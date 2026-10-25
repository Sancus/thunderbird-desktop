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
