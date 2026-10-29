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
  Assert.strictEqual(
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

/**
 * Insert a real thread with a branch, leaf and sibling in a new physical folder.
 *
 * @param {string} name - Unique folder and message-ID prefix.
 * @returns {object} The folder, database, thread and its four live headers.
 */
function tree(name) {
  const folder = root.createLocalSubfolder(name);
  const db = folder.msgDatabase;
  function insert(suffix, references, flags) {
    const draft = db.createNewHdr();
    draft.messageId = name + "-" + suffix + "@thread.invalid";
    draft.flags = flags;
    draft.setReferences(references.map(ref => "<" + ref + ">").join(" "));
    return db.attachHdr(draft, false);
  }
  const head = insert("root", [], Ci.nsMsgMessageFlags.Read);
  const branch = insert("branch", [head.messageId], 0);
  const leaf = insert("leaf", [head.messageId, branch.messageId], 0);
  const sibling = insert("sibling", [head.messageId], 0);
  Assert.equal(branch.threadId, head.messageKey);
  Assert.equal(branch.threadParent, head.messageKey);
  Assert.equal(leaf.threadParent, branch.messageKey);
  Assert.equal(sibling.threadParent, head.messageKey);
  return {
    folder,
    db,
    head,
    branch,
    leaf,
    sibling,
    thread: db.getThreadContainingMsgHdr(head),
  };
}

/**
 * Read physical membership independently of retained header caches.
 *
 * @param {number} key - Global physical message key.
 * @returns {number[]|null} Stored key, folder, thread and parent, or no row.
 */
function storedMembership(key) {
  const statement = database.connectionForTests.createStatement(
    "SELECT id, folderId, threadId, threadParent FROM messages WHERE id = :id"
  );
  statement.params.id = key;
  try {
    return statement.executeStep()
      ? [0, 1, 2, 3].map(index => statement.getInt64(index))
      : null;
  } finally {
    statement.finalize();
  }
}

/**
 * Collect a direct-child enumerator's keys in its existing order.
 *
 * @param {nsIMsgEnumerator} iterator - The real thread enumerator.
 * @returns {number[]} Enumerated physical message keys.
 */
function keys(iterator) {
  const result = [];
  while (iterator.hasMoreElements()) {
    result.push(iterator.getNext().messageKey);
  }
  return result;
}

add_task(function test_directChildrenStayInTheirThreadAndPhysicalFolder() {
  const { folder, db, head, branch, leaf, sibling, thread } =
    tree("direct-children");
  const draft = db.createNewHdr();
  draft.messageId = "unrelated@direct-children.invalid";
  const unrelated = db.attachHdr(draft, false);
  const other = root.createLocalSubfolder("direct-children-other");
  const foreignDraft = other.msgDatabase.createNewHdr();
  foreignDraft.messageId = "foreign@direct-children.invalid";
  foreignDraft.setReferences("<" + head.messageId + ">");
  const foreign = other.msgDatabase.attachHdr(foreignDraft, false);
  Assert.deepEqual(keys(thread.enumerateMessages(head.messageKey)), [
    branch.messageKey,
    sibling.messageKey,
  ]);
  Assert.deepEqual(keys(thread.enumerateMessages(branch.messageKey)), [
    leaf.messageKey,
  ]);
  Assert.deepEqual(keys(thread.enumerateMessages(leaf.messageKey)), []);
  Assert.deepEqual(keys(thread.enumerateMessages(0xffffffff)), [
    head.messageKey,
  ]);
  Assert.equal(thread.getRootHdr().messageKey, head.messageKey);
  Assert.equal(thread.getChildKeyAt(0), head.messageKey);
  Assert.throws(() => thread.getChildKeyAt(0xffffffff), /NS_ERROR_UNEXPECTED/);
  Assert.strictEqual(thread.getRootHdr().folder, folder);
  Assert.throws(
    () => thread.enumerateMessages(unrelated.messageKey),
    /NS_ERROR_UNEXPECTED/
  );
  Assert.throws(
    () => thread.enumerateMessages(foreign.messageKey),
    /NS_ERROR_UNEXPECTED/
  );
});

add_task(function test_removedChildCannotEscapeThroughTheHeaderCache() {
  const { folder, head, branch, leaf, sibling, thread } = tree("removed-child");
  Assert.strictEqual(branch.folder, folder);
  const iterator = thread.enumerateMessages(head.messageKey);
  Assert.ok(iterator.hasMoreElements());
  messageDB.removeMessage(branch.messageKey);
  Assert.equal(storedMembership(branch.messageKey), null);
  Assert.deepEqual(keys(iterator), [sibling.messageKey]);
  Assert.deepEqual(storedMembership(leaf.messageKey), [
    leaf.messageKey,
    folder.id,
    head.messageKey,
    branch.messageKey,
  ]);
  Assert.throws(() => iterator.getNext(), /NS_ERROR_FAILURE/);
});

add_task(function test_childMovedAfterHasMoreIsSkipped() {
  const { folder, head, branch, sibling, thread } = tree("moved-child");
  const other = root.createLocalSubfolder("moved-child-other");
  Assert.strictEqual(branch.folder, folder);
  const iterator = thread.enumerateMessages(head.messageKey);
  Assert.ok(iterator.hasMoreElements());
  database.connectionForTests.executeSimpleSQL(
    "UPDATE messages SET folderId = " +
      other.id +
      " WHERE id = " +
      branch.messageKey
  );
  Assert.deepEqual(keys(iterator), [sibling.messageKey]);
  Assert.deepEqual(storedMembership(branch.messageKey), [
    branch.messageKey,
    other.id,
    head.messageKey,
    head.messageKey,
  ]);
});

add_task(function test_childInAnotherThreadIsSkipped() {
  const { folder, db, head, branch, sibling, thread } =
    tree("rethreaded-child");
  const draft = db.createNewHdr();
  draft.messageId = "unrelated@rethreaded-child.invalid";
  const unrelated = db.attachHdr(draft, false);
  const iterator = thread.enumerateMessages(head.messageKey);
  Assert.ok(iterator.hasMoreElements());
  database.connectionForTests.executeSimpleSQL(
    "UPDATE messages SET threadId = " +
      unrelated.messageKey +
      " WHERE id = " +
      branch.messageKey
  );
  Assert.deepEqual(keys(iterator), [sibling.messageKey]);
  Assert.deepEqual(keys(thread.enumerateMessages(head.messageKey)), [
    sibling.messageKey,
  ]);
  Assert.deepEqual(storedMembership(branch.messageKey), [
    branch.messageKey,
    folder.id,
    unrelated.messageKey,
    head.messageKey,
  ]);
});

add_task(function test_changedDirectParentIsSkipped() {
  const { folder, head, branch, sibling, thread } = tree("changed-parent");
  const iterator = thread.enumerateMessages(head.messageKey);
  Assert.ok(iterator.hasMoreElements());
  database.connectionForTests.executeSimpleSQL(
    "UPDATE messages SET threadParent = " +
      sibling.messageKey +
      " WHERE id = " +
      branch.messageKey
  );
  Assert.deepEqual(keys(iterator), [sibling.messageKey]);
  Assert.deepEqual(storedMembership(branch.messageKey), [
    branch.messageKey,
    folder.id,
    head.messageKey,
    sibling.messageKey,
  ]);
});

add_task(function test_retiredRootHandleCannotReturnAnotherThreadsChild() {
  const { folder, db, head, branch, thread } = tree("retired-root");
  const draft = db.createNewHdr();
  draft.messageId = "replacement@retired-root.invalid";
  const replacement = db.attachHdr(draft, false);
  const original = storedMembership(head.messageKey);
  Assert.deepEqual(original, [head.messageKey, folder.id, head.messageKey, 0]);
  Assert.equal(thread.getRootHdr().messageKey, head.messageKey);
  database.connectionForTests.executeSimpleSQL(
    "UPDATE messages SET threadId = " +
      replacement.messageKey +
      ", threadParent = " +
      replacement.messageKey +
      " WHERE id = " +
      head.messageKey
  );
  try {
    const currentRoot = thread.getRootHdr();
    Assert.equal(currentRoot.messageKey, branch.messageKey);
    Assert.notEqual(currentRoot.messageKey, head.messageKey);
    Assert.strictEqual(currentRoot.folder, folder);
    Assert.deepEqual(keys(thread.enumerateMessages(0xffffffff)), [
      branch.messageKey,
    ]);
    Assert.equal(
      thread.getChild(branch.messageKey).messageKey,
      branch.messageKey
    );
    Assert.deepEqual(storedMembership(head.messageKey), [
      head.messageKey,
      folder.id,
      replacement.messageKey,
      replacement.messageKey,
    ]);
    Assert.deepEqual(storedMembership(branch.messageKey), [
      branch.messageKey,
      folder.id,
      head.messageKey,
      head.messageKey,
    ]);
  } finally {
    database.connectionForTests.executeSimpleSQL(
      "UPDATE messages SET threadId = " +
        head.messageKey +
        ", threadParent = 0 WHERE id = " +
        head.messageKey
    );
  }
  Assert.equal(thread.getRootHdr().messageKey, head.messageKey);
});

add_task(function test_removedRootCannotBeReturnedFromRetainedHeaders() {
  const { folder, head, branch, thread } = tree("removed-root");
  Assert.equal(thread.getRootHdr().messageKey, head.messageKey);
  messageDB.removeMessage(head.messageKey);
  Assert.equal(storedMembership(head.messageKey), null);
  const currentRoot = thread.getRootHdr();
  Assert.equal(currentRoot.messageKey, branch.messageKey);
  Assert.notEqual(currentRoot.messageKey, head.messageKey);
  Assert.strictEqual(currentRoot.folder, folder);
  Assert.deepEqual(keys(thread.enumerateMessages(0xffffffff)), [
    branch.messageKey,
  ]);
  Assert.equal(
    thread.getChild(branch.messageKey).messageKey,
    branch.messageKey
  );
  Assert.deepEqual(storedMembership(branch.messageKey), [
    branch.messageKey,
    folder.id,
    head.messageKey,
    head.messageKey,
  ]);
});

add_task(function test_iteratorStorageFailureIsNotEndOfIteration() {
  const { head, branch, thread } = tree("enumeration-error");
  const iterator = thread.enumerateMessages(head.messageKey);
  Assert.ok(iterator.hasMoreElements());
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "ALTER TABLE messages RENAME TO unavailable_messages"
  );
  try {
    Assert.throws(
      () => iterator.hasMoreElements(),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => iterator.getNext(),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => thread.enumerateMessages(head.messageKey),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_messages RENAME TO messages"
    );
  }
  Assert.equal(iterator.getNext().messageKey, branch.messageKey);
});
