/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

add_setup(function () {
  Assert.deepEqual(PanoramaDelivery.expectedLane(), {
    backend: "panorama",
    store: "none",
  });
  do_get_profile();
  loadExistingDB();
  Assert.equal(
    PanoramaDelivery.assertBackend("panorama").QueryInterface(
      Ci.nsIDatabaseCore
    ),
    database
  );
});

add_task(function test_getStringReferenceRejectsInvalidIndexes() {
  const root = folderDB.insertRoot("references");
  const folder = folderDB.insertFolder(root, "Inbox");
  const key = addMessage({
    folderId: folder,
    references: ["parent@invalid"],
  });
  const header = messageDB.getMessage(key);
  Assert.throws(
    () => header.getStringReference(-1),
    error => error.result == Cr.NS_ERROR_ILLEGAL_VALUE
  );
  Assert.throws(
    () => header.getStringReference(1),
    error => error.result == Cr.NS_ERROR_ILLEGAL_VALUE
  );
  Assert.equal(header.getStringReference(0), "parent@invalid");
});
