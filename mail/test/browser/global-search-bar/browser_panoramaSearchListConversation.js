/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchList.js */

"use strict";

Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchList.js", gTestPath).href,
  this
);

add_task(async function test_openConversationKeepsWholePhysicalMembership() {
  const { ConversationOpener } = ChromeUtils.importESModule(
    "resource:///modules/ConversationOpener.sys.mjs"
  );
  const { MailSearchView } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearchView.sys.mjs"
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["mailnews.database.global.indexer.enabled", true],
      ["mailnews.default_view_flags", 0],
      ["mailnews.default_sort_order", Ci.nsMsgViewSortOrder.ascending],
    ],
  });
  const fixture = makeConversationCommandFixture("nativeconversationopen");
  try {
    Assert.ok(
      ConversationOpener.isMessageIndexed(fixture.selected),
      "An eligible native header needs no Gloda or FTS result token"
    );
    const tabmail = document.getElementById("tabmail");
    const origin = tabmail.currentTabInfo;
    const tab = await new ConversationOpener(
      origin.chromeBrowser.contentWindow
    ).openConversationForMessages([fixture.selected]);
    Assert.equal(tab.mode.name, "mail3PaneTab");
    const actual = await readMailSearchList(tab);
    const order = (left, right) => left.key - right.key;
    Assert.deepEqual(
      actual.toSorted(order),
      fixture.expected.toSorted(order),
      "Every literal root/reply/physical-copy member is present, not the unrelated subject match"
    );
    const pane = tab.chromeBrowser.contentWindow;
    Assert.ok(
      pane.gViewWrapper._syntheticView instanceof MailSearchView,
      "The native path never opens the legacy synthetic view"
    );
    await TestUtils.waitForCondition(
      () => pane.gDBView.numSelected == 1,
      "The requested physical member is selected"
    );
    Assert.deepEqual(
      fixture.physical(pane.gDBView.hdrForFirstSelectedMessage),
      fixture.physical(fixture.selected)
    );
    Assert.equal(
      pane.gViewWrapper._sort[0][1],
      Ci.nsMsgViewSortOrder.ascending,
      "The existing mail-list sort preference remains in use"
    );
    tabmail.closeTab(tab);
    Assert.equal(tabmail.currentTabInfo, origin);
  } finally {
    await fixture.close();
    await SpecialPowers.popPrefEnv();
  }
});
