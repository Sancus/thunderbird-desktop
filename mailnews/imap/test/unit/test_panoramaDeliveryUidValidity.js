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
  const otherMailbox = daemon.createMailbox("DeliveryEpochOther", {
    subscribed: true,
    uidvalidity: 7101,
  });
  addEpochMessage(
    otherMailbox,
    5001,
    "other-folder-same-uid@example.invalid",
    "Another folder, same UID",
    "The same wire UID names another physical message in this folder."
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
  const otherFolder = rootFolder
    .getChildNamed("DeliveryEpochOther")
    .QueryInterface(Ci.nsIMsgImapMailFolder);
  PanoramaDelivery.assertFolder(otherFolder, lane);
  otherFolder.clearFlag(Ci.nsMsgFolderFlags.Offline);
  await updateEpochFolder(otherFolder);
  const otherHeader = otherFolder.msgDatabase.getMsgHdrForMessageID(
    "other-folder-same-uid@example.invalid"
  );
  Assert.ok(otherHeader, "The other folder supplies its real parsed header");
  Assert.equal(otherHeader.folder, otherFolder);
  const otherKey = otherHeader.messageKey;
  Assert.equal(otherFolder.msgDatabase.dBFolderInfo.imapUidValidity, 7101);
  Assert.equal(otherFolder.getTotalMessages(false), 1);
  info('DELIVERY_PHASE {"phase":"imap-discovery-verified"}');

  await updateEpochFolder(folder);
  Assert.equal(
    folder.msgDatabase.dBFolderInfo.imapUidValidity,
    7101,
    "The first production synchronization records the old UIDVALIDITY"
  );
  Assert.equal(folder.getTotalMessages(false), 2, "Both old messages are live");
  Assert.equal(folder.getNumUnread(false), 2, "Both old messages are unread");
  Assert.equal(
    folder.msgDatabase.dBFolderInfo.numUnreadMessages,
    2,
    "The old database counts both unread messages"
  );
  Assert.notEqual(
    folder.msgDatabase.dBFolderInfo.viewFlags,
    Ci.nsMsgViewFlagsType.kUnreadOnly,
    "The chosen view setting differs from the fixture default"
  );
  folder.msgDatabase.dBFolderInfo.viewFlags = Ci.nsMsgViewFlagsType.kUnreadOnly;
  Assert.equal(
    folder.msgDatabase.dBFolderInfo.viewFlags,
    Ci.nsMsgViewFlagsType.kUnreadOnly,
    "The old database records the folder view setting"
  );
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
  if (lane.backend == "panorama") {
    Assert.equal(oldHeader.getUint32Property("uidOnServer"), 5001);
    Assert.equal(removedHeader.getUint32Property("uidOnServer"), 5011);
    Assert.equal(otherHeader.getUint32Property("uidOnServer"), 5001);
    Assert.notEqual(
      oldKey,
      otherKey,
      "The same UID and epoch in different folders have distinct physical keys"
    );
  }
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
  Assert.equal(folder.getNumUnread(false), 1, "The new message is unread");
  Assert.equal(
    folder.msgDatabase.dBFolderInfo.numUnreadMessages,
    1,
    "The replacement database counts only the new unread message"
  );
  Assert.equal(
    folder.msgDatabase.dBFolderInfo.viewFlags,
    Ci.nsMsgViewFlagsType.kUnreadOnly,
    "UIDVALIDITY invalidation preserves the folder view setting"
  );
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
    Assert.equal(newHeader.getUint32Property("uidOnServer"), 5001);
    Assert.notEqual(
      newKey,
      otherKey,
      "The replacement epoch does not reuse the other folder's physical key"
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
  if (lane.backend == "panorama") {
    for (const [mappedFolder, key, messageId, epoch] of [
      [folder, newKey, "new-epoch-reused@example.invalid", 7202],
      [otherFolder, otherKey, "other-folder-same-uid@example.invalid", 7101],
    ]) {
      const previous = mappedFolder.msgDatabase;
      core.QueryInterface(Ci.nsIMsgDBService).forceFolderDBClosed(mappedFolder);
      const reopened = mappedFolder.msgDatabase;
      Assert.notStrictEqual(
        reopened,
        previous,
        "The folder facade is reopened"
      );
      Assert.equal(reopened.dBFolderInfo.imapUidValidity, epoch);
      const header = reopened.getMsgHdrForKey(key);
      Assert.ok(header, "The persisted physical key resolves after reopen");
      Assert.equal(header.messageId, messageId);
      Assert.equal(header.messageKey, key);
      Assert.equal(header.folder, mappedFolder);
      Assert.equal(header.getUint32Property("uidOnServer"), 5001);
      Assert.equal(
        reopened.getMsgHdrForMessageID(messageId).messageKey,
        key,
        "Public Message-ID lookup preserves the exact physical association"
      );
      const globalHeader = core.messageDB.getMessage(key);
      Assert.equal(globalHeader.folder, mappedFolder);
      Assert.equal(globalHeader.messageId, messageId);
      Assert.equal(globalHeader.getUint32Property("uidOnServer"), 5001);
      Assert.deepEqual(
        Array.from(mappedFolder.messages, item => item.messageKey),
        [key],
        "Reopened membership contains only the expected physical message"
      );
    }
  }
  info('DELIVERY_PHASE {"phase":"uidvalidity-reset-verified"}');
});

let commandFixture;

add_task(async function test_commandKeysTranslateToScopedUids() {
  const daemon = new ImapDaemon();
  const server = makeServer(daemon, "RFC2195,RFC4315");
  let account;
  let incomingServer;
  registerCleanupFunction(() => {
    try {
      incomingServer?.QueryInterface(Ci.nsIImapServerSink).abortQueuedUrls();
      incomingServer?.closeCachedConnections();
    } finally {
      server.stop();
      if (account) {
        MailServices.accounts.removeAccount(account, false);
      }
    }
  });
  account = MailServices.accounts.createAccount();
  incomingServer = MailServices.accounts
    .createIncomingServer("user", "localhost", "imap")
    .QueryInterface(Ci.nsIImapIncomingServer);
  account.incomingServer = incomingServer;
  const identity = MailServices.accounts.createIdentity();
  account.addIdentity(identity);
  account.defaultIdentity = identity;
  incomingServer.port = server.port;
  incomingServer.password = "password";
  incomingServer.maximumConnectionsNumber = 1;
  incomingServer.useIdle = false;
  incomingServer.useCondStore = false;
  incomingServer.offlineDownload = false;
  incomingServer.downloadOnBiff = false;
  incomingServer.setBoolValue("autosync_offline_stores", false);
  const root = incomingServer.rootFolder;
  const mailbox = daemon.createMailbox("CommandSource", {
    subscribed: true,
    uidvalidity: 8101,
  });
  for (const uid of [4001, 4011, 4021, 4031]) {
    addEpochMessage(
      mailbox,
      uid,
      `command-${uid}@example.invalid`,
      `Command ${uid}`,
      `Source body at UID ${uid}.`
    );
  }
  const foreignMailbox = daemon.createMailbox("CommandForeign", {
    subscribed: true,
    uidvalidity: 8101,
  });
  addEpochMessage(
    foreignMailbox,
    4001,
    "foreign-command@example.invalid",
    "Foreign command",
    "Foreign body at the same UID."
  );
  const destinationMailbox = daemon.createMailbox("CommandDestination", {
    subscribed: true,
    uidvalidity: 8202,
  });
  addEpochMessage(
    destinationMailbox,
    9001,
    "destination-sentinel@example.invalid",
    "Destination sentinel",
    "Keep the destination sentinel."
  );
  const discovery = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(root, discovery, null);
  await discovery.promise;
  const [source, foreign, destination] = [
    "CommandSource",
    "CommandForeign",
    "CommandDestination",
  ].map(name =>
    root.getChildNamed(name).QueryInterface(Ci.nsIMsgImapMailFolder)
  );
  for (const folder of [source, foreign, destination]) {
    PanoramaDelivery.assertFolder(folder, fixture.lane);
    folder.clearFlag(Ci.nsMsgFolderFlags.Offline);
    await updateEpochFolder(folder);
  }
  const headers = [4001, 4011, 4021, 4031].map(uid =>
    source.msgDatabase.getMsgHdrForMessageID(`command-${uid}@example.invalid`)
  );
  const foreignHeader = foreign.msgDatabase.getMsgHdrForMessageID(
    "foreign-command@example.invalid"
  );
  for (const [i, header] of headers.entries()) {
    Assert.equal(header.folder, source);
    Assert.equal(header.getUint32Property("uidOnServer"), 4001 + i * 10);
    Assert.notEqual(header.messageKey, 4001 + i * 10);
  }
  Assert.notEqual(headers[0].messageKey, foreignHeader.messageKey);
  commandFixture = {
    daemon,
    server,
    incomingServer,
    source,
    foreign,
    destination,
    mailbox,
    foreignMailbox,
    destinationMailbox,
    headers,
    foreignHeader,
  };

  let before = commandWire().length;
  await assertEpochBody(
    foreign,
    foreignHeader.messageKey,
    "foreign-command@example.invalid",
    "Foreign body at the same UID.\r\n"
  );
  await assertEpochBody(
    source,
    headers[1].messageKey,
    "command-4011@example.invalid",
    "Source body at UID 4011.\r\n"
  );
  await assertEpochBody(
    source,
    headers[0].messageKey,
    "command-4001@example.invalid",
    "Source body at UID 4001.\r\n"
  );
  const fetches = commandWire()
    .slice(before)
    .filter(line => / uid fetch /i.test(line));
  Assert.ok(fetches.some(line => / uid fetch 4001 /i.test(line)));
  Assert.ok(fetches.some(line => / uid fetch 4011 /i.test(line)));

  before = commandWire().length;
  const keys = [
    headers[1].messageKey,
    headers[0].messageKey,
    headers[0].messageKey,
  ];
  const flags = new PromiseTestUtils.PromiseUrlListener();
  source.storeImapFlags(0x0004 /* kImapMsgFlaggedFlag */, true, keys, flags);
  await flags.promise;
  Assert.deepEqual(
    commandWire()
      .slice(before)
      .filter(line => / uid store /i.test(line))
      .map(line => line.match(/ uid store (\S+)/i)[1]),
    ["4001,4011"]
  );
  Assert.ok(mailbox._messages[0].flags.includes("\\Flagged"));
  Assert.ok(mailbox._messages[1].flags.includes("\\Flagged"));
  Assert.ok(!mailbox._messages[2].flags.includes("\\Flagged"));
  Assert.deepEqual(foreignMailbox._messages[0].flags, []);
  await commandKeyword("scoped", "", keys);
  Assert.ok(mailbox._messages[0].flags.includes("Scoped"));
  Assert.ok(mailbox._messages[1].flags.includes("Scoped"));
  Assert.deepEqual(foreignMailbox._messages[0].flags, []);

  before = commandWire().length;
  const stops = [];
  const copy = new PromiseTestUtils.PromiseCopyListener({
    onStopCopy(status) {
      stops.push(status);
    },
  });
  MailServices.copy.copyMessages(
    source,
    [headers[1], headers[0]],
    destination,
    false,
    copy,
    null,
    false
  );
  await copy.promise;
  Assert.deepEqual(stops, [Cr.NS_OK], "COPY completes exactly once");
  Assert.deepEqual(
    commandWire()
      .slice(before)
      .filter(line => / uid copy /i.test(line))
      .map(line => line.match(/ uid copy (\S+)/i)[1]),
    ["4001,4011"]
  );
  Assert.deepEqual(
    mailbox._messages.map(message => message.uid),
    [4001, 4011, 4021, 4031]
  );
  Assert.equal(
    source.getTotalMessages(false),
    4,
    "COPY preserves source membership"
  );
  Assert.equal(destinationMailbox._messages.length, 3);
  assertEpochSource(
    destinationMailbox._messages[1].getText(),
    "command-4001@example.invalid",
    "Source body at UID 4001.\r\n"
  );
  assertEpochSource(
    destinationMailbox._messages[2].getText(),
    "command-4011@example.invalid",
    "Source body at UID 4011.\r\n"
  );
  await updateEpochFolder(destination);
  for (const header of headers.slice(0, 2)) {
    const copied = destination.msgDatabase.getMsgHdrForMessageID(
      header.messageId
    );
    Assert.equal(copied.folder, destination);
    Assert.notEqual(copied.messageKey, header.messageKey);
    Assert.greater(copied.getUint32Property("uidOnServer"), 9001);
  }

  incomingServer.deleteModel = Ci.nsMsgImapDeleteModels.IMAPDelete;
  before = commandWire().length;
  const deleted = [];
  const deletion = new PromiseTestUtils.PromiseCopyListener({
    onStopCopy(status) {
      deleted.push(status);
    },
  });
  source.deleteMessages([headers[2]], null, true, false, deletion, false);
  await deletion.promise;
  Assert.deepEqual(deleted, [Cr.NS_OK], "DELETE completes exactly once");
  Assert.deepEqual(
    commandWire()
      .slice(before)
      .filter(line => / uid store /i.test(line))
      .map(line => line.match(/ uid store (\S+)/i)[1]),
    ["4021"]
  );
  Assert.ok(mailbox._messages[2].flags.includes("\\Deleted"));
  Assert.ok(!mailbox._messages[0].flags.includes("\\Deleted"));
  Assert.ok(!mailbox._messages[1].flags.includes("\\Deleted"));
  Assert.deepEqual(foreignMailbox._messages[0].flags, []);
});

add_task(async function test_commandPreflightRejectsInvalidAndForeignKeys() {
  const { source, headers, foreignHeader } = commandFixture;
  for (const key of [0, 0xffffffff]) {
    assertCommandKeyRefused(key, Cr.NS_ERROR_INVALID_ARG);
  }
  assertCommandKeyRefused(foreignHeader.messageKey, Cr.NS_ERROR_NOT_AVAILABLE);
  assertCommandCopyRefused(foreignHeader, Cr.NS_ERROR_ILLEGAL_VALUE);

  const header = headers[1];
  const uid = header.getUint32Property("uidOnServer");
  try {
    header.setUint32Property("uidOnServer", 0);
    assertCommandKeyRefused(header.messageKey, Cr.NS_ERROR_NOT_AVAILABLE);
    assertCommandCopyRefused(header, Cr.NS_ERROR_NOT_AVAILABLE);
  } finally {
    header.setUint32Property("uidOnServer", uid);
  }
  // Remove an actual parsed physical message, retaining its original key for
  // the missing-input case. No replacement header or UID is manufactured.
  const removedKey = headers[3].messageKey;
  source.msgDatabase.deleteMessages([removedKey], null);
  assertCommandKeyRefused(removedKey, Cr.NS_ERROR_UNEXPECTED);
  await assertCommandRefusalBarrier();
});

add_task(async function test_commandPreflightRejectsStaleObservedEpoch() {
  const { source, headers } = commandFixture;
  const sink = source.QueryInterface(Ci.nsIImapMailFolderSink);
  const epoch = source.msgDatabase.dBFolderInfo.imapUidValidity;
  Assert.equal(sink.uidValidity, epoch);
  try {
    sink.uidValidity = epoch + 1;
    assertCommandKeyRefused(headers[1].messageKey, Cr.NS_ERROR_NOT_AVAILABLE);
    assertCommandCopyRefused(headers[1], Cr.NS_ERROR_NOT_AVAILABLE);
    Assert.equal(
      source.msgDatabase.dBFolderInfo.imapUidValidity,
      epoch,
      "Observing a different epoch does not persist or retire the old binding"
    );
  } finally {
    sink.uidValidity = epoch;
  }
  await assertCommandRefusalBarrier();
});

/** @returns {string[]} All real commands on the dedicated UIDPLUS server. */
function commandWire() {
  const transactions = commandFixture.server.playTransaction();
  return (Array.isArray(transactions) ? transactions : [transactions]).flatMap(
    transaction => transaction.them
  );
}

/**
 * Runs a real keyword STORE and checks URL completion exactly once.
 *
 * @param {string} add - Keywords to add.
 * @param {string} remove - Keywords to remove.
 * @param {number[]} keys - Physical source keys.
 * @returns {Promise<void>} Resolves after checked URL completion.
 */
async function commandKeyword(add, remove, keys) {
  const stops = [];
  const listener = new PromiseTestUtils.PromiseUrlListener({
    OnStopRunningUrl(url, status) {
      stops.push(status);
    },
  });
  const uri = commandFixture.source.storeCustomKeywords(
    null,
    add,
    remove,
    keys
  );
  uri.QueryInterface(Ci.nsIMsgMailNewsUrl).RegisterListener(listener);
  await listener.promise;
  Assert.deepEqual(stops, [Cr.NS_OK]);
}

/**
 * Checks synchronous key preflight, including the valid prefix of array inputs.
 *
 * @param {number} key - The rejected physical key.
 * @param {nsresult} status - The exact expected failure.
 */
function assertCommandKeyRefused(key, status) {
  const { source, headers } = commandFixture;
  const before = commandWire();
  const calls = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI([
      "nsIStreamListener",
      "nsIUrlListener",
      "nsIMsgCopyServiceListener",
    ]),
    onStartRequest() {
      calls.push("stream-start");
    },
    onDataAvailable() {
      calls.push("data");
    },
    onStopRequest() {
      calls.push("stream-stop");
    },
    OnStartRunningUrl() {
      calls.push("url-start");
    },
    OnStopRunningUrl() {
      calls.push("url-stop");
    },
    onStartCopy() {
      calls.push("copy-start");
    },
    onStopCopy() {
      calls.push("copy-stop");
    },
  };
  const uri = source.generateMessageURI(key);
  const service = MailServices.messageServiceFromURI(uri);
  for (const action of [
    () =>
      service.streamMessage(uri, listener, null, listener, false, "", false),
    () =>
      source.storeImapFlags(
        0x0004,
        true,
        [headers[0].messageKey, key],
        listener
      ),
    () =>
      source.storeCustomKeywords(null, "blocked", "", [
        headers[0].messageKey,
        key,
      ]),
  ]) {
    Assert.throws(
      action,
      error => error.result == status,
      `Physical key ${key} is refused with its original typed error`
    );
  }
  Assert.deepEqual(
    calls,
    [],
    "Synchronous refusal starts no listener or byte stream"
  );
  Assert.deepEqual(
    commandWire(),
    before,
    "No command is issued for a rejected key"
  );
}

/**
 * Checks full header-array preflight in COPY and key-array preflight in DELETE.
 *
 * @param {nsIMsgDBHdr} header - A real parsed header with a rejected association.
 * @param {nsresult} copyStatus - The actual COPY membership/translation error.
 */
function assertCommandCopyRefused(header, copyStatus) {
  const { source, destination, headers } = commandFixture;
  const before = commandWire();
  const stops = [];
  const listener = new PromiseTestUtils.PromiseCopyListener({
    onStopCopy(status) {
      stops.push(status);
    },
  });
  Assert.throws(
    () =>
      destination.copyMessages(
        source,
        [headers[0], header],
        false,
        null,
        listener,
        false,
        false
      ),
    error => error.result == copyStatus
  );
  // DELETE addresses the source database, so a foreign key fails its reverse
  // mapping rather than COPY's earlier public-header membership check.
  const deleteStatus =
    header.folder == source ? copyStatus : Cr.NS_ERROR_NOT_AVAILABLE;
  Assert.throws(
    () =>
      source.deleteMessages(
        [headers[0], header],
        null,
        true,
        false,
        listener,
        false
      ),
    error => error.result == deleteStatus
  );
  Assert.deepEqual(
    stops,
    [],
    "Preflight refusal does not report successful completion"
  );
  Assert.deepEqual(
    commandWire(),
    before,
    "No COPY or DELETE command is issued"
  );
}

/**
 * Waits behind all rejected work and checks source/destination custody.
 *
 * @returns {Promise<void>} Resolves after the checked barrier STOREs.
 */
async function assertCommandRefusalBarrier() {
  const { source, mailbox, foreignMailbox, destinationMailbox, headers } =
    commandFixture;
  const before = commandWire().length;
  const snapshot = [mailbox, foreignMailbox, destinationMailbox].map(box =>
    box._messages.map(message => [
      message.uid,
      [...message.flags],
      message.getText(),
    ])
  );
  const keys = source.msgDatabase.listAllKeys();
  await commandKeyword("barrier", "", [headers[0].messageKey]);
  await commandKeyword("", "barrier", [headers[0].messageKey]);
  Assert.deepEqual(
    commandWire()
      .slice(before)
      .filter(line => / uid (?:fetch|store|copy|move|expunge) /i.test(line))
      .map(line =>
        line
          .match(/ uid store (\S+) ([+-]FLAGS)(?:\.SILENT)? \(([^)]*)\)/i)
          .slice(1)
      ),
    [
      ["4001", "+FLAGS", "barrier"],
      ["4001", "-FLAGS", "barrier"],
    ],
    "Only the two explicit barrier STOREs reach the server"
  );
  Assert.deepEqual(
    [mailbox, foreignMailbox, destinationMailbox].map(box =>
      box._messages.map(message => [
        message.uid,
        [...message.flags],
        message.getText(),
      ])
    ),
    snapshot,
    "Rejected work preserves every server UID, flag and body"
  );
  Assert.deepEqual(
    source.msgDatabase.listAllKeys(),
    keys,
    "Rejected work preserves physical source membership"
  );
}

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
