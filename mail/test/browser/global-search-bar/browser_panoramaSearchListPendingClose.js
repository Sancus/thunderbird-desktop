/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchList.js */

"use strict";

Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchList.js", gTestPath).href,
  this
);

add_task(async function testClosingPendingMailSearchDoesNotOpenAList() {
  const { getMailSearchService } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearch.sys.mjs"
  );
  await getMailSearchService();
  const tabmail = document.getElementById("tabmail");
  const before = [...tabmail.tabInfo];
  const pending = tabmail.openTab("glodaTableList", {
    mailSearch: { text: "panoramacancelledneedle" },
  });
  const operation = pending.searchPromise;
  tabmail.closeTab(pending);
  await Assert.rejects(operation, error => error.name == "AbortError");
  Assert.deepEqual(
    tabmail.tabInfo,
    before,
    "Closing the pending tab cannot create a late result tab"
  );
});
