/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { MailStringUtils } from "resource:///modules/MailStringUtils.sys.mjs";
import {
  readMorkFolderImport,
  validateMorkFolderWindowsInventory,
  validateMorkFolderWindowsReceipt,
} from "resource:///modules/panorama/MorkFolderImport.sys.mjs";
import { getMorkThreadRelations } from "resource:///modules/panorama/MigrationMessageMap.sys.mjs";

const MESSAGE = "ns:msg:db:row:scope:msgs:all";
const THREAD = "ns:msg:db:row:scope:threads:all";
const INFO = "ns:msg:db:row:scope:dbfolderinfo:all";
const KIND = "ns:msg:db:table:kind:";
// Named legacy getters, never the spelling of an unknown cell's value.
const UINT32_PROPERTIES = new Set([
  "numMsgs",
  "numNewMsgs",
  "flags",
  "folderDate",
  "highWaterKey",
  "UIDValidity",
  "totPendingMsgs",
  "unreadPendingMsgs",
  "version",
  "userSortOrder",
  "viewType",
  "viewFlags",
  "sortType",
  "sortOrder",
  "retainBy",
  "daysToKeepHdrs",
  "numHdrsToKeep",
  "useServerDefaults",
  "applyToFlaggedMessages",
  "downloadByDate",
  "downloadUnreadOnly",
  "ageLimit",
  "forceReparse",
  "fixedBadRefThreading",
]);
const INT64_PROPERTIES = new Set(["folderSize", "expungedBytes"]);
const META_FIELDS = new Set([
  "threadRoot",
  "threadId",
  "threadFlags",
  "children",
  "unreadChildren",
  "threadNewestMsgDate",
]);

/**
 * Converts folder-reader input to Unix version1 or Windows version2 native input.
 * Accounts every raw record before setting recordsComplete. This first subset
 * supports local folders and zero-flag, fully resolved thread structures only.
 * Requires a databaseSourceId persisted in the journal source plan before import.
 *
 * @param {Awaited<ReturnType<typeof readMorkFolderImport>>} input - Owned source input.
 * @param {object} source - Journal source with durable token/databaseSourceId.
 * @param {string} databaseSourceId - Actual current core.sourceId.
 * @param {number} folderFlags - Actual current nsIMsgFolder flags.
 * @returns {object} Complete native request, including all original raw records.
 * @throws {Error} On identity conflict or unrepresentable required source state.
 */
export function convertMorkFolderSnapshot(
  input,
  source,
  databaseSourceId,
  folderFlags
) {
  if (
    (input.version !== 1 &&
      !(AppConstants.platform == "win" && input.version === 2)) ||
    (input.version === 1 && Object.hasOwn(input, "windowsAdmission")) ||
    (input.version === 2 && source.inventory?.version !== 2) ||
    typeof source.id != "string" ||
    !source.id ||
    source.id.includes("\0") ||
    typeof source.token != "string" ||
    !source.token ||
    source.token !== input.token ||
    typeof source.databaseSourceId != "string" ||
    !source.databaseSourceId ||
    source.databaseSourceId.includes("\0") ||
    source.databaseSourceId !== databaseSourceId ||
    !["importing", "imported"].includes(source.state) ||
    !Number.isSafeInteger(source.destinationFolderId) ||
    source.destinationFolderId <= 0 ||
    !Number.isSafeInteger(input.folder.id) ||
    input.folder.id !== source.destinationFolderId ||
    input.source.path !== source.path ||
    !/^[0-9a-f]{64}$/.test(source.sha256) ||
    source.sha256 !== input.source.sha256 ||
    !Number.isSafeInteger(source.size) ||
    source.size < 0 ||
    source.size !== input.source.size ||
    !sameKeys(source.messageKeys, input.source.messageKeys)
  ) {
    throw new Error("Mork snapshot conflicts with journal/database identity");
  }
  if (input.version === 2) {
    const expected = validateMorkFolderWindowsInventory(source.inventory);
    for (const kind of ["summary", "store"]) {
      for (const name of [
        "originalPath",
        "originalRoot",
        "id",
        "parentId",
        "rootId",
      ]) {
        if (input.windowsAdmission?.[kind]?.[name] !== expected[kind][name]) {
          throw new Error(
            "Windows snapshot differs from retained original inventory"
          );
        }
      }
    }
    if (
      input.folder.summaryPath !== expected.summary.canonicalPath ||
      input.folder.storePath !== expected.store.canonicalPath ||
      input.folder.storeExists !== !!expected.store.id ||
      input.source.physicalIdentity?.version !== 1 ||
      input.source.physicalIdentity.id !== expected.summary.id ||
      input.source.physicalIdentity.parentId !== expected.summary.parentId
    ) {
      throw new Error("Windows snapshot physical binding changed");
    }
  }
  if (input.folder.protocol !== "none") {
    throw new Error("Unsupported Mork protocol identity/offline mapping");
  }
  const request = structuredClone(input);
  request.sourceId = source.id;
  request.databaseSourceId = databaseSourceId;
  request.recordsComplete = false;
  request.unhandledRecords = [];
  request.folderProperties = accountRecords(request, folderFlags);
  request.recordsComplete = true;
  return request;
}

/**
 * Calls the native converted snapshot/receipt methods after complete JS conversion.
 * The caller owns backup/profile-lock/writer exclusion and must checkpoint the
 * returned committed receipt before honoring cancellation. No activation occurs.
 *
 * @param {nsIDatabaseCore} core - Started native database with the public bridge.
 * @param {nsIMsgFolder} folder - Actual original native folder.
 * @param {object} source - Durable importing/imported journal source.
 * @returns {Promise<object>} Complete committed receipt with database identity.
 */
export async function importMorkFolderSnapshot(core, folder, source) {
  if (AppConstants.platform == "win" && source.inventory?.version !== 2) {
    throw new Error(
      "Windows native migration requires retained inventory version2"
    );
  }
  const database = core.QueryInterface(Ci.nsIDatabaseCore);
  if (
    typeof database.importFolderSnapshot != "function" ||
    typeof database.getFolderImportReceipt != "function"
  ) {
    throw new Error("Native converted snapshot/receipt bridge is required");
  }
  if (
    database !==
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(Ci.nsIDatabaseCore)
  ) {
    throw new Error("Native Panorama migration backend is required");
  }
  const request = convertMorkFolderSnapshot(
    await readMorkFolderImport(
      folder,
      source.token,
      AppConstants.platform == "win" ? source.inventory : undefined
    ),
    source,
    database.sourceId,
    folder.flags
  );
  let receipt = database.getFolderImportReceipt(folder, request);
  if (receipt === null) {
    if (source.state == "imported") {
      throw new Error("Native database lost a committed Mork receipt");
    }
    receipt = await database.importFolderSnapshot(folder, request);
  }
  if (database.sourceId != request.databaseSourceId) {
    throw new Error("Native database identity changed during Mork import");
  }
  return validateMorkFolderReceipt(request, receipt);
}

/**
 * Validates every returned original/global key pair without allocation-order or
 * Message-ID inference. Keeps source-unit/database identity for reconciliation.
 * Windows version2 additionally retains all measured admission/physical fields
 * after comparison with the original inventory and canonical folder binding.
 *
 * @param {object} request - Complete checked version1/2 snapshot.
 * @param {object} receipt - Native committed receipt, not a hash-only marker.
 * @returns {object} Independent receipt in canonical original-key order.
 */
export function validateMorkFolderReceipt(request, receipt) {
  const windows = request.version === 2 && AppConstants.platform == "win";
  if (windows) {
    if (!request.windowsAdmission) {
      throw new Error(
        "Unsupported native Mork receipt version/physical admission"
      );
    }
    const inventory = {
      version: 2,
      windowsAdmission: request.windowsAdmission,
    };
    const measured = validateMorkFolderWindowsInventory(inventory);
    if (
      request.source.path !== measured.summary.canonicalPath ||
      request.folder.summaryPath !== measured.summary.canonicalPath ||
      request.folder.storePath !== measured.store.canonicalPath ||
      request.source.physicalIdentity?.version !== 1 ||
      request.source.physicalIdentity.id !== measured.summary.id ||
      request.source.physicalIdentity.parentId !== measured.summary.parentId
    ) {
      throw new Error("Windows receipt request lost its physical binding");
    }
    validateMorkFolderWindowsReceipt(inventory, receipt);
  } else if (
    request.version !== 1 ||
    Object.hasOwn(request, "windowsAdmission") ||
    (receipt &&
      ((Object.hasOwn(receipt, "version") && receipt.version !== 1) ||
        Object.hasOwn(receipt, "windowsAdmission") ||
        Object.hasOwn(receipt, "sourcePhysicalIdentity")))
  ) {
    throw new Error(
      "Unsupported native Mork receipt version/physical admission"
    );
  }
  if (
    !receipt ||
    receipt.token !== request.token ||
    receipt.sourceId !== request.sourceId ||
    receipt.databaseSourceId !== request.databaseSourceId ||
    receipt.sourceSha256 !== request.source.sha256 ||
    receipt.folderId !== request.folder.id ||
    !Array.isArray(receipt.keys) ||
    receipt.keys.length != request.source.messageKeys.length
  ) {
    throw new Error("Invalid native Mork import receipt identity/count");
  }
  const originals = new Set(request.source.messageKeys);
  const seen = new Set();
  const allocated = new Set();
  const keys = receipt.keys
    .map(pair => {
      if (
        !Array.isArray(pair) ||
        pair.length != 2 ||
        !isKey(pair[0]) ||
        !isKey(pair[1], false) ||
        !originals.has(pair[0]) ||
        seen.has(pair[0]) ||
        allocated.has(pair[1])
      ) {
        throw new Error("Incomplete or ambiguous native Mork key map");
      }
      seen.add(pair[0]);
      allocated.add(pair[1]);
      return [...pair];
    })
    .sort((a, b) => a[0] - b[0]);
  return {
    token: receipt.token,
    sourceId: receipt.sourceId,
    databaseSourceId: receipt.databaseSourceId,
    sourceSha256: receipt.sourceSha256,
    folderId: receipt.folderId,
    keys,
    ...(windows
      ? {
          version: 2,
          windowsAdmission: structuredClone(receipt.windowsAdmission),
          sourcePhysicalIdentity: structuredClone(
            receipt.sourcePhysicalIdentity
          ),
        }
      : {}),
  };
}

/**
 * Verifies all message, thread/cache and folder-info records against converted
 * messages. Unknown rows/tables, offline operations and nonzero thread state
 * cannot be represented by this receiver and reject before its first call.
 *
 * @param {object} request - Owned cloned source input.
 * @param {number} folderFlags - Current folder flags; mismatches need native support.
 * @returns {object[]} Exact text properties with explicit known numeric views.
 */
function accountRecords(request, folderFlags) {
  const rows = new Map();
  for (const row of request.records.rows) {
    const key = rowKey(row);
    if (rows.has(key)) {
      throw new Error("Duplicate Mork source row");
    }
    rows.set(key, { ...row, cells: cells(row) });
  }
  const remaining = new Set(rows.keys());
  const tables = new Map();
  for (const table of request.records.tables) {
    const key = rowKey(table);
    if (tables.has(key) || new Set(table.rows).size != table.rows.length) {
      throw new Error("Duplicate Mork table/membership");
    }
    const parameters = cells(table);
    if ([...parameters.keys()].some(name => !["k", "s"].includes(name))) {
      throw new Error("Unsupported Mork table parameter");
    }
    tables.set(key, { ...table, cells: parameters });
  }
  const messages = new Map();
  for (const message of request.messages) {
    if (
      !isKey(message.sourceKey) ||
      messages.has(message.sourceKey) ||
      "key" in message.header
    ) {
      throw new Error("Invalid Mork original message identity");
    }
    const key = message.sourceKey + ":" + MESSAGE;
    const row = rows.get(key);
    if (!row || !sameCells(row.cells, message.header.extras)) {
      throw new Error("Mork message bytes differ from exact extras");
    }
    if (
      message.header.flags & Ci.nsMsgMessageFlags.Expunged ||
      hex(row.cells.get("ProtoThreadFlags") ?? "0") != 0
    ) {
      throw new Error("Unsupported deleted/pending thread state");
    }
    messages.set(message.sourceKey, { message, row });
    remaining.delete(key);
  }
  if (!sameKeys([...messages.keys()], request.source.messageKeys)) {
    throw new Error("Incomplete Mork physical source key set");
  }
  let messageTable;
  let infoTable;
  let allThreads;
  const threadTables = new Map();
  for (const [key, table] of tables) {
    const kind = table.cells.get("k");
    if (
      table.scope == MESSAGE &&
      kind == KIND + "msgs" &&
      !messageTable &&
      table.metaRow === null
    ) {
      messageTable = table;
    } else if (
      table.scope == MESSAGE &&
      kind == KIND + "thread" &&
      !threadTables.has(table.id)
    ) {
      threadTables.set(table.id, table);
    } else if (
      table.scope == INFO &&
      kind == KIND + "dbfolderinfo" &&
      !infoTable &&
      table.metaRow === null
    ) {
      infoTable = table;
    } else if (
      table.scope == THREAD &&
      kind == KIND + "allthreads" &&
      !allThreads &&
      table.metaRow === null
    ) {
      allThreads = table;
    } else {
      throw new Error("Unsupported Mork structural/offline table: " + key);
    }
  }
  if (
    !messageTable ||
    !infoTable ||
    !allThreads ||
    !sameKeys(
      messageTable.rows,
      [...messages.keys()].map(key => key + ":" + MESSAGE)
    )
  ) {
    throw new Error("Incomplete Mork message/folder/thread tables");
  }
  const relations = getMorkThreadRelations({
    source: { rows, tables },
    messages: [...messages].map(([sourceKey, { row }]) => ({
      sourceKey,
      threadId: hex(row.cells.get("msgThreadId")),
      threadParent: hex(row.cells.get("threadParent") ?? "ffffffff"),
    })),
  });
  const grouped = new Map();
  for (const [key, { row, message }] of messages) {
    const id = hex(row.cells.get("msgThreadId"));
    if (!grouped.has(id)) {
      grouped.set(id, []);
    }
    grouped.get(id).push(key);
    const relation = relations.get(key);
    if (
      message.rootSourceKey !== relation.root ||
      message.parentSourceKey !== relation.parent
    ) {
      throw new Error("Mork semantic thread map differs from source");
    }
  }
  for (const [id, table] of threadTables) {
    const members = grouped.get(id) ?? [];
    if (
      !members.length ||
      !sameKeys(
        table.rows,
        members.map(key => key + ":" + MESSAGE)
      )
    ) {
      throw new Error("Unsupported empty or inconsistent Mork thread table");
    }
    const meta = rows.get(table.metaRow);
    checkMeta(meta, id, members, messages);
    remaining.delete(table.metaRow);
    grouped.delete(id);
  }
  if (grouped.size || allThreads.rows.length != threadTables.size) {
    throw new Error("Missing Mork thread membership/index");
  }
  for (const key of allThreads.rows) {
    const row = rows.get(key);
    const table = row && threadTables.get(row.id);
    const root = table && hex(rows.get(table.metaRow).cells.get("threadRoot"));
    const subject = messages.get(root)?.row.cells.get("subject") ?? "";
    if (
      !row ||
      row.scope != THREAD ||
      !table ||
      row.cells.size != 1 ||
      row.cells.get("threadSubject") != subject
    ) {
      throw new Error("Unsupported Mork thread subject index");
    }
    remaining.delete(key);
  }
  if (infoTable.rows.length != 1) {
    throw new Error("Unsupported Mork folder-info membership");
  }
  const infoKey = infoTable.rows[0];
  const info = rows.get(infoKey);
  if (!info || info.scope != INFO || info.id != 1) {
    throw new Error("Invalid Mork folder-info row");
  }
  const properties = folderProperties(info.cells, folderFlags);
  for (const [name, expected] of [
    ["numMsgs", messages.size],
    [
      "numNewMsgs",
      [...messages.values()].filter(
        ({ message }) => !(message.header.flags & Ci.nsMsgMessageFlags.Read)
      ).length,
    ],
  ]) {
    if (info.cells.has(name) && hex(info.cells.get(name)) != expected) {
      throw new Error("Mork folder count differs from imported rows");
    }
  }
  remaining.delete(infoKey);
  // Detached empty metadata has no live thread membership. Reject any state.
  for (const key of remaining) {
    const row = rows.get(key);
    if (
      row.scope != "m" ||
      hex(row.cells.get("threadId")) != row.id ||
      hex(row.cells.get("threadRoot")) != row.id
    ) {
      throw new Error("Unsupported unaccounted Mork row: " + key);
    }
    checkMeta(row, row.id, [], messages);
  }
  return properties;
}

/**
 * Checks only the known legacy thread metadata; no active thread flags are lost.
 *
 * @param {object} row - Original metadata row.
 * @param {number} id - Original thread table ID.
 * @param {number[]} members - Exact physical message keys.
 * @param {Map<number, object>} messages - Source messages by physical key.
 * @returns {number} Explicit original semantic root.
 */
function checkMeta(row, id, members, messages) {
  if (
    !row ||
    row.scope != "m" ||
    row.cells.size != META_FIELDS.size ||
    [...row.cells.keys()].some(name => !META_FIELDS.has(name)) ||
    hex(row.cells.get("threadId")) != id ||
    hex(row.cells.get("threadFlags")) != 0 ||
    hex(row.cells.get("children")) != members.length ||
    hex(row.cells.get("unreadChildren")) !=
      members.filter(
        key =>
          !(messages.get(key).message.header.flags & Ci.nsMsgMessageFlags.Read)
      ).length
  ) {
    throw new Error("Unsupported Mork thread metadata/state");
  }
  const root = hex(row.cells.get("threadRoot"));
  if (members.length && !members.includes(root)) {
    throw new Error("Missing Mork semantic root");
  }
  const newest = hex(row.cells.get("threadNewestMsgDate"));
  const expected = members.reduce(
    (newest, key) =>
      Math.max(newest, messages.get(key).message.header.date / 1000000),
    0
  );
  if (newest != 0 && newest != expected) {
    throw new Error("Unsupported Mork newest-date cache");
  }
  return root;
}

/**
 * Converts only names with native numeric getters. Unknown cells stay text.
 * Rejects int64 values that the currently checked numeric JS bridge cannot carry.
 *
 * @param {Map<string, string>} original - Exact original byte-string cells.
 * @param {number} flags - Actual current native folder flags.
 * @returns {object[]} Explicit typed properties; original text also retained.
 */
function folderProperties(original, flags) {
  return [...original].map(([bytes, value]) => {
    const name = decode(bytes);
    const text = decode(value);
    if (name == "morkMigrationSource") {
      throw new Error("Reserved native Mork completion property");
    }
    const property = { name, text };
    if (UINT32_PROPERTIES.has(name) || INT64_PROPERTIES.has(name)) {
      if (
        !/^[0-9a-f]+$/i.test(text) ||
        text.length > (INT64_PROPERTIES.has(name) ? 16 : 8)
      ) {
        throw new Error("Invalid numeric Mork folder property: " + name);
      }
      let integer = BigInt("0x" + text);
      if (INT64_PROPERTIES.has(name)) {
        integer = BigInt.asIntN(64, integer);
      }
      if (
        integer < BigInt(Number.MIN_SAFE_INTEGER) ||
        integer > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        throw new Error(
          "Unsupported exact int64 Mork folder property: " + name
        );
      }
      property.integer = Number(integer);
      if (
        (name == "flags" && property.integer != flags) ||
        (["totPendingMsgs", "unreadPendingMsgs", "forceReparse"].includes(
          name
        ) &&
          property.integer != 0) ||
        (name == "version" && property.integer != 1)
      ) {
        throw new Error("Unsupported required Mork folder state: " + name);
      }
    }
    return property;
  });
}

/**
 * @param {object} record - Raw row/table.
 * @returns {string} Scoped original ID.
 */
function rowKey(record) {
  if (
    !Number.isInteger(record.id) ||
    record.id < 0 ||
    record.id > 0xffffffff ||
    typeof record.scope != "string"
  ) {
    throw new Error("Invalid Mork scoped record identity");
  }
  return record.id + ":" + record.scope;
}

/**
 * @param {object} record - Raw row/table.
 * @returns {Map<string, string>} Exact byte cells.
 */
function cells(record) {
  const values = new Map();
  for (const { k, v } of record.cells) {
    if (
      typeof k != "string" ||
      typeof v != "string" ||
      values.has(k) ||
      /[^\u0000-\u00ff]/.test(k) ||
      /[^\u0000-\u00ff]/.test(v)
    ) {
      throw new Error("Invalid or duplicate Mork byte cell");
    }
    values.set(k, v);
  }
  return values;
}

/**
 * @param {Map<string, string>} raw - Source bytes.
 * @param {object[]} extras - Header text.
 * @returns {boolean} Exact UTF-8 correspondence.
 */
function sameCells(raw, extras) {
  return (
    raw.size == extras.length &&
    [...raw].every(
      ([k, v], index) =>
        MailStringUtils.stringToByteString(extras[index].k) == k &&
        MailStringUtils.stringToByteString(extras[index].v) == v
    )
  );
}

/**
 * @param {string} bytes - Original UTF-8 byte string.
 * @returns {string} Exact text.
 */
function decode(bytes) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    MailStringUtils.byteStringToUint8Array(bytes)
  );
}

/**
 * @param {string} text - Known structural uint32 field.
 * @returns {number} Validated value.
 */
function hex(text) {
  if (typeof text != "string" || !/^[0-9a-f]{1,8}$/i.test(text)) {
    throw new Error("Invalid structural Mork uint32");
  }
  return parseInt(text, 16);
}

/**
 * @param {number} value - Physical key.
 * @param {boolean} [allowZero=true] - Original-key zero is valid.
 * @returns {boolean} Whether usable.
 */
function isKey(value, allowZero = true) {
  return (
    Number.isInteger(value) &&
    value >= (allowZero ? 0 : 1) &&
    value < 0xffffffff
  );
}

/**
 * @param {unknown[]} a - Keys/members.
 * @param {unknown[]} b - Keys/members.
 * @returns {boolean} Equal unique sets, independent of ordering.
 */
function sameKeys(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length != b.length) {
    return false;
  }
  const keys = new Set(b);
  return (
    new Set(a).size == a.length &&
    keys.size == b.length &&
    a.every(key => keys.has(key))
  );
}
