/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from head_delivery.js */

add_task(function test_reusesCachedChildWithoutDuplicateAttachment() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.ok(["mbox", "maildir"].includes(lane.store));
  const { folder } = PanoramaDelivery.createLocalFixture("init-identity");
  const id = folderDB.insertFolder(folder.id, "Cached");
  const child = Cc[
    "@mozilla.org/mail/folder-factory;1?name=mailbox"
  ].createInstance(Ci.nsIMsgFolder);
  child.initWithFolderId(id);
  child.parent = folder;
  const uri = folder.URI + "/Cached";
  Assert.strictEqual(MailServices.folderLookup.getFolderForURL(uri), child);
  Assert.deepEqual(folder.subFolders, []);
  Assert.strictEqual(folder.addSubfolder("Cached"), child);
  Assert.strictEqual(folder.addSubfolder("Cached"), child);
  Assert.deepEqual(folder.subFolders, [child]);
  Assert.equal(child.id, id);
  Assert.equal(child.parent, folder);
  Assert.equal(child.URI, uri);
  Assert.strictEqual(MailServices.folderLookup.getFolderForURL(uri), child);
  Assert.deepEqual(folderDB.getFolderChildren(folder.id), [id]);
});
