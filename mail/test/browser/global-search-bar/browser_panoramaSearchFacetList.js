/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchFacets.js */

// Use the same ordinary fixture for every bounded whole-file scenario.
Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchFacets.js", gTestPath).href,
  this
);

add_task(async function test_nativeFacetListRetainsPhysicalMembersAndOrigin() {
  await be_in_folder(fixture.excluded);
  const origin = tabmail.currentTabInfo;
  const pane = origin.chromeBrowser.contentWindow;
  const visible = pane.quickFilterBar.filterer.visible;
  pane.commandController.doCommand("cmd_showQuickFilterBar");
  registerCleanupFunction(() => {
    pane.commandController.doCommand("cmd_resetQuickFilterBar");
    if (pane.quickFilterBar.filterer.visible != visible) {
      pane.commandController.doCommand("cmd_toggleQuickFilterBar");
    }
  });
  await set_filter_text(fixture.term);
  // The real folder/filter setup can queue metadata projection work. The
  // global UI accepts one bounded update; finish fixture work before testing it.
  let progress;
  do {
    progress = await fixture.service.update({ limit: 500 });
  } while (progress.moreWork);
  Assert.equal(progress.pending, 0, JSON.stringify(progress));
  Assert.equal(progress.acceptedThrough, progress.sourceWatermark);
  info("Native facet replay settled: " + JSON.stringify(progress));
  Assert.equal(
    pane.gDBView.numMsgsInView,
    0,
    "Local filter excludes every global hit"
  );
  info("Native facet UI query starting");
  pane.document.getElementById("qfb-qs-textbox").dispatchEvent(
    new pane.CustomEvent("search", {
      detail: fixture.term,
      cancelable: true,
    })
  );
  const tab = tabmail.currentTabInfo;
  Assert.equal(
    tab.mode.name,
    "glodaFacet",
    "Preserve the user's facet preference"
  );
  Assert.equal(
    tab.mailSearch.text,
    fixture.term,
    "Use the native query argument"
  );
  await TestUtils.waitForCondition(() => tab.searchPromise);
  await tab.searchPromise;
  info("Native facet UI query completed");
  const context = tab.browser.contentWindow.FacetContext;
  Assert.equal(
    context.fullSet.length,
    fixture.matches.length,
    "The compact list fixture retains every physical member"
  );
  const tag = context.faceters.find(faceter => faceter.field == "tags");
  Assert.ok(
    tag.orderedGroups.every(([value]) => value?.id != "not-a-ui-tag"),
    "Arbitrary native keywords do not become user-visible tags"
  );
  const group = tag.orderedGroups.find(([value]) => value?.id == "$label1")[0];
  context.addFacetConstraint(tag, true, [group], false, false);
  Assert.equal(
    context.activeSet.length,
    2,
    "Two physical copies with one Message-ID remain distinct"
  );
  const row = tab.browser.contentDocument.querySelector("facet-result-message");
  Assert.equal(row.author.textContent, "Reply Sender");
  Assert.equal(row.author.title, "facetreply@example.invalid");
  Assert.deepEqual(
    Array.from(
      row.querySelectorAll(".message-attachment"),
      node => node.textContent
    ),
    ["retained.pdf", "retained.png"]
  );

  // Folder/view initialization may have changed native metadata while these
  // widgets were exercised. Keep the refinement, and capture current tokens.
  await context.loadMailSearch({ preserveFilters: true });
  const list = await context.showActiveSetInTab();
  Assert.deepEqual(
    (await readNativeList(list)).identities,
    [fixture.clicked, fixture.secondCopy].map(physicalIdentity).sort()
  );
  tabmail.closeTab(list);
  tabmail.closeTab(tab);
  Assert.equal(tabmail.currentTabInfo, origin);
  Assert.equal(
    pane.quickFilterBar.filterer.filterValues.text.text,
    fixture.term
  );
  Assert.equal(
    pane.gDBView.numMsgsInView,
    0,
    "Escalation keeps the original folder and filter"
  );
  pane.commandController.doCommand("cmd_resetQuickFilterBar");
});
