/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */

let service, root;

add_setup(function () {
  do_get_profile();
  const contract = "@mozilla.org/msgstore/berkeleystore;1";
  for (const pref of [
    "mail.serverDefaultStoreContractID",
    "mail.server.default.storeContractID",
  ]) {
    const hadValue = Services.prefs.prefHasUserValue(pref);
    const oldValue = hadValue ? Services.prefs.getCharPref(pref) : null;
    Services.prefs.setCharPref(pref, contract);
    registerCleanupFunction(() => {
      if (hadValue) {
        Services.prefs.setCharPref(pref, oldValue);
      } else {
        Services.prefs.clearUserPref(pref);
      }
    });
  }
  loadExistingDB();
  service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.strictEqual(service.QueryInterface(Ci.nsIDatabaseCore), database);
  const account = MailServices.accounts.createLocalMailAccount();
  registerCleanupFunction(() =>
    MailServices.accounts.removeAccount(account, false)
  );
  root = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  Assert.equal(root.msgStore.storeType, "mbox");
  Assert.equal(root.server.getStringValue("storeContractID"), contract);
});

add_task(function test_absentCacheLookupAndCloseDoNotOpenAnything() {
  const connection = database.connectionForTests;
  const sourceId = database.sourceId;
  const before = service.openDBs;
  const missingId = Number.MAX_SAFE_INTEGER;
  let reads = 0;
  const absent = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgFolder"]),
    get id() {
      ++reads;
      return missingId;
    },
    get filePath() {
      Assert.ok(false, "An absent close must not request a folder path");
      return null;
    },
    getFlag() {
      Assert.ok(false, "An absent close must not open a wrapper");
      return false;
    },
  };
  const path = do_get_profile().clone();
  path.append("no-open-database");
  Assert.ok(!path.exists());
  Assert.strictEqual(service.cachedDBForFolder(absent), null);
  Assert.strictEqual(service.cachedDBForFilePath(path), null);
  service.forceFolderDBClosed(absent);
  Assert.equal(reads, 2);
  Assert.deepEqual(service.openDBs, before);
  Assert.ok(!path.exists());
  const stmt = connection.createStatement(
    "SELECT COUNT(*) AS count FROM folders WHERE id=:id"
  );
  try {
    stmt.params.id = missingId;
    Assert.ok(stmt.executeStep());
    Assert.equal(stmt.row.count, 0);
  } finally {
    stmt.finalize();
  }
  Assert.strictEqual(database.connectionForTests, connection);
  Assert.equal(database.sourceId, sourceId);
});

add_task(function test_cacheUsesPhysicalFolderAndFileIdentity() {
  const firstParent = root
    .createLocalSubfolder("cache-first")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const otherParent = root
    .createLocalSubfolder("cache-other")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const first = firstParent.createLocalSubfolder("Same");
  const other = otherParent.createLocalSubfolder("Same");
  Assert.notEqual(first.id, other.id);
  const db = first.msgDatabase;
  const otherDB = other.msgDatabase;
  Assert.strictEqual(service.cachedDBForFolder(first), db);
  Assert.strictEqual(service.cachedDBForFolder(other), otherDB);
  Assert.strictEqual(service.cachedDBForFilePath(first.filePath.clone()), db);
  Assert.strictEqual(service.cachedDBForFilePath(other.filePath), otherDB);
  Assert.strictEqual(service.openFolderDB(first, false), db);
  Assert.strictEqual(service.openFolderDB(other, false), otherDB);
  Assert.equal(service.openDBs.filter(item => item == db).length, 1);
  Assert.equal(service.openDBs.filter(item => item == otherDB).length, 1);
  const key = addMessage({ folderId: first.id, subject: "first" });
  const otherKey = addMessage({ folderId: other.id, subject: "other" });
  Assert.deepEqual(db.listAllKeys(), [key]);
  Assert.deepEqual(otherDB.listAllKeys(), [otherKey]);
});

add_task(function test_forceClosedWrapperCannotReturnThroughEitherCache() {
  const folder = root.createLocalSubfolder("direct-force-close");
  const db = folder.msgDatabase;
  const key = addMessage({ folderId: folder.id });
  db.dBFolderInfo.setCharProperty("retained", "exact value");
  let gone = 0;
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onAnnouncerGoingAway(source) {
      Assert.strictEqual(source, db);
      ++gone;
    },
  };
  db.addListener(listener);
  registerCleanupFunction(() => db.removeListener(listener));
  const snapshot = service.openDBs;
  Assert.ok(snapshot.includes(db));
  db.forceClosed();
  Assert.equal(gone, 1);
  Assert.strictEqual(service.cachedDBForFolder(folder), null);
  Assert.strictEqual(service.cachedDBForFilePath(folder.filePath), null);
  Assert.ok(!service.openDBs.includes(db));
  Assert.ok(
    snapshot.includes(db),
    "A returned array retains its own references"
  );
  service.forceFolderDBClosed(folder);
  Assert.equal(gone, 1);
  Assert.strictEqual(service.cachedDBForFolder(folder), null);
  const reopened = service.openFolderDB(folder, false);
  Assert.notStrictEqual(reopened, db);
  Assert.strictEqual(folder.msgDatabase, reopened);
  Assert.deepEqual(reopened.listAllKeys(), [key]);
  Assert.equal(
    reopened.dBFolderInfo.getCharProperty("retained"),
    "exact value"
  );
  Assert.strictEqual(service.cachedDBForFilePath(folder.filePath), reopened);
});

add_task(
  function test_serviceClosePreservesReentrantReplacementAndOtherFolder() {
    const folder = root.createLocalSubfolder("service-close");
    const other = root.createLocalSubfolder("service-control");
    const db = folder.msgDatabase;
    const otherDB = other.msgDatabase;
    const connection = database.connectionForTests;
    const sourceId = database.sourceId;
    let reopened;
    let gone = 0;
    let otherAdded = 0;
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
      onAnnouncerGoingAway(source) {
        ++gone;
        Assert.strictEqual(source, db);
        Assert.strictEqual(service.cachedDBForFolder(folder), null);
        Assert.strictEqual(service.cachedDBForFilePath(folder.filePath), null);
        Assert.ok(!service.openDBs.includes(db));
        service.forceFolderDBClosed(folder);
        reopened = service.openFolderDB(folder, false);
        Assert.notStrictEqual(reopened, db);
      },
    };
    const control = {
      QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
      onAnnouncerGoingAway() {
        Assert.ok(false, "Closing one wrapper leaves the other subscribed");
      },
      onHdrAdded() {
        ++otherAdded;
      },
    };
    db.addListener(listener);
    otherDB.addListener(control);
    registerCleanupFunction(() => db.removeListener(listener));
    registerCleanupFunction(() => otherDB.removeListener(control));
    connection.beginTransaction();
    try {
      service.forceFolderDBClosed(folder);
      Assert.ok(connection.transactionInProgress);
    } finally {
      connection.rollbackTransaction();
    }
    Assert.equal(gone, 1);
    Assert.ok(reopened);
    Assert.strictEqual(service.cachedDBForFolder(folder), reopened);
    Assert.strictEqual(service.cachedDBForFilePath(folder.filePath), reopened);
    Assert.strictEqual(service.cachedDBForFolder(other), otherDB);
    Assert.ok(service.openDBs.includes(reopened));
    Assert.ok(service.openDBs.includes(otherDB));
    Assert.ok(!service.openDBs.includes(db));
    db.forceClosed();
    Assert.strictEqual(service.cachedDBForFolder(folder), reopened);
    const key = addMessage({ folderId: folder.id });
    const controlKey = addMessage({ folderId: other.id });
    Assert.deepEqual(reopened.listAllKeys(), [key]);
    Assert.deepEqual(otherDB.listAllKeys(), [controlKey]);
    Assert.equal(otherAdded, 1);
    db.removeListener(listener);
    otherDB.removeListener(control);
    Assert.strictEqual(database.connectionForTests, connection);
    Assert.equal(database.sourceId, sourceId);
  }
);

add_task(function test_lookupAndOpenErrorsDoNotPublishPartialCacheEntries() {
  const folder = root.createLocalSubfolder("lookup-control");
  const db = folder.msgDatabase;
  const before = service.openDBs;
  const failingId = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgFolder"]),
    get id() {
      throw Components.Exception(
        "id read failed",
        Cr.NS_ERROR_FILE_ACCESS_DENIED
      );
    },
  };
  Assert.throws(
    () => service.cachedDBForFolder(failingId),
    /NS_ERROR_FILE_ACCESS_DENIED/
  );
  Assert.throws(
    () => service.forceFolderDBClosed(failingId),
    /NS_ERROR_FILE_ACCESS_DENIED/
  );
  Assert.throws(
    () => service.openFolderDB(failingId, false),
    /NS_ERROR_FILE_ACCESS_DENIED/
  );
  const unusedId = folderDB.insertFolder(root.id, "failed-open");
  const failingPath = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgFolder"]),
    id: unusedId,
    getFlag() {
      return false;
    },
    get filePath() {
      throw Components.Exception(
        "path read failed",
        Cr.NS_ERROR_FILE_ACCESS_DENIED
      );
    },
  };
  Assert.throws(
    () => service.openFolderDB(failingPath, false),
    /NS_ERROR_FILE_ACCESS_DENIED/
  );
  Assert.strictEqual(service.cachedDBForFolder(failingPath), null);
  Assert.deepEqual(service.openDBs, before);
  Assert.strictEqual(service.cachedDBForFolder(folder), db);
  Assert.deepEqual(db.listAllKeys(), []);
});

add_task(function test_createNewDBStopsOnUnreadableOrAbsentParent() {
  const folder = root.createLocalSubfolder("checked-create");
  const db = folder.msgDatabase;
  const key = addMessage({ folderId: folder.id, subject: "retained" });
  db.getMsgHdrForKey(key).setStringProperty("Exact", "00042");
  const children = folderDB.getFolderChildren(root.id);
  const open = service.openDBs;
  const connection = database.connectionForTests;
  const sourceId = database.sourceId;
  let names = 0;
  let parents = 0;
  const failingName = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgFolder"]),
    id: folder.id,
    get name() {
      ++names;
      throw Components.Exception(
        "name read failed",
        Cr.NS_ERROR_FILE_ACCESS_DENIED
      );
    },
    get parent() {
      ++parents;
      return root;
    },
  };
  Assert.throws(
    () => service.createNewDB(failingName),
    /NS_ERROR_FILE_ACCESS_DENIED/,
    "A name error must propagate before any folder lookup or cache change"
  );
  Assert.equal(names, 1);
  Assert.equal(parents, 0, "A later getter must not run after the first error");
  const failingParent = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgFolder"]),
    id: folder.id,
    name: "unreadable-parent",
    get parent() {
      ++parents;
      throw Components.Exception(
        "parent read failed",
        Cr.NS_ERROR_FILE_NOT_FOUND
      );
    },
  };
  Assert.throws(
    () => service.createNewDB(failingParent),
    /NS_ERROR_FILE_NOT_FOUND/
  );
  Assert.equal(parents, 1);
  Assert.strictEqual(root.parent, null);
  Assert.throws(
    () => service.createNewDB(root),
    error => error.result === Cr.NS_ERROR_INVALID_ARG,
    "Creating a child projection requires an actual parent"
  );
  Assert.deepEqual(folderDB.getFolderChildren(root.id), children);
  Assert.deepEqual(service.openDBs, open);
  Assert.strictEqual(service.cachedDBForFolder(folder), db);
  Assert.strictEqual(service.cachedDBForFilePath(folder.filePath), db);
  Assert.strictEqual(database.connectionForTests, connection);
  Assert.equal(database.sourceId, sourceId);
  Assert.strictEqual(service.createNewDB(folder), db);
  Assert.deepEqual(db.listAllKeys(), [key]);
  Assert.equal(messageDB.getMessageProperty(key, "Exact"), "00042");
});

add_task(function test_nativeFolderResolutionUsesPhysicalId() {
  const server = MailServices.accounts.createIncomingServer(
    "native-resolver",
    "resolver.invalid",
    "imap"
  );
  const account = MailServices.accounts.createAccount();
  account.incomingServer = server;
  registerCleanupFunction(() =>
    MailServices.accounts.removeAccount(account, false)
  );
  const imapRoot = server.rootFolder;
  const imapFolder = imapRoot.QueryInterface(Ci.nsIMsgImapMailFolder);
  // Use the actual native LIST-completion producer, not legacy AddSubfolder.
  imapFolder.createClientSubfolderInfo("wire-&AOE-", "/", 0, true);
  imapFolder.createClientSubfolderInfo("unrelated-wire-name", "/", 0, true);
  const requestedId = folderDB.getFolderChildNamed(imapRoot.id, "wire-&AOE-");
  const aliasId = folderDB.getFolderChildNamed(
    imapRoot.id,
    "unrelated-wire-name"
  );
  Assert.greater(requestedId, 0);
  Assert.greater(aliasId, 0);
  const requested = imapRoot.subFolders.find(child => child.id == requestedId);
  const alias = imapRoot.subFolders.find(child => child.id == aliasId);
  Assert.ok(requested);
  Assert.ok(alias);
  Assert.notEqual(requestedId, aliasId);
  const requestedURI = requested.URI;
  const aliasURI = alias.URI;
  requested.name = "folder \u00e1";
  alias.name = "wire-&AOE-";
  Assert.equal(requested.name, "folder \u00e1");
  Assert.equal(alias.name, "wire-&AOE-");
  Assert.equal(folderDB.getFolderName(requestedId), "wire-&AOE-");
  Assert.equal(folderDB.getFolderName(aliasId), "unrelated-wire-name");
  const sourceId = database.sourceId;
  const children = folderDB.getFolderChildren(imapRoot.id);
  Assert.strictEqual(
    folderDB.getMsgFolderForFolder(requestedId),
    requested,
    "A pretty-name alias must not select another physical folder"
  );
  Assert.strictEqual(folderDB.getMsgFolderForFolder(aliasId), alias);
  const connection = database.connectionForTests;
  connection.beginTransaction();
  try {
    Assert.strictEqual(folderDB.getMsgFolderForFolder(requestedId), requested);
    Assert.ok(
      connection.transactionInProgress,
      "The reader keeps the caller TX"
    );
  } finally {
    connection.rollbackTransaction();
  }
  const key = addMessage({
    folderId: requestedId,
    subject: "physical folder resolver",
  });
  Assert.strictEqual(
    requested.msgDatabase.getMsgHdrForKey(key).folder,
    requested
  );
  Assert.equal(requested.parent, imapRoot);
  Assert.equal(alias.parent, imapRoot);
  Assert.equal(requested.URI, requestedURI);
  Assert.equal(alias.URI, aliasURI);
  Assert.strictEqual(
    MailServices.folderLookup.getFolderForURL(requestedURI),
    requested
  );
  Assert.strictEqual(
    MailServices.folderLookup.getFolderForURL(aliasURI),
    alias
  );
  Assert.deepEqual(folderDB.getFolderChildren(imapRoot.id), children);
  Assert.equal(database.sourceId, sourceId);
});
