/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */

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
const { readMorkFolderImport } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MorkFolderImport.sys.mjs"
);
const { createPanoramaMigrationTarget, resumeMorkImports } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MigrationCoordinator.sys.mjs"
  );
const { MailSearchService } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchService.sys.mjs"
);
const { ChatSearchProvider, chatSearchDocumentId } = ChromeUtils.importESModule(
  "resource:///modules/panorama/ChatSearchProvider.sys.mjs"
);
const { getLogWriter, closeLogWriter, gFilePromises } =
  ChromeUtils.importESModule("resource:///modules/logger.sys.mjs");

// The ordinary single-file --profile-name xpcshell route retains this exact
// profile for the sequential real-process Marionette case. This JSON carries
// expected input identities, never a replacement for durable sidecar state.
const RECOVERED_BODY = "\uFEFFrecovered é 😀 body\0tail";

// The later S717 phase creates these mutable cases after the sealed S716 run.
// Keep expected text separate from values read back from native records/logs.
const S717_CASES = {
  "version": 1,
  "mail": {
    "edit": {
      "messageId": "s717-edit@example.invalid",
      "folder": "S717Edit",
      "oldSubject": "s717oldsubject",
      "newSubject": "s717newsubject",
      "body": "s717editbody"
    },
    "deleted": {
      "messageId": "s717-delete@example.invalid",
      "folder": "S717Delete",
      "subject": "s717deletesubject",
      "body": "s717deletedbody"
    },
    "excluded": {
      "messageId": "s717-exclude@example.invalid",
      "folder": "S717Exclude",
      "subject": "s717excludesubject",
      "body": "s717excludedbody"
    },
    "open": {
      "messageId": "s717-selected@example.invalid",
      "folders": [
        "S717Selected",
        "S717OtherCopy"
      ],
      "subject": "s717selectedsubject",
      "body": "s717selectedbody café é 😀"
    }
  },
  "chat": {
    "account": "s717-policy",
    "conversation": "buddy",
    "edit": {
      "remoteId": "edit",
      "oldText": "s717chatoldneedle",
      "newText": "s717chatnewneedle café é 😀"
    },
    "deleted": {
      "remoteId": "deleted",
      "text": "s717chatdeletedneedle"
    },
    "noLog": {
      "remoteId": "nolog",
      "text": "s717chatnologneedle"
    },
    "redacted": {
      "remoteId": "redacted",
      "text": "s717chatredactedneedle"
    },
    "keep": {
      "remoteId": "keep",
      "text": "s717chatkeepneedle café é 😀"
    },
    "otherPhysical": "s717otherphysicalneedle"
  }
};

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

/**
 * Saves the selected-profile preferences for the application case to restore.
 * The application must select Panorama before it opens this retained profile.
 *
 * @returns {Array<{name: string, hadValue: boolean, value: boolean}>} Old values.
 */
function selectTrialPreferences() {
  return [
    ["mail.panorama.enabled", true],
    ["mailnews.database.global.indexer.enabled", true],
    ["purple.logging.log_ims", true],
    ["chat.logging.cleanup", false],
    ["security.nocertdb", true],
  ].map(([name, value]) => {
    const saved = {
      name,
      hadValue: Services.prefs.prefHasUserValue(name),
      value: Services.prefs.getBoolPref(name, false),
    };
    Services.prefs.setBoolPref(name, value);
    return saved;
  });
}

/**
 * Returns the imported physical key from the actual committed receipt.
 *
 * @param {MigrationJournal} journal - Closed-source import journal.
 * @param {string} name - Original source folder identity.
 * @param {number} oldKey - Literal source message key.
 * @returns {string} Native physical message key.
 */
function receiptKey(journal, name, oldKey) {
  const source = journal.state.sources.find(row => row.id === name);
  Assert.ok(source?.receipt, "The native import produced a real receipt");
  const key = new Map(source.receipt.keys).get(oldKey);
  Assert.ok(Number.isSafeInteger(key) && key > 0, "Receipt has a physical key");
  return String(key);
}

/**
 * Stores two physical MIME copies with the same Message-ID in different folders.
 *
 * @param {nsIMsgLocalMailFolder} root - Actual Local Folders root.
 * @returns {{folders: nsIMsgLocalMailFolder[], headers: nsIMsgDBHdr[]}}
 *   Owned folders and independently stored headers.
 */
function addMimeCopies(root) {
  const folders = ["S716MimeFirst", "S716MimeSecond"].map(name =>
    root.createLocalSubfolder(name).QueryInterface(Ci.nsIMsgLocalMailFolder)
  );
  const raw = [
    "From: Trial Sender <sender@example.invalid>",
    "To: Trial Recipient <recipient@example.invalid>",
    "Date: Tue, 01 Jan 2019 00:00:00 +0000",
    "Message-ID: <s716-shared@example.invalid>",
    "Subject: s716copymetadata",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "s716availablebody",
    "",
  ].join("\r\n");
  const headers = folders.map(folder => folder.addMessage(raw));
  Assert.notEqual(headers[0].messageKey, headers[1].messageKey);
  Assert.equal(headers[0].messageId, headers[1].messageId);
  return { folders, headers };
}

/**
 * Creates the logger's real physical log and a quarantined old aggregate input.
 *
 * @param {string} work - Owned selected-profile fixture directory.
 * @returns {Promise<{id: string, path: string, relativePath: string,
 *   bodyNeedles: string[], expectedBody: string, aggregateNeedle: string,
 *   indexPath: string, recoveryRecords: number, chatSidecar: string}>}
 *   Actual logger identities and closed sidecar paths.
 */
async function createChatInput(work) {
  const conversation = {
    id: "s716-trial",
    title: "S716 retained conversation",
    name: "buddy",
    normalizedName: "buddy",
    isChat: false,
    startDate: new Date("2022-03-04T12:00:00Z").valueOf() * 1000,
    account: {
      id: "s716-trial",
      normalizedName: "s716-trial",
      protocol: { normalizedName: "search-test" },
    },
  };
  const writer = getLogWriter(conversation);
  let provider;
  try {
    await writer._initialized;
    const bodyNeedles = ["s716chatfirst", "s716chatsecond"];
    for (const [offset, displayMessage] of bodyNeedles.entries()) {
      await writer.logMessage({
        time: conversation.startDate / 1000000 + offset + 1,
        who: "sender",
        incoming: true,
        displayMessage,
        remoteId: "s716-" + offset,
      });
    }
    const path = writer.currentPath;
    const relativePath = PathUtils.split(path).slice(-4).join("/");
    const indexPath = createIndexInput(
      "s716",
      relativePath,
      "UPDATE imConversationsText SET content='oldaggregateneedle' WHERE docid=1;"
    );
    const chatSidecar = PathUtils.join(work, "chat.sqlite");
    provider = await ChatSearchProvider.open(new FileUtils.File(chatSidecar));
    Assert.equal(
      await provider.recoverLegacy(
        indexPath,
        PathUtils.join(do_get_profile().path, "logs"),
        [relativePath]
      ),
      1,
      "The aggregate is retained as provenance"
    );
    await provider.refreshLog(path);
    const id = chatSearchDocumentId(path);
    const text = await provider.getText(id);
    const expectedBody = "sender: s716chatfirst\n\nsender: s716chatsecond";
    Assert.equal(
      text.body,
      expectedBody,
      "Only real current logger messages enter search"
    );
    Assert.deepEqual((await provider.search("oldaggregateneedle")).items, []);
    return {
      id,
      path,
      relativePath,
      bodyNeedles,
      expectedBody,
      aggregateNeedle: "oldaggregateneedle",
      indexPath,
      recoveryRecords: 1,
      chatSidecar,
    };
  } finally {
    try {
      await provider?.close();
    } finally {
      closeLogWriter(conversation);
      for (const path of writer.paths) {
        await gFilePromises.get(path);
      }
    }
  }
}

add_task(async function test_createRetainedNativeRebuildTrial() {
  const profile = do_get_profile();
  const savedPrefs = selectTrialPreferences();
  const work = PathUtils.join(profile.path, "panorama-trial-rebuild");
  Assert.ok(
    !(await IOUtils.exists(work)),
    "The ordinary case requires a fresh owned profile"
  );
  await IOUtils.makeDirectory(work);

  // The backup API deliberately rejects descendants of the source profile.
  // Keep this exact path beside the retained profile; never move the profile.
  const backupRoot = await IOUtils.createUniqueDirectory(
    PathUtils.parent(profile.path),
    "s716-backup-"
  );
  // createMigrationBackup creates its destination and requires it absent.
  const backupPath = PathUtils.join(backupRoot, "source");
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
    "s716-trial",
    "tests"
  );
  const lock = nativeProfile.lock({});
  let journal, mail;
  let complete = false;
  const held = [];
  try {
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
    const names = ["RecoveredInbox", "RecoveredCopy"];
    for (const name of names) {
      await server.rootFolder.addMailFolder(name, { summary, mbox: body });
    }
    const originalGloda = createMailInput(
      "s716",
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
    const backup = await createMigrationBackup(profile.path, [], backupPath);
    loadExistingDB();
    Assert.equal(MailServices.accounts.accounts.length, 1);
    const root =
      MailServices.accounts.localFoldersServer.rootFolder.QueryInterface(
        Ci.nsIMsgLocalMailFolder
      );
    const folders = new Map();
    const sources = [];
    for (const name of names) {
      const folder = root.getChildNamed(name);
      folder.setFlag(Ci.nsMsgFolderFlags.Mail);
      Assert.ok(folderDB.getFolderFlags(folder.id) & Ci.nsMsgFolderFlags.Mail);
      const input = await readMorkFolderImport(folder, "planning-only");
      Assert.deepEqual(input.source.messageKeys.toSorted(), [1, 3]);
      folders.set(name, folder);
      sources.push({
        id: name,
        databaseSourceId: database.sourceId,
        ...input.source,
        destinationFolderId: folder.id,
      });
    }
    const journalPath = PathUtils.join(backupRoot, "journal.json");
    journal = await MigrationJournal.create(journalPath, {
      profilePath: lock.directory.path,
      mailPaths: [],
      backupPath,
      sources,
    });
    await journal.recordBackup(backup);
    await resumeMorkImports(
      journal,
      createPanoramaMigrationTarget(
        journal,
        database,
        id => folders.get(id),
        lock
      )
    );
    const backedUp = PathUtils.join(
      backupPath,
      "root-0",
      PathUtils.filename(originalGloda)
    );
    // Finish native folder policy changes before capturing eligible recovery.
    const copies = addMimeCopies(root);
    const missingKey = messageDB.addMessage(
      copies.folders[0].id,
      "s716-unavailable@example.invalid",
      [],
      123456,
      "Sender <sender@example.invalid>",
      "Recipient <recipient@example.invalid>",
      "",
      "",
      "s716metadataonly",
      0,
      "",
      Ci.nsMsgPriority.notSet
    );
    // The normal app factory opens this separate sidecar on first startup.
    // Prepare its real preference fingerprint before capturing recovery so that
    // an unchanged startup cannot journal a later global policy revision.
    const startupMailSidecar = PathUtils.join(
      profile.path,
      `panorama-search-${database.sourceId}.sqlite`
    );
    Assert.ok(!(await IOUtils.exists(startupMailSidecar)));
    const startupMail = await MailSearchService.open(
      new FileUtils.File(startupMailSidecar),
      database.sourceId,
      messageDB
    );
    try {
      Assert.equal(
        await startupMail.getText(String(missingKey)),
        null,
        "Preparing the startup fingerprint must not consume the trial inventory"
      );
    } finally {
      await startupMail.close();
    }
    const mailSidecar = PathUtils.join(work, "mail.sqlite");
    mail = await MailSearchService.open(
      new FileUtils.File(mailSidecar),
      database.sourceId,
      messageDB
    );
    Assert.deepEqual(
      await mail.recoverMail(
        journal,
        database,
        id => folders.get(id),
        lock,
        backedUp
      ),
      { stored: 6, eligible: 2 }
    );
    // Recovery schedules idle work. Close immediately so this instance cannot
    // silently finish the native inventory before the application checkpoint.
    await mail.close();
    mail = null;
    const recoveryPolicyRevision = messageDB.getSearchState(
      copies.headers[0].messageKey
    ).policyRevision;

    Assert.equal(typeof recoveryPolicyRevision, "string");
    Assert.ok(/^[1-9][0-9]*$/.test(recoveryPolicyRevision));

    const heldRoot = PathUtils.join(work, "held-original-streams");
    Assert.ok(!(await IOUtils.exists(heldRoot)));
    await IOUtils.makeDirectory(heldRoot);
    const emptyBodySHA256 =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    const expected = [];
    for (const [name, folder] of folders) {
      for (const oldKey of [1, 3]) {
        const id = receiptKey(journal, name, oldKey);
        const state = messageDB.getSearchState(Number(id));
        Assert.equal(state.folderId, folder.id);
        const recoveredKind = oldKey === 1 ? "recovered" : "recovered-empty";
        expected.push({
          id,
          folderId: folder.id,
          folderURI: folder.URI,
          messageId: messageDB.getMessage(Number(id)).messageId,
          kind:
            name === "RecoveredInbox" ? recoveredKind : "unavailable-imported",
          bodyNeedle:
            name === "RecoveredInbox" && oldKey === 1 ? "recovered" : null,
          metadataNeedle: null,
          bodyReady: name === "RecoveredInbox",
        });
      }
      const bodyPath = folder.filePath.path;
      // A held file in the mail root is discovered as a different native folder.
      // Keep the original empty mailbox path and retain its payload outside Mail.
      const heldPath = PathUtils.join(heldRoot, `${folder.id}.mbox`);
      const bodySHA256 = await IOUtils.computeHexDigest(bodyPath, "sha256");
      Assert.ok(!(await IOUtils.exists(heldPath)));
      await IOUtils.move(bodyPath, heldPath, { noOverwrite: true });
      held.push({ folder, bodyPath, heldPath, bodySHA256 });
      await IOUtils.write(bodyPath, new Uint8Array(), { mode: "create" });
      const placeholder = await IOUtils.stat(bodyPath);
      Assert.equal(placeholder.type, "regular");
      Assert.equal(placeholder.size, 0);
      Assert.equal(
        await IOUtils.computeHexDigest(bodyPath, "sha256"),
        emptyBodySHA256
      );
      Assert.equal(
        await IOUtils.computeHexDigest(heldPath, "sha256"),
        bodySHA256
      );
    }
    for (const header of copies.headers) {
      expected.push({
        id: String(header.messageKey),
        folderId: header.folder.id,
        folderURI: header.folder.URI,
        messageId: header.messageId,
        kind: "mime-copy",
        bodyNeedle: "s716availablebody",
        metadataNeedle: "s716copymetadata",
        bodyReady: true,
      });
    }
    expected.push({
      id: String(missingKey),
      folderId: copies.folders[0].id,
      folderURI: copies.folders[0].URI,
      messageId: "s716-unavailable@example.invalid",
      kind: "metadata-only",
      bodyNeedle: null,
      metadataNeedle: "s716metadataonly",
      bodyReady: false,
    });
    Assert.equal(expected.length, 7);
    Assert.equal(new Set(expected.map(row => row.id)).size, 7);
    for (const row of expected) {
      const state = messageDB.getSearchState(Number(row.id));
      Assert.equal(state.folderId, row.folderId);
      Assert.equal(typeof state.contentRevision, "string");
    }
    const chat = await createChatInput(work);
    Assert.equal(
      messageDB.getSearchState(copies.headers[0].messageKey).policyRevision,
      recoveryPolicyRevision,
      "The fixed corpus must not invalidate captured recovery policy"
    );
    const sourcePaths = [
      originalGloda,
      backedUp,
      backup.path,
      summary.path,
      body.path,
      chat.path,
      chat.indexPath,
      ...held.map(row => row.heldPath),
      ...held.map(row => row.bodyPath),
      ...copies.folders.map(folder => folder.filePath.path),
    ];
    const sourceHashes = [];
    for (const path of [...new Set(sourcePaths)]) {
      sourceHashes.push({
        path,
        sha256: await IOUtils.computeHexDigest(path, "sha256"),
      });
    }
    const fixture = {
      version: 1,
      profile: profile.path,
      sourceId: database.sourceId,
      work,
      mailSidecar,
      startupMailSidecar,
      recoveryPolicyRevision,
      chatSidecar: chat.chatSidecar,
      journalPath,
      backupManifest: backup.path,
      backedUp,
      sourceHashes,
      folders: [
        ...held.map(({ folder, bodyPath, heldPath }) => ({
          name: folder.name,
          id: folder.id,
          uri: folder.URI,
          bodyPath,
          heldPath,
        })),
        ...copies.folders.map(folder => ({
          name: folder.name,
          id: folder.id,
          uri: folder.URI,
          bodyPath: folder.filePath.path,
          heldPath: null,
        })),
      ],
      mail: expected,
      recovered: {
        id: receiptKey(journal, "RecoveredInbox", 1),
        emptyId: receiptKey(journal, "RecoveredInbox", 3),
        body: RECOVERED_BODY,
        quarantinedId: receiptKey(journal, "RecoveredCopy", 3),
        excludedRowIds: [34, 35],
        records: 6,
        eligible: 2,
      },
      chat,
      savedPrefs,
    };
    fixture.s717 = {
      ...S717_CASES,
      sourceId: fixture.sourceId,
      excludedFolderFlag: Ci.nsMsgFolderFlags.Junk,
      recovered: {
        id: fixture.recovered.id,
        emptyId: fixture.recovered.emptyId,
        body: fixture.recovered.body,
        records: fixture.recovered.records,
        eligible: fixture.recovered.eligible,
        sourceRevision: sourceHashes.find(row => row.path == backedUp).sha256,
      },
    };
    await journal.close();
    journal = null;
    MailServices.accounts.saveAccountInfo();
    Services.prefs.savePrefFile(null);
    await IOUtils.writeJSON(PathUtils.join(work, "fixture.json"), fixture, {
      mode: "create",
    });
    Assert.equal(
      (await IOUtils.readJSON(PathUtils.join(work, "fixture.json"))).sourceId,
      database.sourceId
    );
    for (const row of sourceHashes) {
      Assert.equal(
        await IOUtils.computeHexDigest(row.path, "sha256"),
        row.sha256
      );
    }
    complete = true;
    info("S716 retained real profile prepared: " + profile.path);
  } finally {
    try {
      await mail?.close();
    } finally {
      try {
        await journal?.close();
      } finally {
        lock.unlock();
        nativeProfile.remove(false);
        // Keep the successful handoff's intentionally unavailable bodies until
        // the real application case tests recovery, then restores these names.
        if (!complete) {
          for (const { bodyPath, heldPath, bodySHA256 } of held.reverse()) {
            Assert.equal(
              await IOUtils.computeHexDigest(heldPath, "sha256"),
              bodySHA256
            );
            if (await IOUtils.exists(bodyPath)) {
              const placeholder = await IOUtils.stat(bodyPath);
              Assert.equal(placeholder.type, "regular");
              Assert.equal(placeholder.size, 0);
              Assert.equal(
                await IOUtils.computeHexDigest(bodyPath, "sha256"),
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
              );
              await IOUtils.remove(bodyPath, { ignoreAbsent: false });
            }
            await IOUtils.move(heldPath, bodyPath, { noOverwrite: true });
            Assert.equal(
              await IOUtils.computeHexDigest(bodyPath, "sha256"),
              bodySHA256
            );
          }
          for (const { name, hadValue, value } of savedPrefs) {
            if (hadValue) {
              Services.prefs.setBoolPref(name, value);
            } else {
              Services.prefs.clearUserPref(name);
            }
          }
          Services.prefs.savePrefFile(null);
        }
      }
    }
  }
});
