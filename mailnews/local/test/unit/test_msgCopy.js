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
    source.setStringProperty("UidOnServer", "retain case-distinct property");
    const uidText = source.getStringProperty("uidOnServer");
    const rawCopy = destination.msgDatabase.copyHdrFromExistingHdr(
      0xffffffff /* nsMsgKey_None */,
      source,
      false
    );
    Assert.ok(rawCopy.properties.includes("uidOnServer"));
    Assert.equal(rawCopy.getStringProperty("uidOnServer"), uidText);
    Assert.equal(
      rawCopy.getStringProperty("UidOnServer"),
      "retain case-distinct property"
    );
    Assert.deepEqual(destination.msgDatabase.listAllKeys(), []);
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
    Assert.ok(retained.properties.includes("uidOnServer"));
    Assert.equal(retained.getStringProperty("uidOnServer"), uidText);
    Assert.equal(
      retained.getStringProperty("UidOnServer"),
      "retain case-distinct property"
    );
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
    Assert.ok(!finished.properties.includes("uidOnServer"));
    Assert.equal(finished.getUint32Property("uidOnServer"), 0);
    Assert.ok(finished.properties.includes("UidOnServer"));
    Assert.equal(
      finished.getStringProperty("UidOnServer"),
      "retain case-distinct property"
    );
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

const { MockRegistrar: CopyOrderRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);

const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

/**
 * Observes the real native providers and mailbox listeners for one copy case.
 * Restores the three factories after all forwarded stop callbacks return.
 *
 * @param {string} storeType - The mbox or maildir provider.
 * @returns {object} Per-case calls, issued streams, requests and cleanup methods.
 */
function observePublicationCalls(storeType) {
  const storeContract = `@mozilla.org/msgstore/${storeType == "mbox" ? "berkeleystore" : "maildirstore"};1`;
  const serviceContracts = [
    "@mozilla.org/messenger/messageservice;1?type=mailbox",
    "@mozilla.org/messenger/messageservice;1?type=mailbox-message",
  ];
  const contracts = [storeContract, ...serviceContracts];
  const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
  const cids = contracts.map(contract => registrar.contractIDToCID(contract));
  const nativeService = Cc[serviceContracts[0]].getService(
    Ci.nsIMsgMessageService
  );
  // This case owns one server and must acquire exactly one fresh native store.
  const nativeStore = Cc[storeContract].createInstance(Ci.nsIMsgPluggableStore);
  const registrations = [];
  const order = {
    destinationURI: null,
    events: [],
    requests: [],
    instances: 0,
    memberScope: null,
    record(type, details = {}) {
      const event = { type, seq: this.events.length, ...details };
      this.events.push(event);
      return event;
    },
    async drain() {
      let count = 0;
      while (count < this.requests.length) {
        const pending = this.requests.slice(count);
        count = this.requests.length;
        await Promise.all(pending.map(request => request.finished));
      }
    },
    restore() {
      while (registrations.length) {
        CopyOrderRegistrar.unregister(registrations.pop());
      }
      for (const [index, contract] of contracts.entries()) {
        Assert.equal(
          registrar.contractIDToCID(contract).toString(),
          cids[index].toString()
        );
      }
      const count = this.instances;
      Assert.equal(
        Cc[storeContract].createInstance(Ci.nsIMsgPluggableStore).storeType,
        storeType
      );
      Assert.equal(
        this.instances,
        count,
        "Fresh construction uses the restored native factory"
      );
    },
  };

  // Keep every argument and out parameter; only the actual listener is observed.
  const copyRequest = (method, listenerIndex, args) => {
    const request = {
      id: order.requests.length + 1,
      nextMember: 2,
      method,
      sourceURI: method == "CopyMessages" ? args[1].URI : args[0],
      keys: method == "CopyMessages" ? Array.from(args[0]) : null,
    };
    request.finished = new Promise(resolve => {
      request.settled = resolve;
    });
    order.requests.push(request);
    const original = args[listenerIndex];
    const copy = original.QueryInterface(Ci.nsICopyMessageListener);
    order.record("service", {
      id: request.id,
      move: args[listenerIndex + 1],
      urlListener: args[listenerIndex + 2],
      msgWindow: args[listenerIndex + 3],
    });
    args[listenerIndex] = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIStreamListener",
        "nsIRequestObserver",
        "nsICopyMessageListener",
      ]),
      onStartRequest(nativeRequest) {
        return original.onStartRequest(nativeRequest);
      },
      onDataAvailable(...data) {
        return original.onDataAvailable(...data);
      },
      onStopRequest(nativeRequest, status) {
        order.record("stop", { id: request.id, nativeRequest, status });
        try {
          return original.onStopRequest(nativeRequest, status);
        } finally {
          request.settled();
        }
      },
      beginCopy() {
        return copy.beginCopy();
      },
      startMessage() {
        const member = request.nextMember++;
        const previous = order.memberScope;
        order.memberScope = { id: request.id, member };
        order.record("member", { id: request.id, member });
        try {
          return copy.startMessage();
        } catch (error) {
          order.record("member-error", {
            id: request.id,
            member,
            result: error.result,
          });
          throw error;
        } finally {
          order.memberScope = previous;
        }
      },
      copyData(...data) {
        return copy.copyData(...data);
      },
      endMessage(key) {
        return copy.endMessage(key);
      },
      endCopy(succeeded) {
        return copy.endCopy(succeeded);
      },
      endMove(succeeded) {
        return copy.endMove(succeeded);
      },
    };
    try {
      return nativeService[method](...args);
    } catch (error) {
      request.settled();
      throw error;
    }
  };
  const service = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgMessageService"]),
    copyMessage(...args) {
      return copyRequest("copyMessage", 1, args);
    },
    CopyMessages(...args) {
      return copyRequest("CopyMessages", 2, args);
    },
  };
  for (const method of [
    "loadMessage",
    "saveMessageToDisk",
    "getUrlForUri",
    "Search",
    "streamMessage",
    "streamHeaders",
    "isMsgInMemCache",
    "messageURIToMsgHdr",
  ]) {
    service[method] = (...args) => nativeService[method](...args);
  }
  try {
    registrations.push(
      CopyOrderRegistrar.register(storeContract, () => {
        const native = nativeStore;
        order.instances++;
        const store = {
          QueryInterface: ChromeUtils.generateQI(["nsIMsgPluggableStore"]),
          get storeType() {
            return native.storeType;
          },
          get supportsCompaction() {
            return native.supportsCompaction;
          },
          getNewMsgOutputStream(folder) {
            const event =
              folder?.URI == order.destinationURI
                ? order.record("open", { scope: order.memberScope })
                : null;
            const stream = native.getNewMsgOutputStream(folder);
            if (event) {
              event.stream = stream;
            }
            return stream;
          },
          finishNewMessage(folder, stream) {
            const observing = folder?.URI == order.destinationURI;
            if (observing) {
              order.record("finish-entry", { stream });
            }
            try {
              const token = native.finishNewMessage(folder, stream);
              if (observing) {
                order.record("finish", { stream, token });
              }
              return token;
            } catch (error) {
              if (observing) {
                order.record("finish-error", { stream, result: error.result });
              }
              throw error;
            }
          },
        };
        for (const method of [
          "discoverSubFolders",
          "discoverChildFolders",
          "createFolder",
          "ensureLocalStore",
          "deleteFolder",
          "renameFolder",
          "hasSpaceAvailable",
          "copyFolder",
          "discardNewMessage",
          "getMsgInputStream",
          "deleteMessages",
          "deleteStoreMessages",
          "copyMessages",
          "asyncCompact",
          "isSummaryFileValid",
          "setSummaryFileValid",
          "asyncScan",
          "changeFlags",
          "changeKeywords",
          "estimateFolderSize",
        ]) {
          store[method] = (...args) => native[method](...args);
        }
        return store;
      })
    );
    for (const contract of serviceContracts) {
      registrations.push(CopyOrderRegistrar.register(contract, () => service));
    }
  } catch (error) {
    order.restore();
    throw error;
  }
  return order;
}

/**
 * Checks actual provider returns before publication and native stop before completion.
 * This does not establish physical close success or the whole stop callback return.
 *
 * @param {object} order - The per-case native observations.
 * @param {number} finishedCount - Expected successful provider Finish calls.
 * @param {number} requestCount - Expected native requests and public completions.
 */
function assertPublicationOrder(order, finishedCount, requestCount) {
  const calls = type => order.events.filter(event => event.type == type);
  const opens = calls("open");
  const entries = calls("finish-entry");
  const finishes = calls("finish");
  Assert.equal(
    order.instances,
    1,
    "The single owned native account acquired its one fresh provider"
  );
  Assert.equal(opens.length, finishedCount);
  Assert.equal(
    entries.length,
    finishedCount,
    "Each issued target receives one Finish call"
  );
  Assert.equal(finishes.length, finishedCount);
  Assert.deepEqual(calls("finish-error"), []);
  for (const [index, finish] of finishes.entries()) {
    Assert.strictEqual(entries[index].stream, opens[index].stream);
    Assert.strictEqual(finish.stream, opens[index].stream);
    Assert.less(opens[index].seq, entries[index].seq);
    Assert.less(entries[index].seq, finish.seq);
    Assert.equal(typeof finish.token, "string");
    Assert.notEqual(finish.token, "");
  }
  for (const published of calls("publish")) {
    const matching = finishes.filter(
      finish => finish.token === published.token
    );
    Assert.equal(
      matching.length,
      1,
      "Publication has one actual provider result"
    );
    Assert.less(
      matching[0].seq,
      published.seq,
      "Provider Finish returned before publication"
    );
  }
  Assert.equal(order.requests.length, requestCount);
  Assert.equal(calls("stop").length, requestCount);
  Assert.equal(calls("complete").length, requestCount);
  for (const request of order.requests) {
    const stops = calls("stop").filter(event => event.id == request.id);
    const completions = calls("complete").filter(
      event => event.id == request.id
    );
    Assert.equal(stops.length, 1);
    Assert.equal(completions.length, 1);
    Assert.less(
      stops[0].seq,
      completions[0].seq,
      "Native stop entry precedes public completion"
    );
  }
  for (const event of calls("service")) {
    Assert.equal(
      event.move,
      false,
      "The native service does not retire the source"
    );
    Assert.equal(event.urlListener, null);
    Assert.equal(event.msgWindow, null);
  }
}

/**
 * Runs a publication case with a real native local account and store.
 *
 * @param {string} storeType - The mbox or maildir provider.
 * @param {(context: {rootFolder: nsIMsgLocalMailFolder, database: nsIDatabaseCore, accounts: nsIMsgAccount[], order: object|null}) => Promise<void>} run - Receives the owned fixture.
 * @param {object} [options] - Direct observation and quarantine selection.
 * @param {boolean} [options.observeOrder=false] - Observe actual provider and protocol calls.
 * @param {boolean} [options.quarantine=false] - Write the observed mbox case through quarantine.
 * @returns {Promise<void>} Resolves after the case and owned account cleanup.
 */
async function withPublicationStore(
  storeType,
  run,
  { observeOrder = false, quarantine = false } = {}
) {
  const prefs = [
    "mail.serverDefaultStoreContractID",
    "mail.server.default.storeContractID",
  ].map(name => ({
    name,
    hadValue: Services.prefs.prefHasUserValue(name),
    value: Services.prefs.getCharPref(name, ""),
  }));
  const accounts = [];
  const scanPref = "mailnews.downloadToTempFile";
  const hadScanPref = Services.prefs.prefHasUserValue(scanPref);
  const oldScanPref = Services.prefs.getBoolPref(scanPref, false);
  let order = null;
  try {
    if (observeOrder) {
      Services.prefs.setBoolPref(scanPref, quarantine);
      Assert.equal(Services.prefs.getBoolPref(scanPref), quarantine);
      order = observePublicationCalls(storeType);
    }
    const contract = `@mozilla.org/msgstore/${storeType == "mbox" ? "berkeleystore" : "maildirstore"};1`;
    for (const { name } of prefs) {
      Services.prefs.setCharPref(name, contract);
    }
    const server = MailServices.accounts.createIncomingServer(
      "publication",
      "publication.invalid",
      "none"
    );
    server.setStringValue("storeContractID", contract);
    const account = MailServices.accounts.createAccount();
    accounts.push(account);
    account.incomingServer = server;
    const rootFolder = server.rootMsgFolder.QueryInterface(
      Ci.nsIMsgLocalMailFolder
    );
    const database = Cc["@mozilla.org/msgDatabase/msgDBService;1"]
      .getService(Ci.nsIMsgDBService)
      .QueryInterface(Ci.nsIDatabaseCore);
    Assert.equal(server.msgStore.storeType, storeType);
    await run({ rootFolder, database, accounts, order });
  } finally {
    try {
      await order?.drain();
      for (const account of accounts.reverse()) {
        MailServices.accounts.removeAccount(account, false);
      }
    } finally {
      try {
        order?.restore();
      } finally {
        if (observeOrder) {
          if (hadScanPref) {
            Services.prefs.setBoolPref(scanPref, oldScanPref);
          } else {
            Services.prefs.clearUserPref(scanPref);
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
}

/**
 * Checks the selected provider and returns the folder's real database.
 *
 * @param {nsIMsgLocalMailFolder} folder - The owned local folder.
 * @param {string} storeType - The expected mbox or maildir provider.
 * @returns {nsIMsgDatabase} The folder database.
 */
function assertPublicationFolder(folder, storeType) {
  Assert.equal(folder.msgStore.storeType, storeType);
  const database = folder.msgDatabase;
  Assert.ok(database);
  Assert.ok(database.summaryValid);
  return database;
}

/**
 * Reads and closes the complete stored message stream.
 *
 * @param {nsIInputStream} stream - The message stream.
 * @returns {string} The exact retrieved bytes.
 */
function readPublicationBytes(stream) {
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

/**
 * Checks complete metadata at destination publication.
 *
 * @param {string} storeType - The mbox or maildir provider.
 * @param {boolean} isMove - Whether the first request moves its source messages.
 * @param {boolean} [quarantine=false] - Enable the real mbox quarantine wrapper.
 * @returns {Promise<void>} Resolves after real copy completion and custody checks.
 */
async function checkCompletePublication(storeType, isMove, quarantine = false) {
  await withPublicationStore(
    storeType,
    async ({ rootFolder, order }) => {
      const name = isMove ? "complete-move" : "complete-copy";
      const source = rootFolder
        .createLocalSubfolder(name + "-source")
        .QueryInterface(Ci.nsIMsgLocalMailFolder);
      const destination = rootFolder
        .createLocalSubfolder(name + "-destination")
        .QueryInterface(Ci.nsIMsgLocalMailFolder);
      assertPublicationFolder(source, storeType);
      const db = assertPublicationFolder(destination, storeType);
      const raw = [
        "From: Sender <sender@invalid>",
        "To: Recipient <recipient@invalid>",
        "Date: Tue, 01 Jan 2019 00:00:00 +0000",
        "Message-ID: <complete-copy@invalid>",
        "Subject: Wire subject",
        "",
        "From a destination body.",
        "Last destination line.",
        "",
      ].join("\r\n");
      Assert.equal(raw.length, 217, "The literal fixture size is independent");
      const original = source.addMessage(raw);
      original.subject = "Stored subject";
      original.flags =
        Ci.nsMsgMessageFlags.Read |
        Ci.nsMsgMessageFlags.Marked |
        Ci.nsMsgMessageFlags.Replied |
        Ci.nsMsgMessageFlags.Offline;
      original.charset = "utf-8";
      original.accountKey = "original-account";
      original.messageSize = 65535;
      original.offlineMessageSize = 123456;
      original.lineCount = 888;
      for (const [key, value] of [
        ["size", "000Ff"],
        ["numLines", "000Aa"],
        ["offlineMsgSize", "000Bf"],
        ["dateReceived", "00aBcD"],
      ]) {
        original.setStringProperty(key, value);
      }
      const sourceKey = original.messageKey;
      const sourceToken = original.storeToken;
      order.destinationURI = destination.URI;
      const additions = [];
      const changes = [];
      const listener = {
        QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
        onHdrFlagsChanged() {
          changes.push("flags");
        },
        onHdrDeleted() {},
        onParentChanged() {},
        onAnnouncerGoingAway() {},
        onReadChanged() {},
        onJunkScoreChanged() {},
        onHdrPropertyChanged() {
          changes.push("property");
        },
        onEvent() {},
        onHdrAdded(header) {
          order.record("publish", { token: header.storeToken });
          const snapshot = {};
          additions.push(snapshot);
          try {
            snapshot.subject = header.subject;
            snapshot.messageId = header.messageId;
            snapshot.flags = header.flags;
            snapshot.size = header.messageSize;
            snapshot.offlineSize = header.offlineMessageSize;
            snapshot.lines = header.lineCount;
            snapshot.charset = header.charset;
            snapshot.account = header.accountKey;
            snapshot.extras = [
              "size",
              "numLines",
              "offlineMsgSize",
              "dateReceived",
            ].map(key => header.getStringProperty(key));
            snapshot.member = db.containsKey(header.messageKey);
            snapshot.total = destination.getTotalMessages(false);
            snapshot.unread = destination.getNumUnread(false);
            snapshot.hasToken = header.storeToken !== "";
            if (snapshot.hasToken) {
              snapshot.raw = readPublicationBytes(
                destination.getMsgInputStream(header)
              );
              snapshot.storeRaw = readPublicationBytes(
                destination.msgStore.getMsgInputStream(
                  destination,
                  header.storeToken,
                  0
                )
              );
            }
          } catch (error) {
            snapshot.error = String(error);
          }
        },
      };
      db.addListener(listener);
      registerCleanupFunction(() => db.removeListener(listener));
      const stopped = new PromiseTestUtils.PromiseCopyListener({
        onStopCopy(status) {
          order.record("complete", { id: 1, status });
        },
      });
      MailServices.copy.copyMessages(
        source,
        [original],
        destination,
        isMove,
        stopped,
        null,
        false
      );
      await stopped.promise;
      await order.drain();
      assertPublicationOrder(order, 1, 1);
      Assert.equal(
        order.events.filter(event => event.type == "publish").length,
        1
      );
      Assert.equal(
        order.events.find(event => event.type == "complete").status,
        Cr.NS_OK
      );
      Assert.equal(order.requests[0].method, "copyMessage");
      Assert.equal(order.requests[0].sourceURI, source.getUriForMsg(original));
      Assert.deepEqual(
        additions,
        [
          {
            subject: "Stored subject",
            messageId: "complete-copy@invalid",
            flags:
              Ci.nsMsgMessageFlags.Read |
              Ci.nsMsgMessageFlags.Marked |
              Ci.nsMsgMessageFlags.Replied,
            size: 217,
            offlineSize: 0,
            lines: 2,
            charset: "utf-8",
            account: "original-account",
            extras: ["000Ff", "000Aa", "000Bf", "00aBcD"],
            member: true,
            total: 1,
            unread: 0,
            hasToken: true,
            raw,
            storeRaw: raw,
          },
        ],
        "One addition exposes destination storage and complete metadata"
      );
      Assert.deepEqual(
        changes,
        [],
        "No later setters complete the published header"
      );
      assertPublicationFolder(destination, storeType);
      const copied = Array.from(destination.messages);
      Assert.equal(copied.length, 1);
      Assert.equal(
        readPublicationBytes(destination.getMsgInputStream(copied[0])),
        raw
      );
      assertPublicationFolder(source, storeType);
      Assert.deepEqual(
        source.msgDatabase.listAllKeys(),
        isMove ? [] : [sourceKey]
      );
      if (!isMove) {
        Assert.equal(original.storeToken, sourceToken);
        Assert.equal(original.messageSize, 65535);
        Assert.equal(original.offlineMessageSize, 123456);
        Assert.equal(original.lineCount, 888);
        Assert.equal(
          readPublicationBytes(source.getMsgInputStream(original)),
          raw
        );
      }
    },
    { observeOrder: true, quarantine }
  );
}

/**
 * Checks failed mailbox publication followed by a reentrant move.
 *
 * @param {string} storeType - The mbox or maildir provider.
 * @param {boolean} isMove - Whether the first request moves its source messages.
 * @param {boolean} [quarantine=false] - Enable the real mbox quarantine wrapper.
 * @returns {Promise<void>} Resolves after real copy completion and custody checks.
 */
async function checkDeferredMailboxPublicationFailure(
  storeType,
  isMove,
  quarantine = false
) {
  await withPublicationStore(
    storeType,
    async ({ rootFolder, database, order }) => {
      const name = isMove ? "deferred-move" : "deferred-copy";
      const source = rootFolder
        .createLocalSubfolder(name + "-source")
        .QueryInterface(Ci.nsIMsgLocalMailFolder);
      const secondSource = rootFolder
        .createLocalSubfolder(name + "-second-source")
        .QueryInterface(Ci.nsIMsgLocalMailFolder);
      const destination = rootFolder
        .createLocalSubfolder(name + "-destination")
        .QueryInterface(Ci.nsIMsgLocalMailFolder);
      assertPublicationFolder(source, storeType);
      assertPublicationFolder(secondSource, storeType);
      const db = assertPublicationFolder(destination, storeType);
      const subjects = [
        "Kept prefix",
        "Deferred attach fault",
        "Refused suffix",
      ];
      const raws = subjects.map((subject, index) =>
        [
          "From: sender@invalid",
          "To: recipient@invalid",
          "Date: Tue, 01 Jan 2019 00:00:00 +0000",
          "Message-ID: <" + name + "-first-" + index + "@invalid>",
          "Subject: " + subject,
          "",
          "First request body " + index + ".",
          "",
        ].join("\r\n")
      );
      const secondRaws = ["one", "two"].map(word =>
        [
          "From: second@invalid",
          "To: destination@invalid",
          "Date: Wed, 02 Jan 2019 00:00:00 +0000",
          "Message-ID: <" + name + "-second-" + word + "@invalid>",
          "Subject: Second wire " + word,
          "",
          "Second request body " + word + ".",
          "",
        ].join("\r\n")
      );
      const messages = raws.map(raw => source.addMessage(raw));
      const secondMessages = secondRaws.map(raw =>
        secondSource.addMessage(raw)
      );
      const firstFlags =
        Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked;
      for (const header of messages) {
        header.flags = firstFlags;
      }
      const secondFlags = [
        Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Replied,
        Ci.nsMsgMessageFlags.Read |
          Ci.nsMsgMessageFlags.Marked |
          Ci.nsMsgMessageFlags.Replied,
      ];
      for (const [index, header] of secondMessages.entries()) {
        header.subject = "Second stored " + ["one", "two"][index];
        header.flags = secondFlags[index];
      }
      const keys = messages.map(header => header.messageKey);
      const tokens = messages.map(header => header.storeToken);
      const secondKeys = secondMessages.map(header => header.messageKey);
      const secondTokens = secondMessages.map(header => header.storeToken);
      const sourcePaths =
        storeType == "maildir"
          ? tokens.map(token =>
              PathUtils.join(source.filePath.path, "cur", token)
            )
          : [source.filePath.path];
      const before = await Promise.all(
        sourcePaths.map(file => IOUtils.read(file))
      );
      Assert.deepEqual(
        messages.map(header =>
          readPublicationBytes(source.getMsgInputStream(header))
        ),
        raws
      );
      Assert.deepEqual(
        secondMessages.map(header =>
          readPublicationBytes(secondSource.getMsgInputStream(header))
        ),
        secondRaws
      );

      order.destinationURI = destination.URI;
      const events = [];
      const faults = [];
      const additions = [];
      const firstStatuses = [];
      const secondStatuses = [];
      const firstProgress = [];
      const secondProgress = [];
      let firstStop;
      let secondStop;
      const observer = {
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
          order.record("publish", { token: header.storeToken });
          try {
            additions.push([
              header.messageId,
              header.subject,
              header.author,
              header.recipients,
              header.flags,
              readPublicationBytes(destination.getMsgInputStream(header)),
              secondSource.msgDatabase.listAllKeys(),
            ]);
          } catch (error) {
            additions.push(["callback error", String(error)]);
          }
        },
      };
      const secondListener = new PromiseTestUtils.PromiseCopyListener({
        onStartCopy() {
          events.push("second-start");
        },
        onProgress(current, total) {
          secondProgress.push([
            current,
            total,
            secondSource.msgDatabase.listAllKeys(),
          ]);
        },
        onStopCopy(status) {
          order.record("complete", { id: 2, status });
          events.push("second-stop");
          secondStatuses.push(status);
          secondStop = secondSource.msgDatabase.listAllKeys();
        },
      });
      const secondStopped = secondListener.promise.then(
        () => true,
        () => false
      );
      let started;
      let startFailed;
      const secondStarted = new Promise((resolve, reject) => {
        started = resolve;
        startFailed = reject;
      });
      const firstListener = new PromiseTestUtils.PromiseCopyListener({
        onStartCopy() {
          events.push("first-start");
        },
        onProgress(current, total) {
          firstProgress.push([current, total]);
        },
        onStopCopy(status) {
          order.record("complete", { id: 1, status });
          events.push("first-stop");
          firstStatuses.push(status);
          if (firstStatuses.length != 1) {
            return;
          }
          try {
            firstStop = {
              sourceKeys: source.msgDatabase.listAllKeys(),
              secondKeys: secondSource.msgDatabase.listAllKeys(),
              destinationIds: Array.from(
                destination.messages,
                header => header.messageId
              ),
              sourceBodies: messages.map(header =>
                readPublicationBytes(source.getMsgInputStream(header))
              ),
              secondBodies: secondMessages.map(header =>
                readPublicationBytes(secondSource.getMsgInputStream(header))
              ),
            };
            MailServices.copy.copyMessages(
              secondSource,
              secondMessages,
              destination,
              true,
              secondListener,
              null,
              false
            );
            started();
          } catch (error) {
            startFailed(error);
          }
        },
      });
      const firstStopped = firstListener.promise.then(
        () => true,
        () => false
      );
      const connection = database.connectionForTests;
      connection.createFunction("delivery_local_deferred_abort", 1, {
        onFunctionCall(args) {
          order.record("fault");
          events.push("fault");
          faults.push(args.getUTF8String(0));
          throw Components.Exception(
            "Deferred AttachHdr fault",
            Cr.NS_ERROR_FAILURE
          );
        },
      });
      let active = true;
      const cleanup = () => {
        if (active) {
          active = false;
          db.removeListener(observer);
          try {
            connection.executeSimpleSQL(
              "DROP TRIGGER IF EXISTS temp.delivery_local_deferred_abort"
            );
          } finally {
            connection.removeFunction("delivery_local_deferred_abort");
          }
        }
      };
      registerCleanupFunction(cleanup);
      db.addListener(observer);
      connection.executeSimpleSQL(
        "CREATE TEMP TRIGGER delivery_local_deferred_abort BEFORE INSERT ON main.messages " +
          "WHEN NEW.subject = 'Deferred attach fault' BEGIN SELECT " +
          "delivery_local_deferred_abort(NEW.subject); END"
      );
      let firstSucceeded;
      let secondSucceeded;
      const scan = new PromiseTestUtils.PromiseStoreScanListener();
      try {
        MailServices.copy.copyMessages(
          source,
          messages,
          destination,
          isMove,
          firstListener,
          null,
          false
        );
        firstSucceeded = await firstStopped;
        await secondStarted;
        secondSucceeded = await secondStopped;
        destination.msgStore.asyncScan(destination, scan);
        await scan.promise;
      } finally {
        cleanup();
      }
      await order.drain();
      assertPublicationOrder(order, 4, 2);
      Assert.deepEqual(
        order.requests.map(request => [
          request.method,
          request.sourceURI,
          request.keys,
        ]),
        [
          ["CopyMessages", source.URI, keys],
          ["CopyMessages", secondSource.URI, secondKeys],
        ]
      );
      Assert.equal(
        order.events.filter(event => event.type == "publish").length,
        3
      );
      const stop = order.events.find(
        event => event.type == "stop" && event.id == 1
      );
      const fault = order.events.find(event => event.type == "fault");
      Assert.ok(fault);
      Assert.less(fault.seq, stop.seq);
      Assert.equal(
        order.events.filter(
          event => event.type == "open" && event.seq < stop.seq
        ).length,
        2
      );
      Assert.equal(
        order.events.filter(
          event =>
            event.type == "open" &&
            event.seq > fault.seq &&
            event.seq < stop.seq
        ).length,
        0
      );
      Assert.deepEqual(
        order.events
          .filter(event => event.type == "member" && event.id == 1)
          .map(event => event.member),
        [2, 3]
      );
      Assert.deepEqual(
        order.events
          .filter(event => event.type == "member-error" && event.id == 1)
          .map(event => [event.member, event.result]),
        [[3, Cr.NS_ERROR_FAILURE]]
      );
      Assert.equal(
        order.events.filter(
          event =>
            event.type == "open" &&
            event.scope?.id == 1 &&
            event.scope.member == 3
        ).length,
        0
      );
      Assert.deepEqual(
        order.events
          .filter(event => event.type == "complete")
          .map(event => event.status),
        [Cr.NS_ERROR_FAILURE, Cr.NS_OK]
      );
      Assert.equal(firstSucceeded, false);
      Assert.equal(secondSucceeded, true);
      Assert.deepEqual(faults, ["Deferred attach fault"]);
      Assert.deepEqual(firstStatuses, [Cr.NS_ERROR_FAILURE]);
      Assert.deepEqual(secondStatuses, [Cr.NS_OK]);
      Assert.deepEqual(events, [
        "first-start",
        "fault",
        "first-stop",
        "second-start",
        "second-stop",
      ]);
      Assert.deepEqual(firstProgress, [
        [1, 3],
        [2, 3],
      ]);
      Assert.deepEqual(secondProgress, [
        [1, 2, secondKeys],
        [2, 2, secondKeys],
      ]);
      Assert.deepEqual(firstStop, {
        sourceKeys: keys,
        secondKeys,
        destinationIds: [name + "-first-0@invalid"],
        sourceBodies: raws,
        secondBodies: secondRaws,
      });
      Assert.deepEqual(
        secondStop,
        [],
        "Only the successful second move deletes its sources"
      );
      Assert.deepEqual(additions, [
        [
          name + "-first-0@invalid",
          "Kept prefix",
          "sender@invalid",
          "recipient@invalid",
          firstFlags,
          raws[0],
          secondKeys,
        ],
        [
          name + "-second-one@invalid",
          "Second stored one",
          "second@invalid",
          "destination@invalid",
          secondFlags[0],
          secondRaws[0],
          secondKeys,
        ],
        [
          name + "-second-two@invalid",
          "Second stored two",
          "second@invalid",
          "destination@invalid",
          secondFlags[1],
          secondRaws[1],
          secondKeys,
        ],
      ]);
      Assert.deepEqual(
        Array.from(destination.messages, header => [
          header.messageId,
          header.subject,
          header.flags,
        ]).toSorted((a, b) => a[0].localeCompare(b[0])),
        [
          [name + "-first-0@invalid", "Kept prefix", firstFlags],
          [name + "-second-one@invalid", "Second stored one", secondFlags[0]],
          [name + "-second-two@invalid", "Second stored two", secondFlags[1]],
        ]
      );
      Assert.deepEqual(
        scan.messages.toSorted(),
        [raws[0], raws[1], ...secondRaws].toSorted(),
        "The store keeps the prefix, finished unpublished member and only the second request bodies"
      );
      const failedIndex = scan.messages.indexOf(raws[1]);
      Assert.notEqual(scan.tokens[failedIndex], "");
      Assert.equal(
        readPublicationBytes(
          destination.msgStore.getMsgInputStream(
            destination,
            scan.tokens[failedIndex],
            0
          )
        ),
        raws[1]
      );
      Assert.deepEqual(source.msgDatabase.listAllKeys(), keys);
      Assert.deepEqual(
        messages.map(header => header.storeToken),
        tokens
      );
      Assert.deepEqual(
        messages.map(header => header.subject),
        subjects
      );
      Assert.deepEqual(
        messages.map(header => header.flags),
        [firstFlags, firstFlags, firstFlags]
      );
      for (const [index, file] of sourcePaths.entries()) {
        Assert.deepEqual(await IOUtils.read(file), before[index]);
      }
      Assert.deepEqual(
        messages.map(header =>
          readPublicationBytes(source.getMsgInputStream(header))
        ),
        raws
      );
      Assert.deepEqual(secondSource.msgDatabase.listAllKeys(), []);
      if (storeType == "maildir") {
        Assert.deepEqual(
          await IOUtils.getChildren(
            PathUtils.join(destination.filePath.path, "tmp")
          ),
          []
        );
        Assert.equal(
          (
            await IOUtils.getChildren(
              PathUtils.join(destination.filePath.path, "cur")
            )
          ).length,
          4
        );
        for (const token of secondTokens) {
          Assert.equal(
            await IOUtils.exists(
              PathUtils.join(secondSource.filePath.path, "cur", token)
            ),
            false
          );
        }
      }
      for (const folder of [source, secondSource, destination]) {
        assertPublicationFolder(folder, storeType);
      }
    },
    { observeOrder: true, quarantine }
  );
}

/**
 * Checks absent account and charset rows through an independent connection.
 *
 * @param {nsIMsgDBHdr} header - The stored message header.
 * @param {mozIStorageConnection} reader - An independent Panorama connection.
 */
function assertNoStoredAccountOrCharset(header, reader) {
  Assert.deepEqual(
    header.properties.filter(name => name == "account" || name == "msgCharSet"),
    []
  );
  const statement = reader.createStatement(
    "SELECT name FROM message_properties WHERE id = :id " +
      "AND name IN ('account', 'msgCharSet') ORDER BY name"
  );
  try {
    statement.params.id = header.messageKey;
    Assert.equal(
      statement.executeStep(),
      false,
      "Neither effective default is stored"
    );
  } finally {
    statement.finalize();
  }
}

/**
 * Rejects a real property-read error before writing destination bytes.
 *
 * @param {string} storeType - The mbox or maildir provider.
 * @returns {Promise<void>} Resolves after the real operation and custody checks.
 */
async function checkPropertyReadFailurePrecedesBodyWrite(storeType) {
  await withPublicationStore(storeType, async ({ rootFolder, database }) => {
    const source = rootFolder
      .createLocalSubfolder("property-fault-source")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const destination = rootFolder
      .createLocalSubfolder("property-fault-destination")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    assertPublicationFolder(source, storeType);
    const db = assertPublicationFolder(destination, storeType);
    const raw =
      "Date: Tue, 01 Jan 2019 00:00:00 +0000\r\n" +
      "Message-ID: <property-fault@invalid>\r\nSubject: Fault\r\n\r\nKeep.\r\n";
    const original = source.addMessage(raw);
    original.setStringProperty("localPublicationFault", "exact-value");
    const secondRaw = raw.replace(
      "property-fault@invalid",
      "property-control@invalid"
    );
    const second = source.addMessage(secondRaw);
    const key = original.messageKey;
    const keys = [key, second.messageKey];
    const token = original.storeToken;
    const sourcePaths =
      storeType == "maildir"
        ? [original, second].map(header =>
            PathUtils.join(source.filePath.path, "cur", header.storeToken)
          )
        : [source.filePath.path];
    const sourceBytes = await Promise.all(
      sourcePaths.map(file => IOUtils.read(file))
    );
    const faults = [];
    const additions = [];
    const statuses = [];
    const observer = {
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
        additions.push(header.messageId);
      },
    };
    const connection = database.connectionForTests;
    let active = true;
    const cleanup = () => {
      if (active) {
        active = false;
        db.removeListener(observer);
        try {
          connection.executeSimpleSQL(
            "DROP VIEW IF EXISTS temp.message_properties"
          );
        } finally {
          connection.removeFunction("delivery_local_property_fault");
        }
      }
    };
    connection.createFunction("delivery_local_property_fault", 3, {
      onFunctionCall(args) {
        if (
          args.getInt64(0) == key &&
          args.getUTF8String(1) == "localPublicationFault"
        ) {
          faults.push(args.getUTF8String(2));
          throw Components.Exception(
            "Property read fault",
            Cr.NS_ERROR_FAILURE
          );
        }
        return args.getUTF8String(2);
      },
    });
    registerCleanupFunction(cleanup);
    db.addListener(observer);
    connection.executeSimpleSQL(
      "CREATE TEMP VIEW message_properties AS SELECT id, name, " +
        "delivery_local_property_fault(id, name, value) AS value FROM main.message_properties"
    );
    let synchronousError = null;
    let succeeded;
    try {
      const listener = new PromiseTestUtils.PromiseCopyListener({
        onStopCopy(status) {
          statuses.push(status);
        },
      });
      const stopped = listener.promise.then(
        () => true,
        () => false
      );
      try {
        MailServices.copy.copyMessages(
          source,
          [original, second],
          destination,
          true,
          listener,
          null,
          false
        );
      } catch (error) {
        synchronousError = error.result;
      }
      succeeded = await stopped;
    } finally {
      cleanup();
    }
    Assert.deepEqual(
      faults,
      ["exact-value"],
      "The real property read failed once"
    );
    Assert.equal(synchronousError, Cr.NS_ERROR_FAILURE);
    Assert.equal(succeeded, false);
    Assert.deepEqual(statuses, [Cr.NS_ERROR_FAILURE]);
    Assert.deepEqual(additions, []);
    Assert.deepEqual(db.listAllKeys(), []);
    assertPublicationFolder(destination, storeType);
    assertPublicationFolder(source, storeType);
    Assert.deepEqual(source.msgDatabase.listAllKeys(), keys);
    Assert.equal(original.storeToken, token);
    Assert.equal(readPublicationBytes(source.getMsgInputStream(original)), raw);
    Assert.equal(
      readPublicationBytes(source.getMsgInputStream(second)),
      secondRaw
    );
    for (const [index, file] of sourcePaths.entries()) {
      Assert.deepEqual(
        await IOUtils.read(file),
        sourceBytes[index],
        "The failed move preserves exact source bytes"
      );
    }
    if (storeType == "maildir") {
      for (const directory of ["tmp", "cur"]) {
        Assert.deepEqual(
          await IOUtils.getChildren(
            PathUtils.join(destination.filePath.path, directory)
          ),
          []
        );
      }
    } else {
      Assert.equal(
        destination.filePath.fileSize,
        0,
        "No destination bytes were written"
      );
    }
  });
}

/**
 * Retains finished storage when the real SQL publication fails.
 *
 * @param {string} storeType - The mbox or maildir provider.
 * @returns {Promise<void>} Resolves after the real operation and custody checks.
 */
async function checkSqlFailureRetainsFinishedBody(storeType) {
  await withPublicationStore(storeType, async ({ rootFolder, database }) => {
    const folder = rootFolder
      .createLocalSubfolder("publication-sql-fault")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const db = assertPublicationFolder(folder, storeType);
    const raw =
      "Date: Tue, 01 Jan 2019 00:00:00 +0000\r\n" +
      "Message-ID: <publication-sql-fault@invalid>\r\n" +
      "Subject: SQL fault\r\n\r\nFinished body must remain.\r\n";
    const faults = [];
    const additions = [];
    const connection = database.connectionForTests;
    const observer = {
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
        additions.push(header.messageId);
      },
    };
    connection.createFunction("delivery_local_publication_abort", 1, {
      onFunctionCall(args) {
        faults.push(args.getUTF8String(0));
        throw Components.Exception(
          "Publication SQL fault",
          Cr.NS_ERROR_FAILURE
        );
      },
    });
    let active = true;
    const cleanup = () => {
      if (active) {
        active = false;
        db.removeListener(observer);
        try {
          connection.executeSimpleSQL(
            "DROP TRIGGER IF EXISTS temp.delivery_local_publication_abort"
          );
        } finally {
          connection.removeFunction("delivery_local_publication_abort");
        }
      }
    };
    registerCleanupFunction(cleanup);
    db.addListener(observer);
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER delivery_local_publication_abort BEFORE INSERT ON main.messages " +
        "WHEN NEW.subject = 'SQL fault' BEGIN SELECT " +
        "delivery_local_publication_abort(NEW.subject); END"
    );
    try {
      Assert.throws(() => folder.addMessage(raw), /NS_ERROR/);
    } finally {
      cleanup();
    }
    Assert.deepEqual(
      faults,
      ["SQL fault"],
      "SQL insertion reached the real fault"
    );
    Assert.deepEqual(additions, [], "A failed insertion is never published");
    Assert.deepEqual(db.listAllKeys(), []);
    let token;
    if (storeType == "maildir") {
      Assert.deepEqual(
        await IOUtils.getChildren(PathUtils.join(folder.filePath.path, "tmp")),
        []
      );
      const files = await IOUtils.getChildren(
        PathUtils.join(folder.filePath.path, "cur")
      );
      Assert.equal(files.length, 1, "Finished bytes remain after SQL rollback");
      token = PathUtils.filename(files[0]);
    } else {
      token = "0";
      Assert.greater(folder.filePath.fileSize, raw.length);
    }
    Assert.equal(
      readPublicationBytes(folder.msgStore.getMsgInputStream(folder, token, 0)),
      raw,
      "The finished token still retrieves the exact body after SQL failure"
    );
    assertPublicationFolder(folder, storeType);
  });
}

/**
 * Copies opaque property names without splitting them into storage keys.
 *
 * @param {string} storeType - The mbox or maildir provider.
 * @returns {Promise<void>} Resolves after the real operation and custody checks.
 */
async function checkOpaqueNamesSurviveNativeStorageExclusions(storeType) {
  await withPublicationStore(storeType, async ({ rootFolder }) => {
    const source = rootFolder
      .createLocalSubfolder("opaque-names-source")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const destination = rootFolder
      .createLocalSubfolder("opaque-names-destination")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    assertPublicationFolder(source, storeType);
    assertPublicationFolder(destination, storeType);
    const raw = [
      "Date: Tue, 01 Jan 2019 00:00:00 +0000",
      "Message-ID: <opaque-properties@invalid>",
      "Subject: Opaque names",
      "",
      "Opaque body.",
      "",
    ].join("\r\n");
    Assert.equal(raw.length, 119);
    const original = source.addMessage(raw);
    original.messageSize = 65535;
    original.offlineMessageSize = 123456;
    original.lineCount = 888;
    original.setStringProperty("msgOffset", "source-offset");
    for (const [name, value] of [
      ["messageSize offlineMessageSize", "opaque sizes"],
      ["storeToken msgOffset", "opaque tokens"],
      ["messageSize ", "trailing space"],
      [" messageSize", "leading space"],
    ]) {
      original.setStringProperty(name, value);
    }
    // Keep the preference matcher separate from native-key exclusion.
    const pref = "mailnews.database.summary.dontPreserveOnCopy";
    const hadPref = Services.prefs.prefHasUserValue(pref);
    const oldPref = Services.prefs.getCharPref(pref, "");
    const restorePref = () => {
      if (hadPref) {
        Services.prefs.setCharPref(pref, oldPref);
      } else {
        Services.prefs.clearUserPref(pref);
      }
    };
    registerCleanupFunction(restorePref);
    Services.prefs.setCharPref(pref, "");
    try {
      const listener = new PromiseTestUtils.PromiseCopyListener();
      MailServices.copy.copyMessages(
        source,
        [original],
        destination,
        false,
        listener,
        null,
        false
      );
      await listener.promise;
    } finally {
      restorePref();
    }
    const copied = Array.from(destination.messages);
    Assert.equal(copied.length, 1);
    Assert.deepEqual(
      [
        copied[0].getStringProperty("messageSize offlineMessageSize"),
        copied[0].getStringProperty("storeToken msgOffset"),
        copied[0].getStringProperty("messageSize "),
        copied[0].getStringProperty(" messageSize"),
      ],
      ["opaque sizes", "opaque tokens", "trailing space", "leading space"]
    );
    Assert.equal(copied[0].messageSize, 119);
    Assert.equal(copied[0].offlineMessageSize, 0);
    Assert.equal(copied[0].lineCount, 1);
    Assert.equal(copied[0].getStringProperty("msgOffset"), "");
    Assert.notEqual(copied[0].storeToken, "");
    Assert.equal(
      readPublicationBytes(destination.getMsgInputStream(copied[0])),
      raw
    );
    assertPublicationFolder(destination, storeType);
    assertPublicationFolder(source, storeType);
    Assert.deepEqual(source.msgDatabase.listAllKeys(), [original.messageKey]);
    Assert.equal(readPublicationBytes(source.getMsgInputStream(original)), raw);
  });
}

/**
 * Returns the native stream read error from the active copy.
 *
 * @param {string} storeType - The mbox or maildir provider.
 * @returns {Promise<void>} Resolves after the real operation and custody checks.
 */
async function checkCopyDataPreservesNativeReadFailure(storeType) {
  await withPublicationStore(storeType, async ({ rootFolder }) => {
    const source = rootFolder
      .createLocalSubfolder("native-read-fault-source")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const destination = rootFolder
      .createLocalSubfolder("native-read-fault-destination")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    assertPublicationFolder(source, storeType);
    const db = assertPublicationFolder(destination, storeType);
    const messages = ["first", "second"].map(name =>
      source.addMessage(
        "Date: Tue, 01 Jan 2019 00:00:00 +0000\r\n" +
          "Message-ID: <native-read-" +
          name +
          "@invalid>\r\n" +
          "Subject: Native read " +
          name +
          "\r\n\r\nKeep source bytes.\r\n"
      )
    );
    const keys = messages.map(header => header.messageKey);
    const tokens = messages.map(header => header.storeToken);
    const paths =
      storeType == "maildir"
        ? tokens.map(token =>
            PathUtils.join(source.filePath.path, "cur", token)
          )
        : [source.filePath.path];
    const before = await Promise.all(paths.map(file => IOUtils.read(file)));
    const pipe = Cc["@mozilla.org/pipe;1"].createInstance(Ci.nsIPipe);
    pipe.init(true, true, 0, 0);
    const input = pipe.inputStream;
    const output = pipe.outputStream;
    registerCleanupFunction(() => {
      input.close();
      output.close();
    });
    input.closeWithStatus(Cr.NS_ERROR_FILE_CORRUPTED);
    Assert.throws(() => input.available(), /NS_ERROR_FILE_CORRUPTED/);
    const copy = destination.QueryInterface(Ci.nsICopyMessageListener);
    const progress = [];
    const readResults = [];
    const statuses = [];
    const listener = new PromiseTestUtils.PromiseCopyListener({
      onProgress(current, total) {
        progress.push([current, total]);
        if (progress.length != 1) {
          return;
        }
        // The real native pipe Read returns this error with zero bytes.
        try {
          copy.copyData(input, 1);
          readResults.push(Cr.NS_OK);
        } catch (error) {
          readResults.push(error.result);
        }
      },
      onStopCopy(status) {
        statuses.push(status);
      },
    });
    const stopped = listener.promise.then(
      () => true,
      () => false
    );
    MailServices.copy.copyMessages(
      source,
      messages,
      destination,
      true,
      listener,
      null,
      false
    );
    Assert.equal(
      await stopped,
      false,
      "The failed member cannot complete a move"
    );
    Assert.equal(
      progress.length,
      1,
      "The active destination stream was reached once"
    );
    Assert.deepEqual(
      readResults,
      [Cr.NS_ERROR_FILE_CORRUPTED],
      "CopyData returns the original zero-byte native Read failure"
    );
    Assert.deepEqual(
      statuses,
      [Cr.NS_ERROR_FILE_CORRUPTED],
      "OnStopCopy preserves the original native Read failure exactly once"
    );
    Assert.deepEqual(db.listAllKeys(), [], "No failed member is published");
    assertPublicationFolder(destination, storeType);
    assertPublicationFolder(source, storeType);
    Assert.deepEqual(source.msgDatabase.listAllKeys(), keys);
    Assert.deepEqual(
      messages.map(header => header.storeToken),
      tokens
    );
    for (const [index, file] of paths.entries()) {
      Assert.deepEqual(await IOUtils.read(file), before[index]);
    }
    if (storeType == "maildir") {
      for (const directory of ["tmp", "cur"]) {
        Assert.deepEqual(
          await IOUtils.getChildren(
            PathUtils.join(destination.filePath.path, directory)
          ),
          []
        );
      }
    } else {
      Assert.equal(destination.filePath.fileSize, 0);
    }
  });
}

/**
 * Keeps account and charset absent across different account defaults.
 *
 * @param {string} storeType - The mbox or maildir provider.
 * @returns {Promise<void>} Resolves after the real operation and custody checks.
 */
async function checkCopyKeepsAbsentAccountAndCharsetAcrossServers(storeType) {
  await withPublicationStore(storeType, async ({ rootFolder, accounts }) => {
    const source = rootFolder
      .createLocalSubfolder("absent-account-source")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    assertPublicationFolder(source, storeType);
    const sourceAccount = MailServices.accounts.findAccountForServer(
      source.server
    );
    Assert.ok(sourceAccount, "The source belongs to a real account");
    const server = MailServices.accounts.createIncomingServer(
      "publication-fallback",
      "destination.invalid",
      "none"
    );
    server.setStringValue(
      "storeContractID",
      storeType == "maildir"
        ? "@mozilla.org/msgstore/maildirstore;1"
        : "@mozilla.org/msgstore/berkeleystore;1"
    );
    const account = MailServices.accounts.createAccount();
    account.incomingServer = server;
    accounts.push(account);
    const root = server.rootMsgFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
    const destination = root
      .createLocalSubfolder("absent-account-destination")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    assertPublicationFolder(destination, storeType);
    Assert.notEqual(source.server.key, destination.server.key);
    Assert.notEqual(sourceAccount.key, account.key);
    Assert.equal(
      MailServices.accounts.findAccountForServer(destination.server).key,
      account.key
    );
    const raw =
      "From: absent@invalid\r\nTo: recipient@invalid\r\n" +
      "Date: Tue, 01 Jan 2019 00:00:00 +0000\r\n" +
      "Message-ID: <absent-account-copy@invalid>\r\n" +
      "Subject: Absent stored defaults\r\n\r\nKeep defaults absent.\r\n";
    const original = source.addMessage(raw);
    const key = original.messageKey;
    const token = original.storeToken;
    const file = do_get_profile();
    file.append("panorama.sqlite");
    const reader = Services.storage.openUnsharedDatabase(file);
    try {
      Assert.equal(original.accountKey, sourceAccount.key);
      Assert.equal(original.charset, "");
      assertNoStoredAccountOrCharset(original, reader);
      const listener = new PromiseTestUtils.PromiseCopyListener();
      MailServices.copy.copyMessages(
        source,
        [original],
        destination,
        false,
        listener,
        null,
        false
      );
      await listener.promise;
      const copied = Array.from(destination.messages);
      Assert.equal(copied.length, 1);
      Assert.equal(copied[0].messageId, "absent-account-copy@invalid");
      Assert.equal(copied[0].subject, "Absent stored defaults");
      Assert.equal(
        copied[0].accountKey,
        account.key,
        "The destination uses its own account fallback"
      );
      Assert.notEqual(copied[0].accountKey, sourceAccount.key);
      Assert.equal(copied[0].charset, "");
      assertNoStoredAccountOrCharset(copied[0], reader);
      assertNoStoredAccountOrCharset(original, reader);
      Assert.equal(
        readPublicationBytes(destination.getMsgInputStream(copied[0])),
        raw
      );
    } finally {
      reader.close();
    }
    Assert.deepEqual(source.msgDatabase.listAllKeys(), [key]);
    Assert.equal(original.storeToken, token);
    Assert.equal(readPublicationBytes(source.getMsgInputStream(original)), raw);
    assertPublicationFolder(source, storeType);
    assertPublicationFolder(destination, storeType);
  });
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_copyPublishesDestinationStorageMbox() {
    await checkCompletePublication("mbox", false);
  });
  add_task(async function test_copyPublishesDestinationStorageMaildir() {
    await checkCompletePublication("maildir", false);
  });
  add_task(async function test_movePublishesDestinationStorageMbox() {
    await checkCompletePublication("mbox", true);
  });
  add_task(async function test_movePublishesDestinationStorageMaildir() {
    await checkCompletePublication("maildir", true);
  });
  add_task(async function test_copyPublishesAfterQuarantineFinish() {
    await checkCompletePublication("mbox", false, true);
  });
  add_task(async function test_movePublishesAfterQuarantineFinish() {
    await checkCompletePublication("mbox", true, true);
  });
  add_task(async function test_copyDefersQuarantineFailureCompletion() {
    await checkDeferredMailboxPublicationFailure("mbox", false, true);
  });
  add_task(async function test_moveDefersQuarantineFailureCompletion() {
    await checkDeferredMailboxPublicationFailure("mbox", true, true);
  });
  add_task(async function test_propertyReadFailurePrecedesBodyWriteMbox() {
    await checkPropertyReadFailurePrecedesBodyWrite("mbox");
  });
  add_task(async function test_propertyReadFailurePrecedesBodyWriteMaildir() {
    await checkPropertyReadFailurePrecedesBodyWrite("maildir");
  });
  add_task(async function test_sqlFailureRetainsFinishedBodyMbox() {
    await checkSqlFailureRetainsFinishedBody("mbox");
  });
  add_task(async function test_sqlFailureRetainsFinishedBodyMaildir() {
    await checkSqlFailureRetainsFinishedBody("maildir");
  });
  add_task(async function test_opaqueNamesSurviveNativeStorageExclusionsMbox() {
    await checkOpaqueNamesSurviveNativeStorageExclusions("mbox");
  });
  add_task(
    async function test_opaqueNamesSurviveNativeStorageExclusionsMaildir() {
      await checkOpaqueNamesSurviveNativeStorageExclusions("maildir");
    }
  );
  add_task(async function test_copyDataPreservesNativeReadFailureMbox() {
    await checkCopyDataPreservesNativeReadFailure("mbox");
  });
  add_task(async function test_copyDataPreservesNativeReadFailureMaildir() {
    await checkCopyDataPreservesNativeReadFailure("maildir");
  });
  add_task(async function test_copyDefersFailedMailboxCompletionMbox() {
    await checkDeferredMailboxPublicationFailure("mbox", false);
  });
  add_task(async function test_copyDefersFailedMailboxCompletionMaildir() {
    await checkDeferredMailboxPublicationFailure("maildir", false);
  });
  add_task(async function test_moveDefersFailedMailboxCompletionMbox() {
    await checkDeferredMailboxPublicationFailure("mbox", true);
  });
  add_task(async function test_moveDefersFailedMailboxCompletionMaildir() {
    await checkDeferredMailboxPublicationFailure("maildir", true);
  });
  add_task(
    async function test_copyKeepsAbsentAccountAndCharsetAcrossServersMbox() {
      await checkCopyKeepsAbsentAccountAndCharsetAcrossServers("mbox");
    }
  );
  add_task(
    async function test_copyKeepsAbsentAccountAndCharsetAcrossServersMaildir() {
      await checkCopyKeepsAbsentAccountAndCharsetAcrossServers("maildir");
    }
  );
}
/**
 * Keeps an initialization failure latched while the mailbox caller continues.
 *
 * @param {string} storeType - The mbox or maildir provider.
 * @param {boolean} isMove - Whether to request source removal after copying.
 * @returns {Promise<void>} Resolves after completion and source custody checks.
 */
async function checkDeferredInitializationFailure(storeType, isMove) {
  await withPublicationStore(storeType, async ({ rootFolder, database }) => {
    const name = isMove ? "init-move" : "init-copy";
    const source = rootFolder
      .createLocalSubfolder(name + "-source")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const destination = rootFolder
      .createLocalSubfolder(name + "-destination")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const sourceDB = assertPublicationFolder(source, storeType);
    const destinationDB = assertPublicationFolder(destination, storeType);
    const raws = ["Kept prefix", "Header init fault", "Refused suffix"].map(
      (subject, index) =>
        [
          "From: source@invalid",
          "To: recipient@invalid",
          "Date: Tue, 01 Jan 2019 00:00:00 +0000",
          "Message-ID: <" + name + "-" + index + "@invalid>",
          "Subject: " + subject,
          "",
          "Keep source body " + index + ".",
          "",
        ].join("\r\n")
    );
    const messages = raws.map(raw => source.addMessage(raw));
    for (const [index, header] of messages.entries()) {
      header.setStringProperty("initializationValue", "value-" + index);
      header.flags = Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked;
    }
    const keys = messages.map(header => header.messageKey);
    const tokens = messages.map(header => header.storeToken);
    const flags = messages.map(header => header.flags);
    const sourcePaths =
      storeType == "maildir"
        ? tokens.map(token =>
            PathUtils.join(source.filePath.path, "cur", token)
          )
        : [source.filePath.path];
    const before = await Promise.all(
      sourcePaths.map(file => IOUtils.read(file))
    );
    const additions = [];
    const faults = [];
    const statuses = [];
    const progress = [];
    let atStop;
    const observer = {
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
        // Allow the prefix to finish its storage/property writes before making
        // the next header's real property read fail during initialization.
        connection.executeSimpleSQL(
          "CREATE TEMP VIEW message_properties AS SELECT id, name, " +
            "local_initialization_fault(id, name, value) AS value FROM main.message_properties"
        );
        additions.push([
          header.messageId,
          readPublicationBytes(destination.getMsgInputStream(header)),
          sourceDB.listAllKeys(),
        ]);
      },
    };
    const connection = database.connectionForTests;
    connection.createFunction("local_initialization_fault", 3, {
      onFunctionCall(args) {
        if (
          args.getInt64(0) == keys[1] &&
          args.getUTF8String(1) == "initializationValue"
        ) {
          faults.push(args.getUTF8String(2));
          throw Components.Exception("Header init fault", Cr.NS_ERROR_FAILURE);
        }
        return args.getUTF8String(2);
      },
    });
    let active = true;
    const cleanup = () => {
      if (active) {
        active = false;
        destinationDB.removeListener(observer);
        try {
          connection.executeSimpleSQL(
            "DROP VIEW IF EXISTS temp.message_properties"
          );
        } finally {
          connection.removeFunction("local_initialization_fault");
        }
      }
    };
    registerCleanupFunction(cleanup);
    destinationDB.addListener(observer);
    const listener = new PromiseTestUtils.PromiseCopyListener({
      onProgress(current, total) {
        progress.push([current, total]);
      },
      onStopCopy(status) {
        statuses.push(status);
        atStop = {
          sourceKeys: sourceDB.listAllKeys(),
          destinationIds: Array.from(
            destination.messages,
            header => header.messageId
          ),
          sourceBodies: messages.map(header =>
            readPublicationBytes(source.getMsgInputStream(header))
          ),
        };
      },
    });
    const stopped = listener.promise.then(
      () => true,
      () => false
    );
    const scan = new PromiseTestUtils.PromiseStoreScanListener();
    let succeeded;
    try {
      MailServices.copy.copyMessages(
        source,
        messages,
        destination,
        isMove,
        listener,
        null,
        false
      );
      succeeded = await stopped;
      destination.msgStore.asyncScan(destination, scan);
      await scan.promise;
    } finally {
      cleanup();
    }
    Assert.equal(succeeded, false);
    Assert.deepEqual(
      faults,
      ["value-1"],
      "The second header initialization failed once"
    );
    Assert.deepEqual(
      statuses,
      [Cr.NS_ERROR_FAILURE],
      "One terminal reports the initialization error"
    );
    Assert.deepEqual(
      progress,
      [[1, 3]],
      "The continuing caller never starts a failed or later member"
    );
    Assert.deepEqual(additions, [[name + "-0@invalid", raws[0], keys]]);
    Assert.deepEqual(atStop, {
      sourceKeys: keys,
      destinationIds: [name + "-0@invalid"],
      sourceBodies: raws,
    });
    Assert.deepEqual(
      scan.messages,
      [raws[0]],
      "Only the finished prefix has destination storage"
    );
    Assert.deepEqual(sourceDB.listAllKeys(), keys);
    Assert.deepEqual(
      messages.map(header => header.storeToken),
      tokens
    );
    Assert.deepEqual(
      messages.map(header => header.flags),
      flags
    );
    Assert.deepEqual(
      messages.map(header => header.getStringProperty("initializationValue")),
      ["value-0", "value-1", "value-2"]
    );
    for (const [index, file] of sourcePaths.entries()) {
      Assert.deepEqual(
        await IOUtils.read(file),
        before[index],
        "Failure preserves source storage exactly"
      );
    }
    Assert.deepEqual(
      messages.map(header =>
        readPublicationBytes(source.getMsgInputStream(header))
      ),
      raws
    );
    assertPublicationFolder(source, storeType);
    assertPublicationFolder(destination, storeType);
    Assert.equal(destinationDB.listAllKeys().length, 1);
    if (storeType == "maildir") {
      Assert.deepEqual(
        await IOUtils.getChildren(
          PathUtils.join(destination.filePath.path, "tmp")
        ),
        []
      );
      Assert.equal(
        (
          await IOUtils.getChildren(
            PathUtils.join(destination.filePath.path, "cur")
          )
        ).length,
        1
      );
    }
  });
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_initializationFailureCopyMbox() {
    await checkDeferredInitializationFailure("mbox", false);
  });
  add_task(async function test_initializationFailureCopyMaildir() {
    await checkDeferredInitializationFailure("maildir", false);
  });
  add_task(async function test_initializationFailureMoveMbox() {
    await checkDeferredInitializationFailure("mbox", true);
  });
  add_task(async function test_initializationFailureMoveMaildir() {
    await checkDeferredInitializationFailure("maildir", true);
  });
}

/**
 * Exercises the native local transaction with real provider bodies and keys.
 *
 * @param {string} storeType - The mbox or maildir provider.
 * @param {boolean} move - Move the original messages instead of copying.
 * @param {string} [fault=""] - Inject a delete, restore SQL, or maildir Finish fault.
 */
async function checkNativeLocalUndo(storeType, move, fault = "") {
  await withPublicationStore(
    storeType,
    async ({ rootFolder, database, order }) => {
      const source = rootFolder.createLocalSubfolder("undo-source");
      const destination = rootFolder.createLocalSubfolder("undo-destination");
      const sourceDB = assertPublicationFolder(source, storeType);
      const destinationDB = assertPublicationFolder(destination, storeType);
      const manager = MailServices.txns.transactionManager;
      manager.clear();
      const count = fault ? 1 : 3;
      const originals = [];
      const headers = [];
      for (let i = 0; i < count; i++) {
        const raw =
          "From: undo@example.invalid\r\n" +
          "To: recipient@example.invalid\r\n" +
          `Subject: Local undo ${i}\r\n` +
          (i ? "Message-ID: <duplicate-undo@example.invalid>\r\n" : "") +
          "References: <first@invalid> <second@invalid> <first@invalid>\r\n" +
          "\r\n" +
          `Exact recovery body ${i}.\r\n\r\n`;
        const header = source
          .QueryInterface(Ci.nsIMsgLocalMailFolder)
          .addMessage(raw);
        header.setStringProperty("undoOrdinal", String(i));
        header.setStringProperty("undoEmpty", "");
        header.setStringProperty("undoUnicode", "\u2603\u00e9");
        source.markMessagesRead([header], true);
        source.markMessagesFlagged([header], true);
        headers.push(header);
        originals.push({
          key: header.messageKey,
          token: header.storeToken,
          id: header.messageId,
          flags: header.flags,
          references: Array.from({ length: header.numReferences }, (_, index) =>
            header.getStringReference(index)
          ),
          raw: readPublicationBytes(source.getMsgInputStream(header)),
        });
      }
      const window = Cc["@mozilla.org/messenger/msgwindow;1"].createInstance(
        Ci.nsIMsgWindow
      );
      const listener = new PromiseTestUtils.PromiseCopyListener();
      MailServices.copy.copyMessages(
        source,
        headers.toReversed(),
        destination,
        move,
        listener,
        window,
        true
      );
      await listener.promise;
      Assert.equal(manager.numberOfUndoItems, 1);
      const transaction = manager.peekUndoStack();
      const firstDestination = Array.from(destination.messages, header => ({
        key: header.messageKey,
        token: header.storeToken,
        raw: readPublicationBytes(destination.getMsgInputStream(header)),
      }));
      Assert.equal(firstDestination.length, count);
      Assert.equal(sourceDB.listAllKeys().length, move ? 0 : count);
      const additions = [];
      const observers = [];
      let reentrant = 0;
      let faultActive = false;
      let faultCalls = 0;
      const connection = database.connectionForTests;
      const dropFault = () => {
        if (faultActive) {
          connection.executeSimpleSQL(
            "DROP TRIGGER IF EXISTS temp.local_undo_fault"
          );
          faultActive = false;
        }
      };
      const observe = folder => {
        const db = folder.msgDatabase;
        const observer = {
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
            const ordinal = Number(header.getStringProperty("undoOrdinal"));
            const original = originals[ordinal];
            const raw = readPublicationBytes(folder.getMsgInputStream(header));
            additions.push({
              folder: folder.URI,
              key: header.messageKey,
              token: header.storeToken,
              raw,
              ordinal,
            });
            Assert.ok(db.containsKey(header.messageKey));
            Assert.equal(header.messageId, original.id);
            Assert.equal(header.flags, original.flags);
            Assert.equal(header.messageSize, raw.length);
            Assert.equal(header.offlineMessageSize, 0);
            Assert.equal(raw, original.raw);
            Assert.ok(header.properties.includes("undoEmpty"));
            Assert.equal(header.getStringProperty("undoEmpty"), "");
            Assert.ok(!header.properties.includes("undoAbsent"));
            Assert.equal(
              header.getStringProperty("undoUnicode"),
              "\u2603\u00e9"
            );
            Assert.deepEqual(
              Array.from({ length: header.numReferences }, (_, index) =>
                header.getStringReference(index)
              ),
              original.references
            );
            const finishes = order.events.filter(
              event => event.type == "finish"
            );
            Assert.ok(finishes.some(event => event.token == header.storeToken));
            for (const method of ["undoTransaction", "redoTransaction"]) {
              Assert.throws(
                () => transaction[method](),
                error => error.result == Cr.NS_ERROR_IN_PROGRESS
              );
              reentrant++;
            }
          },
        };
        db.addListener(observer);
        observers.push([db, observer]);
      };
      const failSql = phase => {
        connection.createFunction("local_undo_fault", 0, {
          onFunctionCall() {
            faultCalls++;
            return 0;
          },
        });
        connection.executeSimpleSQL(
          "CREATE TEMP TRIGGER local_undo_fault BEFORE " +
            phase +
            " ON main.messages BEGIN SELECT local_undo_fault(); " +
            "SELECT RAISE(ABORT, 'Local undo failure'); END"
        );
        faultActive = true;
      };
      let heldCur;
      const normalRecord = order.record;
      try {
        if (fault == "delete") {
          failSql("DELETE");
          Assert.throws(
            () => manager.undoTransaction(),
            error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
          );
          Assert.equal(faultCalls, 1);
          Assert.equal(manager.peekUndoStack(), transaction);
          Assert.equal(manager.numberOfUndoItems, 1);
          Assert.equal(manager.numberOfRedoItems, 0);
          Assert.deepEqual(
            destinationDB.listAllKeys(),
            firstDestination.map(row => row.key)
          );
          Assert.equal(
            readPublicationBytes(
              destination.getMsgInputStream(
                destinationDB.getMsgHdrForKey(firstDestination[0].key)
              )
            ),
            firstDestination[0].raw
          );
          dropFault();
        }
        observe(source);
        observe(destination);
        order.destinationURI = source.URI;
        manager.undoTransaction();
        Assert.equal(manager.numberOfUndoItems, 0);
        Assert.equal(manager.numberOfRedoItems, 1);
        Assert.deepEqual(destinationDB.listAllKeys(), []);
        const restoredSource = Array.from(source.messages);
        Assert.equal(restoredSource.length, count);
        for (const header of restoredSource) {
          const original =
            originals[Number(header.getStringProperty("undoOrdinal"))];
          Assert.equal(
            readPublicationBytes(source.getMsgInputStream(header)),
            original.raw
          );
          if (move) {
            Assert.notEqual(header.messageKey, original.key);
            Assert.notEqual(header.storeToken, original.token);
            Assert.ok(!sourceDB.containsKey(original.key));
          } else {
            Assert.equal(header.messageKey, original.key);
            Assert.equal(header.storeToken, original.token);
          }
        }
        // Repeated direct calls settle the original operation once.
        transaction.undoTransaction();
        Assert.equal(sourceDB.listAllKeys().length, count);
        order.destinationURI = destination.URI;
        if (fault == "busy") {
          const before = sourceDB.listAllKeys();
          destination.acquireSemaphore(source, "test_nativeUndoBusy");
          try {
            Assert.throws(
              () => manager.redoTransaction(),
              error => error.result == Cr.NS_MSG_FOLDER_BUSY
            );
            Assert.equal(manager.peekRedoStack(), transaction);
            Assert.equal(manager.numberOfRedoItems, 1);
            Assert.deepEqual(destinationDB.listAllKeys(), []);
            Assert.deepEqual(sourceDB.listAllKeys(), before);
            Assert.equal(
              order.events.filter(event => event.type == "finish-entry").length,
              0
            );
          } finally {
            destination.releaseSemaphore(source, "test_nativeUndoBusy");
          }
        }
        if (fault == "restore") {
          failSql("INSERT");
        }
        if (fault == "finish") {
          order.record = function (type, details) {
            const event = normalRecord.call(this, type, details);
            if (type == "finish-entry" && !heldCur) {
              const cur = destination.filePath.clone();
              cur.append("cur");
              heldCur = destination.filePath.clone();
              heldCur.append("cur-before-undo-finish");
              Assert.ok(cur.isDirectory());
              Assert.ok(!heldCur.exists());
              cur.moveTo(heldCur.parent, heldCur.leafName);
              const block = destination.filePath.clone();
              block.append("cur");
              block.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
            }
            return event;
          };
        }
        if (fault == "restore" || fault == "finish") {
          const expected =
            fault == "restore"
              ? Cr.NS_ERROR_STORAGE_CONSTRAINT
              : Cr.NS_ERROR_FILE_DESTINATION_NOT_DIR;
          Assert.throws(
            () => manager.redoTransaction(),
            error => error.result == expected
          );
          Assert.equal(manager.peekRedoStack(), transaction);
          Assert.equal(manager.numberOfRedoItems, 1);
          Assert.deepEqual(destinationDB.listAllKeys(), []);
          Assert.equal(sourceDB.listAllKeys().length, count);
          const entries = order.events.filter(
            event => event.type == "finish-entry"
          ).length;
          Assert.equal(entries, 1);
          if (fault == "finish") {
            const cur = destination.filePath.clone();
            cur.append("cur");
            Assert.ok(cur.isFile());
            Assert.equal(cur.fileSize, 0);
            cur.remove(false);
            heldCur.moveTo(destination.filePath, "cur");
            heldCur = null;
            order.record = normalRecord;
            // An uncertain Finish cannot be retried or turned into success.
            for (let i = 0; i < 2; i++) {
              Assert.throws(
                () => transaction.redoTransaction(),
                error => error.result == expected
              );
              Assert.throws(
                () => transaction.undoTransaction(),
                error => error.result == expected
              );
            }
            Assert.equal(
              order.events.filter(event => event.type == "finish-entry").length,
              entries
            );
            Assert.equal(additions.length, 0);
            const pending = await IOUtils.getChildren(
              PathUtils.join(destination.filePath.path, "tmp")
            );
            Assert.equal(pending.length, 1);
            Assert.equal(await IOUtils.readUTF8(pending[0]), originals[0].raw);
            return;
          }
          Assert.equal(faultCalls, 1);
          dropFault();
          manager.redoTransaction();
          Assert.equal(
            order.events.filter(event => event.type == "finish-entry").length,
            entries
          );
        } else {
          manager.redoTransaction();
        }
        Assert.equal(manager.numberOfUndoItems, 1);
        Assert.equal(manager.numberOfRedoItems, 0);
        Assert.equal(manager.peekUndoStack(), transaction);
        const secondDestination = Array.from(destination.messages);
        Assert.equal(secondDestination.length, count);
        for (const header of secondDestination) {
          Assert.ok(
            !firstDestination.some(old => old.key == header.messageKey)
          );
          Assert.ok(
            !firstDestination.some(old => old.token == header.storeToken)
          );
          const original =
            originals[Number(header.getStringProperty("undoOrdinal"))];
          Assert.equal(
            readPublicationBytes(destination.getMsgInputStream(header)),
            original.raw
          );
        }
        transaction.redoTransaction();
        Assert.equal(destinationDB.listAllKeys().length, count);
        Assert.equal(sourceDB.listAllKeys().length, move ? 0 : count);
        const added = additions.length;
        order.destinationURI = source.URI;
        manager.undoTransaction();
        Assert.equal(additions.length, added + (move ? count : 0));
        Assert.equal(reentrant, additions.length * 2);
        Assert.deepEqual(destinationDB.listAllKeys(), []);
        Assert.equal(sourceDB.listAllKeys().length, count);
        Assert.equal(manager.numberOfUndoItems, 0);
        Assert.equal(manager.numberOfRedoItems, 1);
      } finally {
        order.record = normalRecord;
        if (heldCur?.exists()) {
          const cur = destination.filePath.clone();
          cur.append("cur");
          Assert.ok(cur.isFile());
          Assert.equal(cur.fileSize, 0);
          cur.remove(false);
          heldCur.moveTo(destination.filePath, "cur");
        }
        for (const [db, observer] of observers) {
          db.removeListener(observer);
        }
        dropFault();
        if (fault == "delete" || fault == "restore") {
          connection.removeFunction("local_undo_fault");
        }
        manager.clear();
      }
    },
    { observeOrder: true }
  );
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_localCopyUndoMbox() {
    await checkNativeLocalUndo("mbox", false);
  });
  add_task(async function test_localCopyUndoMaildir() {
    await checkNativeLocalUndo("maildir", false);
  });
  add_task(async function test_localMoveUndoMbox() {
    await checkNativeLocalUndo("mbox", true);
  });
  add_task(async function test_localMoveUndoMaildir() {
    await checkNativeLocalUndo("maildir", true);
  });
  add_task(async function test_localUndoDeleteRetryMbox() {
    await checkNativeLocalUndo("mbox", false, "delete");
  });
  add_task(async function test_localUndoDeleteRetryMaildir() {
    await checkNativeLocalUndo("maildir", false, "delete");
  });
  add_task(async function test_localUndoRestoreRetryMbox() {
    await checkNativeLocalUndo("mbox", false, "restore");
  });
  add_task(async function test_localUndoRestoreRetryMaildir() {
    await checkNativeLocalUndo("maildir", false, "restore");
  });
  add_task(async function test_localUndoFinishFailureMaildir() {
    await checkNativeLocalUndo("maildir", false, "finish");
  });
  add_task(async function test_localUndoBusyRetryMbox() {
    await checkNativeLocalUndo("mbox", false, "busy");
  });
  add_task(async function test_localUndoBusyRetryMaildir() {
    await checkNativeLocalUndo("maildir", false, "busy");
  });
}

/**
 * Inserts raw MIME messages and reads their flags and bodies from a native DB.
 *
 * @param {string} storeType - The mbox or maildir provider.
 * @returns {Promise<void>} Resolves after insertion checks and account cleanup.
 */
async function checkRawMimeAttachmentNative(storeType) {
  await withPublicationStore(storeType, async ({ rootFolder }) => {
    const folder = rootFolder
      .createLocalSubfolder("raw-mime-attachment")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const database = assertPublicationFolder(folder, storeType);
    const { Attachment, HasRe, Read, Replied, Marked, New } =
      Ci.nsMsgMessageFlags;
    const cases = [
      {
        contentType: "multipart/mixed; boundary=parts",
        status: "",
        subject: "MIME attachment",
        // Native publication adds the existing facade New state for unread mail.
        flags: Attachment | New,
      },
      {
        contentType: "multipart/mixed; boundary=parts",
        status: "X-Mozilla-Status: 00a7\r\n",
        subject: "Re: MIME attachment",
        flags: Attachment | HasRe | Read | Replied | Marked,
      },
      {
        contentType: "multipart/mixed; boundary=parts",
        status: "X-Mozilla-Status: 0015\r\n",
        subject: "MIME attachment",
        flags: Attachment | Read | Marked,
      },
      {
        contentType: "text/plain; charset=UTF-8",
        status: "X-Mozilla-Status: 0005\r\n",
        subject: "MIME attachment",
        flags: Read | Marked,
      },
    ];
    const rawMessages = cases.map((test, index) => {
      const headers =
        "From: Sender <sender@example.invalid>\r\n" +
        "To: recipient@example.invalid\r\n" +
        "Date: Tue, 01 Jan 2019 00:00:00 +0000\r\n" +
        `Message-ID: <raw-mime-${index}@example.invalid>\r\n` +
        `Subject: ${test.subject}\r\n` +
        `Content-Type: ${test.contentType}\r\n` +
        test.status +
        "\r\n";
      const body = test.contentType.startsWith("multipart/")
        ? "--parts\r\nContent-Type: text/plain\r\n\r\nVisible body.\r\n" +
          "--parts\r\nContent-Type: application/octet-stream\r\n" +
          'Content-Disposition: attachment; filename="example.txt"\r\n' +
          "\r\nExact attached bytes.\r\n--parts--\r\n"
        : "Exact plain bytes.\r\n";
      return headers + body;
    });
    const inserted = folder.addMessageBatch(rawMessages);
    Assert.equal(inserted.length, cases.length);
    Assert.equal(folder.getTotalMessages(false), cases.length);
    Assert.equal(
      new Set(inserted.map(header => header.messageKey)).size,
      cases.length
    );
    for (const [index, test] of cases.entries()) {
      const original = inserted[index];
      Assert.notEqual(original.messageKey, 0xffffffff);
      Assert.equal(original.folder.URI, folder.URI);
      Assert.greater(original.storeToken.length, 0);
      Assert.equal(original.flags, test.flags);
      const fresh = database.getMsgHdrForKey(original.messageKey);
      Assert.equal(fresh.messageKey, original.messageKey);
      Assert.equal(fresh.folder.URI, folder.URI);
      Assert.equal(fresh.messageId, `raw-mime-${index}@example.invalid`);
      Assert.equal(fresh.flags, test.flags);
      Assert.equal(fresh.subject, "MIME attachment");
      Assert.equal(fresh.author, "Sender <sender@example.invalid>");
      Assert.equal(fresh.recipients, "recipient@example.invalid");
      Assert.equal(fresh.storeToken, original.storeToken);
      Assert.equal(fresh.messageSize, rawMessages[index].length);
      Assert.equal(
        readPublicationBytes(folder.getMsgInputStream(fresh)),
        rawMessages[index]
      );
    }
  });
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_rawMimeAttachmentNativeMbox() {
    await checkRawMimeAttachmentNative("mbox");
  });
  add_task(async function test_rawMimeAttachmentNativeMaildir() {
    await checkRawMimeAttachmentNative("maildir");
  });
}
