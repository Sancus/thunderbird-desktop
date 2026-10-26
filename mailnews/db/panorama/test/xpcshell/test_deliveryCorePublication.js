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

/**
 * Record live-view callbacks with current date, thread, flags and tags.
 *
 * @param {nsILiveView} view - The view whose listener is replaced.
 * @returns {Array<Array<string|number|null>>} Ordered callback fields and the
 *   previous flags/tags value, or null for additions/removals.
 */
function recordSnapshotEvents(view) {
  const events = [];
  const record = (kind, message, previous = null) => {
    events.push([
      kind,
      message.id,
      message.date.valueOf(),
      message.threadId,
      message.flags,
      message.tags,
      previous,
    ]);
  };
  view.setListener({
    onMessageAdded(message) {
      record("added", message);
    },
    onMessageRemoved(message) {
      record("removed", message);
    },
    onMessageFlagsChanged(message, oldFlags) {
      record("flags", message, oldFlags);
    },
    onMessageTagsChanged(message, oldTags) {
      record("tags", message, oldTags);
    },
    onSelectedChunk() {},
  });
  registerCleanupFunction(() => view.clearListener());
  return events;
}

add_task(async function test_flagChangesRetainDateMembership() {
  const root = folderDB.insertRoot("delivery-date-snapshot-flag");
  const folderId = folderDB.insertFolder(root, "Inbox");
  const targetDate = Date.UTC(2040, 0, 15, 12);
  const epochDate = Date.UTC(1970, 0, 1, 12);
  const excludedDate = Date.UTC(2041, 0, 15, 12);
  const initialFlags = Ci.nsMsgMessageFlags.Marked;
  const finalFlags = Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked;
  const view = Cc["@mozilla.org/mailnews/live-view;1"].createInstance(
    Ci.nsILiveView
  );
  view.initWithDateRange(
    Date.UTC(2040, 0, 1) * 1000,
    Date.UTC(2040, 1, 1) * 1000
  );
  const epochView = Cc["@mozilla.org/mailnews/live-view;1"].createInstance(
    Ci.nsILiveView
  );
  epochView.initWithDateRange(
    Date.UTC(1969, 11, 31) * 1000,
    Date.UTC(1970, 0, 2) * 1000
  );
  const events = recordSnapshotEvents(view);
  const epochEvents = recordSnapshotEvents(epochView);
  try {
    const baseline = await view.countMessages();
    const epochBaseline = await epochView.countMessages();
    const target = addMessage({
      folderId,
      messageId: "date-flag-target@invalid",
      date: "2040-01-15T12:00:00Z",
      flags: initialFlags,
      tags: "snapshot-before",
    });
    const epoch = addMessage({
      folderId,
      messageId: "date-flag-epoch@invalid",
      date: "1970-01-01T12:00:00Z",
      flags: initialFlags,
      tags: "snapshot-before",
    });
    const excluded = addMessage({
      folderId,
      messageId: "date-flag-excluded@invalid",
      date: "2041-01-15T12:00:00Z",
      flags: initialFlags,
      tags: "snapshot-before",
    });
    const threads = new Map(
      readStoredRows(
        "SELECT id, threadId FROM messages WHERE folderId = " + folderId,
        ["id", "threadId"]
      )
    );
    Assert.equal(threads.size, 3);
    for (const thread of threads.values()) {
      Assert.ok(thread > 0 && thread < 0xffffffff);
    }
    messageDB.getMessage(target).flags = finalFlags;
    messageDB.getMessage(epoch).flags = finalFlags;
    messageDB.getMessage(excluded).flags = finalFlags;
    Assert.deepEqual(events, [
      [
        "added",
        target,
        targetDate,
        threads.get(target),
        initialFlags,
        "snapshot-before",
        null,
      ],
      [
        "flags",
        target,
        targetDate,
        threads.get(target),
        finalFlags,
        "snapshot-before",
        initialFlags,
      ],
    ]);
    Assert.deepEqual(epochEvents, [
      [
        "added",
        epoch,
        epochDate,
        threads.get(epoch),
        initialFlags,
        "snapshot-before",
        null,
      ],
      [
        "flags",
        epoch,
        epochDate,
        threads.get(epoch),
        finalFlags,
        "snapshot-before",
        initialFlags,
      ],
    ]);
    Assert.equal(await view.countMessages(), baseline + 1);
    Assert.equal(await epochView.countMessages(), epochBaseline + 1);
    const keys = [target, epoch, excluded];
    Assert.deepEqual(
      Array.from(await view.selectMessages(), message => message.id).filter(
        key => keys.includes(key)
      ),
      [target]
    );
    Assert.deepEqual(
      Array.from(
        await epochView.selectMessages(),
        message => message.id
      ).filter(key => keys.includes(key)),
      [epoch]
    );
    Assert.deepEqual(
      readStoredRows(
        "SELECT id, folderId, date, threadId, flags, tags FROM messages " +
          "WHERE folderId = " +
          folderId +
          " ORDER BY id",
        ["id", "folderId", "date", "threadId", "flags", "tags"]
      ),
      [
        [
          target,
          folderId,
          targetDate * 1000,
          threads.get(target),
          finalFlags,
          "snapshot-before",
        ],
        [
          epoch,
          folderId,
          epochDate * 1000,
          threads.get(epoch),
          finalFlags,
          "snapshot-before",
        ],
        [
          excluded,
          folderId,
          excludedDate * 1000,
          threads.get(excluded),
          finalFlags,
          "snapshot-before",
        ],
      ].sort((a, b) => a[0] - b[0]),
      "Committed dates, folders and thread identities survive the mutation"
    );
  } finally {
    view.clearListener();
    epochView.clearListener();
  }
});

add_task(async function test_tagChangesRetainDateMembership() {
  const root = folderDB.insertRoot("delivery-date-snapshot-tag");
  const folderId = folderDB.insertFolder(root, "Inbox");
  const targetDate = Date.UTC(2042, 0, 15, 12);
  const epochDate = Date.UTC(1970, 0, 1, 12);
  const excludedDate = Date.UTC(2043, 0, 15, 12);
  const initialFlags = Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked;
  const finalFlags = Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked;
  const view = Cc["@mozilla.org/mailnews/live-view;1"].createInstance(
    Ci.nsILiveView
  );
  view.initWithDateRange(
    Date.UTC(2042, 0, 1) * 1000,
    Date.UTC(2042, 1, 1) * 1000
  );
  const epochView = Cc["@mozilla.org/mailnews/live-view;1"].createInstance(
    Ci.nsILiveView
  );
  epochView.initWithDateRange(
    Date.UTC(1969, 11, 31) * 1000,
    Date.UTC(1970, 0, 2) * 1000
  );
  const events = recordSnapshotEvents(view);
  const epochEvents = recordSnapshotEvents(epochView);
  try {
    const baseline = await view.countMessages();
    const epochBaseline = await epochView.countMessages();
    const target = addMessage({
      folderId,
      messageId: "date-tag-target@invalid",
      date: "2042-01-15T12:00:00Z",
      flags: initialFlags,
      tags: "snapshot-before",
    });
    const epoch = addMessage({
      folderId,
      messageId: "date-tag-epoch@invalid",
      date: "1970-01-01T12:00:00Z",
      flags: initialFlags,
      tags: "snapshot-before",
    });
    const excluded = addMessage({
      folderId,
      messageId: "date-tag-excluded@invalid",
      date: "2043-01-15T12:00:00Z",
      flags: initialFlags,
      tags: "snapshot-before",
    });
    const threads = new Map(
      readStoredRows(
        "SELECT id, threadId FROM messages WHERE folderId = " + folderId,
        ["id", "threadId"]
      )
    );
    Assert.equal(threads.size, 3);
    for (const thread of threads.values()) {
      Assert.ok(thread > 0 && thread < 0xffffffff);
    }
    messageDB
      .getMessage(target)
      .setStringProperty("keywords", "snapshot-after");
    messageDB.getMessage(epoch).setStringProperty("keywords", "snapshot-after");
    messageDB
      .getMessage(excluded)
      .setStringProperty("keywords", "snapshot-after");
    Assert.deepEqual(events, [
      [
        "added",
        target,
        targetDate,
        threads.get(target),
        initialFlags,
        "snapshot-before",
        null,
      ],
      [
        "tags",
        target,
        targetDate,
        threads.get(target),
        finalFlags,
        "snapshot-after",
        "snapshot-before",
      ],
    ]);
    Assert.deepEqual(epochEvents, [
      [
        "added",
        epoch,
        epochDate,
        threads.get(epoch),
        initialFlags,
        "snapshot-before",
        null,
      ],
      [
        "tags",
        epoch,
        epochDate,
        threads.get(epoch),
        finalFlags,
        "snapshot-after",
        "snapshot-before",
      ],
    ]);
    Assert.equal(await view.countMessages(), baseline + 1);
    Assert.equal(await epochView.countMessages(), epochBaseline + 1);
    const keys = [target, epoch, excluded];
    Assert.deepEqual(
      Array.from(await view.selectMessages(), message => message.id).filter(
        key => keys.includes(key)
      ),
      [target]
    );
    Assert.deepEqual(
      Array.from(
        await epochView.selectMessages(),
        message => message.id
      ).filter(key => keys.includes(key)),
      [epoch]
    );
    Assert.deepEqual(
      readStoredRows(
        "SELECT id, folderId, date, threadId, flags, tags FROM messages " +
          "WHERE folderId = " +
          folderId +
          " ORDER BY id",
        ["id", "folderId", "date", "threadId", "flags", "tags"]
      ),
      [
        [
          target,
          folderId,
          targetDate * 1000,
          threads.get(target),
          finalFlags,
          "snapshot-after",
        ],
        [
          epoch,
          folderId,
          epochDate * 1000,
          threads.get(epoch),
          finalFlags,
          "snapshot-after",
        ],
        [
          excluded,
          folderId,
          excludedDate * 1000,
          threads.get(excluded),
          finalFlags,
          "snapshot-after",
        ],
      ].sort((a, b) => a[0] - b[0]),
      "Committed dates, folders and thread identities survive the mutation"
    );
  } finally {
    view.clearListener();
    epochView.clearListener();
  }
});

add_task(async function test_flagChangesRetainConversationMembership() {
  const root = folderDB.insertRoot("delivery-thread-snapshot-flag");
  const folderId = folderDB.insertFolder(root, "Inbox");
  const otherFolder = folderDB.insertFolder(root, "Other");
  const date = Date.UTC(2028, 0, 15, 12);
  const initialFlags = Ci.nsMsgMessageFlags.Marked;
  const finalFlags = Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked;
  const parent = addMessage({
    folderId,
    messageId: "thread-flag-root@invalid",
    date: "2028-01-15T12:00:00Z",
    flags: initialFlags,
    tags: "snapshot-before",
  });
  const threadRows = readStoredRows(
    "SELECT threadId FROM messages WHERE id = " + parent,
    ["threadId"]
  );
  Assert.equal(threadRows.length, 1);
  const thread = threadRows[0][0];
  Assert.ok(thread > 0 && thread < 0xffffffff);
  const view = Cc["@mozilla.org/mailnews/live-view;1"].createInstance(
    Ci.nsILiveView
  );
  view.initWithConversation(thread);
  const events = recordSnapshotEvents(view);
  try {
    Assert.equal(await view.countMessages(), 1);
    const reply = addMessage({
      folderId: otherFolder,
      messageId: "thread-flag-reply@invalid",
      references: ["thread-flag-root@invalid"],
      date: "2028-01-15T12:00:00Z",
      flags: initialFlags,
      tags: "snapshot-before",
    });
    const excluded = addMessage({
      folderId: otherFolder,
      messageId: "thread-flag-excluded@invalid",
      date: "2028-01-15T12:00:00Z",
      flags: initialFlags,
      tags: "snapshot-before",
    });
    const excludedRows = readStoredRows(
      "SELECT threadId FROM messages WHERE id = " + excluded,
      ["threadId"]
    );
    Assert.equal(excludedRows.length, 1);
    const excludedThread = excludedRows[0][0];
    Assert.ok(excludedThread > 0 && excludedThread < 0xffffffff);
    Assert.notEqual(excludedThread, thread);
    messageDB.getMessage(parent).flags = finalFlags;
    messageDB.getMessage(reply).flags = finalFlags;
    messageDB.getMessage(excluded).flags = finalFlags;
    Assert.deepEqual(events, [
      ["added", reply, date, thread, initialFlags, "snapshot-before", null],
      [
        "flags",
        parent,
        date,
        thread,
        finalFlags,
        "snapshot-before",
        initialFlags,
      ],
      [
        "flags",
        reply,
        date,
        thread,
        finalFlags,
        "snapshot-before",
        initialFlags,
      ],
    ]);
    Assert.equal(await view.countMessages(), 2);
    Assert.deepEqual(
      Array.from(await view.selectMessages(), message => message.id).sort(
        (a, b) => a - b
      ),
      [parent, reply].sort((a, b) => a - b),
      "The conversation contains both folders and excludes the other thread"
    );
    Assert.deepEqual(
      readStoredRows(
        "SELECT id, folderId, threadId, threadParent, date, flags, tags " +
          "FROM messages WHERE folderId IN (" +
          folderId +
          ", " +
          otherFolder +
          ") ORDER BY id",
        ["id", "folderId", "threadId", "threadParent", "date", "flags", "tags"]
      ),
      [
        [
          parent,
          folderId,
          thread,
          0,
          date * 1000,
          finalFlags,
          "snapshot-before",
        ],
        [
          reply,
          otherFolder,
          thread,
          parent,
          date * 1000,
          finalFlags,
          "snapshot-before",
        ],
        [
          excluded,
          otherFolder,
          excludedThread,
          0,
          date * 1000,
          finalFlags,
          "snapshot-before",
        ],
      ].sort((a, b) => a[0] - b[0]),
      "SQL retains shared thread identity, parent, date and folder bindings"
    );
  } finally {
    view.clearListener();
  }
});

add_task(async function test_tagChangesRetainConversationMembership() {
  const root = folderDB.insertRoot("delivery-thread-snapshot-tag");
  const folderId = folderDB.insertFolder(root, "Inbox");
  const otherFolder = folderDB.insertFolder(root, "Other");
  const date = Date.UTC(2028, 0, 15, 12);
  const initialFlags = Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked;
  const finalFlags = Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked;
  const parent = addMessage({
    folderId,
    messageId: "thread-tag-root@invalid",
    date: "2028-01-15T12:00:00Z",
    flags: initialFlags,
    tags: "snapshot-before",
  });
  const threadRows = readStoredRows(
    "SELECT threadId FROM messages WHERE id = " + parent,
    ["threadId"]
  );
  Assert.equal(threadRows.length, 1);
  const thread = threadRows[0][0];
  Assert.ok(thread > 0 && thread < 0xffffffff);
  const view = Cc["@mozilla.org/mailnews/live-view;1"].createInstance(
    Ci.nsILiveView
  );
  view.initWithConversation(thread);
  const events = recordSnapshotEvents(view);
  try {
    Assert.equal(await view.countMessages(), 1);
    const reply = addMessage({
      folderId: otherFolder,
      messageId: "thread-tag-reply@invalid",
      references: ["thread-tag-root@invalid"],
      date: "2028-01-15T12:00:00Z",
      flags: initialFlags,
      tags: "snapshot-before",
    });
    const excluded = addMessage({
      folderId: otherFolder,
      messageId: "thread-tag-excluded@invalid",
      date: "2028-01-15T12:00:00Z",
      flags: initialFlags,
      tags: "snapshot-before",
    });
    const excludedRows = readStoredRows(
      "SELECT threadId FROM messages WHERE id = " + excluded,
      ["threadId"]
    );
    Assert.equal(excludedRows.length, 1);
    const excludedThread = excludedRows[0][0];
    Assert.ok(excludedThread > 0 && excludedThread < 0xffffffff);
    Assert.notEqual(excludedThread, thread);
    messageDB
      .getMessage(parent)
      .setStringProperty("keywords", "snapshot-after");
    messageDB.getMessage(reply).setStringProperty("keywords", "snapshot-after");
    messageDB
      .getMessage(excluded)
      .setStringProperty("keywords", "snapshot-after");
    Assert.deepEqual(events, [
      ["added", reply, date, thread, initialFlags, "snapshot-before", null],
      [
        "tags",
        parent,
        date,
        thread,
        finalFlags,
        "snapshot-after",
        "snapshot-before",
      ],
      [
        "tags",
        reply,
        date,
        thread,
        finalFlags,
        "snapshot-after",
        "snapshot-before",
      ],
    ]);
    Assert.equal(await view.countMessages(), 2);
    Assert.deepEqual(
      Array.from(await view.selectMessages(), message => message.id).sort(
        (a, b) => a - b
      ),
      [parent, reply].sort((a, b) => a - b),
      "The conversation contains both folders and excludes the other thread"
    );
    Assert.deepEqual(
      readStoredRows(
        "SELECT id, folderId, threadId, threadParent, date, flags, tags " +
          "FROM messages WHERE folderId IN (" +
          folderId +
          ", " +
          otherFolder +
          ") ORDER BY id",
        ["id", "folderId", "threadId", "threadParent", "date", "flags", "tags"]
      ),
      [
        [
          parent,
          folderId,
          thread,
          0,
          date * 1000,
          finalFlags,
          "snapshot-after",
        ],
        [
          reply,
          otherFolder,
          thread,
          parent,
          date * 1000,
          finalFlags,
          "snapshot-after",
        ],
        [
          excluded,
          otherFolder,
          excludedThread,
          0,
          date * 1000,
          finalFlags,
          "snapshot-after",
        ],
      ].sort((a, b) => a[0] - b[0]),
      "SQL retains shared thread identity, parent, date and folder bindings"
    );
  } finally {
    view.clearListener();
  }
});
