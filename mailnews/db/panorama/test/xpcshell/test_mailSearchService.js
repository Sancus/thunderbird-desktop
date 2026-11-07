/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { PanoramaSearchIndex } = ChromeUtils.importESModule(
  "resource:///modules/panorama/PanoramaSearchIndex.sys.mjs"
);
const { loadMailSearchMetadata } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchContent.sys.mjs"
);
const { MailSearchService } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchService.sys.mjs"
);
const { resolveMailSearchDocument, mailSearchKey, mailPolicyRevision } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearchSource.sys.mjs"
  );

const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const { MailUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailUtils.sys.mjs"
);

let rootFolder;
let fixtureCount = 0;
let previousService;
const fixtureFolders = [];
const INDEXER_PREF = "mailnews.database.global.indexer.enabled";

add_setup(function setupNativeSearch() {
  do_get_profile();
  loadExistingDB();
  Assert.equal(typeof messageDB.getSearchState, "function");
  Assert.equal(typeof messageDB.getSearchChanges, "function");
  Assert.equal(typeof messageDB.getSearchSnapshot, "function");
  const hadPref = Services.prefs.prefHasUserValue(INDEXER_PREF);
  const oldPref = Services.prefs.getBoolPref(INDEXER_PREF, false);
  Services.prefs.setBoolPref(INDEXER_PREF, true);
  registerCleanupFunction(() => {
    if (hadPref) {
      Services.prefs.setBoolPref(INDEXER_PREF, oldPref);
    } else {
      Services.prefs.clearUserPref(INDEXER_PREF);
    }
  });
  const account = MailServices.accounts.createLocalMailAccount();
  rootFolder = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
});

/**
 * Retires the previous case's folders and opens a real native search fixture.
 * Keeps the same core and journal while removing finished cases' stored messages.
 *
 * @param {string} name - Unique fixture name.
 * @returns {Promise<object>} Native folder, service and file.
 */
async function fixture(name) {
  await previousService?.close();
  while (fixtureFolders.length) {
    rootFolder.propagateDelete(fixtureFolders[0], true);
    fixtureFolders.shift();
  }
  const folder = rootFolder
    .createLocalSubfolder(name)
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  fixtureFolders.push(folder);
  const file = do_get_profile().clone();
  file.append("native-search-" + name + ".sqlite");
  const sourceId = "isolated-test-core-" + ++fixtureCount;
  const service = await MailSearchService.open(file, sourceId, messageDB);
  previousService = service;
  registerCleanupFunction(() => service.close());
  return { folder, service, file, sourceId };
}

/**
 * Adds independently stored bytes with a deliberately shared Message-ID.
 *
 * @param {nsIMsgLocalMailFolder} folder - Physical destination.
 * @param {string} subject - Literal query control.
 * @param {string} [sender="sender@example.invalid"] - Literal sender address.
 * @returns {nsIMsgDBHdr} New physical header.
 */
function addStoredMessage(folder, subject, sender = "sender@example.invalid") {
  return folder.addMessage(
    [
      "From: Sender <" + sender + ">",
      "To: Recipient <recipient@example.invalid>",
      "Date: Tue, 01 Jan 2019 00:00:00 +0000",
      "Message-ID: <shared@example.invalid>",
      "Subject: " + subject,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "nativebodyneedle",
      "",
    ].join("\r\n")
  );
}

/**
 * Drains this small fixture through normal bounded service updates.
 *
 * @param {MailSearchService} service - Service under test.
 * @returns {Promise<object>} Last durable progress.
 */
async function drain(service) {
  for (let i = 0; i < 200; i++) {
    const progress = await service.update({ limit: 500 });
    if (!progress.moreWork) {
      return progress;
    }
  }
  throw new Error("Native search fixture did not finish bounded work");
}

add_task(async function test_authoritativePhysicalStateAndMissingBody() {
  const { folder, service } = await fixture("state");
  const first = addStoredMessage(folder, "stateneedle");
  const second = addStoredMessage(folder, "stateneedle");
  Assert.equal(first.messageId, second.messageId);
  const state = resolveMailSearchDocument(messageDB, String(second.messageKey));
  const raw = messageDB.getSearchState(second.messageKey);
  Assert.deepEqual(state.location, {
    folderId: folder.id,
    messageKey: second.messageKey,
  });
  Assert.equal(state.generation, raw.generation);
  Assert.equal(state.contentRevision, raw.contentRevision);
  Assert.equal(state.locationRevision, raw.locationRevision);
  Assert.ok(state.originalContentAvailable, "Real stored bytes were opened");
  Assert.ok(state.canOpen);
  const missingBody = messageDB.addMessage(
    folder.id,
    "metadata@example.invalid",
    [],
    123456,
    "Sender <sender@example.invalid>",
    "Recipient <recipient@example.invalid>",
    "",
    "",
    "metadataonlyneedle",
    0,
    "",
    Ci.nsMsgPriority.notSet
  );
  const metadata = resolveMailSearchDocument(messageDB, String(missingBody));
  Assert.ok(metadata.eligible);
  Assert.equal(metadata.originalContentAvailable, false);
  Assert.equal(
    metadata.canOpen,
    false,
    "Local metadata does not invent original bytes"
  );

  messageDB.removeMessage(first.messageKey);
  Assert.equal(
    resolveMailSearchDocument(messageDB, String(first.messageKey)),
    null
  );
  Assert.ok(
    resolveMailSearchDocument(messageDB, String(second.messageKey)).eligible
  );
  Assert.throws(() => mailSearchKey(first.messageId), /physical/);
  for (const alias of ["0", "01", "1e2", "1.5", "4294967295"]) {
    Assert.throws(() => mailSearchKey(alias), /physical/);
  }
  Assert.equal(mailPolicyRevision("42"), 42);
  Assert.throws(() => mailPolicyRevision("9007199254740992"), /Unsafe/);
  await service.close();
});

add_task(async function test_replayCopiesDeletionAndPolicyRescan() {
  const { folder, service } = await fixture("replay");
  const otherFolder = rootFolder
    .createLocalSubfolder("replay-other")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  fixtureFolders.push(otherFolder);
  const first = addStoredMessage(folder, "replayneedle");
  const second = addStoredMessage(otherFolder, "replayneedle");
  await drain(service);
  const hits = await service.search("replayneedle");
  Assert.deepEqual(
    hits.items.map(hit => hit.id).sort(),
    [String(first.messageKey), String(second.messageKey)].sort()
  );

  first.flags |= Ci.nsMsgMessageFlags.Read;
  await drain(service);
  const headers = [];
  const streamed = await service.streamHeaders("replayneedle", header =>
    headers.push(header)
  );
  Assert.equal(streamed.count, 2);
  Assert.deepEqual(
    headers.map(header => header.messageKey).sort((a, b) => a - b),
    [first.messageKey, second.messageKey].sort((a, b) => a - b)
  );

  otherFolder.setFlag(Ci.nsMsgFolderFlags.Junk);
  await drain(service);
  Assert.deepEqual(
    (await service.search("replayneedle")).items.map(hit => hit.id),
    [String(first.messageKey)]
  );
  otherFolder.clearFlag(Ci.nsMsgFolderFlags.Junk);
  await drain(service);
  Assert.equal((await service.search("replayneedle")).items.length, 2);
  messageDB.removeMessage(first.messageKey);
  await drain(service);
  Assert.deepEqual(
    (await service.search("replayneedle")).items.map(hit => hit.id),
    [String(second.messageKey)]
  );
  await service.close();
});

add_task(async function test_rescanRestartAndChangesDuringPaging() {
  const { folder, service, file, sourceId } = await fixture("rescan");
  const first = addStoredMessage(folder, "rescanneedle");
  const removed = addStoredMessage(folder, "rescanneedle");
  await drain(service);
  messageDB.noteSearchPolicyChanged();
  let progress = await service.update({ limit: 1 });
  Assert.ok(progress.rebuilding, "Policy marker remains pending");
  first.subject = "renamedneedle";
  messageDB.removeMessage(removed.messageKey);
  const late = addStoredMessage(folder, "rescanneedle");
  await service.close();
  const reopened = await MailSearchService.open(file, sourceId, messageDB);
  registerCleanupFunction(() => reopened.close());
  progress = await drain(reopened);
  Assert.equal(progress.rebuilding, false);
  Assert.equal(progress.acceptedThrough, progress.sourceWatermark);
  Assert.deepEqual(
    (await reopened.search("rescanneedle")).items.map(hit => hit.id),
    [String(late.messageKey)]
  );
  Assert.deepEqual(
    (await reopened.search("renamedneedle")).items.map(hit => hit.id),
    [String(first.messageKey)]
  );
  await reopened.close();
  await Assert.rejects(
    MailSearchService.open(file, "different-core-incarnation", messageDB),
    /source changed/
  );
});

add_task(async function test_addressBookEditsInvalidateIndexedNames() {
  const { folder, service } = await fixture("address-book");
  const book = MailServices.ab.getDirectory("jsaddrbook://abook.sqlite");
  const card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
    Ci.nsIAbCard
  );
  card.primaryEmail = "catalog-sender@example.invalid";
  card.displayName = "OriginalCatalogName";
  const added = book.addCard(card);
  let removed = false;
  registerCleanupFunction(() => {
    if (!removed) {
      book.deleteCards([added]);
    }
  });
  const header = addStoredMessage(
    folder,
    "addressbookneedle",
    "catalog-sender@example.invalid"
  );
  await drain(service);
  Assert.deepEqual(
    (await service.search("OriginalCatalogName")).items.map(hit => hit.id),
    [String(header.messageKey)]
  );
  added.displayName = "ReplacementCatalogName";
  book.modifyCard(added);
  // Query entry must invalidate old text before a background body load finishes.
  Assert.deepEqual((await service.search("OriginalCatalogName")).items, []);
  await drain(service);
  Assert.deepEqual(
    (await service.search("ReplacementCatalogName")).items.map(hit => hit.id),
    [String(header.messageKey)]
  );
  book.deleteCards([added]);
  removed = true;
  Assert.deepEqual((await service.search("ReplacementCatalogName")).items, []);
  await drain(service);
  Assert.deepEqual(
    (await service.search("addressbookneedle")).items.map(hit => hit.id),
    [String(header.messageKey)]
  );
  await service.close();
});

add_task(async function test_nativeFolderPolicyOverridesCachedFlags() {
  const { folder, service } = await fixture("native-flags");
  const child = folder
    .createLocalSubfolder("child")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const header = addStoredMessage(child, "nativeflagsneedle");
  Assert.ok(
    resolveMailSearchDocument(messageDB, String(header.messageKey)).eligible
  );
  const original = folderDB.getFolderFlags(folder.id);
  // Bypass the cached nsIMsgFolder flags through the public native API.
  folderDB.updateFlags(folder.id, original | Ci.nsMsgFolderFlags.Junk);
  Assert.equal(
    resolveMailSearchDocument(messageDB, String(header.messageKey)).eligible,
    false,
    "A native ancestor exclusion takes effect without refreshing the folder wrapper"
  );
  folderDB.updateFlags(folder.id, original);
  Assert.ok(
    resolveMailSearchDocument(messageDB, String(header.messageKey)).eligible
  );
  const childFlags = folderDB.getFolderFlags(child.id);
  folderDB.updateFlags(child.id, childFlags | Ci.nsMsgFolderFlags.Virtual);
  Assert.equal(
    resolveMailSearchDocument(messageDB, String(header.messageKey)).eligible,
    false
  );
  folderDB.updateFlags(child.id, childFlags);
  Assert.ok(
    resolveMailSearchDocument(messageDB, String(header.messageKey)).eligible
  );
  await service.close();
});

add_task(async function test_nativeSelectedCopyOpening() {
  const { folder, service } = await fixture("opening");
  const other = rootFolder
    .createLocalSubfolder("opening-other")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  fixtureFolders.push(other);
  const first = addStoredMessage(folder, "openingneedle");
  const selected = addStoredMessage(other, "openingneedle");
  Assert.equal(first.messageId, selected.messageId);
  const displayMessage = MailUtils.displayMessage;
  const opened = [];
  MailUtils.displayMessage = (...args) => opened.push(args);
  try {
    const viewWrapper = {};
    const tabmail = {};
    const result = await service.openResult(String(selected.messageKey), {
      viewWrapper,
      tabmail,
    });
    Assert.equal(result.status, "ready");
    Assert.equal(opened.length, 1);
    Assert.equal(opened[0][0].messageKey, selected.messageKey);
    Assert.equal(opened[0][0].folder.id, other.id);
    Assert.equal(opened[0][1], viewWrapper);
    Assert.equal(opened[0][2], tabmail);
    messageDB.removeMessage(selected.messageKey);
    Assert.equal(
      (await service.openResult(String(selected.messageKey))).status,
      "deleted"
    );
    Assert.equal(
      opened.length,
      1,
      "Deletion does not open another copy with the same Message-ID"
    );
    Assert.ok(
      resolveMailSearchDocument(messageDB, String(first.messageKey)).eligible
    );
  } finally {
    MailUtils.displayMessage = displayMessage;
    await service.close();
  }
});

add_task(async function test_staleBodyTokenKeepsMetadataAndLaterHits() {
  const { folder, service } = await fixture("stale-body-token");
  const stale = addStoredMessage(folder, "staletokenneedle");
  const good = addStoredMessage(folder, "staletokenneedle");
  const originalToken = stale.storeToken;
  Assert.notEqual(
    originalToken,
    "1",
    "The fixture replaces its real body token"
  );
  stale.storeToken = "1";
  const reports = [];
  service.onError = error => reports.push(error);
  const before = messageDB.getSearchState(stale.messageKey);
  const state = service.resolveDocument(String(stale.messageKey));
  Assert.ok(state.eligible, "Unreadable original does not exclude metadata");
  Assert.equal(state.originalContentAvailable, false);
  Assert.equal(state.canOpen, false);
  Assert.ok(
    state.contentError,
    "The original per-message stream error is retained"
  );
  Assert.ok(
    reports.includes(state.contentError),
    "Service reports the same error object"
  );
  Assert.equal(
    messageDB.getSearchState(stale.messageKey).generation,
    before.generation,
    "Availability lookup does not mutate the stored flags"
  );

  const progress = await drain(service);
  Assert.equal(progress.acceptedThrough, progress.sourceWatermark);
  Assert.greaterOrEqual(progress.unavailable, 1);
  const page = await service.search("staletokenneedle");
  Assert.deepEqual(
    page.items.map(hit => hit.id).sort(),
    [String(stale.messageKey), String(good.messageKey)].sort()
  );
  const missingBody = page.items.find(
    hit => hit.id == String(stale.messageKey)
  );
  Assert.equal(missingBody.bodyIndexed, false);
  Assert.equal(missingBody.originalContentAvailable, false);
  Assert.deepEqual(
    (await service.search("staletokenneedle nativebodyneedle")).items.map(
      hit => hit.id
    ),
    [String(good.messageKey)],
    "Unreadable body text was not silently indexed"
  );
  const headers = [];
  await service.streamHeaders("staletokenneedle", header =>
    headers.push(header.messageKey)
  );
  Assert.deepEqual(
    headers.sort((a, b) => a - b),
    [stale.messageKey, good.messageKey].sort((a, b) => a - b)
  );

  stale.storeToken = originalToken;
  await drain(service);
  Assert.deepEqual(
    (await service.search("staletokenneedle nativebodyneedle")).items
      .map(hit => hit.id)
      .sort(),
    [String(stale.messageKey), String(good.messageKey)].sort(),
    "A new valid token revives the physical message's body work"
  );
  await service.close();
});

add_task(function test_coreStateFailureIsNotContentUnavailable() {
  const failure = Components.Exception(
    "Core read failed",
    Cr.NS_ERROR_FILE_CORRUPTED
  );
  Assert.throws(
    () =>
      resolveMailSearchDocument(
        {
          getSearchState() {
            throw failure;
          },
        },
        "1"
      ),
    error => error === failure
  );
});

/**
 * Opens real sidecar storage with a replay boundary that can fail on demand.
 *
 * @param {string} name - Unique test filename.
 * @param {function(): object} getSearchChanges - Replay response or error.
 * @returns {Promise<MailSearchService>} Service used only for scheduler tests.
 */
async function backgroundFixture(name, getSearchChanges) {
  const file = do_get_profile().clone();
  file.append("background-" + name + ".sqlite");
  const service = await MailSearchService.open(
    file,
    "background-test-" + name,
    {
      getSearchChanges,
      getSearchState() {
        throw new Error("The empty scheduler fixture has no message");
      },
      getSearchSnapshot() {
        throw new Error("The empty scheduler fixture has no policy marker");
      },
      noteSearchPolicyChanged() {},
    }
  );
  registerCleanupFunction(() => service.close());
  return service;
}

add_task(async function test_backgroundRetriesAfterTransientReplayFailure() {
  const failure = new Error("Transient replay failure");
  let fail = true;
  const service = await backgroundFixture("transient", () => {
    if (fail) {
      fail = false;
      throw failure;
    }
    return { changes: [], nextSequence: 0, watermark: 0 };
  });
  const reports = [];
  const progress = [];
  const activitiesAtFailure = [];
  const manager = Cc["@mozilla.org/activity-manager;1"].getService(
    Ci.nsIActivityManager
  );
  service.onError = error => {
    reports.push(error);
    const [activity] = manager.getProcessesByContext(
      "panorama-search",
      "background-test-transient"
    );
    activitiesAtFailure.push({ activity, state: activity?.state });
  };
  service.onProgress = state => progress.push(state);
  service.start();
  await TestUtils.waitForCondition(
    () => progress.length,
    "Background replay resumes without an unrelated mail notification"
  );
  Assert.deepEqual(reports, [failure], "The original error remains reportable");
  Assert.equal(progress[0].acceptedThrough, 0);
  Assert.equal(progress[0].sourceWatermark, 0);
  Assert.equal(progress[0].moreWork, false);
  Assert.equal(activitiesAtFailure.length, 1);
  const [{ activity, state }] = activitiesAtFailure;
  Assert.ok(activity, "A replay failure creates a visible activity");
  Assert.equal(state, Ci.nsIActivityProcess.STATE_WAITINGFORRETRY);
  Assert.equal(activity.state, Ci.nsIActivityProcess.STATE_COMPLETED);
  Assert.equal(
    manager.getProcessesByContext(
      "panorama-search",
      "background-test-transient"
    ).length,
    0,
    "A recovered replay removes its completed activity"
  );
  await service.close();
});

add_task(async function test_closeCancelsBackgroundRetry() {
  const failure = new Error("Persistent replay failure");
  const service = await backgroundFixture("close", () => {
    throw failure;
  });
  const reports = [];
  service.onError = error => reports.push(error);
  service.start();
  await TestUtils.waitForCondition(
    () => reports.length,
    "Initial background failure is reported"
  );
  await service.close();
  await new Promise(resolve => do_timeout(1200, resolve));
  Assert.deepEqual(reports, [failure], "Closing prevents delayed retry work");
});

add_task(
  async function test_explicitUnavailableRetryKeepsErrorsAndPolicyGuards() {
    const { folder, service } = await fixture("retry-unavailable");
    const header = addStoredMessage(folder, "retryunavailableneedle");
    Assert.notEqual(header.storeToken, "1");
    header.storeToken = "1";
    const errors = [];
    service.onError = error => errors.push(error);
    await drain(service);
    const before = messageDB.getSearchState(header.messageKey).generation;
    const retry = await service.retryUnavailable();
    Assert.greaterOrEqual(retry.pending, 1);
    Assert.equal(retry.unavailable, 0);
    const progress = await drain(service);
    Assert.greaterOrEqual(
      progress.unavailable,
      1,
      "Still unreadable does not mean indexed"
    );
    Assert.ok(errors.length, "Original stream errors remain reportable");
    Assert.equal(
      messageDB.getSearchState(header.messageKey).generation,
      before,
      "Retry does not invalidate native metadata or journal a policy rescan"
    );
    Assert.equal(
      (await service.search("retryunavailableneedle")).items[0].bodyIndexed,
      false
    );

    await service.retryUnavailable();
    folder.setFlag(Ci.nsMsgFolderFlags.Junk);
    await drain(service);
    Assert.deepEqual(
      (await service.search("retryunavailableneedle")).items,
      [],
      "Retry cannot revive excluded content"
    );
    const controller = new AbortController();
    const reason = new Error("Cancel unavailable retry");
    controller.abort(reason);
    await Assert.rejects(
      service.retryUnavailable({ signal: controller.signal }),
      error => error === reason
    );
    await service.close();
  }
);

add_task(async function test_cardBurstsDoNotJournalGlobalPolicyChanges() {
  const { folder, service } = await fixture("coalesced-names");
  const book = MailServices.ab.getDirectory("jsaddrbook://abook.sqlite");
  const card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
    Ci.nsIAbCard
  );
  card.primaryEmail = "coalesced@example.invalid";
  card.displayName = "InitialBurstName";
  const added = book.addCard(card);
  registerCleanupFunction(() => book.deleteCards([added]));
  const first = addStoredMessage(folder, "coalescednames", card.primaryEmail);
  const second = addStoredMessage(folder, "coalescednames", card.primaryEmail);
  await drain(service);
  const before = messageDB.getSearchState(first.messageKey);
  for (const name of ["IntermediateBurstName", "FinalBurstName"]) {
    added.displayName = name;
    book.modifyCard(added);
  }
  await Promise.all([
    service.search("InitialBurstName"),
    service.search("IntermediateBurstName"),
  ]);
  await drain(service);
  Assert.deepEqual(
    (await service.search("FinalBurstName")).items.map(hit => hit.id).sort(),
    [String(first.messageKey), String(second.messageKey)].sort()
  );
  Assert.deepEqual((await service.search("InitialBurstName")).items, []);
  Assert.equal(
    messageDB.getSearchState(first.messageKey).generation,
    before.generation
  );
  Assert.equal(
    messageDB.getSearchState(first.messageKey).policyRevision,
    before.policyRevision
  );
  Assert.equal(
    (await service.getText(String(first.messageKey))).bodyIndexed,
    true
  );
  first.flags |= Ci.nsMsgMessageFlags.Read;
  await drain(service);
  Assert.deepEqual(
    (await service.search("nativebodyneedle")).items
      .filter(hit =>
        [String(first.messageKey), String(second.messageKey)].includes(hit.id)
      )
      .map(hit => hit.id)
      .sort(),
    [String(first.messageKey), String(second.messageKey)].sort()
  );
  Assert.equal(
    (await service.collectResults("coalescednames")).items.find(
      item => item.id == String(first.messageKey)
    ).read,
    true
  );
  await service.close();
});

add_task(async function test_consecutivePolicyMarkersShareOneScan() {
  const { folder, service, file, sourceId } = await fixture("policy-burst");
  const header = addStoredMessage(folder, "policyburstneedle");
  await drain(service);
  await service.close();
  let scans = 0;
  const source = {
    getMessage(key) {
      return messageDB.getMessage(key);
    },
    getSearchState(key) {
      return messageDB.getSearchState(key);
    },
    getSearchChanges(after, limit) {
      return messageDB.getSearchChanges(after, limit);
    },
    getSearchSnapshot(after, limit) {
      if (after == 0) {
        scans++;
      }
      return messageDB.getSearchSnapshot(after, limit);
    },
    noteSearchPolicyChanged() {
      return messageDB.noteSearchPolicyChanged();
    },
  };
  const reopened = await MailSearchService.open(file, sourceId, source);
  registerCleanupFunction(() => reopened.close());
  messageDB.noteSearchPolicyChanged();
  messageDB.noteSearchPolicyChanged();
  await drain(reopened);
  Assert.equal(
    scans,
    1,
    "Adjacent policy events in one journal page need one scan"
  );
  Assert.deepEqual(
    (await reopened.search("policyburstneedle")).items.map(hit => hit.id),
    [String(header.messageKey)]
  );
  await reopened.close();
  const again = await MailSearchService.open(file, sourceId, source);
  registerCleanupFunction(() => again.close());
  scans = 0;
  messageDB.noteSearchPolicyChanged();
  messageDB.removeMessage(header.messageKey);
  messageDB.noteSearchPolicyChanged();
  await drain(again);
  Assert.equal(scans, 2, "A deletion between policy events cannot be skipped");
  Assert.deepEqual((await again.search("policyburstneedle")).items, []);
  await again.close();
});

add_task(async function test_unavailableBackgroundWorkHasAnOwnedActivity() {
  const { folder, service, sourceId } = await fixture("activity-unavailable");
  const key = messageDB.addMessage(
    folder.id,
    "activity-unavailable@example.invalid",
    [],
    123456,
    "Sender <sender@example.invalid>",
    "",
    "",
    "",
    "activityunavailableneedle",
    0,
    "",
    Ci.nsMsgPriority.notSet
  );
  const manager = Cc["@mozilla.org/activity-manager;1"].getService(
    Ci.nsIActivityManager
  );
  const settled = Promise.withResolvers();
  service.onError = error => settled.reject(error);
  service.onProgress = progress => {
    if (!progress.moreWork && progress.unavailable) {
      settled.resolve(progress);
    }
  };
  service.start();
  const progress = await settled.promise;
  Assert.greaterOrEqual(progress.unavailable, 1);
  Assert.equal((await service.getText(String(key))).bodyIndexed, false);
  const activities = manager.getProcessesByContext("panorama-search", sourceId);
  Assert.equal(activities.length, 1, "Only this writer owns its activity");
  const [activity] = activities;
  Assert.equal(activity.state, Ci.nsIActivityProcess.STATE_WAITINGFORRETRY);
  Assert.equal(
    activity.percentComplete,
    -1,
    "A checkpoint is not a message total"
  );
  Assert.ok(activity.lastStatusText, "Retained unavailable work has a status");
  await service.close();
  Assert.equal(activity.state, Ci.nsIActivityProcess.STATE_CANCELED);
  Assert.equal(
    manager.getProcessesByContext("panorama-search", sourceId).length,
    0
  );
});

add_task(async function test_closeCancelsPendingQueryDelivery() {
  const {
    folder,
    service: firstService,
    file,
    sourceId,
  } = await fixture("query-close");
  const header = addStoredMessage(folder, "querycloseneedle");
  await drain(firstService);
  for (const callerSignal of [false, true]) {
    const service = callerSignal
      ? await MailSearchService.open(file, sourceId, messageDB)
      : firstService;
    const controller = new AbortController();
    const resolveDocument = service.resolveDocument;
    let closing, observedSignal;
    try {
      if (!callerSignal) {
        const cancelled = new AbortController();
        const reason = new Error("Original caller cancellation");
        cancelled.abort(reason);
        const failure = new Error("Original native lookup failure");
        let lookups = 0;
        service.resolveDocument = () => {
          lookups++;
          throw failure;
        };
        await Assert.rejects(
          service.search("querycloseneedle", { signal: cancelled.signal }),
          error => error === reason
        );
        Assert.equal(lookups, 0, "A cancelled query starts no native lookup");
        await Assert.rejects(
          service.search("querycloseneedle"),
          error => error === failure
        );
      }
      service.resolveDocument = function (id, signal) {
        const state = resolveDocument.call(this, id, signal);
        if (id == String(header.messageKey) && !closing) {
          observedSignal = signal;
          closing = this.close();
        }
        return state;
      };
      await Assert.rejects(
        service.search(
          "querycloseneedle",
          callerSignal ? { signal: controller.signal } : undefined
        ),
        error => observedSignal?.aborted && error === observedSignal.reason,
        "Closing cancels a page even after its current native state was read"
      );
      Assert.ok(closing, "The query reached the physical-state boundary");
      Assert.ok(
        !controller.signal.aborted,
        "Closing does not abort the caller"
      );
      await closing;
    } finally {
      service.resolveDocument = resolveDocument;
      await service.close();
    }
  }
});

add_task(async function test_closePreventsPendingReaderDispatch() {
  const displayMessage = MailUtils.displayMessage;
  const opened = [];
  MailUtils.displayMessage = (...args) => opened.push(args);
  try {
    for (const callerSignal of [false, true]) {
      const { folder, service } = await fixture("open-close-" + callerSignal);
      const header = addStoredMessage(folder, "opencloseneedle");
      const controller = new AbortController();
      const resolveDocument = service.resolveDocument;
      let closing, observedSignal;
      service.resolveDocument = function (id, signal) {
        const state = resolveDocument.call(this, id, signal);
        if (id == String(header.messageKey) && !closing) {
          observedSignal = signal;
          closing = this.close();
        }
        return state;
      };
      try {
        await Assert.rejects(
          service.openResult(
            String(header.messageKey),
            callerSignal ? { signal: controller.signal } : undefined
          ),
          error => observedSignal?.aborted && error === observedSignal.reason,
          "Closing prevents a reader dispatch after current physical lookup"
        );
        Assert.ok(closing, "Opening reached the physical-state boundary");
        Assert.equal(opened.length, 0, "No message opens after service close");
        Assert.ok(!controller.signal.aborted);
        await closing;
      } finally {
        service.resolveDocument = resolveDocument;
        await service.close();
      }
    }
  } finally {
    MailUtils.displayMessage = displayMessage;
  }
});

add_task(async function test_openKeepsOriginalCancellationAndErrors() {
  const { folder, service } = await fixture("query-original-errors");
  const header = addStoredMessage(folder, "queryerrorneedle");
  const controller = new AbortController();
  const reason = new Error("Original caller cancellation");
  controller.abort(reason);
  const options = { signal: controller.signal };
  const resolveDocument = service.resolveDocument;
  const failure = new Error("Original native lookup failure");
  let lookups = 0;
  service.resolveDocument = () => {
    lookups++;
    throw failure;
  };
  try {
    await Assert.rejects(
      service.openResult(String(header.messageKey), options),
      error => error === reason
    );
    Assert.equal(lookups, 0, "A cancelled caller starts no native lookup");
    await Assert.rejects(
      service.openResult(String(header.messageKey)),
      error => error === failure
    );
  } finally {
    service.resolveDocument = resolveDocument;
    await service.close();
  }
});

add_task(async function test_recoveredBodiesFollowCurrentNativePolicy() {
  const input = await fixture("recovered-policy");
  let service = input.service;
  let index, failure, scanController, scanPending, scanReason;
  const target = rootFolder
    .createLocalSubfolder("recovered-policy-unrelated")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  fixtureFolders.push(target);
  const targetFlags = folderDB.getFolderFlags(target.id);
  const originalFlags = folderDB.getFolderFlags(input.folder.id);
  const checkpointFirst = addStoredMessage(
    input.folder,
    "policycheckpointordinary"
  );
  const body = "\uFEFFrecoverypolicyneedle e\u0301 \ud83d\ude00\0tail";
  const cases = [
    ["kept", body],
    ["empty", ""],
    ["changed", "changedrecoveryneedle"],
    ["deleted", "deletedrecoveryneedle"],
    ["quarantined", "quarantinerecoveryneedle"],
    ["publicRead", body],
    ["publicEmpty", ""],
  ].map(([role, text]) => ({
    role,
    text,
    key: messageDB.addMessage(
      input.folder.id,
      "recovered-policy-" + role + "@example.invalid",
      [],
      123456,
      "Sender <sender@example.invalid>",
      "Recipient <recipient@example.invalid>",
      "",
      "",
      "recovered policy " + role,
      0,
      "",
      Ci.nsMsgPriority.notSet
    ),
  }));
  addStoredMessage(target, "unrelatedpolicyneedle");
  const byRole = Object.fromEntries(cases.map(row => [row.role, row]));
  try {
    await drain(service);
    // This trusted-index unit input represents already validated import output.
    // The retained-profile whole test independently checks actual import receipts.
    const records = cases.map(row => {
      const id = String(row.key);
      const state = service.resolveDocument(id);
      Assert.ok(state.eligible);
      Assert.equal(state.originalContentAvailable, false);
      const metadata = loadMailSearchMetadata(
        {
          id,
          generation: state.generation,
          policyRevision: state.policyRevision,
        },
        state
      );
      Assert.ok(metadata);
      return {
        recordId: "verified-policy-fixture-" + row.role,
        documentId: id,
        kind: "mail",
        sourceRevision: "a".repeat(64),
        payload: {
          fixture: "prevalidated native import output",
          sourceId: input.sourceId,
          key: row.key,
          originalText: row.text,
        },
        document:
          row.role === "quarantined"
            ? null
            : {
                ...metadata,
                body: row.text,
                attachmentNames: "original.txt",
                bodyIndexed: true,
              },
      };
    });
    await service.close();
    index = await PanoramaSearchIndex.open(input.file, id =>
      resolveMailSearchDocument(messageDB, id)
    );
    await index.retainRecovery(records);
    const provenance = await index.getRecoveryRecords();
    const expectedPayloads = new Map(
      records.map(row => [row.recordId, row.payload])
    );
    Assert.deepEqual(
      provenance.map(row => row.recordId),
      [...expectedPayloads.keys()].sort()
    );
    for (const row of provenance) {
      Assert.deepEqual(row.payload, expectedPayloads.get(row.recordId));
    }
    const captured = messageDB.getSearchState(byRole.kept.key);
    Assert.equal(
      (await index.getRecoveredText(String(byRole.kept.key))).body,
      body
    );
    Assert.equal(
      await index.getRecoveredText(String(byRole.quarantined.key)),
      null
    );
    await index.close();
    index = null;
    service = await MailSearchService.open(
      input.file,
      input.sourceId,
      messageDB
    );
    await service.rebuild();
    Assert.equal((await drain(service)).unavailable, 1);
    const originalText = await service.getText(String(byRole.kept.key));
    Assert.equal(originalText.body, body);
    Assert.equal((await service.getText(String(byRole.empty.key))).body, "");
    await service.close();
    folderDB.updateFlags(target.id, targetFlags | Ci.nsMsgFolderFlags.Trash);
    folderDB.updateFlags(
      target.id,
      ((targetFlags | Ci.nsMsgFolderFlags.Trash) ^
        Ci.nsMsgFolderFlags.Favorite) >>>
        0
    );
    const current = messageDB.getSearchState(byRole.kept.key);
    Assert.greaterOrEqual(
      messageDB
        .getSearchChanges(Number(captured.policyRevision), 500)
        .changes.filter(
          row =>
            row.messageKey === null &&
            row.sequence <= Number(current.policyRevision)
        ).length,
      2,
      "At least two unrelated native markers committed while the owned sidecar was closed"
    );
    Assert.greater(
      Number(current.policyRevision),
      Number(captured.policyRevision)
    );
    Assert.equal(current.contentRevision, captured.contentRevision);
    service = await MailSearchService.open(
      input.file,
      input.sourceId,
      messageDB
    );
    Assert.equal((await drain(service)).unavailable, 1);
    const refreshed = await service.getText(String(byRole.kept.key));
    Assert.equal(refreshed.body, body);
    Assert.equal(
      refreshed.textRevision,
      originalText.textRevision,
      "Unchanged recovered text is not rewritten by the metadata fast path"
    );
    const hit = (await service.search("recoverypolicyneedle")).items[0];
    Assert.equal(hit.id, String(byRole.kept.key));
    for (const field of [
      "generation",
      "contentRevision",
      "policyRevision",
      "textRevision",
    ]) {
      Assert.equal(hit[field], refreshed[field]);
    }
    Assert.equal(refreshed.generation, current.generation);
    Assert.equal(refreshed.policyRevision, Number(current.policyRevision));
    Assert.equal(hit.originalContentAvailable, false);
    Assert.deepEqual((await service.search("unrelatedpolicyneedle")).items, []);
    Assert.deepEqual(await service.getRecoveryRecords(), provenance);
    await service.close();
    service = await MailSearchService.open(
      input.file,
      input.sourceId,
      messageDB
    );
    await service.rebuild();
    Assert.equal((await drain(service)).unavailable, 1);
    Assert.equal((await service.getText(String(byRole.kept.key))).body, body);
    Assert.equal((await service.getText(String(byRole.empty.key))).body, "");
    Assert.deepEqual(await service.getRecoveryRecords(), provenance);
    // Rebuild schedules idle work even after the explicit drain settles.
    // Retire that owner before starting the read-only observation interval.
    await service.close();
    service = await MailSearchService.open(
      input.file,
      input.sourceId,
      messageDB
    );
    // Only the public getter observes this interval. No excluded update or
    // special recovered-text read may establish the revocation for these rows.
    folderDB.updateFlags(
      input.folder.id,
      originalFlags | Ci.nsMsgFolderFlags.Trash
    );
    const observedPolicy = Number(
      messageDB.getSearchState(byRole.publicRead.key).policyRevision
    );
    for (const role of ["publicRead", "publicEmpty"]) {
      Assert.equal(
        await service.getText(String(byRole[role].key)),
        null,
        "The ordinary public getter observes actual native ineligibility"
      );
    }
    await service.close();
    index = await PanoramaSearchIndex.open(input.file, id =>
      resolveMailSearchDocument(messageDB, id)
    );
    Assert.less(
      (await index.getProgress()).acceptedThrough,
      observedPolicy,
      "No excluded source page was accepted before closing the public reader"
    );
    Assert.equal(await index.getRescan(), null);
    Assert.deepEqual(await index.getRecoveryRecords(), provenance);
    await index.close();
    index = null;
    folderDB.updateFlags(input.folder.id, originalFlags);
    service = await MailSearchService.open(
      input.file,
      input.sourceId,
      messageDB
    );
    await service.rebuild();
    await drain(service);
    for (const role of ["publicRead", "publicEmpty"]) {
      const text = await service.getText(String(byRole[role].key));
      Assert.equal(
        text.bodyIndexed,
        false,
        "A public read exclusion survives close, re-enable, reopen and rebuild"
      );
      Assert.equal(text.body, "", "The old recovered body is not delivered");
    }
    Assert.equal((await service.getText(String(byRole.kept.key))).body, body);
    Assert.equal((await service.getText(String(byRole.empty.key))).body, "");
    Assert.deepEqual(await service.getRecoveryRecords(), provenance);
    messageDB.getMessage(byRole.changed.key).subject =
      "new content interpretation";
    Assert.notEqual(
      messageDB.getSearchState(byRole.changed.key).contentRevision,
      records.find(row => row.documentId === String(byRole.changed.key))
        .document.contentRevision
    );
    messageDB.removeMessage(byRole.deleted.key);
    await drain(service);
    Assert.equal(
      (await service.getText(String(byRole.changed.key))).bodyIndexed,
      false
    );
    Assert.deepEqual((await service.search("changedrecoveryneedle")).items, []);
    Assert.equal(await service.getText(String(byRole.deleted.key)), null);
    Assert.deepEqual((await service.search("deletedrecoveryneedle")).items, []);
    Assert.deepEqual(
      (await service.search("quarantinerecoveryneedle")).items,
      []
    );
    await service.close();
    index = await PanoramaSearchIndex.open(input.file, id =>
      resolveMailSearchDocument(messageDB, id)
    );
    for (const role of ["changed", "deleted", "quarantined"]) {
      Assert.equal(
        await index.getRecoveredText(String(byRole[role].key)),
        null
      );
    }
    const reason = new Error("Cancel recovered content delivery");
    const controller = new AbortController();
    controller.abort(reason);
    await Assert.rejects(
      index.getRecoveredText(String(byRole.kept.key), controller.signal),
      error => error === reason
    );
    await index.close();
    index = null;
    service = await MailSearchService.open(
      input.file,
      input.sourceId,
      messageDB
    );
    // Exercise observed revocation before a bounded scan accepts either
    // recovered row, using this same settled source/sidecar incarnation.
    folderDB.updateFlags(
      input.folder.id,
      originalFlags | Ci.nsMsgFolderFlags.Trash
    );
    Assert.ok((await service.update({ limit: 1 })).rebuilding);
    Assert.ok((await service.update({ limit: 1 })).rebuilding);
    scanController = new AbortController();
    scanReason = new Error("Stop the real policy scan before recovered rows");
    let scanSettled = false;
    scanPending = service
      .update({ limit: 1, signal: scanController.signal })
      .then(
        () => {
          scanSettled = true;
          return { resolved: true };
        },
        error => {
          scanSettled = true;
          return { error };
        }
      );
    await Promise.resolve();
    await Promise.resolve();
    Assert.equal(
      scanSettled,
      false,
      "The non-preaborted bounded update is actually pending"
    );
    scanController.abort(scanReason);
    Assert.equal((await scanPending).error, scanReason);
    await service.close();
    index = await PanoramaSearchIndex.open(input.file, id =>
      resolveMailSearchDocument(messageDB, id)
    );
    Assert.equal(
      await index.getRecoveredText(String(byRole.kept.key)),
      null,
      "Current exclusion withholds recovery before its durable erase is advanced"
    );
    Assert.equal(await index.getRecoveredText(String(byRole.empty.key)), null);
    const scan = await index.getRescan();
    Assert.ok(scan, "The actual policy scan remains unfinished");
    Assert.greater(
      scan.afterKey,
      0,
      "A real bounded native snapshot page was accepted"
    );
    Assert.lessOrEqual(scan.afterKey, checkpointFirst.messageKey);
    Assert.less(
      scan.afterKey,
      Math.min(byRole.kept.key, byRole.empty.key),
      "No recovered row exclusion has been accepted"
    );
    await index.close();
    index = null;
    service = await MailSearchService.open(
      input.file,
      input.sourceId,
      messageDB
    );
    await drain(service);
    Assert.equal(await service.getText(String(byRole.kept.key)), null);
    await service.close();
    folderDB.updateFlags(input.folder.id, originalFlags);
    index = await PanoramaSearchIndex.open(input.file, id =>
      resolveMailSearchDocument(messageDB, id)
    );
    Assert.equal(
      await index.getRecoveredText(String(byRole.kept.key)),
      null,
      "Re-enabling current policy does not reauthorize a previously excluded recovery"
    );
    Assert.equal(await index.getRecoveredText(String(byRole.empty.key)), null);
    const suppressed = await index.getRecoveryRecords();
    for (const row of suppressed.filter(
      row => row.documentId !== String(byRole.deleted.key)
    )) {
      Assert.equal(
        row.erased,
        false,
        "Exclusion preserves raw provenance rather than erasing it"
      );
      Assert.deepEqual(row.payload, expectedPayloads.get(row.recordId));
    }
    await index.close();
    index = null;
    service = await MailSearchService.open(
      input.file,
      input.sourceId,
      messageDB
    );
    await service.rebuild();
    await drain(service);
    for (const role of ["kept", "empty"]) {
      Assert.equal(
        (await service.getText(String(byRole[role].key))).bodyIndexed,
        false,
        "Canonical refresh and rebuild cannot revive a suppressed recovered body"
      );
    }
    Assert.deepEqual((await service.search("recoverypolicyneedle")).items, []);
    Assert.deepEqual(await service.getRecoveryRecords(), suppressed);
    await service.close();
    index = await PanoramaSearchIndex.open(input.file, id =>
      resolveMailSearchDocument(messageDB, id)
    );
    await index.remove(String(byRole.kept.key));
    const [erased] = await index.getRecoveryRecords(String(byRole.kept.key));
    Assert.equal(
      erased.erased,
      true,
      "The explicit permanent erase actually completed"
    );
    Assert.equal(erased.payload, null);
    await index.close();
    index = await PanoramaSearchIndex.open(input.file, id =>
      resolveMailSearchDocument(messageDB, id)
    );
    await index.retainRecovery(records);
    await index.rebuild();
    Assert.equal(
      await index.getRecoveredText(String(byRole.kept.key)),
      null,
      "Re-enabling current policy cannot revive explicitly erased recovery"
    );
    Assert.equal(await index.getText(String(byRole.kept.key)), null);
    const replayed = await index.getRecoveryRecords();
    const erasedIds = [String(byRole.deleted.key), String(byRole.kept.key)];
    Assert.equal(
      replayed.filter(row => erasedIds.includes(row.documentId)).length,
      2
    );
    for (const row of replayed) {
      Assert.equal(row.erased, erasedIds.includes(row.documentId));
      Assert.deepEqual(
        row.payload,
        row.erased ? null : expectedPayloads.get(row.recordId)
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    scanController?.abort(scanReason);
    const scanOutcome = await scanPending;
    const closed = await Promise.allSettled([service.close(), index?.close()]);
    const failures = closed
      .filter(row => row.status === "rejected")
      .map(row => row.reason);
    if (scanOutcome?.error && scanOutcome.error !== scanReason) {
      failures.push(scanOutcome.error);
    }
    try {
      folderDB.updateFlags(target.id, targetFlags);
      folderDB.updateFlags(input.folder.id, originalFlags);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      if (failure) {
        failures.unshift(failure);
      }
      throw new AggregateError(
        failures,
        "Recovered policy fixture operation/cleanup failed"
      );
    }
    if (failure) {
      throw failure;
    }
  }
});

add_task(
  async function test_legacyRecoveryUpgradePreservesEligibleTextAndRevocation() {
    const file = do_get_profile().clone();
    file.append("legacy-recovery-policy-history.sqlite");
    let state = {
      eligible: true,
      generation: 3,
      policyRevision: 1,
      contentRevision: "legacy-content",
      location: null,
      originalContentAvailable: false,
    };
    const document = {
      id: "legacy-policy-copy",
      generation: 3,
      policyRevision: 1,
      contentRevision: "legacy-content",
      subject: "",
      body: "legacyhistoryneedle",
      attachmentNames: "",
      author: "",
      recipients: "",
    };
    const resolve = id => (id === document.id ? state : null);
    let index = await PanoramaSearchIndex.open(file, resolve);
    try {
      await index.retainRecovery([
        {
          recordId: "legacy-policy-source",
          documentId: document.id,
          kind: "mail",
          sourceRevision: "b".repeat(64),
          payload: { fixture: "schema-7 recovery" },
          document,
        },
      ]);
      Assert.ok(await index.index(document));
      await index.close();
      // Recreate the actual prior sidecar layout, with no exclusion-history field.
      const connection = Services.storage.openUnsharedDatabase(file);
      try {
        connection.executeSimpleSQL(
          "ALTER TABLE recovery_records DROP COLUMN suppressed"
        );
        connection.executeSimpleSQL(
          "ALTER TABLE recovery_records DROP COLUMN validatedPolicyRevision"
        );
        connection.schemaVersion = 7;
      } finally {
        connection.close();
      }
      index = await PanoramaSearchIndex.open(file, resolve);
      Assert.equal(
        (await index.getRecoveredText(document.id)).body,
        document.body,
        "An unchanged current legacy policy remains readable after schema upgrade"
      );
      const provenance = await index.getRecoveryRecords();
      state = { ...state, generation: 4, policyRevision: 3 };
      await index.applyChanges({
        sourceId: "legacy-policy-fixture",
        from: 0,
        through: 4,
        changes: [
          {
            id: document.id,
            generation: 4,
            policyRevision: 3,
            sequence: 4,
            kind: "index",
          },
        ],
      });
      Assert.equal(
        (await index.getRecoveredText(document.id)).body,
        document.body,
        "An unrelated policy change does not revoke an eligible upgraded source"
      );
      const [job] = await index.getPendingJobs();
      Assert.equal(
        await index.refreshJob(job, {
          ...document,
          generation: 4,
          policyRevision: 3,
          body: "",
          bodyIndexed: false,
        }),
        true
      );
      await index.close();
      index = await PanoramaSearchIndex.open(file, resolve);
      Assert.equal(
        (await index.getRecoveredText(document.id)).body,
        document.body
      );
      Assert.deepEqual(await index.getRecoveryRecords(), provenance);
      state = { ...state, eligible: false, generation: 5, policyRevision: 4 };
      await index.applyChanges({
        sourceId: "legacy-policy-fixture",
        from: 4,
        through: 5,
        changes: [
          {
            id: document.id,
            generation: 5,
            policyRevision: 4,
            sequence: 5,
            kind: "exclude",
          },
        ],
      });
      Assert.equal(await index.getRecoveredText(document.id), null);
      state = { ...state, eligible: true, generation: 6, policyRevision: 5 };
      await index.applyChanges({
        sourceId: "legacy-policy-fixture",
        from: 5,
        through: 6,
        changes: [
          {
            id: document.id,
            generation: 6,
            policyRevision: 5,
            sequence: 6,
            kind: "index",
          },
        ],
      });
      Assert.equal(
        await index.getRecoveredText(document.id),
        null,
        "A real accepted exclusion remains revoked after re-enable"
      );
      const [suppressedJob] = await index.getPendingJobs();
      Assert.equal(
        await index.refreshJob(suppressedJob, {
          ...document,
          generation: 6,
          policyRevision: 5,
          body: "",
          bodyIndexed: false,
        }),
        false
      );
      await index.close();
      index = await PanoramaSearchIndex.open(file, resolve);
      Assert.equal(await index.getRecoveredText(document.id), null);
      Assert.deepEqual(await index.getRecoveryRecords(), provenance);
    } finally {
      await index.close();
    }
  }
);
