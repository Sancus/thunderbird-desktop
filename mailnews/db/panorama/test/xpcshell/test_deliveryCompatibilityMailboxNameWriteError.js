/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

add_task(function test_mailboxNamePropagatesWriteError() {
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
  const account = MailServices.accounts.createAccount();
  registerCleanupFunction(() =>
    MailServices.accounts.removeAccount(account, false)
  );
  const server = MailServices.accounts.createIncomingServer(
    "mailbox-metadata",
    "mailbox.invalid",
    "none"
  );
  account.incomingServer = server;
  const root = server.rootFolder;
  const id = folderDB.insertFolder(root.id, "Display");
  const folder = Cc[
    "@mozilla.org/mail/folder-factory;1?name=mailbox"
  ].createInstance(Ci.nsIMsgFolder);
  folder.initWithFolderId(id);
  Assert.equal(folder.id, id);
  const db = database
    .QueryInterface(Ci.nsIMsgDBService)
    .openFolderDB(folder, false);
  const info = db.dBFolderInfo;
  info.setCharProperty("mailboxName", "Original/Committed");
  const reader = Services.storage.openUnsharedDatabase(file);
  let statement = null;
  registerCleanupFunction(() => {
    if (statement) {
      statement.finalize();
    }
    reader.close();
  });
  statement = reader.createStatement(
    "SELECT CAST(value AS TEXT) AS value FROM folder_properties " +
      "WHERE id = :id AND name = 'mailboxName'"
  );
  statement.params.id = id;
  Assert.ok(statement.executeStep());
  Assert.equal(statement.row.value, "Original/Committed");
  Assert.ok(!statement.executeStep());
  statement.reset();
  const connection = database.connectionForTests;
  let faults = 0;
  let failedId = 0;
  connection.createFunction("delivery_mailbox_write_fault", 1, {
    onFunctionCall(args) {
      faults++;
      failedId = args.getInt64(0);
      return 0;
    },
  });
  try {
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER delivery_mailbox_write_fault " +
        "BEFORE INSERT ON main.folder_properties WHEN NEW.name = 'mailboxName' " +
        "BEGIN SELECT delivery_mailbox_write_fault(NEW.id); " +
        "SELECT RAISE(ABORT, 'delivery mailbox write fault'); END"
    );
    Assert.throws(
      () => {
        info.mailboxName = "Replacement";
      },
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.equal(faults, 1);
    Assert.equal(failedId, id);
  } finally {
    try {
      connection.executeSimpleSQL(
        "DROP TRIGGER IF EXISTS delivery_mailbox_write_fault"
      );
    } finally {
      connection.removeFunction("delivery_mailbox_write_fault");
    }
  }
  statement.params.id = id;
  Assert.ok(statement.executeStep());
  Assert.equal(statement.row.value, "Original/Committed");
  Assert.ok(!statement.executeStep());
  Assert.equal(db.dBFolderInfo.mailboxName, "Original/Committed");
});
