/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_server.js */

let fault;
let appendObserver;
let commands = [];
let refusals = 0;

add_setup(async function setupFolderCopyFailures() {
  const contract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  Services.prefs.setCharPref("mail.server.default.storeContractID", contract);
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );

  // Install before UIDPLUS captures the base APPEND method on a connection.
  const proto = IMAP_RFC3501_handler.prototype;
  const originalCreate = proto.CREATE;
  const originalAppend = proto.APPEND;
  registerCleanupFunction(() => {
    proto.CREATE = originalCreate;
    proto.APPEND = originalAppend;
    if (IMAPPump.incomingServer) {
      teardownIMAPPump();
    }
  });
  proto.CREATE = function (args) {
    commands.push(["CREATE", args[0]]);
    if (fault?.command == "CREATE" && args[0] == fault.mailbox) {
      refusals++;
      return "NO refused subtree CREATE";
    }
    return originalCreate.call(this, args);
  };
  proto.APPEND = function (args) {
    commands.push(["APPEND", args[0]]);
    if (fault?.command == "APPEND" && args[0] == fault.mailbox) {
      refusals++;
      return "NO refused subtree APPEND";
    }
    const result = originalAppend.call(this, args);
    appendObserver?.(this, args, result);
    return result;
  };

  setupIMAPPump("RFC2195,RFC4315");
  const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.equal(
    "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
    native
  );
  const type = {
    "@mozilla.org/msgstore/berkeleystore;1": "mbox",
    "@mozilla.org/msgstore/maildirstore;1": "maildir",
  }[contract];
  Assert.ok(type);
  Assert.equal(IMAPPump.incomingServer.msgStore.storeType, type);
  Assert.equal(localAccountUtils.rootFolder.msgStore.storeType, type);
  const discovered = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(
    IMAPPump.incomingServer.rootFolder,
    discovered,
    null
  );
  await discovered.promise;
  const inbox = IMAPPump.incomingServer.rootFolder.getChildNamed("INBOX");
  Assert.equal(inbox.parent, IMAPPump.incomingServer.rootFolder);
  Assert.equal(inbox.server, IMAPPump.incomingServer);
  IMAPPump.inbox = inbox.QueryInterface(Ci.nsIMsgImapMailFolder);
});

/**
 * Reads every stored byte in a single-message source folder.
 *
 * @param {nsIMsgFolder} folder - The actual source folder, containing one message.
 * @param {nsIMsgDBHdr} header - The original header with its captured store token.
 * @returns {string} Complete physical bytes, including store metadata.
 */
function readStoredSource(folder, header) {
  const stream = folder.msgStore.getMsgInputStream(
    folder,
    header.storeToken,
    0
  );
  const reader = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
    Ci.nsIScriptableInputStream
  );
  reader.init(stream);
  let bytes = "";
  try {
    for (let chunk = reader.read(4096); chunk; chunk = reader.read(4096)) {
      bytes += chunk;
    }
  } finally {
    reader.close();
  }
  return bytes;
}

/**
 * Streams one complete cached destination through its ordinary message service.
 *
 * @param {nsIMsgFolder} folder - The actual destination folder.
 * @param {nsIMsgDBHdr} header - Its published destination header.
 * @returns {Promise<string>} The complete streamed message.
 */
async function readCachedMessage(folder, header) {
  const uri = folder.getUriForMsg(header);
  const listener = new PromiseTestUtils.PromiseStreamListener();
  MailServices.messageServiceFromURI(uri).streamMessage(
    uri,
    listener,
    null,
    null,
    false,
    "",
    true
  );
  return listener.promise;
}

/**
 * Records the exact original local message before a server-side refusal.
 *
 * @param {nsIMsgFolder} folder - The actual source folder.
 * @param {string} label - A distinct message identity and body.
 * @returns {object} The original physical key, metadata and stored bytes.
 */
function addOriginal(folder, label) {
  const raw =
    "From: sender@example.invalid\r\n" +
    "To: recipient@example.invalid\r\n" +
    `Message-ID: <${label}@example.invalid>\r\n` +
    `Subject: ${label}\r\n` +
    "References: <first@example.invalid> <second@example.invalid>\r\n" +
    `\r\nExact subtree body ${label}.\r\n`;
  const header = folder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .addMessage(raw);
  header.setStringProperty("subtreeSource", label);
  return {
    key: header.messageKey,
    token: header.storeToken,
    flags: header.flags,
    size: header.messageSize,
    label,
    body: raw.slice(raw.indexOf("\r\n\r\n") + 4),
    bytes: readStoredSource(folder, header),
  };
}

/**
 * Requires the failed operation to preserve its actual source message.
 *
 * @param {nsIMsgFolder} folder - The original source folder.
 * @param {object} original - The captured source identity and bytes.
 */
function assertOriginal(folder, original) {
  Assert.deepEqual(folder.msgDatabase.listAllKeys(), [original.key]);
  const header = folder.msgDatabase.getMsgHdrForKey(original.key);
  Assert.equal(header.folder, folder);
  Assert.equal(header.storeToken, original.token);
  Assert.equal(header.flags, original.flags);
  Assert.equal(header.messageSize, original.size);
  Assert.equal(header.getStringProperty("subtreeSource"), original.label);
  Assert.equal(readStoredSource(folder, header), original.bytes);
}

/**
 * Fails a real subtree command, then retries the same queued folder operation.
 *
 * @param {"create-root"|"create-child"|"append-child"} phase - The refused command.
 */
async function checkSubtreeFailure(phase) {
  const localRoot = localAccountUtils.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const source = localRoot
    .createLocalSubfolder("subtree-" + phase)
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const first = source.createLocalSubfolder("a-finished");
  const failed = source.createLocalSubfolder("b-refused");
  const later = source.createLocalSubfolder("c-later");
  const rootMessage =
    phase == "append-child" ? null : addOriginal(source, phase + "-root");
  const firstMessage = addOriginal(first, phase + "-first");
  const failedMessage = addOriginal(failed, phase + "-failed");
  const laterMessage = addOriginal(later, phase + "-later");
  const path = "INBOX/" + source.name;
  fault = {
    command: phase == "append-child" ? "APPEND" : "CREATE",
    mailbox: phase == "create-root" ? path : path + "/b-refused",
  };
  commands = [];
  refusals = 0;
  const stops = [];
  const listener = new PromiseTestUtils.PromiseCopyListener({
    onStopCopy(status) {
      stops.push(status);
    },
  });
  const result = listener.promise.then(
    () => Cr.NS_OK,
    error => Number(error.message)
  );
  MailServices.copy.copyFolder(source, IMAPPump.inbox, false, listener, null);
  try {
    Assert.equal(await result, Cr.NS_MSG_ERROR_IMAP_COMMAND_FAILED);
    Assert.deepEqual(stops, [Cr.NS_MSG_ERROR_IMAP_COMMAND_FAILED]);
    Assert.equal(refusals, 1, "The actual intended command was rejected");
    Assert.equal(source.parent, localRoot);
    for (const folder of [first, failed, later]) {
      Assert.equal(folder.parent, source);
    }
    Assert.ok(!commands.some(([, name]) => name == path + "/c-later"));
    Assert.equal(IMAPPump.daemon.getMailbox(path + "/c-later"), null);
    assertOriginal(first, firstMessage);
    assertOriginal(failed, failedMessage);
    assertOriginal(later, laterMessage);
    if (rootMessage) {
      assertOriginal(source, rootMessage);
    } else {
      Assert.deepEqual(source.msgDatabase.listAllKeys(), []);
    }
    if (phase == "create-root") {
      Assert.equal(IMAPPump.daemon.getMailbox(path), null);
    } else {
      if (rootMessage) {
        const messages = IMAPPump.daemon.getMailbox(path)._messages;
        Assert.equal(messages.length, 1);
        Assert.ok(messages[0].getText().endsWith(rootMessage.body));
      }
      const messages = IMAPPump.daemon.getMailbox(
        path + "/a-finished"
      )._messages;
      Assert.equal(messages.length, 1);
      Assert.ok(messages[0].getText().endsWith(firstMessage.body));
      if (phase == "append-child") {
        Assert.equal(
          IMAPPump.daemon.getMailbox(path + "/b-refused")._messages.length,
          0
        );
      } else {
        Assert.equal(IMAPPump.daemon.getMailbox(path + "/b-refused"), null);
      }
    }
  } finally {
    fault = null;
  }

  // CopyService serializes folder requests by the same name and destination.
  // A differently named retry would not expose a leaked original request.
  const retryStops = [];
  const retry = new PromiseTestUtils.PromiseCopyListener({
    onStopCopy(status) {
      retryStops.push(status);
    },
  });
  MailServices.copy.copyFolder(source, IMAPPump.inbox, false, retry, null);
  await retry.promise;
  Assert.deepEqual(retryStops, [Cr.NS_OK]);
  Assert.deepEqual(stops, [Cr.NS_MSG_ERROR_IMAP_COMMAND_FAILED]);
  for (const [leaf, original, count] of [
    ["a-finished", firstMessage, phase == "create-root" ? 1 : 2],
    ["b-refused", failedMessage, 1],
    ["c-later", laterMessage, 1],
  ]) {
    const messages = IMAPPump.daemon.getMailbox(path + "/" + leaf)._messages;
    Assert.equal(messages.length, count);
    for (const message of messages) {
      Assert.ok(message.getText().endsWith(original.body));
    }
    assertOriginal(source.getChildNamed(leaf), original);
  }
}

add_task(async function test_childCreateFailureDoesNotFinishRootEarly() {
  await checkSubtreeFailure("create-child");
});

add_task(async function test_rootCreateFailureReleasesCopyRequest() {
  await checkSubtreeFailure("create-root");
});

add_task(async function test_childAppendFailureReleasesCopyRequest() {
  await checkSubtreeFailure("append-child");
});

/**
 * Moves an actual streamed IMAP source and checks terminal source confirmation.
 *
 * @param {boolean} folderMove - Whether the outer request copies a subtree.
 * @param {"ack"|"refuse"|"epoch"} outcome - The source retirement outcome.
 */
async function checkNativeStreamMove(folderMove, outcome) {
  const label = `${folderMove ? "folder" : "message"}-${outcome}`;
  const daemon = new ImapDaemon();
  Assert.ok(daemon.createMailbox("INBOX/source-" + label));
  const mailbox = daemon.getMailbox("INBOX/source-" + label);
  mailbox.subscribed = true;
  Assert.ok(daemon.createMailbox("Trash"));
  daemon.getMailbox("Trash").subscribed = true;
  const raw =
    "From: sender@example.invalid\r\n" +
    `Message-ID: <stream-${label}@example.invalid>\r\n` +
    "References: <stream-first@example.invalid> <stream-second@example.invalid>\r\n" +
    "X-Priority: 2\r\n" +
    `Subject: Stream ${label}\r\n\r\nRetain exact streamed body ${label}.\r\n`;
  const message = new ImapMessage(
    "data:text/plain;base64," + btoa(raw),
    7001,
    []
  );
  mailbox.addMessage(message);
  mailbox.uidnext = 7002;
  const username = "source-" + label;
  const server = makeServer(daemon, "RFC2195,RFC4315", {
    kUsername: username,
  });
  let incoming;
  let account;
  let cleaned = false;
  const proto = IMAP_RFC3501_handler.prototype;
  const originalStore = proto.STORE;
  function cleanup() {
    if (cleaned) {
      return;
    }
    cleaned = true;
    proto.STORE = originalStore;
    appendObserver = null;
    incoming?.closeCachedConnections();
    if (account) {
      MailServices.accounts.removeAccount(account, true);
    }
    server.stop();
  }
  registerCleanupFunction(cleanup);
  try {
    const created = localAccountUtils.create_incoming_server_and_account(
      "imap",
      server.port,
      username,
      "password"
    );
    incoming = created.server.QueryInterface(Ci.nsIImapIncomingServer);
    account = created.account;
    account.addIdentity(MailServices.accounts.createIdentity());
    Assert.equal(
      incoming.msgStore.storeType,
      IMAPPump.incomingServer.msgStore.storeType
    );
    incoming.performExpand(null);
    let listener = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.discoverAllFolders(incoming.rootFolder, listener, null);
    await listener.promise;
    const trash = incoming.rootFolder.getChildNamed("Trash");
    Assert.ok(trash);
    Assert.equal(trash.server, incoming);
    incoming.deleteModel = Ci.nsMsgImapDeleteModels.MoveToTrash;
    Assert.equal(incoming.deleteModel, Ci.nsMsgImapDeleteModels.MoveToTrash);
    const source = incoming.rootFolder
      .getChildNamed("INBOX")
      .getChildNamed("source-" + label)
      .QueryInterface(Ci.nsIMsgImapMailFolder);
    Assert.equal(source.server, incoming);
    Assert.notEqual(source.server, IMAPPump.incomingServer);
    listener = new PromiseTestUtils.PromiseUrlListener();
    source.updateFolderWithListener(null, listener);
    await listener.promise;
    listener = new PromiseTestUtils.PromiseUrlListener();
    source.downloadAllForOffline(listener, null);
    await listener.promise;
    const db = source.msgDatabase;
    const header = db.getMsgHdrForMessageID(`stream-${label}@example.invalid`);
    Assert.ok(header);
    Assert.notEqual(header.messageKey, 7001);
    Assert.equal(header.getUint32Property("uidOnServer"), 7001);
    const original = {
      key: header.messageKey,
      token: header.storeToken,
      flags: header.flags,
      size: header.messageSize,
      priority: header.priority,
      references: Array.from({ length: header.numReferences }, (_, i) =>
        header.getStringReference(i)
      ),
      bytes: readStoredSource(source, header),
    };
    Assert.ok(original.token);
    Assert.ok(
      original.bytes.includes(raw),
      "The full original source is stored"
    );
    const destinationPath = folderMove ? "INBOX/source-" + label : "INBOX";
    let sourceCommands = 0;
    const stops = [];
    proto.STORE = function (args, uid) {
      if (this._daemon == daemon && String(args).includes("\\Deleted")) {
        Assert.ok(uid, "Retirement addresses literal server UIDs");
        sourceCommands++;
        Assert.equal(stops.length, 0, "Source launch is not public completion");
        Assert.ok(db.containsKey(original.key));
        const destination = IMAPPump.daemon.getMailbox(destinationPath);
        const copied = destination._messages.find(item =>
          item.getText().includes(`<stream-${label}@example.invalid>`)
        );
        Assert.ok(copied, "Destination finished before source retirement");
        Assert.ok(
          copied.getText().endsWith(raw.slice(raw.indexOf("\r\n\r\n") + 4))
        );
        if (outcome == "refuse") {
          return "NO refused source retirement";
        }
      }
      return originalStore.call(this, args, uid);
    };
    let changedEpoch = false;
    appendObserver = handler => {
      if (handler._daemon == IMAPPump.daemon && outcome == "epoch") {
        Assert.ok(!changedEpoch);
        changedEpoch = true;
        db.dBFolderInfo.imapUidValidity++;
      }
    };
    const membershipAtStop = [];
    const copy = new PromiseTestUtils.PromiseCopyListener({
      onStopCopy(status) {
        stops.push(status);
        membershipAtStop.push(db.containsKey(original.key));
      },
    });
    const completion = copy.promise.then(
      () => Cr.NS_OK,
      error => Number(error.message)
    );
    if (folderMove) {
      MailServices.copy.copyFolder(source, IMAPPump.inbox, true, copy, null);
    } else {
      MailServices.copy.copyMessages(
        source,
        [header],
        IMAPPump.inbox,
        true,
        copy,
        null,
        false
      );
    }
    let expected = Cr.NS_OK;
    if (outcome == "refuse") {
      expected = Cr.NS_MSG_ERROR_IMAP_COMMAND_FAILED;
    } else if (outcome == "epoch") {
      expected = Cr.NS_ERROR_NOT_AVAILABLE;
    }
    Assert.equal(await completion, expected);
    Assert.deepEqual(stops, [expected]);
    Assert.deepEqual(membershipAtStop, [outcome != "ack"]);
    Assert.equal(sourceCommands, outcome == "epoch" ? 0 : 1);
    Assert.equal(changedEpoch, outcome == "epoch");
    Assert.equal(message.flags.includes("\\Deleted"), outcome == "ack");
    Assert.equal(message.getText(), raw);
    Assert.deepEqual(db.listAllKeys(), outcome == "ack" ? [] : [original.key]);
    Assert.equal(source.getTotalMessages(false), outcome == "ack" ? 0 : 1);
    if (outcome != "ack") {
      Assert.equal(header.storeToken, original.token);
      Assert.equal(header.flags, original.flags);
      Assert.equal(header.messageSize, original.size);
      Assert.equal(header.priority, original.priority);
      Assert.deepEqual(
        Array.from({ length: header.numReferences }, (_, i) =>
          header.getStringReference(i)
        ),
        original.references
      );
      Assert.equal(readStoredSource(source, header), original.bytes);
    }
    Assert.equal(source.parent, incoming.rootFolder.getChildNamed("INBOX"));
    const destination = (
      folderMove
        ? IMAPPump.inbox.getChildNamed("source-" + label)
        : IMAPPump.inbox
    ).QueryInterface(Ci.nsIMsgImapMailFolder);
    listener = new PromiseTestUtils.PromiseUrlListener();
    destination.updateFolderWithListener(null, listener);
    await listener.promise;
    const destinationHeader = destination.msgDatabase.getMsgHdrForMessageID(
      `stream-${label}@example.invalid`
    );
    Assert.ok(destinationHeader);
    Assert.equal(destinationHeader.folder, destination);
    Assert.deepEqual(
      Array.from({ length: destinationHeader.numReferences }, (_, i) =>
        destinationHeader.getStringReference(i)
      ),
      ["stream-first@example.invalid", "stream-second@example.invalid"]
    );
    listener = new PromiseTestUtils.PromiseUrlListener();
    destination.downloadAllForOffline(listener, null);
    await listener.promise;
    Assert.ok(destinationHeader.storeToken);
    Assert.ok(
      (await readCachedMessage(destination, destinationHeader)).endsWith(
        raw.slice(raw.indexOf("\r\n\r\n") + 4)
      )
    );
    Assert.deepEqual(stops, [expected]);
  } finally {
    cleanup();
  }
}

if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_fileReplacementKeepsFileCompletion() {
    const file = do_get_file("../../../data/bugmail1");
    const mailbox = IMAPPump.daemon.getMailbox("INBOX");
    Assert.equal(mailbox._messages.length, 0);
    const first = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyFileMessage(
      file,
      IMAPPump.inbox,
      null,
      false,
      0,
      "",
      first,
      null
    );
    await first.promise;
    const update = new PromiseTestUtils.PromiseUrlListener();
    IMAPPump.inbox.updateFolderWithListener(null, update);
    await update.promise;
    Assert.equal(mailbox._messages.length, 1);
    const original = mailbox._messages[0];
    const text = original.getText();
    const header = IMAPPump.inbox.msgDatabase.getMsgHdrForKey(original.uid);
    Assert.ok(header);
    Assert.equal(header.messageKey, original.uid, "Mork retains UID-as-key");
    let starts = 0;
    const stops = [];
    const replacement = new PromiseTestUtils.PromiseCopyListener({
      onStartCopy() {
        starts++;
      },
      onStopCopy(status) {
        stops.push(status);
      },
    });
    MailServices.copy.copyFileMessage(
      file,
      IMAPPump.inbox,
      header,
      false,
      0,
      "",
      replacement,
      null
    );
    await replacement.promise;
    Assert.equal(starts, 1);
    Assert.deepEqual(stops, [Cr.NS_OK]);
    Assert.equal(mailbox._messages.length, 2);
    Assert.notEqual(mailbox._messages[1].uid, original.uid);
    Assert.equal(original.getText(), text);
    Assert.equal(
      mailbox._messages[1].getText(),
      text,
      "The file replacement retains the complete original bytes"
    );
  });
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_nativeStreamMessageMoveWaitsForSourceAck() {
    await checkNativeStreamMove(false, "ack");
  });
  add_task(async function test_nativeStreamMessageMoveRetainsRefusedSource() {
    await checkNativeStreamMove(false, "refuse");
  });
  add_task(async function test_nativeStreamFolderMoveWaitsForSourceAck() {
    await checkNativeStreamMove(true, "ack");
  });
  add_task(async function test_nativeStreamFolderMoveRetainsRefusedSource() {
    await checkNativeStreamMove(true, "refuse");
  });
  add_task(async function test_nativeStreamMoveRejectsChangedSourceEpoch() {
    await checkNativeStreamMove(false, "epoch");
  });
}
