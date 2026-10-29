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
const windowsOnly = () => ({ skip_if: () => AppConstants.platform != "win" });
let fs;
let work;
let original;
let bytes;

add_setup(async function setupFilesystemWithoutStartingDatabase() {
  do_get_profile();
  const provider = Cc["@mozilla.org/xre/directory-provider;1"]
    .getService(Ci.nsIDirectoryServiceProvider)
    .QueryInterface(Ci.nsIXREDirProvider);
  for (const key of ["DefProfRt", "DefProfLRt", "UAppData"]) {
    Services.dirsvc.set(key, provider.getFile(key, {}).clone());
  }
  Assert.ok(
    !(await IOUtils.exists(
      PathUtils.join(PathUtils.profileDir, "panorama.sqlite")
    ))
  );
  fs = Cc["@mozilla.org/mailnews/panorama-migration-file-system;1"].getService(
    Ci.nsIPanoramaMigrationFileSystem
  );
  work = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "migration-filesystem-"
  );
  registerCleanupFunction(() => IOUtils.remove(work, { recursive: true }));
  original = PathUtils.join(work, "source.msf");
  bytes = await IOUtils.read(do_get_file("data/migration.msf").path);
  await IOUtils.copy(do_get_file("data/migration.msf").path, original, {
    noOverwrite: true,
  });
});

/** @param {string} path - Original native path. @param {number} kind - Exact API kind. @returns {nsIPanoramaMigrationPath} Owned lease. */
function admit(path, kind) {
  return fs.admit(new FileUtils.File(path), new FileUtils.File(work), kind);
}

add_task(
  windowsOnly(),
  async function test_nativeAdmissionDoesNotStartOrMutateDatabase() {
    const lease = admit(original, fs.KIND_FILE);
    try {
      Assert.ok(lease instanceof Ci.nsIPanoramaMigrationPath);
      Assert.equal(lease.kind, fs.KIND_FILE);
      Assert.ok(lease.exists);
      Assert.ok(!lease.closed);
      Assert.ok(/^[0-9a-f]{16}:[0-9a-f]{32}$/.test(lease.identity));
      Assert.ok(/^[0-9a-f]{16}:[0-9a-f]{32}$/.test(lease.rootIdentity));
      Assert.equal(lease.parentIdentity, lease.rootIdentity);
      Assert.notEqual(lease.identity, lease.rootIdentity);
      Assert.ok(
        new FileUtils.File(lease.canonicalPath).equals(
          new FileUtils.File(original)
        )
      );
      Assert.ok(
        new FileUtils.File(lease.canonicalRoot).equals(new FileUtils.File(work))
      );
      fs.validate(lease);
      Assert.deepEqual(await IOUtils.read(lease.canonicalPath), bytes);
      Assert.throws(
        () => {
          lease.identity = "invented";
        },
        error => error.name == "TypeError"
      );
    } finally {
      lease.close();
    }
    Assert.ok(
      !(await IOUtils.exists(
        PathUtils.join(PathUtils.profileDir, "panorama.sqlite")
      ))
    );
    Assert.deepEqual(await IOUtils.read(original), bytes);
    Assert.deepEqual(
      await IOUtils.read(do_get_file("data/migration.msf").path),
      bytes
    );
  }
);

add_task(windowsOnly(), function test_closedLeaseMetadataAndValidationRefuse() {
  const lease = admit(original, fs.KIND_FILE);
  lease.close();
  lease.close();
  Assert.ok(lease.closed, "Close is idempotent");
  for (const name of [
    "identity",
    "canonicalPath",
    "canonicalRoot",
    "parentIdentity",
    "rootIdentity",
    "exists",
    "kind",
  ]) {
    Assert.throws(
      () => lease[name],
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
    );
  }
  Assert.throws(
    () => fs.validate(lease),
    error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
  );
});

add_task(windowsOnly(), function test_fakeAndForeignLeaseObjectsRefuse() {
  const fake = {
    QueryInterface: ChromeUtils.generateQI(["nsISupports"]),
    canonicalPath: original,
    identity: "0".repeat(49),
    exists: true,
    closed: false,
  };
  Assert.throws(
    () => fs.validate(fake),
    error => error.result == Cr.NS_ERROR_INVALID_ARG
  );
  Assert.throws(
    () => fs.validate(new FileUtils.File(original)),
    error => error.result == Cr.NS_ERROR_INVALID_ARG
  );
  Assert.throws(
    () => fs.validate(null),
    error => error.result == Cr.NS_ERROR_INVALID_ARG
  );
});

add_task(windowsOnly(), function test_originalFileObjectsAreCloned() {
  const file = new FileUtils.File(original);
  const root = new FileUtils.File(work);
  const lease = fs.admit(file, root, fs.KIND_FILE);
  try {
    const path = lease.canonicalPath;
    file.append("caller-only-change");
    root.append("caller-only-change");
    fs.validate(lease);
    Assert.equal(lease.canonicalPath, path);
  } finally {
    lease.close();
  }
});

add_task(
  windowsOnly(),
  async function test_absentOutputNeedsExclusiveCreateAndNewLease() {
    const output = PathUtils.join(work, "owned-output.bin");
    const missing = admit(output, fs.KIND_FILE_OR_MISSING);
    let created;
    try {
      Assert.equal(missing.kind, fs.KIND_FILE_OR_MISSING);
      Assert.ok(!missing.exists);
      Assert.equal(missing.identity, "");
      Assert.equal(missing.parentIdentity, missing.rootIdentity);
      fs.validate(missing);
      Assert.ok(!(await IOUtils.exists(output)));
      const file = new FileUtils.File(output);
      file.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
      Assert.throws(
        () => file.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600),
        error => error.result == Cr.NS_ERROR_FILE_ALREADY_EXISTS
      );
      Assert.throws(
        () => fs.validate(missing),
        error => error.result == Cr.NS_ERROR_FILE_CORRUPTED
      );
      created = admit(output, fs.KIND_FILE_OR_MISSING);
      Assert.ok(created.exists);
      Assert.equal(created.kind, fs.KIND_FILE);
      Assert.ok(/^[0-9a-f]{16}:[0-9a-f]{32}$/.test(created.identity));
      await IOUtils.write(output, new Uint8Array([7, 0, 255]));
      fs.validate(created);
      Assert.deepEqual(await IOUtils.read(output), new Uint8Array([7, 0, 255]));
    } finally {
      created?.close();
      missing.close();
    }
  }
);

add_task(windowsOnly(), function test_invalidModeAndWrongNativeKindRefuse() {
  Assert.throws(
    () => admit(original, 99),
    error => error.result == Cr.NS_ERROR_INVALID_ARG
  );
  Assert.throws(
    () => admit(original, fs.KIND_DIRECTORY),
    error => error.result == Cr.NS_ERROR_FILE_INVALID_PATH
  );
  Assert.throws(
    () => fs.admit(null, new FileUtils.File(work), fs.KIND_FILE),
    error => error.result == Cr.NS_ERROR_INVALID_ARG
  );
});

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  function test_nonWindowsRemainsExplicitlyUnsupported() {
    Assert.throws(
      () => admit(original, fs.KIND_FILE),
      error => error.result == Cr.NS_ERROR_NOT_IMPLEMENTED
    );
    Assert.throws(
      () => fs.validate(null),
      error => error.result == Cr.NS_ERROR_NOT_IMPLEMENTED
    );
    Assert.throws(
      () => fs.setStageModificationTime(null, 1700000000123),
      error => error.result == Cr.NS_ERROR_NOT_IMPLEMENTED
    );
  }
);

/** @returns {Promise<object>} Quiesced genuine source under an actual profile lock. */
async function closedProfileSource() {
  const root = await IOUtils.createUniqueDirectory(work, "profile-case-");
  const service = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
    Ci.nsIToolkitProfileService
  );
  const profile = service.createProfile(
    new FileUtils.File(PathUtils.join(root, "profile")),
    "migration-fs-" + PathUtils.filename(root),
    "tests"
  );
  const lock = profile.lock({});
  registerCleanupFunction(() => {
    lock.unlock();
    profile.remove(false);
  });
  const summary = PathUtils.join(lock.directory.path, "Inbox.msf");
  await IOUtils.copy(do_get_file("data/migration.msf").path, summary);
  await IOUtils.copy(
    do_get_file("data/migration").path,
    PathUtils.join(lock.directory.path, "Inbox")
  );
  const { readMorkMigrationSource } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MigrationSource.sys.mjs"
  );
  const { createMigrationBackup } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MigrationBackup.sys.mjs"
  );
  const { MigrationJournal } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MigrationJournal.sys.mjs"
  );
  const { captureMorkFolderWindowsInventory } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MorkFolderImport.sys.mjs"
  );
  const inventory = captureMorkFolderWindowsInventory(
    new FileUtils.File(summary),
    lock.directory,
    new FileUtils.File(PathUtils.join(lock.directory.path, "Inbox")),
    lock.directory
  );
  const { identity } = await readMorkMigrationSource(summary);
  const backup = await createMigrationBackup(
    lock.directory.path,
    [],
    PathUtils.join(root, "backup")
  );
  const journalPath = PathUtils.join(root, "journal.json");
  const journal = await MigrationJournal.create(journalPath, {
    profilePath: lock.directory.path,
    mailPaths: [],
    backupPath: PathUtils.parent(backup.path),
    sources: [
      {
        id: "source",
        ...identity,
        inventory,
        databaseSourceId: "journal-unit-without-native-target",
        destinationFolderId: 9,
      },
    ],
  });
  registerCleanupFunction(() => journal.close());
  await journal.recordBackup(backup);
  return {
    root,
    summary,
    profile,
    lock,
    identity,
    backup,
    journal,
    journalPath,
  };
}

add_task(
  windowsOnly(),
  async function test_backupVersion3AndJournalVersion4RetainOriginalIDs() {
    const input = await closedProfileSource();
    const manifest = await IOUtils.readJSON(input.backup.path);
    Assert.equal(manifest.version, 3);
    const entry = manifest.roots[0].entries.find(
      file => file.parts.join("/") == "Inbox.msf"
    );
    Assert.deepEqual(entry.physicalIdentity, input.identity.physicalIdentity);
    Assert.equal(input.journal.state.version, 4);
    Assert.deepEqual(
      input.journal.state.profilePhysicalIdentity,
      manifest.roots[0].physicalIdentity
    );
    Assert.deepEqual(
      input.journal.state.sources[0].physicalIdentity,
      entry.physicalIdentity
    );
    const copied = fs.admit(
      new FileUtils.File(
        PathUtils.join(
          PathUtils.parent(input.backup.path),
          "root-0",
          "Inbox.msf"
        )
      ),
      new FileUtils.File(PathUtils.parent(input.backup.path)),
      fs.KIND_FILE
    );
    try {
      Assert.notEqual(
        copied.identity,
        entry.physicalIdentity.id,
        "A byte-identical backup is a different physical file"
      );
    } finally {
      copied.close();
    }
    input.journal.close();
    const { MigrationJournal } = ChromeUtils.importESModule(
      "resource:///modules/panorama/MigrationJournal.sys.mjs"
    );
    input.journal = await MigrationJournal.open(
      input.journalPath,
      input.lock.directory.path
    );
    registerCleanupFunction(() => input.journal.close());
    Assert.deepEqual(
      input.journal.state.sources[0].physicalIdentity,
      input.identity.physicalIdentity,
      "Restart retains the original physical source pin"
    );
    const token = await input.journal.beginImport("source");
    await Assert.rejects(
      input.journal.recordImport("source", {
        token,
        sourceSha256: input.identity.sha256,
        folderId: 9,
        keys: [
          [1, 401],
          [3, 700],
        ],
      }),
      /physical identity is missing or changed/
    );
    await Assert.rejects(
      input.journal.recordImport("source", {
        token,
        sourceSha256: input.identity.sha256,
        folderId: 9,
        keys: [
          [1, 401],
          [3, 700],
        ],
        sourcePhysicalIdentity: {
          ...input.identity.physicalIdentity,
          id: "0".repeat(16) + ":" + "0".repeat(32),
        },
      }),
      /physical identity is missing or changed/
    );
    Assert.equal(
      input.journal.state.sources[0].state,
      "importing",
      "Unit rejection is not a native import success"
    );
    Assert.ok(
      !(await IOUtils.exists(
        PathUtils.join(PathUtils.profileDir, "panorama.sqlite")
      ))
    );
  }
);

add_task(
  windowsOnly(),
  async function test_identicalReplacementCannotResumeOriginalUnit() {
    const input = await closedProfileSource();
    const retained = input.summary + ".original";
    await IOUtils.move(input.summary, retained, { noOverwrite: true });
    await IOUtils.copy(do_get_file("data/migration.msf").path, input.summary, {
      noOverwrite: true,
    });
    Assert.equal(
      await IOUtils.computeHexDigest(input.summary, "sha256"),
      input.identity.sha256
    );
    const before = await IOUtils.read(input.journalPath);
    await Assert.rejects(
      input.journal.beginImport("source"),
      /physical identity changed/
    );
    Assert.deepEqual(await IOUtils.read(input.journalPath), before);
    Assert.equal(input.journal.state.sources[0].state, "pending");
    await IOUtils.move(input.summary, input.summary + ".replacement", {
      noOverwrite: true,
    });
    await IOUtils.move(retained, input.summary, { noOverwrite: true });
    Assert.ok(
      await input.journal.beginImport("source"),
      "The original physical file can resume"
    );
  }
);

add_task(
  windowsOnly(),
  async function test_windowsRestoreCopiesOnlyIntoFreshOwnedStage() {
    const input = await closedProfileSource();
    const { stageMigrationRestore, verifyMigrationBackup } =
      ChromeUtils.importESModule(
        "resource:///modules/panorama/MigrationBackup.sys.mjs"
      );
    const manifestBytes = await IOUtils.read(input.backup.path);
    const sourceBytes = await IOUtils.read(input.summary);
    const originalBody = PathUtils.join(input.lock.directory.path, "Inbox");
    const bodyBytes = await IOUtils.read(originalBody);
    const staged = await stageMigrationRestore(
      PathUtils.parent(input.backup.path),
      input.root
    );
    Assert.equal(staged.roots.length, 1);
    const manifest = await IOUtils.readJSON(input.backup.path);
    for (const entry of manifest.roots[0].entries) {
      if (entry.type == "regular") {
        Assert.equal(
          (
            await IOUtils.stat(
              PathUtils.join(staged.roots[0].staged, ...entry.parts)
            )
          ).lastModified,
          entry.lastModified,
          "Restore retains recorded file metadata without releasing its lease"
        );
      }
    }
    const copy = PathUtils.join(staged.roots[0].staged, "Inbox.msf");
    Assert.deepEqual(await IOUtils.read(copy), sourceBytes);
    Assert.deepEqual(
      await IOUtils.read(PathUtils.join(staged.roots[0].staged, "Inbox")),
      bodyBytes
    );
    const lease = fs.admit(
      new FileUtils.File(copy),
      new FileUtils.File(staged.path),
      fs.KIND_FILE
    );
    try {
      Assert.notEqual(lease.identity, input.identity.physicalIdentity.id);
      fs.validate(lease);
    } finally {
      lease.close();
    }
    Assert.deepEqual(await IOUtils.read(input.summary), sourceBytes);
    Assert.deepEqual(await IOUtils.read(originalBody), bodyBytes);
    Assert.deepEqual(await IOUtils.read(input.backup.path), manifestBytes);
    Assert.deepEqual(
      await verifyMigrationBackup(PathUtils.parent(input.backup.path)),
      input.backup
    );
    Assert.equal(
      input.journal.state.stage,
      "import",
      "No activation checkpoint"
    );
  }
);

add_task(
  windowsOnly(),
  async function test_stageTimeUsesRetainedNativeHandle() {
    const path = PathUtils.join(work, "metadata-stage.msf");
    await IOUtils.write(path, bytes, { mode: "create" });
    const stage = admit(path, fs.KIND_FILE_OR_MISSING);
    const source = admit(original, fs.KIND_FILE);
    const absent = admit(path + ".absent", fs.KIND_FILE_OR_MISSING);
    const directory = admit(work, fs.KIND_DIRECTORY);
    const originalTime = (await IOUtils.stat(original)).lastModified;
    try {
      const modified = 1700000000123;
      fs.setStageModificationTime(stage, modified);
      Assert.equal((await IOUtils.stat(path)).lastModified, modified);
      fs.validate(stage);
      Assert.deepEqual(await IOUtils.read(path), bytes);
      Assert.throws(
        () =>
          new FileUtils.File(path).moveTo(
            null,
            PathUtils.filename(path) + ".moved"
          ),
        error => error.result == Cr.NS_ERROR_FILE_IS_LOCKED
      );
      Assert.ok(await IOUtils.exists(path));
      Assert.ok(!(await IOUtils.exists(path + ".moved")));
      for (const lease of [source, absent, directory]) {
        Assert.throws(
          () => fs.setStageModificationTime(lease, modified),
          error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
        );
      }
      Assert.throws(
        () => fs.setStageModificationTime({}, modified),
        error => error.result == Cr.NS_ERROR_INVALID_ARG
      );
      stage.close();
      Assert.throws(
        () => fs.setStageModificationTime(stage, modified),
        error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
      );
      Assert.equal((await IOUtils.stat(original)).lastModified, originalTime);
      Assert.deepEqual(await IOUtils.read(original), bytes);
      await IOUtils.move(path, path + ".moved", { noOverwrite: true });
    } finally {
      directory.close();
      absent.close();
      source.close();
      stage.close();
    }
  }
);
