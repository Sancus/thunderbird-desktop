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

add_task(function test_enumerateMessagesKeepsIndependentFolderCursors() {
  const otherFolder = rootFolder
    .createLocalSubfolder("other")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  Assert.deepEqual(
    [...db.enumerateMessages()],
    [],
    "An empty folder enumerates"
  );
  Assert.deepEqual([...db.reverseEnumerateMessages()], []);
  const first = folder.addMessage(
    generator.makeMessage({ subject: "First message" }).toMessageString()
  );
  const other = otherFolder.addMessage(
    generator.makeMessage({ subject: "Other folder" }).toMessageString()
  );
  const last = folder.addMessage(
    generator.makeMessage({ subject: "Last message" }).toMessageString()
  );
  const forward = db.enumerateMessages();
  const concurrent = db.enumerateMessages();
  const reverse = db.reverseEnumerateMessages();
  const otherCursor = otherFolder.msgDatabase.enumerateMessages();
  Assert.ok(forward.hasMoreElements());
  Assert.ok(forward.hasMoreElements(), "Checking for an item does not advance");
  Assert.equal(forward.getNext().messageKey, first.messageKey);
  Assert.equal(otherCursor.getNext().messageKey, other.messageKey);
  Assert.ok(!otherCursor.hasMoreElements());
  Assert.equal(reverse.getNext().messageKey, last.messageKey);
  Assert.equal(concurrent.getNext().subject, "First message");
  const finalHeader = forward.getNext();
  Assert.equal(finalHeader.messageKey, last.messageKey);
  Assert.equal(finalHeader.subject, "Last message");
  Assert.equal(finalHeader.folder, folder);
  Assert.equal(concurrent.getNext().messageKey, last.messageKey);
  Assert.equal(reverse.getNext().messageKey, first.messageKey);
  Assert.ok(!forward.hasMoreElements());
  Assert.ok(!concurrent.hasMoreElements());
  Assert.ok(!reverse.hasMoreElements());
  Assert.deepEqual(
    Array.from(db.enumerateMessages(), h => h.messageKey),
    [first.messageKey, last.messageKey],
    "Exhausting concurrent cursors does not affect a later enumeration"
  );
});
