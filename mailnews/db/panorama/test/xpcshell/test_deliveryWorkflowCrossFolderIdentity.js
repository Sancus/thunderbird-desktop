/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from head_delivery.js */

const SHARED_KEY = 42;
const NOT_IN_VIEW = 0xffffffff;

/**
 * Adds a metadata-only header with the chosen legacy folder-scoped key.
 *
 * @param {nsIMsgDatabase} db - An empty legacy folder database.
 * @param {string} messageId - The literal Message-ID without angle brackets.
 * @param {string} subject - The subject used for sorting.
 * @returns {nsIMsgDBHdr} The attached header.
 */
function addMetadataHeader(db, messageId, subject) {
  Assert.ok(
    !db.containsKey(SHARED_KEY),
    "The chosen key is unused in this folder"
  );
  const header = db.createNewHdrWithSpecificMsgKey(SHARED_KEY);
  header.messageId = messageId;
  header.author = "sender@delivery.invalid";
  header.recipients = "recipient@delivery.invalid";
  header.subject = subject;
  header.date = Date.UTC(2026, 0, 1) * 1000;
  header.flags = 0;
  db.addNewHdrToDB(header, true);
  Assert.equal(
    header.messageKey,
    SHARED_KEY,
    "The explicit fixture key is kept"
  );
  return header;
}

/**
 * Checks exact row order, fetched-header indices and the excluded location.
 *
 * @param {nsIMsgDBView} view - The unthreaded cross-folder search view.
 * @param {Array<[string, number, string]>} expected - Ordered physical identities.
 * @param {nsIMsgDBHdr} excluded - The unsearched third-folder header.
 */
function assertRows(view, expected, excluded) {
  const tree = view.QueryInterface(Ci.nsITreeView);
  Assert.equal(tree.rowCount, expected.length, "Exact physical row count");
  const actual = [];
  for (let index = 0; index < tree.rowCount; index++) {
    const header = view.getMsgHdrAt(index);
    Assert.ok(header, "The row has a message header");
    actual.push([header.folder.URI, header.messageKey, header.messageId]);
    Assert.equal(
      view.findIndexOfMsgHdr(header, false),
      index,
      "The row header resolves to its own physical row"
    );
    const fetched = header.folder.msgDatabase.getMsgHdrForKey(
      header.messageKey
    );
    Assert.equal(
      view.findIndexOfMsgHdr(fetched, false),
      index,
      "A database-fetched header resolves to the same physical row"
    );
  }
  Assert.deepEqual(actual, expected, "Exact folder/key/Message-ID order");
  Assert.equal(
    view.findIndexOfMsgHdr(excluded, false),
    NOT_IN_VIEW,
    "An unsearched folder cannot match the same key and Message-ID"
  );
}

add_task(function test_crossFolderEqualKeysLegacy() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(
    lane.backend,
    "mork",
    "This is an explicit legacy reference case"
  );
  const {
    folder: first,
    rootFolder,
    db: firstDB,
  } = PanoramaDelivery.createLocalFixture("identityFirst");
  const second = rootFolder.createLocalSubfolder("identitySecond");
  const outside = rootFolder.createLocalSubfolder("identityOutside");
  const secondDB = PanoramaDelivery.assertFolder(second, lane);
  const outsideDB = PanoramaDelivery.assertFolder(outside, lane);

  const a = addMetadataHeader(
    firstDB,
    "first-identity@delivery.invalid",
    "Alpha selected"
  );
  const b = addMetadataHeader(
    secondDB,
    "second-identity@delivery.invalid",
    "Zulu selected"
  );
  const excluded = addMetadataHeader(
    outsideDB,
    "first-identity@delivery.invalid",
    "Outside unsearched"
  );
  Assert.equal(a.folder, first, "The first header belongs to the first folder");
  Assert.equal(
    b.folder,
    second,
    "The second header belongs to the second folder"
  );
  Assert.equal(
    excluded.folder,
    outside,
    "The exclusion belongs to its own folder"
  );

  const singleFolderView = Cc[
    "@mozilla.org/messenger/msgdbview;1?type=threaded"
  ].createInstance(Ci.nsIMsgDBView);
  try {
    singleFolderView.init(null, null);
    singleFolderView.open(
      first,
      Ci.nsMsgViewSortType.bySubject,
      Ci.nsMsgViewSortOrder.ascending,
      Ci.nsMsgViewFlagsType.kNone
    );
    Assert.equal(
      singleFolderView.findIndexOfMsgHdr(
        firstDB.getMsgHdrForKey(SHARED_KEY),
        false
      ),
      0,
      "The single-folder view finds its own database-fetched header"
    );
    Assert.equal(
      singleFolderView.findIndexOfMsgHdr(
        outsideDB.getMsgHdrForKey(SHARED_KEY),
        false
      ),
      NOT_IN_VIEW,
      "The single-folder view excludes another folder's equal key"
    );
  } finally {
    singleFolderView.close();
  }

  const firstIdentity = [
    first.URI,
    SHARED_KEY,
    "first-identity@delivery.invalid",
  ];
  const secondIdentity = [
    second.URI,
    SHARED_KEY,
    "second-identity@delivery.invalid",
  ];
  const view = Cc[
    "@mozilla.org/messenger/msgdbview;1?type=search"
  ].createInstance(Ci.nsIMsgDBView);
  registerCleanupFunction(() => view.close());
  view.init(null, null);
  view.open(
    null,
    Ci.nsMsgViewSortType.bySubject,
    Ci.nsMsgViewSortOrder.ascending,
    Ci.nsMsgViewFlagsType.kNone
  );
  const notify = view.QueryInterface(Ci.nsIMsgSearchNotify);
  notify.onNewSearch();
  notify.onSearchHit(b, second);
  notify.onSearchHit(a, first);
  notify.onSearchDone(Cr.NS_OK);
  assertRows(view, [firstIdentity, secondIdentity], excluded);

  view.sort(Ci.nsMsgViewSortType.bySubject, Ci.nsMsgViewSortOrder.descending);
  assertRows(view, [secondIdentity, firstIdentity], excluded);

  firstDB.deleteMessages([SHARED_KEY], null);
  assertRows(view, [secondIdentity], excluded);
  Assert.equal(
    view.findIndexOfMsgHdr(a, false),
    NOT_IN_VIEW,
    "A retained deleted header cannot resolve to the other folder's equal key"
  );
  Assert.deepEqual(
    [...firstDB.enumerateMessages()],
    [],
    "The deleted physical header is absent from its database membership"
  );
  Assert.deepEqual(
    Array.from(secondDB.enumerateMessages(), h => [h.messageKey, h.messageId]),
    [[SHARED_KEY, "second-identity@delivery.invalid"]],
    "The other selected physical header remains in its database"
  );
  Assert.deepEqual(
    Array.from(outsideDB.enumerateMessages(), h => [h.messageKey, h.messageId]),
    [[SHARED_KEY, "first-identity@delivery.invalid"]],
    "The unsearched same-key header remains in its database"
  );

  view.sort(Ci.nsMsgViewSortType.bySubject, Ci.nsMsgViewSortOrder.ascending);
  assertRows(view, [secondIdentity], excluded);
});
