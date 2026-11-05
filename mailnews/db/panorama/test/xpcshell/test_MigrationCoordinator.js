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
const { MigrationJournal } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationJournal.sys.mjs"
);
const { createMigrationBackup } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationBackup.sys.mjs"
);
const { readMorkFolderImport, captureMorkFolderWindowsInventory } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MorkFolderImport.sys.mjs"
  );
const { importMorkFolderSnapshot, convertMorkProtocolUnit } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MorkSnapshotAdapter.sys.mjs"
  );
const {
  resumeMorkImports,
  createPanoramaMigrationTarget,
  createWindowsPanoramaMigrationTarget,
} = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationCoordinator.sys.mjs"
);

let profileLock;
let work;
let backup;
const originals = new Map();
const inventories = new Map();
const names = [
  "native-success",
  "native-reconcile",
  "native-cancel",
  "native-reply-loss",
  "native-pin",
  "native-lock",
  "native-wrong-folder",
  "native-transaction",
  "native-nonlocal",
  "native-alias",
  "native-below-root-link",
  "native-store-link",
  "native-outside",
  "native-no-store",
  ...(AppConstants.platform == "win"
    ? [
        "native-win-success",
        "native-win-reconcile",
        "native-win-wrong-folder",
        "native-win-backup",
      ]
    : []),
];

let imapLedger, imapServerKey;
const imapSourceFiles = new Map();
const imapFolders = new Map();

add_setup(async function setupClosedLegacyProfileThenNativeTarget() {
  // Hashing must not leave certificate database writers in this mail fixture.
  Services.prefs.setBoolPref("security.nocertdb", true);
  const profile = do_get_profile();
  const provider = Cc["@mozilla.org/xre/directory-provider;1"]
    .getService(Ci.nsIDirectoryServiceProvider)
    .QueryInterface(Ci.nsIXREDirProvider);
  for (const key of ["DefProfRt", "DefProfLRt", "UAppData"]) {
    Services.dirsvc.set(key, provider.getFile(key, {}).clone());
  }
  const service = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
    Ci.nsIToolkitProfileService
  );
  const nativeProfile = service.createProfile(
    profile,
    "migration-coordinator",
    "tests"
  );
  profileLock = nativeProfile.lock({});
  registerCleanupFunction(() => {
    profileLock.unlock();
    nativeProfile.remove(false);
  });
  work = await IOUtils.createUniqueDirectory(
    PathUtils.parent(profileLock.directory.path),
    "migration-native-coordinator-"
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
  // Initialize NSS in no-DB mode before inventorying the quiesced profile.
  Assert.equal(
    await IOUtils.computeHexDigest(summary.path, "sha256"),
    "7a262023b98fe964d105de06bf1ddca60f90ee19073e38afda8c885be5a47703",
    "The copied legacy summary retains its genuine fixture bytes"
  );
  const creator = new ProfileCreator(profile);
  const local = creator.addLocalServer();
  for (const name of names.filter(value => value != "native-nonlocal")) {
    const files = await local.rootFolder.addMailFolder(name, {
      summary,
      mbox: body,
    });
    if (AppConstants.platform == "win") {
      inventories.set(
        name,
        captureMorkFolderWindowsInventory(
          new FileUtils.File(files.summaryFilePath),
          profileLock.directory,
          new FileUtils.File(files.mailFilePath),
          profileLock.directory
        )
      );
    }
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
  const imap = creator.addServer(
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
    const files = await imap.rootFolder.addMailFolder(saved.name, {
      summary: summaryInput,
      mbox: bodyInput,
    });
    const inventory =
      AppConstants.platform == "win"
        ? captureMorkFolderWindowsInventory(
            new FileUtils.File(files.summaryFilePath),
            do_get_profile(),
            new FileUtils.File(files.mailFilePath),
            do_get_profile()
          )
        : undefined;
    imapSourceFiles.set(saved.name, { saved, files, inventory });
  }
  Services.prefs.savePrefFile(
    new FileUtils.File(PathUtils.join(do_get_profile().path, "prefs.js"))
  );
  const serverKey = "migrationNativeImap";
  const prefix = "mail.server." + serverKey + ".";
  const imapDirectory = profile.clone();
  imapDirectory.append("native-imap");
  await IOUtils.makeDirectory(imapDirectory.path);
  await IOUtils.copy(
    summary.path,
    PathUtils.join(imapDirectory.path, "native-nonlocal.msf")
  );
  await IOUtils.copy(
    body.path,
    PathUtils.join(imapDirectory.path, "native-nonlocal")
  );
  for (const [name, value] of Object.entries({
    type: "imap",
    userName: "migration",
    hostname: "migration.invalid",
    storeContractID: "@mozilla.org/msgstore/berkeleystore;1",
  })) {
    Services.prefs.setStringPref(prefix + name, value);
  }
  Services.prefs.setComplexValue(
    prefix + "directory",
    Ci.nsIFile,
    imapDirectory
  );
  Services.prefs.savePrefFile(
    new FileUtils.File(PathUtils.join(profile.path, "prefs.js"))
  );
  if (AppConstants.platform == "win") {
    inventories.set(
      "native-nonlocal",
      captureMorkFolderWindowsInventory(
        new FileUtils.File(
          PathUtils.join(imapDirectory.path, "native-nonlocal.msf")
        ),
        profileLock.directory,
        new FileUtils.File(
          PathUtils.join(imapDirectory.path, "native-nonlocal")
        ),
        profileLock.directory
      )
    );
  }
  Assert.ok(
    !(await IOUtils.exists(PathUtils.join(profile.path, "panorama.sqlite"))),
    "Closed source backup precedes target startup"
  );
  const backupRoot = await IOUtils.createUniqueDirectory(
    PathUtils.parent(profileLock.directory.path),
    "migration-coordinator-backup-"
  );
  registerCleanupFunction(() =>
    IOUtils.remove(backupRoot, { recursive: true })
  );
  for (const name of ["cert9.db", "key4.db"]) {
    Assert.ok(
      !(await IOUtils.exists(PathUtils.join(profile.path, name))),
      "The closed mail fixture has no live NSS database: " + name
    );
  }
  backup = await createMigrationBackup(
    profileLock.directory.path,
    [],
    PathUtils.join(backupRoot, "backup")
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
  const localRoot = MailServices.accounts.localFoldersServer.rootFolder;
  for (const name of names.filter(value => value != "native-nonlocal")) {
    originals.set(name, localRoot.getChildNamed(name));
  }
  const rootId = folderDB.insertRoot(serverKey);
  const folderId = folderDB.insertFolder(rootId, "native-nonlocal");
  folderDB.updateFlags(folderId, Ci.nsMsgFolderFlags.Mail);
  const imapServer = MailServices.accounts.getIncomingServer(serverKey);
  const account = MailServices.accounts.createAccount();
  account.incomingServer = imapServer;
  registerCleanupFunction(() => {
    imapServer.closeCachedConnections();
    MailServices.accounts.removeAccount(account, false);
    Services.prefs.deleteBranch(prefix);
  });
  originals.set(
    "native-nonlocal",
    imapServer.rootFolder.getChildNamed("native-nonlocal")
  );
  for (const name of names) {
    Assert.ok(
      originals.get(name),
      "Actual native source folder exists: " + name
    );
    Assert.ok(originals.get(name) instanceof Ci.nsIMsgFolder);
  }
  Assert.equal(originals.get("native-nonlocal").id, folderId);
  Assert.equal(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    ),
    database
  );
  Assert.equal(typeof database.importFolderSnapshot, "function");
  Assert.equal(typeof database.getFolderImportReceipt, "function");
  Assert.equal(originals.get("native-success").msgStore.storeType, "mbox");
  registerCleanupFunction(() => {
    originals.clear();
    inventories.clear();
  });
});

/**
 * Creates a real import journal backed by the pre-target complete source backup.
 *
 * @param {string} name - Separate actual destination folder for this case.
 * @param {string} [databaseSourceId=database.sourceId] - Retained plan incarnation.
 * @returns {Promise<object>} Open journal, native folder and immutable byte copies.
 */
async function plannedImport(name, databaseSourceId = database.sourceId) {
  const folder = originals.get(name);
  const inventory = inventories.get(name);
  const input = await readMorkFolderImport(folder, "plan-input", inventory);
  const path = PathUtils.join(work, name + ".json");
  const journal = await MigrationJournal.create(path, {
    profilePath: profileLock.directory.path,
    mailPaths: [],
    backupPath: PathUtils.parent(backup.path),
    sources: [
      {
        id: name,
        databaseSourceId,
        path: input.source.path,
        size: input.source.size,
        sha256: input.source.sha256,
        messageKeys: [3, 1],
        destinationFolderId: folder.id,
        ...(inventory
          ? { inventory, physicalIdentity: input.source.physicalIdentity }
          : {}),
      },
    ],
  });
  registerCleanupFunction(() => journal.close());
  await journal.recordBackup(backup);
  return {
    journal,
    folder,
    path,
    name,
    summary: await IOUtils.read(folder.summaryFile.path),
    body: await IOUtils.read(folder.filePath.path),
  };
}

/** @param {object} input - Planned case. @returns {object} Real native backend boundary. */
function targetFor(input) {
  return createPanoramaMigrationTarget(
    input.journal,
    database,
    id => {
      Assert.equal(id, input.name);
      return input.folder;
    },
    profileLock
  );
}

/**
 * Queries native headers by committed physical key, never by Message-ID identity.
 *
 * @param {object} input - Planned case.
 * @returns {Promise<void>} Independent destination and immutable-source assertions.
 */
async function assertCommitted(input) {
  const source = input.journal.state.sources[0];
  Assert.equal(source.state, "imported");
  Assert.equal(source.databaseSourceId, database.sourceId);
  Assert.deepEqual(
    source.receipt.keys.map(pair => pair[0]),
    [1, 3]
  );
  const keys = source.receipt.keys.map(pair => pair[1]);
  Assert.equal(new Set(keys).size, 2);
  Assert.ok(keys.every(key => key > 0 && key < 0xffffffff));
  const headers = new Map(
    Array.from(input.folder.messages, header => [header.messageKey, header])
  );
  Assert.equal(headers.size, 2);
  const expected = new Map([
    [1, ["162378@invalid", "0", 578]],
    [3, ["345692@invalid", "1143", 375]],
  ]);
  for (const [oldKey, key] of source.receipt.keys) {
    const header = headers.get(key);
    Assert.ok(header);
    Assert.deepEqual(
      [header.messageId, header.storeToken, header.messageSize],
      expected.get(oldKey)
    );
    Assert.greater(header.threadId, 0);
    Assert.equal(header.threadParent, 0);
  }
  Assert.notEqual(headers.get(keys[0]).threadId, headers.get(keys[1]).threadId);
  Assert.equal(
    input.folder.msgDatabase.dBFolderInfo.getUint32Property("sortType", 0),
    18
  );
  Assert.equal(
    input.folder.msgDatabase.dBFolderInfo.getCharProperty("MRUTime"),
    "1747364552"
  );
  Assert.equal(
    input.folder.msgDatabase.dBFolderInfo.getCharProperty("sortColumns"),
    "\x122"
  );
  Assert.deepEqual(
    await IOUtils.read(input.folder.summaryFile.path),
    input.summary
  );
  Assert.deepEqual(await IOUtils.read(input.folder.filePath.path), input.body);
  Assert.equal(
    await IOUtils.computeHexDigest(backup.path, "sha256"),
    backup.sha256
  );
  Assert.ok(
    !(await IOUtils.exists(
      PathUtils.join(profileLock.directory.path, "panorama-profile.json")
    )),
    "Mail import does not activate the profile"
  );
}

add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function test_windowsNativeTargetRemainsUnsupported() {
    const input = await plannedImport("native-success");
    Assert.equal(input.journal.state.version, 4);
    Assert.equal(input.journal.state.sources[0].inventory.version, 2);
    const before = await IOUtils.read(input.path);
    Assert.throws(() => targetFor(input), /requires native reparse admission/);
    Assert.deepEqual(await IOUtils.read(input.path), before);
    Assert.equal(database.messageDB.totalCount, 0);
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  function test_windowsExplicitTargetRefusesOtherPlatformsBeforeIO() {
    Assert.throws(
      () => createWindowsPanoramaMigrationTarget(null, null, null, null),
      /version2 migration requires Windows/
    );
  }
);

/** @param {object} input - Real journal/native folder. @returns {object} Explicit v2 target. */
function windowsTargetFor(input) {
  return createWindowsPanoramaMigrationTarget(
    input.journal,
    database,
    id => {
      Assert.equal(id, input.name);
      return input.folder;
    },
    profileLock
  );
}

/** @param {object} input - Committed real import. */
function assertWindowsReceipt(input) {
  const source = input.journal.state.sources[0];
  const receipt = source.receipt;
  Assert.equal(input.journal.state.version, 4);
  Assert.equal(receipt.version, 2);
  Assert.equal(receipt.databaseSourceId, database.sourceId);
  Assert.equal(receipt.sourceId, source.id);
  Assert.deepEqual(receipt.sourcePhysicalIdentity, source.physicalIdentity);
  for (const kind of ["summary", "store"]) {
    for (const [name, value] of Object.entries(
      source.inventory.windowsAdmission[kind]
    )) {
      Assert.equal(receipt.windowsAdmission[kind][name], value);
    }
    Assert.equal(
      receipt.windowsAdmission[kind].canonicalRoot,
      input.journal.state.profilePath
    );
  }
  Assert.equal(receipt.windowsAdmission.summary.canonicalPath, source.path);
}

add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function test_explicitWindowsTargetCommitsMeasuredReceipt() {
    const input = await plannedImport("native-win-success");
    await resumeMorkImports(input.journal, windowsTargetFor(input));
    Assert.equal(input.journal.state.stage, "validate");
    await assertCommitted(input);
    assertWindowsReceipt(input);
    input.journal.close();
    input.journal = await MigrationJournal.open(
      input.path,
      profileLock.directory.path
    );
    registerCleanupFunction(() => input.journal.close());
    const source = input.journal.state.sources[0];
    const before = await IOUtils.read(input.path);
    const count = database.messageDB.totalCount;
    const receipt = await windowsTargetFor(input).findReceipt(source.token, {
      sourceId: source.id,
      sourceSha256: source.sha256,
      destinationFolderId: source.destinationFolderId,
    });
    Assert.deepEqual(receipt.windowsAdmission, source.receipt.windowsAdmission);
    Assert.deepEqual(receipt.keys, source.receipt.keys);
    Assert.equal(database.messageDB.totalCount, count);
    Assert.deepEqual(await IOUtils.read(input.path), before);
  }
);

add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function test_windowsReconcilesNativeCommitBeforeCheckpoint() {
    const input = await plannedImport("native-win-reconcile");
    await input.journal.beginImport(input.name);
    const committed = await importMorkFolderSnapshot(
      database,
      input.folder,
      input.journal.state.sources[0]
    );
    Assert.equal(input.journal.state.sources[0].receipt, null);
    input.journal.close();
    input.journal = await MigrationJournal.open(
      input.path,
      profileLock.directory.path
    );
    registerCleanupFunction(() => input.journal.close());
    const target = windowsTargetFor(input);
    target.importFolder = async () => {
      throw new Error("Must reconcile, never reimport");
    };
    const count = database.messageDB.totalCount;
    await resumeMorkImports(input.journal, target);
    Assert.equal(database.messageDB.totalCount, count);
    Assert.deepEqual(
      input.journal.state.sources[0].receipt.windowsAdmission,
      committed.windowsAdmission
    );
    await assertCommitted(input);
    assertWindowsReceipt(input);
  }
);

add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function test_windowsRejectsAnotherPhysicalFolderBeforeNativeWrites() {
    const input = await plannedImport("native-win-wrong-folder");
    const count = database.messageDB.totalCount;
    const target = createWindowsPanoramaMigrationTarget(
      input.journal,
      database,
      () => originals.get("native-pin"),
      profileLock
    );
    await Assert.rejects(
      resumeMorkImports(input.journal, target),
      /Original Windows inventory differs from native folder/
    );
    Assert.equal(database.messageDB.totalCount, count);
    Assert.equal(input.journal.state.sources[0].receipt, null);
    Assert.deepEqual(
      await IOUtils.read(input.folder.summaryFile.path),
      input.summary
    );
    Assert.deepEqual(
      await IOUtils.read(input.folder.filePath.path),
      input.body
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function test_windowsRejectsChangedBackupBeforeNativeWrites() {
    const input = await plannedImport("native-win-backup");
    const target = windowsTargetFor(input);
    const manifest = await IOUtils.read(backup.path);
    const count = database.messageDB.totalCount;
    try {
      await IOUtils.write(backup.path, new Uint8Array([...manifest, 0x20]));
      await Assert.rejects(
        resumeMorkImports(input.journal, target),
        /backup identity changed/
      );
      Assert.equal(database.messageDB.totalCount, count);
      Assert.equal(input.journal.state.sources[0].receipt, null);
      Assert.deepEqual(
        await IOUtils.read(input.folder.summaryFile.path),
        input.summary
      );
      Assert.deepEqual(
        await IOUtils.read(input.folder.filePath.path),
        input.body
      );
    } finally {
      await IOUtils.write(backup.path, manifest);
    }
    await resumeMorkImports(input.journal, windowsTargetFor(input));
    await assertCommitted(input);
    assertWindowsReceipt(input);
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_nativeImportCheckpointsCompleteReceipt() {
    const input = await plannedImport("native-success");
    await resumeMorkImports(input.journal, targetFor(input));
    Assert.equal(input.journal.state.stage, "validate");
    await assertCommitted(input);
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_reconcilesRealCommitBeforeJournalCheckpoint() {
    const input = await plannedImport("native-reconcile");
    await input.journal.beginImport(input.name);
    const committed = await importMorkFolderSnapshot(
      database,
      input.folder,
      input.journal.state.sources[0]
    );
    Assert.equal(input.journal.state.sources[0].state, "importing");
    input.journal.close();
    input.journal = await MigrationJournal.open(
      input.path,
      profileLock.directory.path
    );
    registerCleanupFunction(() => input.journal.close());
    const target = targetFor(input);
    target.importFolder = async () => {
      throw new Error("Receipt reconciliation must not import again");
    };
    const before = database.messageDB.totalCount;
    await resumeMorkImports(input.journal, target);
    Assert.deepEqual(
      input.journal.state.sources[0].receipt.keys,
      committed.keys
    );
    Assert.equal(database.messageDB.totalCount, before);
    await assertCommitted(input);
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_cancellationAfterRealCommitKeepsReceipt() {
    const input = await plannedImport("native-cancel");
    const controller = new AbortController();
    const target = targetFor(input);
    const nativeImport = target.importFolder.bind(target);
    target.importFolder = async request => {
      const receipt = await nativeImport(request);
      controller.abort();
      return receipt;
    };
    await Assert.rejects(
      resumeMorkImports(input.journal, target, controller.signal),
      error => error.name == "AbortError"
    );
    Assert.equal(input.journal.state.cancelled, true);
    Assert.equal(input.journal.state.stage, "import");
    await assertCommitted(input);
    const count = database.messageDB.totalCount;
    await input.journal.setCancelled(false);
    await resumeMorkImports(input.journal, targetFor(input));
    Assert.equal(database.messageDB.totalCount, count);
    Assert.equal(input.journal.state.stage, "validate");
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_deliveryErrorAfterRealCommitReconcilesOnRetry() {
    const input = await plannedImport("native-reply-loss");
    const target = targetFor(input);
    const nativeImport = target.importFolder.bind(target);
    const failure = new Error("Receipt delivery failed after native commit");
    target.importFolder = async request => {
      await nativeImport(request);
      throw failure;
    };
    await Assert.rejects(
      resumeMorkImports(input.journal, target),
      error => error === failure
    );
    Assert.equal(input.journal.state.sources[0].state, "importing");
    Assert.equal(input.journal.state.sources[0].receipt, null);
    Assert.equal(input.journal.state.lastError.message, failure.message);
    Assert.equal(
      Array.from(input.folder.messages).length,
      2,
      "Committed rows are not called rolled back"
    );
    const count = database.messageDB.totalCount;
    await resumeMorkImports(input.journal, targetFor(input));
    Assert.equal(database.messageDB.totalCount, count);
    await assertCommitted(input);
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_rejectsChangedIncarnationBeforeIntent() {
    const input = await plannedImport("native-pin", "another-database");
    const before = await IOUtils.read(input.path);
    Assert.throws(() => targetFor(input), /incarnation differs/);
    Assert.deepEqual(await IOUtils.read(input.path), before);
    Assert.equal(input.journal.state.sources[0].state, "pending");
    Assert.equal(Array.from(input.folder.messages).length, 0);
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_rejectsAnotherActualFolderBeforeNativeWrites() {
    const input = await plannedImport("native-wrong-folder");
    const count = database.messageDB.totalCount;
    const target = createPanoramaMigrationTarget(
      input.journal,
      database,
      () => originals.get("native-pin"),
      profileLock
    );
    await Assert.rejects(
      resumeMorkImports(input.journal, target),
      /journal\/database identity/
    );
    Assert.equal(database.messageDB.totalCount, count);
    Assert.equal(Array.from(input.folder.messages).length, 0);
    Assert.equal(Array.from(originals.get("native-pin").messages).length, 0);
    Assert.equal(input.journal.state.sources[0].receipt, null);
    Assert.deepEqual(
      await IOUtils.read(input.folder.summaryFile.path),
      input.summary
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_nativeSourceIdentityTransactionConflictCanRetry() {
    const input = await plannedImport("native-transaction");
    const connection = database.connectionForTests;
    const count = database.messageDB.totalCount;
    const target = targetFor(input);
    connection.beginTransaction();
    try {
      await Assert.rejects(
        resumeMorkImports(input.journal, target),
        /NS_ERROR_IN_PROGRESS/
      );
      Assert.ok(
        connection.transactionInProgress,
        "Native sourceId guard leaves the foreign transaction owned by caller"
      );
      Assert.equal(database.messageDB.totalCount, count);
    } finally {
      connection.rollbackTransaction();
    }
    Assert.equal(input.journal.state.sources[0].receipt, null);
    await resumeMorkImports(input.journal, targetFor(input));
    await assertCommitted(input);
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_nonlocalFolderRejectsBeforeImport() {
    const input = await plannedImport("native-nonlocal");
    Assert.equal(input.folder.incomingServerType, "imap");
    const count = database.messageDB.totalCount;
    await Assert.rejects(
      resumeMorkImports(input.journal, targetFor(input)),
      /Unsupported Mork protocol/
    );
    Assert.equal(database.messageDB.totalCount, count);
    Assert.equal(input.journal.state.sources[0].receipt, null);
    Assert.deepEqual(
      await IOUtils.read(input.folder.summaryFile.path),
      input.summary
    );
    Assert.deepEqual(
      await IOUtils.read(input.folder.filePath.path),
      input.body
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_rejectsAnotherActualProfileLockBeforeIntent() {
    const input = await plannedImport("native-lock");
    const before = await IOUtils.read(input.path);

    const service = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
      Ci.nsIToolkitProfileService
    );
    const otherProfile = service.createProfile(
      new FileUtils.File(PathUtils.join(work, "another-profile")),
      "another-migration-profile",
      "tests"
    );
    const otherLock = otherProfile.lock({});
    try {
      Assert.throws(
        () =>
          createPanoramaMigrationTarget(
            input.journal,
            database,
            () => input.folder,
            otherLock
          ),
        /lock selects another profile/
      );
      Assert.deepEqual(await IOUtils.read(input.path), before);
      Assert.equal(input.journal.state.sources[0].state, "pending");
      Assert.equal(Array.from(input.folder.messages).length, 0);
    } finally {
      otherLock.unlock();
      otherProfile.remove(false);
    }
  }
);

/** @param {string} target - Existing target. @param {string} path - Fresh Unix link. */
function makeCoordinatorPathLink(target, path) {
  const process = Cc["@mozilla.org/process/util;1"].createInstance(
    Ci.nsIProcess
  );
  process.init(new FileUtils.File("/bin/ln"));
  const args = ["-s", target, path];
  process.run(true, args, args.length);
  Assert.equal(process.exitValue, 0);
  Assert.ok(new FileUtils.File(path).isSymlink());
}

/**
 * Resolves the actual body's relative descriptor through a test alias.
 *
 * @param {object} input - Planned original native folder.
 * @param {nsIFile} aliasRoot - Alternate spelling of the admitted profile root.
 * @returns {nsIFile} Body path with the unchanged profile-relative descriptor.
 */
function aliasedBodyPath(input, aliasRoot) {
  const root = new FileUtils.File(input.journal.state.profilePath);
  const body = input.folder.filePath;
  body.normalize();
  Assert.ok(root.contains(body));
  const relative = body.getRelativeDescriptor(root);
  body.setRelativeDescriptor(aliasRoot, relative);
  return body;
}

/** @param {object} input - Planned folder. @param {RegExp} error - Expected refusal. */
async function assertNativeTargetRefuses(input, error) {
  const count = database.messageDB.totalCount;
  await Assert.rejects(
    resumeMorkImports(input.journal, targetFor(input)),
    error
  );
  Assert.equal(database.messageDB.totalCount, count);
  Assert.equal(Array.from(input.folder.messages).length, 0);
  Assert.equal(input.journal.state.sources[0].receipt, null);
}

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_nativeCanonicalAliasAboveAdmittedRoot() {
    const input = await plannedImport("native-alias");
    const original = input.folder.filePath;
    const logical = input.folder.path;
    const root = new FileUtils.File(input.journal.state.profilePath);
    const alias = PathUtils.join(work, "profile-parent-alias");
    makeCoordinatorPathLink(root.parent.path, alias);
    const aliasRoot = new FileUtils.File(alias);
    aliasRoot.append(root.leafName);
    input.folder.filePath = aliasedBodyPath(input, aliasRoot);
    try {
      Assert.notEqual(
        input.folder.summaryFile.path,
        input.journal.state.sources[0].path
      );
      await resumeMorkImports(input.journal, targetFor(input));
      Assert.equal(input.journal.state.stage, "validate");
      await assertCommitted(input);
      const count = database.messageDB.totalCount;
      const receipt = await importMorkFolderSnapshot(
        database,
        input.folder,
        input.journal.state.sources[0]
      );
      Assert.deepEqual(
        receipt.keys,
        input.journal.state.sources[0].receipt.keys
      );
      Assert.equal(database.messageDB.totalCount, count);
      Assert.equal(input.folder.path, logical);
    } finally {
      input.folder.filePath = original;
    }
    await assertCommitted(input);
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_nativeAliasBelowAdmittedRootRejectsBeforeImport() {
    const input = await plannedImport("native-below-root-link");
    const original = input.folder.filePath;
    const root = new FileUtils.File(input.journal.state.profilePath);
    const alias = PathUtils.join(root.path, "migration-below-root-link");
    makeCoordinatorPathLink(root.path, alias);
    input.folder.filePath = aliasedBodyPath(input, new FileUtils.File(alias));
    try {
      await assertNativeTargetRefuses(input, /contains a link below its root/);
    } finally {
      input.folder.filePath = original;
      Assert.ok(new FileUtils.File(alias).isSymlink());
      await IOUtils.remove(alias);
    }
    Assert.deepEqual(
      await IOUtils.read(input.folder.summaryFile.path),
      input.summary
    );
    Assert.deepEqual(await IOUtils.read(original.path), input.body);
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_nativeStoreLeafLinkRejectsBeforeImport() {
    const input = await plannedImport("native-store-link");
    const path = input.folder.filePath.path;
    const retained = path + ".migration-retained";
    await IOUtils.move(path, retained, { noOverwrite: true });
    try {
      makeCoordinatorPathLink(retained, path);
      await assertNativeTargetRefuses(input, /contains a link below its root/);
    } finally {
      if (await IOUtils.exists(path)) {
        Assert.ok(new FileUtils.File(path).isSymlink());
        await IOUtils.remove(path);
      }
      await IOUtils.move(retained, path, { noOverwrite: true });
    }
    Assert.deepEqual(await IOUtils.read(path), input.body);
    Assert.deepEqual(
      await IOUtils.read(input.folder.summaryFile.path),
      input.summary
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_nativeOutsideBackupRootsRejectsBeforeImport() {
    const input = await plannedImport("native-outside");
    const original = input.folder.filePath;
    const outside = PathUtils.join(work, "outside-mail");
    await IOUtils.makeDirectory(outside);
    await IOUtils.copy(original.path, PathUtils.join(outside, "Inbox"), {
      noOverwrite: true,
    });
    await IOUtils.copy(
      input.folder.summaryFile.path,
      PathUtils.join(outside, "Inbox.msf"),
      { noOverwrite: true }
    );
    input.folder.filePath = new FileUtils.File(
      PathUtils.join(outside, "Inbox")
    );
    try {
      await assertNativeTargetRefuses(input, /outside backed-up roots/);
    } finally {
      input.folder.filePath = original;
    }
    Assert.deepEqual(await IOUtils.read(original.path), input.body);
    Assert.deepEqual(
      await IOUtils.read(input.folder.summaryFile.path),
      input.summary
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function test_nativeAbsentBodyStoreRemainsAbsent() {
    const input = await plannedImport("native-no-store");
    const path = input.folder.filePath.path;
    const retained = path + ".migration-retained";
    await IOUtils.move(path, retained, { noOverwrite: true });
    try {
      await resumeMorkImports(input.journal, targetFor(input));
      Assert.equal(input.journal.state.stage, "validate");
      Assert.ok(
        !(await IOUtils.exists(path)),
        "Import does not reconstruct a body store"
      );
      Assert.deepEqual(await IOUtils.read(retained), input.body);
    } finally {
      await IOUtils.move(retained, path, { noOverwrite: true });
    }
    await assertCommitted(input);
  }
);

/**
 * Plans all six byte-identical retained IMAP sources under the existing backup.
 * The captured readback ledger supplies assertions only, never converter input.
 *
 * @returns {Promise<object>} Owned journal, path and sorted complete source IDs.
 */
async function plannedImapUnit() {
  const sources = [];
  for (const [name, { saved, inventory }] of imapSourceFiles) {
    const folder = imapFolders.get(name);
    const input = await readMorkFolderImport(
      folder,
      "imap-plan-" + name,
      inventory
    );
    Assert.equal(input.source.sha256, saved.sha256);
    sources.push({
      id: name,
      protocol: "imap",
      originalFolderURI: saved.uri,
      databaseSourceId: database.sourceId,
      destinationFolderId: folder.id,
      ...input.source,
      ...(inventory ? { inventory } : {}),
    });
  }
  sources.sort((left, right) => left.id.localeCompare(right.id));
  const path = PathUtils.join(work, "genuine-imap-unit.json");
  const journal = await MigrationJournal.create(path, {
    profilePath: profileLock.directory.path,
    mailPaths: [],
    backupPath: PathUtils.parent(backup.path),
    sources,
  });
  const input = { journal, path, ids: sources.map(source => source.id) };
  registerCleanupFunction(() => input.journal.close());
  await journal.recordBackup(backup);
  return input;
}

/**
 * Creates the ordinary platform-specific target for the complete physical unit.
 *
 * @param {object} input - Current open journal and source IDs.
 * @returns {object} Native checked receipt and import methods.
 */
function imapTarget(input) {
  return (
    AppConstants.platform == "win"
      ? createWindowsPanoramaMigrationTarget
      : createPanoramaMigrationTarget
  )(
    input.journal,
    database,
    id => {
      Assert.ok(imapFolders.has(id));
      return imapFolders.get(id);
    },
    profileLock
  );
}

/**
 * Reconstructs a request solely from current retained source bytes and the plan.
 *
 * @param {object} input - Current complete journal unit.
 * @returns {Promise<object>} Version3 request with the original durable token.
 */
async function imapRequest(input) {
  const unit = input.journal.state.protocolUnits[0];
  const entries = [];
  for (const id of input.ids) {
    const source = input.journal.state.sources.find(value => value.id == id);
    const folder = imapFolders.get(id);
    const snapshot = await readMorkFolderImport(
      folder,
      source.token,
      source.inventory
    );
    entries.push({
      input: snapshot,
      source,
      folderFlags: folderDB.getFolderFlags(folder.id),
    });
  }
  return convertMorkProtocolUnit(entries, unit.token, database.sourceId);
}

/**
 * Checks actual committed headers, body streams, epoch and complete queue data.
 *
 * @param {object} input - Current complete journal unit.
 * @param {object} receipt - Exact committed native unit receipt.
 * @returns {Promise<void>} All physical/source and independent ledger checks pass.
 */
async function assertImapUnit(input, receipt) {
  Assert.equal(receipt.version, 3);
  Assert.equal(receipt.databaseSourceId, database.sourceId);
  Assert.equal(receipt.folders.length, imapLedger.members.length);
  const keysBySource = new Map(
    receipt.folders.map(member => [
      member.sourceId,
      new Map([...member.keys, ...member.imap.operationKeys]),
    ])
  );
  const allKeys = receipt.folders.flatMap(member =>
    [...member.keys, ...member.imap.operationKeys].map(([, key]) => key)
  );
  Assert.equal(
    new Set(allKeys).size,
    allKeys.length,
    "All physical keys are globally distinct"
  );
  const profileFile = do_get_profile().clone();
  profileFile.append("panorama.sqlite");
  const reopened = Services.storage.openUnsharedDatabase(profileFile);
  try {
    for (const member of receipt.folders) {
      const folder = imapFolders.get(member.sourceId);
      const saved = imapLedger.members.find(
        value => value.name == member.sourceId
      );
      Assert.equal(member.folderId, folder.id);
      Assert.equal(
        folder.msgDatabase.dBFolderInfo.imapUidValidity,
        saved.epoch
      );
      Assert.equal([...folder.messages].length, saved.headers.length);
      Assert.deepEqual(
        member.keys.map(([old]) => old).sort((a, b) => a - b),
        saved.headers.map(header => header.key).sort((a, b) => a - b)
      );
      for (const original of saved.headers) {
        const key = keysBySource.get(member.sourceId).get(original.key);
        const header = folder.msgDatabase.getMsgHdrForKey(key);
        Assert.equal(header.folder, folder);
        Assert.equal(header.messageKey, key);
        Assert.equal(header.messageId, original.messageId);
        Assert.equal(header.storeToken, original.storeToken);
        Assert.equal(header.messageSize, original.size);
        const nativeKey = saved.keyMap.find(
          ([, old]) => old == original.key
        )[0];
        const captured = saved.captured.find(
          value => value.nativeKey == nativeKey
        );
        Assert.equal(
          header.properties.includes("uidOnServer"),
          captured.uid !== null
        );
        if (captured.uid !== null) {
          Assert.equal(header.getUint32Property("uidOnServer"), captured.uid);
        }
        const stream = Cc[
          "@mozilla.org/scriptableinputstream;1"
        ].createInstance(Ci.nsIScriptableInputStream);
        stream.init(folder.getMsgInputStream(header));
        let body = "";
        try {
          while (stream.available()) {
            body += stream.read(stream.available());
          }
        } finally {
          stream.close();
        }
        Assert.equal(
          body,
          captured.body,
          "The original finished body is retained"
        );
        const statement = reopened.createStatement(
          "SELECT folderId FROM messages WHERE id = :key"
        );
        try {
          statement.params.key = key;
          Assert.ok(
            statement.executeStep(),
            "A fresh connection sees the committed physical row"
          );
          Assert.equal(statement.row.folderId, folder.id);
          Assert.ok(!statement.executeStep());
        } finally {
          statement.finalize();
        }
      }
      const operations = folder.msgDatabase.QueryInterface(
        Ci.nsIMsgOfflineOpsDatabase
      );
      Assert.equal(
        operations.listAllOfflineOpIds().length,
        saved.operations.length
      );
      for (const original of saved.operations) {
        const mapped = member.imap.operations.find(
          value => value.sourceKey == original.messageKey
        );
        Assert.ok(mapped);
        Assert.greater(mapped.id, 0);
        Assert.greater(mapped.revision, 0);
        const operation = operations.getOfflineOpForKey(mapped.key, false);
        for (const property of [
          "operation",
          "flagOperation",
          "newFlags",
          "srcUid",
          "sourceFolderURI",
          "destinationFolderURI",
          "keywordsToAdd",
          "keywordsToRemove",
          "msgSize",
          "playingBack",
        ]) {
          Assert.equal(operation[property], original[property], property);
        }
        const source = imapLedger.members.find(
          value => value.uri == original.sourceFolderURI
        );
        const expectedSourceKey = source
          ? keysBySource.get(source.name).get(original.srcMessageKey)
          : original.srcMessageKey;
        Assert.equal(operation.srcMessageKey, expectedSourceKey);
        for (let ordinal = 0; ordinal < original.copies.length; ordinal++) {
          Assert.equal(
            operation.getCopyDestination(ordinal),
            original.copies[ordinal]
          );
        }
        Assert.throws(
          () => operation.getCopyDestination(original.copies.length),
          error =>
            [Cr.NS_ERROR_ILLEGAL_VALUE, Cr.NS_ERROR_INVALID_ARG].includes(
              error.result
            )
        );
      }
      Assert.equal(
        await IOUtils.computeHexDigest(folder.summaryFile.path, "sha256"),
        saved.sha256
      );
      Assert.equal(
        await IOUtils.computeHexDigest(folder.filePath.path, "sha256"),
        saved.bodies[0].sha256
      );
    }
  } finally {
    reopened.close();
  }
  Assert.ok(!database.connectionForTests.transactionInProgress);
}

let imapInterrupted, imapCommittedReceipt;
add_task(
  async function test_protocolUnitProjectionReadbackFailureKeepsActualCommitForRetry() {
    const input = await plannedImapUnit();
    imapInterrupted = input;
    const token = await input.journal.beginImportUnit(input.ids);
    const target = imapTarget(input);
    Assert.equal(await target.findProtocolUnitReceipt(token, input.ids), null);
    const receipt = await target.importProtocolUnit(token, input.ids);
    imapCommittedReceipt = receipt;
    const request = await imapRequest(input);
    const member = receipt.folders[0];
    const [sourceKey, key] = member.keys[0];
    const expected = request.folders[0].messages.find(
      message => message.sourceKey == sourceKey
    ).header.subject;
    const header = database.messageDB.getMessage(key);
    const count = database.messageDB.totalCount;
    header.subject = "Changed before protocol-unit checkpoint";
    const changes = database.connectionForTests.createStatement(
      "SELECT total_changes() AS value"
    );
    try {
      Assert.ok(changes.executeStep());
      const beforeChanges = changes.row.value;
      changes.reset();
      for (let attempt = 0; attempt < 2; attempt++) {
        // Reopen the durable uncheckpointed journal just as after process loss.
        input.journal.close();
        input.journal = await MigrationJournal.open(
          input.path,
          profileLock.directory.path
        );
        const before = input.journal.state;
        Assert.equal(before.stage, "import");
        Assert.equal(before.protocolUnits[0].state, "importing");
        Assert.equal(before.protocolUnits[0].receipt, null);
        await Assert.rejects(
          resumeMorkImports(input.journal, {
            ...imapTarget(input),
            async importProtocolUnit() {
              Assert.ok(
                false,
                "Retry must never import a committed unit again"
              );
            },
          }),
          error =>
            error.name === "Error" &&
            error.message ===
              "Native migration message projection differs: subject"
        );
        const recorded = {
          ...before,
          revision: before.revision + 1,
          lastError: {
            name: "Error",
            message: "Native migration message projection differs: subject",
          },
        };
        Assert.deepEqual(
          input.journal.state,
          recorded,
          "Only the actual error is recorded; all members stay uncheckpointed"
        );
        Assert.deepEqual(await IOUtils.readJSON(input.path), recorded);
        Assert.equal(database.messageDB.totalCount, count);
        Assert.deepEqual(
          database.getFolderImportReceipt(
            imapFolders.get(member.sourceId),
            request
          ),
          receipt,
          "The real native commit and exact operation identities remain intact"
        );
        Assert.ok(changes.executeStep());
        Assert.equal(
          changes.row.value,
          beforeChanges,
          "Retry performs no native write"
        );
        changes.reset();
      }
    } finally {
      changes.finalize();
      header.subject = expected;
    }
    await assertImapUnit(input, receipt);
    Assert.deepEqual(
      await imapTarget(input).findProtocolUnitReceipt(token, input.ids),
      receipt,
      "Restoring the exact projection permits the existing receipt"
    );
  }
);

add_task(async function test_protocolUnitCheckpointsCommitBeforeCancellation() {
  const input = imapInterrupted;
  const receipt = imapCommittedReceipt;
  Assert.ok(
    input.journal.state.sources.every(
      source => source.state == "importing" && source.receipt === null
    )
  );
  Assert.equal(input.journal.state.protocolUnits[0].receipt, null);
  await assertImapUnit(input, receipt);
  // Simulate process loss AFTER actual native commit and BEFORE checkpoint.
  input.journal.close();
  input.journal = await MigrationJournal.open(
    input.path,
    profileLock.directory.path
  );
  Assert.equal(input.journal.state.protocolUnits[0].receipt, null);
  const reopened = imapTarget(input);
  const controller = new AbortController();
  await Assert.rejects(
    resumeMorkImports(
      input.journal,
      {
        ...reopened,
        async findProtocolUnitReceipt(unitToken, ids) {
          const actual = await reopened.findProtocolUnitReceipt(unitToken, ids);
          Assert.deepEqual(actual, receipt);
          controller.abort();
          return actual;
        },
        async importProtocolUnit() {
          Assert.ok(
            false,
            "Actual committed receipt must reconcile without a second import"
          );
        },
      },
      controller.signal
    ),
    error => error.name == "AbortError"
  );
  Assert.ok(input.journal.state.cancelled);
  Assert.deepEqual(input.journal.state.protocolUnits[0].receipt, receipt);
  Assert.ok(
    input.journal.state.sources.every(source => source.state == "imported")
  );
  await assertImapUnit(input, receipt);
});

add_task(async function test_protocolUnitReconcilesAfterJournalReopen() {
  const input = imapInterrupted;
  const receipt = structuredClone(input.journal.state.protocolUnits[0].receipt);
  input.journal.close();
  input.journal = await MigrationJournal.open(
    input.path,
    profileLock.directory.path
  );
  Assert.ok(input.journal.state.cancelled);
  Assert.deepEqual(input.journal.state.protocolUnits[0].receipt, receipt);
  await input.journal.setCancelled(false);
  const native = imapTarget(input);
  const header = database.messageDB.getMessage(receipt.folders[0].keys[0][1]);
  const subject = header.subject;
  header.subject = "Legitimate edit after protocol-unit checkpoint";
  try {
    await resumeMorkImports(input.journal, {
      ...native,
      async importProtocolUnit() {
        Assert.ok(
          false,
          "Read-only reconciliation must preserve the existing queue identities"
        );
      },
    });
    Assert.equal(
      header.subject,
      "Legitimate edit after protocol-unit checkpoint",
      "Checkpointed receipt lookup permits current header edits"
    );
  } finally {
    header.subject = subject;
  }
  Assert.equal(input.journal.state.stage, "validate");
  Assert.deepEqual(input.journal.state.protocolUnits[0].receipt, receipt);
  await assertImapUnit(input, receipt);
});
