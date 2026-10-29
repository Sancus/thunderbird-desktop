/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

var { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { localAccountUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/LocalAccountUtils.sys.mjs"
);
var { EwsServer } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/EwsServer.sys.mjs"
);
var { RemoteFolder } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MockServer.sys.mjs"
);

var incomingServer;
var ewsServer;
var ewsIncomingServer;

add_setup(async function () {
  // Negative protocol cases check callback errors without opening GUI alerts.
  Services.prefs.setBoolPref("mail.suppressAlertsForTests", true);
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref("mail.suppressAlertsForTests")
  );

  // Ensure we have an on-disk profile.
  do_get_profile();

  // Create a new mock EWS server, and start it.
  ewsServer = new EwsServer();
  ewsServer.start();
  registerCleanupFunction(() => ewsServer.stop());

  // Create and configure the EWS incoming server.
  incomingServer = localAccountUtils.create_incoming_server(
    "ews",
    ewsServer.port,
    "user",
    "password"
  );
  incomingServer.setStringValue(
    "ews_url",
    `http://127.0.0.1:${ewsServer.port}/EWS/Exchange.asmx`
  );

  const exchangeServer = incomingServer.QueryInterface(
    Ci.IExchangeIncomingServer
  );
  registerCleanupFunction(async () => {
    incomingServer.shutdown();
    await TestUtils.waitForCondition(
      () => !exchangeServer.protocolClientRunning,
      "waiting for the EWS client to shut down"
    );
  });

  ewsIncomingServer = incomingServer.QueryInterface(Ci.IExchangeIncomingServer);
  Assert.ok(!!ewsIncomingServer, "Created server should be an EWS server.");
});

/**
 * Trigger the `deleteMessages` operation and return a promise that resolves on
 * completion.
 *
 * @param {nsIMsgFolder} folder
 * @param {[nsIMsgDBHdr]} headersToDelete
 */
async function deleteItems(folder, headersToDelete) {
  const copyListener = new PromiseTestUtils.PromiseCopyListener();
  folder.deleteMessages(
    headersToDelete,
    null,
    false,
    false,
    copyListener,
    false
  );
  return copyListener.promise;
}

add_task(async function test_syncFailureKeepsOriginalStatus() {
  const { HTTP_404 } = ChromeUtils.importESModule(
    "resource://testing-common/httpd.sys.mjs"
  );
  const hierarchy = Promise.withResolvers();
  ewsIncomingServer.syncFolderHierarchy(
    {
      QueryInterface: ChromeUtils.generateQI([
        "IExchangeSimpleOperationListener",
        "IExchangeFallibleOperationListener",
      ]),
      onOperationSuccess() {
        hierarchy.resolve();
      },
      onOperationFailure(status) {
        hierarchy.reject(status);
      },
    },
    null
  );
  await hierarchy.promise;

  const folder = incomingServer.rootFolder.getChildNamed("Inbox");
  const uri = folder.URI;
  const folderId = folder.getStringProperty("ewsId");
  Assert.ok(folderId, "The real folder hierarchy supplies the server identity");
  const originalGetChanges = ewsServer.getChangesSince;
  const attempts = [];
  ewsServer.getChangesSince = function (offset, id, maxItems) {
    if (id == folderId) {
      attempts.push(id);
      throw HTTP_404;
    }
    return originalGetChanges.call(this, offset, id, maxItems);
  };
  try {
    const stopped = Promise.withResolvers();
    const statuses = [];
    let starts = 0;
    folder.getNewMessages(null, {
      QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),
      OnStartRunningUrl() {
        starts++;
      },
      OnStopRunningUrl(url, status) {
        statuses.push(status);
        stopped.resolve(status);
      },
    });
    Assert.equal(
      await stopped.promise,
      Cr.NS_ERROR_NET_ERROR_RESPONSE,
      "A count refresh failure must not hide the original HTTP error"
    );
    await TestUtils.waitForCondition(
      () => ewsIncomingServer.protocolClientIdle,
      "Waiting for the failed synchronization to finish"
    );
    Assert.equal(starts, 1, "The synchronization starts once");
    Assert.deepEqual(statuses, [Cr.NS_ERROR_NET_ERROR_RESPONSE]);
    Assert.deepEqual(
      attempts,
      [folderId],
      "The real request reached the server"
    );
    Assert.equal(folder.URI, uri);
    Assert.equal(folder.getStringProperty("ewsId"), folderId);
  } finally {
    ewsServer.getChangesSince = originalGetChanges;
  }
});

add_task(async function test_delete_model() {
  const rootFolder = incomingServer.rootFolder;

  await syncFolder(incomingServer, rootFolder);

  const deletedItemsFolder = rootFolder.getChildNamed("Deleted Items");
  Assert.ok(!!deletedItemsFolder, "Deleted Items folder should exist.");

  const inboxFolder = rootFolder.getChildNamed("Inbox");
  Assert.ok(!!inboxFolder, "Inbox should exist.");

  // By default, the delete model should be move to trash, and the folder should
  // be the distinguished folder we got from the server.
  Assert.equal(
    ewsIncomingServer.deleteModel,
    Ci.IExchangeIncomingServer.MOVE_TO_TRASH,
    "Default delete model should be move to trash"
  );
  Assert.equal(
    ewsIncomingServer.trashFolderPath,
    "Deleted Items",
    "trash folder path should be 'Deleted Items'"
  );

  Assert.ok(
    !!(deletedItemsFolder.flags & Ci.nsMsgFolderFlags.Trash),
    "Deleted Items should have the trash flag."
  );

  // Add some items to the inbox.
  ewsServer.addItemToFolder("item1", "inbox");
  ewsServer.addItemToFolder("item2", "inbox");
  ewsServer.addItemToFolder("item3", "inbox");

  await syncFolder(incomingServer, inboxFolder);

  Assert.equal(
    inboxFolder.getTotalMessages(false),
    3,
    "Inbox should have 3 messages."
  );

  const headersToDelete1 = [[...inboxFolder.messages][0]];

  await deleteItems(inboxFolder, headersToDelete1);

  Assert.equal(
    inboxFolder.getTotalMessages(false),
    2,
    "Inbox should have 2 messages."
  );
  Assert.equal(
    deletedItemsFolder.getTotalMessages(false),
    1,
    "Deleted Items should have 1 item."
  );

  // Create a new folder to use as trash.
  ewsServer.appendRemoteFolder(
    new RemoteFolder("delete2", "root", "delete2", "delete2")
  );

  await syncFolder(incomingServer, rootFolder);

  const newDeleteFolder = rootFolder.getChildNamed("delete2");
  Assert.ok(!!newDeleteFolder, "New delete folder should exist.");

  ewsIncomingServer.trashFolderPath = "delete2";
  Assert.ok(
    newDeleteFolder.getFlag(Ci.nsMsgFolderFlags.Trash),
    "New delete folder should now have the Trash flag."
  );
  Assert.equal(
    ewsIncomingServer.trashFolderPath,
    "delete2",
    "Incoming server preference should have been updated."
  );

  const headersToDelete2 = [[...inboxFolder.messages][0]];

  await deleteItems(inboxFolder, headersToDelete2);

  Assert.equal(
    inboxFolder.getTotalMessages(false),
    1,
    "Inbox should have 1 message."
  );
  Assert.equal(
    newDeleteFolder.getTotalMessages(false),
    1,
    "New trash folder should have 1 message."
  );

  ewsIncomingServer.deleteModel = Ci.IExchangeIncomingServer.DELETE_PERMANENTLY;

  const headersToDelete3 = [[...inboxFolder.messages][0]];

  await deleteItems(inboxFolder, headersToDelete3);

  Assert.equal(
    inboxFolder.getTotalMessages(false),
    0,
    "Should have reached inbox zero."
  );

  // Make sure the two delete folders we used in this test still only have one
  // message each.
  Assert.equal(
    deletedItemsFolder.getTotalMessages(false),
    1,
    "Deleted Items should have 1 message."
  );
  Assert.equal(
    newDeleteFolder.getTotalMessages(false),
    1,
    "delete2 should have 1 message."
  );
});

add_task(async function test_invalidDeleteModel() {
  const folderId = "invalid_delete_model";
  ewsServer.appendRemoteFolder(new RemoteFolder(folderId, "root"));
  await syncFolder(incomingServer, incomingServer.rootFolder);
  const folder = incomingServer.rootFolder.getChildNamed(folderId);
  ewsServer.addItemToFolder("invalid_delete_model_message", folderId);
  await syncFolder(incomingServer, folder);
  const header = [...folder.messages][0];
  Assert.ok(header, "The message has been synced before testing deletion");
  const key = header.messageKey;
  const messageId = header.messageId;
  const originalModel = ewsIncomingServer.deleteModel;

  incomingServer.setIntValue("delete_model", 2);
  try {
    Assert.throws(
      () => ewsIncomingServer.deleteModel,
      /NS_ERROR_UNEXPECTED/,
      "The stored deletion model is invalid"
    );
    Assert.throws(
      () => folder.deleteMessages([header], null, false, false, null, false),
      /NS_ERROR_UNEXPECTED/,
      "Deletion propagates the invalid model error before routing the message"
    );
    Assert.equal(folder.getTotalMessages(false), 1);
    Assert.equal(folder.GetMessageHeader(key).messageId, messageId);
    Assert.equal(
      folder.GetMessageHeader(key).getStringProperty("ewsId"),
      "invalid_delete_model_message"
    );
    Assert.equal(
      ewsServer.getItemInfo("invalid_delete_model_message").parentId,
      folderId,
      "The remote message has not moved"
    );
  } finally {
    ewsIncomingServer.deleteModel = originalModel;
  }

  const listener = new PromiseTestUtils.PromiseCopyListener();
  folder.deleteMessages([header], null, true, false, listener, false);
  await listener.promise;
  Assert.equal(
    folder.getTotalMessages(false),
    0,
    "Deletion works after repair"
  );
  Assert.ok(!ewsServer.getItemInfo("invalid_delete_model_message"));
});
