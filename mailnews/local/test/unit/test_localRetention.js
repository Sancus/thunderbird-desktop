/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* globals _PREFS_FILE */

const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

const RETENTION_STORES = {
  mbox: "@mozilla.org/msgstore/berkeleystore;1",
  maildir: "@mozilla.org/msgstore/maildirstore;1",
};

/**
 * Run retention through a real local folder using the selected body store.
 *
 * @param {string} store - Store type.
 * @param {function(nsIMsgLocalMailFolder): Promise<void>} check - Folder checks.
 * @returns {Promise<void>} Resolves after checks and account/pref cleanup.
 */
async function withRetentionFolder(store, check) {
  const prefs = [
    "mail.serverDefaultStoreContractID",
    "mail.server.default.storeContractID",
  ].map(name => ({
    name,
    hadValue: Services.prefs.prefHasUserValue(name),
    value: Services.prefs.getCharPref(name, ""),
  }));
  localAccountUtils.clearAll();
  try {
    for (const { name } of prefs) {
      Services.prefs.setCharPref(name, RETENTION_STORES[store]);
    }
    localAccountUtils.loadLocalMailAccount();
    const folder = localAccountUtils.rootFolder
      .createLocalSubfolder("retention")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    );
    Assert.equal(
      "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
      Services.prefs.getBoolPref("mail.panorama.enabled", false)
    );
    Assert.equal(service.openFolderDB(folder, false), folder.msgDatabase);
    Assert.equal(folder.msgStore.storeType, store);
    Assert.equal(folder.server.msgStore.storeType, store);
    await check(folder);
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

/**
 * @typedef {object} RetentionMessage
 * @property {number} key - Published physical message key.
 * @property {string} token - Provider storage token.
 * @property {number} size - Published byte count.
 * @property {number} lines - Published line count.
 * @property {number} flags - Published message flags.
 * @property {number} date - Published message date in microseconds.
 * @property {string} subject - Parsed subject.
 * @property {string} messageId - Parsed message id without angle brackets.
 * @property {string} note - Exact stored custom property value.
 * @property {string} raw - Original literal message bytes.
 */

/**
 * Add three dated messages and capture their published physical identities.
 *
 * @param {nsIMsgLocalMailFolder} folder - Test folder.
 * @returns {RetentionMessage[]} Metadata and literal bytes, oldest first.
 */
function addRetentionMessages(folder) {
  return [60, 30, 1].map((days, index) => {
    const date = new Date(Date.now() - days * 86400000).toUTCString();
    const raw =
      "From: sender@example.invalid\r\n" +
      `Subject: Retention message ${index}\r\n` +
      `Message-ID: <retention-${index}@example.invalid>\r\n` +
      `Date: ${date}\r\n` +
      "References: <root@example.invalid> <parent@example.invalid> <root@example.invalid>\r\n\r\n" +
      `Retention body ${index}.\r\n`;
    const header = folder.addMessage(raw);
    header.flags |= Ci.nsMsgMessageFlags.Read;
    header.setStringProperty("retention-note", index ? "keep this value" : "");
    Assert.equal(header.messageSize, raw.length);
    Assert.equal(mailTestUtils.loadMessageToString(folder, header), raw);
    return {
      key: header.messageKey,
      token: header.storeToken,
      size: header.messageSize,
      lines: header.lineCount,
      flags: header.flags,
      date: header.date,
      subject: `Retention message ${index}`,
      messageId: `retention-${index}@example.invalid`,
      note: index ? "keep this value" : "",
      raw,
    };
  });
}

/**
 * Check retained rows without replacing their identities, metadata or bodies.
 *
 * @param {nsIMsgLocalMailFolder} folder - Test folder.
 * @param {RetentionMessage[]} originals - Expected retained messages.
 */
function assertRetentionMessages(folder, originals) {
  Assert.deepEqual(
    folder.msgDatabase.listAllKeys().sort((a, b) => a - b),
    originals.map(original => original.key).sort((a, b) => a - b)
  );
  Assert.equal(folder.getTotalMessages(false), originals.length);
  for (const original of originals) {
    const header = folder.msgDatabase.getMsgHdrForKey(original.key);
    Assert.equal(header.storeToken, original.token);
    Assert.equal(header.messageSize, original.size);
    Assert.equal(header.lineCount, original.lines);
    Assert.equal(header.flags, original.flags);
    Assert.equal(header.date, original.date);
    Assert.equal(header.subject, original.subject);
    Assert.equal(header.messageId, original.messageId);
    Assert.ok(header.properties.includes("retention-note"));
    Assert.equal(header.getStringProperty("retention-note"), original.note);
    Assert.equal(header.numReferences, 3);
    Assert.deepEqual(
      Array.from({ length: header.numReferences }, (_, i) =>
        header.getStringReference(i)
      ),
      ["root@example.invalid", "parent@example.invalid", "root@example.invalid"]
    );
    Assert.equal(
      mailTestUtils.loadMessageToString(folder, header),
      original.raw
    );
  }
}

/**
 * Configure the public folder retention settings.
 *
 * @param {nsIMsgLocalMailFolder} folder - Test folder.
 * @param {boolean} byAge - Retain ten days instead of two messages.
 */
function setLocalRetention(folder, byAge) {
  const settings = folder.retentionSettings;
  settings.useServerDefaults = false;
  settings.applyToFlaggedMessages = true;
  settings.retainByPreference = byAge
    ? Ci.nsIMsgRetentionSettings.nsMsgRetainByAge
    : Ci.nsIMsgRetentionSettings.nsMsgRetainByNumHeaders;
  settings.daysToKeepHdrs = 10;
  settings.numHeadersToKeep = 2;
  folder.retentionSettings = settings;
}

/**
 * Apply count or age retention through UpdateFolder and check both stores.
 *
 * @param {string} store - Store type.
 * @param {boolean} byAge - Use age retention.
 */
async function checkLocalRetention(store, byAge) {
  await withRetentionFolder(store, async folder => {
    const originals = addRetentionMessages(folder);
    setLocalRetention(folder, byAge);
    folder.updateFolder(null);
    const removed = byAge ? originals.slice(0, 2) : originals.slice(0, 1);
    assertRetentionMessages(folder, originals.slice(removed.length));
    for (const original of removed) {
      Assert.ok(!folder.msgDatabase.containsKey(original.key));
      if (store == "maildir") {
        Assert.ok(
          !(await IOUtils.exists(
            PathUtils.join(folder.filePath.path, "cur", original.token)
          ))
        );
      }
    }
  });
}

add_task(async function test_localCountRetentionMbox() {
  await checkLocalRetention("mbox", false);
});

add_task(async function test_localCountRetentionMaildir() {
  await checkLocalRetention("maildir", false);
});

add_task(async function test_localAgeRetentionMbox() {
  await checkLocalRetention("mbox", true);
});

add_task(async function test_localAgeRetentionMaildir() {
  await checkLocalRetention("maildir", true);
});

/**
 * Preserve all messages when the actual pre-delete purge timestamp write fails.
 *
 * @param {string} store - Store type.
 */
async function checkLocalRetentionMetadataFailure(store) {
  await withRetentionFolder(store, async folder => {
    const originals = addRetentionMessages(folder);
    setLocalRetention(folder, false);
    const mbox =
      store == "mbox" ? await IOUtils.read(folder.filePath.path) : null;
    folder.setStringProperty("LastPurgeTime", "previous attempt");
    const connection = Cc["@mozilla.org/mailnews/database-core;1"].getService(
      Ci.nsIDatabaseCore
    ).connectionForTests;
    let faults = 0;
    connection.createFunction("local_retention_fault", 0, {
      onFunctionCall() {
        faults++;
        return 0;
      },
    });
    try {
      connection.executeSimpleSQL(
        "CREATE TEMP TRIGGER local_retention_fault BEFORE INSERT ON main.folder_properties " +
          `WHEN NEW.id = ${folder.id} AND NEW.name = 'LastPurgeTime' BEGIN ` +
          "SELECT local_retention_fault(); " +
          "SELECT RAISE(ABORT, 'Local retention metadata failed'); END"
      );
      Assert.throws(
        () => folder.updateFolder(null),
        error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
      );
      Assert.equal(faults, 1);
      assertRetentionMessages(folder, originals);
      Assert.equal(
        folder.getStringProperty("LastPurgeTime"),
        "previous attempt"
      );
      if (mbox) {
        Assert.deepEqual(await IOUtils.read(folder.filePath.path), mbox);
      }
    } finally {
      try {
        connection.executeSimpleSQL(
          "DROP TRIGGER IF EXISTS temp.local_retention_fault"
        );
      } finally {
        connection.removeFunction("local_retention_fault");
      }
    }
    folder.updateFolder(null);
    assertRetentionMessages(folder, originals.slice(1));
  });
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_localRetentionMetadataFailureMbox() {
    await checkLocalRetentionMetadataFailure("mbox");
  });

  add_task(async function test_localRetentionMetadataFailureMaildir() {
    await checkLocalRetentionMetadataFailure("maildir");
  });
}

add_task(async function test_localRetentionMaildirRemovalFailure() {
  await withRetentionFolder("maildir", async folder => {
    const originals = addRetentionMessages(folder);
    setLocalRetention(folder, false);
    const path = PathUtils.join(
      folder.filePath.path,
      "cur",
      originals[0].token
    );
    const staging = path + ".held";
    const held = PathUtils.join(path, "original");
    await IOUtils.move(path, staging, { noOverwrite: true });
    try {
      await IOUtils.makeDirectory(path);
      await IOUtils.move(staging, held, { noOverwrite: true });
      Assert.throws(
        () => folder.updateFolder(null),
        error => error.result == Cr.NS_ERROR_FILE_DIR_NOT_EMPTY
      );
      Assert.deepEqual(
        folder.msgDatabase.listAllKeys().sort((a, b) => a - b),
        originals.map(original => original.key).sort((a, b) => a - b)
      );
      const header = folder.msgDatabase.getMsgHdrForKey(originals[0].key);
      Assert.equal(header.storeToken, originals[0].token);
      Assert.equal(header.messageSize, originals[0].size);
      Assert.equal(await IOUtils.readUTF8(held), originals[0].raw);
      Assert.equal(
        mailTestUtils.loadMessageToString(
          folder,
          folder.msgDatabase.getMsgHdrForKey(originals[1].key)
        ),
        originals[1].raw
      );
      Assert.equal(
        mailTestUtils.loadMessageToString(
          folder,
          folder.msgDatabase.getMsgHdrForKey(originals[2].key)
        ),
        originals[2].raw
      );
    } finally {
      if (await IOUtils.exists(held)) {
        await IOUtils.move(held, staging, { noOverwrite: true });
      }
      const info = await IOUtils.stat(path).catch(() => null);
      if (info?.type == "directory") {
        await IOUtils.remove(path);
      }
      if (await IOUtils.exists(staging)) {
        await IOUtils.move(staging, path, { noOverwrite: true });
      }
    }
    assertRetentionMessages(folder, originals);
    folder.updateFolder(null);
    assertRetentionMessages(folder, originals.slice(1));
  });
});

/**
 * Reject a foreign physical identity before deleting an earlier valid member.
 *
 * @param {string} store - Store type.
 */
async function checkRetentionForeignIdentity(store) {
  await withRetentionFolder(store, async folder => {
    const originals = addRetentionMessages(folder);
    const other = localAccountUtils.rootFolder
      .createLocalSubfolder("other-retention-owner")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    Assert.equal(other.msgStore.storeType, store);
    Assert.equal(other.server.msgStore.storeType, store);
    const foreign = addRetentionMessages(other);
    Assert.throws(
      () =>
        folder.deleteMessages(
          [
            folder.msgDatabase.getMsgHdrForKey(originals[0].key),
            other.msgDatabase.getMsgHdrForKey(foreign[0].key),
          ],
          null,
          true,
          true,
          null,
          false
        ),
      error => error.result == Cr.NS_ERROR_ILLEGAL_VALUE
    );
    assertRetentionMessages(folder, originals);
    assertRetentionMessages(other, foreign);
  });
}

/**
 * Reject an active SQL transaction before a purge can remove provider bytes.
 *
 * @param {string} store - Store type.
 */
async function checkRetentionForeignTransaction(store) {
  await withRetentionFolder(store, async folder => {
    const originals = addRetentionMessages(folder);
    const headers = originals.map(original =>
      folder.msgDatabase.getMsgHdrForKey(original.key)
    );
    const mbox =
      store == "mbox" ? await IOUtils.read(folder.filePath.path) : null;
    const connection = Cc["@mozilla.org/mailnews/database-core;1"].getService(
      Ci.nsIDatabaseCore
    ).connectionForTests;
    connection.beginTransaction();
    try {
      Assert.throws(
        () => folder.deleteMessages(headers, null, true, true, null, false),
        error => error.result == Cr.NS_ERROR_IN_PROGRESS
      );
      Assert.ok(
        connection.transactionInProgress,
        "The caller owns its transaction"
      );
    } finally {
      connection.rollbackTransaction();
    }
    if (mbox) {
      Assert.deepEqual(await IOUtils.read(folder.filePath.path), mbox);
    } else {
      for (const original of originals) {
        Assert.equal(
          await IOUtils.readUTF8(
            PathUtils.join(folder.filePath.path, "cur", original.token)
          ),
          original.raw
        );
      }
    }
    assertRetentionMessages(folder, originals);
  });
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_localRetentionForeignIdentityMbox() {
    await checkRetentionForeignIdentity("mbox");
  });

  add_task(async function test_localRetentionForeignIdentityMaildir() {
    await checkRetentionForeignIdentity("maildir");
  });

  add_task(async function test_localRetentionForeignTransactionMbox() {
    await checkRetentionForeignTransaction("mbox");
  });

  add_task(async function test_localRetentionForeignTransactionMaildir() {
    await checkRetentionForeignTransaction("maildir");
  });
}

/**
 * Check a real first/later row-delete failure after retention selected its set.
 * The pre-existing timestamp fault does not reach this destructive boundary.
 *
 * @param {string} store - Native provider.
 * @param {number} failedIndex - Selected member whose DELETE must abort.
 * @returns {Promise<void>} The exact committed prefix and retry are checked.
 */
async function checkRetentionLateSQL(store, failedIndex) {
  await withRetentionFolder(store, async folder => {
    const originals = addRetentionMessages(folder);
    setLocalRetention(folder, true);
    const core = Cc["@mozilla.org/mailnews/database-core;1"].getService(
      Ci.nsIDatabaseCore
    );
    const connection = core.connectionForTests;
    let faults = 0;
    connection.createFunction("retention_row_fault", 0, {
      onFunctionCall() {
        faults++;
        return 0;
      },
    });
    try {
      connection.executeSimpleSQL(
        "CREATE TEMP TRIGGER retention_row_fault BEFORE DELETE ON main.messages " +
          `WHEN OLD.id = ${originals[failedIndex].key} BEGIN ` +
          "SELECT retention_row_fault(); " +
          "SELECT RAISE(ABORT, 'Selected retention member failed'); END"
      );
      Assert.throws(
        () => folder.updateFolder(null),
        error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
      );
      Assert.equal(faults, 1, "The selected row actually reached SQL DELETE");
      assertRetentionMessages(folder, originals.slice(failedIndex));
      Assert.equal(folder.getTotalMessages(false), 3 - failedIndex);
      Assert.throws(
        () => folder.msgStore.getNewMsgOutputStream(folder),
        error => error.result == Cr.NS_ERROR_IN_PROGRESS,
        "Pending custody prevents a new body from reusing physical storage"
      );
      Assert.throws(
        () =>
          folder.msgStore.asyncScan(
            folder,
            new PromiseTestUtils.PromiseStoreScanListener()
          ),
        error => error.result == Cr.NS_ERROR_IN_PROGRESS,
        "A scan cannot bypass pending native cleanup"
      );
    } finally {
      connection.executeSimpleSQL(
        "DROP TRIGGER IF EXISTS temp.retention_row_fault"
      );
      connection.removeFunction("retention_row_fault");
    }
    folder.updateFolder(null);
    assertRetentionMessages(folder, originals.slice(2));
    Assert.equal(folder.getTotalMessages(false), 1);
    folder.updateFolder(null);
    assertRetentionMessages(folder, originals.slice(2));
    const pending = PathUtils.join(
      do_get_profile().path,
      "panorama-purge",
      core.sourceId,
      String(folder.id)
    );
    Assert.ok(
      !(await IOUtils.exists(pending)),
      "Successful recovery released custody"
    );
  });
}

/**
 * Recover a failed purge after ordinary user flags change on its live member.
 *
 * @param {string} store - Native provider.
 * @returns {Promise<void>} Source custody, completion, later writes and retry settle.
 */
async function checkRetentionChangedFlags(store) {
  await withRetentionFolder(store, async folder => {
    const originals = addRetentionMessages(folder);
    const settings = folder.retentionSettings;
    settings.useServerDefaults = false;
    settings.retainByPreference = Ci.nsIMsgRetentionSettings.nsMsgRetainAll;
    folder.retentionSettings = settings;
    const survivor = folder.msgDatabase.getMsgHdrForKey(originals[1].key);
    folder.markMessagesRead([survivor], false);
    originals[1].flags = survivor.flags;
    const starts = [];
    const stops = [];
    const listener = {
      onStartCopy() {
        starts.push(true);
      },
      onStopCopy(status) {
        stops.push(status);
      },
      QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
    };
    const holder = localAccountUtils.rootFolder;
    folder.acquireSemaphore(holder, "test_retention_busy");
    try {
      Assert.throws(
        () =>
          folder.deleteMessages([survivor], null, true, false, listener, false),
        error => error.result == Cr.NS_MSG_FOLDER_BUSY
      );
      Assert.deepEqual(starts, []);
      Assert.deepEqual(stops, [Cr.NS_MSG_FOLDER_BUSY]);
      assertRetentionMessages(folder, originals);
    } finally {
      folder.releaseSemaphore(holder, "test_retention_busy");
    }
    const core = Cc["@mozilla.org/mailnews/database-core;1"].getService(
      Ci.nsIDatabaseCore
    );
    const pending = PathUtils.join(
      do_get_profile().path,
      "panorama-purge",
      core.sourceId,
      String(folder.id)
    );
    const connection = core.connectionForTests;
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER retention_changed_flags BEFORE DELETE ON main.messages " +
        `WHEN OLD.id = ${survivor.messageKey} BEGIN ` +
        "SELECT RAISE(ABORT, 'Later purge member failed'); END"
    );
    try {
      Assert.throws(
        () =>
          folder.deleteMessages(
            originals
              .slice(0, 2)
              .map(m => folder.msgDatabase.getMsgHdrForKey(m.key)),
            null,
            true,
            false,
            listener,
            false
          ),
        error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
      );
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER temp.retention_changed_flags");
    }
    Assert.deepEqual(starts, [true]);
    Assert.deepEqual(stops, [
      Cr.NS_MSG_FOLDER_BUSY,
      Cr.NS_ERROR_STORAGE_CONSTRAINT,
    ]);
    assertRetentionMessages(folder, originals.slice(1));
    Assert.ok(await IOUtils.exists(pending));
    Assert.throws(
      () => folder.markMessagesRead([survivor], true),
      error => error.result == Cr.NS_ERROR_IN_PROGRESS
    );
    Assert.throws(
      () => folder.markMessagesFlagged([survivor], true),
      error => error.result == Cr.NS_ERROR_IN_PROGRESS
    );
    Assert.ok(survivor.flags & Ci.nsMsgMessageFlags.Read);
    Assert.ok(survivor.flags & Ci.nsMsgMessageFlags.Marked);
    originals[1].flags = survivor.flags;
    folder.updateFolder(null);
    Assert.ok(!(await IOUtils.exists(pending)));
    assertRetentionMessages(folder, originals.slice(1));
    Assert.equal(stops.length, 2, "Recovery did not repeat either completion");
    folder.markMessagesRead([survivor], false);
    folder.markMessagesFlagged([survivor], false);
    Assert.ok(!(survivor.flags & Ci.nsMsgMessageFlags.Read));
    Assert.ok(!(survivor.flags & Ci.nsMsgMessageFlags.Marked));
    originals[1].flags = survivor.flags;
    assertRetentionMessages(folder, originals.slice(1));
    const delivered = folder.addMessage(originals[0].raw);
    Assert.notEqual(delivered.messageKey, originals[0].key);
    Assert.equal(
      mailTestUtils.loadMessageToString(folder, delivered),
      originals[0].raw
    );
    Assert.equal(folder.getTotalMessages(false), 3);
    folder.deleteMessages([survivor], null, true, false, listener, false);
    Assert.deepEqual(starts, [true, true]);
    Assert.deepEqual(stops, [
      Cr.NS_MSG_FOLDER_BUSY,
      Cr.NS_ERROR_STORAGE_CONSTRAINT,
      Cr.NS_OK,
    ]);
    Assert.deepEqual(folder.msgDatabase.listAllKeys(), [
      originals[2].key,
      delivered.messageKey,
    ]);
    Assert.equal(folder.getTotalMessages(false), 2);
    Assert.equal(
      mailTestUtils.loadMessageToString(
        folder,
        folder.msgDatabase.getMsgHdrForKey(originals[2].key)
      ),
      originals[2].raw
    );
    Assert.ok(!(await IOUtils.exists(pending)));
  });
}

/**
 * Fail physical cleanup only after the actual metadata DELETE has executed.
 * A synchronous SQL test function is needed to reach this exact boundary;
 * ordinary fixture setup would be rejected by the whole-input preflight.
 *
 * @param {string} store - Native provider.
 * @param {boolean} custodyFault - Fail recovery-file cleanup, not provider cleanup.
 * @returns {Promise<void>} Committed metadata, retained bytes and retry are checked.
 */
async function checkRetentionCleanupFailure(store, custodyFault) {
  await withRetentionFolder(store, async folder => {
    const originals = addRetentionMessages(folder);
    const core = Cc["@mozilla.org/mailnews/database-core;1"].getService(
      Ci.nsIDatabaseCore
    );
    const connection = core.connectionForTests;
    const pending = PathUtils.join(
      do_get_profile().path,
      "panorama-purge",
      core.sourceId,
      String(folder.id)
    );
    const blocked = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    let blockedPath;
    if (custodyFault) {
      blockedPath = PathUtils.join(pending, "occupied");
    } else if (store == "maildir") {
      blockedPath = PathUtils.join(
        folder.filePath.path,
        "cur",
        originals[0].token
      );
    } else {
      blockedPath = folder.filePath.path;
    }
    blocked.initWithPath(blockedPath);
    const heldName = blocked.leafName + ".retention-held";
    const held = blocked.clone();
    held.leafName = heldName;
    const sentinel = blocked.clone();
    sentinel.append("occupied");
    let faults = 0;
    connection.createFunction("retention_cleanup_fault", 0, {
      onFunctionCall() {
        faults++;
        if (custodyFault) {
          // An unexpected owned-directory entry prevents final custody cleanup
          // after the provider and metadata have both settled.
          blocked.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
          return 0;
        }
        // Preserve the real body, then force a genuine Remove(false)/open error.
        blocked.moveTo(null, heldName);
        blocked.leafName = heldName.slice(0, -".retention-held".length);
        blocked.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
        sentinel.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
        return 0;
      },
    });
    const starts = [];
    const stops = [];
    const listener = {
      onStartCopy() {
        starts.push(true);
        Assert.throws(
          () =>
            folder.deleteMessages(
              [folder.msgDatabase.getMsgHdrForKey(originals[1].key)],
              null,
              true,
              false,
              null,
              false
            ),
          error => error.result == Cr.NS_ERROR_IN_PROGRESS,
          "The accepted deletion rejects synchronous reentry"
        );
      },
      onStopCopy(status) {
        stops.push(status);
      },
      QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
    };
    try {
      connection.executeSimpleSQL(
        "CREATE TEMP TRIGGER retention_cleanup_fault AFTER DELETE ON main.messages " +
          `WHEN OLD.id = ${originals[0].key} BEGIN SELECT retention_cleanup_fault(); END`
      );
      let status;
      try {
        folder.deleteMessages(
          [folder.msgDatabase.getMsgHdrForKey(originals[0].key)],
          null,
          true,
          false,
          listener,
          false
        );
        Assert.ok(false, "The real cleanup fault must fail the operation");
      } catch (error) {
        status = error.result;
        Assert.ok(
          !Components.isSuccessCode(status),
          "The original cleanup returned a failure"
        );
      }
      Assert.equal(
        faults,
        1,
        "The physical fault followed the selected DELETE"
      );
      Assert.deepEqual(starts, [true]);
      Assert.deepEqual(
        stops,
        [status],
        "Original completion carries its first error once"
      );
      Assert.deepEqual(
        folder.msgDatabase.listAllKeys(),
        originals.slice(1).map(m => m.key)
      );
      Assert.equal(
        folder.getTotalMessages(false),
        2,
        "Metadata/count removal committed once"
      );
      Assert.ok(
        await IOUtils.exists(pending),
        "Unresolved physical custody remains explicit"
      );
      if (!custodyFault && store == "maildir") {
        Assert.equal(await IOUtils.readUTF8(held.path), originals[0].raw);
      }
    } finally {
      connection.executeSimpleSQL(
        "DROP TRIGGER IF EXISTS temp.retention_cleanup_fault"
      );
      connection.removeFunction("retention_cleanup_fault");
      if (custodyFault && blocked.exists()) {
        blocked.remove(false);
      } else if (held.exists()) {
        sentinel.remove(false);
        blocked.remove(false);
        held.moveTo(null, blocked.leafName);
      }
    }
    assertRetentionMessages(folder, originals.slice(1));
    Assert.throws(
      () => folder.msgStore.getNewMsgOutputStream(folder),
      error => error.result == Cr.NS_ERROR_IN_PROGRESS
    );
    folder.updateFolder(null);
    assertRetentionMessages(folder, originals.slice(1));
    Assert.equal(folder.getTotalMessages(false), 2);
    Assert.ok(!(await IOUtils.exists(pending)));
    Assert.deepEqual(
      stops.length,
      1,
      "Recovery never replays the original listener"
    );
    // Once cleanup is known to have settled, a normal later write is usable.
    const stream = folder.msgStore.getNewMsgOutputStream(folder);
    folder.msgStore.discardNewMessage(folder, stream);
  });
}

/**
 * Refuse a repeated physical member before any row, provider or callback mutation.
 *
 * @param {string} store - Native provider.
 * @returns {Promise<void>} The complete source and a later normal purge are checked.
 */
async function checkRetentionDuplicate(store) {
  await withRetentionFolder(store, async folder => {
    const originals = addRetentionMessages(folder);
    const header = folder.msgDatabase.getMsgHdrForKey(originals[0].key);
    Assert.throws(
      () =>
        folder.deleteMessages([header, header], null, true, false, null, false),
      error => error.result == Cr.NS_ERROR_ILLEGAL_VALUE
    );
    assertRetentionMessages(folder, originals);
    setLocalRetention(folder, false);
    folder.updateFolder(null);
    assertRetentionMessages(folder, originals.slice(1));
  });
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_localRetentionChangedFlagsMbox() {
    await checkRetentionChangedFlags("mbox");
  });
  add_task(async function test_localRetentionChangedFlagsMaildir() {
    await checkRetentionChangedFlags("maildir");
  });
  add_task(async function test_localRetentionFirstSQLFailureMbox() {
    await checkRetentionLateSQL("mbox", 0);
  });
  add_task(async function test_localRetentionLaterSQLFailureMbox() {
    await checkRetentionLateSQL("mbox", 1);
  });
  add_task(async function test_localRetentionFirstSQLFailureMaildir() {
    await checkRetentionLateSQL("maildir", 0);
  });
  add_task(async function test_localRetentionLaterSQLFailureMaildir() {
    await checkRetentionLateSQL("maildir", 1);
  });
  add_task(async function test_localRetentionProviderCleanupMbox() {
    await checkRetentionCleanupFailure("mbox", false);
  });
  add_task(async function test_localRetentionProviderCleanupMaildir() {
    await checkRetentionCleanupFailure("maildir", false);
  });
  add_task(async function test_localRetentionCustodyCleanupMbox() {
    await checkRetentionCleanupFailure("mbox", true);
  });
  add_task(async function test_localRetentionCustodyCleanupMaildir() {
    await checkRetentionCleanupFailure("maildir", true);
  });
  add_task(async function test_localRetentionDuplicateMbox() {
    await checkRetentionDuplicate("mbox");
  });
  add_task(async function test_localRetentionDuplicateMaildir() {
    await checkRetentionDuplicate("maildir");
  });
}

/**
 * Exercise the persisted committed prefix across two ordinary process lifetimes.
 *
 * @param {string} store - Native provider in both processes.
 * @returns {Promise<void>} Writer and recovery reader have exited normally.
 */
async function checkRetentionProcessRestart(store) {
  const { Subprocess } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs"
  );
  const resources = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler);
  const profilePath = PathUtils.join(
    do_get_profile().path,
    "retention-restart-" + store
  );
  await IOUtils.makeDirectory(profilePath);
  registerCleanupFunction(() =>
    IOUtils.remove(profilePath, { recursive: true })
  );
  for (const stage of ["write", "read"]) {
    const child = await Subprocess.call({
      command: Services.dirsvc.get("XREExeF", Ci.nsIFile).path,
      arguments: [
        "-g",
        Services.dirsvc.get("GreD", Ci.nsIFile).path,
        "-a",
        Services.dirsvc.get("XCurProcD", Ci.nsIFile).path,
        "-e",
        `const retentionRestartInput = ${JSON.stringify({
          stage,
          store,
          profilePath,
          prefsPath: _PREFS_FILE,
          testingCommon: resources.getSubstitution("testing-common").spec,
        })};`,
        "-f",
        do_get_file("data/localRetentionRecovery.js").path,
      ],
      stderr: "stdout",
    });
    let output = "";
    try {
      for (let chunk; (chunk = await child.stdout.readString()); ) {
        output += chunk;
      }
      const { exitCode } = await child.wait();
      Assert.equal(exitCode, 0, `${store} ${stage}: ${JSON.stringify(output)}`);
      Assert.ok(output.includes(`LOCAL-RETENTION-RESTART ${stage} PASS`));
    } finally {
      if (child.exitCode === null) {
        await child.kill();
      }
    }
  }
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_localRetentionProcessRestartMbox() {
    await checkRetentionProcessRestart("mbox");
  });
  add_task(async function test_localRetentionProcessRestartMaildir() {
    await checkRetentionProcessRestart("maildir");
  });
}
