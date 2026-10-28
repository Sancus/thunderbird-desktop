/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Test that pop3 download code and message storage works correctly.
 */

const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

const [daemon, server, handler] = setupServerDaemon();
server.start();
registerCleanupFunction(() => {
  server.stop();
});

/**
 * Helper function to parse an RFC5322 message.
 * Not totally comprehensive, but good enough for tests.
 *
 * For example:
 *   parseMessage("From: Alice\r\nTo: Bob\r\n\r\nHello there!\r\n")
 *
 * Returns:
 *   [{"From":["Alice"], "To": "Bob"}, "Hello there!\r\n"]
 *
 * NOTE: The returned header values are arrays because headers can repeat.
 *
 */
function parseMessage(raw) {
  // Mbox separators are more common than you'd like in test data.
  // We'll tolerate and discard them.
  raw = raw.replace("/^From .*\r?\n/", "");

  // Split header block and body.
  const headerBody = raw.match(/(.*?)\r?\n\r?\n(.*)/s);
  const body = headerBody[2];

  // Parse the headers.
  const headers = {};
  // Flatten any multi-line headers (delete any EOL followed by whitespace).
  const rawHdrs = headerBody[1].replaceAll(/\r?\n(\s)/g, "$1");
  const headerLines = rawHdrs.split(/\r?\n/);
  for (const line of headerLines) {
    // Split "name: value".
    const m = line.match(/^([^\s:]+):\s+(.*)$/);
    if (m == null) {
      continue; // Uh-oh... Bad header.
    }
    const name = m[1];
    // Headers can have multiple values.
    headers[name] ??= [];
    headers[name].push(m[2]);
  }

  return [headers, body];
}

// For Bug 713611.
Services.prefs.setBoolPref("mailnews.downloadToTempFile", false);

/**
 * Test that messages download correctly, and have some of the basic headers
 * correctly parsed.
 */
add_task(async function testDownloadMessages() {
  const incomingServer = createPop3ServerAndLocalFolders(server.port);

  const testMessages = [
    "message1.eml",
    "message_with_from_line.eml",
    "message2.eml",
    "message3.eml",
  ];

  incomingServer.leaveMessagesOnServer = true;

  // Read our original test messages directly from disk.
  const expectRaw = [];
  for (const filename of testMessages) {
    const f = PathUtils.join(do_get_cwd().path, "data", filename);
    expectRaw.push(await IOUtils.readUTF8(f));
  }

  // Inject test messages into POP3 server, and fetch them.
  daemon.setMessages(testMessages);
  const urlListener = new PromiseTestUtils.PromiseUrlListener();
  MailServices.pop3.GetNewMail(
    null,
    urlListener,
    localAccountUtils.inboxFolder,
    incomingServer
  );
  await urlListener.promise;

  // Collect the downloaded messages back out from the folder.
  const gotMsgHdrs = [];
  const gotRaw = [];
  for (const msgHdr of localAccountUtils.inboxFolder.messages) {
    const streamListener = new PromiseTestUtils.PromiseStreamListener();
    const msgURI = msgHdr.folder.getUriForMsg(msgHdr);
    MailServices.messageServiceFromURI(msgURI).streamMessage(
      msgURI,
      streamListener,
      null,
      null,
      false,
      "",
      false
    );

    gotRaw.push(await streamListener.promise);
    gotMsgHdrs.push(msgHdr);
  }

  // Check each downloaded message against what we're expecting.
  // We're assuming the same ordering, which is a bit dodgy, but
  // fine for our fake test server.
  Assert.equal(
    expectRaw.length,
    gotRaw.length,
    "Download correct number of messages"
  );

  // Some headers we want to strip out (because they are added by pop3 and
  // the local message store):
  const blacklist = [
    // POP3 additions:
    "X-UIDL",
    "X-Account-Key",
    // msgStore additions:
    "X-Mozilla-Status",
    "X-Mozilla-Status2",
    "X-Mozilla-Keys",
  ];

  // Check the downloaded messages against the expected data.
  for (let i = 0; i < expectRaw.length; ++i) {
    // Parse the message.
    let [expectHeaders, expectBody] = parseMessage(expectRaw[i]);
    let [gotHeaders, gotBody] = parseMessage(gotRaw[i]);
    // Strip blacklisted headers.
    for (const bad of blacklist) {
      delete gotHeaders[bad];
      delete expectHeaders[bad];
    }

    // Normalise EOLs and compare body.
    expectBody = gotBody.replaceAll(/\r\n/gs, "\n");
    gotBody = gotBody.replaceAll(/\r\n/gs, "\n");
    Assert.equal(expectBody, gotBody, "Message bodies match");

    // Compare headers (stripping out ones that might have added).
    Assert.deepEqual(expectHeaders, gotHeaders, "Message headers match");

    // Check the msgDB has correct subject (Bug 1888790).
    if ("Subject" in expectHeaders) {
      Assert.equal(
        gotMsgHdrs[i].subject,
        expectHeaders.Subject.join(","),
        "Parsed subject matches"
      );
    }
  }

  // Clean up.
  MailServices.accounts.removeIncomingServer(incomingServer, false);
});

const POP3_STORES = {
  mbox: "@mozilla.org/msgstore/berkeleystore;1",
  maildir: "@mozilla.org/msgstore/maildirstore;1",
};

/**
 * Run with a real deferred POP3 account and the selected local store.
 *
 * @param {string} store - Store type.
 * @param {function(nsIPop3IncomingServer, nsIMsgLocalMailFolder): Promise<void>} fn
 */
async function withPop3Store(store, fn) {
  localAccountUtils.clearAll();
  Services.prefs.setCharPref(
    "mail.serverDefaultStoreContractID",
    POP3_STORES[store]
  );
  localAccountUtils.loadLocalMailAccount();
  const { server: incomingServer, account } =
    localAccountUtils.create_incoming_server_and_account(
      "pop3",
      server.port,
      "fred",
      "wilma"
    );
  const folder = localAccountUtils.inboxFolder;
  try {
    Assert.equal(folder.msgStore.storeType, store);
    const dbService = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    );
    Assert.equal(
      "nsIDatabaseCore" in Ci && dbService instanceof Ci.nsIDatabaseCore,
      Services.prefs.getBoolPref("mail.panorama.enabled", false),
      "The active database service matches the selected backend"
    );
    Assert.equal(dbService.openFolderDB(folder, false), folder.msgDatabase);
    Assert.equal(folder.server.msgStore.storeType, store);
    await fn(incomingServer, folder);
  } finally {
    MailServices.accounts.removeAccount(account);
    localAccountUtils.clearAll();
  }
}

/**
 * Read exact message bytes from the selected provider.
 *
 * @param {nsIMsgFolder} folder - Message folder.
 * @param {string} token - Provider token.
 * @returns {string} Stored message bytes.
 */
function readPop3StoredMessage(folder, token) {
  const stream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
    Ci.nsIScriptableInputStream
  );
  stream.init(folder.msgStore.getMsgInputStream(folder, token, 0));
  try {
    let raw = "";
    let chunk;
    while ((chunk = stream.read(4096))) {
      raw += chunk;
    }
    return raw;
  } finally {
    stream.close();
  }
}

/**
 * Configure the real POP3 sink and deliver one message line at a time.
 *
 * @param {nsIPop3IncomingServer} incomingServer - Source account.
 * @param {nsIMsgLocalMailFolder} folder - Destination.
 * @returns {nsIPop3Sink} Sink with an unfinished message.
 */
function beginPop3Message(incomingServer, folder) {
  const sink = Cc["@mozilla.org/messenger/pop3-sink;1"].createInstance(
    Ci.nsIPop3Sink
  );
  sink.popServer = incomingServer;
  sink.folder = folder;
  sink.beginMailDelivery(true, null);
  sink.incorporateBegin("unfinished-uidl", 0);
  for (const line of [
    "From: sender@example.invalid\r\n",
    "Subject: Unfinished POP3 message\r\n",
    "\r\n",
    "Unfinished body.\r\n",
  ]) {
    sink.incorporateWrite(line, line.length);
  }
  return sink;
}

async function checkPop3Abort(incomingServer, folder) {
  const raw = "Subject: Original POP3 body\r\n\r\nOriginal body.\r\n";
  const original = folder.addMessage(raw);
  const key = original.messageKey;
  const token = original.storeToken;
  const sink = beginPop3Message(incomingServer, folder);
  try {
    sink.incorporateAbort();
    sink.endMailDelivery(null);
  } finally {
    sink.abortMailDelivery(null);
  }
  Assert.ok(!folder.locked);
  Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
  Assert.equal(folder.msgDatabase.getMsgHdrForKey(key).storeToken, token);
  Assert.equal(readPop3StoredMessage(folder, token), raw);
  const scan = new PromiseTestUtils.PromiseStoreScanListener();
  folder.msgStore.asyncScan(folder, scan);
  await scan.promise;
  Assert.deepEqual(scan.messages, [raw]);
  Assert.deepEqual(scan.tokens, [token]);
}

add_task(async function testPop3AbortMbox() {
  await withPop3Store("mbox", checkPop3Abort);
});

add_task(async function testPop3AbortMaildir() {
  await withPop3Store("maildir", checkPop3Abort);
});

add_task(async function testPop3FinishFailureRetainsMaildirWrite() {
  await withPop3Store("maildir", async (incomingServer, folder) => {
    const raw = "Subject: Before POP3 Finish failure\r\n\r\nOriginal body.\r\n";
    const original = folder.addMessage(raw);
    const token = original.storeToken;
    const key = original.messageKey;
    const db = folder.msgDatabase;
    const sink = beginPop3Message(incomingServer, folder);
    const cur = PathUtils.join(folder.filePath.path, "cur");
    const saved = cur + "-saved";
    await IOUtils.move(cur, saved, { noOverwrite: true });
    try {
      await IOUtils.writeUTF8(cur, "A file cannot be a maildir destination.");
      Assert.throws(
        () => sink.incorporateComplete(null, 0),
        error => error.result === Cr.NS_ERROR_FILE_DESTINATION_NOT_DIR
      );
      const pending = await IOUtils.getChildren(
        PathUtils.join(folder.filePath.path, "tmp")
      );
      Assert.equal(pending.length, 1);
      const bytes = await IOUtils.read(pending[0]);
      Assert.ok(bytes.length > 0);
      for (const finish of [
        () => sink.incorporateComplete(null, 0),
        () => sink.incorporateAbort(),
        () => sink.endMailDelivery(null),
      ]) {
        Assert.throws(
          finish,
          error => error.result === Cr.NS_ERROR_FILE_DESTINATION_NOT_DIR,
          "Cleanup retains the original Finish error"
        );
        Assert.deepEqual(await IOUtils.read(pending[0]), bytes);
      }
      Assert.deepEqual(db.listAllKeys(), [key]);
      Assert.ok(!folder.locked);
    } finally {
      await IOUtils.remove(cur, { ignoreAbsent: true });
      await IOUtils.move(saved, cur, { noOverwrite: true });
      try {
        sink.abortMailDelivery(null);
      } catch (error) {
        if (error.result !== Cr.NS_ERROR_FILE_DESTINATION_NOT_DIR) {
          throw error;
        }
      }
    }
    Assert.equal(folder.msgDatabase.getMsgHdrForKey(key).storeToken, token);
    Assert.equal(readPop3StoredMessage(folder, token), raw);
  });
});

/**
 * Fetch mail and record the actual URL listener status.
 *
 * @param {nsIPop3IncomingServer} incomingServer - Source account.
 * @param {nsIMsgFolder} folder - Destination.
 * @returns {Promise<object>} Actual start/stop counts and status.
 */
async function fetchPop3ForStatus(incomingServer, folder) {
  const result = { starts: 0, stops: 0, status: undefined };
  const listener = new PromiseTestUtils.PromiseUrlListener({
    OnStartRunningUrl() {
      result.starts++;
    },
    OnStopRunningUrl(_url, status) {
      result.stops++;
      result.status = status;
    },
  });
  MailServices.pop3.GetNewMail(null, listener, folder, incomingServer);
  await listener.promise.catch(() => {});
  return result;
}

async function checkPop3PublicationFailure(incomingServer, folder) {
  Assert.ok(Services.prefs.getBoolPref("mail.panorama.enabled"));
  incomingServer.leaveMessagesOnServer = false;
  const database = Cc["@mozilla.org/mailnews/database-core;1"].getService(
    Ci.nsIDatabaseCore
  );
  const connection = database.connectionForTests;
  let faults = 0;
  const scan = new PromiseTestUtils.PromiseStoreScanListener();
  connection.createFunction("pop3_publication_fault", 0, {
    onFunctionCall() {
      faults++;
      return 0;
    },
  });
  try {
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER pop3_publication_fault BEFORE INSERT ON main.messages " +
        "WHEN NEW.subject = 'test mail' BEGIN " +
        "SELECT pop3_publication_fault(); " +
        "SELECT RAISE(ABORT, 'POP3 publication failure'); END"
    );
    daemon.setMessages(["message1.eml"]);
    Assert.deepEqual(await fetchPop3ForStatus(incomingServer, folder), {
      starts: 1,
      stops: 1,
      status: Cr.NS_ERROR_STORAGE_CONSTRAINT,
    });
    Assert.equal(faults, 1, "The real SQL insertion reached the fault");
    Assert.equal(daemon.getTotalMessages(), 1, "Failed delivery does not DELE");
    Assert.deepEqual(folder.msgDatabase.listAllKeys(), []);
    Assert.ok(!folder.locked);
    folder.msgStore.asyncScan(folder, scan);
    await scan.promise;
    Assert.equal(scan.tokens.length, 1, "Finished bytes remain unpublished");
    Assert.equal(
      parseMessage(scan.messages[0])[1].replaceAll("\r\n", "\n"),
      "this email is in dos format because that is what the interface requires\n\ntest message\n"
    );
  } finally {
    try {
      connection.executeSimpleSQL(
        "DROP TRIGGER IF EXISTS temp.pop3_publication_fault"
      );
    } finally {
      connection.removeFunction("pop3_publication_fault");
    }
  }
  const retainedToken = scan.tokens[0];
  const retainedBytes = readPop3StoredMessage(folder, retainedToken);
  Assert.deepEqual(await fetchPop3ForStatus(incomingServer, folder), {
    starts: 1,
    stops: 1,
    status: Cr.NS_OK,
  });
  Assert.equal(daemon.getTotalMessages(), 0, "Successful retry can DELE");
  const headers = [...folder.messages];
  Assert.equal(headers.length, 1);
  Assert.equal(headers[0].subject, "test mail");
  Assert.equal(
    parseMessage(
      readPop3StoredMessage(folder, headers[0].storeToken)
    )[1].replaceAll("\r\n", "\n"),
    "this email is in dos format because that is what the interface requires\n\ntest message\n"
  );
  Assert.equal(readPop3StoredMessage(folder, retainedToken), retainedBytes);
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function testPop3PublicationFailureMbox() {
    await withPop3Store("mbox", checkPop3PublicationFailure);
  });

  add_task(async function testPop3PublicationFailureMaildir() {
    await withPop3Store("maildir", checkPop3PublicationFailure);
  });
}

/**
 * Keep published POP3 mail when the real template-reply action refuses it.
 *
 * @param {string} store - Destination store type.
 * @param {boolean} noReplyAddress - Omit From and Reply-To instead of addressing
 *   the message to someone outside the account.
 */
async function checkPop3ReplyFailure(store, noReplyAddress) {
  await withPop3Store(store, async (incomingServer, folder) => {
    const account = MailServices.accounts.findAccountForServer(incomingServer);
    const identity = MailServices.accounts.createIdentity();
    identity.email = "recipient@example.invalid";
    account.addIdentity(identity);
    const templates = localAccountUtils.rootFolder
      .createLocalSubfolder("Templates")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    Assert.equal(templates.msgStore.storeType, store);
    const template = templates.addMessage(
      "From: recipient@example.invalid\r\n" +
        "Subject: Auto reply template\r\n" +
        "Message-ID: <pop3-reply-template@example.invalid>\r\n" +
        "Date: Tue, 01 Jan 2019 12:00:00 +0000\r\n" +
        "\r\n" +
        "Template body.\r\n"
    );
    const filters = incomingServer.getFilterList(null);
    const filter = filters.createFilter("Reply is best effort");
    const term = filter.createTerm();
    term.matchAll = true;
    filter.appendTerm(term);
    const action = filter.createAction();
    action.type = Ci.nsMsgFilterAction.Reply;
    action.strValue =
      templates.URI +
      "?messageId=" +
      template.messageId +
      "&subject=" +
      template.subject;
    filter.appendAction(action);
    filter.enabled = true;
    filter.filterType = Ci.nsMsgFilterType.InboxRule;
    filters.insertFilterAt(0, filter);
    filters.loggingEnabled = true;
    try {
      server.resetTest();
      incomingServer.leaveMessagesOnServer = false;
      daemon.setMessages([
        {
          fileData:
            (noReplyAddress ? "" : "From: sender@example.invalid\r\n") +
            (noReplyAddress
              ? "To: recipient@example.invalid\r\n"
              : "To: someone-else@example.invalid\r\n") +
            "Subject: Reply action does not undo delivery\r\n" +
            "Message-ID: <pop3-best-effort-reply@example.invalid>\r\n" +
            "Date: Tue, 01 Jan 2019 12:00:00 +0000\r\n" +
            "\r\n" +
            "Published POP3 body.\r\n",
        },
      ]);
      Assert.deepEqual(await fetchPop3ForStatus(incomingServer, folder), {
        starts: 1,
        stops: 1,
        status: Cr.NS_OK,
      });
      Assert.equal(daemon.getTotalMessages(), 0, "Delivery reaches DELE");
      do_check_transaction(server.playTransaction(), [
        "CAPA",
        "AUTH PLAIN",
        "STAT",
        "LIST",
        "UIDL",
        "RETR 1",
        "DELE 1",
      ]);
      const messages = [...folder.messages];
      Assert.equal(messages.length, 1);
      Assert.equal(messages[0].subject, "Reply action does not undo delivery");
      Assert.equal(
        parseMessage(
          readPop3StoredMessage(folder, messages[0].storeToken)
        )[1].replaceAll("\r\n", "\n"),
        "Published POP3 body.\n"
      );
      Assert.ok(!folder.locked);
      filters.loggingEnabled = false;
      const logFile = Services.io
        .newURI(filters.logURL)
        .QueryInterface(Ci.nsIFileURL).file;
      const log = await IOUtils.readUTF8(logFile.path);
      Assert.ok(
        log.includes(noReplyAddress ? "0x80004005" : "0x80004004"),
        "The real reply action logged its failure after publication"
      );
      Assert.deepEqual(await fetchPop3ForStatus(incomingServer, folder), {
        starts: 1,
        stops: 1,
        status: Cr.NS_OK,
      });
      Assert.deepEqual(
        folder.msgDatabase.listAllKeys(),
        [messages[0].messageKey],
        "The next mail check does not publish a duplicate"
      );
    } finally {
      filters.loggingEnabled = false;
      filters.removeFilter(filter);
    }
  });
}

add_task(async function testPop3UnaddressedReplyMbox() {
  await checkPop3ReplyFailure("mbox", false);
});

add_task(async function testPop3UnaddressedReplyMaildir() {
  await checkPop3ReplyFailure("maildir", false);
});

add_task(async function testPop3ReplyWithoutRecipientMbox() {
  await checkPop3ReplyFailure("mbox", true);
});

add_task(async function testPop3ReplyWithoutRecipientMaildir() {
  await checkPop3ReplyFailure("maildir", true);
});
