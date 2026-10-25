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

add_task(function test_persistHeaderUpdates() {
  const root = folderDB.insertRoot("delivery-headers");
  const folderId = folderDB.insertFolder(root, "Inbox");
  const id = addMessage({ folderId, messageId: "before@example.invalid" });
  const header = messageDB.getMessage(id);
  const expected = {
    messageId: "after@example.invalid",
    date: 1736947200123456,
    author: "Zoë <sender@example.invalid>",
    recipients: "René <to@example.invalid>",
    ccList: "Chloë <cc@example.invalid>",
    bccList: "Hidden <bcc@example.invalid>",
    subject: "Updated café subject",
    flags: Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Attachment,
    priority: Ci.nsMsgPriority.low,
    messageSize: 0xffffffff,
    offlineMessageSize: 4097,
    lineCount: 123,
    storeToken: "maildir-token:001",
  };
  for (const [name, value] of Object.entries(expected)) {
    header[name] = value;
  }

  const fetched = messageDB.getMessage(id);
  for (const [name, value] of Object.entries(expected)) {
    Assert.equal(fetched[name], value, name + " reflects the update");
  }
  Assert.equal(fetched.dateInSeconds, 1736947200);
  Assert.equal(fetched.mime2DecodedAuthor, "Zoë <sender@example.invalid>");
  Assert.equal(fetched.mime2DecodedSubject, "Updated café subject");
  Assert.ok(fetched.isRead);
  Assert.deepEqual(
    readStoredRows(
      "SELECT id, folderId, messageId, date, sender, recipients, ccList, " +
        "bccList, subject, flags, priority FROM messages",
      [
        "id",
        "folderId",
        "messageId",
        "date",
        "sender",
        "recipients",
        "ccList",
        "bccList",
        "subject",
        "flags",
        "priority",
      ]
    ),
    [
      [
        id,
        folderId,
        "after@example.invalid",
        1736947200123456,
        "Zoë <sender@example.invalid>",
        "René <to@example.invalid>",
        "Chloë <cc@example.invalid>",
        "Hidden <bcc@example.invalid>",
        "Updated café subject",
        Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Attachment,
        Ci.nsMsgPriority.low,
      ],
    ],
    "Committed headers agree with the requested values"
  );
  Assert.deepEqual(
    readStoredRows("SELECT name, value FROM message_properties ORDER BY name", [
      "name",
      "value",
    ]),
    [
      ["lineCount", 123],
      ["messageSize", 0xffffffff],
      ["offlineMessageSize", 4097],
      ["storeToken", "maildir-token:001"],
    ],
    "Storage metadata persists under its public property names"
  );
});
