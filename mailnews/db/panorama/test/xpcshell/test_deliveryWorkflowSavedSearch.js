/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from head_delivery.js */

const { DBViewWrapper, IDBViewWrapperListener } = ChromeUtils.importESModule(
  "resource:///modules/DBViewWrapper.sys.mjs"
);
const { VirtualFolderHelper } = ChromeUtils.importESModule(
  "resource:///modules/VirtualFolderWrapper.sys.mjs"
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
 * Opens the saved search and waits for the real search to complete.
 *
 * @param {DBViewWrapper} wrapper - The view to open.
 * @param {nsIMsgFolder} folder - The virtual folder.
 */
async function openSearch(wrapper, folder) {
  const loaded = Promise.withResolvers();
  wrapper.listener.onMessagesLoaded = all => {
    if (all) {
      loaded.resolve();
    }
  };
  wrapper.open(folder);
  await loaded.promise;
}

/**
 * Checks every view row against explicit folder/key/Message-ID triples.
 *
 * @param {DBViewWrapper} wrapper - The open saved-search view.
 * @param {Array<[string, number, string]>} expected - The expected identities.
 */
function assertSearchMembers(wrapper, expected) {
  Assert.ok(wrapper.isVirtual, "The displayed folder is a saved search");
  const view = wrapper.dbView;
  Assert.ok(view, "The search has a message view");
  Assert.equal(view.rowCount, expected.length, "Exact saved-search row count");
  const actual = [];
  for (let i = 0; i < view.rowCount; i++) {
    const header = view.getMsgHdrAt(i);
    actual.push([header.folder.URI, header.messageKey, header.messageId]);
    Assert.equal(
      view.findIndexOfMsgHdr(header, false),
      i,
      "A fetched header resolves to its physical message row"
    );
  }
  Assert.deepEqual(
    actual.sort((a, b) => a[1] - b[1]),
    expected.toSorted((a, b) => a[1] - b[1]),
    "The search preserves each matching physical message"
  );
}

add_task(async function test_savedSearchTracksScopedAddDeleteAndReopen() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  const { folder: first, rootFolder } =
    PanoramaDelivery.createLocalFixture("searchFirst");
  const second = rootFolder
    .createLocalSubfolder("searchSecond")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const outside = rootFolder
    .createLocalSubfolder("searchOutside")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  PanoramaDelivery.assertFolder(second, lane);
  PanoramaDelivery.assertFolder(outside, lane);

  const a = addStoredMessage(
    first,
    "shared-search@delivery.invalid",
    "delivery-match copies"
  );
  const b = addStoredMessage(
    second,
    "shared-search@delivery.invalid",
    "delivery-match copies"
  );
  addStoredMessage(
    outside,
    "shared-search@delivery.invalid",
    "delivery-match copies"
  );
  const control = addStoredMessage(
    first,
    "control-search@delivery.invalid",
    "Unrelated subject"
  );
  const saved = VirtualFolderHelper.createNewVirtualFolder(
    "deliverySavedSearch",
    rootFolder,
    [first, second],
    "AND (subject,contains,delivery-match)",
    false
  );
  PanoramaDelivery.assertFolder(saved.virtualFolder, lane);
  Assert.deepEqual(
    saved.searchFolders.map(f => f.URI).sort(),
    [first.URI, second.URI].sort(),
    "The saved search has exactly the two selected source folders"
  );

  const listener = Object.create(IDBViewWrapperListener.prototype);
  listener.shouldMarkMessagesReadOnLeavingFolder = () => false;
  const wrapper = new DBViewWrapper(listener);
  listener.onLoadingFolder = () => {
    wrapper.showUnthreaded = true;
  };
  registerCleanupFunction(() => wrapper.close());
  const aIdentity = [first.URI, a.messageKey, "shared-search@delivery.invalid"];
  const bIdentity = [
    second.URI,
    b.messageKey,
    "shared-search@delivery.invalid",
  ];
  await openSearch(wrapper, saved.virtualFolder);
  assertSearchMembers(wrapper, [aIdentity, bIdentity]);

  const added = addStoredMessage(
    second,
    "added-search@delivery.invalid",
    "delivery-match arrival"
  );
  const addedIdentity = [
    second.URI,
    added.messageKey,
    "added-search@delivery.invalid",
  ];
  assertSearchMembers(wrapper, [aIdentity, bIdentity, addedIdentity]);

  first.deleteMessages([a], null, true, false, null, false);
  assertSearchMembers(wrapper, [bIdentity, addedIdentity]);
  Assert.deepEqual(
    Array.from(first.messages, h => [h.messageKey, h.messageId]),
    [[control.messageKey, "control-search@delivery.invalid"]],
    "The source retains only its nonmatching control"
  );
  Assert.deepEqual(
    Array.from(second.messages, h => [h.messageKey, h.messageId]).sort(
      (left, right) => left[0] - right[0]
    ),
    [
      [b.messageKey, "shared-search@delivery.invalid"],
      [added.messageKey, "added-search@delivery.invalid"],
    ].sort((left, right) => left[0] - right[0]),
    "Both matching source identities remain stored"
  );

  wrapper.close();
  await openSearch(wrapper, saved.virtualFolder);
  assertSearchMembers(wrapper, [bIdentity, addedIdentity]);
  Assert.equal(
    [...outside.messages].length,
    1,
    "The unsearched copy is unchanged"
  );
});
