/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { PanoramaSearchIndex } = ChromeUtils.importESModule(
  "resource:///modules/panorama/PanoramaSearchIndex.sys.mjs"
);
const { MailSearchService } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchService.sys.mjs"
);
const { getSearchHighlightRanges } = ChromeUtils.importESModule(
  "resource:///modules/panorama/SearchOffsets.sys.mjs"
);

/**
 * Opens real FTS3 storage with independent physical state and literal text.
 *
 * @param {string} name - Isolated database filename.
 * @param {{id: string, body?: string, subject?: string, author?: string,
 *   recipients?: string, attachmentNames?: string}[]} definitions - Physical copies.
 * @returns {Promise<{index: PanoramaSearchIndex, states: Map}>} Index and state fixture.
 */
async function queryFixture(name, definitions) {
  const file = do_get_profile().clone();
  file.append("query-" + name + ".sqlite");
  const states = new Map();
  const index = await PanoramaSearchIndex.open(
    file,
    id => states.get(id) || null
  );
  registerCleanupFunction(() => index.close());
  for (const definition of definitions) {
    const document = {
      generation: 1,
      contentRevision: "source-1",
      subject: "",
      body: "",
      author: "",
      recipients: "",
      attachmentNames: "",
      ...definition,
    };
    states.set(document.id, {
      eligible: true,
      generation: 1,
      contentRevision: "source-1",
      location: { folderId: 10, messageKey: Number(document.id) },
      originalContentAvailable: true,
    });
    Assert.ok(await index.index(document));
  }
  return { index, states };
}

add_task(async function test_pagesThroughStaleRowsAndPhysicalCopies() {
  const { index, states } = await queryFixture("sparse", [
    { id: "101", body: "é 😀 café" },
    { id: "102", body: "é 😀 café" },
    { id: "103", body: "é 😀 café" },
    { id: "104", body: "é 😀 café" },
    { id: "105", body: "é 😀 café" },
    { id: "106", body: "é 😀 café" },
    { id: "107", body: "unrelated" },
    { id: "108", body: "é 😀 café" },
    { id: "109", body: "é 😀 café" },
    { id: "110", body: "é 😀 café" },
    { id: "111", body: "é 😀 café" },
    { id: "112", body: "é 😀 café" },
  ]);
  // The first raw batch and the trailing raw batch contain no eligible hit.
  states.get("101").eligible = false;
  states.get("102").generation = 2;
  states.delete("103");
  states.get("105").eligible = false;
  states.get("106").location = { folderId: 20, messageKey: 106 };
  states.get("108").contentRevision = "source-2";
  states.get("109").originalContentAvailable = false;
  states.get("110").eligible = false;
  states.delete("111");
  states.get("112").generation = 2;

  const first = await index.search("cafe", { limit: 2 });
  Assert.deepEqual(first.items.map(hit => hit.id).sort(), ["104", "106"]);
  Assert.ok(first.cursor, "Another eligible physical copy remains");
  const second = await index.search("cafe", { limit: 2, cursor: first.cursor });
  Assert.deepEqual(
    second.items.map(hit => hit.id),
    ["109"]
  );
  Assert.equal(
    second.cursor,
    null,
    "Stale trailing matches do not create an empty page"
  );
  Assert.equal(first.resultSetId, second.resultSetId);
  Assert.notEqual(
    first.items[0].id,
    first.items[1].id,
    "Identical text keeps both physical copies"
  );
  Assert.deepEqual(
    first.items.map(hit => hit.location.folderId).sort((a, b) => a - b),
    [10, 20]
  );
  Assert.equal(second.items[0].originalContentAvailable, false);
  for (const hit of [...first.items, ...second.items]) {
    Assert.equal(
      hit.offsetsUtf8,
      "1 0 8 5",
      "Byte offsets survive paging unchanged"
    );
    const text = await index.getText(hit.id);
    Assert.equal(text.textRevision, hit.textRevision);
    Assert.deepEqual(getSearchHighlightRanges(hit, text), [
      { start: 5, end: 9 },
    ]);
    Assert.equal(text.body.slice(5, 9), "café");
  }
});

add_task(async function test_offsetsUseReplacementFieldOrder() {
  const { index } = await queryFixture("fields", [
    {
      id: "201",
      subject: "é subjectneedle",
      body: "é 😀 bodyneedle",
      attachmentNames: "😀 attachmentneedle.pdf",
      author: "é authorneedle",
      recipients: "😀 recipientneedle",
    },
  ]);
  for (const [query, field, offsets, start, end] of [
    ["subjectneedle", "subject", "0 0 3 13", 2, 15],
    ["bodyneedle", "body", "1 0 8 10", 5, 15],
    ["attachmentneedle", "attachmentNames", "2 0 5 16", 3, 19],
    ["authorneedle", "author", "3 0 3 12", 2, 14],
    ["recipientneedle", "recipients", "4 0 5 15", 3, 18],
  ]) {
    const page = await index.search(query);
    Assert.deepEqual(
      page.items.map(hit => hit.id),
      ["201"],
      query
    );
    const hit = page.items[0];
    Assert.equal(hit.offsetsUtf8, offsets, field);
    const text = await index.getText("201");
    Assert.deepEqual(getSearchHighlightRanges(hit, text, field), [
      { start, end },
    ]);
    Assert.equal(text[field].slice(start, end), query);
    if (field != "body") {
      Assert.deepEqual(
        getSearchHighlightRanges(hit, text),
        [],
        "Another field's offsets never highlight the body"
      );
    }
  }
});

add_task(async function test_offsetsRejectChangedTextAndAnotherCopy() {
  const { index, states } = await queryFixture("revision", [
    { id: "301", body: "é 😀 café" },
    { id: "302", body: "é 😀 café" },
  ]);
  const page = await index.search("cafe");
  const hit = page.items.find(item => item.id == "301");
  const original = await index.getText("301");
  Assert.deepEqual(getSearchHighlightRanges(hit, original), [
    { start: 5, end: 9 },
  ]);
  Assert.equal(
    getSearchHighlightRanges(hit, await index.getText("302")),
    null,
    "Identical text from another physical copy cannot supply offsets"
  );
  states.get("301").generation = 2;
  states.get("301").contentRevision = "source-2";
  Assert.ok(
    await index.index({
      ...original,
      generation: 2,
      contentRevision: "source-2",
      body: "new prefix é 😀 café",
    })
  );
  const current = await index.getText("301");
  Assert.notEqual(current.textRevision, hit.textRevision);
  Assert.equal(
    getSearchHighlightRanges(hit, current),
    null,
    "An old hit cannot highlight the current projection"
  );
  Assert.equal(getSearchHighlightRanges(hit, null), null);
});

add_task(async function test_cancelTextLookupBeforeDelivery() {
  const file = do_get_profile().clone();
  file.append("query-text-cancel.sqlite");
  const state = {
    eligible: true,
    generation: 1,
    contentRevision: "source-1",
    location: null,
    originalContentAvailable: false,
  };
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  let block = false;
  let calls = 0;
  const index = await PanoramaSearchIndex.open(file, async () => {
    calls++;
    if (block) {
      entered.resolve();
      await released.promise;
    }
    return state;
  });
  registerCleanupFunction(() => {
    released.resolve();
    return index.close();
  });
  Assert.ok(
    await index.index({
      id: "401",
      generation: 1,
      contentRevision: "source-1",
      subject: "",
      body: "canceltextneedle",
      attachmentNames: "",
      author: "",
      recipients: "",
    })
  );
  block = true;
  const controller = new AbortController();
  const reason = new Error("Cancel stored text");
  const pending = index.getText("401", { signal: controller.signal });
  await entered.promise;
  controller.abort(reason);
  await Assert.rejects(pending, error => error === reason);
  block = false;
  released.resolve();
  Assert.equal((await index.getText("401")).body, "canceltextneedle");
  const before = calls;
  await Assert.rejects(
    index.getText("401", { signal: controller.signal }),
    error => error === reason
  );
  Assert.equal(
    calls,
    before,
    "An already cancelled lookup never resolves a physical document"
  );
});

add_task(async function test_explicitMetadataEnumerationKeepsPhysicalPages() {
  const { index, states } = await queryFixture("metadata-pages", [
    { id: "501", subject: "first" },
    { id: "502", subject: "excluded" },
    { id: "503", subject: "last" },
  ]);
  states.get("502").eligible = false;
  states.get("503").originalContentAvailable = false;
  Assert.deepEqual((await index.search("")).items, []);
  const first = await index.search("", { matchAll: true, limit: 1 });
  Assert.deepEqual(
    first.items.map(hit => hit.id),
    ["501"]
  );
  Assert.ok(first.cursor);
  Assert.throws(
    () => index.search("", { cursor: first.cursor }),
    /Cursor does not belong/
  );
  const last = await index.search("", {
    matchAll: true,
    limit: 1,
    cursor: first.cursor,
  });
  Assert.equal(last.resultSetId, first.resultSetId);
  Assert.deepEqual(
    last.items.map(hit => hit.id),
    ["503"]
  );
  Assert.equal(last.cursor, null);
  Assert.equal(last.items[0].originalContentAvailable, false);
  for (const hit of [...first.items, ...last.items]) {
    Assert.equal(hit.offsetsUtf8, "", "Enumeration invents no FTS offsets");
    Assert.deepEqual(
      getSearchHighlightRanges(hit, await index.getText(hit.id)),
      []
    );
  }
});

add_task(async function test_streamsEveryPageWithMetadataOnlyRows() {
  do_get_profile();
  loadExistingDB();
  const pref = "mailnews.database.global.indexer.enabled";
  const hadPref = Services.prefs.prefHasUserValue(pref);
  const oldPref = Services.prefs.getBoolPref(pref, false);
  Services.prefs.setBoolPref(pref, true);
  registerCleanupFunction(() =>
    hadPref
      ? Services.prefs.setBoolPref(pref, oldPref)
      : Services.prefs.clearUserPref(pref)
  );
  const folder = MailServices.accounts
    .createLocalMailAccount()
    .incomingServer.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("native-header-pages");
  const file = do_get_profile().clone();
  file.append("native-header-pages.sqlite");
  const service = await MailSearchService.open(file, database.sourceId, messageDB);
  registerCleanupFunction(() => service.close());
  const expected = [];
  for (let i = 0; i < 105; i++) {
    expected.push(
      messageDB.addMessage(
        folder.id,
        "paging@example.invalid",
        [],
        123456,
        "Sender <sender@example.invalid>",
        "",
        "",
        "",
        "allpagesneedle",
        0,
        "",
        Ci.nsMsgPriority.notSet
      )
    );
  }
  for (let i = 0; ; i++) {
    Assert.less(i, 200, "The native pagination fixture finishes bounded work");
    if (!(await service.update({ limit: 500 })).moreWork) {
      break;
    }
  }
  const actual = [];
  const result = await service.streamHeaders("allpagesneedle", header =>
    actual.push(header.messageKey)
  );
  Assert.equal(
    result.count,
    105,
    "The list is not truncated at one query page"
  );
  Assert.deepEqual(
    actual.sort((a, b) => a - b),
    expected.sort((a, b) => a - b)
  );
  const page = await service.search("allpagesneedle", { limit: 1 });
  Assert.equal(page.items[0].bodyIndexed, false);
  Assert.equal(page.items[0].originalContentAvailable, false);
  const controller = new AbortController();
  const reason = new Error("Stop native list");
  const partial = [];
  await Assert.rejects(
    service.streamHeaders(
      "allpagesneedle",
      header => {
        partial.push(header.messageKey);
        controller.abort(reason);
      },
      { signal: controller.signal }
    ),
    error => error === reason
  );
  Assert.equal(partial.length, 1, "Cancellation stops later physical copies");
  await service.close();
  for (const key of expected) {
    messageDB.removeMessage(key);
  }
});
