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

add_task(function test_onHdrAddedWithoutParent() {
  const noParentFolder = rootFolder
    .createLocalSubfolder("notification-root")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const noParentDB = PanoramaDelivery.assertFolder(
    noParentFolder,
    PanoramaDelivery.expectedLane()
  );
  const added = [];
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
      Assert.equal(header.threadParent, 0, "The root has no stored parent");
      Assert.equal(
        header.threadId,
        header.messageKey,
        "The root owns its thread"
      );
      Assert.equal(
        header.flags,
        Ci.nsMsgMessageFlags.New,
        "The unread callback header exposes its New-list status"
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
  noParentDB.addListener(listener);
  registerCleanupFunction(() => noParentDB.removeListener(listener));

  const root = noParentFolder.addMessage(
    generator.makeMessage({ subject: "Notification root" }).toMessageString()
  );
  Assert.deepEqual(
    added,
    [
      [
        root.messageKey,
        noParentFolder.URI,
        0xffffffff,
        Ci.nsMsgMessageFlags.New,
        null,
      ],
    ],
    "Exactly one root addition uses the no-parent notification sentinel"
  );
  noParentDB.removeListener(listener);
});

add_task(function test_onHdrAddedIncludesParentAndFolder() {
  const first = generator.makeMessage({ subject: "Notification parent" });
  // The reply subject supplies HasRe and its unread status supplies New.
  const expectedFlags = Ci.nsMsgMessageFlags.HasRe | Ci.nsMsgMessageFlags.New;
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
        header.threadParent,
        root.messageKey,
        "The callback header already has the committed reply parent"
      );
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
