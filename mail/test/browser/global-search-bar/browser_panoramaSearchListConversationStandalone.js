/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchList.js */

"use strict";

Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchList.js", gTestPath).href,
  this
);

add_task(async function test_openConversationFromStandaloneWindow() {
  const { ConversationOpener } = ChromeUtils.importESModule(
    "resource:///modules/ConversationOpener.sys.mjs"
  );
  const { MailUtils } = ChromeUtils.importESModule(
    "resource:///modules/MailUtils.sys.mjs"
  );
  const { promise_new_window } = ChromeUtils.importESModule(
    "resource://testing-common/mail/WindowHelpers.sys.mjs"
  );
  const { wait_for_message_display_completion } = ChromeUtils.importESModule(
    "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["mailnews.database.global.indexer.enabled", true],
      ["mailnews.default_view_flags", 0],
    ],
  });
  const fixture = makeConversationCommandFixture("nativeconversationwindow");
  let origin;
  try {
    const opened = promise_new_window("mail:messageWindow");
    MailUtils.openMessageInNewWindow(fixture.selected);
    origin = await opened;
    await wait_for_message_display_completion(origin, true);
    Assert.equal(origin.document.getElementById("tabmail"), null);
    const tabmail = document.getElementById("tabmail");
    const tab = await new ConversationOpener(
      origin
    ).openConversationForMessages([fixture.selected]);
    const actual = await readMailSearchList(tab);
    const order = (left, right) => left.key - right.key;
    Assert.deepEqual(actual.toSorted(order), fixture.expected.toSorted(order));
    const pane = tab.chromeBrowser.contentWindow;
    Assert.deepEqual(
      fixture.physical(pane.gDBView.hdrForFirstSelectedMessage),
      fixture.expected[2],
      "The standalone origin opens the selected physical copy in the existing mail window"
    );
    await BrowserTestUtils.closeWindow(origin);
    origin = null;
    Assert.ok(
      tabmail.tabInfo.includes(tab),
      "Closing the completed origin keeps its result tab"
    );
    Assert.deepEqual(
      fixture.physical(pane.gDBView.hdrForFirstSelectedMessage),
      fixture.expected[2]
    );
    tabmail.closeTab(tab);
  } finally {
    if (origin && !origin.closed) {
      await BrowserTestUtils.closeWindow(origin);
    }
    await fixture.close();
    await SpecialPowers.popPrefEnv();
  }
});
