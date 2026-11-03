/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Test content length for the IMAP protocol. This focuses on necko URLs
 * that are run externally.
 */

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

var gMsgHdr = null;

// Take a multipart message as we're testing attachment URLs as well
var gFile = do_get_file("../../../data/multipart-complex2");

add_setup(async function () {
  setupIMAPPump();
  const listener = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(
    IMAPPump.incomingServer.rootFolder,
    listener,
    null
  );
  await listener.promise;
  IMAPPump.inbox = IMAPPump.incomingServer.rootFolder
    .getChildNamed("INBOX")
    .QueryInterface(Ci.nsIMsgImapMailFolder);

  // Set up nsIMsgFolderListener to get the header when it's received
  MailServices.mfn.addListener(msgAddedListener, MailServices.mfn.msgAdded);

  IMAPPump.inbox.clearFlag(Ci.nsMsgFolderFlags.Offline);
});

// Adds some messages directly to a mailbox (eg new mail)
add_task(async function addMessageToServer() {
  const URI = Services.io.newFileURI(gFile).QueryInterface(Ci.nsIFileURL);
  IMAPPump.mailbox.addMessage(new ImapMessage(URI.spec, 6101, []));

  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, listener);
  await listener.promise;
});

function MsgAddedListener() {
  this._promise = new Promise(resolve => {
    this._resolve = resolve;
  });
}
MsgAddedListener.prototype = {
  msgAdded(aMsgHdr) {
    gMsgHdr = aMsgHdr;
    this._resolve();
  },
  get promise() {
    return this._promise;
  },
};
var msgAddedListener = new MsgAddedListener();

add_task(async function verifyContentLength() {
  await msgAddedListener.promise;
  const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  if (native) {
    Assert.equal(gMsgHdr.getUint32Property("uidOnServer"), 6101);
    Assert.notEqual(gMsgHdr.messageKey, 6101);
  }
  const messageUri = IMAPPump.inbox.getUriForMsg(gMsgHdr);
  // Convert this to a URI that necko can run
  const messageService = MailServices.messageServiceFromURI(messageUri);
  const neckoURL = messageService.getUrlForUri(messageUri);
  // Don't use the necko URL directly. Instead, get the spec and create a new
  // URL using the IO service
  const urlToRun = Services.io.newURI(neckoURL.spec);

  // Get a channel from this URI, and check its content length
  const channel = Services.io.newChannelFromURI(
    urlToRun,
    null,
    Services.scriptSecurityManager.getSystemPrincipal(),
    null,
    Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
    Ci.nsIContentPolicy.TYPE_OTHER
  );
  Assert.equal(channel.contentLength, gFile.fileSize);
  if (native) {
    Assert.equal(urlToRun.QueryInterface(Ci.nsIMsgMessageUrl).uri, messageUri);
  }

  // Now try an attachment. &part=1.2
  const attachmentURL = Services.io.newURI(neckoURL.spec + "&part=1.2");
  const attachmentChannel = Services.io.newChannelFromURI(
    attachmentURL,
    null,
    Services.scriptSecurityManager.getSystemPrincipal(),
    null,
    Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
    Ci.nsIContentPolicy.TYPE_OTHER
  );
  // Currently attachments have their content length set to the length of the
  // entire message
  Assert.equal(attachmentChannel.contentLength, gFile.fileSize);
  if (native) {
    Assert.equal(
      attachmentURL.QueryInterface(Ci.nsIMsgMessageUrl).uri,
      messageUri + "?part=1.2"
    );
    gMsgHdr.setUint32Property("uidOnServer", 0);
    try {
      Assert.throws(
        () =>
          Services.io.newChannelFromURI(
            urlToRun,
            null,
            Services.scriptSecurityManager.getSystemPrincipal(),
            null,
            Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
            Ci.nsIContentPolicy.TYPE_OTHER
          ),
        error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
      );
      Assert.equal(gMsgHdr.storeToken, "");
      Assert.equal(gMsgHdr.flags & Ci.nsMsgMessageFlags.Offline, 0);
    } finally {
      gMsgHdr.setUint32Property("uidOnServer", 6101);
    }
  }
});

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(function test_messageSizeLookupUsesPhysicalHeader() {
    const folder = IMAPPump.inbox;
    const database = folder.msgDatabase;
    const sink = folder.QueryInterface(Ci.nsIImapMessageSink);
    const folderSink = folder.QueryInterface(Ci.nsIImapMailFolderSink);
    const uid = gMsgHdr.getUint32Property("uidOnServer");
    const key = gMsgHdr.messageKey;
    const epoch = database.dBFolderInfo.imapUidValidity;
    const size = gMsgHdr.messageSize;
    const source = {
      messageId: gMsgHdr.messageId,
      flags: gMsgHdr.flags,
      storeToken: gMsgHdr.storeToken,
      count: folder.getTotalMessages(false),
    };
    Assert.equal(uid, 6101);
    Assert.notEqual(key, uid);
    Assert.greater(size, 0);
    Assert.equal(size, gFile.fileSize);
    Assert.equal(folderSink.uidValidity, epoch);
    Assert.equal(sink.getMessageSizeFromDB(uid), size);
    Assert.throws(
      () => sink.getMessageSizeFromDB(0),
      error => error.result == Cr.NS_ERROR_INVALID_ARG
    );
    for (const absentUid of [key, uid + 1]) {
      Assert.throws(
        () => sink.getMessageSizeFromDB(absentUid),
        error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
      );
    }
    try {
      gMsgHdr.setUint32Property("uidOnServer", 0);
      Assert.throws(
        () => sink.getMessageSizeFromDB(uid),
        error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
      );
    } finally {
      gMsgHdr.setUint32Property("uidOnServer", uid);
    }
    Assert.equal(sink.getMessageSizeFromDB(uid), size);
    try {
      folderSink.uidValidity = epoch + 1;
      Assert.equal(database.dBFolderInfo.imapUidValidity, epoch);
      Assert.throws(
        () => sink.getMessageSizeFromDB(uid),
        error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
      );
    } finally {
      folderSink.uidValidity = epoch;
    }
    for (let retry = 0; retry < 2; retry++) {
      Assert.equal(sink.getMessageSizeFromDB(uid), size);
      const retained = database.getMsgHdrForKey(key);
      Assert.equal(retained.messageKey, key);
      Assert.equal(retained.folder, folder);
      Assert.equal(retained.getUint32Property("uidOnServer"), uid);
      Assert.equal(retained.messageSize, size);
      Assert.equal(retained.messageId, source.messageId);
      Assert.equal(retained.flags, source.flags);
      Assert.equal(retained.storeToken, source.storeToken);
      Assert.equal(folder.getTotalMessages(false), source.count);
      Assert.equal(database.dBFolderInfo.imapUidValidity, epoch);
    }
  });
}

add_task(function endTest() {
  MailServices.mfn.removeListener(msgAddedListener);
  teardownIMAPPump();
});
