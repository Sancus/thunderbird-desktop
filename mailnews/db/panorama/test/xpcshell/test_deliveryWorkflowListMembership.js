/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from head_delivery.js */

const { LiveViewDataAdapter } = ChromeUtils.importESModule(
  "chrome://messenger/content/LiveViewDataAdapter.mjs"
);
const LiveView = Components.Constructor(
  "@mozilla.org/mailnews/live-view;1",
  "nsILiveView"
);

/**
 * Adds a stored message with a literal Message-ID.
 *
 * @param {nsIMsgLocalMailFolder} folder - The destination folder.
 * @param {string} messageId - The Message-ID without angle brackets.
 * @param {string} subject - The subject header.
 * @returns {nsIMsgDBHdr} The stored header.
 */
function addStoredMessage(folder, messageId, subject) {
  return folder.addMessage(
    "From: sender@delivery.invalid\r\n" +
      "To: recipient@delivery.invalid\r\n" +
      "Date: Tue, 1 Sep 2026 12:00:00 +0000\r\n" +
      `Message-ID: <${messageId}>\r\nSubject: ${subject}\r\n\r\nBody.\r\n`
  );
}

/**
 * Checks physical identities and counts without depending on row order.
 *
 * @param {nsILiveView} view - The scoped message list.
 * @param {LiveViewDataAdapter} adapter - The live list cache.
 * @param {Array<[number, number, string]>} expected - Key, folder ID, Message-ID.
 * @param {number} unread - The expected unread count.
 */
async function assertMembers(view, adapter, expected, unread) {
  Assert.equal(adapter.rowCount, expected.length, "Exact live adapter count");
  const cached = [];
  let cachedUnread = 0;
  for (let i = 0; i < adapter.rowCount; i++) {
    const { message } = adapter.rowAt(i);
    cached.push([message.id, message.folderId, message.messageId]);
    cachedUnread += message.flags & Ci.nsMsgMessageFlags.Read ? 0 : 1;
  }
  Assert.deepEqual(
    cached.sort((a, b) => a[0] - b[0]),
    expected.toSorted((a, b) => a[0] - b[0]),
    "Live callbacks keep the adapter's physical membership current"
  );
  Assert.equal(cachedUnread, unread, "Exact unread count in the live adapter");
  const rows = await view.selectMessages();
  Assert.deepEqual(
    rows.map(m => [m.id, m.folderId, m.messageId]).sort((a, b) => a[0] - b[0]),
    expected.toSorted((a, b) => a[0] - b[0]),
    "The list contains exactly the expected physical messages"
  );
  Assert.equal(await view.countMessages(), expected.length, "Exact list count");
  Assert.equal(await view.countUnreadMessages(), unread, "Exact unread count");
}

add_task(async function test_scopedListTracksPublicationReadAndDeletion() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  const { folder: first, rootFolder } =
    PanoramaDelivery.createLocalFixture("listFirst");
  const second = rootFolder
    .createLocalSubfolder("listSecond")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const outside = rootFolder
    .createLocalSubfolder("listOutside")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  PanoramaDelivery.assertFolder(second, lane);
  PanoramaDelivery.assertFolder(outside, lane);

  const view = new LiveView();
  view.initWithFolders([first.id, second.id]);
  view.grouping = Ci.nsILiveView.UNTHREADED;
  const adapterView = new LiveView();
  adapterView.initWithFolders([first.id, second.id]);
  const adapter = new LiveViewDataAdapter(adapterView);
  registerCleanupFunction(() => adapter.setTree(null));
  await adapter.sortBy("date", "ascending");
  const events = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsILiveViewListener"]),
    onMessageAdded(message) {
      events.push(["added", message.id, message.folderId, message.messageId]);
    },
    onMessageRemoved(message) {
      events.push(["removed", message.id, message.folderId, message.messageId]);
    },
    onMessageFlagsChanged(message, oldFlags) {
      events.push([
        "flags",
        message.id,
        message.folderId,
        oldFlags,
        message.flags,
      ]);
    },
    onMessageTagsChanged() {
      Assert.ok(false, "This workflow does not change tags");
    },
    onSelectedChunk() {},
  };
  view.setListener(listener);
  registerCleanupFunction(() => view.clearListener());
  await assertMembers(view, adapter, [], 0);

  const a = addStoredMessage(
    first,
    "shared-list@delivery.invalid",
    "Two physical copies"
  );
  const b = addStoredMessage(
    second,
    "shared-list@delivery.invalid",
    "Two physical copies"
  );
  addStoredMessage(
    outside,
    "shared-list@delivery.invalid",
    "Two physical copies"
  );
  Assert.notEqual(
    a.messageKey,
    b.messageKey,
    "Copies have distinct global keys"
  );
  const aIdentity = [a.messageKey, first.id, "shared-list@delivery.invalid"];
  const bIdentity = [b.messageKey, second.id, "shared-list@delivery.invalid"];
  Assert.deepEqual(events.splice(0), [
    ["added", ...aIdentity],
    ["added", ...bIdentity],
  ]);
  await assertMembers(view, adapter, [aIdentity, bIdentity], 2);

  const oldFlags = a.flags;
  first.markMessagesRead([a], true);
  Assert.deepEqual(events.splice(0), [
    [
      "flags",
      a.messageKey,
      first.id,
      oldFlags,
      oldFlags | Ci.nsMsgMessageFlags.Read,
    ],
  ]);
  Assert.ok(first.msgDatabase.getMsgHdrForKey(a.messageKey).isRead);
  Assert.ok(!second.msgDatabase.getMsgHdrForKey(b.messageKey).isRead);
  await assertMembers(view, adapter, [aIdentity, bIdentity], 1);

  second.deleteMessages([b], null, true, false, null, false);
  Assert.deepEqual(events.splice(0), [["removed", ...bIdentity]]);
  await assertMembers(view, adapter, [aIdentity], 0);
  Assert.deepEqual(
    [...second.messages],
    [],
    "Deleted copy is absent from its folder"
  );
  Assert.deepEqual(
    Array.from(first.messages, h => [h.messageKey, h.messageId]),
    [[a.messageKey, "shared-list@delivery.invalid"]],
    "Deleting another physical copy preserves the first"
  );
  Assert.equal([...outside.messages].length, 1, "Out-of-scope copy survives");

  view.clearListener({
    ...listener,
    onMessageFlagsChanged() {
      Assert.ok(false, "The unregistered listener must not run");
    },
  });
  first.markMessagesRead([a], false);
  Assert.deepEqual(
    events.splice(0),
    [
      [
        "flags",
        a.messageKey,
        first.id,
        oldFlags | Ci.nsMsgMessageFlags.Read,
        oldFlags,
      ],
    ],
    "A different listener cannot detach this one"
  );
  view.clearListener(listener);
  first.markMessagesRead([a], true);
  Assert.deepEqual(events, [], "Detached listener receives no later mutations");
  await assertMembers(view, adapter, [aIdentity], 0);
});
