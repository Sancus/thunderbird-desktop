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
  async function test_facetConversationOpensCompleteThreadAndSelectedCopy() {
    const { tab, context } = await openNativeFacets(fixture.term);
    const message = context.fullSet.find(
      item => Number(item.id) == fixture.clicked.messageKey
    );
    const list = await context.openMailSearchConversation(message, true);
    Assert.ok(
      list,
      "The supplied native conversation facade opens an existing list"
    );
    const { pane, identities } = await readNativeList(list);
    Assert.deepEqual(
      identities,
      fixture.conversation.map(physicalIdentity).sort(),
      "Include non-matching root/tail and both physical Message-ID copies"
    );
    await TestUtils.waitForCondition(() => pane.gDBView.numSelected == 1);
    Assert.equal(
      physicalIdentity(pane.gDBView.hdrForFirstSelectedMessage),
      physicalIdentity(fixture.clicked),
      "The clicked folder/key is selected after asynchronous row delivery"
    );
    Assert.equal(
      tabmail.currentTabInfo,
      tab,
      "Background opening retains the facet tab"
    );
    tabmail.closeTab(list);
    tabmail.closeTab(tab);
  }
);
