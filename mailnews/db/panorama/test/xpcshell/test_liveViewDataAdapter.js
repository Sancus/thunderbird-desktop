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

// Only opted-in flat adds change their event contract. Shared sparse/grouped
// ListenerTree behavior, exact row assertions and ordinary removals stay strict.
class FlatPublicationTree extends ListenerTree {
  resets = 0;
  reset() {
    Assert.strictEqual(
      this._index,
      undefined,
      "No intermediate row-count event"
    );
    Assert.strictEqual(this._start, undefined, "No intermediate invalidation");
    this.resets++;
  }
  assertSettledPublication() {
    Assert.equal(this.resets, 1, "Exactly one settled native publication");
    Assert.strictEqual(this._index, undefined);
    Assert.strictEqual(this._start, undefined);
    this.resets = 0;
  }
}

async function setUpAdapter(sortColumn, sortDirection) {
  const liveView = new LiveView();
  const adapter = new LiveViewDataAdapter(liveView);
  adapter.sortBy(sortColumn, sortDirection);
  const tree = new FlatPublicationTree();
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
    tree.assertSettledPublication();

    const addedBetween = addMessage(messagesToAdd[1]);
    const countBefore = sortDirection == "descending" ? 6 : 4;
    Assert.deepEqual(listMessages(adapter), [
      addedBefore,
      ...idsInOrder.slice(0, countBefore),
      addedBetween,
      ...idsInOrder.slice(countBefore, 10),
    ]);
    tree.assertSettledPublication();

    const addedAfter = addMessage(messagesToAdd[2]);
    Assert.deepEqual(listMessages(adapter), [
      addedBefore,
      ...idsInOrder.slice(0, countBefore),
      addedBetween,
      ...idsInOrder.slice(countBefore, 10),
      addedAfter,
    ]);
    tree.assertSettledPublication();

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
 * @param {Function} [Adapter=LiveViewDataAdapter] - The retained adapter type.
 * @returns {object} The adapter, input facade, tree observations and selection.
 */
function threadBatchFixture(messages, Adapter = LiveViewDataAdapter) {
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
  const adapter = new Adapter(liveView);
  liveView.sortColumn =
    Adapter == LiveViewGroupedDataAdapter
      ? Ci.nsILiveView.SUBJECT
      : Ci.nsILiveView.DATE;
  adapter.sortColumn =
    Adapter == LiveViewGroupedDataAdapter ? "subject" : "date";
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
          adapter.rowAt(i).message?.folderId,
          adapter.rowAt(i).message?.id,
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

/**
 * Captures complete groups from literal rows, without consulting the live facade.
 *
 * @param {object[]} messages - Matching captured facts for one side.
 * @param {string} [column="threadId"] - The grouping field.
 * @returns {object[]} Complete group memberships and independently counted totals.
 */
function capturedThreadGroups(messages, column = "threadId") {
  const groups = new Map();
  for (const message of messages) {
    const value = message[column];
    if (!groups.has(value)) {
      groups.set(value, {
        key: { kind: column == "threadId" ? "thread" : "sort", value },
        representative: { folderId: message.folderId, id: message.id },
        members: [],
        messageCount: 0,
        newCount: 0,
        unreadCount: 0,
      });
    }
    const group = groups.get(value);
    group.members.push({ folderId: message.folderId, id: message.id });
    group.messageCount++;
    group.newCount += !!(message.flags & Ci.nsMsgMessageFlags.New);
    group.unreadCount += !(message.flags & Ci.nsMsgMessageFlags.Read);
  }
  return [...groups.values()];
}

/**
 * Adds complete captured groups to the existing physical merge fixture.
 *
 * @param {LiveViewDataAdapter} adapter - The attached retained consumer.
 * @param {object[]} before - Complete affected preimages.
 * @param {string} [column="threadId"] - The grouping field.
 * @returns {object} A complete merge with one matching publication.
 */
function groupedThreadBatch(adapter, before, column = "threadId") {
  const batch = threadBatchDescriptor(adapter, before);
  batch.rows.at(-1).matchesAfter = true;
  batch.groups.before = capturedThreadGroups(before, column);
  batch.groups.after = capturedThreadGroups(
    batch.rows.map(row => row.after),
    column
  );
  return batch;
}

/**
 * Creates a retained closed thread summary from independently supplied members.
 *
 * @param {object[]} members - Literal physical members, representative first.
 * @returns {object} The summary expected by the existing native select API.
 */
function threadBatchSummary(members) {
  const group = capturedThreadGroups(members)[0];
  return {
    ...members[0],
    messageCount: group.messageCount,
    newCount: group.newCount,
    unreadCount: group.unreadCount,
  };
}

add_task(function test_threadBatchCapabilityAndSequentialGenerations() {
  for (const Adapter of [
    LiveViewDataAdapter,
    LiveViewThreadedDataAdapter,
    LiveViewConversationsDataAdapter,
    LiveViewGroupedDataAdapter,
  ]) {
    const { adapter } = threadBatchFixture([], Adapter);
    for (const listener of [adapter, adapter._makeQueryListener(0)]) {
      for (const name of [
        "panoramaThreadBatchVersion",
        "panoramaThreadBatchGeneration",
        "panoramaThreadBatchOwner",
        "panoramaThreadBatchInvalidated",
      ]) {
        Assert.ok(
          Object.hasOwn(
            Object.getOwnPropertyDescriptor(listener, name),
            "value"
          )
        );
      }
      Assert.equal(listener.panoramaThreadBatchVersion, 1);
      Assert.strictEqual(listener.panoramaThreadBatchOwner, adapter);
    }
  }
  const { adapter, liveView, tree } = threadBatchFixture([threadBatchRow(11)]);
  const oldQuery = adapter._makeQueryListener(adapter._queryGeneration);
  adapter.onMessageAdded(threadBatchDescriptor(adapter, [threadBatchRow(11)]));
  const second = threadBatchDescriptor(adapter, [
    { ...threadBatchRow(11), threadId: 13, threadParent: 13 },
  ]);
  second.batchId = "2";
  second.publication.id = second.rows.at(-1).after.id = 16;
  second.componentThreadIds.after = [16];
  second.rows[0].after.threadId = second.rows[0].after.threadParent = 16;
  second.rows.at(-1).after.threadId = 16;
  adapter.onMessageAdded(second);
  Assert.equal(
    adapter._viewGeneration,
    0,
    "Attachment generation survives consecutive batches"
  );
  Assert.equal(
    adapter._queryGeneration,
    2,
    "Both positional queries are invalidated"
  );
  Assert.equal(adapter.rowAt(0).message.threadId, 16);
  oldQuery.onSelectedChunk([threadBatchRow(11)], 0, 0);
  Assert.equal(
    adapter.rowAt(0).message.threadId,
    16,
    "Old chunks cannot restore the old thread"
  );
  Assert.strictEqual(liveView.listener, adapter);
  Assert.equal(tree.resets.length, 2);
});

add_task(function test_threadBatchNeverOpenedThreadsMergeWithoutReadingHoles() {
  const a = threadBatchRow(11),
    child = { ...threadBatchRow(15), threadId: 11, threadParent: 11 };
  const b = threadBatchRow(12),
    control = threadBatchRow(14);
  const { adapter, tree } = threadBatchFixture(
    [
      threadBatchSummary([a, child]),
      threadBatchSummary([b]),
      threadBatchSummary([control]),
    ],
    LiveViewThreadedDataAdapter
  );
  const untouched = adapter.rowAt(2);
  Assert.equal(adapter.rowAt(0).children[0], undefined);
  adapter.onMessageAdded(groupedThreadBatch(adapter, [a, child, b]));
  Assert.equal(adapter.rowCount, 2);
  Assert.equal(adapter.rowAt(0).thread.messageCount, 4);
  Assert.equal(adapter.rowAt(0).children.length, 3);
  Assert.ok(adapter.rowAt(0).children.every(Boolean));
  Assert.ok(!adapter.rowAt(0).open);
  Assert.strictEqual(adapter.rowAt(1), untouched);
  Assert.equal(adapter.rowAt(0).unreadCount, 4);
  Assert.deepEqual(tree.resets, [
    [
      [1, 11],
      [1, 14],
    ],
  ]);
});

add_task(
  async function test_threadBatchMergeKeepsExpandedSelectedPhysicalChild() {
    const a = threadBatchRow(11),
      child = { ...threadBatchRow(15), threadId: 11, threadParent: 11 };
    const b = threadBatchRow(12),
      control = threadBatchRow(14);
    const { adapter, liveView, selection, tree } = threadBatchFixture(
      [
        threadBatchSummary([a, child]),
        threadBatchSummary([b]),
        threadBatchSummary([control]),
      ],
      LiveViewThreadedDataAdapter
    );
    liveView.selectMessagesInGroup = async () =>
      [a, child].map(row => ({ ...row }));
    const oldRoot = adapter.rowAt(0),
      untouched = adapter.rowAt(2);
    await oldRoot.ensureChildren(adapter, 0);
    oldRoot.open = true;
    adapter._clearFlatRowCache();
    const selected = adapter.rowAt(1);
    selection.rangedSelect(1, 1, false);
    const batch = groupedThreadBatch(adapter, [a, child, b]);
    // The actual publication is the new root; both old roots become children.
    batch.groups.after[0].representative = batch.publication;
    adapter.onMessageAdded(batch);
    Assert.equal(adapter.rowCount, 5);
    Assert.ok(adapter.rowAt(0).open);
    Assert.strictEqual(
      adapter.rowAt(1),
      oldRoot,
      "Demoted root retains its physical row object"
    );
    Assert.strictEqual(adapter.rowAt(2), selected);
    Assert.equal(adapter.rowAt(2).message.id, 15);
    Assert.ok(selection.isSelected(2));
    Assert.equal(selection.currentIndex, 2);
    Assert.equal(selection.shiftSelectPivot, 2);
    Assert.strictEqual(adapter.rowAt(4), untouched);
    Assert.equal(tree.resets.length, 1);
  }
);

add_task(
  function test_threadBatchConversationSelectionFollowsCapturedMembership() {
    const a = threadBatchRow(11),
      b = threadBatchRow(12),
      control = threadBatchRow(14);
    const { adapter, selection } = threadBatchFixture(
      [
        threadBatchSummary([a]),
        threadBatchSummary([b]),
        threadBatchSummary([control]),
      ],
      LiveViewConversationsDataAdapter
    );
    selection.rangedSelect(1, 1, false);
    const batch = groupedThreadBatch(adapter, [a, b]);
    batch.groups.after[0].representative = batch.publication;
    adapter.onMessageAdded(batch);
    Assert.equal(adapter.rowCount, 2);
    Assert.equal(adapter.rowAt(0).message.id, 13);
    Assert.equal(adapter.rowAt(0).messageCount, 3);
    Assert.ok(selection.isSelected(0));
    Assert.equal(selection.currentIndex, 0);
    Assert.equal(selection.shiftSelectPivot, 0);
  }
);

add_task(async function test_threadBatchDiscardsStaleChildCompletion() {
  const a = threadBatchRow(11),
    child = { ...threadBatchRow(15), threadId: 11, threadParent: 11 };
  const { adapter, liveView, tree } = threadBatchFixture(
    [threadBatchSummary([a, child])],
    LiveViewThreadedDataAdapter
  );
  let complete;
  liveView.selectMessagesInGroup = () =>
    new Promise(resolve => {
      complete = resolve;
    });
  const root = adapter.rowAt(0);
  const pending = root.ensureChildren(adapter, 0);
  adapter.onMessageAdded(groupedThreadBatch(adapter, [a, child]));
  const installed = root.children;
  complete([a, child]);
  await pending;
  Assert.strictEqual(root.children, installed);
  Assert.equal(root.thread.messageCount, 3);
  Assert.equal(root.children.length, 2);
  Assert.ok(root.children.every(Boolean));
  Assert.equal(tree.resets.length, 1);
});

add_task(
  async function test_threadBatchSparseRefreshKeepsLoadedSelectionAndRejectsOldCompletion() {
    const a = threadBatchRow(11),
      b = threadBatchRow(12);
    const { adapter, liveView, selection, tree } = threadBatchFixture([a, b]);
    const selected = adapter.rowAt(0);
    delete adapter._rowMap[1];
    adapter._clearFlatRowCache();
    selection.select(0);
    const staleQuery = adapter._makeQueryListener(0);
    let finishCount;
    liveView.countMessages = () =>
      new Promise(resolve => {
        finishCount = resolve;
      });
    liveView.selectMessages = async () => [
      { ...a, threadId: 13, threadParent: 13 },
      { ...b, threadId: 13, threadParent: 13 },
    ];
    adapter.onMessageAdded(threadBatchDescriptor(adapter, [a, b]));
    Assert.equal(
      tree.resets.length,
      0,
      "Pending refresh leaves visible state intact"
    );
    finishCount(2);
    await adapter._batchRefreshPromise;
    Assert.strictEqual(adapter.rowAt(0), selected);
    Assert.ok(selection.isSelected(0));
    Assert.equal(adapter.rowAt(1).message.threadId, 13);
    staleQuery.onSelectedChunk([a, b], 0, 1);
    Assert.equal(adapter.rowAt(0).message.threadId, 13);
    Assert.equal(tree.resets.length, 1);
  }
);

add_task(
  function test_threadBatchRejectsInvalidSequenceAndGroupTotalsBeforeMutation() {
    assertThreadBatchDomainRejected(batch => {
      batch.batchId = "0";
    }, /Invalid thread batch descriptor/);
    const a = threadBatchRow(11),
      b = threadBatchRow(12);
    const { adapter, tree, selection } = threadBatchFixture(
      [threadBatchSummary([a]), threadBatchSummary([b])],
      LiveViewThreadedDataAdapter
    );
    selection.select(1);
    const root = adapter.rowAt(0),
      rowMap = adapter._rowMap;
    const batch = groupedThreadBatch(adapter, [a, b]);
    batch.groups.after[0].unreadCount--;
    Assert.throws(
      () => adapter.onMessageAdded(batch),
      /Invalid captured thread batch group totals/
    );
    Assert.strictEqual(adapter._rowMap, rowMap);
    Assert.strictEqual(adapter.rowAt(0), root);
    Assert.equal(root.message.threadId, 11);
    Assert.ok(selection.isSelected(1));
    Assert.equal(adapter._queryGeneration, 0);
    Assert.equal(tree.resets.length, 0);
  }
);

add_task(
  function test_threadBatchSortGroupRetainsUnrelatedMembersAndDummySelection() {
    const a = threadBatchRow(11),
      b = threadBatchRow(12),
      unrelated = threadBatchRow(14);
    const summary = { ...a, messageCount: 3, newCount: 0, unreadCount: 3 };
    const { adapter, selection, tree } = threadBatchFixture(
      [summary],
      LiveViewGroupedDataAdapter
    );
    const dummy = adapter.rowAt(0);
    selection.rangedSelect(0, 0, false);
    const batch = groupedThreadBatch(adapter, [a, b, unrelated], "subject");
    batch.componentThreadIds.before = [11, 12];
    batch.rows[2].after.threadId = unrelated.threadId;
    batch.rows[2].after.threadParent = unrelated.threadParent;
    adapter.onMessageAdded(batch);
    Assert.strictEqual(adapter.rowAt(0), dummy);
    Assert.ok(
      !dummy.open,
      "A selected dummy does not invent a selected physical child"
    );
    Assert.equal(dummy.children.length, 4);
    Assert.deepEqual(
      dummy.children.map(row => [row.message.folderId, row.message.id]),
      [
        [1, 11],
        [1, 12],
        [1, 14],
        [2, 13],
      ]
    );
    Assert.equal(dummy.unreadCount, 4);
    Assert.ok(selection.isSelected(0));
    Assert.equal(selection.currentIndex, 0);
    Assert.equal(selection.shiftSelectPivot, 0);
    Assert.equal(tree.resets.length, 1);
  }
);

add_task(
  function test_threadBatchUnloadedSelectionFailsBeforeRefreshMutation() {
    const a = threadBatchRow(11),
      b = threadBatchRow(12);
    const { adapter, liveView, tree, selection } = threadBatchFixture([a, b]);
    delete adapter._rowMap[1];
    adapter._clearFlatRowCache();
    selection.select(1);
    liveView.countMessages = () =>
      Assert.ok(false, "No query begins without a physical selection identity");
    liveView.selectMessages = () => Assert.ok(false, "No query begins");
    Assert.throws(
      () => adapter.onMessageAdded(threadBatchDescriptor(adapter, [a, b])),
      /cannot recover an unloaded selection identity/
    );
    Assert.strictEqual(liveView.listener, adapter);
    Assert.equal(adapter._queryGeneration, 0);
    Assert.equal(adapter._threadBatchId, null);
    Assert.ok(selection.isSelected(1));
    Assert.equal(tree.resets.length, 0);
  }
);

add_task(
  async function test_threadBatchRefreshFailureInvalidatesWithoutReportingRollback() {
    const a = threadBatchRow(11),
      b = threadBatchRow(12);
    const { adapter, liveView, tree, selection } = threadBatchFixture([a, b]);
    delete adapter._rowMap[1];
    adapter._clearFlatRowCache();
    selection.select(0);
    liveView.countMessages = async () => 2;
    liveView.selectMessages = async () => {
      throw new Error("query failure after commit");
    };
    adapter.onMessageAdded(threadBatchDescriptor(adapter, [a, b]));
    await adapter._batchRefreshPromise;
    Assert.equal(adapter.rowCount, 0);
    Assert.equal(selection.count, 0);
    Assert.equal(selection.currentIndex, -1);
    Assert.equal(liveView.listener, null);
    Assert.equal(adapter._liveView, null);
    Assert.equal(
      adapter._threadBatchId,
      1n,
      "Consumer failure does not undo committed batch identity"
    );
    Assert.equal(tree.resets.length, 1);
  }
);

add_task(
  async function test_nativeTextGroupCountsMatchCompleteSelectedMembers() {
    for (const [sortColumn, field] of [
      [Ci.nsILiveView.SUBJECT, "subject"],
      [Ci.nsILiveView.SENDER, "sender"],
      [Ci.nsILiveView.RECIPIENTS, "recipients"],
    ]) {
      const liveView = new LiveView();
      liveView.initWithFolder(2);
      liveView.grouping = Ci.nsILiveView.GROUPED_BY_SORT;
      liveView.sortColumn = sortColumn;
      const groups = await liveView.selectMessages();
      Assert.equal(await liveView.countMessages(), groups.length);
      Assert.equal(
        await liveView.countUnreadMessages(),
        groups.filter(group => group.unreadCount > 0).length
      );
      const seen = new Set();
      for (const group of groups) {
        const members = await liveView.selectMessagesInGroup(group[field]);
        Assert.equal(members.length, group.messageCount);
        Assert.equal(
          members.filter(row => !(row.flags & Ci.nsMsgMessageFlags.Read))
            .length,
          group.unreadCount
        );
        for (const row of members) {
          Assert.equal(row.folderId, 2);
          Assert.ok(
            !seen.has(row.id),
            "A physical row belongs to one selected group"
          );
          seen.add(row.id);
        }
      }
      const flat = new LiveView();
      flat.initWithFolder(2);
      Assert.deepEqual(
        [...seen].sort((a, b) => a - b),
        (await flat.selectMessages()).map(row => row.id).sort((a, b) => a - b)
      );
    }
  }
);

add_task(
  async function test_threadBatchSparseGroupUsesCapturedMembersAndContributingExpansion() {
    const a = threadBatchRow(11),
      b = threadBatchRow(12),
      control = threadBatchRow(14);
    const { adapter, liveView, selection, tree } = threadBatchFixture(
      [
        threadBatchSummary([a]),
        threadBatchSummary([b]),
        threadBatchSummary([control]),
      ],
      LiveViewThreadedDataAdapter
    );
    delete adapter._rowMap[2];
    adapter._clearFlatRowCache();
    selection.rangedSelect(0, 0, false);
    const selected = adapter.rowAt(0);
    const batch = groupedThreadBatch(adapter, [a, b]);
    liveView.countMessages = async () => 2;
    liveView.selectMessages = async () => [
      { ...batch.rows[0].after, messageCount: 3, newCount: 0, unreadCount: 3 },
      threadBatchSummary([control]),
    ];
    liveView.selectMessagesInGroup = async key => {
      Assert.equal(
        key,
        14,
        "Affected historical membership must come from captured facts"
      );
      return [control];
    };
    adapter.onMessageAdded(batch);
    await adapter._batchRefreshPromise;
    Assert.equal(adapter.rowCount, 4);
    Assert.ok(adapter.rowAt(0).open);
    Assert.strictEqual(adapter.rowAt(1), selected);
    Assert.ok(selection.isSelected(1));
    Assert.equal(selection.currentIndex, 1);
    Assert.equal(selection.shiftSelectPivot, 1);
    Assert.equal(adapter.rowAt(0).thread.messageCount, 3);
    Assert.equal(adapter.rowAt(3).message.id, 14);
    Assert.equal(tree.resets.length, 1);
  }
);

add_task(
  async function test_threadBatchSortRejectsStaleQueryFailureWithoutInvalidatingNewRows() {
    const a = threadBatchRow(11);
    const { adapter, liveView, tree } = threadBatchFixture([a]);
    liveView.countMessages = async () => 1;
    let rejectQuery, markStarted;
    const started = new Promise(resolve => {
      markStarted = resolve;
    });
    liveView.selectMessages = () =>
      new Promise((resolve, reject) => {
        liveView.listener.onSelectedChunk([a], 0, 0);
        rejectQuery = reject;
        markStarted();
      });
    const sorting = adapter.sortBy("date", "ascending");
    await started;
    adapter.onMessageAdded(threadBatchDescriptor(adapter, [a]));
    rejectQuery(new DOMException("View query invalidated", "AbortError"));
    await sorting;
    Assert.strictEqual(adapter._liveView, liveView);
    Assert.equal(adapter.rowAt(0).message.threadId, 13);
    Assert.equal(tree.resets.length, 1);
  }
);

add_task(
  async function test_threadBatchSparseRefreshInvalidatesAffectedChildrenBeforeAwait() {
    const a = threadBatchRow(11),
      child = { ...threadBatchRow(15), threadId: 11, threadParent: 11 },
      control = threadBatchRow(14);
    const { adapter, liveView, selection } = threadBatchFixture(
      [threadBatchSummary([a, child]), threadBatchSummary([control])],
      LiveViewThreadedDataAdapter
    );
    const root = adapter.rowAt(0);
    delete adapter._rowMap[1];
    adapter._clearFlatRowCache();
    selection.select(0);
    let resolveChildren, resolveCount;
    liveView.selectMessagesInGroup = key =>
      key == 11
        ? new Promise(resolve => {
            resolveChildren = resolve;
          })
        : Promise.resolve([control]);
    const pendingChildren = root.ensureChildren(adapter, 0);
    const children = root.children;
    liveView.countMessages = () =>
      new Promise(resolve => {
        resolveCount = resolve;
      });
    const batch = groupedThreadBatch(adapter, [a, child]);
    liveView.selectMessages = async () => [
      { ...batch.rows[0].after, messageCount: 3, newCount: 0, unreadCount: 3 },
      threadBatchSummary([control]),
    ];
    adapter.onMessageAdded(batch);
    resolveChildren([a, child]);
    await pendingChildren;
    Assert.strictEqual(root.children, children);
    Assert.equal(
      root.children[0],
      undefined,
      "A stale affected child query cannot fill holes during the refresh"
    );
    resolveCount(2);
    await adapter._batchRefreshPromise;
    Assert.equal(adapter.rowCount, 4);
    Assert.equal(adapter.rowAt(0).thread.messageCount, 3);
    Assert.equal(adapter.rowAt(adapter.selection.currentIndex).message.id, 11);
  }
);

add_task(
  async function test_threadBatchReplacementTreeRefreshesCachedAttachmentCapability() {
    const a = threadBatchRow(11);
    const { adapter, liveView } = threadBatchFixture([a]);
    const old = adapter._makeQueryListener(adapter._queryGeneration);
    liveView.countMessages = async () => 1;
    liveView.selectMessages = async () => {
      liveView.listener.onSelectedChunk([a], 0, 0);
      return [a];
    };
    adapter.setTree({
      reset() {},
      invalidateRange() {},
      invalidateRow() {},
      rowCountChanged() {
        Assert.ok(false);
      },
    });
    await adapter._batchRefreshPromise;
    Assert.equal(
      liveView.listener.panoramaThreadBatchGeneration,
      adapter._viewGeneration
    );
    Assert.greater(adapter._viewGeneration, 0);
    const fresh = adapter.rowAt(0);
    old.onSelectedChunk([threadBatchRow(99)], 0, 0);
    Assert.strictEqual(adapter.rowAt(0), fresh);
    adapter.onMessageAdded(threadBatchDescriptor(adapter, [a]));
    Assert.equal(
      adapter.rowAt(0).message.threadId,
      13,
      "The replacement attachment admits current batches"
    );
  }
);

add_task(async function test_threadBatchEmptyQueryClearsRowsAndGroupMaps() {
  const a = threadBatchRow(11);
  for (const Adapter of [
    LiveViewDataAdapter,
    LiveViewThreadedDataAdapter,
    LiveViewConversationsDataAdapter,
    LiveViewGroupedDataAdapter,
  ]) {
    const { adapter, liveView } = threadBatchFixture(
      [Adapter == LiveViewDataAdapter ? a : threadBatchSummary([a])],
      Adapter
    );
    Assert.ok(adapter.rowAt(0));
    liveView.countMessages = async () => 0;
    liveView.selectMessages = async () => [];
    await adapter.sortBy(adapter.sortColumn, "ascending");
    Assert.equal(adapter.rowCount, 0);
    Assert.equal(
      adapter.rowAt(0),
      null,
      "No old physical identity survives an empty query"
    );
    if (Adapter != LiveViewDataAdapter) {
      Assert.equal(adapter._getBatchGroupMap().size, 0);
    }
  }
});

/**
 * Builds the private old-query mapping from literal pre-insert roots and members.
 *
 * @param {LiveViewDataAdapter} adapter - The attached consumer.
 * @param {object[]} roots - Independent message/group facts in old SQL order.
 * @returns {object} The native descriptor's pre-insert query mapping.
 */
function capturedBeforeView(adapter, roots) {
  return {
    grouping: adapter._threadBatchGrouping,
    sortColumn:
      adapter instanceof LiveViewGroupedDataAdapter
        ? Ci.nsILiveView.SUBJECT
        : Ci.nsILiveView.DATE,
    sortDescending: false,
    roots: roots.map(({ message, members = [], group = "" }) => ({
      message,
      members,
      group,
    })),
  };
}

add_task(
  async function test_threadBatchUnloadedFlatSelectionUsesOldPhysicalMapping() {
    const a = threadBatchRow(11),
      b = threadBatchRow(12, 2);
    b.messageId = a.messageId;
    const { adapter, liveView, selection, tree } = threadBatchFixture([a, b]);
    delete adapter._rowMap[1];
    adapter._clearFlatRowCache();
    selection.rangedSelect(1, 1, false);
    const batch = threadBatchDescriptor(adapter, [a, b]);
    batch.beforeView = capturedBeforeView(adapter, [
      { message: a },
      { message: b },
    ]);
    batch.rows.at(-1).matchesAfter = true;
    batch.rows.at(-1).after.date = new Date("2025-01-01T00:00:00Z");
    liveView.countMessages = () =>
      Assert.ok(false, "Captured old roots avoid a later count");
    liveView.selectMessages = () =>
      Assert.ok(
        false,
        "Captured roots and changes settle without querying after callbacks"
      );
    adapter.onMessageAdded(batch);
    await adapter._batchRefreshPromise;
    Assert.deepEqual(
      adapter._rowMap.map(row => [row.message.folderId, row.message.id]),
      [
        [2, 13],
        [1, 11],
        [2, 12],
      ]
    );
    Assert.ok(selection.isSelected(2));
    Assert.ok(!selection.isSelected(1));
    Assert.equal(selection.currentIndex, 2);
    Assert.equal(selection.shiftSelectPivot, 2);
    Assert.equal(tree.resets.length, 1);
  }
);

add_task(
  async function test_threadBatchExpandedHoleUsesOldMembersBeforeRootOffsets() {
    const a = threadBatchRow(11),
      child = { ...threadBatchRow(15), threadId: 11, threadParent: 11 },
      control = threadBatchRow(14, 2);
    const { adapter, liveView, selection, tree } = threadBatchFixture(
      [threadBatchSummary([a, child]), threadBatchSummary([control])],
      LiveViewThreadedDataAdapter
    );
    adapter.rowAt(0).open = true;
    delete adapter._rowMap[1];
    adapter._clearFlatRowCache();
    selection.rangedSelect(1, 2, false);
    selection.currentIndex = 2;
    selection._shiftSelectPivot = 1;
    const batch = groupedThreadBatch(adapter, [a, child]);
    batch.beforeView = capturedBeforeView(adapter, [
      { message: a, group: "11", members: [a, child] },
      { message: control, group: "14", members: [control] },
    ]);
    liveView.countMessages = async () => 2;
    liveView.selectMessages = async () => [
      {
        ...batch.rows.at(-1).after,
        messageCount: 3,
        newCount: 0,
        unreadCount: 3,
      },
      threadBatchSummary([control]),
    ];
    liveView.selectMessagesInGroup = async key => {
      Assert.equal(
        key,
        14,
        "Changed members come from the descriptor, not later SQL"
      );
      return [control];
    };
    adapter.onMessageAdded(batch);
    await adapter._batchRefreshPromise;
    Assert.deepEqual(
      Array.from({ length: adapter.rowCount }, (_, i) => [
        adapter.rowAt(i).message.folderId,
        adapter.rowAt(i).message.id,
      ]),
      [
        [2, 13],
        [1, 11],
        [1, 15],
        [2, 14],
      ]
    );
    Assert.ok(selection.isSelected(2));
    Assert.ok(selection.isSelected(3));
    Assert.equal(selection.currentIndex, 3);
    Assert.equal(selection.shiftSelectPivot, 2);
    Assert.equal(tree.resets.length, 1);
  }
);

add_task(function test_threadBatchUnloadedSortChildUsesCapturedQueryOrder() {
  const a = threadBatchRow(11),
    b = threadBatchRow(12, 2);
  b.date = new Date("2026-01-02T00:00:00Z");
  const { adapter, selection, tree } = threadBatchFixture(
    [{ ...a, messageCount: 2, newCount: 0, unreadCount: 2 }],
    LiveViewGroupedDataAdapter
  );
  const dummy = adapter.rowAt(0);
  dummy.open = true;
  adapter._clearFlatRowCache();
  selection.rangedSelect(1, 1, false);
  const batch = groupedThreadBatch(adapter, [a, b], "subject");
  batch.beforeView = capturedBeforeView(adapter, [
    { message: a, group: a.subject, members: [b, a] },
  ]);
  adapter.onMessageAdded(batch);
  Assert.strictEqual(adapter.rowAt(0), dummy);
  Assert.deepEqual(
    dummy.children.map(row => [row.message.folderId, row.message.id]),
    [
      [2, 12],
      [1, 11],
      [2, 13],
    ]
  );
  Assert.equal(selection.currentIndex, 1);
  Assert.equal(selection.shiftSelectPivot, 1);
  Assert.ok(selection.isSelected(1));
  Assert.equal(tree.resets.length, 1);
});

add_task(
  async function test_threadBatchUnloadedConversationSelectionMapsToMergedMembership() {
    const a = threadBatchRow(11),
      b = threadBatchRow(12, 2);
    const { adapter, liveView, selection, tree } = threadBatchFixture(
      [threadBatchSummary([a]), threadBatchSummary([b])],
      LiveViewConversationsDataAdapter
    );
    delete adapter._rowMap[1];
    adapter._clearFlatRowCache();
    selection.rangedSelect(1, 1, false);
    const batch = groupedThreadBatch(adapter, [a, b]);
    batch.rows.at(-1).after.date = new Date("2026-01-02T00:00:00Z");
    batch.groups.after[0].representative = { folderId: 2, id: 13 };
    batch.beforeView = capturedBeforeView(adapter, [
      { message: a, group: "11", members: [a] },
      { message: b, group: "12", members: [b] },
    ]);
    liveView.countMessages = async () => 1;
    liveView.selectMessages = async () => [
      {
        ...batch.rows.at(-1).after,
        messageCount: 3,
        newCount: 0,
        unreadCount: 3,
      },
    ];
    liveView.selectMessagesInGroup = () =>
      Assert.ok(
        false,
        "Complete affected membership was captured before commit"
      );
    adapter.onMessageAdded(batch);
    await adapter._batchRefreshPromise;
    Assert.equal(adapter.rowCount, 1);
    Assert.deepEqual(
      [adapter.rowAt(0).message.folderId, adapter.rowAt(0).message.id],
      [2, 13]
    );
    Assert.equal(adapter.rowAt(0).messageCount, 3);
    Assert.ok(selection.isSelected(0));
    Assert.equal(selection.currentIndex, 0);
    Assert.equal(selection.shiftSelectPivot, 0);
    Assert.equal(tree.resets.length, 1);
  }
);

add_task(function test_threadBatchInvalidOldQueryIsRejectedBeforeMutation() {
  for (const change of [
    mapping => {
      mapping.sortDescending = true;
    },
    mapping => {
      mapping.roots.reverse();
    },
    mapping => {
      mapping.roots[1].message.id = 0;
    },
    mapping => {
      mapping.roots[1].message = { ...mapping.roots[0].message };
    },
    mapping => {
      mapping.roots[1].message.flags = Ci.nsMsgMessageFlags.Read;
    },
  ]) {
    const a = threadBatchRow(11),
      b = threadBatchRow(12);
    const { adapter, selection, tree, liveView } = threadBatchFixture([a, b]);
    selection.rangedSelect(1, 1, false);
    const batch = threadBatchDescriptor(adapter, [a, b]);
    batch.beforeView = capturedBeforeView(adapter, [
      { message: { ...a } },
      { message: { ...b } },
    ]);
    change(batch.beforeView);
    const rows = adapter._rowMap,
      first = adapter.rowAt(0),
      second = adapter.rowAt(1);
    Assert.throws(
      () => adapter.onMessageAdded(batch),
      /Thread batch|Invalid thread batch|Duplicate thread batch/
    );
    Assert.strictEqual(adapter._rowMap, rows);
    Assert.strictEqual(adapter.rowAt(0), first);
    Assert.strictEqual(adapter.rowAt(1), second);
    Assert.strictEqual(liveView.listener, adapter);
    Assert.deepEqual(
      [
        first.message.flags,
        first.message.threadId,
        second.message.flags,
        second.message.threadId,
      ],
      [0, 11, 0, 12]
    );
    Assert.ok(selection.isSelected(1));
    Assert.equal(selection.currentIndex, 1);
    Assert.equal(selection.shiftSelectPivot, 1);
    Assert.equal(adapter._threadBatchId, null);
    Assert.equal(adapter._queryGeneration, 0);
    Assert.equal(adapter._viewGeneration, 0);
    Assert.equal(tree.resets.length, 0);
  }
});

add_task(
  function test_threadBatchUnloadedDummyKeepsGroupSelectionWithoutSelectingChild() {
    const a = threadBatchRow(11),
      b = threadBatchRow(12, 2);
    const { adapter, selection, tree, liveView } = threadBatchFixture(
      [{ ...a, messageCount: 2, newCount: 0, unreadCount: 2 }],
      LiveViewGroupedDataAdapter
    );
    delete adapter._rowMap[0];
    adapter._clearFlatRowCache();
    selection.rangedSelect(0, 0, false);
    const batch = groupedThreadBatch(adapter, [a, b], "subject");
    batch.beforeView = capturedBeforeView(adapter, [
      { message: a, group: a.subject, members: [a, b] },
    ]);
    liveView.countMessages = () => Assert.ok(false, "No later count is needed");
    liveView.selectMessages = () =>
      Assert.ok(false, "No later query is needed");
    adapter.onMessageAdded(batch);
    Assert.equal(adapter.rowCount, 1);
    Assert.ok(!adapter.rowAt(0).open);
    Assert.equal(adapter.rowAt(0).group, a.subject);
    Assert.equal(adapter.rowAt(0).children.length, 3);
    Assert.equal(selection.currentIndex, 0);
    Assert.equal(selection.shiftSelectPivot, 0);
    Assert.ok(selection.isSelected(0));
    Assert.equal(tree.resets.length, 1);
  }
);

add_task(
  function test_threadBatchUnloadedDepartedMemberDoesNotSelectReplacement() {
    const a = threadBatchRow(11),
      b = { ...threadBatchRow(12, 2), threadId: 11 };
    const { adapter, selection, tree, liveView } = threadBatchFixture([a, b]);
    delete adapter._rowMap[1];
    adapter._clearFlatRowCache();
    selection.rangedSelect(1, 1, false);
    const batch = threadBatchDescriptor(adapter, [a, b]);
    batch.rows[0].matchesAfter = batch.rows[1].matchesAfter = false;
    batch.beforeView = capturedBeforeView(adapter, [
      { message: a },
      { message: b },
    ]);
    liveView.countMessages = () =>
      Assert.ok(false, "Old filter membership is already captured");
    liveView.selectMessages = () =>
      Assert.ok(false, "No later row is used as the selected member");
    adapter.onMessageAdded(batch);
    Assert.equal(adapter.rowCount, 0);
    Assert.equal(selection.count, 0);
    Assert.equal(selection.currentIndex, -1);
    Assert.equal(selection.shiftSelectPivot, -1);
    Assert.strictEqual(selection._shiftSelectPivot, null);
    Assert.equal(tree.resets.length, 1);
  }
);

/**
 * Supplies independent current SQL and original displayed query captures.
 *
 * @param {LiveViewDataAdapter} adapter - The retained adapter.
 * @param {object[]} current - Complete pre-insert roots in the requested query.
 * @param {object[]|null} displayed - Complete roots in the displayed configuration.
 * @param {object[]} [order=displayed] - Original query root order before cached edits.
 * @returns {object} A private captured query descriptor.
 */
function contextualBeforeView(adapter, current, displayed, order = displayed) {
  const captured = capturedBeforeView(adapter, current);
  captured.sortDescending = adapter.sortDirection == "descending";
  captured.displayView = displayed && capturedBeforeView(adapter, displayed);
  if (captured.displayView) {
    captured.displayView.order = order.map(entry => ({
      folderId: entry.message.folderId,
      id: entry.message.id,
      group: entry.group ?? "",
    }));
  }
  return captured;
}

add_task(
  async function test_threadBatchDuringCountPreservesOriginalUnloadedSelection() {
    const a = threadBatchRow(11),
      b = threadBatchRow(12, 2);
    b.date = new Date("2026-01-02T00:00:00Z");
    const { adapter, liveView, selection, tree } = threadBatchFixture([a, b]);
    delete adapter._rowMap[0];
    adapter._clearFlatRowCache();
    selection.rangedSelect(0, 0, false);
    let resolveCount;
    liveView.countMessages = () =>
      new Promise(resolve => {
        resolveCount = resolve;
      });
    liveView.selectMessages = () =>
      Assert.ok(false, "Superseded count must not install a positional query");
    const sorting = adapter.sortBy("date", "descending");
    const batch = threadBatchDescriptor(adapter, [a, b]);
    batch.rows.at(-1).matchesAfter = true;
    batch.rows.at(-1).after.date = new Date("2026-01-03T00:00:00Z");
    batch.beforeView = contextualBeforeView(
      adapter,
      [{ message: b }, { message: a }],
      [{ message: a }, { message: b }]
    );
    adapter.onMessageAdded(batch);
    const rows = adapter._rowMap;
    resolveCount(2);
    await sorting;
    Assert.strictEqual(
      adapter._rowMap,
      rows,
      "The stale count cannot resize the settled map"
    );
    Assert.strictEqual(adapter._liveView, liveView);
    Assert.deepEqual(
      rows.map(row => [row.message.folderId, row.message.id]),
      [
        [2, 13],
        [2, 12],
        [1, 11],
      ]
    );
    Assert.ok(selection.isSelected(2));
    Assert.equal(selection.currentIndex, 2);
    Assert.equal(selection.shiftSelectPivot, 2);
    Assert.equal(tree.resets.length, 1);
  }
);

add_task(
  function test_threadBatchCachedTieOrderUsesPhysicalAnchorsAndOriginalQuery() {
    const a = threadBatchRow(11),
      b = threadBatchRow(12, 2),
      c = threadBatchRow(14),
      d = threadBatchRow(15, 2);
    const { adapter, liveView, selection, tree } = threadBatchFixture([
      c,
      b,
      d,
      a,
    ]);
    const first = adapter.rowAt(0),
      last = adapter.rowAt(3);
    delete adapter._rowMap[1];
    delete adapter._rowMap[2];
    adapter._clearFlatRowCache();
    selection.select(1);
    selection.currentIndex = 2;
    selection._shiftSelectPivot = 0;
    const batch = threadBatchDescriptor(adapter, [a, b]);
    batch.rows.at(-1).matchesAfter = true;
    batch.rows.at(-1).after.date = new Date("2025-01-01T00:00:00Z");
    const sql = [a, b, c, d].map(message => ({ message }));
    batch.beforeView = contextualBeforeView(
      adapter,
      sql,
      sql,
      [b, c, d, a].map(message => ({ message }))
    );
    adapter.onMessageAdded(batch);
    Assert.strictEqual(adapter._liveView, liveView);
    Assert.deepEqual(
      adapter._rowMap.map(row => [row.message.folderId, row.message.id]),
      [
        [2, 13],
        [1, 14],
        [2, 12],
        [2, 15],
        [1, 11],
      ]
    );
    Assert.strictEqual(adapter.rowAt(1), first);
    Assert.strictEqual(adapter.rowAt(4), last);
    Assert.ok(selection.isSelected(2));
    Assert.equal(selection.currentIndex, 3);
    Assert.equal(selection.shiftSelectPivot, 1);
    Assert.equal(tree.resets.length, 1);
  }
);

add_task(
  function test_threadBatchBeforeInitialCountInstallsAllRetainedAdapters() {
    const a = threadBatchRow(11),
      b = threadBatchRow(12, 2);
    for (const Adapter of [
      LiveViewDataAdapter,
      LiveViewThreadedDataAdapter,
      LiveViewConversationsDataAdapter,
      LiveViewGroupedDataAdapter,
    ]) {
      const { adapter, liveView, selection, tree } = threadBatchFixture(
        [],
        Adapter
      );
      const flat = Adapter == LiveViewDataAdapter,
        sort = Adapter == LiveViewGroupedDataAdapter;
      const batch = flat
        ? threadBatchDescriptor(adapter, [a, b])
        : groupedThreadBatch(adapter, [a, b], sort ? "subject" : "threadId");
      batch.rows.at(-1).matchesAfter = true;
      if (!flat) {
        batch.groups.after[0].representative = batch.publication;
      }
      let roots;
      if (flat) {
        roots = [{ message: a }, { message: b }];
      } else if (sort) {
        roots = [{ message: a, group: a.subject, members: [a, b] }];
      } else {
        roots = [
          { message: a, group: "11", members: [a] },
          { message: b, group: "12", members: [b] },
        ];
      }
      batch.beforeView = contextualBeforeView(adapter, roots, null);
      adapter.onMessageAdded(batch);
      Assert.strictEqual(adapter._liveView, liveView);
      Assert.equal(adapter._rowMap.length, flat ? 3 : 1);
      Assert.equal(selection.count, 0);
      Assert.equal(selection.currentIndex, -1);
      Assert.equal(tree.resets.length, 1);
    }
  }
);

add_task(
  function test_threadBatchUnchangedExpandedGroupRestoresUnloadedChild() {
    const a = threadBatchRow(11),
      c = threadBatchRow(14),
      child = { ...threadBatchRow(15, 2), threadId: 14, threadParent: 14 };
    c.date = child.date = new Date("2026-01-03T00:00:00Z");
    const { adapter, liveView, selection, tree } = threadBatchFixture(
      [threadBatchSummary([a]), threadBatchSummary([c, child])],
      LiveViewThreadedDataAdapter
    );
    const control = adapter.rowAt(1);
    control.open = true;
    adapter._clearFlatRowCache();
    selection.rangedSelect(2, 2, false);
    adapter.sortDirection = "descending";
    const batch = groupedThreadBatch(adapter, [a]);
    batch.rows.at(-1).after.date = new Date("2026-01-02T00:00:00Z");
    batch.groups.after[0].representative = batch.publication;
    const old = [
      { message: a, group: "11", members: [a] },
      { message: c, group: "14", members: [c, child] },
    ];
    batch.beforeView = contextualBeforeView(adapter, old.toReversed(), old);
    adapter.onMessageAdded(batch);
    Assert.strictEqual(adapter._liveView, liveView);
    Assert.strictEqual(adapter.rowAt(0), control);
    Assert.deepEqual(
      Array.from({ length: adapter.rowCount }, (_, i) => [
        adapter.rowAt(i).message.folderId,
        adapter.rowAt(i).message.id,
      ]),
      [
        [1, 14],
        [2, 15],
        [2, 13],
      ]
    );
    Assert.ok(selection.isSelected(1));
    Assert.equal(selection.currentIndex, 1);
    Assert.equal(selection.shiftSelectPivot, 1);
    Assert.equal(control.thread.messageCount, 2);
    Assert.equal(tree.resets.length, 1);
  }
);

add_task(
  async function test_threadBatchSortColumnChangePreservesUnloadedPhysicalChild() {
    const a = threadBatchRow(11),
      b = threadBatchRow(12, 2);
    a.sender = b.sender = "z-sender@invalid";
    const { adapter, liveView, selection, tree } = threadBatchFixture(
      [{ ...a, messageCount: 2, newCount: 0, unreadCount: 2 }],
      LiveViewGroupedDataAdapter
    );
    const oldDummy = adapter.rowAt(0);
    oldDummy.open = true;
    adapter._clearFlatRowCache();
    selection.rangedSelect(2, 2, false);
    let resolveCount;
    liveView.countMessages = () =>
      new Promise(resolve => {
        resolveCount = resolve;
      });
    liveView.selectMessages = () =>
      Assert.ok(false, "The superseded query cannot overwrite the batch");
    const sorting = adapter.sortBy("sender", "ascending");
    const batch = groupedThreadBatch(adapter, [a, b], "sender");
    batch.rows.at(-1).after.sender = "a-sender@invalid";
    batch.groups.after = capturedThreadGroups(
      batch.rows.map(row => row.after),
      "sender"
    );
    const current = [{ message: a, group: a.sender, members: [a, b] }];
    const displayed = [{ message: a, group: a.subject, members: [b, a] }];
    batch.beforeView = contextualBeforeView(adapter, current, displayed);
    batch.beforeView.sortColumn = Ci.nsILiveView.SENDER;
    adapter.onMessageAdded(batch);
    resolveCount(1);
    await sorting;
    Assert.strictEqual(adapter._liveView, liveView);
    Assert.equal(adapter._rowMap.length, 2);
    Assert.notStrictEqual(
      adapter._rowMap[1],
      oldDummy,
      "The old subject group is not a sender group"
    );
    Assert.equal(adapter._rowMap[0].group, "a-sender@invalid");
    Assert.equal(adapter._rowMap[1].group, "z-sender@invalid");
    const selected = adapter.rowAt(selection.currentIndex);
    Assert.deepEqual([selected.message.folderId, selected.message.id], [1, 11]);
    Assert.ok(selection.isSelected(selection.currentIndex));
    Assert.equal(selection.shiftSelectPivot, selection.currentIndex);
    Assert.equal(
      adapter._getBatchGroupMap().size,
      2,
      "No old subject group remains in the map"
    );
    Assert.equal(tree.resets.length, 1);

    const senderGroup = adapter._rowMap[1];
    const otherGroup = adapter._rowMap[0];
    Assert.ok(senderGroup.open);
    selection.select(adapter.indexOf(senderGroup));
    selection.currentIndex = adapter.indexOf(selected);
    selection._shiftSelectPivot = adapter.indexOf(otherGroup);
    const members = batch.rows.map(row => row.after);
    const publication = {
      ...threadBatchRow(14),
      sender: "a-sender@invalid",
      threadId: 13,
      threadParent: 13,
    };
    const followUp = {
      ...batch,
      batchId: "2",
      publication: { folderId: 1, id: 14 },
      componentThreadIds: { before: [13], after: [13] },
      rows: [
        ...members.map(message => ({
          before: message,
          after: { ...message },
          matchesBefore: true,
          matchesAfter: true,
        })),
        {
          before: null,
          after: publication,
          matchesBefore: false,
          matchesAfter: true,
        },
      ],
      groups: {
        before: capturedThreadGroups(members, "sender"),
        after: capturedThreadGroups([...members, publication], "sender"),
      },
    };
    const installed = [
      { message: members[2], group: members[2].sender, members: [members[2]] },
      { message: members[0], group: a.sender, members: members.slice(0, 2) },
    ];
    followUp.beforeView = contextualBeforeView(adapter, installed, installed);
    followUp.beforeView.sortColumn = Ci.nsILiveView.SENDER;
    followUp.beforeView.displayView.sortColumn = Ci.nsILiveView.SENDER;
    adapter.onMessageAdded(followUp);
    Assert.strictEqual(adapter._liveView, liveView);
    Assert.strictEqual(adapter._rowMap[0], otherGroup);
    Assert.strictEqual(adapter._rowMap[1], senderGroup);
    Assert.ok(senderGroup.open, "A follow-up batch retains expansion");
    Assert.equal(adapter.rowCount, 4);
    Assert.equal(otherGroup.children.length, 2);
    Assert.ok(!otherGroup.open);
    Assert.ok(selection.isSelected(adapter.indexOf(senderGroup)));
    Assert.strictEqual(adapter.rowAt(selection.currentIndex), selected);
    Assert.strictEqual(adapter.rowAt(selection.shiftSelectPivot), otherGroup);
    Assert.equal(tree.resets.length, 2);
  }
);

add_task(
  function test_threadBatchContextRejectsMissingOriginalEvidenceBeforeMutation() {
    const a = threadBatchRow(11),
      b = threadBatchRow(12, 2);
    const { adapter, liveView, tree, selection } = threadBatchFixture([a, b]);
    delete adapter._rowMap[1];
    adapter._clearFlatRowCache();
    selection.rangedSelect(1, 1, false);
    const batch = threadBatchDescriptor(adapter, [a, b]);
    batch.beforeView = contextualBeforeView(
      adapter,
      [{ message: b }, { message: a }],
      [{ message: a }, { message: b }],
      [{ message: a }]
    );
    const rows = adapter._rowMap,
      first = adapter.rowAt(0);
    Assert.throws(
      () => adapter.onMessageAdded(batch),
      /Incomplete original query identity mapping/
    );
    Assert.strictEqual(adapter._rowMap, rows);
    Assert.strictEqual(adapter.rowAt(0), first);
    Assert.strictEqual(adapter._liveView, liveView);
    Assert.equal(adapter._queryGeneration, 0);
    Assert.equal(adapter._threadBatchId, null);
    Assert.ok(selection.isSelected(1));
    Assert.equal(selection.currentIndex, 1);
    Assert.equal(selection.shiftSelectPivot, 1);
    Assert.equal(tree.resets.length, 0);
  }
);

add_task(
  async function test_threadBatchRejectsStaleOriginalQueryChunkAndSuccess() {
    const a = threadBatchRow(11),
      b = threadBatchRow(12, 2);
    const { adapter, liveView, selection, tree } = threadBatchFixture([a, b]);
    let completeQuery, markStarted;
    const started = new Promise(resolve => {
      markStarted = resolve;
    });
    liveView.countMessages = async () => 2;
    liveView.selectMessages = () =>
      new Promise(resolve => {
        completeQuery = resolve;
        liveView.listener.onSelectedChunk([a, b], 0, 1);
        markStarted();
      });
    const sorting = adapter.sortBy("date", "ascending");
    await started;
    const stale = liveView.listener;
    delete adapter._rowMap[1];
    adapter._clearFlatRowCache();
    selection.rangedSelect(1, 1, false);
    const batch = threadBatchDescriptor(adapter, [a, b]);
    batch.beforeView = contextualBeforeView(
      adapter,
      [{ message: a }, { message: b }],
      [{ message: a }, { message: b }]
    );
    adapter.onMessageAdded(batch);
    const rows = adapter._rowMap;
    stale.onSelectedChunk([threadBatchRow(99), threadBatchRow(100)], 0, 1);
    completeQuery([a, b]);
    await sorting;
    Assert.strictEqual(adapter._rowMap, rows);
    Assert.strictEqual(adapter._liveView, liveView);
    Assert.deepEqual(
      rows.map(row => [
        row.message.folderId,
        row.message.id,
        row.message.threadId,
      ]),
      [
        [1, 11, 13],
        [2, 12, 13],
      ]
    );
    Assert.ok(selection.isSelected(1));
    Assert.equal(selection.currentIndex, 1);
    Assert.equal(selection.shiftSelectPivot, 1);
    Assert.equal(tree.resets.length, 1);
  }
);

/**
 * Initial physical New and later public words update each displayed member once.
 */
add_task(async function test_publicNewFlatUsesDisplayedState() {
  const { MessageInjection } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/MessageInjection.sys.mjs"
  );
  const { MessageGenerator, SyntheticMessageSet } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
  );
  const injection = new MessageInjection({ mode: "local" });
  const generator = new MessageGenerator();
  const parent = generator.makeMessage({ subject: "projected-new-adapter" });
  const child = generator.makeMessage({ inReplyTo: parent });
  const folder = await injection.makeEmptyFolder();
  const other = await injection.makeEmptyFolder();
  const set = new SyntheticMessageSet([parent, child]);
  const copies = new SyntheticMessageSet([parent, child]);
  await injection.addSetsToFolders([folder], [set]);
  await injection.addSetsToFolders([other], [copies]);
  Assert.ok(database instanceof Ci.nsIDatabaseCore);
  Assert.equal(
    folder.server.getStringValue("storeContractID"),
    "@mozilla.org/msgstore/berkeleystore;1"
  );
  const [root, reply] = set.msgHdrList;
  const db = folder.msgDatabase;
  root.flags = 0;
  reply.flags = Ci.nsMsgMessageFlags.New | Ci.nsMsgMessageFlags.Marked;
  db.addToNewList(root.messageKey);
  const otherBefore = copies.msgHdrList.map(header => header.flags);
  const folderId = folderDB.getFolderByPath(
    `${folder.server.key}/${folder.name}`
  );
  Assert.greater(folderId, 0);
  const rowChanges = [];
  const statusTree = {
    rowCountChanged(index, delta) {
      rowChanges.push([index, delta]);
    },
    invalidateRow() {},
    invalidateRange() {},
    reset() {
      Assert.ok(
        false,
        "A normal projected flag change does not reset the view"
      );
    },
  };
  const view = new LiveView();
  view.initWithFolder(folderId);
  const adapter = new LiveViewDataAdapter(view);
  adapter.setTree(statusTree);
  try {
    await adapter.sortBy("date", "descending");
    rowChanges.length = 0;

    Assert.equal(adapter.rowCount, 2);
    Assert.deepEqual(
      listMessages(adapter)
        .slice()
        .sort((a, b) => a - b),
      [root.messageKey, reply.messageKey].sort((a, b) => a - b)
    );
    let row = adapter._rowMap.find(item => item.message.id == root.messageKey);
    Assert.equal(row.message.folderId, folderId);
    Assert.equal(row.message.flags, Ci.nsMsgMessageFlags.New);
    db.markRead(root.messageKey, true, null);
    row = adapter._rowMap.find(item => item.message.id == root.messageKey);
    Assert.equal(row.message.flags, Ci.nsMsgMessageFlags.Read);
    db.addToNewList(root.messageKey);
    Assert.equal(
      row.message.flags,
      Ci.nsMsgMessageFlags.Read,
      "A silent addition does not fabricate a row callback"
    );
    db.markRead(root.messageKey, false, null);
    row = adapter._rowMap.find(item => item.message.id == root.messageKey);
    Assert.equal(row.message.flags, 0);
    reply.flags = Ci.nsMsgMessageFlags.Marked;
    row = adapter._rowMap.find(item => item.message.id == reply.messageKey);
    Assert.equal(row.message.flags, Ci.nsMsgMessageFlags.Marked);
    Assert.deepEqual(
      listMessages(adapter)
        .slice()
        .sort((a, b) => a - b),
      [root.messageKey, reply.messageKey].sort((a, b) => a - b)
    );

    Assert.deepEqual(
      rowChanges,
      [],
      "Flag changes preserve physical membership"
    );
    Assert.deepEqual(
      copies.msgHdrList.map(header => header.flags),
      otherBefore,
      "The outside equal-ID physical copies are unchanged"
    );
    adapter.setTree(null);
    db.markRead(root.messageKey, true, null);
    Assert.deepEqual(
      rowChanges,
      [],
      "Detached observers do not reach the tree"
    );
  } finally {
    adapter.setTree(null);
  }
});

/**
 * Creates isolated real physical folders for an ordinary graph-off operation.
 *
 * @param {string} name - The unique operation name.
 * @returns {number[]} Two genuine native folder identifiers.
 */
function ordinaryBatchFolders(name) {
  const root = folderDB.insertRoot(`ordinary-batch-${name}`);
  return [folderDB.insertFolder(root, "A"), folderDB.insertFolder(root, "B")];
}

/**
 * Queries a real native flat view and records its actual producer payloads.
 *
 * @param {number[]} folders - The physical view scope.
 * @param {Function} [initialize] - An additional native view restriction.
 * @returns {Promise<object>} The adapter, view, selection, payloads and tree.
 */
async function ordinaryBatchAdapter(folders, initialize) {
  const view = new LiveView();
  view.initWithFolders(folders);
  initialize?.(view);
  const adapter = new LiveViewDataAdapter(view);
  const events = [],
    payloads = [];
  const tree = {
    reset() {
      events.push(["reset"]);
    },
    rowCountChanged(index, delta) {
      events.push(["count", index, delta]);
    },
    invalidateRow(index) {
      events.push(["row", index]);
    },
    invalidateRange(start, end) {
      events.push(["range", start, end]);
    },
  };
  adapter.setTree(tree);
  adapter.selection = new TreeSelection(null);
  adapter.selection._view = adapter;
  registerCleanupFunction(() => adapter.setTree(null));
  const receive = adapter.onMessageAdded.bind(adapter);
  adapter.onMessageAdded = value => {
    payloads.push(value);
    receive(value);
  };
  await adapter.sortBy("date", "ascending");
  events.length = 0;
  Assert.equal(
    adapter.panoramaThreadBatchVersion,
    1,
    "Real completed flat query"
  );
  return {
    view,
    adapter,
    selection: adapter.selection,
    tree,
    events,
    payloads,
  };
}

/**
 * Lists loaded physical identities without Message-ID or positional guessing.
 *
 * @param {LiveViewDataAdapter} adapter - The queried consumer.
 * @returns {number[][]} Exact folder/key pairs.
 */
function ordinaryBatchPairs(adapter) {
  return adapter._rowMap.map(row => [row.message.folderId, row.message.id]);
}

add_task(async function test_nativeOrdinaryFlatBatchPhysicalIdentity() {
  const folders = ordinaryBatchFolders("identity");
  const first = addMessage({
    folderId: folders[0],
    messageId: "physical-copy",
  });
  const copy = addMessage({ folderId: folders[1], messageId: "physical-copy" });
  const f = await ordinaryBatchAdapter(folders);
  try {
    const old = [...f.adapter._rowMap];
    f.selection.select(1);
    const selected = old[1].message.id;
    const added = addMessage({
      folderId: folders[1],
      messageId: "physical-new",
    });
    Assert.deepEqual(f.events, [["reset"]]);
    Assert.equal(f.payloads.length, 1);
    Assert.equal(f.payloads[0].kind, "panorama-thread-batch");
    Assert.deepEqual(f.payloads[0].publication, {
      folderId: folders[1],
      id: added,
    });
    Assert.deepEqual(ordinaryBatchPairs(f.adapter), [
      [folders[0], first],
      [folders[1], copy],
      [folders[1], added],
    ]);
    Assert.strictEqual(f.adapter.rowAt(0), old[0]);
    Assert.strictEqual(f.adapter.rowAt(1), old[1]);
    Assert.equal(
      f.adapter.rowAt(f.selection.currentIndex).message.id,
      selected
    );
    Assert.ok(f.selection.isSelected(1));
    Assert.equal(f.selection.shiftSelectPivot, 1);
  } finally {
    f.adapter.setTree(null);
  }
});

add_task(async function test_nativeOrdinaryFlatBatchCompleteUnchangedPeers() {
  const folders = ordinaryBatchFolders("peers");
  const root = addMessage({ folderId: folders[0], messageId: "peer-root" });
  const peer = addMessage({
    folderId: folders[1],
    messageId: "peer-copy",
    references: ["peer-root"],
  });
  const f = await ordinaryBatchAdapter([folders[0]]);
  try {
    const before = [root, peer].map(key => {
      const message = messageDB.getMessage(key);
      return [key, message.threadId, message.threadParent];
    });
    const added = addMessage({
      folderId: folders[0],
      messageId: "peer-new",
      references: ["peer-root"],
    });
    const batch = f.payloads[0];
    Assert.deepEqual(batch.componentThreadIds, {
      before: [root],
      after: [root],
    });
    Assert.deepEqual(batch.groups, { before: [], after: [] });
    Assert.deepEqual(
      batch.rows.map(row => row.after.id),
      [root, peer, added]
    );
    Assert.deepEqual(
      batch.rows.slice(0, 2).map(row => row.before),
      batch.rows.slice(0, 2).map(row => row.after)
    );
    Assert.equal(
      batch.rows[1].matchesBefore,
      false,
      "Filtered peer remains captured"
    );
    Assert.equal(batch.rows[1].matchesAfter, false);
    Assert.deepEqual(
      before,
      [root, peer].map(key => {
        const message = messageDB.getMessage(key);
        return [key, message.threadId, message.threadParent];
      }),
      "No ordinary graph rewrite"
    );
    Assert.deepEqual(f.events, [["reset"]]);
    f.events.length = 0;
    addMessage({
      folderId: folders[1],
      messageId: "outside-peer",
      references: ["peer-root"],
    });
    Assert.deepEqual(
      f.events,
      [],
      "Matching old peers do not fabricate a publication"
    );
    Assert.equal(f.payloads.length, 1);
  } finally {
    f.adapter.setTree(null);
  }
});

add_task(async function test_nativeOrdinaryFlatBatchCountSortAndTieOrder() {
  const folders = ordinaryBatchFolders("count-sort");
  const first = addMessage({
    folderId: folders[0],
    messageId: "tie-a",
    subject: "equal",
  });
  const second = addMessage({
    folderId: folders[1],
    messageId: "tie-b",
    subject: "equal",
  });
  const f = await ordinaryBatchAdapter(folders);
  try {
    f.selection.rangedSelect(0, 1, false);
    const old = [...f.adapter._rowMap];
    const sorting = f.adapter.sortBy("subject", "descending");
    Assert.equal(
      f.adapter.panoramaThreadBatchVersion,
      1,
      "Old dense map retained during count"
    );
    const added = addMessage({
      folderId: folders[0],
      messageId: "tie-c",
      subject: "equal",
    });
    await sorting;
    Assert.deepEqual(
      f.events,
      [["reset"]],
      "Stale count/chunks cannot overwrite install"
    );
    Assert.deepEqual(
      ordinaryBatchPairs(f.adapter).map(pair => pair[1]),
      [first, second, added]
    );
    Assert.strictEqual(f.adapter.rowAt(0), old[0]);
    Assert.strictEqual(f.adapter.rowAt(1), old[1]);
    Assert.ok(f.selection.isSelected(0));
    Assert.ok(f.selection.isSelected(1));
    Assert.equal(f.selection.currentIndex, 1);
    Assert.equal(f.selection.shiftSelectPivot, 0);
    f.events.length = 0;
    const next = addMessage({
      folderId: folders[1],
      messageId: "tie-d",
      subject: "equal",
    });
    Assert.deepEqual(
      ordinaryBatchPairs(f.adapter).map(pair => pair[1]),
      [first, second, added, next]
    );
    Assert.deepEqual(f.events, [["reset"]]);
  } finally {
    f.adapter.setTree(null);
  }
});

add_task(
  async function test_nativeOrdinaryFlatBatchReadinessAndSparseFallback() {
    const folders = ordinaryBatchFolders("readiness");
    const view = new LiveView();
    view.initWithFolders(folders);
    const adapter = new LiveViewDataAdapter(view);
    const payloads = [];
    const receive = adapter.onMessageAdded.bind(adapter);
    adapter.onMessageAdded = value => {
      payloads.push(value);
      receive(value);
    };
    try {
      Assert.equal(adapter.panoramaThreadBatchVersion, 0);
      const initial = addMessage({
        folderId: folders[0],
        messageId: "unready",
      });
      Assert.equal(payloads[0].id, initial);
      Assert.equal(
        payloads[0].kind,
        undefined,
        "Unready recipient uses ordinary delivery"
      );
      await adapter.sortBy("date", "ascending");
      Assert.equal(adapter.panoramaThreadBatchVersion, 1);
      const versions = [];
      const chunk = adapter.onSelectedChunk.bind(adapter);
      adapter.onSelectedChunk = (...args) => {
        versions.push(adapter._queryListener.panoramaThreadBatchVersion);
        chunk(...args);
      };
      await adapter.sortBy("date", "descending");
      Assert.deepEqual(
        versions,
        [0],
        "Actual sparse replacement withdraws enrollment"
      );
      Assert.equal(
        adapter.panoramaThreadBatchVersion,
        1,
        "Real chunk restores eligibility"
      );
      addMessage({ folderId: folders[1], messageId: "ready" });
      Assert.equal(payloads.at(-1).kind, "panorama-thread-batch");
    } finally {
      adapter.setTree(null);
    }
    let getters = 0;
    const unaware = {
      onMessageAdded(value) {
        Assert.equal(value.kind, undefined);
      },
    };
    Object.defineProperty(unaware, "panoramaThreadBatchVersion", {
      get() {
        getters++;
        return 1;
      },
    });
    view.setListener(unaware);
    try {
      addMessage({ folderId: folders[0], messageId: "unaware" });
    } finally {
      view.clearListener();
    }
    Assert.equal(
      getters,
      0,
      "Native admission never executes a capability getter"
    );
  }
);

add_task(
  async function test_nativeOrdinaryFlatBatchReentrantHistoryAndRegistration() {
    const folders = ordinaryBatchFolders("reentry");
    const early = new LiveView();
    early.initWithFolders(folders);
    let nested = false;
    early.setListener({
      onMessageAdded(message) {
        if (nested) return;
        nested = true;
        messageDB.getMessage(message.id).orFlags(Ci.nsMsgMessageFlags.Marked);
        addMessage({ folderId: folders[1], messageId: "queued-next" });
      },
    });
    const f = await ordinaryBatchAdapter(folders);
    try {
      const added = addMessage({
        folderId: folders[0],
        messageId: "captured-first",
        flags: 0,
        tags: "opaque",
      });
      Assert.equal(
        f.payloads.length,
        2,
        "Each committed publication delivered once"
      );
      Assert.equal(f.payloads[0].rows.at(-1).after.id, added);
      Assert.equal(
        f.payloads[0].rows.at(-1).after.flags,
        0,
        "First facts precede reentry"
      );
      Assert.equal(f.payloads[0].rows.at(-1).after.tags, "opaque");
      Assert.equal(
        f.adapter._rowMap.find(row => row.message.id == added).message.flags,
        Ci.nsMsgMessageFlags.Marked
      );
      Assert.ok(BigInt(f.payloads[1].batchId) > BigInt(f.payloads[0].batchId));
      Assert.equal(f.events.filter(event => event[0] == "reset").length, 2);
      const count = f.payloads.length;
      f.view.clearListener();
      addMessage({ folderId: folders[0], messageId: "detached" });
      Assert.equal(
        f.payloads.length,
        count,
        "Removed registration cannot receive a queued form"
      );
    } finally {
      early.clearListener();
      f.adapter.setTree(null);
    }
  }
);

add_task(async function test_nativeOrdinaryFlatBatchSourceErrorAndRetry() {
  const folders = ordinaryBatchFolders("source-error");
  const f = await ordinaryBatchAdapter(folders);
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER ordinary_batch_abort BEFORE INSERT ON messages WHEN NEW.messageId = 'source-failure' BEGIN SELECT RAISE(ABORT, 'ordinary batch source failure'); END"
  );
  try {
    Assert.throws(
      () => addMessage({ folderId: folders[0], messageId: "source-failure" }),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.equal(await f.view.countMessages(), 0);
    Assert.equal(f.payloads.length, 0);
    Assert.deepEqual(f.events, []);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER ordinary_batch_abort");
  }
  try {
    const added = addMessage({
      folderId: folders[0],
      messageId: "source-failure",
    });
    Assert.deepEqual(ordinaryBatchPairs(f.adapter), [[folders[0], added]]);
    Assert.deepEqual(f.events, [["reset"]]);
    Assert.equal(
      f.payloads.length,
      1,
      "Retry publishes once with no failed-attempt event"
    );
    // A genuine native descriptor-domain failure must also roll back, not fall
    // back to the ordinary callback after an opted-in recipient's preparation.
    Assert.throws(
      () =>
        messageDB.addMessage(
          folders[1],
          "invalid-time",
          [],
          9e18,
          "sender",
          "recipient",
          "",
          "",
          "subject",
          0,
          "",
          Ci.nsMsgPriority.notSet
        ),
      /NS_ERROR_/
    );
    Assert.equal(await f.view.countMessages(), 1);
    Assert.equal(f.payloads.length, 1);
  } finally {
    f.adapter.setTree(null);
  }
});

add_task(async function test_nativeOrdinaryFlatBatchConsumerFailure() {
  const folders = ordinaryBatchFolders("consumer-error");
  const f = await ordinaryBatchAdapter(folders);
  let invalidations = 0;
  const invalidate = f.adapter.panoramaThreadBatchInvalidated;
  f.adapter.panoramaThreadBatchInvalidated = () => {
    invalidations++;
    invalidate();
  };
  f.adapter._queryListener.panoramaThreadBatchInvalidated =
    f.adapter.panoramaThreadBatchInvalidated;
  f.view.setListener(f.adapter._queryListener);
  f.tree.reset = () => {
    throw new Error("intentional committed consumer failure");
  };
  const added = addMessage({
    folderId: folders[0],
    messageId: "committed-consumer-error",
  });
  Assert.equal(
    messageDB.getMessage(added).messageId,
    "committed-consumer-error"
  );
  Assert.equal(f.payloads.length, 1);
  Assert.equal(invalidations, 1);
  Assert.equal(f.adapter._liveView, null);
  addMessage({ folderId: folders[1], messageId: "after-detach" });
  Assert.equal(
    f.payloads.length,
    1,
    "No resend or delivery after invalidation"
  );
});

add_task(async function test_nativeOrdinaryFlatBatchPublicNewProjection() {
  const folders = ordinaryBatchFolders("new-word");
  const root = addMessage({
    folderId: folders[0],
    messageId: "new-root",
    flags: Ci.nsMsgMessageFlags.New,
  });
  const f = await ordinaryBatchAdapter(folders);
  try {
    addMessage({
      folderId: folders[1],
      messageId: "new-child",
      references: ["new-root"],
      flags: 0,
    });
    Assert.equal(f.payloads[0].rows[0].before.flags, Ci.nsMsgMessageFlags.New);
    Assert.equal(
      f.adapter._rowMap.find(row => row.message.id == root).message.flags,
      Ci.nsMsgMessageFlags.New
    );
    Assert.deepEqual(f.events, [["reset"]]);
  } finally {
    f.adapter.setTree(null);
  }
});
