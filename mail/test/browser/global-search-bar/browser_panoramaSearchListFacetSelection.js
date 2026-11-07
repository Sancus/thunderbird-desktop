/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchList.js */

"use strict";

Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchList.js", gTestPath).href,
  this
);

add_task(async function testMailSearchActiveFacetExportsCapturedMembers() {
  await SpecialPowers.pushPrefEnv({
    set: [["mailnews.default_view_flags", 0]],
  });
  const fixture = await makeMailSearchFixture("panoramafacetneedle", 2);
  const { findMailSearchResults } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearch.sys.mjs"
  );
  const { getMailSearchFacets } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearchResult.sys.mjs"
  );
  const full = await findMailSearchResults("panoramafacetneedle");
  Assert.equal(full.items.length, 3);
  const groups = getMailSearchFacets(full);
  Assert.equal(groups.resultSetId, full.resultSetId);
  const tagged = groups.tags.find(group => group.value == "$label1");
  Assert.ok(tagged);
  Assert.equal(tagged.ids.length, 2);
  const active = {
    ...full,
    items: full.items.filter(item => tagged.ids.includes(item.id)),
  };
  const expected = fixture.expected.filter(item =>
    tagged.ids.includes(String(item.key))
  );
  Assert.equal(expected.length, 2);
  Assert.equal(expected[0].messageId, expected[1].messageId);
  const tabmail = document.getElementById("tabmail");
  const pending = tabmail.openTab("glodaTableList", {
    mailSearch: { resultSet: active },
    title: "Active tag facet",
  });
  active.items.length = 0;
  const tab = await pending.searchPromise;
  const actual = await readMailSearchList(tab);
  const byKey = (a, b) =>
    a.key - b.key || a.folderURI.localeCompare(b.folderURI);
  Assert.deepEqual(actual.toSorted(byKey), expected.toSorted(byKey));
  Assert.equal(
    actual.length,
    2,
    "Export neither reruns all three hits nor loses an equal-ID copy"
  );
  tabmail.closeTab(tab);
  await SpecialPowers.popPrefEnv();
});
