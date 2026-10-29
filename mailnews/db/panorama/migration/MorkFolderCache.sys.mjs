/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  MorkParser,
  MorkImportError,
} from "resource:///modules/MorkParser.sys.mjs";
import { MailStringUtils } from "resource:///modules/MailStringUtils.sys.mjs";

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
 * Reads active legacy folder-cache rows without starting the cache service.
 * Retains exact text, presence and the complete byte-string snapshot.
 * Known numeric fields have a separate cache projection.
 *
 * @param {Uint8Array} bytes - Complete panacea.dat bytes.
 * @returns {{entries: Map<string, {sourceKey: number, properties: Map<string, string>,
 *   values: Record<string, string|number>}>, source: object}} Original path keys.
 * @throws {MorkImportError} For malformed/unsupported rows or unsafe numbers.
 */
export function parseMorkFolderCache(bytes) {
  if (
    !ArrayBuffer.isView(bytes) ||
    Object.prototype.toString.call(bytes) != "[object Uint8Array]"
  ) {
    throw new TypeError("Expected Uint8Array");
  }
  const source = new MorkParser().parseForImport(
    MailStringUtils.uint8ArrayToByteString(bytes)
  );
  const table = source.tables.get("1:" + SCOPE);
  if (source.tables.size != 1 || table?.cells.get("k") != KIND) {
    throw new MorkImportError(
      "UNSUPPORTED_MORK",
      0,
      "Expected one folder-cache table"
    );
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const text = raw => {
    try {
      return decoder.decode(MailStringUtils.byteStringToUint8Array(raw));
    } catch {
      throw new MorkImportError(
        "UNSUPPORTED_MORK",
        0,
        "Non-UTF-8 folder-cache cell"
      );
    }
  };
  const entries = new Map();
  for (const key of table.rows) {
    const row = source.rows.get(key);
    if (row.scope != SCOPE) {
      throw new MorkImportError(
        "UNSUPPORTED_MORK",
        0,
        "Unsupported folder-cache row scope"
      );
    }
    const properties = new Map(
      [...row.cells].map(([name, value]) => [text(name), text(value)])
    );
    const path = properties.get("key");
    if (!path || path.includes("\0") || entries.has(path)) {
      throw new MorkImportError(
        "MALFORMED_MORK",
        0,
        "Missing or duplicate folder-cache key"
      );
    }
    const values = Object.create(null);
    for (const [name, value] of properties) {
      if (name != "key") {
        values[name] = cacheValue(name, value);
      }
    }
    entries.set(path, { sourceKey: row.id, properties, values });
  }
  return { entries, source };
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
 * Projects only fields typed by the existing cache converter.
 *
 * @param {string} name - Exact cache property name.
 * @param {string} value - Exact original text.
 * @returns {string|number} Cache-compatible value.
 * @throws {MorkImportError} For invalid or nonrepresentable typed values.
 */
function cacheValue(name, value) {
  const width = SIGNED64.has(name) ? 64 : 32;
  if (!SIGNED32.has(name) && !UNSIGNED32.has(name) && !SIGNED64.has(name)) {
    return value;
  }
  if (!new RegExp("^[0-9a-f]{1," + width / 4 + "}$", "i").test(value)) {
    throw new MorkImportError(
      "MALFORMED_MORK",
      0,
      "Invalid cache number: " + name
    );
  }
  let number = BigInt("0x" + value);
  if (!UNSIGNED32.has(name)) {
    number = BigInt.asIntN(width, number);
  }
  const converted = Number(number);
  if (!Number.isSafeInteger(converted)) {
    throw new MorkImportError(
      "UNSUPPORTED_MORK",
      0,
      "Cache number exceeds exact JSON range"
    );
  }
  return converted;
}
