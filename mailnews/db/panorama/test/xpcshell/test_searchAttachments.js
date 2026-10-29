/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { readMailSearchAttachmentInfo, copyMailSearchAttachmentInfos } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearchAttachments.sys.mjs"
  );
const { getMailSearchAttachmentInfos } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchContent.sys.mjs"
);
const { MimeMessage, MimeContainer, MimeMessageAttachment } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MimeMessage.sys.mjs"
  );

add_task(function test_observedAttachmentFieldsDoNotInventInternalUrls() {
  const part = new MimeMessageAttachment(
    "1.2",
    "",
    "IMAGE/PNG; name=ignored.pdf",
    "mailbox:///old?number=12&part=1.2",
    false
  );
  part.headers["content-type"] = ["image/png; name=ignored.pdf"];
  part.contentType = "application/pdf";
  part.size = 0;
  Assert.deepEqual(readMailSearchAttachmentInfo(part), {
    name: "",
    contentType: "image/png",
    size: 0,
    part: "1.2",
    isExternal: false,
    externalUrl: null,
  });
  part.isExternal = true;
  part.url = "file:///detached/report.png";
  part.size = 17;
  Assert.deepEqual(readMailSearchAttachmentInfo(part), {
    name: "",
    contentType: "image/png",
    size: 17,
    part: "1.2",
    isExternal: true,
    externalUrl: "file:///detached/report.png",
  });
  const unknown = new MimeMessageAttachment(
    undefined,
    undefined,
    "bogus",
    undefined,
    undefined
  );
  unknown.contentType = "application/pdf";
  unknown.size = -1;
  Assert.deepEqual(readMailSearchAttachmentInfo(unknown), {
    name: null,
    contentType: null,
    size: null,
    part: null,
    isExternal: null,
    externalUrl: null,
  });
  unknown.size = NaN;
  Assert.equal(readMailSearchAttachmentInfo(unknown).size, null);
});

add_task(
  function test_userAttachmentsIncludeForwardedMessagesWithoutInventedSize() {
    const mime = new MimeMessage();
    Assert.deepEqual(getMailSearchAttachmentInfos(mime), {
      items: [],
      complete: true,
    });
    const forwarded = new MimeMessage();
    forwarded.partName = "1.3";
    forwarded.headers["content-type"] = ["multipart/mixed; boundary=inner"];
    forwarded.name = "forwarded.eml";
    forwarded.url = "mailbox:///old?number=12&part=1.3";
    forwarded.isExternal = false;
    const nested = new MimeMessageAttachment(
      "1.3.1.2",
      "inside.png",
      "image/png",
      "",
      false
    );
    nested.size = 23;
    forwarded.parts.push(nested);
    mime.parts.push(forwarded);
    Assert.equal(forwarded.size, 23, "The MIME model has an aggregate getter");
    Assert.deepEqual(
      getMailSearchAttachmentInfos(mime),
      {
        complete: true,
        items: [
          {
            name: "forwarded.eml",
            contentType: "message/rfc822",
            size: null,
            part: "1.3",
            isExternal: false,
            externalUrl: null,
          },
        ],
      },
      "The aggregate is not an explicit observed attachment byte count"
    );
    const hidden = new MimeContainer("multipart/encrypted");
    hidden.isEncrypted = true;
    mime.parts.push(hidden);
    const observed = getMailSearchAttachmentInfos(mime);
    Assert.equal(observed.items.length, 1);
    Assert.equal(observed.complete, false);
    mime.parts = [hidden];
    Assert.deepEqual(getMailSearchAttachmentInfos(mime), {
      items: [],
      complete: false,
    });
  }
);

add_task(function test_attachmentDetailCopiesRejectMalformedStoredFields() {
  const input = {
    complete: false,
    items: [
      {
        name: "report.pdf",
        contentType: "application/pdf",
        size: 7,
        part: "1.2",
        isExternal: false,
        externalUrl: null,
      },
    ],
  };
  const copied = copyMailSearchAttachmentInfos(input);
  input.items[0].name = "changed";
  Assert.equal(copied.items[0].name, "report.pdf");
  Assert.equal(copyMailSearchAttachmentInfos(null), null);
  for (const field of [
    { size: -1 },
    { size: NaN },
    { part: "1.2&number=99" },
    { externalUrl: "mailbox:///old" },
    { contentType: "bogus" },
  ]) {
    Assert.throws(
      () =>
        copyMailSearchAttachmentInfos({
          ...copied,
          items: [{ ...copied.items[0], ...field }],
        }),
      /attachment detail/
    );
  }
  Assert.throws(
    () =>
      copyMailSearchAttachmentInfos({ items: ["not-a-part"], complete: true }),
    /attachment detail/
  );
});
