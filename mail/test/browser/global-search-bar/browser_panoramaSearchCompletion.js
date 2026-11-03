/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { getMailSearchService, closeMailSearch } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearch.sys.mjs"
);
const tabmail = document.getElementById("tabmail");
const provider = Cc["@mozilla.org/autocomplete/search;1?name=gloda"].getService(
  Ci.nsIAutoCompleteSearch
).wrappedJSObject;
let fixture;

add_setup(async function setupNativeCompletionCopies() {
  Assert.ok(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    ) instanceof Ci.nsIDatabaseCore
  );
  Assert.strictEqual(
    provider.isNativeMailSearch,
    true,
    "The registered provider uses the actual native backend"
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["mailnews.database.global.indexer.enabled", true],
      ["mailnews.default_view_flags", 0],
      ["mailnews.mark_message_read.auto", false],
    ],
  });
  const root =
    MailServices.accounts.localFoldersServer.rootFolder.QueryInterface(
      Ci.nsIMsgLocalMailFolder
    );
  const folders = ["First", "Second", "Excluded"].map(name =>
    root
      .createLocalSubfolder("NativeCompletion" + name)
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
  );
  registerCleanupFunction(async () => {
    provider.stopSearch();
    while (tabmail.tabInfo.length > 1) {
      tabmail.closeTab(1);
    }
    await closeMailSearch();
    for (const folder of folders) {
      folder.parent.propagateDelete(folder, true);
    }
  });
  const generator = new MessageGenerator();
  const raw = generator
    .makeMessage({
      subject: "nativecompletionneedle",
      from: ["Completion Sender", "completionperson@example.invalid"],
    })
    .toMessageString();
  const first = folders[0].addMessage(raw),
    second = folders[1].addMessage(raw);
  folders[2].addMessage(
    generator
      .makeMessage({
        subject: "Excluded physical control",
        from: ["Other Sender", "other@example.invalid"],
      })
      .toMessageString()
  );
  for (const [folder, header] of [
    [folders[0], first],
    [folders[1], second],
  ]) {
    folder.addKeywordsToMessages([header], "$label1");
  }
  const service = await getMailSearchService();
  let progress;
  do {
    progress = await service.update({ limit: 500 });
  } while (progress.moreWork);
  Assert.equal(first.messageId, second.messageId);
  Assert.notEqual(first.folder.URI, second.folder.URI);
  fixture = {
    service,
    sourceId: (await service.collectResults("nativecompletionneedle")).sourceId,
    folders,
    expected: [first, second].map(header => [
      header.folder.URI,
      header.messageKey,
      header.messageId,
    ]),
  };
});

/**
 * Waits for the actual native provider's current static completion.
 *
 * @param {string} text - The original controller input.
 * @returns {Promise<object>} The owned terminal result.
 */
async function completionResult(text) {
  await TestUtils.waitForCondition(
    () =>
      provider.curResult?.searchString == text &&
      provider.curResult.active &&
      !provider.curResult.ongoing,
    "Native completion settles for the current input"
  );
  Assert.ok(!provider.curResult.failed, String(provider.curResult.error));
  return provider.curResult;
}

/**
 * Reads physical identities from the real synthetic C++ view.
 *
 * @param {object} tab - Existing mail3PaneTab.
 * @returns {Promise<Array>} Physical folder/key/Message-ID tuples.
 */
async function completionListRows(tab) {
  await TestUtils.waitForCondition(
    () =>
      tab.chromeBrowser?.contentWindow?.dbViewWrapperListener
        ?.allMessagesLoaded && tab.chromeBrowser.contentWindow.gDBView,
    "The native list loads all physical headers"
  );
  const view = tab.chromeBrowser.contentWindow.gDBView;
  return Array.from({ length: view.rowCount }, (_, index) => {
    const header = view.getMsgHdrAt(index);
    return [header.folder.URI, header.messageKey, header.messageId];
  });
}

/**
 * Checks the real controller and popup custom-interface ownership.
 *
 * @param {HTMLInputElement} input - The retained autocomplete custom element.
 */
function assertCompletionInputOwnership(input) {
  input.openPopup();
  Assert.notStrictEqual(input.nsIAutocompleteInput, input);
  Assert.strictEqual(
    input.controller.input.wrappedJSObject,
    input.nsIAutocompleteInput
  );
  Assert.strictEqual(
    input.popup.input?.wrappedJSObject ?? input.popup.input,
    input.nsIAutocompleteInput
  );
}

add_task(
  async function test_nativeToolbarPersonUsesLiteralSelectionAndSource() {
    await SpecialPowers.pushPrefEnv({
      set: [
        ["gloda.show_as_list_by_default", true],
        ["mail.panorama.enabled", false],
      ],
    });
    try {
      const input = document.querySelector(
        "#unifiedToolbarContent global-search-bar"
      );
      input.focus();
      input.dispatchEvent(
        new CustomEvent("autocomplete", { detail: "completionperson" })
      );
      const result = await completionResult("completionperson");
      Assert.strictEqual(input.popup.input, input);
      const index = result.rows.findIndex(row => row.type == "person");
      Assert.greaterOrEqual(index, 0);
      const row = result.getObjectAt(index);
      Assert.equal(
        row.nounDef,
        undefined,
        "Native display data has no Gloda noun"
      );
      input.popup.selectedIndex = index;
      input.dispatchEvent(
        new CustomEvent("search", { detail: "completionperson" })
      );
      const pending = tabmail.currentTabInfo;
      Assert.equal(pending.mode.name, "glodaTableList");
      const tab = await pending.searchPromise;
      const actual = await completionListRows(tab);
      Assert.deepEqual(
        actual.sort((a, b) => a[1] - b[1]),
        fixture.expected.toSorted((a, b) => a[1] - b[1])
      );
      Assert.equal(
        actual.length,
        2,
        "Identical logical IDs retain both physical copies"
      );
      tabmail.closeTab(tab);
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
);

add_task(async function test_openCompletionCardChangesRefreshCurrentLabels() {
  await SpecialPowers.pushPrefEnv({
    set: [["gloda.show_as_list_by_default", true]],
  });
  const book = MailServices.ab.getDirectory("jsaddrbook://abook.sqlite");
  const card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
    Ci.nsIAbCard
  );
  card.primaryEmail = "completionperson@example.invalid";
  card.displayName = "Open Completion Card A";
  let currentCard = book.addCard(card);
  const input = document.querySelector(
    "#unifiedToolbarContent global-search-bar"
  );
  const originalComplete = fixture.service.complete;
  let release = () => {};
  let list;
  try {
    let progress;
    do {
      progress = await fixture.service.update({ limit: 500 });
    } while (progress.moreWork);
    input.focus();
    input.dispatchEvent(
      new CustomEvent("autocomplete", { detail: "completionperson" })
    );
    const initial = await completionResult("completionperson");
    const initialIndex = initial.rows.findIndex(row => row.type == "person");
    Assert.greaterOrEqual(initialIndex, 0);
    Assert.equal(initial.rows[initialIndex].label, "Open Completion Card A");
    input.popup.selectedIndex = initialIndex;
    const tabs = tabmail.tabInfo.length;
    let completed = false;
    const held = new Promise(resolve => {
      release = resolve;
    });
    fixture.service.complete = async function (...args) {
      const result = await originalComplete.apply(this, args);
      completed = true;
      await held;
      return result;
    };
    currentCard.displayName = "Open Completion Card B";
    book.modifyCard(currentCard);
    await TestUtils.waitForCondition(
      () => completed,
      "Real refresh completion reaches the pending delivery boundary"
    );
    Assert.notStrictEqual(provider.curResult, initial);
    Assert.ok(provider.curResult.ongoing);
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
    Assert.equal(input.popup.selectedIndex, 0);
    release();
    fixture.service.complete = originalComplete;
    await TestUtils.waitForCondition(
      () =>
        provider.curResult != initial &&
        !provider.curResult.ongoing &&
        provider.curResult.rows.some(
          row => row.label == "Open Completion Card B"
        ),
      "The open native completion refreshes without another input event"
    );
    const changed = await completionResult("completionperson");
    Assert.ok(!initial.active);
    Assert.ok(input.popup.mPopupOpen);
    Assert.strictEqual(input.popup.input, input);
    Assert.ok(
      changed.getObjectAt(input.popup.selectedIndex).fullText,
      "A new keyboard choice during refresh is not overwritten by the old person selection"
    );
    input.popup.selectedIndex = changed.rows.findIndex(
      row => row.type == "person"
    );
    Assert.equal(
      changed.getObjectAt(input.popup.selectedIndex).label,
      "Open Completion Card B"
    );
    Assert.equal(changed.sourceId, fixture.sourceId);
    Assert.deepEqual(changed.getObjectAt(input.popup.selectedIndex).selection, {
      type: "person",
      emails: [card.primaryEmail],
    });
    Assert.equal(input.controller.searchString, "completionperson");
    Assert.equal(tabmail.tabInfo.length, tabs);
    book.deleteCards([currentCard]);
    currentCard = null;
    await TestUtils.waitForCondition(
      () =>
        provider.curResult != changed &&
        !provider.curResult.ongoing &&
        provider.curResult.rows.some(
          row => row.type == "person" && row.label == "Completion Sender"
        ),
      "Deletion refreshes the same popup with the actual header-name fallback"
    );
    const fallback = await completionResult("completionperson");
    const row = fallback.getObjectAt(input.popup.selectedIndex);
    Assert.equal(row.label, "Completion Sender");
    Assert.deepEqual(row.selection, {
      type: "person",
      emails: [card.primaryEmail],
    });
    Assert.equal(row.sourceId, fixture.sourceId);
    input.dispatchEvent(
      new CustomEvent("search", { detail: "completionperson" })
    );
    const pending = tabmail.currentTabInfo;
    list = await pending.searchPromise;
    Assert.deepEqual(
      (await completionListRows(list)).toSorted(),
      fixture.expected.toSorted(),
      "The refreshed literal selection still opens exactly both physical copies and excludes the control"
    );
    tabmail.closeTab(list);
    list = null;
    Assert.ok(!fallback.active);
    const settled = TestUtils.topicObserved(
      "panorama-mail-search-names-changed",
      (subject, sourceId) => sourceId == fixture.sourceId
    );
    currentCard = book.addCard(card);
    await settled;
    await TestUtils.waitForTick();
    Assert.strictEqual(
      provider.curResult,
      fallback,
      "Closed input owns no future name delivery"
    );
    Assert.ok(!input.popup.mPopupOpen);
  } finally {
    release();
    fixture.service.complete = originalComplete;
    input.dispatchEvent(new CustomEvent("autocomplete", { detail: "" }));
    if (list) {
      tabmail.closeTab(list);
    }
    if (currentCard) {
      book.deleteCards([currentCard]);
    }
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_nativeToolbarTagUsesRetainedFacetUI() {
  await SpecialPowers.pushPrefEnv({
    set: [["gloda.show_as_list_by_default", false]],
  });
  try {
    const input = document.querySelector(
      "#unifiedToolbarContent global-search-bar"
    );
    input.focus();
    const text = MailServices.tags.getTagForKey("$label1");
    input.dispatchEvent(new CustomEvent("autocomplete", { detail: text }));
    const result = await completionResult(text);
    const index = result.rows.findIndex(
      row => row.type == "tag" && row.selection.key == "$label1"
    );
    Assert.greaterOrEqual(index, 0);
    const row = result.getObjectAt(index);
    input.popup.selectedIndex = index;
    input.dispatchEvent(new CustomEvent("search", { detail: text }));
    const tab = tabmail.currentTabInfo;
    Assert.equal(tab.mode.name, "glodaFacet");
    Assert.deepEqual(tab.mailSearch.selection, { type: "tag", key: "$label1" });
    Assert.equal(tab.mailSearch.sourceId, row.sourceId);
    Assert.equal(tab.title, row.label);
    await TestUtils.waitForCondition(() => tab.searchPromise);
    await tab.searchPromise;
    const context = tab.browser.contentWindow.FacetContext;
    Assert.equal(context.mailSearchResultSet.sourceId, row.sourceId);
    Assert.deepEqual(
      context.fullSet.map(item => Number(item.id)).sort((a, b) => a - b),
      fixture.expected.map(item => item[1]).sort((a, b) => a - b)
    );
    tabmail.closeTab(tab);
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(
  async function test_nativeResultInputSurvivesControllerStopBeforeEnter() {
    await SpecialPowers.pushPrefEnv({
      set: [["gloda.show_as_list_by_default", false]],
    });
    try {
      const owner = tabmail.openTab("glodaFacet", {
        mailSearch: { text: "nativecompletionneedle" },
      });
      await TestUtils.waitForCondition(() => owner.searchPromise);
      await owner.searchPromise;
      const input = owner.panel.querySelector(".remote-gloda-search");
      input.focus();
      input.value = "completionperson";
      input.controller.startSearch("completionperson");
      const result = await completionResult("completionperson");
      assertCompletionInputOwnership(input);
      const index = result.rows.findIndex(row => row.type == "person");
      Assert.greaterOrEqual(index, 0);
      input.popup.selectedIndex = index;
      provider.stopSearch();
      Assert.strictEqual(
        provider.curResult,
        result,
        "EnterMatch still owns the displayed row"
      );
      input.textObserver.observe(
        { popupElement: input.popup },
        "autocomplete-did-enter-text"
      );
      await TestUtils.waitForCondition(
        () => tabmail.currentTabInfo != owner,
        "The retained input opens the captured native selection"
      );
      const opened = tabmail.currentTabInfo;
      Assert.equal(
        opened.mailSearch.sourceId,
        result.getObjectAt(index).sourceId
      );
      Assert.deepEqual(opened.mailSearch.selection, {
        type: "person",
        emails: ["completionperson@example.invalid"],
      });
      await TestUtils.waitForCondition(() => opened.searchPromise);
      await opened.searchPromise;
      Assert.equal(opened.browser.contentWindow.FacetContext.fullSet.length, 2);
      tabmail.closeTab(opened);
      tabmail.closeTab(owner);
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
);

add_task(
  async function test_nativeCompletionSourceMismatchDoesNotOpenPhysicalList() {
    const source = fixture.sourceId;
    const pending = tabmail.openTab("glodaTableList", {
      mailSearch: {
        selection: {
          type: "person",
          emails: ["completionperson@example.invalid"],
        },
        sourceId: source + "-obsolete",
      },
    });
    await Assert.rejects(
      pending.searchPromise,
      /Native completion source changed/
    );
    await TestUtils.waitForCondition(() => !tabmail.tabInfo.includes(pending));
    Assert.ok(
      !tabmail.tabInfo.some(
        tab => tab.chromeBrowser?.contentWindow?.gViewWrapper?.isSynthetic
      )
    );
    Assert.equal(fixture.folders[0].getTotalMessages(false), 1);
    Assert.equal(fixture.folders[1].getTotalMessages(false), 1);
    Assert.equal(fixture.folders[2].getTotalMessages(false), 1);
  }
);

add_task(async function test_nativeInputClearCancelsDeferredTypedSelection() {
  const owner = tabmail.openTab("glodaFacet", {
    mailSearch: { text: "nativecompletionneedle" },
  });
  try {
    await TestUtils.waitForCondition(() => owner.searchPromise);
    await owner.searchPromise;
    const input = owner.panel.querySelector(".remote-gloda-search");
    input.focus();
    input.value = "completionperson";
    input.controller.startSearch("completionperson");
    const result = await completionResult("completionperson");
    assertCompletionInputOwnership(input);
    input.popup.selectedIndex = result.rows.findIndex(
      row => row.type == "person"
    );
    Assert.greaterOrEqual(input.popup.selectedIndex, 0);
    provider.stopSearch();
    const count = tabmail.tabInfo.length;
    input.textObserver.observe(
      { popupElement: input.popup },
      "autocomplete-did-enter-text"
    );
    input.clearSearch();
    await new Promise(resolve => window.setTimeout(resolve));
    Assert.strictEqual(tabmail.currentTabInfo, owner);
    Assert.equal(
      tabmail.tabInfo.length,
      count,
      "Escape/clear cannot open the deferred old selection"
    );
  } finally {
    tabmail.closeTab(owner);
  }
});

add_task(async function test_nativeEmptyToolbarCancelsOldCompletion() {
  const input = document.querySelector(
    "#unifiedToolbarContent global-search-bar"
  );
  input.focus();
  input.dispatchEvent(
    new CustomEvent("autocomplete", { detail: "completionperson" })
  );
  const pending = provider.curResult;
  input.dispatchEvent(new CustomEvent("autocomplete", { detail: "" }));
  await fixture.service.complete("completionperson");
  Assert.strictEqual(provider.curResult, pending);
  Assert.ok(!pending.active);
  Assert.equal(input.controller.searchString, "");
  Assert.equal(input.controller.matchCount, 0);
  Assert.equal(input.popup.selectedIndex, -1);
  Assert.ok(!input.popup.mPopupOpen);
});

add_task(
  async function test_nativeQuickFilterIgnoresMutableBackendPreference() {
    const { be_in_folder } = ChromeUtils.importESModule(
      "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
    );
    const { set_filter_text } = ChromeUtils.importESModule(
      "resource://testing-common/mail/QuickFilterBarHelpers.sys.mjs"
    );
    await SpecialPowers.pushPrefEnv({
      set: [
        ["mail.panorama.enabled", false],
        ["gloda.show_as_list_by_default", false],
      ],
    });
    try {
      await be_in_folder(fixture.folders[2]);
      const pane = tabmail.currentTabInfo.chromeBrowser.contentWindow;
      const visible = pane.quickFilterBar.filterer.visible;
      pane.commandController.doCommand("cmd_showQuickFilterBar");
      registerCleanupFunction(() => {
        pane.commandController.doCommand("cmd_resetQuickFilterBar");
        if (pane.quickFilterBar.filterer.visible != visible) {
          pane.commandController.doCommand("cmd_toggleQuickFilterBar");
        }
      });
      await set_filter_text("nativecompletionneedle");
      // Earlier list selections can change metadata after fixture indexing.
      let progress;
      do {
        progress = await fixture.service.update({ limit: 500 });
      } while (progress.moreWork);
      const snapshot = await fixture.service.collectResults(
        "nativecompletionneedle"
      );
      const current = fixture.expected.map(([, key]) =>
        fixture.service.resolveDocument(String(key))
      );
      const { getMailSearchHeader } = ChromeUtils.importESModule(
        "resource:///modules/panorama/MailSearchPolicy.sys.mjs"
      );
      const indexed = snapshot.items.map(item => {
        const state = fixture.service.resolveDocument(item.id);
        Assert.equal(item.generation, state.generation);
        Assert.equal(item.contentRevision, state.contentRevision);
        Assert.equal(item.policyRevision, state.policyRevision);
        Assert.deepEqual(item.location, state.location);
        const header = getMailSearchHeader(state);
        return [header.folder.URI, header.messageKey, item.messageId];
      });
      const revisions = states =>
        states.map(state => ({
          id: state?.id,
          generation: state?.generation,
          contentRevision: state?.contentRevision,
          policyRevision: state?.policyRevision,
          location: state?.location,
        }));
      Assert.deepEqual(
        indexed.toSorted(),
        fixture.expected.toSorted(),
        `Both physical copies are current before escalation: ${JSON.stringify({
          indexed: revisions(snapshot.items),
          current: revisions(current),
        })}`
      );
      pane.document.getElementById("qfb-qs-textbox").dispatchEvent(
        new pane.CustomEvent("search", {
          detail: "nativecompletionneedle",
          cancelable: true,
        })
      );
      const tab = tabmail.currentTabInfo;
      Assert.equal(tab.mode.name, "glodaFacet");
      Assert.equal(tab.mailSearch.text, "nativecompletionneedle");
      await TestUtils.waitForCondition(() => tab.searchPromise);
      await tab.searchPromise;
      Assert.equal(tab.browser.contentWindow.FacetContext.fullSet.length, 2);
      tabmail.closeTab(tab);
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
);

add_task(
  async function test_nativeProxyOwnedInputCancelsOnClearAndDisconnect() {
    const owner = tabmail.openTab("glodaFacet", {
      mailSearch: { text: "nativecompletionneedle" },
    });
    try {
      await TestUtils.waitForCondition(() => owner.searchPromise);
      await owner.searchPromise;
      const input = owner.panel.querySelector(".remote-gloda-search");
      input.focus();
      input.timeout = 0;
      input.value = "completionperson";
      input.controller.startSearch("completionperson");
      let result = provider.curResult;
      Assert.strictEqual(
        input.controller.input.wrappedJSObject,
        input.nsIAutocompleteInput
      );
      Assert.ok(
        result.active && result.ongoing,
        "The real controller started an asynchronous search"
      );
      input.clearSearch();
      Assert.ok(
        !result.active,
        "Clear cancels the actual proxy-owned provider run"
      );
      Assert.equal(input.value, "");
      input.value = "completionperson";
      input.controller.startSearch("completionperson");
      result = provider.curResult;
      Assert.strictEqual(
        input.controller.input.wrappedJSObject,
        input.nsIAutocompleteInput
      );
      Assert.ok(result.active && result.ongoing);
      input.remove();
      Assert.ok(
        !result.active,
        "Disconnect cancels before upstream ownership is detached"
      );
      Assert.equal(input.hasConnected, false);
    } finally {
      tabmail.closeTab(owner);
    }
  }
);

let queryFixture;

add_setup(async function setupNativeQueryInput() {
  const root =
    MailServices.accounts.localFoldersServer.rootFolder.QueryInterface(
      Ci.nsIMsgLocalMailFolder
    );
  const folders = ["First", "Second"].map(name =>
    root
      .createLocalSubfolder("NativeQueryInput" + name)
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
  );
  registerCleanupFunction(async () => {
    await closeMailSearch();
    for (const folder of folders) {
      folder.parent.propagateDelete(folder, true);
    }
  });
  const generator = new MessageGenerator();
  let headersCopy;
  const headers = [
    "s410amber s410violet café 東京検索",
    "s410amber separated s410violet café",
    "s410violet s410amber unrelated",
    "s410amber alone",
    "s410violet alone",
  ].map((subject, index) => {
    const message = generator.makeMessage();
    message.messageId = `native-query-input-${index}@example.invalid`;
    message.subject = MailServices.mimeConverter.encodeMimePartIIStr_UTF8(
      subject,
      false,
      "Subject".length,
      72
    );
    const raw = message.toMessageString();
    const header = folders[0].addMessage(raw);
    Assert.equal(header.mime2DecodedSubject, subject);
    if (index == 0) {
      headersCopy = folders[1].addMessage(raw);
    }
    return header;
  });
  Assert.equal(headers[0].messageId, headersCopy.messageId);
  Assert.notEqual(headers[0].folder.URI, headersCopy.folder.URI);
  let progress;
  do {
    progress = await fixture.service.update({ limit: 500 });
  } while (progress.moreWork);
  queryFixture = {
    phrase: [headers[0], headersCopy],
    terms: [headers[0], headersCopy, headers[1], headers[2]],
    accent: [headers[0], headersCopy, headers[1]],
  };
});

/**
 * Submit literal text through the toolbar's input, completion and Enter handlers.
 *
 * @param {string} text - User text, including quotes and Unicode characters.
 * @param {nsIMsgDBHdr[]} expected - Independent physical result headers.
 * @param {boolean} showAsList - Existing result presentation preference.
 * @returns {Promise<void>} Resolves after checking and closing the result tab.
 */
async function searchToolbarQuery(text, expected, showAsList) {
  await SpecialPowers.pushPrefEnv({
    set: [["gloda.show_as_list_by_default", showAsList]],
  });
  const origin = tabmail.currentTabInfo;
  const input = document.querySelector(
    "#unifiedToolbarContent global-search-bar"
  );
  try {
    input.reset();
    input.focus();
    Assert.strictEqual(
      input.shadowRoot.activeElement,
      input.shadowRoot.querySelector("input")
    );
    if (Array.from(text).some(character => character.charCodeAt(0) > 127)) {
      EventUtils.synthesizeCompositionChange(
        {
          composition: {
            string: text,
            clauses: [
              {
                length: text.length,
                attr: EventUtils.COMPOSITION_ATTR_RAW_CLAUSE,
              },
            ],
          },
          caret: { start: text.length, length: 0 },
        },
        window
      );
      EventUtils.synthesizeComposition(
        { type: "compositioncommitasis" },
        window
      );
    } else {
      EventUtils.sendString(text, window);
    }
    Assert.equal(input.value, text, "Preserve the exact user input");
    const result = await completionResult(text);
    Assert.equal(input.controller.searchString, text);
    Assert.strictEqual(input.popup.input, input);
    const index = result.rows.findIndex(row => row.fullText);
    Assert.greaterOrEqual(
      index,
      0,
      "The actual provider offers a full-text choice"
    );
    Assert.equal(result.getObjectAt(index).item, text);
    input.popup.selectedIndex = -1;
    for (let i = 0; i <= index; i++) {
      EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
    }
    Assert.equal(input.popup.selectedIndex, index);
    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    const pending = tabmail.currentTabInfo;
    Assert.notEqual(pending, origin, "Enter opens the retained result UI");
    Assert.equal(
      pending.mode.name,
      showAsList ? "glodaTableList" : "glodaFacet"
    );
    if (!showAsList) {
      Assert.equal(pending.mailSearch.text, text);
      Assert.equal(pending.mailSearch.selection, null);
    }
    let actual;
    if (showAsList) {
      const list = await pending.searchPromise;
      actual = await completionListRows(list);
      Assert.equal(list.chromeBrowser.contentDocument.title, text);
    } else {
      await TestUtils.waitForCondition(() => pending.searchPromise);
      await pending.searchPromise;
      const { getMailSearchHeader } = ChromeUtils.importESModule(
        "resource:///modules/panorama/MailSearchPolicy.sys.mjs"
      );
      actual = pending.browser.contentWindow.FacetContext.fullSet.map(item => {
        const state = fixture.service.resolveDocument(item.id);
        Assert.deepEqual(item.location, state.location);
        const header = getMailSearchHeader(state);
        Assert.equal(item.messageId, header.messageId);
        return [header.folder.URI, header.messageKey, item.messageId];
      });
    }
    const identities = expected.map(header => [
      header.folder.URI,
      header.messageKey,
      header.messageId,
    ]);
    Assert.deepEqual(
      actual.toSorted(),
      identities.toSorted(),
      `Exact physical results for ${text}`
    );
  } finally {
    while (tabmail.currentTabInfo != origin) {
      tabmail.closeTab(tabmail.currentTabInfo);
    }
    input.reset();
    await SpecialPowers.popPrefEnv();
  }
}

add_task(async function test_nativeToolbarQuotedPhraseAndTermOrder() {
  await searchToolbarQuery('"s410amber s410violet"', queryFixture.phrase, true);
  await searchToolbarQuery("s410amber s410violet", queryFixture.terms, true);
});

add_task(async function test_nativeToolbarUnmatchedQuoteKeepsBothTerms() {
  await searchToolbarQuery('"s410amber s410violet', queryFixture.terms, false);
});

add_task(async function test_nativeToolbarAccentAndCjkInput() {
  await searchToolbarQuery("CAFÉ", queryFixture.accent, true);
  await searchToolbarQuery("cafe", queryFixture.accent, false);
  await searchToolbarQuery("東京検索", queryFixture.phrase, false);
});
