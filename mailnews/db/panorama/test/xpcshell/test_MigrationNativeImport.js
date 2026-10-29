/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */

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
const { readMorkFolderImport } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MorkFolderImport.sys.mjs"
);
const { convertMorkFolderSnapshot } = ChromeUtils.importESModule(
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
    folders: ["references", "references-invalid"],
    raw: "<ancestor@invalid>\r\n\t<parent@invalid> <nearest@invalid>",
    references: ["ancestor@invalid", "parent@invalid", "nearest@invalid"],
  },
  {
    file: "deliveryMigrationDuplicateReferences",
    sha256: "cf2b381c64436b231c1261751db590c7811355f3f4843c8ad0e5e4b1b6003962",
    folders: ["duplicate-references", "references-rollback"],
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
];

add_setup(async function setupBackedUpLegacyProfileBeforeNativeStartup() {
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
  const root = MailServices.accounts.localFoldersServer.rootFolder;
  for (const name of [...names, ...referenceInputs.keys()]) {
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
      "SELECT id,messageId FROM messages WHERE folderId=:folder ORDER BY id",
      ["id", "messageId"],
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
  Assert.equal(headers.get(imported.get(1)).flags, Ci.nsMsgMessageFlags.Read);
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
  Assert.equal(headers.get(imported.get(3)).flags, 0);
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
    Assert.equal(header.flags, first ? Ci.nsMsgMessageFlags.Read : 0);
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
