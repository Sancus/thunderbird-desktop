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
    IMAPPump.mailbox.addMessage(new ImapMessage(uri.spec, sourceUid, []));
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
    Assert.equal(operation.getCopyDestination(0), targets[0].URI);
    Assert.equal(operation.getCopyDestination(1), targets[1].URI);
    Assert.equal(operation.destinationFolderURI, targets[2].URI);
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
