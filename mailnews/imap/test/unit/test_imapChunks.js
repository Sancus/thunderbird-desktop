/**
 * Test bug 92111 - imap download-by-chunks doesn't download complete file if the
 * server lies about rfc822.size (known to happen for Exchange and gmail)
 */

"use strict";

const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

const { ServerTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ServerTestUtils.sys.mjs"
);

let gChunkServer;
let gChunkIncomingServer;
let gCopyChunkSource;

add_task(async function testSaveMessageToDisk() {
  const store = Services.prefs.getCharPref("mail.serverDefaultStoreContractID");
  Services.prefs.setCharPref("mail.server.default.storeContractID", store);
  const imapServer = await ServerTestUtils.createServer({ type: "imap" });

  const account = MailServices.accounts.createAccount();
  const identity = MailServices.accounts.createIdentity();
  account.addIdentity(identity);
  account.defaultIdentity = identity;

  const incomingServer = MailServices.accounts.createIncomingServer(
    "user",
    "localhost",
    "imap"
  );
  incomingServer.port = imapServer.port;
  incomingServer.password = "password";
  account.incomingServer = incomingServer;
  gChunkServer = imapServer;
  gChunkIncomingServer = incomingServer;
  const panorama = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  const databaseService = Cc[
    "@mozilla.org/msgDatabase/msgDBService;1"
  ].getService(Ci.nsIMsgDBService);
  Assert.equal(
    "nsIDatabaseCore" in Ci && databaseService instanceof Ci.nsIDatabaseCore,
    panorama
  );
  Assert.equal(
    incomingServer.msgStore.storeType,
    {
      "@mozilla.org/msgstore/berkeleystore;1": "mbox",
      "@mozilla.org/msgstore/maildirstore;1": "maildir",
    }[store]
  );
  MailServices.accounts.defaultAccount = account;

  // pref tuning: one connection only, turn off notifications
  Services.prefs.setBoolPref(
    "mail.server.server1.autosync_offline_stores",
    false
  );
  Services.prefs.setIntPref("mail.server.server1.max_cached_connections", 1);
  Services.prefs.setBoolPref("mail.biff.play_sound", false);
  Services.prefs.setBoolPref("mail.biff.show_alert", false);
  Services.prefs.setBoolPref("mail.biff.show_tray_icon", false);
  Services.prefs.setBoolPref("mail.biff.animate_dock_icon", false);

  // Crank down the message chunk size to make test cases easier
  Services.prefs.setBoolPref("mail.server.default.fetch_by_chunks", true);
  Services.prefs.setIntPref("mail.imap.chunk_size", 1000);
  Services.prefs.setIntPref("mail.imap.min_chunk_size_threshold", 1500);
  Services.prefs.setIntPref("mail.imap.chunk_add", 0);

  // Sync the folder list with server.
  {
    const listener = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.discoverAllFolders(
      incomingServer.rootFolder,
      listener,
      null
    );
    await listener.promise;
  }
  const inbox = incomingServer.rootFolder
    .getChildNamed("INBOX")
    .QueryInterface(Ci.nsIMsgImapMailFolder);

  // Load a message on the server side.
  const fileName = "bug92111";
  const originalFile = do_get_file("../../../data/" + fileName);
  const originalFileUri = Services.io
    .newFileURI(originalFile)
    .QueryInterface(Ci.nsIFileURL);

  const mailbox = imapServer.daemon.getMailbox("INBOX");
  mailbox.uidvalidity = 7301;
  const message = new ImapMessage(originalFileUri.spec, 8101, []);
  // report an artificially low size, like gmail and Exchange do
  message.setSize(originalFile.fileSize - 100);
  mailbox.addMessage(message);

  // Sync the message list.
  {
    const listener = new PromiseTestUtils.PromiseUrlListener();
    inbox.updateFolderWithListener(null, listener);
    await listener.promise;
  }

  // Sanity checks.
  Assert.equal([...inbox.messages].length, 1, "Inbox should contain 1 message");
  const msg = [...inbox.messages][0];
  const key = msg.messageKey;
  Assert.equal(inbox.msgDatabase.dBFolderInfo.imapUidValidity, 7301);
  Assert.equal(msg.messageSize, originalFile.fileSize - 100);
  Assert.equal(msg.folder, inbox);
  if (panorama) {
    Assert.notEqual(key, 8101);
    Assert.equal(msg.getUint32Property("uidOnServer"), 8101);
  } else {
    Assert.equal(key, 8101);
  }
  Assert.equal(
    msg.flags & Ci.nsMsgMessageFlags.Offline,
    0,
    "Message should not be stored offline."
  );

  // Save the message to a local file.
  const saveFile = Services.dirsvc.get("IMapMD", Ci.nsIFile);
  saveFile.append(fileName + ".eml");

  const msgUri = inbox.generateMessageURI(msg.messageKey);
  const msgService = MailServices.messageServiceFromURI(msgUri);
  const originalContent = await IOUtils.readUTF8(originalFile.path);

  // A rejected body fetch must not publish a new size or damage the source.
  const proto = IMAP_RFC3501_handler.prototype;
  const originalFetch = proto.FETCH;
  let rejected = 0;
  proto.FETCH = function (args, uid) {
    if (uid && String(args[0]) == "8101" && /BODY/i.test(String(args[1]))) {
      rejected++;
      return "NO body fetch rejected";
    }
    return originalFetch.call(this, args, uid);
  };
  const failedCalls = { starts: 0, stops: 0 };
  const failed = new PromiseTestUtils.PromiseUrlListener({
    OnStartRunningUrl() {
      failedCalls.starts++;
    },
    OnStopRunningUrl() {
      failedCalls.stops++;
    },
  });
  try {
    msgService.saveMessageToDisk(msgUri, saveFile, failed, true, null);
    const status = await failed.promise.then(
      () => Cr.NS_OK,
      error => Number(error.message)
    );
    Assert.equal(status, Cr.NS_MSG_ERROR_IMAP_COMMAND_FAILED);
    Assert.equal(rejected, 1);
    Assert.deepEqual(failedCalls, { starts: 1, stops: 1 });
    Assert.equal(msg.messageSize, originalFile.fileSize - 100);
    Assert.equal(msg.messageKey, key);
    Assert.equal(msg.flags & Ci.nsMsgMessageFlags.Offline, 0);
    Assert.equal(message.getText(), originalContent);
    if (saveFile.exists()) {
      Assert.equal(saveFile.fileSize, 0);
      saveFile.remove(false);
    }
  } finally {
    proto.FETCH = originalFetch;
  }

  // The original bug behind this test (Bug 92111) was only triggered when
  // nsMsgSaveAsListener is used. The imapService saveMessageToDisk() will take
  // that path.
  // Enforcing canonicalLineEnding (CRLF) to make sure that the
  // test also runs successfully on platforms not using CRLF by default.
  const calls = { starts: 0, stops: 0 };
  const saveListener = new PromiseTestUtils.PromiseUrlListener({
    OnStartRunningUrl() {
      calls.starts++;
    },
    OnStopRunningUrl() {
      calls.stops++;
    },
  });
  msgService.saveMessageToDisk(
    msgUri,
    saveFile,
    saveListener,
    true /* canonicalLineEnding */,
    null
  );
  await saveListener.promise;

  // File contents should not have been modified.
  const saveContent = await IOUtils.readUTF8(saveFile.path);
  Assert.equal(
    originalContent,
    saveContent,
    "Message content should be intact"
  );

  Assert.deepEqual(calls, { starts: 1, stops: 1 });
  Assert.equal(msg.messageSize, originalFile.fileSize);
  Assert.equal(msg.messageKey, key);
  Assert.equal(msg.folder, inbox);
  Assert.equal(msg.flags & Ci.nsMsgMessageFlags.Offline, 0);
  Assert.equal(message.getText(), originalContent);
  Assert.deepEqual(
    mailbox._messages.map(item => item.uid),
    [8101]
  );
  Assert.deepEqual(
    Array.from(inbox.messages, header => header.messageKey),
    [key]
  );
  Assert.equal(inbox.msgDatabase.dBFolderInfo.imapUidValidity, 7301);
  saveFile.remove(false);

  if (panorama) {
    // Finish may retain bytes even when publishing the Offline flag fails.
    const connection = databaseService.QueryInterface(
      Ci.nsIDatabaseCore
    ).connectionForTests;
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER reject_download_offline BEFORE UPDATE OF flags ON messages " +
        `WHEN OLD.id=${key} AND (NEW.flags & 128)!=0 ` +
        "BEGIN SELECT RAISE(ABORT,'offline settlement'); END"
    );
    const failedFinishCalls = { starts: 0, stops: 0 };
    const failedFinish = new PromiseTestUtils.PromiseUrlListener({
      OnStartRunningUrl() {
        failedFinishCalls.starts++;
      },
      OnStopRunningUrl() {
        failedFinishCalls.stops++;
      },
    });
    try {
      inbox.downloadAllForOffline(failedFinish, null);
      await Assert.rejects(
        failedFinish.promise,
        error => error.message == String(Cr.NS_ERROR_STORAGE_CONSTRAINT)
      );
      // Folder-level download listeners receive only the completion callback.
      Assert.deepEqual(failedFinishCalls, { starts: 0, stops: 1 });
      Assert.equal(msg.flags & Ci.nsMsgMessageFlags.Offline, 0);
      Assert.equal(msg.messageKey, key);
      Assert.equal(msg.messageSize, originalFile.fileSize);
      Assert.ok(msg.storeToken);
      const stream = inbox.msgStore.getMsgInputStream(inbox, msg.storeToken, 0);
      try {
        let retained = "";
        while (stream.available()) {
          retained += NetUtil.readInputStreamToString(
            stream,
            stream.available()
          );
        }
        Assert.ok(retained.endsWith(originalContent));
      } finally {
        stream.close();
      }
      Assert.equal(message.getText(), originalContent);
      Assert.deepEqual(
        mailbox._messages.map(item => item.uid),
        [8101]
      );
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER reject_download_offline");
    }
  }

  const stored = new PromiseTestUtils.PromiseUrlListener();
  inbox.downloadAllForOffline(stored, null);
  await stored.promise;
  Assert.ok(msg.flags & Ci.nsMsgMessageFlags.Offline);
  Assert.equal(msg.messageKey, key);
  Assert.equal(msg.messageSize, originalFile.fileSize);
  Assert.ok(msg.storeToken);
  const stream = inbox.msgStore.getMsgInputStream(inbox, msg.storeToken, 0);
  try {
    let retained = "";
    while (stream.available()) {
      retained += NetUtil.readInputStreamToString(stream, stream.available());
    }
    Assert.ok(retained.endsWith(originalContent));
  } finally {
    stream.close();
  }
  Assert.equal(message.getText(), originalContent);
  Assert.deepEqual(
    mailbox._messages.map(item => item.uid),
    [8101]
  );
});

add_task(async function test_copyNoStopsBeforeMoveDeletion() {
  await checkCopyChunkError("no-first-move", "NO", 1, true);
});

add_task(async function test_copyBadStopsLaterChunks() {
  await checkCopyChunkError("bad-first-copy", "BAD", 1, false);
});

add_task(async function test_copyLateNoReportsPartialDestination() {
  await checkCopyChunkError("no-second-copy", "NO", 2, false);
});

add_task(async function test_copyLostReplyDoesNotReplayPriorChunks() {
  await checkCopyChunkError("drop-second-copy", "DROP", 2, false);
});

add_task(async function test_copyLostFirstReplyDoesNotDeleteSource() {
  await checkCopyChunkError("drop-first-move", "DROP", 1, true);
});

add_task(async function test_copyCanRetrySelectBeforeDispatch() {
  // Select a different real mailbox so COPY must select its source. Dropping
  // this SELECT has not issued COPY and still permits the normal one retry.
  const inbox = gChunkIncomingServer.rootFolder
    .getChildNamed("INBOX")
    .QueryInterface(Ci.nsIMsgImapMailFolder);
  const selected = new PromiseTestUtils.PromiseUrlListener();
  inbox.updateFolderWithListener(null, selected);
  await selected.promise;
  const proto = IMAP_RFC3501_handler.prototype;
  const originalSelect = proto.SELECT;
  let selects = 0;
  proto.SELECT = function (args) {
    if (args[0] == "copy-chunk-source" && ++selects == 1) {
      this.closing = true;
      return "";
    }
    return originalSelect.call(this, args);
  };
  try {
    await checkCopyChunkError("select-retry", "NO", 1, false);
    Assert.equal(selects, 2, "The pre-COPY SELECT gets one transport retry");
  } finally {
    proto.SELECT = originalSelect;
  }
});

/**
 * Checks a real chunked COPY failure without deleting the source or hiding it.
 *
 * @param {string} name - Unique folder/message identity suffix.
 * @param {string} response - NO/BAD rejection, or DROP after applying the chunk.
 * @param {number} rejectedChunk - One-based chunk to reject.
 * @param {boolean} isMove - Requests the COPY/delete fallback for its error case.
 * @returns {Promise<void>}
 */
async function checkCopyChunkError(name, response, rejectedChunk, isMove) {
  const sourceName = "copy-chunk-source";
  const destinationName = `copy-${name}-destination`;
  const daemon = gChunkServer.daemon;
  let remote;
  let uids;
  let text;
  if (gCopyChunkSource) {
    ({ remote, uids, text } = gCopyChunkSource);
  } else {
    remote = daemon.createMailbox(sourceName, {
      subscribed: true,
      uidvalidity: 9301,
    });
    text = uid =>
      [
        "From: copy@example.invalid",
        "To: user@example.invalid",
        `Message-ID: <${sourceName}-${uid}@example.invalid>`,
        `Subject: Retain COPY source ${uid}`,
        "",
        `Exact ${sourceName} source body for UID ${uid}.`,
        "",
      ].join("\r\n");
    // 400 sparse five-digit UIDs require three bounded commands. Reuse this
    // real source unchanged across cases; each destination is independent.
    uids = Array.from({ length: 400 }, (value, i) => 10001 + 2 * i);
    const serverUids = [...uids, 10002].sort((a, b) => a - b);
    for (const uid of serverUids) {
      const message = new ImapMessage(
        "data:text/plain;base64," + btoa(text(uid)),
        uid,
        []
      );
      if (uid == 10002) {
        message.setFlag("Keepcopy");
      }
      remote.addMessage(message);
    }
    remote.uidnext = serverUids.at(-1) + 1;
  }
  const destination = daemon.createMailbox(destinationName, {
    subscribed: true,
    uidvalidity: 9302,
  });
  const discovered = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(
    gChunkIncomingServer.rootFolder,
    discovered,
    null
  );
  await discovered.promise;
  const panorama = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  if (!gCopyChunkSource) {
    const source = gChunkIncomingServer.rootFolder
      .getChildNamed(sourceName)
      .QueryInterface(Ci.nsIMsgImapMailFolder);
    const selected = new PromiseTestUtils.PromiseUrlListener();
    source.updateFolderWithListener(null, selected);
    await selected.promise;
    const db = source.msgDatabase;
    const keys = db.listAllKeys();
    Assert.equal(keys.length, 401);
    Assert.equal(db.dBFolderInfo.imapUidValidity, 9301);
    const downloaded = new PromiseTestUtils.PromiseUrlListener();
    source.downloadAllForOffline(downloaded, null);
    await downloaded.promise;
    const readBody = header => {
      const stream = source.getMsgInputStream(header);
      try {
        let bytes = "";
        while (stream.available()) {
          bytes += NetUtil.readInputStreamToString(stream, stream.available());
        }
        return bytes;
      } finally {
        stream.close();
      }
    };
    const originals = remote._messages.map(message => {
      const uid = message.uid;
      const header = db.getMsgHdrForMessageID(
        `${sourceName}-${uid}@example.invalid`
      );
      Assert.ok(header);
      if (panorama) {
        Assert.notEqual(header.messageKey, uid);
        Assert.equal(header.getUint32Property("uidOnServer"), uid);
      } else {
        Assert.equal(header.messageKey, uid);
      }
      Assert.ok(header.storeToken);
      const bytes = readBody(header);
      Assert.ok(
        bytes.includes(`Exact ${sourceName} source body for UID ${uid}.`)
      );
      return {
        uid,
        header,
        key: header.messageKey,
        token: header.storeToken,
        bytes,
      };
    });
    const flags = remote._messages.map(message => [...message.flags]);
    gCopyChunkSource = Object.freeze({
      source,
      remote,
      db,
      keys,
      originals,
      flags,
      uids,
      text,
      readBody,
    });
  }
  const { source, db, keys, originals, flags, readBody } = gCopyChunkSource;
  const target = gChunkIncomingServer.rootFolder.getChildNamed(destinationName);
  Assert.equal(
    source.msgStore.storeType,
    gChunkIncomingServer.msgStore.storeType
  );
  Assert.equal(target.msgStore.storeType, source.msgStore.storeType);
  Assert.equal(uids.length, 400);
  const beforeDestinationUid = destination.uidnext;
  const commands = [];
  const destructive = [];
  const proto = IMAP_RFC3501_handler.prototype;
  const originalCopy = proto.COPY;
  const originalStore = proto.STORE;
  const originalExpunge = proto.EXPUNGE;
  let reject = true;
  proto.COPY = function (args, isUid) {
    Assert.equal(this._selectedMailbox, remote);
    Assert.ok(isUid);
    Assert.equal(args[1], destinationName);
    const chunk = String(args[0]).split(",").map(Number);
    commands.push(chunk);
    if (reject && commands.length == rejectedChunk) {
      if (response == "DROP") {
        originalCopy.call(this, args, isUid);
        this.closing = true;
        return "";
      }
      return `${response} copy chunk rejected`;
    }
    return originalCopy.call(this, args, isUid);
  };
  proto.STORE = function (args, isUid) {
    if (this._selectedMailbox == remote) {
      destructive.push("STORE");
    }
    return originalStore.call(this, args, isUid);
  };
  proto.EXPUNGE = function (...args) {
    if (this._selectedMailbox == remote) {
      destructive.push("EXPUNGE");
    }
    return originalExpunge.apply(this, args);
  };
  const deleted = [];
  const notifier = {
    msgsDeleted(items) {
      deleted.push(...items.filter(item => item.folder == source));
    },
  };
  MailServices.mfn.addListener(
    notifier,
    Ci.nsIMsgFolderNotificationService.msgsDeleted
  );
  const runCopy = async move => {
    const calls = { starts: 0, stops: 0 };
    const listener = new PromiseTestUtils.PromiseUrlListener({
      OnStartRunningUrl() {
        calls.starts++;
      },
      OnStopRunningUrl() {
        calls.stops++;
      },
    });
    const out = {};
    // This public raw UID API reports protocol completion, not native staged
    // destination publication. No copyState or destination key is invented.
    MailServices.imap.onlineMessageCopy(
      source,
      uids.join(","),
      target,
      true,
      move,
      listener,
      out,
      null,
      null
    );
    const result = await listener.promise.then(
      () => Cr.NS_OK,
      error => Number(error.message)
    );
    Assert.ok(out.value);
    Assert.deepEqual(calls, { starts: 1, stops: 1 });
    return result;
  };
  const checkSource = () => {
    Assert.deepEqual(db.listAllKeys(), keys);
    Assert.equal(db.dBFolderInfo.imapUidValidity, 9301);
    Assert.equal(remote.uidvalidity, 9301);
    Assert.deepEqual(
      remote._messages.map(message => message.flags),
      flags
    );
    for (const message of remote._messages) {
      Assert.equal(message.getText(), text(message.uid));
    }
    for (const saved of originals) {
      Assert.equal(saved.header.messageKey, saved.key);
      Assert.equal(saved.header.storeToken, saved.token);
      if (panorama) {
        Assert.equal(saved.header.getUint32Property("uidOnServer"), saved.uid);
      }
      Assert.equal(readBody(saved.header), saved.bytes);
    }
    Assert.deepEqual(deleted, []);
    Assert.deepEqual(destructive, []);
  };
  try {
    const result = await runCopy(isMove);
    Assert.equal(
      result,
      response == "DROP"
        ? Cr.NS_BASE_STREAM_CLOSED
        : Cr.NS_MSG_ERROR_IMAP_COMMAND_FAILED,
      `COPY chunk sizes=${commands.map(chunk => chunk.length)}; following=${destructive}`
    );
    Assert.equal(commands.length, rejectedChunk);
    const sent = commands.flat();
    Assert.deepEqual(sent, uids.slice(0, sent.length));
    Assert.less(
      sent.length,
      uids.length,
      "The rejected chunk leaves later input unsent"
    );
    // DROP deliberately executes the chunk on the real server, then loses
    // its reply. Its effects remain ambiguous to the client, not safe to retry.
    const copied = commands
      .slice(0, rejectedChunk - (response == "DROP" ? 0 : 1))
      .flat();
    Assert.equal(destination._messages.length, copied.length);
    Assert.equal(destination.uidnext, beforeDestinationUid + copied.length);
    Assert.deepEqual(
      destination._messages.map(message => message.getText()),
      copied.map(uid => text(uid))
    );
    checkSource();
    if (rejectedChunk == 1 && response != "DROP") {
      // The observed fixture destination is empty. An explicit COPY retry is
      // safe here; do not retry the whole selection after a partial COPY.
      reject = false;
      commands.length = 0;
      const retryDestinationUid = destination.uidnext;
      Assert.equal(await runCopy(false), Cr.NS_OK);
      Assert.greater(commands.length, 2);
      Assert.deepEqual(commands.flat(), uids);
      Assert.equal(destination._messages.length, uids.length);
      Assert.deepEqual(
        destination._messages.map(message => message.uid),
        uids.map((uid, i) => retryDestinationUid + i)
      );
      Assert.deepEqual(
        destination._messages.map(message => message.getText()),
        uids.map(uid => text(uid))
      );
      checkSource();
    }
  } finally {
    proto.COPY = originalCopy;
    proto.STORE = originalStore;
    proto.EXPUNGE = originalExpunge;
    MailServices.mfn.removeListener(notifier);
  }
}

/**
 * Refuses conflicting COPYUID tuples within one real COPY completion.
 * Keeps the server effect, source and once-only callback visible on failure.
 */
add_task(async function test_copyRejectsConflictingEarlyCopyUid() {
  const { source, remote, originals, text } = gCopyChunkSource;
  const uid = originals[0].uid;
  const name = "copy-conflicting-early-uid";
  const destination = gChunkServer.daemon.createMailbox(name, {
    subscribed: true,
    uidvalidity: 9403,
  });
  const discovered = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(
    gChunkIncomingServer.rootFolder,
    discovered,
    null
  );
  await discovered.promise;
  const target = gChunkIncomingServer.rootFolder.getChildNamed(name);
  const proto = IMAP_RFC3501_handler.prototype;
  const originalCopy = proto.COPY;
  let copies = 0;
  proto.COPY = function (args, isUid) {
    if (args[1] != name) {
      return originalCopy.call(this, args, isUid);
    }
    Assert.equal(this._selectedMailbox, remote);
    Assert.ok(isUid);
    Assert.equal(String(args[0]), String(uid));
    copies++;
    const before = destination._messages.length;
    const outcome = originalCopy.call(this, args, isUid);
    Assert.ok(outcome.startsWith("OK"));
    Assert.equal(destination._messages.length, before + 1);
    const assigned = destination._messages.at(-1).uid;
    // The fake server's NUL separator emits an untagged OK, followed by the
    // tagged response for this same command. The second tuple conflicts.
    return (
      `* OK [COPYUID 9403 ${uid} ${assigned}] early mapping\0` +
      `OK [COPYUID 9403 ${uid} ${assigned + 1}] conflicting mapping`
    );
  };
  const calls = { starts: 0, stops: 0 };
  const listener = new PromiseTestUtils.PromiseUrlListener({
    OnStartRunningUrl() {
      calls.starts++;
    },
    OnStopRunningUrl() {
      calls.stops++;
    },
  });
  try {
    MailServices.imap.onlineMessageCopy(
      source,
      String(uid),
      target,
      true,
      false,
      listener,
      {},
      null,
      null
    );
    const status = await listener.promise.then(
      () => Cr.NS_OK,
      error => Number(error.message)
    );
    if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
      Assert.notEqual(status, Cr.NS_OK, "Conflicting identity is not success");
    } else {
      Assert.equal(
        status,
        Cr.NS_OK,
        "Retain the unchanged legacy raw behavior"
      );
    }
    Assert.equal(
      copies,
      1,
      "The applied command is never automatically replayed"
    );
    Assert.deepEqual(calls, { starts: 1, stops: 1 });
    Assert.equal(destination._messages.length, 1);
    Assert.equal(destination._messages[0].getText(), text(uid));
    const saved = originals[0];
    Assert.equal(saved.header.messageKey, saved.key);
    Assert.equal(saved.header.storeToken, saved.token);
    Assert.equal(gCopyChunkSource.readBody(saved.header), saved.bytes);
    Assert.equal(
      remote._messages.find(message => message.uid == uid).getText(),
      text(uid)
    );
  } finally {
    proto.COPY = originalCopy;
    // The deliberately malformed receipt poisoned this connection's parser.
    // End that case before discovery for the following independent command.
    gChunkIncomingServer.closeCachedConnections();
  }
});

add_task(async function test_onlineCopyOwnsEveryLateChunkMapping() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) return;
  const { source, originals, text, readBody } = gCopyChunkSource;
  const name = "online-late-chunk-mappings";
  const remote = gChunkServer.daemon.createMailbox(name, {
    subscribed: true,
    uidvalidity: 9405,
  });
  remote.uidnext = 970001;
  const discovered = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(
    gChunkIncomingServer.rootFolder,
    discovered,
    null
  );
  await discovered.promise;
  const target = gChunkIncomingServer.rootFolder.getChildNamed(name);
  const proto = IMAP_RFC3501_handler.prototype;
  const saved = { COPY: proto.COPY, CAPABILITY: proto.CAPABILITY };
  const actual = new Map();
  let commands = 0;
  proto.CAPABILITY = function (...args) {
    return saved.CAPABILITY.apply(this, args).replace(
      "IMAP4rev1",
      "IMAP4rev1 UIDPLUS"
    );
  };
  proto.COPY = function (args, uid) {
    if (args[1] != name) return saved.COPY.call(this, args, uid);
    const sources = this._parseSequenceSet(args[0], uid).map(
      message => message.uid
    );
    const before = remote._messages.length;
    const response = saved.COPY.call(this, args, uid);
    Assert.ok(response.startsWith("OK"));
    const destinations = remote._messages
      .slice(before)
      .map(message => message.uid);
    Assert.equal(destinations.length, sources.length);
    sources.forEach((sourceUid, i) => actual.set(sourceUid, destinations[i]));
    commands++;
    return `* OK [COPYUID 9405 ${sources.join(",")} ${destinations.join(",")}] late mapping\0OK COPY complete`;
  };
  const keys = [];
  let stops = 0;
  const listener = new PromiseTestUtils.PromiseCopyListener({
    setMessageKey(key) {
      keys.push(key);
      const header = target.msgDatabase.getMsgHdrForKey(key);
      const sourceUid = originals.find(
        item => item.header.messageId == header.messageId
      ).uid;
      Assert.equal(
        header.getUint32Property("uidOnServer"),
        actual.get(sourceUid)
      );
      Assert.notEqual(key, actual.get(sourceUid));
      const input = target.getMsgInputStream(header);
      try {
        let bytes = "";
        while (input.available())
          bytes += NetUtil.readInputStreamToString(input, input.available());
        Assert.equal(bytes, text(sourceUid));
      } finally {
        input.close();
      }
    },
    onStopCopy() {
      stops++;
    },
  });
  try {
    gChunkIncomingServer.closeCachedConnections();
    MailServices.copy.copyMessages(
      source,
      originals.map(item => item.header),
      target,
      false,
      listener,
      null,
      false
    );
    await listener.promise;
    Assert.greater(commands, 2);
    Assert.equal(actual.size, originals.length);
    Assert.equal(keys.length, originals.length);
    Assert.equal(new Set(keys).size, originals.length);
    Assert.equal(target.getTotalMessages(false), originals.length);
    Assert.equal(stops, 1);
    for (const savedSource of originals) {
      Assert.equal(savedSource.header.messageKey, savedSource.key);
      Assert.equal(savedSource.header.storeToken, savedSource.token);
      Assert.equal(readBody(savedSource.header), savedSource.bytes);
    }
  } finally {
    Object.assign(proto, saved);
    gChunkIncomingServer.closeCachedConnections();
  }
});

add_task(async function test_onlineCopyObservedUncachedPhysicalIdentity() {
  await checkUncachedOnlineCopy(false);
});

add_task(async function test_onlineMoveAmbiguityRetainsUncachedSource() {
  await checkUncachedOnlineCopy(true);
});

/**
 * Exercises ordinary no-UID COPY discovery with a genuinely uncached source.
 *
 * @param {boolean} ambiguousMove - Introduce two indistinguishable destinations.
 * @returns {Promise<void>} Resolves after the real operation and custody checks.
 */
async function checkUncachedOnlineCopy(ambiguousMove) {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) return;
  const suffix = ambiguousMove ? "ambiguous" : "unique";
  const sourceName = "uncached-source-" + suffix;
  const targetName = "uncached-target-" + suffix;
  const sourceRemote = gChunkServer.daemon.createMailbox(sourceName, {
    subscribed: true,
    uidvalidity: 9407,
  });
  const targetRemote = gChunkServer.daemon.createMailbox(targetName, {
    subscribed: true,
    uidvalidity: 9409,
  });
  targetRemote.uidnext = 980001;
  const raw = [
    "From: uncached@example.invalid",
    `Message-ID: <${suffix}@uncached-copy.invalid>`,
    "References: <root@uncached-copy.invalid>",
    "Subject: Uncached online COPY " + suffix,
    "",
    "Actual uncached source body.",
    "",
  ].join("\r\n");
  sourceRemote.addMessage(
    new ImapMessage("data:text/plain," + encodeURI(raw), 12001, [])
  );
  sourceRemote.uidnext = 12002;
  const discovered = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(
    gChunkIncomingServer.rootFolder,
    discovered,
    null
  );
  await discovered.promise;
  const source = gChunkIncomingServer.rootFolder
    .getChildNamed(sourceName)
    .QueryInterface(Ci.nsIMsgImapMailFolder);
  const target = gChunkIncomingServer.rootFolder.getChildNamed(targetName);
  const selected = new PromiseTestUtils.PromiseUrlListener();
  source.updateFolderWithListener(null, selected);
  await selected.promise;
  const header = [...source.messages][0];
  const key = header.messageKey;
  Assert.equal(header.flags & Ci.nsMsgMessageFlags.Offline, 0);
  Assert.equal(header.storeToken, "");
  const proto = IMAP_RFC3501_handler.prototype;
  const saved = {
    COPY: proto.COPY,
    CAPABILITY: proto.CAPABILITY,
    STORE: proto.STORE,
  };
  let copies = 0;
  const destructive = [];
  proto.CAPABILITY = function (...args) {
    return saved.CAPABILITY.apply(this, args).replace(/\bUIDPLUS\b/g, "");
  };
  proto.COPY = function (args, uid) {
    if (args[1] != targetName) return saved.COPY.call(this, args, uid);
    copies++;
    const response = saved.COPY.call(this, args, uid);
    Assert.ok(response.startsWith("OK"));
    if (ambiguousMove)
      targetRemote.addMessage(
        new ImapMessage(
          "data:text/plain," + encodeURI(raw),
          targetRemote.uidnext++,
          []
        )
      );
    return response.replace(/\[COPYUID [^\]]+\]/g, "");
  };
  proto.STORE = function (args, uid) {
    if (this._selectedMailbox == sourceRemote) destructive.push(args);
    return saved.STORE.call(this, args, uid);
  };
  let stops = 0;
  const listener = new PromiseTestUtils.PromiseCopyListener({
    onStopCopy() {
      stops++;
    },
  });
  try {
    gChunkIncomingServer.closeCachedConnections();
    MailServices.copy.copyMessages(
      source,
      [header],
      target,
      ambiguousMove,
      listener,
      null,
      false
    );
    const result = await listener.promise.then(
      value => value,
      error => error
    );
    if (ambiguousMove) {
      Assert.ok(result instanceof Error);
      Assert.deepEqual(
        destructive,
        [],
        "No fallback source delete without identity"
      );
      Assert.equal(target.getTotalMessages(false), 0);
      Assert.equal(targetRemote._messages.length, 2);
    } else {
      Assert.equal(result.messageKeys.length, 1);
      const copied = target.msgDatabase.getMsgHdrForKey(result.messageKeys[0]);
      Assert.notEqual(copied.messageKey, 980001);
      Assert.equal(copied.getUint32Property("uidOnServer"), 980001);
      Assert.equal(copied.flags & Ci.nsMsgMessageFlags.Offline, 0);
      Assert.equal(
        copied.storeToken,
        "",
        "Remote readback is not a fabricated offline store body"
      );
      Assert.equal(target.getTotalMessages(false), 1);
      Assert.equal(targetRemote._messages.length, 1);
    }
    Assert.equal(copies, 1);
    Assert.equal(stops, 1);
    Assert.equal(source.msgDatabase.getMsgHdrForKey(key), header);
    Assert.equal(header.storeToken, "");
    Assert.equal(header.flags & Ci.nsMsgMessageFlags.Offline, 0);
    Assert.equal(sourceRemote._messages.length, 1);
    Assert.equal(sourceRemote._messages[0].getText(), raw);
    Assert.ok(!sourceRemote._messages[0].flags.includes("\\Deleted"));
  } finally {
    Object.assign(proto, saved);
    gChunkIncomingServer.closeCachedConnections();
  }
}
