/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Test to ensure that changes made while offline are played back when we
 * go back online.
 */

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

var { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);

var gSecondFolder, gThirdFolder;
var gSynthMessage1, gSynthMessage2;
// the message id of bugmail10
var gMsgId1 = "200806061706.m56H6RWT004933@mrapp54.mozilla.org";
var gOfflineManager;
var gOfflineAppendKeys;

add_task(async function test_nativeOrderedCopiesAndMoveUseMatchedReceipts() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    return;
  }
  Services.prefs.setCharPref(
    "mail.server.default.storeContractID",
    Services.prefs.getCharPref("mail.serverDefaultStoreContractID")
  );
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
  setupIMAPPump("RFC2195,RFC4315");
  IMAPPump.server.setDebugLevel(nsMailServer.debugAll);
  const wasOffline = Services.io.offline;
  try {
    const names = ["OrderedCopyOne", "OrderedCopyTwo", "OrderedMove"];
    for (const name of names) {
      IMAPPump.daemon.createMailbox(name, {
        subscribed: true,
        uidvalidity: IMAPPump.daemon.uidvalidity++,
      });
    }
    const sourceUid = 900001;
    const uri = Services.io.newFileURI(do_get_file("../../../data/bugmail10"));
    IMAPPump.mailbox.addMessage(
      new ImapMessage(uri.spec, sourceUid, { "\\Draft": true, "\\Seen": true })
    );
    const root = IMAPPump.incomingServer.rootFolder;
    const discovery = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.discoverAllFolders(root, discovery, null);
    await discovery.promise;
    const source = root
      .getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox)
      .QueryInterface(Ci.nsIMsgImapMailFolder);
    const selected = new PromiseTestUtils.PromiseUrlListener();
    source.updateFolderWithListener(null, selected);
    await selected.promise;
    const downloaded = new PromiseTestUtils.PromiseUrlListener();
    source.downloadAllForOffline(downloaded, null);
    await downloaded.promise;
    const original = Array.from(source.msgDatabase.enumerateMessages()).find(
      header => header.getUint32Property("uidOnServer") == sourceUid
    );
    Assert.ok(original);
    const oldKey = original.messageKey;
    Assert.notEqual(oldKey, sourceUid);
    Assert.ok(original.flags & Ci.nsMsgMessageFlags.Offline);
    const targets = names.map(name => root.getChildNamed(name));
    const physicalKeys = [];
    IMAPPump.incomingServer.closeCachedConnections();
    Services.io.offline = true;
    source.markMessagesFlagged([original], true);
    source.markMessagesRead([original], false);
    for (let i = 0; i < targets.length; ++i) {
      const listener = new PromiseTestUtils.PromiseCopyListener();
      MailServices.copy.copyMessages(
        source,
        [original],
        targets[i],
        i == 2,
        listener,
        null,
        true
      );
      const result = await listener.promise;
      Assert.equal(result.messageKeys.length, 1);
      physicalKeys.push(result.messageKeys[0]);
      const queued = targets[i].msgDatabase.getMsgHdrForKey(physicalKeys[i]);
      Assert.ok(queued);
      Assert.ok(!queued.properties.includes("uidOnServer"));
      Assert.ok(queued.flags & Ci.nsMsgMessageFlags.Offline);
    }
    Assert.equal(source.msgDatabase.containsKey(oldKey), false);
    const operations = source.msgDatabase.QueryInterface(
      Ci.nsIMsgOfflineOpsDatabase
    );
    let operation = operations.getOfflineOpForKey(oldKey, false);
    Assert.ok(operation);
    Assert.equal(operation.srcUid, sourceUid);
    Assert.equal(operation.getCopyDestination(0), targets[0].URI);
    Assert.equal(operation.getCopyDestination(1), targets[1].URI);
    Assert.equal(operation.destinationFolderURI, targets[2].URI);
    Services.io.offline = false;
    const replayed = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.playbackAllOfflineOperations(null, replayed);
    await replayed.promise;
    for (let i = 0; i < targets.length; ++i) {
      const mailbox = IMAPPump.daemon.getMailbox(names[i]);
      Assert.equal(mailbox._messages.length, 1);
      Assert.ok(mailbox._messages[0].flags.includes("\\Flagged"));
      Assert.ok(mailbox._messages[0].flags.includes("\\Draft"));
      Assert.ok(!mailbox._messages[0].flags.includes("\\Seen"));
      Assert.ok(!mailbox._messages[0].flags.includes("$Mdnsent"));
      const header = targets[i].msgDatabase.getMsgHdrForKey(physicalKeys[i]);
      Assert.equal(header.messageKey, physicalKeys[i]);
      Assert.equal(header.folder, targets[i]);
      Assert.ok(header.properties.includes("uidOnServer"));
      Assert.equal(
        header.getUint32Property("uidOnServer"),
        mailbox._messages[0].uid
      );
      Assert.notEqual(header.messageKey, mailbox._messages[0].uid);
      Assert.ok(header.storeToken);
    }
    Assert.ok(
      !IMAPPump.mailbox._messages.some(
        message =>
          message.uid == sourceUid && !message.flags.includes("\\Deleted")
      )
    );
    operation = operations.getOfflineOpForKey(oldKey, false);
    Assert.equal(operation, null, "All selected actions settled exactly once");
    const repeated = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.playbackAllOfflineOperations(null, repeated);
    await repeated.promise;
    for (let i = 0; i < targets.length; ++i) {
      Assert.equal(IMAPPump.daemon.getMailbox(names[i])._messages.length, 1);
      Assert.equal(
        targets[i].msgDatabase.getMsgHdrForKey(physicalKeys[i]).messageKey,
        physicalKeys[i]
      );
    }
  } finally {
    Services.io.offline = wasOffline;
    MailServices.txns.transactionManager.clear();
    teardownIMAPPump();
  }
});

add_task(async function test_nativeOnlineMoveSettlesBothSources() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    return;
  }
  Assert.ok(!Services.io.offline, "The undoable MOVE starts online");
  const expungePref = "mail.imap.expunge_after_delete";
  const hadExpungePref = Services.prefs.prefHasUserValue(expungePref);
  const previousExpunge = Services.prefs.getBoolPref(expungePref, false);
  const originalCopy = IMAP_RFC3501_handler.prototype.COPY;
  const originalStore = IMAP_RFC3501_handler.prototype.STORE;
  const originalUid = IMAP_RFC4315_extension.UID;
  const copies = [];
  const stores = [];
  const expunges = [];
  IMAP_RFC3501_handler.prototype.COPY = function (args, uid) {
    if (uid) {
      copies.push(String(args[0]));
    }
    return originalCopy.call(this, args, uid);
  };
  IMAP_RFC3501_handler.prototype.STORE = function (args, uid) {
    if (uid && args[1].startsWith("+") && args[2].includes("\\Deleted")) {
      stores.push(String(args[0]));
    }
    return originalStore.call(this, args, uid);
  };
  IMAP_RFC4315_extension.UID = function (args) {
    if (args[0] == "EXPUNGE") {
      expunges.push(String(args[1]));
    }
    return originalUid.call(this, args);
  };
  Services.prefs.setBoolPref(expungePref, true);
  setupIMAPPump("RFC2195,RFC4315");
  try {
    IMAPPump.daemon.createMailbox("OnlineMove", {
      subscribed: true,
      uidvalidity: IMAPPump.daemon.uidvalidity++,
    });
    const sourceUids = [94001, 94002];
    const uri = Services.io.newFileURI(do_get_file("../../../data/bugmail10"));
    for (const uid of sourceUids) {
      IMAPPump.mailbox.addMessage(new ImapMessage(uri.spec, uid, []));
    }
    const root = IMAPPump.incomingServer.rootFolder;
    const discovery = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.discoverAllFolders(root, discovery, null);
    await discovery.promise;
    const source = root
      .getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox)
      .QueryInterface(Ci.nsIMsgImapMailFolder);
    const destination = root.getChildNamed("OnlineMove");
    const selected = new PromiseTestUtils.PromiseUrlListener();
    source.updateFolderWithListener(null, selected);
    await selected.promise;
    const downloaded = new PromiseTestUtils.PromiseUrlListener();
    source.downloadAllForOffline(downloaded, null);
    await downloaded.promise;
    const headers = sourceUids.map(uid =>
      Array.from(source.msgDatabase.enumerateMessages()).find(
        header => header.getUint32Property("uidOnServer") == uid
      )
    );
    Assert.ok(headers.every(Boolean));
    const sourceKeys = headers.map(header => header.messageKey);
    const copied = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyMessages(
      source,
      headers,
      destination,
      true,
      copied,
      null,
      true
    );
    const result = await copied.promise;
    Assert.equal(result.messageKeys.length, 2);
    const destinationKeys = [...result.messageKeys];
    const operations = source.msgDatabase.QueryInterface(
      Ci.nsIMsgOfflineOpsDatabase
    );
    // The copy listener reports local staging. The normal online timer owns
    // server playback; do not substitute playbackAllOfflineOperations here.
    await TestUtils.waitForCondition(
      () => sourceKeys.every(key => !operations.getOfflineOpForKey(key, false)),
      "Online playback settles both queued MOVE operations"
    );
    Assert.ok(!Services.io.offline, "The MOVE never went offline");
    Assert.deepEqual(copies, sourceUids.map(String), "One UID COPY per source");
    Assert.deepEqual(stores, sourceUids.map(String), "Each source is deleted");
    Assert.deepEqual(expunges, sourceUids.map(String), "Each UID is expunged");
    Assert.equal(IMAPPump.mailbox._messages.length, 0);
    Assert.deepEqual(operations.listAllOfflineOpIds(), []);
    const mailbox = IMAPPump.daemon.getMailbox("OnlineMove");
    Assert.equal(mailbox._messages.length, 2);
    for (let i = 0; i < sourceKeys.length; ++i) {
      Assert.ok(!source.msgDatabase.containsKey(sourceKeys[i]));
      const target = destination.msgDatabase.getMsgHdrForKey(
        destinationKeys[i]
      );
      Assert.ok(target);
      Assert.equal(target.folder, destination);
      Assert.equal(target.messageKey, destinationKeys[i]);
      Assert.ok(target.properties.includes("uidOnServer"));
      Assert.equal(
        target.getUint32Property("uidOnServer"),
        mailbox._messages[i].uid
      );
      Assert.notEqual(target.messageKey, mailbox._messages[i].uid);
      Assert.ok(target.storeToken);
      Assert.ok(target.flags & Ci.nsMsgMessageFlags.Offline);
      const stream = destination.getMsgInputStream(target);
      Assert.greater(stream.available(), 0);
      stream.close();
    }
  } finally {
    IMAP_RFC3501_handler.prototype.COPY = originalCopy;
    IMAP_RFC3501_handler.prototype.STORE = originalStore;
    IMAP_RFC4315_extension.UID = originalUid;
    if (hadExpungePref) {
      Services.prefs.setBoolPref(expungePref, previousExpunge);
    } else {
      Services.prefs.clearUserPref(expungePref);
    }
    MailServices.txns.transactionManager.clear();
    teardownIMAPPump();
  }
});

add_task(
  async function test_nativeFlagPartialFailureRetainsBodyAndDoesNotResend() {
    if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
      return;
    }
    Services.prefs.setCharPref(
      "mail.server.default.storeContractID",
      Services.prefs.getCharPref("mail.serverDefaultStoreContractID")
    );
    setupIMAPPump("RFC2195,RFC4315");
    const wasOffline = Services.io.offline;
    const originalStore = IMAP_RFC3501_handler.prototype.STORE;
    try {
      const uri = Services.io.newFileURI(
        do_get_file("../../../data/bugmail10")
      );
      for (const uid of [91001, 91002]) {
        IMAPPump.mailbox.addMessage(
          new ImapMessage(uri.spec, uid, {
            "\\Draft": true,
            "\\Seen": true,
            "\\Recent": true,
          })
        );
      }
      const root = IMAPPump.incomingServer.rootFolder;
      const discovery = new PromiseTestUtils.PromiseUrlListener();
      MailServices.imap.discoverAllFolders(root, discovery, null);
      await discovery.promise;
      const source = root
        .getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox)
        .QueryInterface(Ci.nsIMsgImapMailFolder);
      const selected = new PromiseTestUtils.PromiseUrlListener();
      source.updateFolderWithListener(null, selected);
      await selected.promise;
      const downloaded = new PromiseTestUtils.PromiseUrlListener();
      source.downloadAllForOffline(downloaded, null);
      await downloaded.promise;
      const headers = [91001, 91002].map(uid =>
        Array.from(source.msgDatabase.enumerateMessages()).find(
          header => header.getUint32Property("uidOnServer") == uid
        )
      );
      Assert.ok(headers.every(Boolean));
      const keys = headers.map(header => header.messageKey);
      const epoch = source.msgDatabase.dBFolderInfo.imapUidValidity;
      Assert.greater(epoch, 0);
      Assert.notEqual(keys[0], 91001);
      const operations = source.msgDatabase.QueryInterface(
        Ci.nsIMsgOfflineOpsDatabase
      );
      IMAPPump.incomingServer.closeCachedConnections();
      Services.io.offline = true;
      source.storeImapFlags(0, true, [keys[0]], null);
      Assert.equal(operations.getOfflineOpForKey(keys[0], false), null);
      Assert.throws(
        () => source.storeImapFlags(0x20, true, [keys[0]], null),
        error => error.result == Cr.NS_ERROR_INVALID_ARG
      );
      Assert.equal(operations.getOfflineOpForKey(keys[0], false), null);
      source.storeImapFlags(0x84, true, [keys[0]], null); // MDNSent and Flagged.
      source.storeImapFlags(0x01, false, [keys[0]], null); // Seen.
      source.markMessagesFlagged([headers[1]], true);
      let sets = 0;
      let clears = 0;
      let independent = 0;
      IMAP_RFC3501_handler.prototype.STORE = function (args, uid) {
        if (uid && String(args[0]) == "91001") {
          if (args[1].startsWith("-")) {
            clears++;
            // The caller cannot prove no partial effect from tagged NO.
            return "NO selected flag removal failed";
          }
          sets++;
        } else if (uid && String(args[0]) == "91002") {
          independent++;
        }
        return originalStore.call(this, args, uid);
      };
      Services.io.offline = false;
      const failed = new PromiseTestUtils.PromiseUrlListener();
      const failedPromise = (async () => {
        await Assert.rejects(
          failed.promise,
          error => error.message != String(Cr.NS_OK)
        );
      })();
      MailServices.imap.playbackAllOfflineOperations(null, failed);
      await failedPromise;
      Assert.equal(sets, 1);
      Assert.equal(clears, 1);
      Assert.equal(
        independent,
        1,
        "A separate physical message still completes"
      );
      const message = IMAPPump.mailbox._messages.find(msg => msg.uid == 91001);
      for (const flag of [
        "\\Draft",
        "\\Seen",
        "\\Recent",
        "\\Flagged",
        "$Mdnsent",
      ]) {
        Assert.ok(
          message.flags.includes(flag),
          `${flag} is retained or explicitly set`
        );
      }
      Assert.ok(source.msgDatabase.containsKey(keys[0]));
      Assert.ok(headers[0].flags & Ci.nsMsgMessageFlags.Offline);
      Assert.ok(headers[0].storeToken);
      const retained = operations.getOfflineOpForKey(keys[0], false);
      Assert.ok(
        retained.operation & Ci.nsIMsgOfflineImapOperation.kFlagsChanged
      );
      // The legacy payload field is not the native captured protocol tuple.
      Assert.equal(retained.srcUid, 0);
      Assert.equal(retained.messageKey, keys[0]);
      Assert.equal(headers[0].getUint32Property("uidOnServer"), 91001);
      Assert.equal(source.msgDatabase.dBFolderInfo.imapUidValidity, epoch);
      Assert.equal(operations.getOfflineOpForKey(keys[1], false), null);
      const stream = source.getMsgInputStream(headers[0]);
      Assert.greater(
        stream.available(),
        0,
        "The real provider body is retained"
      );
      stream.close();
      IMAPPump.incomingServer.closeCachedConnections();
      const repeated = new PromiseTestUtils.PromiseUrlListener();
      const repeatedPromise = (async () => {
        await Assert.rejects(
          repeated.promise,
          error => error.message == String(Cr.NS_ERROR_NOT_AVAILABLE)
        );
      })();
      MailServices.imap.playbackAllOfflineOperations(null, repeated);
      await repeatedPromise;
      Assert.equal(sets, 1, "The acknowledged set step is not repeated");
      Assert.equal(clears, 1, "The ambiguous clear step is not repeated");
      Assert.equal(independent, 1);
      Assert.ok(operations.getOfflineOpForKey(keys[0], false));
      Assert.equal(headers[0].getUint32Property("uidOnServer"), 91001);
    } finally {
      IMAP_RFC3501_handler.prototype.STORE = originalStore;
      Services.io.offline = wasOffline;
      teardownIMAPPump();
    }
  }
);

add_task(async function test_nativeEmptyTrashUsesDurableFolderIntent() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    return;
  }
  setupIMAPPump("RFC2195,RFC4315");
  const wasOffline = Services.io.offline;
  const originalStore = IMAP_RFC3501_handler.prototype.STORE;
  let stores = 0;
  try {
    IMAPPump.daemon.createMailbox("Trash", {
      subscribed: true,
      uidvalidity: IMAPPump.daemon.uidvalidity++,
    });
    const mailbox = IMAPPump.daemon.getMailbox("Trash");
    const uri = Services.io.newFileURI(do_get_file("../../../data/bugmail10"));
    mailbox.addMessage(new ImapMessage(uri.spec, 92001, []));
    const root = IMAPPump.incomingServer.rootFolder;
    const discovery = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.discoverAllFolders(root, discovery, null);
    await discovery.promise;
    const trash = root
      .getChildNamed("Trash")
      .QueryInterface(Ci.nsIMsgImapMailFolder);
    Assert.ok(trash.getFlag(Ci.nsMsgFolderFlags.Trash));
    const selected = new PromiseTestUtils.PromiseUrlListener();
    trash.updateFolderWithListener(null, selected);
    await selected.promise;
    const downloaded = new PromiseTestUtils.PromiseUrlListener();
    trash.downloadAllForOffline(downloaded, null);
    await downloaded.promise;
    const header = Array.from(trash.msgDatabase.enumerateMessages())[0];
    Assert.ok(header.flags & Ci.nsMsgMessageFlags.Offline);
    const key = header.messageKey;
    const operations = trash.msgDatabase.QueryInterface(
      Ci.nsIMsgOfflineOpsDatabase
    );
    IMAPPump.incomingServer.closeCachedConnections();
    Services.io.offline = true;
    root.emptyTrash(null);
    const operationKeys = operations.listAllOfflineOpIds();
    Assert.equal(operationKeys.length, 1);
    const operation = operations.getOfflineOpForKey(operationKeys[0], false);
    Assert.equal(
      operation.operation,
      Ci.nsIMsgOfflineImapOperation.kDeleteAllMsgs
    );
    Assert.notEqual(operation.messageKey, key);
    Assert.ok(
      trash.msgDatabase.containsKey(key),
      "Queueing retains the physical row"
    );
    IMAP_RFC3501_handler.prototype.STORE = function (args, uid) {
      if (this._selectedMailbox == mailbox && String(args[0]) == "1:*") {
        stores++;
      }
      return originalStore.call(this, args, uid);
    };
    Services.io.offline = false;
    const replayed = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.playbackAllOfflineOperations(null, replayed);
    await replayed.promise;
    Assert.equal(stores, 1);
    Assert.equal(mailbox._messages.length, 0);
    Assert.ok(!trash.msgDatabase.containsKey(key));
    Assert.deepEqual(operations.listAllOfflineOpIds(), []);
    mailbox.addMessage(new ImapMessage(uri.spec, 92002, []));
    const repeated = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.playbackAllOfflineOperations(null, repeated);
    await repeated.promise;
    Assert.equal(
      stores,
      1,
      "An already settled folder intent is not sent again"
    );
    Assert.equal(mailbox._messages.length, 1, "New server mail is retained");
    Assert.equal(mailbox._messages[0].uid, 92002);
  } finally {
    IMAP_RFC3501_handler.prototype.STORE = originalStore;
    Services.io.offline = wasOffline;
    teardownIMAPPump();
  }
});

add_task(async function test_nativeMoveSourceFailureAfterCopySurvivesReopen() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    return;
  }
  setupIMAPPump("RFC2195,RFC4315");
  const wasOffline = Services.io.offline;
  const originalStore = IMAP_RFC3501_handler.prototype.STORE;
  const originalCopy = IMAP_RFC3501_handler.prototype.COPY;
  try {
    IMAPPump.daemon.createMailbox("PhaseMove", {
      subscribed: true,
      uidvalidity: IMAPPump.daemon.uidvalidity++,
    });
    const uri = Services.io.newFileURI(do_get_file("../../../data/bugmail10"));
    const message = new ImapMessage(uri.spec, 93001, []);
    IMAPPump.mailbox.addMessage(message);
    const root = IMAPPump.incomingServer.rootFolder;
    const discovery = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.discoverAllFolders(root, discovery, null);
    await discovery.promise;
    const source = root
      .getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox)
      .QueryInterface(Ci.nsIMsgImapMailFolder);
    const destination = root.getChildNamed("PhaseMove");
    const selected = new PromiseTestUtils.PromiseUrlListener();
    source.updateFolderWithListener(null, selected);
    await selected.promise;
    const downloaded = new PromiseTestUtils.PromiseUrlListener();
    source.downloadAllForOffline(downloaded, null);
    await downloaded.promise;
    const header = Array.from(source.msgDatabase.enumerateMessages())[0];
    const sourceKey = header.messageKey;
    Assert.notEqual(sourceKey, 93001);
    IMAPPump.incomingServer.closeCachedConnections();
    Services.io.offline = true;
    const copied = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyMessages(
      source,
      [header],
      destination,
      true,
      copied,
      null,
      true
    );
    const result = await copied.promise;
    Assert.equal(result.messageKeys.length, 1);
    const targetKey = result.messageKeys[0];
    Assert.ok(!source.msgDatabase.containsKey(sourceKey));
    let copies = 0;
    let sourceStores = 0;
    IMAP_RFC3501_handler.prototype.COPY = function (args, uid) {
      if (uid && String(args[0]) == "93001") {
        copies++;
      }
      return originalCopy.call(this, args, uid);
    };
    IMAP_RFC3501_handler.prototype.STORE = function (args, uid) {
      if (uid && String(args[0]) == "93001" && args[2].includes("\\Deleted")) {
        sourceStores++;
        return "NO source STORE failed after actual COPYUID";
      }
      return originalStore.call(this, args, uid);
    };
    Services.io.offline = false;
    const failed = new PromiseTestUtils.PromiseUrlListener();
    const failedPromise = (async () => {
      await Assert.rejects(
        failed.promise,
        error => error.message != String(Cr.NS_OK)
      );
    })();
    MailServices.imap.playbackAllOfflineOperations(null, failed);
    await failedPromise;
    Assert.equal(copies, 1);
    Assert.equal(sourceStores, 1);
    const mailbox = IMAPPump.daemon.getMailbox("PhaseMove");
    Assert.equal(mailbox._messages.length, 1);
    Assert.ok(IMAPPump.mailbox._messages.includes(message));
    Assert.ok(!message.flags.includes("\\Deleted"));
    const target = destination.msgDatabase.getMsgHdrForKey(targetKey);
    Assert.ok(target.storeToken);
    Assert.ok(target.flags & Ci.nsMsgMessageFlags.Offline);
    Assert.equal(
      target.getUint32Property("uidOnServer"),
      mailbox._messages[0].uid
    );
    const stream = destination.getMsgInputStream(target);
    Assert.greater(stream.available(), 0);
    stream.close();
    IMAPPump.incomingServer.closeCachedConnections();
    source.ForceDBClosed();
    destination.ForceDBClosed();
    const retained = source.msgDatabase
      .QueryInterface(Ci.nsIMsgOfflineOpsDatabase)
      .getOfflineOpForKey(sourceKey, false);
    Assert.equal(retained.destinationFolderURI, destination.URI);
    Assert.equal(retained.srcUid, 93001);
    const repeated = new PromiseTestUtils.PromiseUrlListener();
    const repeatedPromise = (async () => {
      await Assert.rejects(
        repeated.promise,
        error => error.message == String(Cr.NS_ERROR_NOT_AVAILABLE)
      );
    })();
    MailServices.imap.playbackAllOfflineOperations(null, repeated);
    await repeatedPromise;
    Assert.equal(copies, 1, "Reopen does not send a second COPY");
    Assert.equal(sourceStores, 1, "An ambiguous source command is held");
    Assert.equal(mailbox._messages.length, 1);
    Assert.ok(IMAPPump.mailbox._messages.includes(message));
    Assert.equal(
      destination.msgDatabase.getMsgHdrForKey(targetKey).messageKey,
      targetKey
    );
  } finally {
    IMAP_RFC3501_handler.prototype.STORE = originalStore;
    IMAP_RFC3501_handler.prototype.COPY = originalCopy;
    Services.io.offline = wasOffline;
    MailServices.txns.transactionManager.clear();
    teardownIMAPPump();
  }
});

var tests = [
  setupIMAPPump,
  function serverParms() {
    IMAPPump.server.setDebugLevel(nsMailServer.debugAll);
  },
  setup,

  function prepareToGoOffline() {
    const rootFolder = IMAPPump.incomingServer.rootFolder;
    gSecondFolder = rootFolder
      .getChildNamed("secondFolder")
      .QueryInterface(Ci.nsIMsgImapMailFolder);
    gThirdFolder = rootFolder
      .getChildNamed("thirdFolder")
      .QueryInterface(Ci.nsIMsgImapMailFolder);
    IMAPPump.incomingServer.closeCachedConnections();
  },
  async function doOfflineOps() {
    IMAPPump.server.stop();
    Services.io.offline = true;

    // Flag the two messages, and then copy them to different folders. Since
    // we're offline, these operations are synchronous.
    const msgHdr1 = IMAPPump.inbox.msgDatabase.getMsgHdrForMessageID(
      gSynthMessage1.messageId
    );
    const msgHdr2 = IMAPPump.inbox.msgDatabase.getMsgHdrForMessageID(
      gSynthMessage2.messageId
    );
    const headers1 = [msgHdr1];
    const headers2 = [msgHdr2];
    msgHdr1.folder.markMessagesFlagged(headers1, true);
    msgHdr2.folder.markMessagesFlagged(headers2, true);
    const promiseCopyListener1 = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyMessages(
      IMAPPump.inbox,
      headers1,
      gSecondFolder,
      true,
      promiseCopyListener1,
      null,
      true
    );
    const promiseCopyListener2 = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyMessages(
      IMAPPump.inbox,
      headers2,
      gThirdFolder,
      true,
      promiseCopyListener2,
      null,
      true
    );
    var file = do_get_file("../../../data/bugmail10");
    const promiseCopyListener3 = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyFileMessage(
      file,
      IMAPPump.inbox,
      null,
      false,
      0,
      "",
      promiseCopyListener3,
      null
    );
    const results = await Promise.all([
      promiseCopyListener1.promise,
      promiseCopyListener2.promise,
      promiseCopyListener3.promise,
    ]);
    gOfflineAppendKeys = results[2].messageKeys;
  },
  async function test_nativeOfflineAppendUsesFinishedBodyAndPhysicalKey() {
    if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
      return;
    }
    const folder = IMAPPump.inbox;
    const header = folder.msgDatabase.getMsgHdrForMessageID(gMsgId1);
    Assert.ok(header, "The local queued APPEND is published");
    Assert.equal(header.folder, folder);
    Assert.deepEqual(gOfflineAppendKeys, [header.messageKey]);
    Assert.ok(header.flags & Ci.nsMsgMessageFlags.Offline);
    Assert.ok(header.storeToken, "Finish supplied a real token, including 0");
    const properties = header.properties;
    Assert.ok(!properties.includes("uidOnServer"));
    for (const property of [
      "storeToken",
      "messageSize",
      "offlineMessageSize",
      "lineCount",
    ]) {
      Assert.ok(properties.includes(property), `${property} is present`);
    }
    const operations = folder.msgDatabase.QueryInterface(
      Ci.nsIMsgOfflineOpsDatabase
    );
    const operation = operations.getOfflineOpForKey(header.messageKey, false);
    Assert.ok(operation, "The actual physical key has its queued operation");
    Assert.equal(operation.messageKey, header.messageKey);
    Assert.equal(operation.destinationFolderURI, folder.URI);
    Assert.ok(operation.operation & Ci.nsIMsgOfflineImapOperation.kAppendDraft);

    const stream = folder.getMsgInputStream(header);
    const input = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    input.init(stream);
    let stored = "";
    try {
      while (input.available()) {
        stored += input.read(input.available());
      }
    } finally {
      input.close();
    }
    const source = await IOUtils.read(
      do_get_file("../../../data/bugmail10").path
    );
    Assert.deepEqual(
      Array.from(stored, character => character.charCodeAt(0)),
      Array.from(source),
      "The provider-finished message preserves the actual file bytes"
    );
    Assert.equal(header.messageSize, stored.length);
    Assert.equal(header.offlineMessageSize, stored.length);
    const lines = stored.split("\n");
    const separator = lines.findIndex(line => line == "" || line == "\r");
    Assert.greater(
      separator,
      0,
      "The real message has a header/body separator"
    );
    const bodyLines = lines.slice(separator + 1);
    if (bodyLines.at(-1) == "") {
      bodyLines.pop();
    }
    Assert.equal(header.lineCount, bodyLines.length);
    Assert.equal(IMAPPump.daemon.getMailbox("INBOX")._messages.length, 2);
  },

  async function goOnline() {
    gOfflineManager = Cc["@mozilla.org/messenger/offline-manager;1"].getService(
      Ci.nsIMsgOfflineManager
    );
    IMAPPump.daemon.closing = false;
    Services.io.offline = false;

    IMAPPump.server.start();
    gOfflineManager.goOnline(false, true, null);
    await PromiseTestUtils.promiseDelay(2000);
  },
  async function updateSecondFolder() {
    const promiseUrlListener = new PromiseTestUtils.PromiseUrlListener();
    gSecondFolder.updateFolderWithListener(null, promiseUrlListener);
    await promiseUrlListener.promise;
  },
  async function updateThirdFolder() {
    const promiseUrlListener = new PromiseTestUtils.PromiseUrlListener();
    gThirdFolder.updateFolderWithListener(null, promiseUrlListener);
    await promiseUrlListener.promise;
  },
  async function updateInbox() {
    const promiseUrlListener = new PromiseTestUtils.PromiseUrlListener();
    IMAPPump.inbox.updateFolderWithListener(null, promiseUrlListener);
    await promiseUrlListener.promise;
  },
  function checkDone() {
    const msgHdr1 = gSecondFolder.msgDatabase.getMsgHdrForMessageID(
      gSynthMessage1.messageId
    );
    const msgHdr2 = gThirdFolder.msgDatabase.getMsgHdrForMessageID(
      gSynthMessage2.messageId
    );
    const msgHdr3 = IMAPPump.inbox.msgDatabase.getMsgHdrForMessageID(gMsgId1);
    Assert.notEqual(msgHdr1, null);
    Assert.notEqual(msgHdr2, null);
    Assert.notEqual(msgHdr3, null);
  },
  teardownIMAPPump,
];

async function setup() {
  /*
   * Set up an IMAP server.
   */
  IMAPPump.daemon.createMailbox("secondFolder", {
    subscribed: true,
    uidvalidity: IMAPPump.daemon.uidvalidity++,
  });
  IMAPPump.daemon.createMailbox("thirdFolder", {
    subscribed: true,
    uidvalidity: IMAPPump.daemon.uidvalidity++,
  });
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    const discovered = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.discoverAllFolders(
      IMAPPump.incomingServer.rootFolder,
      discovered,
      null
    );
    await discovered.promise;
    IMAPPump.inbox = IMAPPump.incomingServer.rootFolder
      .getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox)
      .QueryInterface(Ci.nsIMsgImapMailFolder);
  }
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
  // Don't prompt about offline download when going offline
  Services.prefs.setIntPref("offline.download.download_messages", 2);

  // make a couple of messages
  let messages = [];
  const gMessageGenerator = new MessageGenerator();
  messages = messages.concat(gMessageGenerator.makeMessage());
  messages = messages.concat(gMessageGenerator.makeMessage());
  gSynthMessage1 = messages[0];
  gSynthMessage2 = messages[1];

  let msgURI = Services.io.newURI(
    "data:text/plain;base64," + btoa(messages[0].toMessageString())
  );
  const imapInbox = IMAPPump.daemon.getMailbox("INBOX");
  let message = new ImapMessage(msgURI.spec, imapInbox.uidnext++, ["\\Seen"]);
  imapInbox.addMessage(message);
  msgURI = Services.io.newURI(
    "data:text/plain;base64," + btoa(messages[1].toMessageString())
  );
  message = new ImapMessage(msgURI.spec, imapInbox.uidnext++, ["\\Seen"]);
  imapInbox.addMessage(message);

  // update folder to download header.
  const promiseUrlListener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, promiseUrlListener);
  await promiseUrlListener.promise;
}

function run_test() {
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
  tests.forEach(x => add_task(x));
  run_next_test();
}
