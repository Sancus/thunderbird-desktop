/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  openSearchWriter,
  SearchWriter,
  recordSearchWriterFailure,
} from "resource:///modules/panorama/SearchMigrationHold.sys.mjs";

import { IMServices } from "resource:///modules/IMServices.sys.mjs";
import { PanoramaSearchIndex } from "resource:///modules/panorama/PanoramaSearchIndex.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  encodeName: "resource:///modules/logger.sys.mjs",
  getChatLogArchive: "resource:///modules/logger.sys.mjs",
  getChatPrivacyEpoch: "resource:///modules/logger.sys.mjs",
  applyChatSearchPrivacyReceipt:
    "resource:///modules/panorama/ChatSearchRedaction.sys.mjs",
  chatSearchPrivacyNeedsErasure:
    "resource:///modules/panorama/ChatSearchRedaction.sys.mjs",
  readLegacyGlodaChat:
    "resource:///modules/panorama/LegacyGlodaChatReader.sys.mjs",
  readLegacyChatLog:
    "resource:///modules/panorama/LegacyGlodaChatReader.sys.mjs",
  bindLegacyChatLogs:
    "resource:///modules/panorama/LegacyGlodaChatReader.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "plainText", () =>
  Cc["@mozilla.org/mail/folder-factory;1?name=mailbox"].createInstance(
    Ci.nsIMsgFolder
  )
);

/**
 * Returns the four logger path components beneath the current profile's logs.
 *
 * @param {string} filePath - Absolute path returned by the chat logger.
 * @returns {string[]} Protocol, encoded account, encoded conversation and filename.
 * @throws {TypeError} For paths outside that layout or unsupported log names.
 */
function logComponents(filePath) {
  if (typeof filePath != "string" || !PathUtils.isAbsolute(filePath)) {
    throw new TypeError("Unsupported chat log path");
  }
  const base = PathUtils.split(PathUtils.join(PathUtils.profileDir, "logs"));
  const parts = PathUtils.split(filePath);
  const relative = parts.slice(base.length);
  if (
    !base.every((part, i) => part == parts[i]) ||
    relative.length != 4 ||
    relative.some(part => !part || part == "." || part == "..") ||
    !/^\d{4}-\d{2}-\d{2}\.\d{6}[+-]\d{4}\.json$/.test(relative[3])
  ) {
    throw new TypeError("Unsupported chat log path");
  }
  return relative;
}

/**
 * Encodes the logger's profile-relative file identity, independently of mail keys.
 *
 * @param {string} filePath - Absolute path returned by the chat logger.
 * @returns {string} Identity stable across relocation of the whole profile.
 * @throws {TypeError} For a relative path or unsupported logger layout.
 */
export function chatSearchDocumentId(filePath) {
  return "chat:" + JSON.stringify(logComponents(filePath));
}

/**
 * Resolves a canonical chat identity beneath the current profile's logs.
 *
 * @param {string} id - Identity returned by chatSearchDocumentId.
 * @returns {string} Current absolute log path.
 * @throws {TypeError} For a noncanonical identity or invalid path components.
 */
function logPath(id) {
  if (typeof id != "string" || !id.startsWith("chat:")) {
    throw new TypeError("Invalid chat document identity");
  }
  const parts = JSON.parse(id.slice(5));
  if (
    !Array.isArray(parts) ||
    parts.length != 4 ||
    parts.some(
      part =>
        typeof part != "string" ||
        !part ||
        part == "." ||
        part == ".." ||
        /[\\/]/.test(part)
    )
  ) {
    throw new TypeError("Invalid chat document identity");
  }
  const filePath = PathUtils.join(PathUtils.profileDir, "logs", ...parts);
  if (chatSearchDocumentId(filePath) != id) {
    throw new TypeError("Noncanonical chat document identity");
  }
  return filePath;
}

/**
 * Reads bytes through the logger's file queue and hashes the exact source.
 * Does not convert read failures into empty transcripts.
 *
 * @param {string} filePath - Current log path.
 * @param {AbortSignal} signal - Cancels delivery, not queued logger I/O.
 * @param {object} archive - Queue bound to the actual pending chat-search work.
 * @returns {Promise<{bytes: Uint8Array, revision: string}>} Bytes and SHA-256 digest.
 */
async function readSource(filePath, signal, archive) {
  signal?.throwIfAborted();
  let bytes;
  let missing;
  try {
    bytes = await archive.queueFileOperation(filePath, async wait => {
      try {
        return await wait(() => IOUtils.read(filePath));
      } catch (error) {
        if (error.name != "NotFoundError") {
          throw error;
        }
        // The actual read has settled. Let the authoritative resolver handle
        // absence outside the child queue, without retaining a writer failure.
        missing = error;
        return null;
      }
    });
  } catch (error) {
    throw sourceFailure(error);
  }
  if (missing) {
    throw sourceFailure(missing);
  }
  signal?.throwIfAborted();
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hash.init(hash.SHA256);
  hash.update(bytes, bytes.length);
  const revision = Array.from(hash.finish(false), c =>
    c.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
  return { bytes, revision };
}

/**
 * Validates source records before using the logger's tolerant display parser.
 * A malformed tail might contain an edit or redaction; do not index older text.
 *
 * @param {Uint8Array} bytes - Complete log bytes.
 * @param {string[]} parts - Logger path components.
 * @returns {{title: string, hasNoLogRecords: boolean,
 *   messages: {who: string, text: string}[]}} Source evidence used to check the parser.
 * @throws {Error} For malformed or mismatched metadata or message records.
 */
function validateSource(bytes, parts) {
  const lines = new TextDecoder("utf-8", { fatal: true })
    .decode(bytes)
    .split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const header = JSON.parse(lines.shift());
  if (
    !header ||
    typeof header.title != "string" ||
    typeof header.account != "string" ||
    typeof header.normalizedName != "string" ||
    typeof header.isChat != "boolean" ||
    !Number.isFinite(Date.parse(header.date)) ||
    header.protocol != parts[0] ||
    lazy.encodeName(header.account) != parts[1] ||
    lazy.encodeName(header.normalizedName + (header.isChat ? ".chat" : "")) !=
      parts[2]
  ) {
    throw new Error("Invalid chat log metadata");
  }
  const records = lines.map(line => JSON.parse(line));
  const last = new Map();
  for (const [i, record] of records.entries()) {
    if (
      !record ||
      typeof record.text != "string" ||
      !Array.isArray(record.flags) ||
      record.flags.some(flag => typeof flag != "string") ||
      !Number.isFinite(Date.parse(record.date)) ||
      (record.remoteId != null && typeof record.remoteId != "string") ||
      (record.who != null && typeof record.who != "string") ||
      (record.alias != null && typeof record.alias != "string")
    ) {
      throw new Error("Invalid chat log message");
    }
    if (record.remoteId) {
      last.set(record.remoteId, i);
    }
  }
  return {
    title: header.title,
    hasNoLogRecords: records.some(record => record.flags.includes("noLog")),
    messages: records
      .filter(
        (record, i) =>
          (!record.remoteId || last.get(record.remoteId) == i) &&
          !record.flags.includes("deleted") &&
          !record.flags.includes("noLog")
      )
      .map(record => ({
        who: record.alias || record.who || "",
        text:
          !record.flags.includes("action") && record.text.startsWith("/me ")
            ? record.text.slice(4)
            : record.text,
      })),
  };
}

/** Original file-read/parser errors, without changing their identity or type. */
const sourceFailures = new WeakSet();

/**
 * Records a source-only failure without wrapping or mutating the original error.
 * Cancellation and index/storage failures are recorded by neither caller.
 *
 * @param {unknown} error - Original file read or transcript parser failure.
 * @returns {unknown} The same error for rejection.
 */
function sourceFailure(error) {
  if (
    error !== null &&
    (typeof error == "object" || typeof error == "function")
  ) {
    sourceFailures.add(error);
  }
  return error;
}

/** The logger parse differs from the previously validated source. */
class IncompleteChatTranscriptError extends Error {}

/**
 * Uses the existing single-file logger parser only after validating its source.
 * The tolerant display parser must not omit an edit or redaction record.
 *
 * @param {string} filePath - Current physical log file.
 * @param {{bytes: Uint8Array}} source - Complete source bytes.
 * @param {AbortSignal} signal - Cancels parsed result delivery.
 * @param {object} archive - Parser bound to the actual pending chat-search work.
 * @returns {Promise<{log: Log, conversation: LogConversation,
 *   messages: imIMessage[], hasNoLogRecords: boolean}>}
 *   Real logger objects and their validated visible records.
 */
async function readLogConversation(filePath, source, signal, archive) {
  let expected;
  let log;
  let conversation;
  try {
    expected = validateSource(source.bytes, logComponents(filePath));
    log = await archive.getLogFromFile(filePath);
    conversation = await log.getConversation();
  } catch (error) {
    throw sourceFailure(error);
  }
  signal?.throwIfAborted();
  const messages = conversation
    ?.getMessages()
    .filter(message => !message.noLog);
  if (
    !messages ||
    conversation.title != expected.title ||
    messages.length != expected.messages.length ||
    messages.some(
      (message, i) =>
        (message.alias || message.who || "") != expected.messages[i].who ||
        message.message != expected.messages[i].text
    )
  ) {
    throw sourceFailure(
      new IncompleteChatTranscriptError(
        "Chat logger did not return the complete source transcript"
      )
    );
  }
  return {
    log,
    conversation,
    messages,
    hasNoLogRecords: expected.hasNoLogRecords,
  };
}

/**
 * Refreshes individual logger files in a separate search sidecar.
 * The logger supplies edit/deletion filtering and HTML/speaker normalization
 * matches index_im. No mail identity, encrypted-MIME policy or Gloda is used.
 *
 * Callers supply changed files, or an active conversation whose writer has one
 * file. This class does not subscribe to observers or discover historical logs.
 * Explicit privacy updates replay the logger's durable version-specific receipts
 * before text delivery. Ordinary observer/startup activation stays separate.
 * Recovered text without verified log policy is not accepted here.
 */
export class ChatSearchProvider {
  /** @type {SearchWriter} Concrete retained writer and pending operations. */
  #migration;
  #storageTerminal = true;
  /** @returns {boolean} Actual storage callback settlement, independent of errors. */
  get migrationSettled() {
    return this.#migration.terminal;
  }

  /** @type {unknown[]} Original failures retained before queue advancement. */
  #migrationFailures = [];

  /**
   * Returns original failures without granting native lease ownership.
   * Ordinary retries and successful cleanup do not clear this diagnostic copy.
   *
   * @returns {unknown[]} First error followed by later distinct failures.
   */
  get migrationFailures() {
    return [...this.#migrationFailures];
  }

  /**
   * Retains a rejected operation before its queue advances.
   *
   * @param {unknown} error - Exact original rejection, without normalization.
   */
  #rememberMigrationFailure(error) {
    if (!this.#migrationFailures.includes(error)) {
      this.#migrationFailures.push(error);
      recordSearchWriterFailure("chat-search", error);
    }
  }

  /** @param {?object} [migrationWork=null] - Captured same-domain open.
   * @param {?object} [migrationWork=null] - Internal token from an actual pending same-domain operation.
   */
  constructor(migrationWork = null) {
    this.#migration = new SearchWriter(
      "chat-search",
      () => this.#stopMigrationNotifications(),
      () => this.close(),
      () => this.#storageTerminal,
      migrationWork
    );
  }

  /** This provider has no independent notification or timer source. */
  #stopMigrationNotifications() {}

  /** @type {PanoramaSearchIndex} */
  #index;
  /**
   * Archive bound to the real operation executing in the serialized index queue.
   *
   * @type {?object}
   */
  #archive = null;

  /** @type {Promise<void>} */
  #pending = Promise.resolve();
  /** @type {Set<Promise<string[]>>} */
  #redactions = new Set();
  #privacyRevision = 0;
  #privacyFailed = false;
  /** @type {unknown} */
  #privacyFailure;
  /** @type {?Promise<void>} */
  #closing = null;

  /**
   * Opens an independent chat sidecar using the existing FTS3 writer/tokenizer.
   *
   * @param {nsIFile} file - Dedicated chat search database, never the mail sidecar.
   * @returns {Promise<ChatSearchProvider>} Provider with fresh log-state resolution.
   * @param {?object} [migrationWork=null] - Internal token from an actual pending same-domain operation.
   */
  static open(file, migrationWork = null) {
    return openSearchWriter(
      "chat-search",
      async work => {
        const provider = new ChatSearchProvider(work);
        try {
          await provider.#migration.wait(async () => {
            provider.#storageTerminal = false;
            provider.#index = await PanoramaSearchIndex.open(
              file,
              (id, signal) => provider.#resolveDocument(id, { signal })
            );
          });
          await provider.#enqueue(() => provider.#reconcilePrivacy(), work);
          return provider;
        } catch (error) {
          provider.#rememberMigrationFailure(error);
          try {
            await provider.close();
          } catch (closeError) {
            provider.#rememberMigrationFailure(closeError);
          }
          throw error;
        }
      },
      migrationWork
    );
  }

  /**
   * Persists validated old chat records without authorizing their unknown policy.
   * Only explicitly supplied physical log paths are read; no history is discovered.
   *
   * @param {string} indexPath - Closed schema30 Gloda backup.
   * @param {string} logsRoot - Original backed-up logger root.
   * @param {string[]} relativePaths - Exact physical log paths from that snapshot.
   * @returns {Promise<number>} Number of committed quarantined records.
   * @throws {Error} Original source/validation/storage error or closing provider.
   * @param {?object} [migrationWork=null] - Internal token from an actual pending same-domain operation.
   */
  recoverLegacy(indexPath, logsRoot, relativePaths, migrationWork = null) {
    return this.#migration.run(work => {
      if (this.#closing) {
        return Promise.reject(new Error("Chat search provider is closing"));
      }
      const result = this.#enqueue(async () => {
        const snapshot = await this.#migration.wait(() =>
          lazy.readLegacyGlodaChat(indexPath)
        );
        const logs = [];
        for (const path of relativePaths) {
          logs.push(
            await this.#migration.wait(() =>
              lazy.readLegacyChatLog(logsRoot, path)
            )
          );
        }
        const bound = lazy.bindLegacyChatLogs(snapshot, logs);
        const records = bound.records.map(record => ({
          recordId: "chat:" + JSON.stringify([snapshot.source.path, record.id]),
          documentId: chatSearchDocumentId(
            PathUtils.join(
              PathUtils.profileDir,
              "logs",
              ...record.relativePath.split("/")
            )
          ),
          kind: "chat",
          sourceRevision: snapshot.source.sha256,
          payload: record,
          document: null,
        }));
        await this.#migration.wait(() => this.#index.retainRecovery(records));
        return records.length;
      }, work);
      return result;
    }, migrationWork);
  }

  /**
   * Reads stored quarantine/provenance without granting search eligibility.
   *
   * @param {?string} [id=null] - Exact chat document ID, or all records.
   * @returns {Promise<object[]>} Stored records; erased payloads are null. An
   *   overlapping privacy operation withholds this read, as for getText.
   * @throws {Error} Original privacy/storage failure or closing provider.
   * @param {?object} [migrationWork=null] - Internal token from an actual pending same-domain operation.
   */
  async getRecoveryRecords(id = null, migrationWork = null) {
    return this.#migration.run(async work => {
      if (this.#closing) {
        throw new Error("Chat search provider is closing");
      }
      const revision = this.#redactions.size ? null : this.#privacyRevision;
      const epoch = lazy.getChatPrivacyEpoch();
      const records = await this.#migration.wait(() =>
        this.#enqueue(async () => {
          await this.#migration.wait(() => this.#reconcilePrivacy());
          const value = await this.#migration.wait(() =>
            this.#index.getRecoveryRecords(id)
          );
          await this.#migration.wait(() => this.#reconcilePrivacy());
          return value;
        }, work)
      );
      await this.#migration.wait(() => this.#waitForRedactions());
      return revision === this.#privacyRevision &&
        epoch === lazy.getChatPrivacyEpoch()
        ? records
        : [];
    }, migrationWork);
  }

  /**
   * Rebuilds disposable transcript rows after earlier refreshes and erasures.
   * Stored recovery aggregates remain quarantined and supply no index rows.
   *
   * @returns {Promise<void>} Resolves after observed privacy work and FTS rebuild.
   * @throws {Error} Original privacy/storage failure or closing provider.
   * @param {?object} [migrationWork=null] - Internal token from an actual pending same-domain operation.
   */
  async rebuild(migrationWork = null) {
    return this.#migration.run(async work => {
      if (this.#closing) {
        throw new Error("Chat search provider is closing");
      }
      await this.#migration.wait(() => this.#waitForRedactions());
      const result = this.#enqueue(async () => {
        await this.#migration.wait(() => this.#reconcilePrivacy());
        await this.#migration.wait(() => this.#index.rebuild());
        await this.#migration.wait(() => this.#reconcilePrivacy());
      }, work);
      await this.#migration.wait(() => result);
      await this.#migration.wait(() => this.#waitForRedactions());
    }, migrationWork);
  }

  /**
   * Checks current source bytes before applying the global indexing preference.
   *
   * @param {string} id - Canonical log identity.
   * @param {object} [options={}] - Resolution options.
   * @param {AbortSignal} [options.signal] - Cancels delivery after queued I/O.
   * @returns {Promise<SearchDocumentState|{eligible: false}|null>} Current revision, disabled policy, or deleted.
   * @throws {Error} Original read errors other than a missing file.
   * @param {?object} [migrationWork=null] - Internal token from an actual pending same-domain operation.
   */
  async resolveDocument(id, { signal } = {}, migrationWork = null) {
    return this.#migration.run(async work => {
      signal = AbortSignal.any([
        this.#migration.deliverySignal,
        ...(signal ? [signal] : []),
      ]);
      const archive = await this.#migration.wait(() =>
        lazy.getChatLogArchive(work)
      );
      return this.#resolveDocument(id, { signal, archive });
    }, migrationWork);
  }

  /**
   * Replaces one log's semantic text only if its exact bytes are still current.
   * Missing files erase their text. Failures leave existing text stored, with
   * source-revision checks hiding stale rows. Explicit privacy erasure removes
   * stored text before reading source or checking indexing policy. Cancellation
   * does not undo an erasure or other commit already started.
   *
   * @param {string} filePath - Current logger path.
   * @param {object} [options={}] - Refresh options.
   * @param {AbortSignal} [options.signal] - Cancels delivery after queued reads.
   * @param {boolean} [options.eraseStoredText=false] - Erase the old semantic/FTS
   *   copy before refreshing a durably redacted source.
   * @returns {Promise<{id: string, indexed: boolean}>} Identity and publication result.
   * @throws {Error} Original I/O/cancellation/storage errors, or invalid source.
   * @throws {TypeError} For a non-boolean erasure option.
   * @param {?object} [migrationWork=null] - Internal token from an actual pending same-domain operation.
   */
  refreshLog(
    filePath,
    { signal, eraseStoredText = false } = {},
    migrationWork = null
  ) {
    return this.#migration.run(work => {
      const id = chatSearchDocumentId(filePath);
      if (typeof eraseStoredText != "boolean") {
        throw new TypeError("Chat stored-text erasure must be boolean");
      }
      if (this.#closing) {
        return Promise.reject(new Error("Chat search provider is closing"));
      }
      return this.#queueRefresh(id, filePath, signal, eraseStoredText, work);
    }, migrationWork);
  }

  /**
   * Queues an admitted refresh, including privacy work accepted before close.
   *
   * @param {string} id - Validated physical log identity.
   * @param {string} filePath - Validated current path.
   * @param {AbortSignal} [signal] - Cancels delivery after queued I/O.
   * @param {boolean} eraseStoredText - Erase old semantic text first.
   * @param {object} work - Actual pending refresh token.
   * @returns {Promise<{id: string, indexed: boolean}>} Publication result.
   */
  #queueRefresh(id, filePath, signal, eraseStoredText, work) {
    const result = this.#enqueue(async () => {
      signal?.throwIfAborted();
      // An explicit refresh may succeed without clearing an earlier read hold.
      if (!this.#privacyFailed) {
        await this.#migration.wait(() => this.#reconcilePrivacy());
      }
      if (eraseStoredText) {
        await this.#migration.wait(() => this.#index.remove(id));
      }
      signal?.throwIfAborted();
      return this.#refreshLog(id, filePath, signal);
    }, work);
    return result;
  }

  /**
   * Persists an explicit noLog/deleted update and erases affected stored text.
   * Registers pending work before durable capture and joins the original subject.
   * Awaits durable source and cache settlement for every captured target.
   * Lookups withhold delivery and retain the first live privacy failure.
   * Capture before its first durable write is not a recovered event.
   *
   * @param {prplIMessage} message - Existing notification with a real remoteId.
   * @returns {Promise<string[]>} All captured paths after source and cache writes.
   * @throws {Error} Original source/storage error, or closing provider.
   * @param {?object} [migrationWork=null] - Internal token from an actual pending same-domain operation.
   */
  redactMessage(message, migrationWork = null) {
    return this.#migration.run(work => {
      if (this.#closing) {
        return Promise.reject(new Error("Chat search provider is closing"));
      }
      const capture = this.#migration.wait(async () => {
        const archive = await lazy.getChatLogArchive(work);
        return archive.captureChatPrivacyIntent(message);
      });
      // Capture can fail while earlier writer work is still draining.
      capture.catch(() => {});
      this.#privacyRevision++;
      const result = this.#enqueue(async () => {
        const receipt = await this.#migration.wait(() => capture);
        return receipt ? this.#completePrivacyReceipt(receipt, true) : [];
      }, work);
      this.#redactions.add(result);
      result.then(
        () => this.#redactions.delete(result),
        error => {
          this.#redactions.delete(result);
          if (!this.#privacyFailed) {
            this.#privacyFailed = true;
            this.#privacyFailure = error;
          }
        }
      );
      return result;
    }, migrationWork);
  }

  /**
   * Drains observed redactions and preserves the first failure.
   *
   * @param {AbortSignal} [signal] - Cancels delivery after pending I/O.
   * @returns {Promise<void>} Resolves after source and sidecar writes.
   * @throws {Error} Cancellation reason or the original privacy failure.
   */
  async #waitForRedactions(signal) {
    signal?.throwIfAborted();
    while (this.#redactions.size) {
      await this.#migration.wait(() =>
        Promise.allSettled([...this.#redactions])
      );
      signal?.throwIfAborted();
    }
    if (this.#privacyFailed) {
      throw this.#privacyFailure;
    }
  }

  /**
   * Serializes a provider operation without converting its error to success.
   *
   * @param {function(): Promise} operation - Work using the dedicated writer.
   * @param {object} work - Actual pending caller that owns archive/parser work.
   * @returns {Promise} The original result; only queue advancement absorbs failure.
   */
  #enqueue(operation, work) {
    const result = this.#pending.then(async () => {
      const archive = await this.#migration.wait(() =>
        lazy.getChatLogArchive(work)
      );
      this.#archive = archive;
      try {
        return await operation();
      } finally {
        this.#archive = null;
      }
    });
    this.#pending = result.then(
      () => {},
      error => this.#rememberMigrationFailure(error)
    );
    return result;
  }

  /**
   * Erases source and all target cache rows before acknowledging a receipt.
   * Runs inside the provider queue; its callback must not reenter that queue.
   *
   * @param {{id: string, targets: object[]}} receipt - Validated logger receipt.
   * @param {boolean} [refresh=false] - Refresh kept text only for an observed update.
   *   Recovery replay leaves erased rows absent until an explicit refresh.
   * @returns {Promise<string[]>} Every target path, including already-erased source.
   * @throws {Error} Original source, index, proof or acknowledgment error.
   */
  async #completePrivacyReceipt(receipt, refresh = false) {
    let paths = [];
    await this.#migration.wait(() =>
      this.#archive.acknowledgeChatPrivacyIntent(receipt.id, async current => {
        paths = await this.#migration.wait(() =>
          lazy.applyChatSearchPrivacyReceipt(current, {
            archive: this.#archive,
          })
        );
        for (const path of paths) {
          const id = chatSearchDocumentId(path);
          await this.#migration.wait(() => this.#index.remove(id));
          if (refresh) {
            await this.#migration.wait(() => this.#refreshLog(id, path));
          }
        }
        return this.#archive.getChatPrivacySourceProof(current.id);
      })
    );
    return paths;
  }

  /**
   * Replays captured privacy work and validates retained version exclusions.
   * Empty pending state does not grant recovered or unknown history eligibility.
   * Runs inside the writer queue, or once before the provider is published.
   *
   * @returns {Promise<void>} Resolves after the known durable work settles.
   * @throws {Error} The first original privacy error for this provider instance.
   */
  async #reconcilePrivacy() {
    if (this.#privacyFailed) {
      throw this.#privacyFailure;
    }
    try {
      let state = await this.#migration.wait(() =>
        this.#archive.getChatPrivacyState()
      );
      for (;;) {
        for (const receipt of state.pending) {
          await this.#migration.wait(() =>
            this.#completePrivacyReceipt(receipt)
          );
        }
        for (const receipt of state.completed) {
          if (
            await this.#migration.wait(() =>
              lazy.chatSearchPrivacyNeedsErasure(receipt, {
                archive: this.#archive,
              })
            )
          ) {
            await this.#migration.wait(() =>
              this.#completePrivacyReceipt(receipt)
            );
          }
        }
        const next = await this.#migration.wait(() =>
          this.#archive.getChatPrivacyState()
        );
        if (!next.pending.length && next.epoch === state.epoch) {
          return;
        }
        state = next;
      }
    } catch (error) {
      if (!this.#privacyFailed) {
        this.#privacyFailed = true;
        this.#privacyFailure = error;
      }
      throw this.#privacyFailure;
    }
  }

  /**
   * Reads and publishes one log in provider queue order.
   *
   * @param {string} id - Validated log identity.
   * @param {string} filePath - Validated absolute path.
   * @param {AbortSignal} [signal] - Cancels result delivery.
   * @returns {Promise<{id: string, indexed: boolean}>} Publication result.
   */
  async #refreshLog(id, filePath, signal) {
    const state = await this.#migration.wait(() =>
      this.#resolveDocument(id, { signal })
    );
    if (!state) {
      await this.#migration.wait(() => this.#index.remove(id));
      signal?.throwIfAborted();
      return { id, indexed: false };
    }
    if (!state.eligible) {
      return { id, indexed: false };
    }
    const source = await this.#migration.wait(() =>
      readSource(filePath, signal, this.#archive)
    );
    const { conversation, messages } = await this.#migration.wait(() =>
      readLogConversation(filePath, source, signal, this.#archive)
    );
    const body = messages
      .map(message => {
        const who = message.alias || message.who;
        return (
          (who ? who + ": " : "") +
          lazy.plainText.convertMsgSnippetToPlainText(
            "<!DOCTYPE html>" + message.message
          )
        );
      })
      .join("\n\n");
    signal?.throwIfAborted();
    const indexed = await this.#migration.wait(() =>
      this.#index.index({
        id,
        generation: 0,
        policyRevision: 0,
        contentRevision: source.revision,
        subject: conversation.title,
        body,
        attachmentNames: "",
        author: "",
        recipients: "",
      })
    );
    signal?.throwIfAborted();
    return { id, indexed };
  }

  /**
   * Identifies an original file-read or transcript-parser refresh failure.
   * A privacy failure remains fatal even if its source read also failed.
   * Closing, cancellation and index/storage errors are not source rejections.
   *
   * @param {unknown} error - The original rejected refresh error.
   * @returns {boolean} Whether this rejected file can be skipped independently.
   */
  isSourceError(error) {
    return !this.#privacyFailed && !this.#closing && sourceFailures.has(error);
  }

  /**
   * Refreshes the active logger file after pending writes complete.
   * A noLog message or disabled writer never supplies in-memory text here.
   *
   * @param {prplIConversation} conversation - Active logged conversation.
   * @param {object} [options={}] - Refresh options passed to refreshLog.
   * @returns {Promise<Array<{id: string, indexed: boolean}>>} Empty for no writer.
   * @throws {Error} For rotating writers; cross-file redaction is not supported yet.
   * @param {?object} [migrationWork=null] - Internal token from an actual pending same-domain operation.
   */
  async refreshConversation(conversation, options = {}, migrationWork = null) {
    return this.#migration.run(async work => {
      options.signal?.throwIfAborted();
      const paths = await this.#migration.wait(() =>
        IMServices.logs.getLogPathsForConversation(conversation)
      );
      options.signal?.throwIfAborted();
      if (paths?.length > 1) {
        throw new Error(
          "Cross-file chat refresh requires logger edit/redaction support"
        );
      }
      return paths?.length
        ? [
            await this.#migration.wait(() =>
              this.refreshLog(paths[0], options, work)
            ),
          ]
        : [];
    }, migrationWork);
  }

  /**
   * Searches explicitly indexed transcripts using current logger revisions.
   * Earlier accepted refreshes drain first; later file edits hide stale hits.
   * Observed privacy changes invalidate an overlapping result. A caller may
   * retry after redaction completes. Privacy failures retain their original error.
   * This does not discover logs or activate a chat observer.
   *
   * @param {string} text - Search words or quoted phrases.
   * @param {object} [options={}] - Existing index query, paging and cancellation controls.
   * @returns {Promise<{items: SearchHit[], cursor: ?object, resultSetId: string}>}
   *   Eligible physical transcript hits, with opaque paging cursors.
   * @throws {Error} Original query/cancellation/storage error, or closing provider.
   * @param {?object} [migrationWork=null] - Internal token from an actual pending same-domain operation.
   */
  search(text, options = {}, migrationWork = null) {
    return this.#migration.run(work => {
      options = {
        ...options,
        signal: AbortSignal.any([
          this.#migration.deliverySignal,
          ...(options.signal ? [options.signal] : []),
        ]),
      };
      if (this.#closing) {
        return Promise.reject(new Error("Chat search provider is closing"));
      }
      const controls = { ...options };
      const epoch = lazy.getChatPrivacyEpoch();
      const revision = this.#redactions.size ? null : this.#privacyRevision;
      const result = this.#enqueue(async () => {
        controls.signal?.throwIfAborted();
        await this.#migration.wait(() => this.#reconcilePrivacy());
        const page = await this.#migration.wait(() =>
          this.#index.search(text, controls)
        );
        await this.#migration.wait(() => this.#reconcilePrivacy());
        controls.signal?.throwIfAborted();
        return page;
      }, work);
      return result.then(async page => {
        await this.#migration.wait(() =>
          this.#waitForRedactions(controls.signal)
        );
        if (
          revision !== this.#privacyRevision ||
          epoch !== lazy.getChatPrivacyEpoch()
        ) {
          throw new Error("Chat privacy changed during search");
        }
        if (
          !Services.prefs.getBoolPref(
            "mailnews.database.global.indexer.enabled",
            false
          )
        ) {
          return { ...page, items: [], cursor: null };
        }
        return page;
      });
    }, migrationWork);
  }

  /**
   * Resolves a captured hit to its current single physical log and conversation.
   * Rechecks source bytes, stored text token and policy before delivery. The log
   * has an absolute current path; it is not a Gloda relative-path result or a
   * grouped-day log. Readers must use the returned conversation, not reparse
   * the log unchecked. Persisted noLog records prevent opening the file.
   * A change between source validation and parsing returns a non-ready status;
   * unrelated parser failures still reject. An overlapping privacy update returns
   * stale; a failed redaction rejects with its original error.
   * No reader or network is opened.
   *
   * @param {SearchHit} hit - Captured transcript identity and exact revisions.
   * @param {object} [options={}] - Opening resolution controls.
   * @param {AbortSignal} [options.signal] - Cancel after queued logger operations.
   * @returns {Promise<{status: "ready", id: string, contentRevision: string,
   *   textRevision: string, log: Log, conversation: LogConversation} |
   *   {status: "deleted"|"ineligible"|"stale"}>}
   *   Ready objects, or deleted/ineligible/stale without substitute content.
   * @throws {TypeError} For an incomplete or noncanonical transcript token.
   * @throws {Error} Source I/O/parser errors, logger/cancellation failures, or closing provider.
   * @param {?object} [migrationWork=null] - Internal token from an actual pending same-domain operation.
   */
  resolveLog(hit, { signal } = {}, migrationWork = null) {
    return this.#migration.run(work => {
      signal = AbortSignal.any([
        this.#migration.deliverySignal,
        ...(signal ? [signal] : []),
      ]);
      const request = {
        id: hit?.id,
        contentRevision: hit?.contentRevision,
        textRevision: hit?.textRevision,
      };
      if (
        Object.values(request).some(value => typeof value != "string" || !value)
      ) {
        throw new TypeError("A current chat search hit is required");
      }
      const filePath = logPath(request.id);
      const revision = this.#redactions.size ? null : this.#privacyRevision;
      const epoch = lazy.getChatPrivacyEpoch();
      if (this.#closing) {
        return Promise.reject(new Error("Chat search provider is closing"));
      }
      const resolve = async () => {
        signal?.throwIfAborted();
        const state = await this.#migration.wait(() =>
          this.#resolveDocument(request.id, { signal })
        );
        signal?.throwIfAborted();
        if (!state) {
          return { status: "deleted" };
        }
        if (!state.eligible) {
          return { status: "ineligible" };
        }
        if (state.contentRevision !== request.contentRevision) {
          return { status: "stale" };
        }
        const text = await this.#migration.wait(() =>
          this.#index.getText(request.id, { signal })
        );
        signal?.throwIfAborted();
        if (
          !text ||
          text.textRevision !== request.textRevision ||
          text.contentRevision !== request.contentRevision
        ) {
          return { status: "stale" };
        }
        const source = await this.#migration.wait(() =>
          readSource(filePath, signal, this.#archive)
        );
        if (source.revision !== request.contentRevision) {
          return { status: "stale" };
        }
        let parsed;
        try {
          parsed = await this.#migration.wait(() =>
            readLogConversation(filePath, source, signal, this.#archive)
          );
        } catch (error) {
          if (!(error instanceof IncompleteChatTranscriptError)) {
            throw error;
          }
          let current;
          try {
            current = await this.#migration.wait(() =>
              this.#resolveDocument(request.id, { signal })
            );
          } catch (readError) {
            signal?.throwIfAborted();
            this.#rememberMigrationFailure(error);
            this.#rememberMigrationFailure(readError);
            throw error;
          }
          signal?.throwIfAborted();
          if (!current) {
            return { status: "deleted" };
          }
          if (!current.eligible) {
            return { status: "ineligible" };
          }
          if (current.contentRevision !== request.contentRevision) {
            return { status: "stale" };
          }
          throw error;
        }
        const { log, conversation, hasNoLogRecords } = parsed;
        if (hasNoLogRecords) {
          return { status: "ineligible" };
        }
        if (log.path !== filePath) {
          throw new Error(
            "Chat logger returned a different physical transcript"
          );
        }
        const current = await this.#migration.wait(() =>
          this.#resolveDocument(request.id, { signal })
        );
        signal?.throwIfAborted();
        if (!current) {
          return { status: "deleted" };
        }
        if (
          !current.eligible ||
          !Services.prefs.getBoolPref(
            "mailnews.database.global.indexer.enabled",
            false
          )
        ) {
          return { status: "ineligible" };
        }
        if (current.contentRevision !== request.contentRevision) {
          return { status: "stale" };
        }
        return { status: "ready", ...request, log, conversation };
      };
      const result = this.#enqueue(async () => {
        signal?.throwIfAborted();
        await this.#migration.wait(() => this.#reconcilePrivacy());
        const resolved = await this.#migration.wait(() => resolve());
        await this.#migration.wait(() => this.#reconcilePrivacy());
        return resolved;
      }, work);
      return result.then(async resolved => {
        await this.#migration.wait(() => this.#waitForRedactions(signal));
        return revision === this.#privacyRevision &&
          epoch === lazy.getChatPrivacyEpoch()
          ? resolved
          : { status: "stale" };
      });
    }, migrationWork);
  }

  /**
   * Reads eligible retained text through current source revision checks.
   * Returns null if observed redaction overlaps the read. Privacy failures reject
   * with their original error, including when source bytes did not change.
   *
   * @param {string} id - Canonical log identity.
   * @param {object} [options={}] - Existing index cancellation options.
   * @returns {Promise<?SearchDocument>} Current text, or null if stale/ineligible.
   * @param {?object} [migrationWork=null] - Internal token from an actual pending same-domain operation.
   */
  getText(id, options = {}, migrationWork = null) {
    return this.#migration.run(work => {
      options = {
        ...options,
        signal: AbortSignal.any([
          this.#migration.deliverySignal,
          ...(options.signal ? [options.signal] : []),
        ]),
      };
      logPath(id);
      if (this.#closing) {
        return Promise.reject(new Error("Chat search provider is closing"));
      }
      const revision = this.#redactions.size ? null : this.#privacyRevision;
      const epoch = lazy.getChatPrivacyEpoch();
      const result = this.#enqueue(async () => {
        options.signal?.throwIfAborted();
        await this.#migration.wait(() => this.#reconcilePrivacy());
        const text = await this.#migration.wait(() =>
          this.#index.getText(id, options)
        );
        await this.#migration.wait(() => this.#reconcilePrivacy());
        return text;
      }, work);
      return result.then(async text => {
        await this.#migration.wait(() =>
          this.#waitForRedactions(options.signal)
        );
        return revision === this.#privacyRevision &&
          epoch === lazy.getChatPrivacyEpoch()
          ? text
          : null;
      });
    }, migrationWork);
  }

  /**
   * Closes the dedicated writer after queued work and redactions drain.
   * Detach the observer first. A privacy failure still closes storage and rejects
   * with the original error, or both errors if storage close also fails.
   *
   * @returns {Promise<void>} Resolves after storage closes.
   * @throws {Error} First original privacy/storage failure; later errors are retained.
   */
  close() {
    this.#closing ??= this.#migration.finish(async () => {
      const errors = [];
      try {
        await this.#waitForRedactions();
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.#pending;
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.#index?.close();
        if (this.#index) {
          this.#storageTerminal = true;
        }
      } catch (error) {
        errors.push(error);
      }
      for (const error of errors) {
        this.#rememberMigrationFailure(error);
      }
      if (errors.length) {
        throw errors[0];
      }
    });
    return this.#closing;
  }

  async #resolveDocument(id, { signal, archive = this.#archive } = {}) {
    this.#migration.check();
    const filePath = logPath(id);
    signal?.throwIfAborted();
    try {
      const source = await this.#migration.wait(() =>
        readSource(filePath, signal, archive)
      );
      if (
        !Services.prefs.getBoolPref(
          "mailnews.database.global.indexer.enabled",
          false
        )
      ) {
        return { eligible: false };
      }
      // The logger has no incarnation counter; exact bytes carry its revision.
      return {
        eligible: true,
        generation: 0,
        policyRevision: 0,
        contentRevision: source.revision,
        location: null,
        originalContentAvailable: true,
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (error.name == "NotFoundError") {
        return null;
      }
      throw error;
    }
  }
}
