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

add_task(function test_onHdrAddedIncludesParentAndFolder() {
  const first = generator.makeMessage({ subject: "Notification parent" });
  // The reply subject supplies HasRe; New is tracked in the DB new-message list.
  const expectedFlags = Ci.nsMsgMessageFlags.HasRe;
  const root = folder.addMessage(first.toMessageString());
  const otherFolder = rootFolder
    .createLocalSubfolder("other")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const otherDB = otherFolder.msgDatabase;
  const added = [];
  const unrelated = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged() {},
    onHdrDeleted() {},
    onParentChanged() {},
    onAnnouncerGoingAway() {},
    onReadChanged() {},
    onJunkScoreChanged() {},
    onHdrPropertyChanged() {},
    onEvent() {},
    onHdrAdded(header, parent, flags, instigator) {
      Assert.equal(
        flags,
        expectedFlags,
        "The notification has the reply flags"
      );
      Assert.equal(
        header.flags,
        expectedFlags,
        "The callback header has the reply flags"
      );
      added.push([
        header.messageKey,
        header.folder.URI,
        parent,
        flags,
        instigator,
      ]);
    },
  };
  const otherListener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged() {},
    onHdrDeleted() {},
    onParentChanged() {},
    onAnnouncerGoingAway() {},
    onReadChanged() {},
    onJunkScoreChanged() {},
    onHdrPropertyChanged() {},
    onEvent() {},
    onHdrAdded(header) {
      unrelated.push(header.messageKey);
    },
  };
  db.addListener(listener);
  registerCleanupFunction(() => db.removeListener(listener));
  otherDB.addListener(otherListener);
  registerCleanupFunction(() => otherDB.removeListener(otherListener));

  const reply = folder.addMessage(
    generator.makeMessage({ inReplyTo: first }).toMessageString()
  );
  Assert.deepEqual(added, [
    [reply.messageKey, folder.URI, root.messageKey, expectedFlags, null],
  ]);
  Assert.deepEqual(unrelated, [], "Other folders do not receive the addition");
  Assert.equal(reply.threadParent, root.messageKey);
  Assert.ok(
    db.getNewList().includes(reply.messageKey),
    "The unread reply joins the new-message list"
  );
  Assert.deepEqual(db.listAllKeys(), [root.messageKey, reply.messageKey]);

  db.removeListener(listener);
  folder.addMessage(generator.makeMessage().toMessageString());
  Assert.equal(added.length, 1, "Removing a listener stops its notifications");
  Assert.deepEqual(unrelated, []);
});
