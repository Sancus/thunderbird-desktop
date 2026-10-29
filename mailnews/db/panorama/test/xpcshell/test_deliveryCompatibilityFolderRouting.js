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
