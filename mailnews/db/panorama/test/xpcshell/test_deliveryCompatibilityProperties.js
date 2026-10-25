/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);

const generator = new MessageGenerator();
let rootFolder, folder, db;

add_setup(function () {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.equal(lane.store, "mbox");
  do_get_profile();
  loadExistingDB();
  const account = MailServices.accounts.createLocalMailAccount();
  rootFolder = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  folder = rootFolder
    .createLocalSubfolder("compatibility")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  db = PanoramaDelivery.assertFolder(folder, lane);
});

add_task(function test_customPropertiesAreSharedByHeaderAndDatabase() {
  const header = folder.addMessage(generator.makeMessage().toMessageString());
  const other = folder.addMessage(generator.makeMessage().toMessageString());
  const retrieved = db.getMsgHdrForKey(header.messageKey);
  Assert.equal(header.getStringProperty("delivery-text"), "");
  Assert.equal(header.getUint32Property("delivery-number"), 0);

  header.setStringProperty("delivery-text", "Café \u2603");
  db.setStringPropertyByHdr(retrieved, "delivery-empty", "");
  db.setUint32PropertyByHdr(retrieved, "delivery-number", 0xffffffff);
  Assert.equal(retrieved.getStringProperty("delivery-text"), "Café \u2603");
  Assert.equal(header.getUint32Property("delivery-number"), 0xffffffff);
  Assert.equal(other.getStringProperty("delivery-text"), "");
  Assert.equal(other.getUint32Property("delivery-number"), 0);
  Assert.deepEqual(
    header.properties.filter(name => name.startsWith("delivery-")).toSorted(),
    ["delivery-empty", "delivery-number", "delivery-text"],
    "Property enumeration includes empty values without duplicates"
  );

  db.setStringProperty(header.messageKey, "delivery-text", "updated");
  header.setUint32Property("delivery-number", 0);
  Assert.equal(retrieved.getStringProperty("delivery-text"), "updated");
  Assert.equal(retrieved.getUint32Property("delivery-number"), 0);

  const stmt = database.connectionForTests.createStatement(
    "SELECT name, value FROM message_properties " +
      "WHERE id = :id AND name LIKE 'delivery-%' ORDER BY name"
  );
  registerCleanupFunction(() => stmt.finalize());
  stmt.params.id = header.messageKey;
  const stored = [];
  while (stmt.executeStep()) {
    stored.push([stmt.row.name, stmt.row.value]);
  }
  stmt.reset();
  Assert.deepEqual(stored, [
    ["delivery-empty", ""],
    ["delivery-number", 0],
    ["delivery-text", "updated"],
  ]);
});
