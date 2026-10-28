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
  Assert.equal(root.msgStore.storeType, "mbox");
  Assert.equal(root.server.getCharValue("storeContractID"), contract);
});

add_task(function test_downloadSettingsDefaultsAndPersistence() {
  const db = root.createLocalSubfolder("settings").msgDatabase;
  const settings = db.msgDownloadSettings;
  Assert.equal(settings.useServerDefaults, true);
  Assert.equal(settings.downloadByDate, false);
  Assert.equal(settings.downloadUnreadOnly, false);
  Assert.equal(settings.ageLimitOfMsgsToDownload, 0);
  settings.useServerDefaults = false;
  settings.downloadByDate = true;
  settings.downloadUnreadOnly = true;
  settings.ageLimitOfMsgsToDownload = 0xffffffff;
  db.msgDownloadSettings = settings;
  const stored = db.msgDownloadSettings;
  Assert.equal(stored.useServerDefaults, false);
  Assert.equal(stored.downloadByDate, true);
  Assert.equal(stored.downloadUnreadOnly, true);
  Assert.equal(stored.ageLimitOfMsgsToDownload, 0xffffffff);
  const info = db.dBFolderInfo;
  Assert.equal(info.getBooleanProperty("useServerDefaults", true), false);
  Assert.equal(info.getBooleanProperty("downloadByDate", false), true);
  Assert.equal(info.getBooleanProperty("downloadUnreadOnly", false), true);
  Assert.equal(info.getUint32Property("ageLimit", 0), 0xffffffff);
  db.msgDownloadSettings = null;
  Assert.equal(db.msgDownloadSettings.ageLimitOfMsgsToDownload, 0xffffffff);
  info.setUint32Property("ageLimit", 3);
  Assert.equal(db.msgDownloadSettings.ageLimitOfMsgsToDownload, 3);
});

add_task(function test_failedWriteRollsBackAllSettings() {
  const db = root.createLocalSubfolder("settings-error").msgDatabase;
  const settings = db.msgDownloadSettings;
  settings.useServerDefaults = false;
  settings.downloadByDate = true;
  settings.downloadUnreadOnly = true;
  settings.ageLimitOfMsgsToDownload = 9;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_age BEFORE INSERT ON folder_properties " +
      "WHEN NEW.name = 'ageLimit' BEGIN " +
      "SELECT RAISE(ABORT, 'settings write failure'); END"
  );
  try {
    Assert.throws(
      () => (db.msgDownloadSettings = settings),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    const stored = db.msgDownloadSettings;
    Assert.equal(stored.useServerDefaults, true);
    Assert.equal(stored.downloadByDate, false);
    Assert.equal(stored.downloadUnreadOnly, false);
    Assert.equal(stored.ageLimitOfMsgsToDownload, 0);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_age");
  }
  db.msgDownloadSettings = settings;
  Assert.equal(db.msgDownloadSettings.ageLimitOfMsgsToDownload, 9);
});

add_task(function test_settingsDoNotCommitAnUnrelatedTransaction() {
  const db = root.createLocalSubfolder("settings-transaction").msgDatabase;
  const settings = db.msgDownloadSettings;
  settings.ageLimitOfMsgsToDownload = 12;
  const connection = database.connectionForTests;
  connection.beginTransaction();
  try {
    Assert.throws(
      () => (db.msgDownloadSettings = settings),
      /NS_ERROR_IN_PROGRESS/
    );
    Assert.ok(connection.transactionInProgress);
    Assert.equal(db.msgDownloadSettings.ageLimitOfMsgsToDownload, 0);
  } finally {
    connection.rollbackTransaction();
  }
});

add_task(function test_settingsReadErrorsCannotReturnCachedSuccess() {
  const db = root.createLocalSubfolder("settings-read-error").msgDatabase;
  Assert.equal(db.msgDownloadSettings.useServerDefaults, true);
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "ALTER TABLE folder_properties RENAME TO unavailable_folder_properties"
  );
  try {
    Assert.throws(
      () => db.msgDownloadSettings,
      error => error.result == Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_folder_properties RENAME TO folder_properties"
    );
  }
  Assert.equal(db.msgDownloadSettings.useServerDefaults, true);
});

add_task(function test_deletedFolderCannotReadOrWriteSettings() {
  const folder = root.createLocalSubfolder("deleted-settings");
  const db = folder.msgDatabase;
  const settings = db.msgDownloadSettings;
  folderDB.deleteFolder(folder.id);
  Assert.throws(() => db.msgDownloadSettings, /NS_ERROR_NOT_AVAILABLE/);
  Assert.throws(
    () => (db.msgDownloadSettings = settings),
    /NS_ERROR_NOT_AVAILABLE/
  );
});

add_task(function test_folderSettingsPersistAndDefaultsRemainLive() {
  const folder = root.createLocalSubfolder("folder-settings");
  const server = folder.server;
  const defaults = server.downloadSettings;
  defaults.ageLimitOfMsgsToDownload = 4;
  server.downloadSettings = defaults;
  Assert.equal(folder.downloadSettings.ageLimitOfMsgsToDownload, 4);
  defaults.ageLimitOfMsgsToDownload = 5;
  server.downloadSettings = defaults;
  Assert.equal(folder.downloadSettings.ageLimitOfMsgsToDownload, 5);
  const settings = folder.msgDatabase.msgDownloadSettings;
  settings.useServerDefaults = false;
  settings.downloadByDate = true;
  settings.ageLimitOfMsgsToDownload = 8;
  folder.downloadSettings = settings;
  Assert.equal(
    folder.msgDatabase.msgDownloadSettings.ageLimitOfMsgsToDownload,
    8
  );
  Assert.equal(folder.downloadSettings.ageLimitOfMsgsToDownload, 8);
  folder.downloadSettings = null;
  Assert.equal(folder.downloadSettings.ageLimitOfMsgsToDownload, 8);
});

add_task(function test_folderSettingsDoNotHideStorageErrors() {
  const folder = root.createLocalSubfolder("folder-settings-error");
  const settings = folder.msgDatabase.msgDownloadSettings;
  settings.useServerDefaults = false;
  settings.ageLimitOfMsgsToDownload = 6;
  folder.downloadSettings = settings;
  Assert.equal(folder.downloadSettings.ageLimitOfMsgsToDownload, 6);
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "ALTER TABLE folder_properties RENAME TO unavailable_folder_properties"
  );
  try {
    Assert.throws(
      () => folder.downloadSettings,
      error => error.result == Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => (folder.downloadSettings = settings),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_folder_properties RENAME TO folder_properties"
    );
  }
  Assert.equal(folder.downloadSettings.ageLimitOfMsgsToDownload, 6);
});
