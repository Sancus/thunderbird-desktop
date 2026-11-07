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
