/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server.js */

let core;
let otherFolder;
let otherHeader;

add_setup(async function () {
  const storeContract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  Services.prefs.setCharPref(
    "mail.server.default.storeContractID",
    storeContract
  );
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
  setupIMAPPump();
  IMAPPump.incomingServer.maximumConnectionsNumber = 1;
  registerCleanupFunction(teardownIMAPPump);
  core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  );
  Assert.ok(
    core instanceof Ci.nsIMsgDBService,
    "Panorama supplies the database service"
  );
  const expectedStoreType = {
    "@mozilla.org/msgstore/berkeleystore;1": "mbox",
    "@mozilla.org/msgstore/maildirstore;1": "maildir",
  }[storeContract];
  Assert.ok(expectedStoreType);
  Assert.equal(IMAPPump.incomingServer.msgStore.storeType, expectedStoreType);
  otherFolder = await createImapSubfolder("OtherEpoch");
  otherFolder.msgDatabase.dBFolderInfo.imapUidValidity = 9101;
  IMAPPump.daemon.getMailbox("OtherEpoch").uidvalidity = 9101;
  otherHeader = addResetHeader(
    otherFolder,
    "other-folder@example.invalid",
    6101
  );
});

add_task(async function test_removesOnlyConfirmedOldEpochRecords() {
  const { folder, db, info, mailbox } =
    await createResetFolder("EpochRetained");
  const stale = [
    addResetHeader(folder, "stale-first@example.invalid", 6101),
    addResetHeader(folder, "stale-second@example.invalid", 6102),
  ];
  const zero = addResetHeader(folder, "uid-zero@example.invalid", 0);
  const local = addResetHeader(folder, "local-only@example.invalid");
  const pending = addResetHeader(
    folder,
    "unconfirmed@example.invalid",
    6999,
    true
  );
  pending.setStringProperty("pending-state", "awaiting-append");
  const retainedKeys = [zero.messageKey, local.messageKey, pending.messageKey];
  Assert.equal(db.dBFolderInfo.numMessages, 5);
  Assert.notEqual(stale[0].messageKey, 6101, "The physical key is not the UID");
  Assert.equal(stale[0].folder, folder);
  Assert.equal(stale[1].folder, folder);
  info.imapTotalPendingMessages = 2;
  info.imapUnreadPendingMessages = 1;
  assertResetCounts(folder, 5, 2, 1);

  await updateResetFolder(folder);

  Assert.deepEqual(
    Array.from(folder.messages, header => header.messageId).sort(),
    [
      "local-only@example.invalid",
      "uid-zero@example.invalid",
      "unconfirmed@example.invalid",
    ],
    "Only local and unconfirmed records survive the new epoch"
  );
  for (const header of stale) {
    Assert.ok(
      !db.containsKey(header.messageKey),
      "The stale physical key is no longer live"
    );
  }
  Assert.deepEqual(
    Array.from(folder.messages, header => header.messageKey).sort(
      (a, b) => a - b
    ),
    retainedKeys.sort((a, b) => a - b),
    "Retained records keep their physical identities"
  );
  Assert.equal(pending.getUint32Property("pseudoHdr"), 1);
  Assert.equal(pending.getStringProperty("pending-state"), "awaiting-append");
  Assert.equal(
    pending.getUint32Property("uidOnServer"),
    0,
    "The copied old UID is retired"
  );
  Assert.equal(zero.getUint32Property("uidOnServer"), 0);
  Assert.equal(local.getUint32Property("uidOnServer"), 0);
  Assert.equal(folder.getTotalMessages(false), 3);
  Assert.equal(info.numMessages, 3);
  assertResetCounts(folder, 3);
  Assert.equal(info.imapUidValidity, 7202);
  Assert.equal(info.getCharProperty("highestModSeq"), "");
  Assert.equal(info.getUint32Property("highestRecordedUID", 0), 0);
  Assert.equal(info.viewFlags, Ci.nsMsgViewFlagsType.kUnreadOnly);
  Assert.equal(
    otherFolder.msgDatabase.containsKey(otherHeader.messageKey),
    true
  );
  Assert.equal(otherHeader.messageId, "other-folder@example.invalid");
  Assert.equal(otherHeader.getUint32Property("uidOnServer"), 6101);
  Assert.equal(otherFolder.msgDatabase.dBFolderInfo.imapUidValidity, 9101);
  Assert.equal(otherFolder.getTotalMessages(false), 1);
  Assert.equal(mailbox.uidvalidity, 7202);
  Assert.deepEqual(
    mailbox._messages.map(message => message.uid),
    []
  );

  await updateResetFolder(folder);
  Assert.deepEqual(
    Array.from(folder.messages, header => header.messageKey).sort(
      (a, b) => a - b
    ),
    retainedKeys,
    "Ordinary repeated synchronization preserves every retained local identity"
  );
  Assert.equal(info.numMessages, 3);
  Assert.equal(info.imapUidValidity, 7202);
  Assert.equal(pending.getStringProperty("pending-state"), "awaiting-append");
  assertResetCounts(folder, 3);

  const pendingKey = pending.messageKey;
  const reopened = reopenResetFolder(folder);
  assertResetCounts(folder, 3);
  Assert.equal(reopened.dBFolderInfo.imapUidValidity, 7202);
  Assert.deepEqual(
    reopened.listAllKeys().sort((a, b) => a - b),
    retainedKeys,
    "Reopening preserves the reconciled membership"
  );
  const reopenedPending = reopened.getMsgHdrForKey(pendingKey);
  Assert.equal(reopenedPending.getUint32Property("pseudoHdr"), 1);
  Assert.equal(reopenedPending.getUint32Property("uidOnServer"), 0);
  Assert.equal(
    reopenedPending.getStringProperty("pending-state"),
    "awaiting-append"
  );
  await updateResetFolder(folder);
  assertResetCounts(folder, 3);
  Assert.deepEqual(
    reopened.listAllKeys().sort((a, b) => a - b),
    retainedKeys,
    "Synchronization after reopening does not reconcile the reset twice"
  );
});

add_task(async function test_validatesAllBindingsBeforeDeletion() {
  const { folder, db, info } = await createResetFolder("EpochAmbiguous");
  const first = addResetHeader(folder, "valid-first@example.invalid", 6101);
  const ambiguous = [
    addResetHeader(folder, "ambiguous-first@example.invalid", 6102),
    addResetHeader(folder, "ambiguous-second@example.invalid", 6102),
  ];

  await expectResetFailure(folder, Cr.NS_ERROR_FILE_CORRUPTED);

  Assert.deepEqual(
    Array.from(folder.messages, header => header.messageId).sort(),
    [
      "ambiguous-first@example.invalid",
      "ambiguous-second@example.invalid",
      "valid-first@example.invalid",
    ],
    "An ambiguous binding prevents every deletion, including valid earlier entries"
  );
  for (const header of [first, ...ambiguous]) {
    Assert.ok(db.containsKey(header.messageKey));
  }
  Assert.equal(info.numMessages, 3);
  Assert.equal(info.imapUidValidity, 7101);
  Assert.equal(info.getUint32Property("highestRecordedUID", 0), 6999);
});

add_task(async function test_propagatesDeletionFailureAndRetries() {
  const { folder, db, info } = await createResetFolder("EpochDeleteFailure");
  const stale = addResetHeader(folder, "delete-failure@example.invalid", 6101);
  stale.storeToken = "retained-body-token";
  stale.setStringProperty("retained-property", "keep-on-failure");
  const staleKey = stale.messageKey;
  info.imapTotalPendingMessages = 3;
  info.imapUnreadPendingMessages = 2;
  assertResetCounts(folder, 1, 3, 2);
  core.connectionForTests.executeSimpleSQL(
    "CREATE TEMP TRIGGER fail_epoch_delete BEFORE DELETE ON messages " +
      "WHEN OLD.id = " +
      stale.messageKey +
      " " +
      "BEGIN SELECT RAISE(ABORT, 'epoch delete failure'); END"
  );
  try {
    await expectResetFailure(folder, Cr.NS_ERROR_STORAGE_CONSTRAINT);
    Assert.ok(
      db.containsKey(stale.messageKey),
      "The failed deletion leaves the record live"
    );
    Assert.equal(stale.getUint32Property("uidOnServer"), 6101);
    Assert.equal(
      stale.getStringProperty("retained-property"),
      "keep-on-failure"
    );
    Assert.equal(stale.storeToken, "retained-body-token");
    Assert.equal(
      info.imapUidValidity,
      7101,
      "A failed deletion does not advance the epoch"
    );
    Assert.equal(info.getUint32Property("highestRecordedUID", 0), 6999);
    Assert.equal(info.numMessages, 1);
    assertResetCounts(folder, 1);
  } finally {
    core.connectionForTests.executeSimpleSQL("DROP TRIGGER fail_epoch_delete");
  }

  const reopened = reopenResetFolder(folder);
  assertResetCounts(folder, 1);
  Assert.equal(reopened.dBFolderInfo.imapUidValidity, 7101);
  const retained = reopened.getMsgHdrForKey(staleKey);
  Assert.equal(retained.getUint32Property("uidOnServer"), 6101);
  Assert.equal(
    retained.getStringProperty("retained-property"),
    "keep-on-failure"
  );
  Assert.equal(retained.storeToken, "retained-body-token");

  await updateResetFolder(folder);
  Assert.ok(!reopened.containsKey(staleKey));
  Assert.deepEqual(Array.from(folder.messages), []);
  Assert.equal(reopened.dBFolderInfo.numMessages, 0);
  Assert.equal(reopened.dBFolderInfo.imapUidValidity, 7202);
  Assert.equal(
    reopened.dBFolderInfo.getUint32Property("highestRecordedUID", 0),
    0
  );
  assertResetCounts(folder, 0);
  await updateResetFolder(folder);
  assertResetCounts(folder, 0);
  const afterRetry = reopenResetFolder(folder);
  Assert.equal(afterRetry.dBFolderInfo.imapUidValidity, 7202);
  Assert.deepEqual(afterRetry.listAllKeys(), []);
  assertResetCounts(folder, 0);
});

add_task(async function test_propagatesEpochStorageFailureAndRetries() {
  const { folder, db, info } = await createResetFolder("EpochWriteFailure");
  const stale = addResetHeader(
    folder,
    "epoch-write-failure@example.invalid",
    6101
  );
  const local = addResetHeader(
    folder,
    "retained-after-write-failure@example.invalid",
    0
  );
  const localKey = local.messageKey;
  info.imapTotalPendingMessages = -1;
  info.imapUnreadPendingMessages = -1;
  assertResetCounts(folder, 2, -1, -1);
  core.connectionForTests.executeSimpleSQL(
    "CREATE TEMP TRIGGER fail_epoch_write BEFORE INSERT ON folder_properties " +
      "WHEN NEW.id = " +
      folder.id +
      " AND NEW.name = 'UIDValidity' " +
      "BEGIN SELECT RAISE(ABORT, 'epoch write failure'); END"
  );
  try {
    await expectResetFailure(folder, Cr.NS_ERROR_STORAGE_CONSTRAINT);
    Assert.equal(
      info.imapUidValidity,
      7101,
      "A failed epoch write is not reported as committed"
    );
    Assert.ok(
      !db.containsKey(stale.messageKey),
      "Earlier record deletion is not falsely rolled back"
    );
    Assert.ok(db.containsKey(local.messageKey));
    Assert.equal(info.numMessages, 1);
    assertResetCounts(folder, 1);
  } finally {
    core.connectionForTests.executeSimpleSQL("DROP TRIGGER fail_epoch_write");
  }

  const reopened = reopenResetFolder(folder);
  Assert.equal(reopened.dBFolderInfo.imapUidValidity, 7101);
  Assert.deepEqual(reopened.listAllKeys(), [localKey]);
  assertResetCounts(folder, 1);
  await updateResetFolder(folder);
  Assert.equal(reopened.dBFolderInfo.imapUidValidity, 7202);
  Assert.deepEqual(
    Array.from(folder.messages, header => [
      header.messageId,
      header.messageKey,
    ]),
    [["retained-after-write-failure@example.invalid", localKey]]
  );
  Assert.equal(reopened.dBFolderInfo.numMessages, 1);
  assertResetCounts(folder, 1);
  await updateResetFolder(folder);
  assertResetCounts(folder, 1);
  const afterRetry = reopenResetFolder(folder);
  Assert.equal(afterRetry.dBFolderInfo.imapUidValidity, 7202);
  Assert.deepEqual(afterRetry.listAllKeys(), [localKey]);
  Assert.equal(
    afterRetry.getMsgHdrForKey(localKey).getUint32Property("uidOnServer"),
    0
  );
  assertResetCounts(folder, 1);
});

add_task(async function test_retainsPendingOperationWithoutLiveSource() {
  const { folder, db, info, mailbox } =
    await createResetFolder("EpochPendingSource");
  const source = addResetHeader(folder, "moved-source@example.invalid", 6101);
  const sourceKey = source.messageKey;
  const local = addResetHeader(folder, "pending-local@example.invalid", 0);
  const ops = db.QueryInterface(Ci.nsIMsgOfflineOpsDatabase);
  const op = ops.getOfflineOpForKey(sourceKey, true);
  op.operation = Ci.nsIMsgOfflineImapOperation.kMsgMoved;
  op.srcMessageKey = sourceKey;
  op.srcUid = 6101;
  op.destinationFolderURI = otherFolder.URI;
  db.deleteMessages([sourceKey], null);
  const serverMessage = addEpochMessage(
    mailbox,
    6101,
    "reused-pending-uid@example.invalid",
    "New epoch pending UID body."
  );
  Assert.ok(!db.containsKey(sourceKey));
  Assert.ok(folder.getFlag(Ci.nsMsgFolderFlags.OfflineEvents));
  Assert.deepEqual(ops.listAllOfflineOpIds(), [sourceKey]);
  Assert.deepEqual(
    Array.from(folder.messages, header => header.messageKey),
    [local.messageKey]
  );
  Assert.equal(local.getUint32Property("uidOnServer"), 0);

  // Call the ordinary sync URL directly, without starting offline playback.
  await expectResetFailure(folder, Cr.NS_ERROR_NOT_AVAILABLE, true);
  Assert.equal(info.imapUidValidity, 7101);
  Assert.equal(info.numMessages, 1);
  Assert.equal(info.getCharProperty("highestModSeq"), "12345");
  Assert.equal(info.getUint32Property("highestRecordedUID", 0), 6999);
  Assert.deepEqual(
    Array.from(folder.messages, header => header.messageKey),
    [local.messageKey]
  );
  const retained = ops.getOfflineOpForKey(sourceKey, false);
  Assert.equal(retained.operation, Ci.nsIMsgOfflineImapOperation.kMsgMoved);
  Assert.equal(retained.srcMessageKey, sourceKey);
  Assert.equal(retained.srcUid, 6101);
  Assert.equal(retained.destinationFolderURI, otherFolder.URI);
  Assert.equal(retained.playingBack, false);

  const transactions = IMAPPump.server.playTransaction();
  const commands = (
    Array.isArray(transactions) ? transactions : [transactions]
  ).flatMap(transaction => transaction.them);
  const selected = commands.filter(command => / select /i.test(command)).length;
  Assert.greater(selected, 0, "The failed reset reached a real SELECT");
  const uri = MailServices.imap.storeCustomKeywords(
    folder,
    null,
    "blocked-epoch",
    "",
    String(retained.srcUid)
  );
  const listener = new PromiseTestUtils.PromiseUrlListener();
  uri.QueryInterface(Ci.nsIMsgMailNewsUrl).RegisterListener(listener);
  await Assert.rejects(
    listener.promise,
    error => error.message == String(Cr.NS_ERROR_NOT_AVAILABLE)
  );
  const after = IMAPPump.server.playTransaction();
  const afterCommands = (Array.isArray(after) ? after : [after]).flatMap(
    transaction => transaction.them
  );
  Assert.equal(
    afterCommands.filter(command => / select /i.test(command)).length,
    selected,
    "The stale command reused the already-selected connection"
  );
  Assert.ok(
    !afterCommands
      .slice(commands.length)
      .some(command => / uid store /i.test(command)),
    "No old-epoch STORE was sent"
  );
  Assert.deepEqual(serverMessage.flags, []);
  Assert.deepEqual(
    mailbox._messages.map(message => message.uid),
    [6101]
  );
  Assert.equal(info.imapUidValidity, 7101);
  Assert.deepEqual(ops.listAllOfflineOpIds(), [sourceKey]);

  // The ordinary playback entry must retain the operation on epoch mismatch.
  await expectResetFailure(folder, Cr.NS_ERROR_NOT_AVAILABLE);
  Assert.equal(info.imapUidValidity, 7101);
  Assert.ok(folder.getFlag(Ci.nsMsgFolderFlags.OfflineEvents));
  Assert.deepEqual(ops.listAllOfflineOpIds(), [sourceKey]);
  const held = ops.getOfflineOpForKey(sourceKey, false);
  Assert.equal(held.operation, Ci.nsIMsgOfflineImapOperation.kMsgMoved);
  Assert.equal(held.srcUid, 6101);
  Assert.equal(held.destinationFolderURI, otherFolder.URI);
  Assert.deepEqual(
    Array.from(folder.messages, header => header.messageKey),
    [local.messageKey]
  );
  Assert.deepEqual(serverMessage.flags, []);
  Assert.deepEqual(
    mailbox._messages.map(message => message.uid),
    [6101]
  );
});

add_task(async function test_refetchesReusedUidsAfterFailedReset() {
  const { folder, db, info, mailbox } =
    await createResetFolder("EpochRetryUids");
  const stale = addResetHeader(folder, "retry-old@example.invalid", 6101);
  const pending = addResetHeader(
    folder,
    "retry-pending@example.invalid",
    6999,
    true
  );
  addEpochMessage(
    mailbox,
    6101,
    "retry-new-low@example.invalid",
    "New low UID body."
  );
  addEpochMessage(
    mailbox,
    6999,
    "retry-new-high@example.invalid",
    "New high UID body."
  );
  core.connectionForTests.executeSimpleSQL(
    "CREATE TEMP TRIGGER fail_epoch_retry BEFORE DELETE ON messages " +
      "WHEN OLD.id = " +
      stale.messageKey +
      " " +
      "BEGIN SELECT RAISE(ABORT, 'epoch retry failure'); END"
  );
  try {
    await expectResetFailure(folder, Cr.NS_ERROR_STORAGE_CONSTRAINT);
    Assert.equal(info.imapUidValidity, 7101);
    Assert.equal(info.getCharProperty("highestModSeq"), "12345");
    Assert.equal(info.getUint32Property("highestRecordedUID", 0), 6999);
    Assert.ok(db.containsKey(stale.messageKey));
    Assert.equal(pending.getUint32Property("uidOnServer"), 6999);
  } finally {
    core.connectionForTests.executeSimpleSQL("DROP TRIGGER fail_epoch_retry");
  }

  await updateResetFolder(folder);
  const headers = Array.from(folder.messages);
  Assert.deepEqual(headers.map(header => header.messageId).sort(), [
    "retry-new-high@example.invalid",
    "retry-new-low@example.invalid",
    "retry-pending@example.invalid",
  ]);
  Assert.ok(!db.containsKey(stale.messageKey));
  for (const [id, uid] of [
    ["retry-new-low@example.invalid", 6101],
    ["retry-new-high@example.invalid", 6999],
  ]) {
    const header = headers.find(item => item.messageId == id);
    Assert.notEqual(header.messageKey, stale.messageKey);
    Assert.notEqual(header.messageKey, pending.messageKey);
    Assert.notEqual(header.messageKey, uid);
    Assert.equal(header.getUint32Property("uidOnServer"), uid);
    Assert.equal(header.folder, folder);
  }
  Assert.ok(db.containsKey(pending.messageKey));
  Assert.equal(pending.getUint32Property("pseudoHdr"), 1);
  Assert.equal(pending.getUint32Property("uidOnServer"), 0);
  Assert.equal(info.imapUidValidity, 7202);
  Assert.equal(info.numMessages, 3);
  Assert.deepEqual(
    mailbox._messages.map(message => message.uid),
    [6101, 6999]
  );
});

add_task(async function test_refusesUnscopedServerBinding() {
  const { folder, db, info } = await createResetFolder("EpochUnknown");
  info.imapUidValidity = 0;
  const unscoped = addResetHeader(folder, "unscoped@example.invalid", 6101);
  await expectResetFailure(folder, Cr.NS_ERROR_NOT_AVAILABLE);
  Assert.equal(info.imapUidValidity, 0);
  Assert.ok(db.containsKey(unscoped.messageKey));
  Assert.equal(unscoped.getUint32Property("uidOnServer"), 6101);
  Assert.equal(info.numMessages, 1);
});

add_task(async function test_globalPlaybackContinuesPastHeldEpoch() {
  const held =
    IMAPPump.incomingServer.rootFolder.getChildNamed("EpochPendingSource");
  const heldDB = held.msgDatabase.QueryInterface(Ci.nsIMsgOfflineOpsDatabase);
  const [heldKey] = heldDB.listAllOfflineOpIds();
  Assert.ok(heldKey);
  const heldOp = heldDB.getOfflineOpForKey(heldKey, false);
  const savedIntent = [
    heldOp.operation,
    heldOp.srcMessageKey,
    heldOp.srcUid,
    heldOp.destinationFolderURI,
  ];
  const savedKeys = heldDB.listAllKeys();
  const { folder, mailbox } = await createResetFolder("ZLaterEpochReplay");
  const serverMessage = addEpochMessage(
    mailbox,
    6101,
    "later-epoch-replay@example.invalid",
    "Later legitimate flag replay."
  );
  await updateResetFolder(folder);
  const header = folder.msgDatabase.getMsgHdrForMessageID(
    "later-epoch-replay@example.invalid"
  );
  const key = header.messageKey;
  Assert.notEqual(key, 6101);
  const order = IMAPPump.incomingServer.rootFolder.descendants;
  Assert.less(order.indexOf(held), order.indexOf(folder));
  Services.io.offline = true;
  try {
    folder.markMessagesFlagged([header], true);
  } finally {
    Services.io.offline = false;
  }
  const laterDB = folder.msgDatabase.QueryInterface(
    Ci.nsIMsgOfflineOpsDatabase
  );
  Assert.deepEqual(laterDB.listAllOfflineOpIds(), [key]);
  let completions = 0;
  const listener = new PromiseTestUtils.PromiseUrlListener({
    OnStopRunningUrl() {
      completions++;
    },
  });
  MailServices.imap.playbackAllOfflineOperations(null, listener);
  await Assert.rejects(
    listener.promise,
    error => error.message == String(Cr.NS_ERROR_NOT_AVAILABLE)
  );
  Assert.equal(
    completions,
    1,
    "Global playback reports its first failure once"
  );
  Assert.ok(serverMessage.flags.includes("\\Flagged"));
  Assert.equal(header.messageKey, key);
  Assert.equal(header.getUint32Property("uidOnServer"), 6101);
  Assert.equal(laterDB.dBFolderInfo.imapUidValidity, 7202);
  Assert.deepEqual(laterDB.listAllOfflineOpIds(), []);
  Assert.deepEqual(heldDB.listAllOfflineOpIds(), [heldKey]);
  Assert.deepEqual(heldDB.listAllKeys(), savedKeys);
  Assert.equal(heldDB.dBFolderInfo.imapUidValidity, 7101);
  const retained = heldDB.getOfflineOpForKey(heldKey, false);
  Assert.deepEqual(
    [
      retained.operation,
      retained.srcMessageKey,
      retained.srcUid,
      retained.destinationFolderURI,
    ],
    savedIntent
  );
  Assert.equal(retained.playingBack, false);
  Assert.deepEqual(
    IMAPPump.daemon.getMailbox("EpochPendingSource")._messages[0].flags,
    []
  );

  Services.io.offline = true;
  try {
    folder.markMessagesFlagged([header], false);
    folder.storeCustomKeywords(null, "epoch-kept", "", [key]);
  } finally {
    Services.io.offline = false;
  }
  const queued = laterDB.getOfflineOpForKey(key, false);
  const savedFlags = queued.newFlags;
  Assert.equal(
    queued.operation,
    Ci.nsIMsgOfflineImapOperation.kFlagsChanged |
      Ci.nsIMsgOfflineImapOperation.kAddKeywords
  );
  Assert.equal(queued.keywordsToAdd, "epoch-kept");
  core.connectionForTests.executeSimpleSQL(
    "CREATE TEMP TRIGGER fail_completed_flag_delete " +
      "BEFORE DELETE ON offline_operations WHEN OLD.folderId = " +
      folder.id +
      " AND OLD.messageKey = " +
      key +
      " BEGIN SELECT RAISE(ABORT, 'confirmed flag cleanup failure'); END"
  );
  try {
    await expectResetFailure(folder, Cr.NS_ERROR_STORAGE_CONSTRAINT);
    Assert.ok(!serverMessage.flags.includes("\\Flagged"));
    // The standard fake server canonicalizes keyword capitalization.
    Assert.ok(serverMessage.flags.includes("Epoch-kept"));
    Assert.equal(queued.keywordsToAdd, "epoch-kept");
    Assert.deepEqual(laterDB.listAllOfflineOpIds(), [key]);
    Assert.equal(queued.newFlags, savedFlags);
    Assert.equal(queued.playingBack, false);
    Assert.ok(folder.getFlag(Ci.nsMsgFolderFlags.OfflineEvents));
    assertResetCounts(folder, 1);
  } finally {
    core.connectionForTests.executeSimpleSQL(
      "DROP TRIGGER fail_completed_flag_delete"
    );
  }

  const transactions = IMAPPump.server.playTransaction();
  const commands = (
    Array.isArray(transactions) ? transactions : [transactions]
  ).flatMap(transaction => transaction.them);
  const reopened = reopenResetFolder(folder).QueryInterface(
    Ci.nsIMsgOfflineOpsDatabase
  );
  Assert.deepEqual(reopened.listAllOfflineOpIds(), [key]);
  Assert.equal(reopened.getOfflineOpForKey(key, false).newFlags, savedFlags);
  await updateResetFolder(folder);
  const after = IMAPPump.server.playTransaction();
  const afterCommands = (Array.isArray(after) ? after : [after]).flatMap(
    transaction => transaction.them
  );
  Assert.ok(
    !afterCommands
      .slice(commands.length)
      .some(command => / uid store /i.test(command)),
    "Local cleanup after reopen does not resend the confirmed flag command"
  );
  Assert.deepEqual(reopened.listAllOfflineOpIds(), []);
  Assert.ok(!folder.getFlag(Ci.nsMsgFolderFlags.OfflineEvents));
  Assert.ok(!serverMessage.flags.includes("\\Flagged"));
  Assert.ok(serverMessage.flags.includes("Epoch-kept"));
  assertResetCounts(folder, 1);

  mailbox.uidvalidity = 7303;
  IMAPPump.incomingServer.closeCachedConnections();
  await updateResetFolder(folder);
  const fresh = folder.msgDatabase.getMsgHdrForMessageID(
    "later-epoch-replay@example.invalid"
  );
  Assert.notEqual(fresh.messageKey, key);
  Assert.ok(!folder.msgDatabase.containsKey(key));
  Assert.equal(fresh.getUint32Property("uidOnServer"), 6101);
  Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 7303);
  assertResetCounts(folder, 1);
  Assert.deepEqual(heldDB.listAllOfflineOpIds(), [heldKey]);
});

/**
 * Adds an independent literal new-epoch message to the disposable server.
 *
 * @param {object} mailbox - The server mailbox.
 * @param {number} uid - The new epoch's UID.
 * @param {string} id - The literal Message-ID.
 * @param {string} body - The literal body text.
 * @returns {ImapMessage} The server message.
 */
function addEpochMessage(mailbox, uid, id, body) {
  const source =
    "Message-ID: <" +
    id +
    ">\r\n" +
    "From: sender@example.invalid\r\n" +
    "To: recipient@example.invalid\r\n" +
    "Subject: New epoch message\r\n" +
    "Date: Sat, 1 Nov 2025 00:00:00 +0000\r\n\r\n" +
    body +
    "\r\n";
  const message = new ImapMessage(
    "data:text/plain;base64," + btoa(source),
    uid,
    []
  );
  mailbox.addMessage(message);
  mailbox.uidnext = Math.max(mailbox.uidnext, uid + 1);
  return message;
}

/**
 * Creates a disposable server folder with an old local epoch and a new server epoch.
 *
 * @param {string} name - The mailbox name.
 * @returns {Promise<object>} The folder, database, folder info and server mailbox.
 */
async function createResetFolder(name) {
  const folder = await createImapSubfolder(name);
  folder.clearFlag(Ci.nsMsgFolderFlags.Offline);
  const db = folder.msgDatabase;
  Assert.equal(db.folder, folder);
  Assert.greater(folder.id, 0);
  const info = db.dBFolderInfo;
  info.imapUidValidity = 7101;
  info.setCharProperty("highestModSeq", "12345");
  info.setUint32Property("highestRecordedUID", 6999);
  info.viewFlags = Ci.nsMsgViewFlagsType.kUnreadOnly;
  const mailbox = IMAPPump.daemon.getMailbox(name);
  mailbox.uidvalidity = 7202;
  Assert.equal(info.imapUidValidity, 7101);
  Assert.equal(mailbox.uidvalidity, 7202);
  Assert.equal(info.numMessages, 0);
  return { folder, db, info, mailbox };
}

/**
 * Publishes a fixture record with a fresh physical key.
 *
 * @param {nsIMsgFolder} folder - The record's folder.
 * @param {string} messageId - The literal Message-ID.
 * @param {number} [uid] - The old server UID; omitted for a local-only record.
 * @param {boolean} [pseudo=false] - Whether the record is unconfirmed.
 * @returns {nsIMsgDBHdr} The live fixture header.
 */
function addResetHeader(folder, messageId, uid, pseudo = false) {
  const db = folder.msgDatabase;
  const draft = db.createNewHdr();
  draft.messageId = messageId;
  draft.subject = "Epoch reset fixture";
  draft.author = "sender@example.invalid";
  draft.recipients = "recipient@example.invalid";
  draft.date = 1761955200000000;
  if (uid !== undefined) {
    draft.setUint32Property("uidOnServer", uid);
  }
  if (pseudo) {
    draft.setUint32Property("pseudoHdr", 1);
  }
  return db.attachHdr(draft, true);
}

/**
 * Checks physical, persisted pending and displayed counts for the unread records.
 *
 * @param {nsIMsgFolder} folder - The reset fixture folder.
 * @param {number} physical - The number of live unread records.
 * @param {number} [totalPending=0] - The persisted pending total delta.
 * @param {number} [unreadPending=0] - The persisted pending unread delta.
 */
function assertResetCounts(
  folder,
  physical,
  totalPending = 0,
  unreadPending = 0
) {
  const info = folder.msgDatabase.dBFolderInfo;
  Assert.equal(info.numMessages, physical, "Physical membership count");
  Assert.equal(info.numUnreadMessages, physical, "Physical unread count");
  Assert.equal(
    info.imapTotalPendingMessages,
    totalPending,
    "Persisted total delta"
  );
  Assert.equal(
    info.imapUnreadPendingMessages,
    unreadPending,
    "Persisted unread delta"
  );
  Assert.equal(
    folder.numPendingTotalMessages,
    totalPending,
    "Public total delta"
  );
  Assert.equal(folder.numPendingUnread, unreadPending, "Public unread delta");
  Assert.equal(
    folder.getTotalMessages(false),
    physical + totalPending,
    "Displayed total"
  );
  Assert.equal(
    folder.getNumUnread(false),
    physical + unreadPending,
    "Displayed unread"
  );
}

/**
 * Closes and reopens the fixture database through the production database service.
 *
 * @param {nsIMsgFolder} folder - The reset fixture folder.
 * @returns {nsIMsgDatabase} A new database facade for the same physical folder.
 */
function reopenResetFolder(folder) {
  const previous = folder.msgDatabase;
  core.QueryInterface(Ci.nsIMsgDBService).forceFolderDBClosed(folder);
  const reopened = folder.msgDatabase;
  Assert.notStrictEqual(
    reopened,
    previous,
    "The database was actually reopened"
  );
  Assert.equal(reopened.folder, folder);
  return reopened;
}

/**
 * Waits for ordinary production synchronization without resetting client state.
 *
 * @param {nsIMsgFolder} folder - The folder to synchronize.
 * @returns {Promise<void>} Resolves after a successful synchronization URL.
 */
async function updateResetFolder(folder) {
  let completions = 0;
  const listener = new PromiseTestUtils.PromiseUrlListener({
    OnStopRunningUrl() {
      completions++;
    },
  });
  folder.updateFolderWithListener(null, listener);
  await listener.promise;
  Assert.equal(completions, 1, "Synchronization finishes once");
}

/**
 * Checks the raw failure reported by the production synchronization URL.
 *
 * @param {nsIMsgFolder} folder - The folder to synchronize.
 * @param {number} expected - The expected nsresult.
 * @param {boolean} [direct=false] - Bypass playback and issue the sync URL directly.
 * @returns {Promise<void>} Resolves after checking the failed URL.
 */
async function expectResetFailure(folder, expected, direct = false) {
  let exitCode;
  let completions = 0;
  const listener = new PromiseTestUtils.PromiseUrlListener({
    OnStopRunningUrl(_url, status) {
      completions++;
      exitCode = status;
    },
  });
  if (direct) {
    MailServices.imap.selectFolder(folder, listener, null);
  } else {
    folder.updateFolderWithListener(null, listener);
  }
  await Assert.rejects(
    listener.promise,
    error => error.message == String(expected)
  );
  Assert.equal(
    exitCode,
    expected,
    "The original storage or mapping error reaches the caller"
  );
  Assert.equal(completions, 1, "Failed synchronization finishes once");
}
