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
const { parseMorkSummary } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MorkSummaryReader.sys.mjs"
);
const { readLegacyGlodaMail, mapLegacyGlodaMail } = ChromeUtils.importESModule(
  "resource:///modules/panorama/LegacyGlodaMailReader.sys.mjs"
);

/**
 * Creates a schema-layout unit input from GlodaDatastore schema30's literal DDL.
 * This is not a frozen legacy-producer fixture or a Gloda parity test.
 *
 * @param {string} name - Unique test database name.
 * @param {string} [changes=""] - Deliberate layout/data changes before close.
 * @returns {string} Closed rollback-journal database path.
 */
function createMailInput(name, changes = "") {
  const file = do_get_profile().clone();
  file.append("legacy-mail-" + name + ".sqlite");
  Assert.ok(!file.exists());
  const connection = Services.storage.openDatabase(file);
  try {
    Assert.equal(connection.databaseFile.path, file.path);
    Cc["@mozilla.org/messenger/fts3tokenizer;1"]
      .getService(Ci.nsIFts3Tokenizer)
      .registerTokenizer(connection);
    connection.executeSimpleSQL(`
      PRAGMA journal_mode=DELETE;
      PRAGMA user_version=30;
      CREATE TABLE folderLocations (id INTEGER PRIMARY KEY, folderURI TEXT NOT NULL,
        dirtyStatus INTEGER NOT NULL, name TEXT NOT NULL, indexingPriority INTEGER NOT NULL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, folderID INTEGER, messageKey INTEGER,
        conversationID INTEGER NOT NULL, date INTEGER, headerMessageID TEXT,
        deleted INTEGER NOT NULL default 0, jsonAttributes TEXT,
        notability INTEGER NOT NULL default 0);
      CREATE TABLE attributeDefinitions (id INTEGER PRIMARY KEY, attributeType INTEGER NOT NULL,
        extensionName TEXT NOT NULL, name TEXT NOT NULL, parameter BLOB);
      CREATE TABLE messageAttributes (conversationID INTEGER NOT NULL, messageID INTEGER NOT NULL,
        attributeID INTEGER NOT NULL, value NUMERIC);
      CREATE VIRTUAL TABLE messagesText USING fts3(tokenize mozporter, body TEXT,
        subject TEXT, attachmentNames TEXT, author TEXT, recipients TEXT);
      CREATE TABLE extensionData (value TEXT);
      INSERT INTO folderLocations VALUES (7,'mailbox://old/Inbox',0,'Inbox',0),
        (8,'mailbox://old/Copy',0,'Copy',0);
      INSERT INTO messages VALUES
        (32,7,0,14,123456789000,'same-id',0,'{"9001":"","9002":null,"unknown":"2a"}',0),
        (33,8,0,14,NULL,'same-id',0,NULL,0),
        (34,NULL,NULL,14,NULL,'ghost-id',0,NULL,0),
        (35,NULL,NULL,14,NULL,'deleted-id',1,NULL,0);
      INSERT INTO messagesText(docid,body,subject,attachmentNames,author,recipients) VALUES
        (32,char(65279)||'recovered é 😀 body'||char(0)||'tail','café','a.txt'||char(10)||'b.txt','Sender','Recipient'),
        (33,NULL,'',NULL,'','');
      INSERT INTO attributeDefinitions VALUES
        (9001,2,'unknown-extension','é',X'00FF80'),
        (9002,2,'unknown-extension','é',NULL);
      INSERT INTO messageAttributes VALUES
        (14,32,9001,9223372036854775807), (14,32,9002,''),
        (14,32,9002,NULL), (14,32,9001,X'00FF80'), (14,32,9001,3.125);
    `);
    if (changes) {
      connection.executeSimpleSQL(changes);
    }
  } finally {
    connection.close();
  }
  return file.path;
}

/**
 * Returns two independent committed folder-import maps with overlapping old keys.
 *
 * @returns {object[]} Journal-compatible source bindings.
 */
function committedBindings() {
  return [
    ["Inbox", 181, 201],
    ["Copy", 182, 202],
  ].map(([name, folderId, key]) => {
    const identity = {
      path: PathUtils.join(do_get_profile().path, name + ".msf"),
      size: 123,
      sha256: "a".repeat(64),
      messageKeys: [0],
    };
    return {
      folderURI: "mailbox://old/" + name,
      source: {
        ...identity,
        id: "folder-" + name,
        state: "imported",
        destinationFolderId: folderId,
        token: "import-" + name,
        receipt: {
          token: "import-" + name,
          sourceSha256: identity.sha256,
          folderId,
          keys: [[0, key]],
        },
      },
      // Unit records model the existing source reader's result, not MSF bytes.
      originalSummary: {
        identity: structuredClone(identity),
        summary: { messages: [{ sourceKey: 0, messageId: "same-id" }] },
      },
    };
  });
}

add_task(async function test_readsStoredTextAndExactUnknownAttributes() {
  const path = createMailInput("text");
  const before = await IOUtils.read(path);
  const snapshot = await readLegacyGlodaMail(path);
  Assert.equal(snapshot.schemaVersion, 30);
  const expectedPath = new FileUtils.File(path);
  expectedPath.normalize();
  Assert.equal(snapshot.source.path, expectedPath.path);
  Assert.equal(
    snapshot.source.sha256,
    await IOUtils.computeHexDigest(path, "sha256")
  );
  Assert.equal(snapshot.source.size, before.length);
  const [first, copy, ghost, deleted] = snapshot.messages;
  Assert.deepEqual(first.text, {
    body: "\uFEFFrecovered é 😀 body\0tail",
    subject: "café",
    attachmentNames: "a.txt\nb.txt",
    author: "Sender",
    recipients: "Recipient",
  });
  Assert.deepEqual(copy.text, {
    body: null,
    subject: "",
    attachmentNames: null,
    author: "",
    recipients: "",
  });
  Assert.equal(
    first.raw.jsonAttributes.value,
    '{"9001":"","9002":null,"unknown":"2a"}'
  );
  Assert.deepEqual(
    first.attributes.map(row => row.value),
    [
      { type: "integer", value: "9223372036854775807" },
      { type: "text", value: "" },
      { type: "null", value: null },
      { type: "blob", value: "00FF80" },
      { type: "real", value: 3.125 },
    ]
  );
  Assert.deepEqual(
    snapshot.attributeDefinitions.map(row => row.name.value),
    ["é", "é"]
  );
  Assert.deepEqual(snapshot.attributeDefinitions[0].parameter, {
    type: "blob",
    value: "00FF80",
  });
  Assert.equal(ghost.folderId, null);
  Assert.equal(ghost.text, null);
  Assert.ok(deleted.deleted);
  Assert.ok(snapshot.unreadTables.includes("extensionData"));
  Assert.deepEqual(
    await IOUtils.read(path),
    before,
    "Original SQLite bytes remain unchanged"
  );
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    Assert.ok(
      !(await IOUtils.exists(path + suffix)),
      "Reader creates no sidecar " + suffix
    );
  }
});

add_task(async function test_mapsPhysicalCopiesThroughCommittedReceipts() {
  const snapshot = await readLegacyGlodaMail(createMailInput("mapping"));
  const result = mapLegacyGlodaMail(snapshot, committedBindings());
  Assert.deepEqual(
    result.mapped.map(row => [row.folderId, row.key]),
    [
      [181, 201],
      [182, 202],
    ]
  );
  Assert.deepEqual(
    result.mapped.map(row => row.message.headerMessageId),
    ["same-id", "same-id"]
  );
  Assert.deepEqual(
    result.mapped.map(row => [
      row.provenance.folderId,
      row.provenance.messageKey,
    ]),
    [
      [7, 0],
      [8, 0],
    ]
  );
  Assert.deepEqual(
    result.mapped.map(row => row.provenance.sourceFolderId),
    ["folder-Inbox", "folder-Copy"]
  );
  Assert.equal(
    result.mapped[0].message.text.body,
    "\uFEFFrecovered é 😀 body\0tail"
  );
  Assert.equal(
    result.mapped[0].provenance.source.sha256,
    snapshot.source.sha256
  );
  Assert.equal(result.mapped[0].provenance.token, "import-Inbox");
  Assert.deepEqual(
    result.excluded.map(row => row.reason),
    ["ghost", "deleted"]
  );
  Assert.equal(result.excluded[1].message.headerMessageId, "deleted-id");
});

add_task(async function test_rejectsMissingFolderMapping() {
  const snapshot = await readLegacyGlodaMail(createMailInput("missing-map"));
  Assert.throws(
    () => mapLegacyGlodaMail(snapshot, committedBindings().slice(0, 1)),
    /Unresolved/
  );
});

add_task(async function test_rejectsIncompleteCommittedMap() {
  const snapshot = await readLegacyGlodaMail(createMailInput("incomplete-map"));
  const bindings = committedBindings();
  bindings[0].source.receipt.keys = [];
  Assert.throws(() => mapLegacyGlodaMail(snapshot, bindings), /Incomplete/);
});

add_task(async function test_rejectsMismatchedSourceHash() {
  const snapshot = await readLegacyGlodaMail(createMailInput("wrong-hash"));
  const bindings = committedBindings();
  bindings[0].source.receipt.sourceSha256 = "b".repeat(64);
  Assert.throws(
    () => mapLegacyGlodaMail(snapshot, bindings),
    /Invalid.*binding/
  );
});

add_task(async function test_rejectsDuplicateBinding() {
  const snapshot = await readLegacyGlodaMail(
    createMailInput("duplicate-binding")
  );
  const bindings = committedBindings();
  bindings[1].folderURI = bindings[0].folderURI;
  Assert.throws(
    () => mapLegacyGlodaMail(snapshot, bindings),
    /Invalid.*binding/
  );
});

add_task(async function test_rejectsReusedDestinationKey() {
  const snapshot = await readLegacyGlodaMail(createMailInput("reused-key"));
  const bindings = committedBindings();
  bindings[1].source.receipt.keys = [[0, 201]];
  Assert.throws(
    () => mapLegacyGlodaMail(snapshot, bindings),
    /Invalid.*key map/
  );
});

add_task(async function test_rejectsOtherSchemaVersions() {
  await Assert.rejects(
    readLegacyGlodaMail(createMailInput("future", "PRAGMA user_version=31;")),
    /schema version: 31/
  );
});

add_task(async function test_rejectsUnknownMailColumns() {
  await Assert.rejects(
    readLegacyGlodaMail(
      createMailInput(
        "column",
        "ALTER TABLE messages ADD COLUMN extensionValue TEXT;"
      )
    ),
    /columns: messages/
  );
});

add_task(async function test_rejectsMissingText() {
  await Assert.rejects(
    readLegacyGlodaMail(
      createMailInput("no-text", "DELETE FROM messagesText WHERE docid=32;")
    ),
    /Missing text/
  );
});

add_task(async function test_rejectsDuplicateFolderIdentity() {
  await Assert.rejects(
    readLegacyGlodaMail(
      createMailInput(
        "duplicate-folder",
        "INSERT INTO folderLocations VALUES(9,'mailbox://old/Inbox',0,'Other',0);"
      )
    ),
    /Ambiguous.*folder/
  );
});

add_task(async function test_rejectsDuplicateMessageLocation() {
  await Assert.rejects(
    readLegacyGlodaMail(
      createMailInput(
        "duplicate-key",
        "UPDATE messages SET folderID=7 WHERE id=33;"
      )
    ),
    /ambiguous.*message location/
  );
});

add_task(async function test_rejectsOrphanedText() {
  await Assert.rejects(
    readLegacyGlodaMail(
      createMailInput(
        "orphan-text",
        "INSERT INTO messagesText(docid,body) VALUES(90,'unattached');"
      )
    ),
    /Orphaned/
  );
});

add_task(async function test_preservesUnkeyedLiveRowsWithoutMappingThem() {
  const snapshot = await readLegacyGlodaMail(
    createMailInput(
      "unkeyed",
      "UPDATE messages SET folderID=7, messageKey=NULL WHERE id IN (32,33);"
    )
  );
  Assert.deepEqual(
    snapshot.messages.slice(0, 2).map(row => row.messageKey),
    [null, null]
  );
  Assert.deepEqual(
    snapshot.messages.slice(0, 2).map(row => row.folderURI),
    ["mailbox://old/Inbox", "mailbox://old/Inbox"]
  );
  Assert.equal(
    snapshot.messages[0].text.body,
    "\uFEFFrecovered é 😀 body\0tail"
  );
  Assert.equal(snapshot.messages[1].text.subject, "");
  const result = mapLegacyGlodaMail(snapshot, committedBindings());
  Assert.deepEqual(result.mapped, []);
  Assert.deepEqual(
    result.excluded.map(row => [row.message.id, row.reason]),
    [
      [32, "unkeyed"],
      [33, "unkeyed"],
      [34, "ghost"],
      [35, "deleted"],
    ]
  );
});

add_task(async function test_rejectsUnkeyedLiveRowsWithoutText() {
  await Assert.rejects(
    readLegacyGlodaMail(
      createMailInput(
        "unkeyed-no-text",
        "UPDATE messages SET messageKey=NULL WHERE id=32; DELETE FROM messagesText WHERE docid=32;"
      )
    ),
    /Missing text/
  );
});

add_task(async function test_rejectsKeyWithoutFolder() {
  await Assert.rejects(
    readLegacyGlodaMail(
      createMailInput(
        "key-no-folder",
        "UPDATE messages SET folderID=NULL WHERE id=32;"
      )
    ),
    /Invalid.*location/
  );
});

add_task(async function test_rejectsInvalidUtf8() {
  await Assert.rejects(
    readLegacyGlodaMail(
      createMailInput(
        "bad-text",
        "UPDATE messagesText SET subject=CAST(X'80' AS TEXT) WHERE docid=32;"
      )
    ),
    /Invalid UTF-8/
  );
});

add_task(async function test_rejectsSidecarsWithoutChangingSource() {
  const path = createMailInput("sidecar");
  await IOUtils.writeUTF8(path + "-wal", "unreplayed input");
  const before = await IOUtils.read(path);
  await Assert.rejects(readLegacyGlodaMail(path), /sidecar: -wal/);
  Assert.equal(await IOUtils.readUTF8(path + "-wal"), "unreplayed input");
  Assert.deepEqual(await IOUtils.read(path), before);
});

add_task(async function test_rejectsWalSources() {
  const path = createMailInput("wal", "PRAGMA journal_mode=WAL;");
  await Assert.rejects(
    readLegacyGlodaMail(path),
    /rollback-journal snapshot|sidecar/
  );
});

add_task(async function test_rejectsRelativeSourcePath() {
  await Assert.rejects(readLegacyGlodaMail("relative.sqlite"), /absolute/);
});

add_task(async function test_rejectsReorderedTextColumns() {
  const path = createMailInput(
    "text-layout",
    `
    DROP TABLE messagesText;
    CREATE VIRTUAL TABLE messagesText USING fts3(tokenize mozporter, subject TEXT,
      body TEXT, attachmentNames TEXT, author TEXT, recipients TEXT);
  `
  );
  await Assert.rejects(readLegacyGlodaMail(path), /text layout/);
});

add_task(async function test_rejectsUnsafeStructuralIntegers() {
  const path = createMailInput(
    "unsafe-id",
    "UPDATE messages SET conversationID=9223372036854775807 WHERE id=32;"
  );
  await Assert.rejects(readLegacyGlodaMail(path), /structural integer/);
});

add_task(async function test_excludesStaleKeysWithoutJoiningByMessageId() {
  const snapshot = await readLegacyGlodaMail(createMailInput("stale"));
  const bindings = committedBindings();
  bindings[0].originalSummary.summary.messages[0].messageId = "replacement-id";
  const result = mapLegacyGlodaMail(snapshot, bindings);
  Assert.deepEqual(
    result.mapped.map(row => [row.folderId, row.key]),
    [[182, 202]]
  );
  Assert.deepEqual(
    result.excluded.map(row => [row.message.id, row.reason]),
    [
      [32, "stale"],
      [34, "ghost"],
      [35, "deleted"],
    ]
  );
  Assert.equal(
    result.excluded[0].message.text.body,
    "\uFEFFrecovered é 😀 body\0tail"
  );
  Assert.equal(result.mapped[0].message.headerMessageId, "same-id");
});

add_task(async function test_requiresTheImportedSummaryHash() {
  const snapshot = await readLegacyGlodaMail(createMailInput("summary-hash"));
  const bindings = committedBindings();
  bindings[0].originalSummary.identity.sha256 = "b".repeat(64);
  Assert.throws(
    () => mapLegacyGlodaMail(snapshot, bindings),
    /original summary binding/
  );
});

add_task(async function test_requiresEveryOriginalSummaryMessageId() {
  const snapshot = await readLegacyGlodaMail(
    createMailInput("summary-incomplete")
  );
  const bindings = committedBindings();
  bindings[0].originalSummary.summary.messages = [];
  Assert.throws(
    () => mapLegacyGlodaMail(snapshot, bindings),
    /Incomplete.*summary/
  );
});

add_task(async function test_verifiesKeysAgainstGenuineImportedSummaryBytes() {
  const file = do_get_file("data/migration.msf");
  file.normalize();
  const before = await IOUtils.read(file.path);
  const originalSummary = {
    identity: {
      path: file.path,
      size: before.length,
      sha256: await IOUtils.computeHexDigest(file.path, "sha256"),
      messageKeys: [1, 3],
    },
    summary: parseMorkSummary(before),
  };
  Assert.deepEqual(
    originalSummary.summary.messages.map(row => [row.sourceKey, row.messageId]),
    [
      [1, "162378@invalid"],
      [3, "345692@invalid"],
    ]
  );
  const bindings = committedBindings();
  for (const [index, binding] of bindings.entries()) {
    Object.assign(binding.source, originalSummary.identity);
    binding.source.receipt.sourceSha256 = originalSummary.identity.sha256;
    binding.source.receipt.keys = [
      [1, 201 + index],
      [3, 203 + index],
    ];
    binding.originalSummary = originalSummary;
  }
  const snapshot = await readLegacyGlodaMail(
    createMailInput(
      "genuine-summary",
      "UPDATE messages SET messageKey=1, headerMessageID='162378@invalid' WHERE id IN (32,33);"
    )
  );
  const result = mapLegacyGlodaMail(snapshot, bindings);
  Assert.deepEqual(
    result.mapped.map(row => [row.folderId, row.key]),
    [
      [181, 201],
      [182, 202],
    ]
  );
  Assert.deepEqual(await IOUtils.read(file.path), before);
});

add_task(async function test_rejectsNumericJournalSourceIds() {
  const snapshot = await readLegacyGlodaMail(
    createMailInput("numeric-journal-id")
  );
  const bindings = committedBindings();
  bindings[0].source.id = 81;
  Assert.throws(
    () => mapLegacyGlodaMail(snapshot, bindings),
    /Invalid.*binding/
  );
});

add_task(async function test_rejectsCoercedReceiptFolderIdentity() {
  const snapshot = await readLegacyGlodaMail(
    createMailInput("coerced-folder-id")
  );
  const bindings = committedBindings();
  bindings[0].source.receipt.folderId = "181";
  Assert.throws(
    () => mapLegacyGlodaMail(snapshot, bindings),
    /Invalid.*binding/
  );
});

let nativeRecovery;

add_task(async function test_recoversBackedUpTextWithActualNativeReceipts() {
  const { ProfileCreator } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/ProfileCreator.sys.mjs"
  );
  const { MigrationJournal } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MigrationJournal.sys.mjs"
  );
  const { createMigrationBackup } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MigrationBackup.sys.mjs"
  );
  const { readMorkFolderImport, captureMorkFolderWindowsInventory } =
    ChromeUtils.importESModule(
      "resource:///modules/panorama/MorkFolderImport.sys.mjs"
    );
  const {
    createPanoramaMigrationTarget,
    createWindowsPanoramaMigrationTarget,
    resumeMorkImports,
    readLegacyGlodaMailRecovery,
  } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MigrationCoordinator.sys.mjs"
  );
  Services.prefs.setBoolPref("security.nocertdb", true);
  const profile = do_get_profile();
  const provider = Cc["@mozilla.org/xre/directory-provider;1"]
    .getService(Ci.nsIDirectoryServiceProvider)
    .QueryInterface(Ci.nsIXREDirProvider);
  for (const key of ["DefProfRt", "DefProfLRt", "UAppData"]) {
    const file = provider.getFile(key, {}).clone();
    if (Services.dirsvc.has(key)) {
      Services.dirsvc.undefine(key);
    }
    Services.dirsvc.set(key, file);
  }
  const service = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
    Ci.nsIToolkitProfileService
  );
  const nativeProfile = service.createProfile(
    profile,
    "legacy-mail-recovery",
    "tests"
  );
  const lock = nativeProfile.lock({});
  registerCleanupFunction(() => {
    lock.unlock();
    nativeProfile.remove(false);
  });
  const work = await IOUtils.createUniqueDirectory(
    PathUtils.parent(profile.path),
    "legacy-mail-recovery-"
  );
  registerCleanupFunction(() => IOUtils.remove(work, { recursive: true }));
  const summaryBytes = await IOUtils.read(
    do_get_file("data/migration.msf").path
  );
  const bodyBytes = await IOUtils.read(do_get_file("data/migration").path);
  const summary = new FileUtils.File(PathUtils.join(work, "source.msf"));
  const body = new FileUtils.File(PathUtils.join(work, "source"));
  await IOUtils.write(summary.path, summaryBytes, { mode: "create" });
  await IOUtils.write(body.path, bodyBytes, { mode: "create" });
  const names = ["RecoveredInbox", "RecoveredCopy"];
  // Literal unit-data locations for ProfileCreator's nobody/Local Folders server.
  // The native URI assertions below must hold before any mapping is used.
  const uris = [
    "mailbox://nobody@Local%20Folders/RecoveredInbox",
    "mailbox://nobody@Local%20Folders/RecoveredCopy",
  ];
  const windows = AppConstants.platform == "win";
  const inventories = new Map();
  const creator = new ProfileCreator(profile);
  const server = creator.addLocalServer();
  for (const name of names) {
    const original = await server.rootFolder.addMailFolder(name, {
      summary,
      mbox: body,
    });
    if (windows) {
      inventories.set(
        name,
        captureMorkFolderWindowsInventory(
          new FileUtils.File(original.summaryFilePath),
          profile,
          new FileUtils.File(original.mailFilePath),
          profile
        )
      );
    }
  }
  const glodaPath = createMailInput(
    "native-recovery",
    `
      UPDATE folderLocations SET folderURI='${uris[0]}' WHERE id=7;
      UPDATE folderLocations SET folderURI='${uris[1]}' WHERE id=8;
      UPDATE messages SET messageKey=1,headerMessageID='162378@invalid' WHERE id IN (32,33);
    `
  );
  const glodaBytes = await IOUtils.read(glodaPath);
  Assert.ok(
    !(await IOUtils.exists(PathUtils.join(profile.path, "panorama.sqlite")))
  );
  const backup = await createMigrationBackup(
    profile.path,
    [],
    PathUtils.join(work, "backup")
  );
  loadExistingDB();
  Assert.equal(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    ),
    database
  );
  const folders = new Map();
  const sources = [];
  const originals = new Map([[glodaPath, glodaBytes]]);
  Assert.equal(MailServices.accounts.accounts.length, 1);
  const root = MailServices.accounts.localFoldersServer.rootFolder;
  for (const [index, name] of names.entries()) {
    const folder = root.getChildNamed(name);
    Assert.ok(folder instanceof Ci.nsIMsgFolder);
    Assert.equal(folder.URI, uris[index]);
    Assert.equal(folder.msgStore.storeType, "mbox");
    const inventory = inventories.get(name);
    const input = await readMorkFolderImport(
      folder,
      "planning-only",
      inventory
    );
    Assert.deepEqual(input.source.messageKeys.toSorted(), [1, 3]);
    folders.set(name, folder);
    sources.push({
      id: name,
      databaseSourceId: database.sourceId,
      ...input.source,
      ...(windows ? { inventory } : {}),
      destinationFolderId: folder.id,
    });
    originals.set(
      folder.summaryFile.path,
      await IOUtils.read(folder.summaryFile.path)
    );
    originals.set(
      folder.filePath.path,
      await IOUtils.read(folder.filePath.path)
    );
  }
  const journalPath = PathUtils.join(work, "journal.json");
  const journal = await MigrationJournal.create(journalPath, {
    profilePath: lock.directory.path,
    mailPaths: [],
    backupPath: PathUtils.parent(backup.path),
    sources,
  });
  registerCleanupFunction(() => journal.close());
  await journal.recordBackup(backup);
  const resolve = id => folders.get(id);
  await resumeMorkImports(
    journal,
    (windows
      ? createWindowsPanoramaMigrationTarget
      : createPanoramaMigrationTarget)(journal, database, resolve, lock)
  );
  Assert.equal(journal.state.version, windows ? 4 : 1);
  if (windows) {
    Assert.equal((await IOUtils.readJSON(backup.path)).version, 3);
  }
  const recorded = await IOUtils.read(journalPath);
  const state = journal.state;
  const changes = () => {
    const stmt = database.connectionForTests.createStatement(
      "SELECT total_changes() AS count"
    );
    try {
      Assert.ok(stmt.executeStep());
      return stmt.row.count;
    } finally {
      stmt.finalize();
    }
  };
  const writes = changes();
  const backedUp = PathUtils.join(
    PathUtils.parent(backup.path),
    "root-0",
    PathUtils.filename(glodaPath)
  );
  const result = await readLegacyGlodaMailRecovery(
    journal,
    database,
    resolve,
    lock,
    backedUp
  );
  Assert.equal(
    changes(),
    writes,
    "Recovery does not write the native database"
  );
  Assert.deepEqual(result.backup, backup);
  const originalDatabase = new FileUtils.File(glodaPath);
  originalDatabase.normalize();
  Assert.equal(result.originalDatabasePath, originalDatabase.path);
  Assert.deepEqual(
    result.mapped.map(row => row.sourceId),
    [database.sourceId, database.sourceId]
  );
  const expected = state.sources.map(source => [
    source.destinationFolderId,
    new Map(source.receipt.keys).get(1),
  ]);
  Assert.deepEqual(
    result.mapped.map(row => [row.folderId, row.key]),
    expected
  );
  Assert.notEqual(
    result.mapped[0].key,
    result.mapped[1].key,
    "Physical copies remain separate despite equal Message-IDs"
  );
  Assert.deepEqual(
    result.mapped.map(row => row.message.headerMessageId),
    ["162378@invalid", "162378@invalid"]
  );
  Assert.equal(
    result.mapped[0].message.text.body,
    "\uFEFFrecovered é 😀 body\0tail"
  );
  Assert.equal(result.mapped[1].message.text.body, null);
  Assert.equal(result.mapped[1].message.text.subject, "");
  Assert.deepEqual(
    result.snapshot.attributeDefinitions.map(row => row.name.value),
    ["é", "é"]
  );
  Assert.deepEqual(
    result.excluded.map(row => row.reason),
    ["ghost", "deleted"]
  );
  for (const [index, row] of result.mapped.entries()) {
    Assert.equal(
      row.provenance.importReceipt.sourceId,
      state.sources[index].id
    );
    Assert.equal(
      row.provenance.importReceipt.databaseSourceId,
      database.sourceId
    );
    Assert.deepEqual(
      row.provenance.importReceipt.keys,
      state.sources[index].receipt.keys
    );
    Assert.deepEqual(row.provenance.backup, backup);
    Assert.ok(
      !Object.hasOwn(row, "eligible"),
      "Recovery never invents search eligibility"
    );
  }
  const repeated = await readLegacyGlodaMailRecovery(
    journal,
    database,
    resolve,
    lock,
    backedUp
  );
  Assert.deepEqual(repeated, result);
  Assert.equal(changes(), writes);
  await Assert.rejects(
    readLegacyGlodaMailRecovery(journal, database, resolve, lock, glodaPath),
    windows
      ? error => error.result == Cr.NS_ERROR_FILE_ACCESS_DENIED
      : /outside backed-up roots/
  );
  const other = service.createProfile(
    new FileUtils.File(PathUtils.join(work, "other-profile")),
    "legacy-mail-other",
    "tests"
  );
  const otherLock = other.lock({});
  try {
    await Assert.rejects(
      readLegacyGlodaMailRecovery(
        journal,
        database,
        resolve,
        otherLock,
        backedUp
      ),
      /held selected profile/
    );
  } finally {
    otherLock.unlock();
    other.remove(false);
  }
  if (!windows) {
    const manifestBytes = await IOUtils.read(backup.path);
    let changedManifest = false;
    const changeAfterVerifiedRead = async id => {
      if (!changedManifest) {
        const changed = new Uint8Array(manifestBytes.length + 1);
        changed.set(manifestBytes);
        changed[manifestBytes.length] = 10;
        await IOUtils.write(backup.path, changed);
        changedManifest = true;
      }
      return resolve(id);
    };
    try {
      await Assert.rejects(
        readLegacyGlodaMailRecovery(
          journal,
          database,
          changeAfterVerifiedRead,
          lock,
          backedUp
        ),
        /backup identity changed/
      );
      Assert.ok(
        changedManifest,
        "The manifest changed after its verified read, at native folder resolution"
      );
      Assert.equal(changes(), writes);
      Assert.deepEqual(await IOUtils.read(journalPath), recorded);
    } finally {
      await IOUtils.write(backup.path, manifestBytes);
    }
    Assert.deepEqual(
      await readLegacyGlodaMailRecovery(
        journal,
        database,
        resolve,
        lock,
        backedUp
      ),
      result,
      "The original verified backup remains usable after exact restoration"
    );
  }
  Assert.deepEqual(await IOUtils.read(journalPath), recorded);
  Assert.deepEqual(journal.state, state);
  for (const [path, bytes] of originals) {
    Assert.deepEqual(await IOUtils.read(path), bytes);
  }
  Assert.deepEqual(await IOUtils.read(backedUp), glodaBytes);
  nativeRecovery = {
    journal,
    lock,
    backup,
    work,
    state,
    recorded,
    journalPath,
    originals,
    result,
    changes,
    writes,
    backedUp,
    glodaPath,
    read: callback =>
      readLegacyGlodaMailRecovery(
        journal,
        database,
        callback ?? resolve,
        lock,
        backedUp
      ),
  };
});

add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function test_windowsRecoveryRejectsChangedBackupBeforeRetry() {
    const c = nativeRecovery;
    const bytes = await IOUtils.read(c.backup.path);
    const changed = new Uint8Array(bytes.length + 1);
    changed.set(bytes);
    changed[bytes.length] = 10;
    await IOUtils.write(c.backup.path, changed);
    try {
      await Assert.rejects(
        c.read(),
        error => error.message === "Gloda recovery backup identity changed"
      );
      Assert.equal(c.changes(), c.writes);
      Assert.deepEqual(await IOUtils.read(c.journalPath), c.recorded);
    } finally {
      await IOUtils.write(c.backup.path, bytes);
    }
    Assert.deepEqual(await c.read(), c.result);
  }
);

add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function test_windowsRecoveryRejectsChangedSourcePhysicalIdentity() {
    const c = nativeRecovery;
    const source = c.state.sources[0];
    const retained = PathUtils.join(c.work, "original-summary.msf");
    // Retain the original file/ID. Only the disposable identical copy replaces it.
    await IOUtils.move(source.path, retained, { noOverwrite: true });
    try {
      await IOUtils.copy(retained, source.path, { noOverwrite: true });
      Assert.deepEqual(
        await IOUtils.read(source.path),
        c.originals.get(source.path)
      );
      await Assert.rejects(
        c.read(),
        error =>
          error.message ===
          "Retained Windows migration physical identity changed"
      );
      Assert.equal(c.changes(), c.writes);
      Assert.deepEqual(await IOUtils.read(c.journalPath), c.recorded);
    } finally {
      await IOUtils.move(retained, source.path, { noOverwrite: false });
    }
    Assert.deepEqual(await c.read(), c.result);
  }
);

add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function test_windowsRecoveryRetainsAdmissionThroughResolverFailure() {
    const c = nativeRecovery;
    const protectedPaths = [
      c.backup.path,
      c.backedUp,
      ...c.originals.keys(),
    ].filter(path => path !== c.glodaPath);
    let firstError;
    let calls = 0;
    const fail = async () => {
      calls++;
      for (const path of protectedPaths) {
        Assert.throws(
          () =>
            new FileUtils.File(path).moveTo(
              null,
              PathUtils.filename(path) + ".blocked"
            ),
          error => {
            firstError ??= error;
            return error.result == Cr.NS_ERROR_FILE_IS_LOCKED;
          }
        );
        Assert.ok(await IOUtils.exists(path));
        Assert.ok(!(await IOUtils.exists(path + ".blocked")));
      }
      throw firstError;
    };
    await Assert.rejects(c.read(fail), error => error === firstError);
    Assert.equal(calls, 1);
    Assert.ok(firstError);
    Assert.equal(c.changes(), c.writes);
    Assert.deepEqual(await IOUtils.read(c.journalPath), c.recorded);
    // The failed operation has finished. Renames now prove owned leases closed.
    for (const path of protectedPaths) {
      const moved = path + ".closed";
      await IOUtils.move(path, moved, { noOverwrite: true });
      await IOUtils.move(moved, path, { noOverwrite: true });
    }
    Assert.deepEqual(await c.read(), c.result);
    Assert.deepEqual(c.journal.state, c.state);
  }
);

add_task(async function test_recoveryDoesNotReimportMissingCommittedReceipt() {
  const { state, changes, writes, recorded, journalPath, originals } =
    nativeRecovery;
  Assert.equal(changes(), writes);
  // Delete only this receipt/map. Retain the native completion marker so the
  // actual getter must reject the inconsistent committed import, never retry it.
  const removeKeys = database.connectionForTests.createStatement(
    "DELETE FROM folder_import_keys WHERE token=:token"
  );
  try {
    removeKeys.params.token = state.sources[0].token;
    removeKeys.execute();
  } finally {
    removeKeys.finalize();
  }
  Assert.equal(
    database.connectionForTests.affectedRows,
    state.sources[0].receipt.keys.length,
    "The fault removes only the selected source's complete native key map"
  );
  const remove = database.connectionForTests.createStatement(
    "DELETE FROM folder_import_receipts WHERE token=:token"
  );
  try {
    remove.params.token = state.sources[0].token;
    remove.execute();
  } finally {
    remove.finalize();
  }
  Assert.equal(
    database.connectionForTests.affectedRows,
    1,
    "The scoped native receipt-loss fault reached its real row"
  );
  const afterFault = changes();
  await Assert.rejects(
    nativeRecovery.read(),
    error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
    "The native getter refuses the retained completion marker without its receipt"
  );
  Assert.equal(
    changes(),
    afterFault,
    "A missing receipt never reimports messages"
  );
  Assert.deepEqual(await IOUtils.read(journalPath), recorded);
  for (const [path, bytes] of originals) {
    Assert.deepEqual(await IOUtils.read(path), bytes);
  }
});
