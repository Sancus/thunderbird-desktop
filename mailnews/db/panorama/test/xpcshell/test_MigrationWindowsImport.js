/* This Source Code Form is subject to the Mozilla Public
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
const Backup = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationBackup.sys.mjs"
);
const { MigrationJournal } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationJournal.sys.mjs"
);
const Reader = ChromeUtils.importESModule(
  "resource:///modules/panorama/MorkFolderImport.sys.mjs"
);
const Adapter = ChromeUtils.importESModule(
  "resource:///modules/panorama/MorkSnapshotAdapter.sys.mjs"
);
let work, lock, backup, summaryBytes, bodyBytes;
const inventories = new Map();
const folders = new Map();

const referenceInputs = new Map();
const REFERENCE_VARIANTS = [
  {
    name: "genuine-ordered-references",
    file: "deliveryMigrationReferences",
    sha256: "b7a621f2e71c328d1b22393d9760dbc84e0f6d40145eb4745da9881a3f4064c8",
    raw: "<ancestor@invalid>\r\n\t<parent@invalid> <nearest@invalid>",
    references: ["ancestor@invalid", "parent@invalid", "nearest@invalid"],
  },
  {
    name: "genuine-duplicate-references",
    file: "deliveryMigrationDuplicateReferences",
    sha256: "cf2b381c64436b231c1261751db590c7811355f3f4843c8ad0e5e4b1b6003962",
    raw: "<ancestor@invalid> <parent@invalid>\r\n\t<ancestor@invalid> <nearest@invalid>",
    references: [
      "ancestor@invalid",
      "parent@invalid",
      "ancestor@invalid",
      "nearest@invalid",
    ],
  },
];

add_setup(async function setupOriginalInventoryBeforeBackupAndNativeStartup() {
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
    "migration-windows-v2",
    "tests"
  );
  lock = nativeProfile.lock({});
  registerCleanupFunction(() => {
    lock.unlock();
    nativeProfile.remove(false);
  });
  work = await IOUtils.createUniqueDirectory(
    PathUtils.parent(profile.path),
    "migration-windows-v2-"
  );
  registerCleanupFunction(() => IOUtils.remove(work, { recursive: true }));
  summaryBytes = await IOUtils.read(do_get_file("data/migration.msf").path);
  bodyBytes = await IOUtils.read(do_get_file("data/migration").path);
  const summary = new FileUtils.File(PathUtils.join(work, "source.msf"));
  const body = new FileUtils.File(PathUtils.join(work, "source"));
  await IOUtils.write(summary.path, summaryBytes, { mode: "create" });
  await IOUtils.write(body.path, bodyBytes, { mode: "create" });
  const creator = new ProfileCreator(profile);
  const server = creator.addLocalServer();
  for (const name of [
    "commit",
    "bad-receipt",
    "legacy",
    "changed-body",
    "literal-root",
  ]) {
    const original = await server.rootFolder.addMailFolder(name, {
      summary,
      mbox: body,
    });
    inventories.set(
      name,
      Reader.captureMorkFolderWindowsInventory(
        new FileUtils.File(original.summaryFilePath),
        profile,
        new FileUtils.File(original.mailFilePath),
        profile
      )
    );
  }
  for (const spec of REFERENCE_VARIANTS) {
    const fixture = do_get_file("data/" + spec.file + ".msf");
    Assert.equal(
      await IOUtils.computeHexDigest(fixture.path, "sha256"),
      spec.sha256
    );
    const bytes = await IOUtils.read(fixture.path);
    const copy = new FileUtils.File(PathUtils.join(work, spec.file + ".msf"));
    await IOUtils.write(copy.path, bytes, { mode: "create" });
    const original = await server.rootFolder.addMailFolder(spec.name, {
      summary: copy,
      mbox: body,
    });
    inventories.set(
      spec.name,
      Reader.captureMorkFolderWindowsInventory(
        new FileUtils.File(original.summaryFilePath),
        profile,
        new FileUtils.File(original.mailFilePath),
        profile
      )
    );
    referenceInputs.set(spec.name, { ...spec, bytes });
  }
  Assert.ok(
    !(await IOUtils.exists(PathUtils.join(profile.path, "panorama.sqlite")))
  );
  backup = await Backup.createMigrationBackup(
    profile.path,
    [],
    PathUtils.join(work, "backup")
  );
  Assert.ok(
    !(await IOUtils.exists(PathUtils.join(profile.path, "panorama.sqlite")))
  );
  loadExistingDB();
  Assert.strictEqual(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    ),
    database
  );
  Assert.ok(database.sourceId);
  Assert.equal(MailServices.accounts.accounts.length, 1);
  const root = MailServices.accounts.localFoldersServer.rootFolder;
  for (const name of inventories.keys()) {
    const folder = root.getChildNamed(name);
    Assert.ok(folder, "Actual native destination exists: " + name);
    Assert.equal(folder.incomingServerType, "none");
    Assert.equal(folder.msgStore.storeType, "mbox");
    folders.set(name, folder);
  }
});

/** @param {string} name - Separate original/destination. @param {object} [saved=backup] - Verified backup. @returns {Promise<object>} Real journal and native folder. */
async function planned(name, saved = backup) {
  const folder = folders.get(name);
  const inventory = inventories.get(name);
  const snapshot = await Reader.readMorkFolderImport(
    folder,
    "planning",
    inventory
  );
  const path = PathUtils.join(work, name + ".json");
  const journal = await MigrationJournal.create(path, {
    profilePath: lock.directory.path,
    mailPaths: [],
    backupPath: PathUtils.parent(saved.path),
    sources: [
      {
        id: name,
        databaseSourceId: database.sourceId,
        ...snapshot.source,
        inventory,
        destinationFolderId: folder.id,
      },
    ],
  });
  const result = { folder, inventory, path, journal };
  registerCleanupFunction(() => result.journal.close());
  return result;
}

add_task(async function test_nativeReceiptSurvivesCheckpointRestartAndRepeat() {
  const input = await planned("commit");
  await input.journal.recordBackup(backup);
  Assert.equal(input.journal.state.version, 4);
  Assert.equal((await IOUtils.readJSON(backup.path)).version, 3);
  await input.journal.beginImport("commit");
  const receipt = await Adapter.importMorkFolderSnapshot(
    database,
    input.folder,
    input.journal.state.sources[0]
  );
  Assert.equal(receipt.version, 2);
  Assert.deepEqual(
    receipt.windowsAdmission,
    Reader.validateMorkFolderWindowsInventory(input.inventory)
  );
  Assert.deepEqual(
    receipt.keys.map(pair => pair[0]),
    [1, 3]
  );
  Assert.equal(new Set(receipt.keys.map(pair => pair[1])).size, 2);
  await input.journal.recordImport("commit", receipt);
  input.journal.close();
  input.journal = await MigrationJournal.open(input.path, lock.directory.path);
  Assert.deepEqual(input.journal.state.sources[0].inventory, input.inventory);
  Assert.deepEqual(
    input.journal.state.sources[0].receipt.windowsAdmission,
    receipt.windowsAdmission
  );
  Assert.deepEqual(
    input.journal.state.sources[0].receipt.sourcePhysicalIdentity,
    receipt.sourcePhysicalIdentity
  );
  const before = await IOUtils.read(input.path);
  const repeated = await Adapter.importMorkFolderSnapshot(
    database,
    input.folder,
    input.journal.state.sources[0]
  );
  Assert.deepEqual(repeated, receipt);
  await input.journal.recordImport("commit", repeated);
  Assert.deepEqual(await IOUtils.read(input.path), before);
  Assert.deepEqual(
    Array.from(input.folder.messages, message => [
      message.messageId,
      message.storeToken,
      message.messageSize,
    ]).sort((a, b) => a[0].localeCompare(b[0])),
    [
      ["162378@invalid", "0", 578],
      ["345692@invalid", "1143", 375],
    ]
  );
  Assert.deepEqual(
    await IOUtils.read(input.folder.summaryFile.path),
    summaryBytes
  );
  Assert.deepEqual(await IOUtils.read(input.folder.filePath.path), bodyBytes);
  await input.journal.finishStage("import");
  const validated = await IOUtils.read(input.path);
  await Assert.rejects(
    input.journal.finishStage("validate"),
    /Windows migration activation remains held/
  );
  Assert.deepEqual(await IOUtils.read(input.path), validated);
});

add_task(async function test_changedNativeReceiptCannotCheckpointOrRebind() {
  const input = await planned("bad-receipt");
  await input.journal.recordBackup(backup);
  await input.journal.beginImport("bad-receipt");
  const receipt = await Adapter.importMorkFolderSnapshot(
    database,
    input.folder,
    input.journal.state.sources[0]
  );
  const changed = structuredClone(receipt);
  changed.windowsAdmission.store.rootId = "0".repeat(16) + ":" + "0".repeat(32);
  const before = await IOUtils.read(input.path);
  await Assert.rejects(
    input.journal.recordImport("bad-receipt", changed),
    /differs from original inventory/
  );
  Assert.deepEqual(await IOUtils.read(input.path), before);
  Assert.equal(input.journal.state.sources[0].state, "importing");
  const recovered = await Adapter.importMorkFolderSnapshot(
    database,
    input.folder,
    input.journal.state.sources[0]
  );
  Assert.deepEqual(
    recovered,
    receipt,
    "Actual native receipt reconciles the already committed unit"
  );
  await input.journal.recordImport("bad-receipt", recovered);
  Assert.equal(input.folder.getTotalMessages(false), 2);
  Assert.deepEqual(
    await IOUtils.read(input.folder.summaryFile.path),
    summaryBytes
  );
  Assert.deepEqual(await IOUtils.read(input.folder.filePath.path), bodyBytes);
});

add_task(
  async function test_oldProgressAndBackupRemainUntouchedWithoutUpgrade() {
    const oldBackup = PathUtils.join(work, "backup2");
    await IOUtils.copy(PathUtils.parent(backup.path), oldBackup, {
      recursive: true,
      noOverwrite: true,
    });
    const oldPath = PathUtils.join(oldBackup, "manifest.json");
    const manifest = await IOUtils.readJSON(oldPath);
    manifest.version = 2;
    delete manifest.originalRoots;
    await IOUtils.writeJSON(oldPath, manifest);
    const oldBytes = await IOUtils.read(oldPath);
    const verified = await Backup.verifyMigrationBackup(oldBackup);
    await Assert.rejects(
      Backup.createMigrationBackup(lock.directory.path, [], oldBackup),
      /format cannot be resumed/
    );
    Assert.deepEqual(await IOUtils.read(oldPath), oldBytes);
    const input = await planned("legacy", verified);
    const before = await IOUtils.read(input.path);
    await Assert.rejects(
      input.journal.recordBackup(verified),
      /requires backup3/
    );
    Assert.deepEqual(await IOUtils.read(input.path), before);
    const legacy = input.journal.state;
    legacy.version = 3;
    delete legacy.originalRoots;
    delete legacy.sources[0].inventory;
    const legacyPath = PathUtils.join(work, "journal3.json");
    await IOUtils.writeJSON(legacyPath, legacy, { mode: "create" });
    const original = await IOUtils.read(legacyPath);
    await Assert.rejects(
      MigrationJournal.open(legacyPath, lock.directory.path),
      /unsupported migration journal/
    );
    Assert.deepEqual(await IOUtils.read(legacyPath), original);
    Assert.deepEqual(
      await IOUtils.read(input.folder.summaryFile.path),
      summaryBytes
    );
    Assert.deepEqual(await IOUtils.read(input.folder.filePath.path), bodyBytes);
  }
);

add_task(async function test_changedBodyCannotBindTheOriginalBackup() {
  const input = await planned("changed-body");
  const before = await IOUtils.read(input.path);
  const total = messageDB.totalCount;
  await IOUtils.write(input.folder.filePath.path, new Uint8Array([0]), {
    mode: "append",
  });
  await Assert.rejects(
    input.journal.recordBackup(backup),
    /body store differs from verified backup/
  );
  Assert.deepEqual(await IOUtils.read(input.path), before);
  Assert.equal(input.journal.state.stage, "backup");
  Assert.equal(
    messageDB.totalCount,
    total,
    "Earlier committed imports are preserved"
  );
  Assert.deepEqual(
    await IOUtils.read(input.folder.summaryFile.path),
    summaryBytes
  );
  const manifest = await IOUtils.readJSON(backup.path);
  const root = manifest.roots[0];
  const entry = root.entries.find(file =>
    new FileUtils.File(PathUtils.join(root.source, ...file.parts)).equals(
      input.folder.filePath
    )
  );
  Assert.ok(entry, "The original body has an exact physical backup entry");
  Assert.deepEqual(
    await IOUtils.read(
      PathUtils.join(
        PathUtils.parent(backup.path),
        root.directory,
        ...entry.parts
      )
    ),
    bodyBytes,
    "The immutable backup preserves the original body"
  );
});

add_task(async function test_receiptCannotRebindAnEquivalentRootSpelling() {
  const input = await planned("literal-root");
  await input.journal.recordBackup(backup);
  await input.journal.beginImport("literal-root");
  const receipt = await Adapter.importMorkFolderSnapshot(
    database,
    input.folder,
    input.journal.state.sources[0]
  );
  const changed = structuredClone(receipt);
  const path = changed.windowsAdmission.summary;
  const drive = path.originalRoot[0];
  path.originalRoot =
    (drive === drive.toUpperCase()
      ? drive.toLowerCase()
      : drive.toUpperCase()) + path.originalRoot.slice(1);
  const fs = Cc[
    "@mozilla.org/mailnews/panorama-migration-file-system;1"
  ].getService(Ci.nsIPanoramaMigrationFileSystem);
  const alias = fs.admit(
    new FileUtils.File(path.originalPath),
    new FileUtils.File(path.originalRoot),
    fs.KIND_FILE
  );
  try {
    Assert.equal(
      alias.rootIdentity,
      path.rootId,
      "The alias names the same physical root"
    );
  } finally {
    alias.close();
  }
  const before = await IOUtils.read(input.path);
  await Assert.rejects(
    input.journal.recordImport("literal-root", changed),
    /differs from original inventory/
  );
  Assert.deepEqual(await IOUtils.read(input.path), before);
  const recovered = await Adapter.importMorkFolderSnapshot(
    database,
    input.folder,
    input.journal.state.sources[0]
  );
  Assert.deepEqual(
    recovered,
    receipt,
    "Native stored original spelling survives lookup"
  );
  await input.journal.recordImport("literal-root", recovered);
  Assert.deepEqual(
    await IOUtils.read(input.folder.summaryFile.path),
    summaryBytes
  );
  Assert.deepEqual(await IOUtils.read(input.folder.filePath.path), bodyBytes);
});

add_task(async function test_genuineReferencesRetainWindowsThreadsAndRetry() {
  for (const [name, spec] of referenceInputs) {
    const input = await planned(name);
    await input.journal.recordBackup(backup);
    await input.journal.beginImport(name);
    const receipt = await Adapter.importMorkFolderSnapshot(
      database,
      input.folder,
      input.journal.state.sources[0]
    );
    Assert.equal(receipt.version, 2);
    Assert.equal(receipt.sourceId, name);
    Assert.equal(receipt.databaseSourceId, database.sourceId);
    Assert.equal(receipt.sourceSha256, spec.sha256);
    Assert.equal(receipt.folderId, input.folder.id);
    Assert.deepEqual(
      receipt.windowsAdmission,
      Reader.validateMorkFolderWindowsInventory(input.inventory)
    );
    Assert.deepEqual(
      receipt.keys.map(pair => pair[0]),
      [1, 3]
    );
    const keys = new Map(receipt.keys);
    Assert.equal(new Set(keys.values()).size, 2);
    Assert.ok(!database.connectionForTests.transactionInProgress);
    Assert.deepEqual(
      Array.from(input.folder.messages, header => header.messageId).sort(),
      ["162378@invalid", "345692@invalid"]
    );
    const threadIds = new Set();
    for (const [oldKey, id, token, size] of [
      [1, "162378@invalid", "0", 578],
      [3, "345692@invalid", "1143", 375],
    ]) {
      const key = keys.get(oldKey);
      Assert.greater(key, 0);
      Assert.less(key, 0xffffffff);
      const header = input.folder.msgDatabase.getMsgHdrForKey(key);
      Assert.equal(
        header.messageId,
        id,
        "Message-ID corroborates the physical-key join"
      );
      Assert.equal(header.folder.id, input.folder.id);
      Assert.equal(header.storeToken, token);
      Assert.equal(header.messageSize, size);
      Assert.equal(
        header.author,
        oldKey == 1
          ? '"Cicero Kutch" <cicero.kutch@invalid>'
          : '"Zo\u00eb Yundt" <zoe.yundt@invalid>'
      );
      Assert.equal(
        header.recipients,
        oldKey == 1 ? "Ren\u00e9e Alsom <renee.alsom@invalid>" : ""
      );
      Assert.equal(
        header.accountKey,
        MailServices.accounts.findAccountForServer(input.folder.server).key
      );
      const expected = oldKey == 1 ? [] : spec.references;
      const raw = oldKey == 1 ? "" : spec.raw;
      Assert.equal(header.numReferences, expected.length);
      Assert.deepEqual(
        Array.from({ length: header.numReferences }, (_, ordinal) =>
          header.getStringReference(ordinal)
        ),
        expected
      );
      Assert.ok(new Set(header.properties).has("references"));
      Assert.equal(header.getStringProperty("references"), raw);
      const references = database.connectionForTests.createStatement(
        "SELECT ordinal,token FROM message_references WHERE id=:key ORDER BY ordinal"
      );
      try {
        references.params.key = key;
        const rows = [];
        while (references.executeStep()) {
          rows.push([references.row.ordinal, references.row.token]);
        }
        Assert.deepEqual(
          rows,
          expected.map((value, ordinal) => [ordinal, value])
        );
      } finally {
        references.finalize();
      }
      const property = database.connectionForTests.createStatement(
        "SELECT value,typeof(value) AS kind FROM message_properties WHERE id=:key AND name='references'"
      );
      try {
        property.params.key = key;
        Assert.ok(
          property.executeStep(),
          "Present-empty is a real property row"
        );
        Assert.strictEqual(property.row.value, raw);
        Assert.equal(property.row.kind, "text");
        Assert.ok(!property.executeStep());
      } finally {
        property.finalize();
      }
      Assert.equal(header.threadParent, 0);
      Assert.greater(header.threadId, 0);
      threadIds.add(header.threadId);
      Assert.equal(
        input.folder.msgDatabase
          .getThreadContainingMsgHdr(header)
          .getChildHdrAt(0).messageKey,
        key
      );
      Assert.ok(
        new TextDecoder()
          .decode(bodyBytes.slice(Number(token), Number(token) + size))
          .includes("Message-ID: <" + id + ">")
      );
    }
    Assert.equal(
      threadIds.size,
      2,
      "External ancestors preserve two independent roots"
    );
    await input.journal.recordImport(name, receipt);
    input.journal.close();
    input.journal = await MigrationJournal.open(
      input.path,
      lock.directory.path
    );
    const state = input.journal.state;
    const before = await IOUtils.read(input.path);
    const changes = database.connectionForTests.createStatement(
      "SELECT total_changes() AS value"
    );
    try {
      Assert.ok(changes.executeStep());
      const count = changes.row.value;
      changes.reset();
      const repeated = await Adapter.importMorkFolderSnapshot(
        database,
        input.folder,
        input.journal.state.sources[0]
      );
      Assert.deepEqual(repeated, receipt);
      await input.journal.recordImport(name, repeated);
      Assert.ok(changes.executeStep());
      Assert.equal(changes.row.value, count, "Native retry is read-only");
    } finally {
      changes.finalize();
    }
    Assert.deepEqual(input.journal.state, state);
    Assert.deepEqual(await IOUtils.read(input.path), before);
    Assert.equal(input.folder.getTotalMessages(false), 2);
    Assert.deepEqual(
      await IOUtils.read(input.folder.summaryFile.path),
      spec.bytes
    );
    Assert.deepEqual(await IOUtils.read(input.folder.filePath.path), bodyBytes);
    Assert.deepEqual(
      await IOUtils.read(do_get_file("data/" + spec.file + ".msf").path),
      spec.bytes
    );
    Assert.deepEqual(
      await Backup.verifyMigrationBackup(PathUtils.parent(backup.path)),
      backup
    );
    input.journal.close();
  }
});
