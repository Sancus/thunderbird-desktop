/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

var { MockServer, RemoteFolder } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MockServer.sys.mjs"
);
var { localAccountUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/LocalAccountUtils.sys.mjs"
);
var { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
var { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
var { ServerTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ServerTestUtils.sys.mjs"
);

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

var ewsIncomingServer;
var graphIncomingServer;

/**
 * @type {MockServer}
 */
var ewsServer;
var graphServer;

const ewsIdPropertyName = "ewsId";
const generator = new MessageGenerator();

add_setup(async function () {
  // Negative protocol cases check callback errors without opening GUI alerts.
  Services.prefs.setBoolPref("mail.suppressAlertsForTests", true);
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref("mail.suppressAlertsForTests")
  );

  [ewsServer, ewsIncomingServer] = setupBasicEwsTestServer({});
  [graphServer, graphIncomingServer] = setupBasicGraphTestServer({});

  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.equal(
    "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
    Services.prefs.getBoolPref("mail.panorama.enabled", false)
  );
});

/**
 * Construct the test structure required for copying or moving items.
 *
 * The `prefix` argument indicates the prefix to apply to the folders
 * constructed for the test setup. This function will create two folders on the
 * remote server: `<prefix>_folder1` and `<prefix>_folder2`, and will place two
 * items in `<prefix>_folder1` named `<prefix>_a` and `<prefix>_b`, each with a
 * synthetic message.
 *
 * This function returns a tuple with the the two folders as the first two
 * elements and an array containing the synthetic messages in order.
 *
 * @param {string} prefix
 * @returns {[string, string, nsIMsgFolder, nsIMsgFolder]}
 */
async function setup_item_copymove_structure(
  prefix,
  mockServer,
  incomingServer
) {
  const type = incomingServer.type;

  // Create two folders for the copy/move tests.
  const folder1Name = `${type}_${prefix}_folder1`;
  const folder2Name = `${type}_${prefix}_folder2`;
  mockServer.appendRemoteFolder(
    new RemoteFolder(folder1Name, "root", folder1Name, folder1Name)
  );
  mockServer.appendRemoteFolder(
    new RemoteFolder(folder2Name, "root", folder2Name, folder2Name)
  );

  const rootFolder = incomingServer.rootFolder;
  await syncFolder(incomingServer, rootFolder);

  const folder1 = rootFolder.getChildNamed(folder1Name);
  Assert.ok(!!folder1, `${folder1Name} should exist.`);
  const folder2 = rootFolder.getChildNamed(folder2Name);
  Assert.ok(!!folder2, `${folder2Name} should exist.`);

  const msgs = generator.makeMessages({ count: 2 });

  mockServer.addItemToFolder(`${type}_${prefix}_a`, folder1Name, msgs[0]);
  mockServer.addItemToFolder(`${type}_${prefix}_b`, folder1Name, msgs[1]);

  await syncFolder(incomingServer, folder1);

  Assert.equal(
    folder1.getTotalMessages(false),
    2,
    `${folder1Name} should have 2 messages`
  );
  Assert.equal(
    folder2.getTotalMessages(false),
    0,
    `${folder2Name} should be empty.`
  );

  return [folder1, folder2, msgs];
}

/**
 * Copy or move items between folders.
 *
 * This function initiates a copy of the items represented by the given
 * `headers` from the `sourceFolder` to the `destinationFolder`.  The `isMove`
 * parameter specifies whether this is a move or a copy operation.  Returns a
 * promise that can be awaited to guarantee the async copy operation has
 * finished.
 *
 * @param {nsIMsgFolder} sourceFolder
 * @param {nsIMsgFolder} destinationFolder
 * @param {[nsIMsgDBHdr]} headers
 * @param {boolean} isMove
 * @returns {Promise}
 */
async function copyItems(sourceFolder, destinationFolder, headers, isMove) {
  let eventHappened = false;
  const eventPromise = PromiseTestUtils.promiseFolderEvent(
    sourceFolder,
    "DeleteOrMoveMsgCompleted"
  ).then(() => (eventHappened = true));

  const notificationPromise = PromiseTestUtils.promiseFolderNotification(
    destinationFolder,
    "msgsMoveCopyCompleted"
  );

  let starts = 0;
  const stops = [];
  const copyListener = new PromiseTestUtils.PromiseCopyListener({
    onStartCopy() {
      starts++;
    },
    onStopCopy(status) {
      stops.push(status);
    },
  });
  MailServices.copy.copyMessages(
    sourceFolder,
    headers,
    destinationFolder,
    isMove,
    copyListener,
    null, // msgWindow
    false // allowUndo
  );
  await copyListener.promise;
  Assert.equal(starts, 1, "The copy service starts the operation once");
  Assert.deepEqual(stops, [Cr.NS_OK], "The copy service completes once");

  if (isMove) {
    await eventPromise;
  } else {
    Assert.ok(
      !eventHappened,
      "there should not be a DeleteOrMoveMsgCompleted event for a copy operation"
    );
  }

  const notificationArgs = await notificationPromise;
  Assert.equal(notificationArgs[0], isMove, "notification is move");
  Assert.equal(
    notificationArgs[1].length,
    headers.length,
    "notification source message count"
  );
  Assert.equal(
    notificationArgs[2],
    destinationFolder,
    "notification destination folder"
  );
  Assert.equal(
    notificationArgs[3].length,
    headers.length,
    "notification destination message count"
  );
}

/**
 * Tests that an account is capable of moving messages from one folder to
 * another.
 *
 * @param {MockServer} mockServer - The `MockServer` child class instance to use
 *   for creating folders and messages.
 * @param {nsIMsgIncomingFolder} incomingServer - The incoming message for the
 *   protocol that's being tested.
 */
async function subtestMoveItem(mockServer, incomingServer) {
  const [folder1, folder2, msgs] = await setup_item_copymove_structure(
    "move",
    mockServer,
    incomingServer
  );

  const headers = [];
  [...folder1.messages].forEach(header => headers.push(header));

  // Initiate the move operation.
  const isMove = true;
  await copyItems(folder1, folder2, headers, isMove);

  Assert.equal(
    folder1.getTotalMessages(false),
    0,
    `${folder1.name} should be empty`
  );
  Assert.equal(
    folder2.getTotalMessages(false),
    2,
    `${folder2.name} should have 2 messages`
  );

  for (const header of folder2.messages) {
    Assert.equal(header.folder.URI, folder2.URI);
    const remote = mockServer.getItemInfo(header.getStringProperty("ewsId"));
    Assert.ok(
      remote,
      "The published destination header has its real remote ID"
    );
    Assert.equal(remote.parentId, folder2.getStringProperty("ewsId"));
    Assert.ok(msgs.some(message => message.messageId == header.messageId));
  }

  // Check that the messages in `folder2` are the correct ones.
  const expectedSubjects = msgs.map(msg => msg.subject);
  const actualSubjects = [...folder2.messages].map(msg => msg.subject);

  for (const subject of expectedSubjects) {
    Assert.ok(
      actualSubjects.includes(subject),
      `${folder2.name} should contain a message with the subject \"${subject}\"`
    );
  }
}

add_task(async function testMoveItemEws() {
  await subtestMoveItem(ewsServer, ewsIncomingServer);
});

add_task(async function testMoveItemGraph() {
  await subtestMoveItem(graphServer, graphIncomingServer);
});

async function subtestCopyItem(mockServer, incomingServer) {
  const [folder1, folder2, msgs] = await setup_item_copymove_structure(
    "copy",
    mockServer,
    incomingServer
  );

  const headers = [];
  [...folder1.messages].forEach(header => headers.push(header));

  // Initiate the copy operation.
  const isMove = false;
  await copyItems(folder1, folder2, headers, isMove);

  Assert.equal(
    folder1.getTotalMessages(false),
    2,
    `${folder1.name} should contain 2 messages`
  );
  Assert.equal(
    folder2.getTotalMessages(false),
    2,
    `${folder2.name} should contain 2 messages`
  );

  // Check that we have a copy of each message in each folder.
  const expectedSubjects = msgs.map(msg => msg.subject);
  const folder1Subjects = [...folder1.messages].map(msg => msg.subject);
  const folder2Subjects = [...folder2.messages].map(msg => msg.subject);

  for (const subject of expectedSubjects) {
    Assert.ok(
      folder1Subjects.includes(subject),
      `${folder1.name} should contain a message with the subject \"${subject}\"`
    );
    Assert.ok(
      folder2Subjects.includes(subject),
      `${folder2.name} should contain a message with the subject \"${subject}\"`
    );
  }

  for (const header of folder2.messages) {
    Assert.equal(header.folder.URI, folder2.URI);
    const remote = mockServer.getItemInfo(header.getStringProperty("ewsId"));
    Assert.ok(
      remote,
      "The published destination header has its real remote ID"
    );
    Assert.equal(remote.parentId, folder2.getStringProperty("ewsId"));
    Assert.ok(msgs.some(message => message.messageId == header.messageId));
  }
}

/**
 * Checks a native remote-ID write failure and a following copy. Mork exercises
 * the following copy without the native SQL fault.
 *
 * @param {MockServer} mockServer - The remote message fixture.
 * @param {nsIMsgIncomingServer} incomingServer - The configured protocol account.
 */
async function checkRemoteIdWriteFailure(mockServer, incomingServer) {
  const [source, destination] = await setup_item_copymove_structure(
    "id_write_failure",
    mockServer,
    incomingServer
  );
  const headers = [...source.messages];
  const retained = {
    key: headers[0].messageKey,
    id: headers[0].messageId,
    remoteId: headers[0].getStringProperty("ewsId"),
    flags: headers[0].flags,
    token: headers[0].storeToken,
    offline: source.hasMsgOffline(headers[0].messageKey),
  };

  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    const connection = Cc["@mozilla.org/mailnews/database-core;1"].getService(
      Ci.nsIDatabaseCore
    ).connectionForTests;
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER reject_copy_remote_id BEFORE INSERT ON message_properties " +
        "WHEN NEW.name = 'ewsId' AND NEW.id IN " +
        `(SELECT id FROM messages WHERE folderId = ${destination.id}) ` +
        "BEGIN SELECT RAISE(ABORT, 'copy remote ID fault'); END"
    );
    try {
      let starts = 0;
      const stops = [];
      const listener = new PromiseTestUtils.PromiseCopyListener({
        onStartCopy() {
          starts++;
        },
        onStopCopy(status) {
          stops.push(status);
        },
      });
      MailServices.copy.copyMessages(
        source,
        [headers[0]],
        destination,
        true,
        listener,
        null,
        false
      );
      await Assert.rejects(
        listener.promise,
        new RegExp(Cr.NS_ERROR_STORAGE_CONSTRAINT),
        "The real remote-ID write error fails the move"
      );
      await TestUtils.waitForCondition(
        () => incomingServer.protocolClientIdle,
        "Waiting for the failed ID binding to finish"
      );
      Assert.equal(starts, 1);
      Assert.deepEqual(stops, [Cr.NS_ERROR_STORAGE_CONSTRAINT]);
      const original = source.GetMessageHeader(retained.key);
      Assert.equal(original.messageId, retained.id);
      Assert.equal(original.getStringProperty("ewsId"), retained.remoteId);
      Assert.equal(original.flags, retained.flags);
      Assert.equal(original.storeToken, retained.token);
      Assert.equal(source.hasMsgOffline(retained.key), retained.offline);
      const partial = [...destination.messages];
      Assert.equal(partial.length, 1, "The published destination is retained");
      Assert.equal(partial[0].messageId, retained.id);
      Assert.equal(partial[0].folder.URI, destination.URI);
      Assert.ok(!partial[0].properties.includes("ewsId"));
      Assert.equal(partial[0].getStringProperty("ewsId"), "");
      Assert.ok(
        !mockServer.getItemInfo(retained.remoteId),
        "The server move already happened; no remote rollback is claimed"
      );
      Assert.equal(
        mockServer.getItemsInFolder(destination.getStringProperty("ewsId"))
          .length,
        1
      );
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER reject_copy_remote_id");
    }
  }

  // A new request to the same destination must not remain behind a failed one.
  let starts = 0;
  const stops = [];
  const listener = new PromiseTestUtils.PromiseCopyListener({
    onStartCopy() {
      starts++;
    },
    onStopCopy(status) {
      stops.push(status);
    },
  });
  MailServices.copy.copyMessages(
    source,
    [headers[1]],
    destination,
    false,
    listener,
    null,
    false
  );
  await listener.promise;
  Assert.equal(starts, 1);
  Assert.deepEqual(stops, [Cr.NS_OK]);
  const copied = [...destination.messages].find(
    header => header.messageId == headers[1].messageId
  );
  Assert.ok(copied);
  Assert.equal(copied.folder.URI, destination.URI);
  const remote = mockServer.getItemInfo(copied.getStringProperty("ewsId"));
  Assert.ok(remote);
  Assert.equal(remote.parentId, destination.getStringProperty("ewsId"));
  Assert.equal(source.GetMessageHeader(retained.key).messageId, retained.id);
}

add_task(async function test_remoteIdWriteFailureEws() {
  await checkRemoteIdWriteFailure(ewsServer, ewsIncomingServer);
});

add_task(async function test_remoteIdWriteFailureGraph() {
  await checkRemoteIdWriteFailure(graphServer, graphIncomingServer);
});

add_task(async function testCopyItemEws() {
  await subtestCopyItem(ewsServer, ewsIncomingServer);
});

add_task(async function testCopyItemGraph() {
  await subtestCopyItem(graphServer, graphIncomingServer);
});

add_task(async function test_move_copy_messages_from_another_server() {
  ewsServer.appendRemoteFolder(
    new RemoteFolder("copyFromAnotherServer", "root")
  );

  const ewsRootFolder = ewsIncomingServer.rootFolder;
  ewsIncomingServer.performExpand(null);
  const ewsDestFolder = await TestUtils.waitForCondition(
    () => ewsRootFolder.getChildNamed("copyFromAnotherServer"),
    "waiting for test folder to exist"
  );
  await syncFolder(ewsIncomingServer, ewsDestFolder);
  Assert.equal(
    ewsDestFolder.getTotalMessages(false),
    0,
    "ewsDestFolder should start with no messages"
  );

  const localAccount = MailServices.accounts.createLocalMailAccount();
  const localRootFolder = localAccount.incomingServer.rootFolder;
  localRootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  const localSourceFolder = localRootFolder.createLocalSubfolder(
    "copyToAnotherServer"
  );
  localSourceFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  localSourceFolder.addMessageBatch(
    generator.makeMessages({}).map(message => message.toMessageString())
  );
  const localHeaders = [...localSourceFolder.messages];

  await copyItems(
    localSourceFolder,
    ewsDestFolder,
    localHeaders.slice(2, 4),
    false
  );

  Assert.equal(
    ewsDestFolder.getTotalMessages(false),
    2,
    "ewsDestFolder should contain two copied messages"
  );
  Assert.equal(
    localSourceFolder.getTotalMessages(false),
    10,
    "localSourceFolder should still have the copied messages"
  );

  await copyItems(
    localSourceFolder,
    ewsDestFolder,
    localHeaders.slice(8, 9),
    true
  );

  Assert.equal(
    ewsDestFolder.getTotalMessages(false),
    3,
    "ewsDestFolder should contain the moved message"
  );
  Assert.equal(
    localSourceFolder.getTotalMessages(false),
    9,
    "localSourceFolder should not still have the moved message"
  );

  Assert.throws(
    () =>
      MailServices.copy.copyMessages(
        localSourceFolder,
        [undefined],
        ewsDestFolder,
        true, // isMove
        null, // listener
        null, // msgWindow
        false // allowUndo
      ),
    /NS_ERROR_ILLEGAL_VALUE/,
    "moving an undefined message should throw"
  );

  MailServices.accounts.removeAccount(localAccount, false);
});

add_task(async function test_move_copy_messages_to_another_server() {
  ewsServer.appendRemoteFolder(new RemoteFolder("copyToAnotherServer", "root"));
  ewsServer.addMessages("copyToAnotherServer", generator.makeMessages({}));

  const ewsRootFolder = ewsIncomingServer.rootFolder;
  ewsIncomingServer.performExpand(null);
  const ewsSourceFolder = await TestUtils.waitForCondition(
    () => ewsRootFolder.getChildNamed("copyToAnotherServer"),
    "waiting for test folder to exist"
  );
  await syncFolder(ewsIncomingServer, ewsSourceFolder);
  Assert.equal(
    ewsSourceFolder.getTotalMessages(false),
    10,
    "ewsSourceFolder should start with 10 messages"
  );
  const ewsHeaders = [...ewsSourceFolder.messages];

  const localAccount = MailServices.accounts.createLocalMailAccount();
  const localRootFolder = localAccount.incomingServer.rootFolder;
  localRootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  const localDestFolder = localRootFolder.createLocalSubfolder(
    "copyFromAnotherServer"
  );

  await copyItems(
    ewsSourceFolder,
    localDestFolder,
    ewsHeaders.slice(5, 7),
    false
  );

  Assert.equal(
    localDestFolder.getTotalMessages(false),
    2,
    "localDestFolder should contain the copied messages"
  );
  Assert.equal(
    ewsSourceFolder.getTotalMessages(false),
    10,
    "ewsSourceFolder should still have the copied messages"
  );

  await copyItems(
    ewsSourceFolder,
    localDestFolder,
    ewsHeaders.slice(1, 2),
    true
  );

  Assert.equal(
    localDestFolder.getTotalMessages(false),
    3,
    "localDestFolder should contain the moved message"
  );
  // This should have happened already. But move operations typically call
  // DeleteMessages without waiting for it to happen.
  await TestUtils.waitForCondition(
    () => ewsSourceFolder.getTotalMessages(false) == 9,
    "waiting for ewsSourceFolder to delete the moved message"
  );
  Assert.equal(
    ewsSourceFolder.getTotalMessages(false),
    9,
    "ewsSourceFolder should not still have the moved message"
  );

  Assert.throws(
    () =>
      MailServices.copy.copyMessages(
        ewsSourceFolder,
        [undefined],
        localDestFolder,
        true, // isMove
        null, // listener
        null, // msgWindow
        false // allowUndo
      ),
    /NS_ERROR_ILLEGAL_VALUE/,
    "moving an undefined message should throw"
  );

  MailServices.accounts.removeAccount(localAccount, false);

  ewsServer.clearItems();
});

add_task(async function test_copy_file_message() {
  ewsServer.appendRemoteFolder(new RemoteFolder("copyFileMessage", "root"));

  const rootFolder = ewsIncomingServer.rootFolder;
  ewsIncomingServer.performExpand(null);
  const folder = await TestUtils.waitForCondition(
    () => rootFolder.getChildNamed("copyFileMessage"),
    "waiting for test folder to exist"
  );

  // Copy the message.

  const copyListener = new PromiseTestUtils.PromiseCopyListener();
  MailServices.copy.copyFileMessage(
    do_get_file("../../../../test/data/bugmail11"),
    folder,
    null,
    false,
    0, // message flags
    "$label4", // keywords
    copyListener,
    null // window
  );
  const copied = await copyListener.promise;

  // Check the copied message.

  const header = folder.GetMessageHeader(copied.messageKeys[0]);
  Assert.equal(
    header.messageId,
    "200804111417.m3BEHTk4030129@mrapp51.mozilla.org",
    "copied message's Message-ID is set from the message"
  );
  Assert.ok(
    header.getStringProperty("ewsId"),
    "copied message should have been assigned an EWS ID"
  );
  Assert.ok(
    header.storeToken,
    "copied message should have been stored on disk"
  );
  Assert.equal(
    header.getStringProperty("keywords"),
    "$label4",
    "keywords should have been set in the database"
  );

  // Check the message is on the server;

  const serverMessage = ewsServer.getItem(header.getStringProperty("ewsId"));
  Assert.ok(serverMessage);
  Assert.equal(serverMessage.parentId, "copyFileMessage");
});

async function runMarkAsReadTest(mockServer, incomingServer) {
  const folderName = `mark_read_${incomingServer.type}`;
  mockServer.appendRemoteFolder(new RemoteFolder(folderName, "root"));

  const syntheticMessages = generator.makeMessages({ count: 3 });
  mockServer.addMessages(folderName, syntheticMessages);

  const rootFolder = incomingServer.rootFolder;
  incomingServer.getNewMessages(rootFolder, null, null);

  const folder = await TestUtils.waitForCondition(
    () => rootFolder.getChildNamed(folderName),
    "waiting for folder to exist"
  );
  await TestUtils.waitForCondition(
    () => folder.getTotalMessages(false) == 3,
    "waiting for messages to exist"
  );

  Assert.equal(
    folder.getNumUnread(false),
    3,
    "all messages should be unread at the start"
  );
  const messages = [...folder.messages];

  const serverMessage0 = mockServer.getItem(syntheticMessages[0].messageId);
  Assert.ok(!serverMessage0.syntheticMessage.metaState.read);
  const serverMessage1 = mockServer.getItem(syntheticMessages[1].messageId);
  Assert.ok(!serverMessage1.syntheticMessage.metaState.read);
  const serverMessage2 = mockServer.getItem(syntheticMessages[2].messageId);
  Assert.ok(!serverMessage2.syntheticMessage.metaState.read);

  // Mark some messages as read.

  folder.markMessagesRead([messages[0], messages[2]], true);

  await TestUtils.waitForCondition(
    () => serverMessage0.syntheticMessage.metaState.read,
    "waiting for message 0 to be marked as read on the server"
  );
  await TestUtils.waitForCondition(
    () => folder.getNumUnread(false) == 1,
    "waiting for two of three messages to be marked as read"
  );
  Assert.ok(
    !serverMessage1.syntheticMessage.metaState.read,
    "message 1 should still be marked as unread on the server"
  );
  Assert.ok(
    serverMessage2.syntheticMessage.metaState.read,
    "message 2 should be marked as read on the server"
  );

  // Mark a message as unread.

  folder.markMessagesRead([messages[2]], false);
  await TestUtils.waitForCondition(
    () => !serverMessage2.syntheticMessage.metaState.read,
    "waiting for message 2 to be marked as unread on the server"
  );

  await TestUtils.waitForCondition(
    () => folder.getNumUnread(false) == 2,
    "waiting for message 2 to be marked as unread locally"
  );
  Assert.ok(
    !serverMessage1.syntheticMessage.metaState.read,
    "message 1 should still be marked as unread on the server"
  );
  Assert.ok(
    serverMessage0.syntheticMessage.metaState.read,
    "message 0 should still be marked as read on the server"
  );
}

add_task(async function test_mark_as_read_ews() {
  await runMarkAsReadTest(ewsServer, ewsIncomingServer);
});

add_task(async function test_mark_as_read_graph() {
  await runMarkAsReadTest(graphServer, graphIncomingServer);
});

/**
 * Tests that a read status change for a message which is no longer in the
 * database doesn't abort the sync, and that the changes following it are still
 * applied.
 */
add_task(async function test_read_status_change_for_missing_message_ews() {
  const folderName = "read_status_missing_ews";
  ewsServer.appendRemoteFolder(new RemoteFolder(folderName, "root"));
  const [existingMessage] = generator.makeMessages({ count: 1 });
  ewsServer.addMessages(folderName, [existingMessage]);

  const rootFolder = ewsIncomingServer.rootFolder;
  await syncFolder(ewsIncomingServer, rootFolder);
  const folder = rootFolder.getChildNamed(folderName);
  await syncFolder(ewsIncomingServer, folder);

  const header = [...folder.messages][0];
  Assert.equal(
    header.subject,
    existingMessage.subject,
    "the message should have been synced"
  );

  // Drop the message from the database without telling the server about it,
  // then have the server report a read status change for it, followed by the
  // creation of a new message so that both land in the same batch of changes.
  const ewsId = header.getStringProperty(ewsIdPropertyName);
  folder.msgDatabase.deleteMessages([header.messageKey], null);

  ewsServer.itemChanges.push(["readflag", folderName, ewsId]);
  const [newMessage] = generator.makeMessages({ count: 1 });
  ewsServer.addMessages(folderName, [newMessage]);

  await syncFolder(ewsIncomingServer, folder);

  Assert.deepEqual(
    [...folder.messages].map(message => message.subject),
    [newMessage.subject],
    "the message created after the read status change should have been synced"
  );
});

/**
 * Set up the structure required for the folder copy/move tests.
 *
 * This creates `<prefix>_parent1` and `<prefix>_parent2` in the root folder,
 * and `<prefix>_child` inside of `<prefix>_parent1`. Returns a tuple containing
 * the first parent folder, the second parent folder, and the child folder in
 * that order.
 *
 * @param {string} prefix
 * @param {MockServer} mockServer
 * @param {nsIIncomingServer} incomingServer
 * @returns {[nsIMsgFolder, nsIMsgFolder, nsIMsgFolder]}
 */
async function setup_folder_copymove_structure(
  prefix,
  mockServer,
  incomingServer
) {
  const parent1Name = `${prefix}_parent1`;
  const parent2Name = `${prefix}_parent2`;
  const childName = `${prefix}_child`;

  mockServer.appendRemoteFolder(
    new RemoteFolder(parent1Name, "root", parent1Name, parent1Name)
  );
  mockServer.appendRemoteFolder(
    new RemoteFolder(parent2Name, "root", parent2Name, parent2Name)
  );
  mockServer.appendRemoteFolder(
    new RemoteFolder(childName, parent1Name, childName, childName)
  );

  const rootFolder = incomingServer.rootFolder;

  await syncFolder(incomingServer, rootFolder);

  const parent1 = rootFolder.getChildNamed(parent1Name);
  Assert.ok(!!parent1, `${parent1Name} should exist.`);
  const parent2 = rootFolder.getChildNamed(parent2Name);
  Assert.ok(!!parent2, `${parent2Name} should exist.`);

  await syncFolder(incomingServer, parent1);

  const child = parent1.getChildNamed(childName);
  Assert.ok(!!child, `${childName} should exist in ${parent1Name}`);

  return [parent1, parent2, child];
}

async function runMoveFolderTest(mockServer, incomingServer) {
  const [parent1, parent2, child] = await setup_folder_copymove_structure(
    "folder_move",
    mockServer,
    incomingServer
  );

  let starts = 0;
  const stops = [];
  const listener = new PromiseTestUtils.PromiseCopyListener({
    onStartCopy() {
      starts++;
    },
    onStopCopy(status) {
      stops.push(status);
    },
  });
  MailServices.copy.copyFolder(child, parent2, true, listener, null);
  await listener.promise;
  Assert.equal(starts, 1, "The folder operation starts once");
  Assert.deepEqual(stops, [Cr.NS_OK], "The folder operation completes once");

  Assert.ok(
    !parent1.getChildNamed(child.name),
    `${child.name} should not exist in ${parent1.name}`
  );
  Assert.ok(
    !!parent2.getChildNamed(child.name),
    `${child.name} should exist in ${parent2.name}`
  );
}

add_task(async function test_move_folder_ews() {
  await runMoveFolderTest(ewsServer, ewsIncomingServer);
});

add_task(async function test_move_folder_graph() {
  await runMoveFolderTest(graphServer, graphIncomingServer);
});

async function runCopyFolderTest(mockServer, incomingServer) {
  const [parent1, parent2, child] = await setup_folder_copymove_structure(
    "folder_copy",
    mockServer,
    incomingServer
  );

  let starts = 0;
  const stops = [];
  const listener = new PromiseTestUtils.PromiseCopyListener({
    onStartCopy() {
      starts++;
    },
    onStopCopy(status) {
      stops.push(status);
    },
  });
  MailServices.copy.copyFolder(child, parent2, false, listener, null);
  await listener.promise;
  Assert.equal(starts, 1, "The folder operation starts once");
  Assert.deepEqual(stops, [Cr.NS_OK], "The folder operation completes once");

  Assert.ok(
    !!parent1.getChildNamed(child.name),
    `${child.name} should exist in ${parent1.name}`
  );
  Assert.ok(
    !!parent2.getChildNamed(child.name),
    `${child.name} should exist in ${parent2.name}`
  );
}

add_task(async function test_copy_folder_ews() {
  await runCopyFolderTest(ewsServer, ewsIncomingServer);
});

add_task(async function test_copy_folder_graph() {
  await runCopyFolderTest(graphServer, graphIncomingServer);
});

add_task(async function test_mark_as_junk_ews() {
  await runMarkAsJunkTest(ewsServer, ewsIncomingServer);
});

add_task(async function test_mark_as_junk_graph() {
  await runMarkAsJunkTest(graphServer, graphIncomingServer);
});

/**
 * Tests mark as junk/unjunk for both EWS and Graph protocols.
 *
 * @param {MockServer} mockServer - The `MockServer` child class instance to use
 *   for creating folders and messages.
 * @param {nsIMsgIncomingServer} incomingServer - The incoming message server for
 *   the protocol being tested.
 */
async function runMarkAsJunkTest(mockServer, incomingServer) {
  const rootFolder = incomingServer.rootFolder;
  await syncFolder(incomingServer, rootFolder);

  // Add messages to the test folder.
  const junkMessages = generator.makeMessages({ count: 2 });
  mockServer.addItemToFolder("junk_message_1", "inbox", junkMessages[0]);
  mockServer.addItemToFolder("junk_message_2", "inbox", junkMessages[1]);

  const inboxFolder = rootFolder.getChildNamed("Inbox");
  Assert.ok(!!inboxFolder, `Inbox folder should exist`);
  const junkFolder = rootFolder.getChildNamed("Junk");
  Assert.ok(!!junkFolder, "Junk folder should exist");

  await syncFolder(incomingServer, inboxFolder);
  await syncFolder(incomingServer, junkFolder);

  Assert.equal(
    inboxFolder.getTotalMessages(false),
    2,
    "Should start with two messages."
  );

  // As per the EWS documentation, unmarking a message as junk can only move
  // that message back to the inbox, so we cannot use a dedicated folder to test
  // this. This means we need to make sure we clean up any leftover messages in
  // the inbox folder to avoid any side-effect.
  registerCleanupFunction(async () => {
    const messages = [...inboxFolder.messages];
    const eventPromise = PromiseTestUtils.promiseFolderEvent(
      inboxFolder,
      "DeleteOrMoveMsgCompleted"
    );
    inboxFolder.deleteMessages(messages, null, true, false, null, false);
    await eventPromise;
  });

  const junkMessageKeys = [...inboxFolder.messages].map(
    header => header.messageKey
  );
  Assert.equal(
    junkMessageKeys.length,
    2,
    "Should have found two messages to mark as junk in the test folder."
  );

  const junkListener = new PromiseTestUtils.PromiseCopyListener();
  inboxFolder.handleViewCommand(
    Ci.nsMsgViewCommandType.junk,
    junkMessageKeys,
    null,
    junkListener
  );
  await junkListener.promise;

  Assert.equal(
    [...inboxFolder.messages].length,
    0,
    "Should be no messages in the test folder."
  );

  Assert.equal(
    [...junkFolder.messages].length,
    2,
    "Should have two messages in the Junk folder."
  );

  // Unjunk the first message and make sure it moved back to the inbox.
  const newMessageKeys = [...junkFolder.messages].map(m => m.messageKey);
  const unjunkListener = new PromiseTestUtils.PromiseCopyListener();
  junkFolder.handleViewCommand(
    Ci.nsMsgViewCommandType.unjunk,
    [newMessageKeys[0]],
    null,
    unjunkListener
  );
  await unjunkListener.promise;
  await syncFolder(incomingServer, inboxFolder);

  Assert.equal(
    [...inboxFolder.messages].length,
    1,
    "Should be one unjunked message in the test folder."
  );
  Assert.equal(
    [...junkFolder.messages].length,
    1,
    "Should still be one junked message in junk folder."
  );
}

async function runChangeFlagStatusTest(mockServer, incomingServer) {
  const folderName = `change_flag_status_${incomingServer.type}`;
  mockServer.appendRemoteFolder(
    new RemoteFolder(folderName, "root", folderName, folderName)
  );

  const rootFolder = incomingServer.rootFolder;
  await syncFolder(incomingServer, rootFolder);

  const folder = rootFolder.getChildNamed(folderName);
  Assert.ok(!!folder, `${folderName} folder should exist.`);

  // Add messages to the folder.
  const message = generator.makeMessages({ count: 1 })[0];
  mockServer.addItemToFolder("message", folderName, message);

  await syncFolder(incomingServer, folder);

  // Get the message header.
  const messageHeaders = [...folder.messages];
  Assert.equal(messageHeaders.length, 1, "Should have one message to flag.");
  const messageHeader = messageHeaders[0];

  const serverItem = mockServer.getItemInfo("message");
  Assert.ok(!!serverItem, "Message should exist on server.");
  const serverMessage = serverItem.syntheticMessage;
  Assert.ok(!!serverMessage, "Synthetic message should exist.");

  // Flag the message.
  folder.markMessagesFlagged([messageHeader], true);
  await TestUtils.waitForCondition(
    () => serverMessage.metaState.flagged,
    "Waiting for message to be flagged."
  );

  // Unflag the message.
  folder.markMessagesFlagged([messageHeader], false);
  await TestUtils.waitForCondition(
    () => !serverMessage.metaState.flagged,
    "Waiting for message to be unflagged."
  );
}

add_task(async function test_flag_item_ews() {
  await runChangeFlagStatusTest(ewsServer, ewsIncomingServer);
});

add_task(async function test_flag_item_graph() {
  await runChangeFlagStatusTest(graphServer, graphIncomingServer);
});

async function runHardDeleteTest(mockServer, incomingServer) {
  const folderName = `hard_delete_${incomingServer.type}`;
  mockServer.appendRemoteFolder(
    new RemoteFolder(folderName, "root", folderName, folderName)
  );

  const rootFolder = incomingServer.rootFolder;
  await syncFolder(incomingServer, rootFolder);

  const folder = rootFolder.getChildNamed(folderName);
  Assert.ok(!!folder, `${folderName} folder should exist.`);

  const message = generator.makeMessages({ count: 1 })[0];
  mockServer.addItemToFolder("message_to_delete", folderName, message);

  await syncFolder(incomingServer, folder);

  const messageHeaders = [...folder.messages];
  Assert.equal(
    messageHeaders.length,
    1,
    "Should be one message to delete in the inbox."
  );

  const eventPromise = PromiseTestUtils.promiseFolderEvent(
    folder,
    "DeleteOrMoveMsgCompleted"
  );
  folder.deleteMessages([messageHeaders[0]], null, true, false, null, false);
  await eventPromise;

  // Message should no longer be in the inbox.
  const matchingMessages = [...folder.messages];
  Assert.equal(matchingMessages.length, 0, "Message should have been deleted.");
}

add_task(async function test_hard_delete_item_ews() {
  await runHardDeleteTest(ewsServer, ewsIncomingServer);
});

add_task(async function test_hard_delete_item_graph() {
  await runHardDeleteTest(graphServer, graphIncomingServer);
});

/**
 * Run a test for deleting items from the trash for the given mock/incoming
 * server combo.
 *
 * @param {MockServer} mockServer
 * @param {nsIMsgIncomingServer} incomingServer
 */
async function runDeleteItemFromTrashTest(mockServer, incomingServer) {
  const rootFolder = incomingServer.rootFolder;
  await syncFolder(incomingServer, rootFolder);

  const trashFolder = rootFolder.getChildNamed("Deleted Items");
  Assert.ok(!!trashFolder, "Trash folder should exist.");

  const messages = generator.makeMessages({ count: 1 });
  const messageId = "delete_from_trash";
  mockServer.addItemToFolder(messageId, "deleteditems", messages[0]);

  await syncFolder(incomingServer, trashFolder);

  Assert.equal(
    trashFolder.getTotalMessages(false),
    1,
    "Should be one message in trash"
  );

  const trashFolderMessage = [...trashFolder.messages][0];

  const eventPromise = PromiseTestUtils.promiseFolderEvent(
    trashFolder,
    "DeleteOrMoveMsgCompleted"
  );
  trashFolder.deleteMessages(
    [trashFolderMessage],
    null,
    false,
    false,
    null,
    false
  );
  await eventPromise;

  Assert.equal(
    trashFolder.getTotalMessages(false),
    0,
    "Should be zero messages in trash"
  );
}

add_task(async function test_delete_item_from_trash_ews() {
  await runDeleteItemFromTrashTest(ewsServer, ewsIncomingServer);
});

add_task(async function test_delete_item_from_trash_graph() {
  await runDeleteItemFromTrashTest(graphServer, graphIncomingServer);
});

add_task(async function testCrossAccountMoveFailureEws() {
  await subtestCrossAccountMoveFailure(
    ewsServer,
    ewsIncomingServer,
    graphServer,
    graphIncomingServer
  );
});

/**
 * Keep the source after a failed fetch, then retry into another account.
 *
 * @param {MockServer} sourceServer - The source protocol fixture.
 * @param {nsIMsgIncomingServer} sourceAccount - The source account server.
 * @param {MockServer} destinationServer - The destination protocol fixture.
 * @param {nsIMsgIncomingServer} destinationAccount - The destination server.
 * @returns {Promise<void>} Resolves after failure and retry finish.
 */
async function subtestCrossAccountMoveFailure(
  sourceServer,
  sourceAccount,
  destinationServer,
  destinationAccount
) {
  const [source, , messages] = await setup_item_copymove_structure(
    "failed_cross_account_source",
    sourceServer,
    sourceAccount
  );
  const [, destination] = await setup_item_copymove_structure(
    "failed_cross_account_destination",
    destinationServer,
    destinationAccount
  );
  const sourceId = `${sourceAccount.type}_failed_cross_account_source_a`;
  const header = [...source.messages].find(
    item => item.getStringProperty(ewsIdPropertyName) == sourceId
  );
  Assert.ok(header, "The source item is stored locally");
  const key = header.messageKey;
  Assert.ok(!source.hasMsgOffline(key), "The source must be fetched remotely");
  const remoteItem = sourceServer.getItemInfo(sourceId);
  remoteItem.syntheticMessage = null;

  const notifications = [];
  const listener = {
    msgsMoveCopyCompleted(isMove, headers, target) {
      if (target.URI == destination.URI) {
        notifications.push({ isMove, count: headers.length });
      }
    },
  };
  MailServices.mfn.addListener(
    listener,
    MailServices.mfn.msgsMoveCopyCompleted
  );
  try {
    const copyListener = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyMessages(
      source,
      [header],
      destination,
      true,
      copyListener,
      null,
      false
    );
    await Assert.rejects(
      copyListener.promise,
      new RegExp(Cr.NS_ERROR_UNEXPECTED),
      "Missing MIME content fails the move"
    );
    Assert.ok(
      source.msgDatabase.containsKey(key),
      "Failure retains the source"
    );
    Assert.equal(
      destination.getTotalMessages(false),
      0,
      "No copy is published"
    );
    Assert.equal(
      notifications.length,
      0,
      "Failure emits no completed-copy event"
    );

    remoteItem.syntheticMessage = messages[0];
    await copyItems(source, destination, [header], true);
    Assert.deepEqual(notifications, [{ isMove: true, count: 1 }]);
    Assert.ok(
      !source.msgDatabase.containsKey(key),
      "Successful retry moves it"
    );
    const copied = [...destination.messages][0];
    Assert.ok(copied, "The retry creates its destination header");
    const remoteId = copied.getStringProperty(ewsIdPropertyName);
    const destinationItem = destinationServer.getItemInfo(remoteId);
    Assert.ok(destinationItem, "The destination ID resolves on its own server");
    Assert.equal(
      destinationItem.parentId,
      destination.getStringProperty("ewsId"),
      "The destination binding names the created remote item"
    );
  } finally {
    remoteItem.syntheticMessage = messages[0];
    MailServices.mfn.removeListener(listener);
  }
}

add_task(async function testHardDeleteStoppedClientEws() {
  const [mockServer, incomingServer] = setupBasicEwsTestServer({
    username: "stopped-delete-ews",
  });
  await testHardDeleteStoppedClient(mockServer, incomingServer);
});

add_task(async function testHardDeleteStoppedClientGraph() {
  const [mockServer, incomingServer] = setupBasicGraphTestServer({
    username: "stopped-delete-graph",
  });
  await testHardDeleteStoppedClient(mockServer, incomingServer);
});

/**
 * Complete a failed hard deletion without changing the local message.
 *
 * @param {MockServer} mockServer - The protocol fixture.
 * @param {nsIMsgIncomingServer} incomingServer - The account to shut down.
 * @returns {Promise<void>} Resolves when the failed deletion is reported.
 */
async function testHardDeleteStoppedClient(mockServer, incomingServer) {
  const [folder] = await setup_item_copymove_structure(
    "stopped_delete",
    mockServer,
    incomingServer
  );
  const header = [...folder.messages][0];
  const key = header.messageKey;
  const serverId = header.getStringProperty(ewsIdPropertyName);
  const flags = header.flags;
  const storeToken = header.storeToken;

  incomingServer.shutdown();
  await TestUtils.waitForCondition(
    () => !incomingServer.protocolClientRunning,
    "Waiting for the protocol client to stop"
  );

  const events = [];
  const folderListener = {
    onFolderEvent(eventFolder, event) {
      if (eventFolder.URI == folder.URI) {
        events.push(event);
      }
    },
  };
  MailServices.mailSession.AddFolderListener(
    folderListener,
    Ci.nsIFolderListener.event
  );
  let starts = 0;
  const stops = [];
  const listener = new PromiseTestUtils.PromiseCopyListener({
    onStartCopy() {
      starts++;
    },
    onStopCopy(status) {
      stops.push(status);
    },
  });
  try {
    folder.deleteMessages([header], null, true, false, listener, false);
    await Assert.rejects(
      listener.promise,
      new RegExp(Cr.NS_ERROR_UNEXPECTED),
      "The stopped queue reports its original error"
    );
    Assert.equal(starts, 1, "Deletion starts the listener once");
    Assert.deepEqual(stops, [Cr.NS_ERROR_UNEXPECTED], "Deletion stops once");
    Assert.deepEqual(events, ["DeleteOrMoveMsgFailed"]);
    const retained = folder.GetMessageHeader(key);
    Assert.equal(retained.getStringProperty(ewsIdPropertyName), serverId);
    Assert.equal(retained.flags, flags, "Failure preserves message state");
    Assert.equal(retained.storeToken, storeToken);
    Assert.equal(folder.getTotalMessages(false), 2);
    Assert.ok(mockServer.getItemInfo(serverId), "The server item remains");
  } finally {
    MailServices.mailSession.RemoveFolderListener(folderListener);
  }
}

add_task(async function testCrossAccountMoveWaitsForDeleteEws() {
  await testCrossAccountMoveWaitsForDelete(
    ewsServer,
    ewsIncomingServer,
    graphServer,
    graphIncomingServer
  );
});

add_task(async function testCrossAccountMoveWaitsForDeleteGraph() {
  await testCrossAccountMoveWaitsForDelete(
    graphServer,
    graphIncomingServer,
    ewsServer,
    ewsIncomingServer
  );
});

/**
 * Report a move only after remote and local source deletion have completed.
 *
 * @param {MockServer} sourceServer - The source protocol fixture.
 * @param {nsIMsgIncomingServer} sourceAccount - The source account server.
 * @param {MockServer} destinationServer - The destination protocol fixture.
 * @param {nsIMsgIncomingServer} destinationAccount - The destination server.
 * @returns {Promise<void>} Resolves after the two-message move finishes.
 */
async function testCrossAccountMoveWaitsForDelete(
  sourceServer,
  sourceAccount,
  destinationServer,
  destinationAccount
) {
  const [source] = await setup_item_copymove_structure(
    "confirmed_move_source",
    sourceServer,
    sourceAccount
  );
  const [, destination] = await setup_item_copymove_structure(
    "confirmed_move_destination",
    destinationServer,
    destinationAccount
  );
  const headers = [...source.messages];
  const keys = headers.map(header => header.messageKey);
  const ids = headers.map(header =>
    header.getStringProperty(ewsIdPropertyName)
  );
  const originals = new Map(
    headers.map(header => [
      header.messageId,
      {
        isRead: header.isRead,
        isFlagged: header.isFlagged,
        body: sourceServer
          .getItemInfo(header.getStringProperty(ewsIdPropertyName))
          .syntheticMessage.toMessageString(),
      },
    ])
  );
  const stops = [];
  const listener = new PromiseTestUtils.PromiseCopyListener({
    onStopCopy(status) {
      stops.push({
        status,
        local: keys.map(key => source.msgDatabase.containsKey(key)),
        remote: ids.map(id => !!sourceServer.getItemInfo(id)),
      });
    },
  });
  MailServices.copy.copyMessages(
    source,
    headers,
    destination,
    true,
    listener,
    null,
    false
  );
  await listener.promise;
  Assert.deepEqual(
    stops,
    [
      {
        status: Cr.NS_OK,
        local: [false, false],
        remote: [false, false],
      },
    ],
    "Completion observes confirmed source deletion and occurs once"
  );
  const moved = [...destination.messages];
  Assert.equal(moved.length, headers.length);
  for (const header of moved) {
    Assert.equal(header.folder.URI, destination.URI);
    const original = originals.get(header.messageId);
    Assert.ok(original, "The destination retains the logical message identity");
    Assert.equal(header.isRead, original.isRead);
    Assert.equal(header.isFlagged, original.isFlagged);
    const remote = destinationServer.getItemInfo(
      header.getStringProperty(ewsIdPropertyName)
    );
    Assert.ok(remote, "The new server identity resolves at the destination");
    Assert.equal(remote.parentId, destination.getStringProperty("ewsId"));
    Assert.ok(destination.hasMsgOffline(header.messageKey));
    const body = new PromiseTestUtils.PromiseStreamListener();
    MailServices.messageServiceFromURI(
      destination.getUriForMsg(header)
    ).streamMessage(
      destination.getUriForMsg(header),
      body,
      null,
      null,
      false,
      "",
      true
    );
    Assert.equal(await body.promise, original.body);
  }
}

add_task(async function testCrossAccountMoveDeleteFailureEws() {
  const { HTTP_404 } = ChromeUtils.importESModule(
    "resource://testing-common/httpd.sys.mjs"
  );
  const [source] = await setup_item_copymove_structure(
    "delete_failure_source",
    ewsServer,
    ewsIncomingServer
  );
  const [, destination] = await setup_item_copymove_structure(
    "delete_failure_destination",
    graphServer,
    graphIncomingServer
  );
  const sourceId = ewsIncomingServer.type + "_delete_failure_source_a";
  const header = [...source.messages].find(
    item => item.getStringProperty(ewsIdPropertyName) == sourceId
  );
  Assert.ok(header);
  const key = header.messageKey;
  const messageId = header.messageId;
  const uri = source.getUriForMsg(header);
  const body = new PromiseTestUtils.PromiseStreamListener();
  MailServices.messageServiceFromURI(uri).streamMessage(
    uri,
    body,
    null,
    null,
    false,
    "",
    false
  );
  const expectedBody = await body.promise;
  Assert.ok(
    source.hasMsgOffline(key),
    "The source can be copied without a fetch"
  );
  const storeToken = header.storeToken;
  const flags = header.flags;
  const completed = [];
  const notificationListener = {
    msgsMoveCopyCompleted(isMove, headers, target) {
      if (target.URI == destination.URI) {
        completed.push(isMove);
      }
    },
  };
  MailServices.mfn.addListener(
    notificationListener,
    MailServices.mfn.msgsMoveCopyCompleted
  );
  const originalDelete = ewsServer.deleteItem;
  const deleteAttempts = [];
  ewsServer.deleteItem = function (id) {
    if (id == sourceId) {
      deleteAttempts.push(id);
      throw HTTP_404;
    }
    return originalDelete.call(this, id);
  };
  try {
    const stops = [];
    const listener = new PromiseTestUtils.PromiseCopyListener({
      onStopCopy(status) {
        stops.push(status);
      },
    });
    MailServices.copy.copyMessages(
      source,
      [header],
      destination,
      true,
      listener,
      null,
      false
    );
    await Assert.rejects(
      listener.promise,
      new RegExp(Cr.NS_ERROR_NET_ERROR_RESPONSE),
      "A failed source deletion fails the move with the original HTTP error"
    );
    Assert.deepEqual(
      deleteAttempts,
      [sourceId],
      "The real source deletion reached the server"
    );
    Assert.deepEqual(stops, [Cr.NS_ERROR_NET_ERROR_RESPONSE]);
    Assert.deepEqual(completed, [], "Failed deletion emits no move success");
    const retained = source.GetMessageHeader(key);
    Assert.equal(retained.messageId, messageId);
    Assert.equal(retained.flags, flags);
    Assert.equal(retained.storeToken, storeToken);
    Assert.ok(source.hasMsgOffline(key));
    Assert.ok(ewsServer.getItemInfo(sourceId), "The remote source remains");
    const copied = [...destination.messages];
    Assert.equal(
      copied.length,
      1,
      "The already-created destination is retained"
    );
    Assert.equal(copied[0].messageId, messageId);
    Assert.ok(graphServer.getItemInfo(copied[0].getStringProperty("ewsId")));
    ewsServer.deleteItem = originalDelete;
    const reread = new PromiseTestUtils.PromiseStreamListener();
    MailServices.messageServiceFromURI(uri).streamMessage(
      uri,
      reread,
      null,
      null,
      false,
      "",
      true
    );
    Assert.equal(await reread.promise, expectedBody);

    const other = [...source.messages].find(item => item.messageKey != key);
    await copyItems(source, destination, [other], false);
    Assert.deepEqual(completed, [false], "The copy queue remains usable");
    Assert.ok(
      source.msgDatabase.containsKey(key),
      "The failed move stays retained"
    );
  } finally {
    ewsServer.deleteItem = originalDelete;
    MailServices.mfn.removeListener(notificationListener);
  }
});

add_task(async function testNextCopyOfflineFailureEws() {
  await testNextCopyOfflineFailure(
    ewsServer,
    ewsIncomingServer,
    graphServer,
    graphIncomingServer
  );
});

add_task(async function testNextCopyOfflineFailureGraph() {
  await testNextCopyOfflineFailure(
    graphServer,
    graphIncomingServer,
    ewsServer,
    ewsIncomingServer
  );
});

/**
 * Finish once if a later message cannot start streaming.
 *
 * @param {MockServer} sourceServer - Source protocol fixture.
 * @param {nsIMsgIncomingServer} sourceAccount - Source account.
 * @param {MockServer} destinationServer - Destination protocol fixture.
 * @param {nsIMsgIncomingServer} destinationAccount - Destination account.
 * @returns {Promise<void>} Resolves after failure and a queued copy retry.
 */
async function testNextCopyOfflineFailure(
  sourceServer,
  sourceAccount,
  destinationServer,
  destinationAccount
) {
  const [source] = await setup_item_copymove_structure(
    "next_copy_offline_source",
    sourceServer,
    sourceAccount
  );
  const [, destination] = await setup_item_copymove_structure(
    "next_copy_offline_destination",
    destinationServer,
    destinationAccount
  );
  const headers = [...source.messages];
  Assert.equal(headers.length, 2);
  Assert.ok(!source.hasMsgOffline(headers[1].messageKey));
  const listener = new PromiseTestUtils.PromiseCopyListener();
  const stops = [];
  const onStopCopy = listener.onStopCopy.bind(listener);
  listener.onStopCopy = status => {
    stops.push(status);
    onStopCopy(status);
  };
  const wasOffline = Services.io.offline;
  let reachedSecond = false;
  listener.onProgress = current => {
    if (current == 2) {
      reachedSecond = true;
      Services.io.offline = true;
    }
  };
  try {
    MailServices.copy.copyMessages(
      source,
      // The copy service groups each folder's messages in reverse input order.
      headers.toReversed(),
      destination,
      false,
      listener,
      null,
      false
    );
    await Assert.rejects(
      listener.promise,
      new RegExp(0x80550014),
      "The later uncached message reports NS_MSG_ERROR_OFFLINE"
    );
  } finally {
    Services.io.offline = wasOffline;
  }

  Assert.ok(reachedSecond, "The first message finished before the failure");
  Assert.deepEqual(
    stops,
    [0x80550014],
    "The copy completes once with its error"
  );
  Assert.equal(destination.getTotalMessages(false), 1);
  for (const header of headers) {
    Assert.ok(source.msgDatabase.containsKey(header.messageKey));
    Assert.ok(sourceServer.getItemInfo(header.getStringProperty("ewsId")));
  }
  const copied = [...destination.messages][0];
  Assert.equal(copied.messageId, headers[0].messageId);
  Assert.ok(destination.hasMsgOffline(copied.messageKey));
  Assert.ok(
    destinationServer.getItemInfo(copied.getStringProperty("ewsId")),
    "The first destination remains published"
  );
  const retry = new PromiseTestUtils.PromiseCopyListener();
  MailServices.copy.copyMessages(
    source,
    [headers[1]],
    destination,
    false,
    retry,
    null,
    false
  );
  await retry.promise;
  Assert.equal(
    destination.getTotalMessages(false),
    2,
    "The copy queue is usable"
  );
  Assert.deepEqual(
    stops,
    [0x80550014],
    "Retry does not complete the old request"
  );
}

add_task(async function testSynchronousSourceDeleteFailureEws() {
  const [source, , messages] = await setup_item_copymove_structure(
    "sync_delete_source",
    ewsServer,
    ewsIncomingServer
  );
  const [, destination] = await setup_item_copymove_structure(
    "sync_delete_destination",
    graphServer,
    graphIncomingServer
  );
  const header = [...source.messages][0];
  const key = header.messageKey;
  const sourceId = header.getStringProperty("ewsId");
  const service = MailServices.messageServiceFromURI(
    source.getUriForMsg(header)
  );
  const body = new PromiseTestUtils.PromiseStreamListener();
  service.streamMessage(
    source.getUriForMsg(header),
    body,
    null,
    null,
    false,
    "",
    false
  );
  const originalBody = await body.promise;
  const originalMessage = messages.find(
    message => message.messageId == header.messageId
  );
  Assert.ok(originalMessage);
  Assert.equal(originalBody, originalMessage.toMessageString());
  const token = header.storeToken;
  const model = ewsIncomingServer.getIntValue("delete_model");
  const listener = new PromiseTestUtils.PromiseCopyListener();
  const stops = [];
  const onStopCopy = listener.onStopCopy.bind(listener);
  listener.onStopCopy = status => {
    stops.push(status);
    onStopCopy(status);
  };
  ewsIncomingServer.setIntValue("delete_model", 2);
  try {
    MailServices.copy.copyMessages(
      source,
      [header],
      destination,
      true,
      listener,
      null,
      false
    );
    await Assert.rejects(
      listener.promise,
      new RegExp(Cr.NS_ERROR_UNEXPECTED),
      "The synchronous source deletion failure reaches the copy listener"
    );
  } finally {
    ewsIncomingServer.setIntValue("delete_model", model);
  }
  Assert.deepEqual(stops, [Cr.NS_ERROR_UNEXPECTED]);
  Assert.ok(
    source.msgDatabase.containsKey(key),
    "The failed move retains source"
  );
  Assert.ok(
    ewsServer.getItemInfo(sourceId),
    "The remote source is not deleted"
  );
  Assert.equal(source.GetMessageHeader(key).storeToken, token);
  Assert.ok(source.hasMsgOffline(key));
  const retained = new PromiseTestUtils.PromiseStreamListener();
  service.streamMessage(
    source.getUriForMsg(header),
    retained,
    null,
    null,
    false,
    "",
    true
  );
  Assert.equal(await retained.promise, originalBody);
  Assert.equal(
    destination.getTotalMessages(false),
    1,
    "The created copy remains"
  );
  const retry = new PromiseTestUtils.PromiseCopyListener();
  MailServices.copy.copyMessages(
    source,
    [header],
    destination,
    false,
    retry,
    null,
    false
  );
  await retry.promise;
  Assert.equal(
    destination.getTotalMessages(false),
    2,
    "The queue advances again"
  );
  Assert.deepEqual(stops, [Cr.NS_ERROR_UNEXPECTED]);
});

add_task(async function testCopyFileKeywordsEws() {
  await testCopyFileKeywords(ewsServer, ewsIncomingServer);
});

add_task(async function testCopyFileKeywordsGraph() {
  await testCopyFileKeywords(graphServer, graphIncomingServer);
});

/**
 * Publish file-copy keywords before notifying database listeners.
 *
 * @param {MockServer} mockServer - Destination protocol fixture.
 * @param {nsIMsgIncomingServer} incomingServer - Destination account.
 * @returns {Promise<void>} Resolves after the file copies.
 */
async function testCopyFileKeywords(mockServer, incomingServer) {
  const name = incomingServer.type + "_copy_file_keywords";
  mockServer.appendRemoteFolder(new RemoteFolder(name, "root", name, name));
  await syncFolder(incomingServer, incomingServer.rootFolder);
  const folder = incomingServer.rootFolder.getChildNamed(name);
  const db = folder.msgDatabase;
  const added = [];
  const dbListener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrAdded(header) {
      added.push({
        key: header.messageKey,
        folderURI: header.folder.URI,
        messageId: header.messageId,
        serverId: header.getStringProperty("ewsId"),
        keywords: header.getStringProperty("keywords"),
        offline: folder.hasMsgOffline(header.messageKey),
        read: header.isRead,
      });
    },
    onHdrFlagsChanged() {},
    onHdrDeleted() {},
    onParentChanged() {},
    onAnnouncerGoingAway() {},
    onReadChanged() {},
    onJunkScoreChanged() {},
    onHdrPropertyChanged() {},
    onEvent() {},
  };
  db.addListener(dbListener);
  try {
    for (const [
      requested,
      expected,
      isDraft,
      flags,
      parsedKeywords = "existing Existing",
    ] of [
      [
        "added existing added CaseTag",
        "existing Existing added CaseTag",
        false,
        Ci.nsMsgMessageFlags.Read,
      ],
      ["", "existing Existing", true, 0],
      ["", "existing Existing", false, 0],
      ["$label4", "$label4", false, 0, " ".repeat(80)],
      [
        "added existing",
        "existing Existing existing added",
        true,
        0,
        "  existing \tExisting   existing  ",
      ],
    ]) {
      const message = generator.makeMessage({
        clobberHeaders: {
          "X-Mozilla-Keys": parsedKeywords,
          "X-Mozilla-Status": Ci.nsMsgMessageFlags.Offline.toString(
            16
          ).padStart(4, "0"),
        },
      });
      const raw = message.toMessageString();
      const file = do_get_tempdir();
      file.append(name + ".eml");
      file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
      try {
        await IOUtils.writeUTF8(file.path, raw);
        const listener = new PromiseTestUtils.PromiseCopyListener();
        const before = added.length;
        MailServices.copy.copyFileMessage(
          file,
          folder,
          null,
          isDraft,
          flags,
          requested,
          listener,
          null
        );
        const copied = await listener.promise;
        Assert.equal(copied.messageKeys.length, 1);
        const header = folder.GetMessageHeader(copied.messageKeys[0]);
        Assert.equal(added.length, before + 1, "One header was published");
        Assert.deepEqual(added[before], {
          key: header.messageKey,
          folderURI: folder.URI,
          messageId: message.messageId,
          serverId: header.getStringProperty("ewsId"),
          keywords: expected,
          offline: false,
          read: !!(flags & Ci.nsMsgMessageFlags.Read),
        });
        Assert.equal(header.getStringProperty("keywords"), expected);
        Assert.equal(
          header.isRead,
          !!(flags & Ci.nsMsgMessageFlags.Read),
          "The requested read state is independent of draft mode"
        );
        Assert.ok(mockServer.getItemInfo(header.getStringProperty("ewsId")));
        Assert.ok(folder.hasMsgOffline(header.messageKey));
        Assert.ok(header.storeToken, "The body has a destination store token");
        const body = new PromiseTestUtils.PromiseStreamListener();
        const uri = folder.getUriForMsg(header);
        MailServices.messageServiceFromURI(uri).streamMessage(
          uri,
          body,
          null,
          null,
          false,
          "",
          true
        );
        Assert.equal(
          await body.promise,
          raw,
          "The stored file body is complete"
        );
      } finally {
        file.remove(false);
      }
    }
  } finally {
    db.removeListener(dbListener);
  }
  Assert.equal(folder.getTotalMessages(false), 5);
}

add_task(async function testMoveDestinationStoreFailureEws() {
  await testMoveDestinationStoreFailure(
    graphServer,
    graphIncomingServer,
    ewsServer,
    ewsIncomingServer
  );
});

add_task(async function testMoveDestinationStoreFailureGraph() {
  await testMoveDestinationStoreFailure(
    ewsServer,
    ewsIncomingServer,
    graphServer,
    graphIncomingServer
  );
});

/**
 * Retain the source if remote creation succeeds but the local store rejects it.
 *
 * @param {MockServer} sourceServer - Source protocol fixture.
 * @param {nsIMsgIncomingServer} sourceAccount - Source account.
 * @param {MockServer} destinationServer - Destination protocol fixture.
 * @param {nsIMsgIncomingServer} destinationAccount - Destination account.
 * @returns {Promise<void>} Resolves after failure and a successful queued retry.
 */
async function testMoveDestinationStoreFailure(
  sourceServer,
  sourceAccount,
  destinationServer,
  destinationAccount
) {
  const [source, , messages] = await setup_item_copymove_structure(
    "destination_store_failure_source",
    sourceServer,
    sourceAccount
  );
  const [, destination] = await setup_item_copymove_structure(
    "destination_store_failure_target",
    destinationServer,
    destinationAccount
  );
  const header = [...source.messages][0];
  const key = header.messageKey;
  const messageId = header.messageId;
  const sourceId = header.getStringProperty("ewsId");
  const uri = source.getUriForMsg(header);
  const service = MailServices.messageServiceFromURI(uri);
  const body = new PromiseTestUtils.PromiseStreamListener();
  service.streamMessage(uri, body, null, null, false, "", false);
  const originalBody = await body.promise;
  Assert.equal(
    originalBody,
    messages.find(message => message.messageId == messageId).toMessageString()
  );
  Assert.ok(source.hasMsgOffline(key));
  const token = header.storeToken;
  const flags = header.flags;
  const db = destination.msgDatabase;
  Assert.equal(destination.getTotalMessages(false), 0);
  const store = destination.msgStore;
  Assert.ok(["mbox", "maildir"].includes(store.storeType));
  const storePath = destination.filePath.clone();
  const backup = storePath.clone();
  backup.leafName += ".store-write-backup";
  Assert.ok(!backup.exists(), "The test owns its unused backup path");
  const hadStore = storePath.exists();
  const completed = [];
  const notificationListener = {
    msgsMoveCopyCompleted(isMove, headers, target) {
      if (target.URI == destination.URI) {
        completed.push(isMove);
      }
    },
  };
  const stops = [];
  const listener = new PromiseTestUtils.PromiseCopyListener({
    onStopCopy(status) {
      stops.push(status);
    },
  });
  MailServices.mfn.addListener(
    notificationListener,
    MailServices.mfn.msgsMoveCopyCompleted
  );
  let obstructed = false;
  let storeError;
  try {
    if (hadStore) {
      storePath.clone().moveTo(backup.parent, backup.leafName);
    }
    try {
      storePath.create(
        store.storeType == "mbox"
          ? Ci.nsIFile.DIRECTORY_TYPE
          : Ci.nsIFile.NORMAL_FILE_TYPE,
        0o700
      );
      obstructed = true;
      let unexpectedStream;
      try {
        unexpectedStream = store.getNewMsgOutputStream(destination);
      } catch (error) {
        storeError = error.result;
      }
      if (unexpectedStream) {
        store.discardNewMessage(destination, unexpectedStream);
      }
      Assert.notEqual(storeError, undefined, "The real store rejects the path");
      Assert.ok(!Components.isSuccessCode(storeError));
      MailServices.copy.copyMessages(
        source,
        [header],
        destination,
        true,
        listener,
        null,
        false
      );
      await Assert.rejects(
        listener.promise,
        new RegExp(storeError),
        "The move reports the original destination-store error"
      );
      Assert.deepEqual(stops, [storeError], "The failed move completes once");
      Assert.deepEqual(completed, [], "The failed write emits no move success");
      const retained = source.GetMessageHeader(key);
      Assert.equal(retained.messageId, messageId);
      Assert.equal(retained.getStringProperty("ewsId"), sourceId);
      Assert.equal(retained.flags, flags);
      Assert.equal(retained.storeToken, token);
      Assert.ok(source.hasMsgOffline(key));
      Assert.ok(
        sourceServer.getItemInfo(sourceId),
        "The remote source remains"
      );
      const partial = [...destination.messages];
      Assert.equal(partial.length, 1, "The already-published header remains");
      Assert.equal(partial[0].messageId, messageId);
      Assert.ok(db.containsKey(partial[0].messageKey));
      Assert.ok(
        destinationServer.getItemInfo(partial[0].getStringProperty("ewsId")),
        "The already-created remote destination remains"
      );
      Assert.ok(
        !destination.hasMsgOffline(partial[0].messageKey),
        "A failed store write does not advertise an offline body"
      );
      Assert.equal(partial[0].storeToken, "");
    } finally {
      if (obstructed) {
        storePath.remove(false);
      }
      if (hadStore) {
        backup.moveTo(storePath.parent, storePath.leafName);
      }
    }

    const reread = new PromiseTestUtils.PromiseStreamListener();
    service.streamMessage(uri, reread, null, null, false, "", true);
    Assert.equal(
      await reread.promise,
      originalBody,
      "The source body is intact"
    );
    await copyItems(source, destination, [header], true);
    Assert.deepEqual(
      completed,
      [true],
      "A successful retry completes the move"
    );
    Assert.deepEqual(
      stops,
      [storeError],
      "The old request is not completed again"
    );
    Assert.ok(!source.msgDatabase.containsKey(key));
    Assert.ok(!sourceServer.getItemInfo(sourceId));
    const copies = [...destination.messages];
    Assert.equal(copies.length, 2, "The failed destination is not rolled back");
    const stored = copies.filter(item =>
      destination.hasMsgOffline(item.messageKey)
    );
    Assert.equal(
      stored.length,
      1,
      "Only the successful retry has an offline body"
    );
    Assert.equal(stored[0].messageId, messageId);
    const copiedBody = new PromiseTestUtils.PromiseStreamListener();
    const copiedUri = destination.getUriForMsg(stored[0]);
    MailServices.messageServiceFromURI(copiedUri).streamMessage(
      copiedUri,
      copiedBody,
      null,
      null,
      false,
      "",
      true
    );
    Assert.equal(await copiedBody.promise, originalBody);
  } finally {
    MailServices.mfn.removeListener(notificationListener);
  }
}

add_task(async function testCopyFileMetadataEws() {
  await testCopyFileMetadata(ewsServer, ewsIncomingServer);
});

add_task(async function testCopyFileMetadataGraph() {
  await testCopyFileMetadata(graphServer, graphIncomingServer);
});

/**
 * Copy local metadata from the supplied header without replacing its identity.
 *
 * @param {MockServer} mockServer - Protocol fixture.
 * @param {nsIMsgIncomingServer} incomingServer - Account holding the source.
 * @returns {Promise<void>} Resolves after copying and rereading both bodies.
 */
async function testCopyFileMetadata(mockServer, incomingServer) {
  const [folder, , messages] = await setup_item_copymove_structure(
    "file_metadata",
    mockServer,
    incomingServer
  );
  const source = [...folder.messages][0];
  const sourceKey = source.messageKey;
  const sourceId = source.getStringProperty("ewsId");
  const message = messages.find(item => item.messageId == source.messageId);
  Assert.ok(message);
  const raw = message.toMessageString();
  source.setStringProperty("fileTemplateNote", "kept locally");
  source.setStringProperty("fileTemplateEmpty", "");
  source.setUint32Property("fileTemplateZero", 0);
  source.setStringProperty("keywords", "source-key");
  Assert.ok(!source.properties.includes("fileTemplateAbsent"));
  const sourceUri = folder.getUriForMsg(source);
  const body = new PromiseTestUtils.PromiseStreamListener();
  MailServices.messageServiceFromURI(sourceUri).streamMessage(
    sourceUri,
    body,
    null,
    null,
    false,
    "",
    false
  );
  Assert.equal(await body.promise, raw);
  const sourceToken = source.storeToken;
  const sourceFlags = source.flags;
  const file = do_get_tempdir();
  file.append(incomingServer.type + "-file-metadata.eml");
  file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
  try {
    await IOUtils.writeUTF8(file.path, raw);
    const listener = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyFileMessage(
      file,
      folder,
      source,
      true,
      0,
      "file-key source-key",
      listener,
      null
    );
    const result = await listener.promise;
    Assert.equal(result.messageKeys.length, 1);
    const copied = folder.GetMessageHeader(result.messageKeys[0]);
    Assert.notEqual(
      copied.messageKey,
      sourceKey,
      "The copy has its own identity"
    );
    Assert.equal(copied.folder.URI, folder.URI);
    Assert.equal(copied.messageId, source.messageId);
    Assert.equal(copied.getStringProperty("fileTemplateNote"), "kept locally");
    Assert.equal(copied.getStringProperty("fileTemplateEmpty"), "");
    Assert.equal(copied.getUint32Property("fileTemplateZero"), 0);
    const properties = copied.properties;
    Assert.ok(properties.includes("fileTemplateEmpty"));
    Assert.ok(properties.includes("fileTemplateZero"));
    Assert.ok(!properties.includes("fileTemplateAbsent"));
    Assert.equal(copied.getStringProperty("keywords"), "source-key file-key");
    const copiedId = copied.getStringProperty("ewsId");
    Assert.notEqual(copiedId, sourceId, "The source server ID is not copied");
    Assert.ok(mockServer.getItemInfo(copiedId));
    Assert.ok(folder.hasMsgOffline(copied.messageKey));
    Assert.ok(copied.storeToken);
    const retained = folder.GetMessageHeader(sourceKey);
    Assert.equal(retained.messageId, source.messageId);
    Assert.equal(retained.getStringProperty("ewsId"), sourceId);
    Assert.equal(retained.getStringProperty("keywords"), "source-key");
    Assert.equal(retained.storeToken, sourceToken);
    Assert.equal(retained.flags, sourceFlags);
    Assert.ok(
      mockServer.getItemInfo(sourceId),
      "The original remote item remains"
    );
    Assert.equal(
      folder.getTotalMessages(false),
      3,
      "The original is not deleted"
    );
    for (const header of [retained, copied]) {
      const stream = new PromiseTestUtils.PromiseStreamListener();
      const uri = folder.getUriForMsg(header);
      MailServices.messageServiceFromURI(uri).streamMessage(
        uri,
        stream,
        null,
        null,
        false,
        "",
        true
      );
      Assert.equal(await stream.promise, raw);
    }
  } finally {
    file.remove(false);
  }
}
add_task(async function test_flagCompletionEws() {
  await testFlagCompletion(ewsServer, ewsIncomingServer);
});

add_task(async function test_flagCompletionGraph() {
  await testFlagCompletion(graphServer, graphIncomingServer);
});

/**
 * Create three real synced messages for flag operations.
 *
 * @param {MockServer} mockServer - The protocol fixture.
 * @param {nsIMsgIncomingServer} incomingServer - The configured account server.
 * @param {string} suffix - The unique folder suffix.
 * @param {boolean} flagged - The initial server flag state.
 * @returns {Promise<{folder: nsIMsgFolder, headers: nsIMsgDBHdr[],
 *   messages: SyntheticMessage[]}>} The synced messages in generator order.
 */
async function createFlagMessages(mockServer, incomingServer, suffix, flagged) {
  const name = incomingServer.type + "_flag_" + suffix;
  mockServer.appendRemoteFolder(new RemoteFolder(name, "root"));
  await syncFolder(incomingServer, incomingServer.rootFolder);
  const folder = incomingServer.rootFolder.getChildNamed(name);
  const messages = generator.makeMessages({ count: 3 });
  for (const [index, message] of messages.entries()) {
    message.metaState.flagged = flagged;
    message.metaState.read = index != 1;
  }
  mockServer.addMessages(name, messages);
  await syncFolder(incomingServer, folder);
  const synced = [...folder.messages];
  Assert.equal(synced.length, messages.length);
  const headers = messages.map(message => {
    const header = synced.find(item => item.messageId == message.messageId);
    Assert.ok(header, "The real header was synced");
    Assert.equal(header.isFlagged, flagged);
    Assert.equal(header.isRead, message.metaState.read);
    Assert.ok(header.getStringProperty(ewsIdPropertyName));
    return header;
  });
  return { folder, headers, messages };
}

/**
 * Report each real flag update once with its acknowledged server identities.
 *
 * @param {MockServer} mockServer - The protocol fixture.
 * @param {nsIMsgIncomingServer} incomingServer - The configured account server.
 * @returns {Promise<void>} Resolves after flagging and unflagging two items.
 */
async function testFlagCompletion(mockServer, incomingServer) {
  const { folder, headers } = await createFlagMessages(
    mockServer,
    incomingServer,
    "completion",
    false
  );
  const server = incomingServer.QueryInterface(Ci.IExchangeIncomingServer);
  const client = server.getProtocolClient();
  const requested = [headers[2], headers[0]].map(header =>
    header.getStringProperty(ewsIdPropertyName)
  );
  const originalFlags = headers.map(header => header.flags);
  const originalKeys = headers.map(header => header.messageKey);
  const originalIds = headers.map(header => header.messageId);
  for (const flagged of [true, false]) {
    const done = Promise.withResolvers();
    const successes = [];
    const failures = [];
    client.changeFlagStatus(
      {
        QueryInterface: ChromeUtils.generateQI([
          "IExchangeSimpleOperationListener",
          "IExchangeFallibleOperationListener",
        ]),
        onOperationSuccess(ids, useLegacyFallback) {
          successes.push({ ids: [...ids], useLegacyFallback });
          done.resolve();
        },
        onOperationFailure(status) {
          failures.push(status);
          done.reject(Components.Exception("Flag operation failed", status));
        },
      },
      requested,
      flagged
    );
    await done.promise;
    await TestUtils.waitForCondition(
      () => server.protocolClientIdle,
      "Waiting for all native flag callbacks to finish"
    );
    Assert.deepEqual(failures, []);
    Assert.equal(successes.length, 1, "The operation reports success once");
    Assert.deepEqual(successes[0].ids.toSorted(), requested.toSorted());
    Assert.ok(!successes[0].useLegacyFallback);
    for (const [index, header] of headers.entries()) {
      const serverId = header.getStringProperty(ewsIdPropertyName);
      const remote = mockServer.getItemInfo(serverId);
      Assert.ok(remote);
      Assert.equal(
        remote.syntheticMessage.metaState.flagged,
        index == 1 ? false : flagged
      );
      Assert.equal(header.messageKey, originalKeys[index]);
      Assert.equal(header.messageId, originalIds[index]);
      Assert.equal(header.folder.URI, folder.URI);
      Assert.equal(
        header.flags,
        originalFlags[index],
        "The protocol operation does not change local headers"
      );
    }
  }
}

add_task(async function test_flaggedHeaderIdentityEws() {
  await testFlaggedHeaderIdentity(ewsServer, ewsIncomingServer);
});

add_task(async function test_flaggedHeaderIdentityGraph() {
  await testFlaggedHeaderIdentity(graphServer, graphIncomingServer);
});

/**
 * Update selected flags without changing cached bodies or unrelated headers.
 *
 * @param {MockServer} mockServer - The protocol fixture.
 * @param {nsIMsgIncomingServer} incomingServer - The configured account server.
 * @returns {Promise<void>} Resolves after two flag changes and cached reads.
 */
async function testFlaggedHeaderIdentity(mockServer, incomingServer) {
  const { folder, headers, messages } = await createFlagMessages(
    mockServer,
    incomingServer,
    "headers",
    false
  );
  const originals = [];
  for (const [index, header] of headers.entries()) {
    const uri = folder.getUriForMsg(header);
    const stream = new PromiseTestUtils.PromiseStreamListener();
    MailServices.messageServiceFromURI(uri).streamMessage(
      uri,
      stream,
      null,
      null,
      false,
      "",
      false
    );
    const raw = await stream.promise;
    Assert.equal(raw, messages[index].toMessageString());
    Assert.ok(folder.hasMsgOffline(header.messageKey));
    Assert.ok(header.storeToken);
    originals.push({
      key: header.messageKey,
      id: header.messageId,
      serverId: header.getStringProperty(ewsIdPropertyName),
      flags: header.flags,
      token: header.storeToken,
      size: header.messageSize,
      offlineSize: header.offlineMessageSize,
      raw,
    });
  }
  Assert.ok(["mbox", "maildir"].includes(folder.msgStore.storeType));
  for (const flagged of [true, false]) {
    folder.markMessagesFlagged([headers[2], headers[0]], flagged);
    await TestUtils.waitForCondition(
      () => headers[0].isFlagged == flagged && headers[2].isFlagged == flagged,
      "Waiting for the acknowledged local flags"
    );
    await TestUtils.waitForCondition(
      () => incomingServer.protocolClientIdle,
      "Waiting for the flag operation to finish"
    );
    Assert.equal(
      folder.getNumUnread(false),
      1,
      "Flag updates keep unread totals"
    );
    for (const [index, old] of originals.entries()) {
      const current = folder.GetMessageHeader(old.key);
      Assert.equal(current.messageKey, old.key);
      Assert.equal(current.messageId, old.id);
      Assert.equal(current.folder.URI, folder.URI);
      Assert.equal(current.getStringProperty(ewsIdPropertyName), old.serverId);
      const expectedFlags =
        flagged && index != 1
          ? old.flags | Ci.nsMsgMessageFlags.Marked
          : old.flags;
      Assert.equal(current.flags, expectedFlags);
      Assert.equal(current.storeToken, old.token);
      Assert.equal(current.messageSize, old.size);
      Assert.equal(current.offlineMessageSize, old.offlineSize);
      Assert.ok(folder.hasMsgOffline(old.key));
      const remote = mockServer.getItemInfo(old.serverId);
      Assert.ok(remote);
      Assert.equal(
        remote.syntheticMessage.metaState.flagged,
        flagged && index != 1
      );
      Assert.equal(
        remote.syntheticMessage.metaState.read,
        messages[index].metaState.read
      );
    }
  }
  for (const [index, header] of headers.entries()) {
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
    Assert.equal(await stream.promise, originals[index].raw);
    Assert.equal(header.storeToken, originals[index].token);
  }
}

add_task(async function test_partialFlaggedIdentityEws() {
  await testPartialFlaggedIdentity(false);
});

add_task(async function test_partialUnflaggedIdentityEws() {
  await testPartialFlaggedIdentity(true);
});

/**
 * Apply only the confirmed flag change when another server item is missing.
 *
 * @param {boolean} initiallyFlagged - The original state of both messages.
 * @returns {Promise<void>} Resolves after the partial update and cached reads.
 */
async function testPartialFlaggedIdentity(initiallyFlagged) {
  const { folder, headers, messages } = await createFlagMessages(
    ewsServer,
    ewsIncomingServer,
    initiallyFlagged ? "partial_unflag" : "partial_flag",
    initiallyFlagged
  );
  const selected = [headers[1], headers[0]];
  const originals = [];
  for (const header of selected) {
    const uri = folder.getUriForMsg(header);
    const stream = new PromiseTestUtils.PromiseStreamListener();
    MailServices.messageServiceFromURI(uri).streamMessage(
      uri,
      stream,
      null,
      null,
      false,
      "",
      false
    );
    const raw = await stream.promise;
    const original = messages.find(
      message => message.messageId == header.messageId
    );
    Assert.ok(original);
    Assert.equal(raw, original.toMessageString());
    Assert.ok(folder.hasMsgOffline(header.messageKey));
    Assert.ok(header.storeToken);
    originals.push({
      key: header.messageKey,
      id: header.messageId,
      serverId: header.getStringProperty(ewsIdPropertyName),
      flags: header.flags,
      token: header.storeToken,
      size: header.messageSize,
      offlineSize: header.offlineMessageSize,
      raw,
    });
  }
  const [missing, live] = originals;
  ewsServer.deleteItem(missing.serverId);
  Assert.equal(ewsServer.getItemInfo(missing.serverId), null);
  const target = !initiallyFlagged;
  folder.markMessagesFlagged(selected, target);
  await TestUtils.waitForCondition(
    () => selected[1].isFlagged == target,
    "Waiting for the successful item in the partial response"
  );
  await TestUtils.waitForCondition(
    () => ewsIncomingServer.protocolClientIdle,
    "Waiting for the partial flag operation to finish"
  );
  const remote = ewsServer.getItemInfo(live.serverId);
  Assert.ok(remote);
  Assert.equal(remote.syntheticMessage.metaState.flagged, target);
  for (const [index, old] of originals.entries()) {
    const retained = folder.GetMessageHeader(old.key);
    let expectedFlags;
    if (index == 0) {
      expectedFlags = old.flags;
    } else {
      expectedFlags = target
        ? old.flags | Ci.nsMsgMessageFlags.Marked
        : old.flags & ~Ci.nsMsgMessageFlags.Marked;
    }
    Assert.equal(retained.messageId, old.id);
    Assert.equal(retained.folder.URI, folder.URI);
    Assert.equal(
      retained.flags,
      expectedFlags,
      "An unacknowledged header keeps its original flags"
    );
    Assert.equal(retained.getStringProperty(ewsIdPropertyName), old.serverId);
    Assert.equal(retained.storeToken, old.token);
    Assert.equal(retained.messageSize, old.size);
    Assert.equal(retained.offlineMessageSize, old.offlineSize);
    Assert.ok(folder.hasMsgOffline(old.key));
    const uri = folder.getUriForMsg(retained);
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
    Assert.equal(await stream.promise, old.raw);
  }
  Assert.equal(
    headers[2].isFlagged,
    initiallyFlagged,
    "The unrequested header is unchanged"
  );
}

/**
 * Move from a real IMAP source, observing destination and deletion failures.
 *
 * @param {MockServer} destinationServer - The Exchange protocol fixture.
 * @param {nsIMsgIncomingServer} destinationAccount - Its incoming server.
 * @param {string} [failure] - Either "create" or "delete" to fail that stage.
 * @returns {Promise<void>} Resolves after the copy listener and identity checks.
 */
async function checkImapSourceMove(
  destinationServer,
  destinationAccount,
  failure = ""
) {
  const name = `imap_source_${destinationAccount.type}_${failure || "success"}`;
  const imap = await ServerTestUtils.createServer({
    type: "imap",
    options: { username: name },
  });
  const incoming = MailServices.accounts.createIncomingServer(
    name,
    "localhost",
    "imap"
  );
  incoming.port = imap.port;
  incoming.password = "password";
  const account = MailServices.accounts.createAccount();
  account.incomingServer = incoming;
  let publicationListener;
  let publicationDatabase;
  let publications = 0;
  const addItem = destinationServer.addItemToFolder;
  try {
    const source = await incoming.rootFolder.createSubfolderAsync(name);
    const contract = Services.prefs.getCharPref(
      "mail.serverDefaultStoreContractID"
    );
    const store = {
      "@mozilla.org/msgstore/berkeleystore;1": "mbox",
      "@mozilla.org/msgstore/maildirstore;1": "maildir",
    }[contract];
    Assert.ok(store);
    Assert.equal(incoming.getStringValue("storeContractID"), contract);
    Assert.equal(source.msgStore.storeType, store);
    Assert.equal(
      destinationAccount.getStringValue("storeContractID"),
      contract
    );
    Assert.equal(destinationAccount.msgStore.storeType, store);
    source.QueryInterface(Ci.nsIMsgImapMailFolder);
    const mailbox = imap.daemon.getMailbox(source.onlineName);
    mailbox.uidnext = 6501;
    const message = generator.makeMessage();
    await imap.addMessages(source, [message]);
    const original = await TestUtils.waitForCondition(
      () => [...source.messages][0],
      "The actual IMAP source header is published"
    );
    const key = original.messageKey;
    Assert.equal(original.messageId, message.messageId);
    if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
      Assert.equal(original.getUint32Property("uidOnServer"), 6501);
      Assert.notEqual(
        key,
        6501,
        "The physical key is independent of the server UID"
      );
      Assert.equal(
        source.msgDatabase.dBFolderInfo.imapUidValidity,
        mailbox.uidvalidity
      );
    } else {
      Assert.equal(key, 6501);
    }
    const download = new PromiseTestUtils.PromiseUrlListener();
    source.downloadAllForOffline(download, null);
    await download.promise;
    Assert.ok(source.hasMsgOffline(key));
    Assert.ok(original.storeToken);
    const sourceUri = source.getUriForMsg(original);
    const sourceBody = new PromiseTestUtils.PromiseStreamListener();
    MailServices.messageServiceFromURI(sourceUri).streamMessage(
      sourceUri,
      sourceBody,
      null,
      null,
      false,
      "",
      false
    );
    const expectedBody = await sourceBody.promise;
    destinationServer.appendRemoteFolder(new RemoteFolder(name, "root"));
    await syncFolder(destinationAccount, destinationAccount.rootFolder);
    const destination = destinationAccount.rootFolder.getChildNamed(name);
    Assert.ok(destination);
    Assert.equal(destination.msgStore.storeType, store);

    if (failure == "create") {
      destinationServer.addItemToFolder = function (id, parentId, ...args) {
        if (parentId == destination.getStringProperty("ewsId")) {
          throw new Error("Destination creation failed");
        }
        return addItem.call(this, id, parentId, ...args);
      };
    } else if (failure == "delete") {
      publicationDatabase = destination.msgDatabase;
      publicationListener = {
        QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
        onHdrAdded(header) {
          Assert.equal(header.folder.URI, destination.URI);
          publications++;
          imap.daemon.commandToFail = "UID";
        },
        onHdrFlagsChanged() {},
        onHdrDeleted() {},
        onParentChanged() {},
        onAnnouncerGoingAway() {},
        onReadChanged() {},
        onJunkScoreChanged() {},
        onHdrPropertyChanged() {},
        onEvent() {},
      };
      publicationDatabase.addListener(publicationListener);
    }
    let starts = 0;
    const stops = [];
    const listener = new PromiseTestUtils.PromiseCopyListener({
      onStartCopy() {
        starts++;
      },
      onStopCopy(status) {
        stops.push(status);
      },
    });
    MailServices.copy.copyMessages(
      source,
      [original],
      destination,
      true,
      listener,
      null,
      false
    );
    // EWS rejects the server's HTTP500 error body during deserialization.
    const error =
      failure == "create"
        ? Cr.NS_ERROR_UNEXPECTED
        : Cr.NS_MSG_ERROR_IMAP_COMMAND_FAILED;
    if (failure) {
      Assert.equal(typeof error, "number", "The native status is defined");
      await Assert.rejects(listener.promise, new RegExp(error));
    } else {
      await listener.promise;
    }
    Assert.equal(publications, failure == "delete" ? 1 : 0);
    Assert.equal(starts, 1);
    Assert.deepEqual(stops, [failure ? error : Cr.NS_OK]);
    const transaction = imap.server.playTransaction();
    const commands = (Array.isArray(transaction) ? transaction : [transaction])
      .flatMap(item => item.them)
      .map(command => command.toUpperCase());
    const deleted = commands.some(
      command => command.includes("UID STORE") && command.includes("\\DELETED")
    );
    Assert.equal(deleted, failure != "create");
    const remoteSource = imap.getMessagesInFolder(source)[0];
    Assert.equal(remoteSource.flags.includes("\\Deleted"), !failure);
    if (failure == "create") {
      Assert.equal(source.GetMessageHeader(key).messageId, message.messageId);
      Assert.equal(destination.getTotalMessages(false), 0);
      Assert.equal(
        destinationServer.getItemsInFolder(
          destination.getStringProperty("ewsId")
        ).length,
        0
      );
      return;
    }
    const copied = [...destination.messages];
    Assert.equal(copied.length, 1);
    Assert.equal(copied[0].messageId, message.messageId);
    Assert.equal(copied[0].folder.URI, destination.URI);
    const remote = destinationServer.getItemInfo(
      copied[0].getStringProperty("ewsId")
    );
    Assert.ok(remote);
    Assert.equal(remote.parentId, destination.getStringProperty("ewsId"));
    Assert.ok(destination.hasMsgOffline(copied[0].messageKey));
    const uri = destination.getUriForMsg(copied[0]);
    const body = new PromiseTestUtils.PromiseStreamListener();
    MailServices.messageServiceFromURI(uri).streamMessage(
      uri,
      body,
      null,
      null,
      false,
      "",
      true
    );
    Assert.equal(await body.promise, expectedBody);
    if (!failure) {
      Assert.equal(source.getTotalMessages(false), 0);
      Assert.ok(!source.msgDatabase.containsKey(key));
    }
  } finally {
    imap.daemon.commandToFail = "";
    destinationServer.addItemToFolder = addItem;
    if (publicationListener) {
      publicationDatabase.removeListener(publicationListener);
    }
    incoming.closeCachedConnections();
    MailServices.accounts.removeAccount(account, false);
  }
}

add_task(async function testImapSourceMoveEws() {
  await checkImapSourceMove(ewsServer, ewsIncomingServer);
});

add_task(async function testImapSourceMoveGraph() {
  await checkImapSourceMove(graphServer, graphIncomingServer);
});

add_task(async function testImapSourceMoveCreateFailureEws() {
  await checkImapSourceMove(ewsServer, ewsIncomingServer, "create");
});

add_task(async function testImapSourceMoveDeleteFailureEws() {
  await checkImapSourceMove(ewsServer, ewsIncomingServer, "delete");
});
