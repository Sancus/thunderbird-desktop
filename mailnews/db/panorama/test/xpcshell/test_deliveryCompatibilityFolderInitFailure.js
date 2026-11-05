/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from head_delivery.js */

const { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);

add_task(async function test_failedDescendantKeepsRowsBodiesAndExistingChild() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.ok(["mbox", "maildir"].includes(lane.store));
  const { folder } = PanoramaDelivery.createLocalFixture("init-failure");
  const stable = folder.createLocalSubfolder("Stable");
  const stableURI = stable.URI;
  const pendingId = folderDB.insertFolder(folder.id, "Pending");
  const readyId = folderDB.insertFolder(pendingId, "AReady");
  const branchId = folderDB.insertFolder(pendingId, "BBranch");
  const leafId = folderDB.insertFolder(branchId, "Leaf");
  const pendingURI = folder.URI + "/Pending";
  const branchURI = pendingURI + "/BBranch";
  const directory = folder.filePath.path + ".sbd";
  const paths = [
    PathUtils.join(directory, "Pending"),
    PathUtils.join(directory, "Pending.sbd", "AReady"),
    PathUtils.join(directory, "Pending.sbd", "BBranch"),
    PathUtils.join(directory, "Pending.sbd", "BBranch.sbd", "Leaf"),
  ];
  const bodies = [];
  for (const path of paths) {
    let body = path;
    if (lane.store == "maildir") {
      await IOUtils.makeDirectory(PathUtils.join(path, "tmp"));
      body = PathUtils.join(path, "cur", "retained");
    }
    await IOUtils.makeDirectory(PathUtils.parent(body));
    await IOUtils.writeUTF8(
      body,
      "From sender@example.invalid\nretained body\n"
    );
    bodies.push(body);
  }
  const expectedRows = [
    [stable.id, folder.id, "Stable"],
    [pendingId, folder.id, "Pending"],
    [readyId, pendingId, "AReady"],
    [branchId, pendingId, "BBranch"],
    [leafId, branchId, "Leaf"],
  ].sort((a, b) => a[0] - b[0]);
  const statement = database.connectionForTests.createStatement(
    "SELECT id, parent, name FROM folders " +
      "WHERE id IN (:stable, :pending, :ready, :branch, :leaf) ORDER BY id"
  );
  registerCleanupFunction(() => statement.finalize());
  statement.params.stable = stable.id;
  statement.params.pending = pendingId;
  statement.params.ready = readyId;
  statement.params.branch = branchId;
  statement.params.leaf = leafId;
  const before = [];
  while (statement.executeStep()) {
    before.push([statement.row.id, statement.row.parent, statement.row.name]);
  }
  statement.reset();
  Assert.deepEqual(before, expectedRows);

  const events = [];
  const listener = {
    folderAdded(item) {
      events.push(item);
    },
  };
  MailServices.mfn.addListener(listener, MailServices.mfn.folderAdded);
  registerCleanupFunction(() => MailServices.mfn.removeListener(listener));

  const contract = "@mozilla.org/mail/folder-factory;1?name=mailbox";
  const created = Array.from({ length: 3 }, () =>
    Cc[contract].createInstance(Ci.nsIMsgFolder)
  );
  let calls = 0;
  let witnessed = false;
  const cid = MockRegistrar.register(contract, () => {
    if (++calls == 4) {
      Assert.equal(created[0].id, pendingId);
      Assert.equal(created[1].id, readyId);
      Assert.equal(created[2].id, branchId);
      Assert.strictEqual(
        MailServices.folderLookup.getOrCreateFolderForURL(branchURI),
        created[2],
        "The failing descendant was published before its child factory ran"
      );
      witnessed = true;
      throw Components.Exception(
        "Descendant factory fault",
        Cr.NS_ERROR_FAILURE
      );
    }
    return created[calls - 1];
  });
  registerCleanupFunction(() => MockRegistrar.unregister(cid));
  Assert.throws(() => folder.addSubfolder("Pending"), /NS_ERROR_FAILURE/);
  MockRegistrar.unregister(cid);
  Assert.ok(witnessed, "The fault occurred inside the descendant initializer");
  Assert.equal(calls, 4);
  Assert.throws(
    () => created[0].initWithFolderId(pendingId),
    /NS_ERROR_ALREADY_INITIALIZED/,
    "A retained failed object cannot be initialized again"
  );
  statement.params.stable = stable.id;
  statement.params.pending = pendingId;
  statement.params.ready = readyId;
  statement.params.branch = branchId;
  statement.params.leaf = leafId;
  const after = [];
  while (statement.executeStep()) {
    after.push([statement.row.id, statement.row.parent, statement.row.name]);
  }
  statement.reset();
  Assert.deepEqual(
    after,
    expectedRows,
    "Failure preserves the actual folder rows"
  );

  Assert.deepEqual(
    folder.subFolders,
    [stable],
    "No partial child was attached"
  );
  for (const item of created) {
    Assert.equal(item.id, 0, "Failed objects do not retain initialized IDs");
    Assert.equal(item.parent, null);
    Assert.throws(
      () => item.numSubFolders,
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
      "A failed initializer cannot enumerate a partial subtree"
    );
  }
  for (const uri of [pendingURI, pendingURI + "/AReady", branchURI]) {
    Assert.equal(MailServices.folderLookup.getFolderForURL(uri), null);
  }
  Assert.strictEqual(
    MailServices.folderLookup.getFolderForURL(stableURI),
    stable
  );
  Assert.equal(stable.parent, folder);
  Assert.equal(stable.URI, stableURI);
  Assert.deepEqual(
    folderDB.getFolderChildren(folder.id).sort(),
    [stable.id, pendingId].sort()
  );
  Assert.deepEqual(
    folderDB.getFolderChildren(pendingId).sort(),
    [readyId, branchId].sort()
  );
  Assert.deepEqual(folderDB.getFolderChildren(branchId), [leafId]);
  for (const body of bodies) {
    Assert.equal(
      await IOUtils.readUTF8(body),
      "From sender@example.invalid\nretained body\n"
    );
  }
  Assert.deepEqual(
    events,
    [],
    "Failed restoration emits no folder-added event"
  );

  const recovered = folder.addSubfolder("Pending");
  Assert.notEqual(recovered, created[0], "Retry creates a fresh object");
  Assert.equal(recovered.id, pendingId);
  Assert.equal(recovered.parent, folder);
  Assert.equal(recovered.URI, pendingURI);
  Assert.equal(
    recovered.generateMessageURI(7),
    pendingURI.replace("mailbox:", "mailbox-message:") + "#7"
  );
  const ready = recovered.getChildNamed("AReady");
  const branch = recovered.getChildNamed("BBranch");
  const leaf = branch.getChildNamed("Leaf");
  for (const [item, id, parent, uri] of [
    [ready, readyId, recovered, pendingURI + "/AReady"],
    [branch, branchId, recovered, branchURI],
    [leaf, leafId, branch, branchURI + "/Leaf"],
  ]) {
    Assert.equal(item.id, id);
    Assert.equal(item.parent, parent);
    Assert.equal(item.URI, uri);
    Assert.strictEqual(MailServices.folderLookup.getFolderForURL(uri), item);
  }
  Assert.strictEqual(folder.addSubfolder("Pending"), recovered);
  Assert.deepEqual(folder.subFolders, [stable, recovered]);
  Assert.deepEqual(recovered.subFolders, [ready, branch]);
  Assert.deepEqual(branch.subFolders, [leaf]);
  Assert.deepEqual(
    events,
    [],
    "Repeated restoration emits no folder-added event"
  );
  for (const body of bodies) {
    Assert.equal(
      await IOUtils.readUTF8(body),
      "From sender@example.invalid\nretained body\n"
    );
  }
});

/**
 * Reads the actual native record without changing its reserved datum.
 *
 * @param {number} folderId - The physical ID captured before invalidation.
 * @returns {string} The complete version-one origin bytes.
 */
function failureOriginText(folderId) {
  const statement = database.connectionForTests.createStatement(
    "SELECT value FROM folder_properties WHERE id = :id " +
      "AND name = 'panoramaCacheImportOrigin'"
  );
  try {
    statement.params.id = folderId;
    Assert.ok(statement.executeStep(), "Actual discovery produced the origin");
    const text = statement.getUTF8String(0);
    Assert.ok(!statement.executeStep());
    Assert.equal(text.split("\n")[0], "1");
    return text;
  } finally {
    statement.finalize();
  }
}

/**
 * Prepares a native root's real child store before ordinary initialization.
 *
 * @param {string} label - The independent ordinary fixture name.
 * @returns {Promise<nsIMsgFolder>} The actual discovered child.
 */
async function createFailureOriginChild(label) {
  const lane = PanoramaDelivery.expectedLane();
  do_get_profile();
  loadExistingDB();
  const server = MailServices.accounts.createIncomingServer(
    label,
    label + ".invalid",
    "none"
  );
  registerCleanupFunction(() =>
    MailServices.accounts.removeIncomingServer(server, false)
  );
  server.setStringValue(
    "storeContractID",
    {
      mbox: "@mozilla.org/msgstore/berkeleystore;1",
      maildir: "@mozilla.org/msgstore/maildirstore;1",
    }[lane.store]
  );
  const directory = do_get_profile();
  directory.append(label);
  await IOUtils.makeDirectory(directory.path);
  server.localPath = directory;
  let body = PathUtils.join(directory.path, "Observed");
  if (lane.store == "maildir") {
    await IOUtils.makeDirectory(PathUtils.join(body, "tmp"));
    body = PathUtils.join(body, "cur", "retained");
  }
  await IOUtils.makeDirectory(PathUtils.parent(body));
  await IOUtils.writeUTF8(body, "From sender@invalid\nretained origin body\n");
  const folder = server.rootFolder.getChildNamed("Observed");
  Assert.ok(folder, "Normal root discovery created the child");
  const origin = failureOriginText(folder.id).split("\n");
  Assert.equal(Number(origin[7]), 0, "No explicit choice before the control");
  return folder;
}

add_task(async function test_originSourceAndClosedOwnerFailuresPreserveState() {
  const folder = await createFailureOriginChild("origin-source-failure");
  const id = folder.id;
  const db = folder.msgDatabase;
  const info = db.dBFolderInfo;
  const original = failureOriginText(id);
  const source = original.split("\n")[1];
  const flags = folder.flags;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "UPDATE database_identity SET sourceId = '{12345678-1234-1234-1234-123456789abc}'"
  );
  try {
    Assert.throws(() => {
      folder.flags = flags;
    }, /NS_ERROR_NOT_AVAILABLE/);
    Assert.throws(() => info.orFlags(0), /NS_ERROR_NOT_AVAILABLE/);
    Assert.equal(failureOriginText(id), original);
    Assert.equal(folder.flags, flags);
  } finally {
    const restore = connection.createStatement(
      "UPDATE database_identity SET sourceId = :source"
    );
    try {
      restore.params.source = source;
      restore.execute();
    } finally {
      restore.finalize();
    }
  }
  db.forceClosed();
  Assert.throws(() => {
    info.flags = 0;
  }, /NS_ERROR_NOT_AVAILABLE/);
  Assert.equal(
    failureOriginText(id),
    original,
    "Closed owner cannot record or write"
  );
  Assert.equal(folder.msgDatabase.dBFolderInfo.flags >>> 0, flags >>> 0);
  Assert.equal(
    failureOriginText(id),
    original,
    "Ordinary DB reopen does not reset origin"
  );
});

add_task(async function test_failedVetoKeepsFlagsAndCallerTransaction() {
  const folder = await createFailureOriginChild("origin-write-failure");
  const id = folder.id;
  const info = folder.msgDatabase.dBFolderInfo;
  const connection = database.connectionForTests;
  const original = failureOriginText(id);
  const flags = folder.flags;
  let callbacks = 0;
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIFolderListener"]),
    onFolderIntPropertyChanged(item, property) {
      if (item == folder && property == "FolderFlag") {
        callbacks++;
      }
    },
  };
  folder.AddFolderListener(listener);
  registerCleanupFunction(() => folder.RemoveFolderListener(listener));
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_cache_origin_attempt BEFORE INSERT ON folder_properties " +
      "WHEN NEW.name = 'panoramaCacheImportOrigin' " +
      "BEGIN SELECT RAISE(ABORT, 'origin attempt write fault'); END"
  );
  try {
    Assert.throws(() => {
      folder.flags = flags;
    }, /NS_ERROR_STORAGE_CONSTRAINT/);
    Assert.throws(() => info.orFlags(0), /NS_ERROR_STORAGE_CONSTRAINT/);
    Assert.equal(
      failureOriginText(id),
      original,
      "Failed veto rolls back its record"
    );
    Assert.equal(folderDB.getFolderFlags(folder.id), flags);
    Assert.equal(
      folder.flags,
      flags,
      "Failure precedes even an equal-word return"
    );
    Assert.ok(
      !connection.transactionInProgress,
      "Only the failed owning transaction ended"
    );
    Assert.equal(callbacks, 0);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_cache_origin_attempt");
  }
  connection.beginTransaction();
  try {
    Assert.throws(() => folder.clearFlag(0), /NS_ERROR_IN_PROGRESS/);
    Assert.throws(() => info.andFlags(-1), /NS_ERROR_IN_PROGRESS/);
    Assert.ok(
      connection.transactionInProgress,
      "A foreign transaction is still owned by its caller"
    );
    Assert.equal(failureOriginText(id), original);
    Assert.equal(folderDB.getFolderFlags(folder.id), flags);
    Assert.equal(callbacks, 0);
  } finally {
    connection.rollbackTransaction();
  }
  // A later ordinary explicit attempt may succeed; it is not cache recovery.
  folder.flags = flags;
  Assert.equal(Number(failureOriginText(id).split("\n")[7]), 0xa8000010);
  Assert.equal(folder.flags, flags);
  Assert.equal(callbacks, 0);
});
