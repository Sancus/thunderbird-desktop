/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

const STORE_PREFS = [
  "mail.serverDefaultStoreContractID",
  "mail.server.default.storeContractID",
];

add_setup(function setupStoreReads() {
  const prefs = STORE_PREFS.map(name => ({
    name,
    hadValue: Services.prefs.prefHasUserValue(name),
    value: Services.prefs.getCharPref(name, ""),
  }));
  registerCleanupFunction(() => {
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
  });
  localAccountUtils.clearAll();
});

/**
 * Create a local account before checking the selected database and store.
 *
 * @param {string} contract - Store contract.
 * @param {string} storeType - Expected store type.
 * @returns {nsIMsgLocalMailFolder} The local inbox.
 */
function loadStore(contract, storeType) {
  // Panorama root discovery can cache the provider before server creation ends.
  for (const name of STORE_PREFS) {
    Services.prefs.setCharPref(name, contract);
  }
  // Both defaults are already set. Avoid the helper's stale explicit-store
  // shortcut after clearAll() when two consecutive tasks use the same store.
  localAccountUtils.loadLocalMailAccount();
  const folder = localAccountUtils.inboxFolder;
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.equal(
    "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
    Services.prefs.getBoolPref("mail.panorama.enabled", false),
    "The active database service matches the selected backend"
  );
  Assert.equal(folder.msgStore.storeType, storeType);
  Assert.equal(folder.server.msgStore.storeType, storeType);
  return folder;
}

/**
 * Read a provider stream, including closing it on a read error.
 *
 * @param {nsIInputStream} stream - Message input.
 * @returns {string} Exact stored message bytes.
 */
function readAll(stream) {
  const input = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
    Ci.nsIScriptableInputStream
  );
  input.init(stream);
  try {
    let raw = "";
    let chunk;
    while ((chunk = input.read(4096))) {
      raw += chunk;
    }
    return raw;
  } finally {
    input.close();
  }
}

/**
 * Corrupt mbox tokens must fail instead of selecting a different body.
 */
add_task(async function test_mboxReadTokenValidation() {
  try {
    const folder = loadStore("@mozilla.org/msgstore/berkeleystore;1", "mbox");
    const store = folder.msgStore;
    const messages = [
      "From: first@example.invalid\r\nSubject: First offset\r\n\r\nFirst exact body.\r\n",
      "From: later@example.invalid\r\nSubject: Later offset\r\n\r\nLater exact body.\r\n",
    ];
    const tokens = [];
    for (const message of messages) {
      const stream = store.getNewMsgOutputStream(folder);
      stream.write(message, message.length);
      tokens.push(store.finishNewMessage(folder, stream));
    }
    Assert.equal(tokens[0], "0", "The first message starts at offset zero");
    Assert.notEqual(tokens[1], "0", "The later message has its own location");
    const bytes = await IOUtils.read(folder.filePath.path);
    for (const token of [
      "",
      "not-an-offset",
      "0tail",
      "0x0",
      "+0",
      "-0",
      " 0",
      "0 ",
      "0\n",
      "0\0tail",
      "9223372036854775808",
      "18446744073709551616",
    ]) {
      Assert.throws(
        () => readAll(store.getMsgInputStream(folder, token, 0)),
        error => error.result === Cr.NS_ERROR_ILLEGAL_VALUE,
        `Reject the complete invalid token ${JSON.stringify(token)}`
      );
    }
    Assert.equal(
      readAll(store.getMsgInputStream(folder, "0", 0)),
      messages[0],
      "Offset zero remains a valid body location"
    );
    Assert.equal(
      readAll(store.getMsgInputStream(folder, tokens[1], 0)),
      messages[1]
    );
    Assert.deepEqual(await IOUtils.read(folder.filePath.path), bytes);
    const scan = new PromiseTestUtils.PromiseStoreScanListener();
    store.asyncScan(folder, scan);
    await scan.promise;
    Assert.deepEqual(scan.messages, messages);
    Assert.deepEqual(scan.tokens, tokens);
  } finally {
    localAccountUtils.clearAll();
  }
});

/**
 * A failed read must leave a missing maildir directory missing.
 */
add_task(async function test_maildirReadMissingDirectory() {
  try {
    const folder = loadStore("@mozilla.org/msgstore/maildirstore;1", "maildir");
    const cur = PathUtils.join(folder.filePath.path, "cur");
    const saved = PathUtils.join(folder.filePath.path, "cur-for-read");
    const store = folder.msgStore;
    const message = "Subject: Retained maildir body\r\n\r\nExact body.\r\n";
    const stream = store.getNewMsgOutputStream(folder);
    stream.write(message, message.length);
    const token = store.finishNewMessage(folder, stream);
    await IOUtils.move(cur, saved, { noOverwrite: true });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        Assert.throws(
          () => readAll(store.getMsgInputStream(folder, token, 0)),
          error => error.result === Cr.NS_ERROR_FILE_NOT_FOUND
        );
        Assert.ok(!(await IOUtils.exists(cur)), "Read creates no directory");
        Assert.equal(
          await IOUtils.readUTF8(PathUtils.join(saved, token)),
          message,
          "The missing-store error leaves the original body intact"
        );
      }
    } finally {
      // Remove only an empty directory created by a regressed read path.
      await IOUtils.remove(cur, { ignoreAbsent: true });
      await IOUtils.move(saved, cur, { noOverwrite: true });
    }
    Assert.equal(readAll(store.getMsgInputStream(folder, token, 0)), message);
    const scan = new PromiseTestUtils.PromiseStoreScanListener();
    store.asyncScan(folder, scan);
    await scan.promise;
    Assert.deepEqual(scan.messages, [message]);
    Assert.deepEqual(scan.tokens, [token]);
  } finally {
    localAccountUtils.clearAll();
  }
});

/**
 * Run availability checks with the registered reader's real account fixture.
 *
 * @param {string} storeType - Expected provider type.
 * @param {function(nsIMsgLocalMailFolder, nsIMsgFolder): Promise<void>} check -
 *   Receives the local inbox and account root.
 * @returns {Promise<void>} Completes the checks and removes the owned account.
 */
async function withAvailabilityStore(storeType, check) {
  localAccountUtils.clearAll();
  try {
    const contract =
      storeType == "mbox"
        ? "@mozilla.org/msgstore/berkeleystore;1"
        : "@mozilla.org/msgstore/maildirstore;1";
    const folder = loadStore(contract, storeType);
    await check(folder, localAccountUtils.rootFolder);
  } finally {
    localAccountUtils.clearAll();
  }
}

/**
 * Local availability depends on Partial, independently of the Offline flag.
 *
 * @param {string} storeType - Expected provider type.
 */
async function checkLocalAvailability(storeType) {
  await withAvailabilityStore(storeType, async folder => {
    const raw = "Subject: Local availability\r\n\r\nExact local body.\r\n";
    const header = folder.addMessage(raw);
    const key = header.messageKey;
    const token = header.storeToken;
    const size = header.messageSize;
    const base =
      (header.flags |
        Ci.nsMsgMessageFlags.Read |
        Ci.nsMsgMessageFlags.Marked |
        Ci.nsMsgMessageFlags.Replied) &
      ~(Ci.nsMsgMessageFlags.Offline | Ci.nsMsgMessageFlags.Partial);
    for (const [flags, expected] of [
      [base, true],
      [base | Ci.nsMsgMessageFlags.Partial, false],
      [
        base | Ci.nsMsgMessageFlags.Partial | Ci.nsMsgMessageFlags.Offline,
        false,
      ],
      [base | Ci.nsMsgMessageFlags.Offline, true],
    ]) {
      header.flags = flags;
      Assert.equal(folder.hasMsgOffline(key), expected);
      Assert.equal(header.flags, flags);
      Assert.equal(header.storeToken, token);
      Assert.equal(header.messageSize, size);
      Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
      Assert.equal(mailTestUtils.loadMessageToString(folder, header), raw);
    }
  });
}

add_task(async function test_localAvailabilityMbox() {
  await checkLocalAvailability("mbox");
});

add_task(async function test_localAvailabilityMaildir() {
  await checkLocalAvailability("maildir");
});

/**
 * Preserve native admission errors and the existing message/body state.
 *
 * @param {string} storeType - Expected provider type.
 */
async function checkLocalAvailabilityAdmissionError(storeType) {
  await withAvailabilityStore(storeType, async folder => {
    const raw = "Subject: Availability error\r\n\r\nRetained exact body.\r\n";
    const header = folder.addMessage(raw);
    const key = header.messageKey;
    const token = header.storeToken;
    const size = header.messageSize;
    const flags = header.flags;
    Assert.ok(folder.hasMsgOffline(key));
    const bodyPath =
      storeType == "mbox"
        ? folder.filePath.path
        : PathUtils.join(folder.filePath.path, "cur", token);
    const bytes = await IOUtils.read(bodyPath);
    const connection = Cc["@mozilla.org/mailnews/database-core;1"].getService(
      Ci.nsIDatabaseCore
    ).connectionForTests;
    connection.executeSimpleSQL(
      "ALTER TABLE body_relocations RENAME TO hidden_local_body_relocations"
    );
    try {
      Assert.throws(
        () => folder.hasMsgOffline(key),
        error => error.result === Cr.NS_ERROR_FAILURE
      );
      Assert.equal(header.flags, flags);
      Assert.equal(header.subject, "Availability error");
      Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
    } finally {
      connection.executeSimpleSQL(
        "ALTER TABLE hidden_local_body_relocations RENAME TO body_relocations"
      );
    }
    Assert.ok(folder.hasMsgOffline(key));
    Assert.equal(header.storeToken, token);
    Assert.equal(header.messageSize, size);
    Assert.equal(header.flags, flags);
    Assert.equal(mailTestUtils.loadMessageToString(folder, header), raw);
    Assert.deepEqual(await IOUtils.read(bodyPath), bytes);
  });
}

/**
 * A global key in another folder must not become a local availability result.
 *
 * @param {string} storeType - Expected provider type.
 */
async function checkLocalAvailabilityForeignKey(storeType) {
  await withAvailabilityStore(storeType, async (folder, root) => {
    const other = root
      .createLocalSubfolder("other-body-owner")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    Assert.equal(other.msgStore.storeType, storeType);
    const raw = "Subject: Foreign body\r\n\r\nOther exact body.\r\n";
    const header = other.addMessage(raw);
    const key = header.messageKey;
    const token = header.storeToken;
    Assert.deepEqual(folder.msgDatabase.listAllKeys(), []);
    Assert.throws(
      () => folder.hasMsgOffline(key),
      error => error.result === Cr.NS_ERROR_ILLEGAL_VALUE
    );
    Assert.deepEqual(folder.msgDatabase.listAllKeys(), []);
    Assert.deepEqual(other.msgDatabase.listAllKeys(), [key]);
    Assert.equal(header.storeToken, token);
    Assert.ok(other.hasMsgOffline(key));
    Assert.equal(mailTestUtils.loadMessageToString(other, header), raw);
  });
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_localAvailabilityAdmissionErrorMbox() {
    await checkLocalAvailabilityAdmissionError("mbox");
  });

  add_task(async function test_localAvailabilityAdmissionErrorMaildir() {
    await checkLocalAvailabilityAdmissionError("maildir");
  });

  add_task(async function test_localAvailabilityForeignKeyMbox() {
    await checkLocalAvailabilityForeignKey("mbox");
  });

  add_task(async function test_localAvailabilityForeignKeyMaildir() {
    await checkLocalAvailabilityForeignKey("maildir");
  });
}

/**
 * A real source-admission error must settle copy/move without changing either
 * the physical source or the destination body storage.
 *
 * @param {string} storeType - Expected provider type.
 * @param {boolean} move - Move instead of copying.
 */
async function checkLocalCopyAdmissionError(storeType, move) {
  await withAvailabilityStore(storeType, async (folder, root) => {
    const raw =
      "Subject: Admission before transfer\r\nMessage-ID: <copy-admission@example.invalid>\r\n\r\nRetained source bytes.\r\n";
    const header = folder.addMessage(raw);
    const key = header.messageKey;
    const token = header.storeToken;
    const flags = header.flags;
    const size = header.messageSize;
    const sourcePath =
      storeType == "mbox"
        ? folder.filePath.path
        : PathUtils.join(folder.filePath.path, "cur", token);
    const sourceBytes = await IOUtils.read(sourcePath);
    const destination = root
      .createLocalSubfolder("failed-admission-destination")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    Assert.equal(destination.msgStore.storeType, storeType);
    const destinationPath =
      storeType == "mbox"
        ? destination.filePath.path
        : PathUtils.join(destination.filePath.path, "cur");
    const existed = await IOUtils.exists(destinationPath);
    let before = null;
    if (existed) {
      before =
        storeType == "mbox"
          ? await IOUtils.read(destinationPath)
          : await IOUtils.getChildren(destinationPath);
    }
    const statuses = [];
    const listener = new PromiseTestUtils.PromiseCopyListener({
      onStopCopy(status) {
        statuses.push(status);
      },
    });
    const connection = Cc["@mozilla.org/mailnews/database-core;1"].getService(
      Ci.nsIDatabaseCore
    ).connectionForTests;
    connection.executeSimpleSQL(
      "ALTER TABLE body_relocations RENAME TO hidden_local_copy_relocations"
    );
    try {
      MailServices.copy.copyMessages(
        folder,
        [header],
        destination,
        move,
        listener,
        null,
        false
      );
      await Assert.rejects(
        listener.promise,
        error => Number(error.message) === Cr.NS_ERROR_FAILURE
      );
      Assert.deepEqual(statuses, [Cr.NS_ERROR_FAILURE]);
      Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
      Assert.deepEqual(destination.msgDatabase.listAllKeys(), []);
      Assert.ok(!folder.locked);
      Assert.ok(!destination.locked);
    } finally {
      connection.executeSimpleSQL(
        "ALTER TABLE hidden_local_copy_relocations RENAME TO body_relocations"
      );
    }
    const retained = folder.msgDatabase.getMsgHdrForKey(key);
    Assert.equal(retained.storeToken, token);
    Assert.equal(retained.messageSize, size);
    Assert.equal(retained.flags, flags);
    Assert.equal(mailTestUtils.loadMessageToString(folder, retained), raw);
    Assert.deepEqual(await IOUtils.read(sourcePath), sourceBytes);
    Assert.equal(await IOUtils.exists(destinationPath), existed);
    if (existed) {
      Assert.deepEqual(
        storeType == "mbox"
          ? await IOUtils.read(destinationPath)
          : await IOUtils.getChildren(destinationPath),
        before
      );
    }
  });
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_localCopyAdmissionErrorMbox() {
    await checkLocalCopyAdmissionError("mbox", false);
  });
  add_task(async function test_localCopyAdmissionErrorMaildir() {
    await checkLocalCopyAdmissionError("maildir", false);
  });
  add_task(async function test_localMoveAdmissionErrorMbox() {
    await checkLocalCopyAdmissionError("mbox", true);
  });
  add_task(async function test_localMoveAdmissionErrorMaildir() {
    await checkLocalCopyAdmissionError("maildir", true);
  });
}
