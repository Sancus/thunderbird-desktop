/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  getMailSearchHeader,
  getMailSearchPolicy,
} from "resource:///modules/panorama/MailSearchPolicy.sys.mjs";

/**
 * Decodes the global physical key without accepting aliases or Message-IDs.
 *
 * @param {string} id - Decimal global message key.
 * @returns {number} Exact nsMsgKey, excluding zero and the sentinel.
 */
export function mailSearchKey(id) {
  if (typeof id != "string" || !/^[1-9]\d*$/.test(id)) {
    throw new TypeError("Invalid physical mail identity");
  }
  const key = Number(id);
  if (!Number.isInteger(key) || key >= 0xffffffff || String(key) != id) {
    throw new TypeError("Invalid physical mail identity");
  }
  return key;
}

/**
 * Converts the core's decimal policy revision only within its checked safe range.
 * Content/location revision strings are never converted.
 *
 * @param {string} text - Core policy revision.
 * @returns {number} Exact revision accepted by the sidecar.
 */
export function mailPolicyRevision(text) {
  const revision = Number(text);
  if (
    typeof text != "string" ||
    !/^(0|[1-9]\d*)$/.test(text) ||
    !Number.isSafeInteger(revision)
  ) {
    throw new TypeError("Unsafe core search policy revision");
  }
  return revision;
}

/**
 * Checks this message's local stream without downloading or changing flags.
 * Per-message stream errors leave metadata eligible and remain reportable.
 * Core database errors are outside this probe and still propagate.
 *
 * @param {nsIMsgDBHdr} header - Current physical message header.
 * @param {object} raw - Authoritative core state.
 * @returns {{available: boolean, error: ?Error}} Local readability and stream error.
 */
function originalContent(header, raw) {
  // GetMsgInputStream clears Offline for an empty token on every folder type.
  if (!raw.storeToken) {
    return { available: false, error: null };
  }
  const local = header.folder instanceof Ci.nsIMsgLocalMailFolder;
  if (!local && !(raw.flags & Ci.nsMsgMessageFlags.Offline)) {
    return { available: false, error: null };
  }
  let stream;
  let available = false;
  let failure = null;
  try {
    stream = header.folder.getMsgInputStream(header);
    available = stream.available() > 0;
  } catch (error) {
    failure = error;
  }
  try {
    stream?.close();
  } catch (error) {
    failure = failure
      ? new AggregateError(
          [failure, error],
          "Message stream read and close failed"
        )
      : error;
  }
  return { available: !failure && available, error: failure };
}

/**
 * Resolves a physical result through core046's committed state API.
 * Never calls back into the search index. A header wrapper is obtained only
 * after core proves the row exists, then checked against its physical folder.
 *
 * @param {nsIMessageDatabase} messageDB - Current core message database.
 * @param {string} id - Decimal physical global key.
 * @param {AbortSignal} [signal] - Prevent lookup/delivery after cancellation.
 * @returns {?SearchDocumentState} Current policy, revisions and native location.
 */
export function resolveMailSearchDocument(messageDB, id, signal) {
  signal?.throwIfAborted();
  const key = mailSearchKey(id);
  const raw = messageDB.getSearchState(key);
  if (!raw) {
    return null;
  }
  const location = { folderId: raw.folderId, messageKey: key };
  const revisions = {
    generation: raw.generation,
    contentRevision: raw.contentRevision,
    policyRevision: mailPolicyRevision(raw.policyRevision),
    metadataRevision: raw.metadataRevision,
    locationRevision: raw.locationRevision,
  };
  // Core048 retains physical rows after deleting their folder. Do not ask a
  // header wrapper to resolve a missing folder, or mistake the row for deletion.
  if (raw.folderFlags === null) {
    signal?.throwIfAborted();
    return {
      ...revisions,
      eligible: false,
      location,
      folder: null,
      originalContentAvailable: false,
      canOpen: false,
    };
  }
  const header = messageDB.getMessage(key);
  const folder = header.folder;
  if (!getMailSearchHeader({ folder, location })) {
    throw Components.Exception(
      "Search location changed",
      Cr.NS_ERROR_IN_PROGRESS
    );
  }
  const policy = getMailSearchPolicy(header);
  const content = policy.eligible
    ? originalContent(header, raw)
    : { available: false, error: null };
  // Reject any native mutation during the probe; errors reading only this
  // message body do not invalidate the committed metadata state.
  const current = messageDB.getSearchState(key);
  if (
    !current ||
    current.generation != raw.generation ||
    current.policyRevision != raw.policyRevision
  ) {
    throw Components.Exception("Search state changed", Cr.NS_ERROR_IN_PROGRESS);
  }
  signal?.throwIfAborted();
  return {
    eligible: policy.eligible,
    ...revisions,
    location,
    folder,
    originalContentAvailable: content.available,
    contentError: content.error,
    canOpen:
      policy.eligible &&
      (content.available ||
        (!(folder instanceof Ci.nsIMsgLocalMailFolder) &&
          folder.supportsOffline &&
          !Services.io.offline)),
  };
}
