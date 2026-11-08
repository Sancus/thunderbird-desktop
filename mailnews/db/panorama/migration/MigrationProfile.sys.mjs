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
 * @typedef {object} StartupMigrationProfileRecord
 * @property {2} formatVersion - Native startup selection format.
 * @property {"panorama"} backend - Selected native backend.
 * @property {string} origin - Empty initialization, adoption or migration.
 * @property {"prepared"|"active"|"restore-required"} state - Startup eligibility.
 * @property {{version: string, buildId: string}} application - Original reader floor.
 * @property {{profilePath: string, databaseSourceId: ?string,
 *   schemaVersion: ?number, journalPath: ?string, backup: ?object,
 *   imports: object[], books: object[], caches: object[]}} identity - Actual native
 *   incarnation and optional complete migration/recovery identities.
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
  if (record?.formatVersion === 2) {
    throw new Error("Startup profile activation requires its native operation");
  }
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
 * @returns {Promise<{state: string, record: MigrationProfileRecord|StartupMigrationProfileRecord|null}>} legacy, prepared,
 *   active or restore-required with its persisted format record.
 * @throws {Error} For corrupt/newer formats, unknown application metadata or
 *   a version/build older than the build that prepared the selector.
 */
export async function getMigrationProfileState(profilePath) {
  const profile = canonicalFile(profilePath);
  const record = await readProfileRecord(profile.path);
  if (record) {
    checkApplicationVersion(record);
    if (
      record.formatVersion === 2 &&
      record.origin === "migrated" &&
      record.state === "active"
    ) {
      await validateStartupRecoveryRecord(record);
    }
  }
  return { state: record?.state ?? "legacy", record };
}

/**
 * Validates the durable journal and identities of an active startup migration.
 * Reads no original Mork files and does not resume or rewrite migration work.
 * Core separately checks the retained native receipts before startup completes.
 * Recovery and restore verify the archive when they use its contents.
 *
 * @param {StartupMigrationProfileRecord} record - Validated active selector.
 * @returns {Promise<void>} Resolves when the durable recovery state matches.
 * @throws {Error} For missing, corrupt, cancelled or changed recovery state.
 */
async function validateStartupRecoveryRecord(
  record,
  journalPath = record.identity.journalPath
) {
  const identity = record.identity;
  startupProfileDirectory(PathUtils.parent(journalPath));
  const file = canonicalFile(journalPath);
  if ((await IOUtils.stat(file.path)).type !== "regular") {
    throw new Error("Startup recovery journal is not a regular file");
  }
  const state = await IOUtils.readJSON(file.path);
  if (
    state?.version !== 7 ||
    state.stage !== "complete" ||
    state.cancelled !== false ||
    state.profilePath !== identity.profilePath ||
    state.startup?.bound !== true ||
    state.startup.databaseSourceId !== identity.databaseSourceId ||
    !Array.isArray(state.sources) ||
    !Array.isArray(state.books ?? []) ||
    !Array.isArray(state.caches ?? []) ||
    JSON.stringify(state.backup) !== JSON.stringify(identity.backup)
  ) {
    throw new Error("Startup recovery journal is incomplete or changed");
  }
  const imports = state.sources.map(source => ({
    id: source.id,
    token: source.token,
    sha256: source.sha256,
    folderId: source.destinationFolderId,
    receipt: source.receipt,
  }));
  const books = (state.books ?? []).map(book => ({
    id: book.id,
    token: book.token,
    sha256: book.sha256,
    receipt: book.receipt,
    publication: book.publication?.receipt,
  }));
  const caches = (state.caches ?? []).map(cache => ({
    id: cache.id,
    token: cache.token,
    sha256: cache.sha256,
    receipt: cache.receipt,
  }));
  for (const [name, units] of Object.entries({ imports, books, caches })) {
    if (JSON.stringify(units) !== JSON.stringify(identity[name])) {
      throw new Error("Startup recovery journal changed committed units");
    }
  }
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
async function readProfileRecord(profilePath, identityPath = profilePath) {
  const path = PathUtils.join(profilePath, PROFILE_FILE);
  canonicalFile(path);
  if (!(await IOUtils.exists(path))) {
    return null;
  }
  if ((await IOUtils.stat(path)).type != "regular") {
    throw new Error("Migration profile record is not a regular file");
  }
  const record = await IOUtils.readJSON(path);
  if (record?.formatVersion === 2) {
    return validateStartupProfileRecord(record, identityPath);
  }
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
      new FileUtils.File(identityPath)
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

/**
 * Writes the pending native migration selection before target creation.
 * Existing selectors are never replaced. The journal and backup must already
 * exist, and the native startup operation must retain ordinary writer exclusion.
 *
 * @param {string} profilePath - Actual startup-selected profile.
 * @param {string} journalPath - Retained startup journal outside the profile.
 * @param {{path: string, sha256: string}} backup - Verified complete backup.
 * @returns {Promise<object>} Durable prepared format2 record.
 * @throws {Error} For an occupied selector, invalid backup or journal identity.
 */
export async function prepareStartupMigrationProfile(
  profilePath,
  journalPath,
  backup
) {
  const profile = startupProfileDirectory(profilePath);
  if (await readProfileRecord(profile.path)) {
    throw new Error("An existing Panorama selection requires recovery");
  }
  const journal = await MigrationJournal.open(journalPath, profile.path);
  try {
    if (
      journal.state.version !== 7 ||
      journal.state.stage !== "backup" ||
      journal.state.cancelled ||
      PathUtils.join(journal.state.backupPath, "manifest.json") !== backup.path
    ) {
      throw new Error("Startup selection requires its pending migration plan");
    }
    const actual = await verifyMigrationBackup(journal.state.backupPath);
    if (actual.path !== backup.path || actual.sha256 !== backup.sha256) {
      throw new Error("Startup backup identity changed");
    }
    const record = startupProfileRecord(profile.path, "migrated", {
      databaseSourceId: null,
      schemaVersion: null,
      journalPath,
      backup: structuredClone(backup),
      imports: [],
      books: [],
      caches: [],
      serverSummaries: [],
    });
    await IOUtils.writeJSON(
      PathUtils.join(profile.path, PROFILE_FILE),
      record,
      {
        mode: "create",
        flush: true,
      }
    );
    return record;
  } finally {
    journal.close();
  }
}

/**
 * Persists the native backend and version after complete import readback.
 * Core independently reads this durable record before admitting normal startup.
 * This function does not release the native operation or XRE's profile lock.
 *
 * @param {nsIDatabaseCore} core - Actual target service.
 * @param {nsISupports} operation - Native-owned selected startup operation.
 * @param {"initialized-empty"|"adopted-existing"|"migrated"} origin - Selection.
 * @param {MigrationJournal} [journal] - Validated complete migration journal.
 * @returns {Promise<object>} Durable active backend/version record.
 * @throws {Error} For incomplete work, changed native identity or downgrade.
 */
export async function activateStartupMigrationProfile(
  core,
  operation,
  origin,
  journal
) {
  const database = core.QueryInterface(Ci.nsIDatabaseCore);
  const selected = database.validateProfileStartup(operation);
  const profile = startupProfileDirectory(selected.profilePath);
  let record = await readProfileRecord(profile.path);
  checkApplicationVersion(
    record ?? { application: currentStartupApplication() }
  );
  if (
    selected.phase !== "target-open" ||
    !selected.databaseSourceId ||
    selected.databaseSourceId !== database.sourceId ||
    !Number.isSafeInteger(selected.schemaVersion)
  ) {
    throw new Error("Startup target is not ready for profile activation");
  }
  const identity = {
    databaseSourceId: selected.databaseSourceId,
    schemaVersion: selected.schemaVersion,
    journalPath: null,
    backup: null,
    imports: [],
    books: [],
    caches: [],
    serverSummaries: [],
  };
  if (origin === "migrated") {
    if (!(journal instanceof MigrationJournal)) {
      throw new TypeError("A validated startup migration journal is required");
    }
    const state = journal.state;
    if (
      state.version !== 7 ||
      state.profilePath !== profile.path ||
      state.startup.databaseSourceId !== selected.databaseSourceId ||
      state.cancelled ||
      !["activate", "complete"].includes(state.stage) ||
      record?.formatVersion !== 2 ||
      record.origin !== origin ||
      record.identity.backup?.sha256 !== state.backup?.sha256
    ) {
      throw new Error("Startup migration has not completed native validation");
    }
    identity.journalPath = record.identity.journalPath;
    identity.backup = structuredClone(state.backup);
    identity.serverSummaries = structuredClone(
      state.startup.serverSummaries ?? []
    );
    identity.imports = state.sources.map(source => ({
      id: source.id,
      token: source.token,
      sha256: source.sha256,
      folderId: source.destinationFolderId,
      receipt: structuredClone(source.receipt),
    }));
    identity.books = (state.books ?? []).map(book => ({
      id: book.id,
      token: book.token,
      sha256: book.sha256,
      receipt: structuredClone(book.receipt),
      publication: structuredClone(book.publication?.receipt),
    }));
    identity.caches = (state.caches ?? []).map(cache => ({
      id: cache.id,
      token: cache.token,
      sha256: cache.sha256,
      receipt: structuredClone(cache.receipt),
    }));
  } else if (!["initialized-empty", "adopted-existing"].includes(origin)) {
    throw new Error("Unsupported native profile origin");
  }
  if (record) {
    if (
      record.formatVersion !== 2 ||
      record.origin !== origin ||
      record.state === "restore-required" ||
      (record.identity.databaseSourceId !== null &&
        record.identity.databaseSourceId !== identity.databaseSourceId)
    ) {
      throw new Error("Existing native profile selection requires recovery");
    }
    if (record.state === "active") {
      if (
        JSON.stringify(record.identity) !==
        JSON.stringify({ profilePath: profile.path, ...identity })
      ) {
        throw new Error("Active native profile identity changed");
      }
      return record;
    }
    record.identity = { profilePath: profile.path, ...identity };
  } else {
    record = startupProfileRecord(profile.path, origin, identity);
    await IOUtils.writeJSON(
      PathUtils.join(profile.path, PROFILE_FILE),
      record,
      {
        mode: "create",
        flush: true,
      }
    );
  }
  database.validateProfileStartup(operation);
  if (journal?.state.stage === "activate") {
    await journal.finishStage("activate");
  }
  record.state = "active";
  validateStartupProfileRecord(record, profile.path);
  await saveProfileRecord(profile.path, record);
  database.validateProfileStartup(operation);
  return record;
}

/**
 * Blocks a just-published selection after failed native final readback.
 * Keeps its original application floor, native identities and recovery inputs.
 *
 * @param {string} profilePath - Startup-selected profile.
 * @returns {Promise<void>} Durable recovery selection, when one exists.
 */
export async function requireStartupProfileRecovery(profilePath) {
  const profile = startupProfileDirectory(profilePath);
  const record = await readProfileRecord(profile.path);
  if (record?.formatVersion === 2) {
    checkApplicationVersion(record);
    record.state = "restore-required";
    await saveProfileRecord(profile.path, record);
  }
}

/** @returns {{version: string, buildId: string}} Current checked version floor. */
function currentStartupApplication() {
  const application = {
    version: Services.appinfo.version,
    buildId: Services.appinfo.appBuildID,
  };
  applicationBuildTime(application);
  return application;
}

/**
 * Constructs a prepared format2 record without a fictitious legacy import.
 *
 * @param {string} profilePath - Actual selected root.
 * @param {string} origin - Native initialization, adoption or migration.
 * @param {object} identity - Native and optional migration identities.
 * @returns {object} Validated prepared record.
 */
function startupProfileRecord(profilePath, origin, identity) {
  const record = {
    formatVersion: 2,
    backend: "panorama",
    origin,
    state: "prepared",
    application: currentStartupApplication(),
    identity: { profilePath, ...identity },
  };
  return validateStartupProfileRecord(record, profilePath);
}

/**
 * Validates native selection metadata without opening a writable database.
 *
 * @param {object} record - Persisted format2 selection.
 * @param {string} profilePath - Expected selected physical profile.
 * @returns {object} The unchanged validated record.
 * @throws {Error} For unknown formats, inconsistent origins or partial identity.
 */
function validateStartupProfileRecord(record, profilePath) {
  const identity = record.identity;
  const serverSummaries =
    identity?.serverSummaries === undefined ? [] : identity.serverSummaries;
  const pending = record.state !== "active" && record.origin === "migrated";
  if (
    record.backend !== "panorama" ||
    !["initialized-empty", "adopted-existing", "migrated"].includes(
      record.origin
    ) ||
    !["prepared", "active", "restore-required"].includes(record.state) ||
    !identity ||
    identity.profilePath !== profilePath ||
    !PathUtils.isAbsolute(profilePath) ||
    typeof record.application?.version !== "string" ||
    typeof record.application?.buildId !== "string" ||
    ![identity.imports, identity.books, identity.caches, serverSummaries].every(
      Array.isArray
    ) ||
    (!(
      pending &&
      identity.databaseSourceId === null &&
      identity.schemaVersion === null
    ) &&
      (typeof identity.databaseSourceId !== "string" ||
        !identity.databaseSourceId ||
        identity.databaseSourceId.includes("\0") ||
        !Number.isSafeInteger(identity.schemaVersion) ||
        identity.schemaVersion < 0))
  ) {
    throw new Error("Invalid or unsupported native profile format");
  }
  if (record.origin === "migrated") {
    if (
      typeof identity.journalPath !== "string" ||
      !PathUtils.isAbsolute(identity.journalPath) ||
      !identity.backup ||
      typeof identity.backup.path !== "string" ||
      !PathUtils.isAbsolute(identity.backup.path) ||
      !/^[a-f0-9]{64}$/.test(identity.backup.sha256)
    ) {
      throw new Error("Native migration profile has no recovery identity");
    }
  } else if (
    identity.journalPath !== null ||
    identity.backup !== null ||
    identity.imports.length ||
    identity.books.length ||
    identity.caches.length ||
    serverSummaries.length
  ) {
    throw new Error("Native initialization must not invent migration receipts");
  }
  const ids = new Set();
  const tokens = new Set();
  for (const unit of [
    ...identity.imports,
    ...identity.books,
    ...identity.caches,
  ]) {
    if (
      typeof unit.id !== "string" ||
      !unit.id ||
      ids.has(unit.id) ||
      typeof unit.token !== "string" ||
      !unit.token ||
      tokens.has(unit.token) ||
      !/^[a-f0-9]{64}$/.test(unit.sha256) ||
      !unit.receipt ||
      (identity.imports.includes(unit) &&
        (!Number.isSafeInteger(unit.folderId) || unit.folderId <= 0)) ||
      (identity.books.includes(unit) && !unit.publication)
    ) {
      throw new Error("Invalid native profile committed-unit identity");
    }
    ids.add(unit.id);
    tokens.add(unit.token);
  }
  const rootIds = new Set();
  for (const binding of serverSummaries) {
    if (
      typeof binding.sourceId !== "string" ||
      !binding.sourceId ||
      ids.has(binding.sourceId) ||
      !Number.isSafeInteger(binding.folderId) ||
      binding.folderId <= 0 ||
      rootIds.has(binding.folderId) ||
      identity.imports.some(unit => unit.folderId === binding.folderId)
    ) {
      throw new Error("Invalid native profile server-root binding");
    }
    ids.add(binding.sourceId);
    rootIds.add(binding.folderId);
  }
  return record;
}

/**
 * Rejects links in every component of a startup profile path.
 *
 * @param {string} path - Absolute selected profile root.
 * @returns {nsIFile} Canonical existing directory.
 */
function startupProfileDirectory(path) {
  const file = canonicalFile(path);
  for (
    let component = new FileUtils.File(path);
    component;
    component = component.parent
  ) {
    if (component.isSymlink()) {
      throw new Error("Startup profile path contains a link");
    }
  }
  if (!file.isDirectory()) {
    throw new Error("Startup profile is not a directory");
  }
  return file;
}

/**
 * Validates an archived selector at its original path and pins its dependencies.
 *
 * @param {string} profilePath - Original selected profile directory.
 * @param {string} archivedProfilePath - Verified archive's profile root.
 * @param {{source: string, archived: string}[]} roots - Complete restore roots.
 * @returns {Promise<{record: object|null, dependencies: object[]}>} Pins.
 * @throws {Error} For unsupported selectors or missing/conflicting dependencies.
 */
export async function getMigrationRestoreDependencies(
  profilePath,
  archivedProfilePath,
  roots
) {
  const record = await readProfileRecord(archivedProfilePath, profilePath);
  if (!record) {
    return { record: null, dependencies: [] };
  }
  checkApplicationVersion(record);
  if (record.formatVersion === 2 && record.origin !== "migrated") {
    return { record, dependencies: [] };
  }
  const identity = record.identity;
  const original = canonicalFile(identity.journalPath);
  let journalPath = original.path;
  for (const root of roots) {
    const directory = new FileUtils.File(root.source);
    if (directory.contains(original)) {
      const archived = new FileUtils.File(root.archived);
      archived.setRelativePath(
        archived.clone(),
        original.getRelativePath(directory)
      );
      journalPath = archived.path;
    }
  }
  // Sibling journals must describe the archived selector; nothing resumes.
  startupProfileDirectory(PathUtils.parent(journalPath));
  const file = canonicalFile(journalPath);
  if ((await IOUtils.stat(file.path)).type !== "regular") {
    throw new Error("Restore journal is not a regular file");
  }
  const journalSha256 = await IOUtils.computeHexDigest(file.path, "sha256");
  const state = await IOUtils.readJSON(file.path);
  if (
    state.profilePath !== profilePath ||
    !["activate", "complete"].includes(state.stage) ||
    JSON.stringify(state.backup) !== JSON.stringify(identity.backup) ||
    !Array.isArray(state.sources) ||
    state.sources.length !== identity.imports.length ||
    identity.imports.some(
      unit =>
        !state.sources.some(
          source =>
            source.id === unit.id &&
            source.token === unit.token &&
            source.sha256 === unit.sha256 &&
            source.destinationFolderId === unit.folderId &&
            source.state === "imported"
        )
    )
  ) {
    throw new Error("Restore selector and journal identities conflict");
  }
  if (record.formatVersion === 2) {
    await validateStartupRecoveryRecord(record, file.path);
  }
  const backup = await verifyMigrationBackup(
    PathUtils.parent(identity.backup.path)
  );
  if (JSON.stringify(backup) !== JSON.stringify(identity.backup)) {
    throw new Error("Restore selector backup identity changed");
  }
  if (journalSha256 !== (await IOUtils.computeHexDigest(file.path, "sha256"))) {
    throw new Error("Restore journal changed during validation");
  }
  return {
    record,
    dependencies: [
      {
        kind: "file",
        path: original.path,
        sourcePath: file.path,
        size: (await IOUtils.stat(file.path)).size,
        sha256: journalSha256,
      },
      { kind: "archive", ...backup },
    ],
  };
}
