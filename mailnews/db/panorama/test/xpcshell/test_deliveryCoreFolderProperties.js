/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

const { MailStringUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailStringUtils.sys.mjs"
);

let dbFile;
let root;

add_setup(function () {
  dbFile = do_get_profile().clone();
  dbFile.append("panorama.sqlite");
  Assert.ok(!dbFile.exists(), "DatabaseCore must create the schema");
  loadExistingDB();
  PanoramaDelivery.assertBackend(PanoramaDelivery.expectedLane().backend);
  Assert.equal(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    ),
    database,
    "The account manager selected Panorama as the database service"
  );
  Assert.equal(database.connectionForTests.databaseFile.path, dbFile.path);

  // These cases exercise property metadata; the body store is incidental.
  const account = MailServices.accounts.createLocalMailAccount();
  registerCleanupFunction(() => MailServices.accounts.removeAccount(account));
  root = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
});

/**
 * Read committed rows through a separate connection to the profile database.
 *
 * @param {string} sql - A SELECT statement with no parameters.
 * @param {string[]} columns - Columns to include in each returned row.
 * @returns {Array<Array<string|number|null>>} The selected values.
 */
function readStoredRows(sql, columns) {
  const connection = Services.storage.openUnsharedDatabase(dbFile);
  try {
    const stmt = connection.createStatement(sql);
    try {
      const rows = [];
      while (stmt.executeStep()) {
        rows.push(columns.map(column => stmt.row[column]));
      }
      return rows;
    } finally {
      stmt.finalize();
    }
  } finally {
    connection.close();
  }
}

add_task(function test_persistFolderPropertiesByIdentity() {
  const first = root.createLocalSubfolder("delivery-first");
  const second = root.createLocalSubfolder("delivery-second");
  Assert.notEqual(first.id, second.id);
  Assert.equal(folderDB.getFolderParent(first.id), root.id);
  Assert.equal(folderDB.getFolderParent(second.id), root.id);

  Assert.equal(first.getStringProperty("delivery.missing"), "");
  first.setStringProperty(
    MailStringUtils.stringToByteString("delivery.café"),
    "old value"
  );
  first.setStringProperty(
    MailStringUtils.stringToByteString("delivery.cafe\u0301"),
    "previous value"
  );
  first.setStringProperty(
    MailStringUtils.stringToByteString("delivery.cafe\u0301"),
    "raw cafe\u0301 value"
  );
  first.setStringProperty("delivery.case", "previous value");
  first.setStringProperty("delivery.Case", "upper value");
  first.setStringProperty("delivery.case", "lower value");
  first.setStringProperty("delivery.leading", "00042");
  first.setStringProperty("delivery.exponent", "1e3");
  first.setStringProperty("delivery.empty", "old value");
  first.setStringProperty("delivery.empty", "");
  second.setStringProperty(
    MailStringUtils.stringToByteString("delivery.café"),
    "second value"
  );
  second.setStringProperty(
    MailStringUtils.stringToByteString("delivery.cafe\u0301"),
    "second decomposed value"
  );

  const expectedFirst = [
    ["delivery.Case", "upper value"],
    ["delivery.cafe\u0301", "raw cafe\u0301 value"],
    ["delivery.café", "old value"],
    ["delivery.case", "lower value"],
    ["delivery.empty", ""],
    ["delivery.exponent", "1e3"],
    ["delivery.leading", "00042"],
  ];
  const expectedSecond = [
    ["delivery.cafe\u0301", "second decomposed value"],
    ["delivery.café", "second value"],
  ];
  Assert.deepEqual(
    {
      first: expectedFirst.map(([name]) => [
        name,
        first.getStringProperty(MailStringUtils.stringToByteString(name)),
      ]),
      second: expectedSecond.map(([name]) => [
        name,
        second.getStringProperty(MailStringUtils.stringToByteString(name)),
      ]),
      secondEmpty: second.getStringProperty("delivery.empty"),
      stored: readStoredRows(
        "SELECT id, name, value FROM folder_properties " +
          "WHERE name LIKE 'delivery.%' ORDER BY id, name",
        ["id", "name", "value"]
      ),
    },
    {
      first: expectedFirst,
      second: expectedSecond,
      secondEmpty: "",
      stored: [
        ...expectedFirst.map(([name, text]) => [first.id, name, text]),
        ...expectedSecond.map(([name, text]) => [second.id, name, text]),
      ],
    },
    "Exact property names and overwrites preserve values within each folder"
  );
});

add_task(function test_copyPreservesExactPropertyNamesAndPresence() {
  const source = root.createLocalSubfolder("property-copy-source");
  const destination = root.createLocalSubfolder("property-copy-destination");
  const sourceDB = source.msgDatabase;
  const destinationDB = destination.msgDatabase;
  const draft = sourceDB.createNewHdr();
  draft.messageId = "properties-copy@invalid";
  draft.subject = "Exact property copy";
  const properties = [
    ["delivery.copy.Case", "ffffffff", 0xffffffff],
    ["delivery.copy.cafe\u0301", "1e3", 483],
    ["delivery.copy.café", "00042", 66],
    ["delivery.copy.case", "2a", 42],
    ["delivery.copy.empty", "", 0],
    ["delivery.copy.invalid", "xyz", 0],
    ["delivery.copy.limit", "100000000", 0x10000000],
  ];
  for (const [name, text] of properties) {
    draft.setStringProperty(MailStringUtils.stringToByteString(name), text);
  }
  const original = sourceDB.attachHdr(draft, false);
  const copy = destinationDB.copyHdrFromExistingHdr(0xffffffff, original, true);
  Assert.ok(copy.isLive);
  Assert.notEqual(copy.messageKey, original.messageKey);
  Assert.equal(original.folder, source);
  Assert.equal(copy.folder, destination);
  Assert.deepEqual(sourceDB.listAllKeys(), [original.messageKey]);
  Assert.deepEqual(destinationDB.listAllKeys(), [copy.messageKey]);
  const expectedNames = properties.map(([name]) => name).toSorted();
  for (const header of [original, copy]) {
    Assert.deepEqual(
      properties.map(([name]) => [
        name,
        header.getStringProperty(MailStringUtils.stringToByteString(name)),
        header.getUint32Property(MailStringUtils.stringToByteString(name)),
      ]),
      properties,
      "Copy preserves both public getter views for every exact property name"
    );
    Assert.deepEqual(
      header.properties
        .filter(name => name.startsWith("delivery.copy."))
        .toSorted(),
      expectedNames
    );
    Assert.equal(header.getStringProperty("delivery.copy.missing"), "");
    Assert.equal(header.getUint32Property("delivery.copy.missing"), 0);
    Assert.ok(!header.properties.includes("delivery.copy.missing"));
    Assert.ok(header.properties.includes("delivery.copy.empty"));
  }
  Assert.deepEqual(
    readStoredRows(
      "SELECT id, name, value, typeof(value) AS valueType FROM message_properties " +
        "WHERE name LIKE 'delivery.copy.%' ORDER BY id, name",
      ["id", "name", "value", "valueType"]
    ),
    [original.messageKey, copy.messageKey].flatMap(key =>
      properties.map(([name, text]) => [key, name, text, "text"])
    ),
    "Both independently committed rows retain exact names and supplied text"
  );
  copy.setStringProperty(
    MailStringUtils.stringToByteString("delivery.copy.café"),
    "independent overwrite"
  );
  Assert.equal(
    original.getStringProperty(
      MailStringUtils.stringToByteString("delivery.copy.café")
    ),
    "00042"
  );
  Assert.equal(
    original.getUint32Property(
      MailStringUtils.stringToByteString("delivery.copy.café")
    ),
    66
  );
  const fetched = messageDB.getMessage(copy.messageKey);
  Assert.equal(
    fetched.getStringProperty(
      MailStringUtils.stringToByteString("delivery.copy.café")
    ),
    "independent overwrite"
  );
  Assert.equal(
    fetched.getUint32Property(
      MailStringUtils.stringToByteString("delivery.copy.café")
    ),
    0
  );
  Assert.equal(
    messageDB.getMessageProperty(copy.messageKey, "delivery.copy.cafe\u0301"),
    "1e3",
    "The NFC-equivalent different key is not overwritten"
  );
});

add_task(function test_copyPropertyReadFailurePreservesSourceAndDestination() {
  const source = root.createLocalSubfolder("property-copy-error-source");
  const destination = root.createLocalSubfolder(
    "property-copy-error-destination"
  );
  const draft = source.msgDatabase.createNewHdr();
  draft.messageId = "property-copy-error@invalid";
  draft.setStringProperty("delivery.copy.control", "00042");
  const original = source.msgDatabase.attachHdr(draft, false);
  const destinationDB = destination.msgDatabase;
  const connection = database.connectionForTests;
  const beforeCount = messageDB.totalCount;
  const sql =
    "SELECT id, name, value FROM message_properties ORDER BY id, name";
  const columns = ["id", "name", "value"];
  const before = readStoredRows(sql, columns);
  Assert.deepEqual(destinationDB.listAllKeys(), []);
  Assert.ok(!connection.transactionInProgress);

  connection.executeSimpleSQL(
    "ALTER TABLE message_properties RENAME TO property_copy_saved"
  );
  let viewCreated = false;
  try {
    // Valid SQL whose property-name evaluation fails on the actual source row.
    connection.executeSimpleSQL(
      "CREATE VIEW message_properties AS SELECT id, " +
        "CAST(abs(-9223372036854775808) AS TEXT) AS name, value " +
        "FROM property_copy_saved"
    );
    viewCreated = true;
    Assert.throws(
      () => destinationDB.copyHdrFromExistingHdr(0xffffffff, original, true),
      error => error.result == Cr.NS_ERROR_FAILURE,
      "A source property read failure propagates instead of copying absent properties"
    );
    Assert.deepEqual(destinationDB.listAllKeys(), []);
    Assert.equal(messageDB.totalCount, beforeCount);
    Assert.ok(!connection.transactionInProgress);
  } finally {
    if (viewCreated) {
      connection.executeSimpleSQL("DROP VIEW message_properties");
    }
    connection.executeSimpleSQL(
      "ALTER TABLE property_copy_saved RENAME TO message_properties"
    );
  }
  Assert.deepEqual(readStoredRows(sql, columns), before);
  Assert.deepEqual(source.msgDatabase.listAllKeys(), [original.messageKey]);
  Assert.equal(original.getStringProperty("delivery.copy.control"), "00042");
  Assert.deepEqual(destinationDB.listAllKeys(), []);
  Assert.ok(!connection.transactionInProgress);
});
