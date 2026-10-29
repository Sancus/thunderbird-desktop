/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  getMailSearchPartType,
  normalizeMailSearchMimeType,
} from "resource:///modules/panorama/MailSearchMimeTypes.sys.mjs";

/**
 * @typedef {object} MailSearchAttachmentInfo
 * @property {?string} name - Parser filename; null means unavailable.
 * @property {?string} contentType - Declared or MIME-default type; message/rfc822
 *   for attached messages. Filename guesses are excluded.
 * @property {?number} size - Parser-reported byte count, including zero.
 * @property {?string} part - MIME part path; never an internal message URL.
 * @property {?boolean} isExternal - Whether the parser identified a detached part.
 * @property {?string} externalUrl - Observed detached URL, not authority to open it.
 */

/**
 * Copies only observed attachment fields. Aggregate/default model sizes and
 * internal message URLs are not persisted.
 *
 * @param {MimeMessageAttachment|MimeMessage} part - User attachment from the parser.
 * @returns {MailSearchAttachmentInfo} Fields with null for missing evidence.
 */
export function readMailSearchAttachmentInfo(part) {
  const size = Object.getOwnPropertyDescriptor(part, "size")?.value;
  const isExternal =
    typeof part.isExternal == "boolean" ? part.isExternal : null;
  return {
    name: typeof part.name == "string" ? part.name : null,
    contentType: getMailSearchPartType(part),
    size: Number.isSafeInteger(size) && size >= 0 ? size : null,
    part:
      typeof part.partName == "string" && /^\d+(?:\.\d+)*$/.test(part.partName)
        ? part.partName
        : null,
    isExternal,
    externalUrl:
      isExternal === true && typeof part.url == "string" && part.url
        ? part.url
        : null,
  };
}

/**
 * Validates and copies stored attachment details. Missing evidence stays null;
 * malformed stored fields throw instead of becoming unavailable content.
 *
 * @param {?{items: MailSearchAttachmentInfo[], complete: boolean}} value - Details
 *   and whether the parsed tree exposed all user attachments.
 * @returns {?{items: MailSearchAttachmentInfo[], complete: boolean}} Independent copy.
 * @throws {TypeError} For invalid fields or a URL without a known external flag.
 */
export function copyMailSearchAttachmentInfos(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Array.isArray(value.items) || typeof value.complete != "boolean") {
    throw new TypeError("Invalid attachment details");
  }
  return {
    complete: value.complete,
    items: value.items.map(item => {
      if (!item || typeof item != "object" || Array.isArray(item)) {
        throw new TypeError("Invalid attachment details");
      }
      const copy = {};
      for (const field of ["name", "contentType", "part", "externalUrl"]) {
        copy[field] = item[field] ?? null;
        if (copy[field] !== null && typeof copy[field] != "string") {
          throw new TypeError("Invalid attachment detail: " + field);
        }
      }
      copy.size = item.size ?? null;
      copy.isExternal = item.isExternal ?? null;
      if (
        (copy.size !== null &&
          (!Number.isSafeInteger(copy.size) || copy.size < 0)) ||
        (copy.isExternal !== null && typeof copy.isExternal != "boolean") ||
        (copy.part !== null && !/^\d+(?:\.\d+)*$/.test(copy.part)) ||
        (copy.contentType !== null &&
          normalizeMailSearchMimeType(copy.contentType) !== copy.contentType) ||
        (copy.externalUrl !== null &&
          (copy.isExternal !== true || !copy.externalUrl))
      ) {
        throw new TypeError("Invalid attachment details");
      }
      return copy;
    }),
  };
}
