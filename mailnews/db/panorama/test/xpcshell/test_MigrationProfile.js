/* This Source Code Form is subject to the Mozilla Public
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
const {
  activateMigrationProfile,
  getMigrationProfileState,
  stageMigrationProfileRestore,
  prepareStartupMigrationProfile,
  requireStartupProfileRecovery,
} = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationProfile.sys.mjs"
);

add_setup(function setupApplicationInfo() {
  const { updateAppInfo } = ChromeUtils.importESModule(
    "resource://testing-common/AppInfo.sys.mjs"
  );
  updateAppInfo({
    name: "XPCShell",
    version: "161.0a1",
    appBuildID: "20261028000000",
  });
});

/**
 * Creates disposable lifecycle inputs. Core receipts/validation are supplied
 * at this unit boundary; these tests do not qualify a SQL/backend import.
 *
 * @returns {Promise<object>} Original roots, backup and open validation journal.
 */
async function lifecycleProfile() {
  const root = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "migration-profile-"
  );
  registerCleanupFunction(() => IOUtils.remove(root, { recursive: true }));
  const profilePath = PathUtils.join(root, "profile");
  const mailPath = PathUtils.join(root, "external");
  await IOUtils.makeDirectory(profilePath);
  await IOUtils.makeDirectory(mailPath);
  await IOUtils.writeUTF8(
    PathUtils.join(profilePath, "prefs.js"),
    "original preferences"
  );
  const summary = PathUtils.join(mailPath, "Inbox.msf");
  const body = PathUtils.join(mailPath, "Inbox");
  await IOUtils.copy(do_get_file("data/migration.msf").path, summary);
  await IOUtils.copy(do_get_file("data/migration").path, body);
  const journalPath = PathUtils.join(root, "journal.json");
  const journal = await MigrationJournal.create(journalPath, {
    profilePath,
    mailPaths: [mailPath],
    backupPath: PathUtils.join(root, "backup"),
    sources: [
      {
        id: "physical-folder",
        path: summary,
        sha256: await IOUtils.computeHexDigest(summary, "sha256"),
        size: (await IOUtils.stat(summary)).size,
        messageKeys: [1, 3],
        destinationFolderId: 9,
      },
    ],
  });
  registerCleanupFunction(() => journal.close());
  const backup = await createMigrationBackup(
    profilePath,
    [mailPath],
    PathUtils.join(root, "backup")
  );
  await journal.recordBackup(backup);
  const token = await journal.beginImport("physical-folder");
  await journal.recordImport("physical-folder", {
    token,
    sourceSha256: journal.state.sources[0].sha256,
    sourcePhysicalIdentity: journal.state.sources[0].physicalIdentity,
    folderId: 9,
    keys: [
      [1, 401],
      [3, 700],
    ],
  });
  await journal.finishStage("import");
  return { root, profilePath, journalPath, journal, body, backup };
}

add_task(async function test_activationRequiresValidationAndRepeatsUnchanged() {
  const { profilePath, journalPath, journal } = await lifecycleProfile();
  journal.close();
  await Assert.rejects(
    activateMigrationProfile(journalPath, profilePath),
    /validation/
  );
  Assert.equal((await getMigrationProfileState(profilePath)).state, "legacy");
  const validated = await MigrationJournal.open(journalPath, profilePath);
  await validated.finishStage("validate");
  validated.close();
  const active = await activateMigrationProfile(journalPath, profilePath);
  Assert.equal(active.state, "active");
  Assert.equal(active.formatVersion, 1);
  Assert.equal(active.identity.imports[0].folderId, 9);
  Assert.equal((await getMigrationProfileState(profilePath)).state, "active");
  const path = PathUtils.join(profilePath, "panorama-profile.json");
  const written = await IOUtils.read(path);
  await activateMigrationProfile(journalPath, profilePath);
  Assert.deepEqual(
    await IOUtils.read(path),
    written,
    "Repeat does not rewrite the selector"
  );
  const complete = await MigrationJournal.open(journalPath, profilePath);
  Assert.equal(complete.state.stage, "complete");
  Assert.deepEqual(complete.state.sources[0].receipt.keys, [
    [1, 401],
    [3, 700],
  ]);
  complete.close();
});

add_task(async function test_preparedStateResumesAfterSelectorWriteFailure() {
  const { profilePath, journalPath, journal } = await lifecycleProfile();
  await journal.finishStage("validate");
  journal.close();
  const path = PathUtils.join(profilePath, "panorama-profile.json");
  await IOUtils.makeDirectory(path + ".tmp");
  await Assert.rejects(
    activateMigrationProfile(journalPath, profilePath),
    error => typeof error.code == "number",
    "The real final selector write fails on its temporary directory"
  );
  Assert.equal((await getMigrationProfileState(profilePath)).state, "prepared");
  const committed = await MigrationJournal.open(journalPath, profilePath);
  Assert.equal(committed.state.stage, "complete");
  const revision = committed.state.revision;
  committed.close();
  await IOUtils.remove(path + ".tmp", { recursive: true });
  Assert.equal(
    (await activateMigrationProfile(journalPath, profilePath)).state,
    "active"
  );
  const reopened = await MigrationJournal.open(journalPath, profilePath);
  Assert.equal(
    reopened.state.revision,
    revision,
    "Resuming publication does not repeat journal work"
  );
  reopened.close();
});

add_task(async function test_unknownFormatIsPreservedAndRefused() {
  const { profilePath, journalPath, journal } = await lifecycleProfile();
  await journal.finishStage("validate");
  journal.close();
  await activateMigrationProfile(journalPath, profilePath);
  const path = PathUtils.join(profilePath, "panorama-profile.json");
  const record = await IOUtils.readJSON(path);
  record.formatVersion = 2;
  await IOUtils.writeJSON(path, record);
  const before = await IOUtils.read(path);
  await Assert.rejects(getMigrationProfileState(profilePath), /unsupported/);
  Assert.deepEqual(await IOUtils.read(path), before);
});

add_task(async function test_applicationMajorDowngradeIsRefused() {
  const { profilePath, journalPath, journal } = await lifecycleProfile();
  await journal.finishStage("validate");
  journal.close();
  await activateMigrationProfile(journalPath, profilePath);
  const path = PathUtils.join(profilePath, "panorama-profile.json");
  const record = await IOUtils.readJSON(path);
  record.application.version =
    Number(/^\d+/.exec(Services.appinfo.version)[0]) + 1 + ".0";
  await IOUtils.writeJSON(path, record);
  const before = await IOUtils.read(path);
  await Assert.rejects(
    getMigrationProfileState(profilePath),
    /compatible application/
  );
  Assert.deepEqual(await IOUtils.read(path), before);
});

add_task(async function test_restoreStagingPreservesSubsequentWrites() {
  const { root, profilePath, journalPath, journal, body, backup } =
    await lifecycleProfile();
  await journal.finishStage("validate");
  journal.close();
  await activateMigrationProfile(journalPath, profilePath);
  await IOUtils.writeUTF8(body, "post-migration body bytes");
  await IOUtils.writeUTF8(
    PathUtils.join(profilePath, "prefs.js"),
    "new preferences"
  );
  const restored = await stageMigrationProfileRestore(profilePath, root);
  Assert.equal(
    (await getMigrationProfileState(profilePath)).state,
    "restore-required"
  );
  Assert.equal(await IOUtils.readUTF8(body), "post-migration body bytes");
  Assert.equal(
    await IOUtils.readUTF8(PathUtils.join(profilePath, "prefs.js")),
    "new preferences"
  );
  Assert.deepEqual(
    await IOUtils.read(PathUtils.join(restored.roots[1].staged, "Inbox")),
    await IOUtils.read(do_get_file("data/migration").path)
  );
  Assert.equal(
    await IOUtils.readUTF8(
      PathUtils.join(restored.roots[0].staged, "prefs.js")
    ),
    "original preferences"
  );
  Assert.equal(
    await IOUtils.computeHexDigest(backup.path, "sha256"),
    backup.sha256
  );
  await Assert.rejects(
    activateMigrationProfile(journalPath, profilePath),
    /activation state changed/
  );
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
  async function test_profileStateAllowsLinkedAncestorWithoutWriting() {
    const root = await IOUtils.createUniqueDirectory(
      PathUtils.tempDir,
      "migration-profile-alias-"
    );
    registerCleanupFunction(() => IOUtils.remove(root, { recursive: true }));
    const actual = PathUtils.join(root, "actual");
    const profile = PathUtils.join(actual, "profile");
    await IOUtils.makeDirectory(profile);
    const alias = PathUtils.join(root, "alias");
    makeMigrationPathLink(actual, alias);
    Assert.deepEqual(
      await getMigrationProfileState(PathUtils.join(alias, "profile")),
      { state: "legacy", record: null }
    );
    Assert.deepEqual(
      await IOUtils.getChildren(profile),
      [],
      "Reading legacy state creates no selector"
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_profileStateRejectsLinkedRootLeaf() {
    const root = await IOUtils.createUniqueDirectory(
      PathUtils.tempDir,
      "migration-profile-root-link-"
    );
    registerCleanupFunction(() => IOUtils.remove(root, { recursive: true }));
    const profile = PathUtils.join(root, "profile");
    await IOUtils.makeDirectory(profile);
    const alias = PathUtils.join(root, "alias");
    makeMigrationPathLink(profile, alias);
    await Assert.rejects(getMigrationProfileState(alias), /contains a link/);
    Assert.deepEqual(await IOUtils.getChildren(profile), []);
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_profileStateRejectsLinkedSelectorLeaf() {
    const root = await IOUtils.createUniqueDirectory(
      PathUtils.tempDir,
      "migration-profile-selector-link-"
    );
    registerCleanupFunction(() => IOUtils.remove(root, { recursive: true }));
    const profile = PathUtils.join(root, "profile");
    await IOUtils.makeDirectory(profile);
    const target = PathUtils.join(root, "retained.json");
    await IOUtils.writeJSON(
      target,
      { retained: "original" },
      { mode: "create" }
    );
    const before = await IOUtils.read(target);
    makeMigrationPathLink(
      target,
      PathUtils.join(profile, "panorama-profile.json")
    );
    await Assert.rejects(getMigrationProfileState(profile), /contains a link/);
    Assert.deepEqual(await IOUtils.read(target), before);
  }
);

const activatingApplication = {
  version: "161.2.0",
  buildId: "20261028123456",
};

/**
 * Uses the pinned AppInfo test factory and restores the previous application.
 *
 * @param {{version: string, buildId: string}} application - Test metadata.
 * @param {function(): Promise<unknown>} task - Operation under that application.
 * @returns {Promise<unknown>} Operation result.
 */
async function withApplication(application, task) {
  const { updateAppInfo, getAppInfo } = ChromeUtils.importESModule(
    "resource://testing-common/AppInfo.sys.mjs"
  );
  const previous = getAppInfo();
  updateAppInfo({
    name: "XPCShell",
    version: application.version,
    appBuildID: application.buildId,
  });
  try {
    return await task();
  } finally {
    updateAppInfo(previous);
  }
}

/**
 * Completes the existing selector/journal unit seam under known app metadata.
 *
 * @param {object} [application=activatingApplication] - First preparing build.
 * @returns {Promise<object>} Disposable active selector and original inputs.
 */
async function activatedProfile(application = activatingApplication) {
  return withApplication(application, async () => {
    const input = await lifecycleProfile();
    await input.journal.finishStage("validate");
    input.journal.close();
    await activateMigrationProfile(input.journalPath, input.profilePath);
    return { ...input, application: { ...application } };
  });
}

/**
 * Asserts refusal at all selector entry points without any persisted changes.
 *
 * @param {object} input - Existing selector and original inputs.
 * @param {RegExp} error - Expected compatibility/metadata refusal.
 */
async function assertProfileRefused(input, error) {
  const path = PathUtils.join(input.profilePath, "panorama-profile.json");
  const selector = await IOUtils.read(path);
  const journal = await IOUtils.read(input.journalPath);
  const body = await IOUtils.read(input.body);
  const children = (await IOUtils.getChildren(input.root)).sort();
  await Assert.rejects(getMigrationProfileState(input.profilePath), error);
  await Assert.rejects(
    activateMigrationProfile(input.journalPath, input.profilePath),
    error
  );
  await Assert.rejects(
    stageMigrationProfileRestore(input.profilePath, input.root),
    error
  );
  Assert.deepEqual(await IOUtils.read(path), selector);
  Assert.deepEqual(await IOUtils.read(input.journalPath), journal);
  Assert.deepEqual(await IOUtils.read(input.body), body);
  Assert.deepEqual((await IOUtils.getChildren(input.root)).sort(), children);
}

/**
 * Accepts a compatible reader/repeat without raising or rewriting the floor.
 *
 * @param {object} input - Existing active selector and original inputs.
 */
async function assertActiveProfileUnchanged(input) {
  const path = PathUtils.join(input.profilePath, "panorama-profile.json");
  const selector = await IOUtils.read(path);
  const journal = await IOUtils.read(input.journalPath);
  Assert.equal(
    (await getMigrationProfileState(input.profilePath)).state,
    "active"
  );
  const record = await activateMigrationProfile(
    input.journalPath,
    input.profilePath
  );
  Assert.equal(record.state, "active");
  Assert.deepEqual(record.application, input.application);
  Assert.deepEqual(await IOUtils.read(path), selector);
  Assert.deepEqual(await IOUtils.read(input.journalPath), journal);
}

add_task(async function test_sameMajorOlderMinorCannotReadOrMutateSelector() {
  const input = await activatedProfile();
  await withApplication({ version: "161.1.9", buildId: "20261029000000" }, () =>
    assertProfileRefused(input, /compatible application/)
  );
});

add_task(async function test_sameMajorOlderPatchCannotReadOrMutateSelector() {
  const input = await activatedProfile({
    version: "161.2.1",
    buildId: "20261028123456",
  });
  await withApplication({ version: "161.2.0", buildId: "20261029000000" }, () =>
    assertProfileRefused(input, /compatible application/)
  );
});

add_task(async function test_sameVersionNewerBuildPreservesSelector() {
  const input = await activatedProfile();
  await withApplication({ version: "161.2.0", buildId: "20261029000000" }, () =>
    assertActiveProfileUnchanged(input)
  );
});

add_task(async function test_identicalApplicationPreservesSelector() {
  const input = await activatedProfile();
  await withApplication(activatingApplication, () =>
    assertActiveProfileUnchanged(input)
  );
});

add_task(async function test_prereleaseDowngradeUsesFullVersion() {
  const input = await activatedProfile({
    version: "161.0b10",
    buildId: "20261028123456",
  });
  await withApplication({ version: "161.0b9", buildId: "20261029000000" }, () =>
    assertProfileRefused(input, /compatible application/)
  );
});

add_task(async function test_newerPrereleaseVersionDoesNotUseLexicalOrder() {
  const input = await activatedProfile({
    version: "161.0b9",
    buildId: "20261028123456",
  });
  await withApplication(
    { version: "161.0b10", buildId: "20261027000000" },
    () => assertActiveProfileUnchanged(input)
  );
});

add_task(async function test_sameVersionEarlierBuildCannotMutateSelector() {
  const input = await activatedProfile();
  await withApplication({ version: "161.2.0", buildId: "20261028123455" }, () =>
    assertProfileRefused(input, /compatible application/)
  );
});

add_task(async function test_unknownRecordedVersionIsRefused() {
  const input = await activatedProfile();
  const path = PathUtils.join(input.profilePath, "panorama-profile.json");
  const record = await IOUtils.readJSON(path);
  record.application.version = "161.2.0custom";
  await IOUtils.writeJSON(path, record);
  await assertProfileRefused(input, /unknown application metadata/);
});

add_task(async function test_overflowingRecordedVersionIsRefused() {
  const input = await activatedProfile();
  const path = PathUtils.join(input.profilePath, "panorama-profile.json");
  const record = await IOUtils.readJSON(path);
  record.application.version = "2147483648.0";
  await IOUtils.writeJSON(path, record);
  await assertProfileRefused(input, /unknown application metadata/);
});

add_task(async function test_invalidCalendarRecordedBuildIsRefused() {
  const input = await activatedProfile();
  const path = PathUtils.join(input.profilePath, "panorama-profile.json");
  const record = await IOUtils.readJSON(path);
  record.application.buildId = "20260230000000";
  await IOUtils.writeJSON(path, record);
  await assertProfileRefused(input, /unknown application metadata/);
});

add_task(async function test_unknownCurrentBuildIsRefused() {
  const input = await activatedProfile();
  await withApplication({ version: "162.0", buildId: "unknown" }, () =>
    assertProfileRefused(input, /unknown application metadata/)
  );
});

add_task(async function test_unknownCurrentVersionCannotPrepareSelector() {
  const input = await lifecycleProfile();
  await input.journal.finishStage("validate");
  input.journal.close();
  const before = await IOUtils.read(input.journalPath);
  const path = PathUtils.join(input.profilePath, "panorama-profile.json");
  await withApplication(
    { version: "unknown", buildId: "20261028000000" },
    async () => {
      await Assert.rejects(
        activateMigrationProfile(input.journalPath, input.profilePath),
        /unknown application metadata/
      );
    }
  );
  Assert.ok(!(await IOUtils.exists(path)));
  Assert.deepEqual(await IOUtils.read(input.journalPath), before);
});

add_task(async function test_preparedSelectorKeepsFloorAndCanResume() {
  const input = await withApplication(activatingApplication, async () => {
    const result = await lifecycleProfile();
    await result.journal.finishStage("validate");
    result.journal.close();
    const path = PathUtils.join(result.profilePath, "panorama-profile.json");
    await IOUtils.makeDirectory(path + ".tmp");
    await Assert.rejects(
      activateMigrationProfile(result.journalPath, result.profilePath),
      error => typeof error.code == "number"
    );
    await IOUtils.remove(path + ".tmp", { recursive: true });
    Assert.equal(
      (await getMigrationProfileState(result.profilePath)).state,
      "prepared"
    );
    return result;
  });
  await withApplication({ version: "161.2.0", buildId: "20261028123455" }, () =>
    assertProfileRefused(input, /compatible application/)
  );
  await withApplication(activatingApplication, async () => {
    Assert.equal(
      (await getMigrationProfileState(input.profilePath)).state,
      "prepared"
    );
    const journal = await IOUtils.read(input.journalPath);
    const active = await activateMigrationProfile(
      input.journalPath,
      input.profilePath
    );
    Assert.equal(active.state, "active");
    Assert.deepEqual(active.application, activatingApplication);
    Assert.deepEqual(await IOUtils.read(input.journalPath), journal);
  });
});

add_task(async function test_restoreRequiredKeepsFloorAndRecoveryState() {
  const input = await activatedProfile();
  await withApplication(activatingApplication, async () => {
    await stageMigrationProfileRestore(input.profilePath, input.root);
  });
  await withApplication({ version: "161.1.9", buildId: "20261029000000" }, () =>
    assertProfileRefused(input, /compatible application/)
  );
  await withApplication(activatingApplication, async () => {
    const path = PathUtils.join(input.profilePath, "panorama-profile.json");
    const selector = await IOUtils.read(path);
    const journal = await IOUtils.read(input.journalPath);
    const state = await getMigrationProfileState(input.profilePath);
    Assert.equal(state.state, "restore-required");
    Assert.deepEqual(state.record.application, activatingApplication);
    await Assert.rejects(
      activateMigrationProfile(input.journalPath, input.profilePath),
      /activation state changed/
    );
    Assert.deepEqual(await IOUtils.read(path), selector);
    Assert.deepEqual(await IOUtils.read(input.journalPath), journal);
  });
});

/**
 * Creates a selector-reader fixture, without claiming a native database import.
 *
 * @param {string} origin - Empty initialization or existing-database adoption.
 * @returns {Promise<{profilePath: string, path: string, record: object}>} Fixture.
 */
async function startupSelector(origin = "initialized-empty") {
  const profilePath = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "native-profile-selector-"
  );
  registerCleanupFunction(() =>
    IOUtils.remove(profilePath, { recursive: true })
  );
  const path = PathUtils.join(profilePath, "panorama-profile.json");
  const record = {
    formatVersion: 2,
    backend: "panorama",
    origin,
    state: "active",
    application: { ...activatingApplication },
    identity: {
      profilePath,
      databaseSourceId: "selector-reader-unit-identity",
      schemaVersion: 21,
      journalPath: null,
      backup: null,
      imports: [],
      books: [],
      caches: [],
    },
  };
  await IOUtils.writeJSON(path, record);
  return { profilePath, path, record };
}

add_task(async function test_getMigrationProfileStateWithNativeOrigins() {
  for (const origin of ["initialized-empty", "adopted-existing"]) {
    const input = await startupSelector(origin);
    const before = await IOUtils.read(input.path);
    await withApplication(activatingApplication, async () => {
      const result = await getMigrationProfileState(input.profilePath);
      Assert.equal(result.state, "active");
      Assert.equal(result.record.backend, "panorama");
      Assert.equal(result.record.origin, origin);
      Assert.strictEqual(result.record.identity.journalPath, null);
      Assert.strictEqual(result.record.identity.backup, null);
      Assert.deepEqual(result.record.application, activatingApplication);
    });
    Assert.deepEqual(
      await IOUtils.read(input.path),
      before,
      "Reading native selection does not invent or rewrite migration progress"
    );
    Assert.deepEqual((await IOUtils.getChildren(input.profilePath)).sort(), [
      input.path,
    ]);
  }
});

add_task(
  async function test_getMigrationProfileStateRefusesInvalidNativeSelection() {
    const input = await startupSelector();
    for (const change of [
      record => {
        record.backend = "mork";
      },
      record => {
        record.origin = "unknown";
      },
      record => {
        record.identity.databaseSourceId = null;
      },
      record => {
        record.identity.schemaVersion = -1;
      },
      record => {
        record.identity.journalPath = input.path;
      },
      record => {
        record.identity.backup = { path: input.path, sha256: "a".repeat(64) };
      },
      record => {
        record.identity.imports = [{ id: "fabricated" }];
      },
      record => {
        record.identity.serverSummaries = null;
      },
      record => {
        record.identity.serverSummaries = [
          { sourceId: "unbound-root", folderId: 1 },
        ];
      },
    ]) {
      const record = structuredClone(input.record);
      change(record);
      await IOUtils.writeJSON(input.path, record);
      const before = await IOUtils.read(input.path);
      await withApplication(activatingApplication, async () => {
        await Assert.rejects(
          getMigrationProfileState(input.profilePath),
          /native profile|must not invent|committed-unit/,
          "An inconsistent backend/origin/identity cannot authorize startup"
        );
      });
      Assert.deepEqual(await IOUtils.read(input.path), before);
    }
  }
);

add_task(
  async function test_getMigrationProfileStateWithNativeDowngradeFloor() {
    const input = await startupSelector();
    const before = await IOUtils.read(input.path);
    for (const application of [
      { version: "161.1.9", buildId: "20261101000000" },
      { version: "161.2.0", buildId: "20261028123455" },
    ]) {
      await withApplication(application, async () => {
        await Assert.rejects(
          getMigrationProfileState(input.profilePath),
          /compatible application/
        );
      });
      Assert.deepEqual(
        await IOUtils.read(input.path),
        before,
        "Downgrade does not write the native selection"
      );
    }
    await withApplication(
      { version: "161.3.0", buildId: "20261001000000" },
      async () => {
        const selected = await getMigrationProfileState(input.profilePath);
        Assert.deepEqual(
          selected.record.application,
          activatingApplication,
          "A newer reader preserves the first preparing minimum"
        );
      }
    );
    Assert.deepEqual(await IOUtils.read(input.path), before);
  }
);

add_task(
  { skip_if: () => AppConstants.platform === "win" },
  async function test_prepareStartupMigrationProfileRetainsActualRecoveryInputs() {
    const root = await IOUtils.createUniqueDirectory(
      PathUtils.tempDir,
      "startup-profile-"
    );
    registerCleanupFunction(() => IOUtils.remove(root, { recursive: true }));
    const profilePath = PathUtils.join(root, "profile");
    const work = PathUtils.join(root, "work");
    await IOUtils.makeDirectory(profilePath);
    await IOUtils.makeDirectory(work);
    const source = PathUtils.join(profilePath, "Inbox.msf");
    await IOUtils.copy(do_get_file("data/migration.msf").path, source);
    const backupPath = PathUtils.join(root, "backup");
    const backup = await createMigrationBackup(profilePath, [], backupPath);
    const journalPath = PathUtils.join(work, "journal.json");
    const journal = await MigrationJournal.create(journalPath, {
      profilePath,
      mailPaths: [],
      backupPath,
      sources: [],
      startupInventory: {
        sources: [
          {
            id: "original",
            serverKey: "server1",
            serverRoot: profilePath,
            protocol: "none",
            storeType: "mbox",
            storeContractID: "@mozilla.org/msgstore/berkeleystore;1",
            storePath: source.slice(0, -4),
            origin: { provider: "local-store-discovery" },
            path: source,
            sha256: await IOUtils.computeHexDigest(source, "sha256"),
            size: (await IOUtils.stat(source)).size,
          },
        ],
        caches: [],
      },
    });
    journal.close();
    const rawJournal = await IOUtils.read(journalPath);
    await withApplication(activatingApplication, async () => {
      const record = await prepareStartupMigrationProfile(
        profilePath,
        journalPath,
        backup
      );
      Assert.equal(record.state, "prepared");
      Assert.equal(record.origin, "migrated");
      Assert.strictEqual(
        record.identity.databaseSourceId,
        null,
        "No native incarnation is invented before actual target bootstrap"
      );
      Assert.equal(record.identity.journalPath, journalPath);
      Assert.deepEqual(record.identity.backup, backup);
      Assert.ok(
        !(await IOUtils.exists(PathUtils.join(profilePath, "panorama.sqlite")))
      );
      const selectorPath = PathUtils.join(profilePath, "panorama-profile.json");
      const rawSelector = await IOUtils.read(selectorPath);
      await Assert.rejects(
        prepareStartupMigrationProfile(profilePath, journalPath, backup),
        /requires recovery/
      );
      Assert.deepEqual(
        await IOUtils.read(selectorPath),
        rawSelector,
        "Repeated startup does not replace existing recovery state"
      );
      await requireStartupProfileRecovery(profilePath);
      Assert.equal(
        (await getMigrationProfileState(profilePath)).state,
        "restore-required"
      );
      Assert.deepEqual(await IOUtils.read(journalPath), rawJournal);
    });
  }
);

add_task(async function test_getMigrationProfileStateRequiresDurableRecovery() {
  // Reader-only refusal fixture. Actual migrated activation/reuse is exercised
  // by the registered ordinary Marionette startup cases.
  const input = await startupSelector("migrated");
  const journalPath = PathUtils.join(input.profilePath, "journal.json");
  const backupPath = PathUtils.join(input.profilePath, "manifest.json");
  const record = input.record;
  record.identity.journalPath = journalPath;
  record.identity.backup = { path: backupPath, sha256: "a".repeat(64) };
  await IOUtils.writeJSON(input.path, record);
  const selector = await IOUtils.read(input.path);
  await withApplication(activatingApplication, async () => {
    await Assert.rejects(
      getMigrationProfileState(input.profilePath),
      /exist|found/i,
      "Missing durable journal is recovery, never active reuse"
    );
    for (const value of [
      "{corrupt journal",
      JSON.stringify({ version: 7, stage: "import", cancelled: false }),
      JSON.stringify({ version: 7, stage: "complete", cancelled: true }),
      JSON.stringify({
        version: 7,
        stage: "complete",
        cancelled: false,
        profilePath: input.profilePath,
        startup: {
          bound: true,
          databaseSourceId: record.identity.databaseSourceId,
        },
        sources: [],
        books: [],
        caches: [],
        backup: { ...record.identity.backup, sha256: "b".repeat(64) },
      }),
    ]) {
      await IOUtils.writeUTF8(journalPath, value);
      const journal = await IOUtils.read(journalPath);
      await Assert.rejects(
        getMigrationProfileState(input.profilePath),
        /JSON|recovery|exist|found/i,
        "Corrupt, incomplete, cancelled or changed-identity progress refuses"
      );
      Assert.deepEqual(await IOUtils.read(journalPath), journal);
      Assert.deepEqual(await IOUtils.read(input.path), selector);
    }
  });
});

add_task(async function test_getMigrationProfileStateDoesNotReadArchive() {
  // Reader-only identities; ordinary startup tests cover actual native reuse.
  const input = await startupSelector("migrated");
  const journalPath = PathUtils.join(input.profilePath, "journal.json");
  const backupPath = PathUtils.join(input.profilePath, "manifest.json");
  input.record.identity.journalPath = journalPath;
  input.record.identity.backup = { path: backupPath, sha256: "a".repeat(64) };
  await IOUtils.writeJSON(input.path, input.record);
  const state = {
    version: 7,
    stage: "complete",
    cancelled: false,
    profilePath: input.profilePath,
    startup: {
      bound: true,
      databaseSourceId: input.record.identity.databaseSourceId,
    },
    sources: [],
    books: [],
    caches: [],
    backup: input.record.identity.backup,
  };
  await IOUtils.writeJSON(journalPath, state);
  const selector = await IOUtils.read(input.path);
  const journal = await IOUtils.read(journalPath);
  await withApplication(activatingApplication, async () => {
    Assert.ok(!(await IOUtils.exists(backupPath)));
    Assert.equal(
      (await getMigrationProfileState(input.profilePath)).state,
      "active"
    );
    await IOUtils.writeUTF8(
      backupPath,
      "Archive contents are not startup inputs"
    );
    const archive = await IOUtils.read(backupPath);
    Assert.equal(
      (await getMigrationProfileState(input.profilePath)).state,
      "active"
    );
    Assert.deepEqual(await IOUtils.read(backupPath), archive);
    Assert.deepEqual(await IOUtils.read(input.path), selector);
    Assert.deepEqual(await IOUtils.read(journalPath), journal);
    const changed = structuredClone(state);
    changed.backup.sha256 = "b".repeat(64);
    await IOUtils.writeJSON(journalPath, changed);
    await Assert.rejects(
      getMigrationProfileState(input.profilePath),
      /incomplete or changed/,
      "The durable backup identity remains mandatory without reading its archive"
    );
  });
});

/**
 * Runs the public coordinator with a fault at its native service boundary.
 * The real source copy, pending journal and prepared selector are persisted.
 * Restores the module globals and temporary inputs before the next case.
 *
 * @param {"refused"|"cancelled"|"partial"} failure - Native open outcome.
 * @returns {Promise<void>} Resolves after checking selector and retry behavior.
 */
async function checkStartupTargetFailure(failure) {
  const { startPanoramaProfileAtStartup } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MigrationCoordinator.sys.mjs"
  );
  const profile = do_get_profile();
  const profilePath = profile.path;
  const directory = PathUtils.join(profilePath, "startup-open-failure");
  const work = PathUtils.join(
    profile.parent.path,
    "panorama-migration-" + profile.leafName
  );
  const selector = PathUtils.join(profilePath, "panorama-profile.json");
  const databasePath = PathUtils.join(profilePath, "panorama.sqlite");
  const journalPath = PathUtils.join(work, "journal.json");
  const branch = "mail.server.startupOpenFailure.";
  const hadEnabled = Services.prefs.prefHasUserValue("mail.panorama.enabled");
  const enabled = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  Assert.ok(!(await IOUtils.exists(work)));
  Assert.ok(!(await IOUtils.exists(selector)));
  Assert.ok(!(await IOUtils.exists(databasePath)));
  await IOUtils.makeDirectory(directory);
  const summary = PathUtils.join(directory, "Inbox.msf");
  const body = PathUtils.join(directory, "Inbox");
  await IOUtils.copy(do_get_file("data/migration.msf").path, summary);
  await IOUtils.copy(do_get_file("data/migration").path, body);
  const originalSummary = await IOUtils.read(summary);
  const originalBody = await IOUtils.read(body);
  const controller = new AbortController();
  let opened = 0;
  let settled = 0;
  const operation = {};
  const fault =
    failure === "cancelled"
      ? new DOMException("Migration cancelled", "AbortError")
      : Components.Exception(
          "Native target admission refused",
          Cr.NS_ERROR_NOT_AVAILABLE
        );
  const core = {
    beginProfileStartup() {
      return Promise.resolve(operation);
    },
    validateProfileStartup(actual) {
      Assert.strictEqual(actual, operation);
      return { profilePath, mode: "migrate" };
    },
    openProfileStartupTarget(actual) {
      Assert.strictEqual(actual, operation);
      Assert.ok(
        new FileUtils.File(selector).exists(),
        "Fault follows preparation"
      );
      Assert.ok(
        new FileUtils.File(journalPath).exists(),
        "Pending journal exists"
      );
      opened++;
      if (failure === "partial") {
        // A native open can create the target and then throw before returning it.
        new FileUtils.File(databasePath).create(
          Ci.nsIFile.NORMAL_FILE_TYPE,
          0o600
        );
      } else if (failure === "cancelled") {
        controller.abort();
      }
      throw fault;
    },
    async failProfileStartup(actual) {
      Assert.strictEqual(actual, operation);
      settled++;
    },
  };
  // nsIDatabaseCore is builtin-only. Stub the module's service lookup rather
  // than registering a JavaScript implementation of that native interface.
  const moduleGlobal = Cu.getGlobalForObject(startPanoramaProfileAtStartup);
  const originalCc = moduleGlobal.Cc;
  const mockCc = {
    "@mozilla.org/mailnews/database-core;1": {
      getService(iid) {
        Assert.ok(iid.equals(Ci.nsIDatabaseCore));
        return core;
      },
    },
  };
  moduleGlobal.Cc = new Proxy(mockCc, {
    get(target, property) {
      return Reflect.has(target, property)
        ? Reflect.get(target, property)
        : Reflect.get(originalCc, property);
    },
  });
  const originalOpen = MigrationJournal.open;
  MigrationJournal.open = async function (...args) {
    const journal = await originalOpen.apply(this, args);
    if (failure === "cancelled" && new FileUtils.File(selector).exists()) {
      controller.abort();
    }
    return journal;
  };
  try {
    Services.prefs.setBoolPref("mail.panorama.enabled", true);
    Services.prefs.setComplexValue(
      branch + "directory",
      Ci.nsIFile,
      new FileUtils.File(directory)
    );
    Services.prefs.setCharPref(branch + "type", "none");
    await Assert.rejects(
      startPanoramaProfileAtStartup(controller.signal),
      error =>
        failure === "cancelled"
          ? error.name === "AbortError"
          : error.result === Cr.NS_ERROR_NOT_AVAILABLE,
      "The original native refusal or cancellation is propagated"
    );
    const expectedOpens = failure === "cancelled" ? 0 : 1;
    Assert.equal(opened, expectedOpens);
    Assert.equal(settled, 1);
    Assert.deepEqual(await IOUtils.read(summary), originalSummary);
    Assert.deepEqual(await IOUtils.read(body), originalBody);
    const journal = await IOUtils.read(journalPath);
    Assert.equal((await IOUtils.readJSON(journalPath)).stage, "backup");
    Assert.ok((await IOUtils.readJSON(journalPath)).lastError);
    if (failure === "partial") {
      Assert.ok(await IOUtils.exists(databasePath));
      Assert.equal(
        (await getMigrationProfileState(profilePath)).state,
        "restore-required",
        "A created target always requires recovery"
      );
    } else {
      Assert.ok(!(await IOUtils.exists(databasePath)));
      Assert.ok(!(await IOUtils.exists(selector)));
      Services.prefs.setBoolPref("mail.panorama.enabled", false);
      Assert.equal(
        (await getMigrationProfileState(profilePath)).state,
        "legacy",
        "Untouched original data can start through the default legacy gate"
      );
    }
    Services.prefs.setBoolPref("mail.panorama.enabled", true);
    await Assert.rejects(
      startPanoramaProfileAtStartup(),
      /requires explicit recovery/,
      "Retained migration work still forbids a silent opt-in retry"
    );
    Assert.equal(opened, expectedOpens, "A retry never opens another target");
    Assert.deepEqual(await IOUtils.read(journalPath), journal);
    Assert.deepEqual(await IOUtils.read(summary), originalSummary);
    Assert.deepEqual(await IOUtils.read(body), originalBody);
  } finally {
    // These process-wide test replacements must be restored before another case.
    MigrationJournal.open = originalOpen;
    moduleGlobal.Cc = originalCc;
    Assert.strictEqual(moduleGlobal.Cc, originalCc);
    Services.prefs.deleteBranch(branch);
    if (hadEnabled) {
      Services.prefs.setBoolPref("mail.panorama.enabled", enabled);
    } else {
      Services.prefs.clearUserPref("mail.panorama.enabled");
    }
    await IOUtils.remove(work, { recursive: true, ignoreAbsent: true });
    await IOUtils.remove(directory, { recursive: true, ignoreAbsent: true });
    await IOUtils.remove(selector, { ignoreAbsent: true });
    await IOUtils.remove(databasePath, { ignoreAbsent: true });
  }
}

add_task(
  { skip_if: () => AppConstants.platform === "win" },
  async function test_startPanoramaProfileAtStartupWithPreTargetRefusal() {
    await checkStartupTargetFailure("refused");
  }
);

add_task(
  { skip_if: () => AppConstants.platform === "win" },
  async function test_startPanoramaProfileAtStartupWithPreTargetCancellation() {
    await checkStartupTargetFailure("cancelled");
  }
);

add_task(
  { skip_if: () => AppConstants.platform === "win" },
  async function test_startPanoramaProfileAtStartupWithPartialTarget() {
    await checkStartupTargetFailure("partial");
  }
);

const { getMigrationRestoreDependencies } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationProfile.sys.mjs"
);

/**
 * Archives an actual selector with its retained unit-boundary journal/archive.
 * Does not model native receipt validation, which runs in ordinary process tests.
 *
 * @param {boolean} [nested=false] - Archive the journal inside an external root
 *   that is backed up but is not one of the journal's own source mail roots.
 * @returns {Promise<object>} Original selector and complete verified root copies.
 */
async function archivedSelectorInput(nested = false) {
  const input = await lifecycleProfile();
  await input.journal.finishStage("validate");
  input.journal.close();
  if (nested) {
    const original = input.journalPath;
    input.journalPath = PathUtils.join(
      input.root,
      "retained",
      "metadata",
      "journal.json"
    );
    await IOUtils.makeDirectory(PathUtils.parent(input.journalPath));
    await IOUtils.move(original, input.journalPath, { noOverwrite: true });
  }
  const record = await activateMigrationProfile(
    input.journalPath,
    input.profilePath
  );
  const archive = PathUtils.join(input.root, "restore-point");
  const external = [PathUtils.join(input.root, "external")];
  if (nested) {
    // Journals stay outside their source roots; this extra root only archives it.
    external.unshift(PathUtils.join(input.root, "retained"));
  }
  const backup = await createMigrationBackup(
    input.profilePath,
    external,
    archive
  );
  const manifest = await IOUtils.readJSON(backup.path);
  const roots = manifest.roots.map(root => ({
    source: root.source,
    archived: PathUtils.join(archive, root.directory),
  }));
  const archived = roots[0].archived;
  return {
    ...input,
    record,
    roots,
    archived,
    dependencies: () =>
      getMigrationRestoreDependencies(input.profilePath, archived, roots),
  };
}

add_task(
  async function test_restoreIntentBindsOriginalSelectorAndDependencies() {
    for (const nested of [false, true]) {
      const input = await archivedSelectorInput(nested);
      const before = await IOUtils.read(
        PathUtils.join(input.profilePath, "panorama-profile.json")
      );
      const result = await input.dependencies();
      Assert.deepEqual(
        result.record,
        input.record,
        "No selector receipt is reminted"
      );
      Assert.equal(result.dependencies.length, 2);
      Assert.equal(result.dependencies[0].path, input.journalPath);
      Assert.equal(
        result.dependencies[0].sourcePath,
        nested
          ? PathUtils.join(input.roots[1].archived, "metadata", "journal.json")
          : input.journalPath,
        "Read the genuine archived or retained journal"
      );
      Assert.equal(
        result.dependencies[0].sha256,
        await IOUtils.computeHexDigest(input.journalPath, "sha256")
      );
      Assert.deepEqual(result.dependencies[1], {
        kind: "archive",
        ...input.record.identity.backup,
      });
      Assert.deepEqual(
        await IOUtils.read(
          PathUtils.join(input.profilePath, "panorama-profile.json")
        ),
        before
      );
    }
  }
);

add_task(
  async function test_restoreRefusesMissingOrConflictingRetainedJournal() {
    const input = await archivedSelectorInput();
    const saved = await IOUtils.read(input.journalPath);
    const moved = input.journalPath + ".retained";
    await IOUtils.move(input.journalPath, moved, { noOverwrite: true });
    await Assert.rejects(input.dependencies(), /./);
    Assert.ok(
      !(await IOUtils.exists(input.journalPath)),
      "Missing dependency stays missing"
    );
    await IOUtils.move(moved, input.journalPath, { noOverwrite: true });
    const state = await IOUtils.readJSON(input.journalPath);
    state.sources[0].token += "-foreign";
    await IOUtils.writeJSON(input.journalPath, state);
    const corrupt = await IOUtils.read(input.journalPath);
    await Assert.rejects(input.dependencies(), /identities conflict/);
    Assert.deepEqual(await IOUtils.read(input.journalPath), corrupt);
    await IOUtils.write(input.journalPath, saved);
  }
);

add_task(
  async function test_archivedRestoreRetainsOriginalPathAndVersionGuards() {
    const input = await archivedSelectorInput();
    await Assert.rejects(
      getMigrationRestoreDependencies(input.root, input.archived, input.roots),
      /unsupported.*profile format/
    );
    const path = PathUtils.join(input.archived, "panorama-profile.json");
    const newer = await IOUtils.readJSON(path);
    newer.application.version = "999.0";
    await IOUtils.writeJSON(path, newer);
    await Assert.rejects(
      input.dependencies(),
      /compatible application version/
    );
    Assert.deepEqual(
      await IOUtils.readJSON(path),
      newer,
      "Refusal does not rewrite the archived selector to admit it"
    );
  }
);
