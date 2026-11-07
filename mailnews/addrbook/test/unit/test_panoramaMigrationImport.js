/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { SQLiteDirectory } = ChromeUtils.importESModule(
  "resource:///modules/SQLiteDirectory.sys.mjs"
);
const MAB_FILE = "import.mab";
const SOURCE_ID = "original-address-book";
const topics = [
  "addrbook-directory-created",
  "addrbook-contact-created",
  "addrbook-contacts-created",
  "addrbook-list-created",
  "addrbook-list-member-added",
];
let serial = 0;
const seen = [];
const observer = {
  observe(subject, topic) {
    seen.push(topic);
  },
};

add_setup(function observePublication() {
  for (const topic of topics) {
    Services.obs.addObserver(observer, topic);
  }
  registerCleanupFunction(() => {
    for (const topic of topics) {
      Services.obs.removeObserver(observer, topic);
    }
  });
});

/** @returns {Promise<object>} Independent empty schema-4 file and owned connection. */
async function emptyStage() {
  const name = "panorama-migration-" + ++serial;
  const pref = "ldap_2.servers." + name;
  const filename = name + ".sqlite";
  const file = do_get_profile().clone();
  file.append(filename);
  const input = {
    file,
    pref,
    filename,
    connection: SQLiteDirectory.createMigrationStage(file),
    bytes: await IOUtils.read(do_get_file(MAB_FILE).path),
  };
  Assert.equal(input.connection.schemaVersion, 4);
  registerCleanupFunction(() => {
    if (input.connection?.connectionReady) {
      input.connection.close();
    }
    Services.prefs.deleteBranch(pref + ".");
  });
  seen.length = 0;
  return input;
}

/** @param {mozIStorageConnection} db - Stage. @param {string} sql - Fixed scalar query. @returns {number} First result. */
function scalar(db, sql) {
  const statement = db.createStatement(sql);
  try {
    Assert.ok(statement.executeStep());
    return statement.getInt64(0);
  } finally {
    statement.finalize();
  }
}

/** @param {object} input - Independent stage. */
async function assertSourceUnchanged(input) {
  Assert.deepEqual(await IOUtils.read(do_get_file(MAB_FILE).path), input.bytes);
}

add_task(async function test_wholeBookRawPropertiesAndNormalReaders() {
  const input = await emptyStage();
  const db = input.connection;
  const receipt = SQLiteDirectory.importMorkSnapshot(
    db,
    input.bytes,
    SOURCE_ID
  );
  Assert.equal(receipt.sourceId, SOURCE_ID);
  Assert.equal(receipt.sourceSize, input.bytes.length);
  Assert.equal(
    receipt.sourceSha256,
    await IOUtils.computeHexDigest(do_get_file(MAB_FILE).path, "sha256")
  );
  Assert.equal(receipt.cards.length, 1);
  Assert.equal(receipt.lists.length, 1);
  Assert.equal(receipt.cards[0][0], 1);
  Assert.equal(receipt.lists[0][0], 1, "Card/list keys are separately scoped");
  const cardUID = receipt.cards[0][1];
  const listUID = receipt.lists[0][1];
  Assert.ok(cardUID);
  Assert.ok(listUID);
  Assert.notEqual(cardUID, listUID);
  Assert.equal(db.schemaVersion, 4);
  Assert.equal(scalar(db, "SELECT COUNT(DISTINCT card) FROM properties"), 1);
  Assert.equal(scalar(db, "SELECT COUNT(*) FROM lists"), 1);
  Assert.equal(scalar(db, "SELECT COUNT(*) FROM list_cards"), 1);
  Assert.equal(
    scalar(
      db,
      "SELECT COUNT(*) FROM migration_properties WHERE kind='data' AND name='LastRecordKey' AND value='2'"
    ),
    1
  );
  const source = db.createStatement("SELECT bytes FROM migration_source");
  try {
    Assert.ok(source.executeStep());
    const original = {};
    source.getBlob(0, {}, original);
    Assert.deepEqual(Uint8Array.from(original.value), input.bytes);
  } finally {
    source.finalize();
  }
  Assert.deepEqual(seen, [], "Staging publishes no live-book events");
  db.close();
  input.connection = null;
  Services.prefs.setStringPref(input.pref + ".filename", input.filename);
  const book = new SQLiteDirectory();
  book.init("jsaddrbook://" + input.filename);
  try {
    Assert.equal(
      book.childCardCount,
      1,
      "List raw properties never become cards"
    );
    const card = book.getCard(cardUID);
    Assert.equal(card.UID, cardUID);
    Assert.equal(card.displayName, "contact number one");
    Assert.equal(card.primaryEmail, "contact1@invalid");
    Assert.equal(card.getPropertyAsUint32("RecordKey"), 1);
    Assert.equal(card.vCardProperties.getFirstValue("uid"), cardUID);
    const raw = book.loadMigrationProperties(cardUID);
    Assert.ok(raw.has("Notes"));
    Assert.equal(raw.get("Notes"), "");
    raw.set("Notes", "caller-only change");
    Assert.equal(book.loadMigrationProperties(cardUID).get("Notes"), "");
    Assert.ok(raw.has("Custom1"));
    Assert.equal(raw.get("Custom1"), "");
    Assert.ok(!raw.has("UID"));
    Assert.equal(raw.get("RecordKey"), "1");
    Assert.equal(raw.get("DbRowID"), "1");
    Assert.equal(raw.get("PreferDisplayName"), "1");
    Assert.equal(raw.get("LowercasePrimaryEmail"), "contact1@invalid");
    const lists = Array.from(book.childNodes);
    Assert.equal(lists.length, 1);
    Assert.equal(lists[0].UID, listUID);
    Assert.equal(lists[0].dirName, "list");
    Assert.equal(lists[0].listNickName, "nick name");
    Assert.equal(lists[0].description, "a list of cards");
    Assert.deepEqual(
      Array.from(lists[0].childCards, member => member.UID),
      [cardUID]
    );
    const listRaw = book.loadMigrationProperties(listUID);
    Assert.equal(listRaw.get("LowercaseListName"), "list");
    Assert.equal(listRaw.get("ListTotalAddresses"), "1");
    Assert.equal(listRaw.get("Address1"), "1");
    Assert.equal(listRaw.get("RecordKey"), "2");
    Assert.ok(!listRaw.has("UID"));
    Assert.equal(book.loadMigrationProperties("unmapped-uid"), null);
  } finally {
    await book.cleanUp();
  }
  await assertSourceUnchanged(input);
});

add_task(async function test_repeatReturnsSameUIDMapsWithoutWrites() {
  const input = await emptyStage();
  const first = SQLiteDirectory.importMorkSnapshot(
    input.connection,
    input.bytes,
    SOURCE_ID
  );
  input.connection.close();
  input.connection = Services.storage.openUnsharedDatabase(input.file);
  const changes = scalar(input.connection, "SELECT total_changes()");
  const second = SQLiteDirectory.importMorkSnapshot(
    input.connection,
    input.bytes,
    SOURCE_ID
  );
  Assert.deepEqual(second, first);
  Assert.equal(scalar(input.connection, "SELECT total_changes()"), changes);
  Assert.deepEqual(seen, []);
  Assert.ok(!input.connection.transactionInProgress);
  await assertSourceUnchanged(input);
});

add_task(async function test_changedSourceCannotReuseCompletedStage() {
  const input = await emptyStage();
  const first = SQLiteDirectory.importMorkSnapshot(
    input.connection,
    input.bytes,
    SOURCE_ID
  );
  const changes = scalar(input.connection, "SELECT total_changes()");
  Assert.throws(
    () =>
      SQLiteDirectory.importMorkSnapshot(
        input.connection,
        input.bytes,
        "another-source"
      ),
    /source identity changed/
  );
  const changed = new Uint8Array(input.bytes.length + 1);
  changed.set(input.bytes);
  changed[changed.length - 1] = 10;
  Assert.throws(
    () =>
      SQLiteDirectory.importMorkSnapshot(input.connection, changed, SOURCE_ID),
    /source identity changed/
  );
  Assert.equal(scalar(input.connection, "SELECT total_changes()"), changes);
  Assert.deepEqual(
    SQLiteDirectory.importMorkSnapshot(
      input.connection,
      input.bytes,
      SOURCE_ID
    ),
    first
  );
  await assertSourceUnchanged(input);
});

add_task(async function test_actualSqlFailureRollsBackAndRetryCommitsOnce() {
  const input = await emptyStage();
  const db = input.connection;
  const faults = [];
  db.createFunction("book_stage_fault_witness", 2, {
    onFunctionCall(args) {
      faults.push([args.getInt32(0), args.getInt32(1)]);
      return 0;
    },
  });
  try {
    db.executeSimpleSQL(
      "CREATE TEMP TRIGGER fail_book_list BEFORE INSERT ON lists BEGIN SELECT book_stage_fault_witness((SELECT COUNT(*) FROM properties),(SELECT COUNT(*) FROM migration_properties WHERE kind='card')); SELECT RAISE(ABORT,'book staging fault'); END"
    );
    Assert.throws(
      () => SQLiteDirectory.importMorkSnapshot(db, input.bytes, SOURCE_ID),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.equal(
      faults.length,
      1,
      "Actual SQLite fault reached after card work"
    );
    Assert.greater(faults[0][0], 0);
    Assert.greater(faults[0][1], 0);
    Assert.ok(!db.transactionInProgress);
    for (const table of ["properties", "lists", "list_cards"]) {
      Assert.equal(scalar(db, "SELECT COUNT(*) FROM " + table), 0);
    }
    for (const table of [
      "migration_source",
      "migration_records",
      "migration_properties",
      ...(AppConstants.platform == "win" ? ["migration_file_identity"] : []),
    ]) {
      Assert.ok(
        !db.tableExists(table),
        "No partially committed provenance: " + table
      );
    }
  } finally {
    db.executeSimpleSQL("DROP TRIGGER IF EXISTS fail_book_list");
    db.removeFunction("book_stage_fault_witness");
  }
  const receipt = SQLiteDirectory.importMorkSnapshot(
    db,
    input.bytes,
    SOURCE_ID
  );
  Assert.equal(receipt.cards.length, 1);
  Assert.equal(receipt.lists.length, 1);
  Assert.equal(scalar(db, "SELECT COUNT(DISTINCT card) FROM properties"), 1);
  Assert.equal(scalar(db, "SELECT COUNT(*) FROM lists"), 1);
  const changes = scalar(db, "SELECT total_changes()");
  Assert.deepEqual(
    SQLiteDirectory.importMorkSnapshot(db, input.bytes, SOURCE_ID),
    receipt
  );
  Assert.equal(scalar(db, "SELECT total_changes()"), changes);
  Assert.deepEqual(seen, []);
  await assertSourceUnchanged(input);
});

add_task(async function test_nonemptyStagePreservesExistingCard() {
  const input = await emptyStage();
  input.connection.executeSimpleSQL(
    "INSERT INTO properties VALUES('existing','DisplayName','Existing card')"
  );
  const changes = scalar(input.connection, "SELECT total_changes()");
  Assert.throws(
    () =>
      SQLiteDirectory.importMorkSnapshot(
        input.connection,
        input.bytes,
        SOURCE_ID
      ),
    /stage is not empty/
  );
  Assert.equal(scalar(input.connection, "SELECT total_changes()"), changes);
  Assert.equal(
    scalar(
      input.connection,
      "SELECT COUNT(*) FROM properties WHERE card='existing' AND name='DisplayName' AND value='Existing card'"
    ),
    1
  );
  Assert.ok(!input.connection.tableExists("migration_source"));
  await assertSourceUnchanged(input);
});

add_task(async function test_foreignTransactionIsNeverCommittedOrRolledBack() {
  const input = await emptyStage();
  input.connection.beginTransaction();
  try {
    Assert.throws(
      () =>
        SQLiteDirectory.importMorkSnapshot(
          input.connection,
          input.bytes,
          SOURCE_ID
        ),
      error => error.result == Cr.NS_ERROR_IN_PROGRESS
    );
    Assert.ok(input.connection.transactionInProgress);
    Assert.ok(!input.connection.tableExists("migration_source"));
  } finally {
    input.connection.rollbackTransaction();
  }
  await assertSourceUnchanged(input);
});

add_task(async function test_openDirectoryCannotBeUsedAsImportStage() {
  const input = await emptyStage();
  input.connection.close();
  input.connection = null;
  Services.prefs.setStringPref(input.pref + ".filename", input.filename);
  const book = new SQLiteDirectory();
  book.init("jsaddrbook://" + input.filename);
  try {
    Assert.throws(
      () =>
        SQLiteDirectory.importMorkSnapshot(
          book._dbConnection,
          input.bytes,
          SOURCE_ID
        ),
      /open in SQLiteDirectory/
    );
    Assert.equal(book.childCardCount, 0);
    Assert.ok(!book._dbConnection.tableExists("migration_source"));
  } finally {
    await book.cleanUp();
  }
  await assertSourceUnchanged(input);
});

add_task(async function test_incompleteMembershipRejectsBeforeStorage() {
  const input = await emptyStage();
  const original = new TextDecoder().decode(input.bytes);
  Assert.ok(original.includes("(^C7=1)"));
  const invalid = new TextEncoder().encode(
    original.replace("(^C7=1)", "(^C7=FF)")
  );
  Assert.throws(
    () =>
      SQLiteDirectory.importMorkSnapshot(input.connection, invalid, SOURCE_ID),
    error => error.name == "MorkImportError" && error.code == "MALFORMED_MORK"
  );
  Assert.equal(scalar(input.connection, "SELECT COUNT(*) FROM properties"), 0);
  Assert.equal(scalar(input.connection, "SELECT COUNT(*) FROM lists"), 0);
  Assert.ok(!input.connection.tableExists("migration_source"));
  Assert.deepEqual(seen, []);
  await assertSourceUnchanged(input);
});

add_task(async function test_stageFactoryNeverOverwritesAnExistingBook() {
  const input = await emptyStage();
  SQLiteDirectory.importMorkSnapshot(input.connection, input.bytes, SOURCE_ID);
  input.connection.close();
  input.connection = null;
  const before = await IOUtils.read(input.file.path);
  Assert.throws(
    () => SQLiteDirectory.createMigrationStage(input.file),
    error => error.result == Cr.NS_ERROR_FILE_ALREADY_EXISTS
  );
  Assert.deepEqual(await IOUtils.read(input.file.path), before);
  Assert.ok(!Services.prefs.prefHasUserValue(input.pref + ".filename"));
  await assertSourceUnchanged(input);
});

add_task(async function test_sourceIdentityTextIsNotNormalized() {
  const input = await emptyStage();
  const sourceId = "\uFEFFbook-source-e\u0301";
  const first = SQLiteDirectory.importMorkSnapshot(
    input.connection,
    input.bytes,
    sourceId
  );
  Assert.equal(first.sourceId, sourceId);
  const changes = scalar(input.connection, "SELECT total_changes()");
  Assert.deepEqual(
    SQLiteDirectory.importMorkSnapshot(input.connection, input.bytes, sourceId),
    first
  );
  Assert.equal(scalar(input.connection, "SELECT total_changes()"), changes);
  await assertSourceUnchanged(input);
});

add_task(async function test_unmappedUIDCannotAliasAnImportedCard() {
  const input = await emptyStage();
  const receipt = SQLiteDirectory.importMorkSnapshot(
    input.connection,
    input.bytes,
    SOURCE_ID
  );
  input.connection.close();
  input.connection = null;
  Services.prefs.setStringPref(input.pref + ".filename", input.filename);
  const book = new SQLiteDirectory();
  book.init("jsaddrbook://" + input.filename);
  try {
    const uid = receipt.cards[0][1];
    Assert.ok(book.loadMigrationProperties(uid));
    Assert.equal(book.loadMigrationProperties("\uFEFF" + uid), null);
  } finally {
    await book.cleanUp();
  }
  await assertSourceUnchanged(input);
});

add_task(async function test_normalCardTextBindingsPreserveBOMAndNUL() {
  const input = await emptyStage();
  input.connection.close();
  input.connection = null;
  Services.prefs.setStringPref(input.pref + ".filename", input.filename);
  const book = new SQLiteDirectory();
  book.init("jsaddrbook://" + input.filename);
  try {
    const card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
      Ci.nsIAbCard
    );
    const name = "\uFEFFcustom";
    const value = "\uFEFFvalue\0e\u0301";
    card.displayName = "\uFEFFRen\u00e9e";
    card.setProperty(name, value);
    await book.bulkAddCards([card]);
    const imported = book.getCardFromProperty(
      "DisplayName",
      card.displayName,
      true
    );
    Assert.ok(imported);
    Assert.equal(imported.getProperty(name, ""), value);
    Assert.equal(
      book.getCardFromProperty("\uFEFFDisplayName", card.displayName, true),
      null
    );
    Assert.deepEqual(
      book.getCardsFromProperty("\uFEFFDisplayName", card.displayName, true),
      []
    );
    Assert.equal(
      book.getCardFromProperty("DisplayName", card.displayName.slice(1), true),
      null
    );

    imported.displayName = "\uFEFFZo\u00eb";
    book.modifyCard(imported);
    Assert.equal(
      book.getCardFromProperty("DisplayName", imported.displayName, true).UID,
      imported.UID
    );
    Assert.equal(book.loadCardProperties(imported.UID).get(name), value);
  } finally {
    await book.cleanUp();
  }
  await assertSourceUnchanged(input);
});

add_task(function test_stageFactoryRequiresAnExistingParent() {
  const parent = do_get_profile().clone();
  parent.append("missing-book-parent-" + ++serial);
  const file = parent.clone();
  file.append("book.sqlite");
  Assert.ok(!parent.exists());
  Assert.throws(
    () => SQLiteDirectory.createMigrationStage(file),
    error => error.result == Cr.NS_ERROR_FILE_NOT_FOUND
  );
  Assert.ok(!parent.exists(), "A refused stage cannot create its parent");
  Assert.ok(!file.exists(), "A refused stage cannot create a database");
});

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  function test_migrationPathLinksOnlyAcceptProfileAncestors() {
    const profile = do_get_profile().clone();
    profile.normalize();
    const link = (target, path) => {
      const process = Cc["@mozilla.org/process/util;1"].createInstance(
        Ci.nsIProcess
      );
      const ln = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      ln.initWithPath("/bin/ln");
      process.init(ln);
      const args = ["-s", target, path];
      process.run(true, args, args.length);
      Assert.equal(process.exitValue, 0);
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(path);
      Assert.ok(file.isSymlink());
      return file;
    };
    const check = file =>
      SQLiteDirectory.checkMigrationPathLinks(file, "Refused migration link");
    const refused = error => error.message == "Refused migration link";

    // A system link outside the profile to one of its ancestors, like /var.
    const ancestor = link(
      profile.parent.path,
      PathUtils.join(PathUtils.tempDir, "ancestor-alias-" + ++serial)
    );
    const throughAncestor = ancestor.clone();
    throughAncestor.append(profile.leafName);
    check(throughAncestor);
    check(profile);

    // A link inside the profile is refused even when it resolves to an
    // ancestor of the profile.
    const inside = profile.clone();
    inside.append("inside-alias-" + ++serial);
    Assert.throws(() => check(link("/", inside.path)), refused);

    // An outside link that does not resolve to a profile ancestor is refused.
    const elsewhere = Services.dirsvc.get("TmpD", Ci.nsIFile);
    elsewhere.append("unrelated-" + ++serial);
    elsewhere.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
    const unrelated = link(
      elsewhere.path,
      PathUtils.join(PathUtils.tempDir, "unrelated-alias-" + serial)
    );
    Assert.throws(() => check(unrelated), refused);
  }
);

add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function test_windowsReceiptRetainsPhysicalStageAcrossReopen() {
    const input = await emptyStage();
    const first = SQLiteDirectory.importMorkSnapshot(
      input.connection,
      input.bytes,
      SOURCE_ID
    );
    const fs = Cc[
      "@mozilla.org/mailnews/panorama-migration-file-system;1"
    ].getService(Ci.nsIPanoramaMigrationFileSystem);
    const lease = fs.admit(
      input.file,
      input.file.parent,
      fs.KIND_FILE_OR_MISSING
    );
    try {
      Assert.deepEqual(first.stagePhysicalIdentity, {
        version: 1,
        id: lease.identity,
        parentId: lease.parentIdentity,
      });
      Assert.ok(/^[0-9a-f]{16}:[0-9a-f]{32}$/.test(lease.identity));
      fs.validate(lease);
    } finally {
      lease.close();
    }
    input.connection.close();
    input.connection = Services.storage.openUnsharedDatabase(input.file);
    const before = scalar(input.connection, "SELECT total_changes()");
    Assert.deepEqual(
      SQLiteDirectory.importMorkSnapshot(
        input.connection,
        input.bytes,
        SOURCE_ID
      ),
      first
    );
    Assert.equal(scalar(input.connection, "SELECT total_changes()"), before);
    Assert.deepEqual(seen, []);
    await assertSourceUnchanged(input);
  }
);

add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function test_windowsCopiedCompletedStageCannotReusePhysicalReceipt() {
    const input = await emptyStage();
    const first = SQLiteDirectory.importMorkSnapshot(
      input.connection,
      input.bytes,
      SOURCE_ID
    );
    input.connection.close();
    input.connection = null;
    const original = await IOUtils.read(input.file.path);
    const copy = input.file.parent;
    copy.append(input.filename + ".retained-copy");
    await IOUtils.copy(input.file.path, copy.path, { noOverwrite: true });
    Assert.deepEqual(await IOUtils.read(copy.path), original);
    const db = Services.storage.openUnsharedDatabase(copy);
    try {
      const before = scalar(db, "SELECT total_changes()");
      Assert.throws(
        () => SQLiteDirectory.importMorkSnapshot(db, input.bytes, SOURCE_ID),
        /Book stage physical identity changed/
      );
      Assert.equal(scalar(db, "SELECT total_changes()"), before);
      Assert.ok(!db.transactionInProgress);
      Assert.equal(
        scalar(db, "SELECT COUNT(DISTINCT card) FROM properties"),
        1
      );
      Assert.equal(scalar(db, "SELECT COUNT(*) FROM lists"), 1);
      Assert.equal(scalar(db, "SELECT COUNT(*) FROM list_cards"), 1);
    } finally {
      db.close();
    }
    input.connection = Services.storage.openUnsharedDatabase(input.file);
    Assert.deepEqual(
      SQLiteDirectory.importMorkSnapshot(
        input.connection,
        input.bytes,
        SOURCE_ID
      ),
      first,
      "The original stage and scoped UID maps still reconcile"
    );
    Assert.deepEqual(seen, []);
    await assertSourceUnchanged(input);
  }
);

/**
 * Exposes a changed real committed stage, then repairs only the injected damage.
 * The original .mab and its returned UIDs are never changed or regenerated.
 *
 * @param {Function} damage - Change one persisted destination fact.
 * @param {Function} repair - Restore that fact from the independent fixture oracle.
 * @param {string} field - Expected mismatch boundary.
 * @returns {Promise<void>}
 */
async function assertDamagedPrivateBookRefused(damage, repair, field) {
  const input = await emptyStage();
  const db = input.connection;
  const receipt = SQLiteDirectory.importMorkSnapshot(
    db,
    input.bytes,
    SOURCE_ID
  );
  damage(db, receipt);
  const changes = scalar(db, "SELECT total_changes()");
  try {
    Assert.throws(
      () => SQLiteDirectory.importMorkSnapshot(db, input.bytes, SOURCE_ID),
      new RegExp("Staged book differs: " + field)
    );
    Assert.equal(scalar(db, "SELECT total_changes()"), changes);
    Assert.ok(!db.transactionInProgress);
    Assert.deepEqual(seen, [], "Invalid private stages publish nothing");
    await assertSourceUnchanged(input);
  } finally {
    repair(db, receipt);
  }
  const repairedChanges = scalar(db, "SELECT total_changes()");
  Assert.deepEqual(
    SQLiteDirectory.importMorkSnapshot(db, input.bytes, SOURCE_ID),
    receipt,
    "The original source-scoped UIDs survive repair and read-only retry"
  );
  Assert.equal(scalar(db, "SELECT total_changes()"), repairedChanges);
  Assert.deepEqual(seen, []);
  await assertSourceUnchanged(input);
}

add_task(async function test_repeatRejectsChangedRawPresentEmptyText() {
  await assertDamagedPrivateBookRefused(
    db =>
      db.executeSimpleSQL(
        "UPDATE migration_properties SET value=char(65279)||'changed'||char(0)||'e'||char(769) WHERE kind='card' AND name='Notes'"
      ),
    db =>
      db.executeSimpleSQL(
        "UPDATE migration_properties SET value='' WHERE kind='card' AND name='Notes'"
      ),
    "raw properties"
  );
});

add_task(async function test_repeatRejectsMissingRawPresentEmptyCell() {
  await assertDamagedPrivateBookRefused(
    db =>
      db.executeSimpleSQL(
        "DELETE FROM migration_properties WHERE kind='card' AND name='Notes'"
      ),
    db =>
      db.executeSimpleSQL(
        "INSERT INTO migration_properties VALUES('card','1','Notes','')"
      ),
    "raw properties"
  );
});

add_task(async function test_repeatRejectsUnmappedRawRecord() {
  await assertDamagedPrivateBookRefused(
    db =>
      db.executeSimpleSQL(
        "INSERT INTO migration_records VALUES('unmapped','foreign',NULL)"
      ),
    db =>
      db.executeSimpleSQL(
        "DELETE FROM migration_records WHERE kind='unmapped' AND sourceKey='foreign'"
      ),
    "records"
  );
});

add_task(async function test_repeatRejectsChangedNormalCardProjection() {
  await assertDamagedPrivateBookRefused(
    db =>
      db.executeSimpleSQL(
        "UPDATE properties SET value='changed destination' WHERE name='DisplayName'"
      ),
    db =>
      db.executeSimpleSQL(
        "UPDATE properties SET value='contact number one' WHERE name='DisplayName'"
      ),
    "card projection"
  );
});

add_task(async function test_repeatRejectsChangedNormalListProjection() {
  await assertDamagedPrivateBookRefused(
    db => db.executeSimpleSQL("UPDATE lists SET name='changed destination'"),
    db => db.executeSimpleSQL("UPDATE lists SET name='list'"),
    "list projection"
  );
});

add_task(async function test_repeatRejectsMissingListMembership() {
  await assertDamagedPrivateBookRefused(
    db => db.executeSimpleSQL("DELETE FROM list_cards"),
    (db, receipt) => {
      const statement = db.createStatement(
        "INSERT INTO list_cards VALUES(:list,:card)"
      );
      try {
        statement.params.list = receipt.lists[0][1];
        statement.params.card = receipt.cards[0][1];
        statement.execute();
      } finally {
        statement.finalize();
      }
    },
    "list membership"
  );
});

add_task(
  async function test_validateMigrationBookRequiresClosedReadOnlyStage() {
    const input = await emptyStage();
    const receipt = SQLiteDirectory.importMorkSnapshot(
      input.connection,
      input.bytes,
      SOURCE_ID
    );
    Assert.throws(
      () =>
        SQLiteDirectory.validateMigrationBook(
          input.file,
          input.bytes,
          SOURCE_ID
        ),
      /SQLite sidecar/,
      "The actual open WAL stage cannot be copied as a closed book"
    );
    input.connection.close();
    input.connection = null;
    const wal = input.file.clone();
    wal.leafName += "-wal";
    if (wal.exists()) {
      Assert.ok(wal.isFile(), "Native retained WAL is a regular file");
      Assert.equal(wal.fileSize, 0, "Real close leaves no WAL page data");
    }
    const before = await IOUtils.read(input.file.path);
    Assert.deepEqual(
      SQLiteDirectory.validateMigrationBook(input.file, input.bytes, SOURCE_ID),
      receipt
    );
    // An empty native auxiliary is safe; actual retained page bytes are not.
    const hadWal = wal.exists();
    const originalWal = hadWal ? await IOUtils.read(wal.path) : null;
    try {
      await IOUtils.write(wal.path, new Uint8Array([1]));
      Assert.throws(
        () =>
          SQLiteDirectory.validateMigrationBook(
            input.file,
            input.bytes,
            SOURCE_ID
          ),
        /data-bearing SQLite sidecar/,
        "A closed-looking stage with WAL bytes is refused without recovery"
      );
      Assert.deepEqual(await IOUtils.read(wal.path), new Uint8Array([1]));
    } finally {
      if (hadWal) {
        await IOUtils.write(wal.path, originalWal);
      } else {
        await IOUtils.remove(wal.path);
      }
    }
    Assert.deepEqual(await IOUtils.read(input.file.path), before);
    Assert.deepEqual(seen, [], "Readback emits no publication events");
    Assert.throws(
      () =>
        SQLiteDirectory.validateMigrationBook(
          input.file,
          new Uint8Array([...input.bytes, 10]),
          SOURCE_ID
        ),
      /source identity changed/,
      "A changed original snapshot cannot validate the committed book"
    );
    Assert.deepEqual(await IOUtils.read(input.file.path), before);
    await assertSourceUnchanged(input);
  }
);

add_task(
  async function test_validateMigrationBookDoesNotInitializeProvenance() {
    const input = await emptyStage();
    input.connection.close();
    input.connection = null;
    const before = await IOUtils.read(input.file.path);
    Assert.throws(
      () =>
        SQLiteDirectory.validateMigrationBook(
          input.file,
          input.bytes,
          SOURCE_ID
        ),
      /Incomplete book import provenance/
    );
    Assert.deepEqual(await IOUtils.read(input.file.path), before);
    const db = Services.storage.openUnsharedDatabase(input.file);
    try {
      Assert.equal(db.schemaVersion, 4);
      Assert.ok(!db.tableExists("migration_source"));
      Assert.ok(!db.tableExists("migration_records"));
      Assert.ok(!db.tableExists("migration_properties"));
      Assert.equal(scalar(db, "SELECT COUNT(*) FROM properties"), 0);
    } finally {
      db.close();
    }
    Assert.deepEqual(seen, []);
    await assertSourceUnchanged(input);
  }
);

add_task(
  async function test_validateMigrationBookReusesOnlySettledLiveConnection() {
    const input = await emptyStage();
    const receipt = SQLiteDirectory.importMorkSnapshot(
      input.connection,
      input.bytes,
      SOURCE_ID
    );
    input.connection.close();
    input.connection = null;
    Services.prefs.setStringPref(input.pref + ".filename", input.filename);
    const book = new SQLiteDirectory();
    book.init("jsaddrbook://" + input.filename);
    try {
      Assert.throws(
        () =>
          SQLiteDirectory.validateMigrationBook(
            input.file,
            input.bytes,
            SOURCE_ID
          ),
        /active directory connection/
      );
      const db = book._dbConnection;
      const changes = scalar(db, "SELECT total_changes()");
      Assert.deepEqual(
        SQLiteDirectory.validateMigrationBook(
          input.file,
          input.bytes,
          SOURCE_ID,
          {
            requireClosed: false,
          }
        ),
        receipt
      );
      Assert.equal(scalar(db, "SELECT total_changes()"), changes);
      Assert.ok(
        db.connectionReady,
        "Readback retains the real directory owner"
      );
      db.beginTransaction();
      try {
        Assert.throws(
          () =>
            SQLiteDirectory.validateMigrationBook(
              input.file,
              input.bytes,
              SOURCE_ID,
              {
                requireClosed: false,
              }
            ),
          /settled schema-4 database/
        );
        Assert.ok(
          db.transactionInProgress,
          "The foreign transaction remains owned"
        );
      } finally {
        db.rollbackTransaction();
      }
      const card = book.getCard(receipt.cards[0][1]);
      card.displayName = "Changed actual public projection";
      book.modifyCard(card);
      Assert.throws(
        () =>
          SQLiteDirectory.validateMigrationBook(
            input.file,
            input.bytes,
            SOURCE_ID,
            {
              requireClosed: false,
            }
          ),
        /Staged book differs/,
        "A changed live projection is not repaired or silently reimported"
      );
      Assert.equal(
        book.getCard(card.UID).displayName,
        "Changed actual public projection"
      );
    } finally {
      await book.cleanUp();
    }
    await assertSourceUnchanged(input);
  }
);
