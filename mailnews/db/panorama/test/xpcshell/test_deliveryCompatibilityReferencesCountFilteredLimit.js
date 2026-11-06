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
  info("Reference fixture: inserting all raw references");
  const key = addMessage({
    folderId: folder,
    messageId: "self@invalid",
    references: tokens,
  });
  info("Reference fixture: raw references inserted");
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
    "SELECT json_group_array(json_array(ordinal, token) ORDER BY ordinal), " +
      "min(typeof(ordinal) IN ('integer', 'real') AND typeof(token) = 'text') " +
      "FROM message_references WHERE id = :id"
  );
  statement.params.id = key;
  info("Reference fixture: reading before complete raw snapshot");
  Assert.ok(
    statement.executeStep(),
    "The complete reference snapshot is available"
  );
  const before = JSON.parse(statement.getString(0));
  const beforeTypesValid = statement.getInt32(1) === 1;
  Assert.ok(
    !statement.executeStep(),
    "The complete reference snapshot has one result"
  );
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
  Assert.equal(header.numReferences, 65535);
  statement.params.id = key;
  info("Reference fixture: reading after complete raw snapshot");
  Assert.ok(
    statement.executeStep(),
    "The complete reference snapshot is available"
  );
  const after = JSON.parse(statement.getString(0));
  const afterTypesValid = statement.getInt32(1) === 1;
  Assert.ok(
    !statement.executeStep(),
    "The complete reference snapshot has one result"
  );
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
  Assert.equal(header.getStringReference(65534), "last@invalid");
});
