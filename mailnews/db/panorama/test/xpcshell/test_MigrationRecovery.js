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
const { createMigrationBackup } = ChromeUtils.importESModule(
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
 * @returns {object} Native profile/lock and private per-case work directory.
 */
async function lockedProfile() {
  const name = "migration-recovery-" + ++serial;
  const root = PathUtils.join(home, name);
  await IOUtils.makeDirectory(root);
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
