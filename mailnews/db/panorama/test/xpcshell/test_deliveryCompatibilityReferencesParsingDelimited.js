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

add_task(function test_setReferencesParsesDelimitedIds() {
  const root = folderDB.insertRoot("references");
  const folder = folderDB.insertFolder(root, "Inbox");
  const key = addMessage({ folderId: folder, messageId: "self@invalid" });
  const header = messageDB.getMessage(key);
  header.setReferences(
    "outside <First@invalid><Second@invalid>\r\n\t<> " +
      "<self@invalid> <First@invalid> ignored <unfinished"
  );
  const retrieved = messageDB.getMessage(key);
  Assert.equal(retrieved.numReferences, 3);
  Assert.deepEqual(
    [0, 1, 2].map(i => retrieved.getStringReference(i)),
    ["First@invalid", "Second@invalid", "First@invalid"]
  );
  const file = do_get_profile();
  file.append("panorama.sqlite");
  const reader = Services.storage.openUnsharedDatabase(file);
  registerCleanupFunction(() => reader.close());
  const statement = reader.createStatement(
    "SELECT token FROM message_references WHERE id = :id ORDER BY ordinal"
  );
  statement.params.id = key;
  const stored = [];
  try {
    while (statement.executeStep()) {
      stored.push(statement.row.token);
    }
  } finally {
    statement.finalize();
  }
  Assert.deepEqual(stored, [
    "First@invalid",
    "Second@invalid",
    "self@invalid",
    "First@invalid",
  ]);
});
