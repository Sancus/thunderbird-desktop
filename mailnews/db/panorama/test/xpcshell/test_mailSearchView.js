/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { MailSearchView, openMailSearchList, openMailSearchResultsList } =
  ChromeUtils.importESModule(
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
      async streamResultHeaders(actual, onHeader, { signal, requireComplete }) {
        Assert.ok(requireComplete);
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
        return { resultSetId: actual.resultSetId, count: 1 };
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

add_task(
  async function test_capturedListWaitsForDeliveryAndReleasesCancellation() {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    registerCleanupFunction(() => release.resolve());
    const selected = {
      sourceId: "native-source",
      resultSetId: "both",
      items: [{ id: "10" }, { id: "20" }],
    };
    const delivered = [];
    const statuses = [];
    const monitors = new Set();
    const tab = {};
    const tabmail = {
      tabInfo: [],
      registerTabMonitor(monitor) {
        monitors.add(monitor);
      },
      unregisterTabMonitor(monitor) {
        monitors.delete(monitor);
      },
      openTab(name, { syntheticView }) {
        Assert.equal(name, "mail3PaneTab");
        this.tabInfo.push(tab);
        for (const monitor of monitors) {
          monitor.onTabTitleChanged(tab);
        }
        syntheticView.search({
          onNewSearch() {},
          onSearchHit(header) {
            delivered.push(header.messageKey);
          },
          onSearchDone(status) {
            statuses.push(status);
          },
        });
        return tab;
      },
      closeTab() {
        Assert.ok(false, "Successful delivery keeps the mail tab");
      },
    };
    const controller = new AbortController();
    const pending = openMailSearchResultsList(
      tabmail,
      {
        start() {},
        async streamResultHeaders(actual, onHeader, { requireComplete }) {
          Assert.ok(requireComplete);
          entered.resolve();
          await release.promise;
          onHeader({ messageKey: 10, folder: {} });
          onHeader({ messageKey: 20, folder: {} });
          return { resultSetId: actual.resultSetId, count: 2 };
        },
      },
      selected,
      { signal: controller.signal }
    );
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await entered.promise;
    Assert.ok(!settled, "A created tab is not a completed captured set");
    release.resolve();
    Assert.equal(await pending, tab);
    Assert.deepEqual(delivered, [10, 20]);
    Assert.deepEqual(statuses, [Cr.NS_OK]);
    Assert.equal(monitors.size, 0);
    controller.abort(new Error("The placeholder closed after success"));
    Assert.deepEqual(tabmail.tabInfo, [tab]);
  }
);

add_task(async function test_capturedListRejectsIncompleteDeliveryAndClosure() {
  const selected = {
    sourceId: "native-source",
    resultSetId: "both",
    items: [{ id: "10" }, { id: "20" }],
  };
  const tab = {};
  let monitor,
    view,
    closed = 0;
  const statuses = [];
  const tabmail = {
    tabInfo: [],
    registerTabMonitor(value) {
      monitor = value;
    },
    unregisterTabMonitor(value) {
      Assert.equal(value, monitor);
      monitor = null;
    },
    openTab(name, { syntheticView }) {
      view = syntheticView;
      this.tabInfo.push(tab);
      view.search({
        onNewSearch() {},
        onSearchHit() {},
        onSearchDone(status) {
          statuses.push(status);
        },
      });
      return tab;
    },
    closeTab(actual) {
      Assert.equal(actual, tab);
      monitor.onTabClosing(tab);
      this.tabInfo.splice(this.tabInfo.indexOf(tab), 1);
      closed++;
    },
  };
  await Assert.rejects(
    openMailSearchResultsList(
      tabmail,
      {
        start() {},
        async streamResultHeaders() {
          return { resultSetId: "both", count: 1 };
        },
      },
      selected
    ),
    error => error.result == Cr.NS_ERROR_IN_PROGRESS
  );
  Assert.equal(closed, 1);
  Assert.deepEqual(statuses, [Cr.NS_ERROR_IN_PROGRESS]);
  Assert.equal(monitor, null);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  registerCleanupFunction(() => release.resolve());
  const pending = openMailSearchResultsList(
    tabmail,
    {
      start() {},
      async streamResultHeaders() {
        entered.resolve();
        await release.promise;
        return { resultSetId: "both", count: 2 };
      },
    },
    selected
  );
  await entered.promise;
  const rejected = (async () => {
    await Assert.rejects(pending, error => error.name == "AbortError");
  })();
  tabmail.closeTab(tab);
  await rejected;
  release.resolve();
  Assert.equal(closed, 2);
  Assert.deepEqual(statuses, [Cr.NS_ERROR_IN_PROGRESS, Cr.NS_BINDING_ABORTED]);
  Assert.equal(monitor, null);
});

add_task(async function test_initialDeliveryKeepsOriginalError() {
  const error = new Error("Native header resolution failed");
  const view = new MailSearchView(
    {
      async streamHeaders() {
        throw error;
      },
    },
    "needle"
  );
  const rejected = (async () => {
    await Assert.rejects(view.whenReady, actual => actual === error);
  })();
  await view.search({
    onNewSearch() {},
    onSearchHit() {},
    onSearchDone(status) {
      Assert.equal(status, Cr.NS_ERROR_FAILURE);
    },
  });
  await rejected;
});
