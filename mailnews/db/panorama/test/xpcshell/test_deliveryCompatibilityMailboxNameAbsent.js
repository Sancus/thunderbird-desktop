/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

add_task(function test_mailboxNameAbsentIsEmpty() {
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
  Assert.equal(info.mailboxName, "");
  const reconstructed = db.dBFolderInfo;
  Assert.notEqual(info, reconstructed);
  Assert.equal(reconstructed.mailboxName, "");
  const reader = Services.storage.openUnsharedDatabase(file);
  let statement;
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
  Assert.ok(
    !statement.executeStep(),
    "Reading an absent name does not store a default"
  );
});
