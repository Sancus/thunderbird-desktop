/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from head_delivery.js */

const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);
const LiveView = Components.Constructor(
  "@mozilla.org/mailnews/live-view;1",
  "nsILiveView"
);

/**
 * Adds a stored message whose body also contains the filter text.
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
      `Message-ID: <${messageId}>\r\nSubject: ${subject}\r\n\r\n` +
      "delivery-filter appears in every body.\r\n"
  );
}

/**
 * Applies the manual filter and waits for its operation result.
 *
 * @param {nsIMsgFilterList} list - The temporary filter list.
 * @param {nsIMsgFolder} folder - The folder to filter.
 */
async function applyFilter(list, folder) {
  const listener = new PromiseTestUtils.PromiseMsgOperationListener();
  MailServices.filters.applyFiltersToFolders(list, [folder], null, listener);
  await listener.promise;
}

/**
 * Checks tag membership independently of source-folder enumeration.
 *
 * @param {nsILiveView} view - The tag view.
 * @param {Array<[number, string]>} expected - Keys and literal Message-IDs.
 */
async function assertTagged(view, expected) {
  Assert.deepEqual(
    (await view.selectMessages())
      .map(m => [m.id, m.messageId])
      .sort((a, b) => a[0] - b[0]),
    expected.toSorted((a, b) => a[0] - b[0]),
    "Only the expected physical messages have the filter tag"
  );
  Assert.equal(await view.countMessages(), expected.length, "Exact tag count");
  Assert.equal(await view.countUnreadMessages(), 0, "Tagged matches are read");
}

add_task(async function test_manualFilterUpdatesTagMembershipAndReadState() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  const { folder, rootFolder } =
    PanoramaDelivery.createLocalFixture("filterSource");
  const outside = rootFolder
    .createLocalSubfolder("filterOutside")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  PanoramaDelivery.assertFolder(outside, lane);
  const a = addStoredMessage(
    folder,
    "shared-filter@delivery.invalid",
    "delivery-filter copies"
  );
  const b = addStoredMessage(
    folder,
    "shared-filter@delivery.invalid",
    "delivery-filter copies"
  );
  const excluded = addStoredMessage(
    outside,
    "shared-filter@delivery.invalid",
    "delivery-filter copies"
  );
  const control = addStoredMessage(
    folder,
    "control-filter@delivery.invalid",
    "Unrelated subject"
  );
  Assert.notEqual(a.messageKey, b.messageKey, "Same-ID copies remain distinct");

  const tag = "$label1";
  const list = MailServices.filters.getTempFilterList(folder);
  const filter = list.createFilter("delivery subject filter");
  const term = filter.createTerm();
  term.attrib = Ci.nsMsgSearchAttrib.Subject;
  const value = term.value;
  value.attrib = term.attrib;
  value.str = "delivery-filter";
  term.value = value;
  term.op = Ci.nsMsgSearchOp.Contains;
  term.booleanAnd = true;
  filter.appendTerm(term);
  const addTag = filter.createAction();
  addTag.type = Ci.nsMsgFilterAction.AddTag;
  addTag.strValue = tag;
  filter.appendAction(addTag);
  const read = filter.createAction();
  read.type = Ci.nsMsgFilterAction.MarkRead;
  filter.appendAction(read);
  filter.enabled = true;
  filter.filterType = Ci.nsMsgFilterType.Manual;
  list.insertFilterAt(0, filter);

  const view = new LiveView();
  view.initWithTag(tag);
  view.grouping = Ci.nsILiveView.UNTHREADED;
  const additions = [];
  const removals = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsILiveViewListener"]),
    onMessageAdded(message) {
      additions.push([message.id, message.messageId]);
    },
    onMessageRemoved(message) {
      removals.push([message.id, message.messageId]);
    },
    onMessageFlagsChanged() {},
    onMessageTagsChanged() {},
    onSelectedChunk() {},
  };
  view.setListener(listener);
  registerCleanupFunction(() => view.clearListener(listener));
  await assertTagged(view, []);
  await applyFilter(list, folder);
  const aIdentity = [a.messageKey, "shared-filter@delivery.invalid"];
  const bIdentity = [b.messageKey, "shared-filter@delivery.invalid"];
  Assert.deepEqual(
    additions.splice(0).sort((left, right) => left[0] - right[0]),
    [aIdentity, bIdentity].sort((left, right) => left[0] - right[0]),
    "The filter publishes both matching copies to the live tag view"
  );
  Assert.deepEqual(removals, [], "The filter removes no tag members");
  await assertTagged(view, [aIdentity, bIdentity]);
  for (const header of [a, b]) {
    const stored = folder.msgDatabase.getMsgHdrForKey(header.messageKey);
    Assert.ok(stored.isRead, "Each matched physical copy is read");
    Assert.equal(stored.getStringProperty("keywords"), tag);
  }
  for (const header of [control, excluded]) {
    Assert.ok(
      !header.isRead,
      "Nonmatching and out-of-scope messages stay unread"
    );
    Assert.equal(header.getStringProperty("keywords"), "");
  }

  const added = addStoredMessage(
    folder,
    "added-filter@delivery.invalid",
    "delivery-filter arrival"
  );
  await applyFilter(list, folder);
  await assertTagged(view, [
    aIdentity,
    bIdentity,
    [added.messageKey, "added-filter@delivery.invalid"],
  ]);
  Assert.deepEqual(
    additions,
    [[added.messageKey, "added-filter@delivery.invalid"]],
    "Repeating the filter adds only the new match"
  );
  folder.removeKeywordsFromMessages([b], tag);
  Assert.deepEqual(
    removals,
    [bIdentity],
    "Tag removal removes one physical copy"
  );
  await assertTagged(view, [
    aIdentity,
    [added.messageKey, "added-filter@delivery.invalid"],
  ]);
  Assert.deepEqual(
    Array.from(folder.messages, h => [h.messageKey, h.messageId]).sort(
      (left, right) => left[0] - right[0]
    ),
    [
      aIdentity,
      bIdentity,
      [control.messageKey, "control-filter@delivery.invalid"],
      [added.messageKey, "added-filter@delivery.invalid"],
    ].sort((left, right) => left[0] - right[0]),
    "Filtering and tag removal preserve all four source identities"
  );
});
