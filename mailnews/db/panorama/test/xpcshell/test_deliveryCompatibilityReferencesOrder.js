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

add_task(function test_getStringReferencePreservesOrder() {
  const header = folder.addMessage(
    generator
      .makeMessage({
        clobberHeaders: {
          References: "<ancestor@invalid> <parent@invalid>",
        },
      })
      .toMessageString()
  );
  Assert.equal(header.getStringReference(0), "ancestor@invalid");
  Assert.equal(header.getStringReference(1), "parent@invalid");
  const retrieved = db.getMsgHdrForKey(header.messageKey);
  Assert.equal(retrieved.getStringReference(0), "ancestor@invalid");
  Assert.equal(retrieved.getStringReference(1), "parent@invalid");
});
