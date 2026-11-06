/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  SearchWriter,
  recordSearchWriterFailure,
} from "resource:///modules/panorama/SearchMigrationHold.sys.mjs";

import { AsyncShutdown } from "resource://gre/modules/AsyncShutdown.sys.mjs";

/**
 * Persists explicit chat privacy updates from the existing new-text notification,
 * then erases and refreshes affected existing search documents.
 * UIConversation forwards edited/deleted messages through that same topic.
 * Display-only remove-text and ordinary messages do not trigger a redaction.
 *
 * Startup is explicit and is not wired into MailGlue. Passing the original
 * subject lets the provider join the logger's durable privacy capture. The
 * provider withholds lookups until source and cache work settles. This observer
 * does not authorize unknown history or index ordinary transcript additions.
 */
export class ChatSearchRedactionObserver {
  /** @type {SearchWriter} Concrete retained observer/service lifetime. */
  #migration;
  /** @returns {boolean} Actual observer detachment and pending-work settlement. */
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

  QueryInterface = ChromeUtils.generateQI(["nsIObserver"]);
  /** @type {ChatSearchProvider} */
  #provider;
  /** @type {function(unknown): void} */
  #onError;
  /** @type {Set<Promise<string[]>>} */
  #pending = new Set();
  /** @type {unknown} */
  #failure;
  #failed = false;
  #started = false;
  /** @type {?Promise<void>} */
  #closing = null;
  #shutdown = () => this.close();

  /**
   * @param {ChatSearchProvider} provider - Existing owned chat sidecar writer.
   * @param {object} [options={}] - Error reporting.
   * @param {function(unknown): void} [options.onError=console.error] - Reports each original failure.
   * @param {?object} [migrationWork=null] - Internal token from an actual pending same-domain operation.
   */
  constructor(
    provider,
    { onError = console.error } = {},
    migrationWork = null
  ) {
    if (
      typeof provider?.redactMessage != "function" ||
      typeof onError != "function"
    ) {
      throw new TypeError("A chat provider and error reporter are required");
    }
    this.#migration = new SearchWriter(
      "chat-search",
      () => this.#stopMigrationNotifications(),
      () => this.close(),
      () => !this.#started && this.#pending.size === 0,
      migrationWork
    );
    this.#provider = provider;
    this.#onError = onError;
  }

  /** Registers the existing notification and shutdown barrier once.
   * @param {?object} [migrationWork=null] - Internal token from an actual pending same-domain operation.
   */
  start(migrationWork = null) {
    return this.#migration.run(() => {
      if (this.#closing) {
        throw new Error("Chat privacy observer is closing");
      }
      if (this.#started) {
        return;
      }
      AsyncShutdown.profileBeforeChange.addBlocker(
        "Panorama chat privacy",
        this.#shutdown
      );
      try {
        Services.obs.addObserver(this, "new-text");
      } catch (error) {
        AsyncShutdown.profileBeforeChange.removeBlocker(this.#shutdown);
        throw error;
      }
      this.#started = true;
    }, migrationWork);
  }

  /**
   * Captures logger paths synchronously, before a later conversation-close can
   * remove its writer. The redaction helper copies identity before its first await
   * and joins existing logger file operations. Only privacy flags, remoteId and
   * conversation pass to the redaction helper.
   *
   * @param {prplIMessage} subject - Existing global new-text notification.
   * @param {string} topic - Only new-text is registered.
   */
  observe(subject, topic) {
    return this.#migration.run(work => {
      if (!this.#started || topic != "new-text") {
        return;
      }
      let redaction;
      try {
        if (
          (subject.noLog !== true && subject.deleted !== true) ||
          !subject.remoteId
        ) {
          return;
        }
        redaction = this.#provider.redactMessage(subject, work);
      } catch (error) {
        redaction = Promise.reject(error);
      }
      const pending = redaction;
      this.#pending.add(pending);
      pending.then(
        () => this.#pending.delete(pending),
        error => {
          this.#pending.delete(pending);
          this.#rememberMigrationFailure(error);
          if (!this.#failed) {
            this.#failure = error;
            this.#failed = true;
          }
          try {
            this.#onError(error);
          } catch (reportError) {
            console.error(
              new AggregateError(
                [error, reportError],
                "Chat privacy error reporting failed"
              )
            );
          }
        }
      );
    });
  }

  /**
   * Drains currently observed privacy work and rethrows the first failure.
   * Later successful work does not silently clear an earlier privacy hold.
   *
   * @returns {Promise<void>} Resolves after observed source and sidecar writes.
   */
  async flush() {
    while (this.#pending.size) {
      await Promise.allSettled([...this.#pending]);
    }
    if (this.#failed) {
      throw this.#failure;
    }
  }

  /**
   * Detaches before draining, so shutdown cannot acknowledge unfinished privacy
   * work. Does not close the caller-owned provider or roll back completed writes.
   *
   * @returns {Promise<void>} One drain/close promise, preserving the first failure.
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
        await this.flush();
      } catch (error) {
        errors.push(error);
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
      this.#started = false;
    }
  }
}
