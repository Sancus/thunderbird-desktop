/* ***** BEGIN LICENSE BLOCK *****
 *
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/licenses/publicdomain/
 *
 * ***** END LICENSE BLOCK ***** */

/**
 * This test checks pseudo-offline message copies (which is triggered
 * by allowUndo == true in copyMessages).
 */

var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

/* import-globals-from ../../../test/resources/logHelper.js */
load("../../../resources/logHelper.js");

var gMsgFile1 = do_get_file("../../../data/bugmail10");
var gMsgId1 = "200806061706.m56H6RWT004933@mrapp54.mozilla.org";
var gMsgFile2 = do_get_file("../../../data/image-attach-test");
var gMsgId2 = "4A947F73.5030709@example.com";
var gMsgFile3 = do_get_file("../../../data/SpamAssassinYes");
var gMsg3Id = "bugmail7.m47LtAEf007543@mrapp51.mozilla.org";
var gMsgFile4 = do_get_file("../../../data/bug460636");
var gMsg4Id = "foo.12345@example";

var gFolder1;

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

var tests = [
  async function setup() {
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
      const expectedStore = {
        "@mozilla.org/msgstore/berkeleystore;1": "mbox",
        "@mozilla.org/msgstore/maildirstore;1": "maildir",
      }[Services.prefs.getCharPref("mail.serverDefaultStoreContractID")];
      Assert.ok(expectedStore);
      Assert.equal(IMAPPump.incomingServer.msgStore.storeType, expectedStore);
    }

    const promiseFolderAdded = PromiseTestUtils.promiseFolderAdded("folder 1");
    IMAPPump.incomingServer.rootFolder.createSubfolder("folder 1", null);
    await promiseFolderAdded;

    gFolder1 = IMAPPump.incomingServer.rootFolder.getChildNamed("folder 1");
    Assert.ok(gFolder1 instanceof Ci.nsIMsgFolder);

    // these hacks are required because we've created the inbox before
    // running initial folder discovery, and adding the folder bails
    // out before we set it as verified online, so we bail out, and
    // then remove the INBOX folder since it's not verified.
    IMAPPump.inbox.hierarchyDelimiter = "/";
    IMAPPump.inbox.verifiedAsOnlineFolder = true;

    // Add messages to the INBOX
    // this is synchronous, afaik
    addMessagesToServer(
      [
        { file: gMsgFile1, messageId: gMsgId1 },
        { file: gMsgFile2, messageId: gMsgId2 },
      ],
      IMAPPump.daemon.getMailbox("INBOX")
    );
  },
  async function updateFolder() {
    const promiseUrlListener = new PromiseTestUtils.PromiseUrlListener();
    IMAPPump.inbox.updateFolderWithListener(null, promiseUrlListener);
    await promiseUrlListener.promise;
  },
  async function downloadAllForOffline() {
    const promiseUrlListener = new PromiseTestUtils.PromiseUrlListener();
    IMAPPump.inbox.downloadAllForOffline(promiseUrlListener, null);
    await promiseUrlListener.promise;
  },
  async function copyMessagesToInbox() {
    let promiseCopyListener = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyFileMessage(
      gMsgFile3,
      IMAPPump.inbox,
      null,
      false,
      0,
      "",
      promiseCopyListener,
      null
    );
    await promiseCopyListener.promise;

    promiseCopyListener = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyFileMessage(
      gMsgFile4,
      IMAPPump.inbox,
      null,
      false,
      0,
      "",
      promiseCopyListener,
      null
    );
    await promiseCopyListener.promise;

    const promiseUrlListener = new PromiseTestUtils.PromiseUrlListener();
    IMAPPump.inbox.updateFolderWithListener(null, promiseUrlListener);
    await promiseUrlListener.promise;

    if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
      // These assertions exercise cached pseudo-offline copies. The online
      // file-APPEND inputs must have real downloaded bodies in the native store.
      const downloaded = new PromiseTestUtils.PromiseUrlListener();
      IMAPPump.inbox.downloadAllForOffline(downloaded, null);
      await downloaded.promise;
      for (const message of IMAPPump.inbox.msgDatabase.enumerateMessages()) {
        Assert.ok(message.flags & Ci.nsMsgMessageFlags.Offline);
        Assert.ok(message.storeToken);
      }
    }

    const db = IMAPPump.inbox.msgDatabase;

    // test the headers in the inbox
    let count = 0;
    for (const message of db.enumerateMessages()) {
      count++;
      message instanceof Ci.nsIMsgDBHdr;
      dump(
        "message <" +
          message.subject +
          "> storeToken: <" +
          message.storeToken +
          "> id: <" +
          message.messageId +
          ">\n"
      );
    }
    Assert.equal(count, 4);
  },
  function copyMessagesToSubfolder() {
    //  a message created from IMAP download
    let db = IMAPPump.inbox.msgDatabase;
    const msg1 = db.getMsgHdrForMessageID(gMsgId1);
    // this is sync, I believe?
    MailServices.copy.copyMessages(
      IMAPPump.inbox,
      [msg1],
      gFolder1,
      false,
      null,
      null,
      true
    );

    // two messages originally created from file copies (like in Send)
    const msg3 = db.getMsgHdrForMessageID(gMsg3Id);
    Assert.ok(msg3 instanceof Ci.nsIMsgDBHdr);
    MailServices.copy.copyMessages(
      IMAPPump.inbox,
      [msg3],
      gFolder1,
      false,
      null,
      null,
      true
    );

    // test the db headers in folder1
    db = gFolder1.msgDatabase;
    let count = 0;
    for (const message of db.enumerateMessages()) {
      count++;
      message instanceof Ci.nsIMsgDBHdr;
      dump(
        "message <" +
          message.subject +
          "> storeToken: <" +
          message.storeToken +
          "> id: <" +
          message.messageId +
          ">\n"
      );
    }
    Assert.equal(count, 2);
  },
  async function test_headers() {
    const msgIds = [gMsgId1, gMsg3Id];
    for (const msgId of msgIds) {
      const newMsgHdr = gFolder1.msgDatabase.getMsgHdrForMessageID(msgId);
      Assert.ok(newMsgHdr.flags & Ci.nsMsgMessageFlags.Offline);
      if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
        const source = IMAPPump.inbox.msgDatabase.getMsgHdrForMessageID(msgId);
        Assert.ok(source);
        Assert.notEqual(newMsgHdr.messageKey, source.messageKey);
        Assert.equal(newMsgHdr.folder, gFolder1);
        Assert.ok(!newMsgHdr.properties.includes("uidOnServer"));
        for (const property of [
          "storeToken",
          "messageSize",
          "offlineMessageSize",
          "lineCount",
        ]) {
          Assert.ok(
            newMsgHdr.properties.includes(property),
            `${property} is present`
          );
        }
        const counterpart = gFolder1.msgDatabase
          .QueryInterface(Ci.nsIMsgOfflineOpsDatabase)
          .getOfflineOpForKey(newMsgHdr.messageKey, false);
        Assert.ok(
          counterpart,
          "The allocated physical member has its operation"
        );
        Assert.equal(counterpart.messageKey, newMsgHdr.messageKey);
        Assert.equal(counterpart.sourceFolderURI, IMAPPump.inbox.URI);
        Assert.equal(counterpart.srcMessageKey, source.messageKey);
        Assert.ok(
          counterpart.operation & Ci.nsIMsgOfflineImapOperation.kMoveResult
        );
        const queued = IMAPPump.inbox.msgDatabase
          .QueryInterface(Ci.nsIMsgOfflineOpsDatabase)
          .getOfflineOpForKey(source.messageKey, false);
        Assert.ok(queued);
        Assert.ok(queued.operation & Ci.nsIMsgOfflineImapOperation.kMsgCopy);
        Assert.equal(queued.getCopyDestination(0), gFolder1.URI);
        Assert.equal(queued.srcUid, source.getUint32Property("uidOnServer"));
      }
      const msgURI = newMsgHdr.folder.getUriForMsg(newMsgHdr);
      const msgServ = MailServices.messageServiceFromURI(msgURI);
      const promiseStreamListener =
        new PromiseTestUtils.PromiseStreamListener();
      msgServ.streamHeaders(msgURI, promiseStreamListener, null, true);
      const data = await promiseStreamListener.promise;
      dump("\nheaders for messageId " + msgId + "\n" + data + "\n\n");
      Assert.ok(data.includes(msgId));
    }
  },
  function moveMessagesToSubfolder() {
    const db = IMAPPump.inbox.msgDatabase;
    const messages = [...db.enumerateMessages()];
    Assert.greater(messages.length, 0);
    if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
      for (const message of messages) {
        const input = IMAPPump.inbox.getMsgInputStream(message);
        const reader = Cc[
          "@mozilla.org/scriptableinputstream;1"
        ].createInstance(Ci.nsIScriptableInputStream);
        reader.init(input);
        let bytes = 0;
        try {
          while (reader.available()) {
            bytes += reader.read(reader.available()).length;
          }
        } finally {
          reader.close();
        }
        info(
          `Queued source ${message.messageKey}: token=${message.storeToken}, ` +
            `size=${message.messageSize}, offline=${message.offlineMessageSize}, actual=${bytes}`
        );
      }
    }
    // this is sync, I believe?
    MailServices.copy.copyMessages(
      IMAPPump.inbox,
      messages,
      gFolder1,
      true,
      null,
      null,
      true
    );

    // the inbox should now be empty
    Assert.equal([...db.enumerateMessages()].length, 0);

    // maildir should also delete the files.
    if (IMAPPump.inbox.msgStore.storeType == "maildir") {
      const curDir = IMAPPump.inbox.filePath.clone();
      curDir.append("cur");
      Assert.ok(curDir.exists());
      Assert.ok(curDir.isDirectory());
      const curEnum = curDir.directoryEntries;
      // the directory should be empty, fails from bug 771643
      Assert.ok(!curEnum.hasMoreElements());
    }
  },
  teardownIMAPPump,
];

function run_test() {
  tests.forEach(x => add_task(x));
  run_next_test();
}
