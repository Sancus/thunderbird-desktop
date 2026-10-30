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
const { ProfileCreator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ProfileCreator.sys.mjs"
);
const { readMorkFolderImport, captureMorkFolderWindowsInventory } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MorkFolderImport.sys.mjs"
  );
const {
  convertMorkFolderSnapshot,
  validateMorkFolderReceipt,
  importMorkFolderSnapshot,
} = ChromeUtils.importESModule(
  "resource:///modules/panorama/MorkSnapshotAdapter.sys.mjs"
);
const { MigrationJournal } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationJournal.sys.mjs"
);
const { MailStringUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailStringUtils.sys.mjs"
);
const TEXT_PROPERTIES = [
  ["Case", "UPPER", 0],
  ["case", "lower", 0],
  ["n\u00e1me", "Name NFC", 0],
  ["na\u0301me", "Name NFD", 0],
  ["escaped", "line 1\n(a=b) $ \\end", 0],
  ["unicode", "text Caf\u00e9 / Cafe\u0301 \ud83d\ude42", 0],
  ["leadingBom", "\ufeffraw text", 0],
  ["empty", "", 0],
  ["decimalText", "42", 66],
  ["paddedText", "00042", 66],
  ["hexText", "2a", 42],
  ["suffixText", "2ag", 42],
  ["wideText", "100000000", 268435456],
  ["maxText", "ffffffff", 0xffffffff],
];
const NUMERIC_PROPERTIES = [
  ["numericZero", 0, "0"],
  ["numericValue", 42, "2a"],
  ["numericMax", 0xffffffff, "ffffffff"],
];
const PROPERTY_VIEWS = [
  ...TEXT_PROPERTIES,
  ...NUMERIC_PROPERTIES.map(([name, value, text]) => [name, text, value]),
];
const FOLDER_TEXT_PROPERTIES = [
  ["FolderCase", "42"],
  ["foldercase", "00042"],
  ["n\u00e1me", "text Caf\u00e9"],
  ["na\u0301me", "text Cafe\u0301"],
  ["folderEmpty", ""],
];
const WIDE_FOLDER_SIZE = 2 ** 40 + 42;
const MESSAGE_SCOPE = "ns:msg:db:row:scope:msgs:all";
const INFO_SCOPE = "ns:msg:db:row:scope:dbfolderinfo:all";
let originalFolder;
let originalInventory;
let propertyFolder;
let propertyInventory;

/**
 * Checks literal property text, numeric views and presence through nsIMsgDBHdr.
 *
 * @param {nsIMsgDBHdr} header - A genuine legacy or imported native header.
 */
function assertPropertyViews(header) {
  const names = header.properties;
  for (const [name, text, number] of PROPERTY_VIEWS) {
    const bytes = MailStringUtils.stringToByteString(name);
    Assert.ok(
      names.includes(name),
      name + " remains present with exact spelling"
    );
    Assert.equal(header.getStringProperty(bytes), text, name);
    Assert.equal(header.getUint32Property(bytes), number, name);
  }
  Assert.ok(!names.includes("absentProperty"));
  Assert.equal(header.getStringProperty("absentProperty"), "");
  Assert.equal(header.getUint32Property("absentProperty"), 0);
}

/**
 * Serializes properties with the real legacy writer, then reads a fresh legacy
 * database before the source is copied into the closed import profile.
 *
 * @param {nsIFile} summary - Owned regular copy of the genuine summary fixture.
 */
function preparePropertySource(summary) {
  const writer = Cc["@mozilla.org/nsMsgDatabase/msgDB-mailbox"].createInstance(
    Ci.nsIMsgDatabase
  );
  writer.openFromFile(summary);
  try {
    const header = writer.getMsgHdrForMessageID("162378@invalid");
    Assert.equal(header.messageKey, 1);
    Assert.equal(header.messageId, "162378@invalid");
    for (const [name, text] of TEXT_PROPERTIES) {
      header.setStringProperty(MailStringUtils.stringToByteString(name), text);
    }
    for (const [name, value] of NUMERIC_PROPERTIES) {
      header.setUint32Property(name, value);
    }
    const info = writer.dBFolderInfo;
    for (const [name, text] of FOLDER_TEXT_PROPERTIES) {
      info.setCharProperty(MailStringUtils.stringToByteString(name), text);
    }
    info.setUint32Property("numHdrsToKeep", 0xffffffff);
    info.setInt64Property("folderSize", WIDE_FOLDER_SIZE);
  } finally {
    writer.forceClosed();
  }
  const reader = Cc["@mozilla.org/nsMsgDatabase/msgDB-mailbox"].createInstance(
    Ci.nsIMsgDatabase
  );
  reader.openFromFile(summary);
  try {
    const saved = reader.getMsgHdrForMessageID("162378@invalid");
    Assert.equal(saved.messageKey, 1);
    assertPropertyViews(saved);
    const other = reader.getMsgHdrForMessageID("345692@invalid");
    Assert.equal(other.messageKey, 3);
    Assert.equal(other.messageId, "345692@invalid");
    for (const [name] of PROPERTY_VIEWS) {
      Assert.ok(!other.properties.includes(name));
    }
    for (const [name, text] of FOLDER_TEXT_PROPERTIES) {
      Assert.equal(
        reader.dBFolderInfo.getCharProperty(
          MailStringUtils.stringToByteString(name)
        ),
        text
      );
    }
    Assert.equal(
      reader.dBFolderInfo.getUint32Property("numHdrsToKeep", 0),
      0xffffffff
    );
    Assert.equal(
      reader.dBFolderInfo.getInt64Property("folderSize", 0),
      WIDE_FOLDER_SIZE
    );
  } finally {
    reader.forceClosed();
  }
}

add_setup(async function setupGenuineLegacySource() {
  const profile = new ProfileCreator(do_get_profile());
  const server = await profile.addLocalServer();
  const work = await IOUtils.createUniqueDirectory(
    do_get_tempdir().path,
    "mork-snapshot-source-"
  );
  registerCleanupFunction(() => IOUtils.remove(work, { recursive: true }));
  const summary = new FileUtils.File(PathUtils.join(work, "source.msf"));
  const body = new FileUtils.File(PathUtils.join(work, "source"));
  await IOUtils.write(
    summary.path,
    await IOUtils.read(do_get_file("data/migration.msf").path),
    { mode: "create" }
  );
  await IOUtils.write(
    body.path,
    await IOUtils.read(do_get_file("data/migration").path),
    { mode: "create" }
  );
  const files = await server.rootFolder.addMailFolder("snapshot-source", {
    summary,
    mbox: body,
  });
  if (AppConstants.platform == "win") {
    originalInventory = captureMorkFolderWindowsInventory(
      new FileUtils.File(files.summaryFilePath),
      do_get_profile(),
      new FileUtils.File(files.mailFilePath),
      do_get_profile()
    );
  }
  const propertySummary = new FileUtils.File(
    PathUtils.join(work, "properties.msf")
  );
  await IOUtils.write(
    propertySummary.path,
    await IOUtils.read(do_get_file("data/migration.msf").path),
    { mode: "create" }
  );
  preparePropertySource(propertySummary);
  const propertyFiles = await server.rootFolder.addMailFolder(
    "property-source",
    {
      summary: propertySummary,
      mbox: body,
    }
  );
  if (AppConstants.platform == "win") {
    propertyInventory = captureMorkFolderWindowsInventory(
      new FileUtils.File(propertyFiles.summaryFilePath),
      do_get_profile(),
      new FileUtils.File(propertyFiles.mailFilePath),
      do_get_profile()
    );
  }
  loadExistingDB();
  MailServices.accounts.accounts;
  originalFolder =
    MailServices.accounts.localFoldersServer.rootFolder.getChildNamed(
      "snapshot-source"
    );
  Assert.equal(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    ),
    database
  );
  propertyFolder =
    MailServices.accounts.localFoldersServer.rootFolder.getChildNamed(
      "property-source"
    );
  Assert.ok(propertyFolder instanceof Ci.nsIMsgFolder);
  Assert.equal(propertyFolder.msgStore.storeType, "mbox");
  Assert.equal(propertyFolder.incomingServerType, "none");
  Assert.equal(originalFolder.msgStore.storeType, "mbox");
  Assert.equal(originalFolder.incomingServerType, "none");
  Assert.ok(!originalFolder.summaryFile.isSymlink());
  Assert.ok(!originalFolder.filePath.isSymlink());
  registerCleanupFunction(() => {
    originalFolder = null;
    propertyFolder = null;
  });
});

/**
 * Reads genuine existing MSF/body inputs. The source object models the durable
 * journal envelope; profile/backup/activation admission is tested separately.
 *
 * @returns {Promise<{input: object, source: object}>} Independent prepared input.
 */
async function snapshotInput() {
  const input = await readMorkFolderImport(
    originalFolder,
    "snapshot-operation"
  );
  const source = {
    id: "original-folder-unit",
    token: input.token,
    databaseSourceId: database.sourceId,
    destinationFolderId: originalFolder.id,
    path: input.source.path,
    sha256: input.source.sha256,
    size: input.source.size,
    messageKeys: [...input.source.messageKeys],
    state: "importing",
    receipt: null,
  };
  return { input, source };
}

/** @param {object} input - Read-only source input. @param {object} source - Journal source. @returns {object} Checked request. */
function convert(input, source) {
  return convertMorkFolderSnapshot(
    input,
    source,
    database.sourceId,
    originalFolder.flags
  );
}

add_task(async function test_accountsEntireGenuineSummary() {
  const { input, source } = await snapshotInput();
  const original = structuredClone(input);
  const request = convert(input, source);
  Assert.equal(request.sourceId, "original-folder-unit");
  Assert.equal(request.databaseSourceId, database.sourceId);
  Assert.equal(request.recordsComplete, true);
  Assert.deepEqual(request.unhandledRecords, []);
  Assert.deepEqual(
    request.records,
    input.records,
    "Every original row/table remains in the request"
  );
  Assert.greater(request.records.rows.length, request.messages.length);
  Assert.deepEqual(
    request.messages.map(row => [
      row.sourceKey,
      row.rootSourceKey,
      row.parentSourceKey,
    ]),
    [
      [1, 1, null],
      [3, 3, null],
    ]
  );
  Assert.equal(
    request.messages[0].header.extras.find(cell => cell.k == "msgThreadId").v,
    "fffffffe"
  );
  const props = new Map(
    request.folderProperties.map(property => [property.name, property])
  );
  Assert.deepEqual(props.get("numHdrsToKeep"), {
    name: "numHdrsToKeep",
    text: "7d0",
    integer: 2000,
  });
  Assert.equal(props.get("numMsgs").integer, 2);
  Assert.equal(props.get("numNewMsgs").integer, 1);
  Assert.equal(props.get("expungedBytes").integer, 1641);
  Assert.equal(props.get("sortType").integer, 18);
  Assert.equal(props.get("sortColumns").text, "\x122");
  Assert.ok(!("integer" in props.get("sortColumns")));
  Assert.equal(props.get("MRUTime").text, "1747364552");
  Assert.ok(!("integer" in props.get("MRUTime")));
  Assert.deepEqual(
    request.messages.map(row => [
      row.header.storeToken,
      row.header.messageSize,
    ]),
    [
      ["0", 578],
      ["1143", 375],
    ]
  );
  Assert.deepEqual(input, original, "Conversion changes no source input");
});

add_task(async function test_preservesUnknownFolderTextAndNumericPresence() {
  const { input, source } = await snapshotInput();
  const info = input.records.rows.find(row => row.scope == INFO_SCOPE);
  // Change only the owned parsed model, never manufacture production MSF bytes.
  info.cells.push(
    { k: "unknown", v: "2a" },
    { k: "empty", v: "" },
    { k: "UIDValidity", v: "0" }
  );
  const properties = new Map(
    convert(input, source).folderProperties.map(p => [p.name, p])
  );
  Assert.deepEqual(properties.get("unknown"), { name: "unknown", text: "2a" });
  Assert.deepEqual(properties.get("empty"), { name: "empty", text: "" });
  Assert.ok(!properties.has("absent"));
  Assert.deepEqual(properties.get("UIDValidity"), {
    name: "UIDValidity",
    text: "0",
    integer: 0,
  });
});

add_task(
  async function test_orderedExtrasReferencesAndStorageOptionalsSurvive() {
    const { input, source } = await snapshotInput();
    const message = input.messages[0];
    const row = input.records.rows.find(
      record => record.id == 1 && record.scope == MESSAGE_SCOPE
    );
    message.header.extras.push({ k: "é", v: "é" }, { k: "é", v: "" });
    row.cells.push(
      { k: "\xc3\xa9", v: "e\xcc\x81" },
      { k: "e\xcc\x81", v: "" }
    );
    message.header.references = ["root", "parent", "root"];
    delete message.header.messageSize;
    message.header.extras = message.header.extras.filter(
      cell => cell.k != "size"
    );
    row.cells = row.cells.filter(cell => cell.k != "size");
    for (const list of [row.cells, message.header.extras]) {
      list.find(cell => cell.k == "storeToken").v = "";
      list.find(cell => cell.k == "references").v = "<root> <parent> <root>";
      list.push({ k: "offlineMsgSize", v: "0" });
    }
    message.header.storeToken = "";
    message.header.offlineMessageSize = 0;
    const header = convert(input, source).messages[0].header;
    Assert.deepEqual(
      header.extras.filter(cell => ["é", "é"].includes(cell.k)),
      [
        { k: "é", v: "é" },
        { k: "é", v: "" },
      ]
    );
    Assert.deepEqual(header.references, ["root", "parent", "root"]);
    Assert.ok(!("messageSize" in header));
    Assert.equal(header.storeToken, "");
    Assert.equal(header.offlineMessageSize, 0);
    header.extras[0].v = "destination-only";
    Assert.notEqual(message.header.extras[0].v, "destination-only");
  }
);

add_task(async function test_receiptUsesExactPhysicalKeySetAndIncarnation() {
  const { input, source } = await snapshotInput();
  const request = convert(input, source);
  const receipt = {
    token: request.token,
    sourceId: request.sourceId,
    databaseSourceId: request.databaseSourceId,
    sourceSha256: request.source.sha256,
    folderId: request.folder.id,
    keys: [
      [3, 700],
      [1, 1],
    ],
  };
  Assert.deepEqual(
    validateMorkFolderReceipt(request, receipt).keys,
    [
      [1, 1],
      [3, 700],
    ],
    "Original key may survive; no allocation-order assumption"
  );
  receipt.databaseSourceId = "different-database";
  Assert.throws(
    () => validateMorkFolderReceipt(request, receipt),
    /receipt identity/
  );
});

add_task(async function test_rejectsIncompleteOrDuplicateReceiptKeys() {
  const { input, source } = await snapshotInput();
  const request = convert(input, source);
  const receipt = {
    token: request.token,
    sourceId: request.sourceId,
    databaseSourceId: request.databaseSourceId,
    sourceSha256: request.source.sha256,
    folderId: request.folder.id,
    keys: [[1, 401]],
  };
  Assert.throws(() => validateMorkFolderReceipt(request, receipt), /count/);
  receipt.keys = [
    [1, 401],
    [3, 401],
  ];
  Assert.throws(() => validateMorkFolderReceipt(request, receipt), /ambiguous/);
});

add_task(async function test_rejectsMissingDatabasePlanPin() {
  const { input, source } = await snapshotInput();
  delete source.databaseSourceId;
  Assert.throws(
    () => convert(input, source),
    error =>
      error.message == "Mork snapshot conflicts with journal/database identity"
  );
});

add_task(async function test_rejectsChangedSourceBinding() {
  const { input, source } = await snapshotInput();
  source.sha256 = "0".repeat(64);
  Assert.throws(
    () => convert(input, source),
    error =>
      error.message == "Mork snapshot conflicts with journal/database identity"
  );
});

add_task(async function test_rejectsUnknownStructuralRow() {
  const { input, source } = await snapshotInput();
  input.records.rows.push({
    id: 7,
    scope: "unknown-required-scope",
    cells: [],
  });
  Assert.throws(() => convert(input, source), /unaccounted/);
});

add_task(async function test_rejectsOfflineOperationsBeforeImport() {
  const { input, source } = await snapshotInput();
  input.records.tables.push({
    id: 1,
    scope: "ns:msg:db:row:scope:ops:all",
    cells: [{ k: "k", v: "ns:msg:db:table:kind:ops" }],
    rows: [],
    metaRow: null,
  });
  Assert.throws(
    () => convert(input, source),
    error =>
      error.message.startsWith("Unsupported Mork structural/offline table:")
  );
  Assert.equal(originalFolder.getTotalMessages(false), 0);
});

add_task(async function test_rejectsUnrepresentableThreadFlags() {
  const { input, source } = await snapshotInput();
  input.records.rows
    .find(row => row.id == 1 && row.scope == "m")
    .cells.find(cell => cell.k == "threadFlags").v = "100";
  Assert.throws(
    () => convert(input, source),
    error => error.message == "Unsupported Mork thread metadata/state"
  );
});

add_task(async function test_rejectsUnsafeInt64FolderProjection() {
  const { input, source } = await snapshotInput();
  input.records.rows
    .find(row => row.scope == INFO_SCOPE)
    .cells.find(cell => cell.k == "folderSize").v = "7fffffffffffffff";
  Assert.throws(() => convert(input, source), /exact int64/);
});

add_task(async function test_rejectsNonzeroPendingFolderState() {
  const { input, source } = await snapshotInput();
  input.records.rows
    .find(row => row.scope == INFO_SCOPE)
    .cells.push({ k: "totPendingMsgs", v: "1" });
  Assert.throws(() => convert(input, source), /required Mork folder state/);
});

add_task(async function test_rejectsParentMappingThatDiffersFromSource() {
  const { input, source } = await snapshotInput();
  input.messages[0].parentSourceKey = 3;
  Assert.throws(() => convert(input, source), /thread map differs/);
});

add_task(async function test_journalPersistsExpectedDatabaseIdentity() {
  const { input, source } = await snapshotInput();
  const directory = await IOUtils.createUniqueDirectory(
    do_get_tempdir().path,
    "mork-snapshot-plan-"
  );
  registerCleanupFunction(() => IOUtils.remove(directory, { recursive: true }));
  const path = PathUtils.join(directory, "journal.json");
  const profile = do_get_profile();
  profile.normalize();
  const work = new FileUtils.File(directory);
  work.normalize();
  const backupPath = PathUtils.join(directory, "backup");
  Assert.ok(
    !profile.equals(work) && !profile.contains(work),
    "Journal work is outside the actual selected profile"
  );
  const summary = originalFolder.summaryFile.clone();
  summary.normalize();
  Assert.ok(
    profile.contains(summary),
    "The genuine source remains inside the selected profile"
  );
  Assert.ok(
    !new FileUtils.File(backupPath).contains(new FileUtils.File(path)),
    "Backup and journal are independent siblings"
  );
  let journal = await MigrationJournal.create(path, {
    profilePath: do_get_profile().path,
    backupPath,
    mailPaths: [],
    sources: [
      {
        ...source,
        ...(originalInventory
          ? {
              inventory: originalInventory,
              physicalIdentity: input.source.physicalIdentity,
            }
          : {}),
      },
    ],
  });
  journal.close();
  journal = await MigrationJournal.open(path, do_get_profile().path);
  try {
    Assert.equal(journal.state.sources[0].databaseSourceId, database.sourceId);
    Assert.equal(journal.state.sources[0].id, "original-folder-unit");
    Assert.equal(journal.state.version, AppConstants.platform == "win" ? 4 : 1);
    if (originalInventory) {
      Assert.deepEqual(journal.state.sources[0].inventory, originalInventory);
    }
  } finally {
    journal.close();
  }
});

// Acceptance for all required summary records in the public native receiver.
add_task(async function test_nativeWholeSnapshotAndRepeatPreserveSource() {
  const { source } = await snapshotInput();
  if (AppConstants.platform == "win") {
    source.inventory = originalInventory;
  }
  const summary = await IOUtils.read(originalFolder.summaryFile.path);
  const body = await IOUtils.read(originalFolder.filePath.path);
  const receipt = await importMorkFolderSnapshot(
    database,
    originalFolder,
    source
  );
  if (originalInventory) {
    Assert.equal(receipt.version, 2);
    Assert.equal(
      receipt.windowsAdmission.summary.originalPath,
      originalInventory.windowsAdmission.summary.originalPath
    );
    Assert.equal(
      receipt.windowsAdmission.summary.originalRoot,
      originalInventory.windowsAdmission.summary.originalRoot
    );
  }
  Assert.deepEqual(
    receipt.keys.map(pair => pair[0]),
    [1, 3]
  );
  Assert.equal(new Set(receipt.keys.map(pair => pair[1])).size, 2);
  const messages = Array.from(originalFolder.messages).sort((a, b) =>
    a.messageId.localeCompare(b.messageId)
  );
  Assert.deepEqual(
    messages.map(h => [h.messageId, h.storeToken, h.messageSize]),
    [
      ["162378@invalid", "0", 578],
      ["345692@invalid", "1143", 375],
    ]
  );
  Assert.deepEqual(
    messages.map(h => h.messageKey),
    receipt.keys.map(pair => pair[1])
  );
  Assert.ok(messages.every(h => h.threadId != 0 && h.threadParent == 0));
  Assert.notEqual(messages[0].threadId, messages[1].threadId);
  Assert.equal(
    originalFolder.msgDatabase.dBFolderInfo.getUint32Property("sortType", 0),
    18
  );
  const repeated = await importMorkFolderSnapshot(
    database,
    originalFolder,
    source
  );
  Assert.deepEqual(repeated, receipt);
  Assert.equal(originalFolder.getTotalMessages(false), 2);
  Assert.deepEqual(
    await IOUtils.read(originalFolder.summaryFile.path),
    summary
  );
  Assert.deepEqual(await IOUtils.read(originalFolder.filePath.path), body);
});

/**
 * Models a complete version1 receiver envelope for validation rejection tests.
 * This is not native physical-admission or transaction evidence.
 *
 * @returns {Promise<object>} Genuine parsed request and independent receipt model.
 */
async function receiptVersionInput() {
  const { input, source } = await snapshotInput();
  const request = convert(input, source);
  return {
    request,
    receipt: {
      token: request.token,
      sourceId: request.sourceId,
      databaseSourceId: request.databaseSourceId,
      sourceSha256: request.source.sha256,
      folderId: request.folder.id,
      keys: [
        [1, 401],
        [3, 700],
      ],
    },
  };
}

add_task(
  async function test_version2RequestCannotUseVersion1ReceiptValidation() {
    const { request, receipt } = await receiptVersionInput();
    request.version = 2;
    const count = messageDB.totalCount;
    Assert.throws(
      () => validateMorkFolderReceipt(request, receipt),
      /Unsupported native Mork receipt version\/physical admission/
    );
    Assert.equal(request.version, 2, "Validation never downgrades the request");
    Assert.equal(messageDB.totalCount, count, "Validation never imports rows");
  }
);

add_task(async function test_version2ReceiptCannotBeDowngradedToVersion1() {
  const { request, receipt } = await receiptVersionInput();
  receipt.version = 2;
  const original = structuredClone(receipt);
  Assert.throws(
    () => validateMorkFolderReceipt(request, receipt),
    /Unsupported native Mork receipt version\/physical admission/
  );
  Assert.deepEqual(receipt, original, "The native envelope is never rewritten");
});

add_task(async function test_windowsAdmissionCannotBeSilentlyDropped() {
  const { request, receipt } = await receiptVersionInput();
  receipt.windowsAdmission = {};
  Assert.throws(
    () => validateMorkFolderReceipt(request, receipt),
    /Unsupported native Mork receipt version\/physical admission/
  );
  Assert.ok(Object.hasOwn(receipt, "windowsAdmission"));
});

add_task(async function test_sourcePhysicalIdentityCannotBeSilentlyDropped() {
  const { request, receipt } = await receiptVersionInput();
  receipt.sourcePhysicalIdentity = {};
  Assert.throws(
    () => validateMorkFolderReceipt(request, receipt),
    /Unsupported native Mork receipt version\/physical admission/
  );
  Assert.ok(Object.hasOwn(receipt, "sourcePhysicalIdentity"));
});

add_task(async function test_genuinePropertyImportFailureRetryAndCopy() {
  const input = await readMorkFolderImport(
    propertyFolder,
    "property-import-operation",
    propertyInventory
  );
  const source = {
    id: "property-source-unit",
    token: input.token,
    databaseSourceId: database.sourceId,
    destinationFolderId: propertyFolder.id,
    path: input.source.path,
    sha256: input.source.sha256,
    size: input.source.size,
    messageKeys: [...input.source.messageKeys],
    state: "importing",
    receipt: null,
    ...(propertyInventory ? { inventory: propertyInventory } : {}),
  };
  const request = convertMorkFolderSnapshot(
    input,
    source,
    database.sourceId,
    propertyFolder.flags
  );
  const summary = await IOUtils.read(propertyFolder.summaryFile.path);
  const body = await IOUtils.read(propertyFolder.filePath.path);
  const count = messageDB.totalCount;
  const connection = database.connectionForTests;
  const trigger =
    "CREATE TEMP TRIGGER fail_imported_property BEFORE INSERT ON message_properties " +
    "WHEN NEW.name = 'Case' AND EXISTS (SELECT 1 FROM messages " +
    "WHERE id = NEW.id AND folderId = " +
    propertyFolder.id +
    ") " +
    "BEGIN SELECT RAISE(ABORT, 'S3-02 property write failure'); END";
  connection.executeSimpleSQL(trigger);
  try {
    await Assert.rejects(
      importMorkFolderSnapshot(database, propertyFolder, source),
      /NS_ERROR_STORAGE_CONSTRAINT/
    );
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER fail_imported_property");
  }
  Assert.ok(!connection.transactionInProgress);
  Assert.equal(messageDB.totalCount, count);
  Assert.equal(database.getFolderImportReceipt(propertyFolder, request), null);
  Assert.equal(propertyFolder.getTotalMessages(false), 0);
  Assert.deepEqual(
    await IOUtils.read(propertyFolder.summaryFile.path),
    summary
  );
  Assert.deepEqual(await IOUtils.read(propertyFolder.filePath.path), body);

  const receipt = await importMorkFolderSnapshot(
    database,
    propertyFolder,
    source
  );
  Assert.deepEqual(
    receipt.keys.map(pair => pair[0]),
    [1, 3]
  );
  Assert.equal(messageDB.totalCount, count + 2);
  Assert.ok(!connection.transactionInProgress);
  const keys = new Map(receipt.keys);
  const header = propertyFolder.msgDatabase.getMsgHdrForKey(keys.get(1));
  const other = propertyFolder.msgDatabase.getMsgHdrForKey(keys.get(3));
  assertPropertyViews(header);
  for (const [name] of PROPERTY_VIEWS) {
    Assert.ok(
      !other.properties.includes(name),
      name + " is not invented on the other row"
    );
  }
  const info = propertyFolder.msgDatabase.dBFolderInfo;
  for (const [name, text] of FOLDER_TEXT_PROPERTIES) {
    Assert.equal(
      info.getCharProperty(MailStringUtils.stringToByteString(name)),
      text
    );
  }
  Assert.equal(info.getUint32Property("numHdrsToKeep", 0), 0xffffffff);
  Assert.equal(info.getInt64Property("folderSize", 0), WIDE_FOLDER_SIZE);
  Assert.equal(info.getCharProperty("absentFolderProperty"), "");

  connection.executeSimpleSQL(trigger);
  try {
    Assert.throws(
      () => header.setStringProperty("Case", "must not commit"),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER fail_imported_property");
  }
  assertPropertyViews(header);
  header.setStringProperty("Case", "overwrite Cafe\u0301");
  Assert.equal(header.getStringProperty("Case"), "overwrite Cafe\u0301");
  Assert.equal(header.getStringProperty("case"), "lower");
  header.setStringProperty("Case", "UPPER");
  assertPropertyViews(header);
  const copy = propertyFolder.msgDatabase.copyHdrFromExistingHdr(
    0xffffffff,
    header,
    false
  );
  Assert.equal(
    copy.isLive,
    false,
    "This checks the detached metadata-copy boundary"
  );
  assertPropertyViews(copy);
  copy.setStringProperty("Case", "changed copy");
  Assert.equal(header.getStringProperty("Case"), "UPPER");
  Assert.equal(copy.getStringProperty("Case"), "changed copy");

  // A separate reopened storage connection checks durable text/presence without
  // claiming a backend/process restart or a body-copy transaction.
  const stored = Services.storage.openUnsharedDatabase(connection.databaseFile);
  try {
    const statement = stored.createStatement(
      "SELECT name, value, typeof(value) AS storageType FROM message_properties WHERE id = :id"
    );
    try {
      statement.params.id = header.messageKey;
      const properties = new Map();
      while (statement.executeStep()) {
        properties.set(statement.row.name, [
          statement.row.value,
          statement.row.storageType,
        ]);
      }
      for (const [name, text] of PROPERTY_VIEWS) {
        Assert.deepEqual(properties.get(name), [text, "text"], name);
      }
      Assert.ok(!properties.has("absentProperty"));
    } finally {
      statement.finalize();
    }
    const folderStatement = stored.createStatement(
      "SELECT name, value, typeof(value) AS storageType FROM folder_properties WHERE id = :id"
    );
    try {
      folderStatement.params.id = propertyFolder.id;
      const folderProperties = new Map();
      while (folderStatement.executeStep()) {
        folderProperties.set(folderStatement.row.name, [
          folderStatement.row.value,
          folderStatement.row.storageType,
        ]);
      }
      for (const [name, text] of FOLDER_TEXT_PROPERTIES) {
        Assert.deepEqual(folderProperties.get(name), [text, "text"], name);
      }
      Assert.ok(!folderProperties.has("absentFolderProperty"));
      Assert.deepEqual(folderProperties.get("numHdrsToKeep"), [
        0xffffffff,
        "integer",
      ]);
      Assert.deepEqual(folderProperties.get("folderSize"), [
        WIDE_FOLDER_SIZE,
        "integer",
      ]);
    } finally {
      folderStatement.finalize();
    }
  } finally {
    stored.close();
  }
  Assert.deepEqual(
    await importMorkFolderSnapshot(database, propertyFolder, source),
    receipt
  );
  Assert.equal(messageDB.totalCount, count + 2);
  Assert.deepEqual(
    await IOUtils.read(propertyFolder.summaryFile.path),
    summary
  );
  Assert.deepEqual(await IOUtils.read(propertyFolder.filePath.path), body);
});
