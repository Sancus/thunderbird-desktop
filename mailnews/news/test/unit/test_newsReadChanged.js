/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server_setup.js */
/* import-globals-from ../../../test/resources/filterTestUtils.js */
load("../../../resources/filterTestUtils.js");

var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);
var { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
var { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);
var { MsgKeySet } = ChromeUtils.importESModule(
  "resource:///modules/MsgKeySet.sys.mjs"
);
var { NntpNewsGroup } = ChromeUtils.importESModule(
  "resource:///modules/NntpNewsGroup.sys.mjs"
);
var { NntpClient } = ChromeUtils.importESModule(
  "resource:///modules/NntpClient.sys.mjs"
);

const nativeBackend = Services.prefs.getBoolPref(
  "mail.panorama.enabled",
  false
);
let articleFixture;
let zeroFixture;

const accounts = [];
const servers = [];
const folders = [];
const databases = [];
const wireCleanups = [];

add_setup(function () {
  const contract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  const store = {
    "@mozilla.org/msgstore/berkeleystore;1": "mbox",
    "@mozilla.org/msgstore/maildirstore;1": "maildir",
  }[contract];
  Assert.ok(store, "The configured store is supported");

  registerCleanupFunction(() => {
    for (let i = 0; i < databases.length; i++) {
      databases[i].removeListener(folders[i]);
    }
    for (const account of accounts) {
      // The cold-reopen task reconstructs the actual accounts from their prefs.
      const current = MailServices.accounts.getAccount(account.key);
      if (current) {
        current.incomingServer?.closeCachedConnections();
        MailServices.accounts.removeAccount(current, false);
      }
    }
  });

  for (const hostname of ["read-one.invalid", "read-two.invalid"]) {
    const account = MailServices.accounts.createAccount();
    accounts.push(account);
    const server = MailServices.accounts.createIncomingServer(
      "",
      hostname,
      "nntp"
    );
    account.incomingServer = server;
    server.valid = false;
    server.QueryInterface(Ci.nsINntpIncomingServer);
    servers.push(server);
    const folder = server.rootFolder
      .QueryInterface(Ci.nsIMsgNewsFolder)
      .addNewsgroup("test.read-changed", "2-4,8");
    folder.QueryInterface(Ci.nsIMsgNewsFolder);
    folders.push(folder);
    Assert.equal(server.getStringValue("storeContractID"), contract);
    Assert.equal(server.msgStore.storeType, store);
    Assert.equal(folder.msgStore.storeType, store);

    const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    );
    Assert.equal(
      "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
      Services.prefs.getBoolPref("mail.panorama.enabled", false),
      "The database service matches the startup backend"
    );
    // Open the group database directly to test its announcer independently of
    // the native news read-set session.
    const db = service.openFolderDB(folder, false);
    databases.push(db);
    Assert.equal(
      db.folder.URI,
      folder.URI,
      "The database belongs to the group"
    );
    db.addListener(folder.QueryInterface(Ci.nsIDBChangeListener));
  }
});

add_task(function test_notifyReadChangedMarksOnlyOwningServer() {
  const lines = folders.map(folder => folder.newsrcLine);
  for (const server of servers) {
    server.newsrcHasChanged = false;
  }

  databases[0].notifyReadChanged(null);
  Assert.ok(
    servers[0].newsrcHasChanged,
    "The real news folder marks its server dirty"
  );
  Assert.ok(!servers[1].newsrcHasChanged, "Another server is unchanged");
  Assert.deepEqual(
    folders.map(folder => folder.newsrcLine),
    lines,
    "A notification does not replace either article read set"
  );
  Assert.deepEqual(databases[0].listAllKeys(), [], "No article was published");
  Assert.deepEqual(
    databases[1].listAllKeys(),
    [],
    "The other group stays empty"
  );
});

add_task(function test_removedFolderListenerIsNotNotified() {
  const db = databases[0];
  const folder = folders[0].QueryInterface(Ci.nsIDBChangeListener);
  db.removeListener(folder);
  servers[0].newsrcHasChanged = false;
  try {
    db.notifyReadChanged(null);
    Assert.ok(
      !servers[0].newsrcHasChanged,
      "A detached folder is not notified"
    );
  } finally {
    db.addListener(folder);
  }

  db.notifyReadChanged(null);
  Assert.ok(
    servers[0].newsrcHasChanged,
    "A reattached folder receives read changes"
  );
  Assert.equal(
    folders[0].newsrcLine.trim(),
    "test.read-changed: 2-4,8",
    "The native article ranges survive listener removal and reattachment"
  );
});

/**
 * Create an ordinary owned news account and register it for file cleanup.
 *
 * @param {string} hostname - The server hostname.
 * @param {number} [port=119] - The actual NNTP port when a server is running.
 * @returns {{server: nsINntpIncomingServer, account: nsIMsgAccount}} The account.
 */
function createReadSetAccount(hostname, port = 119) {
  // News server URIs omit the port. Distinct usernames keep these accounts'
  // roots separate even when their fake servers all listen on localhost.
  const { server, account } =
    localAccountUtils.create_incoming_server_and_account(
      "nntp",
      port,
      `readset-${accounts.length}`,
      null,
      hostname
    );
  accounts.push(account);
  server.QueryInterface(Ci.nsINntpIncomingServer);
  server.pushAuth = false;
  Assert.equal(
    server.rootFolder.server,
    server,
    "The root keeps its real account"
  );
  server.maximumConnectionsNumber = 1;
  server.maxArticles = 1000;
  server.notifyOn = false;
  return { server, account };
}

/**
 * Fetch actual headers through the existing NNTP server and news database.
 *
 * @param {typeof NNTP_RFC2980_handler | typeof NNTP_RFC977_handler}
 *   [handler=NNTP_RFC2980_handler] - The existing protocol handler.
 * @param {boolean} [filters=false] - Whether to exercise explicit read actions.
 * @returns {Promise<{server: nsINntpIncomingServer, account: nsIMsgAccount,
 *   folders: nsIMsgNewsFolder[]}>} The account and its two populated groups.
 */
async function fetchReadSetArticles(
  handler = NNTP_RFC2980_handler,
  filters = false
) {
  const daemon = new NntpDaemon();
  const names = ["test.readset.first", "test.readset.second"];
  for (const [index, name] of names.entries()) {
    daemon.addGroup(name);
    for (let offset = 0; offset < (index ? 1 : 2); offset++) {
      const text = [
        "From: Reader <reader@example.invalid>",
        "Date: Thu, 01 Oct 2026 12:00:00 +0000",
        `Newsgroups: ${name}`,
        `Subject: Read set ${index}-${offset}`,
        `Message-ID: <s363-${index}-${offset}@example.invalid>`,
        "",
        "Article body.",
        "",
      ].join("\n");
      daemon.addArticleToGroup(new NewsArticle(text), name, 5001 + offset);
    }
  }
  const wire = makeServer(handler, daemon);
  wire.start();
  const { server, account } = createReadSetAccount("localhost", wire.port);
  let stopping;
  /**
   * Stop this fixture's network operations once, before account retirement.
   *
   * @returns {Promise<void>} Completion of the actual fake-server shutdown.
   */
  const stopWire = () => {
    stopping ??= (async () => {
      server.closeCachedConnections();
      await wire.stop();
    })();
    return stopping;
  };
  wireCleanups.push(stopWire);
  registerCleanupFunction(stopWire);
  const root = server.rootFolder.QueryInterface(Ci.nsIMsgNewsFolder);
  const selected = names.map((name, index) =>
    root
      .addNewsgroup(name, index ? "" : "5001")
      .QueryInterface(Ci.nsIMsgNewsFolder)
  );
  for (const folder of selected) {
    Assert.equal(
      folder.server,
      server,
      "Each group uses this fake server's filters"
    );
  }
  if (filters) {
    const list = server.getFilterList(null);
    createFilter(list, "subject", "Read set 1-0", "read");
    if (nativeBackend) {
      // Native drafts must retain an explicit unread action over a read set.
      createFilter(list, "subject", "Read set 0-0", "unread");
    }
    server.setFilterList(list);
  }
  for (const folder of selected) {
    folder.clearFlag(Ci.nsMsgFolderFlags.Offline);
    const listener = new PromiseTestUtils.PromiseUrlListener();
    folder.getNewMessages(null, listener);
    await listener.promise;
  }
  return { server, account, folders: selected };
}

/**
 * Read the public article-number set for the supplied real group.
 *
 * @param {nsIMsgNewsFolder} folder - The group to inspect.
 * @returns {MsgKeySet} Its serialized newsrc article ranges.
 */
function readArticles(folder) {
  return new MsgKeySet(folder.newsrcLine.split(":")[1].trim());
}

add_task(async function test_readSetPersistsAcrossReopen() {
  articleFixture = await fetchReadSetArticles();
  const [folder, other] = articleFixture.folders;
  const db = folder.msgDatabase;
  const first = db.getMsgHdrForMessageID("s363-0-0@example.invalid");
  const neighbor = db.getMsgHdrForMessageID("s363-0-1@example.invalid");
  Assert.ok(first && neighbor, "Both actual XOVER articles were published");
  Assert.ok(first.isRead, "Article5001 inherits this group's read set");
  Assert.ok(!neighbor.isRead, "Article5002 is unread");
  Assert.ok(
    !other.msgDatabase.getMsgHdrForMessageID("s363-1-0@example.invalid").isRead,
    "The same article number in another group stays unread"
  );
  const keys = db.listAllKeys();
  if (nativeBackend) {
    Assert.equal(
      db.dBFolderInfo.getCharProperty("readSet"),
      "1-5001",
      "GROUP expiration and the original read article are both checkpointed"
    );
  }
  Cc["@mozilla.org/msgDatabase/msgDBService;1"]
    .getService(Ci.nsIMsgDBService)
    .forceFolderDBClosed(folder);
  const reopened = folder.msgDatabase;
  Assert.notEqual(reopened, db, "The closed group receives a new database");
  Assert.deepEqual(reopened.listAllKeys(), keys, "Physical identity survives");
  Assert.ok(
    reopened.getMsgHdrForMessageID("s363-0-0@example.invalid").isRead,
    "The read state survives actual database reopen"
  );
  Assert.ok(readArticles(folder).has(5001));
});

add_task(function test_liveFlagsPublishArticleReadSetBeforeListeners() {
  if (!nativeBackend) {
    info("Native transactional publication is covered in the native manifests");
    return;
  }
  const {
    server,
    folders: [folder],
  } = articleFixture;
  const db = folder.msgDatabase;
  const header = db.getMsgHdrForMessageID("s363-0-0@example.invalid");
  const key = header.messageKey;
  let expected;
  let readEvents = 0;
  let flagEvents = 0;
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged(changed, oldFlags, newFlags) {
      if (!((oldFlags ^ newFlags) & Ci.nsMsgMessageFlags.Read)) {
        return;
      }
      flagEvents++;
      Assert.equal(changed.messageKey, key);
      Assert.equal(
        changed.isRead,
        expected,
        "First callback sees native flags"
      );
      Assert.equal(
        readArticles(folder).has(5001),
        expected,
        "First callback sees the installed folder-owned set"
      );
      Assert.equal(
        new MsgKeySet(db.dBFolderInfo.getCharProperty("readSet")).has(5001),
        expected,
        "First callback sees the committed checkpoint"
      );
    },
    onReadChanged() {
      readEvents++;
      Assert.equal(readArticles(folder).has(5001), expected);
    },
    onHdrAdded() {},
    onHdrDeleted() {},
    onParentChanged() {},
    onAnnouncerGoingAway() {},
    onJunkScoreChanged() {},
    onHdrPropertyChanged() {},
    onEvent() {},
  };
  db.addListener(listener);
  try {
    for (const [read, change] of [
      [false, () => header.andFlags(~Ci.nsMsgMessageFlags.Read)],
      [true, () => header.orFlags(Ci.nsMsgMessageFlags.Read)],
      [
        false,
        () => {
          header.flags &= ~Ci.nsMsgMessageFlags.Read;
        },
      ],
      [true, () => db.markRead(key, true, null)],
    ]) {
      expected = read;
      server.newsrcHasChanged = false;
      const before = readEvents;
      change();
      Assert.equal(readEvents, before + 1, "One actual read event per change");
      Assert.equal(header.isRead, read);
      Assert.ok(server.newsrcHasChanged, "The real news folder marks dirty");
      Assert.equal(folder.getTotalMessages(false), 2);
      Assert.equal(header.messageKey, key);
    }
    Assert.equal(flagEvents, 4, "All four live write paths publish once");
  } finally {
    db.removeListener(listener);
  }
});

add_task(function test_sameArticleNumberStaysScopedToGroup() {
  const [folder, other] = articleFixture.folders;
  const header = folder.msgDatabase.getMsgHdrForMessageID(
    "s363-0-0@example.invalid"
  );
  const neighbor = folder.msgDatabase.getMsgHdrForMessageID(
    "s363-0-1@example.invalid"
  );
  const otherHeader = other.msgDatabase.getMsgHdrForMessageID(
    "s363-1-0@example.invalid"
  );
  if (nativeBackend) {
    Assert.notEqual(header.messageKey, 5001, "Article is not a native key");
    Assert.notEqual(
      header.messageKey,
      otherHeader.messageKey,
      "Overlapping article numbers have different physical identities"
    );
  }
  for (const read of [false, true]) {
    folder.markMessagesRead([header], read);
    Assert.equal(header.isRead, read);
    Assert.equal(readArticles(folder).has(5001), read);
    Assert.ok(!neighbor.isRead, "The adjacent article stays unread");
    Assert.ok(!otherHeader.isRead, "The other group stays unread");
    Assert.ok(!readArticles(other).has(5001));
    Assert.equal(folder.getNumUnread(false), read ? 1 : 2);
  }
});

add_task(async function test_nativeFailedExpiryPreservesPhysicalState() {
  if (!nativeBackend) {
    info("Legacy expiry is checked by the existing ordinary expiry file");
    return;
  }
  class MalformedListHandler extends NNTP_RFC2980_handler {
    LISTGROUP() {
      return "211 Articles follow:\n5001\ninvalid-article\n.\n";
    }
  }
  const {
    server,
    folders: [folder],
  } = await fetchReadSetArticles(MalformedListHandler);
  const db = folder.msgDatabase;
  const keys = db.listAllKeys();
  Assert.equal(keys.length, 2, "The actual NNTP headers are retained");
  Assert.ok(
    keys.every(key => key != 5001 && key != 5002),
    "Physical keys do not overlap the server's live article numbers"
  );
  const flags = keys.map(key => db.getMsgHdrForKey(key).flags);
  const readSet = folder.newsrcLine;
  const known = db.dBFolderInfo.knownArtsSet;
  Assert.ok(new MsgKeySet(known).has(5001));
  Assert.ok(new MsgKeySet(known).has(5002));
  const dirty = server.newsrcHasChanged;
  const pool = server.wrappedJSObject;
  const withClient = sinon.spy(pool, "withClient");
  try {
    await Assert.rejects(
      pool.removeExpiredArticles(folder.name),
      /NS_ERROR_ILLEGAL_VALUE/,
      "Malformed LISTGROUP rejects with the actual parse error before deletion"
    );
    Assert.equal(
      withClient.callCount,
      1,
      "The actual LISTGROUP request was started"
    );
  } finally {
    withClient.restore();
  }
  Assert.deepEqual(
    db.listAllKeys(),
    keys,
    "No live physical header is removed"
  );
  Assert.deepEqual(
    keys.map(key => db.getMsgHdrForKey(key).flags),
    flags
  );
  Assert.equal(folder.newsrcLine, readSet);
  Assert.equal(db.dBFolderInfo.knownArtsSet, known);
  Assert.equal(server.newsrcHasChanged, dirty);
});

add_task(function test_failedReadSetReplacementRetainsPreviousSet() {
  if (!nativeBackend) {
    info("The closed native facade and signed range controls are native-only");
    return;
  }
  const { server } = createReadSetAccount("closed-readset.invalid");
  const folder = server.rootFolder
    .QueryInterface(Ci.nsIMsgNewsFolder)
    .addNewsgroup("test.closed-readset", "2-4,8")
    .QueryInterface(Ci.nsIMsgNewsFolder);
  const before = folder.newsrcLine;
  Assert.throws(
    () => folder.setReadSetFromStr("2147483648"),
    exception => exception.result == Cr.NS_ERROR_ILLEGAL_VALUE,
    "Overflow is rejected before parsing"
  );
  Assert.equal(folder.newsrcLine, before);
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  // Register before the folder binds itself, so the real close notification
  // reaches this observer while the folder still owns the just-closed facade.
  const raw = service.openFolderDB(folder, false);
  let reached = false;
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onAnnouncerGoingAway() {
      reached = true;
      Assert.throws(
        () => folder.setReadSetFromStr("6-7"),
        exception => exception.result == Cr.NS_ERROR_NOT_AVAILABLE,
        "A real closed facade rejects replacement"
      );
      Assert.equal(
        folder.newsrcLine,
        before,
        "Failed replacement keeps the old owner"
      );
    },
    onHdrFlagsChanged() {},
    onHdrAdded() {},
    onHdrDeleted() {},
    onParentChanged() {},
    onReadChanged() {},
    onJunkScoreChanged() {},
    onHdrPropertyChanged() {},
    onEvent() {},
  };
  raw.addListener(listener);
  Assert.equal(folder.msgDatabase, raw, "The real folder binds that facade");
  raw.forceClosed();
  Assert.ok(reached, "The failing setter was actually reached during close");
  const reopened = folder.msgDatabase;
  Assert.notEqual(reopened, raw);
  folder.setReadSetFromStr("6-7");
  Assert.equal(reopened.dBFolderInfo.getCharProperty("readSet"), "6-7");
  Assert.equal(folder.newsrcLine.trim(), "test.closed-readset: 6-7");
  const held = server.rootFolder
    .QueryInterface(Ci.nsIMsgNewsFolder)
    .addNewsgroup("test.held-binding", "0")
    .QueryInterface(Ci.nsIMsgNewsFolder);
  const reader = new NntpNewsGroup(server, held);
  reader.getArticlesRangeToFetch(null, 0, 0);
  reader.processXOverLine(
    "0\tHeld\tReader <reader@example.invalid>\tThu, 01 Oct 2026 12:00:00 +0000\t<held-binding@example.invalid>\t\t20\t1"
  );
  reader.finishProcessingXOver();
  reader.cleanUp();
  const heldDB = held.msgDatabase;
  const heldHeader = heldDB.getMsgHdrForMessageID(
    "held-binding@example.invalid"
  );
  server.writeNewsrcFile();
  Assert.ok(
    !server.newsrcHasChanged,
    "Persist live groups before retiring one"
  );
  held.msgDatabase = null;
  held.Shutdown(false);
  heldHeader.markRead(false);
  Assert.ok(
    !server.newsrcHasChanged,
    "A retired folder does not receive read events"
  );
  Assert.ok(
    !heldHeader.isRead,
    "A retained live header is safe after its set owner shuts down with an empty DB cache"
  );
  Assert.equal(
    heldDB.listAllKeys().length,
    1,
    "Matching detach preserves database membership"
  );
});

add_task(async function test_newsrcWriteFailureRetainsPreviousFileAndRetry() {
  const { server } = createReadSetAccount("write-readset.invalid");
  const folder = server.rootFolder
    .QueryInterface(Ci.nsIMsgNewsFolder)
    .addNewsgroup("test.write-readset", "2-4")
    .QueryInterface(Ci.nsIMsgNewsFolder);
  server.QueryInterface(Ci.nsISubscribableServer).commitSubscribeChanges();
  const path = server.newsrcFilePath.path;
  const previous = await IOUtils.readUTF8(path);
  Assert.ok(previous.includes("test.write-readset: 2-4"));
  for (const phase of ["write", "finish"]) {
    folder.setReadSetFromStr("6-8");
    const error = Components.Exception(
      `newsrc-${phase}`,
      Cr.NS_ERROR_FILE_ACCESS_DENIED
    );
    const real = FileUtils.openSafeFileOutputStream(server.newsrcFilePath);
    let writes = 0;
    let finishes = 0;
    let closes = 0;
    const mock = sinon.stub(FileUtils, "openSafeFileOutputStream").returns({
      QueryInterface: ChromeUtils.generateQI(["nsISafeOutputStream"]),
      write(data, count) {
        writes++;
        if (phase == "write") {
          throw error;
        }
        return real.write(data, count);
      },
      flush() {
        real.flush();
      },
      finish() {
        finishes++;
        throw error;
      },
      close() {
        closes++;
        real.close();
        throw Components.Exception("secondary close", Cr.NS_ERROR_ABORT);
      },
    });
    try {
      Assert.throws(
        () =>
          server
            .QueryInterface(Ci.nsISubscribableServer)
            .commitSubscribeChanges(),
        exception => exception.result == error.result,
        "The void public caller preserves the original error"
      );
    } finally {
      mock.restore();
    }
    Assert.greater(
      writes,
      0,
      "The actual safe writer reached its write operation"
    );
    Assert.equal(
      finishes,
      phase == "finish" ? 1 : 0,
      "Finish is called only once after a successful write"
    );
    Assert.equal(closes, 1, "Failure aborts the native temporary stream once");
    Assert.ok(server.newsrcHasChanged, "Failed persistence remains dirty");
    Assert.equal(
      await IOUtils.readUTF8(path),
      previous,
      "The old target file survives failure"
    );
    folder.setReadSetFromStr("2-4");
    server.writeNewsrcFile();
    Assert.equal(
      await IOUtils.readUTF8(path),
      previous,
      "A repaired retry persists correctly"
    );
    Assert.ok(
      !server.newsrcHasChanged,
      "Only successful finish clears dirty state"
    );
  }
});

add_task(async function test_headAndXoverUseCapturedArticleNumbers() {
  for (const handler of [NNTP_RFC977_handler, NNTP_RFC2980_handler]) {
    const filterHits = sinon.spy(NntpNewsGroup.prototype, "applyFilterHit");
    let fixture;
    try {
      fixture = await fetchReadSetArticles(handler, true);
      info(
        JSON.stringify(
          filterHits.getCalls().map(call => ({
            filter: call.args[0].filterName,
            messageId: call.thisValue._filteringHdr.messageId,
            read: call.thisValue._filteringHdr.isRead,
          }))
        )
      );
      Assert.ok(filterHits.called, "The actual installed filter was hit");
    } finally {
      filterHits.restore();
    }
    const [folder, other] = fixture.folders;
    const db = folder.msgDatabase;
    Assert.equal(
      folder.getTotalMessages(false),
      2,
      "Each actual article is published once"
    );
    const keys = db.listAllKeys();
    Assert.equal(
      new Set(keys).size,
      2,
      "HEAD never queues its pending header twice"
    );
    const first = db.getMsgHdrForMessageID("s363-0-0@example.invalid");
    const second = db.getMsgHdrForMessageID("s363-0-1@example.invalid");
    Assert.ok(first && second);
    Assert.equal(
      first.isRead,
      !nativeBackend,
      "Native explicit unread wins over the checkpoint; legacy ranges retain their priority"
    );
    Assert.ok(!second.isRead, "A neighboring article remains unread");
    Assert.ok(
      other.msgDatabase.getMsgHdrForMessageID("s363-1-0@example.invalid")
        .isRead,
      "An actual MarkRead filter publishes its read intent over an empty checkpoint"
    );
    if (nativeBackend) {
      Assert.ok(!readArticles(folder).has(5001));
      Assert.ok(readArticles(other).has(5001));
    }
    const listener = new PromiseTestUtils.PromiseUrlListener();
    folder.getNewMessages(null, listener);
    await listener.promise;
    Assert.deepEqual(
      folder.msgDatabase.listAllKeys(),
      keys,
      "Repeat fetch does not republish or refilter the same articles"
    );
    Assert.equal(first.isRead, !nativeBackend);
  }
});

add_task(function test_articleZeroDistinctFromMissing() {
  if (!nativeBackend) {
    info(
      "Present native article0 versus absent custody is a native-only control"
    );
    return;
  }
  const { server, account } = createReadSetAccount("zero-readset.invalid");
  const folder = server.rootFolder
    .QueryInterface(Ci.nsIMsgNewsFolder)
    .addNewsgroup("test.zero-readset", "0")
    .QueryInterface(Ci.nsIMsgNewsFolder);
  const reader = new NntpNewsGroup(server, folder);
  reader.getArticlesRangeToFetch(null, 0, 0);
  reader.processXOverLine(
    "0\tZero\tReader <reader@example.invalid>\tThu, 01 Oct 2026 12:00:00 +0000\t<zero-s363@example.invalid>\t\t20\t1"
  );
  reader.finishProcessingXOver();
  reader.cleanUp();
  const db = folder.msgDatabase;
  const header = db.getMsgHdrForMessageID("zero-s363@example.invalid");
  Assert.ok(header, "A real captured article0 was published");
  Assert.ok(header.isRead, "Exact native zero membership is retained");
  Assert.greater(header.messageKey, 0, "The actual physical key is positive");
  Assert.notEqual(
    header.messageKey,
    0xffffffff,
    "Zero is an article, not a fabricated physical key"
  );
  const keys = db.listAllKeys();
  Assert.throws(
    () =>
      reader.processXOverLine("2147483648\tBad\tReader\tdate\t<bad>\t\t1\t1"),
    exception => exception.result == Cr.NS_ERROR_ILLEGAL_VALUE,
    "An unrepresentable article is rejected before native writes"
  );
  const absent = new NntpNewsGroup(server, folder);
  absent.getArticlesRangeToFetch(null, 0, 0);
  absent.initHdr(-1);
  absent.finishProcessingXOver();
  absent.cleanUp();
  Assert.deepEqual(
    folder.msgDatabase.listAllKeys(),
    keys,
    "The HEAD sentinel creates no missing/zero alias"
  );
  server.newsrcHasChanged = true;
  server.writeNewsrcFile();
  const unreadZero = server.rootFolder
    .QueryInterface(Ci.nsIMsgNewsFolder)
    .addNewsgroup("test.zero-unread", "0")
    .QueryInterface(Ci.nsIMsgNewsFolder);
  const secondReader = new NntpNewsGroup(server, unreadZero);
  secondReader.getArticlesRangeToFetch(null, 0, 1);
  for (const article of [0, 1]) {
    secondReader.processXOverLine(
      `${article}\tCompanion\tReader <reader@example.invalid>\tThu, 01 Oct 2026 12:00:00 +0000\t<zero-companion-${article}@example.invalid>\t\t20\t1`
    );
  }
  secondReader.finishProcessingXOver();
  secondReader.cleanUp();
  const zero = unreadZero.msgDatabase.getMsgHdrForMessageID(
    "zero-companion-0@example.invalid"
  );
  const one = unreadZero.msgDatabase.getMsgHdrForMessageID(
    "zero-companion-1@example.invalid"
  );
  zero.markRead(false);
  one.markRead(true);
  Assert.equal(
    unreadZero.msgDatabase.dBFolderInfo.getCharProperty("readSet"),
    "1"
  );
  Assert.ok(
    !zero.isRead && one.isRead,
    "Zero unread and one read coexist before cold reopen"
  );
  server.newsrcHasChanged = true;
  server.writeNewsrcFile();
  zeroFixture = {
    accountKey: account.key,
    folderId: folder.id,
    key: header.messageKey,
    unreadId: unreadZero.id,
    zeroKey: zero.messageKey,
    oneKey: one.messageKey,
  };
});

add_task(async function test_subscriptionNewsrcPersistsAcrossReopen() {
  const { server, account } = createReadSetAccount("reopen-readset.invalid");
  const names = ["test.retained", "test.empty", "test.ünicode"];
  const ranges = ["2-4,8", "", "7,10-12"];
  const root = server.rootFolder.QueryInterface(Ci.nsIMsgNewsFolder);
  const selected = names.map((name, index) =>
    root.addNewsgroup(name, ranges[index])
  );
  const ids = nativeBackend ? selected.map(folder => folder.id) : [];
  const lines = selected.map(
    folder => folder.QueryInterface(Ci.nsIMsgNewsFolder).newsrcLine
  );
  // Establish actual native checkpoints as well as the ordinary newsrc file.
  for (const folder of selected) {
    Assert.ok(folder.msgDatabase);
  }
  server.QueryInterface(Ci.nsISubscribableServer).commitSubscribeChanges();
  const path = server.newsrcFilePath.path;
  const bytes = await IOUtils.read(path);
  Assert.equal(
    new TextDecoder().decode(bytes),
    lines.join(""),
    "Exact UTF-8 and normal line endings persist"
  );
  const accountKey = account.key;
  for (const stopWire of wireCleanups) {
    await stopWire();
  }
  for (const owned of accounts) {
    MailServices.accounts
      .getAccount(owned.key)
      .incomingServer.QueryInterface(Ci.nsINntpIncomingServer)
      .writeNewsrcFile();
  }
  MailServices.accounts.saveAccountInfo();
  // The two earlier announcer-only fixtures intentionally own explicit listeners.
  // Remove those before the real account manager shuts down their databases.
  for (let i = 0; i < databases.length; i++) {
    databases[i].removeListener(folders[i]);
  }
  databases.length = 0;
  MailServices.accounts.unloadAccounts();
  MailServices.accounts.loadAccounts();
  const reopened = MailServices.accounts
    .getAccount(accountKey)
    .incomingServer.QueryInterface(Ci.nsINntpIncomingServer);
  Assert.notEqual(
    reopened,
    server,
    "The account manager reconstructed the server"
  );
  Assert.equal(reopened.newsrcFilePath.path, path);
  const reopenedGroups = reopened.rootFolder.subFolders;
  Assert.deepEqual(
    reopenedGroups.map(folder => folder.name),
    names,
    "Subscriptions survive actual account reload"
  );
  Assert.deepEqual(
    reopenedGroups.map(
      folder => folder.QueryInterface(Ci.nsIMsgNewsFolder).newsrcLine
    ),
    lines
  );
  if (nativeBackend) {
    Assert.deepEqual(
      reopenedGroups.map(folder => folder.id),
      ids,
      "Cold reload retains physical group identity"
    );
    const zeroServer = MailServices.accounts.getAccount(
      zeroFixture.accountKey
    ).incomingServer;
    const zero = zeroServer.rootFolder.getChildNamed("test.zero-readset");
    Assert.equal(zero.id, zeroFixture.folderId);
    const header = zero.msgDatabase.getMsgHdrForKey(zeroFixture.key);
    Assert.ok(
      header.isRead,
      "Exact zero membership survives lossy newsrc and cold account reload"
    );
    const unreadZero = zeroServer.rootFolder.getChildNamed("test.zero-unread");
    Assert.equal(unreadZero.id, zeroFixture.unreadId);
    Assert.ok(
      !unreadZero.msgDatabase.getMsgHdrForKey(zeroFixture.zeroKey).isRead,
      "Known false zero survives text1's legacy parser meaning"
    );
    Assert.ok(
      unreadZero.msgDatabase.getMsgHdrForKey(zeroFixture.oneKey).isRead
    );
  }
  Assert.deepEqual(
    await IOUtils.read(path),
    bytes,
    "Reopen does not rewrite the persisted source"
  );
});

/**
 * Restore native groups before the ordinary newsrc loader has seen their lines.
 *
 * @param {string} hostname - The account's distinct hostname.
 * @param {string[]} names - The persisted physical groups in insertion order.
 * @param {string} newsrc - The existing file contents.
 * @returns {Promise<{server: nsINntpIncomingServer, account: nsIMsgAccount,
 *   ids: number[]}>} The cold account and its existing group identities.
 */
async function createColdReadSetAccount(hostname, names, newsrc) {
  const account = MailServices.accounts.createAccount();
  accounts.push(account);
  const key = `newsrcCold${accounts.length}`;
  const branch = `mail.server.${key}.`;
  Assert.equal(Services.prefs.getChildList(branch).length, 0);
  Services.prefs.setCharPref(`${branch}type`, "nntp");
  Services.prefs.setCharPref(`${branch}hostname`, hostname);
  Services.prefs.setBoolPref(`${branch}valid`, false);
  const core = Cc["@mozilla.org/mailnews/database-core;1"].getService(
    Ci.nsIDatabaseCore
  );
  Assert.equal(
    core.folderDB.getFolderChildNamed(0, key),
    0,
    "The ordinary account has not initialized its root before restoration"
  );
  const rootId = core.folderDB.insertRoot(key);
  const ids = names.map(name => {
    const id = core.folderDB.insertFolder(rootId, name);
    core.folderDB.updateFlags(id, Ci.nsMsgFolderFlags.Newsgroup);
    return id;
  });
  // Both account-manager creation routes eagerly initialize the root. Seed the
  // persisted identity before that normal load, as in the news factory test.
  const server = MailServices.accounts
    .getIncomingServer(key)
    .QueryInterface(Ci.nsINntpIncomingServer);
  account.incomingServer = server;
  await IOUtils.writeUTF8(server.newsrcFilePath.path, newsrc);
  server.valid = true;
  return { server, account, ids };
}

add_task(async function test_failedNewsrcLoadRetainsFileAndRetries() {
  if (!nativeBackend) {
    info("Failed native restoration and strict signed ranges are native-only");
    return;
  }
  const names = ["a.group", "bad.group", "c.group"];
  const previous = "a.group: 1-5\nbad.group: 2147483648\nc.group: 1-7\n";
  const { server, ids } = await createColdReadSetAccount(
    "failed-load.invalid",
    names,
    previous
  );
  const path = server.newsrcFilePath.path;
  const root = server.rootFolder.QueryInterface(Ci.nsIMsgNewsFolder);
  const first = root.addNewsgroup(names[0], "1-5");
  Assert.equal(first.id, ids[0], "The live group reuses its persisted row");
  Assert.throws(
    () => root.subFolders,
    exception => exception.result == Cr.NS_ERROR_ILLEGAL_VALUE,
    "The malformed middle line stops loading with its primary error"
  );
  const open = sinon.spy(FileUtils, "openSafeFileOutputStream");
  try {
    Assert.throws(
      () =>
        server
          .QueryInterface(Ci.nsISubscribableServer)
          .commitSubscribeChanges(),
      exception => exception.result == Cr.NS_ERROR_ILLEGAL_VALUE,
      "The public dirty write retries loading and preserves the first error"
    );
    Assert.ok(!open.called, "Partial loading never opens a replacement stream");
  } finally {
    open.restore();
  }
  Assert.ok(server.newsrcHasChanged, "The failed write stays dirty");
  Assert.equal(
    await IOUtils.readUTF8(path),
    previous,
    "The malformed source and the unreached valid line remain byte-for-byte"
  );
  const repaired = "a.group: 1-5\nbad.group: 2-4\nc.group: 1-7\n";
  await IOUtils.writeUTF8(path, repaired);
  const selected = root.subFolders;
  Assert.deepEqual(
    selected.map(folder => folder.name),
    names
  );
  Assert.deepEqual(
    selected.map(folder => folder.id),
    ids
  );
  Assert.equal(
    selected[0],
    first,
    "Retry retains the existing physical object"
  );
  Assert.equal(new Set(selected.map(folder => folder.id)).size, names.length);
  const lines = selected.map(
    folder => folder.QueryInterface(Ci.nsIMsgNewsFolder).newsrcLine
  );
  Assert.deepEqual(
    lines.map(line => line.trim()),
    ["a.group: 1-5", "bad.group: 2-4", "c.group: 1-7"]
  );
  Assert.deepEqual(
    root.subFolders,
    selected,
    "Repeat access adds no membership"
  );
  for (const name of names) {
    Assert.ok(
      server.containsNewsgroup(name),
      "Each repaired group is subscribed"
    );
  }
  server.writeNewsrcFile();
  Assert.equal(await IOUtils.readUTF8(path), lines.join(""));
  Assert.ok(
    !server.newsrcHasChanged,
    "Successful repaired persistence clears dirty"
  );
});

add_task(async function test_restoredGroupWithoutNewsrcLineStaysSeparate() {
  if (!nativeBackend) {
    info("Native physical groups can predate their first newsrc write");
    return;
  }
  const names = ["orphan.group", "a.group", "b.group"];
  const { server, account, ids } = await createColdReadSetAccount(
    "orphan-line.invalid",
    names,
    "a.group: 1-5\nb.group: 1-7\n"
  );
  const root = server.rootFolder;
  const selected = root.subFolders;
  Assert.deepEqual(
    selected.map(folder => folder.name),
    names
  );
  Assert.deepEqual(
    selected.map(folder => folder.id),
    ids
  );
  const lines = selected.map(
    folder => folder.QueryInterface(Ci.nsIMsgNewsFolder).newsrcLine
  );
  const newline = lines[1].endsWith("\r\n") ? "\r\n" : "\n";
  Assert.equal(
    lines[0],
    `orphan.group:${newline}`,
    "An absent set has its own line"
  );
  Assert.deepEqual(
    lines.map(line => line.trim()),
    ["orphan.group:", "a.group: 1-5", "b.group: 1-7"]
  );
  server.QueryInterface(Ci.nsISubscribableServer).commitSubscribeChanges();
  const path = server.newsrcFilePath.path;
  const bytes = await IOUtils.read(path);
  Assert.equal(new TextDecoder().decode(bytes), lines.join(""));
  Assert.ok(!server.newsrcHasChanged);
  for (const owned of accounts) {
    MailServices.accounts
      .getAccount(owned.key)
      .incomingServer.QueryInterface(Ci.nsINntpIncomingServer)
      .writeNewsrcFile();
  }
  MailServices.accounts.saveAccountInfo();
  MailServices.accounts.unloadAccounts();
  MailServices.accounts.loadAccounts();
  const reopened = MailServices.accounts
    .getAccount(account.key)
    .incomingServer.QueryInterface(Ci.nsINntpIncomingServer);
  Assert.notEqual(
    reopened,
    server,
    "The real account manager recreated the server"
  );
  const restored = reopened.rootFolder.subFolders;
  Assert.deepEqual(
    restored.map(folder => folder.name),
    names
  );
  Assert.deepEqual(
    restored.map(folder => folder.id),
    ids
  );
  Assert.equal(new Set(restored.map(folder => folder.id)).size, names.length);
  Assert.deepEqual(
    restored.map(folder =>
      folder.QueryInterface(Ci.nsIMsgNewsFolder).newsrcLine.trim()
    ),
    ["orphan.group:", "a.group: 1-5", "b.group: 1-7"],
    "Reload keeps both valid ranges separate from the formerly absent line"
  );
  Assert.deepEqual(reopened.rootFolder.subFolders, restored);
  for (const name of names) {
    Assert.ok(reopened.containsNewsgroup(name));
  }
  Assert.deepEqual(
    await IOUtils.read(path),
    bytes,
    "Reload does not rewrite the file"
  );
});

/**
 * Create a real native group and its ordinary header producer.
 *
 * @param {string} name - Unique account and group suffix.
 * @returns {{server: nsINntpIncomingServer, folder: nsIMsgNewsFolder,
 *   reader: NntpNewsGroup}} The owned producer and group.
 */
function createArticleProducer(name) {
  const { server } = createReadSetAccount(`s364-${name}.invalid`);
  const folder = server.rootFolder
    .QueryInterface(Ci.nsIMsgNewsFolder)
    .addNewsgroup(`test.s364.${name}`, "")
    .QueryInterface(Ci.nsIMsgNewsFolder);
  const reader = new NntpNewsGroup(server, folder);
  reader.getArticlesRangeToFetch(null, 0, 0x7fffffff);
  return { server, folder, reader };
}

/**
 * Build an ordinary overview record with ordered references and Unicode.
 *
 * @param {number} article - The protocol article number.
 * @param {string} id - The message identifier without brackets.
 * @returns {string} The tab-separated overview record.
 */
function articleProducerLine(article, id) {
  return `${article}\tS364 sübject\tReader <reader@example.invalid>\tThu, 01 Oct 2026 12:00:00 +0000\t<${id}>\t<first@example.invalid> <second@example.invalid>\t42\t3`;
}

add_task(function test_nativeArticleProducerKeepsCapturedGroupIdentity() {
  if (!nativeBackend) {
    info(
      "Native physical article identity is covered by the native registrations"
    );
    return;
  }
  const fixtures = [
    createArticleProducer("identity-one"),
    createArticleProducer("identity-two"),
  ];
  const keys = [];
  for (const { folder, reader } of fixtures) {
    for (const article of [0, 0x7fffffff]) {
      reader.processXOverLine(
        articleProducerLine(article, "crosspost-s364@example.invalid")
      );
    }
    Assert.equal(
      folder.getTotalMessages(false),
      0,
      "Detached parser input is not published"
    );
    reader.finishProcessingXOver();
    reader.cleanUp();
    for (const article of [0, 0x7fffffff]) {
      const live = folder.msgDatabase.createNewHdrWithSpecificMsgKey(article);
      Assert.ok(
        live.isLive,
        "The article resolves through the captured native mapping"
      );
      Assert.equal(live.folder, folder);
      Assert.equal(live.messageId, "crosspost-s364@example.invalid");
      Assert.greater(live.messageKey, 0);
      Assert.notEqual(
        live.messageKey,
        article,
        "A global key is not an article-number alias"
      );
      keys.push(live.messageKey);
    }
    Assert.equal(folder.getTotalMessages(false), 2);
    const missing = folder.msgDatabase.createNewHdrWithSpecificMsgKey(17);
    Assert.ok(!missing.isLive, "Absent article17 is not native article0");
    Assert.equal(missing.messageKey, 0xffffffff);
  }
  Assert.equal(
    new Set(keys).size,
    4,
    "Equal Message-IDs and article numbers stay scoped to each physical group"
  );
});

add_task(async function test_nativeArticlePublicationWaitsForCompletedInput() {
  if (!nativeBackend) {
    return;
  }
  const { folder, reader } = createArticleProducer("complete");
  const seen = [];
  const listener = {
    msgAdded(header) {
      if (header.folder == folder) {
        seen.push({
          key: header.messageKey,
          subject: header.subject,
          extra: header.getStringProperty("x-s364-extra"),
          references: Array.from({ length: header.numReferences }, (_, i) =>
            header.getStringReference(i)
          ),
          attached: folder.msgDatabase.containsKey(header.messageKey),
        });
      }
    },
  };
  MailServices.mfn.addListener(
    listener,
    Ci.nsIMsgFolderNotificationService.msgAdded
  );
  registerCleanupFunction(() => MailServices.mfn.removeListener(listener));
  reader.processXOverLine(
    articleProducerLine(30001, "complete-s364@example.invalid")
  );
  Assert.equal(seen.length, 0, "Overview parsing alone does not publish");
  reader.processXHdrLine("x-s364-extra", "30001 completed-extra");
  Assert.equal(
    seen.length,
    0,
    "Extra-header parsing still precedes completion"
  );
  reader.finishProcessingXOver();
  const live = folder.msgDatabase.createNewHdrWithSpecificMsgKey(30001);
  Assert.deepEqual(
    seen,
    [
      {
        key: live.messageKey,
        subject: "S364 sübject",
        extra: "completed-extra",
        references: ["first@example.invalid", "second@example.invalid"],
        attached: true,
      },
    ],
    "The one published notification observes the complete ingested header"
  );
  reader.finishProcessingXOver();
  reader.cleanUp();
  reader.cleanUp();
  Assert.equal(seen.length, 1, "Repeated successful finish never republishes");
  Assert.throws(
    () => reader.processHeadLine("Subject: late"),
    error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
  );
  // Exercise the real HEAD fallback and XOVER/XHDR caller paths as well.
  for (const handler of [NNTP_RFC977_handler, NNTP_RFC2980_handler]) {
    const fixture = await fetchReadSetArticles(handler);
    Assert.equal(fixture.folders[0].getTotalMessages(false), 2);
    Assert.equal(fixture.folders[1].getTotalMessages(false), 1);
  }
});

add_task(function test_nativeFailedArticleProducerDoesNotPublish() {
  if (!nativeBackend) {
    return;
  }
  const { folder, reader } = createArticleProducer("failed");
  reader.processXOverLine(
    articleProducerLine(30002, "failed-s364@example.invalid")
  );
  const known = folder.msgDatabase.dBFolderInfo.knownArtsSet;
  reader._db.forceClosed();
  let first;
  Assert.throws(
    () => reader.finishProcessingXOver(),
    error => {
      first = error;
      return error.result == Cr.NS_ERROR_NOT_AVAILABLE;
    }
  );
  Assert.throws(
    () => reader.finishProcessingXOver(),
    error => error === first,
    "The failed producer retains its first exception"
  );
  Assert.throws(
    () =>
      reader.processXOverLine(
        articleProducerLine(30003, "late-s364@example.invalid")
      ),
    error => error === first
  );
  Assert.equal(
    folder.getTotalMessages(false),
    0,
    "A failed detached producer leaves no published article"
  );
  Assert.equal(
    folder.msgDatabase.dBFolderInfo.knownArtsSet,
    known,
    "Failed input does not mark a completed range"
  );
  Assert.throws(
    () =>
      folder.msgDatabase.getMsgHdrForMessageID("failed-s364@example.invalid"),
    error => error.result == Cr.NS_ERROR_ILLEGAL_VALUE,
    "The failed article has no native Message-ID mapping"
  );
});

add_task(function test_nativeArticleCompletionKeepsFirstErrorAndFinishesOnce() {
  if (!nativeBackend) {
    return;
  }
  for (const initial of [Cr.NS_OK, Cr.NS_ERROR_NET_RESET]) {
    const { server, folder, reader } = createArticleProducer(
      `completion-${initial}`
    );
    const client = new NntpClient(server);
    const statuses = [];
    let idle = 0;
    let cleanup = 0;
    const original = reader.cleanUp.bind(reader);
    reader.cleanUp = status => {
      cleanup++;
      original(status);
      throw Components.Exception(
        "Real caller cleanup cut",
        Cr.NS_ERROR_FILE_ACCESS_DENIED
      );
    };
    const listener = {
      OnStartRunningUrl() {},
      OnStopRunningUrl(uri, status) {
        Assert.equal(uri, url, "Stop retains the completed URL after reset");
        statuses.push(status);
      },
    };
    const url = client.startRunningUrl(listener, null);
    client._newsFolder = folder;
    client._newsGroup = reader;
    client.onDone = status => {
      Assert.equal(cleanup, 1, "Cleanup settles before the terminal callback");
      statuses.push(status);
    };
    client.onIdle = () => idle++;
    client._actionDone(initial);
    client._actionDone();
    const expected = Components.isSuccessCode(initial)
      ? Cr.NS_ERROR_FILE_ACCESS_DENIED
      : initial;
    Assert.deepEqual(
      statuses,
      [expected, expected],
      "Terminal consumers share the original first failure"
    );
    Assert.equal(cleanup, 1);
    Assert.equal(idle, 1, "The connection is released exactly once");
  }
});

add_task(function test_nativeArticleRetryKeepsCommittedIdentity() {
  if (!nativeBackend) {
    return;
  }
  const { server, folder, reader } = createArticleProducer("retry");
  const seen = [];
  const listener = {
    msgAdded(header) {
      if (header.folder == folder) {
        seen.push(header.messageKey);
        if (seen.length == 1) {
          reader._db.forceClosed();
        }
      }
    },
  };
  MailServices.mfn.addListener(
    listener,
    Ci.nsIMsgFolderNotificationService.msgAdded
  );
  registerCleanupFunction(() => MailServices.mfn.removeListener(listener));
  for (const article of [30004, 30005]) {
    reader.processXOverLine(
      articleProducerLine(article, `retry-${article}@example.invalid`)
    );
  }
  Assert.throws(
    () => reader.finishProcessingXOver(),
    error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
  );
  Assert.equal(
    seen.length,
    1,
    "The completed prefix is retained when the next producer fails"
  );
  const firstKey = seen[0];
  const retry = new NntpNewsGroup(server, folder);
  retry.getArticlesRangeToFetch(null, 30004, 30005);
  for (const article of [30004, 30005]) {
    retry.processXOverLine(
      articleProducerLine(article, `retry-${article}@example.invalid`)
    );
  }
  retry.finishProcessingXOver();
  retry.cleanUp();
  Assert.equal(
    folder.msgDatabase.createNewHdrWithSpecificMsgKey(30004).messageKey,
    firstKey
  );
  Assert.equal(folder.getTotalMessages(false), 2);
  Assert.equal(
    seen.length,
    2,
    "Retry publishes only the previously absent article"
  );
  Assert.equal(new Set(seen).size, 2);
});

add_task(function test_nativeStaleArticleProducerCannotComplete() {
  if (!nativeBackend) {
    return;
  }
  const first = createArticleProducer("stale");
  const other = createArticleProducer("other");
  first.reader.processXOverLine(
    articleProducerLine(30006, "stale-s364@example.invalid")
  );
  const draft = first.reader._msgHdrs[0];
  Assert.throws(
    () => other.folder.msgDatabase.attachHdr(draft, true),
    error => error.result == Cr.NS_ERROR_INVALID_ARG,
    "A captured draft cannot publish into another physical group"
  );
  first.reader.cleanUp(Cr.NS_ERROR_ABORT);
  Assert.throws(
    () => first.reader.finishProcessingXOver(),
    error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
    "Aborted producer completion stays closed"
  );
  Assert.equal(first.folder.getTotalMessages(false), 0);
  Assert.equal(other.folder.getTotalMessages(false), 0);
  const current = new NntpNewsGroup(first.server, first.folder);
  current.getArticlesRangeToFetch(null, 30006, 30006);
  current.processXOverLine(
    articleProducerLine(30006, "current-s364@example.invalid")
  );
  current.finishProcessingXOver();
  current.cleanUp();
  Assert.equal(
    first.folder.getTotalMessages(false),
    1,
    "A fresh current producer still succeeds"
  );
  Assert.equal(
    first.folder.msgDatabase.createNewHdrWithSpecificMsgKey(30006).messageId,
    "current-s364@example.invalid"
  );
});
