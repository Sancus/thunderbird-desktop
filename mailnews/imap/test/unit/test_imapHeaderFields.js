/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const messageText =
  "Subject: Filtered headers\r\n" +
  "Content-Type: text/plain; charset=us-ascii\r\n" +
  "X-Repeat: first\r\n" +
  "X-Repeat: second\r\n" +
  "\r\n" +
  "First physical preview.\r\n";

add_task(function test_headerFieldsLiteral() {
  const message = new ImapMessage(
    "data:text/plain;base64," + btoa(messageText),
    1,
    []
  );
  const handler = new IMAP_RFC3501_handler(new ImapDaemon());
  const cases = [
    ["CONTENT-TYPE", "content-type: text/plain; charset=us-ascii\r\n\r\n"],
    [
      "SUBJECT CONTENT-TYPE",
      "subject: Filtered headers\r\n" +
        "content-type: text/plain; charset=us-ascii\r\n\r\n",
    ],
    ["X-Repeat", "x-repeat: first\r\nx-repeat: second\r\n\r\n"],
    ["MISSING", "\r\n"],
  ];
  for (const [fields, expected] of cases) {
    const section = `HEADER.FIELDS (${fields})`;
    Assert.equal(
      handler._FETCH_BODY(message, `BODY.PEEK[${section}]`),
      `BODY[${section}] {${expected.length}}\r\n${expected}`,
      `Exact filtered header literal for ${fields}`
    );
  }
  Assert.deepEqual(message.flags, [], "PEEK does not mark the message read");
});

add_task(function test_headerFieldsNotLiteral() {
  const message = new ImapMessage(
    "data:text/plain;base64," + btoa(messageText),
    2,
    []
  );
  const handler = new IMAP_RFC3501_handler(new ImapDaemon());
  const cases = [
    [
      "sUbJeCt",
      "content-type: text/plain; charset=us-ascii\r\n" +
        "x-repeat: first\r\nx-repeat: second\r\n\r\n",
    ],
    ["SUBJECT CONTENT-TYPE X-REPEAT", "\r\n"],
    [
      "MISSING",
      "subject: Filtered headers\r\n" +
        "content-type: text/plain; charset=us-ascii\r\n" +
        "x-repeat: first\r\nx-repeat: second\r\n\r\n",
    ],
  ];
  for (const [fields, expected] of cases) {
    const section = `HEADER.FIELDS.NOT (${fields})`;
    Assert.equal(
      handler._FETCH_BODY(message, `BODY.PEEK[${section}]`),
      `BODY[${section}] {${expected.length}}\r\n${expected}`,
      `Exact excluded header literal for ${fields}`
    );
  }
  Assert.deepEqual(message.flags, [], "PEEK does not mark the message read");
});

add_task(function test_numericPartKeepsNestedHeaderSelection() {
  const raw = [
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="nested-message"',
    "",
    "--nested-message",
    "Content-Type: message/rfc822",
    "",
    "Subject: Nested message",
    "X-Trace2: nested header",
    "",
    "Nested body.",
    "--nested-message--",
    "",
  ].join("\r\n");
  const message = new ImapMessage("data:text/plain;base64," + btoa(raw), 3, []);
  const handler = new IMAP_RFC3501_handler(new ImapDaemon());
  const expected = "x-trace2: nested header\r\n\r\n";
  for (const section of [
    "1.HEADER.FIELDS (X-TRACE2)",
    "1.HEADER.FIELDS.NOT (SUBJECT)",
  ]) {
    Assert.equal(
      handler._FETCH_BODY(message, `BODY.PEEK[${section}]`),
      `BODY[${section}] {${expected.length}}\r\n${expected}`,
      "A leading MIME part number still selects the nested message headers"
    );
  }
});

add_task(function test_headerFieldNamesWithDigits() {
  const raw =
    "Subject: Numeric field\r\nX-Trace2: second header\r\n\r\nBody.\r\n";
  const message = new ImapMessage("data:text/plain;base64," + btoa(raw), 4, []);
  const handler = new IMAP_RFC3501_handler(new ImapDaemon());
  for (const [section, expected] of [
    ["HEADER.FIELDS (X-TRACE2)", "x-trace2: second header\r\n\r\n"],
    ["HEADER.FIELDS.NOT (X-TRACE2)", "subject: Numeric field\r\n\r\n"],
  ]) {
    Assert.equal(
      handler._FETCH_BODY(message, `BODY.PEEK[${section}]`),
      `BODY[${section}] {${expected.length}}\r\n${expected}`,
      "A digit in the field name is not a MIME part number"
    );
  }
  Assert.deepEqual(message.flags, [], "PEEK does not mark the message read");
});
