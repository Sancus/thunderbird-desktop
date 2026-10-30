/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

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
