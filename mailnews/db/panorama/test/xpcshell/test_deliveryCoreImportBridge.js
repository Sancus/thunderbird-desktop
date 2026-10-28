/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
const { ProfileCreator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ProfileCreator.sys.mjs"
);
const { MailStringUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailStringUtils.sys.mjs"
);

const { readMorkFolderImport } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MorkFolderImport.sys.mjs"
);
const { convertMorkFolderSnapshot } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MorkSnapshotAdapter.sys.mjs"
);

let importFolders;
let importControl;

add_setup(async function () {
  const profileDir = do_get_profile();
  const empty = profileDir.clone();
  empty.append("converted-input");
  await IOUtils.write(empty.path, new Uint8Array());
  const profile = new ProfileCreator(profileDir);
  const server = await profile.addLocalServer();
  for (const name of [
    "fields",
    "repeat",
    "failure",
    "invalid",
    "records",
    "read",
  ]) {
    // Explicit converted-input units, not manufactured legacy Mork fixtures.
    await server.rootFolder.addMailFolder(name, {
      summary: empty,
      mbox: empty,
    });
  }
  for (const name of [
    "whole",
    "whole-properties",
    "whole-reject",
    "whole-alias",
    "whole-summary-link",
    "whole-store-link",
    "whole-missing-store",
  ]) {
    await server.rootFolder.addMailFolder(name, {
      summary: do_get_file("data/migration.msf"),
      mbox: do_get_file("data/migration"),
    });
  }
  loadExistingDB();
  MailServices.accounts.accounts;
  Assert.equal(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    ),
    database
  );
  const root = MailServices.accounts.localFoldersServer.rootFolder;
  importFolders = new Map(
    ["fields", "repeat", "failure", "invalid", "records", "read"].map(name => [
      name,
      root.getChildNamed(name),
    ])
  );
  for (const name of [
    "whole",
    "whole-properties",
    "whole-reject",
    "whole-alias",
    "whole-summary-link",
    "whole-store-link",
    "whole-missing-store",
  ]) {
    importFolders.set(name, root.getChildNamed(name));
  }
  Assert.equal(importFolders.get("fields").msgStore.storeType, "mbox");
  const folder = folderDB.insertFolder(root.id, "control");
  importControl = messageDB.addMessage(
    folder,
    "unrelated",
    [],
    0,
    "",
    "",
    "",
    "",
    "control",
    0,
    "",
    0
  );
  registerCleanupFunction(() => {
    importFolders = null;
  });
});

/**
 * Creates owned converted input over an actual folder's empty summary file.
 * Raw record cells use the migration reader's byte-string representation.
 *
 * @param {string} name - Fixture folder and stable source-unit name.
 * @returns {Promise<Awaited<ReturnType<typeof import("resource:///modules/panorama/MorkFolderImport.sys.mjs").readMorkFolderImport>> & {sourceId: string, databaseSourceId: string}>}
 *   Version1 request with stable journal and database identities.
 */
async function importInput(name) {
  const folder = importFolders.get(name);
  const header = {
    messageId: "child",
    references: ["older", "missing", "older"],
    date: 123456000000,
    dateReceived: -1000000,
    sender: "sender",
    recipients: "recipient",
    ccList: "",
    bccList: "",
    subject: "child",
    flags: 1,
    keywords: "initial",
    priority: Ci.nsMsgPriority.highest,
    charset: "UTF-8",
    accountKey: "account",
    storeToken: "",
    messageSize: 0,
    offlineMessageSize: 0,
    lineCount: 0,
    extras: [
      { k: "Foo", v: "old" },
      { k: "foo", v: "1e3" },
      { k: "é", v: "composed" },
      { k: "e\u0301", v: "" },
      { k: "Foo", v: "00042" },
      { k: "keywords", v: "first" },
      { k: "keywords", v: "last" },
      { k: "messageSize", v: "999" },
    ],
  };
  const root = { ...header, messageId: "root", subject: "root", extras: [] };
  delete root.storeToken;
  delete root.messageSize;
  delete root.offlineMessageSize;
  delete root.lineCount;
  const messages = [
    { sourceKey: 9, rootSourceKey: 0, parentSourceKey: 0, header },
    { sourceKey: 0, rootSourceKey: 0, parentSourceKey: null, header: root },
  ];
  const scope = "ns:msg:db:row:scope:msgs:all";
  return {
    version: 1,
    token: "import-" + name,
    sourceId: name,
    databaseSourceId: database.sourceId,
    folder: {
      id: folder.id,
      uri: folder.URI,
      summaryPath: folder.summaryFile.path,
      storePath: folder.filePath.path,
      storeType: folder.msgStore.storeType,
      protocol: folder.server.getStringValue("type"),
      storeExists: await IOUtils.exists(folder.filePath.path),
    },
    source: {
      path: folder.summaryFile.path,
      size: 0,
      sha256: await IOUtils.computeHexDigest(folder.summaryFile.path, "sha256"),
      messageKeys: [9, 0],
    },
    messages,
    records: {
      rows: messages.map(({ sourceKey, header: data }) => ({
        id: sourceKey,
        scope,
        cells: data.extras.map(({ k, v }) => ({
          k: MailStringUtils.stringToByteString(k),
          v: MailStringUtils.stringToByteString(v),
        })),
      })),
      tables: [
        {
          id: 1,
          scope,
          cells: [
            { k: "k", v: "ns:msg:db:table:kind:msgs" },
            { k: "s", v: "9" },
          ],
          rows: ["9:" + scope, "0:" + scope],
          metaRow: null,
        },
      ],
    },
  };
}

add_task(async function test_importFolderSnapshotPreservesCompleteFields() {
  const folder = importFolders.get("fields");
  const input = await importInput("fields");
  Assert.equal(database.getFolderImportReceipt(folder, input), null);
  const receipt = await database.importFolderSnapshot(folder, input);
  Assert.equal(receipt.databaseSourceId, database.sourceId);
  Assert.equal(receipt.folderId, folder.id);
  Assert.deepEqual(
    receipt.keys.map(pair => pair[0]),
    [0, 9]
  );
  const [[, rootKey], [, childKey]] = receipt.keys;
  Assert.notEqual(rootKey, childKey);
  Assert.ok(rootKey > 0 && childKey > 0);
  const child = messageDB.getMessage(childKey);
  Assert.equal(child.messageId, "child");
  Assert.equal(child.threadId, rootKey);
  Assert.equal(child.threadParent, rootKey);
  Assert.equal(child.priority, Ci.nsMsgPriority.highest);
  Assert.equal(child.storeToken, "");
  Assert.equal(child.messageSize, 0);
  Assert.equal(child.offlineMessageSize, 0);
  Assert.equal(child.lineCount, 0);
  Assert.equal(child.getStringProperty("Foo"), "00042");
  Assert.equal(child.getStringProperty("foo"), "1e3");
  Assert.equal(messageDB.getMessageProperty(childKey, "é"), "composed");
  Assert.equal(messageDB.getMessageProperty(childKey, "e\u0301"), "");
  const childNames = [...child.properties];
  Assert.ok(childNames.includes("é"));
  Assert.ok(childNames.includes("e\u0301"));
  Assert.equal(child.getStringProperty("keywords"), "last");
  Assert.equal(child.getStringProperty("dateReceived"), "ffffffff");
  Assert.deepEqual(
    Array.from({ length: child.numReferences }, (_, index) =>
      child.getStringReference(index)
    ),
    ["older", "missing", "older"]
  );
  const absent = messageDB.getMessage(rootKey);
  const names = [...absent.properties];
  for (const name of [
    "storeToken",
    "messageSize",
    "offlineMessageSize",
    "lineCount",
  ]) {
    Assert.ok(!names.includes(name), name + " remains absent");
  }
  Assert.ok(messageDB.getSearchState(importControl));
});

add_task(async function test_getFolderImportReceiptAndRepeatRetainIdentity() {
  const folder = importFolders.get("repeat");
  const input = await importInput("repeat");
  const receipt = await database.importFolderSnapshot(folder, input);
  const key = receipt.keys[0][1];
  messageDB.getMessage(key).setStringProperty("later", "retained");
  Assert.deepEqual(await database.importFolderSnapshot(folder, input), receipt);
  Assert.deepEqual(database.getFolderImportReceipt(folder, input), receipt);
  Assert.equal(
    messageDB.getMessage(key).getStringProperty("later"),
    "retained"
  );
  const conflicting = structuredClone(input);
  conflicting.sourceId = "different-source";
  Assert.throws(
    () => database.getFolderImportReceipt(folder, conflicting),
    /NS_ERROR_ALREADY_INITIALIZED/
  );
  conflicting.databaseSourceId = "replaced-database";
  Assert.throws(
    () => database.getFolderImportReceipt(folder, conflicting),
    /NS_ERROR_NOT_AVAILABLE/
  );
});

add_task(async function test_importFolderSnapshotReceiptFailureIsAtomic() {
  const folder = importFolders.get("failure");
  const input = await importInput("failure");
  const count = messageDB.totalCount;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER fail_public_import BEFORE INSERT ON folder_import_receipts BEGIN SELECT RAISE(ABORT, 'receipt failure'); END"
  );
  try {
    await Assert.rejects(
      database.importFolderSnapshot(folder, input),
      /NS_ERROR_STORAGE_CONSTRAINT/
    );
    Assert.equal(messageDB.totalCount, count);
    Assert.equal(database.getFolderImportReceipt(folder, input), null);
    Assert.ok(!connection.transactionInProgress);
    Assert.ok(messageDB.getSearchState(importControl));
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER fail_public_import");
  }
  const receipt = await database.importFolderSnapshot(folder, input);
  Assert.equal(receipt.keys.length, 2);
  Assert.equal(messageDB.totalCount, count + 2);
});

add_task(
  async function test_importFolderSnapshotRejectsInvalidConvertedValues() {
    const folder = importFolders.get("invalid");
    const baseline = await importInput("invalid");
    const count = messageDB.totalCount;
    const edits = [
      input => {
        input.messages[0].header.messageSize = undefined;
      },
      input => {
        input.messages[0].header.key = 0;
      },
      input => {
        input.messages[0].header.date = Infinity;
      },
      input => {
        input.messages[0].sourceKey = 0.5;
      },
      input => {
        input.source.messageKeys = [0, 9];
      },
      input => {
        input.messages[0].rootSourceKey = 8;
      },
      input => {
        input.messages[1].parentSourceKey = 9;
      },
      input => {
        input.messages[0].header.extras[0].k = "\ud800";
      },
    ];
    for (const edit of edits) {
      const input = structuredClone(baseline);
      edit(input);
      Assert.throws(
        () => database.importFolderSnapshot(folder, input),
        error => error.result == Cr.NS_ERROR_INVALID_ARG
      );
      Assert.equal(messageDB.totalCount, count);
      Assert.equal(database.getFolderImportReceipt(folder, baseline), null);
    }
    const throwing = structuredClone(baseline);
    Object.defineProperty(throwing.messages[0].header, "subject", {
      get() {
        throw new Error("conversion getter failure");
      },
    });
    Assert.throws(
      () => database.importFolderSnapshot(folder, throwing),
      /conversion getter failure/
    );
    Assert.equal(messageDB.totalCount, count);
    const connection = database.connectionForTests;
    connection.beginTransaction();
    try {
      Assert.throws(
        () => database.importFolderSnapshot(folder, baseline),
        /NS_ERROR_IN_PROGRESS/
      );
      Assert.throws(
        () => database.getFolderImportReceipt(folder, baseline),
        /NS_ERROR_IN_PROGRESS/
      );
      Assert.ok(connection.transactionInProgress);
    } finally {
      connection.rollbackTransaction();
    }
    const wrongStore = structuredClone(baseline);
    wrongStore.folder.storePath += ".different";
    Assert.throws(
      () => database.importFolderSnapshot(folder, wrongStore),
      /NS_ERROR_NOT_AVAILABLE/
    );
    Assert.equal(
      (await database.importFolderSnapshot(folder, baseline)).keys.length,
      2
    );
  }
);

add_task(async function test_importFolderSnapshotRejectsUnsupportedRecords() {
  const folder = importFolders.get("records");
  const baseline = await importInput("records");
  const count = messageDB.totalCount;
  const folderInfo = structuredClone(baseline);
  folderInfo.records.rows[0].scope = "ns:msg:db:row:scope:dbfolderinfo:all";
  Assert.throws(
    () => database.importFolderSnapshot(folder, folderInfo),
    /NS_ERROR_NOT_IMPLEMENTED/
  );
  const thread = structuredClone(baseline);
  thread.records.tables[0].cells[0].v = "ns:msg:db:table:kind:thread";
  Assert.throws(
    () => database.importFolderSnapshot(folder, thread),
    /NS_ERROR_NOT_IMPLEMENTED/
  );
  const altered = structuredClone(baseline);
  altered.records.rows[0].cells[0].v = "unaccounted";
  Assert.throws(
    () => database.importFolderSnapshot(folder, altered),
    error => error.result == Cr.NS_ERROR_INVALID_ARG
  );
  Assert.equal(messageDB.totalCount, count);
  Assert.equal(database.getFolderImportReceipt(folder, baseline), null);
  Assert.ok(messageDB.getSearchState(importControl));
});

add_task(async function test_getFolderImportReceiptPropagatesSqlErrors() {
  const folder = importFolders.get("read");
  const input = await importInput("read");
  const receipt = await database.importFolderSnapshot(folder, input);
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP VIEW folder_import_keys AS SELECT token, sourceKey, abs(-9223372036854775808) AS destinationKey FROM main.folder_import_keys"
  );
  try {
    Assert.throws(
      () => database.getFolderImportReceipt(folder, input),
      /NS_ERROR_FAILURE/
    );
  } finally {
    connection.executeSimpleSQL("DROP VIEW temp.folder_import_keys");
  }
  Assert.deepEqual(database.getFolderImportReceipt(folder, input), receipt);
});

/**
 * Converts the genuine existing fixture through the migration owner's reader.
 *
 * @param {string} name - Fixture folder name.
 * @returns {Promise<object>} Fully accounted version1 native input.
 */
async function fullImportInput(name) {
  const folder = importFolders.get(name);
  const input = await readMorkFolderImport(folder, "whole-" + name);
  return convertMorkFolderSnapshot(
    input,
    {
      id: name,
      token: input.token,
      databaseSourceId: database.sourceId,
      destinationFolderId: folder.id,
      path: input.source.path,
      sha256: input.source.sha256,
      size: input.source.size,
      messageKeys: [...input.source.messageKeys],
      state: "importing",
    },
    database.sourceId,
    folder.flags
  );
}

/**
 * Checks conversion rejection before any native import transaction or receipt.
 *
 * @param {object} input - Owned converted input with an invalid correspondence.
 * @param {number} code - Expected conversion error.
 */
function assertFullImportRejected(input, code) {
  const folder = importFolders.get("whole-reject");
  const count = messageDB.totalCount;
  Assert.throws(
    () => database.importFolderSnapshot(folder, input),
    error => error.result == code
  );
  Assert.equal(messageDB.totalCount, count);
  Assert.equal(database.getFolderImportReceipt(folder, input), null);
  Assert.ok(!database.connectionForTests.transactionInProgress);
  Assert.ok(messageDB.getSearchState(importControl));
}

add_task(async function test_importFullSnapshotUsesScopedSourceIdentity() {
  const folder = importFolders.get("whole");
  const input = await fullImportInput("whole");
  const summary = await IOUtils.read(folder.summaryFile.path);
  const body = await IOUtils.read(folder.filePath.path);
  input.records.rows.reverse();
  input.records.tables.reverse();
  for (const row of [...input.records.rows, ...input.records.tables]) {
    row.cells.reverse();
  }
  input.source.messageKeys.reverse();
  const receipt = await database.importFolderSnapshot(folder, input);
  Assert.deepEqual(
    receipt.keys.map(pair => pair[0]),
    [1, 3]
  );
  Assert.notEqual(receipt.keys[0][1], receipt.keys[1][1]);
  const messages = receipt.keys.map(([, key]) => messageDB.getMessage(key));
  Assert.deepEqual(
    messages.map(header => [
      header.messageId,
      header.storeToken,
      header.messageSize,
    ]),
    [
      ["162378@invalid", "0", 578],
      ["345692@invalid", "1143", 375],
    ]
  );
  Assert.ok(messages.every(header => header.threadId && !header.threadParent));
  Assert.notEqual(messages[0].threadId, messages[1].threadId);
  Assert.equal(
    folder.msgDatabase.dBFolderInfo.getUint32Property("sortType", 0),
    18
  );
  Assert.deepEqual(await database.importFolderSnapshot(folder, input), receipt);
  Assert.deepEqual(await IOUtils.read(folder.summaryFile.path), summary);
  Assert.deepEqual(await IOUtils.read(folder.filePath.path), body);
});

add_task(async function test_importFullSnapshotKeepsExactTextAndReferences() {
  const folder = importFolders.get("whole-properties");
  const input = await fullImportInput("whole-properties");
  const info = input.records.rows.find(row =>
    row.scope.endsWith("dbfolderinfo:all")
  );
  // Change the owned converted model, never the original MSF/body bytes.
  const properties = [
    { name: "unknown", text: "2a" },
    { name: "leading", text: "00042" },
    { name: "exponent", text: "1e3" },
    { name: "é", text: "composed" },
    { name: "e\u0301", text: "" },
  ];
  for (const property of properties) {
    info.cells.push({
      k: MailStringUtils.stringToByteString(property.name),
      v: MailStringUtils.stringToByteString(property.text),
    });
    input.folderProperties.push(property);
  }
  const message = input.messages[0];
  const row = input.records.rows.find(
    record =>
      record.id == message.sourceKey && record.scope.endsWith("msgs:all")
  );
  message.header.references = ["root", "parent", "root"];
  for (const cells of [row.cells, message.header.extras]) {
    cells.find(cell => cell.k == "references").v = "<root> <parent> <root>";
    cells.push({ k: "offlineMsgSize", v: "0" }, { k: "empty", v: "" });
  }
  for (const { name, text } of properties.filter(p => p.name != "unknown")) {
    row.cells.push({
      k: MailStringUtils.stringToByteString(name),
      v: MailStringUtils.stringToByteString(text),
    });
    message.header.extras.push({ k: name, v: text });
  }
  message.header.offlineMessageSize = 0;
  input.folderProperties.reverse();
  const receipt = await database.importFolderSnapshot(folder, input);
  const key = receipt.keys.find(pair => pair[0] == message.sourceKey)[1];
  const header = messageDB.getMessage(key);
  Assert.deepEqual(
    Array.from({ length: header.numReferences }, (_, i) =>
      header.getStringReference(i)
    ),
    ["root", "parent", "root"]
  );
  Assert.equal(header.offlineMessageSize, 0);
  Assert.ok([...header.properties].includes("offlineMessageSize"));
  Assert.ok([...header.properties].includes("empty"));
  Assert.equal(messageDB.getMessageProperty(key, "empty"), "");
  Assert.equal(messageDB.getMessageProperty(key, "é"), "composed");
  Assert.equal(messageDB.getMessageProperty(key, "e\u0301"), "");
  const names = [...header.properties];
  Assert.ok(names.includes("é") && names.includes("e\u0301"));
  const reader = Services.storage.openUnsharedDatabase(
    database.connectionForTests.databaseFile
  );
  const stmt = reader.createStatement(
    "SELECT name, value FROM folder_properties WHERE id=:id"
  );
  const stored = new Map();
  try {
    stmt.params.id = folder.id;
    while (stmt.executeStep()) {
      stored.set(stmt.row.name, stmt.row.value);
    }
  } finally {
    stmt.finalize();
    reader.close();
  }
  for (const { name, text } of properties) {
    Assert.ok(stored.has(name));
    Assert.equal(stored.get(name), text);
  }
  Assert.ok(!stored.has("absent"));
});

add_task(async function test_importFullSnapshotRejectsUnaccountedRecords() {
  const baseline = await fullImportInput("whole-reject");
  for (const edit of [
    input => input.records.rows.push({ id: 7, scope: "unknown", cells: [] }),
    input =>
      input.records.tables.push({
        id: 7,
        scope: "ns:msg:db:row:scope:ops:all",
        cells: [{ k: "k", v: "ns:msg:db:table:kind:ops" }],
        rows: [],
        metaRow: null,
      }),
    input => input.unhandledRecords.push("required offline operation"),
    input => {
      // A genuine nonempty source cannot be projected down to message rows.
      delete input.folderProperties;
      input.records.rows = input.records.rows.filter(row =>
        row.scope.endsWith("msgs:all")
      );
      input.records.tables = input.records.tables.filter(table =>
        table.cells.some(
          cell => cell.k == "k" && cell.v == "ns:msg:db:table:kind:msgs"
        )
      );
    },
  ]) {
    const input = structuredClone(baseline);
    edit(input);
    input.recordsComplete = true;
    assertFullImportRejected(input, Cr.NS_ERROR_NOT_IMPLEMENTED);
  }
});

add_task(async function test_importFullSnapshotRejectsPropertyMismatch() {
  const baseline = await fullImportInput("whole-reject");
  for (const edit of [
    input => {
      input.folderProperties.find(p => p.name == "sortType").text = "13";
    },
    input => {
      input.records.rows
        .find(row => row.scope.endsWith("dbfolderinfo:all"))
        .cells.push({ k: "unknown", v: "2a" });
      input.folderProperties.push({ name: "unknown", text: "2a", integer: 42 });
    },
    input => {
      delete input.folderProperties.find(p => p.name == "sortType").integer;
    },
  ]) {
    const input = structuredClone(baseline);
    edit(input);
    assertFullImportRejected(input, Cr.NS_ERROR_INVALID_ARG);
  }
});

add_task(async function test_importFullSnapshotRejectsHeaderMismatch() {
  const baseline = await fullImportInput("whole-reject");
  for (const edit of [
    input => {
      input.messages[0].header.references = ["unaccounted"];
    },
    input => {
      delete input.messages[0].header.messageSize;
    },
    input => {
      input.messages[0].header.storeToken = "different-body";
    },
    input => {
      input.messages[0].header.subject = "different-subject";
    },
    input => {
      input.messages[0].header.flags = 0;
    },
  ]) {
    const input = structuredClone(baseline);
    edit(input);
    assertFullImportRejected(input, Cr.NS_ERROR_INVALID_ARG);
  }
});

add_task(async function test_importFullSnapshotRejectsThreadState() {
  const baseline = await fullImportInput("whole-reject");
  for (const edit of [
    input => {
      input.records.rows
        .find(row => row.id == 1 && row.scope == "m")
        .cells.find(cell => cell.k == "threadFlags").v = "100";
    },
    input => {
      input.records.rows
        .find(row => row.id == 1 && row.scope == "m")
        .cells.push({ k: "unknownThreadState", v: "0" });
    },
    input => {
      input.records.rows.find(row =>
        row.scope.endsWith("threads:all")
      ).cells[0].v = "different raw subject";
    },
  ]) {
    const input = structuredClone(baseline);
    edit(input);
    assertFullImportRejected(input, Cr.NS_ERROR_NOT_IMPLEMENTED);
  }
});

/**
 * Creates a real Unix link at a disposable fixture path.
 *
 * @param {string} target - Existing physical target.
 * @param {string} path - Unoccupied link path.
 */
function makeImportPathLink(target, path) {
  const process = Cc["@mozilla.org/process/util;1"].createInstance(
    Ci.nsIProcess
  );
  process.init(new FileUtils.File("/bin/ln"));
  const args = ["-s", target, path];
  process.run(true, args, args.length);
  Assert.equal(process.exitValue, 0);
  Assert.ok(new FileUtils.File(path).isSymlink());
}

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_importCanonicalPhysicalPathsPreserveLogicalIdentity() {
    const folder = importFolders.get("whole-alias");
    const summary = folder.summaryFile.path;
    const body = folder.filePath.path;
    const summaryBytes = await IOUtils.read(summary);
    const bodyBytes = await IOUtils.read(body);
    const logicalPath = folder.path;
    const parent = PathUtils.parent(summary);
    const saved = parent + ".core-import-target";
    Assert.ok(!(await IOUtils.exists(saved)));
    const count = messageDB.totalCount;
    await IOUtils.move(parent, saved, { noOverwrite: true });
    let input;
    let receipt;
    try {
      makeImportPathLink(saved, parent);
      input = await fullImportInput("whole-alias");
      Assert.equal(
        input.source.path,
        PathUtils.join(saved, PathUtils.filename(summary))
      );
      Assert.equal(input.folder.summaryPath, input.source.path);
      Assert.equal(
        input.folder.storePath,
        PathUtils.join(saved, PathUtils.filename(body))
      );
      Assert.notEqual(input.source.path, summary);
      Assert.equal(database.getFolderImportReceipt(folder, input), null);
      receipt = await database.importFolderSnapshot(folder, input);
      Assert.deepEqual(
        receipt.keys.map(([key]) => key),
        [1, 3]
      );
      Assert.equal(messageDB.totalCount, count + 2);
      Assert.deepEqual(database.getFolderImportReceipt(folder, input), receipt);
      Assert.deepEqual(
        await database.importFolderSnapshot(folder, input),
        receipt
      );
      Assert.equal(messageDB.totalCount, count + 2);
      Assert.equal(folder.path, logicalPath);
      Assert.equal(folder.summaryFile.path, summary);
      Assert.equal(folder.filePath.path, body);
      const reader = Services.storage.openUnsharedDatabase(
        database.connectionForTests.databaseFile
      );
      const stmt = reader.createStatement(
        "SELECT folderPath, sourcePath FROM folder_import_receipts WHERE token=:token"
      );
      try {
        stmt.params.token = input.token;
        Assert.ok(stmt.executeStep());
        Assert.equal(stmt.row.folderPath, logicalPath);
        Assert.equal(stmt.row.sourcePath, input.source.path);
        Assert.ok(!stmt.executeStep());
      } finally {
        stmt.finalize();
        reader.close();
      }
    } finally {
      if (await IOUtils.exists(parent)) {
        Assert.ok(new FileUtils.File(parent).isSymlink());
        await IOUtils.remove(parent);
      }
      await IOUtils.move(saved, parent, { noOverwrite: true });
    }
    Assert.deepEqual(await IOUtils.read(summary), summaryBytes);
    Assert.deepEqual(await IOUtils.read(body), bodyBytes);
    Assert.ok(messageDB.getSearchState(importControl));
    const movedIdentity = await fullImportInput("whole-alias");
    Assert.notEqual(movedIdentity.source.path, input.source.path);
    Assert.throws(
      () => database.getFolderImportReceipt(folder, movedIdentity),
      error => error.result == Cr.NS_ERROR_ALREADY_INITIALIZED
    );
    Assert.throws(
      () => database.importFolderSnapshot(folder, movedIdentity),
      error => error.result == Cr.NS_ERROR_ALREADY_INITIALIZED
    );
    Assert.equal(messageDB.totalCount, count + 2);
    for (const [, key] of receipt.keys) {
      Assert.equal(messageDB.getMessage(key).folder.id, folder.id);
    }
  }
);

/**
 * Checks native leaf rejection using unchanged input from a real folder.
 *
 * @param {string} name - Isolated fixture folder.
 * @param {string} path - Original summary or body-store path.
 */
async function checkImportLinkedLeaf(name, path) {
  const folder = importFolders.get(name);
  const input = await fullImportInput(name);
  const before = await IOUtils.read(path);
  const count = messageDB.totalCount;
  const saved = path + ".core-import-target";
  Assert.ok(!(await IOUtils.exists(saved)));
  await IOUtils.move(path, saved, { noOverwrite: true });
  try {
    makeImportPathLink(saved, path);
    Assert.throws(
      () => database.getFolderImportReceipt(folder, input),
      error => error.result == Cr.NS_ERROR_FILE_ACCESS_DENIED
    );
    Assert.throws(
      () => database.importFolderSnapshot(folder, input),
      error => error.result == Cr.NS_ERROR_FILE_ACCESS_DENIED
    );
    Assert.equal(messageDB.totalCount, count);
    Assert.ok(!database.connectionForTests.transactionInProgress);
    Assert.ok(messageDB.getSearchState(importControl));
  } finally {
    if (await IOUtils.exists(path)) {
      Assert.ok(new FileUtils.File(path).isSymlink());
      await IOUtils.remove(path);
    }
    await IOUtils.move(saved, path, { noOverwrite: true });
  }
  Assert.deepEqual(await IOUtils.read(path), before);
  Assert.equal(database.getFolderImportReceipt(folder, input), null);
}

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_importRejectsLinkedSummaryBeforeNormalization() {
    await checkImportLinkedLeaf(
      "whole-summary-link",
      importFolders.get("whole-summary-link").summaryFile.path
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_importRejectsLinkedStoreBeforeNormalization() {
    await checkImportLinkedLeaf(
      "whole-store-link",
      importFolders.get("whole-store-link").filePath.path
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_importDoesNotCreateAbsentBodyStore() {
    const folder = importFolders.get("whole-missing-store");
    const path = folder.filePath.path;
    const before = await IOUtils.read(path);
    const saved = path + ".core-import-target";
    Assert.ok(!(await IOUtils.exists(saved)));
    await IOUtils.move(path, saved, { noOverwrite: true });
    try {
      const input = await fullImportInput("whole-missing-store");
      Assert.ok(!input.folder.storeExists);
      const receipt = await database.importFolderSnapshot(folder, input);
      Assert.deepEqual(
        receipt.keys.map(([key]) => key),
        [1, 3]
      );
      Assert.deepEqual(database.getFolderImportReceipt(folder, input), receipt);
      Assert.ok(!(await IOUtils.exists(path)));
      Assert.ok(messageDB.getSearchState(importControl));
    } finally {
      await IOUtils.move(saved, path, { noOverwrite: true });
    }
    Assert.deepEqual(await IOUtils.read(path), before);
  }
);
