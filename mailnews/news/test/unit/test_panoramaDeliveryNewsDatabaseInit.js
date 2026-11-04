/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server_setup.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

const { NntpNewsGroup } = ChromeUtils.importESModule(
  "resource:///modules/NntpNewsGroup.sys.mjs"
);

let fixtureNumber = 0;

/**
 * Open the real native service facade without enrolling the news folder.
 *
 * @returns {Promise<{core: nsIDatabaseCore, folder: nsIMsgNewsFolder,
 *   shared: nsIMsgDatabase, service: nsIMsgDBService, rootId: number,
 *   groupId: number}>} The account and facade retained until registered cleanup.
 */
async function createInitializationFixture() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  const core = PanoramaDelivery.assertBackend(lane.backend).QueryInterface(
    Ci.nsIDatabaseCore
  );
  const account = MailServices.accounts.createAccount();
  let incomingServer = null;
  let seededServerBranch = null;
  registerCleanupFunction(() => {
    try {
      incomingServer?.closeCachedConnections();
      MailServices.accounts.removeAccount(account, false);
    } finally {
      if (seededServerBranch) {
        Services.prefs.deleteBranch(seededServerBranch);
      }
    }
  });
  const key = `panoramaNewsDatabaseInit${++fixtureNumber}`;
  const branch = `mail.server.${key}.`;
  Assert.equal(Services.prefs.getChildList(branch).length, 0);
  seededServerBranch = branch;
  Services.prefs.setCharPref(`${branch}type`, "nntp");
  Services.prefs.setCharPref(
    `${branch}hostname`,
    `news-database-init${fixtureNumber}.invalid`
  );
  Services.prefs.setBoolPref(`${branch}valid`, false);
  const rootId = core.folderDB.insertRoot(key);
  const groupId = core.folderDB.insertFolder(rootId, "test.database-init");
  core.folderDB.updateFlags(groupId, Ci.nsMsgFolderFlags.Newsgroup);
  incomingServer = MailServices.accounts.getIncomingServer(key);
  account.incomingServer = incomingServer;
  incomingServer.QueryInterface(Ci.nsINntpIncomingServer);
  Assert.ok(incomingServer.localPath.exists(), "The real news directory exists");
  await IOUtils.writeUTF8(incomingServer.newsrcFilePath.path, "");
  const rootFolder = incomingServer.rootFolder;
  incomingServer.valid = true;
  PanoramaDelivery._assertStore(rootFolder, lane);
  const folder = rootFolder.getChildNamed("test.database-init");
  Assert.ok(folder instanceof Ci.nsIMsgNewsFolder);
  Assert.ok(!folder.databaseOpen, "Setup does not open the group database");
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  const shared = service.openFolderDB(folder, false);
  Assert.ok(!folder.databaseOpen, "The service reference is separate");
  Assert.ok(shared.QueryInterface(Ci.nsINewsDatabase), "Real news QI succeeds");
  return { core, folder, shared, service, rootId, groupId };
}

/**
 * Add real listeners so a failed folder enrollment is observable.
 *
 * @param {nsIMsgNewsFolder} folder - The actual news folder.
 * @param {nsIMsgDatabase} shared - Its separately held service facade.
 * @returns {{foreign: number, folder: number, notify: Function}} Notification
 *   counters and a synchronous real DB notification producer.
 */
function observeEnrollment(folder, shared) {
  const counts = { foreign: 0, folder: 0, notify: null };
  const foreignListener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged() {
      counts.foreign++;
    },
  };
  const folderListener = {
    QueryInterface: ChromeUtils.generateQI(["nsIFolderListener"]),
    onFolderPropertyFlagChanged() {
      counts.folder++;
    },
  };
  folder.AddFolderListener(folderListener);
  shared.addListener(foreignListener);
  registerCleanupFunction(() => {
    shared.removeListener(foreignListener);
    folder.RemoveFolderListener(folderListener);
  });
  counts.notify = () => {
    const hdr = shared.createNewHdr();
    shared.notifyHdrChangeAll(hdr, 0, Ci.nsMsgMessageFlags.Marked, null);
    return hdr;
  };
  return counts;
}

/**
 * Require both actual public accessors to retain their original native error.
 *
 * @param {nsIMsgNewsFolder} folder - The actual news folder.
 * @param {number} result - Expected synchronous nsresult.
 */
function assertAccessError(folder, result) {
  const output = {};
  Assert.throws(
    () => folder.getDBFolderInfoAndDB(output),
    error => error.result == result,
    "Folder-info access preserves the primary error"
  );
  Assert.ok(!output.value, "No folder info is published on failure");
  Assert.throws(
    () => folder.msgDatabase,
    error => error.result == result,
    "The database getter preserves the same error"
  );
}

/**
 * Corrupt only the saved pending-count value around a synchronous assertion.
 *
 * @param {nsIDatabaseCore} core - The existing automation connection owner.
 * @param {nsIMsgNewsFolder} folder - The one physical folder under test.
 * @param {Function} check - Synchronous assertions while the value is invalid.
 */
function withInvalidPendingCount(core, folder, check) {
  const connection = core.connectionForTests;
  const read = connection.createStatement(
    "SELECT value, typeof(value) AS type FROM folder_properties " +
      "WHERE id = :id AND name = 'totPendingMsgs'"
  );
  let original;
  try {
    read.params.id = folder.id;
    Assert.ok(read.executeStep(), "The genuine setter created the value");
    Assert.equal(read.row.type, "integer");
    original = read.row.value;
    Assert.ok(!read.executeStep(), "Exactly one property is targeted");
  } finally {
    read.finalize();
  }
  const write = connection.createStatement(
    "UPDATE folder_properties SET value = :value " +
      "WHERE id = :id AND name = 'totPendingMsgs'"
  );
  try {
    write.params.id = folder.id;
    write.params.value = -1;
    write.execute();
    write.reset();
    check();
  } finally {
    try {
      write.params.id = folder.id;
      write.params.value = original;
      write.execute();
    } finally {
      write.finalize();
    }
  }
}

add_task(async function test_retriesRejectedNewsDatabase() {
  const { core, folder, shared, rootId, groupId } =
    await createInitializationFixture();
  const count = shared.dBFolderInfo.numMessages;
  const counts = observeEnrollment(folder, shared);
  const connection = core.connectionForTests;
  connection.beginTransaction();
  try {
    for (const attempt of [1, 2]) {
      info(`Reject real initialization attempt ${attempt}`);
      assertAccessError(folder, Cr.NS_ERROR_IN_PROGRESS);
      Assert.ok(connection.transactionInProgress, "The caller still owns its TX");
      Assert.ok(!folder.databaseOpen, "No failed attempt publishes a cached DB");
    }
  } finally {
    connection.rollbackTransaction();
  }
  Assert.equal(folder.id, groupId, "Failure preserves the group identity");
  Assert.equal(
    core.folderDB.getFolderChildNamed(rootId, "test.database-init"),
    groupId,
    "Failure preserves the stored group"
  );
  Assert.equal(shared.dBFolderInfo.numMessages, count, "The held DB survives");
  const hdr = counts.notify();
  Assert.equal(counts.foreign, 1, "The foreign listener remains attached");
  Assert.equal(counts.folder, 0, "The failed folder is not a DB listener");
  Assert.ok(!folder.databaseOpen, "Notification does not revive the failed DB");
  folder.NotifyPropertyFlagChanged(hdr, "Flagged", 0, Ci.nsMsgMessageFlags.Marked);
  Assert.equal(counts.folder, 1, "The folder observer sees direct events");
  Assert.equal(folder.msgDatabase, shared, "Rollback permits a genuine retry");
  counts.notify();
  Assert.equal(counts.foreign, 2);
  Assert.equal(counts.folder, 2, "A successful retry enrolls exactly once");
});

add_task(async function test_summaryFailureUnwindsOwnedNewsBinding() {
  const { core, folder, shared } = await createInitializationFixture();
  shared.dBFolderInfo.imapTotalPendingMessages = 7;
  const counts = observeEnrollment(folder, shared);
  withInvalidPendingCount(core, folder, () => {
    assertAccessError(folder, Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA);
    Assert.ok(!folder.databaseOpen, "Late summary failure clears the attempt");
    counts.notify();
    Assert.equal(counts.foreign, 1);
    Assert.equal(counts.folder, 0, "The failed attempt removed its listener");
  });
  // Read-set checkpoint publication preceded the summary read. It is retained.
  Assert.equal(shared.dBFolderInfo.getCharProperty("readSet"), "");
  Assert.equal(folder.msgDatabase, shared);
  Assert.equal(folder.getTotalMessages(false), 7);
  counts.notify();
  Assert.equal(counts.foreign, 2);
  Assert.equal(counts.folder, 1);
});

add_task(async function test_closedSameDatabaseCannotBeReused() {
  const { folder, shared } = await createInitializationFixture();
  let reached = false;
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onAnnouncerGoingAway() {
      reached = true;
      Assert.ok(shared.QueryInterface(Ci.nsINewsDatabase), "QI survives close");
      Assert.throws(
        () => (folder.msgDatabase = shared),
        error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
        "Same-object replacement must validate the closed facade"
      );
      assertAccessError(folder, Cr.NS_ERROR_NOT_AVAILABLE);
    },
    onHdrFlagsChanged() {},
    onHdrAdded() {},
    onHdrDeleted() {},
    onParentChanged() {},
    onReadChanged() {},
    onJunkScoreChanged() {},
    onHdrPropertyChanged() {},
    onEvent() {},
  };
  shared.addListener(listener);
  registerCleanupFunction(() => shared.removeListener(listener));
  Assert.equal(folder.msgDatabase, shared);
  const before = folder.newsrcLine;
  shared.forceClosed();
  Assert.ok(reached, "The actual closed-facade callback was reached");
  Assert.equal(folder.newsrcLine, before, "The owning read set survives close");
  Assert.ok(!folder.databaseOpen);
  const reopened = folder.msgDatabase;
  Assert.notEqual(reopened, shared, "The service supplies a fresh facade");
  folder.setReadSetFromStr("6-7");
  Assert.equal(reopened.dBFolderInfo.getCharProperty("readSet"), "6-7");
});

add_task(async function test_reentrantReplacementKeepsNewBinding() {
  const { folder, shared } = await createInitializationFixture();
  shared.dBFolderInfo.imapTotalPendingMessages = 9;
  let reached = false;
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIFolderListener"]),
    onFolderIntPropertyChanged(changed, property) {
      if (changed != folder || property != "TotalMessages" || reached) {
        return;
      }
      reached = true;
      folder.msgDatabase = shared;
      folder.setReadSetFromStr("12-14");
      Assert.equal(folder.msgDatabase, shared, "Nested initialization completed");
    },
  };
  folder.AddFolderListener(listener);
  registerCleanupFunction(() => folder.RemoveFolderListener(listener));
  Assert.throws(
    () => folder.msgDatabase,
    error => error.result == Cr.NS_ERROR_IN_PROGRESS,
    "The older attempt reports replacement rather than publishing its result"
  );
  Assert.ok(reached, "The real summary notification reentered initialization");
  Assert.ok(folder.databaseOpen, "Older cleanup preserves the nested cache");
  Assert.equal(folder.msgDatabase, shared);
  Assert.equal(shared.dBFolderInfo.getCharProperty("readSet"), "12-14");
  Assert.equal(folder.newsrcLine.trim(), "test.database-init: 12-14");
  Assert.equal(folder.getTotalMessages(false), 9);
  const counts = observeEnrollment(folder, shared);
  counts.notify();
  Assert.equal(counts.foreign, 1);
  Assert.equal(counts.folder, 1, "The retained folder is enrolled exactly once");
});

add_task(async function test_summaryValidityPreservesNativeErrorsAndReopen() {
  const fixture = await createInitializationFixture();
  const { core, folder, service } = fixture;
  let shared = fixture.shared;
  Assert.ok(shared.summaryValid, "Absent native summary validity defaults true");
  shared.summaryValid = false;
  Assert.equal(folder.msgDatabase, shared);
  folder.msgDatabase = null;
  shared.close(false);
  Assert.equal(service.openFolderDB(folder, false).summaryValid, false);
  Assert.equal(folder.msgDatabase.summaryValid, false, "Close does not reset it");
  shared.summaryValid = true;
  folder.msgDatabase = null;
  shared.close(false);
  Assert.equal(folder.msgDatabase.summaryValid, true);
  folder.setReadSetFromStr("0,2-4");
  const reader = new NntpNewsGroup(
    folder.server.QueryInterface(Ci.nsINntpIncomingServer),
    folder
  );
  reader.getArticlesRangeToFetch(null, 0, 0);
  reader.processXOverLine(
    "0\tCheckpoint\tReader <reader@example.invalid>\tThu, 01 Oct 2026 12:00:00 +0000\t<init-zero@example.invalid>\t\t20\t1"
  );
  reader.finishProcessingXOver();
  reader.cleanUp();
  const header = shared.getMsgHdrForMessageID("init-zero@example.invalid");
  Assert.ok(header.isRead, "Real article zero is initially in the owning set");
  const physicalKey = header.messageKey;
  const before = folder.newsrcLine;
  const old = shared;
  // Real nonrecursive shutdown drops the owner but retains the physical group.
  folder.shutdown(false);
  Assert.ok(!folder.databaseOpen);
  shared = folder.msgDatabase;
  Assert.notEqual(shared, old);
  Assert.equal(folder.newsrcLine, before, "Cold ownership restores its checkpoint");
  const restored = shared.getMsgHdrForMessageID("init-zero@example.invalid");
  Assert.equal(restored.messageKey, physicalKey, "Cold reopen keeps physical identity");
  Assert.ok(restored.isRead, "The exact zero companion survives cold ownership");
  Assert.ok(shared.summaryValid, "Summary validity survives the cold reopen");
  shared.dBFolderInfo.imapTotalPendingMessages = 3;
  folder.msgDatabase = null;
  withInvalidPendingCount(core, folder, () => {
    assertAccessError(folder, Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA);
    Assert.ok(!folder.databaseOpen);
    Assert.ok(shared.summaryValid, "A failed count read does not reset validity");
  });
  Assert.equal(folder.msgDatabase, shared);
  shared.forceClosed();
  Assert.throws(
    () => shared.summaryValid,
    error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
    "A closed summary read preserves its error rather than returning a default"
  );
  const reopened = folder.msgDatabase;
  Assert.notEqual(reopened, shared);
  Assert.ok(reopened.summaryValid, "Validity persists on the fresh facade");
});
