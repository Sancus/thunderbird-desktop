/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

add_task(function test_mailboxNamePropagatesReadStepError() {
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
  info.setCharProperty("mailboxName", "Original/Readable");
  const connection = database.connectionForTests;
  let faults = 0;
  let failedId = 0;
  connection.createFunction("delivery_mailbox_read_fault", 1, {
    onFunctionCall(args) {
      faults++;
      failedId = args.getInt64(0);
      throw Components.Exception(
        "Delivery mailbox read fault",
        Cr.NS_ERROR_FAILURE
      );
    },
  });
  try {
    connection.executeSimpleSQL(
      "CREATE TEMP VIEW folder_properties AS SELECT id, name, " +
        "delivery_mailbox_read_fault(id) AS value FROM main.folder_properties"
    );
    const prepared = connection.createStatement(
      "SELECT value FROM folder_properties WHERE id = :id AND name = 'mailboxName'"
    );
    prepared.finalize();
    Assert.equal(faults, 0, "Preparing the query does not execute the fault");
    Assert.throws(
      () => info.mailboxName,
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.equal(faults, 1);
    Assert.equal(failedId, id);
  } finally {
    try {
      connection.executeSimpleSQL("DROP VIEW IF EXISTS temp.folder_properties");
    } finally {
      connection.removeFunction("delivery_mailbox_read_fault");
    }
  }
  Assert.equal(info.mailboxName, "Original/Readable");
});
