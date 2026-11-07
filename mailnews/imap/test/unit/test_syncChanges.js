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
const modseqs = new Map();
const changedSince = [];
const sparseUids = new Map();
const sparseResponses = [];

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
  // Supply the standard CONDSTORE responses only for explicitly marked boxes.
  const proto = IMAP_RFC3501_handler.prototype;
  const original = Object.fromEntries(
    ["onStartup", "CAPABILITY", "SELECT", "FETCH"].map(name => [
      name,
      proto[name],
    ])
  );
  proto.onStartup = function () {
    this._argFormat.SELECT.push("[(atom)]");
    this._argFormat.FETCH.push("[(atom)]");
    return original.onStartup.call(this);
  };
  proto.CAPABILITY = function () {
    return original.CAPABILITY.call(this).replace(
      "IMAP4rev1",
      "IMAP4rev1 CONDSTORE"
    );
  };
  proto.SELECT = function (args) {
    const response = original.SELECT.call(this, args);
    return modseqs.has(args[0])
      ? `* OK [HIGHESTMODSEQ ${modseqs.get(args[0])}]\0${response}`
      : response;
  };
  proto.FETCH = function (args, uid) {
    if (args[2]?.[0] == "CHANGEDSINCE") {
      changedSince.push([this._selectedMailbox.name, String(args[2][1])]);
    }
    const response = original.FETCH.call(this, args, uid);
    const changed = sparseUids.get(this._selectedMailbox.name);
    if (changed && args[2]?.[0] == "CHANGEDSINCE") {
      const filtered = response.split("\0").filter(line => {
        if (!/^\* \d+ FETCH /.test(line)) {
          return true;
        }
        return changed.has(Number(line.match(/\bUID (\d+)\b/)[1]));
      });
      sparseResponses.push(
        filtered.filter(line => /^\* \d+ FETCH /.test(line))
      );
      return filtered.join("\0");
    }
    return response;
  };
  registerCleanupFunction(() => Object.assign(proto, original));
  setupIMAPPump();
  IMAPPump.incomingServer.useCondStore = false;
  registerCleanupFunction(async () => {
    if (IMAPPump.incomingServer) {
      await releaseOfflineOpWrappers();
      teardownIMAPPump();
    }
  });
  IMAPPump.daemon.createMailbox("secondFolder", {
    subscribed: true,
    uidvalidity: IMAPPump.daemon.uidvalidity++,
  });
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

/**
 * Releases unused offline-operation wrappers before closing their stores.
 * A wrapper kept alive only by a cycle through cycle-collected objects is
 * garbage after CC but is collected by the next GC, and XPConnect may release
 * the collected natives incrementally from an idle task. Otherwise those Mork
 * rows are released at shutdown, after their stores closed.
 */
async function releaseOfflineOpWrappers() {
  await schedulePreciseGCAndForceCC(3);
  await new Promise(resolve => Cu.schedulePreciseGC(resolve));
  await new Promise(resolve =>
    ChromeUtils.idleDispatch(resolve, { timeout: 1000 })
  );
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
    if (panorama) {
      addPublishedFixtureHeader(folder, uid, id, text);
    }
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
  const readOp = queued => [
    queued.operation,
    queued.newFlags,
    queued.destinationFolderURI,
    queued.playingBack,
  ];
  // A pending delete/move wrapper held across SELECT stays alive until
  // shutdown, after teardown has closed its Mork store. Re-read the stored
  // operation after each SELECT instead of keeping the queued wrapper.
  const intent = readOp(queueIntent(folder, header, kind));
  Assert.ok(db.containsKey(key));
  const added = [],
    deleted = [];
  const listener = {
    msgAdded(item) {
      if (item.folder == folder) {
        added.push(item.messageKey);
      }
    },
    msgsDeleted(items) {
      for (const item of items) {
        if (item.folder == folder) {
          deleted.push(item.messageKey);
        }
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
      Assert.deepEqual(readOp(db.getOfflineOpForKey(key, false)), intent);
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

add_task(async function testSparseChangedSinceSkipsSequenceGap() {
  const { folder, db, headers, remote, messages } =
    await makePendingFolder("sparse-condstore");
  const keys = headers.map(header => header.messageKey);
  const bytes = storedBody(folder, headers[0]);
  const folderInfo = db.dBFolderInfo;
  folderInfo.setCharProperty("highestModSeq", "10");
  folderInfo.setUint32Property("highestRecordedUID", 6102);
  messages[1].message.setFlag("\\Flagged");
  modseqs.set(folder.onlineName, 20);
  sparseUids.set(folder.onlineName, new Set([6102]));
  const before = sparseResponses.length;
  IMAPPump.incomingServer.useCondStore = true;
  try {
    await closeConnections();
    await selectFolder(folder);
    Assert.equal(folderInfo.getCharProperty("highestModSeq"), "20");
    Assert.deepEqual(db.listAllKeys(), keys);
    Assert.ok(
      !(db.getMsgHdrForKey(keys[0]).flags & Ci.nsMsgMessageFlags.Marked)
    );
    Assert.ok(db.getMsgHdrForKey(keys[1]).flags & Ci.nsMsgMessageFlags.Marked);
    Assert.equal(storedBody(folder, headers[0]), bytes);
    Assert.deepEqual(
      remote._messages.map(message => message.uid),
      [6101, 6102]
    );
    Assert.equal(messages[0].message.getText(), messages[0].text);
    const replies = sparseResponses.slice(before);
    Assert.greater(replies.length, 0);
    for (const reply of replies) {
      Assert.equal(reply.length, 1);
      Assert.ok(/^\* 2 FETCH /.test(reply[0]));
      Assert.ok(/\bUID 6102\b/.test(reply[0]));
    }
    Assert.ok(
      changedSince.some(
        ([name, seq]) => name == folder.onlineName && seq == "10"
      )
    );
  } finally {
    sparseUids.delete(folder.onlineName);
    modseqs.delete(folder.onlineName);
    IMAPPump.incomingServer.useCondStore = false;
  }
});

if (panorama) {
  add_task(async function testSelectAllowsUnboundServerUidBeforeIngestion() {
    const { folder, db, headers, remote } =
      await makePendingFolder("unbound-new");
    const keys = headers.map(header => header.messageKey);
    const bytes = storedBody(folder, headers[0]);
    const folderInfo = db.dBFolderInfo;
    folderInfo.setCharProperty("highestModSeq", "10");
    folderInfo.setUint32Property("highestRecordedUID", 6102);
    const text =
      "From: sender@example.invalid\r\n" +
      "Message-ID: <unbound-new@example.invalid>\r\n" +
      "Subject: New unbound server message\r\n\r\nNew server body.\r\n";
    const message = new ImapMessage(
      "data:text/plain;base64," + btoa(text),
      6103,
      []
    );
    remote.addMessage(message);
    remote.uidnext = 6104;
    modseqs.set(folder.onlineName, 20);
    IMAPPump.incomingServer.useCondStore = true;
    const before = sentCommands().length;
    try {
      // No native row is prepopulated for UID6103. This proves SELECT can reach
      // header fetching, not that the separate native ingestor publishes it.
      await closeConnections();
      await selectFolder(folder);
      Assert.equal(folderInfo.getCharProperty("highestModSeq"), "20");
      Assert.deepEqual(
        remote._messages.map(item => item.uid),
        [6101, 6102, 6103]
      );
      Assert.equal(message.getText(), text);
      for (const key of keys) {
        Assert.ok(db.containsKey(key));
      }
      Assert.equal(storedBody(folder, headers[0]), bytes);
      Assert.ok(
        sentCommands()
          .slice(before)
          .some(
            command =>
              /^\S+ UID FETCH 6103\b/i.test(command) &&
              /BODY\.PEEK\[HEADER|RFC822\.HEADER/i.test(command)
          )
      );
    } finally {
      modseqs.delete(folder.onlineName);
      IMAPPump.incomingServer.useCondStore = false;
    }
  });
}

if (panorama) {
  add_task(async function testRemovedPendingSourceWithoutTupleFailsClosed() {
    const { folder, db, headers, remote, messages } =
      await makePendingFolder("removed-pending");
    const key = headers[0].messageKey;
    const token = headers[0].storeToken;
    const bytes = storedTokenBody(folder, token);
    Assert.ok(bytes.includes("Keep this exact pending source body."));
    const connection = nativeConnection();
    connection.executeSimpleSQL(
      `DELETE FROM message_properties WHERE id=${key} AND name='uidOnServer'`
    );
    const op = queueIntent(folder, headers[0], "move");
    headers[0].setUint32Property("uidOnServer", 6101);
    // A later facade write must not backfill a tuple absent at creation.
    const queuedFlags = op.newFlags;
    op.newFlags = queuedFlags;
    Assert.deepEqual(queuedIdentity(folder, key).slice(2), [null, null]);
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
    const failure = (async () => {
      await Assert.rejects(
        listener.promise,
        error => error.message == String(Cr.NS_ERROR_NOT_AVAILABLE)
      );
    })();
    try {
      MailServices.imap.selectFolder(folder, listener, null);
      await failure;
      Assert.deepEqual(deleted, []);
      Assert.equal(storedTokenBody(folder, token), bytes);
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
      const failure = (async () => {
        await Assert.rejects(
          listener.promise,
          error => error.message == String(Cr.NS_ERROR_FAILURE)
        );
      })();
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

function storedTokenBody(folder, token) {
  const stream = folder.msgStore.getMsgInputStream(folder, token, 0);
  try {
    return NetUtil.readInputStreamToString(stream, stream.available());
  } finally {
    stream.close();
  }
}

function nativeConnection() {
  return Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  ).connectionForTests;
}

function queuedIdentity(folder, key) {
  const statement = nativeConnection().createStatement(
    `SELECT id,revision,epoch,uid FROM offline_operations ` +
      `WHERE folderId=${folder.id} AND messageKey=${key}`
  );
  try {
    Assert.ok(statement.executeStep());
    const result = [0, 1, 2, 3].map(column =>
      statement.getIsNull(column) ? null : statement.getInt64(column)
    );
    Assert.ok(!statement.executeStep());
    return result;
  } finally {
    statement.finalize();
  }
}

function sentCommands() {
  return [IMAPPump.server.playTransaction()]
    .flat()
    .flatMap(transaction => transaction.them);
}

async function expectSelectFailure(folder, result) {
  const listener = new PromiseTestUtils.PromiseUrlListener();
  const failure = (async () => {
    await Assert.rejects(
      listener.promise,
      error => error.message == String(result)
    );
  })();
  MailServices.imap.selectFolder(folder, listener, null);
  await failure;
}

if (panorama) {
  add_task(async function testRemovedQueuedSourceSurvivesSelectAndReopen() {
    const { folder, db, headers, remote, messages } =
      await makePendingFolder("saved-source");
    const key = headers[0].messageKey;
    const token = headers[0].storeToken;
    const bytes = storedTokenBody(folder, token);
    Assert.ok(bytes.includes("Keep this exact pending source body."));
    // Keep no offline-operation wrapper alive across forceClosed().
    const intent = (() => {
      const op = queueIntent(folder, headers[0], "move");
      return [op.operation, op.newFlags, op.destinationFolderURI];
    })();
    const identity = queuedIdentity(folder, key);
    Assert.deepEqual(identity.slice(2), [7101, 6101]);
    db.deleteMessages([key], null);
    const added = [],
      deleted = [];
    const notifications = {
      msgAdded(item) {
        if (item.folder == folder) {
          added.push(item.messageKey);
        }
      },
      msgsDeleted(items) {
        for (const item of items) {
          if (item.folder == folder) {
            deleted.push(item.messageKey);
          }
        }
      },
    };
    MailServices.mfn.addListener(
      notifications,
      MailServices.mfn.msgAdded | MailServices.mfn.msgsDeleted
    );
    const before = sentCommands().length;
    try {
      for (let i = 0; i < 2; i++) {
        await closeConnections();
        await releaseOfflineOpWrappers();
        folder.msgDatabase.forceClosed();
        await selectFolder(folder);
        const reopened = folder.msgDatabase.QueryInterface(
          Ci.nsIMsgOfflineOpsDatabase
        );
        Assert.deepEqual(reopened.listAllKeys(), [headers[1].messageKey]);
        Assert.deepEqual(reopened.listAllOfflineOpIds(), [key]);
        Assert.deepEqual(queuedIdentity(folder, key), identity);
        const retained = reopened.getOfflineOpForKey(key, false);
        Assert.deepEqual(
          [
            retained.operation,
            retained.newFlags,
            retained.destinationFolderURI,
          ],
          intent
        );
        Assert.equal(reopened.dBFolderInfo.imapUidValidity, 7101);
        Assert.equal(storedTokenBody(folder, token), bytes);
        Assert.deepEqual(added, []);
        Assert.deepEqual(deleted, []);
        Assert.deepEqual(
          remote._messages.map(item => item.uid),
          [6101, 6102]
        );
        Assert.deepEqual(messages[0].message.flags, []);
        Assert.equal(messages[0].message.getText(), messages[0].text);
      }
      const sent = sentCommands().slice(before);
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
      MailServices.mfn.removeListener(notifications);
    }
  });

  for (const fault of [
    "legacy-null",
    "stale-epoch",
    "collision",
    "corrupt",
    "read-error",
  ]) {
    add_task(async function testQueuedSourceRefusalPreservesCheckpoint() {
      const { folder, db, headers, remote, messages } = await makePendingFolder(
        `source-${fault}`
      );
      dump(`queued source refusal: ${fault}\n`);
      const key = headers[0].messageKey;
      const bytes = storedBody(folder, headers[0]);
      const op = queueIntent(folder, headers[0], "move");
      const intent = [op.operation, op.newFlags, op.destinationFolderURI];
      const identity = queuedIdentity(folder, key);
      Assert.deepEqual(identity.slice(2), [7101, 6101]);
      const connection = nativeConnection();
      const info = db.dBFolderInfo;
      info.setCharProperty("highestModSeq", "10");
      info.setUint32Property("highestRecordedUID", 6102);
      modseqs.set(folder.onlineName, 20);
      IMAPPump.incomingServer.useCondStore = true;
      let restore;
      let expected = Cr.NS_ERROR_NOT_AVAILABLE;
      if (fault == "legacy-null" || fault == "corrupt") {
        const source = connection.createStatement(
          "SELECT sourcePhysicalKey FROM offline_operations " +
            "WHERE folderId=:folderId AND messageKey=:key"
        );
        source.params.folderId = folder.id;
        source.params.key = key;
        let sourcePhysicalKey;
        try {
          Assert.ok(source.executeStep());
          Assert.ok(!source.getIsNull(0));
          sourcePhysicalKey = source.getInt64(0);
          Assert.ok(!source.executeStep());
        } finally {
          source.finalize();
        }
        connection.executeSimpleSQL(
          `UPDATE offline_operations SET epoch=NULL${fault == "legacy-null" ? ",uid=NULL,sourcePhysicalKey=NULL" : ""} ` +
            `WHERE folderId=${folder.id} AND messageKey=${key}`
        );
        if (fault == "corrupt") {
          expected = Cr.NS_ERROR_FILE_CORRUPTED;
        }
        restore = () =>
          connection.executeSimpleSQL(
            `UPDATE offline_operations SET epoch=7101,uid=6101,sourcePhysicalKey=${sourcePhysicalKey} ` +
              `WHERE folderId=${folder.id} AND messageKey=${key}`
          );
      } else if (fault == "stale-epoch") {
        remote.uidvalidity = 7202;
        restore = () => {
          remote.uidvalidity = 7101;
        };
      } else if (fault == "collision") {
        // Another physical row now owns the same server location.
        headers[0].setUint32Property("uidOnServer", 6103);
        const collision = addPublishedFixtureHeader(
          folder,
          6101,
          "collision@example.invalid",
          messages[0].text
        );
        restore = () => {
          db.deleteMessages([collision.messageKey], null);
          headers[0].setUint32Property("uidOnServer", 6101);
        };
      } else {
        // Enumeration remains available; the immutable tuple read itself fails.
        connection.executeSimpleSQL(
          "ALTER TABLE offline_operations RENAME TO saved_offline_operations"
        );
        connection.executeSimpleSQL(
          "CREATE TEMP VIEW offline_operations AS SELECT id,revision,folderId," +
            "messageKey,operation,newFlags,folderEpoch FROM saved_offline_operations"
        );
        expected = Cr.NS_ERROR_FAILURE;
        restore = () => {
          connection.executeSimpleSQL("DROP VIEW offline_operations");
          connection.executeSimpleSQL(
            "ALTER TABLE saved_offline_operations RENAME TO offline_operations"
          );
        };
      }
      const deleted = [];
      const notifications = {
        msgsDeleted(items) {
          for (const item of items) {
            if (item.folder == folder) {
              deleted.push(item.messageKey);
            }
          }
        },
      };
      MailServices.mfn.addListener(notifications, MailServices.mfn.msgsDeleted);
      try {
        for (let i = 0; i < 2; i++) {
          await closeConnections();
          await expectSelectFailure(folder, expected);
          Assert.equal(info.getCharProperty("highestModSeq"), "10");
          Assert.equal(info.imapUidValidity, 7101);
          Assert.ok(db.containsKey(key));
          Assert.equal(storedBody(folder, headers[0]), bytes);
          Assert.deepEqual(deleted, []);
          Assert.deepEqual(
            remote._messages.map(item => item.uid),
            [6101, 6102]
          );
          Assert.deepEqual(messages[0].message.flags, []);
          Assert.equal(messages[0].message.getText(), messages[0].text);
        }
      } finally {
        restore();
        MailServices.mfn.removeListener(notifications);
      }
      try {
        Assert.deepEqual(db.listAllOfflineOpIds(), [key]);
        Assert.deepEqual(queuedIdentity(folder, key), identity);
        Assert.deepEqual(
          [op.operation, op.newFlags, op.destinationFolderURI],
          intent
        );
        await closeConnections();
        await selectFolder(folder);
        Assert.equal(info.getCharProperty("highestModSeq"), "20");
        Assert.equal(storedBody(folder, headers[0]), bytes);
        Assert.deepEqual(
          db.listAllKeys(),
          headers.map(header => header.messageKey)
        );
        Assert.ok(
          changedSince.some(
            ([name, seq]) => name == folder.onlineName && seq == "10"
          )
        );
      } finally {
        IMAPPump.incomingServer.useCondStore = false;
        modseqs.delete(folder.onlineName);
      }
    });
  }

  add_task(async function testFlagWriteErrorDoesNotAdvanceCheckpoint() {
    const { folder, db, headers } = await makePendingFolder("checkpoint-flags");
    const key = headers[0].messageKey;
    const bytes = storedBody(folder, headers[0]);
    const op = queueIntent(folder, headers[0], "move");
    const identity = queuedIdentity(folder, key);
    const info = db.dBFolderInfo;
    info.setCharProperty("highestModSeq", "10");
    info.setUint32Property("highestRecordedUID", 6102);
    modseqs.set(folder.onlineName, 20);
    IMAPPump.incomingServer.useCondStore = true;
    const connection = nativeConnection();
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER fail_reconcile_flags BEFORE UPDATE OF flags ON messages " +
        `WHEN OLD.id=${key} BEGIN SELECT RAISE(ABORT,'flag update'); END`
    );
    try {
      for (let i = 0; i < 2; i++) {
        await closeConnections();
        await expectSelectFailure(folder, Cr.NS_ERROR_STORAGE_CONSTRAINT);
        Assert.equal(info.getCharProperty("highestModSeq"), "10");
        Assert.equal(storedBody(folder, headers[0]), bytes);
        Assert.deepEqual(queuedIdentity(folder, key), identity);
        Assert.equal(
          op.operation,
          Ci.nsIMsgOfflineImapOperation.kFlagsChanged |
            Ci.nsIMsgOfflineImapOperation.kMsgMoved
        );
      }
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER fail_reconcile_flags");
    }
    try {
      await closeConnections();
      await selectFolder(folder);
      Assert.equal(info.getCharProperty("highestModSeq"), "20");
      Assert.ok(!(db.getMsgHdrForKey(key).flags & Ci.nsMsgMessageFlags.Marked));
      Assert.equal(storedBody(folder, headers[0]), bytes);
      Assert.deepEqual(queuedIdentity(folder, key), identity);
    } finally {
      IMAPPump.incomingServer.useCondStore = false;
      modseqs.delete(folder.onlineName);
    }
  });

  add_task(async function testCountResetErrorDoesNotAdvanceCheckpoint() {
    const { folder, db, headers } = await makePendingFolder("checkpoint-count");
    const info = db.dBFolderInfo;
    info.setCharProperty("highestModSeq", "10");
    info.setUint32Property("highestRecordedUID", 6102);
    folder.changePendingTotal(1);
    const bytes = storedBody(folder, headers[0]);
    const connection = nativeConnection();
    modseqs.set(folder.onlineName, 20);
    IMAPPump.incomingServer.useCondStore = true;
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER fail_pending_reset BEFORE INSERT ON folder_properties " +
        `WHEN NEW.id=${folder.id} AND NEW.name='totPendingMsgs' ` +
        "BEGIN SELECT RAISE(ABORT,'count reset'); END"
    );
    try {
      for (let i = 0; i < 2; i++) {
        await closeConnections();
        await expectSelectFailure(folder, Cr.NS_ERROR_STORAGE_CONSTRAINT);
        Assert.equal(info.getCharProperty("highestModSeq"), "10");
        Assert.equal(storedBody(folder, headers[0]), bytes);
        Assert.deepEqual(
          db.listAllKeys(),
          headers.map(header => header.messageKey)
        );
      }
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER fail_pending_reset");
    }
    try {
      await closeConnections();
      await selectFolder(folder);
      Assert.equal(info.getCharProperty("highestModSeq"), "20");
      Assert.equal(folder.numPendingTotalMessages, 0);
      Assert.ok(
        changedSince.some(
          ([name, seq]) => name == folder.onlineName && seq == "10"
        )
      );
    } finally {
      IMAPPump.incomingServer.useCondStore = false;
      modseqs.delete(folder.onlineName);
    }
  });
}

add_task(async function test_offlineFlagMasksPreserveSourceState() {
  const { folder, remote, db, headers } =
    await makePendingFolder("offline-mask-queue");
  const header = headers[0];
  const key = header.messageKey;
  const markedRead = new PromiseTestUtils.PromiseUrlListener();
  folder.storeImapFlags(0x01, true, [key], markedRead);
  await markedRead.promise;
  Assert.ok(header.flags & Ci.nsMsgMessageFlags.Read);
  const originalFlags = header.flags;
  const bytes = storedBody(folder, header);
  const seed = originalFlags & 0xffff; // imapMessageFlagsType is uint16.
  Services.io.offline = true;
  try {
    folder.storeImapFlags(0x04, true, [key], null);
    let op = db.getOfflineOpForKey(key, false);
    Assert.equal(op.operation, Ci.nsIMsgOfflineImapOperation.kFlagsChanged);
    Assert.equal(op.newFlags, seed | 0x04);
    folder.storeImapFlags(0x04, false, [key], null);
    op = db.getOfflineOpForKey(key, false);
    Assert.equal(op.newFlags, seed & ~0x04);
    folder.storeCustomKeywords(null, "keep-tag", "drop-tag", [key]);
    op = db.getOfflineOpForKey(key, false);
    Assert.equal(
      op.operation,
      Ci.nsIMsgOfflineImapOperation.kFlagsChanged |
        Ci.nsIMsgOfflineImapOperation.kAddKeywords |
        Ci.nsIMsgOfflineImapOperation.kRemoveKeywords
    );
    Assert.equal(op.newFlags, seed & ~0x04);
    Assert.equal(op.keywordsToAdd, "keep-tag");
    Assert.equal(op.keywordsToRemove, "drop-tag");
    Assert.ok(folder.flags & Ci.nsMsgFolderFlags.OfflineEvents);
    Assert.deepEqual(db.listAllOfflineOpIds(), [key]);
    Assert.equal(header.messageKey, key);
    Assert.equal(header.flags, originalFlags);
    Assert.equal(storedBody(folder, header), bytes);
    Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 7101);
    Assert.deepEqual(
      remote._messages.map(message => message.uid),
      [6101, 6102]
    );
    Assert.deepEqual(remote._messages[0].flags, ["\\Seen"]);
  } finally {
    Services.io.offline = false;
  }
});

/**
 * Checks a real persisted queue failure without queueing later keys.
 *
 * @param {number} failedIndex - Physical key whose INSERT is rejected.
 * @param {"flags"|"keywords"} [kind="flags"] - The queued operation.
 * @param {"create"|"update"|"remove"} [mutation="create"] - The rejected write.
 * @returns {Promise<void>} Resolves after checking retained state.
 */
async function checkOfflineQueueFailure(
  failedIndex,
  kind = "flags",
  mutation = "create"
) {
  const keywords = kind == "keywords";
  const updating = mutation != "create";
  const { folder, remote, db, headers } = await makePendingFolder(
    `offline-queue-${kind}-${failedIndex}-${mutation}`
  );
  const keys = headers.map(header => header.messageKey);
  const bytes = storedBody(folder, headers[0]);
  const token = headers[0].storeToken;
  const seed = headers[0].flags & 0xffff;
  Assert.deepEqual(db.listAllOfflineOpIds(), []);
  const connection = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  ).connectionForTests;
  let condition = " ";
  if (mutation == "remove") {
    condition = ` AND (NEW.operation & ${Ci.nsIMsgOfflineImapOperation.kRemoveKeywords})!=0 `;
  } else if (updating) {
    condition = " AND NEW.operation!=0 ";
  }
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_offline_flag BEFORE INSERT ON offline_operations " +
      `WHEN NEW.folderId=${folder.id} AND NEW.messageKey=${keys[failedIndex]}` +
      condition +
      "BEGIN SELECT RAISE(ABORT,'offline flag'); END"
  );
  const deleted = [];
  const listener = {
    msgsDeleted(items) {
      deleted.push(...items.filter(header => header.folder == folder));
    },
  };
  MailServices.mfn.addListener(
    listener,
    Ci.nsIMsgFolderNotificationService.msgsDeleted
  );
  Services.io.offline = true;
  try {
    Assert.throws(
      () =>
        keywords
          ? folder.storeCustomKeywords(null, "keep-tag", "drop-tag", keys)
          : folder.storeImapFlags(0x04, true, keys, null),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    const retained = failedIndex || updating ? [keys[0]] : [];
    Assert.deepEqual(db.listAllOfflineOpIds(), retained);
    if (retained.length) {
      const op = db.getOfflineOpForKey(keys[0], false);
      if (keywords) {
        let expectedOperation = 0;
        if (mutation == "create") {
          expectedOperation =
            Ci.nsIMsgOfflineImapOperation.kAddKeywords |
            Ci.nsIMsgOfflineImapOperation.kRemoveKeywords;
        } else if (mutation == "remove") {
          expectedOperation = Ci.nsIMsgOfflineImapOperation.kAddKeywords;
        }
        Assert.equal(op.operation, expectedOperation);
        Assert.equal(op.newFlags, seed);
        Assert.equal(op.keywordsToAdd, mutation == "update" ? "" : "keep-tag");
        Assert.equal(
          op.keywordsToRemove,
          mutation == "create" ? "drop-tag" : ""
        );
      } else {
        Assert.equal(
          op.operation,
          updating ? 0 : Ci.nsIMsgOfflineImapOperation.kFlagsChanged
        );
        Assert.equal(op.newFlags, updating ? seed : seed | 0x04);
      }
      Assert.ok(folder.flags & Ci.nsMsgFolderFlags.OfflineEvents);
      const statement = connection.createStatement(
        "SELECT folderId, messageKey, epoch, uid, folderEpoch " +
          "FROM offline_operations WHERE folderId=:folder AND messageKey=:key"
      );
      try {
        statement.params.folder = folder.id;
        statement.params.key = keys[0];
        Assert.ok(statement.executeStep());
        Assert.deepEqual(
          [
            statement.row.folderId,
            statement.row.messageKey,
            statement.row.epoch,
            statement.row.uid,
            statement.row.folderEpoch,
          ],
          [folder.id, keys[0], 7101, 6101, null]
        );
        Assert.ok(!statement.executeStep());
      } finally {
        statement.finalize();
      }
    } else {
      Assert.equal(folder.flags & Ci.nsMsgFolderFlags.OfflineEvents, 0);
    }
    Assert.deepEqual(db.listAllKeys(), keys);
    Assert.deepEqual(deleted, []);
    Assert.equal(headers[0].storeToken, token);
    Assert.equal(storedBody(folder, headers[0]), bytes);
    Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 7101);
    Assert.deepEqual(
      remote._messages.map(message => message.uid),
      [6101, 6102]
    );
    Assert.deepEqual(
      remote._messages.map(message => message.flags),
      [[], []]
    );
  } finally {
    Services.io.offline = false;
    MailServices.mfn.removeListener(listener);
    connection.executeSimpleSQL("DROP TRIGGER reject_offline_flag");
  }
}

if (panorama) {
  add_task(async function test_offlineFlagCreationFailureStopsAtFirstKey() {
    await checkOfflineQueueFailure(0);
  });
  add_task(
    async function test_offlineFlagCreationFailureRetainsEarlierIntent() {
      await checkOfflineQueueFailure(1);
    }
  );
  add_task(async function test_offlineFlagUpdateFailureRetainsCapturedSource() {
    await checkOfflineQueueFailure(0, "flags", "update");
  });
  add_task(async function test_offlineKeywordCreationFailureStopsAtFirstKey() {
    await checkOfflineQueueFailure(0, "keywords");
  });
  add_task(
    async function test_offlineKeywordWriteFailureRetainsCapturedSource() {
      await checkOfflineQueueFailure(0, "keywords", "update");
    }
  );
  add_task(async function test_offlineKeywordRemoveFailureRetainsEarlierAdd() {
    await checkOfflineQueueFailure(0, "keywords", "remove");
  });
}

add_task(async function endTest() {
  await releaseOfflineOpWrappers();
  teardownIMAPPump();
});
