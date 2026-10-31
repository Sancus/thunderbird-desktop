/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from head_delivery.js */

const { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);

let fixture;
add_setup(function setupFolders() {
  fixture = PanoramaDelivery.createLocalFixture("init-parent");
});

add_task(function test_rejectsCachedChildWithConflictingParent() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.ok(["mbox", "maildir"].includes(lane.store));
  const { folder, rootFolder } = fixture;
  const other = rootFolder.createLocalSubfolder("Other");
  const id = folderDB.insertFolder(folder.id, "Cached");
  const child = Cc[
    "@mozilla.org/mail/folder-factory;1?name=mailbox"
  ].createInstance(Ci.nsIMsgFolder);
  child.initWithFolderId(id);
  // Exercise a conflicting public object association, not server discovery.
  child.parent = other;
  const uri = folder.URI + "/Cached";
  Assert.strictEqual(MailServices.folderLookup.getFolderForURL(uri), child);
  Assert.throws(() => folder.addSubfolder("Cached"), /NS_ERROR_UNEXPECTED/);
  Assert.equal(child.id, id);
  Assert.equal(child.parent, other, "Failure does not steal the cached child");
  Assert.equal(child.URI, uri);
  Assert.strictEqual(MailServices.folderLookup.getFolderForURL(uri), child);
  Assert.deepEqual(folder.subFolders, []);
  Assert.deepEqual(folderDB.getFolderChildren(folder.id), [id]);
});

add_task(async function test_recursiveConflictPreservesCachedSubtree() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.ok(["mbox", "maildir"].includes(lane.store));
  const folder = fixture.rootFolder.createLocalSubfolder("init-recursion");
  PanoramaDelivery.assertFolder(folder, lane);
  const parentId = folderDB.insertFolder(folder.id, "P");
  const childId = folderDB.insertFolder(parentId, "C");
  const parentURI = folder.URI + "/P";
  const childURI = parentURI + "/C";
  const directory = folder.filePath.path + ".sbd";
  const bodies = [];
  for (const path of [
    PathUtils.join(directory, "P"),
    PathUtils.join(directory, "P.sbd", "C"),
  ]) {
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
    [parentId, folder.id, "P"],
    [childId, parentId, "C"],
  ].sort((a, b) => a[0] - b[0]);
  const statement = database.connectionForTests.createStatement(
    "SELECT id, parent, name FROM folders " +
      "WHERE id IN (:parent, :child) ORDER BY id"
  );
  registerCleanupFunction(() => statement.finalize());
  statement.params.parent = parentId;
  statement.params.child = childId;
  const before = [];
  while (statement.executeStep()) {
    before.push([statement.row.id, statement.row.parent, statement.row.name]);
  }
  statement.reset();
  Assert.deepEqual(before, expectedRows);

  const contract = "@mozilla.org/mail/folder-factory;1?name=mailbox";
  const parent = Cc[contract].createInstance(Ci.nsIMsgFolder);
  parent.initWithFolderId(parentId);
  const child = parent.getChildNamed("C");
  Assert.ok(child, "Initialization restored the real child row");
  Assert.equal(parent.id, parentId);
  Assert.equal(parent.parent, null);
  Assert.equal(parent.URI, parentURI);
  Assert.deepEqual(parent.subFolders, [child]);
  Assert.equal(child.id, childId);
  Assert.equal(child.parent, parent);
  Assert.equal(child.URI, childURI);
  Assert.strictEqual(
    MailServices.folderLookup.getFolderForURL(childURI),
    child
  );
  Assert.equal(MailServices.folderLookup.getFolderForURL(parentURI), null);
  Assert.strictEqual(
    MailServices.folderLookup.getOrCreateFolderForURL(parentURI),
    parent
  );
  Assert.deepEqual(folder.subFolders, []);

  const failed = Cc[contract].createInstance(Ci.nsIMsgFolder);
  let calls = 0;
  const cid = MockRegistrar.register(contract, () => {
    Assert.equal(
      ++calls,
      1,
      "Only the outer parent needs a new factory object"
    );
    return failed;
  });
  registerCleanupFunction(() => MockRegistrar.unregister(cid));
  Assert.throws(() => folder.addSubfolder("P"), /NS_ERROR_UNEXPECTED/);
  MockRegistrar.unregister(cid);
  Assert.equal(calls, 1, "The conflict is with the live recursive child");
  Assert.equal(failed.id, 0);
  Assert.equal(failed.parent, null);
  Assert.equal(failed.URI, "");
  Assert.throws(
    () => failed.numSubFolders,
    error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
    "A failed initializer cannot enumerate a partial subtree"
  );
  Assert.equal(parent.id, parentId);
  Assert.equal(parent.parent, null);
  Assert.equal(parent.URI, parentURI);
  Assert.deepEqual(parent.subFolders, [child]);
  Assert.equal(child.id, childId);
  Assert.equal(child.parent, parent);
  Assert.equal(child.URI, childURI);
  Assert.strictEqual(
    MailServices.folderLookup.getFolderForURL(childURI),
    child
  );
  Assert.deepEqual(folder.subFolders, []);
  Assert.equal(MailServices.folderLookup.getFolderForURL(parentURI), null);
  // Panorama cannot create an absent folder by URI.
  Assert.throws(
    () => MailServices.folderLookup.getOrCreateFolderForURL(parentURI),
    /NS_ERROR_UNEXPECTED/,
    "Rollback evicts the failed parent even while it is held alive"
  );
  statement.params.parent = parentId;
  statement.params.child = childId;
  const after = [];
  while (statement.executeStep()) {
    after.push([statement.row.id, statement.row.parent, statement.row.name]);
  }
  statement.reset();
  Assert.deepEqual(after, expectedRows);
  for (const body of bodies) {
    Assert.equal(
      await IOUtils.readUTF8(body),
      "From sender@example.invalid\nretained body\n"
    );
  }

  child.parent = null;
  Assert.equal(MailServices.folderLookup.getFolderForURL(childURI), null);
  MailServices.folderLookup.cache(parentURI, parent);
  MailServices.folderLookup.cache(parentURI, parent);
  Assert.strictEqual(
    MailServices.folderLookup.getOrCreateFolderForURL(parentURI),
    parent
  );
  const replacement = folder.addSubfolder("P");
  const replacementChild = replacement.getChildNamed("C");
  Assert.notEqual(replacement, parent);
  Assert.notEqual(replacement, failed);
  Assert.notEqual(replacementChild, child);
  Assert.equal(replacement.id, parentId);
  Assert.equal(replacement.parent, folder);
  Assert.equal(replacement.URI, parentURI);
  Assert.equal(replacementChild.id, childId);
  Assert.equal(replacementChild.parent, replacement);
  Assert.equal(replacementChild.URI, childURI);
  Assert.strictEqual(
    MailServices.folderLookup.getFolderForURL(parentURI),
    replacement
  );
  Assert.strictEqual(
    MailServices.folderLookup.getFolderForURL(childURI),
    replacementChild
  );
  MailServices.folderLookup.evictFolder(parent);
  MailServices.folderLookup.evictFolder(child);
  Assert.strictEqual(
    MailServices.folderLookup.getFolderForURL(parentURI),
    replacement
  );
  Assert.strictEqual(
    MailServices.folderLookup.getFolderForURL(childURI),
    replacementChild
  );
  Assert.strictEqual(folder.addSubfolder("P"), replacement);
  Assert.deepEqual(folder.subFolders, [replacement]);
  Assert.deepEqual(replacement.subFolders, [replacementChild]);
  Assert.equal(parent.id, parentId);
  Assert.equal(parent.parent, null);
  Assert.equal(child.id, childId);
  Assert.equal(child.parent, null);
  statement.params.parent = parentId;
  statement.params.child = childId;
  const restored = [];
  while (statement.executeStep()) {
    restored.push([statement.row.id, statement.row.parent, statement.row.name]);
  }
  statement.reset();
  Assert.deepEqual(restored, expectedRows);
  for (const body of bodies) {
    Assert.equal(
      await IOUtils.readUTF8(body),
      "From sender@example.invalid\nretained body\n"
    );
  }
});
