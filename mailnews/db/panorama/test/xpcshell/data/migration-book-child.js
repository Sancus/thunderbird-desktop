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
  if (migrationBookChildInput.pauseAfterIntent) {
    const { MigrationJournal } = ChromeUtils.importESModule(
      "resource:///modules/panorama/MigrationJournal.sys.mjs"
    );
    globalThis.migrationBookJournal = await MigrationJournal.open(
      migrationBookChildInput.journalPath,
      migrationBookChildInput.profilePath
    );
    const token =
      await globalThis.migrationBookJournal.beginBookImport("original-book");
    print("BOOK-INTENT " + JSON.stringify({ token }));
    Services.tm.spinEventLoopUntil(
      "TestMigrationBook:KillAfterIntent",
      () => false
    );
  }
  globalThis.migrationBookStage = SQLiteDirectory.createMigrationStage(
    new FileUtils.File(migrationBookChildInput.stagingPath)
  );
  if (migrationBookChildInput.pauseDuringWrite) {
    globalThis.migrationBookStage.createFunction("book_write_boundary", 0, {
      onFunctionCall() {
        if (!globalThis.migrationBookStage.transactionInProgress) {
          throw new Error("Expected the native book import transaction");
        }
        print("BOOK-WRITING");
        Services.tm.spinEventLoopUntil(
          "TestMigrationBook:KillDuringWrite",
          () => false
        );
        return 0;
      },
    });
    globalThis.migrationBookStage.executeSimpleSQL(`
      CREATE TEMP TRIGGER book_write_boundary BEFORE INSERT ON properties
      BEGIN SELECT book_write_boundary(); END;
    `);
  }
  const receipt = SQLiteDirectory.importMorkSnapshot(
    globalThis.migrationBookStage,
    await IOUtils.read(migrationBookChildInput.source),
    migrationBookChildInput.token
  );
  if (migrationBookChildInput.checkpointJournal) {
    const { MigrationJournal } = ChromeUtils.importESModule(
      "resource:///modules/panorama/MigrationJournal.sys.mjs"
    );
    globalThis.migrationBookJournal = await MigrationJournal.open(
      migrationBookChildInput.journalPath,
      migrationBookChildInput.profilePath
    );
    const book = globalThis.migrationBookJournal.state.books.find(
      item => item.id == "original-book"
    );
    const actualStage = globalThis.migrationBookStage.databaseFile.clone();
    actualStage.normalize();
    if (
      !book ||
      book.token !== migrationBookChildInput.token ||
      !actualStage.equals(new FileUtils.File(book.stagingPath))
    ) {
      throw new Error("Actual child stage differs from the retained book plan");
    }
    await globalThis.migrationBookJournal.recordBookImport("original-book", {
      token: migrationBookChildInput.token,
      sourceId: "original-book",
      storageSourceId: receipt.sourceId,
      sourceSha256: receipt.sourceSha256,
      sourceSize: receipt.sourceSize,
      stagingPath: book.stagingPath,
      cards: receipt.cards,
      lists: receipt.lists,
    });
    if (migrationBookChildInput.finishImportStage) {
      await globalThis.migrationBookJournal.finishStage("import");
      print("BOOK-IMPORT-SETTLED " + JSON.stringify(receipt));
    } else {
      print("BOOK-CHECKPOINTED " + JSON.stringify(receipt));
    }
  } else {
    print("BOOK-COMMITTED " + JSON.stringify(receipt));
  }
}

let failed = false;
commitBook().catch(error => {
  console.error(error);
  try {
    globalThis.migrationBookJournal?.close();
  } catch (closeError) {
    console.error("Could not close failed child book journal", closeError);
  }
  try {
    globalThis.migrationBookStage?.close();
  } catch (closeError) {
    console.error("Could not close failed child book stage", closeError);
  }
  failed = true;
});
// Success stays open until the parent's actual SIGKILL. On failure, leave the
// nested event loop before quit, so -f can propagate the original error status.
Services.tm.spinEventLoopUntil("TestMigrationBook:AwaitKill", () => failed);
quit(2);
