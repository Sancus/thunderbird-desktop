/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Test to check that offline IMAP operation for a local->IMAP message
 * move completes correctly once we go back online.
 */

// NOTE: PromiseTestUtils and MailServices already imported

var { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

/**
 * Reads the actual provider body through its physical owning header.
 *
 * @param {nsIMsgDBHdr} header - The retained queued or associated member.
 * @returns {string} The complete stored bytes.
 */
function readRetainedMoveBody(header) {
  const stream = header.folder.getMsgInputStream(header);
  const input = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
    Ci.nsIScriptableInputStream
  );
  input.init(stream);
  try {
    let bytes = "";
    for (;;) {
      const chunk = input.read(8192);
      if (!chunk) {
        return bytes;
      }
      bytes += chunk;
    }
  } finally {
    input.close();
  }
}

const gAcceptedAppendSearches = [];
const gAcceptedAppendBodyReads = [];

add_setup(function () {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    return;
  }
  const proto = IMAP_RFC3501_handler.prototype;
  const originalSearch = proto.SEARCH;
  proto.SEARCH = function (args, uid) {
    if (
      args.length != 4 ||
      args[0] != "UNDELETED" ||
      args[1].toUpperCase() != "HEADER" ||
      args[2].toLowerCase() != "message-id"
    ) {
      return originalSearch.call(this, args, uid);
    }
    Assert.ok(uid, "Discovery consumes actual server UIDs");
    const needle = args[3].toLowerCase();
    const matches = this._selectedMailbox._messages.filter(message => {
      const headers = message.getPartHeaders("");
      return (
        !message.flags.includes("\\Deleted") &&
        headers.has("message-id") &&
        headers
          .getRawHeader("message-id")
          .some(value => value.toLowerCase().includes(needle))
      );
    });
    gAcceptedAppendSearches.push(matches.map(message => message.uid));
    return (
      "* SEARCH" +
      matches.map(message => " " + message.uid).join("") +
      "\0OK SEARCH completed"
    );
  };
  registerCleanupFunction(() => {
    proto.SEARCH = originalSearch;
  });
  const originalBody = proto._FETCH_BODY;
  proto._FETCH_BODY = function (message, query) {
    const response = originalBody.call(this, message, query);
    if (query == "BODY[]" || query == "BODY.PEEK[]") {
      // The full-body early return does not set this flag. Keep the real
      // LF bytes and declared literal size instead of expanding them.
      this.sendingLiteral = true;
      gAcceptedAppendBodyReads.push(message.uid);
    }
    return response;
  };
  registerCleanupFunction(() => {
    proto._FETCH_BODY = originalBody;
  });
});

/**
 * Creates the ordinary IMAP fixture and discovers its native INBOX.
 *
 * @param {string} [extensions] - Fake server extensions passed to the fixture.
 * @returns {Promise<void>} Resolves after native folder discovery.
 */
async function setupTest(extensions) {
  // Turn off autosync_offline_stores because
  // fetching messages is invoked after copying the messages.
  // (i.e. The fetching process will be invoked after OnStopCopy)
  // It will cause crash with an assertion
  // (ASSERTION: tried to add duplicate listener: 'index == -1') on teardown.

  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );

  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    Services.prefs.setCharPref(
      "mail.server.default.storeContractID",
      Services.prefs.getCharPref("mail.serverDefaultStoreContractID")
    );
  }
  setupIMAPPump(extensions);
  IMAPPump.server.setDebugLevel(nsMailServer.debugAll);
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
    Assert.ok(IMAPPump.inbox, "Native discovery supplied the real INBOX");
  }

  // These hacks are required because we've created the inbox before
  // running initial folder discovery, and adding the folder bails
  // out before we set it as verified online, so we bail out, and
  // then remove the INBOX folder since it's not verified.
  IMAPPump.inbox.hierarchyDelimiter = "/";
  IMAPPump.inbox.verifiedAsOnlineFolder = true;
}

function teardownTest() {
  teardownIMAPPump();
}

function goOffline() {
  IMAPPump.incomingServer.closeCachedConnections();
  IMAPPump.server.stop();
  Services.io.offline = true;
}

// Go back into online mode, and wait until offline IMAP operations are completed.
async function goOnline() {
  IMAPPump.daemon.closing = false;
  Services.io.offline = false;
  IMAPPump.server.start();

  const offlineManager = Cc[
    "@mozilla.org/messenger/offline-manager;1"
  ].getService(Ci.nsIMsgOfflineManager);
  offlineManager.goOnline(
    false, // sendUnsentMessages
    true, // playbackOfflineImapOperations
    null // msgWindow
  );
  // No way to signal when offline IMAP operations are complete... so we
  // just blindly wait and cross our fingers :-(
  await PromiseTestUtils.promiseDelay(2000);
}

async function loadTestMessage(folder) {
  const copyListener = new PromiseTestUtils.PromiseCopyListener();
  const file = do_get_file("../../../data/bugmail1");
  MailServices.copy.copyFileMessage(
    file,
    folder,
    null,
    false,
    0,
    "",
    copyListener,
    null
  );
  await copyListener.promise;
}

add_task(async function testOfflineMoveLocalToIMAP() {
  await setupTest();

  // Install a test message in the local folder.
  await loadTestMessage(localAccountUtils.inboxFolder);

  goOffline();

  // Move messages in local folder to the IMAP inbox.
  // We're offline so this should result in a queued-up offline IMAP
  // operation, which will execute when we go back online.
  const copyListener = new PromiseTestUtils.PromiseCopyListener();
  const msgs = [
    ...localAccountUtils.inboxFolder.msgDatabase.enumerateMessages(),
  ];
  MailServices.copy.copyMessages(
    localAccountUtils.inboxFolder,
    msgs,
    IMAPPump.inbox, // dest folder
    true, // move
    copyListener,
    null,
    false // undo?
  );
  await copyListener.promise;

  const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  let retainedKey;
  let retainedToken;
  let retainedBytes;
  if (native) {
    const retained = [...IMAPPump.inbox.msgDatabase.enumerateMessages()];
    Assert.equal(retained.length, 1);
    retainedKey = retained[0].messageKey;
    retainedToken = retained[0].storeToken;
    retainedBytes = readRetainedMoveBody(retained[0]);
    Assert.ok(!retained[0].properties.includes("uidOnServer"));
    Assert.ok(retained[0].flags & Ci.nsMsgMessageFlags.Offline);
    Assert.equal(
      localAccountUtils.inboxFolder.getTotalMessages(false),
      0,
      "The completed offline MOVE owns finished destination and undo recovery"
    );
  }

  // Now, go back online and see if the operation has been performed

  await goOnline();

  const imapINBOX = IMAPPump.inbox.QueryInterface(Ci.nsIMsgImapMailFolder);
  const listener = new PromiseTestUtils.PromiseUrlListener();
  imapINBOX.updateFolderWithListener(null, listener);
  await listener.promise;

  // Local folder should be empty, contents now in IMAP inbox.
  const localCount = [
    ...localAccountUtils.inboxFolder.msgDatabase.enumerateMessages(),
  ].length;
  const imapCount = [...IMAPPump.inbox.msgDatabase.enumerateMessages()].length;
  Assert.equal(imapCount, msgs.length);
  Assert.equal(localCount, 0);

  if (native) {
    const mailbox = IMAPPump.daemon.getMailbox("INBOX");
    const associated = IMAPPump.inbox.msgDatabase.getMsgHdrForKey(retainedKey);
    Assert.equal(associated.messageKey, retainedKey);
    Assert.equal(associated.getUint32Property("pseudoHdr"), 0);
    Assert.equal(associated.storeToken, retainedToken);
    Assert.equal(readRetainedMoveBody(associated), retainedBytes);
    Assert.equal(
      associated.getUint32Property("uidOnServer"),
      mailbox._messages[0].uid
    );
    Assert.notEqual(retainedKey, mailbox._messages[0].uid);
    const manager = Cc["@mozilla.org/messenger/offline-manager;1"].getService(
      Ci.nsIMsgOfflineManager
    );
    manager.inProgress = true;
    manager.goOnline(false, true, null);
    await TestUtils.waitForCondition(
      () => !manager.inProgress,
      "Observed accepted APPEND remains fenced against another send"
    );
    let replayStops = 0;
    const terminal = new PromiseTestUtils.PromiseUrlListener({
      OnStopRunningUrl() {
        replayStops++;
      },
    });
    const terminalResult = terminal.promise.then(
      () => Cr.NS_OK,
      error => Number(error.message)
    );
    const playback = MailServices.imap.playbackAllOfflineOperations(
      null,
      terminal
    );
    Assert.ok(playback, "The ordinary service owns the explicit replay");
    Assert.equal(await terminalResult, Cr.NS_ERROR_NOT_AVAILABLE);
    Assert.equal(replayStops, 1);
    const repeated = new PromiseTestUtils.PromiseUrlListener();
    imapINBOX.updateFolderWithListener(null, repeated);
    await repeated.promise;
    Assert.equal(mailbox._messages.length, 1);
    Assert.equal(IMAPPump.inbox.getTotalMessages(false), 1);
    const current = IMAPPump.inbox.msgDatabase.getMsgHdrForKey(retainedKey);
    Assert.equal(current.getUint32Property("pseudoHdr"), 0);
    Assert.equal(current.storeToken, retainedToken);
    Assert.equal(readRetainedMoveBody(current), retainedBytes);
    Assert.equal(
      current.getUint32Property("uidOnServer"),
      mailbox._messages[0].uid
    );
    Assert.equal(replayStops, 1, "Later refresh cannot complete replay twice");
  }

  teardownTest();
});

add_task(async function testOfflineCopyLocalToIMAPRetainsSource() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    return;
  }
  await setupTest();
  try {
    const source = localAccountUtils.inboxFolder;
    await loadTestMessage(source);
    const original = [...source.msgDatabase.enumerateMessages()];
    Assert.equal(original.length, 1);
    const header = original[0];
    const key = header.messageKey;
    const token = header.storeToken;
    const flags = header.flags;
    const bytes = readRetainedMoveBody(header);
    IMAPPump.incomingServer.closeCachedConnections();
    Services.io.offline = true;

    const listener = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyMessages(
      source,
      [header],
      IMAPPump.inbox,
      false,
      listener,
      null,
      false
    );
    const result = await listener.promise;
    Assert.equal(result.messageKeys.length, 1);
    Assert.equal(source.getTotalMessages(false), 1);
    const kept = source.msgDatabase.getMsgHdrForKey(key);
    Assert.equal(kept, header);
    Assert.equal(kept.storeToken, token);
    Assert.equal(kept.flags, flags);
    Assert.equal(readRetainedMoveBody(kept), bytes);
    const copied = [...IMAPPump.inbox.msgDatabase.enumerateMessages()];
    Assert.equal(copied.length, 1);
    Assert.equal(copied[0].messageKey, result.messageKeys[0]);
    Assert.ok(!copied[0].properties.includes("uidOnServer"));
    Assert.ok(copied[0].flags & Ci.nsMsgMessageFlags.Offline);
    Assert.equal(copied[0].getUint32Property("pseudoHdr"), 1);
    Assert.equal(readRetainedMoveBody(copied[0]), bytes);
  } finally {
    teardownTest();
    Services.io.offline = false;
  }
});

/**
 * Verifies that unresolved accepted copies retain custody during normal refresh.
 *
 * @param {"ambiguous"|"wrongBody"} mode - The real server candidate mismatch.
 * @returns {Promise<void>} Resolves after repeated refresh and no-resend checks.
 */
async function checkUnresolvedAcceptedAppendStillUpdates(mode) {
  await setupTest();
  const proto = IMAP_RFC3501_handler.prototype;
  const originalAppend = proto.APPEND;
  let appends = 0;
  proto.APPEND = function (args) {
    const response = originalAppend.call(this, args);
    if (args[0] == "INBOX" && response.startsWith("OK")) {
      appends++;
    }
    return response;
  };
  try {
    const source = localAccountUtils.rootFolder.createLocalSubfolder(
      "unresolved-accepted-" + mode
    );
    await loadTestMessage(source);
    const original = [...source.messages][0];
    const sourceToken = original.storeToken;
    const sourceBytes = readRetainedMoveBody(original);
    goOffline();
    const copied = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyMessages(
      source,
      [original],
      IMAPPump.inbox,
      false,
      copied,
      null,
      false
    );
    const queued = await copied.promise;
    Assert.equal(queued.messageKeys.length, 1);
    const key = queued.messageKeys[0];
    const retained = IMAPPump.inbox.msgDatabase.getMsgHdrForKey(key);
    const token = retained.storeToken;
    const bytes = readRetainedMoveBody(retained);
    const operations = IMAPPump.inbox.msgDatabase.QueryInterface(
      Ci.nsIMsgOfflineOpsDatabase
    );
    const operation = operations.getOfflineOpForKey(key, false).operation;
    Assert.ok(operation);
    Assert.ok(!retained.properties.includes("uidOnServer"));
    IMAPPump.daemon.closing = false;
    Services.io.offline = false;
    IMAPPump.server.start();
    const first = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.playbackAllOfflineOperations(null, first);
    await first.promise;
    const mailbox = IMAPPump.daemon.getMailbox("INBOX");
    Assert.equal(appends, 1);
    Assert.equal(mailbox._messages.length, 1);
    const accepted = mailbox._messages[0];
    if (mode == "ambiguous") {
      mailbox.addMessage(
        new ImapMessage(
          "data:text/plain," + encodeURI(accepted.getText()),
          mailbox.uidnext++,
          []
        )
      );
    } else {
      mailbox._messages[0] = new ImapMessage(
        "data:text/plain," + encodeURI(accepted.getText() + "Different body\n"),
        accepted.uid,
        []
      );
    }
    for (let pass = 0; pass < 2; pass++) {
      const fresh = new ImapMessage(
        "data:text/plain," +
          encodeURI(
            "Message-ID: <unrelated-" +
              mode +
              "-" +
              pass +
              "@example.invalid>\r\n" +
              "Subject: Unrelated new mail\r\n\r\nUnrelated body\r\n"
          ),
        mailbox.uidnext++,
        []
      );
      mailbox.addMessage(fresh);
      let stops = 0;
      const updated = new PromiseTestUtils.PromiseUrlListener({
        OnStopRunningUrl() {
          stops++;
        },
      });
      const searchStart = gAcceptedAppendSearches.length;
      const readStart = gAcceptedAppendBodyReads.length;
      IMAPPump.inbox.updateFolderWithListener(null, updated);
      await updated.promise;
      Assert.equal(stops, 1);
      const searches = gAcceptedAppendSearches.slice(searchStart);
      Assert.equal(searches.length, 1);
      Assert.equal(searches[0].length, mode == "ambiguous" ? 2 : 1);
      Assert.deepEqual(
        gAcceptedAppendBodyReads.slice(readStart),
        mode == "ambiguous" ? [] : [accepted.uid]
      );
      const current = IMAPPump.inbox.msgDatabase.getMsgHdrForKey(key);
      Assert.equal(current.messageKey, key);
      Assert.equal(current.storeToken, token);
      Assert.equal(readRetainedMoveBody(current), bytes);
      Assert.ok(!current.properties.includes("uidOnServer"));
      Assert.equal(
        operations.getOfflineOpForKey(key, false).operation,
        operation
      );
      const all = [...IMAPPump.inbox.messages];
      const uids = all
        .filter(header => header.properties.includes("uidOnServer"))
        .map(header => header.getUint32Property("uidOnServer"))
        .sort((a, b) => a - b);
      Assert.deepEqual(
        uids,
        mailbox._messages.map(message => message.uid).sort((a, b) => a - b)
      );
      Assert.equal(
        all.length,
        mailbox._messages.length + 1,
        "All actual server members plus the unchanged unbound recovery remain visible"
      );
      Assert.ok(uids.includes(fresh.uid), "Unrelated new mail is synchronized");
      Assert.equal(appends, 1, "Refresh cannot resend the accepted copy");
    }
    const repeated = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.playbackAllOfflineOperations(null, repeated);
    await repeated.promise;
    Assert.equal(appends, 1);
    Assert.equal(source.getTotalMessages(false), 1);
    Assert.equal(
      source.msgDatabase.getMsgHdrForKey(original.messageKey).storeToken,
      sourceToken
    );
    Assert.equal(readRetainedMoveBody(original), sourceBytes);
  } finally {
    proto.APPEND = originalAppend;
    teardownTest();
    Services.io.offline = false;
  }
}

add_task(async function test_ambiguousAcceptedAppendStillUpdatesFolder() {
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    await checkUnresolvedAcceptedAppendStillUpdates("ambiguous");
  }
});

add_task(async function test_wrongBodyAcceptedAppendStillUpdatesFolder() {
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    await checkUnresolvedAcceptedAppendStillUpdates("wrongBody");
  }
});

add_task(async function test_observedAcceptedAppendDoesNotStarveLaterWork() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    return;
  }
  const originalAppend = IMAP_RFC4315_extension.APPEND;
  const originalCopy = IMAP_RFC4315_extension.COPY;
  const proto = IMAP_RFC3501_handler.prototype;
  const originalStore = proto.STORE;
  const transactions = MailServices.txns.transactionManager;
  transactions.clear();
  let appends = 0;
  let copies = 0;
  let flagged = 0;
  let freshUid;
  IMAP_RFC4315_extension.APPEND = function (args) {
    const response = originalAppend.call(this, args);
    if (args[0] == "INBOX" && response.startsWith("OK")) {
      appends++;
      return response.replace(/\[APPENDUID [^\]]+\]/, "");
    }
    return response;
  };
  IMAP_RFC4315_extension.COPY = function (args, uid) {
    if (uid && args[1] == "LaterPureMove") {
      copies++;
    }
    return originalCopy.call(this, args, uid);
  };
  proto.STORE = function (args, uid) {
    if (
      uid &&
      this._parseSequenceSet(args[0], uid).some(
        message => message.uid == freshUid
      ) &&
      args[2].includes("\\Flagged")
    ) {
      flagged++;
    }
    return originalStore.call(this, args, uid);
  };
  try {
    await setupTest("RFC2195,RFC4315");
    IMAPPump.daemon.createMailbox("LaterPureMove", {
      subscribed: true,
      uidvalidity: IMAPPump.daemon.uidvalidity++,
    });
    const root = IMAPPump.incomingServer.rootFolder;
    const discovered = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.discoverAllFolders(root, discovered, null);
    await discovered.promise;
    const destination = root
      .getChildNamed("LaterPureMove")
      .QueryInterface(Ci.nsIMsgImapMailFolder);
    const selectedTarget = new PromiseTestUtils.PromiseUrlListener();
    destination.updateFolderWithListener(null, selectedTarget);
    await selectedTarget.promise;
    const local = localAccountUtils.rootFolder.createLocalSubfolder(
      "accepted-before-later-work"
    );
    await loadTestMessage(local);
    goOffline();
    const queued = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyMessages(
      local,
      [...local.messages],
      IMAPPump.inbox,
      true,
      queued,
      null,
      false
    );
    const retainedKey = (await queued.promise).messageKeys[0];
    const retained = IMAPPump.inbox.msgDatabase.getMsgHdrForKey(retainedKey);
    const token = retained.storeToken;
    const bytes = readRetainedMoveBody(retained);
    const operations = IMAPPump.inbox.msgDatabase.QueryInterface(
      Ci.nsIMsgOfflineOpsDatabase
    );
    const acceptedOperation = operations.getOfflineOpForKey(
      retainedKey,
      false
    ).operation;
    Assert.equal(local.getTotalMessages(false), 0);
    IMAPPump.daemon.closing = false;
    Services.io.offline = false;
    IMAPPump.server.start();
    const replayed = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.playbackAllOfflineOperations(null, replayed);
    await replayed.promise;
    const mailbox = IMAPPump.daemon.getMailbox("INBOX");
    Assert.equal(appends, 1);
    const observed = new PromiseTestUtils.PromiseUrlListener();
    IMAPPump.inbox.updateFolderWithListener(null, observed);
    await observed.promise;
    const acceptedUid = mailbox._messages[0].uid;
    Assert.equal(retained.getUint32Property("uidOnServer"), acceptedUid);
    Assert.equal(retained.messageKey, retainedKey);
    Assert.notEqual(retainedKey, acceptedUid);
    const uri = Services.io.newFileURI(do_get_file("../../../data/bugmail10"));
    freshUid = mailbox.uidnext++;
    const freshRemote = new ImapMessage(uri.spec, freshUid, []);
    mailbox.addMessage(freshRemote);
    const loaded = new PromiseTestUtils.PromiseUrlListener();
    IMAPPump.inbox.updateFolderWithListener(null, loaded);
    await loaded.promise;
    const downloaded = new PromiseTestUtils.PromiseUrlListener();
    IMAPPump.inbox.downloadAllForOffline(downloaded, null);
    await downloaded.promise;
    const fresh = [...IMAPPump.inbox.messages].find(
      header => header.getUint32Property("uidOnServer") == freshUid
    );
    Assert.ok(fresh);
    Assert.greater(fresh.messageKey, retainedKey);
    IMAPPump.incomingServer.closeCachedConnections();
    Services.io.offline = true;
    IMAPPump.inbox.markMessagesFlagged([fresh], true);
    Assert.ok(IMAPPump.inbox.flags & Ci.nsMsgFolderFlags.OfflineEvents);
    Services.io.offline = false;
    const afterFlag = new ImapMessage(
      "data:text/plain," +
        encodeURI(
          "Message-ID: <after-retained-flag@example.invalid>\r\nSubject: New flag mail\r\n\r\nbody\r\n"
        ),
      mailbox.uidnext++,
      []
    );
    mailbox.addMessage(afterFlag);
    const flagsPlayed = new PromiseTestUtils.PromiseUrlListener();
    IMAPPump.inbox.updateFolderWithListener(null, flagsPlayed);
    await flagsPlayed.promise;
    Assert.equal(
      flagged,
      1,
      "The later-key ordinary flag operation is dispatched once"
    );
    Assert.ok(freshRemote.flags.includes("\\Flagged"));
    Assert.ok(
      [...IMAPPump.inbox.messages].some(
        header => header.getUint32Property("uidOnServer") == afterFlag.uid
      )
    );
    const moved = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyMessages(
      IMAPPump.inbox,
      [fresh],
      destination,
      true,
      moved,
      null,
      true
    );
    const movedResult = await moved.promise;
    Assert.equal(movedResult.messageKeys.length, 1);
    const afterMove = new ImapMessage(
      "data:text/plain," +
        encodeURI(
          "Message-ID: <after-retained-move@example.invalid>\r\nSubject: New move mail\r\n\r\nbody\r\n"
        ),
      mailbox.uidnext++,
      []
    );
    mailbox.addMessage(afterMove);
    const movePlayed = new PromiseTestUtils.PromiseUrlListener();
    IMAPPump.inbox.updateFolderWithListener(null, movePlayed);
    await movePlayed.promise;
    Assert.equal(
      copies,
      1,
      "The later online undoable MOVE dispatches exactly one real COPY"
    );
    const target = IMAPPump.daemon.getMailbox("LaterPureMove");
    Assert.equal(target._messages.length, 1);
    Assert.ok(
      [...IMAPPump.inbox.messages].some(
        header => header.getUint32Property("uidOnServer") == afterMove.uid
      )
    );
    const current = IMAPPump.inbox.msgDatabase.getMsgHdrForKey(retainedKey);
    Assert.equal(current.getUint32Property("uidOnServer"), acceptedUid);
    Assert.equal(current.storeToken, token);
    Assert.equal(readRetainedMoveBody(current), bytes);
    Assert.equal(
      operations.getOfflineOpForKey(retainedKey, false).operation,
      acceptedOperation
    );
    const repeated = new PromiseTestUtils.PromiseUrlListener();
    IMAPPump.inbox.updateFolderWithListener(null, repeated);
    await repeated.promise;
    Assert.equal(appends, 1);
    Assert.equal(copies, 1);
    Assert.equal(flagged, 1);
    Assert.ok(!(IMAPPump.inbox.flags & Ci.nsMsgFolderFlags.OfflineEvents));
  } finally {
    IMAP_RFC4315_extension.APPEND = originalAppend;
    IMAP_RFC4315_extension.COPY = originalCopy;
    proto.STORE = originalStore;
    transactions.clear();
    teardownTest();
    Services.io.offline = false;
  }
});
