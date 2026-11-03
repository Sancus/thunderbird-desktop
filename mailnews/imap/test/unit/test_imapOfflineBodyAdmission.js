/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server.js */

const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
const MESSAGE_ID = "physical-body-admission@example.invalid";
const GM_ID = "1278455344230334865";
const RAW = [
  "From: sender@example.invalid",
  "To: recipient@example.invalid",
  "Date: Thu, 01 Oct 2026 12:00:00 +0000",
  "Message-ID: <" + MESSAGE_ID + ">",
  "Subject: Physical body admission",
  "",
  "Body from the actual cached folder.",
  "",
].join("\r\n");
const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
// StartNewOfflineMessage inserts these fields with the platform line ending.
const STORE_HEADERS = [
  "X-Mozilla-Status: 0001",
  "X-Mozilla-Status2: 00000000",
  "",
].join(AppConstants.platform == "win" ? "\r\n" : "\n");
let core;

add_setup(async function () {
  const contract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  Services.prefs.setCharPref("mail.server.default.storeContractID", contract);
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
  Services.prefs.setBoolPref("mail.biff.alert.show_preview", false);
  setupIMAPPump("GMail");
  registerCleanupFunction(teardownIMAPPump);
  core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  );
  Assert.ok(core instanceof Ci.nsIMsgDBService);
  Assert.equal(
    IMAPPump.incomingServer.msgStore.storeType,
    {
      "@mozilla.org/msgstore/berkeleystore;1": "mbox",
      "@mozilla.org/msgstore/maildirstore;1": "maildir",
    }[contract]
  );
  IMAPPump.daemon.createMailbox("[Gmail]", { flags: ["\\NoSelect"] });
  IMAPPump.daemon.createMailbox("[Gmail]/All Mail", {
    subscribed: true,
    specialUseFlag: "\\AllMail",
  });
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
  Assert.ok(IMAPPump.incomingServer.isGMailServer);
  Assert.equal(
    IMAPPump.inbox.msgStore.storeType,
    IMAPPump.incomingServer.msgStore.storeType
  );
});

add_task(async function test_ownOfflineAvailabilityPropagatesAdmissionErrors() {
  const state = await createBody("AdmissionOwn", "");
  Assert.equal(state.folder.hasMsgOffline(state.header.messageKey), false);
  await download(state);
  Assert.equal(state.folder.hasMsgOffline(state.header.messageKey), true);
  const token = state.header.storeToken;
  const flags = state.header.flags;
  const connection = core.connectionForTests;
  connection.executeSimpleSQL(
    "ALTER TABLE body_relocations RENAME TO hidden_imap_relocations"
  );
  try {
    Assert.throws(
      () => state.folder.hasMsgOffline(state.header.messageKey),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.equal(state.header.flags, flags);
    Assert.throws(
      () => state.header.storeToken,
      error => error.result == Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE hidden_imap_relocations RENAME TO body_relocations"
    );
  }
  Assert.equal(state.header.storeToken, token);
  Assert.equal(state.folder.hasMsgOffline(state.header.messageKey), true);
  Assert.equal(readBody(state), STORE_HEADERS + RAW);
});

add_task(
  async function test_gmailUsesTheOtherPhysicalHeaderAndRetainsLookupErrors() {
    const cached = await createBody("AdmissionCached", "");
    const source = await createBody("AdmissionLabel", "AdmissionCached");
    Assert.notEqual(source.header.messageKey, cached.header.messageKey);
    Assert.equal(source.header.getUint32Property("uidOnServer"), 5101);
    Assert.equal(cached.header.getUint32Property("uidOnServer"), 5101);
    Assert.equal(source.header.getStringProperty("X-GM-MSGID"), GM_ID);
    Assert.equal(cached.header.getStringProperty("X-GM-MSGID"), GM_ID);
    Assert.ok(
      source.header
        .getStringProperty("X-GM-LABELS")
        .split(" ")
        .includes("AdmissionCached")
    );
    Assert.equal(source.folder.hasMsgOffline(source.header.messageKey), false);
    await download(cached);
    Assert.equal(source.header.flags & Ci.nsMsgMessageFlags.Offline, 0);
    Assert.equal(source.header.storeToken, "");
    Assert.equal(cached.folder.hasMsgOffline(cached.header.messageKey), true);
    Assert.equal(source.folder.hasMsgOffline(source.header.messageKey), true);
    Assert.equal(readBody(cached), STORE_HEADERS + RAW);
    const stream = source.folder.getMsgInputStream(source.header);
    try {
      Assert.equal(
        NetUtil.readInputStreamToString(stream, stream.available()),
        STORE_HEADERS + RAW
      );
    } finally {
      stream.close();
    }
    const duplicateRaw = RAW.replace(
      MESSAGE_ID,
      "ambiguous-gmail-body@example.invalid"
    );
    addServerMessage(cached.mailbox, duplicateRaw, 5103, "");
    await select(cached.folder);
    Assert.equal(Array.from(cached.folder.messages).length, 2);
    Assert.ok(
      cached.folder.msgDatabase.getMsgHdrForMessageID(
        "ambiguous-gmail-body@example.invalid"
      )
    );
    Assert.deepEqual(
      cached.mailbox._messages.map(message => message.uid),
      [5101, 5103]
    );
    Assert.deepEqual(
      source.mailbox._messages.map(message => message.uid),
      [5101]
    );
    Assert.throws(
      () => source.folder.hasMsgOffline(source.header.messageKey),
      error => error.result == Cr.NS_ERROR_FILE_CORRUPTED
    );
    Assert.equal(source.header.flags & Ci.nsMsgMessageFlags.Offline, 0);
    Assert.equal(source.header.storeToken, "");
    Assert.equal(readBody(cached), STORE_HEADERS + RAW);
  }
);

add_task(async function test_availabilityRejectsForeignKeysAndUidAliases() {
  const first = await createBody("AdmissionFirst", "");
  const second = await createBody("AdmissionSecond", "");
  await download(first);
  Assert.equal(first.folder.hasMsgOffline(first.header.messageKey), true);
  Assert.notEqual(first.header.messageKey, 5101);
  Assert.notEqual(second.header.messageKey, 5101);
  Assert.throws(
    () => first.folder.hasMsgOffline(second.header.messageKey),
    error => error.result == Cr.NS_ERROR_ILLEGAL_VALUE
  );
  Assert.throws(
    () => first.folder.hasMsgOffline(5101),
    error => error.result == Cr.NS_ERROR_ILLEGAL_VALUE
  );
  Assert.equal(first.folder.hasMsgOffline(first.header.messageKey), true);
  Assert.equal(readBody(first), STORE_HEADERS + RAW);
});

add_task(async function test_bodyReaderKeepsPhysicalSourceAcrossReconnect() {
  const cached = await createBody("BodyReconnectCached", "");
  const unavailable = await createBody("BodyReconnectUnavailable", "");
  await download(cached);
  const key = cached.header.messageKey;
  const token = cached.header.storeToken;
  const flags = cached.header.flags;
  const epoch = cached.folder.msgDatabase.dBFolderInfo.imapUidValidity;
  Assert.notEqual(key, unavailable.header.messageKey);
  Assert.equal(unavailable.header.getUint32Property("uidOnServer"), 5101);

  await TestUtils.waitForCondition(
    () => IMAPPump.incomingServer.allConnectionsIdle
  );
  const connections = IMAPPump.server._readers.length;
  IMAPPump.incomingServer.closeCachedConnections();
  await select(unavailable.folder);
  Assert.greater(IMAPPump.server._readers.length, connections);

  Assert.throws(
    () => cached.folder.getMsgInputStream(unavailable.header),
    error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
  );
  Assert.throws(
    () => unavailable.folder.getMsgInputStream(unavailable.header),
    error => error.result == Cr.NS_ERROR_FAILURE
  );
  Assert.equal(unavailable.header.storeToken, "");
  Assert.equal(unavailable.header.flags & Ci.nsMsgMessageFlags.Offline, 0);
  const stream = cached.folder.getMsgInputStream(cached.header);
  try {
    let raw = "";
    while (stream.available()) {
      raw += NetUtil.readInputStreamToString(stream, stream.available());
    }
    Assert.equal(raw, STORE_HEADERS + RAW);
  } finally {
    stream.close();
  }
  Assert.equal(cached.header.messageKey, key);
  Assert.equal(cached.header.storeToken, token);
  Assert.equal(cached.header.flags, flags);
  Assert.equal(cached.folder.msgDatabase.dBFolderInfo.imapUidValidity, epoch);
  Assert.equal(readBody(cached), STORE_HEADERS + RAW);
});

/**
 * Creates a real Gmail mailbox with a literal server message and no local body.
 *
 * @param {string} name - The mailbox name.
 * @param {string} label - Another mailbox containing the same Gmail message.
 * @returns {Promise<object>} The physical folder/header and actual server mailbox.
 */
async function createBody(name, label) {
  const folder = await createImapSubfolder(name);
  folder.clearFlag(Ci.nsMsgFolderFlags.Offline);
  const mailbox = IMAPPump.daemon.getMailbox(name);
  mailbox.uidvalidity = 7101;
  addServerMessage(mailbox, RAW, 5101, label);
  await select(folder);
  const header = folder.msgDatabase.getMsgHdrForMessageID(MESSAGE_ID);
  Assert.ok(header);
  Assert.equal(header.folder, folder);
  Assert.equal(header.getUint32Property("uidOnServer"), 5101);
  Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 7101);
  Assert.equal(core.messageDB.getMessage(header.messageKey).folder, folder);
  Assert.equal(
    core.messageDB.getMessage(header.messageKey).messageId,
    MESSAGE_ID
  );
  Assert.equal(header.flags & Ci.nsMsgMessageFlags.Offline, 0);
  return { folder, mailbox, header };
}

/**
 * Adds independent bytes and Gmail attributes to the actual fake server mailbox.
 *
 * @param {object} mailbox - The fake server mailbox.
 * @param {string} raw - RFC822 bytes.
 *
 * @param {number} uid - The server UID.
 * @param {string} label - A mailbox label.
 */
function addServerMessage(mailbox, raw, uid, label) {
  const message = new ImapMessage(
    "data:text/plain;base64," + btoa(raw),
    uid,
    []
  );
  message.xGmMsgid = GM_ID;
  message.xGmThrid = "1266894439832287888";
  message.xGmLabels = "(" + label + ")";
  mailbox.addMessage(message);
}

/**
 * Synchronizes actual server headers through the IMAP folder path.
 *
 * @param {nsIMsgFolder} folder - The mailbox to select.
 * @returns {Promise<void>} Resolves after URL success.
 */
async function select(folder) {
  const listener = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.selectFolder(folder, listener, null);
  await listener.promise;
}

/**
 * Downloads the physical server message into its own folder store.
 *
 * @param {object} state - The folder/header fixture.
 * @returns {Promise<void>} Resolves when the actual offline download finishes.
 */
async function download(state) {
  state.folder.setFlag(Ci.nsMsgFolderFlags.Offline);
  const listener = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.downloadMessagesForOffline(
    "5101",
    state.folder,
    listener,
    null
  );
  await listener.promise;
  Assert.ok(state.header.flags & Ci.nsMsgMessageFlags.Offline);
}

/**
 * Reads bytes directly from the physical cached folder selected by the fixture.
 *
 * @param {object} state - The physical folder/header fixture.
 * @returns {string} The retained RFC822 bytes.
 */
function readBody(state) {
  const stream = state.folder.msgStore.getMsgInputStream(
    state.folder,
    state.header.storeToken,
    0
  );
  try {
    let raw = "";
    while (stream.available()) {
      raw += NetUtil.readInputStreamToString(stream, stream.available());
    }
    return raw;
  } finally {
    stream.close();
  }
}
