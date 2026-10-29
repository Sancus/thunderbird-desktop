/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { MigrationJournal } from "resource:///modules/panorama/MigrationJournal.sys.mjs";
import {
  getMigrationProfileState,
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
