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
const { MigrationJournal } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationJournal.sys.mjs"
);
const { createMigrationBackup, verifyMigrationBackup } =
  ChromeUtils.importESModule(
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
