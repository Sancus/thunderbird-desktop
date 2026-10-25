/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

const { ProfileCreator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ProfileCreator.sys.mjs"
);

add_task(async function test_preservesEmptyAndAbsentProperties() {
  const profile = new ProfileCreator(do_get_profile());
  const server = profile.addLocalServer();
  const files = await server.rootFolder.addMailFolder("presence", {
    summary: do_get_file("data/migration.msf"),
    mbox: do_get_file("data/migration"),
  });
  const summaryFile = Cc["@mozilla.org/file/local;1"].createInstance(
    Ci.nsIFile
  );
  summaryFile.initWithPath(files.summaryFilePath);
  const legacy = Cc["@mozilla.org/nsMsgDatabase/msgDB-mailbox"].createInstance(
    Ci.nsIMsgDatabase
  );
  registerCleanupFunction(() => legacy.close(false));
  legacy.openFromFile(summaryFile);
  legacy
    .getMsgHdrForMessageID("162378@invalid")
    .setStringProperty("deliveryMigrationEmpty", "");
  legacy.forceClosed();

  const reader = Cc["@mozilla.org/nsMsgDatabase/msgDB-mailbox"].createInstance(
    Ci.nsIMsgDatabase
  );
  registerCleanupFunction(() => reader.close(false));
  reader.openFromFile(summaryFile);
  const saved = reader.getMsgHdrForMessageID("162378@invalid");
  Assert.ok(saved.properties.includes("deliveryMigrationEmpty"));
  Assert.ok(!saved.properties.includes("deliveryMigrationAbsent"));
  Assert.equal(saved.getStringProperty("deliveryMigrationEmpty"), "");
  Assert.equal(saved.getStringProperty("deliveryMigrationAbsent"), "");
  reader.forceClosed();

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
  const folder = rootFolder.getChildNamed("presence");
  PanoramaDelivery.assertFolder(folder, lane);
  Assert.equal(folder.getTotalMessages(false), 0);
  await database.migrateFolderDatabase(folder);
  Assert.equal([...folder.messages].length, 2);
  const migrated = folder.msgDatabase.getMsgHdrForMessageID("162378@invalid");
  Assert.ok(migrated, "The source message is present in Panorama");
  Assert.equal(migrated.getStringProperty("deliveryMigrationEmpty"), "");
  Assert.equal(migrated.getStringProperty("deliveryMigrationAbsent"), "");
  Assert.ok(
    migrated.properties.includes("deliveryMigrationEmpty"),
    "An explicitly empty property remains present"
  );
  Assert.ok(
    !migrated.properties.includes("deliveryMigrationAbsent"),
    "An absent property remains absent"
  );

  const statement = database.connectionForTests.createStatement(
    "SELECT m.messageId, p.name, p.value FROM message_properties p " +
      "JOIN messages m ON m.id = p.id WHERE m.folderId = :folderId " +
      "AND p.name IN ('deliveryMigrationEmpty', 'deliveryMigrationAbsent') " +
      "ORDER BY m.messageId, p.name"
  );
  const rows = [];
  try {
    statement.params.folderId = folder.id;
    while (statement.executeStep()) {
      rows.push([
        statement.row.messageId,
        statement.row.name,
        statement.row.value,
      ]);
    }
  } finally {
    statement.finalize();
  }
  Assert.deepEqual(
    rows,
    [["162378@invalid", "deliveryMigrationEmpty", ""]],
    "Only the explicitly empty source cell exists, on its original message"
  );
});
