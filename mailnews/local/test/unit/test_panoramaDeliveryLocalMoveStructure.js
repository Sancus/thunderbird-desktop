/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from ../../../db/panorama/test/xpcshell/head.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

/**
 * @typedef {object} HeaderStructure
 * @property {string} subject - The stored subject.
 * @property {string} author - The From header.
 * @property {string} recipients - The To header.
 * @property {string} ccList - The Cc header.
 * @property {string} bccList - The Bcc header.
 * @property {string} messageId - The message identity from its header.
 * @property {number} date - The date in microseconds.
 * @property {number} flags - The persistent read/star/reply flags.
 * @property {number} priority - The stored priority.
 * @property {string} keywords - The stored tags.
 * @property {string[]} references - The exposed references in order.
 */

/**
 * Returns structural values without reading body or arbitrary properties.
 *
 * @param {nsIMsgDBHdr} header - The header to read.
 * @returns {HeaderStructure} A snapshot of the structural fields.
 */
function readStructure(header) {
  return {
    subject: header.subject,
    author: header.author,
    recipients: header.recipients,
    ccList: header.ccList,
    bccList: header.bccList,
    messageId: header.messageId,
    date: header.date,
    flags:
      header.flags &
      (Ci.nsMsgMessageFlags.Read |
        Ci.nsMsgMessageFlags.Marked |
        Ci.nsMsgMessageFlags.Replied),
    priority: header.priority,
    keywords: header.getStringProperty("keywords"),
    references: Array.from({ length: header.numReferences }, (_, index) =>
      header.getStringReference(index)
    ),
  };
}

add_task(async function test_moveStructuralFields() {
  const lane = PanoramaDelivery.expectedLane();
  const { folder: source, rootFolder } =
    PanoramaDelivery.createLocalFixture("move-source");
  const destination = rootFolder
    .createLocalSubfolder("move-destination")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const db = PanoramaDelivery.assertFolder(destination, lane);
  const messages = [];
  for (const name of ["first", "second"]) {
    messages.push(
      source.addMessage(
        [
          "From: Sender <sender@invalid>",
          "To: Recipient <recipient@invalid>",
          "Cc: Copy <copy@invalid>",
          "Bcc: Blind <blind@invalid>",
          "Date: Tue, 01 Jan 2019 00:00:00 +0000",
          "Message-ID: <" + name + "-structure@invalid>",
          "References: <ancestor@invalid> <parent@invalid>",
          "Subject: Wire subject",
          "",
          "Stored body.",
          "",
        ].join("\r\n")
      )
    );
  }
  // The stored subject differs from the body header, so reparsing is insufficient.
  messages[0].subject = "First stored";
  messages[1].subject = "Second stored";
  source.markMessagesRead([messages[0]], true);
  source.markMessagesFlagged([messages[0]], true);
  messages[1].orFlags(Ci.nsMsgMessageFlags.Replied);
  messages[0].priority = Ci.nsMsgPriority.high;
  messages[1].priority = Ci.nsMsgPriority.low;
  messages[1].setReferences("");
  messages[0].setStringProperty("keywords", "structural-tag");
  const expected = [
    {
      subject: "First stored",
      author: "Sender <sender@invalid>",
      recipients: "Recipient <recipient@invalid>",
      ccList: "Copy <copy@invalid>",
      bccList: "Blind <blind@invalid>",
      messageId: "first-structure@invalid",
      date: 1546300800000000,
      flags: Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked,
      priority: Ci.nsMsgPriority.high,
      keywords: "structural-tag",
      references: ["ancestor@invalid", "parent@invalid"],
    },
    {
      subject: "Second stored",
      author: "Sender <sender@invalid>",
      recipients: "Recipient <recipient@invalid>",
      ccList: "Copy <copy@invalid>",
      bccList: "Blind <blind@invalid>",
      messageId: "second-structure@invalid",
      date: 1546300800000000,
      flags: Ci.nsMsgMessageFlags.Replied,
      priority: Ci.nsMsgPriority.low,
      keywords: "",
      references: [],
    },
  ];
  Assert.deepEqual(
    messages.map(readStructure),
    expected,
    "Source fixture values"
  );

  const additions = [];
  const observer = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged() {},
    onHdrDeleted() {},
    onParentChanged() {},
    onAnnouncerGoingAway() {},
    onReadChanged() {},
    onJunkScoreChanged() {},
    onHdrPropertyChanged() {},
    onEvent() {},
    onHdrAdded(header) {
      const snapshot = { messageId: "" };
      additions.push(snapshot);
      try {
        Object.assign(snapshot, readStructure(header));
      } catch (error) {
        snapshot.error = String(error);
      }
    },
  };
  registerCleanupFunction(() => db.removeListener(observer));
  db.addListener(observer);
  const listener = new PromiseTestUtils.PromiseCopyListener();
  MailServices.copy.copyMessages(
    source,
    messages,
    destination,
    true,
    listener,
    null,
    false
  );
  await listener.promise;
  PanoramaDelivery.assertFolder(source, lane);
  PanoramaDelivery.assertFolder(destination, lane);
  const byId = (a, b) => a.messageId.localeCompare(b.messageId);
  Assert.deepEqual(
    additions.sort(byId),
    expected,
    "Each addition exposes exact structural fields before later updates"
  );
  Assert.deepEqual(
    Array.from(destination.messages, readStructure).sort(byId),
    expected,
    "Destination headers retain exact structural fields"
  );
  Assert.deepEqual(
    Array.from(source.messages, readStructure).sort(byId),
    [],
    "Source membership and structural fields match the operation"
  );
  info('DELIVERY_PHASE {"phase":"local-move-structure-verified"}');
});
