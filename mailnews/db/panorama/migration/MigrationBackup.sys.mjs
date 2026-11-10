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
 * The servers the account manager loads, with a persisted directory: only the
 * server each listed account names (nsMsgAccountManager::LoadAccounts). Any
 * other mail.server.* branch is the leftover of a removed account, which
 * Thunderbird never reads even when it still names a directory.
 *
 * @returns {string[]} Sorted server keys, without initializing any server.
 */
export function collectAccountServerKeys() {
  const keys = new Set();
  for (const list of [
    "mail.accountmanager.accounts",
    "mail.accountmanager.appendaccounts",
  ]) {
    for (const account of Services.prefs.getCharPref(list, "").split(",")) {
      const key =
        account &&
        Services.prefs.getCharPref("mail.account." + account + ".server", "");
      if (
        key &&
        ["directory", "directory-rel"].some(
          name =>
            Services.prefs.getPrefType("mail.server." + key + "." + name) !=
            Ci.nsIPrefBranch.PREF_INVALID
        )
      ) {
        keys.add(key);
      }
    }
  }
  return [...keys].sort();
}

/**
 * Collects persisted profile/server storage paths without initializing stores.
 * Does not call localPath/getFileValue, which can create directories or prefs.
 * Relative descriptors take precedence, matching existing account behavior.
 *
 * @returns {{profilePath: string, mailPaths: string[]}} Configured source roots.
 */
export function collectMigrationRoots() {
  const branches = collectAccountServerKeys().map(key => "mail.server." + key);
  const mailPaths = branches.map(branch => {
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
 * A fresh copy requires at least the inventoried file bytes available on disk.
 * This does not reserve space or include filesystem/manifest overhead.
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
    // This is only a lower bound: directory/manifest overhead and concurrent
    // allocations can still make a later copy fail. Incomplete backups retain
    // their existing retry path; already copied bytes need no second allocation.
    let requiredBytes = 0;
    for (const root of roots) {
      for (const entry of root.entries) {
        if (entry.type == "regular") {
          requiredBytes += entry.size;
          if (!Number.isSafeInteger(requiredBytes)) {
            throw new Error(
              "Migration backup byte count exceeds the supported range"
            );
          }
        }
      }
    }
    const availableBytes = new FileUtils.File(backup.parent.path)
      .diskSpaceAvailable;
    if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) {
      throw new Error("Migration backup free space is unavailable");
    }
    if (availableBytes < requiredBytes) {
      throw Components.Exception(
        `Migration backup needs at least ${requiredBytes} bytes; ${availableBytes} available`,
        Cr.NS_ERROR_FILE_NO_DEVICE_SPACE
      );
    }
    checkCancellation(signal);
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
    // A plain spelling past MAX_PATH reports an existing directory as absent.
    const io = ioFile(file);
    const kind =
      io.exists() && io.isDirectory()
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
 * Returns a clone for I/O on an admitted path that may exceed MAX_PATH.
 * A backup copy lives below the fixed panorama-migration-<profile>\backup\
 * root-N prefix, which is longer than the profile's own, so a copy of a legacy
 * file close to MAX_PATH exceeds it. Windows uses the extended-length spelling;
 * physicalFile/native admission already refuses every component spelling that
 * this form would not normalize identically (".", "..", trailing dots/spaces,
 * device names, reparse points). Path identity checks keep the plain spelling.
 *
 * @param {nsIFile} file - Admitted plain path.
 * @returns {nsIFile} Independent clone for file-system calls only.
 */
function ioFile(file) {
  const io = file.clone();
  if (AppConstants.platform == "win") {
    io.QueryInterface(Ci.nsILocalFileWin).useDOSDevicePathSyntax = true;
  }
  return io;
}

/** @param {string} path - Admitted plain path. @returns {string} IOUtils spelling. */
function ioPath(path) {
  return AppConstants.platform == "win"
    ? ioFile(new FileUtils.File(path)).path
    : path;
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
    const info = await IOUtils.stat(ioPath(path));
    if (
      info.type != "regular" ||
      info.size != entry.size ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      (await hashMigrationFile(ioPath(path))) != entry.sha256
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
        if ((await IOUtils.stat(ioPath(target))).type != "directory") {
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

/**
 * Copies the selected profile before ordinary profile startup notifications.
 * The caller must run synchronously under startup's existing profile lock.
 * This function does not pump the event loop or initialize mail services.
 * Incomplete copies remain available for a retry with identical source bytes.
 *
 * @param {string} profilePath - Selected startup profile directory.
 * @param {string[]} mailPaths - Persisted external message directories.
 * @param {string} backupPath - Private destination outside every source tree.
 * @param {AbortSignal} [signal] - Cancellation checked between stream reads.
 * @returns {{path: string, sha256: string}} Complete manifest path and hash.
 * @throws {Error} For cancellation, changed sources, unsafe paths or copy errors.
 */
export function createMigrationBackupAtStartup(
  profilePath,
  mailPaths,
  backupPath,
  signal
) {
  checkCancellation(signal);
  const profile = physicalFile(profilePath);
  const backup = physicalFile(backupPath);
  const sources = [profile];
  for (const path of mailPaths) {
    const file = physicalFile(path);
    if (sources.some(parent => parent.equals(file) || parent.contains(file))) {
      continue;
    }
    if (file.contains(profile)) {
      throw new Error("External mail root contains the profile");
    }
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
  // Do not replace an existing directory or silently reuse a foreign archive.
  const manifestFile = backup.clone();
  manifestFile.append("manifest.json");
  const roots = sources.map((source, index) => {
    if (!source.isDirectory()) {
      throw new Error("Migration source root is not a directory");
    }
    return {
      source: source.path,
      directory: "root-" + index,
      permissions: source.permissions,
      lastModified: source.lastModifiedTime,
      ...startupInventory(source, index == 0, signal),
    };
  });
  const originalRoots =
    AppConstants.platform == "win"
      ? captureWindowsMigrationRoots([profilePath, ...mailPaths])
      : null;
  let manifest;
  if (backup.exists()) {
    physicalFile(manifestFile.path);
    manifest = readStartupJSON(manifestFile);
    if (
      manifest.version != BACKUP_VERSION ||
      JSON.stringify(manifest.roots) != JSON.stringify(roots) ||
      (originalRoots &&
        JSON.stringify(manifest.originalRoots) !=
          JSON.stringify(originalRoots)) ||
      ![false, true].includes(manifest.complete)
    ) {
      throw new Error(
        "Backup source identity changed; keep the previous backup"
      );
    }
  } else {
    let requiredBytes = 0;
    for (const root of roots) {
      for (const entry of root.entries) {
        requiredBytes += entry.size ?? 0;
        if (!Number.isSafeInteger(requiredBytes)) {
          throw new Error("Migration backup byte count exceeds the safe range");
        }
      }
    }
    if (backup.parent.diskSpaceAvailable < requiredBytes) {
      throw new Error("Insufficient space for migration backup");
    }
    backup.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
    manifest = {
      version: BACKUP_VERSION,
      complete: false,
      roots,
      ...(originalRoots ? { originalRoots } : {}),
    };
    writeStartupJSON(manifestFile, manifest);
  }
  const scratch = backup.clone();
  scratch.append("scratch");
  if (!manifest.complete && !scratch.exists()) {
    scratch.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  }
  physicalFile(scratch.path);
  for (const root of roots) {
    const destination = backup.clone();
    destination.append(root.directory);
    if (!destination.exists()) {
      if (manifest.complete) {
        throw new Error("A complete backup is missing a directory");
      }
      destination.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
    }
    physicalFile(destination.path);
    for (const entry of root.entries) {
      checkCancellation(signal);
      const target = new FileUtils.File(
        childPath(destination.path, entry.parts)
      );
      // The admitted plain spelling above; file-system calls use ioFile.
      const copy = ioFile(target);
      if (entry.type == "directory") {
        if (!copy.exists()) {
          if (manifest.complete) {
            throw new Error("A complete backup is missing a directory");
          }
          copy.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
        }
        if (!copy.isDirectory()) {
          throw new Error("Migration backup directory is not a directory");
        }
      } else if (copy.exists()) {
        checkStartupCopy(target, entry, signal);
      } else {
        if (manifest.complete) {
          throw new Error("A complete backup is missing a file");
        }
        const source = new FileUtils.File(childPath(root.source, entry.parts));
        const temporary = scratch.clone();
        temporary.append("copy-" + Services.uuid.generateUUID());
        ioFile(source).copyTo(ioFile(scratch), temporary.leafName);
        temporary.permissions = 0o600;
        checkStartupCopy(temporary, entry, signal);
        const output = Cc[
          "@mozilla.org/network/file-output-stream;1"
        ].createInstance(Ci.nsIFileOutputStream);
        output.init(temporary, 0x02 | 0x10, 0o600, 0);
        let flushError;
        try {
          output.flush();
        } catch (error) {
          flushError = error;
        }
        try {
          output.close();
        } catch (error) {
          if (flushError) {
            console.error("Additional migration copy close error", error);
          } else {
            flushError = error;
          }
        }
        if (flushError) {
          throw flushError;
        }
        temporary.lastModifiedTime = entry.lastModified;
        temporary.permissions = entry.permissions;
        checkCancellation(signal);
        if (copy.exists()) {
          throw new Error("Migration backup destination appeared during copy");
        }
        ioFile(temporary).moveTo(ioFile(target.parent), target.leafName);
      }
    }
  }
  for (const [index, root] of roots.entries()) {
    if (
      JSON.stringify(startupInventory(sources[index], index == 0, signal)) !=
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
    for (const entry of root.entries) {
      if (entry.type == "regular") {
        checkStartupCopy(
          new FileUtils.File(
            childPath(PathUtils.join(backup.path, root.directory), entry.parts)
          ),
          entry,
          signal
        );
      }
    }
  }
  checkCancellation(signal);
  let sha256;
  if (!manifest.complete) {
    manifest.complete = true;
    sha256 = writeStartupJSON(manifestFile, manifest);
  } else {
    sha256 = hashStartupFile(manifestFile, signal);
  }
  return { path: manifestFile.path, sha256 };
}

/**
 * Reads directory metadata and file hashes without opening mail/NSS databases.
 *
 * @param {nsIFile} root - Canonical selected directory.
 * @param {boolean} profile - Exclude ordinary profile lock files at the root.
 * @param {AbortSignal} [signal] - Cancellation signal.
 * @returns {{entries: object[], excluded: string[], physicalIdentity?: object}}
 *   Ordered source inventory, compatible with ordinary backup verification.
 */
function startupInventory(root, profile, signal) {
  const entries = [];
  const excluded = [];
  const pending = [{ file: root, parts: [] }];
  while (pending.length) {
    const { file, parts } = pending.pop();
    const children = [...file.directoryEntries]
      .map(child => child.QueryInterface(Ci.nsIFile))
      .sort((a, b) => {
        if (a.path == b.path) {
          return 0;
        }
        return a.path < b.path ? -1 : 1;
      });
    for (const child of children) {
      checkCancellation(signal);
      if (
        profile &&
        !parts.length &&
        PROFILE_LOCKS.has(child.leafName) &&
        (child.isSymlink() || child.isFile())
      ) {
        excluded.push(child.leafName);
        continue;
      }
      physicalFile(child.path);
      const entry = {
        parts: [...parts, child.leafName],
        type: child.isDirectory() ? "directory" : "regular",
        permissions: child.permissions,
        lastModified: child.lastModifiedTime,
      };
      if (AppConstants.platform == "win") {
        entry.physicalIdentity = startupPhysicalIdentity(child);
      }
      if (child.isDirectory()) {
        pending.push({ file: child, parts: entry.parts });
      } else if (child.isFile()) {
        entry.size = child.fileSize;
        entry.sha256 = hashStartupFile(child, signal);
        if (
          entry.size != child.fileSize ||
          entry.lastModified != child.lastModifiedTime
        ) {
          throw new Error("Migration source changed while hashing");
        }
      } else {
        throw new Error("Unsupported special file in migration source");
      }
      entries.push(entry);
    }
  }
  return {
    entries,
    excluded,
    ...(AppConstants.platform == "win"
      ? { physicalIdentity: startupPhysicalIdentity(root) }
      : {}),
  };
}

/**
 * Reads an existing native physical identity on Windows.
 *
 * @param {nsIFile} file - Source file or directory.
 * @returns {object} Existing migration filesystem identity.
 */
function startupPhysicalIdentity(file) {
  const lease = admitWindowsMigrationPath(
    file,
    file.isDirectory()
      ? Ci.nsIPanoramaMigrationFileSystem.KIND_DIRECTORY
      : Ci.nsIPanoramaMigrationFileSystem.KIND_FILE
  );
  try {
    return migrationPhysicalIdentity(lease);
  } finally {
    lease.close();
  }
}

/**
 * Hashes a regular file with bounded synchronous stream reads. The hash
 * service consumes the stream itself: a backup hashes every file four times,
 * and passing each byte through a script array took hours for an ordinary
 * multi-gigabyte profile.
 *
 * @param {nsIFile} file - Canonical regular file.
 * @param {AbortSignal} [signal] - Cancellation checked between reads.
 * @returns {string} Lowercase SHA-256.
 */
function hashStartupFile(file, signal) {
  physicalFile(file.path);
  const io = ioFile(file);
  if (!io.isFile()) {
    throw new Error("Migration hash source is not a regular file");
  }
  const size = io.fileSize;
  const modified = io.lastModifiedTime;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Unsupported migration hash file size");
  }
  const input = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(
    Ci.nsIFileInputStream
  );
  input.init(io, 0x01, 0, 0);
  let firstError;
  let digest;
  try {
    const hash = Cc["@mozilla.org/security/hash;1"].createInstance(
      Ci.nsICryptoHash
    );
    hash.init(Ci.nsICryptoHash.SHA256);
    for (let remaining = size; remaining > 0; ) {
      checkCancellation(signal);
      const count = Math.min(1024 * 1024, remaining);
      try {
        hash.updateFromStream(input, count);
      } catch (error) {
        // The stream no longer holds the bytes its measured size promised.
        if (
          error.result == Cr.NS_ERROR_NOT_AVAILABLE ||
          error.result == Cr.NS_BASE_STREAM_CLOSED
        ) {
          throw new Error("Migration file changed while hashing");
        }
        throw error;
      }
      remaining -= count;
    }
    if (io.fileSize != size || io.lastModifiedTime != modified) {
      throw new Error("Migration source changed while hashing");
    }
    digest = Array.from(hash.finish(false), byte =>
      byte.charCodeAt(0).toString(16).padStart(2, "0")
    ).join("");
  } catch (error) {
    firstError = error;
  }
  try {
    input.close();
  } catch (error) {
    if (firstError) {
      console.error("Additional migration input close error", error);
    } else {
      firstError = error;
    }
  }
  if (firstError) {
    throw firstError;
  }
  return digest;
}

/**
 * Checks a copied file against the full source hash and byte count.
 *
 * @param {nsIFile} file - Existing private copy.
 * @param {{size: number, sha256: string}} entry - Recorded source identity.
 * @param {AbortSignal} [signal] - Cancellation signal.
 */
function checkStartupCopy(file, entry, signal) {
  const io = ioFile(file);
  if (
    !io.isFile() ||
    io.fileSize != entry.size ||
    hashStartupFile(file, signal) != entry.sha256
  ) {
    throw new Error("Migration backup file differs from its source");
  }
}

/**
 * Reads a private backup manifest with ordinary synchronous UTF-8 streams.
 *
 * @param {nsIFile} file - Existing regular manifest.
 * @returns {object} Parsed manifest.
 */
function readStartupJSON(file) {
  if (!file.isFile()) {
    throw new Error("Migration backup manifest is not a regular file");
  }
  const input = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(
    Ci.nsIFileInputStream
  );
  input.init(file, 0x01, 0, 0);
  let firstError;
  let value;
  try {
    const converter = Cc[
      "@mozilla.org/intl/converter-input-stream;1"
    ].createInstance(Ci.nsIConverterInputStream);
    converter.init(input, "UTF-8", 0, 0);
    let text = "";
    const part = {};
    while (converter.readString(64 * 1024, part)) {
      text += part.value;
    }
    value = JSON.parse(text);
  } catch (error) {
    firstError = error;
  }
  try {
    input.close();
  } catch (error) {
    if (firstError) {
      console.error("Additional migration manifest close error", error);
    } else {
      firstError = error;
    }
  }
  if (firstError) {
    throw firstError;
  }
  return value;
}

/**
 * Atomically writes and flushes a private backup manifest.
 *
 * @param {nsIFile} file - Manifest in the private backup directory.
 * @param {object} value - Manifest state.
 * @returns {string} SHA-256 of the exact UTF-8 bytes written and flushed.
 */
function writeStartupJSON(file, value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const output = Cc[
    "@mozilla.org/network/safe-file-output-stream;1"
  ].createInstance(Ci.nsIFileOutputStream);
  output.init(file, 0x02 | 0x08 | 0x20, 0o600, 0);
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hash.init(Ci.nsICryptoHash.SHA256);
  try {
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      const chunk = bytes.subarray(offset, offset + 64 * 1024);
      const count = output.write(String.fromCharCode(...chunk), chunk.length);
      hash.update(chunk, chunk.length);
      if (count != chunk.length) {
        throw new Error("Incomplete migration manifest write");
      }
    }
    const sha256 = Array.from(hash.finish(false), byte =>
      byte.charCodeAt(0).toString(16).padStart(2, "0")
    ).join("");
    output.QueryInterface(Ci.nsISafeOutputStream).finish();
    return sha256;
  } catch (error) {
    try {
      output.close();
    } catch (cleanupError) {
      console.error("Additional migration output close error", cleanupError);
    }
    throw error;
  }
}
