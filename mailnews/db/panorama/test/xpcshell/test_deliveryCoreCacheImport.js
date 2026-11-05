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
const { createMigrationBackup } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationBackup.sys.mjs"
);
const CLIENT_MASK = 0xa8000010;
const ORIGIN_PROPERTY = "panoramaCacheImportOrigin";
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
let originalBytes, controlKey, requestV2, proofBackup, originalControl;

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
  // Use the ordinary closed-profile backup helper before native discovery.
  // No origin rows or permission flags are inserted by this fixture.
  const oldNoCertDB = Services.prefs.getBoolPref("security.nocertdb", false);
  const hadNoCertDB = Services.prefs.prefHasUserValue("security.nocertdb");
  Services.prefs.setBoolPref("security.nocertdb", true);
  registerCleanupFunction(() => {
    if (hadNoCertDB) {
      Services.prefs.setBoolPref("security.nocertdb", oldNoCertDB);
    } else {
      Services.prefs.clearUserPref("security.nocertdb");
    }
  });
  work = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "native-cache-"
  );
  registerCleanupFunction(() => IOUtils.remove(work, { recursive: true }));
  const creator = new ProfileCreator(do_get_profile());
  const local = creator.addLocalServer();
  for (const name of ["Trash", "Unsent Messages"]) {
    await local.rootFolder.addMailFolder(name);
  }
  originalControl = await local.rootFolder.addMailFolder("cache-raw-control", {
    summary: do_get_file("data/migration.msf"),
    mbox: do_get_file("data/migration"),
  });
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
  originalBytes = await IOUtils.read(do_get_file("panacea.dat").path);
  const proofCache = PathUtils.join(do_get_profile().path, "panacea.dat");
  await IOUtils.write(proofCache, originalBytes, { mode: "create" });
  await IOUtils.computeHexDigest(proofCache, "sha256");
  if (AppConstants.platform != "win") {
    proofBackup = await createMigrationBackup(
      do_get_profile().path,
      [],
      PathUtils.join(work, "backup")
    );
  }
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
  const parsed = parseMorkFolderCache(originalBytes);
  const source = PathUtils.join(work, "panacea.dat");
  await IOUtils.write(source, originalBytes);
  observer = Services.storage.openUnsharedDatabase(
    new FileUtils.File(PathUtils.join(do_get_profile().path, "panorama.sqlite"))
  );
  registerCleanupFunction(() => observer.close());
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
  if (AppConstants.platform != "win") {
    requestV2 = structuredClone(request);
    requestV2.version = 2;
    requestV2.token = "cache-native-policy-2";
    requestV2.sourceId = "panacea-native-policy-2";
    requestV2.source = {
      path: canonicalFile(new FileUtils.File(proofCache)).path,
      size: originalBytes.length,
      sha256: await IOUtils.computeHexDigest(proofCache, "sha256"),
    };
    requestV2.proof = {
      profilePath: canonicalFile(do_get_profile()).path,
      manifest: {
        path: canonicalFile(new FileUtils.File(proofBackup.path)).path,
        size: (await IOUtils.stat(proofBackup.path)).size,
        sha256: proofBackup.sha256,
      },
    };
    for (const folder of requestV2.folders) {
      folder.originalSummaryPath = folder.isServer ? "" : folder.cachePath;
    }
  }
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

/**
 * Read exact typed SQL values through the independent committed observer.
 *
 * @param {string} sql - Fixed SELECT statement supplied by this test.
 * @returns {Array<Array<string|number|null>>} Rows in the SELECT's order.
 */
function cacheRows(sql) {
  const statement = observer.createStatement(sql);
  const rows = [];
  try {
    while (statement.executeStep()) {
      const row = [];
      for (let column = 0; column < statement.columnCount; column++) {
        const type = statement.getTypeOfIndex(column);
        if (type == Ci.mozIStorageValueArray.VALUE_TYPE_INTEGER) {
          row.push(statement.getInt64(column));
        } else if (type == Ci.mozIStorageValueArray.VALUE_TYPE_TEXT) {
          row.push(statement.getUTF8String(column));
        } else {
          Assert.equal(type, Ci.mozIStorageValueArray.VALUE_TYPE_NULL);
          row.push(null);
        }
      }
      rows.push(row);
    }
    return rows;
  } finally {
    statement.finalize();
  }
}

/**
 * Capture committed native rows and current public flags for rollback checks.
 *
 * @returns {object} Exact SQL and warm public state, including private history.
 */
function cacheState() {
  return {
    folders: cacheRows("SELECT id,parent,name,flags FROM folders ORDER BY id"),
    properties: cacheRows(
      "SELECT id,name,typeof(value),value FROM folder_properties ORDER BY id,name"
    ),
    receipts: cacheRows(
      "SELECT token,sourceId,path,identity,hex(raw),receipt FROM folder_cache_imports ORDER BY token"
    ),
    bindings: cacheRows(
      "SELECT folderId,token FROM folder_cache_bindings ORDER BY folderId"
    ),
    messages: cacheRows("SELECT id,folderId,subject FROM messages ORDER BY id"),
    warm: request.folders.map(f => folderDB.getMsgFolderForFolder(f.id).flags),
  };
}

/**
 * Assert an exact refusal with no failed return or mutation of retained state.
 *
 * @param {object} input - Existing native cache request.
 * @param {number} expected - Exact expected nsresult.
 */
function assertCacheRefusal(input, expected) {
  const before = cacheState();
  let output = "unpublished";
  Assert.throws(
    () => (output = database.importFolderCacheMetadata(input)),
    e => e.result == expected
  );
  Assert.equal(output, "unpublished");
  Assert.deepEqual(cacheState(), before);
  Assert.ok(!database.connectionForTests.transactionInProgress);
}

add_task(function test_v2UsesActualBirthAndKeepsOriginPrivate() {
  if (AppConstants.platform == "win") {
    return;
  }
  const generations = new Set();
  for (const folder of requestV2.folders) {
    const fields = scalar(
      `SELECT value FROM folder_properties WHERE id=${folder.id} AND name='${ORIGIN_PROPERTY}'`
    ).split("\n");
    Assert.equal(fields.length, 13);
    Assert.equal(fields[0], "1");
    Assert.equal(fields[1], database.sourceId);
    Assert.ok(fields[2], "Native discovery recorded a birth generation");
    generations.add(fields[2]);
    Assert.equal(Number(fields[3]), folder.id);
    Assert.equal(
      Number(fields[7]),
      0,
      "No public attempt is inferred from zero flags"
    );
    Assert.equal(Number(fields[9]), 0, "Every actual initial action completed");
    Assert.equal(Number(fields[11]), 0, "New adoption has not been committed");
    Assert.equal(fields[12], "end");
    if (!folder.isServer && folder.protocol == "imap") {
      Assert.equal(Number(fields[6]), 2);
      Assert.equal(Number(fields[10]) & 12, 12, "Both IMAP initial phases ran");
    }
    const info = folderDB.getMsgFolderForFolder(folder.id).msgDatabase
      .dBFolderInfo;
    Assert.ok(!info.GetTransferInfo().hasKey(ORIGIN_PROPERTY));
    for (const action of [
      () => info.getCharProperty(ORIGIN_PROPERTY),
      () => info.getUint32Property(ORIGIN_PROPERTY, 0),
      () => info.setCharProperty(ORIGIN_PROPERTY, "spoofed"),
      () => info.setUint32Property(ORIGIN_PROPERTY, 0),
    ]) {
      Assert.throws(action, e => e.result == Cr.NS_ERROR_INVALID_ARG);
    }
  }
  Assert.equal(generations.size, 1);
  Assert.equal(scalar("SELECT COUNT(*) FROM folder_cache_imports"), 0);
});

add_task(function test_v2RejectsChangedProofAndPublicInsertion() {
  if (AppConstants.platform == "win") {
    return;
  }
  for (const [change, expected] of [
    [
      r => (r.proof.manifest.sha256 = "0".repeat(64)),
      Cr.NS_ERROR_NOT_AVAILABLE,
    ],
    [r => (r.proof.profilePath += "-other"), Cr.NS_ERROR_NOT_AVAILABLE],
    [
      r => (r.folders.find(f => !f.isServer).originalSummaryPath += "-other"),
      Cr.NS_ERROR_INVALID_ARG,
    ],
  ]) {
    const invalid = structuredClone(requestV2);
    change(invalid);
    assertCacheRefusal(invalid, expected);
  }
  const id = folderDB.insertFolder(imapRoot.id, "public-cache-unknown");
  try {
    const actual = folderDB.getMsgFolderForFolder(id);
    Assert.strictEqual(
      scalar(
        `SELECT value FROM folder_properties WHERE id=${id} AND name='${ORIGIN_PROPERTY}'`
      ),
      null,
      "An ordinary public insert never manufactures origin"
    );
    const invalid = structuredClone(requestV2);
    const folder = invalid.folders.find(f =>
      f.originalKey.endsWith("INBOX.msf")
    );
    const summary = canonicalFile(actual.summaryFile);
    folder.id = id;
    folder.cachePath = summary.path;
    folder.originalSummaryPath = summary.path;
    folder.storePath = canonicalFile(actual.filePath).path;
    folder.descriptor = new TextDecoder("utf-8", { fatal: true }).decode(
      MailStringUtils.byteStringToUint8Array(summary.persistentDescriptor)
    );
    assertCacheRefusal(invalid, Cr.NS_ERROR_NOT_AVAILABLE);
  } finally {
    folderDB.deleteFolder(id);
  }
});

add_task(function test_v2RefusesMissingCorruptOrStaleNativeOrigin() {
  if (AppConstants.platform == "win") {
    return;
  }
  const id = imapRoot.getChildNamed("INBOX").id;
  const original = scalar(
    `SELECT value FROM folder_properties WHERE id=${id} AND name='${ORIGIN_PROPERTY}'`
  );
  const baseline = cacheState();
  const connection = database.connectionForTests;
  const write = value => {
    const statement = connection.createStatement(
      `INSERT OR REPLACE INTO folder_properties(id,name,value) VALUES(${id},'${ORIGIN_PROPERTY}',:value)`
    );
    try {
      statement.params.value = value;
      statement.execute();
    } finally {
      statement.finalize();
    }
  };
  const changed = (field, value) => {
    const fields = original.split("\n");
    fields[field] = value;
    return fields.join("\n");
  };
  for (const [value, expected] of [
    [null, Cr.NS_ERROR_NOT_AVAILABLE],
    [0, Cr.NS_ERROR_FILE_CORRUPTED],
    ["broken", Cr.NS_ERROR_FILE_CORRUPTED],
    [changed(1, database.sourceId + "-other"), Cr.NS_ERROR_NOT_AVAILABLE],
    [changed(2, "earlier-generation"), Cr.NS_ERROR_NOT_AVAILABLE],
    [changed(8, "0"), Cr.NS_ERROR_FILE_CORRUPTED],
    [changed(9, "3"), Cr.NS_ERROR_NOT_AVAILABLE],
    [changed(10, "4"), Cr.NS_ERROR_NOT_AVAILABLE],
  ]) {
    if (value === null) {
      connection.executeSimpleSQL(
        `DELETE FROM folder_properties WHERE id=${id} AND name='${ORIGIN_PROPERTY}'`
      );
    } else {
      write(value);
    }
    try {
      assertCacheRefusal(requestV2, expected);
    } finally {
      // Restore only the exact genuine datum retained before this SQL fault.
      // Publicly inserted unknown rows above never receive a test-seeded grant.
      write(original);
    }
    Assert.deepEqual(cacheState(), baseline);
  }
});

add_task(function test_v2ProjectionRollbackPreservesExplicitAndPendingZero() {
  if (AppConstants.platform == "win") {
    return;
  }
  const inbox = imapRoot.getChildNamed("INBOX");
  const explicit = imapRoot.getChildNamed("blah");
  const explicitBefore = explicit.flags;
  // Equal-word native writes still veto the entire client mask.
  folderDB.updateFlags(explicit.id, explicitBefore);
  Assert.equal(
    Number(
      scalar(
        `SELECT value FROM folder_properties WHERE id=${explicit.id} AND name='${ORIGIN_PROPERTY}'`
      ).split("\n")[7]
    ),
    CLIENT_MASK
  );
  const info = inbox.msgDatabase.dBFolderInfo;
  info.setUint32Property("totPendingMsgs", 0);
  info.setUint32Property("unreadPendingMsgs", 0);
  info.setCharProperty("MRUTime", "");
  const flags = ((inbox.flags & ~CLIENT_MASK) | 0x88000010) >>> 0;
  Assert.equal((flags & CLIENT_MASK) >>> 0, 0x88000010);
  const connection = database.connectionForTests;
  // This fault is reached only after the exact allowed projection, preserved
  // explicit word and typed pending zero are visible in the owning SQL TX.
  connection.executeSimpleSQL(`
    CREATE TEMP TRIGGER reject_checked_projection AFTER INSERT ON folder_cache_imports
    WHEN (SELECT flags FROM folders WHERE id=${inbox.id})=${flags}
      AND (SELECT flags FROM folders WHERE id=${explicit.id})=${explicitBefore}
      AND (SELECT value FROM folder_properties WHERE id=${inbox.id} AND name='totPendingMsgs')=0
      AND (SELECT typeof(value) FROM folder_properties WHERE id=${inbox.id} AND name='totPendingMsgs')='integer'
      AND (SELECT value FROM folder_properties WHERE id=${inbox.id} AND name='MRUTime')=''
      AND (SELECT COUNT(*) FROM messages WHERE folderId=${inbox.id})=1
    BEGIN SELECT RAISE(ABORT,'checked native projection fault'); END;
  `);
  try {
    assertCacheRefusal(requestV2, Cr.NS_ERROR_STORAGE_CONSTRAINT);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_checked_projection");
  }
  for (const table of ["folder_cache_imports", "folder_cache_bindings"]) {
    connection.executeSimpleSQL(`
      CREATE TEMP TRIGGER reject_v2_write BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(ABORT,'native projection write fault'); END;
    `);
    try {
      assertCacheRefusal(requestV2, Cr.NS_ERROR_STORAGE_CONSTRAINT);
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER reject_v2_write");
    }
  }
});

add_task(function test_v2ReadbackRejectsChangedFlagsReceiptAndBindings() {
  if (AppConstants.platform == "win") {
    return;
  }
  const inbox = imapRoot.getChildNamed("INBOX");
  const connection = database.connectionForTests;
  for (const mutation of [
    `UPDATE folders SET flags=CASE WHEN (flags & 16)=0 THEN flags+16 ELSE flags-16 END WHERE id=${inbox.id}`,
    "UPDATE folder_cache_imports SET receipt='{}' WHERE token=NEW.token",
    "UPDATE folder_cache_imports SET raw=x'00' WHERE token=NEW.token",
    "DELETE FROM folder_cache_bindings WHERE folderId=NEW.folderId",
  ]) {
    const table = mutation.startsWith("DELETE")
      ? "folder_cache_bindings"
      : "folder_cache_imports";
    connection.executeSimpleSQL(`
      CREATE TEMP TRIGGER corrupt_v2_readback AFTER INSERT ON ${table}
      BEGIN ${mutation}; END;
    `);
    try {
      assertCacheRefusal(requestV2, Cr.NS_ERROR_FILE_CORRUPTED);
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER corrupt_v2_readback");
    }
  }
});

add_task(async function test_v2RetainsRawSourceAndRefusesChangedCache() {
  if (AppConstants.platform == "win") {
    return;
  }
  const before = await IOUtils.read(requestV2.source.path);
  const changed = before.slice();
  changed[0] ^= 1;
  await IOUtils.write(requestV2.source.path, changed);
  try {
    assertCacheRefusal(requestV2, Cr.NS_ERROR_NOT_AVAILABLE);
  } finally {
    await IOUtils.write(requestV2.source.path, before);
  }
  for (const [path, fixture] of [
    [originalControl.summaryFilePath, "data/migration.msf"],
    [originalControl.mailFilePath, "data/migration"],
  ]) {
    Assert.deepEqual(
      await IOUtils.read(path),
      await IOUtils.read(do_get_file(fixture).path)
    );
  }
  Assert.deepEqual(await IOUtils.read(requestV2.source.path), originalBytes);
  Assert.equal(scalar("SELECT COUNT(*) FROM folder_cache_imports"), 0);
  Assert.equal(scalar("SELECT COUNT(*) FROM folder_cache_bindings"), 0);
});

add_task(function test_v2ForeignFlagAttemptDoesNotOwnCallerTransaction() {
  if (AppConstants.platform == "win") {
    return;
  }
  const inbox = imapRoot.getChildNamed("INBOX");
  const before = cacheState();
  const connection = database.connectionForTests;
  connection.beginTransaction();
  try {
    connection.executeSimpleSQL(
      `INSERT INTO folder_properties(id,name,value) VALUES(${inbox.id},'caller-owned-marker','uncommitted')`
    );
    Assert.throws(
      () => folderDB.updateFlags(inbox.id, inbox.flags),
      e => e.result == Cr.NS_ERROR_IN_PROGRESS
    );
    Assert.ok(connection.transactionInProgress);
    Assert.strictEqual(
      scalar(
        `SELECT value FROM folder_properties WHERE id=${inbox.id} AND name='caller-owned-marker'`
      ),
      null
    );
    Assert.equal(
      scalar(
        `SELECT value FROM folder_properties WHERE id=${inbox.id} AND name='caller-owned-marker'`,
        connection
      ),
      "uncommitted",
      "Only the caller owns its pending SQL and rollback"
    );
  } finally {
    connection.rollbackTransaction();
  }
  Assert.deepEqual(cacheState(), before);
});

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
  const trash = localRoot.getChildNamed("Trash");
  Assert.strictEqual(
    scalar(
      `SELECT value FROM folder_properties WHERE id=${trash.id} AND name='MRUTime'`
    ),
    null,
    "The cache-only MRUTime starts without a native value"
  );
  // A pre-existing empty value is authoritative, independently of cache text.
  inbox.msgDatabase.dBFolderInfo.setCharProperty("onlineName", "");
  inbox.msgDatabase.dBFolderInfo.setCharProperty("MRUTime", "1700000000");
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
    "1700000000",
    "The native MRUTime remains authoritative over the cache"
  );
  const nativeMRU = receipt.cells.find(
    cell => cell.id == inbox.id && cell.name == "MRUTime"
  );
  Assert.ok(nativeMRU, "The receipt includes the native MRUTime cell");
  Assert.equal(nativeMRU.text, "1628202593");
  Assert.equal(nativeMRU.disposition, "existing");
  Assert.strictEqual(
    scalar(
      `SELECT value FROM folder_properties WHERE id=${trash.id} AND name='MRUTime'`
    ),
    "1628202569",
    "The cache fills an absent native MRUTime"
  );
  const appliedMRU = receipt.cells.find(
    cell => cell.id == trash.id && cell.name == "MRUTime"
  );
  Assert.ok(appliedMRU, "The receipt includes the applied MRUTime cell");
  Assert.equal(appliedMRU.text, "1628202569");
  Assert.equal(appliedMRU.disposition, "applied");
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
