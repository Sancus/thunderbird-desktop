/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MailServices } from "resource:///modules/MailServices.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  MailSearchService: "resource:///modules/panorama/MailSearchService.sys.mjs",
  openMailSearchList: "resource:///modules/panorama/MailSearchView.sys.mjs",
});

/** @type {?{sourceId: string, promise: Promise<MailSearchService>, closePromise: ?Promise<void>}} */
let current = null;

/**
 * Opens one owned profile service using core048's persistent database identity.
 * The account manager starts core; calling startup again would be an error.
 * Each native incarnation gets a separate sidecar. Old sidecars are retained.
 * Starts bounded background work once the service opens. Only the active native
 * backend can activate this service; this does not supply a legacy fallback.
 *
 * @returns {Promise<MailSearchService>} Shared service; close through closeMailSearch.
 * @throws {Error} If opening or native identity lookup fails.
 */
export async function getMailSearchService() {
  // Account manager initialization registers and starts the native backend.
  MailServices.accounts;
  const backend = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  if (!("nsIDatabaseCore" in Ci) || !(backend instanceof Ci.nsIDatabaseCore)) {
    throw Components.Exception(
      "Panorama search requires the active native database",
      Cr.NS_ERROR_NOT_AVAILABLE
    );
  }
  const core = backend.QueryInterface(Ci.nsIDatabaseCore);
  const sourceId = core.sourceId;
  if (typeof sourceId != "string" || !sourceId) {
    throw Components.Exception(
      "Native search identity is required",
      Cr.NS_ERROR_NOT_AVAILABLE
    );
  }
  if (current) {
    if (current.sourceId != sourceId || current.closePromise) {
      throw Components.Exception(
        "Mail search core changed or is closing",
        Cr.NS_ERROR_NOT_AVAILABLE
      );
    }
    return current.promise;
  }
  const file = Services.dirsvc.get("ProfD", Ci.nsIFile).clone();
  // sourceId is a UUID validated by the native getter, not a path-derived ID.
  file.append("panorama-search-" + sourceId + ".sqlite");
  current = {
    sourceId,
    promise: lazy.MailSearchService.open(file, sourceId, core.messageDB).then(
      async service => {
        try {
          service.start();
          return service;
        } catch (error) {
          try {
            await service.close();
          } catch (closeError) {
            throw new AggregateError(
              [error, closeError],
              "Mail search start and close failed"
            );
          }
          throw error;
        }
      }
    ),
    closePromise: null,
  };
  return current.promise;
}

/**
 * Closes the owned default service before another one can be opened.
 * A failed open/close remains failed; no second writer replaces it silently.
 *
 * @returns {Promise<void>} Resolves after the connection closes.
 */
export async function closeMailSearch() {
  const entry = current;
  if (!entry) {
    return;
  }
  if (!entry.closePromise) {
    entry.closePromise = entry.promise
      .then(service => service.close())
      .then(() => {
        if (current == entry) {
          current = null;
        }
      });
  }
  return entry.closePromise;
}

/**
 * Opens an ordinary replacement result list through the existing mail tab.
 * Shared initialization continues if this caller cancels; cancellation prevents
 * tab creation. A typed selection collects exact physical members first.
 *
 * @param {Element} tabmail - Existing mail tab manager.
 * @param {string} text - Ordinary global-search words/phrases.
 * @param {object} [options] - Query/list controls.
 * @param {boolean} [options.andTerms=true] - Require every term.
 * @param {?MailSearchSelection} [options.selection=null] - Person addresses or tag key.
 * @param {string} [options.title=text] - Tab title.
 * @param {boolean} [options.background=false] - Open without selecting the tab.
 * @param {AbortSignal} [options.signal] - Prevent opening after cancellation.
 * @returns {Promise<object>} Existing mail3PaneTab.
 */
export async function openDefaultMailSearchList(
  tabmail,
  text,
  { signal, selection = null, ...options } = {}
) {
  signal?.throwIfAborted();
  const service = await getMailSearchService();
  const resultSet = selection
    ? await service.collectResults(text, { ...options, selection, signal })
    : null;
  signal?.throwIfAborted();
  return lazy.openMailSearchList(tabmail, service, text, {
    ...options,
    resultSet,
  });
}

/**
 * Collects replacement results for a facet caller using the native sourceId.
 * The caller retains this snapshot and its physical IDs during refinement.
 *
 * @param {string} text - Search words/phrases, or empty for a typed selection.
 * @param {object} [options] - MailSearchService.collectResults controls.
 * @returns {Promise<MailSearchResultSet>} Physical query members and metadata.
 */
export async function findMailSearchResults(text, options) {
  options?.signal?.throwIfAborted();
  const service = await getMailSearchService();
  return service.collectResults(text, options);
}

/**
 * Opens a facet caller's active subset in the existing mail list.
 * Copies member tokens before tab creation. Header delivery checks the source
 * incarnation and each member's current revisions, without rerunning FTS.
 *
 * @param {Element} tabmail - Existing mail tab manager.
 * @param {MailSearchResultSet} resultSet - Full result snapshot or active subset.
 * @param {object} [options] - Existing list controls.
 * @param {string} [options.title=""] - Tab title.
 * @param {boolean} [options.background=false] - Open without selecting the tab.
 * @param {AbortSignal} [options.signal] - Prevent tab creation after cancellation.
 * @returns {Promise<object>} Existing mail3PaneTab.
 */
export async function openDefaultMailSearchResultsList(
  tabmail,
  resultSet,
  { signal, ...options } = {}
) {
  signal?.throwIfAborted();
  const service = await getMailSearchService();
  signal?.throwIfAborted();
  return lazy.openMailSearchList(tabmail, service, "", {
    ...options,
    resultSet,
  });
}

/**
 * Retries unavailable work in the shared native search service.
 * Does not trigger a global policy rescan or claim content is now readable.
 *
 * @param {object} [options] - Action controls.
 * @param {AbortSignal} [options.signal] - Cancel initialization/action delivery.
 * @returns {Promise<{sourceId: ?string, acceptedThrough: number, pending: number,
 *   unavailable: number}>} Durable unfinished-work counts and checkpoint.
 */
export async function retryUnavailableMailSearch(options) {
  options?.signal?.throwIfAborted();
  const service = await getMailSearchService();
  return service.retryUnavailable(options);
}

/**
 * Resolves an attachment in the default native incarnation using current MIME.
 * Shared initialization continues if the caller cancels.
 *
 * @param {MailSearchAttachmentRequest} request - Result token and observed part.
 * @param {object} [options] - resolveAttachment controls, including allowDownload.
 * @returns {Promise<MailSearchAttachmentResolution>} Fresh details or a non-ready status.
 */
export async function resolveMailSearchAttachment(request, options) {
  options?.signal?.throwIfAborted();
  const service = await getMailSearchService();
  return service.resolveAttachment(request, options);
}

/**
 * Revalidates and dispatches an attachment through the existing reader.
 *
 * @param {MailSearchAttachmentRequest} request - Selected physical parent/part.
 * @param {object} options - Existing browsingContext, permission and signal.
 * @returns {Promise<MailSearchAttachmentResolution>} Dispatched or non-ready status.
 */
export async function openMailSearchAttachment(request, options) {
  options?.signal?.throwIfAborted();
  const service = await getMailSearchService();
  return service.openAttachment(request, options);
}

/**
 * Retrieves the full eligible native conversation for an exact facet selection.
 * Pass sourceId from the result set with the clicked item's native token.
 * Shared factory initialization continues when this caller cancels.
 *
 * @param {MailSearchResult & {sourceId: string}} request - Exact clicked copy.
 * @param {object} [options={}] - Native membership controls.
 * @param {AbortSignal} [options.signal] - Prevent query/delivery after cancellation.
 * @returns {Promise<MailSearchConversationSnapshot|{status: string}>} Snapshot or non-ready status.
 */
export async function getMailSearchConversation(request, { signal } = {}) {
  signal?.throwIfAborted();
  request = {
    ...request,
    location: request?.location && { ...request.location },
  };
  const service = await getMailSearchService();
  return service.getConversation(request, { signal });
}

/**
 * Completes native mail people/tags through the existing shared service.
 * Cancelling prevents query/delivery, not shared factory initialization.
 *
 * @param {string} text - Literal completion substring.
 * @param {object} [options={}] - Query controls.
 * @param {number} [options.limit=20] - Maximum choices per kind.
 * @param {AbortSignal} [options.signal] - Cancel this completion only.
 * @returns {Promise<{sourceId: string, items: MailSearchCompletion[]}>} Typed choices.
 */
export async function completeMailSearch(text, { limit = 20, signal } = {}) {
  signal?.throwIfAborted();
  const service = await getMailSearchService();
  return service.complete(text, { limit, signal });
}
