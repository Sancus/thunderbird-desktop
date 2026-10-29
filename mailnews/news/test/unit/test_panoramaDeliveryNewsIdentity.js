/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server_setup.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

add_task(async function test_keepsArticlesInTheirGroups() {
  const lane = PanoramaDelivery.expectedLane();
  const service = PanoramaDelivery.assertBackend(lane.backend);
  const daemon = new NntpDaemon();
  const names = ["test.subscribe.simple", "test.filter"];
  const expected = names.map((name, index) => [
    {
      messageId: `group-${index}@panorama.invalid`,
      subject: `Group ${index} article`,
      references: ["parent@panorama.invalid"],
    },
    {
      messageId: "crosspost@panorama.invalid",
      subject: "Crossposted article",
      references: [],
    },
  ]);
  for (const [index, name] of names.entries()) {
    daemon.addGroup(name);
    for (const [offset, message] of expected[index].entries()) {
      const source = [
        "From: Sender <sender@example.invalid>",
        "Date: Thu, 01 Oct 2026 12:00:00 +0000",
        `Newsgroups: ${offset ? names.join(",") : name}`,
        `Subject: ${message.subject}`,
        `Message-ID: <${message.messageId}>`,
        `References: ${message.references.map(id => `<${id}>`).join(" ")}`,
        "",
        "Article body.",
        "",
      ].join("\n");
      daemon.addArticleToGroup(new NewsArticle(source), name, 5001 + offset);
    }
  }
  const server = makeServer(NNTP_RFC2980_handler, daemon);
  let incomingServer = null;
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
  const added = [];
  const listener = {
    msgAdded(header) {
      added.push({
        folder: header.folder.URI,
        key: header.messageKey,
        messageId: header.messageId,
        subject: header.subject,
        references: Array.from({ length: header.numReferences }, (_, index) =>
          header.getStringReference(index)
        ),
        attached: header.folder.msgDatabase.containsKey(header.messageKey),
      });
    },
  };
  MailServices.mfn.addListener(
    listener,
    Ci.nsIMsgFolderNotificationService.msgAdded
  );
  registerCleanupFunction(() => MailServices.mfn.removeListener(listener));
  info('DELIVERY_PHASE {"phase":"news-headers"}');
  for (const folder of folders) {
    const urlListener = new PromiseTestUtils.PromiseUrlListener();
    folder.getNewMessages(null, urlListener);
    await urlListener.promise;
  }
  const keys = [];
  const snapshots = [];
  for (const [index, folder] of folders.entries()) {
    Assert.equal(folder.getTotalMessages(false), 2, "Group has two articles");
    Assert.deepEqual(
      Array.from(folder.messages, header => header.messageId).sort(),
      expected[index].map(message => message.messageId).sort(),
      "Enumeration contains only this group's articles"
    );
    for (const message of expected[index]) {
      const header = folder.msgDatabase.getMsgHdrForMessageID(
        message.messageId
      );
      Assert.ok(header, "Article has a header");
      Assert.equal(header.folder, folder, "Header retains its group");
      Assert.equal(
        header.subject,
        message.subject,
        "Header retains its subject"
      );
      Assert.equal(
        folder.msgDatabase.getMsgHdrForKey(header.messageKey).messageId,
        message.messageId,
        "Folder key resolves the expected article"
      );
      const uri = folder.getUriForMsg(header);
      const resolved =
        MailServices.messageServiceFromURI(uri).messageURIToMsgHdr(uri);
      Assert.deepEqual(
        [resolved.folder.URI, resolved.messageKey, resolved.messageId],
        [folder.URI, header.messageKey, message.messageId],
        "News message URI resolves the expected article identity"
      );
      keys.push(header.messageKey);
      snapshots.push({
        folder: folder.URI,
        key: header.messageKey,
        messageId: message.messageId,
        subject: message.subject,
        references: message.references,
        attached: true,
      });
      if (lane.backend == "panorama") {
        const core = service.QueryInterface(Ci.nsIDatabaseCore);
        const globalHeader = core.messageDB.getMessage(header.messageKey);
        Assert.equal(
          globalHeader.folder,
          folder,
          "Global key retains its group"
        );
        Assert.equal(
          globalHeader.messageId,
          message.messageId,
          "Global identity"
        );
      }
    }
  }
  Assert.deepEqual(
    added,
    snapshots,
    "First notifications contain complete headers"
  );
  if (lane.backend == "panorama") {
    Assert.equal(
      new Set(keys).size,
      4,
      "Each group article has a global identity"
    );
  }
  for (const [index, folder] of folders.entries()) {
    const urlListener = new PromiseTestUtils.PromiseUrlListener();
    folder.getNewMessages(null, urlListener);
    await urlListener.promise;
    Assert.deepEqual(
      Array.from(folder.messages, header => [
        header.messageId,
        header.messageKey,
      ]).sort(),
      expected[index]
        .map((message, offset) => [message.messageId, keys[index * 2 + offset]])
        .sort(),
      "Repeated ingestion preserves the group's identities"
    );
  }
  Assert.equal(
    added.length,
    4,
    "Repeated ingestion does not publish duplicates"
  );
  info('DELIVERY_PHASE {"phase":"news-identity-verified"}');
});
