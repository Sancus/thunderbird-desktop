/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchCompletion.js */

// Use the same ordinary fixture for every bounded whole-file scenario.
Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchCompletion.js", gTestPath).href,
  this
);

// DIAG-013 (diagnostic only, never a candidate): native revision state of both fixture copies.
function diagStates(label) {
  const states = fixture.expected.map(([uri, key]) => {
    const s = fixture.service.resolveDocument(String(key));
    return s && {
      id: s.id,
      eligible: s.eligible,
      generation: s.generation,
      policyRevision: s.policyRevision,
      contentRevision: s.contentRevision,
      location: s.location,
      uri,
    };
  });
  info("DIAG013 " + label + " " + JSON.stringify(states));
}

add_task(
  async function test_nativeResultInputSurvivesControllerStopBeforeEnter() {
    await SpecialPowers.pushPrefEnv({
      set: [["gloda.show_as_list_by_default", false]],
    });
    let owner;
    let opened;
    try {
      owner = tabmail.openTab("glodaFacet", {
        mailSearch: { text: "nativecompletionneedle" },
      });
      await TestUtils.waitForCondition(() => owner.searchPromise);
      await owner.searchPromise;
      const input = owner.panel.querySelector(".remote-gloda-search");
      // Completion enumerates only current indexed projections. Settle native
      // work queued by the previous consumer before starting this input.
      let progress;
      do {
        progress = await fixture.service.update({ limit: 500 });
      } while (progress.moreWork);
      Assert.equal(progress.pending, 0, JSON.stringify(progress));
      Assert.equal(progress.acceptedThrough, progress.sourceWatermark);
      input.focus();
      input.value = "completionperson";
      const previous = provider.curResult;
      input.controller.startSearch("completionperson");
      // nsAutoCompleteController starts its provider through a delayed timer.
      await TestUtils.waitForCondition(() => provider.curResult != previous);
      const result = await completionResult("completionperson");
      info(
        JSON.stringify({
          searchParam: input.searchParam,
          userContextId: input.userContextId,
          searchString: result.searchString,
          sourceId: result.sourceId,
          rows: result.rows,
          indexingEnabled: Services.prefs.getBoolPref(
            "mailnews.database.global.indexer.enabled"
          ),
        })
      );
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
      opened = tabmail.currentTabInfo;
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
    } finally {
      for (const tab of [opened, owner]) {
        if (tab && tabmail.tabInfo.includes(tab)) {
          tabmail.closeTab(tab);
        }
      }
      await SpecialPowers.popPrefEnv();
      diagStates("after-test1");
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
    diagStates("after-test2");
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
    diagStates("test3-before-update");
    // Use the current native projection, including work queued by the owner tab.
    let progress;
    do {
      progress = await fixture.service.update({ limit: 500 });
    } while (progress.moreWork);
    diagStates("test3-after-update");
    Assert.equal(progress.pending, 0, JSON.stringify(progress));
    Assert.equal(progress.acceptedThrough, progress.sourceWatermark);
    input.focus();
    input.value = "completionperson";
    const previous = provider.curResult;
    input.controller.startSearch("completionperson");
    await TestUtils.waitForCondition(
      () => provider.curResult != previous,
      "The current input owns a fresh native completion"
    );
    const result = await completionResult("completionperson");
    diagStates("test3-after-completion");
    info("DIAG013 rows " + JSON.stringify(result.rows));
    info(
      "DIAG014 result " +
        JSON.stringify({
          same: result === provider.curResult,
          searchString: result.searchString,
          active: result.active,
          ongoing: result.ongoing,
          failed: result.failed,
          sourceId: result.sourceId,
          searchParam: input.searchParam,
          indexer: Services.prefs.getBoolPref(
            "mailnews.database.global.indexer.enabled"
          ),
          matchCount: input.controller.matchCount,
          controllerSearch: input.controller.searchString,
        })
    );
    if (!result.rows.some(row => row.type == "person")) {
      info("DIAG013 direct " + JSON.stringify(await fixture.service.complete("completionperson")));
      let more;
      do {
        more = await fixture.service.update({ limit: 500 });
      } while (more.moreWork);
      info("DIAG013 update-again " + JSON.stringify(more));
      diagStates("test3-after-update-again");
      info("DIAG013 direct-again " + JSON.stringify(await fixture.service.complete("completionperson")));
    }
    assertCompletionInputOwnership(input);
    const index = result.rows.findIndex(row => row.type == "person");
    Assert.greaterOrEqual(index, 0, "The native completion has a person row");
    // The controller receives the settled provider result asynchronously.
    await TestUtils.waitForCondition(
      () => input.controller.matchCount > index,
      "The popup holds the native completion rows"
    );
    input.popup.selectedIndex = index;
    Assert.equal(
      input.popup.selectedIndex,
      index,
      "The person completion is selected"
    );
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

add_task(async function test_nativeQuickFilterUsesStartupBackend() {
  Assert.ok(Services.prefs.getBoolPref("mail.panorama.enabled"));
  const { be_in_folder } = ChromeUtils.importESModule(
    "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
  );
  await SpecialPowers.pushPrefEnv({
    set: [["gloda.show_as_list_by_default", false]],
  });
  try {
    await be_in_folder(fixture.folders[2]);
    const { set_filter_text } = ChromeUtils.importESModule(
      "resource://testing-common/mail/QuickFilterBarHelpers.sys.mjs"
    );
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
    diagStates("qfb-before-collect");
    const snapshot = await fixture.service.collectResults(
      "nativecompletionneedle"
    );
    info("DIAG014 qfb-snapshot " + JSON.stringify({ sourceId: snapshot.sourceId, ids: snapshot.items.map(i => i.id) }));
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
    tab.searchPromise?.then(
      () => info("DIAG014 qfb-facet fullSet " + tab.browser?.contentWindow?.FacetContext?.fullSet?.length),
      e => info("DIAG014 qfb-facet rejected " + e)
    );
    Assert.equal(tab.mode.name, "glodaFacet");
    Assert.equal(tab.mailSearch.text, "nativecompletionneedle");
    await TestUtils.waitForCondition(() => tab.searchPromise);
    await tab.searchPromise;
    Assert.equal(tab.browser.contentWindow.FacetContext.fullSet.length, 2);
    tabmail.closeTab(tab);
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

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
