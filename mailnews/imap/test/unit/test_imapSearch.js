/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Tests traditional (non-gloda) search on IMAP folders.
 * Derived from a combination of test_imapPump.js and test_search.js
 * Original author: Kent James <kent@caspia.com>
 */

var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

// headers we will store in db
// set value of headers we want parsed into the db
Services.prefs.setCharPref(
  "mailnews.customDBHeaders",
  "x-spam-status oneliner twoliner threeliner nospace withspace"
);
Assert.equal(
  Services.prefs.getCharPref("mailnews.customDBHeaders"),
  "x-spam-status oneliner twoliner threeliner nospace withspace"
);

// set customHeaders, which post-bug 363238 should get added to the db. Note that all headers but the last
//  seem to end in colon.
Services.prefs.setCharPref(
  "mailnews.customHeaders",
  "x-uidl: x-bugzilla-watch-reason: x-bugzilla-component: received: x-spam-checker-version"
);

// Messages to load must have CRLF line endings, that is Windows style
var gMessage = "bugmail12"; // message file used as the test message

/*
/*
 * Testing of general mail search features.
 *
 * This tests some search attributes not tested by other specific tests,
 * e.g., test_searchTag.js or test_searchJunk.js
 */
/* import-globals-from ../../../test/resources/searchTestUtils.js */
load("../../../resources/searchTestUtils.js");

var Isnt = Ci.nsMsgSearchOp.Isnt;
var Is = Ci.nsMsgSearchOp.Is;
var Contains = Ci.nsMsgSearchOp.Contains;
var BeginsWith = Ci.nsMsgSearchOp.BeginsWith;
var EndsWith = Ci.nsMsgSearchOp.EndsWith;

var OtherHeader = Ci.nsMsgSearchAttrib.OtherHeader;
var From = Ci.nsMsgSearchAttrib.Sender;
var Subject = Ci.nsMsgSearchAttrib.Subject;

var searchTests = [
  // test the To: header
  {
    testString: "PrimaryEmail1@test.invalid",
    testAttribute: From,
    op: Is,
    count: 1,
  },
  {
    testString: "PrimaryEmail1@test.invalid",
    testAttribute: From,
    op: Isnt,
    count: 0,
  },
  {
    testString: "PrimaryEmail",
    testAttribute: From,
    op: BeginsWith,
    count: 1,
  },
  {
    testString: "invalid",
    testAttribute: From,
    op: BeginsWith,
    count: 0,
  },
  {
    testString: "invalid",
    testAttribute: From,
    op: EndsWith,
    count: 1,
  },
  {
    testString: "Primary",
    testAttribute: From,
    op: EndsWith,
    count: 0,
  },
  {
    testString: "QAContact",
    testAttribute: OtherHeader,
    op: BeginsWith,
    count: 1,
  },
  {
    testString: "filters",
    testAttribute: OtherHeader,
    op: BeginsWith,
    count: 0,
  },
  {
    testString: "mail.bugs",
    testAttribute: OtherHeader,
    op: EndsWith,
    count: 1,
  },
  {
    testString: "QAContact",
    testAttribute: OtherHeader,
    op: EndsWith,
    count: 0,
  },
  {
    testString: "QAcontact filters@mail.bugs",
    testAttribute: OtherHeader,
    op: Is,
    count: 1,
  },
  {
    testString: "filters@mail.bugs",
    testAttribute: OtherHeader,
    op: Is,
    count: 0,
  },
  {
    testString: "QAcontact filters@mail.bugs",
    testAttribute: OtherHeader,
    op: Isnt,
    count: 0,
  },
  {
    testString: "QAcontact",
    testAttribute: OtherHeader,
    op: Isnt,
    count: 1,
  },
  {
    testString: "filters",
    testAttribute: OtherHeader,
    op: Contains,
    count: 1,
  },
  {
    testString: "foobar",
    testAttribute: OtherHeader,
    op: Contains,
    count: 0,
  },
  // test accumulation of received header
  {
    // only in first received
    testString: "caspiaco",
    testAttribute: OtherHeader,
    op: Contains,
    customHeader: "Received",
    count: 1,
  },
  {
    // only in second
    testString: "webapp01.sj.mozilla.com",
    testAttribute: OtherHeader,
    op: Contains,
    customHeader: "received",
    count: 1,
  },
  {
    // in neither
    testString: "not there",
    testAttribute: OtherHeader,
    op: Contains,
    customHeader: "received",
    count: 0,
  },
  // test multiple line arbitrary headers
  {
    // in the first line
    testString: "SpamAssassin 3.2.3",
    testAttribute: OtherHeader,
    op: Contains,
    customHeader: "X-Spam-Checker-Version",
    count: 1,
  },
  {
    // in the second line
    testString: "host29.example.com",
    testAttribute: OtherHeader,
    op: Contains,
    customHeader: "X-Spam-Checker-Version",
    count: 1,
  },
  {
    // spans two lines with space
    testString: "on host29.example.com",
    testAttribute: OtherHeader,
    op: Contains,
    customHeader: "X-Spam-Checker-Version",
    count: 1,
  },
  // subject spanning several lines
  {
    // on the first line
    testString: "A filter will",
    testAttribute: Subject,
    op: Contains,
    count: 1,
  },
  {
    testString: "I do not exist",
    testAttribute: Subject,
    op: Contains,
    count: 0,
  },
  {
    // on the second line
    testString: "this message",
    testAttribute: Subject,
    op: Contains,
    count: 1,
  },
  {
    // spanning second and third line
    testString: "over many",
    testAttribute: Subject,
    op: Contains,
    count: 1,
  },
  // tests of custom headers db values
  {
    testString: "a one line header",
    dbHeader: "oneliner",
  },
  {
    testString: "a two line header",
    dbHeader: "twoliner",
  },
  {
    testString: "a three line header with lotsa space and tabs",
    dbHeader: "threeliner",
  },
  {
    testString: "I have no space",
    dbHeader: "nospace",
  },
  {
    testString: "too much space",
    dbHeader: "withspace",
  },
  // tests of custom db headers in a search
  {
    testString: "one line",
    testAttribute: OtherHeader,
    op: Contains,
    customHeader: "oneliner",
    count: 1,
  },
  {
    testString: "two line header",
    testAttribute: OtherHeader,
    op: Contains,
    customHeader: "twoliner",
    count: 1,
  },
  {
    testString: "three line header with lotsa",
    testAttribute: OtherHeader,
    op: Contains,
    customHeader: "threeliner",
    count: 1,
  },
  {
    testString: "I have no space",
    testAttribute: OtherHeader,
    op: Contains,
    customHeader: "nospace",
    count: 1,
  },
  {
    testString: "too much space",
    testAttribute: OtherHeader,
    op: Contains,
    customHeader: "withspace",
    count: 1,
  },
];

let panorama;

add_setup(async function () {
  const contract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  Services.prefs.setCharPref("mail.server.default.storeContractID", contract);
  setupIMAPPump();
  panorama = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.equal(
    "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
    panorama
  );
  Assert.equal(
    IMAPPump.incomingServer.msgStore.storeType,
    {
      "@mozilla.org/msgstore/berkeleystore;1": "mbox",
      "@mozilla.org/msgstore/maildirstore;1": "maildir",
    }[contract]
  );
  const discovered = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(
    IMAPPump.incomingServer.rootFolder,
    discovered,
    null
  );
  await discovered.promise;
  IMAPPump.inbox = IMAPPump.incomingServer.rootFolder
    .getChildNamed("INBOX")
    .QueryInterface(Ci.nsIMsgImapMailFolder);

  // don't use offline store
  IMAPPump.inbox.clearFlag(Ci.nsMsgFolderFlags.Offline);

  // Load imap message.
  IMAPPump.mailbox.addMessage(
    new ImapMessage(specForFileName(gMessage), IMAPPump.mailbox.uidnext++, [])
  );
  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, listener);
  await listener.promise;

  Assert.equal(1, IMAPPump.inbox.getTotalMessages(false));
});

// process each test from queue, calls itself upon completion of each search
add_task(async function testSearch() {
  while (searchTests.length) {
    const test = searchTests.shift();
    if (test.dbHeader) {
      // Test of a custom db header.
      const customValue = mailTestUtils
        .firstMsgHdr(IMAPPump.inbox)
        .getStringProperty(test.dbHeader);
      Assert.equal(customValue, test.testString);
    } else {
      await new Promise(resolve => {
        new TestSearch(
          IMAPPump.inbox,
          test.testString,
          test.testAttribute,
          test.op,
          test.count,
          resolve,
          null,
          test.customHeader ? test.customHeader : "X-Bugzilla-Watch-Reason"
        );
      });
    }
  }
});

add_task(async function test_onlineSearchUsesPhysicalFolderKeys() {
  const first = await createSearchFolder(
    "SearchFirst",
    "search-first@example.invalid",
    7301
  );
  const second = await createSearchFolder(
    "SearchSecond",
    "search-second@example.invalid",
    7401
  );
  if (panorama) {
    Assert.notEqual(first.header.messageKey, 8101);
    Assert.notEqual(second.header.messageKey, 8101);
    Assert.notEqual(first.header.messageKey, second.header.messageKey);
  }
  for (const state of [first, second]) {
    const result = await onlineSearch(state.folder);
    Assert.equal(result.status, Cr.NS_OK);
    Assert.equal(result.starts, 1);
    Assert.equal(result.stops, 1);
    Assert.deepEqual(
      result.hits.map(header => [
        header.folder,
        header.messageKey,
        header.messageId,
      ]),
      [[state.folder, state.header.messageKey, state.id]]
    );
    Assert.deepEqual(
      state.mailbox._messages.map(message => message.uid),
      [8101]
    );
  }
});

add_task(async function test_onlineSearchReportsMalformedUidsAndCanRetry() {
  const state = await createSearchFolder(
    "SearchMalformed",
    "search-malformed@example.invalid",
    7501
  );
  const deleted = [];
  const listener = {
    msgsDeleted(headers) {
      deleted.push(...headers);
    },
  };
  MailServices.mfn.addListener(
    listener,
    Ci.nsIMsgFolderNotificationService.msgsDeleted
  );
  try {
    for (const badUid of ["invalid", 0, 4294967296]) {
      // Keep the connection selected so this isolates SEARCH response parsing.
      Assert.equal((await onlineSearch(state.folder)).status, Cr.NS_OK);
      const before = searchCommands().length;
      state.message.uid = badUid;
      let result;
      try {
        result = await onlineSearch(state.folder);
      } finally {
        state.message.uid = 8101;
      }
      Assert.equal(
        searchCommands().length,
        before + 1,
        "The real UID SEARCH reached the fake server"
      );
      Assert.equal(result.status, Cr.NS_ERROR_ILLEGAL_VALUE);
      Assert.equal(result.starts, 1);
      Assert.equal(result.stops, 1);
      Assert.deepEqual(result.hits, []);
      Assert.deepEqual(
        Array.from(state.folder.messages, header => header.messageKey),
        [state.header.messageKey]
      );
      Assert.equal(state.header.messageId, state.id);
      Assert.equal(state.message.getText(), state.raw);
      Assert.deepEqual(deleted, []);
      const retry = await onlineSearch(state.folder);
      Assert.equal(retry.status, Cr.NS_OK);
      Assert.deepEqual(
        retry.hits.map(header => header.messageKey),
        [state.header.messageKey]
      );
    }
  } finally {
    MailServices.mfn.removeListener(listener);
  }
});

add_task(
  async function test_onlineSearchReportsAnUnsynchronizedUidAndCanRetry() {
    const state = await createSearchFolder(
      "SearchArrival",
      "search-known@example.invalid",
      7601
    );
    Assert.equal((await onlineSearch(state.folder)).status, Cr.NS_OK);
    const flags = state.header.flags;
    const token = state.header.storeToken;
    const raw = state.raw.replaceAll(
      state.id,
      "search-arriving@example.invalid"
    );
    const arriving = new ImapMessage(
      "data:text/plain;base64," + btoa(raw),
      8103,
      []
    );
    state.mailbox.addMessage(arriving);
    const before = searchCommands().length;
    const result = await onlineSearch(state.folder);
    Assert.equal(searchCommands().length, before + 1);
    Assert.equal(
      result.status,
      panorama ? Cr.NS_ERROR_NOT_AVAILABLE : Cr.NS_OK
    );
    Assert.equal(result.starts, 1);
    Assert.equal(result.stops, 1);
    Assert.deepEqual(
      result.hits.map(header => header.messageKey),
      [state.header.messageKey]
    );
    Assert.deepEqual(
      Array.from(state.folder.messages, header => header.messageKey),
      [state.header.messageKey]
    );
    Assert.equal(state.header.flags, flags);
    Assert.equal(state.header.storeToken, token);
    Assert.equal(state.message.getText(), state.raw);
    Assert.equal(arriving.getText(), raw);
    Assert.deepEqual(
      state.mailbox._messages.map(message => message.uid),
      [8101, 8103]
    );

    // A real folder synchronization supplies the missing binding before retry.
    const selected = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.selectFolder(state.folder, selected, null);
    await selected.promise;
    const header = state.folder.msgDatabase.getMsgHdrForMessageID(
      "search-arriving@example.invalid"
    );
    Assert.ok(header);
    Assert.equal(header.folder, state.folder);
    if (panorama) {
      Assert.notEqual(header.messageKey, 8103);
      Assert.equal(header.getUint32Property("uidOnServer"), 8103);
    }
    const retry = await onlineSearch(state.folder);
    Assert.equal(retry.status, Cr.NS_OK);
    Assert.deepEqual(
      retry.hits.map(hit => hit.messageId),
      [state.id, "search-arriving@example.invalid"]
    );
    Assert.deepEqual(
      retry.hits.map(hit => hit.messageKey),
      [state.header.messageKey, header.messageKey]
    );
    Assert.equal(state.message.getText(), state.raw);
    Assert.equal(arriving.getText(), raw);
  }
);

add_task(async function test_onlineSearchInUnselectedEmptyFolder() {
  const { folder, mailbox } = await createUnselectedSearchFolder(
    "SearchUnselectedEmpty",
    7501
  );
  const before = searchCommands().length;
  const result = await onlineSearch(folder);
  Assert.equal(result.status, Cr.NS_OK);
  Assert.equal(result.starts, 1);
  Assert.equal(result.stops, 1);
  Assert.deepEqual(result.hits, []);
  Assert.equal(searchCommands().length, before + 1);
  Assert.deepEqual(Array.from(folder.messages), []);
  Assert.deepEqual(mailbox._messages, []);
});

add_task(async function test_onlineSearchInUnselectedPopulatedFolder() {
  const { folder, mailbox } = await createUnselectedSearchFolder(
    "SearchUnselectedPopulated",
    7601
  );
  const raw =
    "From: sender@example.invalid\r\n" +
    "Message-ID: <unselected-search@example.invalid>\r\n" +
    "Subject: Search identity\r\n\r\nUnselected bytes stay intact.\r\n";
  const message = new ImapMessage(
    "data:text/plain;base64," + btoa(raw),
    8105,
    []
  );
  mailbox.addMessage(message);
  const before = searchCommands().length;
  const result = await onlineSearch(folder);
  Assert.equal(result.status, panorama ? Cr.NS_ERROR_NOT_AVAILABLE : Cr.NS_OK);
  Assert.equal(result.starts, 1);
  Assert.equal(result.stops, 1);
  if (panorama) {
    Assert.deepEqual(result.hits, []);
  } else {
    Assert.deepEqual(
      result.hits.map(hit => hit.messageId),
      ["unselected-search@example.invalid"]
    );
    Assert.deepEqual(
      result.hits.map(hit => hit.messageKey),
      [8105]
    );
    Assert.equal(result.hits[0].folder, folder);
  }
  Assert.equal(searchCommands().length, before + 1);
  Assert.deepEqual(
    mailbox._messages.map(item => item.uid),
    [8105]
  );
  Assert.equal(message.getText(), raw);

  const selected = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.selectFolder(folder, selected, null);
  await selected.promise;
  const [header] = folder.messages;
  Assert.equal(header.messageId, "unselected-search@example.invalid");
  Assert.equal(header.folder, folder);
  Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 7601);
  if (panorama) {
    Assert.notEqual(header.messageKey, 8105);
    Assert.equal(header.getUint32Property("uidOnServer"), 8105);
  } else {
    Assert.equal(header.messageKey, 8105);
  }
  const retry = await onlineSearch(folder);
  Assert.equal(retry.status, Cr.NS_OK);
  Assert.equal(retry.starts, 1);
  Assert.equal(retry.stops, 1);
  Assert.deepEqual(
    retry.hits.map(hit => hit.messageKey),
    [header.messageKey]
  );
  Assert.deepEqual(
    retry.hits.map(hit => hit.messageId),
    ["unselected-search@example.invalid"]
  );
  Assert.deepEqual(
    mailbox._messages.map(item => item.uid),
    [8105]
  );
  Assert.equal(message.getText(), raw);
});

/**
 * Creates an actual remote folder without a SELECT or a seeded client header.
 *
 * @param {string} name - The server mailbox name.
 * @param {number} epoch - The server UIDVALIDITY.
 * @returns {Promise<{folder: nsIMsgImapMailFolder, mailbox: ImapMailbox}>}
 *   The unsynchronized client folder and its real server mailbox.
 */
async function createUnselectedSearchFolder(name, epoch) {
  const root = IMAPPump.incomingServer.rootFolder;
  const created = new PromiseTestUtils.PromiseUrlListener();
  root
    .QueryInterface(Ci.nsIMsgImapMailFolder)
    .createSubfolderWithListener(name, created);
  await created.promise;
  const folder = root
    .getChildNamed(name)
    .QueryInterface(Ci.nsIMsgImapMailFolder);
  folder.clearFlag(Ci.nsMsgFolderFlags.Offline);
  Assert.equal(
    folder.msgStore.storeType,
    IMAPPump.incomingServer.msgStore.storeType
  );
  Assert.deepEqual(Array.from(folder.messages), []);
  if (panorama) {
    Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 0);
  }
  const mailbox = IMAPPump.daemon.getMailbox(name);
  mailbox.uidvalidity = epoch;
  return { folder, mailbox };
}

/**
 * Creates and synchronizes one actual server message in an independent folder.
 *
 * @param {string} name - The remote folder name.
 * @param {string} id - The literal Message-ID.
 * @param {number} epoch - The server UIDVALIDITY.
 * @returns {Promise<{folder: nsIMsgImapMailFolder, header: nsIMsgDBHdr,
 *   mailbox: ImapMailbox, message: ImapMessage, raw: string, id: string}>}
 *   The retained client and server state.
 */
async function createSearchFolder(name, id, epoch) {
  const root = IMAPPump.incomingServer.rootFolder;
  const created = new PromiseTestUtils.PromiseUrlListener();
  root
    .QueryInterface(Ci.nsIMsgImapMailFolder)
    .createSubfolderWithListener(name, created);
  await created.promise;
  const folder = root
    .getChildNamed(name)
    .QueryInterface(Ci.nsIMsgImapMailFolder);
  folder.clearFlag(Ci.nsMsgFolderFlags.Offline);
  const mailbox = IMAPPump.daemon.getMailbox(name);
  mailbox.uidvalidity = epoch;
  const raw = [
    "From: sender@example.invalid",
    "To: recipient@example.invalid",
    "Message-ID: <" + id + ">",
    "Subject: Search identity",
    "",
    "Retained bytes for " + id,
    "",
  ].join("\r\n");
  const message = new ImapMessage(
    "data:text/plain;base64," + btoa(raw),
    8101,
    []
  );
  mailbox.addMessage(message);
  const selected = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.selectFolder(folder, selected, null);
  await selected.promise;
  const headers = Array.from(folder.messages);
  Assert.equal(headers.length, 1);
  const header = headers[0];
  Assert.equal(header.messageId, id);
  Assert.equal(header.folder, folder);
  Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, epoch);
  if (panorama) {
    Assert.equal(header.getUint32Property("uidOnServer"), 8101);
  }
  return { folder, header, mailbox, message, raw, id };
}

/**
 * Runs an online subject search through the actual search session and IMAP URL.
 *
 * @param {nsIMsgFolder} folder - The physical folder to search.
 * @returns {Promise<{status: number, starts: number, stops: number,
 *   hits: nsIMsgDBHdr[]}>} Actual completion and delivered headers.
 */
async function onlineSearch(folder) {
  const session = Cc["@mozilla.org/messenger/searchSession;1"].createInstance(
    Ci.nsIMsgSearchSession
  );
  session.addScopeTerm(Ci.nsMsgSearchScope.onlineMail, folder);
  const term = session.createTerm();
  term.attrib = Ci.nsMsgSearchAttrib.Subject;
  const value = term.value;
  value.attrib = term.attrib;
  value.str = "Search identity";
  term.value = value;
  term.op = Ci.nsMsgSearchOp.Contains;
  session.appendTerm(term);
  const result = { status: Cr.NS_OK, starts: 0, stops: 0, hits: [] };
  let resolve;
  const done = new Promise(finish => {
    resolve = finish;
  });
  const listener = {
    onNewSearch() {
      result.starts++;
    },
    onSearchHit(header) {
      result.hits.push(header);
    },
    onSearchDone(status) {
      result.status = status;
      result.stops++;
      resolve(result);
    },
  };
  session.registerListener(listener);
  try {
    session.search(null);
    return await done;
  } finally {
    session.unregisterListener(listener);
  }
}

/**
 * Returns the real server's received UID SEARCH commands.
 *
 * @returns {string[]} Received commands from all actual connections.
 */
function searchCommands() {
  const transactions = IMAPPump.server.playTransaction();
  return (Array.isArray(transactions) ? transactions : [transactions])
    .flatMap(transaction => transaction.them)
    .filter(command => / UID SEARCH /i.test(command));
}

// Cleanup at end
add_task(function endTest() {
  teardownIMAPPump();
});

/*
 * helper function
 */

// given a test file, return the file uri spec
function specForFileName(aFileName) {
  const file = do_get_file("../../../data/" + aFileName);
  const msgfileuri = Services.io.newFileURI(file).QueryInterface(Ci.nsIFileURL);
  return msgfileuri.spec;
}
