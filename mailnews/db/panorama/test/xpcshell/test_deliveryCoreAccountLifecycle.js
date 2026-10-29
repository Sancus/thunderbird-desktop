/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */

const { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);

add_setup(function () {
  do_get_profile();
  const pref = "mail.serverDefaultStoreContractID";
  const hadUserValue = Services.prefs.prefHasUserValue(pref);
  const oldValue = Services.prefs.getCharPref(pref);
  Services.prefs.setCharPref(pref, "@mozilla.org/msgstore/berkeleystore;1");
  registerCleanupFunction(() => {
    if (hadUserValue) {
      Services.prefs.setCharPref(pref, oldValue);
    } else {
      Services.prefs.clearUserPref(pref);
    }
  });
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

/**
 * Creates an isolated real local-store account, retaining files during cleanup.
 *
 * @param {string} name - Unique hostname and username for the account.
 * @returns {{account: nsIMsgAccount, server: nsIMsgIncomingServer,
 *   root: nsIMsgLocalMailFolder}} Real account and native root folder.
 */
function makeRemovalAccount(name) {
  const server = MailServices.accounts.createIncomingServer(
    name,
    name + ".invalid",
    "none"
  );
  const account = MailServices.accounts.createAccount();
  account.incomingServer = server;
  registerCleanupFunction(() => {
    for (const current of MailServices.accounts.accounts) {
      if (current == account) {
        MailServices.accounts.removeAccount(account, false);
        break;
      }
    }
  });
  const root = server.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  return { account, server, root };
}

add_task(function test_lookupFailureDoesNotInterruptAccountRemoval() {
  const { account, server, root } = makeRemovalAccount("eviction-error");
  const child = root.createLocalSubfolder("Retained");
  const sibling = root.createLocalSubfolder("Other");
  const path = root.filePath.clone();
  const key = server.key;
  const genuine = MailServices.folderLookup;
  const attempted = [];
  let removed = 0;
  const observer = (subject, topic, data) => {
    if (data == key) {
      Assert.equal(subject, server);
      ++removed;
    }
  };
  Services.obs.addObserver(observer, "message-server-removed");
  registerCleanupFunction(() =>
    Services.obs.removeObserver(observer, "message-server-removed")
  );
  const mock = {
    QueryInterface: ChromeUtils.generateQI(["nsIFolderLookupService"]),
    evictFolder(folder) {
      attempted.push(folder);
      if (folder == child) {
        throw Components.Exception(
          "reached eviction failure",
          Cr.NS_ERROR_FAILURE
        );
      }
      genuine.evictFolder(folder);
    },
    getFolderForURL: uri => genuine.getFolderForURL(uri),
    getOrCreateFolderForURL: uri => genuine.getOrCreateFolderForURL(uri),
    createFolderAndCache: (parent, name) =>
      genuine.createFolderAndCache(parent, name),
    createRootFolderAndCache: name => genuine.createRootFolderAndCache(name),
    cache: (uri, folder) => genuine.cache(uri, folder),
    invalidateCache: () => genuine.invalidateCache(),
  };
  const cid = MockRegistrar.register("@mozilla.org/mail/folder-lookup;1", mock);
  try {
    MailServices.accounts.removeAccount(account, false);
    Assert.ok(attempted.includes(child), "The error point was reached");
    Assert.ok(attempted.includes(sibling));
    Assert.ok(
      attempted.includes(root),
      "Root eviction continues after the error"
    );
    Assert.equal(removed, 1);
    Assert.ok(!MailServices.accounts.allServers.some(item => item.key == key));
    Assert.ok(!Services.prefs.prefHasUserValue("mail.server." + key + ".type"));
    Assert.equal(root.id, 0, "Normal recursive Shutdown still runs");
    Assert.ok(path.exists());
  } finally {
    MockRegistrar.unregister(cid);
    genuine.evictFolder(child);
  }
});

add_task(
  async function test_removedAccountRetiresSqlTreeAndRetainsBodyIdentity() {
    const { account, server, root } = makeRemovalAccount("retired-tree");
    const child = root
      .createLocalSubfolder("Saved")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const nested = child.createLocalSubfolder("Nested");
    const ids = [root.id, child.id, nested.id];
    const paths = ids.map(id => folderDB.getFolderPath(id));
    const serverKey = server.key;
    Assert.equal(child.msgStore.storeType, "mbox");
    const path = child.filePath.path;
    const bytes = new TextEncoder().encode(
      "From - Wed Oct 28 00:00:00 2026\r\nMessage-ID: <retained@invalid>\r\nSubject: retained body\r\n\r\nRetain these bytes.\r\n"
    );
    await IOUtils.write(path, bytes);
    const key = messageDB.addMessage(
      child.id,
      "retained@invalid",
      [],
      123456,
      "sender",
      "recipient",
      "",
      "",
      "retained body",
      0,
      "tag",
      0
    );
    const header = messageDB.getMessage(key);
    header.storeToken = "0";
    header.messageSize = bytes.length;
    const before = messageDB.getSearchState(key);
    const sourceId = database.sourceId;
    const connection = database.connectionForTests;
    MailServices.accounts.removeAccount(account, false);
    Assert.equal(folderDB.getFolderChildNamed(0, serverKey), 0);
    for (const id of ids) {
      Assert.throws(() => folderDB.getFolderName(id), /NS_ERROR_UNEXPECTED/);
    }
    const reader = Services.storage.openUnsharedDatabase(
      connection.databaseFile
    );
    const stmt = reader.createStatement(
      "SELECT COUNT(*) AS count FROM folders WHERE id=:id"
    );
    try {
      for (const id of ids) {
        stmt.params.id = id;
        Assert.ok(stmt.executeStep());
        Assert.equal(stmt.row.count, 0);
        stmt.reset();
      }
    } finally {
      stmt.finalize();
      reader.close();
    }
    const after = messageDB.getSearchState(key);
    Assert.equal(after.messageKey, key);
    Assert.equal(after.folderId, ids[1]);
    Assert.strictEqual(after.folderFlags, null);
    Assert.equal(after.contentRevision, before.contentRevision);
    Assert.equal(after.locationRevision, before.locationRevision);
    Assert.ok(
      BigInt(after.policyRevision) > BigInt(before.policyRevision),
      "Retirement advances the folder policy revision"
    );
    Assert.equal(header.messageId, "retained@invalid");
    Assert.equal(header.subject, "retained body");
    Assert.equal(header.storeToken, "0");
    Assert.equal(header.messageSize, bytes.length);
    Assert.deepEqual(await IOUtils.read(path), bytes);
    Assert.equal(database.sourceId, sourceId);
    Assert.equal(database.connectionForTests, connection);
    // Exercise the same stored server key lookup used on a later startup.
    const replacement = folderDB.insertRoot(serverKey);
    Assert.greater(replacement, Math.max(...ids));
    Assert.deepEqual(folderDB.getFolderChildren(replacement), []);
    Assert.equal(folderDB.getFolderByPath(paths[1]), 0);
    Assert.equal(folderDB.getFolderByPath(paths[2]), 0);
    Assert.equal(messageDB.getSearchState(key).folderId, ids[1]);
    const fresh = folderDB.insertFolder(replacement, "Saved");
    Assert.notEqual(fresh, ids[1]);
    Assert.equal(messageDB.getSearchState(key).folderFlags, null);
    Assert.deepEqual(await IOUtils.read(path), bytes);
  }
);

add_task(function test_reentrantServerLookupKeepsSqlTree() {
  const { account, server, root } = makeRemovalAccount("reentrant-lookup");
  const child = root.createLocalSubfolder("Retained");
  const rootId = root.id;
  const childId = child.id;
  const key = server.key;
  let replacement;
  registerCleanupFunction(() => {
    if (
      replacement &&
      MailServices.accounts.allServers.some(item => item == replacement)
    ) {
      MailServices.accounts.removeIncomingServer(replacement, false);
    }
  });
  const observer = (subject, topic, data) => {
    if (data == key) {
      replacement = MailServices.accounts.getIncomingServer(key);
      Assert.notEqual(replacement, server);
      Assert.equal(replacement.rootFolder.id, rootId);
    }
  };
  Services.obs.addObserver(observer, "message-server-removed");
  try {
    MailServices.accounts.removeAccount(account, false);
  } finally {
    Services.obs.removeObserver(observer, "message-server-removed");
  }
  Assert.ok(
    replacement,
    "The removal callback registered the server key again"
  );
  Assert.ok(MailServices.accounts.allServers.some(item => item == replacement));
  Assert.equal(folderDB.getFolderChildNamed(0, key), rootId);
  Assert.equal(folderDB.getFolderChildNamed(rootId, "Retained"), childId);
});
