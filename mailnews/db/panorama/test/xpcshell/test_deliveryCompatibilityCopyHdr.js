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

function makeDraft(db, id) {
  const header = db.createNewHdr();
  header.messageId = id;
  header.subject = "Exact subject";
  header.author = "Author <author@example.invalid>";
  header.recipients = "To <to@example.invalid>";
  header.ccList = "cc@example.invalid";
  header.bccList = "bcc@example.invalid";
  header.date = 1234567000000;
  header.priority = Ci.nsMsgPriority.high;
  header.flags = Ci.nsMsgMessageFlags.Read;
  header.setStringProperty("custom", "00042");
  header.setStringProperty("Custom", "different");
  header.setStringProperty("empty", "");
  header.accountKey = "";
  header.charset = "ISO-8859-1";
  header.setStringProperty("keywords", "tag1 tag2");
  header.messageSize = 0;
  header.storeToken = "";
  return header;
}

function checkCopy(header, folder) {
  Assert.equal(header.folder, folder);
  Assert.equal(header.subject, "Exact subject");
  Assert.equal(header.author, "Author <author@example.invalid>");
  Assert.equal(header.recipients, "To <to@example.invalid>");
  Assert.equal(header.ccList, "cc@example.invalid");
  Assert.equal(header.bccList, "bcc@example.invalid");
  Assert.equal(header.date, 1234567000000);
  Assert.equal(header.priority, Ci.nsMsgPriority.high);
  Assert.equal(header.flags, Ci.nsMsgMessageFlags.Read);
  Assert.equal(header.getStringProperty("custom"), "00042");
  Assert.equal(header.getStringProperty("Custom"), "different");
  Assert.equal(header.getStringProperty("empty"), "");
  Assert.equal(header.accountKey, "");
  Assert.equal(header.charset, "ISO-8859-1");
  Assert.equal(header.getStringProperty("keywords"), "tag1 tag2");
  const names = header.properties;
  for (const name of ["empty", "account", "messageSize", "storeToken"]) {
    Assert.ok(names.includes(name), name + " is explicitly present");
  }
  Assert.ok(!names.includes("offlineMessageSize"));
  Assert.ok(!names.includes("lineCount"));
  Assert.equal(header.messageSize, 0);
  Assert.equal(header.storeToken, "");
}

function storedReferences(key) {
  const statement = database.connectionForTests.createStatement(
    "SELECT token FROM message_references WHERE id = :id ORDER BY ordinal"
  );
  statement.params.id = key;
  const result = [];
  try {
    while (statement.executeStep()) {
      result.push(statement.row.token);
    }
  } finally {
    statement.finalize();
  }
  return result;
}

add_task(function test_copyDetachedHeaderWithoutPublishing() {
  const source = root.createLocalSubfolder("copy-draft-source");
  const destination = root.createLocalSubfolder("copy-draft-destination");
  const original = makeDraft(source.msgDatabase, "draft@copy.invalid");
  original.setReferences("<first@copy.invalid> <last@copy.invalid>");
  const db = destination.msgDatabase;
  const copy = db.copyHdrFromExistingHdr(0xffffffff, original, false);
  Assert.equal(copy.isLive, false);
  Assert.equal(copy.messageKey, 0xffffffff);
  Assert.deepEqual(db.listAllKeys(), []);
  checkCopy(copy, destination);
  copy.subject = "Changed copy";
  Assert.equal(original.subject, "Exact subject");
  const live = db.attachHdr(copy, false);
  Assert.equal(live.subject, "Changed copy");
  Assert.equal(live.numReferences, 2);
  Assert.equal(live.getStringReference(1), "last@copy.invalid");
  Assert.deepEqual(storedReferences(live.messageKey), [
    "first@copy.invalid",
    "last@copy.invalid",
  ]);
});

add_task(
  function test_copyLiveHeaderPreservesLiteralReferencesAndPublishesOnce() {
    const source = root.createLocalSubfolder("copy-live-source");
    const destination = root.createLocalSubfolder("copy-live-destination");
    const original = source.msgDatabase.attachHdr(
      makeDraft(source.msgDatabase, "self@copy.invalid"),
      false
    );
    original.setReferences(
      "<first@copy.invalid> <self@copy.invalid> <unresolved@copy.invalid> <first@copy.invalid>"
    );
    Assert.equal(original.getStringProperty("keywords"), "tag1 tag2");
    Assert.ok(!original.properties.includes("keywords"));
    const db = destination.msgDatabase;
    const added = [];
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
      onHdrFlagsChanged() {},
      onHdrDeleted() {},
      onParentChanged() {},
      onAnnouncerGoingAway() {},
      onReadChanged() {},
      onJunkScoreChanged() {},
      onHdrPropertyChanged() {},
      onEvent() {},
      onHdrAdded(header) {
        checkCopy(header, destination);
        added.push(header.messageKey);
        Assert.deepEqual(storedReferences(header.messageKey), [
          "first@copy.invalid",
          "self@copy.invalid",
          "unresolved@copy.invalid",
          "first@copy.invalid",
        ]);
      },
    };
    db.addListener(listener);
    let copy;
    try {
      copy = db.copyHdrFromExistingHdr(0xffffffff, original, true);
    } finally {
      db.removeListener(listener);
    }
    Assert.ok(copy.isLive);
    Assert.notEqual(copy.messageKey, original.messageKey);
    Assert.deepEqual(added, [copy.messageKey]);
    Assert.deepEqual(db.listAllKeys(), [copy.messageKey]);
    Assert.equal(original.folder, source);
    Assert.equal(copy.numReferences, 3);
    Assert.equal(copy.getStringReference(2), "first@copy.invalid");
  }
);

add_task(function test_copyErrorsLeaveDestinationUnchanged() {
  const source = root.createLocalSubfolder("copy-error-source");
  const destination = root.createLocalSubfolder("copy-error-destination");
  const original = source.msgDatabase.attachHdr(
    makeDraft(source.msgDatabase, "error@copy.invalid"),
    false
  );
  const db = destination.msgDatabase;
  Assert.throws(
    () => db.copyHdrFromExistingHdr(123, original, true),
    /NS_ERROR_NOT_IMPLEMENTED/
  );
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_copy BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'copy error'); END"
  );
  try {
    Assert.throws(
      () => db.copyHdrFromExistingHdr(0xffffffff, original, true),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.deepEqual(db.listAllKeys(), []);
    Assert.equal(
      source.msgDatabase.getMsgHdrForKey(original.messageKey).messageId,
      "error@copy.invalid"
    );
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_copy");
  }
});

add_task(function test_unavailableReferencesDoNotBecomeKnownEmptyCopies() {
  const source = root.createLocalSubfolder("copy-unavailable-source");
  const destination = root.createLocalSubfolder("copy-unavailable-destination");
  const original = source.msgDatabase.attachHdr(
    makeDraft(source.msgDatabase, "unavailable@copy.invalid"),
    false
  );
  database.connectionForTests.executeSimpleSQL(
    "DELETE FROM message_reference_sets WHERE id = " + original.messageKey
  );
  Assert.throws(
    () =>
      destination.msgDatabase.copyHdrFromExistingHdr(
        0xffffffff,
        original,
        true
      ),
    /NS_ERROR_NOT_AVAILABLE/
  );
  Assert.deepEqual(destination.msgDatabase.listAllKeys(), []);
  Assert.equal(original.folder, source);
});

add_task(function test_liveHeaderFolderRemainsReadableAfterDeletion() {
  const folder = root.createLocalSubfolder("header-folder-deleted");
  const db = folder.msgDatabase;
  const header = db.attachHdr(makeDraft(db, "folder@copy.invalid"), false);
  const key = header.messageKey;
  const uri = folder.URI;
  Assert.equal(header.folder, folder);
  const deleted = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged() {},
    onHdrAdded() {},
    onParentChanged() {},
    onAnnouncerGoingAway() {},
    onReadChanged() {},
    onJunkScoreChanged() {},
    onHdrPropertyChanged() {},
    onEvent() {},
    onHdrDeleted(removed) {
      Assert.equal(removed.messageKey, key);
      Assert.equal(removed.folder, folder);
      Assert.equal(removed.folder.URI, uri);
      Assert.ok(!db.containsKey(key));
      deleted.push(removed.messageKey);
    },
  };
  db.addListener(listener);
  try {
    messageDB.removeMessage(key);
  } finally {
    db.removeListener(listener);
  }
  Assert.deepEqual(deleted, [key]);
  Assert.equal(header.folder, folder);
  Assert.equal(header.folder.URI, uri);
  Assert.ok(!db.containsKey(key));
});
