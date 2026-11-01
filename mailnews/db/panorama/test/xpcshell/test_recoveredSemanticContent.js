/* This Source Code Form is subject to the terms of the Mozilla Public
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
const {
  createPanoramaMigrationTarget,
  createWindowsPanoramaMigrationTarget,
  resumeMorkImports,
} = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationCoordinator.sys.mjs"
);
const { MailSearchService } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchService.sys.mjs"
);
const { PanoramaSearchIndex } = ChromeUtils.importESModule(
  "resource:///modules/panorama/PanoramaSearchIndex.sys.mjs"
);
const { ChatSearchProvider, chatSearchDocumentId } = ChromeUtils.importESModule(
  "resource:///modules/panorama/ChatSearchProvider.sys.mjs"
);
const { getLogWriter, closeLogWriter, queueFileOperation } =
  ChromeUtils.importESModule("resource:///modules/logger.sys.mjs");

let journal, lock, backedUp, originalGloda, work;
const folders = new Map();
const recoveredBody = "\uFEFFrecovered é 😀 body\0tail";
/**
 * Creates a schema-layout unit input from GlodaDatastore schema30's literal DDL.
 * This is not a frozen legacy-producer fixture or a Gloda parity test.
 *
 * @param {string} name - Unique test database name.
 * @param {string} [changes=""] - Deliberate layout/data changes before close.
 * @returns {string} Closed rollback-journal database path.
 */
function createMailInput(name, changes = "") {
  const file = do_get_profile().clone();
  file.append("legacy-mail-" + name + ".sqlite");
  Assert.ok(!file.exists());
  const connection = Services.storage.openDatabase(file);
  try {
    Assert.equal(connection.databaseFile.path, file.path);
    Cc["@mozilla.org/messenger/fts3tokenizer;1"]
      .getService(Ci.nsIFts3Tokenizer)
      .registerTokenizer(connection);
    connection.executeSimpleSQL(`
      PRAGMA journal_mode=DELETE;
      PRAGMA user_version=30;
      CREATE TABLE folderLocations (id INTEGER PRIMARY KEY, folderURI TEXT NOT NULL,
        dirtyStatus INTEGER NOT NULL, name TEXT NOT NULL, indexingPriority INTEGER NOT NULL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, folderID INTEGER, messageKey INTEGER,
        conversationID INTEGER NOT NULL, date INTEGER, headerMessageID TEXT,
        deleted INTEGER NOT NULL default 0, jsonAttributes TEXT,
        notability INTEGER NOT NULL default 0);
      CREATE TABLE attributeDefinitions (id INTEGER PRIMARY KEY, attributeType INTEGER NOT NULL,
        extensionName TEXT NOT NULL, name TEXT NOT NULL, parameter BLOB);
      CREATE TABLE messageAttributes (conversationID INTEGER NOT NULL, messageID INTEGER NOT NULL,
        attributeID INTEGER NOT NULL, value NUMERIC);
      CREATE VIRTUAL TABLE messagesText USING fts3(tokenize mozporter, body TEXT,
        subject TEXT, attachmentNames TEXT, author TEXT, recipients TEXT);
      CREATE TABLE extensionData (value TEXT);
      INSERT INTO folderLocations VALUES (7,'mailbox://old/Inbox',0,'Inbox',0),
        (8,'mailbox://old/Copy',0,'Copy',0);
      INSERT INTO messages VALUES
        (32,7,0,14,123456789000,'same-id',0,'{"9001":"","9002":null,"unknown":"2a"}',0),
        (33,8,0,14,NULL,'same-id',0,NULL,0),
        (34,NULL,NULL,14,NULL,'ghost-id',0,NULL,0),
        (35,NULL,NULL,14,NULL,'deleted-id',1,NULL,0);
      INSERT INTO messagesText(docid,body,subject,attachmentNames,author,recipients) VALUES
        (32,char(65279)||'recovered é 😀 body'||char(0)||'tail','café','a.txt'||char(10)||'b.txt','Sender','Recipient'),
        (33,NULL,'',NULL,'','');
      INSERT INTO attributeDefinitions VALUES
        (9001,2,'unknown-extension','é',X'00FF80'),
        (9002,2,'unknown-extension','é',NULL);
      INSERT INTO messageAttributes VALUES
        (14,32,9001,9223372036854775807), (14,32,9002,''),
        (14,32,9002,NULL), (14,32,9001,X'00FF80'), (14,32,9001,3.125);
    `);
    if (changes) {
      connection.executeSimpleSQL(changes);
    }
  } finally {
    connection.close();
  }
  return file.path;
}

/**
 * Builds schema-layout unit input from pinned index_im/GlodaDatastore DDL.
 * This is not a legacy-produced Gloda fixture or a database parity claim.
 *
 * @param {string} name - Unique database name.
 * @param {string} relativePath - Actual original native log path.
 * @param {string} [changes=""] - Deliberate invalid-source mutation.
 * @returns {string} Closed schema30 rollback-journal database path.
 */
function createIndexInput(name, relativePath, changes = "") {
  const file = do_get_profile().clone();
  file.append("legacy-chat-" + name + ".sqlite");
  Assert.ok(!file.exists());
  const connection = Services.storage.openDatabase(file);
  try {
    Cc["@mozilla.org/messenger/fts3tokenizer;1"]
      .getService(Ci.nsIFts3Tokenizer)
      .registerTokenizer(connection);
    connection.executeSimpleSQL(`
      PRAGMA journal_mode=DELETE;
      PRAGMA user_version=30;
      CREATE TABLE imConversations(id INTEGER PRIMARY KEY, title STRING, time NUMBER, path STRING, jsonAttributes STRING);
      CREATE VIRTUAL TABLE imConversationsText USING fts3(tokenize mozporter, content STRING);
    `);
    const statement = connection.createStatement(
      "INSERT INTO imConversations(title,time,path,jsonAttributes) VALUES('dummy conv',123,:path,:json)"
    );
    try {
      statement.params.path = relativePath;
      statement.params.json = '{"unknown":"","9001":null}';
      statement.execute();
    } finally {
      statement.finalize();
    }
    const text = connection.createStatement(
      "INSERT INTO imConversationsText(docid,content) VALUES(1,char(65279)||:text)"
    );
    try {
      text.params.text = "old aggregate é\0exact";
      text.execute();
    } finally {
      text.finalize();
    }
    if (changes) {
      connection.executeSimpleSQL(changes);
    }
  } finally {
    connection.close();
  }
  return file.path;
}

add_setup(async function setupReceiptBoundNativeRecovery() {
  const profile = do_get_profile();
  for (const [name, value] of [
    ["security.nocertdb", true],
    ["mailnews.database.global.indexer.enabled", true],
    ["purple.logging.log_ims", true],
    ["chat.logging.cleanup", false],
  ]) {
    const previous = Services.prefs.prefHasUserValue(name)
      ? Services.prefs.getBoolPref(name)
      : null;
    Services.prefs.setBoolPref(name, value);
    registerCleanupFunction(() =>
      previous === null
        ? Services.prefs.clearUserPref(name)
        : Services.prefs.setBoolPref(name, previous)
    );
  }
  const provider = Cc["@mozilla.org/xre/directory-provider;1"]
    .getService(Ci.nsIDirectoryServiceProvider)
    .QueryInterface(Ci.nsIXREDirProvider);
  for (const key of ["DefProfRt", "DefProfLRt", "UAppData"]) {
    if (Services.dirsvc.has(key)) {
      Services.dirsvc.undefine(key);
    }
    Services.dirsvc.set(key, provider.getFile(key, {}).clone());
  }
  const profileService = Cc[
    "@mozilla.org/toolkit/profile-service;1"
  ].getService(Ci.nsIToolkitProfileService);
  const nativeProfile = profileService.createProfile(
    profile,
    "recovered-semantic",
    "tests"
  );
  lock = nativeProfile.lock({});
  registerCleanupFunction(() => {
    lock.unlock();
    nativeProfile.remove(false);
  });
  work = await IOUtils.createUniqueDirectory(
    PathUtils.parent(profile.path),
    "recovered-semantic-"
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
  const creator = new ProfileCreator(profile);
  const server = creator.addLocalServer();
  const inventories = new Map();
  const names = ["RecoveredInbox", "RecoveredCopy"];
  for (const name of names) {
    const original = await server.rootFolder.addMailFolder(name, {
      summary,
      mbox: body,
    });
    if (AppConstants.platform === "win") {
      inventories.set(
        name,
        captureMorkFolderWindowsInventory(
          new FileUtils.File(original.summaryFilePath),
          profile,
          new FileUtils.File(original.mailFilePath),
          profile
        )
      );
    }
  }
  originalGloda = createMailInput(
    "semantic",
    `
    UPDATE folderLocations SET folderURI='mailbox://nobody@Local%20Folders/RecoveredInbox' WHERE id=7;
    UPDATE folderLocations SET folderURI='mailbox://nobody@Local%20Folders/RecoveredCopy' WHERE id=8;
    UPDATE messages SET messageKey=1,headerMessageID='162378@invalid' WHERE id IN (32,33);
    INSERT INTO attributeDefinitions VALUES(9003,1,'built-in','isEncrypted',NULL);
    UPDATE messages SET jsonAttributes='{"9003":false,"unknown":"2a"}' WHERE id=32;
    INSERT INTO messages VALUES(36,7,3,14,NULL,'345692@invalid',0,'{"9003":false}',0),
      (37,8,3,14,NULL,'345692@invalid',0,'{"9003":true}',0);
    INSERT INTO messagesText(docid,body,subject,attachmentNames,author,recipients) VALUES
      (36,'','',NULL,'',''), (37,'quarantineneedle','encrypted',NULL,'','');
  `
  );
  const backup = await createMigrationBackup(
    profile.path,
    [],
    PathUtils.join(work, "backup")
  );
  loadExistingDB();
  Assert.equal(
    MailServices.accounts.accounts.length,
    1,
    "Load the ProfileCreator account before resolving its existing server"
  );
  const root = MailServices.accounts.localFoldersServer.rootFolder;
  const sources = [];
  for (const name of names) {
    const folder = root.getChildNamed(name);
    Assert.equal(folder.msgStore.storeType, "mbox");
    // ProfileCreator writes original files, not native target indexing policy.
    // Set the actual destination to an eligible physical mail folder explicitly.
    folder.setFlag(Ci.nsMsgFolderFlags.Mail);
    Assert.ok(folderDB.getFolderFlags(folder.id) & Ci.nsMsgFolderFlags.Mail);
    const inventory = inventories.get(name);
    const input = await readMorkFolderImport(
      folder,
      "planning-only",
      inventory
    );
    Assert.deepEqual(input.source.messageKeys.toSorted(), [1, 3]);
    folders.set(name, folder);
    sources.push({
      id: name,
      databaseSourceId: database.sourceId,
      ...input.source,
      ...(inventory ? { inventory } : {}),
      destinationFolderId: folder.id,
    });
  }
  journal = await MigrationJournal.create(
    PathUtils.join(work, "journal.json"),
    {
      profilePath: lock.directory.path,
      mailPaths: [],
      backupPath: PathUtils.parent(backup.path),
      sources,
    }
  );
  registerCleanupFunction(() => journal.close());
  await journal.recordBackup(backup);
  const target =
    AppConstants.platform === "win"
      ? createWindowsPanoramaMigrationTarget
      : createPanoramaMigrationTarget;
  await resumeMorkImports(
    journal,
    target(journal, database, id => folders.get(id), lock)
  );
  backedUp = PathUtils.join(
    PathUtils.parent(backup.path),
    "root-0",
    PathUtils.filename(originalGloda)
  );
});

/** @param {number} oldId - Original Gloda row ID. @returns {string} Actual imported physical key. */
function importedKey(oldId = 32) {
  const name =
    oldId === 33 || oldId === 37 ? "RecoveredCopy" : "RecoveredInbox";
  const oldKey = oldId >= 36 ? 3 : 1;
  return String(
    new Map(
      journal.state.sources.find(row => row.id === name).receipt.keys
    ).get(oldKey)
  );
}

/** @param {string} name - Unique sidecar suffix. @returns {Promise<object>} Owned service, sidecar and close/reopen operations. */
async function openMail(name) {
  const file = new FileUtils.File(PathUtils.join(work, name + ".sqlite"));
  const fixture = {
    file,
    service: await MailSearchService.open(file, database.sourceId, messageDB),
  };
  fixture.service.onError = () => {};
  registerCleanupFunction(() => fixture.service.close());
  return fixture;
}

/** @param {MailSearchService} service - Actual service. @returns {Promise<object>} Recovery counts after durable storage. */
function recover(service) {
  return service.recoverMail(
    journal,
    database,
    id => folders.get(id),
    lock,
    backedUp
  );
}

/** @param {MailSearchService} service - Actual bounded worker. @returns {Promise<void>} After this small fixture's pending work drains. */
async function drain(service) {
  for (let i = 0; i < 200; i++) {
    if (!(await service.update({ limit: 500 })).moreWork) {
      return;
    }
  }
  throw new Error("Recovery fixture did not drain bounded work");
}

/** @param {function(): Promise<void>} operation - Test work while owned source streams are unavailable. @returns {Promise<void>} After source names are restored even on failure. */
async function withoutBodies(operation) {
  const moved = [];
  try {
    for (const folder of folders.values()) {
      const path = folder.filePath.path;
      await IOUtils.move(path, path + ".held");
      moved.push(path);
    }
    await operation();
  } finally {
    for (const path of moved.reverse()) {
      await IOUtils.move(path + ".held", path);
    }
  }
}

/** @param {string} name - Unique physical conversation name. @returns {Promise<object>} Real logger, old index and provider resources. */
async function openRecoveredChat(name) {
  const conversation = {
    id: "recovered-" + name,
    title: "Recovered conversation",
    name: "buddy",
    normalizedName: "buddy",
    isChat: false,
    startDate: new Date("2022-03-04T12:00:00Z").valueOf() * 1000,
    account: {
      id: "recovered-" + name,
      normalizedName: "recovered-" + name,
      protocol: { normalizedName: "search-test" },
    },
  };
  const writer = getLogWriter(conversation);
  await writer._initialized;
  await writer.logMessage({
    time: conversation.startDate / 1000000 + 1,
    who: "sender",
    incoming: true,
    displayMessage: "privacyneedle",
    remoteId: "private-id",
  });
  await writer.logMessage({
    time: conversation.startDate / 1000000 + 2,
    who: "sender",
    incoming: true,
    displayMessage: "unrelatedneedle",
    remoteId: "keep-id",
  });
  const path = writer.currentPath;
  const relative = PathUtils.split(path).slice(-4).join("/");
  const indexPath = createIndexInput(name, relative);
  const file = new FileUtils.File(
    PathUtils.join(work, "chat-" + name + ".sqlite")
  );
  const input = {
    conversation,
    writer,
    path,
    relative,
    indexPath,
    file,
    root: PathUtils.join(do_get_profile().path, "logs"),
    provider: await ChatSearchProvider.open(file),
    id: chatSearchDocumentId(path),
  };
  registerCleanupFunction(async () => {
    await input.provider.close();
    closeLogWriter(conversation);
  });
  return input;
}

/** @param {object} input - Actual old index/log fixture. @returns {Promise<number>} Stored quarantine count. */
function recoverChat(input) {
  return input.provider.recoverLegacy(input.indexPath, input.root, [
    input.relative,
  ]);
}

add_task(async function test_receiptBoundMailPersistsOutsideFts() {
  const input = await openMail("persist");
  const before = await IOUtils.read(backedUp);
  Assert.deepEqual(await recover(input.service), { stored: 6, eligible: 2 });
  const records = await input.service.getRecoveryRecords();
  Assert.equal(records.length, 6);
  const first = records.find(row => row.documentId === importedKey());
  Assert.equal(first.payload.message.text.body, recoveredBody);
  Assert.equal(first.payload.message.text.subject, "café");
  Assert.equal(
    first.payload.message.raw.jsonAttributes.value,
    '{"9003":false,"unknown":"2a"}'
  );
  Assert.equal(
    first.sourceRevision,
    await IOUtils.computeHexDigest(backedUp, "sha256")
  );
  Assert.equal(
    first.payload.provenance.importReceipt.databaseSourceId,
    database.sourceId
  );
  Assert.equal(
    first.payload.provenance.importReceipt.folderId,
    folders.get("RecoveredInbox").id
  );
  Assert.equal(
    records.find(row => row.documentId === importedKey(33)).payload.message.text
      .body,
    null
  );
  Assert.equal(
    records.find(row => row.documentId === importedKey(36)).payload.message.text
      .body,
    ""
  );
  Assert.notEqual(importedKey(), importedKey(33));
  Assert.deepEqual(
    records
      .filter(row => row.documentId === null)
      .map(row => row.payload.reason)
      .sort(),
    ["deleted", "ghost"]
  );
  Assert.deepEqual(
    (await input.service.search("recovered")).items,
    [],
    "Storage has not fabricated a projection"
  );
  await input.service.close();
  input.service = await MailSearchService.open(
    input.file,
    database.sourceId,
    messageDB
  );
  input.service.onError = () => {};
  Assert.deepEqual(
    await input.service.getRecoveryRecords(),
    records,
    "Raw non-FTS source survives reopen"
  );
  Assert.deepEqual(await IOUtils.read(backedUp), before);
});

add_task(async function test_recoveredChatPreservesSourceAndQuarantine() {
  const input = await openRecoveredChat("quarantine");
  const before = await IOUtils.read(input.indexPath);
  Assert.equal(await recoverChat(input), 1);
  const [record] = await input.provider.getRecoveryRecords(input.id);
  Assert.equal(record.payload.text, "\uFEFFold aggregate é\0exact");
  Assert.equal(record.payload.disposition, "quarantined");
  Assert.equal(
    record.payload.log.source.sha256,
    await IOUtils.computeHexDigest(input.path, "sha256")
  );
  Assert.equal(
    record.payload.provenance.logSource.sha256,
    record.payload.log.source.sha256
  );
  Assert.equal(record.payload.canOpen, false);
  Assert.equal(await input.provider.getText(input.id), null);
  Assert.deepEqual((await input.provider.search("aggregate")).items, []);
  await input.provider.close();
  input.provider = await ChatSearchProvider.open(input.file);
  Assert.deepEqual(await input.provider.getRecoveryRecords(input.id), [record]);
  Assert.deepEqual(await IOUtils.read(input.indexPath), before);
});

add_task(async function test_rejectedOrChangedRecoveryNeverPublishes() {
  const input = await openMail("reject");
  await recover(input.service);
  const before = await input.service.getRecoveryRecords();
  const bytes = await IOUtils.read(backedUp);
  try {
    await IOUtils.write(backedUp, new Uint8Array([...bytes, 0]));
    await Assert.rejects(recover(input.service), /backup|changed|hash|size/i);
  } finally {
    await IOUtils.write(backedUp, bytes);
  }
  Assert.deepEqual(await input.service.getRecoveryRecords(), before);
  Assert.equal(
    before.find(row => row.documentId === importedKey(37)).payload.disposition,
    "quarantined"
  );
  await input.service.rebuild();
  Assert.deepEqual((await input.service.search("quarantineneedle")).items, []);
  Assert.deepEqual(await IOUtils.read(backedUp), bytes);
});

add_task(async function test_mailRebuildUsesStoredSourceAndContentRevision() {
  const input = await openMail("rebuild");
  await recover(input.service);
  await withoutBodies(async () => {
    Assert.equal(
      input.service.resolveDocument(importedKey()).originalContentAvailable,
      false
    );
    await input.service.rebuild();
    await drain(input.service);
    const text = await input.service.getText(importedKey());
    Assert.equal(text.body, recoveredBody);
    Assert.equal(text.bodyIndexed, true);
    Assert.equal(
      text.contentRevision,
      messageDB.getSearchState(Number(importedKey())).contentRevision
    );
    const page = await input.service.search("recovered");
    Assert.deepEqual(
      page.items.map(row => row.id),
      [importedKey()]
    );
    Assert.equal(
      page.items[0].offsetsUtf8,
      "1 0 3 9",
      "BOM contributes three UTF8 bytes to the exact stored-text offset"
    );
    Assert.equal((await input.service.getText(importedKey(36))).body, "");
    await input.service.close();
    input.service = await MailSearchService.open(
      input.file,
      database.sourceId,
      messageDB
    );
    input.service.onError = () => {};
    await input.service.rebuild();
    Assert.equal(
      (await input.service.getText(importedKey())).body,
      recoveredBody
    );
  });
});

add_task(async function test_metadataOnlyRefreshKeepsRecoveredText() {
  const input = await openMail("metadata");
  await recover(input.service);
  await withoutBodies(async () => {
    await input.service.rebuild();
    await drain(input.service);
    const before = await input.service.getText(importedKey());
    const header = messageDB.getMessage(Number(importedKey()));
    header.flags ^= Ci.nsMsgMessageFlags.Read;
    await drain(input.service);
    const after = await input.service.getText(importedKey());
    Assert.equal(after.body, recoveredBody);
    Assert.equal(after.contentRevision, before.contentRevision);
    Assert.greater(after.generation, before.generation);
    Assert.equal(after.textRevision, before.textRevision);
  });
});

add_task(async function test_failedPublicationRetainsRecoveredSource() {
  const input = await openMail("failure");
  const before = await IOUtils.read(backedUp);
  const failure = new Error("bounded publication scheduling failure");
  const original = PanoramaSearchIndex.prototype.retryUnavailable;
  try {
    PanoramaSearchIndex.prototype.retryUnavailable = () =>
      Promise.reject(failure);
    await Assert.rejects(recover(input.service), error => error === failure);
  } finally {
    PanoramaSearchIndex.prototype.retryUnavailable = original;
  }
  Assert.equal((await input.service.getRecoveryRecords()).length, 6);
  Assert.deepEqual(await IOUtils.read(backedUp), before);
  await withoutBodies(async () => {
    await input.service.rebuild();
    await drain(input.service);
    Assert.equal(
      (await input.service.getText(importedKey())).body,
      recoveredBody
    );
  });
});

add_task(async function test_changedOrExcludedRecoveryCannotRebuild() {
  const input = await openMail("stale");
  await recover(input.service);
  await withoutBodies(async () => {
    await input.service.rebuild();
    await drain(input.service);
    const before = await input.service.getText(importedKey());
    const header = messageDB.getMessage(Number(importedKey()));
    header.subject = "changed-content-revision";
    Assert.notEqual(
      messageDB.getSearchState(header.messageKey).contentRevision,
      before.contentRevision
    );
    await input.service.rebuild();
    await drain(input.service);
    Assert.deepEqual((await input.service.search("recovered")).items, []);
    Assert.equal(
      (await input.service.getText(importedKey())).bodyIndexed,
      false
    );
    const folder = folders.get("RecoveredInbox");
    folder.setFlag(Ci.nsMsgFolderFlags.Junk);
    try {
      await input.service.rebuild();
      await drain(input.service);
      Assert.equal(await input.service.getText(importedKey(36)), null);
      Assert.deepEqual(
        (await input.service.search("quarantineneedle")).items,
        []
      );
    } finally {
      folder.clearFlag(Ci.nsMsgFolderFlags.Junk);
    }
    await input.service.rebuild();
    await drain(input.service);
    Assert.equal(
      (await input.service.getText(importedKey(36))).bodyIndexed,
      false,
      "An empty recovered body is not reauthorized across the changed policy"
    );
    Assert.deepEqual((await input.service.search("recovered")).items, []);
  });
});

add_task(async function test_privacyErasureSurvivesReopenAndRebuild() {
  const input = await openRecoveredChat("privacy");
  await recoverChat(input);
  Assert.ok((await input.provider.refreshLog(input.path)).indexed);
  const before = await IOUtils.read(input.indexPath);
  const [retained] = await input.provider.getRecoveryRecords(input.id);
  Assert.ok(JSON.stringify(retained.payload).includes("privacyneedle"));
  let release;
  const hold = new Promise(resolve => {
    release = resolve;
  });
  const blocker = queueFileOperation(input.path, () => hold);
  let redaction, overlappingRead;
  try {
    redaction = input.provider.redactMessage({
      conversation: input.conversation,
      noLog: true,
      remoteId: "private-id",
      time: 1,
      who: "not-recorded",
      displayMessage: "notrecordedneedle",
    });
    overlappingRead = input.provider.getRecoveryRecords(input.id);
    Assert.ok(
      (await IOUtils.readUTF8(input.path)).includes("privacyneedle"),
      "Actual logger source remains unredacted behind its held file operation"
    );
    release();
    await blocker;
    Assert.deepEqual(await redaction, [input.path]);
    Assert.deepEqual(
      await overlappingRead,
      [],
      "A read started while source redaction is pending withholds the old payload"
    );
  } finally {
    release();
    await Promise.allSettled(
      [blocker, redaction, overlappingRead].filter(Boolean)
    );
  }
  const [erased] = await input.provider.getRecoveryRecords(input.id);
  Assert.ok(erased.erased);
  Assert.equal(erased.payload, null);
  const body = (await input.provider.getText(input.id)).body;
  Assert.equal(body, "sender: unrelatedneedle");
  await input.provider.close();
  input.provider = await ChatSearchProvider.open(input.file);
  await recoverChat(input);
  Assert.deepEqual(
    await input.provider.getRecoveryRecords(input.id),
    [erased],
    "Old backup cannot resurrect the erased payload"
  );
  await input.provider.rebuild();
  Assert.deepEqual((await input.provider.search("privacyneedle")).items, []);
  Assert.equal(
    (await input.provider.getText(input.id)).body,
    "sender: unrelatedneedle"
  );
  Assert.deepEqual(
    await IOUtils.read(input.indexPath),
    before,
    "Original unit backup remains read-only"
  );
});
