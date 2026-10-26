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

  const oldMessageId = reply.messageId;
  const oldFlags = reply.flags;
  const deleted = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged() {},
    onHdrAdded() {},
    onParentChanged() {},
    onAnnouncerGoingAway() {},
    onReadChanged() {},
    onJunkScoreChanged() {},
    onHdrPropertyChanged() {},
    onEvent() {},
    onHdrDeleted(header, _parent, flags) {
      deleted.push({
        key: header.messageKey,
        messageId: header.messageId,
        folder: header.folder,
        headerFlags: header.flags,
        flags,
        count: thread.numChildren,
        keys: [thread.getChildKeyAt(0), thread.getChildKeyAt(1)],
      });
    },
  };
  db.addListener(listener);
  registerCleanupFunction(() => db.removeListener(listener));
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
  Assert.deepEqual(
    deleted,
    [
      {
        key: reply.messageKey,
        messageId: oldMessageId,
        folder,
        headerFlags: oldFlags,
        flags: oldFlags,
        count: 2,
        keys: [root.messageKey, later.messageKey],
      },
    ],
    "Removal callbacks retain the old header and expose current membership"
  );
  Assert.throws(() => thread.getChildKeyAt(2), /NS_ERROR_UNEXPECTED/);
  Assert.throws(() => thread.getChildHdrAt(2), /NS_ERROR_UNEXPECTED/);

  const statement = database.connectionForTests.createStatement(
    "SELECT id FROM messages WHERE folderId = :folderId ORDER BY id"
  );
  registerCleanupFunction(() => statement.finalize());
  statement.params.folderId = folder.id;
  const remaining = [];
  while (statement.executeStep()) {
    remaining.push(statement.row.id);
  }
  statement.reset();
  Assert.deepEqual(
    remaining,
    [root.messageKey, later.messageKey],
    "Only the requested message row is removed"
  );
});
