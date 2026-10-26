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

add_task(function test_numUnreadChildrenFollowsFolderReadState() {
  const first = generator.makeMessage();
  const root = folder.addMessage(first.toMessageString());
  const reply = folder.addMessage(
    generator.makeMessage({ inReplyTo: first }).toMessageString()
  );
  folder.addMessage(generator.makeMessage().toMessageString());
  const otherFolder = rootFolder
    .createLocalSubfolder("other")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const other = otherFolder.addMessage(
    generator.makeMessage({ inReplyTo: first }).toMessageString()
  );
  root.markRead(true);
  const thread = db.getThreadContainingMsgHdr(root);
  const otherThread = otherFolder.msgDatabase.getThreadContainingMsgHdr(other);
  Assert.equal(thread.numChildren, 2);
  Assert.equal(thread.numUnreadChildren, 1, "Only the unread reply is counted");
  Assert.equal(otherThread.numUnreadChildren, 1);

  db.markRead(reply.messageKey, true, null);
  Assert.equal(
    thread.numUnreadChildren,
    0,
    "Held threads reflect read changes"
  );
  db.markRead(reply.messageKey, false, null);
  Assert.equal(thread.numUnreadChildren, 1);
  root.markRead(false);
  Assert.equal(thread.numUnreadChildren, 2);
  other.markRead(true);
  Assert.equal(otherThread.numUnreadChildren, 0);
  Assert.equal(
    thread.numUnreadChildren,
    2,
    "Other folders do not change this count"
  );
  Assert.equal(thread.numChildren, 2, "Read changes preserve total membership");

  db.deleteMessage(reply.messageKey, null, false);
  Assert.equal(thread.numChildren, 1);
  Assert.equal(
    thread.numUnreadChildren,
    1,
    "Deleted unread children are excluded"
  );
  root.markRead(true);
  Assert.equal(thread.numUnreadChildren, 0);
  Assert.equal(otherThread.numUnreadChildren, 0);
});
