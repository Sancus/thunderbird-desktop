/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

let root;

add_setup(function () {
  do_get_profile();
  const contract = "@mozilla.org/msgstore/berkeleystore;1";
  Services.prefs.setCharPref("mail.serverDefaultStoreContractID", contract);
  Services.prefs.setCharPref("mail.server.default.storeContractID", contract);
  loadExistingDB();
  Assert.equal(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"]
      .getService(Ci.nsIMsgDBService)
      .QueryInterface(Ci.nsIDatabaseCore),
    database
  );
  const account = MailServices.accounts.createLocalMailAccount();
  registerCleanupFunction(() => {
    MailServices.accounts.removeAccount(account, false);
    Services.prefs.clearUserPref("mail.serverDefaultStoreContractID");
    Services.prefs.clearUserPref("mail.server.default.storeContractID");
  });
  root = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  Assert.equal(root.msgStore.storeType, "mbox");
  Assert.equal(root.server.getStringValue("storeContractID"), contract);
});

function insert(folder, id, references = [], read = false) {
  const db = folder.msgDatabase;
  const draft = db.createNewHdr();
  draft.messageId = id;
  draft.setReferences(references.map(ref => "<" + ref + ">").join(" "));
  draft.flags = read ? Ci.nsMsgMessageFlags.Read : 0;
  return db.attachHdr(draft, false);
}

add_task(function test_missingParentDoesNotHideSurvivingUnreadMembership() {
  const folder = root.createLocalSubfolder("orphan-thread");
  const head = insert(folder, "root@orphan.invalid", [], true);
  const parent = insert(folder, "parent@orphan.invalid", [head.messageId]);
  const leaf = insert(folder, "leaf@orphan.invalid", [
    head.messageId,
    parent.messageId,
  ]);
  const db = folder.msgDatabase;
  const thread = db.getThreadContainingMsgHdr(head);
  messageDB.removeMessage(parent.messageKey);
  Assert.deepEqual(db.listAllKeys(), [head.messageKey, leaf.messageKey]);
  Assert.equal(leaf.threadId, head.messageKey);
  Assert.equal(leaf.threadParent, parent.messageKey);
  Assert.equal(thread.getChild(leaf.messageKey).messageKey, leaf.messageKey);
  Assert.equal(thread.numChildren, 2);
  Assert.equal(thread.numUnreadChildren, 1);
  Assert.equal(thread.numNewChildren, 1);
  Assert.equal(thread.getFirstUnreadChild().messageKey, leaf.messageKey);
});

add_task(function test_foreignConnectorDoesNotHideLocalUnreadMembers() {
  const folder = root.createLocalSubfolder("thread-connector-local");
  const other = root.createLocalSubfolder("thread-connector-foreign");
  const head = insert(folder, "connector-root@thread.invalid", [], true);
  const foreign = insert(other, "connector@thread.invalid", [head.messageId]);
  const leaf = insert(folder, "connector-leaf@thread.invalid", [
    head.messageId,
    foreign.messageId,
  ]);
  const db = folder.msgDatabase;
  const thread = db.getThreadContainingMsgHdr(head);
  Assert.equal(leaf.threadParent, foreign.messageKey);
  Assert.equal(leaf.threadId, head.messageKey);
  Assert.deepEqual(db.listAllKeys(), [head.messageKey, leaf.messageKey]);
  Assert.equal(thread.numChildren, 2);
  Assert.equal(thread.numUnreadChildren, 1);
  Assert.equal(thread.getChildKeyAt(0), head.messageKey);
  Assert.equal(thread.getChildKeyAt(1), leaf.messageKey);
  Assert.equal(thread.getChildHdrAt(1).messageKey, leaf.messageKey);
  Assert.equal(thread.getFirstUnreadChild().messageKey, leaf.messageKey);
  Assert.equal(
    thread.enumerateMessages(head.messageKey).hasMoreElements(),
    false
  );
  Assert.throws(
    () => thread.getChild(foreign.messageKey),
    /NS_ERROR_UNEXPECTED/
  );
  Assert.equal(foreign.isRead, false);
  Assert.equal(leaf.threadParent, foreign.messageKey);
});
