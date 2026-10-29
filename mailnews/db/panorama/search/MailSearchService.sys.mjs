/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { completeMailSearchMetadata } from "resource:///modules/panorama/MailSearchCompletion.sys.mjs";
import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { AsyncShutdown } from "resource://gre/modules/AsyncShutdown.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { PanoramaSearchIndex } from "resource:///modules/panorama/PanoramaSearchIndex.sys.mjs";
import {
  mailSearchKey,
  resolveMailSearchDocument,
} from "resource:///modules/panorama/MailSearchSource.sys.mjs";
import {
  loadMailSearchDocument,
  loadMailSearchMetadata,
} from "resource:///modules/panorama/MailSearchContent.sys.mjs";
import { processSearchIndexBatch } from "resource:///modules/panorama/SearchIndexer.sys.mjs";
import {
  copyMailSearchAttachmentRequest,
  resolveMailSearchAttachment,
  openMailSearchAttachment,
} from "resource:///modules/panorama/MailSearchAttachmentOpener.sys.mjs";
import { openMailSearchResult } from "resource:///modules/panorama/SearchResultOpener.sys.mjs";
import { readMailSearchConversation } from "resource:///modules/panorama/MailSearchConversation.sys.mjs";
import { getMailSearchHeader } from "resource:///modules/panorama/MailSearchPolicy.sys.mjs";
import {
  copyMailSearchSelection,
  matchesMailSearchSelection,
  readMailSearchResult,
} from "resource:///modules/panorama/MailSearchResult.sys.mjs";

const INDEXER_PREF = "mailnews.database.global.indexer.enabled";
const DISPLAY_NAME_PREF = "mail.displayname.version";
const MAX_BACKGROUND_RETRIES = 3;
const BACKGROUND_RETRY_DELAY_MS = 1000;

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "activityManager", () =>
  Cc["@mozilla.org/activity-manager;1"].getService(Ci.nsIActivityManager)
);
ChromeUtils.defineLazyGetter(lazy, "activityStrings", () =>
  Services.strings.createBundle("chrome://messenger/locale/activity.properties")
);

/**
 * Composes native committed replay, current-state resolution and mail indexing.
 * The caller supplies a durable core incarnation identity. A profile path or
 * Message-ID is insufficient. This service does not implement live membership
 * subscriptions or create a reader UI.
 */
export class MailSearchService {
  #messageDB;
  #sourceId;
  #index;
  #updates = Promise.resolve();
  #preferences = Promise.resolve();
  #controller = new AbortController();
  #scheduled = false;
  #retryCount = 0;
  /** @type {?number} Timer.sys.mjs timeout identifier. */
  #retryTimer = null;
  #started = false;
  #closed = false;
  #closePromise;
  /** @type {?nsIActivityProcess} Activity for this physical source incarnation. */
  #activity = null;
  #shutdown = () => this.close();

  /** @type {?function(object): void} Receives durable background progress. */
  onProgress = null;

  /** @type {function(Error): void} Receives a background failure; work stays durable. */
  onError = error => console.error(error);

  QueryInterface = ChromeUtils.generateQI([
    "nsIObserver",
    "nsIMsgFolderListener",
  ]);

  /**
   * Opens the sidecar against core046's real search APIs.
   *
   * @param {nsIFile} file - Owned search sidecar.
   * @param {string} sourceId - Durable core incarnation, supplied by activation.
   * @param {nsIMessageDatabase} [messageDB] - Current native message database.
   * @returns {Promise<MailSearchService>} Open service; call start for background work.
   */
  static async open(
    file,
    sourceId,
    messageDB = Cc["@mozilla.org/mailnews/database-core;1"].getService(
      Ci.nsIDatabaseCore
    ).messageDB
  ) {
    if (typeof sourceId != "string" || !sourceId) {
      throw new TypeError("A durable core incarnation is required");
    }
    if (
      typeof messageDB.getSearchState != "function" ||
      typeof messageDB.getSearchChanges != "function" ||
      typeof messageDB.getSearchSnapshot != "function"
    ) {
      throw new Error("Committed core search APIs are required");
    }
    const service = new MailSearchService(messageDB, sourceId);
    service.#index = await PanoramaSearchIndex.open(file, (id, signal) =>
      service.resolveDocument(id, signal)
    );
    try {
      await service.#index.applyChanges({
        sourceId,
        from: 0,
        through: 0,
        changes: [],
      });
      AsyncShutdown.profileBeforeChange.addBlocker(
        "Panorama mail search",
        service.#shutdown
      );
      return service;
    } catch (error) {
      try {
        await service.#index.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "Mail search open failed"
        );
      }
      throw error;
    }
  }

  /**
   * @param {nsIMessageDatabase} messageDB - Current native database.
   * @param {string} sourceId - Durable core incarnation.
   */
  constructor(messageDB, sourceId) {
    this.#messageDB = messageDB;
    this.#sourceId = sourceId;
  }

  /**
   * Resolves a physical ID through native state and current mail policy.
   *
   * @param {string} id - Decimal global key.
   * @param {AbortSignal} [signal] - Lookup cancellation.
   * @returns {?SearchDocumentState} Authoritative eligible state, or null.
   */
  resolveDocument(id, signal) {
    if (this.#closed) {
      throw new Error("Mail search is closed");
    }
    const state = resolveMailSearchDocument(this.#messageDB, id, signal);
    if (state?.contentError) {
      this.#reportError(state.contentError);
    }
    return state;
  }

  /**
   * Reports an error without letting a reporting callback stop shared lookup.
   *
   * @param {Error} error - Original operation or per-message content error.
   */
  #reportError(error) {
    try {
      this.onError(error);
    } catch (reportError) {
      console.error(
        new AggregateError(
          [error, reportError],
          "Mail search error reporting failed"
        )
      );
    }
  }

  /**
   * Serializes preference invalidation and coalesces current card-name versions.
   * Policy changes journal before their fingerprint is saved. Card changes
   * reset only the durable sidecar header cursor, without a native rescan.
   *
   * @param {AbortSignal} [signal] - Stop before journaling another invalidation.
   * @returns {Promise<void>} Resolves after the fingerprint is durable.
   */
  #preparePreferences(signal) {
    const operation = this.#preferences.then(async () => {
      signal?.throwIfAborted();
      const fingerprint = JSON.stringify([
        2,
        Services.prefs.getBoolPref(INDEXER_PREF, false),
      ]);
      if ((await this.#index.getPolicyFingerprint()) != fingerprint) {
        signal?.throwIfAborted();
        this.#messageDB.noteSearchPolicyChanged();
        await this.#index.setPolicyFingerprint(fingerprint);
      }
      signal?.throwIfAborted();
      await this.#index.prepareAddressBook(
        Services.prefs.getIntPref(DISPLAY_NAME_PREF, 0)
      );
    });
    this.#preferences = operation.catch(() => {});
    return operation;
  }

  /**
   * Consumes one retained journal page or one durable policy-rescan page.
   *
   * @param {number} limit - Native page size.
   * @param {AbortSignal} signal - Stop before accepting another source page.
   */
  async #readChanges(limit, signal) {
    signal.throwIfAborted();
    const scan = await this.#index.getRescan();
    if (scan) {
      const page = this.#messageDB.getSearchSnapshot(scan.afterKey, limit);
      const changes = [];
      for (const raw of page.messages) {
        const id = String(raw.messageKey);
        const state = this.resolveDocument(id, signal);
        if (state) {
          changes.push({
            id,
            sequence: scan.sequence,
            generation: state.generation,
            policyRevision: state.policyRevision,
            kind: state.eligible ? "index" : "exclude",
          });
        }
      }
      signal.throwIfAborted();
      await this.#index.applyRescanPage({
        sequence: scan.sequence,
        afterKey: scan.afterKey,
        nextKey: page.nextKey,
        changes,
        done: !page.messages.length,
      });
      return;
    }

    const { acceptedThrough: from } = await this.#index.getProgress();
    const page = this.#messageDB.getSearchChanges(from, limit);
    const markerIndex = page.changes.findIndex(row => row.messageKey === null);
    const rows =
      markerIndex < 0 ? page.changes : page.changes.slice(0, markerIndex);
    let lastMarker = markerIndex;
    // Consecutive policy changes share one scan. Never skip an intervening
    // physical event: a snapshot alone cannot replay a deletion.
    while (
      lastMarker >= 0 &&
      page.changes[lastMarker + 1]?.messageKey === null
    ) {
      lastMarker++;
    }
    // Only the last event for a physical key is needed from this complete page.
    const latest = new Map(rows.map(row => [row.messageKey, row]));
    const changes = [];
    for (const row of [...latest.values()].sort(
      (a, b) => a.sequence - b.sequence
    )) {
      const id = String(row.messageKey);
      if (row.deleted) {
        changes.push({
          id,
          sequence: row.sequence,
          generation: row.sequence,
          policyRevision: 0,
          kind: "delete",
        });
        continue;
      }
      const state = this.resolveDocument(id, signal);
      if (state) {
        changes.push({
          id,
          sequence: row.sequence,
          generation: state.generation,
          policyRevision: state.policyRevision,
          kind: state.eligible ? "index" : "exclude",
        });
      }
      // A later deletion outside this page is replayed in order. Null current
      // state must not be converted into a fabricated earlier deletion.
    }
    signal.throwIfAborted();
    await this.#index.applyChanges({
      sourceId: this.#sourceId,
      from,
      through:
        markerIndex < 0
          ? page.nextSequence
          : page.changes[lastMarker].sequence - 1,
      changes,
    });
    if (markerIndex >= 0) {
      await this.#index.beginRescan(
        this.#sourceId,
        page.changes[lastMarker].sequence
      );
    }
  }

  /**
   * Processes one bounded native page and one bounded body batch.
   *
   * @param {object} [options] - Work controls.
   * @param {number} [options.limit=20] - Maximum rows/jobs, from 1 to 500.
   * @param {AbortSignal} [options.signal] - Cancel before another load/transaction.
   * @returns {Promise<object>} Durable progress, source watermark and moreWork.
   */
  update({ limit = 20, signal } = {}) {
    if (this.#closed) {
      return Promise.reject(new Error("Mail search is closed"));
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError("Mail search batch size must be from 1 to 500");
    }
    signal = signal
      ? AbortSignal.any([signal, this.#controller.signal])
      : this.#controller.signal;
    const operation = this.#updates.then(async () => {
      signal.throwIfAborted();
      await this.#preparePreferences(signal);
      await this.#readChanges(limit, signal);
      const refreshingNames = await this.#index.refreshAddressBook(limit);
      const before = await this.#index.getProgress();
      const progress = await processSearchIndexBatch(
        this.#index,
        loadMailSearchDocument,
        { limit, signal, loadMetadata: loadMailSearchMetadata }
      );
      const scan = await this.#index.getRescan();
      const { watermark } = this.#messageDB.getSearchChanges(
        progress.acceptedThrough,
        1
      );
      return {
        ...progress,
        sourceWatermark: watermark,
        rebuilding: !!scan || refreshingNames,
        moreWork:
          refreshingNames ||
          !!scan ||
          progress.acceptedThrough < watermark ||
          (progress.pending > 0 && progress.pending < before.pending),
      };
    });
    this.#updates = operation.catch(() => {});
    return operation;
  }

  /** Starts coalesced background work using existing mail notifications. */
  start() {
    if (this.#closed) {
      throw new Error("Mail search is closed");
    }
    if (!this.#started) {
      this.#started = true;
      Services.prefs.addObserver(INDEXER_PREF, this);
      Services.prefs.addObserver(DISPLAY_NAME_PREF, this);
      const flags = Ci.nsIMsgFolderNotificationService;
      MailServices.mfn.addListener(
        this,
        flags.msgAdded |
          flags.msgsDeleted |
          flags.msgsMoveCopyCompleted |
          flags.msgsClassified |
          flags.msgKeyChanged |
          flags.msgsJunkStatusChanged |
          flags.msgPropertyChanged |
          flags.folderDeleted |
          flags.folderRenamed |
          flags.folderMoveCopyCompleted |
          flags.folderCompactFinish |
          flags.folderReindexTriggered
      );
    }
    this.#wake();
  }

  /** Resumes work after an external change or explicit search. */
  #wake() {
    this.#retryCount = 0;
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#schedule();
  }

  /**
   * Schedules bounded work and up to three delayed retries after a failure.
   * New source notifications or explicit searches reset the retry budget.
   * Unfinished work remains durable after the retry budget is exhausted.
   */
  #schedule() {
    if (this.#scheduled || this.#closed) {
      return;
    }
    this.#scheduled = true;
    Services.tm.idleDispatchToMainThread(() => {
      this.#scheduled = false;
      if (this.#closed) {
        return;
      }
      this.update()
        .then(progress => {
          this.#retryCount = 0;
          this.#updateActivity(progress);
          try {
            this.onProgress?.(progress);
          } catch (error) {
            this.#reportError(error);
          }
          if (progress.moreWork) {
            this.#schedule();
          }
        })
        .catch(error => {
          if (this.#closed) {
            return;
          }
          this.#updateActivity(null, true);
          this.#reportError(error);
          if (
            this.#closed ||
            this.#scheduled ||
            this.#retryTimer !== null ||
            this.#retryCount >= MAX_BACKGROUND_RETRIES
          ) {
            return;
          }
          const delay = BACKGROUND_RETRY_DELAY_MS * 2 ** this.#retryCount++;
          this.#retryTimer = setTimeout(() => {
            this.#retryTimer = null;
            this.#schedule();
          }, delay);
        });
    });
  }

  /**
   * Reports unfinished native work through the existing Activity Manager.
   * Source checkpoints are not message totals, so progress is indeterminate.
   * UI failures do not change accepted indexing work or its original errors.
   *
   * @param {?object} progress - Durable background counts, or null on failure.
   * @param {boolean} [failed=false] - Background replay needs a retry.
   */
  #updateActivity(progress, failed = false) {
    if (this.#closed) {
      return;
    }
    if (
      !failed &&
      !progress.moreWork &&
      !progress.pending &&
      !progress.unavailable
    ) {
      this.#clearActivity(false);
      return;
    }
    try {
      const states = Ci.nsIActivityProcess;
      if (!this.#activity) {
        const process =
          Cc["@mozilla.org/activity-process;1"].createInstance(states);
        process.init(
          lazy.activityStrings.GetStringFromName("indexing"),
          this.#sourceId
        );
        process.iconClass = "indexMail";
        process.contextType = "panorama-search";
        process.contextObj = this.#sourceId;
        lazy.activityManager.addActivity(process);
        if (this.#closed) {
          process.state = states.STATE_CANCELED;
          lazy.activityManager.removeActivity(process.id);
          return;
        }
        this.#activity = process;
      }
      let state = states.STATE_INPROGRESS;
      let status = progress?.rebuilding ? "indexingStatusVague" : "indexing";
      if (!Services.prefs.getBoolPref(INDEXER_PREF, false)) {
        state = states.STATE_PAUSED;
        status = "paused2";
      } else if (failed || (!progress.moreWork && progress.unavailable)) {
        state = states.STATE_WAITINGFORRETRY;
        status = "waitingForRetry";
      }
      // Waiting processes must resume before moving to another state.
      if (this.#activity.state == states.STATE_WAITINGFORRETRY) {
        this.#activity.state = states.STATE_INPROGRESS;
      }
      this.#activity.state = state;
      this.#activity.setProgress(
        lazy.activityStrings.GetStringFromName(status),
        0,
        0
      );
    } catch (error) {
      console.error(error);
    }
  }

  /**
   * Finishes only this writer's activity after work settles or close drains.
   *
   * @param {boolean} cancelled - Whether the writer is closing with work retained.
   */
  #clearActivity(cancelled) {
    const process = this.#activity;
    this.#activity = null;
    if (!process) {
      return;
    }
    try {
      const states = Ci.nsIActivityProcess;
      if (process.state == states.STATE_WAITINGFORRETRY) {
        process.state = states.STATE_INPROGRESS;
      }
      process.state = cancelled
        ? states.STATE_CANCELED
        : states.STATE_COMPLETED;
      lazy.activityManager.removeActivity(process.id);
    } catch (error) {
      console.error(error);
    }
  }

  observe() {
    this.#wake();
  }
  msgAdded() {
    this.#wake();
  }
  msgsDeleted() {
    this.#wake();
  }
  msgsMoveCopyCompleted() {
    this.#wake();
  }
  msgsClassified() {
    this.#wake();
  }
  msgKeyChanged() {
    this.#wake();
  }
  msgsJunkStatusChanged() {
    this.#wake();
  }
  msgPropertyChanged() {
    this.#wake();
  }
  folderDeleted() {
    this.#wake();
  }
  folderRenamed() {
    this.#wake();
  }
  folderMoveCopyCompleted() {
    this.#wake();
  }
  folderCompactFinish() {
    this.#wake();
  }
  folderReindexTriggered() {
    this.#wake();
  }

  /**
   * Queries the replacement index and resumes pending background work.
   * Service closure cancels page delivery, including an in-flight lookup.
   *
   * @param {string} text - Search words/phrases.
   * @param {object} [options] - PanoramaSearchIndex query controls.
   * @param {AbortSignal} [options.signal] - Cancel query delivery.
   * @returns {Promise<object>} Physical hits, cursor and result-set identity.
   */
  async search(text, { signal, ...options } = {}) {
    if (this.#closed) {
      throw new Error("Mail search is closed");
    }
    signal = signal
      ? AbortSignal.any([signal, this.#controller.signal])
      : this.#controller.signal;
    await this.#preparePreferences(signal);
    signal.throwIfAborted();
    this.start();
    return this.#index.search(text, { ...options, signal });
  }

  /**
   * Streams all pages to the existing native search-list listener.
   * Serializing with updates keeps the sidecar revision fixed across pages.
   * Native eligibility/location is still checked at each delivery. The callback
   * must be synchronous and must not re-enter this service.
   *
   * @param {string} text - Search words/phrases.
   * @param {function(nsIMsgDBHdr): void} onHeader - Receives each current physical copy.
   * @param {object} [options] - Query controls.
   * @param {boolean} [options.andTerms=true] - Require every term.
   * @param {AbortSignal} [options.signal] - Stop selection/delivery.
   * @returns {Promise<{resultSetId: string, count: number}>} Delivered result set.
   */
  streamHeaders(text, onHeader, { andTerms = true, signal } = {}) {
    if (this.#closed) {
      return Promise.reject(new Error("Mail search is closed"));
    }
    if (typeof onHeader != "function") {
      throw new TypeError("A native header listener is required");
    }
    signal = signal
      ? AbortSignal.any([signal, this.#controller.signal])
      : this.#controller.signal;
    const operation = this.#updates.then(async () => {
      await this.#preparePreferences(signal);
      let cursor;
      let resultSetId;
      let count = 0;
      do {
        const page = await this.#index.search(text, {
          andTerms,
          limit: 100,
          cursor,
          signal,
        });
        resultSetId = page.resultSetId;
        for (const hit of page.items) {
          signal.throwIfAborted();
          const state = this.resolveDocument(hit.id, signal);
          const current =
            state?.eligible &&
            state.generation == hit.generation &&
            state.contentRevision == hit.contentRevision &&
            state.policyRevision == hit.policyRevision;
          const header = current && getMailSearchHeader(state);
          if (header) {
            onHeader(header);
            count++;
          }
        }
        cursor = page.cursor;
      } while (cursor);
      return { resultSetId, count };
    });
    this.#updates = operation.catch(() => {});
    return operation;
  }

  /**
   * Completes current indexed mailboxes and configured tag labels. The existing
   * update queue and policy/card-name guards are shared with normal queries.
   *
   * @param {string} text - Literal completion substring.
   * @param {object} [options={}] - Query controls.
   * @param {number} [options.limit=20] - Maximum choices per kind, from 1 to 100.
   * @param {AbortSignal} [options.signal] - Cancel native selection/delivery.
   * @returns {Promise<{sourceId: string, items: MailSearchCompletion[]}>} Current choices.
   */
  async complete(text, { limit = 20, signal } = {}) {
    if (this.#closed) {
      throw new Error("Mail search is closed");
    }
    signal = signal
      ? AbortSignal.any([signal, this.#controller.signal])
      : this.#controller.signal;
    signal.throwIfAborted();
    this.start();
    const operation = this.#updates.then(async () => {
      await this.#preparePreferences(signal);
      return completeMailSearchMetadata(
        this,
        this.#index,
        this.#sourceId,
        text,
        { limit, signal }
      );
    });
    this.#updates = operation.catch(() => {});
    return operation;
  }

  /**
   * Collects all query pages for facets or an exact person/tag selection.
   * Accepts one bounded update before collection. Updates then wait until
   * collection completes. Native state is checked for each
   * projection and again before return; this is not a live subscription or an
   * atomic snapshot of the native database. Unindexed messages are not included.
   *
   * @param {string} text - Words/phrases; empty text requires a typed selection.
   * @param {object} [options] - Query controls.
   * @param {boolean} [options.andTerms=true] - Require every text term.
   * @param {?MailSearchSelection} [options.selection=null] - Exact typed values.
   * @param {AbortSignal} [options.signal] - Cancel collection and delivery.
   * @returns {Promise<MailSearchResultSet>} Physical members and copied metadata.
   */
  async collectResults(
    text,
    { andTerms = true, selection = null, signal } = {}
  ) {
    if (this.#closed) {
      return Promise.reject(new Error("Mail search is closed"));
    }
    selection = copyMailSearchSelection(selection);
    signal = signal
      ? AbortSignal.any([signal, this.#controller.signal])
      : this.#controller.signal;
    signal.throwIfAborted();
    this.start();
    // Accept one current change page before collecting indexed physical copies.
    // In particular, flag/tag changes must refresh their existing projection.
    try {
      await this.update({ limit: 500, signal });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      this.#reportError(error);
    }
    const operation = this.#updates.then(async () => {
      await this.#preparePreferences(signal);
      const items = [];
      let cursor;
      let resultSetId;
      do {
        const page = await this.#index.search(text, {
          andTerms,
          matchAll: !!selection,
          limit: 100,
          cursor,
          signal,
        });
        resultSetId = page.resultSetId;
        for (const hit of page.items) {
          const result = await readMailSearchResult(this, hit, { signal });
          if (result && matchesMailSearchSelection(result, selection)) {
            items.push(result);
          }
        }
        cursor = page.cursor;
      } while (cursor);
      signal.throwIfAborted();
      return {
        sourceId: this.#sourceId,
        resultSetId,
        items: items.filter(item => this.#currentHeader(item, signal)),
      };
    });
    this.#updates = operation.catch(() => {});
    return operation;
  }

  /**
   * Resolves only the selected physical copy when its indexed revisions match.
   *
   * @param {SearchHit|MailSearchResult} hit - Selected physical result.
   * @param {AbortSignal} signal - Cancel lookup.
   * @returns {?nsIMsgDBHdr} Current eligible header, or null for a stale result.
   */
  #currentHeader(hit, signal) {
    const state = this.resolveDocument(hit.id, signal);
    return state?.eligible &&
      state.generation == hit.generation &&
      state.contentRevision == hit.contentRevision &&
      state.policyRevision == hit.policyRevision
      ? getMailSearchHeader(state)
      : null;
  }

  /**
   * Exports the active facet members without rerunning their original query.
   * Deleted, excluded or changed copies are omitted. Another copy with the same
   * Message-ID is never substituted. The callback must be synchronous.
   *
   * @param {MailSearchResultSet} resultSet - Full result snapshot or active subset.
   * @param {function(nsIMsgDBHdr): void} onHeader - Current selected copy.
   * @param {object} [options] - Delivery controls.
   * @param {AbortSignal} [options.signal] - Stop lookup/delivery.
   * @param {boolean} [options.requireComplete=false] - Reject if any selected copy changed.
   * @returns {Promise<{resultSetId: string, count: number}>} Delivered membership.
   * @throws {TypeError} If the result set belongs to another native incarnation.
   * @throws {nsIException} For stale membership when requireComplete is true.
   */
  streamResultHeaders(
    resultSet,
    onHeader,
    { signal, requireComplete = false } = {}
  ) {
    if (this.#closed) {
      return Promise.reject(new Error("Mail search is closed"));
    }
    if (
      resultSet?.sourceId !== this.#sourceId ||
      typeof resultSet.resultSetId != "string" ||
      !Array.isArray(resultSet.items) ||
      typeof onHeader != "function"
    ) {
      throw new TypeError("A result set from this mail database is required");
    }
    const resultSetId = resultSet.resultSetId;
    const selected = resultSet.items.map(
      ({ id, generation, contentRevision, policyRevision }) => ({
        id,
        generation,
        contentRevision,
        policyRevision,
      })
    );
    signal = signal
      ? AbortSignal.any([signal, this.#controller.signal])
      : this.#controller.signal;
    const operation = this.#updates.then(async () => {
      await this.#preparePreferences(signal);
      const seen = new Set();
      const resolve = hit => {
        signal.throwIfAborted();
        const header = this.#currentHeader(hit, signal);
        if (!header && requireComplete) {
          throw Components.Exception(
            `Search result changed (physical key ${hit.id})`,
            Cr.NS_ERROR_IN_PROGRESS
          );
        }
        return header;
      };
      if (requireComplete) {
        selected.forEach(resolve);
      }
      let count = 0;
      for (const hit of selected) {
        const header = !seen.has(hit.id) && resolve(hit);
        if (header) {
          seen.add(hit.id);
          onHeader(header);
          count++;
        }
      }
      if (requireComplete) {
        selected.forEach(resolve);
      }
      return { resultSetId, count };
    });
    this.#updates = operation.catch(() => {});
    return operation;
  }

  /**
   * Reads current eligible semantic text. Compare its textRevision with the hit
   * before using the hit's offsets.
   *
   * @param {string} id - Physical global key.
   * @param {object} [options] - Lookup controls.
   * @param {AbortSignal} [options.signal] - Cancel selection and text delivery.
   * @returns {Promise<?SearchDocument>} Eligible stored text.
   */
  async getText(id, { signal } = {}) {
    signal = signal
      ? AbortSignal.any([signal, this.#controller.signal])
      : this.#controller.signal;
    await this.#preparePreferences(signal);
    return this.#index.getText(id, { signal });
  }

  /**
   * Explicitly retries unavailable documents without a native policy rescan.
   * Only job status changes. Workers still check the current generation,
   * deletion and eligibility before loading or committing. A started storage
   * operation drains even when the caller cancels delivery.
   *
   * @param {object} [options] - Action controls.
   * @param {AbortSignal} [options.signal] - Cancel before writing or delivering.
   * @returns {Promise<{sourceId: ?string, acceptedThrough: number, pending: number,
   *   unavailable: number}>} Durable unfinished-work counts and checkpoint.
   */
  retryUnavailable({ signal } = {}) {
    if (this.#closed) {
      return Promise.reject(new Error("Mail search is closed"));
    }
    signal = signal
      ? AbortSignal.any([signal, this.#controller.signal])
      : this.#controller.signal;
    const operation = this.#updates.then(async () => {
      signal.throwIfAborted();
      await this.#index.retryUnavailable({ signal });
      const progress = await this.#index.getProgress();
      signal.throwIfAborted();
      this.start();
      return progress;
    });
    this.#updates = operation.catch(() => {});
    return operation;
  }

  /**
   * Retrieves complete eligible native conversation members for a clicked copy.
   * Does not depend on FTS readiness or the current facet refinement.
   *
   * @param {MailSearchResult & {sourceId: string}} request - Exact selected result.
   * @param {object} [options={}] - Lookup controls.
   * @param {AbortSignal} [options.signal] - Cancel selection/delivery.
   * @returns {Promise<MailSearchConversationSnapshot|{status: string}>} Native snapshot or non-ready status.
   */
  getConversation(request, { signal } = {}) {
    if (this.#closed) {
      return Promise.reject(new Error("Mail search is closed"));
    }
    signal = signal
      ? AbortSignal.any([signal, this.#controller.signal])
      : this.#controller.signal;
    return readMailSearchConversation(
      this,
      this.#sourceId,
      this.#messageDB,
      request,
      { signal }
    );
  }

  /**
   * Retrieves a native conversation for an ordinary selected mail header.
   * Settles preference invalidation before capturing native revisions. This
   * requires no indexed text and does not enable background indexing.
   *
   * @param {nsIMsgDBHdr} header - Selected physical header from the active core.
   * @param {object} [options] - Lookup controls.
   * @param {AbortSignal} [options.signal] - Cancel selection and delivery.
   * @returns {Promise<MailSearchConversationSnapshot|{status: string}>} Complete
   *   eligible members, or deleted/ineligible/stale/unavailable without members.
   * @throws {TypeError} For an invalid physical message key.
   */
  async getConversationForHeader(header, { signal } = {}) {
    if (this.#closed) {
      throw new Error("Mail search is closed");
    }
    signal = signal
      ? AbortSignal.any([signal, this.#controller.signal])
      : this.#controller.signal;
    signal.throwIfAborted();
    const id = String(header?.messageKey);
    const key = mailSearchKey(id);
    const folderId = header.folder?.id;
    await this.#preparePreferences(signal);
    signal.throwIfAborted();
    const state = this.resolveDocument(id, signal);
    if (!state) {
      return { status: "deleted" };
    }
    if (!state.eligible) {
      return { status: "ineligible" };
    }
    if (
      state.location?.folderId !== folderId ||
      state.location.messageKey !== key
    ) {
      return { status: "stale" };
    }
    return readMailSearchConversation(
      this,
      this.#sourceId,
      this.#messageDB,
      {
        sourceId: this.#sourceId,
        id,
        generation: state.generation,
        policyRevision: state.policyRevision,
        contentRevision: state.contentRevision,
        location: { ...state.location },
      },
      { signal }
    );
  }

  /**
   * Resolves a current physical attachment URL without using retained URLs.
   *
   * @param {MailSearchAttachmentRequest} request - Parent result token and MIME part.
   * @param {object} [options] - Resolution controls.
   * @param {boolean} [options.allowDownload=false] - Permit remote retrieval/actions.
   * @param {AbortSignal} [options.signal] - Cancel MIME/result delivery.
   * @returns {Promise<MailSearchAttachmentResolution>} Fresh details or a non-ready status.
   */
  resolveAttachment(request, { allowDownload = false, signal } = {}) {
    if (this.#closed) {
      return Promise.reject(new Error("Mail search is closed"));
    }
    request = copyMailSearchAttachmentRequest(this.#sourceId, request);
    signal = signal
      ? AbortSignal.any([signal, this.#controller.signal])
      : this.#controller.signal;
    return resolveMailSearchAttachment(this, this.#sourceId, request, {
      allowDownload,
      signal,
    });
  }

  /**
   * Revalidates a selected attachment and dispatches to the existing reader.
   *
   * @param {MailSearchAttachmentRequest} request - Selected parent and MIME part.
   * @param {object} options - Existing reader context and retrieval policy.
   * @param {BrowsingContext} options.browsingContext - Target reader context.
   * @param {boolean} [options.allowDownload=false] - Permit remote retrieval/actions.
   * @param {AbortSignal} [options.signal] - Cancel before dispatch; an existing
   *   reader action cannot be revoked after handoff.
   * @returns {Promise<MailSearchAttachmentResolution>} Dispatched or non-ready status.
   */
  openAttachment(
    request,
    { browsingContext, allowDownload = false, signal } = {}
  ) {
    if (this.#closed) {
      return Promise.reject(new Error("Mail search is closed"));
    }
    request = copyMailSearchAttachmentRequest(this.#sourceId, request);
    signal = signal
      ? AbortSignal.any([signal, this.#controller.signal])
      : this.#controller.signal;
    return openMailSearchAttachment(this, this.#sourceId, request, {
      browsingContext,
      allowDownload,
      signal,
    });
  }

  /**
   * Opens the current physical copy through the existing mail reader.
   * Service closure cancels lookup and prevents dispatch to the reader.
   *
   * @param {string} id - Physical global key.
   * @param {object} [options] - Cancellation and normal reader arguments.
   * @param {AbortSignal} [options.signal] - Cancel lookup and reader dispatch.
   * @param {DBViewWrapper} [options.viewWrapper] - View to clone for the reader.
   * @param {Element} [options.tabmail] - Target tabmail, or the reader default.
   * @returns {Promise<object>} Current resolution/opening status.
   */
  async openResult(id, { signal, viewWrapper, tabmail } = {}) {
    if (this.#closed) {
      throw new Error("Mail search is closed");
    }
    signal = signal
      ? AbortSignal.any([signal, this.#controller.signal])
      : this.#controller.signal;
    return openMailSearchResult(
      id,
      (key, lookupSignal) => this.resolveDocument(key, lookupSignal),
      { signal, viewWrapper, tabmail }
    );
  }

  /**
   * Cancels pending delivery and drains the owned connection.
   *
   * @returns {Promise<void>} Resolves after the sidecar closes.
   */
  close() {
    if (!this.#closePromise) {
      this.#closed = true;
      if (this.#retryTimer !== null) {
        clearTimeout(this.#retryTimer);
        this.#retryTimer = null;
      }
      this.#controller.abort(new Error("Mail search closed"));
      if (this.#started) {
        Services.prefs.removeObserver(INDEXER_PREF, this);
        Services.prefs.removeObserver(DISPLAY_NAME_PREF, this);
        MailServices.mfn.removeListener(this);
      }
      this.#closePromise = Promise.all([this.#updates, this.#preferences])
        .then(() => this.#index.close())
        .finally(() => {
          this.#clearActivity(true);
          AsyncShutdown.profileBeforeChange.removeBlocker(this.#shutdown);
        });
    }
    return this.#closePromise;
  }
}
