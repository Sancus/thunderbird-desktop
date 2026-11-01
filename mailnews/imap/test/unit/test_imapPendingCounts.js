/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_server.js */

"use strict";

const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const { IMAPServer } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/IMAPServer.sys.mjs"
);

let server, incomingServer;

add_setup(async function () {
  const store = Services.prefs.getCharPref("mail.serverDefaultStoreContractID");
  Services.prefs.setCharPref("mail.server.default.storeContractID", store);
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
  server = new IMAPServer();
  registerCleanupFunction(async () => {
    if (incomingServer) {
      incomingServer.closeCachedConnections();
      await waitForConnectionsToClose();
    }
    await server.server.stop();
  });
  const account = MailServices.accounts.createAccount();
  account.addIdentity(MailServices.accounts.createIdentity());
  incomingServer = MailServices.accounts.createIncomingServer(
    "user",
    "localhost",
    "imap"
  );
  incomingServer.password = "password";
  incomingServer.port = server.port;
  incomingServer.QueryInterface(Ci.nsIImapIncomingServer).useIdle = false;
  account.incomingServer = incomingServer;
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.equal(
    "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
    Services.prefs.getBoolPref("mail.panorama.enabled")
  );
  const listener = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(
    incomingServer.rootFolder,
    listener,
    null
  );
  await listener.promise;
  const inbox = incomingServer.rootFolder.getChildNamed("INBOX");
  const expectedStore = {
    "@mozilla.org/msgstore/berkeleystore;1": "mbox",
    "@mozilla.org/msgstore/maildirstore;1": "maildir",
  }[store];
  Assert.ok(expectedStore);
  Assert.ok(inbox instanceof Ci.nsIMsgImapMailFolder);
  Assert.equal(incomingServer.msgStore.storeType, expectedStore);
  Assert.equal(inbox.msgStore.storeType, expectedStore);
});

async function updateFolder(folder) {
  const listener = new PromiseTestUtils.PromiseUrlListener();
  folder.updateFolderWithListener(null, listener);
  await listener.promise;
}

async function waitForConnectionsToClose() {
  await TestUtils.waitForCondition(
    () => !server.daemon.getConnections().length,
    "all cached IMAP connections should close"
  );
}

function makeMailboxSpec(values) {
  return {
    QueryInterface: ChromeUtils.generateQI(["nsIMailboxSpec"]),
    numMessages: values.numMessages,
    numUnseenMessages: values.numUnseenMessages,
    numRecentMessages: 0,
    nextUID: values.nextUID,
    folderSelected: true,
  };
}

async function makeCountFolder(name) {
  server.daemon.createMailbox(name, {
    subscribed: true,
    uidvalidity: server.daemon.uidvalidity++,
  });
  const listener = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(
    incomingServer.rootFolder,
    listener,
    null
  );
  await listener.promise;
  const folder = incomingServer.rootFolder
    .getChildNamed(name)
    .QueryInterface(Ci.nsIMsgImapMailFolder);
  await updateFolder(folder);
  incomingServer.closeCachedConnections();
  await waitForConnectionsToClose();
  Assert.equal(folder.getTotalMessages(false), 0);
  Assert.equal(folder.getNumUnread(false), 0);
  return folder;
}

function recordCountChanges(folder) {
  const changes = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIFolderListener"]),
    onFolderIntPropertyChanged(changed, property, oldValue, newValue) {
      if (
        changed == folder &&
        ["TotalMessages", "TotalUnreadMessages"].includes(property)
      ) {
        changes.push([property, oldValue, newValue]);
      }
    },
  };
  MailServices.mailSession.AddFolderListener(
    listener,
    Ci.nsIFolderListener.intPropertyChanged
  );
  registerCleanupFunction(() =>
    MailServices.mailSession.RemoveFolderListener(listener)
  );
  return changes;
}

add_task(async function testImapPendingWrappers() {
  const folder = await makeCountFolder("pending-wrapper");
  const changes = recordCountChanges(folder);
  folder.changePendingTotal(1);
  folder.changePendingUnread(1);
  Assert.equal(folder.numPendingTotalMessages, 1);
  Assert.equal(folder.numPendingUnread, 1);
  Assert.equal(folder.getTotalMessages(false), 1);
  Assert.equal(folder.getNumUnread(false), 1);
  Assert.deepEqual(changes, [
    ["TotalMessages", 0, 1],
    ["TotalUnreadMessages", 0, 1],
  ]);
});

if (Services.prefs.getBoolPref("mail.panorama.enabled")) {
  add_task(async function test_syncCountsPreservesNewBiffAndPendingState() {
    const folder = await makeCountFolder("sync-new-biff-counts");
    const generator = new MessageGenerator();
    await server.addMessages(
      "sync-new-biff-counts",
      generator.makeMessages({ count: 3 }),
      false
    );
    const messages = server.getMessagesInFolder(folder);
    messages[0].setFlag("\\Seen");
    folder.performingBiff = true;
    try {
      await updateFolder(folder);
      const database = folder.msgDatabase;
      const headers = [...folder.messages];
      const unreadKeys = headers
        .filter(header => !header.isRead)
        .map(header => header.messageKey)
        .sort((a, b) => a - b);
      Assert.equal(headers.length, 3, "real protocol headers were published");
      Assert.equal(unreadKeys.length, 2);
      Assert.equal(folder.getTotalMessages(false), 3);
      Assert.equal(folder.getNumUnread(false), 2);
      Assert.equal(folder.getNumNewMessages(false), 2);
      Assert.deepEqual(
        database.getNewList().sort((a, b) => a - b),
        unreadKeys
      );
      Assert.equal(folder.biffState, Ci.nsIMsgFolder.nsMsgBiffState_NewMail);

      folder.changePendingTotal(2);
      folder.changePendingUnread(1);
      database.syncCounts();
      folder.updateSummaryTotals(true);
      Assert.equal(folder.getTotalMessages(false), 5);
      Assert.equal(folder.getNumUnread(false), 3);
      Assert.equal(folder.getNumNewMessages(false), 2);
      Assert.deepEqual(
        database.getNewList().sort((a, b) => a - b),
        unreadKeys
      );
      Assert.equal(database.dBFolderInfo.imapTotalPendingMessages, 2);
      Assert.equal(database.dBFolderInfo.imapUnreadPendingMessages, 1);

      folder.clearNewMessages();
      Assert.equal(folder.getNumNewMessages(false), 0);
      Assert.deepEqual(database.getNewList(), []);
      Assert.equal(
        folder.getNumUnread(false),
        3,
        "clearing new is not marking read"
      );
      incomingServer.biffState = Ci.nsIMsgFolder.nsMsgBiffState_NoMail;
      Cc["@mozilla.org/msgDatabase/msgDBService;1"]
        .getService(Ci.nsIMsgDBService)
        .forceFolderDBClosed(folder);
      const reopened = folder.msgDatabase;
      Assert.notStrictEqual(reopened, database);
      reopened.syncCounts();
      folder.updateSummaryTotals(true);
      Assert.equal(reopened.dBFolderInfo.numMessages, 3);
      Assert.equal(reopened.dBFolderInfo.numUnreadMessages, 2);
      Assert.equal(folder.numPendingTotalMessages, 2);
      Assert.equal(folder.numPendingUnread, 1);
      Assert.equal(folder.getTotalMessages(false), 5);
      Assert.equal(folder.getNumUnread(false), 3);
      Assert.equal(folder.getNumNewMessages(false), 0);
      Assert.deepEqual(reopened.getNewList(), []);
      Assert.equal(folder.biffState, Ci.nsIMsgFolder.nsMsgBiffState_NoMail);
    } finally {
      folder.performingBiff = false;
      incomingServer.performingBiff = false;
      incomingServer.biffState = Ci.nsIMsgFolder.nsMsgBiffState_NoMail;
      incomingServer.closeCachedConnections();
      await waitForConnectionsToClose();
    }
  });

  add_task(async function testSelectKeepsAbsentAndZeroPendingCounts() {
    const folder = await makeCountFolder("select-zero-pending");
    const info = folder.msgDatabase.dBFolderInfo;
    const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"]
      .getService(Ci.nsIMsgDBService)
      .QueryInterface(Ci.nsIDatabaseCore);
    const connection = core.connectionForTests;
    const statement = connection.createStatement(
      "SELECT count(*) FROM folder_properties " +
        `WHERE id = ${folder.id} AND name IN ('totPendingMsgs', 'unreadPendingMsgs')`
    );
    try {
      Assert.ok(statement.executeStep());
      Assert.equal(statement.getInt32(0), 0, "SELECT preserves absent deltas");
    } finally {
      statement.finalize();
    }
    info.imapTotalPendingMessages = 0;
    info.imapUnreadPendingMessages = 0;
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER reject_zero_pending BEFORE INSERT ON folder_properties " +
        `WHEN NEW.id = ${folder.id} AND NEW.name IN ('totPendingMsgs', 'unreadPendingMsgs') ` +
        "BEGIN SELECT RAISE(ABORT, 'zero pending write'); END"
    );
    try {
      await updateFolder(folder);
      Assert.equal(info.imapTotalPendingMessages, 0);
      Assert.equal(info.imapUnreadPendingMessages, 0);
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER reject_zero_pending");
    }
  });

  add_task(async function testImapPendingWriteFailure() {
    const folder = await makeCountFolder("pending-write-failure");
    const info = folder.msgDatabase.dBFolderInfo;
    const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"]
      .getService(Ci.nsIMsgDBService)
      .QueryInterface(Ci.nsIDatabaseCore);
    const connection = core.connectionForTests;
    const changes = recordCountChanges(folder);
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER reject_imap_pending BEFORE INSERT ON folder_properties " +
        `WHEN NEW.id = ${folder.id} AND NEW.name IN ('totPendingMsgs', 'unreadPendingMsgs') ` +
        "BEGIN SELECT RAISE(ABORT, 'IMAP pending fault'); END"
    );
    try {
      Assert.throws(
        () => folder.changePendingTotal(1),
        error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
      );
      Assert.throws(
        () => folder.changePendingUnread(1),
        error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
      );
      Assert.equal(info.imapTotalPendingMessages, 0);
      Assert.equal(info.imapUnreadPendingMessages, 0);
      Assert.equal(folder.numPendingTotalMessages, 0);
      Assert.equal(folder.numPendingUnread, 0);
      Assert.deepEqual(changes, []);
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER reject_imap_pending");
    }
    folder.changePendingTotal(1);
    folder.changePendingUnread(1);
    Assert.equal(folder.getTotalMessages(false), 1);
    Assert.equal(folder.getNumUnread(false), 1);
  });

  add_task(async function testStatusPendingWriteFailure() {
    const folder = await makeCountFolder("status-write-failure");
    const info = folder.msgDatabase.dBFolderInfo;
    const sink = folder.QueryInterface(Ci.nsIImapMailFolderSink);
    const nextUID = folder.serverNextUID;
    const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"]
      .getService(Ci.nsIMsgDBService)
      .QueryInterface(Ci.nsIDatabaseCore);
    const connection = core.connectionForTests;
    const changes = recordCountChanges(folder);
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER reject_status_pending BEFORE INSERT ON folder_properties " +
        `WHEN NEW.id = ${folder.id} AND NEW.name = 'unreadPendingMsgs' ` +
        "BEGIN SELECT RAISE(ABORT, 'STATUS pending fault'); END"
    );
    try {
      Assert.throws(
        () =>
          sink.UpdateImapMailboxStatus(
            null,
            makeMailboxSpec({
              numMessages: 1,
              numUnseenMessages: 1,
              nextUID: 2,
            })
          ),
        error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
      );
      Assert.equal(info.imapUnreadPendingMessages, 0);
      Assert.equal(folder.serverNextUID, nextUID);
      Assert.equal(folder.serverUnseen, 0);
      Assert.equal(folder.getNumNewMessages(false), 0);
      Assert.deepEqual(changes, []);
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER reject_status_pending");
    }
    sink.UpdateImapMailboxStatus(
      null,
      makeMailboxSpec({ numMessages: 1, numUnseenMessages: 1, nextUID: 2 })
    );
    Assert.equal(folder.getNumUnread(false), 1);
    Assert.equal(info.imapUnreadPendingMessages, 1);
    Assert.equal(folder.serverNextUID, 2);
    Assert.equal(folder.serverUnseen, 1);
  });

  add_task(async function testSelectResetsSignedMinimumPendingCounts() {
    const folder = await makeCountFolder("select-pending-minimum");
    const info = folder.msgDatabase.dBFolderInfo;
    info.imapTotalPendingMessages = -2147483648;
    info.imapUnreadPendingMessages = -2147483648;
    Assert.equal(folder.numPendingTotalMessages, -2147483648);
    Assert.equal(folder.numPendingUnread, -2147483648);
    const changes = recordCountChanges(folder);
    await updateFolder(folder);
    Assert.equal(info.imapTotalPendingMessages, 0);
    Assert.equal(info.imapUnreadPendingMessages, 0);
    Assert.equal(folder.getTotalMessages(false), 0);
    Assert.equal(folder.getNumUnread(false), 0);
    Assert.deepEqual(changes, [
      ["TotalMessages", -2147483648, 0],
      ["TotalUnreadMessages", -2147483648, 0],
    ]);
  });

  add_task(async function testDeleteAllResetsSignedMinimumPendingCounts() {
    const folder = await makeCountFolder("delete-all-pending-minimum");
    const mailbox = server.daemon.getMailbox("delete-all-pending-minimum");
    const text =
      "From: sender@example.invalid\r\n" +
      "Message-ID: <pending-delete@example.invalid>\r\n" +
      "Subject: Disposable count reset fixture\r\n\r\n" +
      "Pending-count delete body.\r\n";
    const uid = mailbox.uidnext++;
    mailbox.addMessage(
      new ImapMessage("data:text/plain;base64," + btoa(text), uid, [])
    );
    const selected = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.liteSelectFolder(folder, selected, null);
    await selected.promise;
    Assert.deepEqual(
      mailbox._messages.map(message => message.uid),
      [uid]
    );
    Assert.equal(mailbox._messages[0].getText(), text);
    const transactions = () => [server.server.playTransaction()].flat();
    const commands = () =>
      transactions().flatMap(transaction => transaction.them);
    const before = commands().length;
    const info = folder.msgDatabase.dBFolderInfo;
    info.imapTotalPendingMessages = -2147483648;
    info.imapUnreadPendingMessages = -2147483648;
    Assert.equal(folder.numPendingTotalMessages, -2147483648);
    Assert.equal(folder.numPendingUnread, -2147483648);
    const listener = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.deleteAllMessages(folder, listener);
    await listener.promise;
    const sent = commands().slice(before);
    Assert.ok(sent.some(command => /STORE.*Deleted/i.test(command)));
    Assert.ok(!sent.some(command => /\bSELECT\b/i.test(command)));
    Assert.deepEqual(
      mailbox._messages.map(message => message.uid),
      []
    );
    Assert.equal(info.imapTotalPendingMessages, 0);
    Assert.equal(info.imapUnreadPendingMessages, 0);
    Assert.equal(folder.getTotalMessages(false), 0);
    Assert.equal(folder.getNumUnread(false), 0);
  });

  add_task(async function testDeleteAllPendingResetWriteFailure() {
    const folder = await makeCountFolder("delete-all-pending-write-failure");
    const info = folder.msgDatabase.dBFolderInfo;
    info.imapTotalPendingMessages = 1;
    info.imapUnreadPendingMessages = 1;
    Assert.equal(folder.numPendingTotalMessages, 1);
    Assert.equal(folder.numPendingUnread, 1);
    const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"]
      .getService(Ci.nsIMsgDBService)
      .QueryInterface(Ci.nsIDatabaseCore);
    const connection = core.connectionForTests;
    const changes = recordCountChanges(folder);
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER reject_delete_pending BEFORE INSERT ON folder_properties " +
        `WHEN NEW.id = ${folder.id} AND NEW.name = 'totPendingMsgs' ` +
        "BEGIN SELECT RAISE(ABORT, 'delete pending fault'); END"
    );
    let status;
    const listener = new PromiseTestUtils.PromiseUrlListener({
      OnStopRunningUrl(url, result) {
        status = result;
      },
    });
    try {
      const failure = (async () => {
        await Assert.rejects(
          listener.promise,
          error => error.message == String(Cr.NS_ERROR_STORAGE_CONSTRAINT)
        );
      })();
      MailServices.imap.deleteAllMessages(folder, listener);
      await failure;
      Assert.equal(status, Cr.NS_ERROR_STORAGE_CONSTRAINT);
      Assert.equal(info.imapTotalPendingMessages, 1);
      Assert.equal(info.imapUnreadPendingMessages, 1);
      Assert.deepEqual(changes, []);
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER reject_delete_pending");
    }
    const retry = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.deleteAllMessages(folder, retry);
    await retry.promise;
    Assert.equal(info.imapTotalPendingMessages, 0);
    Assert.equal(info.imapUnreadPendingMessages, 0);
    Assert.deepEqual(changes, [
      ["TotalMessages", 1, 0],
      ["TotalUnreadMessages", 1, 0],
    ]);
  });

  add_task(async function testStatusChecksPendingDeltaWidth() {
    const folder = await makeCountFolder("status-delta-width");
    const info = folder.msgDatabase.dBFolderInfo;
    info.imapUnreadPendingMessages = -2147483648;
    Assert.equal(folder.numPendingUnread, -2147483648);
    const nextUID = folder.serverNextUID;
    const changes = recordCountChanges(folder);
    Assert.throws(
      () =>
        folder.QueryInterface(Ci.nsIImapMailFolderSink).UpdateImapMailboxStatus(
          null,
          makeMailboxSpec({
            numMessages: 0,
            numUnseenMessages: 0,
            nextUID: 2,
          })
        ),
      error => error.result == Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA
    );
    Assert.equal(info.imapUnreadPendingMessages, -2147483648);
    Assert.equal(folder.serverNextUID, nextUID);
    Assert.deepEqual(changes, []);
    await updateFolder(folder);
    Assert.equal(folder.numPendingUnread, 0);
  });

  add_task(async function testStatusPropagatesCountReadFailure() {
    const folder = await makeCountFolder("status-summary-failure");
    const info = folder.msgDatabase.dBFolderInfo;
    info.setInt64Property("totPendingMsgs", 4294967296);
    const changes = recordCountChanges(folder);
    try {
      Assert.throws(
        () =>
          folder
            .QueryInterface(Ci.nsIImapMailFolderSink)
            .UpdateImapMailboxStatus(
              null,
              makeMailboxSpec({
                numMessages: 0,
                numUnseenMessages: 0,
                nextUID: 2,
              })
            ),
        error => error.result == Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA
      );
      Assert.equal(folder.getNumUnread(false), 0);
      Assert.deepEqual(changes, []);
    } finally {
      info.imapTotalPendingMessages = 0;
    }
    Assert.equal(folder.getTotalMessages(false), 0);
  });

  add_task(async function testSelectPendingResetWriteFailure() {
    const folder = await makeCountFolder("select-pending-write-failure");
    const info = folder.msgDatabase.dBFolderInfo;
    info.imapTotalPendingMessages = 1;
    info.imapUnreadPendingMessages = 1;
    Assert.equal(folder.numPendingTotalMessages, 1);
    Assert.equal(folder.numPendingUnread, 1);
    const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"]
      .getService(Ci.nsIMsgDBService)
      .QueryInterface(Ci.nsIDatabaseCore);
    const connection = core.connectionForTests;
    const changes = recordCountChanges(folder);
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER reject_select_pending BEFORE INSERT ON folder_properties " +
        `WHEN NEW.id = ${folder.id} AND NEW.name = 'totPendingMsgs' ` +
        "BEGIN SELECT RAISE(ABORT, 'SELECT pending fault'); END"
    );
    let status;
    const listener = new PromiseTestUtils.PromiseUrlListener({
      OnStopRunningUrl(url, result) {
        status = result;
      },
    });
    try {
      const failure = (async () => {
        await Assert.rejects(
          listener.promise,
          error => error.message == String(Cr.NS_ERROR_STORAGE_CONSTRAINT)
        );
      })();
      folder.updateFolderWithListener(null, listener);
      await failure;
      Assert.equal(status, Cr.NS_ERROR_STORAGE_CONSTRAINT);
      Assert.equal(info.imapTotalPendingMessages, 1);
      Assert.equal(info.imapUnreadPendingMessages, 1);
      Assert.deepEqual(changes, []);
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER reject_select_pending");
    }
    await updateFolder(folder);
    Assert.equal(folder.numPendingTotalMessages, 0);
    Assert.equal(folder.numPendingUnread, 0);
  });
}
