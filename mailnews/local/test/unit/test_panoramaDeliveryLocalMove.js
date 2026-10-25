/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from ../../../db/panorama/test/xpcshell/head.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

/**
 * @typedef {object} ExpectedMessage
 * @property {string} subject - The literal subject.
 * @property {string} body - The complete body bytes.
 * @property {number} flags - The expected persistent read/star/reply flags.
 * @property {string} keywords - The expected keywords.
 * @property {string} text - The custom text property.
 * @property {number} score - The custom uint32 property.
 * @property {string} scoreText - The text view of the uint32 property.
 * @property {boolean} empty - Whether the empty custom property is present.
 */

/**
 * Builds messages with the same Message-ID and distinct subjects and bodies.
 *
 * @param {string} subject - The message subject.
 * @param {string} body - The complete body, including its final CRLF.
 * @returns {string} An ASCII message with fixed headers.
 */
function makeMessage(subject, body) {
  return (
    [
      "From: Sender <sender@invalid>",
      "To: Recipient <recipient@invalid>",
      "Cc: Copy <copy@invalid>",
      "Date: Tue, 01 Jan 2019 00:00:00 +0000",
      "Message-ID: <duplicate-local@invalid>",
      "References: <ancestor@invalid> <parent@invalid>",
      "Subject: " + subject,
      "Content-Type: text/plain; charset=us-ascii",
      "",
      "",
    ].join("\r\n") + body
  );
}

/**
 * Reads and closes a message stream.
 *
 * @param {nsIInputStream} stream - The stream to consume.
 * @returns {string} The complete message bytes.
 */
function readMessage(stream) {
  try {
    let raw = "";
    while (stream.available()) {
      raw += NetUtil.readInputStreamToString(stream, stream.available());
    }
    return raw;
  } finally {
    stream.close();
  }
}

/**
 * Checks exact membership, bodies, metadata and counts in one folder.
 *
 * @param {nsIMsgFolder} folder - The source or destination folder.
 * @param {ExpectedMessage[]} expected - Literal outcomes in subject order.
 * @param {number} unread - The expected unread count.
 */
function checkFolder(folder, expected, unread) {
  const db = folder.msgDatabase;
  const headers = Array.from(db.enumerateMessages()).sort((a, b) =>
    a.subject.localeCompare(b.subject)
  );
  Assert.deepEqual(
    headers.map(header => header.subject),
    expected.map(message => message.subject),
    folder.name + " has exactly the expected messages"
  );
  Assert.equal(folder.getTotalMessages(false), expected.length);
  Assert.equal(folder.getNumUnread(false), unread);
  for (const [index, header] of headers.entries()) {
    const want = expected[index];
    Assert.equal(header.folder, folder, "The header belongs to this folder");
    Assert.ok(
      db.containsKey(header.messageKey),
      "This folder contains the key"
    );
    Assert.notEqual(header.storeToken, "", "The body has a final store token");
    const raw = readMessage(folder.getMsgInputStream(header));
    const separator = raw.indexOf("\r\n\r\n");
    Assert.greaterOrEqual(
      separator,
      0,
      "The message has a header/body separator"
    );
    Assert.equal(
      raw.slice(separator + 4),
      want.body,
      "Exact body bytes survive"
    );
    Assert.equal(
      header.messageSize,
      raw.length,
      "Size matches the stored bytes"
    );
    Assert.equal(
      readMessage(
        folder.msgStore.getMsgInputStream(folder, header.storeToken, 0)
      ),
      raw,
      "The token and folder header retrieve the same complete message"
    );
    Assert.deepEqual(
      {
        messageId: header.messageId,
        author: header.author,
        recipients: header.recipients,
        ccList: header.ccList,
        date: header.date,
        references: Array.from({ length: header.numReferences }, (_, i) =>
          header.getStringReference(i)
        ),
        flags:
          header.flags &
          (Ci.nsMsgMessageFlags.Read |
            Ci.nsMsgMessageFlags.Marked |
            Ci.nsMsgMessageFlags.Replied),
        offline: Boolean(header.flags & Ci.nsMsgMessageFlags.Offline),
        offlineSize: header.offlineMessageSize,
        keywords: header.getStringProperty("keywords"),
        text: header.getStringProperty("deliveryLocalText"),
        score: header.getUint32Property("deliveryLocalScore"),
        scoreText: header.getStringProperty("deliveryLocalScore"),
        textNumber: header.getUint32Property("deliveryLocalText"),
        empty: header.properties.includes("deliveryLocalEmpty"),
        emptyText: header.getStringProperty("deliveryLocalEmpty"),
      },
      {
        messageId: "duplicate-local@invalid",
        author: "Sender <sender@invalid>",
        recipients: "Recipient <recipient@invalid>",
        ccList: "Copy <copy@invalid>",
        date: 1546300800000000,
        references: ["ancestor@invalid", "parent@invalid"],
        flags: want.flags,
        offline: false,
        offlineSize: 0,
        keywords: want.keywords,
        text: want.text,
        score: want.score,
        scoreText: want.scoreText,
        textNumber: 0,
        empty: want.empty,
        emptyText: "",
      },
      folder.name + ": " + want.subject + " retains its metadata"
    );
  }
}

add_task(async function test_movesExactMessageAndRetainsBystanders() {
  const lane = PanoramaDelivery.expectedLane();
  const { folder: source, rootFolder } =
    PanoramaDelivery.createLocalFixture("source");
  const destination = rootFolder.createLocalSubfolder("destination");
  PanoramaDelivery.assertFolder(destination, lane);

  source.addMessage(makeMessage("Keeper", "Kept source body.\r\n"));
  const target = source.addMessage(
    makeMessage(
      "Target",
      "From target body.\r\n>From quoted target.\r\n.\r\nTarget tail.\r\n"
    )
  );
  destination.addMessage(makeMessage("Resident", "Existing destination.\r\n"));
  source.markMessagesRead([target], true);
  source.markMessagesFlagged([target], true);
  target.setStringProperty("keywords", "local-tag");
  target.setStringProperty("deliveryLocalText", "literal-0042");
  target.setUint32Property("deliveryLocalScore", 42);
  target.setStringProperty("deliveryLocalEmpty", "");
  const sourceKey = target.messageKey;

  const listener = new PromiseTestUtils.PromiseCopyListener();
  MailServices.copy.copyMessages(
    source,
    [target],
    destination,
    true,
    listener,
    null,
    false
  );
  await listener.promise;
  PanoramaDelivery.assertFolder(source, lane);
  PanoramaDelivery.assertFolder(destination, lane);

  checkFolder(
    source,
    [
      {
        subject: "Keeper",
        body: "Kept source body.\r\n",
        flags: 0,
        keywords: "",
        text: "",
        score: 0,
        scoreText: "",
        empty: false,
      },
    ],
    1
  );
  checkFolder(
    destination,
    [
      {
        subject: "Resident",
        body: "Existing destination.\r\n",
        flags: 0,
        keywords: "",
        text: "",
        score: 0,
        scoreText: "",
        empty: false,
      },
      {
        subject: "Target",
        body:
          "From target body.\r\n>From quoted target.\r\n" +
          ".\r\nTarget tail.\r\n",
        flags: Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked,
        keywords: "local-tag",
        text: "literal-0042",
        score: 42,
        scoreText: "2a",
        empty: true,
      },
    ],
    1
  );
  Assert.ok(
    !source.msgDatabase.containsKey(sourceKey),
    "The old source location no longer has the moved message"
  );
  // A move may retain or replace its global key. Both locations were checked.
  info('DELIVERY_PHASE {"phase":"local-move-verified"}');
});
