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
  // The body store is incidental; storage and process restart are not exercised.
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
  first.setStringProperty("delivery.cafe\u0301", "previous value");
  first.setStringProperty("delivery.cafe\u0301", "raw cafe\u0301 value");
  first.setStringProperty("delivery.case", "previous value");
  first.setStringProperty("delivery.Case", "upper value");
  first.setStringProperty("delivery.case", "lower value");
  first.setStringProperty("delivery.leading", "00042");
  first.setStringProperty("delivery.exponent", "1e3");
  first.setStringProperty("delivery.empty", "old value");
  first.setStringProperty("delivery.empty", "");
  second.setStringProperty("delivery.café", "second value");
  second.setStringProperty("delivery.cafe\u0301", "second decomposed value");

  const expectedFirst = [
    ["delivery.Case", "upper value"],
    ["delivery.cafe\u0301", "raw cafe\u0301 value"],
    ["delivery.café", "old value"],
    ["delivery.case", "lower value"],
    ["delivery.empty", ""],
    ["delivery.exponent", "1e3"],
    ["delivery.leading", "00042"],
  ];
  const expectedSecond = [
    ["delivery.cafe\u0301", "second decomposed value"],
    ["delivery.café", "second value"],
  ];
  Assert.deepEqual(
    {
      first: expectedFirst.map(([name]) => [
        name,
        first.getStringProperty(name),
      ]),
      second: expectedSecond.map(([name]) => [
        name,
        second.getStringProperty(name),
      ]),
      secondEmpty: second.getStringProperty("delivery.empty"),
      stored: readStoredRows(
        "SELECT id, name, value FROM folder_properties " +
          "WHERE name LIKE 'delivery.%' ORDER BY id, name",
        ["id", "name", "value"]
      ),
    },
    {
      first: expectedFirst,
      second: expectedSecond,
      secondEmpty: "",
      stored: [
        ...expectedFirst.map(([name, text]) => [first.id, name, text]),
        ...expectedSecond.map(([name, text]) => [second.id, name, text]),
      ],
    },
    "Exact property names and overwrites preserve values within each folder"
  );
});
