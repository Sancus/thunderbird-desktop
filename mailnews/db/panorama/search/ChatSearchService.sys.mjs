/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AsyncShutdown } from "resource://gre/modules/AsyncShutdown.sys.mjs";
import { IMServices } from "resource:///modules/IMServices.sys.mjs";
import { encodeName, gFilePromises } from "resource:///modules/logger.sys.mjs";

import {
  ChatSearchProvider,
  chatSearchDocumentId,
} from "resource:///modules/panorama/ChatSearchProvider.sys.mjs";
import { ChatSearchRedactionObserver } from "resource:///modules/panorama/ChatSearchRedactionObserver.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  MailServices: "resource:///modules/MailServices.sys.mjs",
});

/**
 * Delivers actual logger files to the separate native transcript provider.
 * Captures physical scope before conversation close and reads source through
 * the existing logger file queues, independently of observer notification order. No message payload
 * is copied from a notification. Privacy work uses the accepted durable observer.
 */
export class ChatSearchService {
  QueryInterface = ChromeUtils.generateQI(["nsIObserver"]);
  #provider;
  #privacy;
  #onError;
  #pending = Promise.resolve();
  #failed = false;
  #failure;
  #started = false;
  #closing = null;
  #shutdown = () => this.close();

  /**
   * Opens the sidecar and resumes current physical logs before returning.
   * A failed start closes its writer and preserves the original error.
   *
   * @param {nsIFile} file - Dedicated chat sidecar, never the mail database.
   * @param {object} [options={}] - Background error reporting.
   * @param {function(unknown): void} [options.onError=console.error] - Reports failures.
   * @returns {Promise<ChatSearchService>} Started provider/observer owner.
   * @throws {Error} Original open/start error, or both start and close errors.
   */
  static async open(file, { onError = console.error } = {}) {
    if (typeof onError != "function") {
      throw new TypeError("A chat search error reporter is required");
    }
    // Initialize the real logger before registering the addition observer.
    IMServices.logs;
    const provider = await ChatSearchProvider.open(file);
    const service = new ChatSearchService(provider, onError);
    try {
      await service.#start();
    } catch (error) {
      try {
        await service.close();
      } catch (closeError) {
        if (closeError !== error) {
          throw new AggregateError(
            [error, closeError],
            "Chat search start and close failed"
          );
        }
      }
      throw error;
    }
    return service;
  }

  /**
   * @param {ChatSearchProvider} provider - Writer owned by this service.
   * @param {function(unknown): void} onError - Reports background failures.
   */
  constructor(provider, onError) {
    this.#provider = provider;
    this.#onError = onError;
    this.#privacy = new ChatSearchRedactionObserver(provider, { onError });
  }

  /**
   * Registers delivery before sweeping, so additions during startup are retained.
   * Existing physical source paths/headers carry identity before FTS publication.
   *
   * @returns {Promise<void>} Initial current-log refresh.
   */
  #start() {
    AsyncShutdown.profileBeforeChange.addBlocker(
      "Panorama chat search",
      this.#shutdown
    );
    let observed = false;
    try {
      this.#privacy.start();
      Services.obs.addObserver(this, "new-text");
      observed = true;
      Services.prefs.addObserver(
        "mailnews.database.global.indexer.enabled",
        this
      );
      this.#started = true;
    } catch (error) {
      if (observed) {
        Services.obs.removeObserver(this, "new-text");
      }
      AsyncShutdown.profileBeforeChange.removeBlocker(this.#shutdown);
      throw error;
    }
    return this.#enqueue(() => this.#refreshLogs());
  }

  /**
   * Sweeps the logger's existing source files, preserving callback read errors.
   * Foreign JSON filenames are not native transcript identities.
   *
   * @returns {Promise<void>} Resolves after current source refreshes.
   */
  async #refreshLogs() {
    let failed = false;
    let failure;
    try {
      await IMServices.logs.forEach({
        processLog: async path => {
          try {
            chatSearchDocumentId(path);
          } catch (error) {
            if (error instanceof TypeError) {
              return;
            }
            throw error;
          }
          try {
            await this.#refreshLog(path);
          } catch (error) {
            // Logger.forEach tolerates DOMExceptions from directory traversal.
            // A provider/source failure must instead reject with its own error.
            failed = true;
            failure = error;
            throw new Error("Chat source refresh failed", { cause: error });
          }
        },
      });
    } catch (error) {
      throw failed ? failure : error;
    }
  }

  /**
   * Reports a rejected source file without withholding unrelated transcripts.
   * Provider-wide privacy, closing and index/storage errors remain fatal.
   *
   * @param {string} path - Actual physical logger file.
   * @returns {Promise<void>} Refresh completion or per-file rejection report.
   * @throws {Error} Original provider-wide failure.
   */
  async #refreshLog(path) {
    try {
      await this.#provider.refreshLog(path);
    } catch (error) {
      if (!this.#provider.isSourceError(error)) {
        throw error;
      }
      this.#reportError(error);
    }
  }

  /**
   * Sends the original error to the caller without replacing it if reporting fails.
   *
   * @param {unknown} error - Original source or provider failure.
   */
  #reportError(error) {
    try {
      this.#onError(error);
    } catch (reportError) {
      console.error(
        new AggregateError(
          [error, reportError],
          "Chat search error reporting failed"
        )
      );
    }
  }

  /**
   * Captures physical directory and any existing writer paths without text.
   * Joins actual logger writes after the synchronous notification has completed.
   *
   * @param {prplIMessage|nsISupports} subject - Original notification subject.
   * @param {string} topic - Existing message or preference notification.
   */
  observe(subject, topic) {
    if (!this.#started || this.#closing) {
      return;
    }
    if (topic == "nsPref:changed") {
      this.#enqueue(() => this.#refreshLogs());
      return;
    }
    if (
      topic != "new-text" ||
      subject.noLog === true ||
      subject.deleted === true
    ) {
      return;
    }
    let paths;
    let folder;
    try {
      const conversation = subject.conversation;
      // Observer order is not producer order. On a first message the logger may
      // not have created its writer yet. Copy only the physical directory now;
      // the logger will queue its actual file/header before this job runs.
      folder = PathUtils.join(
        IMServices.logs.getLogFolderPathForAccount(conversation.account),
        encodeName(
          conversation.normalizedName + (conversation.isChat ? ".chat" : "")
        )
      );
      paths = IMServices.logs.getLogPathsForConversation(conversation);
    } catch (error) {
      paths = Promise.reject(error);
    }
    paths.catch(() => {});
    this.#enqueue(async () => {
      const files = new Set((await paths) || []);
      // These are actual existing logger operations, not a reconstructed file
      // name. They survive a synchronous conversation-close removing its writer.
      const folders = new Set([
        folder,
        ...Array.from(files, path => PathUtils.parent(path)),
      ]);
      const failedPaths = new Set();
      const pending = Array.from(gFilePromises.entries()).filter(([path]) =>
        folders.has(PathUtils.parent(path))
      );
      for (const [path, promise] of pending) {
        files.add(path);
        try {
          await promise;
        } catch (error) {
          files.delete(path);
          failedPaths.add(path);
          this.#reportError(error);
        }
      }
      let children;
      try {
        children = await IOUtils.getChildren(folder);
      } catch (error) {
        if (error.name != "NotFoundError") {
          throw error;
        }
        children = [];
      }
      for (const path of children) {
        try {
          chatSearchDocumentId(path);
          if (!failedPaths.has(path)) {
            files.add(path);
          }
        } catch (error) {
          if (!(error instanceof TypeError)) {
            throw error;
          }
        }
      }
      for (const path of files) {
        await this.#refreshLog(path);
      }
    });
  }

  /**
   * Serializes refreshes and retains the first error without stalling the queue.
   *
   * @param {function(): Promise<void>} operation - Owned source/index work.
   * @returns {Promise<void>} Original operation result.
   */
  #enqueue(operation) {
    const result = this.#pending.then(operation);
    this.#pending = result.then(
      () => {},
      error => {
        if (!this.#failed) {
          this.#failed = true;
          this.#failure = error;
        }
        this.#reportError(error);
      }
    );
    return result;
  }

  /**
   * Drains additions and privacy work, preserving the first refresh failure.
   *
   * @returns {Promise<void>} Resolves after currently observed source writes.
   */
  async flush() {
    for (;;) {
      const pending = this.#pending;
      await pending;
      await this.#privacy.flush();
      if (pending === this.#pending) {
        break;
      }
    }
    if (this.#failed) {
      throw this.#failure;
    }
  }

  /**
   * Searches after observed source and privacy updates have drained.
   *
   * @param {string} text - Existing provider query words.
   * @param {object} [options] - Existing provider query controls.
   * @returns {Promise<object>} Current physical transcript results.
   */
  async search(text, options) {
    await this.flush();
    return this.#provider.search(text, options);
  }

  /**
   * Reads retained text after observed source and privacy updates have drained.
   *
   * @param {string} id - Canonical physical transcript identity.
   * @param {object} [options] - Existing provider read controls.
   * @returns {Promise<?SearchDocument>} Current eligible transcript or null.
   */
  async getText(id, options) {
    await this.flush();
    return this.#provider.getText(id, options);
  }

  /**
   * Detaches before draining and closes the owned provider once.
   * A failure still closes storage and remains rejected on subsequent closes.
   *
   * @returns {Promise<void>} Shared drain/close completion.
   */
  close() {
    if (!this.#closing) {
      if (this.#started) {
        Services.obs.removeObserver(this, "new-text");
        Services.prefs.removeObserver(
          "mailnews.database.global.indexer.enabled",
          this
        );
        this.#started = false;
      }
      this.#closing = (async () => {
        const errors = [];
        try {
          await this.#privacy.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await this.flush();
        } catch (error) {
          if (!errors.includes(error)) {
            errors.push(error);
          }
        }
        try {
          await this.#provider.close();
        } catch (error) {
          if (!errors.includes(error)) {
            errors.push(error);
          }
        } finally {
          AsyncShutdown.profileBeforeChange.removeBlocker(this.#shutdown);
        }
        if (errors.length == 1) {
          throw errors[0];
        }
        if (errors.length) {
          throw new AggregateError(
            errors,
            "Chat search drain and close failed"
          );
        }
      })();
    }
    return this.#closing;
  }
}

/** @type {?{promise: Promise<ChatSearchService>, closePromise: ?Promise<void>}} */
let current = null;

/**
 * Opens one shared native chat sidecar for the current profile.
 *
 * @returns {Promise<ChatSearchService>} Shared service, including its initial sweep.
 * @throws {Error} Original open error, or shutdown/closing refusal.
 */
export function getChatSearchService() {
  if (Services.startup.shuttingDown || current?.closePromise) {
    throw Components.Exception(
      "Chat search is shutting down",
      Cr.NS_ERROR_NOT_AVAILABLE
    );
  }
  lazy.MailServices.accounts;
  const backend = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  if (!("nsIDatabaseCore" in Ci) || !(backend instanceof Ci.nsIDatabaseCore)) {
    throw Components.Exception(
      "Chat search requires the active native database",
      Cr.NS_ERROR_NOT_AVAILABLE
    );
  }
  if (!current) {
    const file = Services.dirsvc.get("ProfD", Ci.nsIFile).clone();
    file.append("panorama-chat-search.sqlite");
    current = { promise: ChatSearchService.open(file), closePromise: null };
  }
  return current.promise;
}

/**
 * Drains the shared service, including an unfinished initial open.
 * A failed open or close stays failed; no replacement writer hides that error.
 *
 * @returns {Promise<void>} Shared close completion, or no work if never opened.
 */
export function closeChatSearch() {
  if (!current) {
    return Promise.resolve();
  }
  const entry = current;
  entry.closePromise ??= entry.promise
    .then(service => service.close())
    .then(() => {
      if (current === entry) {
        current = null;
      }
    });
  return entry.closePromise;
}
