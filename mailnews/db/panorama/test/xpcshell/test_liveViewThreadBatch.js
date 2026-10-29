/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head.js */

const {
  LiveViewDataAdapter,
  LiveViewThreadedDataAdapter,
  LiveViewConversationsDataAdapter,
  LiveViewGroupedDataAdapter,
} = ChromeUtils.importESModule(
  "chrome://messenger/content/LiveViewDataAdapter.mjs"
);
const { TreeSelection } = ChromeUtils.importESModule(
  "chrome://messenger/content/TreeSelection.mjs"
);
const BatchLiveView = Components.Constructor(
  "@mozilla.org/mailnews/live-view;1",
  "nsILiveView"
);

add_setup(function () {
  const file = do_get_profile().clone();
  file.append("panorama.sqlite");
  Assert.ok(!file.exists(), "The concrete backend creates the current schema");
  Assert.ok(Services.prefs.getBoolPref("mail.panorama.enabled"));
  loadExistingDB();
  Assert.equal(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    ),
    database
  );
  if (typeof PanoramaDelivery != "undefined")
    PanoramaDelivery.assertBackend("panorama");
});

/**
 * Creates isolated physical folders through the native backend.
 *
 * @param {string} name - A unique root name.
 * @returns {number[]} The two physical folder identifiers.
 */
function batchFolders(name) {
  const root = folderDB.insertRoot(name);
  return [folderDB.insertFolder(root, "A"), folderDB.insertFolder(root, "B")];
}

/**
 * Inserts genuine ordered raw References through the public message API.
 *
 * @param {number} folderId - The physical folder.
 * @param {string} messageId - The bare Message-ID.
 * @param {string[]} references - The exact raw token sequence.
 * @param {number} [second=0] - A distinct date offset.
 * @returns {number} The allocated global physical key.
 */
function insertBatchMessage(folderId, messageId, references, second = 0) {
  return messageDB.addMessage(
    folderId,
    messageId,
    references,
    1700000000000000 + second * 1000000,
    "sender@batch.invalid",
    "recipient@batch.invalid",
    "",
    "",
    "Retained subject",
    0,
    "",
    Ci.nsMsgPriority.notSet
  );
}

/**
 * Attaches a retained adapter to the actual native view and concrete selection.
 *
 * @param {Function} Adapter - A retained adapter class.
 * @param {number[]} folders - The physical view scope.
 * @returns {Promise<object>} The fully queried adapter and observed resets.
 */
async function nativeBatchAdapter(Adapter, folders) {
  const liveView = new BatchLiveView();
  liveView.initWithFolders(folders);
  const adapter = new Adapter(liveView);
  const tree = {
    resets: 0,
    reset() {
      this.resets++;
    },
    rowCountChanged() {
      Assert.ok(
        false,
        "Native batches never emit intermediate physical insert/delete"
      );
    },
    invalidateRow() {},
    invalidateRange() {},
  };
  adapter.setTree(tree);
  adapter.selection = new TreeSelection(null);
  adapter.selection._view = adapter;
  registerCleanupFunction(() => adapter.setTree(null));
  await adapter.sortBy(
    Adapter == LiveViewGroupedDataAdapter ? "subject" : "date",
    "ascending"
  );
  return { adapter, tree, liveView };
}

add_task(async function test_nativeLateParentUpdatesAllRetainedAdapters() {
  const folders = batchFolders("views-batch-all-adapters");
  const first = insertBatchMessage(folders[0], "first@views-batch.invalid", [
    "parent@views-batch.invalid",
  ]);
  const second = insertBatchMessage(
    folders[1],
    "second@views-batch.invalid",
    ["parent@views-batch.invalid"],
    1
  );
  const control = insertBatchMessage(
    folders[1],
    "control@views-batch.invalid",
    [],
    2
  );
  const fixtures = [];
  try {
    for (const Adapter of [
      LiveViewDataAdapter,
      LiveViewThreadedDataAdapter,
      LiveViewConversationsDataAdapter,
      LiveViewGroupedDataAdapter,
    ]) {
      const fixture = await nativeBatchAdapter(Adapter, folders);
      fixtures.push(fixture);
      const { adapter } = fixture;
      if (
        Adapter == LiveViewThreadedDataAdapter ||
        Adapter == LiveViewGroupedDataAdapter
      ) {
        const root = adapter._rowMap.find(
          row =>
            Adapter == LiveViewGroupedDataAdapter ||
            row.message.threadId == messageDB.getMessage(first).threadId
        );
        await root.ensureChildren(adapter, adapter.indexOf(root));
        root.open = true;
        adapter._clearFlatRowCache();
      }
      const selected = Array.from({ length: adapter.rowCount }, (_, index) =>
        adapter.rowAt(index)
      ).findIndex(
        row =>
          row?.message?.id ==
          (Adapter == LiveViewConversationsDataAdapter ? second : first)
      );
      Assert.ok(
        selected >= 0,
        "The physical selected member is loaded before mutation"
      );
      adapter.selection.rangedSelect(selected, selected, false);
    }
    const parent = insertBatchMessage(
      folders[0],
      "parent@views-batch.invalid",
      [],
      3
    );
    const thread = messageDB.getMessage(parent).threadId;
    Assert.equal(messageDB.getMessage(first).threadId, thread);
    Assert.equal(messageDB.getMessage(second).threadId, thread);
    Assert.equal(messageDB.getMessage(first).threadParent, parent);
    Assert.equal(messageDB.getMessage(second).threadParent, parent);
    Assert.notEqual(messageDB.getMessage(control).threadId, thread);
    for (const { adapter, tree, liveView } of fixtures) {
      Assert.equal(
        tree.resets,
        1,
        "One native descriptor settles each retained consumer"
      );
      const grouped = adapter instanceof LiveViewGroupedDataAdapter;
      const conversations = adapter instanceof LiveViewConversationsDataAdapter;
      Assert.equal(
        adapter._rowMap.length,
        grouped
          ? 1
          : adapter instanceof LiveViewThreadedDataAdapter || conversations
            ? 2
            : 4
      );
      const selected = adapter.rowAt(adapter.selection.currentIndex);
      Assert.equal(selected.message.id, conversations ? parent : first);
      Assert.equal(selected.message.folderId, folders[0]);
      Assert.ok(adapter.selection.isSelected(adapter.selection.currentIndex));
      Assert.equal(
        adapter.selection.shiftSelectPivot,
        adapter.selection.currentIndex
      );
      if (adapter.constructor != LiveViewDataAdapter) {
        const rows = await liveView.selectMessagesInGroup(
          grouped ? "Retained subject" : thread
        );
        Assert.deepEqual(
          rows.map(row => [row.folderId, row.id]).sort((a, b) => a[1] - b[1]),
          (grouped
            ? [
                [folders[0], first],
                [folders[1], second],
                [folders[0], parent],
                [folders[1], control],
              ]
            : [
                [folders[0], first],
                [folders[1], second],
                [folders[0], parent],
              ]
          ).sort((a, b) => a[1] - b[1])
        );
      }
    }
    const flat = new BatchLiveView();
    flat.initWithFolders(folders);
    Assert.deepEqual(
      (await flat.selectMessages())
        .map(row => [row.folderId, row.id])
        .sort((a, b) => a[1] - b[1]),
      [
        [folders[0], first],
        [folders[1], second],
        [folders[1], control],
        [folders[0], parent],
      ].sort((a, b) => a[1] - b[1])
    );
  } finally {
    for (const { adapter } of fixtures) adapter.setTree(null);
  }
});

add_task(
  async function test_nativeUnawareListenerRejectsGraphChangeBeforeCommit() {
    const folders = batchFolders("views-batch-unaware");
    const child = insertBatchMessage(
      folders[1],
      "unaware-child@views-batch.invalid",
      ["unaware-parent@views-batch.invalid"]
    );
    const view = new BatchLiveView();
    view.initWithFolders(folders);
    const before = (await view.selectMessages()).map(row => [
      row.folderId,
      row.id,
      row.threadId,
      row.threadParent,
    ]);
    const events = [];
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsILiveViewListener"]),
      onMessageAdded(message) {
        events.push(message);
      },
      onMessageRemoved(message) {
        events.push(message);
      },
      onMessageFlagsChanged(message) {
        events.push(message);
      },
      onMessageTagsChanged(message) {
        events.push(message);
      },
      onSelectedChunk() {},
    };
    view.setListener(listener);
    try {
      Assert.throws(
        () =>
          insertBatchMessage(
            folders[0],
            "unaware-parent@views-batch.invalid",
            []
          ),
        /NS_ERROR_NOT_AVAILABLE/
      );
      Assert.deepEqual(
        (await view.selectMessages()).map(row => [
          row.folderId,
          row.id,
          row.threadId,
          row.threadParent,
        ]),
        before
      );
      Assert.equal(messageDB.getMessage(child).threadParent, 0);
      Assert.deepEqual(
        events,
        [],
        "A rejected graph change publishes no row or replacement pair"
      );
    } finally {
      view.clearListener(listener);
    }
  }
);

add_task(function test_nativeUnknownListenerCapabilityNeverRunsGetters() {
  const liveView = new BatchLiveView();
  const folders = batchFolders("views-batch-capability-getter");
  liveView.initWithFolders(folders);
  const events = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsILiveViewListener"]),
    get panoramaThreadBatchVersion() {
      Assert.ok(false, "Capability admission must not call an external getter");
    },
    onMessageAdded(message) {
      events.push(["add", message.folderId, message.id, message.messageId]);
    },
    onMessageRemoved(message) {
      events.push(["remove", message.folderId, message.id, message.messageId]);
    },
    onMessageFlagsChanged() {
      Assert.ok(false, "No flag change");
    },
    onMessageTagsChanged() {
      Assert.ok(false, "No tag change");
    },
    onSelectedChunk() {
      Assert.ok(false, "No query");
    },
  };
  liveView.setListener(listener);
  let id;
  try {
    id = insertBatchMessage(
      folders[0],
      "views035-unknown-listener@invalid",
      []
    );
    Assert.deepEqual(events, [
      ["add", folders[0], id, "views035-unknown-listener@invalid"],
    ]);
    messageDB.removeMessage(id);
    id = null;
    Assert.deepEqual(
      events.map(event => event[0]),
      ["add", "remove"]
    );
    Assert.deepEqual(events[1].slice(1), events[0].slice(1));
  } finally {
    liveView.clearListener(listener);
    if (id) messageDB.removeMessage(id);
  }
});

add_task(
  async function test_nativeUnawareUnrelatedViewDoesNotVetoGraphChange() {
    const folders = batchFolders("views-batch-unrelated-listener");
    const child = insertBatchMessage(
      folders[0],
      "unrelated-child@views-batch.invalid",
      ["unrelated-parent@views-batch.invalid"]
    );
    const view = new BatchLiveView();
    view.initWithFolder(folders[1]);
    const events = [];
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsILiveViewListener"]),
      onMessageAdded(message) {
        events.push(message);
      },
      onMessageRemoved(message) {
        events.push(message);
      },
      onMessageFlagsChanged(message) {
        events.push(message);
      },
      onMessageTagsChanged(message) {
        events.push(message);
      },
      onSelectedChunk() {},
    };
    view.setListener(listener);
    try {
      const parent = insertBatchMessage(
        folders[0],
        "unrelated-parent@views-batch.invalid",
        []
      );
      Assert.equal(
        messageDB.getMessage(child).threadParent,
        parent,
        "The actual old row changed; ordinary add-only behavior cannot satisfy this control"
      );
      Assert.equal(
        messageDB.getMessage(child).threadId,
        messageDB.getMessage(parent).threadId
      );
      Assert.deepEqual(
        events,
        [],
        "The unaware view's physical scope excludes the changed rows and publication"
      );
      Assert.equal(await view.countMessages(), 0);
    } finally {
      view.clearListener(listener);
    }
  }
);

/**
 * Records literal owned notification fields without keeping a mutable header.
 *
 * @param {object[]} events - Recorded notifications.
 * @param {Function} [onEvent] - Earlier listener's reentrant mutation.
 * @returns {nsILiveViewListener} An ordinary unaware listener.
 */
function capturedBatchListener(events, onEvent = () => {}) {
  const record = (kind, message, previous) => {
    events.push([
      kind,
      message.folderId,
      message.id,
      message.messageId,
      message.flags,
      message.tags,
      previous,
    ]);
    onEvent(kind, message);
  };
  return {
    QueryInterface: ChromeUtils.generateQI(["nsILiveViewListener"]),
    onMessageAdded: message => record("add", message),
    onMessageRemoved: message => record("remove", message),
    onMessageFlagsChanged: (message, oldFlags) =>
      record("flags", message, oldFlags),
    onMessageTagsChanged: (message, oldTags) =>
      record("tags", message, oldTags),
    onSelectedChunk() {},
  };
}

add_task(
  async function test_nativeCapturedPublicationSurvivesEarlierDeletion() {
    const folders = batchFolders("views-captured-publish-delete");
    const first = new BatchLiveView(),
      second = new BatchLiveView();
    first.initWithFolder(folders[0]);
    second.initWithFolder(folders[0]);
    const earlier = [],
      later = [];
    const a = capturedBatchListener(earlier, (kind, message) => {
      if (kind == "add") messageDB.removeMessage(message.id);
    });
    const b = capturedBatchListener(later);
    first.setListener(a);
    second.setListener(b);
    try {
      const id = insertBatchMessage(
        folders[0],
        "captured-publish@views.invalid",
        []
      );
      Assert.deepEqual(later, [
        [
          "add",
          folders[0],
          id,
          "captured-publish@views.invalid",
          0,
          "",
          undefined,
        ],
        [
          "remove",
          folders[0],
          id,
          "captured-publish@views.invalid",
          0,
          "",
          undefined,
        ],
      ]);
      Assert.deepEqual(
        earlier,
        later,
        "Both views consume the same historical facts"
      );
      Assert.equal(await second.countMessages(), 0);
      Assert.deepEqual(await second.selectMessages(), []);
    } finally {
      first.clearListener(a);
      second.clearListener(b);
    }
  }
);

add_task(function test_nativeCapturedFlagsAndTagsSurviveEarlierMutation() {
  const folders = batchFolders("views-captured-flags-tags");
  const id = insertBatchMessage(
    folders[0],
    "captured-change@views.invalid",
    []
  );
  const header = messageDB.getMessage(id);
  const first = new BatchLiveView(),
    second = new BatchLiveView();
  first.initWithFolder(folders[0]);
  second.initWithFolder(folders[0]);
  const earlier = [],
    later = [];
  const read = Ci.nsMsgMessageFlags.Read;
  const a = capturedBatchListener(earlier, (kind, message) => {
    if (kind == "flags" && message.flags == read)
      header.flags = read | Ci.nsMsgMessageFlags.Marked;
    if (kind == "tags" && message.tags == "first")
      header.setStringProperty("keywords", "second");
  });
  const b = capturedBatchListener(later);
  first.setListener(a);
  second.setListener(b);
  try {
    header.flags = read;
    header.setStringProperty("keywords", "first");
    Assert.deepEqual(later, [
      ["flags", folders[0], id, "captured-change@views.invalid", read, "", 0],
      [
        "flags",
        folders[0],
        id,
        "captured-change@views.invalid",
        read | Ci.nsMsgMessageFlags.Marked,
        "",
        read,
      ],
      [
        "tags",
        folders[0],
        id,
        "captured-change@views.invalid",
        read | Ci.nsMsgMessageFlags.Marked,
        "first",
        "",
      ],
      [
        "tags",
        folders[0],
        id,
        "captured-change@views.invalid",
        read | Ci.nsMsgMessageFlags.Marked,
        "second",
        "first",
      ],
    ]);
    Assert.deepEqual(earlier, later);
    Assert.equal(
      messageDB.getMessage(id).flags,
      read | Ci.nsMsgMessageFlags.Marked
    );
    Assert.equal(
      messageDB.getMessage(id).getStringProperty("keywords"),
      "second"
    );
  } finally {
    first.clearListener(a);
    second.clearListener(b);
  }
});

add_task(
  async function test_nativePreInsertMappingPreservesUnloadedSelections() {
    const folders = batchFolders("views-batch-native-holes");
    const first = insertBatchMessage(
      folders[0],
      "hole-first@views.invalid",
      ["hole-parent@views.invalid"],
      1
    );
    const second = insertBatchMessage(
      folders[1],
      "hole-second@views.invalid",
      ["hole-parent@views.invalid"],
      2
    );
    const control = insertBatchMessage(
      folders[1],
      "hole-control@views.invalid",
      [],
      3
    );
    const fixtures = [];
    try {
      for (const Adapter of [
        LiveViewDataAdapter,
        LiveViewThreadedDataAdapter,
        LiveViewConversationsDataAdapter,
        LiveViewGroupedDataAdapter,
      ]) {
        const fixture = await nativeBatchAdapter(Adapter, folders);
        fixtures.push(fixture);
        const { adapter, liveView } = fixture;
        if (Adapter == LiveViewGroupedDataAdapter) {
          const root = adapter.rowAt(0);
          const members =
            await liveView.selectMessagesInGroup("Retained subject");
          const child = members.findIndex(message => message.id == second);
          Assert.ok(child >= 0);
          root.open = true;
          adapter._clearFlatRowCache();
          adapter.selection.rangedSelect(child + 1, child + 1, false);
          Assert.equal(
            root.children[child],
            undefined,
            "The selected child has not loaded"
          );
        } else {
          const index = adapter._rowMap.findIndex(
            row => row.message.id == second
          );
          Assert.ok(index >= 0);
          delete adapter._rowMap[index];
          adapter._clearFlatRowCache();
          adapter.selection.rangedSelect(index, index, false);
          Assert.equal(adapter._rowMap[index], undefined);
        }
      }
      const parent = insertBatchMessage(
        folders[0],
        "hole-parent@views.invalid",
        [],
        4
      );
      Assert.equal(messageDB.getMessage(first).threadParent, parent);
      Assert.equal(messageDB.getMessage(second).threadParent, parent);
      Assert.notEqual(
        messageDB.getMessage(control).threadId,
        messageDB.getMessage(parent).threadId
      );
      for (const { adapter, tree } of fixtures) {
        await adapter._batchRefreshPromise;
        const selected = adapter.rowAt(adapter.selection.currentIndex);
        const conversations =
          adapter instanceof LiveViewConversationsDataAdapter;
        Assert.deepEqual(
          [selected.message.folderId, selected.message.id],
          conversations ? [folders[0], parent] : [folders[1], second]
        );
        Assert.ok(adapter.selection.isSelected(adapter.selection.currentIndex));
        Assert.equal(
          adapter.selection.shiftSelectPivot,
          adapter.selection.currentIndex
        );
        Assert.equal(
          tree.resets,
          1,
          "One settled tree preserves the physical selection"
        );
      }
      const verify = new BatchLiveView();
      verify.initWithFolders(folders);
      Assert.deepEqual(
        (await verify.selectMessages())
          .map(row => [row.folderId, row.id])
          .sort((a, b) => a[1] - b[1]),
        [
          [folders[0], first],
          [folders[1], second],
          [folders[1], control],
          [folders[0], parent],
        ].sort((a, b) => a[1] - b[1])
      );
    } finally {
      for (const { adapter } of fixtures) adapter.setTree(null);
    }
  }
);

add_task(async function test_nativeBatchDuringCountKeepsAllAdapterSelections() {
  const folders = batchFolders("views-batch-during-count");
  const first = insertBatchMessage(
    folders[0],
    "count-first@views.invalid",
    ["count-parent@views.invalid"],
    1
  );
  const second = insertBatchMessage(
    folders[1],
    "count-second@views.invalid",
    ["count-parent@views.invalid"],
    2
  );
  const control = insertBatchMessage(
    folders[1],
    "count-control@views.invalid",
    [],
    3
  );
  const fixtures = [],
    sorts = [];
  try {
    for (const Adapter of [
      LiveViewDataAdapter,
      LiveViewThreadedDataAdapter,
      LiveViewConversationsDataAdapter,
      LiveViewGroupedDataAdapter,
    ]) {
      const fixture = await nativeBatchAdapter(Adapter, folders);
      fixtures.push(fixture);
      const { adapter, liveView } = fixture;
      if (Adapter == LiveViewGroupedDataAdapter) {
        const members =
          await liveView.selectMessagesInGroup("Retained subject");
        const index = members.findIndex(message => message.id == second);
        adapter.rowAt(0).open = true;
        adapter._clearFlatRowCache();
        adapter.selection.rangedSelect(index + 1, index + 1, false);
      } else {
        const index = adapter._rowMap.findIndex(
          row => row.message.id == second
        );
        Assert.ok(index >= 0);
        delete adapter._rowMap[index];
        adapter._clearFlatRowCache();
        adapter.selection.rangedSelect(index, index, false);
      }
    }
    for (const { adapter } of fixtures)
      sorts.push(
        adapter.sortBy(
          adapter instanceof LiveViewGroupedDataAdapter ? "sender" : "date",
          "descending"
        )
      );
    const parent = insertBatchMessage(
      folders[0],
      "count-parent@views.invalid",
      [],
      4
    );
    await Promise.all(sorts);
    Assert.equal(messageDB.getMessage(first).threadParent, parent);
    Assert.equal(messageDB.getMessage(second).threadParent, parent);
    Assert.notEqual(
      messageDB.getMessage(control).threadId,
      messageDB.getMessage(parent).threadId
    );
    for (const { adapter, liveView, tree } of fixtures) {
      Assert.strictEqual(
        adapter._liveView,
        liveView,
        "A real in-flight count does not invalidate the consumer"
      );
      const selected = adapter.rowAt(adapter.selection.currentIndex);
      Assert.deepEqual(
        [selected.message.folderId, selected.message.id],
        adapter instanceof LiveViewConversationsDataAdapter
          ? [folders[0], parent]
          : [folders[1], second]
      );
      Assert.ok(adapter.selection.isSelected(adapter.selection.currentIndex));
      Assert.equal(
        adapter.selection.shiftSelectPivot,
        adapter.selection.currentIndex
      );
      Assert.equal(tree.resets, 1);
    }
    const verify = new BatchLiveView();
    verify.initWithFolders(folders);
    Assert.deepEqual(
      (await verify.selectMessages())
        .map(message => [message.folderId, message.id])
        .sort((a, b) => a[1] - b[1]),
      [
        [folders[0], first],
        [folders[1], second],
        [folders[1], control],
        [folders[0], parent],
      ].sort((a, b) => a[1] - b[1])
    );

    const { adapter: grouped, tree } = fixtures.find(
      ({ adapter }) => adapter instanceof LiveViewGroupedDataAdapter
    );
    const group = grouped.rowAt(0);
    const current = grouped.rowAt(grouped.selection.currentIndex);
    const pivot = Array.from({ length: grouped.rowCount }, (_, index) =>
      grouped.rowAt(index)
    ).find(row => row.message?.id == control);
    Assert.ok(group.open);
    Assert.ok(pivot);
    grouped.selection.select(0);
    grouped.selection.currentIndex = grouped.indexOf(current);
    grouped.selection._shiftSelectPivot = grouped.indexOf(pivot);
    const followUp = insertBatchMessage(
      folders[1],
      "count-followup@views.invalid",
      ["count-parent@views.invalid"],
      5
    );
    Assert.strictEqual(grouped.rowAt(0), group);
    Assert.ok(group.open, "The acknowledged sender group stays expanded");
    Assert.ok(grouped.selection.isSelected(0));
    Assert.strictEqual(grouped.rowAt(grouped.selection.currentIndex), current);
    Assert.strictEqual(
      grouped.rowAt(grouped.selection.shiftSelectPivot),
      pivot
    );
    Assert.equal(group.children.length, 5);
    Assert.equal(tree.resets, 2);
    Assert.equal(messageDB.getMessage(followUp).threadParent, parent);
    Assert.deepEqual(
      (await verify.selectMessages())
        .map(message => [message.folderId, message.id])
        .sort((a, b) => a[1] - b[1]),
      [
        [folders[0], first],
        [folders[1], second],
        [folders[1], control],
        [folders[0], parent],
        [folders[1], followUp],
      ].sort((a, b) => a[1] - b[1])
    );
  } finally {
    for (const { adapter } of fixtures) adapter.setTree(null);
  }
});
