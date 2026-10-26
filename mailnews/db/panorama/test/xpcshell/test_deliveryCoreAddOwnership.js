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

add_task(function test_rejectAddInsideForeignTransaction() {
  const root = folderDB.insertRoot("delivery-add-owner");
  const folderId = folderDB.insertFolder(root, "Inbox");
  const controlId = addMessage({
    folderId,
    messageId: "control-owner@invalid",
    subject: "Committed control",
  });
  const control = messageDB.getMessage(controlId);
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
    [controlId, "control-owner@invalid", "Committed control"],
  ]);

  connection.beginTransaction();
  registerCleanupFunction(() => {
    if (connection.transactionInProgress) {
      connection.rollbackTransaction();
    }
  });
  connection.executeSimpleSQL(
    "UPDATE messages SET subject = 'Foreign pending' WHERE id = " + controlId
  );
  let failure = null;
  try {
    addMessage({ folderId, messageId: "must-not-publish@invalid" });
  } catch (error) {
    failure = error.result;
  }
  const statement = connection.createStatement(
    "SELECT subject FROM messages WHERE id = " + controlId
  );
  let pendingSubject;
  try {
    Assert.ok(statement.executeStep());
    pendingSubject = statement.row.subject;
  } finally {
    statement.finalize();
  }
  const afterAttempt = {
    failure,
    transactionOpen: connection.transactionInProgress,
    pendingSubject,
    count: messageDB.totalCount,
    stored: readStoredRows(sql, columns),
    events: [...events],
  };
  // End the fixture's transaction only after capturing the ownership evidence.
  if (connection.transactionInProgress) {
    connection.rollbackTransaction();
  }
  const retryId = addMessage({
    folderId,
    messageId: "after-owner@invalid",
    subject: "Independent retry",
  });
  Assert.deepEqual(
    {
      afterAttempt,
      controlSubject: control.subject,
      count: messageDB.totalCount,
      stored: readStoredRows(sql, columns),
      events,
    },
    {
      afterAttempt: {
        failure: Cr.NS_ERROR_IN_PROGRESS,
        transactionOpen: true,
        pendingSubject: "Foreign pending",
        count: 1,
        stored: [[controlId, "control-owner@invalid", "Committed control"]],
        events: [],
      },
      controlSubject: "Committed control",
      count: 2,
      stored: [
        [controlId, "control-owner@invalid", "Committed control"],
        [retryId, "after-owner@invalid", "Independent retry"],
      ],
      events: [retryId],
    },
    "Rejected raw add neither commits nor rolls back unrelated work"
  );
});
