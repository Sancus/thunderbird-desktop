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
const { convertMorkFolderSnapshot, convertMorkProtocolUnit } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MorkSnapshotAdapter.sys.mjs"
  );
const { createPanoramaMigrationTarget, resumeMorkImports } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MigrationCoordinator.sys.mjs"
  );

const REFERENCE_VARIANTS = [
  {
    file: "deliveryMigrationReferences",
    sha256: "b7a621f2e71c328d1b22393d9760dbc84e0f6d40145eb4745da9881a3f4064c8",
    folders: [
      "references",
      "references-invalid",
      "projection-subject",
      "projection-raw",
      "projection-present",
      "projection-after",
    ],
    raw: "<ancestor@invalid>\r\n\t<parent@invalid> <nearest@invalid>",
    references: ["ancestor@invalid", "parent@invalid", "nearest@invalid"],
  },
  {
    file: "deliveryMigrationDuplicateReferences",
    sha256: "cf2b381c64436b231c1261751db590c7811355f3f4843c8ad0e5e4b1b6003962",
    folders: [
      "duplicate-references",
      "references-rollback",
      "projection-duplicates",
    ],
    raw: "<ancestor@invalid> <parent@invalid>\r\n\t<ancestor@invalid> <nearest@invalid>",
    references: [
      "ancestor@invalid",
      "parent@invalid",
      "ancestor@invalid",
      "nearest@invalid",
    ],
  },
];
const referenceInputs = new Map();
let legacyMeasurements;

let work, lock, backup, control;
let summaryBytes, bodyBytes;
const folders = new Map();
const names = [
  "complete",
  "checkpoint",
  "rollback",
  "invalid",
  "insertion",
  "control",
  "flags",
];
// ProfileCreator takes physical leaves. Native EncodeFilename escapes '%' and
// '/', and nsMsgBrkMBoxStore discovers these names through DecodeFilename once.
const CODEC_FOLDER_INPUTS = [
  { name: "codec/literal", filename: "codec%2Fliteral" },
  { name: "codec%2Fliteral", filename: "codec%252Fliteral" },
];

let imapLedger, imapServerKey;
const imapSourceFiles = new Map();
const imapFolders = new Map();

add_setup(async function setupBackedUpLegacyProfileBeforeNativeStartup() {
  // Hash the closed inputs without opening profile NSS database writers.
  Services.prefs.setBoolPref("security.nocertdb", true);
  const profile = do_get_profile();
  const provider = Cc["@mozilla.org/xre/directory-provider;1"]
    .getService(Ci.nsIDirectoryServiceProvider)
    .QueryInterface(Ci.nsIXREDirProvider);
  for (const key of ["DefProfRt", "DefProfLRt", "UAppData"]) {
    Services.dirsvc.set(key, provider.getFile(key, {}).clone());
  }
  const service = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
    Ci.nsIToolkitProfileService
  );
  const nativeProfile = service.createProfile(
    profile,
    "migration-native-import",
    "tests"
  );
  lock = nativeProfile.lock({});
  registerCleanupFunction(() => {
    lock.unlock();
    nativeProfile.remove(false);
  });
  work = await IOUtils.createUniqueDirectory(
    PathUtils.parent(profile.path),
    "migration-native-import-"
  );
  registerCleanupFunction(() => IOUtils.remove(work, { recursive: true }));
  summaryBytes = await IOUtils.read(do_get_file("data/migration.msf").path);
  bodyBytes = await IOUtils.read(do_get_file("data/migration").path);
  // Write byte-identical regular copies, including when support files are links.
  const summary = new FileUtils.File(PathUtils.join(work, "source.msf"));
  const body = new FileUtils.File(PathUtils.join(work, "source"));
  await IOUtils.write(summary.path, summaryBytes, { mode: "create" });
  await IOUtils.write(body.path, bodyBytes, { mode: "create" });
  const creator = new ProfileCreator(profile);
  const server = creator.addLocalServer();
  for (const name of names) {
    await server.rootFolder.addMailFolder(name, { summary, mbox: body });
  }
  for (const { filename } of CODEC_FOLDER_INPUTS) {
    await server.rootFolder.addMailFolder(filename, { summary, mbox: body });
  }
  legacyMeasurements = await IOUtils.readJSON(
    do_get_file("data/deliveryMigrationReferences.measured.json").path
  );
  for (const spec of REFERENCE_VARIANTS) {
    const fixture = do_get_file("data/" + spec.file + ".msf");
    Assert.equal(
      await IOUtils.computeHexDigest(fixture.path, "sha256"),
      spec.sha256
    );
    const bytes = await IOUtils.read(fixture.path);
    const copy = new FileUtils.File(PathUtils.join(work, spec.file + ".msf"));
    await IOUtils.write(copy.path, bytes, { mode: "create" });
    for (const name of spec.folders) {
      await server.rootFolder.addMailFolder(name, {
        summary: copy,
        mbox: body,
      });
      referenceInputs.set(name, { spec, bytes });
    }
  }
  // These files are real committed/reopened MDB and provider output from the
  // ordinary IM producer. Its independent readback ledger is a test oracle.
  imapLedger = await IOUtils.readJSON(
    do_get_file("data/s518/mbox/ledger.json").path
  );
  Assert.equal(imapLedger.backend, "panorama");
  Assert.equal(imapLedger.store, "mbox");
  Assert.equal(imapLedger.members.length, 6);
  const originalUri = Services.io.newURI(imapLedger.members[0].uri);
  const imap = creator.addServer(
    decodeURIComponent(originalUri.username),
    originalUri.host,
    "imap"
  );
  imap.prefBranch.setIntPref("port", originalUri.port);
  imap.prefBranch.setBoolPref("login_at_startup", false);
  imap.prefBranch.setStringPref(
    "storeContractID",
    "@mozilla.org/msgstore/berkeleystore;1"
  );
  imapServerKey = imap.prefBranch.root.split(".")[2];
  for (const saved of imapLedger.members) {
    Assert.ok(
      /^Migration(?:Classic|Explicit|CopyOne|CopyTwo|Move|Append)$/.test(
        saved.name
      )
    );
    const summaryInput = do_get_file("data/s518/mbox/" + saved.name + ".msf");
    const bodyInput = do_get_file("data/s518/mbox/" + saved.name);
    Assert.equal(
      await IOUtils.computeHexDigest(summaryInput.path, "sha256"),
      saved.sha256
    );
    Assert.equal((await IOUtils.stat(summaryInput.path)).size, saved.size);
    Assert.equal(saved.bodies.length, 1);
    Assert.equal(saved.bodies[0].relative, "");
    Assert.equal(
      await IOUtils.computeHexDigest(bodyInput.path, "sha256"),
      saved.bodies[0].sha256
    );
    const files = await imap.rootFolder.addMailFolder(saved.name, {
      summary: summaryInput,
      mbox: bodyInput,
    });
    const inventory =
      AppConstants.platform == "win"
        ? captureMorkFolderWindowsInventory(
            new FileUtils.File(files.summaryFilePath),
            do_get_profile(),
            new FileUtils.File(files.mailFilePath),
            do_get_profile()
          )
        : undefined;
    imapSourceFiles.set(saved.name, { saved, files, inventory });
  }
  Services.prefs.savePrefFile(
    new FileUtils.File(PathUtils.join(do_get_profile().path, "prefs.js"))
  );
  Services.prefs.savePrefFile(
    new FileUtils.File(PathUtils.join(profile.path, "prefs.js"))
  );
  Assert.ok(
    !(await IOUtils.exists(PathUtils.join(profile.path, "panorama.sqlite")))
  );
  const backupRoot = await IOUtils.createUniqueDirectory(
    PathUtils.parent(profile.path),
    "migration-native-backup-"
  );
  registerCleanupFunction(() =>
    IOUtils.remove(backupRoot, { recursive: true })
  );
  backup = await createMigrationBackup(
    profile.path,
    [],
    PathUtils.join(backupRoot, "backup")
  );

  loadExistingDB();
  Assert.equal(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    ),
    database,
    "The selected backend is the actual native Panorama core"
  );
  Assert.ok(database.sourceId);
  MailServices.accounts.accounts;
  let imapRoot = folderDB.getFolderByPath(imapServerKey);
  if (!imapRoot) {
    imapRoot = folderDB.insertRoot(imapServerKey);
  }
  const nativeImap = MailServices.accounts.getIncomingServer(imapServerKey);
  Assert.equal(nativeImap.rootFolder.id, imapRoot);
  for (const [name] of imapSourceFiles) {
    let id = folderDB.getFolderByPath(imapServerKey + "/" + name);
    if (!id) {
      id = folderDB.insertFolder(imapRoot, name);
    }
    // The root facade was initialized before these physical rows were added.
    // Attach its native child without changing the retained row's flags.
    const flags = folderDB.getFolderFlags(id);
    const folder = nativeImap.rootFolder.addSubfolder(name);
    folder.flags = flags;
    Assert.ok(folder);
    Assert.equal(folderDB.getFolderFlags(id), flags);
    Assert.equal(nativeImap.rootFolder.getChildNamed(name), folder);
    Assert.equal(folder.id, id);
    Assert.equal(folder.incomingServerType, "imap");
    Assert.equal(folder.msgStore.storeType, "mbox");
    imapFolders.set(name, folder);
  }
  registerCleanupFunction(() => nativeImap.closeCachedConnections());
  const root = MailServices.accounts.localFoldersServer.rootFolder;
  for (const name of [
    ...names,
    ...referenceInputs.keys(),
    ...CODEC_FOLDER_INPUTS.map(input => input.name),
  ]) {
    const folder = root.getChildNamed(name);
    Assert.ok(folder instanceof Ci.nsIMsgFolder);
    Assert.equal(folder.incomingServerType, "none");
    Assert.equal(folder.msgStore.storeType, "mbox");
    Assert.ok(!folder.summaryFile.isSymlink());
    folders.set(name, folder);
  }
  // A native insertion before migration must survive every import/failure.
  control = messageDB.addMessage(
    folders.get("control").id,
    "native-control@invalid",
    ["control-parent@invalid"],
    0,
    "",
    "",
    "",
    "",
    "Original native control",
    0,
    "",
    Ci.nsMsgPriority.notSet
  );
  registerCleanupFunction(() => folders.clear());
});

/** @param {string} name - Separate genuine source/destination. @param {string} [databaseId=database.sourceId] - Retained incarnation. @returns {Promise<object>} Open journal and actual native folder. */
async function planned(name, databaseId = database.sourceId) {
  const folder = folders.get(name);
  const input = await readMorkFolderImport(folder, "planning-only");
  const path = PathUtils.join(work, name + ".json");
  const journal = await MigrationJournal.create(path, {
    profilePath: lock.directory.path,
    backupPath: PathUtils.parent(backup.path),
    mailPaths: [],
    sources: [
      {
        id: name,
        databaseSourceId: databaseId,
        path: input.source.path,
        sha256: input.source.sha256,
        size: input.source.size,
        messageKeys: referenceInputs.has(name)
          ? legacyMeasurements.rows.map(row => row.physical.key)
          : [3, 1],
        destinationFolderId: folder.id,
      },
    ],
  });
  registerCleanupFunction(() => journal.close());
  await journal.recordBackup(backup);
  return { name, folder, journal, path, reference: referenceInputs.get(name) };
}

/** @param {object} input - Planned unit. @returns {object} Real coordinator/native boundary, without mocks. */
function target(input) {
  return createPanoramaMigrationTarget(
    input.journal,
    database,
    id => {
      Assert.equal(id, input.name);
      return input.folder;
    },
    lock
  );
}

/** @param {object} input - Importing/imported unit. @returns {Promise<object>} Complete real producer request for native receipt reads. */
async function request(input) {
  const source = input.journal.state.sources[0];
  return convertMorkFolderSnapshot(
    await readMorkFolderImport(input.folder, source.token),
    source,
    database.sourceId,
    folderDB.getFolderFlags(input.folder.id)
  );
}

/** @param {string} sql - Fixed domain query. @param {string[]} columns - Explicit result names. @param {object} [params={}] - Bound values. @returns {unknown[][]} Rows from the actual native connection. */
function rows(sql, columns, params = {}) {
  const stmt = database.connectionForTests.createStatement(sql);
  try {
    for (const [name, value] of Object.entries(params)) {
      stmt.params[name] = value;
    }
    const result = [];
    while (stmt.executeStep()) {
      result.push(columns.map(name => stmt.row[name]));
    }
    return result;
  } finally {
    stmt.finalize();
  }
}

/** @param {object} input - One destination. @returns {object} Independently queried rows, References and durable receipts. */
function destination(input) {
  const params = {
    folder: input.folder.id,
    token: input.journal.state.sources[0].token,
  };
  return {
    messages: rows(
      "SELECT id,messageId,flags FROM messages WHERE folderId=:folder ORDER BY id",
      ["id", "messageId", "flags"],
      { folder: params.folder }
    ),
    properties: rows(
      "SELECT p.id,p.name,p.value FROM message_properties p JOIN messages m ON m.id=p.id WHERE m.folderId=:folder ORDER BY p.id,p.name",
      ["id", "name", "value"],
      { folder: params.folder }
    ),
    references: rows(
      "SELECT r.id,r.ordinal,r.token FROM message_references r JOIN messages m ON m.id=r.id WHERE m.folderId=:folder ORDER BY r.id,r.ordinal",
      ["id", "ordinal", "token"],
      { folder: params.folder }
    ),
    folder: rows(
      "SELECT name,value FROM folder_properties WHERE id=:folder ORDER BY name",
      ["name", "value"],
      { folder: params.folder }
    ),
    receipts: rows(
      "SELECT token,sourceId,databaseSourceId,sourceSha256 FROM folder_import_receipts WHERE folderId=:folder",
      ["token", "sourceId", "databaseSourceId", "sourceSha256"],
      { folder: params.folder }
    ),
    keys: rows(
      "SELECT sourceKey,destinationKey FROM folder_import_keys WHERE token=:token ORDER BY sourceKey",
      ["sourceKey", "destinationKey"],
      { token: params.token }
    ),
  };
}

/** @param {object} input - Committed unit. @returns {Promise<void>} Literal fixture outcomes and immutable originals. */
async function assertCommitted(input) {
  const source = input.journal.state.sources[0];
  Assert.equal(source.state, "imported");
  Assert.equal(source.databaseSourceId, database.sourceId);
  const native = database.getFolderImportReceipt(
    input.folder,
    await request(input)
  );
  Assert.equal(native.sourceId, input.name);
  Assert.equal(native.databaseSourceId, source.databaseSourceId);
  Assert.equal(native.token, source.token);
  Assert.equal(native.folderId, input.folder.id);
  Assert.equal(source.receipt.folderId, input.folder.id);
  Assert.equal(native.sourceSha256, source.sha256);
  Assert.deepEqual(native.keys, source.receipt.keys);
  Assert.deepEqual(
    native.keys.map(pair => pair[0]),
    [1, 3]
  );
  const imported = new Map(native.keys);
  Assert.equal(new Set(imported.values()).size, 2);
  Assert.ok(
    [...imported.values()].every(
      key => key > 0 && key < 0xffffffff && key != control
    )
  );
  const headers = new Map(
    Array.from(input.folder.messages, h => [h.messageKey, h])
  );
  Assert.equal(headers.size, 2);
  Assert.deepEqual(
    rows(
      "SELECT id,flags FROM messages WHERE folderId=:folder ORDER BY id",
      ["id", "flags"],
      { folder: input.folder.id }
    ),
    [
      [imported.get(1), Ci.nsMsgMessageFlags.Read],
      [imported.get(3), 0],
    ]
  );
  const readKey = imported.get(1);
  const unreadKey = imported.get(3);
  const newKeys = new Set(input.folder.msgDatabase.getNewList());
  const expected = [
    [1, "162378@invalid", "0", 578, "Secured value-added orchestration"],
    [3, "345692@invalid", "1143", 375, "Intuitive full-range analyzer"],
  ];
  const threadIds = new Set();
  for (const [oldKey, id, token, size, subject] of expected) {
    const header = headers.get(imported.get(oldKey));
    Assert.equal(header.messageId, id);
    Assert.equal(header.folder.id, input.folder.id);
    Assert.equal(header.storeToken, token);
    Assert.equal(header.messageSize, size);
    Assert.equal(header.subject, subject);
    Assert.equal(
      header.numReferences,
      0,
      "The genuine base has explicit empty References"
    );
    Assert.equal(header.threadParent, 0);
    Assert.greater(header.threadId, 0);
    threadIds.add(header.threadId);
    const thread = input.folder.msgDatabase.getThreadContainingMsgHdr(header);
    Assert.equal(thread.getChildHdrAt(0).messageId, id);
    Assert.equal(
      messageDB.getMessageProperty(header.messageKey, "references"),
      ""
    );
    Assert.ok([...header.properties].includes("references"));
    Assert.ok(![...header.properties].includes("absent-import-property"));
    const physicalBody = new TextDecoder().decode(
      bodyBytes.slice(Number(token), Number(token) + size)
    );
    Assert.ok(physicalBody.includes("Message-ID: <" + id + ">"));
  }
  Assert.equal(threadIds.size, 2, "The two semantic roots remain independent");
  Assert.equal(
    headers.get(imported.get(1)).author,
    '"Cicero Kutch" <cicero.kutch@invalid>'
  );
  Assert.equal(
    headers.get(imported.get(1)).recipients,
    "Ren\u00e9e Alsom <renee.alsom@invalid>"
  );
  Assert.equal(
    headers.get(imported.get(1)).date,
    new Date("2000-07-01T23:06:00Z").valueOf() * 1000
  );
  const readFlags =
    Ci.nsMsgMessageFlags.Read |
    (newKeys.has(readKey) ? Ci.nsMsgMessageFlags.New : 0);
  Assert.equal(headers.get(readKey).flags, readFlags);
  Assert.equal(
    headers.get(imported.get(1)).getStringProperty("keywords"),
    "$label5"
  );
  Assert.equal(
    headers.get(imported.get(3)).author,
    '"Zo\u00eb Yundt" <zoe.yundt@invalid>'
  );
  Assert.equal(headers.get(imported.get(3)).recipients, "");
  Assert.equal(
    headers.get(imported.get(3)).date,
    new Date("2022-09-13T05:40:00Z").valueOf() * 1000
  );
  const unreadFlags = newKeys.has(unreadKey) ? Ci.nsMsgMessageFlags.New : 0;
  Assert.equal(headers.get(unreadKey).flags, unreadFlags);
  Assert.equal(headers.get(imported.get(3)).getStringProperty("keywords"), "");
  Assert.equal(
    messageDB.getMessageProperty(imported.get(1), "sender_name"),
    "0|Cicero Kutch <cicero.kutch@invalid>"
  );
  Assert.equal(
    messageDB.getMessageProperty(imported.get(3), "sender_name"),
    '0|"Zoë Yundt" <zoe.yundt@invalid>'
  );
  Assert.equal(
    messageDB.getMessageProperty(imported.get(1), "growKeywords"),
    "1"
  );
  Assert.ok(
    [...headers.get(imported.get(1)).properties].includes("growKeywords")
  );
  Assert.ok(
    ![...headers.get(imported.get(3)).properties].includes("growKeywords")
  );
  Assert.equal(
    input.folder.msgDatabase.dBFolderInfo.getUint32Property("sortType", 0),
    18
  );
  Assert.equal(
    input.folder.msgDatabase.dBFolderInfo.getUint32Property("numHdrsToKeep", 0),
    2000
  );
  Assert.equal(
    input.folder.msgDatabase.dBFolderInfo.getCharProperty("MRUTime"),
    "1747364552"
  );
  Assert.equal(
    input.folder.msgDatabase.dBFolderInfo.getCharProperty("sortColumns"),
    "\x122"
  );
  Assert.deepEqual(
    await IOUtils.read(input.folder.summaryFile.path),
    summaryBytes
  );
  Assert.deepEqual(await IOUtils.read(input.folder.filePath.path), bodyBytes);
  Assert.deepEqual(
    await IOUtils.read(do_get_file("data/migration.msf").path),
    summaryBytes
  );
  Assert.deepEqual(
    await IOUtils.read(do_get_file("data/migration").path),
    bodyBytes
  );
  Assert.equal(
    await IOUtils.computeHexDigest(backup.path, "sha256"),
    backup.sha256
  );
  Assert.ok(
    !(await IOUtils.exists(
      PathUtils.join(lock.directory.path, "panorama-profile.json")
    ))
  );
  const original = messageDB.getMessage(control);
  Assert.equal(original.messageId, "native-control@invalid");
  Assert.equal(original.getStringReference(0), "control-parent@invalid");
}

/** @param {object} input - Actual native folder. @returns {{added: number[], close: function()}} Normal per-folder publication listener. */
function observe(input) {
  const db = input.folder.msgDatabase;
  const added = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrAdded(header) {
      added.push(header.messageKey);
    },
    onHdrDeleted() {},
    onHdrFlagsChanged() {},
    onParentChanged() {},
    onReadChanged() {},
    onJunkScoreChanged() {},
    onHdrPropertyChanged() {},
    onEvent() {},
    onAnnouncerGoingAway() {},
  };
  db.addListener(listener);
  let attached = true;
  const close = () => {
    if (attached) {
      db.removeListener(listener);
      attached = false;
    }
  };
  registerCleanupFunction(close);
  return { added, close };
}

add_task(async function test_completeReaderCoordinatorNativeImportAndRepeat() {
  const input = await planned("complete");
  const events = observe(input);
  await resumeMorkImports(input.journal, target(input));
  Assert.equal(input.journal.state.stage, "validate");
  await assertCommitted(input);
  const imported = new Map(input.journal.state.sources[0].receipt.keys);
  Assert.deepEqual(input.folder.msgDatabase.getNewList(), [imported.get(3)]);
  Assert.equal(
    input.folder.msgDatabase.getMsgHdrForKey(imported.get(3)).flags,
    Ci.nsMsgMessageFlags.New
  );
  Assert.deepEqual(events.added, [], "Import uses native quiet publication");
  const before = destination(input);
  const changes = rows("SELECT total_changes() AS value", ["value"]);
  await resumeMorkImports(input.journal, target(input));
  Assert.deepEqual(destination(input), before);
  Assert.deepEqual(rows("SELECT total_changes() AS value", ["value"]), changes);
  Assert.deepEqual(events.added, []);
  events.close();
});

add_task(async function test_reconcilesActualCommitAfterJournalReopen() {
  const input = await planned("checkpoint");
  await input.journal.beginImport(input.name);
  const events = observe(input);
  const committed = await database.importFolderSnapshot(
    input.folder,
    await request(input)
  );
  Assert.equal(input.journal.state.sources[0].state, "importing");
  Assert.equal(input.journal.state.sources[0].receipt, null);
  input.journal.close();
  input.journal = await MigrationJournal.open(input.path, lock.directory.path);
  registerCleanupFunction(() => input.journal.close());
  const changes = rows("SELECT total_changes() AS value", ["value"]);
  await resumeMorkImports(input.journal, target(input));
  Assert.deepEqual(input.journal.state.sources[0].receipt.keys, committed.keys);
  Assert.deepEqual(rows("SELECT total_changes() AS value", ["value"]), changes);
  Assert.deepEqual(
    events.added,
    [],
    "Reconciliation does not announce imported headers as new mail"
  );
  await assertCommitted(input);
  events.close();
});

add_task(async function test_actualReceiptFailureRollsBackBeforeRetry() {
  const input = await planned("rollback");
  const events = observe(input);
  const before = destination(input);
  const db = database.connectionForTests;
  const faults = [];
  db.createFunction("migration_native_receipt_fault", 2, {
    onFunctionCall(args) {
      faults.push([args.getInt32(0), args.getInt32(1)]);
      return 0;
    },
  });
  try {
    db.executeSimpleSQL(
      `CREATE TEMP TRIGGER migration_native_receipt_abort BEFORE INSERT ON folder_import_receipts WHEN NEW.folderId=${input.folder.id} BEGIN SELECT migration_native_receipt_fault((SELECT COUNT(*) FROM messages WHERE folderId=NEW.folderId),(SELECT COUNT(*) FROM message_properties p JOIN messages m ON m.id=p.id WHERE m.folderId=NEW.folderId)); SELECT RAISE(ABORT,'migration receipt fault'); END`
    );
    await Assert.rejects(
      resumeMorkImports(input.journal, target(input)),
      /NS_ERROR_STORAGE_CONSTRAINT/
    );
    Assert.equal(
      faults.length,
      1,
      "Real receipt insert fault reached after imported message/property work"
    );
    Assert.equal(faults[0][0], 2);
    Assert.greater(faults[0][1], 0);
    Assert.ok(!db.transactionInProgress);
    Assert.deepEqual(destination(input), before);
    Assert.deepEqual(events.added, []);
    Assert.equal(input.journal.state.sources[0].state, "importing");
    Assert.equal(input.journal.state.sources[0].receipt, null);
    const original = messageDB.getMessage(control);
    Assert.equal(original.messageId, "native-control@invalid");
    Assert.equal(original.getStringReference(0), "control-parent@invalid");
    Assert.deepEqual(
      await IOUtils.read(input.folder.summaryFile.path),
      summaryBytes
    );
    Assert.deepEqual(await IOUtils.read(input.folder.filePath.path), bodyBytes);
  } finally {
    db.executeSimpleSQL(
      "DROP TRIGGER IF EXISTS migration_native_receipt_abort"
    );
    db.removeFunction("migration_native_receipt_fault");
  }
  await resumeMorkImports(input.journal, target(input));
  await assertCommitted(input);
  Assert.deepEqual(events.added, []);
  const after = destination(input);
  await resumeMorkImports(input.journal, target(input));
  Assert.deepEqual(destination(input), after);
  Assert.deepEqual(events.added, []);
  events.close();
});

add_task(
  async function test_wrongIncarnationRefusesBeforeIntentOrNativeWrites() {
    const input = await planned("invalid", "different-native-database");
    const before = destination(input);
    const journal = await IOUtils.read(input.path);
    Assert.throws(() => target(input), /incarnation differs/);
    Assert.deepEqual(destination(input), before);
    Assert.deepEqual(await IOUtils.read(input.path), journal);
    Assert.equal(input.journal.state.sources[0].state, "pending");
  }
);

add_task(async function test_nativeInsertionAfterImportKeepsBothKeyMaps() {
  const input = await planned("insertion");
  const events = observe(input);
  await resumeMorkImports(input.journal, target(input));
  await assertCommitted(input);
  Assert.deepEqual(events.added, []);
  const receipt = input.journal.state.sources[0].receipt;
  const key = messageDB.addMessage(
    input.folder.id,
    "native-after-import@invalid",
    [],
    0,
    "",
    "",
    "",
    "",
    "Native after migration",
    0,
    "",
    Ci.nsMsgPriority.notSet
  );
  Assert.ok(key > 0 && key != control);
  Assert.ok(!receipt.keys.some(pair => pair[1] == key));
  Assert.equal(
    messageDB.getMessage(key).messageId,
    "native-after-import@invalid"
  );
  Assert.equal(Array.from(input.folder.messages).length, 3);
  Assert.deepEqual(
    events.added,
    [key],
    "The real listener observes native insertion"
  );
  events.close();
  Assert.deepEqual(
    database.getFolderImportReceipt(input.folder, await request(input)).keys,
    receipt.keys
  );
  Assert.deepEqual(
    await IOUtils.read(input.folder.summaryFile.path),
    summaryBytes
  );
  Assert.deepEqual(await IOUtils.read(input.folder.filePath.path), bodyBytes);
});

/**
 * Checks literal semantics and the independently reopened legacy measurements.
 * Joins each header by the receipt's original key before checking its ID.
 *
 * @param {object} input - One committed genuine References unit.
 * @returns {Promise<void>} Public fields, raw properties and untouched inputs.
 */
async function assertReferenceImport(input) {
  const source = input.journal.state.sources[0];
  const { spec, bytes } = input.reference;
  Assert.equal(source.state, "imported");
  Assert.equal(source.sha256, spec.sha256);
  Assert.ok(!database.connectionForTests.transactionInProgress);
  Assert.equal(source.databaseSourceId, database.sourceId);
  const native = database.getFolderImportReceipt(
    input.folder,
    await request(input)
  );
  Assert.ok(native, "Native API returns its committed receipt");
  Assert.equal(native.token, source.token);
  Assert.equal(native.sourceId, input.name);
  Assert.equal(native.sourceSha256, spec.sha256);
  Assert.equal(native.databaseSourceId, database.sourceId);
  Assert.equal(native.folderId, input.folder.id);
  Assert.deepEqual(native.keys, source.receipt.keys);
  Assert.deepEqual(
    native.keys.map(([key]) => key).sort((a, b) => a - b),
    legacyMeasurements.rows.map(row => row.physical.key).sort((a, b) => a - b)
  );
  const keys = new Map(native.keys);
  Assert.equal(new Set(keys.values()).size, 2);
  Assert.ok(
    [...keys.values()].every(
      key => key > 0 && key < 0xffffffff && key != control
    )
  );
  const headers = Array.from(input.folder.messages);
  const newKeys = new Set(input.folder.msgDatabase.getNewList());
  Assert.deepEqual(headers.map(h => h.messageId).sort(), [
    "162378@invalid",
    "345692@invalid",
  ]);
  const threadIds = new Set();
  for (const row of legacyMeasurements.rows) {
    const key = keys.get(row.physical.key);
    const header = input.folder.msgDatabase.getMsgHdrForKey(key);
    Assert.ok(header);
    Assert.equal(
      header.messageId,
      row.messageId,
      "Message-ID corroborates the physical-key join"
    );
    const first = row.messageId == "162378@invalid";
    Assert.equal(
      header.subject,
      first
        ? "Secured value-added orchestration"
        : "Intuitive full-range analyzer"
    );
    Assert.equal(
      header.author,
      first
        ? '"Cicero Kutch" <cicero.kutch@invalid>'
        : '"Zo\u00eb Yundt" <zoe.yundt@invalid>'
    );
    Assert.equal(
      header.recipients,
      first ? "Ren\u00e9e Alsom <renee.alsom@invalid>" : ""
    );
    Assert.equal(
      header.date,
      Date.parse(first ? "2000-07-01T23:06:00Z" : "2022-09-13T05:40:00Z") * 1000
    );
    const flags = first ? Ci.nsMsgMessageFlags.Read : 0;
    Assert.deepEqual(
      rows("SELECT flags FROM messages WHERE id=:id", ["flags"], { id: key }),
      [[flags]]
    );
    Assert.equal(
      header.flags,
      (flags | (newKeys.has(key) ? Ci.nsMsgMessageFlags.New : 0)) >>> 0
    );
    Assert.equal(header.getStringProperty("keywords"), first ? "$label5" : "");
    Assert.equal(header.priority, Ci.nsMsgPriority.none);
    Assert.equal(header.ccList, "");
    Assert.equal(header.bccList, "");
    Assert.equal(header.charset, "");
    Assert.equal(
      header.accountKey,
      MailServices.accounts.findAccountForServer(input.folder.server).key,
      "Absent account uses folder"
    );
    Assert.equal(header.folder.id, input.folder.id);
    Assert.equal(header.storeToken, row.physical.storeToken);
    Assert.equal(header.messageSize, row.physical.size);
    Assert.equal(header.lineCount, first ? 9 : 4);
    const refs = first ? [] : spec.references;
    Assert.equal(header.numReferences, refs.length);
    Assert.deepEqual(
      Array.from({ length: header.numReferences }, (_, i) =>
        header.getStringReference(i)
      ),
      refs
    );
    Assert.equal(header.getStringProperty("references"), first ? "" : spec.raw);
    Assert.deepEqual(
      rows(
        "SELECT ordinal,token FROM message_references WHERE id=:key ORDER BY ordinal",
        ["ordinal", "token"],
        { key }
      ),
      refs.map((token, ordinal) => [ordinal, token])
    );
    const present = new Set(header.properties);
    Assert.ok(
      present.has("references"),
      "No-References control retains its present-empty cell"
    );
    for (const [name, text] of Object.entries(row.properties)) {
      if (name == "keywords") {
        Assert.equal(header.getStringProperty(name), text);
      } else {
        Assert.ok(present.has(name), "Original property is present: " + name);
        Assert.strictEqual(
          messageDB.getMessageProperty(key, name),
          text,
          "Exact original text: " + name
        );
      }
    }
    for (const name of ["growKeywords", "recipients", "gloda-dirty"]) {
      Assert.equal(
        present.has(name),
        Object.hasOwn(row.properties, name),
        "Original presence: " + name
      );
    }
    for (const name of [
      "absent-import-property",
      "offlineMsgSize",
      "msgCharSet",
      "account",
    ]) {
      Assert.ok(
        !present.has(name),
        "No absent source property is invented: " + name
      );
    }
    Assert.equal(header.threadParent, 0);
    Assert.greater(header.threadId, 0);
    threadIds.add(header.threadId);
    Assert.equal(
      input.folder.msgDatabase
        .getThreadContainingMsgHdr(header)
        .getChildHdrAt(0).messageId,
      row.messageId
    );
    const body = new TextDecoder().decode(
      bodyBytes.slice(
        Number(row.physical.storeToken),
        Number(row.physical.storeToken) + row.physical.size
      )
    );
    Assert.ok(body.includes("Message-ID: <" + row.messageId + ">"));
  }
  Assert.equal(
    threadIds.size,
    2,
    "External ancestors leave two independent semantic roots"
  );
  Assert.ok(
    new TextDecoder().decode(bodyBytes).includes("Message-ID: <300894@invalid>")
  );
  Assert.ok(
    !headers.some(h => h.messageId == "300894@invalid"),
    "A deleted body record is not resurrected"
  );
  Assert.equal(
    input.folder.msgDatabase.dBFolderInfo.getUint32Property("sortType", 0),
    18
  );
  Assert.equal(
    input.folder.msgDatabase.dBFolderInfo.getUint32Property("numHdrsToKeep", 0),
    2000
  );
  Assert.equal(
    input.folder.msgDatabase.dBFolderInfo.getCharProperty("MRUTime"),
    "1747364552"
  );
  Assert.equal(
    input.folder.msgDatabase.dBFolderInfo.getCharProperty("sortColumns"),
    "\x122"
  );
  Assert.deepEqual(await IOUtils.read(input.folder.summaryFile.path), bytes);
  Assert.deepEqual(
    await IOUtils.read(do_get_file("data/" + spec.file + ".msf").path),
    bytes
  );
  Assert.deepEqual(await IOUtils.read(input.folder.filePath.path), bodyBytes);
  Assert.deepEqual(
    await IOUtils.read(do_get_file("data/migration").path),
    bodyBytes
  );
  Assert.equal(
    await IOUtils.computeHexDigest(backup.path, "sha256"),
    backup.sha256
  );
  Assert.equal(
    messageDB.getMessage(control).messageId,
    "native-control@invalid"
  );
  Assert.equal(
    messageDB.getMessage(control).getStringReference(0),
    "control-parent@invalid"
  );
  Assert.ok(
    !(await IOUtils.exists(
      PathUtils.join(lock.directory.path, "panorama-profile.json")
    ))
  );
}

add_task(async function test_genuineOrderedReferencesImportAndRepeat() {
  const input = await planned("references");
  const events = observe(input);
  await resumeMorkImports(input.journal, target(input));
  await assertReferenceImport(input);
  const before = destination(input);
  const changes = rows("SELECT total_changes() AS value", ["value"]);
  await resumeMorkImports(input.journal, target(input));
  Assert.deepEqual(destination(input), before);
  Assert.deepEqual(rows("SELECT total_changes() AS value", ["value"]), changes);
  Assert.deepEqual(events.added, []);
  events.close();
});

add_task(
  async function test_genuineDuplicateReferencesSurviveCheckpointReopen() {
    const input = await planned("duplicate-references");
    const events = observe(input);
    await resumeMorkImports(input.journal, target(input));
    const before = destination(input);
    input.journal.close();
    input.journal = await MigrationJournal.open(
      input.path,
      lock.directory.path
    );
    registerCleanupFunction(() => input.journal.close());
    await resumeMorkImports(input.journal, target(input));
    await assertReferenceImport(input);
    Assert.deepEqual(destination(input), before);
    Assert.deepEqual(events.added, []);
    events.close();
  }
);

add_task(async function test_projectionCannotReorderGenuineRawReferences() {
  const input = await planned("references-invalid");
  await input.journal.beginImport(input.name);
  const snapshot = await request(input);
  const oldKey = legacyMeasurements.rows.find(
    row => row.messageId == "345692@invalid"
  ).physical.key;
  const child = snapshot.messages.find(message => message.sourceKey == oldKey);
  Assert.equal(child.header.messageId, "345692@invalid");
  child.header.references.reverse();
  const before = destination(input);
  Assert.throws(
    () => database.importFolderSnapshot(input.folder, snapshot),
    error => error.result == Cr.NS_ERROR_INVALID_ARG
  );
  Assert.deepEqual(destination(input), before);
  Assert.ok(!database.connectionForTests.transactionInProgress);
  Assert.equal(input.journal.state.sources[0].receipt, null);
  Assert.deepEqual(
    await IOUtils.read(input.folder.summaryFile.path),
    input.reference.bytes
  );
  Assert.deepEqual(await IOUtils.read(input.folder.filePath.path), bodyBytes);
  await resumeMorkImports(input.journal, target(input));
  await assertReferenceImport(input);
});

add_task(
  async function test_receiptFailureRollsBackGenuineDuplicateReferences() {
    const input = await planned("references-rollback");
    const events = observe(input);
    const before = destination(input);
    const db = database.connectionForTests;
    const faults = [];
    db.createFunction("migration_references_fault", 2, {
      onFunctionCall(args) {
        faults.push([args.getInt32(0), args.getInt32(1)]);
        return 0;
      },
    });
    try {
      db.executeSimpleSQL(
        `CREATE TEMP TRIGGER migration_references_abort BEFORE INSERT ON folder_import_receipts WHEN NEW.folderId=${input.folder.id} BEGIN SELECT migration_references_fault((SELECT COUNT(*) FROM messages WHERE folderId=NEW.folderId),(SELECT COUNT(*) FROM message_references r JOIN messages m ON m.id=r.id WHERE m.folderId=NEW.folderId)); SELECT RAISE(ABORT,'migration References receipt fault'); END`
      );
      await Assert.rejects(
        resumeMorkImports(input.journal, target(input)),
        /NS_ERROR_STORAGE_CONSTRAINT/
      );
      Assert.deepEqual(
        faults,
        [[2, 4]],
        "Actual receipt fault follows both live rows and all four References"
      );
      Assert.deepEqual(destination(input), before);
      Assert.ok(!db.transactionInProgress);
      Assert.deepEqual(events.added, []);
      Assert.equal(input.journal.state.sources[0].receipt, null);
      Assert.equal(
        database.getFolderImportReceipt(input.folder, await request(input)),
        null
      );
      Assert.deepEqual(
        await IOUtils.read(input.folder.summaryFile.path),
        input.reference.bytes
      );
      Assert.deepEqual(
        await IOUtils.read(input.folder.filePath.path),
        bodyBytes
      );
      Assert.equal(
        messageDB.getMessage(control).messageId,
        "native-control@invalid"
      );
    } finally {
      db.executeSimpleSQL("DROP TRIGGER IF EXISTS migration_references_abort");
      db.removeFunction("migration_references_fault");
    }
    await resumeMorkImports(input.journal, target(input));
    await assertReferenceImport(input);
    const committed = destination(input);
    await resumeMorkImports(input.journal, target(input));
    Assert.deepEqual(destination(input), committed);
    Assert.deepEqual(events.added, []);
    events.close();
  }
);

/**
 * Commits through the real native receiver, leaving the journal before its
 * receipt checkpoint. All identities/keys come from the actual receipt.
 *
 * @param {string} name - Genuine fixture-backed unit.
 * @returns {Promise<object>} Original input, actual request and native receipt.
 */
async function nativeCommitBeforeCheckpoint(name) {
  const input = await planned(name);
  await input.journal.beginImport(name);
  const snapshot = await request(input);
  const receipt = await database.importFolderSnapshot(input.folder, snapshot);
  Assert.equal(input.journal.state.sources[0].state, "importing");
  Assert.equal(input.journal.state.sources[0].receipt, null);
  return { input, snapshot, receipt };
}

/** @param {object} input - Genuine unit. @returns {Promise<void>} Source bytes unchanged. */
async function assertProjectionSourcesUnchanged(input) {
  Assert.deepEqual(
    await IOUtils.read(input.folder.summaryFile.path),
    input.reference.bytes
  );
  Assert.deepEqual(await IOUtils.read(input.folder.filePath.path), bodyBytes);
}

add_task(
  async function test_projectionReadbackFailureKeepsActualCommitForRetry() {
    const { input, snapshot, receipt } =
      await nativeCommitBeforeCheckpoint("projection-subject");
    const [sourceKey, key] = receipt.keys[0];
    const expected = snapshot.messages.find(
      message => message.sourceKey == sourceKey
    ).header.subject;
    const header = messageDB.getMessage(key);
    const count = messageDB.totalCount;
    header.subject = "Changed after native commit";
    const changes = rows("SELECT total_changes() AS value", ["value"]);
    try {
      await Assert.rejects(
        resumeMorkImports(input.journal, target(input)),
        /message projection differs: subject/
      );
      Assert.equal(
        messageDB.totalCount,
        count,
        "The native commit is not called rolled back"
      );
      Assert.deepEqual(
        rows("SELECT total_changes() AS value", ["value"]),
        changes
      );
      Assert.equal(input.journal.state.sources[0].state, "importing");
      Assert.equal(input.journal.state.sources[0].receipt, null);
      Assert.deepEqual(
        database.getFolderImportReceipt(input.folder, snapshot),
        receipt
      );
      await assertProjectionSourcesUnchanged(input);
    } finally {
      header.subject = expected;
    }
    await resumeMorkImports(input.journal, target(input));
    Assert.equal(messageDB.totalCount, count);
    Assert.deepEqual(input.journal.state.sources[0].receipt.keys, receipt.keys);
    await assertReferenceImport(input);
  }
);

add_task(async function test_projectionReadbackChecksRawFlagsBehindPublicNew() {
  const input = await planned("flags");
  const events = observe(input);
  await input.journal.beginImport(input.name);
  const snapshot = await request(input);
  const receipt = await database.importFolderSnapshot(input.folder, snapshot);
  const key = new Map(receipt.keys).get(3);
  const db = input.folder.msgDatabase;
  const header = messageDB.getMessage(key);
  Assert.deepEqual(db.getNewList(), [key]);
  Assert.equal(header.flags, Ci.nsMsgMessageFlags.New);
  const count = messageDB.totalCount;
  for (const flags of [Ci.nsMsgMessageFlags.New, Ci.nsMsgMessageFlags.Marked]) {
    header.flags = flags;
    Assert.equal(header.flags, flags | Ci.nsMsgMessageFlags.New);
    Assert.deepEqual(
      rows("SELECT flags FROM messages WHERE id=:id", ["flags"], { id: key }),
      [[flags]]
    );
    const before = destination(input);
    const changes = rows("SELECT total_changes() AS value", ["value"]);
    try {
      await Assert.rejects(
        resumeMorkImports(input.journal, target(input)),
        /message projection differs: stored flags/
      );
      Assert.equal(messageDB.totalCount, count);
      Assert.deepEqual(destination(input), before);
      Assert.deepEqual(
        rows("SELECT total_changes() AS value", ["value"]),
        changes
      );
      Assert.equal(input.journal.state.sources[0].state, "importing");
      Assert.equal(input.journal.state.sources[0].receipt, null);
      Assert.deepEqual(
        database.getFolderImportReceipt(input.folder, snapshot),
        receipt
      );
    } finally {
      header.flags = 0;
      db.addToNewList(key);
    }
  }
  // NewList is transient facade state; clearing it must not change the imported
  // word or prevent recovery of the already committed receipt.
  db.clearNewList(false);
  Assert.equal(header.flags, 0);
  const before = destination(input);
  const changes = rows("SELECT total_changes() AS value", ["value"]);
  await resumeMorkImports(input.journal, target(input));
  Assert.equal(input.journal.state.stage, "validate");
  Assert.deepEqual(input.journal.state.sources[0].receipt.keys, receipt.keys);
  Assert.deepEqual(destination(input), before);
  Assert.deepEqual(rows("SELECT total_changes() AS value", ["value"]), changes);
  await resumeMorkImports(input.journal, target(input));
  Assert.deepEqual(destination(input), before);
  Assert.deepEqual(rows("SELECT total_changes() AS value", ["value"]), changes);
  Assert.deepEqual(events.added, []);
  Assert.deepEqual(
    await IOUtils.read(input.folder.summaryFile.path),
    summaryBytes
  );
  Assert.deepEqual(await IOUtils.read(input.folder.filePath.path), bodyBytes);
  events.close();
});

add_task(
  async function test_projectionReadbackRejectsReorderedDuplicateReferences() {
    const { input, snapshot, receipt } = await nativeCommitBeforeCheckpoint(
      "projection-duplicates"
    );
    const row = snapshot.messages.find(
      message => message.header.references.length == 4
    );
    Assert.ok(row, "Genuine duplicate-four References row was read");
    const key = new Map(receipt.keys).get(row.sourceKey);
    const header = messageDB.getMessage(key);
    header.setReferences(
      [...input.reference.spec.references]
        .reverse()
        .map(value => `<${value}>`)
        .join(" ")
    );
    const changes = rows("SELECT total_changes() AS value", ["value"]);
    try {
      await Assert.rejects(
        resumeMorkImports(input.journal, target(input)),
        /References ordinal/
      );
      Assert.deepEqual(
        rows("SELECT total_changes() AS value", ["value"]),
        changes
      );
      Assert.equal(input.journal.state.sources[0].receipt, null);
      Assert.deepEqual(
        database.getFolderImportReceipt(input.folder, snapshot),
        receipt
      );
      await assertProjectionSourcesUnchanged(input);
    } finally {
      header.setReferences(input.reference.spec.raw);
    }
    await resumeMorkImports(input.journal, target(input));
    Assert.deepEqual(input.journal.state.sources[0].receipt.keys, receipt.keys);
    await assertReferenceImport(input);
  }
);

add_task(
  async function test_projectionReadbackRejectsChangedPresentEmptyText() {
    const { input, snapshot, receipt } =
      await nativeCommitBeforeCheckpoint("projection-raw");
    const row = snapshot.messages.find(
      message => !message.header.references.length
    );
    Assert.ok(
      row.header.extras.some(({ k, v }) => k == "references" && v === "")
    );
    const header = messageDB.getMessage(
      new Map(receipt.keys).get(row.sourceKey)
    );
    header.setStringProperty("references", "\ufeffchanged\0e\u0301");
    const changes = rows("SELECT total_changes() AS value", ["value"]);
    try {
      await Assert.rejects(
        resumeMorkImports(input.journal, target(input)),
        /property references/
      );
      Assert.deepEqual(
        rows("SELECT total_changes() AS value", ["value"]),
        changes
      );
      Assert.equal(input.journal.state.sources[0].receipt, null);
      await assertProjectionSourcesUnchanged(input);
    } finally {
      header.setStringProperty("references", "");
    }
    await resumeMorkImports(input.journal, target(input));
    await assertReferenceImport(input);
  }
);

add_task(async function test_projectionReadbackRejectsInventedEmptyProperty() {
  const { input, snapshot, receipt } =
    await nativeCommitBeforeCheckpoint("projection-present");
  const header = messageDB.getMessage(receipt.keys[0][1]);
  Assert.ok(!header.properties.includes("validation-present-empty"));
  header.setStringProperty("validation-present-empty", "");
  Assert.ok(header.properties.includes("validation-present-empty"));
  const changes = rows("SELECT total_changes() AS value", ["value"]);
  await Assert.rejects(
    resumeMorkImports(input.journal, target(input)),
    /property presence differs/
  );
  Assert.deepEqual(rows("SELECT total_changes() AS value", ["value"]), changes);
  Assert.equal(input.journal.state.sources[0].receipt, null);
  Assert.deepEqual(
    database.getFolderImportReceipt(input.folder, snapshot),
    receipt
  );
  await assertProjectionSourcesUnchanged(input);
});

add_task(
  async function test_receiptLookupAfterCheckpointAllowsCurrentHeaderEdits() {
    const input = await planned("projection-after");
    await resumeMorkImports(input.journal, target(input));
    Assert.equal(input.journal.state.stage, "validate");
    const source = input.journal.state.sources[0];
    const header = messageDB.getMessage(source.receipt.keys[0][1]);
    const subject = header.subject;
    try {
      header.subject = "Legitimate current metadata after import stage";
      const changes = rows("SELECT total_changes() AS value", ["value"]);
      const journal = await IOUtils.read(input.path);
      const receipt = await target(input).findReceipt(source.token, {
        sourceId: source.id,
        sourceSha256: source.sha256,
        destinationFolderId: source.destinationFolderId,
      });
      Assert.deepEqual(receipt.keys, source.receipt.keys);
      Assert.deepEqual(
        rows("SELECT total_changes() AS value", ["value"]),
        changes
      );
      Assert.deepEqual(await IOUtils.read(input.path), journal);
      await assertProjectionSourcesUnchanged(input);
    } finally {
      header.subject = subject;
    }
  }
);

add_task(
  async function test_literalPercentReceiptRetryPreservesPhysicalIdentity() {
    const input = await planned("codec%2Fliteral");
    const sibling = folders.get("codec/literal");
    Assert.notEqual(input.folder.id, sibling.id);
    const path = folderDB.getFolderPath(input.folder.id);
    const siblingPath = folderDB.getFolderPath(sibling.id);
    Assert.ok(path.endsWith("/codec%252Fliteral"));
    Assert.ok(siblingPath.endsWith("/codec%2Fliteral"));
    Assert.notEqual(path, siblingPath);
    Assert.equal(folderDB.getFolderByPath(path), input.folder.id);
    Assert.equal(folderDB.getFolderByPath(siblingPath), sibling.id);

    await input.journal.beginImport(input.name);
    const snapshot = await request(input);
    const beforeCommit = await IOUtils.read(input.path);
    const first = await database.importFolderSnapshot(input.folder, snapshot);
    Assert.equal(first.folderId, input.folder.id);
    Assert.equal(first.sourceId, input.name);
    Assert.equal(first.databaseSourceId, database.sourceId);
    Assert.deepEqual(
      first.keys.map(pair => pair[0]),
      [1, 3]
    );
    Assert.deepEqual(await IOUtils.read(input.path), beforeCommit);
    Assert.equal(input.journal.state.sources[0].receipt, null);

    const events = observe(input);
    const page = messageDB.getSearchChanges(0, 1);
    Assert.ok(Number.isSafeInteger(page.watermark));
    try {
      Assert.deepEqual(
        database.getFolderImportReceipt(input.folder, snapshot),
        first
      );
      Assert.deepEqual(
        await database.importFolderSnapshot(input.folder, snapshot),
        first,
        "An unchanged public producer request returns the original mapping"
      );
      Assert.deepEqual(events.added, []);
      Assert.equal(messageDB.getSearchChanges(0, 1).watermark, page.watermark);

      const conflicts = [
        [
          { ...snapshot, sourceId: snapshot.sourceId + "-changed" },
          Cr.NS_ERROR_ALREADY_INITIALIZED,
        ],
        [
          {
            ...snapshot,
            databaseSourceId: snapshot.databaseSourceId + "-changed",
          },
          Cr.NS_ERROR_NOT_AVAILABLE,
        ],
        [
          {
            ...snapshot,
            source: { ...snapshot.source, sha256: "0".repeat(64) },
          },
          // Unix receipt lookup compares the recorded hash tuple; this is the
          // same conflict result asserted by the native historical-retry test.
          Cr.NS_ERROR_ALREADY_INITIALIZED,
        ],
        [
          {
            ...snapshot,
            source: { ...snapshot.source, path: sibling.summaryFile.path },
          },
          Cr.NS_ERROR_NOT_AVAILABLE,
        ],
      ];
      for (const [conflict, result] of conflicts) {
        Assert.throws(
          () => database.getFolderImportReceipt(input.folder, conflict),
          error => error.result == result
        );
      }
      Assert.throws(
        () => database.getFolderImportReceipt(sibling, snapshot),
        error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
        "A percent-looking sibling cannot supply another physical folder"
      );
      Assert.deepEqual(
        database.getFolderImportReceipt(input.folder, snapshot),
        first
      );
      Assert.deepEqual(await IOUtils.read(input.path), beforeCommit);
      Assert.equal(messageDB.getSearchChanges(0, 1).watermark, page.watermark);
      Assert.deepEqual(events.added, []);

      await resumeMorkImports(input.journal, target(input));
      await assertCommitted(input);
      Assert.deepEqual(input.journal.state.sources[0].receipt.keys, first.keys);
      const recorded = input.journal.state.sources[0].receipt;
      const changed = structuredClone(recorded);
      changed.keys[0][1] = control;
      const settled = await IOUtils.read(input.path);
      await Assert.rejects(
        input.journal.recordImport(input.name, changed),
        /Committed migration receipt changed/
      );
      Assert.deepEqual(await IOUtils.read(input.path), settled);
      input.journal.close();
      input.journal = await MigrationJournal.open(
        input.path,
        lock.directory.path
      );
      const reopened = input.journal;
      registerCleanupFunction(() => reopened.close());
      Assert.deepEqual(
        await target(input).findReceipt(recorded.token, {
          sourceId: input.name,
          sourceSha256: snapshot.source.sha256,
          destinationFolderId: input.folder.id,
        }),
        first,
        "The reopened journal validates the same actual native receipt"
      );
      await resumeMorkImports(input.journal, target(input));
      Assert.deepEqual(await IOUtils.read(input.path), settled);
      Assert.deepEqual(input.journal.state.sources[0].receipt, recorded);
      Assert.deepEqual(events.added, []);
      Assert.deepEqual(
        await IOUtils.read(input.folder.summaryFile.path),
        summaryBytes
      );
      Assert.deepEqual(
        await IOUtils.read(input.folder.filePath.path),
        bodyBytes
      );
    } finally {
      events.close();
    }
  }
);

/**
 * Plans all six byte-identical retained IMAP sources under the existing backup.
 * The captured readback ledger supplies assertions only, never converter input.
 *
 * @returns {Promise<object>} Owned journal, path and sorted complete source IDs.
 */
async function plannedImapUnit() {
  const sources = [];
  for (const [name, { saved, inventory }] of imapSourceFiles) {
    const folder = imapFolders.get(name);
    const input = await readMorkFolderImport(
      folder,
      "imap-plan-" + name,
      inventory
    );
    Assert.equal(input.source.sha256, saved.sha256);
    sources.push({
      id: name,
      protocol: "imap",
      originalFolderURI: saved.uri,
      databaseSourceId: database.sourceId,
      destinationFolderId: folder.id,
      ...input.source,
      ...(inventory ? { inventory } : {}),
    });
  }
  sources.sort((left, right) => left.id.localeCompare(right.id));
  const path = PathUtils.join(work, "genuine-imap-unit.json");
  const journal = await MigrationJournal.create(path, {
    profilePath: lock.directory.path,
    mailPaths: [],
    backupPath: PathUtils.parent(backup.path),
    sources,
  });
  const input = { journal, path, ids: sources.map(source => source.id) };
  registerCleanupFunction(() => input.journal.close());
  await journal.recordBackup(backup);
  return input;
}

/**
 * Creates the ordinary platform-specific target for the complete physical unit.
 *
 * @param {object} input - Current open journal and source IDs.
 * @returns {object} Native checked receipt and import methods.
 */
function imapTarget(input) {
  return createPanoramaMigrationTarget(
    input.journal,
    database,
    id => {
      Assert.ok(imapFolders.has(id));
      return imapFolders.get(id);
    },
    lock
  );
}

/**
 * Reconstructs a request solely from current retained source bytes and the plan.
 *
 * @param {object} input - Current complete journal unit.
 * @returns {Promise<object>} Version3 request with the original durable token.
 */
async function imapRequest(input) {
  const unit = input.journal.state.protocolUnits[0];
  const entries = [];
  for (const id of input.ids) {
    const source = input.journal.state.sources.find(value => value.id == id);
    const folder = imapFolders.get(id);
    const snapshot = await readMorkFolderImport(
      folder,
      source.token,
      source.inventory
    );
    entries.push({
      input: snapshot,
      source,
      folderFlags: folderDB.getFolderFlags(folder.id),
    });
  }
  return convertMorkProtocolUnit(entries, unit.token, database.sourceId);
}

/**
 * Checks actual committed headers, body streams, epoch and complete queue data.
 *
 * @param {object} input - Current complete journal unit.
 * @param {object} receipt - Exact committed native unit receipt.
 * @returns {Promise<void>} All physical/source and independent ledger checks pass.
 */
async function assertImapUnit(input, receipt) {
  Assert.equal(receipt.version, 3);
  Assert.equal(receipt.databaseSourceId, database.sourceId);
  Assert.equal(receipt.folders.length, imapLedger.members.length);
  const keysBySource = new Map(
    receipt.folders.map(member => [
      member.sourceId,
      new Map([...member.keys, ...member.imap.operationKeys]),
    ])
  );
  const allKeys = receipt.folders.flatMap(member =>
    [...member.keys, ...member.imap.operationKeys].map(([, key]) => key)
  );
  Assert.equal(
    new Set(allKeys).size,
    allKeys.length,
    "All physical keys are globally distinct"
  );
  const profileFile = do_get_profile().clone();
  profileFile.append("panorama.sqlite");
  const reopened = Services.storage.openUnsharedDatabase(profileFile);
  try {
    for (const member of receipt.folders) {
      const folder = imapFolders.get(member.sourceId);
      const saved = imapLedger.members.find(
        value => value.name == member.sourceId
      );
      Assert.equal(member.folderId, folder.id);
      Assert.equal(
        folder.msgDatabase.dBFolderInfo.imapUidValidity,
        saved.epoch
      );
      Assert.equal([...folder.messages].length, saved.headers.length);
      Assert.deepEqual(
        member.keys.map(([old]) => old).sort((a, b) => a - b),
        saved.headers.map(header => header.key).sort((a, b) => a - b)
      );
      for (const original of saved.headers) {
        const key = keysBySource.get(member.sourceId).get(original.key);
        const header = folder.msgDatabase.getMsgHdrForKey(key);
        Assert.equal(header.folder, folder);
        Assert.equal(header.messageKey, key);
        Assert.equal(header.messageId, original.messageId);
        Assert.equal(header.storeToken, original.storeToken);
        Assert.equal(header.messageSize, original.size);
        const nativeKey = saved.keyMap.find(
          ([, old]) => old == original.key
        )[0];
        const captured = saved.captured.find(
          value => value.nativeKey == nativeKey
        );
        Assert.equal(
          header.properties.includes("uidOnServer"),
          captured.uid !== null
        );
        if (captured.uid !== null) {
          Assert.equal(header.getUint32Property("uidOnServer"), captured.uid);
        }
        const stream = Cc[
          "@mozilla.org/scriptableinputstream;1"
        ].createInstance(Ci.nsIScriptableInputStream);
        stream.init(folder.getMsgInputStream(header));
        let body = "";
        try {
          while (stream.available()) {
            body += stream.read(stream.available());
          }
        } finally {
          stream.close();
        }
        Assert.equal(
          body,
          captured.body,
          "The original finished body is retained"
        );
        const statement = reopened.createStatement(
          "SELECT m.folderId, p.value AS uid, typeof(p.value) AS uidType " +
            "FROM messages m LEFT JOIN message_properties p " +
            "ON p.id = m.id AND p.name = 'uidOnServer' WHERE m.id = :key"
        );
        try {
          statement.params.key = key;
          Assert.ok(
            statement.executeStep(),
            "A fresh connection sees the committed physical row"
          );
          Assert.equal(statement.row.folderId, folder.id);
          Assert.equal(
            statement.row.uid,
            captured.uid === null ? null : captured.uid.toString(16),
            "A fresh connection sees the exact canonical UID property or absence"
          );
          Assert.equal(
            statement.row.uidType,
            captured.uid === null ? "null" : "text"
          );
          Assert.ok(!statement.executeStep());
        } finally {
          statement.finalize();
        }
      }
      const operations = folder.msgDatabase.QueryInterface(
        Ci.nsIMsgOfflineOpsDatabase
      );
      Assert.equal(
        operations.listAllOfflineOpIds().length,
        saved.operations.length
      );
      for (const original of saved.operations) {
        const mapped = member.imap.operations.find(
          value => value.sourceKey == original.messageKey
        );
        Assert.ok(mapped);
        Assert.greater(mapped.id, 0);
        Assert.greater(mapped.revision, 0);
        const operation = operations.getOfflineOpForKey(mapped.key, false);
        for (const property of [
          "operation",
          "flagOperation",
          "newFlags",
          "srcUid",
          "sourceFolderURI",
          "destinationFolderURI",
          "keywordsToAdd",
          "keywordsToRemove",
          "msgSize",
          "playingBack",
        ]) {
          Assert.equal(operation[property], original[property], property);
        }
        const source = imapLedger.members.find(
          value => value.uri == original.sourceFolderURI
        );
        const expectedSourceKey = source
          ? keysBySource.get(source.name).get(original.srcMessageKey)
          : original.srcMessageKey;
        Assert.equal(operation.srcMessageKey, expectedSourceKey);
        for (let ordinal = 0; ordinal < original.copies.length; ordinal++) {
          Assert.equal(
            operation.getCopyDestination(ordinal),
            original.copies[ordinal]
          );
        }
        Assert.throws(
          () => operation.getCopyDestination(original.copies.length),
          error =>
            [Cr.NS_ERROR_ILLEGAL_VALUE, Cr.NS_ERROR_INVALID_ARG].includes(
              error.result
            )
        );
      }
      Assert.equal(
        await IOUtils.computeHexDigest(folder.summaryFile.path, "sha256"),
        saved.sha256
      );
      Assert.equal(
        await IOUtils.computeHexDigest(folder.filePath.path, "sha256"),
        saved.bodies[0].sha256
      );
    }
  } finally {
    reopened.close();
  }
  Assert.ok(!database.connectionForTests.transactionInProgress);
}

add_task(async function test_genuineImapUnitCommitReopenAndReadOnlyRetry() {
  const input = await plannedImapUnit();
  await resumeMorkImports(input.journal, imapTarget(input));
  Assert.equal(input.journal.state.stage, "validate");
  const unitRequest = await imapRequest(input);
  const anchor = imapFolders.get(input.ids[0]);
  const receipt = database.getFolderImportReceipt(anchor, unitRequest);
  Assert.deepEqual(input.journal.state.protocolUnits[0].receipt, receipt);
  await assertImapUnit(input, receipt);
  const journalHash = await IOUtils.computeHexDigest(input.path, "sha256");
  const invalid = structuredClone(receipt);
  const invalidOperation = invalid.folders.flatMap(
    member => member.imap.operations
  )[0];
  Assert.ok(invalidOperation);
  invalidOperation.id = 0;
  await Assert.rejects(
    input.journal.recordImportUnit(receipt.token, invalid),
    error => error.message === "Native Mork offline payload/revision changed"
  );
  const rebound = structuredClone(receipt);
  const reboundOperation = rebound.folders.flatMap(
    member => member.imap.operations
  )[0];
  reboundOperation.revision++;
  await Assert.rejects(
    input.journal.recordImportUnit(receipt.token, rebound),
    error => error.message === "Committed migration protocol receipt changed"
  );
  Assert.equal(
    await IOUtils.computeHexDigest(input.path, "sha256"),
    journalHash
  );
  Assert.deepEqual(
    database.getFolderImportReceipt(anchor, unitRequest),
    receipt
  );
  input.journal.close();
  input.journal = await MigrationJournal.open(input.path, lock.directory.path);
  Assert.deepEqual(input.journal.state.protocolUnits[0].receipt, receipt);
  const before = database.connectionForTests.createStatement(
    "SELECT total_changes() AS value"
  );
  let changes;
  try {
    Assert.ok(before.executeStep());
    changes = before.row.value;
  } finally {
    before.finalize();
  }
  Assert.deepEqual(
    await database.importFolderSnapshot(anchor, unitRequest),
    receipt
  );
  Assert.deepEqual(
    database.getFolderImportReceipt(anchor, unitRequest),
    receipt
  );
  const after = database.connectionForTests.createStatement(
    "SELECT total_changes() AS value"
  );
  try {
    Assert.ok(after.executeStep());
    Assert.equal(
      after.row.value,
      changes,
      "Matching receipt retry does not allocate or requeue"
    );
  } finally {
    after.finalize();
  }
  await assertImapUnit(input, receipt);
});
