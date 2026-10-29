/**
 * Test bug 92111 - imap download-by-chunks doesn't download complete file if the
 * server lies about rfc822.size (known to happen for Exchange and gmail)
 */

const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

const { ServerTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ServerTestUtils.sys.mjs"
);

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
