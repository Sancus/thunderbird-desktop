/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchList.js */

"use strict";

Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchList.js", gTestPath).href,
  this
);

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
