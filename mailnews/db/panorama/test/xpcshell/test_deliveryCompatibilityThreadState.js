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

function tree(name) {
  const folder = root.createLocalSubfolder(name);
  const head = insert(folder, name + "-root@thread.invalid", [], true);
  const branch = insert(folder, name + "-branch@thread.invalid", [
    head.messageId,
  ]);
  const leaf = insert(folder, name + "-leaf@thread.invalid", [
    head.messageId,
    branch.messageId,
  ]);
  const sibling = insert(folder, name + "-sibling@thread.invalid", [
    head.messageId,
  ]);
  const other = root.createLocalSubfolder(name + "-other");
  const foreign = insert(other, name + "-foreign@thread.invalid", [
    head.messageId,
    branch.messageId,
  ]);
  const db = folder.msgDatabase;
  return {
    folder,
    db,
    head,
    branch,
    leaf,
    sibling,
    foreign,
    thread: db.getThreadContainingMsgHdr(head),
  };
}

add_task(function test_readCountsAndNearestUnreadChild() {
  const { db, head, branch, leaf, sibling, foreign, thread } = tree("read");
  Assert.equal(thread.numUnreadChildren, 3);
  Assert.equal(thread.getFirstUnreadChild().messageKey, branch.messageKey);
  db.markRead(branch.messageKey, true, null);
  thread.markChildRead(true);
  Assert.equal(
    thread.numUnreadChildren,
    2,
    "Bookkeeping does not decrement derived counts twice"
  );
  Assert.equal(thread.getFirstUnreadChild().messageKey, sibling.messageKey);
  db.markRead(sibling.messageKey, true, null);
  Assert.equal(thread.getFirstUnreadChild().messageKey, leaf.messageKey);
  db.markRead(leaf.messageKey, true, null);
  Assert.equal(thread.numUnreadChildren, 0);
  Assert.throws(
    () => thread.getFirstUnreadChild(),
    error => error.result === Cr.NS_ERROR_NULL_POINTER
  );
  db.markRead(head.messageKey, false, null);
  thread.markChildRead(false);
  Assert.equal(thread.numUnreadChildren, 1);
  Assert.equal(thread.getFirstUnreadChild().messageKey, head.messageKey);
  Assert.equal(foreign.isRead, false);
  Assert.throws(
    () => db.markRead(foreign.messageKey, true, null),
    /NS_ERROR_ILLEGAL_VALUE/
  );
  Assert.equal(foreign.isRead, false);
  Assert.throws(
    () => db.getThreadContainingMsgHdr(foreign),
    /NS_ERROR_ILLEGAL_VALUE/
  );
  Assert.equal(
    thread.getChild(branch.messageKey).messageKey,
    branch.messageKey
  );
  Assert.throws(
    () => thread.getChild(foreign.messageKey),
    /NS_ERROR_UNEXPECTED/
  );
});

add_task(function test_newCountsFollowTheFolderNewList() {
  const { db, head, branch, foreign, thread } = tree("new");
  Assert.equal(thread.numNewChildren, 3);
  db.markNotNew(branch.messageKey, null);
  thread.markChildNew(false);
  Assert.equal(thread.numNewChildren, 2);
  db.addToNewList(head.messageKey);
  thread.markChildNew(true);
  Assert.equal(thread.numNewChildren, 3);
  db.clearNewList(false);
  Assert.equal(thread.numNewChildren, 0);
  Assert.equal(
    foreign.folder.msgDatabase.getThreadContainingMsgHdr(foreign)
      .numNewChildren,
    1
  );
});

add_task(function test_killedMarkerAffectsOnlyItsDescendantsInThisFolder() {
  const { db, head, branch, leaf, sibling, foreign } = tree("killed");
  db.markKilled(branch.messageKey, true, null);
  Assert.ok(branch.isKilled);
  Assert.ok(leaf.isKilled);
  Assert.ok(
    !(leaf.flags & Ci.nsMsgMessageFlags.Ignored),
    "An inherited kill does not write a marker on the child"
  );
  Assert.equal(head.isKilled, false);
  Assert.equal(sibling.isKilled, false);
  Assert.equal(foreign.isKilled, false);
  Assert.equal(
    db.isIgnored(branch.messageKey),
    false,
    "A killed subthread is separate from an ignored thread"
  );
  Assert.equal(
    leaf.isRead,
    false,
    "The view separately chooses when to mark descendants read"
  );
  db.markKilled(head.messageKey, true, null);
  Assert.ok(sibling.isKilled);
  db.markKilled(head.messageKey, false, null);
  Assert.equal(sibling.isKilled, false);
  Assert.ok(leaf.isKilled, "The independent branch marker remains");
  db.markKilled(branch.messageKey, false, null);
  Assert.equal(leaf.isKilled, false);
  Assert.throws(
    () => db.markKilled(foreign.messageKey, true, null),
    /NS_ERROR_ILLEGAL_VALUE/
  );
  Assert.equal(foreign.isKilled, false);
});

add_task(function test_deletedAncestorDoesNotSupplyACachedKilledMarker() {
  const { db, branch, leaf } = tree("missing-parent");
  db.markKilled(branch.messageKey, true, null);
  Assert.ok(leaf.isKilled);
  messageDB.removeMessage(branch.messageKey);
  const statement = database.connectionForTests.createStatement(
    "SELECT COUNT(*) FROM messages WHERE id = :id"
  );
  statement.params.id = branch.messageKey;
  try {
    Assert.ok(statement.executeStep());
    Assert.equal(
      statement.getInt64(0),
      0,
      "The parent row is absent independently of cached headers"
    );
  } finally {
    statement.finalize();
  }
  Assert.equal(leaf.isKilled, false);
  Assert.throws(
    () => db.markKilled(branch.messageKey, false, null),
    /NS_ERROR_ILLEGAL_VALUE/
  );
});

add_task(function test_killedQueryRejectsCyclesWithoutChangingRows() {
  const { head, leaf } = tree("cycle");
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "UPDATE messages SET threadParent = " +
      leaf.messageKey +
      " WHERE id = " +
      head.messageKey
  );
  try {
    Assert.throws(() => leaf.isKilled, /NS_ERROR_FILE_CORRUPTED/);
  } finally {
    connection.executeSimpleSQL(
      "UPDATE messages SET threadParent = 0 WHERE id = " + head.messageKey
    );
  }
  Assert.equal(leaf.isKilled, false);
});

add_task(function test_threadReadsPropagateStorageErrors() {
  const { leaf, thread } = tree("error");
  Assert.equal(leaf.isKilled, false);
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "ALTER TABLE messages RENAME TO unavailable_messages"
  );
  try {
    Assert.throws(
      () => leaf.isKilled,
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => thread.getChild(leaf.messageKey),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => thread.getFirstUnreadChild(),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => thread.numChildren,
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => thread.numUnreadChildren,
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => thread.numNewChildren,
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => thread.newestMsgDate,
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => thread.getRootHdr(),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_messages RENAME TO messages"
    );
  }
});
