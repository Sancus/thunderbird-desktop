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
const MESSAGE_SCOPE = "ns:msg:db:row:scope:msgs:all";
const INFO_SCOPE = "ns:msg:db:row:scope:dbfolderinfo:all";
let originalFolder;
let originalInventory;

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
  Assert.equal(originalFolder.msgStore.storeType, "mbox");
  Assert.equal(originalFolder.incomingServerType, "none");
  Assert.ok(!originalFolder.summaryFile.isSymlink());
  Assert.ok(!originalFolder.filePath.isSymlink());
  registerCleanupFunction(() => {
    originalFolder = null;
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
