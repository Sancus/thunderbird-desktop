/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server_setup.js */

const accounts = [];
const servers = [];
const folders = [];
const databases = [];

add_setup(function () {
  const contract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  const store = {
    "@mozilla.org/msgstore/berkeleystore;1": "mbox",
    "@mozilla.org/msgstore/maildirstore;1": "maildir",
  }[contract];
  Assert.ok(store, "The configured store is supported");

  registerCleanupFunction(() => {
    for (let i = 0; i < databases.length; i++) {
      databases[i].removeListener(folders[i]);
    }
    for (const account of accounts) {
      account.incomingServer?.closeCachedConnections();
      MailServices.accounts.removeAccount(account, false);
    }
  });

  for (const hostname of ["read-one.invalid", "read-two.invalid"]) {
    const account = MailServices.accounts.createAccount();
    accounts.push(account);
    const server = MailServices.accounts.createIncomingServer(
      "",
      hostname,
      "nntp"
    );
    account.incomingServer = server;
    server.valid = false;
    server.QueryInterface(Ci.nsINntpIncomingServer);
    servers.push(server);
    const folder = server.rootFolder
      .QueryInterface(Ci.nsIMsgNewsFolder)
      .addNewsgroup("test.read-changed", "2-4,8");
    folder.QueryInterface(Ci.nsIMsgNewsFolder);
    folders.push(folder);
    Assert.equal(server.getStringValue("storeContractID"), contract);
    Assert.equal(server.msgStore.storeType, store);
    Assert.equal(folder.msgStore.storeType, store);

    const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    );
    Assert.equal(
      "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
      Services.prefs.getBoolPref("mail.panorama.enabled", false),
      "The database service matches the startup backend"
    );
    // Open the group database directly to test its announcer independently of
    // the native news read-set session.
    const db = service.openFolderDB(folder, false);
    databases.push(db);
    Assert.equal(
      db.folder.URI,
      folder.URI,
      "The database belongs to the group"
    );
    db.addListener(folder.QueryInterface(Ci.nsIDBChangeListener));
  }
});

add_task(function test_notifyReadChangedMarksOnlyOwningServer() {
  const lines = folders.map(folder => folder.newsrcLine);
  for (const server of servers) {
    server.newsrcHasChanged = false;
  }

  databases[0].notifyReadChanged(null);
  Assert.ok(
    servers[0].newsrcHasChanged,
    "The real news folder marks its server dirty"
  );
  Assert.ok(!servers[1].newsrcHasChanged, "Another server is unchanged");
  Assert.deepEqual(
    folders.map(folder => folder.newsrcLine),
    lines,
    "A notification does not replace either article read set"
  );
  Assert.deepEqual(databases[0].listAllKeys(), [], "No article was published");
  Assert.deepEqual(
    databases[1].listAllKeys(),
    [],
    "The other group stays empty"
  );
});

add_task(function test_removedFolderListenerIsNotNotified() {
  const db = databases[0];
  const folder = folders[0].QueryInterface(Ci.nsIDBChangeListener);
  db.removeListener(folder);
  servers[0].newsrcHasChanged = false;
  try {
    db.notifyReadChanged(null);
    Assert.ok(
      !servers[0].newsrcHasChanged,
      "A detached folder is not notified"
    );
  } finally {
    db.addListener(folder);
  }

  db.notifyReadChanged(null);
  Assert.ok(
    servers[0].newsrcHasChanged,
    "A reattached folder receives read changes"
  );
  Assert.equal(
    folders[0].newsrcLine.trim(),
    "test.read-changed: 2-4,8",
    "The native article ranges survive listener removal and reattachment"
  );
});
