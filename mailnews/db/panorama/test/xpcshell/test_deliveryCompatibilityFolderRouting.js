/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

let root;
const raw =
  "From: sender@example.invalid\r\n" +
  "Message-ID: <routing@example.invalid>\r\n" +
  "Subject: Stored message\r\n\r\nBody\r\n";

function createFolder(name) {
  return root
    .createLocalSubfolder(name)
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
}

add_setup(function () {
  do_get_profile();
  const contract = "@mozilla.org/msgstore/berkeleystore;1";
  Services.prefs.setCharPref("mail.serverDefaultStoreContractID", contract);
  Services.prefs.setCharPref("mail.server.default.storeContractID", contract);
  loadExistingDB();
  Assert.equal(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"]
      .getService(Ci.nsIMsgDBService)
      .QueryInterface(Ci.nsIDatabaseCore),
    database
  );
  const account = MailServices.accounts.createLocalMailAccount();
  registerCleanupFunction(() => {
    MailServices.accounts.removeAccount(account, false);
    Services.prefs.clearUserPref("mail.serverDefaultStoreContractID");
    Services.prefs.clearUserPref("mail.server.default.storeContractID");
  });
  root = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  Assert.equal(root.server.getStringValue("storeContractID"), contract);
  Assert.equal(root.msgStore.storeType, "mbox");
});

add_task(function test_getFolderAndHeadersStayInTheirPhysicalFolder() {
  const first = createFolder("first");
  const second = createFolder("second");
  const firstHeader = first.addMessage(raw);
  const secondHeader = second.addMessage(raw);
  const db = first.msgDatabase;
  Assert.equal(db.folder, first);
  Assert.equal(db.folder, first);
  Assert.equal(second.msgDatabase.folder, second);
  Assert.equal(db.getMsgHdrForKey(firstHeader.messageKey).folder, first);
  Assert.equal(
    db.getMsgHdrForMessageID("routing@example.invalid").messageKey,
    firstHeader.messageKey
  );
  Assert.throws(
    () => db.getMsgHdrForKey(secondHeader.messageKey),
    /NS_ERROR_ILLEGAL_VALUE/
  );
  Assert.throws(
    () => db.setStringProperty(secondHeader.messageKey, "custom", "wrong"),
    /NS_ERROR_ILLEGAL_VALUE/
  );
  Assert.equal(secondHeader.getStringProperty("custom"), "");
  messageDB.removeMessage(firstHeader.messageKey);
  Assert.throws(
    () => db.getMsgHdrForKey(firstHeader.messageKey),
    /NS_ERROR_ILLEGAL_VALUE/,
    "A retained header must not make a deleted row available"
  );
});

add_task(function test_serverIDsUseExactPropertiesAndFolderMembership() {
  const first = createFolder("server-ids");
  const second = createFolder("other-server-ids");
  const header = first.addMessage(raw);
  const foreign = second.addMessage(raw);
  for (const item of [header, foreign]) {
    item.setStringProperty("X-GM-MSGID", "18446744073709551615");
    item.setStringProperty("ewsId", "AAMk+/=Opaque");
  }
  const db = first.msgDatabase;
  Assert.equal(
    db.getMsgHdrForGMMsgID("18446744073709551615").messageKey,
    header.messageKey
  );
  Assert.equal(db.getMsgHdrForEwsItemID("AAMk+/=Opaque").folder, first);
  Assert.equal(db.getMsgHdrForEwsItemID("aamk+/=opaque"), null);
  Assert.equal(db.getMsgHdrForGMMsgID(String(header.messageKey)), null);
  Assert.equal(db.getMsgHdrForEwsItemID(""), null);
  header.setStringProperty("ewsId", "");
  Assert.equal(db.getMsgHdrForEwsItemID("").messageKey, header.messageKey);
  const duplicate = first.addMessage(raw);
  duplicate.setStringProperty("X-GM-MSGID", "18446744073709551615");
  Assert.throws(
    () => db.getMsgHdrForGMMsgID("18446744073709551615"),
    /NS_ERROR_FILE_CORRUPTED/,
    "Ambiguous physical matches must not pick an arbitrary header"
  );
});

add_task(function test_listOfflineMessagesRequiresStoredCompleteContent() {
  const folder = createFolder("offline");
  const foreign = createFolder("foreign-offline");
  const complete = folder.addMessage(raw);
  const partial = folder.addMessage(raw);
  const online = folder.addMessage(raw);
  const noToken = folder.addMessage(raw);
  const other = foreign.addMessage(raw);
  for (const header of [complete, partial, noToken, other]) {
    header.orFlags(Ci.nsMsgMessageFlags.Offline);
  }
  partial.orFlags(Ci.nsMsgMessageFlags.Partial);
  noToken.storeToken = "";
  Assert.equal(folder.msgStore.storeType, "mbox");
  Assert.ok(complete.storeToken.length);
  Assert.ok(!(online.flags & Ci.nsMsgMessageFlags.Offline));
  Assert.deepEqual(folder.msgDatabase.listAllOfflineMsgs(), [
    complete.messageKey,
  ]);
  Assert.deepEqual(foreign.msgDatabase.listAllOfflineMsgs(), [
    other.messageKey,
  ]);
  Assert.ok(noToken.flags & Ci.nsMsgMessageFlags.Offline);
});

add_task(async function test_missingStoreDoesNotReportOfflineMessages() {
  const folder = createFolder("missing-store");
  const header = folder.addMessage(raw);
  header.orFlags(Ci.nsMsgMessageFlags.Offline);
  Assert.deepEqual(folder.msgDatabase.listAllOfflineMsgs(), [
    header.messageKey,
  ]);
  await IOUtils.remove(folder.filePath.path);
  Assert.deepEqual(folder.msgDatabase.listAllOfflineMsgs(), []);
  Assert.ok(header.flags & Ci.nsMsgMessageFlags.Offline);
});

add_task(function test_deletedFolderCannotReturnCachedObjects() {
  const folder = createFolder("deleted-folder");
  const header = folder.addMessage(raw);
  const db = folder.msgDatabase;
  Assert.equal(db.folder, folder);
  folderDB.deleteFolder(folder.id);
  Assert.throws(() => db.folder, /NS_ERROR_NOT_AVAILABLE/);
  Assert.throws(
    () => db.getMsgHdrForKey(header.messageKey),
    /NS_ERROR_NOT_AVAILABLE/
  );
  Assert.throws(() => db.listAllOfflineMsgs(), /NS_ERROR_NOT_AVAILABLE/);
});

add_task(function test_lookupStorageErrorsDoNotBecomeNotFound() {
  const folder = createFolder("lookup-error");
  const header = folder.addMessage(raw);
  header.setStringProperty("X-GM-MSGID", "stored-id");
  const db = folder.msgDatabase;
  Assert.equal(
    db.getMsgHdrForGMMsgID("stored-id").messageKey,
    header.messageKey
  );
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "ALTER TABLE messages RENAME TO unavailable_messages"
  );
  try {
    Assert.throws(
      () => db.getMsgHdrForGMMsgID("stored-id"),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => db.getMsgHdrForMessageID("routing@example.invalid"),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_messages RENAME TO messages"
    );
  }
  Assert.equal(
    db.getMsgHdrForGMMsgID("stored-id").messageKey,
    header.messageKey
  );
});

add_task(function test_logicalCodecPreservesPhysicalCachedWrappers() {
  const parent = createFolder("codec-parent");
  const other = createFolder("codec-other");
  const cases = [
    ["I/O stuff", "I%2FO stuff", "I%2FO%20stuff"],
    ["I%2FO stuff", "I%252FO stuff", "I%252FO%20stuff"],
    ["comp.lang.c++", "comp.lang.c++", "comp.lang.c++"],
    ["R&D (a=b);x,$+", "R&D (a=b);x,$+", "R%26D%20%28a%3Db%29%3Bx%2C%24+"],
    ["100% +?#süb", "100%25 +?#süb", "100%25%20+%3F%23s%C3%BCb"],
  ];
  const children = [];
  for (const [name, logicalName, uriName] of cases) {
    const id = folderDB.insertFolder(parent.id, name);
    const child = Cc[
      "@mozilla.org/mail/folder-factory;1?name=mailbox"
    ].createInstance(Ci.nsIMsgFolder);
    child.initWithFolderId(id);
    child.parent = parent;
    const uri = parent.URI + "/" + uriName;
    Assert.equal(child.path, parent.path + "/" + logicalName);
    Assert.equal(folderDB.getFolderByPath(child.path), id);
    Assert.equal(child.name, name);
    Assert.equal(child.URI, uri, "The logical codec is not escaped twice");
    Assert.equal(
      child.generateMessageURI(7),
      uri.replace("mailbox:", "mailbox-message:") + "#7"
    );
    Assert.strictEqual(MailServices.folderLookup.getFolderForURL(uri), child);
    Assert.strictEqual(
      MailServices.folderLookup.createFolderAndCache(parent, name),
      child,
      "The existing legacy URI encoder finds the identical native wrapper"
    );
    Assert.strictEqual(parent.addSubfolder(name), child);
    Assert.strictEqual(parent.addSubfolder(name), child);
    Assert.strictEqual(folderDB.getMsgFolderForFolder(id), child);
    Assert.equal(child.id, id);
    Assert.strictEqual(child.parent, parent);
    Assert.throws(
      () => child.initWithFolderId(id),
      /NS_ERROR_ALREADY_INITIALIZED/,
      "A cached wrapper cannot be rebound"
    );
    children.push(child);
  }
  Assert.deepEqual(parent.subFolders, children);
  Assert.equal(new Set(children.map(child => child.URI)).size, cases.length);
  Assert.equal(
    new Set(children.map(child => child.filePath.path)).size,
    cases.length,
    "Logical encoding does not change physical filename authority"
  );
  Assert.equal(
    MailServices.folderLookup.getFolderForURL(
      parent.URI + "/I%25252FO%20stuff"
    ),
    null,
    "There is no extra-escaped URI alias"
  );

  const id = folderDB.insertFolder(parent.id, "conflicting%2Fchild");
  const conflicting = Cc[
    "@mozilla.org/mail/folder-factory;1?name=mailbox"
  ].createInstance(Ci.nsIMsgFolder);
  conflicting.initWithFolderId(id);
  conflicting.parent = other;
  const uri = parent.URI + "/conflicting%252Fchild";
  try {
    Assert.throws(
      () => parent.addSubfolder("conflicting%2Fchild"),
      /NS_ERROR_UNEXPECTED/,
      "A URI hit must retain its exact physical parent guard"
    );
    Assert.equal(conflicting.id, id);
    Assert.strictEqual(conflicting.parent, other);
    Assert.strictEqual(
      MailServices.folderLookup.getFolderForURL(uri),
      conflicting
    );
    Assert.deepEqual(parent.subFolders, children);
    Assert.equal(folderDB.getFolderParent(id), parent.id);
  } finally {
    conflicting.parent = null;
    MailServices.folderLookup.evictFolder(conflicting);
  }
  Assert.equal(MailServices.folderLookup.getFolderForURL(uri), null);
  const replacement = parent.addSubfolder("conflicting%2Fchild");
  Assert.notEqual(replacement, conflicting);
  Assert.equal(replacement.id, id);
  Assert.strictEqual(replacement.parent, parent);
  Assert.equal(replacement.URI, uri);
  MailServices.folderLookup.evictFolder(conflicting);
  Assert.strictEqual(
    MailServices.folderLookup.getFolderForURL(uri),
    replacement
  );
  Assert.equal(conflicting.id, id);
  Assert.equal(conflicting.parent, null);
});
