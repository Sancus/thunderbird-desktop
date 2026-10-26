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

add_task(function test_childMembershipUpdatesOnInsertion() {
  const first = generator.makeMessage();
  const root = folder.addMessage(first.toMessageString());
  const reply = folder.addMessage(
    generator.makeMessage({ inReplyTo: first }).toMessageString()
  );
  const thread = db.getThreadContainingMsgHdr(root);
  Assert.equal(thread.numChildren, 2);
  Assert.deepEqual(
    [thread.getChildKeyAt(0), thread.getChildKeyAt(1)].toSorted(
      (a, b) => a - b
    ),
    [root.messageKey, reply.messageKey].toSorted((a, b) => a - b)
  );

  const later = folder.addMessage(
    generator.makeMessage({ inReplyTo: first }).toMessageString()
  );
  Assert.equal(
    thread.numChildren,
    3,
    "Insertion updates the held thread count"
  );
  Assert.deepEqual(
    [0, 1, 2]
      .map(index => thread.getChildHdrAt(index).messageKey)
      .toSorted((a, b) => a - b),
    [root.messageKey, reply.messageKey, later.messageKey].toSorted(
      (a, b) => a - b
    ),
    "Child access includes the inserted message after earlier child access"
  );
  Assert.deepEqual(
    [0, 1, 2].map(index => thread.getChildKeyAt(index)),
    [root.messageKey, reply.messageKey, later.messageKey],
    "The held thread keeps root-first sibling order after insertion"
  );
  for (const index of [0, 1, 2]) {
    Assert.equal(thread.getChildHdrAt(index).folder, folder);
  }
});
