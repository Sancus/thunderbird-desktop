/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */

let searchFolder;

add_setup(function () {
  do_get_profile();
  loadExistingDB();
  Assert.equal(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    ),
    database
  );
  const root = folderDB.insertRoot("search-state");
  searchFolder = folderDB.insertFolder(root, "Inbox");
});

/**
 * Adds a metadata-only message through the production writer.
 *
 * @param {string} messageId - Message-ID for the row.
 * @param {number} [folderId=searchFolder] - Physical folder for the row.
 * @returns {number} The physical global key.
 */
function addSearchMessage(messageId, folderId = searchFolder) {
  return messageDB.addMessage(
    folderId,
    messageId,
    [],
    123456,
    "sender",
    "recipient",
    "",
    "",
    "subject",
    0,
    "",
    0
  );
}

add_task(function test_currentStateTracksRevisions() {
  const key = addSearchMessage("state@invalid");
  const header = messageDB.getMessage(key);
  const before = messageDB.getSearchState(key);
  Assert.equal(before.messageKey, key);
  Assert.equal(before.folderId, searchFolder);
  Assert.equal(before.flags, 0);
  Assert.equal(before.storeToken, "");
  Assert.ok(Number.isSafeInteger(before.generation));
  header.subject = "changed subject";
  const edited = messageDB.getSearchState(key);
  Assert.ok(edited.generation > before.generation);
  Assert.ok(BigInt(edited.contentRevision) > BigInt(before.contentRevision));
  Assert.equal(edited.locationRevision, before.locationRevision);
  header.flags = Ci.nsMsgMessageFlags.Read;
  const flagged = messageDB.getSearchState(key);
  Assert.equal(flagged.flags, Ci.nsMsgMessageFlags.Read);
  Assert.ok(flagged.generation > edited.generation);
  Assert.equal(flagged.contentRevision, edited.contentRevision);
  header.setStringProperty("storeToken", "body-token");
  const stored = messageDB.getSearchState(key);
  Assert.equal(stored.storeToken, "body-token");
  Assert.ok(BigInt(stored.locationRevision) > BigInt(flagged.locationRevision));
  messageDB.noteMessageContentChanged(key);
  const content = messageDB.getSearchState(key);
  Assert.ok(BigInt(content.contentRevision) > BigInt(stored.contentRevision));
  Assert.equal(content.locationRevision, stored.locationRevision);
});

add_task(function test_publicationAndReplayRollBackTogether() {
  const key = addSearchMessage("rollback-control@invalid");
  const before = messageDB.getSearchState(key);
  const watermark = messageDB.getSearchChanges(0, 1).watermark;
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER fail_search_work BEFORE INSERT ON message_changes " +
      "WHEN NEW.messageId IS NOT NULL BEGIN " +
      "SELECT RAISE(ABORT, 'journal fault'); END"
  );
  try {
    Assert.throws(
      () => addSearchMessage("rollback-failed@invalid"),
      /NS_ERROR_STORAGE_CONSTRAINT/
    );
    Assert.deepEqual(messageDB.getSearchState(key), before);
    Assert.deepEqual(messageDB.getSearchChanges(watermark, 1000).changes, []);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER fail_search_work");
  }
  const next = addSearchMessage("rollback-retry@invalid");
  Assert.notEqual(next, key);
  Assert.ok(messageDB.getSearchState(next));
  messageDB.removeMessage(key);
  Assert.equal(messageDB.getSearchState(key), null);
  const changes = messageDB.getSearchChanges(watermark, 1000).changes;
  const removed = changes.filter(change => change.messageKey == key);
  Assert.ok(removed.length);
  Assert.ok(removed.at(-1).deleted);
  Assert.ok(messageDB.getSearchState(next), "The unrelated row survives");
});

add_task(function test_snapshotWatermarkSupportsLaterReplay() {
  addSearchMessage("snapshot-control@invalid");
  const first = messageDB.getSearchSnapshot(0, 1);
  Assert.equal(first.messages.length, 1);
  const original = first.messages[0];
  const late = addSearchMessage("snapshot-late@invalid");
  messageDB.getMessage(original.messageKey).subject = "after snapshot";
  const seen = first.messages.map(state => state.messageKey);
  let keyCursor = first.nextKey;
  while (true) {
    const page = messageDB.getSearchSnapshot(keyCursor, 1);
    if (!page.messages.length) {
      break;
    }
    Assert.ok(page.nextKey > keyCursor);
    seen.push(...page.messages.map(state => state.messageKey));
    keyCursor = page.nextKey;
  }
  Assert.ok(seen.includes(late));
  Assert.equal(new Set(seen).size, seen.length);
  const changes = [];
  let sequence = first.watermark;
  while (true) {
    const page = messageDB.getSearchChanges(sequence, 2);
    changes.push(...page.changes);
    if (page.nextSequence == page.watermark) {
      break;
    }
    Assert.ok(page.nextSequence > sequence);
    sequence = page.nextSequence;
  }
  Assert.ok(changes.some(change => change.messageKey == late));
  Assert.ok(changes.some(change => change.messageKey == original.messageKey));
  Assert.ok(
    BigInt(messageDB.getSearchState(original.messageKey).contentRevision) >
      BigInt(original.contentRevision)
  );
});

add_task(function test_policyInvalidationPreservesContentRevision() {
  const key = addSearchMessage("policy@invalid");
  const before = messageDB.getSearchState(key);
  const watermark = messageDB.getSearchChanges(0, 1).watermark;
  messageDB.noteSearchPolicyChanged();
  const after = messageDB.getSearchState(key);
  Assert.ok(after.generation > before.generation);
  Assert.ok(BigInt(after.policyRevision) > BigInt(before.policyRevision));
  Assert.equal(after.contentRevision, before.contentRevision);
  Assert.ok(
    messageDB
      .getSearchChanges(watermark, 1000)
      .changes.some(change => change.messageKey === null && !change.deleted)
  );
  folderDB.updateFlags(searchFolder, Ci.nsMsgFolderFlags.Junk);
  try {
    const junk = messageDB.getSearchState(key);
    Assert.equal(junk.folderFlags, Ci.nsMsgFolderFlags.Junk);
    Assert.ok(junk.generation > after.generation);
  } finally {
    folderDB.updateFlags(searchFolder, 0);
  }
});

add_task(function test_stagingAndReadFailuresAreNotEmptySuccess() {
  const key = addSearchMessage("errors@invalid");
  const before = messageDB.getSearchState(key);
  const connection = database.connectionForTests;
  connection.beginTransaction();
  try {
    messageDB.getMessage(key).setStringProperty("pending", "unpublished");
    Assert.throws(() => messageDB.getSearchState(key), /NS_ERROR_IN_PROGRESS/);
    Assert.throws(
      () => messageDB.getSearchSnapshot(0, 1),
      /NS_ERROR_IN_PROGRESS/
    );
    Assert.throws(
      () => messageDB.getSearchChanges(0, 1),
      /NS_ERROR_IN_PROGRESS/
    );
    Assert.throws(
      () => messageDB.noteMessageContentChanged(key),
      /NS_ERROR_IN_PROGRESS/
    );
    Assert.throws(
      () => messageDB.noteSearchPolicyChanged(),
      /NS_ERROR_IN_PROGRESS/
    );
  } finally {
    connection.rollbackTransaction();
  }
  Assert.deepEqual(messageDB.getSearchState(key), before);
  connection.executeSimpleSQL(
    "CREATE TEMP VIEW message_changes AS SELECT " +
      "abs(-9223372036854775808) AS sequence, messageId, contentRevision, " +
      "locationRevision, deleted FROM main.message_changes"
  );
  try {
    Assert.throws(() => messageDB.getSearchState(key), /NS_ERROR_FAILURE/);
    Assert.throws(() => messageDB.getSearchSnapshot(0, 1), /NS_ERROR_FAILURE/);
    Assert.throws(() => messageDB.getSearchChanges(0, 1), /NS_ERROR_FAILURE/);
  } finally {
    connection.executeSimpleSQL("DROP VIEW temp.message_changes");
  }
  Assert.deepEqual(messageDB.getSearchState(key), before);
  Assert.throws(
    () => messageDB.getSearchChanges(0, 0),
    /NS_ERROR_ILLEGAL_VALUE/
  );
  const end = messageDB.getSearchChanges(0, 1).watermark;
  Assert.throws(
    () => messageDB.getSearchChanges(end + 1, 1),
    /NS_ERROR_NOT_AVAILABLE/
  );
});

add_task(function test_deletedFolderRemainsReadableAndPageable() {
  const root = folderDB.insertRoot("search-orphans");
  const doomed = folderDB.insertFolder(root, "Removed");
  const survivor = folderDB.insertFolder(root, "Survivor");
  const orphanKey = addSearchMessage("orphan@invalid", doomed);
  const survivorKey = addSearchMessage("survivor@invalid", survivor);
  const before = messageDB.getSearchState(orphanKey);
  Assert.equal(before.folderFlags, 0);
  const watermark = messageDB.getSearchChanges(0, 1).watermark;
  folderDB.deleteFolder(doomed);
  const orphan = messageDB.getSearchState(orphanKey);
  Assert.equal(orphan.messageKey, orphanKey);
  Assert.equal(orphan.folderId, doomed);
  Assert.strictEqual(orphan.folderFlags, null);
  Assert.equal(orphan.contentRevision, before.contentRevision);
  Assert.ok(orphan.generation > before.generation);
  Assert.equal(messageDB.getSearchState(survivorKey).folderFlags, 0);
  const replay = messageDB.getSearchChanges(watermark, 1000);
  Assert.equal(replay.changes.length, 1);
  Assert.strictEqual(replay.changes[0].messageKey, null);
  Assert.equal(replay.changes[0].deleted, false);
  const seen = [];
  let cursor = 0;
  while (true) {
    const page = messageDB.getSearchSnapshot(cursor, 1);
    if (!page.messages.length) {
      break;
    }
    Assert.ok(page.nextKey > cursor);
    seen.push(...page.messages);
    cursor = page.nextKey;
  }
  Assert.equal(seen.filter(row => row.messageKey === orphanKey).length, 1);
  Assert.strictEqual(
    seen.find(row => row.messageKey === orphanKey).folderFlags,
    null
  );
  Assert.ok(
    seen.some(row => row.messageKey === survivorKey && row.folderFlags === 0)
  );
});

add_task(function test_unrelatedFolderPropertiesDoNotInvalidateAllMessages() {
  const key = addSearchMessage("quiet-folder-properties@invalid");
  const before = messageDB.getSearchState(key);
  const watermark = messageDB.getSearchChanges(0, 1).watermark;
  const connection = database.connectionForTests;
  for (const name of [
    "MRUTime",
    "MRMTime",
    "sortType",
    "sortOrder",
    "UIDValidity",
    "morkMigrationSource",
    "indexingpriority",
  ]) {
    connection.executeSimpleSQL(
      "INSERT INTO folder_properties(id, name, value) VALUES(" +
        searchFolder +
        ", '" +
        name +
        "', 'first')"
    );
    connection.executeSimpleSQL(
      "UPDATE folder_properties SET value = 'second' WHERE id = " +
        searchFolder +
        " AND name = '" +
        name +
        "'"
    );
    connection.executeSimpleSQL(
      "DELETE FROM folder_properties WHERE id = " +
        searchFolder +
        " AND name = '" +
        name +
        "'"
    );
  }
  Assert.deepEqual(messageDB.getSearchState(key), before);
  Assert.deepEqual(messageDB.getSearchChanges(watermark, 1000).changes, []);
});

add_task(function test_indexingPriorityChangesInvalidatePolicy() {
  const key = addSearchMessage("folder-priority@invalid");
  const connection = database.connectionForTests;
  for (const sql of [
    "INSERT INTO folder_properties(id, name, value) VALUES(" +
      searchFolder +
      ", 'indexingPriority', 'first')",
    "UPDATE folder_properties SET value = 'second' WHERE id = " +
      searchFolder +
      " AND name = 'indexingPriority'",
    "DELETE FROM folder_properties WHERE id = " +
      searchFolder +
      " AND name = 'indexingPriority'",
  ]) {
    const before = messageDB.getSearchState(key);
    const watermark = messageDB.getSearchChanges(0, 1).watermark;
    connection.executeSimpleSQL(sql);
    const after = messageDB.getSearchState(key);
    Assert.ok(after.generation > before.generation);
    Assert.ok(BigInt(after.policyRevision) > BigInt(before.policyRevision));
    Assert.equal(after.contentRevision, before.contentRevision);
    const changes = messageDB.getSearchChanges(watermark, 1000).changes;
    Assert.equal(changes.length, 1);
    Assert.strictEqual(changes[0].messageKey, null);
  }
});
