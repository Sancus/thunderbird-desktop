/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* globals migrationBackupChildInput, print, quit */

/**
 * Waits after the real move or manifest flush, before the caller can continue.
 *
 * @param {string} path - Actual completed output path.
 */
function pauseBackup(path) {
  print("BACKUP-PAUSED " + JSON.stringify({ path }));
  Services.tm.spinEventLoopUntil("TestMigrationBackup:AwaitKill", () => false);
}

/** @returns {Promise<void>} Actual backup paused at the selected durable write. */
async function runBackup() {
  Services.prefs.setBoolPref("security.nocertdb", true);
  const { createMigrationBackup } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MigrationBackup.sys.mjs"
  );
  const backupIO = Cu.getGlobalForObject(createMigrationBackup).IOUtils;
  const move = backupIO.move.bind(backupIO);
  const writeJSON = backupIO.writeJSON.bind(backupIO);
  backupIO.move = async (...args) => {
    await move(...args);
    if (!migrationBackupChildInput.complete) {
      pauseBackup(args[1]);
    }
  };
  backupIO.writeJSON = async (path, value, options) => {
    await writeJSON(path, value, options);
    if (value.complete === true && migrationBackupChildInput.complete) {
      pauseBackup(path);
    }
  };
  await createMigrationBackup(
    migrationBackupChildInput.profilePath,
    migrationBackupChildInput.mailPaths,
    migrationBackupChildInput.backupPath
  );
  throw new Error("Backup returned without reaching the selected boundary");
}

let failed = false;
runBackup().catch(error => {
  console.error(error);
  failed = true;
});
Services.tm.spinEventLoopUntil("TestMigrationBackup:Run", () => failed);
quit(2);
