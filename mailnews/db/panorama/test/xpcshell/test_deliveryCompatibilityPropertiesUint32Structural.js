/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

add_task(function test_uint32StorageAliasesRemainNumeric() {
  Assert.deepEqual(PanoramaDelivery.expectedLane(), {
    backend: "panorama",
    store: "none",
  });
  const file = do_get_profile().clone();
  file.append("panorama.sqlite");
  loadExistingDB();
  Assert.equal(
    PanoramaDelivery.assertBackend("panorama").QueryInterface(
      Ci.nsIDatabaseCore
    ),
    database
  );
  Assert.equal(database.connectionForTests.databaseFile.path, file.path);
  const root = folderDB.insertRoot("header-uint32");
  const folder = folderDB.insertFolder(root, "Inbox");
  const id = addMessage({
    folderId: folder,
    messageId: "header-uint32@invalid",
  });
  const header = messageDB.getMessage(id);

  const fields = ["messageSize", "offlineMessageSize", "lineCount"];
  for (const name of fields) {
    header[name] = 42;
  }
  Assert.deepEqual(
    fields.map(name => [header[name], header.getUint32Property(name)]),
    [
      [42, 42],
      [42, 42],
      [42, 42],
    ],
    "Typed field writes retain numeric alias reads"
  );
  for (const name of fields) {
    header.setUint32Property(name, 4294967295);
  }
  const fetched = messageDB.getMessage(id);
  Assert.deepEqual(
    fields.map(name => [fetched[name], fetched.getUint32Property(name)]),
    [
      [4294967295, 4294967295],
      [4294967295, 4294967295],
      [4294967295, 4294967295],
    ],
    "Alias writes retain full numeric field values"
  );
  const reader = Services.storage.openUnsharedDatabase(file);
  try {
    const statement = reader.createStatement(
      "SELECT name, value, typeof(value) AS kind FROM message_properties " +
        "WHERE id = :id ORDER BY name"
    );
    try {
      statement.params.id = id;
      const stored = [];
      while (statement.executeStep()) {
        stored.push([
          statement.row.name,
          statement.row.value,
          statement.row.kind,
        ]);
      }
      Assert.deepEqual(stored, [
        ["lineCount", 4294967295, "integer"],
        ["messageSize", 4294967295, "integer"],
        ["offlineMessageSize", 4294967295, "integer"],
      ]);
    } finally {
      statement.finalize();
    }
  } finally {
    reader.close();
  }
  header.storeToken = "00042";
  Assert.equal(fetched.storeToken, "00042");
  Assert.equal(fetched.getUint32Property("storeToken"), 42);
  header.setUint32Property("storeToken", 43);
  Assert.equal(fetched.storeToken, "43");
});
