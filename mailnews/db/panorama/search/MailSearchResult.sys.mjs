/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { copyMailSearchAttachmentInfos } from "resource:///modules/panorama/MailSearchAttachments.sys.mjs";
import { copyMailSearchMimeEvidence } from "resource:///modules/panorama/MailSearchMimeTypes.sys.mjs";
import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { getMailSearchHeader } from "resource:///modules/panorama/MailSearchPolicy.sys.mjs";
import { getSearchBodySnippet } from "resource:///modules/panorama/SearchOffsets.sys.mjs";

/**
 * @typedef {object} SearchMailbox
 * @property {string} name - Current address-book name or decoded header name.
 * @property {string} email - Mailbox address with its original case.
 */

/**
 * @typedef {object} MailSearchResult
 * @property {string} id - Physical global message key.
 * @property {number} generation - Indexed native generation.
 * @property {string} contentRevision - Indexed semantic source revision.
 * @property {number} policyRevision - Indexed eligibility revision.
 * @property {string} textRevision - Stored text used by the snippet.
 * @property {{folderId: number, messageKey: number}} location - Current location.
 * @property {string} messageId - Header value for presentation, not identity.
 * @property {string} subject - Current indexed subject.
 * @property {Date} date - Message date copied from the native header.
 * @property {SearchMailbox[]} from - Sender mailboxes.
 * @property {SearchMailbox[]} to - To mailboxes.
 * @property {SearchMailbox[]} cc - Cc mailboxes.
 * @property {SearchMailbox[]} bcc - Bcc mailboxes.
 * @property {string[]} tagKeys - Distinct native keyword keys.
 * @property {boolean} read - Native read flag.
 * @property {boolean} starred - Native marked flag.
 * @property {boolean} hasAttachments - Native attachment flag (heuristic).
 * @property {?{types: string[], complete: boolean}} attachmentTypes - Observed MIME types; incomplete evidence cannot prove absence.
 * @property {?{items: MailSearchAttachmentInfo[], complete: boolean}} attachmentInfos - Copied user attachments, with unknown fields kept null.
 * @property {?boolean} attachmentPresence - MIME-proven presence, or null when unknown.
 * @property {?{text: string, ranges: {start: number, end: number}[],
 *   firstMatchText: ?string}} snippet - Revision-bound body snippet.
 * @property {boolean} originalContentAvailable - Local original is readable.
 * @property {boolean} canOpen - Native original can currently be opened.
 */

/**
 * Copies current display names without changing case or collapsing addresses.
 *
 * @param {string} value - Encoded native address header.
 * @returns {SearchMailbox[]} Mailboxes in header order.
 */
function mailboxes(value) {
  return MailServices.headerParser
    .parseEncodedHeaderW(value)
    .filter(address => address.email)
    .map(address => ({
      name:
        MailServices.ab.cardForEmailAddress(address.email)?.displayName ||
        address.name,
      email: address.email,
    }));
}

/**
 * Checks whether native state still describes this physical hit.
 *
 * @param {?SearchDocumentState} state - Authoritative current state.
 * @param {SearchHit} hit - Result being displayed.
 * @returns {boolean} Whether this result is current and eligible.
 */
function matchesHit(state, hit) {
  return (
    state?.eligible === true &&
    state.generation === hit.generation &&
    state.contentRevision === hit.contentRevision &&
    state.policyRevision === hit.policyRevision
  );
}

/**
 * Copies current native mail metadata and a revision-bound snippet for a hit.
 * Returns null when the copy or projection changed during lookup. The caller
 * keeps the query page's resultSetId; this does not compute facet membership.
 * messageId is presentation data only. id remains the selected physical copy.
 *
 * @param {MailSearchService} service - Open replacement mail search service.
 * @param {SearchHit} hit - Physical hit returned by that service.
 * @param {object} [options] - Lookup controls.
 * @param {AbortSignal} [options.signal] - Cancel lookup and result delivery.
 * @returns {Promise<?MailSearchResult>} Copied metadata/snippet, or null for a stale hit.
 * @throws {TypeError} If the hit has no physical identity.
 */
export async function readMailSearchResult(service, hit, { signal } = {}) {
  if (typeof hit?.id != "string" || !hit.id) {
    throw new TypeError("A physical search hit is required");
  }
  signal?.throwIfAborted();
  const text = await service.getText(hit.id, { signal });
  signal?.throwIfAborted();
  if (!text || text.id !== hit.id || text.textRevision !== hit.textRevision) {
    return null;
  }
  const state = service.resolveDocument(hit.id, signal);
  if (!matchesHit(state, hit)) {
    return null;
  }
  const header = getMailSearchHeader(state);
  if (!header) {
    return null;
  }
  const flags = header.flags;
  const result = {
    id: hit.id,
    generation: hit.generation,
    contentRevision: hit.contentRevision,
    policyRevision: hit.policyRevision,
    textRevision: hit.textRevision,
    location: { ...state.location },
    messageId: header.messageId,
    subject: text.subject,
    date: new Date(header.date / 1000),
    from: mailboxes(header.author),
    to: mailboxes(header.recipients),
    cc: mailboxes(header.ccList),
    bcc: mailboxes(header.bccList),
    tagKeys: [
      ...new Set(
        header.getStringProperty("keywords").split(" ").filter(Boolean)
      ),
    ],
    read: !!(flags & Ci.nsMsgMessageFlags.Read),
    starred: !!(flags & Ci.nsMsgMessageFlags.Marked),
    hasAttachments: !!(flags & Ci.nsMsgMessageFlags.Attachment),
    attachmentPresence: text.attachmentPresence ?? null,
    attachmentTypes: copyMailSearchMimeEvidence(text.attachmentTypes),
    attachmentInfos: copyMailSearchAttachmentInfos(text.attachmentInfos),
    snippet: getSearchBodySnippet(hit, text),
  };
  const current = service.resolveDocument(hit.id, signal);
  signal?.throwIfAborted();
  if (!matchesHit(current, hit)) {
    return null;
  }
  return {
    ...result,
    originalContentAvailable: current.originalContentAvailable,
    canOpen: current.canOpen,
  };
}

/**
 * @typedef {{type: "person", emails: string[]}|{type: "tag", key: string}} MailSearchSelection
 * Person addresses match any From/To/Cc/Bcc mailbox. Tag keys match exactly.
 */

/**
 * @typedef {object} MailSearchResultSet
 * @property {string} sourceId - Native database incarnation.
 * @property {string} resultSetId - Identity shared by these query pages.
 * @property {MailSearchResult[]} items - Physical members with current metadata.
 */

/**
 * Copies a typed autocomplete selection before asynchronous work starts.
 *
 * @param {?MailSearchSelection} selection - Person addresses or native tag key.
 * @returns {?MailSearchSelection} Independent selection; emails are lowercase.
 * @throws {TypeError} If the selection is unsupported or empty.
 */
export function copyMailSearchSelection(selection) {
  if (selection == null) {
    return null;
  }
  if (
    selection.type == "tag" &&
    typeof selection.key == "string" &&
    selection.key
  ) {
    return { type: "tag", key: selection.key };
  }
  if (
    selection.type == "person" &&
    Array.isArray(selection.emails) &&
    selection.emails.length &&
    selection.emails.every(
      email => typeof email == "string" && email && email == email.trim()
    )
  ) {
    return {
      type: "person",
      emails: [...new Set(selection.emails.map(email => email.toLowerCase()))],
    };
  }
  throw new TypeError("Expected a person or tag search selection");
}

/**
 * Tests exact typed values against a copied result, without FTS tokenization.
 *
 * @param {MailSearchResult} result - Current physical result.
 * @param {?MailSearchSelection} selection - Copied typed selection.
 * @returns {boolean} Whether any selected mailbox, or the tag key, matches.
 */
export function matchesMailSearchSelection(result, selection) {
  if (!selection) {
    return true;
  }
  if (selection.type == "tag") {
    return result.tagKeys.includes(selection.key);
  }
  return ["from", "to", "cc", "bcc"].some(field =>
    result[field].some(address =>
      selection.emails.includes(address.email.toLowerCase())
    )
  );
}

/**
 * Groups one result snapshot for participant, tag and folder facets.
 * Each group contains physical IDs once per message. Counts and list export
 * use these same members. The caller applies display-only duplicate grouping.
 * This does not subscribe to later changes or supply the other legacy facets.
 *
 * @param {MailSearchResultSet} resultSet - Full query or its active subset.
 * @returns {{resultSetId: string, participants: {value: string, ids: string[]}[],
 *   tags: {value: string, ids: string[]}[], folders: {value: number, ids: string[]}[]}}
 *   Groups in first-occurrence order. A group's count is its ids.length.
 */
export function getMailSearchFacets(resultSet) {
  const participants = new Map();
  const tags = new Map();
  const folders = new Map();
  for (const result of resultSet.items) {
    const emails = new Set(
      ["from", "to", "cc", "bcc"].flatMap(field =>
        result[field].map(address => address.email.toLowerCase())
      )
    );
    for (const [groups, values] of [
      [participants, emails],
      [tags, result.tagKeys],
      [folders, [result.location.folderId]],
    ]) {
      for (const value of new Set(values)) {
        if (!groups.has(value)) {
          groups.set(value, []);
        }
        groups.get(value).push(result.id);
      }
    }
  }
  const entries = groups => [...groups].map(([value, ids]) => ({ value, ids }));
  return {
    resultSetId: resultSet.resultSetId,
    participants: entries(participants),
    tags: entries(tags),
    folders: entries(folders),
  };
}
