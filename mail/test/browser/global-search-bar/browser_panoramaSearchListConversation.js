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

add_task(async function test_openConversationPolicyAndErrors() {
  const { ConversationOpener } = ChromeUtils.importESModule(
    "resource:///modules/ConversationOpener.sys.mjs"
  );
  const { MailSearchService } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearchService.sys.mjs"
  );
  const { sinon } = ChromeUtils.importESModule(
    "resource://testing-common/Sinon.sys.mjs"
  );
  await SpecialPowers.pushPrefEnv({
    set: [["mailnews.database.global.indexer.enabled", true]],
  });
  const fixture = makeConversationCommandFixture("nativeconversationpolicy");
  const tabmail = document.getElementById("tabmail");
  const origin = tabmail.currentTabInfo;
  let stub;
  try {
    fixture.selected.setStringProperty("junkscore", "100");
    Assert.ok(!ConversationOpener.isMessageIndexed(fixture.selected));
    fixture.selected.setStringProperty("junkscore", "0");
    await SpecialPowers.pushPrefEnv({
      set: [["mailnews.database.global.indexer.enabled", false]],
    });
    try {
      Assert.ok(!ConversationOpener.isMessageIndexed(fixture.selected));
      Assert.equal(
        await new ConversationOpener(
          origin.chromeBrowser.contentWindow
        ).openConversationForMessages([fixture.selected]),
        null
      );
      Assert.equal(tabmail.tabInfo.length, 1, "Disabled search opens no tab");
    } finally {
      await SpecialPowers.popPrefEnv();
    }
    const error = new Error("Native conversation lookup failed");
    stub = sinon
      .stub(MailSearchService.prototype, "getConversationForHeader")
      .rejects(error);
    await Assert.rejects(
      new ConversationOpener(
        origin.chromeBrowser.contentWindow
      ).openConversationForMessages([fixture.selected]),
      value => value === error,
      "The original native error is preserved without a legacy fallback"
    );
    Assert.equal(tabmail.tabInfo.length, 1);
  } finally {
    stub?.restore();
    await fixture.close();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_openConversationCancelsClosedOrigin() {
  const { ConversationOpener } = ChromeUtils.importESModule(
    "resource:///modules/ConversationOpener.sys.mjs"
  );
  const { MailSearchService } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearchService.sys.mjs"
  );
  const { sinon } = ChromeUtils.importESModule(
    "resource://testing-common/Sinon.sys.mjs"
  );
  await SpecialPowers.pushPrefEnv({
    set: [["mailnews.database.global.indexer.enabled", true]],
  });
  const fixture = makeConversationCommandFixture("nativeconversationcancel");
  const tabmail = document.getElementById("tabmail");
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const original = MailSearchService.prototype.getConversationForHeader;
  const stub = sinon
    .stub(MailSearchService.prototype, "getConversationForHeader")
    .callsFake(async function (header, options) {
      const result = await original.call(this, header, options);
      entered.resolve();
      await release.promise;
      return result;
    });
  let opening;
  try {
    const origin = tabmail.openTab("mail3PaneTab", {
      folderURI: fixture.folders[0].URI,
    });
    await TestUtils.waitForCondition(
      () => origin.chromeBrowser.contentWindow?.gDBView,
      "The real origin mail pane is initialized"
    );
    opening = new ConversationOpener(
      origin.chromeBrowser.contentWindow
    ).openConversationForMessages([fixture.selected]);
    opening.catch(entered.reject);
    await entered.promise;
    tabmail.closeTab(origin);
    Assert.equal(
      await opening,
      null,
      "Closing the origin settles before delayed delivery"
    );
    release.resolve();
    await TestUtils.waitForTick();
    Assert.equal(
      tabmail.tabInfo.length,
      1,
      "Delayed native completion creates no late tab"
    );
  } finally {
    release.resolve();
    stub.restore();
    if (opening) {
      await opening.catch(() => {});
    }
    await fixture.close();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_openConversationRejectsMovedSelection() {
  await checkStaleConversationSelection("move");
});
