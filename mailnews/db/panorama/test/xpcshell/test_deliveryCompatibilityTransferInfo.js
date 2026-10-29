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
  Assert.strictEqual(
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

/**
 * Read the exact physical folder's stored property types and text values.
 *
 * @param {nsIMsgFolder} folder - The physical folder to inspect.
 * @returns {Array<Array>} Stored name, SQLite type and value text.
 */
function storedProperties(folder) {
  const statement = database.connectionForTests.createStatement(
    "SELECT name, typeof(value) AS type, CAST(value AS TEXT) AS text " +
      "FROM folder_properties WHERE id = :id ORDER BY name"
  );
  statement.params.id = folder.id;
  const properties = [];
  try {
    while (statement.executeStep()) {
      properties.push([
        statement.row.name,
        statement.row.type,
        statement.row.text,
      ]);
    }
  } finally {
    statement.finalize();
  }
  return properties;
}

add_task(function test_transferKeepsUnknownTextNamesAndPresence() {
  const source = root.createLocalSubfolder("transfer-text-source");
  const target = root.createLocalSubfolder("transfer-text-target");
  const sourceInfo = source.msgDatabase.dBFolderInfo;
  const targetInfo = target.msgDatabase.dBFolderInfo;
  const expected = [
    ["Case", "upper"],
    ["case", "lower"],
    ["empty", ""],
    ["numeric", "00042"],
    ["exponent", "1e3"],
  ];
  for (const [name, text] of expected) {
    sourceInfo.setCharProperty(name, text);
  }
  targetInfo.setCharProperty("target-only", "retained");
  const bag = sourceInfo.GetTransferInfo();
  for (const [name, text] of expected) {
    Assert.ok(bag.hasKey(name));
    Assert.equal(typeof bag.getProperty(name), "string");
    Assert.equal(bag.getPropertyAsACString(name), text);
  }
  Assert.ok(!bag.hasKey("missing"));
  targetInfo.initFromTransferInfo(bag);
  const stored = storedProperties(target);
  for (const [name, text] of expected) {
    Assert.deepEqual(
      stored.find(row => row[0] == name),
      [name, "text", text]
    );
  }
  Assert.ok(!stored.some(row => row[0] == "missing"));
  Assert.equal(targetInfo.getCharProperty("target-only"), "retained");
});

add_task(function test_transferKeepsFullSignedIntegerWidth() {
  const source = root.createLocalSubfolder("transfer-int-source");
  const target = root.createLocalSubfolder("transfer-int-target");
  database.connectionForTests.executeSimpleSQL(
    "INSERT INTO folder_properties (id, name, value) VALUES " +
      `(${source.id}, 'minimum', -9223372036854775808), ` +
      `(${source.id}, 'maximum', 9223372036854775807), ` +
      `(${source.id}, 'zero', 0)`
  );
  const bag = source.msgDatabase.dBFolderInfo.GetTransferInfo();
  Assert.equal(typeof bag.getProperty("maximum"), "number");
  Assert.equal(bag.getPropertyAsACString("minimum"), "-9223372036854775808");
  Assert.equal(bag.getPropertyAsACString("maximum"), "9223372036854775807");
  target.msgDatabase.dBFolderInfo.initFromTransferInfo(bag);
  const stored = storedProperties(target);
  for (const [name, text] of [
    ["minimum", "-9223372036854775808"],
    ["maximum", "9223372036854775807"],
    ["zero", "0"],
  ]) {
    Assert.deepEqual(
      stored.find(row => row[0] == name),
      [name, "integer", text]
    );
  }
});

add_task(function test_transferMetadataCannotChangePhysicalIdentity() {
  const source = root.createLocalSubfolder("transfer-id-source");
  const target = root.createLocalSubfolder("transfer-id-target");
  const sourceInfo = source.msgDatabase.dBFolderInfo;
  for (const name of ["id", "parent", "path", "folderName"]) {
    sourceInfo.setCharProperty(name, "metadata only");
  }
  sourceInfo.highWater = 500;
  const id = target.id;
  const parent = target.parent;
  const uri = target.URI;
  const name = target.name;
  const info = target.msgDatabase.dBFolderInfo;
  info.initFromTransferInfo(sourceInfo.GetTransferInfo());
  Assert.equal(target.id, id);
  Assert.strictEqual(target.parent, parent);
  Assert.equal(target.URI, uri);
  Assert.equal(target.name, name);
  Assert.equal(info.folderName, name);
  for (const property of ["id", "parent", "path", "folderName"]) {
    Assert.equal(info.getCharProperty(property), "metadata only");
  }
  Assert.equal(info.highWater, 500);
  Assert.equal(addMessage({ folderId: id }), 1);
  Assert.equal(info.numMessages, 1);
});

add_task(function test_invalidTransferValueCannotApplyAnEarlierProperty() {
  const source = root.createLocalSubfolder("transfer-invalid-source");
  const target = root.createLocalSubfolder("transfer-invalid-target");
  source.msgDatabase.dBFolderInfo.setCharProperty("valid", "new value");
  const bag = source.msgDatabase.dBFolderInfo
    .GetTransferInfo()
    .QueryInterface(Ci.nsIWritablePropertyBag2);
  bag.setPropertyAsDouble("unsupported", 1.5);
  const info = target.msgDatabase.dBFolderInfo;
  info.setCharProperty("kept", "old value");
  const before = storedProperties(target);
  Assert.throws(
    () => info.initFromTransferInfo(bag),
    error => error.result == Cr.NS_ERROR_INVALID_ARG
  );
  Assert.deepEqual(storedProperties(target), before);
});

add_task(function test_transferWriteFailureKeepsOriginalErrorAndRows() {
  const source = root.createLocalSubfolder("transfer-fault-source");
  const target = root.createLocalSubfolder("transfer-fault-target");
  const sourceInfo = source.msgDatabase.dBFolderInfo;
  sourceInfo.setCharProperty("transferred", "source value");
  const bag = sourceInfo.GetTransferInfo();
  const targetInfo = target.msgDatabase.dBFolderInfo;
  targetInfo.setCharProperty("kept", "old value");
  const id = target.id;
  const uri = target.URI;
  const parent = target.parent;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_transfer_property BEFORE INSERT ON folder_properties " +
      `WHEN NEW.id = ${id} BEGIN SELECT RAISE(ABORT, 'transfer fault'); END`
  );
  try {
    Assert.throws(
      () => targetInfo.initFromTransferInfo(bag),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_transfer_property");
  }
  Assert.equal(targetInfo.getCharProperty("kept"), "old value");
  Assert.equal(sourceInfo.getCharProperty("transferred"), "source value");
  Assert.equal(target.id, id);
  Assert.equal(target.URI, uri);
  Assert.strictEqual(target.parent, parent);
});

add_task(function test_transferUsesRealFlagsAndPhysicalMembership() {
  const source = root.createLocalSubfolder("transfer-count-source");
  const target = root.createLocalSubfolder("transfer-count-target");
  const sourceInfo = source.msgDatabase.dBFolderInfo;
  const targetInfo = target.msgDatabase.dBFolderInfo;
  const flags = Ci.nsMsgFolderFlags.Mail | Ci.nsMsgFolderFlags.Inbox;
  sourceInfo.flags = flags;
  sourceInfo.setInt64Property("flags", Ci.nsMsgFolderFlags.Virtual);
  sourceInfo.setCharProperty("numMsgs", "stale shadow");
  sourceInfo.setInt64Property("numNewMsgs", 99);
  sourceInfo.setCharProperty("Flags", "case-sensitive metadata");
  addMessage({ folderId: source.id });
  addMessage({ folderId: source.id, flags: Ci.nsMsgMessageFlags.Read });
  addMessage({ folderId: target.id });
  const bag = sourceInfo.GetTransferInfo();
  Assert.equal(bag.getPropertyAsInt64("flags"), flags);
  Assert.equal(bag.getPropertyAsInt64("numMsgs"), 2);
  Assert.equal(bag.getPropertyAsInt64("numNewMsgs"), 1);
  targetInfo.initFromTransferInfo(bag);
  Assert.equal(targetInfo.flags, flags);
  Assert.equal(targetInfo.numMessages, 1);
  Assert.equal(targetInfo.numUnreadMessages, 1);
  Assert.equal(targetInfo.getInt64Property("numMsgs", -1), -1);
  Assert.equal(targetInfo.getCharProperty("Flags"), "case-sensitive metadata");
});

add_task(function test_transferKeepsTypedVirtualSummaries() {
  const source = root.createLocalSubfolder("transfer-virtual-source");
  const target = root.createLocalSubfolder("transfer-virtual-target");
  const sourceInfo = source.msgDatabase.dBFolderInfo;
  sourceInfo.flags |= Ci.nsMsgFolderFlags.Virtual;
  sourceInfo.numMessages = 9;
  sourceInfo.numUnreadMessages = 3;
  const info = target.msgDatabase.dBFolderInfo;
  info.initFromTransferInfo(sourceInfo.GetTransferInfo());
  Assert.ok(info.flags & Ci.nsMsgFolderFlags.Virtual);
  Assert.equal(info.numMessages, 9);
  Assert.equal(info.numUnreadMessages, 3);
  const stored = storedProperties(target);
  Assert.deepEqual(
    stored.find(row => row[0] == "numMsgs"),
    ["numMsgs", "integer", "9"]
  );
  Assert.deepEqual(
    stored.find(row => row[0] == "numNewMsgs"),
    ["numNewMsgs", "integer", "3"]
  );
});

add_task(function test_transferAcceptsTheThreeFolderCommandsStringEdits() {
  const source = root.createLocalSubfolder("transfer-repair-source");
  const target = root.createLocalSubfolder("transfer-repair-target");
  const sourceInfo = source.msgDatabase.dBFolderInfo;
  sourceInfo.imapUidValidity = 41;
  const bag = source.dBTransferInfo.QueryInterface(Ci.nsIWritablePropertyBag2);
  bag.setPropertyAsACString("numMsgs", "0");
  bag.setPropertyAsACString("numNewMsgs", "0");
  bag.setPropertyAsACString("UIDValidity", "-1");
  const info = target.msgDatabase.dBFolderInfo;
  info.imapUidValidity = 12;
  addMessage({ folderId: target.id });
  target.dBTransferInfo = bag;
  Assert.equal(info.imapUidValidity, 0);
  Assert.equal(info.numMessages, 1);
  Assert.equal(info.numUnreadMessages, 1);
  Assert.deepEqual(
    storedProperties(target).find(row => row[0] == "UIDValidity"),
    ["UIDValidity", "integer", "0"]
  );
});

add_task(function test_transferKeepsMaxUint32AsAValidEpoch() {
  const source = root.createLocalSubfolder("transfer-max-epoch-source");
  const target = root.createLocalSubfolder("transfer-max-epoch-target");
  source.msgDatabase.dBFolderInfo.imapUidValidity = 0xffffffff;
  const bag = source.msgDatabase.dBFolderInfo.GetTransferInfo();
  Assert.equal(bag.getPropertyAsInt64("UIDValidity"), 4294967295);
  const info = target.msgDatabase.dBFolderInfo;
  info.imapUidValidity = 7;
  info.initFromTransferInfo(bag);
  Assert.equal(info.imapUidValidity, 0xffffffff);
  Assert.deepEqual(
    storedProperties(target).find(row => row[0] == "UIDValidity"),
    ["UIDValidity", "integer", "4294967295"]
  );
});

add_task(function test_absentTransferEpochLeavesDestinationEpochPresent() {
  const source = root.createLocalSubfolder("transfer-no-epoch-source");
  const target = root.createLocalSubfolder("transfer-no-epoch-target");
  const bag = source.msgDatabase.dBFolderInfo.GetTransferInfo();
  Assert.ok(!bag.hasKey("UIDValidity"));
  const info = target.msgDatabase.dBFolderInfo;
  info.imapUidValidity = 23;
  info.initFromTransferInfo(bag);
  Assert.equal(info.imapUidValidity, 23);
});

add_task(function test_transferRejectsNamedWidthBeforeApplyingEpochOrFlags() {
  const target = root.createLocalSubfolder("transfer-width-error");
  const info = target.msgDatabase.dBFolderInfo;
  info.imapUidValidity = 7;
  info.setCharProperty("kept", "old value");
  const before = storedProperties(target);
  const flags = info.flags;
  const bag = info.GetTransferInfo().QueryInterface(Ci.nsIWritablePropertyBag2);
  bag.setPropertyAsInt64("UIDValidity", 8);
  bag.setPropertyAsInt64("flags", Ci.nsMsgFolderFlags.Virtual);
  bag.setPropertyAsInt64("version", 4294967296);
  Assert.throws(
    () => info.initFromTransferInfo(bag),
    error => error.result == Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA
  );
  Assert.equal(info.imapUidValidity, 7);
  Assert.equal(info.flags, flags);
  Assert.deepEqual(storedProperties(target), before);
});

add_task(function test_transferRejectsOtherCanonicalNumericStrings() {
  const target = root.createLocalSubfolder("transfer-type-error");
  const info = target.msgDatabase.dBFolderInfo;
  info.imapUidValidity = 7;
  const before = storedProperties(target);
  const bag = info.GetTransferInfo().QueryInterface(Ci.nsIWritablePropertyBag2);
  bag.setPropertyAsACString("UIDValidity", "42");
  Assert.throws(
    () => info.initFromTransferInfo(bag),
    error => error.result == Cr.NS_ERROR_INVALID_ARG
  );
  Assert.equal(info.imapUidValidity, 7);
  Assert.deepEqual(storedProperties(target), before);
});

add_task(function test_transferRejectsNegativeVirtualCountsBeforeWrites() {
  const target = root.createLocalSubfolder("transfer-negative-count");
  const info = target.msgDatabase.dBFolderInfo;
  const before = storedProperties(target);
  const flags = info.flags;
  const bag = info.GetTransferInfo().QueryInterface(Ci.nsIWritablePropertyBag2);
  bag.setPropertyAsInt64("flags", Ci.nsMsgFolderFlags.Virtual);
  bag.setPropertyAsInt64("numMsgs", -1);
  Assert.throws(
    () => info.initFromTransferInfo(bag),
    error => error.result == Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA
  );
  Assert.equal(info.flags, flags);
  Assert.deepEqual(storedProperties(target), before);
});

add_task(function test_transferRejectsNullAndDeletedFolder() {
  const folder = root.createLocalSubfolder("transfer-deleted");
  const info = folder.msgDatabase.dBFolderInfo;
  const bag = info.GetTransferInfo();
  Assert.throws(
    () => info.initFromTransferInfo(null),
    error => error.result == Cr.NS_ERROR_INVALID_ARG
  );
  folderDB.deleteFolder(folder.id);
  Assert.throws(() => info.GetTransferInfo(), /NS_ERROR_NOT_AVAILABLE/);
  Assert.throws(() => info.initFromTransferInfo(bag), /NS_ERROR_NOT_AVAILABLE/);
});
