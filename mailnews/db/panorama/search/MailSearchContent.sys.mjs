/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readMailSearchAttachmentInfo } from "resource:///modules/panorama/MailSearchAttachments.sys.mjs";
import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { MailStringUtils } from "resource:///modules/MailStringUtils.sys.mjs";
import { MsgHdrToMimeMessage } from "resource:///modules/panorama/MimeMessage.sys.mjs";
import {
  getMailSearchHeader,
  getMailSearchPolicy,
  MAIL_SEARCH_MIME_OPTIONS,
} from "resource:///modules/panorama/MailSearchPolicy.sys.mjs";
import {
  getMailSearchPartType,
  normalizeMailSearchMimeType,
} from "resource:///modules/panorama/MailSearchMimeTypes.sys.mjs";
import { getMailBodyText } from "resource:///modules/panorama/MessageContent.sys.mjs";

/**
 * Adds current address-book names to decoded message addresses.
 *
 * @param {string} raw - Encoded address header.
 * @param {string} decoded - Decoded names and addresses.
 * @returns {string} Searchable header and address-book names.
 */
function addressText(raw, decoded) {
  const names = new Set();
  for (const address of MailServices.headerParser.parseEncodedHeaderW(raw)) {
    const name = MailServices.ab.cardForEmailAddress(
      address.email
    )?.displayName;
    if (name) {
      names.add(name);
    }
  }
  return [decoded, ...names].filter(Boolean).join(" ");
}

/**
 * Streams MIME with encrypted parts hidden; downloads require explicit permission.
 * Aborting rejects delivery; the shared MIME stream still drains its callback.
 *
 * @param {nsIMsgDBHdr} header - Current physical header.
 * @param {object} [options] - Retrieval controls.
 * @param {AbortSignal} [options.signal] - Cancel MIME delivery; the stream still drains.
 * @param {boolean} [options.allowDownload=false] - Permit an explicit online retrieval.
 * @returns {Promise<MimeMessage>} Parsed MIME representation.
 * @throws {Error} For successful retrieval without a MIME result.
 * @throws {nsIException} With the original failed message-service nsresult.
 * @throws {TypeError} For a non-boolean download permission.
 */
export async function readMailSearchMime(
  header,
  { signal, allowDownload = false } = {}
) {
  if (typeof allowDownload != "boolean") {
    throw new TypeError("Download permission must be boolean");
  }
  signal?.throwIfAborted();
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      MsgHdrToMimeMessage(
        header,
        null,
        (msgHdr, mime, status) => {
          if (!Components.isSuccessCode(status)) {
            reject(Components.Exception("MIME retrieval failed", status));
          } else if (!mime) {
            reject(new Error("MIME stream completed without a MIME result"));
          } else {
            resolve(mime);
          }
        },
        allowDownload,
        MAIL_SEARCH_MIME_OPTIONS
      );
    });
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/**
 * Finds encrypted containers that the MIME helper deliberately hides.
 *
 * @param {MimeMessage|MimeContainer} part - Parsed MIME part.
 * @returns {boolean} Whether any encrypted part prevents proving absence.
 */
function containsEncryptedPart(part) {
  return part.isEncrypted || (part.parts?.some(containsEncryptedPart) ?? false);
}

/**
 * Copies declared or MIME-default types without examining encrypted children.
 * Hidden encrypted or invalid type metadata prevents proving full coverage.
 *
 * @param {MimeMessage} mime - MIME tree with encrypted children removed.
 * @returns {{types: string[], complete: boolean}} Observed types and coverage.
 */
export function getMailSearchAttachmentEvidence(mime) {
  const observed = mime.allAttachments.map(getMailSearchPartType);
  return {
    types: [...new Set(observed.filter(Boolean))],
    complete:
      !containsEncryptedPart(mime) && observed.every(type => type !== null),
  };
}

/**
 * Reads attachment presence without treating unusable MIME types as absence.
 *
 * @param {MimeMessage} mime - Parsed tree with encrypted children hidden.
 * @returns {?boolean} True for an observed type, false only for an unencrypted
 *   tree without attachment parts, or null for unknown presence.
 */
export function getMailSearchAttachmentPresence(mime) {
  const attachments = mime.allAttachments;
  if (
    attachments.some(
      part =>
        typeof part?.contentType == "string" &&
        normalizeMailSearchMimeType(part.contentType)
    )
  ) {
    return true;
  }
  return attachments.length || containsEncryptedPart(mime) ? null : false;
}

/**
 * Copies user-visible attachment details, including attached messages.
 * Hidden encrypted children leave the enumeration incomplete.
 *
 * @param {MimeMessage} mime - Parsed tree with encrypted children removed.
 * @returns {{items: MailSearchAttachmentInfo[], complete: boolean}} Observed details.
 */
export function getMailSearchAttachmentInfos(mime) {
  return {
    items: mime.allUserAttachments.map(readMailSearchAttachmentInfo),
    complete: !containsEncryptedPart(mime),
  };
}

/**
 * Copies current decoded headers and address-book names without opening MIME.
 *
 * @param {SearchIndexJob} job - Exact pending work token.
 * @param {SearchDocumentState & {folder: ?nsIMsgFolder}} state - Authoritative
 *   revisions, current folder/key and eligibility from the resolver.
 * @param {AbortSignal} [signal] - Cancel metadata delivery.
 * @returns {?SearchDocument} Metadata-only text, or null without eligible metadata.
 */
export function loadMailSearchMetadata(job, state, signal) {
  signal?.throwIfAborted();
  if (
    state.eligible !== true ||
    state.generation != job.generation ||
    (state.policyRevision ?? 0) != job.policyRevision
  ) {
    return null;
  }
  const header = getMailSearchHeader(state);
  if (!header || !getMailSearchPolicy(header).eligible) {
    return null;
  }
  const recipientHeaders = [header.recipients, header.ccList, header.bccList];
  const decodedRecipients = recipientHeaders.map(raw =>
    MailServices.mimeConverter.decodeMimeHeader(
      MailStringUtils.stringToByteString(raw),
      null,
      false,
      true
    )
  );
  return {
    id: job.id,
    generation: job.generation,
    policyRevision: job.policyRevision,
    contentRevision: state.contentRevision,
    subject: header.mime2DecodedSubject,
    body: "",
    bodyIndexed: false,
    attachmentNames: "",
    attachmentPresence: null,
    attachmentTypes: null,
    attachmentInfos: null,
    author: addressText(header.author, header.mime2DecodedAuthor),
    recipients: recipientHeaders
      .map((raw, i) => addressText(raw, decodedRecipients[i]))
      .join(" "),
  };
}

/**
 * Loads policy-approved headers and locally available MIME without downloading.
 * A failed or tree-less retrieval returns metadata with unknown body/attachments.
 * Without current canonical body text, the index keeps the body job unavailable
 * for explicit retry.
 *
 * @param {SearchIndexJob} job - Exact pending work token.
 * @param {SearchDocumentState} state - Current physical location and revisions.
 * @param {AbortSignal} [signal] - Cancel MIME delivery.
 * @returns {Promise<?SearchDocument>} Parsed text, metadata-only text, or null when ineligible.
 * @throws {Error} Cancellation or metadata/content-processing errors outside retrieval.
 */
export async function loadMailSearchDocument(job, state, signal) {
  const document = loadMailSearchMetadata(job, state, signal);
  if (!document) {
    return null;
  }
  const header = getMailSearchHeader(state);
  if (
    state.originalContentAvailable !== true ||
    (!(header.flags & Ci.nsMsgMessageFlags.Offline) &&
      !(header.folder instanceof Ci.nsIMsgLocalMailFolder))
  ) {
    return document;
  }
  let mime;
  try {
    mime = await readMailSearchMime(header, { signal });
  } catch {
    signal?.throwIfAborted();
    return document;
  }
  signal?.throwIfAborted();
  const attachments = mime.allAttachments;
  const evidence = getMailSearchAttachmentEvidence(mime);
  return {
    ...document,
    bodyIndexed: true,
    body: getMailBodyText(
      mime.coerceBodyToPlaintext(header.folder).split(/\r?\n/)
    ),
    attachmentNames: attachments.map(part => part.name).join("\n"),
    attachmentPresence: getMailSearchAttachmentPresence(mime),
    attachmentTypes: evidence,
    attachmentInfos: getMailSearchAttachmentInfos(mime),
  };
}
