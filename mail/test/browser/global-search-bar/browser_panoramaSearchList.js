/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const PREF_SHOW_AS_LIST = "gloda.show_as_list_by_default";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["mailnews.mark_message_read.auto", false]],
  });
});

registerCleanupFunction(function () {
  const tabmail = document.getElementById("tabmail");
  while (tabmail.tabInfo.length > 1) {
    tabmail.closeTab(1);
  }
});

/**
 * Create real local search members, including two physical copies with one ID.
 *
 * @param {string} term - Literal subject term unique to this fixture.
 * @param {number} count - Number of messages in the first physical folder.
 * @returns {Promise<object>} Folders, independent expected identities and service.
 */
async function makeMailSearchFixture(term, count) {
  const { MailServices } = ChromeUtils.importESModule(
    "resource:///modules/MailServices.sys.mjs"
  );
  const { MessageGenerator } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
  );
  const { getMailSearchService, closeMailSearch } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearch.sys.mjs"
  );
  const root =
    MailServices.accounts.localFoldersServer.rootFolder.QueryInterface(
      Ci.nsIMsgLocalMailFolder
    );
  const folders = [];
  const tabmail = document.getElementById("tabmail");
  registerCleanupFunction(async () => {
    while (tabmail.tabInfo.length > 1) {
      tabmail.closeTab(1);
    }
    await closeMailSearch();
    for (const folder of folders) {
      folder.parent.propagateDelete(folder, true);
    }
  });
  for (const suffix of ["First", "Second", "Excluded"]) {
    folders.push(
      root
        .createLocalSubfolder(term + suffix)
        .QueryInterface(Ci.nsIMsgLocalMailFolder)
    );
  }
  const [first, second, excluded] = folders;
  const generator = new MessageGenerator();
  const headers = [];
  let copiedMessage;
  for (let i = 0; i < count; i++) {
    const raw = generator
      .makeMessage({
        subject: term,
        from: ["Search Sender", `${term}@example.invalid`],
      })
      .toMessageString();
    copiedMessage ??= raw;
    headers.push(first.addMessage(raw));
  }
  const duplicate = second.addMessage(copiedMessage);
  headers.push(duplicate);
  excluded.addMessage(
    generator.makeMessage({ subject: "unrelated" }).toMessageString()
  );
  first.addKeywordsToMessages([headers[0]], "$label1");
  second.addKeywordsToMessages([duplicate], "$label1");
  const expected = headers.map(header => ({
    folderURI: header.folder.URI,
    key: header.messageKey,
    messageId: header.messageId,
  }));
  const service = await getMailSearchService();
  let progress;
  do {
    progress = await service.update({ limit: 500 });
  } while (progress.moreWork);
  return { first, second, excluded, expected, service };
}

/**
 * Wait for the existing synthetic mail tab and return its actual view headers.
 *
 * @param {object} tab - The mail3PaneTab opened by the default search factory.
 * @returns {Promise<object[]>} Physical folder/key/Message-ID identities.
 */
async function readMailSearchList(tab) {
  await TestUtils.waitForCondition(() => {
    const about3Pane = tab.chromeBrowser?.contentWindow;
    return (
      about3Pane?.gViewWrapper?.isSynthetic &&
      about3Pane.dbViewWrapperListener.allMessagesLoaded &&
      about3Pane.gDBView
    );
  }, "Replacement search completes in the existing mail list");
  const view = tab.chromeBrowser.contentWindow.gDBView;
  return Array.from({ length: view.rowCount }, (_, index) => {
    const header = view.getMsgHdrAt(index);
    return {
      folderURI: header.folder.URI,
      key: header.messageKey,
      messageId: header.messageId,
    };
  });
}

add_task(async function testMailSearchToolbarKeepsAllPhysicalPages() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [PREF_SHOW_AS_LIST, true],
      ["mail.chat.enabled", false],
      ["mailnews.default_view_flags", 0],
    ],
  });
  const fixture = await makeMailSearchFixture("panoramatoolbarneedle", 102);
  const tabmail = document.getElementById("tabmail");
  const input = document.querySelector(
    "#unifiedToolbarContent global-search-bar"
  );
  Assert.ok(input, "The existing toolbar search input is available");
  input.popup.selectedIndex = -1;
  // Exercise the public search event independently of the unported completion provider.
  input.dispatchEvent(
    new CustomEvent("search", { detail: "panoramatoolbarneedle" })
  );
  const pending = tabmail.currentTabInfo;
  Assert.equal(pending.mode.name, "glodaTableList");
  const tab = await pending.searchPromise;
  Assert.equal(tab.mode.name, "mail3PaneTab");
  const actual = await readMailSearchList(tab);
  Assert.equal(
    actual.length,
    103,
    "No first-page limit or Message-ID deduplication"
  );
  const byKey = (a, b) =>
    a.key - b.key || a.folderURI.localeCompare(b.folderURI);
  Assert.deepEqual(actual.toSorted(byKey), fixture.expected.toSorted(byKey));
  Assert.equal(fixture.first.getTotalMessages(false), 102);
  Assert.equal(fixture.second.getTotalMessages(false), 1);
  Assert.equal(fixture.excluded.getTotalMessages(false), 1);
  const second = fixture.expected.find(
    item => item.folderURI == fixture.second.URI
  );
  const index = actual.findIndex(
    item => item.folderURI == second.folderURI && item.key == second.key
  );
  const about3Pane = tab.chromeBrowser.contentWindow;
  about3Pane.paneLayout.messagePaneVisible = true;
  about3Pane.threadTree.selectedIndex = index;
  const reader =
    about3Pane.document.getElementById("messageBrowser").contentWindow;
  await TestUtils.waitForCondition(
    () =>
      reader.gMessage?.messageKey == second.key &&
      reader.gMessage.folder.URI == second.folderURI,
    "The reader opens the selected physical copy, not another copy with its Message-ID"
  );
  Assert.equal(reader.gMessage.messageId, second.messageId);
  tabmail.closeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function testMailSearchActiveFacetExportsCapturedMembers() {
  await SpecialPowers.pushPrefEnv({
    set: [["mailnews.default_view_flags", 0]],
  });
  const fixture = await makeMailSearchFixture("panoramafacetneedle", 2);
  const { findMailSearchResults } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearch.sys.mjs"
  );
  const { getMailSearchFacets } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearchResult.sys.mjs"
  );
  const full = await findMailSearchResults("panoramafacetneedle");
  Assert.equal(full.items.length, 3);
  const groups = getMailSearchFacets(full);
  Assert.equal(groups.resultSetId, full.resultSetId);
  const tagged = groups.tags.find(group => group.value == "$label1");
  Assert.ok(tagged);
  Assert.equal(tagged.ids.length, 2);
  const active = {
    ...full,
    items: full.items.filter(item => tagged.ids.includes(item.id)),
  };
  const expected = fixture.expected.filter(item =>
    tagged.ids.includes(String(item.key))
  );
  Assert.equal(expected.length, 2);
  Assert.equal(expected[0].messageId, expected[1].messageId);
  const tabmail = document.getElementById("tabmail");
  const pending = tabmail.openTab("glodaTableList", {
    mailSearch: { resultSet: active },
    title: "Active tag facet",
  });
  active.items.length = 0;
  const tab = await pending.searchPromise;
  const actual = await readMailSearchList(tab);
  const byKey = (a, b) =>
    a.key - b.key || a.folderURI.localeCompare(b.folderURI);
  Assert.deepEqual(actual.toSorted(byKey), expected.toSorted(byKey));
  Assert.equal(
    actual.length,
    2,
    "Export neither reruns all three hits nor loses an equal-ID copy"
  );
  tabmail.closeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function testClosingPendingMailSearchDoesNotOpenAList() {
  const { getMailSearchService } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearch.sys.mjs"
  );
  await getMailSearchService();
  const tabmail = document.getElementById("tabmail");
  const before = [...tabmail.tabInfo];
  const pending = tabmail.openTab("glodaTableList", {
    mailSearch: { text: "panoramacancelledneedle" },
  });
  const operation = pending.searchPromise;
  tabmail.closeTab(pending);
  await Assert.rejects(operation, error => error.name == "AbortError");
  Assert.deepEqual(
    tabmail.tabInfo,
    before,
    "Closing the pending tab cannot create a late result tab"
  );
});

add_task(async function testMailSearchTypedSelectionIsCapturedBeforeOpening() {
  await SpecialPowers.pushPrefEnv({
    set: [["mailnews.default_view_flags", 0]],
  });
  const fixture = await makeMailSearchFixture("panoramatypedneedle", 1);
  const selection = {
    type: "person",
    emails: ["panoramatypedneedle@example.invalid"],
  };
  const tabmail = document.getElementById("tabmail");
  const pending = tabmail.openTab("glodaTableList", {
    mailSearch: { selection },
  });
  selection.emails[0] = "another-person@example.invalid";
  const tab = await pending.searchPromise;
  const actual = await readMailSearchList(tab);
  const byKey = (a, b) =>
    a.key - b.key || a.folderURI.localeCompare(b.folderURI);
  Assert.deepEqual(actual.toSorted(byKey), fixture.expected.toSorted(byKey));
  Assert.equal(actual.length, 2);
  tabmail.closeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function testInvalidMailSearchSelectionDoesNotFallBack() {
  const tabmail = document.getElementById("tabmail");
  const before = [...tabmail.tabInfo];
  const pending = tabmail.openTab("glodaTableList", {
    mailSearch: { selection: { type: "unsupported" } },
  });
  await Assert.rejects(
    pending.searchPromise,
    /Expected a person or tag search selection/
  );
  Assert.deepEqual(
    tabmail.tabInfo,
    before,
    "An invalid selection rejects without a legacy result tab"
  );
});

add_task(async function test_quickFilterEscalatesToPhysicalGlobalList() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [PREF_SHOW_AS_LIST, true],
      ["mailnews.default_view_flags", 0],
    ],
  });
  const { be_in_folder } = ChromeUtils.importESModule(
    "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
  );
  const { MessageTextFilter } = ChromeUtils.importESModule(
    "resource:///modules/QuickFilterManager.sys.mjs"
  );
  const fixture = await makeMailSearchFixture("panoramaescalationneedle", 1);
  await be_in_folder(fixture.excluded);
  const tabmail = document.getElementById("tabmail");
  const origin = tabmail.currentTabInfo;
  const about3Pane = origin.chromeBrowser.contentWindow;
  const filterBar = about3Pane.quickFilterBar;
  const wasVisible = filterBar.filterer.visible;
  const oldDeferredUpdate = filterBar.deferredUpdateSearch;
  const { set_filter_text } = ChromeUtils.importESModule(
    "resource://testing-common/mail/QuickFilterBarHelpers.sys.mjs"
  );
  registerCleanupFunction(() => {
    filterBar.deferredUpdateSearch = oldDeferredUpdate;
    about3Pane.commandController.doCommand("cmd_resetQuickFilterBar");
    if (filterBar.filterer.visible != wasVisible) {
      about3Pane.commandController.doCommand("cmd_toggleQuickFilterBar");
    }
  });
  about3Pane.commandController.doCommand("cmd_showQuickFilterBar");
  await set_filter_text("panoramaescalationneedle");
  Assert.equal(about3Pane.gDBView.numMsgsInView, 0);
  const state = filterBar.filterer.filterValues.text;
  Assert.equal(state.text, "panoramaescalationneedle");
  Assert.equal(
    MessageTextFilter.postFilterProcess(
      state,
      about3Pane.gViewWrapper,
      true
    )[1],
    "upsell",
    "Native search is offered without consulting the Gloda indexer"
  );
  const input = about3Pane.document.getElementById("qfb-qs-textbox");
  input.dispatchEvent(
    new about3Pane.CustomEvent("search", {
      detail: "panoramaescalationneedle",
      cancelable: true,
    })
  );
  const pending = tabmail.currentTabInfo;
  Assert.equal(pending.mode.name, "glodaTableList");
  const tab = await pending.searchPromise;
  const actual = await readMailSearchList(tab);
  const byKey = (a, b) =>
    a.key - b.key || a.folderURI.localeCompare(b.folderURI);
  Assert.deepEqual(actual.toSorted(byKey), fixture.expected.toSorted(byKey));
  Assert.equal(
    actual.length,
    2,
    "Escalation searches beyond the current folder"
  );
  tabmail.closeTab(tab);
  Assert.equal(tabmail.currentTabInfo, origin);
  Assert.equal(
    about3Pane.gViewWrapper.displayedFolder.URI,
    fixture.excluded.URI
  );
  Assert.equal(filterBar.filterer.filterValues.text.text, state.text);
  Assert.equal(about3Pane.gDBView.numMsgsInView, 0);
  await SpecialPowers.pushPrefEnv({
    set: [["mailnews.database.global.indexer.enabled", false]],
  });
  Assert.equal(
    MessageTextFilter.postFilterProcess(
      state,
      about3Pane.gViewWrapper,
      true
    )[1],
    "nosale",
    "Disabling global indexing also disables native search escalation"
  );
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_resultSearchInputUsesPhysicalGlobalList() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [PREF_SHOW_AS_LIST, true],
      ["mail.chat.enabled", false],
      ["mailnews.default_view_flags", 0],
    ],
  });
  const fixture = await makeMailSearchFixture("panoramaresultinputneedle", 1);
  await customElements.whenDefined("gloda-autocomplete-input");
  // Use the existing result-tab input with its real attributes and controller.
  const input = document
    .getElementById("glodaTab")
    .querySelector(".remote-gloda-search")
    .cloneNode(true);
  registerCleanupFunction(() => input.remove());
  document.documentElement.appendChild(input);
  input.value = "panoramaresultinputneedle";
  input.doSearch();
  Assert.equal(input.value, "", "The entered query is cleared after capture");
  const tabmail = document.getElementById("tabmail");
  const pending = tabmail.currentTabInfo;
  Assert.equal(pending.mode.name, "glodaTableList");
  const tab = await pending.searchPromise;
  const actual = await readMailSearchList(tab);
  const byKey = (a, b) =>
    a.key - b.key || a.folderURI.localeCompare(b.folderURI);
  Assert.deepEqual(actual.toSorted(byKey), fixture.expected.toSorted(byKey));
  Assert.equal(actual.length, 2);
  tabmail.closeTab(tab);
  input.remove();
  await SpecialPowers.popPrefEnv();
});
