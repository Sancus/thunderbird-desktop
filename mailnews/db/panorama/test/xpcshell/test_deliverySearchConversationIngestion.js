/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */

const ConversationLiveView = Components.Constructor(
  "@mozilla.org/mailnews/live-view;1",
  "nsILiveView"
);

add_setup(function () {
  const dbFile = do_get_profile().clone();
  dbFile.append("panorama.sqlite");
  Assert.ok(!dbFile.exists(), "DatabaseCore must create the schema");
  Assert.ok(Services.prefs.getBoolPref("mail.panorama.enabled"));
  loadExistingDB();
  Assert.equal(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    ),
    database,
    "The account manager selected the Panorama database service"
  );
});

/**
 * Creates two raw database folders without seeding any message rows.
 *
 * @param {string} name - A unique name for this scenario.
 * @returns {{a: number, b: number}} The two folder IDs.
 */
function conversationFolders(name) {
  const rootId = folderDB.insertRoot("search-ingestion-" + name);
  return {
    a: folderDB.insertFolder(rootId, "A"),
    b: folderDB.insertFolder(rootId, "B"),
  };
}

/**
 * Inserts metadata through the public native API and returns its physical key.
 *
 * @param {number} folderId - The destination database folder ID.
 * @param {string} messageId - A unique bare Message-ID.
 * @param {string[]} references - The ordered bare References tokens.
 * @param {string} subject - The scenario's shared subject.
 * @returns {number} The nsMsgKey returned by addMessage.
 */
function ingestConversationMessage(folderId, messageId, references, subject) {
  const key = messageDB.addMessage(
    folderId,
    messageId,
    references,
    1700000000000000,
    "sender@conversation.invalid",
    "recipient@conversation.invalid",
    "",
    "",
    subject,
    0,
    "",
    Ci.nsMsgPriority.notSet
  );
  const header = messageDB.getMessage(key);
  Assert.equal(header.messageKey, key, "The returned key resolves to a header");
  Assert.equal(
    header.messageId,
    messageId,
    "The ingested Message-ID is readable"
  );
  return key;
}

/**
 * Queries each expected member's current thread and checks physical membership.
 * Thread IDs are read again for every call and may change after an arrival.
 *
 * @param {Array<[number, number]>} expected - Literal folder/key fixture pairs.
 * @param {string} stage - The arrival stage for assertion diagnostics.
 * @returns {Promise<void>} Resolves after checking every current conversation.
 */
async function assertIngestedConversation(expected, stage) {
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1];
  for (const [, seedKey] of expected) {
    const currentThreadId = messageDB.getMessage(seedKey).threadId;
    const view = new ConversationLiveView();
    view.initWithConversation(currentThreadId);
    view.grouping = Ci.nsILiveView.UNTHREADED;
    const rows = await view.selectMessages();
    Assert.deepEqual(
      Array.from(rows, row => [row.folderId, row.id]).toSorted(compare),
      expected.toSorted(compare),
      stage + ": exact physical members from key " + seedKey
    );
  }
}

add_task(async function test_orderedCrossFolderIngestion() {
  const { a, b } = conversationFolders("ordered");
  const subject = "Ordered conversation";
  const rootKey = ingestConversationMessage(
    a,
    "ordered-root@conversation.invalid",
    [],
    subject
  );
  const replyKey = ingestConversationMessage(
    b,
    "ordered-reply@conversation.invalid",
    ["ordered-root@conversation.invalid"],
    subject
  );
  const tailKey = ingestConversationMessage(
    a,
    "ordered-tail@conversation.invalid",
    ["ordered-root@conversation.invalid", "ordered-reply@conversation.invalid"],
    subject
  );
  const unrelatedKey = ingestConversationMessage(
    b,
    "ordered-unrelated@conversation.invalid",
    [],
    subject
  );
  await assertIngestedConversation(
    [
      [a, rootKey],
      [b, replyKey],
      [a, tailKey],
    ],
    "ordered chain"
  );
  await assertIngestedConversation([[b, unrelatedKey]], "same-subject control");
});

add_task(async function test_replyBeforeParentIngestion() {
  const { a, b } = conversationFolders("reply-first");
  const subject = "Reply before parent";
  ingestConversationMessage(
    a,
    "reply-first-unrelated@conversation.invalid",
    [],
    subject
  );
  const replyKey = ingestConversationMessage(
    b,
    "reply-first-child@conversation.invalid",
    ["reply-first-parent@conversation.invalid"],
    subject
  );
  await assertIngestedConversation([[b, replyKey]], "reply without parent");
  const parentKey = ingestConversationMessage(
    a,
    "reply-first-parent@conversation.invalid",
    [],
    subject
  );
  await assertIngestedConversation(
    [
      [b, replyKey],
      [a, parentKey],
    ],
    "parent arrived after reply"
  );
});

add_task(async function test_siblingsWithMissingParent() {
  const { a, b } = conversationFolders("siblings-missing");
  const subject = "Siblings without parent";
  ingestConversationMessage(
    a,
    "siblings-missing-unrelated@conversation.invalid",
    [],
    subject
  );
  const firstKey = ingestConversationMessage(
    a,
    "siblings-missing-first@conversation.invalid",
    ["siblings-missing-parent@conversation.invalid"],
    subject
  );
  const secondKey = ingestConversationMessage(
    b,
    "siblings-missing-second@conversation.invalid",
    ["siblings-missing-parent@conversation.invalid"],
    subject
  );
  await assertIngestedConversation(
    [
      [a, firstKey],
      [b, secondKey],
    ],
    "siblings share an absent parent"
  );
});

add_task(async function test_siblingsThenParentArrival() {
  const { a, b } = conversationFolders("siblings-parent-late");
  const subject = "Siblings then parent";
  const firstKey = ingestConversationMessage(
    a,
    "siblings-late-first@conversation.invalid",
    ["siblings-late-parent@conversation.invalid"],
    subject
  );
  const secondKey = ingestConversationMessage(
    b,
    "siblings-late-second@conversation.invalid",
    ["siblings-late-parent@conversation.invalid"],
    subject
  );
  ingestConversationMessage(
    b,
    "siblings-late-unrelated@conversation.invalid",
    [],
    subject
  );
  // Check the late arrival without first asserting missing-parent grouping.
  const parentKey = ingestConversationMessage(
    a,
    "siblings-late-parent@conversation.invalid",
    [],
    subject
  );
  await assertIngestedConversation(
    [
      [a, firstKey],
      [b, secondKey],
      [a, parentKey],
    ],
    "parent arrived after siblings"
  );
});
