/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { PanoramaSearchIndex } = ChromeUtils.importESModule(
  "resource:///modules/panorama/PanoramaSearchIndex.sys.mjs"
);
const { parseSearchTerms, makeMatchExpression } = ChromeUtils.importESModule(
  "resource:///modules/panorama/SearchTerms.sys.mjs"
);

/**
 * Opens an isolated index with a mutable authoritative document-state fixture.
 *
 * @param {string} name - Unique database name.
 * @returns {Promise<{index: PanoramaSearchIndex, states: Map, file: nsIFile}>}
 *   Index, current-state fixture and database file.
 */
async function openIndex(name) {
  const file = do_get_profile().clone();
  file.append("search-" + name + ".sqlite");
  const states = new Map();
  const index = await PanoramaSearchIndex.open(
    file,
    id => states.get(id) || null
  );
  registerCleanupFunction(() => index.close());
  return { index, states, file };
}

/**
 * Adds one physical document and its independent current-state fixture.
 *
 * @param {PanoramaSearchIndex} index - Index under test.
 * @param {Map} states - Authoritative state fixture.
 * @param {string} id - Physical identity.
 * @param {object} [text={}] - Semantic text fields to override.
 * @returns {Promise<object>} The supplied document.
 */
async function addDocument(index, states, id, text = {}) {
  const document = {
    id,
    generation: 1,
    contentRevision: "text-1",
    subject: "",
    body: "",
    attachmentNames: "",
    author: "",
    recipients: "",
    ...text,
  };
  states.set(id, {
    eligible: true,
    generation: 1,
    contentRevision: "text-1",
    location: { folderId: 10, messageKey: 20 },
    originalContentAvailable: true,
  });
  Assert.ok(await index.index(document), "Current semantic text is indexed");
  return document;
}

add_task(function test_searchTerms() {
  Assert.deepEqual(parseSearchTerms('  cobalt "valley meadow" "'), [
    "cobalt",
    "valley meadow",
  ]);
  Assert.equal(makeMatchExpression(["aa", "cobalt"], false), '"cobalt"');
  Assert.equal(makeMatchExpression(["aa"]), "");
  Assert.equal(makeMatchExpression(["自"]), "自*");
  Assert.equal(makeMatchExpression(["自動"]), '"自動"');
  Assert.equal(makeMatchExpression(['foo"bar']), '"foo bar"');
  Assert.equal(makeMatchExpression(['report"']), '"report "');
});

add_task(async function test_matchingAndPhysicalCopies() {
  const { index, states } = await openIndex("matching");
  await addDocument(index, states, "adjacent", {
    body: "cobalt meadow",
    author: "Sender Decoded",
    attachmentNames: "quarterly-report.pdf",
    recipients: "Recipient Carbon Blind",
  });
  await addDocument(index, states, "separated", {
    body: "cobalt valley meadow",
  });
  await addDocument(index, states, "cross-field", {
    subject: "cobalt",
    body: "meadow",
  });
  await addDocument(index, states, "unicode", { body: "París 自動售貨機" });
  await addDocument(index, states, "copy-a", {
    body: "duplicateneedle",
    messageId: "same@invalid",
  });
  await addDocument(index, states, "copy-b", {
    body: "duplicateneedle",
    messageId: "same@invalid",
  });
  const cases = [
    ["cobalt meadow", true, ["adjacent", "cross-field", "separated"]],
    ['"cobalt meadow"', true, ["adjacent"]],
    ["cobalt NEAR/1 meadow", true, ["adjacent", "separated"]],
    [
      "cobalt duplicateneedle",
      false,
      ["adjacent", "copy-a", "copy-b", "cross-field", "separated"],
    ],
    ["aa cobalt", false, ["adjacent", "cross-field", "separated"]],
    ["paris", true, ["unicode"]],
    ["自", true, ["unicode"]],
    ["自動", true, ["unicode"]],
    ["自動售貨機機", true, []],
    ["decoded", true, ["adjacent"]],
    ["quarterly", true, ["adjacent"]],
    ["carbon", true, ["adjacent"]],
    ["blind", true, ["adjacent"]],
    ["duplicateneedle", true, ["copy-a", "copy-b"]],
  ];
  for (const [text, andTerms, expected] of cases) {
    const page = await index.search(text, { andTerms });
    Assert.deepEqual(page.items.map(item => item.id).sort(), expected, text);
  }
});

add_task(async function test_currentPolicyAndLocation() {
  const { index, states } = await openIndex("policy");
  const document = await addDocument(index, states, "physical", {
    body: "policyneedle",
  });
  const state = states.get("physical");
  state.location = { folderId: 30, messageKey: 40 };
  const page = await index.search("policyneedle");
  Assert.deepEqual(page.items[0].location, { folderId: 30, messageKey: 40 });
  Assert.equal(
    page.items[0].id,
    "physical",
    "Location does not replace identity"
  );

  state.eligible = false;
  Assert.deepEqual((await index.search("policyneedle")).items, []);
  Assert.equal(await index.getText("physical"), null);
  Assert.ok(!(await index.index(document)), "Excluded work cannot refresh FTS");
  state.eligible = true;
  state.generation = 2;
  Assert.deepEqual((await index.search("policyneedle")).items, []);
  Assert.ok(!(await index.index(document)), "Old generations are rejected");
  state.contentRevision = "text-2";
  const current = {
    ...document,
    generation: 2,
    contentRevision: "text-2",
    body: "replacementneedle",
  };
  Assert.ok(await index.index(current));
  Assert.deepEqual((await index.search("policyneedle")).items, []);
  Assert.equal(
    (await index.search("replacementneedle")).items[0].id,
    "physical"
  );
  Assert.ok(!(await index.index(document)));
  states.delete("physical");
  Assert.deepEqual((await index.search("replacementneedle")).items, []);
  await index.remove("physical");
  Assert.equal(await index.getText("physical"), null);
});

add_task(async function test_pagingAndInvalidation() {
  const { index, states } = await openIndex("paging");
  for (const id of ["first", "second", "third", "fourth"]) {
    await addDocument(index, states, id, { body: "pagingneedle" });
  }
  states.get("second").eligible = false;
  const first = await index.search("pagingneedle", { limit: 1 });
  const second = await index.search("pagingneedle", {
    limit: 1,
    cursor: first.cursor,
  });
  const third = await index.search("pagingneedle", {
    limit: 1,
    cursor: second.cursor,
  });
  Assert.deepEqual(
    [first.items[0].id, second.items[0].id, third.items[0].id],
    ["first", "third", "fourth"]
  );
  Assert.equal(first.resultSetId, second.resultSetId);
  Assert.equal(second.resultSetId, third.resultSetId);
  Assert.equal(third.cursor, null);
  Assert.throws(
    () => index.search("different", { cursor: first.cursor }),
    /Cursor/
  );
  await index.remove("third");
  await Assert.rejects(
    index.search("pagingneedle", { cursor: first.cursor }),
    /index changed/
  );
});

add_task(async function test_recoveredTextAndUtf8Offsets() {
  const { index, states, file } = await openIndex("recovery");
  await addDocument(index, states, "recovered", { body: "éclipse comet" });
  states.get("recovered").location = null;
  states.get("recovered").originalContentAvailable = false;
  await index.rebuild();
  await index.close();
  const reopened = await PanoramaSearchIndex.open(
    file,
    id => states.get(id) || null
  );
  registerCleanupFunction(() => reopened.close());
  const page = await reopened.search("comet");
  Assert.equal(page.items[0].id, "recovered");
  Assert.equal(page.items[0].contentRevision, "text-1");
  Assert.equal(
    page.items[0].offsetsUtf8,
    "1 0 9 5",
    "FTS3 offsets use UTF-8 bytes"
  );
  Assert.equal(page.items[0].location, null);
  Assert.equal(page.items[0].originalContentAvailable, false);
  Assert.equal((await reopened.getText("recovered")).body, "éclipse comet");
  Assert.throws(
    () => reopened.index({ id: "invalid", body: undefined }),
    /Expected document string/
  );
});

add_task(async function test_cancellationAndReuse() {
  const file = do_get_profile().clone();
  file.append("search-cancel.sqlite");
  const state = {
    eligible: true,
    generation: 1,
    contentRevision: "text-1",
    location: null,
    originalContentAvailable: false,
  };
  let block = false;
  let entered;
  const resolving = new Promise(resolve => {
    entered = resolve;
  });
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const index = await PanoramaSearchIndex.open(file, async () => {
    if (block) {
      entered();
      await gate;
    }
    return state;
  });
  registerCleanupFunction(() => {
    release();
    return index.close();
  });
  Assert.ok(
    await index.index({
      id: "cancel",
      generation: 1,
      contentRevision: "text-1",
      subject: "",
      body: "cancelneedle",
      attachmentNames: "",
      author: "",
      recipients: "",
    })
  );
  block = true;
  const controller = new AbortController();
  const reason = new Error("Query cancelled");
  const pending = index.search("cancelneedle", { signal: controller.signal });
  await resolving;
  controller.abort(reason);
  await Assert.rejects(pending, error => error === reason);
  block = false;
  release();
  Assert.equal((await index.search("cancelneedle")).items[0].id, "cancel");
  const aborted = new AbortController();
  aborted.abort(reason);
  await Assert.rejects(
    index.search("cancelneedle", { signal: aborted.signal }),
    error => error === reason
  );
  await index.close();
  await Assert.rejects(index.search("cancelneedle"), /closed/);
});

add_task(async function test_embeddedQuoteMatching() {
  const { index, states } = await openIndex("embedded-quotes");
  await addDocument(index, states, "adjacent", { body: "foo bar report" });
  await addDocument(index, states, "separated", { body: "foo gap bar" });
  await addDocument(index, states, "alternative", { body: "cobalt" });
  await addDocument(index, states, "reversed", { body: "bar foo" });
  for (const [text, andTerms, expected] of [
    ['foo"bar', true, ["adjacent"]],
    ['foo"bar', false, ["adjacent"]],
    ['cobalt foo"bar', false, ["adjacent", "alternative"]],
    ['report"', true, ["adjacent"]],
  ]) {
    const page = await index.search(text, { andTerms });
    Assert.deepEqual(page.items.map(hit => hit.id).sort(), expected, text);
  }
});
