/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  TreeDataAdapter,
  TreeDataRow,
} from "chrome://messenger/content/TreeDataAdapter.mjs";

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "collator", () => new Intl.Collator());
ChromeUtils.defineLazyGetter(
  lazy,
  "dateFormatter",
  () =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "short",
      timeStyle: "short",
      hourCycle: "h23",
    })
);
ChromeUtils.defineLazyGetter(lazy, "dateGroupLabels", () => {
  // FIXME: We don't have a way to pass L10n IDs to the tree-view widget.
  const l10n = new Localization(["messenger/messenger.ftl"], true);
  return {
    [Ci.nsILiveView.DATE_GROUP_FUTURE]: l10n.formatValueSync(
      "message-group-future-date"
    ),
    [Ci.nsILiveView.DATE_GROUP_TODAY]: l10n.formatValueSync(
      "message-group-today"
    ),
    [Ci.nsILiveView.DATE_GROUP_YESTERDAY]: l10n.formatValueSync(
      "message-group-yesterday"
    ),
    [Ci.nsILiveView.DATE_GROUP_LAST_SEVEN_DAYS]: l10n.formatValueSync(
      "message-group-last-seven-days"
    ),
    [Ci.nsILiveView.DATE_GROUP_LAST_FOURTEEN_DAYS]: l10n.formatValueSync(
      "message-group-last-fourteen-days"
    ),
  };
});
ChromeUtils.defineLazyGetter(
  lazy,
  "yearFormatter",
  () => new Intl.DateTimeFormat(undefined, { year: "numeric" })
);

/**
 * A map of column names to nsILiveView_SortColumn constants.
 */
const columns = {
  date: Ci.nsILiveView.DATE,
  subject: Ci.nsILiveView.SUBJECT,
  sender: Ci.nsILiveView.SENDER,
  recipients: Ci.nsILiveView.RECIPIENTS,
  unread: Ci.nsILiveView.READ_FLAG,
  flagged: Ci.nsILiveView.MARKED_FLAG,
};

/**
 * Compare two messages for ordering their rows.
 *
 * @typedef {Function} Comparator
 * @param {Message} a - A message object.
 * @param {Message} b - A message object.
 * @returns {boolean} - True if message A should be above message B.
 */

/**
 * Get a comparator that can be used to put messages in alphabetical order.
 *
 * @param {string} property - The message property to be used for ordering.
 * @returns {Comparator} - A function that accepts two messages, A and B, and
 *   returns true if message A is ahead of message B in the alphabet.
 */
function getTextComparator(property) {
  return (a, b) => lazy.collator.compare(a[property], b[property]) < 0;
}

/**
 * A map of column names to comparators for ordering.
 */
const comparators = {
  date: (a, b) => a.date < b.date,
  subject: getTextComparator("subject"),
  sender: getTextComparator("sender"),
  recipients: getTextComparator("recipients"),
  // Unread messages come first, but the flag is for read messages.
  unread: (a, b) =>
    (a.flags & Ci.nsMsgMessageFlags.Read) <
    (b.flags & Ci.nsMsgMessageFlags.Read),
  flagged: (a, b) =>
    (a.flags & Ci.nsMsgMessageFlags.Marked) >
    (b.flags & Ci.nsMsgMessageFlags.Marked),
};

/**
 * Represents a message in the message database. These fields are not live.
 *
 * @typedef {object} Message
 * @property {integer} id - Identifier in the messages database.
 * @property {integer} folderId - Identifier of the containing folder.
 * @property {string} messageId - The Message-ID header.
 * @property {Date} date - Value of the Date header.
 * @property {string} sender
 * @property {string} recipients
 * @property {string} subject
 * @property {integer} flags
 * @property {string} tags - A space-separated list of nsIMsgTag keys.
 * @property {integer} threadId - The captured conversation identifier.
 * @property {integer} threadParent - The captured physical parent key.
 */

const threadBatchFields = [
  "id",
  "folderId",
  "messageId",
  "date",
  "sender",
  "recipients",
  "subject",
  "flags",
  "tags",
  "threadId",
  "threadParent",
];

/**
 * Checks whether a captured value fits its unsigned 32-bit native field.
 *
 * @param {number} value - The captured numeric value.
 * @returns {boolean} Whether the value is an unsigned 32-bit integer.
 */
function isThreadBatchUint32(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

/**
 * Validates a captured physical identity and returns its map key.
 *
 * @param {object} row - A captured row or physical pair.
 * @param {Map<number, number>} [foldersByKey] - Batch-local global key bindings.
 * @returns {string} Its physical identity.
 * @throws {Error} If either identifier is invalid or its folder binding differs.
 */
function threadBatchKey(row, foldersByKey) {
  if (
    !row ||
    !isThreadBatchUint32(row.id) ||
    row.id == 0 ||
    row.id == 0xffffffff ||
    !Number.isSafeInteger(row.folderId) ||
    row.folderId <= 0
  ) {
    throw new Error("Invalid thread batch physical identity");
  }
  if (foldersByKey?.has(row.id) && foldersByKey.get(row.id) != row.folderId) {
    throw new Error("Conflicting thread batch global key folder");
  }
  foldersByKey?.set(row.id, row.folderId);
  return `${row.folderId}:${row.id}`;
}

/**
 * Copies a complete captured row without retaining its mutable Date.
 *
 * @param {object} row - The captured row.
 * @returns {Message} A validated independent row.
 * @throws {Error} If any captured row field is missing or invalid.
 */
function copyThreadBatchRow(row) {
  threadBatchKey(row);
  if (
    Object.keys(row).length != threadBatchFields.length ||
    threadBatchFields.some(field => !Object.hasOwn(row, field)) ||
    ["messageId", "sender", "recipients", "subject", "tags"].some(
      field => typeof row[field] != "string"
    ) ||
    ["flags", "threadId", "threadParent"].some(
      field => !isThreadBatchUint32(row[field])
    ) ||
    Object.prototype.toString.call(row.date) != "[object Date]" ||
    !Number.isFinite(row.date.valueOf())
  ) {
    throw new Error("Invalid captured thread batch row");
  }
  return { ...row, date: new Date(row.date.valueOf()) };
}

/**
 * Checks complete captured group membership and aggregate counts.
 *
 * @param {object[]} groups - Captured groups for one side of the batch.
 * @param {Map<string, Message>} rows - Matching captured rows on that side.
 * @throws {Error} If group membership or totals are incomplete or invalid.
 */
function validateThreadBatchGroups(groups, rows) {
  if (!Array.isArray(groups)) {
    throw new Error("Missing captured thread batch groups");
  }
  const keys = new Set();
  const members = new Set();
  for (const group of groups) {
    if (
      !group.key ||
      !["thread", "sort"].includes(group.key.kind) ||
      !["string", "number"].includes(typeof group.key.value) ||
      !Array.isArray(group.members)
    ) {
      throw new Error("Invalid captured thread batch group");
    }
    const key = JSON.stringify([group.key.kind, group.key.value]);
    if (keys.has(key)) {
      throw new Error("Duplicate captured thread batch group");
    }
    keys.add(key);
    let newCount = 0;
    let unreadCount = 0;
    const ownMembers = new Set();
    for (const pair of group.members) {
      const member = threadBatchKey(pair);
      const row = rows.get(member);
      if (
        !row ||
        members.has(member) ||
        (group.key.kind == "thread" && group.key.value != row.threadId)
      ) {
        throw new Error("Incomplete captured thread batch group");
      }
      members.add(member);
      ownMembers.add(member);
      newCount += !!(row.flags & Ci.nsMsgMessageFlags.New);
      unreadCount += !(row.flags & Ci.nsMsgMessageFlags.Read);
    }
    if (
      group.messageCount !== ownMembers.size ||
      group.newCount !== newCount ||
      group.unreadCount !== unreadCount ||
      (ownMembers.size
        ? !ownMembers.has(threadBatchKey(group.representative))
        : group.representative !== null)
    ) {
      throw new Error("Invalid captured thread batch group totals");
    }
  }
  if (groups.length && members.size != rows.size) {
    throw new Error("Missing captured thread batch group members");
  }
}

/**
 * Adapts message data from nsILiveView for display in a TreeView. This class
 * lists messages as a flat list.
 *
 * @augments {TreeDataAdapter}
 * @implements {nsILiveViewListener}
 */
export class LiveViewDataAdapter extends TreeDataAdapter {
  QueryInterface = ChromeUtils.generateQI(["nsILiveViewListener"]);

  _liveView;
  _sortComparator = comparators.date;
  _viewGeneration = 0;
  _queryGeneration = 0;
  // Native LiveView reads these own data properties only at attachment.
  panoramaThreadBatchVersion = 1;
  panoramaThreadBatchGeneration = 0;
  panoramaThreadBatchOwner = this;
  panoramaThreadBatchInvalidated = () => this._invalidateThreadBatch();
  _queryListener = null;
  _threadBatchId = null;
  _threadBatchGrouping;

  /**
   * @param {nsILiveView} liveView
   * @param {nsILiveView_Grouping} [grouping=Ci.nsILiveView.UNTHREADED] -
   *   set to Ci.nsILiveView.THREADED for one row only per thread.
   */
  constructor(liveView, grouping = Ci.nsILiveView.UNTHREADED) {
    super();
    this._threadBatchGrouping = grouping;
    liveView.grouping = grouping;
    liveView.setListener(this);
    this._liveView = liveView;
  }

  /**
   * Extends TreeDataAdapter.setTree so that references are cleaned up when
   * the tree changes.
   *
   * @param {TreeView} tree
   */
  setTree(tree) {
    const replaced = tree && this._tree && tree != this._tree;
    if (!tree || replaced) {
      this._viewGeneration++;
      this._queryGeneration++;
    }
    if (!tree) {
      this._liveView?.clearListener(this._queryListener ?? this);
      this._liveView = null;
      this._rowMap.length = 0;
      this._clearFlatRowCache();
    }
    super.setTree(tree);
    if (replaced && this._liveView) {
      this._batchRefreshPromise = this.sortBy(
        this.sortColumn,
        this.sortDirection
      ).catch(error => this._invalidateThreadBatch(error));
    }
  }

  async sortBy(sortColumn, sortDirection, _resort = false) {
    if (!(sortColumn in columns)) {
      sortColumn = "date";
    }
    if (!["ascending", "descending"].includes(sortDirection)) {
      sortDirection = "descending";
    }
    this.sortColumn = sortColumn;
    this.sortDirection = sortDirection;
    this._sortComparator = comparators[sortColumn];
    this._liveView.sortColumn = columns[sortColumn];
    this._liveView.sortDescending = sortDirection == "descending";

    const liveView = this._liveView;
    const generation = ++this._queryGeneration;
    this.panoramaThreadBatchGeneration = ++this._viewGeneration;
    this._queryListener = this._makeQueryListener(generation);
    liveView.setListener(this._queryListener);
    try {
      const count = await liveView.countMessages();
      if (generation != this._queryGeneration || liveView != this._liveView) {
        return;
      }
      this._rowMap.length = 0;
      this._rowMap.length = count;
      this._clearFlatRowCache();
      if (this._threadBatchGrouping != Ci.nsILiveView.UNTHREADED) {
        this._setBatchGroupMap(new Map());
      }
      // Acknowledge the new positional map before starting its query.
      liveView.setListener(this._queryListener);
      await liveView.selectMessages();
    } catch (error) {
      if (generation != this._queryGeneration || liveView != this._liveView) {
        return;
      }
      throw error;
    }
  }

  /**
   * Binds positional query chunks to the query that requested them.
   *
   * @param {number} generation - The current query generation.
   * @returns {nsILiveViewListener} A listener with guarded chunk delivery.
   */
  _makeQueryListener(generation) {
    const adapter = this;
    return {
      QueryInterface: ChromeUtils.generateQI(["nsILiveViewListener"]),
      panoramaThreadBatchVersion: 1,
      panoramaThreadBatchGeneration: adapter._viewGeneration,
      panoramaThreadBatchOwner: adapter,
      panoramaThreadBatchInvalidated: adapter.panoramaThreadBatchInvalidated,
      onMessageAdded: message =>
        adapter._liveView && adapter.onMessageAdded(message),
      onMessageRemoved: message =>
        adapter._liveView && adapter.onMessageRemoved(message),
      onMessageFlagsChanged: (message, flags) =>
        adapter._liveView && adapter.onMessageFlagsChanged(message, flags),
      onMessageTagsChanged: (message, tags) =>
        adapter._liveView && adapter.onMessageTagsChanged(message, tags),
      onSelectedChunk(messages, start, end) {
        if (adapter._liveView && generation == adapter._queryGeneration) {
          adapter.onSelectedChunk(messages, start, end);
        }
      },
    };
  }

  /**
   * Checks descriptor shape and component identities before preparing rows.
   *
   * @param {object} batch - The version 1 captured descriptor.
   * @throws {Error} If the descriptor is invalid or stale.
   */
  _validateThreadBatchDescriptor(batch) {
    if (
      typeof batch.batchId != "string" ||
      !/^[1-9][0-9]*$/.test(batch.batchId) ||
      (this._threadBatchId !== null &&
        BigInt(batch.batchId) <= this._threadBatchId) ||
      !Array.isArray(batch.rows) ||
      !batch.componentThreadIds ||
      !batch.groups
    ) {
      throw new Error("Invalid thread batch descriptor");
    }
    for (const side of ["before", "after"]) {
      const ids = batch.componentThreadIds[side];
      if (
        !Array.isArray(ids) ||
        new Set(ids).size != ids.length ||
        ids.some(id => !isThreadBatchUint32(id))
      ) {
        throw new Error("Invalid thread batch component identifiers");
      }
    }
  }

  /**
   * Prepares captured rows and complete affected groups without notifying the tree.
   *
   * @param {object} batch - The version 1 captured descriptor.
   * @returns {object} Prepared rows, updates and selected physical identities.
   * @throws {Error} If captured facts are invalid or this draft cannot apply them.
   */
  _prepareThreadBatch(batch) {
    this._validateThreadBatchDescriptor(batch);
    const foldersByKey = new Map();
    const publication = threadBatchKey(batch.publication, foldersByKey);
    const changes = new Map();
    const sides = { before: new Map(), after: new Map() };
    let publications = 0;
    for (const change of batch.rows) {
      const before =
        change.before === null ? null : copyThreadBatchRow(change.before);
      const after =
        change.after === null ? null : copyThreadBatchRow(change.after);
      if (
        (!before && !after) ||
        typeof change.matchesBefore != "boolean" ||
        typeof change.matchesAfter != "boolean" ||
        (!before && change.matchesBefore) ||
        (!after && change.matchesAfter)
      ) {
        throw new Error("Invalid thread batch membership");
      }
      const key = threadBatchKey(before ?? after, foldersByKey);
      if (
        (before && after && key != threadBatchKey(after, foldersByKey)) ||
        changes.has(key)
      ) {
        throw new Error("Duplicate or changed thread batch physical identity");
      }
      if (!before) {
        if (key != publication || !after) {
          throw new Error("Unexpected thread batch publication");
        }
        publications++;
      }
      if (
        (!before ||
          !after ||
          before.threadId != after.threadId ||
          before.threadParent != after.threadParent) &&
        ((before &&
          !batch.componentThreadIds.before.includes(before.threadId)) ||
          (after && !batch.componentThreadIds.after.includes(after.threadId)))
      ) {
        throw new Error("Thread batch omits an affected component");
      }
      const entry = { ...change, before, after };
      changes.set(key, entry);
      if (change.matchesBefore) {
        sides.before.set(key, before);
      }
      if (change.matchesAfter) {
        sides.after.set(key, after);
      }
    }
    if (publications != 1) {
      throw new Error("Missing unique thread batch publication");
    }
    validateThreadBatchGroups(batch.groups.before, sides.before);
    validateThreadBatchGroups(batch.groups.after, sides.after);
    if (this.selection && !("_shiftSelectPivot" in this.selection)) {
      throw new Error("Thread batch requires concrete TreeSelection");
    }
    if (this._tree && typeof this._tree.reset != "function") {
      throw new Error("Thread batch requires a tree reset");
    }
    this._validateCachedThreadBatch(
      changes,
      batch.componentThreadIds.before,
      foldersByKey
    );
    const beforeView = this._prepareBatchBeforeView(
      batch.beforeView,
      foldersByKey,
      changes
    );
    if (this._threadBatchGrouping != Ci.nsILiveView.UNTHREADED) {
      const kind =
        this._threadBatchGrouping == Ci.nsILiveView.THREADED
          ? "thread"
          : "sort";
      for (const group of [...batch.groups.before, ...batch.groups.after]) {
        if (
          group.key.kind != kind ||
          (kind == "thread" && !isThreadBatchUint32(group.key.value)) ||
          (typeof group.key.value == "number" &&
            !Number.isSafeInteger(group.key.value))
        ) {
          throw new Error("Invalid thread batch grouping key");
        }
      }
      if (
        (sides.before.size && !batch.groups.before.length) ||
        (sides.after.size && !batch.groups.after.length)
      ) {
        throw new Error(
          "Thread batch grouped consumer is held without complete groups"
        );
      }
      return this._prepareGroupedThreadBatch(
        batch,
        changes,
        sides,
        foldersByKey,
        beforeView
      );
    }
    const cachedRows = new Map(
      this._rowMap
        .filter(Boolean)
        .map(row => [threadBatchKey(row.message), row])
    );
    const saved = beforeView?.contextual
      ? this._captureBatchSelection(beforeView)
      : null;
    let oldRows;
    if (beforeView?.contextual) {
      oldRows = beforeView.roots
        .map(
          entry =>
            cachedRows.get(threadBatchKey(entry.message)) ??
            this._setUpRow(entry.message)
        )
        .sort((a, b) => {
          const aIndex = beforeView.oldOrder.indexOf(threadBatchKey(a.message));
          const bIndex = beforeView.oldOrder.indexOf(threadBatchKey(b.message));
          return (
            (aIndex < 0 ? Infinity : aIndex) - (bIndex < 0 ? Infinity : bIndex)
          );
        });
    } else if (beforeView) {
      oldRows = Array.from(
        this._rowMap,
        (row, index) => row ?? this._setUpRow(beforeView.roots[index].message)
      );
    } else {
      oldRows = this._rowMap;
    }
    if (Array.from(oldRows).some(row => !row)) {
      if (
        typeof this._liveView.countMessages != "function" ||
        typeof this._liveView.selectMessages != "function"
      ) {
        throw new Error(
          "Thread batch sparse flat consumer is held without query support"
        );
      }
      return {
        refresh: true,
        selection: this._captureBatchSelection(beforeView),
        beforeView,
      };
    }
    const selection = this.selection;
    if (selection && !("_shiftSelectPivot" in selection)) {
      throw new Error("Thread batch requires concrete TreeSelection");
    }
    if (this._tree && typeof this._tree.reset != "function") {
      throw new Error("Thread batch requires a tree reset");
    }
    const selected = new Set();
    const current = oldRows[selection?.currentIndex];
    const pivot = oldRows[selection?.shiftSelectPivot];
    const existing = new Map();
    const next = [];
    const updates = [];
    for (const [index, row] of oldRows.entries()) {
      const key = threadBatchKey(row.message, foldersByKey);
      if (existing.has(key)) {
        throw new Error("Duplicate cached physical row");
      }
      existing.set(key, row);
      if (selection?.isSelected(index)) {
        selected.add(row);
      }
      const change = changes.get(key);
      if (!change) {
        if (batch.componentThreadIds.before.includes(row.message.threadId)) {
          throw new Error("Thread batch omits a cached component member");
        }
        next.push({ row, message: row.message });
        continue;
      }
      if (
        !change.matchesBefore ||
        threadBatchFields.some(field =>
          field == "date"
            ? row.message.date.valueOf() != change.before.date.valueOf()
            : row.message[field] !== change.before[field]
        )
      ) {
        throw new Error("Thread batch preimage differs from cached row");
      }
      if (change.matchesAfter) {
        // Allocate and format the captured after-image before installing it.
        this._setUpRow(change.after).getText("date");
        updates.push([row, change.after]);
        next.push({ row, message: change.after });
      }
    }
    for (const [key, change] of changes) {
      if (change.matchesBefore && !existing.has(key)) {
        throw new Error("Thread batch is missing a cached preimage");
      }
      if (change.matchesAfter && !change.matchesBefore) {
        if (existing.has(key)) {
          throw new Error("Thread batch would duplicate a physical row");
        }
        next.push({ row: this._setUpRow(change.after), message: change.after });
      }
    }
    next.sort((a, b) => {
      if (this._compareMessages(a.message, b.message)) {
        return -1;
      }
      return this._compareMessages(b.message, a.message) ? 1 : 0;
    });
    return {
      rows: next.map(item => item.row),
      updates,
      saved,
      selected,
      current,
      pivot,
    };
  }

  /**
   * Intercepts the unwired descriptor before any ordinary insertion path.
   *
   * @param {object} batch - An ordinary row or captured descriptor.
   * @returns {boolean} Whether this was a descriptor, including stale delivery.
   * @throws {Error} If the descriptor is invalid or its consumer is held.
   */
  _consumeThreadBatch(batch) {
    if (batch?.kind !== "panorama-thread-batch") {
      return false;
    }
    if (
      batch.version !== 1 ||
      !Number.isSafeInteger(batch.viewGeneration) ||
      batch.viewGeneration < 0
    ) {
      throw new Error("Unsupported thread batch version or generation");
    }
    if (!this._liveView || batch.viewGeneration != this._viewGeneration) {
      return true;
    }
    const plan = this._prepareThreadBatch(batch);
    if (plan.refresh) {
      for (const row of plan.pendingGroups ?? []) {
        if (typeof row._childrenGeneration == "number") {
          row._childrenGeneration++;
        }
      }
      this._threadBatchId = BigInt(batch.batchId);
      this._batchRefreshPromise = this._refreshSparseThreadBatch(
        plan.selection,
        plan
      ).catch(error => this._invalidateThreadBatch(error));
      return true;
    }
    if (plan.grouped) {
      this._installGroupedThreadBatch(plan, batch);
      return true;
    }
    const selection = this.selection;
    const suppressed = selection?.selectEventsSuppressed;
    if (selection) {
      selection.selectEventsSuppressed = true;
    }
    try {
      for (const [row, message] of plan.updates) {
        row._initFromMessage(message);
      }
      this._rowMap = plan.rows;
      this._clearFlatRowCache();
      this._queryGeneration++;
      this._threadBatchId = BigInt(batch.batchId);
      if (plan.saved) {
        this._restoreBatchSelection(plan.saved);
      } else if (selection) {
        selection.clearSelection();
        for (const [index, row] of plan.rows.entries()) {
          if (plan.selected.has(row)) {
            selection.toggleSelect(index);
          }
        }
        selection.currentIndex = plan.rows.indexOf(plan.current);
        const pivot = plan.rows.indexOf(plan.pivot);
        selection._shiftSelectPivot = pivot < 0 ? null : pivot;
      }
      this._tree?.reset();
    } catch (error) {
      this._invalidateThreadBatch(error);
      throw error;
    } finally {
      if (selection) {
        selection.selectEventsSuppressed = suppressed;
      }
    }
    return true;
  }

  /**
   * Validates the native pre-insert query and copies its complete physical mapping.
   *
   * @param {object} [input] - Owned old roots and members from the native query.
   * @param {Map<number, number>} foldersByKey - Global physical key bindings.
   * @param {Map<string, object>} changes - Captured component preimages.
   * @returns {object|null} Validated old query, or null for older private fixtures.
   * @throws {Error} If the query configuration, membership or loaded roots differ.
   */
  _prepareBatchBeforeView(input, foldersByKey, changes) {
    if (input === undefined) {
      return null;
    }
    if (input && Object.hasOwn(input, "displayView")) {
      return this._prepareContextualBatchView(input, foldersByKey, changes);
    }
    if (
      !input ||
      input.grouping !== this._threadBatchGrouping ||
      input.sortColumn !== columns[this.sortColumn] ||
      input.sortDescending !== (this.sortDirection == "descending") ||
      !Array.isArray(input.roots) ||
      input.roots.length != this._rowMap.length
    ) {
      throw new Error("Thread batch old query configuration differs");
    }
    const seen = new Set();
    const roots = input.roots.map((entry, index) => {
      const message = copyThreadBatchRow(entry.message);
      const key = threadBatchKey(message, foldersByKey);
      if (typeof entry.group != "string" || !Array.isArray(entry.members)) {
        throw new Error("Invalid thread batch old query root");
      }
      const members = entry.members.map(copyThreadBatchRow);
      const grouped = this._threadBatchGrouping != Ci.nsILiveView.UNTHREADED;
      if (grouped ? !members.length : members.length) {
        throw new Error("Incomplete thread batch old query members");
      }
      const identities = (grouped ? members : [message]).map(member => {
        const identity = threadBatchKey(member, foldersByKey);
        if (seen.has(identity)) {
          throw new Error("Duplicate thread batch old query member");
        }
        seen.add(identity);
        const change = changes.get(identity);
        if (
          change &&
          (!change.matchesBefore ||
            threadBatchFields.some(field =>
              field == "date"
                ? member.date.valueOf() != change.before.date.valueOf()
                : member[field] !== change.before[field]
            ))
        ) {
          throw new Error(
            "Thread batch old query differs from captured preimage"
          );
        }
        if (
          this._threadBatchGrouping == Ci.nsILiveView.THREADED &&
          member.threadId != message.threadId
        ) {
          throw new Error("Thread batch old query crosses threads");
        }
        return identity;
      });
      if (!identities.includes(key)) {
        throw new Error("Missing old query representative");
      }
      const representative = grouped
        ? members.find(member => threadBatchKey(member) == key)
        : message;
      if (
        threadBatchFields.some(field =>
          field == "date"
            ? message.date.valueOf() != representative.date.valueOf()
            : message[field] !== representative[field]
        )
      ) {
        throw new Error(
          "Thread batch old query representative differs from member"
        );
      }
      if (
        this._threadBatchGrouping == Ci.nsILiveView.THREADED &&
        entry.group !== String(message.threadId)
      ) {
        throw new Error("Thread batch old query group differs");
      }
      const row = this._rowMap[index];
      if (row) {
        const summary = row.thread ?? row.message;
        if (
          (summary && threadBatchKey(summary, foldersByKey) != key) ||
          (!summary && String(row.group) !== entry.group)
        ) {
          throw new Error(
            "Thread batch old query order differs from cached roots"
          );
        }
        if (
          row instanceof LiveViewThreadDataRow &&
          row.children.length != members.length - 1
        ) {
          throw new Error("Thread batch old query child count differs");
        }
        if (
          row instanceof LiveViewGroupedHeaderRow &&
          row.children.length != members.length
        ) {
          throw new Error("Thread batch old query child count differs");
        }
        const ordered =
          row instanceof LiveViewThreadDataRow
            ? LiveViewThreadedDataAdapter.sortThread(
                members.map(member => ({ ...member }))
              ).slice(1)
            : members;
        row.children.forEach((child, childIndex) => {
          if (!child) {
            return;
          }
          const expected = ordered[childIndex];
          if (
            !expected ||
            threadBatchFields.some(field =>
              field == "date"
                ? child.message.date.valueOf() != expected.date.valueOf()
                : child.message[field] !== expected[field]
            )
          ) {
            throw new Error(
              "Thread batch old query differs from cached children"
            );
          }
        });
      }
      return { message, group: entry.group, members };
    });
    for (const [identity, change] of changes) {
      if (change.matchesBefore && !seen.has(identity)) {
        throw new Error("Thread batch old query omits a component member");
      }
    }
    return { roots };
  }

  /**
   * Copies one complete native query independently of its current display position.
   *
   * @param {object} input - Captured configuration, roots and members.
   * @param {Map<number, number>} folders - Global physical ownership bindings.
   * @returns {object} Owned scalar rows and query metadata.
   * @throws {Error} If physical membership or configuration is invalid.
   */
  _copyBatchQuery(input, folders) {
    if (
      !input ||
      input.grouping !== this._threadBatchGrouping ||
      !Object.values(columns).includes(input.sortColumn) ||
      typeof input.sortDescending != "boolean" ||
      !Array.isArray(input.roots)
    ) {
      throw new Error("Invalid captured query configuration");
    }
    const seen = new Set(),
      groups = new Set();
    const grouped = input.grouping != Ci.nsILiveView.UNTHREADED;
    const roots = input.roots.map(entry => {
      const message = copyThreadBatchRow(entry.message);
      const key = threadBatchKey(message, folders);
      if (
        typeof entry.group != "string" ||
        !Array.isArray(entry.members) ||
        (grouped ? !entry.members.length : entry.members.length)
      ) {
        throw new Error("Incomplete captured query root");
      }
      const members = entry.members.map(copyThreadBatchRow);
      const source = grouped ? members : [message];
      for (const member of source) {
        const identity = threadBatchKey(member, folders);
        if (seen.has(identity)) {
          throw new Error("Duplicate captured query member");
        }
        seen.add(identity);
        if (
          input.grouping == Ci.nsILiveView.THREADED &&
          member.threadId != message.threadId
        ) {
          throw new Error("Captured query crosses threads");
        }
      }
      const representative = source.find(
        member => threadBatchKey(member) == key
      );
      if (
        !representative ||
        threadBatchFields.some(field =>
          field == "date"
            ? representative.date.valueOf() != message.date.valueOf()
            : representative[field] !== message[field]
        )
      ) {
        throw new Error("Captured query representative differs");
      }
      const groupKey = grouped ? entry.group : key;
      if (groups.has(groupKey)) {
        throw new Error("Duplicate captured query group");
      }
      groups.add(groupKey);
      const aliases = entry.originalGroups ?? [];
      if (
        !Array.isArray(aliases) ||
        aliases.some(alias => typeof alias != "string")
      ) {
        throw new Error("Invalid captured query group aliases");
      }
      return {
        message,
        group: entry.group,
        members,
        originalGroups: [...aliases],
      };
    });
    return {
      grouping: input.grouping,
      sortColumn: input.sortColumn,
      sortDescending: input.sortDescending,
      roots,
    };
  }

  /**
   * Resolves the displayed query using original order and loaded physical anchors.
   *
   * @param {object} input - Current query plus the original displayed configuration.
   * @param {Map<number, number>} folders - Global physical ownership bindings.
   * @param {Map<string, object>} changes - Captured component preimages.
   * @returns {object} Current roots, displayed root identities and stable old order.
   * @throws {Error} If an unloaded identity has no original query evidence.
   */
  _prepareContextualBatchView(input, folders, changes) {
    const current = this._copyBatchQuery(input, folders);
    if (
      current.sortColumn !== columns[this.sortColumn] ||
      current.sortDescending !== (this.sortDirection == "descending")
    ) {
      throw new Error("Captured current query configuration differs");
    }
    const before = new Map(
      current.roots.flatMap(entry =>
        (current.grouping == Ci.nsILiveView.UNTHREADED
          ? [entry.message]
          : entry.members
        ).map(message => [threadBatchKey(message), message])
      )
    );
    for (const [key, change] of changes) {
      const message = before.get(key);
      if (
        change.matchesBefore !== !!message ||
        (message &&
          threadBatchFields.some(field =>
            field == "date"
              ? message.date.valueOf() != change.before.date.valueOf()
              : message[field] !== change.before[field]
          ))
      ) {
        throw new Error("Captured query differs from component preimage");
      }
    }
    const display =
      input.displayView === null
        ? null
        : this._copyBatchQuery(input.displayView, folders);
    const grouped = current.grouping != Ci.nsILiveView.UNTHREADED;
    const keyFor = entry =>
      grouped ? entry.group : threadBatchKey(entry.message);
    const loadedKey = row =>
      grouped
        ? String(row.group ?? (row.thread ?? row.message).threadId)
        : threadBatchKey(row.message);
    const byKey = new Map();
    for (const entry of display?.roots ?? []) {
      byKey.set(keyFor(entry), entry);
      for (const alias of entry.originalGroups) {
        if (byKey.has(alias) && byKey.get(alias) !== entry) {
          throw new Error("Contradictory original query group alias");
        }
        byKey.set(alias, entry);
      }
    }
    const order = input.displayView?.order ?? [];
    if (!Array.isArray(order)) {
      throw new Error("Invalid original query order");
    }
    const original = [],
      originalKeys = new Set();
    for (const entry of order) {
      const pair = threadBatchKey(entry, folders);
      if (typeof entry.group != "string") {
        throw new Error("Invalid original query group");
      }
      const key = grouped ? entry.group : pair;
      if (originalKeys.has(key)) {
        throw new Error("Duplicate original query root");
      }
      originalKeys.add(key);
      const captured = byKey.get(key);
      if (captured && !original.includes(captured)) {
        original.push(captured);
      }
    }
    const known = new Set(
      this._rowMap.filter(Boolean).map(row => byKey.get(loadedKey(row)))
    );
    const remaining = original.filter(entry => !known.has(entry));
    const holes = Array.from(this._rowMap).filter(row => !row).length;
    if (holes && remaining.length != holes) {
      throw new Error("Incomplete original query identity mapping");
    }
    let index = 0;
    const mappedRoots = Array.from(this._rowMap, row =>
      row ? byKey.get(loadedKey(row)) : remaining[index++]
    );
    const oldOrder = mappedRoots.flatMap((entry, i) => {
      const row = this._rowMap[i];
      if (!grouped) {
        if (row?.message) {
          return [threadBatchKey(row.message)];
        }
        return entry ? [threadBatchKey(entry.message)] : [];
      }
      if (row && !(this instanceof LiveViewConversationsDataAdapter)) {
        let members = [];
        if (entry) {
          members =
            this instanceof LiveViewGroupedDataAdapter
              ? entry.members
              : LiveViewThreadedDataAdapter.sortThread(
                  entry.members.map(message => ({ ...message }))
                ).slice(1);
        }
        return [
          row.message && threadBatchKey(row.message),
          ...Array.from(row.children, (child, j) =>
            child?.message
              ? threadBatchKey(child.message)
              : members[j] && threadBatchKey(members[j])
          ),
        ].filter(Boolean);
      }
      return (
        entry?.members.map(message => threadBatchKey(message)) ??
        (row?.message ? [threadBatchKey(row.message)] : [])
      );
    });
    return { ...current, contextual: true, display, mappedRoots, oldOrder };
  }

  /**
   * Captures selection identities without dereferencing unloaded rows.
   *
   * @param {object} [beforeView] - Validated old native roots and members.
   * @returns {object} Selected, current and pivot physical keys or dummy rows.
   * @throws {Error} If a selected slot has no loaded or captured physical identity.
   */
  _captureBatchSelection(beforeView = null) {
    const selection = this.selection;
    if (selection && !("_shiftSelectPivot" in selection)) {
      throw new Error("Thread batch requires concrete TreeSelection");
    }
    const rows = this._batchVisibleRows(this._rowMap);
    const fallback = [];
    if (beforeView) {
      const mappedRoots = beforeView.mappedRoots ?? beforeView.roots;
      if (mappedRoots.length != this._rowMap.length) {
        throw new Error(
          "Thread batch old query no longer matches visible roots"
        );
      }
      for (const [i, entry] of mappedRoots.entries()) {
        const row = this._rowMap[i];
        const sortGroup = this instanceof LiveViewGroupedDataAdapter;
        fallback.push(
          sortGroup
            ? entry && {
                batchGroup: entry.group,
                batchSortColumn: beforeView.display?.sortColumn,
              }
            : entry && threadBatchKey(entry.message)
        );
        if (!row?.open) {
          continue;
        }
        if (!entry) {
          fallback.push(...Array(row.children.length));
          continue;
        }
        const members = sortGroup
          ? entry.members
          : LiveViewThreadedDataAdapter.sortThread(
              entry.members.map(message => ({ ...message }))
            ).slice(1);
        if (members.length != row.children.length) {
          throw new Error(
            "Thread batch old query no longer matches visible children"
          );
        }
        fallback.push(...members.map(message => threadBatchKey(message)));
      }
    }
    const required = [selection?.currentIndex, selection?.shiftSelectPivot];
    const identities = rows.map((row, index) => {
      const identity = row?.message
        ? threadBatchKey(row.message)
        : (row ?? fallback[index]);
      if (
        identity === undefined &&
        (selection?.isSelected(index) || required.includes(index))
      ) {
        throw new Error(
          "Thread batch cannot recover an unloaded selection identity"
        );
      }
      return identity;
    });
    return {
      selected: identities.filter(
        (identity, index) =>
          identity !== undefined && selection?.isSelected(index)
      ),
      current: identities[selection?.currentIndex],
      pivot: identities[selection?.shiftSelectPivot],
    };
  }

  /**
   * Flattens open descendants while retaining unloaded slots.
   *
   * @param {TreeDataRow[]} roots - Top-level rows.
   * @returns {TreeDataRow[]} Visible rows, including empty slots.
   */
  _batchVisibleRows(roots) {
    const rows = [];
    const append = list => {
      for (const row of list) {
        rows.push(row);
        if (row?.open) {
          append(row.children);
        }
      }
    };
    append(roots);
    return rows;
  }

  /**
   * Restores surviving physical selections before the final tree reset.
   *
   * @param {object} saved - Captured selection identities.
   * @param {Map<string, TreeDataRow>} [membership] - Hidden conversation members.
   */
  _restoreBatchSelection(saved, membership = new Map()) {
    const selection = this.selection;
    if (!selection) {
      return;
    }
    const rows = this._batchVisibleRows(this._rowMap);
    const index = identity =>
      rows.findIndex(
        row =>
          row &&
          (row === identity ||
            (identity?.batchGroup !== undefined &&
              row instanceof LiveViewGroupedHeaderRow &&
              String(row.group) === identity.batchGroup &&
              (identity.batchSortColumn === undefined ||
                identity.batchSortColumn === columns[this.sortColumn])) ||
            (row.message && threadBatchKey(row.message) === identity) ||
            row === membership.get(identity))
      );
    selection.clearSelection();
    for (const identity of saved.selected) {
      const position = index(identity);
      if (position >= 0 && !selection.isSelected(position)) {
        selection.toggleSelect(position);
      }
    }
    selection.currentIndex = index(saved.current);
    const pivot = index(saved.pivot);
    selection._shiftSelectPivot = pivot < 0 ? null : pivot;
  }

  /**
   * Buffers a new positional query and installs one settled view.
   * Affected group facts come from the prepared descriptor.
   *
   * @param {object} saved - Loaded physical selection identities.
   * @param {object} plan - Captured matching rows and complete affected groups.
   * @returns {Promise<void>} Resolves after installation or consumer invalidation.
   */
  async _refreshSparseThreadBatch(saved, plan) {
    const liveView = this._liveView;
    const generation = ++this._queryGeneration;
    const listener = this._makeQueryListener(generation);
    const messages = [];
    listener.onSelectedChunk = (chunk, start, end) => {
      if (liveView != this._liveView || generation != this._queryGeneration) {
        return;
      }
      for (let i = start; i <= end; i++) {
        messages[i] = chunk[i];
      }
    };
    this._queryListener = listener;
    liveView.setListener(listener);
    try {
      const count = await liveView.countMessages();
      if (liveView != this._liveView || generation != this._queryGeneration) {
        return;
      }
      const complete = await liveView.selectMessages();
      if (liveView != this._liveView || generation != this._queryGeneration) {
        return;
      }
      const result = complete ?? messages;
      if (
        result.length != count ||
        Array.from(result).some(message => !message)
      ) {
        throw new Error("Incomplete thread batch refresh");
      }
      const cached = new Map();
      const oldRoots = this._rowMap.filter(Boolean);
      const collect = list =>
        list.forEach(row => {
          if (!row) {
            return;
          }
          if (row.message) {
            cached.set(threadBatchKey(row.message), row);
          }
          collect(row.children);
        });
      collect(oldRoots);
      const rows = [],
        installs = [],
        membership = new Map(),
        capturedGroups = new Set();
      for (const selectedSummary of result) {
        let summary = selectedSummary;
        if (this._threadBatchGrouping == Ci.nsILiveView.UNTHREADED) {
          rows.push(
            cached.get(threadBatchKey(summary)) ?? new LiveViewDataRow(summary)
          );
          continue;
        }
        const sortGroups = this instanceof LiveViewGroupedDataAdapter;
        const conversations = this instanceof LiveViewConversationsDataAdapter;
        const key = sortGroups
          ? summary[this.sortColumn == "date" ? "dateGroup" : this.sortColumn]
          : summary.threadId;
        const captured = plan?.groups?.after.find(
          group =>
            group.key.value === key ||
            (sortGroups &&
              this.sortColumn != "date" &&
              group.members.some(
                pair =>
                  plan.sides.after.get(threadBatchKey(pair))[
                    this.sortColumn
                  ] === key
              ))
        );
        if (captured) {
          capturedGroups.add(captured);
        }
        const members = captured
          ? captured.members.map(pair =>
              plan.sides.after.get(threadBatchKey(pair))
            )
          : await liveView.selectMessagesInGroup(key);
        const keys = new Set(members.map(message => threadBatchKey(message)));
        const previous = oldRoots.filter(row => {
          if ((sortGroups ? row.group : row.message.threadId) === key) {
            return true;
          }
          return (
            !sortGroups &&
            plan?.groups?.before.some(
              group =>
                group.key.value == row.message.threadId &&
                group.members.some(pair => keys.has(threadBatchKey(pair)))
            )
          );
        });
        const old = previous[0];
        if (captured) {
          summary = {
            ...plan.sides.after.get(threadBatchKey(captured.representative)),
            messageCount: captured.messageCount,
            newCount: captured.newCount,
            unreadCount: captured.unreadCount,
          };
          if (sortGroups) {
            summary[this.sortColumn == "date" ? "dateGroup" : this.sortColumn] =
              captured.key.value;
          }
        }
        if (members.length != summary.messageCount) {
          throw new Error("Incomplete refreshed group");
        }
        const shouldOpen = () =>
          !conversations &&
          (previous.some(row => row.open) ||
            [...saved.selected, saved.current, saved.pivot].some(identity =>
              keys.has(identity)
            ));
        let sorted = [];
        if (!conversations) {
          sorted = sortGroups
            ? members.sort((a, b) => {
                if (this._compareMessages(a, b)) {
                  return -1;
                }
                return this._compareMessages(b, a) ? 1 : 0;
              })
            : LiveViewThreadedDataAdapter.sortThread(members);
        }
        const first = !conversations && !sortGroups ? sorted.shift() : summary;
        const displayed = shouldOpen() && !sortGroups ? first : summary;
        const root = sortGroups
          ? (old ?? this._newBatchGroupRow(summary))
          : (previous.find(
              row => threadBatchKey(row.message) == threadBatchKey(displayed)
            ) ?? this._newBatchGroupRow(summary));
        const children = [];
        for (const message of sorted) {
          let row = cached.get(threadBatchKey(message));
          if (!row || row === root) {
            row = new LiveViewDataRow(message);
          }
          children.push(row);
          installs.push(() => {
            if (row instanceof LiveViewThreadDataRow) {
              row._installThreadBatchLeaf(message);
            } else {
              row._initFromMessage(message);
            }
          });
        }
        const preparedHeader = sortGroups
          ? new LiveViewGroupedHeaderRow(summary, liveView)
          : null;
        installs.push(() => {
          if (conversations) {
            root._initFromMessage(summary);
            root.messageCount = summary.messageCount;
          } else {
            root._installThreadBatch({
              summary,
              first,
              children,
              open: shouldOpen(),
              preparedHeader,
            });
          }
        });
        if (conversations) {
          for (const identity of keys) {
            membership.set(identity, root);
          }
        }
        rows.push(root);
      }
      if (liveView != this._liveView || generation != this._queryGeneration) {
        return;
      }
      if (
        plan?.groups?.after.some(
          group => group.members.length && !capturedGroups.has(group)
        )
      ) {
        throw new Error("Refresh omits a captured affected group");
      }
      saved = this._captureBatchSelection(plan.beforeView);
      const suppressed = this.selection?.selectEventsSuppressed;
      if (this.selection) {
        this.selection.selectEventsSuppressed = true;
      }
      try {
        if (this._threadBatchGrouping == Ci.nsILiveView.UNTHREADED) {
          rows.forEach((row, i) => row._initFromMessage(result[i]));
        }
        for (const install of installs) {
          install();
        }
        this._rowMap = rows;
        if (this._threadBatchGrouping != Ci.nsILiveView.UNTHREADED) {
          this._setBatchGroupMap(
            new Map(rows.map(row => [row.group ?? row.message.threadId, row]))
          );
        }
        this._clearFlatRowCache();
        this._restoreBatchSelection(saved, membership);
        this._tree?.reset();
      } finally {
        if (this.selection) {
          this.selection.selectEventsSuppressed = suppressed;
        }
      }
    } catch (error) {
      if (liveView == this._liveView && generation == this._queryGeneration) {
        this._invalidateThreadBatch(error);
      }
    }
  }

  /**
   * Allocates a group row without changing the adapter's group map.
   *
   * @param {object} message - Captured representative and aggregate totals.
   * @returns {TreeDataRow} A detached row for the retained grouping mode.
   */
  _newBatchGroupRow(message) {
    if (this instanceof LiveViewGroupedDataAdapter) {
      return new LiveViewGroupedHeaderRow(message, this._liveView);
    }
    if (this instanceof LiveViewConversationsDataAdapter) {
      const row = new LiveViewDataRow(message);
      row.messageCount = message.messageCount;
      return row;
    }
    return new LiveViewThreadDataRow(message, this._liveView);
  }

  /**
   * Checks loaded preimages and records cached physical rows before mutation.
   *
   * @param {Map<string, object>} changes - Captured before/after rows.
   * @param {number[]} componentIds - Complete affected old component IDs.
   * @param {Map<number, number>} foldersByKey - Captured global key bindings.
   * @returns {Map<string, LiveViewDataRow>} Loaded physical rows.
   * @throws {Error} If a cached preimage differs or a component is incomplete.
   */
  _validateCachedThreadBatch(changes, componentIds, foldersByKey) {
    const cached = new Map();
    const allCached = list =>
      list.forEach(row => {
        if (!row) {
          return;
        }
        if (row.message) {
          const key = threadBatchKey(row.message, foldersByKey);
          cached.set(key, row);
          const change = changes.get(key);
          if (
            change &&
            (!change.matchesBefore ||
              threadBatchFields.some(field =>
                field == "date"
                  ? row.message.date.valueOf() != change.before.date.valueOf()
                  : row.message[field] !== change.before[field]
              ))
          ) {
            throw new Error("Thread batch preimage differs from cached row");
          }
          if (!change && componentIds.includes(row.message.threadId)) {
            throw new Error("Thread batch omits a cached component member");
          }
        }
        allCached(row.children);
      });
    allCached(this._rowMap);
    return cached;
  }

  _matchesThreadBatchGroup(row, group, side) {
    if (!(this instanceof LiveViewGroupedDataAdapter)) {
      return row.message.threadId == group.key.value;
    }
    if (row.group === group.key.value) {
      return true;
    }
    if (this.sortColumn == "date") {
      return false;
    }
    return group.members.some(
      pair => side.get(threadBatchKey(pair))?.[this.sortColumn] === row.group
    );
  }

  /**
   * Prepares an unloaded root from owned old query facts without a new query.
   *
   * @param {object} entry - Captured old representative, group key and members.
   * @param {Map<string, LiveViewDataRow>} [cached] - Surviving physical rows.
   * @returns {TreeDataRow} A detached closed root with complete physical children.
   */
  _rootFromBatchBefore(entry, cached = new Map()) {
    const state = this._stateFromBatchBefore(entry, cached);
    const root = this._newBatchGroupRow(state.summary);
    if (!(this instanceof LiveViewConversationsDataAdapter)) {
      root._installThreadBatch(state);
    }
    return root;
  }

  /**
   * Prepares complete children for one captured group without updating cached rows.
   *
   * @param {object} entry - Captured representative and members.
   * @param {Map<string, LiveViewDataRow>} cached - Surviving physical row objects.
   * @param {TreeDataRow} [root] - An existing container that must not be its own child.
   * @returns {object} Detached group state for atomic installation.
   */
  _stateFromBatchBefore(entry, cached, root) {
    const sortGroups = this instanceof LiveViewGroupedDataAdapter;
    const summary = {
      ...entry.message,
      messageCount: entry.members.length,
      newCount: entry.members.filter(
        message => message.flags & Ci.nsMsgMessageFlags.New
      ).length,
      unreadCount: entry.members.filter(
        message => !(message.flags & Ci.nsMsgMessageFlags.Read)
      ).length,
    };
    if (sortGroups) {
      summary[this.sortColumn == "date" ? "dateGroup" : this.sortColumn] =
        this.sortColumn == "date" ? Number(entry.group) : entry.group;
    }
    const ordered = sortGroups
      ? entry.members
      : LiveViewThreadedDataAdapter.sortThread(
          entry.members.map(message => ({ ...message }))
        );
    const first = sortGroups ? summary : ordered.shift();
    return {
      summary,
      first,
      children: ordered.map(message => {
        const row = cached.get(threadBatchKey(message));
        return row && row !== root ? row : new LiveViewDataRow(message);
      }),
      open: root?.open ?? false,
      preparedHeader: sortGroups
        ? new LiveViewGroupedHeaderRow(summary, this._liveView)
        : null,
    };
  }

  /**
   * Prepares complete group replacements and reuses loaded physical rows.
   *
   * @param {object} batch - Validated captured memberships and group totals.
   * @param {Map<string, object>} changes - Validated captured changes.
   * @param {object} sides - Matching before/after rows keyed by physical identity.
   * @param {Map<number, number>} foldersByKey - Captured global key bindings.
   * @param {object|null} beforeView - Validated old native roots and members.
   * @returns {object} Detached rows, map, selection and installation work.
   */
  _prepareGroupedThreadBatch(batch, changes, sides, foldersByKey, beforeView) {
    const saved = this._captureBatchSelection(beforeView);
    const cached = this._validateCachedThreadBatch(
      changes,
      batch.componentThreadIds.before,
      foldersByKey
    );
    const baseInstalls = [];
    const rootEntries = new Map();
    const sameSortGroup =
      !(this instanceof LiveViewGroupedDataAdapter) ||
      !beforeView?.contextual ||
      beforeView.display?.sortColumn === columns[this.sortColumn];
    let roots;
    if (beforeView?.contextual) {
      roots = beforeView.roots.map(entry => {
        const keys = new Set(
          entry.members.map(message => threadBatchKey(message))
        );
        const old =
          sameSortGroup &&
          this._rowMap.find(
            row =>
              row &&
              (this instanceof LiveViewGroupedDataAdapter
                ? String(row.group) === entry.group ||
                  beforeView.mappedRoots[
                    this._rowMap.indexOf(row)
                  ]?.members.some(message => keys.has(threadBatchKey(message)))
                : (row.thread ?? row.message).threadId ===
                  entry.message.threadId)
          );
        if (old) {
          rootEntries.set(old, entry);
          if (
            Array.from(old.children).some(child => !child) &&
            !(this instanceof LiveViewConversationsDataAdapter)
          ) {
            baseInstalls.push({
              ...this._stateFromBatchBefore(entry, cached, old),
              root: old,
              sortGroups: this instanceof LiveViewGroupedDataAdapter,
              conversations: false,
            });
          }
          return old;
        }
        const root = this._rootFromBatchBefore(entry, cached);
        rootEntries.set(root, entry);
        if (
          !(this instanceof LiveViewConversationsDataAdapter) &&
          this._rowMap.some(
            (row, i) =>
              row?.open &&
              beforeView.mappedRoots[i]?.members.some(message =>
                keys.has(threadBatchKey(message))
              )
          )
        ) {
          root.open = true;
        }
        return root;
      });
    } else if (beforeView) {
      roots = Array.from(
        this._rowMap,
        (row, index) =>
          row ?? this._rootFromBatchBefore(beforeView.roots[index])
      );
    } else {
      roots = this._rowMap;
    }
    if (Array.from(roots).some(row => !row)) {
      return {
        refresh: true,
        selection: saved,
        beforeView,
        sides,
        pendingGroups: this._rowMap.filter(
          row =>
            row &&
            batch.groups.before.some(group =>
              this._matchesThreadBatchGroup(row, group, sides.before)
            )
        ),
        groups: {
          before: batch.groups.before.map(group => ({
            ...group,
            key: { ...group.key },
            members: group.members.map(pair => ({ ...pair })),
          })),
          after: batch.groups.after.map(group => ({
            ...group,
            key: { ...group.key },
            representative: group.representative && { ...group.representative },
            members: group.members.map(pair => ({ ...pair })),
          })),
        },
      };
    }
    const collect = list =>
      list.forEach(row => {
        if (row.message && !cached.has(threadBatchKey(row.message))) {
          cached.set(threadBatchKey(row.message), row);
        }
        collect(row.children);
      });
    collect(roots);
    let oldOrder;
    if (beforeView?.contextual) {
      oldOrder = beforeView.oldOrder;
    } else if (beforeView) {
      oldOrder = beforeView.roots.flatMap(entry =>
        entry.members.map(message => threadBatchKey(message))
      );
    } else {
      oldOrder = [...cached.keys()];
    }
    const sortGroups = this instanceof LiveViewGroupedDataAdapter;
    const conversations = this instanceof LiveViewConversationsDataAdapter;
    const matchesGroup = (row, group, side) => {
      const entry = rootEntries.get(row);
      if (entry) {
        return (
          entry.group === String(group.key.value) ||
          entry.members.some(message =>
            group.members.some(
              pair => threadBatchKey(pair) === threadBatchKey(message)
            )
          )
        );
      }
      return this._matchesThreadBatchGroup(row, group, side);
    };
    const affected = new Set(
      roots.filter(row =>
        batch.groups.before.some(group =>
          matchesGroup(row, group, sides.before)
        )
      )
    );
    const map = beforeView?.contextual
      ? new Map()
      : new Map(this._getBatchGroupMap());
    for (const root of roots) {
      map.set(root.group ?? root.message.threadId, root);
    }
    for (const [key, row] of map) {
      if (affected.has(row)) {
        map.delete(key);
      }
    }
    const rootOrder = row => {
      const loaded = this._rowMap.indexOf(row);
      if (loaded >= 0) {
        return loaded;
      }
      if (beforeView?.contextual && sameSortGroup) {
        const key = String(row.group ?? (row.thread ?? row.message).threadId);
        const old = beforeView.mappedRoots.findIndex(
          entry =>
            entry && (entry.group === key || entry.originalGroups.includes(key))
        );
        if (old >= 0) {
          return old;
        }
      }
      return roots.indexOf(row);
    };
    const next = roots
      .filter(row => !affected.has(row))
      .map(row => ({
        row,
        message: row.thread ?? row.message,
        order: rootOrder(row),
      }));
    const updates = new Map();
    const installs = baseInstalls.filter(item => !affected.has(item.root));
    const membership = new Map();
    for (const group of batch.groups.after) {
      if (!group.members.length) {
        continue;
      }
      const members = group.members.map(pair =>
        sides.after.get(threadBatchKey(pair))
      );
      const keys = new Set(group.members.map(pair => threadBatchKey(pair)));
      const previous = [...affected].filter(row => {
        if (
          !sortGroups &&
          batch.groups.before.some(
            before =>
              matchesGroup(row, before, sides.before) &&
              before.members.some(pair => keys.has(threadBatchKey(pair)))
          )
        ) {
          return true;
        }
        return sortGroups && matchesGroup(row, group, sides.after);
      });
      const selected = [...saved.selected, saved.current, saved.pivot].some(
        key => keys.has(key)
      );
      const isOpen =
        !conversations && (previous.some(row => row.open) || selected);
      const representative = sides.after.get(
        threadBatchKey(group.representative)
      );
      const summary = {
        ...representative,
        messageCount: group.messageCount,
        newCount: group.newCount,
        unreadCount: group.unreadCount,
      };
      if (sortGroups) {
        summary[this.sortColumn == "date" ? "dateGroup" : this.sortColumn] =
          group.key.value;
      }
      const ordered = members.toSorted((a, b) => {
        const aIndex = oldOrder.indexOf(threadBatchKey(a));
        const bIndex = oldOrder.indexOf(threadBatchKey(b));
        return (
          (aIndex < 0 ? Infinity : aIndex) - (bIndex < 0 ? Infinity : bIndex)
        );
      });
      let sorted = [];
      if (!conversations) {
        sorted = sortGroups
          ? ordered.sort((a, b) => {
              // Match SelectGroupSQL: text groups use newest first; date
              // groups follow the requested date direction.
              return this.sortColumn == "date" &&
                this.sortDirection == "ascending"
                ? a.date - b.date
                : b.date - a.date;
            })
          : LiveViewThreadedDataAdapter.sortThread(ordered);
      }
      const first =
        !conversations && !sortGroups ? sorted.shift() : representative;
      const displayed = isOpen && !sortGroups ? first : representative;
      const root = sortGroups
        ? (previous[0] ?? this._newBatchGroupRow(summary))
        : (previous.find(
            row => threadBatchKey(row.message) == threadBatchKey(displayed)
          ) ?? this._newBatchGroupRow(summary));
      const children = [];
      for (const message of sorted) {
        let row = cached.get(threadBatchKey(message));
        if (!row || row === root) {
          row = new LiveViewDataRow(message);
        }
        new LiveViewDataRow(message).getText("date");
        updates.set(row, message);
        children.push(row);
      }
      const preparedHeader = sortGroups
        ? new LiveViewGroupedHeaderRow(summary, this._liveView)
        : null;
      installs.push({
        root,
        summary,
        first,
        children,
        open: isOpen,
        sortGroups,
        conversations,
        preparedHeader,
      });
      const key = sortGroups ? group.key.value : representative.threadId;
      map.set(key, root);
      next.push({
        row: root,
        message: summary,
        order: Math.min(...previous.map(rootOrder)),
      });
      if (conversations) {
        for (const pair of group.members) {
          membership.set(threadBatchKey(pair), root);
        }
      }
    }
    next.sort((a, b) => {
      if (sortGroups) {
        const aKey =
          installs.find(item => item.root === a.row)?.summary[
            this.sortColumn == "date" ? "dateGroup" : this.sortColumn
          ] ?? a.row.group;
        const bKey =
          installs.find(item => item.root === b.row)?.summary[
            this.sortColumn == "date" ? "dateGroup" : this.sortColumn
          ] ?? b.row.group;
        const compared =
          typeof aKey == "number"
            ? aKey - bKey
            : lazy.collator.compare(aKey, bKey);
        return (
          (this.sortDirection == "ascending" ? compared : -compared) ||
          a.order - b.order
        );
      }
      if (this._compareMessages(a.message, b.message)) {
        return -1;
      }
      return this._compareMessages(b.message, a.message)
        ? 1
        : a.order - b.order;
    });
    return {
      grouped: true,
      rows: next.map(item => item.row),
      updates,
      installs,
      map,
      saved,
      membership,
    };
  }

  /**
   * Installs prepared groups and restores selection before one tree reset.
   *
   * @param {object} plan - Detached replacements and surviving row updates.
   * @param {object} batch - The committed batch identifier.
   */
  _installGroupedThreadBatch(plan, batch) {
    const selection = this.selection;
    const suppressed = selection?.selectEventsSuppressed;
    if (selection) {
      selection.selectEventsSuppressed = true;
    }
    try {
      for (const [row, message] of plan.updates) {
        if (row instanceof LiveViewThreadDataRow) {
          row._installThreadBatchLeaf(message);
        } else {
          row._initFromMessage(message);
        }
      }
      for (const item of plan.installs) {
        if (item.conversations) {
          item.root._initFromMessage(item.summary);
          item.root.messageCount = item.summary.messageCount;
        } else {
          item.root._installThreadBatch(item);
        }
      }
      this._rowMap = plan.rows;
      this._setBatchGroupMap(plan.map);
      this._clearFlatRowCache();
      this._queryGeneration++;
      this._threadBatchId = BigInt(batch.batchId);
      this._restoreBatchSelection(plan.saved, plan.membership);
      this._tree?.reset();
    } catch (error) {
      this._invalidateThreadBatch(error);
      throw error;
    } finally {
      if (selection) {
        selection.selectEventsSuppressed = suppressed;
      }
    }
  }

  /**
   * Detaches a failed committed consumer and clears its invalid visible state.
   *
   * @param {Error} [error] - The reported consumer failure.
   */
  _invalidateThreadBatch(error) {
    this._queryGeneration++;
    this._viewGeneration++;
    this._liveView?.clearListener(this._queryListener ?? this);
    this._liveView = null;
    this._rowMap = [];
    this._clearFlatRowCache();
    this.selection?.clearSelection();
    if (this.selection) {
      this.selection.currentIndex = -1;
      this.selection._shiftSelectPivot = null;
    }
    try {
      this._tree?.reset();
    } catch (resetError) {
      console.error(resetError);
    }
    console.error(error ?? "Committed thread batch consumer invalidated");
  }

  /**
   * Creates a data row for the given message. Overriden by subclasses to
   * produce different effects.
   *
   * @param {Message} message
   * @returns {LiveViewDataRow}
   */
  _setUpRow(message) {
    return new LiveViewDataRow(message);
  }

  /**
   * Compare two messages for ordering their rows.
   *
   * @param {Message} a - A message object.
   * @param {Message} b - A message object.
   * @returns {boolean} - True if message A should be above message B.
   */
  _compareMessages(a, b) {
    if (this.sortDirection == "descending") {
      [a, b] = [b, a];
    }
    return this._sortComparator(a, b);
  }

  onMessageAdded(message) {
    if (this._consumeThreadBatch(message)) {
      return;
    }
    const newRow = this._setUpRow(message);
    let added = false;
    this._rowMap.forEach((row, index) => {
      if (added) {
        return;
      }
      if (this._compareMessages(message, row.message)) {
        // The new message goes above row.
        if (index == 0 || this._rowMap[index - 1]) {
          // The new message goes immediately above row.
          this._rowMap.splice(index, 0, newRow);
        }
        this._clearFlatRowCache();
        this._tree?.rowCountChanged(index, 1);
        added = true;
      }
    });
    if (!added) {
      // The new message goes after all the others.
      this._rowMap.push(newRow);
      this._clearFlatRowCache();
      this._tree?.rowCountChanged(this._rowMap.length - 1, 1);
    }
  }

  onMessageRemoved(message) {
    let removed = false;
    this._rowMap.forEach((row, index) => {
      if (removed || !row) {
        return;
      }
      if (message.id == row.message.id) {
        // The removed message was this one.
        this._rowMap.splice(index, 1);
        this._clearFlatRowCache();
        this._tree?.rowCountChanged(index, -1);
        removed = true;
      }
    });
  }

  onMessageFlagsChanged(message, oldFlags) {
    // Hope _flatRowCache exists.
    const index = this._flatRowCache.findIndex(
      r => r.message?.id == message.id
    );
    if (index == -1) {
      return;
    }
    const row = this._flatRowCache[index];
    row._initFromMessage(message);

    // Only invalidate the tree for flags we care about.
    const changedFlags = oldFlags ^ message.flags;
    const interestingFlags = Ci.nsMsgMessageFlags.Read;
    if (changedFlags & interestingFlags) {
      this._tree?.invalidateRow(index);
    }
  }

  onMessageTagsChanged(message, _oldTags) {
    const index = this._flatRowCache.findIndex(r => r.message.id == message.id);
    const row = this._flatRowCache[index];
    row._initFromMessage(message);
    this._tree?.invalidateRow(index);
  }

  onSelectedChunk(messages, startIndex, endIndex) {
    for (let index = startIndex; index <= endIndex; index++) {
      const message = messages[index];
      const row = this._setUpRow(message);
      row.setSize = this._rowMap.length;
      row.posInSet = index;
      row.liveView = this._liveView;
      this._rowMap[index] = row;
    }

    // We can get away with this because all rows are top level rows.
    // If we open one, _flatRowCache gets replaced.
    this._flatRowCache = this._rowMap;
    this._tree?.invalidateRange(startIndex, endIndex);
  }
}

/**
 * Adapts message data from nsILiveView for display in a TreeView. This class
 * lists messages grouped by thread. Threads are lazily loaded when the root
 * message is expanded.
 *
 * @augments {TreeDataAdapter}
 */
export class LiveViewThreadedDataAdapter extends LiveViewDataAdapter {
  /**
   * Put a group of messages in thread order.
   *
   * @param {Message[]} messages
   * @returns {Message[]}
   */
  static sortThread(messages) {
    const idMap = new Map(messages.map(m => [m.id, m]));

    // Link all of the messages together. Each message is a member of a
    // parent message's children, or a root.
    const roots = [];
    for (const message of messages) {
      if (message.threadParent) {
        const parentMessage = idMap.get(message.threadParent);
        if (parentMessage) {
          parentMessage.childMessages ??= [];
          parentMessage.childMessages.push(message);
          continue;
        }
      }
      roots.push(message);
    }

    // Construct a flat list of the messages in thread order.
    const sorted = [];
    function append(unsorted, level) {
      if (!unsorted) {
        return;
      }

      // Siblings are in date, ascending order. We could revisit this.
      unsorted.sort((a, b) => a.date - b.date);
      for (const message of unsorted) {
        message.level = level;
        sorted.push(message);
        append(message.childMessages, level + 1);
        delete message.childMessages;
      }
    }
    // TODO: This will add all roots at level 0, which is accurate but not
    // very good from a UI standpoint. I'm leaving it like this until we
    // figure out what to do with threads containing missing messages.
    append(roots, 0);

    return sorted;
  }

  /**
   * A map of thread identifiers to `LiveViewThreadDataRow`s.
   *
   * @type {Map<number, LiveViewThreadDataRow>}
   */
  #threads = new Map();

  _getBatchGroupMap() {
    return this.#threads;
  }
  _setBatchGroupMap(map) {
    this.#threads = map;
  }

  /**
   * @param {nsILiveView} liveView
   */
  constructor(liveView) {
    super(liveView, Ci.nsILiveView.THREADED);
  }

  /**
   * Creates a data row for the given thread. This version creates a
   * `LiveViewThreadDataRow`.
   *
   * @param {Message} message
   * @returns {LiveViewDataRow}
   */
  _setUpRow(message) {
    const row = new LiveViewThreadDataRow(message, this._liveView);
    this.#threads.set(message.threadId, row);
    return row;
  }

  onMessageAdded(message) {
    if (this._consumeThreadBatch(message)) {
      return;
    }
    let threadRow = this.#threads.get(message.threadId);
    if (threadRow) {
      threadRow.addChild(this, this.indexOf(threadRow), message);
    } else {
      threadRow = this._setUpRow({
        ...message,
        messageCount: 1,
        newCount: message.flags & Ci.nsMsgMessageFlags.New ? 1 : 0,
        unreadCount: message.flags & Ci.nsMsgMessageFlags.Read ? 0 : 1,
      });
      let added = false;
      this._rowMap.forEach((row, index) => {
        if (added) {
          return;
        }
        if (this._compareMessages(message, row.thread)) {
          // The new message goes above row.
          if (index == 0 || this._rowMap[index - 1]) {
            // The new message goes immediately above row.
            this._rowMap.splice(index, 0, threadRow);
          }
          added = true;
        }
      });
      if (!added) {
        // The new message goes after all the others.
        this._rowMap.push(threadRow);
      }
      this._clearFlatRowCache();
      this._tree?.rowCountChanged(this.indexOf(threadRow), 1);
    }
  }

  onMessageRemoved(message) {
    const threadRow = this.#threads.get(message.threadId);
    if (!threadRow) {
      // This shouldn't happen.
      console.error(
        `Unable to find a thread for a message with threadId = ${message.threadId}`
      );
      return;
    }
    const threadRowIndex = this.indexOf(threadRow);
    if (threadRow.children.length == 0) {
      this._rowMap.splice(this._rowMap.indexOf(threadRow), 1);
      this.#threads.delete(message.threadId);
      this._clearFlatRowCache();
      this._tree?.rowCountChanged(threadRowIndex, -1);
      return;
    }
    threadRow.removeChild(this, threadRowIndex, message);
  }

  onMessageFlagsChanged(message, oldFlags) {
    const threadRow = this.#threads.get(message.threadId);
    if (!threadRow) {
      // This shouldn't happen.
      console.error(
        `Unable to find a thread for a message with threadId = ${message.threadId}`
      );
      return;
    }

    const changedFlags = oldFlags ^ message.flags;
    if (changedFlags & Ci.nsMsgMessageFlags.New) {
      if (oldFlags & Ci.nsMsgMessageFlags.New) {
        threadRow.newCount--;
      } else {
        threadRow.newCount++;
      }
      this._tree.invalidateRow(this.indexOf(threadRow));
    }
    if (changedFlags & Ci.nsMsgMessageFlags.Read) {
      if (oldFlags & Ci.nsMsgMessageFlags.Read) {
        threadRow.unreadCount++;
      } else {
        threadRow.unreadCount--;
      }
      this._tree.invalidateRow(this.indexOf(threadRow));
    }

    super.onMessageFlagsChanged(message, oldFlags);
  }
}

/**
 * Adapts message data from nsILiveView for display in a TreeView. This class
 * is like LiveViewDataAdapter but lists conversations instead of messages.
 * It's also like LiveViewThreadedDataAdapter but without the option to expand
 * thread rows.
 *
 * @augments {LiveViewDataAdapter}
 */
export class LiveViewConversationsDataAdapter extends LiveViewDataAdapter {
  /**
   * A map of thread identifiers to `LiveViewDataRow`s.
   *
   * @type {Map<number, LiveViewDataRow>}
   */
  #threads = new Map();

  _getBatchGroupMap() {
    return this.#threads;
  }
  _setBatchGroupMap(map) {
    this.#threads = map;
  }

  /**
   * @param {nsILiveView} liveView
   */
  constructor(liveView) {
    super(liveView, Ci.nsILiveView.THREADED);
  }

  async sortBy(sortColumn, sortDirection) {
    // Only sorting by date is allowed.
    await super.sortBy("date", sortDirection);
  }

  /**
   * Creates a data row for the given message. This version creates a
   * `LiveViewDataRow` that doesn't have children (as the children won't be
   * displayed), but does maintain a count of the children so that the row can
   * be removed if the count drops to zero.
   *
   * @param {Message} message
   * @returns {LiveViewDataRow}
   */
  _setUpRow(message) {
    const row = new LiveViewDataRow(message);
    row.messageCount = message.messageCount;
    this.#threads.set(message.threadId, row);
    return row;
  }

  onMessageAdded(message) {
    if (this._consumeThreadBatch(message)) {
      return;
    }
    const threadRow = this.#threads.get(message.threadId);
    if (threadRow) {
      threadRow.messageCount++;
      this._tree?.invalidateRow(this.indexOf(threadRow));
      return;
    }
    message.messageCount = 1;
    super.onMessageAdded(message);
  }

  onMessageRemoved(message) {
    const threadRow = this.#threads.get(message.threadId);
    if (!threadRow) {
      // This shouldn't happen.
      console.error(
        `Unable to find a thread for a message with threadId = ${message.threadId}`
      );
      return;
    }
    const threadRowIndex = this.indexOf(threadRow);
    threadRow.messageCount--;
    if (threadRow.messageCount == 0) {
      this._rowMap.splice(this._rowMap.indexOf(threadRow), 1);
      this.#threads.delete(message.threadId);
      this._clearFlatRowCache();
      this._tree?.rowCountChanged(threadRowIndex, -1);
    } else {
      this._tree?.invalidateRow(threadRowIndex);
    }
  }
}

/**
 * Adapts message data from nsILiveView for display in a TreeView. This class
 * lists messages grouped by the current sort column. Each group contains a
 * dummy header row. Groups are lazily loaded when the dummy row is expanded.
 * Check for the "dummy" property to know if a row is a dummy row.
 *
 * @augments {TreeDataAdapter}
 */
export class LiveViewGroupedDataAdapter extends LiveViewDataAdapter {
  /**
   * Finds the appropriate date group for a given date.
   *
   * @see `GroupedByDateFunction`
   * @param {Date} date
   * @returns {number} A year or nsILiveView.DATE_GROUP_* constant.
   */
  static getDateGroup(date) {
    const now = new Date();
    // A message from the future! (And a half-hour grace period for weirdness
    // like clock skew.)
    if (date > now.valueOf() + 1800000) {
      return Ci.nsILiveView.DATE_GROUP_FUTURE;
    }

    // Today, actually since midnight last night.
    now.setHours(0);
    now.setMinutes(0);
    now.setSeconds(0);
    now.setMilliseconds(0);
    if (date > now) {
      return Ci.nsILiveView.DATE_GROUP_TODAY;
    }

    // Since midnight yesterday.
    now.setDate(now.getDate() - 1);
    if (date > now) {
      return Ci.nsILiveView.DATE_GROUP_YESTERDAY;
    }

    // "7 Days Ago", actually since 6 days before midnight last night.
    now.setDate(now.getDate() - 5);
    if (date > now) {
      return Ci.nsILiveView.DATE_GROUP_LAST_SEVEN_DAYS;
    }

    // "14 Days Ago", actually since 13 days before midnight last night.
    now.setDate(now.getDate() - 7);
    if (date > now) {
      return Ci.nsILiveView.DATE_GROUP_LAST_FOURTEEN_DAYS;
    }

    // Older than all the special groups, just use the year number.
    return date.getFullYear();
  }

  /**
   * A map of group identifiers to `LiveViewGroupedHeaderRow`s.
   *
   * @type {Map<(number|string), LiveViewGroupedHeaderRow>}
   */
  #groups = new Map();

  _getBatchGroupMap() {
    return this.#groups;
  }
  _setBatchGroupMap(map) {
    this.#groups = map;
  }

  /**
   * @param {nsILiveView} liveView
   */
  constructor(liveView) {
    super(liveView, Ci.nsILiveView.GROUPED_BY_SORT);
  }

  /**
   * Creates a data row for the given thread. This version creates a
   * `LiveViewGroupedHeaderRow`.
   *
   * @param {Message} message
   * @returns {LiveViewDataRow}
   */
  _setUpRow(message) {
    const row = new LiveViewGroupedHeaderRow(message, this._liveView);
    this.#groups.set(row.group, row);
    return row;
  }

  /**
   * Compare two messages for ordering their rows. Unlike the superclass, this
   * is only used for ordering messages within a group, and the order is
   * always date, descending unless the adapter's order is date, ascending.
   *
   * @param {Message} a - A message object.
   * @param {Message} b - A message object.
   * @returns {boolean} - True if message A should be above message B.
   */
  _compareMessages(a, b) {
    if (this.sortColumn == "date" && this.sortDirection == "ascending") {
      [a, b] = [b, a];
    }
    return comparators.date(a, b);
  }

  onMessageAdded(message) {
    if (this._consumeThreadBatch(message)) {
      return;
    }
    let groupField = this.sortColumn;
    let comparator = (a, b) => lazy.collator.compare(a, b) < 0;
    if (this._liveView.sortColumn == Ci.nsILiveView.DATE) {
      message.dateGroup = LiveViewGroupedDataAdapter.getDateGroup(message.date);
      groupField = "dateGroup";
      comparator = (a, b) => a < b;
    }
    const groupValue = message[groupField];

    let groupRow = this.#groups.get(groupValue);
    if (groupRow) {
      groupRow.addChild(this, this.indexOf(groupRow), message);
      return;
    }

    groupRow = this._setUpRow({
      [groupField]: groupValue,
      messageCount: 1,
      newCount: message.flags & Ci.nsMsgMessageFlags.New ? 1 : 0,
      unreadCount: message.flags & Ci.nsMsgMessageFlags.Read ? 0 : 1,
    });
    const isAscending = this.sortDirection == "ascending";
    const index = this._rowMap.findIndex(
      r => comparator(groupValue, r.group) == isAscending
    );
    if (index == -1) {
      this._rowMap.push(groupRow);
    } else {
      this._rowMap.splice(index, 0, groupRow);
    }
    this._clearFlatRowCache();
    this._tree?.rowCountChanged(this.indexOf(groupRow), 1);
  }

  onMessageRemoved(message) {
    let groupField = this.sortColumn;
    if (this._liveView.sortColumn == Ci.nsILiveView.DATE) {
      message.dateGroup = LiveViewGroupedDataAdapter.getDateGroup(message.date);
      groupField = "dateGroup";
    }

    const groupRow = this.#groups.get(message[groupField]);
    if (!groupRow) {
      // This shouldn't happen.
      console.error(
        `Unable to find a group for a message with ${groupField} = ${message[groupField]}`
      );
      return;
    }

    if (groupRow.children.length == 1) {
      const index = this.indexOf(groupRow);
      this._rowMap.splice(this._rowMap.indexOf(groupRow), 1);
      this.#groups.delete(message[groupField]);
      this._clearFlatRowCache();
      this._tree?.rowCountChanged(index, groupRow.open ? -2 : -1);
      return;
    }

    groupRow.removeChild(this, this.indexOf(groupRow), message);
  }

  onMessageFlagsChanged(message, oldFlags) {
    let groupField = this.sortColumn;
    if (this._liveView.sortColumn == Ci.nsILiveView.DATE) {
      message.dateGroup = LiveViewGroupedDataAdapter.getDateGroup(message.date);
      groupField = "dateGroup";
    }

    const groupRow = this.#groups.get(message[groupField]);
    if (!groupRow) {
      // This shouldn't happen.
      console.error(
        `Unable to find a group for a message with ${groupField} = ${message[groupField]}`
      );
      return;
    }

    const changedFlags = oldFlags ^ message.flags;
    if (changedFlags & Ci.nsMsgMessageFlags.New) {
      if (oldFlags & Ci.nsMsgMessageFlags.New) {
        groupRow.newCount--;
      } else {
        groupRow.newCount++;
      }
      this._tree.invalidateRow(this.indexOf(groupRow));
    }
    if (changedFlags & Ci.nsMsgMessageFlags.Read) {
      if (oldFlags & Ci.nsMsgMessageFlags.Read) {
        groupRow.unreadCount++;
      } else {
        groupRow.unreadCount--;
      }
      this._tree.invalidateRow(this.indexOf(groupRow));
    }

    super.onMessageFlagsChanged(message, oldFlags);
  }
}

/**
 * A class representing a row in a TreeView.
 *
 * @augments {TreeDataRow}
 */
class LiveViewDataRow extends TreeDataRow {
  /**
   * @param {Message} message
   */
  constructor(message) {
    super();
    this._initFromMessage(message);
  }

  /**
   * Set up this row based on the values from `message`.
   *
   * @param {Message} message
   */
  _initFromMessage(message) {
    ChromeUtils.defineLazyGetter(this, "texts", () => {
      return {
        ...message,
        date: lazy.dateFormatter.format(message.date),
        // Invert the read flag for unread messages.
        new: !!(message.flags & Ci.nsMsgMessageFlags.New),
        unread: !(message.flags & Ci.nsMsgMessageFlags.Read),
        flagged: !!(message.flags & Ci.nsMsgMessageFlags.Marked),
      };
    });
    this.values = { date: message.date.valueOf() };
    this.message = message;

    this.toggleProperty("new", message.flags & Ci.nsMsgMessageFlags.New);
    this.toggleProperty("read", message.flags & Ci.nsMsgMessageFlags.Read);
    this.toggleProperty("unread", !(message.flags & Ci.nsMsgMessageFlags.Read));
  }
}

/**
 * A class representing a row in a TreeView. Like LiveViewDataRow, but capable
 * of having child rows.
 *
 * @augments {LiveViewDataRow}
 */
class LiveViewThreadDataRow extends LiveViewDataRow {
  /**
   * @type {nsILiveView}
   */
  #liveView;

  /**
   * The message to display when this row is open. Only available after
   * `ensureChildren` has fetched the child messages.
   *
   * @type {Message}
   */
  #openMessage;

  /**
   * The message to display when this row is closed. Only available after
   * `ensureChildren` has fetched the child messages.
   *
   * @type {Message}
   */
  #closedMessage;

  /**
   * The number of new messages in this thread. Used to maintain the "hasNew"
   * property.
   *
   * @type {integer}
   */
  #newCount = 0;

  /**
   * The number of unread messages in this thread. Used to maintain the
   * "hasUnread" property.
   *
   * @type {integer}
   */
  #unreadCount = 0;

  /**
   * @param {Message} message
   * @param {nsILiveView} liveView
   */
  constructor(message, liveView) {
    super(message);
    this.thread = message;
    this.children.length = message.messageCount - 1;
    this.newCount = message.newCount;
    this.unreadCount = message.unreadCount;
    this.#liveView = liveView;
    this.#closedMessage = message;
  }

  /**
   * The number of new messages in this thread. If greater than zero, the row
   * will have the "hasNew" property.
   *
   * @type {integer}
   */
  get newCount() {
    return this.#newCount;
  }

  set newCount(value) {
    this.#newCount = value;
    this.toggleProperty("hasNew", !!value);
  }

  /**
   * The number of unread messages in this thread. If greater than zero, the
   * row will have the "hasUnread" property.
   *
   * @type {integer}
   */
  get unreadCount() {
    return this.#unreadCount;
  }

  set unreadCount(value) {
    this.#unreadCount = value;
    this.toggleProperty("hasUnread", !!value);
  }

  _childrenGeneration = 0;

  /**
   * Reuses a former thread container as one physical child row.
   *
   * @param {Message} message - The captured surviving physical message.
   */
  _installThreadBatchLeaf(message) {
    this._childrenGeneration++;
    this.children = [];
    this._open = false;
    this.thread = this.#closedMessage = this.#openMessage = message;
    this.newCount = this.unreadCount = 0;
    this._initFromMessage(message);
  }

  /**
   * Replaces one thread with captured facts and invalidates pending child queries.
   *
   * @param {object} state - Prepared summary, first message, children and expansion.
   */
  _installThreadBatch(state) {
    const { summary, first, children, open: isOpen } = state;
    this._childrenGeneration++;
    this.thread = this.#closedMessage = summary;
    this.#openMessage = first;
    this.children = children;
    this._open = isOpen;
    this.newCount = summary.newCount;
    this.unreadCount = summary.unreadCount;
    this._initFromMessage(isOpen ? first : summary);
  }

  /**
   * Trigger loading of the child rows – it is an async function but you
   * should not wait for it. This is called before `open` is set.
   *
   * @param {TreeDataAdapter} dataAdapter - The adapter this row belongs to.
   * @param {number} rootIndex - The current index of this row in the view.
   */
  async ensureChildren(dataAdapter, rootIndex) {
    if (this.children.length == 0 || this.children[0] !== undefined) {
      return;
    }

    const generation = this._childrenGeneration;
    const attachment = dataAdapter._viewGeneration;
    const liveView = this.#liveView;
    let messages;
    try {
      messages = await this.#liveView.selectMessagesInGroup(
        this.thread.threadId
      );
    } catch (error) {
      if (
        generation == this._childrenGeneration &&
        attachment == dataAdapter._viewGeneration &&
        liveView == dataAdapter._liveView &&
        error.name != "AbortError"
      ) {
        this._childrenError = error;
        console.error(error);
        dataAdapter._tree?.invalidateRow(rootIndex);
      }
      return;
    }
    if (
      generation != this._childrenGeneration ||
      attachment != dataAdapter._viewGeneration ||
      liveView != dataAdapter._liveView
    ) {
      return;
    }
    this._childrenError = null;
    const sortedMessages = LiveViewThreadedDataAdapter.sortThread(messages);
    this.#openMessage = sortedMessages[0];

    for (let i = 0; i < this.children.length; i++) {
      this.children[i] = new LiveViewDataRow(sortedMessages[i + 1]);
    }
    if (this.open) {
      this._initFromMessage(this.#openMessage);
      // Notify the tree that the content is ready and it should redraw the rows.
      dataAdapter._clearFlatRowCache();
      dataAdapter._tree?.invalidateRange(
        rootIndex,
        rootIndex + this.children.length
      );
    }
  }

  /**
   * Whether or not this row is open (its children are visible).
   *
   * @type {boolean}
   */
  get open() {
    return this._open;
  }

  set open(value) {
    this._open = value;

    // Swap the contents of this row depending on whether it is open or not.
    if (value) {
      if (this.#openMessage) {
        this._initFromMessage(this.#openMessage);
      }
    } else if (this.#closedMessage) {
      this._initFromMessage(this.#closedMessage);
    }
  }

  /**
   * Add a new LiveViewDataRow to this row's children, updating the tree as
   * necessary.
   *
   * @param {TreeDataAdapter} dataAdapter
   * @param {number} rootIndex - The index of this row in the adapter's rows.
   * @param {Message} message
   */
  addChild(dataAdapter, rootIndex, message) {
    if (message.flags & Ci.nsMsgMessageFlags.New) {
      this.newCount++;
    }
    if (!(message.flags & Ci.nsMsgMessageFlags.Read)) {
      this.unreadCount++;
    }

    if (!this.open && this.children[0] === undefined) {
      // This row has never been opened. We know how many children it has, but
      // we don't have the children. Now there's another child, expand the
      // array that will hold them.
      this.children.length++;
      dataAdapter._tree?.invalidateRow(rootIndex);
      return;
    }

    // TODO: This should be done with a faster operation, e.g. a binary search,
    // but it's good enough for now while we work on correctness.
    const sortedMessages = LiveViewThreadedDataAdapter.sortThread([
      this.#openMessage,
      ...this.children.map(r => r.message),
      message,
    ]);
    this.#openMessage = sortedMessages[0];
    // TODO: Work out if #closedMessage needs to be changed.

    this.children.length++;
    for (let i = 0; i < this.children.length; i++) {
      this.children[i] = new LiveViewDataRow(sortedMessages[i + 1]);
    }

    if (this.open) {
      dataAdapter._clearFlatRowCache();
      dataAdapter._tree?.rowCountChanged(rootIndex, 1);
      // Adding a row will invalidate all those below it.
    } else {
      dataAdapter._tree?.invalidateRow(rootIndex);
    }
  }

  /**
   * Remove a row from this row's children, updating the tree as necessary.
   *
   * @param {TreeDataAdapter} dataAdapter
   * @param {number} rootIndex - This index of this row in the adapter's rows.
   * @param {Message} message
   */
  removeChild(dataAdapter, rootIndex, message) {
    if (message.flags & Ci.nsMsgMessageFlags.New) {
      this.newCount--;
    }
    if (!(message.flags & Ci.nsMsgMessageFlags.Read)) {
      this.unreadCount--;
    }

    if (this.message.id == message.id) {
      this.#openMessage = this.children.shift().message;
      this._initFromMessage(this.#openMessage);
      if (this.open) {
        dataAdapter._clearFlatRowCache();
        dataAdapter._tree?.rowCountChanged(rootIndex, -1);
      } else {
        dataAdapter._tree?.invalidateRow(rootIndex);
      }
      return;
    }

    if (this.children[0] === undefined) {
      // This row has never been opened. We know how many children it has, but
      // we don't have the children. Now a child has been removed, shrink the
      // array that will hold them.
      this.children.length--;
      if (this.open) {
        dataAdapter._clearFlatRowCache();
        dataAdapter._tree?.rowCountChanged(rootIndex, -1);
      } else {
        dataAdapter._tree?.invalidateRow(rootIndex);
      }
    }
    const childIndex = this.children.findIndex(
      r => r?.message.id == message.id
    );
    if (childIndex > -1) {
      const childFlatIndex = this.open ? rootIndex + 1 + childIndex : -1;
      this.children.splice(childIndex, 1);
      if (childFlatIndex > -1) {
        dataAdapter._clearFlatRowCache();
        dataAdapter._tree?.rowCountChanged(childFlatIndex, -1);
      }
    }
  }
}

/**
 * A dummy header row for the grouped-by-sort view.
 *
 * @augments {TreeDataRow}
 */
class LiveViewGroupedHeaderRow extends TreeDataRow {
  /**
   * @type {nsILiveView}
   */
  #liveView;

  /**
   * The number of new messages in this group. Used to maintain the "hasNew"
   * property.
   *
   * @type {integer}
   */
  #newCount = 0;

  /**
   * The number of unread messages in this group. Used to maintain the
   * "hasUnread" property.
   *
   * @type {integer}
   */
  #unreadCount = 0;

  /**
   * @param {Message} message
   * @param {nsILiveView} liveView
   */
  constructor(message, liveView) {
    let label, group;
    switch (liveView.sortColumn) {
      case Ci.nsILiveView.DATE:
        label =
          lazy.dateGroupLabels[message.dateGroup] ??
          // The value is a year. Format it for locales that display
          // differently e.g. Japanese ("2025年").
          lazy.yearFormatter.format(new Date(message.dateGroup, 0, 15));
        group = message.dateGroup;
        break;
      case Ci.nsILiveView.SUBJECT:
        label = group = message.subject;
        break;
      case Ci.nsILiveView.SENDER:
        label = group = message.sender;
        break;
      case Ci.nsILiveView.RECIPIENTS:
        label = group = message.recipients;
        break;
    }
    super({ subject: label }, { date: message.dateGroup }, ["dummy"]);
    this.group = group;
    this.children.length = message.messageCount;
    this.newCount = message.newCount;
    this.unreadCount = message.unreadCount;
    this.#liveView = liveView;
  }

  /**
   * The number of new messages in this thread. If greater than zero, the row
   * will have the "hasNew" property.
   *
   * @type {integer}
   */
  get newCount() {
    return this.#newCount;
  }

  set newCount(value) {
    this.#newCount = value;
    this.toggleProperty("hasNew", !!value);
  }

  /**
   * The number of unread messages in this group. If greater than zero, the
   * row will have the "hasUnread" property.
   *
   * @type {integer}
   */
  get unreadCount() {
    return this.#unreadCount;
  }

  set unreadCount(value) {
    this.#unreadCount = value;
    this.toggleProperty("hasUnread", !!value);
  }

  _childrenGeneration = 0;

  /**
   * Replaces a dummy group's captured members, totals and prepared display text.
   *
   * @param {object} state - Prepared summary, children, expansion and header row.
   */
  _installThreadBatch(state) {
    const { summary, children, open: isOpen, preparedHeader: prepared } = state;
    this._childrenGeneration++;
    this.texts = prepared.texts;
    this.values = prepared.values;
    this.group = prepared.group;
    this.children = children;
    this._open = isOpen;
    this.newCount = summary.newCount;
    this.unreadCount = summary.unreadCount;
  }

  /**
   * Trigger loading of the child rows – it is an async function but you
   * should not wait for it. This is called before `open` is set.
   *
   * @param {TreeDataAdapter} dataAdapter - The adapter this row belongs to.
   * @param {number} rootIndex - The current index of this row in the view.
   */
  async ensureChildren(dataAdapter, rootIndex) {
    if (this.children.length == 0 || this.children[0] !== undefined) {
      return;
    }

    const generation = this._childrenGeneration;
    const attachment = dataAdapter._viewGeneration;
    const liveView = this.#liveView;
    let messages;
    try {
      messages = await this.#liveView.selectMessagesInGroup(this.group);
    } catch (error) {
      if (
        generation == this._childrenGeneration &&
        attachment == dataAdapter._viewGeneration &&
        liveView == dataAdapter._liveView &&
        error.name != "AbortError"
      ) {
        this._childrenError = error;
        console.error(error);
        dataAdapter._tree?.invalidateRow(rootIndex);
      }
      return;
    }
    if (
      generation != this._childrenGeneration ||
      attachment != dataAdapter._viewGeneration ||
      liveView != dataAdapter._liveView
    ) {
      return;
    }
    this._childrenError = null;
    for (let i = 0; i < this.children.length; i++) {
      const message = messages[i];
      this.children[i] = new LiveViewDataRow(message);
      this.children[i].parent = this;
      this.children[i].level = this.level + 1;
    }
    if (this.open) {
      // Notify the tree that the content is ready and it should redraw the rows.
      dataAdapter._clearFlatRowCache();
      dataAdapter._tree?.invalidateRange(
        rootIndex,
        rootIndex + this.children.length
      );
    }
  }

  /**
   * Add a new LiveViewDataRow to this row's children, updating the tree as
   * necessary.
   *
   * @param {TreeDataAdapter} dataAdapter
   * @param {number} rootIndex - The index of this row in the adapter's rows.
   * @param {Message} message
   */
  addChild(dataAdapter, rootIndex, message) {
    if (message.flags & Ci.nsMsgMessageFlags.New) {
      this.newCount++;
    }
    if (!(message.flags & Ci.nsMsgMessageFlags.Read)) {
      this.unreadCount++;
    }

    if (!this.open && this.children[0] === undefined) {
      // This row has never been opened. We know how many children it has, but
      // we don't have the children. Now there's another child, expand the
      // array that will hold them.
      this.children.length++;
      dataAdapter._tree?.invalidateRow(rootIndex);
      return;
    }
    // TODO: This should be done with a faster operation, e.g. a binary search,
    // but it's good enough for now while we work on correctness.
    this.children.push(new LiveViewDataRow(message));
    this.children.sort((a, b) =>
      dataAdapter._compareMessages(a.message, b.message)
    );
    if (this.open) {
      dataAdapter._clearFlatRowCache();
      dataAdapter._tree?.rowCountChanged(rootIndex, 1);
      // Adding a row will invalidate all those below it.
    } else {
      dataAdapter._tree?.invalidateRow(rootIndex);
    }
  }

  /**
   * Remove a row from this row's children, updating the tree as necessary.
   *
   * @param {TreeDataAdapter} dataAdapter
   * @param {number} rootIndex - This index of this row in the adapter's rows.
   * @param {Message} message
   */
  removeChild(dataAdapter, rootIndex, message) {
    if (message.flags & Ci.nsMsgMessageFlags.New) {
      this.newCount--;
    }
    if (!(message.flags & Ci.nsMsgMessageFlags.Read)) {
      this.unreadCount--;
    }

    if (this.children[0] === undefined) {
      // This row has never been opened. We know how many children it has, but
      // we don't have the children. Now a child has been removed, shrink the
      // array that will hold them.
      this.children.length--;
      if (this.open) {
        dataAdapter._clearFlatRowCache();
        dataAdapter._tree?.rowCountChanged(rootIndex, -1);
      } else {
        dataAdapter._tree?.invalidateRow(rootIndex);
      }
    }
    const childIndex = this.children.findIndex(
      r => r?.message.id == message.id
    );
    if (childIndex > -1) {
      const childFlatIndex = this.open ? rootIndex + 1 + childIndex : -1;
      this.children.splice(childIndex, 1);
      if (childFlatIndex == -1) {
        dataAdapter._tree?.invalidateRow(rootIndex);
      } else {
        dataAdapter._clearFlatRowCache();
        dataAdapter._tree?.rowCountChanged(childFlatIndex, -1);
      }
    }
  }
}
