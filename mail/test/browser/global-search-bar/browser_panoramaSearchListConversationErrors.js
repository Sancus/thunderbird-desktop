/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchList.js */

"use strict";

Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchList.js", gTestPath).href,
  this
);

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
