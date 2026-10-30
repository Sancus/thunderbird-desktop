/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Verify that we are constructing the filters that we expect and that they
 * are hooked up to the right buttons.
 */

"use strict";

var {
  assert_messages_in_view,
  assert_messages_not_in_view,
  be_in_folder,
  create_folder,
  get_about_3pane,
  wait_for_all_messages_to_load,
} = ChromeUtils.importESModule(
  "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
);
var { delete_messages, make_message_sets_in_folders } =
  ChromeUtils.importESModule(
    "resource://testing-common/mail/MessageInjectionHelpers.sys.mjs"
  );
var {
  assert_results_label_count,
  assert_tag_mode,
  assert_text_constraints_checked,
  clear_constraints,
  set_filter_text,
  toggle_boolean_constraints,
  toggle_quick_filter_bar,
  toggle_tag_constraints,
  switch_tag_mode,
  toggle_text_constraints,
  cleanup_qfb_button,
} = ChromeUtils.importESModule(
  "resource://testing-common/mail/QuickFilterBarHelpers.sys.mjs"
);

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { ensure_cards_view, ensure_table_view } = ChromeUtils.importESModule(
  "resource://testing-common/MailViewHelpers.sys.mjs"
);

add_setup(async function () {
  // Quick filter bar is hidden by default, need to toggle it on. To toggle
  // quick filter bar, need to be inside folder
  const folder = await create_folder("QuickFilterBarFilterFilterLogicSetup");
  await be_in_folder(folder);
  await ensure_table_view(document);
  await toggle_quick_filter_bar();

  registerCleanupFunction(async function () {
    await ensure_cards_view(document);
    await cleanup_qfb_button();
    // Quick filter bar is hidden by default, need to toggle it off.
    await toggle_quick_filter_bar();
  });
});

/**
 * Assert that the tags selection elements have the expected class and
 * visibility state after a mode change.
 *
 * @param {boolean} isVisible - The visibility state in which the buttons should
 * be.
 */
function subtest_assert_tags_visibility(isVisible) {
  const about3Pane = get_about_3pane();

  Assert.equal(
    about3Pane.document
      .getElementById("quickFilterBarTagsContainer")
      .classList.contains("none-mode-selected"),
    !isVisible,
    "The .none-mode-selected class should be applied to the tags container"
  );
  for (const button of [
    ...about3Pane.document.querySelectorAll(
      "#quickFilterBarTagsContainer button.qfb-tag-button"
    ),
  ]) {
    if (isVisible) {
      Assert.ok(
        BrowserTestUtils.isVisible(button),
        "The tags button of the quick filter bar should be visible"
      );
    } else {
      Assert.ok(
        BrowserTestUtils.isHidden(button),
        "The tags button of the quick filter bar should be hidden"
      );
    }
  }
}

add_task(async function test_filter_unread() {
  const folder = await create_folder("QuickFilterBarFilterUnread");
  const [unread, read] = await make_message_sets_in_folders(
    [folder],
    [{ count: 1 }, { count: 1 }]
  );
  read.setRead(true);

  await be_in_folder(folder);
  await toggle_boolean_constraints("unread");
  assert_messages_in_view(unread);
  teardownTest();
});

add_task(async function test_filter_starred() {
  const folder = await create_folder("QuickFilterBarFilterStarred");
  const [, starred] = await make_message_sets_in_folders(
    [folder],
    [{ count: 1 }, { count: 1 }]
  );
  starred.setStarred(true);

  await be_in_folder(folder);
  await toggle_boolean_constraints("starred");
  assert_messages_in_view(starred);
  teardownTest();
});

add_task(async function test_filter_simple_intersection_unread_and_starred() {
  const folder = await create_folder("QuickFilterBarFilterUnreadAndStarred");
  const [, readUnstarred, unreadStarred, readStarred] =
    await make_message_sets_in_folders(
      [folder],
      [{ count: 1 }, { count: 1 }, { count: 1 }, { count: 1 }]
    );
  readUnstarred.setRead(true);
  unreadStarred.setStarred(true);
  readStarred.setRead(true);
  readStarred.setStarred(true);

  await be_in_folder(folder);
  await toggle_boolean_constraints("unread", "starred");

  assert_messages_in_view(unreadStarred);
  teardownTest();
});

add_task(async function test_filter_attachments() {
  const attachSetDef = {
    count: 1,
    attachments: [
      {
        filename: "foo.png",
        contentType: "image/png",
        encoding: "base64",
        charset: null,
        body: "YWJj\n",
        format: null,
      },
    ],
  };
  const noAttachSetDef = {
    count: 1,
  };

  const folder = await create_folder("QuickFilterBarFilterAttachments");
  const [, setAttach] = await make_message_sets_in_folders(
    [folder],
    [noAttachSetDef, attachSetDef]
  );

  await be_in_folder(folder);
  await toggle_boolean_constraints("attachments");

  assert_messages_in_view(setAttach);
  teardownTest();
});

/**
 * Create a card for the given e-mail address, adding it to the first address
 * book we can find.
 */
function add_email_to_address_book(aEmailAddr, aDisplayName = "") {
  const card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
    Ci.nsIAbCard
  );
  card.primaryEmail = aEmailAddr;
  card.displayName = aDisplayName;

  for (const addrbook of MailServices.ab.directories) {
    addrbook.addCard(card);
    return;
  }

  throw new Error("Unable to find any suitable address book.");
}

add_task(async function test_filter_in_address_book() {
  const bookSetDef = {
    from: ["Qbert Q Qbington", "q@q.invalid"],
    count: 1,
  };
  add_email_to_address_book(bookSetDef.from[1]);
  const folder = await create_folder("MesssageFilterBarInAddressBook");
  const [setBook] = await make_message_sets_in_folders(
    [folder],
    [bookSetDef, { count: 1 }]
  );
  await be_in_folder(folder);
  await toggle_boolean_constraints("addrbook");
  assert_messages_in_view(setBook);
  teardownTest();
});

add_task(async function test_filter_tags() {
  const folder = await create_folder("QuickFilterBarTags");
  const tagA = "$label1",
    tagB = "$label2",
    tagC = "$label3";
  const [setNoTag, setTagA, setTagB, setTagAB, setTagC] =
    await make_message_sets_in_folders(
      [folder],
      [{ count: 1 }, { count: 1 }, { count: 1 }, { count: 1 }, { count: 1 }]
    );
  setTagA.addTag(tagA);
  setTagB.addTag(tagB);
  setTagAB.addTag(tagA);
  setTagAB.addTag(tagB);
  setTagC.addTag(tagC);

  await be_in_folder(folder);
  await toggle_boolean_constraints("tags"); // must have a tag
  assert_tag_mode("OR");
  assert_messages_in_view([setTagA, setTagB, setTagAB, setTagC]);

  await toggle_tag_constraints(tagA); // must have tag A
  assert_messages_in_view([setTagA, setTagAB]);

  await toggle_tag_constraints(tagB);
  // mode is OR by default -> must have tag A or tag B
  assert_messages_in_view([setTagA, setTagB, setTagAB]);

  await switch_tag_mode("AND");
  // mode is now AND -> must have tag A and tag B
  assert_messages_in_view([setTagAB]);

  await toggle_tag_constraints(tagA); // must have tag B
  assert_messages_in_view([setTagB, setTagAB]);

  await toggle_tag_constraints(tagB); // have have a tag
  assert_messages_in_view([setTagA, setTagB, setTagAB, setTagC]);

  await switch_tag_mode("NONE");
  // mode is now NONE -> must have no tags
  assert_messages_in_view([setNoTag]);
  subtest_assert_tags_visibility(false);

  await toggle_boolean_constraints("tags"); // no constraints
  assert_messages_in_view([setNoTag, setTagA, setTagB, setTagAB, setTagC]);

  // If we have filtered to a specific tag and we disable the tag filter
  // entirely, make sure that when we turn it back on we are just back to "any
  // tag".
  await toggle_boolean_constraints("tags");
  // The tags filter should be back to "OR" and any tags should be shown.
  assert_tag_mode("OR");
  assert_messages_in_view([setTagA, setTagB, setTagAB, setTagC]);

  await switch_tag_mode("AND");
  subtest_assert_tags_visibility(true);
  await toggle_tag_constraints(tagC);
  assert_messages_in_view(setTagC);

  await toggle_boolean_constraints("tags"); // no constraints
  await toggle_boolean_constraints("tags"); // should be any tag (not tagC!)
  assert_messages_in_view([setTagA, setTagB, setTagAB, setTagC]);
  teardownTest();
});

add_task(async function test_filter_text_single_word_and_predicates() {
  const folder = await create_folder("QuickFilterBarTextSingleWord");
  const whoFoo = ["zabba", "foo@madeup.invalid"];
  const [, setSenderFoo, setRecipientsFoo, setSubjectFoo, setBodyFoo] =
    await make_message_sets_in_folders(
      [folder],
      [
        { count: 1 },
        { count: 1, from: whoFoo },
        { count: 1, to: [whoFoo] },
        { count: 1, subject: "foo" },
        { count: 1, body: { body: "foo" } },
      ]
    );
  await be_in_folder(folder);

  // by default, sender/recipients/subject are selected
  assert_text_constraints_checked("sender", "recipients", "subject");

  // con defaults, por favor
  await set_filter_text("foo");
  assert_messages_in_view([setSenderFoo, setRecipientsFoo, setSubjectFoo]);
  // note: we sequence the changes in the list so there is always at least one
  //  dude selected.  selecting down to nothing has potential UI implications
  //  we don't want this test to get affected by.
  // sender only
  await toggle_text_constraints("recipients", "subject");
  assert_messages_in_view(setSenderFoo);
  // recipients only
  await toggle_text_constraints("recipients", "sender");
  assert_messages_in_view(setRecipientsFoo);
  // subject only
  await toggle_text_constraints("subject", "recipients");
  assert_messages_in_view(setSubjectFoo);
  // body only
  await toggle_text_constraints("body", "subject");
  assert_messages_in_view(setBodyFoo);
  // everybody
  await toggle_text_constraints("sender", "recipients", "subject");
  assert_messages_in_view([
    setSenderFoo,
    setRecipientsFoo,
    setSubjectFoo,
    setBodyFoo,
  ]);

  // sanity check non-matching
  await set_filter_text("notgonnamatchevercauseisayso");
  assert_messages_in_view([]);
  // disable body, still should get nothing
  await toggle_text_constraints("body");
  assert_messages_in_view([]);

  // (we are leaving with the defaults once again active)
  assert_text_constraints_checked("sender", "recipients", "subject");
  teardownTest();
});

/**
 * Verify that sender text filtering also matches the display name from an
 * address book contact. This means that given a message from
 * "Joe Schmoe <reservations@example.com>" and an address book entry with the
 * display name "Hotel Paradise", searching for "Hotel" should match the
 * message even though the text does not appear in the message headers.
 */
add_task(async function test_filter_sender_display_name() {
  const whoHotel = ["Joe Schmoe", "reservations@example.com"];

  add_email_to_address_book(whoHotel[1], "Hotel Paradise");

  const folder = await create_folder("QuickFilterBarSenderDisplayName");

  const [, setSender] = await make_message_sets_in_folders(
    [folder],
    [{ count: 1 }, { count: 1, from: whoHotel }]
  );

  await be_in_folder(folder);

  await set_filter_text("Hotel");

  await toggle_text_constraints("recipients", "subject");

  assert_messages_in_view(setSender);

  teardownTest();
});

/**
 * Verify that the multi-word logic is actually splitting the words into
 *  different terms and that the terms can match in different predicates.
 *  This means that given "foo bar" we should be able to match "bar foo" in
 *  a subject and "foo" in the sender and "bar" in the recipient.  And that
 *  constitutes sufficient positive coverage, although we also want to make
 *  sure that just a single term match is insufficient.
 */
add_task(async function test_filter_text_multi_word() {
  const folder = await create_folder("QuickFilterBarTextMultiWord");

  const whoFoo = ["foo", "zabba@madeup.invalid"];
  const whoBar = ["zabba", "bar@madeup.invalid"];
  const [, setPeepMatch, setSubjReverse] = await make_message_sets_in_folders(
    [folder],
    [
      { count: 1 },
      { count: 1, from: whoFoo, to: [whoBar] },
      { count: 1, subject: "bar foo" },
      { count: 1, from: whoFoo },
    ]
  );
  await be_in_folder(folder);

  // (precondition)
  assert_text_constraints_checked("sender", "recipients", "subject");

  await set_filter_text("foo bar");
  assert_messages_in_view([setPeepMatch, setSubjReverse]);
  teardownTest();
});

/**
 * Verify that the quickfilter bar has OR functionality using
 * | (Pipe character) - Bug 586131
 */
add_task(async function test_filter_or_operator() {
  const folder = await create_folder("QuickFilterBarOrOperator");

  const whoFoo = ["foo", "zabba@madeup.invalid"];
  const whoBar = ["zabba", "bar@madeup.invalid"];
  const whoTest = ["test", "test@madeup.invalid"];
  const [setInert, setSenderFoo, setToBar, , , setSubject3, setMail1] =
    await make_message_sets_in_folders(
      [folder],
      [
        { count: 1 },
        { count: 1, from: whoFoo },
        { count: 1, to: [whoBar] },
        { count: 1, subject: "foo bar" },
        { count: 1, subject: "bar test" },
        { count: 1, subject: "test" },
        { count: 1, to: [whoTest], subject: "logic" },
        { count: 1, from: whoFoo, to: [whoBar], subject: "test" },
      ]
    );
  await be_in_folder(folder);

  assert_text_constraints_checked("sender", "recipients", "subject");
  await set_filter_text("foo | bar");
  assert_messages_not_in_view([setInert, setSubject3, setMail1]);

  await set_filter_text("test | bar");
  assert_messages_not_in_view([setInert, setSenderFoo]);

  await set_filter_text("foo | test");
  assert_messages_not_in_view([setInert, setToBar]);

  // consists of leading and trailing spaces and tab character.
  await set_filter_text("test     |   foo bar");
  assert_messages_not_in_view([
    setInert,
    setSenderFoo,
    setToBar,
    setSubject3,
    setMail1,
  ]);

  await set_filter_text("test | foo  bar |logic");
  assert_messages_not_in_view([setInert, setSenderFoo, setToBar, setSubject3]);
  teardownTest();
});

/**
 * Make sure that when dropping all constraints on toggle off or changing
 *  folders that we persist/propagate the state of the
 *  sender/recipients/subject/body toggle buttons.
 */
add_task(async function test_filter_text_constraints_propagate() {
  const whoFoo = ["foo", "zabba@madeup.invalid"];
  const whoBar = ["zabba", "bar@madeup.invalid"];

  const folderOne = await create_folder("QuickFilterBarTextPropagate1");
  const [setSubjFoo, setWhoFoo] = await make_message_sets_in_folders(
    [folderOne],
    [
      { count: 1, subject: "foo" },
      { count: 1, from: whoFoo },
    ]
  );
  const folderTwo = await create_folder("QuickFilterBarTextPropagate2");
  const [, setWhoBar] = await make_message_sets_in_folders(
    [folderTwo],
    [
      { count: 1, subject: "bar" },
      { count: 1, from: whoBar },
    ]
  );

  await be_in_folder(folderOne);
  await set_filter_text("foo");
  // (precondition)
  assert_text_constraints_checked("sender", "recipients", "subject");
  assert_messages_in_view([setSubjFoo, setWhoFoo]);

  // -- drop subject, close bar to reset, make sure it sticks
  await toggle_text_constraints("subject");
  assert_messages_in_view([setWhoFoo]);

  await toggle_quick_filter_bar();
  await toggle_quick_filter_bar();

  await set_filter_text("foo");
  assert_messages_in_view([setWhoFoo]);
  assert_text_constraints_checked("sender", "recipients");

  // -- now change folders and make sure the settings stick
  await be_in_folder(folderTwo);
  await set_filter_text("bar");
  assert_messages_in_view([setWhoBar]);
  assert_text_constraints_checked("sender", "recipients");
  teardownTest();
});

/**
 * The loading icon appears when a "searching" classname is attached to the
 * quick filter bar. It should disappear when the results are found. This test
 * runs successfully when there are messages in the folder being searched.
 */
add_task(async function test_loading_icon() {
  const folder = await create_folder("QuickFilterBarTextSingleWordLoading");
  const whoFoo = ["zabba", "foo@madeup.invalid"];
  await make_message_sets_in_folders(
    [folder],
    [
      { count: 1 },
      { count: 1, from: whoFoo },
      { count: 1, to: [whoFoo] },
      { count: 1, subject: "foo" },
      { count: 1, body: { body: "foo" } },
    ]
  );
  await be_in_folder(folder);

  const about3Pane = get_about_3pane();
  const searchBar = about3Pane.document.getElementById("qfb-qs-textbox");
  const eventPromise = BrowserTestUtils.waitForEvent(searchBar, "autocomplete");

  searchBar.focus();
  EventUtils.sendString("foo", searchBar.documentGlobal);
  await BrowserTestUtils.waitForMutationCondition(
    about3Pane.document.getElementById("quick-filter-bar"),
    { attributeFilter: ["class"] },
    () =>
      about3Pane.document
        .getElementById("quick-filter-bar")
        .classList.contains("searching")
  );

  const throbber = about3Pane.document.getElementById("qfb-searching-throbber");
  Assert.ok(
    BrowserTestUtils.isVisible(throbber),
    "Throbber should be visible during the search"
  );
  await eventPromise;
  Assert.ok(
    BrowserTestUtils.isHidden(throbber),
    "Throbber should be hidden during the search"
  );
});

/**
 * Here is what the results label does:
 * - No filter active: results label is not visible.
 * - Filter active, messages: it says the number of messages.
 * - Filter active, no messages: it says there are no messages.
 *
 * Additional nuances:
 * - The count needs to update as the user deletes messages or what not.
 */
add_task(async function test_results_label() {
  const folder = await create_folder("QuickFilterBarResultsLabel");
  const [setImmortal, setMortal, setGoldfish] =
    await make_message_sets_in_folders(
      [folder],
      [{ count: 1 }, { count: 1 }, { count: 1 }]
    );

  await be_in_folder(folder);

  // no filter, the label should not be visible
  Assert.ok(
    BrowserTestUtils.isHidden(
      get_about_3pane().document.getElementById("qfb-results-label")
    ),
    "results label should not be visible"
  );

  await toggle_boolean_constraints("unread");
  assert_messages_in_view([setImmortal, setMortal, setGoldfish]);
  assert_results_label_count(3);

  await delete_messages(setGoldfish);
  assert_results_label_count(2);

  await delete_messages(setMortal);
  assert_results_label_count(1);

  await delete_messages(setImmortal);
  assert_results_label_count(0);
  teardownTest();
});

function teardownTest() {
  clear_constraints();
}

const legacyQuickFilter = {};
const legacyGlobalText = "qflegacyoutside café";
const legacyLocalText = "qflegacylocalneedle";

add_setup(async function setupLegacyQuickFilterReference() {
  Assert.equal(
    Services.prefs.getBoolPref("mail.panorama.enabled", false),
    false
  );
  Assert.equal(
    Components.manager
      .QueryInterface(Ci.nsIComponentRegistrar)
      .contractIDToCID("@mozilla.org/msgDatabase/msgDBService;1")
      .toString(),
    "{03223c50-1e88-45e8-ba1a-7ce792dc3fc3}",
    "The Quick Filter reference uses the actual legacy backend"
  );
  const previousFolder = get_about_3pane().gFolder;
  const tabmail = document.getElementById("tabmail");
  const originalTabs = new Set(tabmail.tabInfo);
  const storeURL = "chrome://messenger/content/messenger.xhtml";
  const hadStickySetting = Services.xulStore.hasValue(
    storeURL,
    "quickFilterBarSticky",
    "enabled"
  );
  const previousStickySetting = Services.xulStore.getValue(
    storeURL,
    "quickFilterBarSticky",
    "enabled"
  );
  const { GlodaIndexer } = ChromeUtils.importESModule(
    "resource:///modules/gloda/GlodaIndexer.sys.mjs"
  );
  const previousIndexerEnabled = GlodaIndexer.enabled;
  await SpecialPowers.pushPrefEnv({
    set: [["mailnews.database.global.indexer.enabled", true]],
  });
  registerCleanupFunction(async () => {
    for (const tab of [...tabmail.tabInfo]) {
      if (!originalTabs.has(tab)) {
        tabmail.closeTab(tab);
      }
    }
    const panel = get_about_3pane().document.getElementById(
      "qfb-text-search-upsell"
    );
    if (panel.state != "closed") {
      const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
      panel.hidePopup();
      await hidden;
    }
    const origin = get_about_3pane();
    const bar = origin.document.getElementById("quick-filter-bar");
    const wasVisible = BrowserTestUtils.isVisible(bar);
    clear_constraints();
    await be_in_folder(previousFolder);
    if (BrowserTestUtils.isVisible(bar) != wasVisible) {
      await toggle_quick_filter_bar();
    }
    for (const folder of [
      legacyQuickFilter.origin,
      legacyQuickFilter.outside,
    ]) {
      if (folder) {
        folder.parent.propagateDelete(folder, true);
      }
    }
    if (hadStickySetting) {
      Services.xulStore.setValue(
        storeURL,
        "quickFilterBarSticky",
        "enabled",
        previousStickySetting
      );
    } else {
      Services.xulStore.removeValue(
        storeURL,
        "quickFilterBarSticky",
        "enabled"
      );
    }
    // The preference is read at startup; restore the real runtime state too.
    GlodaIndexer.enabled = previousIndexerEnabled;
    await SpecialPowers.popPrefEnv();
  });

  const { Gloda } = ChromeUtils.importESModule(
    "resource:///modules/gloda/GlodaPublic.sys.mjs"
  );
  const { GlodaMsgIndexer } = ChromeUtils.importESModule(
    "resource:///modules/gloda/IndexMsg.sys.mjs"
  );
  legacyQuickFilter.indexer = GlodaIndexer;
  legacyQuickFilter.origin = await create_folder("LegacyQFOrigin");
  legacyQuickFilter.outside = await create_folder("LegacyQFOutside");
  const [local] = await make_message_sets_in_folders(
    [legacyQuickFilter.origin],
    [{ count: 1, subject: legacyLocalText }]
  );
  const [outside] = await make_message_sets_in_folders(
    [legacyQuickFilter.outside],
    [{ count: 1, subject: legacyGlobalText }]
  );
  outside.setRead(true);
  legacyQuickFilter.local = local.getMsgHdr(0);
  legacyQuickFilter.target = outside.getMsgHdr(0);
  Assert.ok(legacyQuickFilter.local);
  Assert.ok(legacyQuickFilter.target);
  Assert.notEqual(
    legacyQuickFilter.local.folder.URI,
    legacyQuickFilter.target.folder.URI,
    "The only global hit is physically outside the local filter scope"
  );
  for (const folder of [legacyQuickFilter.origin, legacyQuickFilter.outside]) {
    const indexed = await new Promise(resolve => {
      Assert.ok(
        GlodaMsgIndexer.indexFolder(folder, { force: true, callback: resolve })
      );
    });
    Assert.ok(indexed, "The production Gloda indexer indexed the real folder");
  }
  await TestUtils.waitForCondition(
    () => Gloda.isMessageIndexed(legacyQuickFilter.target),
    "The outside physical message is indexed before typing the local filter"
  );
});

/**
 * Returns the physical location of a real message header.
 *
 * @param {nsIMsgDBHdr} header - The message header.
 * @returns {[string, number]} Its folder URI and local message key.
 */
function legacyQuickFilterLocation(header) {
  return [header.folder.URI, header.messageKey];
}

/**
 * Escalates the real local filter and checks its global result and origin state.
 *
 * @param {boolean} showAsList - Whether the existing list preference is enabled.
 * @returns {Promise<void>} Resolves after the results tab closes and state checks.
 */
async function checkLegacyQuickFilterEscalation(showAsList) {
  await be_in_folder(legacyQuickFilter.origin);
  clear_constraints();
  await wait_for_all_messages_to_load();
  await toggle_boolean_constraints("sticky", "unread");
  const origin = get_about_3pane();
  const input = origin.document.getElementById("qfb-qs-textbox");
  const panel = origin.document.getElementById("qfb-text-search-upsell");
  input.focus();
  const shown = BrowserTestUtils.waitForPopupEvent(panel, "shown");
  await set_filter_text(legacyGlobalText);
  await shown;
  Assert.equal(origin.gDBView.numMsgsInView, 0, "No local message matches");
  assert_results_label_count(0);
  Assert.deepEqual(
    origin.document.l10n.getAttributes(
      origin.document.getElementById("qfb-upsell-line-two")
    ),
    {
      id: "quick-filter-bar-gloda-upsell-line2",
      args: { text: legacyGlobalText },
    }
  );
  const state = structuredClone(origin.quickFilterBar.filterer.filterValues);
  Assert.equal(state.sticky, true);
  Assert.equal(state.unread, true);
  Assert.equal(state.text.text, legacyGlobalText);
  const tabmail = document.getElementById("tabmail");
  const originTab = tabmail.currentTabInfo;
  const tabCount = tabmail.tabInfo.length;
  const mode = showAsList ? "mail3PaneTab" : "glodaFacet";
  await SpecialPowers.pushPrefEnv({
    set: [["gloda.show_as_list_by_default", showAsList]],
  });
  let results;
  try {
    const opened = BrowserTestUtils.waitForEvent(
      tabmail.tabContainer,
      "TabOpen",
      false,
      event => event.detail.tabInfo.mode.name == mode
    );
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    EventUtils.synthesizeKey("KEY_Enter", {}, origin);
    results = (await opened).detail.tabInfo;
    await hidden;
    const expected = legacyQuickFilterLocation(legacyQuickFilter.target);
    if (showAsList) {
      await TestUtils.waitForCondition(
        () =>
          results.chromeBrowser.contentWindow.gViewWrapper?.isSynthetic &&
          results.chromeBrowser.contentWindow.gDBView?.numMsgsInView == 1,
        "The real global query loads its one-message synthetic result view"
      );
      const view = results.chromeBrowser.contentWindow.gDBView;
      Assert.equal(view.rowCount, 1);
      Assert.deepEqual(
        legacyQuickFilterLocation(view.getMsgHdrAt(0)),
        expected
      );
      await BrowserTestUtils.waitForMutationCondition(
        results.tabNode,
        { attributes: true, childList: true, subtree: true },
        () => results.title == legacyGlobalText
      );
      Assert.equal(
        results.title,
        legacyGlobalText,
        "The list keeps the exact query"
      );
    } else {
      await TestUtils.waitForCondition(
        () => results.browser?.contentWindow.FacetContext?.everFaceted,
        "The production facet query has completed"
      );
      const context = results.browser.contentWindow.FacetContext;
      Assert.equal(context.fullSet.length, 1);
      Assert.deepEqual(
        context.fullSet.map(item =>
          legacyQuickFilterLocation(item.folderMessage)
        ),
        [expected]
      );
      const cards = results.browser.contentDocument.querySelectorAll(
        "facet-result-message"
      );
      Assert.equal(cards.length, 1);
      Assert.deepEqual(
        legacyQuickFilterLocation(cards[0].message.folderMessage),
        expected
      );
      Assert.equal(results.searchString, legacyGlobalText);
      Assert.equal(results.searcher.searchString, legacyGlobalText);
    }
    Assert.equal(
      tabmail.tabInfo.length,
      tabCount + 1,
      "One final results tab opens"
    );
    Assert.equal(tabmail.currentTabInfo, results);
    tabmail.closeTab(results);
    Assert.equal(tabmail.currentTabInfo, originTab);
    Assert.equal(origin.gFolder.URI, legacyQuickFilter.origin.URI);
    Assert.equal(
      input.value,
      legacyGlobalText,
      "Closing search keeps the filter text"
    );
    Assert.deepEqual(origin.quickFilterBar.filterer.filterValues, state);
    Assert.equal(origin.document.getElementById("qfb-sticky").pressed, true);
    Assert.equal(origin.document.getElementById("qfb-unread").pressed, true);
    Assert.equal(origin.gDBView.numMsgsInView, 0);
    Assert.equal(panel.state, "closed");
  } finally {
    if (results && tabmail.tabInfo.includes(results)) {
      tabmail.closeTab(results);
    }
    clear_constraints();
    await wait_for_all_messages_to_load();
    await SpecialPowers.popPrefEnv();
  }
}

add_task(async function test_legacyQuickFilterFacetEscalation() {
  await checkLegacyQuickFilterEscalation(false);
});

add_task(async function test_legacyQuickFilterListEscalation() {
  await checkLegacyQuickFilterEscalation(true);
});

add_task(async function test_legacyQuickFilterUpsellSuppression() {
  await be_in_folder(legacyQuickFilter.origin);
  clear_constraints();
  await wait_for_all_messages_to_load();
  const origin = get_about_3pane();
  const input = origin.document.getElementById("qfb-qs-textbox");
  const panel = origin.document.getElementById("qfb-text-search-upsell");
  input.focus();
  const shown = BrowserTestUtils.waitForPopupEvent(panel, "shown");
  await set_filter_text(legacyGlobalText);
  await shown;
  await SpecialPowers.pushPrefEnv({
    set: [["mailnews.database.global.indexer.enabled", false]],
  });
  // Legacy Gloda reads the preference at startup. Disable its actual indexer
  // through the production API as well; changing the preference alone is not
  // evidence that indexing has stopped.
  const wasEnabled = legacyQuickFilter.indexer.enabled;
  legacyQuickFilter.indexer.enabled = false;
  try {
    Assert.equal(legacyQuickFilter.indexer.enabled, false);
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    await set_filter_text(legacyGlobalText + " absent");
    await hidden;
    Assert.equal(origin.gDBView.numMsgsInView, 0);
    Assert.equal(
      panel.state,
      "closed",
      "Disabled indexer suppresses the upsell"
    );
  } finally {
    legacyQuickFilter.indexer.enabled = wasEnabled;
    await SpecialPowers.popPrefEnv();
  }
  Assert.equal(legacyQuickFilter.indexer.enabled, true);
  await set_filter_text("");
  Assert.equal(input.value, "");
  Assert.equal(origin.gDBView.numMsgsInView, 1);
  Assert.equal(panel.state, "closed", "Empty text suppresses the upsell");
  await set_filter_text(legacyLocalText);
  Assert.equal(origin.gDBView.numMsgsInView, 1);
  Assert.deepEqual(
    legacyQuickFilterLocation(origin.gDBView.getMsgHdrAt(0)),
    legacyQuickFilterLocation(legacyQuickFilter.local)
  );
  Assert.equal(
    panel.state,
    "closed",
    "An actual local hit suppresses the upsell"
  );
  clear_constraints();
  await wait_for_all_messages_to_load();
});
