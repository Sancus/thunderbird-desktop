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
  const id = addMessage({
    folderId,
    messageId: "before@example.invalid",
    sender: "Before <before@example.invalid>",
    subject: "Before subject",
    priority: Ci.nsMsgPriority.highest,
  });
  const header = messageDB.getMessage(id);
  Assert.equal(header.messageId, "before@example.invalid");
  Assert.equal(header.author, "Before <before@example.invalid>");
  Assert.equal(header.subject, "Before subject");
  Assert.equal(header.priority, Ci.nsMsgPriority.highest);
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

add_task(function test_repeatedHeaderWritesUpdateExistingHeaders() {
  const root = folderDB.insertRoot("delivery-repeated-headers");
  const folderId = folderDB.insertFolder(root, "Inbox");
  const id = addMessage({
    folderId,
    messageId: "repeated-before@example.invalid",
    subject: "Before",
  });
  const header = messageDB.getMessage(id);
  Assert.equal(header.subject, "Before", "Prime the real cached row");
  const fetched = messageDB.getMessage(id);
  const first = {
    messageId: "repeated-first@example.invalid",
    date: 1736947200123456,
    author: "Zoë <first@example.invalid>",
    recipients: "René <to@example.invalid>",
    ccList: "Chloë <cc@example.invalid>",
    bccList: "Hidden <bcc@example.invalid>",
    subject: "  First café subject  ",
    flags: Ci.nsMsgMessageFlags.Read,
  };
  const second = {
    messageId: "repeated-second@example.invalid",
    date: 1736947200654321,
    author: "Second <second@example.invalid>",
    recipients: "",
    ccList: "",
    bccList: "Zoë <hidden@example.invalid>",
    subject: "",
    flags: Ci.nsMsgMessageFlags.Marked,
  };
  for (const values of [first, second]) {
    for (const [name, value] of Object.entries(values)) {
      fetched[name] = value;
    }
    for (const [name, value] of Object.entries(values)) {
      Assert.equal(header[name], value, name + " updates the retained header");
      Assert.equal(
        messageDB.getMessage(id)[name],
        value,
        name + " updates a fetched header"
      );
    }
    Assert.deepEqual(
      readStoredRows(
        "SELECT messageId, date, sender, recipients, ccList, bccList, " +
          "subject, flags FROM messages WHERE id = " +
          id,
        [
          "messageId",
          "date",
          "sender",
          "recipients",
          "ccList",
          "bccList",
          "subject",
          "flags",
        ]
      ),
      [Object.values(values)],
      "An independent reader observes the complete committed values"
    );
  }
});

add_task(function test_failedHeaderWritePreservesLiveFields() {
  const root = folderDB.insertRoot("delivery-header-write-error");
  const folderId = folderDB.insertFolder(root, "Inbox");
  const id = addMessage({
    folderId,
    messageId: "failed-before@example.invalid",
    date: 1736947200123,
    sender: "Before <before@example.invalid>",
    recipients: "Before recipients",
    ccList: "Before cc",
    bccList: "Before bcc",
    subject: "Before subject",
    flags: Ci.nsMsgMessageFlags.Read,
  });
  const header = messageDB.getMessage(id);
  const before = {
    messageId: "failed-before@example.invalid",
    date: 1736947200123000,
    author: "Before <before@example.invalid>",
    recipients: "Before recipients",
    ccList: "Before cc",
    bccList: "Before bcc",
    subject: "Before subject",
    flags: Ci.nsMsgMessageFlags.Read,
  };
  const after = {
    messageId: "failed-after@example.invalid",
    date: 1736947200654321,
    author: "After <after@example.invalid>",
    recipients: "After recipients",
    ccList: "After cc",
    bccList: "",
    subject: "After café subject",
    flags: Ci.nsMsgMessageFlags.Marked,
  };
  for (const [name, value] of Object.entries(before)) {
    Assert.equal(header[name], value, name + " primes the committed field");
  }
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_header_write BEFORE UPDATE ON messages " +
      "WHEN OLD.id = " +
      id +
      " BEGIN " +
      "SELECT RAISE(ABORT, 'header write rejected'); END"
  );
  try {
    for (const [name, value] of Object.entries(after)) {
      Assert.throws(
        () => {
          header[name] = value;
        },
        error => error.result === Cr.NS_ERROR_STORAGE_CONSTRAINT,
        name + " propagates the actual SQL constraint error"
      );
      Assert.ok(
        !connection.transactionInProgress,
        "The failed write rolled back"
      );
      for (const [field, oldValue] of Object.entries(before)) {
        Assert.equal(header[field], oldValue, field + " retains the hot value");
        Assert.equal(messageDB.getMessage(id)[field], oldValue);
      }
    }
    Assert.deepEqual(
      readStoredRows(
        "SELECT messageId, date, sender, recipients, ccList, bccList, " +
          "subject, flags FROM messages WHERE id = " +
          id,
        [
          "messageId",
          "date",
          "sender",
          "recipients",
          "ccList",
          "bccList",
          "subject",
          "flags",
        ]
      ),
      [Object.values(before)],
      "Failed writes leave all committed fields intact"
    );
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_header_write");
  }
  for (const [name, value] of Object.entries(after)) {
    header[name] = value;
    Assert.equal(header[name], value, name + " retries after the constraint");
  }
  Assert.deepEqual(
    readStoredRows(
      "SELECT messageId, date, sender, recipients, ccList, bccList, " +
        "subject, flags FROM messages WHERE id = " +
        id,
      [
        "messageId",
        "date",
        "sender",
        "recipients",
        "ccList",
        "bccList",
        "subject",
        "flags",
      ]
    ),
    [Object.values(after)],
    "All retries commit after removing only the failing trigger"
  );
});
