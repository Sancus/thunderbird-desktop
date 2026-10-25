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

add_task(function test_keepDuplicateMessageIdsIndependent() {
  const rootA = folderDB.insertRoot("delivery-server-a");
  const rootB = folderDB.insertRoot("delivery-server-b");
  const folderA = folderDB.insertFolder(rootA, "Inbox");
  const folderB = folderDB.insertFolder(rootB, "Inbox");
  Assert.notEqual(folderA, folderB, "Folder IDs are global across servers");
  Assert.equal(folderDB.getFolderByPath("delivery-server-a/Inbox"), folderA);
  Assert.equal(folderDB.getFolderByPath("delivery-server-b/Inbox"), folderB);

  const idA = addMessage({
    folderId: folderA,
    messageId: "same@example.invalid",
  });
  const idB = addMessage({
    folderId: folderB,
    messageId: "same@example.invalid",
  });
  const idC = addMessage({
    folderId: folderA,
    messageId: "same@example.invalid",
  });
  Assert.ok(idA > 0 && idB > 0 && idC > 0);
  Assert.equal(new Set([idA, idB, idC]).size, 3, "Each copy has its own key");
  Assert.equal(messageDB.totalCount, 3);
  messageDB.getMessage(idA).setStringProperty("delivery.owner", "first");
  messageDB.getMessage(idB).setStringProperty("delivery.owner", "second");
  messageDB.getMessage(idC).setStringProperty("delivery.owner", "third");
  Assert.deepEqual(
    [idA, idB, idC].map(id =>
      messageDB.getMessage(id).getStringProperty("delivery.owner")
    ),
    ["first", "second", "third"],
    "Properties are scoped by global key, including copies in the same folder"
  );
  Assert.deepEqual(
    readStoredRows("SELECT id, folderId, messageId FROM messages ORDER BY id", [
      "id",
      "folderId",
      "messageId",
    ]),
    [
      [idA, folderA, "same@example.invalid"],
      [idB, folderB, "same@example.invalid"],
      [idC, folderA, "same@example.invalid"],
    ].sort((left, right) => left[0] - right[0])
  );

  messageDB.removeMessage(idA);
  Assert.equal(messageDB.totalCount, 2);
  Assert.equal(messageDB.getMessage(idB).messageId, "same@example.invalid");
  Assert.equal(messageDB.getMessage(idC).messageId, "same@example.invalid");
  Assert.deepEqual(
    readStoredRows("SELECT id, folderId FROM messages ORDER BY id", [
      "id",
      "folderId",
    ]),
    [
      [idB, folderB],
      [idC, folderA],
    ].sort((left, right) => left[0] - right[0]),
    "Deleting one copy leaves both other copies stored"
  );
  Assert.deepEqual(
    readStoredRows(
      "SELECT id, value FROM message_properties " +
        "WHERE name = 'delivery.owner' ORDER BY id",
      ["id", "value"]
    ),
    [
      [idB, "second"],
      [idC, "third"],
    ].sort((left, right) => left[0] - right[0]),
    "Deleting one copy removes only its own properties"
  );
});
