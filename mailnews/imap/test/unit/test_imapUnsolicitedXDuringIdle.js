/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Test that an unknown untagged X response sent while the connection is
 * idling, when no url is running, is ignored:
 *
 *   * XFOO bar<CR><LF>
 */

const { IMAPServer } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/IMAPServer.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

let incomingServer;
let server;
let inbox;
let other;

const panorama = Services.prefs.getBoolPref("mail.panorama.enabled", false);

async function updateInbox() {
  const listener = new PromiseTestUtils.PromiseUrlListener();
  inbox.updateFolderWithListener(null, listener);
  await listener.promise;
}

add_setup(async function () {
  const contract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  Services.prefs.setCharPref("mail.server.default.storeContractID", contract);
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
  server = new IMAPServer({ extensions: ["RFC2177"] });
  server.daemon.createMailbox("Other", { subscribed: true });
  server.daemon.getMailbox("INBOX").uidvalidity = 7101;
  server.daemon.getMailbox("Other").uidvalidity = 7202;
  server.daemon.getMailbox("INBOX").uidnext = 8101;
  server.daemon.getMailbox("Other").uidnext = 8101;

  const account = MailServices.accounts.createAccount();
  account.addIdentity(MailServices.accounts.createIdentity());
  incomingServer = MailServices.accounts.createIncomingServer(
    "user",
    "localhost",
    "imap"
  );
  incomingServer.password = "password";
  incomingServer.port = server.port;
  incomingServer.QueryInterface(Ci.nsIImapIncomingServer).useIdle = true;
  incomingServer.maximumConnectionsNumber = 1;
  account.incomingServer = incomingServer;

  const listener = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(
    incomingServer.rootFolder,
    listener,
    null
  );
  await listener.promise;

  inbox = incomingServer.rootFolder
    .getChildNamed("INBOX")
    .QueryInterface(Ci.nsIMsgImapMailFolder);
  other = incomingServer.rootFolder
    .getChildNamed("Other")
    .QueryInterface(Ci.nsIMsgImapMailFolder);
  const dbService = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.equal(
    "nsIDatabaseCore" in Ci && dbService instanceof Ci.nsIDatabaseCore,
    panorama
  );
  const store = {
    "@mozilla.org/msgstore/berkeleystore;1": "mbox",
    "@mozilla.org/msgstore/maildirstore;1": "maildir",
  }[contract];
  Assert.ok(store);
  Assert.equal(incomingServer.msgStore.storeType, store);
  Assert.equal(inbox.msgStore.storeType, store);
  Assert.equal(other.msgStore.storeType, store);
  await updateInbox();

  registerCleanupFunction(() => {
    incomingServer.closeCachedConnections();
    MailServices.accounts.removeIncomingServer(incomingServer, false);
  });
});

add_task(async function unsolicitedXResponseWhileIdle() {
  await TestUtils.waitForCondition(
    () => server.daemon.getConnections("INBOX").some(h => h.idling),
    "INBOX connection should enter IDLE"
  );
  await server.addMessages("INBOX", [gMessageGenerator.makeMessage()], false);
  const folderLoaded = PromiseTestUtils.promiseFolderEvent(
    inbox,
    "FolderLoaded"
  );
  const messageAdded = PromiseTestUtils.promiseFolderNotification(
    inbox,
    "msgAdded"
  );
  Assert.equal(
    server.daemon.sendUnsolicited("INBOX", ["* XFOO bar", "* 1 EXISTS"]),
    1,
    "the idling connection should receive the X response"
  );

  // The message is fetched in response to the EXISTS, so the X response
  // before it was handled while idling.
  await messageAdded;
  Assert.equal(inbox.getTotalMessages(false), 1, "the message should arrive");
  await folderLoaded;
});

add_task(async function test_urlSinkHandoffAfterIdleResponse() {
  const [original] = inbox.msgDatabase.enumerateMessages();
  Assert.ok(original);
  Assert.equal(server.daemon.getMailbox("INBOX").uidnext, 8102);
  Assert.equal(server.daemon.getMailbox("Other").uidnext, 8101);
  const inboxText =
    "From: sender@example.invalid\r\n" +
    "Message-ID: <handoff-inbox@example.invalid>\r\n" +
    "Subject: Inbox handoff\r\n\r\nInbox bytes stay here.\r\n";
  const otherText =
    "From: sender@example.invalid\r\n" +
    "Message-ID: <handoff-other@example.invalid>\r\n" +
    "Subject: Other handoff\r\n\r\nOther bytes stay here.\r\n";
  await server.addMessages("INBOX", [inboxText], false);
  await server.addMessages("Other", [otherText], false);

  const completed = [];
  let starts = 0;
  const last = new PromiseTestUtils.PromiseUrlListener({
    OnStartRunningUrl() {
      starts++;
    },
    OnStopRunningUrl(url, status) {
      Assert.equal(status, Cr.NS_OK);
      Assert.equal(url.QueryInterface(Ci.nsIMsgMailNewsUrl).folder, inbox);
      completed.push("INBOX");
    },
  });
  const next = new PromiseTestUtils.PromiseUrlListener({
    OnStartRunningUrl() {
      starts++;
    },
    OnStopRunningUrl(url, status) {
      Assert.equal(status, Cr.NS_OK);
      Assert.equal(url.QueryInterface(Ci.nsIMsgMailNewsUrl).folder, other);
      completed.push("Other");
      MailServices.imap.selectFolder(inbox, last, null);
    },
  });
  const first = new PromiseTestUtils.PromiseUrlListener({
    OnStartRunningUrl() {
      starts++;
    },
    OnStopRunningUrl(url, status) {
      Assert.equal(status, Cr.NS_OK);
      Assert.equal(url.QueryInterface(Ci.nsIMsgMailNewsUrl).folder, inbox);
      completed.push("INBOX");
      MailServices.imap.selectFolder(other, next, null);
    },
  });
  MailServices.imap.selectFolder(inbox, first, null);
  await Promise.all([first.promise, next.promise, last.promise]);
  Assert.equal(starts, 3);
  Assert.deepEqual(completed, ["INBOX", "Other", "INBOX"]);
  Assert.equal(server.daemon.getConnections().length, 1);
  Assert.equal(inbox.getTotalMessages(false), 2);
  Assert.equal(other.getTotalMessages(false), 1);
  Assert.ok(inbox.msgDatabase.containsKey(original.messageKey));
  const inboxHeader = [...inbox.msgDatabase.enumerateMessages()].find(
    header => header.messageId == "handoff-inbox@example.invalid"
  );
  const [otherHeader] = other.msgDatabase.enumerateMessages();
  Assert.ok(inboxHeader);
  Assert.equal(otherHeader.messageId, "handoff-other@example.invalid");
  Assert.equal(inboxHeader.folder, inbox);
  Assert.equal(otherHeader.folder, other);
  Assert.equal(inbox.msgDatabase.dBFolderInfo.imapUidValidity, 7101);
  Assert.equal(other.msgDatabase.dBFolderInfo.imapUidValidity, 7202);
  if (panorama) {
    Assert.notEqual(inboxHeader.messageKey, otherHeader.messageKey);
    Assert.notEqual(original.messageKey, otherHeader.messageKey);
    Assert.notEqual(inboxHeader.messageKey, 8102);
    Assert.notEqual(otherHeader.messageKey, 8101);
    Assert.equal(inboxHeader.getUint32Property("uidOnServer"), 8102);
    Assert.equal(otherHeader.getUint32Property("uidOnServer"), 8101);
  } else {
    Assert.equal(inboxHeader.messageKey, 8102);
    Assert.equal(otherHeader.messageKey, 8101);
  }
  for (const [folder, header, tail] of [
    [inbox, inboxHeader, "Inbox bytes stay here.\r\n"],
    [other, otherHeader, "Other bytes stay here.\r\n"],
  ]) {
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
    Assert.ok((await stream.promise).endsWith(tail));
  }
  Assert.deepEqual(
    server.getMessagesInFolder(inbox).map(message => message.uid),
    [8101, 8102]
  );
  Assert.deepEqual(
    server.getMessagesInFolder(other).map(message => message.uid),
    [8101]
  );
});
