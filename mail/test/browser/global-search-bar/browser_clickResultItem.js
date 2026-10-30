/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

if (AppConstants.platform == "macosx") {
  requestLongerTimeout(2);
}
const { be_in_folder, create_folder } = ChromeUtils.importESModule(
  "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
);
const { inboxFolder, make_message_sets_in_folders } =
  ChromeUtils.importESModule(
    "resource://testing-common/mail/MessageInjectionHelpers.sys.mjs"
  );

const { GlodaIndexer } = ChromeUtils.importESModule(
  "resource:///modules/gloda/GlodaIndexer.sys.mjs"
);
const { GlodaMsgIndexer } = ChromeUtils.importESModule(
  "resource:///modules/gloda/IndexMsg.sys.mjs"
);

let folder;

/**
 * Tests the 3 global search bars found in the UI:
 * 1) The one on the mail tab.
 * 2) The one in the search result tab.
 */
const tests = [
  {
    selector: "#unifiedToolbarContent .search-bar global-search-bar",
    isNewSearchBar: true,
    tabCountBefore: 1,
    tabCountAfter: 2,
  },
  {
    selector: ".remote-gloda-search",
    tabCountBefore: 2,
    async before() {
      // Run a search so we can search from the results tab.
      const input = document.querySelector(
        "#unifiedToolbarContent .search-bar"
      );
      EventUtils.synthesizeMouseAtCenter(input, {}, input.documentGlobal);
      EventUtils.sendString("us", input.documentGlobal);
      EventUtils.synthesizeKey("KEY_Enter", {}, input.documentGlobal);

      await TestUtils.waitForCondition(
        () =>
          window.document.getElementById("tabmail").selectedTab.browser &&
          window.document.getElementById("tabmail").selectedTab.browser.src ==
            "chrome://messenger/content/glodaFacetView.xhtml",
        "search result tab did not open in time"
      );
    },
    tabCountAfter: 3,
  },
];

/**
 * Tests clicking on an item in the various global search bars opens one tab
 * only. See bug 1679113.
 */
add_task(async function testClickingGlobalSearchResultItemOpensOneTab() {
  window.focus();
  folder = await create_folder("SearchedFolder");
  await be_in_folder(folder);
  await make_message_sets_in_folders(
    [folder],
    [
      { from: ["User", "user@example.com"] },
      { from: ["User", "user@example.com"] },
      { from: ["User", "user@example.com"] },
    ]
  );
  Assert.equal(
    [...folder.messages].length,
    30,
    "should have 30 msgs in folder"
  );
  await TestUtils.waitForTick();

  const shouldIndex = GlodaMsgIndexer.indexFolder(folder, {
    force: true,
  });
  Assert.ok(shouldIndex, "should index the folder");

  await TestUtils.waitForCondition(
    () => !GlodaIndexer.indexing,
    "waiting for Gloda to finish indexing",
    3000
  );
  Assert.report(false, undefined, undefined, "We have an indexed folder now.");

  const tabmail = window.document.getElementById("tabmail");
  for (const test of tests) {
    info(`Running test with selector ${test.selector}`);
    while (tabmail.tabInfo.length > 1) {
      tabmail.closeTab(1);
    }

    if (test.before) {
      await test.before();
    }

    Assert.equal(
      tabmail.tabInfo.length,
      test.tabCountBefore,
      "tab count is as expected before"
    );

    const input = document.querySelector(test.selector);
    if (test.isNewSearchBar) {
      input.reset();
    } else {
      input.value = "";
    }
    input.focus();

    const popup = document.getElementById("PopupGlodaAutocomplete");
    const popupShown = BrowserTestUtils.waitForPopupEvent(popup, "shown");

    EventUtils.synthesizeKey("u", {}, input.documentGlobal);
    EventUtils.synthesizeKey("s", {}, input.documentGlobal);
    EventUtils.synthesizeKey("e", {}, input.documentGlobal);

    await TestUtils.waitForCondition(
      () => input.controller.matchCount > 0,
      `"${test.selector}" did not find any matches`
    );
    await popupShown;

    const target = document.querySelector(
      "#PopupGlodaAutocomplete > richlistbox > richlistitem"
    );
    Assert.ok(target, "target item to click found");
    EventUtils.synthesizeMouseAtCenter(target, {}, target.documentGlobal);

    // Give any potentially extra tabs time to appear.
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    await new Promise(resolve => window.setTimeout(resolve, 1000));

    Assert.equal(
      tabmail.tabInfo.length,
      test.tabCountAfter,
      "tab count is as expected after"
    );
    Assert.equal(
      tabmail.selectedTab.browser.src,
      "chrome://messenger/content/glodaFacetView.xhtml",
      "current tab is the search results tab"
    );
  }
});

registerCleanupFunction(async function () {
  const tabmail = window.document.getElementById("tabmail");
  tabmail.selectTabByMode("mail3PaneTab");
  await be_in_folder(inboxFolder);
  folder.deleteSelf(null);
  while (tabmail.tabInfo.length > 1) {
    tabmail.closeTab(1);
  }
});

const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { Gloda } = ChromeUtils.importESModule(
  "resource:///modules/gloda/GlodaPublic.sys.mjs"
);
const { GlodaConstants } = ChromeUtils.importESModule(
  "resource:///modules/gloda/GlodaConstants.sys.mjs"
);
const { GlodaMsgSearcher } = ChromeUtils.importESModule(
  "resource:///modules/gloda/GlodaMsgSearcher.sys.mjs"
);
const { MessageGenerator, SyntheticMessageSet } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { add_message_sets_to_folders } = ChromeUtils.importESModule(
  "resource://testing-common/mail/MessageInjectionHelpers.sys.mjs"
);

const legacyCompletion = {
  headers: {},
  primary: "alpha.autocomplete@example.invalid",
  secondary: "beta.autocomplete@example.invalid",
  name: "Qzalpha Áurelia",
  renamed: "Qzrenamed Élodie",
  category: "Zzfriend",
};

add_setup(async function setupLegacyCompletionReference() {
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
    "The reference uses the actual retained Mork backend"
  );
  const previousEnabled = GlodaIndexer.enabled;
  await SpecialPowers.pushPrefEnv({
    set: [
      ["mailnews.database.global.indexer.enabled", true],
      ["gloda.facetview.sortby", 1],
      ["mailnews.database.global.search.msg.limit", 100],
    ],
  });
  const pref = MailServices.ab.newAddressBook(
    "Legacy autocomplete reference",
    null,
    Ci.nsIAbManager.JS_DIRECTORY_TYPE
  );
  const book = (legacyCompletion.book =
    MailServices.ab.getDirectoryFromId(pref));
  legacyCompletion.card = addLegacyCompletionCard(
    legacyCompletion.name,
    legacyCompletion.primary,
    legacyCompletion.secondary
  );
  addLegacyCompletionCard("山田 太郎", "cjk.autocomplete@example.invalid");
  legacyCompletion.folder = await create_folder("LegacyCompletionReference");
  registerCleanupFunction(async () => {
    const tabmail = document.getElementById("tabmail");
    while (tabmail.tabInfo.length > 1) {
      tabmail.closeTab(1);
    }
    const provider = getLegacyCompletionProvider();
    if (provider.curResult) {
      provider.stopSearch();
    }
    document.querySelector("global-search-bar").reset();
    document.getElementById("PopupGlodaAutocomplete").closePopup();
    await be_in_folder(inboxFolder);
    legacyCompletion.folder.parent.propagateDelete(
      legacyCompletion.folder,
      true
    );
    const deleted = TestUtils.topicObserved(
      "addrbook-directory-deleted",
      subject => subject.QueryInterface(Ci.nsIAbDirectory).URI == book.URI
    );
    MailServices.ab.deleteAddressBook(book.URI);
    await deleted;
    GlodaIndexer.enabled = previousEnabled;
    await SpecialPowers.popPrefEnv();
  });
  const primary = [legacyCompletion.name, legacyCompletion.primary];
  const secondary = [legacyCompletion.name, legacyCompletion.secondary];
  const other = ["Other Person", "other.autocomplete@example.invalid"];
  const definitions = {
    A: { from: primary, to: [other], date: new Date(2020, 0, 10, 12) },
    B: { from: other, to: [primary], date: new Date(2020, 2, 10, 12) },
    C: { from: secondary, to: [other], date: new Date(2020, 1, 10, 12) },
    D: {
      from: other,
      to: [["Unrelated", "unrelated@example.invalid"]],
      date: new Date(2020, 3, 10, 12),
    },
    E: {
      from: ["山田 太郎", "cjk.autocomplete@example.invalid"],
      to: [other],
      date: new Date(2019, 11, 10, 12),
    },
  };
  const generator = new MessageGenerator();
  await add_message_sets_to_folders(
    [legacyCompletion.folder],
    [
      new SyntheticMessageSet(
        Object.entries(definitions).map(([name, definition]) =>
          generator.makeMessage({
            ...definition,
            subject: "Completion fixture " + name,
            body: { body: "legacycompletionfixture" },
          })
        )
      ),
    ]
  );
  for (const header of legacyCompletion.folder.messages) {
    const name = header.subject.slice(-1);
    legacyCompletion.headers[name] = header;
    if (["A", "C"].includes(name)) {
      legacyCompletion.folder.addKeywordsToMessages([header], "$label1");
    }
  }
  const indexed = await new Promise(resolve => {
    Assert.ok(
      GlodaMsgIndexer.indexFolder(legacyCompletion.folder, {
        force: true,
        callback: resolve,
      })
    );
  });
  Assert.ok(indexed);
  for (const header of Object.values(legacyCompletion.headers)) {
    Assert.ok(Gloda.isMessageIndexed(header));
  }
  legacyCompletion.tag = MailServices.tags.getTagForKey("$label1");
});

/**
 * Adds a real card with its supported Categories and optional second email.
 *
 * @param {string} name - The card display name.
 * @param {string} email - The primary address.
 * @param {string} [second] - The secondary address.
 * @returns {nsIAbCard} The stored card.
 */
function addLegacyCompletionCard(name, email, second) {
  const card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
    Ci.nsIAbCard
  );
  card.displayName = name;
  card.primaryEmail = email;
  if (second) {
    card.setProperty("SecondEmail", second);
  }
  card.setProperty("Categories", legacyCompletion.category);
  return legacyCompletion.book.addCard(card);
}

/** @returns {object} The actual registered legacy completion service. */
function getLegacyCompletionProvider() {
  const provider = Cc[
    "@mozilla.org/autocomplete/search;1?name=gloda"
  ].getService(Ci.nsIAutoCompleteSearch).wrappedJSObject;
  Assert.ok(!provider.isNativeMailSearch);
  return provider;
}

/**
 * Types into the actual input and waits for its production completion request.
 *
 * @param {HTMLElement} input - The toolbar or retained result-tab input.
 * @param {string} text - The literal input text.
 * @param {boolean} [complete=true] - Whether to await the real contact queries.
 * @returns {Promise<object>} The actual service result.
 */
async function typeLegacyCompletion(input, text, complete = true) {
  const provider = getLegacyCompletionProvider();
  if (provider.curResult) {
    provider.stopSearch();
  }
  if (input.localName == "global-search-bar") {
    input.reset();
  } else {
    input.value = "";
  }
  input.focus();
  if (input.localName == "global-search-bar") {
    // The browser event helper resolves on a later task, after the real
    // contact query may finish. Resolve here to cancel an outstanding query
    // without delaying or replacing the production backend.
    const changed = new Promise(resolve => {
      const started = event => {
        if (event.detail != text) {
          return;
        }
        input.removeEventListener("autocomplete", started);
        resolve();
      };
      input.addEventListener("autocomplete", started);
    });
    EventUtils.sendString(text, input.documentGlobal);
    await changed;
  } else {
    Assert.equal(
      input.controller.input.wrappedJSObject,
      input.nsIAutocompleteInput,
      "The actual result input owns the formal autocomplete controller"
    );
    EventUtils.sendString(text, input.documentGlobal);
    Assert.equal(
      input.value,
      text,
      "Real typing reaches the selected result input"
    );
    await TestUtils.waitForCondition(
      () => provider.curResult?.searchString == text,
      `The actual retained result input requested ${text}`
    );
  }
  const result = provider.curResult;
  Assert.equal(result.searchString, text);
  if (complete) {
    await TestUtils.waitForCondition(
      () => result._pendingCount == 0,
      "Real contact and identity queries completed"
    );
  }
  return result;
}

/**
 * Returns the actual rows without treating labels as typed identities.
 *
 * @param {object} result - The registered service result.
 * @returns {object[]} Its completion rows.
 */
function legacyCompletionRows(result) {
  return Array.from({ length: result.matchCount }, (_, index) =>
    result.getObjectAt(index)
  );
}

/**
 * Returns an independent physical message location.
 *
 * @param {nsIMsgDBHdr} header - The real header.
 * @returns {[string, number]} The folder URI and message key.
 */
function legacyCompletionLocation(header) {
  return [header.folder.URI, header.messageKey];
}

/**
 * Checks the final real result membership and retained date order.
 *
 * @param {object} tab - The opened result tab.
 * @param {boolean} showAsList - Whether the existing list preference is true.
 * @param {string[]} names - Expected fixture names in descending date order.
 * @returns {Promise<void>} Resolves after all physical rows are checked.
 */
async function assertLegacyCompletionResults(tab, showAsList, names) {
  const expected = names.map(name =>
    legacyCompletionLocation(legacyCompletion.headers[name])
  );
  if (showAsList) {
    await TestUtils.waitForCondition(
      () =>
        tab.chromeBrowser?.contentWindow.gViewWrapper?.isSynthetic &&
        tab.chromeBrowser.contentWindow.gDBView?.numMsgsInView == names.length
    );
    const view = tab.chromeBrowser.contentWindow.gDBView;
    Assert.equal(view.rowCount, names.length);
    Assert.deepEqual(
      Array.from({ length: view.rowCount }, (_, i) =>
        legacyCompletionLocation(view.getMsgHdrAt(i))
      ),
      expected
    );
  } else {
    await TestUtils.waitForCondition(
      () => tab.browser?.contentWindow.FacetContext?.everFaceted
    );
    const context = tab.browser.contentWindow.FacetContext;
    Assert.deepEqual(
      context.fullSet.map(message =>
        legacyCompletionLocation(message.folderMessage)
      ),
      expected
    );
    Assert.deepEqual(
      Array.from(
        tab.browser.contentDocument.querySelectorAll("facet-result-message"),
        card => legacyCompletionLocation(card.message.folderMessage)
      ),
      expected
    );
  }
}

add_task(async function test_legacyCompletionKindsAndThresholds() {
  const input = document.querySelector("global-search-bar");
  for (const [text, kind, present] of [
    ["qz", "identity", false],
    ["qza", "identity", true],
    ["山", "identity", true],
    ["áur", "identity", true],
    [legacyCompletion.tag.slice(0, 1), "tag", false],
    [legacyCompletion.tag.slice(0, 2), "tag", true],
    ["xxz", "fullText", false],
    ["xxzz", "fullText", true],
  ]) {
    const rows = legacyCompletionRows(await typeLegacyCompletion(input, text));
    Assert.equal(
      rows.some(row =>
        kind == "fullText" ? row.fullText : row.nounDef?.name == kind
      ),
      present,
      `${text} has the retained ${kind} threshold`
    );
    const contacts = rows
      .filter(row => row.nounDef?.name == "identity")
      .map(row => row.item.contactID);
    Assert.equal(
      new Set(contacts).size,
      contacts.length,
      "Name and email matches deduplicate by actual contact"
    );
  }
  const rows = legacyCompletionRows(await typeLegacyCompletion(input, "zz"));
  const group = rows.find(
    row => row.multi && row.criteria == legacyCompletion.category
  );
  Assert.ok(
    group,
    "Real card Categories supplies the supported contact-tag group"
  );
  Assert.equal(group.nounDef.name, "contact");
  await TestUtils.waitForCondition(() => group.collection.items.length == 3);
  Assert.deepEqual(
    group.collection.items
      .flatMap(contact => contact.identities.map(identity => identity.value))
      .sort(),
    [
      legacyCompletion.primary,
      legacyCompletion.secondary,
      "cjk.autocomplete@example.invalid",
    ].sort()
  );
  input.reset();
});

/**
 * Selects real typed identity/tag rows with both actual retained inputs.
 *
 * @param {boolean} showAsList - The existing results preference value.
 * @returns {Promise<void>} Resolves after the four routes return to the origin.
 */
async function checkLegacyCompletionSelections(showAsList) {
  const tabmail = document.getElementById("tabmail");
  await SpecialPowers.pushPrefEnv({
    set: [["gloda.show_as_list_by_default", showAsList]],
  });
  try {
    for (const [remote, kind, keyboard] of [
      [false, "identity", false],
      [false, "tag", true],
      [true, "identity", true],
      [true, "tag", false],
    ]) {
      info(
        `Retained completion selection: list=${showAsList}, remote=${remote}, kind=${kind}, keyboard=${keyboard}`
      );
      let host;
      let resultTab;
      try {
        if (remote) {
          host = tabmail.openTab("glodaFacet", {
            searcher: new GlodaMsgSearcher(null, "legacycompletionfixture"),
          });
          await TestUtils.waitForCondition(
            () => host.browser?.contentWindow.FacetContext?.everFaceted,
            "The actual retained result-input host completes its facet query"
          );
        }
        const input = remote
          ? host.panel.querySelector(".remote-gloda-search")
          : document.querySelector("global-search-bar");
        Assert.ok(input);
        const result = await typeLegacyCompletion(
          input,
          kind == "identity" ? legacyCompletion.primary : legacyCompletion.tag
        );
        const rows = legacyCompletionRows(result);
        const index = rows.findIndex(
          row =>
            row.nounDef?.name == kind &&
            (kind == "identity"
              ? row.item.value == legacyCompletion.primary
              : row.item.key == "$label1")
        );
        Assert.greaterOrEqual(index, 0, "The real typed row exists");
        const popup = document.getElementById("PopupGlodaAutocomplete");
        await TestUtils.waitForCondition(
          () => popup.state == "open",
          `Actual ${kind} popup opens: list=${showAsList}, remote=${remote}`
        );
        const count = tabmail.tabInfo.length;
        const mode = showAsList ? "mail3PaneTab" : "glodaFacet";
        const opened = BrowserTestUtils.waitForEvent(
          tabmail.tabContainer,
          "TabOpen",
          false,
          event => event.detail.tabInfo.mode.name == mode
        );
        if (keyboard) {
          popup.selectedIndex = -1;
          for (let i = 0; i <= index; i++) {
            EventUtils.synthesizeKey("KEY_ArrowDown", {}, input.documentGlobal);
          }
          Assert.equal(popup.selectedIndex, index);
          EventUtils.synthesizeKey("KEY_Enter", {}, input.documentGlobal);
        } else {
          const item = popup.richlistbox.getItemAtIndex(index);
          item.scrollIntoView({ block: "nearest" });
          EventUtils.synthesizeMouseAtCenter(item, {}, item.documentGlobal);
        }
        resultTab = (await opened).detail.tabInfo;
        await assertLegacyCompletionResults(
          resultTab,
          showAsList,
          kind == "identity" ? ["B", "A"] : ["C", "A"]
        );
        Assert.equal(
          tabmail.tabInfo.length,
          count + 1,
          "Exactly one final result tab opens"
        );
        Assert.equal(tabmail.currentTabInfo, resultTab);
      } finally {
        if (resultTab && tabmail.tabInfo.includes(resultTab)) {
          tabmail.closeTab(resultTab);
        }
        if (host && tabmail.tabInfo.includes(host)) {
          tabmail.closeTab(host);
        }
      }
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
}

add_task(async function test_legacyCompletionSelectionFacet() {
  await checkLegacyCompletionSelections(false);
});

add_task(async function test_legacyCompletionSelectionList() {
  await checkLegacyCompletionSelections(true);
});

add_task(async function test_legacyCompletionCancellation() {
  const provider = getLegacyCompletionProvider();
  const delivered = [];
  const listener = {
    onSearchResult(_provider, result) {
      delivered.push(result);
    },
  };
  provider.startSearch("qza", "global", null, listener);
  const old = provider.curResult;
  Assert.greater(
    old._pendingCount,
    0,
    "The first real contact query is outstanding"
  );
  provider.startSearch("山", "global", null, listener);
  const current = provider.curResult;
  const start = delivered.length;
  Assert.equal(old.active, false, "A superseded request stops delivery");
  await TestUtils.waitForCondition(
    () => old._pendingCount == 0 && current._pendingCount == 0
  );
  Assert.ok(
    delivered.slice(start).every(result => result == current),
    "Real old-query completion is not published"
  );
  provider.stopSearch();
  const input = document.querySelector("global-search-bar");
  const popup = document.getElementById("PopupGlodaAutocomplete");
  for (const action of ["clear", "escape", "blur", "cancel"]) {
    const result = await typeLegacyCompletion(input, "qza", false);
    Assert.greater(
      result._pendingCount,
      0,
      `${action} reaches an outstanding real contact query`
    );
    if (action == "clear") {
      input.reset();
    } else if (action == "escape") {
      EventUtils.synthesizeKey("KEY_Escape", {}, input.documentGlobal);
    } else if (action == "blur") {
      document.getElementById("button-appmenu").focus();
    } else {
      input.controller.stopSearch();
      popup.closePopup();
    }
    Assert.equal(result.active, false, `${action} stops delivery`);
    await TestUtils.waitForCondition(() => result._pendingCount == 0);
    await TestUtils.waitForCondition(
      () => popup.state == "closed",
      `${action} must not reopen the popup`
    );
    if (action == "clear") {
      Assert.equal(input.value, "");
      Assert.equal(input.controller.matchCount, 0);
    }
  }
  input.reset();
});

add_task(async function test_legacyAddressBookNamesAndIdentityRefresh() {
  const query = Gloda.newQuery(GlodaConstants.NOUN_IDENTITY);
  query
    .kind("email")
    .value(legacyCompletion.primary, legacyCompletion.secondary);
  const collection = await new Promise(resolve =>
    query.getCollection({
      onItemsAdded() {},
      onItemsModified() {},
      onItemsRemoved() {},
      onQueryCompleted: resolve,
    })
  );
  Assert.equal(collection.items.length, 2);
  Assert.deepEqual(
    collection.items.map(identity => identity.value).sort(),
    [legacyCompletion.primary, legacyCompletion.secondary].sort()
  );
  for (const identity of collection.items) {
    Assert.equal(identity.inAddressBook, true);
    Assert.equal(identity.contact.name, legacyCompletion.name);
  }
  const deleted = TestUtils.topicObserved(
    "addrbook-contact-deleted",
    subject =>
      subject.QueryInterface(Ci.nsIAbCard).UID == legacyCompletion.card.UID
  );
  legacyCompletion.book.deleteCards([legacyCompletion.card]);
  await deleted;
  for (const identity of collection.items) {
    Assert.equal(
      identity.inAddressBook,
      false,
      "Deleting the real card clears each cached identity association"
    );
    Assert.equal(
      identity.contact.name,
      legacyCompletion.name,
      "Historical indexed contacts remain after card deletion"
    );
  }
  legacyCompletion.card = addLegacyCompletionCard(
    legacyCompletion.name,
    legacyCompletion.primary,
    legacyCompletion.secondary
  );
  for (const identity of collection.items) {
    Assert.equal(
      identity.inAddressBook,
      true,
      "Adding the card refreshes each cached identity association"
    );
  }
  const updated = TestUtils.topicObserved(
    "addrbook-contact-updated",
    subject =>
      subject.QueryInterface(Ci.nsIAbCard).UID == legacyCompletion.card.UID
  );
  legacyCompletion.card.displayName = legacyCompletion.renamed;
  legacyCompletion.book.modifyCard(legacyCompletion.card);
  await updated;
  await TestUtils.waitForCondition(
    () =>
      collection.items.some(
        identity => identity.contact.name == legacyCompletion.renamed
      ),
    "The actual card update changes an observed Gloda contact name"
  );
  await TestUtils.waitForCondition(() => !GlodaIndexer.indexing);
  for (const identity of collection.items) {
    Assert.equal(
      identity.contact.name,
      legacyCompletion.renamed,
      "Both physical email identities refresh from the real card"
    );
  }
  const input = document.querySelector("global-search-bar");
  const renamedRows = legacyCompletionRows(
    await typeLegacyCompletion(input, "qzren")
  );
  Assert.deepEqual(
    renamedRows
      .filter(row => row.nounDef?.name == "identity")
      .map(row => row.item.value)
      .sort(),
    [legacyCompletion.primary, legacyCompletion.secondary].sort()
  );
  const oldRows = legacyCompletionRows(
    await typeLegacyCompletion(input, "qzalpha")
  );
  Assert.equal(
    oldRows.filter(row => row.nounDef?.name == "identity").length,
    0,
    "The old name no longer yields stale suggestions"
  );
  input.reset();
});

add_task(async function test_legacyAddressBookSearchOr() {
  const tabmail = document.getElementById("tabmail");
  let addressTab;
  const abWindow = await new Promise(resolve => {
    addressTab = tabmail.openTab("addressBookTab", {
      onLoad(_event, browser) {
        resolve(browser.contentWindow);
      },
    });
  });
  try {
    await TestUtils.waitForCondition(
      () => abWindow.booksList && abWindow.cardsPane?.cardsList?.isReady
    );
    const bookRow = abWindow.booksList.getRowForUID(legacyCompletion.book.UID);
    EventUtils.synthesizeMouseAtCenter(
      bookRow.querySelector("span"),
      {},
      abWindow
    );
    const cards = abWindow.cardsPane.cardsList;
    await TestUtils.waitForCondition(
      () =>
        cards.isReady &&
        cards.view.getIndexForUID(legacyCompletion.card.UID) >= 0
    );
    EventUtils.synthesizeMouseAtCenter(
      cards.getRowAtIndex(cards.view.getIndexForUID(legacyCompletion.card.UID)),
      {},
      abWindow
    );
    const button = abWindow.document.getElementById("detailsSearchButton");
    await TestUtils.waitForCondition(() => BrowserTestUtils.isVisible(button));
    Assert.deepEqual(legacyCompletion.card.emailAddresses, [
      legacyCompletion.primary,
      legacyCompletion.secondary,
    ]);
    for (const showAsList of [false, true]) {
      await SpecialPowers.pushPrefEnv({
        set: [["gloda.show_as_list_by_default", showAsList]],
      });
      let results;
      try {
        const count = tabmail.tabInfo.length;
        const opened = BrowserTestUtils.waitForEvent(
          tabmail.tabContainer,
          "TabOpen",
          false,
          event =>
            event.detail.tabInfo.mode.name ==
            (showAsList ? "mail3PaneTab" : "glodaFacet")
        );
        EventUtils.synthesizeMouseAtCenter(button, {}, abWindow);
        results = (await opened).detail.tabInfo;
        await assertLegacyCompletionResults(results, showAsList, [
          "B",
          "C",
          "A",
        ]);
        Assert.equal(tabmail.tabInfo.length, count + 1);
      } finally {
        if (results && tabmail.tabInfo.includes(results)) {
          tabmail.closeTab(results);
        }
        await SpecialPowers.popPrefEnv();
      }
    }
  } finally {
    if (addressTab && tabmail.tabInfo.includes(addressTab)) {
      tabmail.closeTab(addressTab);
    }
  }
});
