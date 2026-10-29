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

function insert(folder, id, reference) {
  const db = folder.msgDatabase;
  const draft = db.createNewHdr();
  draft.messageId = id;
  if (reference) {
    draft.setReferences("<" + reference + ">");
  }
  return db.attachHdr(draft, false);
}

/**
 * Get the native interface identity of a JavaScript change listener.
 *
 * @param {nsIDBChangeListener} listener - The JavaScript implementation.
 * @returns {nsIDBChangeListener} Its XPConnect interface wrapper.
 */
function listenerIdentity(listener) {
  const pointer = Cc[
    "@mozilla.org/supports-interface-pointer;1"
  ].createInstance(Ci.nsISupportsInterfacePointer);
  pointer.data = listener;
  return pointer.data.QueryInterface(Ci.nsIDBChangeListener);
}

add_task(function test_watchedAndIgnoredAreThreadStateNotKilledMarkers() {
  const folder = root.createLocalSubfolder("thread-flags");
  const head = insert(folder, "root@thread-flags.invalid");
  const child = insert(folder, "child@thread-flags.invalid", head.messageId);
  const db = folder.msgDatabase;
  const thread = db.getThreadContainingMsgHdr(head);
  const events = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrAdded() {},
    onHdrDeleted() {},
    onParentChanged() {},
    onAnnouncerGoingAway() {},
    onReadChanged() {},
    onJunkScoreChanged() {},
    onHdrPropertyChanged() {},
    onEvent() {},
    onHdrFlagsChanged(header, oldFlags, flags, instigator) {
      events.push([header.messageKey, oldFlags, flags]);
      Assert.strictEqual(instigator, expectedInstigator);
      Assert.equal(header.folder, folder);
    },
  };
  const expectedInstigator = listenerIdentity(listener);
  db.addListener(listener);
  try {
    db.markThreadWatched(thread, head.messageKey, true, listener);
    Assert.equal(thread.flags, Ci.nsMsgMessageFlags.Watched);
    Assert.equal(
      db.getThreadContainingMsgHdr(child).flags,
      Ci.nsMsgMessageFlags.Watched
    );
    Assert.ok(db.isWatched(child.messageKey));
    Assert.equal(head.flags & Ci.nsMsgMessageFlags.Watched, 0);
    db.markThreadIgnored(thread, head.messageKey, true, listener);
    Assert.equal(thread.flags, Ci.nsMsgMessageFlags.Ignored);
    Assert.ok(db.isIgnored(child.messageKey));
    Assert.equal(db.isWatched(head.messageKey), false);
    Assert.equal(
      child.isKilled,
      false,
      "Thread ignore does not add a killed-subthread marker"
    );
    db.markThreadWatched(thread, head.messageKey, true, listener);
    Assert.equal(db.isIgnored(child.messageKey), false);
    Assert.ok(db.isWatched(child.messageKey));
    db.markThreadWatched(thread, head.messageKey, false, listener);
    Assert.equal(thread.flags, 0);
    Assert.deepEqual(events, [
      [head.messageKey, 0, Ci.nsMsgMessageFlags.Watched],
      [
        head.messageKey,
        Ci.nsMsgMessageFlags.Watched,
        Ci.nsMsgMessageFlags.Ignored,
      ],
      [
        head.messageKey,
        Ci.nsMsgMessageFlags.Ignored,
        Ci.nsMsgMessageFlags.Watched,
      ],
      [head.messageKey, Ci.nsMsgMessageFlags.Watched, 0],
    ]);
  } finally {
    db.removeListener(listener);
  }
  Assert.equal(head.flags, 0);
  Assert.equal(child.flags, 0);
});

add_task(function test_threadMarkingRejectsAnotherFoldersHandle() {
  const folder = root.createLocalSubfolder("local-thread-flags");
  const other = root.createLocalSubfolder("foreign-thread-flags");
  const head = insert(folder, "local-root@thread-flags.invalid");
  const foreign = insert(other, "foreign@thread-flags.invalid", head.messageId);
  const db = folder.msgDatabase;
  const foreignThread = other.msgDatabase.getThreadContainingMsgHdr(foreign);
  Assert.throws(
    () => db.markThreadIgnored(foreignThread, head.messageKey, true, null),
    /NS_ERROR_UNEXPECTED/
  );
  const otherHead = insert(folder, "unrelated@thread-flags.invalid");
  const unrelatedThread = db.getThreadContainingMsgHdr(otherHead);
  Assert.throws(
    () => db.markThreadWatched(unrelatedThread, head.messageKey, true, null),
    /NS_ERROR_ILLEGAL_VALUE/
  );
  Assert.equal(head.flags, 0);
  Assert.equal(foreign.flags, 0);
});

/**
 * Read the persisted word independently of thread/header caches.
 *
 * @param {nsIMsgFolder} folder - Physical folder owning the thread state.
 * @param {number} threadId - Global thread key.
 * @returns {Array|null} The stored word and SQLite type, or no metadata row.
 */
function storedFlags(folder, threadId) {
  const statement = database.connectionForTests.createStatement(
    "SELECT flags, typeof(flags) FROM main.thread_flags " +
      "WHERE folderId = :folder AND threadId = :thread"
  );
  statement.params.folder = folder.id;
  statement.params.thread = threadId;
  try {
    return statement.executeStep()
      ? [statement.getInt64(0), statement.getString(1)]
      : null;
  } finally {
    statement.finalize();
  }
}

/**
 * Read a physical header without consulting the native header cache.
 *
 * @param {number} key - Physical message key.
 * @returns {number[]|null} Stored folder, thread, parent and flags, or no row.
 */
function storedHeader(key) {
  const statement = database.connectionForTests.createStatement(
    "SELECT folderId, threadId, threadParent, flags FROM messages WHERE id = :id"
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

add_task(function test_threadFlagsPreserveTheFullUint32Word() {
  const folder = root.createLocalSubfolder("thread-word-width");
  const head = insert(folder, "width@thread-flags.invalid");
  const child = insert(
    folder,
    "width-child@thread-flags.invalid",
    head.messageId
  );
  const db = folder.msgDatabase;
  const thread = db.getThreadContainingMsgHdr(head);
  Assert.equal(thread.flags, 0);
  Assert.equal(storedFlags(folder, head.messageKey), null);
  thread.flags = 0xffffffff;
  Assert.equal(thread.flags, 0xffffffff);
  Assert.equal(db.getThreadContainingMsgHdr(child).flags, 0xffffffff);
  Assert.deepEqual(storedFlags(folder, head.messageKey), [
    0xffffffff,
    "integer",
  ]);
  thread.flags = 0x80000000;
  Assert.equal(db.getThreadContainingMsgHdr(head).flags, 0x80000000);
  Assert.deepEqual(storedFlags(folder, head.messageKey), [
    0x80000000,
    "integer",
  ]);
  thread.flags = 0;
  Assert.deepEqual(storedFlags(folder, head.messageKey), [0, "integer"]);
  Assert.deepEqual(storedHeader(child.messageKey), [
    folder.id,
    head.messageKey,
    head.messageKey,
    0,
  ]);
  Assert.equal(head.flags, 0);
  Assert.equal(child.flags, 0);
  Assert.equal(child.isKilled, false);
});

add_task(function test_threadFlagsRemainScopedToThePhysicalFolder() {
  const folder = root.createLocalSubfolder("thread-word-local");
  const other = root.createLocalSubfolder("thread-word-foreign");
  const head = insert(folder, "scope@thread-flags.invalid");
  const child = insert(
    folder,
    "scope-child@thread-flags.invalid",
    head.messageId
  );
  const foreign = insert(
    other,
    "scope-foreign@thread-flags.invalid",
    head.messageId
  );
  Assert.equal(foreign.threadId, head.messageKey);
  const db = folder.msgDatabase;
  const otherDB = other.msgDatabase;
  const otherThread = otherDB.getThreadContainingMsgHdr(foreign);
  const currentRoot = otherThread.getRootHdr();
  Assert.equal(currentRoot.messageKey, foreign.messageKey);
  Assert.notEqual(currentRoot.messageKey, head.messageKey);
  Assert.strictEqual(currentRoot.folder, other);
  Assert.equal(currentRoot.threadParent, head.messageKey);
  const roots = otherThread.enumerateMessages(0xffffffff);
  Assert.ok(roots.hasMoreElements());
  Assert.equal(roots.getNext().messageKey, foreign.messageKey);
  Assert.equal(roots.hasMoreElements(), false);
  db.markThreadWatched(
    db.getThreadContainingMsgHdr(head),
    head.messageKey,
    true,
    null
  );
  otherDB.markThreadIgnored(
    otherDB.getThreadContainingMsgHdr(foreign),
    foreign.messageKey,
    true,
    null
  );
  Assert.ok(db.isWatched(child.messageKey));
  Assert.equal(db.isIgnored(child.messageKey), false);
  Assert.ok(otherDB.isIgnored(foreign.messageKey));
  Assert.equal(otherDB.isWatched(foreign.messageKey), false);
  Assert.deepEqual(storedFlags(folder, head.messageKey), [
    Ci.nsMsgMessageFlags.Watched,
    "integer",
  ]);
  Assert.deepEqual(storedFlags(other, head.messageKey), [
    Ci.nsMsgMessageFlags.Ignored,
    "integer",
  ]);
  Assert.equal(head.flags, 0);
  Assert.equal(child.flags, 0);
  Assert.equal(foreign.flags, 0);
  Assert.equal(foreign.isKilled, false);
  Assert.deepEqual(storedHeader(foreign.messageKey), [
    other.id,
    head.messageKey,
    head.messageKey,
    0,
  ]);
});

add_task(function test_threadFlagsSurviveTheRootUntilTheLastMemberIsRemoved() {
  const folder = root.createLocalSubfolder("thread-word-root-removal");
  const head = insert(folder, "removed-root@thread-flags.invalid");
  const child = insert(folder, "survivor@thread-flags.invalid", head.messageId);
  const db = folder.msgDatabase;
  const thread = db.getThreadContainingMsgHdr(head);
  thread.flags = Ci.nsMsgMessageFlags.Watched;
  messageDB.removeMessage(head.messageKey);
  Assert.deepEqual(db.listAllKeys(), [child.messageKey]);
  Assert.equal(storedHeader(head.messageKey), null);
  Assert.deepEqual(storedHeader(child.messageKey), [
    folder.id,
    head.messageKey,
    head.messageKey,
    0,
  ]);
  Assert.equal(child.threadParent, head.messageKey);
  Assert.equal(thread.flags, Ci.nsMsgMessageFlags.Watched);
  Assert.equal(
    db.getThreadContainingMsgHdr(child).flags,
    Ci.nsMsgMessageFlags.Watched
  );
  Assert.equal(thread.numChildren, 1);
  Assert.equal(thread.numUnreadChildren, 1);
  Assert.equal(thread.getFirstUnreadChild().messageKey, child.messageKey);
  Assert.equal(thread.getRootHdr().messageKey, child.messageKey);
  Assert.notEqual(thread.getRootHdr().messageKey, head.messageKey);
  Assert.deepEqual(storedFlags(folder, head.messageKey), [
    Ci.nsMsgMessageFlags.Watched,
    "integer",
  ]);
  messageDB.removeMessage(child.messageKey);
  Assert.deepEqual(db.listAllKeys(), []);
  Assert.equal(storedFlags(folder, head.messageKey), null);
  Assert.throws(() => thread.flags, /NS_ERROR_NOT_AVAILABLE/);
  Assert.throws(() => thread.getRootHdr(), /NS_ERROR_UNEXPECTED/);
  Assert.throws(
    () => thread.enumerateMessages(0xffffffff),
    /NS_ERROR_UNEXPECTED/
  );
  Assert.throws(() => {
    thread.flags = 0;
  }, /NS_ERROR_NOT_AVAILABLE/);
});

add_task(function test_threadFlagWriteFailureDoesNotPublishANewState() {
  const folder = root.createLocalSubfolder("thread-word-write-error");
  const head = insert(folder, "write@thread-flags.invalid");
  const db = folder.msgDatabase;
  const thread = db.getThreadContainingMsgHdr(head);
  thread.flags = Ci.nsMsgMessageFlags.Watched;
  const events = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged(header, oldFlags, flags, instigator) {
      Assert.strictEqual(header.folder, folder);
      Assert.strictEqual(instigator, expectedInstigator);
      Assert.equal(
        db.getThreadContainingMsgHdr(header).flags,
        Ci.nsMsgMessageFlags.Ignored
      );
      events.push([header.messageKey, oldFlags, flags]);
    },
  };
  const expectedInstigator = listenerIdentity(listener);
  db.addListener(listener);
  const connection = database.connectionForTests;
  try {
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER reject_thread_word BEFORE INSERT ON thread_flags " +
        "WHEN NEW.folderId = " +
        folder.id +
        " AND NEW.threadId = " +
        head.messageKey +
        " BEGIN SELECT RAISE(ABORT, 'thread word'); END"
    );
    try {
      Assert.throws(
        () => db.markThreadIgnored(thread, head.messageKey, true, listener),
        error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
      );
      Assert.deepEqual(events, []);
      Assert.equal(thread.flags, Ci.nsMsgMessageFlags.Watched);
      Assert.deepEqual(storedFlags(folder, head.messageKey), [
        Ci.nsMsgMessageFlags.Watched,
        "integer",
      ]);
      Assert.equal(head.flags, 0);
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER reject_thread_word");
    }
    db.markThreadIgnored(thread, head.messageKey, true, listener);
    Assert.deepEqual(events, [
      [
        head.messageKey,
        Ci.nsMsgMessageFlags.Watched,
        Ci.nsMsgMessageFlags.Ignored,
      ],
    ]);
    Assert.equal(head.flags, 0);
  } finally {
    db.removeListener(listener);
  }
});

add_task(function test_threadFlagWritePreservesTheCallersTransaction() {
  const folder = root.createLocalSubfolder("thread-word-transaction");
  const head = insert(folder, "transaction@thread-flags.invalid");
  const db = folder.msgDatabase;
  const thread = db.getThreadContainingMsgHdr(head);
  thread.flags = Ci.nsMsgMessageFlags.Watched;
  const connection = database.connectionForTests;
  connection.beginTransaction();
  try {
    connection.executeSimpleSQL(
      "INSERT INTO folder_properties(id,name,value) VALUES(" +
        folder.id +
        ", 'thread-caller', 'pending')"
    );
    Assert.throws(
      () => db.markThreadIgnored(thread, head.messageKey, true, null),
      error => error.result == Cr.NS_ERROR_IN_PROGRESS
    );
    Assert.ok(connection.transactionInProgress);
    Assert.deepEqual(storedFlags(folder, head.messageKey), [
      Ci.nsMsgMessageFlags.Watched,
      "integer",
    ]);
    const statement = connection.createStatement(
      "SELECT value FROM folder_properties WHERE id = :folder AND name = 'thread-caller'"
    );
    statement.params.folder = folder.id;
    try {
      Assert.ok(statement.executeStep());
      Assert.equal(statement.getString(0), "pending");
    } finally {
      statement.finalize();
    }
  } finally {
    if (connection.transactionInProgress) {
      connection.rollbackTransaction();
    }
  }
  Assert.equal(thread.flags, Ci.nsMsgMessageFlags.Watched);
  const statement = connection.createStatement(
    "SELECT COUNT(*) FROM folder_properties WHERE id = :folder AND name = 'thread-caller'"
  );
  statement.params.folder = folder.id;
  try {
    Assert.ok(statement.executeStep());
    Assert.equal(statement.getInt64(0), 0);
  } finally {
    statement.finalize();
  }
});

add_task(function test_threadFlagReadFailurePropagatesThroughTheFacade() {
  const folder = root.createLocalSubfolder("thread-word-read-error");
  const head = insert(folder, "read-error@thread-flags.invalid");
  const db = folder.msgDatabase;
  const thread = db.getThreadContainingMsgHdr(head);
  thread.flags = Ci.nsMsgMessageFlags.Watched;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP VIEW thread_flags AS SELECT folderId, threadId, " +
      "abs(-9223372036854775808) AS flags FROM main.thread_flags"
  );
  try {
    Assert.throws(
      () => thread.flags,
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => db.isWatched(head.messageKey),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => db.markThreadIgnored(thread, head.messageKey, true, null),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL("DROP VIEW temp.thread_flags");
  }
  Assert.equal(thread.flags, Ci.nsMsgMessageFlags.Watched);
  Assert.deepEqual(storedFlags(folder, head.messageKey), [
    Ci.nsMsgMessageFlags.Watched,
    "integer",
  ]);
  Assert.equal(head.flags, 0);
});
