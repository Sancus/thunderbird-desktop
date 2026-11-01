/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";
do_get_profile();

const { ChatSearchService } = ChromeUtils.importESModule(
  "resource:///modules/panorama/ChatSearchService.sys.mjs"
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
  getLogWriter,
  closeLogWriter,
  queueFileOperation,
  gFilePromises,
} = ChromeUtils.importESModule("resource:///modules/logger.sys.mjs");
let conversationId = 40000;

/**
 * Opens the real service before the first protocol/UIConversation message.
 *
 * @param {string} name - Unique physical account/sidecar suffix.
 * @returns {Promise<object>} Actual conversation, service and owned cleanup state.
 */
async function serviceFixture(name) {
  const conversation = Object.create(GenericConvIMPrototype);
  conversation._name = "buddy";
  conversation._date = new Date("2022-03-04T12:00:00Z").valueOf() * 1000;
  conversation.id = ++conversationId;
  conversation._observers = [];
  conversation._account = {
    imAccount: {
      id: "service-" + name,
      name: "service-" + name,
      normalizedName: "service-" + name,
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
  const file = do_get_profile().clone();
  file.append("chat-service-" + name + ".sqlite");
  const errors = [];
  const service = await ChatSearchService.open(file, {
    onError: error => errors.push(error),
  });
  const fixture = { conversation, ui, file, service, errors, writer: null };
  registerCleanupFunction(async () => {
    await fixture.service.close();
    conversation.removeObserver(ui._convObservers.get(conversation));
    closeLogWriter(conversation);
    for (const path of fixture.writer?.paths || []) {
      await gFilePromises.get(path);
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
  });
  return fixture;
}

/**
 * Sends a real protocol notification and drains the service, without manual refresh.
 *
 * @param {object} fixture - Actual service fixture.
 * @param {string} id - Protocol identity, independent of log identity.
 * @param {string} text - Actual logged body.
 * @returns {Promise<void>} Current logger/index work completion.
 */
async function writeServiceMessage(fixture, id, text) {
  fixture.conversation.writeMessage("sender", text, {
    incoming: true,
    remoteId: id,
    time: fixture.conversation.startDate / 1000000 + 1,
  });
  fixture.writer = getLogWriter(fixture.conversation);
  await fixture.service.flush();
}

add_setup(function setupServicePreferences() {
  const prefs = [
    "purple.logging.log_ims",
    "chat.logging.cleanup",
    "mailnews.database.global.indexer.enabled",
  ];
  const previous = prefs.map(name => [
    name,
    Services.prefs.prefHasUserValue(name),
    Services.prefs.getBoolPref(name, false),
  ]);
  Services.prefs.setBoolPref(prefs[0], true);
  Services.prefs.setBoolPref(prefs[1], false);
  Services.prefs.setBoolPref(prefs[2], true);
  registerCleanupFunction(() => {
    for (const [name, had, value] of previous) {
      if (had) {
        Services.prefs.setBoolPref(name, value);
      } else {
        Services.prefs.clearUserPref(name);
      }
    }
  });
});

add_task(async function test_realAdditionsPersistPhysicalIdentity() {
  const f = await serviceFixture("addition");
  await writeServiceMessage(f, "same-id", "<b>nativeadditionneedle</b>");
  const path = f.writer.currentPath;
  const id = chatSearchDocumentId(path);
  const page = await f.service.search("nativeadditionneedle");
  Assert.deepEqual(
    page.items.map(hit => hit.id),
    [id]
  );
  Assert.ok((await IOUtils.readUTF8(path)).includes("nativeadditionneedle"));
  Assert.ok(
    (await f.service.getText(id)).body.includes("nativeadditionneedle")
  );
  f.conversation.updateMessage("sender", "replacementadditionneedle", {
    incoming: true,
    remoteId: "same-id",
    time: f.conversation.startDate / 1000000 + 2,
  });
  await f.service.flush();
  Assert.equal(
    (await f.service.search("nativeadditionneedle")).items.length,
    0
  );
  Assert.deepEqual(
    (await f.service.search("replacementadditionneedle")).items.map(
      hit => hit.id
    ),
    [id]
  );
  Assert.deepEqual(f.errors, []);
  Assert.ok(!Cu.isESModuleLoaded("resource:///modules/index_im.sys.mjs"));
});

add_task(async function test_firstMessageSurvivesImmediateWriterClose() {
  const f = await serviceFixture("immediate-close");
  f.conversation.writeMessage("sender", "immediatecloseneedle", {
    incoming: true,
    remoteId: "first-id",
    time: f.conversation.startDate / 1000000 + 1,
  });
  f.writer = getLogWriter(f.conversation);
  const path = f.writer.currentPath;
  Services.obs.notifyObservers(f.conversation, "conversation-closed");
  Assert.equal(await logs.getLogPathsForConversation(f.conversation), null);
  await f.service.flush();
  Assert.deepEqual(
    (await f.service.search("immediatecloseneedle")).items.map(hit => hit.id),
    [chatSearchDocumentId(path)]
  );
  Assert.ok((await IOUtils.readUTF8(path)).includes("immediatecloseneedle"));
  Assert.deepEqual(f.errors, []);
});

add_task(async function test_rotatedAndEqualIdLogsStayDistinct() {
  const f = await serviceFixture("rotated");
  const control = await serviceFixture("control");
  await writeServiceMessage(f, "same-id", "firstrotationneedle");
  await writeServiceMessage(
    control,
    "same-id",
    "firstrotationneedle controlrotationneedle"
  );
  f.writer.startNewFile(f.conversation.startDate / 1000 + 1000, true);
  await writeServiceMessage(f, "second-id", "secondrotationneedle");
  const ids = f.writer.paths.map(chatSearchDocumentId);
  Assert.equal(ids.length, 2);
  Assert.notEqual(ids[0], ids[1]);
  Assert.deepEqual(
    (await f.service.search("firstrotationneedle")).items
      .map(hit => hit.id)
      .sort(),
    [ids[0], chatSearchDocumentId(control.writer.currentPath)].sort()
  );
  Assert.deepEqual(
    (await f.service.search("secondrotationneedle")).items.map(hit => hit.id),
    [ids[1]]
  );
  Assert.equal((await f.service.getText(ids[0])).id, ids[0]);
  Assert.equal((await f.service.getText(ids[1])).id, ids[1]);
  Assert.deepEqual(f.errors, []);
});

add_task(async function test_observedPrivacyNeverIndexesNotificationPayload() {
  const f = await serviceFixture("privacy");
  await writeServiceMessage(f, "private-id", "serviceprivateneedle");
  await writeServiceMessage(f, "kept-id", "servicekeptneedle");
  f.conversation.updateMessage("sender", "neverpersistservicepayload", {
    incoming: true,
    noLog: true,
    remoteId: "private-id",
    time: f.conversation.startDate / 1000000 + 2,
  });
  await f.service.flush();
  Assert.equal(
    (await f.service.search("serviceprivateneedle")).items.length,
    0
  );
  Assert.equal(
    (await f.service.search("neverpersistservicepayload")).items.length,
    0
  );
  Assert.equal((await f.service.search("servicekeptneedle")).items.length, 1);
  const bytes = await IOUtils.readUTF8(f.writer.currentPath);
  Assert.ok(!bytes.includes("serviceprivateneedle"));
  Assert.ok(!bytes.includes("neverpersistservicepayload"));
  Assert.ok(bytes.includes("servicekeptneedle"));
  Assert.deepEqual(f.errors, []);
});

add_task(async function test_policyAndDisabledLoggingKeepSourceEligibility() {
  const f = await serviceFixture("policy");
  Services.prefs.setBoolPref("mailnews.database.global.indexer.enabled", false);
  try {
    await writeServiceMessage(f, "disabled-id", "servicepolicyneedle");
    Assert.ok(
      (await IOUtils.readUTF8(f.writer.currentPath)).includes(
        "servicepolicyneedle"
      )
    );
    Assert.equal(
      (await f.service.search("servicepolicyneedle")).items.length,
      0
    );
  } finally {
    Services.prefs.setBoolPref(
      "mailnews.database.global.indexer.enabled",
      true
    );
  }
  await f.service.flush();
  Assert.deepEqual(
    (await f.service.search("servicepolicyneedle")).items.map(hit => hit.id),
    [chatSearchDocumentId(f.writer.currentPath)]
  );
  Services.prefs.setBoolPref("purple.logging.log_ims", false);
  try {
    const disabled = await serviceFixture("logging-disabled");
    await writeServiceMessage(disabled, "same-id", "unloggedserviceneedle");
    Assert.equal(
      await logs.getLogPathsForConversation(disabled.conversation),
      null
    );
    Assert.equal(
      (await disabled.service.search("unloggedserviceneedle")).items.length,
      0
    );
    Assert.deepEqual(disabled.errors, []);
  } finally {
    Services.prefs.setBoolPref("purple.logging.log_ims", true);
  }
});

add_task(async function test_closeDrainsActualLoggerWorkAndRestartResumes() {
  const f = await serviceFixture("restart");
  await writeServiceMessage(f, "first-id", "beforerestartneedle");
  const path = f.writer.currentPath;
  const id = chatSearchDocumentId(path);
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const held = queueFileOperation(path, async () => {
    entered.resolve();
    await gate.promise;
  });
  registerCleanupFunction(() => gate.resolve());
  await entered.promise;
  f.conversation.writeMessage("sender", "queuedrestartneedle", {
    incoming: true,
    remoteId: "queued-id",
    time: f.conversation.startDate / 1000000 + 2,
  });
  const closing = f.service.close();
  Assert.equal(closing, f.service.close());
  let closed = false;
  closing.then(() => {
    closed = true;
  });
  Assert.equal(
    closed,
    false,
    "The actual held logger operation prevents close"
  );
  gate.resolve();
  await held;
  await closing;
  // The service is detached: this actual append is picked up by the next startup sweep.
  f.conversation.writeMessage("sender", "missedrestartneedle", {
    incoming: true,
    remoteId: "missed-id",
    time: f.conversation.startDate / 1000000 + 3,
  });
  await f.writer._initialized;
  await gFilePromises.get(path);
  f.service = await ChatSearchService.open(f.file, {
    onError: error => f.errors.push(error),
  });
  Assert.deepEqual(
    (await f.service.search("queuedrestartneedle")).items.map(hit => hit.id),
    [id]
  );
  Assert.deepEqual(
    (await f.service.search("missedrestartneedle")).items.map(hit => hit.id),
    [id]
  );
  Assert.ok((await f.service.getText(id)).body.includes("beforerestartneedle"));
  Assert.ok((await f.service.getText(id)).body.includes("missedrestartneedle"));
  Assert.deepEqual(f.errors, []);
  Assert.ok(!Cu.isESModuleLoaded("resource:///modules/index_im.sys.mjs"));
});

add_task(async function test_failedStartupPreservesSourceAndClosesTheWriter() {
  const f = await serviceFixture("failure");
  await writeServiceMessage(f, "first-id", "preservedserviceneedle");
  await f.service.close();
  const path = f.writer.currentPath;
  const bytes = (await IOUtils.readUTF8(path)) + "{invalid-tail\n";
  await IOUtils.writeUTF8(path, bytes);
  const errors = [];
  await Assert.rejects(
    ChatSearchService.open(f.file, { onError: error => errors.push(error) }),
    error => error === errors[0] && error.name === "SyntaxError"
  );
  Assert.equal(errors.length, 1);
  Assert.equal(
    await IOUtils.readUTF8(path),
    bytes,
    "Failed destination work never deletes source"
  );
  const provider = await ChatSearchProvider.open(f.file);
  try {
    Assert.equal(
      await provider.getText(chatSearchDocumentId(path)),
      null,
      "Changed source hides the old text"
    );
  } finally {
    await provider.close();
  }
  // Keep this malformed source isolated from later startup sweeps.
  await IOUtils.remove(path);
});
