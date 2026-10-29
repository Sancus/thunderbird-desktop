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
const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  GlodaMsgSearcher: "resource:///modules/gloda/GlodaMsgSearcher.sys.mjs",
});

const messages = {};

add_setup(async function () {
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

  const { Gloda, GlodaIndexer, GlodaMsgIndexer } = lazy;
  const generator = new MessageGenerator();
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
  folder.addMessageBatch(
    synthetic.map(([, message]) => message.toMessageString())
  );
  // Each Message-ID occurs once per folder; result identities include the folder.
  for (const [name, message] of synthetic) {
    messages[name] = folder.msgDatabase.getMsgHdrForMessageID(
      message.messageId
    );
    Assert.ok(messages[name], "Created fixture " + name);
  }
  const duplicate = synthetic.find(([name]) => name == "duplicate")[1];
  copyFolder.addMessage(duplicate.toMessageString());
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
