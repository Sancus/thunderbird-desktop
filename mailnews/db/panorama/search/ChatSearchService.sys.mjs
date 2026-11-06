/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  openSearchWriter,
  runSearchWriterOperation,
  waitForSearchWriter,
  SearchWriter,
  recordSearchWriterFailure,
} from "resource:///modules/panorama/SearchMigrationHold.sys.mjs";

import { AsyncShutdown } from "resource://gre/modules/AsyncShutdown.sys.mjs";
import { IMServices } from "resource:///modules/IMServices.sys.mjs";

import {
  ChatSearchProvider,
  chatSearchDocumentId,
} from "resource:///modules/panorama/ChatSearchProvider.sys.mjs";
import { ChatSearchRedactionObserver } from "resource:///modules/panorama/ChatSearchRedactionObserver.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  encodeName: "resource:///modules/logger.sys.mjs",
  gFilePromises: "resource:///modules/logger.sys.mjs",
  getChatLogArchive: "resource:///modules/logger.sys.mjs",
  MailServices: "resource:///modules/MailServices.sys.mjs",
});

/**
 * Delivers actual logger files to the separate native transcript provider.
 * Captures physical scope before conversation close and reads source through
 * the existing logger file queues, independently of observer notification order. No message payload
 * is copied from a notification. Privacy work uses the accepted durable observer.
 */
export class ChatSearchService {
  /** @type {SearchWriter} Concrete retained observer/service lifetime. */
  #migration;
  /** @returns {boolean} Whether the actual owned storage close succeeded. */
  get closed() {
    return this.#migration.closed;
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
   * @param {?object} [migrationWork=null] - Internal token from an actual pending same-domain operation.
   */
  static open(file, { onError = console.error } = {}, migrationWork = null) {
    return openSearchWriter(
      "chat-search",
      async work => {
        if (typeof onError != "function") {
          throw new TypeError("A chat search error reporter is required");
        }
        // The provisional open owns archive reads without starting a live logger.
        const provider = await waitForSearchWriter(work, () =>
          ChatSearchProvider.open(file, work)
        );
        const service = new ChatSearchService(provider, onError, work);
        try {
          await service.#migration.wait(() => service.#start(work));
          return service;
        } catch (error) {
          service.#rememberMigrationFailure(error);
          try {
            await service.close();
          } catch (closeError) {
            service.#rememberMigrationFailure(closeError);
          }
          throw error;
        }
      },
      migrationWork
    );
  }

  /**
   * @param {ChatSearchProvider} provider - Writer owned by this service.
   * @param {function(unknown): void} onError - Reports background failures.
   * @param {?object} [migrationWork=null] - Internal token from an actual pending same-domain operation.
   */
  constructor(provider, onError, migrationWork = null) {
    this.#migration = new SearchWriter(
      "chat-search",
      () => this.#stopMigrationNotifications(),
      () => this.close(),
      () =>
        !this.#started &&
        this.#provider?.migrationSettled === true &&
        this.#privacy?.migrationSettled === true,
      migrationWork
    );
    this.#provider = provider;
    this.#onError = onError;
    this.#privacy = new ChatSearchRedactionObserver(
      provider,
      { onError },
      migrationWork
    );
  }

  /**
   * Registers delivery before sweeping, so additions during startup are retained.
   * Existing physical source paths/headers carry identity before FTS publication.
   *
   * @returns {Promise<void>} Initial current-log refresh.
   * @param {?object} [work] - Internal token from an actual pending same-domain operation.
   */
  #start(work) {
    AsyncShutdown.profileBeforeChange.addBlocker(
      "Panorama chat search",
      this.#shutdown
    );
    let observed = false;
    try {
      this.#privacy.start(work);
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
    return this.#enqueue(work => this.#refreshLogs(work), work);
  }

  /**
   * Sweeps the logger's existing source files, preserving callback read errors.
   * Foreign JSON filenames are not native transcript identities.
   *
   * @returns {Promise<void>} Resolves after current source refreshes.
   * @param {?object} [work] - Internal token from an actual pending same-domain operation.
   */
  async #refreshLogs(work) {
    let failed = false;
    let failure;
    try {
      const archive = await waitForSearchWriter(work, () =>
        lazy.getChatLogArchive(work)
      );
      await this.#migration.wait(() =>
        archive.forEach({
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
              await this.#migration.wait(() => this.#refreshLog(path, work));
            } catch (error) {
              // Logger.forEach tolerates DOMExceptions from directory traversal.
              // A provider/source failure must instead reject with its own error.
              failed = true;
              failure = error;
              throw new Error("Chat source refresh failed", { cause: error });
            }
          },
        })
      );
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
   * @param {?object} [work] - Internal token from an actual pending same-domain operation.
   */
  async #refreshLog(path, work) {
    try {
      await this.#migration.wait(() =>
        this.#provider.refreshLog(path, {}, work)
      );
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
    return this.#migration.run(work => {
      if (!this.#started || this.#closing) {
        return;
      }
      if (topic == "nsPref:changed") {
        this.#enqueue(work => this.#refreshLogs(work), work);
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
          lazy.encodeName(
            conversation.normalizedName + (conversation.isChat ? ".chat" : "")
          )
        );
        paths = IMServices.logs.getLogPathsForConversation(conversation);
      } catch (error) {
        paths = Promise.reject(error);
      }
      paths.catch(() => {});
      this.#enqueue(async work => {
        const files = new Set((await this.#migration.wait(() => paths)) || []);
        // These are actual existing logger operations, not a reconstructed file
        // name. They survive a synchronous conversation-close removing its writer.
        const folders = new Set([
          folder,
          ...Array.from(files, path => PathUtils.parent(path)),
        ]);
        const failedPaths = new Set();
        const pending = Array.from(lazy.gFilePromises.entries()).filter(
          ([path]) => folders.has(PathUtils.parent(path))
        );
        for (const [path, promise] of pending) {
          files.add(path);
          try {
            await this.#migration.wait(() => promise);
          } catch (error) {
            files.delete(path);
            failedPaths.add(path);
            this.#rememberMigrationFailure(error);
            this.#reportError(error);
          }
        }
        let children;
        try {
          children = await this.#migration.wait(() =>
            IOUtils.getChildren(folder)
          );
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
          await this.#migration.wait(() => this.#refreshLog(path, work));
        }
      }, work);
    });
  }

  /**
   * Serializes refreshes and retains the first error without stalling the queue.
   *
   * @param {function(): Promise<void>} operation - Owned source/index work.
   * @returns {Promise<void>} Original operation result.
   * @param {?object} [work] - Internal token from an actual pending same-domain operation.
   */
  #enqueue(operation, work) {
    const result = this.#migration.run(
      work => this.#pending.then(() => operation(work)),
      work
    );
    this.#pending = result.then(
      () => {},
      error => {
        this.#rememberMigrationFailure(error);
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
   * @param {?object} [migrationWork=null] - Internal token from an actual pending same-domain operation.
   */
  async search(text, options, migrationWork = null) {
    return this.#migration.run(async work => {
      await this.#migration.wait(() => this.flush());
      return this.#provider.search(text, options, work);
    }, migrationWork);
  }

  /**
   * Reads retained text after observed source and privacy updates have drained.
   *
   * @param {string} id - Canonical physical transcript identity.
   * @param {object} [options] - Existing provider read controls.
   * @returns {Promise<?SearchDocument>} Current eligible transcript or null.
   * @param {?object} [migrationWork=null] - Internal token from an actual pending same-domain operation.
   */
  async getText(id, options, migrationWork = null) {
    return this.#migration.run(async work => {
      await this.#migration.wait(() => this.flush());
      return this.#provider.getText(id, options, work);
    }, migrationWork);
  }

  /**
   * Detaches before draining and closes the owned provider once.
   * A failure still closes storage and remains rejected on subsequent closes.
   *
   * @returns {Promise<void>} Shared drain/close completion.
   */
  close() {
    this.#closing ??= this.#migration.finish(async () => {
      const errors = [];
      try {
        this.#stopMigrationNotifications();
      } catch (error) {
        errors.push(error);
      }
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
      }
      try {
        AsyncShutdown.profileBeforeChange.removeBlocker(this.#shutdown);
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

  /** Detaches new notifications without discarding captured work. */
  #stopMigrationNotifications() {
    if (this.#started) {
      Services.obs.removeObserver(this, "new-text");
      Services.prefs.removeObserver(
        "mailnews.database.global.indexer.enabled",
        this
      );
      this.#started = false;
    }
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
  return runSearchWriterOperation("chat-search", work => {
    if (current?.service?.closed) {
      current = null;
    }
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
    if (
      !("nsIDatabaseCore" in Ci) ||
      !(backend instanceof Ci.nsIDatabaseCore)
    ) {
      throw Components.Exception(
        "Chat search requires the active native database",
        Cr.NS_ERROR_NOT_AVAILABLE
      );
    }
    if (!current) {
      const file = Services.dirsvc.get("ProfD", Ci.nsIFile).clone();
      file.append("panorama-chat-search.sqlite");
      current = {
        promise: ChatSearchService.open(file, {}, work).then(service => {
          current.service = service;
          return service;
        }),
        closePromise: null,
      };
    }
    return current.promise;
  });
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
