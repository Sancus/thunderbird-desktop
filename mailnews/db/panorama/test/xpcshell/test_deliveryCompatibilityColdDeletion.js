/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);

const generator = new MessageGenerator();
let rootFolder, folder, db;

add_setup(function () {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.equal(lane.store, "mbox");
  do_get_profile();
  loadExistingDB();
  const account = MailServices.accounts.createLocalMailAccount();
  rootFolder = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  folder = rootFolder
    .createLocalSubfolder("compatibility")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  db = PanoramaDelivery.assertFolder(folder, lane);
});

add_task(function test_deleteMessageNotifiesWithoutCachedHeader() {
  const source = folder.addMessage(
    generator.makeMessage({ subject: "Cold deletion" }).toMessageString()
  );
  const connection = database.connectionForTests;
  // Copy a valid standalone row without warming MessageDatabase's message cache.
  // Use the stored no-parent value instead of a legacy nsMsgKey_None sentinel.
  const insert = connection.createStatement(
    "INSERT INTO messages (id, folderId, threadId, threadParent, messageId, date, " +
      "sender, recipients, ccList, bccList, subject, flags, tags, priority) " +
      "SELECT (SELECT highWater + 1 FROM message_key_allocator WHERE singleton = 1), " +
      "folderId, threadId, threadParent, 'delivery-cold@invalid', date, " +
      "sender, recipients, ccList, bccList, subject, flags, tags, priority " +
      "FROM messages WHERE id = :id RETURNING id"
  );
  registerCleanupFunction(() => insert.finalize());
  const update = connection.createStatement(
    "UPDATE messages SET threadId = id WHERE id = :id"
  );
  registerCleanupFunction(() => update.finalize());
  let key;
  connection.beginTransaction();
  try {
    insert.params.id = source.messageKey;
    Assert.ok(
      insert.executeStep(),
      "The cold fixture copies an existing message"
    );
    key = insert.row.id;
    Assert.ok(!insert.executeStep());
    insert.reset();
    update.params.id = key;
    update.execute();
    connection.commitTransaction();
  } finally {
    insert.reset();
    if (connection.transactionInProgress) {
      connection.rollbackTransaction();
    }
  }

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
    onHdrDeleted(header, _parent, flags, instigator) {
      deleted.push([
        header.messageKey,
        header.folder.URI,
        header.messageId,
        header.subject,
        flags,
        instigator,
      ]);
    },
  };
  db.addListener(listener);
  registerCleanupFunction(() => db.removeListener(listener));
  db.deleteMessage(key, null, false);

  const remaining = connection.createStatement(
    "SELECT id FROM messages WHERE folderId = :folderId ORDER BY id"
  );
  registerCleanupFunction(() => remaining.finalize());
  remaining.params.folderId = folder.id;
  const keys = [];
  while (remaining.executeStep()) {
    keys.push(remaining.row.id);
  }
  remaining.reset();
  Assert.deepEqual(
    keys,
    [source.messageKey],
    "Only the requested row is deleted"
  );
  Assert.deepEqual(
    deleted,
    [[key, folder.URI, "delivery-cold@invalid", "Cold deletion", 0, null]],
    "An uncached deletion supplies readable header data to the folder listener"
  );
});
