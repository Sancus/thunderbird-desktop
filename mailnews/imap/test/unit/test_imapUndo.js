/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// This file tests undoing of an imap delete to the trash.
// There are three main cases:
// 1. Normal undo
// 2. Undo after the source folder has been compacted.
// 2.1 Same, but the server doesn't support COPYUID (GMail case)
//
// Original Author: David Bienvenu <bienvenu@nventure.com>

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

var gRootFolder;
var gMessages = [];
var gMsgWindow;
let uncachedSourceKey;
let uncachedSourceUid;
let sourceReferences;
let expectedRecoveryRefusal = false;

var gMsgFile1 = do_get_file("../../../data/bugmail10");
var gMsgFile2 = do_get_file("../../../data/bugmail11");
// var gMsgFile3 = do_get_file("../../../data/draft1");
var gMsgFile4 = do_get_file("../../../data/bugmail7");
var gMsgFile5 = do_get_file("../../../data/bugmail6");

// Copied straight from the example files
var gMsgId1 = "200806061706.m56H6RWT004933@mrapp54.mozilla.org";
var gMsgId2 = "200804111417.m3BEHTk4030129@mrapp51.mozilla.org";
// var gMsgId3 = "4849BF7B.2030800@example.com";
var gMsgId4 = "bugmail7.m47LtAEf007542@mrapp51.mozilla.org";
var gMsgId5 = "bugmail6.m47LtAEf007542@mrapp51.mozilla.org";

// Adds some messages directly to a mailbox (eg new mail)
function addMessagesToServer(messages, mailbox) {
  // For every message we have, we need to convert it to a file:/// URI
  messages.forEach(function (message) {
    const URI = Services.io
      .newFileURI(message.file)
      .QueryInterface(Ci.nsIFileURL);
    // Create the ImapMessage and store it on the mailbox.
    mailbox.addMessage(new ImapMessage(URI.spec, mailbox.uidnext++, []));
  });
}

function alertListener() {}

alertListener.prototype = {
  reset() {},

  onAlert(aMessage) {
    if (expectedRecoveryRefusal) {
      return true;
    }
    throw new Error("got alert - TEST FAILED " + aMessage);
  },
};

add_setup(async function () {
  setupIMAPPump();
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

  var listener1 = new alertListener();

  MailServices.mailSession.addUserFeedbackListener(listener1);

  Services.prefs.setBoolPref(
    "mail.server.server1.autosync_offline_stores",
    false
  );
  Services.prefs.setBoolPref("mail.server.server1.offline_download", false);

  gMsgWindow = Cc["@mozilla.org/messenger/msgwindow;1"].createInstance(
    Ci.nsIMsgWindow
  );

  gRootFolder = IMAPPump.incomingServer.rootFolder;
  // these hacks are required because we've created the inbox before
  // running initial folder discovery, and adding the folder bails
  // out before we set it as verified online, so we bail out, and
  // then remove the INBOX folder since it's not verified.
  IMAPPump.inbox.hierarchyDelimiter = "/";
  IMAPPump.inbox.verifiedAsOnlineFolder = true;

  // Add a couple of messages to the INBOX
  // this is synchronous, afaik
  addMessagesToServer(
    [
      { file: gMsgFile1, messageId: gMsgId1 },
      { file: gMsgFile4, messageId: gMsgId4 },
      { file: gMsgFile5, messageId: gMsgId5 },
      { file: gMsgFile2, messageId: gMsgId2 },
    ],
    IMAPPump.mailbox
  );
});

add_task(async function updateFolder() {
  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, listener);
  await listener.promise;
});

add_task(async function test_onlineRecoveryRefusalRetainsUncachedSource() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    return;
  }
  const source = IMAPPump.inbox;
  const header = source.msgDatabase.getMsgHdrForMessageID(gMsgId1);
  const key = header.messageKey;
  const uid = header.getUint32Property("uidOnServer");
  Assert.equal(header.flags & Ci.nsMsgMessageFlags.Offline, 0);
  const destination = await createImapSubfolder("OnlineRecoveryRefusal");
  let refusals = 0;
  let completions = 0;
  const proto = IMAP_RFC3501_handler.prototype;
  const originalFetch = proto.FETCH;
  const listener = new PromiseTestUtils.PromiseCopyListener({
    onStopCopy(status) {
      completions++;
      Assert.equal(status, 0x80550021);
    },
  });
  expectedRecoveryRefusal = true;
  proto.FETCH = function (args, idsAreUids) {
    if (idsAreUids && String(args[0]) == String(uid)) {
      refusals++;
      return "NO refused online undo recovery";
    }
    return originalFetch.call(this, args, idsAreUids);
  };
  try {
    MailServices.copy.copyMessages(
      source,
      [header],
      destination,
      true,
      listener,
      gMsgWindow,
      true
    );
    await Assert.rejects(
      listener.promise,
      error => error.message == String(0x80550021)
    );
    Assert.equal(refusals, 1);
    Assert.equal(completions, 1);
    Assert.equal(source.msgDatabase.containsKey(key), true);
    Assert.equal(header.getUint32Property("uidOnServer"), uid);
    Assert.equal(header.flags & Ci.nsMsgMessageFlags.Offline, 0);
    Assert.equal(source.getTotalMessages(false), 4);
    Assert.equal(destination.getTotalMessages(false), 0);
    Assert.equal(MailServices.txns.transactionManager.numberOfUndoItems, 0);
  } finally {
    proto.FETCH = originalFetch;
    expectedRecoveryRefusal = false;
  }
});

add_task(async function deleteMessage() {
  const msgToDelete = IMAPPump.inbox.msgDatabase.getMsgHdrForMessageID(gMsgId1);
  const copyListener = new PromiseTestUtils.PromiseCopyListener();
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    Assert.equal(msgToDelete.flags & Ci.nsMsgMessageFlags.Offline, 0);
    uncachedSourceKey = msgToDelete.messageKey;
    uncachedSourceUid = msgToDelete.getUint32Property("uidOnServer");
    sourceReferences = Array.from(
      { length: msgToDelete.numReferences },
      (_, i) => msgToDelete.getStringReference(i)
    );
  }
  gMessages.push(msgToDelete);
  IMAPPump.inbox.deleteMessages(
    gMessages,
    gMsgWindow,
    false,
    true,
    copyListener,
    true
  );
  await copyListener.promise;
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    Assert.equal(
      IMAPPump.inbox.msgDatabase.containsKey(uncachedSourceKey),
      false
    );
    Assert.equal(MailServices.txns.transactionManager.numberOfUndoItems, 1);
  }
});

add_task(async function expunge() {
  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.expunge(listener, gMsgWindow);
  await listener.promise;

  // Ensure that the message has been surely deleted.
  Assert.equal(IMAPPump.inbox.msgDatabase.dBFolderInfo.numMessages, 3);
});

add_task(async function undoDelete() {
  const transactions = MailServices.txns.transactionManager;
  const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  const source = IMAPPump.inbox;
  let operations;
  let transaction;
  const published = [];
  let added;
  if (native) {
    operations = source.msgDatabase.QueryInterface(Ci.nsIMsgOfflineOpsDatabase);
    const queued = operations.getOfflineOpForKey(uncachedSourceKey, false);
    Assert.ok(queued);
    Assert.ok(queued.operation & Ci.nsIMsgOfflineImapOperation.kMsgMoved);
    Assert.equal(queued.srcUid, uncachedSourceUid);
    transaction = transactions.peekUndoStack();
    added = {
      QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
      onHdrFlagsChanged() {},
      onHdrDeleted() {},
      onParentChanged() {},
      onAnnouncerGoingAway() {},
      onReadChanged() {},
      onJunkScoreChanged() {},
      onHdrPropertyChanged() {},
      onEvent() {},
      onHdrAdded(header) {
        published.push(header.messageKey);
        Assert.notEqual(header.messageKey, uncachedSourceKey);
        Assert.equal(
          header.getUint32Property("uidOnServer"),
          uncachedSourceUid
        );
        const remaining = operations.getOfflineOpForKey(
          header.messageKey,
          false
        );
        Assert.equal(
          (remaining?.operation ?? 0) & Ci.nsIMsgOfflineImapOperation.kMsgMoved,
          0,
          "The selected unsent MOVE is cancelled before source publication"
        );
        Assert.throws(
          () => transaction.undoTransaction(),
          /NS_ERROR_IN_PROGRESS/
        );
        Assert.throws(
          () => transaction.redoTransaction(),
          /NS_ERROR_IN_PROGRESS/
        );
      },
    };
    source.msgDatabase.addListener(added);
  }
  try {
    transactions.undoTransaction();
  } finally {
    if (added) {
      source.msgDatabase.removeListener(added);
    }
  }
  if (native) {
    const restored = source.msgDatabase.getMsgHdrForMessageID(gMsgId1);
    Assert.ok(restored);
    Assert.notEqual(restored.messageKey, uncachedSourceKey);
    Assert.ok(restored.flags & Ci.nsMsgMessageFlags.Offline);
    Assert.deepEqual(
      Array.from({ length: restored.numReferences }, (_, i) =>
        restored.getStringReference(i)
      ),
      sourceReferences
    );
    const stream = IMAPPump.inbox.getMsgInputStream(restored);
    const input = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    input.init(stream);
    let body = "";
    for (;;) {
      const chunk = input.read(8192);
      if (!chunk) {
        break;
      }
      body += chunk;
    }
    stream.close();
    Assert.equal(body.length, restored.offlineMessageSize);
    Assert.ok(body.includes(gMsgId1));
    const firstKey = restored.messageKey;
    Assert.deepEqual(published, [firstKey]);
    transactions.redoTransaction();
    Assert.equal(source.msgDatabase.containsKey(firstKey), false);
    const redone = operations.getOfflineOpForKey(firstKey, false);
    Assert.ok(redone, "Redo retains the saved initiating MOVE intent");
    Assert.ok(redone.operation & Ci.nsIMsgOfflineImapOperation.kMsgMoved);
    Assert.equal(redone.srcUid, uncachedSourceUid);
    Assert.equal(source.getTotalMessages(false), 3);
    source.msgDatabase.addListener(added);
    try {
      transactions.undoTransaction();
    } finally {
      source.msgDatabase.removeListener(added);
    }
    const again = source.msgDatabase.getMsgHdrForMessageID(gMsgId1);
    Assert.notEqual(again.messageKey, firstKey);
    Assert.deepEqual(published, [firstKey, again.messageKey]);
    Assert.equal(again.getUint32Property("uidOnServer"), uncachedSourceUid);
    Assert.equal(source.getTotalMessages(false), 4);
    Assert.equal(operations.getOfflineOpForKey(firstKey, false), null);
    const againStream = source.getMsgInputStream(again);
    const againInput = Cc[
      "@mozilla.org/scriptableinputstream;1"
    ].createInstance(Ci.nsIScriptableInputStream);
    againInput.init(againStream);
    let againBody = "";
    try {
      for (;;) {
        const chunk = againInput.read(8192);
        if (!chunk) {
          break;
        }
        againBody += chunk;
      }
    } finally {
      againInput.close();
    }
    Assert.equal(againBody, body, "Repeated Undo retains exact recovery bytes");
    Assert.equal(againBody.length, again.offlineMessageSize);
  }
  // after undo, we select the trash and then the inbox, so that we sync
  // up with the server, and clear out the effects of having done the
  // delete offline.
  const listener = new PromiseTestUtils.PromiseUrlListener();
  const trash = gRootFolder.getChildNamed("Trash");
  trash
    .QueryInterface(Ci.nsIMsgImapMailFolder)
    .updateFolderWithListener(null, listener);
  await listener.promise;
});

add_task(async function goBackToInbox() {
  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(gMsgWindow, listener);
  await listener.promise;
});

add_task(function verifyFolders() {
  const msgRestored = IMAPPump.inbox.msgDatabase.getMsgHdrForMessageID(gMsgId1);
  Assert.notStrictEqual(msgRestored, null);
  Assert.equal(IMAPPump.inbox.msgDatabase.dBFolderInfo.numMessages, 4);
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    Assert.notEqual(msgRestored.messageKey, uncachedSourceKey);
    Assert.ok(msgRestored.flags & Ci.nsMsgMessageFlags.Offline);
    Assert.greater(msgRestored.offlineMessageSize, 0);
    Assert.deepEqual(
      Array.from({ length: msgRestored.numReferences }, (_, i) =>
        msgRestored.getStringReference(i)
      ),
      sourceReferences
    );
    const body = IMAPPump.inbox.getMsgInputStream(msgRestored);
    Assert.greater(body.available(), 0);
    body.close();
  }
});

add_task(function endTest() {
  // Cleanup, null out everything, close all cached connections and stop the
  // server
  gMessages = [];
  gMsgWindow = null;
  gRootFolder = null;
  teardownIMAPPump();
});
