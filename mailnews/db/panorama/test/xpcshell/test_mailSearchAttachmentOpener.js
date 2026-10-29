/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { MailSearchService } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchService.sys.mjs"
);
const { resolveMailSearchAttachment, openMailSearchAttachment } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearchAttachmentOpener.sys.mjs"
  );
const { readMailSearchMime } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchContent.sys.mjs"
);
const { AttachmentInfo } = ChromeUtils.importESModule(
  "resource:///modules/AttachmentInfo.sys.mjs"
);

let attachmentService, attachmentRoot;

add_setup(async function setupAttachmentActions() {
  do_get_profile();
  loadExistingDB();
  const pref = "mailnews.database.global.indexer.enabled";
  const hadPref = Services.prefs.prefHasUserValue(pref);
  const oldPref = Services.prefs.getBoolPref(pref, false);
  Services.prefs.setBoolPref(pref, true);
  registerCleanupFunction(() => {
    if (hadPref) {
      Services.prefs.setBoolPref(pref, oldPref);
    } else {
      Services.prefs.clearUserPref(pref);
    }
  });
  attachmentRoot = MailServices.accounts
    .createLocalMailAccount()
    .incomingServer.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  const file = do_get_profile().clone();
  file.append("attachment-actions.sqlite");
  attachmentService = await MailSearchService.open(
    file,
    database.sourceId,
    messageDB
  );
  registerCleanupFunction(() => attachmentService.close());
});

/**
 * Indexes two independently stored copies with a literal MIME part. Neither
 * Message-ID nor a retained attachment URL identifies the selected copy.
 *
 * @param {string} name - Unique query and folder prefix.
 * @param {boolean} [external=false] - Include a detached HTTP URL in the MIME.
 * @param {?string[]} [partLines=null] - Complete alternative attachment headers/body.
 * @returns {Promise<object>} Headers and a copied result selection.
 */
async function attachmentCopies(name, external = false, partLines = null) {
  const raw = [
    "From: sender@example.invalid",
    "Message-ID: <shared-attachment-action@example.invalid>",
    "Subject: " + name,
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=actions",
    "",
    "--actions",
    "Content-Type: text/plain",
    "",
    "action body",
    "--actions",
    ...(partLines ?? [
      "Content-Type: application/octet-stream",
      "Content-Disposition: attachment; filename=report.txt",
      ...(external
        ? [
            "X-Mozilla-External-Attachment-URL: https://example.invalid/report.txt",
          ]
        : []),
      "Content-Transfer-Encoding: base64",
      "",
      "YWJj",
    ]),
    "--actions--",
    "",
  ].join("\r\n");
  const first = attachmentRoot
    .createLocalSubfolder(name + "-first")
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .addMessage(raw);
  const selected = attachmentRoot
    .createLocalSubfolder(name + "-selected")
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .addMessage(raw);
  for (let i = 0; ; i++) {
    Assert.less(i, 100, "Small fixture finishes bounded indexing");
    if (!(await attachmentService.update({ limit: 50 })).moreWork) {
      break;
    }
  }
  const results = await attachmentService.collectResults(name);
  Assert.deepEqual(
    results.items.map(item => item.id).sort(),
    [String(first.messageKey), String(selected.messageKey)].sort()
  );
  const result = results.items.find(
    item => item.id == String(selected.messageKey)
  );
  Assert.equal(result.attachmentInfos.items[0].part, "1.2");
  return {
    first,
    selected,
    request: { ...result, sourceId: results.sourceId, part: "1.2" },
  };
}

add_task(async function test_currentPhysicalAttachmentAndReaderDispatch() {
  const { first, selected, request } = await attachmentCopies(
    "physicalattachmentaction"
  );
  Assert.equal(first.messageId, selected.messageId);
  const caller = {
    ...request,
    location: { ...request.location },
    url: "https://stale.invalid/never-open",
    externalUrl: "file:///stale.txt",
  };
  const resolving = attachmentService.resolveAttachment(caller);
  caller.part = "9.9";
  caller.location.folderId = first.folder.id;
  const resolved = await resolving;
  Assert.equal(resolved.status, "ready");
  Assert.equal(resolved.header.messageKey, selected.messageKey);
  Assert.deepEqual(resolved.location, request.location);
  Assert.equal(resolved.uri, selected.folder.getUriForMsg(selected));
  Assert.notEqual(resolved.uri, first.folder.getUriForMsg(first));
  const url = new URL(resolved.url);
  const base = new URL(
    MailServices.messageServiceFromURI(resolved.uri).getUrlForUri(resolved.uri)
      .spec
  );
  Assert.equal(url.pathname, base.pathname);
  Assert.equal(url.searchParams.get("part"), "1.2");
  Assert.equal(resolved.info.contentType, "application/octet-stream");
  Assert.equal(url.searchParams.get("filename"), "report.txt");
  Assert.equal(resolved.info.externalUrl, null);

  const open = AttachmentInfo.prototype.open;
  const context = {};
  const calls = [];
  AttachmentInfo.prototype.open = async function (browsingContext) {
    calls.push([this, browsingContext]);
  };
  try {
    const dispatched = await attachmentService.openAttachment(request, {
      browsingContext: context,
    });
    Assert.equal(dispatched.status, "dispatched");
    Assert.equal(calls.length, 1);
    Assert.equal(calls[0][0].message.messageKey, selected.messageKey);
    Assert.equal(calls[0][0].url, resolved.url);
    Assert.equal(url.searchParams.get("type"), calls[0][0].contentType);
    Assert.equal(
      calls[0][0].contentType,
      "text/plain",
      "The reader receives the effective .txt type, while evidence stays octet-stream"
    );
    Assert.equal(calls[0][1], context);
    calls.length = 0;
    const readerError = new Error("Attachment reader failed");
    AttachmentInfo.prototype.open = async function () {
      calls.push(this);
      throw readerError;
    };
    await Assert.rejects(
      attachmentService.openAttachment(request, { browsingContext: context }),
      error => error === readerError
    );
    Assert.equal(calls.length, 1, "A failed reader action is not retried");
  } finally {
    AttachmentInfo.prototype.open = open;
  }
});

add_task(async function test_staleSelectionAndDeletedCopy() {
  const { first, selected, request } = await attachmentCopies(
    "staleattachmentaction"
  );
  Assert.throws(
    () =>
      attachmentService.resolveAttachment({
        ...request,
        sourceId: "foreign-core",
      }),
    error =>
      error.name == "TypeError" &&
      error.message == "An attachment from this mail database is required"
  );
  Assert.throws(
    () =>
      attachmentService.resolveAttachment({ ...request, id: "0" + request.id }),
    error =>
      error.name == "TypeError" &&
      error.message == "Invalid physical mail identity"
  );
  Assert.equal(
    (
      await attachmentService.resolveAttachment({
        ...request,
        generation: request.generation + 1,
      })
    ).status,
    "stale"
  );
  Assert.equal(
    (
      await attachmentService.resolveAttachment({
        ...request,
        textRevision: "old-text",
      })
    ).status,
    "stale"
  );
  Assert.equal(
    (
      await attachmentService.resolveAttachment({
        ...request,
        location: {
          folderId: first.folder.id,
          messageKey: selected.messageKey,
        },
      })
    ).status,
    "stale"
  );
  Assert.equal(
    (await attachmentService.resolveAttachment({ ...request, part: "1.99" }))
      .status,
    "unavailable"
  );

  const changing = {
    resolveDocument: (...args) => attachmentService.resolveDocument(...args),
    async getText(...args) {
      const text = await attachmentService.getText(...args);
      selected.subject = "changedattachmentparent";
      return text;
    },
  };
  Assert.equal(
    (await resolveMailSearchAttachment(changing, database.sourceId, request))
      .status,
    "stale",
    "A change during projection retrieval cannot open the old selection"
  );
  messageDB.removeMessage(selected.messageKey);
  Assert.equal(
    (await attachmentService.resolveAttachment(request)).status,
    "deleted"
  );
  const other = await attachmentService.collectResults("staleattachmentaction");
  Assert.deepEqual(
    other.items.map(item => item.id),
    [String(first.messageKey)]
  );
  Assert.equal(
    (
      await attachmentService.resolveAttachment({
        ...other.items[0],
        sourceId: other.sourceId,
        part: "1.2",
      })
    ).status,
    "ready"
  );
});

add_task(async function test_policyErrorsDownloadPermissionAndCancellation() {
  const { selected, request } = await attachmentCopies(
    "guardedattachmentaction"
  );
  let projectedState = {};
  const controlled = {
    resolveDocument: (...args) => ({
      ...attachmentService.resolveDocument(...args),
      ...projectedState,
    }),
    getText: (...args) => attachmentService.getText(...args),
  };
  projectedState = { originalContentAvailable: false, canOpen: true };
  Assert.equal(
    (await resolveMailSearchAttachment(controlled, database.sourceId, request))
      .status,
    "download-required"
  );
  const bodyError = new Error("Unreadable selected body");
  projectedState = { contentError: bodyError };
  const unavailable = await resolveMailSearchAttachment(
    controlled,
    database.sourceId,
    request
  );
  Assert.equal(unavailable.status, "unavailable");
  Assert.equal(unavailable.contentError, bodyError);
  const gateError = Components.Exception(
    "Native body relocation pending",
    Cr.NS_ERROR_IN_PROGRESS
  );
  controlled.resolveDocument = () => {
    throw gateError;
  };
  await Assert.rejects(
    resolveMailSearchAttachment(controlled, database.sourceId, request),
    error => error === gateError
  );

  const controller = new AbortController();
  const reason = new Error("Cancel attachment retrieval");
  const cancelling = {
    resolveDocument: (...args) => attachmentService.resolveDocument(...args),
    async getText(...args) {
      const text = await attachmentService.getText(...args);
      controller.abort(reason);
      return text;
    },
  };
  const open = AttachmentInfo.prototype.open;
  let calls = 0;
  AttachmentInfo.prototype.open = async () => calls++;
  try {
    await Assert.rejects(
      openMailSearchAttachment(cancelling, database.sourceId, request, {
        browsingContext: {},
        signal: controller.signal,
      }),
      error => error === reason
    );
    Assert.equal(calls, 0, "Cancellation prevents reader dispatch");
  } finally {
    AttachmentInfo.prototype.open = open;
  }
  selected.setStringProperty(
    "junkscore",
    Ci.nsIJunkMailPlugin.IS_SPAM_SCORE.toString()
  );
  Assert.equal(
    (await attachmentService.resolveAttachment(request)).status,
    "ineligible"
  );
});

add_task(async function test_detachedRemoteActionRequiresExplicitPermission() {
  const { request } = await attachmentCopies("remoteattachmentaction", true);
  Assert.equal(request.attachmentInfos.items[0].isExternal, true);
  Assert.equal(
    (await attachmentService.resolveAttachment(request)).status,
    "download-required"
  );
  Assert.equal(
    (
      await attachmentService.resolveAttachment(request, {
        allowDownload: true,
      })
    ).status,
    "unavailable",
    "The ordinary mail reader rejects an HTTP detached URL even with download permission"
  );
});

add_task(async function test_forwardedMessageUsesReaderTypeAndRawPartUrl() {
  const { selected, request } = await attachmentCopies(
    "forwardedattachmentaction",
    false,
    [
      "Content-Type: message/rfc822",
      "Content-Disposition: attachment; filename=forwarded.eml",
      "Content-Transfer-Encoding: 7bit",
      "",
      "From: enclosed@example.invalid",
      "To: recipient@example.invalid",
      "Message-ID: <enclosed-action@example.invalid>",
      "Subject: Enclosed multipart message",
      "MIME-Version: 1.0",
      "Content-Type: multipart/mixed; boundary=enclosed",
      "",
      "--enclosed",
      "Content-Type: text/plain",
      "",
      "forwarded body",
      "--enclosed--",
      "",
    ]
  );
  const mime = await readMailSearchMime(selected);
  const [part] = mime.allUserAttachments;
  Assert.equal(part.partName, "1.2");
  Assert.equal(Object.hasOwn(part, "contentType"), false);
  Assert.equal(
    part.get("content-type"),
    "multipart/mixed; boundary=enclosed",
    "The actual parser exposes enclosed headers, not the attachment header"
  );
  Assert.equal(request.attachmentInfos.items.length, 1);
  Assert.equal(request.attachmentInfos.items[0].contentType, "message/rfc822");
  const resolved = await attachmentService.resolveAttachment(request);
  Assert.equal(resolved.status, "ready");
  Assert.equal(resolved.info.contentType, "message/rfc822");
  Assert.equal(
    new URL(resolved.url).searchParams.has("type"),
    false,
    "type=message/rfc822 would request rendered HTML instead of the attached message"
  );
  Assert.equal(Object.hasOwn(resolved, "attachment"), false);

  const open = AttachmentInfo.prototype.open;
  const calls = [];
  AttachmentInfo.prototype.open = async function () {
    calls.push(this);
  };
  try {
    const dispatched = await attachmentService.openAttachment(request, {
      browsingContext: {},
    });
    Assert.equal(dispatched.status, "dispatched");
    Assert.equal(Object.hasOwn(dispatched, "attachment"), false);
    Assert.equal(calls.length, 1);
    Assert.equal(calls[0].contentType, "message/rfc822");
    Assert.equal(new URL(calls[0].url).searchParams.has("type"), false);
    Assert.equal(calls[0].partID, "1.2");
    Assert.equal(calls[0].message.messageKey, selected.messageKey);
  } finally {
    AttachmentInfo.prototype.open = open;
  }
});

add_task(async function test_detachedLiteralNullPathIsCleanedOnlyOnce() {
  const file = do_get_profile().clone();
  file.append("search-annulled.pdf");
  await IOUtils.writeUTF8(file.path, "%PDF-1.0\nattachment action fixture\n");
  registerCleanupFunction(() => IOUtils.remove(file.path));
  const fileUrl = Services.io.newFileURI(file).spec;
  Assert.ok(
    fileUrl.includes("null"),
    "The fixture exercises literal null URL text"
  );
  const { selected, request } = await attachmentCopies(
    "detachednullattachmentaction",
    false,
    [
      "Content-Type: application/pdf",
      "Content-Disposition: attachment; filename=search-annulled.pdf",
      "X-Mozilla-External-Attachment-URL: " + fileUrl,
      "Content-Transfer-Encoding: base64",
      "",
      "YWJj",
    ]
  );
  const resolved = await attachmentService.resolveAttachment(request);
  Assert.equal(resolved.status, "ready");
  Assert.equal(resolved.info.isExternal, true);
  Assert.equal(
    new URL(resolved.info.externalUrl).searchParams.get("part"),
    "1.2"
  );
  Assert.equal(resolved.url, fileUrl);
  const open = AttachmentInfo.prototype.open;
  const calls = [];
  AttachmentInfo.prototype.open = async function () {
    calls.push(this);
  };
  try {
    const dispatched = await attachmentService.openAttachment(request, {
      browsingContext: {},
    });
    Assert.equal(dispatched.status, "dispatched");
    Assert.equal(calls.length, 1);
    Assert.equal(
      calls[0].url,
      fileUrl,
      "The checked detached target is not reconstructed from an already cleaned URL"
    );
    Assert.equal(
      calls[0].partID,
      "1.2",
      "Reader part identity survives dispatch"
    );
    Assert.equal(calls[0].message.messageKey, selected.messageKey);
    Assert.equal(calls[0].contentType, "application/pdf");
  } finally {
    AttachmentInfo.prototype.open = open;
  }
});
