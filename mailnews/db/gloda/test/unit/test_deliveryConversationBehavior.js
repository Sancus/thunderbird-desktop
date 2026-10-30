/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const {
  glodaTestHelperInitialize,
  assertExpectedMessagesIndexed,
  waitForGlodaIndexer,
} = ChromeUtils.importESModule(
  "resource://testing-common/gloda/GlodaTestHelper.sys.mjs"
);
const { waitForGlodaDBFlush } = ChromeUtils.importESModule(
  "resource://testing-common/gloda/GlodaTestHelperFunctions.sys.mjs"
);
const { Gloda } = ChromeUtils.importESModule(
  "resource:///modules/gloda/GlodaPublic.sys.mjs"
);
const { GlodaSyntheticView } = ChromeUtils.importESModule(
  "resource:///modules/gloda/GlodaSyntheticView.sys.mjs"
);
const { MessageGenerator, SyntheticMessageSet } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { MessageInjection } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageInjection.sys.mjs"
);

/**
 * @typedef {object} MessageState
 * @property {string} location - The serialized folder/key pair.
 * @property {boolean} read - The read state at notification time.
 * @property {boolean} starred - The star state at notification time.
 * @property {string[]} tags - The tag keys at notification time.
 */

/**
 * @typedef {object} CollectionEvent
 * @property {string} kind - The added, modified or removed callback kind.
 * @property {MessageState[]} changed - Copies of the changed message states.
 * @property {string[]} members - Physical members at notification time.
 */

/**
 * @typedef {object} Observation
 * @property {GlodaCollection} collection - The live query collection.
 * @property {CollectionEvent[]} events - Callbacks after the initial query.
 */

const generator = new MessageGenerator();
/** @type {MessageInjection} */
let injection;

add_setup(function () {
  injection = new MessageInjection({ mode: "local" }, generator);
  const account = MailServices.accounts.findAccountForServer(
    MailServices.accounts.localFoldersServer
  );
  registerCleanupFunction(() => MailServices.accounts.removeAccount(account));
  glodaTestHelperInitialize(injection);
});

/**
 * Returns a header's physical location without assuming key allocation order.
 *
 * @param {nsIMsgDBHdr} header - The message header.
 * @returns {string} The serialized folder/key pair.
 */
function location(header) {
  return JSON.stringify([header.folder.URI, header.messageKey]);
}

/**
 * Creates a three-message reply chain across two folders and an unrelated root.
 * The unrelated message has the same subject and no References header.
 *
 * @returns {Promise<{thread: SyntheticMessageSet, folders: nsIMsgFolder[]}>}
 *   The injected chain and its two folders.
 */
async function createConversation() {
  const folders = [
    await injection.makeEmptyFolder(),
    await injection.makeEmptyFolder(),
  ];
  const rootMessage = generator.makeMessage();
  const reply = generator.makeMessage({ inReplyTo: rootMessage });
  const tail = generator.makeMessage({ inReplyTo: reply });
  const thread = new SyntheticMessageSet([rootMessage, reply, tail]);
  const unrelated = new SyntheticMessageSet([
    generator.makeMessage({ subject: rootMessage.subject }),
  ]);
  await injection.addSetsToFolders(folders, [thread, unrelated]);
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([thread, unrelated]));
  await waitForGlodaDBFlush();
  Assert.equal(thread.getMsgHdr(0).folder.URI, folders[0].URI);
  Assert.equal(thread.getMsgHdr(1).folder.URI, folders[1].URI);
  Assert.equal(thread.getMsgHdr(2).folder.URI, folders[0].URI);
  return { thread, folders };
}

/**
 * Creates a singleton bound to its actual folder. slice retains empty source
 * folders, but the per-folder tag/move/delete helpers pass every folder to native.
 *
 * @param {SyntheticMessageSet} thread - Existing injected fixture.
 * @param {number} index - Message to select.
 * @returns {SyntheticMessageSet} One message without empty folder groups.
 */
function singleMessage(thread, index) {
  return new SyntheticMessageSet(
    [thread.synMessages[index]],
    thread.getMsgHdr(index).folder,
    [0]
  );
}

/**
 * Records collection callbacks and resolves when the initial query completes.
 * Callback records copy locations and metadata before later mutations.
 *
 * @param {function({
 *   onItemsAdded: function(GlodaMessage[], GlodaCollection): void,
 *   onItemsModified: function(GlodaMessage[], GlodaCollection): void,
 *   onItemsRemoved: function(GlodaMessage[], GlodaCollection): void,
 *   onQueryCompleted: function(GlodaCollection): void
 * }): GlodaCollection} start - Starts a public collection query.
 * @returns {Promise<Observation>}
 *   The live collection and callbacks after the initial query.
 */
async function observe(start) {
  const events = [];
  const record = (kind, items, collection) => {
    events.push({
      kind,
      changed: items.map(item => ({
        location: JSON.stringify([item.folderURI, item.messageKey]),
        read: item.read,
        starred: item.starred,
        tags: item.tags.map(tag => tag.key).toSorted(),
      })),
      members: collection.items
        .map(item => JSON.stringify([item.folderURI, item.messageKey]))
        .toSorted(),
    });
  };
  const collection = await new Promise(resolve => {
    start({
      onItemsAdded: (items, current) => record("added", items, current),
      onItemsModified: (items, current) => record("modified", items, current),
      onItemsRemoved: (items, current) => record("removed", items, current),
      onQueryCompleted: resolve,
    });
  });
  registerCleanupFunction(() => {
    collection.becomeExplicit();
    collection.listener = null;
  });
  events.length = 0;
  return { collection, events };
}

/**
 * Checks exact membership and resolves every result to its current header.
 *
 * @param {GlodaCollection} collection - The public query collection.
 * @param {nsIMsgDBHdr[]} expected - Independently selected fixture headers.
 */
function assertMembers(collection, expected) {
  const headers = collection.items.map(item => item.folderMessage);
  Assert.ok(
    headers.every(Boolean),
    "Every member resolves to a current header"
  );
  Assert.deepEqual(
    headers.map(location).toSorted(),
    expected.map(location).toSorted(),
    "Exact physical conversation members"
  );
}

/**
 * Checks callback kind, changed locations and membership visible in callbacks.
 * Callback batch sizes and repeated notifications are not prescribed.
 *
 * @param {Observation} observed - The recorded collection callbacks.
 * @param {string} kind - Expected callback kind.
 * @param {string[]} changed - Expected serialized changed locations.
 * @param {nsIMsgDBHdr[]} members - Expected remaining fixture headers.
 * @returns {MessageState[]} Copied metadata for the changed items.
 */
function assertChanges(observed, kind, changed, members) {
  Assert.ok(observed.events.length, "Received a live collection callback");
  Assert.deepEqual(
    [...new Set(observed.events.map(event => event.kind))],
    [kind],
    "Only the expected callback kind was received"
  );
  const items = observed.events.flatMap(event => event.changed);
  Assert.deepEqual(
    [...new Set(items.map(item => item.location))].toSorted(),
    changed.toSorted(),
    "Only the changed physical messages were reported"
  );
  for (const event of observed.events) {
    Assert.deepEqual(
      event.members,
      members.map(location).toSorted(),
      "Callback observes the complete current membership"
    );
  }
  return items;
}

/**
 * Follows the header lookup and conversation query used by ConversationOpener.
 *
 * @param {nsIMsgDBHdr} header - A fixture member to look up.
 * @returns {Promise<Observation>} The live conversation and its callbacks.
 */
async function observeConversation(header) {
  const selected = await observe(listener =>
    Gloda.getMessageCollectionForHeaders([header], listener)
  );
  assertMembers(selected.collection, [header]);
  return observe(listener =>
    selected.collection.items[0].conversation.getMessagesCollection(listener)
  );
}

add_task(async function test_lookupAcrossFolders() {
  const { thread } = await createConversation();
  const rootHeader = thread.getMsgHdr(0);
  const replyHeader = thread.getMsgHdr(1);
  const tailHeader = thread.getMsgHdr(2);
  const selected = await observe(listener =>
    Gloda.getMessageCollectionForHeaders([replyHeader, tailHeader], listener)
  );
  assertMembers(selected.collection, [replyHeader, tailHeader]);
  // ConversationOpener passes the selected message and conversation to this view.
  const message = selected.collection.items.find(
    item => location(item.folderMessage) == location(replyHeader)
  );
  Assert.ok(message, "Lookup returned the selected reply");
  const view = new GlodaSyntheticView({
    conversation: message.conversation,
    message,
  });
  registerCleanupFunction(() => {
    view.abortSearch();
    view.collection.listener = null;
  });
  const hits = [];
  const status = await new Promise(resolve => {
    view.search({
      onNewSearch() {},
      onSearchHit(header, folder) {
        hits.push({ header, folder });
      },
      onSearchDone: resolve,
    });
  });
  Assert.equal(status, Cr.NS_OK, "Synthetic conversation search completes");
  Assert.ok(view.completed, "Conversation query completed");
  Assert.equal(view.viewType, "conversation");
  Assert.equal(location(view.selectedMessage), location(replyHeader));
  for (const hit of hits) {
    Assert.equal(hit.header.folder.URI, hit.folder.URI);
  }
  Assert.deepEqual(
    hits.map(hit => location(hit.header)).toSorted(),
    [rootHeader, replyHeader, tailHeader].map(location).toSorted(),
    "Open in Conversation search includes both folders and excludes same-subject root"
  );
});

add_task(async function test_liveReplyAdded() {
  const { thread, folders } = await createConversation();
  const before = [
    thread.getMsgHdr(0),
    thread.getMsgHdr(1),
    thread.getMsgHdr(2),
  ];
  const observed = await observeConversation(before[1]);
  assertMembers(observed.collection, before);
  const reply = new SyntheticMessageSet([
    generator.makeMessage({ inReplyTo: thread.synMessages[2] }),
  ]);
  const unrelated = new SyntheticMessageSet([
    generator.makeMessage({ subject: thread.synMessages[0].subject }),
  ]);
  await injection.addSetsToFolders([folders[1]], [reply, unrelated]);
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([reply, unrelated]));
  await waitForGlodaDBFlush();
  const added = reply.getMsgHdr(0);
  const after = [...before, added];
  assertMembers(observed.collection, after);
  assertChanges(observed, "added", [location(added)], after);
});

add_task(async function test_liveReadUpdate() {
  const { thread } = await createConversation();
  const headers = [
    thread.getMsgHdr(0),
    thread.getMsgHdr(1),
    thread.getMsgHdr(2),
  ];
  const observed = await observeConversation(headers[0]);
  assertMembers(observed.collection, headers);
  const reply = thread.slice(1, 2);
  reply.setRead(true);
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([reply]));
  await waitForGlodaDBFlush();
  assertMembers(observed.collection, headers);
  const changed = assertChanges(
    observed,
    "modified",
    [location(headers[1])],
    headers
  );
  Assert.ok(
    changed.every(item => item.read),
    "Callback carries the new read state"
  );
});

add_task(async function test_liveStarUpdate() {
  const { thread } = await createConversation();
  const headers = [
    thread.getMsgHdr(0),
    thread.getMsgHdr(1),
    thread.getMsgHdr(2),
  ];
  const observed = await observeConversation(headers[0]);
  assertMembers(observed.collection, headers);
  const reply = thread.slice(1, 2);
  reply.setStarred(true);
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([reply]));
  await waitForGlodaDBFlush();
  assertMembers(observed.collection, headers);
  const changed = assertChanges(
    observed,
    "modified",
    [location(headers[1])],
    headers
  );
  Assert.ok(
    changed.every(item => item.starred),
    "Callback carries the new star state"
  );
});

add_task(async function test_liveTagUpdate() {
  const { thread } = await createConversation();
  const headers = [
    thread.getMsgHdr(0),
    thread.getMsgHdr(1),
    thread.getMsgHdr(2),
  ];
  const observed = await observeConversation(headers[0]);
  assertMembers(observed.collection, headers);
  const reply = singleMessage(thread, 1);
  reply.addTag("$label1");
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([reply]));
  await waitForGlodaDBFlush();
  assertMembers(observed.collection, headers);
  const changed = assertChanges(
    observed,
    "modified",
    [location(headers[1])],
    headers
  );
  for (const item of changed) {
    Assert.deepEqual(item.tags, ["$label1"], "Callback carries the new tag");
  }
});

add_task(async function test_liveMoveResolvesCurrentHeader() {
  const { thread } = await createConversation();
  const rootHeader = thread.getMsgHdr(0);
  const oldReply = thread.getMsgHdr(1);
  const tailHeader = thread.getMsgHdr(2);
  const oldLocation = location(oldReply);
  const observed = await observeConversation(rootHeader);
  assertMembers(observed.collection, [rootHeader, oldReply, tailHeader]);
  const destination = await injection.makeEmptyFolder();
  const reply = singleMessage(thread, 1);
  await injection.moveMessages(reply, destination, true);
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([reply], { fullyIndexed: 0 }));
  await waitForGlodaDBFlush();
  const moved = reply.getMsgHdr(0);
  Assert.equal(moved.folder.URI, destination.URI);
  Assert.notEqual(
    location(moved),
    oldLocation,
    "Move changes physical location"
  );
  const after = [rootHeader, moved, tailHeader];
  assertMembers(observed.collection, after);
  assertChanges(observed, "modified", [location(moved)], after);
  const reopened = await observeConversation(moved);
  assertMembers(reopened.collection, after);
});

add_task(async function test_liveAncestorDeletion() {
  const { thread } = await createConversation();
  const rootHeader = thread.getMsgHdr(0);
  const replyHeader = thread.getMsgHdr(1);
  const tailHeader = thread.getMsgHdr(2);
  const removedLocation = location(rootHeader);
  const observed = await observeConversation(tailHeader);
  assertMembers(observed.collection, [rootHeader, replyHeader, tailHeader]);
  const rootSet = singleMessage(thread, 0);
  await MessageInjection.deleteMessages(rootSet);
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([], { deleted: [rootSet] }));
  await waitForGlodaDBFlush();
  const after = [replyHeader, tailHeader];
  assertMembers(observed.collection, after);
  assertChanges(observed, "removed", [removedLocation], after);
  const reopened = await observeConversation(replyHeader);
  assertMembers(reopened.collection, after);
});
