/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from ../../../db/panorama/test/xpcshell/head.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

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

add_task(function test_publishesRetrievableCompleteMessage() {
  const lane = PanoramaDelivery.expectedLane();
  const { folder, db } = PanoramaDelivery.createLocalFixture("publication");
  const raw = [
    "From: Sender <sender@invalid>",
    "To: Recipient <recipient@invalid>",
    "Date: Tue, 01 Jan 2019 00:00:00 +0000",
    "Message-ID: <local-publication@invalid>",
    "References: <ancestor@invalid> <parent@invalid>",
    "Subject: Local publication",
    "Content-Type: text/plain; charset=us-ascii",
    "",
    "From an unescaped body line.",
    ">From an already quoted body line.",
    ".",
    "Last body line.",
    "",
  ].join("\r\n");
  const additions = [];
  const listener = {
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
      // Retain values now; reading a live header later would hide early adds.
      const snapshot = {};
      additions.push(snapshot);
      try {
        snapshot.hasToken = header.storeToken !== "";
        snapshot.size = header.messageSize;
        snapshot.messageId = header.messageId;
        snapshot.subject = header.subject;
        snapshot.folderURI = header.folder.URI;
        snapshot.member = db.containsKey(header.messageKey);
        snapshot.ids = Array.from(
          db.enumerateMessages(),
          message => message.messageId
        );
        snapshot.total = folder.getTotalMessages(false);
        snapshot.unread = folder.getNumUnread(false);
        snapshot.references = Array.from(
          { length: header.numReferences },
          (_, index) => header.getStringReference(index)
        );
        // An empty token is unset. Do not pass it to a native store reader.
        if (snapshot.hasToken) {
          snapshot.raw = readMessage(folder.getMsgInputStream(header));
        }
      } catch (error) {
        // Native observer dispatch can ignore an exception from this callback.
        snapshot.error = String(error);
      }
    },
  };
  registerCleanupFunction(() => db.removeListener(listener));
  db.addListener(listener);
  const header = folder.addMessage(raw);

  // Check retrieval after return independently of the captured callback state.
  PanoramaDelivery.assertFolder(folder, lane);
  Assert.notEqual(header.storeToken, "", "The stored message has a token");
  Assert.equal(
    readMessage(folder.getMsgInputStream(header)),
    raw,
    "The folder retrieves the exact headers and body"
  );
  Assert.equal(
    readMessage(
      folder.msgStore.getMsgInputStream(folder, header.storeToken, 0)
    ),
    raw,
    "The final token retrieves the exact headers and body"
  );
  Assert.deepEqual(
    additions,
    [
      {
        hasToken: true,
        size: raw.length,
        messageId: "local-publication@invalid",
        subject: "Local publication",
        folderURI: folder.URI,
        member: true,
        ids: ["local-publication@invalid"],
        total: 1,
        unread: 1,
        references: ["ancestor@invalid", "parent@invalid"],
        raw,
      },
    ],
    "Exactly one addition exposes complete metadata and retrievable bytes"
  );
  info('DELIVERY_PHASE {"phase":"local-publication-verified"}');
});
