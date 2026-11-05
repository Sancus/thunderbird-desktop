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
  let incomingServer = null;
  let account = null;
  registerCleanupFunction(async () => {
    try {
      incomingServer?.closeCachedConnections();
      await server.stop();
    } finally {
      if (account) {
        MailServices.accounts.removeAccount(account, false);
        if (_account == account) _account = null;
      }
    }
  });
  server.start();
  info('DELIVERY_PHASE {"phase":"news-factory"}');
  incomingServer = setupLocalServer(server.port);
  account = _account;
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


let offlineFixtureId = 0;

/**
 * Creates real two-group articles through the ordinary NNTP ingestion path.
 *
 * @returns {Promise<{lane: object, folder: nsIMsgNewsFolder,
 *   otherFolder: nsIMsgNewsFolder, header: nsIMsgDBHdr,
 *   otherHeader: nsIMsgDBHdr, server: nsMailServer, incoming: nsINntpIncomingServer}>}
 *   The normal backend/store fixture and its distinct physical articles.
 */
async function createOfflineNewsFixture() {
  const lane = PanoramaDelivery.expectedLane();
  PanoramaDelivery.assertBackend(lane.backend);
  const daemon = new NntpDaemon();
  const names = ["test.subscribe.simple", "test.filter"];
  for (const [index, name] of names.entries()) {
    daemon.addGroup(name);
    daemon.addArticleToGroup(new NewsArticle([
      "From: Sender <sender@example.invalid>",
      "Date: Thu, 01 Oct 2026 12:00:00 +0000",
      `Newsgroups: ${name}`,
      `Subject: Offline article ${index}`,
      `Message-ID: <offline-${index}@panorama.invalid>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=us-ascii",
      "",
      `Only offline group ${index} contains this body.`,
      "",
    ].join("\n")), name, 5001);
  }
  const server = makeServer(NNTP_RFC2980_handler, daemon);
  let incoming = null;
  let account = null;
  registerCleanupFunction(async () => {
    try {
      incoming?.closeCachedConnections();
      await server.stop();
    } finally {
      if (account) {
        MailServices.accounts.removeAccount(account, false);
        if (_account == account) _account = null;
      }
    }
  });
  server.start();
  const created = localAccountUtils.create_incoming_server_and_account(
    "nntp", server.port, `offline-${offlineFixtureId++}`, null, "localhost"
  );
  incoming = created.server.QueryInterface(Ci.nsINntpIncomingServer);
  incoming.pushAuth = false;
  account = created.account;
  subscribeServer(incoming);
  const folders = names.map(name => incoming.rootFolder.getChildNamed(name)
    .QueryInterface(Ci.nsIMsgNewsFolder));
  for (const folder of folders) {
    PanoramaDelivery.assertFolder(folder, lane);
    folder.clearFlag(Ci.nsMsgFolderFlags.Offline);
    const listener = new PromiseTestUtils.PromiseUrlListener();
    folder.getNewMessages(null, listener);
    await listener.promise;
  }
  const header = folders[0].msgDatabase.getMsgHdrForMessageID("offline-0@panorama.invalid");
  const otherHeader = folders[1].msgDatabase.getMsgHdrForMessageID("offline-1@panorama.invalid");
  Assert.ok(header && otherHeader, "Real NNTP ingestion published both group headers");
  if (lane.backend == "panorama") {
    Assert.notEqual(header.messageKey, 5001, "Native physical key is not the wire article");
    Assert.notEqual(header.messageKey, otherHeader.messageKey, "Groups have distinct physical rows");
  }
  return { lane, folder: folders[0], otherFolder: folders[1], header, otherHeader, server, incoming, daemon };
}

/**
 * Reads the actual selected store's existing physical message stream.
 *
 * @param {nsIMsgFolder} folder - The owning folder.
 * @param {nsIMsgDBHdr} header - The stored physical header.
 * @returns {string} The retained body bytes, including local status headers.
 */
function readStoredNewsBody(folder, header) {
  const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
  const stream = folder.getMsgInputStream(header);
  try {
    return NetUtil.readInputStreamToString(stream, stream.available());
  } finally {
    stream.close();
  }
}

/**
 * Requires an actual asynchronous error with its original nsresult.
 *
 * @param {Promise} promise - The actual operation's completion.
 * @param {nsresult} expected - The required original error.
 */
async function expectNewsResult(promise, expected) {
  let failure = null;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  Assert.ok(failure, "The operation failed rather than reporting success");
  if (typeof failure.result == "number") {
    Assert.equal(failure.result, expected, "Completion retains the original error");
  } else {
    // PromiseUrlListener rejects new Error(aExitCode), while the downloader
    // rejects the original nsIException. Check each actual helper contract.
    Assert.equal(failure.name, "Error", "The URL helper returned its documented Error");
    Assert.equal(failure.message, String(expected), "URL completion retains the exact original status");
  }
}

/**
 * Downloads one actual physical header through the existing service listener.
 *
 * @param {nsIMsgNewsFolder} folder - The owning group with offline mode enabled.
 * @param {nsIMsgDBHdr} header - The physical header to retrieve.
 * @returns {Promise<void>} The real service URL completion.
 */
function fetchOfflineNews(folder, header) {
  const listener = new PromiseTestUtils.PromiseUrlListener();
  MailServices.nntp.fetchMessage(folder, header.messageKey, null, null, listener);
  return listener.promise;
}

add_task(async function test_offlineFetchUsesPhysicalHeader() {
  const { folder, otherFolder, header, otherHeader, server } = await createOfflineNewsFixture();
  const key = header.messageKey;
  const newsrc = folder.newsrcLine;
  folder.saveArticleOffline = true;
  try {
    await fetchOfflineNews(folder, header);
  } finally {
    folder.saveArticleOffline = false;
  }
  Assert.ok(folder.hasMsgOffline(key), "Actual body settlement marks the selected physical header offline");
  Assert.ok(header.storeToken, "The selected provider published a real token");
  const body = readStoredNewsBody(folder, header);
  Assert.ok(body.includes("Only offline group 0 contains this body."));
  Assert.ok(!body.includes("Only offline group 1 contains this body."));
  Assert.ok(!otherFolder.hasMsgOffline(otherHeader.messageKey), "Other group's same article number is untouched");
  Assert.equal(header.messageKey, key, "Offline completion retains physical identity");
  Assert.equal(folder.newsrcLine, newsrc, "Offline completion retains article read state");
  const transactions = server.playTransaction();
  const commands = (Array.isArray(transactions) ? transactions : [transactions])
    .flatMap(transaction => transaction.them);
  Assert.ok(commands.includes("ARTICLE 5001"), "Wire fetch uses the mapped article number");
});

add_task(async function test_failedOfflineFetchRetainsPriorBody() {
  const { lane, folder, header } = await createOfflineNewsFixture();
  if (lane.backend != "panorama") {
    info("Native prior-body retention control is inapplicable to Mork");
    return;
  }
  folder.saveArticleOffline = true;
  try {
    await fetchOfflineNews(folder, header);
    const previous = {
      key: header.messageKey, token: header.storeToken,
      size: header.offlineMessageSize, flags: header.flags,
      newsrc: folder.newsrcLine, count: folder.getTotalMessages(false),
      unread: folder.getNumUnread(false), bytes: readStoredNewsBody(folder, header),
    };
    const owner = Services.io.newURI("about:blank");
    folder.acquireSemaphore(owner, "S365 body failure control");
    try {
      await expectNewsResult(fetchOfflineNews(folder, header), Cr.NS_MSG_FOLDER_BUSY);
    } finally {
      folder.releaseSemaphore(owner, "S365 body failure control");
    }
    Assert.equal(header.messageKey, previous.key);
    Assert.equal(header.storeToken, previous.token);
    Assert.equal(header.offlineMessageSize, previous.size);
    Assert.equal(header.flags, previous.flags, "Failure retains prior Offline/read/flag bits");
    Assert.equal(folder.newsrcLine, previous.newsrc);
    Assert.equal(folder.getTotalMessages(false), previous.count);
    Assert.equal(folder.getNumUnread(false), previous.unread);
    Assert.equal(readStoredNewsBody(folder, header), previous.bytes, "Failure retains exact prior provider bytes");
    await fetchOfflineNews(folder, header);
    Assert.ok(folder.hasMsgOffline(previous.key), "A fresh explicit retry succeeds");
    Assert.ok(readStoredNewsBody(folder, header).includes("Only offline group 0 contains this body."));
  } finally {
    folder.saveArticleOffline = false;
  }
});

add_task(async function test_downloaderReportsFailureAndRestoresMode() {
  const { folder, header } = await createOfflineNewsFixture();
  const { NewsDownloader } = ChromeUtils.importESModule("resource:///modules/NewsDownloader.sys.mjs");
  const downloader = new NewsDownloader(null);
  const owner = Services.io.newURI("about:blank");
  folder.acquireSemaphore(owner, "S365 body failure control");
  try {
    await expectNewsResult(downloader.downloadMessages(folder, [header.messageKey]), Cr.NS_MSG_FOLDER_BUSY);
  } finally {
    folder.releaseSemaphore(owner, "S365 body failure control");
  }
  Assert.ok(!folder.saveArticleOffline, "Failed batch restores the original offline mode");
  Assert.ok(!folder.hasMsgOffline(header.messageKey), "Failed batch never claims a body");
  await downloader.downloadMessages(folder, [header.messageKey]);
  Assert.ok(!folder.saveArticleOffline, "Explicit retry also restores the mode");
  Assert.ok(folder.hasMsgOffline(header.messageKey), "Explicit retry completes the actual provider write");
});

add_task(async function test_nativeStaleBodyRequestDoesNotPublishOffline() {
  const { lane, folder, header } = await createOfflineNewsFixture();
  if (lane.backend != "panorama") {
    info("Native retained-facade source control is inapplicable to Mork");
    return;
  }
  const stopped = Promise.withResolvers();
  const key = header.messageKey;
  const newsrc = folder.newsrcLine;
  const database = folder.msgDatabase;
  let closed = false;
  let stops = 0;
  folder.saveArticleOffline = true;
  try {
    MailServices.nntp.fetchMessage(folder, key, null, {
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
      onStartRequest() {},
      onDataAvailable(request, stream, offset, count) {
        const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
        NetUtil.readInputStreamToString(stream, count);
        if (!closed) {
          closed = true;
          database.forceClosed();
        }
      },
      onStopRequest(request, status) {
        stops++;
        stopped.resolve(status);
      },
    }, null);
    Assert.equal(await stopped.promise, Cr.NS_ERROR_NOT_AVAILABLE, "Stale native body request keeps the mapping error");
  } finally {
    folder.saveArticleOffline = false;
  }
  Assert.ok(closed, "The real body callback closed the captured facade");
  Assert.equal(stops, 1, "Body failure completes once");
  Assert.ok(!folder.hasMsgOffline(key), "Stale response never publishes an offline body");
  Assert.equal(folder.newsrcLine, newsrc, "Stale response preserves read state");
  Assert.equal(folder.msgDatabase.getMsgHdrForKey(key).messageId, "offline-0@panorama.invalid");
});

add_task(async function test_nativeFolderBatchReportsFailureAndRetries() {
  const { lane, folder, header } = await createOfflineNewsFixture();
  if (lane.backend != "panorama") {
    info("Native public folder batch listener control is inapplicable to Mork");
    return;
  }
  const settings = folder.downloadSettings;
  settings.useServerDefaults = false;
  settings.downloadByDate = false;
  settings.downloadUnreadOnly = false;
  folder.downloadSettings = settings;
  const first = new PromiseTestUtils.PromiseUrlListener();
  const owner = Services.io.newURI("about:blank");
  folder.acquireSemaphore(owner, "S365 body failure control");
  try {
    folder.downloadAllForOffline(first, null);
    await expectNewsResult(first.promise, Cr.NS_MSG_FOLDER_BUSY);
  } finally {
    folder.releaseSemaphore(owner, "S365 body failure control");
  }
  Assert.ok(!folder.saveArticleOffline, "Native folder failure releases its own batch mode");
  Assert.ok(!folder.hasMsgOffline(header.messageKey));
  const retry = new PromiseTestUtils.PromiseUrlListener();
  folder.downloadAllForOffline(retry, null);
  await retry.promise;
  Assert.ok(folder.hasMsgOffline(header.messageKey), "Public folder retry settles the actual native body");
  Assert.ok(!folder.saveArticleOffline, "Successful native folder batch releases its mode");
});


add_task(async function test_nativeArticleZeroFetchesByPresence() {
  const { lane, folder, server, incoming, daemon } = await createOfflineNewsFixture();
  if (lane.backend != "panorama") {
    info("Present article zero is native metadata; explicit nntp URL validation stays unchanged");
    return;
  }
  const source = [
    "From: Zero <zero@example.invalid>",
    "Date: Thu, 01 Oct 2026 12:00:00 +0000",
    `Newsgroups: ${folder.name}`,
    "Subject: Present article zero",
    "Message-ID: <offline-zero@panorama.invalid>",
    "", "The mapped article zero body.", "",
  ].join("\n");
  daemon.addArticleToGroup(new NewsArticle(source), folder.name, 0);
  const { NntpNewsGroup } = ChromeUtils.importESModule("resource:///modules/NntpNewsGroup.sys.mjs");
  const reader = new NntpNewsGroup(incoming, folder);
  try {
    reader.getArticlesRangeToFetch(null, 0, 0);
    reader.processXOverLine(
      "0\tPresent article zero\tZero <zero@example.invalid>\tThu, 01 Oct 2026 12:00:00 +0000\t<offline-zero@panorama.invalid>\t\t100\t1"
    );
    reader.finishProcessingXOver();
  } finally {
    reader.cleanUp();
  }
  const header = folder.msgDatabase.getMsgHdrForMessageID("offline-zero@panorama.invalid");
  Assert.ok(header, "The real native producer published present article zero");
  Assert.notEqual(header.messageKey, 0, "Physical identity remains nonzero");
  const keys = folder.msgDatabase.listAllKeys();
  folder.saveArticleOffline = true;
  try {
    await fetchOfflineNews(folder, header);
  } finally {
    folder.saveArticleOffline = false;
  }
  Assert.ok(folder.hasMsgOffline(header.messageKey));
  Assert.ok(readStoredNewsBody(folder, header).includes("The mapped article zero body."));
  Assert.deepEqual(folder.msgDatabase.listAllKeys(), keys, "Fetching zero creates no extra header");
  const commands = [server.playTransaction()].flat().flatMap(transaction => transaction.them);
  Assert.ok(commands.includes("ARTICLE 0"), "Zero is sent explicitly, not replaced by a message ID");
  Assert.ok(!commands.includes("ARTICLE <offline-zero@panorama.invalid>"));
});

add_task(async function test_nativeBatchCompletionCanStartFreshBatch() {
  const { lane, folder, header } = await createOfflineNewsFixture();
  if (lane.backend != "panorama") {
    info("Native public batch completion reentry is inapplicable to Mork");
    return;
  }
  const settings = folder.downloadSettings;
  settings.useServerDefaults = false;
  settings.downloadByDate = false;
  settings.downloadUnreadOnly = false;
  folder.downloadSettings = settings;
  const completed = Promise.withResolvers();
  let firstStops = 0;
  let secondStops = 0;
  folder.downloadAllForOffline({
    OnStartRunningUrl() {},
    OnStopRunningUrl(uri, status) {
      firstStops++;
      Assert.equal(status, Cr.NS_OK);
      Assert.ok(!folder.saveArticleOffline, "Old batch releases mode before its terminal callback");
      Assert.ok(folder.hasMsgOffline(header.messageKey), "Old body is committed before notification");
      folder.downloadAllForOffline({
        OnStartRunningUrl() {},
        OnStopRunningUrl(secondUri, secondStatus) {
          secondStops++;
          completed.resolve(secondStatus);
        },
      }, null);
    },
  }, null);
  Assert.equal(await completed.promise, Cr.NS_OK, "A fresh request from completion may finish normally");
  Assert.equal(firstStops, 1);
  Assert.equal(secondStops, 1);
  Assert.ok(!folder.saveArticleOffline, "The first request cannot leave or clear a later request's mode");
});


add_task(async function test_offlineBodyRetainsReadAndFlagStateAcrossReopen() {
  const { folder, header } = await createOfflineNewsFixture();
  const key = header.messageKey;
  folder.markMessagesRead([header], true);
  folder.markMessagesFlagged([header], true);
  const newsrc = folder.newsrcLine;
  folder.saveArticleOffline = true;
  try {
    await fetchOfflineNews(folder, header);
  } finally {
    folder.saveArticleOffline = false;
  }
  const token = header.storeToken;
  Assert.ok(token, "Real body settlement produced an owning store token");
  Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(Ci.nsIMsgDBService)
    .forceFolderDBClosed(folder);
  const reopened = folder.msgDatabase.getMsgHdrForMessageID("offline-0@panorama.invalid");
  Assert.equal(reopened.messageKey, key);
  Assert.equal(reopened.storeToken, token);
  Assert.ok(reopened.isRead && reopened.isFlagged, "Body settlement preserves current persisted read and flag state");
  Assert.ok(folder.hasMsgOffline(key), "The reopened physical row owns the settled body");
  Assert.equal(folder.newsrcLine, newsrc, "The article read set survives body settlement and actual reopen");
  Assert.equal(folder.getNumUnread(false), 0);
  Assert.equal(folder.getTotalMessages(false), 1);
  Assert.ok(readStoredNewsBody(folder, reopened).includes("Only offline group 0 contains this body."));
});


add_task(async function test_nativeBatchSourceChangeFromStartFailsOnce() {
  const { lane, folder, header } = await createOfflineNewsFixture();
  if (lane.backend != "panorama") {
    info("Native public batch source admission is inapplicable to Mork");
    return;
  }
  const database = folder.msgDatabase;
  const key = header.messageKey;
  const completed = Promise.withResolvers();
  let starts = 0;
  let stops = 0;
  folder.downloadAllForOffline({
    OnStartRunningUrl() {
      starts++;
      database.forceClosed();
    },
    OnStopRunningUrl(uri, status) {
      stops++;
      Assert.ok(!folder.saveArticleOffline, "Stale batch releases its mode before failure notification");
      completed.resolve(status);
    },
  }, null);
  Assert.equal(await completed.promise, Cr.NS_ERROR_NOT_AVAILABLE,
    "A real source change from the start callback cannot become empty-selection success");
  Assert.equal(starts, 1);
  Assert.equal(stops, 1);
  Assert.ok(!folder.hasMsgOffline(key), "Stale public batch never settles a body");
  Assert.equal(folder.msgDatabase.getMsgHdrForKey(key).messageId, "offline-0@panorama.invalid");
});
