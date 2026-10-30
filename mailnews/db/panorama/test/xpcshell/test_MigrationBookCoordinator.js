/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
const { SQLiteDirectory } = ChromeUtils.importESModule(
  "resource:///modules/SQLiteDirectory.sys.mjs"
);
const { MigrationJournal } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationJournal.sys.mjs"
);
const { createMigrationBackup, verifyMigrationBackup } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MigrationBackup.sys.mjs"
  );
const { readMorkAddressBookSource } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationSource.sys.mjs"
);
const { resumeMorkBookImports } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationCoordinator.sys.mjs"
);
const MAB_FILE = "import.mab";
const unixOnly = () => ({ skip_if: () => AppConstants.platform == "win" });
let home;
let profiles;
let serial = 0;

add_setup(async function setupNativeProfiles() {
  do_get_profile();
  const { updateAppInfo } = ChromeUtils.importESModule(
    "resource://testing-common/AppInfo.sys.mjs"
  );
  updateAppInfo({ name: "XPCShell", version: "1.0" });
  const provider = Cc["@mozilla.org/xre/directory-provider;1"]
    .getService(Ci.nsIDirectoryServiceProvider)
    .QueryInterface(Ci.nsIXREDirProvider);
  for (const key of ["DefProfRt", "DefProfLRt", "UAppData"]) {
    Services.dirsvc.set(key, provider.getFile(key, {}).clone());
  }
  profiles = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
    Ci.nsIToolkitProfileService
  );
  home = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "migration-book-"
  );
  registerCleanupFunction(() => IOUtils.remove(home, { recursive: true }));
});

/**
 * @param {boolean} [withMail=false] - Also plan a genuine pending mail folder.
 * @returns {Promise<object>} Genuine input, backup and actual held profile lock.
 */
async function bookInput(withMail = false) {
  const name = "migration-book-" + ++serial;
  const root = PathUtils.join(home, name);
  await IOUtils.makeDirectory(root);
  const profile = profiles.createProfile(
    new FileUtils.File(PathUtils.join(root, "profile")),
    name,
    "tests"
  );
  const lock = profile.lock({});
  registerCleanupFunction(() => {
    lock.unlock();
    profile.remove(false);
  });
  const profilePath = lock.directory.path;
  const source = PathUtils.join(profilePath, "abook.mab");
  const bytes = await IOUtils.read(do_get_file(MAB_FILE).path);
  await IOUtils.copy(do_get_file(MAB_FILE).path, source);
  const { identity } = await readMorkAddressBookSource(source);
  const stagingPath = PathUtils.join(root, "abook.sqlite");
  const path = PathUtils.join(root, "journal.json");
  const backupPath = PathUtils.join(root, "backup");
  const input = {
    root,
    profile,
    lock,
    profilePath,
    source,
    bytes,
    stagingPath,
    path,
    backupPath,
  };
  const sources = [];
  if (withMail) {
    const summary = PathUtils.join(profilePath, "Inbox.msf");
    await IOUtils.copy(do_get_file("data/migration.msf").path, summary);
    await IOUtils.copy(
      do_get_file("data/migration").path,
      PathUtils.join(profilePath, "Inbox")
    );
    sources.push({
      id: "folder-source",
      path: summary,
      size: (await IOUtils.stat(summary)).size,
      sha256: await IOUtils.computeHexDigest(summary, "sha256"),
      messageKeys: [1, 3],
      destinationFolderId: 9,
    });
  }
  input.journal = await MigrationJournal.create(path, {
    profilePath,
    mailPaths: [],
    backupPath,
    sources,
    books: [{ id: "original-book", ...identity, stagingPath }],
  });
  registerCleanupFunction(() => input.journal.close());
  input.backup = await createMigrationBackup(profilePath, [], backupPath);
  await input.journal.recordBackup(input.backup);
  return input;
}

/** @param {object} input - Planned book. @returns {mozIStorageConnection} Owned stage reader. */
function openStage(input) {
  return Services.storage.openUnsharedDatabase(
    new FileUtils.File(input.stagingPath)
  );
}

/** @param {mozIStorageConnection} db - Stage. @param {string} sql - Fixed query. @returns {string[][]} Rows. */
function rows(db, sql) {
  const statement = db.createStatement(sql);
  try {
    const result = [];
    while (statement.executeStep()) {
      result.push(
        Array.from({ length: statement.columnCount }, (_, i) =>
          statement.getUTF8String(i)
        )
      );
    }
    return result;
  } finally {
    statement.finalize();
  }
}

/** @param {object} input - Imported book. @returns {Promise<void>} Original and backup checks. */
async function assertOriginals(input) {
  Assert.deepEqual(await IOUtils.read(input.source), input.bytes);
  Assert.deepEqual(await IOUtils.read(do_get_file(MAB_FILE).path), input.bytes);
  Assert.deepEqual(await verifyMigrationBackup(input.backupPath), input.backup);
}

add_task(unixOnly(), async function test_bookCheckpointAndExactSourceMaps() {
  const input = await bookInput();
  Assert.equal(input.journal.state.version, 2);
  await resumeMorkBookImports(input.journal, input.lock);
  const state = input.journal.state;
  Assert.deepEqual(state.sources, [], "Book maps are not mail receipts");
  Assert.equal(state.stage, "validate");
  const book = state.books[0];
  const receipt = book.receipt;
  Assert.equal(book.state, "imported");
  Assert.equal(receipt.sourceId, "original-book");
  Assert.equal(receipt.storageSourceId, book.token);
  Assert.equal(receipt.sourceSha256, book.sha256);
  Assert.equal(receipt.sourceSize, input.bytes.length);
  const expectedStage = new FileUtils.File(input.stagingPath);
  expectedStage.normalize();
  Assert.equal(receipt.stagingPath, expectedStage.path);
  Assert.deepEqual(
    receipt.cards.map(([key]) => key),
    [1]
  );
  Assert.deepEqual(
    receipt.lists.map(([key]) => key),
    [1]
  );
  Assert.notEqual(receipt.cards[0][1], receipt.lists[0][1]);
  const db = openStage(input);
  try {
    Assert.deepEqual(rows(db, "SELECT sourceId FROM migration_source"), [
      [book.token],
    ]);
    Assert.deepEqual(rows(db, "SELECT list,card FROM list_cards"), [
      [receipt.lists[0][1], receipt.cards[0][1]],
    ]);
    Assert.deepEqual(
      rows(
        db,
        "SELECT value FROM migration_properties WHERE kind='card' AND name='Notes'"
      ),
      [[""]]
    );
    Assert.deepEqual(
      rows(
        db,
        "SELECT value FROM migration_properties WHERE kind='card' AND name='UID'"
      ),
      []
    );
    Assert.deepEqual(
      rows(
        db,
        "SELECT value FROM migration_properties WHERE kind='list' AND name='ListName'"
      ),
      [["list"]]
    );
    Assert.deepEqual(rows(db, "SELECT COUNT(DISTINCT card) FROM properties"), [
      ["1"],
    ]);
  } finally {
    db.close();
  }
  await assertOriginals(input);
  await Assert.rejects(
    input.journal.finishStage("validate"),
    /publication and activation are not supported/
  );
  const before = await IOUtils.read(input.path);
  input.journal.close();
  input.journal = await MigrationJournal.open(input.path, input.profilePath);
  await resumeMorkBookImports(input.journal, input.lock);
  Assert.deepEqual(
    await IOUtils.read(input.path),
    before,
    "Settled repeat does not rewrite progress"
  );
  Assert.deepEqual(input.journal.state.books[0].receipt, receipt);
});

add_task(
  unixOnly(),
  async function test_reconcileStorageCommitBeforeJournalCheckpoint() {
    const input = await bookInput();
    const token = await input.journal.beginBookImport("original-book");
    const db = SQLiteDirectory.createMigrationStage(
      new FileUtils.File(input.stagingPath)
    );
    let committed;
    try {
      committed = SQLiteDirectory.importMorkSnapshot(db, input.bytes, token);
    } finally {
      db.close();
    }
    Assert.equal(input.journal.state.books[0].state, "importing");
    input.journal.close();
    input.journal = await MigrationJournal.open(input.path, input.profilePath);
    await resumeMorkBookImports(input.journal, input.lock);
    Assert.deepEqual(
      input.journal.state.books[0].receipt.cards,
      committed.cards
    );
    Assert.deepEqual(
      input.journal.state.books[0].receipt.lists,
      committed.lists
    );
    await assertOriginals(input);
  }
);

add_task(
  unixOnly(),
  async function test_failedCheckpointRetainsCommittedBookForRetry() {
    const input = await bookInput();
    const record = input.journal.recordBookImport.bind(input.journal);
    let committed;
    let writeError;
    let beforeCheckpoint;
    input.journal.recordBookImport = async (id, receipt) => {
      committed = receipt;
      beforeCheckpoint = await IOUtils.read(input.path);
      await IOUtils.makeDirectory(input.path + ".tmp");
      try {
        return await record(id, receipt);
      } catch (error) {
        writeError = error;
        throw error;
      }
    };
    await Assert.rejects(
      resumeMorkBookImports(input.journal, input.lock),
      error =>
        error === writeError &&
        typeof error.code == "number" &&
        typeof error.name == "string",
      "The real IOUtils checkpoint fails after the real storage commit"
    );
    Assert.ok(
      committed,
      "Storage returned its complete receipt before the write fault"
    );
    Assert.equal(input.journal.state.books[0].state, "importing");
    Assert.deepEqual(
      await IOUtils.read(input.path),
      beforeCheckpoint,
      "Failed checkpoint retains the prior journal bytes"
    );
    const db = openStage(input);
    try {
      Assert.deepEqual(
        rows(db, "SELECT uid FROM migration_records WHERE kind='card'"),
        [[committed.cards[0][1]]]
      );
      Assert.deepEqual(rows(db, "SELECT COUNT(*) FROM lists"), [["1"]]);
      Assert.ok(!db.transactionInProgress);
    } finally {
      db.close();
    }
    input.journal.close();
    await IOUtils.remove(input.path + ".tmp", { recursive: true });
    input.journal = await MigrationJournal.open(input.path, input.profilePath);
    await resumeMorkBookImports(input.journal, input.lock);
    Assert.deepEqual(input.journal.state.books[0].receipt, committed);
    await assertOriginals(input);
  }
);

add_task(
  unixOnly(),
  async function test_cancellationSettlesCommittedBookFirst() {
    const input = await bookInput();
    const controller = new AbortController();
    const record = input.journal.recordBookImport.bind(input.journal);
    input.journal.recordBookImport = (id, receipt) => {
      controller.abort();
      return record(id, receipt);
    };
    await Assert.rejects(
      resumeMorkBookImports(input.journal, input.lock, controller.signal),
      error => error.name == "AbortError"
    );
    Assert.equal(input.journal.state.cancelled, true);
    Assert.equal(input.journal.state.stage, "import");
    Assert.equal(input.journal.state.books[0].state, "imported");
    const receipt = input.journal.state.books[0].receipt;
    input.journal.recordBookImport = record;
    await input.journal.setCancelled(false);
    await resumeMorkBookImports(input.journal, input.lock);
    Assert.deepEqual(input.journal.state.books[0].receipt, receipt);
    Assert.equal(input.journal.state.stage, "validate");
    await assertOriginals(input);
  }
);

add_task(unixOnly(), async function test_changedBookRejectsBeforeStaging() {
  const input = await bookInput();
  await IOUtils.write(input.source, new Uint8Array([...input.bytes, 10]));
  await Assert.rejects(
    resumeMorkBookImports(input.journal, input.lock),
    /source changed since backup/
  );
  Assert.ok(!(await IOUtils.exists(input.stagingPath)));
  Assert.equal(input.journal.state.books[0].state, "pending");
  await IOUtils.write(input.source, input.bytes);
  await resumeMorkBookImports(input.journal, input.lock);
  await assertOriginals(input);
});

add_task(unixOnly(), async function test_lostCommittedStageIsNotRecreated() {
  const input = await bookInput();
  await resumeMorkBookImports(input.journal, input.lock);
  const receipt = input.journal.state.books[0].receipt;
  await IOUtils.move(input.stagingPath, input.stagingPath + ".retained");
  await Assert.rejects(
    resumeMorkBookImports(input.journal, input.lock),
    /Committed book stage is missing/
  );
  Assert.ok(!(await IOUtils.exists(input.stagingPath)));
  Assert.deepEqual(input.journal.state.books[0].receipt, receipt);
  await IOUtils.move(input.stagingPath + ".retained", input.stagingPath);
  await resumeMorkBookImports(input.journal, input.lock);
  await assertOriginals(input);
});

add_task(unixOnly(), async function test_wrongHeldProfileRejectsBeforeIntent() {
  const input = await bookInput();
  const other = await bookInput();
  const before = await IOUtils.read(input.path);
  await Assert.rejects(
    resumeMorkBookImports(input.journal, other.lock),
    /lock selects another profile/
  );
  Assert.deepEqual(await IOUtils.read(input.path), before);
  Assert.ok(!(await IOUtils.exists(input.stagingPath)));
});

add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function test_windowsRemainsUnadmitted() {
    const input = await bookInput();
    const before = await IOUtils.read(input.path);
    await Assert.rejects(
      resumeMorkBookImports(input.journal, input.lock),
      /requires native reparse admission/
    );
    Assert.deepEqual(await IOUtils.read(input.path), before);
    Assert.ok(!(await IOUtils.exists(input.stagingPath)));
  }
);

add_task(
  unixOnly(),
  async function test_bookCompletionDoesNotSkipPendingMail() {
    const input = await bookInput(true);
    const mail = input.journal.state.sources[0];
    await resumeMorkBookImports(input.journal, input.lock);
    Assert.equal(input.journal.state.books[0].state, "imported");
    Assert.equal(input.journal.state.stage, "import");
    Assert.deepEqual(input.journal.state.sources[0], mail);
    await Assert.rejects(
      input.journal.finishStage("import"),
      /imports are incomplete/
    );
    input.journal.close();
    input.journal = await MigrationJournal.open(input.path, input.profilePath);
    Assert.deepEqual(
      input.journal.state.sources[0],
      mail,
      "Version1 mail fields survive a version2 restart"
    );
    await assertOriginals(input);
  }
);

add_task(
  unixOnly(),
  async function test_bookReceiptCannotSwapSourceOrScopedMaps() {
    const input = await bookInput();
    await resumeMorkBookImports(input.journal, input.lock);
    const receipt = input.journal.state.books[0].receipt;
    const before = await IOUtils.read(input.path);
    await Assert.rejects(
      input.journal.recordBookImport("original-book", {
        ...receipt,
        storageSourceId: "another-operation",
      }),
      /Invalid book import receipt/
    );
    await Assert.rejects(
      input.journal.recordBookImport("original-book", {
        ...receipt,
        cards: [],
      }),
      /Book UID mapping is incomplete/
    );
    await Assert.rejects(
      input.journal.recordBookImport("original-book", {
        ...receipt,
        lists: [[1, receipt.cards[0][1]]],
      }),
      /Invalid book UID mapping/
    );
    Assert.deepEqual(await IOUtils.read(input.path), before);
    Assert.deepEqual(input.journal.state.books[0].receipt, receipt);
  }
);

add_task(
  unixOnly(),
  async function test_lostCommittedReceiptDoesNotReimportEmptyStage() {
    const input = await bookInput();
    await resumeMorkBookImports(input.journal, input.lock);
    const receipt = input.journal.state.books[0].receipt;
    await IOUtils.move(input.stagingPath, input.stagingPath + ".retained");
    SQLiteDirectory.createMigrationStage(
      new FileUtils.File(input.stagingPath)
    ).close();
    await Assert.rejects(
      resumeMorkBookImports(input.journal, input.lock),
      /Committed book storage receipt is missing/
    );
    const db = openStage(input);
    try {
      Assert.ok(!db.tableExists("migration_source"));
      Assert.deepEqual(rows(db, "SELECT COUNT(*) FROM properties"), [["0"]]);
      Assert.deepEqual(rows(db, "SELECT COUNT(*) FROM lists"), [["0"]]);
    } finally {
      db.close();
    }
    Assert.deepEqual(input.journal.state.books[0].receipt, receipt);
    await assertOriginals(input);
  }
);

add_task(
  unixOnly(),
  async function test_changedCommittedBookCannotCheckpointBeforeRepair() {
    const input = await bookInput();
    const token = await input.journal.beginBookImport("original-book");
    let db = SQLiteDirectory.createMigrationStage(
      new FileUtils.File(input.stagingPath)
    );
    let committed;
    try {
      committed = SQLiteDirectory.importMorkSnapshot(db, input.bytes, token);
      db.executeSimpleSQL(
        "DELETE FROM migration_properties WHERE kind='card' AND name='Notes'"
      );
    } finally {
      db.close();
    }
    input.journal.close();
    input.journal = await MigrationJournal.open(input.path, input.profilePath);
    await Assert.rejects(
      resumeMorkBookImports(input.journal, input.lock),
      /Staged book differs: raw properties/
    );
    Assert.equal(input.journal.state.stage, "import");
    Assert.equal(input.journal.state.books[0].state, "importing");
    Assert.equal(input.journal.state.books[0].receipt, null);
    db = openStage(input);
    try {
      Assert.deepEqual(
        rows(db, "SELECT uid FROM migration_records WHERE kind='card'"),
        [[committed.cards[0][1]]],
        "The original committed identity is retained, not called rolled back"
      );
      Assert.deepEqual(
        rows(
          db,
          "SELECT COUNT(*) FROM migration_properties WHERE kind='card' AND name='Notes'"
        ),
        [["0"]],
        "Reconciliation does not silently repair missing source data"
      );
      db.executeSimpleSQL(
        "INSERT INTO migration_properties VALUES('card','1','Notes','')"
      );
    } finally {
      db.close();
    }
    await assertOriginals(input);
    await resumeMorkBookImports(input.journal, input.lock);
    Assert.equal(input.journal.state.stage, "validate");
    Assert.deepEqual(
      input.journal.state.books[0].receipt.cards,
      committed.cards
    );
    Assert.deepEqual(
      input.journal.state.books[0].receipt.lists,
      committed.lists
    );
    await assertOriginals(input);
  }
);

/**
 * Uses -f because the native -e handler ignores evaluation failure status.
 * The bootstrap only supplies exact input; the ordinary child script runs it.
 *
 * @param {object} input - Actual source/stage/token for the child.
 * @returns {string[]} Native xpcshell arguments.
 */
function bookCommitChildArguments(input) {
  return [
    "-g",
    Services.dirsvc.get("GreD", Ci.nsIFile).path,
    "-a",
    Services.dirsvc.get("XCurProcD", Ci.nsIFile).path,
    "-e",
    `const migrationBookChildInput = ${JSON.stringify(input)};`,
    "-f",
    do_get_file("data/migration-book-child.js").path,
  ];
}

add_task(
  unixOnly(),
  async function test_killedBookCommitReconcilesWithoutRegeneratingUIDs() {
    const input = await bookInput();
    const token = await input.journal.beginBookImport("original-book");
    const { Subprocess } = ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs"
    );
    const { TestUtils } = ChromeUtils.importESModule(
      "resource://testing-common/TestUtils.sys.mjs"
    );
    const child = await Subprocess.call({
      command: Services.dirsvc.get("XREExeF", Ci.nsIFile).path,
      arguments: bookCommitChildArguments({
        source: input.source,
        stagingPath: input.stagingPath,
        token,
      }),
      stderr: "stdout",
    });
    let output = "";
    let committed;
    let readError;
    const readCommit = (async () => {
      try {
        for (let chunk; (chunk = await child.stdout.readString()); ) {
          output += chunk;
          const complete = output.split("\n");
          complete.pop(); // The last chunk can end in a partial line.
          const line = complete.find(value =>
            value.startsWith("BOOK-COMMITTED ")
          );
          if (line) {
            committed = JSON.parse(line.slice("BOOK-COMMITTED ".length));
            return;
          }
        }
        await child.wait(); // Observe exit before failure cleanup can request a kill.
        throw new Error("Child exited before its native commit: " + output);
      } catch (error) {
        readError = error;
      }
    })();
    try {
      await TestUtils.waitForCondition(
        () => committed || readError,
        "Waiting for the actual native book commit before forced termination",
        100,
        300
      );
      if (readError) {
        throw readError;
      }
      Assert.equal(input.journal.state.books[0].state, "importing");
      Assert.equal(input.journal.state.books[0].receipt, null);
      Assert.equal(child.exitCode, null, "The child still owns its open stage");
      const { exitCode } = await child.kill(0);
      Assert.equal(exitCode, -9, "Real SIGKILL, not orderly connection close");
    } finally {
      await child.kill(0);
      await readCommit;
    }
    input.journal.close();
    input.journal = await MigrationJournal.open(input.path, input.profilePath);
    await assertOriginals(input);
    await resumeMorkBookImports(input.journal, input.lock);
    Assert.equal(input.journal.state.stage, "validate");
    Assert.deepEqual(
      input.journal.state.books[0].receipt.cards,
      committed.cards
    );
    Assert.deepEqual(
      input.journal.state.books[0].receipt.lists,
      committed.lists
    );
    const before = await IOUtils.read(input.path);
    await resumeMorkBookImports(input.journal, input.lock);
    Assert.deepEqual(await IOUtils.read(input.path), before);
    await assertOriginals(input);
  }
);

add_task(
  unixOnly(),
  async function test_childSourceErrorExitsBeforeCommitAndRetryImports() {
    const input = await bookInput();
    const token = await input.journal.beginBookImport("original-book");
    const { Subprocess } = ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs"
    );
    const { TestUtils } = ChromeUtils.importESModule(
      "resource://testing-common/TestUtils.sys.mjs"
    );
    const missing = input.source + ".missing";
    Assert.ok(!(await IOUtils.exists(missing)));
    const child = await Subprocess.call({
      command: Services.dirsvc.get("XREExeF", Ci.nsIFile).path,
      arguments: bookCommitChildArguments({
        source: missing,
        stagingPath: input.stagingPath,
        token,
      }),
      stderr: "stdout",
    });
    let output = "";
    const readOutput = (async () => {
      for (let chunk; (chunk = await child.stdout.readString()); ) {
        output += chunk;
      }
    })();
    let exit;
    child.wait().then(result => {
      exit = result;
    });
    try {
      await TestUtils.waitForCondition(
        () => exit,
        "The actual child source failure must exit, not hang in its spin loop",
        100,
        300
      );
      await readOutput;
      Assert.equal(exit.exitCode, 2);
      Assert.ok(output.includes("NotFoundError"), output);
      Assert.ok(
        output.includes(missing),
        "The original failing path is reported"
      );
      Assert.ok(!output.includes("BOOK-COMMITTED"));
    } finally {
      await child.kill(0);
      await readOutput;
    }
    Assert.equal(input.journal.state.books[0].state, "importing");
    Assert.equal(input.journal.state.books[0].receipt, null);
    const db = openStage(input);
    try {
      Assert.ok(!db.tableExists("migration_source"));
      Assert.deepEqual(rows(db, "SELECT COUNT(*) FROM properties"), [["0"]]);
      Assert.deepEqual(rows(db, "SELECT COUNT(*) FROM lists"), [["0"]]);
    } finally {
      db.close();
    }
    await assertOriginals(input);
    await resumeMorkBookImports(input.journal, input.lock);
    Assert.equal(input.journal.state.stage, "validate");
    Assert.equal(input.journal.state.books[0].receipt.storageSourceId, token);
    await assertOriginals(input);
  }
);

add_task(
  unixOnly(),
  async function test_killedUncommittedBookRollsBackThenRetries() {
    const input = await bookInput();
    const token = await input.journal.beginBookImport("original-book");
    const { Subprocess } = ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs"
    );
    const { TestUtils } = ChromeUtils.importESModule(
      "resource://testing-common/TestUtils.sys.mjs"
    );
    const child = await Subprocess.call({
      command: Services.dirsvc.get("XREExeF", Ci.nsIFile).path,
      arguments: bookCommitChildArguments({
        source: input.source,
        stagingPath: input.stagingPath,
        token,
        pauseDuringWrite: true,
      }),
      stderr: "stdout",
    });
    let output = "";
    let writing = false;
    let readError;
    const readBoundary = (async () => {
      try {
        for (let chunk; (chunk = await child.stdout.readString()); ) {
          output += chunk;
          const complete = output.split("\n");
          complete.pop();
          if (complete.includes("BOOK-WRITING")) {
            writing = true;
            return;
          }
        }
        await child.wait();
        throw new Error("Child exited before its native SQL write: " + output);
      } catch (error) {
        readError = error;
      }
    })();
    try {
      await TestUtils.waitForCondition(
        () => writing || readError,
        "Waiting for the actual native transaction before forced termination",
        100,
        300
      );
      if (readError) {
        throw readError;
      }
      Assert.ok(!output.includes("BOOK-COMMITTED"));
      Assert.equal(child.exitCode, null);
      Assert.equal(input.journal.state.books[0].state, "importing");
      Assert.equal(input.journal.state.books[0].receipt, null);
      Assert.equal((await child.kill(0)).exitCode, -9);
    } finally {
      await child.kill(0);
      await readBoundary;
    }
    const db = openStage(input);
    try {
      Assert.equal(db.schemaVersion, 4);
      Assert.ok(!db.tableExists("migration_source"));
      Assert.ok(!db.tableExists("migration_records"));
      Assert.ok(!db.tableExists("migration_properties"));
      Assert.deepEqual(rows(db, "SELECT COUNT(*) FROM properties"), [["0"]]);
      Assert.deepEqual(rows(db, "SELECT COUNT(*) FROM lists"), [["0"]]);
      Assert.deepEqual(rows(db, "SELECT COUNT(*) FROM list_cards"), [["0"]]);
    } finally {
      db.close();
    }
    input.journal.close();
    input.journal = await MigrationJournal.open(input.path, input.profilePath);
    Assert.equal(input.journal.state.books[0].receipt, null);
    await assertOriginals(input);
    await resumeMorkBookImports(input.journal, input.lock);
    const receipt = input.journal.state.books[0].receipt;
    Assert.equal(input.journal.state.stage, "validate");
    Assert.equal(receipt.storageSourceId, token);
    Assert.deepEqual(
      receipt.cards.map(([key]) => key),
      [1]
    );
    Assert.deepEqual(
      receipt.lists.map(([key]) => key),
      [1]
    );
    await assertOriginals(input);
  }
);
