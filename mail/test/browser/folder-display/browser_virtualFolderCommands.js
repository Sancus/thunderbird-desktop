/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Test that commands on virtual folders work properly.
 */

"use strict";

var {
  be_in_folder,
  create_folder,
  create_virtual_folder,
  expand_all_threads,
  get_about_3pane,
  make_display_threaded,
  select_click_row,
} = ChromeUtils.importESModule(
  "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
);
var { make_message_sets_in_folders } = ChromeUtils.importESModule(
  "resource://testing-common/mail/MessageInjectionHelpers.sys.mjs"
);

var msgsPerThread = 5;
var singleVirtFolder;
var multiVirtFolder;

add_setup(async function () {
  const folderOne = await create_folder("folderOne");
  const folderTwo = await create_folder("folderTwo");
  await make_message_sets_in_folders([folderOne], [{ msgsPerThread }]);
  await make_message_sets_in_folders([folderTwo], [{ msgsPerThread }]);

  singleVirtFolder = create_virtual_folder("singleVirtFolder", [folderOne]);
  multiVirtFolder = create_virtual_folder("multiVirtFolder", [
    folderOne,
    folderTwo,
  ]);
});

add_task(async function test_single_folder_select_thread() {
  await be_in_folder(singleVirtFolder);
  const win = get_about_3pane();
  await make_display_threaded();
  await expand_all_threads();

  // Try selecting the thread from the root message.
  await select_click_row(0);
  EventUtils.synthesizeKey("a", { accelKey: true, shiftKey: true });
  Assert.equal(
    win.gDBView.selection.count,
    msgsPerThread,
    "should have selected all messages in the thread"
  );

  // Now try selecting the thread from a non-root message.
  await select_click_row(1);
  EventUtils.synthesizeKey("a", { accelKey: true, shiftKey: true });
  Assert.equal(
    win.gDBView.selection.count,
    msgsPerThread,
    "should have selected all messages in the thread"
  );
});

add_task(async function test_cross_folder_select_thread() {
  await be_in_folder(multiVirtFolder);
  const win = get_about_3pane();
  await make_display_threaded();
  await expand_all_threads();

  // Try selecting the thread from the root message.
  await select_click_row(0);
  EventUtils.synthesizeKey("a", { accelKey: true, shiftKey: true });
  Assert.equal(
    win.gDBView.selection.count,
    msgsPerThread,
    "should have selected all messages in the thread"
  );

  // Now try selecting the thread from a non-root message.
  await select_click_row(1);
  EventUtils.synthesizeKey("a", { accelKey: true, shiftKey: true });
  Assert.equal(
    win.gDBView.selection.count,
    msgsPerThread,
    "should have selected all messages in the thread"
  );
});

var {
  assert_selected_and_displayed,
  get_about_message,
  make_display_unthreaded,
  press_delete,
} = ChromeUtils.importESModule(
  "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
);

/**
 * Stores a literal message in the existing real UI fixture.
 *
 * @param {nsIMsgFolder} folder - Destination folder.
 * @param {string} id - Message-ID without brackets.
 * @param {string} subject - Filter and sort input.
 * @returns {nsIMsgDBHdr} The stored header.
 */
function storeMembershipMessage(folder, id, subject) {
  return folder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .addMessage(
      "From: sender@membership.invalid\r\n" +
        "To: recipient@membership.invalid\r\n" +
        "Date: Thu, 1 Jan 2026 12:00:00 +0000\r\n" +
        `Message-ID: <${id}>\r\nSubject: ${subject}\r\n\r\nPhysical body: ${subject}\r\n`
    );
}

/**
 * Returns a stored header's physical location and literal ID.
 *
 * @param {nsIMsgDBHdr} header - Stored message header.
 * @returns {[string, number, string]} Folder URI, key and Message-ID.
 */
function membershipIdentity(header) {
  return [header.folder.URI, header.messageKey, header.messageId];
}

/**
 * Checks every displayed row against independent physical fixture inputs.
 *
 * @param {Array<[string, number, string]>} expected - Ordered fixture identities.
 * @param {nsIMsgDBHdr} outside - Unsearched equal-ID copy.
 */
function assertMembershipRows(expected, outside) {
  const { gDBView, gViewWrapper } = get_about_3pane();
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.equal(
    "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
    Services.prefs.getBoolPref("mail.panorama.enabled", false),
    "The UI uses the requested actual database backend"
  );
  Assert.equal(
    outside.folder.server.msgStore.storeType,
    Services.prefs
      .getCharPref("mail.serverDefaultStoreContractID")
      .includes("maildirstore")
      ? "maildir"
      : "mbox",
    "The physical UI fixture uses the requested store"
  );
  Assert.equal(gDBView.rowCount, expected.length);
  Assert.deepEqual(
    Array.from({ length: gDBView.rowCount }, (_, i) =>
      membershipIdentity(gDBView.getMsgHdrAt(i))
    ),
    expected,
    "The rendered view contains exactly the independently known ordered physical rows"
  );
  Assert.equal(gViewWrapper.getViewIndexForMsgHdr(outside, false), 0xffffffff);
  Assert.equal(gViewWrapper.getViewIndexForMsgHdr(outside, true), 0xffffffff);
}

add_task(async function test_single_folder_selected_physical_members() {
  const origin = get_about_3pane().gFolder;
  const tabmail = document.getElementById("tabmail");
  const originalTabs = [...tabmail.tabInfo];
  const target = await create_folder("physicalSingleTarget");
  const outside = await create_folder("physicalSingleOutside");
  registerCleanupFunction(async () => {
    await be_in_folder(origin);
    target.parent?.propagateDelete(target, true);
    outside.parent?.propagateDelete(outside, true);
  });
  const a = storeMembershipMessage(
    target,
    "single-ui@membership.invalid",
    "Alpha target"
  );
  const b = storeMembershipMessage(
    target,
    "survivor-ui@membership.invalid",
    "Zulu survivor"
  );
  const excluded = storeMembershipMessage(
    outside,
    "single-ui@membership.invalid",
    "Alpha outside"
  );
  const control = storeMembershipMessage(
    outside,
    "control-ui@membership.invalid",
    "Outside control"
  );
  const expected = [
    [target.URI, a.messageKey, "single-ui@membership.invalid"],
    [target.URI, b.messageKey, "survivor-ui@membership.invalid"],
  ];
  const outsideExpected = [
    membershipIdentity(excluded),
    membershipIdentity(control),
  ];
  await be_in_folder(target);
  await make_display_unthreaded();
  get_about_3pane().gViewWrapper.sort(
    "subjectCol",
    Ci.nsMsgViewSortOrder.ascending
  );
  assertMembershipRows(expected, excluded);
  await select_click_row(0);
  await assert_selected_and_displayed(a);
  Assert.deepEqual(
    membershipIdentity(get_about_3pane().gDBView.hdrForFirstSelectedMessage),
    expected[0]
  );
  Assert.deepEqual(
    membershipIdentity(get_about_message().gMessage),
    expected[0]
  );
  await press_delete();
  await TestUtils.waitForCondition(
    () => get_about_3pane().gDBView.rowCount == 1,
    "The actual deletion removes one target row"
  );
  assertMembershipRows([expected[1]], excluded);
  await assert_selected_and_displayed(b);
  Assert.deepEqual(
    membershipIdentity(get_about_message().gMessage),
    expected[1]
  );
  Assert.deepEqual(Array.from(target.messages, membershipIdentity), [
    expected[1],
  ]);
  Assert.deepEqual(
    Array.from(outside.messages, membershipIdentity),
    outsideExpected,
    "The outside copy and control are unchanged"
  );
  Assert.equal(
    get_about_3pane().gViewWrapper.getViewIndexForMsgHdr(a, false),
    0xffffffff
  );
  Assert.deepEqual(
    tabmail.tabInfo,
    originalTabs,
    "The command creates no extra tabs"
  );
  await be_in_folder(origin);
  Assert.equal(get_about_3pane().gFolder, origin);
});

add_task(async function test_saved_search_selected_physical_members() {
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  const native =
    "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore;
  Assert.equal(
    native,
    Services.prefs.getBoolPref("mail.panorama.enabled", false),
    "The saved-search control uses the requested actual backend"
  );
  if (!native) {
    info(
      "Native global-cache physical-member control; legacy equal-key saved-search behavior remains a reference observation"
    );
    return;
  }
  const { VirtualFolderHelper } = ChromeUtils.importESModule(
    "resource:///modules/VirtualFolderWrapper.sys.mjs"
  );
  const origin = get_about_3pane().gFolder;
  const tabmail = document.getElementById("tabmail");
  const originalTabs = [...tabmail.tabInfo];
  const first = await create_folder("physicalSearchFirst");
  const second = await create_folder("physicalSearchSecond");
  const outside = await create_folder("physicalSearchOutside");
  const a = storeMembershipMessage(
    first,
    "shared-ui@membership.invalid",
    "member Alpha"
  );
  const b = storeMembershipMessage(
    second,
    "shared-ui@membership.invalid",
    "member Zulu"
  );
  const excluded = storeMembershipMessage(
    outside,
    "shared-ui@membership.invalid",
    "member Outside"
  );
  const control = storeMembershipMessage(
    first,
    "search-control-ui@membership.invalid",
    "Unrelated control"
  );
  const localRoot = first.parent;
  const one = VirtualFolderHelper.createNewVirtualFolder(
    "physicalSearchOne",
    localRoot,
    [first],
    "AND (subject,contains,member)",
    false
  ).virtualFolder;
  const both = VirtualFolderHelper.createNewVirtualFolder(
    "physicalSearchBoth",
    localRoot,
    [first, second],
    "AND (subject,contains,member)",
    false
  ).virtualFolder;
  registerCleanupFunction(async () => {
    await be_in_folder(origin);
    for (const folder of [one, both, first, second, outside]) {
      folder.parent?.propagateDelete(folder, true);
    }
  });
  const expected = [
    [first.URI, a.messageKey, "shared-ui@membership.invalid"],
    [second.URI, b.messageKey, "shared-ui@membership.invalid"],
  ];
  const controlExpected = membershipIdentity(control);
  const outsideExpected = [
    [outside.URI, excluded.messageKey, "shared-ui@membership.invalid"],
  ];
  await be_in_folder(one);
  await make_display_unthreaded();
  assertMembershipRows([expected[0]], excluded);
  Assert.equal(
    get_about_3pane().gViewWrapper.getViewIndexForMsgHdr(b, true),
    0xffffffff
  );
  await select_click_row(0);
  await assert_selected_and_displayed(a);
  Assert.deepEqual(
    membershipIdentity(get_about_message().gMessage),
    expected[0]
  );
  await be_in_folder(both);
  await make_display_unthreaded();
  get_about_3pane().gViewWrapper.sort(
    "subjectCol",
    Ci.nsMsgViewSortOrder.ascending
  );
  assertMembershipRows(expected, excluded);
  Assert.deepEqual(
    Array.from(first.msgDatabase.getCachedHits(both.URI), membershipIdentity),
    expected,
    "The global cache keeps both physical source members"
  );
  await select_click_row(1);
  await assert_selected_and_displayed(b);
  Assert.deepEqual(
    membershipIdentity(get_about_3pane().gDBView.hdrForFirstSelectedMessage),
    expected[1]
  );
  get_about_3pane().gViewWrapper.sort(
    "subjectCol",
    Ci.nsMsgViewSortOrder.descending
  );
  assertMembershipRows(expected.toReversed(), excluded);
  await assert_selected_and_displayed(b);
  Assert.deepEqual(
    membershipIdentity(get_about_message().gMessage),
    expected[1]
  );
  await press_delete();
  await TestUtils.waitForCondition(
    () => get_about_3pane().gDBView.rowCount == 1,
    "Only the selected physical copy leaves the saved search"
  );
  assertMembershipRows([expected[0]], excluded);
  Assert.deepEqual(
    Array.from(first.msgDatabase.getCachedHits(both.URI), membershipIdentity),
    [expected[0]],
    "The actual deletion removes only the deleted physical member from cache"
  );
  await assert_selected_and_displayed(a);
  Assert.deepEqual(
    membershipIdentity(get_about_message().gMessage),
    expected[0]
  );
  Assert.deepEqual(Array.from(first.messages, membershipIdentity), [
    expected[0],
    controlExpected,
  ]);
  Assert.deepEqual(Array.from(second.messages, membershipIdentity), []);
  Assert.deepEqual(
    Array.from(outside.messages, membershipIdentity),
    outsideExpected
  );
  await be_in_folder(origin);
  await be_in_folder(both);
  assertMembershipRows([expected[0]], excluded);
  await select_click_row(0);
  await assert_selected_and_displayed(a);
  Assert.deepEqual(
    membershipIdentity(get_about_message().gMessage),
    expected[0]
  );
  Assert.deepEqual(tabmail.tabInfo, originalTabs);
  await be_in_folder(origin);
  Assert.equal(get_about_3pane().gFolder, origin);
});
