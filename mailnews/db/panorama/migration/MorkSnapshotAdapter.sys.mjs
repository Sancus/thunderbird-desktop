/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { MailStringUtils } from "resource:///modules/MailStringUtils.sys.mjs";
import {
  LOCAL_STORE_PROTOCOLS,
  readMorkFolderImport,
  validateMorkFolderWindowsInventory,
  validateMorkFolderWindowsReceipt,
} from "resource:///modules/panorama/MorkFolderImport.sys.mjs";
import {
  getMorkThreadFlags,
  getMorkThreadRelations,
} from "resource:///modules/panorama/MigrationMessageMap.sys.mjs";

const MESSAGE = "ns:msg:db:row:scope:msgs:all";
const THREAD = "ns:msg:db:row:scope:threads:all";
const INFO = "ns:msg:db:row:scope:dbfolderinfo:all";
const KIND = "ns:msg:db:table:kind:";
const OFFLINE = "ns:msg:db:row:scope:ops:all";
const PENDING = "ns:msg:db:row:scope:pending:all";
// nsImapMailFolder's kIdStartOfFake: keys from here on are pseudo headers.
const FIRST_PSEUDO_KEY = 0xffffff80;
// nsMsgDatabase caches a unified folder's hits in a message-scope table named
// by that folder's URI. Panorama does not migrate unified folders.
const UNIFIED_HITS = "mailbox://nobody@smart%20mailboxes/";
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
 * @param {function(string, string, number): void} [note] - Told the reason
 *   code, source ID and count of source data that is not imported.
 * @returns {object} Complete native request, including all original raw records.
 * @throws {Error} On identity conflict or unrepresentable required source state.
 */
export function convertMorkFolderSnapshot(
  input,
  source,
  databaseSourceId,
  folderFlags,
  note
) {
  return convertMorkSnapshot(
    input,
    source,
    databaseSourceId,
    folderFlags,
    false,
    note
  );
}

/**
 * Checks one source member before constructing a native request.
 *
 * @param {object} input - Complete reader snapshot.
 * @param {object} source - Persisted source plan.
 * @param {string} databaseSourceId - Current native incarnation.
 * @param {number} folderFlags - Current native folder flags.
 * @param {boolean} imap - Whether to account supported saved IMAP records.
 * @param {function(string, string, number): void} [note] - Told what is not
 *   imported.
 * @returns {object} Checked owned request.
 */
function convertMorkSnapshot(
  input,
  source,
  databaseSourceId,
  folderFlags,
  imap,
  note
) {
  // Stale offline move results (staleMoveResults), left out of this source.
  const omitted = new Set(source.omittedMessageKeys ?? []);
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
    !sameKeys(
      source.messageKeys,
      input.source.messageKeys.filter(key => !omitted.has(key))
    )
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
  // News folders have no IMAP UID/offline-operation unit; their optional
  // offline bodies stay in the retained store, as local bodies do.
  if (
    imap
      ? input.folder.protocol !== "imap"
      : !LOCAL_STORE_PROTOCOLS.includes(input.folder.protocol) &&
        input.folder.protocol !== "nntp"
  ) {
    throw new Error("Unsupported Mork protocol identity/offline mapping");
  }
  const request = structuredClone(input);
  if (omitted.size) {
    // Neither the pseudo header nor its operation is imported. Their rows
    // stay among the raw records, as rows no table holds.
    request.messages = request.messages.filter(
      message => !omitted.has(message.sourceKey)
    );
    request.source.messageKeys = request.source.messageKeys.filter(
      key => !omitted.has(key)
    );
    const rows = new Set(
      [...omitted].flatMap(key => [key + ":" + MESSAGE, key + ":" + OFFLINE])
    );
    for (const table of request.records.tables) {
      table.rows = table.rows.filter(key => !rows.has(key));
    }
    request.source.omittedMessageKeys = [...omitted].sort((a, b) => a - b);
    note?.("stale-move-results", source.id, omitted.size);
  }
  request.sourceId = source.id;
  request.databaseSourceId = databaseSourceId;
  request.recordsComplete = false;
  request.unhandledRecords = [];
  request.folderProperties = accountRecords(
    request,
    folderFlags,
    imap,
    note,
    omitted.size > 0
  );
  request.recordsComplete = true;
  return request;
}

/**
 * The form in which a folder address saved with an offline operation is
 * compared. Older summaries hold addresses with characters left as they are
 * (a space) that the folder's own address escapes. Old Thunderbird resolves a
 * saved address by its unescaped path names, so both spellings are one folder.
 *
 * @param {string} uri - Saved or current folder address.
 * @returns {string} Its unescaped form; the address itself when it does not
 *   unescape.
 */
function folderAddress(uri) {
  try {
    return decodeURIComponent(uri);
  } catch (error) {
    return uri;
  }
}

/**
 * @param {string} left - Folder address.
 * @param {string} right - Folder address.
 * @returns {boolean} Whether both name one folder (folderAddress).
 */
function sameFolder(left, right) {
  return folderAddress(left) === folderAddress(right);
}

/**
 * An offline move or copy shows its message in the destination folder at
 * once: a pseudo header with a "move result" operation that names the source
 * folder and key. The server work itself is the source folder's operation.
 * When that is gone (played back, or lost with a rebuilt summary or a deleted
 * folder) the result is a leftover. Old Thunderbird discards every move
 * result with its pseudo header the next time it plays the folder's
 * operations back (nsImapOfflineSync::ProcessNextOperation), and the real
 * message arrives with the next sync. Panorama resolves each result through
 * its source operation and cannot hold one without it, so such a result is
 * not migrated. One whose source operation is still pending stays exact.
 *
 * @param {{input: object, source: object}[]} entries - The unit's members.
 * @returns {number[][]} For each member, the keys of its move results that
 *   are not already left out and that no member has a pending move or copy
 *   for.
 */
function staleMoveResults(entries) {
  const folders = entries.map(({ input, source }) => {
    const rows = new Map(
      input.records.rows.map(row => [row.id + ":" + row.scope, row])
    );
    const operations = [];
    for (const table of input.records.tables) {
      for (const key of table.scope == OFFLINE ? table.rows : []) {
        const row = rows.get(key);
        if (row?.scope != OFFLINE) {
          continue;
        }
        const cell = name => row.cells.find(item => item.k == name)?.v;
        const text = name =>
          cell(name) === undefined ? undefined : decode(cell(name));
        operations.push({
          key: row.id,
          operation: parseInt(cell("op") ?? "0", 16),
          sourceFolderURI: text("srcFolderURI"),
          sourceMessageKey: parseInt(cell("srcMsgKey") ?? "", 16),
          destinations: [
            text("moveDest") ?? "",
            ...(text("copyDests") ?? "").split("\u0001"),
          ].map(folderAddress),
        });
      }
    }
    return {
      address: folderAddress(source.originalFolderURI ?? input.folder.uri),
      omitted: source.omittedMessageKeys ?? [],
      operations,
    };
  });
  const moved =
    Ci.nsIMsgOfflineImapOperation.kMsgMoved |
    Ci.nsIMsgOfflineImapOperation.kMsgCopy;
  return folders.map(folder =>
    folder.operations
      .filter(
        result =>
          // Alone, as old playback tests it.
          result.operation === Ci.nsIMsgOfflineImapOperation.kMoveResult &&
          result.sourceFolderURI !== undefined &&
          !folder.omitted.includes(result.key) &&
          !folders.some(
            origin =>
              origin.address === folderAddress(result.sourceFolderURI) &&
              origin.operations.some(
                operation =>
                  operation.key === result.sourceMessageKey &&
                  operation.operation & moved &&
                  operation.destinations.includes(folder.address)
              )
          )
      )
      .map(result => result.key)
      .sort((a, b) => a - b)
  );
}

/**
 * Converts a complete connected IMAP source unit without allocating native keys.
 * Resolves saved counterpart identities from the source records and folder plan.
 * The independent fixture ledger is not an input to this conversion.
 *
 * @param {{input: object, source: object, folderFlags: number}[]} entries -
 *   Reader inputs and their persisted journal sources, in source-ID order.
 * @param {string} token - Persisted whole-unit token.
 * @param {string} databaseSourceId - Actual native database incarnation.
 * @param {function(string, string, number): void} [note] - Told the reason
 *   code, source ID and count of source data that is not imported.
 * @returns {object} Version3 unit with existing platform-bound member requests.
 * @throws {Error} For an incomplete, ambiguous or conflicting source unit.
 */
export function convertMorkProtocolUnit(
  entries,
  token,
  databaseSourceId,
  note
) {
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    typeof token != "string" ||
    !token ||
    token.includes("\0")
  ) {
    throw new Error("Invalid Mork protocol import unit");
  }
  const stale = staleMoveResults(entries);
  const folders = entries.map(({ input, source: planned, folderFlags }, at) => {
    if (planned.protocol !== "imap") {
      throw new Error("Mork protocol source is not in the retained IMAP plan");
    }
    // What the first conversion leaves out, the journal records with the
    // unit's intent (bindImportUnit); later conversions find it in the plan.
    const source = stale[at].length
      ? {
          ...planned,
          messageKeys: planned.messageKeys.filter(
            key => !stale[at].includes(key)
          ),
          omittedMessageKeys: [
            ...(planned.omittedMessageKeys ?? []),
            ...stale[at],
          ],
        }
      : planned;
    const request = convertMorkSnapshot(
      input,
      source,
      databaseSourceId,
      folderFlags,
      true,
      note
    );
    request.imap.originalFolderURI =
      source.originalFolderURI ?? input.folder.uri;
    return request;
  });
  const sources = new Set();
  const destinations = new Set();
  const uris = new Map();
  for (const folder of folders) {
    const uri = folder.imap.originalFolderURI;
    if (
      sources.has(folder.sourceId) ||
      destinations.has(folder.folder.id) ||
      typeof uri != "string" ||
      !uri ||
      uri.includes("\0") ||
      uris.has(folderAddress(uri))
    ) {
      throw new Error("Duplicate or invalid Mork protocol folder identity");
    }
    sources.add(folder.sourceId);
    destinations.add(folder.folder.id);
    uris.set(folderAddress(uri), folder);
  }
  const keyOf = (folder, key) => {
    if (
      !isKey(key) ||
      (!folder.source.messageKeys.includes(key) &&
        !folder.imap.operations.some(op => op.sourceKey === key))
    ) {
      throw new Error("Missing Mork protocol physical counterpart");
    }
    return { sourceId: folder.sourceId, key };
  };
  for (const folder of folders) {
    for (const operation of folder.imap.operations) {
      const payload = operation.payload;
      if (Object.hasOwn(payload, "sourceFolderURI")) {
        const origin = uris.get(folderAddress(payload.sourceFolderURI));
        if (!origin || !Object.hasOwn(payload, "sourceMessageKey")) {
          throw new Error("Unresolved Mork offline source folder/key");
        }
        operation.source = keyOf(origin, payload.sourceMessageKey);
        const uid = origin.imap.serverUids.find(
          entry => entry.sourceKey === payload.sourceMessageKey
        );
        if (Object.hasOwn(payload, "sourceUid") && payload.sourceUid) {
          if (uid && uid.uid !== payload.sourceUid) {
            throw new Error("Conflicting Mork offline source UID");
          }
          if (!uid) {
            if (
              !origin.imap.uidValidity.present ||
              !origin.imap.uidValidity.value
            ) {
              throw new Error("Mork offline source UID has no captured epoch");
            }
            origin.imap.serverUids.push({
              sourceKey: payload.sourceMessageKey,
              uid: payload.sourceUid,
            });
          }
        }
      }
      if (operation.source) {
        const origin = uris.get(folderAddress(payload.sourceFolderURI));
        const originating = origin.imap.operations.find(
          value => value.sourceKey === payload.sourceMessageKey
        );
        if (
          !originating ||
          !(
            originating.payload.operation &
            (Ci.nsIMsgOfflineImapOperation.kMsgCopy |
              Ci.nsIMsgOfflineImapOperation.kMsgMoved)
          ) ||
          ![
            originating.payload.destinationFolderURI ?? "",
            ...(originating.payload.copyDestinations ?? []),
          ].some(uri => sameFolder(uri, folder.imap.originalFolderURI))
        ) {
          throw new Error("Unresolved Mork offline counterpart operation");
        }
      }
      if (
        payload.operation & Ci.nsIMsgOfflineImapOperation.kMoveResult &&
        !operation.source
      ) {
        throw new Error(
          "Ambiguous Mork offline result has no captured source operation"
        );
      }
      if (
        payload.operation &
          (Ci.nsIMsgOfflineImapOperation.kMsgMoved |
            Ci.nsIMsgOfflineImapOperation.kAppendDraft |
            Ci.nsIMsgOfflineImapOperation.kAppendTemplate) &&
        !payload.destinationFolderURI
      ) {
        throw new Error("Mork pending operation has no captured destination");
      }
      const findCounterpart = uri => {
        const destination = uris.get(folderAddress(uri));
        if (!destination) {
          throw new Error("Unresolved Mork offline destination folder");
        }
        const candidates = destination.imap.operations.filter(
          candidate =>
            candidate.payload.sourceFolderURI !== undefined &&
            sameFolder(
              candidate.payload.sourceFolderURI,
              folder.imap.originalFolderURI
            ) &&
            candidate.payload.sourceMessageKey === operation.sourceKey
        );
        if (candidates.length !== 1) {
          throw new Error("Ambiguous Mork offline physical counterpart");
        }
        return keyOf(destination, candidates[0].sourceKey);
      };
      if (payload.operation & Ci.nsIMsgOfflineImapOperation.kMsgCopy) {
        const copies = payload.copyDestinations;
        if (!copies?.length || new Set(copies).size !== copies.length) {
          throw new Error("Ambiguous Mork ordered COPY counterparts");
        }
        operation.copies = copies.map((uri, ordinal) => ({
          ...findCounterpart(uri),
          ordinal,
        }));
      } else if (payload.copyDestinations?.length) {
        throw new Error(
          "Mork COPY destinations have no pending COPY operation"
        );
      }
      if (Object.hasOwn(payload, "destinationFolderURI")) {
        if (
          payload.operation &
          (Ci.nsIMsgOfflineImapOperation.kAppendDraft |
            Ci.nsIMsgOfflineImapOperation.kAppendTemplate)
        ) {
          if (
            !sameFolder(
              payload.destinationFolderURI,
              folder.imap.originalFolderURI
            )
          ) {
            throw new Error("Mork queued APPEND has an unresolved body owner");
          }
          operation.destination = keyOf(folder, operation.sourceKey);
        } else if (
          payload.operation & Ci.nsIMsgOfflineImapOperation.kMsgMoved
        ) {
          operation.destination = findCounterpart(payload.destinationFolderURI);
        } else if (
          payload.operation & Ci.nsIMsgOfflineImapOperation.kMoveResult &&
          operation.source &&
          sameFolder(
            payload.destinationFolderURI,
            folder.imap.originalFolderURI
          )
        ) {
          operation.destination = keyOf(folder, operation.sourceKey);
        } else {
          throw new Error("Unresolved Mork offline destination state");
        }
      }
    }
  }
  for (const folder of folders) {
    for (const op of folder.imap.operations) {
      if (
        op.payload.operation &
          (Ci.nsIMsgOfflineImapOperation.kFlagsChanged |
            Ci.nsIMsgOfflineImapOperation.kMsgMoved |
            Ci.nsIMsgOfflineImapOperation.kMsgCopy |
            Ci.nsIMsgOfflineImapOperation.kDeletedMsg |
            Ci.nsIMsgOfflineImapOperation.kMsgMarkedDeleted |
            Ci.nsIMsgOfflineImapOperation.kAddKeywords |
            Ci.nsIMsgOfflineImapOperation.kRemoveKeywords) &&
        !(
          op.payload.operation &
          (Ci.nsIMsgOfflineImapOperation.kAppendDraft |
            Ci.nsIMsgOfflineImapOperation.kAppendTemplate |
            Ci.nsIMsgOfflineImapOperation.kMoveResult |
            Ci.nsIMsgOfflineImapOperation.kAddedHeader)
        ) &&
        !folder.imap.serverUids.some(entry => entry.sourceKey === op.sourceKey)
      ) {
        throw new Error("Unresolved Mork offline server UID");
      }
    }
    const seen = new Set();
    for (const entry of folder.imap.serverUids) {
      if (seen.has(entry.uid)) {
        throw new Error("Duplicate Mork folder-scoped server UID");
      }
      seen.add(entry.uid);
    }
    folder.imap.serverUids.sort((a, b) => a.sourceKey - b.sourceKey);
  }
  return { version: 3, token, databaseSourceId, protocol: "imap", folders };
}

/**
 * Copies the source identities and typed protocol intent for a journal checkpoint.
 * Raw rows and headers remain in their immutable source files and native request.
 *
 * @param {object} request - Complete converted version3 request.
 * @returns {object} Independent intent, without duplicated raw source contents.
 * @throws {Error} For a missing protocol unit identity.
 */
export function getMorkProtocolUnitIntent(request) {
  if (
    request?.version !== 3 ||
    request.protocol !== "imap" ||
    typeof request.token != "string" ||
    !request.token ||
    request.token.includes("\0") ||
    typeof request.databaseSourceId != "string" ||
    !request.databaseSourceId ||
    request.databaseSourceId.includes("\0") ||
    !Array.isArray(request.folders) ||
    !request.folders.length
  ) {
    throw new Error("Invalid Mork protocol unit intent");
  }
  return {
    version: 3,
    token: request.token,
    databaseSourceId: request.databaseSourceId,
    protocol: "imap",
    folders: request.folders.map(folder => ({
      version: folder.version,
      token: folder.token,
      sourceId: folder.sourceId,
      databaseSourceId: folder.databaseSourceId,
      folder: structuredClone(folder.folder),
      source: structuredClone(folder.source),
      ...(Object.hasOwn(folder, "windowsAdmission")
        ? { windowsAdmission: structuredClone(folder.windowsAdmission) }
        : {}),
      imap: structuredClone(folder.imap),
    })),
  };
}

/**
 * Checks a committed unit's complete message, UID and offline-operation maps.
 * Uses receipt provenance after an operation has legitimately left the live queue.
 * Does not allocate keys or infer a counterpart from allocation order.
 *
 * @param {object} request - Converted unit or its retained journal intent.
 * @param {object} receipt - Actual native committed version3 receipt.
 * @param {object} [options] - Validation mode.
 * @param {boolean} [options.retained=false] - Compare Windows admission with
 *   the retained intent instead of re-admitting the original files.
 * @returns {object} Independent canonical receipt with all checked protocol data.
 * @throws {Error} For changed identity, incomplete maps or conflicting payload.
 */
export function validateMorkProtocolUnitReceipt(
  request,
  receipt,
  { retained = false } = {}
) {
  const intent = getMorkProtocolUnitIntent(request);
  if (
    receipt?.version !== 3 ||
    receipt.protocol !== "imap" ||
    receipt.token !== intent.token ||
    receipt.databaseSourceId !== intent.databaseSourceId ||
    !Array.isArray(receipt.folders) ||
    receipt.folders.length !== intent.folders.length
  ) {
    throw new Error("Invalid native Mork protocol unit receipt");
  }
  const maps = new Map();
  const allocated = new Set();
  const folders = intent.folders.map((member, index) => {
    const native = receipt.folders[index];
    const checked = validateMorkFolderReceipt(member, native, { retained });
    if (
      maps.has(member.sourceId) ||
      native.imap?.version !== 1 ||
      native.imap.originalFolderURI !== member.imap.originalFolderURI ||
      !sameProtocolValue(native.imap.uidValidity, member.imap.uidValidity) ||
      !Array.isArray(native.imap.operationKeys)
    ) {
      throw new Error("Invalid native Mork protocol member receipt");
    }
    const map = new Map(checked.keys);
    for (const key of map.values()) {
      if (allocated.has(key)) {
        throw new Error("Mork unit reused a global physical key");
      }
      allocated.add(key);
    }
    const missing = new Set(
      member.imap.operations
        .map(op => op.sourceKey)
        .filter(key => !map.has(key))
    );
    if (native.imap.operationKeys.length !== missing.size) {
      throw new Error("Incomplete Mork operation-only key map");
    }
    const operationKeys = native.imap.operationKeys
      .map(pair => {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          !missing.delete(pair[0]) ||
          !isKey(pair[1], false) ||
          allocated.has(pair[1])
        ) {
          throw new Error("Invalid Mork operation-only physical key");
        }
        map.set(pair[0], pair[1]);
        allocated.add(pair[1]);
        return [...pair];
      })
      .sort((a, b) => a[0] - b[0]);
    maps.set(member.sourceId, map);
    return {
      ...checked,
      imap: {
        version: 1,
        originalFolderURI: member.imap.originalFolderURI,
        uidValidity: structuredClone(member.imap.uidValidity),
        serverUids: [],
        operationKeys,
        operations: [],
      },
    };
  });
  const mapped = binding => {
    const key = maps.get(binding.sourceId)?.get(binding.key);
    if (key === undefined) {
      throw new Error("Native Mork receipt lost a physical counterpart");
    }
    return {
      sourceId: binding.sourceId,
      key,
      ...(Object.hasOwn(binding, "ordinal")
        ? { ordinal: binding.ordinal }
        : {}),
    };
  };
  const operationIds = new Set();
  for (let index = 0; index < intent.folders.length; index++) {
    const member = intent.folders[index];
    const native = receipt.folders[index].imap;
    const checked = folders[index].imap;
    const map = maps.get(member.sourceId);
    if (
      !Array.isArray(native.serverUids) ||
      native.serverUids.length !== member.imap.serverUids.length ||
      !Array.isArray(native.operations) ||
      native.operations.length !== member.imap.operations.length
    ) {
      throw new Error("Incomplete native Mork UID/operation receipt");
    }
    checked.serverUids = member.imap.serverUids.map((binding, ordinal) => {
      const expected = { ...binding, key: map.get(binding.sourceKey) };
      if (
        expected.key === undefined ||
        !sameProtocolValue(native.serverUids[ordinal], expected)
      ) {
        throw new Error("Native Mork UID binding changed");
      }
      return expected;
    });
    checked.operations = member.imap.operations.map((operation, ordinal) => {
      const actual = native.operations[ordinal];
      const key = map.get(operation.sourceKey);
      if (
        !actual ||
        actual.sourceKey !== operation.sourceKey ||
        actual.key !== key ||
        key === undefined ||
        !Number.isSafeInteger(actual.id) ||
        actual.id < 1 ||
        operationIds.has(actual.id) ||
        !Number.isSafeInteger(actual.revision) ||
        actual.revision < 1 ||
        !sameProtocolValue(actual.payload, operation.payload)
      ) {
        throw new Error("Native Mork offline payload/revision changed");
      }
      operationIds.add(actual.id);
      const result = {
        sourceKey: operation.sourceKey,
        key,
        id: actual.id,
        revision: actual.revision,
        payload: structuredClone(operation.payload),
      };
      for (const name of ["source", "destination", "copies"]) {
        if (Object.hasOwn(actual, name) !== Object.hasOwn(operation, name)) {
          throw new Error("Native Mork counterpart presence changed");
        }
        if (Object.hasOwn(operation, name)) {
          const expected =
            name === "copies"
              ? operation.copies.map(mapped)
              : mapped(operation[name]);
          if (!sameProtocolValue(actual[name], expected)) {
            throw new Error("Native Mork physical counterpart/order changed");
          }
          result[name] = expected;
        }
      }
      return result;
    });
  }
  return {
    version: 3,
    token: intent.token,
    databaseSourceId: intent.databaseSourceId,
    protocol: "imap",
    folders,
  };
}

/**
 * Compares typed JSON records, preserving property presence and array order.
 *
 * @param {unknown} left - Actual protocol value.
 * @param {unknown} right - Expected saved protocol value.
 * @returns {boolean} Whether both values have the same complete structure.
 */
function sameProtocolValue(left, right) {
  if (left === right) {
    return true;
  }
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (
    Array.isArray(left) !== Array.isArray(right) ||
    (Array.isArray(left) && left.length !== right.length)
  ) {
    return false;
  }
  const keys = Object.keys(right);
  return (
    Object.keys(left).length === keys.length &&
    keys.every(
      key =>
        Object.hasOwn(left, key) && sameProtocolValue(left[key], right[key])
    )
  );
}

/**
 * Accounts the saved IMAP epoch, UID representation and full offline-op table.
 *
 * @param {object} request - Owned complete source member.
 * @param {Map<string,string>} info - Exact folder-info cells.
 * @param {object|undefined} table - Original offline table, if present.
 * @param {Map<string,object>} rows - All original scoped rows.
 * @returns {object} Version1 typed IMAP section with exact field presence.
 * @throws {Error} For unsupported or possibly dispatched source state.
 */
function accountImapRecords(request, info, table, rows) {
  const uidValidity = info.has("UIDValidity")
    ? { present: true, value: hex(info.get("UIDValidity")) }
    : { present: false };
  const numeric = new Map([
    ["opFlags", "flagOperation"],
    ["newFlags", "newFlags"],
    ["srcMsgKey", "sourceMessageKey"],
    ["srcUid", "sourceUid"],
    ["msgSize", "messageSize"],
  ]);
  const text = new Map([
    ["srcFolderURI", "sourceFolderURI"],
    ["moveDest", "destinationFolderURI"],
    ["addedKeywords", "keywordsToAdd"],
    ["removedKeywords", "keywordsToRemove"],
  ]);
  const allowed = new Set([
    "op",
    "msgKey",
    "copyDests",
    "numCopyDests",
    "inPlayback",
    ...numeric.keys(),
    ...text.keys(),
  ]);
  const operations = (table?.rows ?? []).map(key => {
    const row = rows.get(key);
    if (!row || row.scope !== OFFLINE || rowKey(row) !== key) {
      throw new Error("Invalid Mork offline table membership");
    }
    const original = row.cells;
    if ([...original.keys()].some(name => !allowed.has(name))) {
      throw new Error("Unsupported Mork offline property");
    }
    const sourceKey = hex(original.get("msgKey"));
    const operation = hex(original.get("op"));
    if (
      sourceKey !== row.id ||
      !isKey(sourceKey) ||
      !operation ||
      operation & ~0xfff
    ) {
      throw new Error("Invalid Mork offline operation identity/word");
    }
    const payload = { operation };
    for (const [column, field] of numeric) {
      if (original.has(column)) {
        payload[field] = hex(original.get(column));
      }
    }
    for (const [column, field] of text) {
      if (original.has(column)) {
        payload[field] = decode(original.get(column));
        if (payload[field].includes("\0")) {
          throw new Error("Invalid Mork offline text");
        }
      }
    }
    if (original.has("inPlayback")) {
      const value = hex(original.get("inPlayback"));
      if (value > 1) {
        throw new Error("Invalid Mork offline playback state");
      }
      payload.playingBack = value === 1;
    }
    if (payload.playingBack) {
      throw new Error(
        "Ambiguous Mork offline operation may have been dispatched"
      );
    }
    if (original.has("copyDests")) {
      const value = decode(original.get("copyDests"));
      payload.copyDestinations = value ? value.split("\u0001") : [];
      if (payload.copyDestinations.some(uri => !uri || uri.includes("\0"))) {
        throw new Error("Invalid Mork ordered COPY destination");
      }
    }
    if (original.has("numCopyDests")) {
      const count = hex(original.get("numCopyDests"));
      if (count !== (payload.copyDestinations?.length ?? 0)) {
        throw new Error("Mork COPY destination count differs from source");
      }
      payload.copyDestinationCount = count;
    }
    return { sourceKey, scope: OFFLINE, rowId: row.id, payload };
  });
  const serverUids = [];
  for (const message of request.messages) {
    const row = rows.get(message.sourceKey + ":" + MESSAGE);
    const op = operations.find(value => value.sourceKey === message.sourceKey);
    const pseudo = hex(row.cells.get("pseudoHdr") ?? "0");
    const pending =
      op &&
      op.payload.operation &
        (Ci.nsIMsgOfflineImapOperation.kMoveResult |
          Ci.nsIMsgOfflineImapOperation.kAppendDraft |
          Ci.nsIMsgOfflineImapOperation.kAppendTemplate |
          Ci.nsIMsgOfflineImapOperation.kAddedHeader);
    let uid;
    if (row.cells.has("uidOnServer")) {
      uid = hex(row.cells.get("uidOnServer"));
      if (!uid || pending || pseudo) {
        throw new Error("Conflicting Mork pending/confirmed UID state");
      }
    } else if (!pending && !pseudo) {
      // The retained classic IMAP header producer sets MessageKey to its UID.
      // Native captures carry uidOnServer explicitly instead.
      uid = message.sourceKey;
    } else if (!op) {
      throw new Error("Mork pseudo header has no retained offline operation");
    }
    if (uid !== undefined) {
      if (
        !uid ||
        !Number.isInteger(uid) ||
        uid > 0xffffffff ||
        !uidValidity.present ||
        !uidValidity.value
      ) {
        throw new Error("Mork server UID has no valid captured folder epoch");
      }
      serverUids.push({ sourceKey: message.sourceKey, uid });
    }
    if (
      pending &&
      (!Object.hasOwn(message.header, "storeToken") ||
        !message.header.storeToken ||
        !(message.header.flags & Ci.nsMsgMessageFlags.Offline))
    ) {
      throw new Error("Mork pending message has no captured finished body");
    }
  }
  // An operation written before operations recorded their UID (srcUid) names
  // its message by key alone. Old playback took the UID from that key
  // (UidsFromMsgKeys), and in a classic summary, whose headers carry no
  // uidOnServer, the key is the UID. A pseudo key never is.
  const classic = !request.messages.some(message =>
    rows.get(message.sourceKey + ":" + MESSAGE).cells.has("uidOnServer")
  );
  const serverActions =
    Ci.nsIMsgOfflineImapOperation.kFlagsChanged |
    Ci.nsIMsgOfflineImapOperation.kMsgMoved |
    Ci.nsIMsgOfflineImapOperation.kMsgCopy |
    Ci.nsIMsgOfflineImapOperation.kDeletedMsg |
    Ci.nsIMsgOfflineImapOperation.kMsgMarkedDeleted |
    Ci.nsIMsgOfflineImapOperation.kAddKeywords |
    Ci.nsIMsgOfflineImapOperation.kRemoveKeywords;
  for (const op of operations) {
    if (
      request.source.messageKeys.includes(op.sourceKey) ||
      Object.hasOwn(op.payload, "sourceFolderURI")
    ) {
      continue;
    }
    const uid =
      op.payload.sourceUid ||
      (classic &&
      op.payload.operation & serverActions &&
      op.sourceKey < FIRST_PSEUDO_KEY
        ? op.sourceKey
        : 0);
    if (uid) {
      if (!uidValidity.present || !uidValidity.value) {
        throw new Error("Mork operation-only UID has no captured epoch");
      }
      serverUids.push({ sourceKey: op.sourceKey, uid });
    }
  }
  return { version: 1, uidValidity, serverUids, operations };
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
  // Read stored flags without opening and closing the live folder database.
  const request = convertMorkFolderSnapshot(
    await readMorkFolderImport(
      folder,
      source.token,
      AppConstants.platform == "win" ? source.inventory : undefined
    ),
    source,
    database.sourceId,
    database.folderDB.getFolderFlags(folder.id)
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
 * Checks a committed unit receipt during ordinary selected-startup reuse.
 * After activation Panorama owns the folders: the obsolete original summary
 * and offline store may legitimately be compacted, replaced or removed. On
 * Windows the measured admission is therefore compared with the retained
 * journal intent (and, by the native caller, with the durable
 * folder_import_windows rows), never re-admitted. All other checks are those
 * of validateMorkProtocolUnitReceipt.
 *
 * @param {object} request - Retained journal unit intent.
 * @param {object} receipt - Actual durable native version3 receipt.
 * @returns {object} Independent canonical receipt with all checked protocol data.
 * @throws {Error} For changed identity, incomplete maps or conflicting payload.
 */
export function validateRetainedMorkProtocolUnitReceipt(request, receipt) {
  return validateMorkProtocolUnitReceipt(request, receipt, { retained: true });
}

/**
 * Validates every returned original/global key pair without allocation-order or
 * Message-ID inference. Keeps source-unit/database identity for reconciliation.
 * Windows version2 additionally retains all measured admission/physical fields
 * after comparison with the original inventory and canonical folder binding.
 *
 * @param {object} request - Complete checked version1/2 snapshot.
 * @param {object} receipt - Native committed receipt, not a hash-only marker.
 * @param {object} [options] - Validation mode.
 * @param {boolean} [options.retained=false] - On Windows, compare the receipt's
 *   measured admission with the request's retained admission and canonical
 *   binding instead of re-admitting the original files (startup reuse only).
 * @returns {object} Independent receipt in canonical original-key order.
 */
export function validateMorkFolderReceipt(
  request,
  receipt,
  { retained = false } = {}
) {
  const windows = request.version === 2 && AppConstants.platform == "win";
  if (windows && retained) {
    validateRetainedWindowsReceipt(request, receipt);
  } else if (windows) {
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
 * Compares a Windows version2 receipt with its request's retained admission.
 * Every original/ID field must equal the retained intent, each canonical path
 * the request's canonical folder binding, and the source physical identity the
 * retained summary identity. Reads no file and holds no lease.
 *
 * @param {object} request - Retained version2 member request.
 * @param {object} receipt - Durable native version2 receipt.
 * @throws {Error} For any missing, extra or changed admission field.
 */
function validateRetainedWindowsReceipt(request, receipt) {
  const retained = ["originalPath", "originalRoot", "id", "parentId", "rootId"];
  const canonical = {
    summary: request.folder?.summaryPath,
    store: request.folder?.storePath,
  };
  const saved = request.windowsAdmission;
  const source = request.source?.physicalIdentity;
  if (
    !saved ||
    Object.keys(saved).length != 2 ||
    typeof canonical.summary != "string" ||
    typeof canonical.store != "string" ||
    request.source?.path !== canonical.summary ||
    source?.version !== 1 ||
    source.id !== saved.summary?.id ||
    source.parentId !== saved.summary?.parentId ||
    receipt?.version !== 2 ||
    !receipt.windowsAdmission ||
    Object.keys(receipt.windowsAdmission).length != 2 ||
    ["summary", "store"].some(kind => {
      const value = receipt.windowsAdmission[kind];
      return (
        !saved[kind] ||
        Object.keys(saved[kind]).length != retained.length ||
        !value ||
        Object.keys(value).length != retained.length + 2 ||
        retained.some(
          name =>
            typeof saved[kind][name] != "string" ||
            value[name] !== saved[kind][name]
        ) ||
        value.canonicalPath !== canonical[kind] ||
        typeof value.canonicalRoot != "string" ||
        !value.canonicalRoot
      );
    }) ||
    receipt.sourcePhysicalIdentity?.version !== 1 ||
    Object.keys(receipt.sourcePhysicalIdentity).length != 3 ||
    receipt.sourcePhysicalIdentity.id !== source.id ||
    receipt.sourcePhysicalIdentity.parentId !== source.parentId
  ) {
    throw new Error(
      "Native Windows migration receipt differs from its retained intent"
    );
  }
}

/**
 * Classifies supported table shapes and rejects duplicates or unknown tables.
 *
 * @param {Map<string, object>} tables - Tables with checked parameter cells.
 * @param {boolean} imap - Accept the saved offline and empty pending tables.
 * @returns {{messageTable: object|undefined, infoTable: object|undefined,
 *   allThreads: object|undefined, offlineTable: object|undefined,
 *   threadTables: Map<number, object>, unifiedHits: object[],
 *   pendingRows: number}} The selected tables, thread ID map, cached unified
 *   folder hits and the count of pending header attribute rows.
 * @throws {Error} If a table has an unsupported or duplicate shape.
 */
function classifyRecordTables(tables, imap) {
  let messageTable;
  let infoTable;
  let allThreads;
  let offlineTable;
  let pendingRows = 0;
  const threadTables = new Map();
  const unifiedHits = [];
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
    } else if (
      imap &&
      table.scope == OFFLINE &&
      kind == KIND + "ops" &&
      !offlineTable &&
      table.metaRow === null
    ) {
      offlineTable = table;
    } else if (table.scope == PENDING) {
      // Attributes nsImapMailDatabase keeps, by Message-ID, for a message that
      // has not arrived yet (a copy's keywords, a sent message's identity).
      // Old Thunderbird applies them if such a header is ever added and loses
      // them when the summary is rebuilt; rows of messages that never arrive
      // stay for good. Panorama keeps such attributes only with a detached
      // header, so there is nowhere to import them to. They are counted for
      // the report and stay in the original summary.
      pendingRows += table.rows.length;
    } else if (
      table.scope == MESSAGE &&
      kind?.startsWith(UNIFIED_HITS) &&
      table.metaRow === null
    ) {
      unifiedHits.push(table);
    } else if (table.scope == OFFLINE && (imap || table.rows.length)) {
      // Pending server work is user data this reader must understand.
      throw new Error("Unsupported Mork structural/offline table: " + key);
    }
    // Any other table is a derived index or cache old Thunderbird rebuilds.
  }
  return {
    messageTable,
    infoTable,
    allThreads,
    offlineTable,
    threadTables,
    unifiedHits,
    pendingRows,
  };
}

/**
 * Verifies all message, thread/cache and folder-info records against converted
 * messages. The IMAP unit additionally accounts the saved offline table.
 * Rejects unknown structure and unsupported thread state before native calls.
 *
 * @param {object} request - Owned cloned source input.
 * @param {number} folderFlags - Current folder flags; mismatches need native support.
 * @param {boolean} [imap=false] - Account the typed saved IMAP operation section.
 * @param {function(string, string, number): void} [note] - Told what is not
 *   imported.
 * @param {boolean} [rethread=false] - Headers were left out: thread the
 *   remaining ones as their own rows say, without the ones left out.
 * @returns {object[]} Exact text properties with explicit known numeric views.
 */
function accountRecords(
  request,
  folderFlags,
  imap = false,
  note = null,
  rethread = false
) {
  const rows = new Map();
  for (const row of request.records.rows) {
    const key = rowKey(row);
    if (rows.has(key)) {
      throw new Error("Duplicate Mork source row");
    }
    rows.set(key, { ...row, cells: cells(row) });
  }
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
  }
  if (!sameKeys([...messages.keys()], request.source.messageKeys)) {
    throw new Error("Incomplete Mork physical source key set");
  }
  const { messageTable, infoTable, offlineTable, pendingRows } =
    classifyRecordTables(tables, imap);
  if (pendingRows) {
    note?.("pending-header-attributes", request.sourceId, pendingRows);
  }
  // The all-headers table and the folder-info row are the index. Only an
  // empty folder's summary may lack the all-headers table; nsMsgDatabase
  // recreates it when it opens one.
  if (
    !infoTable ||
    (messageTable
      ? !sameKeys(
          messageTable.rows,
          [...messages.keys()].map(key => key + ":" + MESSAGE)
        )
      : messages.size)
  ) {
    throw new Error("Incomplete Mork message/folder tables");
  }
  // The per-thread tables with their cached counts and roots, the all-threads
  // subject index, the folder-info counts and cached unified-folder hits are
  // derived from the headers. Old Thunderbird repairs or recounts them and
  // real summaries leave them stale; they are neither imported nor compared.
  // Each header's own row names its thread and parent.
  const relations = getMorkThreadRelations({
    source: { rows, tables },
    messages: [...messages].map(([sourceKey, { row }]) => ({
      sourceKey,
      threadId: row.cells.has("msgThreadId")
        ? hex(row.cells.get("msgThreadId"))
        : null,
      threadParent: hex(row.cells.get("threadParent") ?? "ffffffff"),
    })),
  });
  for (const [key, { message }] of messages) {
    const relation = relations.get(key);
    if (rethread) {
      message.rootSourceKey = relation.root;
      message.parentSourceKey = relation.parent;
    } else if (
      message.rootSourceKey !== relation.root ||
      message.parentSourceKey !== relation.parent
    ) {
      throw new Error("Mork semantic thread map differs from source");
    }
  }
  // A thread's watch/ignore word is user data and is imported.
  request.threadFlags = getMorkThreadFlags(
    {
      source: { rows, tables },
      messages: [...messages].map(([sourceKey, { row }]) => ({
        sourceKey,
        threadId: row.cells.has("msgThreadId")
          ? hex(row.cells.get("msgThreadId"))
          : null,
      })),
    },
    relations
  );
  if (infoTable.rows.length != 1) {
    throw new Error("Unsupported Mork folder-info membership");
  }
  const infoKey = infoTable.rows[0];
  const info = rows.get(infoKey);
  if (!info || info.scope != INFO || info.id != 1) {
    throw new Error("Invalid Mork folder-info row");
  }
  const properties = folderProperties(
    info.cells,
    folderFlags,
    imap,
    LOCAL_STORE_PROTOCOLS.includes(request.folder.protocol)
  );
  if (imap) {
    request.imap = accountImapRecords(request, info.cells, offlineTable, rows);
  }
  return properties;
}

/**
 * Converts only names with native numeric getters. Unknown cells stay text.
 * Rejects int64 values that the currently checked numeric JS bridge cannot carry.
 *
 * @param {Map<string, string>} original - Exact original byte-string cells.
 * @param {number} flags - Actual current native folder flags.
 * @param {boolean} [imap=false] - Retain pending counters and the offline event flag.
 * @returns {object[]} Explicit typed properties; original text also retained.
 */
function folderProperties(original, flags, imap = false, localStore = false) {
  // A local store folder is Mail even when its summary word predates legacy
  // discovery setting it; never the reverse.
  const mail =
    localStore && flags & Ci.nsMsgFolderFlags.Mail
      ? Ci.nsMsgFolderFlags.Mail
      : 0;
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
      // Discovery adds the special use it derives, as the old one does.
      const derived =
        name == "flags"
          ? flags & ~property.integer & Ci.nsMsgFolderFlags.SpecialUse
          : 0;
      if (
        (name == "flags" &&
          (imap
            ? (property.integer ^ flags) &
              ~(Ci.nsMsgFolderFlags.OfflineEvents | derived)
            : (property.integer ^ flags) & ~(mail | derived))) ||
        // A summary old Thunderbird itself marked for rebuilding from its
        // store is not a usable index; the pending counters are a cache.
        (name == "forceReparse" && property.integer != 0) ||
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
      /[\u0100-\uffff]/.test(k) ||
      /[\u0100-\uffff]/.test(v)
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
  // A cell that is not UTF-8 is carried as its bytes read as ISO-8859-1
  // (parseMorkSummary): its text then is the byte string itself.
  const same = (text, bytes) =>
    MailStringUtils.stringToByteString(text) == bytes ||
    (text == bytes && !isUTF8(bytes));
  return (
    raw.size == extras.length &&
    [...raw].every(
      ([k, v], index) => same(extras[index].k, k) && same(extras[index].v, v)
    )
  );
}

/**
 * @param {string} bytes - Byte string.
 * @returns {boolean} Whether the bytes are well-formed UTF-8.
 */
function isUTF8(bytes) {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      MailStringUtils.byteStringToUint8Array(bytes)
    );
    return true;
  } catch {
    return false;
  }
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
