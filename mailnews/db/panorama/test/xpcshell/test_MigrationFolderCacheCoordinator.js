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
const { MailStringUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailStringUtils.sys.mjs"
);
const { ProfileCreator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ProfileCreator.sys.mjs"
);
const { MigrationJournal } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationJournal.sys.mjs"
);
const { createMigrationBackup, verifyMigrationBackup } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MigrationBackup.sys.mjs"
  );
const { readMorkMigrationSource } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationSource.sys.mjs"
);
const { prepareMorkFolderCacheImport, resumeMorkCacheImports } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MigrationCoordinator.sys.mjs"
  );

const {
  parseJSONFolderCache,
  parseMorkFolderCache,
  createMorkFolderCacheRequest,
  validateMorkFolderCacheReceipt,
} = ChromeUtils.importESModule(
  "resource:///modules/panorama/MorkFolderCache.sys.mjs"
);

const CACHE_FILE = "panacea.dat";
const OLD_ROOT = "/foo/bar/profile-default/";
const LOCAL_NAMES = ["Trash", "Unsent Messages"];
const IMAP_NAMES = [
  "Archives",
  "Drafts",
  "INBOX",
  "Junk",
  "Sent",
  "Templates",
  "Trash",
  "blah",
  "foo",
];
const skipOnWindows = () => AppConstants.platform == "win";
let lock;
let work;
let source;
let reconciledSource;
let backup;
let control;
let controlInventory;
let serial = 0;
const bindings = new Map();
const reconciledBindings = new Map();
let reconciledInput;

add_setup(async function setupBackedUpProfileAndActualNativeFolders() {
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
    "migration-cache-native",
    "tests"
  );
  lock = nativeProfile.lock({});
  registerCleanupFunction(() => {
    lock.unlock();
    nativeProfile.remove(false);
  });
  work = await IOUtils.createUniqueDirectory(
    PathUtils.parent(profile.path),
    "migration-cache-native-"
  );
  registerCleanupFunction(() => IOUtils.remove(work, { recursive: true }));
  const summary = new FileUtils.File(PathUtils.join(work, "source.msf"));
  const body = new FileUtils.File(PathUtils.join(work, "source"));
  for (const [file, fixture] of [
    [summary, "data/migration.msf"],
    [body, "data/migration"],
  ]) {
    await IOUtils.write(
      file.path,
      await IOUtils.read(do_get_file(fixture).path),
      {
        mode: "create",
      }
    );
  }
  // Initialize NSS in no-DB mode before inventorying the quiesced profile.
  Assert.equal(
    await IOUtils.computeHexDigest(summary.path, "sha256"),
    "7a262023b98fe964d105de06bf1ddca60f90ee19073e38afda8c885be5a47703"
  );
  const creator = new ProfileCreator(profile);
  const local = creator.addLocalServer();
  for (const name of LOCAL_NAMES) {
    await local.rootFolder.addMailFolder(name);
  }
  const originalControl = await local.rootFolder.addMailFolder(
    "cache-control",
    {
      summary,
      mbox: body,
    }
  );
  // A separate native family keeps permanent version1 bindings unchanged.
  // Both families consume the same saved cache bytes, never a generated cache.
  Services.prefs.setStringPref(
    "mail.accountmanager.localfoldersserver",
    local.prefBranch.root.split(".")[2]
  );
  const reconciledLocal = creator.addServer(
    "cache-v2",
    "cache-v2-local.invalid",
    "none"
  );
  reconciledLocal.isMaildirStore = true;
  for (const name of LOCAL_NAMES) {
    await reconciledLocal.rootFolder.addMailFolder(name);
  }
  const reconciledImap = creator.addServer(
    "cache-v2",
    "cache-v2.invalid",
    "imap"
  );
  reconciledImap.isMaildirStore = true;
  await IOUtils.makeDirectory(reconciledImap.rootFolder.path);
  const serverKey = "migrationCacheImap";
  const prefix = "mail.server." + serverKey + ".";
  const directory = profile.clone();
  directory.append("cache-\u90ae\u4ef6-e\u0301");
  await IOUtils.makeDirectory(directory.path);
  for (const [name, value] of Object.entries({
    type: "imap",
    userName: "migration",
    hostname: "migration.invalid",
    storeContractID: "@mozilla.org/msgstore/berkeleystore;1",
  })) {
    Services.prefs.setStringPref(prefix + name, value);
  }
  Services.prefs.setComplexValue(prefix + "directory", Ci.nsIFile, directory);
  Services.prefs.savePrefFile(
    new FileUtils.File(PathUtils.join(profile.path, "prefs.js"))
  );
  source = PathUtils.join(profile.path, "panacea.dat");
  await IOUtils.write(
    source,
    await IOUtils.read(do_get_file(CACHE_FILE).path),
    {
      mode: "create",
    }
  );
  // Version1 permanently binds its original cache source and path. Give the
  // independent version2 destination family its own real backed-up input.
  reconciledSource = PathUtils.join(
    profile.path,
    "cache-v2-input",
    "panacea.dat"
  );
  await IOUtils.makeDirectory(PathUtils.parent(reconciledSource));
  await IOUtils.write(
    reconciledSource,
    await IOUtils.read(do_get_file(CACHE_FILE).path),
    { mode: "create" }
  );
  Assert.notEqual(reconciledSource, source);
  Assert.deepEqual(
    await IOUtils.read(reconciledSource),
    await IOUtils.read(source),
    "Both independent inputs retain the exact saved cache bytes"
  );
  Assert.ok(
    !(await IOUtils.exists(PathUtils.join(profile.path, "panorama.sqlite")))
  );
  if (AppConstants.platform == "win") {
    const { captureMorkFolderWindowsInventory } = ChromeUtils.importESModule(
      "resource:///modules/panorama/MorkFolderImport.sys.mjs"
    );
    controlInventory = captureMorkFolderWindowsInventory(
      new FileUtils.File(originalControl.summaryFilePath),
      profile,
      new FileUtils.File(originalControl.mailFilePath),
      profile
    );
  }
  const backupRoot = await IOUtils.createUniqueDirectory(
    PathUtils.parent(profile.path),
    "migration-cache-backup-"
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
    profile.path,
    [],
    PathUtils.join(backupRoot, "backup")
  );
  loadExistingDB();
  Assert.equal(
    MailServices.accounts.accounts.length,
    3,
    "The three configured fixture accounts are loaded before local-root lookup"
  );
  const localRoot = MailServices.accounts.localFoldersServer.rootFolder;
  Assert.ok(localRoot, "The local root exists");
  control = localRoot.getChildNamed("cache-control");
  Assert.ok(control, "The genuine summary control folder exists");
  const rootId = folderDB.insertRoot(serverKey);
  for (const name of IMAP_NAMES) {
    folderDB.updateFlags(
      folderDB.insertFolder(rootId, name),
      Ci.nsMsgFolderFlags.Mail
    );
  }
  const server = MailServices.accounts.getIncomingServer(serverKey);
  const account = MailServices.accounts.createAccount();
  account.incomingServer = server;
  registerCleanupFunction(() => {
    server.closeCachedConnections();
    MailServices.accounts.removeAccount(account, false);
    Services.prefs.deleteBranch(prefix);
  });
  const imapRoot = server.rootFolder;
  Assert.ok(imapRoot, "The native IMAP root exists");
  const actual = new Map([
    [OLD_ROOT + "Mail/Local Folders", localRoot],
    [OLD_ROOT + "ImapMail/imap.localhost", imapRoot],
  ]);
  for (const [names, parent, oldPath] of [
    [LOCAL_NAMES, localRoot, "Mail/Local Folders/"],
    [IMAP_NAMES, imapRoot, "ImapMail/imap.localhost/"],
  ]) {
    for (const name of names) {
      const folder = parent.getChildNamed(name);
      Assert.ok(folder, "Native cache fixture folder exists: " + name);
      actual.set(OLD_ROOT + oldPath + name + ".msf", folder);
    }
  }
  for (const [key, folder] of actual) {
    Assert.ok(folder, "Native cache fixture folder exists: " + key);
    Assert.ok(
      folder instanceof Ci.nsIMsgFolder,
      "Actual native folder: " + key
    );
    const file = (
      folder.isServer ? folder.filePath : folder.summaryFile
    ).clone();
    // Unix persistentDescriptor is the absolute path, including absent summaries.
    const parent = file.parent;
    parent.normalize();
    parent.append(file.leafName);
    bindings.set(key, { folder, descriptor: cacheKey(parent) });
  }
  Assert.equal(imapRoot.id, rootId);
  Assert.equal(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    ),
    database
  );
  Assert.equal(bindings.size, 13);
  const inbox = imapRoot.getChildNamed("INBOX");
  Assert.ok(inbox, "The native catalog INBOX exists");
  const descriptor = bindings.get(
    OLD_ROOT + "ImapMail/imap.localhost/INBOX.msf"
  ).descriptor;
  Assert.ok(
    descriptor.includes("cache-\u90ae\u4ef6-e\u0301"),
    "Unicode spelling is exact"
  );
  Assert.notEqual(descriptor, inbox.summaryFile.persistentDescriptor);
  const nativeLocal = MailServices.accounts.getIncomingServer(
    reconciledLocal.prefBranch.root.split(".")[2]
  ).rootFolder;
  const nativeImap = MailServices.accounts.getIncomingServer(
    reconciledImap.prefBranch.root.split(".")[2]
  ).rootFolder;
  const nativeDiscovery = nativeImap.QueryInterface(Ci.nsIMsgImapMailFolder);
  for (const name of IMAP_NAMES) {
    nativeDiscovery.createClientSubfolderInfo(name, "/", 0, true);
  }
  for (const [key, folder] of [
    [OLD_ROOT + "Mail/Local Folders", nativeLocal],
    [OLD_ROOT + "ImapMail/imap.localhost", nativeImap],
    ...LOCAL_NAMES.map(name => [
      OLD_ROOT + "Mail/Local Folders/" + name + ".msf",
      nativeLocal.getChildNamed(name),
    ]),
    ...IMAP_NAMES.map(name => [
      OLD_ROOT + "ImapMail/imap.localhost/" + name + ".msf",
      nativeImap.getChildNamed(name),
    ]),
  ]) {
    Assert.ok(
      folder,
      "Actual discovery-created native cache destination: " + key
    );
    const file = (
      folder.isServer ? folder.filePath : folder.summaryFile
    ).clone();
    const parent = file.parent;
    parent.normalize();
    parent.append(file.leafName);
    reconciledBindings.set(key, { folder, descriptor: cacheKey(parent) });
    Assert.equal(folder.msgStore.storeType, "maildir");
  }
  Assert.equal(reconciledBindings.size, 13);
});

/** @param {nsIFile} file - Actual native cache file. @returns {string} Exact UTF-8 JSON key. */
function cacheKey(file) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    MailStringUtils.byteStringToUint8Array(file.persistentDescriptor)
  );
}

/** @param {string} [incarnation=database.sourceId] - Retained plan pin. @returns {Promise<object>} Open backed-up journal. */
async function cacheInput(incarnation = database.sourceId) {
  const { identity } = await readMorkMigrationSource(control.summaryFile.path);
  const path = PathUtils.join(work, "cache-" + ++serial + ".json");
  const journal = await MigrationJournal.create(path, {
    profilePath: lock.directory.path,
    mailPaths: [],
    backupPath: PathUtils.parent(backup.path),
    sources: [
      {
        id: "cache-control",
        databaseSourceId: incarnation,
        ...identity,
        ...(controlInventory ? { inventory: controlInventory } : {}),
        destinationFolderId: control.id,
      },
    ],
  });
  registerCleanupFunction(() => journal.close());
  await journal.recordBackup(backup);
  return { journal, path };
}

/** @returns {number} SQLite changes made by this actual connection. */
function changes() {
  const statement = database.connectionForTests.createStatement(
    "SELECT total_changes()"
  );
  try {
    Assert.ok(statement.executeStep());
    return statement.getInt64(0);
  } finally {
    statement.finalize();
  }
}

add_task(
  { skip_if: skipOnWindows },
  async function test_nativeDescriptorsAndExactTextWithoutApplication() {
    const input = await cacheInput();
    const original = await IOUtils.read(source);
    const before = await IOUtils.read(input.path);
    const count = changes();
    const flags = [...bindings.values()].map(({ folder }) => [
      folder.id,
      folderDB.getFolderFlags(folder.id),
    ]);
    const snapshot = await prepareMorkFolderCacheImport(
      input.journal,
      database,
      lock,
      source,
      bindings
    );
    Assert.equal(snapshot.databaseSourceId, database.sourceId);
    const expected = new FileUtils.File(source);
    expected.normalize();
    Assert.equal(snapshot.source.path, expected.path);
    Assert.equal(snapshot.source.size, original.length);
    Assert.equal(
      snapshot.source.sha256,
      await IOUtils.computeHexDigest(source, "sha256")
    );
    Assert.deepEqual(snapshot.bytes, original);
    Assert.equal(snapshot.records.rows.size, 13);
    Assert.equal(snapshot.records.tables.size, 1);
    Assert.equal(snapshot.folders.length, 13);
    for (const row of snapshot.folders) {
      const actual = bindings.get(row.originalKey);
      Assert.equal(row.id, actual.folder.id);
      Assert.equal(row.descriptor, actual.descriptor);
      Assert.equal(row.isServer, actual.folder.isServer);
      Assert.equal(
        row.properties.find(property => property.name == "key").text,
        row.originalKey
      );
    }
    const inbox = snapshot.folders.find(
      folder =>
        folder.originalKey == OLD_ROOT + "ImapMail/imap.localhost/INBOX.msf"
    );
    Assert.deepEqual(
      inbox.properties.find(property => property.name == "flags"),
      { name: "flags", text: "88083014", integer: 2282237972 }
    );
    Assert.deepEqual(
      inbox.properties.find(property => property.name == "MRUTime"),
      { name: "MRUTime", text: "1628202593" }
    );
    const root = snapshot.folders.find(
      folder => folder.originalKey == OLD_ROOT + "ImapMail/imap.localhost"
    );
    Assert.deepEqual(
      root.properties.find(property => property.name == "onlineName"),
      { name: "onlineName", text: "" }
    );
    Assert.ok(!root.properties.some(property => property.name == "absent"));
    Assert.deepEqual(
      root.properties.find(property => property.name == "folderSize"),
      { name: "folderSize", text: "ffffffffffffffff", integer: -1 }
    );
    Assert.deepEqual(
      [...bindings.values()].map(({ folder }) => [
        folder.id,
        folderDB.getFolderFlags(folder.id),
      ]),
      flags
    );
    Assert.equal(
      changes(),
      count,
      "Preparation does not apply cache flags/properties or receipts"
    );
    Assert.equal(messageDB.totalCount, 0);
    Assert.deepEqual(await IOUtils.read(input.path), before);
    Assert.deepEqual(await IOUtils.read(source), original);
    Assert.deepEqual(
      await IOUtils.read(do_get_file(CACHE_FILE).path),
      original
    );
    Assert.deepEqual(
      await verifyMigrationBackup(PathUtils.parent(backup.path)),
      backup
    );
  }
);

add_task(
  { skip_if: skipOnWindows },
  async function test_descriptorMismatchRefusesWithoutWrites() {
    const input = await cacheInput();
    const wrong = new Map(bindings);
    const key = OLD_ROOT + "ImapMail/imap.localhost/INBOX.msf";
    wrong.set(key, {
      ...wrong.get(key),
      descriptor: cacheKey(control.summaryFile),
    });
    const count = changes();
    await Assert.rejects(
      prepareMorkFolderCacheImport(
        input.journal,
        database,
        lock,
        source,
        wrong
      ),
      /canonical descriptor changed/
    );
    Assert.equal(changes(), count);
    Assert.equal(input.journal.state.sources[0].state, "pending");
  }
);

add_task(
  { skip_if: skipOnWindows },
  async function test_missingBindingRefusesWholeCache() {
    const input = await cacheInput();
    const partial = new Map(bindings);
    partial.delete(OLD_ROOT + "ImapMail/imap.localhost/INBOX.msf");
    const count = changes();
    await Assert.rejects(
      prepareMorkFolderCacheImport(
        input.journal,
        database,
        lock,
        source,
        partial
      ),
      /Incomplete native folder-cache mapping/
    );
    Assert.equal(changes(), count);
  }
);

add_task(
  { skip_if: skipOnWindows },
  async function test_duplicatePhysicalFolderRefuses() {
    const input = await cacheInput();
    const wrong = new Map(bindings);
    wrong.set(
      OLD_ROOT + "ImapMail/imap.localhost/INBOX.msf",
      bindings.get(OLD_ROOT + "ImapMail/imap.localhost/Archives.msf")
    );
    const count = changes();
    await Assert.rejects(
      prepareMorkFolderCacheImport(
        input.journal,
        database,
        lock,
        source,
        wrong
      ),
      /unique current native identity/
    );
    Assert.equal(changes(), count);
  }
);

add_task(
  { skip_if: skipOnWindows },
  async function test_wrongRetainedIncarnationRefuses() {
    const input = await cacheInput("another-native-database");
    const before = await IOUtils.read(input.path);
    await Assert.rejects(
      prepareMorkFolderCacheImport(
        input.journal,
        database,
        lock,
        source,
        bindings
      ),
      /retained migration plan/
    );
    Assert.deepEqual(await IOUtils.read(input.path), before);
  }
);

add_task(
  { skip_if: skipOnWindows },
  async function test_identicalUnbackedPathIsNotOriginalSource() {
    const input = await cacheInput();
    const elsewhere = PathUtils.join(lock.directory.path, "unbacked-cache.dat");
    await IOUtils.copy(source, elsewhere);
    await Assert.rejects(
      prepareMorkFolderCacheImport(
        input.journal,
        database,
        lock,
        elsewhere,
        bindings
      ),
      /not covered by the verified backup/
    );
    Assert.equal(messageDB.totalCount, 0);
  }
);

add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function test_windowsCacheAdmissionRemainsHeld() {
    const input = await cacheInput();
    const count = changes();
    await Assert.rejects(
      prepareMorkFolderCacheImport(
        input.journal,
        database,
        lock,
        source,
        bindings
      ),
      /requires native reparse admission/
    );
    Assert.equal(changes(), count);
  }
);

add_task(
  { skip_if: skipOnWindows },
  async function test_otherHeldProfileDoesNotAdmitSelectedTarget() {
    const input = await cacheInput();
    const service = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
      Ci.nsIToolkitProfileService
    );
    const other = service.createProfile(
      new FileUtils.File(PathUtils.join(work, "other-profile")),
      "migration-cache-other",
      "tests"
    );
    const otherLock = other.lock({});
    try {
      const count = changes();
      await Assert.rejects(
        prepareMorkFolderCacheImport(
          input.journal,
          database,
          otherLock,
          source,
          bindings
        ),
        /not the held selected profile/
      );
      Assert.equal(changes(), count);
    } finally {
      otherLock.unlock();
      other.remove(false);
    }
  }
);

add_task(
  { skip_if: skipOnWindows },
  async function test_linkedCacheLeafIsNotNormalizedIntoOriginal() {
    const input = await cacheInput();
    const alias = PathUtils.join(lock.directory.path, "cache-alias.dat");
    const process = Cc["@mozilla.org/process/util;1"].createInstance(
      Ci.nsIProcess
    );
    process.init(new FileUtils.File("/bin/ln"));
    const args = ["-s", source, alias];
    process.run(true, args, args.length);
    Assert.equal(process.exitValue, 0);
    Assert.ok(new FileUtils.File(alias).isSymlink());
    const count = changes();
    try {
      await Assert.rejects(
        prepareMorkFolderCacheImport(
          input.journal,
          database,
          lock,
          alias,
          bindings
        ),
        /contains a link below its root/
      );
      Assert.equal(changes(), count);
    } finally {
      await IOUtils.remove(alias);
    }
  }
);

add_task(
  { skip_if: skipOnWindows },
  async function test_summaryDescriptorCannotNameADirectory() {
    const input = await cacheInput();
    const summary = bindings.get(OLD_ROOT + "ImapMail/imap.localhost/INBOX.msf")
      .folder.summaryFile.path;
    Assert.ok(!(await IOUtils.exists(summary)));
    await IOUtils.makeDirectory(summary);
    const count = changes();
    try {
      await Assert.rejects(
        prepareMorkFolderCacheImport(
          input.journal,
          database,
          lock,
          source,
          bindings
        ),
        /Unsupported native folder-cache path type/
      );
      Assert.equal(changes(), count);
    } finally {
      await IOUtils.remove(summary);
    }
  }
);

/**
 * Plans one independent backed-up cache input without importing metadata.
 *
 * @param {number} [version=1] - Original provenance or reconciled request version.
 * @param {Map<string, object>} [mapping=bindings] - Complete actual native family.
 * @returns {Promise<object>} Open backed-up journal and its private path.
 */
async function plannedCache(version = 1, mapping = bindings) {
  const input = await cacheInput();
  const inputPath = version == 2 ? reconciledSource : source;
  const cacheId = version == 2 ? "panacea-v2" : "panacea";
  const snapshot = await prepareMorkFolderCacheImport(
    input.journal,
    database,
    lock,
    inputPath,
    mapping,
    version
  );
  const token = await input.journal.planCacheImport(cacheId, snapshot);
  Assert.equal(input.journal.state.version, 5);
  Assert.equal(input.journal.state.caches[0].token, token);
  const revision = input.journal.state.revision;
  snapshot.folders.reverse();
  Assert.equal(await input.journal.planCacheImport(cacheId, snapshot), token);
  Assert.equal(
    input.journal.state.revision,
    revision,
    "Matching reordered plan is read-only"
  );
  return input;
}

/** @returns {object} Independently read committed native rows and provenance. */
function committedCacheState() {
  const connection = Services.storage.openUnsharedDatabase(
    new FileUtils.File(PathUtils.join(PathUtils.profileDir, "panorama.sqlite"))
  );
  const query = (sql, columns) => {
    const statement = connection.createStatement(sql);
    try {
      const rows = [];
      while (statement.executeStep()) {
        rows.push(columns.map(column => statement.row[column]));
      }
      return rows;
    } finally {
      statement.finalize();
    }
  };
  try {
    return {
      folders: query("SELECT id,name,flags FROM folders ORDER BY id", [
        "id",
        "name",
        "flags",
      ]),
      properties: query(
        "SELECT id,name,typeof(value) AS type,value FROM folder_properties ORDER BY id,name",
        ["id", "name", "type", "value"]
      ),
      receipts: query(
        "SELECT token,identity,receipt FROM folder_cache_imports ORDER BY token",
        ["token", "identity", "receipt"]
      ),
      bindings: query("SELECT COUNT(*) AS count FROM folder_cache_bindings", [
        "count",
      ]),
      messages: query("SELECT id,messageId FROM messages ORDER BY id", [
        "id",
        "messageId",
      ]),
    };
  } finally {
    connection.close();
  }
}

add_task(
  { skip_if: skipOnWindows },
  async function test_cachePlanRejectsChangedSourceAndMapping() {
    const input = await plannedCache();
    const before = committedCacheState();
    const bytes = await IOUtils.read(source);
    const wrong = new Map(bindings);
    const key = OLD_ROOT + "ImapMail/imap.localhost/INBOX.msf";
    wrong.set(key, {
      ...wrong.get(key),
      descriptor: cacheKey(control.summaryFile),
    });
    await Assert.rejects(
      resumeMorkCacheImports(input.journal, database, lock, () => wrong),
      /canonical descriptor changed/
    );
    await IOUtils.write(source, new Uint8Array([...bytes, 10]));
    try {
      await Assert.rejects(
        resumeMorkCacheImports(input.journal, database, lock, () => bindings),
        /not covered by the verified backup|snapshot differs/
      );
    } finally {
      await IOUtils.write(source, bytes);
    }
    Assert.equal(input.journal.state.caches[0].state, "pending");
    Assert.strictEqual(input.journal.state.caches[0].receipt, null);
    Assert.deepEqual(committedCacheState(), before);
    Assert.deepEqual(await IOUtils.read(do_get_file(CACHE_FILE).path), bytes);
    const invalid = structuredClone(input.journal.state);
    invalid.version = 1;
    input.journal.close();
    await IOUtils.writeJSON(input.path, invalid);
    await Assert.rejects(
      MigrationJournal.open(input.path, lock.directory.path),
      /unsupported migration journal/
    );
  }
);

add_task(
  { skip_if: skipOnWindows },
  async function test_cacheNativeRollbackThenCheckpointRecovery() {
    const input = await plannedCache();
    const protectedKey = messageDB.addMessage(
      control.id,
      "cache-protected@invalid",
      [],
      0,
      "",
      "",
      "",
      "",
      "Existing native message",
      0,
      "",
      0
    );
    const original = await IOUtils.read(source);
    const inboxFolder = bindings.get(
      OLD_ROOT + "ImapMail/imap.localhost/INBOX.msf"
    ).folder;
    inboxFolder.msgDatabase.dBFolderInfo.setCharProperty("onlineName", "");
    const before = committedCacheState();
    const connection = database.connectionForTests;
    const faults = [];
    connection.createFunction("migration_cache_fault", 1, {
      onFunctionCall(args) {
        faults.push(args.getUTF8String(0));
        return 0;
      },
    });
    connection.executeSimpleSQL(`
    CREATE TEMP TRIGGER migration_cache_fault BEFORE INSERT ON folder_cache_imports
    BEGIN
      SELECT migration_cache_fault(NEW.token);
      SELECT RAISE(ABORT, 'migration cache receipt failure');
    END;
  `);
    try {
      await Assert.rejects(
        resumeMorkCacheImports(input.journal, database, lock, () => bindings),
        /NS_ERROR_STORAGE_CONSTRAINT/
      );
      Assert.deepEqual(
        faults,
        [input.journal.state.caches[0].token],
        "Actual receipt insert reached after native work"
      );
      Assert.ok(!connection.transactionInProgress);
      Assert.deepEqual(
        committedCacheState(),
        before,
        "Native failure rolls back rows and provenance"
      );
      Assert.strictEqual(input.journal.state.caches[0].receipt, null);
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER migration_cache_fault");
      connection.removeFunction("migration_cache_fault");
    }
    const checkpointError = new Error(
      "Cache checkpoint interrupted after native commit"
    );
    input.journal.recordCacheImport = async () => {
      throw checkpointError;
    };
    await Assert.rejects(
      resumeMorkCacheImports(input.journal, database, lock, () => bindings),
      error => error === checkpointError
    );
    const cache = input.journal.state.caches[0];
    Assert.equal(cache.state, "importing");
    Assert.strictEqual(cache.receipt, null);
    Assert.equal(
      input.journal.state.lastError.message,
      checkpointError.message
    );
    const request = createMorkFolderCacheRequest(cache);
    const receipt = database.getFolderCacheImportReceipt(request);
    Assert.ok(receipt, "Native commit exists before journal checkpoint");
    Assert.equal(receipt.identity.policy, "native-authoritative-v1");
    Assert.equal(receipt.identity.folders.length, 13);
    const inbox = bindings.get(
      OLD_ROOT + "ImapMail/imap.localhost/INBOX.msf"
    ).folder;
    const cell = name =>
      receipt.cells.find(p => p.id == inbox.id && p.name == name);
    Assert.deepEqual(
      {
        text: cell("flags").text,
        integer: cell("flags").integer,
        disposition: cell("flags").disposition,
      },
      {
        text: "88083014",
        integer: 2282237972,
        disposition: "native-authoritative",
      }
    );
    Assert.equal(cell("MRUTime").text, "1628202593");
    const rootId = bindings.get(OLD_ROOT + "ImapMail/imap.localhost").folder.id;
    Assert.equal(
      receipt.cells.find(p => p.id == rootId && p.name == "onlineName").text,
      ""
    );
    Assert.ok(!receipt.cells.some(p => p.name == "absent"));
    Assert.equal(
      cell("onlineName").text,
      "INBOX",
      "Receipt retains the original cache text"
    );
    Assert.equal(cell("onlineName").disposition, "existing");
    for (const [mutate, expected] of [
      [
        r =>
          r.cells.splice(
            r.cells.findIndex(p => p.id == inbox.id && p.name == "MRUTime"),
            1
          ),
        /Native cache receipt cells changed/,
      ],
      [
        r => r.cells.push(structuredClone(r.cells[0])),
        /Invalid cache property/,
      ],
      [
        r => {
          r.cells.find(p => p.name == "flags").disposition = "applied";
        },
        /Invalid native cache cell disposition/,
      ],
      [
        r => {
          r.cells.find(p => p.name == "MRUTime").text = "changed";
        },
        /Native cache receipt cells changed/,
      ],
      [
        r => {
          r.identity.folders[0].id = inbox.id;
        },
        /Duplicate cache folder binding/,
      ],
    ]) {
      const invalid = structuredClone(receipt);
      mutate(invalid);
      Assert.throws(
        () => validateMorkFolderCacheReceipt(cache, invalid),
        expected
      );
    }
    const committed = committedCacheState();
    Assert.deepEqual(
      committed.folders,
      before.folders,
      "Cache cannot override native flags/names"
    );
    Assert.deepEqual(
      committed.messages,
      before.messages,
      "Physical mail rows survive"
    );
    Assert.ok(
      committed.messages.some(
        ([key, id]) => key == protectedKey && id == "cache-protected@invalid"
      )
    );
    Assert.ok(
      committed.properties.some(
        ([id, name, type, value]) =>
          id == inbox.id &&
          name == "onlineName" &&
          type == "text" &&
          value === ""
      ),
      "An existing present-empty value is preserved independently of raw cache text"
    );
    Assert.equal(committed.receipts.length, 1);
    Assert.deepEqual(committed.bindings, [[13]]);
    input.journal.close();
    input.journal = await MigrationJournal.open(
      input.path,
      lock.directory.path
    );
    registerCleanupFunction(() => input.journal.close());
    const count = changes();
    await resumeMorkCacheImports(input.journal, database, lock, () => bindings);
    Assert.deepEqual(input.journal.state.caches[0].receipt, receipt);
    Assert.equal(input.journal.state.caches[0].state, "imported");
    Assert.equal(
      input.journal.state.sources[0].state,
      "pending",
      "Cache receipt is not a mail key map"
    );
    Assert.equal(
      input.journal.state.stage,
      "import",
      "Pending mail still prevents stage completion"
    );
    Assert.deepEqual(committedCacheState(), committed);
    Assert.equal(
      changes(),
      count,
      "Recovery looks up the original native commit without writing"
    );
    const revision = input.journal.state.revision;
    await resumeMorkCacheImports(input.journal, database, lock, () => bindings);
    Assert.equal(input.journal.state.revision, revision);
    Assert.equal(changes(), count);
    const remapped = new Map(bindings);
    remapped.set(OLD_ROOT + "ImapMail/imap.localhost/INBOX.msf", {
      folder: control,
      descriptor: cacheKey(control.summaryFile),
    });
    await Assert.rejects(
      resumeMorkCacheImports(input.journal, database, lock, () => remapped),
      /Cache snapshot differs from the journal plan/
    );
    await IOUtils.write(source, new Uint8Array([...original, 10]));
    try {
      await Assert.rejects(
        resumeMorkCacheImports(input.journal, database, lock, () => bindings),
        /not covered by the verified backup/
      );
    } finally {
      await IOUtils.write(source, original);
    }
    Assert.equal(input.journal.state.caches[0].state, "imported");
    Assert.deepEqual(committedCacheState(), committed);
    const controller = new AbortController();
    controller.abort();
    await Assert.rejects(
      resumeMorkCacheImports(
        input.journal,
        database,
        lock,
        () => bindings,
        controller.signal
      ),
      error => error.name == "AbortError"
    );
    Assert.equal(input.journal.state.caches[0].state, "imported");
    Assert.deepEqual(committedCacheState(), committed);
    Assert.deepEqual(await IOUtils.read(source), original);
    Assert.deepEqual(
      await IOUtils.read(do_get_file(CACHE_FILE).path),
      original
    );
    Assert.deepEqual(
      await verifyMigrationBackup(PathUtils.parent(backup.path)),
      backup
    );
  }
);

add_task(
  { skip_if: skipOnWindows },
  async function test_selectedCacheV2RejectsChangedProof() {
    reconciledInput = await plannedCache(2, reconciledBindings);
    const cache = reconciledInput.journal.state.caches[0];
    Assert.equal(cache.id, "panacea-v2");
    // The recorded input is canonical; macOS temporary profiles sit below /var.
    const expected = new FileUtils.File(reconciledSource);
    expected.normalize();
    Assert.equal(cache.path, expected.path);
    Assert.notEqual(cache.path, source);
    Assert.deepEqual(
      await IOUtils.read(cache.path),
      await IOUtils.read(do_get_file(CACHE_FILE).path)
    );
    const request = createMorkFolderCacheRequest(cache);
    Assert.equal(request.version, 2);
    const canonicalProfile = lock.directory.clone();
    canonicalProfile.normalize();
    const canonicalManifest = new FileUtils.File(backup.path);
    canonicalManifest.normalize();
    Assert.deepEqual(request.proof, {
      profilePath: canonicalProfile.path,
      manifest: {
        path: canonicalManifest.path,
        size: (await IOUtils.stat(backup.path)).size,
        sha256: backup.sha256,
      },
    });
    Assert.equal(request.folders.length, 13);
    for (const row of request.folders) {
      Assert.equal(row.originalSummaryPath, row.isServer ? "" : row.cachePath);
      Assert.equal(row.storeType, "maildir");
    }
    for (const mutate of [
      unit => {
        unit.requestVersion = 3;
      },
      unit => {
        unit.proof.manifest.size = 0;
      },
      unit => {
        unit.proof.manifest.path = "manifest.json";
      },
      unit => {
        unit.folders.find(row => !row.isServer).originalSummaryPath =
          "not-absolute";
      },
    ]) {
      const invalid = structuredClone(cache);
      mutate(invalid);
      Assert.throws(
        () => createMorkFolderCacheRequest(invalid),
        /version|proof|original/
      );
    }
    const before = committedCacheState();
    for (const mutate of [
      value => {
        value.proof.manifest.sha256 = "0".repeat(64);
      },
      value => {
        value.proof.manifest.size++;
      },
      value => {
        value.proof.profilePath = work;
      },
      value => {
        value.folders.find(row => !row.isServer).originalSummaryPath =
          control.summaryFile.path;
      },
    ]) {
      const invalid = structuredClone(request);
      mutate(invalid);
      Assert.throws(
        () => database.importFolderCacheMetadata(invalid),
        /NS_ERROR/
      );
      Assert.deepEqual(
        committedCacheState(),
        before,
        "Changed proof commits no metadata, receipt or binding"
      );
      Assert.ok(!database.connectionForTests.transactionInProgress);
    }
    Assert.equal(reconciledInput.journal.state.caches[0].state, "pending");
    Assert.strictEqual(reconciledInput.journal.state.caches[0].receipt, null);
    Assert.deepEqual(
      await IOUtils.read(source),
      await IOUtils.read(do_get_file(CACHE_FILE).path)
    );
  }
);

add_task(
  { skip_if: skipOnWindows },
  async function test_selectedCacheV2PreservesExplicitZeroAndPresentEmpty() {
    const archive = reconciledBindings.get(
      OLD_ROOT + "ImapMail/imap.localhost/Archives.msf"
    ).folder;
    const drafts = reconciledBindings.get(
      OLD_ROOT + "ImapMail/imap.localhost/Drafts.msf"
    ).folder;
    const inbox = reconciledBindings.get(
      OLD_ROOT + "ImapMail/imap.localhost/INBOX.msf"
    ).folder;
    archive.setFlag(Ci.nsMsgFolderFlags.Favorite);
    archive.clearFlag(Ci.nsMsgFolderFlags.Favorite);
    Assert.equal(archive.flags & Ci.nsMsgFolderFlags.Favorite, 0);
    drafts.msgDatabase.dBFolderInfo.flags = 0;
    Assert.equal(
      folderDB.getFolderFlags(drafts.id),
      0,
      "Explicit whole-word zero is real native authority"
    );
    const info = inbox.msgDatabase.dBFolderInfo;
    info.imapTotalPendingMessages = 0;
    info.imapUnreadPendingMessages = 0;
    info.setCharProperty("onlineName", "");
    Assert.equal(info.imapTotalPendingMessages, 0);
    Assert.equal(info.imapUnreadPendingMessages, 0);
    Assert.equal(info.getCharProperty("onlineName"), "");
  }
);

add_task(
  { skip_if: skipOnWindows },
  async function test_selectedCacheV2ProjectsNativeFieldsAndColdReopens() {
    const input = reconciledInput;
    const original = await IOUtils.read(reconciledSource);
    const controlBody = await IOUtils.read(control.filePath.path);
    const controlSummary = await IOUtils.read(control.summaryFile.path);
    Assert.deepEqual(
      controlBody,
      await IOUtils.read(do_get_file("data/migration").path)
    );
    Assert.deepEqual(
      controlSummary,
      await IOUtils.read(do_get_file("data/migration.msf").path)
    );
    const before = committedCacheState();
    const nativeBefore = new Map(
      before.folders.map(([id, name, flags]) => [id, { name, flags }])
    );
    const inbox = reconciledBindings.get(
      OLD_ROOT + "ImapMail/imap.localhost/INBOX.msf"
    ).folder;
    const archive = reconciledBindings.get(
      OLD_ROOT + "ImapMail/imap.localhost/Archives.msf"
    ).folder;
    const drafts = reconciledBindings.get(
      OLD_ROOT + "ImapMail/imap.localhost/Drafts.msf"
    ).folder;
    const queue = reconciledBindings.get(
      OLD_ROOT + "Mail/Local Folders/Unsent Messages.msf"
    ).folder;
    const queueName = queue.name;
    const checkpointError = new Error(
      "Version2 journal write failed after native commit"
    );
    input.journal.recordCacheImport = async () => {
      throw checkpointError;
    };
    await Assert.rejects(
      resumeMorkCacheImports(
        input.journal,
        database,
        lock,
        () => reconciledBindings
      ),
      error => error === checkpointError
    );
    const cache = input.journal.state.caches[0];
    Assert.equal(cache.state, "importing");
    Assert.strictEqual(cache.receipt, null);
    Assert.equal(
      input.journal.state.lastError.message,
      checkpointError.message
    );
    const receipt = database.getFolderCacheImportReceipt(
      createMorkFolderCacheRequest(cache)
    );
    Assert.ok(
      receipt,
      "Actual native version2 commit precedes the failed checkpoint"
    );
    Assert.equal(receipt.identity.version, 2);
    Assert.equal(receipt.identity.policy, "native-reconciled-selected-v2");
    validateMorkFolderCacheReceipt(cache, receipt);
    for (const [mutate, expected] of [
      [
        value => {
          value.identity.proof.manifest.sha256 = "0".repeat(64);
        },
        /proof changed/,
      ],
      [
        value => {
          value.cells.find(cell => cell.name == "pendingMsgs").target =
            "pendingMsgs";
        },
        /field projection/,
      ],
      [
        value => {
          value.cells.find(cell => cell.name == "flags").eligibleMask =
            0xffffffff;
        },
        /flags projection/,
      ],
      [
        value => {
          value.cells.find(cell => cell.name == "MRUTime").disposition =
            "unreconciled";
        },
        /unreconciled/,
      ],
      [
        value => {
          value.cells.splice(
            value.cells.findIndex(cell => cell.name == "MRUTime"),
            1
          );
        },
        /cells changed/,
      ],
    ]) {
      const invalid = structuredClone(receipt);
      mutate(invalid);
      Assert.throws(
        () => validateMorkFolderCacheReceipt(cache, invalid),
        expected
      );
    }
    const clientMask = 0xa8000010;
    Assert.equal(
      (folderDB.getFolderFlags(inbox.id) & clientMask) >>> 0,
      0x88000010
    );
    for (const { folder } of reconciledBindings.values()) {
      const actual = folderDB.getFolderFlags(folder.id);
      const prior = nativeBefore.get(folder.id).flags;
      Assert.equal(
        (actual & ~clientMask) >>> 0,
        (prior & ~clientMask) >>> 0,
        "Native structural, type, special, virtual and offline-event bits survive"
      );
      Assert.equal(
        folder.flags >>> 0,
        actual >>> 0,
        "Public folder flags use the committed native value"
      );
      if (!folder.isServer) {
        const opened = folder.msgDatabase;
        const expectedFlags = opened.dBFolderInfo.flags >>> 0;
        folder.ForceDBClosed();
        const reopened = folder.msgDatabase;
        Assert.notStrictEqual(
          reopened,
          opened,
          "Ordinary folder close creates a cold facade"
        );
        Assert.equal(reopened.dBFolderInfo.flags >>> 0, expectedFlags);
        Assert.equal(folder.flags >>> 0, actual >>> 0);
      }
    }
    Assert.equal(
      folderDB.getFolderFlags(archive.id) & Ci.nsMsgFolderFlags.Favorite,
      0
    );
    Assert.equal(folderDB.getFolderFlags(drafts.id), 0);
    const freshInfo = inbox.msgDatabase.dBFolderInfo;
    Assert.equal(freshInfo.imapTotalPendingMessages, 0);
    Assert.equal(freshInfo.imapUnreadPendingMessages, 0);
    Assert.equal(freshInfo.getCharProperty("onlineName"), "");
    Assert.equal(freshInfo.getCharProperty("MRUTime"), "1628202593");
    const properties = committedCacheState().properties;
    for (const name of ["totPendingMsgs", "unreadPendingMsgs"]) {
      Assert.ok(
        properties.some(
          ([id, key, type, value]) =>
            id == inbox.id && key == name && type == "integer" && value === 0
        ),
        "Exact native pending alias has a present integer zero: " + name
      );
    }
    Assert.ok(
      !properties.some(
        ([id, name]) =>
          id == inbox.id && ["pendingMsgs", "pendingUnreadMsgs"].includes(name)
      ),
      "Cache spelling remains provenance rather than a second native pending field"
    );
    Assert.equal(
      freshInfo.numMessages,
      0,
      "Cached total2 creates no physical mail rows"
    );
    Assert.equal(
      freshInfo.numUnreadMessages,
      0,
      "Cached unread1 creates no unread rows"
    );
    Assert.equal(
      queue.name,
      queueName,
      "Cached Outbox label does not rename native Queue"
    );
    const cell = name =>
      receipt.cells.find(value => value.id == inbox.id && value.name == name);
    Assert.equal(cell("flags").text, "88083014");
    Assert.equal(cell("flags").integer, 2282237972);
    Assert.equal(cell("MRUTime").text, "1628202593");
    Assert.equal(
      cell("onlineName").text,
      "INBOX",
      "Original cache text stays provenance beside native present-empty"
    );
    Assert.ok(!receipt.cells.some(value => value.name == "absent"));
    Assert.deepEqual(
      committedCacheState().messages,
      before.messages,
      "Unrelated committed physical mail survives"
    );
    Assert.ok(!database.connectionForTests.transactionInProgress);
    Assert.ok(
      !(await IOUtils.exists(
        PathUtils.join(PathUtils.profileDir, "folderCache.json")
      )),
      "Native import and ordinary facade reopen never recreate the obsolete writer"
    );
    Assert.deepEqual(
      await IOUtils.read(control.filePath.path),
      controlBody,
      "Cache metadata never changes genuine original body bytes"
    );
    Assert.deepEqual(
      await IOUtils.read(control.summaryFile.path),
      controlSummary,
      "Cache metadata never changes genuine original summary bytes"
    );
    Assert.deepEqual(await IOUtils.read(reconciledSource), original);
    Assert.deepEqual(
      await IOUtils.read(do_get_file(CACHE_FILE).path),
      original
    );
  }
);

add_task(
  { skip_if: skipOnWindows },
  async function test_selectedCacheV2CommitBeforeCheckpointAndHistoricalRetry() {
    const input = reconciledInput;
    const cache = input.journal.state.caches[0];
    const receipt = database.getFolderCacheImportReceipt(
      createMorkFolderCacheRequest(cache)
    );
    const before = committedCacheState();
    input.journal.close();
    input.journal = await MigrationJournal.open(
      input.path,
      lock.directory.path
    );
    registerCleanupFunction(() => input.journal.close());
    const noLiveBinding = () => {
      throw new Error(
        "Committed original audit must not resolve a new live mapping"
      );
    };
    const count = changes();
    await resumeMorkCacheImports(input.journal, database, lock, noLiveBinding);
    Assert.equal(input.journal.state.caches[0].state, "imported");
    Assert.deepEqual(input.journal.state.caches[0].receipt, receipt);
    Assert.deepEqual(committedCacheState(), before);
    Assert.equal(
      changes(),
      count,
      "Commit-before-checkpoint reconciliation is SQL read-only"
    );
    const revision = input.journal.state.revision;
    await resumeMorkCacheImports(input.journal, database, lock, noLiveBinding);
    Assert.equal(input.journal.state.revision, revision);
    Assert.equal(changes(), count);
    const folder = reconciledBindings.get(
      OLD_ROOT + "ImapMail/imap.localhost/foo.msf"
    ).folder;
    const originalName = folderDB.getFolderName(folder.id);
    folderDB.updateName(folder.id, "renamed-after-transfer");
    try {
      const renamed = committedCacheState();
      const renamedCount = changes();
      await resumeMorkCacheImports(
        input.journal,
        database,
        lock,
        noLiveBinding
      );
      Assert.deepEqual(input.journal.state.caches[0].receipt, receipt);
      Assert.deepEqual(
        committedCacheState(),
        renamed,
        "Historical audit cannot rename or rebind current native rows"
      );
      Assert.equal(changes(), renamedCount);
    } finally {
      folderDB.updateName(folder.id, originalName);
    }
  }
);

add_task(function test_JSONCacheRetainsDescriptorIdentityAndTypedPresence() {
  const key = PathUtils.join(PathUtils.profileDir, "Original ☃.msf");
  const input = {
    [key]: {
      flags: 0,
      pendingMsgs: -1,
      userSortOrder: 0xffffffff,
      folderSize: 9007199254740991,
      folderName: "Original ☃",
      empty: "",
      unknownText: "unchanged",
    },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const before = bytes.slice();
  const parsed = parseJSONFolderCache(bytes);
  Assert.equal(parsed.format, "json");
  Assert.deepEqual([...parsed.entries.keys()], [key]);
  const row = parsed.entries.get(key);
  Assert.ok(!Object.hasOwn(row, "sourceKey"), "JSON has no Mork row ID");
  Assert.equal(row.properties.get("key"), key);
  Assert.equal(row.properties.get("flags"), "0");
  Assert.equal(row.values.flags, 0, "Explicit numeric zero stays present");
  Assert.equal(row.properties.get("pendingMsgs"), "ffffffff");
  Assert.equal(row.values.pendingMsgs, -1);
  Assert.equal(row.properties.get("userSortOrder"), "ffffffff");
  Assert.equal(row.values.userSortOrder, 0xffffffff);
  const defaultOrder = parseJSONFolderCache(
    new TextEncoder().encode(JSON.stringify({ [key]: { userSortOrder: 0 } }))
  ).entries.get(key);
  Assert.equal(defaultOrder.properties.get("userSortOrder"), "0");
  Assert.equal(defaultOrder.values.userSortOrder, 0);
  const missingOrder = parseJSONFolderCache(
    new TextEncoder().encode(JSON.stringify({ [key]: {} }))
  ).entries.get(key);
  Assert.ok(!missingOrder.properties.has("userSortOrder"));
  Assert.ok(!Object.hasOwn(missingOrder.values, "userSortOrder"));
  Assert.equal(row.properties.get("folderSize"), "1fffffffffffff");
  Assert.equal(row.values.folderSize, 9007199254740991);
  Assert.equal(row.properties.get("folderName"), "Original ☃");
  Assert.equal(row.properties.get("empty"), "");
  Assert.equal(row.properties.get("unknownText"), "unchanged");
  Assert.ok(!row.properties.has("absent"));
  Assert.deepEqual(parsed.source, input, "Original JSON rows remain JSON");
  Assert.deepEqual(bytes, before, "Parsing never rewrites original bytes");
  const empty = parseJSONFolderCache(new TextEncoder().encode("{}"));
  Assert.equal(
    empty.entries.size,
    0,
    "Only an actual empty object has zero rows"
  );
  Assert.deepEqual(empty.source, {});
});

add_task(function test_JSONCacheReadsDirtyDataAsTheOldReaderDoes() {
  // A folder cache is a rebuildable hint. nsMsgFolderCache starts with an
  // empty cache when the file does not parse and reports "no value" for a
  // cell its typed getter cannot return. Nothing here refuses a profile.
  const key = PathUtils.join(PathUtils.profileDir, "Original.msf");
  const encode = value => new TextEncoder().encode(JSON.stringify(value));
  const raw = text => new TextEncoder().encode(text);
  for (const bytes of [
    raw(""),
    raw("{broken"),
    raw("﻿{broken"),
    new Uint8Array([0xff, 0xfe, 0x00]),
    encode(null),
    encode([]),
    encode(0),
    encode("rows"),
  ]) {
    const unusable = parseJSONFolderCache(bytes);
    Assert.equal(unusable.entries.size, 0, "An unusable cache is empty");
    Assert.equal(unusable.format, "json");
    Assert.ok(unusable.unusable, "The reason is retained for the report");
    Assert.deepEqual(unusable.source, {});
  }
  // A row that is no object has no entry; its neighbours are unaffected.
  const rows = parseJSONFolderCache(
    encode({
      "": { folderName: "No path" },
      relative: {},
      [key]: {},
      "/null-row": null,
      "/array-row": [],
      "/true-row": true,
      "/text-row": "text",
      "/nul\0key": {},
    })
  );
  Assert.deepEqual([...rows.entries.keys()], ["", "relative", key]);
  Assert.equal(rows.entries.get("").values.folderName, "No path");
  Assert.equal(rows.skipped.entries, 5);
  Assert.strictEqual(
    rows.source["/null-row"],
    null,
    "The original keeps every row"
  );
  // Each cell alone: what the old typed getter returns, or no value.
  const cell = (name, value) => {
    const parsed = parseJSONFolderCache(encode({ [key]: { [name]: value } }));
    const entry = parsed.entries.get(key);
    Assert.ok(entry, "A dirty cell never removes its row");
    Assert.deepEqual(parsed.source[key][name], value);
    return entry.properties.has(name)
      ? [entry.values[name], entry.properties.get(name)]
      : null;
  };
  for (const [name, value] of [
    // Null: the getter's zero or empty default, the same as an absent cell.
    ["flags", null],
    ["nextUID", null],
    ["folderSize", null],
    ["folderName", null],
    ["MRUTime", null],
    // Text is not convertible to a number.
    ["flags", "0"],
    ["flags", "1c"],
    ["userSortOrder", "0"],
    ["totalMsgs", ""],
    // Out of the getter's range.
    ["flags", -1],
    ["flags", 0x100000000],
    ["userSortOrder", -1],
    ["userSortOrder", 0x100000000],
    ["totalMsgs", 0x80000000],
    ["totalMsgs", -0x80000001],
    ["folderSize", 9007199254740992],
    // No scalar at all.
    ["flags", []],
    ["flags", {}],
    ["folderName", []],
    ["folderName", {}],
    ["folderName", 1.5],
    // Text no later stage can carry exactly.
    ["folderName", "nul\0value"],
    ["folderName", "\ud800"],
  ]) {
    Assert.equal(
      cell(name, value),
      null,
      name + " " + JSON.stringify(value) + " has no value"
    );
  }
  for (const [name, value, expected] of [
    ["flags", 0, [0, "0"]],
    ["flags", 0xffffffff, [0xffffffff, "ffffffff"]],
    ["flags", true, [1, "1"]],
    ["flags", 4.75, [4, "4"]],
    ["totalMsgs", -1, [-1, "ffffffff"]],
    ["totalMsgs", false, [0, "0"]],
    ["hierDelim", 47.0, [47, "2f"]],
    ["folderSize", -2, [-2, "fffffffffffffffe"]],
    ["folderName", "Name", ["Name", "Name"]],
    ["folderName", "", ["", ""]],
    ["folderName", 12, ["12", "12"]],
    ["folderName", true, ["true", "true"]],
    ["unknownText", "kept", ["kept", "kept"]],
    ["folderName", "Replaced �", ["Replaced �", "Replaced �"]],
  ]) {
    Assert.deepEqual(
      cell(name, value),
      expected,
      name + " " + JSON.stringify(value)
    );
  }
  // A property named like the row key is no cell.
  const reserved = parseJSONFolderCache(
    encode({ [key]: { key: "replacement", flags: 4 } })
  );
  Assert.deepEqual(
    [...reserved.entries.get(key).properties],
    [
      ["key", key],
      ["flags", "4"],
    ]
  );
  Assert.equal(reserved.skipped.cells, 1);
  // Bytes that are not UTF-8 inside one value do not lose the document.
  const latin = new Uint8Array([
    ...raw('{"/a.msf":{"folderName":"caf'),
    0xe9,
    ...raw('","flags":4}}'),
  ]);
  const replaced = parseJSONFolderCache(latin).entries.get("/a.msf");
  Assert.equal(replaced.values.flags, 4);
  Assert.equal(replaced.values.folderName, "caf�");
});

add_task(function test_MorkCacheReadsDirtyDataAsTheOldReaderDoes() {
  // importFromMork/applyEntry: a file that does not open is an empty cache,
  // a row without a key is skipped, a later row replaces an earlier one and
  // a numeric cell without leading hexadecimal digits is dropped.
  const encode = text =>
    Uint8Array.from(text, character => character.charCodeAt(0));
  const document = rows =>
    encode(
      '// <!-- <mdb:mork:z v="1.4"/> -->\n' +
        "< <(a=c)> (80=ns:msg:db:row:scope:folders:all)" +
        "(81=ns:msg:db:table:kind:folders)(82=key)(83=flags)(84=folderName)" +
        "(85=totalMsgs)(86=folderSize)(87=custom)>\n" +
        "{1:^80 {(k^81:c)(s=9)}\n" +
        rows +
        "}\n"
    );
  for (const bytes of [
    encode(""),
    encode("not Mork at all"),
    encode('// <!-- <mdb:mork:z v="1.4"/> -->\n{1:^80 {(k^81:c)(s=9)} [1(^82'),
    encode(
      '// <!-- <mdb:mork:z v="1.4"/> -->\n' +
        "< <(a=c)> (80=ns:other:scope)(81=ns:other:kind)>\n" +
        "{1:^80 {(k^81:c)(s=9)}}\n"
    ),
  ]) {
    const unusable = parseMorkFolderCache(bytes);
    Assert.equal(unusable.entries.size, 0, "An unusable cache is empty");
    Assert.ok(unusable.unusable);
  }
  const parsed = parseMorkFolderCache(
    document(
      "[1(^82=/first.msf)(^83=1c)(^84=First)(^85=)(^86=zz)(^87=)]\n" +
        "[2(^83=4)(^84=No key)]\n" +
        "[3(^82=)(^83=4)]\n" +
        "[4(^82=/dup.msf)(^84=Earlier)]\n" +
        "[5(^82=/dup.msf)(^84=Later)(^83=1cz)(^85=123456789)]\n" +
        "[6(^82=/bytes.msf)(^84=caf$E9)(^83=8)]\n"
    )
  );
  Assert.deepEqual(
    [...parsed.entries.keys()],
    ["/first.msf", "/dup.msf", "/bytes.msf"]
  );
  const first = parsed.entries.get("/first.msf");
  Assert.equal(first.sourceKey, 1);
  Assert.deepEqual(
    { ...first.values },
    { flags: 0x1c, folderName: "First", custom: "" },
    "An empty or unreadable number has no value; empty text is text"
  );
  const duplicate = parsed.entries.get("/dup.msf");
  Assert.equal(duplicate.sourceKey, 5, "A later row replaces an earlier one");
  Assert.deepEqual(
    { ...duplicate.values },
    { folderName: "Later", flags: 0x1c },
    "Leading hexadecimal digits are read; an over-long number is dropped"
  );
  Assert.deepEqual(
    { ...parsed.entries.get("/bytes.msf").values },
    { flags: 8 },
    "Text that is not UTF-8 has no projection; its row stays"
  );
  Assert.equal(parsed.skipped.entries, 3);
  Assert.equal(parsed.source.rows.size, 6, "The original keeps every row");
});

add_task(
  function test_JSONCacheReceiptKeepsOriginalAndNativeUserOrderSeparate() {
    const key = PathUtils.join(PathUtils.profileDir, "NativeInbox.msf");
    const unit = {
      requestVersion: 3,
      sourceFormat: "json",
      id: "json-user-order",
      token: "json-user-order-token",
      databaseSourceId: "json-user-order-database",
      path: PathUtils.join(PathUtils.profileDir, "folderCache.json"),
      size: 2,
      sha256: "a".repeat(64),
      proof: {
        profilePath: PathUtils.profileDir,
        manifest: {
          path: PathUtils.join(PathUtils.profileDir, "backup", "manifest.json"),
          size: 1,
          sha256: "b".repeat(64),
        },
      },
      folders: [
        {
          originalKey: key,
          id: 1,
          isServer: false,
          descriptor: key,
          cachePath: key,
          storePath: PathUtils.join(PathUtils.profileDir, "NativeInbox"),
          originalSummaryPath: key,
          protocol: "none",
          storeType: "mbox",
          properties: [
            { name: "key", text: key },
            { name: "userSortOrder", text: "ffffffff", integer: 0xffffffff },
          ],
        },
      ],
    };
    const request = createMorkFolderCacheRequest(unit);
    const receipt = {
      identity: {
        version: 3,
        sourceFormat: "json",
        policy: "native-reconciled-json-v3",
        token: unit.token,
        sourceId: unit.id,
        databaseSourceId: unit.databaseSourceId,
        path: unit.path,
        size: unit.size,
        sha256: unit.sha256,
        proof: request.proof,
        folders: request.folders,
      },
      cells: [
        {
          id: 1,
          name: "key",
          text: key,
          target: "key",
          disposition: "binding",
        },
        {
          id: 1,
          name: "userSortOrder",
          text: "ffffffff",
          integer: 0xffffffff,
          target: "userSortOrder",
          disposition: "applied",
          nativeInteger: 0xffffffff,
        },
      ],
    };
    Assert.deepEqual(validateMorkFolderCacheReceipt(unit, receipt), receipt);
    const existing = structuredClone(receipt);
    existing.cells[1].disposition = "existing";
    existing.cells[1].nativeInteger = 7;
    Assert.deepEqual(
      validateMorkFolderCacheReceipt(unit, existing),
      existing,
      "The original sentinel remains retained when native order7 already exists"
    );
    for (const mutate of [
      cell => {
        cell.nativeInteger = 7;
      },
      cell => {
        cell.nativeInteger = -1;
      },
      cell => {
        cell.nativeInteger = 0x100000000;
      },
      cell => {
        cell.nativeText = "ffffffff";
      },
      cell => {
        cell.eligibleMask = 0;
      },
      cell => {
        cell.disposition = "native-authoritative";
      },
      cell => {
        delete cell.integer;
      },
      cell => {
        cell.integer = 0x100000000;
      },
      cell => {
        cell.text = "0ffffffff";
      },
      cell => {
        cell.target = "sortOrder";
      },
    ]) {
      const invalid = structuredClone(receipt);
      mutate(invalid.cells[1]);
      Assert.throws(
        () => validateMorkFolderCacheReceipt(unit, invalid),
        /cache/
      );
    }
    const incomplete = structuredClone(receipt);
    incomplete.cells.pop();
    Assert.throws(
      () => validateMorkFolderCacheReceipt(unit, incomplete),
      /cells changed/,
      "Native receipt cannot omit the original user order cell"
    );
  }
);

add_task(function test_JSONCacheObsoleteKeysAreExplicitAndRetained() {
  const key = PathUtils.join(PathUtils.profileDir, "CurrentInbox.msf");
  // Keys left by an earlier profile location; no current folder is there.
  const obsolete = [
    PathUtils.join(PathUtils.tempDir, "earlier", "CurrentInbox.msf"),
    PathUtils.join(PathUtils.tempDir, "other", "CurrentInbox.msf"),
  ].sort();
  const unit = {
    requestVersion: 3,
    sourceFormat: "json",
    id: "json-obsolete",
    token: "json-obsolete-token",
    databaseSourceId: "json-obsolete-database",
    path: PathUtils.join(PathUtils.profileDir, "folderCache.json"),
    size: 2,
    sha256: "a".repeat(64),
    proof: {
      profilePath: PathUtils.profileDir,
      manifest: {
        path: PathUtils.join(PathUtils.profileDir, "backup", "manifest.json"),
        size: 1,
        sha256: "b".repeat(64),
      },
    },
    folders: [
      {
        originalKey: key,
        id: 1,
        isServer: false,
        descriptor: key,
        cachePath: key,
        storePath: PathUtils.join(PathUtils.profileDir, "CurrentInbox"),
        originalSummaryPath: key,
        protocol: "none",
        storeType: "mbox",
        properties: [{ name: "key", text: key }],
      },
    ],
    unboundKeys: obsolete,
  };
  const request = createMorkFolderCacheRequest(unit);
  Assert.deepEqual(request.unboundKeys, obsolete);
  Assert.ok(
    !Object.hasOwn(
      createMorkFolderCacheRequest({ ...unit, unboundKeys: undefined }),
      "unboundKeys"
    ),
    "A cache without obsolete keys keeps its earlier request"
  );
  for (const unboundKeys of [
    [],
    [...obsolete].reverse(),
    [obsolete[0], obsolete[0]],
    [key],
    ["nul\0key"],
  ]) {
    Assert.throws(
      () => createMorkFolderCacheRequest({ ...unit, unboundKeys }),
      /Invalid obsolete folder-cache keys/
    );
  }
  Assert.deepEqual(
    createMorkFolderCacheRequest({ ...unit, unboundKeys: ["", ...obsolete] })
      .unboundKeys,
    ["", ...obsolete],
    "The entry Thunderbird wrote under an empty key is accounted as obsolete"
  );
  Assert.throws(
    () =>
      createMorkFolderCacheRequest({
        ...unit,
        requestVersion: undefined,
        sourceFormat: undefined,
        proof: undefined,
        path: PathUtils.join(PathUtils.profileDir, "panacea.dat"),
        folders: unit.folders.map(folder => ({ ...folder, sourceKey: 1 })),
      }),
    /Invalid obsolete folder-cache keys/,
    "Version1 has no explicit obsolete-key accounting"
  );
  const receipt = {
    identity: {
      version: 3,
      sourceFormat: "json",
      policy: "native-reconciled-json-v3",
      token: unit.token,
      sourceId: unit.id,
      databaseSourceId: unit.databaseSourceId,
      path: unit.path,
      size: unit.size,
      sha256: unit.sha256,
      proof: request.proof,
      folders: request.folders,
      unboundKeys: obsolete,
    },
    cells: [
      { id: 1, name: "key", text: key, target: "key", disposition: "binding" },
    ],
  };
  Assert.deepEqual(validateMorkFolderCacheReceipt(unit, receipt), receipt);
  for (const unboundKeys of [undefined, obsolete.slice(1)]) {
    const changed = structuredClone(receipt);
    changed.identity.unboundKeys = unboundKeys;
    Assert.throws(
      () => validateMorkFolderCacheReceipt(unit, changed),
      /Invalid native cache receipt identity/,
      "The receipt records exactly the omitted original keys"
    );
  }
});
