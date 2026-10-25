/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

add_task(function test_setReferencesLegacyParsing03() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.equal(lane.store, "none");
  do_get_profile();
  loadExistingDB();
  PanoramaDelivery.assertBackend(lane.backend);
  const root = folderDB.insertRoot("references");
  const folder = folderDB.insertFolder(root, "Inbox");
  const key = addMessage({ folderId: folder });
  const header = messageDB.getMessage(key);
  header.setReferences("<up@down> <left@right> <ying@yang>");
  Assert.equal(header.numReferences, 3);
  Assert.equal(header.getStringReference(0), "up@down");
  Assert.equal(header.getStringReference(1), "left@right");
  Assert.equal(header.getStringReference(2), "ying@yang");
});
