/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

add_task(function test_setReferencesLegacyParsing12() {
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
  header.setReferences(
    "<a@1>\n<a@2> <a@3>\t <a@4>\n  <a@5>\r\t<a@6>\r\n <a@7>\r\n\t "
  );
  Assert.equal(header.numReferences, 7);
  Assert.equal(header.getStringReference(0), "a@1");
  Assert.equal(header.getStringReference(1), "a@2");
  Assert.equal(header.getStringReference(2), "a@3");
  Assert.equal(header.getStringReference(3), "a@4");
  Assert.equal(header.getStringReference(4), "a@5");
  Assert.equal(header.getStringReference(5), "a@6");
  Assert.equal(header.getStringReference(6), "a@7");
});
