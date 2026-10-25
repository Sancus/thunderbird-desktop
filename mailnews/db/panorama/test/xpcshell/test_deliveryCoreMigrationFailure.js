/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

let dbFile;

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

const { ProfileCreator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ProfileCreator.sys.mjs"
);

add_task(
  async function test_failedMigrationReleasesTransactionBeforeNativeAdd() {
    dbFile = do_get_profile().clone();
    dbFile.append("panorama.sqlite");
    Assert.ok(!dbFile.exists(), "DatabaseCore must create the schema");
    const profile = new ProfileCreator(do_get_profile());
    const server = profile.addLocalServer();
    await server.rootFolder.addMailFolder("migration-failure", {
      summary: do_get_file("data/migration.msf"),
      mbox: do_get_file("data/migration"),
    });
    loadExistingDB();
    const lane = PanoramaDelivery.expectedLane();
    Assert.deepEqual(lane, { backend: "panorama", store: "mbox" });
    Assert.equal(
      PanoramaDelivery.assertBackend(lane.backend).QueryInterface(
        Ci.nsIDatabaseCore
      ),
      database
    );
    const folder =
      MailServices.accounts.localFoldersServer.rootFolder.getChildNamed(
        "migration-failure"
      );
    PanoramaDelivery.assertFolder(folder, lane);
    const connection = database.connectionForTests;
    Assert.equal(connection.databaseFile.path, dbFile.path);
    const controlId = addMessage({
      folderId: folder.id,
      messageId: "control@invalid",
      subject: "Committed control",
    });
    const control = messageDB.getMessage(controlId);
    const sql = "SELECT messageId, subject FROM messages ORDER BY messageId";
    const columns = ["messageId", "subject"];
    Assert.deepEqual(readStoredRows(sql, columns), [
      ["control@invalid", "Committed control"],
    ]);

    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER delivery_fail_migration BEFORE UPDATE OF threadId " +
        "ON messages WHEN NEW.messageId = '162378@invalid' " +
        "BEGIN SELECT RAISE(ABORT, 'delivery core migration failure'); END"
    );
    registerCleanupFunction(() =>
      connection.executeSimpleSQL(
        "DROP TRIGGER IF EXISTS delivery_fail_migration"
      )
    );
    let rejection = null;
    try {
      await database.migrateFolderDatabase(folder);
    } catch (error) {
      rejection = { name: error?.name, message: error?.message };
    }
    const afterFailure = {
      rejection,
      transactionOpen: connection.transactionInProgress,
      count: messageDB.totalCount,
      stored: readStoredRows(sql, columns),
      properties: readStoredRows(
        "SELECT COUNT(*) AS count FROM message_properties",
        ["count"]
      ),
      controlSubject: control.subject,
    };
    connection.executeSimpleSQL("DROP TRIGGER delivery_fail_migration");

    let nativeError = null;
    let nativeId;
    try {
      nativeId = addMessage({
        folderId: folder.id,
        messageId: "native@invalid",
        subject: "Native after failed migration",
        priority: Ci.nsMsgPriority.high,
      });
    } catch (error) {
      nativeError = error.result;
    }
    // A different rejection means this fault point is stale, not broken rollback.
    Assert.deepEqual(
      afterFailure,
      {
        rejection: {
          name: "UnknownError",
          message:
            "Folder migration SQL failed: delivery core migration failure",
        },
        transactionOpen: false,
        count: 1,
        stored: [["control@invalid", "Committed control"]],
        properties: [[0]],
        controlSubject: "Committed control",
      },
      "A reached late migration failure ends its transaction and preserves the control"
    );
    Assert.equal(nativeError, null, "A subsequent native add succeeds");
    Assert.ok(nativeId > 0);
    Assert.notEqual(nativeId, controlId);
    Assert.deepEqual(
      {
        transactionOpen: connection.transactionInProgress,
        count: messageDB.totalCount,
        subject: messageDB.getMessage(nativeId).subject,
        priority: messageDB.getMessage(nativeId).priority,
        controlSubject: control.subject,
        stored: readStoredRows(sql, columns),
      },
      {
        transactionOpen: false,
        count: 2,
        subject: "Native after failed migration",
        priority: Ci.nsMsgPriority.high,
        controlSubject: "Committed control",
        stored: [
          ["control@invalid", "Committed control"],
          ["native@invalid", "Native after failed migration"],
        ],
      },
      "Native metadata is independently committed after the failed import"
    );
  }
);
