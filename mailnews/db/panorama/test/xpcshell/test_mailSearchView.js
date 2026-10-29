/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { MailSearchView, openMailSearchList } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchView.sys.mjs"
);

add_task(async function test_nativePhysicalHeadersAndCompletion() {
  const folder = {};
  const first = { folder, messageKey: 10, messageId: "same@example.invalid" };
  const second = { folder, messageKey: 20, messageId: "same@example.invalid" };
  const delivered = [];
  const statuses = [];
  let starts = 0;
  let completes = 0;
  const view = new MailSearchView(
    {
      async streamHeaders(text, onHeader, options) {
        Assert.equal(text, "needle");
        Assert.equal(options.andTerms, false);
        onHeader(first);
        onHeader(second);
      },
    },
    "needle",
    false
  );
  await view.search(
    {
      onNewSearch() {
        starts++;
      },
      onSearchHit(header, actualFolder) {
        delivered.push(header);
        Assert.equal(actualFolder, folder);
      },
      onSearchDone(status) {
        statuses.push(status);
      },
    },
    () => completes++
  );
  view.abortSearch();
  Assert.equal(starts, 1);
  Assert.deepEqual(delivered, [first, second]);
  Assert.deepEqual(statuses, [Cr.NS_OK]);
  Assert.equal(completes, 1);
});

add_task(async function test_abortBeforeProducerStarts() {
  let calls = 0;
  let done = 0;
  let complete = 0;
  const view = new MailSearchView(
    {
      async streamHeaders() {
        calls++;
      },
    },
    "needle"
  );
  const pending = view.search(
    {
      onNewSearch() {},
      onSearchHit() {
        Assert.ok(false, "Cancelled view must not receive a hit");
      },
      onSearchDone(status) {
        Assert.equal(status, Cr.NS_BINDING_ABORTED);
        done++;
      },
    },
    () => complete++
  );
  view.abortSearch();
  view.abortSearch();
  await pending;
  Assert.equal(calls, 0);
  Assert.equal(done, 1);
  Assert.equal(complete, 1);
});

add_task(async function test_lateProducerCannotCompleteCancelledViewAgain() {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  registerCleanupFunction(() => release.resolve());
  const delivered = [];
  const statuses = [];
  let complete = 0;
  const view = new MailSearchView(
    {
      async streamHeaders(text, onHeader) {
        entered.resolve();
        await release.promise;
        onHeader({ folder: {}, messageKey: 10 });
      },
    },
    "needle"
  );
  const pending = view.search(
    {
      onNewSearch() {},
      onSearchHit(header) {
        delivered.push(header);
      },
      onSearchDone(status) {
        statuses.push(status);
      },
    },
    () => complete++
  );
  await entered.promise;
  view.abortSearch();
  release.resolve();
  await pending;
  Assert.deepEqual(delivered, []);
  Assert.deepEqual(statuses, [Cr.NS_BINDING_ABORTED]);
  Assert.equal(complete, 1);
});

add_task(async function test_replacementKeepsCallbacksSeparate() {
  const statuses = [];
  const view = new MailSearchView(
    {
      async streamHeaders() {},
    },
    "needle"
  );
  const old = view.search({
    onNewSearch() {},
    onSearchHit() {},
    onSearchDone(status) {
      statuses.push(["old", status]);
    },
  });
  const current = view.search({
    onNewSearch() {},
    onSearchHit() {},
    onSearchDone(status) {
      statuses.push(["current", status]);
    },
  });
  await Promise.all([old, current]);
  Assert.deepEqual(statuses, [
    ["old", Cr.NS_BINDING_ABORTED],
    ["current", Cr.NS_OK],
  ]);
});

add_task(async function test_completionRunsWhenListenerThrows() {
  let complete = 0;
  let done = 0;
  const failure = new Error("Listener failure");
  const view = new MailSearchView({ async streamHeaders() {} }, "needle");
  const pending = view.search(
    {
      onNewSearch() {},
      onSearchHit() {},
      onSearchDone() {
        done++;
        throw failure;
      },
    },
    () => complete++
  );
  Assert.throws(
    () => view.abortSearch(),
    error => error === failure
  );
  await pending;
  Assert.equal(done, 1);
  Assert.equal(complete, 1);
});

add_task(function test_existingMailTabEntry() {
  let starts = 0;
  let opened;
  const service = {
    start() {
      starts++;
    },
    async streamHeaders() {},
  };
  const tab = {};
  const result = openMailSearchList(
    {
      openTab(name, args) {
        opened = { name, args };
        return tab;
      },
    },
    service,
    "needle",
    { andTerms: false, title: "Search results", background: true }
  );
  Assert.equal(result, tab);
  Assert.equal(starts, 1);
  Assert.equal(opened.name, "mail3PaneTab");
  Assert.equal(opened.args.folderPaneVisible, false);
  Assert.equal(opened.args.title, "Search results");
  Assert.equal(opened.args.background, true);
  Assert.ok(opened.args.syntheticView instanceof MailSearchView);
});

add_task(function test_startFailureCompletesOnce() {
  let done = 0;
  let completed = 0;
  const failure = new Error("Search start failed");
  const view = new MailSearchView(
    {
      async streamHeaders() {
        Assert.ok(false, "A failed listener must not start the producer");
      },
    },
    "needle"
  );
  Assert.throws(
    () =>
      view.search(
        {
          onNewSearch() {
            throw failure;
          },
          onSearchHit() {},
          onSearchDone(status) {
            Assert.equal(status, Cr.NS_ERROR_FAILURE);
            done++;
          },
        },
        () => completed++
      ),
    error => error === failure
  );
  view.abortSearch();
  Assert.equal(done, 1);
  Assert.equal(completed, 1);
});

add_task(async function test_facetListCopiesPhysicalMembersAndFinishesOnce() {
  const resultSet = {
    sourceId: "native-source",
    resultSetId: "selected-members",
    items: [
      { id: "20", generation: 7, contentRevision: "body-7", policyRevision: 2 },
    ],
  };
  const header = {
    folder: {},
    messageKey: 20,
    messageId: "same@example.invalid",
  };
  const statuses = [];
  const delivered = [];
  let completes = 0;
  const view = new MailSearchView(
    {
      async streamHeaders() {
        Assert.ok(false, "Facet export must not rerun the text query");
      },
      async streamResultHeaders(actual, onHeader, { signal }) {
        signal.throwIfAborted();
        Assert.equal(actual.resultSetId, "selected-members");
        Assert.deepEqual(actual.items, [
          {
            id: "20",
            generation: 7,
            contentRevision: "body-7",
            policyRevision: 2,
          },
        ]);
        onHeader(header);
      },
    },
    "original words",
    true,
    resultSet
  );
  resultSet.items[0].id = "10";
  resultSet.items.push({ id: "30" });
  await view.search(
    {
      onNewSearch() {},
      onSearchHit(actual) {
        delivered.push(actual.messageKey);
      },
      onSearchDone(status) {
        statuses.push(status);
      },
    },
    () => completes++
  );
  view.abortSearch();
  Assert.deepEqual(delivered, [20]);
  Assert.deepEqual(statuses, [Cr.NS_OK]);
  Assert.equal(completes, 1);
});
