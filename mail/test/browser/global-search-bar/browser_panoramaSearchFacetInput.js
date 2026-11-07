/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchFacets.js */

// Use the same ordinary fixture for every bounded whole-file scenario.
Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchFacets.js", gTestPath).href,
  this
);

add_task(async function test_nativeFacetInputKeepsItsBackend() {
  const { tab } = await openNativeFacets(fixture.term);
  const input = tab.panel.querySelector(".remote-gloda-search");
  input.value = "nativefacetinputnomatches";
  input.doSearch();
  const replacement = tabmail.currentTabInfo;
  Assert.notEqual(replacement, tab);
  Assert.equal(replacement.mode.name, "glodaFacet");
  Assert.equal(replacement.mailSearch.text, "nativefacetinputnomatches");
  await TestUtils.waitForCondition(() => replacement.searchPromise);
  const result = await replacement.searchPromise;
  Assert.equal(
    result.items.length,
    0,
    "The retained input performs a real native query"
  );
  tabmail.closeTab(replacement);
});
