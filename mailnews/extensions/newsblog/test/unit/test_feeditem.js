/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { FeedEnclosure, FeedItem } = ChromeUtils.importESModule(
  "resource:///modules/FeedItem.sys.mjs"
);
const { MimeParser } = ChromeUtils.importESModule(
  "resource:///modules/mimeParser.sys.mjs"
);

const TAG_KEY = "rss-camera";
const TAG_NAME = "Cameras";

add_setup(function () {
  MailServices.tags.addTagForKey(TAG_KEY, TAG_NAME, "", FeedUtils.AUTOTAG);
  registerCleanupFunction(() => MailServices.tags.deleteKey(TAG_KEY));
});

/**
 * Create an RSS item and write it directly to a folder.
 *
 * @param {nsIMsgFolder} folder - Folder in which to create the item.
 * @param {string} id - Unique item identifier.
 */
function writeFeedItem(folder, id) {
  const item = new FeedItem();
  item.feed = {
    folder,
    name: folder.name,
    options: {
      category: {
        enabled: true,
        prefixEnabled: false,
        prefix: "",
      },
    },
  };
  item.id = id;
  item.title = `Feed item ${id}`;
  item.author = ["author@example.invalid"];
  item.keywords = [TAG_NAME];
  item.content = "\n<p>Feed item content</p>";
  item.url = `https://example.invalid/${id}`;
  item.writeToFolder();
}

/**
 * Add an incoming move filter to an RSS account.
 *
 * @param {nsIMsgIncomingServer} server - RSS incoming server.
 * @param {nsIMsgFolder} destination - Move destination.
 * @param {boolean} matchTag - Whether to match TAG_KEY instead of all items.
 */
function addMoveFilter(server, destination, matchTag) {
  const filterList = server.getFilterList(null);
  const filter = filterList.createFilter(
    matchTag ? "Move tagged feed item" : "Move all feed items"
  );
  const term = filter.createTerm();
  if (matchTag) {
    term.attrib = Ci.nsMsgSearchAttrib.Keywords;
    term.op = Ci.nsMsgSearchOp.Contains;
    const value = term.value;
    value.attrib = Ci.nsMsgSearchAttrib.Keywords;
    value.str = TAG_KEY;
    term.value = value;
  } else {
    term.matchAll = true;
  }
  filter.appendTerm(term);

  const action = filter.createAction();
  action.type = Ci.nsMsgFilterAction.MoveToFolder;
  action.targetFolderUri = destination.URI;
  filter.appendAction(action);
  filter.enabled = true;
  filter.filterType = Ci.nsMsgFilterType.InboxRule;
  filterList.insertFilterAt(0, filter);
}

/**
 * Check that an item was moved with its RSS metadata intact.
 *
 * @param {nsIMsgFolder} source - Original feed folder.
 * @param {nsIMsgFolder} destination - Move destination.
 */
function assertMovedAndTagged(source, destination) {
  Assert.equal([...source.messages].length, 0, "source folder should be empty");
  const messages = [...destination.messages];
  Assert.equal(messages.length, 1, "destination should contain the feed item");
  Assert.equal(
    messages[0].getStringProperty("keywords"),
    TAG_KEY,
    "moved item should retain its feed category tag"
  );
  Assert.ok(
    messages[0].flags & Ci.nsMsgMessageFlags.FeedMsg,
    "moved item should retain its feed flag"
  );
  const storedMessage = mailTestUtils.loadMessageToString(
    destination,
    messages[0]
  );
  Assert.ok(
    storedMessage.includes("X-Mozilla-Status: 0040"),
    "feed flag should be persisted in the message"
  );
  Assert.ok(
    storedMessage.includes(`X-Mozilla-Keys: ${TAG_KEY}`),
    "feed category tag should be persisted in the message"
  );
}

/**
 * Check the active database service and the account's physical message store.
 *
 * @param {nsIMsgFolder} folder - A real folder created by the RSS account.
 */
function assertBackendAndStore(folder) {
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  const isPanorama =
    "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore;
  Assert.equal(
    isPanorama,
    Services.prefs.getBoolPref("mail.panorama.enabled", false),
    "The database service matches the configured backend after account setup"
  );
  const contract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  const expectedStore = {
    "@mozilla.org/msgstore/berkeleystore;1": "mbox",
    "@mozilla.org/msgstore/maildirstore;1": "maildir",
  }[contract];
  Assert.ok(expectedStore, "The account uses a supported physical store");
  Assert.equal(folder.server.getStringValue("storeContractID"), contract);
  Assert.equal(folder.msgStore.storeType, expectedStore);
}

add_task(async function test_storeFailureCompletesAndCanRetry() {
  const account = FeedUtils.createRssAccount("store failure account");
  const rootFolder = account.incomingServer.rootMsgFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const folder = rootFolder.createLocalSubfolder("store failure folder");
  assertBackendAndStore(folder);
  Assert.ok(
    folder.msgDatabase,
    "The folder database is available before locking"
  );
  const feed = new Feed("https://example.invalid/store-failure", folder);
  feed.parseItems = true;
  const results = [];
  const retryComplete = Promise.withResolvers();
  let progress = 0;
  feed.downloadCallback = {
    downloaded(completedFeed, code) {
      Assert.equal(completedFeed.url, feed.url);
      results.push(code);
      if (code == FeedUtils.kNewsBlogSuccess) {
        retryComplete.resolve();
      }
    },
    onFeedItemStored() {
      progress++;
    },
  };
  const makeItem = () => {
    const item = new FeedItem();
    item.feed = feed;
    item.id = "store-failure-item";
    item.title = "Store failure item";
    item.author = ["author@example.invalid"];
    item.content = "<p>The retried feed content.</p>";
    item.url = "https://example.invalid/store-failure-item";
    return item;
  };
  const storedItem = makeItem();
  storedItem.id = "stored-after-failure";
  storedItem.title = "Already stored item";
  storedItem.url = "https://example.invalid/stored-after-failure";
  storedItem.content = "<p>Existing physical feed message.</p>";
  Assert.ok(storedItem.store(), "The later item is already published");
  const storedHeader = [...folder.messages][0];
  const storedKey = storedHeader.messageKey;
  const storedMessageId = storedHeader.messageId;
  const storedToken = storedHeader.storeToken;
  const storedBody = mailTestUtils.loadMessageToString(folder, storedHeader);
  const ds = FeedUtils.getItemsDS(account.incomingServer);
  ds.data[storedItem.id].lastSeenTime =
    Date.now() - FeedUtils.INVALID_ITEM_PURGE_DELAY - 1;
  const storedResource = structuredClone(ds.data[storedItem.id]);
  feed.invalidateItems();
  storedResource.valid = false;
  const failedItem = makeItem();
  feed.itemsToStore = [failedItem, storedItem];
  feed.itemsToStoreIndex = 0;
  feed.itemsStored = 0;
  const holder = Cc["@mozilla.org/supports-cstring;1"].createInstance(
    Ci.nsISupportsCString
  );
  folder.acquireSemaphore(holder, "test feed storage failure");
  try {
    feed.storeNextItem();
    Assert.deepEqual(results, [FeedUtils.kNewsBlogFileError]);
    Assert.equal(progress, 0, "The failed item must not report progress");
    Assert.equal(feed.itemsStored, 0);
    Assert.deepEqual(feed.itemsToStore, [], "Failure clears the pending items");
    Assert.equal(feed.storeItemsTimer, null, "No further write is scheduled");
    Assert.equal(
      folder.getTotalMessages(false),
      1,
      "The failed item does not publish a message"
    );
    Assert.deepEqual(
      ds.data[storedItem.id],
      storedResource,
      "Failure retains the aged stored resource and its feed identity"
    );
    const retained = folder.GetMessageHeader(storedKey);
    Assert.equal(retained.messageId, storedMessageId);
    Assert.equal(retained.storeToken, storedToken);
    Assert.equal(
      mailTestUtils.loadMessageToString(folder, retained),
      storedBody
    );
    Assert.ok(
      !FeedUtils.getItemsDS(account.incomingServer).data[failedItem.id]?.stored,
      "The failed item must not be marked stored"
    );
    Assert.ok(folder.testSemaphore(holder), "The foreign lock remains owned");
    Assert.ok(
      !folder.gettingNewMessages,
      "The ingestion flag has been cleared"
    );
  } finally {
    folder.releaseSemaphore(holder, "test feed storage failure");
  }

  feed.itemsToStore = [makeItem(), storedItem];
  feed.storeNextItem();
  await retryComplete.promise;
  Assert.deepEqual(results, [
    FeedUtils.kNewsBlogFileError,
    FeedUtils.kNewsBlogSuccess,
  ]);
  Assert.equal(
    progress,
    2,
    "Only the two successful retry items report progress"
  );
  Assert.equal(feed.itemsStored, 1);
  const messages = [...folder.messages];
  Assert.equal(
    messages.length,
    2,
    "The retry publishes one additional message"
  );
  const retried = messages.find(header => header.messageKey != storedKey);
  Assert.ok(retried, "The failed item receives a new physical message");
  Assert.ok(
    FeedUtils.getItemsDS(account.incomingServer).data[failedItem.id].stored,
    "The successful retry records the stored item"
  );
  Assert.stringContains(
    mailTestUtils.loadMessageToString(folder, retried),
    "<p>The retried feed content.</p>"
  );
  Assert.ok(!storedItem.store(), "The remaining stored item is not duplicated");
  Assert.equal(folder.getTotalMessages(false), 2);
  Assert.equal(folder.GetMessageHeader(storedKey).storeToken, storedToken);
  Assert.equal(
    mailTestUtils.loadMessageToString(
      folder,
      folder.GetMessageHeader(storedKey)
    ),
    storedBody
  );
});

add_task(function test_folderCreationFailurePreservesExistingMessages() {
  const account = FeedUtils.createRssAccount("folder collision account");
  const rootFolder = account.incomingServer.rootMsgFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const feed = new Feed("https://example.invalid/folder-collision", rootFolder);
  feed.title = "Folder collision";
  // Another operation creates this name after the feed has chosen it.
  const name = feed.folderName;
  const existing = rootFolder.createLocalSubfolder(name);
  assertBackendAndStore(existing);
  const item = new FeedItem();
  item.feed = new Feed("https://example.invalid/existing", existing);
  item.id = "folder-collision-item";
  item.title = "Existing feed item";
  item.author = ["author@example.invalid"];
  item.content = "<p>Existing physical feed message.</p>";
  item.url = "https://example.invalid/folder-collision-item";
  Assert.ok(item.store(), "The existing item is published");
  const header = [...existing.messages][0];
  Assert.ok(header, "The existing folder contains a stored message");
  const uri = existing.URI;
  const parentURI = existing.parent.URI;
  const key = header.messageKey;
  const messageId = header.messageId;
  const storeToken = header.storeToken;
  const flags = existing.flags;
  const body = mailTestUtils.loadMessageToString(existing, header);

  feed.createFolder();
  Assert.equal(
    feed.folder,
    null,
    "The failed attempt does not adopt the folder"
  );
  const results = [];
  feed.itemsToStore = [];
  feed.downloadCallback = {
    downloaded(completedFeed, code) {
      results.push(code);
    },
  };
  feed.storeNextItem();
  Assert.deepEqual(results, [FeedUtils.kNewsBlogFileError]);

  const retained = rootFolder.getChildNamed(name);
  Assert.equal(retained.URI, uri, "The original logical folder remains");
  Assert.equal(retained.parent.URI, parentURI);
  Assert.equal(retained.name, name);
  Assert.equal(retained.flags, flags, "The folder metadata remains unchanged");
  const messages = [...retained.messages];
  Assert.equal(messages.length, 1, "The stored message remains");
  Assert.equal(messages[0].messageKey, key);
  Assert.equal(messages[0].messageId, messageId);
  Assert.equal(messages[0].storeToken, storeToken);
  Assert.equal(mailTestUtils.loadMessageToString(retained, messages[0]), body);
});

add_task(function test_feed_category_tag_available_to_incoming_filter() {
  const account = FeedUtils.createRssAccount("tag filter account");
  const rootFolder = account.incomingServer.rootMsgFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const source = rootFolder.createLocalSubfolder("tag filter source");
  const destination = rootFolder.createLocalSubfolder("tag filter destination");
  addMoveFilter(account.incomingServer, destination, true);

  writeFeedItem(source, "tag-filter");

  assertMovedAndTagged(source, destination);
});

add_task(function test_feed_category_tag_survives_incoming_filter_move() {
  const account = FeedUtils.createRssAccount("move filter account");
  const rootFolder = account.incomingServer.rootMsgFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const source = rootFolder.createLocalSubfolder("move filter source");
  const destination = rootFolder.createLocalSubfolder(
    "move filter destination"
  );
  addMoveFilter(account.incomingServer, destination, false);

  writeFeedItem(source, "move-filter");

  assertMovedAndTagged(source, destination);
});

add_task(function test_store_preserves_dollar_ampersand_in_content() {
  const account = FeedUtils.createRssAccount("replacement pattern account");
  const rootFolder = account.incomingServer.rootMsgFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const folder = rootFolder.createLocalSubfolder("replacement pattern folder");
  const item = new FeedItem();
  item.feed = {
    folder,
    server: account.incomingServer,
    url: "https://example.invalid/feed",
    name: folder.name,
    options: {
      category: {
        enabled: false,
        prefixEnabled: false,
        prefix: "",
      },
    },
  };
  item.id = "replacement-pattern";
  item.title = "Replacement pattern";
  item.author = ["author@example.invalid"];
  item.content = "<p>Expected literal token: $&.</p>";
  item.url = "https://example.invalid/replacement-pattern";

  Assert.ok(item.store(), "feed item should be stored");

  const messages = [...folder.messages];
  Assert.equal(messages.length, 1, "folder should contain the feed item");
  const storedMessage = mailTestUtils.loadMessageToString(folder, messages[0]);
  Assert.ok(
    storedMessage.includes("<p>Expected literal token: $&.</p>"),
    "feed content should preserve a literal $&"
  );
});

add_task(function test_normalizeMessageID_escapes_meta_characters() {
  const item = new FeedItem();
  Assert.equal(
    item.normalizeMessageID(" victim-real-id@example.com> "),
    "<victim-real-id%40example.com%3E@localhost.localdomain>",
    "message ID meta characters should be escaped"
  );
  Assert.equal(
    item.normalizeMessageID("<a@b><c@d>"),
    "<%3Ca%40b%3E%3Cc%40d%3E@localhost.localdomain>",
    "all occurrences of message ID meta characters should be escaped"
  );
  Assert.equal(
    item.normalizeMessageID("foo bar\u00A0baz"),
    "<foo%20bar%C2%A0baz@localhost.localdomain>",
    "inner whitespace should be escaped"
  );
  Assert.notEqual(
    item.normalizeMessageID("a%40b"),
    item.normalizeMessageID("a@b"),
    "an already escaped id should not collide with the unescaped one"
  );
});

add_task(function test_message_id_header_escapes_item_id() {
  const account = FeedUtils.createRssAccount("message id account");
  const rootFolder = account.incomingServer.rootMsgFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const folder = rootFolder.createLocalSubfolder("message id folder");

  writeFeedItem(folder, "victim-real-id@example.com>");

  const messages = [...folder.messages];
  Assert.equal(messages.length, 1, "folder should contain the feed item");
  Assert.equal(
    messages[0].messageId,
    "victim-real-id%40example.com%3E@localhost.localdomain",
    "stored message ID should be the escaped item id"
  );
  const storedMessage = mailTestUtils.loadMessageToString(folder, messages[0]);
  Assert.ok(
    storedMessage.includes(
      "Message-Id: <victim-real-id%40example.com%3E@localhost.localdomain>\n"
    ),
    "Message-Id header should contain the escaped item id"
  );
});

add_task(function test_content_cannot_inject_mime_parts() {
  const account = FeedUtils.createRssAccount("boundary account");
  const rootFolder = account.incomingServer.rootMsgFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const folder = rootFolder.createLocalSubfolder("boundary folder");

  let injected = "";
  for (let i = 0; i < 2000; i++) {
    injected +=
      `\n--------------${i}\n` +
      'Content-Type: text/plain; name="injected.txt"\n' +
      'Content-Disposition: attachment; filename="injected.txt"\n\n' +
      "INJECTED\n";
  }

  const item = new FeedItem();
  item.feed = {
    folder,
    name: folder.name,
    options: { category: { enabled: false } },
  };
  item.id = "boundary";
  item.title = "Boundary";
  item.content = `\n<p>Before</p>${injected}<p>After</p>`;
  item.url = "https://example.invalid/boundary";
  item.enclosures = [
    new FeedEnclosure(
      "https://example.invalid/real-attachment.txt",
      "text/plain",
      8
    ),
  ];
  item.writeToFolder();

  const messages = [...folder.messages];
  Assert.equal(messages.length, 1, "folder should contain the feed item");
  const storedMessage = mailTestUtils.loadMessageToString(folder, messages[0]);

  const parts = [];
  MimeParser.parseSync(
    storedMessage,
    {
      startPart(partNum, headers) {
        parts.push({ partNum, contentType: headers.contentType.type });
      },
    },
    { bodyformat: "none" }
  );
  Assert.deepEqual(
    parts,
    [
      { partNum: "", contentType: "multipart/mixed" },
      { partNum: "1", contentType: "text/html" },
      { partNum: "2", contentType: "text/plain" },
    ],
    "message should only contain the content and the declared enclosure"
  );
});

add_task(async function test_proto_item_id_is_stored_as_own_key() {
  const account = FeedUtils.createRssAccount("proto id account");
  const server = account.incomingServer;
  const rootFolder = server.rootMsgFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const folder = rootFolder.createLocalSubfolder("proto id folder");
  const feedURL = "https://example.invalid/proto.xml";

  const item = new FeedItem();
  item.feed = {
    folder,
    server,
    url: feedURL,
    name: folder.name,
    options: { category: { enabled: false } },
  };
  item.id = "__proto__";
  item.title = "Proto";
  item.content = "\n<p>Proto</p>";
  item.url = "https://example.invalid/proto";
  Assert.ok(item.store(), "item should be stored");

  let ds = FeedUtils.getItemsDS(server);
  Assert.ok(
    Object.hasOwn(ds.data, "__proto__"),
    "__proto__ item id should be an own key of the item cache"
  );
  Assert.deepEqual(
    Object.keys(ds.data),
    ["__proto__"],
    "item cache should only contain the stored item"
  );

  const feed = new Feed(feedURL, folder);
  feed.invalidateItems();
  feed.removeInvalidItems(false);
  Assert.equal(
    ds.data.__proto__.valid,
    false,
    "__proto__ item should have been invalidated"
  );

  await ds._save();
  delete FeedUtils[server.serverURI].FeedItemsDS;
  ds = FeedUtils.getItemsDS(server);
  Assert.ok(
    Object.hasOwn(ds.data, "__proto__"),
    "__proto__ item id should be an own key after reloading the item cache"
  );
  Assert.deepEqual(
    ds.data.__proto__.feedURLs,
    [feedURL],
    "reloaded __proto__ item should keep its feed URL"
  );
});
