/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

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
  { skip_if: () => AppConstants.platform == "win" },
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
    MailServices.accounts.accounts;
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
    const sourceSummary = await IOUtils.read(folder.summaryFile.path);
    const sourceBody = await IOUtils.read(folder.filePath.path);
    const completionSQL =
      "SELECT value FROM folder_properties WHERE id = " +
      folder.id +
      " AND name = 'morkMigrationSource'";
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
      completion: readStoredRows(completionSQL, ["value"]),
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
        completion: [],
      },
      "A reached late migration failure ends its transaction and preserves the control"
    );
    Assert.equal(nativeError, null, "A subsequent native add succeeds");
    Assert.greater(nativeId, 0);
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

    Assert.strictEqual(
      await database.migrateFolderDatabase(folder),
      undefined,
      "Retry of the same genuine source succeeds after the failed savepoint ends"
    );
    const imported = [
      ["162378@invalid", "Secured value-added orchestration"],
      ["345692@invalid", "Intuitive full-range analyzer"],
    ];
    const afterRetry = [
      ...imported,
      ["control@invalid", "Committed control"],
      ["native@invalid", "Native after failed migration"],
    ];
    Assert.ok(!connection.transactionInProgress);
    Assert.equal(messageDB.totalCount, 4);
    Assert.deepEqual(readStoredRows(sql, columns), afterRetry);
    Assert.equal(control.subject, "Committed control");
    Assert.equal(
      messageDB.getMessage(nativeId).priority,
      Ci.nsMsgPriority.high
    );
    const propertySQL =
      "SELECT m.messageId, p.name, CAST(p.value AS TEXT) AS value " +
      "FROM message_properties p JOIN messages m ON m.id = p.id " +
      "WHERE m.folderId = " +
      folder.id +
      " ORDER BY m.messageId, p.name";
    const properties = [
      ["162378@invalid", "messageSize", "578"],
      ["162378@invalid", "storeToken", "0"],
      ["345692@invalid", "messageSize", "375"],
      ["345692@invalid", "storeToken", "1143"],
    ];
    Assert.deepEqual(
      readStoredRows(propertySQL, ["messageId", "name", "value"]),
      properties,
      "The actual retry commits each original body binding exactly once"
    );
    const completion = [
      ["v1:sha256:eiYgI7mP6WTRBd4Gvx3cpg+Q7hkHPjiv2oyIW+WkdwM="],
    ];
    Assert.deepEqual(readStoredRows(completionSQL, ["value"]), completion);
    const committedRows = readStoredRows(
      "SELECT id, folderId, messageId, subject, priority FROM messages ORDER BY id",
      ["id", "folderId", "messageId", "subject", "priority"]
    );
    Assert.equal(new Set(committedRows.map(row => row[0])).size, 4);
    Assert.ok(committedRows.every(row => row[0] > 0 && row[1] == folder.id));

    await database.migrateFolderDatabase(folder);
    Assert.ok(!connection.transactionInProgress);
    Assert.deepEqual(
      readStoredRows(
        "SELECT id, folderId, messageId, subject, priority FROM messages ORDER BY id",
        ["id", "folderId", "messageId", "subject", "priority"]
      ),
      committedRows,
      "The completed retry preserves its physical keys on another call"
    );
    Assert.deepEqual(readStoredRows(completionSQL, ["value"]), completion);
    Assert.deepEqual(
      readStoredRows(propertySQL, ["messageId", "name", "value"]),
      properties
    );

    const afterRetryId = addMessage({
      folderId: folder.id,
      messageId: "native-after-retry@invalid",
      sender: "Sender after migration retry",
      recipients: "Recipient after migration retry",
      ccList: "Cc after migration retry",
      bccList: "Bcc after migration retry",
      subject: "Native after migration retry",
      priority: Ci.nsMsgPriority.low,
    });
    Assert.ok(!connection.transactionInProgress);
    Assert.ok(!committedRows.some(row => row[0] == afterRetryId));
    const afterRetryHeader = messageDB.getMessage(afterRetryId);
    Assert.deepEqual(
      [
        afterRetryHeader.messageId,
        afterRetryHeader.author,
        afterRetryHeader.recipients,
        afterRetryHeader.ccList,
        afterRetryHeader.bccList,
        afterRetryHeader.subject,
        afterRetryHeader.priority,
      ],
      [
        "native-after-retry@invalid",
        "Sender after migration retry",
        "Recipient after migration retry",
        "Cc after migration retry",
        "Bcc after migration retry",
        "Native after migration retry",
        Ci.nsMsgPriority.low,
      ],
      "The native statement keeps its complete bindings after the migration retry"
    );
    Assert.equal(messageDB.totalCount, 5);
    Assert.deepEqual(readStoredRows(sql, columns), [
      ...imported,
      ["control@invalid", "Committed control"],
      ["native-after-retry@invalid", "Native after migration retry"],
      ["native@invalid", "Native after failed migration"],
    ]);
    Assert.deepEqual(readStoredRows(completionSQL, ["value"]), completion);
    Assert.deepEqual(
      await IOUtils.read(folder.summaryFile.path),
      sourceSummary
    );
    Assert.deepEqual(await IOUtils.read(folder.filePath.path), sourceBody);
  }
);
