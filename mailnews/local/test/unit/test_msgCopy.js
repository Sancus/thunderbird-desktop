/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

/**
 * Test setting keywords with copyFileMessage().
 */
add_task(async function test_fileCopySetKeywords() {
  localAccountUtils.loadLocalMailAccount();
  try {
    const inbox = localAccountUtils.inboxFolder;

    const copyListener = new PromiseTestUtils.PromiseCopyListener();
    const bugmail11 = do_get_file("../../../data/bugmail11");
    const tag1 = "istag";
    MailServices.copy.copyFileMessage(
      bugmail11,
      inbox,
      null,
      false,
      0 /* message flags */,
      tag1 /* keywords */,
      copyListener,
      null /* window */
    );
    const copied = await copyListener.promise;

    // Check the keywords on the copied message.
    const msg = inbox.GetMessageHeader(copied.messageKeys[0]);
    Assert.equal(msg.getStringProperty("keywords"), tag1);
  } finally {
    localAccountUtils.clearAll();
  }
});

/**
 * Keep a completed destination and its source when native IMAP undo is refused.
 *
 * @param {string} storeType - Local mbox or maildir provider.
 */
async function checkUnsupportedImapMoveUndo(storeType) {
  const { IMAPPump, setupIMAPPump, teardownIMAPPump } =
    ChromeUtils.importESModule(
      "resource://testing-common/mailnews/IMAPpump.sys.mjs"
    );
  const { ImapMessage } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/Imapd.sys.mjs"
  );
  const accountKeys = new Set(
    MailServices.accounts.accounts.map(account => account.key)
  );
  const prefs = [
    "mail.serverDefaultStoreContractID",
    "mail.server.default.storeContractID",
  ].map(name => ({
    name,
    hadValue: Services.prefs.prefHasUserValue(name),
    value: Services.prefs.getCharPref(name, ""),
  }));
  const contract =
    storeType == "mbox"
      ? "@mozilla.org/msgstore/berkeleystore;1"
      : "@mozilla.org/msgstore/maildirstore;1";
  let started = false;
  try {
    for (const { name } of prefs) {
      Services.prefs.setCharPref(name, contract);
    }
    localAccountUtils.loadLocalMailAccount();
    const database = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    );
    Assert.ok(database instanceof Ci.nsIDatabaseCore);
    const destination = localAccountUtils.rootFolder.createLocalSubfolder(
      "unsupported-native-move"
    );
    Assert.equal(destination.msgStore.storeType, storeType);
    Assert.equal(destination.server.msgStore.storeType, storeType);
    setupIMAPPump();
    started = true;
    const root = IMAPPump.incomingServer.rootFolder;
    const discovered = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.discoverAllFolders(root, discovered, null);
    await discovered.promise;
    const inbox = root.getChildNamed("INBOX");
    Assert.ok(inbox);
    Assert.equal(inbox.parent, root);
    Assert.equal(inbox.server, IMAPPump.incomingServer);
    IMAPPump.inbox = inbox.QueryInterface(Ci.nsIMsgImapMailFolder);
    IMAPPump.incomingServer.setBoolValue("autosync_offline_stores", false);
    const raw =
      "From: sender@example.invalid\r\n" +
      "Subject: Unsupported native move undo\r\n" +
      "Message-ID: <unsupported-local-move@example.invalid>\r\n" +
      "References: <first@example.invalid> <second@example.invalid>\r\n\r\n" +
      "Exact retained IMAP source body.\r\n";
    const file = do_get_profile();
    file.append(`unsupported-native-move-${storeType}.eml`);
    await IOUtils.writeUTF8(file.path, raw);
    const serverMessage = new ImapMessage(
      Services.io.newFileURI(file).spec,
      IMAPPump.mailbox.uidnext++,
      ["\\Seen", "\\Flagged"]
    );
    IMAPPump.mailbox.addMessage(serverMessage);
    const update = new PromiseTestUtils.PromiseUrlListener();
    inbox.updateFolderWithListener(null, update);
    await update.promise;
    const source = inbox.msgDatabase.getMsgHdrForMessageID(
      "unsupported-local-move@example.invalid"
    );
    const key = source.messageKey;
    const flags = source.flags;
    const token = source.storeToken;
    const size = source.messageSize;
    const uid = source.getUint32Property("uidOnServer");
    Assert.equal(uid, serverMessage.uid);
    Assert.notEqual(key, uid);
    source.setStringProperty("copyErrorProperty", "exact retained value");
    const stops = [];
    const copied = new PromiseTestUtils.PromiseCopyListener({
      onStopCopy(status) {
        stops.push(status);
      },
    });
    MailServices.copy.copyMessages(
      inbox,
      [source],
      destination,
      true,
      copied,
      null,
      true
    );
    await Assert.rejects(
      copied.promise,
      error => Number(error.message) === Cr.NS_ERROR_NOT_IMPLEMENTED
    );
    Assert.deepEqual(stops, [Cr.NS_ERROR_NOT_IMPLEMENTED]);
    Assert.deepEqual(inbox.msgDatabase.listAllKeys(), [key]);
    const retained = inbox.msgDatabase.getMsgHdrForKey(key);
    Assert.equal(retained.storeToken, token);
    Assert.equal(retained.flags, flags);
    Assert.equal(retained.messageSize, size);
    Assert.equal(retained.getUint32Property("uidOnServer"), uid);
    Assert.equal(
      retained.getStringProperty("copyErrorProperty"),
      "exact retained value"
    );
    Assert.ok(!serverMessage.flags.includes("\\Deleted"));
    Assert.equal(await IOUtils.readUTF8(file.path), raw);
    const keys = destination.msgDatabase.listAllKeys();
    Assert.equal(keys.length, 1);
    const finished = destination.msgDatabase.getMsgHdrForKey(keys[0]);
    Assert.notEqual(finished.messageKey, key);
    Assert.equal(finished.messageId, source.messageId);
    Assert.equal(finished.flags, flags & ~Ci.nsMsgMessageFlags.Offline);
    Assert.equal(
      finished.getStringProperty("copyErrorProperty"),
      "exact retained value"
    );
    Assert.equal(finished.numReferences, 2);
    Assert.equal(finished.getStringReference(0), "first@example.invalid");
    Assert.equal(finished.getStringReference(1), "second@example.invalid");
    Assert.notEqual(finished.storeToken, ""); // A zero mbox token is valid.
    const body = mailTestUtils.loadMessageToString(destination, finished);
    // WriteStartOfNewMessage uses MSG_LINEBREAK and the exact 80-space blank
    // from nsMsgLocalFolderHdrs.h; the IMAP body itself uses canonical CRLF.
    const eol = Services.appinfo.OS == "WINNT" ? "\r\n" : "\n";
    const storedFlags = (flags & ~Ci.nsMsgMessageFlags.RuntimeOnly & 0xffff)
      .toString(16)
      .padStart(4, "0");
    const prefix =
      `X-Mozilla-Status: ${storedFlags}${eol}` +
      `X-Mozilla-Status2: 00000000${eol}` +
      `X-Mozilla-Keys: ${" ".repeat(80)}${eol}`;
    Assert.equal(body, prefix + raw);
    Assert.equal(finished.messageSize, body.length);
    const path =
      storeType == "mbox"
        ? destination.filePath.path
        : PathUtils.join(destination.filePath.path, "cur", finished.storeToken);
    const bytes = await IOUtils.read(path);
    Assert.greater(bytes.length, 0);
    Assert.ok(!destination.locked);
    Assert.ok(!inbox.locked);
  } finally {
    try {
      if (started) {
        teardownIMAPPump();
      }
    } finally {
      localAccountUtils.clearAll();
      for (const account of MailServices.accounts.accounts) {
        if (!accountKeys.has(account.key)) {
          MailServices.accounts.removeAccount(account);
        }
      }
      for (const { name, hadValue, value } of prefs) {
        if (hadValue) {
          Services.prefs.setCharPref(name, value);
        } else {
          Services.prefs.clearUserPref(name);
        }
      }
    }
  }
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_imapMoveUnsupportedUndoMbox() {
    await checkUnsupportedImapMoveUndo("mbox");
  });
  add_task(async function test_imapMoveUnsupportedUndoMaildir() {
    await checkUnsupportedImapMoveUndo("maildir");
  });
}
