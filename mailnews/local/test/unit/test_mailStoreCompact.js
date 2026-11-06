/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for nsIMsgPluggableStore compaction support.
 * Tests _only_ the mailstore side - no folder/db involvement!
 */

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);

const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

/**
 * Helper to calculate a checksum for a file.
 *
 * @param {string} fileName - Full path to file.
 * @returns {string} checksum of the file contents.
 */
async function fileChecksum(fileName) {
  const md5 = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  md5.init(Ci.nsICryptoHash.MD5);
  const raw = await IOUtils.read(fileName);
  md5.update(raw, raw.byteLength);
  return md5.finish(true);
}

/**
 * Helper class to provide async listener for store compaction.
 */
class PromiseStoreCompactListener {
  QueryInterface = ChromeUtils.generateQI(["nsIStoreCompactListener"]);
  #promise = Promise.withResolvers();

  onCompactionBegin() {}
  onRetentionQuery(_storeToken) {
    // By default, keep all messages.
    return true;
  }
  onMessageRetained(_oldToken, _newToken, _newSize) {}
  onCompactionComplete(_status) {}
  onFinalSummary(status, _oldSize, _newSize) {
    if (status == Cr.NS_OK) {
      this.#promise.resolve();
    } else {
      this.#promise.reject(status);
    }
  }
  get promise() {
    return this.#promise.promise;
  }
}

/**
 * Test that discarding all messages yields an empty store.
 */
async function test_discardAll() {
  // NOTE: we should be able to create stand-alone msgStore to run tests on,
  // but currently they are tightly coupled with folders, msgDB et al...
  // Bug 1714472 should sort that out and strip away some of this cruft.
  localAccountUtils.loadLocalMailAccount();
  const inbox = localAccountUtils.inboxFolder;

  Assert.ok(inbox.msgStore.supportsCompaction);

  const generator = new MessageGenerator();
  inbox.addMessageBatch(
    generator
      .makeMessages({ count: 10 })
      .map(message => message.toMessageString())
  );

  const compactListener = new PromiseStoreCompactListener();
  // Monkey-patch to discard all messages.
  compactListener.onRetentionQuery = function (_storeToken) {
    return false;
  };

  inbox.msgStore.asyncCompact(inbox, compactListener, true);
  await compactListener.promise;

  Assert.equal(inbox.filePath.fileSize, 0, "should be left with an empty mbox");

  // Clear up so we can run again on different store type.
  localAccountUtils.clearAll();
}

/**
 * Test that throwing errors in listener callbacks leaves mbox untouched.
 */
async function test_listenerErrors() {
  localAccountUtils.loadLocalMailAccount();
  const inbox = localAccountUtils.inboxFolder;

  Assert.ok(inbox.msgStore.supportsCompaction);

  const generator = new MessageGenerator();
  inbox.addMessageBatch(
    generator
      .makeMessages({ count: 10 })
      .map(message => message.toMessageString())
  );

  // Checksum the mbox file before we do anything.
  const checksumBefore = await fileChecksum(inbox.filePath.path);

  // Run compaction, failing listener callback in turn.
  // We'll use an arbitrary but identifiable code: NS_ERROR_CRYPTOMINING_URI.
  {
    // Check that onCompactionBegin() can abort.
    const l = new PromiseStoreCompactListener();
    l.onCompactionBegin = function () {
      throw Components.Exception("", Cr.NS_ERROR_CRYPTOMINING_URI);
    };
    inbox.msgStore.asyncCompact(inbox, l, true);
    await Assert.rejects(l.promise, e => {
      return e === Cr.NS_ERROR_CRYPTOMINING_URI;
    });
    // Unchanged mbox file?
    const checksumAfter = await fileChecksum(inbox.filePath.path);
    Assert.equal(checksumBefore, checksumAfter);
  }

  {
    // Check that onRetentionQuery() can abort.
    const l = new PromiseStoreCompactListener();
    l.onRetentionQuery = function (_storeToken) {
      throw Components.Exception("", Cr.NS_ERROR_CRYPTOMINING_URI);
    };
    inbox.msgStore.asyncCompact(inbox, l, true);
    await Assert.rejects(l.promise, e => {
      return e === Cr.NS_ERROR_CRYPTOMINING_URI;
    });
    // Unchanged mbox file?
    const checksumAfter = await fileChecksum(inbox.filePath.path);
    Assert.equal(checksumBefore, checksumAfter);
  }

  {
    // Check that onMessageRetained() can abort.
    const l = new PromiseStoreCompactListener();
    l.onMessageRetained = function (_oldToken, _newToken, _newSize) {
      throw Components.Exception("", Cr.NS_ERROR_CRYPTOMINING_URI);
    };
    inbox.msgStore.asyncCompact(inbox, l, true);
    await Assert.rejects(l.promise, e => {
      return e === Cr.NS_ERROR_CRYPTOMINING_URI;
    });
    // Unchanged mbox file?
    const checksumAfter = await fileChecksum(inbox.filePath.path);
    Assert.equal(checksumBefore, checksumAfter);
  }

  {
    // Check that onCompactionComplete() can abort.
    const l = new PromiseStoreCompactListener();
    l.onCompactionComplete = function (_status) {
      throw Components.Exception("", Cr.NS_ERROR_CRYPTOMINING_URI);
    };
    inbox.msgStore.asyncCompact(inbox, l, true);
    await Assert.rejects(l.promise, e => {
      return e === Cr.NS_ERROR_CRYPTOMINING_URI;
    });
    // Unchanged mbox file?
    const checksumAfter = await fileChecksum(inbox.filePath.path);
    Assert.equal(checksumBefore, checksumAfter);
  }

  // Clear up so we can run again on different store type.
  localAccountUtils.clearAll();
}

/**
 * Test that mbox is left untouched if we fail after retaining some messages.
 */
async function test_midwayFail() {
  localAccountUtils.loadLocalMailAccount();
  const inbox = localAccountUtils.inboxFolder;

  Assert.ok(inbox.msgStore.supportsCompaction);

  // Some test messages.
  const numMessages = 50;
  const generator = new MessageGenerator();
  inbox.addMessageBatch(
    generator
      .makeMessages({ count: numMessages })
      .map(message => message.toMessageString())
  );

  // Checksum the mbox file before we do anything.
  const checksumBefore = await fileChecksum(inbox.filePath.path);

  // Monkey-patch a listener to keep every other message then fail
  // half way through.
  const l = new PromiseStoreCompactListener();
  l.queriedCount = 0;
  l.onRetentionQuery = function (_storeToken) {
    ++this.queriedCount;
    return (this.queriedCount & 1) == 0;
  };
  l.onMessageRetained = function (_oldToken, _newToken, _newSize) {
    // Abort halfway through.
    if (this.queriedCount >= numMessages / 2) {
      throw Components.Exception("", Cr.NS_ERROR_CRYPTOMINING_URI);
    }
  };

  // Go!
  inbox.msgStore.asyncCompact(inbox, l, true);
  await Assert.rejects(l.promise, e => {
    return e === Cr.NS_ERROR_CRYPTOMINING_URI;
  });

  // Unchanged mbox file?
  const checksumAfter = await fileChecksum(inbox.filePath.path);
  Assert.equal(checksumBefore, checksumAfter);

  localAccountUtils.clearAll();
}

/**
 * Test that onFinalSummary returns sensible before and after sizes.
 * See Bug 1900172.
 */
async function test_sizesAtCompletion() {
  localAccountUtils.loadLocalMailAccount();
  const inbox = localAccountUtils.inboxFolder;

  Assert.ok(inbox.msgStore.supportsCompaction);

  const generator = new MessageGenerator();
  inbox.addMessageBatch(
    generator
      .makeMessages({ count: 50 })
      .map(message => message.toMessageString())
  );

  let info = await IOUtils.stat(inbox.filePath.path);
  const oldFileSize = info.size;

  // Monkey-patch listener to discard every second message and to note
  // sizes upon completion.
  const l = new PromiseStoreCompactListener();
  l.msgCount = 0;
  l.onRetentionQuery = function (_storeToken) {
    ++this.msgCount;
    return this.msgCount % 2 == 0;
  };
  l._onFinalSummary = l.onFinalSummary;
  l.onFinalSummary = function (status, oldSize, newSize) {
    this.newSize = newSize;
    this.oldSize = oldSize;
    this._onFinalSummary(status, oldSize, newSize);
  };

  inbox.msgStore.asyncCompact(inbox, l, true);
  await l.promise;

  // NOTE: We avoid the use of inbox.filePath.fileSize because of
  // nsIfile stat caching under windows (Bug 456603).
  info = await IOUtils.stat(inbox.filePath.path);
  const newFileSize = info.size;

  Assert.equal(oldFileSize, l.oldSize, "reported oldSize matches filesize");
  Assert.equal(newFileSize, l.newSize, "reported newSize matches filesize");

  localAccountUtils.clearAll();
}

/**
 * Make sure asyncCompact() fails with NS_MSG_ERROR_MBOX_MALFORMED for
 * malformed mbox files we can't sensibly parse.
 */
async function test_malformedMboxes() {
  localAccountUtils.loadLocalMailAccount();
  const inbox = localAccountUtils.inboxFolder;

  const badMboxes = [
    // An mbox which has two messages but no "From " separators (see Bug 1935331):
    "Message-Id: one\r\n" +
      "From: alice@invalid.com\r\n" +
      "To: bob@invalid.com\r\n" +
      "Subject: hello\r\n" +
      "\r\n" +
      "Hi there bob!\r\n" +
      "\r\n" +
      "Message-Id: two\r\n" +
      "From: bob@invalid.com\r\n" +
      "To: alice@invalid.com\r\n" +
      "Subject: re: hello\r\n" +
      "\r\n" +
      "Hi Alice!\r\n" +
      "\r\n",

    // An mbox file with some random rubbish:
    "foo\r\nbar\r\nwibble\r\n",
  ];

  for (const mbox of badMboxes) {
    await IOUtils.writeUTF8(inbox.filePath.path, mbox);
    // Note: we're writing an mbox file to the folder, but there are no
    // corresponding message entries in the database.
    // But that's OK - asyncCompact doesn't use the DB at all.
    const l = new PromiseStoreCompactListener();
    await Assert.rejects(
      (async function () {
        inbox.msgStore.asyncCompact(inbox, l, true);
        await l.promise;
      })(),
      /2153054244/,
      "Bad mbox should cause msgStore.asyncCompact() to fail with NS_MSG_ERROR_MBOX_MALFORMED"
    );
  }

  localAccountUtils.clearAll();
}

/**
 * Check that an interrupted compaction's files are left for recovery.
 *
 * @param {string} suffix - Recovery file suffix.
 * @param {boolean} [moveSource=false] - Move the original mbox to the backup.
 */
async function checkRecoveryFile(suffix, moveSource = false) {
  localAccountUtils.loadLocalMailAccount();
  let recoveryPath;
  try {
    const inbox = localAccountUtils.inboxFolder;
    const store = inbox.msgStore;
    Assert.equal(store.storeType, "mbox");
    Assert.ok(store.supportsCompaction);
    const body = "Subject: preserve recovery\r\n\r\nOriginal body.\r\n";
    const output = store.getNewMsgOutputStream(inbox);
    output.write(body, body.length);
    store.finishNewMessage(inbox, output);
    const sourcePath = inbox.filePath.path;
    const checksum = await fileChecksum(sourcePath);
    const tempDir = PathUtils.join(
      PathUtils.parent(sourcePath),
      ".compact-temp"
    );
    await IOUtils.makeDirectory(tempDir, { ignoreExisting: true });
    recoveryPath = PathUtils.join(
      tempDir,
      PathUtils.filename(sourcePath) + suffix
    );
    const recoveryBody = "Existing recovery bytes.\r\n";
    if (moveSource) {
      await IOUtils.move(sourcePath, recoveryPath, { noOverwrite: true });
    } else {
      await IOUtils.writeUTF8(recoveryPath, recoveryBody);
    }

    let began = false;
    const listener = new PromiseStoreCompactListener();
    listener.onCompactionBegin = function () {
      began = true;
    };
    await Assert.rejects(
      (async () => {
        store.asyncCompact(inbox, listener, false);
        await listener.promise;
      })(),
      error => (error.result ?? error) === Cr.NS_ERROR_FILE_ALREADY_EXISTS
    );
    Assert.ok(!began, "Recovery files prevent compaction from starting");
    if (moveSource) {
      Assert.ok(
        !(await IOUtils.exists(sourcePath)),
        "No empty replacement mbox"
      );
      Assert.equal(await fileChecksum(recoveryPath), checksum);
    } else {
      Assert.equal(await fileChecksum(sourcePath), checksum);
      Assert.equal(await IOUtils.readUTF8(recoveryPath), recoveryBody);
    }
  } finally {
    if (recoveryPath) {
      await IOUtils.remove(recoveryPath, { ignoreAbsent: true });
    }
    localAccountUtils.clearAll();
  }
}

async function test_existingCompactingFile() {
  await checkRecoveryFile(".compacting");
}

async function test_existingCompactedFile() {
  await checkRecoveryFile(".compacted");
}

async function test_existingOriginalFile() {
  await checkRecoveryFile(".original");
}

async function test_missingSourceWithOriginalFile() {
  await checkRecoveryFile(".original", true);
}

/**
 * Empty mboxes must honor the same listener failure as nonempty mboxes.
 */
async function test_emptyMboxListenerError() {
  localAccountUtils.loadLocalMailAccount();
  try {
    const inbox = localAccountUtils.inboxFolder;
    Assert.equal(inbox.msgStore.storeType, "mbox");
    await IOUtils.writeUTF8(inbox.filePath.path, "");
    const listener = new PromiseStoreCompactListener();
    let completionStatus;
    let completed = 0;
    listener.onCompactionBegin = function () {
      throw Components.Exception("", Cr.NS_ERROR_ABORT);
    };
    listener.onCompactionComplete = function (status) {
      completionStatus = status;
      completed++;
    };
    inbox.msgStore.asyncCompact(inbox, listener, false);
    await Assert.rejects(
      listener.promise,
      error => error === Cr.NS_ERROR_ABORT
    );
    Assert.equal(completionStatus, Cr.NS_ERROR_ABORT);
    Assert.equal(completed, 1);
    Assert.equal(await IOUtils.readUTF8(inbox.filePath.path), "");
    const tempDir = PathUtils.join(
      PathUtils.parent(inbox.filePath.path),
      ".compact-temp"
    );
    Assert.ok(!(await IOUtils.exists(tempDir)), "No compaction files remain");
  } finally {
    localAccountUtils.clearAll();
  }
}

/**
 * Backup cleanup failure does not invalidate an installed compacted mbox.
 */
async function test_backupCleanupFailure() {
  localAccountUtils.loadLocalMailAccount();
  let backupPath;
  let savedPath;
  try {
    const folder = localAccountUtils.inboxFolder;
    const store = folder.msgStore;
    Assert.equal(store.storeType, "mbox");
    Assert.ok(store.supportsCompaction);
    const bodies = [
      "Subject: Discarded by compaction\r\nMessage-ID: <discarded@example.invalid>\r\n\r\nDiscarded body.\r\n",
      "Subject: Retained by compaction\r\nMessage-ID: <retained@example.invalid>\r\n\r\nRetained body.\r\n",
    ];
    const tokens = [];
    for (const body of bodies) {
      const output = store.getNewMsgOutputStream(folder);
      output.write(body, body.length);
      tokens.push(store.finishNewMessage(folder, output));
    }
    const originalScan = new PromiseTestUtils.PromiseStoreScanListener();
    store.asyncScan(folder, originalScan);
    await originalScan.promise;
    Assert.deepEqual(originalScan.messages, bodies);
    Assert.deepEqual(originalScan.tokens, tokens);
    const originalChecksum = await fileChecksum(folder.filePath.path);
    const tempDir = folder.filePath.parent;
    tempDir.append(".compact-temp");
    const backup = tempDir.clone();
    backup.append(folder.filePath.leafName + ".original");
    backupPath = backup.path;
    savedPath = backupPath + ".saved";
    const listener = new PromiseStoreCompactListener();
    let completed = 0;
    let completionStatus;
    let retainedToken;
    listener.onRetentionQuery = token => token === tokens[1];
    listener.onMessageRetained = (_oldToken, newToken) => {
      retainedToken = newToken;
    };
    listener.onCompactionComplete = status => {
      completed++;
      completionStatus = status;
      if (status !== Cr.NS_OK) {
        return;
      }
      // Keep the real original bytes, then obstruct only backup cleanup.
      backup.clone().moveTo(tempDir, backup.leafName + ".saved");
      backup.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
      const obstruction = backup.clone();
      obstruction.append("keep");
      obstruction.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
    };
    store.asyncCompact(folder, listener, false);
    await listener.promise;
    Assert.equal(completed, 1);
    Assert.equal(completionStatus, Cr.NS_OK, "Installation was permitted");
    Assert.equal(typeof retainedToken, "string");
    Assert.equal(await fileChecksum(savedPath), originalChecksum);
    Assert.ok(await IOUtils.exists(PathUtils.join(backupPath, "keep")));
    const stream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    stream.init(store.getMsgInputStream(folder, retainedToken, 0));
    let body = "";
    let chunk;
    while ((chunk = stream.read(4096))) {
      body += chunk;
    }
    stream.close();
    Assert.equal(body, bodies[1]);
    const scan = new PromiseTestUtils.PromiseStoreScanListener();
    store.asyncScan(folder, scan);
    await scan.promise;
    Assert.deepEqual(scan.messages, [bodies[1]]);
    Assert.deepEqual(scan.tokens, [retainedToken]);
    const installed = await IOUtils.read(folder.filePath.path);
    const retry = new PromiseStoreCompactListener();
    let retryBegan = false;
    retry.onCompactionBegin = () => {
      retryBegan = true;
    };
    await Assert.rejects(
      (async () => {
        store.asyncCompact(folder, retry, false);
        await retry.promise;
      })(),
      error => (error.result ?? error) === Cr.NS_ERROR_FILE_ALREADY_EXISTS
    );
    Assert.ok(!retryBegan, "The retained backup blocks the next compaction");
    Assert.deepEqual(await IOUtils.read(folder.filePath.path), installed);
    Assert.equal(await fileChecksum(savedPath), originalChecksum);
  } finally {
    if (backupPath) {
      await IOUtils.remove(backupPath, { recursive: true, ignoreAbsent: true });
    }
    if (savedPath) {
      await IOUtils.remove(savedPath, { ignoreAbsent: true });
    }
    localAccountUtils.clearAll();
  }
}

// TODO
// More test ideas:
// - Test X-Mozilla-* header patching (higher-level folder-compact tests
//   already cover this, but it'd probably be cleaner doing it here).

// Return a wrapper which sets the store type before running fn().
function withStore(store, fn) {
  return async () => {
    Services.prefs.setCharPref("mail.serverDefaultStoreContractID", store);
    Services.prefs.setCharPref("mail.server.default.storeContractID", store);
    await fn();
  };
}

// Only mbox has compaction. For now. It is possible others might in future.
const mboxStore = "@mozilla.org/msgstore/berkeleystore;1";
add_task(withStore(mboxStore, test_discardAll));
add_task(withStore(mboxStore, test_listenerErrors));
add_task(withStore(mboxStore, test_midwayFail));
add_task(withStore(mboxStore, test_sizesAtCompletion));
add_task(withStore(mboxStore, test_malformedMboxes));
add_task(withStore(mboxStore, test_existingCompactingFile));
add_task(withStore(mboxStore, test_existingCompactedFile));
add_task(withStore(mboxStore, test_existingOriginalFile));
add_task(withStore(mboxStore, test_missingSourceWithOriginalFile));
add_task(withStore(mboxStore, test_emptyMboxListenerError));
add_task(withStore(mboxStore, test_backupCleanupFailure));

/**
 * Create a folder with a discarded prefix and two committed retained messages.
 *
 * @returns {Promise<{folder: nsIMsgLocalMailFolder, connection: mozIStorageConnection,
 *   originals: Array<{key: number, token: string, size: number, lines: number,
 *     flags: number, raw: string}>, originalBytes: Uint8Array, compacted: nsIFile,
 *   backup: nsIFile}>} Native compaction fixture and original identities.
 */
async function makeRelocationFolder() {
  localAccountUtils.clearAll();
  Services.prefs.setCharPref("mail.serverDefaultStoreContractID", mboxStore);
  Services.prefs.setCharPref("mail.server.default.storeContractID", mboxStore);
  localAccountUtils.loadLocalMailAccount();
  const folder = localAccountUtils.inboxFolder;
  const dbService = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.ok(dbService instanceof Ci.nsIDatabaseCore);
  Assert.equal(folder.server.msgStore.storeType, "mbox");
  Assert.equal(folder.msgStore.storeType, "mbox");
  const removed = folder.addMessage(
    "Subject: Discard this prefix\r\n\r\nDiscarded physical body.\r\n"
  );
  const originals = [];
  for (let number = 1; number <= 2; number++) {
    const header = folder.addMessage(
      `Subject: Relocated message ${number}\r\n` +
        `Message-ID: <relocated-${number}@example.invalid>\r\n` +
        "References: <root@example.invalid> <parent@example.invalid> <root@example.invalid>\r\n\r\n" +
        `Relocated body ${number}.\r\n`
    );
    header.flags |= Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked;
    header.setStringProperty("compaction-note", "retain this property");
    originals.push({
      key: header.messageKey,
      token: header.storeToken,
      size: header.messageSize,
      lines: header.lineCount,
      flags: header.flags,
      raw: mailTestUtils.loadMessageToString(folder, header),
    });
  }
  const removedSize = removed.messageSize;
  folder.msgDatabase.deleteMessage(removed.messageKey, null, true);
  folder.msgDatabase.dBFolderInfo.expungedBytes = removedSize;
  const compacted = folder.filePath.parent;
  compacted.append(".compact-temp");
  const backup = compacted.clone();
  compacted.append(folder.filePath.leafName + ".compacted");
  backup.append(folder.filePath.leafName + ".original");
  return {
    folder,
    connection: dbService.QueryInterface(Ci.nsIDatabaseCore).connectionForTests,
    originals,
    originalBytes: await IOUtils.read(folder.filePath.path),
    compacted,
    backup,
  };
}

/**
 * Read a scalar from the existing native test connection.
 *
 * @param {mozIStorageConnection} connection - Native connection.
 * @param {string} sql - Scalar query using the folder or key parameter.
 * @param {number} id - Physical key or folder ID.
 * @returns {string|null} First scalar value, or null when no row exists.
 */
function relocationScalar(connection, sql, id) {
  const statement = connection.createStatement(sql);
  try {
    statement.params.id = id;
    return statement.executeStep() ? statement.getUTF8String(0) : null;
  } finally {
    statement.finalize();
  }
}

/**
 * Compact a real folder through its ordinary URL listener.
 *
 * @param {nsIMsgLocalMailFolder} folder - Folder to compact.
 * @returns {Promise<void>} Resolves after final folder completion.
 */
async function compactRelocationFolder(folder) {
  let completionStatus;
  const listener = new PromiseTestUtils.PromiseUrlListener({
    OnStopRunningUrl(_url, status) {
      completionStatus = status;
    },
  });
  folder.compact(listener, null);
  // PromiseUrlListener wraps the status in Error.message, without .result.
  await listener.promise.catch(error => {
    throw Components.Exception(error.message, completionStatus);
  });
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_folderRelocationSuccess() {
    const { folder, connection, originals, backup, compacted } =
      await makeRelocationFolder();
    try {
      await compactRelocationFolder(folder);
      Assert.deepEqual(
        folder.msgDatabase.listAllKeys().sort((a, b) => a - b),
        originals.map(row => row.key).sort((a, b) => a - b)
      );
      for (const [index, original] of originals.entries()) {
        const header = folder.msgDatabase.getMsgHdrForKey(original.key);
        Assert.equal(header.subject, `Relocated message ${index + 1}`);
        Assert.equal(
          header.messageId,
          `relocated-${index + 1}@example.invalid`
        );
        Assert.equal(header.flags, original.flags);
        Assert.equal(header.numReferences, 3);
        Assert.deepEqual(
          Array.from({ length: 3 }, (_, i) => header.getStringReference(i)),
          [
            "root@example.invalid",
            "parent@example.invalid",
            "root@example.invalid",
          ]
        );
        Assert.equal(header.lineCount, original.lines);
        Assert.equal(
          header.getStringProperty("compaction-note"),
          "retain this property"
        );
        const raw = mailTestUtils.loadMessageToString(folder, header);
        Assert.equal(header.messageSize, raw.length);
        const normalized = raw.replaceAll("\r\n", "\n");
        Assert.equal(
          normalized.slice(normalized.indexOf("\n\n") + 2),
          `Relocated body ${index + 1}.\n`
        );
      }
      Assert.equal(
        relocationScalar(
          connection,
          "SELECT state FROM body_relocations WHERE folderId=:id",
          folder.id
        ),
        "1"
      );
      Assert.equal(folder.msgDatabase.dBFolderInfo.expungedBytes, 0);
      Assert.ok(!backup.exists());
      Assert.ok(!compacted.exists());
      Assert.ok(!folder.locked);
    } finally {
      localAccountUtils.clearAll();
    }
  });

  add_task(async function test_folderRelocationUnfinishedWrite() {
    const { folder, originalBytes } = await makeRelocationFolder();
    const store = folder.msgStore;
    const output = store.getNewMsgOutputStream(folder);
    let discardAttempted = false;
    try {
      const pending = "Subject: Unfinished append\r\n\r\nUnfinished body.\r\n";
      output.write(pending, pending.length);
      await Assert.rejects(
        compactRelocationFolder(folder),
        error => (error.result ?? error) == Cr.NS_ERROR_IN_PROGRESS
      );
      discardAttempted = true;
      store.discardNewMessage(folder, output);
      Assert.deepEqual(await IOUtils.read(folder.filePath.path), originalBytes);
      await compactRelocationFolder(folder);
      Assert.equal(folder.getTotalMessages(false), 2);
    } finally {
      if (!discardAttempted) {
        store.discardNewMessage(folder, output);
      }
      localAccountUtils.clearAll();
    }
  });

  add_task(async function test_folderRelocationPreparationFailure() {
    const { folder, connection, originals, originalBytes, backup, compacted } =
      await makeRelocationFolder();
    let faults = 0;
    let layout;
    connection.createFunction("compact_prepare_fault", 0, {
      onFunctionCall() {
        faults++;
        layout = [
          folder.filePath.exists(),
          compacted.exists(),
          backup.exists(),
        ];
        return 0;
      },
    });
    try {
      connection.executeSimpleSQL(
        "CREATE TEMP TRIGGER compact_prepare_fault BEFORE INSERT ON main.body_relocations " +
          `WHEN NEW.folderId=${folder.id} BEGIN SELECT compact_prepare_fault(); ` +
          "SELECT RAISE(ABORT, 'Compaction preparation failed'); END"
      );
      await Assert.rejects(
        compactRelocationFolder(folder),
        error => (error.result ?? error) == Cr.NS_ERROR_STORAGE_CONSTRAINT
      );
      Assert.equal(faults, 1);
      Assert.deepEqual(
        layout,
        [true, true, false],
        "Prepare precedes the destructive rename"
      );
      Assert.deepEqual(await IOUtils.read(folder.filePath.path), originalBytes);
      for (const original of originals) {
        const header = folder.msgDatabase.getMsgHdrForKey(original.key);
        Assert.equal(header.storeToken, original.token);
        Assert.equal(header.messageSize, original.size);
        Assert.equal(
          mailTestUtils.loadMessageToString(folder, header),
          original.raw
        );
      }
      Assert.equal(
        relocationScalar(
          connection,
          "SELECT state FROM body_relocations WHERE folderId=:id",
          folder.id
        ),
        null
      );
      Assert.ok(
        compacted.exists(),
        "Completed bytes survive failed preparation"
      );
      Assert.ok(!backup.exists());
      Assert.ok(!folder.locked);
      await Assert.rejects(
        compactRelocationFolder(folder),
        error => (error.result ?? error) == Cr.NS_ERROR_FILE_ALREADY_EXISTS
      );
      Assert.deepEqual(await IOUtils.read(folder.filePath.path), originalBytes);
    } finally {
      try {
        connection.executeSimpleSQL(
          "DROP TRIGGER IF EXISTS temp.compact_prepare_fault"
        );
      } finally {
        connection.removeFunction("compact_prepare_fault");
        localAccountUtils.clearAll();
      }
    }
  });

  add_task(async function test_folderRelocationPendingRemoval() {
    const { folder, connection, originals } = await makeRelocationFolder();
    try {
      const removed = folder.msgDatabase.getMsgHdrForKey(originals[0].key);
      removed.setStringProperty("pendingRemoval", "1");
      removed.flags |= Ci.nsMsgMessageFlags.Offline;
      await compactRelocationFolder(folder);
      const retained = folder.msgDatabase.getMsgHdrForKey(originals[0].key);
      Assert.equal(retained.storeToken, "");
      Assert.equal(
        relocationScalar(
          connection,
          "SELECT value FROM message_properties WHERE id=:id AND name='storeToken'",
          originals[0].key
        ),
        "",
        "Pending removal preserves the present empty legacy property"
      );
      Assert.equal(retained.flags, originals[0].flags);
      Assert.equal(retained.getStringProperty("pendingRemoval"), "1");
      Assert.equal(folder.getTotalMessages(false), 2);
      const scan = new PromiseTestUtils.PromiseStoreScanListener();
      folder.msgStore.asyncScan(folder, scan);
      await scan.promise;
      Assert.equal(scan.messages.length, 1);
      const raw = scan.messages[0];
      Assert.ok(
        /^X-Mozilla-Status: [0-9a-f]{4}\r\nX-Mozilla-Status2: [0-9a-f]{8}\r\nX-Mozilla-Keys: [ ]{80}\r\n/.test(
          raw
        ),
        "Compaction prepends the generated storage headers"
      );
      Assert.equal(
        raw.slice(raw.indexOf("\r\n", raw.indexOf("X-Mozilla-Keys:")) + 2),
        originals[1].raw,
        "Every original header and body byte follows the generated prefix"
      );
      Assert.deepEqual(scan.tokens, [
        folder.msgDatabase.getMsgHdrForKey(originals[1].key).storeToken,
      ]);
    } finally {
      localAccountUtils.clearAll();
    }
  });

  if (AppConstants.platform == "win") {
    add_task(async function test_folderRelocationRenameFailure() {
      const {
        folder,
        connection,
        originals,
        originalBytes,
        backup,
        compacted,
      } = await makeRelocationFolder();
      let heldInput;
      let locks = 0;
      let acknowledgements = 0;
      let layout;
      connection.createFunction("compact_rename_lock", 0, {
        onFunctionCall() {
          locks++;
          // No SHARE_DELETE: retain a real handle through the first rename.
          heldInput = Cc[
            "@mozilla.org/network/file-input-stream;1"
          ].createInstance(Ci.nsIFileInputStream);
          heldInput.init(folder.filePath, 0x01 /* PR_RDONLY */, 0, 0);
          return 0;
        },
      });
      connection.createFunction("compact_restored", 0, {
        onFunctionCall() {
          acknowledgements++;
          layout = [
            folder.filePath.exists(),
            compacted.exists(),
            backup.exists(),
          ];
          return 0;
        },
      });
      try {
        connection.executeSimpleSQL(
          "CREATE TEMP TRIGGER compact_rename_lock AFTER INSERT ON main.body_relocations " +
            `WHEN NEW.folderId=${folder.id} BEGIN SELECT compact_rename_lock(); END`
        );
        connection.executeSimpleSQL(
          "CREATE TEMP TRIGGER compact_restored BEFORE UPDATE ON main.body_relocations " +
            `WHEN NEW.folderId=${folder.id} AND NEW.state=2 ` +
            "BEGIN SELECT compact_restored(); END"
        );
        await Assert.rejects(
          compactRelocationFolder(folder),
          error => (error.result ?? error) == Cr.NS_ERROR_FILE_IS_LOCKED
        );
        Assert.equal(locks, 1);
        Assert.equal(acknowledgements, 1);
        Assert.deepEqual(layout, [true, true, false]);
        Assert.equal(
          relocationScalar(
            connection,
            "SELECT state FROM body_relocations WHERE folderId=:id",
            folder.id
          ),
          "2",
          "The provider acknowledged its untouched original before cleanup"
        );
        Assert.deepEqual(
          await IOUtils.read(folder.filePath.path),
          originalBytes
        );
        Assert.ok(!compacted.exists());
        Assert.ok(!backup.exists());
        Assert.ok(!folder.locked);
        for (const original of originals) {
          const header = folder.msgDatabase.getMsgHdrForKey(original.key);
          Assert.equal(header.storeToken, original.token);
          Assert.equal(header.messageSize, original.size);
          Assert.equal(
            mailTestUtils.loadMessageToString(folder, header),
            original.raw
          );
        }
        heldInput.close();
        heldInput = null;
        connection.executeSimpleSQL("DROP TRIGGER temp.compact_rename_lock");
        connection.executeSimpleSQL("DROP TRIGGER temp.compact_restored");
        await compactRelocationFolder(folder);
        Assert.equal(
          relocationScalar(
            connection,
            "SELECT state FROM body_relocations WHERE folderId=:id",
            folder.id
          ),
          "1",
          "A transient rename error does not strand the next compaction"
        );
        Assert.deepEqual(
          folder.msgDatabase.listAllKeys().toSorted((a, b) => a - b),
          originals.map(row => row.key).toSorted((a, b) => a - b)
        );
      } finally {
        heldInput?.close();
        try {
          connection.executeSimpleSQL(
            "DROP TRIGGER IF EXISTS temp.compact_rename_lock"
          );
          connection.executeSimpleSQL(
            "DROP TRIGGER IF EXISTS temp.compact_restored"
          );
        } finally {
          connection.removeFunction("compact_rename_lock");
          connection.removeFunction("compact_restored");
          if (
            relocationScalar(
              connection,
              "SELECT state FROM body_relocations WHERE folderId=:id",
              folder.id
            ) != "0"
          ) {
            localAccountUtils.clearAll();
          }
        }
      }
    });
  }

  // Keep the failed folder in this disposable profile. Removing its account
  // would bypass the pending recovery contract; a recovery driver is separate.
  add_task(async function test_folderRelocationSettlementFailure() {
    const { folder, connection, originals, originalBytes, backup, compacted } =
      await makeRelocationFolder();
    let faults = 0;
    let layout;
    const laterKey = Math.max(...originals.map(row => row.key));
    connection.createFunction("compact_settle_fault", 0, {
      onFunctionCall() {
        faults++;
        layout = [
          folder.filePath.exists(),
          compacted.exists(),
          backup.exists(),
        ];
        return 0;
      },
    });
    try {
      connection.executeSimpleSQL(
        "CREATE TEMP TRIGGER compact_settle_fault BEFORE INSERT ON main.message_properties " +
          `WHEN NEW.id=${laterKey} AND NEW.name='storeToken' ` +
          "BEGIN SELECT compact_settle_fault(); " +
          "SELECT RAISE(ABORT, 'Later relocation settlement failed'); END"
      );
      await Assert.rejects(
        compactRelocationFolder(folder),
        error => (error.result ?? error) == Cr.NS_ERROR_STORAGE_CONSTRAINT
      );
      Assert.equal(faults, 1);
      Assert.deepEqual(
        layout,
        [true, false, true],
        "Settlement follows installation with backup intact"
      );
      Assert.deepEqual(await IOUtils.read(backup.path), originalBytes);
      Assert.equal(
        relocationScalar(
          connection,
          "SELECT state FROM body_relocations WHERE folderId=:id",
          folder.id
        ),
        "0"
      );
      for (const original of originals) {
        Assert.equal(
          relocationScalar(
            connection,
            "SELECT value FROM message_properties WHERE id=:id AND name='storeToken'",
            original.key
          ),
          original.token
        );
      }
      const installed = await IOUtils.readUTF8(folder.filePath.path);
      Assert.ok(installed.includes("Relocated body 1."));
      Assert.ok(installed.includes("Relocated body 2."));
      Assert.ok(!installed.includes("Discarded physical body."));
      Assert.throws(
        () => folder.msgStore.getMsgInputStream(folder, originals[0].token, 0),
        error => error.result == Cr.NS_ERROR_IN_PROGRESS
      );
      Assert.throws(
        () => folder.msgStore.getNewMsgOutputStream(folder),
        error => error.result == Cr.NS_ERROR_IN_PROGRESS
      );
      Assert.ok(!folder.locked);
    } finally {
      try {
        connection.executeSimpleSQL(
          "DROP TRIGGER IF EXISTS temp.compact_settle_fault"
        );
      } finally {
        connection.removeFunction("compact_settle_fault");
      }
    }
  });
}

/**
 * Refuses an actual foreign native subject without granting a live lease.
 * Live selected-owner assertions are in the original Core native fixture.
 *
 * @param {string} domain - The fixed native domain whose real IO started.
 */
function assertMigrationForeignContext(domain) {
  const gate = Cc["@mozilla.org/mailnews/migration-writer-lease;1"].getService(
    Ci.nsIObserver
  );
  const bag = gate.QueryInterface(Ci.nsIPropertyBag2);
  const subject = bag.getPropertyAsInterface(
    "writer-admission-subject",
    Ci.nsISupports
  );
  const before = bag.getPropertyAsUint32(`writer-history.${domain}`);
  Assert.equal(before, 1, "The real operation irreversibly marked Started");
  Assert.throws(
    () => gate.observe(subject, "check-writer-never-started", domain),
    error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
  );
  Assert.throws(
    () =>
      gate.observe(Services.appinfo, "validate-selected-view", "after-await"),
    error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
  );
  Assert.equal(bag.getPropertyAsUint32(`writer-history.${domain}`), before);
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_migrationCompactionFinalCleanupDrain() {
    const { folder, originals, compacted, backup } =
      await makeRelocationFolder();
    assertMigrationForeignContext("local-store");
    for (const original of originals) {
      const header = folder.msgDatabase.getMsgHdrForKey(original.key);
      Assert.equal(header.storeToken, original.token);
      Assert.equal(
        mailTestUtils.loadMessageToString(folder, header),
        original.raw
      );
    }
    await compactRelocationFolder(folder);
    Assert.ok(!(await IOUtils.exists(compacted.path)));
    Assert.ok(!(await IOUtils.exists(backup.path)));
    for (const original of originals) {
      const header = folder.msgDatabase.getMsgHdrForKey(original.key);
      Assert.equal(header.messageSize, original.size);
      Assert.equal(header.flags, original.flags);
      Assert.equal(
        mailTestUtils.loadMessageToString(folder, header),
        original.raw
      );
    }
  });
}
