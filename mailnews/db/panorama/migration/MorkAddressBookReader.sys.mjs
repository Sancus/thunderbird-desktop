/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  MorkParser,
  MorkImportError,
} from "resource:///modules/MorkParser.sys.mjs";
import { MailStringUtils } from "resource:///modules/MailStringUtils.sys.mjs";

const CARD = "ns:addrbk:db:row:scope:card:all";
const LIST = "ns:addrbk:db:row:scope:list:all";
const DATA = "ns:addrbk:db:row:scope:data:all";
const PAB = "ns:addrbk:db:table:kind:pab";
const DELETED = "ns:addrbk:db:table:kind:deleted";

/**
 * Reads cards, lists and physical membership from a legacy address book.
 * Retains all cell text and empty values, including unknown card/list fields.
 * Does not create cards or publish a partially imported address book.
 *
 * @param {Uint8Array} bytes - Complete original .mab bytes.
 * @returns {{cards: {sourceKey: number, properties: Map<string, string>}[],
 *   lists: {sourceKey: number, properties: Map<string, string>, members: number[]}[],
 *   metadata: Map<string, Map<string, string>>, source: object}} Active records
 *   and the complete snapshot, including deleted rows and non-active records.
 * @throws {MorkImportError} For unsupported tables/scopes/text or incomplete lists.
 */
export function parseMorkAddressBook(bytes) {
  if (
    !ArrayBuffer.isView(bytes) ||
    Object.prototype.toString.call(bytes) != "[object Uint8Array]"
  ) {
    throw new TypeError("Expected Uint8Array");
  }
  const source = new MorkParser().parseForImport(
    MailStringUtils.uint8ArrayToByteString(bytes)
  );
  const table = source.tables.get("1:" + CARD);
  if (
    table?.cells.get("k") != PAB ||
    [...source.tables.values()].some(
      other => other != table && other.cells.get("k") != DELETED
    )
  ) {
    throw new MorkImportError(
      "UNSUPPORTED_MORK",
      0,
      "Unsupported address-book tables"
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
        "Non-UTF-8 address-book cell"
      );
    }
  };
  const cards = [];
  const lists = [];
  const metadata = new Map();
  for (const key of table.rows) {
    const row = source.rows.get(key);
    const properties = new Map(
      [...row.cells].map(([name, value]) => [text(name), text(value)])
    );
    if (row.scope == CARD) {
      cards.push({ sourceKey: row.id, properties });
    } else if (row.scope == LIST) {
      lists.push({ sourceKey: row.id, properties, members: [] });
    } else if (row.scope == DATA) {
      metadata.set(key, properties);
    } else {
      throw new MorkImportError(
        "UNSUPPORTED_MORK",
        0,
        "Unsupported address-book row scope"
      );
    }
  }
  const cardKeys = new Set(cards.map(card => card.sourceKey));
  for (const list of lists) {
    const count = list.properties.has("ListTotalAddresses")
      ? uint32(list.properties.get("ListTotalAddresses"), "list count")
      : 0;
    // Native list positions are uint16_t; do not wrap or loop indefinitely.
    if (count > 0xffff) {
      throw new MorkImportError(
        "UNSUPPORTED_MORK",
        0,
        "Address-book list is too large"
      );
    }
    for (let index = 1; index <= count; index++) {
      const member = uint32(
        list.properties.get("Address" + index),
        "list member"
      );
      if (!cardKeys.has(member)) {
        throw new MorkImportError(
          "MALFORMED_MORK",
          0,
          "Address-book list member is missing"
        );
      }
      list.members.push(member);
    }
    for (const name of list.properties.keys()) {
      const match = /^Address([1-9][0-9]*)$/.exec(name);
      if (match && Number(match[1]) > count) {
        throw new MorkImportError(
          "MALFORMED_MORK",
          0,
          "Address-book member exceeds list count"
        );
      }
    }
  }
  return { cards, lists, metadata, source };
}

/**
 * Reads a structural hexadecimal list count/member without changing cell text.
 *
 * @param {string|undefined} value - Original field text.
 * @param {string} field - Error context.
 * @returns {number} Unsigned original value.
 * @throws {MorkImportError} For missing or invalid structural fields.
 */
function uint32(value, field) {
  if (typeof value != "string" || !/^[0-9a-f]{1,8}$/i.test(value)) {
    throw new MorkImportError(
      "MALFORMED_MORK",
      0,
      "Invalid address-book " + field
    );
  }
  return parseInt(value, 16);
}
