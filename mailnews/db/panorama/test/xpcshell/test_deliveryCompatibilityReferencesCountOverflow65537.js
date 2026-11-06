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
  let beforeTypesValid = true;
  while (statement.executeStep()) {
    const ordinalType = statement.getTypeOfIndex(0);
    const tokenType = statement.getTypeOfIndex(1);
    beforeTypesValid &&=
      (ordinalType == Ci.mozIStorageValueArray.VALUE_TYPE_INTEGER ||
        ordinalType == Ci.mozIStorageValueArray.VALUE_TYPE_FLOAT) &&
      tokenType == Ci.mozIStorageValueArray.VALUE_TYPE_TEXT;
    before.push([statement.getDouble(0), statement.getString(1)]);
  }
  Assert.ok(
    beforeTypesValid,
    "The raw reference SQL column types are preserved"
  );
  statement.reset();
  Assert.equal(before.length, 65537);
  // Compare every tuple and report only the exact comparison result.
  Assert.ok(
    before.every(
      ([ordinal, token]) =>
        Number.isSafeInteger(ordinal) && typeof token == "string"
    ),
    "Every stored reference row has a safe integer ordinal and string token"
  );
  Assert.deepEqual(
    before.every(
      ([ordinal, token], index) => ordinal === index && token === tokens[index]
    ),
    true
  );
  Assert.throws(
    () => header.numReferences,
    error => error.result == Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA
  );
  const after = [];
  statement.params.id = key;
  let afterTypesValid = true;
  while (statement.executeStep()) {
    const ordinalType = statement.getTypeOfIndex(0);
    const tokenType = statement.getTypeOfIndex(1);
    afterTypesValid &&=
      (ordinalType == Ci.mozIStorageValueArray.VALUE_TYPE_INTEGER ||
        ordinalType == Ci.mozIStorageValueArray.VALUE_TYPE_FLOAT) &&
      tokenType == Ci.mozIStorageValueArray.VALUE_TYPE_TEXT;
    after.push([statement.getDouble(0), statement.getString(1)]);
  }
  Assert.ok(
    afterTypesValid,
    "The raw reference SQL column types are preserved"
  );
  statement.reset();
  Assert.ok(
    after.every(
      ([ordinal, token]) =>
        Number.isSafeInteger(ordinal) && typeof token == "string"
    ),
    "Every reread reference row has a safe integer ordinal and string token"
  );
  Assert.deepEqual(
    after.length === before.length &&
      after.every(
        ([ordinal, token], index) =>
          ordinal === before[index][0] && token === before[index][1]
      ),
    true,
    "Reading the count preserves every raw row"
  );
  Assert.equal(header.getStringReference(65536), "last@invalid");
});
