/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server_setup.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

add_task(async function test_retriesRejectedNewsDatabase() {
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
  const key = "panoramaNewsDatabaseInit";
  const branch = `mail.server.${key}.`;
  Assert.equal(Services.prefs.getChildList(branch).length, 0);
  seededServerBranch = branch;
  Services.prefs.setCharPref(`${branch}type`, "nntp");
  Services.prefs.setCharPref(`${branch}hostname`, "news-database-init.invalid");
  Services.prefs.setBoolPref(`${branch}valid`, false);
  const rootId = core.folderDB.insertRoot(key);
  const groupId = core.folderDB.insertFolder(rootId, "test.database-init");
  core.folderDB.updateFlags(groupId, Ci.nsMsgFolderFlags.Newsgroup);
  info('DELIVERY_PHASE {"phase":"news-database-init-factory"}');
  incomingServer = MailServices.accounts.getIncomingServer(key);
  account.incomingServer = incomingServer;
  incomingServer.QueryInterface(Ci.nsINntpIncomingServer);
  const localPath = incomingServer.localPath;
  Assert.ok(localPath.exists(), "The real news directory exists");
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
  // This is the real unsupported Panorama interface, not a news adapter.
  Assert.throws(
    () => shared.QueryInterface(Ci.nsINewsDatabase),
    error => error.result == Cr.NS_NOINTERFACE,
    "The held database supplies the concrete QI failure"
  );
  const count = shared.dBFolderInfo.numMessages;
  let foreignNotifications = 0;
  const foreignListener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged() {
      foreignNotifications++;
    },
  };
  let folderNotifications = 0;
  const folderListener = {
    QueryInterface: ChromeUtils.generateQI(["nsIFolderListener"]),
    onFolderPropertyFlagChanged() {
      folderNotifications++;
    },
  };
  folder.AddFolderListener(folderListener);
  shared.addListener(foreignListener);
  try {
    info('DELIVERY_PHASE {"phase":"news-database-init-qi-failure"}');
    for (const attempt of [1, 2]) {
      Assert.throws(
        () => folder.getDBFolderInfoAndDB({}),
        error => error.result == Cr.NS_NOINTERFACE,
        `Lookup ${attempt} reports the original unsupported interface`
      );
    }
    Assert.ok(!folder.databaseOpen, "Neither failure publishes a cached DB");
    Assert.equal(folder.id, groupId, "Failure preserves the group identity");
    Assert.equal(
      core.folderDB.getFolderChildNamed(rootId, "test.database-init"),
      groupId,
      "Failure preserves the stored group"
    );
    Assert.equal(
      shared.dBFolderInfo.numMessages,
      count,
      "The held DB survives"
    );
    const hdr = shared.createNewHdr();
    shared.notifyHdrChangeAll(hdr, 0, Ci.nsMsgMessageFlags.Marked, null);
    Assert.equal(
      foreignNotifications,
      1,
      "The foreign listener remains attached"
    );
    Assert.equal(
      folderNotifications,
      0,
      "The failed folder is not a DB listener"
    );
    Assert.ok(
      !folder.databaseOpen,
      "Notification does not revive the failed DB"
    );
    folder.NotifyPropertyFlagChanged(
      hdr,
      "Flagged",
      0,
      Ci.nsMsgMessageFlags.Marked
    );
    Assert.equal(
      folderNotifications,
      1,
      "The folder observer sees direct events"
    );
  } finally {
    shared.removeListener(foreignListener);
    folder.RemoveFolderListener(folderListener);
  }
});
