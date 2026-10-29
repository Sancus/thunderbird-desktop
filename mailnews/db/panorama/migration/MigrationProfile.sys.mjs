/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { FileUtils } from "resource://gre/modules/FileUtils.sys.mjs";
import { MigrationJournal } from "resource:///modules/panorama/MigrationJournal.sys.mjs";
import {
  stageMigrationRestore,
  verifyMigrationBackup,
} from "resource:///modules/panorama/MigrationBackup.sys.mjs";

const FORMAT_VERSION = 1;
const PROFILE_FILE = "panorama-profile.json";

/**
 * @typedef {object} MigrationProfileRecord
 * @property {number} formatVersion - On-disk Panorama format.
 * @property {"prepared"|"active"|"restore-required"} state - Startup eligibility.
 * @property {{version: string, buildId: string}} application - First preparing build;
 *   minimum reader version, then minimum date for comparator-equal versions.
 * @property {{profilePath: string, journalPath: string,
 *   backup: {path: string, sha256: string},
 *   imports: {id: string, token: string, sha256: string, folderId: number}[]}} identity -
 *   Original profile, complete backup and committed folder operation identities.
 */

/**
 * Publishes an in-place profile format after journal validation.
 * Writes prepared state before completing the journal, then active state.
 * A prepared record blocks normal startup until this operation resumes.
 * Existing selector/current application metadata is checked before journal work.
 * Requires the profile lock, quiesced writers and startup's legacy-version
 * guard. This module cannot make older executables understand the new format.
 *
 * @param {string} journalPath - Absolute journal outside the source trees.
 * @param {string} profilePath - Original, already validated profile directory.
 * @returns {Promise<MigrationProfileRecord>} Persisted active format record.
 * @throws {Error} For cancelled/incomplete work, mismatched records or IO errors.
 */
export async function activateMigrationProfile(journalPath, profilePath) {
  const profile = canonicalFile(profilePath);
  let record = await readProfileRecord(profile.path);
  const application = {
    version: Services.appinfo.version,
    buildId: Services.appinfo.appBuildID,
  };
  checkApplicationVersion(record ?? { application });
  const file = canonicalFile(journalPath);
  const journal = await MigrationJournal.open(file.path, profile.path);
  try {
    const state = journal.state;
    if (state.cancelled || !["activate", "complete"].includes(state.stage)) {
      throw new Error("Migration profile has not completed validation");
    }
    const identity = {
      profilePath: state.profilePath,
      journalPath: file.path,
      backup: state.backup,
      imports: state.sources.map(source => ({
        id: source.id,
        token: source.token,
        sha256: source.sha256,
        folderId: source.destinationFolderId,
      })),
    };
    if (record) {
      if (
        JSON.stringify(record.identity) != JSON.stringify(identity) ||
        record.state == "restore-required" ||
        (record.state == "active" && state.stage != "complete")
      ) {
        throw new Error(
          "Migration profile identity or activation state changed"
        );
      }
    } else {
      if (state.stage != "activate") {
        throw new Error("Completed migration has no prepared profile record");
      }
      record = {
        formatVersion: FORMAT_VERSION,
        state: "prepared",
        application,
        identity,
      };
      await IOUtils.writeJSON(
        PathUtils.join(profile.path, PROFILE_FILE),
        record,
        {
          mode: "create",
          flush: true,
        }
      );
    }
    if (state.stage == "activate") {
      await journal.finishStage("activate");
    }
    if (record.state != "active") {
      record.state = "active";
      await saveProfileRecord(profile.path, record);
    }
    return record;
  } finally {
    journal.close();
  }
}

/**
 * Reads the profile selector before opening writable application services.
 * Prepared and restore-required records must not start normal mail operation.
 * Absence identifies an unconverted profile, not a successful migration.
 *
 * @param {string} profilePath - Profile directory selected by startup.
 * @returns {Promise<{state: string, record: MigrationProfileRecord|null}>} legacy, prepared,
 *   active or restore-required with its persisted format record.
 * @throws {Error} For corrupt/newer formats, unknown application metadata or
 *   a version/build older than the build that prepared the selector.
 */
export async function getMigrationProfileState(profilePath) {
  const profile = canonicalFile(profilePath);
  const record = await readProfileRecord(profile.path);
  if (record) {
    checkApplicationVersion(record);
  }
  return { state: record?.state ?? "legacy", record };
}

/**
 * Stages a full backup before blocking this profile for recovery.
 * Preserves subsequent live writes; never switches or overwrites live roots.
 * Requires quiesced writers. Startup must remain blocked until an explicit
 * external-store/profile cutover restores the returned directory mappings.
 *
 * @param {string} profilePath - Profile containing its format record.
 * @param {string} parentPath - Fresh staging parent outside source/backup trees.
 * @returns {Promise<{path: string, roots: {original: string, staged: string}[]}>}
 *   Verified staged backup. A failure leaves all live data in place.
 * @throws {Error} For a missing format, invalid backup or IO failure.
 */
export async function stageMigrationProfileRestore(profilePath, parentPath) {
  const profile = canonicalFile(profilePath);
  const record = await readProfileRecord(profile.path);
  if (!record) {
    throw new Error("Profile has no migration backup record");
  }
  checkApplicationVersion(record);
  const backupPath = PathUtils.parent(record.identity.backup.path);
  const verified = await verifyMigrationBackup(backupPath);
  if (record.identity.backup.sha256 != verified.sha256) {
    throw new Error("Profile backup identity changed");
  }
  const restored = await stageMigrationRestore(backupPath, parentPath);
  const after = await verifyMigrationBackup(backupPath);
  if (
    !new FileUtils.File(restored.roots[0].original).equals(profile) ||
    record.identity.backup.sha256 != after.sha256
  ) {
    throw new Error("Profile backup identity changed");
  }
  record.state = "restore-required";
  await saveProfileRecord(profile.path, record);
  return restored;
}

/**
 * Reads and validates a selector without consulting old databases.
 *
 * @param {string} profilePath - Normalized original profile directory.
 * @returns {Promise<MigrationProfileRecord|null>} Record, or null before conversion.
 * @throws {Error} For unsupported, incomplete or misdirected records.
 */
async function readProfileRecord(profilePath) {
  const path = PathUtils.join(profilePath, PROFILE_FILE);
  canonicalFile(path);
  if (!(await IOUtils.exists(path))) {
    return null;
  }
  if ((await IOUtils.stat(path)).type != "regular") {
    throw new Error("Migration profile record is not a regular file");
  }
  const record = await IOUtils.readJSON(path);
  const identity = record?.identity;
  if (
    record?.formatVersion != FORMAT_VERSION ||
    !["prepared", "active", "restore-required"].includes(record.state) ||
    typeof record.application?.version != "string" ||
    typeof record.application?.buildId != "string" ||
    !identity ||
    typeof identity.profilePath != "string" ||
    !PathUtils.isAbsolute(identity.profilePath) ||
    !new FileUtils.File(identity.profilePath).equals(
      new FileUtils.File(profilePath)
    ) ||
    !PathUtils.isAbsolute(identity.journalPath) ||
    !identity.backup ||
    !PathUtils.isAbsolute(identity.backup.path) ||
    typeof identity.backup.sha256 != "string" ||
    !/^[a-f0-9]{64}$/.test(identity.backup.sha256) ||
    !Array.isArray(identity.imports)
  ) {
    throw new Error("Invalid or unsupported migration profile format");
  }
  const ids = new Set();
  const tokens = new Set();
  const folders = new Set();
  for (const source of identity.imports) {
    if (
      typeof source.id != "string" ||
      !source.id ||
      ids.has(source.id) ||
      typeof source.token != "string" ||
      !source.token ||
      tokens.has(source.token) ||
      typeof source.sha256 != "string" ||
      !/^[a-f0-9]{64}$/.test(source.sha256) ||
      !Number.isSafeInteger(source.folderId) ||
      source.folderId <= 0 ||
      folders.has(source.folderId)
    ) {
      throw new Error("Invalid migration profile import identity");
    }
    ids.add(source.id);
    tokens.add(source.token);
    folders.add(source.folderId);
  }
  return record;
}

/**
 * Enforces the first preparing build as a minimum, without updating the record.
 * Gecko's compatibility.ini downgrade guard compares only major versions.
 * This compares the full product version, then the build date for equal versions.
 * It does not make older executables consult this selector.
 *
 * @param {{application: {version: string, buildId: string}}} record - Preparing build.
 * @throws {Error} For unknown metadata or an older application version/build.
 */
function checkApplicationVersion(record) {
  const current = {
    version: Services.appinfo.version,
    buildId: Services.appinfo.appBuildID,
  };
  const previousBuild = applicationBuildTime(record.application);
  const currentBuild = applicationBuildTime(current);
  const order = Services.vc.compare(
    current.version,
    record.application.version
  );
  if (order < 0 || (order == 0 && currentBuild < previousBuild)) {
    throw new Error(
      "Migration profile requires a compatible application version and build"
    );
  }
}

/**
 * Validates release/prerelease product versions and generated YYYYMMDDhhmmss IDs.
 * Unknown custom formats need an explicit compatibility decision, not coercion.
 *
 * @param {{version: string, buildId: string}} application - Current/preparing metadata.
 * @returns {number} Calendar build time for equal-version comparison.
 * @throws {Error} For malformed, unsupported or comparator-overflowing metadata.
 */
function applicationBuildTime(application) {
  const { version, buildId } = application;
  if (
    typeof version != "string" ||
    !/^\d+\.\d+(?:\.\d+){0,2}(?:a[12]|b[1-9]\d*|rc[1-9]\d*|esr)?$/.test(
      version
    ) ||
    version.match(/\d+/g).some(part => Number(part) > 0x7fffffff) ||
    typeof buildId != "string" ||
    !/^\d{14}$/.test(buildId)
  ) {
    throw new Error("Migration profile has unknown application metadata");
  }
  const date = new Date(
    `${buildId.slice(0, 4)}-${buildId.slice(4, 6)}-${buildId.slice(6, 8)}T` +
      `${buildId.slice(8, 10)}:${buildId.slice(10, 12)}:${buildId.slice(12, 14)}Z`
  );
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().replace(/\D/g, "").slice(0, 14) !== buildId
  ) {
    throw new Error("Migration profile has unknown application metadata");
  }
  return date.getTime();
}

/** @param {string} path - Absolute path. @returns {nsIFile} Normalized path with an unlinked leaf. */
function canonicalFile(path) {
  if (!PathUtils.isAbsolute(path)) {
    throw new Error("Migration profile path must be absolute");
  }
  const file = new FileUtils.File(path);
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
    throw new Error("Migration profile path contains a link");
  }
  file.normalize();
  return file;
}

/**
 * Flushes a selector replacement without changing profile or store directories.
 *
 * @param {string} profilePath - Original profile directory.
 * @param {MigrationProfileRecord} record - Validated selector.
 * @returns {Promise<void>}
 */
async function saveProfileRecord(profilePath, record) {
  const path = PathUtils.join(profilePath, PROFILE_FILE);
  canonicalFile(path);
  await IOUtils.writeJSON(path, record, {
    tmpPath: path + ".tmp",
    flush: true,
  });
}
