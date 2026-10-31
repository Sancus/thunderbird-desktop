/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from head_delivery.js */

add_task(function test_repeatedAdditionKeepsOneLiveChild() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.ok(["mbox", "maildir"].includes(lane.store));
  const { folder, rootFolder } =
    PanoramaDelivery.createLocalFixture("factory-children");
  Assert.deepEqual(folder.subFolders, []);
  const child = folder.addSubfolder("repeat");
  const childId = child.id;
  Assert.greater(childId, 0);
  Assert.equal(child.parent, folder);
  Assert.equal(child.server, folder.server);
  Assert.strictEqual(
    folder.addSubfolder("repeat"),
    child,
    "Repeated addition reuses the child"
  );
  Assert.strictEqual(
    folder.addSubfolder("repeat"),
    child,
    "Further additions keep its identity"
  );
  Assert.deepEqual(
    folder.subFolders,
    [child],
    "Repeated addition does not append duplicates"
  );
  Assert.equal(folder.getChildNamed("repeat"), child);
  Assert.strictEqual(
    MailServices.folderLookup.getFolderForURL(child.URI),
    child,
    "The URI cache still resolves the original child"
  );
  Assert.deepEqual(folderDB.getFolderChildren(folder.id), [childId]);

  const connection = database.connectionForTests;
  const property = "factoryMetadata";
  const readStored = id => {
    const row = connection.createStatement(
      "SELECT value, typeof(value) FROM folder_properties " +
        "WHERE id=:id AND name=:property"
    );
    try {
      row.params.id = id;
      row.params.property = property;
      return row.executeStep()
        ? [row.getUTF8String(0), row.getUTF8String(1)]
        : null;
    } finally {
      row.finalize();
    }
  };
  const retainedValue = "retained café 日本語";
  for (const target of [rootFolder, child]) {
    const id = target.id;
    Assert.equal(target.getStringProperty(property), "");
    Assert.equal(readStored(id), null, "Reading absence does not insert a row");
    for (const value of ["", retainedValue]) {
      target.setStringProperty(property, value);
      Assert.equal(target.getStringProperty(property), value);
      Assert.deepEqual(readStored(id), [value, "text"]);
    }
    connection.beginTransaction();
    try {
      target.setStringProperty(property, "caller-owned change");
      Assert.equal(target.getStringProperty(property), "caller-owned change");
      Assert.ok(connection.transactionInProgress);
    } finally {
      connection.rollbackTransaction();
    }
    Assert.equal(target.getStringProperty(property), retainedValue);
    Assert.deepEqual(readStored(id), [retainedValue, "text"]);
  }
  connection.executeSimpleSQL(
    `CREATE TEMP TRIGGER reject_factory_metadata BEFORE INSERT ON folder_properties
     WHEN NEW.id=${childId} AND NEW.name='factoryMetadata'
     BEGIN SELECT RAISE(ABORT, 'factory metadata fault'); END`
  );
  try {
    Assert.throws(
      () => child.setStringProperty(property, "blocked"),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.equal(child.getStringProperty(property), retainedValue);
    Assert.deepEqual(readStored(childId), [retainedValue, "text"]);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_factory_metadata");
  }
  connection.executeSimpleSQL(
    "ALTER TABLE folder_properties RENAME TO held_factory_properties"
  );
  try {
    Assert.throws(
      () => child.getStringProperty(property),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => child.setStringProperty(property, "lost"),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE held_factory_properties RENAME TO folder_properties"
    );
  }
  connection.beginTransaction();
  try {
    connection.executeSimpleSQL(
      "UPDATE database_identity SET sourceId = '{87654321-4321-4321-4321-cba987654321}'"
    );
    for (const call of [
      () => child.getStringProperty(property),
      () => child.setStringProperty(property, "foreign source"),
    ]) {
      Assert.throws(call, error => error.result == Cr.NS_ERROR_NOT_AVAILABLE);
    }
    Assert.ok(connection.transactionInProgress);
  } finally {
    connection.rollbackTransaction();
  }
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  service.forceFolderDBClosed(child);
  Assert.equal(child.getStringProperty(property), retainedValue);
  Assert.deepEqual(readStored(childId), [retainedValue, "text"]);
  Assert.equal(child.id, childId);
  Assert.strictEqual(child.parent, folder);
  Assert.strictEqual(child.server, folder.server);
  Assert.deepEqual(folderDB.getFolderChildren(folder.id), [childId]);
  const retired = folder.addSubfolder("retired-properties");
  const retiredId = retired.id;
  retired.setStringProperty(property, "retired value");
  folderDB.deleteFolder(retiredId);
  const retiredProperties = readStored(retiredId);
  Assert.throws(
    () => folderDB.getFolderName(retiredId),
    error => error.result == Cr.NS_ERROR_UNEXPECTED
  );
  for (const call of [
    () => retired.getStringProperty(property),
    () => retired.setStringProperty(property, "resurrection"),
  ]) {
    Assert.throws(call, error => error.result == Cr.NS_ERROR_UNEXPECTED);
  }
  Assert.deepEqual(
    readStored(retiredId),
    retiredProperties,
    "Rejected access cannot alter a retired ID's properties"
  );
  Assert.deepEqual(readStored(childId), [retainedValue, "text"]);
});
