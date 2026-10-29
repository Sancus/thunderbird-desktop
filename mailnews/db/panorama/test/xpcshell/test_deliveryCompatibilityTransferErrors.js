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

function transferBag() {
  const bag = Cc["@mozilla.org/hash-property-bag;1"].createInstance(
    Ci.nsIWritablePropertyBag2
  );
  bag.setPropertyAsACString("transferred", "applied prefix");
  return bag;
}

// Fault only the existing database/FolderInfo call boundary. Native metadata
// remains observable so a failed repair cannot silently clear forceReparse.
function withTransferDatabase(folder, getInfo, setSummary, callback) {
  const original = folder.msgDatabase;
  const replacement = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgDatabase"]),
    addListener() {},
    removeListener() {},
    commit() {},
    clearCachedHdrs() {},
    lastUseTime: 0,
    get dBFolderInfo() {
      return getInfo();
    },
    set summaryValid(value) {
      setSummary(value);
    },
  };
  folder.msgDatabase = replacement;
  try {
    callback();
  } finally {
    folder.msgDatabase = original;
  }
}

add_task(function test_transferInfoLookupKeepsOriginalError() {
  const folder = root.createLocalSubfolder("transfer-info-lookup-error");
  const uri = folder.URI;
  let summaryCalls = 0;
  withTransferDatabase(
    folder,
    () => {
      throw new Components.Exception(
        "folder info read",
        Cr.NS_ERROR_FILE_CORRUPTED
      );
    },
    () => ++summaryCalls,
    () => {
      Assert.throws(
        () => folder.dBTransferInfo,
        error => error.result == Cr.NS_ERROR_FILE_CORRUPTED
      );
    }
  );
  Assert.equal(summaryCalls, 0);
  Assert.equal(folder.URI, uri);
});

add_task(function test_failedImportCannotClearNativeRepairState() {
  const folder = root.createLocalSubfolder("transfer-info-import-error");
  const info = folder.msgDatabase.dBFolderInfo;
  info.setBooleanProperty("forceReparse", true);
  const bag = transferBag();
  let summaryCalls = 0;
  const failingInfo = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBFolderInfo"]),
    initFromTransferInfo(input) {
      Assert.strictEqual(input, bag);
      throw new Components.Exception(
        "import failed",
        Cr.NS_ERROR_FILE_ACCESS_DENIED
      );
    },
    setBooleanProperty(name, value) {
      info.setBooleanProperty(name, value);
    },
  };
  withTransferDatabase(
    folder,
    () => failingInfo,
    () => ++summaryCalls,
    () => {
      Assert.throws(
        () => (folder.dBTransferInfo = bag),
        error => error.result == Cr.NS_ERROR_FILE_ACCESS_DENIED
      );
    }
  );
  Assert.ok(info.getBooleanProperty("forceReparse", false));
  Assert.equal(summaryCalls, 0);
});

add_task(function test_repairStateWriteFailureKeepsImportedPrefix() {
  const folder = root.createLocalSubfolder("transfer-info-state-error");
  const info = folder.msgDatabase.dBFolderInfo;
  info.setBooleanProperty("forceReparse", true);
  const bag = transferBag();
  let summaryCalls = 0;
  const importingInfo = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBFolderInfo"]),
    initFromTransferInfo(input) {
      info.setCharProperty(
        "transferred",
        input.getPropertyAsACString("transferred")
      );
    },
    setBooleanProperty(name, value) {
      info.setBooleanProperty(name, value);
    },
  };
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_transfer_state BEFORE INSERT ON folder_properties " +
      "WHEN NEW.name = 'forceReparse' BEGIN SELECT RAISE(ABORT, 'transfer state'); END"
  );
  try {
    withTransferDatabase(
      folder,
      () => importingInfo,
      () => ++summaryCalls,
      () => {
        Assert.throws(
          () => (folder.dBTransferInfo = bag),
          error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
        );
      }
    );
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_transfer_state");
  }
  Assert.equal(info.getCharProperty("transferred"), "applied prefix");
  Assert.ok(info.getBooleanProperty("forceReparse", false));
  Assert.equal(summaryCalls, 0);
});

add_task(function test_summaryFailurePropagatesAfterMetadataWrites() {
  const folder = root.createLocalSubfolder("transfer-info-summary-error");
  const uri = folder.URI;
  const info = folder.msgDatabase.dBFolderInfo;
  info.setBooleanProperty("forceReparse", true);
  const bag = transferBag();
  const importingInfo = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBFolderInfo"]),
    initFromTransferInfo(input) {
      info.setCharProperty(
        "transferred",
        input.getPropertyAsACString("transferred")
      );
    },
    setBooleanProperty(name, value) {
      info.setBooleanProperty(name, value);
    },
  };
  let summaryCalls = 0;
  withTransferDatabase(
    folder,
    () => importingInfo,
    value => {
      ++summaryCalls;
      Assert.ok(value);
      throw new Components.Exception(
        "summary failed",
        Cr.NS_ERROR_FILE_READ_ONLY
      );
    },
    () => {
      Assert.throws(
        () => (folder.dBTransferInfo = bag),
        error => error.result == Cr.NS_ERROR_FILE_READ_ONLY
      );
    }
  );
  Assert.equal(summaryCalls, 1);
  Assert.equal(info.getCharProperty("transferred"), "applied prefix");
  Assert.ok(!info.getBooleanProperty("forceReparse", true));
  Assert.equal(folder.URI, uri);
});
