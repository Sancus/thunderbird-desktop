/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  MorkParser,
  MorkImportError,
} from "resource:///modules/MorkParser.sys.mjs";
import { MailStringUtils } from "resource:///modules/MailStringUtils.sys.mjs";
import { MIGRATED_MAIL_PROTOCOLS } from "resource:///modules/panorama/MorkFolderImport.sys.mjs";

const SCOPE = "ns:msg:db:row:scope:folders:all";
const KIND = "ns:msg:db:table:kind:folders";

// These projections match nsMsgFolderCache::applyEntry. Unknown cells stay text.
const SIGNED32 = new Set([
  "hierDelim",
  "lastSyncTimeInSec",
  "nextUID",
  "pendingMsgs",
  "pendingUnreadMsgs",
  "serverRecent",
  "serverTotal",
  "serverUnseen",
  "totalMsgs",
  "totalUnreadMsgs",
]);
const UNSIGNED32 = new Set(["aclFlags", "boxFlags", "flags"]);
const SIGNED64 = new Set(["expungedBytes", "folderSize"]);

/**
 * A folder cache is a rebuildable hint. Old Thunderbird reads it leniently
 * (nsMsgFolderCache.cpp): a file it cannot parse is an empty cache, a row
 * without a key is skipped, a later row replaces an earlier one with its key,
 * and a cell whose value the typed getter cannot return simply has no value.
 * Both readers below apply those rules and never refuse a profile for its
 * cache. The complete original stays in the backup (and in `source` when it
 * parsed); `skipped` counts the rows and cells that have no projection.
 *
 * @param {string} format - "mork" or "json".
 * @param {string} reason - Why no row could be read.
 * @returns {object} An empty cache.
 */
function unusableCache(format, reason) {
  return {
    ...(format == "json" ? { format } : {}),
    entries: new Map(),
    source: format == "json" ? {} : { rows: new Map(), tables: new Map() },
    skipped: { entries: 0, cells: 0 },
    unusable: reason,
  };
}

/**
 * @param {*} value - Candidate key, name or text cell.
 * @returns {boolean} Whether it is text every later stage can carry exactly.
 */
function carriedText(value) {
  return (
    typeof value == "string" && !value.includes("\0") && value.isWellFormed()
  );
}

/**
 * Reads active legacy folder-cache rows without starting the cache service.
 * Retains exact text and presence of every cell it can project. Known numeric
 * fields have a separate cache projection.
 *
 * @param {Uint8Array} bytes - Complete panacea.dat bytes.
 * @returns {{entries: Map<string, {sourceKey: number, properties: Map<string, string>,
 *   values: Record<string, string|number>}>, source: object, skipped: object,
 *   unusable?: string}} Original path keys.
 */
export function parseMorkFolderCache(bytes) {
  if (
    !ArrayBuffer.isView(bytes) ||
    Object.prototype.toString.call(bytes) != "[object Uint8Array]"
  ) {
    throw new TypeError("Expected Uint8Array");
  }
  let source;
  try {
    source = new MorkParser().parseForImport(
      MailStringUtils.uint8ArrayToByteString(bytes)
    );
  } catch (error) {
    if (!(error instanceof MorkImportError)) {
      throw error;
    }
    // importFromMork fails and Thunderbird starts with an empty cache.
    return unusableCache("mork", error.code);
  }
  const table = source.tables.get("1:" + SCOPE);
  if (table?.cells.get("k") != KIND) {
    return unusableCache("mork", "NO_FOLDER_TABLE");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const text = raw => {
    try {
      const value = decoder.decode(MailStringUtils.byteStringToUint8Array(raw));
      return carriedText(value) ? value : null;
    } catch {
      return null;
    }
  };
  const skipped = { entries: 0, cells: 0 };
  const entries = new Map();
  for (const key of table.rows) {
    const row = source.rows.get(key);
    const properties = new Map();
    const values = Object.create(null);
    let path = null;
    for (const [rawName, rawValue] of row?.scope == SCOPE ? row.cells : []) {
      const name = text(rawName);
      const value = text(rawValue);
      if (name == "key") {
        path = value;
        continue;
      }
      const projected =
        name === null || value === null ? undefined : cacheValue(name, value);
      if (projected === undefined) {
        skipped.cells++;
        continue;
      }
      properties.set(name, value);
      values[name] = projected;
    }
    // convertTable skips a row without a key; a later row replaces an
    // earlier one.
    if (!path) {
      skipped.entries++;
      continue;
    }
    if (entries.has(path)) {
      skipped.entries++;
    }
    entries.set(path, {
      sourceKey: row.id,
      properties: new Map([["key", path], ...properties]),
      values,
    });
  }
  return { entries, source, skipped };
}

/**
 * Reads native JSON cache rows without constructing the legacy cache service.
 * Uses each original descriptor as its source entry identity. JSON entries have
 * no Mork row ID. Numeric cells keep their typed value and canonical hex text.
 *
 * @param {Uint8Array} bytes - Complete original folderCache.json bytes.
 * @returns {{format: string, entries: Map<string, {properties: Map<string, string>,
 *   values: Record<string, string|number>}>, source: object, skipped: object,
 *   unusable?: string}} Every row that has a projection.
 */
export function parseJSONFolderCache(bytes) {
  if (Object.prototype.toString.call(bytes) !== "[object Uint8Array]") {
    throw new TypeError("Expected Uint8Array");
  }
  let source;
  try {
    // The old reader parses bytes; text that is not UTF-8 is carried with
    // replacement characters and can then name no current folder.
    source = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch {
    // LoadFolderCache fails and Thunderbird starts with an empty cache.
    return unusableCache("json", "NOT_JSON");
  }
  if (!source || Array.isArray(source) || typeof source !== "object") {
    return unusableCache("json", "NOT_AN_OBJECT");
  }
  const skipped = { entries: 0, cells: 0 };
  const entries = new Map();
  for (const [key, row] of Object.entries(source)) {
    // Thunderbird writes the entry of a folder without a file path under an
    // empty key. A key that is no absolute path here reaches no folder; it is
    // accounted like any other obsolete entry.
    if (
      !carriedText(key) ||
      !row ||
      Array.isArray(row) ||
      typeof row !== "object"
    ) {
      skipped.entries++;
      continue;
    }
    const properties = new Map([["key", key]]);
    const values = Object.create(null);
    for (const [name, original] of Object.entries(row)) {
      const projected =
        carriedText(name) && name !== "key"
          ? jsonCacheValue(name, original)
          : null;
      if (!projected) {
        skipped.cells++;
        continue;
      }
      properties.set(name, projected.cell);
      values[name] = projected.value;
    }
    entries.set(key, { properties, values });
  }
  return { format: "json", entries, source, skipped };
}

/**
 * Projects one JSON cache cell as nsMsgFolderCacheElement's typed getter
 * returns it (Json::Value::isConvertibleTo): a number or boolean converts
 * between the numeric and text forms; a value the getter reports as not
 * available, or returns only as its zero or empty default (null), has no
 * projection.
 *
 * @param {string} name - Cache property name.
 * @param {*} original - Parsed JSON value.
 * @returns {?{cell: string, value: string|number}} Typed value and canonical
 *   cell text, or null.
 */
function jsonCacheValue(name, original) {
  // The current JSON producer writes userSortOrder as uint32. Historical
  // Mork conversion retains its original text projection for this property.
  const unsigned = UNSIGNED32.has(name) || name === "userSortOrder";
  let width = 0;
  if (SIGNED64.has(name)) {
    width = 64;
  } else if (SIGNED32.has(name) || unsigned) {
    width = 32;
  }
  if (!width) {
    if (typeof original == "string") {
      return carriedText(original) ? { cell: original, value: original } : null;
    }
    if (typeof original == "boolean" || Number.isSafeInteger(original)) {
      return { cell: String(original), value: String(original) };
    }
    return null;
  }
  let value = original;
  if (typeof value == "boolean") {
    value = Number(value);
  } else if (typeof value == "number" && Number.isFinite(value)) {
    value = Math.trunc(value);
  }
  const minimum = unsigned ? 0 : -(2 ** (width - 1));
  const maximum = unsigned ? 0xffffffff : 2 ** (width - 1) - 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return null;
  }
  return {
    cell: BigInt.asUintN(width, BigInt(value)).toString(16),
    value,
  };
}

/**
 * Writes a new JSON cache after validating all rows and physical path mappings.
 * Never overwrites a cache or removes the legacy input. The caller supplies
 * mappings from discovered original folder descriptors to destination keys.
 *
 * @param {Uint8Array} bytes - Original panacea.dat bytes.
 * @param {string} destination - Absolute fresh JSON cache path.
 * @param {Map<string, string>} paths - Complete original/destination key map.
 * @returns {Promise<number>} Number of imported folder records.
 * @throws {Error} For an incomplete/colliding map or an existing output.
 */
export async function importMorkFolderCache(bytes, destination, paths) {
  if (!PathUtils.isAbsolute(destination)) {
    throw new Error("Folder-cache destination must be absolute");
  }
  const { entries } = parseMorkFolderCache(bytes);
  if (
    Object.prototype.toString.call(paths) != "[object Map]" ||
    paths.size != entries.size
  ) {
    throw new Error("Incomplete folder-cache path mapping");
  }
  const output = Object.create(null);
  const destinations = new Set();
  for (const [original, target] of paths) {
    if (
      !entries.has(original) ||
      typeof target != "string" ||
      !target ||
      target.includes("\0") ||
      destinations.has(target)
    ) {
      throw new Error("Invalid or colliding folder-cache path mapping");
    }
    destinations.add(target);
    output[target] = entries.get(original).values;
  }
  await IOUtils.writeJSON(destination, output, { mode: "create", flush: true });
  return entries.size;
}

/**
 * Imports a complete cache map using actual native folder descriptors.
 * The caller supplies every original key explicitly; names/URIs are not joins.
 * Mirrors nsMsgDBFolder::GetFolderCacheKey without invoking legacy cache writes:
 * server roots use filePath, other folders use summaryFile. Preserves unknown
 * text and empty properties through importMorkFolderCache's fresh JSON output.
 * Does not register, activate or apply this cache to Panorama folder metadata.
 * Requires the caller's complete backup and quiesced source/cache writers.
 *
 * @param {Uint8Array} bytes - Original read-only panacea.dat snapshot.
 * @param {string} destination - Absolute fresh JSON cache path.
 * @param {Map<string, nsIMsgFolder>} folders - Complete original-key/native-folder map.
 * @returns {Promise<number>} Number of imported records.
 * @throws {Error} For invalid folders/UTF-8 descriptors, colliding maps or IO errors.
 */
export async function importMorkFolderCacheForFolders(
  bytes,
  destination,
  folders
) {
  if (Object.prototype.toString.call(folders) != "[object Map]") {
    throw new TypeError(
      "Expected original cache keys mapped to native folders"
    );
  }
  const paths = new Map();
  for (const [original, value] of folders) {
    const folder = value.QueryInterface(Ci.nsIMsgFolder);
    const file = folder.isServer ? folder.filePath : folder.summaryFile;
    const descriptor = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(
      MailStringUtils.byteStringToUint8Array(file.persistentDescriptor)
    );
    paths.set(original, descriptor);
  }
  return importMorkFolderCache(bytes, destination, paths);
}

/**
 * Projects one Mork cache cell as nsMsgFolderCache.cpp applyEntry converts it:
 * a numeric property reads its leading hexadecimal digits and is dropped when
 * it has none; any other property is text.
 *
 * @param {string} name - Cache property name.
 * @param {string} value - Original cell text.
 * @returns {string|number|undefined} Typed value; undefined for no value.
 */
function cacheValue(name, value) {
  const width = SIGNED64.has(name) ? 64 : 32;
  if (!SIGNED32.has(name) && !UNSIGNED32.has(name) && !SIGNED64.has(name)) {
    return value;
  }
  const digits = /^[0-9a-f]+/i.exec(value)?.[0];
  if (!digits || digits.length > width / 4) {
    return undefined;
  }
  let number = BigInt("0x" + digits);
  if (!UNSIGNED32.has(name)) {
    number = BigInt.asIntN(width, number);
  }
  const converted = Number(number);
  return Number.isSafeInteger(converted) ? converted : undefined;
}

const CACHE_BINDING_FIELDS = [
  "originalKey",
  "sourceKey",
  "id",
  "isServer",
  "descriptor",
  "cachePath",
  "storePath",
  "protocol",
  "storeType",
];
const CACHE_AUTHORITY = new Set([
  "flags",
  "folderName",
  "totalMsgs",
  "totalUnreadMsgs",
  "pendingMsgs",
  "pendingUnreadMsgs",
  "folderSize",
  "expungedBytes",
]);

/**
 * Builds the supported native cache envelope from a retained journal unit.
 *
 * Version2 binds the verified backup and original physical input paths.
 * Version3 binds native JSON descriptors instead of Mork row IDs.
 * Units without `requestVersion` retain their exact version1 envelope.
 *
 * @param {object} unit - Exact source identity and complete physical bindings.
 * @returns {object} Native request; native code reads the source and proof files.
 * @throws {Error} For invalid identity, proof, paths or duplicate bindings.
 */
export function createMorkFolderCacheRequest(unit) {
  const version = unit.requestVersion === undefined ? 1 : unit.requestVersion;
  if (![1, 2, 3].includes(version)) {
    throw new Error("Unsupported native cache request version");
  }
  const json = version === 3;
  if (
    json &&
    (unit.sourceFormat !== "json" ||
      PathUtils.filename(unit.path) !== "folderCache.json")
  ) {
    throw new Error("JSON cache requires its explicit original source format");
  }
  const proof = version >= 2 ? cacheReconciliationProof(unit.proof) : null;
  if (version === 1 && unit.proof !== undefined) {
    throw new Error("Cache proof requires version2");
  }
  for (const value of [unit.id, unit.token, unit.databaseSourceId, unit.path]) {
    if (typeof value != "string" || !value || value.includes("\0")) {
      throw new Error("Invalid cache import identity");
    }
  }
  if (
    !PathUtils.isAbsolute(unit.path) ||
    !/^[a-f0-9]{64}$/.test(unit.sha256) ||
    !Number.isSafeInteger(unit.size) ||
    unit.size <= 0 ||
    unit.size >= 0xffffffff ||
    !Array.isArray(unit.folders) ||
    (!json && !unit.folders.length)
  ) {
    throw new Error("Invalid cache source identity");
  }
  const bindingFields = json
    ? CACHE_BINDING_FIELDS.filter(name => name !== "sourceKey")
    : CACHE_BINDING_FIELDS;
  const unique = new Map(
    [
      "originalKey",
      "sourceKey",
      "id",
      "descriptor",
      "cachePath",
      "storePath",
    ].map(name => [name, new Set()])
  );
  const fields =
    version >= 2 ? [...bindingFields, "originalSummaryPath"] : bindingFields;
  const originals = new Set();
  const folders = unit.folders.map(folder => {
    if (json && Object.hasOwn(folder, "sourceKey")) {
      throw new Error("JSON cache entry has no Mork source row ID");
    }
    for (const name of bindingFields) {
      const value = folder[name];
      if (name == "id" || name == "sourceKey") {
        if (
          !Number.isSafeInteger(value) ||
          value <= 0 ||
          (name == "sourceKey" && value > 0xffffffff)
        ) {
          throw new Error("Invalid cache folder identity");
        }
      } else if (name == "isServer") {
        if (typeof value != "boolean") {
          throw new Error("Invalid cache server identity");
        }
      } else if (typeof value != "string" || !value || value.includes("\0")) {
        throw new Error("Invalid cache folder field: " + name);
      }
      if (unique.has(name)) {
        if (unique.get(name).has(value)) {
          throw new Error("Duplicate cache folder binding");
        }
        unique.get(name).add(value);
      }
    }
    if (
      !MIGRATED_MAIL_PROTOCOLS.includes(folder.protocol) ||
      !PathUtils.isAbsolute(folder.cachePath) ||
      !PathUtils.isAbsolute(folder.storePath)
    ) {
      throw new Error("Unsupported cache folder binding");
    }
    if (version >= 2) {
      if (
        typeof folder.originalSummaryPath != "string" ||
        folder.originalSummaryPath.includes("\0") ||
        (folder.isServer
          ? folder.originalSummaryPath !== ""
          : !PathUtils.isAbsolute(folder.originalSummaryPath) ||
            folder.originalSummaryPath !== folder.cachePath ||
            originals.has(folder.originalSummaryPath))
      ) {
        throw new Error("Invalid or duplicate original cache input path");
      }
      if (!folder.isServer) {
        originals.add(folder.originalSummaryPath);
      }
    }
    return Object.fromEntries(fields.map(name => [name, folder[name]]));
  });
  // Obsolete original keys reach no current folder; they are listed so that
  // every original entry is accounted, and stay in the verified backup.
  const unboundKeys = unit.unboundKeys ?? [];
  if (
    !Array.isArray(unboundKeys) ||
    (unit.unboundKeys !== undefined && !unboundKeys.length) ||
    (unboundKeys.length && version === 1) ||
    unboundKeys.some(
      (key, index) =>
        typeof key != "string" ||
        key.includes("\0") ||
        (index && unboundKeys[index - 1] >= key) ||
        folders.some(
          folder => folder.originalKey === key || folder.descriptor === key
        )
    )
  ) {
    throw new Error("Invalid obsolete folder-cache keys");
  }
  return {
    version,
    ...(json
      ? { sourceFormat: "json", policy: "native-reconciled-json-v3" }
      : {}),
    token: unit.token,
    sourceId: unit.id,
    databaseSourceId: unit.databaseSourceId,
    source: { path: unit.path, size: unit.size, sha256: unit.sha256 },
    ...(proof ? { proof } : {}),
    folders,
    ...(unboundKeys.length ? { unboundKeys: [...unboundKeys] } : {}),
  };
}

/**
 * Copies the immutable backup identity used by version2 reconciliation.
 * Native code verifies the manifest bytes and complete original-file inventory.
 *
 * @param {object} proof - Selected profile and verified manifest identity.
 * @returns {object} Owned profile path and manifest path, byte size and SHA256.
 * @throws {Error} For an incomplete or nonabsolute proof identity.
 */
function cacheReconciliationProof(proof) {
  const manifest = proof?.manifest;
  if (
    typeof proof?.profilePath != "string" ||
    !PathUtils.isAbsolute(proof.profilePath) ||
    proof.profilePath.includes("\0") ||
    typeof manifest?.path != "string" ||
    !PathUtils.isAbsolute(manifest.path) ||
    manifest.path.includes("\0") ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size <= 0 ||
    manifest.size >= 0xffffffff ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256)
  ) {
    throw new Error("Invalid native cache reconciliation proof");
  }
  return {
    profilePath: proof.profilePath,
    manifest: {
      path: manifest.path,
      size: manifest.size,
      sha256: manifest.sha256,
    },
  };
}

/**
 * Returns exact, presence-sensitive cells in a stable comparison order.
 *
 * @param {object[]} folders - Planner bindings with every original property.
 * @returns {object[]} Cell values; no native disposition is inferred.
 */
export function getMorkFolderCacheCells(folders) {
  return folders
    .flatMap(folder => {
      const names = new Set();
      if (
        !Array.isArray(folder.properties) ||
        !folder.properties.some(
          p => p.name == "key" && p.text === folder.originalKey
        )
      ) {
        throw new Error("Incomplete cache properties");
      }
      return folder.properties.map(property => {
        if (
          typeof property.name != "string" ||
          !property.name ||
          property.name.includes("\0") ||
          names.has(property.name) ||
          typeof property.text != "string" ||
          (Object.hasOwn(property, "integer") &&
            !Number.isSafeInteger(property.integer))
        ) {
          throw new Error("Invalid cache property");
        }
        names.add(property.name);
        return {
          id: folder.id,
          name: property.name,
          text: property.text,
          ...(Object.hasOwn(property, "integer")
            ? { integer: property.integer }
            : {}),
        };
      });
    })
    .sort((a, b) => {
      const difference = a.id - b.id;
      if (difference) {
        return difference;
      }
      if (a.name < b.name) {
        return -1;
      }
      return a.name > b.name ? 1 : 0;
    });
}

/**
 * Checks a native receipt against every retained binding and original cell.
 *
 * @param {object} unit - Retained source/binding/cell plan.
 * @param {object} receipt - Actual native committed receipt.
 * @returns {object} Owned receipt suitable for a separate journal checkpoint.
 */
export function validateMorkFolderCacheReceipt(unit, receipt) {
  const expected = createMorkFolderCacheRequest(unit);
  const identity = receipt?.identity;
  let policy = "native-authoritative-v1";
  if (expected.version === 3) {
    policy = "native-reconciled-json-v3";
  } else if (expected.version === 2) {
    policy = "native-reconciled-selected-v2";
  }
  if (
    identity?.version !== expected.version ||
    identity.policy !== policy ||
    (expected.version === 3 && identity.sourceFormat !== "json") ||
    identity.token !== unit.token ||
    identity.sourceId !== unit.id ||
    identity.databaseSourceId !== unit.databaseSourceId ||
    identity.path !== unit.path ||
    identity.sha256 !== unit.sha256 ||
    identity.size !== unit.size ||
    JSON.stringify(identity.unboundKeys ?? []) !==
      JSON.stringify(expected.unboundKeys ?? []) ||
    !Array.isArray(receipt.cells)
  ) {
    throw new Error("Invalid native cache receipt identity");
  }
  if (
    expected.version >= 2 &&
    JSON.stringify(cacheReconciliationProof(identity.proof)) !==
      JSON.stringify(expected.proof)
  ) {
    throw new Error("Native cache receipt proof changed");
  }
  const actual = createMorkFolderCacheRequest({
    ...unit,
    folders: identity.folders,
  });
  const byId = values => values.toSorted((a, b) => a.id - b.id);
  if (
    JSON.stringify(byId(actual.folders)) !==
    JSON.stringify(byId(expected.folders))
  ) {
    throw new Error("Native cache receipt mapping changed");
  }
  const folders = unit.folders.map(folder => ({ ...folder, properties: [] }));
  const byFolder = new Map(folders.map(folder => [folder.id, folder]));
  for (const cell of receipt.cells) {
    const folder = byFolder.get(cell.id);
    let dispositions;
    if (expected.version >= 2) {
      validateReconciledCacheCell(cell, expected.version);
      dispositions = [cell.disposition];
    } else if (cell.name == "key") {
      dispositions = ["binding"];
    } else if (CACHE_AUTHORITY.has(cell.name)) {
      dispositions = ["native-authoritative"];
    } else {
      dispositions = ["existing", "applied"];
    }
    if (!folder || !dispositions.includes(cell.disposition)) {
      throw new Error("Invalid native cache cell disposition");
    }
    folder.properties.push({
      name: cell.name,
      text: cell.text,
      ...(Object.hasOwn(cell, "integer") ? { integer: cell.integer } : {}),
    });
  }
  if (
    JSON.stringify(getMorkFolderCacheCells(folders)) !==
    JSON.stringify(getMorkFolderCacheCells(unit.folders))
  ) {
    throw new Error("Native cache receipt cells changed");
  }
  return structuredClone(receipt);
}

/**
 * Checks the closed native version2/3 field disposition and typed projection.
 * Raw cells are compared separately against every original source cell.
 *
 * @param {object} cell - One actual native receipt cell.
 * @param {number} version - Exact retained native request version.
 * @throws {Error} For an invalid alias, value, mask or unresolved field.
 */
function validateReconciledCacheCell(cell, version) {
  const pending =
    cell.name == "pendingMsgs" || cell.name == "pendingUnreadMsgs";
  let target = cell.name;
  if (pending) {
    target =
      cell.name == "pendingMsgs" ? "totPendingMsgs" : "unreadPendingMsgs";
  }
  const integer = Object.hasOwn(cell, "nativeInteger");
  const text = Object.hasOwn(cell, "nativeText");
  const mask = Object.hasOwn(cell, "eligibleMask");
  if (
    cell.target !== target ||
    (integer && !Number.isSafeInteger(cell.nativeInteger)) ||
    (text && typeof cell.nativeText != "string")
  ) {
    throw new Error("Invalid native cache field projection");
  }
  let dispositions;
  if (cell.name == "key") {
    dispositions = ["binding"];
    if (integer || text || mask) {
      throw new Error("Invalid native cache binding projection");
    }
  } else {
    if (integer === text || (cell.name != "flags" && mask)) {
      throw new Error("Invalid native cache field value");
    }
    if (cell.name == "flags") {
      dispositions = ["applied", "existing", "source-authoritative"];
      validateReconciledCacheFlags(cell);
    } else if (cell.name == "totalMsgs" || cell.name == "totalUnreadMsgs") {
      dispositions = ["native-authoritative"];
      if (
        !integer ||
        cell.nativeInteger < 0 ||
        cell.nativeInteger > 0x7fffffff
      ) {
        throw new Error("Invalid native cache count projection");
      }
    } else if (cell.name == "userSortOrder") {
      dispositions = ["existing", "applied"];
      if (
        version !== 3 ||
        !Number.isSafeInteger(cell.integer) ||
        cell.integer < 0 ||
        cell.integer > 0xffffffff ||
        cell.text !== cell.integer.toString(16) ||
        !integer ||
        cell.nativeInteger < 0 ||
        cell.nativeInteger > 0xffffffff ||
        (cell.disposition === "applied" && cell.nativeInteger !== cell.integer)
      ) {
        throw new Error("Invalid native JSON cache user order projection");
      }
    } else if (cell.name == "folderName") {
      dispositions = ["native-authoritative"];
      if (!text) {
        throw new Error("Invalid native cache name projection");
      }
    } else if (pending) {
      dispositions = ["existing", "applied", "native-authoritative"];
      if (
        !integer ||
        cell.nativeInteger < -0x80000000 ||
        cell.nativeInteger > 0x7fffffff
      ) {
        throw new Error("Invalid native cache pending projection");
      }
    } else if (cell.name == "folderSize" || cell.name == "expungedBytes") {
      dispositions = ["existing", "applied-native"];
      if (!integer || cell.nativeInteger < 0) {
        throw new Error("Invalid native cache accounting projection");
      }
    } else {
      dispositions = ["existing", "applied"];
      if (
        cell.disposition == "applied" &&
        (Object.hasOwn(cell, "integer")
          ? !integer || cell.nativeInteger !== cell.integer
          : !text || cell.nativeText !== cell.text)
      ) {
        throw new Error("Native cache applied value differs from the source");
      }
    }
  }
  if (!dispositions.includes(cell.disposition)) {
    throw new Error("Invalid or unreconciled native cache cell disposition");
  }
}

/**
 * Checks the allowed native client mask and its exact applied flag bits.
 *
 * @param {object} cell - The version2 flags cell with its actual committed word.
 * @throws {Error} For a noninteger word, invalid mask or mismatched projection.
 */
function validateReconciledCacheFlags(cell) {
  const clientMask = 0xa8000010;
  if (
    !Object.hasOwn(cell, "nativeInteger") ||
    cell.nativeInteger < 0 ||
    cell.nativeInteger > 0xffffffff ||
    !Number.isInteger(cell.eligibleMask) ||
    cell.eligibleMask < 0 ||
    cell.eligibleMask > 0xffffffff ||
    (cell.eligibleMask & ~clientMask) !== 0 ||
    (cell.eligibleMask !== 0) !== (cell.disposition == "applied") ||
    (cell.nativeInteger & cell.eligibleMask) >>> 0 !==
      (cell.integer & cell.eligibleMask) >>> 0
  ) {
    throw new Error("Invalid native cache flags projection");
  }
}
