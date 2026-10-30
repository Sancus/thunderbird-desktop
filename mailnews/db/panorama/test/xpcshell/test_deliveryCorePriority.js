/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

let dbFile;

add_setup(function () {
  dbFile = do_get_profile().clone();
  dbFile.append("panorama.sqlite");
  Assert.ok(!dbFile.exists(), "DatabaseCore must create the schema");
  loadExistingDB();
  PanoramaDelivery.assertBackend(PanoramaDelivery.expectedLane().backend);
  Assert.equal(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    ),
    database,
    "The account manager selected Panorama as the database service"
  );
  Assert.equal(database.connectionForTests.databaseFile.path, dbFile.path);
});

/**
 * Read committed rows through a separate connection to the profile database.
 *
 * @param {string} sql - A SELECT statement with no parameters.
 * @param {string[]} columns - Columns to include in each returned row.
 * @returns {Array<Array<string|number|null>>} The selected values.
 */
function readStoredRows(sql, columns) {
  const connection = Services.storage.openUnsharedDatabase(dbFile);
  try {
    const stmt = connection.createStatement(sql);
    try {
      const rows = [];
      while (stmt.executeStep()) {
        rows.push(columns.map(column => stmt.row[column]));
      }
      return rows;
    } finally {
      stmt.finalize();
    }
  } finally {
    connection.close();
  }
}

add_task(function test_addMessageWithPriority() {
  const root = folderDB.insertRoot("delivery-priority");
  const folderId = folderDB.insertFolder(root, "Inbox");
  const id = addMessage({
    folderId,
    messageId: "priority@example.invalid",
    priority: Ci.nsMsgPriority.high,
  });

  const priority = messageDB.getMessage(id).priority;
  const stored = readStoredRows("SELECT id, priority FROM messages", [
    "id",
    "priority",
  ]);
  Assert.deepEqual(
    { priority, stored },
    { priority: Ci.nsMsgPriority.high, stored: [[id, Ci.nsMsgPriority.high]] },
    "The immediate header and committed row retain the supplied priority"
  );
});

add_task(function test_priorityUpdatesAndFailureKeepCommittedValue() {
  const root = folderDB.insertRoot("delivery-priority-updates");
  const folderId = folderDB.insertFolder(root, "Inbox");
  const id = addMessage({
    folderId,
    messageId: "priority-updates@example.invalid",
    priority: Ci.nsMsgPriority.lowest,
  });
  const header = messageDB.getMessage(id);
  Assert.equal(
    header.priority,
    Ci.nsMsgPriority.lowest,
    "Prime the cached row"
  );
  for (const priority of [
    Ci.nsMsgPriority.highest,
    Ci.nsMsgPriority.normal,
    Ci.nsMsgPriority.lowest,
    Ci.nsMsgPriority.notSet,
  ]) {
    header.priority = priority;
    Assert.equal(header.priority, priority, "The retained header is updated");
    Assert.equal(messageDB.getMessage(id).priority, priority);
    Assert.deepEqual(
      readStoredRows("SELECT priority FROM messages WHERE id = " + id, [
        "priority",
      ]),
      [[priority]],
      "The independent committed row agrees with the public getter"
    );
  }
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_priority_write BEFORE UPDATE OF priority " +
      "ON messages WHEN OLD.id = " +
      id +
      " BEGIN " +
      "SELECT RAISE(ABORT, 'priority write rejected'); END"
  );
  try {
    Assert.throws(
      () => {
        header.priority = Ci.nsMsgPriority.high;
      },
      error => error.result === Cr.NS_ERROR_STORAGE_CONSTRAINT,
      "The priority setter propagates the actual SQL constraint error"
    );
    Assert.ok(
      !connection.transactionInProgress,
      "The failed setter rolled back"
    );
    Assert.equal(header.priority, Ci.nsMsgPriority.notSet);
    Assert.equal(messageDB.getMessage(id).priority, Ci.nsMsgPriority.notSet);
    Assert.deepEqual(
      readStoredRows("SELECT priority FROM messages WHERE id = " + id, [
        "priority",
      ]),
      [[Ci.nsMsgPriority.notSet]],
      "The failure preserves the previous committed priority"
    );
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_priority_write");
  }
  header.priority = Ci.nsMsgPriority.normal;
  Assert.equal(header.priority, Ci.nsMsgPriority.normal);
  Assert.equal(messageDB.getMessage(id).priority, Ci.nsMsgPriority.normal);
  Assert.deepEqual(
    readStoredRows("SELECT priority FROM messages WHERE id = " + id, [
      "priority",
    ]),
    [[Ci.nsMsgPriority.normal]],
    "The same live header can retry and commit after rollback"
  );
});
