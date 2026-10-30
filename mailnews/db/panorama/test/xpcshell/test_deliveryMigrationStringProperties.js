/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

// Acceptance coverage for the explicit migration API, not a startup upgrade.
const { ProfileCreator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ProfileCreator.sys.mjs"
);

add_task(async function test_preservesStringProperties() {
  const profile = new ProfileCreator(do_get_profile());
  const server = profile.addLocalServer();
  const files = await server.rootFolder.addMailFolder("strings", {
    summary: do_get_file("data/migration.msf"),
    mbox: do_get_file("data/migration"),
  });
  const summaryFile = Cc["@mozilla.org/file/local;1"].createInstance(
    Ci.nsIFile
  );
  summaryFile.initWithPath(files.summaryFilePath);

  const stringProperties = [
    ["deliveryMigrationDecimalText", "42"],
    ["deliveryMigrationPaddedText", "00042"],
    ["deliveryMigrationHexText", "2a"],
  ];

  const legacy = Cc["@mozilla.org/nsMsgDatabase/msgDB-mailbox"].createInstance(
    Ci.nsIMsgDatabase
  );
  registerCleanupFunction(() => legacy.close(false));
  legacy.openFromFile(summaryFile);
  const original = legacy.getMsgHdrForMessageID("162378@invalid");
  original.setStringProperty("deliveryMigrationText", "line 1\n(a=b) $ \\end");
  original.setStringProperty("junkscore", "100");
  original.setStringProperty("junkscoreorigin", "user");
  for (const [name, value] of stringProperties) {
    original.setStringProperty(name, value);
  }
  legacy.forceClosed();

  // Read a fresh legacy database so fixture construction cannot mask data loss.
  const reader = Cc["@mozilla.org/nsMsgDatabase/msgDB-mailbox"].createInstance(
    Ci.nsIMsgDatabase
  );
  registerCleanupFunction(() => reader.close(false));
  reader.openFromFile(summaryFile);
  const saved = reader.getMsgHdrForMessageID("162378@invalid");
  Assert.equal(
    saved.getStringProperty("deliveryMigrationText"),
    "line 1\n(a=b) $ \\end",
    "The legacy engine persisted the custom string"
  );
  Assert.equal(saved.getStringProperty("junkscore"), "100");
  Assert.equal(saved.getStringProperty("junkscoreorigin"), "user");
  for (const [name, value] of stringProperties) {
    Assert.equal(saved.getStringProperty(name), value, name);
  }
  reader.forceClosed();
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
  const folder = rootFolder.getChildNamed("strings");
  PanoramaDelivery.assertFolder(folder, lane);
  Assert.equal(folder.getTotalMessages(false), 0);
  const controlFolder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("string-property-controls");
  const controlId = addMessage({
    folderId: controlFolder.id,
    messageId: "property-control@invalid",
    subject: "Committed property control",
  });
  const control = messageDB.getMessage(controlId);
  control.setStringProperty("delivery.control", "00042");
  const sourceSummary = await IOUtils.read(files.summaryFilePath);
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER delivery_fail_property_import " +
      "BEFORE INSERT ON message_properties " +
      "WHEN NEW.name = 'deliveryMigrationPaddedText' " +
      "BEGIN SELECT RAISE(ABORT, 'delivery property import failure'); END"
  );
  registerCleanupFunction(() =>
    connection.executeSimpleSQL(
      "DROP TRIGGER IF EXISTS delivery_fail_property_import"
    )
  );
  await Assert.rejects(
    database.migrateFolderDatabase(folder),
    error =>
      error.name === "UnknownError" &&
      error.message ===
        "Folder migration SQL failed: delivery property import failure",
    "The actual late arbitrary-property write failure rejects the import"
  );
  Assert.ok(!connection.transactionInProgress);
  Assert.equal(messageDB.totalCount, 1);
  Assert.deepEqual([...folder.messages], []);
  Assert.equal(control.subject, "Committed property control");
  Assert.equal(control.getStringProperty("delivery.control"), "00042");
  Assert.equal(control.getUint32Property("delivery.control"), 66);
  const failedRows = connection.createStatement(
    "SELECT id, name, value FROM message_properties ORDER BY id, name"
  );
  try {
    const rows = [];
    while (failedRows.executeStep()) {
      rows.push([failedRows.row.id, failedRows.row.name, failedRows.row.value]);
    }
    Assert.deepEqual(rows, [[controlId, "delivery.control", "00042"]]);
  } finally {
    failedRows.finalize();
  }
  Assert.equal(folder.getStringProperty("morkMigrationSource"), "");
  Assert.deepEqual(await IOUtils.read(files.summaryFilePath), sourceSummary);
  Assert.deepEqual(await IOUtils.read(files.mailFilePath), originalMbox);
  connection.executeSimpleSQL("DROP TRIGGER delivery_fail_property_import");
  await database.migrateFolderDatabase(folder);

  Assert.ok(!connection.transactionInProgress);
  Assert.equal(messageDB.totalCount, 3);
  Assert.equal(control.getStringProperty("delivery.control"), "00042");
  const messages = [...folder.messages];
  Assert.equal(messages.length, 2, "Only the two live source messages migrate");
  const migrated = folder.msgDatabase.getMsgHdrForMessageID("162378@invalid");
  Assert.ok(migrated, "The source message is present in Panorama");
  Assert.equal(
    migrated.getStringProperty("deliveryMigrationText"),
    "line 1\n(a=b) $ \\end",
    "Custom string bytes survive migration"
  );
  Assert.equal(migrated.getStringProperty("junkscore"), "100");
  Assert.equal(migrated.getStringProperty("junkscoreorigin"), "user");

  for (const [name, value] of stringProperties) {
    Assert.equal(migrated.getStringProperty(name), value, name);
  }

  const statement = database.connectionForTests.createStatement(
    "SELECT m.messageId, p.name, CAST(p.value AS TEXT) AS value " +
      "FROM message_properties p " +
      "JOIN messages m ON m.id = p.id WHERE m.folderId = :folderId " +
      "AND p.name IN ('deliveryMigrationText', " +
      "'deliveryMigrationDecimalText', " +
      "'deliveryMigrationPaddedText', 'deliveryMigrationHexText', " +
      "'junkscore', 'junkscoreorigin') " +
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
    [
      ["162378@invalid", "deliveryMigrationDecimalText", "42"],
      ["162378@invalid", "deliveryMigrationHexText", "2a"],
      ["162378@invalid", "deliveryMigrationPaddedText", "00042"],
      ["162378@invalid", "deliveryMigrationText", "line 1\n(a=b) $ \\end"],
      ["162378@invalid", "junkscore", "100"],
      ["162378@invalid", "junkscoreorigin", "user"],
    ],
    "String properties are stored on the correct message"
  );
  Assert.deepEqual(
    await IOUtils.read(files.mailFilePath),
    originalMbox,
    "Summary migration preserves the mbox bytes"
  );
});
