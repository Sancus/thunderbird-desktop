/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchCompletion.js */

// Use the same ordinary fixture for every bounded whole-file scenario.
Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchCompletion.js", gTestPath).href,
  this
);

add_task(
  async function test_nativeToolbarPersonUsesLiteralSelectionAndSource() {
    // The native backend preference is frozen at startup; changing it here
    // would violate its StaticPrefs debug assertion before any UI is tested.
    Assert.ok(Services.prefs.getBoolPref("mail.panorama.enabled"));
    await SpecialPowers.pushPrefEnv({
      set: [["gloda.show_as_list_by_default", true]],
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
    await TestUtils.waitForCondition(() => input.popup.mPopupOpen);
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
    Assert.equal(provider.curResult.matchCount, 0);
    Assert.equal(input.popup.richlistbox.children.length, 0);
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
    Assert.equal(
      input.popup.selectedIndex,
      -1,
      "Pending rows are not selectable"
    );
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
    Assert.equal(
      input.popup.selectedIndex,
      -1,
      "The old person choice is not restored"
    );
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
    Assert.equal(input.popup.selectedIndex, 0);
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
    const hidden = input.popup.mPopupOpen
      ? BrowserTestUtils.waitForEvent(input.popup, "popuphidden")
      : Promise.resolve();
    input.dispatchEvent(new CustomEvent("autocomplete", { detail: "" }));
    await hidden;
    if (list) {
      tabmail.closeTab(list);
    }
    if (currentCard) {
      book.deleteCards([currentCard]);
    }
    // Finish the real cleanup notification before another test queries people.
    let progress;
    do {
      progress = await fixture.service.update({ limit: 500 });
    } while (progress.moreWork);
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
    info(
      "Native completion diagnostic: " +
        JSON.stringify({
          query: tab.mailSearch,
          sourceId: context.mailSearchResultSet?.sourceId,
          resultItems: context.mailSearchResultSet?.items.map(item => ({
            id: item.id,
            tagKeys: item.tagKeys,
          })),
          sort: context._sortBy,
          relevantCount: context._relevantSortedItems?.length,
          dateCount: context._dateSortedItems?.length,
          headers: fixture.folders.slice(0, 2).map(folder =>
            [...folder.messages].map(header => ({
              key: header.messageKey,
              keywords: header.getStringProperty("keywords"),
            }))
          ),
        })
    );
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
