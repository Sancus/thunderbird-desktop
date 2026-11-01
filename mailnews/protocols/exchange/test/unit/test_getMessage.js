/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

var { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);

/**
 * @type {EwsServer}
 */
var ewsServer;
/**
 * @type {nsIMsgIncomingServer}
 */
var incomingEwsServer;
/**
 * @type {GraphServer}
 */
var graphServer;
/**
 * @type {nsIMsgIncomingServer}
 */
var incomingGraphServer;
/**
 * @type {IExchangeClient}
 */
var ewsClient;
/**
 * @type {IExchangeClient}
 */
var graphClient;

add_setup(async () => {
  // Negative protocol cases check callback errors without opening GUI alerts.
  Services.prefs.setBoolPref("mail.suppressAlertsForTests", true);
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref("mail.suppressAlertsForTests")
  );

  [ewsServer, incomingEwsServer] = setupBasicEwsTestServer({});
  [graphServer, incomingGraphServer] = setupBasicGraphTestServer();

  await syncFolder(incomingEwsServer, incomingEwsServer.rootFolder);
  await syncFolder(incomingGraphServer, incomingGraphServer.rootFolder);

  ewsClient = Cc["@mozilla.org/messenger/ews-client;1"].createInstance(
    Ci.IExchangeClient
  );
  ewsClient.initialize(
    incomingEwsServer.getStringValue("ews_url"),
    incomingEwsServer,
    false,
    "",
    "",
    "",
    "",
    ""
  );

  graphClient = Cc["@mozilla.org/messenger/graph-client;1"].createInstance(
    Ci.IExchangeClient
  );
  graphClient.initialize(
    incomingGraphServer.getStringValue("ews_url"),
    incomingGraphServer,
    false,
    "",
    "",
    "",
    "",
    ""
  );
});

add_task(async function test_getEwsMessage() {
  await getMessageTest(ewsServer, ewsClient, incomingEwsServer);
});

add_task(async function test_getGraphMessage() {
  await getMessageTest(graphServer, graphClient, incomingGraphServer);
});

async function getMessageTest(mockServer, client, incomingServer) {
  const generator = new MessageGenerator();
  const messages = generator.makeMessages({ count: 2 });
  mockServer.addMessages("inbox", messages);

  const inboxFolder = incomingServer.rootFolder.getChildNamed("Inbox");

  await syncFolder(incomingServer, inboxFolder);

  Assert.equal(
    inboxFolder.getTotalMessages(false),
    2,
    "Inbox should have two messages."
  );

  for (let i = 0; i < 2; i++) {
    const first = [...inboxFolder.messages][i];
    const listener = new MessageFetchListener();
    client.getMessage(listener, first.getStringProperty("ewsId"));
    const data = await listener.promise;
    Assert.equal(data, messages[i].toMessageString());
  }
}

class MessageFetchListener {
  QueryInterface = ChromeUtils.generateQI(["IExchangeMessageFetchListener"]);

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    this.scriptableStream = Cc[
      "@mozilla.org/scriptableinputstream;1"
    ].createInstance(Ci.nsIScriptableInputStream);
  }

  onFetchStart() {}

  onFetchedDataAvailable(inputStream) {
    const count = inputStream.available();
    this.scriptableStream.init(inputStream);
    this._data = this.scriptableStream.read(count);
  }

  onFetchStop(status) {
    if (status == Cr.NS_OK) {
      this._resolve(this._data);
    } else {
      this._reject(status);
    }
  }
}

add_task(async function test_failedChannelEws() {
  await testFailedChannel(ewsServer, incomingEwsServer);
});

/**
 * Report a failed body fetch through the channel and finish it once.
 *
 * @param {MockServer} mockServer - The protocol fixture.
 * @param {nsIMsgIncomingServer} incomingServer - The configured account server.
 * @returns {Promise<void>} Resolves when the failed request stops.
 */
async function testFailedChannel(mockServer, incomingServer) {
  const folderName = `${incomingServer.type}_failed_channel`;
  mockServer.appendRemoteFolder(
    new RemoteFolder(folderName, "root", folderName, folderName)
  );
  await syncFolder(incomingServer, incomingServer.rootFolder);
  const folder = incomingServer.rootFolder.getChildNamed(folderName);
  const message = new MessageGenerator().makeMessage();
  message.messageId = `${folderName}@made.up.invalid`;
  mockServer.addMessages(folderName, [message]);
  await syncFolder(incomingServer, folder);
  const header = [...folder.messages][0];
  Assert.ok(header, "The message metadata has been synced");
  Assert.ok(!folder.hasMsgOffline(header.messageKey));
  const remoteItem = mockServer.getItemInfo(header.getStringProperty("ewsId"));
  remoteItem.syntheticMessage = null;
  registerCleanupFunction(() => {
    remoteItem.syntheticMessage = message;
  });

  const messageURI = folder.getUriForMsg(header);
  const service = MailServices.messageServiceFromURI(messageURI);
  const channel = Services.io.newChannelFromURI(
    service.getUrlForUri(messageURI),
    null,
    Services.scriptSecurityManager.getSystemPrincipal(),
    null,
    Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
    Ci.nsIContentPolicy.TYPE_OTHER
  );
  const done = Promise.withResolvers();
  let starts = 0;
  let stops = 0;
  channel.asyncOpen({
    QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
    onStartRequest() {
      starts++;
    },
    onDataAvailable() {
      Assert.ok(false, "The missing body must not produce data");
    },
    onStopRequest(request, status) {
      stops++;
      done.resolve(status);
    },
  });
  Assert.ok(channel.isPending(), "The download is pending");
  const status = await done.promise;
  Assert.equal(status, Cr.NS_ERROR_UNEXPECTED, "Missing MIME content fails");
  Assert.equal(channel.status, status, "The channel retains the failure");
  Assert.ok(!channel.isPending(), "The failed request is no longer pending");
  Assert.ok(!channel.canceled, "A fetch failure is not a cancellation");
  Assert.equal(starts, 1, "The listener starts once");
  Assert.equal(stops, 1, "The listener stops once");
  Assert.ok(!folder.hasMsgOffline(header.messageKey), "No body was stored");
}

add_task(async function testLocalOnlyMessageEws() {
  await testLocalOnlyMessage(ewsServer, incomingEwsServer);
});

add_task(async function testLocalOnlyMessageGraph() {
  await testLocalOnlyMessage(graphServer, incomingGraphServer);
});

/**
 * Reject uncached reads without downloading and retain cached offline reads.
 *
 * @param {MockServer} mockServer - The protocol fixture.
 * @param {nsIMsgIncomingServer} incomingServer - The configured account server.
 * @returns {Promise<void>} Resolves after the online and offline reads.
 */
async function testLocalOnlyMessage(mockServer, incomingServer) {
  const folderName = incomingServer.type + "_local_only";
  mockServer.appendRemoteFolder(new RemoteFolder(folderName, "root"));
  await syncFolder(incomingServer, incomingServer.rootFolder);
  const folder = incomingServer.rootFolder.getChildNamed(folderName);
  const generator = new MessageGenerator();
  const messages = [
    generator.makeMessage({
      subject: "Cached message",
      body: { body: "The downloaded body remains available offline.\r\n" },
    }),
    generator.makeMessage({ subject: "Uncached message" }),
  ];
  for (const [index, message] of messages.entries()) {
    message.messageId = `${folderName}-${index}@made.up.invalid`;
  }
  messages[0].metaState.read = true;
  messages[0].metaState.flagged = true;
  mockServer.addMessages(folderName, messages);
  await syncFolder(incomingServer, folder);
  const headers = [...folder.messages];
  Assert.equal(headers.length, 2, "Both message headers have been synced");
  const cached = headers.find(header => header.subject == "Cached message");
  const uncached = headers.find(header => header.subject == "Uncached message");
  Assert.ok(cached && uncached);
  const key = cached.messageKey;
  const messageId = cached.messageId;
  const serverId = cached.getStringProperty("ewsId");
  Assert.ok(!folder.hasMsgOffline(key));
  Assert.ok(!folder.hasMsgOffline(uncached.messageKey));
  Assert.ok(cached.isRead && cached.isFlagged);

  const service = MailServices.messageServiceFromURI(
    folder.getUriForMsg(cached)
  );
  const rejectedListener = {
    QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
    onStartRequest() {
      Assert.ok(false, "A rejected request must not start");
    },
    onDataAvailable() {
      Assert.ok(false, "A rejected request must not produce data");
    },
    onStopRequest() {
      Assert.ok(false, "A rejected request must not stop asynchronously");
    },
  };
  Assert.throws(
    () =>
      service.streamMessage(
        folder.getUriForMsg(cached),
        rejectedListener,
        null,
        null,
        false,
        "",
        true
      ),
    /NS_ERROR_DOCUMENT_NOT_CACHED/,
    "A local-only request rejects an uncached body before downloading"
  );
  Assert.ok(!folder.hasMsgOffline(key));

  const downloaded = new PromiseTestUtils.PromiseStreamListener();
  service.streamMessage(
    folder.getUriForMsg(cached),
    downloaded,
    null,
    null,
    false,
    "",
    false
  );
  Assert.equal(await downloaded.promise, messages[0].toMessageString());
  Assert.ok(folder.hasMsgOffline(key), "The successful fetch stores the body");
  const storeToken = cached.storeToken;
  Assert.ok(storeToken);

  const loadGroup = Cc["@mozilla.org/network/load-group;1"].createInstance(
    Ci.nsILoadGroup
  );
  const groupDone = Promise.withResolvers();
  const groupObserver = {
    flags: [],
    statuses: [],
    QueryInterface: ChromeUtils.generateQI([
      "nsIRequestObserver",
      "nsISupportsWeakReference",
    ]),
    onStartRequest(request) {
      this.flags.push(request.loadFlags);
    },
    onStopRequest(request, status) {
      this.statuses.push(status);
      groupDone.resolve();
    },
  };
  loadGroup.groupObserver = groupObserver;
  const channel = Services.io.newChannelFromURI(
    service.getUrlForUri(folder.getUriForMsg(cached)),
    null,
    Services.scriptSecurityManager.getSystemPrincipal(),
    null,
    Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
    Ci.nsIContentPolicy.TYPE_OTHER
  );
  channel.loadGroup = loadGroup;
  channel.loadFlags |= Ci.nsICachingChannel.LOAD_ONLY_FROM_CACHE;
  const consumerDone = Promise.withResolvers();
  const consumerStops = [];
  let consumerStarts = 0;
  let consumerChunks = 0;
  const discardPref = "mail.discard_offline_msg_on_failure";
  const hadDiscardPref = Services.prefs.prefHasUserValue(discardPref);
  const discardOnFailure = Services.prefs.getBoolPref(discardPref, true);
  Services.prefs.setBoolPref(discardPref, true);
  try {
    channel.asyncOpen({
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
      onStartRequest(request) {
        consumerStarts++;
        Assert.ok(
          request.loadFlags & Ci.nsICachingChannel.LOAD_ONLY_FROM_CACHE
        );
      },
      onDataAvailable() {
        consumerChunks++;
        throw Components.Exception(
          "Destination is full",
          Cr.NS_ERROR_FILE_NO_DEVICE_SPACE
        );
      },
      onStopRequest(request, status) {
        consumerStops.push(status);
        consumerDone.resolve();
      },
    });
    Assert.equal(
      groupObserver.flags.length,
      1,
      "The actual pump joins the load group before asyncOpen returns"
    );
    await Promise.all([consumerDone.promise, groupDone.promise]);
  } finally {
    if (hadDiscardPref) {
      Services.prefs.setBoolPref(discardPref, discardOnFailure);
    } else {
      Services.prefs.clearUserPref(discardPref);
    }
  }
  Assert.equal(consumerStarts, 1);
  Assert.equal(consumerChunks, 1, "The consumer rejects the first body chunk");
  Assert.deepEqual(consumerStops, [Cr.NS_ERROR_FILE_NO_DEVICE_SPACE]);
  Assert.deepEqual(groupObserver.statuses, [Cr.NS_ERROR_FILE_NO_DEVICE_SPACE]);
  Assert.ok(
    groupObserver.flags[0] & Ci.nsICachingChannel.LOAD_ONLY_FROM_CACHE,
    "The pump has the channel flags before it starts"
  );
  Assert.ok(!channel.isPending());
  Assert.equal(
    loadGroup.activeCount,
    0,
    "The failed read leaves the load group"
  );
  loadGroup.groupObserver = null;
  Assert.equal(channel.status, Cr.NS_ERROR_FILE_NO_DEVICE_SPACE);
  Assert.ok(
    folder.hasMsgOffline(key),
    "Consumer failure retains the cached body"
  );
  Assert.equal(folder.GetMessageHeader(key).storeToken, storeToken);
  Assert.equal(folder.GetMessageHeader(key).messageId, messageId);
  Assert.ok(mockServer.getItemInfo(serverId), "The remote source is unchanged");

  const wasOffline = Services.io.offline;
  Services.io.offline = true;
  try {
    const local = new PromiseTestUtils.PromiseStreamListener();
    service.streamMessage(
      folder.getUriForMsg(cached),
      local,
      null,
      null,
      false,
      "",
      true
    );
    Assert.equal(await local.promise, messages[0].toMessageString());
    Assert.throws(
      () =>
        service.streamMessage(
          folder.getUriForMsg(uncached),
          rejectedListener,
          null,
          null,
          false,
          "",
          true
        ),
      /NS_ERROR_DOCUMENT_NOT_CACHED/,
      "Offline local-only reads still reject an uncached body"
    );
    Assert.throws(
      () =>
        service.streamMessage(
          folder.getUriForMsg(uncached),
          rejectedListener,
          null,
          null,
          false,
          "",
          false
        ),
      error => error.result == 0x80550014, // NS_MSG_ERROR_OFFLINE.
      "A normal stream request cannot fetch an uncached body while offline"
    );
    const retained = folder.GetMessageHeader(key);
    Assert.equal(retained.messageId, messageId);
    Assert.equal(retained.getStringProperty("ewsId"), serverId);
    Assert.equal(retained.storeToken, storeToken);
    Assert.ok(retained.isRead && retained.isFlagged, "Reading preserves state");
    Assert.ok(folder.hasMsgOffline(key));
    Assert.ok(!folder.hasMsgOffline(uncached.messageKey));
  } finally {
    Services.io.offline = wasOffline;
  }
}

add_task(async function testMissingMessageClientEws() {
  await testMissingMessageClient(ewsServer, ewsClient, Cr.NS_ERROR_UNEXPECTED);
});

add_task(async function testMissingMessageClientGraph() {
  await testMissingMessageClient(
    graphServer,
    graphClient,
    Cr.NS_ERROR_NET_ERROR_RESPONSE
  );
});

/**
 * Fetch an absent server item, then retry after it becomes available.
 *
 * @param {MockServer} mockServer - The protocol fixture.
 * @param {IExchangeClient} client - The real protocol client.
 * @param {nsresult} expectedStatus - The protocol's missing-item error.
 * @returns {Promise<void>} Resolves after the failed fetch and successful retry.
 */
async function testMissingMessageClient(mockServer, client, expectedStatus) {
  const id = "missing-client-item";
  Assert.ok(!mockServer.getItemInfo(id), "The requested server item is absent");
  const done = Promise.withResolvers();
  let starts = 0;
  let chunks = 0;
  const stops = [];
  client.getMessage(
    {
      QueryInterface: ChromeUtils.generateQI(["IExchangeMessageFetchListener"]),
      onFetchStart() {
        starts++;
      },
      onFetchedDataAvailable() {
        chunks++;
      },
      onFetchStop(status) {
        stops.push(status);
        done.resolve();
      },
    },
    id
  );
  await done.promise;
  Assert.equal(starts, 1, "The failed fetch starts once");
  Assert.equal(chunks, 0, "The missing item supplies no MIME content");
  Assert.deepEqual(stops, [expectedStatus], "The original error stops once");

  const message = new MessageGenerator().makeMessage({
    subject: "Available after missing item",
  });
  mockServer.addItemToFolder(id, "inbox", message);
  const retry = new MessageFetchListener();
  client.getMessage(retry, id);
  Assert.equal(await retry.promise, message.toMessageString());
}

add_task(async function testMissingMessageChannelEws() {
  await testMissingMessageChannel(
    ewsServer,
    incomingEwsServer,
    Cr.NS_ERROR_UNEXPECTED
  );
});

add_task(async function testMissingMessageChannelGraph() {
  await testMissingMessageChannel(
    graphServer,
    incomingGraphServer,
    Cr.NS_ERROR_NET_ERROR_RESPONSE
  );
});

/**
 * Retain a synced header after a missing-item fetch and permit a body retry.
 *
 * @param {MockServer} mockServer - The protocol fixture.
 * @param {nsIMsgIncomingServer} incomingServer - The configured account server.
 * @param {nsresult} expectedStatus - The protocol's missing-item error.
 * @returns {Promise<void>} Resolves after failure and retry finish.
 */
async function testMissingMessageChannel(
  mockServer,
  incomingServer,
  expectedStatus
) {
  const folderName = incomingServer.type + "_missing_item_channel";
  const serverId = incomingServer.type + "_missing_channel_item";
  mockServer.appendRemoteFolder(new RemoteFolder(folderName, "root"));
  await syncFolder(incomingServer, incomingServer.rootFolder);
  const folder = incomingServer.rootFolder.getChildNamed(folderName);
  const message = new MessageGenerator().makeMessage({
    subject: "Missing item channel",
  });
  message.metaState.read = true;
  message.metaState.flagged = true;
  mockServer.addItemToFolder(serverId, folderName, message);
  await syncFolder(incomingServer, folder);
  const header = [...folder.messages][0];
  Assert.ok(header, "The metadata is synced before removing the remote item");
  const key = header.messageKey;
  const messageId = header.messageId;
  Assert.equal(header.getStringProperty("ewsId"), serverId);
  Assert.ok(!folder.hasMsgOffline(key));
  Assert.ok(header.isRead && header.isFlagged);
  const storeToken = header.storeToken;
  mockServer.deleteItem(serverId);

  const uri = folder.getUriForMsg(header);
  const service = MailServices.messageServiceFromURI(uri);
  const channel = Services.io.newChannelFromURI(
    service.getUrlForUri(uri),
    null,
    Services.scriptSecurityManager.getSystemPrincipal(),
    null,
    Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
    Ci.nsIContentPolicy.TYPE_OTHER
  );
  const done = Promise.withResolvers();
  let starts = 0;
  let chunks = 0;
  const stops = [];
  try {
    channel.asyncOpen({
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
      onStartRequest() {
        starts++;
      },
      onDataAvailable() {
        chunks++;
      },
      onStopRequest(request, status) {
        stops.push(status);
        done.resolve();
      },
    });
    Assert.ok(
      channel.isPending(),
      "The request is pending before the response"
    );
    await done.promise;
    Assert.equal(starts, 1);
    Assert.equal(chunks, 0, "No data is reported for the missing item");
    Assert.deepEqual(stops, [expectedStatus]);
    Assert.equal(channel.status, expectedStatus);
    Assert.ok(!channel.isPending());
    Assert.ok(!channel.canceled, "A missing item is not a cancellation");
    Assert.ok(!folder.hasMsgOffline(key), "Failure does not publish a body");
    Assert.equal(header.storeToken, storeToken);
    Assert.equal(folder.GetMessageHeader(key).messageId, messageId);
    Assert.ok(header.isRead && header.isFlagged, "Failure preserves state");

    mockServer.addItemToFolder(serverId, folderName, message);
    const retry = new PromiseTestUtils.PromiseStreamListener();
    service.streamMessage(uri, retry, null, null, false, "", false);
    Assert.equal(await retry.promise, message.toMessageString());
    Assert.ok(
      folder.hasMsgOffline(key),
      "The successful retry stores the body"
    );
    Assert.equal(folder.GetMessageHeader(key).messageId, messageId);
    Assert.equal(header.getStringProperty("ewsId"), serverId);
    Assert.ok(header.isRead && header.isFlagged, "Retry preserves state");
  } finally {
    if (!mockServer.getItemInfo(serverId)) {
      mockServer.addItemToFolder(serverId, folderName, message);
    }
  }
}

add_task(async function testCachedReadStartFailureEws() {
  await testCachedReadStartFailure(ewsServer, incomingEwsServer);
});

add_task(async function testCachedReadStartFailureGraph() {
  await testCachedReadStartFailure(graphServer, incomingGraphServer);
});

/**
 * Retain cached metadata when the store cannot open its body, then retry.
 *
 * @param {MockServer} mockServer - The protocol fixture.
 * @param {nsIMsgIncomingServer} incomingServer - The configured account server.
 * @returns {Promise<void>} Resolves after restoring and reading the same body.
 */
async function testCachedReadStartFailure(mockServer, incomingServer) {
  const name = incomingServer.type + "_cached_read_start_failure";
  mockServer.appendRemoteFolder(new RemoteFolder(name, "root"));
  await syncFolder(incomingServer, incomingServer.rootFolder);
  const folder = incomingServer.rootFolder.getChildNamed(name);
  const message = new MessageGenerator().makeMessage({
    subject: "Cached body read startup failure",
  });
  const raw = message.toMessageString();
  const file = do_get_tempdir();
  file.append(name + ".eml");
  file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
  try {
    await IOUtils.writeUTF8(file.path, raw);
    const copy = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyFileMessage(
      file,
      folder,
      null,
      false,
      Ci.nsMsgMessageFlags.Read,
      "",
      copy,
      null
    );
    const result = await copy.promise;
    Assert.equal(result.messageKeys.length, 1);
    const header = folder.GetMessageHeader(result.messageKeys[0]);
    const key = header.messageKey;
    const id = header.messageId;
    const token = header.storeToken;
    const flags = header.flags;
    const size = header.messageSize;
    const offlineSize = header.offlineMessageSize;
    const serverId = header.getStringProperty("ewsId");
    Assert.equal(id, message.messageId);
    Assert.ok(token);
    Assert.ok(folder.hasMsgOffline(key));
    const db = folder.msgDatabase;
    const storeType = folder.msgStore.storeType;
    Assert.ok(["mbox", "maildir"].includes(storeType));
    const storePath = folder.filePath.clone();
    const backup = storePath.clone();
    backup.leafName += ".read-backup";
    Assert.ok(!backup.exists(), "The backup path is unused");
    const uri = folder.getUriForMsg(header);
    const service = MailServices.messageServiceFromURI(uri);
    const channel = Services.io.newChannelFromURI(
      service.getUrlForUri(uri),
      null,
      Services.scriptSecurityManager.getSystemPrincipal(),
      null,
      Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
      Ci.nsIContentPolicy.TYPE_OTHER
    );
    channel.loadFlags |=
      Ci.nsICachingChannel.LOAD_ONLY_FROM_CACHE |
      Ci.nsICachingChannel.LOAD_NO_NETWORK_IO;
    const callbacks = [];
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
      onStartRequest() {
        callbacks.push("start");
      },
      onDataAvailable() {
        callbacks.push("data");
      },
      onStopRequest() {
        callbacks.push("stop");
      },
    };
    storePath.clone().moveTo(backup.parent, backup.leafName);
    let obstructed = false;
    try {
      // Maildir must not create a new cur directory while its store is away.
      if (storeType == "maildir") {
        storePath.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
        obstructed = true;
      }
      let storeError;
      let unexpectedStream;
      try {
        unexpectedStream = folder.getMsgInputStream(header);
      } catch (error) {
        storeError = error.result;
      }
      unexpectedStream?.close();
      Assert.notEqual(
        storeError,
        undefined,
        "The real store cannot open the body"
      );
      Assert.ok(!Components.isSuccessCode(storeError));
      Assert.throws(
        () => channel.asyncOpen(listener),
        error => error.result == storeError,
        "Opening the cached body returns its original store error"
      );
      Assert.equal(
        channel.status,
        storeError,
        "The request retains the same error"
      );
      Assert.ok(!channel.isPending());
      Assert.ok(!channel.canceled);
      Assert.deepEqual(callbacks, [], "An unopened read has no callbacks");
      Assert.ok(
        db.containsKey(key),
        "Unavailable bytes do not remove the header"
      );
      Assert.ok(
        folder.hasMsgOffline(key),
        "This read does not repair metadata"
      );
      Assert.equal(header.storeToken, token);
      Assert.equal(header.flags, flags);
      Assert.equal(header.messageSize, size);
      Assert.equal(header.offlineMessageSize, offlineSize);
      Assert.equal(header.messageId, id);
      Assert.equal(header.getStringProperty("ewsId"), serverId);
      Assert.ok(mockServer.getItemInfo(serverId));
    } finally {
      if (obstructed) {
        Assert.ok(storePath.isFile(), "Only the test obstruction is removed");
        storePath.remove(false);
      }
      Assert.ok(
        !storePath.exists(),
        "Restoration does not replace another store"
      );
      backup.moveTo(storePath.parent, storePath.leafName);
    }

    const retry = new PromiseTestUtils.PromiseStreamListener();
    service.streamMessage(uri, retry, null, null, false, "", true);
    Assert.equal(
      await retry.promise,
      raw,
      "The same stored bytes remain readable"
    );
    const retained = folder.GetMessageHeader(key);
    Assert.equal(retained.messageId, id);
    Assert.equal(retained.storeToken, token);
    Assert.equal(retained.flags, flags);
    Assert.equal(retained.messageSize, size);
    Assert.equal(retained.offlineMessageSize, offlineSize);
    Assert.equal(retained.getStringProperty("ewsId"), serverId);
    Assert.ok(folder.hasMsgOffline(key));
    Assert.deepEqual(
      callbacks,
      [],
      "Retry does not start the rejected request"
    );
  } finally {
    file.remove(false);
  }
}

add_task(async function testCachedReadMissingTokenEws() {
  await testCachedReadMissingToken(ewsServer, incomingEwsServer);
});

add_task(async function testCachedReadMissingTokenGraph() {
  await testCachedReadMissingToken(graphServer, incomingGraphServer);
});

/**
 * Report missing cached-body metadata without replacing the stored bytes.
 *
 * @param {MockServer} mockServer - The protocol fixture.
 * @param {nsIMsgIncomingServer} incomingServer - The configured account server.
 * @returns {Promise<void>} Resolves after restoring the fixture's token and flags.
 */
async function testCachedReadMissingToken(mockServer, incomingServer) {
  const name = incomingServer.type + "_cached_read_missing_token";
  mockServer.appendRemoteFolder(new RemoteFolder(name, "root"));
  await syncFolder(incomingServer, incomingServer.rootFolder);
  const folder = incomingServer.rootFolder.getChildNamed(name);
  const message = new MessageGenerator().makeMessage({
    subject: "Cached body metadata failure",
  });
  const raw = message.toMessageString();
  const file = do_get_tempdir();
  file.append(name + ".eml");
  file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
  try {
    await IOUtils.writeUTF8(file.path, raw);
    const copy = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyFileMessage(
      file,
      folder,
      null,
      false,
      Ci.nsMsgMessageFlags.Read,
      "",
      copy,
      null
    );
    const result = await copy.promise;
    Assert.equal(result.messageKeys.length, 1);
    const header = folder.GetMessageHeader(result.messageKeys[0]);
    const key = header.messageKey;
    const id = header.messageId;
    const token = header.storeToken;
    const flags = header.flags;
    const size = header.messageSize;
    const offlineSize = header.offlineMessageSize;
    const serverId = header.getStringProperty("ewsId");
    Assert.equal(id, message.messageId);
    Assert.ok(token);
    Assert.ok(folder.hasMsgOffline(key));
    const uri = folder.getUriForMsg(header);
    const service = MailServices.messageServiceFromURI(uri);
    const channel = Services.io.newChannelFromURI(
      service.getUrlForUri(uri),
      null,
      Services.scriptSecurityManager.getSystemPrincipal(),
      null,
      Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
      Ci.nsIContentPolicy.TYPE_OTHER
    );
    channel.loadFlags |=
      Ci.nsICachingChannel.LOAD_ONLY_FROM_CACHE |
      Ci.nsICachingChannel.LOAD_NO_NETWORK_IO;
    const callbacks = [];
    try {
      header.storeToken = "";
      Assert.equal(
        header.storeToken,
        "",
        "The public token metadata is absent"
      );
      Assert.throws(
        () =>
          channel.asyncOpen({
            QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
            onStartRequest() {
              callbacks.push("start");
            },
            onDataAvailable() {
              callbacks.push("data");
            },
            onStopRequest() {
              callbacks.push("stop");
            },
          }),
        error => error.result == Cr.NS_ERROR_FAILURE,
        "Missing token metadata returns the existing metadata failure"
      );
      Assert.equal(channel.status, Cr.NS_ERROR_FAILURE);
      Assert.ok(!channel.isPending());
      Assert.ok(!channel.canceled);
      Assert.deepEqual(callbacks, []);
      Assert.ok(folder.msgDatabase.containsKey(key));
      Assert.equal(
        header.flags,
        flags & ~Ci.nsMsgMessageFlags.Offline,
        "The existing missing-token path clears only Offline"
      );
      Assert.equal(header.messageSize, size);
      Assert.equal(header.offlineMessageSize, offlineSize);
      Assert.equal(header.messageId, id);
      Assert.equal(header.getStringProperty("ewsId"), serverId);
      Assert.ok(mockServer.getItemInfo(serverId));
    } finally {
      header.storeToken = token;
      header.flags = flags;
    }
    const retry = new PromiseTestUtils.PromiseStreamListener();
    service.streamMessage(uri, retry, null, null, false, "", true);
    Assert.equal(await retry.promise, raw);
    Assert.equal(folder.GetMessageHeader(key).messageId, id);
    Assert.equal(header.storeToken, token);
    Assert.equal(header.flags, flags);
    Assert.equal(header.messageSize, size);
    Assert.equal(header.offlineMessageSize, offlineSize);
    Assert.deepEqual(
      callbacks,
      [],
      "Retry leaves the rejected request unopened"
    );
  } finally {
    file.remove(false);
  }
}
add_task(async function test_missingFolderStatusEws() {
  await testEarlyLookupStatus(ewsServer, incomingEwsServer, "folder");
});

add_task(async function test_missingFolderStatusGraph() {
  await testEarlyLookupStatus(graphServer, incomingGraphServer, "folder");
});

add_task(async function test_missingHeaderStatusEws() {
  await testEarlyLookupStatus(ewsServer, incomingEwsServer, "header");
});

add_task(async function test_missingHeaderStatusGraph() {
  await testEarlyLookupStatus(graphServer, incomingGraphServer, "header");
});

/**
 * Return a real synced message for early channel-open failures.
 *
 * @param {MockServer} mockServer - The protocol fixture.
 * @param {nsIMsgIncomingServer} incomingServer - The configured account server.
 * @param {string} suffix - The test folder suffix.
 * @param {boolean} cached - Whether to download the message before returning.
 * @returns {Promise<{folder: nsIMsgFolder, header: nsIMsgDBHdr, uri: string,
 *   raw: string}>} The message and its original content.
 */
async function createEarlyOpenMessage(
  mockServer,
  incomingServer,
  suffix,
  cached
) {
  const name = incomingServer.type + "_early_open_" + suffix;
  mockServer.appendRemoteFolder(new RemoteFolder(name, "root"));
  await syncFolder(incomingServer, incomingServer.rootFolder);
  const folder = incomingServer.rootFolder.getChildNamed(name);
  const message = new MessageGenerator().makeMessage({
    subject: "Early channel failure " + suffix,
  });
  message.messageId = `${name}@made.up.invalid`;
  message.metaState.read = true;
  message.metaState.flagged = true;
  mockServer.addMessages(name, [message]);
  await syncFolder(incomingServer, folder);
  const headers = [...folder.messages];
  Assert.equal(headers.length, 1);
  const header = headers[0];
  Assert.equal(header.messageId, message.messageId);
  Assert.ok(header.isRead && header.isFlagged);
  Assert.ok(!folder.hasMsgOffline(header.messageKey));
  Assert.ok(["mbox", "maildir"].includes(folder.msgStore.storeType));
  const uri = folder.getUriForMsg(header);
  const raw = message.toMessageString();
  if (cached) {
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
    Assert.equal(await stream.promise, raw);
    Assert.ok(folder.hasMsgOffline(header.messageKey));
    Assert.ok(header.storeToken);
  }
  return { folder, header, uri, raw };
}

/**
 * Retain a real lookup error and read the unchanged body through a corrected URI.
 *
 * @param {MockServer} mockServer - The protocol fixture.
 * @param {nsIMsgIncomingServer} incomingServer - The configured account server.
 * @param {"folder"|"header"} missing - The missing URI component.
 * @returns {Promise<void>} Resolves after a new request reads the original body.
 */
async function testEarlyLookupStatus(mockServer, incomingServer, missing) {
  const { folder, header, uri, raw } = await createEarlyOpenMessage(
    mockServer,
    incomingServer,
    missing,
    true
  );
  const key = header.messageKey;
  const id = header.messageId;
  const token = header.storeToken;
  const flags = header.flags;
  const size = header.messageSize;
  const offlineSize = header.offlineMessageSize;
  const serverId = header.getStringProperty("ewsId");
  const service = MailServices.messageServiceFromURI(uri);
  const goodUrl = service.getUrlForUri(uri);
  const lastSlash = goodUrl.spec.lastIndexOf("/");
  let badSpec;
  let expectedError;
  if (missing == "folder") {
    Assert.equal(
      MailServices.folderLookup.getFolderForURL(folder.URI + "_missing"),
      null,
      "The requested folder does not exist"
    );
    badSpec = goodUrl.spec.slice(0, lastSlash) + "_missing/" + key;
  } else {
    let absentKey = 1;
    while (folder.msgDatabase.containsKey(absentKey)) {
      absentKey++;
    }
    try {
      folder.GetMessageHeader(absentKey);
    } catch (error) {
      expectedError = error.result;
    }
    Assert.notEqual(expectedError, undefined, "The real header lookup fails");
    badSpec = goodUrl.spec.slice(0, lastSlash + 1) + absentKey;
  }
  let lookupError;
  try {
    service.messageURIToMsgHdr(badSpec);
  } catch (error) {
    lookupError = error.result;
  }
  Assert.notEqual(lookupError, undefined, "The real URI lookup fails");
  Assert.ok(!Components.isSuccessCode(lookupError));
  if (missing == "header") {
    Assert.equal(
      lookupError,
      expectedError,
      "The URI keeps the native header error"
    );
  }
  const channel = Services.io.newChannelFromURI(
    Services.io.newURI(badSpec),
    null,
    Services.scriptSecurityManager.getSystemPrincipal(),
    null,
    Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
    Ci.nsIContentPolicy.TYPE_OTHER
  );
  channel.loadFlags |= Ci.nsICachingChannel.LOAD_NO_NETWORK_IO;
  const callbacks = [];
  Assert.throws(
    () =>
      channel.asyncOpen({
        QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
        onStartRequest() {
          callbacks.push("start");
        },
        onDataAvailable() {
          callbacks.push("data");
        },
        onStopRequest() {
          callbacks.push("stop");
        },
      }),
    error => error.result == lookupError,
    "AsyncOpen returns the actual lookup error"
  );
  Assert.equal(channel.status, lookupError);
  Assert.ok(!channel.isPending());
  Assert.ok(!channel.canceled);
  Assert.deepEqual(callbacks, []);
  Assert.ok(folder.msgDatabase.containsKey(key));
  Assert.ok(folder.hasMsgOffline(key));
  Assert.equal(header.storeToken, token);
  Assert.equal(header.flags, flags);
  Assert.equal(header.messageSize, size);
  Assert.equal(header.offlineMessageSize, offlineSize);
  Assert.equal(mockServer.getItemInfo(serverId).syntheticMessage.messageId, id);

  const retry = new PromiseTestUtils.PromiseStreamListener();
  service.streamMessage(uri, retry, null, null, false, "", true);
  Assert.equal(
    await retry.promise,
    raw,
    "A new request uses the corrected URI"
  );
  const retained = folder.GetMessageHeader(key);
  Assert.equal(retained.messageKey, key);
  Assert.equal(retained.folder.URI, folder.URI);
  Assert.equal(retained.messageId, id);
  Assert.equal(retained.storeToken, token);
  Assert.equal(retained.flags, flags);
  Assert.equal(retained.messageSize, size);
  Assert.equal(retained.offlineMessageSize, offlineSize);
  Assert.equal(retained.getStringProperty("ewsId"), serverId);
  Assert.equal(
    channel.status,
    lookupError,
    "The failed request keeps its first error"
  );
  Assert.deepEqual(callbacks, [], "The failed request never starts");
}

add_task(async function test_cachePolicyStatusEws() {
  await testEarlyPolicyStatus(ewsServer, incomingEwsServer, false);
});

add_task(async function test_cachePolicyStatusGraph() {
  await testEarlyPolicyStatus(graphServer, incomingGraphServer, false);
});

add_task(async function test_offlineStatusEws() {
  await testEarlyPolicyStatus(ewsServer, incomingEwsServer, true);
});

add_task(async function test_offlineStatusGraph() {
  await testEarlyPolicyStatus(graphServer, incomingGraphServer, true);
});

/**
 * Retain a local-read refusal and download only through a new online request.
 *
 * @param {MockServer} mockServer - The protocol fixture.
 * @param {nsIMsgIncomingServer} incomingServer - The configured account server.
 * @param {boolean} offline - Whether to test global offline mode or cache-only.
 * @returns {Promise<void>} Resolves after the new request downloads the body.
 */
async function testEarlyPolicyStatus(mockServer, incomingServer, offline) {
  const { folder, header, uri, raw } = await createEarlyOpenMessage(
    mockServer,
    incomingServer,
    offline ? "offline" : "cache",
    false
  );
  const key = header.messageKey;
  const id = header.messageId;
  const token = header.storeToken;
  const flags = header.flags;
  const size = header.messageSize;
  const offlineSize = header.offlineMessageSize;
  const serverId = header.getStringProperty("ewsId");
  const service = MailServices.messageServiceFromURI(uri);
  const channel = Services.io.newChannelFromURI(
    service.getUrlForUri(uri),
    null,
    Services.scriptSecurityManager.getSystemPrincipal(),
    null,
    Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
    Ci.nsIContentPolicy.TYPE_OTHER
  );
  if (!offline) {
    channel.loadFlags |= Ci.nsICachingChannel.LOAD_ONLY_FROM_CACHE;
  }
  const callbacks = [];
  const wasOffline = Services.io.offline;
  Assert.ok(!wasOffline, "The configured server setup is online");
  const expectedError = offline
    ? Cr.NS_MSG_ERROR_OFFLINE
    : Cr.NS_ERROR_DOCUMENT_NOT_CACHED;
  try {
    if (offline) {
      Services.io.offline = true;
    }
    Assert.throws(
      () =>
        channel.asyncOpen({
          QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
          onStartRequest() {
            callbacks.push("start");
          },
          onDataAvailable() {
            callbacks.push("data");
          },
          onStopRequest() {
            callbacks.push("stop");
          },
        }),
      error => error.result == expectedError,
      "The uncached request returns the policy error"
    );
    Assert.equal(channel.status, expectedError);
    Assert.ok(!channel.isPending());
    Assert.ok(!channel.canceled);
    Assert.deepEqual(callbacks, []);
    Assert.ok(folder.msgDatabase.containsKey(key));
    Assert.ok(
      !folder.hasMsgOffline(key),
      "The rejected request did not download"
    );
    Assert.equal(header.storeToken, token);
    Assert.equal(header.flags, flags);
    Assert.equal(header.messageSize, size);
    Assert.equal(header.offlineMessageSize, offlineSize);
    Assert.equal(
      mockServer.getItemInfo(serverId).syntheticMessage.messageId,
      id
    );
  } finally {
    Services.io.offline = wasOffline;
  }
  const retry = new PromiseTestUtils.PromiseStreamListener();
  service.streamMessage(uri, retry, null, null, false, "", false);
  Assert.equal(
    await retry.promise,
    raw,
    "Only the new request downloads the body"
  );
  const retained = folder.GetMessageHeader(key);
  Assert.equal(retained.messageKey, key);
  Assert.equal(retained.folder.URI, folder.URI);
  Assert.equal(retained.messageId, id);
  Assert.equal(retained.getStringProperty("ewsId"), serverId);
  Assert.ok(retained.isRead && retained.isFlagged);
  Assert.ok(retained.storeToken);
  Assert.ok(folder.hasMsgOffline(key));
  Assert.equal(
    channel.status,
    expectedError,
    "The first request retains its error"
  );
  Assert.deepEqual(callbacks, [], "The failed request never starts");
}

add_task(async function test_singleUriPhysicalReadEws() {
  await checkSingleUriPhysicalRead(ewsServer, incomingEwsServer);
});

add_task(async function test_singleUriPhysicalReadGraph() {
  await checkSingleUriPhysicalRead(graphServer, incomingGraphServer);
});

/**
 * Resolve and stream separate physical messages with the same Message-ID.
 *
 * @param {MockServer} mockServer - The existing protocol fixture.
 * @param {nsIMsgIncomingServer} incomingServer - Its configured account.
 * @returns {Promise<void>} Resolves after remote and cached reads of both URIs.
 */
async function checkSingleUriPhysicalRead(mockServer, incomingServer) {
  const databaseService = Cc[
    "@mozilla.org/msgDatabase/msgDBService;1"
  ].getService(Ci.nsIMsgDBService);
  const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  Assert.equal(
    "nsIDatabaseCore" in Ci && databaseService instanceof Ci.nsIDatabaseCore,
    native
  );
  Assert.equal(
    incomingServer.getStringValue("storeContractID"),
    Services.prefs.getCharPref("mail.serverDefaultStoreContractID")
  );
  const prefix = `${incomingServer.type}_physical_uri`;
  const generator = new MessageGenerator();
  const messages = generator.makeMessages({ count: 2 });
  const commonId = `${prefix}@made.up.invalid`;
  const folders = [];
  for (let i = 0; i < 2; i++) {
    messages[i].messageId = commonId;
    const name = `${prefix}_${i}`;
    mockServer.appendRemoteFolder(new RemoteFolder(name, "root", name, name));
    mockServer.addItemToFolder(
      `${prefix}_item_${i ? "11" : "1"}`,
      name,
      messages[i]
    );
  }
  await syncFolder(incomingServer, incomingServer.rootFolder);
  for (let i = 0; i < 2; i++) {
    const folder = incomingServer.rootFolder.getChildNamed(`${prefix}_${i}`);
    await syncFolder(incomingServer, folder);
    folders.push(folder);
  }
  const headers = folders.map(folder => [...folder.messages][0]);
  const keys = headers.map(header => header.messageKey);
  const ids = headers.map(header => header.getStringProperty("ewsId"));
  const uris = headers.map((header, i) => folders[i].getUriForMsg(header));
  Assert.notEqual(
    uris[0],
    uris[1],
    "Each physical instance has its own message URI"
  );
  Assert.notEqual(
    ids[0],
    ids[1],
    "Opaque IDs with overlapping text stay distinct"
  );
  if (native) {
    Assert.notEqual(
      keys[0],
      keys[1],
      "Native physical keys are global across folders"
    );
  }
  for (const localOnly of [false, true]) {
    for (let i = 0; i < 2; i++) {
      const service = MailServices.messageServiceFromURI(uris[i]);
      const resolved = service.messageURIToMsgHdr(uris[i]);
      Assert.equal(resolved.messageKey, keys[i]);
      Assert.equal(resolved.folder.URI, folders[i].URI);
      Assert.equal(resolved.messageId, commonId);
      Assert.equal(resolved.getStringProperty("ewsId"), ids[i]);
      const channelURI = service.getUrlForUri(uris[i]);
      Assert.equal(channelURI.scheme, `x-moz-${incomingServer.type}`);
      const statuses = [];
      let starts = 0;
      const stream = new PromiseTestUtils.PromiseStreamListener({
        onStartRequest() {
          starts++;
        },
        onStopRequest(request, status) {
          statuses.push(status);
        },
      });
      service.streamMessage(uris[i], stream, null, null, false, "", localOnly);
      Assert.equal(await stream.promise, messages[i].toMessageString());
      Assert.equal(starts, 1, "Each individual URI starts once");
      Assert.deepEqual(
        statuses,
        [Cr.NS_OK],
        "Each individual URI stops successfully once"
      );
      Assert.ok(folders[i].hasMsgOffline(keys[i]));
      Assert.ok(headers[i].storeToken);
      Assert.equal(service.messageURIToMsgHdr(uris[i]).messageKey, keys[i]);
      Assert.equal(
        mockServer.getItemInfo(ids[i]).parentId,
        folders[i].getStringProperty("ewsId")
      );
      Assert.equal(
        folders[1 - i].GetMessageHeader(keys[1 - i]).messageId,
        commonId
      );
    }
  }
}
