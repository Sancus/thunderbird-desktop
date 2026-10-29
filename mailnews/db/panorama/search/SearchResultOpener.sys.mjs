/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  getMailSearchHeader,
  getMailSearchPolicy,
} from "resource:///modules/panorama/MailSearchPolicy.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  MailUtils: "resource:///modules/MailUtils.sys.mjs",
});

/**
 * @typedef {object} MailSearchLocation
 * @property {boolean} eligible - Current authoritative search eligibility.
 * @property {?{folderId: number, messageKey: number}} location - Current location.
 * @property {?nsIMsgFolder} folder - Current physical folder, or null without a location.
 * @property {boolean} originalContentAvailable - Original content is readable.
 * @property {boolean} canOpen - The original can be opened, including an online fetch.
 */

/**
 * Resolves the physical identity and observes cancellation before returning.
 *
 * @param {string} id - Stable physical identity.
 * @param {function(string, AbortSignal=): Promise<?MailSearchLocation>} resolveDocument -
 *   Current identity/location lookup. Must honor cancellation.
 * @param {AbortSignal} [signal] - Cancel lookup and prevent opening.
 * @returns {Promise<?MailSearchLocation>} Current authoritative state.
 */
async function lookup(id, resolveDocument, signal) {
  if (typeof id != "string" || !id || typeof resolveDocument != "function") {
    throw new TypeError("A physical identity and resolver are required");
  }
  signal?.throwIfAborted();
  const state = await resolveDocument(id, signal);
  signal?.throwIfAborted();
  return state;
}

/**
 * Checks current folder membership and policy without retaining an old header.
 *
 * @param {?MailSearchLocation} state - Authoritative current location.
 * @returns {{status: string, header: ?nsIMsgDBHdr,
 *   originalContentAvailable: boolean}} Ready, deleted, ineligible or unavailable.
 */
function checkLocation(state) {
  const result = {
    status: "unavailable",
    header: null,
    originalContentAvailable: state?.originalContentAvailable === true,
  };
  if (!state) {
    return { ...result, status: "deleted" };
  }
  if (state.eligible !== true) {
    return { ...result, status: "ineligible" };
  }
  if (state.canOpen !== true) {
    return result;
  }
  const current = getMailSearchHeader(state);
  if (!current) {
    return result;
  }
  if (!getMailSearchPolicy(current).eligible) {
    return { ...result, status: "ineligible" };
  }
  return { ...result, status: "ready", header: current };
}

/**
 * Resolves a result again and checks current folder/key membership and policy.
 * The resolver must map physical identity, never match by Message-ID.
 * Missing local content does not by itself prevent an online open.
 *
 * @param {string} id - Stable physical document identity from a search hit.
 * @param {function(string, AbortSignal=): Promise<?MailSearchLocation>} resolveDocument -
 *   Current identity/location lookup. Must honor cancellation.
 * @param {AbortSignal} [signal] - Cancel lookup.
 * @returns {Promise<{status: string, header: ?nsIMsgDBHdr,
 *   originalContentAvailable: boolean}>} Current resolution status.
 */
export async function resolveMailSearchResult(id, resolveDocument, signal) {
  return checkLocation(await lookup(id, resolveDocument, signal));
}

/**
 * Opens the freshly resolved physical copy through the normal mail reader.
 * Checks folder membership immediately before calling MailUtils.
 *
 * @param {string} id - Stable physical document identity.
 * @param {function(string, AbortSignal=): Promise<?MailSearchLocation>} resolveDocument -
 *   Current identity/location lookup. Must honor cancellation.
 * @param {object} [options] - Reader and cancellation options.
 * @param {AbortSignal} [options.signal] - Prevent opening after cancellation.
 * @param {DBViewWrapper} [options.viewWrapper] - View to clone for the reader.
 * @param {Element} [options.tabmail] - Target tabmail, or the normal reader default.
 * @returns {Promise<{status: string, header: ?nsIMsgDBHdr,
 *   originalContentAvailable: boolean}>} Resolution status; opens only when ready.
 */
export async function openMailSearchResult(
  id,
  resolveDocument,
  { signal, viewWrapper, tabmail } = {}
) {
  const state = await lookup(id, resolveDocument, signal);
  signal?.throwIfAborted();
  const result = checkLocation(state);
  if (result.status == "ready") {
    lazy.MailUtils.displayMessage(result.header, viewWrapper, tabmail);
  }
  return result;
}
