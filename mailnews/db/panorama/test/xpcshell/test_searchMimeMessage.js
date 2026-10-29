/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { mimeMsgToContentSnippetAndMeta } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MessageContent.sys.mjs"
);
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

add_task(function test_neutralSummarySnippetAndMetadata() {
  const message = new neutralMime.MimeMessage();
  message.headers.subject = ["Summary subject"];
  message.headers.from = ["Header Author <author@example.invalid>"];
  const body = new neutralMime.MimeBody("text/plain");
  const original = [
    "First authored line.",
    "",
    "Someone wrote:",
    "> quoted line",
    ">> nested reply",
    "",
    "Second authored line.",
    "",
  ].join("\r\n");
  body.appendBody(original);
  message.parts.push(body);
  const expected = "First authored line.\nSecond authored line.";
  Assert.deepEqual(mimeMsgToContentSnippetAndMeta(message, null, 300), [
    expected,
    { subject: "Summary subject" },
  ]);
  Assert.equal(
    mimeMsgToContentSnippetAndMeta(message, null)[0],
    expected,
    "Omitting the length keeps all authored content"
  );
  Assert.equal(mimeMsgToContentSnippetAndMeta(message, null, 4)[0], "Fir…");
  Assert.equal(mimeMsgToContentSnippetAndMeta(message, null, 1)[0], "…");
  Assert.equal(body.body, original, "Snippet extraction does not mutate MIME");
  const unicode = new neutralMime.MimeMessage();
  const unicodeBody = new neutralMime.MimeBody("text/plain");
  unicodeBody.appendBody("é 😀 tail");
  unicode.parts.push(unicodeBody);
  Assert.equal(mimeMsgToContentSnippetAndMeta(unicode, null, 4)[0], "é …");
  Assert.equal(mimeMsgToContentSnippetAndMeta(unicode, null, 5)[0], "é 😀…");
  const empty = new neutralMime.MimeMessage();
  const quoted = new neutralMime.MimeBody("text/plain");
  quoted.appendBody("> Only quoted text\r\n");
  empty.parts.push(quoted);
  Assert.deepEqual(mimeMsgToContentSnippetAndMeta(empty, null, 300), [
    "",
    { subject: null },
  ]);
});

add_task(function test_neutralSummaryConvertsHtmlThroughTheFolder() {
  const message = new neutralMime.MimeMessage();
  message.headers.subject = ["HTML subject"];
  const body = new neutralMime.MimeBody("text/html");
  body.appendBody("<b>Authored</b> &amp; final");
  message.parts.push(body);
  const folder = Cc[
    "@mozilla.org/mail/folder-factory;1?name=mailbox"
  ].createInstance(Ci.nsIMsgFolder);
  Assert.deepEqual(mimeMsgToContentSnippetAndMeta(message, folder, 300), [
    "Authored & final",
    { subject: "HTML subject" },
  ]);
  const failure = new Error("Original MIME conversion failure");
  message.coerceBodyToPlaintext = () => {
    throw failure;
  };
  Assert.throws(
    () => mimeMsgToContentSnippetAndMeta(message, folder, 300),
    error => error === failure
  );
});
