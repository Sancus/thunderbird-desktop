/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchList.js */

"use strict";

Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchList.js", gTestPath).href,
  this
);

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
