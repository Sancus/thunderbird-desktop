/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

const { ProfileCreator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ProfileCreator.sys.mjs"
);

/**
 * Reads committed identities and body locations on a separate connection.
 *
 * @param {number} folderId - The Panorama folder to read.
 * @returns {Array<Array<number|string|null>>} Rows of keys, IDs, tokens,
 *   and sizes.
 */
function readStoredMessages(folderId) {
  const dbFile = do_get_profile();
  dbFile.append("panorama.sqlite");
  const reader = Services.storage.openUnsharedDatabase(dbFile);
  try {
    const statement = reader.createStatement(
      "SELECT m.id, m.messageId, " +
        "(SELECT CAST(value AS TEXT) FROM message_properties " +
        "WHERE id = m.id AND name = 'storeToken') AS token, " +
        "(SELECT value FROM message_properties " +
        "WHERE id = m.id AND name = 'messageSize') AS size " +
        "FROM messages m WHERE m.folderId = :folderId ORDER BY m.messageId"
    );
    try {
      statement.params.folderId = folderId;
      const rows = [];
      while (statement.executeStep()) {
        rows.push([
          statement.row.id,
          statement.row.messageId,
          statement.row.token,
          statement.row.size,
        ]);
      }
      return rows;
    } finally {
      statement.finalize();
    }
  } finally {
    reader.close();
  }
}

add_task(async function test_repeatUnchangedSourceAfterSuccessfulImport() {
  const profile = new ProfileCreator(do_get_profile());
  const server = profile.addLocalServer();
  const files = await server.rootFolder.addMailFolder("repeatAfterSuccess", {
    summary: do_get_file("data/migration.msf"),
    mbox: do_get_file("data/migration"),
  });
  const originalMbox = await IOUtils.read(files.mailFilePath);
  loadExistingDB();
  MailServices.accounts.accounts;
  const lane = PanoramaDelivery.expectedLane();
  Assert.deepEqual(lane, { backend: "panorama", store: "mbox" });
  const selectedDatabase = PanoramaDelivery.assertBackend(
    lane.backend
  ).QueryInterface(Ci.nsIDatabaseCore);
  Assert.equal(
    selectedDatabase,
    database,
    "The selected message database service is Panorama"
  );
  const rootFolder = MailServices.accounts.localFoldersServer.rootFolder;
  const folder = rootFolder.getChildNamed("repeatAfterSuccess");
  PanoramaDelivery.assertFolder(folder, lane);
  Assert.equal(folder.getTotalMessages(false), 0);

  await database.migrateFolderDatabase(folder);
  const first = readStoredMessages(folder.id);
  Assert.deepEqual(
    first.map(([, ...fields]) => fields),
    [
      ["162378@invalid", "0", 0x242],
      ["345692@invalid", "1143", 0x177],
    ],
    "The first migration commits exactly the live messages and body locations"
  );
  // The unchanged source must resolve again without changing imported data.
  await database.migrateFolderDatabase(folder);
  Assert.deepEqual(
    readStoredMessages(folder.id),
    first,
    "Repeating migration preserves committed keys without duplicate rows"
  );
  Assert.deepEqual(
    Array.from(folder.messages, message => [
      message.messageKey,
      message.messageId,
      message.storeToken,
      message.messageSize,
    ]).toSorted((a, b) => a[1].localeCompare(b[1])),
    first,
    "Folder enumeration agrees with stored data after repeat-after-success"
  );
  Assert.deepEqual(
    await IOUtils.read(files.mailFilePath),
    originalMbox,
    "Both migration calls preserve the original mbox bytes"
  );
});
