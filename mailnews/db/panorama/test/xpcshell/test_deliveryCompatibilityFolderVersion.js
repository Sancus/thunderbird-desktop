/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

let root;

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
    database,
  );
  const account = MailServices.accounts.createLocalMailAccount();
  registerCleanupFunction(() => {
    MailServices.accounts.removeAccount(account, false);
    Services.prefs.clearUserPref("mail.serverDefaultStoreContractID");
    Services.prefs.clearUserPref("mail.server.default.storeContractID");
  });
  root = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder,
  );
  Assert.equal(root.msgStore.storeType, "mbox");
  Assert.equal(root.server.getStringValue("storeContractID"), contract);
});

add_task(function test_missingVersionDefaultsToZeroWithoutCreatingProperty() {
  const info =
    root.createLocalSubfolder("version-default").msgDatabase.dBFolderInfo;
  Assert.equal(info.version, 0);
  Assert.equal(info.getUint32Property("version", 77), 77);
  info.setCharProperty("Version", "case-sensitive");
  Assert.equal(info.version, 0);
  Assert.equal(info.getCharProperty("Version"), "case-sensitive");
});

add_task(function test_versionKeepsThePublicUint32WidthAndExplicitZero() {
  const folder = root.createLocalSubfolder("version-width");
  const info = folder.msgDatabase.dBFolderInfo;
  const connection = database.connectionForTests;
  const schemaVersion = connection.schemaVersion;
  info.version = 0x12345678;
  Assert.equal(folder.msgDatabase.dBFolderInfo.version, 0x12345678);
  info.version = 0xffffffff;
  Assert.equal(info.version, 0xffffffff);
  Assert.equal(info.getInt64Property("version", -1), 4294967295);
  info.version = 0;
  Assert.equal(info.version, 0);
  Assert.equal(info.getUint32Property("version", 77), 0);
  Assert.equal(connection.schemaVersion, schemaVersion);
});

add_task(function test_versionStaysInItsPhysicalFolder() {
  const first = root.createLocalSubfolder("version-first");
  const second = root.createLocalSubfolder("version-second");
  const firstURI = first.URI;
  const secondURI = second.URI;
  const firstInfo = first.msgDatabase.dBFolderInfo;
  const secondInfo = second.msgDatabase.dBFolderInfo;
  firstInfo.setCharProperty("isolation-control", "first");
  secondInfo.setCharProperty("isolation-control", "second");
  firstInfo.version = 12;
  secondInfo.version = 23;
  Assert.equal(first.msgDatabase.dBFolderInfo.version, 12);
  Assert.equal(second.msgDatabase.dBFolderInfo.version, 23);
  Assert.equal(firstInfo.getCharProperty("isolation-control"), "first");
  Assert.equal(secondInfo.getCharProperty("isolation-control"), "second");
  Assert.equal(first.URI, firstURI);
  Assert.equal(second.URI, secondURI);
  Assert.equal(firstInfo.folderName, "version-first");
  Assert.equal(secondInfo.folderName, "version-second");
});

add_task(function test_versionReadsFreshPersistedValues() {
  const folder = root.createLocalSubfolder("version-refresh");
  const info = folder.msgDatabase.dBFolderInfo;
  info.version = 5;
  folder.msgDatabase.dBFolderInfo.setUint32Property("version", 1000000);
  Assert.equal(info.version, 1000000);
});

add_task(function test_versionWriteFailureDoesNotCacheTheAttempt() {
  const folder = root.createLocalSubfolder("version-write-error");
  const info = folder.msgDatabase.dBFolderInfo;
  info.version = 42;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_folder_version BEFORE INSERT ON folder_properties " +
      "WHEN NEW.name = 'version' BEGIN SELECT RAISE(ABORT, 'version fault'); END",
  );
  try {
    Assert.throws(
      () => (info.version = 200),
      (error) => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT,
    );
    Assert.equal(info.version, 42);
    Assert.equal(folder.msgDatabase.dBFolderInfo.version, 42);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_folder_version");
  }
});

add_task(function test_versionReadFailurePropagates() {
  const info =
    root.createLocalSubfolder("version-read-error").msgDatabase.dBFolderInfo;
  info.version = 42;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "ALTER TABLE folder_properties RENAME TO hidden_version_properties",
  );
  try {
    Assert.throws(
      () => info.version,
      (error) => error.result == Cr.NS_ERROR_FAILURE,
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE hidden_version_properties RENAME TO folder_properties",
    );
  }
  Assert.equal(info.version, 42);
});

add_task(function test_negativeStoredVersionIsRejected() {
  const info =
    root.createLocalSubfolder("version-negative").msgDatabase.dBFolderInfo;
  info.setInt64Property("version", -1);
  Assert.throws(
    () => info.version,
    (error) => error.result == Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA,
  );
});

add_task(function test_tooWideStoredVersionIsRejected() {
  const info =
    root.createLocalSubfolder("version-too-wide").msgDatabase.dBFolderInfo;
  info.setInt64Property("version", 4294967296);
  Assert.throws(
    () => info.version,
    (error) => error.result == Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA,
  );
});

add_task(function test_deletedFolderVersionCannotBeReadOrWritten() {
  const folder = root.createLocalSubfolder("version-deleted");
  const info = folder.msgDatabase.dBFolderInfo;
  info.version = 42;
  folderDB.deleteFolder(folder.id);
  Assert.throws(() => info.version, /NS_ERROR_NOT_AVAILABLE/);
  Assert.throws(() => (info.version = 23), /NS_ERROR_NOT_AVAILABLE/);
});

add_task(function test_versionDoesNotSettleTheCallerTransaction() {
  const info = root.createLocalSubfolder("version-transaction").msgDatabase
    .dBFolderInfo;
  info.version = 5;
  const connection = database.connectionForTests;
  connection.beginTransaction();
  try {
    info.version = 7;
    Assert.ok(connection.transactionInProgress);
    Assert.equal(info.version, 7);
  } finally {
    connection.rollbackTransaction();
  }
  Assert.equal(info.version, 5);
});
