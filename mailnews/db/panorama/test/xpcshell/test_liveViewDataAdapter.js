/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_delivery.js */

/**
 * This is a series of tests to prove that LiveViewDataAdapter has correctly
 * cached messages from the LiveView. We create a list of the message IDs in
 * the adapter's cache (in `listMessages`) and compare it to a known list of
 * IDs. Empty slots in the cache are `undefined` in the list of expected IDs
 * (usually expanded from a new Array to avoid writing out `undefined` many
 * times over).
 *
 * The messages are from data/messages.sql. There are 10 initially.
 */

const { LiveViewDataAdapter } = ChromeUtils.importESModule(
  "chrome://messenger/content/LiveViewDataAdapter.mjs"
);

const LiveView = Components.Constructor(
  "@mozilla.org/mailnews/live-view;1",
  "nsILiveView"
);

add_setup(async function () {
  await installDBFromFile("db/messages.sql");
  if (typeof PanoramaDelivery != "undefined") {
    PanoramaDelivery.assertBackend("panorama");
  }
});

/**
 * Test that we have the right values to display on the screen.
 */
add_task(async function testColumnContents() {
  const { adapter, tree } = await setUpAdapter("date", "descending");

  try {
    const row2 = adapter.rowAt(2);
    Assert.equal(row2.message.id, 8, "message 8 should be at row 2");
    // We're not going to get into the intricacies of date/time formatting yet.
    // Just check the value is right for sorting.
    Assert.equal(row2.getValue("date"), 1691301720000);
    // FIXME: Address formatting is temporarily disabled.
    // Assert.equal(row2.getText("sender"), "Edgár Stokes <edgar@stokes.invalid>");
    Assert.equal(row2.getText("subject"), "Balanced static project déjà vu");
    Assert.equal(row2.getText("flags"), "0");
    Assert.equal(row2.getText("unread"), "1");
    Assert.equal(row2.getText("flagged"), "0");
    Assert.equal(row2.getText("tags"), "$label1");
    Assert.deepEqual([...row2.properties], ["unread"]);

    const row6 = adapter.rowAt(6);
    Assert.equal(row6.message.id, 4, "message 4 should be at row 6");
    Assert.equal(row6.getValue("date"), 1572784496000);
    // FIXME: Address formatting is temporarily disabled.
    // Assert.equal(row6.getText("sender"), "Eliseo Bauch <eliseo@bauch.invalid>");
    Assert.equal(
      row6.getText("subject"),
      "Proactive intermediate collaboration"
    );
    Assert.equal(row6.getText("flags"), "4");
    Assert.equal(row6.getText("unread"), true);
    Assert.equal(row6.getText("flagged"), true);
    Assert.equal(row6.getText("tags"), "");
    Assert.deepEqual([...row6.properties], ["unread"]);

    messageDB.getMessage(4).orFlags(Ci.nsMsgMessageFlags.Read);
    Assert.equal(row6.getText("flags"), "5");
    Assert.equal(row6.getText("unread"), false);
    Assert.equal(row6.getText("flagged"), true);
    Assert.deepEqual([...row6.properties], ["read"]);

    tree.assertInvalidated(6, 6);
  } finally {
    adapter.setTree(null);
  }
});

async function setUpAdapter(sortColumn, sortDirection) {
  const liveView = new LiveView();
  const adapter = new LiveViewDataAdapter(liveView);
  adapter.sortBy(sortColumn, sortDirection);
  const tree = new ListenerTree();
  adapter.setTree(tree);
  await tree.promiseInvalidated(0, 9);
  return { adapter, tree };
}

/**
 * Test what happens when messages are added or removed.
 */
async function subtestAddRemove(
  sortColumn,
  sortDirection,
  idsInOrder,
  messagesToAdd
) {
  Services.prefs.setIntPref("mail.panorama.bufferRows", 2);

  const { adapter, tree } = await setUpAdapter(sortColumn, sortDirection);

  try {
    Assert.equal(adapter._rowMap.length, 10);
    Assert.equal(adapter.rowCount, 10);

    Assert.deepEqual(listMessages(adapter), idsInOrder);

    const addedBefore = addMessage(messagesToAdd[0]);
    Assert.deepEqual(listMessages(adapter), [addedBefore, ...idsInOrder]);
    tree.assertRowCountChanged(0, 1);

    const addedBetween = addMessage(messagesToAdd[1]);
    const countBefore = sortDirection == "descending" ? 6 : 4;
    Assert.deepEqual(listMessages(adapter), [
      addedBefore,
      ...idsInOrder.slice(0, countBefore),
      addedBetween,
      ...idsInOrder.slice(countBefore, 10),
    ]);
    tree.assertRowCountChanged(countBefore + 1, 1);

    const addedAfter = addMessage(messagesToAdd[2]);
    Assert.deepEqual(listMessages(adapter), [
      addedBefore,
      ...idsInOrder.slice(0, countBefore),
      addedBetween,
      ...idsInOrder.slice(countBefore, 10),
      addedAfter,
    ]);
    tree.assertRowCountChanged(12, 1);

    messageDB.removeMessage(addedBefore);
    Assert.deepEqual(listMessages(adapter), [
      ...idsInOrder.slice(0, countBefore),
      addedBetween,
      ...idsInOrder.slice(countBefore, 10),
      addedAfter,
    ]);
    tree.assertRowCountChanged(0, -1);

    messageDB.removeMessage(addedBetween);
    Assert.deepEqual(listMessages(adapter), [...idsInOrder, addedAfter]);
    tree.assertRowCountChanged(countBefore, -1);

    messageDB.removeMessage(addedAfter);
    Assert.deepEqual(listMessages(adapter), idsInOrder);
    tree.assertRowCountChanged(10, -1);
  } finally {
    adapter.setTree(null);
  }
}

// Sort by date.

const dateDesc = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
const dateAsc = dateDesc.toReversed();

/**
 * Test LiveViewDataAdapter, when sorted by date, descending.
 */
add_task(async function testAddRemoveDateDescending() {
  await subtestAddRemove("date", "descending", dateDesc, [
    { date: "2023-11-14" },
    { date: "2020-09-13" },
    { date: "2017-07-14" },
  ]);
});

/**
 * Test LiveViewDataAdapter, when sorted by date, ascending.
 */
add_task(async function testAddRemoveDateAscending() {
  await subtestAddRemove("date", "ascending", dateAsc, [
    { date: "2017-07-14" },
    { date: "2020-09-13" },
    { date: "2023-11-14" },
  ]);
});

// Sort by subject.

const subjectDesc = [9, 5, 3, 6, 4, 2, 1, 7, 10, 8];
const subjectAsc = subjectDesc.toReversed();

/**
 * Test LiveViewDataAdapter, when sorted by subject, descending.
 */
add_task(async function testAddRemoveSubjectDescending() {
  await subtestAddRemove("subject", "descending", subjectDesc, [
    { subject: "Visionary optimizing benchmark" },
    { subject: "Innovative discrete success" },
    { subject: "Balanced mission-critical encryption" },
  ]);
});

/**
 * Test LiveViewDataAdapter, when sorted by subject, ascending.
 */
add_task(async function testAddRemoveSubjectAscending() {
  await subtestAddRemove("subject", "ascending", subjectAsc, [
    { subject: "Balanced mission-critical encryption" },
    { subject: "Innovative discrete success" },
    { subject: "Visionary optimizing benchmark" },
  ]);
});

const { TreeSelection } = ChromeUtils.importESModule(
  "chrome://messenger/content/TreeSelection.mjs"
);
const {
  LiveViewThreadedDataAdapter,
  LiveViewConversationsDataAdapter,
  LiveViewGroupedDataAdapter,
} = ChromeUtils.importESModule(
  "chrome://messenger/content/LiveViewDataAdapter.mjs"
);

/**
 * Creates complete literal captured rows for direct descriptor tests.
 *
 * @param {number} id - The physical key.
 * @param {number} [folderId=1] - The physical folder.
 * @returns {object} A complete captured row with the same date as its peers.
 */
function threadBatchRow(id, folderId = 1) {
  return {
    id,
    folderId,
    messageId: `batch-${id}@invalid`,
    date: new Date("2026-01-01T12:00:00Z"),
    sender: "sender@invalid",
    recipients: "recipient@invalid",
    subject: "Equal date",
    flags: 0,
    tags: "",
    threadId: id,
    threadParent: 0,
  };
}

/**
 * Creates a flat adapter without a native emitter, retaining real row/selection code.
 *
 * @param {object[]} messages - Existing loaded rows.
 * @returns {object} The adapter, input facade, tree observations and selection.
 */
function threadBatchFixture(messages) {
  const liveView = {
    listener: null,
    setListener(listener) {
      this.listener = listener;
    },
    clearListener(listener) {
      if (this.listener == listener) {
        this.listener = null;
      }
    },
  };
  const adapter = new LiveViewDataAdapter(liveView);
  adapter.sortColumn = "date";
  adapter.sortDirection = "ascending";
  adapter.onSelectedChunk(messages, 0, messages.length - 1);
  const tree = {
    resets: [],
    rowCountChanged() {
      Assert.ok(false, "A batch never emits physical delete/add");
    },
    invalidateRow() {},
    invalidateRange() {},
    reset() {
      this.resets.push(
        Array.from({ length: adapter.rowCount }, (_, i) => [
          adapter.rowAt(i).message.folderId,
          adapter.rowAt(i).message.id,
        ])
      );
    },
  };
  adapter.setTree(tree);
  adapter.selection = new TreeSelection(null);
  adapter.selection._view = adapter;
  registerCleanupFunction(() => adapter.setTree(null));
  return { adapter, liveView, tree, selection: adapter.selection };
}

/**
 * Describes two old components joining a new publication outside this view.
 *
 * @param {LiveViewDataAdapter} adapter - The attached consumer.
 * @param {object[]} before - Complete affected cached preimages.
 * @returns {object} A version 1 descriptor with independent captured postimages.
 */
function threadBatchDescriptor(adapter, before) {
  const publication = threadBatchRow(13, 2);
  return {
    kind: "panorama-thread-batch",
    version: 1,
    batchId: "1",
    viewGeneration: adapter._viewGeneration,
    publication: { folderId: 2, id: 13 },
    componentThreadIds: {
      before: [...new Set(before.map(m => m.threadId))],
      after: [13],
    },
    rows: [
      ...before.map(message => ({
        before: message,
        after: { ...message, threadId: 13, threadParent: 13 },
        matchesBefore: true,
        matchesAfter: true,
      })),
      {
        before: null,
        after: publication,
        matchesBefore: false,
        matchesAfter: false,
      },
    ],
    groups: { before: [], after: [] },
  };
}

add_task(function test_threadBatchKeepsEqualDateRowsAndSelection() {
  const a = threadBatchRow(11),
    b = threadBatchRow(12),
    control = threadBatchRow(14);
  const { adapter, tree, selection } = threadBatchFixture([a, b, control]);
  const original = [adapter.rowAt(0), adapter.rowAt(1), adapter.rowAt(2)];
  selection.rangedSelect(0, 1, false);
  const capturedDate = a.date.valueOf();
  const batch = threadBatchDescriptor(adapter, [a, b]);
  adapter.onMessageAdded(batch);
  Assert.deepEqual(listMessages(adapter), [11, 12, 14]);
  for (let i = 0; i < original.length; i++) {
    Assert.strictEqual(
      adapter.rowAt(i),
      original[i],
      "Surviving row objects are reused"
    );
  }
  Assert.equal(adapter.rowAt(0).message.threadId, 13);
  Assert.equal(adapter.rowAt(1).message.threadParent, 13);
  Assert.strictEqual(
    adapter.rowAt(2).message,
    control,
    "Unaffected row data is untouched"
  );
  Assert.ok(selection.isSelected(0) && selection.isSelected(1));
  Assert.equal(selection.currentIndex, 1);
  Assert.equal(selection.shiftSelectPivot, 0);
  Assert.deepEqual(tree.resets, [
    [
      [1, 11],
      [1, 12],
      [1, 14],
    ],
  ]);
  batch.rows[0].after.date.setTime(0);
  Assert.equal(adapter.rowAt(0).message.date.valueOf(), capturedDate);
});

add_task(function test_threadBatchInstallsPublicationBeforeOneReset() {
  const a = threadBatchRow(11),
    b = threadBatchRow(12);
  const { adapter, tree, selection } = threadBatchFixture([a, b]);
  selection.rangedSelect(0, 1, false);
  const batch = threadBatchDescriptor(adapter, [a, b]);
  batch.rows[2].matchesAfter = true;
  batch.rows[2].after.date = new Date("2025-12-31T12:00:00Z");
  adapter.onMessageAdded(batch);
  Assert.deepEqual(tree.resets, [
    [
      [2, 13],
      [1, 11],
      [1, 12],
    ],
  ]);
  Assert.ok(
    !selection.isSelected(0) &&
      selection.isSelected(1) &&
      selection.isSelected(2)
  );
  Assert.equal(selection.currentIndex, 2);
  Assert.equal(selection.shiftSelectPivot, 1);
});

add_task(function test_threadBatchDepartedRowsDoNotSelectNeighbors() {
  const a = threadBatchRow(11),
    b = threadBatchRow(12),
    control = threadBatchRow(14);
  const { adapter, selection, tree } = threadBatchFixture([a, b, control]);
  selection.rangedSelect(0, 1, false);
  const batch = threadBatchDescriptor(adapter, [a, b]);
  batch.rows[0].matchesAfter = batch.rows[1].matchesAfter = false;
  adapter.onMessageAdded(batch);
  Assert.deepEqual(tree.resets, [[[1, 14]]]);
  Assert.equal(selection.count, 0);
  Assert.equal(selection.currentIndex, -1);
  Assert.equal(selection.shiftSelectPivot, -1);
});

add_task(function test_threadBatchValidationLeavesRowsUntouched() {
  const a = threadBatchRow(11),
    b = threadBatchRow(12);
  const { adapter, tree, selection } = threadBatchFixture([a, b]);
  selection.rangedSelect(0, 1, false);
  const first = adapter.rowAt(0);
  const batch = threadBatchDescriptor(adapter, [a, b]);
  delete batch.rows[1].after.tags;
  Assert.throws(() => adapter.onMessageAdded(batch), /Invalid captured/);
  Assert.strictEqual(adapter.rowAt(0), first);
  Assert.strictEqual(first.message, a, "Earlier valid rows were not installed");
  Assert.equal(selection.count, 2);
  Assert.equal(adapter._viewGeneration, 0);
  Assert.deepEqual(tree.resets, []);
});

add_task(async function test_threadBatchDiscardsOldQueryAndDetachedChunks() {
  const a = threadBatchRow(11),
    b = threadBatchRow(12);
  const { adapter, liveView, tree } = threadBatchFixture([a, b]);
  let resolveCount;
  let selects = 0;
  liveView.countMessages = () =>
    new Promise(resolve => {
      resolveCount = resolve;
    });
  liveView.selectMessages = () => {
    selects++;
    return Promise.resolve();
  };
  const sorting = adapter.sortBy("date", "ascending");
  const stale = liveView.listener;
  adapter.onMessageAdded(threadBatchDescriptor(adapter, [a, b]));
  stale.onSelectedChunk([threadBatchRow(99)], 0, 0);
  resolveCount(99);
  await sorting;
  Assert.equal(
    selects,
    0,
    "Stale count completion cannot start a positional query"
  );
  Assert.deepEqual(listMessages(adapter), [11, 12]);
  Assert.equal(tree.resets.length, 1);
  adapter.setTree(null);
  stale.onSelectedChunk([threadBatchRow(99)], 0, 0);
  Assert.equal(adapter.rowCount, 0, "Detached query cannot resurrect rows");
});

add_task(function test_threadBatchGroupedConsumersRemainHeld() {
  for (const Adapter of [
    LiveViewThreadedDataAdapter,
    LiveViewConversationsDataAdapter,
    LiveViewGroupedDataAdapter,
  ]) {
    const liveView = {
      setListener() {},
      clearListener() {},
      sortColumn: Ci.nsILiveView.DATE,
    };
    const adapter = new Adapter(liveView);
    try {
      const a = threadBatchRow(11);
      adapter.onSelectedChunk(
        [
          {
            ...a,
            messageCount: 2,
            newCount: 0,
            unreadCount: 2,
            dateGroup: Ci.nsILiveView.DATE_GROUP_TODAY,
          },
        ],
        0,
        0
      );
      const row = adapter.rowAt(0);
      const children = Array.from(row.children);
      Assert.throws(
        () => adapter.onMessageAdded(threadBatchDescriptor(adapter, [a])),
        /grouped consumer is held/
      );
      Assert.strictEqual(adapter.rowAt(0), row);
      Assert.deepEqual(
        Array.from(row.children),
        children,
        "Sparse never-loaded children are untouched"
      );
    } finally {
      adapter.setTree(null);
    }
  }
});

add_task(async function test_threadBatchDiscardsStaleSelectCompletion() {
  const a = threadBatchRow(11),
    b = threadBatchRow(12);
  const { adapter, liveView } = threadBatchFixture([a, b]);
  let resolveSelect, resolveStarted;
  const started = new Promise(resolve => {
    resolveStarted = resolve;
  });
  liveView.countMessages = async () => 2;
  liveView.selectMessages = () => {
    liveView.listener.onSelectedChunk([a, b], 0, 1);
    resolveStarted();
    return new Promise(resolve => {
      resolveSelect = resolve;
    });
  };
  const sorting = adapter.sortBy("date", "ascending");
  await started;
  const stale = liveView.listener;
  adapter.onMessageAdded(threadBatchDescriptor(adapter, [a, b]));
  const surviving = adapter.rowAt(0);
  stale.onSelectedChunk([threadBatchRow(99)], 0, 0);
  resolveSelect();
  await sorting;
  Assert.strictEqual(adapter.rowAt(0), surviving);
  Assert.equal(surviving.message.threadId, 13);
  Assert.deepEqual(listMessages(adapter), [11, 12]);
});

add_task(function test_threadBatchRejectsSparseCacheAndIncompleteComponents() {
  const a = threadBatchRow(11),
    b = threadBatchRow(12);
  const { adapter, tree } = threadBatchFixture([a, b]);
  const batch = threadBatchDescriptor(adapter, [a]);
  batch.componentThreadIds.before.push(12);
  Assert.throws(
    () => adapter.onMessageAdded(batch),
    /omits a cached component/
  );
  Assert.deepEqual(listMessages(adapter), [11, 12]);
  adapter._rowMap = new Array(2);
  adapter._clearFlatRowCache();
  Assert.throws(
    () => adapter.onMessageAdded(threadBatchDescriptor(adapter, [a, b])),
    /sparse flat consumer is held/
  );
  Assert.equal(adapter.rowCount, 2);
  Assert.equal(adapter.rowAt(0), null);
  Assert.deepEqual(tree.resets, []);
});

add_task(function test_threadBatchVersionsNeverEnterOrdinaryOverrides() {
  for (const Adapter of [
    LiveViewDataAdapter,
    LiveViewThreadedDataAdapter,
    LiveViewConversationsDataAdapter,
    LiveViewGroupedDataAdapter,
  ]) {
    const adapter = new Adapter({ setListener() {}, clearListener() {} });
    try {
      Assert.throws(
        () =>
          adapter.onMessageAdded({
            kind: "panorama-thread-batch",
            version: 2,
            viewGeneration: 0,
          }),
        /Unsupported thread batch/
      );
      Assert.equal(adapter.rowCount, 0);
    } finally {
      adapter.setTree(null);
    }
  }
});

/**
 * Verifies malformed descriptors leave loaded rows and concrete selection intact.
 *
 * @param {Function} mutate - Changes only the descriptor under test.
 * @param {RegExp} expected - The expected validation error.
 */
function assertThreadBatchDomainRejected(mutate, expected) {
  const messages = [threadBatchRow(11), threadBatchRow(12), threadBatchRow(14)];
  const { adapter, tree, selection, liveView } = threadBatchFixture(messages);
  selection.rangedSelect(0, 1, false);
  adapter._viewGeneration = 7;
  adapter._threadBatchId = 3n;
  const batch = threadBatchDescriptor(adapter, messages.slice(0, 2));
  batch.batchId = "4";
  for (const change of batch.rows) {
    if (change.before) {
      change.before = { ...change.before };
    }
  }
  const rows = messages.map((_, index) => adapter.rowAt(index));
  const state = () => ({
    count: adapter.rowCount,
    rows: adapter._rowMap.map(row => ({
      message: { ...row.message, date: row.message.date.valueOf() },
      texts: { ...row.texts },
      values: { ...row.values },
      properties: [...row.properties],
    })),
    selected: rows.map((_, index) => selection.isSelected(index)),
    selectionCount: selection.count,
    ranges: selection._ranges.map(range => [...range]),
    current: selection.currentIndex,
    pivot: selection.shiftSelectPivot,
    suppressed: selection.selectEventsSuppressed,
    invalidIndices: [...selection._invalidIndices],
    generation: adapter._viewGeneration,
    batchId: adapter._threadBatchId,
    sortColumn: adapter.sortColumn,
    sortDirection: adapter.sortDirection,
  });
  const before = state();
  const rowMap = adapter._rowMap;
  const flatRows = adapter._flatRowCache;
  const texts = rows.map(row => row.texts);
  const values = rows.map(row => row.values);
  const events = [];
  for (const method of [
    "reset",
    "rowCountChanged",
    "invalidateRow",
    "invalidateRange",
    "invalidate",
  ]) {
    tree[method] = (...args) => events.push([method, ...args]);
  }
  tree.view = adapter;
  selection.tree = tree;
  adapter.selectionChanged = () => events.push(["selectionChanged"]);
  mutate(batch);
  Assert.throws(() => adapter.onMessageAdded(batch), expected);
  Assert.strictEqual(adapter._rowMap, rowMap);
  Assert.strictEqual(adapter._flatRowCache, flatRows);
  Assert.strictEqual(adapter._liveView, liveView);
  Assert.strictEqual(liveView.listener, adapter);
  Assert.strictEqual(adapter._queryListener, null);
  for (const [index, row] of rows.entries()) {
    Assert.strictEqual(adapter.rowAt(index), row);
    Assert.strictEqual(row.message, messages[index]);
    Assert.strictEqual(row.texts, texts[index]);
    Assert.strictEqual(row.values, values[index]);
  }
  Assert.deepEqual(
    state(),
    before,
    "All row and selection facts are unchanged"
  );
  Assert.deepEqual(
    events,
    [],
    "Validation cannot notify the tree or selection"
  );
  Assert.deepEqual(tree.resets, []);
}

add_task(function test_threadBatchRejectsInvalidPhysicalDomains() {
  for (const id of [0, 0xffffffff, 0x100000000, -1, 0.5, "13"]) {
    assertThreadBatchDomainRejected(batch => {
      batch.publication.id = batch.rows[2].after.id = id;
      batch.rows[2].matchesAfter = true;
    }, /Invalid thread batch physical identity/);
  }
  for (const folderId of [0, -1, 1.5, 2 ** 53, Infinity]) {
    assertThreadBatchDomainRejected(batch => {
      batch.publication.folderId = batch.rows[2].after.folderId = folderId;
      batch.rows[2].matchesAfter = true;
    }, /Invalid thread batch physical identity/);
  }
  for (const side of ["before", "after"]) {
    for (const id of [0, 0xffffffff, 0x100000000]) {
      assertThreadBatchDomainRejected(batch => {
        batch.rows[1][side].id = id;
      }, /Invalid thread batch physical identity/);
    }
    for (const folderId of [0, 2 ** 53]) {
      assertThreadBatchDomainRejected(batch => {
        batch.rows[1][side].folderId = folderId;
      }, /Invalid thread batch physical identity/);
    }
  }
});

add_task(function test_threadBatchRejectsInvalidNumericDomains() {
  for (const side of ["before", "after"]) {
    for (const field of ["flags", "threadId", "threadParent"]) {
      for (const value of [-1, 0x100000000, 1.5, NaN]) {
        assertThreadBatchDomainRejected(batch => {
          batch.rows[1][side][field] = value;
        }, /Invalid captured thread batch row/);
      }
    }
    for (const value of [-1, 0x100000000, 1.5, NaN]) {
      assertThreadBatchDomainRejected(batch => {
        batch.componentThreadIds[side].push(value);
      }, /Invalid thread batch component identifiers/);
    }
  }
});

add_task(function test_threadBatchRejectsGlobalKeyFolderConflicts() {
  // The first key is captured; the second belongs to an unaffected cached row.
  for (const id of [11, 14]) {
    assertThreadBatchDomainRejected(batch => {
      batch.publication.id = batch.rows[2].after.id = id;
      batch.rows[2].matchesAfter = true;
    }, /Conflicting thread batch global key folder/);
  }
  assertThreadBatchDomainRejected(batch => {
    batch.rows[1].after.folderId = 3;
  }, /Conflicting thread batch global key folder/);
  assertThreadBatchDomainRejected(batch => {
    const message = threadBatchRow(11, 3);
    batch.rows.push({
      before: message,
      after: { ...message },
      matchesBefore: false,
      matchesAfter: false,
    });
  }, /Conflicting thread batch global key folder/);
});

add_task(function test_threadBatchAcceptsNativeNumericBoundaries() {
  const a = threadBatchRow(11);
  const { adapter, tree } = threadBatchFixture([a]);
  const batch = threadBatchDescriptor(adapter, [a]);
  batch.publication = { id: 0xfffffffe, folderId: Number.MAX_SAFE_INTEGER };
  batch.componentThreadIds.after = [0xfffffffe];
  batch.rows[1].after.id = 0xfffffffe;
  batch.rows[1].after.folderId = Number.MAX_SAFE_INTEGER;
  batch.rows[1].matchesAfter = true;
  for (const change of batch.rows) {
    change.after.flags = 0xffffffff;
    change.after.threadId = 0xfffffffe;
    change.after.threadParent = 0;
  }
  adapter.onMessageAdded(batch);
  Assert.deepEqual(listMessages(adapter), [11, 0xfffffffe]);
  Assert.equal(adapter.rowAt(1).message.folderId, Number.MAX_SAFE_INTEGER);
  for (const index of [0, 1]) {
    Assert.equal(adapter.rowAt(index).message.flags, 0xffffffff);
    Assert.equal(adapter.rowAt(index).message.threadId, 0xfffffffe);
    Assert.equal(adapter.rowAt(index).message.threadParent, 0);
  }
  Assert.equal(tree.resets.length, 1);
});

add_task(function test_threadBatchPreservesCapturedThreadAbsenceValues() {
  const a = { ...threadBatchRow(11), threadId: 0, threadParent: 0xffffffff };
  const { adapter, tree } = threadBatchFixture([a]);
  const batch = threadBatchDescriptor(adapter, [a]);
  batch.rows[0].after.threadParent = 0;
  adapter.onMessageAdded(batch);
  Assert.equal(a.threadId, 0, "Historical zero thread value is not rewritten");
  Assert.equal(a.threadParent, 0xffffffff, "Historical None value is retained");
  Assert.equal(adapter.rowAt(0).message.threadId, 13);
  Assert.equal(adapter.rowAt(0).message.threadParent, 0);
  Assert.equal(tree.resets.length, 1);
});
