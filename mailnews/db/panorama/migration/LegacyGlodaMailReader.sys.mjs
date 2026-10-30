/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { FileUtils } from "resource://gre/modules/FileUtils.sys.mjs";
import { Sqlite } from "resource://gre/modules/Sqlite.sys.mjs";
import { hashMigrationFile } from "resource:///modules/panorama/MigrationSource.sys.mjs";

const MAX_DATABASE_BYTES = 256 * 1024 * 1024;
const MAX_ROWS = 100000;
// GlodaDatastore schema30 and SQLite FTS3's ordinary content-table layout.
const TABLES = {
  folderLocations: [
    "id:INTEGER",
    "folderURI:TEXT",
    "dirtyStatus:INTEGER",
    "name:TEXT",
    "indexingPriority:INTEGER",
  ],
  messages: [
    "id:INTEGER",
    "folderID:INTEGER",
    "messageKey:INTEGER",
    "conversationID:INTEGER",
    "date:INTEGER",
    "headerMessageID:TEXT",
    "deleted:INTEGER",
    "jsonAttributes:TEXT",
    "notability:INTEGER",
  ],
  messagesText_content: [
    "docid:INTEGER",
    "c0body:",
    "c1subject:",
    "c2attachmentNames:",
    "c3author:",
    "c4recipients:",
  ],
  attributeDefinitions: [
    "id:INTEGER",
    "attributeType:INTEGER",
    "extensionName:TEXT",
    "name:TEXT",
    "parameter:BLOB",
  ],
  messageAttributes: [
    "conversationID:INTEGER",
    "messageID:INTEGER",
    "attributeID:INTEGER",
    "value:NUMERIC",
  ],
};
const TEXT_SCHEMA =
  "CREATE VIRTUAL TABLE messagesText USING fts3(tokenize mozporter, body TEXT, subject TEXT, attachmentNames TEXT, author TEXT, recipients TEXT)";

/**
 * @typedef {object} LegacyGlodaCell
 * @property {string} type - SQLite storage class, not an inferred attribute type.
 * @property {string|number|null} value - Exact text, decimal integer, hex blob,
 *   finite real or null. Empty text and empty blobs keep their storage class.
 */

/**
 * @typedef {object} LegacyGlodaMailMessage
 * @property {number} id - Original Gloda row ID.
 * @property {number|null} folderId - Original Gloda folder ID; null for ghosts.
 * @property {string|null} folderURI - Exact original folder location.
 * @property {number|null} messageKey - Original physical key; null for unkeyed moves or ghosts.
 * @property {boolean} deleted - Stored deletion state.
 * @property {number} conversationId - Original conversation row ID, not a thread key.
 * @property {string|null} headerMessageId - Metadata only, never an identity join.
 * @property {Record<string, LegacyGlodaCell>} raw - Every original message column.
 * @property {?{body: ?string, subject: ?string, attachmentNames: ?string,
 *   author: ?string, recipients: ?string}} text - Stored semantic text cells.
 * @property {Record<string, LegacyGlodaCell>[]} attributes - All typed attribute rows.
 */

/**
 * @typedef {object} LegacyGlodaMailSnapshot
 * @property {number} version - Reader output version, currently one.
 * @property {number} schemaVersion - Supported source schema, currently 30 only.
 * @property {{path: string, size: number, sha256: string}} source - Original bytes.
 * @property {{id: number, uri: string, raw: Record<string, LegacyGlodaCell>}[]} folders - Source locations.
 * @property {LegacyGlodaMailMessage[]} messages - Live, ghost and deleted rows.
 * @property {Record<string, LegacyGlodaCell>[]} attributeDefinitions - All definitions.
 * @property {string[]} unreadTables - Tables outside this mail reader's scope.
 */

/**
 * Reads a closed schema30 Gloda database without loading Gloda or a tokenizer.
 * Only UTF-8 rollback-journal snapshots without sidecars are supported. Use a verified
 * migration backup with all writers stopped; WAL recovery is not implemented.
 * Keeps raw attributes and stored text; does not attach policy or body availability.
 *
 * @param {string} path - Absolute path to the immutable source database.
 * @returns {Promise<LegacyGlodaMailSnapshot>} Owned source records. This is not
 *   a complete database import. Inputs are limited to 256 MiB and 100000 rows/table.
 * @throws {Error} On unsupported layout/version, corruption, changes or limits.
 */
export async function readLegacyGlodaMail(path) {
  if (!PathUtils.isAbsolute(path)) {
    throw new Error("Legacy Gloda path must be absolute");
  }
  const file = new FileUtils.File(path);
  if (file.isSymlink()) {
    throw new Error("Legacy Gloda path contains a link");
  }
  file.normalize();
  path = file.path;
  const before = await IOUtils.stat(path);
  if (before.type != "regular" || before.size > MAX_DATABASE_BYTES) {
    throw new Error("Unsupported legacy Gloda file type or size");
  }
  await rejectSidecars(path);
  const header = await IOUtils.read(path, { maxBytes: 100 });
  if (
    new TextDecoder().decode(header.subarray(0, 16)) != "SQLite format 3\0" ||
    header[18] != 1 ||
    header[19] != 1 ||
    header.length < 100 ||
    new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
      56
    ) != 1
  ) {
    throw new Error(
      "Legacy Gloda requires a closed UTF-8 rollback-journal snapshot"
    );
  }
  const sha256 = await hashMigrationFile(path);
  const connection = await Sqlite.openConnection({ path, readOnly: true });
  let result;
  let failure;
  let failed = false;
  try {
    result = await connection.executeTransaction(
      () => readMailTables(connection),
      connection.TRANSACTION_DEFERRED
    );
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await connection.close();
  } catch (error) {
    if (failed) {
      console.error("Closing legacy Gloda reader failed", error);
    } else {
      failed = true;
      failure = error;
    }
  }
  if (failed) {
    throw failure;
  }
  await rejectSidecars(path);
  const after = await IOUtils.stat(path);
  if (
    after.type != "regular" ||
    after.size != before.size ||
    after.lastModified != before.lastModified ||
    (await hashMigrationFile(path)) != sha256
  ) {
    throw new Error("Legacy Gloda source changed while reading");
  }
  return {
    version: 1,
    schemaVersion: 30,
    source: { path, size: before.size, sha256 },
    ...result,
  };
}

/**
 * Rejects sources that require journal replay or WAL coordination.
 *
 * @param {string} path - Database path.
 */
async function rejectSidecars(path) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (await IOUtils.exists(path + suffix)) {
      throw new Error("Unsupported legacy Gloda sidecar: " + suffix);
    }
  }
}

/**
 * Checks schema and reads all supported mail rows within one read transaction.
 *
 * @param {Sqlite.OpenedConnection} connection - Owned read-only connection.
 * @returns {Promise<object>} Unmapped records and exact source attributes.
 */
async function readMailTables(connection) {
  const version = await connection.getSchemaVersion();
  if (version != 30) {
    throw new Error("Unsupported legacy Gloda schema version: " + version);
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
    tables.get("messagesText")?.replace(/\s+/g, "").toLowerCase() !=
    TEXT_SCHEMA.replace(/\s+/g, "").toLowerCase()
  ) {
    throw new Error("Unsupported legacy Gloda text layout");
  }
  const data = {};
  for (const [name, columns] of Object.entries(TABLES)) {
    if (!tables.has(name) || !/^CREATE TABLE /i.test(tables.get(name))) {
      throw new Error("Unsupported legacy Gloda table: " + name);
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
      info.some(
        (row, index) =>
          row.getResultByName("pk") !=
          Number(index == 0 && name != "messageAttributes")
      )
    ) {
      throw new Error("Unsupported legacy Gloda columns: " + name);
    }
    data[name] = await readTable(
      connection,
      name,
      columns.map(column => column.split(":")[0])
    );
  }
  const folders = new Map();
  const uris = new Set();
  for (const row of data.folderLocations) {
    const id = integer(row.id);
    const uri = text(row.folderURI);
    if (id <= 0 || !uri || folders.has(id) || uris.has(uri)) {
      throw new Error("Ambiguous legacy Gloda folder identity");
    }
    folders.set(id, { id, uri, raw: row });
    uris.add(uri);
  }
  const texts = new Map(
    data.messagesText_content.map(row => [integer(row.docid), row])
  );
  const attributes = new Map();
  for (const row of data.messageAttributes) {
    const id = integer(row.messageID);
    if (!attributes.has(id)) {
      attributes.set(id, []);
    }
    attributes.get(id).push(row);
  }
  const locations = new Set();
  const messages = data.messages.map(raw => {
    const id = integer(raw.id);
    const folderId = integer(raw.folderID, true);
    const messageKey = integer(raw.messageKey, true);
    const deleted = integer(raw.deleted);
    if (
      id <= 0 ||
      ![0, 1].includes(deleted) ||
      (folderId === null && messageKey !== null) ||
      (folderId !== null && !folders.has(folderId)) ||
      (messageKey !== null && (messageKey < 0 || messageKey >= 0xffffffff))
    ) {
      throw new Error("Invalid legacy Gloda message location");
    }
    const stored = texts.get(id);
    if (!deleted && folderId !== null) {
      const location = folderId + ":" + messageKey;
      if (!stored || (messageKey !== null && locations.has(location))) {
        throw new Error(
          "Missing text or ambiguous legacy Gloda message location"
        );
      }
      if (messageKey !== null) {
        locations.add(location);
      }
    }
    texts.delete(id);
    const messageAttributes = attributes.get(id) ?? [];
    attributes.delete(id);
    return {
      id,
      folderId,
      folderURI: folders.get(folderId)?.uri ?? null,
      messageKey,
      deleted: !!deleted,
      conversationId: integer(raw.conversationID),
      headerMessageId: text(raw.headerMessageID, true),
      raw,
      text: stored
        ? {
            body: text(stored.c0body, true),
            subject: text(stored.c1subject, true),
            attachmentNames: text(stored.c2attachmentNames, true),
            author: text(stored.c3author, true),
            recipients: text(stored.c4recipients, true),
          }
        : null,
      attributes: messageAttributes,
    };
  });
  if (texts.size || attributes.size) {
    throw new Error("Orphaned legacy Gloda text or attributes");
  }
  return {
    folders: [...folders.values()],
    messages,
    attributeDefinitions: data.attributeDefinitions,
    unreadTables: [...tables.keys()]
      .filter(name => !Object.hasOwn(TABLES, name) && name != "messagesText")
      .sort(),
  };
}

/**
 * Reads storage classes explicitly so 64-bit integers never round in JS.
 * Does not interpret numeric-looking text, JSON attributes or extension names.
 *
 * @param {Sqlite.OpenedConnection} connection - Source connection.
 * @param {string} name - Fixed supported table name.
 * @param {string[]} columns - Validated supported columns.
 * @returns {Promise<Record<string, LegacyGlodaCell>[]>} All source rows.
 */
async function readTable(connection, name, columns) {
  const fields = columns.flatMap((column, index) => [
    'typeof("' + column + '") AS t' + index,
    `CASE typeof("${column}") WHEN 'blob' THEN hex("${column}") WHEN 'text' THEN hex(CAST("${column}" AS BLOB)) WHEN 'integer' THEN CAST("${column}" AS TEXT) ELSE "${column}" END AS v${index}`,
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
    throw new Error("Legacy Gloda row limit exceeded: " + name);
  }
  return rows.map(row =>
    Object.fromEntries(
      columns.map((column, index) => {
        const type = row.getResultByName("t" + index);
        let value = row.getResultByName("v" + index);
        if (type == "text") {
          const bytes = Uint8Array.from(value.match(/../g) ?? [], byte =>
            parseInt(byte, 16)
          );
          try {
            value = new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(bytes);
          } catch {
            throw new Error("Invalid UTF-8 legacy Gloda text");
          }
        }
        if (
          !["integer", "real", "text", "blob", "null"].includes(type) ||
          (type == "real" && !Number.isFinite(value))
        ) {
          throw new Error("Unsupported legacy Gloda storage value");
        }
        return [column, { type, value }];
      })
    )
  );
}

/**
 * Requires an exact safe structural integer, with explicit nullable fields.
 *
 * @param {LegacyGlodaCell} cell - Typed source value.
 * @param {boolean} [nullable=false] - Allow SQL null.
 * @returns {number|null} Structural value.
 */
function integer(cell, nullable = false) {
  if (nullable && cell.type == "null") {
    return null;
  }
  if (cell.type != "integer" || !Number.isSafeInteger(Number(cell.value))) {
    throw new Error("Invalid legacy Gloda structural integer");
  }
  return Number(cell.value);
}

/**
 * Requires text without collapsing null and empty or normalizing Unicode.
 *
 * @param {LegacyGlodaCell} cell - Typed source value.
 * @param {boolean} [nullable=false] - Allow SQL null.
 * @returns {string|null} Original text.
 */
function text(cell, nullable = false) {
  if (nullable && cell.type == "null") {
    return null;
  }
  if (cell.type != "text") {
    throw new Error("Invalid legacy Gloda text value");
  }
  return cell.value;
}

/**
 * Resolves live mail rows using exact original folder URIs and committed maps.
 * Excludes deleted, ghost, unkeyed and stale rows. Does not infer eligibility, merge
 * Message-IDs, write search state or claim original bodies can be opened.
 *
 * @param {LegacyGlodaMailSnapshot} snapshot - Source records from readLegacyGlodaMail.
 * @param {{folderURI: string, source: object, originalSummary: object}[]} bindings -
 *   Original URI, imported journal source and readMorkMigrationSource result
 *   from the same summary bytes. Message-ID corroborates the physical key join.
 * @returns {{mapped: object[], excluded: object[]}} Mapped records retain raw
 *   text/attributes and receipt provenance; current policy must still be checked.
 * @throws {Error} On missing, ambiguous or inconsistent mappings.
 */
export function mapLegacyGlodaMail(snapshot, bindings) {
  if (snapshot.version != 1 || snapshot.schemaVersion != 30) {
    throw new Error("Invalid legacy Gloda snapshot");
  }
  const folders = new Map();
  const allocated = new Set();
  for (const { folderURI, source, originalSummary } of bindings) {
    const receipt = source.receipt;
    if (
      !folderURI ||
      folders.has(folderURI) ||
      source.state != "imported" ||
      typeof source.id != "string" ||
      !source.id ||
      typeof source.path != "string" ||
      !PathUtils.isAbsolute(source.path) ||
      !Number.isSafeInteger(source.size) ||
      source.size < 0 ||
      !Number.isSafeInteger(source.destinationFolderId) ||
      source.destinationFolderId <= 0 ||
      typeof source.token != "string" ||
      !source.token ||
      !/^[0-9a-f]{64}$/.test(source.sha256) ||
      receipt?.token !== source.token ||
      receipt?.sourceSha256 !== source.sha256 ||
      receipt?.folderId !== source.destinationFolderId ||
      !Array.isArray(receipt.keys) ||
      !Array.isArray(source.messageKeys)
    ) {
      throw new Error("Invalid legacy Gloda migration binding");
    }
    const keys = new Map();
    const originals = new Set(source.messageKeys);
    for (const [oldKey, newKey] of receipt.keys) {
      if (
        !Number.isInteger(oldKey) ||
        oldKey < 0 ||
        oldKey >= 0xffffffff ||
        !originals.has(oldKey) ||
        keys.has(oldKey) ||
        !Number.isInteger(newKey) ||
        newKey <= 0 ||
        newKey >= 0xffffffff ||
        allocated.has(newKey)
      ) {
        throw new Error("Invalid legacy Gloda committed key map");
      }
      keys.set(oldKey, newKey);
      allocated.add(newKey);
    }
    if (
      originals.size != source.messageKeys.length ||
      keys.size != originals.size
    ) {
      throw new Error("Incomplete legacy Gloda committed key map");
    }
    const identity = originalSummary?.identity;
    if (
      identity?.sha256 !== source.sha256 ||
      identity?.path !== source.path ||
      identity?.size !== source.size ||
      !Array.isArray(identity?.messageKeys) ||
      identity.messageKeys.length != originals.size ||
      new Set(identity.messageKeys).size != originals.size ||
      identity.messageKeys.some(key => !originals.has(key)) ||
      !Array.isArray(originalSummary?.summary?.messages)
    ) {
      throw new Error("Invalid legacy Gloda original summary binding");
    }
    const messageIds = new Map();
    for (const message of originalSummary.summary.messages) {
      if (
        !originals.has(message.sourceKey) ||
        messageIds.has(message.sourceKey) ||
        typeof message.messageId != "string"
      ) {
        throw new Error("Invalid legacy Gloda original summary message map");
      }
      messageIds.set(message.sourceKey, message.messageId);
    }
    if (messageIds.size != originals.size) {
      throw new Error("Incomplete legacy Gloda original summary message map");
    }
    folders.set(folderURI, { source, keys, messageIds });
  }
  const mapped = [];
  const excluded = [];
  for (const message of snapshot.messages) {
    if (message.deleted || message.folderId === null) {
      excluded.push({ reason: message.deleted ? "deleted" : "ghost", message });
      continue;
    }
    if (message.messageKey === null) {
      excluded.push({ reason: "unkeyed", message });
      continue;
    }
    const binding = folders.get(message.folderURI);
    if (!binding?.keys.has(message.messageKey)) {
      throw new Error("Unresolved legacy Gloda folder/key location");
    }
    if (
      binding.messageIds.get(message.messageKey) !== message.headerMessageId
    ) {
      excluded.push({ reason: "stale", message });
      continue;
    }
    mapped.push({
      folderId: binding.source.destinationFolderId,
      key: binding.keys.get(message.messageKey),
      message,
      provenance: {
        source: snapshot.source,
        glodaId: message.id,
        folderURI: message.folderURI,
        folderId: message.folderId,
        messageKey: message.messageKey,
        sourceFolderId: binding.source.id,
        sourceSha256: binding.source.sha256,
        token: binding.source.token,
      },
    });
  }
  return { mapped, excluded };
}
