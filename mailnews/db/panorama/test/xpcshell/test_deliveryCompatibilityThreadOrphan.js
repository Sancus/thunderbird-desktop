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
  Assert.deepEqual(
    [...thread.enumerateMessages(0xffffffff)].map(header => header.messageKey),
    [head.messageKey, leaf.messageKey]
  );
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
  Assert.deepEqual(
    [...thread.enumerateMessages(0xffffffff)].map(header => header.messageKey),
    [head.messageKey, leaf.messageKey]
  );
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

add_task(function test_scopedRootsKeepForeignParentsAndReachEveryLocalMember() {
  const folder = root.createLocalSubfolder("frontier-local");
  const other = root.createLocalSubfolder("frontier-foreign");
  const head = insert(other, "frontier-root@thread.invalid", [], true);
  const foreign = insert(other, "frontier-foreign@thread.invalid", [
    head.messageId,
  ]);
  const first = insert(folder, "frontier-first@thread.invalid", [
    head.messageId,
  ]);
  const second = insert(folder, "frontier-second@thread.invalid", [
    head.messageId,
    foreign.messageId,
  ]);
  const child = insert(folder, "frontier-child@thread.invalid", [
    head.messageId,
    first.messageId,
  ]);
  const unrelated = insert(folder, "frontier-other-thread@thread.invalid");
  const db = folder.msgDatabase;
  const thread = db.getThreadContainingMsgHdr(first);
  Assert.equal(first.threadParent, head.messageKey);
  Assert.equal(second.threadParent, foreign.messageKey);
  Assert.equal(child.threadParent, first.messageKey);
  Assert.equal(thread.threadKey, head.messageKey);
  Assert.equal(thread.numChildren, 3);
  Assert.deepEqual(
    [...thread.enumerateMessages(0xffffffff)].map(header => header.messageKey),
    [second.messageKey, first.messageKey],
    "Every local frontier root follows the native thread preorder"
  );
  Assert.deepEqual(
    [...thread.enumerateMessages(first.messageKey)].map(
      header => header.messageKey
    ),
    [child.messageKey],
    "A non-sentinel parent still enumerates immediate children only"
  );
  Assert.deepEqual([...thread.enumerateMessages(second.messageKey)], []);
  const pending = [0xffffffff];
  const visited = [];
  while (pending.length) {
    for (const header of thread.enumerateMessages(pending.pop())) {
      Assert.strictEqual(header.folder, folder);
      visited.push(header.messageKey);
      pending.push(header.messageKey);
    }
  }
  Assert.equal(visited.length, thread.numChildren);
  Assert.equal(new Set(visited).size, visited.length);
  Assert.deepEqual(
    visited.toSorted((a, b) => a - b),
    [first.messageKey, second.messageKey, child.messageKey].toSorted(
      (a, b) => a - b
    )
  );
  Assert.ok(!visited.includes(unrelated.messageKey));
  Assert.throws(
    () => thread.enumerateMessages(foreign.messageKey),
    /NS_ERROR_UNEXPECTED/
  );
  Assert.equal(first.threadParent, head.messageKey);
  Assert.equal(second.threadParent, foreign.messageKey);
  Assert.equal(child.threadParent, first.messageKey);
});

add_task(function test_rootCursorSkipsRetiredMembersAndPreservesQueryErrors() {
  const folder = root.createLocalSubfolder("frontier-cursor-local");
  const other = root.createLocalSubfolder("frontier-cursor-foreign");
  const head = insert(other, "cursor-root@thread.invalid", [], true);
  const first = insert(folder, "cursor-first@thread.invalid", [head.messageId]);
  const second = insert(folder, "cursor-second@thread.invalid", [
    head.messageId,
  ]);
  const thread = folder.msgDatabase.getThreadContainingMsgHdr(first);
  const roots = thread.enumerateMessages(0xffffffff);
  Assert.ok(roots.hasMoreElements());
  messageDB.removeMessage(first.messageKey);
  Assert.equal(roots.getNext().messageKey, second.messageKey);
  Assert.ok(!roots.hasMoreElements());
  Assert.throws(() => roots.getNext(), /NS_ERROR_FAILURE/);
  const retained = thread.enumerateMessages(0xffffffff);
  Assert.ok(retained.hasMoreElements());
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "ALTER TABLE messages RENAME TO unavailable_frontier_messages"
  );
  try {
    Assert.throws(
      () => retained.hasMoreElements(),
      error => error.result === Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => retained.getNext(),
      error => error.result === Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => thread.enumerateMessages(0xffffffff),
      error => error.result === Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_frontier_messages RENAME TO messages"
    );
  }
  Assert.equal(retained.getNext().messageKey, second.messageKey);
  Assert.ok(!retained.hasMoreElements());
  Assert.equal(second.threadParent, head.messageKey);
  Assert.strictEqual(head.folder, other);
});
