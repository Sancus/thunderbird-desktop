/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server.js */

const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
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
let nextGmId = 1278455344;

/**
 * @typedef {object} PreviewMessage
 * @property {nsIMsgFolder} folder - The physical client folder.
 * @property {nsIMsgDBHdr} header - Its published physical header.
 * @property {ImapMailbox} mailbox - The actual fake server mailbox.
 * @property {string} raw - Literal RFC822 bytes.
 * @property {string} gmId - The server Gmail message identity.
 */

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
  const expectedStore = {
    "@mozilla.org/msgstore/berkeleystore;1": "mbox",
    "@mozilla.org/msgstore/maildirstore;1": "maildir",
  }[contract];
  Assert.ok(expectedStore);
  Assert.equal(IMAPPump.incomingServer.msgStore.storeType, expectedStore);
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

add_task(async function test_remotePreviewKeepsOverlappingUidsSeparate() {
  const first = await createPreviewMessage(
    "PreviewFirst",
    "First physical preview."
  );
  const second = await createPreviewMessage(
    "PreviewSecond",
    "Second physical preview."
  );
  Assert.notEqual(first.header.messageKey, second.header.messageKey);
  await fetchPreview(first);
  Assert.equal(
    first.header.getStringProperty("preview"),
    "First physical preview."
  );
  Assert.equal(second.header.getStringProperty("preview"), "");
  await fetchPreview(second);
  Assert.equal(
    second.header.getStringProperty("preview"),
    "Second physical preview."
  );
  Assert.equal(
    first.header.getStringProperty("preview"),
    "First physical preview."
  );
  for (const state of [first, second]) {
    Assert.equal(state.header.flags & Ci.nsMsgMessageFlags.Offline, 0);
    Assert.equal(state.header.storeToken, "");
    Assert.deepEqual(
      state.mailbox._messages.map(message => message.uid),
      [5101]
    );
    Assert.deepEqual(
      Array.from(state.folder.messages, header => header.messageKey),
      [state.header.messageKey]
    );
    Assert.equal(
      state.folder.fetchMsgPreviewText([state.header.messageKey], null),
      false
    );
  }
});

add_task(async function test_gmailPreviewReadsTheOtherPhysicalBodyOffline() {
  const cached = await createPreviewMessage(
    "PreviewCached",
    "Preview from retained Gmail bytes."
  );
  const source = await createPreviewMessage(
    "PreviewLabel",
    "Preview from retained Gmail bytes.",
    "PreviewCached",
    cached.raw,
    cached.gmId
  );
  Assert.notEqual(source.header.messageKey, cached.header.messageKey);
  await download(cached);
  Assert.equal(source.header.flags & Ci.nsMsgMessageFlags.Offline, 0);
  Assert.equal(source.header.storeToken, "");
  Assert.equal(source.folder.hasMsgOffline(source.header.messageKey), true);
  let callbacks = 0;
  const listener = {
    OnStartRunningUrl() {
      callbacks++;
    },
    OnStopRunningUrl() {
      callbacks++;
    },
  };
  const wasOffline = Services.io.offline;
  Services.io.offline = true;
  try {
    Assert.equal(
      source.folder.fetchMsgPreviewText([source.header.messageKey], listener),
      false
    );
    Assert.equal(
      source.header.getStringProperty("preview"),
      "Preview from retained Gmail bytes."
    );
    Assert.equal(cached.header.getStringProperty("preview"), "");
    Assert.equal(callbacks, 0, "A synchronous stored preview issues no URL");
  } finally {
    Services.io.offline = wasOffline;
  }
  Assert.equal(source.header.storeToken, "");
  Assert.equal(source.header.flags & Ci.nsMsgMessageFlags.Offline, 0);
  Assert.equal(readBody(cached), STORE_HEADERS + cached.raw);
  Assert.deepEqual(
    source.mailbox._messages.map(message => message.uid),
    [5101]
  );
});

add_task(
  async function test_localPreviewReportsStorageFailureWithoutLosingBody() {
    const state = await createPreviewMessage(
      "PreviewLocalFailure",
      "Local preview after storage retry."
    );
    await download(state);
    const token = state.header.storeToken;
    const flags = state.header.flags;
    failPreviewWrite(state);
    try {
      Assert.throws(
        () => state.folder.fetchMsgPreviewText([state.header.messageKey], null),
        error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
      );
      Assert.equal(state.header.getStringProperty("preview"), "");
      Assert.equal(state.header.storeToken, token);
      Assert.equal(state.header.flags, flags);
      Assert.equal(readBody(state), STORE_HEADERS + state.raw);
    } finally {
      core.connectionForTests.executeSimpleSQL(
        "DROP TRIGGER fail_imap_preview"
      );
    }
    Assert.equal(
      state.folder.fetchMsgPreviewText([state.header.messageKey], null),
      false
    );
    Assert.equal(
      state.header.getStringProperty("preview"),
      "Local preview after storage retry."
    );
    Assert.equal(state.header.storeToken, token);
    Assert.equal(readBody(state), STORE_HEADERS + state.raw);
  }
);

add_task(async function test_remotePreviewReportsStorageFailureAndCanRetry() {
  const state = await createPreviewMessage(
    "PreviewRemoteFailure",
    "Remote preview after storage retry."
  );
  failPreviewWrite(state);
  try {
    const listener = new PromiseTestUtils.PromiseUrlListener();
    Assert.equal(
      state.folder.fetchMsgPreviewText([state.header.messageKey], listener),
      true
    );
    await Assert.rejects(
      listener.promise,
      error => error.message == String(Cr.NS_ERROR_STORAGE_CONSTRAINT)
    );
    Assert.equal(state.header.getStringProperty("preview"), "");
    Assert.equal(state.header.flags & Ci.nsMsgMessageFlags.Offline, 0);
    Assert.equal(state.header.storeToken, "");
    Assert.deepEqual(
      Array.from(state.folder.messages, header => header.messageKey),
      [state.header.messageKey]
    );
    Assert.deepEqual(
      state.mailbox._messages.map(message => message.uid),
      [5101]
    );
  } finally {
    core.connectionForTests.executeSimpleSQL("DROP TRIGGER fail_imap_preview");
  }
  await fetchPreview(state);
  Assert.equal(
    state.header.getStringProperty("preview"),
    "Remote preview after storage retry."
  );
});

add_task(async function test_previewReadFailureDoesNotStartAnUrl() {
  const state = await createPreviewMessage(
    "PreviewReadFailure",
    "Preview after property read retry."
  );
  const connection = core.connectionForTests;
  let callbacks = 0;
  const listener = {
    OnStartRunningUrl() {
      callbacks++;
    },
    OnStopRunningUrl() {
      callbacks++;
    },
  };
  connection.executeSimpleSQL(
    "ALTER TABLE message_properties RENAME TO hidden_imap_preview_properties"
  );
  try {
    Assert.throws(
      () =>
        state.folder.fetchMsgPreviewText([state.header.messageKey], listener),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.equal(callbacks, 0);
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE hidden_imap_preview_properties RENAME TO message_properties"
    );
  }
  Assert.equal(state.header.getStringProperty("preview"), "");
  await fetchPreview(state);
  Assert.equal(
    state.header.getStringProperty("preview"),
    "Preview after property read retry."
  );
});

/**
 * Selects a real server message with an overlapping UID and independent body.
 *
 * @param {string} name - The server mailbox name.
 * @param {string} body - The literal expected preview text.
 *
 * @param {string} [label=""] - Another Gmail mailbox containing these bytes.
 * @param {string} [raw] - Existing bytes for a second label of the same message.
 *
 * @param {string} [gmId] - Its existing Gmail identity, or a fresh fixture identity.
 * @returns {Promise<PreviewMessage>} The physical client and server message.
 */
async function createPreviewMessage(
  name,
  body,
  label = "",
  raw = undefined,
  gmId = String(nextGmId++)
) {
  raw ??= [
    "From: sender@example.invalid",
    "To: recipient@example.invalid",
    "Date: Thu, 01 Oct 2026 12:00:00 +0000",
    "Message-ID: <" + name + "@example.invalid>",
    "Subject: Physical preview",
    "Content-Type: text/plain; charset=us-ascii",
    "",
    body,
    "",
  ].join("\r\n");
  const folder = await createImapSubfolder(name);
  folder.clearFlag(Ci.nsMsgFolderFlags.Offline);
  const mailbox = IMAPPump.daemon.getMailbox(name);
  mailbox.uidvalidity = 7101;
  const message = new ImapMessage(
    "data:text/plain;base64," + btoa(raw),
    5101,
    []
  );
  message.xGmMsgid = gmId;
  message.xGmThrid = "1266894439832287888";
  message.xGmLabels = "(" + label + ")";
  mailbox.addMessage(message);
  const selected = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.selectFolder(folder, selected, null);
  await selected.promise;
  const headers = Array.from(folder.messages);
  Assert.equal(headers.length, 1);
  const header = headers[0];
  Assert.ok(raw.includes("Message-ID: <" + header.messageId + ">"));
  Assert.equal(header.folder, folder);
  Assert.equal(header.getUint32Property("uidOnServer"), 5101);
  Assert.notEqual(header.messageKey, 5101);
  Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 7101);
  Assert.equal(core.messageDB.getMessage(header.messageKey).folder, folder);
  Assert.equal(header.flags & Ci.nsMsgMessageFlags.Offline, 0);
  Assert.equal(header.getStringProperty("preview"), "");
  return { folder, header, mailbox, raw, gmId };
}

/**
 * Fetches a preview through the production asynchronous IMAP URL.
 *
 * @param {PreviewMessage} state - The actual folder/header fixture.
 * @returns {Promise<void>} Resolves after a successful URL.
 */
async function fetchPreview(state) {
  const listener = new PromiseTestUtils.PromiseUrlListener();
  Assert.equal(
    state.folder.fetchMsgPreviewText([state.header.messageKey], listener),
    true
  );
  await listener.promise;
}

/**
 * Finishes a real offline body download in its physical folder.
 *
 * @param {PreviewMessage} state - The actual folder/header fixture.
 * @returns {Promise<void>} Resolves after offline storage completes.
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
 * Fails only this message's preview insert using the actual storage connection.
 *
 * @param {PreviewMessage} state - The actual folder/header fixture.
 */
function failPreviewWrite(state) {
  core.connectionForTests.executeSimpleSQL(
    "CREATE TEMP TRIGGER fail_imap_preview BEFORE INSERT ON message_properties " +
      "WHEN NEW.id = " +
      state.header.messageKey +
      " AND NEW.name = 'preview' " +
      "BEGIN SELECT RAISE(ABORT, 'IMAP preview storage failure'); END"
  );
}

/**
 * Reads the retained bytes from the actual physical message store.
 *
 * @param {PreviewMessage} state - The actual folder/header fixture.
 * @returns {string} The RFC822 bytes, without redirection to another label.
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
