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

add_task(function test_referenceLookupErrorDoesNotBecomeAbsence() {
  const root = folderDB.insertRoot("delivery-reference-error");
  const folderId = folderDB.insertFolder(root, "Inbox");
  const controlId = addMessage({
    folderId,
    messageId: "reference-control@invalid",
    subject: "Committed control",
  });
  const control = messageDB.getMessage(controlId);
  const threadId = control.threadId;
  Assert.greater(threadId, 0);
  // Observe raw rows without requiring an account-backed nsIMsgFolder.
  const view = Cc["@mozilla.org/mailnews/live-view;1"].createInstance(
    Ci.nsILiveView
  );
  registerCleanupFunction(() => view.clearListener());
  const events = [];
  view.setListener({
    onMessageAdded(message) {
      events.push(message.id);
    },
    onMessageRemoved() {},
    onMessageFlagsChanged() {},
    onMessageTagsChanged() {},
    onSelectedChunk() {},
  });
  const connection = database.connectionForTests;
  const sql = "SELECT id, messageId, subject FROM messages ORDER BY id";
  const columns = ["id", "messageId", "subject"];
  Assert.deepEqual(readStoredRows(sql, columns), [
    [controlId, "reference-control@invalid", "Committed control"],
  ]);
  let faults = 0;
  connection.setProgressHandler(1, {
    onProgress() {
      if (faults == 0) {
        faults++;
        return true;
      }
      return false;
    },
  });
  registerCleanupFunction(() => connection.removeProgressHandler());
  // Reference resolution is the first SQL work, before the owning write begins.
  let failure = null;
  try {
    addMessage({
      folderId,
      messageId: "reference-retry@invalid",
      references: ["reference-control@invalid"],
    });
  } catch (error) {
    failure = error;
  }
  connection.removeProgressHandler();
  const afterFailure = {
    faults,
    failure: failure ? failure.result : null,
    count: messageDB.totalCount,
    transactionOpen: connection.transactionInProgress,
    stored: readStoredRows(sql, columns),
    controlSubject: control.subject,
    events: [...events],
  };
  const retryId = addMessage({
    folderId,
    messageId: "reference-retry@invalid",
    references: ["reference-control@invalid"],
    subject: "Successful retry",
  });
  const retry = messageDB.getMessage(retryId);
  Assert.deepEqual(
    {
      afterFailure,
      count: messageDB.totalCount,
      stored: readStoredRows(sql, columns),
      threadId: retry.threadId,
      parent: retry.threadParent,
      events,
    },
    {
      afterFailure: {
        faults: 1,
        failure: Cr.NS_ERROR_ABORT,
        count: 1,
        transactionOpen: false,
        stored: [[controlId, "reference-control@invalid", "Committed control"]],
        controlSubject: "Committed control",
        events: [],
      },
      count: 2,
      stored: [
        [controlId, "reference-control@invalid", "Committed control"],
        [retryId, "reference-retry@invalid", "Successful retry"],
      ],
      threadId,
      parent: controlId,
      events: [retryId],
    },
    "A lookup error preserves committed state and permits an independent retry"
  );
});
