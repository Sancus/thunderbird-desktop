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

add_task(function test_numReferencesRetainsUnresolvedAncestors() {
  const header = folder.addMessage(
    generator
      .makeMessage({
        clobberHeaders: {
          References: "<ancestor@invalid> <parent@invalid>",
        },
      })
      .toMessageString()
  );
  Assert.ok(header.isLive, "The header is attached to the database");
  Assert.equal(header.numReferences, 2, "Both References are retained");
  Assert.equal(
    db.getMsgHdrForKey(header.messageKey).numReferences,
    2,
    "A separately retrieved header exposes the same References count"
  );
});
