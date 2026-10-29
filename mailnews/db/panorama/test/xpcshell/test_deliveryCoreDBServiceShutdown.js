/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */

add_task(function test_startupErrorStopsAccountInitialization() {
  const file = do_get_profile().clone();
  file.append("panorama.sqlite");
  const connection = Services.storage.openDatabase(file);
  connection.schemaVersion = 0x7fffffff;
  connection.close();

  Assert.throws(
    () =>
      Cc["@mozilla.org/messenger/account-manager;1"].getService(
        Ci.nsIMsgAccountManager
      ),
    error => error.result === Cr.NS_ERROR_XPC_GS_RETURNED_FAILURE,
    "The service factory must fail when database startup fails"
  );
  const refused = Cc["@mozilla.org/mailnews/database-core;1"].getService(
    Ci.nsIDatabaseCore
  );
  Assert.throws(() => refused.startup(), /NS_ERROR_NOT_AVAILABLE/);
  Assert.ok(file.exists(), "A refused database remains in the profile");
  const retained = Services.storage.openDatabase(file);
  try {
    Assert.equal(retained.schemaVersion, 0x7fffffff);
    Assert.ok(!retained.transactionInProgress);
    // Only the test repairs its unsupported version before normal startup.
    retained.schemaVersion = 0;
  } finally {
    retained.close();
  }
  installDB();
  Assert.ok(database.sourceId, "The repaired profile can initialize normally");
});

add_task(function test_shutdownClosesOwnedWrappersBeforeNativeState() {
  do_get_profile();
  loadExistingDB();
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.strictEqual(service.QueryInterface(Ci.nsIDatabaseCore), database);
  const connection = database.connectionForTests;
  const rootId = folderDB.insertRoot("service-shutdown");
  const handles = [];
  const wrappers = [];
  const calls = [];
  // These handles exercise the service cache and announcer contract only.
  // SQL folders are real; this test does not claim provider or folder lookup coverage.
  for (const name of ["first", "other"]) {
    const id = folderDB.insertFolder(rootId, name);
    const path = do_get_profile().clone();
    path.append(name);
    const handle = {
      QueryInterface: ChromeUtils.generateQI(["nsIMsgFolder"]),
      id,
      filePath: path,
      getFlag() {
        return false;
      },
    };
    handles.push(handle);
    const db = service.openFolderDB(handle, false);
    wrappers.push(db);
    const key = addMessage({ folderId: id, subject: name });
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
      onAnnouncerGoingAway(source) {
        Assert.strictEqual(source, db);
        calls.push(name);
        Assert.deepEqual(service.openDBs, []);
        Assert.strictEqual(service.cachedDBForFolder(handle), null);
        Assert.strictEqual(service.cachedDBForFilePath(path), null);
        Assert.equal(messageDB.getMessage(key).subject, name);
        Assert.strictEqual(database.connectionForTests, connection);
        Assert.throws(
          () => service.openFolderDB(handle, false),
          /NS_ERROR_NOT_AVAILABLE/
        );
        Assert.throws(
          () => service.createNewDB(handle),
          /NS_ERROR_NOT_AVAILABLE/
        );
        Assert.throws(() => database.startup(), /NS_ERROR_NOT_AVAILABLE/);
        database
          .QueryInterface(Ci.nsIObserver)
          .observe(null, "profile-before-change", null);
        source.forceClosed();
      },
    };
    db.addListener(listener);
  }
  database
    .QueryInterface(Ci.nsIObserver)
    .observe(null, "profile-before-change", null);
  Assert.deepEqual(calls.sort(), ["first", "other"]);
  Assert.deepEqual(service.openDBs, []);
  for (let i = 0; i < handles.length; ++i) {
    Assert.strictEqual(service.cachedDBForFolder(handles[i]), null);
    Assert.strictEqual(service.cachedDBForFilePath(handles[i].filePath), null);
    service.forceFolderDBClosed(handles[i]);
    wrappers[i].forceClosed();
    Assert.throws(() => wrappers[i].folder, /NS_ERROR_NOT_AVAILABLE/);
  }
  Assert.equal(calls.length, 2);
});
