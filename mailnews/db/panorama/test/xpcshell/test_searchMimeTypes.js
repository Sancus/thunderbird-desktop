/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {
  getMailSearchMimeCategory,
  getMailSearchPartType,
  normalizeMailSearchMimeType,
  copyMailSearchMimeEvidence,
} = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchMimeTypes.sys.mjs"
);
const { getMailSearchAttachmentEvidence, getMailSearchAttachmentPresence } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearchContent.sys.mjs"
  );
const { MimeMessage, MimeContainer, MimeMessageAttachment } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MimeMessage.sys.mjs"
  );

add_task(function test_retainedMimeCategoryPrecedence() {
  for (const [type, category] of [
    ["application/pdf", "pdf"],
    ["image/pdf", "pdf"],
    ["image/x-cdr", "documents"],
    ["image/png", "images"],
    ["application/zip", "archives"],
    ["application/vnd.ms-excel", "documents"],
    ["audio/ogg", "media"],
    ["application/x-matroska", "media"],
    ["application/octet-stream", "other"],
    ["text/plain", "other"],
  ]) {
    Assert.equal(getMailSearchMimeCategory(type), category, type);
  }
  Assert.equal(
    normalizeMailSearchMimeType(' Application/PDF; name="report.txt"'),
    "application/pdf"
  );
  Assert.equal(normalizeMailSearchMimeType("report.pdf"), null);
  Assert.equal(getMailSearchMimeCategory("report.pdf"), null);
  const input = {
    types: ["APPLICATION/PDF", "application/pdf"],
    complete: false,
  };
  Assert.deepEqual(copyMailSearchMimeEvidence(input), {
    types: ["application/pdf"],
    complete: false,
  });
  Assert.deepEqual(input.types, ["APPLICATION/PDF", "application/pdf"]);
  Assert.equal(copyMailSearchMimeEvidence(null), null);
  Assert.throws(
    () => copyMailSearchMimeEvidence({ types: ["report.pdf"], complete: true }),
    /MIME evidence/
  );
});

add_task(function test_hiddenEncryptedTypesKeepIncompleteEvidence() {
  const mime = new MimeMessage();
  Assert.deepEqual(getMailSearchAttachmentEvidence(mime), {
    types: [],
    complete: true,
  });
  mime.parts.push(
    new MimeMessageAttachment("1.1", "not-an-image.pdf", "image/png", "", false)
  );
  mime.parts.push(
    new MimeMessageAttachment("1.2", "duplicate.zip", "image/png", "", false)
  );
  for (const part of mime.parts) {
    part.headers["content-type"] = ["image/png"];
    part.contentType = "application/pdf";
  }
  Assert.deepEqual(getMailSearchAttachmentEvidence(mime), {
    types: ["image/png"],
    complete: true,
  });
  const hidden = new MimeContainer("multipart/encrypted");
  hidden.isEncrypted = true;
  mime.parts.push(hidden);
  Assert.deepEqual(getMailSearchAttachmentEvidence(mime), {
    types: ["image/png"],
    complete: false,
  });
  mime.parts = [hidden];
  Assert.deepEqual(getMailSearchAttachmentEvidence(mime), {
    types: [],
    complete: false,
  });
  const missingType = new MimeMessageAttachment(
    "1.3",
    "report.pdf",
    "unknown",
    "",
    false
  );
  mime.parts = [missingType];
  Assert.deepEqual(getMailSearchAttachmentEvidence(mime), {
    types: [],
    complete: false,
  });
});

add_task(async function test_invalidStoredMimeEvidenceIsNotUnknown() {
  const { PanoramaSearchIndex } = ChromeUtils.importESModule(
    "resource:///modules/panorama/PanoramaSearchIndex.sys.mjs"
  );
  const file = do_get_profile().clone();
  file.append("corrupt-mime-evidence.sqlite");
  const state = {
    eligible: true,
    generation: 1,
    policyRevision: 0,
    contentRevision: "source-1",
  };
  const open = () => PanoramaSearchIndex.open(file, () => state);
  let index = await open();
  registerCleanupFunction(() => index.close());
  const document = {
    id: "corrupt",
    generation: 1,
    policyRevision: 0,
    contentRevision: "source-1",
    subject: "",
    body: "body",
    attachmentNames: "",
    author: "",
    recipients: "",
    attachmentTypes: { types: ["application/pdf"], complete: false },
  };
  await index.index(document);
  await index.index({ ...document, id: "control" });
  await index.close();
  const db = Services.storage.openUnsharedDatabase(file);
  try {
    db.executeSimpleSQL(
      "UPDATE documents SET attachmentTypes='not-json' WHERE documentId='corrupt'"
    );
  } finally {
    db.close();
  }
  index = await open();
  await Assert.rejects(index.getText("corrupt"), /JSON|Unexpected/);
  Assert.deepEqual((await index.getText("control")).attachmentTypes, {
    types: ["application/pdf"],
    complete: false,
  });
});

add_task(function test_unusableAttachmentTypeDoesNotProveAbsence() {
  const mime = new MimeMessage();
  Assert.equal(getMailSearchAttachmentPresence(mime), false);
  mime.parts.push(
    new MimeMessageAttachment("1.1", "report.pdf", "bogus", "", false)
  );
  Assert.equal(
    getMailSearchAttachmentPresence(mime),
    null,
    "A part without a MIME type is not proven absent"
  );
  mime.parts[0].contentType = undefined;
  Assert.equal(
    getMailSearchAttachmentPresence(mime),
    null,
    "A missing type remains unknown"
  );
  mime.parts[0].contentType = "/";
  Assert.equal(
    getMailSearchAttachmentPresence(mime),
    null,
    "A slash alone is not a usable type"
  );
  mime.parts[0].contentType = "application/octet-stream";
  Assert.equal(getMailSearchAttachmentPresence(mime), true);
  const hidden = new MimeContainer("multipart/encrypted");
  hidden.isEncrypted = true;
  mime.parts = [hidden];
  Assert.equal(getMailSearchAttachmentPresence(mime), null);
});

add_task(function test_declaredTypesExcludeFilenameGuessesAndMalformedTokens() {
  const mime = new MimeMessage();
  const part = new MimeMessageAttachment(
    "1.2",
    "invoice.pdf",
    "application/pdf",
    "",
    false
  );
  mime.parts.push(part);
  Assert.deepEqual(
    getMailSearchAttachmentEvidence(mime),
    { types: [], complete: false },
    "A guessed type without a declared header is unknown"
  );
  part.headers["content-type"] = ["application/octet-stream; name=invoice.pdf"];
  Assert.deepEqual(getMailSearchAttachmentEvidence(mime), {
    types: ["application/octet-stream"],
    complete: true,
  });
  Assert.equal(
    getMailSearchMimeCategory(getMailSearchAttachmentEvidence(mime).types[0]),
    "other"
  );
  Assert.equal(
    getMailSearchAttachmentPresence(mime),
    true,
    "Presence remains separate from declared type evidence"
  );
  for (const raw of [
    "=?windows-1252?q?application/pdf",
    "application/p(d)f",
    "application/p[d]f",
    "application/é",
    "application/p\\df",
    "application/p:df",
  ]) {
    Assert.equal(normalizeMailSearchMimeType(raw), null, raw);
  }
  Assert.equal(
    normalizeMailSearchMimeType("application/vnd.test+json"),
    "application/vnd.test+json"
  );
  Assert.equal(
    normalizeMailSearchMimeType("application/x{a}|~"),
    "application/x{a}|~"
  );
});

add_task(function test_forwardedTypeExcludesEnclosedBodyHeaders() {
  const forwarded = new MimeMessage();
  forwarded.headers["content-type"] = ["multipart/mixed; boundary=inner"];
  Assert.equal(Object.hasOwn(forwarded, "contentType"), false);
  Assert.equal(getMailSearchPartType(forwarded), "message/rfc822");
  const otherModel = Object.assign(
    Object.create({ contentType: "message/rfc822" }),
    forwarded
  );
  Assert.equal(otherModel instanceof MimeMessage, false);
  Assert.equal(
    getMailSearchPartType(otherModel),
    "message/rfc822",
    "The emitter model does not need to share the caller's prototype"
  );
  delete forwarded.headers["content-type"];
  Assert.equal(getMailSearchPartType(forwarded), "message/rfc822");
});
