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

/**
 * Create independently identified native conversation members using mail ingest.
 *
 * @param {string} name - Unique physical fixture prefix.
 * @returns {object} Stored headers, literal expected members and cleanup.
 */
function makeConversationCommandFixture(name) {
  const { MailServices } = ChromeUtils.importESModule(
    "resource:///modules/MailServices.sys.mjs"
  );
  const { MessageGenerator } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
  );
  const root =
    MailServices.accounts.localFoldersServer.rootFolder.QueryInterface(
      Ci.nsIMsgLocalMailFolder
    );
  const folders = ["First", "Second", "Outside"].map(suffix =>
    root
      .createLocalSubfolder(name + suffix)
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
  );
  const generator = new MessageGenerator();
  const parent = generator.makeMessage({ subject: name });
  parent.messageId = `${name}-parent@example.invalid`;
  const reply = generator.makeMessage({ inReplyTo: parent });
  reply.messageId = `${name}-reply@example.invalid`;
  const unrelated = generator.makeMessage({ subject: name });
  unrelated.messageId = `${name}-unrelated@example.invalid`;
  const a = folders[0].addMessage(parent.toMessageString());
  const b = folders[0].addMessage(reply.toMessageString());
  const selected = folders[1].addMessage(parent.toMessageString());
  const excluded = folders[2].addMessage(unrelated.toMessageString());
  const physical = header => ({
    folderURI: header.folder.URI,
    key: header.messageKey,
    messageId: header.messageId,
  });
  const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  );
  Assert.ok(core, "The real installed native backend supplies this command");
  info(
    "Native conversation ingress " +
      JSON.stringify(
        [a, b, selected, excluded].map(header => ({
          key: header.messageKey,
          folderId: header.folder.id,
          messageId: header.messageId,
          threadId: header.threadId,
          threadParent: header.threadParent,
          references: Array.from({ length: header.numReferences }, (_, index) =>
            header.getStringReference(index)
          ),
        }))
      )
  );
  Assert.equal(
    b.numReferences,
    1,
    "The stored reply retains its real parent reference"
  );
  Assert.equal(
    b.getStringReference(0),
    a.messageId,
    "The ordinary native ingress preserved the generated parent Message-ID"
  );
  return {
    selected,
    excluded,
    folders,
    expected: [a, b, selected].map(physical),
    physical,
    async close() {
      const tabmail = document.getElementById("tabmail");
      while (tabmail.tabInfo.length > 1) {
        tabmail.closeTab(1);
      }
      const { closeMailSearch } = ChromeUtils.importESModule(
        "resource:///modules/panorama/MailSearch.sys.mjs"
      );
      await closeMailSearch();
      for (const folder of folders) {
        folder.parent.propagateDelete(folder, true);
      }
    },
  };
}

add_task(async function test_openConversationKeepsWholePhysicalMembership() {
  const { ConversationOpener } = ChromeUtils.importESModule(
    "resource:///modules/ConversationOpener.sys.mjs"
  );
  const { MailSearchView } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearchView.sys.mjs"
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["mailnews.database.global.indexer.enabled", true],
      ["mailnews.default_view_flags", 0],
      ["mailnews.default_sort_order", Ci.nsMsgViewSortOrder.ascending],
    ],
  });
  const fixture = makeConversationCommandFixture("nativeconversationopen");
  try {
    Assert.ok(
      ConversationOpener.isMessageIndexed(fixture.selected),
      "An eligible native header needs no Gloda or FTS result token"
    );
    const tabmail = document.getElementById("tabmail");
    const origin = tabmail.currentTabInfo;
    const tab = await new ConversationOpener(
      origin.chromeBrowser.contentWindow
    ).openConversationForMessages([fixture.selected]);
    Assert.equal(tab.mode.name, "mail3PaneTab");
    const actual = await readMailSearchList(tab);
    const order = (left, right) => left.key - right.key;
    Assert.deepEqual(
      actual.toSorted(order),
      fixture.expected.toSorted(order),
      "Every literal root/reply/physical-copy member is present, not the unrelated subject match"
    );
    const pane = tab.chromeBrowser.contentWindow;
    Assert.ok(
      pane.gViewWrapper._syntheticView instanceof MailSearchView,
      "The native path never opens the legacy synthetic view"
    );
    await TestUtils.waitForCondition(
      () => pane.gDBView.numSelected == 1,
      "The requested physical member is selected"
    );
    Assert.deepEqual(
      fixture.physical(pane.gDBView.hdrForFirstSelectedMessage),
      fixture.physical(fixture.selected)
    );
    Assert.equal(
      pane.gViewWrapper._sort[0][1],
      Ci.nsMsgViewSortOrder.ascending,
      "The existing mail-list sort preference remains in use"
    );
    tabmail.closeTab(tab);
    Assert.equal(tabmail.currentTabInfo, origin);
  } finally {
    await fixture.close();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_openConversationPolicyAndErrors() {
  const { ConversationOpener } = ChromeUtils.importESModule(
    "resource:///modules/ConversationOpener.sys.mjs"
  );
  const { MailSearchService } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearchService.sys.mjs"
  );
  const { sinon } = ChromeUtils.importESModule(
    "resource://testing-common/Sinon.sys.mjs"
  );
  await SpecialPowers.pushPrefEnv({
    set: [["mailnews.database.global.indexer.enabled", true]],
  });
  const fixture = makeConversationCommandFixture("nativeconversationpolicy");
  const tabmail = document.getElementById("tabmail");
  const origin = tabmail.currentTabInfo;
  let stub;
  try {
    fixture.selected.setStringProperty("junkscore", "100");
    Assert.ok(!ConversationOpener.isMessageIndexed(fixture.selected));
    fixture.selected.setStringProperty("junkscore", "0");
    await SpecialPowers.pushPrefEnv({
      set: [["mailnews.database.global.indexer.enabled", false]],
    });
    try {
      Assert.ok(!ConversationOpener.isMessageIndexed(fixture.selected));
      Assert.equal(
        await new ConversationOpener(
          origin.chromeBrowser.contentWindow
        ).openConversationForMessages([fixture.selected]),
        null
      );
      Assert.equal(tabmail.tabInfo.length, 1, "Disabled search opens no tab");
    } finally {
      await SpecialPowers.popPrefEnv();
    }
    const error = new Error("Native conversation lookup failed");
    stub = sinon
      .stub(MailSearchService.prototype, "getConversationForHeader")
      .rejects(error);
    await Assert.rejects(
      new ConversationOpener(
        origin.chromeBrowser.contentWindow
      ).openConversationForMessages([fixture.selected]),
      value => value === error,
      "The original native error is preserved without a legacy fallback"
    );
    Assert.equal(tabmail.tabInfo.length, 1);
  } finally {
    stub?.restore();
    await fixture.close();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_openConversationCancelsClosedOrigin() {
  const { ConversationOpener } = ChromeUtils.importESModule(
    "resource:///modules/ConversationOpener.sys.mjs"
  );
  const { MailSearchService } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearchService.sys.mjs"
  );
  const { sinon } = ChromeUtils.importESModule(
    "resource://testing-common/Sinon.sys.mjs"
  );
  await SpecialPowers.pushPrefEnv({
    set: [["mailnews.database.global.indexer.enabled", true]],
  });
  const fixture = makeConversationCommandFixture("nativeconversationcancel");
  const tabmail = document.getElementById("tabmail");
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const original = MailSearchService.prototype.getConversationForHeader;
  const stub = sinon
    .stub(MailSearchService.prototype, "getConversationForHeader")
    .callsFake(async function (header, options) {
      const result = await original.call(this, header, options);
      entered.resolve();
      await release.promise;
      return result;
    });
  let opening;
  try {
    const origin = tabmail.openTab("mail3PaneTab", {
      folderURI: fixture.folders[0].URI,
    });
    await TestUtils.waitForCondition(
      () => origin.chromeBrowser.contentWindow?.gDBView,
      "The real origin mail pane is initialized"
    );
    opening = new ConversationOpener(
      origin.chromeBrowser.contentWindow
    ).openConversationForMessages([fixture.selected]);
    opening.catch(entered.reject);
    await entered.promise;
    tabmail.closeTab(origin);
    Assert.equal(
      await opening,
      null,
      "Closing the origin settles before delayed delivery"
    );
    release.resolve();
    await TestUtils.waitForTick();
    Assert.equal(
      tabmail.tabInfo.length,
      1,
      "Delayed native completion creates no late tab"
    );
  } finally {
    release.resolve();
    stub.restore();
    if (opening) {
      await opening.catch(() => {});
    }
    await fixture.close();
    await SpecialPowers.popPrefEnv();
  }
});

/**
 * Change the selected physical member after a real conversation snapshot.
 *
 * @param {"move"|"delete"} action - The operation on the captured copy.
 */
async function checkStaleConversationSelection(action) {
  const { ConversationOpener } = ChromeUtils.importESModule(
    "resource:///modules/ConversationOpener.sys.mjs"
  );
  const { MailSearchService } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearchService.sys.mjs"
  );
  const { MailServices } = ChromeUtils.importESModule(
    "resource:///modules/MailServices.sys.mjs"
  );
  const { PromiseTestUtils: MailPromiseTestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
  );
  const { sinon } = ChromeUtils.importESModule(
    "resource://testing-common/Sinon.sys.mjs"
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["mailnews.database.global.indexer.enabled", true],
      ["mailnews.default_view_flags", 0],
    ],
  });
  const fixture = makeConversationCommandFixture(`nativeconversation${action}`);
  const tabmail = document.getElementById("tabmail");
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const original = MailSearchService.prototype.getConversationForHeader;
  const stub = sinon
    .stub(MailSearchService.prototype, "getConversationForHeader")
    .callsFake(async function (header, options) {
      const snapshot = await original.call(this, header, options);
      Assert.equal(snapshot.status, "ready");
      Assert.equal(snapshot.items.length, 3);
      entered.resolve();
      await release.promise;
      return snapshot;
    });
  let opening;
  try {
    const origin = tabmail.openTab("mail3PaneTab", {
      folderURI: fixture.folders[0].URI,
    });
    await TestUtils.waitForCondition(
      () => origin.chromeBrowser.contentWindow?.gDBView?.rowCount == 2,
      "The independent origin folder has both stored messages"
    );
    const pane = origin.chromeBrowser.contentWindow;
    pane.selectMessage(
      fixture.folders[0].msgDatabase.getMsgHdrForKey(fixture.expected[0].key)
    );
    await TestUtils.waitForCondition(
      () => pane.gDBView.numSelected == 1,
      "The original physical selection is installed"
    );
    const view = pane.gDBView;
    const capture = () => ({
      folderURI: pane.gViewWrapper.displayedFolder.URI,
      selected: view.getSelectedMsgHdrs().map(fixture.physical),
      current: view.selection.currentIndex,
      pivot: view.selection.shiftSelectPivot,
    });
    const before = capture();
    const tabsBefore = [...tabmail.tabInfo];
    const selectedKey = fixture.selected.messageKey;
    opening = new ConversationOpener(pane).openConversationForMessages([
      fixture.selected,
    ]);
    opening.catch(entered.reject);
    await entered.promise;
    if (action == "move") {
      const listener = new MailPromiseTestUtils.PromiseCopyListener();
      MailServices.copy.copyMessages(
        fixture.folders[1],
        [fixture.selected],
        fixture.folders[2],
        true,
        listener,
        null,
        false
      );
      await listener.promise;
    } else {
      fixture.folders[1].deleteMessages(
        [fixture.selected],
        null,
        true,
        false,
        null,
        false
      );
    }
    Assert.ok(
      !fixture.folders[1].msgDatabase.containsKey(selectedKey),
      "The captured physical member actually left its original folder"
    );
    Assert.equal(fixture.folders[0].getTotalMessages(false), 2);
    Assert.equal(fixture.folders[1].getTotalMessages(false), 0);
    Assert.equal(
      fixture.folders[2].getTotalMessages(false),
      action == "move" ? 2 : 1
    );
    release.resolve();
    await Assert.rejects(
      opening,
      error =>
        [Cr.NS_ERROR_NOT_AVAILABLE, Cr.NS_ERROR_IN_PROGRESS].includes(
          error.result
        ),
      "Stale membership fails instead of opening a subset or the equal-ID copy"
    );
    Assert.deepEqual(
      tabmail.tabInfo,
      tabsBefore,
      "No stale result tab remains"
    );
    Assert.equal(tabmail.currentTabInfo, origin);
    Assert.deepEqual(
      capture(),
      before,
      "The origin selection/current/pivot remain intact"
    );
  } finally {
    release.resolve();
    stub.restore();
    if (opening) {
      await opening.catch(() => {});
    }
    await fixture.close();
    await SpecialPowers.popPrefEnv();
  }
}

add_task(async function test_openConversationRejectsMovedSelection() {
  await checkStaleConversationSelection("move");
});

add_task(async function test_openConversationRejectsDeletedSelection() {
  await checkStaleConversationSelection("delete");
});

add_task(async function test_openConversationFromStandaloneWindow() {
  const { ConversationOpener } = ChromeUtils.importESModule(
    "resource:///modules/ConversationOpener.sys.mjs"
  );
  const { MailUtils } = ChromeUtils.importESModule(
    "resource:///modules/MailUtils.sys.mjs"
  );
  const { promise_new_window } = ChromeUtils.importESModule(
    "resource://testing-common/mail/WindowHelpers.sys.mjs"
  );
  const { wait_for_message_display_completion } = ChromeUtils.importESModule(
    "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["mailnews.database.global.indexer.enabled", true],
      ["mailnews.default_view_flags", 0],
    ],
  });
  const fixture = makeConversationCommandFixture("nativeconversationwindow");
  let origin;
  try {
    const opened = promise_new_window("mail:messageWindow");
    MailUtils.openMessageInNewWindow(fixture.selected);
    origin = await opened;
    await wait_for_message_display_completion(origin, true);
    Assert.equal(origin.document.getElementById("tabmail"), null);
    const tabmail = document.getElementById("tabmail");
    const tab = await new ConversationOpener(
      origin
    ).openConversationForMessages([fixture.selected]);
    const actual = await readMailSearchList(tab);
    const order = (left, right) => left.key - right.key;
    Assert.deepEqual(actual.toSorted(order), fixture.expected.toSorted(order));
    const pane = tab.chromeBrowser.contentWindow;
    Assert.deepEqual(
      fixture.physical(pane.gDBView.hdrForFirstSelectedMessage),
      fixture.expected[2],
      "The standalone origin opens the selected physical copy in the existing mail window"
    );
    await BrowserTestUtils.closeWindow(origin);
    origin = null;
    Assert.ok(
      tabmail.tabInfo.includes(tab),
      "Closing the completed origin keeps its result tab"
    );
    Assert.deepEqual(
      fixture.physical(pane.gDBView.hdrForFirstSelectedMessage),
      fixture.expected[2]
    );
    tabmail.closeTab(tab);
  } finally {
    if (origin && !origin.closed) {
      await BrowserTestUtils.closeWindow(origin);
    }
    await fixture.close();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(
  async function test_contextConversationKeepsCurrentPhysicalSelection() {
    const { MailServices } = ChromeUtils.importESModule(
      "resource:///modules/MailServices.sys.mjs"
    );
    const { MessageGenerator } = ChromeUtils.importESModule(
      "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
    );
    const { PromiseTestUtils } = ChromeUtils.importESModule(
      "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
    );
    const { be_in_folder, select_click_row } = ChromeUtils.importESModule(
      "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
    );
    const { getMailSearchService, closeMailSearch } =
      ChromeUtils.importESModule(
        "resource:///modules/panorama/MailSearch.sys.mjs"
      );
    Assert.ok(Services.prefs.getBoolPref("mail.panorama.enabled"));
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    );
    await SpecialPowers.pushPrefEnv({
      set: [
        ["mailnews.database.global.indexer.enabled", true],
        ["mailnews.default_view_flags", 0],
      ],
    });
    const tabmail = document.getElementById("tabmail");
    const origin = tabmail.currentTabInfo;
    const pane = origin.chromeBrowser.contentWindow;
    const menu = pane.document.getElementById("mailContext");
    const folders = [];
    registerCleanupFunction(async () => {
      if (menu.state == "open") {
        const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
        menu.hidePopup();
        await hidden;
      }
      while (tabmail.tabInfo.length > 1) {
        tabmail.closeTab(1);
      }
      await closeMailSearch();
      for (const folder of folders) {
        folder.parent.propagateDelete(folder, true);
      }
      await SpecialPowers.popPrefEnv();
    });
    const localRoot = MailServices.accounts.localFoldersServer.rootFolder;
    for (const [name, flag] of [
      ["Inbox", Ci.nsMsgFolderFlags.Inbox],
      ["Sent", Ci.nsMsgFolderFlags.SentMail],
      ["Archive", Ci.nsMsgFolderFlags.Archive],
    ]) {
      const folder = localRoot
        .createLocalSubfolder("ContextConversation095" + name)
        .QueryInterface(Ci.nsIMsgLocalMailFolder);
      folders.push(folder);
      folder.setFlag(flag);
      Assert.equal(folder.flags & flag, flag);
    }
    const [inbox, sent, archive] = folders;
    const generator = new MessageGenerator();
    const parentMail = generator.makeMessage({
      subject: "Context conversation 095",
    });
    parentMail.messageId = "context095-root@example.invalid";
    const replyMail = generator.makeMessage({ inReplyTo: parentMail });
    replyMail.messageId = "context095-reply@example.invalid";
    const tailMail = generator.makeMessage({ inReplyTo: replyMail });
    tailMail.messageId = "context095-tail@example.invalid";
    const controlMail = generator.makeMessage({ subject: parentMail.subject });
    controlMail.messageId = "context095-control@example.invalid";
    const parent = inbox.addMessage(parentMail.toMessageString());
    const reply = sent.addMessage(replyMail.toMessageString());
    const tail = archive.addMessage(tailMail.toMessageString());
    const control = sent.addMessage(controlMail.toMessageString());
    const physical = header => ({
      folderURI: header.folder.URI,
      key: header.messageKey,
      messageId: header.messageId,
    });
    Assert.equal(reply.getStringReference(0), parent.messageId);
    Assert.equal(
      tail.getStringReference(tail.numReferences - 1),
      reply.messageId
    );
    Assert.equal(control.numReferences, 0);
    Assert.equal(
      new Set([parent, reply, tail, control].map(header => header.messageId))
        .size,
      4,
      "Four distinct literal IDs isolate this reference chain and control"
    );
    Assert.equal(control.mime2DecodedSubject, parent.mime2DecodedSubject);
    const oldLocation = physical(reply);
    const transfers = [];
    const notification = {
      msgsMoveCopyCompleted(isMove, sources, target, messages) {
        if (target.URI == archive.URI) {
          transfers.push({
            isMove,
            sources: sources.map(header => ({
              folderURI: header.folder.URI,
              key: header.messageKey,
            })),
            keys: messages.map(header => header.messageKey),
          });
        }
      },
    };
    const listener = new PromiseTestUtils.PromiseCopyListener();
    MailServices.mfn.addListener(
      notification,
      MailServices.mfn.msgsMoveCopyCompleted
    );
    try {
      MailServices.copy.copyMessages(
        sent,
        [reply],
        archive,
        true,
        listener,
        null,
        false
      );
      await listener.promise;
    } finally {
      MailServices.mfn.removeListener(notification);
    }
    Assert.equal(
      transfers.length,
      1,
      "One completed physical Sent-to-Archive move"
    );
    Assert.equal(transfers[0].isMove, true);
    Assert.deepEqual(transfers[0].sources, [
      { folderURI: oldLocation.folderURI, key: oldLocation.key },
    ]);
    Assert.equal(transfers[0].keys.length, 1);
    const moved = archive.GetMessageHeader(transfers[0].keys[0]);
    Assert.equal(moved.folder.URI, archive.URI);
    Assert.notDeepEqual(physical(moved), oldLocation);
    const expected = [parent, moved, tail].map(physical);
    const service = await getMailSearchService();
    let progress;
    do {
      progress = await service.update({ limit: 500 });
    } while (progress.moreWork);

    /**
     * Opens the actual selected row's menu and checks its complete physical result.
     *
     * @param {nsIMsgDBHdr} selected - The current physical header to click.
     * @param {object[]} members - Independently injected expected header locations.
     */
    async function openFromMenu(selected, members) {
      await be_in_folder(selected.folder);
      const index = Array.from(
        { length: pane.gDBView.rowCount },
        (_, i) => i
      ).find(
        i => pane.gDBView.getMsgHdrAt(i).messageKey == selected.messageKey
      );
      Assert.notEqual(
        index,
        undefined,
        "The current physical row is displayed"
      );
      await select_click_row(index);
      Assert.deepEqual(
        physical(pane.gDBView.hdrForFirstSelectedMessage),
        physical(selected)
      );
      Assert.equal(pane.gDBView.selection.count, 1);
      const row = pane.threadTree.getRowAtIndex(index);
      Assert.ok(row, "The selected row is rendered in the real main window");
      const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
      EventUtils.synthesizeMouseAtCenter(row, { type: "contextmenu" }, pane);
      await shown;
      const openMenu = menu.querySelector("#mailContext-open");
      const submenu = menu.querySelector("#mailContext-openPopup");
      const submenuShown = BrowserTestUtils.waitForPopupEvent(submenu, "shown");
      openMenu.openMenu(true);
      await submenuShown;
      const item = menu.querySelector("#mailContext-openConversation");
      Assert.ok(
        BrowserTestUtils.isVisible(item),
        "Open Conversation is visible"
      );
      Assert.ok(
        !item.disabled,
        "Open Conversation is enabled for the current header"
      );
      Assert.ok(
        pane.commandController.isCommandEnabled("cmd_openConversation")
      );
      Assert.deepEqual(
        physical(pane.gDBView.hdrForFirstSelectedMessage),
        physical(selected)
      );
      const before = [...tabmail.tabInfo];
      const opened = BrowserTestUtils.waitForEvent(
        tabmail.tabContainer,
        "TabOpen"
      );
      const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
      menu.activateItem(item);
      await hidden;
      const {
        detail: { tabInfo: tab },
      } = await opened;
      const actual = await readMailSearchList(tab);
      Assert.equal(tab.mode.name, "mail3PaneTab");
      Assert.deepEqual(
        tabmail.tabInfo.filter(candidate => !before.includes(candidate)),
        [tab],
        "The real menu command opens exactly one result tab"
      );
      Assert.equal(tabmail.currentTabInfo, tab);
      Assert.deepEqual(
        actual.toSorted((a, b) => a.key - b.key),
        members.toSorted((a, b) => a.key - b.key),
        "Exact complete current physical members"
      );
      Assert.ok(
        actual.every(
          member =>
            member.folderURI != oldLocation.folderURI ||
            member.key != oldLocation.key
        ),
        "The old Sent physical location is absent"
      );
      const resultPane = tab.chromeBrowser.contentWindow;
      await TestUtils.waitForCondition(
        () => resultPane.gDBView.numSelected == 1,
        "The actual menu command selects its clicked physical member"
      );
      Assert.deepEqual(
        physical(resultPane.gDBView.hdrForFirstSelectedMessage),
        physical(selected)
      );
      tabmail.closeTab(tab);
      Assert.equal(tabmail.currentTabInfo, origin);
    }

    await openFromMenu(moved, expected);
    await openFromMenu(control, [physical(control)]);
  }
);
