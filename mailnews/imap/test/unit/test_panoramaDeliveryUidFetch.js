/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

// A separate preconfigured-store fixture isolates key-to-UID fetch evidence.
add_task(async function test_fetchesServerUidUsingLocalKey() {
  const lane = PanoramaDelivery.expectedLane();
  info(
    "DELIVERY_IMAP_FIXTURE " +
      JSON.stringify({
        ...lane,
        mode: "preconfigured-store",
      })
  );
  const { core, daemon, incomingServer, rootFolder } =
    PanoramaDelivery.createImapFixture();
  const expected = [
    [
      {
        uid: 5001,
        messageId: "inbox-fetch@example.invalid",
        subject: "Fetch from inbox",
        body: "Only the INBOX message contains this body.",
      },
    ],
    [
      {
        uid: 5001,
        messageId: "other-fetch@example.invalid",
        subject: "Fetch from other folder",
        body: "Only the DeliveryOther message contains this body.",
      },
    ],
  ];
  // Equal UIDVALIDITY values also require the folder to scope each UID.
  const inboxMailbox = daemon.getMailbox("INBOX");
  inboxMailbox.uidvalidity = 1234;
  const otherMailbox = daemon.createMailbox("DeliveryOther", {
    subscribed: true,
    uidvalidity: 1234,
  });
  const mailboxes = [inboxMailbox, otherMailbox];
  for (const [index, messages] of expected.entries()) {
    for (const message of messages) {
      const source = [
        "From: sender@example.invalid",
        "To: recipient@example.invalid",
        "Date: Thu, 01 Oct 2026 12:00:00 +0000",
        `Message-ID: <${message.messageId}>`,
        `Subject: ${message.subject}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=us-ascii",
        "",
        message.body,
        "",
      ].join("\r\n");
      mailboxes[index].addMessage(
        new ImapMessage(
          "data:text/plain;base64," + btoa(source),
          message.uid,
          []
        )
      );
    }
  }
  info('DELIVERY_PHASE {"phase":"imap-discovery"}');
  const discovery = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(rootFolder, discovery, null);
  await discovery.promise;
  const folders = ["INBOX", "DeliveryOther"].map(name =>
    rootFolder.getChildNamed(name).QueryInterface(Ci.nsIMsgImapMailFolder)
  );
  for (const folder of folders) {
    Assert.equal(
      folder.server,
      incomingServer,
      "Folder belongs to the account"
    );
    if (core) {
      Assert.greater(folder.id, 0, "Discovered folder has a Panorama ID");
      Assert.equal(
        core.folderDB.getFolderChildNamed(rootFolder.id, folder.name),
        folder.id,
        "Discovered folder is registered under its account"
      );
      Assert.equal(
        core.folderDB.getMsgFolderForFolder(folder.id),
        folder,
        "Panorama resolves the discovered IMAP folder"
      );
    }
    PanoramaDelivery.assertFolder(folder, lane);
    folder.clearFlag(Ci.nsMsgFolderFlags.Offline);
    const listener = new PromiseTestUtils.PromiseUrlListener();
    folder.updateFolderWithListener(null, listener);
    await listener.promise;
  }
  const headers = folders.map((folder, index) => {
    Assert.equal(
      folder.getTotalMessages(false),
      1,
      "One message in each folder"
    );
    const header = folder.msgDatabase.getMsgHdrForMessageID(
      expected[index][0].messageId
    );
    Assert.ok(header, "Message has a local header before streaming");
    Assert.equal(header.folder, folder, "Header belongs to its source folder");
    return header;
  });
  if (core) {
    Assert.notEqual(
      headers[0].messageKey,
      headers[1].messageKey,
      "Messages with the same server UID have distinct global keys"
    );
    Assert.ok(
      headers.some(header => header.messageKey != 5001),
      "At least one fetch must translate a global key to a different server UID"
    );
  }
  info('DELIVERY_PHASE {"phase":"uid-fetch"}');
  // Fetch in reverse discovery order to exercise selection of both mailboxes.
  for (const index of [1, 0]) {
    const folder = folders[index];
    const header = headers[index];
    const message = expected[index][0];
    Assert.equal(
      header.flags & Ci.nsMsgMessageFlags.Offline,
      0,
      "The body is not available from an offline store"
    );
    const uri = folder.getUriForMsg(header);
    const service = MailServices.messageServiceFromURI(uri);
    const streamListener = new PromiseTestUtils.PromiseStreamListener();
    const urlListener = new PromiseTestUtils.PromiseUrlListener();
    const [data] = await Promise.all([
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
    ]).catch(error => {
      throw new Error(`IMAP fetch failed for ${message.messageId}`, {
        cause: error,
      });
    });
    const source = data.replace(/\r\n/g, "\n");
    Assert.ok(
      source.includes(`Message-ID: <${message.messageId}>\n`),
      "Streaming by the local key retrieves the correct Message-ID"
    );
    const bodyStart = source.indexOf("\n\n");
    Assert.greater(bodyStart, 0, "Stream contains a header/body separator");
    Assert.equal(
      source.slice(bodyStart + 2),
      message.body + "\n",
      "Streaming by the local key retrieves exactly the correct server body"
    );
    if (core) {
      const globalHeader = core.messageDB.getMessage(header.messageKey);
      Assert.equal(
        globalHeader.messageId,
        message.messageId,
        "Global identity"
      );
      Assert.equal(
        globalHeader.folder,
        folder,
        "Global key retains its folder"
      );
    }
  }
  Assert.deepEqual(
    inboxMailbox._messages.map(message => message.uid),
    [5001],
    "Fetching preserves the actual INBOX UID set"
  );
  Assert.deepEqual(
    otherMailbox._messages.map(message => message.uid),
    [5001],
    "Fetching preserves the actual DeliveryOther UID set"
  );
  info('DELIVERY_PHASE {"phase":"uid-fetch-verified"}');
});
