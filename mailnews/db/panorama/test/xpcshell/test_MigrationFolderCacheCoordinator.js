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
const { prepareMorkFolderCacheImport } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationCoordinator.sys.mjs"
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
let backup;
let control;
let controlInventory;
let serial = 0;
const bindings = new Map();

add_setup(async function setupBackedUpProfileAndActualNativeFolders() {
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
  // Initialize NSS before quiescing the profile for the backup.
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
  backup = await createMigrationBackup(
    profile.path,
    [],
    PathUtils.join(backupRoot, "backup")
  );
  loadExistingDB();
  MailServices.accounts.accounts;
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
