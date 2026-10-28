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

function insert(folder, id, subject) {
  const db = folder.msgDatabase;
  const draft = db.createNewHdr();
  draft.messageId = id;
  draft.subject = subject;
  return db.attachHdr(draft, false);
}

function term(attrib, op, text) {
  const session = Cc["@mozilla.org/messenger/searchSession;1"].createInstance(
    Ci.nsIMsgSearchSession
  );
  const result = session.createTerm();
  result.attrib = attrib;
  result.op = op;
  result.booleanAnd = true;
  const value = result.value;
  value.attrib = attrib;
  value.str = text;
  result.value = value;
  return result;
}

add_task(function test_filterEnumeratorMatchesInFolderAndDirection() {
  const folder = root.createLocalSubfolder("filtered");
  const other = root.createLocalSubfolder("other-filtered");
  const first = insert(folder, "first@filter.invalid", "keep first");
  const excluded = insert(folder, "excluded@filter.invalid", "keep excluded");
  const last = insert(folder, "last@filter.invalid", "keep last");
  insert(folder, "different@filter.invalid", "different");
  insert(other, "foreign@filter.invalid", "keep foreign");
  excluded.setStringProperty("indexed", "yes");
  const terms = [
    term(Ci.nsMsgSearchAttrib.Subject, Ci.nsMsgSearchOp.Contains, "keep"),
    term(Ci.nsMsgSearchAttrib.HdrProperty, Ci.nsMsgSearchOp.IsEmpty, "indexed"),
  ];
  terms[1].hdrProperty = "indexed";
  const db = folder.msgDatabase;
  const forward = [...db.getFilterEnumerator(terms)];
  Assert.deepEqual(
    forward.map(h => h.messageKey),
    [first.messageKey, last.messageKey]
  );
  Assert.ok(forward.every(h => h.folder === folder));
  Assert.deepEqual(
    [...db.getFilterEnumerator(terms, true)].map(h => h.messageKey),
    [last.messageKey, first.messageKey]
  );
});

add_task(function test_filterEnumeratorEmptyTermsAndNoMatches() {
  const folder = root.createLocalSubfolder("unfiltered");
  const header = insert(folder, "all@filter.invalid", "all");
  const db = folder.msgDatabase;
  Assert.deepEqual(
    [...db.getFilterEnumerator([])].map(h => h.messageKey),
    [header.messageKey]
  );
  Assert.deepEqual(
    [
      ...db.getFilterEnumerator([
        term(Ci.nsMsgSearchAttrib.Subject, Ci.nsMsgSearchOp.Is, "absent"),
      ]),
    ],
    []
  );
  Assert.deepEqual(
    [
      ...root
        .createLocalSubfolder("empty-filter")
        .msgDatabase.getFilterEnumerator([]),
    ],
    []
  );
});

add_task(function test_filterEnumeratorPropagatesListErrors() {
  const db = root.createLocalSubfolder("filter-list-error").msgDatabase;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "ALTER TABLE messages RENAME TO unavailable_messages"
  );
  try {
    Assert.throws(
      () => db.getFilterEnumerator([]),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_messages RENAME TO messages"
    );
  }
});

add_task(function test_filterEnumeratorPropagatesIterationErrors() {
  const folder = root.createLocalSubfolder("filter-read-error");
  const header = insert(folder, "read@filter.invalid", "read");
  const enumerator = folder.msgDatabase.getFilterEnumerator([]);
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "ALTER TABLE messages RENAME TO unavailable_messages"
  );
  try {
    Assert.throws(
      () => enumerator.hasMoreElements(),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_messages RENAME TO messages"
    );
  }
  Assert.ok(enumerator.hasMoreElements());
  Assert.equal(enumerator.getNext().messageKey, header.messageKey);
  Assert.ok(!enumerator.hasMoreElements());
});

add_task(function test_filterEnumeratorRejectsDeletedFolder() {
  const folder = root.createLocalSubfolder("filter-deleted");
  const db = folder.msgDatabase;
  folderDB.deleteFolder(folder.id);
  Assert.throws(() => db.getFilterEnumerator([]), /NS_ERROR_NOT_AVAILABLE/);
});

add_task(function test_filterEnumeratorSkipsDeletedSnapshotKeys() {
  const folder = root.createLocalSubfolder("filter-concurrent-delete");
  const first = insert(folder, "first-delete@filter.invalid", "first");
  const removed = insert(folder, "removed@filter.invalid", "removed");
  const last = insert(folder, "last-delete@filter.invalid", "last");
  const db = folder.msgDatabase;
  const enumerator = db.getFilterEnumerator([]);
  Assert.equal(enumerator.getNext().messageKey, first.messageKey);
  messageDB.removeMessage(removed.messageKey);
  Assert.ok(enumerator.hasMoreElements());
  Assert.equal(enumerator.getNext().messageKey, last.messageKey);
  Assert.ok(!enumerator.hasMoreElements());
  Assert.deepEqual(db.listAllKeys(), [first.messageKey, last.messageKey]);
});

add_task(function test_filterEnumeratorSkipsReassignedSnapshotKeys() {
  const folder = root.createLocalSubfolder("filter-reassigned");
  const other = root.createLocalSubfolder("filter-reassigned-destination");
  const first = insert(folder, "first-reassigned@filter.invalid", "first");
  Assert.equal(first.numReferences, 0);
  const connection = database.connectionForTests;
  // Copy a valid metadata row without warming its MessageDatabase cache entry.
  const statement = connection.createStatement(
    "INSERT INTO messages (id, folderId, threadId, threadParent, messageId, date, " +
      "sender, recipients, ccList, bccList, subject, flags, tags, priority) " +
      "SELECT (SELECT highWater + 1 FROM message_key_allocator WHERE singleton = 1), " +
      "folderId, (SELECT highWater + 1 FROM message_key_allocator WHERE singleton = 1), " +
      "0, 'reassigned@filter.invalid', date, sender, recipients, ccList, bccList, " +
      "'reassigned', flags, tags, priority FROM messages WHERE id = :source RETURNING id"
  );
  let reassignedKey;
  connection.beginTransaction();
  try {
    statement.params.source = first.messageKey;
    Assert.ok(statement.executeStep());
    reassignedKey = statement.row.id;
    Assert.ok(!statement.executeStep());
    statement.reset();
    connection.executeSimpleSQL(
      "INSERT INTO message_reference_sets(id) VALUES (" + reassignedKey + ")"
    );
    connection.commitTransaction();
  } finally {
    statement.finalize();
    if (connection.transactionInProgress) {
      connection.rollbackTransaction();
    }
  }
  const last = insert(folder, "last-reassigned@filter.invalid", "last");
  const db = folder.msgDatabase;
  const enumerator = db.getFilterEnumerator([]);
  Assert.deepEqual(db.listAllKeys(), [
    first.messageKey,
    reassignedKey,
    last.messageKey,
  ]);
  connection.executeSimpleSQL(
    "UPDATE messages SET folderId = " +
      other.id +
      " WHERE id = " +
      reassignedKey
  );
  Assert.deepEqual(
    [...enumerator].map(h => h.messageKey),
    [first.messageKey, last.messageKey]
  );
  const reassigned = other.msgDatabase.getMsgHdrForKey(reassignedKey);
  Assert.equal(reassigned.messageId, "reassigned@filter.invalid");
  Assert.equal(reassigned.folder, other);
  Assert.deepEqual(other.msgDatabase.listAllKeys(), [reassignedKey]);
});
