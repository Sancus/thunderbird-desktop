/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

let fixture;

add_setup(function () {
  const lane = PanoramaDelivery.expectedLane();
  info(
    "DELIVERY_IMAP_FIXTURE " +
      JSON.stringify({ ...lane, mode: "preconfigured-store" })
  );
  fixture = PanoramaDelivery.createImapFixture();
});

add_task(async function test_replacesMessagesFromOldUidValidity() {
  const { lane, core, daemon, server, incomingServer, rootFolder } = fixture;
  const oldMailbox = daemon.createMailbox("DeliveryEpoch", {
    subscribed: true,
    uidvalidity: 7101,
  });
  addEpochMessage(
    oldMailbox,
    5001,
    "old-epoch-reused@example.invalid",
    "Before reset, reused UID",
    "Old epoch content at UID 5001."
  );
  addEpochMessage(
    oldMailbox,
    5011,
    "old-epoch-removed@example.invalid",
    "Before reset, removed UID",
    "This message disappears with the old epoch."
  );
  Assert.deepEqual(
    oldMailbox._messages.map(message => message.uid),
    [5001, 5011],
    "The populated old epoch has exactly the fixture UIDs"
  );
  Assert.equal(
    oldMailbox.uidvalidity,
    7101,
    "The initial server epoch is fixed"
  );

  info('DELIVERY_PHASE {"phase":"imap-discovery"}');
  const discovery = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(rootFolder, discovery, null);
  await discovery.promise;
  const folder = rootFolder
    .getChildNamed("DeliveryEpoch")
    .QueryInterface(Ci.nsIMsgImapMailFolder);
  Assert.equal(
    folder.server,
    incomingServer,
    "The folder belongs to the account"
  );
  PanoramaDelivery.assertFolder(folder, lane);
  if (lane.backend == "panorama") {
    Assert.ok(core, "The required Panorama backend supplies the core service");
    Assert.greater(
      folder.id,
      0,
      "The discovered IMAP folder has a Panorama ID"
    );
    Assert.equal(
      core.folderDB.getFolderChildNamed(rootFolder.id, "DeliveryEpoch"),
      folder.id,
      "The server-discovered folder is registered under its account"
    );
    Assert.equal(
      core.folderDB.getMsgFolderForFolder(folder.id),
      folder,
      "Panorama resolves the discovered IMAP folder"
    );
  }
  folder.clearFlag(Ci.nsMsgFolderFlags.Offline);
  info('DELIVERY_PHASE {"phase":"imap-discovery-verified"}');

  await updateEpochFolder(folder);
  Assert.equal(
    folder.msgDatabase.dBFolderInfo.imapUidValidity,
    7101,
    "The first production synchronization records the old UIDVALIDITY"
  );
  Assert.equal(folder.getTotalMessages(false), 2, "Both old messages are live");
  Assert.deepEqual(
    Array.from(folder.messages, header => [
      header.messageId,
      header.subject,
    ]).sort(),
    [
      ["old-epoch-removed@example.invalid", "Before reset, removed UID"],
      ["old-epoch-reused@example.invalid", "Before reset, reused UID"],
    ],
    "The client initially contains exactly the old epoch's messages"
  );
  const oldHeader = folder.msgDatabase.getMsgHdrForMessageID(
    "old-epoch-reused@example.invalid"
  );
  const removedHeader = folder.msgDatabase.getMsgHdrForMessageID(
    "old-epoch-removed@example.invalid"
  );
  Assert.ok(oldHeader, "The reused UID initially has its old header");
  Assert.ok(removedHeader, "The old-only UID initially has its header");
  const oldKey = oldHeader.messageKey;
  const removedKey = removedHeader.messageKey;
  Assert.notEqual(
    oldKey,
    removedKey,
    "The two old messages have distinct keys"
  );
  Assert.ok(
    folder.msgDatabase.containsKey(oldKey),
    "The old key is initially live"
  );
  Assert.ok(
    folder.msgDatabase.containsKey(removedKey),
    "The old-only key is initially live"
  );
  await assertEpochBody(
    folder,
    oldKey,
    "old-epoch-reused@example.invalid",
    "Old epoch content at UID 5001.\r\n"
  );
  const oldConnections = daemon.getConnections(oldMailbox);
  Assert.equal(oldConnections.length, 1, "The client selected the old mailbox");
  info('DELIVERY_PHASE {"phase":"uidvalidity-initial-verified"}');

  incomingServer.closeCachedConnections();
  await TestUtils.waitForCondition(
    () => daemon.getConnections().length == 0,
    "The old connection must close before the server namespace changes"
  );
  server.resetTest();
  info('DELIVERY_PHASE {"phase":"uidvalidity-disconnected"}');

  // Replace only server state. The client retains its populated folder database.
  daemon.deleteMailbox(oldMailbox);
  const newMailbox = daemon.createMailbox("DeliveryEpoch", {
    subscribed: true,
    uidvalidity: 7202,
  });
  addEpochMessage(
    newMailbox,
    5001,
    "new-epoch-reused@example.invalid",
    "After reset, reused UID",
    "New epoch content at the reused UID 5001."
  );
  Assert.notEqual(newMailbox, oldMailbox, "The server mailbox was replaced");
  Assert.equal(daemon.getMailbox("DeliveryEpoch"), newMailbox);
  Assert.equal(newMailbox.uidvalidity, 7202, "The replacement has a new epoch");
  Assert.deepEqual(
    newMailbox._messages.map(message => message.uid),
    [5001],
    "The new epoch reuses one UID and removes the other"
  );
  assertEpochSource(
    newMailbox._messages[0].getText(),
    "new-epoch-reused@example.invalid",
    "New epoch content at the reused UID 5001.\r\n"
  );

  await updateEpochFolder(folder);
  const newConnections = daemon.getConnections(newMailbox);
  Assert.equal(newConnections.length, 1, "The client selected the replacement");
  Assert.notEqual(
    newConnections[0],
    oldConnections[0],
    "Synchronization reconnected instead of using the old selected connection"
  );
  PanoramaDelivery.assertFolder(folder, lane);
  Assert.equal(
    folder.msgDatabase.dBFolderInfo.imapUidValidity,
    7202,
    "Production synchronization records the replacement UIDVALIDITY"
  );
  const folderCount = folder.getTotalMessages(false);
  const messages = Array.from(folder.messages, header => ({
    key: header.messageKey,
    messageId: header.messageId,
    subject: header.subject,
  }));
  info(
    "DELIVERY_IMAP_MEMBERSHIP " +
      JSON.stringify({
        ...lane,
        folderURI: folder.URI,
        uidValidity: folder.msgDatabase.dBFolderInfo.imapUidValidity,
        folderCount,
        pendingCount: folder.numPendingTotalMessages,
        databaseCount: folder.msgDatabase.dBFolderInfo.numMessages,
        messages,
      })
  );
  Assert.deepEqual(
    messages.map(header => [header.messageId, header.subject]),
    [["new-epoch-reused@example.invalid", "After reset, reused UID"]],
    "Client membership and metadata match only the replacement epoch"
  );
  Assert.equal(folderCount, 1, "Only the new message is live");
  const newHeader = folder.msgDatabase.getMsgHdrForMessageID(
    "new-epoch-reused@example.invalid"
  );
  Assert.ok(newHeader, "The new physical message has a local header");
  Assert.equal(
    newHeader.folder,
    folder,
    "The new header belongs to this folder"
  );
  const newKey = newHeader.messageKey;
  Assert.ok(folder.msgDatabase.containsKey(newKey), "The new key is live");
  Assert.ok(
    !folder.msgDatabase.containsKey(removedKey),
    "The old-only message key no longer names a live message in this folder"
  );
  if (lane.backend == "panorama") {
    Assert.notEqual(
      newKey,
      oldKey,
      "A reused UID gets a fresh global identity"
    );
    Assert.notEqual(
      newKey,
      removedKey,
      "No old epoch global key is reassigned"
    );
    Assert.ok(
      !folder.msgDatabase.containsKey(oldKey),
      "The reused UID's old global key no longer names a live folder message"
    );
    const globalHeader = core.messageDB.getMessage(newKey);
    Assert.ok(globalHeader, "The new global key resolves to a message");
    Assert.equal(globalHeader.messageId, "new-epoch-reused@example.invalid");
    Assert.equal(
      globalHeader.folder,
      folder,
      "The new global key keeps its folder"
    );
  } else {
    Assert.equal(
      oldKey,
      5001,
      "The reference uses the old server UID as its key"
    );
    Assert.equal(
      removedKey,
      5011,
      "The reference old-only key was its server UID"
    );
    Assert.equal(newKey, 5001, "The reference retains UID-as-key behavior");
  }
  info('DELIVERY_PHASE {"phase":"uidvalidity-headers-verified"}');

  await assertEpochBody(
    folder,
    newKey,
    "new-epoch-reused@example.invalid",
    "New epoch content at the reused UID 5001.\r\n"
  );
  info('DELIVERY_PHASE {"phase":"uidvalidity-content-verified"}');

  await updateEpochFolder(folder);
  Assert.equal(
    folder.getTotalMessages(false),
    1,
    "Repeated sync adds no duplicate"
  );
  Assert.deepEqual(
    Array.from(folder.messages, header => [
      header.messageId,
      header.messageKey,
    ]),
    [["new-epoch-reused@example.invalid", newKey]],
    "Repeated sync preserves only the new identity"
  );
  Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 7202);
  Assert.deepEqual(
    newMailbox._messages.map(message => message.uid),
    [5001],
    "Synchronization preserves the actual new epoch UID set"
  );
  Assert.equal(newMailbox.uidvalidity, 7202);
  info('DELIVERY_PHASE {"phase":"uidvalidity-reset-verified"}');
});

/**
 * Adds literal message data to the fake mailbox at the supplied UID.
 *
 * @param {ImapMailbox} mailbox - The server mailbox.
 * @param {number} uid - The wire UID.
 * @param {string} messageId - The Message-ID without angle brackets.
 * @param {string} subject - The subject text.
 * @param {string} body - The single body line without its final CRLF.
 */
function addEpochMessage(mailbox, uid, messageId, subject, body) {
  const source = [
    "From: sender@example.invalid",
    "To: recipient@example.invalid",
    "Date: Thu, 01 Oct 2026 12:00:00 +0000",
    "Message-ID: <" + messageId + ">",
    "Subject: " + subject,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=us-ascii",
    "",
    body,
    "",
  ].join("\r\n");
  mailbox.addMessage(
    new ImapMessage("data:text/plain;base64," + btoa(source), uid, [])
  );
}

/**
 * Waits for the production folder synchronization URL to succeed.
 *
 * @param {nsIMsgImapMailFolder} folder - The folder to synchronize.
 * @returns {Promise<void>} Resolves after successful URL completion.
 */
async function updateEpochFolder(folder) {
  const listener = new PromiseTestUtils.PromiseUrlListener();
  folder.updateFolderWithListener(null, listener);
  await listener.promise;
}

/**
 * Checks the literal Message-ID and exact body bytes in an RFC822 source.
 *
 * @param {string} source - The raw source.
 * @param {string} messageId - The expected Message-ID without angle brackets.
 * @param {string} body - The expected body, including its final CRLF.
 */
function assertEpochSource(source, messageId, body) {
  Assert.ok(
    source.includes("\r\nMessage-ID: <" + messageId + ">\r\n"),
    "The source has the expected Message-ID: " + messageId
  );
  const bodyStart = source.indexOf("\r\n\r\n");
  Assert.greater(bodyStart, 0, "The source has a header/body separator");
  Assert.equal(
    source.slice(bodyStart + 4),
    body,
    "The body bytes match exactly"
  );
}

/**
 * Streams a live folder key and checks its Message-ID and body.
 *
 * @param {nsIMsgImapMailFolder} folder - The message's folder.
 * @param {number} key - The live local message key.
 * @param {string} messageId - The expected Message-ID without angle brackets.
 * @param {string} body - The expected body, including its final CRLF.
 * @returns {Promise<void>} Resolves after URL/stream success and source assertions.
 */
async function assertEpochBody(folder, key, messageId, body) {
  const header = folder.msgDatabase.getMsgHdrForKey(key);
  Assert.ok(header, "The body key resolves to a local header");
  Assert.equal(header.folder, folder, "The body key resolves in this folder");
  Assert.equal(
    header.messageId,
    messageId,
    "The body key resolves the expected ID"
  );
  Assert.equal(
    header.flags & Ci.nsMsgMessageFlags.Offline,
    0,
    "The fixture does not supply an offline body"
  );
  const uri = folder.getUriForMsg(header);
  const service = MailServices.messageServiceFromURI(uri);
  const streamListener = new PromiseTestUtils.PromiseStreamListener();
  const urlListener = new PromiseTestUtils.PromiseUrlListener();
  const [source] = await Promise.all([
    streamListener.promise,
    urlListener.promise,
    Promise.resolve().then(() =>
      service.streamMessage(
        uri,
        streamListener,
        null,
        urlListener,
        false,
        "",
        false
      )
    ),
  ]);
  assertEpochSource(source, messageId, body);
}
