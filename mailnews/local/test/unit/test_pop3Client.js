/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const [daemon, server, handler] = setupServerDaemon();
handler.kCapabilities = ["uidl", "top"]; // CAPA response is case-insensitive.
server.start();
registerCleanupFunction(() => {
  server.stop();
});

/**
 * Test when alwaysSTARTTLS is set, but the server doesn't support STARTTLS,
 * should abort after CAPA response.
 */
add_task(async function testSTARTTLS() {
  server.resetTest();

  const incomingServer = createPop3ServerAndLocalFolders(server.port);
  // Set to always use STARTTLS.
  incomingServer.socketType = Ci.nsMsgSocketType.alwaysSTARTTLS;

  const urlListener = {
    OnStartRunningUrl() {},
    OnStopRunningUrl(url, result) {
      try {
        const transaction = server.playTransaction();
        do_check_transaction(transaction, ["AUTH", "CAPA"]);
        Assert.equal(result, Cr.NS_ERROR_FAILURE);
      } catch (e) {
      } finally {
        MailServices.accounts.removeIncomingServer(incomingServer, false);
        do_test_finished();
      }
    },
  };

  // Now get the mail.
  MailServices.pop3.GetNewMail(
    null,
    urlListener,
    localAccountUtils.inboxFolder,
    incomingServer
  );

  server.performTest();

  do_test_pending();
});

/**
 * Test that depending on user prefs and message size, TOP or RETR should be used.
 *
 * @param {nsIMsgIncomingServer} incomingServer - A server instance.
 * @param {string[]} transaction - The commands sent to the server.
 */
async function testTopOrRetr(incomingServer, transaction) {
  server.resetTest();
  // Any message file larger than 50KB is good for this test.
  daemon.setMessages(["mailformed_subject.eml"]);

  const urlListener = {
    OnStartRunningUrl() {},
    OnStopRunningUrl(url, result) {
      try {
        do_check_transaction(server.playTransaction(), transaction);
        Assert.equal(result, 0);
      } catch (e) {
      } finally {
        MailServices.accounts.removeIncomingServer(incomingServer, false);
        do_test_finished();
      }
    },
  };

  // Now get the mail.
  MailServices.pop3.GetNewMail(
    null,
    urlListener,
    localAccountUtils.inboxFolder,
    incomingServer
  );

  server.performTest();

  do_test_pending();
}

/**
 * Turn off server.limitOfflineMessageSize, test RETR is used.
 */
add_task(async function testNoOfflineMessageSizeLimit() {
  const incomingServer = createPop3ServerAndLocalFolders(server.port);
  incomingServer.limitOfflineMessageSize = false;
  incomingServer.maxMessageSize = 1;

  testTopOrRetr(incomingServer, [
    "AUTH",
    "CAPA",
    "AUTH PLAIN",
    "STAT",
    "LIST",
    "UIDL",
    "RETR 1",
    "DELE 1",
  ]);
});

/**
 * Turn on server.limitOfflineMessageSize and set maxMessageSize to 1KB, test
 * TOP is used.
 */
add_task(async function testMaxMessageSize() {
  const incomingServer = createPop3ServerAndLocalFolders(server.port);
  incomingServer.limitOfflineMessageSize = true;
  incomingServer.maxMessageSize = 1;

  testTopOrRetr(incomingServer, [
    "AUTH",
    "CAPA",
    "AUTH PLAIN",
    "STAT",
    "LIST",
    "UIDL",
    "TOP 1 20",
  ]);
});

/**
 * Turn on server.headersOnly, test TOP is used.
 */
add_task(async function testHeadersOnly() {
  const incomingServer = createPop3ServerAndLocalFolders(server.port);
  incomingServer.headersOnly = true;

  testTopOrRetr(incomingServer, [
    "AUTH",
    "CAPA",
    "AUTH PLAIN",
    "STAT",
    "LIST",
    "UIDL",
    "TOP 1 0",
  ]);
});

/**
 * Test that a response line split over several data events is only parsed
 * once complete, and is parsed in full.
 */
add_task(async function testSplitLine() {
  const { Pop3Client } = ChromeUtils.importESModule(
    "resource:///modules/Pop3Client.sys.mjs"
  );
  const { LineReader } = ChromeUtils.importESModule(
    "resource:///modules/LineReader.sys.mjs"
  );
  const incomingServer = createPop3ServerAndLocalFolders(server.port);
  const client = new Pop3Client(incomingServer);
  client._lineReader = new LineReader();
  client._pendingPayload = "";
  const responses = [];
  client._nextAction = res => responses.push(res);

  for (const chunk of [
    "+OK ready ",
    "<1896.6971",
    "70952@dbc.mtview.ca.us>\r",
    "\n",
  ]) {
    await client._onData({
      data: new TextEncoder().encode(chunk).buffer,
    });
  }

  Assert.equal(responses.length, 1, "the line should be parsed once");
  Assert.ok(responses[0].success, "the response should be a success");
  Assert.equal(
    responses[0].statusText,
    "ready <1896.697170952@dbc.mtview.ca.us>",
    "the status text should be complete"
  );
  Assert.equal(client._pendingPayload, "", "nothing should be left pending");

  MailServices.accounts.removeIncomingServer(incomingServer, false);
});

/**
 * Test that bare LF line endings in a downloaded message still end the
 * headers at the empty line, so that header-like lines in the body don't end
 * up in the message database.
 */
add_task(async function testBareLFHeaderSeparator() {
  const { PromiseTestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
  );
  server.resetTest();
  // Send the message exactly as given, without converting bare LF to CRLF.
  handler.postCommand = function (reader) {
    Object.getPrototypeOf(this).postCommand.call(this, reader);
    reader.preventLFMunge();
  };
  daemon.setMessages([
    {
      fileData:
        "From: sender@example.com\n" +
        "Subject: bare LF separator\n" +
        "\n" +
        "Hello: there\n" +
        "To: someone@example.com\n" +
        "Content-Type: multipart/mixed; boundary=xyz\n" +
        "\n" +
        "Body text\r\n",
    },
  ]);

  const incomingServer = createPop3ServerAndLocalFolders(server.port);
  const inbox = localAccountUtils.inboxFolder;
  const urlListener = new PromiseTestUtils.PromiseUrlListener();
  MailServices.pop3.GetNewMail(null, urlListener, inbox, incomingServer);
  await urlListener.promise;

  const msgHdr = [...inbox.messages].find(
    hdr => hdr.subject == "bare LF separator"
  );
  Assert.ok(msgHdr, "the message should have been downloaded");
  Assert.equal(
    msgHdr.recipients,
    "",
    "a To line in the body should not be parsed as a header"
  );
  Assert.ok(
    !(msgHdr.flags & Ci.nsMsgMessageFlags.Attachment),
    "a Content-Type line in the body should not be parsed as a header"
  );

  delete handler.postCommand;
  MailServices.accounts.removeIncomingServer(incomingServer, false);
});

/**
 * Download two deferred accounts when one server rejects the connection.
 *
 * @param {string} store - Destination store type.
 * @param {boolean} failingFirst - Process the failing account first.
 */
async function checkDeferredDownloadFailure(store, failingFirst) {
  const storeID =
    store == "mbox"
      ? "@mozilla.org/msgstore/berkeleystore;1"
      : "@mozilla.org/msgstore/maildirstore;1";
  const prefs = [
    "mail.serverDefaultStoreContractID",
    "mail.server.default.storeContractID",
  ].map(name => ({
    name,
    present: Services.prefs.prefHasUserValue(name),
    value: Services.prefs.getCharPref(name, ""),
  }));
  const [badDaemon, badServer, badHandler] = setupServerDaemon();
  const [goodDaemon, goodServer, goodHandler] = setupServerDaemon();
  const accounts = [];
  badHandler.kUsername = "deferred-bad";
  goodHandler.kUsername = "deferred-good";
  badHandler.onStartup = () => "-ERR Delivery unavailable";
  badDaemon.setMessages(["message1.eml"]);
  goodDaemon.setMessages([
    {
      fileData:
        "From: sender@example.invalid\r\n" +
        "To: recipient@example.invalid\r\n" +
        "Subject: Deferred download\r\n" +
        "Message-ID: <deferred-download@example.invalid>\r\n" +
        "Date: Tue, 01 Jan 2019 12:00:00 +0000\r\n" +
        "\r\n" +
        "Deferred download body.\r\n",
    },
  ]);
  try {
    badServer.start();
    goodServer.start();
    localAccountUtils.clearAll();
    for (const { name } of prefs) {
      Services.prefs.setCharPref(name, storeID);
    }
    localAccountUtils.loadLocalMailAccount();
    const inbox = localAccountUtils.inboxFolder;
    Assert.equal(inbox.msgStore.storeType, store);
    Assert.equal(inbox.server.msgStore.storeType, store);
    const dbService = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    );
    Assert.equal(
      "nsIDatabaseCore" in Ci && dbService instanceof Ci.nsIDatabaseCore,
      Services.prefs.getBoolPref("mail.panorama.enabled", false)
    );
    Assert.equal(dbService.openFolderDB(inbox, false), inbox.msgDatabase);

    for (const [popServer, popHandler] of [
      [badServer, badHandler],
      [goodServer, goodHandler],
    ]) {
      const accountAndServer =
        localAccountUtils.create_incoming_server_and_account(
          "pop3",
          popServer.port,
          popHandler.kUsername,
          "wilma"
        );
      accounts.push(accountAndServer);
      accountAndServer.server.deferGetNewMail = true;
      Assert.equal(accountAndServer.server.msgStore.storeType, store);
      Assert.equal(
        accountAndServer.server.deferredToAccount,
        localAccountUtils.msgAccount.key
      );
      Assert.equal(accountAndServer.server.rootMsgFolder, inbox.parent);
    }
    const [badIncoming, goodIncoming] = accounts.map(item => item.server);
    Assert.notEqual(badIncoming.serverURI, goodIncoming.serverURI);
    const pending = failingFirst
      ? [badIncoming, goodIncoming]
      : [goodIncoming, badIncoming];
    const { promise, resolve } = Promise.withResolvers();
    const completions = [];
    badIncoming.downloadMailFromServers(pending, null, inbox, {
      OnStartRunningUrl() {},
      OnStopRunningUrl(url, status) {
        completions.push({ url, status });
        resolve();
      },
    });
    await promise;
    await new Promise(nextTurn => Services.tm.dispatchToMainThread(nextTurn));
    Assert.deepEqual(completions, [{ url: null, status: Cr.NS_ERROR_FAILURE }]);
    Assert.equal(badDaemon.getTotalMessages(), 1, "Failed source is retained");
    Assert.equal(goodDaemon.getTotalMessages(), 0, "Other account completed");
    do_check_transaction(goodServer.playTransaction(), [
      "CAPA",
      "AUTH PLAIN",
      "STAT",
      "LIST",
      "UIDL",
      "RETR 1",
      "DELE 1",
    ]);
    const messages = [...inbox.messages];
    Assert.equal(messages.length, 1);
    Assert.equal(messages[0].subject, "Deferred download");
    Assert.equal(messages[0].messageId, "deferred-download@example.invalid");
    const raw = mailTestUtils
      .loadMessageToString(inbox, messages[0])
      .replaceAll("\r\n", "\n");
    Assert.equal(
      raw.slice(raw.indexOf("\n\n") + 2),
      "Deferred download body.\n"
    );
    Assert.ok(!inbox.locked, "The destination is unlocked after completion");
  } finally {
    for (const { account } of accounts) {
      MailServices.accounts.removeAccount(account);
    }
    localAccountUtils.clearAll();
    for (const { name, present, value } of prefs) {
      if (present) {
        Services.prefs.setCharPref(name, value);
      } else {
        Services.prefs.clearUserPref(name);
      }
    }
    goodServer.stop();
    badServer.stop();
  }
}

add_task(async function test_deferredFailureBeforeSuccessMbox() {
  await checkDeferredDownloadFailure("mbox", true);
});

add_task(async function test_deferredFailureBeforeSuccessMaildir() {
  await checkDeferredDownloadFailure("maildir", true);
});

add_task(async function test_deferredFailureAfterSuccessMbox() {
  await checkDeferredDownloadFailure("mbox", false);
});

add_task(async function test_deferredFailureAfterSuccessMaildir() {
  await checkDeferredDownloadFailure("maildir", false);
});

add_task(async function test_deferredDownloadOfflineError() {
  localAccountUtils.loadLocalMailAccount();
  const { server: incomingServer, account } =
    localAccountUtils.create_incoming_server_and_account(
      "pop3",
      server.port,
      "fred",
      "wilma"
    );
  incomingServer.deferGetNewMail = true;
  const inbox = localAccountUtils.inboxFolder;
  const previousOffline = Services.io.offline;
  const previousManageOffline = Services.io.manageOfflineStatus;
  const originalKeys = [...inbox.messages].map(hdr => hdr.messageKey);
  try {
    Services.io.manageOfflineStatus = false;
    Services.io.offline = true;
    const { promise, resolve } = Promise.withResolvers();
    const completions = [];
    incomingServer.downloadMailFromServers([incomingServer], null, inbox, {
      OnStartRunningUrl() {},
      OnStopRunningUrl(url, status) {
        completions.push({ url, status });
        resolve();
      },
    });
    await promise;
    Assert.deepEqual(completions, [
      { url: null, status: Cr.NS_MSG_ERROR_OFFLINE },
    ]);
    Assert.deepEqual(
      [...inbox.messages].map(hdr => hdr.messageKey),
      originalKeys
    );
    Assert.ok(!inbox.locked);
    Assert.ok(!incomingServer.serverBusy);
  } finally {
    Services.io.offline = previousOffline;
    Services.io.manageOfflineStatus = previousManageOffline;
    MailServices.accounts.removeAccount(account);
  }
});

/**
 * Exercise both real response handlers with a controlled sink callback.
 * Native provider/copy behavior is tested in test_pop3PartialCompletion.js.
 *
 * @param {string} kind - TOP or RETR response handler.
 * @param {string} mode - Terminal callback/dispatch timing.
 */
async function checkPopCompletionSettlement(kind, mode) {
  const { Pop3Client } = ChromeUtils.importESModule(
    "resource:///modules/Pop3Client.sys.mjs"
  );
  const { LineReader } = ChromeUtils.importESModule(
    "resource:///modules/LineReader.sys.mjs"
  );
  const incoming = createPop3ServerAndLocalFolders(server.port);
  incoming.leaveMessagesOnServer = false;
  const client = new Pop3Client(incoming);
  client._lineReader = new LineReader();
  const message = { messageNumber: 1, uidl: "settlement-uidl" };
  client._currentMessage = message;
  client._messagesToHandle = [];
  client._messageSizeMap = new Map([[1, 100]]);
  client._uidlMap = new Map();
  client._totalReceivedSize = 0;
  client._updateProgress = () => {};
  client._sendNoopIfInactive = () => {};
  const transitions = [];
  const errors = [];
  let completes = 0;
  let aborts = 0;
  let listener;
  client._actionDelete = () => transitions.push("DELE");
  client._actionHandleMessage = () => transitions.push("next");
  client._actionError = (_name, _params, _text, status) => errors.push(status);
  client._sink = {
    incorporateBegin() {},
    incorporateWrite() {},
    incorporateAbort() {
      aborts++;
    },
    incorporateComplete(_window, _size, callback) {
      completes++;
      listener = callback;
      if (mode == "reject") {
        throw Components.Exception(
          "dispatch rejected",
          Cr.NS_ERROR_FILE_ACCESS_DENIED
        );
      }
      if (mode == "reentrant-reject") {
        callback.onStopOperation(Cr.NS_OK);
        throw Components.Exception(
          "dispatch rejected",
          Cr.NS_ERROR_FILE_ACCESS_DENIED
        );
      }
      if (mode == "first-error") {
        callback.onStopOperation(Cr.NS_ERROR_STORAGE_CONSTRAINT);
        throw Components.Exception(
          "later dispatch error",
          Cr.NS_ERROR_FILE_ACCESS_DENIED
        );
      }
      if (mode == "sync") {
        callback.onStopOperation(Cr.NS_OK);
      }
    },
  };
  try {
    const response = {
      status: "+OK",
      success: true,
      data: "Subject: settlement\r\n\r\nbody\r\n.\r\n",
    };
    if (kind == "TOP") {
      client._actionTopResponse(response);
    } else {
      client._actionRetrResponse(response);
    }
    Assert.equal(completes, 1);
    if (["late", "failure", "cancel", "stale"].includes(mode)) {
      Assert.deepEqual(transitions, []);
      Assert.deepEqual(errors, []);
      Assert.equal(client._nextAction, null);
      if (mode == "cancel") {
        client._writeUidlState = async () => {};
        client.quit = async () => {
          client._cleanedUp = true;
        };
        await client._actionDone(Cr.NS_BINDING_ABORTED);
        Assert.equal(client._messagesToHandle[0], message);
      } else if (mode == "stale") {
        client._currentMessage = { messageNumber: 2, uidl: "other" };
      }
      listener.onStopOperation(
        mode == "failure" ? Cr.NS_ERROR_STORAGE_CONSTRAINT : Cr.NS_OK
      );
    }
    let failure = null;
    if (mode == "failure" || mode == "first-error") {
      failure = Cr.NS_ERROR_STORAGE_CONSTRAINT;
    } else if (["reject", "reentrant-reject"].includes(mode)) {
      failure = Cr.NS_ERROR_FILE_ACCESS_DENIED;
    }
    Assert.deepEqual(errors, failure === null ? [] : [failure]);
    Assert.deepEqual(
      transitions,
      failure !== null || ["cancel", "stale"].includes(mode)
        ? []
        : [kind == "TOP" ? "next" : "DELE"]
    );
    Assert.equal(aborts, failure !== null || mode == "cancel" ? 1 : 0);
    listener.onStopOperation(Cr.NS_OK);
    Assert.equal(completes, 1);
    Assert.equal(
      transitions.length,
      failure !== null || ["cancel", "stale"].includes(mode) ? 0 : 1
    );
    Assert.equal(errors.length, failure === null ? 0 : 1);
  } finally {
    MailServices.accounts.removeIncomingServer(incoming, false);
  }
}

add_task(async function test_topCompletionSync() {
  await checkPopCompletionSettlement("TOP", "sync");
});

add_task(async function test_topCompletionLate() {
  await checkPopCompletionSettlement("TOP", "late");
});

add_task(async function test_topCompletionReject() {
  await checkPopCompletionSettlement("TOP", "reject");
});

add_task(async function test_topCompletionReentrantReject() {
  await checkPopCompletionSettlement("TOP", "reentrant-reject");
});

add_task(async function test_topCompletionFirstError() {
  await checkPopCompletionSettlement("TOP", "first-error");
});

add_task(async function test_topCompletionFailure() {
  await checkPopCompletionSettlement("TOP", "failure");
});

add_task(async function test_topCompletionCancel() {
  await checkPopCompletionSettlement("TOP", "cancel");
});

add_task(async function test_topCompletionStale() {
  await checkPopCompletionSettlement("TOP", "stale");
});

add_task(async function test_retrCompletionSync() {
  await checkPopCompletionSettlement("RETR", "sync");
});

add_task(async function test_retrCompletionLate() {
  await checkPopCompletionSettlement("RETR", "late");
});

add_task(async function test_retrCompletionReject() {
  await checkPopCompletionSettlement("RETR", "reject");
});

add_task(async function test_retrCompletionReentrantReject() {
  await checkPopCompletionSettlement("RETR", "reentrant-reject");
});

add_task(async function test_retrCompletionFirstError() {
  await checkPopCompletionSettlement("RETR", "first-error");
});

add_task(async function test_retrCompletionFailure() {
  await checkPopCompletionSettlement("RETR", "failure");
});

add_task(async function test_retrCompletionCancel() {
  await checkPopCompletionSettlement("RETR", "cancel");
});

add_task(async function test_retrCompletionStale() {
  await checkPopCompletionSettlement("RETR", "stale");
});

/**
 * Exercise real UIDL-file persistence with a controlled sink outcome.
 * Native completion and copy faults are tested in test_pop3PartialCompletion.
 *
 * @param {string} mode - Callback timing, cancellation, correlation or I/O fault.
 */
async function checkConfirmedPartialReceipt(mode) {
  const { Pop3Client } = ChromeUtils.importESModule(
    "resource:///modules/Pop3Client.sys.mjs"
  );
  const incoming = createPop3ServerAndLocalFolders(server.port);
  const client = new Pop3Client(incoming);
  const message = {
    messageNumber: 1,
    uidl: "confirmed-uidl",
    status: "f",
    receivedAt: 100,
  };
  const other = { uidl: "other-uidl", status: "f", receivedAt: 200 };
  client._currentMessage = message;
  client._messagesToHandle = [{ ...message }, other];
  client._uidlMap = new Map([[message.uidl, { ...message }]]);
  client._uidlMapChanged = true;
  const stateFile = PathUtils.join(incoming.localPath.path, "popstate.dat");
  const transitions = [];
  const stopped = Promise.withResolvers();
  const originalDone = client._actionDone;
  client._actionDone = async status => {
    await originalDone(status);
    stopped.resolve(status);
  };
  // Keep the real _actionDone and UIDL writer, without opening a test socket.
  client.quit = async () => {
    client._cleanedUp = true;
  };
  let listener;
  let aborts = 0;
  client._sink = {
    confirmedPartialCompletion: mode != "unconfirmed",
    incorporateComplete(_window, _size, callback) {
      listener = callback;
      if (mode == "sync") {
        callback.onStopOperation(Cr.NS_ERROR_STORAGE_CONSTRAINT);
      }
      if (mode == "reentrant-reject") {
        callback.onStopOperation(Cr.NS_OK);
        throw Components.Exception(
          "dispatch failed",
          Cr.NS_ERROR_FILE_ACCESS_DENIED
        );
      }
    },
    incorporateAbort() {
      aborts++;
    },
  };
  const before = Math.floor(Date.now() / 1000);
  try {
    if (mode == "write-failure") {
      await IOUtils.makeDirectory(stateFile);
    }
    client._completeMessage(0, () => transitions.push("next/DELE"));
    if (mode == "cancel") {
      await client._actionDone(Cr.NS_BINDING_ABORTED);
    } else if (mode == "stale-message") {
      client._currentMessage = { ...other };
    } else if (mode == "stale-sink") {
      client._sink = { confirmedPartialCompletion: true };
    }
    if (mode != "sync" && mode != "reentrant-reject") {
      listener.onStopOperation(Cr.NS_ERROR_STORAGE_CONSTRAINT);
    }
    if (mode.startsWith("stale-")) {
      Assert.equal(client._uidlMap.get(message.uidl).status, "f");
      Assert.equal(message.status, "f");
      Assert.ok(!(await IOUtils.exists(stateFile)));
    } else {
      let expected;
      if (mode == "cancel") {
        expected = Cr.NS_BINDING_ABORTED;
      } else if (mode == "reentrant-reject") {
        expected = Cr.NS_ERROR_FILE_ACCESS_DENIED;
      } else {
        expected = Cr.NS_ERROR_STORAGE_CONSTRAINT;
      }
      Assert.equal(await stopped.promise, expected);
      if (mode == "write-failure") {
        Assert.equal((await IOUtils.stat(stateFile)).type, "directory");
        Assert.ok(
          client._uidlMapChanged,
          "Failed persistence is not acknowledged"
        );
        Assert.equal(client._uidlMap.get(message.uidl).status, "k");
      } else {
        const raw = await IOUtils.readUTF8(stateFile);
        const entry = raw
          .split(/\r?\n/)
          .find(line => line.split(" ")[1] == message.uidl);
        const [status, uidl, receivedAt] = entry.split(" ");
        Assert.equal(status, mode == "unconfirmed" ? "f" : "k");
        Assert.equal(uidl, message.uidl);
        if (mode == "unconfirmed") {
          Assert.equal(Number(receivedAt), 100);
        } else {
          Assert.greaterOrEqual(Number(receivedAt), before);
          Assert.lessOrEqual(Number(receivedAt), Math.floor(Date.now() / 1000));
          Assert.equal(
            message.status,
            "k",
            "Error requeue retains the receipt"
          );
        }
        Assert.ok(raw.split(/\r?\n/).includes("f other-uidl 200"));
        listener.onStopOperation(Cr.NS_OK);
        Assert.equal(
          await IOUtils.readUTF8(stateFile),
          raw,
          "Stale callback cannot rewrite state"
        );
      }
      Assert.equal(aborts, mode == "unconfirmed" || mode == "cancel" ? 1 : 0);
    }
    Assert.deepEqual(transitions, []);
  } finally {
    if (mode == "write-failure") {
      await IOUtils.remove(stateFile);
    }
    MailServices.accounts.removeIncomingServer(incoming, false);
  }
}

add_task(async function test_confirmedPartialReceiptSync() {
  await checkConfirmedPartialReceipt("sync");
});
add_task(async function test_confirmedPartialReceiptLate() {
  await checkConfirmedPartialReceipt("late");
});
add_task(async function test_confirmedPartialReceiptCancel() {
  await checkConfirmedPartialReceipt("cancel");
});
add_task(async function test_unconfirmedPartialKeepsFetchState() {
  await checkConfirmedPartialReceipt("unconfirmed");
});
add_task(async function test_confirmedPartialIgnoresDifferentMessage() {
  await checkConfirmedPartialReceipt("stale-message");
});
add_task(async function test_confirmedPartialIgnoresDifferentSink() {
  await checkConfirmedPartialReceipt("stale-sink");
});
add_task(async function test_confirmedPartialReceiptWriteFailure() {
  await checkConfirmedPartialReceipt("write-failure");
});

add_task(async function test_confirmedPartialReceiptReentrantDispatchError() {
  await checkConfirmedPartialReceipt("reentrant-reject");
});
