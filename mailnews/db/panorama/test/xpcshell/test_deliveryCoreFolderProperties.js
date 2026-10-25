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

add_task(function test_persistFolderPropertiesByIdentity() {
  const account = MailServices.accounts.createLocalMailAccount();
  registerCleanupFunction(() => MailServices.accounts.removeAccount(account));
  const root = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const first = root.createLocalSubfolder("delivery-first");
  const second = root.createLocalSubfolder("delivery-second");
  Assert.notEqual(first.id, second.id);
  Assert.equal(folderDB.getFolderParent(first.id), root.id);
  Assert.equal(folderDB.getFolderParent(second.id), root.id);

  Assert.equal(first.getStringProperty("delivery.missing"), "");
  first.setStringProperty("delivery.café", "old value");
  first.setStringProperty("delivery.cafe\u0301", "first value");
  second.setStringProperty("delivery.café", "second value");
  first.setStringProperty("delivery.empty", "old value");
  first.setStringProperty("delivery.empty", "");
  Assert.equal(first.getStringProperty("delivery.café"), "first value");
  Assert.equal(first.getStringProperty("delivery.cafe\u0301"), "first value");
  Assert.equal(second.getStringProperty("delivery.café"), "second value");
  Assert.equal(first.getStringProperty("delivery.empty"), "");
  Assert.equal(second.getStringProperty("delivery.empty"), "");
  Assert.deepEqual(
    readStoredRows(
      "SELECT id, name, value FROM folder_properties " +
        "WHERE name LIKE 'delivery.%' ORDER BY id, name",
      ["id", "name", "value"]
    ),
    [
      [first.id, "delivery.café", "first value"],
      [first.id, "delivery.empty", ""],
      [second.id, "delivery.café", "second value"],
    ],
    "Folder identity scopes replacements and preserves an explicitly empty value"
  );
});
