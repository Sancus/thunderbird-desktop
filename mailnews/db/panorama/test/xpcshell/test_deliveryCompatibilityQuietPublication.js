/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from head_delivery.js */

add_task(async function test_quietAttachStillPublishesToLiveView() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.equal(lane.store, "mbox");
  const { db, folder, account } =
    PanoramaDelivery.createLocalFixture("quiet-publication");
  const draft = db.createNewHdr();
  draft.messageId = "quiet@invalid";
  draft.subject = "Quiet draft";
  draft.storeToken = "metadata-token";
  draft.messageSize = 11;
  const view = Cc["@mozilla.org/mailnews/live-view;1"].createInstance(
    Ci.nsILiveView
  );
  view.initWithFolder(folder.id);
  registerCleanupFunction(() => view.clearListener());
  const internal = [];
  view.setListener({
    onMessageAdded(message) {
      const header = messageDB.getMessage(message.id);
      Assert.equal(header.storeToken, "metadata-token");
      Assert.equal(header.messageSize, 11);
      Assert.equal(
        header.accountKey,
        account.key,
        "Absent account uses folder"
      );
      Assert.throws(() => db.attachHdr(draft, false), /NS_ERROR_IN_PROGRESS/);
      internal.push([
        message.id,
        message.folderId,
        message.subject,
        message.flags,
      ]);
    },
    onMessageRemoved() {
      Assert.ok(false, "No removal during publication");
    },
    onMessageFlagsChanged() {
      Assert.ok(false, "No completion flag change");
    },
    onMessageTagsChanged() {
      Assert.ok(false, "No completion tag change");
    },
    onSelectedChunk() {},
  });
  const legacy = [];
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
    onHdrAdded(header) {
      legacy.push(header.messageKey);
    },
  };
  db.addListener(listener);
  registerCleanupFunction(() => db.removeListener(listener));
  const live = db.attachHdr(draft, false);
  Assert.deepEqual(legacy, []);
  Assert.deepEqual(internal, [[live.messageKey, folder.id, "Quiet draft", 0]]);
  Assert.equal(await view.countMessages(), 1);
  Assert.equal(await view.countUnreadMessages(), 1);
  Assert.deepEqual(db.getNewList(), [live.messageKey]);
  Assert.equal(db.attachHdr(draft, true), live);
  Assert.equal(internal.length, 1);
  Assert.deepEqual(legacy, [], "A consumed draft cannot replay a quiet add");
  db.removeListener(listener);
  view.clearListener();
});
