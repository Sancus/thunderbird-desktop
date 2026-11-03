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

/**
 * Validate real mbox summary metadata without changing the body file.
 */
add_task(async function test_mboxSummaryValidation() {
  await withAvailabilityStore("mbox", async folder => {
    const database = folder.msgDatabase;
    const info = database.dBFolderInfo;
    const bytes = await IOUtils.read(folder.filePath.path);
    folder.msgStore.setSummaryFileValid(folder, database, true);
    Assert.ok(folder.msgStore.isSummaryFileValid(folder, database));
    Assert.equal(info.folderSize, folder.filePath.fileSize);
    Assert.deepEqual(await IOUtils.read(folder.filePath.path), bytes);
  });
});

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  /**
   * Preserve a real metadata getter error instead of accepting an empty mbox.
   */
  add_task(async function test_mboxSummaryGetterError() {
    await withAvailabilityStore("mbox", async folder => {
      const database = folder.msgDatabase;
      const info = database.dBFolderInfo;
      const store = folder.msgStore;
      const bytes = await IOUtils.read(folder.filePath.path);
      store.setSummaryFileValid(folder, database, true);
      Assert.equal(info.folderSize, 0);
      const originalDate = info.folderDate;
      info.setInt64Property("folderDate", -1);
      try {
        Assert.throws(
          () => info.folderDate,
          error => error.result == Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA
        );
        Assert.throws(
          () => store.isSummaryFileValid(folder, database),
          error => error.result == Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA
        );
        Assert.equal(info.getInt64Property("folderDate", 0), -1);
        Assert.deepEqual(database.listAllKeys(), []);
        Assert.deepEqual(await IOUtils.read(folder.filePath.path), bytes);
      } finally {
        info.folderDate = originalDate;
      }
      Assert.ok(store.isSummaryFileValid(folder, database));
    });
  });

  /**
   * Report the first real summary-property write error and keep the body file.
   */
  add_task(async function test_mboxSummarySetterErrors() {
    await withAvailabilityStore("mbox", async folder => {
      const database = folder.msgDatabase;
      const info = database.dBFolderInfo;
      const store = folder.msgStore;
      const bytes = await IOUtils.read(folder.filePath.path);
      const connection = Cc["@mozilla.org/mailnews/database-core;1"].getService(
        Ci.nsIDatabaseCore
      ).connectionForTests;
      for (const [property, valid] of [
        ["folderSize", true],
        ["folderDate", true],
        ["version", false],
      ]) {
        let faults = 0;
        connection.createFunction("mbox_summary_fault", 0, {
          onFunctionCall() {
            faults++;
            return 0;
          },
        });
        try {
          connection.executeSimpleSQL(
            "CREATE TEMP TRIGGER mbox_summary_fault BEFORE INSERT ON main.folder_properties " +
              `WHEN NEW.id = ${folder.id} AND NEW.name = '${property}' BEGIN ` +
              "SELECT mbox_summary_fault(); " +
              "SELECT RAISE(ABORT, 'Mbox summary metadata failed'); END"
          );
          Assert.throws(
            () => store.setSummaryFileValid(folder, database, valid),
            error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
          );
          Assert.equal(faults, 1);
          Assert.deepEqual(database.listAllKeys(), []);
          Assert.deepEqual(await IOUtils.read(folder.filePath.path), bytes);
        } finally {
          try {
            connection.executeSimpleSQL(
              "DROP TRIGGER IF EXISTS temp.mbox_summary_fault"
            );
          } finally {
            connection.removeFunction("mbox_summary_fault");
          }
        }
        // An earlier successful property write may remain after a later error.
        // This is not an atomic group of metadata setters.
        store.setSummaryFileValid(folder, database, true);
        Assert.equal(info.folderSize, folder.filePath.fileSize);
        Assert.ok(store.isSummaryFileValid(folder, database));
      }
    });
  });
}

/**
 * Stop a read-only scan on the first actual listener error, without losing data.
 *
 * @param {string} mode - Empty start, populated start, stop, or data plus stop.
 * @returns {Promise<void>} Checks both real providers and a successful rescan.
 */
async function checkScanListenerError(mode) {
  for (const type of ["mbox", "maildir"]) {
    await withAvailabilityStore(type, async folder => {
      const raws =
        mode == "empty-start"
          ? []
          : [0, 1].map(
              index =>
                "From: sender@example.invalid\r\n" +
                `Message-ID: <scan-error-${index}@example.invalid>\r\n` +
                `Subject: Scan retained message ${index}\r\n\r\n` +
                `Exact retained scanner body ${index}.\r\n`
            );
      const headers = raws.map(raw => folder.addMessage(raw));
      const originals = headers.map(header => ({
        key: header.messageKey,
        id: header.messageId,
        token: header.storeToken,
        size: header.messageSize,
        flags: header.flags,
      }));
      const physicalFiles = async () => {
        const paths =
          type == "mbox"
            ? [folder.filePath.path]
            : await IOUtils.getChildren(
                PathUtils.join(folder.filePath.path, "cur")
              );
        return Promise.all(
          paths.sort().map(async path => [path, await IOUtils.read(path)])
        );
      };
      const before = await physicalFiles();
      const listener = new PromiseTestUtils.PromiseStoreScanListener();
      let starts = 0;
      let stops = 0;
      const requestStops = [];
      listener.onStartScan = () => {
        starts++;
        if (mode.endsWith("start")) {
          throw Components.Exception(
            "Stop scan before reading",
            Cr.NS_ERROR_ABORT
          );
        }
      };
      const read = listener.onDataAvailable;
      listener.onDataAvailable = function (...args) {
        read.apply(this, args);
        if (mode == "data-stop") {
          throw Components.Exception(
            "Original scan data error",
            Cr.NS_ERROR_ABORT
          );
        }
      };
      listener.onStopRequest = (request, status) => {
        requestStops.push(status);
        throw Components.Exception(
          "Later scan stop error",
          Cr.NS_ERROR_FILE_ACCESS_DENIED
        );
      };
      const stop = listener.onStopScan;
      listener.onStopScan = function (status) {
        stops++;
        stop.call(this, status);
      };
      const expected =
        mode == "stop" ? Cr.NS_ERROR_FILE_ACCESS_DENIED : Cr.NS_ERROR_ABORT;
      // asyncScan guarantees that no callback runs before this call returns.
      folder.msgStore.asyncScan(folder, listener);
      await Assert.rejects(
        listener.promise,
        error => Number(error.message) == expected
      );
      Assert.equal(starts, 1);
      Assert.equal(stops, 1);
      if (mode.endsWith("start")) {
        Assert.deepEqual(listener.tokens, []);
        Assert.deepEqual(listener.messages, []);
        Assert.deepEqual(requestStops, []);
      } else {
        Assert.equal(listener.tokens.length, 1);
        const index = originals.findIndex(
          original => original.token == listener.tokens[0]
        );
        Assert.notEqual(index, -1);
        if (mode == "stop") {
          Assert.equal(listener.messages[0], raws[index]);
          Assert.deepEqual(requestStops, [Cr.NS_OK]);
        } else {
          // A deliberate data error can stop before all bytes are delivered.
          // The independent full body and physical-file checks below stay exact.
          Assert.greater(listener.messages[0].length, 0);
          Assert.ok(raws[index].startsWith(listener.messages[0]));
          Assert.deepEqual(requestStops, [Cr.NS_ERROR_ABORT]);
        }
      }
      Assert.deepEqual(
        folder.msgDatabase.listAllKeys().sort((a, b) => a - b),
        originals.map(original => original.key).sort((a, b) => a - b)
      );
      for (let i = 0; i < originals.length; i++) {
        const original = originals[i];
        const header = folder.msgDatabase.getMsgHdrForKey(original.key);
        Assert.equal(header.folder, folder);
        Assert.equal(header.messageId, original.id);
        Assert.equal(header.storeToken, original.token);
        Assert.equal(header.messageSize, original.size);
        Assert.equal(header.flags, original.flags);
        Assert.equal(
          mailTestUtils.loadMessageToString(folder, header),
          raws[i]
        );
      }
      Assert.deepEqual(await physicalFiles(), before);
      const retry = new PromiseTestUtils.PromiseStoreScanListener();
      folder.msgStore.asyncScan(folder, retry);
      await retry.promise;
      Assert.deepEqual(retry.messages.toSorted(), raws.toSorted());
      Assert.deepEqual(
        retry.tokens.toSorted(),
        originals.map(original => original.token).toSorted()
      );
      Assert.deepEqual(await physicalFiles(), before);
    });
  }
}

add_task(async function test_scanEmptyStartError() {
  await checkScanListenerError("empty-start");
});
add_task(async function test_scanStartError() {
  await checkScanListenerError("start");
});
add_task(async function test_scanStopError() {
  await checkScanListenerError("stop");
});
add_task(async function test_scanDataKeepsFirstError() {
  await checkScanListenerError("data-stop");
});

/**
 * A real failed import must retain finished store bytes and report its error.
 *
 * @param {string} storeType - Expected provider type.
 */
async function checkRepairAttachError(storeType) {
  await withAvailabilityStore(storeType, async folder => {
    const id = folder.id;
    const uri = folder.URI;
    const store = folder.msgStore;
    const raw =
      "From: repair@example.invalid\r\n" +
      "Subject: Repair attachment error\r\n" +
      "Message-ID: <repair-attachment@example.invalid>\r\n" +
      "References: <first@example.invalid> <second@example.invalid>\r\n" +
      "\r\nExact retained repair body.\r\n";
    const stream = store.getNewMsgOutputStream(folder);
    Assert.equal(stream.write(raw, raw.length), raw.length);
    const token = store.finishNewMessage(folder, stream);
    Assert.notEqual(token, ""); // The first mbox token may be zero.
    const path =
      storeType == "mbox"
        ? folder.filePath.path
        : PathUtils.join(folder.filePath.path, "cur", token);
    const bytes = await IOUtils.read(path);
    Assert.deepEqual(folder.msgDatabase.listAllKeys(), []);
    const connection = Cc["@mozilla.org/mailnews/database-core;1"].getService(
      Ci.nsIDatabaseCore
    ).connectionForTests;
    let faults = 0;
    connection.createFunction("repair_attach_fault", 0, {
      onFunctionCall() {
        faults++;
        return 0;
      },
    });
    let installed = false;
    try {
      connection.executeSimpleSQL(
        "CREATE TEMP TRIGGER repair_attach_fault BEFORE INSERT ON main.messages " +
          `WHEN NEW.folderId=${id} BEGIN SELECT repair_attach_fault(); ` +
          "SELECT RAISE(ABORT, 'repair attachment failure'); END"
      );
      installed = true;
      const statuses = [];
      const listener = new PromiseTestUtils.PromiseUrlListener({
        OnStopRunningUrl(url, status) {
          statuses.push(status);
        },
      });
      folder.parseFolder(null, listener);
      const result = await listener.promise.then(
        () => Cr.NS_OK,
        error => Number(error.message)
      );
      Assert.equal(faults, 1, "The real attachment reached the failing write");
      Assert.equal(result, Cr.NS_ERROR_STORAGE_CONSTRAINT);
      Assert.deepEqual(statuses, [Cr.NS_ERROR_STORAGE_CONSTRAINT]);
      Assert.equal(folder.id, id);
      Assert.equal(folder.URI, uri);
      Assert.ok(!folder.locked);
      Assert.deepEqual(folder.msgDatabase.listAllKeys(), []);
      Assert.deepEqual(await IOUtils.read(path), bytes);
      Assert.equal(readAll(store.getMsgInputStream(folder, token, 0)), raw);

      connection.executeSimpleSQL("DROP TRIGGER temp.repair_attach_fault");
      installed = false;
      const retry = new PromiseTestUtils.PromiseUrlListener();
      folder.parseFolder(null, retry);
      await retry.promise;
      const keys = folder.msgDatabase.listAllKeys();
      Assert.equal(keys.length, 1);
      const header = folder.msgDatabase.getMsgHdrForKey(keys[0]);
      Assert.equal(header.messageId, "repair-attachment@example.invalid");
      Assert.equal(header.subject, "Repair attachment error");
      Assert.equal(header.storeToken, token);
      Assert.equal(header.messageSize, raw.length);
      Assert.equal(header.lineCount, 1);
      Assert.equal(header.numReferences, 2);
      Assert.equal(header.getStringReference(0), "first@example.invalid");
      Assert.equal(header.getStringReference(1), "second@example.invalid");
      Assert.equal(mailTestUtils.loadMessageToString(folder, header), raw);
      Assert.deepEqual(await IOUtils.read(path), bytes);
      Assert.equal(folder.id, id);
      Assert.equal(folder.URI, uri);
      Assert.ok(!folder.locked);
    } finally {
      if (installed) {
        connection.executeSimpleSQL("DROP TRIGGER temp.repair_attach_fault");
      }
      connection.removeFunction("repair_attach_fault");
    }
  });
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_repairAttachErrorMbox() {
    await checkRepairAttachError("mbox");
  });
  add_task(async function test_repairAttachErrorMaildir() {
    await checkRepairAttachError("maildir");
  });
}

/**
 * Repair a complete real store without substituting its existing physical rows.
 *
 * @param {string} storeType - Expected provider type.
 * @param {boolean} failUpdate - Fail the second real native metadata update.
 */
async function checkRepairExistingRows(storeType, failUpdate) {
  await withAvailabilityStore(storeType, async folder => {
    const store = folder.msgStore;
    const raws = [
      "From: repair@example.invalid\r\n" +
        "Message-ID: <shared-repair@example.invalid>\r\n" +
        "Subject: Repaired first row\r\n" +
        "References: <older@example.invalid> <shared-repair@example.invalid> " +
        "<older@example.invalid>\r\n\r\nFirst retained body.\r\n",
      "From: repair@example.invalid\r\n" +
        "Message-ID: <shared-repair@example.invalid>\r\n" +
        "Subject: Repaired second row\r\n\r\nSecond retained body.\r\n",
      "From: repair@example.invalid\r\n" +
        "Message-ID: <shared-repair@example.invalid>\r\n" +
        "Subject: Newly discovered row\r\nReferences: \r\n\r\nNew retained body.\r\n",
    ];
    const originals = raws.slice(0, 2).map((raw, index) => {
      const header = folder.addMessage(raw);
      header.subject = `Stale summary ${index}`;
      header.setReferences("<stale-summary@example.invalid>");
      header.flags |= Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked;
      header.priority = Ci.nsMsgPriority.high;
      header.setStringProperty("repairUserState", `owned-${index}`);
      header.setStringProperty("repairEmpty", "");
      return {
        key: header.messageKey,
        token: header.storeToken,
        size: header.messageSize,
        flags: header.flags,
        subject: header.subject,
      };
    });
    Assert.notEqual(originals[0].key, originals[1].key);
    Assert.notEqual(originals[0].token, originals[1].token);
    const stream = store.getNewMsgOutputStream(folder);
    Assert.equal(stream.write(raws[2], raws[2].length), raws[2].length);
    const newToken = store.finishNewMessage(folder, stream);
    Assert.notEqual(newToken, "");
    const tokens = [...originals.map(original => original.token), newToken];
    const paths =
      storeType == "mbox"
        ? [folder.filePath.path]
        : tokens.map(token =>
            PathUtils.join(folder.filePath.path, "cur", token)
          );
    const bytes = await Promise.all(paths.map(path => IOUtils.read(path)));
    const id = folder.id;
    const uri = folder.URI;
    const keys = originals.map(original => original.key).sort((a, b) => a - b);
    const connection = Cc["@mozilla.org/mailnews/database-core;1"].getService(
      Ci.nsIDatabaseCore
    ).connectionForTests;
    let installed = false;
    let faults = 0;
    if (failUpdate) {
      connection.createFunction("existing_repair_fault", 0, {
        onFunctionCall() {
          faults++;
          return 0;
        },
      });
    }
    try {
      if (failUpdate) {
        connection.executeSimpleSQL(
          "CREATE TEMP TRIGGER existing_repair_fault BEFORE UPDATE ON main.messages " +
            `WHEN OLD.id=${originals[1].key} BEGIN SELECT existing_repair_fault(); ` +
            "SELECT RAISE(ABORT, 'existing repair failure'); END"
        );
        installed = true;
        const statuses = [];
        const failed = new PromiseTestUtils.PromiseUrlListener({
          OnStopRunningUrl(url, status) {
            statuses.push(status);
          },
        });
        folder.parseFolder(null, failed);
        const result = await failed.promise.then(
          () => Cr.NS_OK,
          error => Number(error.message)
        );
        Assert.equal(
          faults,
          1,
          "The second existing row reaches the actual SQL fault"
        );
        Assert.equal(result, Cr.NS_ERROR_STORAGE_CONSTRAINT);
        Assert.deepEqual(statuses, [Cr.NS_ERROR_STORAGE_CONSTRAINT]);
        Assert.ok(!folder.locked);
        Assert.ok(!folder.msgDatabase.summaryValid);
        folder.msgDatabase.forceClosed();
        folder.msgDatabase = null;
        Assert.ok(
          !folder.msgDatabase.summaryValid,
          "Failed repair stays invalid after reopen"
        );
        Assert.deepEqual(
          folder.msgDatabase.listAllKeys().sort((a, b) => a - b),
          keys
        );
        for (const original of originals) {
          const retained = folder.msgDatabase.getMsgHdrForKey(original.key);
          Assert.equal(retained.subject, original.subject);
          Assert.equal(
            retained.getStringReference(0),
            "stale-summary@example.invalid"
          );
          Assert.equal(retained.flags, original.flags);
          Assert.equal(retained.storeToken, original.token);
        }
        for (const [index, path] of paths.entries()) {
          Assert.deepEqual(await IOUtils.read(path), bytes[index]);
        }
        for (const [index, token] of tokens.entries()) {
          Assert.equal(
            readAll(store.getMsgInputStream(folder, token, 0)),
            raws[index]
          );
        }
        connection.executeSimpleSQL("DROP TRIGGER temp.existing_repair_fault");
        installed = false;
      }
      const statuses = [];
      const repeatedStatuses = [];
      const repeated = new PromiseTestUtils.PromiseUrlListener({
        OnStopRunningUrl(url, status) {
          repeatedStatuses.push(status);
        },
      });
      const repaired = new PromiseTestUtils.PromiseUrlListener({
        OnStopRunningUrl(url, status) {
          statuses.push(status);
          if (status == Cr.NS_OK) {
            // A completed scan has released its semaphore. The old listener
            // must not clear this follow-on scan's listener after reentry.
            folder.parseFolder(null, repeated);
          }
        },
      });
      if (failUpdate) {
        // The failed repair's invalid native summary must launch a same-row
        // reparse, including when this folder already has a cached wrapper.
        Assert.throws(
          () => folder.getDatabaseWithReparse(repaired, null),
          error => error.result === Cr.NS_ERROR_NOT_INITIALIZED
        );
      } else {
        folder.parseFolder(null, repaired);
      }
      await repaired.promise;
      await repeated.promise;
      Assert.deepEqual(statuses, [Cr.NS_OK]);
      Assert.deepEqual(repeatedStatuses, [Cr.NS_OK]);
      Assert.equal(folder.id, id);
      Assert.equal(folder.URI, uri);
      Assert.ok(!folder.locked);
      Assert.ok(folder.msgDatabase.summaryValid);
      const repairedKeys = folder.msgDatabase
        .listAllKeys()
        .sort((a, b) => a - b);
      Assert.equal(repairedKeys.length, 3);
      Assert.equal(folder.getTotalMessages(false), 3);
      for (const key of keys) {
        Assert.ok(
          repairedKeys.includes(key),
          "A matched physical row keeps its key"
        );
      }
      const newKeys = repairedKeys.filter(key => !keys.includes(key));
      Assert.equal(
        newKeys.length,
        1,
        "Only the unmatched actual body receives a new key"
      );
      for (const [index, key] of [
        ...originals.map(original => original.key),
        newKeys[0],
      ].entries()) {
        const header = folder.msgDatabase.getMsgHdrForKey(key);
        Assert.equal(header.messageId, "shared-repair@example.invalid");
        Assert.equal(
          header.subject,
          ["Repaired first row", "Repaired second row", "Newly discovered row"][
            index
          ]
        );
        Assert.equal(header.storeToken, tokens[index]);
        Assert.equal(header.messageSize, raws[index].length);
        Assert.equal(
          mailTestUtils.loadMessageToString(folder, header),
          raws[index]
        );
        if (index < originals.length) {
          Assert.equal(header.flags, originals[index].flags);
          Assert.equal(header.priority, Ci.nsMsgPriority.high);
          Assert.equal(
            header.getStringProperty("repairUserState"),
            `owned-${index}`
          );
          Assert.ok(header.properties.includes("repairEmpty"));
          Assert.equal(header.getStringProperty("repairEmpty"), "");
          Assert.ok(!header.properties.includes("repairAbsent"));
        }
        const expectedReferences =
          index == 0
            ? [
                "older@example.invalid",
                "shared-repair@example.invalid",
                "older@example.invalid",
              ]
            : [];
        const statement = connection.createStatement(
          "SELECT token FROM message_references WHERE id = :id ORDER BY ordinal"
        );
        statement.params.id = key;
        const storedReferences = [];
        try {
          while (statement.executeStep()) {
            storedReferences.push(statement.row.token);
          }
        } finally {
          statement.finalize();
        }
        Assert.deepEqual(storedReferences, expectedReferences);
        // The legacy getter filters self references; raw native custody above
        // still retains their exact order and duplicate tokens.
        Assert.deepEqual(
          Array.from({ length: header.numReferences }, (_, n) =>
            header.getStringReference(n)
          ),
          expectedReferences.filter(reference => reference != header.messageId)
        );
        // Known native References use a typed presence row, including when
        // the original RFC header was absent or explicitly empty.
        const presence = connection.createStatement(
          "SELECT COUNT(*) AS count FROM message_reference_sets WHERE id = :id"
        );
        presence.params.id = key;
        try {
          Assert.ok(presence.executeStep());
          Assert.equal(presence.row.count, 1);
        } finally {
          presence.finalize();
        }
      }
      folder.msgDatabase.forceClosed();
      folder.msgDatabase = null;
      Assert.ok(folder.msgDatabase.summaryValid);
      Assert.deepEqual(
        folder.msgDatabase.listAllKeys().sort((a, b) => a - b),
        repairedKeys
      );
      for (const [index, path] of paths.entries()) {
        Assert.deepEqual(await IOUtils.read(path), bytes[index]);
      }
    } finally {
      if (installed) {
        connection.executeSimpleSQL("DROP TRIGGER temp.existing_repair_fault");
      }
      if (failUpdate) {
        connection.removeFunction("existing_repair_fault");
      }
    }
  });
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_repairExistingRowsMbox() {
    await checkRepairExistingRows("mbox", false);
  });
  add_task(async function test_repairExistingRowsMaildir() {
    await checkRepairExistingRows("maildir", false);
  });
  add_task(async function test_repairExistingRowsRollbackMbox() {
    await checkRepairExistingRows("mbox", true);
  });
  add_task(async function test_repairExistingRowsRollbackMaildir() {
    await checkRepairExistingRows("maildir", true);
  });
}

/**
 * A body with incomplete headers is retained without a false valid summary.
 *
 * @param {string} storeType - Expected provider type.
 */
async function checkRepairMalformedHeaders(storeType) {
  await withAvailabilityStore(storeType, async folder => {
    const store = folder.msgStore;
    const good = "Subject: Existing row\r\n\r\nRetained existing bytes.\r\n";
    const header = folder.addMessage(good);
    const key = header.messageKey;
    const token = header.storeToken;
    const malformed =
      "From: malformed@example.invalid\r\n" +
      "Subject: Incomplete header block\r\n" +
      "Message-ID: <malformed-repair@example.invalid>\r\n" +
      "X-Unfinished: value";
    const malformedToken = "repair-malformed-input";
    // Create retained corrupt input directly, like test_folderCompact2's
    // malformed mbox. Normal mbox Finish adds termination/separator bytes and
    // cannot reliably create this incomplete-header case. Setup/cleanup still
    // use the real account fixture; all bytes below are snapshotted before scan.
    if (storeType == "mbox") {
      await IOUtils.writeUTF8(folder.filePath.path, `From \r\n${malformed}`, {
        mode: "append",
      });
    } else {
      await IOUtils.writeUTF8(
        PathUtils.join(folder.filePath.path, "cur", malformedToken),
        malformed,
        { mode: "create" }
      );
    }
    const paths =
      storeType == "mbox"
        ? [folder.filePath.path]
        : [token, malformedToken].map(bodyToken =>
            PathUtils.join(folder.filePath.path, "cur", bodyToken)
          );
    const before = await Promise.all(paths.map(path => IOUtils.read(path)));
    const statuses = [];
    const listener = new PromiseTestUtils.PromiseUrlListener({
      OnStopRunningUrl(url, status) {
        statuses.push(status);
      },
    });
    folder.parseFolder(null, listener);
    const result = await listener.promise.then(
      () => Cr.NS_OK,
      error => Number(error.message)
    );
    // GetNewMsgHdr reports the original missing completed-header error.
    Assert.equal(result, Cr.NS_ERROR_NULL_POINTER);
    Assert.deepEqual(statuses, [Cr.NS_ERROR_NULL_POINTER]);
    Assert.ok(!folder.locked);
    Assert.ok(!folder.msgDatabase.summaryValid);
    folder.msgDatabase.forceClosed();
    folder.msgDatabase = null;
    Assert.ok(!folder.msgDatabase.summaryValid);
    Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
    const retained = folder.msgDatabase.getMsgHdrForKey(key);
    Assert.equal(retained.storeToken, token);
    Assert.equal(retained.subject, "Existing row");
    Assert.equal(mailTestUtils.loadMessageToString(folder, retained), good);
    for (const [index, path] of paths.entries()) {
      Assert.deepEqual(await IOUtils.read(path), before[index]);
    }
  });
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_repairMalformedHeadersMbox() {
    await checkRepairMalformedHeaders("mbox");
  });
  add_task(async function test_repairMalformedHeadersMaildir() {
    await checkRepairMalformedHeaders("maildir");
  });
}
