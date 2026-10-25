/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

// UIDs are folder-scoped; Panorama keys identify messages globally.
add_task(async function test_keepsOverlappingUidsInTheirFolders() {
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
        messageId: "inbox-shared@example.invalid",
        subject: "Inbox shared UID",
        body: "Body from INBOX UID 5001.",
      },
      {
        uid: 5011,
        messageId: "inbox-only@example.invalid",
        subject: "Inbox other UID",
        body: "Body from INBOX UID 5011.",
      },
    ],
    [
      {
        uid: 5001,
        messageId: "other-shared@example.invalid",
        subject: "Other folder shared UID",
        body: "Body from DeliveryOther UID 5001.",
      },
      {
        uid: 5021,
        messageId: "other-only@example.invalid",
        subject: "Other folder other UID",
        body: "Body from DeliveryOther UID 5021.",
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
  Assert.deepEqual(
    inboxMailbox._messages.map(message => message.uid),
    [5001, 5011],
    "INBOX actually contains the expected server UIDs"
  );
  Assert.deepEqual(
    otherMailbox._messages.map(message => message.uid),
    [5001, 5021],
    "DeliveryOther actually contains the overlapping server UID"
  );
  info('DELIVERY_PHASE {"phase":"uid-headers"}');
  const keys = [];
  for (const [index, folder] of folders.entries()) {
    Assert.equal(folder.getTotalMessages(false), 2, "Folder has two messages");
    Assert.deepEqual(
      Array.from(folder.messages, header => header.messageId).sort(),
      expected[index].map(message => message.messageId).sort(),
      "Folder enumeration contains exactly its own Message-IDs"
    );
    for (const message of expected[index]) {
      const header = folder.msgDatabase.getMsgHdrForMessageID(
        message.messageId
      );
      Assert.ok(header, "Expected message has a local header");
      Assert.equal(
        header.folder,
        folder,
        "Header belongs to its source folder"
      );
      Assert.equal(
        header.subject,
        message.subject,
        "Header has its own subject"
      );
      Assert.equal(
        folder.msgDatabase.getMsgHdrForKey(header.messageKey).messageId,
        message.messageId,
        "Folder key resolves to the expected message"
      );
      keys.push(header.messageKey);
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
  }
  if (core) {
    Assert.equal(
      new Set(keys).size,
      4,
      "Four messages have distinct global keys"
    );
    Assert.notEqual(folders[0].id, folders[1].id, "Folders have distinct IDs");
  }
  // Revisit both folders: synchronisation must not merge or duplicate headers.
  for (const [index, folder] of folders.entries()) {
    const listener = new PromiseTestUtils.PromiseUrlListener();
    folder.updateFolderWithListener(null, listener);
    await listener.promise;
    Assert.deepEqual(
      Array.from(folder.messages, header => [
        header.messageId,
        header.messageKey,
      ]).sort(),
      expected[index]
        .map((message, offset) => [message.messageId, keys[index * 2 + offset]])
        .sort(),
      "Repeated synchronisation preserves message identities and folder keys"
    );
  }
  Assert.deepEqual(
    inboxMailbox._messages.map(message => message.uid),
    [5001, 5011],
    "Repeated synchronisation preserves the actual INBOX UID set"
  );
  Assert.deepEqual(
    otherMailbox._messages.map(message => message.uid),
    [5001, 5021],
    "Repeated synchronisation preserves the actual DeliveryOther UID set"
  );
  info('DELIVERY_PHASE {"phase":"uid-isolation-verified"}');
});
