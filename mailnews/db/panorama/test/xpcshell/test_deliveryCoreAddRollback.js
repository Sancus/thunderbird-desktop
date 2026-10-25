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

add_task(async function test_failedAddLeavesNoMessageOrPublication() {
  const root = folderDB.insertRoot("delivery-rollback");
  const folderId = folderDB.insertFolder(root, "Inbox");
  const view = Cc["@mozilla.org/mailnews/live-view;1"].createInstance(
    Ci.nsILiveView
  );
  view.initWithFolder(folderId);
  registerCleanupFunction(() => view.clearListener());
  const events = [];
  view.setListener({
    onMessageAdded(message) {
      events.push(message.id);
    },
    onMessageRemoved(message) {
      events.push(["removed", message.id]);
    },
    onMessageFlagsChanged(message) {
      events.push(["flags", message.id]);
    },
    onMessageTagsChanged(message) {
      events.push(["tags", message.id]);
    },
    onSelectedChunk() {},
  });
  const connection = database.connectionForTests;
  const controlId = addMessage({
    folderId,
    messageId: "control@example.invalid",
    sender: "Control sender",
    subject: "Committed control",
  });
  const control = messageDB.getMessage(controlId);
  const controlThreadId = control.threadId;
  Assert.ok(controlThreadId > 0, "The control has a thread identity");
  const sql =
    "SELECT id, messageId, sender, subject, threadId, threadParent " +
    "FROM messages ORDER BY id";
  const columns = [
    "id",
    "messageId",
    "sender",
    "subject",
    "threadId",
    "threadParent",
  ];
  const controlRow = [
    controlId,
    "control@example.invalid",
    "Control sender",
    "Committed control",
    controlThreadId,
    0,
  ];
  const controlState = {
    messageId: "control@example.invalid",
    author: "Control sender",
    subject: "Committed control",
    threadId: controlThreadId,
    threadParent: 0,
  };
  Assert.deepEqual(
    readStoredRows(sql, columns),
    [controlRow],
    "The control is independently committed before installing the fault"
  );
  Assert.ok(!connection.transactionInProgress);

  let faults = 0;
  let failedId = 0;
  connection.createFunction("delivery_record_add_failure", 1, {
    onFunctionCall(args) {
      faults++;
      failedId = args.getInt64(0);
      return 0;
    },
  });
  registerCleanupFunction(() =>
    connection.removeFunction("delivery_record_add_failure")
  );
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER delivery_fail_add BEFORE UPDATE OF threadId " +
      "ON messages WHEN NEW.messageId = 'failed@example.invalid' " +
      "BEGIN SELECT delivery_record_add_failure(NEW.id); " +
      "SELECT RAISE(ABORT, 'delivery core add failure'); END"
  );
  registerCleanupFunction(() =>
    connection.executeSimpleSQL("DROP TRIGGER IF EXISTS delivery_fail_add")
  );
  // A missing exception means this injection point is stale, not broken rollback.
  Assert.throws(
    () => addMessage({ folderId, messageId: "failed@example.invalid" }),
    /NS_ERROR_STORAGE_CONSTRAINT/,
    "The fault fixture raises the expected storage constraint"
  );
  Assert.equal(faults, 1, "The operation reached the intended later write");
  Assert.ok(failedId > 0);
  Assert.notEqual(failedId, controlId);
  Assert.throws(
    () => messageDB.getMessage(failedId).messageId,
    /NS_ERROR_UNEXPECTED/,
    "The failed key has no readable row or cached header before retry"
  );

  const afterFailure = {
    count: messageDB.totalCount,
    selected: (await view.selectMessages())
      .map(message => message.id)
      .toSorted((left, right) => left - right),
    stored: readStoredRows(sql, columns),
    control: {
      messageId: control.messageId,
      author: control.author,
      subject: control.subject,
      threadId: control.threadId,
      threadParent: control.threadParent,
    },
    events: [...events],
    transactionOpen: connection.transactionInProgress,
  };
  connection.executeSimpleSQL("DROP TRIGGER delivery_fail_add");
  const retryId = addMessage({
    folderId,
    messageId: "failed@example.invalid",
    references: ["control@example.invalid"],
    sender: "Retry sender",
    subject: "Retried message",
  });
  const retried = messageDB.getMessage(retryId);
  const afterRetry = {
    count: messageDB.totalCount,
    selected: (await view.selectMessages())
      .map(message => message.id)
      .toSorted((left, right) => left - right),
    stored: readStoredRows(sql, columns),
    control: {
      messageId: control.messageId,
      author: control.author,
      subject: control.subject,
      threadId: control.threadId,
      threadParent: control.threadParent,
    },
    retried: {
      messageId: retried.messageId,
      author: retried.author,
      subject: retried.subject,
      threadId: retried.threadId,
      threadParent: retried.threadParent,
    },
    events: [...events],
  };
  Assert.deepEqual(
    { afterFailure, afterRetry },
    {
      afterFailure: {
        count: 1,
        selected: [controlId],
        stored: [controlRow],
        control: controlState,
        events: [controlId],
        transactionOpen: false,
      },
      afterRetry: {
        count: 2,
        selected: [controlId, retryId].toSorted((left, right) => left - right),
        stored: [
          controlRow,
          [
            retryId,
            "failed@example.invalid",
            "Retry sender",
            "Retried message",
            controlThreadId,
            controlId,
          ],
        ].sort((left, right) => left[0] - right[0]),
        control: controlState,
        retried: {
          messageId: "failed@example.invalid",
          author: "Retry sender",
          subject: "Retried message",
          threadId: controlThreadId,
          threadParent: controlId,
        },
        events: [controlId, retryId],
      },
    },
    "Only the failed add rolls back; control and retry headers match committed rows"
  );
});
