/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mailSearchKey } from "resource:///modules/panorama/MailSearchSource.sys.mjs";
import { getMailSearchHeader } from "resource:///modules/panorama/MailSearchPolicy.sys.mjs";

/**
 * Copies the selected physical result before starting a native query.
 * A snippet revision is not needed to retrieve native conversation metadata.
 *
 * @param {string} sourceId - Current service incarnation.
 * @param {MailSearchResult & {sourceId: string}} request - Exact clicked result.
 * @returns {{id: string, generation: number, policyRevision: number,
 *   contentRevision: string, location: {folderId: number, messageKey: number}}}
 *   Independent physical selection and native revisions.
 * @throws {TypeError} For foreign, incomplete or aliased identities.
 */
function copySelection(sourceId, request) {
  if (
    typeof sourceId != "string" ||
    !sourceId ||
    request?.sourceId !== sourceId
  ) {
    throw new TypeError(
      "A conversation result from this mail database is required"
    );
  }
  const key = mailSearchKey(request.id);
  if (
    !Number.isSafeInteger(request.generation) ||
    request.generation < 1 ||
    !Number.isSafeInteger(request.policyRevision) ||
    request.policyRevision < 0 ||
    typeof request.contentRevision != "string" ||
    !request.contentRevision ||
    !Number.isSafeInteger(request.location?.folderId) ||
    request.location.folderId < 1 ||
    request.location.messageKey !== key
  ) {
    throw new TypeError("An exact physical conversation selection is required");
  }
  return {
    id: request.id,
    generation: request.generation,
    policyRevision: request.policyRevision,
    contentRevision: request.contentRevision,
    location: { folderId: request.location.folderId, messageKey: key },
  };
}

/**
 * Checks the exact selected copy without requiring locally available body text.
 *
 * @param {MailSearchService} service - Current source resolver.
 * @param {{id: string, generation: number, policyRevision: number,
 *   contentRevision: string, location: {folderId: number, messageKey: number}}}
 *   request - Copied physical selection.
 * @param {AbortSignal} [signal] - Prevent lookup/delivery after cancellation.
 * @returns {{status: string, header?: nsIMsgDBHdr}} Current selected header or status.
 */
function inspectSelection(service, request, signal) {
  signal?.throwIfAborted();
  const state = service.resolveDocument(request.id, signal);
  if (!state) {
    return { status: "deleted" };
  }
  if (!state.eligible) {
    return { status: "ineligible" };
  }
  if (
    state.generation !== request.generation ||
    state.policyRevision !== request.policyRevision ||
    state.contentRevision !== request.contentRevision ||
    state.location?.folderId !== request.location.folderId ||
    state.location.messageKey !== request.location.messageKey
  ) {
    return { status: "stale" };
  }
  const header = getMailSearchHeader(state);
  return header ? { status: "ready", header } : { status: "unavailable" };
}

/**
 * Cancels delivery while still observing the native query's eventual settlement.
 * LiveView has no scriptable cancellation method; no listener is installed.
 *
 * @param {Promise<object[]>} pending - Native selection already started.
 * @param {AbortSignal} [signal] - Cancel result delivery.
 * @returns {Promise<object[]>} Selected rows, or the original rejection/reason.
 */
function selectWithCancellation(pending, signal) {
  if (!signal) {
    return pending;
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      rows => {
        signal.removeEventListener("abort", abort);
        resolve(rows);
      },
      error => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
    if (signal.aborted) {
      abort();
    }
  });
}

/**
 * @typedef {object} MailSearchConversationMember
 * @property {string} id - Global physical message key.
 * @property {number} generation - Current native generation.
 * @property {number} policyRevision - Current eligibility revision.
 * @property {string} contentRevision - Current semantic source revision.
 * @property {string} metadataRevision - Current metadata revision.
 * @property {string} locationRevision - Current physical location revision.
 * @property {{folderId: number, messageKey: number}} location - Current location.
 * @property {boolean} originalContentAvailable - Local body was readable at lookup.
 * @property {boolean} canOpen - The normal reader can currently open the original.
 */

/**
 * @typedef {object} MailSearchConversationSnapshot
 * @property {"ready"} status - Complete eligible native membership was selected.
 * @property {string} sourceId - Native database incarnation.
 * @property {string} resultSetId - Identity for this membership snapshot, not FTS.
 * @property {number} conversationId - Current native threadId, not a stable logical ID.
 * @property {number} watermark - Durable search sequence surrounding the selection.
 * @property {MailSearchConversationMember[]} items - Tokens accepted by streamResultHeaders.
 * @property {string} selectedId - Exact clicked physical key.
 * @property {nsIMsgDBHdr} selectedMessage - That copy's freshly resolved header.
 * @property {number} excludedCount - Native members omitted by current search policy.
 */

/**
 * Retrieves the whole eligible native conversation, including unindexed and
 * non-matching messages across folders. Applies current policy to every member;
 * never substitutes a Message-ID duplicate or an FTS/refined subset.
 *
 * Any durable mutation during selection returns stale, including unrelated
 * mutations. Native errors propagate. This is a static snapshot; later header
 * export must recheck its tokens. It is not a subscription or a stable thread ID.
 *
 * @param {MailSearchService} service - Current metadata/policy resolver.
 * @param {string} sourceId - Service's actual native incarnation.
 * @param {nsIMessageDatabase} messageDB - Same native database used by the service.
 * @param {MailSearchResult & {sourceId: string}} selected - Clicked physical result.
 * @param {object} [options={}] - Selection controls.
 * @param {AbortSignal} [options.signal] - Cancel selection delivery.
 * @returns {Promise<MailSearchConversationSnapshot|{status: string}>} Ready members,
 *   or stale/deleted/ineligible/unavailable without partial membership.
 */
export async function readMailSearchConversation(
  service,
  sourceId,
  messageDB,
  selected,
  { signal } = {}
) {
  const request = copySelection(sourceId, selected);
  signal?.throwIfAborted();
  const watermark = messageDB.getSearchChanges(0, 1).watermark;
  const seed = inspectSelection(service, request, signal);
  if (seed.status != "ready") {
    return seed;
  }
  const conversationId = seed.header.threadId;
  mailSearchKey(String(conversationId));
  const view = Cc["@mozilla.org/mailnews/live-view;1"].createInstance(
    Ci.nsILiveView
  );
  view.initWithConversation(conversationId);
  view.grouping = Ci.nsILiveView.UNTHREADED;
  const rows = await selectWithCancellation(view.selectMessages(), signal);
  signal?.throwIfAborted();
  const items = [];
  const seen = new Set();
  let excludedCount = 0;
  for (const row of rows) {
    signal?.throwIfAborted();
    const id = String(row.id);
    mailSearchKey(id);
    if (seen.has(id)) {
      throw new Error("Duplicate physical conversation row");
    }
    seen.add(id);
    const state = service.resolveDocument(id, signal);
    if (
      !state ||
      state.location?.folderId !== row.folderId ||
      state.location.messageKey !== row.id ||
      row.threadId !== conversationId
    ) {
      return { status: "stale" };
    }
    if (!state.eligible) {
      excludedCount++;
      continue;
    }
    const header = getMailSearchHeader(state);
    if (!header || header.threadId !== conversationId) {
      return { status: "stale" };
    }
    items.push({
      id,
      generation: state.generation,
      policyRevision: state.policyRevision,
      contentRevision: state.contentRevision,
      metadataRevision: state.metadataRevision,
      locationRevision: state.locationRevision,
      location: { ...state.location },
      originalContentAvailable: state.originalContentAvailable,
      canOpen: state.canOpen,
    });
  }
  const current = inspectSelection(service, request, signal);
  if (current.status != "ready") {
    return current;
  }
  if (
    current.header.threadId !== conversationId ||
    !items.some(item => item.id == request.id) ||
    messageDB.getSearchChanges(0, 1).watermark !== watermark
  ) {
    return { status: "stale" };
  }
  signal?.throwIfAborted();
  return {
    status: "ready",
    sourceId,
    resultSetId: Services.uuid.generateUUID().toString(),
    conversationId,
    watermark,
    items,
    selectedId: request.id,
    selectedMessage: current.header,
    excludedCount,
  };
}
