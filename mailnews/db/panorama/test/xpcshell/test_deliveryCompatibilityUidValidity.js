/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

let root;
const raw =
  "From: sender@example.invalid\r\n" +
  "Message-ID: <epoch@example.invalid>\r\n" +
  "Subject: Epoch test\r\n\r\nRetained body\r\n";

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

add_task(function test_absentEpochIsZeroWithoutCreatingAProperty() {
  const folder = createFolder("absent-epoch");
  const info = folder.msgDatabase.dBFolderInfo;
  Assert.equal(info.imapUidValidity, 0);
  Assert.equal(info.getUint32Property("UIDValidity", 17), 17);
  info.imapUidValidity = 0;
  Assert.equal(info.imapUidValidity, 0);
  Assert.equal(info.getUint32Property("UIDValidity", 17), 0);
});

add_task(async function test_epochChangesRetireOnlyTheFoldersBindings() {
  const folder = createFolder("epochs");
  const other = createFolder("other-epochs");
  const header = folder.addMessage(raw);
  const foreign = other.addMessage(raw);
  const info = folder.msgDatabase.dBFolderInfo;
  const otherInfo = other.msgDatabase.dBFolderInfo;
  const bytes = await IOUtils.read(folder.filePath.path);
  header.setUint32Property("uidOnServer", 42);
  header.setStringProperty("custom", "retained");
  otherInfo.imapUidValidity = 7;
  foreign.setUint32Property("uidOnServer", 42);
  const token = header.storeToken;
  const key = header.messageKey;

  info.imapUidValidity = 7;
  Assert.equal(info.imapUidValidity, 7);
  Assert.ok(!header.properties.includes("uidOnServer"));
  Assert.equal(foreign.getUint32Property("uidOnServer"), 42);
  header.setUint32Property("uidOnServer", 42);
  info.imapUidValidity = 7;
  Assert.equal(header.getUint32Property("uidOnServer"), 42);

  info.imapUidValidity = 0xffffffff;
  Assert.equal(info.imapUidValidity, 0xffffffff);
  const reconstructed = folder.msgDatabase.dBFolderInfo;
  Assert.notEqual(info, reconstructed);
  Assert.equal(reconstructed.imapUidValidity, 0xffffffff);
  Assert.equal(reconstructed.getUint32Property("UIDValidity", 0), 0xffffffff);
  Assert.ok(!header.properties.includes("uidOnServer"));
  Assert.equal(header.getStringProperty("custom"), "retained");
  Assert.equal(otherInfo.imapUidValidity, 7);
  Assert.equal(foreign.getUint32Property("uidOnServer"), 42);
  Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
  Assert.equal(folder.msgDatabase.getMsgHdrForKey(key).folder, folder);
  Assert.equal(header.storeToken, token);
  Assert.deepEqual(await IOUtils.read(folder.filePath.path), bytes);
});

add_task(function test_failedEpochChangePreservesExistingBinding() {
  const folder = createFolder("failed-epoch");
  const header = folder.addMessage(raw);
  const info = folder.msgDatabase.dBFolderInfo;
  info.imapUidValidity = 11;
  header.setUint32Property("uidOnServer", 42);
  const connection = database.connectionForTests;
  connection.beginTransaction();
  try {
    Assert.throws(() => (info.imapUidValidity = 12), /NS_ERROR_IN_PROGRESS/);
    Assert.equal(info.imapUidValidity, 11);
    Assert.equal(header.getUint32Property("uidOnServer"), 42);
  } finally {
    connection.rollbackTransaction();
  }
  Assert.equal(info.imapUidValidity, 11);
  Assert.equal(header.getUint32Property("uidOnServer"), 42);
});

add_task(function test_epochReadErrorsAreNotReportedAsZero() {
  const folder = createFolder("epoch-read-error");
  const info = folder.msgDatabase.dBFolderInfo;
  info.imapUidValidity = 15;
  Assert.equal(info.imapUidValidity, 15);
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "ALTER TABLE folder_properties RENAME TO unavailable_folder_properties"
  );
  try {
    Assert.throws(
      () => info.imapUidValidity,
      error =>
        !Components.isSuccessCode(error.result) &&
        error.result != Cr.NS_ERROR_NOT_AVAILABLE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_folder_properties RENAME TO folder_properties"
    );
  }
  Assert.equal(info.imapUidValidity, 15);
});

add_task(function test_deletedFolderCannotReadOrWriteAnEpoch() {
  const folder = createFolder("deleted-epoch");
  const info = folder.msgDatabase.dBFolderInfo;
  info.imapUidValidity = 19;
  folderDB.deleteFolder(folder.id);
  Assert.throws(() => info.imapUidValidity, /NS_ERROR_NOT_AVAILABLE/);
  Assert.throws(() => (info.imapUidValidity = 20), /NS_ERROR_NOT_AVAILABLE/);
});

add_task(function test_sqlFailureRollsBackEpochAndBindingRetirement() {
  const folder = createFolder("epoch-write-error");
  const header = folder.addMessage(raw);
  const info = folder.msgDatabase.dBFolderInfo;
  info.imapUidValidity = 21;
  header.setUint32Property("uidOnServer", 42);
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_epoch BEFORE INSERT ON folder_properties " +
      "WHEN NEW.name = 'UIDValidity' AND NEW.id = " +
      folder.id +
      " BEGIN SELECT RAISE(ABORT, 'epoch write failure'); END"
  );
  try {
    Assert.throws(
      () => (info.imapUidValidity = 22),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.equal(info.imapUidValidity, 21);
    Assert.equal(header.getUint32Property("uidOnServer"), 42);
    Assert.ok(header.properties.includes("uidOnServer"));
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_epoch");
  }
  info.imapUidValidity = 22;
  Assert.equal(info.imapUidValidity, 22);
  Assert.ok(!header.properties.includes("uidOnServer"));
});
