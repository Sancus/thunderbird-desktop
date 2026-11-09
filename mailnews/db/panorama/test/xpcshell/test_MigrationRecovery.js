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
const { createMigrationBackup, verifyMigrationBackup, stageMigrationRestore } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MigrationBackup.sys.mjs"
  );
const { inspectMigrationRecovery, stageInterruptedMigrationRestore } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MigrationRecovery.sys.mjs"
  );
const { stageMigrationProfileRestore } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationProfile.sys.mjs"
);

let home;
let profileService;
let serial = 0;

add_setup(async function setupNativeProfiles() {
  do_get_profile();
  const { updateAppInfo } = ChromeUtils.importESModule(
    "resource://testing-common/AppInfo.sys.mjs"
  );
  updateAppInfo({
    name: "XPCShell",
    version: "1.0",
    appBuildID: "20261028000000",
  });
  // Match toolkit/profile/test/xpcshell/head.js at the pinned Gecko revision.
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
  profileService = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
    Ci.nsIToolkitProfileService
  );
  home = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "migration-recovery-"
  );
  registerCleanupFunction(() => IOUtils.remove(home, { recursive: true }));
});

/**
 * Creates and holds an actual toolkit profile lock, without a migration plan.
 *
 * @param {boolean} [canonical=false] - Select the canonical profile spelling.
 * @returns {object} Native profile/lock and private per-case work directory.
 */
async function lockedProfile(canonical = false) {
  const name = "migration-recovery-" + ++serial;
  let root = PathUtils.join(home, name);
  await IOUtils.makeDirectory(root);
  if (canonical) {
    // Restore requests bind canonical selected paths, and the macOS temporary
    // directory is reached through a /var link.
    const file = new FileUtils.File(root);
    file.normalize();
    root = file.path;
  }
  const profile = profileService.createProfile(
    new FileUtils.File(PathUtils.join(root, "profile")),
    name,
    "tests"
  );
  const lock = profile.lock({});
  registerCleanupFunction(() => {
    lock.unlock();
    profile.remove(false);
  });
  Assert.ok(
    lock.directory.equals(profile.rootDir),
    "Actual toolkit lock selects the profile"
  );
  return { root, profile, lock };
}

/**
 * Builds a closed backup/journal and models a durable interrupted selector.
 * Receipt key pairs are unit input, not evidence of a native database import.
 * Only the existing genuine MSF/body inputs are copied; no legacy encoder runs.
 *
 * @param {string} [state="prepared"] - Prepared, restore-required or active selector.
 * @param {boolean} [externalStore=false] - Include an independent external mail root.
 * @returns {Promise<object>} Held profile and real persisted recovery inputs.
 */
async function recoveryInput(state = "prepared", externalStore = false) {
  const input = await lockedProfile();
  const profilePath = input.lock.directory.path;
  const source = PathUtils.join(profilePath, "Inbox.msf");
  const body = PathUtils.join(profilePath, "Inbox");
  await IOUtils.copy(do_get_file("data/migration.msf").path, source);
  await IOUtils.copy(do_get_file("data/migration").path, body);
  const journalPath = PathUtils.join(input.root, "journal.json");
  const backupPath = PathUtils.join(input.root, "backup");
  const mailPaths = [];
  const sources = [
    { id: "folder-source", path: source, destinationFolderId: 9 },
  ];
  let externalSource, externalBody;
  if (externalStore) {
    const mail = PathUtils.join(input.root, "external-mail");
    await IOUtils.makeDirectory(mail);
    externalSource = PathUtils.join(mail, "Inbox.msf");
    externalBody = PathUtils.join(mail, "Inbox");
    await IOUtils.copy(do_get_file("data/migration.msf").path, externalSource);
    await IOUtils.copy(do_get_file("data/migration").path, externalBody);
    mailPaths.push(mail);
    sources.push({
      id: "external-folder-source",
      path: externalSource,
      destinationFolderId: 10,
    });
  }
  for (const entry of sources) {
    entry.size = (await IOUtils.stat(entry.path)).size;
    entry.sha256 = await IOUtils.computeHexDigest(entry.path, "sha256");
    entry.messageKeys = [1, 3];
    entry.databaseSourceId = "unit-database-incarnation";
  }
  const journal = await MigrationJournal.create(journalPath, {
    profilePath,
    mailPaths,
    backupPath,
    sources,
  });
  let snapshot;
  try {
    await journal.recordBackup(
      await createMigrationBackup(profilePath, mailPaths, backupPath)
    );
    for (const entry of sources) {
      const token = await journal.beginImport(entry.id);
      const recorded = journal.state.sources.find(item => item.id == entry.id);
      await journal.recordImport(entry.id, {
        token,
        sourceSha256: entry.sha256,
        sourcePhysicalIdentity: recorded.physicalIdentity,
        folderId: entry.destinationFolderId,
        keys:
          entry.id == "folder-source"
            ? [
                [1, 401],
                [3, 700],
              ]
            : [
                [1, 900],
                [3, 901],
              ],
      });
    }
    await journal.finishStage("import");
    await journal.finishStage("validate");
    if (state != "prepared") {
      await journal.finishStage("activate");
    }
    snapshot = journal.state;
  } finally {
    journal.close();
  }
  const marker = PathUtils.join(profilePath, "panorama-profile.json");
  await IOUtils.writeJSON(
    marker,
    {
      formatVersion: 1,
      state,
      application: { version: "1.0", buildId: Services.appinfo.appBuildID },
      identity: {
        profilePath: snapshot.profilePath,
        journalPath,
        backup: snapshot.backup,
        imports: snapshot.sources.map(entry => ({
          id: entry.id,
          token: entry.token,
          sha256: entry.sha256,
          folderId: entry.destinationFolderId,
        })),
      },
    },
    { mode: "create" }
  );
  return {
    ...input,
    source,
    body,
    marker,
    journalPath,
    backupPath,
    externalSource,
    externalBody,
  };
}

add_task(async function test_requiresAProfileLock() {
  await Assert.rejects(
    inspectMigrationRecovery(null),
    error =>
      error.name == "TypeError" &&
      error.message == "Expected a held profile lock"
  );
});

add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function test_windowsRecoveryRequiresNativePathAdmission() {
    const input = await lockedProfile();
    const before = (
      await IOUtils.getChildren(input.lock.directory.path)
    ).sort();
    await Assert.rejects(
      inspectMigrationRecovery(input.lock),
      /requires native reparse admission/
    );
    Assert.deepEqual(
      (await IOUtils.getChildren(input.lock.directory.path)).sort(),
      before
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_readsPreparedStateWithoutAdvancingOrUnlocking() {
    const input = await recoveryInput();
    const paths = [
      input.marker,
      input.journalPath,
      input.source,
      input.body,
      PathUtils.join(input.backupPath, "manifest.json"),
    ];
    const before = await Promise.all(paths.map(path => IOUtils.read(path)));
    const result = await inspectMigrationRecovery(input.lock);
    Assert.equal(result.profile.state, "prepared");
    Assert.equal(result.journal.stage, "activate");
    Assert.equal(result.journal.sources[0].id, "folder-source");
    Assert.equal(
      result.journal.sources[0].databaseSourceId,
      "unit-database-incarnation"
    );
    Assert.deepEqual(result.journal.sources[0].receipt.keys, [
      [1, 401],
      [3, 700],
    ]);
    Assert.ok(
      input.lock.directory.equals(input.profile.rootDir),
      "Caller retains the lock"
    );
    result.profile.record.state = "active";
    result.journal.sources[0].receipt.keys[0][1] = 999;
    Assert.deepEqual(
      await Promise.all(paths.map(path => IOUtils.read(path))),
      before
    );
    const reopened = await MigrationJournal.open(
      input.journalPath,
      input.lock.directory.path
    );
    try {
      Assert.equal(
        reopened.state.stage,
        "activate",
        "Inspection closed its journal without advancing"
      );
    } finally {
      reopened.close();
    }
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_readsPreparedSelectorAfterJournalCompletion() {
    const input = await recoveryInput();
    const journal = await MigrationJournal.open(
      input.journalPath,
      input.lock.directory.path
    );
    try {
      await journal.finishStage("activate");
    } finally {
      journal.close();
    }
    const before = await IOUtils.read(input.marker);
    const result = await inspectMigrationRecovery(input.lock);
    Assert.equal(result.profile.state, "prepared");
    Assert.equal(result.journal.stage, "complete");
    Assert.deepEqual(await IOUtils.read(input.marker), before);
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_restoreRequiredInspectionDoesNotStageOrCutOver() {
    const input = await recoveryInput("restore-required");
    const paths = [input.source, input.body, input.marker, input.journalPath];
    const before = await Promise.all(paths.map(path => IOUtils.read(path)));
    const children = (await IOUtils.getChildren(input.root)).sort();
    const result = await inspectMigrationRecovery(input.lock);
    Assert.equal(result.profile.state, "restore-required");
    Assert.equal(result.journal.stage, "complete");
    Assert.deepEqual((await IOUtils.getChildren(input.root)).sort(), children);
    Assert.deepEqual(
      await Promise.all(paths.map(path => IOUtils.read(path))),
      before
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_inspectsRestoreAfterCancelledActivationWithoutWriting() {
    const input = await recoveryInput();
    const journal = await MigrationJournal.open(
      input.journalPath,
      input.lock.directory.path
    );
    try {
      await journal.setCancelled(true);
    } finally {
      journal.close();
    }
    const restored = await stageMigrationProfileRestore(
      input.lock.directory.path,
      input.root
    );
    const paths = [
      input.marker,
      input.journalPath,
      input.source,
      input.body,
      PathUtils.join(input.backupPath, "manifest.json"),
      PathUtils.join(restored.roots[0].staged, "Inbox.msf"),
      PathUtils.join(restored.roots[0].staged, "Inbox"),
    ];
    const before = await Promise.all(paths.map(path => IOUtils.read(path)));
    const children = (await IOUtils.getChildren(input.root)).sort();
    const result = await inspectMigrationRecovery(input.lock);
    Assert.equal(result.profile.state, "restore-required");
    Assert.equal(result.journal.stage, "activate");
    Assert.equal(result.journal.cancelled, true);
    Assert.ok(input.lock.directory.equals(input.profile.rootDir));
    Assert.deepEqual((await IOUtils.getChildren(input.root)).sort(), children);
    Assert.deepEqual(
      await Promise.all(paths.map(path => IOUtils.read(path))),
      before
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_rejectsSelectorWithAnotherImportToken() {
    const input = await recoveryInput();
    const record = await IOUtils.readJSON(input.marker);
    record.identity.imports[0].token = "another-import";
    await IOUtils.writeJSON(input.marker, record);
    const before = await IOUtils.read(input.journalPath);
    await Assert.rejects(
      inspectMigrationRecovery(input.lock),
      /imports conflict/
    );
    Assert.deepEqual(await IOUtils.read(input.journalPath), before);
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_rejectsSelectorWithAnotherBackup() {
    const input = await recoveryInput();
    const record = await IOUtils.readJSON(input.marker);
    record.identity.backup.sha256 = "b".repeat(64);
    await IOUtils.writeJSON(input.marker, record);
    await Assert.rejects(
      inspectMigrationRecovery(input.lock),
      /identities conflict/
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_rejectsSelectorMissingAnImport() {
    const input = await recoveryInput();
    const record = await IOUtils.readJSON(input.marker);
    record.identity.imports = [];
    await IOUtils.writeJSON(input.marker, record);
    await Assert.rejects(
      inspectMigrationRecovery(input.lock),
      /identities conflict/
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_rejectsPreparedSelectorBeforeValidation() {
    const input = await recoveryInput();
    const journal = await IOUtils.readJSON(input.journalPath);
    journal.stage = "validate";
    await IOUtils.writeJSON(input.journalPath, journal);
    await Assert.rejects(
      inspectMigrationRecovery(input.lock),
      /stages conflict/
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_missingJournalIsNotRecreated() {
    const input = await recoveryInput();
    const before = await IOUtils.read(input.journalPath);
    const retained = input.journalPath + ".retained";
    await IOUtils.move(input.journalPath, retained, { noOverwrite: true });
    await Assert.rejects(
      inspectMigrationRecovery(input.lock),
      error =>
        error.name == "NotFoundError" ||
        error.result == Cr.NS_ERROR_FILE_NOT_FOUND
    );
    Assert.ok(!(await IOUtils.exists(input.journalPath)));
    Assert.deepEqual(await IOUtils.read(retained), before);
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_rejectsDamagedBackupWithoutChangingOriginal() {
    const input = await recoveryInput();
    const before = await IOUtils.read(input.source);
    await IOUtils.writeUTF8(
      PathUtils.join(input.backupPath, "root-0", "Inbox.msf"),
      "damaged backup"
    );
    await Assert.rejects(
      inspectMigrationRecovery(input.lock),
      /differs from its source/
    );
    Assert.deepEqual(await IOUtils.read(input.source), before);
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_unconvertedProfileIsNotInterruptedRecovery() {
    const input = await lockedProfile();
    const path = input.lock.directory.path;
    const before = (await IOUtils.getChildren(path)).sort();
    await Assert.rejects(
      inspectMigrationRecovery(input.lock),
      /no interrupted migration selector/
    );
    Assert.deepEqual((await IOUtils.getChildren(path)).sort(), before);
    Assert.ok(
      !(await IOUtils.exists(PathUtils.join(path, "panorama-profile.json")))
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_activeProfileIsNotInterruptedRecovery() {
    const input = await recoveryInput("active");
    const before = await IOUtils.read(input.marker);
    await Assert.rejects(
      inspectMigrationRecovery(input.lock),
      /no interrupted migration selector/
    );
    Assert.deepEqual(await IOUtils.read(input.marker), before);
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_cancelledRecoveryRemainsCancelled() {
    const input = await recoveryInput();
    const journal = await MigrationJournal.open(
      input.journalPath,
      input.lock.directory.path
    );
    try {
      await journal.setCancelled(true);
    } finally {
      journal.close();
    }
    const before = await IOUtils.read(input.journalPath);
    const result = await inspectMigrationRecovery(input.lock);
    Assert.equal(result.journal.cancelled, true);
    Assert.equal(result.journal.stage, "activate");
    Assert.deepEqual(await IOUtils.read(input.journalPath), before);
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_lockedRestoreStagesBackupAndPreservesCancelledJournal() {
    const input = await recoveryInput();
    const journal = await MigrationJournal.open(
      input.journalPath,
      input.lock.directory.path
    );
    await journal.setCancelled(true);
    journal.close();
    const before = await IOUtils.read(input.journalPath);
    const originalBody = await IOUtils.read(input.body);
    const laterBody = new TextEncoder().encode(
      "later live mail remains in the original"
    );
    await IOUtils.write(input.body, laterBody);
    const parent = PathUtils.join(input.root, "restore-staging");
    await IOUtils.makeDirectory(parent);
    const result = await stageInterruptedMigrationRestore(input.lock, parent);
    Assert.equal(result.profile.state, "restore-required");
    Assert.equal(result.journal.stage, "activate");
    Assert.equal(result.journal.cancelled, true);
    Assert.ok(input.lock.directory.equals(input.profile.rootDir));
    Assert.deepEqual(await IOUtils.read(input.journalPath), before);
    Assert.deepEqual(
      await IOUtils.read(input.body),
      laterBody,
      "No live root replacement"
    );
    Assert.equal(result.roots.length, 1);
    const root = result.roots[0];
    Assert.equal(root.original, result.journal.profilePath);
    Assert.deepEqual(
      await IOUtils.read(PathUtils.join(root.staged, "Inbox")),
      originalBody
    );
    Assert.deepEqual(
      await IOUtils.read(PathUtils.join(root.staged, "Inbox.msf")),
      await IOUtils.read(input.source)
    );
    const recorded = await IOUtils.readJSON(input.marker);
    Assert.equal(recorded.state, "restore-required");
    Assert.deepEqual(recorded.identity, result.profile.record.identity);
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_lockedRestoreIncludesExternalMailRoot() {
    const input = await recoveryInput("prepared", true);
    const before = await inspectMigrationRecovery(input.lock);
    Assert.equal(before.journal.sources.length, 2);
    const journal = await IOUtils.read(input.journalPath);
    const original = await IOUtils.read(input.externalBody);
    const summary = await IOUtils.read(input.externalSource);
    const later = new TextEncoder().encode("later external mail stays live");
    await IOUtils.write(input.externalBody, later);
    const parent = PathUtils.join(input.root, "restore-staging");
    await IOUtils.makeDirectory(parent);
    const result = await stageInterruptedMigrationRestore(input.lock, parent);
    Assert.equal(result.roots.length, 2);
    const external = new FileUtils.File(PathUtils.parent(input.externalBody));
    external.normalize();
    const root = result.roots.find(entry => entry.original == external.path);
    Assert.ok(root, "The selected external root has its own restore mapping");
    Assert.ok(
      new FileUtils.File(result.path).contains(new FileUtils.File(root.staged))
    );
    Assert.notEqual(root.staged, external.path);
    Assert.deepEqual(
      await IOUtils.read(PathUtils.join(root.staged, "Inbox")),
      original
    );
    Assert.deepEqual(
      await IOUtils.read(PathUtils.join(root.staged, "Inbox.msf")),
      summary
    );
    Assert.deepEqual(await IOUtils.read(input.externalBody), later);
    Assert.deepEqual(await IOUtils.read(input.externalSource), summary);
    Assert.deepEqual(await IOUtils.read(input.journalPath), journal);
    Assert.deepEqual(result.journal, before.journal);
    Assert.deepEqual(
      result.profile.record.identity,
      before.profile.record.identity
    );
    Assert.equal(result.profile.state, "restore-required");
    Assert.ok(input.lock.directory.equals(input.profile.rootDir));
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_restoreCopyFailureRetainsOriginalsAndRetries() {
    const { sinon } = ChromeUtils.importESModule(
      "resource://testing-common/Sinon.sys.mjs"
    );
    const input = await recoveryInput();
    const originals = new Map();
    for (const path of [
      input.marker,
      input.journalPath,
      input.source,
      input.body,
      PathUtils.join(input.backupPath, "manifest.json"),
      PathUtils.join(input.backupPath, "root-0", "Inbox.msf"),
      PathUtils.join(input.backupPath, "root-0", "Inbox"),
    ]) {
      originals.set(path, await IOUtils.read(path));
    }
    const parent = PathUtils.join(input.root, "restore-staging");
    await IOUtils.makeDirectory(parent);
    const backupIO = Cu.getGlobalForObject(createMigrationBackup).IOUtils;
    const realCopy = backupIO.copy.bind(backupIO);
    let copied;
    let copyError;
    let copies = 0;
    const copy = sinon.stub(backupIO, "copy").callsFake(async (...args) => {
      copies++;
      await realCopy(...args);
      copied = { source: args[0], destination: args[1] };
      try {
        // Reach a real filesystem error after completing one restore copy.
        await realCopy(args[0], args[1], { noOverwrite: true });
      } catch (error) {
        copyError = error;
        throw error;
      }
    });
    try {
      await Assert.rejects(
        stageInterruptedMigrationRestore(input.lock, parent),
        error => error === copyError,
        "The first native copy error reaches the restore caller"
      );
    } finally {
      copy.restore();
    }
    Assert.ok(copyError, "The real no-overwrite operation failed");
    Assert.equal(copies, 1, "Stop after the first failed copy");
    const failed = await IOUtils.getChildren(parent);
    Assert.equal(failed.length, 1, "The failed staging directory is retained");
    const staged = new FileUtils.File(failed[0]);
    staged.normalize();
    Assert.ok(staged.contains(new FileUtils.File(copied.destination)));
    Assert.deepEqual(
      await IOUtils.read(copied.destination),
      await IOUtils.read(copied.source),
      "The completed copy is retained after failure"
    );
    for (const [path, bytes] of originals) {
      Assert.deepEqual(await IOUtils.read(path), bytes);
    }
    Assert.ok(input.lock.directory.equals(input.profile.rootDir));

    const result = await stageInterruptedMigrationRestore(input.lock, parent);
    Assert.equal(result.profile.state, "restore-required");
    Assert.notEqual(result.path, staged.path, "Retry uses fresh staging");
    Assert.equal((await IOUtils.getChildren(parent)).length, 2);
    Assert.equal(result.roots.length, 1);
    Assert.equal(result.roots[0].original, result.journal.profilePath);
    for (const [leaf, original] of [
      ["Inbox.msf", input.source],
      ["Inbox", input.body],
    ]) {
      Assert.deepEqual(
        await IOUtils.read(PathUtils.join(result.roots[0].staged, leaf)),
        originals.get(original)
      );
    }
    Assert.deepEqual(await IOUtils.readJSON(input.marker), {
      ...JSON.parse(new TextDecoder().decode(originals.get(input.marker))),
      state: "restore-required",
    });
    for (const [path, bytes] of originals) {
      if (path != input.marker) {
        Assert.deepEqual(await IOUtils.read(path), bytes);
      }
    }
    Assert.deepEqual(
      await IOUtils.read(copied.destination),
      await IOUtils.read(copied.source)
    );
    Assert.ok(input.lock.directory.equals(input.profile.rootDir));
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_restoreCallerPropagatesInvalidBackupWithoutPublishing() {
    const input = await recoveryInput();
    const marker = await IOUtils.read(input.marker);
    const journal = await IOUtils.read(input.journalPath);
    const original = await IOUtils.read(input.source);
    await IOUtils.writeUTF8(
      PathUtils.join(input.backupPath, "root-0", "Inbox.msf"),
      "damaged backup"
    );
    const parent = PathUtils.join(input.root, "restore-staging");
    await IOUtils.makeDirectory(parent);
    await Assert.rejects(
      stageInterruptedMigrationRestore(input.lock, parent),
      /differs from its source/
    );
    Assert.deepEqual(await IOUtils.getChildren(parent), []);
    Assert.deepEqual(await IOUtils.read(input.marker), marker);
    Assert.deepEqual(await IOUtils.read(input.journalPath), journal);
    Assert.deepEqual(await IOUtils.read(input.source), original);
  }
);

add_task(async function test_restoreCallerRequiresActualHeldLock() {
  await Assert.rejects(
    stageInterruptedMigrationRestore(null, PathUtils.tempDir),
    error =>
      error.name == "TypeError" &&
      error.message == "Expected a held profile lock"
  );
});

add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function test_restoreCallerKeepsWindowsAdmissionRefusal() {
    const input = await lockedProfile();
    const directory = input.lock.directory.path;
    const markerPath = PathUtils.join(directory, "panorama-profile.json");
    const journalPath = PathUtils.join(input.root, "journal.json");
    // Native admission must refuse before even parsing recovery metadata.
    await IOUtils.writeUTF8(markerPath, "unparsed selector sentinel");
    await IOUtils.writeUTF8(journalPath, "unparsed journal sentinel");
    const marker = await IOUtils.read(markerPath);
    const journal = await IOUtils.read(journalPath);
    const children = (await IOUtils.getChildren(directory)).sort();
    const parent = PathUtils.join(input.root, "restore-staging");
    await IOUtils.makeDirectory(parent);
    await Assert.rejects(
      stageInterruptedMigrationRestore(input.lock, parent),
      /requires native reparse admission/
    );
    Assert.deepEqual(await IOUtils.getChildren(parent), []);
    Assert.deepEqual((await IOUtils.getChildren(directory)).sort(), children);
    Assert.deepEqual(await IOUtils.read(markerPath), marker);
    Assert.deepEqual(await IOUtils.read(journalPath), journal);
  }
);

/**
 * Copies genuine legacy files into an otherwise idle locked profile and store.
 *
 * @returns {Promise<object>} Held profile, selected roots and original bytes.
 */
async function backupBoundaryInput() {
  const input = await lockedProfile();
  const mail = PathUtils.join(input.root, "external-mail");
  await IOUtils.makeDirectory(mail);
  const originals = new Map();
  // createProfile writes this native metadata file before backup inventory.
  const created = new FileUtils.File(
    PathUtils.join(input.lock.directory.path, "times.json")
  );
  created.normalize();
  originals.set(created.path, await IOUtils.read(created.path));
  for (const root of [input.lock.directory.path, mail]) {
    await IOUtils.makeDirectory(PathUtils.join(root, "empty"));
    for (const [fixture, leaf] of [
      ["data/migration.msf", "Inbox.msf"],
      ["data/migration", "Inbox"],
    ]) {
      const path = PathUtils.join(root, leaf);
      await IOUtils.copy(do_get_file(fixture).path, path);
      const canonical = new FileUtils.File(path);
      canonical.normalize();
      originals.set(canonical.path, await IOUtils.read(path));
    }
  }
  // Use a real harmless ancestor alias for the not-yet-created backup leaf.
  const alias = input.root + "-alias";
  const ln = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
  ln.init(new FileUtils.File("/bin/ln"));
  ln.run(true, ["-s", input.root, alias], 3);
  Assert.equal(ln.exitValue, 0);
  registerCleanupFunction(() => IOUtils.remove(alias));
  return {
    ...input,
    profilePath: input.lock.directory.path,
    mailPaths: [mail],
    backupPath: PathUtils.join(alias, "backup"),
    originals,
  };
}

/**
 * Kills the actual backup child after a completed file move or manifest flush.
 * Reads the persisted manifest independently while the parent retains its lock.
 *
 * @param {object} input - Locked fresh profile and external-store input.
 * @param {boolean} complete - Wait for the complete manifest instead of first move.
 * @returns {Promise<object>} Persisted manifest and first installed file metadata.
 */
async function killBackupAfterWrite(input, complete) {
  const { Subprocess } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs"
  );
  const { TestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/TestUtils.sys.mjs"
  );
  const child = await Subprocess.call({
    command: Services.dirsvc.get("XREExeF", Ci.nsIFile).path,
    arguments: [
      "-g",
      Services.dirsvc.get("GreD", Ci.nsIFile).path,
      "-a",
      Services.dirsvc.get("XCurProcD", Ci.nsIFile).path,
      "-e",
      `const migrationBackupChildInput = ${JSON.stringify({
        profilePath: input.profilePath,
        mailPaths: input.mailPaths,
        backupPath: input.backupPath,
        complete,
      })};`,
      "-f",
      do_get_file("data/migration-backup-child.js").path,
    ],
    stderr: "stdout",
  });
  let output = "";
  let paused;
  let readError;
  const reader = (async () => {
    try {
      for (let chunk; (chunk = await child.stdout.readString()); ) {
        output += chunk;
        const lines = output.split("\n");
        lines.pop();
        const line = lines.find(value => value.startsWith("BACKUP-PAUSED "));
        if (line) {
          paused = JSON.parse(line.slice("BACKUP-PAUSED ".length));
          return;
        }
      }
      await child.wait();
      throw new Error("Child exited before the backup boundary: " + output);
    } catch (error) {
      readError = error;
    }
  })();
  try {
    await TestUtils.waitForCondition(
      () => paused || readError,
      "Waiting for the real backup write before forced termination",
      100,
      300
    );
    if (readError) {
      throw readError;
    }
    Assert.equal(child.exitCode, null, "The actual backup operation is paused");
    const backup = new FileUtils.File(input.backupPath);
    backup.normalize();
    const manifestPath = PathUtils.join(backup.path, "manifest.json");
    const manifest = await IOUtils.readJSON(manifestPath);
    Assert.equal(manifest.complete, complete);
    Assert.equal(manifest.roots.length, 2);
    const root = manifest.roots[0];
    const entry = root.entries.find(item => item.type == "regular");
    const firstPath = PathUtils.join(
      backup.path,
      root.directory,
      ...entry.parts
    );
    Assert.equal(paused.path, complete ? manifestPath : firstPath);
    const bytes = await IOUtils.read(firstPath);
    Assert.deepEqual(
      bytes,
      await IOUtils.read(PathUtils.join(root.source, ...entry.parts))
    );
    const info = await IOUtils.stat(firstPath);
    Assert.ok(input.lock.directory.equals(input.profile.rootDir));
    const { exitCode } = await child.kill(0);
    Assert.equal(exitCode, -9, "Real SIGKILL at the persisted backup boundary");
    return { manifest, manifestPath, firstPath, bytes, info };
  } finally {
    await child.kill(0);
    await reader;
  }
}

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_killedIncompleteBackupResumesWithoutReplacingCopiedFile() {
    const input = await backupBoundaryInput();
    const saved = await killBackupAfterWrite(input, false);
    await Assert.rejects(
      verifyMigrationBackup(input.backupPath),
      /Migration backup is incomplete or unsupported/
    );
    const { sinon } = ChromeUtils.importESModule(
      "resource://testing-common/Sinon.sys.mjs"
    );
    const backupIO = Cu.getGlobalForObject(createMigrationBackup).IOUtils;
    const move = sinon.spy(backupIO, "move");
    let receipt;
    try {
      receipt = await createMigrationBackup(
        input.profilePath,
        input.mailPaths,
        input.backupPath
      );
      const remaining = saved.manifest.roots.flatMap(root =>
        root.entries
          .filter(entry => entry.type == "regular")
          .map(entry =>
            PathUtils.join(
              PathUtils.parent(saved.manifestPath),
              root.directory,
              ...entry.parts
            )
          )
          .filter(path => path != saved.firstPath)
      );
      Assert.deepEqual(
        move
          .getCalls()
          .map(call => call.args[1])
          .sort(),
        remaining.sort(),
        "Retry moves every remaining file, never the completed first copy"
      );
    } finally {
      move.restore();
    }
    Assert.deepEqual(await verifyMigrationBackup(input.backupPath), receipt);
    const manifest = await IOUtils.readJSON(saved.manifestPath);
    Assert.equal(manifest.complete, true);
    Assert.deepEqual(manifest.roots, saved.manifest.roots);
    Assert.deepEqual(await IOUtils.read(saved.firstPath), saved.bytes);
    Assert.equal(
      (await IOUtils.stat(saved.firstPath)).lastModified,
      saved.info.lastModified,
      "Retry verifies the installed file without replacing it"
    );
    for (const [path, bytes] of input.originals) {
      Assert.deepEqual(await IOUtils.read(path), bytes);
    }
    Assert.ok(input.lock.directory.equals(input.profile.rootDir));
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_killedCompleteBackupReopensAndRestoresBothRoots() {
    const input = await backupBoundaryInput();
    const saved = await killBackupAfterWrite(input, true);
    const manifestBytes = await IOUtils.read(saved.manifestPath);
    const receipt = await verifyMigrationBackup(input.backupPath);
    Assert.deepEqual(
      await createMigrationBackup(
        input.profilePath,
        input.mailPaths,
        input.backupPath
      ),
      receipt,
      "A complete backup is verified, not replaced after restart"
    );
    const parent = PathUtils.join(input.root, "restore-staging");
    await IOUtils.makeDirectory(parent);
    const restored = await stageMigrationRestore(input.backupPath, parent);
    Assert.equal(restored.roots.length, 2);
    for (const root of restored.roots) {
      for (const [original, bytes] of input.originals) {
        if (PathUtils.parent(original) == root.original) {
          Assert.deepEqual(
            await IOUtils.read(
              PathUtils.join(root.staged, PathUtils.filename(original))
            ),
            bytes
          );
        }
      }
      Assert.equal(
        (await IOUtils.stat(PathUtils.join(root.staged, "empty"))).type,
        "directory"
      );
      Assert.notEqual(root.staged, root.original);
    }
    Assert.deepEqual(await IOUtils.read(saved.manifestPath), manifestBytes);
    for (const [path, bytes] of input.originals) {
      Assert.deepEqual(await IOUtils.read(path), bytes);
    }
    Assert.ok(input.lock.directory.equals(input.profile.rootDir));
    Assert.ok(
      !(await IOUtils.exists(
        PathUtils.join(input.profilePath, "panorama-profile.json")
      )),
      "Backup and fresh restore staging do not publish a migration selector"
    );
  }
);

const {
  inspectMigrationRestorePlan,
  requestMigrationRestore,
  requestMigrationRestoreRecovery,
  migrationRestoreRequestPath,
} = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationRecovery.sys.mjs"
);

/**
 * Creates a real locked profile and independent external roots for request tests.
 *
 * @returns {Promise<object>} Exact root paths, retained bytes and verified archive.
 */
async function restoreRequestInput() {
  const input = await lockedProfile(true);
  const profilePath = input.lock.directory.path;
  const external = PathUtils.join(input.root, "external");
  await IOUtils.makeDirectory(external);
  const original = PathUtils.join(profilePath, "original");
  const mail = PathUtils.join(external, "Inbox");
  await IOUtils.writeUTF8(original, "archived profile bytes");
  await IOUtils.writeUTF8(mail, "archived external mail bytes");
  const backupPath = PathUtils.join(input.root, "archive");
  const backup = await createMigrationBackup(
    profilePath,
    [external],
    backupPath
  );
  await IOUtils.writeUTF8(original, "newer profile bytes");
  await IOUtils.writeUTF8(mail, "newer mail bytes");
  const roots = [profilePath, external];
  return {
    ...input,
    profilePath,
    external,
    original,
    mail,
    backupPath,
    backup,
    roots,
    manifest: await IOUtils.read(backup.path),
    request: (approval = roots) =>
      requestMigrationRestore(profilePath, profilePath, backupPath, approval),
    recover: action =>
      requestMigrationRestoreRecovery(profilePath, profilePath, action),
  };
}

add_task(async function test_approvedRestoreWritesOnlyRequest() {
  const input = await restoreRequestInput();
  const request = await input.request();
  Assert.equal(request.mode, "restore");
  Assert.deepEqual(
    request.approvedRoots.map(root => root.original),
    input.roots
  );
  Assert.deepEqual(request.backup, input.backup);
  Assert.ok(!request.progress, "A request is not completion");
  if (AppConstants.platform != "win") {
    Assert.equal(
      (await IOUtils.stat(request.stagingParent)).permissions,
      0o700,
      "Native restore admits only an owner-only staging parent"
    );
  }
  Assert.deepEqual(
    await IOUtils.readJSON(migrationRestoreRequestPath(input.profilePath)),
    request
  );
  Assert.equal(await IOUtils.readUTF8(input.original), "newer profile bytes");
  Assert.equal(await IOUtils.readUTF8(input.mail), "newer mail bytes");
  Assert.deepEqual(await IOUtils.read(input.backup.path), input.manifest);
  Assert.ok(input.lock.directory.equals(input.profile.rootDir));
});

add_task(async function test_restoreRejectsIncompleteOrForeignRootApproval() {
  const input = await restoreRequestInput();
  for (const approval of [
    [],
    [input.profilePath],
    [...input.roots, input.root],
    [input.external, input.external],
  ]) {
    await Assert.rejects(
      input.request(approval),
      /Approve every original restore root/
    );
    Assert.ok(
      !(await IOUtils.exists(migrationRestoreRequestPath(input.profilePath)))
    );
    Assert.equal(await IOUtils.readUTF8(input.mail), "newer mail bytes");
  }
});

add_task(async function test_restoreRequestNeverReplacesAnOlderTransaction() {
  const input = await restoreRequestInput();
  await input.request();
  const path = migrationRestoreRequestPath(input.profilePath);
  const before = await IOUtils.read(path);
  await Assert.rejects(input.request(), /./);
  Assert.deepEqual(await IOUtils.read(path), before);
  Assert.equal(await IOUtils.readUTF8(input.original), "newer profile bytes");
});

add_task(async function test_restoreRejectsAnotherProfileAndChangedArchive() {
  const input = await restoreRequestInput();
  const other = await lockedProfile(true);
  await Assert.rejects(
    inspectMigrationRestorePlan(
      other.lock.directory.path,
      other.lock.directory.path,
      input.backupPath
    ),
    /another profile/
  );
  const manifest = await IOUtils.readJSON(input.backup.path);
  const root = manifest.roots[1];
  await IOUtils.writeUTF8(
    PathUtils.join(input.backupPath, root.directory, "Inbox"),
    "changed archive"
  );
  await Assert.rejects(input.request(), /differs/);
  Assert.ok(
    !(await IOUtils.exists(migrationRestoreRequestPath(input.profilePath)))
  );
  Assert.equal(await IOUtils.readUTF8(input.mail), "newer mail bytes");
});

add_task(async function test_restoreRecoveryChangesOnlyTheRequestedAction() {
  const input = await restoreRequestInput();
  const request = await input.request();
  await Assert.rejects(
    input.recover("ready"),
    /Invalid restore recovery action/
  );
  await Assert.rejects(
    requestMigrationRestoreRecovery(input.profilePath, input.root, "retry"),
    /another operation/
  );
  for (const action of ["retry", "rollback"]) {
    const changed = await input.recover(action);
    Assert.deepEqual(changed, {
      ...request,
      action: action === "retry" ? "restore" : action,
    });
    Assert.equal(await IOUtils.readUTF8(input.original), "newer profile bytes");
    Assert.equal(await IOUtils.readUTF8(input.mail), "newer mail bytes");
  }
  Assert.deepEqual(await IOUtils.read(input.backup.path), input.manifest);
});

add_task(async function test_unmutatedRetryPreparesFreshAndKeepsLedger() {
  const input = await restoreRequestInput();
  const request = await input.request();
  const path = migrationRestoreRequestPath(input.profilePath);
  const failed = {
    ...request,
    progress: { generation: 2, firstError: 1, roots: [{ phase: 0 }] },
  };
  await IOUtils.writeJSON(path, failed);
  const bytes = await IOUtils.readUTF8(path);
  const fresh = await input.recover("retry");
  Assert.deepEqual(fresh, { ...request, stagingParent: fresh.stagingParent });
  Assert.notEqual(fresh.stagingParent, request.stagingParent);
  Assert.ok(await IOUtils.exists(request.stagingParent), "Keep failed staging");
  const ledger = PathUtils.join(
    PathUtils.parent(path),
    `restore-${request.operationId}-${PathUtils.filename(request.stagingParent)}.failed.json`
  );
  Assert.equal(await IOUtils.readUTF8(ledger), bytes, "Exact failed ledger");
  await IOUtils.writeJSON(path, { ...fresh, progress: failed.progress });
  const again = await input.recover("retry");
  Assert.notEqual(again.stagingParent, fresh.stagingParent, "Second retry");
  await IOUtils.writeJSON(path, { ...again, progress: failed.progress });
  await input.recover("rollback");
  Assert.ok(!(await IOUtils.exists(path)), "Unchanged rollback ends");
  failed.progress.roots = [{ phase: 1 }];
  await IOUtils.writeJSON(path, failed);
  Assert.deepEqual(await input.recover("retry"), failed, "Mutated roots stay");
});

add_task(async function test_changedArchiveCannotAuthorizeRestoreRetry() {
  const input = await restoreRequestInput();
  await input.request();
  const path = migrationRestoreRequestPath(input.profilePath);
  const before = await IOUtils.read(path);
  await IOUtils.writeUTF8(input.backup.path, "corrupt manifest");
  await Assert.rejects(input.recover("retry"), /./);
  Assert.deepEqual(await IOUtils.read(path), before);
  const rollback = await input.recover("rollback");
  Assert.deepEqual(rollback, {
    ...JSON.parse(new TextDecoder().decode(before)),
    action: "rollback",
  });
  Assert.equal(await IOUtils.readUTF8(input.mail), "newer mail bytes");
  Assert.ok(!(await IOUtils.exists(path)), "Startup is no longer blocked");
  const ledger = `restore-${rollback.operationId}-${PathUtils.filename(rollback.stagingParent)}.failed.json`;
  Assert.deepEqual(
    await IOUtils.read(PathUtils.join(PathUtils.parent(path), ledger)),
    before
  );
});

add_task(async function test_settledAuditRecoveryPreservesItsGeneration() {
  const input = await restoreRequestInput();
  const request = await input.request();
  const path = migrationRestoreRequestPath(input.profilePath);
  const directory = PathUtils.parent(path);
  const completed = {
    ...request,
    nativeSettlement: 1,
    progress: { generation: 1, outcome: "restored" },
  };
  const bytes = JSON.stringify(completed);
  const current = PathUtils.join(directory, "restore-current.json");
  const audit = PathUtils.join(
    directory,
    `restore-${request.operationId}-1.complete.json`
  );
  await IOUtils.writeUTF8(current, bytes);
  await IOUtils.writeUTF8(audit, bytes);
  await IOUtils.remove(path);
  await IOUtils.writeJSON(current, {
    ...completed,
    progress: { outcome: "restored" },
  });
  await Assert.rejects(input.recover("rollback"), /settled native generation/);
  Assert.ok(!(await IOUtils.exists(path)));
  await IOUtils.writeUTF8(current, bytes);
  await IOUtils.remove(input.backupPath, { recursive: true });
  await Assert.rejects(input.recover("retry"), /./);
  Assert.ok(!(await IOUtils.exists(path)));
  Assert.deepEqual(await input.recover("rollback"), {
    ...completed,
    action: "rollback",
  });
  Assert.equal(await IOUtils.readUTF8(current), bytes);
  Assert.equal(await IOUtils.readUTF8(audit), bytes);
  await IOUtils.remove(path);
  await IOUtils.writeUTF8(path + ".tmp", "retained partial request");
  await Assert.rejects(input.recover("rollback"), /retained partial/);
  Assert.equal(
    await IOUtils.readUTF8(path + ".tmp"),
    "retained partial request"
  );
  await IOUtils.writeUTF8(audit, bytes + " ");
  await Assert.rejects(input.recover("rollback"), /immutable audit/);
  Assert.ok(!(await IOUtils.exists(path)));
  completed.progress.outcome = "rolled-back";
  const rolledBack = JSON.stringify(completed);
  await IOUtils.writeUTF8(current, rolledBack);
  await IOUtils.writeUTF8(audit, rolledBack);
  await Assert.rejects(input.recover("retry"), /rolled-back generation/);
  await Assert.rejects(input.recover("rollback"), /rolled-back generation/);
  Assert.ok(!(await IOUtils.exists(path)));
  Assert.equal(await IOUtils.readUTF8(input.original), "newer profile bytes");
  Assert.equal(await IOUtils.readUTF8(input.mail), "newer mail bytes");
});
