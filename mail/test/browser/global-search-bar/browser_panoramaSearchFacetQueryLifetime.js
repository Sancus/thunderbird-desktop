/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchFacets.js */

// Use the same ordinary fixture for every bounded whole-file scenario.
Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchFacets.js", gTestPath).href,
  this
);

add_task(async function test_chatQueryFailureKeepsHealthyNativeMailResults() {
  const { tab, context } = await openNativeFacets(fixture.term);
  registerCleanupFunction(() => {
    if (tabmail.tabInfo.includes(tab)) {
      tabmail.closeTab(tab);
    }
  });
  const win = Cu.waiveXrays(tab.browser.contentWindow);
  const original = win.findChatSearchResults;
  const originalReportError = win.console.error;
  const reportedErrors = [];
  const failure = new Error("The chat query failed independently of mail");
  let chatQueries = 0;
  await SpecialPowers.pushPrefEnv({ set: [["mail.chat.enabled", true]] });
  win.findChatSearchResults = async (_text, { signal }) => {
    signal.throwIfAborted();
    chatQueries++;
    throw failure;
  };
  win.console.error = (...args) => reportedErrors.push(args);
  try {
    for (let query = 0; query < 2; query++) {
      const result = await context.loadMailSearch();
      Assert.ok(result, "Healthy mail settles despite the same chat failure");
      Assert.deepEqual(
        context.fullSet.map(item => Number(item.id)).sort((a, b) => a - b),
        fixture.matches.map(header => header.messageKey).sort((a, b) => a - b),
        "Every real physical mail copy remains searchable"
      );
      const doc = tab.browser.contentDocument;
      Assert.greater(
        doc.querySelectorAll("facet-result-message").length,
        0,
        "The retained view renders actual mail result cards"
      );
      Assert.equal(
        doc.querySelectorAll(".native-chat-result").length,
        0,
        "A rejected chat collection cannot publish transcript rows"
      );
      Assert.equal(
        reportedErrors.length,
        query + 1,
        "Each failed chat query is separately reported once"
      );
      Assert.equal(reportedErrors[query]?.length, 1);
      Assert.equal(
        reportedErrors[query]?.[0],
        failure,
        "Report the original chat error without replacing or wrapping it"
      );
      Assert.ok(!doc.getElementById("results").countNode.hidden);
      Assert.ok(!doc.getElementById("gloda-facet-view").inert);
    }
  } finally {
    win.findChatSearchResults = original;
    win.console.error = originalReportError;
    await SpecialPowers.popPrefEnv();
  }
  Assert.equal(chatQueries, 2, "Both queries reach the same failed chat input");
  Assert.equal(win.findChatSearchResults, original, "Restore the scoped hook");
  Assert.equal(win.console.error, originalReportError, "Restore the reporter");
  tabmail.closeTab(tab);
});

add_task(async function test_replacedFacetQueryCannotInstallOldResults() {
  const { tab, context } = await openNativeFacets(fixture.term);
  const original = fixture.service.collectResults;
  let release;
  let signalCollected;
  const collected = new Promise(resolve => {
    signalCollected = resolve;
  });
  const held = new Promise(resolve => {
    release = resolve;
  });
  fixture.service.collectResults = async function (...args) {
    const results = await original.apply(this, args);
    signalCollected();
    await held;
    return results;
  };
  try {
    const old = context.loadMailSearch();
    await collected;
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
