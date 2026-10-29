/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { FileUtils } from "resource://gre/modules/FileUtils.sys.mjs";

import {
  admitWindowsMigrationPath,
  hashMigrationFile,
  migrationPhysicalIdentity,
  isMigrationPhysicalIdentity,
} from "resource:///modules/panorama/MigrationSource.sys.mjs";

const BACKUP_VERSION = AppConstants.platform == "win" ? 3 : 1;
const PROFILE_LOCKS = new Set(["parent.lock", ".parentlock", "lock"]);

/**
 * Collects persisted profile/server storage paths without initializing stores.
 * Does not call localPath/getFileValue, which can create directories or prefs.
 * Relative descriptors take precedence, matching existing account behavior.
 *
 * @returns {{profilePath: string, mailPaths: string[]}} Configured source roots.
 */
export function collectMigrationRoots() {
  const branches = new Set();
  for (const name of Services.prefs.getChildList("mail.server.")) {
    const match = /^(mail\.server\..+)\.directory(?:-rel)?$/.exec(name);
    if (match && match[1] != "mail.server.default") {
      branches.add(match[1]);
    }
  }
  const mailPaths = [...branches].sort().map(branch => {
    const relative = branch + ".directory-rel";
    if (Services.prefs.getPrefType(relative) != Ci.nsIPrefBranch.PREF_INVALID) {
      return Services.prefs.getComplexValue(relative, Ci.nsIRelativeFilePref)
        .file.path;
    }
    return Services.prefs.getComplexValue(branch + ".directory", Ci.nsIFile)
      .path;
  });
  return { profilePath: PathUtils.profileDir, mailPaths };
}

/**
 * Captures every selected Windows root before canonical deduplication.
 * Requires the caller's selected-profile lock and quiesced source writers.
 *
 * @param {string[]} paths - Original profile/mail-root spellings.
 * @returns {object[]} Literal selections with native canonical/physical identity.
 */
export function captureWindowsMigrationRoots(paths) {
  const fs = Cc[
    "@mozilla.org/mailnews/panorama-migration-file-system;1"
  ].getService(Ci.nsIPanoramaMigrationFileSystem);
  return [...new Set(paths)].map(originalPath => {
    if (
      typeof originalPath != "string" ||
      originalPath.includes("\0") ||
      !PathUtils.isAbsolute(originalPath)
    ) {
      throw new Error("Invalid original migration root");
    }
    const file = new FileUtils.File(originalPath);
    const lease = fs.admit(file, file, fs.KIND_DIRECTORY);
    try {
      return {
        originalPath,
        canonicalPath: lease.canonicalPath,
        physicalIdentity: migrationPhysicalIdentity(lease),
      };
    } finally {
      lease.close();
    }
  });
}

/**
 * Copies a quiesced profile and external mail stores to a private backup.
 * Resumes an incomplete copy only when its recorded source inventory matches.
 * Never changes or removes source data. Failed scratch copies are retained.
 * Profile lock files are recorded as exclusions; other links/special files fail.
 *
 * @param {string} profilePath - Original profile directory.
 * @param {string[]} mailPaths - All configured mail-store directories.
 * @param {string} backupPath - Backup outside all source trees; parent exists.
 * @param {AbortSignal} [signal] - Stop at a file boundary, keeping incomplete copies.
 * @returns {Promise<{path: string, sha256: string}>} Verified complete manifest.
 */
export async function createMigrationBackup(
  profilePath,
  mailPaths,
  backupPath,
  signal
) {
  checkCancellation(signal);
  const originalRoots =
    AppConstants.platform == "win"
      ? captureWindowsMigrationRoots([profilePath, ...mailPaths])
      : null;
  const profile = physicalFile(profilePath);
  const backup = physicalFile(backupPath);
  if (AppConstants.platform == "win" && (await IOUtils.exists(backup.path))) {
    const existing = physicalFile(PathUtils.join(backup.path, "manifest.json"));
    if (
      (await IOUtils.stat(existing.path)).type != "regular" ||
      (await IOUtils.readJSON(existing.path)).version !== BACKUP_VERSION
    ) {
      throw new Error("Migration backup format cannot be resumed");
    }
  }
  const sources = [profile];
  for (const path of mailPaths) {
    const file = physicalFile(path);
    if (sources.some(parent => parent.equals(file) || parent.contains(file))) {
      continue;
    }
    if (file.contains(profile)) {
      throw new Error("External mail root contains the profile");
    }
    // Keep one copy when two configured servers share nested storage roots.
    for (let index = sources.length - 1; index > 0; index--) {
      if (file.contains(sources[index])) {
        sources.splice(index, 1);
      }
    }
    sources.push(file);
  }
  if (
    sources.some(source => source.equals(backup) || source.contains(backup))
  ) {
    throw new Error("Backup must be outside migration source trees");
  }
  const roots = [];
  for (const [index, source] of sources.entries()) {
    const info = await IOUtils.stat(source.path);
    if (info.type != "directory") {
      throw new Error("Migration source root is not a directory");
    }
    roots.push({
      source: source.path,
      directory: "root-" + index,
      permissions: info.permissions,
      lastModified: info.lastModified,
      ...(await inventory(source.path, index == 0, signal)),
    });
  }
  const manifestPath = PathUtils.join(backup.path, "manifest.json");
  let manifest;
  if (await IOUtils.exists(backup.path)) {
    physicalFile(manifestPath);
    if ((await IOUtils.stat(manifestPath)).type != "regular") {
      throw new Error("Migration backup manifest is not a regular file");
    }
    manifest = await IOUtils.readJSON(manifestPath);
    if (
      manifest.version != BACKUP_VERSION ||
      (originalRoots &&
        JSON.stringify(manifest.originalRoots) !=
          JSON.stringify(originalRoots)) ||
      JSON.stringify(manifest.roots) != JSON.stringify(roots)
    ) {
      throw new Error(
        "Backup source identity changed; keep the previous backup"
      );
    }
    if (manifest.complete === true) {
      return verifyMigrationBackup(backup.path);
    }
    if (manifest.complete !== false) {
      throw new Error("Invalid incomplete migration backup");
    }
  } else {
    await IOUtils.makeDirectory(backup.path, {
      createAncestors: false,
      ignoreExisting: false,
      permissions: 0o700,
    });
    manifest = {
      version: BACKUP_VERSION,
      complete: false,
      roots,
      ...(originalRoots ? { originalRoots } : {}),
    };
    await IOUtils.writeJSON(manifestPath, manifest, {
      mode: "create",
      flush: true,
    });
  }
  const scratch = PathUtils.join(backup.path, "scratch");
  await IOUtils.makeDirectory(scratch, { permissions: 0o700 });
  physicalFile(scratch);
  for (const root of roots) {
    const destination = PathUtils.join(backup.path, root.directory);
    await IOUtils.makeDirectory(destination, { permissions: 0o700 });
    physicalFile(destination);
    for (const entry of root.entries) {
      checkCancellation(signal);
      const source = childPath(root.source, entry.parts);
      const target = childPath(destination, entry.parts);
      physicalFile(source);
      physicalFile(target);
      if (entry.type == "directory") {
        await IOUtils.makeDirectory(target, { permissions: 0o700 });
      } else if (await IOUtils.exists(target)) {
        await verifyFile(target, entry);
      } else {
        const temporary = await IOUtils.createUniqueFile(
          scratch,
          "copy-",
          0o600
        );
        const lease =
          AppConstants.platform == "win"
            ? admitWindowsMigrationPath(
                new FileUtils.File(source),
                Ci.nsIPanoramaMigrationFileSystem.KIND_FILE
              )
            : null;
        try {
          if (
            lease &&
            JSON.stringify(migrationPhysicalIdentity(lease)) !=
              JSON.stringify(entry.physicalIdentity)
          ) {
            throw new Error("Migration source physical identity changed");
          }
          await IOUtils.copy(source, temporary);
          if (lease) {
            migrationPhysicalIdentity(lease);
          }
        } finally {
          lease?.close();
        }
        await IOUtils.setPermissions(temporary, 0o600, false);
        // Flush the copied file without changing its contents.
        await IOUtils.write(temporary, new Uint8Array(), {
          mode: "append",
          flush: true,
        });
        await verifyFile(temporary, entry);
        await IOUtils.setModificationTime(temporary, entry.lastModified);
        await IOUtils.setPermissions(temporary, entry.permissions, false);
        checkCancellation(signal);
        await IOUtils.move(temporary, target, { noOverwrite: true });
      }
    }
  }
  for (const [index, root] of roots.entries()) {
    if (
      JSON.stringify(await inventory(root.source, index == 0, signal)) !=
      JSON.stringify({
        entries: root.entries,
        excluded: root.excluded,
        ...(root.physicalIdentity
          ? { physicalIdentity: root.physicalIdentity }
          : {}),
      })
    ) {
      throw new Error("Migration source changed during backup");
    }
  }
  // Completion is published only after source and destination verification.
  await verifyCopies(backup.path, manifest);
  checkCancellation(signal);
  manifest.complete = true;
  await IOUtils.writeJSON(manifestPath, manifest, {
    tmpPath: manifestPath + ".tmp",
    flush: true,
  });
  return verifyMigrationBackup(backup.path);
}

/**
 * Verifies every recorded backup file without requiring unchanged originals.
 * This also runs when resuming a journal, before any new destructive work.
 *
 * @param {string} backupPath - Completed backup directory.
 * @returns {Promise<{path: string, sha256: string}>} Manifest identity.
 */
export async function verifyMigrationBackup(backupPath) {
  const backup = physicalFile(backupPath);
  const path = PathUtils.join(backup.path, "manifest.json");
  const lease =
    AppConstants.platform == "win"
      ? admitWindowsMigrationPath(
          new FileUtils.File(path),
          Ci.nsIPanoramaMigrationFileSystem.KIND_FILE
        )
      : null;
  try {
    physicalFile(path);
    if ((await IOUtils.stat(path)).type != "regular") {
      throw new Error("Migration backup manifest is not a regular file");
    }
    const before = await hashMigrationFile(path);
    const manifest = await IOUtils.readJSON(path);
    if (
      ![1, 2, 3].includes(manifest.version) ||
      (AppConstants.platform == "win" && ![2, 3].includes(manifest.version)) ||
      manifest.complete !== true ||
      !Array.isArray(manifest.roots) ||
      !manifest.roots.length
    ) {
      throw new Error("Migration backup is incomplete or unsupported");
    }
    if (
      manifest.version >= 2 &&
      manifest.roots.some(
        root =>
          !isMigrationPhysicalIdentity(root.physicalIdentity) ||
          !Array.isArray(root.entries) ||
          root.entries.some(
            entry => !isMigrationPhysicalIdentity(entry.physicalIdentity)
          )
      )
    ) {
      throw new Error("Invalid migration backup physical identities");
    }
    if (manifest.version == 3) {
      if (
        !Array.isArray(manifest.originalRoots) ||
        !manifest.originalRoots.length ||
        new Set(manifest.originalRoots.map(root => root.originalPath)).size !=
          manifest.originalRoots.length ||
        manifest.originalRoots.some(
          original =>
            typeof original.originalPath != "string" ||
            original.originalPath.includes("\0") ||
            !PathUtils.isAbsolute(original.originalPath) ||
            !PathUtils.isAbsolute(original.canonicalPath) ||
            !isMigrationPhysicalIdentity(original.physicalIdentity) ||
            !manifest.roots.some(
              root =>
                (root.source === original.canonicalPath &&
                  JSON.stringify(root.physicalIdentity) ===
                    JSON.stringify(original.physicalIdentity)) ||
                root.entries.some(
                  entry =>
                    entry.type == "directory" &&
                    PathUtils.join(root.source, ...entry.parts) ===
                      original.canonicalPath &&
                    JSON.stringify(entry.physicalIdentity) ===
                      JSON.stringify(original.physicalIdentity)
                )
            )
        )
      ) {
        throw new Error("Invalid original migration backup roots");
      }
    }
    await verifyCopies(backup.path, manifest);
    if (before != (await hashMigrationFile(path))) {
      throw new Error("Migration backup manifest changed during verification");
    }
    return { path, sha256: before };
  } finally {
    lease?.close();
  }
}

/**
 * Restores a verified backup into fresh staging directories only.
 * Never overwrites the live profile, mail roots or the backup. The startup
 * coordinator must separately validate and switch these directories.
 *
 * @param {string} backupPath - Complete verified backup.
 * @param {string} parentPath - Existing staging parent outside all source trees.
 * @returns {Promise<{path: string, roots: {original: string, staged: string}[]}>}
 *   Fresh staging root and original-to-staged directory mappings.
 */
export async function stageMigrationRestore(backupPath, parentPath) {
  const receipt = await verifyMigrationBackup(backupPath);
  const manifest = await IOUtils.readJSON(receipt.path);
  const parent = physicalFile(parentPath);
  const backup = physicalFile(backupPath);
  if (
    backup.equals(parent) ||
    backup.contains(parent) ||
    manifest.roots.some(root => {
      const source = new FileUtils.File(root.source);
      return source.equals(parent) || source.contains(parent);
    })
  ) {
    throw new Error("Restore staging must be outside source and backup trees");
  }
  const path = await IOUtils.createUniqueDirectory(
    parent.path,
    "panorama-restore-",
    0o700
  );
  const roots = [];
  for (const root of manifest.roots) {
    const target = PathUtils.join(path, root.directory);
    await IOUtils.makeDirectory(target, {
      ignoreExisting: false,
      permissions: 0o700,
    });
    for (const entry of root.entries) {
      const output = childPath(target, entry.parts);
      if (entry.type == "directory") {
        await IOUtils.makeDirectory(output, {
          ignoreExisting: false,
          permissions: 0o700,
        });
      } else {
        const input = childPath(
          PathUtils.join(backup.path, root.directory),
          entry.parts
        );
        let sourceLease, future, outputLease;
        try {
          if (AppConstants.platform == "win") {
            sourceLease = admitWindowsMigrationPath(
              new FileUtils.File(input),
              Ci.nsIPanoramaMigrationFileSystem.KIND_FILE
            );
            future = admitWindowsMigrationPath(
              new FileUtils.File(output),
              Ci.nsIPanoramaMigrationFileSystem.KIND_FILE_OR_MISSING
            );
          }
          await IOUtils.copy(input, output, { noOverwrite: true });
          outputLease =
            AppConstants.platform == "win"
              ? admitWindowsMigrationPath(
                  new FileUtils.File(output),
                  Ci.nsIPanoramaMigrationFileSystem.KIND_FILE_OR_MISSING
                )
              : null;
          await IOUtils.setPermissions(output, 0o600, false);
          await IOUtils.write(output, new Uint8Array(), {
            mode: "append",
            flush: true,
          });
          await verifyFile(output, entry);
          if (outputLease) {
            Cc["@mozilla.org/mailnews/panorama-migration-file-system;1"]
              .getService(Ci.nsIPanoramaMigrationFileSystem)
              .setStageModificationTime(outputLease, entry.lastModified);
          } else {
            await IOUtils.setModificationTime(output, entry.lastModified);
          }
          await IOUtils.setPermissions(output, entry.permissions, false);
          if (sourceLease) {
            migrationPhysicalIdentity(sourceLease);
            migrationPhysicalIdentity(outputLease);
          }
        } finally {
          outputLease?.close();
          future?.close();
          sourceLease?.close();
        }
      }
    }
    // Apply directory metadata after creating their children.
    for (const entry of [...root.entries].reverse()) {
      if (entry.type == "directory") {
        const directory = childPath(target, entry.parts);
        await IOUtils.setModificationTime(directory, entry.lastModified);
        await IOUtils.setPermissions(directory, entry.permissions, false);
      }
    }
    await IOUtils.setModificationTime(target, root.lastModified);
    await IOUtils.setPermissions(target, root.permissions, false);
    roots.push({ original: root.source, staged: target });
  }
  const after = await verifyMigrationBackup(backup.path);
  if (after.sha256 != receipt.sha256) {
    throw new Error("Migration backup changed during restore staging");
  }
  return { path, roots };
}

/**
 * Normalizes ancestors and refuses a linked leaf, including dangling links.
 *
 * @param {string} path - Absolute file path, which may not exist yet.
 * @returns {nsIFile} Normalized root or leaf; descendants need childPath checks.
 */
function physicalFile(path) {
  if (!PathUtils.isAbsolute(path)) {
    throw new Error("Migration paths must be absolute");
  }
  const file = new FileUtils.File(path);
  if (AppConstants.platform == "win") {
    const exists = file.exists();
    const kind =
      exists && file.isDirectory()
        ? Ci.nsIPanoramaMigrationFileSystem.KIND_DIRECTORY
        : Ci.nsIPanoramaMigrationFileSystem.KIND_FILE_OR_MISSING;
    const lease = admitWindowsMigrationPath(file, kind);
    try {
      return new FileUtils.File(lease.canonicalPath);
    } finally {
      lease.close();
    }
  }
  let link = false;
  try {
    link = file.isSymlink();
  } catch (error) {
    if (error.result != Cr.NS_ERROR_FILE_NOT_FOUND) {
      throw error;
    }
    const parent = file.parent;
    parent.normalize();
    parent.append(file.leafName);
    return parent;
  }
  if (link) {
    throw new Error("Migration source or destination contains a link");
  }
  file.normalize();
  return file;
}

/**
 * Captures all directories and file hashes, including empty directories.
 *
 * @param {string} root - Directory to read.
 * @param {boolean} profile - Whether to exclude root-level profile locks.
 * @param {AbortSignal} [signal] - Stop without publishing backup completion.
 * @returns {Promise<{entries: object[], excluded: string[]}>} Stable inventory.
 */
async function inventory(root, profile, signal) {
  const rootLease =
    AppConstants.platform == "win"
      ? admitWindowsMigrationPath(
          new FileUtils.File(root),
          Ci.nsIPanoramaMigrationFileSystem.KIND_DIRECTORY
        )
      : null;
  try {
    const entries = [];
    const excluded = [];
    const pending = [{ path: root, parts: [] }];
    while (pending.length) {
      const current = pending.pop();
      const children = (await IOUtils.getChildren(current.path)).sort();
      for (const path of children) {
        checkCancellation(signal);
        const leaf = PathUtils.filename(path);
        if (profile && !current.parts.length && PROFILE_LOCKS.has(leaf)) {
          const file = new FileUtils.File(path);
          if (
            file.isSymlink() ||
            (await IOUtils.stat(path)).type == "regular"
          ) {
            excluded.push(leaf);
            continue;
          }
        }
        physicalFile(path);
        const info = await IOUtils.stat(path);
        const entry = {
          parts: [...current.parts, leaf],
          type: info.type,
          permissions: info.permissions,
          lastModified: info.lastModified,
        };
        const lease =
          AppConstants.platform == "win"
            ? admitWindowsMigrationPath(
                new FileUtils.File(path),
                info.type == "directory"
                  ? Ci.nsIPanoramaMigrationFileSystem.KIND_DIRECTORY
                  : Ci.nsIPanoramaMigrationFileSystem.KIND_FILE
              )
            : null;
        try {
          if (lease) {
            entry.physicalIdentity = migrationPhysicalIdentity(lease);
          }
          if (info.type == "directory") {
            pending.push({ path, parts: entry.parts });
          } else if (info.type == "regular") {
            entry.size = info.size;
            entry.sha256 = await hashMigrationFile(path);
            const after = await IOUtils.stat(path);
            if (
              after.size != info.size ||
              after.lastModified != info.lastModified
            ) {
              throw new Error("Migration source changed while hashing");
            }
          } else {
            throw new Error("Unsupported special file in migration source");
          }
          if (lease) {
            migrationPhysicalIdentity(lease);
          }
          entries.push(entry);
        } finally {
          lease?.close();
        }
      }
    }
    return {
      entries,
      excluded,
      ...(rootLease
        ? { physicalIdentity: migrationPhysicalIdentity(rootLease) }
        : {}),
    };
  } finally {
    rootLease?.close();
  }
}

/**
 * Resolves manifest components beneath a root and rejects links below it.
 *
 * @param {string} root - Absolute root.
 * @param {string[]} parts - Individual relative filename components.
 * @returns {string} Path under root.
 */
function childPath(root, parts) {
  if (
    !Array.isArray(parts) ||
    parts.some(
      part =>
        typeof part != "string" ||
        !part ||
        part == "." ||
        part == ".." ||
        PathUtils.isAbsolute(part) ||
        PathUtils.filename(PathUtils.join(root, part)) != part
    )
  ) {
    throw new Error("Invalid backup entry path");
  }
  const file = physicalFile(root);
  for (const part of parts) {
    file.append(part);
    // Do not normalize away a link inside the admitted tree.
    physicalFile(file.path);
  }
  return file.path;
}

/** @param {string} path - Copy path. @param {object} entry - Expected file. */
async function verifyFile(path, entry) {
  const lease =
    AppConstants.platform == "win"
      ? admitWindowsMigrationPath(
          new FileUtils.File(path),
          Ci.nsIPanoramaMigrationFileSystem.KIND_FILE
        )
      : null;
  try {
    physicalFile(path);
    const info = await IOUtils.stat(path);
    if (
      info.type != "regular" ||
      info.size != entry.size ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      (await hashMigrationFile(path)) != entry.sha256
    ) {
      throw new Error("Migration backup file differs from its source");
    }
    if (lease) {
      migrationPhysicalIdentity(lease);
    }
  } finally {
    lease?.close();
  }
}

/** @param {string} path - Backup root. @param {object} manifest - Saved inventory. */
async function verifyCopies(path, manifest) {
  for (const [index, root] of manifest.roots.entries()) {
    if (
      root.directory != "root-" + index ||
      !PathUtils.isAbsolute(root.source) ||
      !Array.isArray(root.entries) ||
      !Array.isArray(root.excluded) ||
      !validMetadata(root) ||
      root.excluded.some(name => index != 0 || !PROFILE_LOCKS.has(name))
    ) {
      throw new Error("Invalid migration backup root");
    }
    const directory = PathUtils.join(path, root.directory);
    physicalFile(directory);
    if ((await IOUtils.stat(directory)).type != "directory") {
      throw new Error("Missing migration backup root");
    }
    const seen = new Set();
    for (const entry of root.entries) {
      const entryKey = JSON.stringify(entry.parts);
      if (!validMetadata(entry) || seen.has(entryKey)) {
        throw new Error("Invalid or duplicate migration backup entry");
      }
      seen.add(entryKey);
      const target = childPath(directory, entry.parts);
      physicalFile(target);
      if (entry.type == "directory") {
        if ((await IOUtils.stat(target)).type != "directory") {
          throw new Error("Missing migration backup directory");
        }
      } else if (entry.type == "regular") {
        await verifyFile(target, entry);
      } else {
        throw new Error("Invalid migration backup entry");
      }
    }
  }
}

/** @param {object} entry - Saved metadata. @returns {boolean} Valid mode/time. */
function validMetadata(entry) {
  return (
    Number.isInteger(entry.permissions) &&
    entry.permissions >= 0 &&
    entry.permissions <= 0o7777 &&
    Number.isSafeInteger(entry.lastModified)
  );
}

/** @param {AbortSignal} [signal] - Cancellation requested by the caller. */
function checkCancellation(signal) {
  if (signal?.aborted) {
    throw new DOMException("Migration backup cancelled", "AbortError");
  }
}
