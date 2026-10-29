/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import {
  getMailSearchMimeCategory,
  normalizeMailSearchMimeType,
} from "resource:///modules/panorama/MailSearchMimeTypes.sys.mjs";
import { getMailSearchFacets } from "resource:///modules/panorama/MailSearchResult.sys.mjs";

/**
 * @typedef {{value: string|number|boolean|null, ids: string[]}} MailSearchFacetGroup
 */

/**
 * @typedef {object} MailSearchFacetData
 * @property {string} sourceId - Native incarnation of these physical members.
 * @property {string} resultSetId - Shared query snapshot identity.
 * @property {MailSearchFacetGroup[]} participants - Mailboxes except own labels.
 * @property {MailSearchFacetGroup[]} tags - Native tag keys.
 * @property {MailSearchFacetGroup[]} folders - Physical folder IDs.
 * @property {MailSearchFacetGroup[]} read - True, false and unknown groups.
 * @property {MailSearchFacetGroup[]} starred - True, false and unknown groups.
 * @property {MailSearchFacetGroup[]} attachmentTypes - Observed types and null for unknown coverage.
 * @property {MailSearchFacetGroup[]} attachmentCategories - Retained category keys and unknown coverage.
 * @property {MailSearchFacetGroup[]} hasAttachments - MIME-proven presence groups.
 * @property {MailSearchFacetGroup[]} fromMe - Own sender with at least one recipient.
 * @property {MailSearchFacetGroup[]} toMe - To/Cc/Bcc membership in own identities.
 * @property {{oldest: ?Date, newest: ?Date, validIds: string[],
 *   missingIds: string[], unreasonableIds: string[]}} dates - Histogram inputs.
 */

const BOOLEAN_FACETS = ["read", "starred", "hasAttachments", "fromMe", "toMe"];

/**
 * Returns current account email and Reply-To identities without caching them.
 *
 * @returns {string[]} Distinct lowercase mailbox addresses.
 */
export function getMailSearchOwnEmails() {
  const emails = new Set();
  for (const identity of MailServices.accounts.allIdentities) {
    for (const value of [identity.email, identity.replyTo]) {
      const address = MailServices.headerParser.parseEncodedHeaderW(value)[0];
      if (address?.email) {
        emails.add(address.email.toLowerCase());
      }
    }
  }
  return [...emails];
}

/**
 * Validates caller-supplied own identities without changing the input.
 *
 * @param {string[]} emails - Plain mailbox addresses.
 * @returns {Set<string>} Lowercase addresses.
 */
function ownAddresses(emails) {
  if (
    !Array.isArray(emails) ||
    emails.some(email => typeof email != "string" || !email)
  ) {
    throw new TypeError("Expected own mailbox addresses");
  }
  return new Set(emails.map(email => email.toLowerCase()));
}

/**
 * Reads real Date values across caller realms.
 *
 * @param {?Date} date - Result date or filter boundary.
 * @returns {?number} Milliseconds, or null for missing/invalid dates.
 */
function dateTime(date) {
  try {
    const time = Date.prototype.getTime.call(date);
    return Number.isFinite(time) ? time : null;
  } catch {
    return null;
  }
}

/**
 * Tests one or more address roles. Missing arrays remain unknown.
 *
 * @param {MailSearchResult} result - Copied physical result.
 * @param {string[]} fields - Address roles.
 * @param {Set<string>} own - Current own identities.
 * @returns {?boolean} Whether an own address occurs, or null without metadata.
 */
function involvesOwn(result, fields, own) {
  if (
    fields.some(
      field =>
        Array.isArray(result[field]) &&
        result[field].some(address => own.has(address.email.toLowerCase()))
    )
  ) {
    return true;
  }
  return fields.some(field => !Array.isArray(result[field])) ? null : false;
}

/**
 * Reads boolean facet values without converting unknown values to false.
 *
 * @param {MailSearchResult} result - Copied physical result.
 * @param {string} field - Supported boolean facet.
 * @param {Set<string>} own - Current own identities.
 * @returns {?boolean} Known value, or null for unknown metadata.
 */
function booleanValue(result, field, own) {
  if (field == "fromMe") {
    const sender = involvesOwn(result, ["from"], own);
    if (sender !== true) {
      return sender;
    }
    const recipients = ["to", "cc", "bcc"];
    if (
      recipients.some(
        role => Array.isArray(result[role]) && result[role].length
      )
    ) {
      return true;
    }
    return recipients.some(role => !Array.isArray(result[role])) ? null : false;
  }
  if (field == "toMe") {
    return involvesOwn(result, ["to", "cc", "bcc"], own);
  }
  const value =
    field == "hasAttachments" ? result.attachmentPresence : result[field];
  return typeof value == "boolean" ? value : null;
}

/**
 * Refines a full physical snapshot with date and boolean facet selections.
 * Date bounds are inclusive, with OR between ranges and AND between fields.
 * A selected boolean matches only a known value. Unknowns match neither true
 * nor false. Display-only duplicate grouping is not applied here.
 *
 * @param {MailSearchResultSet} resultSet - Query snapshot or active subset.
 * @param {object} [filters] - Facet selections.
 * @param {Array<[?Date, ?Date]>} [filters.dateRanges] - Inclusive ranges; null is open.
 * @param {boolean} [filters.read] - Native read state.
 * @param {boolean} [filters.starred] - Native marked state.
 * @param {string[]} [filters.attachmentTypes] - Match any observed normalized MIME type.
 * @param {string[]} [filters.attachmentCategories] - Match any retained category key.
 * @param {boolean} [filters.hasAttachments] - MIME-proven attachment presence.
 * @param {boolean} [filters.fromMe] - Own sender has at least one To/Cc/Bcc recipient.
 * @param {boolean} [filters.toMe] - To/Cc/Bcc includes an own identity.
 * @param {string[]} [filters.ownEmails] - Defaults to current account identities.
 * @returns {MailSearchResultSet} Same source/result token with filtered members.
 * @throws {TypeError} For invalid selections or date bounds.
 */
export function refineMailSearchResults(
  resultSet,
  {
    dateRanges,
    attachmentTypes,
    attachmentCategories,
    ownEmails = getMailSearchOwnEmails(),
    ...filters
  } = {}
) {
  const own = ownAddresses(ownEmails);
  for (const values of [attachmentTypes, attachmentCategories]) {
    if (
      values !== undefined &&
      (!Array.isArray(values) ||
        !values.length ||
        values.some(value => typeof value != "string" || !value))
    ) {
      throw new TypeError("Expected attachment facet values");
    }
  }
  if (
    attachmentTypes?.some(type => normalizeMailSearchMimeType(type) !== type) ||
    attachmentCategories?.some(
      category =>
        !["archives", "documents", "images", "media", "other", "pdf"].includes(
          category
        )
    )
  ) {
    throw new TypeError("Invalid attachment facet value");
  }
  for (const [field, value] of Object.entries(filters)) {
    if (!BOOLEAN_FACETS.includes(field) || typeof value != "boolean") {
      throw new TypeError("Unsupported mail search facet selection");
    }
  }
  let ranges = null;
  if (dateRanges !== undefined) {
    if (!Array.isArray(dateRanges) || !dateRanges.length) {
      throw new TypeError("Expected date ranges");
    }
    ranges = dateRanges.map(range => {
      if (!Array.isArray(range) || range.length != 2) {
        throw new TypeError("Expected two date bounds");
      }
      const [start, end] = range.map(value =>
        value === null ? null : dateTime(value)
      );
      if (
        range.some((value, i) => value !== null && [start, end][i] === null) ||
        (start !== null && end !== null && start > end)
      ) {
        throw new TypeError("Invalid date range");
      }
      return [start, end];
    });
  }
  return {
    ...resultSet,
    items: resultSet.items.filter(result => {
      if (ranges) {
        const time = dateTime(result.date);
        if (
          time === null ||
          !ranges.some(
            ([start, end]) =>
              (start === null || time >= start) && (end === null || time <= end)
          )
        ) {
          return false;
        }
      }
      const observed = result.attachmentTypes?.types ?? [];
      if (
        (attachmentTypes &&
          !observed.some(type => attachmentTypes.includes(type))) ||
        (attachmentCategories &&
          !observed.some(type =>
            attachmentCategories.includes(getMailSearchMimeCategory(type))
          ))
      ) {
        return false;
      }
      return Object.entries(filters).every(
        ([field, value]) => booleanValue(result, field, own) === value
      );
    }),
  };
}

/**
 * Adds date/boolean facets and hides own participant labels for display.
 * Physical query members and opening identities are unchanged. Null boolean
 * groups expose unknowns. Date histogram inputs retain the legacy reasonable
 * range: February 1, 1970 through three days after now.
 *
 * @param {MailSearchResultSet} resultSet - Full query or active subset.
 * @param {object} [options] - Display context.
 * @param {string[]} [options.ownEmails] - Defaults to current account identities.
 * @param {Date} [options.now] - Reference time for the date histogram.
 * @returns {MailSearchFacetData} Physical groups and date histogram inputs.
 */
export function getMailSearchFacetData(
  resultSet,
  { ownEmails = getMailSearchOwnEmails(), now = new Date() } = {}
) {
  const own = ownAddresses(ownEmails);
  const nowTime = dateTime(now);
  if (nowTime === null) {
    throw new TypeError("Expected a reference date");
  }
  const facets = getMailSearchFacets({
    ...resultSet,
    items: resultSet.items.map(result => ({
      ...result,
      ...Object.fromEntries(
        ["from", "to", "cc", "bcc"].map(field => [
          field,
          Array.isArray(result[field]) ? result[field] : [],
        ])
      ),
    })),
  });
  facets.sourceId = resultSet.sourceId;
  facets.participants = facets.participants.filter(
    group => !own.has(group.value)
  );
  for (const field of BOOLEAN_FACETS) {
    const groups = new Map();
    for (const result of resultSet.items) {
      const value = booleanValue(result, field, own);
      if (!groups.has(value)) {
        groups.set(value, []);
      }
      groups.get(value).push(result.id);
    }
    facets[field] = [...groups].map(([value, ids]) => ({ value, ids }));
  }
  for (const field of ["attachmentTypes", "attachmentCategories"]) {
    const groups = new Map();
    for (const result of resultSet.items) {
      const evidence = result.attachmentTypes;
      const values = new Set(
        (evidence?.types ?? []).map(type =>
          field == "attachmentTypes" ? type : getMailSearchMimeCategory(type)
        )
      );
      if (!evidence?.complete) {
        values.add(null);
      }
      for (const value of values) {
        if (!groups.has(value)) {
          groups.set(value, []);
        }
        groups.get(value).push(result.id);
      }
    }
    facets[field] = [...groups].map(([value, ids]) => ({ value, ids }));
  }
  const dates = {
    oldest: null,
    newest: null,
    validIds: [],
    missingIds: [],
    unreasonableIds: [],
  };
  const tooOld = new Date(1970, 1, 1).getTime();
  const tooNew = nowTime + 3 * 24 * 60 * 60 * 1000;
  for (const result of resultSet.items) {
    const time = dateTime(result.date);
    if (time === null) {
      dates.missingIds.push(result.id);
    } else if (time < tooOld || time > tooNew) {
      dates.unreasonableIds.push(result.id);
    } else {
      dates.validIds.push(result.id);
      dates.oldest =
        dates.oldest === null ? time : Math.min(dates.oldest, time);
      dates.newest =
        dates.newest === null ? time : Math.max(dates.newest, time);
    }
  }
  dates.oldest = dates.oldest === null ? null : new Date(dates.oldest);
  dates.newest = dates.newest === null ? null : new Date(dates.newest);
  return { ...facets, dates };
}
