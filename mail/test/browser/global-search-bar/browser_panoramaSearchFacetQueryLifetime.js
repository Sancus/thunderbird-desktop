/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchFacets.js */

// Use the same ordinary fixture for every bounded whole-file scenario.
Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchFacets.js", gTestPath).href,
  this
);

add_task(async function test_replacedFacetQueryCannotInstallOldResults() {
  const { tab, context } = await openNativeFacets(fixture.term);
  const original = fixture.service.collectResults;
  let release;
  let collected = false;
  const held = new Promise(resolve => {
    release = resolve;
  });
  fixture.service.collectResults = async function (...args) {
    const results = await original.apply(this, args);
    collected = true;
    await held;
    return results;
  };
  try {
    const old = context.loadMailSearch();
    await TestUtils.waitForCondition(() => collected);
    fixture.service.collectResults = original;
    tab.mailSearch.text = "nomatchreplacementfacetquery";
    await context.loadMailSearch();
    release();
    Assert.equal(
      await old,
      null,
      "Observe and discard the old completed query"
    );
    Assert.equal(context.fullSet.length, 0);
    Assert.equal(context.activeSet.length, 0);
    Assert.equal(
      tab.browser.contentDocument.getElementById("showEmpty").style.display,
      "block"
    );
    Assert.notEqual(
      tab.browser.contentDocument
        .getElementById("showLoading")
        .getAttribute("data-l10n-id"),
      "facet-view-search-error",
      "Cancellation is not an error or old-result success"
    );
  } finally {
    release();
    fixture.service.collectResults = original;
    tabmail.closeTab(tab);
  }
});

add_task(async function test_facetQueryFailureIsNotAnEmptySuccess() {
  const { tab, context } = await openNativeFacets(fixture.term);
  const original = fixture.service.collectResults;
  fixture.service.collectResults = async () => {
    throw new Error("Facet query failure");
  };
  try {
    Assert.equal(await context.loadMailSearch(), null);
    Assert.equal(
      tab.browser.contentDocument
        .getElementById("showLoading")
        .getAttribute("data-l10n-id"),
      "facet-view-search-error"
    );
    Assert.equal(
      tab.browser.contentDocument.getElementById("showEmpty").style.display,
      "none"
    );
    Assert.equal(
      tab.browser.contentDocument.querySelectorAll("facet-result-message")
        .length,
      0
    );
  } finally {
    fixture.service.collectResults = original;
    tabmail.closeTab(tab);
  }
});
