/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from head_delivery.js */

add_task(function test_attachPublishesCompleteHeaderAndConsumesDraft() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.equal(lane.store, "mbox");
  const { db, folder, account } = PanoramaDelivery.createLocalFixture(
    "complete-publication"
  );
  const parent = addMessage({
    folderId: folder.id,
    messageId: "complete-parent@invalid",
    flags: Ci.nsMsgMessageFlags.Read,
  });
  const draft = db.createNewHdr();
  draft.messageId = "complete-child@invalid";
  draft.subject = "Complete draft";
  draft.author = "Sender <sender@invalid>";
  draft.recipients = "Recipient <recipient@invalid>";
  draft.ccList = "Copy <copy@invalid>";
  draft.bccList = "Blind <blind@invalid>";
  draft.date = 1736942400000000;
  draft.flags = Ci.nsMsgMessageFlags.HasRe;
  draft.setStringProperty("replyTo", "reply@invalid");
  draft.setStringProperty("dateReceived", "00042");
  draft.setReferences(
    "<complete-parent@invalid> <unresolved@invalid> <complete-parent@invalid>"
  );
  draft.charset = "UTF-8";
  draft.accountKey = "received-account";
  draft.setStringProperty("account", "");
  draft.setStringProperty("delivery.text", "Caf\u00e9");
  draft.setStringProperty("keywords", "complete-tag");
  draft.storeToken = "metadata-token";
  draft.messageSize = 37;
  draft.offlineMessageSize = 0;
  draft.lineCount = 0;
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
    onHdrAdded(header, parentKey, flags, instigator) {
      added.push(header.messageKey);
      Assert.equal(parentKey, parent);
      Assert.equal(header.threadParent, parent);
      Assert.equal(header.folder, folder);
      Assert.equal(flags, Ci.nsMsgMessageFlags.HasRe);
      Assert.equal(header.flags, Ci.nsMsgMessageFlags.HasRe);
      Assert.equal(header.messageId, "complete-child@invalid");
      Assert.equal(header.subject, "Complete draft");
      Assert.equal(header.author, "Sender <sender@invalid>");
      Assert.equal(header.recipients, "Recipient <recipient@invalid>");
      Assert.equal(header.ccList, "Copy <copy@invalid>");
      Assert.equal(header.bccList, "Blind <blind@invalid>");
      Assert.equal(header.date, 1736942400000000);
      Assert.equal(header.getStringProperty("replyTo"), "reply@invalid");
      Assert.equal(header.getStringProperty("dateReceived"), "00042");
      Assert.equal(header.getUint32Property("dateReceived"), 66);
      Assert.equal(instigator, null);
      Assert.equal(header.storeToken, "metadata-token");
      Assert.equal(header.messageSize, 37);
      Assert.equal(header.offlineMessageSize, 0);
      Assert.equal(header.lineCount, 0);
      Assert.ok(header.properties.includes("offlineMessageSize"));
      Assert.ok(header.properties.includes("lineCount"));
      Assert.equal(header.charset, "UTF-8");
      Assert.equal(header.accountKey, "", "Explicit empty defeats fallback");
      Assert.equal(header.getStringProperty("keywords"), "complete-tag");
      Assert.equal(header.getStringProperty("delivery.text"), "Caf\u00e9");
      Assert.equal(header.numReferences, 3);
      Assert.equal(header.getStringReference(0), "complete-parent@invalid");
      Assert.equal(header.getStringReference(1), "unresolved@invalid");
      Assert.equal(header.getStringReference(2), "complete-parent@invalid");
      Assert.equal(header.threadId, parent);
      Assert.ok(db.getNewList().includes(header.messageKey));
      Assert.throws(() => db.attachHdr(draft, true), /NS_ERROR_IN_PROGRESS/);
      Assert.throws(() => {
        draft.subject = "reentrant";
      }, /NS_ERROR_IN_PROGRESS/);
    },
  };
  db.addListener(listener);
  registerCleanupFunction(() => db.removeListener(listener));
  const live = db.attachHdr(draft, true);
  Assert.deepEqual(added, [live.messageKey]);
  Assert.equal(
    db.attachHdr(draft, true),
    live,
    "Same draft retains its result"
  );
  Assert.deepEqual(
    added,
    [live.messageKey],
    "Successful repeat emits no event"
  );
  Assert.deepEqual(db.listAllKeys(), [parent, live.messageKey]);
  Assert.throws(() => {
    draft.messageSize = 99;
  }, /NS_ERROR_ALREADY_INITIALIZED/);
  Assert.equal(live.messageSize, 37);
  live.charset = "windows-1252";
  Assert.equal(live.getStringProperty("msgCharSet"), "windows-1252");
  live.setStringProperty("msgCharSet", "UTF-8");
  Assert.equal(live.charset, "UTF-8");
  live.charset = "";
  Assert.equal(live.getStringProperty("msgCharSet"), "");
  Assert.ok(live.properties.includes("msgCharSet"));
  live.accountKey = "other-account";
  Assert.equal(live.getStringProperty("account"), "other-account");
  live.setStringProperty("account", "");
  Assert.equal(live.accountKey, "");
  Assert.ok(live.properties.includes("account"));
  Assert.notEqual(account.key, "");
  db.removeListener(listener);
});
