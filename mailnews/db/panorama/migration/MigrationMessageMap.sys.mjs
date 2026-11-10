/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const MESSAGE_SCOPE = "ns:msg:db:row:scope:msgs:all";
const THREAD_KIND = "ns:msg:db:table:kind:thread";

/**
 * Resolves original thread roots/parents through a complete core key allocation.
 * Uses physical row keys and thread metadata, never Message-ID equality.
 * Rejects missing or cyclic relationships instead of silently dropping edges.
 * Does not change the source snapshot, insert rows or emit notifications.
 *
 * @param {{messages: object[], source: object}} summary - Parsed Mork summary.
 * @param {Map<number, number>} destinationKeys - Core's old-key/new-key mapping
 *   for this source folder only. Global keys are nonzero and exclude 0xffffffff.
 * @returns {object[]} Complete mapped messages with original keys/properties.
 */
export function mapMorkSummary(summary, destinationKeys) {
  const originals = new Map(
    summary.messages.map(message => [message.sourceKey, message])
  );
  if (
    originals.size != summary.messages.length ||
    destinationKeys.size != originals.size
  ) {
    throw new Error("Migration key allocation is incomplete or duplicated");
  }
  const allocated = new Set();
  for (const [oldKey, newKey] of destinationKeys) {
    if (
      !originals.has(oldKey) ||
      !Number.isInteger(newKey) ||
      newKey <= 0 ||
      newKey >= 0xffffffff ||
      allocated.has(newKey)
    ) {
      throw new Error("Invalid migration key allocation");
    }
    allocated.add(newKey);
  }
  const relations = getMorkThreadRelations(summary);
  return summary.messages.map(message => ({
    ...message,
    key: destinationKeys.get(message.sourceKey),
    sourceThreadId: message.threadId,
    sourceThreadParent: message.threadParent,
    threadId: destinationKeys.get(relations.get(message.sourceKey).root),
    threadParent:
      relations.get(message.sourceKey).parent === null
        ? null
        : destinationKeys.get(relations.get(message.sourceKey).parent),
    properties: new Map(message.properties),
    references: [...message.references],
  }));
}

/**
 * Reads each header's thread root and parent as old Thunderbird threads it.
 *
 * A header's own row names its thread and parent (nsMsgHdr). The per-thread
 * tables, their cached root and their counts are a derived index that old
 * Thunderbird repairs as it goes and that real summaries leave stale: a
 * parent that was deleted, a root that left the thread, a thread without its
 * table. None of that is a reason to refuse. A header without a thread is its
 * own thread; a thread without a usable cached root is rooted at its first
 * header that has no parent in it; a header whose parent is not in its thread
 * hangs below the root, where the old thread pane shows it; a parent cycle is
 * cut the same way.
 *
 * @param {{messages: object[], source: object}} summary - Parsed mail summary.
 * @returns {Map<number, {root: number, parent: number|null}>} Source-key relations.
 * @throws {Error} For duplicate or invalid physical message keys.
 */
export function getMorkThreadRelations(summary) {
  const originals = new Map(
    summary.messages.map(message => [message.sourceKey, message])
  );
  if (
    originals.size != summary.messages.length ||
    summary.messages.some(
      message =>
        !Number.isInteger(message.sourceKey) ||
        message.sourceKey < 0 ||
        message.sourceKey >= 0xffffffff
    )
  ) {
    throw new Error("Invalid or duplicate physical source key");
  }
  const NONE = 0xffffffff;
  const threadOf = new Map();
  const threads = new Map();
  for (const message of summary.messages) {
    const named = message.properties
      ? message.properties.has("msgThreadId")
      : Number.isInteger(message.threadId);
    const thread =
      named && message.threadId != NONE
        ? "t" + message.threadId
        : "m" + message.sourceKey;
    threadOf.set(message.sourceKey, thread);
    if (!threads.has(thread)) {
      threads.set(thread, []);
    }
    threads.get(thread).push(message);
  }
  const roots = new Map();
  for (const [thread, members] of threads) {
    const keys = new Set(members.map(message => message.sourceKey));
    let root = null;
    if (thread.startsWith("t")) {
      const table = summary.source.tables.get(
        thread.slice(1) + ":" + MESSAGE_SCOPE
      );
      const meta =
        table?.cells.get("k") == THREAD_KIND && table.metaRow
          ? summary.source.rows.get(table.metaRow)
          : null;
      const text = meta?.cells.get("threadRoot");
      if (typeof text == "string" && /^[0-9a-f]{1,8}$/i.test(text)) {
        const cached = parseInt(text, 16);
        if (keys.has(cached)) {
          root = cached;
        }
      }
    }
    if (root === null) {
      root = (
        members.find(
          message =>
            message.threadParent == message.sourceKey ||
            !keys.has(message.threadParent)
        ) ?? members[0]
      ).sourceKey;
    }
    roots.set(thread, root);
  }
  const parents = new Map();
  for (const message of summary.messages) {
    const thread = threadOf.get(message.sourceKey);
    const root = roots.get(thread);
    let parent = null;
    if (message.sourceKey != root) {
      parent =
        message.threadParent != message.sourceKey &&
        threadOf.get(message.threadParent) == thread
          ? message.threadParent
          : root;
    }
    parents.set(message.sourceKey, parent);
  }
  for (const message of summary.messages) {
    const chain = new Set();
    let current = message.sourceKey;
    while (current !== null && !chain.has(current)) {
      chain.add(current);
      current = parents.get(current);
    }
    if (current !== null) {
      parents.set(
        message.sourceKey,
        roots.get(threadOf.get(message.sourceKey))
      );
    }
  }
  return new Map(
    summary.messages.map(message => [
      message.sourceKey,
      {
        root: roots.get(threadOf.get(message.sourceKey)),
        parent: parents.get(message.sourceKey),
      },
    ])
  );
}

/**
 * Reads the watch/ignore word of each thread from its table's metadata row.
 * That word is user data (nsMsgThread flags); every other cell of the row is
 * a cache.
 *
 * @param {{messages: object[], source: object}} summary - Parsed mail summary.
 * @param {Map<number, {root: number}>} relations - getMorkThreadRelations.
 * @returns {number[][]} [root source key, word] of each thread with a word.
 */
export function getMorkThreadFlags(summary, relations) {
  const words = new Map();
  for (const message of summary.messages) {
    const root = relations.get(message.sourceKey).root;
    if (words.has(root) || !Number.isInteger(message.threadId)) {
      continue;
    }
    const table = summary.source.tables.get(
      message.threadId + ":" + MESSAGE_SCOPE
    );
    const meta =
      table?.cells.get("k") == THREAD_KIND && table.metaRow
        ? summary.source.rows.get(table.metaRow)
        : null;
    const text = meta?.cells.get("threadFlags");
    const word =
      typeof text == "string" && /^[0-9a-f]{1,8}$/i.test(text)
        ? parseInt(text, 16)
        : 0;
    words.set(root, word);
  }
  return [...words].filter(([, word]) => word).sort((a, b) => a[0] - b[0]);
}
