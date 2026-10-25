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

add_task(function test_setReferencesUpdatesLiveHeaders() {
  const header = folder.addMessage(generator.makeMessage().toMessageString());
  const retrieved = db.getMsgHdrForKey(header.messageKey);
  header.setReferences("<first@invalid> <second@invalid>");
  Assert.equal(retrieved.numReferences, 2);
  Assert.equal(retrieved.getStringReference(0), "first@invalid");
  Assert.equal(retrieved.getStringReference(1), "second@invalid");

  retrieved.setReferences("<replacement@invalid>");
  Assert.equal(
    header.numReferences,
    1,
    "Replacing References removes old values"
  );
  Assert.equal(header.getStringReference(0), "replacement@invalid");
  header.setReferences("");
  Assert.equal(
    retrieved.numReferences,
    0,
    "Clearing References updates held headers"
  );
  Assert.equal(db.getMsgHdrForKey(header.messageKey).numReferences, 0);
});
