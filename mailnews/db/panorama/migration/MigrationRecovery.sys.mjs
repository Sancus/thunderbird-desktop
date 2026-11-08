/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { FileUtils } from "resource://gre/modules/FileUtils.sys.mjs";
import { verifyMigrationBackup } from "resource:///modules/panorama/MigrationBackup.sys.mjs";
import {
  admitWindowsMigrationPath,
  migrationPhysicalIdentity,
} from "resource:///modules/panorama/MigrationSource.sys.mjs";
import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { MigrationJournal } from "resource:///modules/panorama/MigrationJournal.sys.mjs";
import {
  getMigrationProfileState,
  getMigrationRestoreDependencies,
  stageMigrationProfileRestore,
} from "resource:///modules/panorama/MigrationProfile.sys.mjs";

/**
 * Reads an interrupted profile selector and checks its journal/backup identity.
 * Requires the caller's held profile lock and quiesced profile/external writers.
 * Never advances a stage, resumes an import, restores files or authorizes startup.
 * Native receipt validation, replacement-service readiness and the same-major
 * downgrade guard remain required before activation. Windows path admission is
 * unsupported until native reparse-point checks are available.
 *
 * @param {nsIProfileLock} profileLock - Held lock retained by the caller until return.
 *   This function neither acquires nor releases the lock.
 * @returns {Promise<{profile: object, journal: object}>} Owned selector and journal
 *   snapshots for prepared or restore-required recovery, including cancellation,
 *   source/database identities and committed maps. This is not a readiness flag.
 * @throws {Error} On unsupported platform, non-recovery state, inconsistent
 *   metadata, missing/corrupt backup or journal, or a released/changed lock.
 */
export async function inspectMigrationRecovery(profileLock) {
  if (typeof profileLock?.QueryInterface != "function") {
    throw new TypeError("Expected a held profile lock");
  }
  const lock = profileLock.QueryInterface(Ci.nsIProfileLock);
  if (AppConstants.platform == "win") {
    throw new Error(
      "Windows migration recovery requires native reparse admission"
    );
  }
  const directory = lock.directory.clone();
  const profile = await getMigrationProfileState(directory.path);
  if (!["prepared", "restore-required"].includes(profile.state)) {
    throw new Error("Profile has no interrupted migration selector");
  }
  const identity = profile.record.identity;
  const journal = await MigrationJournal.open(
    identity.journalPath,
    directory.path
  );
  try {
    const state = journal.state;
    if (!["activate", "complete"].includes(state.stage)) {
      throw new Error("Migration selector and journal stages conflict");
    }
    if (
      identity.profilePath !== state.profilePath ||
      identity.backup.path !== state.backup?.path ||
      identity.backup.sha256 !== state.backup?.sha256 ||
      identity.imports.length != state.sources.length
    ) {
      throw new Error("Migration selector and journal identities conflict");
    }
    const imports = new Map(
      identity.imports.map(source => [source.id, source])
    );
    for (const source of state.sources) {
      const recorded = imports.get(source.id);
      if (
        source.state != "imported" ||
        recorded?.token !== source.token ||
        recorded?.sha256 !== source.sha256 ||
        recorded?.folderId !== source.destinationFolderId
      ) {
        throw new Error("Migration selector and journal imports conflict");
      }
    }
    // Keep the caller's native lock alive across all asynchronous reads.
    if (!directory.equals(lock.directory)) {
      throw new Error("Migration profile lock directory changed");
    }
    return { profile, journal: state };
  } finally {
    journal.close();
  }
}

/**
 * Stages a verified interrupted profile's complete backup under its held lock.
 * Sets restore-required through the existing profile API, retaining live roots,
 * journal cancellation and imported mappings. Requires quiesced writers through
 * return. Does not cut over roots, resume imports or authorize startup.
 *
 * @param {nsIProfileLock} profileLock - Actual held original-profile lock.
 * @param {string} parentPath - Existing private staging parent outside all roots.
 * @returns {Promise<object>} Fresh restore path/root mappings and verified
 *   restore-required profile/journal snapshots for the external cutover owner.
 * @throws {Error} For invalid recovery/lock/backup, changed state or staging IO.
 */
export async function stageInterruptedMigrationRestore(
  profileLock,
  parentPath
) {
  const before = await inspectMigrationRecovery(profileLock);
  const restored = await stageMigrationProfileRestore(
    before.journal.profilePath,
    parentPath
  );
  const after = await inspectMigrationRecovery(profileLock);
  if (
    after.profile.state != "restore-required" ||
    JSON.stringify(after.profile.record.identity) !=
      JSON.stringify(before.profile.record.identity) ||
    JSON.stringify(after.journal) != JSON.stringify(before.journal)
  ) {
    throw new Error("Migration recovery changed while staging restore");
  }
  return { ...restored, ...after };
}

/**
 * Returns the fixed sibling request path without opening a database or a store.
 *
 * @param {string} profilePath - Exact selected profile directory.
 * @returns {string} Request path used by the native restoration-only observer.
 */
export function migrationRestoreRequestPath(profilePath) {
  const profile = restoreFile(profilePath);
  return PathUtils.join(
    profile.parent.path,
    "panorama-migration-" + profile.leafName,
    "restore.json"
  );
}

/**
 * Verifies a complete restore archive and its original destination/dependency set.
 *
 * @param {string} profilePath - Selected original profile directory.
 * @param {string} localProfilePath - Selected XRE local directory.
 * @param {string} backupPath - Complete backup directory outside all live roots.
 * @returns {Promise<object>} Verified manifest, exact root set and dependencies.
 * @throws {Error} For unsafe paths, mismatched identity or incomplete input.
 */
export async function inspectMigrationRestorePlan(
  profilePath,
  localProfilePath,
  backupPath
) {
  const profile = restoreFile(profilePath);
  const local = restoreFile(localProfilePath);
  if (!profile.isDirectory() || !local.isDirectory()) {
    throw new Error("Restore requires existing selected directories");
  }
  const archive = restoreFile(backupPath);
  const backup = await verifyMigrationBackup(archive.path);
  const manifest = await IOUtils.readJSON(backup.path);
  const sources = manifest.roots.map(root => restoreFile(root.source));
  if (sources[0].path !== profile.path) {
    throw new Error("Restore backup selects another profile");
  }
  const work = new FileUtils.File(
    PathUtils.parent(migrationRestoreRequestPath(profile.path))
  );
  for (const [index, source] of sources.entries()) {
    if (
      source.equals(archive) ||
      source.contains(archive) ||
      archive.contains(source) ||
      source.equals(work) ||
      source.contains(work) ||
      work.contains(source) ||
      sources.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          (source.equals(other) || source.contains(other))
      ) ||
      !/^root-\d+$/.test(manifest.roots[index].directory)
    ) {
      throw new Error("Restore roots, work and archive must be disjoint");
    }
    if (!source.isDirectory()) {
      throw new Error("Restore destination is not a directory");
    }
  }
  const roots = manifest.roots.map(root => ({
    source: root.source,
    archived: PathUtils.join(archive.path, root.directory),
  }));
  const { record, dependencies } = await getMigrationRestoreDependencies(
    profile.path,
    roots[0].archived,
    roots
  );
  return {
    profilePath: profile.path,
    localProfilePath: local.path,
    backup,
    approvedRoots: manifest.roots.map(root => ({ original: root.source })),
    dependencies,
    application: record?.application ?? {
      version: Services.appinfo.version,
      buildId: Services.appinfo.appBuildID,
    },
  };
}

/**
 * Writes an approved restore request for the next closed-writer native startup.
 * Consent covers EVERY original root and retention of its current child entries.
 *
 * @param {string} profilePath - Exact selected profile directory.
 * @param {string} localProfilePath - Exact selected local directory.
 * @param {string} backupPath - Complete verified backup directory.
 * @param {string[]} approvedRoots - Explicit original destinations, no subset.
 * @returns {Promise<object>} Durable request with no live root changes.
 * @throws {Error} For incomplete consent, changed inputs or an existing request.
 */
export async function requestMigrationRestore(
  profilePath,
  localProfilePath,
  backupPath,
  approvedRoots
) {
  const plan = await inspectMigrationRestorePlan(
    profilePath,
    localProfilePath,
    backupPath
  );
  const expected = plan.approvedRoots.map(root => root.original);
  if (
    !Array.isArray(approvedRoots) ||
    approvedRoots.length !== expected.length ||
    new Set(approvedRoots).size !== expected.length ||
    expected.some(path => !approvedRoots.includes(path))
  ) {
    throw new Error(
      "Approve every original restore root: " + expected.join(", ")
    );
  }
  const path = migrationRestoreRequestPath(plan.profilePath);
  if (await IOUtils.exists(path)) {
    throw new Error(
      "Keep the existing restore transaction for retry or rollback"
    );
  }
  await IOUtils.makeDirectory(PathUtils.parent(path), { permissions: 0o700 });
  restoreFile(PathUtils.parent(path));
  const request = {
    formatVersion: 1,
    mode: "restore",
    operationId: Services.uuid.generateUUID().toString().replace(/[{}-]/g, ""),
    action: "restore",
    ...plan,
    stagingParent: await IOUtils.createUniqueDirectory(
      PathUtils.parent(plan.profilePath),
      "panorama-restore-",
      0o700
    ),
  };
  await writeRestoreRequest(path, request, { mode: "create", flush: true });
  return request;
}

/**
 * Requests retry or complete rollback of the retained native transaction.
 * Rollback of an unchanged operation keeps its ledger and staging and ends it.
 * Retry re-verifies the archive; rollback relies on native retained custody.
 *
 * @param {string} profilePath - Selected original profile directory.
 * @param {string} localProfilePath - Selected original local directory.
 * @param {"retry"|"rollback"} action - Explicit recovery operation.
 * @returns {Promise<object>} Same request with only its requested action changed.
 * @throws {Error} For absent/foreign progress, unsafe retry or invalid action.
 */
export async function requestMigrationRestoreRecovery(
  profilePath,
  localProfilePath,
  action
) {
  if (!["retry", "rollback"].includes(action)) {
    throw new Error("Invalid restore recovery action");
  }
  const path = migrationRestoreRequestPath(profilePath);
  const pending = await IOUtils.exists(path);
  const source = pending
    ? path
    : PathUtils.join(PathUtils.parent(path), "restore-current.json");
  restoreFile(source);
  const before = await IOUtils.readUTF8(source);
  const request = JSON.parse(before);
  if (
    request.formatVersion !== 1 ||
    request.mode !== "restore" ||
    request.profilePath !== profilePath ||
    request.localProfilePath !== localProfilePath ||
    !/^[a-f0-9]{32}$/.test(request.operationId) ||
    !request.backup
  ) {
    throw new Error("Restore recovery selects another operation");
  }
  if (!pending) {
    const generation = request.progress?.generation;
    if (
      request.nativeSettlement !== 1 ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      generation > 0xffffffff ||
      !["restored", "rolled-back"].includes(request.progress?.outcome)
    ) {
      throw new Error("Restore recovery requires a settled native generation");
    }
    const audit = restoreFile(
      PathUtils.join(
        PathUtils.parent(path),
        `restore-${request.operationId}-${generation}.complete.json`
      )
    );
    if ((await IOUtils.readUTF8(audit.path)) !== before) {
      throw new Error("Restore current index differs from its immutable audit");
    }
  }
  if (request.progress?.outcome === "rolled-back") {
    throw new Error("A rolled-back generation is final; request a new restore");
  }
  if (action === "retry") {
    const plan = await inspectMigrationRestorePlan(
      profilePath,
      localProfilePath,
      PathUtils.parent(request.backup.path)
    );
    if (
      ["backup", "approvedRoots", "dependencies", "application"].some(
        key => JSON.stringify(plan[key]) !== JSON.stringify(request[key])
      )
    ) {
      throw new Error("Restore archive, roots or dependencies changed");
    }
  }
  // Audit equality is request preflight only; native revalidates real custody.
  if ((await IOUtils.readUTF8(source)) !== before) {
    throw new Error("Restore progress changed during recovery request");
  }
  // Native persists phase 1 before any live change; phase 0 proves none.
  const roots = request.progress?.roots;
  if (
    pending &&
    !request.progress?.outcome &&
    (request.progress ? roots?.length : action === "rollback") &&
    (roots ?? []).every(root => root.phase === 0)
  ) {
    const ledger = restoreFile(
      PathUtils.join(
        PathUtils.parent(path),
        `restore-${request.operationId}-${PathUtils.filename(request.stagingParent)}.failed.json`
      )
    ).path;
    if ((await IOUtils.readUTF8(ledger).catch(() => null)) !== before) {
      await IOUtils.writeUTF8(ledger, before, { mode: "create", flush: true });
    }
    if (action === "rollback") {
      await IOUtils.remove(path);
      return { ...request, action };
    }
    delete request.progress;
    request.stagingParent = await IOUtils.createUniqueDirectory(
      PathUtils.parent(profilePath),
      "panorama-restore-",
      0o700
    );
  }
  request.action = action === "retry" ? "restore" : action;
  await writeRestoreRequest(path, request, {
    mode: pending ? "overwrite" : "create",
    tmpPath: path + ".tmp",
    flush: true,
  });
  return request;
}

/**
 * Admits absolute restore paths through native Windows or Unix link guards.
 *
 * @param {string} path - Literal existing path or absent leaf.
 * @returns {nsIFile} Admitted canonical path with existing safe ancestors.
 * @throws {Error} For relative/aliased/linked paths or missing ancestors.
 */
function restoreFile(path) {
  if (
    typeof path !== "string" ||
    path.includes("\0") ||
    !PathUtils.isAbsolute(path)
  ) {
    throw new Error("Restore path must be absolute");
  }
  const file = new FileUtils.File(path);
  if (AppConstants.platform === "win") {
    const kind =
      file.exists() && file.isDirectory()
        ? Ci.nsIPanoramaMigrationFileSystem.KIND_DIRECTORY
        : Ci.nsIPanoramaMigrationFileSystem.KIND_FILE_OR_MISSING;
    const lease = admitWindowsMigrationPath(file, kind);
    try {
      Cc["@mozilla.org/mailnews/panorama-migration-file-system;1"]
        .getService(Ci.nsIPanoramaMigrationFileSystem)
        .validate(lease);
      return new FileUtils.File(lease.canonicalPath);
    } finally {
      lease.close();
    }
  }
  const absent = !file.exists();
  const normalized = (absent ? file.parent : file).clone();
  normalized.normalize();
  if (
    (absent
      ? PathUtils.join(normalized.path, file.leafName)
      : normalized.path) !== path
  ) {
    throw new Error("Restore path must be canonical");
  }
  for (let part = file; part; part = part.parent) {
    try {
      if (part.isSymlink()) {
        throw new Error("Restore path contains a link");
      }
    } catch (error) {
      if (error.result !== Cr.NS_ERROR_FILE_NOT_FOUND || part.path !== path) {
        throw error;
      }
    }
  }
  return file;
}

/**
 * Flushes request JSON while retaining its real Windows parent admission.
 *
 * @param {string} path - Fixed sibling request path.
 * @param {object} request - Verified request or same-operation recovery action.
 * @param {{mode?: string, tmpPath?: string, flush: boolean}} options - IO options.
 * @returns {Promise<void>} Resolves after publication and parent revalidation.
 * @throws {Error} For unsafe/changed parents or failed write/flush.
 */
async function writeRestoreRequest(path, request, options) {
  if (options.tmpPath) {
    restoreFile(options.tmpPath);
    if (await IOUtils.exists(options.tmpPath)) {
      throw new Error("Keep the retained partial restore request");
    }
  }
  const lease = admitWindowsMigrationPath(
    new FileUtils.File(PathUtils.parent(path)),
    Ci.nsIPanoramaMigrationFileSystem.KIND_DIRECTORY
  );
  try {
    if (lease) {
      migrationPhysicalIdentity(lease);
    }
    await IOUtils.writeJSON(path, request, options);
    if (lease) {
      migrationPhysicalIdentity(lease);
    }
  } finally {
    lease?.close();
  }
}
