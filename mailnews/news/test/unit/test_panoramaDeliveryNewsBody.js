/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server_setup.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

add_task(async function test_streamsEachGroupsArticle() {
  const lane = PanoramaDelivery.expectedLane();
  PanoramaDelivery.assertBackend(lane.backend);
  const daemon = new NntpDaemon();
  const names = ["test.subscribe.simple", "test.filter"];
  const sources = names.map((name, index) =>
    [
      "From: Sender <sender@example.invalid>",
      "Date: Thu, 01 Oct 2026 12:00:00 +0000",
      `Newsgroups: ${name}`,
      `Subject: Body from group ${index}`,
      `Message-ID: <body-${index}@panorama.invalid>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=us-ascii",
      "",
      `Only group ${index} contains this body.`,
      ".A dot-prefixed line.",
      "",
    ].join("\n")
  );
  for (const [index, name] of names.entries()) {
    daemon.addGroup(name);
    daemon.addArticleToGroup(new NewsArticle(sources[index]), name, 5001);
  }
  const server = makeServer(NNTP_RFC2980_handler, daemon);
  let incomingServer;
  registerCleanupFunction(async () => {
    try {
      incomingServer?.closeCachedConnections();
      await server.stop();
    } finally {
      if (_account) {
        MailServices.accounts.removeAccount(_account, false);
      }
    }
  });
  server.start();
  info('DELIVERY_PHASE {"phase":"news-factory"}');
  incomingServer = setupLocalServer(server.port);
  const folders = names.map(name =>
    incomingServer.rootFolder.getChildNamed(name)
  );
  for (const folder of folders) {
    Assert.ok(folder instanceof Ci.nsIMsgNewsFolder, "Group is a news folder");
    PanoramaDelivery.assertFolder(folder, lane);
    folder.clearFlag(Ci.nsMsgFolderFlags.Offline);
  }
  info('DELIVERY_PHASE {"phase":"news-ready"}');
  info('DELIVERY_PHASE {"phase":"news-headers"}');
  for (const folder of folders) {
    const listener = new PromiseTestUtils.PromiseUrlListener();
    folder.getNewMessages(null, listener);
    await listener.promise;
  }
  info('DELIVERY_PHASE {"phase":"news-body"}');
  // Fetch in reverse ingestion order to expose cross-group key aliasing.
  for (const index of [1, 0]) {
    const folder = folders[index];
    const messageId = `body-${index}@panorama.invalid`;
    const header = folder.msgDatabase.getMsgHdrForMessageID(messageId);
    Assert.ok(header, "Article has a local header");
    Assert.ok(!folder.hasMsgOffline(header.messageKey), "Body is not stored");
    const key = header.messageKey;
    const uri = folder.getUriForMsg(header);
    const service = MailServices.messageServiceFromURI(uri);
    const stream = new PromiseTestUtils.PromiseStreamListener();
    const listener = new PromiseTestUtils.PromiseUrlListener();
    const [data] = await Promise.all([
      stream.promise,
      listener.promise,
      Promise.resolve().then(() =>
        service.streamMessage(uri, stream, null, listener, false, "", false)
      ),
    ]);
    Assert.equal(
      data.replace(/\r\n/g, "\n"),
      sources[index],
      "Streaming the local URI retrieves exactly this group's article"
    );
    Assert.equal(
      folder.msgDatabase.getMsgHdrForKey(key).messageId,
      messageId,
      "Body retrieval preserves the local identity"
    );
    Assert.equal(
      folder.getTotalMessages(false),
      1,
      "Fetch creates no extra row"
    );
    Assert.ok(
      !folder.hasMsgOffline(key),
      "Online retrieval does not claim an offline body"
    );
  }
  const transactions = server.playTransaction();
  const commands = (
    Array.isArray(transactions) ? transactions : [transactions]
  ).flatMap(transaction => transaction.them);
  Assert.equal(
    commands.filter(command => command.startsWith("ARTICLE ")).length,
    2,
    "Both bodies were requested from the fake server"
  );
  info('DELIVERY_PHASE {"phase":"news-body-verified"}');
});
