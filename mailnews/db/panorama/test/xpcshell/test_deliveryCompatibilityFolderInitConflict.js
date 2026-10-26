/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from head_delivery.js */

add_task(function test_rejectsConflictingLiveIdentity() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.ok(["mbox", "maildir"].includes(lane.store));
  const { folder } = PanoramaDelivery.createLocalFixture("init-conflict");
  const child = folder.createLocalSubfolder("Existing");
  const id = child.id;
  const uri = child.URI;
  const replacement = Cc[
    "@mozilla.org/mail/folder-factory;1?name=mailbox"
  ].createInstance(Ci.nsIMsgFolder);
  Assert.throws(
    () => replacement.initWithFolderId(id),
    /NS_ERROR_ALREADY_INITIALIZED/
  );
  Assert.equal(replacement.id, 0);
  Assert.strictEqual(MailServices.folderLookup.getFolderForURL(uri), child);
  Assert.throws(
    () => MailServices.folderLookup.cache(uri, replacement),
    /NS_ERROR_ALREADY_INITIALIZED/
  );
  MailServices.folderLookup.evictFolder(replacement);
  Assert.strictEqual(MailServices.folderLookup.getFolderForURL(uri), child);
  Assert.equal(child.id, id);
  Assert.equal(child.parent, folder);
  Assert.equal(child.URI, uri);
  Assert.deepEqual(folder.subFolders, [child]);
  Assert.deepEqual(folderDB.getFolderChildren(folder.id), [id]);
  Assert.strictEqual(folder.addSubfolder("Existing"), child);
});
