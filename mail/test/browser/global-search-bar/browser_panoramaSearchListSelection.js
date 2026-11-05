/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchList.js */

"use strict";

Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchList.js", gTestPath).href,
  this
);

add_task(async function testInvalidMailSearchSelectionDoesNotFallBack() {
  const tabmail = document.getElementById("tabmail");
  const before = [...tabmail.tabInfo];
  const pending = tabmail.openTab("glodaTableList", {
    mailSearch: { selection: { type: "unsupported" } },
  });
  await Assert.rejects(
    pending.searchPromise,
    /Expected a person or tag search selection/
  );
  Assert.deepEqual(
    tabmail.tabInfo,
    before,
    "An invalid selection rejects without a legacy result tab"
  );
});
