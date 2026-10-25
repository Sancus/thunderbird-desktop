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

add_task(function test_setStringPropertyUpdatesKeywords() {
  const header = folder.addMessage(generator.makeMessage().toMessageString());
  db.setStringProperty(header.messageKey, "keywords", "delivery-tag");
  Assert.equal(header.getStringProperty("keywords"), "delivery-tag");
  Assert.equal(
    db.getMsgHdrForKey(header.messageKey).getStringProperty("keywords"),
    "delivery-tag",
    "The database setter and header accessor use the same keyword value"
  );

  const stmt = database.connectionForTests.createStatement(
    "SELECT tags FROM messages WHERE id = :id AND folderId = :folderId"
  );
  registerCleanupFunction(() => stmt.finalize());
  stmt.params.id = header.messageKey;
  stmt.params.folderId = folder.id;
  Assert.ok(
    stmt.executeStep(),
    "The message is stored in this Panorama folder"
  );
  Assert.equal(
    stmt.row.tags,
    "delivery-tag",
    "The canonical tag value is stored"
  );
  Assert.ok(!stmt.executeStep());
  stmt.reset();
});
