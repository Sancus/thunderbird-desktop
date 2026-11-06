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
  createMigrationBackupAtStartup,
  verifyMigrationBackup,
  stageMigrationRestore,
} = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationBackup.sys.mjs"
);

do_get_profile();

/**
 * Creates real profile and external-store files outside the running profile.
 *
 * @param {number} [bodySize=257] - Real binary message fixture size.
 * @returns {Promise<object>} Disposable source and destination paths.
 */
async function startupCopyFixture(bodySize = 257) {
  const root = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "startup-copy-"
  );
  registerCleanupFunction(() => IOUtils.remove(root, { recursive: true }));
  const profile = PathUtils.join(root, "profile");
  const external = PathUtils.join(root, "external");
  await IOUtils.makeDirectory(profile);
  await IOUtils.makeDirectory(external);
  await IOUtils.makeDirectory(PathUtils.join(profile, "empty"));
  await IOUtils.makeDirectory(PathUtils.join(external, "Inbox"));
  await IOUtils.makeDirectory(PathUtils.join(external, "Inbox", "cur"));
  await IOUtils.writeUTF8(
    PathUtils.join(profile, "prefs.js"),
    "original preferences"
  );
  await IOUtils.writeUTF8(
    PathUtils.join(profile, "parent.lock"),
    "profile lock"
  );
  await IOUtils.write(PathUtils.join(profile, "zero-length"), new Uint8Array());
  await IOUtils.writeUTF8(
    PathUtils.join(profile, "Inbox"),
    "original mbox bytes\n"
  );
  const body = PathUtils.join(external, "Inbox", "cur", "message");
  const bytes = new Uint8Array(bodySize);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = index % 251;
  }
  await IOUtils.write(body, bytes);
  const backup = PathUtils.join(root, "backup");
  return { root, profile, external, body, backup };
}

add_task(async function test_realBytesMatchExistingVerifierAndRestore() {
  const { root, profile, external, body, backup } = await startupCopyFixture(
    1024 * 1024 + 37
  );
  const originalHash = await IOUtils.computeHexDigest(body, "sha256");
  const result = createMigrationBackupAtStartup(profile, [external], backup);
  Assert.ok(!result.then, "The startup copy completes without an event loop");
  Assert.deepEqual(await verifyMigrationBackup(backup), result);
  const manifest = await IOUtils.readJSON(result.path);
  Assert.equal(manifest.complete, true);
  Assert.equal(manifest.roots.length, 2);
  Assert.deepEqual(manifest.roots[0].excluded, ["parent.lock"]);
  Assert.ok(
    manifest.roots[0].entries.some(
      entry => entry.type == "directory" && entry.parts.join("/") == "empty"
    )
  );
  Assert.equal(await IOUtils.computeHexDigest(body, "sha256"), originalHash);
  const copy = PathUtils.join(backup, "root-1", "Inbox", "cur", "message");
  Assert.equal(await IOUtils.computeHexDigest(copy, "sha256"), originalHash);
  const restored = await stageMigrationRestore(backup, root);
  Assert.equal(restored.roots.length, 2);
  Assert.equal(
    await IOUtils.computeHexDigest(
      PathUtils.join(restored.roots[1].staged, "Inbox", "cur", "message"),
      "sha256"
    ),
    originalHash
  );
});

add_task(async function test_unchangedRepeatVerifiesAndChangedSourceRefuses() {
  const { profile, external, body, backup } = await startupCopyFixture();
  const result = createMigrationBackupAtStartup(profile, [external], backup);
  Assert.deepEqual(
    createMigrationBackupAtStartup(profile, [external], backup),
    result
  );
  const manifestBytes = await IOUtils.read(result.path);
  await IOUtils.writeUTF8(body, "a changed source");
  Assert.throws(
    () => createMigrationBackupAtStartup(profile, [external], backup),
    /source identity changed/
  );
  Assert.deepEqual(
    await IOUtils.read(result.path),
    manifestBytes,
    "Changed-source rejection preserves the previous manifest"
  );
});

add_task(async function test_corruptCompleteCopyIsNeverRepairedSilently() {
  const { profile, external, backup } = await startupCopyFixture();
  const result = createMigrationBackupAtStartup(profile, [external], backup);
  await IOUtils.writeUTF8(PathUtils.join(backup, "root-0", "Inbox"), "corrupt");
  Assert.throws(
    () => createMigrationBackupAtStartup(profile, [external], backup),
    /differs from its source/
  );
  const manifestBytes = await IOUtils.read(result.path);
  await IOUtils.remove(PathUtils.join(backup, "root-0", "Inbox"));
  Assert.throws(
    () => createMigrationBackupAtStartup(profile, [external], backup),
    /complete backup is missing/
  );
  Assert.deepEqual(await IOUtils.read(result.path), manifestBytes);
});

add_task(async function test_cancelBeforeCopyDoesNotCreateArchive() {
  const { profile, external, backup } = await startupCopyFixture();
  const controller = new AbortController();
  controller.abort();
  Assert.throws(
    () =>
      createMigrationBackupAtStartup(
        profile,
        [external],
        backup,
        controller.signal
      ),
    /cancel/i
  );
  Assert.ok(!(await IOUtils.exists(backup)));
  createMigrationBackupAtStartup(profile, [external], backup);
  await verifyMigrationBackup(backup);
});

add_task(async function test_overlapAndMissingRootsFailWithoutCompletion() {
  const { root, profile, external, backup } = await startupCopyFixture();
  Assert.throws(
    () =>
      createMigrationBackupAtStartup(
        profile,
        [external],
        PathUtils.join(profile, "unsafe")
      ),
    /outside migration source/
  );
  Assert.throws(
    () => createMigrationBackupAtStartup(profile, [root], backup),
    /contains the profile/
  );
  Assert.throws(
    () =>
      createMigrationBackupAtStartup(
        profile,
        [PathUtils.join(root, "missing")],
        backup
      ),
    /NS_ERROR_FILE_NOT_FOUND/
  );
  Assert.ok(!(await IOUtils.exists(backup)));
});

add_task(async function test_nestedAndRepeatedStoresHaveOnePhysicalCopy() {
  const { profile, external, backup } = await startupCopyFixture();
  const result = createMigrationBackupAtStartup(
    profile,
    [external, PathUtils.join(external, "Inbox"), external],
    backup
  );
  const manifest = await IOUtils.readJSON(result.path);
  Assert.equal(manifest.roots.length, 2);
  await verifyMigrationBackup(backup);
});

add_task(async function test_incompleteUnchangedArchiveResumesExactCopies() {
  const { profile, external, backup } = await startupCopyFixture();
  const result = createMigrationBackupAtStartup(profile, [external], backup);
  const manifest = await IOUtils.readJSON(result.path);
  manifest.complete = false;
  await IOUtils.writeJSON(result.path, manifest);
  await IOUtils.remove(
    PathUtils.join(backup, "root-1", "Inbox", "cur", "message")
  );
  const resumed = createMigrationBackupAtStartup(profile, [external], backup);
  Assert.deepEqual(await verifyMigrationBackup(backup), resumed);
  Assert.equal((await IOUtils.readJSON(result.path)).complete, true);
});

add_task(async function test_copyTypeErrorRetainsIncompleteManifest() {
  const { profile, external, backup } = await startupCopyFixture();
  const result = createMigrationBackupAtStartup(profile, [external], backup);
  const manifest = await IOUtils.readJSON(result.path);
  manifest.complete = false;
  await IOUtils.writeJSON(result.path, manifest);
  const copiedDirectory = PathUtils.join(backup, "root-1", "Inbox", "cur");
  await IOUtils.remove(copiedDirectory, { recursive: true });
  await IOUtils.writeUTF8(copiedDirectory, "not a directory");
  Assert.throws(
    () => createMigrationBackupAtStartup(profile, [external], backup),
    /not a directory/
  );
  Assert.equal(
    (await IOUtils.readJSON(result.path)).complete,
    false,
    "A real destination IO error cannot publish completion"
  );
  Assert.equal(await IOUtils.readUTF8(copiedDirectory), "not a directory");
});

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_realLinkCannotExpandSelectedSource() {
    const { root, profile, external, body, backup } =
      await startupCopyFixture();
    const link = PathUtils.join(profile, "linked-message");
    const process = Cc["@mozilla.org/process/util;1"].createInstance(
      Ci.nsIProcess
    );
    process.init(new FileUtils.File("/bin/ln"));
    const args = ["-s", body, link];
    process.run(true, args, args.length);
    Assert.equal(
      process.exitValue,
      0,
      "Use the existing Unix link fixture route"
    );
    Assert.ok(new FileUtils.File(link).isSymlink());
    Assert.throws(
      () => createMigrationBackupAtStartup(profile, [external], backup),
      /contains a link/
    );
    Assert.ok(!(await IOUtils.exists(backup)));
    Assert.ok(await IOUtils.exists(root));
  }
);
