/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server_setup.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

add_task(async function test_keepsFlagsInTheirGroups() {
  const lane = PanoramaDelivery.expectedLane();
  PanoramaDelivery.assertBackend(lane.backend);
  const daemon = new NntpDaemon();
  const names = ["test.subscribe.simple", "test.filter"];
  for (const [index, name] of names.entries()) {
    daemon.addGroup(name);
    const source = [
      "From: Sender <sender@example.invalid>",
      "Date: Thu, 01 Oct 2026 12:00:00 +0000",
      `Newsgroups: ${name}`,
      `Subject: Flag state ${index}`,
      `Message-ID: <flag-${index}@panorama.invalid>`,
      "",
      "Flag state body.",
      "",
    ].join("\n");
    daemon.addArticleToGroup(new NewsArticle(source), name, 5001);
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
  info('DELIVERY_PHASE {"phase":"news-headers"}');
  for (const folder of folders) {
    const listener = new PromiseTestUtils.PromiseUrlListener();
    folder.getNewMessages(null, listener);
    await listener.promise;
  }
  info('DELIVERY_PHASE {"phase":"news-flag"}');
  const [folder, otherFolder] = folders;
  let header = folder.msgDatabase.getMsgHdrForMessageID(
    "flag-0@panorama.invalid"
  );
  const other = otherFolder.msgDatabase.getMsgHdrForMessageID(
    "flag-1@panorama.invalid"
  );
  Assert.ok(header && other, "Both articles have headers");
  Assert.ok(!header.isFlagged && !other.isFlagged, "Articles start unflagged");
  const key = header.messageKey;
  const newsrc = folder.QueryInterface(Ci.nsIMsgNewsFolder).newsrcLine;
  for (const flagged of [true, false]) {
    folder.markMessagesFlagged([header], flagged);
    Assert.equal(header.isFlagged, flagged, "Retained header has the new flag");
    folder.msgDatabase.commit(Ci.nsMsgDBCommitType.kLargeCommit);
    folder.msgDatabase = null;
    const fresh = PanoramaDelivery.assertFolder(
      folder,
      lane
    ).getMsgHdrForMessageID("flag-0@panorama.invalid");
    Assert.ok(fresh, "Flagged article survives reopening the folder database");
    Assert.equal(fresh.messageKey, key, "Flag changes preserve identity");
    Assert.equal(fresh.isFlagged, flagged, "Reopened header has the new flag");
    Assert.ok(!fresh.isRead, "Flag changes leave the article unread");
    Assert.ok(
      !otherFolder.msgDatabase.getMsgHdrForKey(other.messageKey).isFlagged,
      "The overlapping article number in the other group stays unflagged"
    );
    Assert.equal(
      folder.getNumUnread(false),
      1,
      "Flagging preserves unread count"
    );
    Assert.equal(folder.getTotalMessages(false), 1, "Flagging preserves count");
    Assert.equal(
      otherFolder.getNumUnread(false),
      1,
      "Other group stays unread"
    );
    Assert.equal(
      folder.QueryInterface(Ci.nsIMsgNewsFolder).newsrcLine,
      newsrc,
      "Flag changes leave the article-number read set unchanged"
    );
    header = fresh;
  }
  info('DELIVERY_PHASE {"phase":"news-flag-verified"}');
});
