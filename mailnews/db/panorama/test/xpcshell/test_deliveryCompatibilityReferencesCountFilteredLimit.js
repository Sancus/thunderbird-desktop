/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

add_task(function test_numReferencesLimitsTheFilteredView() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.equal(lane.store, "none");
  do_get_profile();
  loadExistingDB();
  PanoramaDelivery.assertBackend(lane.backend);
  const root = folderDB.insertRoot("references");
  const folder = folderDB.insertFolder(root, "Inbox");
  const tokens = ["self@invalid", "", ...Array(65534).fill("visible@invalid")];
  tokens.push("last@invalid");
  const key = addMessage({
    folderId: folder,
    messageId: "self@invalid",
    references: tokens,
  });
  const header = messageDB.getMessage(key);
  const file = do_get_profile().clone();
  file.append("panorama.sqlite");
  const reader = Services.storage.openUnsharedDatabase(file);
  let statement = null;
  registerCleanupFunction(() => {
    if (statement) {
      statement.finalize();
    }
    reader.close();
  });
  statement = reader.createStatement(
    "SELECT ordinal, token FROM message_references WHERE id = :id ORDER BY ordinal"
  );
  statement.params.id = key;
  const before = [];
  while (statement.executeStep()) {
    before.push([statement.row.ordinal, statement.row.token]);
  }
  statement.reset();
  Assert.equal(before.length, 65537);
  Assert.deepEqual(
    before,
    tokens.map((token, ordinal) => [ordinal, token])
  );
  Assert.equal(header.numReferences, 65535);
  const after = [];
  statement.params.id = key;
  while (statement.executeStep()) {
    after.push([statement.row.ordinal, statement.row.token]);
  }
  statement.reset();
  Assert.deepEqual(after, before, "Reading the count preserves every raw row");
  Assert.equal(header.getStringReference(65534), "last@invalid");
});
