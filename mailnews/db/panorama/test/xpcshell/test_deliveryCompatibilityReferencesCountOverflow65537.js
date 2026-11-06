/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

add_task(function test_numReferencesOverflow65537PreservesStorage() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.equal(lane.store, "none");
  do_get_profile();
  loadExistingDB();
  PanoramaDelivery.assertBackend(lane.backend);
  const root = folderDB.insertRoot("references");
  const folder = folderDB.insertFolder(root, "Inbox");
  const tokens = Array(65536).fill("visible@invalid");
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
  if (statement.executeStep()) {
    const row = statement.row;
    do {
      before.push([row.ordinal, row.token]);
    } while (statement.executeStep());
  }
  statement.reset();
  Assert.equal(before.length, 65537);
  // Compare every tuple without recursively inspecting 65k cross-realm arrays.
  Assert.ok(
    before.every(
      ([ordinal, token]) =>
        Number.isSafeInteger(ordinal) && typeof token == "string"
    ),
    "Every stored reference row has a safe integer ordinal and string token"
  );
  Assert.deepEqual(
    JSON.stringify(before),
    JSON.stringify(tokens.map((token, ordinal) => [ordinal, token]))
  );
  Assert.throws(
    () => header.numReferences,
    error => error.result == Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA
  );
  const after = [];
  statement.params.id = key;
  if (statement.executeStep()) {
    const row = statement.row;
    do {
      after.push([row.ordinal, row.token]);
    } while (statement.executeStep());
  }
  statement.reset();
  Assert.ok(
    after.every(
      ([ordinal, token]) =>
        Number.isSafeInteger(ordinal) && typeof token == "string"
    ),
    "Every reread reference row has a safe integer ordinal and string token"
  );
  Assert.deepEqual(
    JSON.stringify(after),
    JSON.stringify(before),
    "Reading the count preserves every raw row"
  );
  Assert.equal(header.getStringReference(65536), "last@invalid");
});
