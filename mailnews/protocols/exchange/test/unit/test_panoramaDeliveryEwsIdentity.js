/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from ../../../../db/panorama/test/xpcshell/head_delivery.js */

var { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);

add_task(async function test_keepsEwsItemsWithTheSameMessageId() {
  do_get_profile();
  const lane = PanoramaDelivery.expectedLane();
  const service = PanoramaDelivery.assertBackend(lane.backend);
  const server = new EwsServer({ username: "user", password: "password" });
  const account = MailServices.accounts.createAccount();
  let incomingServer = null;
  registerCleanupFunction(async () => {
    try {
      if (incomingServer) {
        incomingServer.shutdown();
        incomingServer.QueryInterface(Ci.IExchangeIncomingServer);
        await TestUtils.waitForCondition(
          () => !incomingServer.protocolClientRunning,
          "EWS client shuts down"
        );
      }
    } finally {
      try {
        server.stop();
      } finally {
        MailServices.accounts.removeAccount(account, false);
      }
    }
  });
  server.start();
  info('DELIVERY_PHASE {"phase":"ews-factory"}');
  incomingServer = MailServices.accounts.createIncomingServer(
    "user",
    "localhost",
    "ews"
  );
  account.incomingServer = incomingServer;
  incomingServer.port = server.port;
  incomingServer.password = "password";
  incomingServer.valid = true;
  incomingServer.setStringValue(
    "ews_url",
    `http://127.0.0.1:${server.port}/EWS/Exchange.asmx`
  );
  const root = incomingServer.rootFolder;
  server.appendRemoteFolder(
    new RemoteFolder("panorama-folder", "root", "PanoramaIdentity", null)
  );
  info('DELIVERY_PHASE {"phase":"ews-discovery"}');
  await syncFolder(incomingServer, root);
  const folder = root.getChildNamed("PanoramaIdentity");
  PanoramaDelivery.assertFolder(folder, lane);
  info('DELIVERY_PHASE {"phase":"ews-ready"}');
  const generator = new MessageGenerator();
  const ids = ["opaque-item-A", "opaque-item-B"];
  const messages = ids.map((id, index) => {
    const message = generator.makeMessage({
      subject: `Physical copy ${index}`,
    });
    message.messageId = "shared@panorama.invalid";
    message.metaState.read = index == 0;
    message.metaState.flagged = index == 1;
    // addMessages derives the item ID from Message-ID; keep them independent.
    server.addItemToFolder(id, "panorama-folder", message);
    return message;
  });
  info('DELIVERY_PHASE {"phase":"ews-headers"}');
  await syncFolder(incomingServer, folder);
  Assert.equal(
    folder.getTotalMessages(false),
    2,
    "Both physical items are ingested"
  );
  Assert.equal(folder.getNumUnread(false), 1, "Ingestion preserves read state");
  Assert.deepEqual(
    Array.from(folder.messages, header =>
      header.getStringProperty("ewsId")
    ).sort(),
    ids,
    "Enumeration contains both distinct EWS items"
  );
  const keys = [];
  for (const [index, id] of ids.entries()) {
    const header = folder.msgDatabase.getMsgHdrForEwsItemID(id);
    Assert.ok(header, "Opaque EWS item ID resolves to a local header");
    Assert.equal(header.folder, folder, "Item belongs to the synced folder");
    Assert.equal(
      header.messageId,
      messages[index].messageId,
      "Message-ID survives"
    );
    Assert.equal(
      header.subject,
      messages[index].subject,
      "Each item retains its subject"
    );
    Assert.equal(header.isRead, index == 0, "Each item retains its read state");
    Assert.equal(
      header.isFlagged,
      index == 1,
      "Each item retains its flag state"
    );
    keys.push(header.messageKey);
    if (lane.backend == "panorama") {
      const core = service.QueryInterface(Ci.nsIDatabaseCore);
      Assert.equal(core.messageDB.getMessage(header.messageKey).folder, folder);
    }
  }
  Assert.notEqual(
    keys[0],
    keys[1],
    "Duplicate Message-IDs have distinct local keys"
  );
  await syncFolder(incomingServer, folder);
  Assert.equal(
    folder.getTotalMessages(false),
    2,
    "Repeated sync creates no duplicate"
  );
  Assert.deepEqual(
    ids.map(id => folder.msgDatabase.getMsgHdrForEwsItemID(id).messageKey),
    keys,
    "Repeated sync preserves both physical identities"
  );
  info('DELIVERY_PHASE {"phase":"ews-identity-verified"}');
});
