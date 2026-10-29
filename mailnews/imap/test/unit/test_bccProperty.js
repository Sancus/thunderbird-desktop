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

add_task(function endTest() {
  teardownIMAPPump();
});
