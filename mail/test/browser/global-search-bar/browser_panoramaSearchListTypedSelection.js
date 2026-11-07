/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchList.js */

"use strict";

Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchList.js", gTestPath).href,
  this
);

add_task(async function testMailSearchTypedSelectionIsCapturedBeforeOpening() {
  await SpecialPowers.pushPrefEnv({
    set: [["mailnews.default_view_flags", 0]],
  });
  const fixture = await makeMailSearchFixture("panoramatypedneedle", 1);
  const selection = {
    type: "person",
    emails: ["panoramatypedneedle@example.invalid"],
  };
  const tabmail = document.getElementById("tabmail");
  const pending = tabmail.openTab("glodaTableList", {
    mailSearch: { selection },
  });
  selection.emails[0] = "another-person@example.invalid";
  const tab = await pending.searchPromise;
  const actual = await readMailSearchList(tab);
  const byKey = (a, b) =>
    a.key - b.key || a.folderURI.localeCompare(b.folderURI);
  Assert.deepEqual(actual.toSorted(byKey), fixture.expected.toSorted(byKey));
  Assert.equal(actual.length, 2);
  tabmail.closeTab(tab);
  await SpecialPowers.popPrefEnv();
});
