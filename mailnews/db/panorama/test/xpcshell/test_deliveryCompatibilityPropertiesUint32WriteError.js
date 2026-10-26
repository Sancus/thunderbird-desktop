/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

add_task(function test_uint32WriteFailurePreservesCommittedText() {
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

  header.setStringProperty("delivery.number", "deadbeef");
  header.setStringProperty("delivery.control", "unchanged");
  const connection = database.connectionForTests;
  const faults = [];
  connection.createFunction("delivery_uint32_write_fault", 2, {
    onFunctionCall(args) {
      faults.push([args.getInt64(0), args.getUTF8String(1)]);
      return 0;
    },
  });
  try {
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER delivery_uint32_write_fault " +
        "BEFORE INSERT ON main.message_properties WHEN NEW.name = 'delivery.number' " +
        "BEGIN SELECT delivery_uint32_write_fault(NEW.id, NEW.value); " +
        "SELECT RAISE(ABORT, 'header property write fault'); END"
    );
    Assert.throws(
      () => header.setUint32Property("delivery.number", 42),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.deepEqual(
      faults,
      [[id, "2a"]],
      "The write reached the trigger with hex text"
    );
  } finally {
    try {
      connection.executeSimpleSQL(
        "DROP TRIGGER IF EXISTS delivery_uint32_write_fault"
      );
    } finally {
      connection.removeFunction("delivery_uint32_write_fault");
    }
  }
  const reader = Services.storage.openUnsharedDatabase(file);
  try {
    const statement = reader.createStatement(
      "SELECT name, value FROM message_properties WHERE id = :id ORDER BY name"
    );
    try {
      statement.params.id = id;
      const stored = [];
      while (statement.executeStep()) {
        stored.push([statement.row.name, statement.row.value]);
      }
      Assert.deepEqual(stored, [
        ["delivery.control", "unchanged"],
        ["delivery.number", "deadbeef"],
      ]);
    } finally {
      statement.finalize();
    }
  } finally {
    reader.close();
  }
  const fetched = messageDB.getMessage(id);
  Assert.equal(fetched.getStringProperty("delivery.number"), "deadbeef");
  Assert.equal(fetched.getUint32Property("delivery.number"), 3735928559);
  Assert.equal(fetched.getStringProperty("delivery.control"), "unchanged");
});
