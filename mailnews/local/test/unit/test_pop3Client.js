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
  const previousStore = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  const [badDaemon, badServer, badHandler] = setupServerDaemon();
  const [goodDaemon, goodServer] = setupServerDaemon();
  const accounts = [];
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
    Services.prefs.setCharPref("mail.serverDefaultStoreContractID", storeID);
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

    for (const popServer of [badServer, goodServer]) {
      const accountAndServer =
        localAccountUtils.create_incoming_server_and_account(
          "pop3",
          popServer.port,
          "fred",
          "wilma"
        );
      accounts.push(accountAndServer);
      accountAndServer.server.deferGetNewMail = true;
      Assert.equal(
        accountAndServer.server.deferredToAccount,
        localAccountUtils.msgAccount.key
      );
      Assert.equal(accountAndServer.server.rootMsgFolder, inbox.parent);
    }
    const [badIncoming, goodIncoming] = accounts.map(item => item.server);
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
    await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
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
    Services.prefs.setCharPref(
      "mail.serverDefaultStoreContractID",
      previousStore
    );
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
