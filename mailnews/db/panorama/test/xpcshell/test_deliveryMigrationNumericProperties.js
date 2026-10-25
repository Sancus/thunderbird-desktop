/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

// Unknown numeric and cross-type migration is a pending cross-owner contract.
const { ProfileCreator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ProfileCreator.sys.mjs"
);

add_task(async function test_preservesUint32Properties() {
  const profile = new ProfileCreator(do_get_profile());
  const server = profile.addLocalServer();
  const files = await server.rootFolder.addMailFolder("numbers", {
    summary: do_get_file("data/migration.msf"),
    mbox: do_get_file("data/migration"),
  });
  const summaryFile = Cc["@mozilla.org/file/local;1"].createInstance(
    Ci.nsIFile
  );
  summaryFile.initWithPath(files.summaryFilePath);
  const numericProperties = [
    ["deliveryMigrationZero", 0, "0"],
    ["deliveryMigrationUint", 42, "2a"],
    ["deliveryMigrationMax", 0xffffffff, "ffffffff"],
  ];

  const legacy = Cc["@mozilla.org/nsMsgDatabase/msgDB-mailbox"].createInstance(
    Ci.nsIMsgDatabase
  );
  registerCleanupFunction(() => legacy.close(false));
  legacy.openFromFile(summaryFile);
  const original = legacy.getMsgHdrForMessageID("162378@invalid");
  for (const [name, value] of numericProperties) {
    original.setUint32Property(name, value);
  }
  legacy.forceClosed();

  const reader = Cc["@mozilla.org/nsMsgDatabase/msgDB-mailbox"].createInstance(
    Ci.nsIMsgDatabase
  );
  registerCleanupFunction(() => reader.close(false));
  reader.openFromFile(summaryFile);
  const saved = reader.getMsgHdrForMessageID("162378@invalid");
  for (const [name, value, raw] of numericProperties) {
    Assert.equal(saved.getUint32Property(name), value, name);
    Assert.equal(saved.getStringProperty(name), raw, name);
    Assert.ok(saved.properties.includes(name), name);
  }
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
  const folder = rootFolder.getChildNamed("numbers");
  PanoramaDelivery.assertFolder(folder, lane);
  Assert.equal(folder.getTotalMessages(false), 0);
  await database.migrateFolderDatabase(folder);
  Assert.equal([...folder.messages].length, 2);
  const migrated = folder.msgDatabase.getMsgHdrForMessageID("162378@invalid");
  Assert.ok(migrated, "The source message is present in Panorama");
  for (const [name, value] of numericProperties) {
    Assert.equal(migrated.getUint32Property(name), value, name);
    Assert.ok(migrated.properties.includes(name), name);
  }
});
