/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const neutralMime = ChromeUtils.importESModule(
  "resource:///modules/panorama/MimeMessage.sys.mjs"
);
const legacyMime = ChromeUtils.importESModule(
  "resource:///modules/gloda/MimeMessage.sys.mjs"
);

add_task(function test_compatibleExports() {
  for (const name of [
    "MsgHdrToMimeMessage",
    "MimeBody",
    "MimeContainer",
    "MimeMessage",
    "MimeMessageAttachment",
    "MimeUnknown",
  ]) {
    Assert.equal(
      legacyMime[name],
      neutralMime[name],
      name + " shares one module"
    );
  }
});

add_task(function test_plaintextAndAttachments() {
  const message = new neutralMime.MimeMessage();
  const body = new neutralMime.MimeBody("text/plain");
  body.appendBody("First line");
  body.appendBody("\nSecond line");
  const attachment = new neutralMime.MimeMessageAttachment(
    "1.2",
    "report.pdf",
    "application/pdf",
    "mailbox://example",
    false
  );
  message.parts.push(body, attachment);
  Assert.equal(message.coerceBodyToPlaintext(null), "First line\nSecond line");
  Assert.deepEqual(
    message.allUserAttachments.map(part => part.name),
    ["report.pdf"]
  );
  Assert.equal(body.size, 22);
});

add_task(function test_mimePartURLs() {
  for (const [url, expected] of [
    ["mailbox:///Inbox?number=1&part=1.2&type=application/pdf", "1.2"],
    ["imap://server/fetch?/;section=1?part=2", "2"],
    ["mailbox:///Inbox?number=1", null],
  ]) {
    Assert.equal(
      neutralMime.MIME_PART_RE.exec(url)?.[1] ?? null,
      expected,
      url
    );
  }
});
