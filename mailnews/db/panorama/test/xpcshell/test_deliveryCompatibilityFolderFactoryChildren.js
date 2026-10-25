/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from head_delivery.js */

add_task(function test_repeatedAdditionKeepsOneLiveChild() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.ok(["mbox", "maildir"].includes(lane.store));
  const { folder } = PanoramaDelivery.createLocalFixture("factory-children");
  Assert.deepEqual(folder.subFolders, []);
  const child = folder.addSubfolder("repeat");
  const childId = child.id;
  Assert.greater(childId, 0);
  Assert.equal(child.parent, folder);
  Assert.equal(child.server, folder.server);
  Assert.strictEqual(
    folder.addSubfolder("repeat"),
    child,
    "Repeated addition reuses the child"
  );
  Assert.strictEqual(
    folder.addSubfolder("repeat"),
    child,
    "Further additions keep its identity"
  );
  Assert.deepEqual(
    folder.subFolders,
    [child],
    "Repeated addition does not append duplicates"
  );
  Assert.equal(folder.getChildNamed("repeat"), child);
  Assert.strictEqual(
    MailServices.folderLookup.getFolderForURL(child.URI),
    child,
    "The URI cache still resolves the original child"
  );
  Assert.deepEqual(folderDB.getFolderChildren(folder.id), [childId]);
});
