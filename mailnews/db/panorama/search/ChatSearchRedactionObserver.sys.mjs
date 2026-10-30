/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AsyncShutdown } from "resource://gre/modules/AsyncShutdown.sys.mjs";

/**
 * Persists explicit chat privacy updates from the existing new-text notification,
 * then erases and refreshes affected existing search documents.
 * UIConversation forwards edited/deleted messages through that same topic.
 * Display-only remove-text and ordinary messages do not trigger a redaction.
 *
 * Startup is explicit and is not wired into MailGlue. The provider withholds
 * lookups during observed redactions. Full activation remains held for durable
 * missed-event delivery and historical mapping; a failed flush preserves that hold.
 * Ordinary change indexing is separate.
 */
export class ChatSearchRedactionObserver {
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
   */
  constructor(provider, { onError = console.error } = {}) {
    if (
      typeof provider?.redactMessage != "function" ||
      typeof onError != "function"
    ) {
      throw new TypeError("A chat provider and error reporter are required");
    }
    this.#provider = provider;
    this.#onError = onError;
  }

  /** Registers the existing notification and shutdown barrier once. */
  start() {
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
      redaction = this.#provider.redactMessage({
        noLog: subject.noLog,
        deleted: subject.deleted,
        remoteId: subject.remoteId,
        conversation: subject.conversation,
      });
    } catch (error) {
      redaction = Promise.reject(error);
    }
    const work = redaction;
    this.#pending.add(work);
    work.then(
      () => this.#pending.delete(work),
      error => {
        this.#pending.delete(work);
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
    if (!this.#closing) {
      if (this.#started) {
        Services.obs.removeObserver(this, "new-text");
        this.#started = false;
      }
      this.#closing = this.flush().finally(() =>
        AsyncShutdown.profileBeforeChange.removeBlocker(this.#shutdown)
      );
    }
    return this.#closing;
  }
}
