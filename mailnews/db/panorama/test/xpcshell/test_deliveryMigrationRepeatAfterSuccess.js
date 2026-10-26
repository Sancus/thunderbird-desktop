/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

const { ProfileCreator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ProfileCreator.sys.mjs"
);

/**
 * Reads committed identities and body locations on a separate connection.
 *
 * @param {number} folderId - The Panorama folder to read.
 * @returns {Array<Array<number|string|null>>} Rows of keys, IDs, tokens,
 *   and sizes.
 */
function readStoredMessages(folderId) {
  const dbFile = do_get_profile();
  dbFile.append("panorama.sqlite");
  const reader = Services.storage.openUnsharedDatabase(dbFile);
  try {
    const statement = reader.createStatement(
      "SELECT m.id, m.messageId, " +
        "(SELECT CAST(value AS TEXT) FROM message_properties " +
        "WHERE id = m.id AND name = 'storeToken') AS token, " +
        "(SELECT value FROM message_properties " +
        "WHERE id = m.id AND name = 'messageSize') AS size " +
        "FROM messages m WHERE m.folderId = :folderId ORDER BY m.messageId"
    );
    try {
      statement.params.folderId = folderId;
      const rows = [];
      while (statement.executeStep()) {
        rows.push([
          statement.row.id,
          statement.row.messageId,
          statement.row.token,
          statement.row.size,
        ]);
      }
      return rows;
    } finally {
      statement.finalize();
    }
  } finally {
    reader.close();
  }
}

add_task(async function test_repeatUnchangedSourceAfterSuccessfulImport() {
  const profile = new ProfileCreator(do_get_profile());
  const server = profile.addLocalServer();
  const files = await server.rootFolder.addMailFolder("repeatAfterSuccess", {
    summary: do_get_file("data/migration.msf"),
    mbox: do_get_file("data/migration"),
  });
  const originalMbox = await IOUtils.read(files.mailFilePath);
  const originalSummary = await IOUtils.read(files.summaryFilePath);
  loadExistingDB();
  MailServices.accounts.accounts;
  const lane = PanoramaDelivery.expectedLane();
  Assert.deepEqual(lane, { backend: "panorama", store: "mbox" });
  const selectedDatabase = PanoramaDelivery.assertBackend(
    lane.backend
  ).QueryInterface(Ci.nsIDatabaseCore);
  Assert.equal(
    selectedDatabase,
    database,
    "The selected message database service is Panorama"
  );
  const rootFolder = MailServices.accounts.localFoldersServer.rootFolder;
  const folder = rootFolder.getChildNamed("repeatAfterSuccess");
  PanoramaDelivery.assertFolder(folder, lane);
  Assert.equal(folder.getTotalMessages(false), 0);

  await database.migrateFolderDatabase(folder);
  Assert.ok(!database.connectionForTests.transactionInProgress);
  const first = readStoredMessages(folder.id);
  Assert.deepEqual(
    first.map(([, ...fields]) => fields),
    [
      ["162378@invalid", "0", 0x242],
      ["345692@invalid", "1143", 0x177],
    ],
    "The first migration commits exactly the live messages and body locations"
  );
  // The unchanged source must resolve again without changing imported data.
  await database.migrateFolderDatabase(folder);
  Assert.ok(!database.connectionForTests.transactionInProgress);
  Assert.deepEqual(
    readStoredMessages(folder.id),
    first,
    "Repeating migration preserves committed keys without duplicate rows"
  );
  Assert.deepEqual(
    Array.from(folder.messages, message => [
      message.messageKey,
      message.messageId,
      message.storeToken,
      message.messageSize,
    ]).toSorted((a, b) => a[1].localeCompare(b[1])),
    first,
    "Folder enumeration agrees with stored data after repeat-after-success"
  );
  Assert.deepEqual(
    await IOUtils.read(files.mailFilePath),
    originalMbox,
    "Both migration calls preserve the original mbox bytes"
  );
  Assert.deepEqual(
    await IOUtils.read(files.summaryFilePath),
    originalSummary,
    "Migration leaves its source summary unchanged"
  );

  const changedSummary = new Uint8Array(originalSummary.length + 1);
  changedSummary.set(originalSummary);
  changedSummary[originalSummary.length] = 10;
  await IOUtils.write(files.summaryFilePath, changedSummary);
  try {
    await Assert.rejects(
      Promise.resolve().then(() => database.migrateFolderDatabase(folder)),
      error => error.result === Cr.NS_ERROR_ALREADY_INITIALIZED,
      "A different summary cannot silently reuse the completed import"
    );
    Assert.deepEqual(readStoredMessages(folder.id), first);
    Assert.ok(!database.connectionForTests.transactionInProgress);
  } finally {
    await IOUtils.write(files.summaryFilePath, originalSummary);
  }
  await database.migrateFolderDatabase(folder);
  Assert.ok(!database.connectionForTests.transactionInProgress);
  Assert.deepEqual(
    readStoredMessages(folder.id),
    first,
    "The original source remains repeatable after a rejected changed source"
  );
});

/**
 * Read committed destination and orphan rows independently.
 *
 * @param {number} folderId - The destination folder.
 * @returns {object} Messages, properties, References, and completion receipt.
 */
function readReceiptMigrationState(folderId) {
  const dbFile = do_get_profile().clone();
  dbFile.append("panorama.sqlite");
  const reader = Services.storage.openUnsharedDatabase(dbFile);
  const read = (sql, columns) => {
    const statement = reader.createStatement(sql);
    try {
      statement.params.folderId = folderId;
      const rows = [];
      while (statement.executeStep()) {
        rows.push(columns.map(column => statement.row[column]));
      }
      return rows;
    } finally {
      statement.finalize();
    }
  };
  try {
    return {
      messages: read(
        "SELECT * FROM messages WHERE folderId = :folderId ORDER BY messageId",
        [
          "id",
          "folderId",
          "threadId",
          "threadParent",
          "messageId",
          "date",
          "sender",
          "recipients",
          "ccList",
          "bccList",
          "subject",
          "flags",
          "tags",
          "priority",
        ]
      ),
      // Include orphans so deleting only messages cannot hide partial work.
      properties: read(
        "SELECT p.id, p.name, CAST(p.value AS TEXT) AS value " +
          "FROM message_properties p LEFT JOIN messages m ON m.id = p.id " +
          "WHERE m.folderId = :folderId OR m.id IS NULL " +
          "ORDER BY m.messageId, p.name",
        ["id", "name", "value"]
      ),
      referenceSets: read(
        "SELECT r.id FROM message_reference_sets r " +
          "LEFT JOIN messages m ON m.id = r.id " +
          "WHERE m.folderId = :folderId OR m.id IS NULL ORDER BY m.messageId",
        ["id"]
      ),
      references: read(
        "SELECT r.id, r.ordinal, r.token FROM message_references r " +
          "LEFT JOIN messages m ON m.id = r.id " +
          "WHERE m.folderId = :folderId OR m.id IS NULL " +
          "ORDER BY m.messageId, r.ordinal",
        ["id", "ordinal", "token"]
      ),
      receipt: read(
        "SELECT name, typeof(value) AS type, CAST(value AS TEXT) AS value " +
          "FROM folder_properties WHERE id = :folderId " +
          "AND name = 'morkMigrationSource'",
        ["name", "type", "value"]
      ),
    };
  } finally {
    reader.close();
  }
}

add_task(async function test_receiptWriteFailureRollsBackAndRetries() {
  loadExistingDB();
  const lane = PanoramaDelivery.expectedLane();
  Assert.deepEqual(lane, { backend: "panorama", store: "mbox" });
  Assert.equal(
    PanoramaDelivery.assertBackend(lane.backend).QueryInterface(
      Ci.nsIDatabaseCore
    ),
    database
  );
  const rootFolder =
    MailServices.accounts.localFoldersServer.rootFolder.QueryInterface(
      Ci.nsIMsgLocalMailFolder
    );
  const folder = rootFolder
    .createLocalSubfolder("receiptFailure")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const summaryFile = folder.summaryFile;
  await IOUtils.copy(do_get_file("data/migration.msf").path, summaryFile.path);
  await IOUtils.copy(do_get_file("data/migration").path, folder.filePath.path);

  const legacy = Cc["@mozilla.org/nsMsgDatabase/msgDB-mailbox"].createInstance(
    Ci.nsIMsgDatabase
  );
  registerCleanupFunction(() => legacy.close(false));
  legacy.openFromFile(summaryFile);
  legacy
    .getMsgHdrForMessageID("345692@invalid")
    .setReferences("<receipt-ancestor@invalid> <receipt-parent@invalid>");
  legacy.forceClosed();
  const reader = Cc["@mozilla.org/nsMsgDatabase/msgDB-mailbox"].createInstance(
    Ci.nsIMsgDatabase
  );
  registerCleanupFunction(() => reader.close(false));
  reader.openFromFile(summaryFile);
  const sourceHeader = reader.getMsgHdrForMessageID("345692@invalid");
  Assert.equal(sourceHeader.numReferences, 2);
  Assert.deepEqual(
    [sourceHeader.getStringReference(0), sourceHeader.getStringReference(1)],
    ["receipt-ancestor@invalid", "receipt-parent@invalid"],
    "The legacy writer persisted the independently specified References"
  );
  reader.forceClosed();
  const sourceSummary = await IOUtils.read(summaryFile.path);
  const sourceBody = await IOUtils.read(folder.filePath.path);
  const db = PanoramaDelivery.assertFolder(folder, lane);
  const connection = database.connectionForTests;
  Assert.greater(folder.id, 0);
  const events = { core: [], compatibility: [] };
  const view = Cc["@mozilla.org/mailnews/live-view;1"].createInstance(
    Ci.nsILiveView
  );
  registerCleanupFunction(() => view.clearListener());
  view.setListener({
    onMessageAdded(message) {
      events.core.push(["added", message.id]);
    },
    onMessageRemoved(message) {
      events.core.push(["removed", message.id]);
    },
    onMessageFlagsChanged(message) {
      events.core.push(["flags", message.id]);
    },
    onMessageTagsChanged(message) {
      events.core.push(["tags", message.id]);
    },
    onSelectedChunk() {},
  });
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrAdded(header) {
      events.compatibility.push(["added", header.messageKey]);
    },
    onHdrDeleted() {
      events.compatibility.push(["deleted"]);
    },
    onHdrFlagsChanged() {
      events.compatibility.push(["flags"]);
    },
    onParentChanged() {
      events.compatibility.push(["parent"]);
    },
    onReadChanged() {
      events.compatibility.push(["read"]);
    },
    onJunkScoreChanged() {
      events.compatibility.push(["junk"]);
    },
    onHdrPropertyChanged() {
      events.compatibility.push(["property"]);
    },
    onEvent() {
      events.compatibility.push(["event"]);
    },
    onAnnouncerGoingAway() {
      events.compatibility.push(["going-away"]);
    },
  };
  db.addListener(listener);
  registerCleanupFunction(() => db.removeListener(listener));
  const controlId = addMessage({
    folderId: folder.id,
    messageId: "receipt-control@invalid",
    references: ["control-ancestor@invalid"],
    subject: "Committed receipt control",
  });
  const controlEvents = {
    core: [["added", controlId]],
    compatibility: [["added", controlId]],
  };
  Assert.deepEqual(events, controlEvents, "Both notification observers work");
  const before = readReceiptMigrationState(folder.id);
  Assert.deepEqual(readStoredMessages(folder.id), [
    [controlId, "receipt-control@invalid", null, null],
  ]);
  Assert.deepEqual(before.referenceSets, [[controlId]]);
  Assert.deepEqual(before.references, [
    [controlId, 0, "control-ancestor@invalid"],
  ]);
  Assert.deepEqual(before.receipt, []);
  Assert.ok(!connection.transactionInProgress);

  const faults = [];
  connection.createFunction("delivery_receipt_fault_witness", 3, {
    onFunctionCall(args) {
      faults.push([
        args.getUTF8String(0),
        args.getUTF8String(1),
        args.getInt32(2),
      ]);
      return 0;
    },
  });
  registerCleanupFunction(() =>
    connection.removeFunction("delivery_receipt_fault_witness")
  );
  // This synchronous receipt write follows all imported rows and References.
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER delivery_fail_receipt BEFORE INSERT " +
      "ON folder_properties WHEN NEW.id = " +
      folder.id +
      " AND NEW.name = 'morkMigrationSource' BEGIN " +
      "SELECT delivery_receipt_fault_witness(" +
      "(SELECT group_concat(messageId, '|') FROM " +
      "(SELECT messageId FROM messages WHERE folderId = NEW.id " +
      "ORDER BY messageId)), " +
      "(SELECT group_concat(token, '|') FROM " +
      "(SELECT r.token FROM message_references r " +
      "JOIN messages m ON m.id = r.id WHERE m.folderId = NEW.id " +
      "AND m.messageId = '345692@invalid' ORDER BY r.ordinal)), " +
      "(SELECT COUNT(*) FROM message_reference_sets r " +
      "JOIN messages m ON m.id = r.id WHERE m.folderId = NEW.id)); " +
      "SELECT RAISE(ABORT, 'delivery migration receipt failure'); END"
  );
  registerCleanupFunction(() =>
    connection.executeSimpleSQL("DROP TRIGGER IF EXISTS delivery_fail_receipt")
  );
  await Assert.rejects(
    database.migrateFolderDatabase(folder),
    error => error.result === Cr.NS_ERROR_STORAGE_CONSTRAINT,
    "The receipt insert rejects with the injected storage constraint"
  );
  Assert.deepEqual(
    faults,
    [
      [
        "162378@invalid|345692@invalid|receipt-control@invalid",
        "receipt-ancestor@invalid|receipt-parent@invalid",
        3,
      ],
    ],
    "The fault sees both imported messages and their completed References work"
  );
  Assert.ok(!connection.transactionInProgress);
  Assert.deepEqual(
    readReceiptMigrationState(folder.id),
    before,
    "Rollback preserves the committed control and removes all import work"
  );
  Assert.deepEqual(events, controlEvents, "Failure publishes no notifications");
  Assert.deepEqual(await IOUtils.read(summaryFile.path), sourceSummary);
  Assert.deepEqual(await IOUtils.read(folder.filePath.path), sourceBody);

  connection.executeSimpleSQL("DROP TRIGGER delivery_fail_receipt");
  await database.migrateFolderDatabase(folder);
  Assert.ok(!connection.transactionInProgress);
  const retried = readReceiptMigrationState(folder.id);
  const stored = readStoredMessages(folder.id);
  Assert.deepEqual(
    stored.map(([, ...fields]) => fields),
    [
      ["162378@invalid", "0", 0x242],
      ["345692@invalid", "1143", 0x177],
      ["receipt-control@invalid", null, null],
    ],
    "Retry commits exactly the source messages beside the earlier control"
  );
  const keys = stored.map(([key]) => key);
  Assert.ok(keys.every(key => key > 0));
  Assert.equal(new Set(keys).size, 3);
  Assert.equal(keys[2], controlId, "The committed control keeps its identity");
  Assert.deepEqual(
    retried.referenceSets,
    keys.map(key => [key])
  );
  Assert.deepEqual(retried.references, [
    [keys[1], 0, "receipt-ancestor@invalid"],
    [keys[1], 1, "receipt-parent@invalid"],
    [controlId, 0, "control-ancestor@invalid"],
  ]);
  Assert.deepEqual(
    retried.messages.filter(row => row[0] == controlId),
    before.messages,
    "Retry preserves every stored control field"
  );
  Assert.deepEqual(
    retried.receipt.map(([name, type]) => [name, type]),
    [["morkMigrationSource", "text"]],
    "A successful retry commits one text receipt"
  );
  const retryEvents = {
    core: [...events.core],
    compatibility: [...events.compatibility],
  };
  await database.migrateFolderDatabase(folder);
  Assert.ok(!connection.transactionInProgress);
  Assert.deepEqual(
    readReceiptMigrationState(folder.id),
    retried,
    "Repeat after retry changes no rows, References, or receipt"
  );
  Assert.deepEqual(events, retryEvents, "Repeat emits no extra notifications");
  Assert.equal(faults.length, 1, "The removed fault is not reached again");
  Assert.deepEqual(await IOUtils.read(summaryFile.path), sourceSummary);
  Assert.deepEqual(await IOUtils.read(folder.filePath.path), sourceBody);
});
