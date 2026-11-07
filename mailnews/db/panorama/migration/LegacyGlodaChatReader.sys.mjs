/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { FileUtils } from "resource://gre/modules/FileUtils.sys.mjs";
import { Sqlite } from "resource://gre/modules/Sqlite.sys.mjs";
import { hashMigrationFile } from "resource:///modules/panorama/MigrationSource.sys.mjs";

const MAX_ROWS = 100000;
const CHAT_COLUMNS = [
  "id:INTEGER",
  "title:STRING",
  "time:NUMBER",
  "path:STRING",
  "jsonAttributes:STRING",
];
const CONTENT_COLUMNS = ["docid:INTEGER", "c0content:"];
const TEXT_SCHEMA =
  "CREATE VIRTUAL TABLE imConversationsText USING fts3(tokenize mozporter, content STRING)";

/**
 * @typedef {object} LegacyChatSource
 * @property {string} path - Absolute original source path.
 * @property {number} size - Original byte length.
 * @property {string} sha256 - SHA-256 of original bytes.
 * @property {number} lastModified - Observed modification time for change detection.
 */

/**
 * @typedef {object} LegacyChatLogSnapshot
 * @property {number} version - Reader output version, currently one.
 * @property {LegacyChatSource & {relativePath: string}} source - Original log identity.
 * @property {Record<string, unknown>} header - All original header fields.
 * @property {string} headerLine - Exact original header JSON text.
 * @property {{line: number, rawLine: string, raw: Record<string, unknown>,
 *   disposition: string, reason: string}[]} records - Classified physical lines.
 * @property {string} disposition - Always quarantined.
 * @property {string} reason - Current policy and complete history remain unverified.
 */

/**
 * @typedef {object} LegacyGlodaChatSnapshot
 * @property {number} version - Reader output version, currently one.
 * @property {number} schemaVersion - Supported Gloda schema, 30 only.
 * @property {LegacyChatSource} source - Original database identity.
 * @property {{id: number, relativePath: string, title: ?string, text: ?string,
 *   jsonAttributes: ?string, raw: Record<string, object>, disposition: string,
 *   reason: string}[]} records - Exact aggregates, always quarantined.
 * @property {string[]} unreadTables - Tables outside this adapter's scope.
 */

/**
 * Reads schema30 IM aggregate text without starting Gloda or the chat logger.
 * Only closed UTF-8 rollback-journal snapshots up to 256 MiB are supported.
 * All aggregate text stays quarantined: the old index cannot prove current
 * noLog, edit, deletion, encryption policy or complete log history.
 *
 * @param {string} path - Absolute immutable backup database path.
 * @returns {Promise<LegacyGlodaChatSnapshot>} Exact aggregates and unread tables.
 *   No destination identities, search rows or completion receipts are created.
 * @throws {Error} On unsupported schema/layout, ambiguous paths or invalid data.
 */
export async function readLegacyGlodaChat(path) {
  const source = await inspectSource(path, 256 * 1024 * 1024);
  await rejectSidecars(source.path);
  const header = await IOUtils.read(source.path, { maxBytes: 100 });
  if (
    header.length < 100 ||
    new TextDecoder().decode(header.subarray(0, 16)) != "SQLite format 3\0" ||
    header[18] != 1 ||
    header[19] != 1 ||
    new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
      56
    ) != 1
  ) {
    throw new Error(
      "Legacy chat requires a closed UTF-8 rollback-journal snapshot"
    );
  }
  const connection = await Sqlite.openConnection({
    path: source.path,
    readOnly: true,
  });
  let result;
  let failure;
  let failed = false;
  try {
    result = await connection.executeTransaction(async () => {
      if ((await connection.getSchemaVersion()) != 30) {
        throw new Error("Unsupported legacy chat schema version");
      }
      const schema = await connection.execute(
        "SELECT name,type,sql FROM sqlite_master ORDER BY name"
      );
      const tables = new Map(
        schema
          .filter(row => row.getResultByName("type") == "table")
          .map(row => [row.getResultByName("name"), row.getResultByName("sql")])
      );
      if (
        tables.get("imConversationsText")?.replace(/\s+/g, "").toLowerCase() !=
        TEXT_SCHEMA.replace(/\s+/g, "").toLowerCase()
      ) {
        throw new Error("Unsupported legacy chat text layout");
      }
      const rows = await readChatTable(
        connection,
        tables,
        "imConversations",
        CHAT_COLUMNS
      );
      const contents = await readChatTable(
        connection,
        tables,
        "imConversationsText_content",
        CONTENT_COLUMNS
      );
      const texts = new Map(
        contents.map(row => [structuralId(row.docid), row.c0content])
      );
      const paths = new Set();
      const records = rows.map(raw => {
        const id = structuralId(raw.id);
        const relativePath = cellText(raw.path);
        logPathParts(relativePath);
        if (paths.has(relativePath)) {
          throw new Error("Ambiguous legacy chat log path");
        }
        paths.add(relativePath);
        if (!texts.has(id)) {
          throw new Error("Missing legacy chat content row");
        }
        const text = cellText(texts.get(id), true);
        texts.delete(id);
        if (!["integer", "real", "null"].includes(raw.time.type)) {
          throw new Error("Invalid legacy chat time");
        }
        return {
          id,
          relativePath,
          title: cellText(raw.title, true),
          text,
          jsonAttributes: cellText(raw.jsonAttributes, true),
          raw,
          disposition: "quarantined",
          reason: "legacy-index-policy-unverified",
        };
      });
      if (texts.size) {
        throw new Error("Orphaned legacy chat content");
      }
      return {
        records,
        unreadTables: [...tables.keys()].filter(
          name =>
            ![
              "imConversations",
              "imConversationsText",
              "imConversationsText_content",
            ].includes(name)
        ),
      };
    }, connection.TRANSACTION_DEFERRED);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await connection.close();
  } catch (error) {
    if (failed) {
      console.error("Closing legacy chat reader failed", error);
    } else {
      failed = true;
      failure = error;
    }
  }
  if (failed) {
    throw failure;
  }
  await rejectSidecars(source.path);
  await verifySource(source);
  return { version: 1, schemaVersion: 30, source, ...result };
}

/**
 * Reads one existing logger JSON-lines file by its original index path.
 * Rejects malformed/truncated lines instead of the logger's recovery behavior.
 * Keeps raw lines and text unchanged, including HTML and unknown fields.
 * Rejects links below logsRoot; ancestors of that root may be directory links.
 * A single file cannot establish complete conversation history or current
 * policy; surviving messages stay quarantined and never become search input.
 *
 * @param {string} logsRoot - Absolute original backup logs directory.
 * @param {string} relativePath - Exact four-component Gloda log location.
 * @returns {Promise<LegacyChatLogSnapshot>} Source hash and classified physical lines.
 * @throws {Error} On invalid paths, unsupported records or changed input.
 */
export async function readLegacyChatLog(logsRoot, relativePath) {
  if (!PathUtils.isAbsolute(logsRoot)) {
    throw new Error("Legacy chat logs root must be absolute");
  }
  const parts = logPathParts(relativePath);
  const file = new FileUtils.File(logsRoot);
  file.normalize();
  for (const part of parts) {
    file.append(part);
    if (file.isSymlink()) {
      throw new Error("Legacy chat log path contains a link");
    }
  }
  const source = await inspectSource(file.path, 64 * 1024 * 1024);
  // IOUtils allocates maxBytes up front; one byte past the measured size
  // still detects growth without a 64MB buffer per log.
  const bytes = await IOUtils.read(source.path, {
    maxBytes: source.size + 1,
  });
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hash.init(Ci.nsICryptoHash.SHA256);
  hash.update(bytes, bytes.length);
  const sha256 = Array.from(hash.finish(false), byte =>
    byte.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
  if (bytes.length != source.size || sha256 != source.sha256) {
    throw new Error("Legacy chat log bytes differ from source identity");
  }
  const text = decodeUtf8(bytes);
  if (!text.endsWith("\n")) {
    throw new Error("Truncated legacy chat log");
  }
  const lines = text.split("\n");
  lines.pop();
  if (lines.length - 1 > MAX_ROWS) {
    throw new Error("Legacy chat log row limit exceeded");
  }
  const header = parseLogLine(lines[0], 1);
  if (
    !validDate(header.date) ||
    typeof header.isChat != "boolean" ||
    ["name", "title", "account", "protocol", "normalizedName"].some(
      name => typeof header[name] != "string"
    ) ||
    ("continuedSession" in header &&
      typeof header.continuedSession != "boolean")
  ) {
    throw new Error("Unsupported legacy chat log header");
  }
  const records = lines.slice(1).map((line, index) => {
    const raw = parseLogLine(line, index + 2);
    if (
      !validDate(raw.date) ||
      typeof raw.text != "string" ||
      !Array.isArray(raw.flags) ||
      raw.flags.some(flag => typeof flag != "string") ||
      ["who", "alias", "remoteId"].some(
        name =>
          name in raw && raw[name] !== null && typeof raw[name] != "string"
      )
    ) {
      throw new Error("Unsupported legacy chat record at line " + (index + 2));
    }
    return { line: index + 2, rawLine: line, raw };
  });
  const latest = new Map();
  const deleted = new Set();
  const noLog = new Set();
  for (const [index, { raw }] of records.entries()) {
    if (raw.remoteId) {
      latest.set(raw.remoteId, index);
      if (raw.flags.includes("deleted")) {
        deleted.add(raw.remoteId);
      }
      if (raw.flags.includes("noLog")) {
        noLog.add(raw.remoteId);
      }
    }
  }
  for (const [index, record] of records.entries()) {
    const { raw } = record;
    let reason;
    if (raw.flags.includes("noLog") || noLog.has(raw.remoteId)) {
      reason = "noLog";
    } else if (raw.flags.includes("deleted") || deleted.has(raw.remoteId)) {
      // Do not resurrect a known deletion from a later unverified index/edit.
      reason = "deleted";
    } else if (raw.remoteId && latest.get(raw.remoteId) != index) {
      reason = "superseded";
    }
    record.disposition = reason ? "excluded" : "quarantined";
    record.reason = reason ?? "current-policy-and-history-unverified";
  }
  await verifySource(source);
  return {
    version: 1,
    source: { ...source, relativePath },
    header,
    headerLine: lines[0],
    records,
    disposition: "quarantined",
    reason: "current-policy-and-history-unverified",
  };
}

/**
 * Attaches independently read logs through exact original paths, never title,
 * timestamp, account guesses or generated message IDs. Keeps absent logs explicit.
 * Does not turn aggregate text or any log line into eligible/searchable content.
 *
 * @param {LegacyGlodaChatSnapshot} snapshot - Result of readLegacyGlodaChat.
 * @param {LegacyChatLogSnapshot[]} logs - Read logs from one source backup.
 * @returns {{records: object[], unmatchedLogs: object[]}} Read-only source bindings.
 * @throws {Error} On duplicate/ambiguous original paths or wrong reader versions.
 */
export function bindLegacyChatLogs(snapshot, logs) {
  if (snapshot.version != 1 || snapshot.schemaVersion != 30) {
    throw new Error("Unsupported legacy chat snapshot");
  }
  const byPath = new Map();
  for (const log of logs) {
    if (
      log.version != 1 ||
      log.disposition != "quarantined" ||
      byPath.has(log.source.relativePath)
    ) {
      throw new Error("Ambiguous legacy chat log binding");
    }
    logPathParts(log.source.relativePath);
    byPath.set(log.source.relativePath, log);
  }
  const records = snapshot.records.map(record => {
    if (record.disposition != "quarantined") {
      throw new Error("Legacy chat aggregate must remain quarantined");
    }
    const log = byPath.get(record.relativePath) ?? null;
    byPath.delete(record.relativePath);
    return {
      ...record,
      log,
      provenance: {
        source: snapshot.source,
        rowId: record.id,
        relativePath: record.relativePath,
        logSource: log?.source ?? null,
      },
      originalLogRead: log !== null,
      // Availability in a backup is not a current application open target.
      canOpen: false,
    };
  });
  return { records, unmatchedLogs: [...byPath.values()] };
}

/**
 * Checks a source path and hashes its bytes without changing it.
 * Requires quiesced backup writers; this is not a native immutable-file handle.
 *
 * @param {string} path - Absolute source file path.
 * @param {number} limit - Maximum supported file size.
 * @returns {Promise<{path: string, size: number, sha256: string, lastModified: number}>} Identity.
 */
async function inspectSource(path, limit) {
  if (!PathUtils.isAbsolute(path)) {
    throw new Error("Legacy chat source path must be absolute");
  }
  const file = new FileUtils.File(path);
  if (file.isSymlink()) {
    throw new Error("Legacy chat source contains a link");
  }
  file.normalize();
  const stat = await IOUtils.stat(file.path);
  if (stat.type != "regular" || stat.size > limit) {
    throw new Error("Unsupported legacy chat source type or size");
  }
  return {
    path: file.path,
    size: stat.size,
    lastModified: stat.lastModified,
    sha256: await hashMigrationFile(file.path),
  };
}

/**
 * Rejects changed source bytes before returning recovered data.
 *
 * @param {{path: string, size: number, sha256: string, lastModified: number}} source - Original identity.
 */
async function verifySource(source) {
  const stat = await IOUtils.stat(source.path);
  if (
    stat.type != "regular" ||
    stat.size != source.size ||
    stat.lastModified != source.lastModified ||
    (await hashMigrationFile(source.path)) != source.sha256
  ) {
    throw new Error("Legacy chat source changed while reading");
  }
}

/**
 * Rejects snapshots needing replay or WAL coordination.
 *
 * @param {string} path - Database path.
 */
async function rejectSidecars(path) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (await IOUtils.exists(path + suffix)) {
      throw new Error("Unsupported legacy chat sidecar: " + suffix);
    }
  }
}

/**
 * Validates the exact physical four-component path emitted by index_im.
 * Keeps encoded names unchanged; decoding could turn names into traversal.
 *
 * @param {string} path - Original slash-separated Gloda log path.
 * @returns {string[]} Original physical path components.
 */
function logPathParts(path) {
  if (typeof path != "string" || path.includes("\\") || path.includes("\0")) {
    throw new Error("Unsupported legacy chat log path");
  }
  const parts = path.split("/");
  if (
    parts.length != 4 ||
    parts.some(part => !part || part == "." || part == "..") ||
    !/^\d{4}-\d{2}-\d{2}\.\d{6}[+-]\d{4}\.json$/.test(parts[3])
  ) {
    throw new Error("Unsupported legacy chat log path");
  }
  return parts;
}

/**
 * Reads typed cells from the two fixed schema30 chat tables.
 *
 * @param {Sqlite.OpenedConnection} connection - Owned read-only connection.
 * @param {Map<string, string>} tables - Actual table declarations.
 * @param {string} name - Fixed supported table name.
 * @param {string[]} columns - Exact column names and declared types.
 * @returns {Promise<object[]>} Original storage classes and values.
 */
async function readChatTable(connection, tables, name, columns) {
  if (!/^CREATE TABLE /i.test(tables.get(name) ?? "")) {
    throw new Error("Unsupported legacy chat table: " + name);
  }
  const info = await connection.execute('PRAGMA table_info("' + name + '")');
  if (
    info
      .map(
        row =>
          row.getResultByName("name") +
          ":" +
          row.getResultByName("type").toUpperCase()
      )
      .join("|") != columns.join("|") ||
    info.some((row, index) => row.getResultByName("pk") != Number(index == 0))
  ) {
    throw new Error("Unsupported legacy chat columns: " + name);
  }
  const names = columns.map(column => column.split(":")[0]);
  const fields = names.flatMap((column, index) => [
    'typeof("' + column + '") AS t' + index,
    `CASE typeof("${column}") WHEN 'text' THEN hex(CAST("${column}" AS BLOB)) WHEN 'integer' THEN CAST("${column}" AS TEXT) ELSE "${column}" END AS v${index}`,
  ]);
  const rows = await connection.execute(
    "SELECT " +
      fields.join(",") +
      ' FROM "' +
      name +
      '" ORDER BY rowid LIMIT ' +
      (MAX_ROWS + 1)
  );
  if (rows.length > MAX_ROWS) {
    throw new Error("Legacy chat row limit exceeded");
  }
  return rows.map(row =>
    Object.fromEntries(
      names.map((column, index) => {
        const type = row.getResultByName("t" + index);
        let value = row.getResultByName("v" + index);
        if (type == "text") {
          value = decodeUtf8(
            Uint8Array.from(value.match(/../g) ?? [], byte =>
              parseInt(byte, 16)
            )
          );
        }
        if (
          !["null", "integer", "real", "text"].includes(type) ||
          (type == "real" && !Number.isFinite(value))
        ) {
          throw new Error("Unsupported legacy chat storage value");
        }
        return [column, { type, value }];
      })
    )
  );
}

/**
 * Returns original text without collapsing empty/null or normalizing Unicode.
 *
 * @param {{type: string, value: string|null}} cell - Typed stored value.
 * @param {boolean} [nullable=false] - Whether SQL null is supported.
 * @returns {string|null} Original text.
 */
function cellText(cell, nullable = false) {
  if (nullable && cell.type == "null") {
    return null;
  }
  if (cell.type != "text") {
    throw new Error("Invalid legacy chat text value");
  }
  return cell.value;
}

/**
 * Requires an exact positive original row ID, not an inferred message identity.
 *
 * @param {{type: string, value: string}} cell - Typed integer cell.
 * @returns {number} Exact original row ID.
 */
function structuralId(cell) {
  const id = Number(cell.value);
  if (cell.type != "integer" || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Invalid legacy chat row identity");
  }
  return id;
}

/**
 * Decodes valid UTF-8 without dropping an original leading BOM code point.
 *
 * @param {Uint8Array} bytes - Original bytes.
 * @returns {string} Original text.
 */
function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes
    );
  } catch {
    throw new Error("Invalid UTF-8 legacy chat text");
  }
}

/**
 * Parses one complete JSON object and keeps unsupported fields in that object.
 *
 * @param {string} text - One physical log line.
 * @param {number} line - Original one-based line number.
 * @returns {object} Parsed source record.
 */
function parseLogLine(text, line) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value == "object" && !Array.isArray(value)) {
      return value;
    }
  } catch {}
  throw new Error("Malformed legacy chat log at line " + line);
}

/**
 * Recognizes the ISO date strings written by JSON.stringify(Date).
 *
 * @param {unknown} value - Stored date field.
 * @returns {boolean} Whether the supported date representation is valid.
 */
function validDate(value) {
  return (
    typeof value == "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() == value
  );
}
