/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchList.js */

"use strict";

Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchList.js", gTestPath).href,
  this
);

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
