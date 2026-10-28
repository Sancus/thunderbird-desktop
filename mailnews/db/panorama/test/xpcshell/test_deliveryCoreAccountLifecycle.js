/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */

add_setup(function () {
  do_get_profile();
  loadExistingDB();
  Assert.equal(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    ),
    database
  );
});

add_task(function test_recreateLocalAccountWithRetainedFolders() {
  const sourceId = database.sourceId;
  const connection = database.connectionForTests;
  const controlServer = MailServices.accounts.createIncomingServer(
    "control",
    "control.invalid",
    "none"
  );
  const controlAccount = MailServices.accounts.createAccount();
  controlAccount.incomingServer = controlServer;
  registerCleanupFunction(() =>
    MailServices.accounts.removeAccount(controlAccount)
  );
  const controlRoot = controlServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const controlFolder = controlRoot.createLocalSubfolder("Control");
  const controlKey = messageDB.addMessage(
    controlFolder.id,
    "account-control@invalid",
    [],
    0,
    "",
    "",
    "",
    "",
    "unrelated account",
    0,
    "",
    0
  );

  let account = MailServices.accounts.createLocalMailAccount();
  registerCleanupFunction(() => {
    if (account) {
      MailServices.accounts.removeAccount(account);
    }
  });
  const oldRoot = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const oldChild = oldRoot
    .createLocalSubfolder("RetainedChild")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const oldNested = oldChild.createLocalSubfolder("Nested");
  const rootURI = oldRoot.URI;
  const childURI = oldChild.URI;
  const nestedURI = oldNested.URI;
  const oldRootId = oldRoot.id;
  const oldChildId = oldChild.id;
  const oldPath = oldRoot.filePath.clone();
  Assert.equal(MailServices.folderLookup.getFolderForURL(childURI), oldChild);
  Assert.equal(MailServices.folderLookup.getFolderForURL(nestedURI), oldNested);

  MailServices.accounts.removeAccount(account, false);
  account = null;
  Assert.ok(
    oldPath.exists(),
    "Removing the account retains its store directory"
  );
  Assert.equal(MailServices.folderLookup.getFolderForURL(rootURI), null);
  Assert.equal(MailServices.folderLookup.getFolderForURL(childURI), null);
  Assert.equal(MailServices.folderLookup.getFolderForURL(nestedURI), null);

  account = MailServices.accounts.createLocalMailAccount();
  const replacement = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  Assert.equal(replacement.URI, rootURI);
  Assert.notEqual(replacement, oldRoot);
  Assert.notEqual(replacement.id, oldRootId);
  Assert.equal(MailServices.folderLookup.getFolderForURL(rootURI), replacement);
  Assert.equal(MailServices.folderLookup.getFolderForURL(childURI), null);
  const child = replacement
    .createLocalSubfolder("RetainedChild")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const nested = child.createLocalSubfolder("Nested");
  Assert.notEqual(child, oldChild);
  Assert.notEqual(child.id, oldChildId);
  Assert.notEqual(nested, oldNested);
  Assert.equal(child.parent, replacement);
  Assert.equal(nested.parent, child);
  Assert.equal(MailServices.folderLookup.getFolderForURL(childURI), child);
  Assert.equal(MailServices.folderLookup.getFolderForURL(nestedURI), nested);
  MailServices.folderLookup.evictFolder(oldChild);
  Assert.equal(MailServices.folderLookup.getFolderForURL(childURI), child);
  Assert.ok(oldPath.exists(), "Recreation does not delete the old store");
  Assert.equal(
    MailServices.folderLookup.getFolderForURL(controlRoot.URI),
    controlRoot
  );
  Assert.equal(
    MailServices.folderLookup.getFolderForURL(controlFolder.URI),
    controlFolder
  );
  Assert.ok(messageDB.getSearchState(controlKey));
  Assert.equal(database.sourceId, sourceId);
  Assert.equal(database.connectionForTests, connection);
});
