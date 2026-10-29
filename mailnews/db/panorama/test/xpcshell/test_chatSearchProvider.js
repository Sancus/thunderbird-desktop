/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

do_get_profile();

const { ChatSearchProvider, chatSearchDocumentId } = ChromeUtils.importESModule(
  "resource:///modules/panorama/ChatSearchProvider.sys.mjs"
);
const { PanoramaSearchIndex } = ChromeUtils.importESModule(
  "resource:///modules/panorama/PanoramaSearchIndex.sys.mjs"
);
const {
  logs,
  getLogWriter,
  closeLogWriter,
  queueFileOperation,
  gFilePromises,
} = ChromeUtils.importESModule("resource:///modules/logger.sys.mjs");
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

/**
 * Creates an isolated sidecar and actual logger writer, without a chat account.
 *
 * @param {string} name - Unique fixture name.
 * @returns {Promise<{provider: ChatSearchProvider, file: nsIFile,
 *   conversation: object, writer: object, filePath: string}>} Owned test resources.
 */
async function openChatFixture(name) {
  const conversation = {
    id: "search-" + name,
    account: {
      id: "search-" + name,
      normalizedName: "search-" + name,
      protocol: { normalizedName: "search-test" },
    },
    name: "buddy",
    normalizedName: "buddy",
    title: "Retained chat title",
    startDate: new Date("2022-03-04T12:00:00Z").valueOf() * 1000,
    isChat: false,
  };
  const writer = getLogWriter(conversation);
  await writer._initialized;
  const filePath = writer.currentPath;
  const file = do_get_profile().clone();
  file.append("chat-search-" + name + ".sqlite");
  const provider = await ChatSearchProvider.open(file);
  registerCleanupFunction(async () => {
    await provider.close();
    closeLogWriter(conversation);
    for (const log of writer.paths) {
      await gFilePromises.get(log);
      await IOUtils.remove(log, { ignoreAbsent: true });
    }
  });
  return { provider, file, conversation, writer, filePath };
}

/**
 * Writes through the existing logger observer, then waits for its file queue.
 *
 * @param {object} fixture - Fixture returned by openChatFixture.
 * @param {string} text - Display text recorded by the logger.
 * @param {object} [properties={}] - Message flags, source and remote identity.
 * @returns {Promise<void>} Resolves after the queued log write.
 */
async function logText(fixture, text, properties = {}) {
  logs.observe(
    {
      conversation: fixture.conversation,
      time: fixture.conversation.startDate / 1000000 + 1,
      who: "sender",
      displayMessage: text,
      incoming: true,
      ...properties,
    },
    "new-text"
  );
  await fixture.writer._initialized;
  await gFilePromises.get(fixture.writer.currentPath);
}

add_setup(function setupChatSearchPreferences() {
  do_get_profile();
  const prefs = [
    "mailnews.database.global.indexer.enabled",
    "purple.logging.log_ims",
    "chat.logging.cleanup",
  ];
  const previous = prefs.map(name => [
    name,
    Services.prefs.prefHasUserValue(name),
    Services.prefs.getBoolPref(name, false),
  ]);
  Services.prefs.setBoolPref(prefs[0], true);
  Services.prefs.setBoolPref(prefs[1], true);
  // Keep the physical deletion records so parser filtering is the control.
  Services.prefs.setBoolPref(prefs[2], false);
  registerCleanupFunction(() => {
    for (const [name, hadValue, value] of previous) {
      if (hadValue) {
        Services.prefs.setBoolPref(name, value);
      } else {
        Services.prefs.clearUserPref(name);
      }
    }
  });
});

add_task(async function test_loggedEditsRedactionAndNoLog() {
  const fixture = await openChatFixture("edits");
  const { provider, filePath } = fixture;
  await logText(fixture, "<b>París</b> &amp; meadow", {
    remoteId: "edit",
    alias: "Alias",
  });
  await logText(fixture, "deletionneedle", { remoteId: "delete" });
  await logText(fixture, "unloggedneedle", { noLog: true });
  const [{ id, indexed }] = await provider.refreshConversation(
    fixture.conversation
  );
  Assert.ok(indexed);
  let text = await provider.getText(id);
  Assert.equal(text.subject, "Retained chat title");
  Assert.equal(text.body, "Alias: París & meadow\n\nsender: deletionneedle");
  Assert.ok(!text.body.includes("unloggedneedle"));
  Assert.equal(
    text.attachmentPresence,
    null,
    "Chat text provides no MIME evidence"
  );

  await logText(fixture, "replacementneedle", {
    remoteId: "edit",
    alias: "Alias",
  });
  await logText(fixture, "redacted", { remoteId: "delete", deleted: true });
  Assert.equal(
    await provider.getText(id),
    null,
    "Changed source hides old text before refresh"
  );
  Assert.ok((await provider.refreshLog(filePath)).indexed);
  text = await provider.getText(id);
  Assert.equal(text.body, "Alias: replacementneedle");
  Assert.ok(!text.body.includes("deletionneedle"));
  Assert.ok(
    text.textRevision,
    "The existing writer assigns the exact text revision"
  );

  await provider.close();
  const index = await PanoramaSearchIndex.open(fixture.file, key =>
    provider.resolveDocument(key)
  );
  try {
    Assert.deepEqual(
      (await index.search("replacementneedle")).items.map(hit => hit.id),
      [id]
    );
    Assert.deepEqual((await index.search("deletionneedle")).items, []);
    Assert.deepEqual((await index.search("unloggedneedle")).items, []);
  } finally {
    await index.close();
  }
});

add_task(async function test_identityReopenAndDeletedFile() {
  const first = await openChatFixture("first-copy");
  const second = await openChatFixture("second-copy");
  for (const fixture of [first, second]) {
    await logText(fixture, "samephysicaltext", { remoteId: "same-remote-id" });
    Assert.ok((await fixture.provider.refreshLog(fixture.filePath)).indexed);
  }
  const firstId = chatSearchDocumentId(first.filePath);
  const secondId = chatSearchDocumentId(second.filePath);
  Assert.notEqual(
    firstId,
    secondId,
    "Account/log path distinguishes identical remote IDs and titles"
  );
  Assert.deepEqual(JSON.parse(firstId.slice(5)), [
    "search-test",
    "search-first-copy",
    "buddy",
    PathUtils.filename(first.filePath),
  ]);
  Assert.equal(
    (await first.provider.resolveDocument(firstId)).location,
    null,
    "Chat identity never becomes a mail folder/key"
  );
  await first.provider.close();
  const reopened = await ChatSearchProvider.open(first.file);
  try {
    Assert.equal(
      (await reopened.getText(firstId)).body,
      "sender: samephysicaltext"
    );
    await queueFileOperation(first.filePath, () =>
      IOUtils.remove(first.filePath)
    );
    Assert.equal(await reopened.resolveDocument(firstId), null);
    Assert.equal(await reopened.getText(firstId), null);
    Assert.deepEqual(await reopened.refreshLog(first.filePath), {
      id: firstId,
      indexed: false,
    });
    Assert.equal(
      (await second.provider.getText(secondId)).body,
      "sender: samephysicaltext"
    );
  } finally {
    await reopened.close();
  }
  Assert.throws(
    () =>
      chatSearchDocumentId(
        PathUtils.join(PathUtils.profileDir, "outside.json")
      ),
    /Unsupported chat log path/
  );
  await Assert.rejects(
    second.provider.resolveDocument(
      'chat:["..","account","buddy","2022-03-04.120000+0000.json"]'
    ),
    /chat.*(identity|path)/i
  );
});

add_task(async function test_invalidDocumentPathComponentsAreTypeErrors() {
  const fixture = await openChatFixture("invalid-components");
  const parts = JSON.parse(chatSearchDocumentId(fixture.filePath).slice(5));
  for (const component of ["", ".", ".."]) {
    await Assert.rejects(
      fixture.provider.resolveDocument(
        "chat:" + JSON.stringify([component, ...parts.slice(1)])
      ),
      error =>
        error.name == "TypeError" &&
        error.message == "Invalid chat document identity"
    );
  }
  Assert.throws(
    () => chatSearchDocumentId("relative.json"),
    error =>
      error.name == "TypeError" && error.message == "Unsupported chat log path"
  );
});

add_task(async function test_deletedLogIsErasedWhileIndexingIsDisabled() {
  const fixture = await openChatFixture("deleted-disabled");
  const { provider, filePath } = fixture;
  await logText(fixture, "erasewhileoffneedle");
  const { id } = await provider.refreshLog(filePath);
  Assert.equal(
    (await provider.getText(id)).body,
    "sender: erasewhileoffneedle"
  );
  const bytes = await queueFileOperation(filePath, () =>
    IOUtils.read(filePath)
  );
  Services.prefs.setBoolPref("mailnews.database.global.indexer.enabled", false);
  try {
    await queueFileOperation(filePath, () => IOUtils.remove(filePath));
    Assert.deepEqual(await provider.refreshLog(filePath), {
      id,
      indexed: false,
    });
    await queueFileOperation(filePath, () => IOUtils.write(filePath, bytes));
  } finally {
    Services.prefs.setBoolPref(
      "mailnews.database.global.indexer.enabled",
      true
    );
  }
  Assert.equal(
    await provider.getText(id),
    null,
    "Recreating identical source bytes cannot resurrect erased retained text"
  );
  await provider.close();
  const reopened = await PanoramaSearchIndex.open(fixture.file, key =>
    provider.resolveDocument(key)
  );
  try {
    Assert.equal(
      await reopened.getText(id),
      null,
      "Erasure survives sidecar reopen"
    );
    Assert.deepEqual((await reopened.search("erasewhileoffneedle")).items, []);
  } finally {
    await reopened.close();
  }
});

add_task(async function test_malformedTailAndFailureDoNotBecomeSuccess() {
  const bad = await openChatFixture("malformed");
  const good = await openChatFixture("after-failure");
  await logText(bad, "previousneedle");
  const { id } = await bad.provider.refreshLog(bad.filePath);
  await queueFileOperation(bad.filePath, () =>
    IOUtils.writeUTF8(bad.filePath, "{not a complete redaction\n", {
      mode: "append",
    })
  );
  await Assert.rejects(
    bad.provider.refreshLog(bad.filePath),
    error => error.name == "SyntaxError"
  );
  Assert.equal(
    await bad.provider.getText(id),
    null,
    "Malformed changed bytes cannot expose old matches"
  );
  await logText(good, "nextlogneedle");
  const result = await bad.provider.refreshLog(good.filePath);
  Assert.ok(
    result.indexed,
    "One failed log does not starve later work on the same provider"
  );
  Assert.equal(
    (await bad.provider.getText(result.id)).body,
    "sender: nextlogneedle"
  );

  const failure = new Error("Actual pending logger operation failed");
  queueFileOperation(good.filePath, () => Promise.reject(failure));
  await Assert.rejects(
    good.provider.refreshConversation(good.conversation),
    error => error === failure
  );
});

add_task(async function test_existingLoggingAndIndexingPolicy() {
  const fixture = await openChatFixture("policy");
  const otrPref =
    "messenger.account." +
    fixture.conversation.account.id +
    ".options.otrAllowMsgLog";
  registerCleanupFunction(() => Services.prefs.clearUserPref(otrPref));
  Services.prefs.setBoolPref(otrPref, false);
  await logText(fixture, "excludedencryptedneedle", { isEncrypted: true });
  Services.prefs.setBoolPref(otrPref, true);
  await logText(fixture, "allowedloggedneedle", { isEncrypted: true });
  const { id } = await fixture.provider.refreshLog(fixture.filePath);
  Assert.equal(
    (await fixture.provider.getText(id)).body,
    "sender: allowedloggedneedle",
    "Use actual chat logger policy, not mail encrypted-MIME rules"
  );
  Services.prefs.setBoolPref("mailnews.database.global.indexer.enabled", false);
  try {
    Assert.equal(await fixture.provider.getText(id), null);
    Assert.deepEqual(await fixture.provider.refreshLog(fixture.filePath), {
      id,
      indexed: false,
    });
  } finally {
    Services.prefs.setBoolPref(
      "mailnews.database.global.indexer.enabled",
      true
    );
  }

  Assert.equal(
    (await fixture.provider.getText(id)).body,
    "sender: allowedloggedneedle",
    "Disabling indexing retains text when the log still exists"
  );

  const unlogged = { ...fixture.conversation, id: "unlogged-conversation" };
  Assert.deepEqual(
    await fixture.provider.refreshConversation(unlogged),
    [],
    "No writer has no transcript"
  );
  Services.prefs.setBoolPref("purple.logging.log_ims", false);
  try {
    getLogWriter(unlogged);
    Assert.deepEqual(
      await fixture.provider.refreshConversation(unlogged),
      [],
      "Disabled writer supplies no paths"
    );
  } finally {
    closeLogWriter(unlogged);
    Services.prefs.setBoolPref("purple.logging.log_ims", true);
  }
});

add_task(async function test_cancellationAndCloseDrainQueuedReads() {
  const fixture = await openChatFixture("cancel");
  await logText(fixture, "retainedneedle");
  const { id } = await fixture.provider.refreshLog(fixture.filePath);
  const controller = new AbortController();
  const reason = new Error("Cancel this refresh");
  let release;
  const blocker = queueFileOperation(
    fixture.filePath,
    () =>
      new Promise(resolve => {
        release = resolve;
      })
  );
  const pending = fixture.provider.refreshLog(fixture.filePath, {
    signal: controller.signal,
  });
  const rejected = (async () => {
    await Assert.rejects(pending, error => error === reason);
  })();
  await TestUtils.waitForCondition(
    () => release && gFilePromises.get(fixture.filePath) !== blocker
  );
  controller.abort(reason);
  const closing = fixture.provider.close();
  Assert.equal(
    fixture.provider.close(),
    closing,
    "One close drains pending work"
  );
  release();
  await rejected;
  await closing;
  await Assert.rejects(
    fixture.provider.refreshLog(fixture.filePath),
    /closing/
  );
  const reopened = await ChatSearchProvider.open(fixture.file);
  try {
    Assert.equal((await reopened.getText(id)).body, "sender: retainedneedle");
    const aborted = new AbortController();
    aborted.abort(reason);
    await Assert.rejects(
      reopened.refreshLog(fixture.filePath, { signal: aborted.signal }),
      error => error === reason
    );
  } finally {
    await reopened.close();
  }
});

add_task(async function test_sourceChangeDuringParsingDoesNotPublishOldText() {
  const fixture = await openChatFixture("source-race");
  await logText(fixture, "oldraceneedle", { remoteId: "edited" });
  const original = logs.getLogFromFile;
  logs.getLogFromFile = async function (...args) {
    const log = await original.apply(this, args);
    const getConversation = log.getConversation;
    log.getConversation = async function () {
      const parsed = await getConversation.call(this);
      await logText(fixture, "newraceneedle", { remoteId: "edited" });
      return parsed;
    };
    return log;
  };
  let result;
  try {
    result = await fixture.provider.refreshLog(fixture.filePath);
    Assert.ok(
      !result.indexed,
      "A newer edit wins over an already parsed snapshot"
    );
    Assert.equal(await fixture.provider.getText(result.id), null);
  } finally {
    logs.getLogFromFile = original;
  }
  Assert.ok((await fixture.provider.refreshLog(fixture.filePath)).indexed);
  Assert.equal(
    (await fixture.provider.getText(result.id)).body,
    "sender: newraceneedle"
  );
});

add_task(async function test_rotationRequiresCrossFileRedactionSupport() {
  const fixture = await openChatFixture("rotation");
  await logText(fixture, "firstsegment");
  fixture.writer.startNewFile(
    fixture.conversation.startDate / 1000 + 1000,
    true
  );
  await fixture.writer._initialized;
  await Assert.rejects(
    fixture.provider.refreshConversation(fixture.conversation),
    /Cross-file chat refresh requires logger/
  );
});

add_task(
  async function test_publicQueryKeepsTranscriptIdentityAndCurrentText() {
    const first = await openChatFixture("query-first");
    const second = await openChatFixture("query-second");
    const { provider } = first;
    const ids = [first, second].map(
      (fixture, i) =>
        "chat:" +
        JSON.stringify([
          "search-test",
          i ? "search-query-second" : "search-query-first",
          "buddy",
          PathUtils.filename(fixture.filePath),
        ])
    );
    for (const fixture of [first, second]) {
      await logText(fixture, "Café orbit shared", { remoteId: "shared" });
      await provider.refreshLog(fixture.filePath);
    }
    const page = await provider.search('"cafe orbit"', { limit: 1 });
    Assert.equal(page.items.length, 1);
    Assert.ok(page.cursor);
    const next = await provider.search('"cafe orbit"', {
      limit: 1,
      cursor: page.cursor,
    });
    Assert.equal(next.resultSetId, page.resultSetId);
    Assert.equal(next.cursor, null);
    Assert.deepEqual(
      [...page.items, ...next.items].map(hit => hit.id).sort(),
      [...ids].sort(),
      "Equal text and remote IDs retain both physical transcript files"
    );
    Assert.ok(
      [...page.items, ...next.items].every(hit => hit.location === null)
    );
    Assert.deepEqual((await provider.search("cafe absentneedle")).items, []);
    Assert.deepEqual(
      (await provider.search("cafe absentneedle", { andTerms: false })).items
        .map(hit => hit.id)
        .sort(),
      [...ids].sort()
    );
    await logText(first, "replacementneedle", { remoteId: "shared" });
    Assert.deepEqual(
      (await provider.search("orbit")).items.map(hit => hit.id),
      [ids[1]],
      "An unrefreshed edit hides the old transcript before text is replaced"
    );
    const refreshing = provider.refreshLog(first.filePath);
    const current = provider.search("replacementneedle");
    await refreshing;
    Assert.deepEqual(
      (await current).items.map(hit => hit.id),
      [ids[0]]
    );
    Services.prefs.setBoolPref(
      "mailnews.database.global.indexer.enabled",
      false
    );
    try {
      Assert.deepEqual((await provider.search("orbit")).items, []);
    } finally {
      Services.prefs.setBoolPref(
        "mailnews.database.global.indexer.enabled",
        true
      );
    }
    const resolveDocument = provider.resolveDocument;
    provider.resolveDocument = async function (...args) {
      const state = await resolveDocument.apply(this, args);
      Services.prefs.setBoolPref(
        "mailnews.database.global.indexer.enabled",
        false
      );
      return state;
    };
    try {
      Assert.deepEqual(
        (await provider.search("orbit")).items,
        [],
        "Disabling indexing after resolution still prevents query delivery"
      );
    } finally {
      provider.resolveDocument = resolveDocument;
      Services.prefs.setBoolPref(
        "mailnews.database.global.indexer.enabled",
        true
      );
    }
    const controller = new AbortController();
    const reason = new Error("Cancel the transcript query");
    controller.abort(reason);
    await Assert.rejects(
      provider.search("orbit", { signal: controller.signal }),
      error => error === reason
    );
    await Assert.rejects(provider.search("orbit", { limit: 0 }), /page size/);
    Assert.deepEqual(
      (await provider.search("orbit")).items.map(hit => hit.id),
      [ids[1]],
      "A rejected query does not starve later provider operations"
    );
    await provider.close();
    await Assert.rejects(provider.search("orbit"), /provider is closing/);
  }
);

add_task(async function test_resolveLogKeepsTheClickedPhysicalFile() {
  const fixture = await openChatFixture("open-physical");
  const { provider, writer, conversation } = fixture;
  const firstPath = fixture.filePath;
  await logText(fixture, "physicalopenneedle first", { remoteId: "shared" });
  await provider.refreshLog(firstPath);
  writer.startNewFile(conversation.startDate / 1000 + 1000, true);
  await writer._initialized;
  const selectedPath = writer.currentPath;
  await logText(fixture, "physicalopenneedle selected", { remoteId: "shared" });
  await provider.refreshLog(selectedPath);
  const ids = [firstPath, selectedPath].map(
    filePath =>
      "chat:" +
      JSON.stringify([
        "search-test",
        "search-open-physical",
        "buddy",
        PathUtils.filename(filePath),
      ])
  );
  const page = await provider.search("physicalopenneedle");
  Assert.deepEqual(page.items.map(hit => hit.id).sort(), [...ids].sort());
  const firstHit = page.items.find(hit => hit.id == ids[0]);
  const selectedHit = page.items.find(hit => hit.id == ids[1]);
  const request = { ...selectedHit };
  const pending = provider.resolveLog(request);
  Object.assign(request, firstHit);
  const result = await pending;
  Assert.equal(result.status, "ready");
  Assert.equal(result.id, ids[1]);
  Assert.equal(result.log.path, selectedPath);
  Assert.equal(result.contentRevision, selectedHit.contentRevision);
  Assert.equal(result.textRevision, selectedHit.textRevision);
  Assert.deepEqual(
    result.conversation
      .getMessages()
      .filter(message => !message.noLog)
      .map(message => message.message),
    ["physicalopenneedle selected"],
    "The reader receives only the clicked file, not the grouped day or another version"
  );
  await queueFileOperation(selectedPath, () => IOUtils.remove(selectedPath));
  Assert.deepEqual(await provider.resolveLog(selectedHit), {
    status: "deleted",
  });
  Assert.equal((await provider.resolveLog(firstHit)).status, "ready");
});

add_task(async function test_resolveLogChecksTokensPolicyAndCancellation() {
  const fixture = await openChatFixture("open-tokens");
  const { provider, filePath } = fixture;
  await logText(fixture, "openrevisionneedle", { remoteId: "edited" });
  await provider.refreshLog(filePath);
  const [oldHit] = (await provider.search("openrevisionneedle")).items;
  await provider.refreshLog(filePath);
  Assert.deepEqual(await provider.resolveLog(oldHit), { status: "stale" });
  const [hit] = (await provider.search("openrevisionneedle")).items;
  Services.prefs.setBoolPref("mailnews.database.global.indexer.enabled", false);
  try {
    Assert.deepEqual(await provider.resolveLog(hit), { status: "ineligible" });
  } finally {
    Services.prefs.setBoolPref(
      "mailnews.database.global.indexer.enabled",
      true
    );
  }
  const controller = new AbortController();
  const reason = new Error("Cancel the transcript opening");
  controller.abort(reason);
  await Assert.rejects(
    provider.resolveLog(hit, { signal: controller.signal }),
    error => error === reason
  );
  Assert.throws(
    () => provider.resolveLog({ ...hit, id: "mail-message-id" }),
    /Invalid chat document identity/
  );
  Assert.throws(
    () => provider.resolveLog({ id: hit.id }),
    /current chat search hit/
  );
  await logText(fixture, "newopeningneedle", { remoteId: "edited" });
  Assert.deepEqual(await provider.resolveLog(hit), { status: "stale" });
  await provider.refreshLog(filePath);
  const [current] = (await provider.search("newopeningneedle")).items;
  Assert.equal((await provider.resolveLog(current)).status, "ready");
  await provider.close();
  await Assert.rejects(provider.resolveLog(current), /provider is closing/);
});

add_task(async function test_resolveLogPreservesErrorsAndDetectsParseRaces() {
  const fixture = await openChatFixture("open-race");
  const { provider, filePath } = fixture;
  await logText(fixture, "oldopeningrace", { remoteId: "edited" });
  await provider.refreshLog(filePath);
  const [hit] = (await provider.search("oldopeningrace")).items;
  const original = logs.getLogFromFile;
  const failure = new Error("Original logger read failure");
  logs.getLogFromFile = async () => {
    throw failure;
  };
  try {
    await Assert.rejects(provider.resolveLog(hit), error => error === failure);
  } finally {
    logs.getLogFromFile = original;
  }
  Assert.equal((await provider.resolveLog(hit)).status, "ready");
  logs.getLogFromFile = async function (...args) {
    const log = await original.apply(this, args);
    const getConversation = log.getConversation;
    log.getConversation = async function () {
      const parsed = await getConversation.call(this);
      await logText(fixture, "replacementopeningrace", { remoteId: "edited" });
      return parsed;
    };
    return log;
  };
  try {
    Assert.deepEqual(await provider.resolveLog(hit), { status: "stale" });
  } finally {
    logs.getLogFromFile = original;
  }
  await provider.refreshLog(filePath);
  const [current] = (await provider.search("replacementopeningrace")).items;
  const controller = new AbortController();
  const reason = new Error("Cancel after parsing the physical transcript");
  logs.getLogFromFile = async function (...args) {
    const log = await original.apply(this, args);
    const getConversation = log.getConversation;
    log.getConversation = async function () {
      const parsed = await getConversation.call(this);
      controller.abort(reason);
      return parsed;
    };
    return log;
  };
  try {
    await Assert.rejects(
      provider.resolveLog(current, { signal: controller.signal }),
      error => error === reason
    );
  } finally {
    logs.getLogFromFile = original;
  }
  Assert.equal((await provider.resolveLog(current)).status, "ready");
});

add_task(async function test_persistedNoLogRecordCannotReachTheReader() {
  const fixture = await openChatFixture("open-no-log");
  const { provider, filePath } = fixture;
  await logText(fixture, "publicopeningneedle");
  // The writer omits noLog messages. Supply a persisted record explicitly to
  // exercise admission of older or externally changed logs, not writer behavior.
  const record = {
    date: "2022-03-04T12:00:02Z",
    who: "sender",
    text: "privatenologopeningneedle",
    flags: ["incoming", "noLog"],
    remoteId: "private",
  };
  await queueFileOperation(filePath, () =>
    IOUtils.writeUTF8(filePath, JSON.stringify(record) + "\n", {
      mode: "append",
    })
  );
  await provider.refreshLog(filePath);
  Assert.deepEqual(
    (await provider.search("privatenologopeningneedle")).items,
    []
  );
  const [hit] = (await provider.search("publicopeningneedle")).items;
  Assert.ok(hit);
  Assert.deepEqual(await provider.resolveLog(hit), { status: "ineligible" });
});

add_task(async function test_appendBeforeParsingMakesTheOpeningStale() {
  const fixture = await openChatFixture("open-before-parse");
  const { provider, filePath } = fixture;
  await logText(fixture, "beforeparseneedle", { remoteId: "edited" });
  await provider.refreshLog(filePath);
  const [hit] = (await provider.search("beforeparseneedle")).items;
  const original = logs.getLogFromFile;
  logs.getLogFromFile = async function (...args) {
    await logText(fixture, "afterappendneedle", { remoteId: "edited" });
    return original.apply(this, args);
  };
  try {
    Assert.deepEqual(
      await provider.resolveLog(hit),
      { status: "stale" },
      "An append between source validation and the logger read is a stale hit"
    );
  } finally {
    logs.getLogFromFile = original;
  }
  await provider.refreshLog(filePath);
  const [current] = (await provider.search("afterappendneedle")).items;
  Assert.equal((await provider.resolveLog(current)).status, "ready");
});

add_task(async function test_loggerFailureSurvivesAConcurrentAppend() {
  const fixture = await openChatFixture("open-error-append");
  const { provider, filePath } = fixture;
  await logText(fixture, "beforeerrorappend", { remoteId: "edited" });
  await provider.refreshLog(filePath);
  const [hit] = (await provider.search("beforeerrorappend")).items;
  const original = logs.getLogFromFile;
  const failure = new Error("Original read failed while the source changed");
  logs.getLogFromFile = async () => {
    await logText(fixture, "aftererrorappend", { remoteId: "edited" });
    throw failure;
  };
  try {
    await Assert.rejects(provider.resolveLog(hit), error => error === failure);
  } finally {
    logs.getLogFromFile = original;
  }
  await provider.refreshLog(filePath);
  const [current] = (await provider.search("aftererrorappend")).items;
  Assert.equal((await provider.resolveLog(current)).status, "ready");
});
