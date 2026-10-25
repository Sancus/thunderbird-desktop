/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

// Keep account-factory failures separate from preconfigured-store UID cases.
add_task(function test_selectsImapAccountBackend() {
  const expected = PanoramaDelivery.expectedLane();
  const contracts = {
    mbox: "@mozilla.org/msgstore/berkeleystore;1",
    maildir: "@mozilla.org/msgstore/maildirstore;1",
  };
  Assert.ok(
    Object.hasOwn(contracts, expected.store),
    "Factory requires a body store"
  );
  const prefNames = [
    "mail.serverDefaultStoreContractID",
    "mail.server.default.storeContractID",
  ];
  const savedPrefs = prefNames.map(name => ({
    name,
    value: Services.prefs.prefHasUserValue(name)
      ? Services.prefs.getCharPref(name)
      : null,
  }));
  let account;
  let incomingServer;
  registerCleanupFunction(() => {
    try {
      const thread = Services.tm.currentThread;
      while (thread.hasPendingEvents()) {
        thread.processNextEvent(true);
      }
      if (incomingServer) {
        incomingServer.QueryInterface(Ci.nsIImapServerSink).abortQueuedUrls();
        incomingServer.closeCachedConnections();
      }
    } finally {
      try {
        if (account) {
          MailServices.accounts.removeAccount(account, false);
        }
      } finally {
        for (const { name, value } of savedPrefs) {
          if (value === null) {
            Services.prefs.clearUserPref(name);
          } else {
            Services.prefs.setCharPref(name, value);
          }
        }
      }
    }
  });
  Services.prefs.setCharPref(prefNames[0], contracts[expected.store]);
  Services.prefs.clearUserPref(prefNames[1]);
  info(
    "DELIVERY_IMAP_FIXTURE " +
      JSON.stringify({
        ...expected,
        mode: "account-factory",
      })
  );
  const service = PanoramaDelivery.assertBackend(expected.backend);
  account = MailServices.accounts.createAccount();
  const identity = MailServices.accounts.createIdentity();
  account.addIdentity(identity);
  account.defaultIdentity = identity;
  info('DELIVERY_PHASE {"phase":"imap-factory"}');
  incomingServer = MailServices.accounts.createIncomingServer(
    "user",
    "localhost",
    "imap"
  );
  account.incomingServer = incomingServer;
  incomingServer.QueryInterface(Ci.nsIImapIncomingServer);
  const rootFolder = incomingServer.rootFolder;
  const contractBefore = incomingServer.getStringValue("storeContractID");
  info(
    "DELIVERY_STORE_CONTRACT " +
      JSON.stringify({
        folderURI: rootFolder.URI,
        contractBefore,
        defaulted: !contractBefore,
        mode: "account-factory",
      })
  );
  const actualStore = incomingServer.msgStore.storeType;
  info(
    "DELIVERY_FOLDER " +
      JSON.stringify({
        folderURI: rootFolder.URI,
        backend: expected.backend,
        expectedStore: expected.store,
        actualStore,
        contractBefore,
        mode: "account-factory",
      })
  );
  Assert.equal(
    actualStore,
    expected.store,
    "Factory selects the requested store"
  );
  Assert.equal(
    contractBefore,
    contracts[expected.store],
    "Factory stores its contract"
  );
  Assert.equal(incomingServer.type, "imap", "Account uses the IMAP protocol");
  Assert.ok(
    rootFolder instanceof Ci.nsIMsgImapMailFolder,
    "The account factory creates an IMAP root folder"
  );
  Assert.equal(
    rootFolder.server,
    incomingServer,
    "Root belongs to the account"
  );
  if (expected.backend == "panorama") {
    const core = service.QueryInterface(Ci.nsIDatabaseCore);
    Assert.greater(rootFolder.id, 0, "Account root has a Panorama folder ID");
    Assert.equal(
      core.folderDB.getFolderChildNamed(0, incomingServer.key),
      rootFolder.id,
      "Account root is registered in Panorama"
    );
    Assert.equal(
      core.folderDB.getMsgFolderForFolder(rootFolder.id),
      rootFolder,
      "Panorama resolves the account root"
    );
  }
  info('DELIVERY_PHASE {"phase":"imap-ready"}');
});
