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
      if (!chunk) return bytes;
      bytes += chunk;
    }
  } finally {
    input.close();
  }
}

async function setupTest() {
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
  setupIMAPPump();
  IMAPPump.server.setDebugLevel(nsMailServer.debugAll);
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    const proto = IMAP_RFC3501_handler.prototype;
    const originalBody = proto._FETCH_BODY;
    proto._FETCH_BODY = function (message, query) {
      const response = originalBody.call(this, message, query);
      if (query == "BODY[]" || query == "BODY.PEEK[]") {
        // The full-body early return does not set this flag. Keep the real
        // LF bytes and declared literal size instead of expanding them.
        this.sendingLiteral = true;
      }
      return response;
    };
    registerCleanupFunction(() => {
      proto._FETCH_BODY = originalBody;
    });
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
  }

  // Now, go back online and see if the operation has been performed

  await goOnline();

  if (native) {
    const mailbox = IMAPPump.daemon.getMailbox("INBOX");
    Assert.equal(mailbox._messages.length, 1, "Exactly one actual APPEND");
    const original = mailbox._messages[0];
    const duplicate = new ImapMessage(
      "data:text/plain," + encodeURI(original.getText()),
      mailbox.uidnext++,
      []
    );
    mailbox.addMessage(duplicate);
    Assert.equal(duplicate.getText(), original.getText());
    const refused = new PromiseTestUtils.PromiseUrlListener();
    const refusal = refused.promise.then(
      () => Cr.NS_OK,
      error => Number(error.message)
    );
    try {
      IMAPPump.inbox.updateFolderWithListener(null, refused);
      Assert.equal(await refusal, Cr.NS_ERROR_NOT_AVAILABLE);
      const kept = IMAPPump.inbox.msgDatabase.getMsgHdrForKey(retainedKey);
      Assert.ok(!kept.properties.includes("uidOnServer"));
      Assert.equal(kept.storeToken, retainedToken);
      Assert.equal(readRetainedMoveBody(kept), retainedBytes);
      Assert.equal(IMAPPump.inbox.getTotalMessages(false), 1);
      Assert.equal(mailbox._messages.length, 2);
    } finally {
      // Remove only the deliberately ambiguous server input. No application
      // member or retained provider bytes are hidden to satisfy the count.
      mailbox._messages.splice(mailbox._messages.indexOf(duplicate), 1);
    }
  }

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
  }

  teardownTest();
});
