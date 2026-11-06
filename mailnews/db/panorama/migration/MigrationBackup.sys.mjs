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

import {
  selectedMigrationIO,
  selectedMigrationCopy,
  validateSelectedMigrationView,
} from "resource:///modules/panorama/MigrationQuiescence.sys.mjs";

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
 * A fresh copy requires at least the inventoried file bytes available on disk.
 * This does not reserve space or include filesystem/manifest overhead.
 * Never changes or removes source data. Failed scratch copies are retained.
 * Profile lock files are recorded as exclusions; other links/special files fail.
 *
 * @param {string} profilePath - Original profile directory.
 * @param {string[]} mailPaths - All configured mail-store directories.
 * @param {string} backupPath - Backup outside all source trees; parent exists.
 * @param {AbortSignal} [signal] - Stop at a file boundary, keeping incomplete copies.
 * @param {nsISupports} [nativeView] - Actual native selected view; when supplied,
 *   every awaited operation is validated before IO and after settlement.
 * @returns {Promise<{path: string, sha256: string}>} Verified complete manifest.
 */
export async function createMigrationBackup(
  profilePath,
  mailPaths,
  backupPath,
  signal,
  nativeView
) {
  if (nativeView) {
    validateSelectedMigrationView(nativeView, "before-source-read");
  }
  checkCancellation(signal);
  const originalRoots =
    AppConstants.platform == "win"
      ? captureWindowsMigrationRoots([profilePath, ...mailPaths])
      : null;
  const profile = physicalFile(profilePath);
  const backup = physicalFile(backupPath);
  if (
    AppConstants.platform == "win" &&
    (await selectedMigrationIO(nativeView, () => IOUtils.exists(backup.path)))
  ) {
    const existing = physicalFile(PathUtils.join(backup.path, "manifest.json"));
    if (
      (await selectedMigrationIO(nativeView, () => IOUtils.stat(existing.path)))
        .type != "regular" ||
      (
        await selectedMigrationIO(nativeView, () =>
          IOUtils.readJSON(existing.path)
        )
      ).version !== BACKUP_VERSION
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
    const info = await selectedMigrationIO(nativeView, () =>
      IOUtils.stat(source.path)
    );
    if (info.type != "directory") {
      throw new Error("Migration source root is not a directory");
    }
    roots.push({
      source: source.path,
      directory: "root-" + index,
      permissions: info.permissions,
      lastModified: info.lastModified,
      ...(await selectedMigrationIO(nativeView, () =>
        inventory(source.path, index == 0, signal, nativeView)
      )),
    });
  }
  const manifestPath = PathUtils.join(backup.path, "manifest.json");
  let manifest;
  if (
    await selectedMigrationIO(nativeView, () => IOUtils.exists(backup.path))
  ) {
    physicalFile(manifestPath);
    if (
      (await selectedMigrationIO(nativeView, () => IOUtils.stat(manifestPath)))
        .type != "regular"
    ) {
      throw new Error("Migration backup manifest is not a regular file");
    }
    manifest = await selectedMigrationIO(nativeView, () =>
      IOUtils.readJSON(manifestPath)
    );
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
      return verifyMigrationBackup(backup.path, nativeView);
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
    await selectedMigrationIO(nativeView, () =>
      IOUtils.makeDirectory(backup.path, {
        createAncestors: false,
        ignoreExisting: false,
        permissions: 0o700,
      })
    );
    manifest = {
      version: BACKUP_VERSION,
      complete: false,
      roots,
      ...(originalRoots ? { originalRoots } : {}),
    };
    await selectedMigrationIO(nativeView, () =>
      IOUtils.writeJSON(manifestPath, manifest, {
        mode: "create",
        flush: true,
      })
    );
  }
  const scratch = PathUtils.join(backup.path, "scratch");
  await selectedMigrationIO(nativeView, () =>
    IOUtils.makeDirectory(scratch, { permissions: 0o700 })
  );
  physicalFile(scratch);
  for (const root of roots) {
    const destination = PathUtils.join(backup.path, root.directory);
    await selectedMigrationIO(nativeView, () =>
      IOUtils.makeDirectory(destination, { permissions: 0o700 })
    );
    physicalFile(destination);
    for (const entry of root.entries) {
      checkCancellation(signal);
      const source = childPath(root.source, entry.parts);
      const target = childPath(destination, entry.parts);
      physicalFile(source);
      physicalFile(target);
      if (entry.type == "directory") {
        await selectedMigrationIO(nativeView, () =>
          IOUtils.makeDirectory(target, { permissions: 0o700 })
        );
      } else if (
        await selectedMigrationIO(nativeView, () => IOUtils.exists(target))
      ) {
        await selectedMigrationIO(nativeView, () =>
          verifyFile(target, entry, nativeView)
        );
      } else {
        const temporary = await selectedMigrationIO(nativeView, () =>
          IOUtils.createUniqueFile(scratch, "copy-", 0o600)
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
          await selectedMigrationIO(nativeView, () =>
            selectedMigrationCopy(nativeView, source, temporary)
          );
          if (lease) {
            migrationPhysicalIdentity(lease);
          }
        } finally {
          lease?.close();
        }
        await selectedMigrationIO(nativeView, () =>
          IOUtils.setPermissions(temporary, 0o600, false)
        );
        // Flush the copied file without changing its contents.
        await selectedMigrationIO(nativeView, () =>
          IOUtils.write(temporary, new Uint8Array(), {
            mode: "append",
            flush: true,
          })
        );
        await selectedMigrationIO(nativeView, () =>
          verifyFile(temporary, entry, nativeView)
        );
        await selectedMigrationIO(nativeView, () =>
          IOUtils.setModificationTime(temporary, entry.lastModified)
        );
        await selectedMigrationIO(nativeView, () =>
          IOUtils.setPermissions(temporary, entry.permissions, false)
        );
        checkCancellation(signal);
        await selectedMigrationIO(nativeView, () =>
          IOUtils.move(temporary, target, { noOverwrite: true })
        );
      }
    }
  }
  for (const [index, root] of roots.entries()) {
    if (
      JSON.stringify(
        await selectedMigrationIO(nativeView, () =>
          inventory(root.source, index == 0, signal, nativeView)
        )
      ) !=
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
  await selectedMigrationIO(nativeView, () =>
    verifyCopies(backup.path, manifest, nativeView)
  );
  checkCancellation(signal);
  if (nativeView) {
    validateSelectedMigrationView(nativeView, "before-publication");
  }
  manifest.complete = true;
  await selectedMigrationIO(nativeView, () =>
    IOUtils.writeJSON(manifestPath, manifest, {
      tmpPath: manifestPath + ".tmp",
      flush: true,
    })
  );
  return verifyMigrationBackup(backup.path, nativeView);
}

/**
 * Verifies every recorded backup file without requiring unchanged originals.
 * This also runs when resuming a journal, before any new destructive work.
 *
 * @param {string} backupPath - Completed backup directory.
 * @param {nsISupports} [nativeView] - Actual selected view retained through IO.
 * @returns {Promise<{path: string, sha256: string}>} Manifest identity.
 */
export async function verifyMigrationBackup(backupPath, nativeView) {
  if (nativeView) {
    validateSelectedMigrationView(nativeView, "before-source-read");
  }

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
    if (
      (await selectedMigrationIO(nativeView, () => IOUtils.stat(path))).type !=
      "regular"
    ) {
      throw new Error("Migration backup manifest is not a regular file");
    }
    const before = await selectedMigrationIO(nativeView, () =>
      hashMigrationFile(path)
    );
    const manifest = await selectedMigrationIO(nativeView, () =>
      IOUtils.readJSON(path)
    );
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
    await selectedMigrationIO(nativeView, () =>
      verifyCopies(backup.path, manifest, nativeView)
    );
    if (
      before !=
      (await selectedMigrationIO(nativeView, () => hashMigrationFile(path)))
    ) {
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
 * @param {nsISupports} [nativeView] - Actual selected view retained through IO.
 * @returns {Promise<{entries: object[], excluded: string[]}>} Stable inventory.
 */
async function inventory(root, profile, signal, nativeView) {
  if (nativeView) {
    validateSelectedMigrationView(nativeView, "before-source-read");
  }

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
      const children = (
        await selectedMigrationIO(nativeView, () =>
          IOUtils.getChildren(current.path)
        )
      ).sort();
      for (const path of children) {
        checkCancellation(signal);
        const leaf = PathUtils.filename(path);
        if (profile && !current.parts.length && PROFILE_LOCKS.has(leaf)) {
          const file = new FileUtils.File(path);
          if (
            file.isSymlink() ||
            (await selectedMigrationIO(nativeView, () => IOUtils.stat(path)))
              .type == "regular"
          ) {
            excluded.push(leaf);
            continue;
          }
        }
        physicalFile(path);
        const info = await selectedMigrationIO(nativeView, () =>
          IOUtils.stat(path)
        );
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
            entry.sha256 = await selectedMigrationIO(nativeView, () =>
              hashMigrationFile(path)
            );
            const after = await selectedMigrationIO(nativeView, () =>
              IOUtils.stat(path)
            );
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

/**
 * Checks the copied bytes against the original entry.
 *
 * @param {string} path - Copy path.
 * @param {object} entry - Expected size, hash and metadata.
 * @param {nsISupports} [nativeView] - Actual selected view retained through IO.
 * @returns {Promise<void>} Resolves after the exact copy is verified.
 */
async function verifyFile(path, entry, nativeView) {
  if (nativeView) {
    validateSelectedMigrationView(nativeView, "before-source-read");
  }

  const lease =
    AppConstants.platform == "win"
      ? admitWindowsMigrationPath(
          new FileUtils.File(path),
          Ci.nsIPanoramaMigrationFileSystem.KIND_FILE
        )
      : null;
  try {
    physicalFile(path);
    const info = await selectedMigrationIO(nativeView, () =>
      IOUtils.stat(path)
    );
    if (
      info.type != "regular" ||
      info.size != entry.size ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      (await selectedMigrationIO(nativeView, () => hashMigrationFile(path))) !=
        entry.sha256
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

/**
 * Verifies every saved root and copied entry in the complete manifest.
 *
 * @param {string} path - Backup root.
 * @param {object} manifest - Saved inventory.
 * @param {nsISupports} [nativeView] - Actual selected view retained through IO.
 * @returns {Promise<void>} Resolves after every declared copy is verified.
 */
async function verifyCopies(path, manifest, nativeView) {
  if (nativeView) {
    validateSelectedMigrationView(nativeView, "before-source-read");
  }

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
    if (
      (await selectedMigrationIO(nativeView, () => IOUtils.stat(directory)))
        .type != "directory"
    ) {
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
        if (
          (await selectedMigrationIO(nativeView, () => IOUtils.stat(target)))
            .type != "directory"
        ) {
          throw new Error("Missing migration backup directory");
        }
      } else if (entry.type == "regular") {
        await selectedMigrationIO(nativeView, () =>
          verifyFile(target, entry, nativeView)
        );
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
 * Copies the native selected inventory into a fresh snapshot bundle.
 * Directory backups retain their existing manifest/restore format. External
 * metadata leaves outside those directories are copied individually; an absent
 * leaf is recorded without copying its parent or unrelated siblings.
 *
 * @param {object} inventory - Exact native inventory-json value.
 * @param {string} backupPath - Fresh bundle path outside all selected sources.
 * @param {AbortSignal} signal - Native operation cancellation signal.
 * @param {nsISupports} nativeView - Exact live selected view.
 * @returns {Promise<{path: string, sha256: string}>} Complete snapshot manifest.
 * @throws {*} Original IO, cancellation or native identity error.
 */
export async function createSelectedMigrationBackup(
  inventory,
  backupPath,
  signal,
  nativeView
) {
  validateSelectedMigrationView(nativeView, "before-source-read");
  const bag = nativeView.QueryInterface(Ci.nsIPropertyBag2);
  if (
    JSON.stringify(inventory) !=
    JSON.stringify(JSON.parse(bag.getPropertyAsAString("inventory-json")))
  ) {
    throw new Error("Snapshot inventory differs from native custody");
  }
  const directoryRoots = inventory.roots.filter(
    root => root.kind == "directory"
  );
  const fileRoots = inventory.roots.filter(root => root.kind == "file");
  const profile = inventory.roots.find(root => root.role == "profile");
  if (
    !profile ||
    directoryRoots.length + fileRoots.length != inventory.roots.length
  ) {
    throw new Error("Unsupported selected snapshot inventory");
  }
  await selectedMigrationIO(nativeView, () =>
    IOUtils.makeDirectory(backupPath, {
      createAncestors: false,
      ignoreExisting: false,
      permissions: 0o700,
    })
  );
  const directories = await createMigrationBackup(
    profile.canonicalPath,
    directoryRoots.map(root => root.canonicalPath),
    PathUtils.join(backupPath, "directories"),
    signal,
    nativeView
  );
  const filesPath = PathUtils.join(backupPath, "files");
  await selectedMigrationIO(nativeView, () =>
    IOUtils.makeDirectory(filesPath, {
      ignoreExisting: false,
      permissions: 0o700,
    })
  );
  const externalFiles = [];
  const saved = new Set();
  for (const root of fileRoots) {
    const source = new FileUtils.File(root.canonicalPath);
    if (
      saved.has(source.path) ||
      directoryRoots.some(directory =>
        new FileUtils.File(directory.canonicalPath).contains(source)
      )
    ) {
      continue;
    }
    saved.add(source.path);
    checkCancellation(signal);
    // Native validation binds the absence/leaf and its original physical parent.
    validateSelectedMigrationView(nativeView, "before-source-read");
    if (!root.exists) {
      if (source.exists()) {
        throw new Error("Absent snapshot metadata appeared");
      }
      externalFiles.push({ source: source.path, exists: false });
      continue;
    }
    physicalFile(source.path);
    const before = await selectedMigrationIO(nativeView, () =>
      IOUtils.stat(source.path)
    );
    if (before.type != "regular") {
      throw new Error("Snapshot metadata is not a regular file");
    }
    const digest = await selectedMigrationIO(nativeView, () =>
      hashMigrationFile(source.path)
    );
    const file = "file-" + externalFiles.length;
    const output = PathUtils.join(filesPath, file);
    await selectedMigrationCopy(nativeView, source.path, output, {
      noOverwrite: true,
    });
    await selectedMigrationIO(nativeView, () =>
      IOUtils.setPermissions(output, 0o600, false)
    );
    await selectedMigrationIO(nativeView, () =>
      IOUtils.write(output, new Uint8Array(), { mode: "append", flush: true })
    );
    const entry = {
      source: source.path,
      exists: true,
      file,
      size: before.size,
      sha256: digest,
      permissions: before.permissions,
      lastModified: before.lastModified,
    };
    await verifyFile(output, entry, nativeView);
    const after = await selectedMigrationIO(nativeView, () =>
      IOUtils.stat(source.path)
    );
    if (
      before.size != after.size ||
      before.lastModified != after.lastModified ||
      digest !=
        (await selectedMigrationIO(nativeView, () =>
          hashMigrationFile(source.path)
        ))
    ) {
      throw new Error("Snapshot metadata changed during copy");
    }
    externalFiles.push(entry);
  }
  const manifest = {
    version: 1,
    kind: "selected-profile-snapshot",
    complete: true,
    inventory,
    directories,
    externalFiles,
  };
  await verifySelectedCopies(
    new FileUtils.File(backupPath),
    manifest,
    nativeView
  );
  validateSelectedMigrationView(nativeView, "before-publication");
  const path = PathUtils.join(backupPath, "snapshot.json");
  await selectedMigrationIO(nativeView, () =>
    IOUtils.writeJSON(path, manifest, { mode: "create", flush: true })
  );
  return verifySelectedMigrationBackup(backupPath, nativeView);
}

/**
 * Verifies all copied directory and external-file bytes in a snapshot bundle.
 * This reads the bundle only. A saved inventory never grants a selected lease.
 *
 * @param {string} backupPath - Existing selected snapshot bundle.
 * @param {nsISupports} [nativeView] - Live view for an ongoing selected operation.
 * @returns {Promise<{path: string, sha256: string}>} Verified manifest identity.
 * @throws {Error} For an incomplete, altered or inconsistent bundle.
 */
export async function verifySelectedMigrationBackup(backupPath, nativeView) {
  const bundle = physicalFile(backupPath);
  const path = PathUtils.join(bundle.path, "snapshot.json");
  physicalFile(path);
  const digest = await selectedMigrationIO(nativeView, () =>
    hashMigrationFile(path)
  );
  const manifest = await selectedMigrationIO(nativeView, () =>
    IOUtils.readJSON(path)
  );
  if (
    manifest.version !== 1 ||
    manifest.kind !== "selected-profile-snapshot" ||
    manifest.complete !== true ||
    !Array.isArray(manifest.inventory?.roots) ||
    !Array.isArray(manifest.externalFiles)
  ) {
    throw new Error("Invalid selected snapshot manifest");
  }
  await verifySelectedCopies(bundle, manifest, nativeView);
  if (
    digest !==
    (await selectedMigrationIO(nativeView, () => hashMigrationFile(path)))
  ) {
    throw new Error("Selected snapshot manifest changed during verification");
  }
  return { path, sha256: digest };
}

/**
 * Checks selected root coverage and all copied bytes before publishing completion.
 *
 * @param {nsIFile} bundle - Existing fresh bundle directory.
 * @param {object} manifest - Candidate complete snapshot inventory.
 * @param {nsISupports} [nativeView] - Actual selected view, when ongoing.
 * @returns {Promise<void>} All selected directory/leaf copies are verified.
 */
async function verifySelectedCopies(bundle, manifest, nativeView) {
  const actual = await verifyMigrationBackup(
    PathUtils.join(bundle.path, "directories"),
    nativeView
  );
  if (
    actual.path !== manifest.directories?.path ||
    actual.sha256 !== manifest.directories.sha256
  ) {
    throw new Error("Snapshot directory backup changed");
  }
  const directories = await selectedMigrationIO(nativeView, () =>
    IOUtils.readJSON(actual.path)
  );
  const expected = new Set();
  for (const root of manifest.inventory.roots) {
    if (!PathUtils.isAbsolute(root.canonicalPath)) {
      throw new Error("Invalid selected snapshot source");
    }
    const source = new FileUtils.File(root.canonicalPath);
    const covered = directories.roots.find(directory => {
      const parent = new FileUtils.File(directory.source);
      return parent.equals(source) || parent.contains(source);
    });
    const entries =
      covered?.entries.filter(
        entry =>
          PathUtils.join(covered.source, ...entry.parts) === root.canonicalPath
      ) ?? [];
    if (root.kind == "directory") {
      if (
        !covered ||
        (covered.source !== root.canonicalPath &&
          (entries.length !== 1 || entries[0].type !== "directory"))
      ) {
        throw new Error("Snapshot omits a selected directory");
      }
    } else if (root.kind == "file") {
      if (!covered) {
        expected.add(root.canonicalPath);
      } else if (
        root.exists
          ? entries.length !== 1 || entries[0].type !== "regular"
          : entries.length !== 0
      ) {
        throw new Error(
          "Directory backup omits selected metadata or its absence"
        );
      }
    } else {
      throw new Error("Unsupported selected snapshot root");
    }
  }
  for (const [index, entry] of manifest.externalFiles.entries()) {
    if (!expected.delete(entry.source) || typeof entry.exists != "boolean") {
      throw new Error("Duplicate or foreign snapshot metadata");
    }
    const descriptors = manifest.inventory.roots.filter(
      root => root.canonicalPath === entry.source
    );
    if (descriptors.some(root => root.exists !== entry.exists)) {
      throw new Error("Snapshot metadata absence changed");
    }
    if (entry.exists) {
      if (entry.file !== "file-" + index || !validMetadata(entry)) {
        throw new Error("Invalid snapshot metadata copy");
      }
      await verifyFile(
        PathUtils.join(bundle.path, "files", entry.file),
        entry,
        nativeView
      );
    } else if (entry.file !== undefined) {
      throw new Error("Absent snapshot metadata has a copy");
    }
  }
  if (expected.size) {
    throw new Error("Snapshot omits selected external metadata");
  }
}
