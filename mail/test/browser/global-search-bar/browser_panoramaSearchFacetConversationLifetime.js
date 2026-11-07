/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchFacets.js */

// Use the same ordinary fixture for every bounded whole-file scenario.
Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchFacets.js", gTestPath).href,
  this
);

add_task(
  async function test_memberDeletedDuringConversationDeliveryClosesPartialList() {
    const { tab, context } = await openNativeFacets(fixture.term);
    const message = context.fullSet.find(
      item => Number(item.id) == fixture.clicked.messageKey
    );
    const tail = fixture.conversation.at(-1);
    const original = fixture.service.streamResultHeaders;
    fixture.service.streamResultHeaders = async function (...args) {
      const result = await original.apply(this, args);
      const key = tail.messageKey;
      fixture.second.deleteMessages([tail], null, true, false, null, false);
      await TestUtils.waitForCondition(
        () => !fixture.second.msgDatabase.containsKey(key),
        "The physical member is removed before search completion"
      );
      return result;
    };
    try {
      const list = await context.openMailSearchConversation(message, false);
      Assert.ok(list);
      await TestUtils.waitForCondition(
        () => !tabmail.tabInfo.includes(list),
        "A member removed before native completion cannot leave a partial successful conversation"
      );
      Assert.equal(tabmail.currentTabInfo, tab);
      Assert.equal(
        tab.browser.contentDocument
          .getElementById("showLoading")
          .getAttribute("data-l10n-id"),
        "facet-view-conversation-stale"
      );
      Assert.ok(
        fixture.first.msgDatabase.containsKey(fixture.clicked.messageKey),
        "The selected physical copy remains; the deleted member is a different row"
      );
      Assert.ok(!fixture.second.msgDatabase.containsKey(tail.messageKey));
    } finally {
      fixture.service.streamResultHeaders = original;
      tabmail.closeTab(tab);
    }
  }
);

add_task(async function test_closedFacetCannotOpenPendingConversation() {
  const { tab, context } = await openNativeFacets(fixture.term);
  const message = context.fullSet.find(
    item => Number(item.id) == fixture.clicked.messageKey
  );
  const original = fixture.service.getConversation;
  let release;
  let captured = false;
  const held = new Promise(resolve => {
    release = resolve;
  });
  fixture.service.getConversation = async function (...args) {
    const snapshot = await original.apply(this, args);
    captured = true;
    await held;
    return snapshot;
  };
  try {
    const opening = context.openMailSearchConversation(message, false);
    await TestUtils.waitForCondition(() => captured);
    tabmail.closeTab(tab);
    const count = tabmail.tabInfo.length;
    release();
    Assert.equal(await opening, null);
    Assert.equal(
      tabmail.tabInfo.length,
      count,
      "No late list or single-message substitute opens"
    );
  } finally {
    release();
    fixture.service.getConversation = original;
    if (tabmail.tabInfo.includes(tab)) {
      tabmail.closeTab(tab);
    }
  }
});
