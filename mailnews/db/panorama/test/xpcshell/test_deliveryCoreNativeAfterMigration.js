/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

let dbFile;
let folder;

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

add_setup(async function () {
  dbFile = do_get_profile().clone();
  dbFile.append("panorama.sqlite");
  Assert.ok(!dbFile.exists(), "DatabaseCore must create the schema");
  const profile = new ProfileCreator(do_get_profile());
  const server = profile.addLocalServer();
  await server.rootFolder.addMailFolder("native-after-migration", {
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
  folder = MailServices.accounts.localFoldersServer.rootFolder.getChildNamed(
    "native-after-migration"
  );
  PanoramaDelivery.assertFolder(folder, lane);
  Assert.equal(database.connectionForTests.databaseFile.path, dbFile.path);
});

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_nativeInsertAfterMigrationKeepsItsOwnBindings() {
    await database.migrateFolderDatabase(folder);

    const sql = "SELECT messageId, subject FROM messages ORDER BY messageId";
    const columns = ["messageId", "subject"];
    const imported = [
      ["162378@invalid", "Secured value-added orchestration"],
      ["345692@invalid", "Intuitive full-range analyzer"],
    ];
    Assert.deepEqual(readStoredRows(sql, columns), imported);
    const id = addMessage({
      folderId: folder.id,
      messageId: "native-after@invalid",
      sender: "Native sender",
      recipients: "Native recipient",
      ccList: "Native cc",
      bccList: "Native bcc",
      subject: "Native after migration",
      priority: Ci.nsMsgPriority.high,
    });
    const header = messageDB.getMessage(id);
    Assert.deepEqual(
      {
        messageId: header.messageId,
        author: header.author,
        recipients: header.recipients,
        ccList: header.ccList,
        bccList: header.bccList,
        subject: header.subject,
        priority: header.priority,
        count: messageDB.totalCount,
        nativeStored: readStoredRows(
          "SELECT id, folderId, priority FROM messages WHERE id = " + id,
          ["id", "folderId", "priority"]
        ),
        stored: readStoredRows(sql, columns),
      },
      {
        messageId: "native-after@invalid",
        author: "Native sender",
        recipients: "Native recipient",
        ccList: "Native cc",
        bccList: "Native bcc",
        subject: "Native after migration",
        priority: Ci.nsMsgPriority.high,
        count: 3,
        nativeStored: [[id, folder.id, Ci.nsMsgPriority.high]],
        stored: [
          ...imported,
          ["native-after@invalid", "Native after migration"],
        ],
      },
      "Native insertion uses its complete SQL shape without changing imported rows"
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function test_rawMigrationRequiresWindowsAdmissionBeforeNativeAdd() {
    const sourceSummary = await IOUtils.read(folder.summaryFile.path);
    const sourceBody = await IOUtils.read(folder.filePath.path);
    const connection = database.connectionForTests;
    const controlId = addMessage({
      folderId: folder.id,
      messageId: "windows-control@invalid",
      subject: "Committed Windows control",
    });
    const control = messageDB.getMessage(controlId);
    const sql =
      "SELECT id, folderId, messageId, subject FROM messages ORDER BY id";
    const columns = ["id", "folderId", "messageId", "subject"];
    const committed = [
      [
        controlId,
        folder.id,
        "windows-control@invalid",
        "Committed Windows control",
      ],
    ];
    Assert.deepEqual(readStoredRows(sql, columns), committed);
    Assert.ok(!connection.transactionInProgress);

    Assert.throws(
      () => database.migrateFolderDatabase(folder),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
      "Raw migration refuses synchronously without the original Windows admission"
    );
    Assert.ok(!connection.transactionInProgress);
    Assert.equal(messageDB.totalCount, 1);
    Assert.equal(control.subject, "Committed Windows control");
    Assert.deepEqual(readStoredRows(sql, columns), committed);
    Assert.deepEqual(
      readStoredRows("SELECT COUNT(*) AS count FROM message_properties", [
        "count",
      ]),
      [[0]]
    );
    Assert.deepEqual(
      readStoredRows(
        "SELECT value FROM folder_properties WHERE id = " +
          folder.id +
          " AND name = 'morkMigrationSource'",
        ["value"]
      ),
      []
    );
    Assert.deepEqual(
      await IOUtils.read(folder.summaryFile.path),
      sourceSummary
    );
    Assert.deepEqual(await IOUtils.read(folder.filePath.path), sourceBody);

    const nativeId = addMessage({
      folderId: folder.id,
      messageId: "windows-native@invalid",
      sender: "Windows native sender",
      recipients: "Windows native recipient",
      ccList: "Windows native cc",
      bccList: "Windows native bcc",
      subject: "Native after Windows refusal",
      priority: Ci.nsMsgPriority.high,
    });
    const native = messageDB.getMessage(nativeId);
    Assert.greater(nativeId, 0);
    Assert.notEqual(nativeId, controlId);
    Assert.ok(!connection.transactionInProgress);
    Assert.equal(messageDB.totalCount, 2);
    Assert.deepEqual(
      [
        native.messageId,
        native.author,
        native.recipients,
        native.ccList,
        native.bccList,
        native.subject,
        native.priority,
      ],
      [
        "windows-native@invalid",
        "Windows native sender",
        "Windows native recipient",
        "Windows native cc",
        "Windows native bcc",
        "Native after Windows refusal",
        Ci.nsMsgPriority.high,
      ]
    );
    Assert.deepEqual(readStoredRows(sql, columns), [
      ...committed,
      [
        nativeId,
        folder.id,
        "windows-native@invalid",
        "Native after Windows refusal",
      ],
    ]);
    Assert.deepEqual(
      await IOUtils.read(folder.summaryFile.path),
      sourceSummary
    );
    Assert.deepEqual(await IOUtils.read(folder.filePath.path), sourceBody);
  }
);
