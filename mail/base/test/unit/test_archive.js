/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests that archive folders can be created synchronously and asynchronously.
 */

const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { MessageArchiver } = ChromeUtils.importESModule(
  "resource:///modules/MessageArchiver.sys.mjs"
);

const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);
const { IMAP_RFC3501_handler } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/Imapd.sys.mjs"
);
const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { ServerTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ServerTestUtils.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

add_setup(function setupArchiveBackend() {
  const contract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  Services.prefs.setCharPref("mail.server.default.storeContractID", contract);
  // Account startup registers the selected native database service.
  MailServices.accounts;
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.equal(
    "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
    Services.prefs.getBoolPref("mail.panorama.enabled", false),
    "The archive uses the requested actual database backend"
  );
});

const generator = new MessageGenerator();
const synMessage1 = generator.makeMessage({
  date: new Date(2025, 5, 10, 20, 25),
});
const synMessage2 = generator.makeMessage({
  date: new Date(2023, 3, 1, 21, 25),
});
const synMessage3 = generator.makeMessage({
  date: new Date(2023, 7, 14, 18, 0),
});
const synMessage4 = generator.makeMessage({
  date: new Date(2024, 1, 29, 9, 15),
});

add_task(async function testLocal() {
  const account = MailServices.accounts.createLocalMailAccount();
  account.addIdentity(MailServices.accounts.createIdentity());
  const rootFolder = account.incomingServer.rootFolder;
  rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);

  const sourceFolder1 = rootFolder.createLocalSubfolder("sourceFolder1");
  sourceFolder1.QueryInterface(Ci.nsIMsgLocalMailFolder);

  sourceFolder1.addMessage(synMessage1.toMessageString());
  sourceFolder1.addMessage(synMessage2.toMessageString());
  sourceFolder1.addMessage(synMessage3.toMessageString());

  await subtest(account);
});

add_task(async function testImap() {
  const imapServer = await ServerTestUtils.createServer(
    ServerTestUtils.serverDefs.imap.plain
  );
  imapServer.daemon.createMailbox("sourceFolder1", {
    subscribed: true,
    uidvalidity: 8101,
  });
  // We have to already have an archives folder, or the local folders will be used.
  imapServer.daemon.createMailbox("Archives", {
    flags: ["\\Archive"],
    subscribed: true,
    uidvalidity: 8102,
  });

  const account = MailServices.accounts.createAccount();
  account.addIdentity(MailServices.accounts.createIdentity());
  account.incomingServer = MailServices.accounts.createIncomingServer(
    "user",
    "test.test",
    "imap"
  );
  account.incomingServer.port = 143;
  account.incomingServer.password = "password";
  account.incomingServer.QueryInterface(Ci.nsIImapIncomingServer);

  const rootFolder = account.incomingServer.rootFolder;
  account.incomingServer.performExpand(null);
  const sourceFolder1 = await TestUtils.waitForCondition(() =>
    rootFolder.subFolders.find(folder => folder.name == "sourceFolder1")
  );
  account.incomingServer.subscribeToFolder("sourceFolder1", true);
  const archivesFolder = await TestUtils.waitForCondition(() =>
    rootFolder.subFolders.find(folder => folder.name == "Archives")
  );
  await imapServer.addMessages(archivesFolder, [], true);
  Assert.equal(
    archivesFolder.msgDatabase.dBFolderInfo.imapUidValidity,
    8102,
    "SELECT records the archive mailbox epoch"
  );
  await imapServer.addMessages(
    sourceFolder1,
    [synMessage1, synMessage2, synMessage3],
    true
  );

  Assert.equal(
    sourceFolder1.msgDatabase.dBFolderInfo.imapUidValidity,
    8101,
    "SELECT records the source mailbox epoch"
  );

  await subtest(account);
  await subtestInboxStructure(account, imapServer);
});

async function subtest(account) {
  const rootFolder = account.incomingServer.rootFolder;
  const sourceFolder1 = rootFolder.getChildNamed("sourceFolder1");
  const headers = [...sourceFolder1.messages];
  Assert.equal(headers.length, 3, "The source contains all three real headers");
  const [message1, message2, message3] = headers;

  account.defaultIdentity.archiveGranularity =
    Ci.nsIMsgIdentity.perYearArchiveFolders;

  let deferred = Promise.withResolvers();
  let archiver = new MessageArchiver();
  archiver.oncomplete = deferred.resolve;
  await archiver.archiveMessages([message1]);
  await deferred.promise;
  Assert.equal(sourceFolder1.getTotalMessages(false), 2);

  const archivesFolder = rootFolder.getChildNamed("Archives");
  Assert.ok(archivesFolder.getFlag(Ci.nsMsgFolderFlags.Archive));
  Assert.deepEqual(
    archivesFolder.subFolders.map(f => f.name),
    ["2025"]
  );
  const archives2025Folder = archivesFolder.getChildNamed("2025");
  Assert.equal(archives2025Folder.getTotalMessages(false), 1);

  account.defaultIdentity.archiveGranularity =
    Ci.nsIMsgIdentity.perMonthArchiveFolders;

  deferred = Promise.withResolvers();
  archiver = new MessageArchiver();
  archiver.oncomplete = deferred.resolve;
  await archiver.archiveMessages([message2, message3]);
  await deferred.promise;
  Assert.equal(sourceFolder1.getTotalMessages(false), 0);

  Assert.deepEqual(archivesFolder.subFolders.map(f => f.name).toSorted(), [
    "2023",
    "2025",
  ]);
  const archives2023Folder = archivesFolder.getChildNamed("2023");
  Assert.ok(archives2023Folder);
  Assert.equal(archives2023Folder.getTotalMessages(false), 0);
  Assert.deepEqual(archives2023Folder.subFolders.map(f => f.name).toSorted(), [
    "2023-04",
    "2023-08",
  ]);
  Assert.equal(
    archives2023Folder.getChildNamed("2023-04").getTotalMessages(false),
    1
  );
  Assert.equal(
    archives2023Folder.getChildNamed("2023-08").getTotalMessages(false),
    1
  );
}

/**
 * Archiving with "keep folder structure" and "recreate inbox" enabled should
 * name the recreated folder after the inbox's localized name, not the name it
 * has on the server, which for IMAP is "INBOX".
 */
async function subtestInboxStructure(account, imapServer) {
  const rootFolder = account.incomingServer.rootFolder;
  const inboxFolder = rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
  Assert.equal(inboxFolder.name, "INBOX", "the inbox should be named INBOX");
  Assert.notEqual(
    inboxFolder.localizedName,
    inboxFolder.name,
    "the inbox's localized name should differ from its name"
  );
  await imapServer.addMessages(inboxFolder, [synMessage4], true);

  account.defaultIdentity.archiveGranularity =
    Ci.nsIMsgIdentity.singleArchiveFolder;
  account.defaultIdentity.archiveKeepFolderStructure = true;
  account.defaultIdentity.archiveRecreateInbox = true;

  const deferred = Promise.withResolvers();
  const archiver = new MessageArchiver();
  archiver.oncomplete = deferred.resolve;
  await archiver.archiveMessages([...inboxFolder.messages]);
  await deferred.promise;

  const archivesFolder = rootFolder.getChildNamed("Archives");
  const archivedInboxFolder = archivesFolder.getChildNamed(
    inboxFolder.localizedName
  );
  Assert.ok(archivedInboxFolder, "the archived inbox folder should exist");
  Assert.equal(
    archivedInboxFolder.name,
    inboxFolder.localizedName,
    "the archived inbox folder should use the inbox's localized name"
  );
  Assert.equal(
    archivedInboxFolder.getTotalMessages(false),
    1,
    "the archived inbox folder should contain the archived message"
  );
}

add_task(async function testFilteredEmptyBatch() {
  const server = MailServices.accounts.localFoldersServer;
  const account = MailServices.accounts.findAccountForServer(server);
  const root = server.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  const source = root
    .createLocalSubfolder("filteredArchiveBatch")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const skipped = source.addMessage(
    generator.makeMessage({ date: new Date(2001, 0, 1) }).toMessageString()
  );
  const archived = source.addMessage(
    generator.makeMessage({ date: new Date(2002, 0, 1) }).toMessageString()
  );
  const skippedKey = skipped.messageKey;
  const archivedId = archived.messageId;
  source.orProcessingFlags(skippedKey, Ci.nsMsgProcessingFlags.FilterToMove);
  const identity = account.defaultIdentity;
  const oldGranularity = identity.archiveGranularity;
  identity.archiveGranularity = Ci.nsIMsgIdentity.perYearArchiveFolders;
  const completed = Promise.withResolvers();
  const archiver = new MessageArchiver();
  archiver.oncomplete = completed.resolve;
  try {
    await archiver.archiveMessages([skipped, archived]);
    await completed.promise;
    const archives = root.getChildNamed("Archives");
    Assert.ok(!archives.containsChildNamed("2001"), "Skip the filtered batch");
    const destination = archives.getChildNamed("2002");
    Assert.equal(destination.getTotalMessages(false), 1);
    Assert.equal([...destination.messages][0].messageId, archivedId);
    Assert.deepEqual(
      [...source.messages].map(header => header.messageKey),
      [skippedKey],
      "The pending filter move is not archived again"
    );
  } finally {
    source.andProcessingFlags(
      skippedKey,
      ~Ci.nsMsgProcessingFlags.FilterToMove
    );
    identity.archiveGranularity = oldGranularity;
  }
});

add_task(async function testCompletionCanStartNextArchive() {
  const server = MailServices.accounts.localFoldersServer;
  const account = MailServices.accounts.findAccountForServer(server);
  const root = server.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  const identity = account.defaultIdentity;
  const oldGranularity = identity.archiveGranularity;
  identity.archiveGranularity = Ci.nsIMsgIdentity.perYearArchiveFolders;
  const source = root
    .createLocalSubfolder("reentrantArchiveCompletion")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const first = source.addMessage(
    generator.makeMessage({ date: new Date(2003, 0, 1) }).toMessageString()
  );
  const second = source.addMessage(
    generator.makeMessage({ date: new Date(2004, 0, 1) }).toMessageString()
  );
  const firstId = first.messageId;
  const secondId = second.messageId;
  const completed = Promise.withResolvers();
  let completions = 0;
  const nextArchiver = new MessageArchiver();
  nextArchiver.oncomplete = () => {
    completions++;
    completed.resolve();
  };
  const archiver = new MessageArchiver();
  archiver.oncomplete = () => {
    completions++;
    nextArchiver.archiveMessages([second]).catch(completed.reject);
  };
  try {
    await archiver.archiveMessages([first]);
    await completed.promise;
    Assert.equal(completions, 2, "Each archive completes once");
    Assert.equal(source.getTotalMessages(false), 0);
    const archives = root.getChildNamed("Archives");
    Assert.equal(
      [...archives.getChildNamed("2003").messages][0].messageId,
      firstId
    );
    Assert.equal(
      [...archives.getChildNamed("2004").messages][0].messageId,
      secondId
    );
  } finally {
    identity.archiveGranularity = oldGranularity;
  }
});

add_task(async function testStartupFailureAllowsNextArchive() {
  const { sinon } = ChromeUtils.importESModule(
    "resource://testing-common/Sinon.sys.mjs"
  );
  const { MailUtils } = ChromeUtils.importESModule(
    "resource:///modules/MailUtils.sys.mjs"
  );
  const root =
    MailServices.accounts.localFoldersServer.rootFolder.QueryInterface(
      Ci.nsIMsgLocalMailFolder
    );
  const source = root
    .createLocalSubfolder("archiveStartupFailure")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const message = source.addMessage(generator.makeMessage().toMessageString());
  const messageKey = message.messageKey;
  const messageId = message.messageId;
  const identityStub = sinon.stub(MailUtils, "getIdentityForHeader").returns([
    {
      archiveEnabled: true,
      async getOrCreateArchivesFolderAsync() {
        throw new Error("Archive folder creation failed");
      },
    },
  ]);
  let completions = 0;
  const failedArchiver = new MessageArchiver();
  failedArchiver.oncomplete = () => completions++;
  try {
    await Assert.rejects(
      failedArchiver.archiveMessages([message]),
      /Archive folder creation failed/
    );
    Assert.equal(
      completions,
      0,
      "Startup failure is not successful completion"
    );
    Assert.ok(source.msgDatabase.containsKey(messageKey));
    Assert.equal(source.GetMessageHeader(messageKey).messageId, messageId);
  } finally {
    identityStub.restore();
  }

  const completed = Promise.withResolvers();
  const archiver = new MessageArchiver();
  archiver.oncomplete = () => {
    completions++;
    completed.resolve();
  };
  await archiver.archiveMessages([message]);
  await completed.promise;
  Assert.equal(completions, 1);
  Assert.equal(source.getTotalMessages(false), 0);
});

/**
 * Create a real IMAP account with a selected physical mailbox for archiving.
 *
 * @param {string} username - Unique account and fake-server login.
 * @param {string} mailbox - Existing mailbox to SELECT.
 * @param {number} epoch - Positive mailbox UIDVALIDITY.
 * @returns {Promise<{account: nsIMsgAccount, folder: nsIMsgFolder,
 *   server: import("resource://testing-common/mailnews/IMAPServer.sys.mjs").IMAPServer}>} The account, selected folder and real test server.
 */
async function createArchiveAccount(username, mailbox, epoch) {
  const server = await ServerTestUtils.createServer({
    type: "imap",
    options: { username },
  });
  server.daemon.createMailbox(mailbox, {
    subscribed: true,
    uidvalidity: epoch,
    flags: mailbox == "Archives" ? ["\\Archive"] : [],
  });
  const account = MailServices.accounts.createAccount();
  const incoming = MailServices.accounts.createIncomingServer(
    username,
    "localhost",
    "imap"
  );
  incoming.port = server.port;
  incoming.password = "password";
  account.incomingServer = incoming;
  const identity = MailServices.accounts.createIdentity();
  identity.email = `${username}@example.invalid`;
  account.addIdentity(identity);
  registerCleanupFunction(() => {
    incoming.shutdown();
    MailServices.accounts.removeAccount(account, false);
  });
  const contract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  Assert.equal(incoming.getStringValue("storeContractID"), contract);
  const root = incoming.rootFolder;
  const discovered = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(root, discovered, null);
  await discovered.promise;
  const folder = root.getChildNamed(mailbox);
  await server.addMessages(folder, [], true);
  Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, epoch);
  return { account, folder, server };
}

add_task(async function testCrossServerArchiveFailureAndRetry() {
  const proto = IMAP_RFC3501_handler.prototype;
  const originalAppend = proto.APPEND;
  const originalCreate = proto.CREATE;
  let targetDaemon;
  let rejectedCommand;
  let refusals = 0;
  proto.APPEND = function (args) {
    if (this._daemon == targetDaemon && rejectedCommand == "APPEND") {
      refusals++;
      return "NO refused archive APPEND";
    }
    return originalAppend.call(this, args);
  };
  proto.CREATE = function (args) {
    if (this._daemon == targetDaemon && rejectedCommand == "CREATE") {
      refusals++;
      return "NO refused archive CREATE";
    }
    return originalCreate.call(this, args);
  };
  registerCleanupFunction(() => {
    proto.APPEND = originalAppend;
    proto.CREATE = originalCreate;
  });
  const source = await createArchiveAccount("archiveSource", "source", 7301);
  const destination = await createArchiveAccount(
    "archiveDestination",
    "Archives",
    8401
  );
  targetDaemon = destination.server.daemon;
  const identity = source.account.defaultIdentity;
  identity.archivesFolderURI = destination.folder.URI;
  identity.archiveEnabled = true;
  const messages = [2030, 2031].map(year =>
    generator.makeMessage({
      date: new Date(year, 0, 1),
      to: [["Archive source", identity.email]],
      body: {
        body: `<body bgcolor="#ffffff">${"line%25? #ffffff ".repeat(1400)}</body>\r\n`,
      },
    })
  );
  await source.server.addMessages(source.folder, messages, true);
  const headers = [...source.folder.messages];
  Assert.equal(headers.length, 2, "Two actual source headers exist");
  for (const [index, command] of ["APPEND", "CREATE"].entries()) {
    const header = headers[index];
    const key = header.messageKey;
    const messageId = header.messageId;
    const sourceURI = source.folder.getUriForMsg(header);
    identity.archiveGranularity =
      command == "CREATE"
        ? Ci.nsIMsgIdentity.perYearArchiveFolders
        : Ci.nsIMsgIdentity.singleArchiveFolder;
    rejectedCommand = command;
    let completions = 0;
    let done = Promise.withResolvers();
    let archiver = new MessageArchiver();
    archiver.oncomplete = status => {
      completions++;
      done.resolve(status);
    };
    await archiver.archiveMessages([header]);
    const status = await done.promise;
    Assert.ok(
      !Components.isSuccessCode(status),
      "The real protocol refusal is returned"
    );
    Assert.equal(completions, 1, "A failed archive completes once");
    Assert.equal(refusals, index + 1, "The intended wire command was refused");
    Assert.equal(source.folder.getTotalMessages(false), 2 - index);
    Assert.equal(source.folder.GetMessageHeader(key).messageId, messageId);
    Assert.equal(
      source.folder.getUriForMsg(source.folder.GetMessageHeader(key)),
      sourceURI
    );
    Assert.equal(destination.folder.getTotalMessages(true), index);
    rejectedCommand = null;
    done = Promise.withResolvers();
    archiver = new MessageArchiver();
    archiver.oncomplete = result => {
      completions++;
      done.resolve(result);
    };
    await archiver.archiveMessages([source.folder.GetMessageHeader(key)]);
    Assert.ok(
      Components.isSuccessCode(await done.promise),
      "A fresh real retry succeeds"
    );
    Assert.equal(completions, 2, "The retry completes once");
    Assert.equal(source.folder.getTotalMessages(false), 1 - index);
    const target =
      command == "CREATE"
        ? destination.folder.getChildNamed("2031")
        : destination.folder;
    const archived = [...target.messages];
    Assert.equal(archived.length, 1);
    Assert.equal(archived[0].messageId, messageId);
    Assert.equal(archived[0].folder.URI, target.URI);
    const remote = targetDaemon.getMailbox(
      command == "CREATE" ? "Archives/2031" : "Archives"
    );
    Assert.equal(remote._messages.length, 1);
    Assert.equal(
      remote._messages[0].getText(),
      messages[index].toMessageString(),
      "The complete archived bytes, including long #/% lines, survive APPEND and readback"
    );
  }
});
