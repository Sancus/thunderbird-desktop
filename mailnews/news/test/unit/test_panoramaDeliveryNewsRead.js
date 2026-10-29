/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server_setup.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);
var { MsgKeySet } = ChromeUtils.importESModule(
  "resource:///modules/MsgKeySet.sys.mjs"
);

add_task(async function test_updatesReadStateByArticleNumber() {
  const lane = PanoramaDelivery.expectedLane();
  PanoramaDelivery.assertBackend(lane.backend);
  const daemon = new NntpDaemon();
  const names = ["test.subscribe.simple", "test.filter"];
  for (const [index, name] of names.entries()) {
    daemon.addGroup(name);
    for (let offset = 0; offset < (index ? 1 : 2); offset++) {
      const source = [
        "From: Sender <sender@example.invalid>",
        "Date: Thu, 01 Oct 2026 12:00:00 +0000",
        `Newsgroups: ${name}`,
        `Subject: Read state ${index}-${offset}`,
        `Message-ID: <read-${index}-${offset}@panorama.invalid>`,
        "",
        "Read state body.",
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
  for (const [index, folder] of folders.entries()) {
    Assert.ok(folder instanceof Ci.nsIMsgNewsFolder, "Group is a news folder");
    folder
      .QueryInterface(Ci.nsIMsgNewsFolder)
      .setReadSetFromStr(index ? "" : "5001");
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
  info('DELIVERY_PHASE {"phase":"news-read"}');
  const [folder, otherFolder] = folders;
  const header = folder.msgDatabase.getMsgHdrForMessageID(
    "read-0-0@panorama.invalid"
  );
  const neighbor = folder.msgDatabase.getMsgHdrForMessageID(
    "read-0-1@panorama.invalid"
  );
  const other = otherFolder.msgDatabase.getMsgHdrForMessageID(
    "read-1-0@panorama.invalid"
  );
  Assert.ok(header && neighbor && other, "All three articles have headers");
  const key = header.messageKey;
  Assert.ok(
    header.isRead,
    "Article 5001 inherits this group's newsrc read set"
  );
  Assert.ok(!neighbor.isRead, "Article 5002 is initially unread");
  Assert.ok(!other.isRead, "Article 5001 in the other group is unread");
  Assert.equal(folder.getNumUnread(false), 1, "Only one article is unread");
  for (const read of [false, true]) {
    folder.markMessagesRead([header], read);
    Assert.equal(header.isRead, read, "Retained header has the new read state");
    const listener = new PromiseTestUtils.PromiseUrlListener();
    folder.getNewMessages(null, listener);
    await listener.promise;
    const fresh = folder.msgDatabase.getMsgHdrForMessageID(
      "read-0-0@panorama.invalid"
    );
    Assert.equal(fresh.messageKey, key, "Read changes preserve identity");
    Assert.equal(
      fresh.isRead,
      read,
      "Read state survives another news request"
    );
    Assert.ok(!fresh.isFlagged, "Read changes do not flag the article");
    Assert.ok(
      !folder.msgDatabase.getMsgHdrForKey(neighbor.messageKey).isRead,
      "The adjacent article stays unread"
    );
    Assert.ok(
      !otherFolder.msgDatabase.getMsgHdrForKey(other.messageKey).isRead,
      "The overlapping article number in the other group stays unread"
    );
    Assert.equal(
      folder.getNumUnread(false),
      read ? 1 : 2,
      "Unread count agrees"
    );
    Assert.equal(
      folder.getTotalMessages(false),
      2,
      "Read changes preserve count"
    );
    Assert.equal(
      otherFolder.getNumUnread(false),
      1,
      "Other group count agrees"
    );
    // newsrc is a public article-number read set, independent of local keys.
    const readSet = new MsgKeySet(
      folder.QueryInterface(Ci.nsIMsgNewsFolder).newsrcLine.split(":")[1].trim()
    );
    Assert.equal(readSet.has(5001), read, "newsrc tracks the server article");
    Assert.ok(!readSet.has(5002), "newsrc leaves the adjacent article unread");
  }
  info('DELIVERY_PHASE {"phase":"news-read-verified"}');
});
