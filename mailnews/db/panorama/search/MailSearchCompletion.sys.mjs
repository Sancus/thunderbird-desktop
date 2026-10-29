/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { getMailSearchHeader } from "resource:///modules/panorama/MailSearchPolicy.sys.mjs";

/**
 * @typedef {object} MailSearchCompletion
 * @property {string} label - Current display name or configured tag label.
 * @property {MailSearchSelection} selection - Literal mailbox addresses or tag key.
 */

/**
 * Keeps the legacy three-character or single-CJK people threshold.
 *
 * @param {string} text - Search input.
 * @returns {boolean} Whether people completion is enabled.
 */
export function canCompleteMailSearchPeople(text) {
  return text.length >= 3 || /[ぁ-鿿가-퟿豈-ￜ]/.test(text);
}

/**
 * Resolves a candidate's current physical header without trusting stale text.
 *
 * @param {MailSearchService} service - Current native resolver.
 * @param {SearchHit} hit - Indexed metadata token.
 * @param {AbortSignal} signal - Cancellation.
 * @returns {?nsIMsgDBHdr} Eligible header with the same native revisions.
 */
function completionHeader(service, hit, signal) {
  const state = service.resolveDocument(hit.id, signal);
  return state?.eligible &&
    state.generation === hit.generation &&
    state.policyRevision === hit.policyRevision &&
    state.contentRevision === hit.contentRevision
    ? getMailSearchHeader(state)
    : null;
}

/**
 * Copies matching current From/To/Cc/Bcc mailboxes and address-book names.
 *
 * @param {nsIMsgDBHdr} header - Eligible current header.
 * @param {string} needle - Lowercase literal substring.
 * @returns {MailSearchCompletion[]} Matching individual mailboxes, not messages.
 */
function peopleForHeader(header, needle) {
  const people = [];
  for (const field of ["author", "recipients", "ccList", "bccList"]) {
    for (const address of MailServices.headerParser.parseEncodedHeaderW(
      header[field]
    )) {
      if (!address.email) {
        continue;
      }
      const email = address.email.toLowerCase();
      const cardName = MailServices.ab.cardForEmailAddress(email)?.displayName;
      const label = cardName || address.name || email;
      if (
        [email, address.name, cardName].some(value =>
          value?.toLowerCase().includes(needle)
        )
      ) {
        people.push({ label, selection: { type: "person", emails: [email] } });
      }
    }
  }
  return people;
}

/**
 * Completes indexed headers without loading MIME or rescanning core.
 * Each kind has its own limit, so many people cannot hide matching tags. People
 * are deduplicated by mailbox; physical membership is resolved only on search.
 * Unindexed/invalidated metadata waits for the existing visible rebuild.
 *
 * @param {MailSearchService} service - Existing native service.
 * @param {PanoramaSearchIndex} index - Its existing metadata sidecar.
 * @param {string} sourceId - Actual database incarnation.
 * @param {string} text - Literal completion substring, not an FTS expression.
 * @param {object} [options={}] - Query controls.
 * @param {number} [options.limit=20] - Maximum choices per kind, from 1 to 100.
 * @param {AbortSignal} [options.signal] - Cancel native selection/delivery.
 * @returns {Promise<{sourceId: string, items: MailSearchCompletion[]}>} Current choices.
 * @throws {RangeError} For an invalid limit. Native/storage errors propagate.
 */
export async function completeMailSearchMetadata(
  service,
  index,
  sourceId,
  text,
  { limit = 20, signal } = {}
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Completion limit must be from 1 to 100");
  }
  signal?.throwIfAborted();
  const needle = text.trim().toLowerCase();
  const people = new Map();
  if (needle && canCompleteMailSearchPeople(text)) {
    let after = 0;
    do {
      const page = await index.getCompletionPage(needle, { after, signal });
      for (const hit of page.items) {
        signal?.throwIfAborted();
        const header = completionHeader(service, hit, signal);
        if (!header) {
          continue;
        }
        for (const person of peopleForHeader(header, needle)) {
          const email = person.selection.emails[0];
          if (!people.has(email)) {
            people.set(email, hit);
          }
          if (people.size == limit) {
            break;
          }
        }
        if (people.size == limit) {
          break;
        }
      }
      after = page.nextKey;
    } while (after !== null && people.size < limit);
  }
  const items = [];
  for (const [email, hit] of people) {
    signal?.throwIfAborted();
    const header = completionHeader(service, hit, signal);
    const person =
      header &&
      peopleForHeader(header, needle).find(
        item => item.selection.emails[0] === email
      );
    if (person) {
      items.push(person);
    }
  }
  if (needle && text.length >= 2) {
    items.push(
      ...MailServices.tags
        .getAllTags()
        .filter(tag => tag.tag.toLowerCase().includes(needle))
        .slice(0, limit)
        .map(tag => ({
          label: tag.tag,
          selection: { type: "tag", key: tag.key },
        }))
    );
  }
  signal?.throwIfAborted();
  if (
    !Services.prefs.getBoolPref(
      "mailnews.database.global.indexer.enabled",
      false
    )
  ) {
    items.length = 0;
  }
  return { sourceId, items };
}
