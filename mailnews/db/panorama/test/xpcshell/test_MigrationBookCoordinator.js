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
const { resumeMorkBookImports, resumeMorkBookImportsAndPublish } =
  ChromeUtils.importESModule(
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
    do_get_tempdir().path,
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

add_task(
  unixOnly(),
  async function test_killedCheckpointedBookOnlyFinishesStage() {
    const input = await bookInput();
    const token = await input.journal.beginBookImport("original-book");
    const plannedStage = input.journal.state.books[0].stagingPath;
    const alias = PathUtils.join(home, "checkpoint-alias-" + serial);
    // Existing xpcom/path-test route: only a harmless work-directory ancestor
    // is linked. The selected profile and actual source leaf remain unchanged.
    const process = Cc["@mozilla.org/process/util;1"].createInstance(
      Ci.nsIProcess
    );
    process.init(new FileUtils.File("/bin/ln"));
    const args = ["-s", input.root, alias];
    process.run(true, args, args.length);
    Assert.equal(process.exitValue, 0);
    Assert.ok(new FileUtils.File(alias).isSymlink());
    const originalStage = PathUtils.join(alias, "abook.sqlite");
    Assert.notEqual(originalStage, plannedStage);
    // One journal writer: the child owns the actual reopen/write until it exits.
    input.journal.close();
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
        stagingPath: originalStage,
        token,
        checkpointJournal: true,
        journalPath: input.path,
        profilePath: input.profilePath,
      }),
      stderr: "stdout",
    });
    let output = "";
    let committed;
    let readError;
    const readCheckpoint = (async () => {
      try {
        for (let chunk; (chunk = await child.stdout.readString()); ) {
          output += chunk;
          const complete = output.split("\n");
          complete.pop();
          const line = complete.find(value =>
            value.startsWith("BOOK-CHECKPOINTED ")
          );
          if (line) {
            committed = JSON.parse(line.slice("BOOK-CHECKPOINTED ".length));
            return;
          }
        }
        await child.wait();
        throw new Error(
          "Child exited before its durable book checkpoint: " + output
        );
      } catch (error) {
        readError = error;
      }
    })();
    let persisted;
    try {
      await TestUtils.waitForCondition(
        () => committed || readError,
        "Waiting for the actual durable book journal checkpoint",
        100,
        300
      );
      if (readError) {
        throw readError;
      }
      persisted = await IOUtils.readJSON(input.path);
      Assert.equal(persisted.stage, "import");
      Assert.equal(persisted.books[0].state, "imported");
      Assert.equal(persisted.books[0].receipt.storageSourceId, token);
      Assert.equal(persisted.books[0].receipt.stagingPath, plannedStage);
      Assert.notEqual(persisted.books[0].receipt.stagingPath, originalStage);
      Assert.deepEqual(persisted.books[0].receipt.cards, committed.cards);
      Assert.deepEqual(persisted.books[0].receipt.lists, committed.lists);
      Assert.equal(child.exitCode, null);
      Assert.equal((await child.kill(0)).exitCode, -9);
    } finally {
      await child.kill(0);
      await readCheckpoint;
    }
    input.journal = await MigrationJournal.open(input.path, input.profilePath);
    Assert.deepEqual(input.journal.state, persisted);
    await assertOriginals(input);
    await resumeMorkBookImports(input.journal, input.lock);
    Assert.equal(input.journal.state.stage, "validate");
    Assert.equal(
      input.journal.state.revision,
      persisted.revision + 1,
      "Only finishStage writes; the committed unit is not checkpointed again"
    );
    Assert.deepEqual(
      input.journal.state.books[0].receipt,
      persisted.books[0].receipt
    );
    const before = await IOUtils.read(input.path);
    await resumeMorkBookImports(input.journal, input.lock);
    Assert.deepEqual(await IOUtils.read(input.path), before);
    await assertOriginals(input);
  }
);

/**
 * Stops the sole real journal writer after intent or import-stage settlement.
 * The returned state is read independently from disk, not supplied by the child.
 *
 * @param {object} input - Genuine book, actual held profile lock and journal.
 * @param {boolean} intentOnly - Stop before stage creation, otherwise after import settlement.
 * @returns {Promise<{persisted: object, reported: object}>} Observed durable state.
 */
async function killBookAtJournalBoundary(input, intentOnly) {
  const token = input.journal.state.books[0].token;
  input.journal.close();
  const { Subprocess } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs"
  );
  const { TestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/TestUtils.sys.mjs"
  );
  const prefix = intentOnly ? "BOOK-INTENT " : "BOOK-IMPORT-SETTLED ";
  const child = await Subprocess.call({
    command: Services.dirsvc.get("XREExeF", Ci.nsIFile).path,
    arguments: bookCommitChildArguments({
      source: input.source,
      stagingPath: input.stagingPath,
      token,
      journalPath: input.path,
      profilePath: input.profilePath,
      pauseAfterIntent: intentOnly,
      checkpointJournal: !intentOnly,
      finishImportStage: !intentOnly,
    }),
    stderr: "stdout",
  });
  let output = "";
  let reported;
  let readError;
  const readBoundary = (async () => {
    try {
      for (let chunk; (chunk = await child.stdout.readString()); ) {
        output += chunk;
        const complete = output.split("\n");
        complete.pop();
        const line = complete.find(value => value.startsWith(prefix));
        if (line) {
          reported = JSON.parse(line.slice(prefix.length));
          return;
        }
      }
      await child.wait();
      throw new Error("Child exited before its journal boundary: " + output);
    } catch (error) {
      readError = error;
    }
  })();
  let persisted;
  try {
    await TestUtils.waitForCondition(
      () => reported || readError,
      "Waiting for the actual durable book journal write",
      100,
      300
    );
    if (readError) {
      throw readError;
    }
    persisted = await IOUtils.readJSON(input.path);
    if (intentOnly) {
      Assert.ok(!(await IOUtils.exists(input.stagingPath)));
    }
    Assert.equal(child.exitCode, null);
    Assert.equal((await child.kill(0)).exitCode, -9);
  } finally {
    await child.kill(0);
    await readBoundary;
  }
  input.journal = await MigrationJournal.open(input.path, input.profilePath);
  Assert.deepEqual(input.journal.state, persisted);
  return { persisted, reported };
}

add_task(unixOnly(), async function test_killedBookIntentRetriesFromNoStage() {
  const input = await bookInput();
  const before = input.journal.state;
  Assert.equal(before.books[0].state, "pending");
  const { persisted, reported } = await killBookAtJournalBoundary(input, true);
  Assert.equal(persisted.revision, before.revision + 1);
  Assert.equal(persisted.stage, "import");
  Assert.equal(persisted.books[0].state, "importing");
  Assert.equal(persisted.books[0].receipt, null);
  Assert.equal(reported.token, before.books[0].token);
  Assert.equal(persisted.books[0].token, reported.token);
  Assert.ok(!(await IOUtils.exists(input.stagingPath)));
  await assertOriginals(input);
  await resumeMorkBookImports(input.journal, input.lock);
  Assert.equal(input.journal.state.stage, "validate");
  Assert.equal(
    input.journal.state.books[0].receipt.storageSourceId,
    reported.token
  );
  await assertOriginals(input);
});

add_task(unixOnly(), async function test_killedSettledImportReopensReadOnly() {
  const input = await bookInput();
  await input.journal.beginBookImport("original-book");
  const revision = input.journal.state.revision;
  const { persisted, reported } = await killBookAtJournalBoundary(input, false);
  Assert.equal(persisted.revision, revision + 2);
  Assert.equal(persisted.stage, "validate");
  Assert.equal(persisted.books[0].state, "imported");
  Assert.deepEqual(persisted.books[0].receipt.cards, reported.cards);
  Assert.deepEqual(persisted.books[0].receipt.lists, reported.lists);
  await assertOriginals(input);
  const before = await IOUtils.read(input.path);
  await resumeMorkBookImports(input.journal, input.lock);
  Assert.deepEqual(await IOUtils.read(input.path), before);
  Assert.deepEqual(input.journal.state, persisted);
  await Assert.rejects(
    input.journal.finishStage("validate"),
    /publication and activation are not supported/
  );
  Assert.deepEqual(await IOUtils.read(input.path), before);
  Assert.ok(
    !(await IOUtils.exists(
      PathUtils.join(input.profilePath, "panorama-profile.json")
    ))
  );
  await assertOriginals(input);
});

let publicationProfile;

/** Closes actual Manager connections before a controlled publication/restart. */
async function reloadPublishedBooks() {
  const { MailServices } = ChromeUtils.importESModule(
    "resource:///modules/MailServices.sys.mjs"
  );
  const { TestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/TestUtils.sys.mjs"
  );
  Array.from(MailServices.ab.directories);
  const reloaded = TestUtils.topicObserved("addrbook-reloaded");
  Services.obs.notifyObservers(null, "addrbook-reload");
  await reloaded;
}

/**
 * Plans genuine book bytes under a native lock, then releases that lock.
 * Other-profile staging cases above retain their original stage-only lifetime.
 *
 * @returns {Promise<object>} Actual current profile, genuine source, backup,
 *   stage, journal, original book ID and selected display-name map.
 */
async function publicationInput() {
  if (!publicationProfile) {
    publicationProfile = profiles.createProfile(
      do_get_profile(),
      "s520-current-publication",
      "tests"
    );
    registerCleanupFunction(async () => {
      await reloadPublishedBooks();
      publicationProfile.remove(false);
    });
  }
  await reloadPublishedBooks();
  // Prepare the genuine source and backup before transferring lock ownership.
  const preparationLock = publicationProfile.lock({});
  try {
    const id = "publication-book-" + ++serial;
    const root = PathUtils.join(do_get_tempdir().path, id);
    await IOUtils.makeDirectory(root);
    const profilePath = preparationLock.directory.path;
    const source = PathUtils.join(profilePath, id + ".mab");
    const bytes = await IOUtils.read(do_get_file(MAB_FILE).path);
    await IOUtils.copy(do_get_file(MAB_FILE).path, source);
    const { identity } = await readMorkAddressBookSource(source);
    const stagingPath = PathUtils.join(root, "book.sqlite");
    const path = PathUtils.join(root, "journal.json");
    const backupPath = PathUtils.join(root, "backup");
    const journal = await MigrationJournal.create(path, {
      profilePath,
      mailPaths: [],
      backupPath,
      sources: [],
      books: [{ id, ...identity, stagingPath }],
    });
    const input = {
      id,
      root,
      profilePath,
      source,
      bytes,
      stagingPath,
      path,
      backupPath,
      journal,
      profile: publicationProfile,
      names: new Map([[id, "Actual imported book é"]]),
    };
    registerCleanupFunction(() => input.journal.close());
    input.backup = await createMigrationBackup(profilePath, [], backupPath);
    await input.journal.recordBackup(input.backup);
    return input;
  } finally {
    preparationLock.unlock();
  }
}

/**
 * Imports a corruption/error fixture under a separate actual native lock.
 *
 * @param {object} input - Current-profile journal and native toolkit profile.
 * @returns {Promise<void>} Complete original stage-only import receipt.
 */
async function stagePublicationInput(input) {
  const lock = input.profile.lock({});
  try {
    await resumeMorkBookImports(input.journal, lock);
  } finally {
    lock.unlock();
  }
}

/** @returns {{topics: string[], close: Function}} Actual creation events. */
function watchBookPublication() {
  const topics = [];
  const observed = [
    "addrbook-directory-created",
    "addrbook-contact-created",
    "addrbook-contacts-created",
    "addrbook-list-created",
    "addrbook-list-member-added",
  ];
  const observer = {
    observe(subject, topic) {
      topics.push(topic);
    },
  };
  for (const topic of observed) {
    Services.obs.addObserver(observer, topic);
  }
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    for (const topic of observed) {
      Services.obs.removeObserver(observer, topic);
    }
    closed = true;
  };
  registerCleanupFunction(close);
  return { topics, close };
}

/**
 * Checks the actual normal directory, genuine values and original scoped maps.
 *
 * @param {object} input - Current complete journal unit.
 * @param {object} published - Actual Manager result.
 */
function assertPublishedBook(input, published) {
  const book = input.journal.state.books[0];
  const directory = published.directory;
  Assert.equal(book.publication.state, "published");
  Assert.equal(directory.UID, book.publication.bookUID);
  Assert.equal(directory.dirName, "Actual imported book é");
  Assert.equal(directory.dirPrefId, published.dirPrefId);
  Assert.equal(directory.URI, published.uri);
  Assert.deepEqual(published.cards, book.receipt.cards);
  Assert.deepEqual(published.lists, book.receipt.lists);
  const cards = Array.from(directory.childCards).filter(
    card => !card.isMailList
  );
  Assert.equal(cards.length, 1);
  Assert.equal(cards[0].UID, book.receipt.cards[0][1]);
  Assert.equal(
    cards[0].displayName,
    "contact number one",
    "Durable public book retains the genuine card name"
  );
  Assert.equal(cards[0].primaryEmail, "contact1@invalid");
  const lists = Array.from(directory.childNodes);
  Assert.equal(lists.length, 1);
  Assert.equal(lists[0].UID, book.receipt.lists[0][1]);
  Assert.equal(lists[0].dirName, "list");
  Assert.equal(lists[0].listNickName, "nick name");
  Assert.equal(lists[0].description, "a list of cards");
  Assert.deepEqual(
    Array.from(lists[0].childCards, card => card.UID),
    [cards[0].UID]
  );
  const actual = SQLiteDirectory.forFile(published.fileName);
  Assert.equal(actual.loadMigrationProperties(cards[0].UID).get("Notes"), "");
  Assert.ok(!actual.loadMigrationProperties(cards[0].UID).has("UID"));
  Assert.equal(
    actual.loadMigrationProperties(lists[0].UID).get("Address1"),
    "1"
  );
}

add_task(
  unixOnly(),
  async function test_bookPublicationAwaitsNativePreferenceCommit() {
    const input = await publicationInput();
    const events = watchBookPublication();
    const { withMigrationAddressBookPublication } = ChromeUtils.importESModule(
      "resource:///modules/AddrBookManager.sys.mjs"
    );
    const managerServices = Cu.getGlobalForObject(
      withMigrationAddressBookPublication
    ).Services;
    const prefs = managerServices.prefs;
    const backupPrefFile = prefs.backupPrefFile;
    let signalStarted;
    const started = new Promise(resolve => {
      signalStarted = resolve;
    });
    let releaseCommit;
    const commit = new Promise(resolve => {
      releaseCommit = resolve;
    });
    let first = true;
    let operation;
    const snapshot = function (...args) {
      const native = backupPrefFile.apply(prefs, args);
      if (!first) {
        return native;
      }
      first = false;
      signalStarted();
      // Keep the actual native result, delaying only its successful delivery.
      return native.then(() => commit);
    };
    // Forward native methods with their real receiver; only this module sees
    // the controlled success-delivery boundary. Native methods stay readonly.
    managerServices.prefs = new Proxy(
      {},
      {
        get(target, name) {
          const value = name == "backupPrefFile" ? snapshot : prefs[name];
          return typeof value == "function" ? value.bind(prefs) : value;
        },
      }
    );
    try {
      operation = resumeMorkBookImportsAndPublish(
        input.journal,
        input.profile,
        input.names
      );
      await Promise.race([
        started,
        operation.then(() => {
          throw new Error(
            "Publication returned without the native preference commit"
          );
        }),
      ]);
      Assert.equal(
        input.journal.state.books[0].publication.state,
        "pending",
        "An unsettled native publication never becomes a journal receipt"
      );
      Assert.deepEqual(
        events.topics,
        [],
        "No creation before durable publication"
      );
      releaseCommit();
      const [published] = await operation;
      assertPublishedBook(input, published);
      Assert.deepEqual(events.topics, ["addrbook-directory-created"]);
      await assertOriginals(input);
    } finally {
      releaseCommit();
      managerServices.prefs = prefs;
      // Settle this test's operation before releasing its observer or profile.
      try {
        await operation;
      } catch (error) {
        console.error(
          "Publication fixture settled after its primary failure",
          error
        );
      }
      events.close();
    }
  }
);

add_task(
  unixOnly(),
  async function test_completeBookPublicationPreservesOriginalUIDMaps() {
    const input = await publicationInput();
    const events = watchBookPublication();
    const [published] = await resumeMorkBookImportsAndPublish(
      input.journal,
      input.profile,
      input.names
    );
    assertPublishedBook(input, published);
    Assert.deepEqual(events.topics, ["addrbook-directory-created"]);
    const before = await IOUtils.read(input.path);
    const [again] = await resumeMorkBookImportsAndPublish(
      input.journal,
      input.profile,
      input.names
    );
    Assert.equal(again.reused, true);
    Assert.equal(again.dirPrefId, published.dirPrefId);
    Assert.deepEqual(await IOUtils.read(input.path), before);
    Assert.deepEqual(events.topics, ["addrbook-directory-created"]);
    await assertOriginals(input);
    await Assert.rejects(
      input.journal.finishStage("validate"),
      /publication and activation are not supported/
    );
    events.close();
  }
);

/**
 * Reads actual persisted prefs and public card/list data in a new OS process.
 * The publication callback has released its native lock before this call.
 * The parent closes real readers before the child acquires its own lock.
 *
 * @param {object} input - Published current-profile unit.
 * @param {object} published - Actual stable Manager identity.
 * @returns {Promise<object>} Child's independent public values, not parent data.
 */
async function readPublishedBookInChild(input, published) {
  const { Subprocess } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs"
  );
  const { TestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/TestUtils.sys.mjs"
  );
  await reloadPublishedBooks();
  const profileDirectories = Object.fromEntries(
    ["DefProfRt", "DefProfLRt", "UAppData"].map(key => [
      key,
      Services.dirsvc.get(key, Ci.nsIFile).path,
    ])
  );
  const code = `
    let held;
    try {
      const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
      const root = new FileUtils.File(${JSON.stringify(input.profilePath)});
      Services.dirsvc.set("ProfD", root.clone());
      Services.dirsvc.set("ProfLD", root.clone());
      for (const [key, path] of Object.entries(${JSON.stringify(profileDirectories)})) {
        Services.dirsvc.set(key, new FileUtils.File(path));
      }
      const service = Cc["@mozilla.org/toolkit/profile-service;1"].getService(Ci.nsIToolkitProfileService);
      const profile = service.createProfile(root, "s520-readback-child", "tests");
      held = profile.lock({});
      const prefs = root.clone(); prefs.append("prefs.js");
      Services.prefs.readUserPrefsFromFile(prefs);
      Services.prefs.setBoolPref("security.nocertdb", true);
      const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const directory = MailServices.ab.getDirectoryFromUID(${JSON.stringify(published.bookUID)});
      if (!directory) { throw new Error("Persisted public book is absent"); }
      const card = Array.from(directory.childCards).find(value => !value.isMailList);
      const result = {
        bookUID: directory.UID, uri: directory.URI, dirPrefId: directory.dirPrefId,
        card: [card.UID, card.displayName, card.primaryEmail],
        lists: Array.from(directory.childNodes, list => [list.UID, list.dirName,
          Array.from(list.childCards, member => member.UID)]),
      };
      print("BOOK-PUBLICATION-REOPEN " + JSON.stringify(result));
      held.unlock(); held = null;
      quit(0);
    } catch (error) {
      print("BOOK-PUBLICATION-REOPEN-ERROR " + JSON.stringify({
        message: String(error), result: error.result, stack: error.stack,
      }));
      held?.unlock();
      quit(1);
    }
  `;
  let child;
  let output = "";
  let terminal;
  let error;
  let done = false;
  let reading;
  try {
    child = await Subprocess.call({
      command: Services.dirsvc.get("XREExeF", Ci.nsIFile).path,
      arguments: [
        "-g",
        Services.dirsvc.get("GreD", Ci.nsIFile).path,
        "-a",
        Services.dirsvc.get("XCurProcD", Ci.nsIFile).path,
        "-e",
        code,
      ],
      stderr: "stdout",
    });
    reading = (async () => {
      try {
        for (let chunk; (chunk = await child.stdout.readString()); ) {
          output += chunk;
        }
        terminal = await child.wait();
      } catch (failure) {
        error = failure;
      } finally {
        done = true;
      }
    })();
    await TestUtils.waitForCondition(
      () => done,
      "Actual public-book process exits",
      100,
      300
    );
    if (error) {
      throw error;
    }
    Assert.equal(
      terminal.exitCode,
      0,
      "Actual Manager process-reopen exits successfully: " +
        JSON.stringify(output)
    );
    const line = output
      .split("\n")
      .find(value => value.startsWith("BOOK-PUBLICATION-REOPEN "));
    Assert.ok(
      line,
      "Actual process reopens the persisted public book: " +
        JSON.stringify(output)
    );
    return JSON.parse(line.slice("BOOK-PUBLICATION-REOPEN ".length));
  } finally {
    if (child && child.exitCode === null) {
      await child.kill(0);
    }
    await reading;
  }
}

add_task(
  unixOnly(),
  async function test_bookPublicationReconcilesAfterJournalReopen() {
    const input = await publicationInput();
    const [published] = await resumeMorkBookImportsAndPublish(
      input.journal,
      input.profile,
      input.names
    );
    const receipt = input.journal.state.books[0].receipt;
    input.journal.close();
    const actual = await readPublishedBookInChild(input, published);
    Assert.deepEqual(actual, {
      bookUID: published.bookUID,
      uri: published.uri,
      dirPrefId: published.dirPrefId,
      card: [receipt.cards[0][1], "contact number one", "contact1@invalid"],
      lists: [[receipt.lists[0][1], "list", [receipt.cards[0][1]]]],
    });
    input.journal = await MigrationJournal.open(input.path, input.profilePath);
    const before = await IOUtils.read(input.path);
    const events = watchBookPublication();
    const [again] = await resumeMorkBookImportsAndPublish(
      input.journal,
      input.profile,
      input.names
    );
    assertPublishedBook(input, again);
    Assert.equal(again.reused, true);
    Assert.equal(again.dirPrefId, published.dirPrefId);
    Assert.deepEqual(await IOUtils.read(input.path), before);
    Assert.deepEqual(events.topics, []);
    await assertOriginals(input);
    events.close();
  }
);

add_task(
  unixOnly(),
  async function test_bookPublicationRequiresHeldSelectedProfile() {
    const wrong = await bookInput();
    const before = await IOUtils.read(wrong.path);
    await Assert.rejects(
      resumeMorkBookImportsAndPublish(
        wrong.journal,
        wrong.profile,
        new Map([["original-book", "Wrong profile"]])
      ),
      /another profile/
    );
    Assert.deepEqual(await IOUtils.read(wrong.path), before);
    Assert.ok(!wrong.journal.state.books[0].publication);
    const input = await publicationInput();
    const previous = await IOUtils.read(input.path);
    const { withMigrationAddressBookPublication } = ChromeUtils.importESModule(
      "resource:///modules/AddrBookManager.sys.mjs"
    );
    const events = watchBookPublication();
    let released;
    await withMigrationAddressBookPublication(
      input.profile,
      async publication => {
        released = publication;
        Assert.equal(publication.checkProfile().path, input.profilePath);
      }
    );
    // Exercise a new real native acquisition after the owned callback settles.
    const nextLock = input.profile.lock({});
    nextLock.unlock();
    Assert.throws(
      () => released.checkProfile(),
      /Book publication operation is closed/
    );
    await Assert.rejects(
      released.adopt({}),
      /Book publication operation is closed/
    );
    Assert.deepEqual(await IOUtils.read(input.path), previous);
    Assert.ok(!(await IOUtils.exists(input.stagingPath)));
    Assert.deepEqual(events.topics, []);
    const [published] = await resumeMorkBookImportsAndPublish(
      input.journal,
      input.profile,
      input.names
    );
    assertPublishedBook(input, published);
    Assert.deepEqual(events.topics, ["addrbook-directory-created"]);
    await assertOriginals(input);
    events.close();
  }
);

add_task(
  unixOnly(),
  async function test_bookPublicationRejectsChangedCommittedStage() {
    const input = await publicationInput();
    await stagePublicationInput(input);
    const receipt = input.journal.state.books[0].receipt;
    let db = openStage(input);
    db.executeSimpleSQL(
      "DELETE FROM migration_properties WHERE kind='card' AND name='Notes'"
    );
    db.close();
    const events = watchBookPublication();
    await Assert.rejects(
      resumeMorkBookImportsAndPublish(
        input.journal,
        input.profile,
        input.names
      ),
      /Staged book differs: raw properties/
    );
    Assert.deepEqual(events.topics, []);
    Assert.equal(input.journal.state.books[0].publication.state, "pending");
    Assert.deepEqual(input.journal.state.books[0].receipt, receipt);
    db = openStage(input);
    db.executeSimpleSQL(
      "INSERT INTO migration_properties VALUES('card','1','Notes','')"
    );
    db.close();
    const [published] = await resumeMorkBookImportsAndPublish(
      input.journal,
      input.profile,
      input.names
    );
    assertPublishedBook(input, published);
    Assert.deepEqual(published.cards, receipt.cards);
    Assert.deepEqual(events.topics, ["addrbook-directory-created"]);
    await assertOriginals(input);
    events.close();
  }
);

add_task(
  unixOnly(),
  async function test_cancelledPublicationSettlesActualCommit() {
    const input = await publicationInput();
    const controller = new AbortController();
    const record = input.journal.recordBookPublication.bind(input.journal);
    input.journal.recordBookPublication = (id, receipt) => {
      controller.abort();
      return record(id, receipt);
    };
    const events = watchBookPublication();
    await Assert.rejects(
      resumeMorkBookImportsAndPublish(
        input.journal,
        input.profile,
        input.names,
        controller.signal
      ),
      error => error.name === "AbortError"
    );
    const publication = input.journal.state.books[0].publication;
    Assert.equal(publication.state, "published");
    Assert.equal(input.journal.state.cancelled, true);
    Assert.deepEqual(events.topics, ["addrbook-directory-created"]);
    input.journal.recordBookPublication = record;
    await input.journal.setCancelled(false);
    const [again] = await resumeMorkBookImportsAndPublish(
      input.journal,
      input.profile,
      input.names
    );
    Assert.deepEqual(input.journal.state.books[0].publication, publication);
    assertPublishedBook(input, again);
    Assert.deepEqual(events.topics, ["addrbook-directory-created"]);
    await assertOriginals(input);
    events.close();
  }
);

add_task(
  unixOnly(),
  async function test_bookPublicationPreservesOriginalChildError() {
    const input = await publicationInput();
    await input.journal.beginBookPublication(
      input.id,
      input.names.get(input.id)
    );
    await stagePublicationInput(input);
    let db = openStage(input);
    db.executeSimpleSQL(
      "DELETE FROM migration_properties WHERE kind='card' AND name='Notes'"
    );
    db.close();
    await IOUtils.makeDirectory(input.path + ".tmp");
    const original = SQLiteDirectory.importMorkSnapshot;
    let childError;
    SQLiteDirectory.importMorkSnapshot = (...args) => {
      try {
        return original(...args);
      } catch (error) {
        childError = error;
        throw error;
      }
    };
    try {
      await Assert.rejects(
        resumeMorkBookImportsAndPublish(
          input.journal,
          input.profile,
          input.names
        ),
        error =>
          error === childError &&
          /Staged book differs: raw properties/.test(error.message),
        "The actual storage readback error stays primary when real journal IO also fails"
      );
    } finally {
      SQLiteDirectory.importMorkSnapshot = original;
      await IOUtils.remove(input.path + ".tmp", { recursive: true });
    }
    Assert.equal(input.journal.state.books[0].publication.state, "pending");
    input.journal.close();
    input.journal = await MigrationJournal.open(input.path, input.profilePath);
    db = openStage(input);
    db.executeSimpleSQL(
      "INSERT INTO migration_properties VALUES('card','1','Notes','')"
    );
    db.close();
    const [published] = await resumeMorkBookImportsAndPublish(
      input.journal,
      input.profile,
      input.names
    );
    assertPublishedBook(input, published);
    await assertOriginals(input);
  }
);
