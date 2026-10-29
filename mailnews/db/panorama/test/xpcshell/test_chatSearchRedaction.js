/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";
do_get_profile();

const { persistChatSearchRedaction } = ChromeUtils.importESModule(
  "resource:///modules/panorama/ChatSearchRedaction.sys.mjs"
);
const { ChatSearchProvider, chatSearchDocumentId } = ChromeUtils.importESModule(
  "resource:///modules/panorama/ChatSearchProvider.sys.mjs"
);
const {
  logs,
  getLogWriter,
  closeLogWriter,
  queueFileOperation,
  gFilePromises,
} = ChromeUtils.importESModule("resource:///modules/logger.sys.mjs");

/**
 * Opens a real logger writer with unique account/conversation identity.
 *
 * @param {string} name - Unique test account suffix.
 * @returns {Promise<{conversation: object, writer: object}>} Owned logger resources.
 */
async function openRedactionLog(name) {
  const conversation = {
    id: "redaction-" + name,
    account: {
      normalizedName: "redaction-" + name,
      protocol: { normalizedName: "search-test" },
    },
    normalizedName: "buddy",
    name: "buddy",
    title: "Chat redaction fixture",
    isChat: false,
    startDate: new Date("2022-03-04T12:00:00Z").valueOf() * 1000,
  };
  const writer = getLogWriter(conversation);
  await writer._initialized;
  registerCleanupFunction(async () => {
    closeLogWriter(conversation);
    for (const file of writer.paths) {
      await gFilePromises.get(file);
      await IOUtils.remove(file, { ignoreAbsent: true });
    }
  });
  return { conversation, writer };
}

/**
 * Appends one normal message through the exported logger writer.
 *
 * @param {object} fixture - Logger fixture.
 * @param {string} remoteId - Existing protocol message identity.
 * @param {string} text - Logged display text.
 * @returns {Promise<void>} Resolves after the logger append.
 */
async function appendRedactionText(fixture, remoteId, text) {
  await fixture.writer.logMessage({
    time: fixture.conversation.startDate / 1000000 + 1,
    who: "original-sender",
    remoteId,
    displayMessage: text,
    incoming: true,
  });
}

add_setup(function setupChatRedactionPreferences() {
  const names = [
    "purple.logging.log_ims",
    "chat.logging.cleanup",
    "mailnews.database.global.indexer.enabled",
  ];
  const previous = names.map(name => [
    name,
    Services.prefs.prefHasUserValue(name),
    Services.prefs.getBoolPref(name, false),
  ]);
  Services.prefs.setBoolPref(names[0], true);
  Services.prefs.setBoolPref(names[1], false);
  Services.prefs.setBoolPref(names[2], true);
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

add_task(async function test_noLogRedactsAllRecordedVersionsAcrossFiles() {
  const fixture = await openRedactionLog("rotated");
  await appendRedactionText(fixture, "private-id", "privacyfirstneedle");
  await appendRedactionText(fixture, "keep-id", "unrelatedneedle");
  fixture.writer.startNewFile(
    fixture.conversation.startDate / 1000 + 1000,
    true
  );
  await fixture.writer._initialized;
  await appendRedactionText(fixture, "private-id", "privacysecondneedle");
  const paths = [...fixture.writer.paths];
  const file = do_get_profile().clone();
  file.append("chat-redaction.sqlite");
  const provider = await ChatSearchProvider.open(file);
  try {
    for (const path of paths) {
      Assert.ok((await provider.refreshLog(path)).indexed);
    }
    const event = {
      conversation: fixture.conversation,
      noLog: true,
      remoteId: "private-id",
      time: 1,
      who: "never-record-this-sender",
      displayMessage: "neverloggedneedle",
    };
    logs.observe(event, "new-text");
    Assert.deepEqual(await persistChatSearchRedaction(event), paths);
    const beforeReopen = [];
    for (const path of paths) {
      const raw = await IOUtils.readUTF8(path);
      Assert.ok(
        !raw.includes("privacyfirstneedle") &&
          !raw.includes("privacysecondneedle")
      );
      Assert.ok(
        !raw.includes("neverloggedneedle") &&
          !raw.includes("never-record-this-sender")
      );
      const records = raw
        .trimEnd()
        .split("\n")
        .slice(1)
        .map(line => JSON.parse(line));
      Assert.ok(
        records
          .filter(record => record.remoteId == "private-id")
          .every(
            record => record.text === "" && record.flags.includes("deleted")
          )
      );
      const id = chatSearchDocumentId(path);
      Assert.equal(
        await provider.getText(id),
        null,
        "Source change hides the old projection before refresh"
      );
      Assert.ok((await provider.refreshLog(path)).indexed);
      beforeReopen.push((await provider.getText(id)).body);
    }
    Assert.deepEqual(beforeReopen, ["original-sender: unrelatedneedle", ""]);
    Assert.deepEqual(
      await persistChatSearchRedaction(event),
      [],
      "Persisted redaction is idempotent"
    );
  } finally {
    await provider.close();
  }
  const reopened = await ChatSearchProvider.open(file);
  try {
    Assert.deepEqual(
      await Promise.all(
        paths.map(
          async path =>
            (await reopened.getText(chatSearchDocumentId(path))).body
        )
      ),
      ["original-sender: unrelatedneedle", ""]
    );
  } finally {
    await reopened.close();
  }
});

add_task(async function test_typeChangeRedactsEachFilesOwnIdentity() {
  const fixture = await openRedactionLog("type%change");
  const unrelated = await openRedactionLog("type-unrelated");
  await appendRedactionText(unrelated, "private-id", "otheraccountneedle");
  const unrelatedBytes = await IOUtils.read(unrelated.writer.currentPath);
  await appendRedactionText(fixture, "private-id", "directfirstneedle");
  await appendRedactionText(fixture, "private-id", "directsecondneedle");
  await appendRedactionText(fixture, "keep-id", "directkeepneedle");
  const directPath = fixture.writer.currentPath;
  fixture.conversation.isChat = true;
  fixture.writer.startNewFile(
    fixture.conversation.startDate / 1000 + 1000,
    true
  );
  await fixture.writer._initialized;
  await appendRedactionText(fixture, "private-id", "groupfirstneedle");
  await appendRedactionText(fixture, "private-id", "groupsecondneedle");
  await appendRedactionText(fixture, "keep-id", "groupkeepneedle");
  const groupPath = fixture.writer.currentPath;
  const paths = [directPath, groupPath];
  Assert.deepEqual(fixture.writer.paths, paths);
  Assert.deepEqual(
    paths.map(path =>
      JSON.parse(chatSearchDocumentId(path).slice(5)).slice(0, 3)
    ),
    [
      ["search-test", "redaction-type%25change", "buddy"],
      ["search-test", "redaction-type%25change", "buddy.chat"],
    ]
  );
  Assert.deepEqual(
    await persistChatSearchRedaction({
      conversation: fixture.conversation,
      remoteId: "private-id",
      noLog: true,
    }),
    paths
  );
  for (const [i, path] of paths.entries()) {
    const records = (await IOUtils.readUTF8(path))
      .trimEnd()
      .split("\n")
      .map(line => JSON.parse(line));
    Assert.equal(records.shift().isChat, i == 1);
    const versions = records.filter(record => record.remoteId == "private-id");
    Assert.equal(versions.length, 2);
    Assert.ok(
      versions.every(
        record => record.text === "" && record.flags.includes("deleted")
      )
    );
    Assert.deepEqual(
      records
        .filter(record => record.remoteId == "keep-id")
        .map(record => record.text),
      [i == 0 ? "directkeepneedle" : "groupkeepneedle"]
    );
    const log = await logs.getLogFromFile(path);
    Assert.deepEqual(
      (await log.getConversation())
        .getMessages()
        .filter(message => !message.noLog)
        .map(message => message.message),
      [i == 0 ? "directkeepneedle" : "groupkeepneedle"]
    );
  }
  Assert.deepEqual(
    await IOUtils.read(unrelated.writer.currentPath),
    unrelatedBytes,
    "The same remote ID in another account is not redacted"
  );
});

add_task(async function test_logHeaderMustMatchItsOwnFilePath() {
  const fixture = await openRedactionLog("path-owner");
  await appendRedactionText(fixture, "private-id", "pathownedneedle");
  const path = fixture.writer.currentPath;
  const original = await IOUtils.readUTF8(path);
  const header = JSON.parse(original.split("\n")[0]);
  const event = {
    conversation: fixture.conversation,
    remoteId: "private-id",
    noLog: true,
  };
  for (const change of [
    { protocol: "unrelated-protocol" },
    { account: "unrelated-account" },
    { normalizedName: "unrelated-room" },
    { isChat: true },
    { isChat: 0 },
  ]) {
    const lines = original.split("\n");
    lines[0] = JSON.stringify({ ...header, ...change });
    const mismatched = lines.join("\n");
    await queueFileOperation(path, () => IOUtils.writeUTF8(path, mismatched));
    await Assert.rejects(
      persistChatSearchRedaction(event),
      /Chat redaction source does not match its log path/
    );
    Assert.equal(await IOUtils.readUTF8(path), mismatched);
  }
  await queueFileOperation(path, () => IOUtils.writeUTF8(path, original));
  Assert.deepEqual(await persistChatSearchRedaction(event), [path]);
});

add_task(async function test_unloggedIdentityAddsNoMetadataOrFiles() {
  const fixture = await openRedactionLog("unlogged");
  await appendRedactionText(fixture, "keep-id", "unchangedneedle");
  const original = await IOUtils.read(fixture.writer.currentPath);
  const event = {
    conversation: fixture.conversation,
    remoteId: "not-in-the-log",
    noLog: true,
  };
  Assert.deepEqual(await persistChatSearchRedaction(event), []);
  Assert.deepEqual(await IOUtils.read(fixture.writer.currentPath), original);
  Assert.deepEqual(
    await persistChatSearchRedaction({ ...event, remoteId: "" }),
    []
  );
  Assert.deepEqual(
    await persistChatSearchRedaction({
      ...event,
      remoteId: "keep-id",
      noLog: false,
    }),
    []
  );
  closeLogWriter(fixture.conversation);
  delete fixture.conversation.account;
  Assert.deepEqual(
    await persistChatSearchRedaction({ ...event, remoteId: "keep-id" }),
    [],
    "A closed writer with its account released has no historical log mapping"
  );
});

add_task(async function test_deletedUpdatePreservesUnrelatedQueuedAppend() {
  const fixture = await openRedactionLog("deleted");
  await appendRedactionText(fixture, "delete-id", "deletedneedle");
  const appended = appendRedactionText(fixture, "keep-id", "queuedneedle");
  const result = await persistChatSearchRedaction({
    conversation: fixture.conversation,
    remoteId: "delete-id",
    deleted: true,
  });
  await appended;
  Assert.deepEqual(result, fixture.writer.paths);
  const raw = await IOUtils.readUTF8(fixture.writer.currentPath);
  Assert.ok(!raw.includes("deletedneedle"));
  Assert.ok(raw.includes("queuedneedle"));
  const log = await logs.getLogFromFile(fixture.writer.currentPath);
  Assert.deepEqual(
    (await log.getConversation())
      .getMessages()
      .filter(message => !message.noLog)
      .map(message => message.message),
    ["queuedneedle"]
  );
});

add_task(async function test_invalidSourceAndCancellationDoNotRewriteLog() {
  const fixture = await openRedactionLog("failure");
  await appendRedactionText(fixture, "private-id", "retainedsource");
  const path = fixture.writer.currentPath;
  const event = {
    conversation: fixture.conversation,
    remoteId: "private-id",
    noLog: true,
  };
  const original = await IOUtils.readUTF8(path);
  const controller = new AbortController();
  const reason = new Error("Cancel before redaction");
  controller.abort(reason);
  await Assert.rejects(
    persistChatSearchRedaction(event, { signal: controller.signal }),
    error => error === reason
  );
  Assert.equal(await IOUtils.readUTF8(path), original);

  const failure = new Error("Original logger queue failure");
  queueFileOperation(path, () => Promise.reject(failure));
  await Assert.rejects(
    persistChatSearchRedaction(event),
    error => error === failure
  );
  Assert.equal(await IOUtils.readUTF8(path), original);

  await queueFileOperation(path, () =>
    IOUtils.writeUTF8(path, "{malformed tail\n", { mode: "append" })
  );
  const malformed = await IOUtils.readUTF8(path);
  await Assert.rejects(
    persistChatSearchRedaction(event),
    error => error.name == "SyntaxError"
  );
  Assert.equal(
    await IOUtils.readUTF8(path),
    malformed,
    "Validation failure keeps the whole source file"
  );
  await queueFileOperation(path, () => IOUtils.writeUTF8(path, original));
  Assert.deepEqual(
    await persistChatSearchRedaction(event),
    [path],
    "Failed work does not poison the logger queue"
  );
});
