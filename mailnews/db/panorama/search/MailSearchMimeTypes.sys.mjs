/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Category keys and exact/wildcard precedence match the retained search facets.
const MIME_CATEGORIES = {
  archives: [
    "application/java-archive",
    "application/x-java-archive",
    "application/x-jar",
    "application/x-java-jnlp-file",

    "application/mac-binhex40",
    "application/vnd.ms-cab-compressed",

    "application/x-arc",
    "application/x-arj",
    "application/x-compress",
    "application/x-compressed-tar",
    "application/x-cpio",
    "application/x-cpio-compressed",
    "application/x-deb",

    "application/x-bittorrent",

    "application/x-rar",
    "application/x-rar-compressed",
    "application/x-7z-compressed",
    "application/zip",
    "application/x-zip-compressed",
    "application/x-zip",

    "application/x-bzip",
    "application/x-bzip-compressed-tar",
    "application/x-bzip2",
    "application/x-gzip",
    "application/x-tar",
    "application/x-tar-gz",
    "application/x-tarz",
  ],
  documents: {
    database: [
      "application/vnd.ms-access",
      "application/x-msaccess",
      "application/msaccess",
      "application/vnd.msaccess",
      "application/x-msaccess",
      "application/mdb",
      "application/x-mdb",

      "application/vnd.oasis.opendocument.database",
    ],
    graphics: [
      "application/postscript",
      "application/x-bzpostscript",
      "application/x-dvi",
      "application/x-gzdvi",

      "application/illustrator",

      "application/vnd.corel-draw",
      "application/cdr",
      "application/coreldraw",
      "application/x-cdr",
      "application/x-coreldraw",
      "image/cdr",
      "image/x-cdr",
      "zz-application/zz-winassoc-cdr",

      "application/vnd.oasis.opendocument.graphics",
      "application/vnd.oasis.opendocument.graphics-template",
      "application/vnd.oasis.opendocument.image",

      "application/x-dia-diagram",
    ],
    presentation: [
      "application/vnd.ms-powerpoint.presentation.macroenabled.12",
      "application/vnd.ms-powerpoint.template.macroenabled.12",
      "application/vnd.ms-powerpoint",
      "application/powerpoint",
      "application/mspowerpoint",
      "application/x-mspowerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.presentationml.template",

      "application/vnd.oasis.opendocument.presentation",
      "application/vnd.oasis.opendocument.presentation-template",
    ],
    spreadsheet: [
      "application/vnd.lotus-1-2-3",
      "application/x-lotus123",
      "application/x-123",
      "application/lotus123",
      "application/wk1",

      "application/x-quattropro",

      "application/vnd.ms-excel.sheet.binary.macroenabled.12",
      "application/vnd.ms-excel.sheet.macroenabled.12",
      "application/vnd.ms-excel.template.macroenabled.12",
      "application/vnd.ms-excel",
      "application/msexcel",
      "application/x-msexcel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.template",

      "application/vnd.oasis.opendocument.formula",
      "application/vnd.oasis.opendocument.formula-template",
      "application/vnd.oasis.opendocument.chart",
      "application/vnd.oasis.opendocument.chart-template",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.oasis.opendocument.spreadsheet-template",

      "application/x-gnumeric",
    ],
    wordProcessor: [
      "application/msword",
      "application/vnd.ms-word",
      "application/x-msword",
      "application/msword-template",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
      "application/vnd.ms-word.document.macroenabled.12",
      "application/vnd.ms-word.template.macroenabled.12",
      "application/x-mswrite",
      "application/x-pocket-word",

      "application/rtf",
      "text/rtf",

      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.text-master",
      "application/vnd.oasis.opendocument.text-template",
      "application/vnd.oasis.opendocument.text-web",

      "application/vnd.wordperfect",

      "application/x-abiword",
      "application/x-amipro",
    ],
    suite: ["application/vnd.ms-works"],
  },
  images: ["image/*"],
  media: {
    audio: ["audio/*"],
    video: ["video/*"],
    container: [
      "application/ogg",

      "application/smil",
      "application/vnd.ms-asf",
      "application/vnd.rn-realmedia",
      "application/x-matroska",
      "application/x-quicktime-media-link",
      "application/x-quicktimeplayer",
    ],
  },
  other: ["*"],
  pdf: [
    "application/pdf",
    "application/x-pdf",
    "image/pdf",
    "file/pdf",
    "application/x-bzpdf",
    "application/x-gzpdf",
  ],
};

const categories = new Map();
for (const [category, entries] of Object.entries(MIME_CATEGORIES)) {
  addCategories(entries, category);
}

/**
 * Adds exact types and major-type fallbacks for one existing category.
 *
 * @param {string[]|object} entries - Nested category mapping.
 * @param {string} category - Existing top-level category key.
 */
function addCategories(entries, category) {
  if (Array.isArray(entries)) {
    for (const type of entries) {
      categories.set(type, category);
    }
  } else {
    for (const nested of Object.values(entries)) {
      addCategories(nested, category);
    }
  }
}

/**
 * Normalizes a parsed MIME type without guessing from a filename.
 *
 * @param {string} value - MIME type, optionally with parameters.
 * @returns {?string} Lowercase RFC 2045 tokens, or null for malformed types.
 */
export function normalizeMailSearchMimeType(value) {
  const type = value.split(";", 1)[0].trim().toLowerCase();
  return /^[!#$%&'*+.^_`{|}~a-z0-9-]+\/[!#$%&'*+.^_`{|}~a-z0-9-]+$/.test(type)
    ? type
    : null;
}

/**
 * Reads the declared or MIME-default type of an attachment-shaped emitter part.
 * Attached messages inherit contentType; their headers describe the enclosed
 * message. The structural check also accepts parts from another module instance.
 *
 * @param {MimeMessageAttachment|MimeMessage} part - Observed user attachment.
 * @returns {?string} Attachment type, excluding filename-derived guesses.
 */
export function getMailSearchPartType(part) {
  return Object.hasOwn(part, "contentType")
    ? normalizeMailSearchMimeType(part.get("content-type") ?? "")
    : "message/rfc822";
}

/**
 * Resolves the retained exact-type, major-type and other category fallbacks.
 *
 * @param {string} value - Parsed MIME type.
 * @returns {?string} Existing category key, or null without a MIME type.
 */
export function getMailSearchMimeCategory(value) {
  const type = normalizeMailSearchMimeType(value);
  return type === null
    ? null
    : (categories.get(type) ??
        categories.get(type.split("/")[0] + "/*") ??
        categories.get("*"));
}

/**
 * Validates and copies MIME evidence. Missing evidence stays unknown.
 *
 * @param {?{types: string[], complete: boolean}} value - Observed types and coverage.
 * @returns {?{types: string[], complete: boolean}} Independent normalized evidence.
 * @throws {TypeError} For malformed evidence, including invalid MIME strings.
 */
export function copyMailSearchMimeEvidence(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    !Array.isArray(value.types) ||
    typeof value.complete != "boolean" ||
    value.types.some(
      type => typeof type != "string" || !normalizeMailSearchMimeType(type)
    )
  ) {
    throw new TypeError("Invalid attachment MIME evidence");
  }
  return {
    types: [...new Set(value.types.map(normalizeMailSearchMimeType))],
    complete: value.complete,
  };
}
