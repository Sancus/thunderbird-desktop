/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server.js */

const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
const nativeBackend = Services.prefs.getBoolPref(
  "mail.panorama.enabled",
  false
);
const sourceFile = do_get_file("../../../data/bugmail10");
const sourceMessageId = "200806061706.m56H6RWT004933@mrapp54.mozilla.org";
let core;
let manager;
let msgWindow;

add_setup(async function () {
  if (!nativeBackend) {
    return;
  }
  const contract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  Services.prefs.setCharPref("mail.server.default.storeContractID", contract);
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
  setupIMAPPump("RFC2195,RFC4315");
  registerCleanupFunction(() => {
    if (IMAPPump.incomingServer) {
      teardownIMAPPump();
    }
  });
  core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  );
  Assert.ok(core instanceof Ci.nsIMsgDBService);
  const expected = {
    "@mozilla.org/msgstore/berkeleystore;1": "mbox",
    "@mozilla.org/msgstore/maildirstore;1": "maildir",
  }[contract];
  Assert.ok(expected);
  Assert.equal(IMAPPump.incomingServer.msgStore.storeType, expected);
  Assert.equal(localAccountUtils.incomingServer.msgStore.storeType, expected);
  manager = MailServices.txns.transactionManager;
  manager.clear();
  registerCleanupFunction(() => manager.clear());
  msgWindow = Cc["@mozilla.org/messenger/msgwindow;1"].createInstance(
    Ci.nsIMsgWindow
  );
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
  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, listener);
  await listener.promise;
});

add_task(async function test_localMoveUndoPublishesCompleteFreshIdentity() {
  if (!nativeBackend) {
    return;
  }
  const state = await prepareMove("CompleteUndo");
  await move(state);
  Assert.equal(manager.numberOfUndoItems, 1);
  Assert.equal(state.source.msgDatabase.containsKey(state.oldKey), false);
  Assert.equal(readBody(state.source, state.oldToken), state.storedBytes);
  const added = [];
  const observer = {
    msgAdded(header) {
      if (header.folder == state.source) {
        assertRestored(state, header);
        added.push(header.messageKey);
      }
    },
  };
  MailServices.mfn.addListener(observer, MailServices.mfn.msgAdded);
  try {
    manager.undoTransaction();
    await select(state.destination);
  } finally {
    MailServices.mfn.removeListener(observer);
  }
  const restored = Array.from(state.source.messages);
  Assert.equal(restored.length, 1);
  assertRestored(state, restored[0]);
  Assert.deepEqual(added, [restored[0].messageKey]);
  Assert.equal(state.source.msgDatabase.containsKey(state.oldKey), false);
  Assert.equal(state.source.getTotalMessages(false), 1);
  Assert.equal(state.source.getNumUnread(false), 1);
  Assert.equal(state.mailbox._messages.length, 1);
  Assert.equal(state.mailbox._messages[0].uid, 900001);
  Assert.ok(state.mailbox._messages[0].flags.includes("\\Deleted"));
  Assert.ok(
    state.mailbox._messages[0].getText().includes("Literal retained undo body.")
  );
  Assert.throws(
    () => manager.redoTransaction(),
    error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
  );
  Assert.deepEqual(
    Array.from(state.source.messages, header => header.messageKey),
    [restored[0].messageKey]
  );
  Assert.equal(
    readBody(state.source, restored[0].storeToken),
    state.storedBytes
  );
});

add_task(async function test_offlineUndoRetainsItsSnapshotForOnlineRetry() {
  if (!nativeBackend) {
    return;
  }
  const state = await prepareMove("OfflineUndo");
  await move(state);
  const wasOffline = Services.io.offline;
  Services.io.offline = true;
  try {
    Assert.throws(
      () => manager.undoTransaction(),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
    );
    Assert.equal(manager.numberOfUndoItems, 1);
    Assert.deepEqual(Array.from(state.source.messages), []);
    Assert.equal(readBody(state.source, state.oldToken), state.storedBytes);
    Assert.equal(state.mailbox._messages[0].flags.includes("\\Deleted"), false);
  } finally {
    Services.io.offline = wasOffline;
  }
  manager.undoTransaction();
  await select(state.destination);
  const restored = Array.from(state.source.messages);
  Assert.equal(restored.length, 1);
  assertRestored(state, restored[0]);
  Assert.equal(state.mailbox._messages.length, 1);
  Assert.ok(state.mailbox._messages[0].flags.includes("\\Deleted"));
});

add_task(async function test_captureFailureRetainsSourceAndReportsCopyError() {
  if (!nativeBackend) {
    return;
  }
  const state = await prepareMove("CaptureFailure");
  core.connectionForTests.executeSimpleSQL(
    "CREATE TEMP TRIGGER fail_imap_capture BEFORE DELETE ON messages " +
      "WHEN OLD.id = " +
      state.oldKey +
      " BEGIN SELECT RAISE(ABORT, 'IMAP undo capture failure'); END"
  );
  try {
    await Assert.rejects(
      move(state),
      error => error.message == String(Cr.NS_ERROR_STORAGE_CONSTRAINT)
    );
    Assert.equal(state.source.msgDatabase.containsKey(state.oldKey), true);
    Assert.deepEqual(
      Array.from(state.source.messages, header => header.messageKey),
      [state.oldKey]
    );
    Assert.equal(readBody(state.source, state.oldToken), state.storedBytes);
    Assert.equal(manager.numberOfUndoItems, 0);
    Assert.equal(
      state.mailbox._messages.length,
      1,
      "The server already accepted APPEND"
    );
    Assert.equal(state.mailbox._messages[0].uid, 900001);
    Assert.equal(state.mailbox._messages[0].flags.includes("\\Deleted"), false);
    Assert.ok(
      state.mailbox._messages[0]
        .getText()
        .includes("Literal retained undo body.")
    );
  } finally {
    core.connectionForTests.executeSimpleSQL("DROP TRIGGER fail_imap_capture");
  }
});

add_task(async function test_changedSourceIsNotRetiredAfterAppend() {
  if (!nativeBackend) {
    return;
  }
  const state = await prepareMove("ChangedSource");
  let edits = 0;
  const observer = {
    msgAdded(header) {
      if (header.folder == state.destination) {
        state.header.subject = "Edited while APPEND completed";
        edits++;
      }
    },
  };
  MailServices.mfn.addListener(observer, MailServices.mfn.msgAdded);
  try {
    await Assert.rejects(
      move(state),
      error => error.message == String(Cr.NS_ERROR_NOT_AVAILABLE)
    );
  } finally {
    MailServices.mfn.removeListener(observer);
  }
  Assert.equal(edits, 1);
  Assert.equal(state.source.msgDatabase.containsKey(state.oldKey), true);
  Assert.equal(state.header.subject, "Edited while APPEND completed");
  Assert.equal(readBody(state.source, state.oldToken), state.storedBytes);
  Assert.equal(manager.numberOfUndoItems, 0);
  Assert.equal(state.mailbox._messages.length, 1);
  Assert.equal(state.mailbox._messages[0].uid, 900001);
  Assert.equal(state.mailbox._messages[0].flags.includes("\\Deleted"), false);
  Assert.ok(
    state.mailbox._messages[0]
      .getText()
      .includes("Subject: Complete local undo")
  );
});

add_task(async function test_restoreFailureRetainsSnapshotAndCanRetry() {
  if (!nativeBackend) {
    return;
  }
  const state = await prepareMove("RestoreFailure");
  await move(state);
  core.connectionForTests.executeSimpleSQL(
    "CREATE TEMP TRIGGER fail_imap_restore BEFORE INSERT ON messages " +
      "WHEN NEW.messageId = 'RestoreFailure@example.invalid' " +
      "BEGIN SELECT RAISE(ABORT, 'IMAP undo restore failure'); END"
  );
  try {
    Assert.throws(
      () => manager.undoTransaction(),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.deepEqual(Array.from(state.source.messages), []);
    Assert.equal(manager.numberOfUndoItems, 1);
    Assert.equal(readBody(state.source, state.oldToken), state.storedBytes);
    Assert.equal(state.mailbox._messages.length, 1);
    Assert.equal(state.mailbox._messages[0].flags.includes("\\Deleted"), false);
  } finally {
    core.connectionForTests.executeSimpleSQL("DROP TRIGGER fail_imap_restore");
  }
  manager.undoTransaction();
  await select(state.destination);
  const restored = Array.from(state.source.messages);
  Assert.equal(restored.length, 1);
  assertRestored(state, restored[0]);
  Assert.equal(
    state.mailbox._messages.length,
    1,
    "Undo never issues another APPEND"
  );
  Assert.ok(state.mailbox._messages[0].flags.includes("\\Deleted"));
});

add_task(async function test_undoRejectsReusedDestinationUidInAnotherEpoch() {
  if (!nativeBackend) {
    return;
  }
  const state = await prepareMove("UndoEpoch");
  await move(state);
  // Let the normal update clear the completed APPEND's empty offline queue.
  const updated = new PromiseTestUtils.PromiseUrlListener();
  state.destination.updateFolderWithListener(null, updated);
  await updated.promise;
  Assert.equal(state.destination.flags & Ci.nsMsgFolderFlags.OfflineEvents, 0);
  state.mailbox.uidvalidity = 8303;
  state.mailbox._messages.length = 0;
  const replacement =
    "From: other@example.invalid\r\nMessage-ID: <replacement-undo@example.invalid>\r\nSubject: Another epoch\r\n\r\nKeep this new server message.\r\n";
  state.mailbox.addMessage(
    new ImapMessage("data:text/plain;base64," + btoa(replacement), 900001, [])
  );
  IMAPPump.incomingServer.closeCachedConnections();
  await select(state.destination);
  Assert.equal(
    state.destination.msgDatabase.dBFolderInfo.imapUidValidity,
    8303
  );
  Assert.ok(
    state.destination.msgDatabase.getMsgHdrForMessageID(
      "replacement-undo@example.invalid"
    )
  );
  Assert.throws(
    () => manager.undoTransaction(),
    error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
  );
  Assert.deepEqual(Array.from(state.source.messages), []);
  Assert.equal(manager.numberOfUndoItems, 1);
  Assert.equal(readBody(state.source, state.oldToken), state.storedBytes);
  Assert.deepEqual(
    state.mailbox._messages.map(message => message.uid),
    [900001]
  );
  Assert.equal(state.mailbox._messages[0].flags.includes("\\Deleted"), false);
  Assert.equal(state.mailbox._messages[0].getText(), replacement);
});

/**
 * @typedef {object} MoveFixture
 * @property {nsIMsgFolder} source - The original local folder.
 * @property {nsIMsgFolder} destination - The selected remote folder.
 * @property {nsIMsgDBHdr} header - The original local header.
 * @property {ImapMailbox} mailbox - The actual remote mailbox.
 * @property {number} oldKey - The original physical key.
 * @property {string} oldToken - The original body location.
 * @property {number} offlineFlags - The original local Offline bit.
 * @property {number} offlineSize - The original local offline size.
 * @property {number} messageSize - The original RFC822 byte count.
 * @property {string} storedBytes - The actual retained local bytes.
 * @property {string} id - The literal Message-ID.
 */

/**
 * Imports a complete local message and selects its empty server destination.
 *
 * @param {string} name - The unique fixture mailbox name.
 * @returns {Promise<MoveFixture>} Real source/header and selected destination.
 */
async function prepareMove(name) {
  manager.clear();
  const source = localAccountUtils.rootFolder.createLocalSubfolder(name);
  const raw = [
    "From: Sender <sender@example.invalid>",
    "To: Recipient <recipient@example.invalid>",
    "Bcc: Hidden <hidden@example.invalid>",
    "Date: Thu, 01 Oct 2026 12:00:00 +0000",
    "Message-ID: <" + name + "@example.invalid>",
    "References: <root@example.invalid> <parent@example.invalid> <root@example.invalid>",
    "Subject: Complete local undo",
    "Content-Type: text/plain; charset=us-ascii",
    "",
    "Literal retained undo body.",
    "",
  ].join("\r\n");
  const file = do_get_profile();
  file.append(name + ".eml");
  await IOUtils.writeUTF8(file.path, raw);
  const imported = new PromiseTestUtils.PromiseCopyListener();
  MailServices.copy.copyFileMessage(
    file,
    source,
    null,
    false,
    0,
    "",
    imported,
    null
  );
  await imported.promise;
  const header = source.msgDatabase.getMsgHdrForMessageID(
    name + "@example.invalid"
  );
  Assert.ok(header);
  header.setStringProperty("CaseProperty", "00123");
  header.setStringProperty("emptyProperty", "");
  header.setStringProperty("keywords", "$label1");
  header.priority = Ci.nsMsgPriority.high;
  const destination = await createImapSubfolder(name);
  destination.clearFlag(Ci.nsMsgFolderFlags.Offline);
  const mailbox = IMAPPump.daemon.getMailbox(name);
  mailbox.uidvalidity = 8202;
  mailbox.uidnext = 900001;
  await select(destination);
  Assert.equal(destination.msgDatabase.dBFolderInfo.imapUidValidity, 8202);
  Assert.equal(core.messageDB.getMessage(header.messageKey).folder, source);
  const offlineFlags = header.flags & Ci.nsMsgMessageFlags.Offline;
  const offlineSize = header.offlineMessageSize;
  Assert.equal(offlineFlags, 0);
  Assert.equal(offlineSize, 0);
  const storedBytes = readBody(source, header.storeToken);
  Assert.ok(storedBytes.includes("Literal retained undo body.\r\n"));
  return {
    source,
    destination,
    header,
    mailbox,
    oldKey: header.messageKey,
    oldToken: header.storeToken,
    offlineFlags,
    offlineSize,
    messageSize: header.messageSize,
    storedBytes,
    id: name + "@example.invalid",
  };
}

/**
 * Moves through the public client API, requiring source removal before success.
 *
 * @param {MoveFixture} state - The real local-to-IMAP fixture.
 * @returns {Promise<void>} Resolves after the real copy completion.
 */
async function move(state) {
  let completions = 0;
  const listener = new PromiseTestUtils.PromiseCopyListener({
    onStopCopy(status) {
      completions++;
      if (status == Cr.NS_OK) {
        Assert.equal(state.source.getTotalMessages(false), 0);
      }
    },
  });
  MailServices.copy.copyMessages(
    state.source,
    [state.header],
    state.destination,
    true,
    listener,
    msgWindow,
    true
  );
  await listener.promise;
  Assert.equal(completions, 1);
  Assert.equal(state.mailbox._messages.length, 1);
  const destinationHeader = Array.from(state.destination.messages)[0];
  Assert.ok(destinationHeader);
  Assert.equal(destinationHeader.getUint32Property("uidOnServer"), 900001);
  Assert.notEqual(destinationHeader.messageKey, 900001);
  Assert.notEqual(destinationHeader.messageKey, state.oldKey);
}

/**
 * Checks complete metadata, fresh physical identity and real finished bytes.
 *
 * @param {MoveFixture} state - The original local source and literal metadata.
 * @param {nsIMsgDBHdr} header - The actual restored header.
 */
function assertRestored(state, header) {
  Assert.notEqual(header.messageKey, state.oldKey);
  Assert.notEqual(header.messageKey, 900001);
  Assert.equal(header.folder, state.source);
  Assert.equal(header.messageId, state.id);
  Assert.equal(header.subject, "Complete local undo");
  Assert.equal(header.bccList, "Hidden <hidden@example.invalid>");
  Assert.equal(header.priority, Ci.nsMsgPriority.high);
  Assert.equal(header.getStringProperty("CaseProperty"), "00123");
  Assert.equal(header.getStringProperty("caseProperty"), "");
  Assert.ok(header.properties.includes("emptyProperty"));
  Assert.equal(header.getStringProperty("emptyProperty"), "");
  Assert.equal(header.getStringProperty("keywords"), "$label1");
  Assert.equal(header.properties.includes("uidOnServer"), false);
  Assert.deepEqual(
    Array.from({ length: header.numReferences }, (_, index) =>
      header.getStringReference(index)
    ),
    ["root@example.invalid", "parent@example.invalid", "root@example.invalid"]
  );
  Assert.notEqual(header.storeToken, state.oldToken);
  Assert.equal(header.flags & Ci.nsMsgMessageFlags.Offline, state.offlineFlags);
  Assert.equal(header.offlineMessageSize, state.offlineSize);
  Assert.equal(header.messageSize, state.messageSize);
  Assert.equal(readBody(state.source, header.storeToken), state.storedBytes);
}

/**
 * Selects a folder after previously queued server operations have completed.
 *
 * @param {nsIMsgFolder} folder - The actual server-backed folder.
 * @returns {Promise<void>} Resolves on SELECT completion.
 */
async function select(folder) {
  const listener = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.selectFolder(folder, listener, null);
  await listener.promise;
}

/**
 * Reads the physical body directly, including bytes retained after removal.
 *
 * @param {nsIMsgFolder} folder - The physical local folder.
 * @param {string} token - Its actual provider token.
 * @returns {string} Retained RFC822 bytes.
 */
function readBody(folder, token) {
  const stream = folder.msgStore.getMsgInputStream(folder, token, 0);
  try {
    const input = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    input.init(stream);
    let result = "";
    for (;;) {
      const chunk = input.read(8192);
      if (!chunk) {
        return result;
      }
      result += chunk;
    }
  } finally {
    stream.close();
  }
}

add_task(function finishPreservedLocalMoveCases() {
  if (!nativeBackend) {
    return;
  }
  manager.clear();
  teardownIMAPPump();
});

add_task(async function test_nativeLocalMoveUndoUsesFreshFinishedBody() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    return;
  }
  const { TestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/TestUtils.sys.mjs"
  );
  setupIMAPPump("RFC2195,RFC4315");
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
  const transactionManager = MailServices.txns.transactionManager;
  transactionManager.clear();
  const local =
    localAccountUtils.rootFolder.createLocalSubfolder("nativeUndoSource");
  const window = Cc["@mozilla.org/messenger/msgwindow;1"].createInstance(
    Ci.nsIMsgWindow
  );
  let addedListener;
  try {
    const selected = new PromiseTestUtils.PromiseUrlListener();
    IMAPPump.inbox.updateFolderWithListener(null, selected);
    await selected.promise;
    const loaded = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyFileMessage(
      sourceFile,
      local,
      null,
      false,
      0,
      "",
      loaded,
      null
    );
    const loadedResult = await loaded.promise;
    const original = local.msgDatabase.getMsgHdrForKey(
      loadedResult.messageKeys[0]
    );
    const originalKey = original.messageKey;
    const originalToken = original.storeToken;
    const originalStream = local.getMsgInputStream(original);
    const originalInput = Cc[
      "@mozilla.org/scriptableinputstream;1"
    ].createInstance(Ci.nsIScriptableInputStream);
    originalInput.init(originalStream);
    let originalText = "";
    try {
      while (originalInput.available()) {
        originalText += originalInput.read(originalInput.available());
      }
    } finally {
      originalInput.close();
    }
    const bytes = Uint8Array.from(originalText, c => c.charCodeAt(0));
    const moved = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyMessages(
      local,
      [original],
      IMAPPump.inbox,
      true,
      moved,
      window,
      true
    );
    await moved.promise;
    Assert.equal(
      local.getTotalMessages(false),
      0,
      "Move removed only the confirmed source"
    );
    Assert.equal(transactionManager.numberOfUndoItems, 1);
    const transaction = transactionManager.peekUndoStack();
    Assert.ok(transaction);
    const published = [];
    addedListener = {
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
        Assert.equal(header.folder, local);
        Assert.notEqual(header.messageKey, originalKey);
        Assert.ok(header.storeToken);
        Assert.equal(header.messageSize, bytes.length);
        Assert.equal(header.offlineMessageSize, 0);
        Assert.ok(!(header.flags & Ci.nsMsgMessageFlags.Offline));
        Assert.ok(!header.properties.includes("uidOnServer"));
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
    local.msgDatabase.addListener(addedListener);
    transactionManager.undoTransaction();
    let refreshed = new PromiseTestUtils.PromiseUrlListener();
    IMAPPump.inbox.updateFolderWithListener(null, refreshed);
    await refreshed.promise;
    let restored = Array.from(local.messages);
    Assert.equal(restored.length, 1);
    Assert.deepEqual(published, [restored[0].messageKey]);
    Assert.notEqual(restored[0].storeToken, originalToken);
    Assert.equal(restored[0].messageId, sourceMessageId);
    const stream = local.getMsgInputStream(restored[0]);
    const input = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    input.init(stream);
    let text = "";
    try {
      while (input.available()) {
        text += input.read(input.available());
      }
    } finally {
      input.close();
    }
    Assert.deepEqual(
      Array.from(text, c => c.charCodeAt(0)),
      Array.from(bytes)
    );
    const firstRestoredKey = restored[0].messageKey;
    transactionManager.redoTransaction();
    refreshed = new PromiseTestUtils.PromiseUrlListener();
    IMAPPump.inbox.updateFolderWithListener(null, refreshed);
    await refreshed.promise;
    await TestUtils.waitForCondition(
      () => local.getTotalMessages(false) == 0,
      "Redo removes the fresh physical source only after the destination ACK"
    );
    transactionManager.undoTransaction();
    refreshed = new PromiseTestUtils.PromiseUrlListener();
    IMAPPump.inbox.updateFolderWithListener(null, refreshed);
    await refreshed.promise;
    restored = Array.from(local.messages);
    Assert.equal(restored.length, 1);
    Assert.notEqual(restored[0].messageKey, firstRestoredKey);
    Assert.deepEqual(published, [firstRestoredKey, restored[0].messageKey]);
  } finally {
    if (addedListener) {
      local.msgDatabase.removeListener(addedListener);
    }
    transactionManager.clear();
    teardownIMAPPump();
  }
});

add_task(async function test_nativeQueuedSourceUndoAndReturnHomeUseFreshKeys() {
  if (!nativeBackend) {
    return;
  }
  setupIMAPPump("RFC2195,RFC4315");
  const wasOffline = Services.io.offline;
  const transactions = MailServices.txns.transactionManager;
  transactions.clear();
  let source;
  let added;
  try {
    for (const name of ["QueuedUndoCopy", "QueuedUndoMove"]) {
      IMAPPump.daemon.createMailbox(name, {
        subscribed: true,
        uidvalidity: IMAPPump.daemon.uidvalidity++,
      });
    }
    const uid = 700001;
    const uri = Services.io.newFileURI(sourceFile);
    IMAPPump.mailbox.addMessage(new ImapMessage(uri.spec, uid, []));
    const root = IMAPPump.incomingServer.rootFolder;
    const discovered = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.discoverAllFolders(root, discovered, null);
    await discovered.promise;
    source = root
      .getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox)
      .QueryInterface(Ci.nsIMsgImapMailFolder);
    const refreshed = new PromiseTestUtils.PromiseUrlListener();
    source.updateFolderWithListener(null, refreshed);
    await refreshed.promise;
    const downloaded = new PromiseTestUtils.PromiseUrlListener();
    source.downloadAllForOffline(downloaded, null);
    await downloaded.promise;
    const original = Array.from(source.msgDatabase.enumerateMessages()).find(
      header => header.getUint32Property("uidOnServer") == uid
    );
    Assert.ok(original);
    const oldKey = original.messageKey;
    const originalBytes = readBody(source, original.storeToken);
    const copyFolder = root.getChildNamed("QueuedUndoCopy");
    const moveFolder = root.getChildNamed("QueuedUndoMove");
    const operations = source.msgDatabase.QueryInterface(
      Ci.nsIMsgOfflineOpsDatabase
    );
    IMAPPump.incomingServer.closeCachedConnections();
    Services.io.offline = true;
    const copied = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyMessages(
      source,
      [original],
      copyFolder,
      false,
      copied,
      null,
      true
    );
    const copyKey = (await copied.promise).messageKeys[0];
    const moved = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyMessages(
      source,
      [original],
      moveFolder,
      true,
      moved,
      null,
      true
    );
    const moveKey = (await moved.promise).messageKeys[0];
    Assert.equal(source.msgDatabase.containsKey(oldKey), false);
    Assert.equal(transactions.numberOfUndoItems, 1);
    const transaction = transactions.peekUndoStack();
    const published = [];
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
        Assert.notEqual(header.messageKey, oldKey);
        Assert.equal(header.folder, source);
        Assert.ok(
          !header.properties.includes("uidOnServer"),
          "Restore excludes raw UID identity; the retained SOURCE operation owns its original tuple"
        );
        Assert.ok(header.flags & Ci.nsMsgMessageFlags.Offline);
        Assert.ok(header.storeToken);
        Assert.equal(readBody(source, header.storeToken), originalBytes);
        const operation = operations.getOfflineOpForKey(
          header.messageKey,
          false
        );
        Assert.ok(
          operation,
          "The still-live SOURCE operation is rekeyed before publication"
        );
        Assert.equal(operation.messageKey, header.messageKey);
        Assert.equal(operation.srcUid, uid);
        Assert.equal(operation.getCopyDestination(0), copyFolder.URI);
        for (const [folder, key] of [
          [copyFolder, copyKey],
          [moveFolder, moveKey],
        ]) {
          const counterpart = folder.msgDatabase
            .QueryInterface(Ci.nsIMsgOfflineOpsDatabase)
            .getOfflineOpForKey(key, false);
          Assert.equal(counterpart.srcMessageKey, header.messageKey);
        }
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
    transactions.undoTransaction();
    source.msgDatabase.removeListener(added);
    added = null;
    const restored = Array.from(source.msgDatabase.enumerateMessages());
    Assert.equal(restored.length, 1);
    const restoredKey = restored[0].messageKey;
    Assert.deepEqual(published, [restoredKey]);
    Assert.equal(source.msgDatabase.containsKey(oldKey), false);
    transactions.redoTransaction();
    Assert.equal(source.msgDatabase.containsKey(restoredKey), false);
    const retained = operations.getOfflineOpForKey(restoredKey, false);
    Assert.ok(retained, "Redo retains queued SOURCE custody");
    Assert.equal(retained.getCopyDestination(0), copyFolder.URI);
    transactions.clear();
    const returned = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyMessages(
      moveFolder,
      [moveFolder.msgDatabase.getMsgHdrForKey(moveKey)],
      source,
      true,
      returned,
      null,
      true
    );
    const returnKey = (await returned.promise).messageKeys[0];
    Assert.notEqual(returnKey, oldKey);
    Assert.notEqual(returnKey, restoredKey);
    const home = source.msgDatabase.getMsgHdrForKey(returnKey);
    Assert.equal(home.getUint32Property("uidOnServer"), uid);
    Assert.equal(readBody(source, home.storeToken), originalBytes);
    Assert.equal(moveFolder.msgDatabase.containsKey(moveKey), false);
    const remaining = operations.getOfflineOpForKey(returnKey, false);
    Assert.ok(
      remaining,
      "Remaining unsent COPY follows the actual returned physical key"
    );
    Assert.equal(remaining.getCopyDestination(0), copyFolder.URI);
    Assert.equal(
      remaining.operation & Ci.nsIMsgOfflineImapOperation.kMsgMoved,
      0
    );
    const copyOperation = copyFolder.msgDatabase
      .QueryInterface(Ci.nsIMsgOfflineOpsDatabase)
      .getOfflineOpForKey(copyKey, false);
    Assert.equal(copyOperation.srcMessageKey, returnKey);
    Assert.equal(operations.getOfflineOpForKey(restoredKey, false), null);
    Assert.equal(
      IMAPPump.daemon.getMailbox("QueuedUndoCopy")._messages.length,
      0
    );
    Assert.equal(
      IMAPPump.daemon.getMailbox("QueuedUndoMove")._messages.length,
      0
    );
  } finally {
    if (added && source) {
      source.msgDatabase.removeListener(added);
    }
    Services.io.offline = wasOffline;
    transactions.clear();
    teardownIMAPPump();
  }
});

add_task(async function test_onlinePendingMoveUndoPreservesOrderedCopies() {
  if (!nativeBackend) {
    return;
  }
  setupIMAPPump("RFC2195,RFC4315");
  const wasOffline = Services.io.offline;
  const transactions = MailServices.txns.transactionManager;
  transactions.clear();
  let source;
  let added;
  try {
    const names = [
      "PendingUndoCopyOne",
      "PendingUndoCopyTwo",
      "PendingUndoMove",
    ];
    for (const name of names) {
      IMAPPump.daemon.createMailbox(name, {
        subscribed: true,
        uidvalidity: IMAPPump.daemon.uidvalidity++,
      });
    }
    const uid = 810001;
    const uri = Services.io.newFileURI(sourceFile);
    IMAPPump.mailbox.addMessage(new ImapMessage(uri.spec, uid, []));
    const root = IMAPPump.incomingServer.rootFolder;
    const discovered = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.discoverAllFolders(root, discovered, null);
    await discovered.promise;
    source = root
      .getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox)
      .QueryInterface(Ci.nsIMsgImapMailFolder);
    const refreshed = new PromiseTestUtils.PromiseUrlListener();
    source.updateFolderWithListener(null, refreshed);
    await refreshed.promise;
    const downloaded = new PromiseTestUtils.PromiseUrlListener();
    source.downloadAllForOffline(downloaded, null);
    await downloaded.promise;
    const original = Array.from(source.msgDatabase.enumerateMessages()).find(
      header => header.getUint32Property("uidOnServer") == uid
    );
    Assert.ok(original);
    const oldKey = original.messageKey;
    const bytes = readBody(source, original.storeToken);
    const targets = names.map(name => root.getChildNamed(name));
    const keys = [];
    const operations = source.msgDatabase.QueryInterface(
      Ci.nsIMsgOfflineOpsDatabase
    );
    IMAPPump.incomingServer.closeCachedConnections();
    Services.io.offline = true;
    source.markMessagesFlagged([original], true);
    for (const target of targets.slice(0, 2)) {
      const copied = new PromiseTestUtils.PromiseCopyListener();
      MailServices.copy.copyMessages(
        source,
        [original],
        target,
        false,
        copied,
        null,
        true
      );
      keys.push((await copied.promise).messageKeys[0]);
    }
    Services.io.offline = false;
    const moved = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyMessages(
      source,
      [original],
      targets[2],
      true,
      moved,
      null,
      true
    );
    keys.push((await moved.promise).messageKeys[0]);
    Assert.equal(source.msgDatabase.containsKey(oldKey), false);
    Assert.equal(transactions.numberOfUndoItems, 1);
    const transaction = transactions.peekUndoStack();
    const published = [];
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
        Assert.notEqual(header.messageKey, oldKey);
        Assert.equal(header.getUint32Property("uidOnServer"), uid);
        Assert.equal(readBody(source, header.storeToken), bytes);
        const remaining = operations.getOfflineOpForKey(
          header.messageKey,
          false
        );
        Assert.ok(remaining);
        Assert.equal(
          remaining.operation & Ci.nsIMsgOfflineImapOperation.kMsgMoved,
          0
        );
        Assert.equal(remaining.getCopyDestination(0), targets[0].URI);
        Assert.equal(remaining.getCopyDestination(1), targets[1].URI);
        for (let i = 0; i < 2; ++i) {
          const child = targets[i].msgDatabase
            .QueryInterface(Ci.nsIMsgOfflineOpsDatabase)
            .getOfflineOpForKey(keys[i], false);
          Assert.equal(child.srcMessageKey, header.messageKey);
        }
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
    transactions.undoTransaction();
    const firstKey = published[0];
    transactions.redoTransaction();
    Assert.equal(source.msgDatabase.containsKey(firstKey), false);
    const redone = operations.getOfflineOpForKey(firstKey, false);
    Assert.ok(redone.operation & Ci.nsIMsgOfflineImapOperation.kMsgMoved);
    Assert.equal(redone.destinationFolderURI, targets[2].URI);
    Assert.equal(redone.getCopyDestination(0), targets[0].URI);
    Assert.equal(redone.getCopyDestination(1), targets[1].URI);
    transactions.undoTransaction();
    Assert.equal(published.length, 2);
    Assert.notEqual(published[1], firstKey);
    source.msgDatabase.removeListener(added);
    added = null;
    const replayed = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.playbackAllOfflineOperations(null, replayed);
    await replayed.promise;
    const repeated = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.playbackAllOfflineOperations(null, repeated);
    await repeated.promise;
    for (let i = 0; i < 2; ++i) {
      const mailbox = IMAPPump.daemon.getMailbox(names[i]);
      Assert.equal(mailbox._messages.length, 1);
      Assert.ok(mailbox._messages[0].flags.includes("\\Flagged"));
      const copied = targets[i].msgDatabase.getMsgHdrForKey(keys[i]);
      Assert.equal(
        copied.getUint32Property("uidOnServer"),
        mailbox._messages[0].uid
      );
    }
    Assert.equal(IMAPPump.daemon.getMailbox(names[2])._messages.length, 0);
    Assert.equal(IMAPPump.mailbox._messages.length, 1);
    Assert.equal(IMAPPump.mailbox._messages[0].uid, uid);
    Assert.equal(source.getTotalMessages(false), 1);
    Assert.equal(
      readBody(
        source,
        source.msgDatabase.getMsgHdrForKey(published[1]).storeToken
      ),
      bytes
    );
  } finally {
    if (added && source) {
      source.msgDatabase.removeListener(added);
    }
    Services.io.offline = wasOffline;
    transactions.clear();
    teardownIMAPPump();
  }
});
