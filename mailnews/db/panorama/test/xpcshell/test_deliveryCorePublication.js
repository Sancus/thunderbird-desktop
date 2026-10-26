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

add_task(async function test_folderFilteredEventsUseDatabaseIdentity() {
  const root = folderDB.insertRoot("delivery-filter-events");
  const folderId = folderDB.insertFolder(root, "Inbox");
  const otherFolder = folderDB.insertFolder(root, "Other");
  const controlId = addMessage({ folderId, messageId: "filter-control@invalid" });
  Assert.throws(
    () => messageDB.getMessage(controlId).folder,
    /NS_ERROR_NOT_INITIALIZED/,
    "The raw folder has no account-backed folder object"
  );
  const view = Cc["@mozilla.org/mailnews/live-view;1"].createInstance(
    Ci.nsILiveView
  );
  registerCleanupFunction(() => view.clearListener());
  view.initWithFolder(folderId);
  const events = [];
  view.setListener({
    onMessageAdded(message) {
      events.push(["added", message.id, message.folderId]);
    },
    onMessageRemoved(message) {
      events.push(["removed", message.id, message.folderId]);
    },
    onMessageFlagsChanged(message) {
      events.push(["flags", message.id, message.folderId]);
    },
    onMessageTagsChanged(message) {
      events.push(["tags", message.id, message.folderId]);
    },
    onSelectedChunk() {},
  });
  try {
    const id = addMessage({ folderId, messageId: "filter-added@invalid" });
    const otherId = addMessage({
      folderId: otherFolder,
      messageId: "filter-excluded@invalid",
    });
    const header = messageDB.getMessage(id);
    header.flags = Ci.nsMsgMessageFlags.Read;
    header.setStringProperty("keywords", "filter-tag");
    messageDB.removeMessage(id);
    Assert.deepEqual(events, [
      ["added", id, folderId],
      ["flags", id, folderId],
      ["tags", id, folderId],
      ["removed", id, folderId],
    ]);
    Assert.deepEqual(
      readStoredRows(
        "SELECT id, folderId FROM messages WHERE folderId IN (" +
          folderId +
          ", " +
          otherFolder +
          ") ORDER BY messageId",
        ["id", "folderId"]
      ),
      [
        [controlId, folderId],
        [otherId, otherFolder],
      ],
      "The removed row is absent while both control rows survive"
    );
    Assert.equal(await view.countMessages(), 1);
    Assert.deepEqual(
      Array.from(await view.selectMessages(), message => message.id),
      [controlId],
      "SQL selection and live events agree on folder membership"
    );
  } finally {
    view.clearListener();
  }
});

add_task(async function test_tagThenReadPublishesEachMessageOnce() {
  const root = folderDB.insertRoot("delivery-tag-then-read");
  const folderId = folderDB.insertFolder(root, "Inbox");
  const tag = "delivery-snapshot-tag";
  const view = Cc["@mozilla.org/mailnews/live-view;1"].createInstance(
    Ci.nsILiveView
  );
  view.initWithTag(tag);
  registerCleanupFunction(() => view.clearListener());
  const events = [];
  view.setListener({
    onMessageAdded(message) {
      events.push(["added", message.id, message.flags, message.tags]);
    },
    onMessageRemoved(message) {
      events.push(["removed", message.id, message.flags, message.tags]);
    },
    onMessageFlagsChanged(message, oldFlags) {
      events.push(["flags", message.id, message.flags, message.tags, oldFlags]);
    },
    onMessageTagsChanged(message, oldTags) {
      events.push(["tags", message.id, message.flags, message.tags, oldTags]);
    },
    onSelectedChunk() {},
  });
  try {
    const first = addMessage({
      folderId,
      messageId: "snapshot-copy@invalid",
      flags: 0,
    });
    const second = addMessage({
      folderId,
      messageId: "snapshot-copy@invalid",
      flags: 0,
    });
    const control = addMessage({
      folderId,
      messageId: "snapshot-control@invalid",
      flags: 0,
    });
    Assert.deepEqual(events, [], "Untagged rows do not enter the tag view");
    const firstHeader = messageDB.getMessage(first);
    const secondHeader = messageDB.getMessage(second);
    secondHeader.setStringProperty("keywords", tag);
    firstHeader.setStringProperty("keywords", tag);
    secondHeader.flags = Ci.nsMsgMessageFlags.Read;
    firstHeader.flags = Ci.nsMsgMessageFlags.Read;
    messageDB.getMessage(control).flags = Ci.nsMsgMessageFlags.Read;
    Assert.deepEqual(events, [
      ["added", second, 0, tag],
      ["added", first, 0, tag],
      ["flags", second, Ci.nsMsgMessageFlags.Read, tag, 0],
      ["flags", first, Ci.nsMsgMessageFlags.Read, tag, 0],
    ]);
    Assert.equal(await view.countMessages(), 2);
    Assert.deepEqual(
      Array.from(await view.selectMessages(), message => message.id).sort(
        (a, b) => a - b
      ),
      [first, second].sort((a, b) => a - b),
      "SQL membership contains both physical copies exactly once"
    );
    Assert.deepEqual(
      readStoredRows(
        "SELECT id, flags, tags FROM messages WHERE folderId = " +
          folderId +
          " ORDER BY id",
        ["id", "flags", "tags"]
      ),
      [
        [first, Ci.nsMsgMessageFlags.Read, tag],
        [second, Ci.nsMsgMessageFlags.Read, tag],
        [control, Ci.nsMsgMessageFlags.Read, ""],
      ].sort((a, b) => a[0] - b[0]),
      "Independent committed rows retain the tags during flag changes"
    );
  } finally {
    view.clearListener();
  }
});

add_task(async function test_tagChangesPreserveFlaggedMembership() {
  const root = folderDB.insertRoot("delivery-tag-flagged-snapshot");
  const folderId = folderDB.insertFolder(root, "Inbox");
  const flags = Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked;
  const view = Cc["@mozilla.org/mailnews/live-view;1"].createInstance(
    Ci.nsILiveView
  );
  view.initWithFlaggedMessages();
  registerCleanupFunction(() => view.clearListener());
  const baseline = await view.countMessages();
  const events = [];
  view.setListener({
    onMessageAdded(message) {
      events.push(["added", message.id, message.flags, message.tags]);
    },
    onMessageRemoved(message) {
      events.push(["removed", message.id, message.flags, message.tags]);
    },
    onMessageFlagsChanged(message, oldFlags) {
      events.push(["flags", message.id, message.flags, message.tags, oldFlags]);
    },
    onMessageTagsChanged(message, oldTags) {
      events.push(["tags", message.id, message.flags, message.tags, oldTags]);
    },
    onSelectedChunk() {},
  });
  try {
    const id = addMessage({ folderId, flags, tags: "before" });
    const control = addMessage({
      folderId,
      flags: Ci.nsMsgMessageFlags.Read,
      tags: "before",
    });
    messageDB.getMessage(id).setStringProperty("keywords", "after");
    messageDB.getMessage(control).setStringProperty("keywords", "after");
    Assert.deepEqual(events, [
      ["added", id, flags, "before"],
      ["tags", id, flags, "after", "before"],
    ]);
    Assert.equal(await view.countMessages(), baseline + 1);
    Assert.deepEqual(
      Array.from(await view.selectMessages(), message => message.id).filter(
        key => key === id || key === control
      ),
      [id],
      "Only the flagged row belongs to the view"
    );
    Assert.deepEqual(
      readStoredRows(
        "SELECT id, flags, tags FROM messages WHERE folderId = " +
          folderId +
          " ORDER BY id",
        ["id", "flags", "tags"]
      ),
      [
        [id, flags, "after"],
        [control, Ci.nsMsgMessageFlags.Read, "after"],
      ].sort((a, b) => a[0] - b[0]),
      "Tag replacement preserves the committed flags of both rows"
    );
  } finally {
    view.clearListener();
  }
});

add_task(async function test_tagChangesKeepReadMessagesOutOfUnreadView() {
  const root = folderDB.insertRoot("delivery-tag-unread-snapshot");
  const folderId = folderDB.insertFolder(root, "Inbox");
  const view = Cc["@mozilla.org/mailnews/live-view;1"].createInstance(
    Ci.nsILiveView
  );
  view.initWithUnreadMessages();
  registerCleanupFunction(() => view.clearListener());
  const baseline = await view.countMessages();
  const events = [];
  view.setListener({
    onMessageAdded(message) {
      events.push(["added", message.id, message.flags, message.tags]);
    },
    onMessageRemoved(message) {
      events.push(["removed", message.id, message.flags, message.tags]);
    },
    onMessageFlagsChanged(message, oldFlags) {
      events.push(["flags", message.id, message.flags, message.tags, oldFlags]);
    },
    onMessageTagsChanged(message, oldTags) {
      events.push(["tags", message.id, message.flags, message.tags, oldTags]);
    },
    onSelectedChunk() {},
  });
  try {
    const unread = addMessage({ folderId, flags: 0, tags: "before" });
    const read = addMessage({
      folderId,
      flags: Ci.nsMsgMessageFlags.Read,
      tags: "before",
    });
    messageDB.getMessage(read).setStringProperty("keywords", "after");
    messageDB.getMessage(unread).setStringProperty("keywords", "after");
    Assert.deepEqual(events, [
      ["added", unread, 0, "before"],
      ["tags", unread, 0, "after", "before"],
    ]);
    Assert.equal(await view.countMessages(), baseline + 1);
    Assert.deepEqual(
      Array.from(await view.selectMessages(), message => message.id).filter(
        key => key === read || key === unread
      ),
      [unread],
      "The read control never belongs to the unread view"
    );
    Assert.deepEqual(
      readStoredRows(
        "SELECT id, flags, tags FROM messages WHERE folderId = " +
          folderId +
          " ORDER BY id",
        ["id", "flags", "tags"]
      ),
      [
        [unread, 0, "after"],
        [read, Ci.nsMsgMessageFlags.Read, "after"],
      ].sort((a, b) => a[0] - b[0]),
      "Both committed rows preserve their read states during tag changes"
    );
  } finally {
    view.clearListener();
  }
});
