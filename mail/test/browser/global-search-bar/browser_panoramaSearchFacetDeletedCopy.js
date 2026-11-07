/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchFacets.js */

// Use the same ordinary fixture for every bounded whole-file scenario.
Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchFacets.js", gTestPath).href,
  this
);

add_task(async function test_deletedFacetCopyDoesNotOpenItsMessageIdPeer() {
  const { tab, context } = await openNativeFacets(fixture.term);
  const message = context.fullSet.find(
    item => Number(item.id) == fixture.clicked.messageKey
  );
  fixture.first.deleteMessages(
    [fixture.clicked],
    null,
    true,
    false,
    null,
    false
  );
  await TestUtils.waitForCondition(
    () => !fixture.first.msgDatabase.containsKey(fixture.clicked.messageKey),
    "The selected physical header was deleted from the actual store"
  );
  const count = tabmail.tabInfo.length;
  Assert.equal(await context.openMailSearchConversation(message, false), null);
  Assert.equal(tabmail.tabInfo.length, count);
  Assert.ok(
    fixture.second.msgDatabase.containsKey(fixture.secondCopy.messageKey),
    "The excluded peer substitution control still exists in the physical store"
  );
  Assert.equal(
    tab.browser.contentDocument
      .getElementById("showLoading")
      .getAttribute("data-l10n-id"),
    "facet-view-conversation-stale"
  );
  tabmail.closeTab(tab);
});
