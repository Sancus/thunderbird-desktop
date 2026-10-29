/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
const { MailStringUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailStringUtils.sys.mjs"
);
const { ProfileCreator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ProfileCreator.sys.mjs"
);
const { parseMorkFolderCache } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MorkFolderCache.sys.mjs"
);
const OLD_ROOT = "/foo/bar/profile-default/";
const IMAP_NAMES = [
  "Archives",
  "Drafts",
  "INBOX",
  "Junk",
  "Sent",
  "Templates",
  "Trash",
  "blah",
  "foo",
];
let work, request, observer, localRoot, imapRoot;
let originalBytes, controlKey;

/**
 * Build the same canonical descriptor used by the native receiver.
 *
 * @param {nsIFile} file - Existing file, or missing leaf with an existing parent.
 * @returns {nsIFile} Canonical clone; never changes the folder's own file object.
 */
function canonicalFile(file) {
  const copy = file.clone();
  if (copy.exists()) {
    Assert.ok(!copy.isSymlink());
    copy.normalize();
    return copy;
  }
  const parent = copy.parent;
  parent.normalize();
  parent.append(copy.leafName);
  return parent;
}

add_setup(async function setupPhysicalCacheMappings() {
  const creator = new ProfileCreator(do_get_profile());
  const local = creator.addLocalServer();
  for (const name of ["Trash", "Unsent Messages"]) {
    await local.rootFolder.addMailFolder(name);
  }
  const imapServer = creator.addServer("cache", "cache.invalid", "imap");
  const directory = do_get_profile();
  directory.append("native-cache-\u90ae\u4ef6-e\u0301");
  await IOUtils.makeDirectory(directory.path);
  imapServer.prefBranch.setStringPref(
    "directory-rel",
    "[ProfD]" + directory.leafName
  );
  Services.prefs.savePrefFile(
    new FileUtils.File(PathUtils.join(do_get_profile().path, "prefs.js"))
  );
  loadExistingDB();
  MailServices.accounts.accounts;
  localRoot = MailServices.accounts.localFoldersServer.rootFolder;
  imapRoot = MailServices.accounts.allServers.find(
    s => s.type == "imap"
  ).rootFolder;
  const imap = imapRoot.QueryInterface(Ci.nsIMsgImapMailFolder);
  for (const name of IMAP_NAMES) {
    imap.createClientSubfolderInfo(name, "/", 0, true);
  }
  const bindings = new Map([
    [OLD_ROOT + "Mail/Local Folders", localRoot],
    [OLD_ROOT + "ImapMail/imap.localhost", imapRoot],
  ]);
  for (const [names, root, original] of [
    [["Trash", "Unsent Messages"], localRoot, "Mail/Local Folders/"],
    [IMAP_NAMES, imapRoot, "ImapMail/imap.localhost/"],
  ]) {
    for (const name of names) {
      bindings.set(
        OLD_ROOT + original + name + ".msf",
        root.getChildNamed(name)
      );
    }
  }
  originalBytes = await IOUtils.read(do_get_file("panacea.dat").path);
  const parsed = parseMorkFolderCache(originalBytes);
  work = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "native-cache-"
  );
  const source = PathUtils.join(work, "panacea.dat");
  await IOUtils.write(source, originalBytes);
  observer = Services.storage.openUnsharedDatabase(
    new FileUtils.File(PathUtils.join(do_get_profile().path, "panorama.sqlite"))
  );
  registerCleanupFunction(async () => {
    observer.close();
    await IOUtils.remove(work, { recursive: true });
  });
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  request = {
    version: 1,
    token: "cache-unit-1",
    sourceId: "panacea-source-1",
    databaseSourceId: database.sourceId,
    source: {
      path: canonicalFile(new FileUtils.File(source)).path,
      size: originalBytes.length,
      sha256: await IOUtils.computeHexDigest(source, "sha256"),
    },
    folders: [...bindings].map(([originalKey, folder]) => {
      const cache = canonicalFile(
        folder.isServer ? folder.filePath : folder.summaryFile
      );
      return {
        originalKey,
        sourceKey: parsed.entries.get(originalKey).sourceKey,
        id: folder.id,
        isServer: folder.isServer,
        descriptor: decoder.decode(
          MailStringUtils.byteStringToUint8Array(cache.persistentDescriptor)
        ),
        cachePath: cache.path,
        storePath: canonicalFile(folder.filePath).path,
        protocol: folder.incomingServerType,
        storeType: folder.msgStore.storeType,
      };
    }),
  };
  Assert.equal(request.folders.length, 13);
  controlKey = messageDB.addMessage(
    imapRoot.getChildNamed("INBOX").id,
    "cache-control@invalid",
    [],
    0,
    "",
    "",
    "",
    "",
    "Retained physical message",
    0,
    "",
    0
  );
});

/**
 * Read committed state through a different connection, independent of folders.
 *
 * @param {string} sql - A scalar SELECT with no caller-provided fragments.
 * @param {mozIStorageConnection} [connection] - Committed observer or core.
 * @returns {string|number|null} First SQL column, or null for an absent row.
 */
function scalar(sql, connection = observer) {
  const statement = connection.createStatement(sql);
  try {
    if (!statement.executeStep()) {
      return null;
    }
    switch (statement.getTypeOfIndex(0)) {
      case Ci.mozIStorageValueArray.VALUE_TYPE_INTEGER:
        return statement.getInt64(0);
      case Ci.mozIStorageValueArray.VALUE_TYPE_TEXT:
        return statement.getUTF8String(0);
      case Ci.mozIStorageValueArray.VALUE_TYPE_NULL:
        return null;
      default:
        throw new Error("Unexpected scalar SQL type");
    }
  } finally {
    statement.finalize();
  }
}

add_task(function test_rejectsIncompleteOrChangedIdentityBeforeWrites() {
  if (AppConstants.platform == "win") {
    Assert.throws(
      () => database.importFolderCacheMetadata(request),
      e => e.result == Cr.NS_ERROR_NOT_AVAILABLE
    );
    Assert.throws(
      () => database.getFolderCacheImportReceipt(request),
      e => e.result == Cr.NS_ERROR_NOT_AVAILABLE
    );
    return;
  }
  Assert.strictEqual(database.getFolderCacheImportReceipt(request), null);
  for (const [change, expected] of [
    [r => r.folders.pop(), Cr.NS_ERROR_NOT_IMPLEMENTED],
    [r => (r.folders[1].id = r.folders[0].id), Cr.NS_ERROR_INVALID_ARG],
    [
      r => (r.folders[1].descriptor = r.folders[0].descriptor),
      Cr.NS_ERROR_INVALID_ARG,
    ],
    [
      r => (r.folders[1].storePath = r.folders[0].storePath),
      Cr.NS_ERROR_INVALID_ARG,
    ],
    [r => (r.folders[0].id = 9007199254740991), Cr.NS_ERROR_NOT_AVAILABLE],
    [r => (r.folders[0].sourceKey += 100), Cr.NS_ERROR_INVALID_ARG],
    [r => (r.folders[0].descriptor += "-wrong"), Cr.NS_ERROR_NOT_AVAILABLE],
    [r => (r.databaseSourceId += "-wrong"), Cr.NS_ERROR_NOT_AVAILABLE],
    [r => (r.source.sha256 = "0".repeat(64)), Cr.NS_ERROR_NOT_AVAILABLE],
  ]) {
    const invalid = structuredClone(request);
    change(invalid);
    Assert.throws(
      () => database.importFolderCacheMetadata(invalid),
      e => e.result == expected
    );
    Assert.equal(scalar("SELECT COUNT(*) FROM folder_cache_imports"), 0);
  }
});

add_task(function test_propagatesSQLReadFailureWithoutWriting() {
  if (AppConstants.platform == "win") {
    return;
  }
  const connection = database.connectionForTests;
  const id = imapRoot.getChildNamed("INBOX").id;
  connection.executeSimpleSQL(`
    INSERT INTO folder_properties VALUES(${id},'cache-read-fault','kept');
    CREATE TEMP VIEW folder_properties AS
      SELECT id,name,CASE WHEN name='cache-read-fault'
        THEN abs(-9223372036854775808) ELSE value END AS value
      FROM main.folder_properties;
  `);
  try {
    Assert.throws(
      () => database.importFolderCacheMetadata(request),
      e => e.result == Cr.NS_ERROR_FAILURE
    );
    Assert.equal(scalar("SELECT COUNT(*) FROM folder_cache_imports"), 0);
    Assert.ok(!connection.transactionInProgress);
  } finally {
    connection.executeSimpleSQL("DROP VIEW temp.folder_properties");
  }
  Assert.equal(
    scalar(
      `SELECT value FROM folder_properties WHERE id=${id} AND name='cache-read-fault'`
    ),
    "kept"
  );
});

add_task(function test_rollsBackMetadataAndReceiptTogether() {
  if (AppConstants.platform == "win") {
    return;
  }
  const before = scalar("SELECT COUNT(*) FROM folder_properties");
  for (const table of ["folder_cache_imports", "folder_cache_bindings"]) {
    database.connectionForTests.executeSimpleSQL(`
      CREATE TEMP TRIGGER reject_cache_write BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(ABORT,'cache write failure'); END;
    `);
    try {
      Assert.throws(
        () => database.importFolderCacheMetadata(request),
        e => e.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
      );
      Assert.equal(scalar("SELECT COUNT(*) FROM folder_properties"), before);
      Assert.equal(scalar("SELECT COUNT(*) FROM folder_cache_imports"), 0);
      Assert.equal(scalar("SELECT COUNT(*) FROM folder_cache_bindings"), 0);
      Assert.ok(!database.connectionForTests.transactionInProgress);
    } finally {
      database.connectionForTests.executeSimpleSQL(
        "DROP TRIGGER reject_cache_write"
      );
    }
  }
  database.connectionForTests.beginTransaction();
  try {
    Assert.throws(
      () => database.importFolderCacheMetadata(request),
      e => e.result == Cr.NS_ERROR_IN_PROGRESS
    );
    Assert.throws(
      () => database.getFolderCacheImportReceipt(request),
      e => e.result == Cr.NS_ERROR_IN_PROGRESS
    );
    Assert.ok(database.connectionForTests.transactionInProgress);
  } finally {
    database.connectionForTests.rollbackTransaction();
  }
});

add_task(async function test_appliesMetadataAndRetainsNativeAuthority() {
  if (AppConstants.platform == "win") {
    return;
  }
  const inbox = imapRoot.getChildNamed("INBOX");
  // A pre-existing empty value is authoritative, independently of cache text.
  inbox.msgDatabase.dBFolderInfo.setCharProperty("onlineName", "");
  Assert.strictEqual(
    scalar(
      `SELECT value FROM folder_properties WHERE id=${inbox.id} AND name='onlineName'`
    ),
    ""
  );
  const flags = request.folders.map(f =>
    scalar(`SELECT flags FROM folders WHERE id=${f.id}`)
  );
  const names = request.folders.map(f =>
    scalar(`SELECT name FROM folders WHERE id=${f.id}`)
  );
  const receipt = database.importFolderCacheMetadata(request);
  Assert.equal(receipt.identity.policy, "native-authoritative-v1");
  Assert.equal(receipt.identity.folders.length, 13);
  Assert.strictEqual(
    receipt.identity.folders.find(f => f.id == localRoot.id).isServer,
    true
  );
  Assert.strictEqual(
    receipt.identity.folders.find(f => f.id == inbox.id).isServer,
    false
  );
  Assert.equal(scalar("SELECT COUNT(*) FROM folder_cache_bindings"), 13);
  Assert.equal(scalar("SELECT COUNT(*) FROM folder_cache_imports"), 1);
  Assert.equal(scalar("SELECT COUNT(*) FROM messages"), 1);
  Assert.equal(
    scalar(`SELECT subject FROM messages WHERE id=${controlKey}`),
    "Retained physical message"
  );
  Assert.equal(
    scalar(`SELECT COUNT(*) FROM messages WHERE folderId=${inbox.id}`),
    1
  );
  Assert.deepEqual(
    request.folders.map(f =>
      scalar(`SELECT flags FROM folders WHERE id=${f.id}`)
    ),
    flags
  );
  Assert.deepEqual(
    request.folders.map(f =>
      scalar(`SELECT name FROM folders WHERE id=${f.id}`)
    ),
    names
  );
  Assert.strictEqual(
    scalar(
      `SELECT value FROM folder_properties WHERE id=${inbox.id} AND name='onlineName'`
    ),
    ""
  );
  Assert.strictEqual(
    scalar(
      `SELECT value FROM folder_properties WHERE id=${inbox.id} AND name='MRUTime'`
    ),
    "1628202593"
  );
  Assert.strictEqual(
    scalar(
      `SELECT typeof(value) FROM folder_properties WHERE id=${inbox.id} AND name='MRUTime'`
    ),
    "text"
  );
  Assert.strictEqual(
    scalar(
      `SELECT value FROM folder_properties WHERE id=${inbox.id} AND name='boxFlags'`
    ),
    0x200040
  );
  Assert.strictEqual(
    scalar(
      `SELECT value FROM folder_properties WHERE id=${imapRoot.id} AND name='onlineName'`
    ),
    ""
  );
  Assert.strictEqual(
    scalar(
      `SELECT value FROM folder_properties WHERE id=${localRoot.id} AND name='folderSize'`
    ),
    null
  );
  const count = receipt.cells.find(
    c => c.id == localRoot.id && c.name == "totalMsgs"
  );
  Assert.equal(count.text, "ffffffff");
  Assert.equal(count.integer, -1);
  Assert.equal(count.disposition, "native-authoritative");
  const display = receipt.cells.find(
    c => c.text == "Outbox" && c.name == "folderName"
  );
  Assert.equal(display.disposition, "native-authoritative");
  Assert.ok(
    receipt.cells.some(
      c => c.id == imapRoot.id && c.name == "onlineName" && c.text === ""
    )
  );
  Assert.deepEqual(await IOUtils.read(request.source.path), originalBytes);
  const raw = observer.createStatement("SELECT raw FROM folder_cache_imports");
  try {
    Assert.ok(raw.executeStep());
    const size = {},
      bytes = {};
    raw.getBlob(0, size, bytes);
    Assert.equal(size.value, originalBytes.length);
    Assert.deepEqual(new Uint8Array(bytes.value), originalBytes);
  } finally {
    raw.finalize();
  }
});

add_task(async function test_retryAndLookupAreReadOnlyAndRejectRebinding() {
  if (AppConstants.platform == "win") {
    return;
  }
  const inbox = imapRoot.getChildNamed("INBOX");
  inbox.msgDatabase.dBFolderInfo.setCharProperty(
    "MRUTime",
    "later native value"
  );
  Assert.equal(
    scalar(
      `SELECT value FROM folder_properties WHERE id=${inbox.id} AND name='MRUTime'`
    ),
    "later native value"
  );
  const before = scalar("SELECT receipt FROM folder_cache_imports");
  const writes = scalar("SELECT total_changes()", database.connectionForTests);
  const receipt = database.getFolderCacheImportReceipt(request);
  const reversed = structuredClone(request);
  reversed.folders.reverse();
  Assert.deepEqual(database.importFolderCacheMetadata(reversed), receipt);
  Assert.equal(
    scalar("SELECT total_changes()", database.connectionForTests),
    writes
  );
  Assert.equal(scalar("SELECT receipt FROM folder_cache_imports"), before);
  for (const change of [
    r => (r.sourceId += "changed"),
    r => (r.token += "changed"),
    r => (r.source.sha256 = "0".repeat(64)),
    r => (r.folders[0].originalKey += "changed"),
  ]) {
    const changed = structuredClone(request);
    change(changed);
    Assert.throws(
      () => database.importFolderCacheMetadata(changed),
      e => e.result == Cr.NS_ERROR_ALREADY_INITIALIZED
    );
    Assert.throws(
      () => database.getFolderCacheImportReceipt(changed),
      e => e.result == Cr.NS_ERROR_ALREADY_INITIALIZED
    );
  }
  Assert.equal(
    scalar(
      `SELECT value FROM folder_properties WHERE id=${inbox.id} AND name='MRUTime'`
    ),
    "later native value"
  );
  const restored = structuredClone(request);
  const restoredPath = PathUtils.join(work, "restored-panacea.dat");
  await IOUtils.write(restoredPath, originalBytes);
  restored.source.path = canonicalFile(new FileUtils.File(restoredPath)).path;
  restored.token += "-restored";
  restored.sourceId += "-restored";
  Assert.throws(
    () => database.importFolderCacheMetadata(restored),
    e => e.result == Cr.NS_ERROR_ALREADY_INITIALIZED
  );
  Assert.throws(
    () => database.getFolderCacheImportReceipt(restored),
    e => e.result == Cr.NS_ERROR_ALREADY_INITIALIZED
  );
  Assert.equal(scalar("SELECT COUNT(*) FROM folder_cache_imports"), 1);
  Assert.equal(scalar("SELECT COUNT(*) FROM folder_cache_bindings"), 13);
  const changedBytes = originalBytes.slice();
  changedBytes[0] ^= 1;
  await IOUtils.write(request.source.path, changedBytes);
  try {
    Assert.throws(
      () => database.importFolderCacheMetadata(request),
      e => e.result == Cr.NS_ERROR_NOT_AVAILABLE
    );
    Assert.deepEqual(
      database.getFolderCacheImportReceipt(request),
      receipt,
      "Identity-only lookup remains available; import rechecks source bytes"
    );
    Assert.equal(scalar("SELECT receipt FROM folder_cache_imports"), before);
  } finally {
    await IOUtils.write(request.source.path, originalBytes);
  }
  // The ordinary unshared SQL reader can be closed/reopened without altering
  // receipts; this is persistence evidence, not a process-restart claim.
  observer.close();
  observer = Services.storage.openUnsharedDatabase(
    new FileUtils.File(PathUtils.join(do_get_profile().path, "panorama.sqlite"))
  );
  Assert.equal(scalar("SELECT receipt FROM folder_cache_imports"), before);
});
