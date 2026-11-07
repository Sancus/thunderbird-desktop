/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { copyMailSearchAttachmentInfos } from "resource:///modules/panorama/MailSearchAttachments.sys.mjs";
import { copyMailSearchMimeEvidence } from "resource:///modules/panorama/MailSearchMimeTypes.sys.mjs";
import {
  makeMatchExpression,
  parseSearchTerms,
} from "resource:///modules/panorama/SearchTerms.sys.mjs";

/**
 * @typedef {object} SearchDocument
 * @property {string} id - Stable physical document identity, not Message-ID.
 * @property {number} generation - Authoritative message generation.
 * @property {string} contentRevision - Authoritative semantic source revision.
 * @property {string} [textRevision] - Assigned by the index to the stored text.
 * @property {number} [policyRevision=0] - Revision of the indexing policy.
 * @property {string} subject - Decoded subject.
 * @property {string} body - Searchable semantic text, including recovered text.
 * @property {boolean} [bodyIndexed=true] - Body text is indexed; false requires an empty body.
 * @property {string} attachmentNames - Decoded attachment filenames.
 * @property {?boolean} [attachmentPresence=null] - MIME-proven attachment presence; null is unknown.
 * @property {?{types: string[], complete: boolean}} [attachmentTypes=null] - Parsed MIME evidence; false coverage cannot prove absence.
 * @property {?{items: MailSearchAttachmentInfo[], complete: boolean}} [attachmentInfos=null] - Observed user attachments; hidden content leaves incomplete coverage.
 * @property {string} author - Decoded sender names and addresses.
 * @property {string} recipients - Decoded To/Cc/Bcc names and addresses.
 */

/**
 * @typedef {object} SearchDocumentState
 * @property {boolean} eligible - Current deletion, junk, exclusion and pref policy.
 * @property {number} generation - Current authoritative message generation.
 * @property {string} contentRevision - Current authoritative semantic source revision.
 * @property {number} [policyRevision=0] - Current indexing policy revision.
 * @property {?{folderId: number, messageKey: number}} location - Current location.
 * @property {boolean} originalContentAvailable - Original content can be read.
 * @property {?Error} [contentError] - Per-message body read/close error, not a core read failure.
 */

/**
 * @typedef {object} SearchHit
 * @property {string} id - Stable physical document identity.
 * @property {number} generation - Indexed generation, checked against current state.
 * @property {string} contentRevision - Authoritative semantic source revision.
 * @property {string} textRevision - Exact stored text used for the offsets.
 * @property {number} policyRevision - Indexed policy revision, checked at lookup.
 * @property {string} offsetsUtf8 - FTS3 column/term/byte-offset/byte-length tuples.
 *   Columns are subject, body, attachmentNames, author and recipients.
 * @property {?{folderId: number, messageKey: number}} location - Location snapshot.
 * @property {boolean} originalContentAvailable - Original content is readable.
 * @property {boolean} bodyIndexed - Body text was indexed, even if recovered.
 */

/**
 * @typedef {object} SearchIndexJob
 * @property {string} id - Stable physical document identity.
 * @property {number} generation - Required message generation.
 * @property {number} policyRevision - Required indexing policy revision.
 * @property {number} sequence - Source change that scheduled this work.
 */

/**
 * Accepts only integers that storage and JavaScript can round-trip exactly.
 *
 * @param {number} value - Revision or source sequence.
 * @returns {boolean} Whether the value is a nonnegative safe integer.
 */
function isRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Decodes nullable SQLite attachment evidence without hiding invalid storage.
 *
 * @param {?number} value - Stored zero, one or null.
 * @returns {?boolean} Known presence, or null for missing evidence.
 * @throws {Error} For an invalid stored value.
 */
function decodeAttachmentPresence(value) {
  if (value !== null && value !== 0 && value !== 1) {
    throw new Error("Invalid stored attachment presence");
  }
  return value === null ? null : !!value;
}

/**
 * Decodes stored MIME evidence without converting malformed storage to unknown.
 *
 * @param {?string} value - JSON evidence or SQL NULL.
 * @returns {?{types: string[], complete: boolean}} Validated observed MIME types.
 */
function decodeMimeEvidence(value) {
  return value === null ? null : copyMailSearchMimeEvidence(JSON.parse(value));
}

/**
 * Decodes attachment details without hiding malformed stored JSON or fields.
 *
 * @param {?string} value - Stored JSON or SQL NULL.
 * @returns {?{items: MailSearchAttachmentInfo[], complete: boolean}} Observed details.
 */
function decodeAttachmentInfos(value) {
  return value === null
    ? null
    : copyMailSearchAttachmentInfos(JSON.parse(value));
}

/**
 * Copies and validates semantic text before asynchronous work begins.
 *
 * @param {SearchDocument} document - Caller-supplied text.
 * @returns {SearchDocument} An independent document.
 */
function copyDocument(document) {
  const copy = {};
  for (const name of [
    "id",
    "contentRevision",
    "subject",
    "body",
    "attachmentNames",
    "author",
    "recipients",
  ]) {
    if (typeof document[name] != "string") {
      throw new TypeError("Expected document string: " + name);
    }
    copy[name] = document[name];
  }
  copy.generation = document.generation;
  copy.policyRevision = document.policyRevision ?? 0;
  copy.bodyIndexed = document.bodyIndexed ?? true;
  copy.attachmentPresence = document.attachmentPresence ?? null;
  copy.attachmentTypes = copyMailSearchMimeEvidence(document.attachmentTypes);
  copy.attachmentInfos = copyMailSearchAttachmentInfos(
    document.attachmentInfos
  );
  if (
    copy.attachmentPresence !== null &&
    typeof copy.attachmentPresence != "boolean"
  ) {
    throw new TypeError("Invalid attachment presence");
  }
  if (
    typeof copy.bodyIndexed != "boolean" ||
    (!copy.bodyIndexed && copy.body)
  ) {
    throw new TypeError("Invalid document body readiness");
  }
  if (
    !copy.id ||
    !copy.contentRevision ||
    !isRevision(copy.generation) ||
    !isRevision(copy.policyRevision)
  ) {
    throw new TypeError("Invalid document identity or revision");
  }
  return copy;
}

/**
 * Copies a durable job token before it is queued.
 *
 * @param {SearchIndexJob} job - Previously returned pending work.
 * @returns {SearchIndexJob} An independent token.
 */
function copyJob({ id, generation, policyRevision, sequence }) {
  if (
    typeof id != "string" ||
    !id ||
    !isRevision(generation) ||
    !isRevision(policyRevision) ||
    !isRevision(sequence)
  ) {
    throw new TypeError("Invalid search job");
  }
  return { id, generation, policyRevision, sequence };
}

/**
 * Compares indexed text with current policy and message revisions.
 *
 * @param {?SearchDocumentState} state - Authoritative current state.
 * @param {SearchDocument} document - Indexed or supplied text.
 * @returns {boolean} Whether the text is currently eligible.
 */
function matchesState(state, document) {
  return (
    state?.eligible === true &&
    state.generation == document.generation &&
    state.contentRevision == document.contentRevision &&
    (state.policyRevision ?? 0) == document.policyRevision
  );
}

// A superseded document remains stored for recovery, but cannot match queries.
const CURRENT_VERSION =
  "(v.documentId IS NULL OR (v.kind='index' AND " +
  "v.generation=d.generation AND v.policyRevision=d.policyRevision " +
  "AND v.sequence=d.changeSequence))";

// During a name refresh, unvisited rows must not match obsolete card names.
const CURRENT_PROJECTION =
  CURRENT_VERSION +
  " AND d.projectionReady=1" +
  " AND ((SELECT addressBookAfterId FROM work_state) IS NULL OR " +
  "d.id <= (SELECT addressBookAfterId FROM work_state))";

/**
 * Rejects delivery on abort without abandoning the underlying operation.
 *
 * @template T
 * @param {Promise<T>} promise - Operation whose completion remains observed.
 * @param {AbortSignal} [signal] - Cancellation signal.
 * @returns {Promise<T>} The operation result; rejects on abort.
 */
async function withAbort(promise, signal) {
  if (!signal) {
    return promise;
  }
  let abort;
  const cancelled = new Promise((resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/**
 * Stores semantic text and its disposable FTS3 index in a separate database.
 * Callers supply authoritative policy/location resolution. This class does not
 * subscribe to core changes or own message bodies. Resolver callbacks must not
 * call into this same index: operations run on a serialized connection.
 */
export class PanoramaSearchIndex {
  #connection;
  #resolveDocument;
  #tail = Promise.resolve();
  #closed = false;
  #cursors = new WeakMap();

  /**
   * Opens an index and registers the existing native mozporter tokenizer.
   *
   * @param {nsIFile} file - Search sidecar database, never the core database.
   * @param {function(string, AbortSignal=): Promise<?SearchDocumentState>} resolveDocument -
   *   Resolve current eligibility, revisions and location; null means deleted.
   * @returns {Promise<PanoramaSearchIndex>} The initialized index.
   */
  static async open(file, resolveDocument) {
    if (typeof resolveDocument != "function") {
      throw new TypeError("An authoritative document resolver is required");
    }
    const connection = Services.storage.openUnsharedDatabase(file);
    const index = new PanoramaSearchIndex(connection, resolveDocument);
    try {
      Cc["@mozilla.org/messenger/fts3tokenizer;1"]
        .getService(Ci.nsIFts3Tokenizer)
        .registerTokenizer(connection);
      if (connection.schemaVersion > 8) {
        throw new Error("Unsupported search index schema");
      }
      await index.#transaction(async () => {
        await index.#execute(
          "CREATE TABLE IF NOT EXISTS documents (" +
            "id INTEGER PRIMARY KEY, documentId TEXT UNIQUE NOT NULL, " +
            "generation INTEGER NOT NULL, contentRevision TEXT NOT NULL, textRevision TEXT NOT NULL, " +
            "policyRevision INTEGER NOT NULL DEFAULT 0, changeSequence INTEGER NOT NULL DEFAULT 0, " +
            "bodyIndexed INTEGER NOT NULL DEFAULT 1, " +
            "subject TEXT NOT NULL, body TEXT NOT NULL, attachmentNames TEXT NOT NULL, attachmentPresence INTEGER, " +
            "author TEXT NOT NULL, " +
            "recipients TEXT NOT NULL)"
        );
        await index.#execute(
          "CREATE VIRTUAL TABLE IF NOT EXISTS search_text " +
            "USING fts3(tokenize mozporter, subject, body, attachmentNames, author, recipients)"
        );
        await index.#execute(
          "CREATE TABLE IF NOT EXISTS index_state (revision INTEGER NOT NULL)"
        );
        await index.#execute(
          "INSERT INTO index_state SELECT 0 WHERE NOT EXISTS " +
            "(SELECT 1 FROM index_state)"
        );
        if (connection.schemaVersion == 1) {
          await index.#execute(
            "ALTER TABLE documents ADD COLUMN policyRevision INTEGER NOT NULL DEFAULT 0"
          );
          await index.#execute(
            "ALTER TABLE documents ADD COLUMN changeSequence INTEGER NOT NULL DEFAULT 0"
          );
          await index.#execute(
            "ALTER TABLE documents ADD COLUMN bodyIndexed INTEGER NOT NULL DEFAULT 1"
          );
          await index.#execute(
            "ALTER TABLE documents ADD COLUMN textRevision TEXT NOT NULL DEFAULT ''"
          );
          await index.#execute(
            "UPDATE documents SET textRevision=lower(hex(randomblob(16)))"
          );
        }
        await index.#execute(
          "CREATE TABLE IF NOT EXISTS document_versions (" +
            "documentId TEXT PRIMARY KEY, generation INTEGER NOT NULL, " +
            "policyRevision INTEGER NOT NULL, sequence INTEGER NOT NULL, kind TEXT NOT NULL)"
        );
        await index.#execute(
          "CREATE TABLE IF NOT EXISTS retained_bodies (" +
            "documentId TEXT PRIMARY KEY, generation INTEGER NOT NULL, " +
            "policyRevision INTEGER NOT NULL, contentRevision TEXT NOT NULL, " +
            "body TEXT NOT NULL, attachmentNames TEXT NOT NULL, attachmentPresence INTEGER)"
        );
        await index.#execute(
          "CREATE TABLE IF NOT EXISTS index_jobs (" +
            "documentId TEXT PRIMARY KEY, generation INTEGER NOT NULL, " +
            "policyRevision INTEGER NOT NULL, sequence INTEGER NOT NULL, " +
            "status TEXT NOT NULL)"
        );
        await index.#execute(
          "CREATE INDEX IF NOT EXISTS index_jobs_status_sequence ON index_jobs(status,sequence)"
        );
        await index.#execute(
          "CREATE TABLE IF NOT EXISTS work_state (sourceId TEXT, checkpoint INTEGER NOT NULL, " +
            "rescanSequence INTEGER, rescanAfterKey INTEGER NOT NULL DEFAULT 0, policyFingerprint TEXT)"
        );
        await index.#execute(
          "INSERT INTO work_state(sourceId,checkpoint,rescanSequence,rescanAfterKey,policyFingerprint) SELECT NULL,0,NULL,0,NULL WHERE NOT EXISTS (SELECT 1 FROM work_state)"
        );
        for (const table of ["documents", "retained_bodies"]) {
          const columns = await index.#execute(
            "PRAGMA table_info(" + table + ")",
            {},
            ["name"]
          );
          if (!columns.some(column => column.name == "attachmentInfos")) {
            await index.#execute(
              "ALTER TABLE " + table + " ADD COLUMN attachmentInfos TEXT"
            );
          }
          if (!columns.some(column => column.name == "attachmentTypes")) {
            await index.#execute(
              "ALTER TABLE " + table + " ADD COLUMN attachmentTypes TEXT"
            );
          }
          if (!columns.some(column => column.name == "attachmentPresence")) {
            await index.#execute(
              "ALTER TABLE " + table + " ADD COLUMN attachmentPresence INTEGER"
            );
          }
        }
        const documentColumns = await index.#execute(
          "PRAGMA table_info(documents)",
          {},
          ["name"]
        );
        if (!documentColumns.some(column => column.name == "projectionReady")) {
          await index.#execute(
            "ALTER TABLE documents ADD COLUMN projectionReady INTEGER NOT NULL DEFAULT 1"
          );
        }
        const workColumns = await index.#execute(
          "PRAGMA table_info(work_state)",
          {},
          ["name"]
        );
        for (const column of ["addressBookVersion", "addressBookAfterId"]) {
          if (!workColumns.some(field => field.name == column)) {
            await index.#execute(
              "ALTER TABLE work_state ADD COLUMN " + column + " INTEGER"
            );
          }
        }
        await index.#execute(
          "CREATE TABLE IF NOT EXISTS recovery_records (" +
            "recordId TEXT PRIMARY KEY,documentId TEXT,kind TEXT NOT NULL," +
            "sourceRevision TEXT NOT NULL,payload TEXT,document TEXT,erased INTEGER NOT NULL DEFAULT 0)"
        );
        await index.#execute(
          "CREATE TABLE IF NOT EXISTS recovery_erased (documentId TEXT PRIMARY KEY)"
        );
        await index.#execute(
          "CREATE TABLE IF NOT EXISTS recovery_policy (" +
            "documentId TEXT PRIMARY KEY,policyRevision INTEGER NOT NULL," +
            "suppressed INTEGER NOT NULL DEFAULT 0)"
        );
        await index.#execute("PRAGMA user_version = 8");
      });
      return index;
    } catch (error) {
      try {
        await index.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "Search initialization and close failed"
        );
      }
      throw error;
    }
  }

  /**
   * @param {mozIStorageConnection} connection - Owned sidecar connection.
   * @param {function(string, AbortSignal=): Promise<?SearchDocumentState>} resolveDocument -
   *   Authoritative current-state lookup.
   */
  constructor(connection, resolveDocument) {
    this.#connection = connection;
    this.#resolveDocument = resolveDocument;
  }

  /**
   * Serializes operations so a query cannot see an incomplete index write.
   *
   * @param {function(): Promise} operation - Work on the owned connection.
   * @returns {Promise} The operation result.
   */
  #enqueue(operation) {
    if (this.#closed) {
      return Promise.reject(new Error("Search index is closed"));
    }
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }

  /**
   * Executes one native asynchronous statement and cancels it on abort.
   *
   * @param {string} sql - SQL with named parameters.
   * @param {Record<string, string|number|null|Uint8Array>} [params={}] - Bound values.
   * @param {string[]} [columns=[]] - Result columns to copy before finalization.
   * @param {AbortSignal} [signal] - Statement cancellation.
   * @returns {Promise<Array<Record<string, string|number>>>} Copied result rows.
   */
  #execute(sql, params = {}, columns = [], signal) {
    signal?.throwIfAborted();
    const statement = this.#connection.createAsyncStatement(sql);
    try {
      for (const [name, value] of Object.entries(params)) {
        if (value instanceof Uint8Array) {
          statement.bindBlobByName(name, value);
        } else {
          statement.params[name] = value;
        }
      }
    } catch (error) {
      statement.finalize();
      throw error;
    }
    return new Promise((resolve, reject) => {
      const rows = [];
      let failure;
      let pending;
      const abort = () => pending.cancel();
      try {
        pending = statement.executeAsync({
          handleResult(result) {
            try {
              let row;
              while ((row = result.getNextRow())) {
                rows.push(
                  Object.fromEntries(
                    columns.map(name => [name, row.getResultByName(name)])
                  )
                );
              }
            } catch (error) {
              failure = error;
              pending.cancel();
            }
          },
          handleError(error) {
            failure = error;
          },
          handleCompletion(reason) {
            signal?.removeEventListener("abort", abort);
            statement.finalize();
            if (signal?.aborted) {
              reject(signal.reason);
            } else if (failure) {
              reject(new Error(failure.message, { cause: failure }));
            } else if (
              reason != Ci.mozIStorageStatementCallback.REASON_FINISHED
            ) {
              reject(new Error("Search statement did not complete"));
            } else {
              resolve(rows);
            }
          },
        });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
        }
      } catch (error) {
        signal?.removeEventListener("abort", abort);
        statement.finalize();
        reject(error);
      }
    });
  }

  /**
   * Commits sidecar changes together; core/body storage is not part of it.
   *
   * @param {function(): Promise} operation - Transaction work.
   * @returns {Promise} The committed operation result.
   */
  async #transaction(operation) {
    await this.#execute("BEGIN");
    try {
      const result = await operation();
      await this.#execute("COMMIT");
      return result;
    } catch (error) {
      try {
        await this.#execute("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Search rollback failed"
        );
      }
      throw error;
    }
  }

  /**
   * Replaces one physical document if its generation/revision is still current.
   *
   * @param {SearchDocument} document - Decoded, policy-approved semantic text.
   * @returns {Promise<boolean>} False for stale or currently ineligible work.
   */
  index(document) {
    document = copyDocument(document);
    return this.#enqueue(async () => {
      const version = await this.#getVersion(document.id);
      if (
        !matchesState(await this.#resolveDocument(document.id), document) ||
        (version &&
          (version.kind != "index" ||
            version.generation != document.generation ||
            version.policyRevision != document.policyRevision))
      ) {
        return false;
      }
      return this.#transaction(async () => {
        await this.#storeDocument(document, version?.sequence ?? 0);
        return true;
      });
    });
  }

  /**
   * Reads the latest accepted change for one physical document.
   *
   * @param {string} id - Physical identity.
   * @returns {Promise<{generation: number, policyRevision: number,
   *   sequence: number, kind: string}|undefined>} Latest accepted version.
   */
  async #getVersion(id) {
    const [version] = await this.#execute(
      "SELECT generation,policyRevision,sequence,kind FROM document_versions WHERE documentId=:id",
      { id },
      ["generation", "policyRevision", "sequence", "kind"]
    );
    return version;
  }

  /**
   * Replaces canonical text and FTS inside the caller's sidecar transaction.
   *
   * @param {SearchDocument} document - Validated current text.
   * @param {number} sequence - Accepted source sequence, or zero for direct writes.
   * @returns {Promise<boolean>} Whether the committed projection has body text.
   */
  async #storeDocument(document, sequence) {
    if (!document.bodyIndexed) {
      const bodies = await this.#execute(
        "SELECT generation,policyRevision,contentRevision,body,attachmentNames,attachmentPresence,attachmentTypes,attachmentInfos " +
          "FROM documents WHERE documentId=:id AND bodyIndexed=1 UNION ALL " +
          "SELECT generation,policyRevision,contentRevision,body,attachmentNames,attachmentPresence,attachmentTypes,attachmentInfos " +
          "FROM retained_bodies WHERE documentId=:id",
        { id: document.id },
        [
          "generation",
          "policyRevision",
          "contentRevision",
          "body",
          "attachmentNames",
          "attachmentPresence",
          "attachmentTypes",
          "attachmentInfos",
        ]
      );
      const retained = bodies.find(
        body =>
          body.generation == document.generation &&
          body.policyRevision == document.policyRevision &&
          body.contentRevision == document.contentRevision
      );
      if (retained) {
        document = {
          ...document,
          body: retained.body,
          attachmentNames: retained.attachmentNames,
          attachmentPresence: decodeAttachmentPresence(
            retained.attachmentPresence
          ),
          attachmentTypes: decodeMimeEvidence(retained.attachmentTypes),
          attachmentInfos: decodeAttachmentInfos(retained.attachmentInfos),
          bodyIndexed: true,
        };
      } else {
        // A metadata refresh must not erase the last usable semantic body.
        await this.#execute(
          "INSERT INTO retained_bodies(documentId,generation,policyRevision,contentRevision,body,attachmentNames,attachmentPresence,attachmentTypes,attachmentInfos) " +
            "SELECT documentId,generation,policyRevision,contentRevision,body,attachmentNames,attachmentPresence,attachmentTypes,attachmentInfos " +
            "FROM documents WHERE documentId=:id AND bodyIndexed=1 " +
            "ON CONFLICT(documentId) DO UPDATE SET generation=excluded.generation," +
            "policyRevision=excluded.policyRevision,contentRevision=excluded.contentRevision," +
            "body=excluded.body,attachmentNames=excluded.attachmentNames,attachmentPresence=excluded.attachmentPresence,attachmentTypes=excluded.attachmentTypes,attachmentInfos=excluded.attachmentInfos",
          { id: document.id }
        );
      }
    }
    // String variants bind as UTF-16, whose initial U+FEFF SQLite consumes as
    // an encoding marker. Bind semantic UTF-8 bytes and cast to TEXT so exact
    // leading BOMs, embedded NULs and the corresponding FTS offsets survive.
    // Keep empty strings as strings: the native zero-length blob binds NULL.
    const encoder = new TextEncoder();
    await this.#execute(
      "INSERT INTO documents " +
        "(documentId,generation,policyRevision,changeSequence,bodyIndexed,contentRevision,textRevision,subject,body,attachmentNames,attachmentPresence,attachmentTypes,attachmentInfos,author,recipients) " +
        "VALUES(:id,:generation,:policyRevision,:sequence,:bodyIndexed,:contentRevision,:textRevision,CAST(:subject AS TEXT),CAST(:body AS TEXT),CAST(:attachmentNames AS TEXT),:attachmentPresence,:attachmentTypes,:attachmentInfos,CAST(:author AS TEXT),CAST(:recipients AS TEXT)) " +
        "ON CONFLICT(documentId) DO UPDATE SET " +
        "generation=excluded.generation,policyRevision=excluded.policyRevision,changeSequence=excluded.changeSequence," +
        "projectionReady=1,bodyIndexed=excluded.bodyIndexed,contentRevision=excluded.contentRevision,textRevision=excluded.textRevision," +
        "subject=excluded.subject,body=excluded.body," +
        "attachmentNames=excluded.attachmentNames,attachmentPresence=excluded.attachmentPresence,attachmentTypes=excluded.attachmentTypes,attachmentInfos=excluded.attachmentInfos,author=excluded.author,recipients=excluded.recipients",
      {
        ...document,
        subject: document.subject ? encoder.encode(document.subject) : "",
        body: document.body ? encoder.encode(document.body) : "",
        attachmentNames: document.attachmentNames
          ? encoder.encode(document.attachmentNames)
          : "",
        author: document.author ? encoder.encode(document.author) : "",
        recipients: document.recipients
          ? encoder.encode(document.recipients)
          : "",
        textRevision: Services.uuid.generateUUID().toString(),
        bodyIndexed: Number(document.bodyIndexed),
        attachmentPresence:
          document.attachmentPresence === null
            ? null
            : Number(document.attachmentPresence),
        attachmentTypes:
          document.attachmentTypes === null
            ? null
            : JSON.stringify(document.attachmentTypes),
        attachmentInfos:
          document.attachmentInfos === null
            ? null
            : JSON.stringify(document.attachmentInfos),
        sequence,
      }
    );
    await this.#erase(document.id, false);
    await this.#execute(
      "INSERT INTO search_text(docid,subject,body,attachmentNames,author,recipients) " +
        "SELECT id,subject,body,attachmentNames,author,recipients FROM documents WHERE documentId=:id",
      { id: document.id }
    );
    if (document.bodyIndexed) {
      await this.#execute("DELETE FROM retained_bodies WHERE documentId=:id", {
        id: document.id,
      });
    }
    await this.#execute("UPDATE index_state SET revision=revision+1");
    return document.bodyIndexed;
  }

  /**
   * Removes FTS rows and optionally canonical text in an existing transaction.
   *
   * @param {string} id - Physical identity.
   * @param {boolean} eraseText - Also remove retained semantic text.
   */
  async #erase(id, eraseText) {
    await this.#execute(
      "DELETE FROM search_text WHERE docid=(SELECT id FROM documents WHERE documentId=:id)",
      { id }
    );
    if (eraseText) {
      await this.#execute(
        "INSERT INTO recovery_erased(documentId) VALUES(:id) ON CONFLICT DO NOTHING",
        { id }
      );
      await this.#execute(
        "UPDATE recovery_records SET payload=NULL,document=NULL,erased=1 WHERE documentId=:id",
        { id }
      );
      await this.#execute("DELETE FROM documents WHERE documentId=:id", { id });
      await this.#execute("DELETE FROM retained_bodies WHERE documentId=:id", {
        id,
      });
    }
  }

  /**
   * Persists one complete, ordered page from a replayable source.
   * The checkpoint records accepted work, not completed indexing. Core changes
   * and body storage are outside this transaction. Overlapping pages are safe.
   *
   * @param {object} page - Complete source interval (from, through].
   * @param {string} page.sourceId - Durable source identity; cannot change in place.
   * @param {number} page.from - Exclusive source checkpoint.
   * @param {number} page.through - Inclusive source checkpoint.
   * @param {Array<SearchIndexJob & {kind: "index"|"delete"|"exclude"}>} page.changes -
   *   Changes in strictly increasing source sequence order.
   * @returns {Promise<void>} Resolves after work and checkpoint commit together.
   * @throws {TypeError} For invalid identities, revisions or page ordering.
   */
  applyChanges({ sourceId, from, through, changes }) {
    if (
      typeof sourceId != "string" ||
      !sourceId ||
      !isRevision(from) ||
      !isRevision(through) ||
      through < from ||
      !Array.isArray(changes)
    ) {
      throw new TypeError("Invalid search change page");
    }
    let previous = from;
    changes = changes.map(change => {
      const { id, generation, sequence, kind, policyRevision } = change;
      if (
        typeof id != "string" ||
        !id ||
        !isRevision(generation) ||
        !isRevision(policyRevision) ||
        !isRevision(sequence) ||
        sequence <= previous ||
        sequence > through ||
        !["index", "delete", "exclude"].includes(kind)
      ) {
        throw new TypeError("Invalid or unordered search change");
      }
      previous = sequence;
      return { id, generation, policyRevision, sequence, kind };
    });
    return this.#enqueue(() =>
      this.#transaction(async () => {
        const [work] = await this.#execute(
          "SELECT sourceId,checkpoint,rescanSequence FROM work_state",
          {},
          ["sourceId", "checkpoint", "rescanSequence"]
        );
        if (work.sourceId && work.sourceId != sourceId) {
          throw new Error("Search change source changed");
        }
        if (from > work.checkpoint) {
          throw new Error("Search change page has a gap");
        }
        if (work.rescanSequence !== null && through > work.checkpoint) {
          throw new Error("Search policy rescan is unfinished");
        }
        for (const change of changes) {
          if (change.sequence <= work.checkpoint) {
            continue;
          }
          await this.#queueChange(change);
        }
        await this.#execute(
          "UPDATE work_state SET sourceId=:sourceId,checkpoint=:checkpoint",
          { sourceId, checkpoint: Math.max(work.checkpoint, through) }
        );
        if (through > work.checkpoint) {
          await this.#execute("UPDATE index_state SET revision=revision+1");
        }
      })
    );
  }

  /**
   * Queues a newer physical change within the caller's sidecar transaction.
   *
   * @param {SearchIndexJob & {kind: string}} change - Validated work.
   */
  async #queueChange(change) {
    const version = await this.#getVersion(change.id);
    if (version && change.sequence <= version.sequence) {
      return;
    }
    if (version && change.kind == "delete") {
      change.policyRevision = Math.max(
        change.policyRevision,
        version.policyRevision
      );
    }
    if (
      version &&
      (change.generation < version.generation ||
        change.policyRevision < version.policyRevision)
    ) {
      throw new Error("Search change revisions went backwards");
    }
    await this.#execute(
      "INSERT INTO document_versions(documentId,generation,policyRevision,sequence,kind) " +
        "VALUES(:id,:generation,:policyRevision,:sequence,:kind) " +
        "ON CONFLICT(documentId) DO UPDATE SET generation=excluded.generation," +
        "policyRevision=excluded.policyRevision,sequence=excluded.sequence,kind=excluded.kind",
      change
    );
    // Version checks hide stale rows until refresh. Keep index-change FTS text
    // so a flag-only projection can advance without tokenizing the body again.
    if (change.kind != "index") {
      // Consuming an exclusion revokes backup reuse even after policy is restored.
      // Keep the original recovery record and receipt unchanged.
      await this.#execute(
        "INSERT INTO recovery_policy(documentId,policyRevision,suppressed) " +
          "VALUES(:id,:policyRevision,1) ON CONFLICT(documentId) " +
          "DO UPDATE SET suppressed=1",
        { id: change.id, policyRevision: change.policyRevision }
      );
      await this.#erase(change.id, change.kind == "delete");
    }
    await this.#execute("DELETE FROM index_jobs WHERE documentId=:id", {
      id: change.id,
    });
    if (change.kind == "index") {
      await this.#execute(
        "INSERT INTO index_jobs(documentId,generation,policyRevision,sequence,status) " +
          "VALUES(:id,:generation,:policyRevision,:sequence,'pending')",
        {
          id: change.id,
          generation: change.generation,
          policyRevision: change.policyRevision,
          sequence: change.sequence,
        }
      );
    }
  }

  /**
   * Records a core global-policy marker without acknowledging it yet.
   *
   * @param {string} sourceId - Core incarnation bound to this sidecar.
   * @param {number} sequence - Unacknowledged native policy marker.
   * @returns {Promise<void>} Resolves after the rescan cursor is durable.
   */
  beginRescan(sourceId, sequence) {
    if (typeof sourceId != "string" || !sourceId || !isRevision(sequence)) {
      throw new TypeError("Invalid search rescan");
    }
    return this.#enqueue(() =>
      this.#transaction(async () => {
        const [work] = await this.#execute(
          "SELECT sourceId,checkpoint,rescanSequence FROM work_state",
          {},
          ["sourceId", "checkpoint", "rescanSequence"]
        );
        if (work.sourceId != sourceId || sequence <= work.checkpoint) {
          throw new Error(
            "Search rescan does not follow the source checkpoint"
          );
        }
        if (work.rescanSequence !== null) {
          if (work.rescanSequence != sequence) {
            throw new Error("Another search rescan is unfinished");
          }
          return;
        }
        await this.#execute(
          "UPDATE work_state SET rescanSequence=:sequence,rescanAfterKey=0",
          { sequence }
        );
      })
    );
  }

  /**
   * Returns the durable native snapshot cursor for a pending policy rescan.
   *
   * @returns {Promise<?{sequence: number, afterKey: number}>} Cursor, or null.
   */
  getRescan() {
    return this.#enqueue(async () => {
      const [row] = await this.#execute(
        "SELECT rescanSequence AS sequence,rescanAfterKey AS afterKey FROM work_state",
        {},
        ["sequence", "afterKey"]
      );
      return row.sequence === null ? null : row;
    });
  }

  /**
   * Persists one native snapshot page and its resume key together.
   * The policy marker is acknowledged only after an empty final page.
   *
   * @param {object} page - Native rescan page.
   * @param {number} page.sequence - Policy marker being scanned.
   * @param {number} page.afterKey - Cursor before this page.
   * @param {number} page.nextKey - Cursor after this page.
   * @param {SearchIndexJob[]} page.changes - Index/exclude work with this sequence.
   * @param {boolean} [page.done=false] - Empty final native page.
   * @returns {Promise<void>} Resolves after work and resume cursor commit.
   */
  applyRescanPage({ sequence, afterKey, nextKey, changes, done = false }) {
    if (
      !Array.isArray(changes) ||
      typeof done != "boolean" ||
      !isRevision(sequence) ||
      !isRevision(afterKey) ||
      !isRevision(nextKey) ||
      nextKey < afterKey ||
      (done ? nextKey != afterKey || changes.length : nextKey == afterKey)
    ) {
      throw new TypeError("Invalid search rescan page");
    }
    const ids = new Set();
    changes = changes.map(change => {
      const job = copyJob(change);
      if (
        job.sequence != sequence ||
        !["index", "exclude"].includes(change.kind) ||
        ids.has(job.id)
      ) {
        throw new TypeError("Invalid search rescan work");
      }
      ids.add(job.id);
      return { ...job, kind: change.kind };
    });
    return this.#enqueue(() =>
      this.#transaction(async () => {
        const [work] = await this.#execute(
          "SELECT rescanSequence,rescanAfterKey FROM work_state",
          {},
          ["rescanSequence", "rescanAfterKey"]
        );
        if (
          work.rescanSequence != sequence ||
          work.rescanAfterKey != afterKey
        ) {
          throw new Error("Search rescan cursor changed");
        }
        for (const change of changes) {
          await this.#queueChange(change);
          if (change.kind == "index") {
            // Only the bounded authoritative eligibility rescan can advance a
            // recovery authorization. A stale page or consumed exclusion cannot.
            await this.#execute(
              "UPDATE recovery_policy SET policyRevision=:policyRevision " +
                "WHERE documentId=:id AND suppressed=0 AND EXISTS(" +
                "SELECT 1 FROM document_versions WHERE documentId=:id " +
                "AND sequence=:sequence AND generation=:generation " +
                "AND policyRevision=:policyRevision AND kind='index')",
              {
                id: change.id,
                sequence: change.sequence,
                generation: change.generation,
                policyRevision: change.policyRevision,
              }
            );
          }
        }
        await this.#execute(
          done
            ? "UPDATE work_state SET checkpoint=:sequence,rescanSequence=NULL,rescanAfterKey=0"
            : "UPDATE work_state SET rescanAfterKey=:nextKey",
          done ? { sequence } : { nextKey }
        );
        await this.#execute("UPDATE index_state SET revision=revision+1");
      })
    );
  }

  /**
   * Returns a bounded batch of durable work in source order.
   *
   * @param {number} [limit=20] - Maximum jobs, from 1 to 500.
   * @returns {Promise<SearchIndexJob[]>} Jobs remain pending until completion.
   */
  getPendingJobs(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError("Search batch size must be from 1 to 500");
    }
    return this.#enqueue(() =>
      this.#execute(
        "SELECT documentId AS id,generation,policyRevision,sequence FROM index_jobs " +
          "WHERE status='pending' ORDER BY sequence,documentId LIMIT :limit",
        { limit },
        ["id", "generation", "policyRevision", "sequence"]
      )
    );
  }

  /**
   * Checks whether a job token still names unfinished work.
   *
   * @param {SearchIndexJob} job - Validated token.
   * @param {AbortSignal} [signal] - Cancel the pending-job lookup.
   * @returns {Promise<boolean>} Whether this exact job remains.
   */
  async #hasJob(job, signal) {
    const [pending] = await this.#execute(
      "SELECT 1 AS found FROM index_jobs WHERE documentId=:id AND generation=:generation " +
        "AND policyRevision=:policyRevision AND sequence=:sequence",
      job,
      ["found"],
      signal
    );
    return !!pending;
  }

  /**
   * Resolves eligibility before a worker reads message content.
   * Completion validates the state again after loading.
   *
   * @param {SearchIndexJob} job - Previously returned pending work.
   * @param {AbortSignal} [signal] - Cancel lookup and delivery.
   * @returns {Promise<?SearchDocumentState>} Current state, or null for stale work.
   */
  getJobState(job, signal) {
    job = copyJob(job);
    return withAbort(
      this.#enqueue(async () => {
        signal?.throwIfAborted();
        if (!(await this.#hasJob(job, signal))) {
          return null;
        }
        const state = await withAbort(
          this.#resolveDocument(job.id, signal),
          signal
        );
        signal?.throwIfAborted();
        return state?.eligible === true &&
          state.generation == job.generation &&
          (state.policyRevision ?? 0) == job.policyRevision
          ? state
          : null;
      }),
      signal
    );
  }

  /**
   * Refreshes a pending mail projection without reopening unchanged MIME.
   * Only canonical indexed bodies qualify. Native contentRevision must cover
   * every body/charset/header mutation; current eligibility and the exact job
   * are checked again before commit. Retained-body recovery keeps its stricter
   * generation guard. This does not reuse a body after a content change.
   *
   * @param {SearchIndexJob} job - Current pending work token.
   * @param {SearchDocument} metadata - Current metadata with an empty body.
   * @param {AbortSignal} [signal] - Cancel before committing the projection.
   * @returns {Promise<boolean>} Whether the job completed without loading MIME.
   */
  refreshJob(job, metadata, signal) {
    job = copyJob(job);
    metadata = copyDocument(metadata);
    if (
      metadata.bodyIndexed ||
      metadata.id != job.id ||
      metadata.generation != job.generation ||
      metadata.policyRevision != job.policyRevision
    ) {
      throw new TypeError("Metadata does not match its search job");
    }
    return this.#enqueue(async () => {
      signal?.throwIfAborted();
      if (!(await this.#hasJob(job, signal))) {
        return false;
      }
      const [body] = await this.#execute(
        "SELECT contentRevision,body,attachmentNames,attachmentPresence,attachmentTypes,attachmentInfos,subject,author,recipients," +
          "EXISTS(SELECT 1 FROM search_text WHERE docid=documents.id) AS hasFts FROM documents " +
          "WHERE documentId=:id AND bodyIndexed=1",
        { id: job.id },
        [
          "contentRevision",
          "body",
          "attachmentNames",
          "attachmentPresence",
          "attachmentTypes",
          "attachmentInfos",
          "subject",
          "author",
          "recipients",
          "hasFts",
        ],
        signal
      );
      if (!body || body.contentRevision != metadata.contentRevision) {
        return false;
      }
      const recovered = await this.#execute(
        "SELECT document FROM recovery_records WHERE documentId=:id AND kind='mail' " +
          "AND erased=0 AND document IS NOT NULL",
        { id: job.id },
        ["document"],
        signal
      );
      // Recovery needs its captured policy or an explicit eligible rescan.
      // Never turn a consumed exclusion into fresh MIME evidence.
      const policy = recovered.length
        ? await this.#getRecoveryPolicy(job.id, signal)
        : null;
      if (
        recovered.some(row => {
          const source = copyDocument(JSON.parse(row.document));
          return (
            source.contentRevision === body.contentRevision &&
            source.body === body.body &&
            (policy?.suppressed ||
              (source.policyRevision !== metadata.policyRevision &&
                policy?.policyRevision !== metadata.policyRevision))
          );
        })
      ) {
        return false;
      }
      const document = {
        ...metadata,
        body: body.body,
        attachmentNames: body.attachmentNames,
        attachmentPresence: decodeAttachmentPresence(body.attachmentPresence),
        attachmentTypes: decodeMimeEvidence(body.attachmentTypes),
        attachmentInfos: decodeAttachmentInfos(body.attachmentInfos),
        bodyIndexed: true,
      };
      if (
        !matchesState(
          await withAbort(this.#resolveDocument(job.id, signal), signal),
          document
        )
      ) {
        return false;
      }
      signal?.throwIfAborted();
      return this.#transaction(async () => {
        if (
          body.hasFts &&
          ["subject", "author", "recipients"].every(
            field => body[field] === metadata[field]
          )
        ) {
          // Stored text and offsets are unchanged; only the native token moves.
          await this.#execute(
            "UPDATE documents SET projectionReady=1,generation=:generation,policyRevision=:policyRevision,changeSequence=:sequence WHERE documentId=:id",
            job
          );
          await this.#execute("UPDATE index_state SET revision=revision+1");
        } else {
          await this.#storeDocument(document, job.sequence);
        }
        await this.#execute(
          "DELETE FROM index_jobs WHERE documentId=:id AND sequence=:sequence",
          { id: job.id, sequence: job.sequence }
        );
        return true;
      });
    });
  }

  /**
   * Commits current text and acknowledges a completed body job.
   * A newer change, deletion or exclusion rejects an old completion.
   * Metadata-only text commits with the body job retained as unavailable.
   *
   * @param {SearchIndexJob} job - Previously returned pending job.
   * @param {SearchDocument} document - Text loaded for that job.
   * @param {AbortSignal} [signal] - Cancel before the sidecar transaction starts.
   * @returns {Promise<boolean>} Whether this job committed current text.
   */
  finishJob(job, document, signal) {
    document = copyDocument(document);
    job = copyJob(job);
    if (
      document.id != job.id ||
      document.generation != job.generation ||
      document.policyRevision != job.policyRevision
    ) {
      throw new TypeError("Search text does not match its job");
    }
    return this.#enqueue(async () => {
      signal?.throwIfAborted();
      const pending = await this.#hasJob(job, signal);
      if (
        !pending ||
        !matchesState(
          await withAbort(this.#resolveDocument(job.id, signal), signal),
          document
        )
      ) {
        return false;
      }
      signal?.throwIfAborted();
      return this.#transaction(async () => {
        const bodyIndexed = await this.#storeDocument(document, job.sequence);
        await this.#execute(
          bodyIndexed
            ? "DELETE FROM index_jobs WHERE documentId=:id AND sequence=:sequence"
            : "UPDATE index_jobs SET status='unavailable' WHERE documentId=:id AND sequence=:sequence",
          { id: job.id, sequence: job.sequence }
        );
        return true;
      });
    });
  }

  /**
   * Retains a job whose source content cannot currently be read.
   *
   * @param {SearchIndexJob} job - Exact attempted job.
   * @returns {Promise<void>} Resolves after the status is durable.
   */
  markUnavailable(job) {
    const { id, generation, policyRevision, sequence } = copyJob(job);
    return this.#enqueue(() =>
      this.#execute(
        "UPDATE index_jobs SET status='unavailable' WHERE documentId=:id " +
          "AND generation=:generation AND policyRevision=:policyRevision AND sequence=:sequence",
        { id, generation, policyRevision, sequence }
      )
    );
  }

  /**
   * Retries unavailable source content after a download or explicit rebuild.
   *
   * @param {object} [options] - Work controls.
   * @param {AbortSignal} [options.signal] - Cancel before/during the status write.
   * @returns {Promise<void>} Resolves after jobs become pending.
   */
  retryUnavailable({ signal } = {}) {
    return this.#enqueue(async () => {
      signal?.throwIfAborted();
      await this.#execute(
        "UPDATE index_jobs SET status='pending' WHERE status='unavailable'",
        {},
        [],
        signal
      );
    });
  }

  /**
   * Starts one durable header refresh for the latest address-book version.
   * No native policy revision changes. Repeated calls for the same version
   * leave the bounded cursor intact.
   *
   * @param {number} version - Current mail.displayname.version preference.
   * @returns {Promise<void>} Resolves after the version and cursor commit.
   */
  prepareAddressBook(version) {
    if (!Number.isSafeInteger(version)) {
      throw new TypeError("Invalid address-book version");
    }
    return this.#enqueue(() =>
      this.#transaction(async () => {
        const [work] = await this.#execute(
          "SELECT addressBookVersion FROM work_state",
          {},
          ["addressBookVersion"]
        );
        if (work.addressBookVersion !== version) {
          await this.#execute(
            "UPDATE work_state SET addressBookVersion=:version,addressBookAfterId=0",
            { version }
          );
          await this.#execute("UPDATE index_state SET revision=revision+1");
        }
      })
    );
  }

  /**
   * Queues one bounded page of existing projections for current card names.
   * Jobs keep their exact physical generation/policy/sequence. The projection
   * guard hides old names while a job is pending or unavailable. Unchanged
   * headers retain their FTS text. Newer native work is never overwritten.
   *
   * @param {number} [limit=20] - Maximum canonical rows, from 1 to 500.
   * @returns {Promise<boolean>} Whether another refresh page remains.
   */
  refreshAddressBook(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError("Search batch size must be from 1 to 500");
    }
    return this.#enqueue(() =>
      this.#transaction(async () => {
        const [work] = await this.#execute(
          "SELECT addressBookAfterId FROM work_state",
          {},
          ["addressBookAfterId"]
        );
        if (work.addressBookAfterId === null) {
          return false;
        }
        const rows = await this.#execute(
          "SELECT id,documentId,generation,policyRevision,changeSequence FROM documents " +
            "WHERE id>:after ORDER BY id LIMIT :limit",
          { after: work.addressBookAfterId, limit },
          ["id", "documentId", "generation", "policyRevision", "changeSequence"]
        );
        for (const row of rows) {
          const version = await this.#getVersion(row.documentId);
          if (
            !version ||
            version.kind != "index" ||
            version.generation != row.generation ||
            version.policyRevision != row.policyRevision ||
            version.sequence != row.changeSequence
          ) {
            continue;
          }
          await this.#execute(
            "UPDATE documents SET projectionReady=0 WHERE documentId=:id",
            { id: row.documentId }
          );
          await this.#execute(
            "INSERT INTO index_jobs(documentId,generation,policyRevision,sequence,status) " +
              "VALUES(:id,:generation,:policyRevision,:sequence,'pending') " +
              "ON CONFLICT(documentId) DO UPDATE SET status='pending' " +
              "WHERE generation=excluded.generation AND policyRevision=excluded.policyRevision AND sequence=excluded.sequence",
            {
              id: row.documentId,
              generation: version.generation,
              policyRevision: version.policyRevision,
              sequence: version.sequence,
            }
          );
        }
        await this.#execute("UPDATE work_state SET addressBookAfterId=:after", {
          after: rows.length ? rows.at(-1).id : null,
        });
        await this.#execute("UPDATE index_state SET revision=revision+1");
        return !!rows.length;
      })
    );
  }

  /**
   * Reads the last preferences fingerprint for external policy invalidation.
   *
   * @returns {Promise<?string>} Last durable fingerprint, or null.
   */
  getPolicyFingerprint() {
    return this.#enqueue(async () => {
      const [row] = await this.#execute(
        "SELECT policyFingerprint FROM work_state",
        {},
        ["policyFingerprint"]
      );
      return row.policyFingerprint;
    });
  }

  /**
   * Records preferences only after the caller durably journals invalidation.
   *
   * @param {string} fingerprint - Current search preferences.
   * @returns {Promise<void>} Resolves after the sidecar write.
   */
  setPolicyFingerprint(fingerprint) {
    if (typeof fingerprint != "string") {
      throw new TypeError("Invalid search policy fingerprint");
    }
    return this.#enqueue(() =>
      this.#execute("UPDATE work_state SET policyFingerprint=:fingerprint", {
        fingerprint,
      })
    );
  }

  /**
   * Returns accepted source position and separate unfinished-work counts.
   *
   * @returns {Promise<{sourceId: ?string, acceptedThrough: number,
   *   pending: number, unavailable: number}>} Durable progress.
   */
  getProgress() {
    return this.#enqueue(async () => {
      const [work] = await this.#execute(
        "SELECT sourceId,checkpoint AS acceptedThrough FROM work_state",
        {},
        ["sourceId", "acceptedThrough"]
      );
      const counts = await this.#execute(
        "SELECT status,count(*) AS count FROM index_jobs GROUP BY status",
        {},
        ["status", "count"]
      );
      const progress = { ...work, pending: 0, unavailable: 0 };
      for (const { status, count } of counts) {
        progress[status] = count;
      }
      return progress;
    });
  }

  /**
   * Reads retained text only while its generation/revision is eligible.
   *
   * @param {string} id - Physical document identity.
   * @param {object} [options] - Lookup controls.
   * @param {AbortSignal} [options.signal] - Cancel native selection and delivery.
   * @returns {Promise<?SearchDocument>} Current semantic text, or null.
   */
  getText(id, { signal } = {}) {
    return withAbort(
      this.#enqueue(async () => {
        signal?.throwIfAborted();
        const [row] = await this.#execute(
          "SELECT d.documentId AS id,d.generation,d.policyRevision,d.contentRevision,d.textRevision,d.bodyIndexed,d.subject,d.body," +
            "d.attachmentNames,d.attachmentPresence,d.attachmentTypes,d.attachmentInfos,d.author,d.recipients FROM documents d " +
            "LEFT JOIN document_versions v ON v.documentId=d.documentId " +
            "WHERE d.documentId=:id AND " +
            CURRENT_PROJECTION,
          { id },
          [
            "id",
            "generation",
            "policyRevision",
            "contentRevision",
            "textRevision",
            "bodyIndexed",
            "subject",
            "body",
            "attachmentNames",
            "attachmentPresence",
            "attachmentTypes",
            "attachmentInfos",
            "author",
            "recipients",
          ],
          signal
        );
        if (!row) {
          return null;
        }
        const state = await withAbort(
          this.#resolveDocument(id, signal),
          signal
        );
        signal?.throwIfAborted();
        row.bodyIndexed = !!row.bodyIndexed;
        row.attachmentPresence = decodeAttachmentPresence(
          row.attachmentPresence
        );
        row.attachmentTypes = decodeMimeEvidence(row.attachmentTypes);
        row.attachmentInfos = decodeAttachmentInfos(row.attachmentInfos);
        return matchesState(state, row) ? row : null;
      }),
      signal
    );
  }

  /**
   * Reads one forward page of literal author/recipient substring candidates.
   * Mozilla storage's LIKE is Unicode-aware; wildcards in input are escaped.
   * Only current metadata projections are considered, never body text or FTS.
   *
   * @param {string} text - Nonempty completion substring.
   * @param {object} [options={}] - Page controls for this lookup.
   * @param {number} [options.after=0] - Previous internal sidecar row position.
   * @param {number} [options.limit=100] - Candidate page size, from 1 to 500.
   * @param {AbortSignal} [options.signal] - Cancel native selection/delivery.
   * @returns {Promise<{items: SearchHit[], nextKey: ?number}>} Current tokens and
   *   next position, not a stable native snapshot or physical message identity.
   */
  getCompletionPage(text, { after = 0, limit = 100, signal } = {}) {
    if (typeof text != "string" || !text) {
      throw new TypeError("A completion substring is required");
    }
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500
    ) {
      throw new RangeError("Invalid completion page");
    }
    return withAbort(
      this.#enqueue(async () => {
        const rows = await this.#execute(
          "SELECT d.id AS position,d.documentId,d.generation,d.policyRevision,d.contentRevision " +
            "FROM documents d LEFT JOIN document_versions v ON v.documentId=d.documentId WHERE " +
            CURRENT_PROJECTION +
            " AND d.id>:after AND " +
            "(d.author LIKE :pattern ESCAPE '/' OR d.recipients LIKE :pattern ESCAPE '/') " +
            "ORDER BY d.id LIMIT :limit",
          { after, limit, pattern: "%" + text.replace(/[/%_]/g, "/$&") + "%" },
          [
            "position",
            "documentId",
            "generation",
            "policyRevision",
            "contentRevision",
          ],
          signal
        );
        const items = [];
        for (const row of rows) {
          const state = await withAbort(
            this.#resolveDocument(row.documentId, signal),
            signal
          );
          signal?.throwIfAborted();
          if (matchesState(state, row)) {
            items.push({
              id: row.documentId,
              generation: row.generation,
              policyRevision: row.policyRevision,
              contentRevision: row.contentRevision,
            });
          }
        }
        return {
          items,
          nextKey: rows.length == limit ? rows.at(-1).position : null,
        };
      }),
      signal
    );
  }

  /**
   * Removes semantic text and FTS rows for one document.
   *
   * @param {string} id - Physical document identity.
   * @returns {Promise<void>} Resolves after the sidecar transaction commits.
   */
  remove(id) {
    return this.#enqueue(() =>
      this.#transaction(async () => {
        await this.#erase(id, true);
        await this.#execute("DELETE FROM index_jobs WHERE documentId=:id", {
          id,
        });
        await this.#execute("UPDATE index_state SET revision=revision+1");
      })
    );
  }

  /**
   * Stores verified recovery records independently of their disposable projection.
   * A conflicting source revision rejects the whole batch. Erasure is permanent
   * for this physical identity; retrying an old backup cannot restore its payload.
   *
   * @param {{recordId: string, documentId: ?string, kind: string,
   *   sourceRevision: string, payload: object, document: ?SearchDocument}[]} records -
   *   Records produced by the receipt-bound mail or quarantined chat caller.
   * @returns {Promise<void>} Resolves after the complete record batch commits.
   * @throws {TypeError} For malformed identities, text or revisions.
   * @throws {Error} For conflicting source revisions or storage failures.
   */
  retainRecovery(records) {
    if (!Array.isArray(records)) {
      throw new TypeError("Recovery records must be an array");
    }
    const ids = new Set();
    const copies = records.map(record => {
      if (
        typeof record.recordId != "string" ||
        !record.recordId ||
        ids.has(record.recordId) ||
        (record.documentId !== null &&
          (typeof record.documentId != "string" || !record.documentId)) ||
        !["mail", "chat"].includes(record.kind) ||
        typeof record.sourceRevision != "string" ||
        !/^[0-9a-f]{64}$/.test(record.sourceRevision) ||
        !record.payload ||
        typeof record.payload != "object"
      ) {
        throw new TypeError("Invalid recovery record");
      }
      ids.add(record.recordId);
      const document =
        record.document === null ? null : copyDocument(record.document);
      if (
        document &&
        (record.kind != "mail" || document.id !== record.documentId)
      ) {
        throw new TypeError(
          "Recovery projection does not match its physical identity"
        );
      }
      return {
        recordId: record.recordId,
        documentId: record.documentId,
        kind: record.kind,
        sourceRevision: record.sourceRevision,
        payload: JSON.stringify(record.payload),
        document: document === null ? null : JSON.stringify(document),
      };
    });
    return this.#enqueue(() =>
      this.#transaction(async () => {
        for (const record of copies) {
          const [old] = await this.#execute(
            "SELECT sourceRevision,documentId,kind FROM recovery_records WHERE recordId=:recordId",
            { recordId: record.recordId },
            ["sourceRevision", "documentId", "kind"]
          );
          if (
            old &&
            (old.sourceRevision !== record.sourceRevision ||
              old.documentId !== record.documentId ||
              old.kind !== record.kind)
          ) {
            throw new Error("Recovered source or physical binding changed");
          }
          if (!old && record.document !== null) {
            // Do not invent policy history for records written by an old schema.
            // An exclusion recorded before import also prevents authorization.
            await this.#execute(
              "INSERT INTO recovery_policy(documentId,policyRevision) " +
                "VALUES(:id,:policyRevision) ON CONFLICT DO NOTHING",
              {
                id: record.documentId,
                policyRevision: JSON.parse(record.document).policyRevision,
              }
            );
          }
          await this.#execute(
            "INSERT INTO recovery_records(recordId,documentId,kind,sourceRevision,payload,document,erased) " +
              "VALUES(:recordId,:documentId,:kind,:sourceRevision," +
              "CASE WHEN EXISTS(SELECT 1 FROM recovery_erased WHERE documentId=:documentId) THEN NULL ELSE :payload END," +
              "CASE WHEN EXISTS(SELECT 1 FROM recovery_erased WHERE documentId=:documentId) THEN NULL ELSE :document END," +
              "EXISTS(SELECT 1 FROM recovery_erased WHERE documentId=:documentId)) " +
              "ON CONFLICT(recordId) DO NOTHING",
            record
          );
        }
      })
    );
  }

  /**
   * Reads persisted recovery records, including explicit quarantine and erasure.
   * This is not an eligibility grant and never reads the FTS table.
   *
   * @param {?string} [documentId=null] - Optional exact physical document identity.
   * @returns {Promise<object[]>} Owned raw/provenance records; erased payloads are null.
   */
  getRecoveryRecords(documentId = null) {
    if (documentId !== null && typeof documentId != "string") {
      throw new TypeError("Invalid recovery lookup identity");
    }
    return this.#enqueue(async () => {
      const rows = await this.#execute(
        "SELECT recordId,documentId,kind,sourceRevision,payload,erased FROM recovery_records " +
          (documentId === null ? "" : "WHERE documentId=:documentId ") +
          "ORDER BY recordId",
        documentId === null ? {} : { documentId },
        [
          "recordId",
          "documentId",
          "kind",
          "sourceRevision",
          "payload",
          "erased",
        ]
      );
      return rows.map(row => ({
        ...row,
        payload: row.payload === null ? null : JSON.parse(row.payload),
        erased: !!row.erased,
      }));
    });
  }

  /**
   * Reads the last authorized recovery policy and durable suppression state.
   * Missing state does not authorize a legacy record under a changed policy.
   *
   * @param {string} id - Exact physical mail key.
   * @param {AbortSignal} [signal] - Cancels the lookup.
   * @returns {Promise<?{policyRevision: number, suppressed: number}>} Stored state, or null.
   */
  async #getRecoveryPolicy(id, signal) {
    const [policy] = await this.#execute(
      "SELECT policyRevision,suppressed FROM recovery_policy WHERE documentId=:id",
      { id },
      ["policyRevision", "suppressed"],
      signal
    );
    return policy ?? null;
  }

  /**
   * Loads recovered text for current native content under an authorized policy.
   * An eligible rescan can advance policy without changing the source record.
   * A consumed exclusion suppresses that recovery across reopen and rebuild.
   *
   * @param {string} id - Exact physical mail key.
   * @param {AbortSignal} [signal] - Cancels lookup and delivery.
   * @returns {Promise<?SearchDocument>} A current projection, or null for quarantine/stale/erased data.
   * @throws {Error} For conflicting sources, native lookup or storage failures.
   */
  getRecoveredText(id, signal) {
    return withAbort(
      this.#enqueue(async () => {
        signal?.throwIfAborted();
        const rows = await this.#execute(
          "SELECT document FROM recovery_records WHERE documentId=:id AND kind='mail' " +
            "AND erased=0 AND document IS NOT NULL",
          { id },
          ["document"],
          signal
        );
        const state = await this.#resolveDocument(id, signal);
        const policy = await this.#getRecoveryPolicy(id, signal);
        signal?.throwIfAborted();
        if (state?.eligible !== true || policy?.suppressed) {
          return null;
        }
        const candidates = rows
          .map(row => copyDocument(JSON.parse(row.document)))
          .filter(
            document =>
              document.contentRevision === state.contentRevision &&
              (document.policyRevision === (state.policyRevision ?? 0) ||
                policy?.policyRevision === (state.policyRevision ?? 0))
          );
        if (!candidates.length) {
          return null;
        }
        if (
          candidates.some(
            document =>
              document.body !== candidates[0].body ||
              document.attachmentNames !== candidates[0].attachmentNames
          )
        ) {
          throw new Error("Conflicting recovered semantic sources");
        }
        return {
          ...candidates[0],
          generation: state.generation,
          policyRevision: state.policyRevision ?? 0,
        };
      }),
      signal
    );
  }

  /**
   * Rebuilds disposable FTS rows from retained semantic text.
   *
   * @returns {Promise<void>} Resolves after the sidecar transaction commits.
   */
  rebuild() {
    return this.#enqueue(() =>
      this.#transaction(async () => {
        await this.#execute("DELETE FROM search_text");
        await this.#execute(
          "INSERT INTO search_text(docid,subject,body,attachmentNames,author,recipients) " +
            "SELECT d.id,d.subject,d.body,d.attachmentNames,d.author,d.recipients FROM documents d " +
            "LEFT JOIN document_versions v ON v.documentId=d.documentId WHERE " +
            CURRENT_PROJECTION
        );
        await this.#execute("UPDATE index_state SET revision=revision+1");
      })
    );
  }

  /**
   * Searches current eligible physical documents in stable index order.
   * A cursor is valid only until the index changes; callers then restart.
   * Locations are current at lookup time and must be resolved again on opening.
   *
   * @param {string} text - Global-search words or quoted phrases.
   * @param {object} [options] - Query options.
   * @param {boolean} [options.andTerms=true] - Match all terms instead of any.
   * @param {boolean} [options.matchAll=false] - Enumerate indexed metadata when text has no terms.
   * @param {number} [options.limit=50] - Page size, from 1 to 500.
   * @param {object} [options.cursor] - Opaque cursor returned by this instance.
   * @param {AbortSignal} [options.signal] - Cancel delivery and native selection.
   * @returns {Promise<{items: SearchHit[], cursor: ?object, resultSetId: string}>}
   *   Matches, next-page cursor and identity shared by pages of this query.
   */
  search(
    text,
    { andTerms = true, matchAll = false, limit = 50, cursor, signal } = {}
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError("Search page size must be from 1 to 500");
    }
    const expression = makeMatchExpression(parseSearchTerms(text), andTerms);
    if (typeof matchAll != "boolean") {
      throw new TypeError("matchAll must be boolean");
    }
    const all = !expression && matchAll;
    const previous = cursor && this.#cursors.get(cursor);
    if (
      cursor &&
      (!previous || previous.expression != expression || previous.all != all)
    ) {
      throw new TypeError("Cursor does not belong to this search");
    }
    const resultSetId =
      previous?.resultSetId || Services.uuid.generateUUID().toString();
    return withAbort(
      this.#enqueue(() =>
        this.#transaction(async () => {
          signal?.throwIfAborted();
          const [{ revision }] = await this.#execute(
            "SELECT revision FROM index_state",
            {},
            ["revision"],
            signal
          );
          if (previous && previous.revision != revision) {
            throw new Error("Search index changed; restart the query");
          }
          const items = [];
          let after = previous?.after || 0;
          let more = false;
          while (expression || all) {
            const rows = await this.#execute(
              "SELECT search_text.docid AS id,d.documentId,d.generation,d.policyRevision,d.contentRevision,d.textRevision,d.bodyIndexed," +
                (expression ? "offsets(search_text)" : "''") +
                " AS offsets " +
                "FROM search_text JOIN documents d ON d.id=search_text.docid " +
                "LEFT JOIN document_versions v ON v.documentId=d.documentId " +
                "WHERE " +
                (expression ? "search_text MATCH :expression AND " : "") +
                CURRENT_PROJECTION +
                " AND search_text.docid>:after ORDER BY search_text.docid LIMIT :limit",
              {
                ...(expression ? { expression } : {}),
                after,
                limit: limit + 1,
              },
              [
                "id",
                "documentId",
                "generation",
                "policyRevision",
                "contentRevision",
                "textRevision",
                "bodyIndexed",
                "offsets",
              ],
              signal
            );
            if (!rows.length) {
              break;
            }
            for (const row of rows) {
              const state = await withAbort(
                this.#resolveDocument(row.documentId, signal),
                signal
              );
              signal?.throwIfAborted();
              if (matchesState(state, row)) {
                if (items.length == limit) {
                  more = true;
                  break;
                }
                items.push({
                  id: row.documentId,
                  generation: row.generation,
                  policyRevision: row.policyRevision,
                  contentRevision: row.contentRevision,
                  textRevision: row.textRevision,
                  bodyIndexed: !!row.bodyIndexed,
                  offsetsUtf8: row.offsets,
                  location: state.location ? { ...state.location } : null,
                  originalContentAvailable:
                    state.originalContentAvailable === true,
                });
              }
              after = row.id;
            }
            if (more || rows.length < limit + 1) {
              break;
            }
          }
          const next = more ? Object.freeze({}) : null;
          if (next) {
            this.#cursors.set(next, {
              expression,
              all,
              revision,
              after,
              resultSetId,
            });
          }
          return { items, cursor: next, resultSetId };
        })
      ),
      signal
    );
  }

  /**
   * Finishes accepted operations and closes the owned connection.
   *
   * @returns {Promise<void>} Resolves when the native connection has closed.
   */
  close() {
    if (!this.#closed) {
      this.#closed = true;
      this.#tail = this.#tail.then(
        () =>
          new Promise((resolve, reject) => {
            try {
              this.#connection.asyncClose({
                complete() {
                  resolve();
                },
              });
            } catch (error) {
              reject(error);
            }
          })
      );
    }
    return this.#tail;
  }
}
