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

add_task(function test_readWriteFailureKeepsFlagsCountsAndNotifications() {
  const { folder, db, branch, leaf, sibling, thread } =
    tree("read-write-error");
  const events = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged(header, oldFlags, flags) {
      events.push([header.messageKey, oldFlags, flags]);
    },
  };
  Assert.equal(branch.flags, 0);
  Assert.equal(thread.numUnreadChildren, 3);
  db.addListener(listener);
  const connection = database.connectionForTests;
  try {
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER reject_thread_read BEFORE UPDATE OF flags ON messages " +
        "WHEN OLD.id = " +
        branch.messageKey +
        " BEGIN SELECT RAISE(ABORT, 'read change'); END"
    );
    try {
      Assert.throws(
        () => db.markRead(branch.messageKey, true, null),
        error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
      );
      Assert.deepEqual(events, []);
      Assert.equal(branch.flags, 0);
      Assert.equal(thread.numUnreadChildren, 3);
      Assert.equal(thread.getFirstUnreadChild().messageKey, branch.messageKey);
      Assert.equal(leaf.isRead, false);
      Assert.equal(sibling.isRead, false);
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER reject_thread_read");
    }
    db.markRead(branch.messageKey, true, null);
    Assert.ok(branch.isRead);
    Assert.equal(thread.numUnreadChildren, 2);
    Assert.equal(thread.getFirstUnreadChild().messageKey, sibling.messageKey);
    Assert.deepEqual(events, [
      [branch.messageKey, 0, Ci.nsMsgMessageFlags.Read],
    ]);
    Assert.strictEqual(branch.folder, folder);
  } finally {
    db.removeListener(listener);
  }
});

add_task(function test_killedWriteFailureKeepsTheDescendantsUnchanged() {
  const { db, head, branch, leaf, sibling } = tree("killed-write-error");
  const events = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged(header, oldFlags, flags) {
      events.push([header.messageKey, oldFlags, flags]);
    },
  };
  Assert.equal(branch.flags, 0);
  Assert.equal(leaf.isKilled, false);
  db.addListener(listener);
  const connection = database.connectionForTests;
  try {
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER reject_thread_kill BEFORE UPDATE OF flags ON messages " +
        "WHEN OLD.id = " +
        branch.messageKey +
        " BEGIN SELECT RAISE(ABORT, 'killed change'); END"
    );
    try {
      Assert.throws(
        () => db.markKilled(branch.messageKey, true, null),
        error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
      );
      Assert.deepEqual(events, []);
      Assert.equal(branch.flags, 0);
      Assert.equal(leaf.isKilled, false);
      Assert.equal(leaf.flags, 0);
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER reject_thread_kill");
    }
    db.markKilled(branch.messageKey, true, null);
    Assert.ok(branch.isKilled);
    Assert.ok(leaf.isKilled);
    Assert.equal(leaf.flags, 0);
    Assert.equal(leaf.isRead, false);
    Assert.equal(head.isKilled, false);
    Assert.equal(sibling.isKilled, false);
    Assert.deepEqual(events, [
      [branch.messageKey, 0, Ci.nsMsgMessageFlags.Ignored],
    ]);
  } finally {
    db.removeListener(listener);
  }
});

add_task(function test_keyedThreadMutationsRejectCurrentForeignMembership() {
  const { db, folder, branch } = tree("moved-keyed-ownership");
  const other = root.createLocalSubfolder("moved-keyed-other");
  Assert.strictEqual(branch.folder, folder);
  Assert.equal(branch.flags, 0);
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    `UPDATE messages SET folderId = ${other.id} WHERE id = ${branch.messageKey}`
  );
  for (const operation of [
    () => db.markRead(branch.messageKey, true, null),
    () => db.markKilled(branch.messageKey, true, null),
    () => db.isRead(branch.messageKey),
    () => db.getThreadContainingMsgHdr(branch),
  ]) {
    Assert.throws(
      operation,
      error => error.result == Cr.NS_ERROR_ILLEGAL_VALUE
    );
  }
  const statement = connection.createStatement(
    "SELECT folderId, flags FROM messages WHERE id = :id"
  );
  try {
    statement.params.id = branch.messageKey;
    Assert.ok(statement.executeStep());
    Assert.equal(statement.row.folderId, other.id);
    Assert.equal(statement.row.flags, 0);
  } finally {
    statement.finalize();
  }
});

add_task(function test_unknownThreadIdentityIsNotAnEmptyThreadWord() {
  const { db, branch } = tree("unknown-thread-identity");
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    `UPDATE messages SET threadId = NULL WHERE id = ${branch.messageKey}`
  );
  Assert.throws(
    () => db.getThreadContainingMsgHdr(branch),
    /NS_ERROR_NOT_AVAILABLE/
  );
  Assert.throws(
    () => db.isIgnored(branch.messageKey),
    /NS_ERROR_NOT_AVAILABLE/
  );
  Assert.throws(
    () => db.isWatched(branch.messageKey),
    /NS_ERROR_NOT_AVAILABLE/
  );
  const statement = connection.createStatement(
    "SELECT threadId, flags FROM messages WHERE id = :id"
  );
  try {
    statement.params.id = branch.messageKey;
    Assert.ok(statement.executeStep());
    Assert.strictEqual(statement.row.threadId, null);
    Assert.equal(statement.row.flags, 0);
  } finally {
    statement.finalize();
  }
});
