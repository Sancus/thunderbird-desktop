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

add_task(function test_explicitGoingAwayKeepsScopeAndAllowsSelfRemoval() {
  const first = root.createLocalSubfolder("going-away-first").msgDatabase;
  const second = root.createLocalSubfolder("going-away-second").msgDatabase;
  const calls = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onAnnouncerGoingAway(source) {
      calls.push(source);
      source.removeListener(listener);
    },
  };
  first.addListener(listener);
  second.addListener(listener);
  try {
    first.notifyAnnouncerGoingAway();
    first.notifyAnnouncerGoingAway();
    Assert.equal(calls.length, 1);
    Assert.strictEqual(calls[0], first);
    second.notifyAnnouncerGoingAway();
    Assert.equal(calls.length, 2);
    Assert.strictEqual(calls[1], second);
  } finally {
    first.removeListener(listener);
    second.removeListener(listener);
  }
});

add_task(function test_closeKeepsSubscriptionWithoutCommittingForeignWork() {
  const folder = root.createLocalSubfolder("ordinary-close");
  const db = folder.msgDatabase;
  const calls = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrAdded(header) {
      calls.push(header.messageKey);
    },
    onAnnouncerGoingAway() {
      Assert.ok(false, "Ordinary close does not force listeners away");
    },
  };
  db.addListener(listener);
  try {
    const connection = database.connectionForTests;
    connection.beginTransaction();
    try {
      db.close(false);
      Assert.ok(connection.transactionInProgress);
      db.close(true);
      Assert.ok(connection.transactionInProgress);
    } finally {
      connection.rollbackTransaction();
    }
    Assert.strictEqual(folder.msgDatabase, db);
    const key = addMessage({ folderId: folder.id });
    Assert.deepEqual(calls, [key]);
    Assert.deepEqual(db.listAllKeys(), [key]);
  } finally {
    db.removeListener(listener);
  }
});

add_task(function test_forceCloseReopensOnlyItsWrapperAndPreservesRows() {
  const folder = root.createLocalSubfolder("forced-close");
  const other = root.createLocalSubfolder("still-open");
  const db = folder.msgDatabase;
  const otherDB = other.msgDatabase;
  const key = addMessage({ folderId: folder.id });
  db.dBFolderInfo.setCharProperty("close-preserved", "exact value");
  let gone = 0;
  let oldAdds = 0;
  let otherAdds = 0;
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onAnnouncerGoingAway(source) {
      Assert.strictEqual(source, db);
      ++gone;
      source.removeListener(listener);
    },
    onHdrAdded() {
      ++oldAdds;
    },
  };
  const otherListener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onAnnouncerGoingAway() {
      Assert.ok(false, "The other folder remains open");
    },
    onHdrAdded() {
      ++otherAdds;
    },
  };
  db.addListener(listener);
  otherDB.addListener(otherListener);
  try {
    db.forceClosed();
    db.forceClosed();
    Assert.equal(gone, 1);
    Assert.throws(() => db.addListener(listener), /NS_ERROR_NOT_AVAILABLE/);
    Assert.throws(() => db.folder, /NS_ERROR_NOT_AVAILABLE/);
    const reopened = folder.msgDatabase;
    Assert.notStrictEqual(reopened, db);
    Assert.strictEqual(reopened.folder, folder);
    Assert.strictEqual(folder.msgDatabase, reopened);
    Assert.equal(
      reopened.dBFolderInfo.getCharProperty("close-preserved"),
      "exact value"
    );
    Assert.deepEqual(reopened.listAllKeys(), [key]);
    const next = addMessage({ folderId: folder.id });
    Assert.deepEqual(reopened.listAllKeys(), [key, next]);
    Assert.equal(oldAdds, 0);
    const otherKey = addMessage({ folderId: other.id });
    Assert.strictEqual(other.msgDatabase, otherDB);
    Assert.deepEqual(otherDB.listAllKeys(), [otherKey]);
    Assert.equal(otherAdds, 1);
  } finally {
    db.removeListener(listener);
    otherDB.removeListener(otherListener);
  }
});

add_task(function test_goingAwayCanReenterForceCloseAndReopen() {
  const folder = root.createLocalSubfolder("reentrant-close");
  const db = folder.msgDatabase;
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  let firstCalls = 0;
  let secondCalls = 0;
  let reopened;
  const first = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onAnnouncerGoingAway(source) {
      ++firstCalls;
      Assert.strictEqual(source, db);
      source.forceClosed();
      source.notifyAnnouncerGoingAway();
      reopened = service.openFolderDB(folder, false);
      Assert.notStrictEqual(reopened, db);
    },
  };
  const second = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onAnnouncerGoingAway(source) {
      ++secondCalls;
      Assert.strictEqual(source, db);
    },
  };
  db.addListener(first);
  db.addListener(second);
  try {
    db.notifyAnnouncerGoingAway();
    Assert.equal(firstCalls, 1);
    Assert.equal(secondCalls, 1);
    Assert.strictEqual(folder.msgDatabase, reopened);
    Assert.strictEqual(service.openFolderDB(folder, false), reopened);
    db.forceClosed();
    Assert.equal(firstCalls, 1);
    Assert.equal(secondCalls, 1);
  } finally {
    db.removeListener(first);
    db.removeListener(second);
  }
});

add_task(function test_forceCloseDuringPublicationKeepsHeaderAndOneEvent() {
  const folder = root.createLocalSubfolder("close-on-add");
  const db = folder.msgDatabase;
  const calls = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrAdded(header) {
      calls.push(["add", header.messageKey]);
      db.forceClosed();
    },
    onAnnouncerGoingAway(source) {
      Assert.strictEqual(source, db);
      calls.push(["away"]);
    },
  };
  db.addListener(listener);
  try {
    const draft = db.createNewHdr();
    draft.messageId = "close-on-add@lifetime.invalid";
    const live = db.attachHdr(draft, true);
    Assert.deepEqual(calls, [["add", live.messageKey], ["away"]]);
    const reopened = folder.msgDatabase;
    Assert.notStrictEqual(reopened, db);
    Assert.equal(live.folder, folder);
    Assert.equal(live.messageId, "close-on-add@lifetime.invalid");
    Assert.deepEqual(reopened.listAllKeys(), [live.messageKey]);
    addMessage({ folderId: folder.id });
    Assert.equal(calls.length, 2);
  } finally {
    db.removeListener(listener);
  }
});

/**
 * Keep a replacement opened during a real folder close callback.
 *
 * @param {string} method - Existing nsIMsgFolder close method.
 * @param {string} name - Unique child folder name.
 */
function checkFolderCloseReplacement(method, name) {
  const folder = root.createLocalSubfolder(name);
  const other = root.createLocalSubfolder(name + "-other");
  const db = folder.msgDatabase;
  const otherDB = other.msgDatabase;
  const key = addMessage({ folderId: folder.id });
  const otherKey = addMessage({ folderId: other.id });
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  const connection = database.connectionForTests;
  let calls = 0;
  let replacement;
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onAnnouncerGoingAway(source) {
      Assert.strictEqual(source, db);
      ++calls;
      source.removeListener(listener);
      replacement = folder.msgDatabase;
      Assert.notStrictEqual(replacement, db);
      Assert.strictEqual(replacement.folder, folder);
    },
  };
  db.addListener(listener);
  try {
    folder[method]();
    Assert.equal(calls, 1);
    Assert.ok(folder.databaseOpen, "the reentrant replacement stays attached");
    Assert.strictEqual(service.cachedDBForFolder(folder), replacement);
    Assert.strictEqual(
      service.cachedDBForFilePath(folder.filePath),
      replacement
    );
    Assert.strictEqual(folder.msgDatabase, replacement);
    Assert.deepEqual(replacement.listAllKeys(), [key]);
    Assert.strictEqual(other.msgDatabase, otherDB);
    Assert.deepEqual(otherDB.listAllKeys(), [otherKey]);
    Assert.strictEqual(database.connectionForTests, connection);
    db.forceClosed();
    Assert.equal(calls, 1);
  } finally {
    db.removeListener(listener);
  }
}

add_task(function test_folderClosePreservesReentrantReplacement() {
  checkFolderCloseReplacement("CloseDatabase", "folder-close-replacement");
});

add_task(function test_folderForceClosePreservesReentrantReplacement() {
  checkFolderCloseReplacement("ForceDBClosed", "folder-force-replacement");
});

add_task(function test_oldAnnouncerCannotDetachTheCurrentWrapper() {
  const folder = root.createLocalSubfolder("old-announcer");
  const oldDB = folder.msgDatabase;
  const key = addMessage({ folderId: folder.id });
  oldDB.forceClosed();
  const current = folder.msgDatabase;
  Assert.notStrictEqual(current, oldDB);
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  folder.QueryInterface(Ci.nsIDBChangeListener).onAnnouncerGoingAway(oldDB);
  Assert.ok(folder.databaseOpen, "a different announcer cannot detach it");
  Assert.strictEqual(folder.msgDatabase, current);
  Assert.strictEqual(service.cachedDBForFolder(folder), current);
  Assert.strictEqual(current.folder, folder);
  Assert.deepEqual(current.listAllKeys(), [key]);
});

add_task(function test_pseudoKeyCursorIsLocalAndDoesNotAllocatePhysicalKeys() {
  const folder = root.createLocalSubfolder("pseudo-key-cursor");
  const other = root.createLocalSubfolder("pseudo-key-other");
  const db = folder.msgDatabase;
  const otherDB = other.msgDatabase;
  const first = addMessage({ folderId: folder.id });
  Assert.equal(db.nextPseudoMsgKey, 0xfffffff0);
  Assert.equal(db.nextPseudoMsgKey, 0xffffffef);
  Assert.equal(otherDB.nextPseudoMsgKey, 0xfffffff0);
  db.nextPseudoMsgKey = 42;
  Assert.equal(db.nextPseudoMsgKey, 42);
  db.close(false);
  Assert.strictEqual(folder.msgDatabase, db);
  Assert.equal(db.nextPseudoMsgKey, 41, "ordinary close keeps this cursor");
  Assert.equal(otherDB.nextPseudoMsgKey, 0xffffffef);
  db.nextPseudoMsgKey = 0;
  Assert.equal(db.nextPseudoMsgKey, 0);
  Assert.equal(db.nextPseudoMsgKey, 0xffffffff, "retain the unsigned cursor");
  db.nextPseudoMsgKey = first;
  Assert.equal(
    db.nextPseudoMsgKey,
    first,
    "a cursor value is not a reservation"
  );
  Assert.deepEqual(db.listAllKeys(), [first]);
  const second = addMessage({ folderId: folder.id });
  Assert.equal(second, first + 1, "cursor access does not advance allocation");
  db.forceClosed();
  Assert.throws(() => db.nextPseudoMsgKey, /NS_ERROR_NOT_AVAILABLE/);
  Assert.throws(() => {
    db.nextPseudoMsgKey = 90;
  }, /NS_ERROR_NOT_AVAILABLE/);
  const replacement = folder.msgDatabase;
  Assert.notStrictEqual(replacement, db);
  Assert.equal(replacement.nextPseudoMsgKey, 0xfffffff0);
  Assert.deepEqual(replacement.listAllKeys(), [first, second]);
});

add_task(function test_pseudoKeyFailuresPreserveCursorAndCallerTransaction() {
  const folder = root.createLocalSubfolder("pseudo-key-source");
  const db = folder.msgDatabase;
  const id = folder.id;
  const connection = database.connectionForTests;
  db.nextPseudoMsgKey = 77;
  connection.beginTransaction();
  const update = connection.createStatement(
    "UPDATE database_identity SET sourceId = :source"
  );
  try {
    Assert.equal(db.nextPseudoMsgKey, 77);
    db.nextPseudoMsgKey = 88;
    update.params.source = Services.uuid.generateUUID().toString();
    update.execute();
    Assert.throws(() => db.nextPseudoMsgKey, /NS_ERROR_NOT_AVAILABLE/);
    Assert.throws(() => {
      db.nextPseudoMsgKey = 9;
    }, /NS_ERROR_NOT_AVAILABLE/);
    Assert.ok(connection.transactionInProgress);
  } finally {
    update.finalize();
    connection.rollbackTransaction();
  }
  Assert.equal(
    db.nextPseudoMsgKey,
    88,
    "failed reads/writes retain the cursor"
  );
  connection.beginTransaction();
  const remove = connection.createStatement(
    "DELETE FROM folders WHERE id = :id"
  );
  try {
    remove.params.id = id;
    remove.execute();
    Assert.throws(() => db.nextPseudoMsgKey, /NS_ERROR_NOT_AVAILABLE/);
    Assert.throws(() => {
      db.nextPseudoMsgKey = 9;
    }, /NS_ERROR_NOT_AVAILABLE/);
    Assert.ok(connection.transactionInProgress);
  } finally {
    remove.finalize();
    connection.rollbackTransaction();
  }
  Assert.equal(db.nextPseudoMsgKey, 87, "missing folder did not change state");
  connection.executeSimpleSQL(
    "ALTER TABLE database_identity RENAME TO unavailable_pseudo_identity"
  );
  try {
    Assert.throws(() => db.nextPseudoMsgKey, /NS_ERROR_FAILURE/);
    Assert.throws(() => {
      db.nextPseudoMsgKey = 9;
    }, /NS_ERROR_FAILURE/);
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_pseudo_identity RENAME TO database_identity"
    );
  }
  Assert.equal(db.nextPseudoMsgKey, 86, "storage errors do not consume state");
});
