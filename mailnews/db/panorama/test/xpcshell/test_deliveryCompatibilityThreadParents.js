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

add_task(function test_enumerateMessagesReturnsImmediateChildren() {
  const first = generator.makeMessage();
  const second = generator.makeMessage({ inReplyTo: first });
  const root = folder.addMessage(first.toMessageString());
  const reply = folder.addMessage(second.toMessageString());
  const sibling = folder.addMessage(
    generator.makeMessage({ inReplyTo: first }).toMessageString()
  );
  const grandchild = folder.addMessage(
    generator.makeMessage({ inReplyTo: second }).toMessageString()
  );
  folder.addMessage(generator.makeMessage().toMessageString());
  const otherFolder = rootFolder
    .createLocalSubfolder("other")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  otherFolder.addMessage(
    generator.makeMessage({ inReplyTo: first }).toMessageString()
  );

  const thread = db.getThreadContainingMsgHdr(grandchild);
  Assert.equal(
    thread.numChildren,
    4,
    "Unrelated messages and folders are excluded"
  );
  Assert.equal(thread.getRootHdr().messageKey, root.messageKey);
  Assert.equal(thread.getRootHdr().folder, folder);
  Assert.equal(reply.threadParent, root.messageKey);
  Assert.equal(sibling.threadParent, root.messageKey);
  Assert.equal(grandchild.threadParent, reply.messageKey);
  Assert.deepEqual(
    Array.from(
      thread.enumerateMessages(root.messageKey),
      h => h.messageKey
    ).toSorted((a, b) => a - b),
    [reply.messageKey, sibling.messageKey].toSorted((a, b) => a - b),
    "Enumerating a parent excludes grandchildren and replies in other folders"
  );
  Assert.deepEqual(
    Array.from(thread.enumerateMessages(reply.messageKey), h => h.messageKey),
    [grandchild.messageKey]
  );
  Assert.deepEqual([...thread.enumerateMessages(grandchild.messageKey)], []);
});
