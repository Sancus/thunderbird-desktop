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
    Assert.equal(item.numSubFolders, 0);
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
