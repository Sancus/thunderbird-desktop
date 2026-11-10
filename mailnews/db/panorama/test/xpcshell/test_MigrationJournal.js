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
  readMorkFolderCacheSource,
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

add_task(
  async function test_freshBackupRefusesInvalidVolumeSpaceBeforeCreatingOutput() {
    const { sinon } = ChromeUtils.importESModule(
      "resource://testing-common/Sinon.sys.mjs"
    );
    for (const available of [
      -1,
      NaN,
      Infinity,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const { root, plan } = await migrationFiles();
      const paths = [
        PathUtils.join(plan.profilePath, "prefs.js"),
        plan.sources[0].path,
        PathUtils.join(plan.mailPaths[0], "Inbox"),
      ];
      const originals = await Promise.all(
        paths.map(path => IOUtils.read(path))
      );
      let queries = 0;
      const space = stubBackupVolumeSpace(sinon, canonicalRoot(root), () => {
        queries++;
        return available;
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
          error =>
            error.name == "Error" &&
            error.message == "Migration backup free space is unavailable",
          `An unavailable or inexact volume result (${available}) cannot admit output`
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
    }
  }
);

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
  const accounts = Services.prefs.getCharPref(
    "mail.accountmanager.accounts",
    ""
  );
  Assert.ok(!(await IOUtils.exists(databasePath)));
  try {
    Services.prefs.setComplexValue(
      branch + ".directory",
      Ci.nsIFile,
      new FileUtils.File(missing)
    );
    const descriptor = Services.prefs.getStringPref(branch + ".directory");
    let roots = collectMigrationRoots();
    Assert.ok(
      !roots.mailPaths.includes(missing),
      "A branch no listed account names is a removed account's leftover"
    );
    Services.prefs.setCharPref(
      "mail.account.migrationInventory.server",
      "migrationInventory"
    );
    Assert.ok(
      !collectMigrationRoots().mailPaths.includes(missing),
      "An account outside the account list is never loaded either"
    );
    Services.prefs.setCharPref(
      "mail.accountmanager.accounts",
      [accounts, "migrationInventory"].filter(Boolean).join(",")
    );
    roots = collectMigrationRoots();
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
    Services.prefs.deleteBranch("mail.account.migrationInventory.");
    if (accounts) {
      Services.prefs.setCharPref("mail.accountmanager.accounts", accounts);
    } else {
      Services.prefs.clearUserPref("mail.accountmanager.accounts");
    }
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

add_task(
  async function test_inventoryRetainsProfileMetadataAndLockExclusions() {
    const { plan } = await migrationFiles();
    const profile = plan.profilePath;
    const directory = PathUtils.join(profile, "data");
    const empty = PathUtils.join(directory, "empty");
    const settings = PathUtils.join(directory, "settings-\u90ae\u4ef6.json");
    const settingsBytes = new TextEncoder().encode(
      '{"retained":"profile value"}'
    );
    const lock = PathUtils.join(profile, "parent.lock");
    const lockBytes = new TextEncoder().encode("excluded profile lock");
    await IOUtils.makeDirectory(empty, { createAncestors: true });
    await IOUtils.write(settings, settingsBytes, { mode: "create" });
    await IOUtils.write(lock, lockBytes, { mode: "create" });
    const parts = [
      ["data"],
      ["data", "empty"],
      ["data", "settings-\u90ae\u4ef6.json"],
      ["prefs.js"],
    ];
    const measured = new Map();
    for (const components of [[], ...parts]) {
      const path = PathUtils.join(profile, ...components);
      const info = await IOUtils.stat(path);
      measured.set(components.join("/"), {
        info,
        sha256:
          info.type == "regular"
            ? await IOUtils.computeHexDigest(path, "sha256")
            : null,
      });
    }
    const receipt = await createMigrationBackup(
      profile,
      plan.mailPaths,
      plan.backupPath
    );
    const manifest = await IOUtils.readJSON(receipt.path);
    const inventory = manifest.roots[0];
    Assert.equal(inventory.source, canonicalRoot(profile));
    Assert.deepEqual(inventory.excluded, ["parent.lock"]);
    Assert.deepEqual(
      inventory.entries.map(entry => entry.parts.join("/")).toSorted(),
      parts.map(components => components.join("/")).toSorted(),
      "Full profile inventory retains empty directories and every non-lock file"
    );
    Assert.equal(inventory.permissions, measured.get("").info.permissions);
    Assert.equal(inventory.lastModified, measured.get("").info.lastModified);
    for (const entry of inventory.entries) {
      const expected = measured.get(entry.parts.join("/"));
      Assert.equal(entry.type, expected.info.type);
      Assert.equal(entry.permissions, expected.info.permissions);
      Assert.equal(entry.lastModified, expected.info.lastModified);
      if (entry.type == "regular") {
        Assert.equal(entry.size, expected.info.size);
        Assert.equal(entry.sha256, expected.sha256);
      }
      if (AppConstants.platform == "win") {
        const source = PathUtils.join(profile, ...entry.parts);
        const lease = admitWindowsMigrationPath(
          new FileUtils.File(source),
          entry.type == "directory"
            ? Ci.nsIPanoramaMigrationFileSystem.KIND_DIRECTORY
            : Ci.nsIPanoramaMigrationFileSystem.KIND_FILE
        );
        try {
          Assert.deepEqual(entry.physicalIdentity, {
            version: 1,
            id: lease.identity,
            parentId: lease.parentIdentity,
          });
        } finally {
          lease.close();
        }
      } else {
        Assert.ok(!Object.hasOwn(entry, "physicalIdentity"));
      }
    }
    Assert.deepEqual(await IOUtils.read(settings), settingsBytes);
    Assert.deepEqual(await IOUtils.read(lock), lockBytes);
    Assert.deepEqual(
      await IOUtils.read(
        PathUtils.join(
          plan.backupPath,
          "root-0",
          "data",
          "settings-\u90ae\u4ef6.json"
        )
      ),
      settingsBytes
    );
    Assert.deepEqual(
      await IOUtils.getChildren(
        PathUtils.join(plan.backupPath, "root-0", "data", "empty")
      ),
      []
    );
    Assert.ok(
      !(await IOUtils.exists(
        PathUtils.join(plan.backupPath, "root-0", "parent.lock")
      ))
    );
    Assert.deepEqual(await verifyMigrationBackup(plan.backupPath), receipt);
  }
);

add_task(async function test_inventoryRejectsOverlappingSourceAndBackupRoots() {
  const { root, plan } = await migrationFiles();
  const original = await IOUtils.read(plan.sources[0].path);
  await Assert.rejects(
    createMigrationBackup(plan.profilePath, [root], plan.backupPath),
    error =>
      error.name == "Error" &&
      error.message == "External mail root contains the profile"
  );
  Assert.ok(!(await IOUtils.exists(plan.backupPath)));
  const nestedBackup = PathUtils.join(plan.profilePath, "invalid-backup");
  await Assert.rejects(
    createMigrationBackup(plan.profilePath, plan.mailPaths, nestedBackup),
    error =>
      error.name == "Error" &&
      error.message == "Backup must be outside migration source trees"
  );
  Assert.ok(!(await IOUtils.exists(nestedBackup)));
  Assert.deepEqual(await IOUtils.read(plan.sources[0].path), original);
});

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_inventoryRefusesLinkedDescendant() {
    const { plan } = await migrationFiles();
    const original = await IOUtils.read(plan.sources[0].path);
    const link = PathUtils.join(plan.mailPaths[0], "Alias.msf");
    makeMigrationPathLink(plan.sources[0].path, link);
    await Assert.rejects(
      createMigrationBackup(plan.profilePath, plan.mailPaths, plan.backupPath),
      error =>
        error.name == "Error" &&
        error.message == "Migration source or destination contains a link"
    );
    Assert.ok(!(await IOUtils.exists(plan.backupPath)));
    Assert.deepEqual(await IOUtils.read(plan.sources[0].path), original);
    Assert.ok(
      new FileUtils.File(link).isSymlink(),
      "The original link is retained"
    );
  }
);

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

add_task(async function test_committedSnapshotRetainsMappingsOnSourceRefusal() {
  const modes = ["changed", "missing"];
  if (AppConstants.platform == "win") {
    modes.push("replaced");
  }
  for (const mode of modes) {
    const { root, plan, path } = await migrationFiles();
    const source = plan.sources[0];
    const original = await IOUtils.read(source.path);
    const saved = PathUtils.join(root, "retained-original.msf");
    let journal = await MigrationJournal.create(path, plan);
    registerCleanupFunction(() => journal.close());
    const backup = await createMigrationBackup(
      plan.profilePath,
      plan.mailPaths,
      plan.backupPath
    );
    await journal.recordBackup(backup);
    const token = await journal.beginImport("folder-source");
    await journal.recordImport("folder-source", {
      token,
      sourceSha256: source.sha256,
      ...physicalReceiptModel(journal),
      sourcePhysicalIdentity: journal.state.sources[0].physicalIdentity,
      folderId: 9,
      keys: [
        [3, 700],
        [1, 401],
      ],
    });
    const committed = journal.state;
    const persisted = await IOUtils.read(path);
    Assert.equal(committed.sources[0].state, "imported");
    Assert.deepEqual(committed.sources[0].receipt.keys, [
      [1, 401],
      [3, 700],
    ]);
    journal.close();

    // Only mutate after the original operation and its leases have settled.
    if (mode == "changed") {
      const changed = original.slice();
      changed[changed.length - 1] ^= 1;
      await IOUtils.write(source.path, changed);
      Assert.equal((await IOUtils.stat(source.path)).size, source.size);
      Assert.notEqual(await hashMigrationFile(source.path), source.sha256);
    } else {
      await IOUtils.move(source.path, saved, { noOverwrite: true });
      if (mode == "replaced") {
        await IOUtils.copy(saved, source.path, { noOverwrite: true });
        Assert.equal(await hashMigrationFile(source.path), source.sha256);
      }
    }

    const reopenRefuses = AppConstants.platform == "win" && mode != "changed";
    if (!reopenRefuses) {
      journal = await MigrationJournal.open(path, plan.profilePath);
      Assert.deepEqual(
        journal.state,
        committed,
        mode + ": reopen retains progress"
      );
    }
    await Assert.rejects(
      reopenRefuses
        ? MigrationJournal.open(path, plan.profilePath)
        : journal.beginImport("folder-source"),
      error =>
        mode == "missing"
          ? error.result === Cr.NS_ERROR_FILE_NOT_FOUND
          : error.name === "Error" &&
            error.message ===
              (mode == "replaced"
                ? "Retained Windows migration physical identity changed"
                : "Migration source changed since backup"),
      mode + ": committed progress cannot bypass source verification"
    );
    Assert.deepEqual(
      await IOUtils.readJSON(path),
      committed,
      mode + ": failure retains committed mapping"
    );
    if (!reopenRefuses) {
      Assert.deepEqual(
        journal.state,
        committed,
        mode + ": failure retains mapping"
      );
    }
    Assert.deepEqual(
      await IOUtils.read(path),
      persisted,
      mode + ": no journal write"
    );
    Assert.deepEqual(await verifyMigrationBackup(plan.backupPath), backup);
    journal.close();

    if (mode == "changed") {
      await IOUtils.write(source.path, original);
    } else {
      if (mode == "replaced") {
        // This is the test replacement; the original still exists at saved.
        await IOUtils.remove(source.path);
      }
      await IOUtils.move(saved, source.path, { noOverwrite: true });
    }
    journal = await MigrationJournal.open(path, plan.profilePath);
    Assert.equal(await journal.beginImport("folder-source"), token);
    Assert.deepEqual(journal.state, committed, mode + ": retry is read-only");
    Assert.deepEqual(await IOUtils.read(path), persisted);
    Assert.deepEqual(await IOUtils.read(source.path), original);
    Assert.deepEqual(await verifyMigrationBackup(plan.backupPath), backup);
    journal.close();
  }
});

add_task(async function test_protocolUnitMembershipAndReceiptAreAtomic() {
  const { plan, path } = await migrationFiles();
  const directory = plan.mailPaths[0];
  const secondPath = PathUtils.join(directory, "Second.msf");
  const secondStore = PathUtils.join(directory, "Second");
  await IOUtils.copy(plan.sources[0].path, secondPath);
  await IOUtils.copy(PathUtils.join(directory, "Inbox"), secondStore);
  plan.sources[0].protocol = "imap";
  plan.sources[0].databaseSourceId = "journal-unit-without-native-target";
  plan.sources.push({
    ...structuredClone(plan.sources[0]),
    id: "second-source",
    path: secondPath,
    destinationFolderId: 10,
  });
  if (AppConstants.platform == "win") {
    const { captureMorkFolderWindowsInventory } = ChromeUtils.importESModule(
      "resource:///modules/panorama/MorkFolderImport.sys.mjs"
    );
    plan.sources[1].inventory = captureMorkFolderWindowsInventory(
      new FileUtils.File(secondPath),
      new FileUtils.File(directory),
      new FileUtils.File(secondStore),
      new FileUtils.File(directory)
    );
  }
  let journal = await MigrationJournal.create(path, plan);
  registerCleanupFunction(() => journal.close());
  Assert.equal(journal.state.version, 6);
  await journal.recordBackup(
    await createMigrationBackup(
      plan.profilePath,
      plan.mailPaths,
      plan.backupPath
    )
  );
  await Assert.rejects(
    journal.beginImport("folder-source"),
    error =>
      error.message === "IMAP sources require a complete protocol import unit"
  );
  const ids = ["folder-source", "second-source"];
  const token = await journal.beginImportUnit(ids);
  Assert.ok(
    journal.state.sources.every(source => source.token !== token),
    "The durable unit token is distinct from every native member receipt token"
  );
  const intentRevision = journal.state.revision;
  Assert.equal(await journal.beginImportUnit([...ids].reverse()), token);
  Assert.equal(journal.state.revision, intentRevision);
  await Assert.rejects(
    journal.beginImportUnit(["second-source"]),
    error => error.message === "Migration protocol unit overlaps existing work"
  );
  Assert.ok(
    journal.state.sources.every(source => source.state === "importing")
  );

  // Model the committed native result to test journal checkpoint mechanics.
  // The genuine protocol/MDB producer and native import execute in the IM test.
  const sources = journal.state.sources;
  const request = {
    version: 3,
    protocol: "imap",
    token,
    databaseSourceId: sources[0].databaseSourceId,
    folders: sources.map((source, index) => {
      let windowsAdmission;
      let measured;
      if (AppConstants.platform == "win") {
        const { validateMorkFolderWindowsInventory } =
          ChromeUtils.importESModule(
            "resource:///modules/panorama/MorkFolderImport.sys.mjs"
          );
        windowsAdmission = source.inventory.windowsAdmission;
        measured = validateMorkFolderWindowsInventory(source.inventory);
      }
      return {
        version: AppConstants.platform == "win" ? 2 : 1,
        token: source.token,
        sourceId: source.id,
        databaseSourceId: source.databaseSourceId,
        folder: {
          id: source.destinationFolderId,
          uri: "imap://journal.invalid/" + source.id,
          protocol: "imap",
          summaryPath: measured?.summary.canonicalPath ?? source.path,
          storePath:
            measured?.store.canonicalPath ??
            PathUtils.join(directory, index ? "Second" : "Inbox"),
          storeType: "mbox",
          storeExists: true,
        },
        source: {
          path: source.path,
          size: source.size,
          sha256: source.sha256,
          messageKeys: [...source.messageKeys],
          ...(source.physicalIdentity
            ? { physicalIdentity: source.physicalIdentity }
            : {}),
        },
        ...(windowsAdmission ? { windowsAdmission } : {}),
        imap: {
          version: 1,
          originalFolderURI: "imap://journal.invalid/" + source.id,
          uidValidity: { present: true, value: 17 },
          serverUids: [
            { sourceKey: 1, uid: 11 },
            { sourceKey: 3, uid: 13 },
          ],
          operations: [],
        },
      };
    }),
  };
  const memberTokenRequest = structuredClone(request);
  memberTokenRequest.token = request.folders[0].token;
  const beforeBinding = await IOUtils.read(path);
  await Assert.rejects(
    journal.bindImportUnit(memberTokenRequest),
    error =>
      error.name === "Error" &&
      error.message === "Migration protocol import unit was not started"
  );
  Assert.deepEqual(await IOUtils.read(path), beforeBinding);
  await journal.bindImportUnit(request);
  const boundRevision = journal.state.revision;
  await journal.bindImportUnit(structuredClone(request));
  Assert.equal(journal.state.revision, boundRevision);
  const changedInput = structuredClone(request);
  changedInput.folders[1].imap.uidValidity.value++;
  await Assert.rejects(
    journal.bindImportUnit(changedInput),
    error => error.message === "Migration protocol input changed after intent"
  );
  Assert.equal(journal.state.revision, boundRevision);
  const receipt = {
    version: 3,
    token,
    databaseSourceId: request.databaseSourceId,
    protocol: "imap",
    folders: request.folders.map((member, index) => {
      const base = 400 + index * 100;
      let measured;
      if (AppConstants.platform == "win") {
        const { validateMorkFolderWindowsInventory } =
          ChromeUtils.importESModule(
            "resource:///modules/panorama/MorkFolderImport.sys.mjs"
          );
        measured = validateMorkFolderWindowsInventory(sources[index].inventory);
      }
      return {
        token: member.token,
        sourceId: member.sourceId,
        databaseSourceId: member.databaseSourceId,
        sourceSha256: member.source.sha256,
        folderId: member.folder.id,
        keys: [
          [1, base + 1],
          [3, base + 3],
        ],
        ...(measured
          ? {
              version: 2,
              windowsAdmission: measured,
              sourcePhysicalIdentity: member.source.physicalIdentity,
            }
          : {}),
        imap: {
          version: 1,
          originalFolderURI: member.imap.originalFolderURI,
          uidValidity: structuredClone(member.imap.uidValidity),
          serverUids: member.imap.serverUids.map(binding => ({
            ...binding,
            key: base + binding.sourceKey,
          })),
          operationKeys: [],
          operations: [],
        },
      };
    }),
  };
  const before = await IOUtils.read(path);
  const incomplete = structuredClone(receipt);
  incomplete.folders[1].imap.serverUids[0].uid++;
  await Assert.rejects(
    journal.recordImportUnit(token, incomplete),
    error =>
      error.name === "Error" &&
      error.message === "Native Mork UID binding changed"
  );
  Assert.deepEqual(await IOUtils.read(path), before);
  Assert.ok(
    journal.state.sources.every(source => source.state === "importing")
  );
  await journal.setCancelled(true);
  await journal.recordImportUnit(token, receipt);
  Assert.ok(journal.state.sources.every(source => source.state === "imported"));
  const committedRevision = journal.state.revision;
  await journal.recordImportUnit(token, structuredClone(receipt));
  Assert.equal(journal.state.revision, committedRevision);
  journal.close();
  journal = await MigrationJournal.open(path, plan.profilePath);
  Assert.equal(journal.state.protocolUnits[0].state, "imported");
  Assert.equal(journal.state.protocolUnits[0].token, token);
  Assert.ok(
    journal.state.cancelled,
    "Commit is checkpointed before honoring cancellation"
  );
  Assert.deepEqual(
    journal.state.sources.map(source => source.receipt.keys),
    [
      [
        [1, 401],
        [3, 403],
      ],
      [
        [1, 501],
        [3, 503],
      ],
    ]
  );
  await journal.setCancelled(false);
  await journal.finishStage("import");
  if (AppConstants.platform == "win") {
    await Assert.rejects(
      journal.finishStage("validate"),
      error => error.message === "Windows migration activation remains held"
    );
    Assert.equal(journal.state.stage, "validate");
  }
});

add_task(async function test_stageTransitionsPersistCancellationAndReceipts() {
  const { plan, path } = await migrationFiles();
  const original = await IOUtils.read(plan.sources[0].path);
  let journal = await MigrationJournal.create(path, plan);
  registerCleanupFunction(() => journal.close());
  const planned = journal.state.sources[0];
  const reopenAtStage = async stage => {
    const state = journal.state;
    const bytes = await IOUtils.read(path);
    Assert.equal(state.stage, stage);
    journal.close();
    journal = await MigrationJournal.open(path, plan.profilePath);
    Assert.deepEqual(
      journal.state,
      state,
      stage + ": exact state survives reopen"
    );
    Assert.deepEqual(
      await IOUtils.read(path),
      bytes,
      stage + ": reopen is read-only"
    );
  };
  const refuseTransition = async (
    stage,
    message = "Migration is cancelled or at another stage"
  ) => {
    const state = journal.state;
    const bytes = await IOUtils.read(path);
    await Assert.rejects(
      journal.finishStage(stage),
      error => error.name === "Error" && error.message === message,
      stage + ": invalid transition refuses before writing"
    );
    Assert.deepEqual(journal.state, state, stage + ": refusal retains state");
    Assert.deepEqual(
      await IOUtils.read(path),
      bytes,
      stage + ": no journal write"
    );
  };

  await reopenAtStage("backup");
  await refuseTransition("import");
  const backup = await createMigrationBackup(
    plan.profilePath,
    plan.mailPaths,
    plan.backupPath
  );
  await journal.recordBackup(backup);
  await reopenAtStage("import");
  await refuseTransition("activate");
  await refuseTransition("import", "Migration imports are incomplete");
  const token = await journal.beginImport("folder-source");
  await journal.recordImport("folder-source", {
    token,
    sourceSha256: plan.sources[0].sha256,
    ...physicalReceiptModel(journal),
    sourcePhysicalIdentity: journal.state.sources[0].physicalIdentity,
    folderId: 9,
    keys: [
      [3, 700],
      [1, 401],
    ],
  });
  const committed = journal.state.sources[0].receipt;
  await journal.recordError(new TypeError("validation retry required"));
  await reopenAtStage("import");
  Assert.deepEqual(journal.state.lastError, {
    name: "TypeError",
    message: "validation retry required",
  });
  await refuseTransition("activate");

  // The stage owner records completed work; this test never activates a profile.
  await journal.finishStage("import");
  await reopenAtStage("validate");
  await journal.setCancelled(true);
  await reopenAtStage("validate");
  await refuseTransition("validate");
  await refuseTransition("activate");
  await journal.setCancelled(false);
  await refuseTransition("activate");
  if (AppConstants.platform == "win") {
    await refuseTransition(
      "validate",
      "Windows migration activation remains held"
    );
  } else {
    await journal.finishStage("validate");
    await reopenAtStage("activate");
    await refuseTransition("validate");
    await journal.finishStage("activate");
    await reopenAtStage("complete");
    await refuseTransition("activate");
  }

  Assert.deepEqual(
    { ...journal.state.sources[0], state: "pending", receipt: null },
    planned,
    "Every stage retains the exact original plan and intent"
  );
  Assert.deepEqual(journal.state.sources[0].receipt, committed);
  Assert.equal(journal.state.sources[0].receipt.token, token);
  Assert.deepEqual(journal.state.lastError, {
    name: "TypeError",
    message: "validation retry required",
  });
  Assert.deepEqual(await IOUtils.read(plan.sources[0].path), original);
  Assert.deepEqual(await verifyMigrationBackup(plan.backupPath), backup);
  journal.close();
});

/**
 * Creates a real unbound startup plan; no native import/target is fabricated.
 *
 * @returns {Promise<{journal: MigrationJournal, path: string, backup: object,
 *   profilePath: string, source: string}>} Original files and retained plan.
 */
async function startupJournalPlan() {
  // Startup origins are compared with their normalized physical path, and the
  // macOS temporary directory is reached through a /var link.
  const rootFile = new FileUtils.File(
    await IOUtils.createUniqueDirectory(PathUtils.tempDir, "startup-journal-")
  );
  rootFile.normalize();
  const root = rootFile.path;
  registerCleanupFunction(() => IOUtils.remove(root, { recursive: true }));
  const profilePath = PathUtils.join(root, "profile");
  const work = PathUtils.join(root, "work");
  await IOUtils.makeDirectory(profilePath);
  await IOUtils.makeDirectory(work);
  const source = PathUtils.join(profilePath, "Inbox.msf");
  await IOUtils.copy(do_get_file("data/migration.msf").path, source);
  const { identity } = await readMorkMigrationSource(source);
  const backupPath = PathUtils.join(root, "backup");
  const backup = await createMigrationBackup(profilePath, [], backupPath);
  const path = PathUtils.join(work, "journal.json");
  const journal = await MigrationJournal.create(path, {
    profilePath,
    mailPaths: [],
    backupPath,
    sources: [],
    startupInventory: {
      sources: [
        {
          id: "Inbox",
          ...identity,
          serverKey: "server1",
          serverRoot: profilePath,
          protocol: "none",
          storeType: "mbox",
          storeContractID: "@mozilla.org/msgstore/berkeleystore;1",
          storePath: source.slice(0, -4),
          origin: { provider: "local-store-discovery" },
        },
      ],
      caches: [],
    },
  });
  registerCleanupFunction(() => journal.close());
  return { journal, path, backup, profilePath, source };
}

add_task(
  { skip_if: () => AppConstants.platform === "win" },
  async function test_startupJournalRetainsInputsBeforeNativeBinding() {
    const input = await startupJournalPlan();
    const source = await IOUtils.read(input.source);
    const state = input.journal.state;
    Assert.equal(state.version, 7);
    Assert.equal(state.stage, "backup");
    Assert.deepEqual(state.sources, [], "No destination IDs are invented");
    Assert.strictEqual(state.startup.databaseSourceId, null);
    Assert.equal(state.startup.bound, false);
    Assert.equal(state.startup.inventory.sources[0].path, input.source);
    input.journal.close();
    const reopened = await MigrationJournal.open(input.path, input.profilePath);
    Assert.deepEqual(
      reopened.state,
      state,
      "Reopen preserves the exact pending plan"
    );
    reopened.close();
    Assert.deepEqual(
      state.protocolUnits,
      [],
      "Unbound startup has no IMAP unit"
    );
    const retained = await IOUtils.read(input.path);
    for (const invalid of [
      { ...state, protocolUnits: null },
      { ...state, protocolUnits: [{}] },
      { ...state, version: 6, startup: undefined },
    ]) {
      await IOUtils.writeJSON(input.path, invalid);
      const corrupt = await IOUtils.read(input.path);
      await Assert.rejects(
        MigrationJournal.open(input.path, input.profilePath),
        /Invalid migration protocol journal/,
        "Only version7 can retain an empty unbound protocol inventory"
      );
      Assert.deepEqual(await IOUtils.read(input.path), corrupt);
      Assert.deepEqual(await IOUtils.read(input.source), source);
    }
    await IOUtils.write(input.path, retained);
    Assert.deepEqual(await IOUtils.read(input.source), source);
    Assert.ok(
      !(await IOUtils.exists(
        PathUtils.join(input.profilePath, "panorama.sqlite")
      ))
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform === "win" },
  async function test_startupJournalCannotSkipActualNativeBinding() {
    const input = await startupJournalPlan();
    const before = await IOUtils.read(input.path);
    const source = await IOUtils.read(input.source);
    await Assert.rejects(
      input.journal.recordBackup(input.backup),
      /native target binding/,
      "Even a real verified backup cannot invent the actual native target"
    );
    Assert.deepEqual(await IOUtils.read(input.path), before);
    Assert.deepEqual(await IOUtils.read(input.source), source);
    Assert.equal(input.journal.state.stage, "backup");
  }
);

add_task(
  { skip_if: () => AppConstants.platform === "win" },
  async function test_startupJournalCorruptionIsNeverAnEmptyPlan() {
    const input = await startupJournalPlan();
    const state = input.journal.state;
    input.journal.close();
    state.startup.inventory.sources[0].sha256 = "corrupt";
    await IOUtils.writeJSON(input.path, state);
    const before = await IOUtils.read(input.path);
    await Assert.rejects(
      MigrationJournal.open(input.path, input.profilePath),
      /startup source identity/
    );
    Assert.deepEqual(
      await IOUtils.read(input.path),
      before,
      "Invalid retained progress is not recreated or repaired"
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform === "win" },
  async function test_startupJournalRefusesChangedNativeProvider() {
    const input = await startupJournalPlan();
    const state = input.journal.state;
    const original = await IOUtils.read(input.source);
    input.journal.close();
    state.startup.inventory.sources[0].origin.provider = "public-folder-insert";
    await IOUtils.writeJSON(input.path, state);
    const before = await IOUtils.read(input.path);
    await Assert.rejects(
      MigrationJournal.open(input.path, input.profilePath),
      /startup folder origin/,
      "A public row is not genuine native discovery"
    );
    Assert.deepEqual(await IOUtils.read(input.path), before);
    Assert.deepEqual(await IOUtils.read(input.source), original);
    Assert.ok(
      !(await IOUtils.exists(
        PathUtils.join(input.profilePath, "panorama.sqlite")
      ))
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform === "win" },
  async function test_startupJournalRetainsUnicodeCacheDescriptor() {
    // Retained startup paths are normalized physical paths, and the macOS
    // temporary directory is reached through a /tmp link.
    const rootFile = new FileUtils.File(
      await IOUtils.createUniqueDirectory(
        PathUtils.tempDir,
        "startup-journal-unicode-"
      )
    );
    rootFile.normalize();
    const root = rootFile.path;
    registerCleanupFunction(() => IOUtils.remove(root, { recursive: true }));
    const profilePath = PathUtils.join(root, "\u90ae\u4ef6-e\u0301");
    const work = PathUtils.join(root, "work");
    await IOUtils.makeDirectory(profilePath);
    await IOUtils.makeDirectory(work);
    const source = PathUtils.join(profilePath, "Inbox.msf");
    await IOUtils.copy(do_get_file("data/migration.msf").path, source);
    const sourceBytes = await IOUtils.read(source);
    const { identity } = await readMorkMigrationSource(source);
    const { MailStringUtils } = ChromeUtils.importESModule(
      "resource:///modules/MailStringUtils.sys.mjs"
    );
    const raw = new FileUtils.File(source).persistentDescriptor;
    const key = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(MailStringUtils.byteStringToUint8Array(raw));
    Assert.notEqual(
      key,
      raw,
      "The actual non-ASCII descriptor is a byte string"
    );
    const encoded = [...new TextEncoder().encode(key)]
      .map(byte => "$" + byte.toString(16).padStart(2, "0"))
      .join("");
    const cachePath = PathUtils.join(profilePath, "panacea.dat");
    // A strict parser fixture, never a native folder/receipt/origin grant.
    await IOUtils.writeUTF8(
      cachePath,
      '// <!-- <mdb:mork:z v="1.4"/> -->\n' +
        "< <(a=c)>(80=ns:msg:db:row:scope:folders:all)" +
        "(81=ns:msg:db:table:kind:folders)(82=key)" +
        "(8A=boxFlags)(8B=hierDelim)(8C=onlineName)>\n" +
        "{1:^80 {(k^81:c)} [1(^82=" +
        encoded +
        ")(^8A=0)(^8B=2f)(^8C=INBOX)]}\n"
    );
    const cacheBytes = await IOUtils.read(cachePath);
    const { cache, identity: cacheIdentity } =
      await readMorkFolderCacheSource(cachePath);
    const row = cache.entries.get(key);
    Assert.ok(row, "The strict original cache reader projects the UTF-8 key");
    Assert.equal(row.values.boxFlags, 0, "Explicit zero remains present");
    Assert.equal(row.values.hierDelim, 47);
    const backupPath = PathUtils.join(root, "backup");
    await createMigrationBackup(profilePath, [], backupPath);
    const path = PathUtils.join(work, "journal.json");
    const journal = await MigrationJournal.create(path, {
      profilePath,
      mailPaths: [],
      backupPath,
      sources: [],
      startupInventory: {
        sources: [
          {
            id: "unicode-summary",
            ...identity,
            serverKey: "server1",
            serverRoot: profilePath,
            storePath: source.slice(0, -4),
            storeType: "mbox",
            protocol: "imap",
            storeContractID: "@mozilla.org/msgstore/berkeleystore;1",
            origin: {
              provider: "imap-client-discovery",
              cache: {
                ...cacheIdentity,
                originalKey: key,
                sourceKey: row.sourceKey,
              },
              originalCells: Object.fromEntries(
                ["onlineName", "hierDelim", "boxFlags"].map(name => [
                  name,
                  row.properties.get(name),
                ])
              ),
              onlineName: row.values.onlineName,
              hierarchyDelimiter: row.values.hierDelim,
              boxFlags: row.values.boxFlags,
            },
          },
        ],
        caches: [
          {
            id: "cache",
            ...cacheIdentity,
            cacheKeys: [...cache.entries.keys()],
          },
        ],
      },
    });
    registerCleanupFunction(() => journal.close());
    const state = journal.state;
    const before = await IOUtils.read(path);
    Assert.equal(state.startup.bound, false, "No native target is invented");
    Assert.strictEqual(state.startup.databaseSourceId, null);
    Assert.strictEqual(state.startup.inventory.sources[0].folderURI, undefined);
    journal.close();
    const reopened = await MigrationJournal.open(path, profilePath);
    Assert.deepEqual(reopened.state, state);
    reopened.close();
    Assert.deepEqual(await IOUtils.read(path), before);
    // Thunderbird writes the unknown '^' (94) or NIL '|' (124) sentinel for a
    // client folder the server never listed; only one exact level is admitted.
    const retainedOrigin = state.startup.inventory.sources[0].origin;
    for (const [hierarchyDelimiter, onlineName, admitted] of [
      [94, "Junk", true],
      [124, "Junk", true],
      [94, "Junk/Spam", false],
      [94, "Junk^Spam", false],
      [124, "Junk|Spam", false],
    ]) {
      state.startup.inventory.sources[0].origin = {
        ...retainedOrigin,
        hierarchyDelimiter,
        onlineName,
      };
      await IOUtils.writeJSON(path, state);
      const bytes = await IOUtils.read(path);
      if (admitted) {
        const unknown = await MigrationJournal.open(path, profilePath);
        Assert.deepEqual(unknown.state, state, `${onlineName} is exact`);
        unknown.close();
      } else {
        await Assert.rejects(
          MigrationJournal.open(path, profilePath),
          /startup IMAP cache origin/,
          `${onlineName} is ambiguous without a known delimiter`
        );
      }
      Assert.deepEqual(await IOUtils.read(path), bytes);
    }
    state.startup.inventory.sources[0].origin = retainedOrigin;
    state.startup.inventory.sources[0].origin.cache.originalKey = raw;
    await IOUtils.writeJSON(path, state);
    const invalid = await IOUtils.read(path);
    await Assert.rejects(
      MigrationJournal.open(path, profilePath),
      /startup IMAP cache origin/
    );
    Assert.deepEqual(await IOUtils.read(path), invalid);
    Assert.deepEqual(await IOUtils.read(source), sourceBytes);
    Assert.deepEqual(await IOUtils.read(cachePath), cacheBytes);
    Assert.ok(
      !(await IOUtils.exists(PathUtils.join(profilePath, "panorama.sqlite")))
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform === "win" },
  async function test_startupJournalRetainsSeparateServerSummary() {
    const input = await startupJournalPlan();
    const state = input.journal.state;
    input.journal.close();
    // This is unbound journal metadata. Only native startup may admit its bytes.
    const root = PathUtils.join(
      input.profilePath,
      "ImapMail",
      "server.invalid"
    );
    await IOUtils.makeDirectory(PathUtils.parent(root));
    await IOUtils.makeDirectory(root);
    const summary = {
      id: "server-summary:ImapMail/server.invalid.msf",
      role: "imap-server-root-summary",
      path: root + ".msf",
      serverKey: "server2",
      serverRoot: root,
      protocol: "imap",
      storeType: "mbox",
      storeContractID: "@mozilla.org/msgstore/berkeleystore;1",
      sha256: "a".repeat(64),
      size: 526,
      messageKeys: [],
    };
    state.startup.inventory.serverSummaries = [summary];
    await IOUtils.writeJSON(input.path, state);
    const retained = await IOUtils.read(input.path);
    const reopened = await MigrationJournal.open(input.path, input.profilePath);
    registerCleanupFunction(() => reopened.close());
    Assert.deepEqual(reopened.state.startup.inventory.serverSummaries, [
      summary,
    ]);
    Assert.equal(reopened.state.startup.inventory.sources.length, 1);
    Assert.deepEqual(
      reopened.state.sources,
      [],
      "Root metadata invents no import"
    );
    Assert.strictEqual(reopened.state.startup.databaseSourceId, null);
    Assert.deepEqual(await IOUtils.read(input.path), retained);
    reopened.close();
    for (const change of [
      { serverSummaries: null },
      { serverSummaries: [{ ...summary, role: "child-folder" }] },
      { serverSummaries: [{ ...summary, storeType: "maildir" }] },
      { serverSummaries: [{ ...summary, messageKeys: [42] }] },
      {
        serverSummaries: [
          { ...summary, serverRoot: PathUtils.parent(input.profilePath) },
        ],
      },
      {
        serverSummaries: [
          summary,
          { ...summary, id: "duplicate-root", path: root + "-other.msf" },
        ],
      },
    ]) {
      const changed = structuredClone(state);
      Object.assign(changed.startup.inventory, change);
      await IOUtils.writeJSON(input.path, changed);
      const before = await IOUtils.read(input.path);
      await Assert.rejects(
        MigrationJournal.open(input.path, input.profilePath),
        /startup server-summary|retained startup server-summary/,
        "Malformed or data-bearing root metadata stays explicit recovery"
      );
      Assert.deepEqual(await IOUtils.read(input.path), before);
      Assert.ok(
        !(await IOUtils.exists(
          PathUtils.join(input.profilePath, "panorama.sqlite")
        ))
      );
    }
  }
);

add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function test_windowsStartupJournalIsPhysical() {
    // The selected-startup journal7 keeps journal4's Windows physical
    // admission: original roots plus profile and work directory file IDs.
    const { plan, path } = await migrationFiles();
    const journal = await MigrationJournal.create(path, {
      profilePath: plan.profilePath,
      mailPaths: [],
      backupPath: plan.backupPath,
      sources: [],
      startupInventory: { sources: [], caches: [], serverSummaries: [] },
    });
    registerCleanupFunction(() => journal.close());
    const state = journal.state;
    Assert.equal(state.version, 7);
    Assert.equal(state.stage, "backup");
    Assert.deepEqual(
      state.originalRoots.map(root => root.canonicalPath),
      [canonicalRoot(plan.profilePath)]
    );
    Assert.equal(state.profilePhysicalIdentity.version, 1);
    Assert.equal(state.workPhysicalIdentity.version, 1);
    journal.close();
    const reopened = await MigrationJournal.open(path, plan.profilePath);
    try {
      Assert.deepEqual(reopened.state, state);
    } finally {
      reopened.close();
    }
  }
);
