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
