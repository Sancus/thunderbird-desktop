/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchList.js */

"use strict";

Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchList.js", gTestPath).href,
  this
);

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
