/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

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
    const eol = AppConstants.platform == "win" ? "\r\n" : "\n";
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

/**
 * Reads the complete stored reference sequence without the public header filter.
 *
 * @param {nsIDatabaseCore} database - Native database containing the message.
 * @param {number} key - Physical message key.
 * @returns {string[]} Stored references in their original order.
 */
function readStoredCopyReferences(database, key) {
  const statement = database.connectionForTests.createStatement(
    "SELECT token FROM message_references WHERE id = :id ORDER BY ordinal"
  );
  statement.params.id = key;
  const references = [];
  try {
    while (statement.executeStep()) {
      references.push(statement.row.token);
    }
  } finally {
    statement.finalize();
  }
  return references;
}

/**
 * Copy or move one local message between different real store implementations.
 *
 * @param {string} sourceStore - Source provider contract ID.
 * @param {string} destinationStore - Destination provider contract ID.
 * @param {boolean} isMove - Whether to retire the source after destination success.
 */
async function checkCrossStoreTransfer(sourceStore, destinationStore, isMove) {
  const accounts = [];
  const prefs = [
    "mail.serverDefaultStoreContractID",
    "mail.server.default.storeContractID",
  ].map(name => ({
    name,
    hadValue: Services.prefs.prefHasUserValue(name),
    value: Services.prefs.getCharPref(name, ""),
  }));
  const makeFolder = (name, contract) => {
    // Native account adoption can cache the store during server creation.
    for (const { name: pref } of prefs) {
      Services.prefs.setCharPref(pref, contract);
    }
    const server = MailServices.accounts.createIncomingServer(
      name,
      `${name}.invalid`,
      "none"
    );
    // The store must be selected before rootMsgFolder or msgStore is cached.
    server.setStringValue("storeContractID", contract);
    const account = MailServices.accounts.createAccount();
    accounts.push(account);
    account.incomingServer = server;
    const folder = server.rootMsgFolder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder(name)
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const type = contract.includes("maildirstore") ? "maildir" : "mbox";
    Assert.equal(folder.msgStore.storeType, type);
    Assert.equal(server.msgStore.storeType, type);
    return folder;
  };
  const snapshot = (folder, header) => ({
    key: header.messageKey,
    id: header.messageId,
    token: header.storeToken,
    size: header.messageSize,
    flags: header.flags,
    body: mailTestUtils.loadMessageToString(folder, header),
  });
  try {
    const source = makeFolder("cross-store-source", sourceStore);
    const destination = makeFolder("cross-store-destination", destinationStore);
    const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
    const database = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    );
    Assert.equal(
      "nsIDatabaseCore" in Ci && database instanceof Ci.nsIDatabaseCore,
      native
    );
    Assert.notEqual(source.server.key, destination.server.key);
    const raw = id =>
      "From: sender@example.invalid\r\n" +
      "To: recipient@example.invalid\r\n" +
      "Date: Tue, 01 Jan 2019 00:00:00 +0000\r\n" +
      `Message-ID: <${id}@cross-store.invalid>\r\n` +
      (native
        ? `References: <first@example.invalid> <${id}@cross-store.invalid> <second@example.invalid> <first@example.invalid>\r\n`
        : "References: <first@example.invalid> <second@example.invalid>\r\n") +
      `Subject: ${id}\r\n\r\nExact ${id} body.\r\n`;
    const selected = source.addMessage(raw("selected"));
    source.markMessagesRead([selected], true);
    source.markMessagesFlagged([selected], true);
    selected.setStringProperty("keywords", "first-tag second-tag");
    selected.setStringProperty("crossStoreValue", "Exact café 日本語");
    selected.setStringProperty("crossStoreEmpty", "");
    // These are arbitrary text rows in Panorama, but storage columns in Mork.
    if (native) {
      selected.setStringProperty("size", "0007 text");
      selected.setStringProperty("numLines", "0011 text");
      selected.setStringProperty("offlineMsgSize", "0013 text");
      selected.setStringProperty("msgOffset", isMove ? "0007" : "");
      selected.setStringProperty("uidOnServer", "00041");
      selected.setStringProperty("UidOnServer", "0017 text");
    }
    const kept = source.addMessage(raw("unselected"));
    const prior = destination.addMessage(raw("preexisting"));
    const before = snapshot(source, selected);
    const bystander = snapshot(source, kept);
    const existing = snapshot(destination, prior);
    const references = [
      "first@example.invalid",
      before.id,
      "second@example.invalid",
      "first@example.invalid",
    ];
    const core = native ? database.QueryInterface(Ci.nsIDatabaseCore) : null;
    if (native) {
      Assert.deepEqual(readStoredCopyReferences(core, before.key), references);
      Assert.ok([...selected.properties].includes("msgOffset"));
      Assert.equal(selected.getStringProperty("uidOnServer"), "00041");
    }
    let publications = 0;
    const notification = {
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
        if (header.folder != destination || header.messageId != before.id) {
          return;
        }
        publications++;
        Assert.deepEqual(
          readStoredCopyReferences(core, header.messageKey),
          references
        );
        const properties = [...header.properties];
        Assert.ok(!properties.includes("msgOffset"));
        Assert.ok(!properties.includes("uidOnServer"));
        Assert.ok(properties.includes("UidOnServer"));
        Assert.equal(header.getStringProperty("UidOnServer"), "0017 text");
        Assert.ok(!properties.includes("crossStoreAbsent"));
        Assert.ok(properties.includes("crossStoreEmpty"));
        for (const name of [
          "storeToken",
          "messageSize",
          "offlineMessageSize",
          "lineCount",
        ]) {
          Assert.ok(
            properties.includes(name),
            `${name} is known at publication`
          );
        }
        Assert.notEqual(header.storeToken, "");
        Assert.equal(header.messageSize, before.size);
        Assert.equal(header.offlineMessageSize, 0);
        Assert.equal(header.lineCount, 1);
        Assert.equal(header.flags & Ci.nsMsgMessageFlags.Offline, 0);
        Assert.equal(
          mailTestUtils.loadMessageToString(destination, header),
          before.body
        );
      },
    };
    const stops = [];
    const listener = new PromiseTestUtils.PromiseCopyListener({
      onStopCopy(status) {
        stops.push(status);
      },
    });
    const destinationDB = destination.msgDatabase;
    if (native) {
      destinationDB.addListener(notification);
    }
    try {
      MailServices.copy.copyMessages(
        source,
        [selected],
        destination,
        isMove,
        listener,
        null,
        false
      );
      await listener.promise;
    } finally {
      if (native) {
        destinationDB.removeListener(notification);
      }
    }
    Assert.deepEqual(stops, [Cr.NS_OK]);
    if (native) {
      Assert.equal(publications, 1);
    }
    // CopyMessages does not promise the CopyFileMessage-only SetMessageKey hook.
    const copied = [...destination.messages].find(
      header => header.messageId == before.id
    );
    Assert.ok(copied);
    Assert.equal(copied.folder, destination);
    Assert.equal(copied.messageId, before.id);
    if (native) {
      Assert.notEqual(copied.messageKey, before.key);
    }
    Assert.notEqual(copied.storeToken, ""); // Token "0" remains valid.
    Assert.equal(copied.messageSize, before.size);
    Assert.equal(
      mailTestUtils.loadMessageToString(destination, copied),
      before.body
    );
    const storedFlags = ~(
      Ci.nsMsgMessageFlags.New | Ci.nsMsgMessageFlags.Offline
    );
    Assert.equal(copied.flags & storedFlags, before.flags & storedFlags);
    Assert.equal(copied.flags & Ci.nsMsgMessageFlags.Offline, 0);
    Assert.equal(copied.getStringProperty("keywords"), "first-tag second-tag");
    Assert.equal(
      copied.getStringProperty("crossStoreValue"),
      "Exact café 日本語"
    );
    Assert.equal(copied.getStringProperty("crossStoreEmpty"), "");
    Assert.ok([...copied.properties].includes("crossStoreEmpty"));
    if (native) {
      Assert.equal(copied.getStringProperty("size"), "0007 text");
      Assert.equal(copied.getStringProperty("numLines"), "0011 text");
      Assert.equal(copied.getStringProperty("offlineMsgSize"), "0013 text");
      Assert.ok(![...copied.properties].includes("msgOffset"));
      Assert.equal(copied.lineCount, 1);
      Assert.deepEqual(
        readStoredCopyReferences(core, copied.messageKey),
        references
      );
    }
    Assert.equal(copied.numReferences, native ? 3 : 2);
    Assert.equal(copied.getStringReference(0), "first@example.invalid");
    Assert.equal(copied.getStringReference(1), "second@example.invalid");
    if (native) {
      Assert.equal(copied.getStringReference(2), "first@example.invalid");
    }
    Assert.deepEqual(
      snapshot(destination, destination.GetMessageHeader(existing.key)),
      existing
    );
    Assert.deepEqual(
      [...destination.messages].map(header => header.messageId).sort(),
      [before.id, existing.id].sort()
    );
    Assert.deepEqual(
      source.msgDatabase.listAllKeys().sort((a, b) => a - b),
      (isMove ? [bystander.key] : [before.key, bystander.key]).sort(
        (a, b) => a - b
      )
    );
    Assert.deepEqual(
      snapshot(source, source.GetMessageHeader(bystander.key)),
      bystander
    );
    if (!isMove) {
      if (native) {
        Assert.equal(
          source.GetMessageHeader(before.key).getStringProperty("uidOnServer"),
          "00041"
        );
      }
      Assert.deepEqual(
        snapshot(source, source.GetMessageHeader(before.key)),
        before
      );
    }
    Assert.ok(!source.locked);
    Assert.ok(!destination.locked);
  } finally {
    try {
      for (const account of accounts.reverse()) {
        MailServices.accounts.removeAccount(account, false);
      }
    } finally {
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

add_task(async function test_copyMboxToMaildir() {
  await checkCrossStoreTransfer(
    "@mozilla.org/msgstore/berkeleystore;1",
    "@mozilla.org/msgstore/maildirstore;1",
    false
  );
});

add_task(async function test_moveMboxToMaildir() {
  await checkCrossStoreTransfer(
    "@mozilla.org/msgstore/berkeleystore;1",
    "@mozilla.org/msgstore/maildirstore;1",
    true
  );
});

add_task(async function test_copyMaildirToMbox() {
  await checkCrossStoreTransfer(
    "@mozilla.org/msgstore/maildirstore;1",
    "@mozilla.org/msgstore/berkeleystore;1",
    false
  );
});

add_task(async function test_moveMaildirToMbox() {
  await checkCrossStoreTransfer(
    "@mozilla.org/msgstore/maildirstore;1",
    "@mozilla.org/msgstore/berkeleystore;1",
    true
  );
});

/**
 * Reject an invalid delete batch before any member's body or row is removed.
 *
 * @param {string} storeType - Local mbox or maildir provider.
 * @param {boolean} [foreignTransaction=false] - Hold a real native transaction.
 */
async function checkDeleteAdmission(storeType, foreignTransaction = false) {
  const prefs = [
    "mail.serverDefaultStoreContractID",
    "mail.server.default.storeContractID",
  ].map(name => ({
    name,
    hadValue: Services.prefs.prefHasUserValue(name),
    value: Services.prefs.getCharPref(name, ""),
  }));
  const contract = `@mozilla.org/msgstore/${storeType == "mbox" ? "berkeleystore" : "maildirstore"};1`;
  localAccountUtils.clearAll();
  try {
    for (const { name } of prefs) {
      Services.prefs.setCharPref(name, contract);
    }
    localAccountUtils.loadLocalMailAccount();
    const root = localAccountUtils.rootFolder;
    const folder = root
      .createLocalSubfolder("delete-owner")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const other = root
      .createLocalSubfolder("delete-other")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    );
    const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
    Assert.equal(
      "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
      native
    );
    for (const f of [folder, other]) {
      Assert.equal(f.msgStore.storeType, storeType);
      Assert.equal(f.server.msgStore.storeType, storeType);
    }
    const populate = (f, prefix) =>
      [0, 1].map(i => {
        const raw =
          "From: sender@example.invalid\r\n" +
          "Date: Tue, 01 Jan 2019 00:00:00 +0000\r\n" +
          `Message-ID: <${prefix}-${i}@delete.invalid>\r\n` +
          `Subject: ${prefix}-${i}\r\n\r\nExact ${prefix}-${i} bytes.\r\n`;
        const header = f.addMessage(raw);
        header.setStringProperty("delete-note", "Keep café 日本語");
        return {
          header,
          key: header.messageKey,
          token: header.storeToken,
          flags: header.flags,
          size: header.messageSize,
          raw,
        };
      });
    const own = populate(folder, "owner");
    const foreign = populate(other, "foreign");
    const files = async (f, originals) =>
      storeType == "mbox"
        ? [await IOUtils.read(f.filePath.path)]
        : Promise.all(
            originals.map(original =>
              IOUtils.read(
                PathUtils.join(f.filePath.path, "cur", original.token)
              )
            )
          );
    const ownBytes = await files(folder, own);
    const foreignBytes = await files(other, foreign);
    const check = (f, originals) => {
      Assert.deepEqual(
        f.msgDatabase.listAllKeys().sort((a, b) => a - b),
        originals.map(original => original.key).sort((a, b) => a - b)
      );
      for (const original of originals) {
        const h = f.GetMessageHeader(original.key);
        Assert.equal(h.folder, f);
        Assert.equal(h.storeToken, original.token);
        Assert.equal(h.flags, original.flags);
        Assert.equal(h.messageSize, original.size);
        Assert.equal(h.getStringProperty("delete-note"), "Keep café 日本語");
        Assert.equal(mailTestUtils.loadMessageToString(f, h), original.raw);
      }
    };
    let deleted = 0;
    const observer = {
      QueryInterface: ChromeUtils.generateQI(["nsIMsgFolderListener"]),
      msgsDeleted() {
        ++deleted;
      },
    };
    MailServices.mfn.addListener(observer, MailServices.mfn.msgsDeleted);
    try {
      let connection;
      if (foreignTransaction) {
        Assert.ok(native);
        connection = service.QueryInterface(
          Ci.nsIDatabaseCore
        ).connectionForTests;
        connection.beginTransaction();
      }
      try {
        Assert.throws(
          () =>
            folder.deleteMessages(
              foreignTransaction
                ? own.map(original => original.header)
                : [own[0].header, foreign[0].header],
              null,
              true,
              false,
              null,
              false
            ),
          error =>
            error.result ==
            (foreignTransaction
              ? Cr.NS_ERROR_IN_PROGRESS
              : Cr.NS_ERROR_ILLEGAL_VALUE)
        );
        if (connection) {
          Assert.ok(connection.transactionInProgress);
        }
      } finally {
        if (connection) {
          connection.rollbackTransaction();
        }
      }
      Assert.equal(deleted, 0);
      check(folder, own);
      check(other, foreign);
      Assert.deepEqual(await files(folder, own), ownBytes);
      Assert.deepEqual(await files(other, foreign), foreignBytes);
      // The validation failure has not poisoned a later valid request.
      folder.deleteMessages([own[0].header], null, true, false, null, false);
      Assert.equal(deleted, 1);
      check(folder, own.slice(1));
      check(other, foreign);
      if (storeType == "maildir") {
        Assert.ok(
          !(await IOUtils.exists(
            PathUtils.join(folder.filePath.path, "cur", own[0].token)
          ))
        );
      }
      Assert.deepEqual(await files(other, foreign), foreignBytes);
    } finally {
      MailServices.mfn.removeListener(observer);
    }
  } finally {
    try {
      localAccountUtils.clearAll();
    } finally {
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

add_task(async function test_deleteRejectsForeignFolderMbox() {
  await checkDeleteAdmission("mbox");
});
add_task(async function test_deleteRejectsForeignFolderMaildir() {
  await checkDeleteAdmission("maildir");
});
if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_deleteRejectsForeignTransactionMbox() {
    await checkDeleteAdmission("mbox", true);
  });
  add_task(async function test_deleteRejectsForeignTransactionMaildir() {
    await checkDeleteAdmission("maildir", true);
  });
}

/**
 * Fail a real maildir Finish after its destination stream has opened.
 *
 * @param {boolean} isMove - Request a move instead of a copy.
 * @param {number} count - One message, or three with the second Finish failing.
 * @returns {Promise<void>} Completes the real request and restores owned paths.
 */
async function checkCopyFinishFailure(isMove, count) {
  const accounts = [];
  const prefs = [
    "mail.serverDefaultStoreContractID",
    "mail.server.default.storeContractID",
  ].map(name => ({
    name,
    hadValue: Services.prefs.prefHasUserValue(name),
    value: Services.prefs.getCharPref(name, ""),
  }));
  const label = `finish-${isMove ? "move" : "copy"}-${count}`;
  const makeFolder = (name, contract) => {
    for (const { name: pref } of prefs) {
      Services.prefs.setCharPref(pref, contract);
    }
    const server = MailServices.accounts.createIncomingServer(
      name,
      `${name}.invalid`,
      "none"
    );
    server.setStringValue("storeContractID", contract);
    const account = MailServices.accounts.createAccount();
    accounts.push(account);
    account.incomingServer = server;
    const folder = server.rootMsgFolder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder(name)
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const type = contract.includes("maildirstore") ? "maildir" : "mbox";
    Assert.equal(folder.msgStore.storeType, type);
    Assert.equal(server.msgStore.storeType, type);
    return folder;
  };
  try {
    // Different providers force the real streaming path on both backends.
    const source = makeFolder(
      `${label}-source`,
      "@mozilla.org/msgstore/berkeleystore;1"
    );
    const destination = makeFolder(
      `${label}-destination`,
      "@mozilla.org/msgstore/maildirstore;1"
    );
    const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
    const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    );
    Assert.equal(
      "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
      native
    );
    const raws = Array.from(
      { length: count },
      (_, index) =>
        "From: sender@example.invalid\r\n" +
        "To: recipient@example.invalid\r\n" +
        `Message-ID: <${label}-${index}@example.invalid>\r\n` +
        `Subject: ${label} ${index}\r\n\r\n` +
        `Exact retained body ${index}.\r\n`
    );
    const headers = raws.map(raw => source.addMessage(raw));
    source.markMessagesRead(headers, true);
    for (const header of headers) {
      header.setStringProperty("finishFailureNote", "Keep this exact value");
    }
    const originals = headers.map(header => ({
      key: header.messageKey,
      id: header.messageId,
      token: header.storeToken,
      size: header.messageSize,
      flags: header.flags,
    }));
    const sourceBytes = await IOUtils.read(source.filePath.path);
    const failAt = count == 1 ? 1 : 2;
    const cur = destination.filePath.clone();
    cur.append("cur");
    const held = destination.filePath.clone();
    held.append("cur-before-failed-finish");
    Assert.ok(cur.isDirectory());
    Assert.ok(!held.exists());
    let starts = 0;
    let stops = 0;
    let progress = 0;
    let injected = false;
    let injectionError;
    let resolve;
    const done = new Promise(callback => {
      resolve = callback;
    });
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
      onStartCopy() {
        starts++;
      },
      onProgress() {
        if (++progress != failAt) {
          return;
        }
        try {
          // BeginCopy calls progress only after GetNewMsgOutputStream.
          // Keep any successful prefix, and block the actual final MoveTo.
          cur.clone().moveTo(held.parent, held.leafName);
          cur.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
          injected = true;
        } catch (error) {
          injectionError = error;
        }
      },
      setMessageKey() {},
      getMessageId() {
        return "";
      },
      onStopCopy(status) {
        stops++;
        resolve(status);
      },
    };
    let status;
    try {
      MailServices.copy.copyMessages(
        source,
        headers,
        destination,
        isMove,
        listener,
        null,
        false
      );
      status = await done;
    } finally {
      if (held.exists()) {
        // Never remove unexpected or possibly settled destination content.
        Assert.ok(cur.isFile());
        Assert.equal(cur.fileSize, 0);
        cur.remove(false);
        held.moveTo(destination.filePath, "cur");
      }
    }
    Assert.equal(injectionError, undefined);
    Assert.ok(injected, "The real opened-write finalization fault was reached");
    Assert.equal(starts, 1);
    Assert.equal(stops, 1);
    Assert.equal(status, Cr.NS_ERROR_FILE_DESTINATION_NOT_DIR);
    Assert.equal(progress, failAt);
    Assert.deepEqual(
      source.msgDatabase.listAllKeys().sort((a, b) => a - b),
      originals.map(original => original.key).sort((a, b) => a - b)
    );
    for (let i = 0; i < originals.length; i++) {
      const original = originals[i];
      const header = source.msgDatabase.getMsgHdrForKey(original.key);
      Assert.equal(header.messageId, original.id);
      Assert.equal(header.storeToken, original.token);
      Assert.equal(header.messageSize, original.size);
      Assert.equal(header.flags, original.flags);
      Assert.ok(header.properties.includes("finishFailureNote"));
      Assert.equal(
        header.getStringProperty("finishFailureNote"),
        "Keep this exact value"
      );
      Assert.equal(mailTestUtils.loadMessageToString(source, header), raws[i]);
    }
    Assert.deepEqual(await IOUtils.read(source.filePath.path), sourceBytes);
    const destinationKeys = destination.msgDatabase
      .listAllKeys()
      .sort((a, b) => a - b);
    Assert.equal(destinationKeys.length, failAt - 1);
    for (let i = 0; i < destinationKeys.length; i++) {
      const header = destination.msgDatabase.getMsgHdrForKey(
        destinationKeys[i]
      );
      Assert.equal(header.messageId, originals[i].id);
      Assert.equal(
        mailTestUtils.loadMessageToString(destination, header),
        raws[i]
      );
    }
    const pending = await IOUtils.getChildren(
      PathUtils.join(destination.filePath.path, "tmp")
    );
    Assert.equal(pending.length, 1);
    Assert.equal(await IOUtils.readUTF8(pending[0]), raws[failAt - 1]);
  } finally {
    for (const account of accounts.reverse()) {
      MailServices.accounts.removeAccount(account);
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

add_task(async function test_copyFinishFailure() {
  await checkCopyFinishFailure(false, 1);
});
add_task(async function test_moveFinishFailure() {
  await checkCopyFinishFailure(true, 1);
});
add_task(async function test_laterCopyFinishFailure() {
  await checkCopyFinishFailure(false, 3);
});
add_task(async function test_laterMoveFinishFailure() {
  await checkCopyFinishFailure(true, 3);
});

/**
 * Preserve a real IMAP source when the local EndMessage cannot finish its body.
 *
 * @param {boolean} isMove - Request a move instead of a copy.
 * @returns {Promise<void>} Completes the request and restores owned paths.
 */
async function checkImapFinishFailure(isMove) {
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
  const label = `imap-finish-${isMove ? "move" : "copy"}`;
  let started = false;
  try {
    for (const { name } of prefs) {
      Services.prefs.setCharPref(name, "@mozilla.org/msgstore/maildirstore;1");
    }
    localAccountUtils.loadLocalMailAccount();
    const destination =
      localAccountUtils.rootFolder.createLocalSubfolder(label);
    Assert.equal(destination.msgStore.storeType, "maildir");
    Assert.equal(destination.server.msgStore.storeType, "maildir");
    const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
    const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    );
    Assert.equal(
      "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
      native
    );
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
      `Message-ID: <${label}@example.invalid>\r\n` +
      `Subject: ${label}\r\n` +
      "References: <first@example.invalid> <second@example.invalid>\r\n\r\n" +
      "Exact retained IMAP Finish failure body.\r\n";
    const file = do_get_profile();
    file.append(`${label}.eml`);
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
      `${label}@example.invalid`
    );
    Assert.ok(source);
    const original = {
      key: source.messageKey,
      flags: source.flags,
      token: source.storeToken,
      size: source.messageSize,
      serverFlags: [...serverMessage.flags],
    };
    const uid = native
      ? source.getUint32Property("uidOnServer")
      : source.messageKey;
    Assert.equal(uid, serverMessage.uid);
    if (native) {
      Assert.notEqual(source.messageKey, uid);
    }
    source.setStringProperty("finishFailureNote", "Retain this IMAP identity");
    const cur = destination.filePath.clone();
    cur.append("cur");
    const held = destination.filePath.clone();
    held.append("cur-before-failed-finish");
    Assert.ok(cur.isDirectory());
    Assert.ok(!held.exists());
    let starts = 0;
    let stops = 0;
    let progress = 0;
    let injected = false;
    let injectionError;
    let resolve;
    const done = new Promise(callback => {
      resolve = callback;
    });
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
      onStartCopy() {
        starts++;
      },
      onProgress() {
        if (++progress != 1) {
          return;
        }
        try {
          // The single-message BeginCopy has opened its actual output stream.
          cur.clone().moveTo(held.parent, held.leafName);
          cur.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
          injected = true;
        } catch (error) {
          injectionError = error;
        }
      },
      setMessageKey() {},
      getMessageId() {
        return "";
      },
      onStopCopy(status) {
        stops++;
        resolve(status);
      },
    };
    let status;
    try {
      MailServices.copy.copyMessages(
        inbox,
        [source],
        destination,
        isMove,
        listener,
        null,
        false
      );
      status = await done;
    } finally {
      if (held.exists()) {
        Assert.ok(cur.isFile());
        Assert.equal(cur.fileSize, 0);
        cur.remove(false);
        held.moveTo(destination.filePath, "cur");
      }
    }
    Assert.equal(injectionError, undefined);
    Assert.ok(injected, "The real IMAP destination Finish fault was reached");
    Assert.equal(starts, 1);
    Assert.equal(stops, 1);
    Assert.equal(progress, 1);
    Assert.equal(status, Cr.NS_ERROR_FILE_DESTINATION_NOT_DIR);
    Assert.deepEqual(inbox.msgDatabase.listAllKeys(), [original.key]);
    const retained = inbox.msgDatabase.getMsgHdrForKey(original.key);
    Assert.equal(retained.folder, inbox);
    Assert.equal(retained.messageId, `${label}@example.invalid`);
    Assert.equal(retained.storeToken, original.token);
    Assert.equal(retained.messageSize, original.size);
    Assert.equal(retained.flags, original.flags);
    Assert.ok(retained.properties.includes("finishFailureNote"));
    Assert.equal(
      retained.getStringProperty("finishFailureNote"),
      "Retain this IMAP identity"
    );
    Assert.equal(retained.numReferences, 2);
    Assert.equal(retained.getStringReference(0), "first@example.invalid");
    Assert.equal(retained.getStringReference(1), "second@example.invalid");
    Assert.equal(
      native ? retained.getUint32Property("uidOnServer") : retained.messageKey,
      uid
    );
    Assert.ok(IMAPPump.mailbox._messages.includes(serverMessage));
    Assert.deepEqual(serverMessage.flags, original.serverFlags);
    Assert.ok(!serverMessage.flags.includes("\\Deleted"));
    Assert.equal(await IOUtils.readUTF8(file.path), raw);
    Assert.deepEqual(destination.msgDatabase.listAllKeys(), []);
    const pending = await IOUtils.getChildren(
      PathUtils.join(destination.filePath.path, "tmp")
    );
    Assert.equal(pending.length, 1);
    const eol = AppConstants.platform == "win" ? "\r\n" : "\n";
    const flags = (original.flags & ~Ci.nsMsgMessageFlags.RuntimeOnly & 0xffff)
      .toString(16)
      .padStart(4, "0");
    const prefix =
      `X-Mozilla-Status: ${flags}${eol}` +
      `X-Mozilla-Status2: 00000000${eol}` +
      `X-Mozilla-Keys: ${" ".repeat(80)}${eol}`;
    Assert.equal(await IOUtils.readUTF8(pending[0]), prefix + raw);
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

add_task(async function test_imapCopyFinishFailure() {
  await checkImapFinishFailure(false);
});
add_task(async function test_imapMoveFinishFailure() {
  await checkImapFinishFailure(true);
});

/**
 * Wait for a real native IMAP source-delete reply after a finished local body.
 *
 * @param {string} storeType - Local mbox or maildir provider.
 * @param {boolean} refuseStore - Whether the real server rejects its STORE.
 * @param {boolean} [excludeMetadata=false] - Exclude priority, tags and junk score.
 * @returns {Promise<void>} Resolves after terminal source/body identity checks.
 */
async function checkImapMoveSettlement(
  storeType,
  refuseStore,
  excludeMetadata = false
) {
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
  let restoreStore;
  const propertyPref = "mailnews.database.summary.dontPreserveOnMove";
  const oldProperties = {
    hadValue: Services.prefs.prefHasUserValue(propertyPref),
    value: Services.prefs.getCharPref(propertyPref, ""),
  };
  try {
    if (excludeMetadata) {
      Services.prefs.setCharPref(
        propertyPref,
        oldProperties.value + " priority keywords junkscore"
      );
    }
    for (const { name } of prefs) {
      Services.prefs.setCharPref(name, contract);
    }
    localAccountUtils.loadLocalMailAccount();
    const database = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    );
    Assert.ok(database instanceof Ci.nsIDatabaseCore);
    const destination = localAccountUtils.rootFolder.createLocalSubfolder(
      "native-move-settlement"
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
      "Subject: Native IMAP move settlement\r\n" +
      "Message-ID: <native-move-settlement@example.invalid>\r\n" +
      "References: <first@example.invalid> <second@example.invalid>\r\n\r\n" +
      "Exact retained IMAP move settlement body.\r\n";
    const file = do_get_profile();
    file.append(`native-move-settlement-${storeType}.eml`);
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
      "native-move-settlement@example.invalid"
    );
    const messageId = source.messageId;
    source.priority = Ci.nsMsgPriority.high;
    source.setStringProperty("keywords", "first-tag second-tag");
    source.setStringProperty("junkscore", "73");
    const key = source.messageKey;
    const flags = source.flags;
    const token = source.storeToken;
    const size = source.messageSize;
    const uid = source.getUint32Property("uidOnServer");
    Assert.equal(uid, serverMessage.uid);
    Assert.notEqual(key, uid);
    source.setStringProperty("copyErrorProperty", "exact retained value");
    const stops = [];
    let sourceKeysAtStop;
    let wire;
    let deleteCommands = 0;
    let resolveDeleteCommand;
    const deleteCommand = new Promise(resolve => {
      resolveDeleteCommand = resolve;
    });
    const copied = new PromiseTestUtils.PromiseCopyListener({
      onStopCopy(status) {
        stops.push(status);
        sourceKeysAtStop = inbox.msgDatabase.listAllKeys();
      },
    });
    const connections = IMAPPump.daemon.getConnections("INBOX");
    Assert.equal(connections.length, 1);
    const connection = connections[0];
    const hadStore = Object.hasOwn(connection, "STORE");
    const originalStore = connection.STORE;
    restoreStore = () => {
      if (hadStore) {
        connection.STORE = originalStore;
      } else {
        delete connection.STORE;
      }
    };
    connection.STORE = function (args, isUid) {
      const commandFlags = Array.isArray(args[2]) ? args[2] : [args[2]];
      if (commandFlags.includes("\\Deleted")) {
        deleteCommands++;
        wire = {
          isUid,
          uid: args[0],
          stops: stops.length,
          destinationKeys: destination.msgDatabase.listAllKeys(),
        };
        resolveDeleteCommand();
        if (refuseStore) {
          return "NO Source deletion refused by ordinary fixture";
        }
      }
      return originalStore.call(this, args, isUid);
    };
    MailServices.copy.copyMessages(
      inbox,
      [source],
      destination,
      true,
      copied,
      null,
      false
    );
    if (refuseStore) {
      await Assert.rejects(
        copied.promise,
        error => Number(error.message) === Cr.NS_MSG_ERROR_IMAP_COMMAND_FAILED
      );
    } else {
      await copied.promise;
    }
    await deleteCommand;
    Assert.equal(deleteCommands, 1);
    Assert.equal(wire.isUid, true);
    Assert.equal(String(wire.uid), String(uid));
    Assert.equal(
      wire.stops,
      0,
      "Copy completion waits for the actual source STORE reply"
    );
    Assert.equal(
      wire.destinationKeys.length,
      1,
      "The destination is published before source retirement"
    );
    const expectedStatus = refuseStore
      ? Cr.NS_MSG_ERROR_IMAP_COMMAND_FAILED
      : Cr.NS_OK;
    Assert.deepEqual(stops, [expectedStatus]);
    Assert.deepEqual(sourceKeysAtStop, refuseStore ? [key] : []);
    if (refuseStore) {
      Assert.deepEqual(inbox.msgDatabase.listAllKeys(), [key]);
      const retained = inbox.msgDatabase.getMsgHdrForKey(key);
      Assert.equal(retained.storeToken, token);
      Assert.equal(retained.priority, Ci.nsMsgPriority.high);
      Assert.equal(
        retained.getStringProperty("keywords"),
        "first-tag second-tag"
      );
      Assert.equal(retained.getStringProperty("junkscore"), "73");
      Assert.equal(retained.flags, flags);
      Assert.equal(retained.messageSize, size);
      Assert.equal(retained.getUint32Property("uidOnServer"), uid);
      Assert.equal(
        retained.getStringProperty("copyErrorProperty"),
        "exact retained value"
      );
      Assert.ok(!serverMessage.flags.includes("\\Deleted"));
      Assert.equal(await IOUtils.readUTF8(file.path), raw);
    } else {
      Assert.deepEqual(inbox.msgDatabase.listAllKeys(), []);
      Assert.ok(serverMessage.flags.includes("\\Deleted"));
      Assert.equal(await IOUtils.readUTF8(file.path), raw);
    }
    const keys = destination.msgDatabase.listAllKeys();
    Assert.equal(keys.length, 1);
    const finished = destination.msgDatabase.getMsgHdrForKey(keys[0]);
    Assert.notEqual(finished.messageKey, key);
    Assert.equal(finished.messageId, messageId);
    Assert.equal(
      finished.priority,
      excludeMetadata ? Ci.nsMsgPriority.none : Ci.nsMsgPriority.high
    );
    Assert.equal(
      finished.getStringProperty("keywords"),
      excludeMetadata ? "" : "first-tag second-tag"
    );
    Assert.equal(
      finished.getStringProperty("junkscore"),
      excludeMetadata ? "" : "73"
    );
    if (excludeMetadata) {
      Assert.ok(!finished.properties.includes("keywords"));
      Assert.ok(!finished.properties.includes("junkscore"));
    }
    Assert.deepEqual(keys, wire.destinationKeys);
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
    const eol = AppConstants.platform == "win" ? "\r\n" : "\n";
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
    restoreStore?.();
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
      if (oldProperties.hadValue) {
        Services.prefs.setCharPref(propertyPref, oldProperties.value);
      } else {
        Services.prefs.clearUserPref(propertyPref);
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
  add_task(async function test_imapMoveWaitsForSourceMbox() {
    await checkImapMoveSettlement("mbox", false);
  });
  add_task(async function test_imapMoveWaitsForSourceMaildir() {
    await checkImapMoveSettlement("maildir", false);
  });
  add_task(async function test_imapMoveSourceErrorMbox() {
    await checkImapMoveSettlement("mbox", true);
  });
  add_task(async function test_imapMoveSourceErrorMaildir() {
    await checkImapMoveSettlement("maildir", true);
  });
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_imapMoveExcludesMetadataMbox() {
    await checkImapMoveSettlement("mbox", false, true);
  });
  add_task(async function test_imapMoveExcludesMetadataMaildir() {
    await checkImapMoveSettlement("maildir", false, true);
  });
}
