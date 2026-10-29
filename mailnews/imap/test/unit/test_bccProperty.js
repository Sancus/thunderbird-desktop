/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Test to ensure that BCC gets added to message headers on IMAP download
 *
 * adapted from test_downloadOffline.js
 *
 * original author Kent James <kent@caspia.com>
 */

var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const panorama = Services.prefs.getBoolPref("mail.panorama.enabled", false);
const published = [];

var gFileName = "draft1";
var gMsgFile = do_get_file("../../../data/" + gFileName);

add_setup(async function () {
  const contract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  Services.prefs.setCharPref("mail.server.default.storeContractID", contract);
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
  Services.prefs.setCharPref("mailnews.customDBHeaders", "x-publication");
  setupIMAPPump();
  registerCleanupFunction(() => {
    if (IMAPPump.incomingServer) {
      teardownIMAPPump();
    }
  });
  const discovery = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(
    IMAPPump.incomingServer.rootFolder,
    discovery,
    null
  );
  await discovery.promise;
  IMAPPump.inbox = IMAPPump.incomingServer.rootFolder
    .getChildNamed("INBOX")
    .QueryInterface(Ci.nsIMsgImapMailFolder);
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.equal(
    "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
    panorama
  );
  const store = {
    "@mozilla.org/msgstore/berkeleystore;1": "mbox",
    "@mozilla.org/msgstore/maildirstore;1": "maildir",
  }[contract];
  Assert.ok(store);
  Assert.equal(IMAPPump.incomingServer.msgStore.storeType, store);
  Assert.equal(IMAPPump.inbox.msgStore.storeType, store);
  IMAPPump.mailbox.uidvalidity = 7101;
  const publicationObserver = {
    msgAdded(header) {
      if (header.folder == IMAPPump.inbox) {
        published.push({
          id: header.messageId,
          key: header.messageKey,
          subject: header.subject,
          bcc: header.bccList,
          priority: header.priority,
          date: header.dateInSeconds,
          size: header.messageSize,
          flags: header.flags,
          references: Array.from({ length: header.numReferences }, (_, i) =>
            header.getStringReference(i)
          ),
          custom: header.getStringProperty("x-publication"),
          keywords: header.getStringProperty("keywords"),
          junk: header.getStringProperty("junkscore"),
          junkOrigin: header.getStringProperty("junkscoreorigin"),
          uid: panorama
            ? header.getUint32Property("uidOnServer")
            : header.messageKey,
        });
      }
    },
  };
  MailServices.mfn.addListener(publicationObserver, MailServices.mfn.msgAdded);
  registerCleanupFunction(() =>
    MailServices.mfn.removeListener(publicationObserver)
  );

  /*
   * Ok, prelude done. Read the original message from disk
   * (through a file URI), and add it to the Inbox.
   */
  const msgfileuri = Services.io
    .newFileURI(gMsgFile)
    .QueryInterface(Ci.nsIFileURL);

  IMAPPump.mailbox.addMessage(new ImapMessage(msgfileuri.spec, 6101, []));

  IMAPPump.mailbox.uidnext = 6102;
  // ...and download for offline use.
  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.downloadAllForOffline(listener, null);
  await listener.promise;
});

add_task(async function checkBccs() {
  // locate the new message by enumerating through the database
  const headers = [...IMAPPump.inbox.msgDatabase.enumerateMessages()];
  Assert.equal(
    headers.length,
    1,
    "The original server message must actually be ingested"
  );
  Assert.equal(headers[0].messageId, "4849BF7B.2030800@example.com");
  Assert.equal(published.length, 1);
  Assert.equal(published[0].id, "4849BF7B.2030800@example.com");
  Assert.equal(published[0].uid, 6101);
  Assert.equal(IMAPPump.inbox.msgDatabase.dBFolderInfo.imapUidValidity, 7101);
  if (panorama) {
    Assert.notEqual(headers[0].messageKey, 6101);
  }
  Assert.ok(headers[0].flags & Ci.nsMsgMessageFlags.Offline);
  const stored = new PromiseTestUtils.PromiseStreamListener();
  const uri = IMAPPump.inbox.getUriForMsg(headers[0]);
  MailServices.messageServiceFromURI(uri).streamMessage(
    uri,
    stored,
    null,
    null,
    false,
    "",
    true
  );
  Assert.ok(
    (await stored.promise).includes("Hello, did you receive my bugmail?")
  );
  for (const hdr of headers) {
    Assert.ok(hdr.bccList.includes("Another Person"));
    Assert.ok(hdr.bccList.includes("<u1@example.com>"));
    Assert.ok(!hdr.bccList.includes("IDoNotExist"));
  }
});

add_task(async function test_messageUriQueryPreservesIdentity() {
  const [header] = IMAPPump.inbox.msgDatabase.enumerateMessages();
  const uri = IMAPPump.inbox.getUriForMsg(header);
  const service = MailServices.messageServiceFromURI(uri);
  const [folderUri, key] = uri.split("#");
  const plainUrl = service.getUrlForUri(uri);
  for (const messageUri of [
    uri + "?editasnew=true",
    folderUri + "?editasnew=true#" + key,
  ]) {
    const resolved = service.messageURIToMsgHdr(messageUri);
    Assert.equal(resolved.folder, IMAPPump.inbox);
    Assert.equal(resolved.messageKey, header.messageKey);
    Assert.equal(resolved.messageId, "4849BF7B.2030800@example.com");
    const url = service.getUrlForUri(messageUri);
    Assert.equal(url.spec, plainUrl.spec);
    Assert.equal(url.QueryInterface(Ci.nsIImapUrl).listOfMessageIds, "6101");
    Assert.equal(url.QueryInterface(Ci.nsIMsgMessageUrl).uri, messageUri);
    Assert.ok(messageUri.includes("editasnew=true"));
    const stream = new PromiseTestUtils.PromiseStreamListener();
    service.streamMessage(messageUri, stream, null, null, false, "", true);
    Assert.ok(
      (await stream.promise).includes("Hello, did you receive my bugmail?")
    );
  }
  Assert.equal(IMAPPump.mailbox.uidvalidity, 7101);
  Assert.deepEqual(
    IMAPPump.mailbox._messages.map(message => message.uid),
    [6101]
  );
});

async function updateInbox() {
  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, listener);
  await listener.promise;
}

add_task(async function testCompleteHeaderIsVisibleAtPublication() {
  const text =
    "From: Sender <sender@example.invalid>\r\n" +
    "To: Reader <reader@example.invalid>\r\n" +
    "Bcc: Hidden Reader <hidden@example.invalid>\r\n" +
    "Message-ID: <complete@example.invalid>\r\n" +
    "Subject: Complete IMAP header\r\n" +
    "Date: Mon, 01 Jan 2024 12:00:00 +0000\r\n" +
    "References: <r1@example.invalid> <r2@example.invalid> <r1@example.invalid>\r\n" +
    "X-Priority: 2\r\nX-Publication: 18446744073709551615\r\n\r\n" +
    "Second body stays exact.\r\n";
  const message = new ImapMessage(
    "data:text/plain;base64," + btoa(text),
    6102,
    []
  );
  for (const flag of ["\\Seen", "\\Flagged", "NonJunk", "publicationtag"]) {
    message.setFlag(flag);
  }
  IMAPPump.mailbox.addMessage(message);
  IMAPPump.mailbox.uidnext = 6103;
  await updateInbox();
  const snapshot = published.filter(
    item => item.id == "complete@example.invalid"
  );
  Assert.equal(snapshot.length, 1);
  const [header] = snapshot;
  Assert.equal(header.subject, "Complete IMAP header");
  Assert.ok(header.bcc.includes("hidden@example.invalid"));
  Assert.equal(header.priority, Ci.nsMsgPriority.high);
  Assert.equal(header.date, 1704110400);
  Assert.equal(header.size, text.length);
  Assert.deepEqual(header.references, [
    "r1@example.invalid",
    "r2@example.invalid",
    "r1@example.invalid",
  ]);
  Assert.equal(header.custom, "18446744073709551615");
  Assert.ok(header.flags & Ci.nsMsgMessageFlags.Read);
  Assert.ok(header.flags & Ci.nsMsgMessageFlags.Marked);
  Assert.ok(header.keywords.split(" ").includes("publicationtag"));
  Assert.equal(header.junk, "0");
  Assert.equal(header.uid, 6102);
  if (panorama) {
    Assert.notEqual(header.key, 6102);
  }
  const uri = IMAPPump.inbox.getUriForMsg(
    IMAPPump.inbox.msgDatabase.getMsgHdrForKey(header.key)
  );
  const listener = new PromiseTestUtils.PromiseStreamListener();
  MailServices.messageServiceFromURI(uri).streamMessage(
    uri,
    listener,
    null,
    null,
    false,
    "",
    false
  );
  const bytes = await listener.promise;
  Assert.ok(bytes.includes("Message-ID: <complete@example.invalid>\r\n"));
  Assert.ok(bytes.endsWith("Second body stays exact.\r\n"));
  await updateInbox();
  Assert.equal(
    published.filter(item => item.id == "complete@example.invalid").length,
    1
  );
  Assert.equal(
    [...IMAPPump.inbox.messages].filter(
      item => item.messageId == "complete@example.invalid"
    )[0].messageKey,
    header.key
  );
  Assert.equal(message.getText(), text);
});

if (panorama) {
  add_task(async function testFailedPublicationReportsErrorAndRetries() {
    const db = IMAPPump.inbox.msgDatabase;
    const keys = db.listAllKeys();
    const count = published.length;
    const highest = db.dBFolderInfo.getUint32Property("highestRecordedUID", 0);
    Assert.equal(highest, 6102);
    const text =
      "From: sender@example.invalid\r\n" +
      "Message-ID: <rejected@example.invalid>\r\n" +
      "Subject: Retry complete publication\r\n\r\nRetain the server source.\r\n";
    const message = new ImapMessage(
      "data:text/plain;base64," + btoa(text),
      6103,
      []
    );
    IMAPPump.mailbox.addMessage(message);
    IMAPPump.mailbox.uidnext = 6104;
    const connection = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    ).connectionForTests;
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER reject_imap_publication BEFORE INSERT ON messages " +
        "WHEN NEW.messageId='rejected@example.invalid' BEGIN SELECT RAISE(ABORT,'publication'); END"
    );
    try {
      const listener = new PromiseTestUtils.PromiseUrlListener();
      const failure = (async () => {
        await Assert.rejects(
          listener.promise,
          error => error.message == String(Cr.NS_ERROR_STORAGE_CONSTRAINT)
        );
      })();
      IMAPPump.inbox.updateFolderWithListener(null, listener);
      await failure;
      Assert.deepEqual(db.listAllKeys(), keys);
      Assert.equal(published.length, count);
      Assert.equal(
        db.dBFolderInfo.getUint32Property("highestRecordedUID", 0),
        highest
      );
      Assert.deepEqual(
        IMAPPump.mailbox._messages.map(item => item.uid),
        [6101, 6102, 6103]
      );
      Assert.equal(message.getText(), text);
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER reject_imap_publication");
    }
    await updateInbox();
    const recovered = db.getMsgHdrForMessageID("rejected@example.invalid");
    Assert.ok(recovered);
    Assert.notEqual(recovered.messageKey, 6103);
    Assert.equal(recovered.getUint32Property("uidOnServer"), 6103);
    Assert.equal(published.length, count + 1);
    Assert.equal(
      db.dBFolderInfo.getUint32Property("highestRecordedUID", 0),
      6103
    );
    Assert.equal(message.getText(), text);
  });
}

add_task(async function test_filterMetadataPrecedesPublication() {
  const filters = IMAPPump.incomingServer.getFilterList(null);
  const filter = filters.createFilter("Complete draft metadata");
  const term = filter.createTerm();
  term.attrib = Ci.nsMsgSearchAttrib.Subject;
  term.op = Ci.nsMsgSearchOp.Contains;
  const value = term.value;
  value.attrib = term.attrib;
  value.str = "Filtered metadata";
  term.value = value;
  term.booleanAnd = true;
  filter.appendTerm(term);
  filter.enabled = true;
  filter.filterType = Ci.nsMsgFilterType.InboxRule;
  const priority = filter.createAction();
  priority.type = Ci.nsMsgFilterAction.ChangePriority;
  priority.priority = Ci.nsMsgPriority.highest;
  filter.appendAction(priority);
  const junk = filter.createAction();
  junk.type = Ci.nsMsgFilterAction.JunkScore;
  junk.junkScore = 100;
  filter.appendAction(junk);
  filters.insertFilterAt(0, filter);
  try {
    const text =
      "From: sender@example.invalid\r\n" +
      "Message-ID: <filtered@example.invalid>\r\n" +
      "Subject: Filtered metadata\r\n\r\nRetain filtered source bytes.\r\n";
    const message = new ImapMessage(
      "data:text/plain;base64," + btoa(text),
      6104,
      []
    );
    IMAPPump.mailbox.addMessage(message);
    IMAPPump.mailbox.uidnext = 6105;
    await updateInbox();
    const snapshots = published.filter(
      item => item.id == "filtered@example.invalid"
    );
    Assert.equal(snapshots.length, 1);
    Assert.equal(snapshots[0].priority, Ci.nsMsgPriority.highest);
    Assert.equal(snapshots[0].junk, "100");
    Assert.equal(snapshots[0].junkOrigin, "filter");
    Assert.equal(snapshots[0].uid, 6104);
    Assert.ok(!(snapshots[0].flags & Ci.nsMsgMessageFlags.New));
    await TestUtils.waitForCondition(
      () => message.flags.some(flag => flag.toLowerCase() == "junk"),
      "The actual published key queues Junk for its server UID"
    );
    const commands = IMAPPump.server.playTransaction().them;
    const stores = commands.filter(command =>
      /UID STORE 6104 .*Junk/i.test(command)
    );
    Assert.greater(stores.length, 0);
    if (panorama) {
      Assert.equal(
        stores.length,
        1,
        "Queue the newly published physical key once"
      );
    }
    Assert.equal(message.getText(), text);
    await updateInbox();
    Assert.equal(
      published.filter(item => item.id == "filtered@example.invalid").length,
      1
    );
  } finally {
    filters.removeFilter(filter);
  }
});

add_task(async function test_copyStreamUsesPhysicalSourceKeys() {
  const target =
    localAccountUtils.rootFolder.createLocalSubfolder("UidCopyTarget");
  const texts = [
    "From: copy@example.invalid\r\nMessage-ID: <copy-first@example.invalid>\r\n" +
      "Subject: First copy\r\nX-Priority: 1\r\n\r\nFirst copy body.\r\n",
    "From: copy@example.invalid\r\nMessage-ID: <copy-second@example.invalid>\r\n" +
      "Subject: Second copy\r\nX-Priority: 5\r\n\r\nSecond copy body.\r\n",
  ];
  const messages = texts.map(
    (text, i) =>
      new ImapMessage("data:text/plain;base64," + btoa(text), 6105 + i, [])
  );
  messages[0].setFlag("\\Flagged");
  messages[1].setFlag("\\Seen");
  for (const message of messages) {
    IMAPPump.mailbox.addMessage(message);
  }
  IMAPPump.mailbox.uidnext = 6107;
  await updateInbox();
  const headers = [
    "copy-first@example.invalid",
    "copy-second@example.invalid",
  ].map(id => IMAPPump.inbox.msgDatabase.getMsgHdrForMessageID(id));
  const sourceCount = IMAPPump.inbox.getTotalMessages(false);
  for (let i = 0; i < headers.length; i++) {
    Assert.ok(headers[i]);
    if (panorama) {
      Assert.notEqual(headers[i].messageKey, 6105 + i);
      Assert.equal(headers[i].getUint32Property("uidOnServer"), 6105 + i);
    } else {
      Assert.equal(headers[i].messageKey, 6105 + i);
    }
  }
  let stops = 0;
  const listener = new PromiseTestUtils.PromiseCopyListener({
    onStopCopy(status) {
      Assert.equal(status, Cr.NS_OK);
      stops++;
    },
  });
  MailServices.copy.copyMessages(
    IMAPPump.inbox,
    headers,
    target,
    false,
    listener,
    null,
    false
  );
  await listener.promise;
  Assert.equal(stops, 1);
  Assert.equal(target.msgStore.storeType, IMAPPump.inbox.msgStore.storeType);
  Assert.equal(target.getTotalMessages(false), 2);
  Assert.equal(IMAPPump.inbox.getTotalMessages(false), sourceCount);
  for (let i = 0; i < headers.length; i++) {
    const copied = target.msgDatabase.getMsgHdrForMessageID(
      headers[i].messageId
    );
    Assert.ok(copied);
    Assert.equal(
      copied.priority,
      i ? Ci.nsMsgPriority.lowest : Ci.nsMsgPriority.highest
    );
    Assert.equal(copied.isFlagged, !i);
    Assert.equal(copied.isRead, !!i);
    const body = new PromiseTestUtils.PromiseStreamListener();
    const uri = target.getUriForMsg(copied);
    MailServices.messageServiceFromURI(uri).streamMessage(
      uri,
      body,
      null,
      null,
      false,
      "",
      true
    );
    Assert.ok(
      (await body.promise).endsWith(
        i ? "Second copy body.\r\n" : "First copy body.\r\n"
      )
    );
    Assert.ok(IMAPPump.inbox.msgDatabase.containsKey(headers[i].messageKey));
    Assert.equal(messages[i].getText(), texts[i]);
    Assert.ok(!messages[i].flags.includes("\\Deleted"));
  }
});

add_task(function test_copySinkErrorsAndUnknownIdentityFailClosed() {
  const sink = IMAPPump.inbox.QueryInterface(Ci.nsIImapMailFolderSink);
  const url = Services.io
    .newURI(IMAPPump.incomingServer.rootFolder.URI + "/fetch>UID>/INBOX>6105")
    .QueryInterface(Ci.nsIImapUrl);
  let starts = 0,
    ends = 0;
  const consumer = {
    QueryInterface: ChromeUtils.generateQI(["nsICopyMessageListener"]),
    startMessage() {
      starts++;
      throw Components.Exception("Copy start refused", Cr.NS_ERROR_UNEXPECTED);
    },
    endMessage(key) {
      ends++;
      Assert.equal(key, 6105, "Mork retains its UID-as-key callback");
      throw Components.Exception("Copy end refused", Cr.NS_ERROR_UNEXPECTED);
    },
  };
  // Main-thread boundary only: raw JS is not a threadsafe transport copy state.
  url.copyState = consumer;
  Assert.throws(
    () => sink.StartMessage(url),
    error => error.result == Cr.NS_ERROR_UNEXPECTED
  );
  Assert.equal(starts, 1);
  Assert.throws(
    () => sink.EndMessage(url, 6105),
    error =>
      error.result ==
      (panorama ? Cr.NS_ERROR_NOT_AVAILABLE : Cr.NS_ERROR_UNEXPECTED)
  );
  Assert.equal(ends, panorama ? 0 : 1);
  const header = IMAPPump.inbox.msgDatabase.getMsgHdrForMessageID(
    "copy-first@example.invalid"
  );
  Assert.ok(IMAPPump.inbox.msgDatabase.containsKey(header.messageKey));
  if (panorama) {
    const target = localAccountUtils.rootFolder.getChildNamed("UidCopyTarget");
    const foreign = target.msgDatabase.getMsgHdrForMessageID(header.messageId);
    Assert.notEqual(foreign.messageKey, header.messageKey);
    const stream = new PromiseTestUtils.PromiseStreamListener();
    const service = MailServices.messageServiceFromURI(
      IMAPPump.inbox.getUriForMsg(header)
    );
    Assert.throws(
      () =>
        service.CopyMessages(
          [foreign.messageKey],
          IMAPPump.inbox,
          stream,
          false,
          null,
          null
        ),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
    );
    Assert.ok(target.msgDatabase.containsKey(foreign.messageKey));
    Assert.ok(IMAPPump.inbox.msgDatabase.containsKey(header.messageKey));
  }
});

if (panorama) {
  const deleteText =
    "From: sender@example.invalid\r\nMessage-ID: <delete-target@example.invalid>\r\n" +
    "Subject: Delete target\r\n" +
    "References: <delete-r1@example.invalid> <delete-r2@example.invalid> <delete-r1@example.invalid>\r\n" +
    "X-Publication: 18446744073709551615\r\nX-Priority: 2\r\n\r\n" +
    "Retain the original delete source.\r\n";
  const protectedText =
    "From: sender@example.invalid\r\nMessage-ID: <delete-protected@example.invalid>\r\n" +
    "Subject: Unrelated source\r\n\r\nKeep unrelated source bytes.\r\n";
  let deleteHeader, protectedHeader, deleteMessage, protectedMessage;
  const deleted = [];
  let initialCount;

  async function localBody(header) {
    const uri = IMAPPump.inbox.getUriForMsg(header);
    const listener = new PromiseTestUtils.PromiseStreamListener();
    MailServices.messageServiceFromURI(uri).streamMessage(
      uri,
      listener,
      null,
      null,
      false,
      "",
      true
    );
    return listener.promise;
  }

  async function deleteWithStatus(
    status,
    header = deleteHeader,
    isMove = false
  ) {
    let starts = 0;
    const stops = [];
    const listener = new PromiseTestUtils.PromiseCopyListener({
      onStartCopy() {
        starts++;
      },
      onStopCopy(result) {
        stops.push(result);
      },
    });
    const completion = (async () => {
      if (status == Cr.NS_OK) {
        await listener.promise;
      } else {
        await Assert.rejects(
          listener.promise,
          error => error.message == String(status)
        );
      }
    })();
    IMAPPump.inbox.deleteMessages(
      [header],
      null,
      true,
      isMove,
      listener,
      false
    );
    Assert.deepEqual(stops, [], "Dispatch is not confirmed deletion");
    await completion;
    Assert.equal(starts, 1);
    Assert.deepEqual(stops, [status]);
    Assert.ok(!IMAPPump.inbox.gettingNewMessages);
  }

  add_task(async function test_deleteSetupUsesRealIngestion() {
    IMAPPump.incomingServer.deleteModel = Ci.nsMsgImapDeleteModels.MoveToTrash;
    initialCount = IMAPPump.inbox.getTotalMessages(false);
    deleteMessage = new ImapMessage(
      "data:text/plain;base64," + btoa(deleteText),
      6201,
      []
    );
    protectedMessage = new ImapMessage(
      "data:text/plain;base64," + btoa(protectedText),
      6202,
      []
    );
    IMAPPump.mailbox.addMessage(deleteMessage);
    IMAPPump.mailbox.addMessage(protectedMessage);
    IMAPPump.mailbox.uidnext = 6203;
    const listener = new PromiseTestUtils.PromiseUrlListener();
    IMAPPump.inbox.downloadAllForOffline(listener, null);
    await listener.promise;
    deleteHeader = IMAPPump.inbox.msgDatabase.getMsgHdrForMessageID(
      "delete-target@example.invalid"
    );
    protectedHeader = IMAPPump.inbox.msgDatabase.getMsgHdrForMessageID(
      "delete-protected@example.invalid"
    );
    Assert.ok(deleteHeader);
    Assert.ok(protectedHeader);
    Assert.notEqual(deleteHeader.messageKey, 6201);
    Assert.notEqual(protectedHeader.messageKey, 6202);
    Assert.equal(IMAPPump.inbox.getTotalMessages(false), initialCount + 2);
    Assert.ok(
      (await localBody(deleteHeader)).endsWith(
        "Retain the original delete source.\r\n"
      )
    );
    Assert.ok(
      (await localBody(protectedHeader)).endsWith(
        "Keep unrelated source bytes.\r\n"
      )
    );
    const observer = {
      msgsDeleted(headers) {
        for (const header of headers) {
          Assert.ok(
            IMAPPump.inbox.msgDatabase.containsKey(header.messageKey),
            "Deletion notification precedes removal"
          );
          Assert.equal(header.messageId, "delete-target@example.invalid");
          Assert.equal(header.getUint32Property("uidOnServer"), 6201);
          Assert.ok(header.storeToken);
          Assert.equal(header.priority, Ci.nsMsgPriority.high);
          Assert.equal(
            header.getStringProperty("x-publication"),
            "18446744073709551615"
          );
          Assert.ok(header.properties.includes("x-publication"));
          Assert.deepEqual(
            Array.from({ length: header.numReferences }, (_, i) =>
              header.getStringReference(i)
            ),
            [
              "delete-r1@example.invalid",
              "delete-r2@example.invalid",
              "delete-r1@example.invalid",
            ]
          );
          deleted.push(header.messageKey);
        }
      },
    };
    MailServices.mfn.addListener(observer, MailServices.mfn.msgsDeleted);
    registerCleanupFunction(() => MailServices.mfn.removeListener(observer));
  });

  add_task(async function test_failedDeleteKeepsSourceAndBody() {
    const token = deleteHeader.storeToken;
    IMAPPump.daemon.commandToFail = "UID";
    try {
      await deleteWithStatus(Cr.NS_MSG_ERROR_IMAP_COMMAND_FAILED);
    } finally {
      IMAPPump.daemon.commandToFail = "";
    }
    Assert.ok(IMAPPump.inbox.msgDatabase.containsKey(deleteHeader.messageKey));
    Assert.equal(deleteHeader.storeToken, token);
    Assert.deepEqual(deleted, []);
    Assert.equal(IMAPPump.inbox.getTotalMessages(false), initialCount + 2);
    Assert.ok(
      (await localBody(deleteHeader)).endsWith(
        "Retain the original delete source.\r\n"
      )
    );
    Assert.ok(!deleteMessage.flags.includes("\\Deleted"));
    Assert.equal(deleteMessage.getText(), deleteText);
    Assert.equal(protectedMessage.getText(), protectedText);
  });

  add_task(async function test_databaseFailureKeepsBodyAndReportsError() {
    const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    );
    const token = deleteHeader.storeToken;
    core.connectionForTests.executeSimpleSQL(
      "CREATE TEMP TRIGGER reject_confirmed_delete BEFORE DELETE ON messages " +
        `WHEN OLD.id=${deleteHeader.messageKey} BEGIN SELECT RAISE(ABORT,'delete'); END`
    );
    try {
      await deleteWithStatus(Cr.NS_ERROR_STORAGE_CONSTRAINT);
    } finally {
      core.connectionForTests.executeSimpleSQL(
        "DROP TRIGGER reject_confirmed_delete"
      );
    }
    Assert.ok(deleteMessage.flags.includes("\\Deleted"));
    Assert.ok(IMAPPump.inbox.msgDatabase.containsKey(deleteHeader.messageKey));
    Assert.equal(deleteHeader.storeToken, token);
    Assert.deepEqual(
      deleted,
      [deleteHeader.messageKey],
      "The confirmed delete command announces intent before the failed local removal"
    );
    Assert.ok(
      (await localBody(deleteHeader)).endsWith(
        "Retain the original delete source.\r\n"
      )
    );
  });

  add_task(async function test_confirmedDeleteSettlesOriginalKeyOnce() {
    const protectedKey = protectedHeader.messageKey;
    await deleteWithStatus(Cr.NS_OK);
    Assert.ok(!IMAPPump.inbox.msgDatabase.containsKey(deleteHeader.messageKey));
    Assert.deepEqual(deleted, [
      deleteHeader.messageKey,
      deleteHeader.messageKey,
    ]);
    Assert.equal(IMAPPump.inbox.getTotalMessages(false), initialCount + 1);
    Assert.equal(protectedHeader.messageKey, protectedKey);
    Assert.ok(IMAPPump.inbox.msgDatabase.containsKey(protectedKey));
    Assert.ok(!protectedMessage.flags.includes("\\Deleted"));
    Assert.equal(protectedMessage.getText(), protectedText);
    Assert.ok(
      (await localBody(protectedHeader)).endsWith(
        "Keep unrelated source bytes.\r\n"
      )
    );
    const commands = IMAPPump.server.playTransaction();
    Assert.ok(
      (Array.isArray(commands) ? commands : [commands])
        .flatMap(item => item.them)
        .some(command => /UID STORE 6201 .*\\Deleted/i.test(command))
    );
  });

  add_task(
    async function test_missingCaptureFailsClosedAndDuplicateCompletesOnce() {
      let url;
      const folderListener = IMAPPump.inbox.QueryInterface(Ci.nsIUrlListener);
      let stops = 0;
      const listener = new PromiseTestUtils.PromiseUrlListener({
        OnStartRunningUrl(value) {
          folderListener.OnStartRunningUrl(value);
        },
        OnStopRunningUrl(value, status) {
          url = value;
          folderListener.OnStopRunningUrl(value, status);
          stops++;
        },
      });
      IMAPPump.inbox.storeImapFlags(
        8,
        false,
        [protectedHeader.messageKey],
        listener
      );
      await listener.promise;
      Assert.equal(stops, 1);
      folderListener.OnStopRunningUrl(url, Cr.NS_OK);
      Assert.equal(stops, 1);
      const uncaptured = Services.io.newURI(url.spec);
      Assert.throws(
        () => folderListener.OnStopRunningUrl(uncaptured, Cr.NS_OK),
        error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
      );
      Assert.ok(
        IMAPPump.inbox.msgDatabase.containsKey(protectedHeader.messageKey)
      );
      Assert.ok(
        (await localBody(protectedHeader)).endsWith(
          "Keep unrelated source bytes.\r\n"
        )
      );
    }
  );

  add_task(async function test_capturedAlreadyRemovedSourceCompletes() {
    const text =
      "From: sender@example.invalid\r\nMessage-ID: <already-removed@example.invalid>\r\n" +
      "Subject: Known source retirement\r\n\r\nKeep the known source bytes.\r\n";
    const message = new ImapMessage(
      "data:text/plain;base64," + btoa(text),
      6301,
      []
    );
    IMAPPump.mailbox.addMessage(message);
    IMAPPump.mailbox.uidnext = 6302;
    await updateInbox();
    const db = IMAPPump.inbox.msgDatabase;
    const header = db.getMsgHdrForMessageID("already-removed@example.invalid");
    Assert.ok(header);
    Assert.notEqual(header.messageKey, 6301);
    const originalStore = IMAP_RFC3501_handler.prototype.STORE;
    let reached = false;
    IMAP_RFC3501_handler.prototype.STORE = function (args, uid) {
      if (uid && String(args[0]) == "6301") {
        Assert.ok(db.containsKey(header.messageKey));
        db.deleteMessages([header.messageKey], null);
        reached = true;
      }
      return originalStore.call(this, args, uid);
    };
    try {
      await deleteWithStatus(Cr.NS_OK, header, true);
    } finally {
      IMAP_RFC3501_handler.prototype.STORE = originalStore;
    }
    Assert.ok(reached, "The actual command ran after identity capture");
    Assert.ok(!db.containsKey(header.messageKey));
    Assert.ok(message.flags.includes("\\Deleted"));
    Assert.equal(message.getText(), text);
    Assert.deepEqual(
      deleted,
      [deleteHeader.messageKey, deleteHeader.messageKey],
      "Do not emit another removal for an absent captured key"
    );
    Assert.ok(db.containsKey(protectedHeader.messageKey));
  });

  add_task(async function test_moveCleanupSuppressesDeleteNotification() {
    const text =
      "From: sender@example.invalid\r\nMessage-ID: <move-cleanup@example.invalid>\r\n" +
      "Subject: Confirmed move cleanup\r\n\r\nOriginal move source.\r\n";
    const message = new ImapMessage(
      "data:text/plain;base64," + btoa(text),
      6401,
      []
    );
    IMAPPump.mailbox.addMessage(message);
    IMAPPump.mailbox.uidnext = 6402;
    await updateInbox();
    const db = IMAPPump.inbox.msgDatabase;
    const header = db.getMsgHdrForMessageID("move-cleanup@example.invalid");
    Assert.ok(header);
    Assert.notEqual(header.messageKey, 6401);
    await deleteWithStatus(Cr.NS_OK, header, true);
    Assert.ok(!db.containsKey(header.messageKey));
    Assert.ok(message.flags.includes("\\Deleted"));
    Assert.equal(message.getText(), text);
    Assert.deepEqual(deleted, [
      deleteHeader.messageKey,
      deleteHeader.messageKey,
    ]);
    Assert.ok(db.containsKey(protectedHeader.messageKey));
  });

  add_task(async function test_droppedDeleteStoreRetriesAndSettlesOnce() {
    const text =
      "From: sender@example.invalid\r\nMessage-ID: <delete-retry@example.invalid>\r\n" +
      "Subject: Retried delete\r\n\r\nRetain retry source bytes.\r\n";
    const message = new ImapMessage(
      "data:text/plain;base64," + btoa(text),
      6501,
      []
    );
    IMAPPump.mailbox.addMessage(message);
    IMAPPump.mailbox.uidnext = 6502;
    const download = new PromiseTestUtils.PromiseUrlListener();
    IMAPPump.inbox.downloadAllForOffline(download, null);
    await download.promise;
    const db = IMAPPump.inbox.msgDatabase;
    const header = db.getMsgHdrForMessageID("delete-retry@example.invalid");
    Assert.ok(header);
    Assert.notEqual(header.messageKey, 6501);
    Assert.ok(
      (await localBody(header)).endsWith("Retain retry source bytes.\r\n")
    );
    const originalStore = IMAP_RFC3501_handler.prototype.STORE;
    let attempts = 0;
    IMAP_RFC3501_handler.prototype.STORE = function (args, uid) {
      if (uid && String(args[0]) == "6501" && ++attempts == 1) {
        Assert.ok(db.containsKey(header.messageKey));
        Assert.ok(!message.flags.includes("\\Deleted"));
        this.closing = true;
        return "";
      }
      return originalStore.call(this, args, uid);
    };
    try {
      await deleteWithStatus(Cr.NS_OK, header, true);
    } finally {
      IMAP_RFC3501_handler.prototype.STORE = originalStore;
    }
    Assert.equal(attempts, 2, "The dropped STORE receives one transport retry");
    Assert.ok(!db.containsKey(header.messageKey));
    Assert.ok(IMAPPump.mailbox._messages.includes(message));
    Assert.ok(message.flags.includes("\\Deleted"));
    Assert.equal(message.getText(), text);
    Assert.ok(db.containsKey(protectedHeader.messageKey));
    Assert.ok(!protectedMessage.flags.includes("\\Deleted"));
    Assert.equal(protectedMessage.getText(), protectedText);
    Assert.ok(
      (await localBody(protectedHeader)).endsWith(
        "Keep unrelated source bytes.\r\n"
      )
    );
    const transactions = IMAPPump.server.playTransaction();
    const commands = (
      Array.isArray(transactions) ? transactions : [transactions]
    ).flatMap(item => item.them);
    Assert.equal(
      commands.filter(command => /UID STORE 6501 .*\\Deleted/i.test(command))
        .length,
      2
    );
    Assert.equal(
      commands.filter(command => /UID EXPUNGE 6501\b/i.test(command)).length,
      0
    );
  });

  add_task(async function test_unknownSourceRefusesBeforeDispatch() {
    const keys = IMAPPump.inbox.msgDatabase.listAllKeys();
    Assert.throws(
      () =>
        IMAPPump.inbox.deleteMessages(
          [protectedHeader],
          null,
          true,
          false,
          null,
          true
        ),
      error => error.result == Cr.NS_ERROR_NOT_IMPLEMENTED
    );
    Assert.throws(
      () =>
        MailServices.imap.addMessageFlags(
          IMAPPump.inbox,
          null,
          "9999",
          8,
          true
        ),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
    );
    Assert.throws(
      () =>
        MailServices.imap.addMessageFlags(IMAPPump.inbox, null, "1:*", 8, true),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
    );
    Assert.deepEqual(IMAPPump.inbox.msgDatabase.listAllKeys(), keys);
    Assert.ok(!protectedMessage.flags.includes("\\Deleted"));
    Assert.ok(
      (await localBody(protectedHeader)).endsWith(
        "Keep unrelated source bytes.\r\n"
      )
    );
  });

  add_task(async function test_unwritableCommandsDoNotSettleSource() {
    const proto = IMAP_RFC3501_handler.prototype;
    const originalSelect = proto.SELECT;
    const originalFlags = IMAPPump.mailbox.permflags;
    for (const readOnly of [true, false]) {
      IMAPPump.incomingServer.closeCachedConnections();
      await TestUtils.waitForCondition(
        () => !IMAPPump.daemon.getConnections().length,
        "The command must consume current SELECT permissions"
      );
      if (readOnly) {
        proto.SELECT = function (args) {
          const response = originalSelect.call(this, args);
          this._readOnly = true;
          return response.replace("OK [READ-WRITE]", "OK [READ-ONLY]");
        };
      } else {
        IMAPPump.mailbox.permflags = originalFlags.filter(
          flag => flag != "\\Deleted"
        );
      }
      try {
        await deleteWithStatus(
          readOnly
            ? Cr.NS_ERROR_NOT_AVAILABLE
            : Cr.NS_MSG_ERROR_IMAP_COMMAND_FAILED,
          protectedHeader
        );
      } finally {
        proto.SELECT = originalSelect;
        IMAPPump.mailbox.permflags = originalFlags;
      }
      Assert.ok(
        IMAPPump.inbox.msgDatabase.containsKey(protectedHeader.messageKey)
      );
      Assert.ok(!protectedMessage.flags.includes("\\Deleted"));
      Assert.deepEqual(deleted, [
        deleteHeader.messageKey,
        deleteHeader.messageKey,
      ]);
      Assert.ok(
        (await localBody(protectedHeader)).endsWith(
          "Keep unrelated source bytes.\r\n"
        )
      );
    }
  });

  add_task(async function test_changedServerEpochRefusesOldCommand() {
    const token = protectedHeader.storeToken;
    IMAPPump.incomingServer.closeCachedConnections();
    await TestUtils.waitForCondition(
      () => !IMAPPump.daemon.getConnections().length,
      "The flag command must select the actual server epoch"
    );
    IMAPPump.mailbox.uidvalidity = 7202;
    const listener = new PromiseTestUtils.PromiseUrlListener();
    const failure = (async () => {
      await Assert.rejects(
        listener.promise,
        error => error.message == String(Cr.NS_ERROR_NOT_AVAILABLE)
      );
    })();
    IMAPPump.inbox.storeImapFlags(
      8,
      true,
      [protectedHeader.messageKey],
      listener
    );
    await failure;
    Assert.ok(
      IMAPPump.inbox.msgDatabase.containsKey(protectedHeader.messageKey)
    );
    Assert.ok(!protectedMessage.flags.includes("\\Deleted"));
    Assert.equal(protectedMessage.getText(), protectedText);
    Assert.equal(protectedHeader.storeToken, token);
    // Protocol identity is stale; verify retained bytes at their actual store.
    const uri = IMAPPump.inbox.getUriForMsg(protectedHeader);
    Assert.throws(
      () =>
        MailServices.messageServiceFromURI(uri).streamMessage(
          uri,
          null,
          null,
          null,
          false,
          "",
          true
        ),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
    );
    const stream = IMAPPump.inbox.msgStore.getMsgInputStream(
      IMAPPump.inbox,
      token,
      0
    );
    const reader = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    reader.init(stream);
    let bytes = "";
    try {
      for (let chunk = reader.read(4096); chunk; chunk = reader.read(4096)) {
        bytes += chunk;
      }
    } finally {
      reader.close();
    }
    Assert.ok(bytes.endsWith("Keep unrelated source bytes.\r\n"));
  });
}

add_task(function test_flagLookupErrorsReachCommonCleanup() {
  const keys = IMAPPump.inbox.msgDatabase.listAllKeys();
  const spec =
    IMAPPump.incomingServer.rootFolder.URI + "/addmsgflags>UID>/INBOX>0>8";
  const folderListener = IMAPPump.inbox.QueryInterface(Ci.nsIUrlListener);
  for (const status of [Cr.NS_OK, Cr.NS_MSG_ERROR_IMAP_COMMAND_FAILED]) {
    const expected =
      status ||
      (panorama ? Cr.NS_ERROR_NOT_AVAILABLE : Cr.NS_ERROR_INVALID_ARG);
    IMAPPump.inbox.gettingNewMessages = true;
    Assert.throws(
      () => folderListener.OnStopRunningUrl(Services.io.newURI(spec), status),
      error => error.result == expected
    );
    Assert.ok(
      !IMAPPump.inbox.gettingNewMessages,
      "A lookup error still runs common URL cleanup"
    );
    Assert.deepEqual(IMAPPump.inbox.msgDatabase.listAllKeys(), keys);
  }
});

add_task(function endTest() {
  teardownIMAPPump();
});
