/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Test that the message failed to move to a local folder remains on IMAP
 * server. */

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

var { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

let sourceIdentity;

function stop_server() {
  IMAPPump.incomingServer.closeCachedConnections();
  IMAPPump.server.stop();
  const thread = Services.tm.currentThread;
  while (thread.hasPendingEvents()) {
    thread.processNextEvent(true);
  }
}

add_setup(async function () {
  const contract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  Services.prefs.setCharPref("mail.server.default.storeContractID", contract);
  setupIMAPPump();
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
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
});

add_setup(async function () {
  const messageGenerator = new MessageGenerator();
  const messageString = messageGenerator.makeMessage().toMessageString();
  const dataUri = Services.io.newURI(
    "data:text/plain;base64," + btoa(messageString)
  );
  const imapMsg = new ImapMessage(dataUri.spec, IMAPPump.mailbox.uidnext++, []);
  IMAPPump.mailbox.addMessage(imapMsg);

  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, listener);
  await listener.promise;
});

add_task(async function move_messages() {
  const contract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  const expectedStore = {
    "@mozilla.org/msgstore/berkeleystore;1": "mbox",
    "@mozilla.org/msgstore/maildirstore;1": "maildir",
  }[contract];
  Assert.ok(expectedStore, "The manifest selects a supported store");
  for (const folder of [IMAPPump.inbox, localAccountUtils.inboxFolder]) {
    Assert.equal(folder.msgStore.storeType, expectedStore);
    Assert.equal(folder.server.msgStore.storeType, expectedStore);
  }
  const panorama = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  if ("nsIDatabaseCore" in Ci) {
    const databaseService = Cc[
      "@mozilla.org/msgDatabase/msgDBService;1"
    ].getService(Ci.nsIMsgDBService);
    Assert.equal(databaseService instanceof Ci.nsIDatabaseCore, panorama);
  } else {
    Assert.ok(!panorama);
  }
  const msg = [...IMAPPump.inbox.messages][0];
  sourceIdentity = {
    key: msg.messageKey,
    messageId: msg.messageId,
    token: msg.storeToken,
    hasToken: msg.properties.includes("storeToken"),
  };
  let progressCount = 0;
  const statuses = [];
  const copyListener = new PromiseTestUtils.PromiseCopyListener({
    onProgress() {
      progressCount++;
      stop_server();
    },
    onStopCopy(status) {
      statuses.push(status);
    },
  });
  MailServices.copy.copyMessages(
    IMAPPump.inbox,
    [msg],
    localAccountUtils.inboxFolder,
    true,
    copyListener,
    null,
    false
  );
  await Assert.rejects(
    copyListener.promise,
    error => error.message == String(Cr.NS_ERROR_FAILURE),
    "Stopping the source server reports a failed move"
  );
  Assert.equal(progressCount, 1, "The source was stopped during this request");
  Assert.deepEqual(statuses, [Cr.NS_ERROR_FAILURE]);
});

add_task(async function check_messages() {
  Assert.equal(IMAPPump.inbox.getTotalMessages(false), 1);
  Assert.equal(localAccountUtils.inboxFolder.getTotalMessages(false), 0);
  const [source] = [...IMAPPump.inbox.messages];
  Assert.equal(source.messageKey, sourceIdentity.key);
  Assert.equal(source.messageId, sourceIdentity.messageId);
  Assert.equal(source.storeToken, sourceIdentity.token);
  Assert.equal(
    source.properties.includes("storeToken"),
    sourceIdentity.hasToken
  );
  const scan = new PromiseTestUtils.PromiseStoreScanListener();
  localAccountUtils.inboxFolder.msgStore.asyncScan(
    localAccountUtils.inboxFolder,
    scan
  );
  await scan.promise;
  Assert.deepEqual(scan.messages, [], "No unfinished destination body remains");
});

add_task(function endTest() {
  // IMAPPump.server.performTest() brings this test to a halt,
  // so we need teardownIMAPPump() without IMAPPump.server.performTest().
  IMAPPump.inbox = null;
  IMAPPump.server.resetTest();
  try {
    IMAPPump.incomingServer.closeCachedConnections();
    const serverSink = IMAPPump.incomingServer.QueryInterface(
      Ci.nsIImapServerSink
    );
    serverSink.abortQueuedUrls();
  } catch (ex) {
    dump(ex);
  }
  IMAPPump.server.stop();
  const thread = Services.tm.currentThread;
  while (thread.hasPendingEvents()) {
    thread.processNextEvent(true);
  }
});
