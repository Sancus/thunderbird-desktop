/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from head_delivery.js */

add_task(function test_retriesRootAfterStoreInitializationFailure() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.ok(["mbox", "maildir"].includes(lane.store));
  do_get_profile();
  loadExistingDB();
  PanoramaDelivery.assertBackend(lane.backend);
  const serverKey = "factoryRetry";
  const prefPrefix = "mail.server." + serverKey + ".";
  const storeContract = {
    mbox: "@mozilla.org/msgstore/berkeleystore;1",
    maildir: "@mozilla.org/msgstore/maildirstore;1",
  }[lane.store];
  const missingStore = "@mozilla.org/msgstore/compatibility-missing;1";
  Assert.ok(!(missingStore in Cc), "The configured store is unavailable");
  let account = null;
  let incomingServer = null;
  registerCleanupFunction(() => {
    try {
      Services.prefs.setStringPref(
        prefPrefix + "storeContractID",
        storeContract
      );
      incomingServer ??= MailServices.accounts.getIncomingServer(serverKey);
      if (account) {
        MailServices.accounts.removeAccount(account, false);
      } else {
        MailServices.accounts.removeIncomingServer(incomingServer, false);
      }
    } finally {
      Services.prefs.deleteBranch(prefPrefix);
    }
  });
  Services.prefs.setStringPref(prefPrefix + "type", "none");
  Services.prefs.setStringPref(prefPrefix + "userName", "nobody");
  Services.prefs.setStringPref(prefPrefix + "hostname", "factory.invalid");
  Services.prefs.setStringPref(prefPrefix + "storeContractID", missingStore);
  const directory = do_get_profile();
  directory.append("factory-retry");
  directory.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  Services.prefs.setComplexValue(
    prefPrefix + "directory",
    Ci.nsIFile,
    directory
  );

  Assert.throws(
    () => MailServices.accounts.getIncomingServer(serverKey),
    /NS_ERROR_FACTORY_NOT_REGISTERED/,
    "Initial root creation fails for the unavailable store"
  );
  // The account manager retains the server after failed root initialization.
  incomingServer = MailServices.accounts.getIncomingServer(serverKey);
  const rootId = folderDB.getFolderChildNamed(0, serverKey);
  Assert.greater(rootId, 0);
  Assert.throws(
    () => incomingServer.rootFolder,
    /NS_ERROR_FACTORY_NOT_REGISTERED/,
    "A retry must fail again instead of returning the partial root"
  );

  incomingServer.setStringValue("storeContractID", storeContract);
  const root = incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  Assert.ok(root instanceof Ci.nsIMsgLocalMailFolder);
  Assert.equal(root.id, rootId, "Recovery keeps the existing folder record");
  Assert.equal(root.server, incomingServer);
  Assert.equal(root.URI, "mailbox://nobody@factory.invalid");
  Assert.strictEqual(
    incomingServer.rootFolder,
    root,
    "Successful roots are retained"
  );
  PanoramaDelivery._assertStore(root, lane);
  account = MailServices.accounts.createAccount();
  account.incomingServer = incomingServer;
  Assert.equal(folderDB.getMsgFolderForFolder(rootId), root);
  const child = root.createLocalSubfolder("recovered");
  Assert.equal(child.parent, root);
  Assert.equal(child.server, incomingServer);
  Assert.equal(root.getChildNamed("recovered"), child);
});
