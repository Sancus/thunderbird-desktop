/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  makeMatchExpression,
  parseSearchTerms,
} from "resource:///modules/panorama/SearchTerms.sys.mjs";

/**
 * @typedef {object} SearchDocument
 * @property {string} id - Stable physical document identity, not Message-ID.
 * @property {number} generation - Authoritative message generation.
 * @property {string} contentRevision - Revision of the supplied semantic text.
 * @property {string} subject - Decoded subject.
 * @property {string} body - Searchable semantic text, including recovered text.
 * @property {string} attachmentNames - Decoded attachment filenames.
 * @property {string} author - Decoded sender names and addresses.
 * @property {string} recipients - Decoded To/Cc/Bcc names and addresses.
 */

/**
 * @typedef {object} SearchDocumentState
 * @property {boolean} eligible - Current deletion, junk, exclusion and pref policy.
 * @property {number} generation - Current authoritative message generation.
 * @property {string} contentRevision - Current semantic text revision.
 * @property {?{folderId: number, messageKey: number}} location - Current location.
 * @property {boolean} originalContentAvailable - Original content can be read.
 */

/**
 * @typedef {object} SearchHit
 * @property {string} id - Stable physical document identity.
 * @property {number} generation - Indexed generation, checked against current state.
 * @property {string} contentRevision - Revision used for the indexed text/offsets.
 * @property {string} offsetsUtf8 - FTS3 column/term/byte-offset/byte-length tuples.
 *   Columns are subject, body, attachmentNames, author and recipients.
 * @property {?{folderId: number, messageKey: number}} location - Location snapshot.
 * @property {boolean} originalContentAvailable - Original content is readable.
 */

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
 * subscribe to core changes or own message bodies.
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
   * @param {function(string): Promise<?SearchDocumentState>} resolveDocument -
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
      if (connection.schemaVersion > 1) {
        throw new Error("Unsupported search index schema");
      }
      await index.#transaction(async () => {
        await index.#execute(
          "CREATE TABLE IF NOT EXISTS documents (" +
            "id INTEGER PRIMARY KEY, documentId TEXT UNIQUE NOT NULL, " +
            "generation INTEGER NOT NULL, contentRevision TEXT NOT NULL, " +
            "subject TEXT NOT NULL, body TEXT NOT NULL, attachmentNames TEXT NOT NULL, " +
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
        await index.#execute("PRAGMA user_version = 1");
      });
      return index;
    } catch (error) {
      await index.close();
      throw error;
    }
  }

  /**
   * @param {mozIStorageConnection} connection - Owned sidecar connection.
   * @param {function(string): Promise<?SearchDocumentState>} resolveDocument -
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
   * @param {Record<string, string|number>} [params={}] - Bound values.
   * @param {string[]} [columns=[]] - Result columns to copy before finalization.
   * @param {AbortSignal} [signal] - Statement cancellation.
   * @returns {Promise<Array<Record<string, string|number>>>} Copied result rows.
   */
  #execute(sql, params = {}, columns = [], signal) {
    signal?.throwIfAborted();
    const statement = this.#connection.createAsyncStatement(sql);
    try {
      for (const [name, value] of Object.entries(params)) {
        statement.params[name] = value;
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
    }
    if (
      !document.id ||
      !document.contentRevision ||
      !Number.isSafeInteger(document.generation) ||
      document.generation < 0
    ) {
      throw new TypeError("Invalid document identity or revision");
    }
    document = Object.fromEntries(
      [
        "id",
        "generation",
        "contentRevision",
        "subject",
        "body",
        "attachmentNames",
        "author",
        "recipients",
      ].map(name => [name, document[name]])
    );
    return this.#enqueue(async () => {
      const state = await this.#resolveDocument(document.id);
      if (
        state?.eligible !== true ||
        state.generation != document.generation ||
        state.contentRevision != document.contentRevision
      ) {
        return false;
      }
      return this.#transaction(async () => {
        await this.#execute(
          "INSERT INTO documents " +
            "(documentId,generation,contentRevision,subject,body,attachmentNames,author,recipients) " +
            "VALUES(:id,:generation,:contentRevision,:subject,:body,:attachmentNames,:author,:recipients) " +
            "ON CONFLICT(documentId) DO UPDATE SET " +
            "generation=excluded.generation,contentRevision=excluded.contentRevision," +
            "subject=excluded.subject,body=excluded.body,attachmentNames=excluded.attachmentNames," +
            "author=excluded.author," +
            "recipients=excluded.recipients",
          document
        );
        await this.#execute(
          "DELETE FROM search_text WHERE docid=" +
            "(SELECT id FROM documents WHERE documentId=:id)",
          { id: document.id }
        );
        await this.#execute(
          "INSERT INTO search_text(docid,subject,body,attachmentNames,author,recipients) " +
            "SELECT id,subject,body,attachmentNames,author,recipients FROM documents WHERE documentId=:id",
          { id: document.id }
        );
        await this.#execute("UPDATE index_state SET revision=revision+1");
        return true;
      });
    });
  }

  /**
   * Reads retained text only while its generation/revision is eligible.
   *
   * @param {string} id - Physical document identity.
   * @returns {Promise<?SearchDocument>} Current semantic text, or null.
   */
  getText(id) {
    return this.#enqueue(async () => {
      const [row] = await this.#execute(
        "SELECT documentId AS id,generation,contentRevision,subject,body,attachmentNames,author," +
          "recipients FROM documents WHERE documentId=:id",
        { id },
        [
          "id",
          "generation",
          "contentRevision",
          "subject",
          "body",
          "attachmentNames",
          "author",
          "recipients",
        ]
      );
      if (!row) {
        return null;
      }
      const state = await this.#resolveDocument(id);
      return state?.eligible === true &&
        state.generation == row.generation &&
        state.contentRevision == row.contentRevision
        ? row
        : null;
    });
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
        await this.#execute(
          "DELETE FROM search_text WHERE docid=" +
            "(SELECT id FROM documents WHERE documentId=:id)",
          { id }
        );
        await this.#execute("DELETE FROM documents WHERE documentId=:id", {
          id,
        });
        await this.#execute("UPDATE index_state SET revision=revision+1");
      })
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
            "SELECT id,subject,body,attachmentNames,author,recipients FROM documents"
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
   * @param {number} [options.limit=50] - Page size, from 1 to 500.
   * @param {object} [options.cursor] - Opaque cursor returned by this instance.
   * @param {AbortSignal} [options.signal] - Cancel delivery and native selection.
   * @returns {Promise<{items: SearchHit[], cursor: ?object, resultSetId: string}>}
   *   Matches, next-page cursor and identity shared by pages of this query.
   */
  search(text, { andTerms = true, limit = 50, cursor, signal } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError("Search page size must be from 1 to 500");
    }
    const expression = makeMatchExpression(parseSearchTerms(text), andTerms);
    const previous = cursor && this.#cursors.get(cursor);
    if (cursor && (!previous || previous.expression != expression)) {
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
          while (expression) {
            const rows = await this.#execute(
              "SELECT d.id,d.documentId,d.generation,d.contentRevision," +
                "offsets(search_text) AS offsets " +
                "FROM search_text JOIN documents d ON d.id=search_text.docid " +
                "WHERE search_text MATCH :expression AND d.id>:after ORDER BY d.id LIMIT :limit",
              { expression, after, limit: limit + 1 },
              ["id", "documentId", "generation", "contentRevision", "offsets"],
              signal
            );
            if (!rows.length) {
              break;
            }
            for (const row of rows) {
              const state = await withAbort(
                this.#resolveDocument(row.documentId),
                signal
              );
              signal?.throwIfAborted();
              if (
                state?.eligible === true &&
                state.generation == row.generation &&
                state.contentRevision == row.contentRevision
              ) {
                if (items.length == limit) {
                  more = true;
                  break;
                }
                items.push({
                  id: row.documentId,
                  generation: row.generation,
                  contentRevision: row.contentRevision,
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
