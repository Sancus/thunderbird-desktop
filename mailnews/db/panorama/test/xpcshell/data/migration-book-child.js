/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* globals migrationBookChildInput, print, quit */

/** @returns {Promise<void>} Actual native commit with its connection kept open. */
async function commitBook() {
  Services.prefs.setBoolPref("security.nocertdb", true);
  const { SQLiteDirectory } = ChromeUtils.importESModule(
    "resource:///modules/SQLiteDirectory.sys.mjs"
  );
  const { FileUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/FileUtils.sys.mjs"
  );
  globalThis.migrationBookStage = SQLiteDirectory.createMigrationStage(
    new FileUtils.File(migrationBookChildInput.stagingPath)
  );
  const receipt = SQLiteDirectory.importMorkSnapshot(
    globalThis.migrationBookStage,
    await IOUtils.read(migrationBookChildInput.source),
    migrationBookChildInput.token
  );
  print("BOOK-COMMITTED " + JSON.stringify(receipt));
}

let failed = false;
commitBook().catch(error => {
  console.error(error);
  failed = true;
});
// Success stays open until the parent's actual SIGKILL. On failure, leave the
// nested event loop before quit, so -f can propagate the original error status.
Services.tm.spinEventLoopUntil("TestMigrationBook:AwaitKill", () => failed);
quit(2);
