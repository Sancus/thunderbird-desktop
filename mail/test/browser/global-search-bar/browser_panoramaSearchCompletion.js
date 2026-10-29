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
    while (tabmail.tabInfo.length > 1) tabmail.closeTab(1);
    await closeMailSearch();
    for (const folder of folders) folder.parent.propagateDelete(folder, true);
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
  ])
    folder.addKeywordsToMessages([header], "$label1");
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
      Assert.ok(index >= 0);
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
    Assert.ok(index >= 0);
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
      Assert.ok(index >= 0);
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
    Assert.ok(input.popup.selectedIndex >= 0);
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
        if (pane.quickFilterBar.filterer.visible != visible)
          pane.commandController.doCommand("cmd_toggleQuickFilterBar");
      });
      await set_filter_text("nativecompletionneedle");
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
