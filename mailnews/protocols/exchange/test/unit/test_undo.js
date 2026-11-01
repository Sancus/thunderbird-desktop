/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

var incomingServer;

/**
 * @type {EwsServer}
 */
var ewsServer;

/**
 * @type {nsIMsgWindow}
 */
var msgWindow;

var rootFolder;

const ewsIdPropertyName = "ewsId";

add_setup(async function () {
  const alertPref = "mail.suppressAlertsForTests";
  const hadAlertPref = Services.prefs.prefHasUserValue(alertPref);
  const oldAlertPref = Services.prefs.getBoolPref(alertPref, false);
  Services.prefs.setBoolPref(alertPref, true);
  registerCleanupFunction(() => {
    if (hadAlertPref) {
      Services.prefs.setBoolPref(alertPref, oldAlertPref);
    } else {
      Services.prefs.clearUserPref(alertPref);
    }
  });
  [ewsServer, incomingServer] = setupBasicEwsTestServer({});
  msgWindow = Cc["@mozilla.org/messenger/msgwindow;1"].createInstance(
    Ci.nsIMsgWindow
  );
  rootFolder = incomingServer.rootFolder;
  await syncFolder(incomingServer, rootFolder);
});

function findTestMessages(folder, prefix) {
  const messages = [...folder.messages];
  return messages.filter(m =>
    m.getStringProperty(ewsIdPropertyName).startsWith(prefix)
  );
}

async function setupCopyMoveTest(srcFolder, dstFolder, isMove) {
  ewsServer.addItemToFolder("copy_move_item", srcFolder.name);
  await syncFolder(incomingServer, srcFolder);

  const headers = [...srcFolder.messages];
  Assert.equal(
    headers.length,
    1,
    "Should have one message in the source folder."
  );

  const listener = new PromiseTestUtils.PromiseCopyListener();
  MailServices.copy.copyMessages(
    srcFolder,
    headers,
    dstFolder,
    isMove,
    listener,
    msgWindow,
    true
  );
  await listener.promise;
}

function checkFolders(folderCounts) {
  for (const [folder, count] of folderCounts) {
    Assert.equal(
      [...folder.messages].length,
      count,
      `Should have ${count} messages in folder ${folder.name}.`
    );
  }
}

add_task(async function test_undo_move() {
  const srcFolderName = "undo_move_src";
  const dstFolderName = "undo_move_dst";
  ewsServer.appendRemoteFolder(
    new RemoteFolder(srcFolderName, "root", srcFolderName, srcFolderName)
  );
  ewsServer.appendRemoteFolder(
    new RemoteFolder(dstFolderName, "root", dstFolderName, dstFolderName)
  );

  await syncFolder(incomingServer, rootFolder);
  const srcFolder = rootFolder.getChildNamed(srcFolderName);
  const dstFolder = rootFolder.getChildNamed(dstFolderName);

  await setupCopyMoveTest(srcFolder, dstFolder, true);

  checkFolders([
    [srcFolder, 0],
    [dstFolder, 1],
  ]);

  const currentUndoItem = MailServices.txns.transactionManager.peekUndoStack();
  Assert.ok(!!currentUndoItem, "Should have a transaction on the undo stack.");
  Assert.equal(
    currentUndoItem.QueryInterface(Ci.nsIMsgTxn).txnType,
    Ci.nsIMsgTransactionService.eMoveMsg
  );

  MailServices.txns.transactionManager.undoTransaction();
  await TestUtils.waitForCondition(() => {
    return !![...srcFolder.messages].length;
  }, "Waiting for undo operation to complete.");

  checkFolders([
    [srcFolder, 1],
    [dstFolder, 0],
  ]);

  const currentRedoItem = MailServices.txns.transactionManager.peekRedoStack();
  Assert.ok(!!currentRedoItem, "Should have a transaction on the redo stack.");
  Assert.equal(
    currentRedoItem.QueryInterface(Ci.nsIMsgTxn).txnType,
    Ci.nsIMsgTransactionService.eMoveMsg
  );

  MailServices.txns.transactionManager.redoTransaction();
  await TestUtils.waitForCondition(() => {
    return !![...dstFolder.messages].length;
  }, "Waiting for redo operation to complete.");

  checkFolders([
    [srcFolder, 0],
    [dstFolder, 1],
  ]);

  MailServices.txns.transactionManager.clear();
});

add_task(async function test_undo_copy() {
  const srcFolderName = "undo_copy_src";
  const dstFolderName = "undo_copy_dst";
  ewsServer.appendRemoteFolder(
    new RemoteFolder(srcFolderName, "root", srcFolderName, srcFolderName)
  );
  ewsServer.appendRemoteFolder(
    new RemoteFolder(dstFolderName, "root", dstFolderName, dstFolderName)
  );

  await syncFolder(incomingServer, rootFolder);
  const srcFolder = rootFolder.getChildNamed(srcFolderName);
  const dstFolder = rootFolder.getChildNamed(dstFolderName);

  await setupCopyMoveTest(srcFolder, dstFolder, false);

  checkFolders([
    [srcFolder, 1],
    [dstFolder, 1],
  ]);

  const currentUndoItem = MailServices.txns.transactionManager.peekUndoStack();
  Assert.ok(!!currentUndoItem, "Should have a transaction on the undo stack.");
  Assert.equal(
    currentUndoItem.QueryInterface(Ci.nsIMsgTxn).txnType,
    Ci.nsIMsgTransactionService.eCopyMsg
  );

  MailServices.txns.transactionManager.undoTransaction();
  await TestUtils.waitForCondition(() => {
    return ![...dstFolder.messages].length;
  }, "Waiting for undo operation to complete.");

  checkFolders([
    [srcFolder, 1],
    [dstFolder, 0],
  ]);

  const currentRedoItem = MailServices.txns.transactionManager.peekRedoStack();
  Assert.ok(!!currentRedoItem, "Should have a transaction on the redo stack.");
  Assert.equal(
    currentRedoItem.QueryInterface(Ci.nsIMsgTxn).txnType,
    Ci.nsIMsgTransactionService.eCopyMsg
  );

  MailServices.txns.transactionManager.redoTransaction();
  await TestUtils.waitForCondition(() => {
    return !![...dstFolder.messages].length;
  }, "Waiting for redo operation to complete.");

  checkFolders([
    [srcFolder, 1],
    [dstFolder, 1],
  ]);

  MailServices.txns.transactionManager.clear();
});

/**
 * This test tests undoing of soft delete operations, in which the item is moved
 * to the trash. There is no way to undo a hard delete in which the item is
 * permanently deleted.
 */
add_task(async function test_undo_delete() {
  const trashFolder = rootFolder.getChildNamed("Deleted Items");
  Assert.ok(!!trashFolder, "Trash folder should exist.");

  const folderName = "undo_delete";
  ewsServer.appendRemoteFolder(
    new RemoteFolder(folderName, "root", folderName, folderName)
  );
  ewsServer.addItemToFolder("undo_delete_test", folderName);
  await syncFolder(incomingServer, rootFolder);

  const folder = rootFolder.getChildNamed(folderName);
  await syncFolder(incomingServer, folder);

  const messagesToDelete = [...folder.messages];
  Assert.equal(messagesToDelete.length, 1, "Should have a message to delete.");

  const listener = new PromiseTestUtils.PromiseCopyListener();
  folder.deleteMessages(
    messagesToDelete,
    msgWindow,
    false,
    false,
    listener,
    true
  );
  await listener.promise;

  checkFolders([
    [folder, 0],
    [trashFolder, 1],
  ]);

  const undoTransaction = MailServices.txns.transactionManager.peekUndoStack();
  Assert.ok(!!undoTransaction, "Should have an undo transaction.");
  Assert.equal(
    undoTransaction.QueryInterface(Ci.nsIMsgTxn).txnType,
    Ci.nsIMsgTransactionService.eDeleteMsg
  );

  MailServices.txns.transactionManager.undoTransaction();
  await TestUtils.waitForCondition(() => {
    return !![...folder.messages].length;
  }, "Waiting for message to reappear in source folder.");

  checkFolders([
    [folder, 1],
    [trashFolder, 0],
  ]);

  const redoTransaction = MailServices.txns.transactionManager.peekRedoStack();
  Assert.ok(!!redoTransaction, "Should have a redo transaction.");
  Assert.equal(
    redoTransaction.QueryInterface(Ci.nsIMsgTxn).txnType,
    Ci.nsIMsgTransactionService.eDeleteMsg
  );

  MailServices.txns.transactionManager.redoTransaction();
  await TestUtils.waitForCondition(() => {
    return ![...folder.messages].length;
  }, "Waiting for message to disappear from folder.");

  checkFolders([
    [folder, 0],
    [trashFolder, 1],
  ]);

  MailServices.txns.transactionManager.clear();
});

var { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const undoGenerator = new MessageGenerator();

/**
 * Create a real copy/move transaction whose HTTP endpoint can be restarted.
 *
 * @param {string} type - Either "ews" or "graph".
 * @param {string} name - Unique folder/account prefix.
 * @param {boolean} isMove - Whether the original operation moves messages.
 * @returns {Promise<object>} The server, folders, transaction and source bodies.
 */
async function createUndoFixture(type, name, isMove) {
  // The default copy policy excludes flags except Read/New/HasRe. Exercise
  // retained Marked state with the existing configurable preservation policy.
  const flagsPref = "mailnews.database.summary.dontPreserveOnCopy";
  const hadFlagsPref = Services.prefs.prefHasUserValue(flagsPref);
  const oldFlagsPref = Services.prefs.getStringPref(flagsPref);
  Services.prefs.setStringPref(
    flagsPref,
    oldFlagsPref
      .split(" ")
      .filter(property => property != "flags")
      .join(" ")
  );
  registerCleanupFunction(() => {
    if (hadFlagsPref) {
      Services.prefs.setStringPref(flagsPref, oldFlagsPref);
    } else {
      Services.prefs.clearUserPref(flagsPref);
    }
  });
  const socket = Cc["@mozilla.org/network/server-socket;1"].createInstance(
    Ci.nsIServerSocket
  );
  socket.init(-1, true, -1);
  const listenPort = socket.port;
  socket.close();
  const mock = new (type == "ews" ? EwsServer : GraphServer)({
    username: name,
    listenPort,
  });
  mock.start();
  const server = localAccountUtils
    .create_incoming_server(type, mock.port, name, "password")
    .QueryInterface(Ci.IExchangeIncomingServer);
  server.setStringValue(
    "ews_url",
    `http://127.0.0.1:${mock.port}/${type == "ews" ? "EWS/Exchange.asmx" : ""}`
  );
  registerCleanupFunction(async () => {
    server.shutdown();
    await TestUtils.waitForCondition(() => !server.protocolClientRunning);
    await mock.stop();
  });
  const databaseService = Cc[
    "@mozilla.org/msgDatabase/msgDBService;1"
  ].getService(Ci.nsIMsgDBService);
  Assert.equal(
    "nsIDatabaseCore" in Ci && databaseService instanceof Ci.nsIDatabaseCore,
    Services.prefs.getBoolPref("mail.panorama.enabled", false),
    "The real consumer uses the configured database backend"
  );
  Assert.equal(
    server.getStringValue("storeContractID"),
    Services.prefs.getCharPref("mail.serverDefaultStoreContractID")
  );
  for (const suffix of ["source", "destination"]) {
    const id = `${name}_${suffix}`;
    mock.appendRemoteFolder(new RemoteFolder(id, "root", id, id));
  }
  await syncFolder(server, server.rootFolder);
  const source = server.rootFolder.getChildNamed(`${name}_source`);
  const destination = server.rootFolder.getChildNamed(`${name}_destination`);
  const messages = undoGenerator.makeMessages({ count: 3, msgsPerThread: 3 });
  for (let i = 0; i < messages.length; i++) {
    mock.addItemToFolder(`${name}_${i}`, source.name, messages[i]);
  }
  await syncFolder(server, source);
  const headers = [...source.messages];
  for (const header of headers) {
    const stream = new PromiseTestUtils.PromiseStreamListener();
    const uri = source.getUriForMsg(header);
    MailServices.messageServiceFromURI(uri).streamMessage(
      uri,
      stream,
      null,
      null,
      false,
      "",
      false
    );
    Assert.equal(
      await stream.promise,
      messages
        .find(message => message.messageId == header.messageId)
        .toMessageString()
    );
    header.markRead(true);
    header.markFlagged(true);
    header.setStringProperty("keywords", "$label2 transaction");
    Assert.ok(
      header.isRead && header.isFlagged,
      "The input contains Read and Marked"
    );
  }
  const selected = [headers[1], headers[0]];
  // The copy service groups this folder by walking the input backwards.
  // Transactions retain the order passed to Exchange and acknowledged by it.
  const expected = selected.toReversed().map(header => ({
    id: header.messageId,
    raw: messages
      .find(message => message.messageId == header.messageId)
      .toMessageString(),
    references: Array.from({ length: header.numReferences }, (_, i) =>
      header.getStringReference(i)
    ),
  }));
  const manager = MailServices.txns.transactionManager;
  manager.clear();
  registerCleanupFunction(() => manager.clear());
  const fixture = {
    mock,
    server,
    source,
    destination,
    expected,
    unselected: headers[2],
    latestHeaders: [],
    publications: 0,
  };
  const published = {
    msgsMoveCopyCompleted(move, sourceHeaders, target, newHeaders) {
      if (target == source || target == destination) {
        fixture.publications++;
        Assert.equal(move, isMove);
        Assert.deepEqual(
          sourceHeaders.map(header => header.messageId),
          expected.map(item => item.id)
        );
        fixture.latestHeaders = newHeaders;
      }
    },
  };
  MailServices.mfn.addListener(
    published,
    Ci.nsIMsgFolderNotificationService.msgsMoveCopyCompleted
  );
  registerCleanupFunction(() => MailServices.mfn.removeListener(published));
  const listener = new PromiseTestUtils.PromiseCopyListener();
  MailServices.copy.copyMessages(
    source,
    selected,
    destination,
    isMove,
    listener,
    msgWindow,
    true
  );
  await listener.promise;
  const transaction = manager.peekUndoStack();
  Assert.ok(
    transaction,
    "The actual successful operation publishes an undo item"
  );
  Assert.equal(
    transaction.QueryInterface(Ci.nsIMsgTxn).txnType,
    isMove
      ? Ci.nsIMsgTransactionService.eMoveMsg
      : Ci.nsIMsgTransactionService.eCopyMsg
  );
  Assert.equal(fixture.publications, 1, "The initial operation publishes once");
  fixture.transaction = transaction;
  return fixture;
}

/**
 * Check physical rows, server IDs, ordered references and cached message bytes.
 *
 * @param {object} fixture - The real transaction fixture.
 * @param {nsIMsgFolder} folder - The current location of selected messages.
 * @returns {Promise<object[]>} The current physical keys, opaque IDs and tokens.
 */
async function checkTransactionMessages(fixture, folder) {
  const { mock, expected, unselected } = fixture;
  // The notification returns headers in request order; folder enumeration has
  // no ordering contract. Check the actual returned set and DB membership.
  const headers = fixture.latestHeaders;
  Assert.equal(
    [...folder.messages].filter(
      header => header.messageId != unselected.messageId
    ).length,
    expected.length
  );
  Assert.deepEqual(
    headers.map(header => header.messageId),
    expected.map(item => item.id)
  );
  const result = [];
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    Assert.equal(header.folder.URI, folder.URI);
    Assert.ok(folder.msgDatabase.containsKey(header.messageKey));
    Assert.ok(header.isRead && header.isFlagged);
    Assert.equal(header.getStringProperty("keywords"), "$label2 transaction");
    Assert.deepEqual(
      Array.from({ length: header.numReferences }, (_, j) =>
        header.getStringReference(j)
      ),
      expected[i].references
    );
    const id = header.getStringProperty("ewsId");
    Assert.ok(id, "The returned physical header has its actual server ID");
    Assert.equal(
      mock.getItemInfo(id).parentId,
      folder.getStringProperty("ewsId")
    );
    Assert.ok(header.storeToken);
    Assert.ok(folder.hasMsgOffline(header.messageKey));
    const uri = folder.getUriForMsg(header);
    const stream = new PromiseTestUtils.PromiseStreamListener();
    MailServices.messageServiceFromURI(uri).streamMessage(
      uri,
      stream,
      null,
      null,
      false,
      "",
      true
    );
    Assert.equal(await stream.promise, expected[i].raw);
    result.push({ key: header.messageKey, id, token: header.storeToken });
  }
  Assert.equal(new Set(result.map(item => item.key)).size, expected.length);
  Assert.ok(fixture.source.msgDatabase.containsKey(unselected.messageKey));
  Assert.equal(
    fixture.source.GetMessageHeader(unselected.messageKey).messageId,
    unselected.messageId
  );
  return result;
}

/**
 * Fail an undo/redo request against a stopped HTTP server, then repair it.
 *
 * @param {object} fixture - The actual transaction and restartable server.
 * @param {boolean} redo - Whether to invoke redo instead of undo.
 * @param {nsIMsgFolder} failureFolder - The folder that reports the failed operation.
 * @returns {Promise<void>} Resolves after the failure event and endpoint restart.
 */
async function failTransactionRequest(fixture, redo, failureFolder) {
  const { mock, transaction } = fixture;
  const events = [];
  const listener = {
    onFolderEvent(folder, event) {
      if (folder == failureFolder) {
        events.push(event);
      }
    },
  };
  MailServices.mailSession.AddFolderListener(
    listener,
    Ci.nsIFolderListener.event
  );
  await mock.stop();
  try {
    // Confirm the real endpoint error through the existing protocol listener.
    // nsITransaction itself has no asynchronous status callback.
    const failedProbe = Promise.withResolvers();
    const probeErrors = [];
    fixture.server.getProtocolClient().deleteMessages(
      {
        QueryInterface: ChromeUtils.generateQI([
          "IExchangeSimpleOperationListener",
          "IExchangeFallibleOperationListener",
        ]),
        onOperationSuccess() {
          Assert.ok(false, "A stopped endpoint cannot acknowledge deletion");
          failedProbe.resolve();
        },
        onOperationFailure(status) {
          probeErrors.push(status);
          failedProbe.resolve();
        },
      },
      [...failureFolder.messages]
        .slice(0, 1)
        .map(header => header.getStringProperty("ewsId"))
    );
    await failedProbe.promise;
    Assert.deepEqual(probeErrors, [Cr.NS_ERROR_CONNECTION_REFUSED]);
    const failed = PromiseTestUtils.promiseFolderEvent(
      failureFolder,
      "DeleteOrMoveMsgFailed"
    );
    transaction[redo ? "redoTransaction" : "undoTransaction"]();
    await failed;
    Assert.deepEqual(
      events,
      ["DeleteOrMoveMsgFailed"],
      "The failed operation finishes once"
    );
  } finally {
    mock.start();
    MailServices.mailSession.RemoveFolderListener(listener);
  }
}

/**
 * Retain copied headers after asynchronous delete failure and retry explicitly.
 *
 * @param {string} type - The configured Exchange provider.
 * @returns {Promise<void>} Resolves after failed undo, repaired undo and redo.
 */
async function checkCopyUndoFailure(type) {
  const fixture = await createUndoFixture(type, `${type}_undo_retry`, false);
  const { source, destination, transaction } = fixture;
  const before = await checkTransactionMessages(fixture, destination);
  await failTransactionRequest(fixture, false, destination);
  Assert.deepEqual(
    await checkTransactionMessages(fixture, destination),
    before
  );
  Assert.equal(
    source.getTotalMessages(false),
    3,
    "Copy failure retains every source item"
  );
  Assert.throws(
    () => transaction.redoTransaction(),
    error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
    "Failed undo cannot turn into a second copy"
  );
  const deleted = PromiseTestUtils.promiseFolderEvent(
    destination,
    "DeleteOrMoveMsgCompleted"
  );
  transaction.undoTransaction();
  await deleted;
  Assert.equal(
    destination.getTotalMessages(false),
    0,
    "Repaired undo deletes the retained copied headers"
  );
  for (const item of before) {
    Assert.ok(!destination.msgDatabase.containsKey(item.key));
    Assert.ok(!fixture.mock.getItemInfo(item.id));
  }
  const copied = PromiseTestUtils.promiseFolderNotification(
    destination,
    "msgsMoveCopyCompleted"
  );
  transaction.redoTransaction();
  await copied;
  Assert.equal(fixture.publications, 2, "Redo publishes exactly one new set");
  await checkTransactionMessages(fixture, destination);
  const deletedAgain = PromiseTestUtils.promiseFolderEvent(
    destination,
    "DeleteOrMoveMsgCompleted"
  );
  transaction.undoTransaction();
  await deletedAgain;
  Assert.equal(
    destination.getTotalMessages(false),
    0,
    "Second undo uses the redo's actual headers"
  );
}

/**
 * Use acknowledged physical headers through move undo/redo and failed redo retry.
 *
 * @param {string} type - The configured Exchange provider.
 * @param {boolean} failRedo - Whether to fail and repair the redo request.
 * @returns {Promise<void>} Resolves after undo and redo preserve the selected bodies.
 */
async function checkMoveUndoRedo(type, failRedo) {
  const fixture = await createUndoFixture(
    type,
    `${type}_move_${failRedo}`,
    true
  );
  const { source, destination, transaction } = fixture;
  const initial = await checkTransactionMessages(fixture, destination);
  const undone = PromiseTestUtils.promiseFolderEvent(
    destination,
    "DeleteOrMoveMsgCompleted"
  );
  transaction.undoTransaction();
  Assert.throws(
    () => transaction.redoTransaction(),
    error => error.result == Cr.NS_ERROR_IN_PROGRESS,
    "A pending undo cannot be raced by redo"
  );
  await undone;
  Assert.equal(destination.getTotalMessages(false), 0);
  Assert.equal(fixture.publications, 2, "Undo publishes once");
  const restored = await checkTransactionMessages(fixture, source);
  Assert.ok(
    restored.every((item, i) => item.id != initial[i].id),
    "Undo uses acknowledged changed server IDs"
  );
  if (failRedo) {
    await failTransactionRequest(fixture, true, source);
    Assert.deepEqual(await checkTransactionMessages(fixture, source), restored);
    Assert.equal(fixture.publications, 2, "Failed redo does not publish");
    Assert.equal(
      destination.getTotalMessages(false),
      0,
      "Failed redo publishes no destination"
    );
  }
  const redone = PromiseTestUtils.promiseFolderEvent(
    source,
    "DeleteOrMoveMsgCompleted"
  );
  transaction.redoTransaction();
  Assert.throws(
    () => transaction.undoTransaction(),
    error => error.result == Cr.NS_ERROR_IN_PROGRESS,
    "A pending redo cannot be raced by undo"
  );
  await redone;
  Assert.equal(fixture.publications, 3, "Redo publishes once");
  const current = await checkTransactionMessages(fixture, destination);
  Assert.ok(current.every((item, i) => item.id != restored[i].id));
  Assert.equal(source.getTotalMessages(false), 1);
  const undoneAgain = PromiseTestUtils.promiseFolderEvent(
    destination,
    "DeleteOrMoveMsgCompleted"
  );
  transaction.undoTransaction();
  await undoneAgain;
  Assert.equal(fixture.publications, 4, "The second undo publishes once");
  await checkTransactionMessages(fixture, source);
}

add_task(async function test_copyUndoDeleteFailureEws() {
  await checkCopyUndoFailure("ews");
});
add_task(async function test_copyUndoDeleteFailureGraph() {
  await checkCopyUndoFailure("graph");
});
add_task(async function test_moveUndoRedoPhysicalIdentityEws() {
  await checkMoveUndoRedo("ews", false);
});
add_task(async function test_moveUndoRedoPhysicalIdentityGraph() {
  await checkMoveUndoRedo("graph", false);
});
add_task(async function test_redoFailureRetainsTransactionEws() {
  await checkMoveUndoRedo("ews", true);
});
add_task(async function test_redoFailureRetainsTransactionGraph() {
  await checkMoveUndoRedo("graph", true);
});

/**
 * Retain the original copy source when redo fails, then retry the same item.
 *
 * @param {string} type - The configured Exchange provider.
 * @returns {Promise<void>} Resolves after failed redo and its explicit retry.
 */
async function checkCopyRedoFailure(type) {
  const fixture = await createUndoFixture(
    type,
    `${type}_copy_redo_retry`,
    false
  );
  const { source, destination, transaction } = fixture;
  const original = [...source.messages].map(header => ({
    key: header.messageKey,
    id: header.getStringProperty("ewsId"),
    token: header.storeToken,
    flags: header.flags,
  }));
  const deleted = PromiseTestUtils.promiseFolderEvent(
    destination,
    "DeleteOrMoveMsgCompleted"
  );
  transaction.undoTransaction();
  await deleted;
  Assert.equal(destination.getTotalMessages(false), 0);
  Assert.throws(
    () => transaction.undoTransaction(),
    error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
    "An already undone copy cannot delete another set"
  );
  await failTransactionRequest(fixture, true, source);
  Assert.equal(
    fixture.publications,
    1,
    "Failed copy redo publishes no destination"
  );
  Assert.equal(destination.getTotalMessages(false), 0);
  Assert.deepEqual(
    [...source.messages].map(header => ({
      key: header.messageKey,
      id: header.getStringProperty("ewsId"),
      token: header.storeToken,
      flags: header.flags,
    })),
    original,
    "The original physical source survives failed redo"
  );
  const copied = PromiseTestUtils.promiseFolderNotification(
    destination,
    "msgsMoveCopyCompleted"
  );
  transaction.redoTransaction();
  Assert.throws(
    () => transaction.redoTransaction(),
    error => error.result == Cr.NS_ERROR_IN_PROGRESS,
    "A repeated pending redo cannot publish twice"
  );
  await copied;
  Assert.equal(fixture.publications, 2);
  await checkTransactionMessages(fixture, destination);
  Assert.equal(source.getTotalMessages(false), 3);
}

add_task(async function test_copyRedoFailureEws() {
  await checkCopyRedoFailure("ews");
});
add_task(async function test_copyRedoFailureGraph() {
  await checkCopyRedoFailure("graph");
});
