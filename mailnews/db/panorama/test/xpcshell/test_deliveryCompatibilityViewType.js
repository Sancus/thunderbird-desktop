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
  Assert.equal(root.server.getStringValue("storeContractID"), contract);
});

add_task(function test_viewTypeDefaultsAndPerFolderPersistence() {
  const folder = root.createLocalSubfolder("view-type");
  const other = root.createLocalSubfolder("view-type-other");
  const info = folder.msgDatabase.dBFolderInfo;
  Assert.equal(info.viewType, Ci.nsMsgViewType.eShowAllThreads);
  info.viewType = Ci.nsMsgViewType.eShowThreadsWithUnread;
  other.msgDatabase.dBFolderInfo.viewType =
    Ci.nsMsgViewType.eShowWatchedThreadsWithUnread;
  Assert.equal(folder.msgDatabase.dBFolderInfo.viewType, 2);
  Assert.equal(other.msgDatabase.dBFolderInfo.viewType, 3);
  Assert.equal(info.getUint32Property("viewType", 99), 2);
  info.setUint32Property("viewType", 6);
  Assert.equal(info.viewType, Ci.nsMsgViewType.eShowSearch);
  Assert.deepEqual(folder.msgDatabase.listAllKeys(), []);
});

add_task(function test_viewTypeKeepsItsSignedIDLWidth() {
  const info =
    root.createLocalSubfolder("view-type-width").msgDatabase.dBFolderInfo;
  for (const value of [-2147483648, -1, 2147483647, 0]) {
    info.viewType = value;
    Assert.equal(info.viewType, value);
    Assert.equal(info.getUint32Property("viewType", 0), value >>> 0);
  }
});

add_task(function test_viewTypeWriteFailureRetainsThePreviousValue() {
  const info =
    root.createLocalSubfolder("view-type-write").msgDatabase.dBFolderInfo;
  info.viewType = Ci.nsMsgViewType.eShowThreadsWithUnread;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_view_type BEFORE INSERT ON folder_properties " +
      "WHEN NEW.name = 'viewType' " +
      "BEGIN SELECT RAISE(ABORT, 'view type fault'); END"
  );
  try {
    Assert.throws(
      () => (info.viewType = Ci.nsMsgViewType.eShowWatchedThreadsWithUnread),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.equal(info.viewType, 2);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_view_type");
  }
});

add_task(function test_viewTypeReadFailurePropagates() {
  const info =
    root.createLocalSubfolder("view-type-read").msgDatabase.dBFolderInfo;
  info.viewType = 3;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "ALTER TABLE folder_properties RENAME TO hidden_view_type"
  );
  try {
    Assert.throws(
      () => info.viewType,
      error => error.result == Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE hidden_view_type RENAME TO folder_properties"
    );
  }
  Assert.equal(info.viewType, 3);
});

add_task(function test_viewTypeKeepsTheCallersTransactionOpen() {
  const info = root.createLocalSubfolder("view-type-transaction").msgDatabase
    .dBFolderInfo;
  info.viewType = 2;
  const connection = database.connectionForTests;
  connection.beginTransaction();
  try {
    info.viewType = 3;
    Assert.equal(info.viewType, 3);
    Assert.ok(connection.transactionInProgress);
  } finally {
    connection.rollbackTransaction();
  }
  Assert.equal(info.viewType, 2);
});

add_task(function test_viewTypeRejectsDeletedPhysicalFolder() {
  const folder = root.createLocalSubfolder("view-type-deleted");
  const info = folder.msgDatabase.dBFolderInfo;
  folderDB.deleteFolder(folder.id);
  Assert.throws(() => info.viewType, /NS_ERROR_NOT_AVAILABLE/);
  Assert.throws(() => (info.viewType = 2), /NS_ERROR_NOT_AVAILABLE/);
});
