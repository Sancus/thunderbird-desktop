/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

add_task(function test_uint32PropagatesReadStepError() {
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

  header.setStringProperty("delivery.number", "2a");
  Assert.equal(header.getUint32Property("delivery.number"), 42);
  const connection = database.connectionForTests;
  let faults = 0;
  let failedId = 0;
  connection.createFunction("delivery_uint32_read_fault", 1, {
    onFunctionCall(args) {
      faults++;
      failedId = args.getInt64(0);
      throw Components.Exception(
        "Header property read fault",
        Cr.NS_ERROR_FAILURE
      );
    },
  });
  try {
    connection.executeSimpleSQL(
      "CREATE TEMP VIEW message_properties AS SELECT id, name, " +
        "delivery_uint32_read_fault(id) AS value FROM main.message_properties"
    );
    const prepared = connection.createStatement(
      "SELECT value FROM message_properties WHERE id = :id AND name = 'delivery.number'"
    );
    prepared.finalize();
    Assert.equal(faults, 0, "Preparing the query does not execute the fault");
    Assert.throws(
      () => header.getUint32Property("delivery.number"),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.equal(
      faults,
      1,
      "The getter reached the failing SQL row evaluation"
    );
    Assert.equal(failedId, id);
  } finally {
    try {
      connection.executeSimpleSQL(
        "DROP VIEW IF EXISTS temp.message_properties"
      );
    } finally {
      connection.removeFunction("delivery_uint32_read_fault");
    }
  }
  Assert.equal(header.getStringProperty("delivery.number"), "2a");
  Assert.equal(header.getUint32Property("delivery.number"), 42);
});
