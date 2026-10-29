/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { mailSearchKey } from "resource:///modules/panorama/MailSearchSource.sys.mjs";
import {
  getMailSearchHeader,
  getMailSearchPolicy,
} from "resource:///modules/panorama/MailSearchPolicy.sys.mjs";
import { readMailSearchMime } from "resource:///modules/panorama/MailSearchContent.sys.mjs";
import { readMailSearchAttachmentInfo } from "resource:///modules/panorama/MailSearchAttachments.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AttachmentInfo: "resource:///modules/AttachmentInfo.sys.mjs",
});

/**
 * @typedef {object} MailSearchAttachmentRequest
 * @property {string} sourceId - Native incarnation from the result set.
 * @property {string} id - Selected physical global key.
 * @property {number} generation - Selected native generation.
 * @property {number} policyRevision - Selected eligibility revision.
 * @property {string} contentRevision - Selected source body/header revision.
 * @property {string} textRevision - Stored projection used by the selection.
 * @property {{folderId: number, messageKey: number}} location - Selected physical location.
 * @property {string} part - Observed MIME part path from attachmentInfos.
 */

/**
 * @typedef {object} MailSearchAttachmentResolution
 * @property {"ready"|"dispatched"|"deleted"|"ineligible"|"stale"|"unavailable"|"download-required"} status - Lookup or dispatch outcome.
 * @property {boolean} originalContentAvailable - Parent body was locally readable.
 * @property {?Error} contentError - Original per-message body error, if available.
 * @property {string} [url] - Fresh URL on ready/dispatched outcomes; not opening authority.
 * @property {string} [uri] - Current parent message URI on ready/dispatched outcomes.
 * @property {MailSearchAttachmentInfo} [info] - Fresh parser details.
 * @property {nsIMsgDBHdr} [header] - Current physical parent.
 * @property {{folderId: number, messageKey: number}} [location] - Current physical location.
 */

/**
 * Copies an exact attachment selection before asynchronous lookup. URLs and
 * caller-supplied attachment metadata are deliberately not accepted as authority.
 *
 * @param {string} sourceId - Service's native incarnation.
 * @param {MailSearchAttachmentRequest} request - Selected parent and part.
 * @returns {MailSearchAttachmentRequest} Independent selection.
 * @throws {TypeError} For foreign, incomplete or aliased physical selections.
 */
export function copyMailSearchAttachmentRequest(sourceId, request) {
  if (
    request?.sourceId !== sourceId ||
    typeof sourceId != "string" ||
    !sourceId
  ) {
    throw new TypeError("An attachment from this mail database is required");
  }
  const key = mailSearchKey(request.id);
  if (
    !Number.isSafeInteger(request.generation) ||
    request.generation < 1 ||
    !Number.isSafeInteger(request.policyRevision) ||
    request.policyRevision < 0 ||
    typeof request.contentRevision != "string" ||
    !request.contentRevision ||
    typeof request.textRevision != "string" ||
    !request.textRevision ||
    !Number.isSafeInteger(request.location?.folderId) ||
    request.location.folderId < 1 ||
    request.location.messageKey !== key ||
    typeof request.part != "string" ||
    !/^\d+(?:\.\d+)*$/.test(request.part)
  ) {
    throw new TypeError("An exact physical attachment selection is required");
  }
  const {
    id,
    generation,
    policyRevision,
    contentRevision,
    textRevision,
    part,
  } = request;
  return {
    sourceId,
    id,
    generation,
    policyRevision,
    contentRevision,
    textRevision,
    part,
    location: { folderId: request.location.folderId, messageKey: key },
  };
}

/**
 * Returns a non-ready status while retaining a per-message stream error.
 *
 * @param {string} status - Resolution outcome.
 * @param {?SearchDocumentState} state - Last native state, if available.
 * @returns {MailSearchAttachmentResolution} Status without a reusable URL or header.
 */
function outcome(status, state) {
  return {
    status,
    originalContentAvailable: state?.originalContentAvailable === true,
    contentError: state?.contentError ?? null,
  };
}

/**
 * Checks the selected native revisions, current folder/key, body and policy.
 * Core read/gate errors propagate unchanged.
 *
 * @param {MailSearchService} service - Current source resolver.
 * @param {MailSearchAttachmentRequest} request - Copied selection.
 * @param {AbortSignal} [signal] - Cancel before delivery.
 * @returns {MailSearchAttachmentResolution & {state?: SearchDocumentState}} Ready
 *   state/header, or a non-ready outcome.
 */
function inspect(service, request, signal) {
  signal?.throwIfAborted();
  const state = service.resolveDocument(request.id, signal);
  if (!state) {
    return outcome("deleted", state);
  }
  if (state.eligible !== true) {
    return outcome("ineligible", state);
  }
  if (
    state.generation !== request.generation ||
    state.policyRevision !== request.policyRevision ||
    state.contentRevision !== request.contentRevision ||
    state.location?.folderId !== request.location.folderId ||
    state.location.messageKey !== request.location.messageKey
  ) {
    return outcome("stale", state);
  }
  if (state.contentError || state.canOpen !== true) {
    return outcome("unavailable", state);
  }
  const header = getMailSearchHeader(state);
  if (!header) {
    return outcome("unavailable", state);
  }
  if (!getMailSearchPolicy(header).eligible) {
    return outcome("ineligible", state);
  }
  return { ...outcome("ready", state), state, header };
}

/**
 * Restricts no-download actions to local mailbox URLs and local file URLs.
 * A serialized IMAP/news URL cannot retain streamMessage's localOnly flag.
 *
 * @param {URL} url - Fresh attachment URL.
 * @param {nsIMsgFolder} folder - Current parent folder.
 * @returns {boolean} Whether the ordinary reader can avoid a remote fetch.
 */
function isLocalAction(url, folder) {
  return (
    (url.protocol == "mailbox:" &&
      folder instanceof Ci.nsIMsgLocalMailFolder) ||
    (url.protocol == "file:" && !url.hostname && !url.pathname.startsWith("//"))
  );
}

/**
 * Resolves a selected part by reparsing the current physical message. Retained
 * URLs are never used. No-download is the default for both MIME retrieval and
 * the returned action URL. Ready URLs are snapshots, not opening capabilities;
 * callers must use openAttachment to revalidate at action dispatch.
 *
 * @param {MailSearchService} service - Current native search service.
 * @param {string} sourceId - Service incarnation, not a profile path.
 * @param {MailSearchAttachmentRequest} request - Selected parent/part.
 * @param {object} [options] - Resolution controls.
 * @param {boolean} [options.allowDownload=false] - Permit remote retrieval/actions.
 * @param {AbortSignal} [options.signal] - Cancel MIME/result delivery.
 * @returns {Promise<MailSearchAttachmentResolution>} Fresh ready details or a non-ready status.
 * @throws {TypeError} For an invalid selection or non-boolean download permission.
 * @see MailSearchService.openAttachment
 */
export async function resolveMailSearchAttachment(
  service,
  sourceId,
  request,
  options
) {
  const resolved = await resolveAttachment(service, sourceId, request, options);
  delete resolved.attachment;
  return resolved;
}

/**
 * Resolves and checks a fresh reader instance without exposing it to callers.
 * The action keeps this instance so detached URL cleanup runs only once.
 *
 * @param {MailSearchService} service - Current source resolver.
 * @param {string} sourceId - Native database incarnation.
 * @param {MailSearchAttachmentRequest} request - Selected physical parent/part.
 * @param {object} [options] - MIME retrieval controls.
 * @param {boolean} [options.allowDownload=false] - Permit remote retrieval/actions.
 * @param {AbortSignal} [options.signal] - Cancel MIME/result delivery.
 * @returns {Promise<MailSearchAttachmentResolution & {attachment?: AttachmentInfo}>}
 *   Checked private instance on ready outcomes, otherwise only a status.
 */
async function resolveAttachment(
  service,
  sourceId,
  request,
  { allowDownload = false, signal } = {}
) {
  request = copyMailSearchAttachmentRequest(sourceId, request);
  if (typeof allowDownload != "boolean") {
    throw new TypeError("Download permission must be boolean");
  }
  let current = inspect(service, request, signal);
  if (current.status != "ready") {
    return current;
  }
  const text = await service.getText(request.id, { signal });
  current = inspect(service, request, signal);
  if (current.status != "ready") {
    return current;
  }
  if (
    !text ||
    text.textRevision !== request.textRevision ||
    text.contentRevision !== request.contentRevision
  ) {
    return outcome("stale", current.state);
  }
  if (
    text.attachmentInfos?.items.filter(item => item.part === request.part)
      .length !== 1
  ) {
    return outcome("unavailable", current.state);
  }
  if (!allowDownload && !current.state.originalContentAvailable) {
    return outcome("download-required", current.state);
  }
  const mime = await readMailSearchMime(current.header, {
    signal,
    allowDownload,
  });
  signal?.throwIfAborted();
  current = inspect(service, request, signal);
  if (current.status != "ready") {
    return current;
  }
  if (!mime) {
    return outcome("unavailable", current.state);
  }
  const latest = await service.getText(request.id, { signal });
  current = inspect(service, request, signal);
  if (current.status != "ready") {
    return current;
  }
  if (!latest || latest.textRevision !== request.textRevision) {
    return outcome("stale", current.state);
  }
  const parts = mime.allUserAttachments.filter(
    part => part.partName === request.part
  );
  if (parts.length != 1) {
    return outcome("unavailable", current.state);
  }
  const info = readMailSearchAttachmentInfo(parts[0]);
  const actionType =
    typeof parts[0].contentType == "string" ? parts[0].contentType : "";
  if (info.isExternal === null || actionType == "text/x-moz-deleted") {
    return outcome("unavailable", current.state);
  }
  const uri = current.header.folder.getUriForMsg(current.header);
  let url;
  if (info.isExternal) {
    if (!info.externalUrl) {
      return outcome("unavailable", current.state);
    }
    url = new URL(info.externalUrl);
  } else {
    url = new URL(
      MailServices.messageServiceFromURI(uri).getUrlForUri(uri).spec
    );
    url.searchParams.set("part", request.part);
    url.searchParams.delete("type");
    if (actionType && actionType != "message/rfc822") {
      url.searchParams.set("type", actionType);
    }
    if (info.name !== null) {
      url.searchParams.set("filename", info.name);
    }
  }
  if (!allowDownload && !isLocalAction(url, current.header.folder)) {
    return outcome("download-required", current.state);
  }
  const attachment = new lazy.AttachmentInfo({
    contentType: actionType,
    name: info.name ?? "",
    url: url.href,
    uri,
    message: current.header,
    isExternalAttachment: info.isExternal,
  });
  if (attachment.isDeleted || !attachment.isAllowedURL) {
    return outcome("unavailable", current.state);
  }
  signal?.throwIfAborted();
  const final = inspect(service, request, signal);
  if (final.status != "ready") {
    return final;
  }
  if (
    final.header.folder.getUriForMsg(final.header) !== uri ||
    (!allowDownload && !final.state.originalContentAvailable)
  ) {
    return outcome("stale", final.state);
  }
  return {
    ...outcome("ready", final.state),
    attachment,
    url: attachment.url,
    uri,
    info,
    header: final.header,
    location: { ...final.state.location },
  };
}

/**
 * Revalidates an attachment and delegates once to the existing reader action.
 * Cancellation prevents dispatch; it cannot revoke an action already handed to
 * AttachmentInfo.open. Native body admission remains authoritative at read time.
 *
 * @param {MailSearchService} service - Current search service.
 * @param {string} sourceId - Service incarnation.
 * @param {MailSearchAttachmentRequest} request - Selected physical parent/part.
 * @param {object} options - Action controls.
 * @param {BrowsingContext} options.browsingContext - Existing reader context.
 * @param {boolean} [options.allowDownload=false] - Permit remote fetches.
 * @param {AbortSignal} [options.signal] - Cancel before action dispatch.
 * @returns {Promise<MailSearchAttachmentResolution>} Dispatched or non-ready status.
 *   Dispatched means the reader accepted the call, not that a viewer opened.
 * @throws {TypeError} For an invalid selection, permission or missing context.
 */
export async function openMailSearchAttachment(
  service,
  sourceId,
  request,
  { browsingContext, allowDownload = false, signal } = {}
) {
  request = copyMailSearchAttachmentRequest(sourceId, request);
  if (!browsingContext) {
    throw new TypeError("An attachment browsing context is required");
  }
  const { attachment, ...resolved } = await resolveAttachment(
    service,
    sourceId,
    request,
    { allowDownload, signal }
  );
  if (resolved.status != "ready") {
    return resolved;
  }
  const text = await service.getText(request.id, { signal });
  const current = inspect(service, request, signal);
  if (current.status != "ready") {
    return current;
  }
  if (
    !text ||
    text.textRevision !== request.textRevision ||
    current.header.folder.getUriForMsg(current.header) !== resolved.uri ||
    (!allowDownload && !current.state.originalContentAvailable)
  ) {
    return outcome("stale", current.state);
  }
  attachment.message = current.header;
  signal?.throwIfAborted();
  await attachment.open(browsingContext);
  return { ...resolved, status: "dispatched" };
}
