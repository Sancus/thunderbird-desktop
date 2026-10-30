/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
const { readLegacyGlodaChat, readLegacyChatLog, bindLegacyChatLogs } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/LegacyGlodaChatReader.sys.mjs"
  );
let conversationId = 100;

add_setup(function () {
  do_get_profile();
  for (const [name, value] of [
    ["purple.logging.log_ims", true],
    ["chat.logging.cleanup", false],
  ]) {
    const previous = Services.prefs.prefHasUserValue(name)
      ? Services.prefs.getBoolPref(name)
      : null;
    Services.prefs.setBoolPref(name, value);
    registerCleanupFunction(() => {
      if (previous === null) {
        Services.prefs.clearUserPref(name);
      } else {
        Services.prefs.setBoolPref(name, previous);
      }
    });
  }
});

/**
 * Writes real JSON logs through the retained product logger, then closes its
 * writer and returns the actual original path. No Mork/Gloda producer is loaded.
 *
 * @param {string} name - Unique test conversation name.
 * @param {object[]} messages - Native logger inputs with existing flag semantics.
 * @returns {Promise<object>} Source path, root, conversation and logger exports.
 */
async function createLogInput(name, messages) {
  const logger = ChromeUtils.importESModule(
    "resource:///modules/logger.sys.mjs"
  );
  const conversation = {
    id: ++conversationId,
    title: "dummy conv",
    name: "dummyconv-" + name,
    normalizedName: "dummyconv-" + name,
    isChat: false,
    startDate: new Date(2011, 5, 28).valueOf() * 1000,
    account: {
      id: "migration-test",
      normalizedName: "dummyaccount",
      protocol: { normalizedName: "dummy", id: "prpl-dummy" },
    },
  };
  const writer = logger.getLogWriter(conversation);
  registerCleanupFunction(() => logger.closeLogWriter(conversation));
  try {
    Assert.equal(
      writer.paths.length,
      1,
      "Real logger selected, not its disabled dummy writer"
    );
    const path = writer.currentPath;
    await writer._initialized;
    for (const [index, message] of messages.entries()) {
      await writer.logMessage({
        time: conversation.startDate / 1000000 + index + 1,
        who: "personA",
        incoming: true,
        ...message,
      });
    }
    Assert.ok(await IOUtils.exists(path));
    const relativePath = PathUtils.split(path).slice(-4).join("/");
    return {
      path,
      relativePath,
      root: PathUtils.join(do_get_profile().path, "logs"),
      conversation,
      logger,
    };
  } finally {
    logger.closeLogWriter(conversation);
  }
}

/**
 * Builds schema-layout unit input from pinned index_im/GlodaDatastore DDL.
 * This is not a legacy-produced Gloda fixture or a database parity claim.
 *
 * @param {string} name - Unique database name.
 * @param {string} relativePath - Actual original native log path.
 * @param {string} [changes=""] - Deliberate invalid-source mutation.
 * @returns {string} Closed schema30 rollback-journal database path.
 */
function createIndexInput(name, relativePath, changes = "") {
  const file = do_get_profile().clone();
  file.append("legacy-chat-" + name + ".sqlite");
  Assert.ok(!file.exists());
  const connection = Services.storage.openDatabase(file);
  try {
    Cc["@mozilla.org/messenger/fts3tokenizer;1"]
      .getService(Ci.nsIFts3Tokenizer)
      .registerTokenizer(connection);
    connection.executeSimpleSQL(`
      PRAGMA journal_mode=DELETE;
      PRAGMA user_version=30;
      CREATE TABLE imConversations(id INTEGER PRIMARY KEY, title STRING, time NUMBER, path STRING, jsonAttributes STRING);
      CREATE VIRTUAL TABLE imConversationsText USING fts3(tokenize mozporter, content STRING);
    `);
    const statement = connection.createStatement(
      "INSERT INTO imConversations(title,time,path,jsonAttributes) VALUES('dummy conv',123,:path,:json)"
    );
    try {
      statement.params.path = relativePath;
      statement.params.json = '{"unknown":"","9001":null}';
      statement.execute();
    } finally {
      statement.finalize();
    }
    const text = connection.createStatement(
      "INSERT INTO imConversationsText(docid,content) VALUES(1,char(65279)||:text)"
    );
    try {
      text.params.text = "old aggregate é\0exact";
      text.execute();
    } finally {
      text.finalize();
    }
    if (changes) {
      connection.executeSimpleSQL(changes);
    }
  } finally {
    connection.close();
  }
  return file.path;
}

add_task(
  async function test_readsAggregateAndLogTextWithoutPromotingEligibility() {
    const input = await createLogInput("source", [
      { displayMessage: "<b>é</b>\n\0exact", remoteId: "identifier" },
    ]);
    const path = createIndexInput("source", input.relativePath);
    const beforeDB = await IOUtils.read(path);
    const beforeLog = await IOUtils.read(input.path);
    const snapshot = await readLegacyGlodaChat(path);
    const log = await readLegacyChatLog(input.root, input.relativePath);
    for (const [actual, expected] of [
      [snapshot.source.path, path],
      [log.source.path, input.path],
    ]) {
      const normalized = new FileUtils.File(expected);
      normalized.normalize();
      Assert.equal(actual, normalized.path);
    }
    Assert.equal(snapshot.records[0].text, "\uFEFFold aggregate é\0exact");
    Assert.equal(
      snapshot.records[0].jsonAttributes,
      '{"unknown":"","9001":null}'
    );
    Assert.equal(log.records[0].raw.text, "<b>é</b>\n\0exact");
    Assert.equal(log.records[0].raw.remoteId, "identifier");
    Assert.equal(
      log.records[0].line,
      2,
      "Physical source line is not a generated message ID"
    );
    Assert.equal(log.records[0].disposition, "quarantined");
    Assert.equal(snapshot.records[0].disposition, "quarantined");
    Assert.equal(
      log.source.sha256,
      await IOUtils.computeHexDigest(input.path, "sha256")
    );
    const bound = bindLegacyChatLogs(snapshot, [log]).records[0];
    Assert.equal(bound.provenance.rowId, 1);
    Assert.equal(bound.provenance.relativePath, input.relativePath);
    Assert.equal(bound.provenance.source.sha256, snapshot.source.sha256);
    Assert.equal(bound.provenance.logSource.sha256, log.source.sha256);
    Assert.ok(bound.originalLogRead);
    Assert.ok(
      !bound.canOpen,
      "Backup evidence is not a current chat open target"
    );
    Assert.equal(bound.disposition, "quarantined");
    Assert.deepEqual(await IOUtils.read(path), beforeDB);
    Assert.deepEqual(await IOUtils.read(input.path), beforeLog);
  }
);

add_task(async function test_keepsKnownEditsAndDeletionsOutOfCandidates() {
  const input = await createLogInput("edits", [
    { displayMessage: "old edit", remoteId: "identifier" },
    { displayMessage: "new edit", remoteId: "identifier" },
    { displayMessage: "old deleted text", remoteId: "otherID" },
    { displayMessage: "Deleted", remoteId: "otherID", deleted: true },
    { displayMessage: "later unverified replacement", remoteId: "otherID" },
  ]);
  const before = await IOUtils.read(input.path);
  const log = await readLegacyChatLog(input.root, input.relativePath);
  Assert.deepEqual(
    log.records.map(row => row.reason),
    [
      "superseded",
      "current-policy-and-history-unverified",
      "deleted",
      "deleted",
      "deleted",
    ]
  );
  Assert.deepEqual(
    log.records.map(row => row.disposition),
    ["excluded", "quarantined", "excluded", "excluded", "excluded"]
  );
  Assert.equal(
    log.records[0].raw.text,
    "old edit",
    "Original source is retained separately from any search projection"
  );
  Assert.deepEqual(await IOUtils.read(input.path), before);
});

add_task(async function test_loggerNoLogAdmissionDoesNotBecomeRecoveryText() {
  const input = await createLogInput("nolog", [{ displayMessage: "visible" }]);
  const before = await IOUtils.read(input.path);
  input.logger.logs.observe(
    {
      conversation: input.conversation,
      noLog: true,
      time: input.conversation.startDate / 1000000 + 2,
      who: "personB",
      displayMessage: "must not be logged",
    },
    "new-text"
  );
  await input.logger.logs.getLogPathsForConversation(input.conversation);
  await input.logger.gFilePromises.get(input.path);
  input.logger.closeLogWriter(input.conversation);
  Assert.deepEqual(await IOUtils.read(input.path), before);
  const log = await readLegacyChatLog(input.root, input.relativePath);
  Assert.equal(log.records.length, 1);
  Assert.equal(log.records[0].raw.text, "visible");
  Assert.equal(
    log.records[0].disposition,
    "quarantined",
    "Absence of noLog text does not prove current policy"
  );
});

add_task(async function test_keepsMissingLogsExplicit() {
  const input = await createLogInput("binding", [{ displayMessage: "text" }]);
  const snapshot = await readLegacyGlodaChat(
    createIndexInput("binding", input.relativePath)
  );
  const result = bindLegacyChatLogs(snapshot, []);
  Assert.equal(result.records[0].log, null);
  Assert.equal(result.records[0].provenance.logSource, null);
  Assert.ok(!result.records[0].originalLogRead);
  Assert.ok(!result.records[0].canOpen);
});

add_task(async function test_rejectsAmbiguousLogBindings() {
  const input = await createLogInput("duplicate-binding", [
    { displayMessage: "text" },
  ]);
  const snapshot = await readLegacyGlodaChat(
    createIndexInput("duplicate-binding", input.relativePath)
  );
  const log = await readLegacyChatLog(input.root, input.relativePath);
  Assert.throws(() => bindLegacyChatLogs(snapshot, [log, log]), /Ambiguous/);
});

add_task(async function test_rejectsMalformedLogLine() {
  const input = await createLogInput("malformed", [{ displayMessage: "text" }]);
  await IOUtils.writeUTF8(input.path, "not JSON\n", { mode: "append" });
  await Assert.rejects(
    readLegacyChatLog(input.root, input.relativePath),
    /Malformed.*line 3/
  );
});

add_task(async function test_rejectsTruncatedLog() {
  const input = await createLogInput("truncated", [{ displayMessage: "text" }]);
  const bytes = await IOUtils.read(input.path);
  await IOUtils.write(input.path, bytes.subarray(0, bytes.length - 1));
  await Assert.rejects(
    readLegacyChatLog(input.root, input.relativePath),
    /Truncated/
  );
});

add_task(async function test_rejectsUnknownIndexVersion() {
  const input = await createLogInput("version", []);
  const path = createIndexInput(
    "version",
    input.relativePath,
    "PRAGMA user_version=31;"
  );
  await Assert.rejects(readLegacyGlodaChat(path), /schema version/);
});

add_task(async function test_rejectsAmbiguousIndexPaths() {
  const input = await createLogInput("duplicate", []);
  const path = createIndexInput(
    "duplicate",
    input.relativePath,
    "INSERT INTO imConversations SELECT 2,title,time,path,jsonAttributes FROM imConversations; INSERT INTO imConversationsText(docid,content) VALUES(2,'another text');"
  );
  await Assert.rejects(readLegacyGlodaChat(path), /Ambiguous.*path/);
});

add_task(async function test_rejectsUnsupportedIndexColumns() {
  const input = await createLogInput("columns", []);
  const path = createIndexInput(
    "columns",
    input.relativePath,
    "ALTER TABLE imConversations ADD COLUMN unknownValue STRING;"
  );
  await Assert.rejects(readLegacyGlodaChat(path), /columns/);
});

add_task(async function test_rejectsMissingIndexContent() {
  const input = await createLogInput("missing", []);
  const path = createIndexInput(
    "missing",
    input.relativePath,
    "DELETE FROM imConversationsText;"
  );
  await Assert.rejects(readLegacyGlodaChat(path), /Missing/);
});

add_task(async function test_rejectsSourceSidecars() {
  const input = await createLogInput("sidecar", []);
  const path = createIndexInput("sidecar", input.relativePath);
  await IOUtils.writeUTF8(path + "-wal", "unreplayed input");
  await Assert.rejects(readLegacyGlodaChat(path), /sidecar/);
  Assert.equal(await IOUtils.readUTF8(path + "-wal"), "unreplayed input");
});

add_task(async function test_rejectsTraversalAndUnknownLogFormat() {
  const input = await createLogInput("path", []);
  await Assert.rejects(
    readLegacyChatLog(input.root, "dummy/../conv/file.json"),
    /log path/
  );
  await Assert.rejects(
    readLegacyChatLog(
      input.root,
      input.relativePath.replace(/\.json$/, ".txt")
    ),
    /log path/
  );
});

add_task(async function test_encryptedLogDoesNotEstablishEligibility() {
  const input = await createLogInput("encrypted", [
    {
      displayMessage: "Encrypted msg",
      remoteId: "identifier",
      isEncrypted: true,
    },
  ]);
  const log = await readLegacyChatLog(input.root, input.relativePath);
  Assert.ok(log.records[0].raw.flags.includes("isEncrypted"));
  Assert.equal(log.records[0].disposition, "quarantined");
  Assert.equal(log.records[0].reason, "current-policy-and-history-unverified");
});

add_task(async function test_rejectsAmbiguousLegacyStringCoercion() {
  const input = await createLogInput("numeric-title", []);
  // Legacy STRING columns have NUMERIC affinity; original spelling is lost.
  const path = createIndexInput(
    "numeric-title",
    input.relativePath,
    "UPDATE imConversations SET title='001';"
  );
  await Assert.rejects(readLegacyGlodaChat(path), /text value/);
});
