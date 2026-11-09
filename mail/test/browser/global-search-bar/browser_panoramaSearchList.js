/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchList.js */

"use strict";

// The 102-message native fixture setup alone takes about 90s on Windows ASan.
requestLongerTimeout(2);

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
