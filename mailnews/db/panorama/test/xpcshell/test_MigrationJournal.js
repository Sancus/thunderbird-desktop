/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
const {
  admitWindowsMigrationPath,
  hashMigrationFile,
  readMorkMigrationSource,
} = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationSource.sys.mjs"
);
const { MigrationJournal } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationJournal.sys.mjs"
);
const {
  createMigrationBackup,
  verifyMigrationBackup,
  stageMigrationRestore,
  collectMigrationRoots,
} = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationBackup.sys.mjs"
);

const { resumeMorkImports } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationCoordinator.sys.mjs"
);

async function migrationFiles() {
  const root = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "migration-journal-"
  );
  registerCleanupFunction(() => IOUtils.remove(root, { recursive: true }));
  const profilePath = PathUtils.join(root, "profile");
  const mailPath = PathUtils.join(root, "external-mail");
  await IOUtils.makeDirectory(profilePath);
  await IOUtils.makeDirectory(mailPath);
  await IOUtils.writeUTF8(
    PathUtils.join(profilePath, "prefs.js"),
    'user_pref("mail.test", true);'
  );
  const path = PathUtils.join(mailPath, "Inbox.msf");
  await IOUtils.copy(do_get_file("data/migration.msf").path, path);
  await IOUtils.copy(
    do_get_file("data/migration").path,
    PathUtils.join(mailPath, "Inbox")
  );
  const plan = {
    profilePath,
    mailPaths: [mailPath],
    backupPath: PathUtils.join(root, "backup"),
    sources: [
      {
        id: "folder-source",
        path,
        size: (await IOUtils.stat(path)).size,
        sha256: await IOUtils.computeHexDigest(path, "sha256"),
        messageKeys: [1, 3],
        destinationFolderId: 9,
      },
    ],
  };
  if (AppConstants.platform == "win") {
    const { captureMorkFolderWindowsInventory } = ChromeUtils.importESModule(
      "resource:///modules/panorama/MorkFolderImport.sys.mjs"
    );
    plan.sources[0].databaseSourceId = "journal-unit-without-native-target";
    plan.sources[0].inventory = captureMorkFolderWindowsInventory(
      new FileUtils.File(path),
      new FileUtils.File(mailPath),
      new FileUtils.File(PathUtils.join(mailPath, "Inbox")),
      new FileUtils.File(mailPath)
    );
  }
  return { root, plan, path: PathUtils.join(root, "journal.json") };
}

/**
 * @param {string} path - Existing explicit input directory.
 * @returns {string} Admitted Windows or normalized Unix spelling for comparisons.
 */
function canonicalRoot(path) {
  const file = new FileUtils.File(path);
  if (AppConstants.platform == "win") {
    const lease = admitWindowsMigrationPath(
      file,
      Ci.nsIPanoramaMigrationFileSystem.KIND_DIRECTORY
    );
    try {
      return lease.canonicalPath;
    } finally {
      lease.close();
    }
  }
  file.normalize();
  return file.path;
}

/**
 * Models native receipt metadata for these journal-only unit seams. This does
 * not prove a native commit; test_MigrationWindowsImport uses the real receiver.
 *
 * @param {MigrationJournal} journal - Actual filesystem-bound unit journal.
 * @returns {object} Required Windows envelope fields, or unchanged Unix fields.
 */
function physicalReceiptModel(journal) {
  if (AppConstants.platform != "win") {
    return {};
  }
  const source = journal.state.sources[0];
  const { validateMorkFolderWindowsInventory } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MorkFolderImport.sys.mjs"
  );
  return {
    version: 2,
    sourceId: source.id,
    databaseSourceId: source.databaseSourceId,
    windowsAdmission: validateMorkFolderWindowsInventory(source.inventory),
  };
}

add_task(async function test_hashingAndBackupDoNotOpenProfileNSSStores() {
  const profile = do_get_profile();
  const hadUserPref = Services.prefs.prefHasUserValue("security.nocertdb");
  const noCertDB = Services.prefs.getBoolPref("security.nocertdb", false);
  Services.prefs.setBoolPref("security.nocertdb", false);
  const root = await IOUtils.createUniqueDirectory(
    do_get_tempdir().path,
    "migration-hash-"
  );
  registerCleanupFunction(() => IOUtils.remove(root, { recursive: true }));
  const source = PathUtils.join(profile.path, "migration-hash.msf");
  const empty = PathUtils.join(profile.path, "migration-hash-empty");
  const multi = PathUtils.join(profile.path, "migration-hash-multiple");
  const assertNoStores = async () => {
    for (const name of ["cert9.db", "key4.db"]) {
      Assert.ok(
        !(await IOUtils.exists(PathUtils.join(profile.path, name))),
        "Migration hashing must not open profile NSS storage: " + name
      );
    }
  };
  try {
    await assertNoStores();
    await IOUtils.write(
      source,
      await IOUtils.read(do_get_file("data/migration.msf").path),
      { mode: "create" }
    );
    await IOUtils.write(empty, new Uint8Array(), { mode: "create" });
    await IOUtils.write(multi, new Uint8Array(1024 * 1024 + 17).fill(0x61), {
      mode: "create",
    });
    Assert.equal(
      await hashMigrationFile(empty),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    await assertNoStores();
    Assert.equal(
      await hashMigrationFile(multi),
      "c26032d5154f96bd29c799447d715ab681d8d0aa308ecc6f321a35d98f0672da"
    );
    const { identity } = await readMorkMigrationSource(source);
    Assert.equal(
      identity.sha256,
      "7a262023b98fe964d105de06bf1ddca60f90ee19073e38afda8c885be5a47703"
    );
    await assertNoStores();
    const backupPath = PathUtils.join(root, "backup");
    const receipt = await createMigrationBackup(profile.path, [], backupPath);
    Assert.deepEqual(await verifyMigrationBackup(backupPath), receipt);
    await assertNoStores();
    Assert.ok((await IOUtils.read(multi)).every(value => value == 0x61));
    Assert.deepEqual(
      await IOUtils.read(source),
      await IOUtils.read(do_get_file("data/migration.msf").path)
    );
    await Assert.rejects(hashMigrationFile("relative"), /must be absolute/);
    await Assert.rejects(hashMigrationFile(root), /Unsupported migration hash/);
    await Assert.rejects(
      hashMigrationFile(PathUtils.join(root, "missing")),
      error => error.name == "NotFoundError"
    );
  } finally {
    for (const path of [source, empty, multi]) {
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
    if (hadUserPref) {
      Services.prefs.setBoolPref("security.nocertdb", noCertDB);
    } else {
      Services.prefs.clearUserPref("security.nocertdb");
    }
  }
});

add_task(async function test_backupVerifiesNestedPathComponents() {
  const { plan } = await migrationFiles();
  const nested = PathUtils.join(plan.mailPaths[0], "nested");
  await IOUtils.makeDirectory(nested);
  const source = PathUtils.join(nested, "Inbox.msf");
  await IOUtils.copy(plan.sources[0].path, source);
  const original = await IOUtils.read(source);
  const backup = await createMigrationBackup(
    plan.profilePath,
    plan.mailPaths,
    plan.backupPath
  );
  Assert.equal(
    (await verifyMigrationBackup(plan.backupPath)).sha256,
    backup.sha256
  );
  Assert.deepEqual(
    await IOUtils.read(
      PathUtils.join(plan.backupPath, "root-1", "nested", "Inbox.msf")
    ),
    original
  );
  Assert.deepEqual(await IOUtils.read(source), original);
});

add_task(async function test_backupRejectsParentPathComponents() {
  const { plan } = await migrationFiles();
  const source = await IOUtils.read(plan.sources[0].path);
  const backup = await createMigrationBackup(
    plan.profilePath,
    plan.mailPaths,
    plan.backupPath
  );
  const manifest = await IOUtils.readJSON(backup.path);
  manifest.roots[0].entries[0].parts = ["..", "escaped"];
  await IOUtils.writeJSON(backup.path, manifest);
  await Assert.rejects(
    verifyMigrationBackup(plan.backupPath),
    /Invalid backup entry path/
  );
  Assert.ok(
    !(await IOUtils.exists(PathUtils.join(plan.backupPath, "escaped")))
  );
  Assert.deepEqual(await IOUtils.read(plan.sources[0].path), source);
});

/**
 * Models only the free-space query on the destination parent. Every source,
 * admission and copy still receives real native file objects. This does not
 * model a physically full disk.
 *
 * @param {object} sinon - Existing Sinon helper.
 * @param {string} parentPath - Actual canonical destination parent path.
 * @param {Function} readSpace - Modeled result or thrown query error.
 * @returns {object} Stub to restore in finally.
 */
function stubBackupVolumeSpace(sinon, parentPath, readSpace) {
  const File = FileUtils.File;
  const parent = new File(parentPath);
  return sinon.stub(FileUtils, "File").callsFake(function (path) {
    const file = new File(path);
    if (file.equals(parent)) {
      return {
        get diskSpaceAvailable() {
          return readSpace(file);
        },
      };
    }
    return file;
  });
}

add_task(
  async function test_freshBackupRefusesInsufficientFileBytesBeforeCreatingOutput() {
    const { sinon } = ChromeUtils.importESModule(
      "resource://testing-common/Sinon.sys.mjs"
    );
    const { root, plan } = await migrationFiles();
    const paths = [
      PathUtils.join(plan.profilePath, "prefs.js"),
      plan.sources[0].path,
      PathUtils.join(plan.mailPaths[0], "Inbox"),
    ];
    const originals = await Promise.all(paths.map(path => IOUtils.read(path)));
    const required = originals.reduce((sum, bytes) => sum + bytes.length, 0);
    let queries = 0;
    const parent = new FileUtils.File(canonicalRoot(root));
    const space = stubBackupVolumeSpace(sinon, parent.path, file => {
      Assert.ok(file.equals(parent));
      queries++;
      return required - 1;
    });
    const copy = sinon.spy(
      Cu.getGlobalForObject(createMigrationBackup).IOUtils,
      "copy"
    );
    try {
      await Assert.rejects(
        createMigrationBackup(
          plan.profilePath,
          [...plan.mailPaths, ...plan.mailPaths],
          plan.backupPath
        ),
        error =>
          error.result == Cr.NS_ERROR_FILE_NO_DEVICE_SPACE &&
          error.message.includes(`at least ${required} bytes`)
      );
      Assert.equal(queries, 1);
      Assert.equal(copy.callCount, 0);
      Assert.ok(!(await IOUtils.exists(plan.backupPath)));
    } finally {
      copy.restore();
      space.restore();
    }
    for (const [index, path] of paths.entries()) {
      Assert.deepEqual(await IOUtils.read(path), originals[index]);
    }
    const receipt = await createMigrationBackup(
      plan.profilePath,
      plan.mailPaths,
      plan.backupPath
    );
    Assert.deepEqual(await verifyMigrationBackup(plan.backupPath), receipt);
  }
);

add_task(
  async function test_freshBackupPreservesVolumeQueryErrorBeforeCreatingOutput() {
    const { sinon } = ChromeUtils.importESModule(
      "resource://testing-common/Sinon.sys.mjs"
    );
    const { root, plan } = await migrationFiles();
    const original = await IOUtils.read(plan.sources[0].path);
    const failure = new Error("Backup volume query failed");
    const space = stubBackupVolumeSpace(sinon, canonicalRoot(root), () => {
      throw failure;
    });
    const copy = sinon.spy(
      Cu.getGlobalForObject(createMigrationBackup).IOUtils,
      "copy"
    );
    try {
      await Assert.rejects(
        createMigrationBackup(
          plan.profilePath,
          plan.mailPaths,
          plan.backupPath
        ),
        error => error === failure
      );
      Assert.equal(copy.callCount, 0);
      Assert.ok(!(await IOUtils.exists(plan.backupPath)));
    } finally {
      copy.restore();
      space.restore();
    }
    Assert.deepEqual(await IOUtils.read(plan.sources[0].path), original);
  }
);

add_task(async function test_freshBackupAllowsExactFileByteLowerBound() {
  const { sinon } = ChromeUtils.importESModule(
    "resource://testing-common/Sinon.sys.mjs"
  );
  const { root, plan } = await migrationFiles();
  const paths = [
    PathUtils.join(plan.profilePath, "prefs.js"),
    plan.sources[0].path,
    PathUtils.join(plan.mailPaths[0], "Inbox"),
  ];
  const originals = await Promise.all(paths.map(path => IOUtils.read(path)));
  const required = originals.reduce((sum, bytes) => sum + bytes.length, 0);
  let queries = 0;
  const space = stubBackupVolumeSpace(sinon, canonicalRoot(root), () => {
    queries++;
    return required;
  });
  try {
    const receipt = await createMigrationBackup(
      plan.profilePath,
      plan.mailPaths,
      plan.backupPath
    );
    Assert.equal(queries, 1);
    Assert.deepEqual(await verifyMigrationBackup(plan.backupPath), receipt);
  } finally {
    space.restore();
  }
  for (const [index, path] of paths.entries()) {
    Assert.deepEqual(await IOUtils.read(path), originals[index]);
  }
});

add_task(async function test_cancelledBackupRetainsWorkAndResumes() {
  const { sinon } = ChromeUtils.importESModule(
    "resource://testing-common/Sinon.sys.mjs"
  );
  const { plan } = await migrationFiles();
  const originals = new Map();
  for (const path of [
    PathUtils.join(plan.profilePath, "prefs.js"),
    plan.sources[0].path,
    PathUtils.join(plan.mailPaths[0], "Inbox"),
  ]) {
    const file = new FileUtils.File(path);
    const lease =
      AppConstants.platform == "win"
        ? admitWindowsMigrationPath(
            file,
            Ci.nsIPanoramaMigrationFileSystem.KIND_FILE
          )
        : null;
    try {
      if (!lease) {
        file.normalize();
      }
      originals.set(
        lease?.canonicalPath ?? file.path,
        await IOUtils.read(path)
      );
    } finally {
      lease?.close();
    }
  }

  const controller = new AbortController();
  const copied = [];
  const backupIO = Cu.getGlobalForObject(createMigrationBackup).IOUtils;
  const realCopy = backupIO.copy.bind(backupIO);
  const copy = sinon.stub(backupIO, "copy").callsFake(async (...args) => {
    const result = await realCopy(...args);
    copied.push({ source: args[0], destination: args[1] });
    controller.abort();
    return result;
  });
  try {
    await Assert.rejects(
      createMigrationBackup(
        plan.profilePath,
        plan.mailPaths,
        plan.backupPath,
        controller.signal
      ),
      error =>
        error.name == "AbortError" &&
        error.message == "Migration backup cancelled"
    );
  } finally {
    copy.restore();
  }
  Assert.equal(copied.length, 1, "One real copy completed before cancellation");
  const retained = copied[0];
  Assert.ok(
    originals.has(retained.source),
    "The copied file is an original input"
  );
  Assert.ok(
    new FileUtils.File(canonicalRoot(plan.backupPath)).contains(
      new FileUtils.File(retained.destination)
    ),
    "Incomplete work belongs to the backup"
  );
  Assert.deepEqual(
    await IOUtils.read(retained.destination),
    originals.get(retained.source),
    "Cancellation retains the completed scratch copy"
  );
  const manifestPath = PathUtils.join(plan.backupPath, "manifest.json");
  const incomplete = await IOUtils.readJSON(manifestPath);
  Assert.equal(incomplete.complete, false);
  await Assert.rejects(
    verifyMigrationBackup(plan.backupPath),
    /Migration backup is incomplete or unsupported/
  );
  for (const [path, bytes] of originals) {
    Assert.deepEqual(await IOUtils.read(path), bytes);
  }

  const receipt = await createMigrationBackup(
    plan.profilePath,
    plan.mailPaths,
    plan.backupPath
  );
  Assert.deepEqual(await verifyMigrationBackup(plan.backupPath), receipt);
  const complete = await IOUtils.readJSON(manifestPath);
  Assert.equal(complete.complete, true);
  Assert.deepEqual(
    complete.roots,
    incomplete.roots,
    "Retry keeps source identities"
  );
  const [prefs, summary, body] = originals.values();
  for (const [root, leaf, bytes] of [
    [0, "prefs.js", prefs],
    [1, "Inbox.msf", summary],
    [1, "Inbox", body],
  ]) {
    Assert.deepEqual(
      await IOUtils.read(
        PathUtils.join(plan.backupPath, complete.roots[root].directory, leaf)
      ),
      bytes
    );
  }

  const manifestBytes = await IOUtils.read(manifestPath);
  Assert.deepEqual(
    await createMigrationBackup(
      plan.profilePath,
      plan.mailPaths,
      plan.backupPath
    ),
    receipt
  );
  Assert.deepEqual(await IOUtils.read(manifestPath), manifestBytes);
  for (const [path, bytes] of originals) {
    Assert.deepEqual(await IOUtils.read(path), bytes);
  }
});

add_task(async function test_inventoryReadsPathsWithoutCreatingStores() {
  const profile = do_get_profile();
  const branch = "mail.server.migrationInventory";
  const missing = PathUtils.join(profile.path, "not-created-absolute-store");
  const relativeName = "not-created-\u90ae\u4ef6-e\u0301";
  const relative = PathUtils.join(profile.path, relativeName);
  const databasePath = PathUtils.join(profile.path, "panorama.sqlite");
  Assert.ok(!(await IOUtils.exists(databasePath)));
  try {
    Services.prefs.setComplexValue(
      branch + ".directory",
      Ci.nsIFile,
      new FileUtils.File(missing)
    );
    const descriptor = Services.prefs.getStringPref(branch + ".directory");
    let roots = collectMigrationRoots();
    Assert.equal(roots.profilePath, profile.path);
    Assert.ok(roots.mailPaths.includes(missing));
    Assert.ok(!Services.prefs.prefHasUserValue(branch + ".directory-rel"));
    Assert.ok(!(await IOUtils.exists(missing)));

    // The standard ProfileCreator uses this persisted relative-pref format.
    Services.prefs.setStringPref(
      branch + ".directory-rel",
      "[ProfD]" + relativeName
    );
    roots = collectMigrationRoots();
    Assert.ok(roots.mailPaths.includes(relative));
    Assert.ok(
      !roots.mailPaths.includes(missing),
      "Relative paths take precedence"
    );
    Assert.equal(
      Services.prefs.getStringPref(branch + ".directory"),
      descriptor
    );
    Assert.ok(!(await IOUtils.exists(missing)));
    Assert.ok(!(await IOUtils.exists(relative)));
    Assert.ok(!(await IOUtils.exists(databasePath)));
  } finally {
    Services.prefs.deleteBranch(branch + ".");
  }
});

add_task(async function test_inventoryBacksUpNestedExternalRootsOnce() {
  const { plan } = await migrationFiles();
  const mail = plan.mailPaths[0];
  const nested = PathUtils.join(mail, "shared");
  await IOUtils.makeDirectory(nested);
  const original = await IOUtils.read(do_get_file("data/migration").path);
  await IOUtils.write(PathUtils.join(nested, "Archived"), original, {
    mode: "create",
  });
  const receipt = await createMigrationBackup(
    plan.profilePath,
    [nested, mail, nested],
    plan.backupPath
  );
  const manifest = await IOUtils.readJSON(receipt.path);
  Assert.equal(manifest.roots.length, 2);
  Assert.equal(manifest.roots[1].source, canonicalRoot(mail));
  const paths = manifest.roots[1].entries.map(entry => entry.parts.join("/"));
  Assert.equal(
    new Set(paths).size,
    paths.length,
    "Each entry is backed up once"
  );
  Assert.deepEqual(paths.toSorted(), [
    "Inbox",
    "Inbox.msf",
    "shared",
    "shared/Archived",
  ]);
  Assert.deepEqual(
    await IOUtils.read(
      PathUtils.join(plan.backupPath, "root-1", "shared", "Archived")
    ),
    original
  );
  Assert.deepEqual(await verifyMigrationBackup(plan.backupPath), receipt);
});

add_task(async function test_verifiedBackupRestoresProfileAndExternalMail() {
  const { root, plan } = await migrationFiles();
  const prefs = PathUtils.join(plan.profilePath, "prefs.js");
  const summary = plan.sources[0].path;
  const body = PathUtils.join(plan.mailPaths[0], "Inbox");
  const originalPrefs = await IOUtils.read(prefs);
  const originalSummary = await IOUtils.read(summary);
  const originalBody = await IOUtils.read(body);
  const receipt = await createMigrationBackup(
    plan.profilePath,
    plan.mailPaths,
    plan.backupPath
  );
  const manifestBytes = await IOUtils.read(receipt.path);

  // Backup has returned and released its source leases before this edit.
  const changedPrefs = 'user_pref("mail.test", false);';
  await IOUtils.writeUTF8(prefs, changedPrefs, { flush: true });
  await Assert.rejects(
    createMigrationBackup(plan.profilePath, plan.mailPaths, plan.backupPath),
    /source identity changed/
  );
  Assert.deepEqual(await IOUtils.read(receipt.path), manifestBytes);
  Assert.deepEqual(await verifyMigrationBackup(plan.backupPath), receipt);

  const expectedRoots = [plan.profilePath, ...plan.mailPaths].map(
    canonicalRoot
  );
  const first = await stageMigrationRestore(plan.backupPath, root);
  const second = await stageMigrationRestore(plan.backupPath, root);
  Assert.notEqual(first.path, second.path, "Each restore owns fresh staging");
  for (const restored of [first, second]) {
    const mappings = new Map(
      restored.roots.map(({ original, staged }) => [original, staged])
    );
    Assert.equal(mappings.size, expectedRoots.length);
    Assert.deepEqual([...mappings.keys()], expectedRoots);
    for (const [original, staged] of mappings) {
      const stage = new FileUtils.File(staged);
      Assert.ok(new FileUtils.File(restored.path).contains(stage));
      Assert.ok(!new FileUtils.File(original).contains(stage));
    }
    Assert.deepEqual(
      await IOUtils.read(
        PathUtils.join(mappings.get(expectedRoots[0]), "prefs.js")
      ),
      originalPrefs
    );
    Assert.deepEqual(
      await IOUtils.read(
        PathUtils.join(mappings.get(expectedRoots[1]), "Inbox.msf")
      ),
      originalSummary
    );
    Assert.deepEqual(
      await IOUtils.read(
        PathUtils.join(mappings.get(expectedRoots[1]), "Inbox")
      ),
      originalBody
    );
  }
  Assert.equal(await IOUtils.readUTF8(prefs), changedPrefs);
  Assert.deepEqual(await IOUtils.read(summary), originalSummary);
  Assert.deepEqual(await IOUtils.read(body), originalBody);
  Assert.deepEqual(await IOUtils.read(receipt.path), manifestBytes);
  Assert.deepEqual(await verifyMigrationBackup(plan.backupPath), receipt);
});

add_task(async function test_journalResumesCommittedImport() {
  const { plan, path } = await migrationFiles();
  let journal = await MigrationJournal.create(path, plan);
  registerCleanupFunction(() => journal.close());
  const backup = await createMigrationBackup(
    plan.profilePath,
    plan.mailPaths,
    plan.backupPath
  );
  await journal.recordBackup(backup);
  const token = await journal.beginImport("folder-source");
  const revision = journal.state.revision;
  Assert.equal(await journal.beginImport("folder-source"), token);
  Assert.equal(
    journal.state.revision,
    revision,
    "A repeated intent is not rewritten"
  );
  journal.close();
  journal = await MigrationJournal.open(path, plan.profilePath);
  Assert.equal(
    await journal.beginImport("folder-source"),
    token,
    "Restart retains the operation token"
  );
  // Core supplies this data only after committing its rows and receipt together.
  const receipt = {
    token,
    sourceSha256: plan.sources[0].sha256,
    ...physicalReceiptModel(journal),
    sourcePhysicalIdentity: journal.state.sources[0].physicalIdentity,
    folderId: 9,
    keys: [
      [3, 700],
      [1, 401],
    ],
  };
  await journal.recordImport("folder-source", receipt);
  const importedRevision = journal.state.revision;
  await journal.recordImport("folder-source", {
    ...receipt,
    keys: [
      [1, 401],
      [3, 700],
    ],
  });
  Assert.equal(journal.state.revision, importedRevision);
  Assert.deepEqual(journal.state.sources[0].receipt.keys, [
    [1, 401],
    [3, 700],
  ]);
  journal.close();
  journal = await MigrationJournal.open(path, plan.profilePath);
  Assert.equal(journal.state.sources[0].state, "imported");
  Assert.deepEqual(await verifyMigrationBackup(plan.backupPath), backup);
});

add_task(async function test_cancellationAndIncompleteMappings() {
  const { plan, path } = await migrationFiles();
  const journal = await MigrationJournal.create(path, plan);
  registerCleanupFunction(() => journal.close());
  await journal.recordBackup(
    await createMigrationBackup(
      plan.profilePath,
      plan.mailPaths,
      plan.backupPath
    )
  );
  await journal.setCancelled(true);
  await Assert.rejects(journal.beginImport("folder-source"), /cancelled/);
  await journal.setCancelled(false);
  const token = await journal.beginImport("folder-source");
  await Assert.rejects(
    journal.recordImport("folder-source", {
      token,
      sourceSha256: plan.sources[0].sha256,
      ...physicalReceiptModel(journal),
      sourcePhysicalIdentity: journal.state.sources[0].physicalIdentity,
      folderId: 9,
      keys: [[1, 401]],
    }),
    /incomplete/
  );
  Assert.equal(journal.state.sources[0].state, "importing");
  await Assert.rejects(
    journal.recordImport("folder-source", {
      token,
      sourceSha256: plan.sources[0].sha256,
      ...physicalReceiptModel(journal),
      sourcePhysicalIdentity: journal.state.sources[0].physicalIdentity,
      folderId: 10,
      keys: [
        [1, 401],
        [3, 700],
      ],
    }),
    /Invalid migration import receipt/
  );
  await Assert.rejects(journal.finishStage("import"), /incomplete/);
  await IOUtils.writeUTF8(plan.sources[0].path, "changed source");
  await Assert.rejects(journal.beginImport("folder-source"), /source changed/);
  Assert.equal(journal.state.sources[0].state, "importing");
});

add_task(async function test_failedWriteRequiresReopen() {
  const { plan, path } = await migrationFiles();
  let journal = await MigrationJournal.create(path, plan);
  registerCleanupFunction(() => journal.close());
  const before = await IOUtils.read(path);
  await IOUtils.makeDirectory(path + ".tmp");
  await Assert.rejects(
    journal.setCancelled(true),
    error => typeof error.code == "number" && typeof error.name == "string",
    "The actual write reports the IOUtils DOMException contract"
  );
  Assert.deepEqual(
    await IOUtils.read(path),
    before,
    "Failed checkpoint keeps the previous journal"
  );
  Assert.equal(journal.state.cancelled, false);
  await Assert.rejects(
    journal.recordError(new Error("original failure")),
    /failed/
  );
  journal.close();
  await IOUtils.remove(path + ".tmp", { recursive: true });
  journal = await MigrationJournal.open(path, plan.profilePath);
  Assert.equal(journal.state.stage, "backup");
  Assert.equal(journal.state.cancelled, false);
});

add_task(async function test_newerJournalIsNotRecreated() {
  const { plan, path } = await migrationFiles();
  await IOUtils.writeJSON(path, { version: 99, future: "keep" });
  const before = await IOUtils.read(path);
  await Assert.rejects(
    MigrationJournal.open(path, plan.profilePath),
    /unsupported/
  );
  Assert.deepEqual(await IOUtils.read(path), before);
});

add_task(async function test_coordinatorReconcilesBeforeImporting() {
  const { plan, path } = await migrationFiles();
  const journal = await MigrationJournal.create(path, plan);
  registerCleanupFunction(() => journal.close());
  await journal.recordBackup(
    await createMigrationBackup(
      plan.profilePath,
      plan.mailPaths,
      plan.backupPath
    )
  );
  const token = await journal.beginImport("folder-source");
  let lookups = 0;
  let imports = 0;
  // Unit seam: core's actual SQL transaction/receipt integration is separate.
  const core = {
    async findReceipt(foundToken) {
      lookups++;
      Assert.equal(foundToken, token);
      return {
        token,
        sourceSha256: plan.sources[0].sha256,
        ...physicalReceiptModel(journal),
        sourcePhysicalIdentity: journal.state.sources[0].physicalIdentity,
        folderId: 9,
        keys: [
          [1, 401],
          [3, 700],
        ],
      };
    },
    async importFolder() {
      imports++;
      throw new Error("A committed folder must not be imported twice");
    },
  };
  await resumeMorkImports(journal, core);
  Assert.equal(journal.state.stage, "validate");
  Assert.equal(journal.state.sources[0].state, "imported");
  Assert.equal(lookups, 1);
  Assert.equal(imports, 0);
  const revision = journal.state.revision;
  await resumeMorkImports(journal, core);
  Assert.equal(journal.state.revision, revision);
  Assert.equal(lookups, 1);
  Assert.equal(imports, 0);
});

add_task(async function test_coordinatorPreservesFailureAndOriginals() {
  const { plan, path } = await migrationFiles();
  const journal = await MigrationJournal.create(path, plan);
  registerCleanupFunction(() => journal.close());
  await journal.recordBackup(
    await createMigrationBackup(
      plan.profilePath,
      plan.mailPaths,
      plan.backupPath
    )
  );
  const original = await IOUtils.read(plan.sources[0].path);
  const failure = new Error("core import failed");
  let imports = 0;
  await Assert.rejects(
    resumeMorkImports(journal, {
      async findReceipt() {
        return null;
      },
      async importFolder(input) {
        imports++;
        Assert.equal(input.source.sha256, plan.sources[0].sha256);
        Assert.equal(input.destinationFolderId, 9);
        Assert.equal(input.relations.get(1).root, 1);
        throw failure;
      },
    }),
    error => error === failure
  );
  Assert.equal(imports, 1);
  Assert.equal(journal.state.stage, "import");
  Assert.equal(journal.state.sources[0].state, "importing");
  Assert.equal(journal.state.lastError.message, failure.message);
  Assert.deepEqual(await IOUtils.read(plan.sources[0].path), original);
  Assert.equal(
    await IOUtils.computeHexDigest(
      PathUtils.join(plan.mailPaths[0], "Inbox"),
      "sha256"
    ),
    await IOUtils.computeHexDigest(do_get_file("data/migration").path, "sha256")
  );
});

add_task(async function test_cancellationStillRecordsCommittedWork() {
  const { plan, path } = await migrationFiles();
  const journal = await MigrationJournal.create(path, plan);
  registerCleanupFunction(() => journal.close());
  await journal.recordBackup(
    await createMigrationBackup(
      plan.profilePath,
      plan.mailPaths,
      plan.backupPath
    )
  );
  const controller = new AbortController();
  let committed;
  let imports = 0;
  const core = {
    async findReceipt() {
      return committed ?? null;
    },
    async importFolder({ token }) {
      imports++;
      committed = {
        token,
        sourceSha256: plan.sources[0].sha256,
        ...physicalReceiptModel(journal),
        sourcePhysicalIdentity: journal.state.sources[0].physicalIdentity,
        folderId: 9,
        keys: [
          [1, 401],
          [3, 700],
        ],
      };
      controller.abort();
      return committed;
    },
  };
  await Assert.rejects(
    resumeMorkImports(journal, core, controller.signal),
    error => error.name == "AbortError"
  );
  Assert.equal(journal.state.stage, "import");
  Assert.equal(journal.state.cancelled, true);
  Assert.equal(journal.state.sources[0].state, "imported");
  Assert.deepEqual(journal.state.sources[0].receipt.keys, [
    [1, 401],
    [3, 700],
  ]);
  await journal.setCancelled(false);
  await resumeMorkImports(journal, core);
  Assert.equal(imports, 1);
  Assert.equal(journal.state.stage, "validate");
});

/**
 * Creates a real Unix link using the existing xpcom link-test route.
 *
 * @param {string} target - Original file or directory.
 * @param {string} path - Fresh link path.
 */
function makeMigrationPathLink(target, path) {
  const process = Cc["@mozilla.org/process/util;1"].createInstance(
    Ci.nsIProcess
  );
  process.init(new FileUtils.File("/bin/ln"));
  const args = ["-s", target, path];
  process.run(true, args, args.length);
  Assert.equal(process.exitValue, 0);
  Assert.ok(new FileUtils.File(path).isSymlink(), "Real link created");
}

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_journalReopensThroughLinkedAncestor() {
    const { root, plan } = await migrationFiles();
    const outer = await IOUtils.createUniqueDirectory(
      PathUtils.tempDir,
      "migration-journal-alias-"
    );
    registerCleanupFunction(() => IOUtils.remove(outer, { recursive: true }));
    const alias = PathUtils.join(outer, "alias");
    makeMigrationPathLink(root, alias);
    const through = {
      ...plan,
      profilePath: PathUtils.join(alias, "profile"),
      mailPaths: [PathUtils.join(alias, "external-mail")],
      backupPath: PathUtils.join(alias, "backup"),
      sources: [
        {
          ...plan.sources[0],
          path: PathUtils.join(alias, "external-mail", "Inbox.msf"),
        },
      ],
    };
    const path = PathUtils.join(alias, "journal.json");
    let journal = await MigrationJournal.create(path, through);
    registerCleanupFunction(() => journal.close());
    const backup = await createMigrationBackup(
      through.profilePath,
      through.mailPaths,
      through.backupPath
    );
    await journal.recordBackup(backup);
    const token = await journal.beginImport("folder-source");
    const original = await IOUtils.read(plan.sources[0].path);
    journal.close();
    journal = await MigrationJournal.open(path, through.profilePath);
    Assert.equal(await journal.beginImport("folder-source"), token);
    const expected = new FileUtils.File(plan.sources[0].path);
    expected.normalize();
    Assert.equal(journal.state.sources[0].path, expected.path);
    Assert.equal(journal.state.sources[0].sha256, plan.sources[0].sha256);
    Assert.deepEqual(await IOUtils.read(plan.sources[0].path), original);
    Assert.deepEqual(await verifyMigrationBackup(through.backupPath), backup);
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_journalRefusesLinkedSourceLeafBeforeNormalization() {
    const { root, plan, path } = await migrationFiles();
    const original = await IOUtils.read(plan.sources[0].path);
    const link = PathUtils.join(plan.mailPaths[0], "Alias.msf");
    makeMigrationPathLink(plan.sources[0].path, link);
    plan.sources[0].path = link;
    await Assert.rejects(
      MigrationJournal.create(path, plan),
      /contains a link/
    );
    Assert.ok(!(await IOUtils.exists(path)));
    Assert.deepEqual(
      await IOUtils.read(PathUtils.join(root, "external-mail", "Inbox.msf")),
      original
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_journalRejectsRedirectedSourceRoot() {
    const { root, plan, path } = await migrationFiles();
    const journal = await MigrationJournal.create(path, plan);
    registerCleanupFunction(() => journal.close());
    const backup = await createMigrationBackup(
      plan.profilePath,
      plan.mailPaths,
      plan.backupPath
    );
    await journal.recordBackup(backup);
    const mail = plan.mailPaths[0];
    const saved = PathUtils.join(root, "retained-mail-directory");
    await IOUtils.move(mail, saved, { noOverwrite: true });
    makeMigrationPathLink(saved, mail);
    await Assert.rejects(
      journal.beginImport("folder-source"),
      /contains a link/
    );
    Assert.equal(journal.state.sources[0].state, "pending");
    Assert.deepEqual(await verifyMigrationBackup(plan.backupPath), backup);
    Assert.equal(
      await IOUtils.computeHexDigest(
        PathUtils.join(saved, "Inbox.msf"),
        "sha256"
      ),
      plan.sources[0].sha256
    );
  }
);
