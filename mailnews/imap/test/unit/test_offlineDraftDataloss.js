/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This file tests that a message saved as draft in an IMAP folder in offline
 * mode is not lost when going back online
 * See Bug 805626
 */

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);
var { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const gAcceptedAppendSearches = [];

var gDraftsFolder;
var gNativeDraft;
var gNativeDraftBytes;

/**
 * Reads the actual retained provider bytes to EOF.
 *
 * @param {nsIMsgDBHdr} header - The physical queued draft.
 * @returns {string} The complete stored message.
 */
function readNativeDraftBytes(header) {
  const stream = header.folder.getMsgInputStream(header);
  const input = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
    Ci.nsIScriptableInputStream
  );
  input.init(stream);
  try {
    let result = "";
    for (;;) {
      const chunk = input.read(8192);
      if (!chunk) {
        return result;
      }
      result += chunk;
    }
  } finally {
    input.close();
  }
}

add_setup(function () {
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
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
  }
  setupIMAPPump();
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
});

add_task(async function createDraftsFolder() {
  IMAPPump.incomingServer.rootFolder.createSubfolder("Drafts", null);
  await PromiseTestUtils.promiseFolderAdded("Drafts");
  gDraftsFolder = IMAPPump.incomingServer.rootFolder.getChildNamed("Drafts");
  Assert.ok(gDraftsFolder instanceof Ci.nsIMsgImapMailFolder);
  const listener = new PromiseTestUtils.PromiseUrlListener();
  gDraftsFolder.updateFolderWithListener(null, listener);
  await listener.promise;
});

add_task(async function goOffline() {
  // Don't prompt about offline download when going offline.
  Services.prefs.setIntPref("offline.download.download_messages", 2);

  IMAPPump.incomingServer.closeCachedConnections();
  const thread = Services.tm.currentThread;
  while (thread.hasPendingEvents()) {
    thread.processNextEvent(true);
  }
  IMAPPump.server.stop();
  Services.io.offline = true;
});

add_task(async function saveDraft() {
  const msgCompose = Cc[
    "@mozilla.org/messengercompose/compose;1"
  ].createInstance(Ci.nsIMsgCompose);
  const fields = Cc[
    "@mozilla.org/messengercompose/composefields;1"
  ].createInstance(Ci.nsIMsgCompFields);
  fields.from = "Nobody <nobody@tinderbox.test>";

  const params = Cc[
    "@mozilla.org/messengercompose/composeparams;1"
  ].createInstance(Ci.nsIMsgComposeParams);
  params.composeFields = fields;
  msgCompose.initialize(params);

  // Set up the identity.
  const identity = MailServices.accounts.getFirstIdentityForServer(
    IMAPPump.incomingServer
  );
  identity.draftsFolderURI = gDraftsFolder.URI;

  const progress = Cc["@mozilla.org/messenger/progress;1"].createInstance(
    Ci.nsIMsgProgress
  );
  const progressListener = new WebProgressListener();
  progress.registerListener(progressListener);
  msgCompose.sendMsg(Ci.nsIMsgSend.nsMsgSaveAsDraft, identity, "", progress);
  await progressListener.promise;
  // Verify that message is not on the server yet.
  Assert.equal(IMAPPump.daemon.getMailbox("Drafts")._messages.length, 0);
});

add_task(function test_nativeQueuedDraftHasFinishedBody() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    return;
  }
  const headers = Array.from(gDraftsFolder.messages);
  Assert.equal(headers.length, 1);
  gNativeDraft = headers[0];
  Assert.equal(gNativeDraft.folder, gDraftsFolder);
  Assert.ok(gNativeDraft.messageKey);
  Assert.ok(gNativeDraft.flags & Ci.nsMsgMessageFlags.Offline);
  Assert.ok(!gNativeDraft.properties.includes("uidOnServer"));
  for (const property of [
    "storeToken",
    "messageSize",
    "offlineMessageSize",
    "lineCount",
  ]) {
    Assert.ok(gNativeDraft.properties.includes(property));
  }
  gNativeDraftBytes = readNativeDraftBytes(gNativeDraft);
  Assert.greater(gNativeDraftBytes.length, 0);
  Assert.equal(gNativeDraft.messageSize, gNativeDraftBytes.length);
  Assert.equal(gNativeDraft.offlineMessageSize, gNativeDraftBytes.length);
  const operation = gDraftsFolder.msgDatabase
    .QueryInterface(Ci.nsIMsgOfflineOpsDatabase)
    .getOfflineOpForKey(gNativeDraft.messageKey, false);
  Assert.ok(operation);
  Assert.equal(operation.messageKey, gNativeDraft.messageKey);
  Assert.ok(operation.operation & Ci.nsIMsgOfflineImapOperation.kAppendDraft);
});

add_task(async function goOnline() {
  const offlineManager = Cc[
    "@mozilla.org/messenger/offline-manager;1"
  ].getService(Ci.nsIMsgOfflineManager);
  IMAPPump.daemon.closing = false;
  Services.io.offline = false;

  IMAPPump.server.start();
  offlineManager.inProgress = true;
  offlineManager.goOnline(false, true, null);
  // There seem to be some untraceable postprocessing with 100ms.
  //  (Found through xpcshell-test --verify)
  await PromiseTestUtils.promiseDelay(100);
  await TestUtils.waitForCondition(
    () => !offlineManager.inProgress,
    "wait for offlineManager not in progress"
  );
  // Verify that message is now on the server.
  Assert.equal(IMAPPump.daemon.getMailbox("Drafts")._messages.length, 1);
});

add_task(
  async function test_nativeAcceptedDraftKeepsUnboundRecoveryWithoutResend() {
    if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
      return;
    }
    const key = gNativeDraft.messageKey;
    const database = gDraftsFolder.msgDatabase;
    const retained = database.getMsgHdrForKey(key);
    Assert.equal(retained.messageKey, gNativeDraft.messageKey);
    Assert.equal(retained.folder, gNativeDraft.folder);
    Assert.equal(retained.messageId, gNativeDraft.messageId);
    Assert.equal(retained.storeToken, gNativeDraft.storeToken);
    Assert.equal(database.getMsgHdrForKey(key), retained);
    Assert.equal(readNativeDraftBytes(retained), gNativeDraftBytes);
    Assert.ok(!gNativeDraft.properties.includes("uidOnServer"));
    Assert.ok(gNativeDraft.flags & Ci.nsMsgMessageFlags.Offline);
    Assert.equal(readNativeDraftBytes(gNativeDraft), gNativeDraftBytes);
    const operations = database.QueryInterface(Ci.nsIMsgOfflineOpsDatabase);
    Assert.ok(
      operations.getOfflineOpForKey(key, false).operation &
        Ci.nsIMsgOfflineImapOperation.kAppendDraft
    );
    const offlineManager = Cc[
      "@mozilla.org/messenger/offline-manager;1"
    ].getService(Ci.nsIMsgOfflineManager);
    offlineManager.inProgress = true;
    offlineManager.goOnline(false, true, null);
    await TestUtils.waitForCondition(
      () => !offlineManager.inProgress,
      "The acknowledged unresolved draft is settled locally without another APPEND"
    );
    Assert.equal(IMAPPump.daemon.getMailbox("Drafts")._messages.length, 1);
    const current = gDraftsFolder.msgDatabase.getMsgHdrForKey(key);
    Assert.equal(current.messageKey, gNativeDraft.messageKey);
    Assert.equal(current.folder, gNativeDraft.folder);
    Assert.equal(current.messageId, gNativeDraft.messageId);
    Assert.equal(current.storeToken, gNativeDraft.storeToken);
    Assert.equal(gDraftsFolder.msgDatabase.getMsgHdrForKey(key), current);
    Assert.equal(readNativeDraftBytes(current), gNativeDraftBytes);
    Assert.ok(!gNativeDraft.properties.includes("uidOnServer"));
    Assert.equal(readNativeDraftBytes(gNativeDraft), gNativeDraftBytes);
    Assert.ok(
      operations.getOfflineOpForKey(key, false).operation &
        Ci.nsIMsgOfflineImapOperation.kAppendDraft
    );
  }
);

add_task(async function test_missingAcceptedDraftStillUpdatesFolder() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    return;
  }
  const mailbox = IMAPPump.daemon.getMailbox("Drafts");
  Assert.equal(mailbox._messages.length, 1);
  const key = gNativeDraft.messageKey;
  const token = gNativeDraft.storeToken;
  const operations = gDraftsFolder.msgDatabase.QueryInterface(
    Ci.nsIMsgOfflineOpsDatabase
  );
  const operation = operations.getOfflineOpForKey(key, false).operation;
  // A different client removes the accepted server draft before first SELECT.
  mailbox._messages.splice(0, 1);
  const unrelated = new ImapMessage(
    "data:text/plain," +
      encodeURI(
        "Message-ID: <new-after-missing-draft@example.invalid>\r\n" +
          "Subject: New unrelated draft\r\n\r\nbody\r\n"
      ),
    mailbox.uidnext++,
    []
  );
  mailbox.addMessage(unrelated);
  for (let pass = 0; pass < 2; pass++) {
    const updated = new PromiseTestUtils.PromiseUrlListener();
    const searchStart = gAcceptedAppendSearches.length;
    gDraftsFolder.updateFolderWithListener(null, updated);
    await updated.promise;
    Assert.deepEqual(
      gAcceptedAppendSearches.slice(searchStart),
      [[]],
      "The missing accepted draft has zero genuine Message-ID candidates"
    );
    const current = gDraftsFolder.msgDatabase.getMsgHdrForKey(key);
    Assert.equal(current.messageKey, key);
    Assert.equal(current.storeToken, token);
    Assert.equal(readNativeDraftBytes(current), gNativeDraftBytes);
    Assert.ok(!current.properties.includes("uidOnServer"));
    Assert.equal(
      operations.getOfflineOpForKey(key, false).operation,
      operation
    );
    const members = [...gDraftsFolder.messages];
    Assert.equal(
      members.length,
      2,
      "Retained recovery and actual unrelated server draft both remain"
    );
    const server = members.filter(header =>
      header.properties.includes("uidOnServer")
    );
    Assert.equal(server.length, 1);
    Assert.equal(server[0].getUint32Property("uidOnServer"), unrelated.uid);
    Assert.notEqual(server[0].messageKey, key);
    Assert.equal(
      mailbox._messages.length,
      1,
      "No automatic resend of the deleted accepted draft"
    );
  }
});

add_task(function endTest() {
  teardownIMAPPump();
});

/*
 * helper functions
 */

function WebProgressListener() {
  this._promise = new Promise(resolve => {
    this._resolve = resolve;
  });
}
WebProgressListener.prototype = {
  onStateChange(aWebProgress, aRequest, aStateFlags) {
    if (aStateFlags & Ci.nsIWebProgressListener.STATE_STOP) {
      this._resolve();
    }
  },

  onProgressChange() {},
  onLocationChange() {},
  onStatusChange() {},
  onSecurityChange() {},
  onContentBlockingEvent() {},

  QueryInterface: ChromeUtils.generateQI([
    "nsIWebProgressListener",
    "nsISupportsWeakReference",
  ]),

  get promise() {
    return this._promise;
  },
};
