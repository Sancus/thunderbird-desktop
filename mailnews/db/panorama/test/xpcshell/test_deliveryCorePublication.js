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

add_task(async function test_publishCommittedMessageOnce() {
  const root = folderDB.insertRoot("delivery-publication");
  const folderId = folderDB.insertFolder(root, "Inbox");
  // Observe raw rows without requiring an account-backed nsIMsgFolder.
  const view = Cc["@mozilla.org/mailnews/live-view;1"].createInstance(
    Ci.nsILiveView
  );
  registerCleanupFunction(() => view.clearListener());
  const events = [];
  view.setListener({
    onMessageAdded(message) {
      const header = messageDB.getMessage(message.id);
      events.push({
        id: message.id,
        folderId: message.folderId,
        messageId: message.messageId,
        date: message.date.valueOf(),
        sender: message.sender,
        recipients: message.recipients,
        subject: message.subject,
        flags: message.flags,
        tags: message.tags,
        threadId: message.threadId,
        threadParent: message.threadParent,
        ccList: header.ccList,
        bccList: header.bccList,
        stored: readStoredRows(
          "SELECT id, folderId, messageId, threadId, threadParent, " +
            "date, sender, recipients, ccList, bccList, subject, flags, tags " +
            "FROM messages",
          [
            "id",
            "folderId",
            "messageId",
            "threadId",
            "threadParent",
            "date",
            "sender",
            "recipients",
            "ccList",
            "bccList",
            "subject",
            "flags",
            "tags",
          ]
        ),
      });
    },
    onMessageRemoved(message) {
      events.push({ removed: message.id });
    },
    onMessageFlagsChanged(message) {
      events.push({ flagsChanged: message.id });
    },
    onMessageTagsChanged(message) {
      events.push({ tagsChanged: message.id });
    },
  });

  const id = addMessage({
    folderId,
    messageId: "published@example.invalid",
    date: "2025-01-15T12:00:00Z",
    sender: "Sender <sender@example.invalid>",
    recipients: "To <to@example.invalid>",
    ccList: "Cc <cc@example.invalid>",
    bccList: "Bcc <bcc@example.invalid>",
    subject: "Published message",
    flags: Ci.nsMsgMessageFlags.Read,
    tags: "delivery-tag",
  });
  Assert.equal(await view.countMessages(), 1);
  Assert.equal(events.length, 1, "One add callback was published");
  const threadId = events[0].threadId;
  Assert.ok(threadId > 0, "The published message has a thread identity");
  Assert.deepEqual(
    events,
    [
      {
        id,
        folderId,
        messageId: "published@example.invalid",
        date: 1736942400000,
        sender: "Sender <sender@example.invalid>",
        recipients: "To <to@example.invalid>",
        subject: "Published message",
        flags: Ci.nsMsgMessageFlags.Read,
        tags: "delivery-tag",
        threadId,
        threadParent: 0,
        ccList: "Cc <cc@example.invalid>",
        bccList: "Bcc <bcc@example.invalid>",
        stored: [
          [
            id,
            folderId,
            "published@example.invalid",
            threadId,
            0,
            1736942400000000,
            "Sender <sender@example.invalid>",
            "To <to@example.invalid>",
            "Cc <cc@example.invalid>",
            "Bcc <bcc@example.invalid>",
            "Published message",
            Ci.nsMsgMessageFlags.Read,
            "delivery-tag",
          ],
        ],
      },
    ],
    "One add callback sees the complete, committed addMessage input"
  );
});
