/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

const { MailStringUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailStringUtils.sys.mjs"
);

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

add_task(function test_persistPropertyNamesAndViews() {
  const root = folderDB.insertRoot("delivery-properties");
  const folderId = folderDB.insertFolder(root, "Inbox");
  const id = addMessage({ folderId, messageId: "properties@example.invalid" });
  const header = messageDB.getMessage(id);

  Assert.equal(header.getStringProperty("delivery.missing"), "");
  Assert.equal(header.getUint32Property("delivery.missing"), 0);
  header.setStringProperty(
    MailStringUtils.stringToByteString("delivery.café"),
    "old value"
  );
  header.setStringProperty(
    MailStringUtils.stringToByteString("delivery.cafe\u0301"),
    "previous value"
  );
  header.setStringProperty(
    MailStringUtils.stringToByteString("delivery.cafe\u0301"),
    "raw cafe\u0301 value"
  );
  header.setStringProperty("delivery.case", "previous value");
  header.setStringProperty("delivery.Case", "upper value");
  header.setStringProperty("delivery.case", "lower value");
  header.setStringProperty("delivery.leading", "00042");
  header.setStringProperty("delivery.exponent", "1e3");
  header.setStringProperty("delivery.empty", "previous value");
  header.setStringProperty("delivery.empty", "");
  header.setUint32Property("delivery.answer", 42);
  header.setUint32Property("delivery.maximum", 0xffffffff);
  header.setUint32Property("delivery.zero", 17);
  header.setUint32Property("delivery.zero", 0);
  header.setStringProperty("keywords", "label1 label2");

  const stringProperties = [
    ["delivery.Case", "upper value", 0],
    ["delivery.cafe\u0301", "raw cafe\u0301 value", 0],
    ["delivery.café", "old value", 0],
    ["delivery.case", "lower value", 0],
    ["delivery.empty", "", 0],
    ["delivery.exponent", "1e3", 483],
    ["delivery.leading", "00042", 66],
  ];
  const expectedProperties = [
    ...stringProperties,
    ["delivery.answer", "2a", 42],
    ["delivery.maximum", "ffffffff", 0xffffffff],
    ["delivery.zero", "0", 0],
  ];
  const expectedNames = expectedProperties.map(([name]) => name).toSorted();

  // Cached getters and an unshared SQL reader do not exercise process restart.
  const fetched = messageDB.getMessage(id);
  Assert.deepEqual(
    {
      views: expectedProperties.map(([name]) => [
        name,
        fetched.getStringProperty(MailStringUtils.stringToByteString(name)),
        fetched.getUint32Property(MailStringUtils.stringToByteString(name)),
      ]),
      names: fetched.properties.toSorted(),
      nativeText: stringProperties.map(([name]) => [
        name,
        messageDB.getMessageProperty(id, name),
      ]),
      storedNames: readStoredRows(
        "SELECT id, name FROM message_properties ORDER BY name",
        ["id", "name"]
      ),
      storedStrings: readStoredRows(
        "SELECT id, name, value FROM message_properties " +
          "WHERE name NOT IN " +
          "('delivery.answer', 'delivery.maximum', 'delivery.zero') ORDER BY name",
        ["id", "name", "value"]
      ),
      keywords: fetched.getStringProperty("keywords"),
      storedTags: readStoredRows("SELECT id, tags FROM messages", [
        "id",
        "tags",
      ]),
    },
    {
      views: expectedProperties,
      names: expectedNames,
      nativeText: stringProperties.map(([name, text]) => [name, text]),
      storedNames: expectedNames.map(name => [id, name]),
      storedStrings: stringProperties.map(([name, text]) => [id, name, text]),
      keywords: "label1 label2",
      storedTags: [[id, "label1 label2"]],
    },
    "Exact names, text, both header views and committed metadata stay independent"
  );
});
