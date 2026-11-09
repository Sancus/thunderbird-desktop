/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  MorkParser,
  MorkImportError,
} from "resource:///modules/MorkParser.sys.mjs";
import { MailStringUtils } from "resource:///modules/MailStringUtils.sys.mjs";

/**
 * @typedef {object} MorkSummaryMessage
 * @property {number} sourceKey - Original folder-local message key.
 * @property {Map<string, string>} properties - Exact names, text and presence.
 * @property {string} messageId - Original Message-ID text.
 * @property {string[]} references - Ordered ancestors, excluding self references.
 * @property {number} dateInSeconds - Original timestamp in seconds.
 * @property {number} flags - Original message flags.
 * @property {number} messageSize - Original message size.
 * @property {number} threadId - Original msgThreadId, not a new global key.
 * @property {number} threadParent - Original parent key or 0xffffffff.
 * @property {string} storeToken - Explicit body token or decimal legacy msgOffset.
 */

/**
 * Reads a mail-summary snapshot without opening a legacy database or writing.
 * Retains every table/row in source, including offline-operation records.
 * Generic properties retain exact names, text and presence. Structural numeric
 * fields are validated separately; no generic property type is inferred.
 *
 * @param {Uint8Array} bytes - Complete original summary bytes.
 * @returns {{messages: MorkSummaryMessage[], source: import("resource:///modules/MorkParser.sys.mjs").MorkImportSnapshot}}
 *   Messages in table order and the complete original byte-string snapshot.
 * @throws {MorkImportError} For invalid syntax, structural numbers or UTF-8 text.
 */
export function parseMorkSummary(bytes) {
  if (
    !ArrayBuffer.isView(bytes) ||
    Object.prototype.toString.call(bytes) != "[object Uint8Array]"
  ) {
    throw new TypeError("Expected Uint8Array");
  }
  const source = new MorkParser().parseForImport(
    MailStringUtils.uint8ArrayToByteString(bytes)
  );
  const tables = [...source.tables.values()].filter(
    table =>
      table.scope == "ns:msg:db:row:scope:msgs:all" &&
      table.cells.get("k") == "ns:msg:db:table:kind:msgs"
  );
  // A legacy compress commit leaves an empty folder's summary with only its
  // folder info: nsMsgDatabase recreates the absent all-headers table on open.
  // Such a summary has no messages; callers still validate every record. Mork
  // without folder info is not a mail summary.
  const folderInfo = [...source.tables.values()].some(
    table =>
      table.scope == "ns:msg:db:row:scope:dbfolderinfo:all" &&
      table.cells.get("k") == "ns:msg:db:table:kind:dbfolderinfo"
  );
  if (tables.length > 1 || (!tables.length && !folderInfo)) {
    throw new MorkImportError(
      "UNSUPPORTED_MORK",
      0,
      "Expected one message table"
    );
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const text = raw => {
    try {
      return decoder.decode(MailStringUtils.byteStringToUint8Array(raw));
    } catch (error) {
      throw new MorkImportError(
        "UNSUPPORTED_MORK",
        0,
        "Non-UTF-8 header property"
      );
    }
  };
  const messages = (tables[0]?.rows ?? []).map(key => {
    const row = source.rows.get(key);
    if (row.scope != tables[0].scope) {
      throw new MorkImportError(
        "UNSUPPORTED_MORK",
        0,
        "Message row scope mismatch"
      );
    }
    const properties = new Map(
      [...row.cells].map(([name, value]) => [text(name), text(value)])
    );
    const number = (name, fallback = 0) => {
      if (!properties.has(name)) {
        return fallback;
      }
      const value = properties.get(name);
      if (!/^[0-9a-f]{1,8}$/i.test(value)) {
        throw new MorkImportError("MALFORMED_MORK", 0, "Invalid " + name);
      }
      return parseInt(value, 16);
    };
    let storeToken = properties.get("storeToken") ?? "";
    if (!storeToken && properties.has("msgOffset")) {
      const offset = properties.get("msgOffset");
      if (!/^[0-9a-f]{1,16}$/i.test(offset)) {
        throw new MorkImportError("MALFORMED_MORK", 0, "Invalid msgOffset");
      }
      const value = BigInt("0x" + offset);
      // Native GetStoreToken reserves UINT64_MAX for an unset offset.
      if (value != 0xffffffffffffffffn) {
        storeToken = value.toString();
      }
    }
    return {
      sourceKey: row.id,
      properties,
      messageId: properties.get("message-id") ?? "",
      references: readReferences(
        properties.get("references") ?? "",
        properties.get("message-id") ?? ""
      ),
      dateInSeconds: number("date"),
      flags: number("flags"),
      messageSize: number("size"),
      threadId: number("msgThreadId"),
      threadParent: number("threadParent", 0xffffffff),
      storeToken,
    };
  });
  return { messages, source };
}

/**
 * Reads ordered References using nsMsgHdr::GetNextReference semantics.
 * Keeps duplicate ancestors and ignores self references. Only the first token
 * permits the legacy undelimited fallback. The original property stays intact.
 *
 * @param {string} value - Original References text.
 * @param {string} messageId - This header's Message-ID.
 * @returns {string[]} Ordered ancestor IDs.
 */
function readReferences(value, messageId) {
  // The legacy interface reads a NUL-terminated string.
  value = value.split("\0", 1)[0];
  const references = [];
  let pos = 0;
  while (pos < value.length) {
    const first = pos == 0;
    const tail = value.slice(pos);
    const open = tail.indexOf("<");
    const close = open < 0 ? -1 : tail.indexOf(">", open + 1);
    let reference = "";
    if (close >= 0) {
      reference = tail.slice(open + 1, close);
      pos += close + 1;
    } else {
      if (first) {
        reference = tail.replace(/^[ \r\n\t]+/, "").replace(/^</, "");
      }
      pos = value.length;
    }
    if (reference && reference != messageId) {
      references.push(reference);
    }
  }
  return references;
}
