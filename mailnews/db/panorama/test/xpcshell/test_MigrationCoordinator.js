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
const { importMorkFolderSnapshot } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MorkSnapshotAdapter.sys.mjs"
);
const { resumeMorkImports, createPanoramaMigrationTarget } =
  ChromeUtils.importESModule(
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
];

add_setup(async function setupClosedLegacyProfileThenNativeTarget() {
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
  // Initialize NSS before quiescing the profile for the backup.
  Assert.equal(
    await IOUtils.computeHexDigest(summary.path, "sha256"),
    "7a262023b98fe964d105de06bf1ddca60f90ee19073e38afda8c885be5a47703",
    "The copied legacy summary retains its genuine fixture bytes"
  );
  const creator = new ProfileCreator(profile);
  const local = creator.addLocalServer();
  for (const name of names.filter(name => name != "native-nonlocal")) {
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
  backup = await createMigrationBackup(
    profileLock.directory.path,
    [],
    PathUtils.join(backupRoot, "backup")
  );
  loadExistingDB();
  MailServices.accounts.accounts;
  const localRoot = MailServices.accounts.localFoldersServer.rootFolder;
  for (const name of names.filter(name => name != "native-nonlocal")) {
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
    Assert.ok(header.threadId > 0);
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
    const { FileUtils } = ChromeUtils.importESModule(
      "resource://gre/modules/FileUtils.sys.mjs"
    );
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
