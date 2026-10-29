/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
 * Creates a real local folder and a sidecar bound to this test's core instance.
 *
 * @param {string} name - Unique fixture name.
 * @returns {Promise<object>} Native folder, service and file.
 */
async function fixture(name) {
  const folder = rootFolder
    .createLocalSubfolder(name)
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const file = do_get_profile().clone();
  file.append("native-search-" + name + ".sqlite");
  const sourceId = "isolated-test-core-" + ++fixtureCount;
  const service = await MailSearchService.open(file, sourceId, messageDB);
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
