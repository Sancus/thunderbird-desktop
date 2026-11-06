/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";
do_get_profile();

const { ChatSearchService } = ChromeUtils.importESModule(
  "resource:///modules/panorama/ChatSearchService.sys.mjs"
);
const { chatSearchDocumentId } = ChromeUtils.importESModule(
  "resource:///modules/panorama/ChatSearchProvider.sys.mjs"
);
const { PanoramaSearchIndex } = ChromeUtils.importESModule(
  "resource:///modules/panorama/PanoramaSearchIndex.sys.mjs"
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
  logs.init();
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
  const fixture = {
    conversation,
    ui,
    file,
    service,
    errors,
    writer: null,
    expectedFailure: null,
  };
  registerCleanupFunction(async () => {
    if (fixture.expectedFailure) {
      await Assert.rejects(
        fixture.service.close(),
        error => error === fixture.expectedFailure
      );
    } else {
      await fixture.service.close();
    }
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

add_task(async function test_archiveStartupDoesNotUseLiveLogger() {
  const folder = PathUtils.join(
    PathUtils.profileDir,
    "logs",
    "search-test",
    "s508-service-archive",
    "buddy"
  );
  const path = PathUtils.join(folder, "2022-03-04.120000+0000.json");
  const file = do_get_profile().clone();
  file.append("s508-service-archive.sqlite");
  await IOUtils.makeDirectory(folder, { createAncestors: true });
  const header = {
    date: "2022-03-04T12:00:00.000Z",
    name: "buddy",
    title: "Stopped archive",
    account: "s508-service-archive",
    normalizedName: "buddy",
    protocol: "search-test",
    isChat: false,
  };
  const record = {
    date: "2022-03-04T12:00:01.000Z",
    who: "sender",
    text: "archivestartupneedle",
    flags: ["incoming"],
    remoteId: "retained-first",
  };
  await IOUtils.writeUTF8(
    path,
    JSON.stringify(header) + "\n" + JSON.stringify(record) + "\n"
  );
  let owned;
  registerCleanupFunction(async () => {
    await owned?.close();
    await IOUtils.remove(folder, { recursive: true, ignoreAbsent: true });
  });
  const original = logs.forEach;
  logs.forEach = () => {
    throw new Error("Stopped archive must not activate the live logger");
  };
  try {
    owned = await ChatSearchService.open(file);

    const page = await owned.search("archivestartupneedle");
    Assert.equal(
      page.items.length,
      1,
      "The actual stopped physical transcript is searchable"
    );
    Assert.equal(
      page.items[0].id,
      chatSearchDocumentId(path),
      "The hit retains the physical path identity"
    );
    const text = await owned.getText(page.items[0].id);
    Assert.ok(
      text.body.includes("archivestartupneedle"),
      "The source text survives the archive queue/parser and index"
    );
  } finally {
    logs.forEach = original;
    await owned?.close();
  }
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
  await f.service.close();
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
  await f.service.close();
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
  await Promise.all([f.service.close(), control.service.close()]);
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
  await f.service.close();
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
    await disabled.service.close();
  } finally {
    Services.prefs.setBoolPref("purple.logging.log_ims", true);
  }
  await f.service.close();
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
  await f.service.close();
});

add_task(async function test_indexFailureIsNotARejectedSourceFile() {
  const f = await serviceFixture("storage-failure");
  await writeServiceMessage(f, "first-id", "beforestoragefailureneedle");
  const path = f.writer.currentPath;
  const id = chatSearchDocumentId(path);
  const failure = new Error("Controlled original index write failure");
  const index = PanoramaSearchIndex.prototype.index;
  PanoramaSearchIndex.prototype.index = function (document, ...args) {
    return document.id === id
      ? Promise.reject(failure)
      : index.call(this, document, ...args);
  };
  f.expectedFailure = failure;
  try {
    await Assert.rejects(
      writeServiceMessage(f, "second-id", "retainedstoragesourceneedle"),
      error => error === failure
    );
    await Assert.rejects(
      f.service.search("beforestoragefailureneedle"),
      error => error === failure
    );
    await Assert.rejects(f.service.getText(id), error => error === failure);
    Assert.deepEqual(f.errors, [failure]);
    Assert.strictEqual(
      f.service.migrationFailures[0],
      failure,
      "The owned service retains its first asynchronous storage failure"
    );
    Assert.ok(
      (await IOUtils.readUTF8(path)).includes("retainedstoragesourceneedle")
    );
    const closing = f.service.close();
    Assert.equal(closing, f.service.close());
    await Assert.rejects(closing, error => error === failure);
  } finally {
    PanoramaSearchIndex.prototype.index = index;
  }
});

add_task(async function test_malformedLogsDoNotBlockHealthySourceOrStartup() {
  const f = await serviceFixture("malformed");
  const rejected = [];
  for (let i = 0; i < 4; i++) {
    await writeServiceMessage(f, "bad-" + i, "malformedhistoricalneedle" + i);
    rejected.push(f.writer.currentPath);
    f.writer.startNewFile(
      f.conversation.startDate / 1000 + 1000 * (i + 1),
      true
    );
  }
  await writeServiceMessage(f, "healthy-id", "healthyhistoricalneedle");
  const healthyPath = f.writer.currentPath;
  await f.service.close();
  await IOUtils.writeUTF8(
    rejected[0],
    (await IOUtils.readUTF8(rejected[0])) + "{invalid-tail\n"
  );
  await IOUtils.writeUTF8(rejected[1], "");
  await IOUtils.write(rejected[2], new Uint8Array([255, 254, 255]));
  const lines = (await IOUtils.readUTF8(rejected[3])).split("\n");
  const header = JSON.parse(lines[0]);
  delete header.normalizedName;
  lines[0] = JSON.stringify(header);
  await IOUtils.writeUTF8(rejected[3], lines.join("\n"));
  const source = new Map();
  for (const path of rejected) {
    source.set(path, Array.from(await IOUtils.read(path)));
  }
  const errors = [];
  f.service = await ChatSearchService.open(f.file, {
    onError: error => errors.push(error),
  });
  Assert.deepEqual(errors.map(error => error.name).sort(), [
    "Error",
    "SyntaxError",
    "SyntaxError",
    "TypeError",
  ]);
  Assert.deepEqual(
    (await f.service.search("healthyhistoricalneedle")).items.map(
      hit => hit.id
    ),
    [chatSearchDocumentId(healthyPath)]
  );
  for (const path of rejected) {
    Assert.equal(await f.service.getText(chatSearchDocumentId(path)), null);
    Assert.deepEqual(
      Array.from(await IOUtils.read(path)),
      source.get(path),
      "Rejected source remains byte-exact"
    );
  }
  await writeServiceMessage(f, "later-id", "healthyliveadditionneedle");
  Assert.deepEqual(
    (await f.service.search("healthyliveadditionneedle")).items.map(
      hit => hit.id
    ),
    [chatSearchDocumentId(healthyPath)]
  );
  Assert.equal(
    (await f.service.search("malformedhistoricalneedle0")).items.length,
    0
  );
  Assert.equal(
    errors.length,
    8,
    "Each actual historical rejection is reported, not a sticky global hold"
  );
  for (const path of rejected) {
    Assert.deepEqual(Array.from(await IOUtils.read(path)), source.get(path));
  }
  await f.service.close();
});
