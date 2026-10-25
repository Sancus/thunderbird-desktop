/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from ../../../../db/panorama/test/xpcshell/head_delivery.js */

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

add_task(function test_selectsEwsAccountBackend() {
  do_get_profile();
  const lane = PanoramaDelivery.expectedLane();
  const service = PanoramaDelivery.assertBackend(lane.backend);
  info('DELIVERY_PHASE {"phase":"ews-support"}');
  for (const contract of [
    "@mozilla.org/messenger/server;1?type=ews",
    "@mozilla.org/messenger/ews-client;1",
    "@mozilla.org/messenger/messageservice;1?type=ews",
  ]) {
    Assert.ok(contract in Cc, `EWS build provides ${contract}`);
  }
  const account = MailServices.accounts.createAccount();
  let incomingServer;
  registerCleanupFunction(() => {
    incomingServer?.shutdown();
    MailServices.accounts.removeAccount(account, false);
  });
  info('DELIVERY_PHASE {"phase":"ews-factory"}');
  incomingServer = MailServices.accounts.createIncomingServer(
    "user",
    "localhost",
    "ews"
  );
  account.incomingServer = incomingServer;
  const rootFolder = incomingServer.rootFolder;
  Assert.equal(incomingServer.type, "ews", "Account uses EWS");
  Assert.ok(
    rootFolder instanceof Ci.IExchangeFolder,
    "Factory creates an Exchange folder"
  );
  Assert.equal(rootFolder.server, incomingServer, "Root belongs to account");
  Assert.equal(
    Services.io.newURI(rootFolder.URI).scheme,
    "ews",
    "Factory preserves the EWS folder scheme"
  );
  PanoramaDelivery._assertStore(rootFolder, lane);
  if (lane.backend == "panorama") {
    const core = service.QueryInterface(Ci.nsIDatabaseCore);
    Assert.greater(rootFolder.id, 0, "EWS root has a Panorama ID");
    Assert.equal(
      core.folderDB.getMsgFolderForFolder(rootFolder.id),
      rootFolder,
      "Panorama resolves the EWS root"
    );
  }
  info('DELIVERY_PHASE {"phase":"ews-ready"}');
});
