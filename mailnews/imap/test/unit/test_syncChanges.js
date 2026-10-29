/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Test to ensure that changes made from a different profile/machine
 * are synced correctly. In particular, we're checking that emptying out
 * an imap folder on the server makes us delete all the headers from our db.
 */

var { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

var { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
var { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

const panorama = Services.prefs.getBoolPref("mail.panorama.enabled", false);
var gMessage;
var gSecondFolder;
var gSynthMessage;

add_setup(async function () {
  /*
   * Set up an IMAP server.
   */
  const store = Services.prefs.getCharPref("mail.serverDefaultStoreContractID");
  Services.prefs.setCharPref("mail.server.default.storeContractID", store);
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
  setupIMAPPump();
  registerCleanupFunction(() => {
    if (IMAPPump.incomingServer) teardownIMAPPump();
  });
  IMAPPump.daemon.createMailbox("secondFolder", { subscribed: true });
  await discoverFolders();
  IMAPPump.inbox = IMAPPump.incomingServer.rootFolder
    .getChildNamed("INBOX")
    .QueryInterface(Ci.nsIMsgImapMailFolder);
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.equal(
    "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
    panorama
  );
  const expectedStore = {
    "@mozilla.org/msgstore/berkeleystore;1": "mbox",
    "@mozilla.org/msgstore/maildirstore;1": "maildir",
  }[store];
  Assert.ok(expectedStore);
  Assert.equal(IMAPPump.incomingServer.msgStore.storeType, expectedStore);
  Assert.equal(IMAPPump.inbox.msgStore.storeType, expectedStore);
  await selectFolder(IMAPPump.inbox);

  let messages = [];
  const gMessageGenerator = new MessageGenerator();
  messages = messages.concat(gMessageGenerator.makeMessage());
  gSynthMessage = messages[0];

  const msgURI = Services.io.newURI(
    "data:text/plain;base64," + btoa(gSynthMessage.toMessageString())
  );
  gMessage = new ImapMessage(msgURI.spec, IMAPPump.mailbox.uidnext++, []);
  IMAPPump.mailbox.addMessage(gMessage);
  if (panorama) {
    addPublishedFixtureHeader(
      IMAPPump.inbox,
      gMessage.uid,
      gSynthMessage.messageId,
      gSynthMessage.toMessageString()
    );
  }

  // update folder to download header.
  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, listener);
  await listener.promise;
});

add_task(async function switchAwayFromInbox() {
  const rootFolder = IMAPPump.incomingServer.rootFolder;
  gSecondFolder = rootFolder
    .getChildNamed("secondFolder")
    .QueryInterface(Ci.nsIMsgImapMailFolder);

  // Selecting the second folder will close the cached connection
  // on the inbox because fake server only supports one connection at a time.
  //  Then, we can poke at the message on the imap server directly, which
  // simulates the user changing the message from a different machine,
  // and Thunderbird discovering the change when it does a flag sync
  // upon reselecting the Inbox.
  const listener = new PromiseTestUtils.PromiseUrlListener();
  gSecondFolder.updateFolderWithListener(null, listener);
  await listener.promise;
});

add_task(async function simulateMailboxEmptied() {
  gMessage.setFlag("\\Deleted");
  const expungeListener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.expunge(expungeListener, null);
  await expungeListener.promise;
  const updateListener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, updateListener);
  await updateListener.promise;
});

add_task(function checkMailboxEmpty() {
  Assert.equal(IMAPPump.inbox.getTotalMessages(false), 0);
});

async function discoverFolders() {
  const listener = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(
    IMAPPump.incomingServer.rootFolder,
    listener,
    null
  );
  await listener.promise;
}

async function selectFolder(folder) {
  const listener = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.selectFolder(folder, listener, null);
  await listener.promise;
}

async function closeConnections() {
  IMAPPump.incomingServer.closeCachedConnections();
  await TestUtils.waitForCondition(
    () => !IMAPPump.daemon.getConnections().length,
    "the next URL should issue SELECT on a new connection"
  );
}

// Model a populated native profile through public database APIs. These tests
// exercise reconciliation of existing physical rows, not header ingestion.
function addPublishedFixtureHeader(folder, uid, id, text) {
  const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  );
  const key = core.messageDB.addMessage(
    folder.id,
    id,
    [],
    0,
    "sender@example.invalid",
    "recipient@example.invalid",
    "",
    "",
    "Pending synchronization",
    0,
    "",
    Ci.nsMsgPriority.normal
  );
  const header = folder.msgDatabase.getMsgHdrForKey(key);
  header.setUint32Property("uidOnServer", uid);
  header.messageSize = text.length;
  Assert.notEqual(key, uid);
  return header;
}

async function makePendingFolder(name) {
  IMAPPump.daemon.createMailbox(name, { subscribed: true });
  const remote = IMAPPump.daemon.getMailbox(name);
  remote.uidvalidity = 7101;
  await discoverFolders();
  const folder = IMAPPump.incomingServer.rootFolder
    .getChildNamed(name)
    .QueryInterface(Ci.nsIMsgImapMailFolder);
  folder.clearFlag(Ci.nsMsgFolderFlags.Offline);
  Assert.equal(
    folder.msgStore.storeType,
    IMAPPump.incomingServer.msgStore.storeType
  );
  await selectFolder(folder);
  Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 7101);
  const messages = [];
  for (const [uid, id, body] of [
    [
      6101,
      `${name}-keep@example.invalid`,
      "Keep this exact pending source body.",
    ],
    [
      6102,
      `${name}-remove@example.invalid`,
      "Only this message leaves the server.",
    ],
  ]) {
    const text =
      "From: sender@example.invalid\r\n" +
      "To: recipient@example.invalid\r\n" +
      `Message-ID: <${id}>\r\nSubject: Pending synchronization\r\n\r\n${body}\r\n`;
    const message = new ImapMessage(
      "data:text/plain;base64," + btoa(text),
      uid,
      []
    );
    remote.addMessage(message);
    remote.uidnext = uid + 1;
    if (panorama) addPublishedFixtureHeader(folder, uid, id, text);
    messages.push({ message, text, id });
  }
  await selectFolder(folder);
  const db = folder.msgDatabase.QueryInterface(Ci.nsIMsgOfflineOpsDatabase);
  const headers = messages.map(({ id }) => db.getMsgHdrForMessageID(id));
  Assert.ok(headers.every(Boolean));
  Assert.equal([...folder.messages].length, 2);
  if (panorama) {
    Assert.equal(headers[0].getUint32Property("uidOnServer"), 6101);
    Assert.equal(headers[1].getUint32Property("uidOnServer"), 6102);
  }
  const downloaded = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.downloadMessagesForOffline(
    "6101",
    folder,
    downloaded,
    null
  );
  await downloaded.promise;
  Assert.ok(headers[0].flags & Ci.nsMsgMessageFlags.Offline);
  Assert.equal(messages[0].message.getText(), messages[0].text);
  return { folder, remote, db, headers, messages };
}

function storedBody(folder, header) {
  const stream = folder.getMsgInputStream(header);
  try {
    return NetUtil.readInputStreamToString(stream, stream.available());
  } finally {
    stream.close();
  }
}

function queueIntent(folder, header, kind) {
  Services.io.offline = true;
  try {
    if (kind == "deleted") {
      folder.storeImapFlags(0x08, true, [header.messageKey], null);
    } else {
      folder.markMessagesFlagged([header], true);
    }
  } finally {
    Services.io.offline = false;
  }
  const db = folder.msgDatabase.QueryInterface(Ci.nsIMsgOfflineOpsDatabase);
  const op = db.getOfflineOpForKey(header.messageKey, false);
  Assert.ok(op);
  if (kind == "move") {
    op.operation = Ci.nsIMsgOfflineImapOperation.kMsgMoved;
    op.destinationFolderURI = gSecondFolder.URI;
  }
  Assert.equal(
    op.operation,
    Ci.nsIMsgOfflineImapOperation.kFlagsChanged |
      (kind == "move" ? Ci.nsIMsgOfflineImapOperation.kMsgMoved : 0)
  );
  Assert.ok(op.newFlags & (kind == "deleted" ? 0x08 : 0x04));
  Assert.deepEqual(
    db.listAllOfflineDeletes(),
    // Mork's legacy mask also includes this offline-stored flags-only row.
    kind == "flags" && panorama ? [] : [header.messageKey]
  );
  return op;
}

async function checkLivePendingSource(kind) {
  const { folder, remote, db, headers, messages } = await makePendingFolder(
    `live-${kind}`
  );
  const [header, removed] = headers;
  const key = header.messageKey;
  const bytes = storedBody(folder, header);
  Assert.ok(bytes.includes("Keep this exact pending source body."));
  const op = queueIntent(folder, header, kind);
  const intent = [
    op.operation,
    op.newFlags,
    op.destinationFolderURI,
    op.playingBack,
  ];
  Assert.ok(db.containsKey(key));
  const added = [],
    deleted = [];
  const listener = {
    msgAdded(item) {
      if (item.folder == folder) added.push(item.messageKey);
    },
    msgsDeleted(items) {
      for (const item of items) {
        if (item.folder == folder) deleted.push(item.messageKey);
      }
    },
  };
  MailServices.mfn.addListener(
    listener,
    MailServices.mfn.msgAdded | MailServices.mfn.msgsDeleted
  );
  const commands = () =>
    [IMAPPump.server.playTransaction()]
      .flat()
      .flatMap(transaction => transaction.them);
  remote._messages.splice(remote._messages.indexOf(messages[1].message), 1);
  const before = commands().length;
  try {
    for (let i = 0; i < 2; i++) {
      await closeConnections();
      await selectFolder(folder);
      Assert.deepEqual(
        [...folder.messages].map(item => item.messageKey),
        [key]
      );
      Assert.ok(db.containsKey(key));
      Assert.equal(db.getMsgHdrForKey(key).messageId, messages[0].id);
      Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 7101);
      Assert.equal(storedBody(folder, db.getMsgHdrForKey(key)), bytes);
      Assert.deepEqual(added, []);
      Assert.deepEqual(deleted, [removed.messageKey]);
      Assert.deepEqual(db.listAllOfflineOpIds(), [key]);
      Assert.deepEqual(
        [op.operation, op.newFlags, op.destinationFolderURI, op.playingBack],
        intent
      );
      Assert.deepEqual(
        remote._messages.map(item => item.uid),
        [6101]
      );
      Assert.deepEqual(messages[0].message.flags, []);
      Assert.equal(messages[0].message.getText(), messages[0].text);
    }
    const sent = commands().slice(before);
    Assert.equal(
      sent.filter(command => /^\S+ SELECT\b/i.test(command)).length,
      2
    );
    Assert.ok(
      !sent.some(command =>
        /^\S+ (?:UID )?(STORE|COPY|MOVE|EXPUNGE)\b/i.test(command)
      )
    );
  } finally {
    MailServices.mfn.removeListener(listener);
  }
}

add_task(async function testSelectKeepsLivePendingFlags() {
  await checkLivePendingSource("flags");
});

add_task(async function testSelectKeepsLivePendingDelete() {
  await checkLivePendingSource("deleted");
});

add_task(async function testSelectKeepsLivePendingMove() {
  await checkLivePendingSource("move");
});

if (panorama) {
  add_task(async function testRemovedPendingSourceWithoutTupleFailsClosed() {
    const { folder, db, headers, remote, messages } =
      await makePendingFolder("removed-pending");
    const key = headers[0].messageKey;
    const op = queueIntent(folder, headers[0], "move");
    const intent = [op.operation, op.newFlags, op.destinationFolderURI];
    db.deleteMessages([key], null);
    Assert.ok(!db.containsKey(key));
    Assert.deepEqual(db.listAllOfflineDeletes(), [key]);
    const deleted = [];
    const notifications = {
      msgsDeleted(items) {
        deleted.push(...items.map(item => item.messageKey));
      },
    };
    MailServices.mfn.addListener(notifications, MailServices.mfn.msgsDeleted);
    const listener = new PromiseTestUtils.PromiseUrlListener();
    const failure = Assert.rejects(
      listener.promise,
      error => error.message == String(Cr.NS_ERROR_NOT_AVAILABLE)
    );
    try {
      MailServices.imap.selectFolder(folder, listener, null);
      await failure;
      Assert.deepEqual(deleted, []);
    } finally {
      MailServices.mfn.removeListener(notifications);
    }
    Assert.deepEqual(
      [...folder.messages].map(item => item.messageKey),
      [headers[1].messageKey]
    );
    Assert.deepEqual(db.listAllOfflineOpIds(), [key]);
    Assert.deepEqual(
      [op.operation, op.newFlags, op.destinationFolderURI],
      intent
    );
    Assert.deepEqual(
      remote._messages.map(item => item.uid),
      [6101, 6102]
    );
    Assert.deepEqual(messages[0].message.flags, []);
  });
}

if (panorama) {
  add_task(async function testPendingDeleteEnumerationErrorKeepsLiveRows() {
    const { folder, db, headers } = await makePendingFolder(
      "query-error-pending"
    );
    const key = headers[0].messageKey;
    const bytes = storedBody(folder, headers[0]);
    const op = queueIntent(folder, headers[0], "deleted");
    const flags = op.newFlags;
    const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    );
    const connection = core.connectionForTests;
    const deleted = [];
    const notifications = {
      msgsDeleted(items) {
        deleted.push(...items.map(item => item.messageKey));
      },
    };
    MailServices.mfn.addListener(notifications, MailServices.mfn.msgsDeleted);
    connection.executeSimpleSQL(
      "ALTER TABLE offline_operations RENAME TO unavailable_offline_operations"
    );
    try {
      const listener = new PromiseTestUtils.PromiseUrlListener();
      const failure = Assert.rejects(
        listener.promise,
        error => error.message == String(Cr.NS_ERROR_FAILURE)
      );
      MailServices.imap.selectFolder(folder, listener, null);
      await failure;
      Assert.deepEqual(deleted, []);
      Assert.deepEqual(
        db.listAllKeys(),
        headers.map(item => item.messageKey)
      );
      Assert.equal(storedBody(folder, headers[0]), bytes);
    } finally {
      connection.executeSimpleSQL(
        "ALTER TABLE unavailable_offline_operations RENAME TO offline_operations"
      );
      MailServices.mfn.removeListener(notifications);
    }
    await selectFolder(folder);
    Assert.ok(db.containsKey(key));
    Assert.equal(storedBody(folder, db.getMsgHdrForKey(key)), bytes);
    Assert.equal(op.newFlags, flags);
    Assert.equal(op.operation, Ci.nsIMsgOfflineImapOperation.kFlagsChanged);
    Assert.deepEqual(db.listAllOfflineOpIds(), [key]);
  });
}

add_task(function endTest() {
  teardownIMAPPump();
});
