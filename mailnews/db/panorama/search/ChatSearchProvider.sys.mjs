/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { IMServices } from "resource:///modules/IMServices.sys.mjs";
import {
  encodeName,
  queueFileOperation,
} from "resource:///modules/logger.sys.mjs";
import { PanoramaSearchIndex } from "resource:///modules/panorama/PanoramaSearchIndex.sys.mjs";

const lazy = {};
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
 * @param {AbortSignal} [signal] - Cancels delivery, not queued logger I/O.
 * @returns {Promise<{bytes: Uint8Array, revision: string}>} Bytes and SHA-256 digest.
 */
async function readSource(filePath, signal) {
  signal?.throwIfAborted();
  const bytes = await queueFileOperation(filePath, () =>
    IOUtils.read(filePath)
  );
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
 * @returns {{title: string, messages: {who: string, text: string}[]}} Source text used to check the parser.
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
    encodeName(header.account) != parts[1] ||
    encodeName(header.normalizedName + (header.isChat ? ".chat" : "")) !=
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

/**
 * Refreshes individual logger files in a separate search sidecar.
 * The logger supplies edit/deletion filtering and HTML/speaker normalization
 * matches index_im. No mail identity, encrypted-MIME policy or Gloda is used.
 *
 * Callers supply changed files, or an active conversation whose writer has one
 * file. This class does not subscribe to observers or discover historical logs.
 * Cross-file edits and persistent noLog invalidation need logger support before
 * activation. Recovered text without verified log policy is not accepted here.
 */
export class ChatSearchProvider {
  /** @type {PanoramaSearchIndex} */
  #index;
  /** @type {Promise<void>} */
  #pending = Promise.resolve();
  /** @type {?Promise<void>} */
  #closing = null;

  /**
   * Opens an independent chat sidecar using the existing FTS3 writer/tokenizer.
   *
   * @param {nsIFile} file - Dedicated chat search database, never the mail sidecar.
   * @returns {Promise<ChatSearchProvider>} Provider with fresh log-state resolution.
   */
  static async open(file) {
    const provider = new ChatSearchProvider();
    provider.#index = await PanoramaSearchIndex.open(file, (id, signal) =>
      provider.resolveDocument(id, { signal })
    );
    return provider;
  }

  /**
   * Checks current source bytes before applying the global indexing preference.
   *
   * @param {string} id - Canonical log identity.
   * @param {object} [options={}] - Resolution options.
   * @param {AbortSignal} [options.signal] - Cancels delivery after queued I/O.
   * @returns {Promise<SearchDocumentState|{eligible: false}|null>} Current revision, disabled policy, or deleted.
   * @throws {Error} Original read errors other than a missing file.
   */
  async resolveDocument(id, { signal } = {}) {
    const filePath = logPath(id);
    signal?.throwIfAborted();
    try {
      const source = await readSource(filePath, signal);
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

  /**
   * Replaces one log's semantic text only if its exact bytes are still current.
   * Missing files erase their text. Failures leave existing text stored, with
   * source-revision checks hiding stale rows. Cancellation does not undo a commit.
   *
   * @param {string} filePath - Current logger path.
   * @param {object} [options={}] - Refresh options.
   * @param {AbortSignal} [options.signal] - Cancels delivery after queued reads.
   * @returns {Promise<{id: string, indexed: boolean}>} Identity and publication result.
   * @throws {Error} Original I/O/cancellation/storage errors, or invalid source.
   */
  refreshLog(filePath, { signal } = {}) {
    const id = chatSearchDocumentId(filePath);
    if (this.#closing) {
      return Promise.reject(new Error("Chat search provider is closing"));
    }
    const result = this.#pending.then(() =>
      this.#refreshLog(id, filePath, signal)
    );
    this.#pending = result.then(
      () => {},
      () => {}
    );
    return result;
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
    const state = await this.resolveDocument(id, { signal });
    if (!state) {
      await this.#index.remove(id);
      signal?.throwIfAborted();
      return { id, indexed: false };
    }
    if (!state.eligible) {
      return { id, indexed: false };
    }
    const source = await readSource(filePath, signal);
    const expected = validateSource(source.bytes, logComponents(filePath));
    const log = await IMServices.logs.getLogFromFile(filePath);
    const conversation = await log.getConversation();
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
      throw new Error(
        "Chat logger did not return the complete source transcript"
      );
    }
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
    const indexed = await this.#index.index({
      id,
      generation: 0,
      policyRevision: 0,
      contentRevision: source.revision,
      subject: conversation.title,
      body,
      attachmentNames: "",
      author: "",
      recipients: "",
    });
    signal?.throwIfAborted();
    return { id, indexed };
  }

  /**
   * Refreshes the active logger file after pending writes complete.
   * A noLog message or disabled writer never supplies in-memory text here.
   *
   * @param {prplIConversation} conversation - Active logged conversation.
   * @param {object} [options={}] - Refresh options passed to refreshLog.
   * @returns {Promise<Array<{id: string, indexed: boolean}>>} Empty for no writer.
   * @throws {Error} For rotating writers; cross-file redaction is not supported yet.
   */
  async refreshConversation(conversation, options = {}) {
    options.signal?.throwIfAborted();
    const paths =
      await IMServices.logs.getLogPathsForConversation(conversation);
    options.signal?.throwIfAborted();
    if (paths?.length > 1) {
      throw new Error(
        "Cross-file chat refresh requires logger edit/redaction support"
      );
    }
    return paths?.length ? [await this.refreshLog(paths[0], options)] : [];
  }

  /**
   * Reads eligible retained text through current source revision checks.
   *
   * @param {string} id - Canonical log identity.
   * @param {object} [options={}] - Existing index cancellation options.
   * @returns {Promise<?SearchDocument>} Current text, or null if stale/ineligible.
   */
  getText(id, options = {}) {
    logPath(id);
    return this.#index.getText(id, options);
  }

  /**
   * Closes the dedicated writer after queued work drains.
   *
   * @returns {Promise<void>} Resolves after storage closes.
   */
  close() {
    this.#closing ??= this.#pending.then(() => this.#index.close());
    return this.#closing;
  }
}
