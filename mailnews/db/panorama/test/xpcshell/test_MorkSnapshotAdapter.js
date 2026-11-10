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
  convertMorkProtocolUnit,
  validateMorkFolderReceipt,
  importMorkFolderSnapshot,
} = ChromeUtils.importESModule(
  "resource:///modules/panorama/MorkSnapshotAdapter.sys.mjs"
);
const { MigrationJournal } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationJournal.sys.mjs"
);
const { parseMorkSummary, getMorkMoveResults, findStaleMoveResults } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MorkSummaryReader.sys.mjs"
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
let imapLedger, imapServerKey;
const imapSourceFiles = new Map();
const imapFolders = new Map();

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
  // These files are real committed/reopened MDB and provider output from the
  // ordinary IM producer. Its independent readback ledger is a test oracle.
  imapLedger = await IOUtils.readJSON(
    do_get_file("data/s518/mbox/ledger.json").path
  );
  Assert.equal(imapLedger.backend, "panorama");
  Assert.equal(imapLedger.store, "mbox");
  Assert.equal(imapLedger.members.length, 6);
  const originalUri = Services.io.newURI(imapLedger.members[0].uri);
  const imap = profile.addServer(
    decodeURIComponent(originalUri.username),
    originalUri.host,
    "imap"
  );
  imap.prefBranch.setIntPref("port", originalUri.port);
  imap.prefBranch.setBoolPref("login_at_startup", false);
  imap.prefBranch.setStringPref(
    "storeContractID",
    "@mozilla.org/msgstore/berkeleystore;1"
  );
  imapServerKey = imap.prefBranch.root.split(".")[2];
  for (const saved of imapLedger.members) {
    Assert.ok(
      /^Migration(?:Classic|Explicit|CopyOne|CopyTwo|Move|Append)$/.test(
        saved.name
      )
    );
    const summaryInput = do_get_file("data/s518/mbox/" + saved.name + ".msf");
    const bodyInput = do_get_file("data/s518/mbox/" + saved.name);
    Assert.equal(
      await IOUtils.computeHexDigest(summaryInput.path, "sha256"),
      saved.sha256
    );
    Assert.equal((await IOUtils.stat(summaryInput.path)).size, saved.size);
    Assert.equal(saved.bodies.length, 1);
    Assert.equal(saved.bodies[0].relative, "");
    Assert.equal(
      await IOUtils.computeHexDigest(bodyInput.path, "sha256"),
      saved.bodies[0].sha256
    );
    const memberFiles = await imap.rootFolder.addMailFolder(saved.name, {
      summary: summaryInput,
      mbox: bodyInput,
    });
    const inventory =
      AppConstants.platform == "win"
        ? captureMorkFolderWindowsInventory(
            new FileUtils.File(memberFiles.summaryFilePath),
            do_get_profile(),
            new FileUtils.File(memberFiles.mailFilePath),
            do_get_profile()
          )
        : undefined;
    imapSourceFiles.set(saved.name, { saved, files: memberFiles, inventory });
  }
  Services.prefs.savePrefFile(
    new FileUtils.File(PathUtils.join(do_get_profile().path, "prefs.js"))
  );
  loadExistingDB();
  MailServices.accounts.accounts;
  let imapRoot = folderDB.getFolderByPath(imapServerKey);
  if (!imapRoot) {
    imapRoot = folderDB.insertRoot(imapServerKey);
  }
  const nativeImap = MailServices.accounts.getIncomingServer(imapServerKey);
  Assert.equal(nativeImap.rootFolder.id, imapRoot);
  for (const [name] of imapSourceFiles) {
    let id = folderDB.getFolderByPath(imapServerKey + "/" + name);
    if (!id) {
      id = folderDB.insertFolder(imapRoot, name);
    }
    // The root facade was initialized before these physical rows were added.
    // Attach its native child without changing the retained row's flags.
    const flags = folderDB.getFolderFlags(id);
    const folder = nativeImap.rootFolder.addSubfolder(name);
    folder.flags = flags;
    Assert.ok(folder);
    Assert.equal(folderDB.getFolderFlags(id), flags);
    Assert.equal(nativeImap.rootFolder.getChildNamed(name), folder);
    Assert.equal(folder.id, id);
    Assert.equal(folder.incomingServerType, "imap");
    Assert.equal(folder.msgStore.storeType, "mbox");
    imapFolders.set(name, folder);
  }
  registerCleanupFunction(() => nativeImap.closeCachedConnections());
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
  // A row no table old Thunderbird reads holds is not data.
  Assert.ok(convert(input, source).recordsComplete);
});

add_task(async function test_rejectsOfflineOperationsBeforeImport() {
  const { input, source } = await snapshotInput();
  const table = {
    id: 1,
    scope: "ns:msg:db:row:scope:ops:all",
    cells: [{ k: "k", v: "ns:msg:db:table:kind:ops" }],
    rows: [],
    metaRow: null,
  };
  input.records.tables.push(table);
  Assert.ok(
    convert(input, source).recordsComplete,
    "An empty operations table holds no pending work"
  );
  input.records.rows.push({
    id: 1,
    scope: "ns:msg:db:row:scope:ops:all",
    cells: [{ k: "op", v: "1" }],
  });
  table.rows.push("1:ns:msg:db:row:scope:ops:all");
  Assert.throws(
    () => convert(input, source),
    error =>
      error.message.startsWith("Unsupported Mork structural/offline table:"),
    "Pending server work is never dropped"
  );
  Assert.equal(originalFolder.getTotalMessages(false), 0);
});

add_task(async function test_importsThreadWatchIgnoreWord() {
  // The word of a thread's metadata row is user data (watch, ignore).
  const { input, source } = await snapshotInput();
  Assert.deepEqual(convert(input, source).threadFlags, []);
  const meta = input.records.rows.find(row => row.id == 1 && row.scope == "m");
  meta.cells.find(cell => cell.k == "threadFlags").v = "40000";
  const root = parseInt(meta.cells.find(cell => cell.k == "threadRoot").v, 16);
  Assert.deepEqual(convert(input, source).threadFlags, [[root, 0x40000]]);
});

add_task(async function test_rejectsUnsafeInt64FolderProjection() {
  const { input, source } = await snapshotInput();
  input.records.rows
    .find(row => row.scope == INFO_SCOPE)
    .cells.find(cell => cell.k == "folderSize").v = "7fffffffffffffff";
  Assert.throws(() => convert(input, source), /exact int64/);
});

add_task(async function test_rejectsSummaryMarkedForRebuilding() {
  const { input, source } = await snapshotInput();
  const info = input.records.rows.find(row => row.scope == INFO_SCOPE);
  const set = (name, value) => {
    const cell = info.cells.find(item => item.k == name);
    if (cell) {
      cell.v = value;
    } else {
      info.cells.push({ k: name, v: value });
    }
  };
  // The pending and message counters are a cache old Thunderbird recounts.
  set("totPendingMsgs", "1");
  set("unreadPendingMsgs", "2");
  set("numMsgs", "7f");
  set("numNewMsgs", "7f");
  Assert.ok(convert(input, source).recordsComplete);
  // A summary old Thunderbird marked for rebuilding is no usable index.
  set("forceReparse", "1");
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

/**
 * Reads the saved whole IMAP unit without giving its independent oracle to the
 * production converter. Source paths and native keys belong to this profile.
 *
 * @returns {Promise<object[]>} Complete real reader/source/folder-flag entries.
 */
async function genuineImapEntries() {
  const entries = [];
  for (const [name, { saved, inventory }] of imapSourceFiles) {
    const folder = imapFolders.get(name);
    const input = await readMorkFolderImport(
      folder,
      "snapshot-imap-" + name,
      inventory
    );
    Assert.equal(input.source.sha256, saved.sha256);
    entries.push({
      input,
      source: {
        id: name,
        protocol: "imap",
        originalFolderURI: saved.uri,
        token: input.token,
        databaseSourceId: database.sourceId,
        destinationFolderId: folder.id,
        ...input.source,
        ...(inventory ? { inventory } : {}),
        state: "importing",
        receipt: null,
      },
      folderFlags: folderDB.getFolderFlags(folder.id),
    });
  }
  return entries.sort((left, right) =>
    left.source.id.localeCompare(right.source.id)
  );
}

add_task(async function test_imapUnitAccountsUidAndOfflineRecords() {
  const entries = await genuineImapEntries();
  const request = convertMorkProtocolUnit(
    entries,
    "snapshot-imap-unit",
    database.sourceId
  );
  Assert.equal(request.version, 3);
  Assert.equal(request.protocol, "imap");
  Assert.equal(request.folders.length, imapLedger.members.length);
  for (const member of request.folders) {
    const saved = imapLedger.members.find(
      value => value.name == member.sourceId
    );
    Assert.ok(member.recordsComplete);
    Assert.deepEqual(
      member.records,
      entries.find(entry => entry.source.id == member.sourceId).input.records,
      "All original records and omitted cells remain exact"
    );
    Assert.deepEqual(member.unhandledRecords, []);
    const pending = member.records.tables.filter(
      table => table.scope == "ns:msg:db:row:scope:pending:all"
    );
    Assert.equal(pending.length, 1);
    Assert.equal(pending[0].id, 1);
    Assert.equal(pending[0].metaRow, null);
    Assert.deepEqual(pending[0].rows, []);
    Assert.deepEqual(member.imap.uidValidity, {
      present: true,
      value: saved.epoch,
    });
    Assert.equal(member.imap.originalFolderURI, saved.uri);
    Assert.deepEqual(
      member.source.messageKeys,
      saved.headers.map(header => header.key).sort((a, b) => a - b)
    );
    const expectedUids = saved.headers.flatMap(header => {
      const nativeKey = saved.keyMap.find(([, old]) => old == header.key)[0];
      const captured = saved.captured.find(
        value => value.nativeKey == nativeKey
      );
      return captured.uid === null
        ? []
        : [{ sourceKey: header.key, uid: captured.uid }];
    });
    for (const expected of expectedUids) {
      Assert.ok(
        member.imap.serverUids.some(
          actual =>
            actual.sourceKey == expected.sourceKey && actual.uid == expected.uid
        )
      );
    }
    Assert.equal(member.imap.operations.length, saved.operations.length);
    for (const original of saved.operations) {
      const operation = member.imap.operations.find(
        value => value.sourceKey == original.messageKey
      );
      Assert.ok(operation);
      Assert.equal(operation.payload.operation, original.operation);
      Assert.equal(
        operation.payload.playingBack ?? false,
        original.playingBack
      );
      Assert.equal(
        operation.payload.keywordsToAdd ?? "",
        original.keywordsToAdd
      );
      Assert.equal(
        operation.payload.keywordsToRemove ?? "",
        original.keywordsToRemove
      );
      Assert.deepEqual(
        operation.payload.copyDestinations ?? [],
        original.copies
      );
      if (original.copies.length) {
        Assert.deepEqual(
          operation.copies.map(copy => ({
            uri: imapLedger.members.find(value => value.name == copy.sourceId)
              .uri,
            ordinal: copy.ordinal,
          })),
          original.copies.map((uri, ordinal) => ({ uri, ordinal }))
        );
      }
    }
    Assert.equal(
      await IOUtils.computeHexDigest(member.source.path, "sha256"),
      saved.sha256
    );
  }
});

// An offline move or copy leaves a "move result" with a pseudo header in its
// destination. Once the source folder's operation is gone, old Thunderbird
// discards the result at its next playback; Panorama cannot hold it. Such a
// result is left out of the plan, and one that is still pending stays exact.
add_task(async function test_staleMoveResultsAreLeftOutOfThePlan() {
  const OPS = "ns:msg:db:row:scope:ops:all";
  const entries = await genuineImapEntries();
  const facts = [];
  for (const entry of entries) {
    facts.push(
      getMorkMoveResults(
        parseMorkSummary(await IOUtils.read(entry.input.source.path))
      )
    );
  }
  Assert.greater(
    facts.reduce((count, folder) => count + folder.results.length, 0),
    0,
    "The fixture has pending move results"
  );
  Assert.deepEqual(
    findStaleMoveResults(facts),
    entries.map(() => []),
    "A result whose source operation is pending is never stale"
  );

  // The source operations have been played back: their table lets go of them
  // and the destination results are leftovers.
  for (const [index, entry] of entries.entries()) {
    for (const table of entry.input.records.tables) {
      if (table.scope == OPS) {
        table.rows = table.rows.filter(
          key => !facts[index].origins.has(parseInt(key))
        );
      }
    }
  }
  const convertUnit = () =>
    convertMorkProtocolUnit(entries, "snapshot-imap-stale", database.sourceId);
  Assert.throws(
    convertUnit,
    /counterpart|Unresolved/,
    "A result without its source operation is not importable as it is"
  );
  const stale = findStaleMoveResults(
    facts.map(folder => ({ results: folder.results, origins: new Set() }))
  );
  Assert.deepEqual(
    stale,
    facts.map(folder =>
      folder.results.map(result => result.key).sort((a, b) => a - b)
    )
  );
  for (const [index, entry] of entries.entries()) {
    if (stale[index].length) {
      entry.source.omittedMessageKeys = stale[index];
      entry.source.messageKeys = entry.source.messageKeys.filter(
        key => !stale[index].includes(key)
      );
    }
  }
  const request = convertUnit();
  for (const [index, member] of request.folders.entries()) {
    const omitted = new Set(stale[index]);
    Assert.ok(member.recordsComplete);
    Assert.ok(!member.messages.some(message => omitted.has(message.sourceKey)));
    Assert.ok(!member.source.messageKeys.some(key => omitted.has(key)));
    Assert.ok(!member.imap.operations.some(op => omitted.has(op.sourceKey)));
    Assert.equal(
      member.messages.length,
      entries[index].input.messages.length -
        entries[index].input.messages.filter(message =>
          omitted.has(message.sourceKey)
        ).length,
      "Every other message is still imported"
    );
    Assert.deepEqual(
      member.records.rows,
      entries[index].input.records.rows,
      "The original rows stay, as rows no table holds"
    );
    for (const message of member.messages) {
      Assert.ok(!omitted.has(message.rootSourceKey));
      Assert.ok(!omitted.has(message.parentSourceKey));
    }
  }
});

add_task(async function test_imapUnitRejectsUnknownOrAmbiguousBinding() {
  const entries = await genuineImapEntries();
  const convertUnit = values =>
    convertMorkProtocolUnit(values, "snapshot-imap-refusal", database.sourceId);
  Assert.throws(
    () =>
      convertUnit(
        entries.filter(entry => entry.source.id != "MigrationCopyOne")
      ),
    /counterpart|destination|Unresolved/
  );
  const pendingState = structuredClone(entries);
  const pendingMember = pendingState[0].input.records;
  const pendingTable = pendingMember.tables.find(
    table => table.scope == "ns:msg:db:row:scope:pending:all"
  );
  Assert.ok(pendingTable);
  pendingTable.rows.push(
    pendingMember.rows[0].id + ":" + pendingMember.rows[0].scope
  );
  // Attributes kept for a message that has not arrived yet have no native
  // place. They refuse nothing and are reported by count, never dropped
  // unseen.
  const notes = [];
  Assert.equal(
    convertMorkProtocolUnit(
      pendingState,
      "snapshot-imap-refusal",
      database.sourceId,
      (...note) => notes.push(note)
    ).folders.length,
    entries.length
  );
  Assert.deepEqual(notes, [
    ["pending-header-attributes", pendingState[0].source.id, 1],
  ]);
  // Pending server work in the operations table stays exact.
  const foreignWork = structuredClone(entries);
  foreignWork[0].input.records.tables.push({
    id: 9,
    scope: "ns:msg:db:row:scope:ops:all",
    cells: [{ k: "k", v: "ns:msg:db:table:kind:other" }],
    metaRow: null,
    rows: [],
  });
  Assert.throws(
    () => convertUnit(foreignWork),
    /Unsupported Mork structural\/offline table: 9:ns:msg:db:row:scope:ops:all/
  );
  const unread = structuredClone(entries);
  const append = unread.find(entry => entry.source.id == "MigrationAppend");
  const readMeta = append.input.records.rows.find(row => row.scope == "m");
  Assert.ok(!readMeta.cells.some(cell => cell.k == "unreadChildren"));
  readMeta.cells.push({ k: "unreadChildren", v: "1" });
  Assert.equal(
    convertUnit(unread).folders.length,
    entries.length,
    "A thread's cached unread count is recounted, never compared"
  );
  const retired = structuredClone(entries);
  const classic = retired.find(entry => entry.source.id == "MigrationClassic");
  const emptyThread = classic.input.records.tables.find(
    table =>
      table.scope == "ns:msg:db:row:scope:msgs:all" &&
      table.cells.some(
        cell => cell.k == "k" && cell.v == "ns:msg:db:table:kind:thread"
      ) &&
      table.rows.length === 0
  );
  Assert.ok(emptyThread);
  const retiredMeta = classic.input.records.rows.find(
    row => row.id + ":" + row.scope == emptyThread.metaRow
  );
  retiredMeta.cells.find(cell => cell.k == "threadFlags").v = "1";
  Assert.ok(
    convertUnit(retired).folders.every(folder => !folder.threadFlags.length),
    "A thread without headers has no word to import"
  );
  const alias = structuredClone(entries);
  alias[1].source.originalFolderURI = alias[0].source.originalFolderURI;
  Assert.throws(
    () => convertUnit(alias),
    /Duplicate or invalid Mork protocol folder identity/
  );
  const unknown = structuredClone(entries);
  const member = unknown.find(entry => entry.input.source.messageKeys.length);
  const row = member.input.records.rows.find(
    record => record.scope == "ns:msg:db:row:scope:ops:all"
  );
  Assert.ok(row, "The genuine input contains an actual operation row");
  row.cells.push({ k: "unrecognizedRequiredOperation", v: "1" });
  Assert.throws(
    () => convertUnit(unknown),
    /Unsupported Mork offline property/
  );
  for (const entry of entries) {
    const saved = imapLedger.members.find(
      value => value.name == entry.source.id
    );
    Assert.equal(
      await IOUtils.computeHexDigest(entry.source.path, "sha256"),
      saved.sha256
    );
    Assert.equal([...imapFolders.get(entry.source.id).messages].length, 0);
  }
});

// Retained whole015 native IMAP summary, byte-exact SHA256 below.
const MISSING_NEWEST_IMAP_SHA256 =
  "740a7bd8d9a44550e72c783df794aeb9e3acab63b42790a91192763507bf2f9d";
const MISSING_NEWEST_IMAP_SOURCE = [
  '// <!-- <mdb:mork:z v="1.4"/> -->',
  "< <(a=c)> // (f=iso-8859-1)",
  "  (80=ns:msg:db:row:scope:msgs:all)(81=subject)(82=sender)(83=message-id)",
  "  (84=references)(85=recipients)(86=date)(87=size)(88=flags)(89=priority)",
  "  (8A=label)(8B=numLines)(8C=ccList)(8D=bccList)(8E=msgThreadId)",
  "  (8F=threadId)(90=threadFlags)(91=threadNewestMsgDate)(92=children)",
  "  (93=unreadChildren)(94=threadSubject)(95=msgCharSet)",
  "  (96=ns:msg:db:table:kind:msgs)(97=ns:msg:db:table:kind:thread)",
  "  (98=ns:msg:db:table:kind:allthreads)",
  "  (99=ns:msg:db:row:scope:threads:all)(9A=threadParent)(9B=threadRoot)",
  "  (9C=msgOffset)(9D=offlineMsgSize)(9E=uidOnServer)",
  "  (9F=ns:msg:db:row:scope:dbfolderinfo:all)",
  "  (A0=ns:msg:db:table:kind:dbfolderinfo)(A1=numMsgs)(A2=numNewMsgs)",
  "  (A3=folderSize)(A4=expungedBytes)(A5=folderDate)(A6=highWaterKey)",
  "  (A7=mailboxName)(A8=UIDValidity)(A9=totPendingMsgs)",
  "  (AA=unreadPendingMsgs)(AB=version)(AC=forceReparse)",
  "  (AD=fixedBadRefThreading)(AE=onlineName)(AF=userSortOrder)",
  "  (B0=folderName)(B1=indexingPriority)(B2=imapFlags)(B3=s526-custom)",
  "  (B4=ProtoThreadFlags)(B5=ns:msg:db:row:scope:pending:all)",
  "  (B6=ns:msg:db:table:kind:pending)>",
  "<(8A=2a)(81=0)(80=1)>[1:m(^9B=2a)(^8F=2a)(^90=0)(^92=1)(^93=1)]",
  "",
  "<(88=imap-activation-s526@invalid)(89=Original IMAP startup migration)",
  "  (8B=imap-retained)(8C=ffffffff)>",
  "{1:^80 {(k^96:c)(s=9)} ",
  "  [2A(^83^88)(^81^89)(^9E=2a)(^B3^8B)(^9A^8C)(^8E=2a)(^B4=0)]}",
  "{2A:^80 {(k^97:c)(s=9)1:m } 2A }",
  "{FFFFFFFD:^99 {(k^98:c)(s=9)} [2A(^94^89)]}",
  "",
  "<(82=INBOX)(85=8003014)(86=e000)(87=20e)>",
  "{1:^9F {(k^A0:c)(s=9u)} ",
  "  [1(^AB=1)(^AC=0)(^AD=1)(^AE^82)(^88^85)(^A7^82)(^B2^86)(^A8^87)(^A1=1)",
  "    (^A2=1)(^A6=2a)]}",
  "",
  "@$${C{@",
  "@$$}C}@",
  "",
].join("\n");

/**
 * Copies the retained native summary to an owned IMAP folder and reads it.
 * Does not open a Mork database or add missing cells to the original bytes.
 *
 * @returns {Promise<{input: object, source: object, folderFlags: number}>}
 *   Ordinary reader input and its source plan for the existing converter.
 */
async function missingNewestImapEntry() {
  const root =
    MailServices.accounts.getIncomingServer(imapServerKey).rootFolder;
  const folder = root.addSubfolder(
    "missing-newest-" + Services.uuid.generateUUID().toString().slice(1, -1)
  );
  folder.flags = 0x8003014;
  const summary = folder.summaryFile;
  Assert.ok(!summary.exists(), "The test owns a new summary path");
  await IOUtils.write(
    summary.path,
    new TextEncoder().encode(MISSING_NEWEST_IMAP_SOURCE),
    { mode: "create" }
  );
  registerCleanupFunction(() =>
    IOUtils.remove(summary.path, { ignoreAbsent: true })
  );
  const inventory =
    AppConstants.platform == "win"
      ? captureMorkFolderWindowsInventory(
          summary,
          do_get_profile(),
          folder.filePath,
          do_get_profile()
        )
      : undefined;
  const input = await readMorkFolderImport(
    folder,
    "snapshot-missing-newest-" + folder.id,
    inventory
  );
  Assert.equal(input.source.sha256, MISSING_NEWEST_IMAP_SHA256);
  return {
    input,
    source: {
      id: "retained-missing-newest-" + folder.id,
      protocol: "imap",
      originalFolderURI: folder.URI,
      token: input.token,
      databaseSourceId: database.sourceId,
      destinationFolderId: folder.id,
      ...input.source,
      ...(inventory ? { inventory } : {}),
      state: "importing",
      receipt: null,
    },
    folderFlags: folder.flags,
  };
}

add_task(async function test_convertsOriginalImapNoNewestDateCache() {
  const entry = await missingNewestImapEntry();
  const original = structuredClone(entry.input);
  const metadata = original.records.rows.find(row => row.scope == "m");
  Assert.ok(!metadata.cells.some(cell => cell.k == "threadNewestMsgDate"));
  const request = convertMorkProtocolUnit(
    [entry],
    "missing-newest-unit",
    database.sourceId
  );
  const member = request.folders[0];
  Assert.equal(member.recordsComplete, true);
  Assert.deepEqual(member.unhandledRecords, []);
  Assert.deepEqual(member.records, original.records);
  Assert.deepEqual(member.source.messageKeys, [42]);
  Assert.equal(member.messages[0].sourceKey, 42);
  Assert.equal(member.messages[0].rootSourceKey, 42);
  Assert.equal(member.messages[0].parentSourceKey, null);
  Assert.equal(member.messages[0].header.date, 0);
  Assert.deepEqual(member.imap.serverUids, [{ sourceKey: 42, uid: 42 }]);
  Assert.deepEqual(member.imap.uidValidity, { present: true, value: 526 });
  Assert.deepEqual(
    entry.input,
    original,
    "No source cell is inserted or changed"
  );
  Assert.deepEqual(
    await IOUtils.read(entry.source.path),
    new TextEncoder().encode(MISSING_NEWEST_IMAP_SOURCE)
  );
});

add_task(async function test_threadCachesAreHintsAndWordIsImported() {
  const entry = await missingNewestImapEntry();
  const convertEntry = value =>
    convertMorkProtocolUnit([value], "thread-cache-hints", database.sourceId);
  Assert.equal(convertEntry(entry).folders.length, 1);
  // The per-thread metadata row caches counts, a newest date and the root.
  // Old Thunderbird recounts and reroots; stale or absent cells refuse nothing.
  const variants = [
    ["threadNewestMsgDate", "1"],
    ["threadNewestMsgDate", "ffffffff"],
    ["threadNewestMsgDate", "g"],
    ["unknownThreadCell", "0"],
    ["children", "2"],
    ["unreadChildren", "0"],
    ["threadRoot", "2b"],
    ["threadRoot", "not hex"],
    ["threadRoot", null],
    ["threadId", null],
    ["children", null],
    ["unreadChildren", null],
    ["threadFlags", null],
    ["threadFlags", "not hex"],
  ];
  for (const [name, value] of variants) {
    const changed = structuredClone(entry);
    const row = changed.input.records.rows.find(record => record.scope == "m");
    const cell = row.cells.find(item => item.k == name);
    if (value === null) {
      row.cells = row.cells.filter(item => item.k != name);
    } else if (cell) {
      cell.v = value;
    } else {
      row.cells.push({ k: name, v: value });
    }
    const [member] = convertEntry(changed).folders;
    Assert.equal(member.messages[0].rootSourceKey, 42, name + ": " + value);
    Assert.equal(member.messages[0].parentSourceKey, null, name);
    Assert.deepEqual(member.threadFlags, [], name);
  }
  // The watch/ignore word is user data.
  const watched = structuredClone(entry);
  const meta = watched.input.records.rows.find(record => record.scope == "m");
  meta.cells.find(item => item.k == "threadFlags").v = "100";
  Assert.deepEqual(convertEntry(watched).folders[0].threadFlags, [[42, 0x100]]);
  Assert.equal(
    await IOUtils.computeHexDigest(entry.source.path, "sha256"),
    MISSING_NEWEST_IMAP_SHA256,
    "Variants change only owned parsed models"
  );
});

add_task(async function test_imapUnitAccountsLegacyDerivedAndDeletedRecords() {
  const entries = await genuineImapEntries();
  const convertUnit = values =>
    convertMorkProtocolUnit(values, "snapshot-imap-derived", database.sourceId);
  const MESSAGES = "ns:msg:db:row:scope:msgs:all";
  const kindOf = table => table.cells.find(cell => cell.k == "k")?.v;
  const memberOf = values =>
    values.find(entry =>
      entry.input.records.tables.some(
        table =>
          kindOf(table) == "ns:msg:db:table:kind:allthreads" &&
          table.rows.length
      )
    );
  const withTable = (kind, rows) => {
    const values = structuredClone(entries);
    const records = memberOf(values).input.records;
    records.tables.push({
      id: 0xfffffff0,
      scope: MESSAGES,
      cells: [
        { k: "k", v: kind },
        { k: "s", v: "9" },
      ],
      rows: rows(records),
      metaRow: null,
    });
    return values;
  };
  const liveHeaders = records =>
    records.tables.find(table => kindOf(table) == "ns:msg:db:table:kind:msgs")
      .rows;

  // A unified folder view caches hits on live headers of this folder.
  const unified = withTable(
    "mailbox://nobody@smart%20mailboxes/Inbox",
    liveHeaders
  );
  const converted = convertUnit(unified);
  Assert.ok(
    converted.folders.every(folder => folder.recordsComplete),
    "Cached unified folder hits are accounted"
  );
  // A stale hit and the cache of any other search folder are derived too.
  for (const stale of [
    withTable("mailbox://nobody@smart%20mailboxes/Inbox", records => [
      ...liveHeaders(records),
      "999999:" + MESSAGES,
    ]),
    withTable("mailbox://nobody@Local%20Folders/Saved", liveHeaders),
  ]) {
    Assert.ok(
      convertUnit(stale).folders.every(folder => folder.recordsComplete),
      "A search cache is rebuilt, never imported or compared"
    );
  }

  // A live thread may be missing from the derived all-threads subject index.
  const unindexed = structuredClone(entries);
  const records = memberOf(unindexed).input.records;
  const index = records.tables.find(
    table => kindOf(table) == "ns:msg:db:table:kind:allthreads"
  );
  const subjectKey = index.rows.shift();
  convertUnit(unindexed);
  const subject = records.rows.find(
    row => row.id + ":" + row.scope == subjectKey
  );
  subject.cells.find(cell => cell.k == "threadSubject").v += " changed";
  convertUnit(unindexed);

  // A played-back offline operation or pending attribute is deleted by
  // cutting it from its table and cutting all its cells.
  const deleted = structuredClone(entries);
  const deletedRecords = memberOf(deleted).input.records;
  for (const scope of [
    "ns:msg:db:row:scope:ops:all",
    "ns:msg:db:row:scope:pending:all",
  ]) {
    deletedRecords.rows.push({ id: 777, scope, cells: [] });
  }
  convertUnit(deleted);
  // Old Thunderbird reads pending operations through their table only: a
  // row cut from it is no pending work, with or without leftover cells.
  deletedRecords.rows.at(-2).cells.push({ k: "op", v: "1" });
  convertUnit(deleted);
});
