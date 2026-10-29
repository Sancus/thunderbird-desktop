/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
const { MailStringUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailStringUtils.sys.mjs"
);
const { ProfileCreator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ProfileCreator.sys.mjs"
);
const { importMorkFolderCacheForFolders } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MorkFolderCache.sys.mjs"
);
const CACHE_FILE = "panacea.dat";
const OLD_ROOT = "/foo/bar/profile-default/";
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
const LOCAL_NAMES = ["Trash", "Unsent Messages"];
let work;
let source;
let bindings;
let imapRoot;
let localRoot;

add_setup(async function setupNativeFolderDescriptors() {
  const creator = new ProfileCreator(do_get_profile());
  const local = creator.addLocalServer();
  for (const name of LOCAL_NAMES) {
    await local.rootFolder.addMailFolder(name);
  }
  const imap = creator.addServer("migration", "migration.invalid", "imap");
  const directory = do_get_profile();
  directory.append("cache-\u90ae\u4ef6-e\u0301");
  await IOUtils.makeDirectory(directory.path);
  imap.prefBranch.setStringPref(
    "directory-rel",
    "[ProfD]" + directory.leafName
  );
  Services.prefs.savePrefFile(
    new FileUtils.File(PathUtils.join(do_get_profile().path, "prefs.js"))
  );
  loadExistingDB();
  MailServices.accounts.accounts;
  Assert.equal(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    ),
    database,
    "The actual message database service is Panorama"
  );
  localRoot = MailServices.accounts.localFoldersServer.rootFolder;
  const server = MailServices.accounts.allServers.find(
    item => item.type == "imap"
  );
  Assert.ok(server, "The IMAP server exists");
  imapRoot = server.rootFolder;
  Assert.ok(localRoot, "The local root exists");
  Assert.ok(imapRoot, "The IMAP root exists");
  const imapFolder = imapRoot.QueryInterface(Ci.nsIMsgImapMailFolder);
  for (const name of IMAP_NAMES) {
    imapFolder.createClientSubfolderInfo(name, "/", 0, true);
  }
  Assert.equal(localRoot.incomingServerType, "none");
  Assert.equal(imapRoot.incomingServerType, "imap");
  Assert.ok(localRoot.isServer);
  Assert.ok(imapRoot.isServer);
  bindings = new Map([
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
      bindings.set(OLD_ROOT + oldPath + name + ".msf", folder);
    }
  }
  for (const [key, folder] of bindings) {
    Assert.ok(folder, "Native cache fixture folder exists: " + key);
    Assert.strictEqual(folderDB.getMsgFolderForFolder(folder.id), folder);
  }
  work = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "migration-cache-folders-"
  );
  registerCleanupFunction(() => IOUtils.remove(work, { recursive: true }));
  source = PathUtils.join(work, "panacea.dat");
  await IOUtils.write(
    source,
    await IOUtils.read(do_get_file(CACHE_FILE).path),
    { mode: "create" }
  );
  Assert.equal((await IOUtils.stat(source)).type, "regular");
  Assert.ok(!new FileUtils.File(source).isSymlink());
});

/** @param {nsIFile} file - Actual native cache file. @returns {string} Exact UTF-8 JSON key. */
function cacheKey(file) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    MailStringUtils.byteStringToUint8Array(file.persistentDescriptor)
  );
}

add_task(async function test_importsActualServerAndSummaryDescriptors() {
  const bytes = await IOUtils.read(source);
  const before = bytes.slice();
  const output = PathUtils.join(work, "mapped-folderCache.json");
  Assert.equal(
    await importMorkFolderCacheForFolders(bytes, output, bindings),
    13
  );
  const json = await IOUtils.readJSON(output);
  Assert.equal(Object.keys(json).length, 13);
  Assert.ok(Object.hasOwn(json, cacheKey(localRoot.filePath)));
  Assert.ok(Object.hasOwn(json, cacheKey(imapRoot.filePath)));
  const inbox = imapRoot.getChildNamed("INBOX");
  Assert.ok(inbox, "The LIST-created INBOX exists");
  const inboxKey = cacheKey(inbox.summaryFile);
  Assert.ok(
    inboxKey.includes("cache-\u90ae\u4ef6-e\u0301"),
    "Unicode spelling is exact"
  );
  Assert.notEqual(inboxKey, inbox.summaryFile.persistentDescriptor);
  Assert.ok(!Object.hasOwn(json, inbox.summaryFile.persistentDescriptor));
  Assert.ok(Object.hasOwn(json, inboxKey));
  Assert.ok(!Object.hasOwn(json, cacheKey(inbox.filePath)));
  Assert.equal(json[inboxKey].MRUTime, "1628202593");
  Assert.equal(json[inboxKey].MRMTime, "1628202592");
  Assert.equal(json[inboxKey].flags, 2282237972);
  const rootEntry = json[cacheKey(imapRoot.filePath)];
  Assert.ok(Object.hasOwn(rootEntry, "onlineName"));
  Assert.equal(rootEntry.onlineName, "");
  Assert.ok(!Object.hasOwn(rootEntry, "absent"));
  Assert.equal(rootEntry.folderSize, -1);
  Assert.equal(typeof json[inboxKey].MRUTime, "string");
  Assert.equal(json[inboxKey].totalMsgs, 2);
  Assert.equal(json[inboxKey].totalUnreadMsgs, 1);
  Assert.equal(
    database.messageDB.totalCount,
    0,
    "Staging cache JSON imports no mail rows"
  );
  const written = await IOUtils.read(output);
  await Assert.rejects(
    importMorkFolderCacheForFolders(bytes, output, bindings),
    error => error.name == "NoModificationAllowedError"
  );
  Assert.deepEqual(await IOUtils.read(output), written);
  Assert.deepEqual(bytes, before);
  Assert.deepEqual(await IOUtils.read(source), before);
  Assert.deepEqual(await IOUtils.read(do_get_file(CACHE_FILE).path), before);
});

add_task(async function test_missingOriginalBindingCreatesNoCache() {
  const partial = new Map(bindings);
  partial.delete(OLD_ROOT + "ImapMail/imap.localhost/INBOX.msf");
  const output = PathUtils.join(work, "missing.json");
  const bytes = await IOUtils.read(source);
  await Assert.rejects(
    importMorkFolderCacheForFolders(bytes, output, partial),
    /Incomplete/
  );
  Assert.ok(!(await IOUtils.exists(output)));
  Assert.deepEqual(await IOUtils.read(source), bytes);
});

add_task(async function test_collidingNativeDescriptorsCreateNoCache() {
  const collision = new Map(bindings);
  collision.set(
    OLD_ROOT + "ImapMail/imap.localhost/INBOX.msf",
    imapRoot.getChildNamed("Archives")
  );
  const output = PathUtils.join(work, "collision.json");
  const bytes = await IOUtils.read(source);
  await Assert.rejects(
    importMorkFolderCacheForFolders(bytes, output, collision),
    /colliding/
  );
  Assert.ok(!(await IOUtils.exists(output)));
  Assert.deepEqual(await IOUtils.read(source), bytes);
});

add_task(async function test_unknownOriginalKeyCreatesNoCache() {
  const unknown = new Map(bindings);
  const folder = unknown.get(OLD_ROOT + "ImapMail/imap.localhost/INBOX.msf");
  unknown.delete(OLD_ROOT + "ImapMail/imap.localhost/INBOX.msf");
  unknown.set("unrecorded-original-cache-key", folder);
  const output = PathUtils.join(work, "unknown.json");
  const bytes = await IOUtils.read(source);
  await Assert.rejects(
    importMorkFolderCacheForFolders(bytes, output, unknown),
    /colliding/
  );
  Assert.ok(!(await IOUtils.exists(output)));
  Assert.deepEqual(await IOUtils.read(source), bytes);
});
