/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
const { MessageGenerator, SyntheticMessageSet } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);

const { MessageInjection } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageInjection.sys.mjs"
);
const { waitForGlodaIndexer } = ChromeUtils.importESModule(
  "resource://testing-common/gloda/GlodaTestHelper.sys.mjs"
);
const { waitForGlodaDBFlush } = ChromeUtils.importESModule(
  "resource://testing-common/gloda/GlodaTestHelperFunctions.sys.mjs"
);

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Gloda: "resource:///modules/gloda/GlodaPublic.sys.mjs",
  GlodaIndexer: "resource:///modules/gloda/GlodaIndexer.sys.mjs",
  GlodaMsgIndexer: "resource:///modules/gloda/IndexMsg.sys.mjs",
  GlodaMsgSearcher: "resource:///modules/gloda/GlodaMsgSearcher.sys.mjs",
});

const messages = {};
const syntheticMessages = {};
/** @type {MessageInjection} */
let searchInjection;

add_setup(async function () {
  Assert.equal(Services.prefs.getBoolPref("mail.panorama.enabled"), false);
  Assert.equal(
    Components.manager
      .QueryInterface(Ci.nsIComponentRegistrar)
      .contractIDToCID("@mozilla.org/msgDatabase/msgDBService;1")
      .toString(),
    "{03223c50-1e88-45e8-ba1a-7ce792dc3fc3}",
    "The behavior reference uses the legacy backend"
  );
  const prefs = [
    "mailnews.database.global.indexer.enabled",
    "mailnews.database.global.indexer.perform_initial_sweep",
    "mailnews.database.global.search.msg.limit",
  ];
  const previous = prefs.map(name => {
    let value;
    if (Services.prefs.prefHasUserValue(name)) {
      value =
        Services.prefs.getPrefType(name) == Services.prefs.PREF_BOOL
          ? Services.prefs.getBoolPref(name)
          : Services.prefs.getIntPref(name);
    }
    return { name, value };
  });
  registerCleanupFunction(() => {
    for (const { name, value } of previous) {
      if (value === undefined) {
        Services.prefs.clearUserPref(name);
      } else if (typeof value == "boolean") {
        Services.prefs.setBoolPref(name, value);
      } else {
        Services.prefs.setIntPref(name, value);
      }
    }
  });
  Services.prefs.setBoolPref(prefs[0], true);
  Services.prefs.setBoolPref(prefs[1], false);
  Services.prefs.setIntPref(prefs[2], 100);

  const account = MailServices.accounts.createLocalMailAccount();
  registerCleanupFunction(() => MailServices.accounts.removeAccount(account));
  const rootFolder = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const folder = rootFolder
    .createLocalSubfolder("search-behavior")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const copyFolder = rootFolder
    .createLocalSubfolder("search-behavior-copy")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  // With To present, Cc/Bcc names enter full-text search through cards.
  const addressBook = MailServices.ab.getDirectory("jsaddrbook://abook.sqlite");
  const cards = [];
  registerCleanupFunction(() => addressBook.deleteCards(cards));
  for (const [email, displayName] of [
    ["cc@example.invalid", "Répertoirecc"],
    ["bcc@example.invalid", "Répertoirebcc"],
  ]) {
    const card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
      Ci.nsIAbCard
    );
    card.primaryEmail = email;
    card.displayName = displayName;
    cards.push(addressBook.addCard(card));
    const found = MailServices.ab.cardForEmailAddress(email);
    Assert.ok(found, "Fixture card is available for " + email);
    Assert.equal(found.displayName, displayName);
  }

  const Gloda = lazy.Gloda;
  const GlodaIndexer = lazy.GlodaIndexer;
  const GlodaMsgIndexer = lazy.GlodaMsgIndexer;
  const generator = new MessageGenerator();
  searchInjection = new MessageInjection({ mode: "local" }, generator);
  const { glodaTestHelperInitialize } = ChromeUtils.importESModule(
    "resource://testing-common/gloda/GlodaTestHelper.sys.mjs"
  );
  glodaTestHelperInitialize(searchInjection);
  const definitions = {
    subject: { subject: "subjectneedle" },
    body: { body: { body: "bodyneedle" } },
    attachment: {
      attachments: [{ filename: "attachmentneedle.txt", body: "payload" }],
    },
    author: { from: ["Authorneedle", "author@example.invalid"] },
    to: {
      to: [["=?UTF-8?Q?R=C3=A9cepteurto?=", "to@example.invalid"]],
    },
    cc: {
      cc: [["=?UTF-8?Q?R=C3=A9cepteurcc?=", "cc@example.invalid"]],
    },
    bcc: {
      clobberHeaders: {
        Bcc: "=?UTF-8?Q?R=C3=A9cepteurbcc?= <bcc@example.invalid>",
      },
    },
    adjacent: { body: { body: "cobalt meadow" } },
    reversed: { body: { body: "meadow cobalt" } },
    separated: { body: { body: "cobalt valley meadow" } },
    crossField: { subject: "cobalt", body: { body: "meadow" } },
    cobalt: { body: { body: "cobalt" } },
    meadow: { body: { body: "meadow" } },
    unicode: {
      body: {
        charset: "UTF-8",
        encoding: "8bit",
        body:
          "Par\xc3\xads " +
          "\xe8\x87\xaa\xe5\x8b\x95\xe5\x94\xae\xe8\xb2\xa8\xe6\xa9\x9f",
      },
    },
    duplicate: { body: { body: "duplicateneedle" } },
    unrelated: { body: { body: "unrelated content" } },
  };
  const synthetic = Object.entries(definitions).map(([name, options]) => [
    name,
    generator.makeMessage({
      subject: "Fixture " + name,
      from: ["Sender", "sender@example.invalid"],
      to: [["Recipient", "recipient@example.invalid"]],
      body: { body: "ordinary content" },
      ...options,
    }),
  ]);
  await searchInjection.addSetsToFolders(
    [folder],
    [new SyntheticMessageSet(synthetic.map(([, message]) => message))]
  );
  // Each Message-ID occurs once per folder; result identities include the folder.
  for (const [name, message] of synthetic) {
    syntheticMessages[name] = message;
    messages[name] = folder.msgDatabase.getMsgHdrForMessageID(
      message.messageId
    );
    Assert.ok(messages[name], "Created fixture " + name);
  }
  const duplicate = synthetic.find(([name]) => name == "duplicate")[1];
  await searchInjection.addSetsToFolders(
    [copyFolder],
    [new SyntheticMessageSet([duplicate])]
  );
  messages.duplicateCopy = [...copyFolder.messages][0];
  Assert.ok(messages.duplicateCopy, "Created the second physical copy");
  Assert.equal(messages.duplicate.messageId, messages.duplicateCopy.messageId);
  Assert.notEqual(
    location(messages.duplicate),
    location(messages.duplicateCopy),
    "Copies have distinct physical locations"
  );

  for (const target of [folder, copyFolder]) {
    const indexed = await new Promise(resolve => {
      Assert.ok(
        GlodaMsgIndexer.indexFolder(target, { force: true, callback: resolve }),
        "Queued fixture folder for indexing"
      );
    });
    Assert.ok(indexed, "Completed fixture folder indexing");
  }
  await TestUtils.waitForCondition(() => !GlodaIndexer.indexing);
  for (const header of Object.values(messages)) {
    Assert.ok(Gloda.isMessageIndexed(header), "Fixture header is indexed");
  }
});

/**
 * Returns a header's physical location without assuming a key allocation order.
 *
 * @param {nsIMsgDBHdr} header - The message header.
 * @returns {string} The serialized folder/key pair.
 */
function location(header) {
  return JSON.stringify([header.folder.URI, header.messageKey]);
}

/**
 * Compares public search results with the specified physical fixture messages.
 *
 * @param {string} text - The search text.
 * @param {string[]} expected - Names in the messages fixture.
 * @param {boolean} [andTerms=true] - Whether all terms must match.
 * @returns {Promise<void>} Resolves after checking the completed result set.
 */
async function assertSearch(text, expected, andTerms = true) {
  const searcher = new lazy.GlodaMsgSearcher(null, text, andTerms);
  const collection = await new Promise(resolve => {
    searcher.getCollection({
      onItemsAdded() {},
      onItemsModified() {},
      onItemsRemoved() {},
      onQueryCompleted: resolve,
    });
  });
  collection.becomeExplicit();
  collection.listener = null;
  searcher.listener = null;
  const actual = collection.items.map(item => {
    const header = item.folderMessage;
    Assert.ok(header, "Search result resolves to a current header");
    return location(header);
  });
  Assert.deepEqual(
    actual.toSorted(),
    expected.map(name => location(messages[name])).toSorted(),
    "Exact physical results for " + JSON.stringify({ text, andTerms })
  );
}

add_task(async function test_searchSubject() {
  await assertSearch("subjectneedle", ["subject"]);
});

add_task(async function test_searchBody() {
  await assertSearch("bodyneedle", ["body"]);
});

add_task(async function test_searchAttachmentName() {
  await assertSearch("attachmentneedle", ["attachment"]);
});

add_task(async function test_searchAuthor() {
  await assertSearch("authorneedle", ["author"]);
});

add_task(async function test_searchDecodedTo() {
  await assertSearch("récepteurto", ["to"]);
});

add_task(async function test_searchCcCardName() {
  await assertSearch("répertoirecc", ["cc"]);
});

add_task(async function test_searchBccCardName() {
  await assertSearch("répertoirebcc", ["bcc"]);
});

add_task(async function test_searchPhraseOrder() {
  await assertSearch('"cobalt meadow"', ["adjacent"]);
  await assertSearch('"meadow cobalt"', ["reversed"]);
});

add_task(async function test_searchAllTermsAcrossFields() {
  await assertSearch("cobalt meadow", [
    "adjacent",
    "reversed",
    "separated",
    "crossField",
  ]);
});

add_task(async function test_searchAnyTerm() {
  await assertSearch(
    "cobalt meadow",
    ["adjacent", "reversed", "separated", "crossField", "cobalt", "meadow"],
    false
  );
});

add_task(async function test_searchProximity() {
  await assertSearch("cobalt NEAR/1 meadow", [
    "adjacent",
    "reversed",
    "separated",
  ]);
});

add_task(async function test_searchUnicodeAccent() {
  await assertSearch("paris", ["unicode"]);
});

add_task(async function test_searchUnicodeSingleCharacter() {
  await assertSearch("自", ["unicode"]);
});

add_task(async function test_searchUnicodeCjk() {
  await assertSearch("自動", ["unicode"]);
  await assertSearch("自動售貨機機", []);
});

add_task(async function test_searchDuplicatePhysicalMessages() {
  await assertSearch("duplicateneedle", ["duplicate", "duplicateCopy"]);
});

add_task(async function test_searchNoMatches() {
  await assertSearch("absentneedle", []);
});

/**
 * Starts a real public search and retains its live collection through mutation.
 *
 * @param {string} text - The indexed fixture term.
 * @returns {{searcher: GlodaMsgSearcher, collection: GlodaCollection,
 *   completion: Promise<GlodaCollection>}} The outstanding query and completion.
 */
function startLiveSearch(text) {
  const searcher = new lazy.GlodaMsgSearcher(null, text);
  let collection;
  const completion = new Promise(resolve => {
    collection = searcher.getCollection({
      onItemsAdded() {},
      onItemsModified() {},
      onItemsRemoved() {},
      onQueryCompleted: resolve,
    });
  });
  const observed = { searcher, collection, completion };
  registerCleanupFunction(() => stopLiveSearch(observed));
  Assert.equal(searcher.completed, false, "The real initial query is pending");
  return observed;
}

/**
 * Detaches a completed observation without changing its returned members.
 *
 * @param {{searcher: GlodaMsgSearcher, collection: GlodaCollection}} observed -
 *   The public search observation.
 */
function stopLiveSearch(observed) {
  observed.collection.becomeExplicit();
  observed.collection.listener = null;
  observed.searcher.listener = null;
}

/**
 * Checks every live member against independently selected current headers.
 *
 * @param {GlodaCollection} collection - The original public query collection.
 * @param {nsIMsgDBHdr[]} expected - The physical messages after mutation.
 */
function assertLiveSearchMembers(collection, expected) {
  const actual = collection.items.map(item => {
    const header = item.folderMessage;
    Assert.ok(header, "A live result resolves to a current physical header");
    return location(header);
  });
  Assert.deepEqual(
    actual.toSorted(),
    expected.map(location).toSorted(),
    "The outstanding search retains exactly the current physical messages"
  );
}

add_task(async function test_searchReadUpdateDuringInitialQuery() {
  const header = messages.subject;
  const observed = startLiveSearch("subjectneedle");
  try {
    header.folder.markMessagesRead([header], true);
    Assert.ok(
      header.isRead,
      "The real header read state changed synchronously"
    );
    Assert.equal(
      observed.searcher.completed,
      false,
      "The read mutation precedes initial query completion"
    );
    await observed.completion;
    await waitForGlodaIndexer();
    await waitForGlodaDBFlush();
    assertLiveSearchMembers(observed.collection, [header]);
    Assert.equal(observed.collection.items[0].read, true);
    await assertSearch("subjectneedle", ["subject"]);
  } finally {
    await observed.completion;
    stopLiveSearch(observed);
  }
});

add_task(async function test_searchDeletionDuringInitialQuery() {
  const header = messages.body;
  const removedLocation = location(header);
  const deleting = new SyntheticMessageSet(
    [syntheticMessages.body],
    header.folder,
    [0]
  );
  const observed = startLiveSearch("bodyneedle");
  let deletedWhilePending;
  let listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgFolderListener"]),
    msgsDeleted(headers) {
      if (headers.some(item => location(item) == removedLocation)) {
        deletedWhilePending = !observed.searcher.completed;
      }
    },
  };
  MailServices.mfn.addListener(
    listener,
    Ci.nsIMsgFolderNotificationService.msgsDeleted
  );
  registerCleanupFunction(() => {
    if (listener) {
      MailServices.mfn.removeListener(listener);
    }
  });
  try {
    Assert.equal(observed.searcher.completed, false);
    await MessageInjection.deleteMessages(deleting);
    Assert.equal(
      deletedWhilePending,
      true,
      "The actual deletion notification arrived while the initial query was pending"
    );
    await observed.completion;
    await waitForGlodaIndexer();
    await waitForGlodaDBFlush();
    assertLiveSearchMembers(observed.collection, []);
    await assertSearch("bodyneedle", []);
  } finally {
    MailServices.mfn.removeListener(listener);
    listener = null;
    await observed.completion;
    stopLiveSearch(observed);
  }
});

add_task(async function test_searchMoveDuringInitialQuery() {
  const original = messages.duplicate;
  const oldLocation = location(original);
  const messageID = original.messageId;
  const destination = original.folder.parent
    .createLocalSubfolder("search-behavior-moved")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const moving = new SyntheticMessageSet(
    [syntheticMessages.duplicate],
    original.folder,
    [0]
  );
  let observed;
  let destinationHeader;
  let movedWhilePending;
  let listener = {
    QueryInterface: ChromeUtils.generateQI([
      "nsIFolderListener",
      "nsIMsgFolderListener",
    ]),
    onFolderAdded() {},
    onMessageAdded(folder, header) {
      if (folder.URI == destination.URI && header.messageId == messageID) {
        destinationHeader = header;
        observed ??= startLiveSearch("duplicateneedle");
      }
    },
    msgsMoveCopyCompleted(isMove, sourceHeaders) {
      if (
        isMove &&
        sourceHeaders.some(header => location(header) == oldLocation)
      ) {
        movedWhilePending = observed && !observed.searcher.completed;
      }
    },
  };
  // The real destination header is attached before the move notification.
  // Start the query from that folder event while the native copy is active.
  MailServices.mailSession.AddFolderListener(
    listener,
    Ci.nsIFolderListener.added
  );
  MailServices.mfn.addListener(
    listener,
    Ci.nsIMsgFolderNotificationService.msgsMoveCopyCompleted
  );
  registerCleanupFunction(() => {
    if (listener) {
      MailServices.mailSession.RemoveFolderListener(listener);
      MailServices.mfn.removeListener(listener);
    }
  });
  try {
    await searchInjection.moveMessages(moving, destination, true);
    Assert.ok(observed, "The real destination-header event started the query");
    Assert.equal(
      movedWhilePending,
      true,
      "The actual move notification arrived while the initial query was pending"
    );
    await observed.completion;
    await waitForGlodaIndexer();
    await waitForGlodaDBFlush();
    const moved = moving.getMsgHdr(0);
    Assert.equal(location(moved), location(destinationHeader));
    Assert.equal(moved.folder.URI, destination.URI);
    Assert.notEqual(location(moved), oldLocation);
    assertLiveSearchMembers(observed.collection, [
      moved,
      messages.duplicateCopy,
    ]);
    Assert.equal(
      new Set(observed.collection.items.map(item => item.id)).size,
      2
    );
    Assert.ok(
      observed.collection.items.every(
        item => JSON.stringify([item.folderURI, item.messageKey]) != oldLocation
      ),
      "The old physical location cannot return from the outstanding query"
    );
    messages.duplicate = moved;
    await assertSearch("duplicateneedle", ["duplicate", "duplicateCopy"]);
  } finally {
    MailServices.mailSession.RemoveFolderListener(listener);
    MailServices.mfn.removeListener(listener);
    listener = null;
    if (observed) {
      await observed.completion;
      stopLiveSearch(observed);
    }
  }
});

add_task(async function test_searchFolderDeletionDuringInitialQuery() {
  const folder = messages.author.folder;
  const folderURI = folder.URI;
  const observed = startLiveSearch("authorneedle");
  let deletedWhilePending;
  let listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgFolderListener"]),
    folderDeleted(deletedFolder) {
      if (deletedFolder.URI == folderURI) {
        deletedWhilePending = !observed.searcher.completed;
      }
    },
  };
  MailServices.mfn.addListener(
    listener,
    Ci.nsIMsgFolderNotificationService.folderDeleted
  );
  registerCleanupFunction(() => {
    if (listener) {
      MailServices.mfn.removeListener(listener);
    }
  });
  try {
    Assert.equal(observed.searcher.completed, false);
    searchInjection.deleteFolder(folder);
    Assert.equal(
      deletedWhilePending,
      true,
      "The actual folder deletion arrived while the initial query was pending"
    );
    await observed.completion;
    await waitForGlodaIndexer();
    await waitForGlodaDBFlush();
    assertLiveSearchMembers(observed.collection, []);
    await assertSearch("authorneedle", []);
    await assertSearch("duplicateneedle", ["duplicate", "duplicateCopy"]);
  } finally {
    MailServices.mfn.removeListener(listener);
    listener = null;
    await observed.completion;
    stopLiveSearch(observed);
  }
});
