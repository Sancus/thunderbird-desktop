/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from head_delivery.js */

const NOT_IN_VIEW = 0xffffffff;

/**
 * Stores a message with a literal Message-ID and subject.
 *
 * @param {nsIMsgLocalMailFolder} folder - The destination folder.
 * @param {string} messageId - The Message-ID without angle brackets.
 * @param {string} subject - The subject used for sorting.
 * @returns {nsIMsgDBHdr} The stored header.
 */
function addStoredMessage(folder, messageId, subject) {
  return folder.addMessage(
    "From: sender@delivery.invalid\r\n" +
      "To: recipient@delivery.invalid\r\n" +
      "Date: Thu, 1 Jan 2026 12:00:00 +0000\r\n" +
      `Message-ID: <${messageId}>\r\nSubject: ${subject}\r\n\r\nBody.\r\n`
  );
}

/**
 * Checks exact ordered rows, fresh header lookups and folder exclusion.
 *
 * @param {nsIMsgDBView} view - The single-folder view.
 * @param {Array<[string, number, string]>} expected - Ordered physical identities.
 * @param {nsIMsgDBHdr} excluded - A same-Message-ID header in another folder.
 */
function assertRows(view, expected, excluded) {
  const tree = view.QueryInterface(Ci.nsITreeView);
  Assert.equal(tree.rowCount, expected.length, "Exact single-folder row count");
  const actual = [];
  for (let index = 0; index < tree.rowCount; index++) {
    const header = view.getMsgHdrAt(index);
    Assert.ok(header, "The row has a message header");
    actual.push([header.folder.URI, header.messageKey, header.messageId]);
    const fetched = header.folder.msgDatabase.getMsgHdrForKey(
      header.messageKey
    );
    Assert.equal(
      view.findIndexOfMsgHdr(fetched, false),
      index,
      "A fresh database header resolves to its physical row"
    );
  }
  Assert.deepEqual(
    actual,
    expected,
    "Exact ordered folder/key/Message-ID rows"
  );
  Assert.equal(
    view.findIndexOfMsgHdr(excluded, false),
    NOT_IN_VIEW,
    "A same-Message-ID message in another folder is excluded"
  );
}

add_task(function test_singleFolderTracksFreshHeadersAndDeletion() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  const { folder, rootFolder, db } = PanoramaDelivery.createLocalFixture(
    "singleFolderIdentity"
  );
  const outside = rootFolder
    .createLocalSubfolder("singleFolderOutside")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  PanoramaDelivery.assertFolder(outside, lane);
  const a = addStoredMessage(
    folder,
    "first-single@delivery.invalid",
    "Alpha selected"
  );
  const b = addStoredMessage(
    folder,
    "second-single@delivery.invalid",
    "Zulu selected"
  );
  const excluded = addStoredMessage(
    outside,
    "first-single@delivery.invalid",
    "Alpha selected"
  );
  const firstIdentity = [
    folder.URI,
    a.messageKey,
    "first-single@delivery.invalid",
  ];
  const secondIdentity = [
    folder.URI,
    b.messageKey,
    "second-single@delivery.invalid",
  ];

  const view = Cc[
    "@mozilla.org/messenger/msgdbview;1?type=threaded"
  ].createInstance(Ci.nsIMsgDBView);
  registerCleanupFunction(() => view.close());
  view.init(null, null);
  view.open(
    folder,
    Ci.nsMsgViewSortType.bySubject,
    Ci.nsMsgViewSortOrder.ascending,
    Ci.nsMsgViewFlagsType.kNone
  );
  Assert.equal(view.msgFolder, folder, "The view belongs to the real folder");
  assertRows(view, [firstIdentity, secondIdentity], excluded);
  view.sort(Ci.nsMsgViewSortType.bySubject, Ci.nsMsgViewSortOrder.descending);
  assertRows(view, [secondIdentity, firstIdentity], excluded);

  folder.deleteMessages([a], null, true, false, null, false);
  assertRows(view, [secondIdentity], excluded);
  Assert.equal(
    view.findIndexOfMsgHdr(a, false),
    NOT_IN_VIEW,
    "The retained deleted header has no row"
  );
  Assert.deepEqual(
    Array.from(db.enumerateMessages(), h => [h.messageKey, h.messageId]),
    [[b.messageKey, "second-single@delivery.invalid"]],
    "The database retains only the expected physical message"
  );
  Assert.deepEqual(
    Array.from(outside.messages, h => [h.messageKey, h.messageId]),
    [[excluded.messageKey, "first-single@delivery.invalid"]],
    "The excluded physical message is unchanged"
  );

  view.sort(Ci.nsMsgViewSortType.bySubject, Ci.nsMsgViewSortOrder.ascending);
  assertRows(view, [secondIdentity], excluded);
});
