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

add_task(function test_childMembershipUpdatesOnDeletion() {
  const first = generator.makeMessage();
  const root = folder.addMessage(first.toMessageString());
  const reply = folder.addMessage(
    generator.makeMessage({ inReplyTo: first }).toMessageString()
  );
  const later = folder.addMessage(
    generator.makeMessage({ inReplyTo: first }).toMessageString()
  );
  const thread = db.getThreadContainingMsgHdr(root);
  Assert.equal(thread.numChildren, 3);
  Assert.deepEqual(
    [0, 1, 2]
      .map(index => thread.getChildKeyAt(index))
      .toSorted((a, b) => a - b),
    [root.messageKey, reply.messageKey, later.messageKey].toSorted(
      (a, b) => a - b
    )
  );

  db.deleteMessage(reply.messageKey, null, false);
  Assert.equal(thread.numChildren, 2, "Deletion updates the held thread count");
  Assert.deepEqual(
    [
      thread.getChildHdrAt(0).messageKey,
      thread.getChildHdrAt(1).messageKey,
    ].toSorted((a, b) => a - b),
    [root.messageKey, later.messageKey].toSorted((a, b) => a - b),
    "Child access excludes the deleted message after earlier child access"
  );
});
