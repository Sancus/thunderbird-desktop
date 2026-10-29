/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server_setup.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

add_task(function test_selectsNewsAccountBackend() {
  const lane = PanoramaDelivery.expectedLane();
  const contracts = {
    mbox: "@mozilla.org/msgstore/berkeleystore;1",
    maildir: "@mozilla.org/msgstore/maildirstore;1",
  };
  Assert.ok(Object.hasOwn(contracts, lane.store), "News requires a store");
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
  let account = null;
  let incomingServer = null;
  registerCleanupFunction(() => {
    try {
      incomingServer?.closeCachedConnections();
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
  });
  Services.prefs.setCharPref(prefNames[0], contracts[lane.store]);
  Services.prefs.clearUserPref(prefNames[1]);
  const service = PanoramaDelivery.assertBackend(lane.backend);
  account = MailServices.accounts.createAccount();
  info('DELIVERY_PHASE {"phase":"news-factory"}');
  incomingServer = MailServices.accounts.createIncomingServer(
    "",
    "localhost",
    "nntp"
  );
  account.incomingServer = incomingServer;
  incomingServer.QueryInterface(Ci.nsINntpIncomingServer);
  const rootFolder = incomingServer.rootFolder;
  Assert.equal(incomingServer.type, "nntp", "Account uses NNTP");
  Assert.ok(
    rootFolder instanceof Ci.nsIMsgNewsFolder,
    "Factory creates a news root"
  );
  Assert.equal(rootFolder.server, incomingServer, "Root belongs to account");
  // Check the factory's choice before instantiating the body store.
  Assert.equal(
    incomingServer.getStringValue("storeContractID"),
    contracts[lane.store],
    "Factory records the requested store contract"
  );
  PanoramaDelivery._assertStore(rootFolder, lane);
  if (lane.backend == "panorama") {
    const core = service.QueryInterface(Ci.nsIDatabaseCore);
    Assert.greater(rootFolder.id, 0, "News root has a Panorama ID");
    Assert.equal(
      core.folderDB.getFolderChildNamed(0, incomingServer.key),
      rootFolder.id,
      "News root is registered under its account"
    );
    Assert.equal(
      core.folderDB.getMsgFolderForFolder(rootFolder.id),
      rootFolder,
      "Panorama resolves the news root"
    );
  }
  info('DELIVERY_PHASE {"phase":"news-ready"}');
});
