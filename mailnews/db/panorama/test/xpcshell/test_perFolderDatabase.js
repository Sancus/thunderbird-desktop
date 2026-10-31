/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests the new database's implementation of the old database's interfaces.
 */

const { ProfileCreator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ProfileCreator.sys.mjs"
);

let rootFolder;

/**
 * Checks the stored word separately from the public header status.
 *
 * @param {nsIMsgDBHdr} header - The published header to check.
 * @param {number} rawFlags - Exact stored flags, including unknown bits.
 * @param {number} publicFlags - Exact flags exposed by the current facade.
 */
function assertRawAndPublicFlags(header, rawFlags, publicFlags) {
  const statement = database.connectionForTests.createStatement(
    "SELECT flags FROM messages WHERE id = :key"
  );
  try {
    statement.params.key = header.messageKey;
    Assert.ok(statement.executeStep());
    Assert.equal(statement.getInt64(0) >>> 0, rawFlags >>> 0, "raw SQL flags");
    Assert.ok(!statement.executeStep());
  } finally {
    statement.finalize();
  }
  Assert.equal(header.flags, publicFlags >>> 0, "public status flags");
}

add_setup(async function () {
  // The independent fixture messages are standalone native thread roots.
  installDB(
    (await IOUtils.readUTF8(do_get_file("db/messages.sql").path)) +
      "\nUPDATE messages SET threadId = id, threadParent = 0;"
  );
  const profile = new ProfileCreator(do_get_profile());
  const server = profile.addLocalServer();
  server.isMaildirStore = false;
  await server.rootFolder.addMailFolder("folderA");
  await server.rootFolder.addMailFolder("folderB");
  await server.rootFolder.addMailFolder("folderC");

  MailServices.accounts.accounts;
  const localServer = MailServices.accounts.localFoldersServer;
  Assert.equal(localServer.key, "server1");
  rootFolder = localServer.rootFolder;
  Assert.strictEqual(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"]
      .getService(Ci.nsIMsgDBService)
      .QueryInterface(Ci.nsIDatabaseCore),
    database
  );
  Assert.equal(rootFolder.msgStore.storeType, "mbox");
  Assert.equal(
    localServer.getStringValue("storeContractID"),
    "@mozilla.org/msgstore/berkeleystore;1"
  );
});

add_task(async function testFolderMethods() {
  const folderA = MailServices.folderLookup.getFolderForURL(
    rootFolder.URI + "/folderA"
  );
  Assert.ok(folderA.filePath.path);

  const folderDatabase = database.openFolderDB(folderA, false);
  Assert.ok(folderDatabase);
  Assert.equal(folderA.msgDatabase, folderDatabase);
  Assert.deepEqual(folderDatabase.listAllKeys(), [1, 2, 3, 4]);
  Assert.ok(!folderDatabase.containsKey(0));
  Assert.ok(folderDatabase.containsKey(1));
  Assert.ok(folderDatabase.containsKey(4));
  Assert.ok(!folderDatabase.containsKey(5));

  // Test getting a message header.
  let header = folderDatabase.getMsgHdrForKey(2);
  Assert.equal(header.messageKey, 2);
  Assert.equal(header.folder, folderA);
  Assert.equal(header.date, new Date("2019-09-14T00:00:00Z").valueOf() * 1000);
  Assert.equal(header.author, '"Lydia Rau" <lydia@rau.invalid>');
  Assert.equal(header.subject, "Networked even-keeled forecast");
  Assert.equal(header.flags, 0);

  Assert.throws(
    () => folderDatabase.getMsgHdrForKey(5),
    /NS_ERROR_ILLEGAL_VALUE/,
    "message from a different folder should not be returned"
  );

  header = folderDatabase.getMsgHdrForMessageID("message4@invalid");
  Assert.equal(header.messageKey, 4);
  Assert.equal(header.folder, folderA);
  Assert.equal(header.date, new Date("2019-11-03T12:34:56Z").valueOf() * 1000);
  Assert.equal(header.author, '"Eliseo Bauch" <eliseo@bauch.invalid>');
  Assert.equal(header.subject, "Proactive intermediate collaboration");
  Assert.equal(header.flags, Ci.nsMsgMessageFlags.Marked);

  Assert.throws(
    () => folderDatabase.getMsgHdrForMessageID("message7@invalid"),
    /NS_ERROR_ILLEGAL_VALUE/,
    "message from a different folder should not be returned"
  );

  // Test getting and changing message flags.
  Assert.ok(!folderDatabase.isRead(4));
  Assert.ok(!folderDatabase.isIgnored(4));
  Assert.ok(!folderDatabase.isWatched(4));
  Assert.ok(folderDatabase.isMarked(4));
  Assert.ok(!folderDatabase.hasAttachments(4));
  Assert.ok(!folderDatabase.isMDNSent(4));
  folderDatabase.markNotNew(4, null);
  folderDatabase.markMDNNeeded(4, true, null);
  folderDatabase.markMDNSent(4, true, null);
  Assert.ok(folderDatabase.isMDNSent(4));
  folderDatabase.markRead(4, false, null);
  Assert.ok(!folderDatabase.isRead(4));
  folderDatabase.markMarked(4, false, null);
  Assert.ok(!folderDatabase.isMarked(4));
  folderDatabase.markReplied(4, true, null);
  folderDatabase.markForwarded(4, true, null);
  folderDatabase.markRedirected(4, true, null);
  folderDatabase.markHasAttachments(4, true, null);
  Assert.ok(folderDatabase.hasAttachments(4));
  folderDatabase.markOffline(4, true, null);
  folderDatabase.markImapDeleted(4, true, null);
  folderDatabase.markKilled(4, true, null);

  header = folderDatabase.getMsgHdrForKey(4);
  Assert.equal(
    header.flags,
    Ci.nsMsgMessageFlags.MDNReportNeeded |
      Ci.nsMsgMessageFlags.MDNReportSent |
      Ci.nsMsgMessageFlags.Replied |
      Ci.nsMsgMessageFlags.Forwarded |
      Ci.nsMsgMessageFlags.Redirected |
      Ci.nsMsgMessageFlags.Attachment |
      Ci.nsMsgMessageFlags.Offline |
      Ci.nsMsgMessageFlags.IMAPDeleted |
      Ci.nsMsgMessageFlags.Ignored
  );

  folderDatabase.markMDNNeeded(4, false, null);
  folderDatabase.markMDNSent(4, false, null);
  Assert.ok(!folderDatabase.isMDNSent(4));
  folderDatabase.markRead(4, true, null);
  Assert.ok(folderDatabase.isRead(4));
  folderDatabase.markMarked(4, true, null);
  Assert.ok(folderDatabase.isMarked(4));
  folderDatabase.markReplied(4, false, null);
  folderDatabase.markForwarded(4, false, null);
  folderDatabase.markRedirected(4, false, null);
  folderDatabase.markHasAttachments(4, false, null);
  Assert.ok(!folderDatabase.hasAttachments(4));
  folderDatabase.markOffline(4, false, null);
  folderDatabase.markImapDeleted(4, false, null);
  folderDatabase.markKilled(4, false, null);
  header = folderDatabase.getMsgHdrForKey(4);
  Assert.equal(
    header.flags,
    Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked
  );

  // Test enumerateMessages and reverseEnumerateMessages. Do this twice to
  // make sure we get a fresh enumerator the second time.
  Assert.deepEqual(
    Array.from(folderDatabase.enumerateMessages(), m => m.messageKey),
    [1, 2, 3, 4]
  );
  Assert.deepEqual(
    Array.from(folderDatabase.enumerateMessages(), m => m.subject),
    [
      "Fundamental empowering pricing structure",
      "Networked even-keeled forecast",
      "Streamlined bandwidth-monitored help-desk",
      "Proactive intermediate collaboration",
    ]
  );

  Assert.deepEqual(
    Array.from(folderDatabase.reverseEnumerateMessages(), m => m.messageKey),
    [4, 3, 2, 1]
  );
  Assert.deepEqual(
    Array.from(folderDatabase.reverseEnumerateMessages(), m => m.subject),
    [
      "Proactive intermediate collaboration",
      "Streamlined bandwidth-monitored help-desk",
      "Networked even-keeled forecast",
      "Fundamental empowering pricing structure",
    ]
  );

  // Test marking all messages as read.
  Assert.ok(!folderDatabase.isRead(1));
  Assert.ok(!folderDatabase.isRead(2));
  Assert.ok(folderDatabase.isRead(3));
  Assert.ok(folderDatabase.isRead(4));
  Assert.deepEqual(folderDatabase.markAllRead(), [1, 2]);
  Assert.ok(folderDatabase.isRead(1));
  Assert.ok(folderDatabase.isRead(2));
  Assert.ok(folderDatabase.isRead(3));
  Assert.ok(folderDatabase.isRead(4));

  // Test the new messages list.
  Assert.ok(!folderDatabase.hasNew());
  Assert.equal(folderDatabase.firstNew, 0xffffffff); // nsMsgKey_None
  folderDatabase.addToNewList(2);
  Assert.ok(folderDatabase.hasNew());
  Assert.equal(folderDatabase.firstNew, 2);
  Assert.deepEqual(folderDatabase.getNewList(), [2]);
  folderDatabase.addToNewList(2);
  Assert.deepEqual(folderDatabase.getNewList(), [2]);
  folderDatabase.addToNewList(3);
  Assert.deepEqual(folderDatabase.getNewList(), [2, 3]);
  folderDatabase.markNotNew(2, null);
  Assert.deepEqual(folderDatabase.getNewList(), [3]);
  folderDatabase.markNotNew(2, null);
  Assert.deepEqual(folderDatabase.getNewList(), [3]);

  // Reset unread messages.
  folderDatabase.markRead(3, false, null);
  folderDatabase.markRead(4, false, null);
});

add_task(async function testFolderInfo() {
  const folderA = MailServices.folderLookup.getFolderForURL(
    rootFolder.URI + "/folderA"
  );
  const folderDatabase = database.openFolderDB(folderA, false);
  const folderInfo = folderDatabase.dBFolderInfo;
  Assert.ok(folderInfo);
  Assert.equal(folderInfo.folderName, "folderA");

  Assert.equal(folderInfo.flags, 0);

  folderInfo.flags = Ci.nsMsgFolderFlags.Mail | Ci.nsMsgFolderFlags.Inbox;
  Assert.equal(
    folderInfo.flags,
    Ci.nsMsgFolderFlags.Mail | Ci.nsMsgFolderFlags.Inbox
  );

  Assert.equal(
    folderInfo.andFlags(Ci.nsMsgFolderFlags.Mail),
    Ci.nsMsgFolderFlags.Mail
  );
  Assert.equal(folderInfo.flags, Ci.nsMsgFolderFlags.Mail);

  // Physical folders count rows; virtual folders use search summaries.
  Assert.equal(folderInfo.numMessages, 4);
  Assert.equal(folderA.getTotalMessages(false), 4);
  Assert.equal(folderInfo.numUnreadMessages, 2);
  Assert.equal(folderA.getNumUnread(false), 2);

  Assert.equal(
    folderInfo.orFlags(Ci.nsMsgFolderFlags.Virtual),
    Ci.nsMsgFolderFlags.Mail | Ci.nsMsgFolderFlags.Virtual
  );
  Assert.equal(
    folderInfo.flags,
    Ci.nsMsgFolderFlags.Mail | Ci.nsMsgFolderFlags.Virtual
  );
});

add_task(async function testFolderProperties() {
  const folderB = MailServices.folderLookup.getFolderForURL(
    rootFolder.URI + "/folderB"
  );

  const folderDatabase = database.openFolderDB(folderB, false);
  const folderInfo = folderDatabase.dBFolderInfo;

  function readProperties(operator) {
    const stmt = database.connectionForTests.createStatement(
      `SELECT id, name, value FROM folder_properties
       WHERE id ${operator} :id ORDER BY id, name`
    );
    stmt.params.id = folderB.id;
    const properties = [];
    try {
      while (stmt.executeStep()) {
        properties.push([stmt.row.id, stmt.row.name, stmt.row.value]);
      }
    } finally {
      stmt.finalize();
    }
    return properties;
  }

  const unrelatedProperties = readProperties("!=");
  for (const mailbox of ["Trash", "Unsent Messages"]) {
    Assert.ok(
      unrelatedProperties.some(
        ([, name, value]) => name == "mailboxName" && value == mailbox
      ),
      `the account's ${mailbox} metadata is present`
    );
  }

  Assert.equal(folderInfo.getProperty("wibble"), "");
  folderInfo.setProperty("wibble", "wobble");
  Assert.equal(folderInfo.getProperty("wibble"), "wobble");
  folderInfo.setProperty("wibble", "");
  Assert.equal(folderInfo.getProperty("wibble"), "");

  Assert.equal(folderInfo.getCharProperty("hack"), "");
  folderInfo.setCharProperty("hack", "splat");
  Assert.equal(folderInfo.getCharProperty("hack"), "splat");
  folderInfo.setCharProperty("hack", "");
  Assert.equal(folderInfo.getCharProperty("hack"), "");

  Assert.equal(folderInfo.getUint32Property("answer", 3), 3);
  folderInfo.setUint32Property("answer", 42);
  Assert.equal(folderInfo.getUint32Property("answer", 3), 42);

  Assert.equal(folderInfo.getInt64Property("days", -1), -1);
  folderInfo.setInt64Property("days", 365);
  Assert.equal(folderInfo.getInt64Property("days", -1), 365);

  Assert.equal(folderInfo.getBooleanProperty("yes?", true), true);
  folderInfo.setBooleanProperty("yes?", false);
  Assert.equal(folderInfo.getBooleanProperty("yes?", true), false);

  Assert.equal(folderInfo.getBooleanProperty("no!", false), false);
  folderInfo.setBooleanProperty("no!", true);
  Assert.equal(folderInfo.getBooleanProperty("no!", false), true);

  // Empty text and numeric zero remain present in the physical folder.
  Assert.deepEqual(readProperties("="), [
    [folderB.id, "answer", 42],
    [folderB.id, "days", 365],
    [folderB.id, "hack", ""],
    [folderB.id, "no!", 1],
    [folderB.id, "wibble", ""],
    [folderB.id, "yes?", 0],
  ]);
  Assert.deepEqual(
    readProperties("!="),
    unrelatedProperties,
    "properties on the account's other folders are unchanged"
  );
});

add_task(async function testHeaderMethods() {
  const folderC = MailServices.folderLookup.getFolderForURL(
    rootFolder.URI + "/folderC"
  );
  Assert.ok(folderC.filePath.path);

  const folderDatabase = database.openFolderDB(folderC, false);
  Assert.ok(folderDatabase);
  Assert.equal(folderC.msgDatabase, folderDatabase);

  let header = folderDatabase.getMsgHdrForKey(7);
  Assert.equal(header.folder, folderC);
  Assert.equal(header.flags, 0);
  Assert.ok(!header.isRead);
  Assert.ok(!header.isFlagged);
  Assert.ok(!header.isKilled);

  header.flags = Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked;
  Assert.equal(
    header.flags,
    Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked
  );
  Assert.ok(header.isRead);
  Assert.ok(header.isFlagged);
  Assert.ok(!header.isKilled);

  Assert.equal(
    header.andFlags(~Ci.nsMsgMessageFlags.Marked),
    Ci.nsMsgMessageFlags.Read
  );
  Assert.equal(
    header.orFlags(Ci.nsMsgMessageFlags.Ignored),
    Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Ignored
  );

  header = folderDatabase.getMsgHdrForKey(7);
  Assert.equal(
    header.flags,
    Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Ignored
  );

  header.markRead(false);
  Assert.ok(!header.isRead);
  header.markFlagged(true);
  Assert.ok(header.isFlagged);
  header.markHasAttachments(true);
  Assert.equal(
    header.flags,
    Ci.nsMsgMessageFlags.Marked |
      Ci.nsMsgMessageFlags.Ignored |
      Ci.nsMsgMessageFlags.Attachment
  );
});

add_task(async function testHeaderProperties() {
  const folderC = MailServices.folderLookup.getFolderForURL(
    rootFolder.URI + "/folderC"
  );

  const folderDatabase = database.openFolderDB(folderC, false);
  const header = folderDatabase.getMsgHdrForKey(7);

  Assert.equal(header.getStringProperty("hack"), "");
  header.setStringProperty("hack", "splat");
  Assert.equal(header.getStringProperty("hack"), "splat");
  header.setStringProperty("hack", "");
  Assert.equal(header.getStringProperty("hack"), "");

  Assert.equal(header.getUint32Property("answer"), 0);
  header.setUint32Property("answer", 42);
  Assert.equal(header.getUint32Property("answer"), 42);

  Assert.equal(header.storeToken, "");
  header.storeToken = "12345678";
  Assert.equal(header.storeToken, "12345678");

  Assert.equal(header.messageSize, 0);
  header.messageSize = 500;
  Assert.equal(header.messageSize, 500);

  Assert.deepEqual(header.properties.toSorted(), [
    "answer",
    "hack",
    "messageSize",
    "storeToken",
  ]);

  // Check the database has a record of the properties.
  // TODO: Should we remove properties set to an empty string or 0?

  const stmt = database.connectionForTests.createStatement(
    "SELECT id, name, typeof(value) AS type, value FROM message_properties " +
      "WHERE id = :id ORDER BY name"
  );
  stmt.params.id = header.messageKey;
  const properties = [];
  while (stmt.executeStep()) {
    properties.push([
      stmt.row.id,
      stmt.row.name,
      stmt.row.type,
      stmt.row.value,
    ]);
  }
  stmt.finalize();

  Assert.deepEqual(properties, [
    [header.messageKey, "answer", "text", "2a"],
    [header.messageKey, "hack", "text", ""],
    [header.messageKey, "messageSize", "integer", 500],
    [header.messageKey, "storeToken", "text", "12345678"],
  ]);
});

add_task(async function testListener() {
  class FolderListener {
    QueryInterface = ChromeUtils.generateQI(["nsIDBChangeListener"]);
    reset() {
      this._headerAdded = null;
      this._headerRemoved = null;
      this._headerChanged = null;
    }
    onHdrFlagsChanged(hdrChanged, oldFlags, newFlags, instigator) {
      this._headerChanged = [hdrChanged, oldFlags, newFlags, instigator];
    }
    onHdrDeleted(hdrChanged, parentKey, flags, instigator) {
      this._headerRemoved = [hdrChanged, parentKey, flags, instigator];
    }
    onHdrAdded(hdrChanged, parentKey, flags, instigator) {
      this._headerAdded = [hdrChanged, parentKey, flags, instigator];
    }
    onParentChanged(_keyChanged, _oldParent, _newParent, _instigator) {
      Assert.ok(false, "unexpected onParentChanged event");
    }
    onAnnouncerGoingAway(_instigator) {
      Assert.ok(false, "unexpected onAnnouncerGoingAway event");
    }
    onReadChanged(_instigator) {
      Assert.ok(false, "unexpected onReadChanged event");
    }
    onJunkScoreChanged(_instigator) {
      Assert.ok(false, "unexpected onJunkScoreChanged event");
    }
    onHdrPropertyChanged(
      _hdrToChange,
      _property,
      _preChange,
      _status,
      _instigator
    ) {
      Assert.ok(false, "unexpected onHdrPropertyChanged event");
    }
    onEvent(_db, _event) {
      Assert.ok(false, "unexpected onEvent event");
    }
  }

  const listenerB = new FolderListener();
  const folderB = MailServices.folderLookup.getFolderForURL(
    rootFolder.URI + "/folderB"
  );
  const folderDatabaseB = database.openFolderDB(folderB, false);
  folderDatabaseB.addListener(listenerB);
  registerCleanupFunction(() => folderDatabaseB.removeListener(listenerB));

  const listenerC = new FolderListener();
  const folderC = MailServices.folderLookup.getFolderForURL(
    rootFolder.URI + "/folderC"
  );
  const folderDatabaseC = database.openFolderDB(folderC, false);
  folderDatabaseC.addListener(listenerC);
  registerCleanupFunction(() => folderDatabaseC.removeListener(listenerC));

  const addedId = addMessage({ folderId: folderC.id });
  Assert.ok(!listenerB._headerAdded);
  Assert.ok(!listenerB._headerRemoved);
  Assert.ok(!listenerB._headerChanged);
  Assert.ok(listenerC._headerAdded);
  Assert.ok(!listenerC._headerRemoved);
  Assert.ok(!listenerC._headerChanged);

  const [headerAdded] = listenerC._headerAdded;
  Assert.ok(headerAdded instanceof Ci.nsIMsgDBHdr);
  Assert.equal(headerAdded.messageKey, addedId);
  Assert.equal(headerAdded.folder, folderC);
  Assert.equal(headerAdded.messageId, "messageId");
  Assert.equal(headerAdded.date, new Date("2025-01-22").valueOf() * 1000);
  Assert.equal(headerAdded.author, "sender");
  Assert.equal(headerAdded.subject, "subject");
  Assert.equal(headerAdded.flags, Ci.nsMsgMessageFlags.New);
  Assert.equal(headerAdded.getStringProperty("keywords"), "");

  listenerC.reset();
  headerAdded.markRead(true);
  Assert.ok(!listenerB._headerAdded);
  Assert.ok(!listenerB._headerRemoved);
  Assert.ok(!listenerB._headerChanged);
  Assert.ok(!listenerC._headerAdded);
  Assert.ok(!listenerC._headerRemoved);
  Assert.ok(listenerC._headerChanged);

  const [headerChanged, oldFlags, newFlags] = listenerC._headerChanged;
  Assert.ok(headerChanged instanceof Ci.nsIMsgDBHdr);
  Assert.equal(headerChanged.messageKey, addedId);
  Assert.equal(headerChanged.folder, folderC);
  Assert.equal(headerChanged.messageId, "messageId");
  Assert.equal(headerChanged.date, new Date("2025-01-22").valueOf() * 1000);
  Assert.equal(headerChanged.author, "sender");
  Assert.equal(headerChanged.subject, "subject");
  Assert.equal(
    headerChanged.flags,
    Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.New
  );
  Assert.equal(headerChanged.getStringProperty("keywords"), "");
  Assert.equal(oldFlags, Ci.nsMsgMessageFlags.New);
  Assert.equal(newFlags, Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.New);

  listenerC.reset();
  messageDB.removeMessage(headerAdded.messageKey);
  Assert.ok(!listenerB._headerAdded);
  Assert.ok(!listenerB._headerRemoved);
  Assert.ok(!listenerB._headerChanged);
  Assert.ok(!listenerC._headerAdded);
  Assert.ok(listenerC._headerRemoved);
  Assert.ok(!listenerC._headerChanged);

  const [headerRemoved] = listenerC._headerRemoved;
  Assert.ok(headerRemoved instanceof Ci.nsIMsgDBHdr);
  Assert.equal(headerRemoved.messageKey, addedId);
  Assert.equal(headerRemoved.folder, folderC);
  Assert.equal(headerRemoved.messageId, "messageId");
  Assert.equal(headerRemoved.date, new Date("2025-01-22").valueOf() * 1000);
  Assert.equal(headerRemoved.author, "sender");
  Assert.equal(headerRemoved.subject, "subject");
  Assert.equal(
    headerRemoved.flags,
    Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.New
  );
  // TODO
  //Assert.equal(headerRemoved.getStringProperty("keywords"), "");
});

add_task(function test_syncCountsUsesPhysicalMembership() {
  const root = rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  const folder = root.createLocalSubfolder("physical-counts");
  const other = root.createLocalSubfolder("other-counts");
  const db = folder.msgDatabase;
  const info = db.dBFolderInfo;
  const unread = addMessage({ folderId: folder.id, messageId: "count-unread" });
  const removed = addMessage({
    folderId: folder.id,
    messageId: "count-remove",
  });
  addMessage({
    folderId: folder.id,
    messageId: "count-read",
    flags: Ci.nsMsgMessageFlags.Read,
  });
  addMessage({ folderId: other.id, messageId: "count-other" });
  const unpublished = db.createNewHdr();
  unpublished.messageId = "count-unpublished";
  info.setUint32Property("numMsgs", 900);
  info.setUint32Property("numNewMsgs", 800);
  info.imapTotalPendingMessages = 10;
  info.imapUnreadPendingMessages = 9;

  const events = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrAdded: () => events.push("added"),
    onHdrDeleted: () => events.push("deleted"),
    onHdrFlagsChanged: () => events.push("flags"),
    onParentChanged: () => events.push("parent"),
    onAnnouncerGoingAway: () => events.push("goingAway"),
    onReadChanged: () => events.push("read"),
    onJunkScoreChanged: () => events.push("junk"),
    onHdrPropertyChanged: () => events.push("property"),
    onEvent: () => events.push("event"),
  };
  db.addListener(listener);
  try {
    db.syncCounts();
    Assert.equal(info.numMessages, 3);
    Assert.equal(info.numUnreadMessages, 2);
    Assert.equal(info.getUint32Property("numMsgs", 0), 900);
    Assert.equal(info.getUint32Property("numNewMsgs", 0), 800);
    Assert.equal(info.imapTotalPendingMessages, 10);
    Assert.equal(info.imapUnreadPendingMessages, 9);
    Assert.deepEqual(events, [], "reconciliation emits no fabricated changes");
  } finally {
    db.removeListener(listener);
  }

  db.markRead(unread, true, null);
  messageDB.removeMessage(removed);
  db.syncCounts();
  Assert.equal(info.numMessages, 2);
  Assert.equal(info.numUnreadMessages, 0);
  Assert.equal(other.msgDatabase.dBFolderInfo.numMessages, 1);
  Assert.equal(other.msgDatabase.dBFolderInfo.numUnreadMessages, 1);
  Assert.throws(() => (info.numMessages = 50), /NS_ERROR_NOT_IMPLEMENTED/);
  Assert.throws(
    () => info.changeNumUnreadMessages(1),
    /NS_ERROR_NOT_IMPLEMENTED/
  );
  Assert.equal(info.numMessages, 2);
  Assert.equal(info.numUnreadMessages, 0);
});

add_task(function test_virtualCountSummariesAndCheckedDeltas() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("virtual-counts");
  const db = folder.msgDatabase;
  const info = db.dBFolderInfo;
  info.orFlags(Ci.nsMsgFolderFlags.Virtual);
  Assert.equal(info.numMessages, 0);
  Assert.equal(info.numUnreadMessages, 0);
  db.syncCounts();
  info.numMessages = 7;
  info.numUnreadMessages = 3;
  info.changeNumMessages(2);
  info.changeNumUnreadMessages(-4);
  Assert.equal(info.numMessages, 9);
  Assert.equal(info.numUnreadMessages, 0);
  db.syncCounts();
  Assert.equal(
    info.numMessages,
    9,
    "sync retains the completed search summary"
  );
  Assert.deepEqual(db.listAllKeys(), [], "summary counts create no membership");

  info.numMessages = 0x7fffffff;
  Assert.throws(
    () => info.changeNumMessages(1),
    /NS_ERROR_LOSS_OF_SIGNIFICANT_DATA/
  );
  Assert.equal(info.numMessages, 0x7fffffff);
  info.setUint32Property("numNewMsgs", 0x80000000);
  Assert.throws(() => db.syncCounts(), /NS_ERROR_LOSS_OF_SIGNIFICANT_DATA/);
  Assert.equal(info.getUint32Property("numNewMsgs", 0), 0x80000000);
});

add_task(function test_pendingCountsKeepSignedBitsAndPresence() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("pending-values");
  const info = folder.msgDatabase.dBFolderInfo;
  const statement = database.connectionForTests.createStatement(
    "SELECT name, typeof(value) AS type, value FROM folder_properties " +
      "WHERE id = :id AND name IN ('totPendingMsgs', 'unreadPendingMsgs') " +
      "ORDER BY name"
  );
  try {
    Assert.equal(info.imapTotalPendingMessages, 0);
    Assert.equal(info.imapUnreadPendingMessages, 0);
    statement.params.id = folder.id;
    Assert.ok(
      !statement.executeStep(),
      "default reads do not create properties"
    );
    statement.reset();
    for (const [attribute, property] of [
      ["imapTotalPendingMessages", "totPendingMsgs"],
      ["imapUnreadPendingMessages", "unreadPendingMsgs"],
    ]) {
      for (const value of [-2147483648, -1, 2147483647, 0]) {
        info[attribute] = value;
        Assert.equal(folder.msgDatabase.dBFolderInfo[attribute], value);
        Assert.equal(info.getUint32Property(property, 99), value >>> 0);
      }
    }
    statement.params.id = folder.id;
    const rows = [];
    while (statement.executeStep()) {
      rows.push([statement.row.name, statement.row.type, statement.row.value]);
    }
    Assert.deepEqual(rows, [
      ["totPendingMsgs", "integer", 0],
      ["unreadPendingMsgs", "integer", 0],
    ]);
  } finally {
    statement.finalize();
  }
  Assert.equal(info.numMessages, 0);
  Assert.equal(info.numUnreadMessages, 0);
  folder.changeNumPendingTotalMessages(3);
  folder.changeNumPendingUnread(2);
  Assert.equal(info.imapTotalPendingMessages, 3);
  Assert.equal(info.imapUnreadPendingMessages, 2);
  folder.changeNumPendingTotalMessages(-1);
  folder.changeNumPendingUnread(-1);
  Assert.equal(info.imapTotalPendingMessages, 2);
  Assert.equal(info.imapUnreadPendingMessages, 1);
  Assert.deepEqual(folder.msgDatabase.listAllKeys(), []);
});

add_task(function test_pendingCountErrorsPreserveStoredValues() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("pending-errors");
  const info = folder.msgDatabase.dBFolderInfo;
  info.imapTotalPendingMessages = 7;
  info.imapUnreadPendingMessages = 5;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_pending_count BEFORE INSERT ON folder_properties " +
      `WHEN NEW.id = ${folder.id} AND ` +
      "NEW.name IN ('totPendingMsgs', 'unreadPendingMsgs') " +
      "BEGIN SELECT RAISE(ABORT, 'pending count fault'); END"
  );
  try {
    Assert.throws(
      () => (info.imapTotalPendingMessages = 9),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.throws(
      () => (info.imapUnreadPendingMessages = 9),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.equal(info.imapTotalPendingMessages, 7);
    Assert.equal(info.imapUnreadPendingMessages, 5);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_pending_count");
  }
  connection.beginTransaction();
  try {
    info.imapTotalPendingMessages = -3;
    info.imapUnreadPendingMessages = -2;
    Assert.equal(info.imapTotalPendingMessages, -3);
    Assert.equal(info.imapUnreadPendingMessages, -2);
    Assert.ok(connection.transactionInProgress);
  } finally {
    connection.rollbackTransaction();
  }
  Assert.equal(info.imapTotalPendingMessages, 7);
  Assert.equal(info.imapUnreadPendingMessages, 5);
  for (const [property, value] of [
    ["totPendingMsgs", "-1"],
    ["unreadPendingMsgs", "4294967296"],
  ]) {
    connection.executeSimpleSQL(
      `UPDATE folder_properties SET value = ${value} ` +
        `WHERE id = ${folder.id} AND name = '${property}'`
    );
  }
  Assert.throws(
    () => info.imapTotalPendingMessages,
    /NS_ERROR_LOSS_OF_SIGNIFICANT_DATA/
  );
  Assert.throws(
    () => info.imapUnreadPendingMessages,
    /NS_ERROR_LOSS_OF_SIGNIFICANT_DATA/
  );
});

add_task(function test_countReadFailuresAndDeletedFolder() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("count-read-errors");
  const db = folder.msgDatabase;
  const info = db.dBFolderInfo;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "ALTER TABLE messages RENAME TO hidden_count_messages"
  );
  try {
    Assert.throws(() => db.syncCounts(), /NS_ERROR_FAILURE/);
    Assert.throws(() => info.numMessages, /NS_ERROR_FAILURE/);
    Assert.throws(() => info.numUnreadMessages, /NS_ERROR_FAILURE/);
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE hidden_count_messages RENAME TO messages"
    );
  }
  connection.executeSimpleSQL(
    "ALTER TABLE folder_properties RENAME TO hidden_count_properties"
  );
  try {
    Assert.throws(() => info.imapTotalPendingMessages, /NS_ERROR_FAILURE/);
    Assert.throws(() => info.imapUnreadPendingMessages, /NS_ERROR_FAILURE/);
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE hidden_count_properties RENAME TO folder_properties"
    );
  }
  db.syncCounts();
  Assert.equal(info.numMessages, 0);
  folderDB.deleteFolder(folder.id);
  Assert.throws(() => db.syncCounts(), /NS_ERROR_NOT_AVAILABLE/);
  Assert.throws(() => info.numMessages, /NS_ERROR_NOT_AVAILABLE/);
  Assert.throws(() => info.imapTotalPendingMessages, /NS_ERROR_NOT_AVAILABLE/);
  Assert.throws(
    () => (info.imapUnreadPendingMessages = 1),
    /NS_ERROR_NOT_AVAILABLE/
  );
});

function recordPendingCountChanges(folder) {
  const changes = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIFolderListener"]),
    onFolderIntPropertyChanged(changed, property, oldValue, newValue) {
      if (
        changed == folder &&
        ["TotalMessages", "TotalUnreadMessages"].includes(property)
      ) {
        changes.push([property, oldValue, newValue]);
      }
    },
  };
  MailServices.mailSession.AddFolderListener(
    listener,
    Ci.nsIFolderListener.intPropertyChanged
  );
  registerCleanupFunction(() =>
    MailServices.mailSession.RemoveFolderListener(listener)
  );
  return changes;
}

add_task(function test_pendingProducerWriteFailureDoesNotPublish() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("producer-write-errors");
  addMessage({ folderId: folder.id, messageId: "producer-one" });
  addMessage({ folderId: folder.id, messageId: "producer-two" });
  const info = folder.msgDatabase.dBFolderInfo;
  info.imapTotalPendingMessages = 3;
  info.imapUnreadPendingMessages = 1;
  Assert.equal(folder.numPendingTotalMessages, 3);
  Assert.equal(folder.numPendingUnread, 1);
  const changes = recordPendingCountChanges(folder);
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_pending_producer BEFORE INSERT ON folder_properties " +
      `WHEN NEW.id = ${folder.id} AND NEW.name IN ('totPendingMsgs', 'unreadPendingMsgs') ` +
      "BEGIN SELECT RAISE(ABORT, 'pending producer fault'); END"
  );
  try {
    Assert.throws(
      () => folder.changeNumPendingTotalMessages(1),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.throws(
      () => folder.changeNumPendingUnread(1),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.equal(folder.numPendingTotalMessages, 3);
    Assert.equal(folder.numPendingUnread, 1);
    Assert.equal(info.imapTotalPendingMessages, 3);
    Assert.equal(info.imapUnreadPendingMessages, 1);
    Assert.equal(folder.getTotalMessages(false), 5);
    Assert.equal(folder.getNumUnread(false), 3);
    Assert.deepEqual(changes, []);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_pending_producer");
  }
  folder.changeNumPendingTotalMessages(1);
  folder.changeNumPendingUnread(1);
  Assert.deepEqual(changes, [
    ["TotalMessages", 5, 6],
    ["TotalUnreadMessages", 3, 4],
  ]);
});

add_task(function test_pendingProducerChecksDeltaAndDisplayedCountWidth() {
  const root = rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  const empty = root.createLocalSubfolder("producer-delta-width");
  const emptyInfo = empty.msgDatabase.dBFolderInfo;
  empty.changeNumPendingTotalMessages(0x7fffffff);
  Assert.throws(
    () => empty.changeNumPendingTotalMessages(1),
    /NS_ERROR_LOSS_OF_SIGNIFICANT_DATA/
  );
  Assert.equal(empty.numPendingTotalMessages, 0x7fffffff);
  emptyInfo.imapTotalPendingMessages = -2147483648;
  Assert.throws(
    () => empty.changeNumPendingTotalMessages(-1),
    /NS_ERROR_LOSS_OF_SIGNIFICANT_DATA/
  );
  Assert.equal(empty.numPendingTotalMessages, -2147483648);
  emptyInfo.imapTotalPendingMessages = 0;

  const folder = root.createLocalSubfolder("producer-total-width");
  addMessage({ folderId: folder.id, messageId: "producer-width" });
  const info = folder.msgDatabase.dBFolderInfo;
  folder.changeNumPendingTotalMessages(0x7ffffffe);
  folder.changeNumPendingUnread(0x7ffffffe);
  const changes = recordPendingCountChanges(folder);
  Assert.throws(
    () => folder.changeNumPendingTotalMessages(1),
    /NS_ERROR_LOSS_OF_SIGNIFICANT_DATA/
  );
  Assert.throws(
    () => folder.changeNumPendingUnread(1),
    /NS_ERROR_LOSS_OF_SIGNIFICANT_DATA/
  );
  Assert.equal(folder.numPendingTotalMessages, 0x7ffffffe);
  Assert.equal(folder.numPendingUnread, 0x7ffffffe);
  Assert.equal(folder.getTotalMessages(false), 0x7fffffff);
  Assert.equal(folder.getNumUnread(false), 0x7fffffff);
  Assert.deepEqual(changes, []);
  info.imapTotalPendingMessages = 0;
  info.imapUnreadPendingMessages = 0;
});

add_task(function test_pendingProducerPreservesSignedAndUnknownUnreadValues() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("producer-signed");
  addMessage({ folderId: folder.id, messageId: "producer-signed-one" });
  addMessage({ folderId: folder.id, messageId: "producer-signed-two" });
  const info = folder.msgDatabase.dBFolderInfo;
  folder.changeNumPendingUnread(-1);
  Assert.equal(folder.numPendingUnread, -1);
  Assert.equal(info.getUint32Property("unreadPendingMsgs", 0), 0xffffffff);
  Assert.equal(folder.getNumUnread(false), 1);
  const changes = recordPendingCountChanges(folder);
  Assert.throws(
    () => folder.changeNumPendingUnread(-2),
    /NS_ERROR_ILLEGAL_VALUE/
  );
  Assert.equal(folder.numPendingUnread, -1);
  Assert.equal(info.imapUnreadPendingMessages, -1);
  Assert.deepEqual(changes, []);

  const virtual = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("producer-unknown");
  const summary = virtual.msgDatabase.dBFolderInfo;
  summary.orFlags(Ci.nsMsgFolderFlags.Virtual);
  summary.numMessages = 7;
  summary.numUnreadMessages = -1;
  Assert.equal(virtual.getNumUnread(false), -1);
  virtual.changeNumPendingUnread(0);
  Assert.equal(summary.getUint32Property("unreadPendingMsgs", 99), 99);
  Assert.throws(
    () => virtual.changeNumPendingUnread(-1),
    /NS_ERROR_NOT_AVAILABLE/
  );
  Assert.equal(summary.getUint32Property("unreadPendingMsgs", 99), 99);
  virtual.changeNumPendingUnread(2);
  virtual.changeNumPendingTotalMessages(3);
  Assert.equal(virtual.getNumUnread(false), 1);
  Assert.equal(virtual.getTotalMessages(false), 10);
  Assert.equal(summary.numMessages, 7);
  Assert.equal(summary.numUnreadMessages, -1);
  Assert.deepEqual(virtual.msgDatabase.listAllKeys(), []);
});

add_task(function test_pendingProducerReloadsAcrossForceClose() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("producer-reopen");
  addMessage({ folderId: folder.id, messageId: "producer-reopen-message" });
  const oldDB = folder.msgDatabase;
  oldDB.dBFolderInfo.imapTotalPendingMessages = 8;
  oldDB.dBFolderInfo.imapUnreadPendingMessages = 4;
  Cc["@mozilla.org/msgDatabase/msgDBService;1"]
    .getService(Ci.nsIMsgDBService)
    .forceFolderDBClosed(folder);
  const db = folder.msgDatabase;
  Assert.notStrictEqual(db, oldDB);
  Assert.equal(folder.numPendingTotalMessages, 8);
  Assert.equal(folder.numPendingUnread, 4);
  Assert.equal(folder.getTotalMessages(false), 9);
  Assert.equal(folder.getNumUnread(false), 5);
  folder.changeNumPendingTotalMessages(-8);
  folder.changeNumPendingUnread(-4);
  Assert.equal(db.dBFolderInfo.imapTotalPendingMessages, 0);
  Assert.equal(db.dBFolderInfo.imapUnreadPendingMessages, 0);
  const statement = database.connectionForTests.createStatement(
    "SELECT name, value, typeof(value) AS type FROM folder_properties " +
      "WHERE id = :id AND name IN ('totPendingMsgs', 'unreadPendingMsgs') ORDER BY name"
  );
  statement.params.id = folder.id;
  const rows = [];
  try {
    while (statement.executeStep()) {
      rows.push([statement.row.name, statement.row.value, statement.row.type]);
    }
  } finally {
    statement.finalize();
  }
  Assert.deepEqual(rows, [
    ["totPendingMsgs", 0, "integer"],
    ["unreadPendingMsgs", 0, "integer"],
  ]);
  Assert.equal(folder.getTotalMessages(false), 1);
  Assert.equal(folder.getNumUnread(false), 1);
});

add_task(function test_pendingProducerKeepsReentrantResult() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("producer-reentrant");
  const changes = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIFolderListener"]),
    onFolderIntPropertyChanged(changed, property, oldValue, newValue) {
      if (changed != folder || property != "TotalMessages") {
        return;
      }
      changes.push([oldValue, newValue]);
      Assert.equal(folder.numPendingTotalMessages, newValue);
      Assert.equal(
        folder.msgDatabase.dBFolderInfo.imapTotalPendingMessages,
        newValue
      );
      if (newValue == 1) {
        folder.changeNumPendingTotalMessages(2);
      }
    },
  };
  MailServices.mailSession.AddFolderListener(
    listener,
    Ci.nsIFolderListener.intPropertyChanged
  );
  try {
    folder.changeNumPendingTotalMessages(1);
    Assert.deepEqual(changes, [
      [0, 1],
      [1, 3],
    ]);
    Assert.equal(folder.numPendingTotalMessages, 3);
    Assert.equal(folder.getTotalMessages(false), 3);
  } finally {
    MailServices.mailSession.RemoveFolderListener(listener);
  }
});

add_task(function test_pendingProducerReadErrorsAndTransactionOwnership() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("producer-read-errors");
  folder.changeNumPendingTotalMessages(3);
  folder.changeNumPendingUnread(2);
  const connection = database.connectionForTests;
  const changes = recordPendingCountChanges(folder);
  connection.executeSimpleSQL(
    "ALTER TABLE folder_properties RENAME TO hidden_producer_properties"
  );
  try {
    Assert.throws(
      () => folder.changeNumPendingTotalMessages(1),
      /NS_ERROR_FAILURE/
    );
    Assert.throws(() => folder.changeNumPendingUnread(1), /NS_ERROR_FAILURE/);
    Assert.throws(() => folder.numPendingTotalMessages, /NS_ERROR_FAILURE/);
    Assert.throws(() => folder.getNumUnread(false), /NS_ERROR_FAILURE/);
    Assert.throws(() => folder.summaryChanged(), /NS_ERROR_FAILURE/);
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE hidden_producer_properties RENAME TO folder_properties"
    );
  }
  Assert.deepEqual(changes, []);
  connection.beginTransaction();
  try {
    folder.changeNumPendingTotalMessages(1);
    Assert.ok(connection.transactionInProgress);
    Assert.equal(folder.numPendingTotalMessages, 4);
  } finally {
    connection.rollbackTransaction();
  }
  Assert.equal(folder.numPendingTotalMessages, 3);
  Assert.equal(folder.getTotalMessages(false), 3);
  folderDB.deleteFolder(folder.id);
  Assert.throws(
    () => folder.changeNumPendingTotalMessages(1),
    /NS_ERROR_NOT_AVAILABLE/
  );
  Assert.throws(() => folder.numPendingUnread, /NS_ERROR_NOT_AVAILABLE/);
});

add_task(function test_pendingGettersDoNotReadUnrelatedCountFields() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("producer-independent");
  addMessage({ folderId: folder.id, messageId: "producer-independent" });
  const info = folder.msgDatabase.dBFolderInfo;
  info.imapTotalPendingMessages = 3;
  info.imapUnreadPendingMessages = 2;
  info.setInt64Property("unreadPendingMsgs", 4294967296);
  Assert.equal(folder.numPendingTotalMessages, 3);
  Assert.equal(folder.getTotalMessages(false), 4);
  Assert.throws(
    () => folder.numPendingUnread,
    /NS_ERROR_LOSS_OF_SIGNIFICANT_DATA/
  );
  info.imapUnreadPendingMessages = 2;
  info.orFlags(Ci.nsMsgFolderFlags.Virtual);
  info.numMessages = 7;
  info.numUnreadMessages = 3;
  info.setUint32Property("numMsgs", 0x80000000);
  Assert.equal(folder.numPendingTotalMessages, 3);
  Assert.equal(folder.numPendingUnread, 2);
  Assert.equal(folder.getNumUnread(false), 5);
  Assert.throws(
    () => folder.getTotalMessages(false),
    /NS_ERROR_LOSS_OF_SIGNIFICANT_DATA/
  );
  info.numMessages = 7;
  info.setUint32Property("numNewMsgs", 0x80000000);
  Assert.equal(folder.getTotalMessages(false), 10);
  Assert.equal(folder.numPendingUnread, 2);
  Assert.throws(
    () => folder.getNumUnread(false),
    /NS_ERROR_LOSS_OF_SIGNIFICANT_DATA/
  );
  info.numUnreadMessages = 3;
});

add_task(
  function test_pendingDeepCountsCheckChildrenAndExcludeVirtualSummaries() {
    const parent = rootFolder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder("producer-deep")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const child = parent.createLocalSubfolder("physical");
    const virtual = parent.createLocalSubfolder("virtual");
    addMessage({ folderId: child.id, messageId: "producer-deep-message" });
    virtual.setFlag(Ci.nsMsgFolderFlags.Virtual);
    virtual.msgDatabase.dBFolderInfo.numMessages = 99;
    virtual.msgDatabase.dBFolderInfo.numUnreadMessages = 88;
    parent.changeNumPendingTotalMessages(2);
    parent.changeNumPendingUnread(1);
    child.changeNumPendingTotalMessages(3);
    child.changeNumPendingUnread(1);
    Assert.equal(parent.getTotalMessages(false), 2);
    Assert.equal(parent.getNumUnread(false), 1);
    Assert.equal(parent.getTotalMessages(true), 6);
    Assert.equal(parent.getNumUnread(true), 3);
    child.msgDatabase.dBFolderInfo.imapTotalPendingMessages = 0x7fffffff;
    Assert.throws(
      () => parent.getTotalMessages(true),
      /NS_ERROR_LOSS_OF_SIGNIFICANT_DATA/
    );
    child.msgDatabase.dBFolderInfo.imapTotalPendingMessages = 0;
    Assert.equal(parent.getTotalMessages(true), 3);
  }
);

add_task(function test_offlineInterfaceReadsAndPersistsRealFolderOperations() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("offline-interface");
  let db = folder.msgDatabase.QueryInterface(Ci.nsIMsgOfflineOpsDatabase);
  const key = addMessage({
    folderId: folder.id,
    flags: Ci.nsMsgMessageFlags.Read,
  });
  Assert.deepEqual(db.listAllKeys(), [key]);
  Assert.deepEqual(db.listAllOfflineOpIds(), []);
  Assert.deepEqual(db.listAllOfflineDeletes(), []);
  Assert.equal(db.hasOfflineActivity(), false);
  Assert.strictEqual(db.getOfflineOpForKey(key, false), null);
  const op = db.getOfflineOpForKey(key, true);
  Assert.equal(op.messageKey, key);
  Assert.equal(op.newFlags, 1);
  Assert.equal(op.operation, 0);
  op.flagOperation = 0x08;
  op.addKeywordToAdd("exact-keyword");
  Assert.equal(
    op.operation,
    Ci.nsIMsgOfflineImapOperation.kFlagsChanged |
      Ci.nsIMsgOfflineImapOperation.kAddKeywords
  );
  Assert.equal(op.keywordsToAdd, "exact-keyword");
  Assert.deepEqual(db.listAllOfflineOpIds(), [key]);
  Assert.deepEqual(db.listAllOfflineDeletes(), [key]);
  Assert.equal(db.hasOfflineActivity(), true);
  Assert.ok(folder.getFlag(Ci.nsMsgFolderFlags.OfflineEvents));
  Assert.ok(db.dBFolderInfo.flags & Ci.nsMsgFolderFlags.OfflineEvents);
  db.forceClosed();
  Assert.throws(() => op.operation, /NS_ERROR_NOT_AVAILABLE/);
  db = folder.msgDatabase.QueryInterface(Ci.nsIMsgOfflineOpsDatabase);
  Assert.equal(
    db.getOfflineOpForKey(key, false).keywordsToAdd,
    "exact-keyword"
  );
  Assert.deepEqual(db.listAllOfflineDeletes(), [key]);
  db.removeOfflineOp(db.getOfflineOpForKey(key, false));
  Assert.strictEqual(db.getOfflineOpForKey(key, false), null);
  Assert.equal(db.hasOfflineActivity(), false);
  Assert.deepEqual(db.listAllKeys(), [key]);
});

add_task(
  function test_offlineDeleteEnumerationKeepsRemovedSourcesAndFolderScope() {
    const local = rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
    const folder = local.createLocalSubfolder("offline-delete-scope");
    const other = local.createLocalSubfolder("offline-delete-other");
    const db = folder.msgDatabase.QueryInterface(Ci.nsIMsgOfflineOpsDatabase);
    const otherDb = other.msgDatabase.QueryInterface(
      Ci.nsIMsgOfflineOpsDatabase
    );
    const deleted = addMessage({ folderId: folder.id });
    const mdnSent = addMessage({ folderId: folder.id });
    const moved = addMessage({ folderId: folder.id });
    const copied = addMessage({ folderId: folder.id });
    const foreign = addMessage({ folderId: other.id });
    db.getOfflineOpForKey(deleted, true).flagOperation = 0x08;
    db.getOfflineOpForKey(mdnSent, true).flagOperation = 0x80;
    db.getOfflineOpForKey(moved, true).operation =
      Ci.nsIMsgOfflineImapOperation.kMsgMoved;
    const copy = db.getOfflineOpForKey(copied, true);
    copy.operation = Ci.nsIMsgOfflineImapOperation.kMsgCopy;
    copy.newFlags = 0x08;
    otherDb.getOfflineOpForKey(foreign, true).flagOperation = 0x08;
    Assert.strictEqual(db.getOfflineOpForKey(foreign, false), null);
    Assert.throws(
      () => db.getOfflineOpForKey(foreign, true),
      /NS_ERROR_NOT_AVAILABLE/
    );
    messageDB.removeMessage(deleted);
    Assert.deepEqual(db.listAllKeys(), [mdnSent, moved, copied]);
    Assert.deepEqual(db.listAllOfflineDeletes(), [deleted, moved]);
    Assert.deepEqual(db.listAllOfflineOpIds(), [
      deleted,
      mdnSent,
      moved,
      copied,
    ]);
    Assert.deepEqual(otherDb.listAllOfflineDeletes(), [foreign]);
    Assert.equal(db.getOfflineOpForKey(deleted, false).newFlags, 0x08);
    const connection = database.connectionForTests;
    const statement = connection.createStatement(
      "SELECT messageKey, newFlags FROM offline_operations WHERE folderId = :folder ORDER BY messageKey"
    );
    try {
      statement.params.folder = folder.id;
      const stored = [];
      while (statement.executeStep()) {
        stored.push([statement.row.messageKey, statement.row.newFlags]);
      }
      Assert.deepEqual(stored, [
        [deleted, 0x08],
        [mdnSent, 0x80],
        [moved, 0],
        [copied, 0x08],
      ]);
    } finally {
      statement.finalize();
    }
  }
);

add_task(function test_offlineJournalErrorsAndClosedWrapperAreNotEmptyQueues() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("offline-interface-errors");
  const db = folder.msgDatabase.QueryInterface(Ci.nsIMsgOfflineOpsDatabase);
  const key = addMessage({ folderId: folder.id });
  const op = db.getOfflineOpForKey(key, true);
  op.flagOperation = 0x08;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_offline_update BEFORE UPDATE ON offline_operations " +
      "BEGIN SELECT RAISE(ABORT, 'offline update fault'); END"
  );
  try {
    Assert.throws(
      () => (op.newFlags = 0x80),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.equal(op.newFlags, 0x08);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_offline_update");
  }
  connection.beginTransaction();
  try {
    Assert.throws(
      () => (op.operation = Ci.nsIMsgOfflineImapOperation.kMsgMoved),
      /NS_ERROR_IN_PROGRESS/
    );
    Assert.ok(connection.transactionInProgress);
    Assert.equal(op.operation, Ci.nsIMsgOfflineImapOperation.kFlagsChanged);
  } finally {
    connection.rollbackTransaction();
  }
  connection.executeSimpleSQL(
    "ALTER TABLE offline_operations RENAME TO hidden_offline_operations"
  );
  try {
    Assert.throws(() => db.listAllOfflineOpIds(), /NS_ERROR_FAILURE/);
    Assert.throws(() => db.listAllOfflineDeletes(), /NS_ERROR_FAILURE/);
    Assert.throws(() => db.hasOfflineActivity(), /NS_ERROR_FAILURE/);
    Assert.throws(() => db.getOfflineOpForKey(key, false), /NS_ERROR_FAILURE/);
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE hidden_offline_operations RENAME TO offline_operations"
    );
  }
  Assert.deepEqual(db.listAllOfflineOpIds(), [key]);
  db.forceClosed();
  Assert.throws(() => db.listAllOfflineDeletes(), /NS_ERROR_NOT_AVAILABLE/);
  Assert.throws(() => op.newFlags, /NS_ERROR_NOT_AVAILABLE/);
  const fresh = folder.msgDatabase.QueryInterface(Ci.nsIMsgOfflineOpsDatabase);
  Assert.deepEqual(fresh.listAllOfflineDeletes(), [key]);
});

add_task(function test_permanentFolderRemovalRetiresActualNativeLocations() {
  const local = rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  const folder = local
    .createLocalSubfolder("retired-location")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const child = folder
    .createLocalSubfolder("nested")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const survivor = local
    .createLocalSubfolder("surviving-location")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const raw =
    "Message-ID: <same-retirement-message@example.invalid>\r\nSubject: Native retirement control\r\n\r\nbody\r\n";
  const headers = [
    folder.addMessage(raw),
    child.addMessage(raw),
    survivor.addMessage(raw),
  ];
  const ids = [folder.id, child.id, survivor.id];
  const keys = headers.map(header => header.messageKey);
  Assert.equal(new Set(keys).size, 3);
  Assert.deepEqual(
    keys.map(key => messageDB.getSearchState(key).folderId),
    ids
  );
  Assert.strictEqual(headers[0].folder, folder);
  Assert.strictEqual(headers[1].folder, child);
  const body = folder.filePath;
  Assert.ok(body.exists());
  rootFolder.propagateDelete(folder, true);
  Assert.ok(!body.exists());
  Assert.ok(!rootFolder.subFolders.includes(folder));
  for (let index = 0; index < 2; index++) {
    const state = messageDB.getSearchState(keys[index]);
    Assert.equal(state.folderId, ids[index]);
    Assert.strictEqual(state.folderFlags, null);
    Assert.throws(
      () => folderDB.getFolderParent(ids[index]),
      /NS_ERROR_UNEXPECTED/
    );
    // Retiring a location does not destroy captured physical message facts.
    Assert.equal(
      messageDB.getMessage(keys[index]).messageId,
      "same-retirement-message@example.invalid"
    );
  }
  Assert.equal(messageDB.getSearchState(keys[2]).folderId, ids[2]);
  Assert.notStrictEqual(messageDB.getSearchState(keys[2]).folderFlags, null);
  Assert.strictEqual(messageDB.getMessage(keys[2]).folder, survivor);
  const recreated = local
    .createLocalSubfolder("retired-location")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  Assert.notEqual(recreated.id, ids[0]);
  const replacement = recreated.addMessage(raw);
  Assert.ok(!keys.includes(replacement.messageKey));
  Assert.strictEqual(replacement.folder, recreated);
  Assert.strictEqual(messageDB.getSearchState(keys[0]).folderFlags, null);
});

add_task(
  function test_folderRemovalRejectsForeignTransactionBeforeBodyDeletion() {
    const folder = rootFolder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder("retirement-foreign-transaction");
    const id = folder.id;
    const body = folder.filePath;
    const connection = database.connectionForTests;
    connection.beginTransaction();
    try {
      Assert.throws(
        () => rootFolder.propagateDelete(folder, true),
        /NS_ERROR_IN_PROGRESS/
      );
      Assert.ok(connection.transactionInProgress);
      Assert.strictEqual(folder.parent, rootFolder);
      Assert.ok(rootFolder.subFolders.includes(folder));
      Assert.ok(body.exists());
      Assert.equal(folderDB.getFolderParent(id), rootFolder.id);
    } finally {
      connection.rollbackTransaction();
    }
    rootFolder.propagateDelete(folder, true);
    Assert.throws(() => folderDB.getFolderParent(id), /NS_ERROR_UNEXPECTED/);
  }
);

add_task(
  function test_folderRetirementReportsLateMetadataErrorAndAllowsFreshRetry() {
    const folder = rootFolder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder("retirement-write-error");
    const id = folder.id;
    const body = folder.filePath;
    const connection = database.connectionForTests;
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER reject_folder_retirement BEFORE DELETE ON folders " +
        `WHEN OLD.id = ${id} BEGIN SELECT RAISE(ABORT, 'folder retirement fault'); END`
    );
    try {
      Assert.throws(
        () => rootFolder.propagateDelete(folder, true),
        error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
      );
      Assert.strictEqual(folder.parent, rootFolder);
      Assert.ok(rootFolder.subFolders.includes(folder));
      Assert.equal(folderDB.getFolderParent(id), rootFolder.id);
      // Body deletion already succeeded. SQL failure is not a filesystem rollback.
      Assert.ok(!body.exists());
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER reject_folder_retirement");
    }
    rootFolder.propagateDelete(folder, true);
    Assert.throws(() => folderDB.getFolderParent(id), /NS_ERROR_UNEXPECTED/);
    Assert.ok(!rootFolder.subFolders.includes(folder));
  }
);

add_task(function test_expungedBytesPersistenceAndPhysicalFolder() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("expunged-bytes");
  const other = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("other-expunged-bytes");
  let info = folder.msgDatabase.dBFolderInfo;
  const otherInfo = other.msgDatabase.dBFolderInfo;
  const connection = database.connectionForTests;
  const readStoredValue = () => {
    const statement = connection.createStatement(
      "SELECT CAST(value AS TEXT) AS value, typeof(value) AS type " +
        "FROM folder_properties WHERE id = :id AND name = 'expungedBytes'"
    );
    statement.params.id = folder.id;
    try {
      return statement.executeStep()
        ? [statement.row.value, statement.row.type]
        : null;
    } finally {
      statement.finalize();
    }
  };

  Assert.equal(info.expungedBytes, 0);
  Assert.equal(folder.expungedBytes, 0);
  Assert.equal(readStoredValue(), null, "reading absence does not store zero");
  otherInfo.expungedBytes = 29;
  const largeValue = 2 ** 40 + 19;
  info.expungedBytes = largeValue;
  info.changeExpungedBytes(7);
  info.changeExpungedBytes(-3);
  Assert.equal(info.expungedBytes, largeValue + 4);
  Assert.equal(folder.expungedBytes, largeValue + 4);
  Assert.deepEqual(readStoredValue(), [String(largeValue + 4), "integer"]);
  Assert.equal(otherInfo.expungedBytes, 29);

  connection.beginTransaction();
  try {
    info.expungedBytes = 10;
    info.changeExpungedBytes(2);
    Assert.equal(info.expungedBytes, 12);
    Assert.ok(connection.transactionInProgress);
  } finally {
    connection.rollbackTransaction();
  }
  Assert.equal(info.expungedBytes, largeValue + 4);
  Assert.equal(folder.expungedBytes, largeValue + 4);

  Cc["@mozilla.org/msgDatabase/msgDBService;1"]
    .getService(Ci.nsIMsgDBService)
    .forceFolderDBClosed(folder);
  info = folder.msgDatabase.dBFolderInfo;
  Assert.equal(info.expungedBytes, largeValue + 4);
  Assert.equal(folder.expungedBytes, largeValue + 4);
  info.expungedBytes = 0;
  Assert.deepEqual(readStoredValue(), ["0", "integer"]);
  Assert.equal(folder.expungedBytes, 0);
  Assert.equal(otherInfo.expungedBytes, 29);
});

add_task(function test_expungedBytesRejectsInvalidValuesAndPreservesErrors() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("expunged-errors");
  const info = folder.msgDatabase.dBFolderInfo;
  const connection = database.connectionForTests;
  info.expungedBytes = 20;
  Assert.throws(
    () => (info.expungedBytes = -1),
    error => error.result == Cr.NS_ERROR_ILLEGAL_VALUE
  );
  Assert.throws(
    () => info.changeExpungedBytes(-21),
    error => error.result == Cr.NS_ERROR_ILLEGAL_VALUE
  );
  Assert.equal(info.expungedBytes, 20);

  // Use SQL for INT64_MAX: JavaScript Numbers cannot represent it exactly.
  connection.executeSimpleSQL(
    "UPDATE folder_properties SET value = 9223372036854775807 " +
      `WHERE id = ${folder.id} AND name = 'expungedBytes'`
  );
  Assert.throws(
    () => info.changeExpungedBytes(1),
    error => error.result == Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA
  );
  Assert.equal(info.getCharProperty("expungedBytes"), "9223372036854775807");
  info.changeExpungedBytes(-1);
  Assert.equal(info.getCharProperty("expungedBytes"), "9223372036854775806");
  info.setInt64Property("expungedBytes", -1);
  Assert.throws(
    () => info.expungedBytes,
    error => error.result == Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA
  );
  Assert.equal(info.getInt64Property("expungedBytes", 0), -1);
  info.expungedBytes = 20;

  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_expunged_write BEFORE INSERT ON folder_properties " +
      `WHEN NEW.id = ${folder.id} AND NEW.name = 'expungedBytes' ` +
      "BEGIN SELECT RAISE(ABORT, 'expunged bytes fault'); END"
  );
  try {
    Assert.throws(
      () => (info.expungedBytes = 30),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.throws(
      () => info.changeExpungedBytes(1),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.equal(info.expungedBytes, 20);
    Assert.equal(folder.expungedBytes, 20);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_expunged_write");
  }

  connection.executeSimpleSQL(
    "ALTER TABLE folder_properties RENAME TO hidden_expunged_properties"
  );
  try {
    Assert.throws(() => info.expungedBytes, /NS_ERROR_FAILURE/);
    Assert.throws(() => folder.expungedBytes, /NS_ERROR_FAILURE/);
    Assert.throws(() => info.changeExpungedBytes(1), /NS_ERROR_FAILURE/);
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE hidden_expunged_properties RENAME TO folder_properties"
    );
  }
  Assert.equal(info.expungedBytes, 20);
  Assert.equal(folder.expungedBytes, 20);
  folderDB.deleteFolder(folder.id);
  Assert.throws(() => info.expungedBytes, /NS_ERROR_NOT_AVAILABLE/);
  Assert.throws(() => (info.expungedBytes = 0), /NS_ERROR_NOT_AVAILABLE/);
  Assert.throws(() => info.changeExpungedBytes(1), /NS_ERROR_NOT_AVAILABLE/);
});

add_task(async function test_retainedTrashStorageRequiresRetiredRows() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("retained-trash-storage");
  folder.setFlag(Ci.nsMsgFolderFlags.Trash);
  const id = folder.id;
  const uri = folder.URI;
  const path = folder.filePath.path;
  await IOUtils.writeUTF8(path, "retained storage bytes");
  const key = addMessage({ folderId: id, messageId: "retained-trash-message" });
  Assert.throws(
    () => rootFolder.propagateDelete(folder, true),
    /NS_ERROR_NOT_AVAILABLE/
  );
  Assert.equal(await IOUtils.readUTF8(path), "retained storage bytes");
  Assert.ok(folder.msgDatabase.containsKey(key));
  Assert.strictEqual(folder.parent, rootFolder);
  Assert.strictEqual(MailServices.folderLookup.getFolderForURL(uri), folder);

  messageDB.removeMessage(key);

  const connection = database.connectionForTests;
  connection.beginTransaction();
  try {
    Assert.throws(
      () => rootFolder.propagateDelete(folder, true),
      /NS_ERROR_IN_PROGRESS/
    );
    Assert.ok(connection.transactionInProgress);
    Assert.equal(await IOUtils.readUTF8(path), "retained storage bytes");
  } finally {
    connection.rollbackTransaction();
  }
  connection.executeSimpleSQL(
    "ALTER TABLE staged_messages RENAME TO hidden_trash_staged_messages"
  );
  try {
    Assert.throws(
      () => rootFolder.propagateDelete(folder, true),
      /NS_ERROR_FAILURE/
    );
    Assert.equal(await IOUtils.readUTF8(path), "retained storage bytes");
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE hidden_trash_staged_messages RENAME TO staged_messages"
    );
  }
  rootFolder.propagateDelete(folder, true);
  Assert.ok(!(await IOUtils.exists(path)));
  Assert.equal(folderDB.getFolderParent(id), rootFolder.id);
  // propagateDelete deliberately unlinks the folder on success. EmptyTrash
  // must instead keep its canonical object and call the native storage API.
  Assert.strictEqual(folder.parent, null);
  Assert.equal(folder.id, id);
  Assert.equal(folder.URI, uri);
});

add_task(async function test_retainedTrashRechecksAfterAnnouncerCallbacks() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("retained-trash-reentrant");
  folder.setFlag(Ci.nsMsgFolderFlags.Trash);
  const path = folder.filePath.path;
  await IOUtils.writeUTF8(path, "announcer must not discard these bytes");
  const db = folder.msgDatabase;
  let key;
  let child;
  let calls = 0;
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onAnnouncerGoingAway() {
      calls++;
      key = addMessage({
        folderId: folder.id,
        messageId: "retained-trash-during-close",
      });
      folder.createSubfolder("late-child", null);
      child = folder.getChildNamed("late-child");
    },
  };
  db.addListener(listener);
  try {
    Assert.throws(
      () => rootFolder.propagateDelete(folder, true),
      /NS_ERROR_NOT_AVAILABLE/
    );
    Assert.equal(calls, 1);
    Assert.ok(folder.msgDatabase.containsKey(key));
    Assert.strictEqual(child.parent, folder);
    Assert.equal(folderDB.getFolderParent(child.id), folder.id);
    Assert.equal(
      await IOUtils.readUTF8(path),
      "announcer must not discard these bytes"
    );
    Assert.strictEqual(folder.parent, rootFolder);
    Assert.strictEqual(
      MailServices.folderLookup.getFolderForURL(folder.URI),
      folder
    );
  } finally {
    db.removeListener(listener);
  }
});

add_task(async function test_accountedDeletionUsesPhysicalRowsAndKeepsBodies() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("accounted-deletion");
  const other = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("accounted-bystander");
  const db = folder.msgDatabase;
  const info = db.dBFolderInfo;
  const otherDB = other.msgDatabase;
  const first = messageDB.getMessage(addMessage({ folderId: folder.id }));
  const second = messageDB.getMessage(addMessage({ folderId: folder.id }));
  const foreign = messageDB.getMessage(addMessage({ folderId: other.id }));
  first.messageSize = 0xf0000001;
  first.offlineMessageSize = 7;
  second.messageSize = 19;
  foreign.messageSize = 31;
  const path = folder.filePath.path;
  await IOUtils.writeUTF8(path, "metadata removal retains body bytes");
  const deleted = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrDeleted(header) {
      deleted.push(header.messageKey);
      Assert.ok(!db.containsKey(header.messageKey));
      Assert.equal(
        info.expungedBytes,
        deleted.length == 1 ? 0xf0000001 : 0xf0000014
      );
      Assert.ok(!database.connectionForTests.transactionInProgress);
    },
  };
  db.addListener(listener);
  try {
    Assert.throws(
      () => db.deleteHeader(foreign, null, true, true),
      /NS_ERROR_NOT_AVAILABLE/
    );
    Assert.ok(otherDB.containsKey(foreign.messageKey));
    Assert.equal(info.expungedBytes, 0);
    Assert.equal(otherDB.dBFolderInfo.expungedBytes, 0);
    Assert.deepEqual(deleted, []);
    db.deleteHeader(first, null, true, true);
    db.deleteMessage(second.messageKey, null, false);
    Assert.deepEqual(deleted, [first.messageKey, second.messageKey]);
    Assert.equal(info.expungedBytes, 0xf0000014);
    Assert.ok(otherDB.containsKey(foreign.messageKey));
    Assert.equal(otherDB.dBFolderInfo.expungedBytes, 0);
    Assert.equal(
      await IOUtils.readUTF8(path),
      "metadata removal retains body bytes"
    );
    Assert.strictEqual(first.folder, folder);
    // Removal deletes storage properties; the retained header keeps its key
    // and core fields, while the size getter uses the normal absence default.
    Assert.equal(first.messageSize, 0);
    const properties = database.connectionForTests.createStatement(
      "SELECT COUNT(*) AS count FROM message_properties WHERE id = :key"
    );
    try {
      properties.params.key = first.messageKey;
      Assert.ok(properties.executeStep());
      Assert.equal(properties.row.count, 0);
    } finally {
      properties.finalize();
    }
  } finally {
    db.removeListener(listener);
  }
});

add_task(function test_accountedDeletionPreservesErrorsAndCallerOwnership() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("accounted-errors");
  const db = folder.msgDatabase;
  const info = db.dBFolderInfo;
  const key = addMessage({ folderId: folder.id });
  messageDB.getMessage(key).messageSize = 23;
  info.expungedBytes = 11;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_accounted_removal BEFORE INSERT ON folder_properties " +
      `WHEN NEW.id = ${folder.id} AND NEW.name = 'expungedBytes' ` +
      "BEGIN SELECT RAISE(ABORT, 'accounted removal fault'); END"
  );
  try {
    Assert.throws(
      () => db.deleteMessages([key], null),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.ok(db.containsKey(key));
    Assert.equal(info.expungedBytes, 11);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_accounted_removal");
  }
  connection.beginTransaction();
  try {
    Assert.throws(
      () => db.deleteMessage(key, null, true),
      /NS_ERROR_IN_PROGRESS/
    );
    Assert.ok(connection.transactionInProgress);
    Assert.ok(db.containsKey(key));
    Assert.equal(info.expungedBytes, 11);
  } finally {
    connection.rollbackTransaction();
  }
  connection.executeSimpleSQL(
    "ALTER TABLE body_relocations RENAME TO hidden_accounted_body_relocations"
  );
  try {
    Assert.throws(() => db.deleteMessages([key], null), /NS_ERROR_FAILURE/);
    Assert.ok(db.containsKey(key));
    Assert.equal(info.expungedBytes, 11);
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE hidden_accounted_body_relocations RENAME TO body_relocations"
    );
  }
  const source = database.sourceId;
  const id = folder.id;
  const stored = storedFolderInfoState(id);
  connection.executeSimpleSQL(
    "UPDATE database_identity SET sourceId = '{12345678-1234-1234-1234-123456789abc}'"
  );
  try {
    Assert.throws(
      () => db.deleteMessages([key], null),
      /NS_ERROR_NOT_AVAILABLE/
    );
    Assert.ok(db.containsKey(key));
    Assert.throws(() => info.expungedBytes, /NS_ERROR_NOT_AVAILABLE/);
    Assert.deepEqual(storedFolderInfoState(id), stored);
  } finally {
    const restore = connection.createStatement(
      "UPDATE database_identity SET sourceId = :source"
    );
    try {
      restore.params.source = source;
      restore.execute();
    } finally {
      restore.finalize();
    }
  }
  Assert.equal(info.expungedBytes, 11);
  db.deleteMessages([key], null);
  Assert.ok(!db.containsKey(key));
  Assert.equal(info.expungedBytes, 34);
  db.forceClosed();
  Assert.throws(() => db.deleteMessages([key], null), /NS_ERROR_NOT_AVAILABLE/);
});

add_task(function test_accountedImapDeletionUsesOnlyOfflineBytes() {
  const server = MailServices.accounts.createIncomingServer(
    "accounted-imap",
    "accounted.invalid",
    "imap"
  );
  const account = MailServices.accounts.createAccount();
  account.incomingServer = server;
  try {
    Assert.equal(server.localDatabaseType, "imap");
    const root = server.rootFolder.QueryInterface(Ci.nsIMsgImapMailFolder);
    root.createClientSubfolderInfo("accounted", "/", 0, true);
    const folder = root.getChildNamed("accounted");
    const db = folder.msgDatabase;
    Assert.strictEqual(db.folder, folder);
    const offline = messageDB.getMessage(
      addMessage({ folderId: folder.id, flags: Ci.nsMsgMessageFlags.Offline })
    );
    const online = messageDB.getMessage(addMessage({ folderId: folder.id }));
    offline.messageSize = 700;
    offline.offlineMessageSize = 0x80000001;
    online.messageSize = 900;
    online.offlineMessageSize = 100;
    db.deleteMessages([offline.messageKey, online.messageKey], null);
    Assert.equal(db.dBFolderInfo.expungedBytes, 0x80000001);
    Assert.ok(!db.containsKey(offline.messageKey));
    Assert.ok(!db.containsKey(online.messageKey));
  } finally {
    MailServices.accounts.removeAccount(account, false);
  }
});

add_task(function test_accountedRemovalStopsAtReentrantClose() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("accounted-close");
  const db = folder.msgDatabase;
  const first = addMessage({ folderId: folder.id });
  const second = addMessage({ folderId: folder.id });
  messageDB.getMessage(first).messageSize = 23;
  messageDB.getMessage(second).messageSize = 7;
  let calls = 0;
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrDeleted(header) {
      Assert.equal(header.messageKey, first);
      calls++;
      db.forceClosed();
    },
  };
  db.addListener(listener);
  try {
    Assert.throws(
      () => db.deleteMessages([first, second], null),
      /NS_ERROR_NOT_AVAILABLE/
    );
    Assert.equal(calls, 1);
    const reopened = database.openFolderDB(folder, false);
    Assert.ok(!reopened.containsKey(first));
    Assert.ok(reopened.containsKey(second));
    Assert.equal(reopened.dBFolderInfo.expungedBytes, 23);
  } finally {
    db.removeListener(listener);
  }
});

add_task(function test_deletionKeepsItsConstructionIncarnation() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("accounted-admission");
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  const connection = database.connectionForTests;
  const originalSource = database.sourceId;
  const first = addMessage({ folderId: folder.id });
  messageDB.getMessage(first).messageSize = 43;
  service.forceFolderDBClosed(folder);
  let admitted;
  connection.beginTransaction();
  try {
    admitted = service.openFolderDB(folder, false);
    Assert.ok(connection.transactionInProgress);
    Assert.throws(
      () => admitted.deleteMessage(first, null, true),
      /NS_ERROR_IN_PROGRESS/
    );
    Assert.ok(connection.transactionInProgress);
  } finally {
    connection.rollbackTransaction();
  }
  admitted.deleteMessage(first, null, true);
  Assert.equal(admitted.dBFolderInfo.expungedBytes, 43);
  const second = addMessage({ folderId: folder.id });
  messageDB.getMessage(second).messageSize = 7;
  admitted.forceClosed();
  connection.beginTransaction();
  try {
    connection.executeSimpleSQL(
      "UPDATE database_identity SET sourceId = '{87654321-4321-4321-4321-cba987654321}'"
    );
    Assert.throws(
      () => service.openFolderDB(folder, false),
      /NS_ERROR_NOT_AVAILABLE/,
      "Public admission rejects the original wrapper in another incarnation"
    );
    Assert.ok(connection.transactionInProgress);
  } finally {
    connection.rollbackTransaction();
  }
  Assert.equal(database.sourceId, originalSource);
  // Direct receiver construction in a temporary incarnation is covered by
  // DeliveryFolderInfoProperties.DeletionKeepsItsConstructionIncarnation.
  const current = service.openFolderDB(folder, false);
  Assert.ok(current.containsKey(second));
  Assert.equal(current.dBFolderInfo.expungedBytes, 43);
  current.deleteMessage(second, null, true);
  Assert.equal(current.dBFolderInfo.expungedBytes, 50);
});

add_task(function test_deletionPropagatesActualServerPolicyError() {
  const incoming = MailServices.accounts.createIncomingServer(
    "accounted-pop",
    "policy.invalid",
    "pop3"
  );
  const account = MailServices.accounts.createAccount();
  account.incomingServer = incoming;
  try {
    Assert.equal(incoming.localDatabaseType, "mailbox");
    const folder = incoming.rootFolder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder("accounted-policy-error");
    const db = folder.msgDatabase;
    const key = addMessage({ folderId: folder.id });
    messageDB.getMessage(key).messageSize = 29;
    // POP3 uses the real JavaScript incoming-server implementation. The Local
    // Folders server is native and cannot supply this getter fault witness.
    const server = incoming.wrappedJSObject;
    const descriptor = Object.getOwnPropertyDescriptor(
      server,
      "localDatabaseType"
    );
    Object.defineProperty(server, "localDatabaseType", {
      configurable: true,
      get() {
        throw Components.Exception(
          "accounting policy fault",
          Cr.NS_ERROR_ABORT
        );
      },
    });
    try {
      Assert.throws(
        () => db.deleteMessage(key, null, true),
        error => error.result == Cr.NS_ERROR_ABORT
      );
      Assert.ok(db.containsKey(key));
      Assert.equal(db.dBFolderInfo.expungedBytes, 0);
      // Empty input preserves its existing no-op behavior, without consulting
      // the policy or writing an explicit zero counter.
      db.deleteMessages([], null);
    } finally {
      if (descriptor) {
        Object.defineProperty(server, "localDatabaseType", descriptor);
      } else {
        delete server.localDatabaseType;
      }
    }
    db.deleteMessage(key, null, true);
    Assert.equal(db.dBFolderInfo.expungedBytes, 29);
  } finally {
    MailServices.accounts.removeAccount(account, false);
  }
});

add_task(function test_admissionKeepsItsOriginalSourceReadError() {
  const service = database.QueryInterface(Ci.nsIMsgDBService);
  const connection = database.connectionForTests;
  const source = database.sourceId;
  for (const fault of ["missing", "corrupt"]) {
    const folder = rootFolder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder(`admission-source-${fault}`);
    const folderId = folder.id;
    const key = addMessage({ folderId });
    messageDB.getMessage(key).messageSize = 17;
    folder.msgDatabase.forceClosed();
    const readCounter = () => {
      const row = connection.createStatement(
        "SELECT value, typeof(value) FROM folder_properties " +
          "WHERE id = :id AND name = 'expungedBytes'"
      );
      try {
        row.params.id = folderId;
        return row.executeStep()
          ? [row.getInt64(0), row.getUTF8String(1)]
          : null;
      } finally {
        row.finalize();
      }
    };
    const originalCounter = readCounter();
    const expected =
      fault === "missing" ? Cr.NS_ERROR_FAILURE : Cr.NS_ERROR_FILE_CORRUPTED;
    try {
      if (fault === "missing") {
        connection.executeSimpleSQL(
          "ALTER TABLE database_identity RENAME TO hidden_admission_identity"
        );
      } else {
        connection.executeSimpleSQL(
          "UPDATE database_identity SET sourceId = 'not-a-uuid'"
        );
      }
      Assert.throws(
        () => service.openFolderDB(folder, false),
        error => error.result === expected,
        "Public admission preserves the original source reader error"
      );
    } finally {
      if (fault === "missing") {
        connection.executeSimpleSQL(
          "ALTER TABLE hidden_admission_identity RENAME TO database_identity"
        );
      } else {
        const restore = connection.createStatement(
          "UPDATE database_identity SET sourceId = :source"
        );
        try {
          restore.params.source = source;
          restore.execute();
        } finally {
          restore.finalize();
        }
      }
    }
    Assert.equal(database.sourceId, source);
    // The constructor's latched original error is covered directly by
    // DeliveryFolderInfoProperties.AdmissionKeepsItsOriginalSourceReadError.
    const current = service.openFolderDB(folder, false);
    Assert.ok(current.containsKey(key));
    Assert.equal(current.dBFolderInfo.expungedBytes, 0);
    Assert.deepEqual(
      readCounter(),
      originalCounter,
      "Failed admission preserves raw counter presence, type and value"
    );
    current.deleteMessage(key, null, true);
    Assert.ok(!current.containsKey(key));
    Assert.equal(current.dBFolderInfo.expungedBytes, 17);
  }
});

add_task(function test_enumeratorsBelongToTheirWrapperLifetime() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("enumerator-owner");
  const other = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("enumerator-bystander");
  const key = addMessage({ folderId: folder.id });
  const otherKey = addMessage({ folderId: other.id });
  const db = folder.msgDatabase;
  const otherDB = other.msgDatabase;
  const header = db.getMsgHdrForKey(key);
  db.refreshCache(folder.URI, [otherKey]);
  Assert.strictEqual(db.getCachedHits(folder.URI).getNext().folder, other);
  const factories = [
    () => db.enumerateMessages(),
    () => db.reverseEnumerateMessages(),
    () => db.getFilterEnumerator([]),
    () => db.getCachedHits(folder.URI),
  ];
  const retained = factories.map(create => create());
  const threads = db.enumerateThreads();
  for (const enumerator of [...retained, threads]) {
    Assert.ok(enumerator.hasMoreElements());
  }
  const otherEnumerator = otherDB.enumerateMessages();
  const connection = database.connectionForTests;
  connection.beginTransaction();
  try {
    db.close(true);
    Assert.ok(connection.transactionInProgress);
  } finally {
    connection.rollbackTransaction();
  }
  for (const enumerator of retained) {
    Assert.throws(() => enumerator.hasMoreElements(), /NS_ERROR_FAILURE/);
    Assert.throws(() => enumerator.getNext(), /NS_ERROR_FAILURE/);
  }
  // Retained thread cursors report exhaustion on close; fetching still fails.
  Assert.ok(!threads.hasMoreElements());
  Assert.throws(() => threads.getNext(), /NS_ERROR_FAILURE/);
  Assert.strictEqual(header.folder, folder);
  header.subject = "Header remains usable after cursor invalidation";
  Assert.equal(db.getMsgHdrForKey(key).subject, header.subject);
  Assert.deepEqual(
    [...db.enumerateMessages()].map(item => item.messageKey),
    [key],
    "Close invalidates old cursors without closing the shared connection"
  );
  Assert.equal(otherEnumerator.getNext().messageKey, otherKey);
  Assert.ok(!otherEnumerator.hasMoreElements());
  Assert.deepEqual(
    [...db.getCachedHits(folder.URI)].map(item => item.messageKey),
    [otherKey],
    "Cached hits retain their own physical folder identity"
  );
  const beforeForceClose = factories.map(create => create());
  const threadsBeforeForceClose = db.enumerateThreads();
  let callbacks = 0;
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onAnnouncerGoingAway(source) {
      callbacks++;
      Assert.strictEqual(source, db);
      for (const enumerator of beforeForceClose) {
        Assert.throws(() => enumerator.hasMoreElements(), /NS_ERROR_FAILURE/);
        Assert.throws(() => enumerator.getNext(), /NS_ERROR_FAILURE/);
      }
      Assert.ok(!threadsBeforeForceClose.hasMoreElements());
      Assert.throws(
        () => threadsBeforeForceClose.getNext(),
        /NS_ERROR_FAILURE/
      );
      source.forceClosed();
      Assert.ok(otherDB.containsKey(otherKey));
    },
  };
  db.addListener(listener);
  try {
    db.forceClosed();
    Assert.equal(callbacks, 1);
    db.forceClosed();
    Assert.equal(callbacks, 1);
    const reopened = database
      .QueryInterface(Ci.nsIMsgDBService)
      .openFolderDB(folder, false);
    Assert.notStrictEqual(reopened, db);
    Assert.deepEqual(
      [...reopened.enumerateMessages()].map(item => item.messageKey),
      [key]
    );
    Assert.ok(otherDB.containsKey(otherKey));
  } finally {
    db.removeListener(listener);
  }
});

add_task(function test_enumeratorsPreserveTheirOriginalSourceIdentity() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("enumerator-incarnation");
  const key = addMessage({ folderId: folder.id });
  const db = folder.msgDatabase;
  const connection = database.connectionForTests;
  const source = database.sourceId;
  const update = connection.createStatement(
    "UPDATE database_identity SET sourceId = :source"
  );
  try {
    for (const [value, expected] of [
      [Services.uuid.generateUUID().toString(), Cr.NS_ERROR_NOT_AVAILABLE],
      ["not-a-uuid", Cr.NS_ERROR_FILE_CORRUPTED],
    ]) {
      const enumerators = [
        db.enumerateMessages(),
        db.reverseEnumerateMessages(),
        db.enumerateThreads(),
        db.getFilterEnumerator([]),
      ];
      for (const enumerator of enumerators) {
        Assert.ok(enumerator.hasMoreElements());
      }
      update.params.source = value;
      update.execute();
      try {
        for (const enumerator of enumerators) {
          Assert.throws(
            () => enumerator.hasMoreElements(),
            error => error.result === expected
          );
          Assert.throws(
            () => enumerator.getNext(),
            error => error.result === expected
          );
        }
      } finally {
        update.params.source = source;
        update.execute();
      }
      for (const enumerator of enumerators) {
        Assert.throws(
          () => enumerator.getNext(),
          error => error.result === expected,
          "Restoring the table cannot revive a refused cursor"
        );
      }
      Assert.deepEqual(
        [...db.enumerateMessages()].map(header => header.messageKey),
        [key]
      );
    }
  } finally {
    update.params.source = source;
    update.execute();
    update.finalize();
  }
});

add_task(function test_enumeratorFactoriesPropagateFirstStepErrors() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("enumerator-step-error");
  const key = addMessage({ folderId: folder.id });
  const db = folder.msgDatabase;
  const connection = database.connectionForTests;
  // A normal read of the temporary view fails when SQLite evaluates date.
  // The production table and its message are unchanged.
  connection.executeSimpleSQL(
    "CREATE TEMP VIEW messages AS SELECT id, folderId, threadId, " +
      "threadParent, messageId, abs(-9223372036854775808) AS date, sender, " +
      "recipients, ccList, bccList, subject, flags, tags, priority FROM main.messages"
  );
  try {
    for (const create of [
      () => db.enumerateMessages(),
      () => db.reverseEnumerateMessages(),
      () => db.enumerateThreads(),
    ]) {
      Assert.throws(
        create,
        error => error.result === Cr.NS_ERROR_FAILURE,
        "An ExecuteStep error cannot become a successful empty enumeration"
      );
    }
  } finally {
    connection.executeSimpleSQL("DROP VIEW temp.messages");
  }
  Assert.deepEqual(
    [...db.enumerateMessages()].map(header => header.messageKey),
    [key]
  );
});

add_task(function test_filteredPrefetchCannotOutliveItsMembershipOrOwner() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("enumerator-filtered-membership");
  const first = addMessage({ folderId: folder.id });
  const second = addMessage({ folderId: folder.id });
  const db = folder.msgDatabase;
  const enumerator = db.getFilterEnumerator([]);
  Assert.ok(enumerator.hasMoreElements());
  db.deleteMessage(first, null, true);
  Assert.equal(enumerator.getNext().messageKey, second);
  Assert.ok(!enumerator.hasMoreElements());
  let calls = 0;
  const custom = {
    id: "enumerator-reentrant-close@test.invalid",
    name: "Close the wrapper during matching",
    getEnabled() {
      return true;
    },
    getAvailable() {
      return true;
    },
    getAvailableOperators() {
      return [Ci.nsMsgSearchOp.Is];
    },
    match() {
      calls++;
      db.close(false);
      return true;
    },
  };
  MailServices.filters.addCustomTerm(custom);
  const session = Cc["@mozilla.org/messenger/searchSession;1"].createInstance(
    Ci.nsIMsgSearchSession
  );
  const term = session.createTerm();
  term.attrib = Ci.nsMsgSearchAttrib.Custom;
  term.customId = custom.id;
  term.op = Ci.nsMsgSearchOp.Is;
  term.booleanAnd = true;
  const value = term.value;
  value.attrib = term.attrib;
  value.str = "close";
  term.value = value;
  const reentrant = db.getFilterEnumerator([term]);
  Assert.throws(() => reentrant.hasMoreElements(), /NS_ERROR_FAILURE/);
  Assert.equal(calls, 1);
  Assert.throws(() => reentrant.getNext(), /NS_ERROR_FAILURE/);
  Assert.equal(calls, 1);
  Assert.deepEqual(
    [...db.getFilterEnumerator([])].map(header => header.messageKey),
    [second]
  );
});

add_task(function test_retentionSettingsDefaultsAndPersistence() {
  const db = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("retention-settings").msgDatabase;
  const settings = db.msgRetentionSettings;
  Assert.equal(
    settings.retainByPreference,
    Ci.nsIMsgRetentionSettings.nsMsgRetainAll
  );
  Assert.equal(settings.daysToKeepHdrs, 0);
  Assert.equal(settings.numHeadersToKeep, 0);
  Assert.equal(settings.useServerDefaults, true);
  Assert.equal(settings.applyToFlaggedMessages, false);
  settings.retainByPreference = Ci.nsIMsgRetentionSettings.nsMsgRetainByAge;
  settings.daysToKeepHdrs = 0xffffffff;
  settings.numHeadersToKeep = 42;
  settings.useServerDefaults = false;
  settings.applyToFlaggedMessages = true;
  db.msgRetentionSettings = settings;
  const info = db.dBFolderInfo;
  Assert.equal(info.getUint32Property("retainBy", 0), 2);
  Assert.equal(info.getUint32Property("daysToKeepHdrs", 0), 0xffffffff);
  Assert.equal(info.getUint32Property("numHdrsToKeep", 0), 42);
  Assert.equal(info.getBooleanProperty("useServerDefaults", true), false);
  Assert.equal(info.getBooleanProperty("applyToFlaggedMessages", false), true);
  db.msgRetentionSettings = null;
  Assert.equal(db.msgRetentionSettings.daysToKeepHdrs, 0xffffffff);
  info.setUint32Property("daysToKeepHdrs", 7);
  Assert.equal(db.msgRetentionSettings.daysToKeepHdrs, 7);
});

add_task(function test_retentionWriteFailureRollsBack() {
  const db = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("retention-write-error").msgDatabase;
  const settings = db.msgRetentionSettings;
  settings.retainByPreference = Ci.nsIMsgRetentionSettings.nsMsgRetainByAge;
  settings.daysToKeepHdrs = 7;
  settings.numHeadersToKeep = 9;
  settings.useServerDefaults = false;
  settings.applyToFlaggedMessages = true;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_retention BEFORE INSERT ON folder_properties " +
      "WHEN NEW.id = " +
      db.folder.id +
      " AND NEW.name = 'applyToFlaggedMessages' BEGIN " +
      "SELECT RAISE(ABORT, 'retention write failure'); END"
  );
  try {
    Assert.throws(
      () => (db.msgRetentionSettings = settings),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    const stored = db.msgRetentionSettings;
    Assert.equal(stored.retainByPreference, 1);
    Assert.equal(stored.daysToKeepHdrs, 0);
    Assert.equal(stored.numHeadersToKeep, 0);
    Assert.equal(stored.useServerDefaults, true);
    Assert.equal(stored.applyToFlaggedMessages, false);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_retention");
  }
  db.msgRetentionSettings = settings;
  Assert.equal(db.msgRetentionSettings.daysToKeepHdrs, 7);
});

add_task(function test_retentionDoesNotCommitForeignTransaction() {
  const db = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("retention-transaction").msgDatabase;
  const settings = db.msgRetentionSettings;
  settings.daysToKeepHdrs = 12;
  const connection = database.connectionForTests;
  connection.beginTransaction();
  try {
    Assert.throws(
      () => (db.msgRetentionSettings = settings),
      /NS_ERROR_IN_PROGRESS/
    );
    Assert.ok(connection.transactionInProgress);
    Assert.equal(db.msgRetentionSettings.daysToKeepHdrs, 0);
  } finally {
    connection.rollbackTransaction();
  }
});

add_task(function test_folderRetentionUsesCurrentDefaults() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("retention-defaults");
  const defaults = folder.server.retentionSettings;
  defaults.numHeadersToKeep = 4;
  folder.server.retentionSettings = defaults;
  Assert.equal(folder.retentionSettings.numHeadersToKeep, 4);
  defaults.numHeadersToKeep = 5;
  folder.server.retentionSettings = defaults;
  Assert.equal(folder.retentionSettings.numHeadersToKeep, 5);
  const settings = folder.msgDatabase.msgRetentionSettings;
  settings.useServerDefaults = false;
  settings.numHeadersToKeep = 8;
  folder.retentionSettings = settings;
  Assert.equal(folder.retentionSettings.numHeadersToKeep, 8);
  Assert.equal(folder.msgDatabase.msgRetentionSettings.numHeadersToKeep, 8);
  folder.retentionSettings = null;
  Assert.equal(folder.retentionSettings.numHeadersToKeep, 8);
});

add_task(function test_retentionDoesNotHideStorageErrors() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("retention-read-error");
  const settings = folder.msgDatabase.msgRetentionSettings;
  settings.useServerDefaults = false;
  settings.numHeadersToKeep = 6;
  folder.retentionSettings = settings;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "ALTER TABLE folder_properties RENAME TO unavailable_folder_properties"
  );
  try {
    Assert.throws(
      () => folder.retentionSettings,
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => (folder.retentionSettings = settings),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_folder_properties RENAME TO folder_properties"
    );
  }
  Assert.equal(folder.retentionSettings.numHeadersToKeep, 6);
});

add_task(function test_deletedFolderCannotReadOrWriteRetention() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("retention-deleted-folder");
  const db = folder.msgDatabase;
  const settings = db.msgRetentionSettings;
  folderDB.deleteFolder(folder.id);
  Assert.throws(() => db.msgRetentionSettings, /NS_ERROR_NOT_AVAILABLE/);
  Assert.throws(
    () => (db.msgRetentionSettings = settings),
    /NS_ERROR_NOT_AVAILABLE/
  );
});

add_task(function test_countRetentionUsesDateThenPhysicalKey() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("retention-count");
  const db = folder.msgDatabase;
  const newest = addMessage({ folderId: folder.id, date: "2030-01-01" });
  const oldest = addMessage({ folderId: folder.id, date: "2000-01-01" });
  const tied = addMessage({ folderId: folder.id, date: "2000-01-01" });
  const settings = db.msgRetentionSettings;
  settings.retainByPreference =
    Ci.nsIMsgRetentionSettings.nsMsgRetainByNumHeaders;
  settings.numHeadersToKeep = 2;
  db.applyRetentionSettings(settings, false);
  Assert.deepEqual(db.listAllKeys(), [newest, tied]);
  Assert.ok(!db.containsKey(oldest));
  Assert.ok(folder.getStringProperty("LastPurgeTime"));
});

add_task(function test_countRetentionProtectsFlaggedMessages() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("retention-flagged");
  const db = folder.msgDatabase;
  const marked = addMessage({
    folderId: folder.id,
    date: "2000-01-01",
    flags: Ci.nsMsgMessageFlags.Marked,
  });
  const oldest = addMessage({ folderId: folder.id, date: "2001-01-01" });
  const newest = addMessage({ folderId: folder.id, date: "2030-01-01" });
  const settings = db.msgRetentionSettings;
  settings.retainByPreference =
    Ci.nsIMsgRetentionSettings.nsMsgRetainByNumHeaders;
  settings.numHeadersToKeep = 2;
  db.applyRetentionSettings(settings, false);
  Assert.deepEqual(db.listAllKeys(), [marked, newest]);
  Assert.ok(!db.containsKey(oldest));
  settings.applyToFlaggedMessages = true;
  settings.numHeadersToKeep = 1;
  db.applyRetentionSettings(settings, false);
  Assert.deepEqual(db.listAllKeys(), [newest]);
});

add_task(function test_ageRetentionAndMaximumAge() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("retention-age");
  const db = folder.msgDatabase;
  const old = addMessage({ folderId: folder.id, date: "2000-01-01" });
  const future = addMessage({ folderId: folder.id, date: "2100-01-01" });
  const settings = db.msgRetentionSettings;
  settings.retainByPreference = Ci.nsIMsgRetentionSettings.nsMsgRetainByAge;
  settings.daysToKeepHdrs = 0xffffffff;
  db.applyRetentionSettings(settings, false);
  Assert.deepEqual(db.listAllKeys(), [old, future]);
  settings.daysToKeepHdrs = 1;
  db.applyRetentionSettings(settings, false);
  Assert.deepEqual(db.listAllKeys(), [future]);
});

add_task(function test_retentionProtectsDraftDescendants() {
  const parent = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("retention-drafts");
  parent.setFlag(Ci.nsMsgFolderFlags.Drafts);
  const folder = parent
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("child");
  const key = addMessage({ folderId: folder.id, date: "2000-01-01" });
  const settings = folder.msgDatabase.msgRetentionSettings;
  settings.retainByPreference =
    Ci.nsIMsgRetentionSettings.nsMsgRetainByNumHeaders;
  settings.numHeadersToKeep = 0;
  folder.msgDatabase.applyRetentionSettings(settings, false);
  Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
});

add_task(function test_invalidRetentionCannotDelete() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("retention-invalid");
  const db = folder.msgDatabase;
  const key = addMessage({ folderId: folder.id });
  const settings = db.msgRetentionSettings;
  settings.retainByPreference = 99;
  Assert.throws(
    () => db.applyRetentionSettings(settings, false),
    /NS_ERROR_ILLEGAL_VALUE/
  );
  Assert.deepEqual(db.listAllKeys(), [key]);
});

add_task(function test_retentionStopsAtFailedRemoval() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("retention-delete-error");
  const db = folder.msgDatabase;
  const first = addMessage({ folderId: folder.id, date: "2000-01-01" });
  const blocked = addMessage({ folderId: folder.id, date: "2001-01-01" });
  const later = addMessage({ folderId: folder.id, date: "2002-01-01" });
  const settings = db.msgRetentionSettings;
  settings.retainByPreference =
    Ci.nsIMsgRetentionSettings.nsMsgRetainByNumHeaders;
  settings.numHeadersToKeep = 0;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_retention_delete BEFORE DELETE ON messages " +
      "WHEN OLD.id = " +
      blocked +
      " BEGIN " +
      "SELECT RAISE(ABORT, 'retention removal failure'); END"
  );
  try {
    Assert.throws(
      () => db.applyRetentionSettings(settings, false),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.ok(!db.containsKey(first));
    Assert.deepEqual(db.listAllKeys(), [blocked, later]);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_retention_delete");
  }
});

add_task(function test_publicRetentionDeletesViaFolder() {
  const { MessageGenerator } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
  );
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("retention-public");
  const header = folder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .addMessage(
      new MessageGenerator()
        .makeMessage({ subject: "expired", age: { days: 30 } })
        .toMessageString()
    );
  const settings = folder.msgDatabase.msgRetentionSettings;
  settings.useServerDefaults = false;
  settings.retainByPreference =
    Ci.nsIMsgRetentionSettings.nsMsgRetainByNumHeaders;
  settings.numHeadersToKeep = 0;
  folder.retentionSettings = settings;
  folder.applyRetentionSettings();
  Assert.ok(!folder.msgDatabase.containsKey(header.messageKey));
  Assert.equal(folder.getTotalMessages(false), 0);
});

add_task(function test_purgeTimestampFailurePreventsDeletion() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("retention-timestamp-error");
  const db = folder.msgDatabase;
  const key = addMessage({ folderId: folder.id, date: "2000-01-01" });
  const settings = db.msgRetentionSettings;
  settings.retainByPreference =
    Ci.nsIMsgRetentionSettings.nsMsgRetainByNumHeaders;
  settings.numHeadersToKeep = 0;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_purge_time BEFORE INSERT ON folder_properties " +
      "WHEN NEW.id = " +
      folder.id +
      " AND NEW.name = 'LastPurgeTime' BEGIN " +
      "SELECT RAISE(ABORT, 'purge timestamp failure'); END"
  );
  try {
    Assert.throws(
      () => db.applyRetentionSettings(settings, false),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.deepEqual(db.listAllKeys(), [key]);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_purge_time");
  }
});

add_task(function test_retentionAdmissionAndForeignTransactionStayReadOnly() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("retention-admission");
  const key = addMessage({ folderId: folder.id, date: "2000-01-01" });
  const db = folder.msgDatabase;
  const settings = db.msgRetentionSettings;
  settings.retainByPreference =
    Ci.nsIMsgRetentionSettings.nsMsgRetainByNumHeaders;
  settings.numHeadersToKeep = 0;
  const connection = database.connectionForTests;
  const source = database.sourceId;
  const update = connection.createStatement(
    "UPDATE database_identity SET sourceId = :source"
  );
  try {
    update.params.source = Services.uuid.generateUUID().toString();
    update.execute();
    for (const operation of [
      () => db.msgRetentionSettings,
      () => (db.msgRetentionSettings = settings),
      () => db.applyRetentionSettings(settings, false),
    ]) {
      Assert.throws(operation, /NS_ERROR_NOT_AVAILABLE/);
    }
    Assert.ok(db.containsKey(key));
  } finally {
    update.params.source = source;
    update.execute();
    update.finalize();
  }
  const purge = connection.createStatement(
    "SELECT 1 FROM folder_properties WHERE id = :id AND name = 'LastPurgeTime'"
  );
  try {
    purge.params.id = folder.id;
    Assert.ok(!purge.executeStep());
    purge.reset();
    connection.beginTransaction();
    try {
      Assert.throws(
        () => db.applyRetentionSettings(settings, false),
        /NS_ERROR_IN_PROGRESS/
      );
      Assert.ok(connection.transactionInProgress);
      Assert.deepEqual(db.listAllKeys(), [key]);
      purge.params.id = folder.id;
      Assert.ok(!purge.executeStep());
      purge.reset();
    } finally {
      connection.rollbackTransaction();
    }
  } finally {
    purge.finalize();
  }
});

add_task(
  function test_retentionDefaultReadsAndInputErrorsPreserveRawProperties() {
    const folder = rootFolder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder("retention-raw-presence");
    const db = folder.msgDatabase;
    const connection = database.connectionForTests;
    const read = connection.createStatement(
      "SELECT name, value, typeof(value) FROM folder_properties WHERE id = :id " +
        "AND name IN ('retainBy', 'daysToKeepHdrs', 'numHdrsToKeep', " +
        "'useServerDefaults', 'applyToFlaggedMessages') ORDER BY name"
    );
    const snapshot = () => {
      read.params.id = folder.id;
      const rows = [];
      try {
        while (read.executeStep()) {
          rows.push([
            read.getUTF8String(0),
            read.getInt64(1),
            read.getUTF8String(2),
          ]);
        }
        return rows;
      } finally {
        read.reset();
      }
    };
    try {
      const original = snapshot();
      const settings = db.msgRetentionSettings;
      Assert.equal(settings.daysToKeepHdrs, 0);
      Assert.deepEqual(
        snapshot(),
        original,
        "Default reads do not store defaults"
      );
      const broken = {
        QueryInterface: ChromeUtils.generateQI(["nsIMsgRetentionSettings"]),
        retainByPreference: Ci.nsIMsgRetentionSettings.nsMsgRetainByAge,
        get daysToKeepHdrs() {
          throw Components.Exception(
            "retention input fault",
            Cr.NS_ERROR_ABORT
          );
        },
      };
      Assert.throws(
        () => (db.msgRetentionSettings = broken),
        error => error.result === Cr.NS_ERROR_ABORT
      );
      Assert.deepEqual(
        snapshot(),
        original,
        "All settings are read before writes"
      );
      settings.daysToKeepHdrs = 0xffffffff;
      settings.numHeadersToKeep = 0;
      settings.useServerDefaults = false;
      settings.applyToFlaggedMessages = false;
      db.msgRetentionSettings = settings;
      Assert.deepEqual(snapshot(), [
        ["applyToFlaggedMessages", 0, "integer"],
        ["daysToKeepHdrs", 0xffffffff, "integer"],
        ["numHdrsToKeep", 0, "integer"],
        ["retainBy", 1, "integer"],
        ["useServerDefaults", 0, "integer"],
      ]);
    } finally {
      read.finalize();
    }
  }
);

add_task(function test_headerObjectCacheThresholdAndExternalViews() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("header-object-cache");
  const other = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("header-cache-bystander");
  const keys = [0, 1, 2].map(index =>
    addMessage({
      folderId: folder.id,
      messageId: `cache-${index}@cache.invalid`,
    })
  );
  const otherKey = addMessage({ folderId: other.id });
  const db = folder.msgDatabase;
  const otherDB = other.msgDatabase;
  const bystander = otherDB.getMsgHdrForKey(otherKey);
  Assert.equal(db.msgHdrCacheSize, 512);
  db.msgHdrCacheSize = 1;
  const first = db.getMsgHdrForKey(keys[0]);
  const second = db.getMsgHdrForKey(keys[1]);
  Assert.strictEqual(db.getMsgHdrForKey(keys[0]), first);
  Assert.strictEqual(db.getMsgHdrForMessageID(first.messageId), first);
  const third = db.getMsgHdrForKey(keys[2]);
  const freshFirst = db.getMsgHdrForKey(keys[0]);
  Assert.notStrictEqual(freshFirst, first);
  Assert.strictEqual(db.getMsgHdrForKey(keys[2]), third);
  db.resetHdrCacheSize(2);
  Assert.equal(db.msgHdrCacheSize, 1, "Reset never increases the threshold");
  Assert.strictEqual(db.getMsgHdrForKey(keys[0]), freshFirst);
  db.resetHdrCacheSize(0);
  Assert.equal(db.msgHdrCacheSize, 0);
  const one = db.getMsgHdrForKey(keys[0]);
  Assert.notStrictEqual(one, freshFirst);
  Assert.strictEqual(db.getMsgHdrForKey(keys[0]), one);
  db.getMsgHdrForKey(keys[1]);
  Assert.notStrictEqual(db.getMsgHdrForKey(keys[0]), one);
  db.msgHdrCacheSize = 0xffffffff;
  Assert.equal(db.msgHdrCacheSize, 0xffffffff);
  const beforeClear = db.getMsgHdrForKey(keys[0]);
  const enumerator = db.enumerateMessages();
  Assert.ok(enumerator.hasMoreElements());
  db.clearCachedHdrs();
  Assert.notStrictEqual(db.getMsgHdrForKey(keys[0]), beforeClear);
  Assert.equal(first.messageKey, keys[0]);
  Assert.equal(first.subject, "subject");
  first.subject = "External view remains live";
  Assert.equal(db.getMsgHdrForKey(keys[0]).subject, first.subject);
  Assert.equal(second.messageKey, keys[1]);
  Assert.strictEqual(otherDB.getMsgHdrForKey(otherKey), bystander);
  const enumerated = enumerator.getNext();
  Assert.strictEqual(db.getMsgHdrForKey(enumerated.messageKey), enumerated);
  Assert.deepEqual(db.listAllKeys(), keys);
  db.lastUseTime = 1;
  db.getMsgHdrForKey(keys[0]);
  Assert.greater(db.lastUseTime, 1);
});

add_task(function test_cachedHeadersRequirePhysicalMembershipAndSource() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("header-cache-admission");
  const other = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("header-cache-foreign");
  const key = addMessage({ folderId: folder.id });
  const db = folder.msgDatabase;
  const header = db.getMsgHdrForKey(key);
  const otherDB = other.msgDatabase;
  otherDB.refreshCache(other.URI, [key]);
  const hit = otherDB.getCachedHits(other.URI).getNext();
  Assert.strictEqual(hit.folder, folder);
  Assert.throws(() => otherDB.getMsgHdrForKey(key), /NS_ERROR_ILLEGAL_VALUE/);
  const connection = database.connectionForTests;
  const source = database.sourceId;
  const update = connection.createStatement(
    "UPDATE database_identity SET sourceId = :source"
  );
  try {
    update.params.source = Services.uuid.generateUUID().toString();
    update.execute();
    Assert.throws(() => db.getMsgHdrForKey(key), /NS_ERROR_NOT_AVAILABLE/);
  } finally {
    update.params.source = source;
    update.execute();
    update.finalize();
  }
  Assert.strictEqual(db.getMsgHdrForKey(key), header);
  connection.executeSimpleSQL(
    "ALTER TABLE messages RENAME TO unavailable_header_cache_messages"
  );
  try {
    Assert.throws(
      () => db.getMsgHdrForKey(key),
      error => error.result === Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_header_cache_messages RENAME TO messages"
    );
  }
  Assert.strictEqual(db.getMsgHdrForKey(key), header);
  Assert.strictEqual(header.folder, folder);
  db.deleteMessage(key, null, true);
  Assert.throws(() => db.getMsgHdrForKey(key), /NS_ERROR_ILLEGAL_VALUE/);
  db.clearCachedHdrs();
  Assert.strictEqual(header.folder, folder);
  Assert.ok(!db.containsKey(key));
});

add_task(function test_headerCacheKeepsCallerTransactionAndCloseScope() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("header-cache-lifetime");
  const key = addMessage({ folderId: folder.id });
  const db = folder.msgDatabase;
  const header = db.getMsgHdrForKey(key);
  const connection = database.connectionForTests;
  connection.beginTransaction();
  try {
    db.clearCachedHdrs();
    db.msgHdrCacheSize = 4;
    db.resetHdrCacheSize(2);
    Assert.equal(db.msgHdrCacheSize, 2);
    Assert.ok(connection.transactionInProgress);
    Assert.equal(db.getMsgHdrForKey(key).messageKey, key);
    Assert.ok(connection.transactionInProgress);
  } finally {
    connection.rollbackTransaction();
  }
  db.forceClosed();
  Assert.throws(() => db.getMsgHdrForKey(key), /NS_ERROR_NOT_AVAILABLE/);
  Assert.strictEqual(header.folder, folder);
  Assert.equal(header.subject, "subject");
  db.clearCachedHdrs();
  db.resetHdrCacheSize(0);
  Assert.equal(db.msgHdrCacheSize, 0);
  Assert.ok(!connection.transactionInProgress);
  const current = database
    .QueryInterface(Ci.nsIMsgDBService)
    .openFolderDB(folder, false);
  Assert.equal(current.msgHdrCacheSize, 512);
  Assert.notStrictEqual(current.getMsgHdrForKey(key), header);
  Assert.equal(current.getMsgHdrForKey(key).messageKey, key);
});

add_task(function test_bulkReadRequiresCurrentFolderAndSource() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("bulk-read-admission");
  const key = addMessage({ folderId: folder.id, flags: 0x40000004 });
  const db = folder.msgDatabase;
  const header = db.getMsgHdrForKey(key);
  const originalFlags = header.flags;
  assertRawAndPublicFlags(
    header,
    0x40000004,
    0x40000004 | Ci.nsMsgMessageFlags.New
  );
  const connection = database.connectionForTests;
  connection.beginTransaction();
  const update = connection.createStatement(
    "UPDATE database_identity SET sourceId = :source"
  );
  try {
    update.params.source = Services.uuid.generateUUID().toString();
    update.execute();
    Assert.throws(() => db.markAllRead(), /NS_ERROR_NOT_AVAILABLE/);
    Assert.ok(connection.transactionInProgress);
  } finally {
    update.finalize();
    connection.rollbackTransaction();
  }
  Assert.equal(header.flags, originalFlags);
  Assert.ok(!header.isRead);
  Assert.ok(!connection.transactionInProgress);
  Assert.ok(db.containsKey(key));
  db.forceClosed();
  Assert.throws(() => db.markAllRead(), /NS_ERROR_NOT_AVAILABLE/);
  assertRawAndPublicFlags(header, 0x40000004, 0x40000004);
  Assert.ok(!header.isRead);
});

add_task(function test_bulkReadPropagatesSourceReadFailure() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("bulk-read-source-error");
  const key = addMessage({ folderId: folder.id, flags: 0x40000004 });
  const db = folder.msgDatabase;
  const header = db.getMsgHdrForKey(key);
  const originalFlags = header.flags;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "ALTER TABLE database_identity RENAME TO unavailable_bulk_identity"
  );
  try {
    Assert.throws(
      () => db.markAllRead(),
      error => error.result === Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_bulk_identity RENAME TO database_identity"
    );
  }
  Assert.equal(header.flags, originalFlags);
  Assert.ok(!header.isRead);
  Assert.ok(db.containsKey(key));
  Assert.ok(!connection.transactionInProgress);
});

add_task(function test_fileMetadataKeepsPresenceWidthAndPhysicalIdentity() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("file-metadata");
  const other = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("file-metadata-bystander");
  const db = folder.msgDatabase;
  const info = db.dBFolderInfo;
  const otherInfo = other.msgDatabase.dBFolderInfo;
  const uri = folder.URI;
  const before = info.GetTransferInfo();
  Assert.ok(!before.hasKey("folderSize"));
  Assert.ok(!before.hasKey("folderDate"));
  Assert.equal(info.folderSize, 0);
  Assert.equal(info.folderDate, 0);
  Assert.ok(!info.GetTransferInfo().hasKey("folderSize"));
  Assert.ok(!info.GetTransferInfo().hasKey("folderDate"));
  otherInfo.folderSize = 27;
  otherInfo.folderDate = 31;
  for (const size of [
    0,
    -1,
    0x100000005,
    -0x100000005,
    Number.MAX_SAFE_INTEGER,
    -Number.MAX_SAFE_INTEGER,
  ]) {
    info.folderSize = size;
    Assert.equal(info.folderSize, size);
    Assert.equal(info.GetTransferInfo().getPropertyAsInt64("folderSize"), size);
    Assert.equal(otherInfo.folderSize, 27);
  }
  for (const date of [0, 0x80000000, 0xffffffff, 1]) {
    info.folderDate = date;
    Assert.equal(info.folderDate, date);
    Assert.equal(
      info.GetTransferInfo().getPropertyAsUint32("folderDate"),
      date
    );
    Assert.equal(otherInfo.folderDate, 31);
  }
  Assert.strictEqual(folder.parent, rootFolder);
  Assert.equal(folder.URI, uri);
  Assert.equal(info.numMessages, 0);
  Assert.equal(info.numUnreadMessages, 0);
  Assert.ok(info.GetTransferInfo().hasKey("folderSize"));
  Assert.ok(info.GetTransferInfo().hasKey("folderDate"));
  db.forceClosed();
  const reopened = folder.msgDatabase;
  Assert.notStrictEqual(reopened, db);
  Assert.equal(reopened.dBFolderInfo.folderSize, -Number.MAX_SAFE_INTEGER);
  Assert.equal(reopened.dBFolderInfo.folderDate, 1);
});

add_task(
  function test_fileMetadataPreservesStorageErrorsAndCallerTransaction() {
    const folder = rootFolder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder("file-metadata-errors");
    const db = folder.msgDatabase;
    const info = db.dBFolderInfo;
    const connection = database.connectionForTests;
    info.folderSize = 123;
    info.folderDate = 456;
    connection.beginTransaction();
    try {
      info.folderSize = -789;
      info.folderDate = 0xffffffff;
      Assert.equal(info.folderSize, -789);
      Assert.equal(info.folderDate, 0xffffffff);
      Assert.ok(connection.transactionInProgress);
    } finally {
      connection.rollbackTransaction();
    }
    Assert.equal(info.folderSize, 123);
    Assert.equal(info.folderDate, 456);
    info.folderSize = 987;
    connection.executeSimpleSQL(
      "ALTER TABLE folder_properties RENAME TO unavailable_file_properties"
    );
    try {
      for (const property of ["folderSize", "folderDate"]) {
        Assert.throws(
          () => info[property],
          error => error.result === Cr.NS_ERROR_FAILURE
        );
        Assert.throws(
          () => {
            info[property] = 555;
          },
          error => error.result === Cr.NS_ERROR_FAILURE
        );
      }
    } finally {
      connection.executeSimpleSQL(
        "ALTER TABLE unavailable_file_properties RENAME TO folder_properties"
      );
    }
    Assert.equal(info.folderSize, 987);
    Assert.equal(info.folderDate, 456);
    Assert.ok(!connection.transactionInProgress);
    db.forceClosed();
    Assert.throws(() => info.folderSize, /NS_ERROR_NOT_AVAILABLE/);
    Assert.throws(() => {
      info.folderDate = 2;
    }, /NS_ERROR_NOT_AVAILABLE/);
  }
);

add_task(function test_epochAccessRequiresTheCapturedSource() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("epoch-source-admission");
  const other = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("epoch-source-bystander");
  const key = addMessage({ folderId: folder.id });
  const db = folder.msgDatabase;
  const info = db.dBFolderInfo;
  const header = db.getMsgHdrForKey(key);
  const otherInfo = other.msgDatabase.dBFolderInfo;
  info.imapUidValidity = 0xffffffff;
  otherInfo.imapUidValidity = 17;
  header.setUint32Property("uidOnServer", 42);
  const connection = database.connectionForTests;
  const source = database.sourceId;
  const update = connection.createStatement(
    "UPDATE database_identity SET sourceId = :source"
  );
  try {
    update.params.source = Services.uuid.generateUUID().toString();
    update.execute();
    Assert.throws(() => info.imapUidValidity, /NS_ERROR_NOT_AVAILABLE/);
    Assert.throws(() => {
      info.imapUidValidity = 0;
    }, /NS_ERROR_NOT_AVAILABLE/);
  } finally {
    update.params.source = source;
    update.execute();
    update.finalize();
  }
  Assert.equal(info.imapUidValidity, 0xffffffff);
  Assert.equal(otherInfo.imapUidValidity, 17);
  Assert.equal(header.getUint32Property("uidOnServer"), 42);
  Assert.ok(header.properties.includes("uidOnServer"));
  Assert.deepEqual(db.listAllKeys(), [key]);
  connection.beginTransaction();
  try {
    Assert.equal(info.imapUidValidity, 0xffffffff);
    Assert.throws(() => {
      info.imapUidValidity = 0;
    }, /NS_ERROR_IN_PROGRESS/);
    Assert.ok(connection.transactionInProgress);
  } finally {
    connection.rollbackTransaction();
  }
  Assert.equal(info.imapUidValidity, 0xffffffff);
  Assert.equal(header.getUint32Property("uidOnServer"), 42);
  db.forceClosed();
  Assert.throws(() => info.imapUidValidity, /NS_ERROR_NOT_AVAILABLE/);
  Assert.throws(() => {
    info.imapUidValidity = 0;
  }, /NS_ERROR_NOT_AVAILABLE/);
  Assert.equal(otherInfo.imapUidValidity, 17);
});

add_task(function test_epochAccessPreservesSourceReaderErrors() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("epoch-source-error");
  const info = folder.msgDatabase.dBFolderInfo;
  info.imapUidValidity = 19;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "ALTER TABLE database_identity RENAME TO unavailable_epoch_identity"
  );
  try {
    Assert.throws(
      () => info.imapUidValidity,
      error => error.result === Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => {
        info.imapUidValidity = 20;
      },
      error => error.result === Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_epoch_identity RENAME TO database_identity"
    );
  }
  Assert.equal(info.imapUidValidity, 19);
  Assert.ok(!connection.transactionInProgress);
});

add_task(function test_readChangedUsesItsCurrentListeners() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("read-change-listeners");
  const db = folder.msgDatabase;
  const events = [];
  const late = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onReadChanged(instigator) {
      Assert.strictEqual(instigator.QueryInterface(Ci.nsIMsgFolder), folder);
      events.push("late");
    },
  };
  const removed = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onReadChanged() {
      Assert.ok(false, "A removed listener must not be notified");
    },
  };
  const first = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onReadChanged(instigator) {
      Assert.strictEqual(instigator.QueryInterface(Ci.nsIMsgFolder), folder);
      events.push("first");
      db.removeListener(removed);
      db.addListener(late);
    },
  };
  db.addListener(first);
  db.addListener(removed);
  try {
    db.notifyReadChanged(folder.QueryInterface(Ci.nsIDBChangeListener));
    Assert.deepEqual(events, ["first"]);
    db.notifyReadChanged(folder.QueryInterface(Ci.nsIDBChangeListener));
    Assert.deepEqual(events, ["first", "first", "late"]);
    Assert.deepEqual(
      db.listAllKeys(),
      [],
      "Notification does not publish data"
    );
  } finally {
    db.removeListener(first);
    db.removeListener(removed);
    db.removeListener(late);
  }
});

add_task(function test_readChangedStopsAtReentrantForceClose() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("read-change-close");
  const db = folder.msgDatabase;
  const events = [];
  const first = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onReadChanged(instigator) {
      Assert.strictEqual(instigator, null);
      events.push("first");
      db.forceClosed();
    },
    onAnnouncerGoingAway(source) {
      Assert.strictEqual(source, db);
      events.push("first-away");
    },
  };
  const second = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onReadChanged() {
      Assert.ok(false, "A force-closed wrapper must stop notifying");
    },
    onAnnouncerGoingAway(source) {
      Assert.strictEqual(source, db);
      events.push("second-away");
    },
  };
  db.addListener(first);
  db.addListener(second);
  try {
    db.notifyReadChanged(null);
    Assert.deepEqual(events, ["first", "first-away", "second-away"]);
    Assert.throws(() => db.notifyReadChanged(null), /NS_ERROR_NOT_AVAILABLE/);
    Assert.deepEqual(events, ["first", "first-away", "second-away"]);
  } finally {
    db.removeListener(first);
    db.removeListener(second);
  }
});

add_task(function test_readChangedRequiresItsFolderAndSource() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("read-change-admission");
  const db = folder.msgDatabase;
  const connection = database.connectionForTests;
  let calls = 0;
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onReadChanged() {
      calls++;
    },
  };
  db.addListener(listener);
  try {
    connection.beginTransaction();
    const update = connection.createStatement(
      "UPDATE database_identity SET sourceId = :source"
    );
    try {
      update.params.source = Services.uuid.generateUUID().toString();
      update.execute();
      Assert.throws(() => db.notifyReadChanged(null), /NS_ERROR_NOT_AVAILABLE/);
      Assert.ok(connection.transactionInProgress);
      Assert.equal(calls, 0);
    } finally {
      update.finalize();
      connection.rollbackTransaction();
    }
    for (const table of ["folders", "database_identity"]) {
      const temporary = `unavailable_read_change_${table}`;
      connection.executeSimpleSQL(
        `ALTER TABLE ${table} RENAME TO ${temporary}`
      );
      try {
        Assert.throws(
          () => db.notifyReadChanged(null),
          error => error.result === Cr.NS_ERROR_FAILURE
        );
        Assert.equal(calls, 0);
      } finally {
        connection.executeSimpleSQL(
          `ALTER TABLE ${temporary} RENAME TO ${table}`
        );
      }
    }
    connection.beginTransaction();
    try {
      db.notifyReadChanged(null);
      Assert.ok(connection.transactionInProgress);
      Assert.equal(calls, 1);
    } finally {
      connection.rollbackTransaction();
    }
  } finally {
    db.removeListener(listener);
  }
  rootFolder.propagateDelete(folder, true);
  Assert.throws(() => db.notifyReadChanged(null), /NS_ERROR_NOT_AVAILABLE/);
  Assert.equal(calls, 1);
  Assert.ok(!connection.transactionInProgress);
});

add_task(function test_junkScoreAnnouncementUsesOwningFolderAndAdmission() {
  const local = rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  const folder = local.createLocalSubfolder("junk-announcer");
  const other = local.createLocalSubfolder("junk-announcer-other");
  const db = database.openFolderDB(folder, false);
  const otherDB = database.openFolderDB(other, false);
  const events = [];
  let calls = 0;
  let away = 0;
  let closeOnNotify = false;
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onJunkScoreChanged(instigator) {
      Assert.strictEqual(instigator.QueryInterface(Ci.nsIMsgFolder), folder);
      calls++;
      if (closeOnNotify) {
        db.forceClosed();
      }
    },
    onAnnouncerGoingAway(source) {
      Assert.strictEqual(source, db);
      away++;
    },
  };
  const folderListener = {
    QueryInterface: ChromeUtils.generateQI(["nsIFolderListener"]),
    onFolderEvent(changed, event) {
      if (changed == folder || changed == other) {
        events.push([changed.URI, event]);
      }
    },
  };
  const target = folder.QueryInterface(Ci.nsIDBChangeListener);
  const bystander = other.QueryInterface(Ci.nsIDBChangeListener);
  // Folder initialization already registered target; put the closing listener first.
  db.removeListener(target);
  db.addListener(listener);
  db.addListener(target);
  otherDB.addListener(bystander);
  MailServices.mailSession.AddFolderListener(
    folderListener,
    Ci.nsIFolderListener.event
  );
  try {
    const connection = database.connectionForTests;
    connection.beginTransaction();
    const update = connection.createStatement(
      "UPDATE database_identity SET sourceId = :source"
    );
    try {
      update.params.source = Services.uuid.generateUUID().toString();
      update.execute();
      Assert.throws(
        () => db.notifyJunkScoreChanged(target),
        /NS_ERROR_NOT_AVAILABLE/
      );
      Assert.ok(connection.transactionInProgress);
      Assert.equal(calls, 0);
      Assert.deepEqual(events, []);
    } finally {
      update.finalize();
      connection.rollbackTransaction();
    }
    connection.executeSimpleSQL(
      "ALTER TABLE database_identity RENAME TO unavailable_junk_identity"
    );
    try {
      Assert.throws(
        () => db.notifyJunkScoreChanged(target),
        error => error.result === Cr.NS_ERROR_FAILURE
      );
      Assert.equal(calls, 0);
      Assert.deepEqual(events, []);
    } finally {
      connection.executeSimpleSQL(
        "ALTER TABLE unavailable_junk_identity RENAME TO database_identity"
      );
    }
    db.notifyJunkScoreChanged(target);
    Assert.equal(calls, 1);
    Assert.deepEqual(events, [[folder.URI, "JunkStatusChanged"]]);
    Assert.deepEqual(db.listAllKeys(), []);
    Assert.deepEqual(otherDB.listAllKeys(), []);
    Assert.equal(db.dBFolderInfo.numMessages, 0);
    Assert.equal(db.dBFolderInfo.numUnreadMessages, 0);
    Assert.strictEqual(folder.parent, rootFolder);
    closeOnNotify = true;
    db.notifyJunkScoreChanged(target);
    Assert.equal(calls, 2);
    Assert.equal(away, 1);
    Assert.deepEqual(events, [[folder.URI, "JunkStatusChanged"]]);
    Assert.throws(
      () => db.notifyJunkScoreChanged(target),
      /NS_ERROR_NOT_AVAILABLE/
    );
    Assert.equal(calls, 2);
    otherDB.notifyJunkScoreChanged(null);
    Assert.deepEqual(events, [
      [folder.URI, "JunkStatusChanged"],
      [other.URI, "JunkStatusChanged"],
    ]);
    Assert.deepEqual(otherDB.listAllKeys(), []);
    Assert.ok(!connection.transactionInProgress);
  } finally {
    MailServices.mailSession.RemoveFolderListener(folderListener);
    db.removeListener(listener);
    db.removeListener(target);
    otherDB.removeListener(bystander);
  }
});

add_task(function test_bulkReadCommitsAllRowsBeforeScopedFlagCallbacks() {
  const local = rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  const folder = local.createLocalSubfolder("bulk-read-captured");
  const other = local.createLocalSubfolder("bulk-read-captured-other");
  const db = folder.msgDatabase;
  const otherDB = other.msgDatabase;
  const initial = [0x40000004, 0, Ci.nsMsgMessageFlags.Read];
  const headers = initial.map((flags, index) => {
    const draft = db.createNewHdr();
    draft.messageId = `bulk-captured-${index}@read.invalid`;
    draft.flags = flags;
    return db.attachHdr(draft, false);
  });
  const foreignDraft = otherDB.createNewHdr();
  foreignDraft.messageId = "bulk-captured-foreign@read.invalid";
  const foreign = otherDB.attachHdr(foreignDraft, false);
  const keys = headers.slice(0, 2).map(header => header.messageKey);
  Assert.deepEqual(db.getNewList(), keys);
  const changes = [];
  const connection = database.connectionForTests;
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged(header, before, after, instigator) {
      Assert.strictEqual(instigator, null);
      Assert.ok(!connection.transactionInProgress);
      Assert.ok(headers.every(candidate => candidate.isRead));
      changes.push([header.messageKey, before, after]);
    },
  };
  const bystander = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged() {
      Assert.ok(false, "Bulk read must not notify another physical folder");
    },
  };
  db.addListener(listener);
  otherDB.addListener(bystander);
  try {
    Assert.deepEqual(
      db.markAllRead(),
      keys.toSorted((a, b) => a - b)
    );
    Assert.deepEqual(changes, [
      [
        keys[0],
        initial[0] | Ci.nsMsgMessageFlags.New,
        initial[0] | Ci.nsMsgMessageFlags.Read,
      ],
      [
        keys[1],
        initial[1] | Ci.nsMsgMessageFlags.New,
        Ci.nsMsgMessageFlags.Read,
      ],
    ]);
    Assert.deepEqual(db.getNewList(), []);
    Assert.ok(!db.hasNew());
    Assert.equal(db.dBFolderInfo.numMessages, 3);
    Assert.equal(db.dBFolderInfo.numUnreadMessages, 0);
    for (const [index, header] of headers.entries()) {
      const raw = initial[index] | Ci.nsMsgMessageFlags.Read;
      assertRawAndPublicFlags(header, raw, raw);
    }
    Assert.ok(!foreign.isRead);
    Assert.deepEqual(otherDB.getNewList(), [foreign.messageKey]);
    Assert.equal(otherDB.dBFolderInfo.numUnreadMessages, 1);
    const beforeNoOp = changes.slice();
    Assert.deepEqual(db.markAllRead(), []);
    Assert.deepEqual(changes, beforeNoOp, "A no-op has no flag callbacks");
  } finally {
    db.removeListener(listener);
    otherDB.removeListener(bystander);
  }
});

add_task(function test_bulkReadFailureAndReentrantCapturedOrder() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("bulk-read-rollback");
  const db = folder.msgDatabase;
  const headers = [0, 1].map(index => {
    const draft = db.createNewHdr();
    draft.messageId = `bulk-rollback-${index}@read.invalid`;
    return db.attachHdr(draft, false);
  });
  const keys = headers.map(header => header.messageKey);
  Assert.ok(headers.every(header => !header.isRead));
  Assert.deepEqual(db.getNewList(), keys);
  const connection = database.connectionForTests;
  const changes = [];
  let reenter = false;
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged(header, before, after) {
      changes.push([header.messageKey, before, after]);
      Assert.ok(!connection.transactionInProgress);
      if (reenter && changes.length == 1) {
        Assert.ok(headers.every(candidate => candidate.isRead));
        db.markRead(keys[1], false, null);
      }
    },
  };
  db.addListener(listener);
  try {
    connection.beginTransaction();
    try {
      Assert.throws(
        () => db.markAllRead(),
        error => error.result === Cr.NS_ERROR_IN_PROGRESS
      );
      Assert.ok(connection.transactionInProgress);
      Assert.deepEqual(db.getNewList(), keys);
      Assert.deepEqual(changes, []);
    } finally {
      connection.rollbackTransaction();
    }
    connection.executeSimpleSQL(
      `CREATE TEMP TRIGGER reject_bulk_read_103 BEFORE UPDATE OF flags ON messages
       WHEN OLD.id = ${keys[1]}
       BEGIN SELECT RAISE(ABORT, 'bulk read fault'); END`
    );
    try {
      Assert.throws(
        () => db.markAllRead(),
        error => error.result === Cr.NS_ERROR_STORAGE_CONSTRAINT
      );
      Assert.ok(!connection.transactionInProgress);
      Assert.ok(headers.every(header => !header.isRead));
      Assert.deepEqual(db.getNewList(), keys);
      Assert.deepEqual(changes, [], "Failed bulk writes have no callbacks");
      Assert.equal(db.dBFolderInfo.numUnreadMessages, 2);
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER reject_bulk_read_103");
    }
    reenter = true;
    Assert.deepEqual(
      db.markAllRead(),
      keys.toSorted((a, b) => a - b)
    );
    Assert.deepEqual(changes, [
      [keys[0], Ci.nsMsgMessageFlags.New, Ci.nsMsgMessageFlags.Read],
      [keys[1], Ci.nsMsgMessageFlags.New, Ci.nsMsgMessageFlags.Read],
      [keys[1], Ci.nsMsgMessageFlags.Read, 0],
    ]);
    Assert.deepEqual(db.getNewList(), []);
    assertRawAndPublicFlags(
      headers[0],
      Ci.nsMsgMessageFlags.Read,
      Ci.nsMsgMessageFlags.Read
    );
    assertRawAndPublicFlags(headers[1], 0, 0);
    Assert.ok(headers[0].isRead);
    Assert.ok(!headers[1].isRead);
    Assert.equal(db.dBFolderInfo.numUnreadMessages, 1);
    Assert.equal(db.dBFolderInfo.numMessages, 2);
  } finally {
    db.removeListener(listener);
  }
});

add_task(function test_notNewErrorsPreservePhysicalMembershipAndNewList() {
  const local = rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  const folder = local.createLocalSubfolder("not-new-admission");
  const other = local.createLocalSubfolder("not-new-admission-other");
  const db = folder.msgDatabase;
  const otherDB = other.msgDatabase;
  const draft = db.createNewHdr();
  draft.messageId = "not-new-owned@read.invalid";
  draft.flags = Ci.nsMsgMessageFlags.New | 0x40000004;
  const header = db.attachHdr(draft, false);
  const foreignDraft = otherDB.createNewHdr();
  foreignDraft.messageId = "not-new-foreign@read.invalid";
  foreignDraft.flags = Ci.nsMsgMessageFlags.New;
  const foreign = otherDB.attachHdr(foreignDraft, false);
  const before = db.getNewList();
  const flags = header.flags;
  const foreignFlags = foreign.flags;
  const connection = database.connectionForTests;
  connection.beginTransaction();
  try {
    Assert.throws(
      () => db.markNotNew(header.messageKey, null),
      error => error.result === Cr.NS_ERROR_IN_PROGRESS
    );
    Assert.ok(connection.transactionInProgress);
    Assert.deepEqual(db.getNewList(), before);
    Assert.equal(header.flags, flags);
  } finally {
    connection.rollbackTransaction();
  }
  connection.beginTransaction();
  const update = connection.createStatement(
    "UPDATE database_identity SET sourceId = :source"
  );
  try {
    update.params.source = Services.uuid.generateUUID().toString();
    update.execute();
    Assert.throws(
      () => db.markNotNew(header.messageKey, null),
      /NS_ERROR_NOT_AVAILABLE/
    );
    Assert.ok(connection.transactionInProgress);
    Assert.deepEqual(db.getNewList(), before);
  } finally {
    update.finalize();
    connection.rollbackTransaction();
  }
  connection.executeSimpleSQL(
    `CREATE TEMP TRIGGER reject_not_new_104 BEFORE UPDATE OF flags ON messages
     WHEN OLD.id = ${header.messageKey}
     BEGIN SELECT RAISE(ABORT, 'not new fault'); END`
  );
  try {
    Assert.throws(
      () => db.markNotNew(header.messageKey, null),
      error => error.result === Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.deepEqual(db.getNewList(), before);
    Assert.equal(header.flags, flags);
    Assert.ok(!connection.transactionInProgress);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_not_new_104");
  }
  Assert.throws(
    () => db.markNotNew(foreign.messageKey, null),
    /NS_ERROR_ILLEGAL_VALUE/
  );
  Assert.deepEqual(db.getNewList(), before);
  Assert.equal(foreign.flags, foreignFlags);
  Assert.deepEqual(otherDB.getNewList(), [foreign.messageKey]);
  db.forceClosed();
  Assert.throws(
    () => db.markNotNew(header.messageKey, null),
    /NS_ERROR_NOT_AVAILABLE/
  );
  Assert.equal(header.flags, flags);
  Assert.strictEqual(header.folder, folder);
  Assert.ok(!connection.transactionInProgress);
});

add_task(function test_notNewNoOpAndReentrantNewListMutation() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("not-new-reentrant");
  const db = folder.msgDatabase;
  const plain = db.createNewHdr();
  plain.messageId = "not-new-no-raw-bit@read.invalid";
  const withoutBit = db.attachHdr(plain, false);
  Assert.deepEqual(db.getNewList(), [withoutBit.messageKey]);
  db.markNotNew(withoutBit.messageKey, null);
  Assert.deepEqual(
    db.getNewList(),
    [],
    "A raw flag no-op still clears NewList"
  );
  const draft = db.createNewHdr();
  draft.messageId = "not-new-reentrant@read.invalid";
  draft.flags = Ci.nsMsgMessageFlags.New | 0x40000004;
  const header = db.attachHdr(draft, false);
  let calls = 0;
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged(changed, before, after) {
      Assert.equal(changed.messageKey, header.messageKey);
      Assert.equal(before, Ci.nsMsgMessageFlags.New | 0x40000004);
      Assert.equal(after, 0x40000004);
      Assert.deepEqual(db.getNewList(), []);
      calls++;
      db.addToNewList(header.messageKey);
    },
  };
  db.addListener(listener);
  try {
    db.markNotNew(header.messageKey, null);
    Assert.equal(calls, 1);
    Assert.deepEqual(
      db.getNewList(),
      [header.messageKey],
      "The completed caller must preserve a listener's later re-addition"
    );
    const statement = database.connectionForTests.createStatement(
      "SELECT flags FROM messages WHERE id = :key"
    );
    try {
      statement.params.key = header.messageKey;
      Assert.ok(statement.executeStep());
      Assert.equal(statement.getInt64(0), 0x40000004);
      Assert.ok(!statement.executeStep());
    } finally {
      statement.finalize();
    }
  } finally {
    db.removeListener(listener);
  }
});

add_task(function test_keyFlagSettersRequireCurrentPhysicalFolder() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("key-flag-admission");
  const other = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("key-flag-bystander");
  const db = folder.msgDatabase;
  const otherDB = other.msgDatabase;
  const draft = db.createNewHdr();
  draft.messageId = "key-flag-owned@read.invalid";
  draft.flags = 0x40000000;
  const header = db.attachHdr(draft, false);
  const foreignDraft = otherDB.createNewHdr();
  foreignDraft.messageId = "key-flag-foreign@read.invalid";
  foreignDraft.flags = 0x40000000;
  const foreign = otherDB.attachHdr(foreignDraft, false);
  const setters = [
    ["markMDNNeeded", Ci.nsMsgMessageFlags.MDNReportNeeded],
    ["markMDNSent", Ci.nsMsgMessageFlags.MDNReportSent],
    ["markMarked", Ci.nsMsgMessageFlags.Marked],
    ["markReplied", Ci.nsMsgMessageFlags.Replied],
    ["markForwarded", Ci.nsMsgMessageFlags.Forwarded],
    ["markRedirected", Ci.nsMsgMessageFlags.Redirected],
    ["markHasAttachments", Ci.nsMsgMessageFlags.Attachment],
    ["markOffline", Ci.nsMsgMessageFlags.Offline],
    ["markImapDeleted", Ci.nsMsgMessageFlags.IMAPDeleted],
  ];
  const calls = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged(changed, before, after) {
      Assert.equal(changed.messageKey, header.messageKey);
      Assert.strictEqual(changed.folder, folder);
      calls.push([before, after]);
    },
  };
  db.addListener(listener);
  const connection = database.connectionForTests;
  try {
    for (const [method, flag] of setters) {
      db[method](header.messageKey, true, null);
      assertRawAndPublicFlags(
        header,
        0x40000000 | flag,
        0x40000000 | flag | Ci.nsMsgMessageFlags.New
      );
      db[method](header.messageKey, false, null);
      assertRawAndPublicFlags(
        header,
        0x40000000,
        0x40000000 | Ci.nsMsgMessageFlags.New
      );
      Assert.deepEqual(calls.splice(0), [
        [
          0x40000000 | Ci.nsMsgMessageFlags.New,
          0x40000000 | flag | Ci.nsMsgMessageFlags.New,
        ],
        [
          0x40000000 | flag | Ci.nsMsgMessageFlags.New,
          0x40000000 | Ci.nsMsgMessageFlags.New,
        ],
      ]);
    }
    for (const [method] of setters) {
      Assert.throws(
        () => db[method](foreign.messageKey, true, null),
        /NS_ERROR_ILLEGAL_VALUE/,
        `${method} cannot mutate another physical folder`
      );
      assertRawAndPublicFlags(
        foreign,
        0x40000000,
        0x40000000 | Ci.nsMsgMessageFlags.New
      );
      Assert.deepEqual(otherDB.getNewList(), [foreign.messageKey]);
    }
    connection.beginTransaction();
    try {
      for (const [method] of setters) {
        Assert.throws(
          () => db[method](header.messageKey, true, null),
          error => error.result === Cr.NS_ERROR_IN_PROGRESS,
          `${method} preserves the caller transaction`
        );
        Assert.ok(connection.transactionInProgress);
        assertRawAndPublicFlags(
          header,
          0x40000000,
          0x40000000 | Ci.nsMsgMessageFlags.New
        );
      }
    } finally {
      connection.rollbackTransaction();
    }
    connection.executeSimpleSQL(
      `CREATE TEMP TRIGGER reject_key_flags_105 BEFORE UPDATE OF flags ON messages
       WHEN OLD.id = ${header.messageKey}
       BEGIN SELECT RAISE(ABORT, 'key flags fault'); END`
    );
    try {
      for (const [method] of setters) {
        Assert.throws(
          () => db[method](header.messageKey, true, null),
          error => error.result === Cr.NS_ERROR_STORAGE_CONSTRAINT,
          `${method} propagates the original write error`
        );
        assertRawAndPublicFlags(
          header,
          0x40000000,
          0x40000000 | Ci.nsMsgMessageFlags.New
        );
        Assert.ok(!connection.transactionInProgress);
      }
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER reject_key_flags_105");
    }
    connection.beginTransaction();
    const update = connection.createStatement(
      "UPDATE database_identity SET sourceId = :source"
    );
    try {
      update.params.source = Services.uuid.generateUUID().toString();
      update.execute();
      for (const [method] of setters) {
        Assert.throws(
          () => db[method](header.messageKey, true, null),
          /NS_ERROR_NOT_AVAILABLE/,
          `${method} refuses another database incarnation`
        );
        Assert.ok(connection.transactionInProgress);
      }
    } finally {
      update.finalize();
      connection.rollbackTransaction();
    }
    for (const [method] of setters) {
      Assert.throws(
        () => db[method](0xffffffff, true, null),
        /NS_ERROR_ILLEGAL_VALUE/,
        `${method} refuses a missing published key`
      );
    }
    assertRawAndPublicFlags(
      header,
      0x40000000,
      0x40000000 | Ci.nsMsgMessageFlags.New
    );
    Assert.deepEqual(db.getNewList(), [header.messageKey]);
    Assert.deepEqual(calls, []);
    db.forceClosed();
    for (const [method] of setters) {
      Assert.throws(
        () => db[method](header.messageKey, true, null),
        /NS_ERROR_NOT_AVAILABLE/,
        `${method} refuses a force-closed wrapper`
      );
    }
    Assert.equal(header.flags, 0x40000000);
    assertRawAndPublicFlags(
      foreign,
      0x40000000,
      0x40000000 | Ci.nsMsgMessageFlags.New
    );
    Assert.ok(!connection.transactionInProgress);
  } finally {
    db.removeListener(listener);
  }
});

add_task(function test_keyFlagQueriesRequireCurrentPhysicalFolder() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("key-flag-query-admission");
  const other = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("key-flag-query-bystander");
  const db = folder.msgDatabase;
  const otherDB = other.msgDatabase;
  const draft = db.createNewHdr();
  draft.messageId = "key-flag-query-owned@read.invalid";
  const header = db.attachHdr(draft, false);
  const foreignDraft = otherDB.createNewHdr();
  foreignDraft.messageId = "key-flag-query-foreign@read.invalid";
  foreignDraft.flags =
    Ci.nsMsgMessageFlags.Marked |
    Ci.nsMsgMessageFlags.Attachment |
    Ci.nsMsgMessageFlags.MDNReportSent;
  const foreign = otherDB.attachHdr(foreignDraft, false);
  const queries = [
    ["isMarked", "markMarked"],
    ["hasAttachments", "markHasAttachments"],
    ["isMDNSent", "markMDNSent"],
  ];
  for (const [query, setter] of queries) {
    Assert.strictEqual(db[query](header.messageKey), false);
    db[setter](header.messageKey, true, null);
    Assert.strictEqual(db[query](header.messageKey), true);
  }
  for (const [query] of queries) {
    Assert.throws(
      () => db[query](foreign.messageKey),
      /NS_ERROR_ILLEGAL_VALUE/,
      `${query} cannot read another physical folder through this wrapper`
    );
  }
  const connection = database.connectionForTests;
  connection.beginTransaction();
  try {
    for (const [query] of queries) {
      Assert.strictEqual(db[query](header.messageKey), true);
      Assert.ok(connection.transactionInProgress);
    }
  } finally {
    connection.rollbackTransaction();
  }
  connection.beginTransaction();
  const update = connection.createStatement(
    "UPDATE database_identity SET sourceId = :source"
  );
  try {
    update.params.source = Services.uuid.generateUUID().toString();
    update.execute();
    for (const [query] of queries) {
      Assert.throws(
        () => db[query](header.messageKey),
        /NS_ERROR_NOT_AVAILABLE/,
        `${query} refuses another database incarnation`
      );
      Assert.ok(connection.transactionInProgress);
    }
  } finally {
    update.finalize();
    connection.rollbackTransaction();
  }
  connection.executeSimpleSQL(
    "ALTER TABLE messages RENAME TO held_messages_105"
  );
  try {
    for (const [query] of queries) {
      Assert.throws(
        () => db[query](header.messageKey),
        error => error.result === Cr.NS_ERROR_FAILURE,
        `${query} propagates the original lookup failure`
      );
    }
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE held_messages_105 RENAME TO messages"
    );
  }
  for (const [query] of queries) {
    Assert.strictEqual(db[query](header.messageKey), true);
    Assert.throws(() => db[query](0xffffffff), /NS_ERROR_ILLEGAL_VALUE/);
  }
  db.forceClosed();
  for (const [query] of queries) {
    Assert.throws(() => db[query](header.messageKey), /NS_ERROR_NOT_AVAILABLE/);
    Assert.strictEqual(otherDB[query](foreign.messageKey), true);
  }
  Assert.ok(!connection.transactionInProgress);
});
add_task(function test_userSortOrderPersistsWithoutChangingPhysicalOrder() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("stored-user-sort");
  const other = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("stored-user-sort-control");
  const id = folder.id;
  const info = folder.msgDatabase.dBFolderInfo;
  const otherInfo = other.msgDatabase.dBFolderInfo;
  const connection = database.connectionForTests;
  const readStored = () => {
    const row = connection.createStatement(
      "SELECT value, typeof(value) FROM folder_properties " +
        "WHERE id=:id AND name='userSortOrder'"
    );
    try {
      row.params.id = id;
      return row.executeStep() ? [row.getInt64(0), row.getUTF8String(1)] : null;
    } finally {
      row.finalize();
    }
  };
  const readOrdinal = () => {
    const row = connection.createStatement(
      "SELECT ordinal FROM folders WHERE id=:id"
    );
    try {
      row.params.id = id;
      Assert.ok(row.executeStep());
      return row.getIsNull(0) ? null : row.getInt64(0);
    } finally {
      row.finalize();
    }
  };
  const ordinal = readOrdinal();
  Assert.equal(info.userSortOrder, Ci.nsIMsgFolder.NO_SORT_VALUE);
  Assert.equal(folder.userSortOrder, Ci.nsIMsgFolder.NO_SORT_VALUE);
  Assert.equal(readStored(), null, "Reading a default does not create a row");
  otherInfo.userSortOrder = 29;
  for (const value of [0, 7, 0xffffffff]) {
    info.userSortOrder = value;
    Assert.equal(info.userSortOrder, value);
    Assert.equal(folder.userSortOrder, value);
    Assert.deepEqual(readStored(), [value, "integer"]);
  }
  for (const invalid of [-1, 0x100000000]) {
    info.setInt64Property("userSortOrder", invalid);
    for (const read of [
      () => info.userSortOrder,
      () => folder.userSortOrder,
      () => folder.sortOrder,
    ]) {
      Assert.throws(
        read,
        error => error.result == Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA
      );
    }
    Assert.deepEqual(readStored(), [invalid, "integer"]);
  }
  info.userSortOrder = 7;
  connection.executeSimpleSQL(
    `CREATE TEMP TRIGGER reject_user_sort BEFORE INSERT ON folder_properties
     WHEN NEW.id=${id} AND NEW.name='userSortOrder' AND NEW.value=9
     BEGIN SELECT RAISE(ABORT, 'user sort fault'); END`
  );
  try {
    Assert.throws(
      () => (folder.userSortOrder = 9),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.equal(info.userSortOrder, 7);
    Assert.equal(
      folder.userSortOrder,
      7,
      "Failed writes do not replace the cache"
    );
    Assert.deepEqual(readStored(), [7, "integer"]);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_user_sort");
  }
  connection.beginTransaction();
  try {
    folder.userSortOrder = 11;
    Assert.ok(connection.transactionInProgress);
    Assert.equal(info.userSortOrder, 11);
    Assert.equal(folder.userSortOrder, 11);
    Assert.ok(connection.transactionInProgress);
  } finally {
    connection.rollbackTransaction();
  }
  Assert.equal(folder.userSortOrder, 7, "Rollback is read from storage");
  connection.executeSimpleSQL(
    "ALTER TABLE folder_properties RENAME TO held_user_sort_properties"
  );
  try {
    for (const call of [
      () => info.userSortOrder,
      () => folder.userSortOrder,
      () => folder.sortOrder,
      () => (info.userSortOrder = 13),
      () => (folder.userSortOrder = 13),
    ]) {
      Assert.throws(call, error => error.result == Cr.NS_ERROR_FAILURE);
    }
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE held_user_sort_properties RENAME TO folder_properties"
    );
  }
  Assert.equal(folder.userSortOrder, 7);
  connection.beginTransaction();
  try {
    connection.executeSimpleSQL(
      "UPDATE database_identity SET sourceId = '{87654321-4321-4321-4321-cba987654321}'"
    );
    for (const call of [
      () => info.userSortOrder,
      () => folder.userSortOrder,
      () => (info.userSortOrder = 17),
      () => (folder.userSortOrder = 17),
    ]) {
      Assert.throws(call, error => error.result == Cr.NS_ERROR_NOT_AVAILABLE);
    }
    Assert.ok(connection.transactionInProgress);
  } finally {
    connection.rollbackTransaction();
  }
  folder.msgDatabase.forceClosed();
  Assert.equal(folder.msgDatabase.dBFolderInfo.userSortOrder, 7);
  Assert.equal(folder.userSortOrder, 7);
  Assert.equal(otherInfo.userSortOrder, 29);
  Assert.equal(
    readOrdinal(),
    ordinal,
    "The native ordinal is a different field"
  );
  Assert.equal(folder.id, id);
  Assert.strictEqual(folder.parent, rootFolder);
  Assert.deepEqual(readStored(), [7, "integer"]);
});

add_task(function test_serverRootSortOrderUsesNativeMetadata() {
  const folder = rootFolder;
  Assert.ok(folder.isServer);
  const id = folder.id;
  const connection = database.connectionForTests;
  const readStored = () => {
    const row = connection.createStatement(
      "SELECT value, typeof(value) FROM folder_properties " +
        "WHERE id=:id AND name='userSortOrder'"
    );
    try {
      row.params.id = id;
      return row.executeStep() ? [row.getInt64(0), row.getUTF8String(1)] : null;
    } finally {
      row.finalize();
    }
  };
  Assert.equal(folder.userSortOrder, Ci.nsIMsgFolder.NO_SORT_VALUE);
  Assert.equal(
    readStored(),
    null,
    "Reading root metadata does not create a row"
  );
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  const info = service.openFolderDB(folder, false).dBFolderInfo;
  for (const value of [0, 0x80000001, 0xffffffff]) {
    folder.userSortOrder = value;
    Assert.equal(folder.userSortOrder, value);
    Assert.equal(info.userSortOrder, value);
    Assert.deepEqual(readStored(), [value, "integer"]);
  }
  for (const invalid of [-1, 0x100000000]) {
    info.setInt64Property("userSortOrder", invalid);
    Assert.throws(
      () => folder.userSortOrder,
      error => error.result == Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA
    );
    Assert.deepEqual(readStored(), [invalid, "integer"]);
  }
  info.userSortOrder = 7;
  Assert.equal(folder.userSortOrder, 7, "Direct metadata writes are visible");
  connection.beginTransaction();
  try {
    folder.userSortOrder = 11;
    Assert.ok(connection.transactionInProgress);
    Assert.equal(folder.userSortOrder, 11);
    Assert.equal(info.userSortOrder, 11);
    Assert.ok(connection.transactionInProgress);
  } finally {
    connection.rollbackTransaction();
  }
  Assert.equal(
    folder.userSortOrder,
    7,
    "Caller rollback remains authoritative"
  );
  connection.executeSimpleSQL(
    `CREATE TEMP TRIGGER reject_root_user_sort BEFORE INSERT ON folder_properties
     WHEN NEW.id=${id} AND NEW.name='userSortOrder' AND NEW.value=13
     BEGIN SELECT RAISE(ABORT, 'root user sort fault'); END`
  );
  try {
    Assert.throws(
      () => (folder.userSortOrder = 13),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.equal(folder.userSortOrder, 7);
    Assert.deepEqual(readStored(), [7, "integer"]);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_root_user_sort");
  }
  connection.executeSimpleSQL(
    "ALTER TABLE folder_properties RENAME TO held_root_sort_properties"
  );
  try {
    Assert.throws(
      () => folder.userSortOrder,
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => (folder.userSortOrder = 17),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE held_root_sort_properties RENAME TO folder_properties"
    );
  }
  connection.beginTransaction();
  try {
    connection.executeSimpleSQL(
      "UPDATE database_identity SET sourceId = '{87654321-4321-4321-4321-cba987654321}'"
    );
    for (const call of [
      () => folder.userSortOrder,
      () => (folder.userSortOrder = 19),
    ]) {
      Assert.throws(call, error => error.result == Cr.NS_ERROR_NOT_AVAILABLE);
    }
    Assert.ok(connection.transactionInProgress);
  } finally {
    connection.rollbackTransaction();
  }
  service.forceFolderDBClosed(folder);
  Assert.equal(folder.userSortOrder, 7, "Root metadata survives facade reopen");
  Assert.equal(folder.id, id);
  Assert.ok(folder.isServer);
  Assert.deepEqual(readStored(), [7, "integer"]);
});

/**
 * Read physical folder metadata and exact stored property types and values.
 *
 * @param {number} id - Physical folder ID, including a retired folder ID.
 * @returns {Array<Array>} The folder row and stored property rows.
 */
function storedFolderInfoState(id) {
  const connection = database.connectionForTests;
  const folder = connection.createStatement(
    "SELECT parent, name, flags FROM folders WHERE id = :id"
  );
  let row = null;
  try {
    folder.params.id = id;
    if (folder.executeStep()) {
      row = [folder.row.parent, folder.row.name, folder.row.flags];
    }
  } finally {
    folder.finalize();
  }
  const properties = connection.createStatement(
    "SELECT name, typeof(value) AS type, CAST(value AS TEXT) AS text " +
      "FROM folder_properties WHERE id = :id ORDER BY name"
  );
  const rows = [];
  try {
    properties.params.id = id;
    while (properties.executeStep()) {
      rows.push([
        properties.row.name,
        properties.row.type,
        properties.row.text,
      ]);
    }
  } finally {
    properties.finalize();
  }
  return [row, rows];
}

/**
 * Enumerate persisted property access through the public folder-info facade.
 *
 * @param {nsIDBFolderInfo} info - The retained facade to exercise.
 * @param {nsIPropertyBag2} transfer - A valid native transfer bag.
 * @returns {Array<Array>} Named operations and their callbacks.
 */
function folderInfoPropertyOperations(info, transfer) {
  return [
    ["generic char read", () => info.getCharProperty("guardedMetadata.char")],
    [
      "generic char write",
      () => info.setCharProperty("guardedMetadata.char", "changed"),
    ],
    ["generic text read", () => info.getProperty("guardedMetadata.text")],
    [
      "generic text write",
      () => info.setProperty("guardedMetadata.text", "changed"),
    ],
    [
      "generic uint32 read",
      () => info.getUint32Property("guardedMetadata.uint", 19),
    ],
    [
      "generic uint32 write",
      () => info.setUint32Property("guardedMetadata.uint", 20),
    ],
    [
      "generic int64 read",
      () => info.getInt64Property("guardedMetadata.int", -19),
    ],
    [
      "generic int64 write",
      () => info.setInt64Property("guardedMetadata.int", -20),
    ],
    [
      "generic boolean read",
      () => info.getBooleanProperty("guardedMetadata.bool", false),
    ],
    [
      "generic boolean write",
      () => info.setBooleanProperty("guardedMetadata.bool", true),
    ],
    ["flags read", () => info.flags],
    [
      "flags write",
      () => {
        info.flags = Ci.nsMsgFolderFlags.Mail;
      },
    ],
    ["or flags", () => info.orFlags(Ci.nsMsgFolderFlags.Favorite)],
    ["and flags", () => info.andFlags(Ci.nsMsgFolderFlags.Mail)],
    ["folder name read", () => info.folderName],
    [
      "folder name write",
      () => {
        info.folderName = "changed";
      },
    ],
    ["mailbox name read", () => info.mailboxName],
    [
      "mailbox name write",
      () => {
        info.mailboxName = "changed";
      },
    ],
    ["known articles read", () => info.knownArtsSet],
    [
      "known articles write",
      () => {
        info.knownArtsSet = "1-7";
      },
    ],
    ["view flags read", () => info.viewFlags],
    [
      "view flags write",
      () => {
        info.viewFlags = Ci.nsMsgViewFlagsType.kThreadedDisplay;
      },
    ],
    ["sort type read", () => info.sortType],
    [
      "sort type write",
      () => {
        info.sortType = Ci.nsMsgViewSortType.byDate;
      },
    ],
    ["sort order read", () => info.sortOrder],
    [
      "sort order write",
      () => {
        info.sortOrder = Ci.nsMsgViewSortOrder.ascending;
      },
    ],
    ["view type read", () => info.viewType],
    [
      "view type write",
      () => {
        info.viewType = Ci.nsMsgViewType.eShowAllThreads;
      },
    ],
    ["high water read", () => info.highWater],
    [
      "high water write",
      () => {
        info.highWater = 17;
      },
    ],
    ["version read", () => info.version],
    [
      "version write",
      () => {
        info.version = 17;
      },
    ],
    ["expunged bytes read", () => info.expungedBytes],
    [
      "expunged bytes write",
      () => {
        info.expungedBytes = 17;
      },
    ],
    ["folder size read", () => info.folderSize],
    [
      "folder size write",
      () => {
        info.folderSize = 17;
      },
    ],
    ["folder date read", () => info.folderDate],
    [
      "folder date write",
      () => {
        info.folderDate = 17;
      },
    ],
    ["sort position read", () => info.userSortOrder],
    [
      "sort position write",
      () => {
        info.userSortOrder = 17;
      },
    ],
    ["total pending read", () => info.imapTotalPendingMessages],
    [
      "total pending write",
      () => {
        info.imapTotalPendingMessages = 17;
      },
    ],
    ["unread pending read", () => info.imapUnreadPendingMessages],
    [
      "unread pending write",
      () => {
        info.imapUnreadPendingMessages = 17;
      },
    ],
    ["transfer read", () => info.GetTransferInfo()],
    ["transfer write", () => info.initFromTransferInfo(transfer)],
  ];
}

add_task(
  function test_folderInfoPropertiesKeepTypedPersistenceAndCallerTransaction() {
    const folder = rootFolder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder("guarded-property-types");
    const other = rootFolder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder("guarded-property-types-other");
    const id = folder.id;
    const info = folder.msgDatabase.dBFolderInfo;
    const connection = database.connectionForTests;
    const unrelated = storedFolderInfoState(other.id);
    const before = storedFolderInfoState(id);
    Assert.equal(info.getCharProperty("guardedMetadata.char"), "");
    Assert.equal(info.getProperty("guardedMetadata.text"), "");
    Assert.equal(info.getUint32Property("guardedMetadata.uint", 19), 19);
    Assert.equal(info.getInt64Property("guardedMetadata.int", -19), -19);
    Assert.equal(info.getBooleanProperty("guardedMetadata.bool", true), true);
    Assert.deepEqual(storedFolderInfoState(id), before);
    info.setCharProperty("guardedMetadata.char", "");
    info.setProperty("guardedMetadata.text", "café 日本語 📧");
    info.setUint32Property("guardedMetadata.uint", 0xffffffff);
    info.setInt64Property("guardedMetadata.int", -0x100000001);
    info.setBooleanProperty("guardedMetadata.bool", false);
    const stored = storedFolderInfoState(id);
    Assert.deepEqual(
      stored[1].filter(([name]) => name.startsWith("guardedMetadata.")),
      [
        ["guardedMetadata.bool", "integer", "0"],
        ["guardedMetadata.char", "text", ""],
        ["guardedMetadata.int", "integer", "-4294967297"],
        ["guardedMetadata.text", "text", "café 日本語 📧"],
        ["guardedMetadata.uint", "integer", "4294967295"],
      ]
    );
    connection.beginTransaction();
    try {
      info.setCharProperty("guardedMetadata.char", "line\nπ");
      info.setProperty("guardedMetadata.text", "");
      info.setUint32Property("guardedMetadata.uint", 0);
      info.setInt64Property("guardedMetadata.int", 0x100000002);
      info.setBooleanProperty("guardedMetadata.bool", true);
      Assert.equal(info.getCharProperty("guardedMetadata.char"), "line\nπ");
      Assert.equal(info.getProperty("guardedMetadata.text"), "");
      Assert.equal(info.getUint32Property("guardedMetadata.uint", 19), 0);
      Assert.equal(
        info.getInt64Property("guardedMetadata.int", -19),
        0x100000002
      );
      Assert.equal(
        info.getBooleanProperty("guardedMetadata.bool", false),
        true
      );
      Assert.ok(connection.transactionInProgress);
    } finally {
      connection.rollbackTransaction();
    }
    Assert.deepEqual(storedFolderInfoState(id), stored);
    for (const invalid of [-1, 0x100000000]) {
      info.setInt64Property("guardedMetadata.uint", invalid);
      Assert.throws(
        () => info.getUint32Property("guardedMetadata.uint", 19),
        error => error.result == Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA
      );
      Assert.equal(info.getInt64Property("guardedMetadata.uint", 0), invalid);
    }
    info.setUint32Property("guardedMetadata.uint", 0xffffffff);
    Cc["@mozilla.org/msgDatabase/msgDBService;1"]
      .getService(Ci.nsIMsgDBService)
      .forceFolderDBClosed(folder);
    const reopened = folder.msgDatabase.dBFolderInfo;
    Assert.equal(reopened.getCharProperty("guardedMetadata.char"), "");
    Assert.equal(
      reopened.getProperty("guardedMetadata.text"),
      "café 日本語 📧"
    );
    Assert.equal(
      reopened.getUint32Property("guardedMetadata.uint", 19),
      0xffffffff
    );
    Assert.equal(
      reopened.getInt64Property("guardedMetadata.int", -19),
      -0x100000001
    );
    Assert.equal(
      reopened.getBooleanProperty("guardedMetadata.bool", true),
      false
    );
    Assert.equal(folder.id, id);
    Assert.deepEqual(storedFolderInfoState(id), stored);
    Assert.deepEqual(storedFolderInfoState(other.id), unrelated);
  }
);

add_task(function test_folderInfoPropertiesRejectClosedAndDeletedOwners() {
  for (const state of ["closed", "deleted"]) {
    const folder = rootFolder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder(`guarded-property-${state}`);
    const id = folder.id;
    const db = folder.msgDatabase;
    const info = db.dBFolderInfo;
    info.setCharProperty("guardedMetadata.char", "retained");
    const transfer = info.GetTransferInfo();
    const file = folder.filePath;
    const existed = file.exists();
    if (state == "closed") {
      db.forceClosed();
    } else {
      folderDB.deleteFolder(id);
    }
    const afterRetirement = storedFolderInfoState(id);
    for (const [name, operation] of folderInfoPropertyOperations(
      info,
      transfer
    )) {
      Assert.throws(
        operation,
        error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
        `${state}: ${name} cannot use a retired folder-info facade`
      );
      Assert.deepEqual(storedFolderInfoState(id), afterRetirement);
    }
    Assert.equal(
      file.exists(),
      existed,
      "Rejected properties do not alter the body path"
    );
  }
});

add_task(
  function test_folderInfoPropertiesRequireCapturedSourceAndKeepFirstErrors() {
    const folder = rootFolder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder("guarded-property-source");
    const other = rootFolder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder("guarded-property-source-other");
    const id = folder.id;
    const info = folder.msgDatabase.dBFolderInfo;
    info.setCharProperty("guardedMetadata.char", "retained");
    const transfer = info.GetTransferInfo();
    const operations = folderInfoPropertyOperations(info, transfer);
    const before = storedFolderInfoState(id);
    const unrelated = storedFolderInfoState(other.id);
    const connection = database.connectionForTests;
    connection.beginTransaction();
    try {
      const update = connection.createStatement(
        "UPDATE database_identity SET sourceId = :source"
      );
      try {
        update.params.source = Services.uuid.generateUUID().toString();
        update.execute();
      } finally {
        update.finalize();
      }
      for (const [name, operation] of operations) {
        Assert.throws(
          operation,
          error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
          `${name} requires the facade's captured source`
        );
        Assert.deepEqual(storedFolderInfoState(id), before);
        Assert.ok(connection.transactionInProgress);
      }
    } finally {
      connection.rollbackTransaction();
    }
    connection.executeSimpleSQL(
      "ALTER TABLE database_identity RENAME TO held_property_identity"
    );
    try {
      for (const [name, operation] of operations) {
        Assert.throws(
          operation,
          error => error.result == Cr.NS_ERROR_FAILURE,
          `${name} preserves the source-reader failure`
        );
        Assert.deepEqual(storedFolderInfoState(id), before);
      }
    } finally {
      connection.executeSimpleSQL(
        "ALTER TABLE held_property_identity RENAME TO database_identity"
      );
    }
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER reject_guarded_property BEFORE INSERT ON folder_properties " +
        `WHEN NEW.id = ${id} AND NEW.name GLOB 'guardedMetadata.*' ` +
        "BEGIN SELECT RAISE(ABORT, 'property write fault'); END"
    );
    connection.beginTransaction();
    try {
      for (const [name, operation] of operations.filter(
        ([label]) => label.startsWith("generic ") && label.endsWith(" write")
      )) {
        Assert.throws(
          operation,
          error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT,
          `${name} preserves the actual write error`
        );
        Assert.ok(connection.transactionInProgress);
        Assert.deepEqual(storedFolderInfoState(id), before);
      }
    } finally {
      connection.rollbackTransaction();
      connection.executeSimpleSQL("DROP TRIGGER reject_guarded_property");
    }
    connection.executeSimpleSQL(
      "ALTER TABLE folder_properties RENAME TO held_guarded_properties"
    );
    try {
      for (const [name, operation] of operations.filter(([label]) =>
        label.startsWith("generic ")
      )) {
        Assert.throws(
          operation,
          error => error.result == Cr.NS_ERROR_FAILURE,
          `${name} does not treat a property-table error as absence`
        );
      }
    } finally {
      connection.executeSimpleSQL(
        "ALTER TABLE held_guarded_properties RENAME TO folder_properties"
      );
    }
    Assert.ok(!connection.transactionInProgress);
    Assert.equal(info.getCharProperty("guardedMetadata.char"), "retained");
    Assert.deepEqual(storedFolderInfoState(id), before);
    Assert.deepEqual(storedFolderInfoState(other.id), unrelated);
  }
);

add_task(function test_publicFlagsFollowCanonicalNewList() {
  const local = rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  const folder = local.createLocalSubfolder("public-status-canonical");
  const other = local.createLocalSubfolder("public-status-foreign");
  const db = folder.msgDatabase;
  const otherDB = other.msgDatabase;
  const { New, Read } = Ci.nsMsgMessageFlags;
  const rawWords = [0, 0x80000004, New, Read | New, Read];
  const headers = rawWords.map((flags, index) => {
    const draft = db.createNewHdr();
    draft.messageId = `status-canonical-${index}@invalid`;
    draft.flags = flags;
    return db.attachHdr(draft, false);
  });
  const keys = headers.map(header => header.messageKey);
  const cachedHeaders = keys.map(key => db.getMsgHdrForKey(key));
  Assert.deepEqual(db.getNewList(), keys.slice(0, 3));
  for (const [index, header] of headers.entries()) {
    assertRawAndPublicFlags(
      header,
      rawWords[index],
      rawWords[index] | (index < 3 ? New : 0)
    );
    Assert.strictEqual(
      db.getMsgHdrForKey(header.messageKey),
      cachedHeaders[index]
    );
    Assert.equal(cachedHeaders[index].messageKey, header.messageKey);
    Assert.strictEqual(cachedHeaders[index].folder, folder);
  }
  const events = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged(header, before, after) {
      events.push([header.messageKey, before, after]);
    },
  };
  db.addListener(listener);
  try {
    db.clearNewList(false);
    Assert.deepEqual(db.getNewList(), []);
    Assert.deepEqual(events, [], "Silent clear sends no ordinary flag events");
    for (const [index, header] of headers.entries()) {
      assertRawAndPublicFlags(header, rawWords[index], rawWords[index]);
    }
    db.addToNewList(keys[0]);
    db.addToNewList(keys[0]);
    Assert.deepEqual(db.getNewList(), [keys[0]]);
    assertRawAndPublicFlags(headers[0], 0, New);
    const foreign = otherDB.attachHdr(otherDB.createNewHdr(), false);
    Assert.throws(
      () => db.addToNewList(foreign.messageKey),
      /NS_ERROR_ILLEGAL_VALUE/
    );
    Assert.throws(() => db.addToNewList(0xffffffff), /NS_ERROR_ILLEGAL_VALUE/);
    const staged = db.createNewHdr();
    Assert.throws(
      () => db.addToNewList(staged.messageKey),
      /NS_ERROR_ILLEGAL_VALUE/
    );
    Assert.deepEqual(db.getNewList(), [keys[0]]);
    Assert.deepEqual(otherDB.getNewList(), [foreign.messageKey]);
    const copyDraft = otherDB.copyHdrFromExistingHdr(
      0xffffffff,
      headers[0],
      false
    );
    Assert.equal(
      copyDraft.flags,
      0,
      "A structural copy retains the raw source word"
    );
    const copy = otherDB.attachHdr(copyDraft, false);
    assertRawAndPublicFlags(copy, 0, New);
    assertRawAndPublicFlags(headers[0], 0, New);

    const connection = database.connectionForTests;
    connection.beginTransaction();
    const update = connection.createStatement(
      "UPDATE database_identity SET sourceId = :source"
    );
    try {
      update.params.source = Services.uuid.generateUUID().toString();
      update.execute();
      Assert.throws(() => headers[0].flags, /NS_ERROR_NOT_AVAILABLE/);
      Assert.throws(() => db.clearNewList(true), /NS_ERROR_NOT_AVAILABLE/);
      Assert.throws(() => db.clearNewList(false), /NS_ERROR_NOT_AVAILABLE/);
      Assert.throws(() => db.addToNewList(keys[1]), /NS_ERROR_NOT_AVAILABLE/);
      Assert.deepEqual(db.getNewList(), [keys[0]]);
      Assert.ok(connection.transactionInProgress);
      Assert.deepEqual(events, []);
    } finally {
      update.finalize();
      connection.rollbackTransaction();
    }
    assertRawAndPublicFlags(headers[0], 0, New);
  } finally {
    db.removeListener(listener);
  }
  db.forceClosed();
  Assert.strictEqual(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"]
      .getService(Ci.nsIMsgDBService)
      .cachedDBForFolder(folder),
    null
  );
  assertRawAndPublicFlags(headers[0], 0, 0);
  Assert.strictEqual(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"]
      .getService(Ci.nsIMsgDBService)
      .cachedDBForFolder(folder),
    null,
    "Reading status did not open a replacement facade"
  );
  const replacement = folder.msgDatabase;
  Assert.notStrictEqual(replacement, db);
  const current = replacement.getMsgHdrForKey(keys[0]);
  Assert.notStrictEqual(current, cachedHeaders[0]);
  Assert.strictEqual(replacement.getMsgHdrForKey(keys[0]), current);
  Assert.equal(current.messageKey, headers[0].messageKey);
  Assert.strictEqual(current.folder, folder);
  Assert.deepEqual(replacement.getNewList(), []);
  replacement.addToNewList(keys[1]);
  assertRawAndPublicFlags(headers[0], 0, 0);
  assertRawAndPublicFlags(headers[1], rawWords[1], rawWords[1] | New);
  Assert.throws(() => db.clearNewList(true), /NS_ERROR_NOT_AVAILABLE/);
  Assert.deepEqual(replacement.getNewList(), [keys[1]]);
});

add_task(function test_publicFlagCallbacksKeepRealViewNewStatus() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("public-status-real-view");
  const db = folder.msgDatabase;
  const { New, Read, Marked, Offline } = Ci.nsMsgMessageFlags;
  // nsMsgDBView.h: standalone roots retain MSG_VIEW_FLAG_ISTHREAD in the row.
  const viewThread = 0x08000000;
  const events = [];
  const added = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrAdded(header, parent, flags) {
      added.push([header.messageKey, parent, flags]);
      assertRawAndPublicFlags(header, 0, New);
    },
    onHdrFlagsChanged(header, before, after) {
      events.push([header.messageKey, before, after]);
    },
  };
  db.addListener(listener);
  const view = Cc[
    "@mozilla.org/messenger/msgdbview;1?type=threaded"
  ].createInstance(Ci.nsIMsgDBView);
  view.init(null, null);
  try {
    const draft = db.createNewHdr();
    draft.messageId = "status-real-view@invalid";
    const header = db.attachHdr(draft, true);
    const key = header.messageKey;
    Assert.deepEqual(added, [[key, 0xffffffff, New]]);
    view.open(
      folder,
      Ci.nsMsgViewSortType.byDate,
      Ci.nsMsgViewSortOrder.ascending,
      0
    );
    Assert.equal(view.QueryInterface(Ci.nsITreeView).rowCount, 1);
    Assert.equal(view.getMsgHdrAt(0).messageKey, header.messageKey);
    Assert.strictEqual(view.getMsgHdrAt(0).folder, folder);
    Assert.equal(view.getFlagsAt(0), viewThread | New);
    header.markFlagged(true);
    assertRawAndPublicFlags(header, Marked, New | Marked);
    Assert.equal(view.getFlagsAt(0), viewThread | New | Marked);
    header.setStringProperty("keywords", "status-tag");
    header.messageSize = 27;
    Assert.equal(header.getStringProperty("keywords"), "status-tag");
    Assert.equal(header.messageSize, 27);
    Assert.equal(view.getFlagsAt(0), viewThread | New | Marked);
    db.markOffline(key, true, null);
    assertRawAndPublicFlags(header, Marked | Offline, New | Marked | Offline);
    Assert.equal(view.getFlagsAt(0), viewThread | New | Marked | Offline);
    db.markOffline(key, false, null);
    header.markRead(true);
    Assert.deepEqual(db.getNewList(), []);
    assertRawAndPublicFlags(header, Marked | Read, Marked | Read);
    Assert.equal(view.getFlagsAt(0), viewThread | Marked | Read);
    Assert.deepEqual(events, [
      [key, New, New | Marked],
      [key, New | Marked, New | Marked | Offline],
      [key, New | Marked | Offline, New | Marked],
      [key, New | Marked, Read | Marked],
    ]);
    header.markRead(true);
    Assert.equal(events.length, 4, "A raw/status no-op is silent");
    header.markRead(false);
    assertRawAndPublicFlags(header, Marked, Marked);
    Assert.equal(view.getFlagsAt(0), viewThread | Marked);
    db.addToNewList(key);
    db.markMarked(key, false, null);
    Assert.equal(view.getFlagsAt(0), viewThread | New);
    db.markNotNew(key, null);
    assertRawAndPublicFlags(header, 0, 0);
    Assert.equal(
      view.getFlagsAt(0),
      viewThread,
      "Membership-only MarkNotNew reaches the view"
    );
    const count = events.length;
    db.markNotNew(key, null);
    Assert.equal(events.length, count);
    db.addToNewList(key);
    header.markFlagged(true);
    Assert.equal(view.getFlagsAt(0), viewThread | New | Marked);
    db.clearNewList(true);
    assertRawAndPublicFlags(header, Marked, Marked);
    Assert.equal(
      view.getFlagsAt(0),
      viewThread | Marked,
      "Notifying clear updates the real row"
    );
  } finally {
    view.close();
    db.removeListener(listener);
  }
});

add_task(function test_clearNewListPinsPublicCallbacks() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("public-status-clear-reentrant");
  const db = folder.msgDatabase;
  const { New, Attachment } = Ci.nsMsgMessageFlags;
  const initial = [0, 0x40000004, New];
  const headers = initial.map((flags, index) => {
    const draft = db.createNewHdr();
    draft.messageId = `status-clear-${index}@invalid`;
    draft.flags = flags;
    return db.attachHdr(draft, false);
  });
  const keys = headers.map(header => header.messageKey);
  const first = [];
  const later = [];
  let reenter = true;
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged(header, before, after) {
      first.push([header.messageKey, before, after]);
      if (reenter) {
        reenter = false;
        Assert.deepEqual(db.getNewList(), []);
        db.addToNewList(keys[0]);
        headers[1].markHasAttachments(true);
        db.addToNewList(keys[1]);
      }
    },
  };
  const observer = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged(header, before, after) {
      later.push([header.messageKey, before, after, header.flags]);
    },
  };
  db.addListener(listener);
  db.addListener(observer);
  try {
    db.clearNewList(true);
    Assert.deepEqual(first, [
      [keys[0], New, 0],
      [keys[1], initial[1], initial[1] | Attachment],
      [keys[1], initial[1] | New, initial[1]],
    ]);
    Assert.deepEqual(later, [
      [keys[1], initial[1], initial[1] | Attachment, initial[1] | Attachment],
      [keys[0], New, 0, New],
      [keys[1], initial[1] | New, initial[1], initial[1] | Attachment | New],
    ]);
    Assert.deepEqual(db.getNewList(), keys.slice(0, 2));
    assertRawAndPublicFlags(headers[0], 0, New);
    assertRawAndPublicFlags(
      headers[1],
      initial[1] | Attachment,
      initial[1] | Attachment | New
    );
    assertRawAndPublicFlags(headers[2], New, New);
    Assert.ok(
      !first.some(event => event[0] == keys[2]),
      "Stored New is preserved without a synthetic flag event"
    );
  } finally {
    db.removeListener(listener);
    db.removeListener(observer);
  }
});

add_task(function test_publicStatusFanoutPreservesLaterMembershipAndClose() {
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("public-status-close-reentrant");
  const db = folder.msgDatabase;
  const { New, Read } = Ci.nsMsgMessageFlags;
  const draft = db.createNewHdr();
  draft.messageId = "status-close-reentrant@invalid";
  const header = db.attachHdr(draft, false);
  const key = header.messageKey;
  const events = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged(changed, before, after) {
      Assert.equal(changed.messageKey, header.messageKey);
      Assert.strictEqual(changed.folder, folder);
      Assert.equal(before, New);
      Assert.equal(after, Read);
      Assert.deepEqual(db.getNewList(), []);
      db.addToNewList(key);
    },
  };
  const observer = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged(changed, before, after) {
      events.push([before, after, changed.flags]);
      db.forceClosed();
    },
    onAnnouncerGoingAway() {},
  };
  db.addListener(listener);
  db.addListener(observer);
  try {
    header.markRead(true);
    Assert.deepEqual(events, [[New, Read, New | Read]]);
    assertRawAndPublicFlags(header, Read, Read);
    Assert.throws(() => db.addToNewList(key), /NS_ERROR_NOT_AVAILABLE/);
    Assert.deepEqual(db.getNewList(), []);
    Assert.strictEqual(
      Cc["@mozilla.org/msgDatabase/msgDBService;1"]
        .getService(Ci.nsIMsgDBService)
        .cachedDBForFolder(folder),
      null
    );
  } finally {
    db.removeListener(listener);
    db.removeListener(observer);
  }
});
