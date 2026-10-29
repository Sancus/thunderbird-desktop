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
 * Reads original root and parent keys from source thread tables.
 *
 * @param {{messages: object[], source: object}} summary - Parsed mail summary.
 * @returns {Map<number, {root: number, parent: number|null}>} Source-key relations.
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

  const roots = new Map();
  for (const message of summary.messages) {
    const thread = summary.source.tables.get(
      message.threadId + ":" + MESSAGE_SCOPE
    );
    if (
      !thread ||
      thread.cells.get("k") != THREAD_KIND ||
      !thread.metaRow ||
      !thread.rows.includes(message.sourceKey + ":" + MESSAGE_SCOPE)
    ) {
      throw new Error("Missing source thread membership or metadata");
    }
    const meta = summary.source.rows.get(thread.metaRow);
    const text = meta?.cells.get("threadRoot");
    if (typeof text != "string" || !/^[0-9a-f]{1,8}$/i.test(text)) {
      throw new Error("Invalid source thread root");
    }
    const rootKey = parseInt(text, 16);
    const root = originals.get(rootKey);
    if (
      !root ||
      root.threadId != message.threadId ||
      !thread.rows.includes(rootKey + ":" + MESSAGE_SCOPE)
    ) {
      throw new Error("Source thread root is not an imported member");
    }
    roots.set(message.sourceKey, rootKey);
    if (message.threadParent != 0xffffffff) {
      const parent = originals.get(message.threadParent);
      if (!parent || parent.threadId != message.threadId) {
        throw new Error("Source thread parent is missing or in another thread");
      }
    }
  }
  const checked = new Set();
  for (const message of summary.messages) {
    const chain = new Set();
    let current = message;
    while (current && !checked.has(current.sourceKey)) {
      if (chain.has(current.sourceKey)) {
        throw new Error("Source thread parent cycle");
      }
      chain.add(current.sourceKey);
      current = originals.get(current.threadParent);
    }
    for (const key of chain) {
      checked.add(key);
    }
  }
  return new Map(
    summary.messages.map(message => [
      message.sourceKey,
      {
        root: roots.get(message.sourceKey),
        parent:
          message.threadParent == 0xffffffff ? null : message.threadParent,
      },
    ])
  );
}
