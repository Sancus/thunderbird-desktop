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

add_task(async function test_nativeInsertAfterMigrationKeepsItsOwnBindings() {
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
      "native-after-migration"
    );
  PanoramaDelivery.assertFolder(folder, lane);
  Assert.equal(database.connectionForTests.databaseFile.path, dbFile.path);
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
      stored: [...imported, ["native-after@invalid", "Native after migration"]],
    },
    "Native insertion uses its complete SQL shape without changing imported rows"
  );
});
