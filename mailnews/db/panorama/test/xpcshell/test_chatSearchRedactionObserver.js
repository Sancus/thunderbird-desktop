/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";
do_get_profile();

const { ChatSearchRedactionObserver } = ChromeUtils.importESModule(
  "resource:///modules/panorama/ChatSearchRedactionObserver.sys.mjs"
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
const { getLogWriter, closeLogWriter, queueFileOperation, gFilePromises } =
  ChromeUtils.importESModule("resource:///modules/logger.sys.mjs");
let privacyConversationId = 10000;

/**
 * Creates the same protocol/UI conversation objects used by existing chat tests,
 * plus a real logger writer, owned sidecar and actual Services observer.
 *
 * @param {string} name - Unique fixture suffix.
 * @returns {Promise<object>} Owned conversation, writer, provider and observer.
 */
async function privacyFixture(name) {
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
