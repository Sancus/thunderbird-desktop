/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";
do_get_profile();

const { ChatSearchRedactionObserver } = ChromeUtils.importESModule(
  "resource:///modules/panorama/ChatSearchRedactionObserver.sys.mjs"
);
const { PanoramaSearchIndex } = ChromeUtils.importESModule(
  "resource:///modules/panorama/PanoramaSearchIndex.sys.mjs"
);
const { ChatSearchProvider, chatSearchDocumentId } = ChromeUtils.importESModule(
  "resource:///modules/panorama/ChatSearchProvider.sys.mjs"
);
const { GenericConvIMPrototype } = ChromeUtils.importESModule(
  "resource:///modules/jsProtoHelper.sys.mjs"
);
const { UIConversation } = ChromeUtils.importESModule(
  "resource:///modules/imConversations.sys.mjs"
);
const {
  logs,
  getChatLogArchive,
  getLogWriter,
  closeLogWriter,
  queueFileOperation,
  gFilePromises,
  getChatPrivacyState,
  acknowledgeChatPrivacyIntent,
} = ChromeUtils.importESModule("resource:///modules/logger.sys.mjs");
const { applyChatSearchPrivacyReceipt } = ChromeUtils.importESModule(
  "resource:///modules/panorama/ChatSearchRedaction.sys.mjs"
);
const { openSearchWriter } = ChromeUtils.importESModule(
  "resource:///modules/panorama/SearchMigrationHold.sys.mjs"
);
let privacyConversationId = 10000;

/**
 * Creates the same protocol/UI conversation objects used by existing chat tests,
 * plus a real logger writer, owned sidecar and actual Services observer.
 *
 * @param {string} name - Unique fixture suffix.
 * @returns {Promise<object>} Owned conversation, writer, provider and observer.
 */
async function privacyFixture(name) {
  logs.init();
  const conversation = Object.create(GenericConvIMPrototype);
  conversation._name = "buddy";
  conversation._date = new Date("2022-03-04T12:00:00Z").valueOf() * 1000;
  conversation.id = ++privacyConversationId;
  conversation._observers = [];
  conversation._account = {
    imAccount: {
      id: "privacy-" + name,
      name: "privacy-" + name,
      normalizedName: "privacy-" + name,
      alias: "",
      protocol: { normalizedName: "search-test", name: "Search test" },
    },
    normalize: value => value,
    DEBUG() {},
    ERROR(error) {
      throw error;
    },
  };
  const ui = new UIConversation(conversation);
  const writer = getLogWriter(conversation);
  await writer._initialized;
  const file = do_get_profile().clone();
  file.append("privacy-observer-" + name + ".sqlite");
  const provider = await ChatSearchProvider.open(file);
  const errors = [];
  const observer = new ChatSearchRedactionObserver(provider, {
    onError: error => errors.push(error),
  });
  observer.start();
  observer.start();
  const fixture = {
    conversation,
    ui,
    writer,
    file,
    provider,
    observer,
    errors,
    expectedFailure: null,
  };
  registerCleanupFunction(async () => {
    try {
      await observer.close();
    } catch (error) {
      if (error !== fixture.expectedFailure) {
        throw error;
      }
    } finally {
      if (fixture.expectedFailure) {
        await Assert.rejects(
          provider.close(),
          error => error === fixture.expectedFailure
        );
      } else {
        await provider.close();
      }
      conversation.removeObserver(ui._convObservers.get(conversation));
      closeLogWriter(conversation);
      for (const path of writer.paths) {
        await gFilePromises.get(path);
        await IOUtils.remove(path, { ignoreAbsent: true });
      }
    }
  });
  return fixture;
}

/**
 * Appends via protocol -> UIConversation -> global new-text -> actual logger.
 *
 * @param {object} fixture - Existing fixture.
 * @param {string} id - Protocol message ID.
 * @param {string} text - Logged body text.
 * @returns {Promise<void>} Resolves after the logger's pending append.
 */
async function writePrivacyMessage(fixture, id, text) {
  fixture.conversation.writeMessage("sender", text, {
    incoming: true,
    remoteId: id,
    time: fixture.conversation.startDate / 1000000 + 1,
  });
  await fixture.writer._initialized;
  await gFilePromises.get(fixture.writer.currentPath);
}

/**
 * Writes a stopped physical transcript and opens the real search provider.
 * No live logger, protocol account, conversation or selected view is created.
 *
 * @param {string} name - Test-owned archive account and sidecar suffix.
 * @returns {Promise<object>} Actual source bytes, scope, sidecar and provider.
 */
async function stoppedPrivacyFixture(name) {
  const folder = PathUtils.join(
    PathUtils.profileDir,
    "logs",
    "search-test",
    name,
    "buddy"
  );
  const path = PathUtils.join(folder, "2022-03-04.120000+0000.json");
  const file = do_get_profile().clone();
  file.append(name + ".sqlite");
  const header = {
    date: "2022-03-04T12:00:00.000Z",
    name: "buddy",
    title: "Retained stopped privacy",
    account: name,
    normalizedName: "buddy",
    protocol: "search-test",
    isChat: false,
  };
  const records = [
    {
      date: "2022-03-04T12:00:01.000Z",
      who: "sender",
      text: "stoppedprivateneedle",
      flags: ["incoming"],
      remoteId: "private-id",
    },
    {
      date: "2022-03-04T12:00:02.000Z",
      who: "sender",
      text: "stoppedcontrolneedle",
      flags: ["incoming"],
      remoteId: "keep-id",
    },
  ];
  const original = new TextEncoder().encode(
    [header, ...records].map(row => JSON.stringify(row)).join("\n") + "\n"
  );
  const subject = {
    noLog: true,
    remoteId: "private-id",
    conversation: {
      account: {
        normalizedName: name,
        protocol: { normalizedName: "search-test" },
      },
      normalizedName: "buddy",
      isChat: false,
    },
    get displayMessage() {
      throw new Error("NoLog payload must never be read");
    },
    get who() {
      throw new Error("NoLog sender must never be read");
    },
    get time() {
      throw new Error("NoLog timestamp must never be read");
    },
  };
  const fixture = {
    folder,
    path,
    file,
    id: chatSearchDocumentId(path),
    header,
    records,
    original,
    subject,
    provider: null,
  };
  registerCleanupFunction(async () => {
    await fixture.provider?.close();
    await IOUtils.remove(folder, { recursive: true, ignoreAbsent: true });
  });
  await IOUtils.makeDirectory(folder, { createAncestors: true });
  await IOUtils.write(path, original);
  fixture.provider = await ChatSearchProvider.open(file);
  Assert.ok((await fixture.provider.refreshLog(path)).indexed);
  return fixture;
}

add_setup(function setupPrivacyPreferences() {
  const names = [
    "purple.logging.log_ims",
    "chat.logging.cleanup",
    "mailnews.database.global.indexer.enabled",
  ];
  const old = names.map(name => [
    name,
    Services.prefs.prefHasUserValue(name),
    Services.prefs.getBoolPref(name, false),
  ]);
  Services.prefs.setBoolPref(names[0], true);
  Services.prefs.setBoolPref(names[1], false);
  Services.prefs.setBoolPref(names[2], true);
  registerCleanupFunction(() => {
    for (const [name, had, value] of old) {
      if (had) {
        Services.prefs.setBoolPref(name, value);
      } else {
        Services.prefs.clearUserPref(name);
      }
    }
  });
});

// These stopped-source cases run before the normal live conversation fixtures.
add_task(async function test_stoppedArchiveErasesSourceTextAndRecovery() {
  const bag = Cc["@mozilla.org/mailnews/migration-writer-lease;1"].getService(
    Ci.nsIPropertyBag2
  );
  Assert.equal(bag.getPropertyAsUint32("writer-history.chat"), 0);
  const f = await stoppedPrivacyFixture("s508-stopped-privacy");
  const [hit] = (await f.provider.search("stoppedprivateneedle")).items;
  Assert.equal(hit.id, f.id);
  const text = await f.provider.getText(f.id);
  await f.provider.close();
  const index = await PanoramaSearchIndex.open(f.file, async () => null);
  try {
    // Actual quarantined storage for this transcript, not a legacy import or
    // invented eligible document. The null document cannot authorize a hit.
    await index.retainRecovery([
      {
        recordId: "stopped-recovery-" + f.id,
        documentId: f.id,
        kind: "chat",
        sourceRevision: text.contentRevision,
        payload: { header: f.header, records: f.records },
        document: null,
      },
    ]);
  } finally {
    await index.close();
  }
  f.provider = await ChatSearchProvider.open(f.file);
  const [retained] = await f.provider.getRecoveryRecords(f.id);
  Assert.equal(retained.payload.records[0].text, "stoppedprivateneedle");
  Assert.deepEqual(await f.provider.redactMessage(f.subject), [f.path]);
  const erasedSource = await IOUtils.readUTF8(f.path);
  Assert.ok(!erasedSource.includes("stoppedprivateneedle"));
  Assert.ok(erasedSource.includes("stoppedcontrolneedle"));
  Assert.equal(
    (await f.provider.getText(f.id)).body,
    "sender: stoppedcontrolneedle"
  );
  Assert.deepEqual((await f.provider.search("stoppedprivateneedle")).items, []);
  Assert.equal((await f.provider.resolveLog(hit)).status, "stale");
  const [erased] = await f.provider.getRecoveryRecords(f.id);
  Assert.ok(erased.erased);
  Assert.equal(erased.payload, null);
  await openSearchWriter("chat-search", async work => {
    const archive = await getChatLogArchive(work);
    const state = await archive.getChatPrivacyState();
    Assert.ok(
      !state.pending.some(row => row.scope.account === f.header.account)
    );
    Assert.ok(
      state.completed.some(
        row =>
          row.scope.account === f.header.account && row.targets.length === 1
      )
    );
    Assert.strictEqual(state.historyKnown, false);
  });
  await f.provider.close();
  await openSearchWriter("chat-search", async work => {
    const archive = await getChatLogArchive(work);
    await archive.queueFileOperation(f.path, wait =>
      wait(() => IOUtils.write(f.path, f.original))
    );
  });
  f.provider = await ChatSearchProvider.open(f.file);
  Assert.equal(
    await f.provider.getText(f.id),
    null,
    "Receipt replay erases rather than publishing a row"
  );
  Assert.ok(!(await IOUtils.readUTF8(f.path)).includes("stoppedprivateneedle"));
  await f.provider.refreshLog(f.path);
  Assert.equal(
    (await f.provider.getText(f.id)).body,
    "sender: stoppedcontrolneedle"
  );
  Assert.deepEqual((await f.provider.search("stoppedprivateneedle")).items, []);
  const [replayed] = await f.provider.getRecoveryRecords(f.id);
  Assert.ok(replayed.erased);
  Assert.equal(replayed.payload, null);
  Assert.equal(
    bag.getPropertyAsUint32("writer-history.chat"),
    0,
    "Actual stopped erasure/replay did not start live Chat"
  );
});

add_task(async function test_stoppedArchiveCancellationRetainsPendingReceipt() {
  const f = await stoppedPrivacyFixture("s508-stopped-cancel");
  const receipt = await openSearchWriter("chat-search", async work => {
    const archive = await getChatLogArchive(work);
    return archive.captureChatPrivacyIntent(f.subject);
  });
  Assert.equal(receipt.targets.length, 1);
  const reason = new Error(
    "Cancel while the real archive file queue is reading"
  );
  await openSearchWriter("chat-search", async work => {
    const archive = await getChatLogArchive(work);
    const controller = new AbortController();
    const reading = archive.queueFileOperation(f.path, async wait => {
      await wait(() => IOUtils.read(f.path));
      controller.abort(reason);
    });
    const erasing = applyChatSearchPrivacyReceipt(receipt, {
      signal: controller.signal,
      archive,
    });
    erasing.catch(() => {});
    await reading;
    await Assert.rejects(erasing, error => error === reason);
    Assert.deepEqual([...(await IOUtils.read(f.path))], [...f.original]);
    const state = await archive.getChatPrivacyState();
    Assert.ok(
      state.pending.some(row => row.id === receipt.id),
      "Canceled actual IO cannot acknowledge privacy completion"
    );
  });
  await f.provider.close();
  f.provider = await ChatSearchProvider.open(f.file);
  Assert.equal(await f.provider.getText(f.id), null);
  await f.provider.refreshLog(f.path);
  Assert.equal(
    (await f.provider.getText(f.id)).body,
    "sender: stoppedcontrolneedle"
  );
  Assert.deepEqual((await f.provider.search("stoppedprivateneedle")).items, []);
  await openSearchWriter("chat-search", async work => {
    const archive = await getChatLogArchive(work);
    const state = await archive.getChatPrivacyState();
    Assert.ok(!state.pending.some(row => row.id === receipt.id));
    Assert.ok(state.completed.some(row => row.id === receipt.id));
  });
  const bag = Cc["@mozilla.org/mailnews/migration-writer-lease;1"].getService(
    Ci.nsIPropertyBag2
  );
  Assert.equal(bag.getPropertyAsUint32("writer-history.chat"), 0);
});

add_task(
  async function test_actualNoLogUpdatePersistsAndRefreshesRotatedFiles() {
    const f = await privacyFixture("rotated");
    await writePrivacyMessage(f, "private-id", "firstprivateneedle");
    await writePrivacyMessage(f, "keep-id", "keptneedle");
    f.writer.startNewFile(f.conversation.startDate / 1000 + 1000, true);
    await f.writer._initialized;
    await writePrivacyMessage(f, "private-id", "secondprivateneedle");
    for (const path of f.writer.paths) {
      await f.provider.refreshLog(path);
    }
    f.conversation.updateMessage("sender", "neverpersistthisneedle", {
      incoming: true,
      noLog: true,
      remoteId: "private-id",
      time: f.conversation.startDate / 1000000 + 1,
    });
    await f.observer.flush();
    const bodies = [];
    for (const path of f.writer.paths) {
      const raw = await IOUtils.readUTF8(path);
      Assert.ok(
        !raw.includes("firstprivateneedle") &&
          !raw.includes("secondprivateneedle")
      );
      Assert.ok(!raw.includes("neverpersistthisneedle"));
      bodies.push((await f.provider.getText(chatSearchDocumentId(path))).body);
    }
    Assert.deepEqual(bodies, ["sender: keptneedle", ""]);
    Assert.deepEqual(f.errors, []);
    await f.observer.close();
  }
);

add_task(async function test_closeCapturesWriterPathsAndDrainsTheRefresh() {
  const f = await privacyFixture("close");
  await writePrivacyMessage(f, "private-id", "closeprivateneedle");
  const path = f.writer.currentPath;
  await f.provider.refreshLog(path);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const original = f.provider.redactMessage.bind(f.provider);
  let completed = false;
  f.provider.redactMessage = async (...args) => {
    const result = await original(...args);
    entered.resolve();
    await release.promise;
    completed = true;
    return result;
  };
  registerCleanupFunction(() => release.resolve());
  f.conversation.updateMessage("sender", "notlogged", {
    noLog: true,
    remoteId: "private-id",
  });
  closeLogWriter(f.conversation);
  await entered.promise;
  const closing = f.observer.close();
  Assert.equal(f.observer.close(), closing);
  release.resolve();
  await closing;
  Assert.ok(
    completed,
    "Close waits for the sidecar refresh after durable source redaction"
  );
  Assert.equal((await f.provider.getText(chatSearchDocumentId(path))).body, "");
  Assert.throws(() => f.observer.start(), /closing/);
});

add_task(async function test_firstPrivacyFailureHoldsFlushAndClose() {
  const f = await privacyFixture("failure");
  await writePrivacyMessage(f, "private-id", "sourceuntouchedneedle");
  const path = f.writer.currentPath;
  const before = await IOUtils.readUTF8(path);
  await f.provider.refreshLog(path);
  const hit = (await f.provider.search("sourceuntouchedneedle")).items[0];
  Assert.equal(hit.id, chatSearchDocumentId(path));
  const failure = new Error("Original queued privacy source failure");
  f.expectedFailure = failure;
  queueFileOperation(path, () => Promise.reject(failure));
  f.conversation.updateMessage("sender", "notlogged", {
    noLog: true,
    remoteId: "private-id",
  });
  await Assert.rejects(f.observer.flush(), error => error === failure);
  Assert.deepEqual(f.errors, [failure]);
  Assert.strictEqual(
    f.observer.migrationFailures[0],
    failure,
    "Detaching or draining cannot discard the original privacy failure"
  );
  Assert.equal(await IOUtils.readUTF8(path), before);
  await Assert.rejects(
    f.provider.search("sourceuntouchedneedle"),
    error => error === failure
  );
  await Assert.rejects(f.provider.getText(hit.id), error => error === failure);
  await Assert.rejects(f.provider.resolveLog(hit), error => error === failure);
  await f.provider.refreshLog(path);
  await Assert.rejects(
    f.provider.search("sourceuntouchedneedle"),
    error => error === failure
  );
  await Assert.rejects(f.observer.close(), error => error === failure);
  await Assert.rejects(f.provider.close(), error => error === failure);
});

add_task(
  async function test_displayOnlyRemovalDoesNotBecomePersistentDeletion() {
    const f = await privacyFixture("display");
    await writePrivacyMessage(f, "kept-id", "displaykeptneedle");
    const path = f.writer.currentPath;
    const before = await IOUtils.readUTF8(path);
    f.conversation.removeMessage("kept-id");
    await f.observer.flush();
    Assert.equal(await IOUtils.readUTF8(path), before);
    await writePrivacyMessage(f, "delete-id", "actualdeletedneedle");
    f.conversation.updateMessage("sender", "removed", {
      deleted: true,
      remoteId: "delete-id",
      time: f.conversation.startDate / 1000000 + 1,
    });
    await f.observer.flush();
    const raw = await IOUtils.readUTF8(path);
    Assert.ok(!raw.includes("actualdeletedneedle"));
    Assert.ok(raw.includes("displaykeptneedle"));
    Assert.deepEqual(f.errors, []);
    await f.observer.close();
  }
);

add_task(async function test_noLogErasesStoredTextWhileIndexingIsDisabled() {
  const f = await privacyFixture("disabled");
  await writePrivacyMessage(f, "private-id", "disabledprivateneedle");
  const path = f.writer.currentPath;
  const id = chatSearchDocumentId(path);
  await f.provider.refreshLog(path);
  Assert.equal(
    (await f.provider.getText(id)).body,
    "sender: disabledprivateneedle"
  );
  Assert.throws(
    () => f.provider.refreshLog(path, { eraseStoredText: "yes" }),
    /erasure must be boolean/
  );
  Assert.equal(
    (await f.provider.getText(id)).body,
    "sender: disabledprivateneedle"
  );
  const controller = new AbortController();
  const reason = new Error("Cancel chat stored-text erasure");
  controller.abort(reason);
  await Assert.rejects(
    f.provider.refreshLog(path, {
      eraseStoredText: true,
      signal: controller.signal,
    }),
    error => error === reason
  );
  Assert.equal(
    (await f.provider.getText(id)).body,
    "sender: disabledprivateneedle"
  );
  const original = await queueFileOperation(path, () => IOUtils.read(path));
  const pref = "mailnews.database.global.indexer.enabled";
  Services.prefs.setBoolPref(pref, false);
  let redacted;
  try {
    f.conversation.updateMessage("sender", "neverpersistdisabledneedle", {
      incoming: true,
      noLog: true,
      remoteId: "private-id",
    });
    await f.observer.flush();
    redacted = await queueFileOperation(path, () => IOUtils.read(path));
    const raw = new TextDecoder().decode(redacted);
    Assert.ok(!raw.includes("disabledprivateneedle"));
    Assert.ok(!raw.includes("neverpersistdisabledneedle"));
    await queueFileOperation(path, () => IOUtils.write(path, original));
  } finally {
    Services.prefs.setBoolPref(pref, true);
  }
  Assert.equal(
    await f.provider.getText(id),
    null,
    "Recreating the old transcript cannot resurrect an erased semantic copy"
  );
  Assert.deepEqual(
    (await f.provider.search("disabledprivateneedle")).items,
    []
  );
  await f.observer.close();
  await f.provider.close();
  const reopened = await ChatSearchProvider.open(f.file);
  try {
    Assert.equal(
      await reopened.getText(id),
      null,
      "Erasure survives sidecar reopen"
    );
    await queueFileOperation(path, () => IOUtils.write(path, redacted));
    await reopened.refreshLog(path);
    Assert.equal((await reopened.getText(id)).body, "");
    Assert.deepEqual(
      (await reopened.search("disabledprivateneedle")).items,
      []
    );
  } finally {
    await reopened.close();
  }
  Assert.deepEqual(f.errors, []);
});

add_task(
  async function test_pendingRedactionWithholdsLookupsAndDrainsProviderClose() {
    const f = await privacyFixture("pending");
    await writePrivacyMessage(f, "private-id", "pendingprivateneedle");
    await writePrivacyMessage(f, "keep-id", "pendingkeptneedle");
    const path = f.writer.currentPath;
    const id = chatSearchDocumentId(path);
    await f.provider.refreshLog(path);
    const hit = (await f.provider.search("pendingprivateneedle")).items[0];
    Assert.equal(hit.id, id);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    registerCleanupFunction(() => release.resolve());
    const held = queueFileOperation(path, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    f.conversation.updateMessage("sender", "neverpersistpendingneedle", {
      noLog: true,
      remoteId: "private-id",
    });
    let delivered = false;
    const search = (async () => {
      await Assert.rejects(
        f.provider.search("pendingprivateneedle"),
        /Chat privacy changed during search/
      );
      delivered = true;
    })();
    const text = f.provider.getText(id);
    const resolved = f.provider.resolveLog(hit);
    const controller = new AbortController();
    const reason = new Error("Cancel an overlapping chat privacy read");
    const cancelled = (async () => {
      await Assert.rejects(
        f.provider.getText(id, { signal: controller.signal }),
        error => error === reason
      );
    })();
    controller.abort(reason);
    let closed = false;
    const closing = f.provider.close();
    Assert.equal(f.provider.close(), closing);
    const observedClose = closing.then(() => {
      closed = true;
    });
    await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
    Assert.ok(
      !delivered,
      "No search result escapes the pending privacy operation"
    );
    Assert.ok(!closed, "Provider close waits for admitted privacy writes");
    release.resolve();
    await held;
    await search;
    Assert.equal(await text, null);
    Assert.equal((await resolved).status, "stale");
    await cancelled;
    await observedClose;
    await f.observer.flush();
    Assert.deepEqual(f.errors, []);
    await f.observer.close();
    const reopened = await ChatSearchProvider.open(f.file);
    try {
      Assert.deepEqual(
        (await reopened.search("pendingprivateneedle")).items,
        []
      );
      Assert.equal(
        (await reopened.getText(id)).body,
        "sender: pendingkeptneedle"
      );
      Assert.deepEqual(
        (await reopened.search("pendingkeptneedle")).items.map(item => item.id),
        [id]
      );
      const raw = await IOUtils.readUTF8(path);
      Assert.ok(!raw.includes("pendingprivateneedle"));
      Assert.ok(!raw.includes("neverpersistpendingneedle"));
    } finally {
      await reopened.close();
    }
  }
);

add_task(async function test_observedEditSuppressesOldSemanticContent() {
  const f = await privacyFixture("edit");
  await writePrivacyMessage(f, "edit-id", "supersedededitneedle");
  await writePrivacyMessage(f, "control-id", "unrelatededitcontrol");
  const path = f.writer.currentPath;
  const id = chatSearchDocumentId(path);
  await f.provider.refreshLog(path);
  const hit = (await f.provider.search("supersedededitneedle")).items[0];
  Assert.equal(hit.id, id);

  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  registerCleanupFunction(() => release.resolve());
  const held = queueFileOperation(path, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  f.conversation.updateMessage("sender", "replacementeditneedle", {
    incoming: true,
    remoteId: "edit-id",
    time: f.conversation.startDate / 1000000 + 2,
  });
  let delivered = false;
  const text = f.provider.getText(id).then(value => {
    delivered = true;
    return value;
  });
  await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
  Assert.ok(!delivered, "The old semantic read waits for the real logger edit");
  release.resolve();
  await held;
  Assert.equal(await text, null, "Changed source hides the old indexed body");
  Assert.equal((await f.provider.resolveLog(hit)).status, "stale");
  Assert.deepEqual((await f.provider.search("supersedededitneedle")).items, []);

  await f.provider.refreshLog(path);
  Assert.equal(
    (await f.provider.getText(id)).body,
    "sender: unrelatededitcontrol\n\nsender: replacementeditneedle"
  );
  Assert.deepEqual((await f.provider.search("supersedededitneedle")).items, []);
  Assert.deepEqual(
    (await f.provider.search("replacementeditneedle")).items.map(
      item => item.id
    ),
    [id]
  );
  Assert.deepEqual(
    (await f.provider.search("unrelatededitcontrol")).items.map(
      item => item.id
    ),
    [id]
  );
  Assert.deepEqual(f.errors, []);
  await f.observer.close();
});

/**
 * Returns the real pending receipt containing a fixture's exact physical log.
 *
 * @param {string} path - Existing logger file path.
 * @returns {Promise<object>} The single durable receipt for that target.
 */
async function pendingPrivacyReceipt(path) {
  const parts = JSON.stringify(JSON.parse(chatSearchDocumentId(path).slice(5)));
  const state = await getChatPrivacyState();
  const matching = state.pending.filter(receipt =>
    receipt.targets.some(target => JSON.stringify(target.relativePath) == parts)
  );
  Assert.equal(matching.length, 1, "One actual durable intent owns this log");
  return matching[0];
}

add_task(
  async function test_loggerPrivacyReplayErasesTextBeforeAcknowledgement() {
    const f = await privacyFixture("missed");
    await writePrivacyMessage(f, "private-id", "missedprivateneedle");
    await writePrivacyMessage(f, "keep-id", "missedkeptneedle");
    const path = f.writer.currentPath;
    const id = chatSearchDocumentId(path);
    const original = await IOUtils.read(path);
    await f.provider.refreshLog(path);
    const hit = (await f.provider.search("missedprivateneedle")).items[0];
    Assert.equal(hit.id, id);
    await f.observer.close();
    f.conversation.updateMessage("sender", "neverpersistmissedneedle", {
      noLog: true,
      remoteId: "private-id",
    });
    const receipt = await pendingPrivacyReceipt(path);
    Assert.equal(receipt.targets.length, 1);
    Assert.ok((await IOUtils.readUTF8(path)).includes("missedprivateneedle"));
    await f.provider.close();

    const reopened = await ChatSearchProvider.open(f.file);
    try {
      Assert.equal(
        await reopened.getText(id),
        null,
        "Replay does not republish a row"
      );
      await reopened.refreshLog(path);
      Assert.equal(
        (await reopened.getText(id)).body,
        "sender: missedkeptneedle"
      );
      Assert.deepEqual(
        (await reopened.search("missedprivateneedle")).items,
        []
      );
      Assert.equal((await reopened.resolveLog(hit)).status, "stale");
      let state = await getChatPrivacyState();
      Assert.ok(!state.pending.some(item => item.id == receipt.id));
      Assert.ok(state.completed.some(item => item.id == receipt.id));
      let raw = await IOUtils.readUTF8(path);
      Assert.ok(!raw.includes("missedprivateneedle"));
      Assert.ok(!raw.includes("neverpersistmissedneedle"));
      Assert.ok(raw.includes("missedkeptneedle"));

      await queueFileOperation(path, () => IOUtils.write(path, original));
      await reopened.refreshLog(path);
      raw = await IOUtils.readUTF8(path);
      Assert.ok(
        !raw.includes("missedprivateneedle"),
        "Restored excluded version is erased again"
      );
      Assert.equal(
        (await reopened.getText(id)).body,
        "sender: missedkeptneedle"
      );
      Assert.deepEqual(
        (await reopened.search("missedprivateneedle")).items,
        []
      );
      state = await getChatPrivacyState();
      Assert.ok(state.completed.some(item => item.id == receipt.id));
    } finally {
      await reopened.close();
    }

    await queueFileOperation(path, () => IOUtils.remove(path));
    const absent = await ChatSearchProvider.open(f.file);
    try {
      Assert.equal(
        await absent.getText(id),
        null,
        "Absent source is not empty text"
      );
      Assert.deepEqual((await absent.search("missedkeptneedle")).items, []);
      Assert.deepEqual((await absent.search("missedprivateneedle")).items, []);
    } finally {
      await absent.close();
    }
    await queueFileOperation(path, () => IOUtils.write(path, original));
    const restored = await ChatSearchProvider.open(f.file);
    try {
      Assert.equal(await restored.getText(id), null);
      await restored.refreshLog(path);
      Assert.equal(
        (await restored.getText(id)).body,
        "sender: missedkeptneedle"
      );
      Assert.deepEqual(
        (await restored.search("missedprivateneedle")).items,
        []
      );
      Assert.ok(
        !(await IOUtils.readUTF8(path)).includes("missedprivateneedle")
      );
    } finally {
      await restored.close();
    }
    Assert.deepEqual(f.errors, []);
  }
);

add_task(async function test_partialPrivacyReplaySurvivesProviderRestart() {
  const f = await privacyFixture("partial");
  await writePrivacyMessage(f, "private-id", "partialfirstneedle");
  await writePrivacyMessage(f, "keep-id", "partialkeptneedle");
  f.writer.startNewFile(f.conversation.startDate / 1000 + 1000, true);
  await f.writer._initialized;
  await writePrivacyMessage(f, "private-id", "partialsecondneedle");
  const paths = [...f.writer.paths];
  Assert.equal(paths.length, 2);
  for (const path of paths) {
    await f.provider.refreshLog(path);
  }
  await f.observer.close();
  f.conversation.updateMessage("sender", "neverpersistpartialneedle", {
    noLog: true,
    remoteId: "private-id",
  });
  const receipt = await pendingPrivacyReceipt(paths[0]);
  Assert.equal(receipt.targets.length, 2);
  const failure = new Error(
    "Interrupted after the first actual privacy source write"
  );
  await Assert.rejects(
    acknowledgeChatPrivacyIntent(receipt.id, async current => {
      // Stop after one genuine captured target; the full receipt stays pending.
      const firstPath = JSON.stringify(
        JSON.parse(chatSearchDocumentId(paths[0]).slice(5))
      );
      const firstTarget = current.targets.find(
        target => JSON.stringify(target.relativePath) == firstPath
      );
      Assert.ok(
        firstTarget,
        "The first physical file is actually in this receipt"
      );
      await applyChatSearchPrivacyReceipt({
        ...current,
        targets: [firstTarget],
      });
      throw failure;
    }),
    error => error === failure
  );
  Assert.ok(!(await IOUtils.readUTF8(paths[0])).includes("partialfirstneedle"));
  Assert.ok((await IOUtils.readUTF8(paths[1])).includes("partialsecondneedle"));
  Assert.ok(
    (await getChatPrivacyState()).pending.some(item => item.id == receipt.id)
  );
  await f.provider.close();

  const reopened = await ChatSearchProvider.open(f.file);
  try {
    const bodies = [];
    for (const path of paths) {
      const id = chatSearchDocumentId(path);
      Assert.equal(
        await reopened.getText(id),
        null,
        "Every replayed target row was erased"
      );
      await reopened.refreshLog(path);
      bodies.push((await reopened.getText(id)).body);
      Assert.ok(
        !(await IOUtils.readUTF8(path)).includes("neverpersistpartialneedle")
      );
    }
    Assert.deepEqual(bodies, ["sender: partialkeptneedle", ""]);
    Assert.deepEqual((await reopened.search("partialfirstneedle")).items, []);
    Assert.deepEqual((await reopened.search("partialsecondneedle")).items, []);
    const state = await getChatPrivacyState();
    Assert.ok(!state.pending.some(item => item.id == receipt.id));
    Assert.ok(state.completed.some(item => item.id == receipt.id));
  } finally {
    await reopened.close();
  }
  Assert.deepEqual(f.errors, []);
});

add_task(async function test_closedWriterPrivacyPreservesScopedControl() {
  const f = await privacyFixture("closed-target");
  const control = await privacyFixture("closed-control");
  await writePrivacyMessage(f, "shared-id", "closedprivateneedle");
  await writePrivacyMessage(control, "shared-id", "closedcontrolneedle");
  const path = f.writer.currentPath;
  const controlPath = control.writer.currentPath;
  const id = chatSearchDocumentId(path);
  const controlId = chatSearchDocumentId(controlPath);
  Assert.notEqual(id, controlId);
  await f.provider.refreshLog(path);
  await control.provider.refreshLog(controlPath);
  const controlBytes = await IOUtils.readUTF8(controlPath);
  await f.observer.close();
  await control.observer.close();
  await f.provider.close();
  await control.provider.close();
  closeLogWriter(f.conversation);
  f.conversation.updateMessage("sender", "neverpersistclosedneedle", {
    noLog: true,
    remoteId: "shared-id",
  });
  const receipt = await pendingPrivacyReceipt(path);
  Assert.equal(
    receipt.targets.length,
    1,
    "Closed history stays in the exact account scope"
  );
  const reopened = await ChatSearchProvider.open(f.file);
  let reopenedControl;
  try {
    reopenedControl = await ChatSearchProvider.open(control.file);
    Assert.equal(await reopened.getText(id), null);
    await reopened.refreshLog(path);
    Assert.equal((await reopened.getText(id)).body, "");
    Assert.deepEqual((await reopened.search("closedprivateneedle")).items, []);
    Assert.equal(
      (await reopenedControl.getText(controlId)).body,
      "sender: closedcontrolneedle"
    );
    Assert.equal(await IOUtils.readUTF8(controlPath), controlBytes);
    Assert.ok(
      !(await IOUtils.readUTF8(path)).includes("neverpersistclosedneedle")
    );
  } finally {
    try {
      await reopenedControl?.close();
    } finally {
      await reopened.close();
    }
  }
  Assert.deepEqual(f.errors, []);
  Assert.deepEqual(control.errors, []);
});

add_task(async function test_typeChangePrivacyUsesEveryPhysicalLog() {
  for (const rotated of [false, true]) {
    const f = await privacyFixture("type-change-" + rotated);
    const control = await privacyFixture("type-control-" + rotated);
    await writePrivacyMessage(control, "private-id", "typecontrolneedle");
    const controlPath = control.writer.currentPath;
    const controlId = chatSearchDocumentId(controlPath);
    await control.provider.refreshLog(controlPath);
    await control.observer.close();
    const controlBytes = await IOUtils.read(controlPath);

    await writePrivacyMessage(f, "private-id", "typeprivateneedle");
    await writePrivacyMessage(f, "direct-keep", "typedirectkeepneedle");
    const directPath = f.writer.currentPath;
    // Protocols can change the same conversation from a DM to a group. Shadow
    // GenericConvIMPrototype's read-only getter as a real type-changing protocol.
    Object.defineProperty(f.conversation, "isChat", { value: true });
    if (rotated) {
      f.writer.startNewFile(f.conversation.startDate / 1000 + 1000, true);
      await f.writer._initialized;
      await writePrivacyMessage(f, "private-id", "typeprivateneedle");
      await writePrivacyMessage(f, "group-keep", "typegroupkeepneedle");
    }
    const paths = [...f.writer.paths];
    Assert.equal(paths.length, rotated ? 2 : 1);
    Assert.equal(paths[0], directPath);
    const records = [];
    for (const [i, path] of paths.entries()) {
      Assert.ok((await f.provider.refreshLog(path)).indexed);
      const id = chatSearchDocumentId(path);
      const text = await f.provider.getText(id);
      const lines = (await IOUtils.readUTF8(path)).trimEnd().split("\n");
      const header = JSON.parse(lines[0]);
      Assert.equal(header.isChat, i == 1, "Each file retains its actual type");
      records.push({
        recordId: "type-recovery-" + id,
        documentId: id,
        kind: "chat",
        sourceRevision: text.contentRevision,
        // Exercise real recovery storage with this actual log's JSON records.
        // This is a quarantined storage input, not a legacy import fixture.
        payload: {
          header,
          records: lines.slice(1).map(line => JSON.parse(line)),
        },
        document: null,
      });
    }
    const hits = (await f.provider.search("typeprivateneedle")).items;
    Assert.deepEqual(
      hits.map(hit => hit.id).sort(),
      records.map(r => r.documentId).sort()
    );
    await f.observer.close();
    await f.provider.close();
    const index = await PanoramaSearchIndex.open(f.file, async () => null);
    try {
      await index.retainRecovery(records);
    } finally {
      await index.close();
    }

    const provider = await ChatSearchProvider.open(f.file);
    const errors = [];
    const observer = new ChatSearchRedactionObserver(provider, {
      onError: error => errors.push(error),
    });
    observer.start();
    try {
      for (const record of records) {
        const [stored] = await provider.getRecoveryRecords(record.documentId);
        Assert.ok(
          stored.payload.records.some(row => row.text == "typeprivateneedle")
        );
      }
      f.conversation.updateMessage("sender", "neverpersisttypechange", {
        noLog: true,
        remoteId: "private-id",
      });
      await observer.flush();
      Assert.deepEqual(errors, [], "Type changes do not poison privacy reads");
      for (const [i, path] of paths.entries()) {
        const id = chatSearchDocumentId(path);
        const lines = (await IOUtils.readUTF8(path)).trimEnd().split("\n");
        Assert.equal(JSON.parse(lines[0]).isChat, i == 1);
        const versions = lines
          .slice(1)
          .map(line => JSON.parse(line))
          .filter(row => row.remoteId == "private-id");
        Assert.ok(versions.length);
        Assert.ok(
          versions.every(
            row => row.text === "" && row.flags.includes("deleted")
          )
        );
        Assert.ok(!lines.join("\n").includes("neverpersisttypechange"));
        Assert.equal(
          (await provider.getText(id)).body,
          "sender: " + (i ? "typegroupkeepneedle" : "typedirectkeepneedle")
        );
        const [erased] = await provider.getRecoveryRecords(id);
        Assert.ok(erased.erased, "The actual retained recovery row was erased");
        Assert.equal(erased.payload, null);
      }
      Assert.deepEqual((await provider.search("typeprivateneedle")).items, []);
      for (const hit of hits) {
        Assert.equal((await provider.resolveLog(hit)).status, "stale");
      }
      Assert.equal(
        (await control.provider.getText(controlId)).body,
        "sender: typecontrolneedle"
      );
      Assert.deepEqual(
        [...(await IOUtils.read(controlPath))],
        [...controlBytes]
      );
    } finally {
      try {
        await observer.close();
      } finally {
        await provider.close();
      }
    }
    const reopened = await ChatSearchProvider.open(f.file);
    try {
      Assert.deepEqual((await reopened.search("typeprivateneedle")).items, []);
      for (const [i, path] of paths.entries()) {
        const id = chatSearchDocumentId(path);
        Assert.equal(
          (await reopened.getText(id)).body,
          "sender: " + (i ? "typegroupkeepneedle" : "typedirectkeepneedle")
        );
        const [erased] = await reopened.getRecoveryRecords(id);
        Assert.ok(erased.erased);
        Assert.equal(erased.payload, null);
      }
    } finally {
      await reopened.close();
    }
    Assert.deepEqual(f.errors, []);
    Assert.deepEqual(control.errors, []);
  }
});
