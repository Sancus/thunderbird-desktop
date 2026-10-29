/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** FTS3 column order in PanoramaSearchIndex, distinct from Gloda messagesText. */
export const SEARCH_TEXT_FIELDS = Object.freeze([
  "subject",
  "body",
  "attachmentNames",
  "author",
  "recipients",
]);

/**
 * Converts FTS3 UTF-8 byte ranges to disjoint JavaScript string ranges.
 * Rejects offsets for another physical document or stored text revision.
 * Callers can show text without highlights when this returns null.
 *
 * @param {SearchHit} hit - Physical result, textRevision and offsetsUtf8.
 * @param {?SearchDocument} document - Current text returned by getText.
 * @param {string} [field="body"] - One of SEARCH_TEXT_FIELDS.
 * @returns {?{start: number, end: number}[]} UTF-16 ranges, or null for stale text.
 * @throws {TypeError} For an unknown field or malformed FTS tuples.
 * @throws {RangeError} For a range outside the field or between UTF-8 bytes.
 */
export function getSearchHighlightRanges(hit, document, field = "body") {
  const column = SEARCH_TEXT_FIELDS.indexOf(field);
  if (column < 0) {
    throw new TypeError("Unknown search text field");
  }
  if (
    !document ||
    typeof hit?.id != "string" ||
    !hit.id ||
    hit.id !== document.id ||
    typeof hit.textRevision != "string" ||
    !hit.textRevision ||
    hit.textRevision !== document.textRevision
  ) {
    return null;
  }
  const text = document[field];
  if (typeof text != "string" || typeof hit.offsetsUtf8 != "string") {
    throw new TypeError("Expected search text and FTS offsets");
  }
  if (!hit.offsetsUtf8.trim()) {
    return [];
  }
  const tokens = hit.offsetsUtf8.trim().split(/\s+/);
  if (
    tokens.length % 4 ||
    tokens.some(
      token => !/^\d+$/.test(token) || !Number.isSafeInteger(Number(token))
    )
  ) {
    throw new TypeError("Malformed FTS offsets");
  }
  const bytes = [];
  for (let i = 0; i < tokens.length; i += 4) {
    const [matchColumn, , start, length] = tokens.slice(i, i + 4).map(Number);
    if (matchColumn >= SEARCH_TEXT_FIELDS.length || !length) {
      throw new TypeError("Malformed FTS offsets");
    }
    if (matchColumn == column) {
      const end = start + length;
      if (!Number.isSafeInteger(end)) {
        throw new RangeError("Invalid UTF-8 range");
      }
      bytes.push({ start, end });
    }
  }
  if (!bytes.length) {
    return [];
  }
  const boundaries = new Set(bytes.flatMap(range => [range.start, range.end]));
  const positions = new Map();
  let byteOffset = 0;
  let stringOffset = 0;
  for (const point of text) {
    if (boundaries.has(byteOffset)) {
      positions.set(byteOffset, stringOffset);
    }
    const value = point.codePointAt(0);
    byteOffset +=
      value < 0x80 ? 1 : value < 0x800 ? 2 : value < 0x10000 ? 3 : 4;
    stringOffset += point.length;
  }
  if (boundaries.has(byteOffset)) {
    positions.set(byteOffset, stringOffset);
  }
  if (positions.size != boundaries.size) {
    throw new RangeError("FTS range is outside a UTF-8 character boundary");
  }
  const ranges = bytes
    .map(range => ({
      start: positions.get(range.start),
      end: positions.get(range.end),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const result = [];
  for (const range of ranges) {
    const previous = result.at(-1);
    if (previous && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      result.push(range);
    }
  }
  return result;
}

/**
 * Returns the existing result card's five-line body snippet with two lines of
 * context before the first body match. Ranges refer to the returned text.
 * This creates no DOM and does not turn unavailable content into body text.
 *
 * @param {SearchHit} hit - Result whose offsets describe this stored projection.
 * @param {?SearchDocument} document - Current semantic text returned by getText.
 * @returns {?{text: string, ranges: {start: number, end: number}[],
 *   firstMatchText: ?string}} Snippet, or null for another copy/text revision.
 */
export function getSearchBodySnippet(hit, document) {
  const matches = getSearchHighlightRanges(hit, document);
  if (matches === null) {
    return null;
  }
  let body = document.body;
  let start = 0;
  if (matches.length) {
    start = matches[0].start;
    for (let context = 2; context >= 0; context--) {
      start = body.lastIndexOf("\n", start - 1);
      if (start == -1) {
        start = 0;
        break;
      }
    }
  }
  let maxLines = 5;
  if (start) {
    while (body[start + 1] == "\n") {
      start++;
    }
    body = "…" + body.substring(start);
    maxLines++;
  }
  let end = -1;
  let ellipsis = "…";
  for (let line = 0; line < maxLines; line++) {
    end = body.indexOf("\n", end + 1);
    if (end == -1) {
      ellipsis = "";
      break;
    }
  }
  let snippet = end == -1 ? body : body.substring(0, end);
  if (ellipsis) {
    snippet = snippet.trimEnd();
  }
  const shift = start ? 1 - start : 0;
  const ranges = matches
    .map(range => ({ start: range.start + shift, end: range.end + shift }))
    .filter(range => range.start >= 0 && range.end <= snippet.length);
  return {
    text: snippet + ellipsis,
    ranges,
    firstMatchText: ranges.length
      ? snippet.substring(ranges[0].start, ranges[0].end)
      : null,
  };
}
