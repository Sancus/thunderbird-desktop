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

add_task(function test_persistTypedProperties() {
  const root = folderDB.insertRoot("delivery-properties");
  const folderId = folderDB.insertFolder(root, "Inbox");
  const id = addMessage({ folderId, messageId: "properties@example.invalid" });
  const header = messageDB.getMessage(id);

  Assert.equal(header.getStringProperty("delivery.missing"), "");
  Assert.equal(header.getUint32Property("delivery.missing"), 0);
  header.setStringProperty("delivery.café", "old value");
  header.setStringProperty("delivery.cafe\u0301", "raw cafe\u0301 value");
  header.setStringProperty("delivery.empty", "previous value");
  header.setStringProperty("delivery.empty", "");
  header.setUint32Property("delivery.maximum", 0xffffffff);
  header.setUint32Property("delivery.zero", 17);
  header.setUint32Property("delivery.zero", 0);
  header.setStringProperty("keywords", "label1 label2");

  const fetched = messageDB.getMessage(id);
  Assert.equal(
    fetched.getStringProperty("delivery.café"),
    "raw cafe\u0301 value"
  );
  Assert.equal(
    messageDB.getMessageProperty(id, "delivery.cafe\u0301"),
    "raw cafe\u0301 value",
    "Equivalent property names address the updated value"
  );
  Assert.equal(fetched.getStringProperty("delivery.empty"), "");
  Assert.equal(fetched.getUint32Property("delivery.maximum"), 0xffffffff);
  Assert.equal(fetched.getUint32Property("delivery.zero"), 0);
  Assert.equal(fetched.getStringProperty("keywords"), "label1 label2");
  Assert.deepEqual(fetched.properties.toSorted(), [
    "delivery.café",
    "delivery.empty",
    "delivery.maximum",
    "delivery.zero",
  ]);
  Assert.deepEqual(
    readStoredRows(
      "SELECT id, name, value FROM message_properties ORDER BY name",
      ["id", "name", "value"]
    ),
    [
      [id, "delivery.café", "raw cafe\u0301 value"],
      [id, "delivery.empty", ""],
      [id, "delivery.maximum", 0xffffffff],
      [id, "delivery.zero", 0],
    ],
    "Updates replace one property; empty and zero remain stored values"
  );
  Assert.deepEqual(
    readStoredRows("SELECT id, tags FROM messages", ["id", "tags"]),
    [[id, "label1 label2"]],
    "Keywords persist as tags without a duplicate arbitrary property"
  );
});
