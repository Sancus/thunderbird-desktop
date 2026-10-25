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

add_task(function test_setReferencesPropagatesTransactionOwnershipError() {
  const root = folderDB.insertRoot("references");
  const folder = folderDB.insertFolder(root, "Inbox");
  const key = addMessage({
    folderId: folder,
    references: ["original@invalid"],
  });
  const header = messageDB.getMessage(key);
  const connection = database.connectionForTests;
  connection.beginTransaction();
  try {
    Assert.throws(
      () => header.setReferences("<replacement@invalid>"),
      error => error.result == Cr.NS_ERROR_IN_PROGRESS
    );
    Assert.ok(connection.transactionInProgress);
  } finally {
    connection.rollbackTransaction();
  }
  Assert.equal(header.numReferences, 1);
  Assert.equal(header.getStringReference(0), "original@invalid");
  Assert.equal(
    messageDB.getMessage(key).getStringReference(0),
    "original@invalid"
  );
});
