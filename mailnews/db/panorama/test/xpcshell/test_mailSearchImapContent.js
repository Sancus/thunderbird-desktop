/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { IMAPPump, setupIMAPPump, teardownIMAPPump } =
  ChromeUtils.importESModule(
    "resource://testing-common/mailnews/IMAPpump.sys.mjs"
  );
const { ImapMessage } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/Imapd.sys.mjs"
);
const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);
const { MailSearchService } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchService.sys.mjs"
);
const { MailStringUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailStringUtils.sys.mjs"
);

let service, sidecar, sourceId;
let headers;
const serverUIDs = [];

/**
 * Copies every connection's client commands from the ordinary fake server.
 *
 * @returns {string[]} Commands sent by the IMAP client.
 */
function serverCommands() {
  const transactions = IMAPPump.server.playTransaction();
  return (Array.isArray(transactions) ? transactions : [transactions]).flatMap(
    transaction => transaction.them.slice()
  );
}

/**
 * Accepts retained native work through normal bounded service updates.
 *
 * @returns {Promise<object>} Last durable progress.
 */
async function drainContentWork() {
  for (let i = 0; i < 100; i++) {
    const progress = await service.update({ limit: 500 });
    if (!progress.moreWork) {
      return progress;
    }
  }
  throw new Error("The small IMAP extraction fixture did not finish");
}

/**
 * Returns the exact native physical keys of this fixture's two copies.
 *
 * @returns {string[]} Sorted decimal native keys.
 */
function physicalKeys() {
  return headers.map(header => String(header.messageKey)).sort();
}

add_setup(async function setupNativeImapContent() {
  do_get_profile();
  loadExistingDB();
  Assert.equal(typeof messageDB.getSearchState, "function");
  const indexerPref = "mailnews.database.global.indexer.enabled";
  const hadPref = Services.prefs.prefHasUserValue(indexerPref);
  const oldPref = Services.prefs.getBoolPref(indexerPref, false);
  Services.prefs.setBoolPref(indexerPref, true);
  registerCleanupFunction(() => {
    if (hadPref) {
      Services.prefs.setBoolPref(indexerPref, oldPref);
    } else {
      Services.prefs.clearUserPref(indexerPref);
    }
  });

  setupIMAPPump();
  registerCleanupFunction(() => teardownIMAPPump());
  const serverPref = "mail.server." + IMAPPump.incomingServer.key + ".";
  Services.prefs.setBoolPref(serverPref + "autosync_offline_stores", false);
  Services.prefs.setBoolPref(serverPref + "offline_download", true);
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref(serverPref + "autosync_offline_stores");
    Services.prefs.clearUserPref(serverPref + "offline_download");
  });
  Assert.ok(
    !Services.io.offline,
    "The fake server is available for explicit download"
  );

  Assert.equal(IMAPPump.incomingServer.msgStore.storeType, "mbox");
  const backend = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.ok(backend instanceof Ci.nsIDatabaseCore);
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

  const raw = [
    "From: Sender <sender@example.invalid>",
    "To: Recipient <recipient@example.invalid>",
    "Date: Tue, 01 Jan 2019 00:00:00 +0000",
    "Message-ID: <shared-imap-content@example.invalid>",
    "Subject: =?UTF-8?Q?Par=C3=ADs_imapmetadataneedle?=",
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=imap-content-boundary",
    "",
    "--imap-content-boundary",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    "imapbodyneedle café 自動",
    "",
    "Someone wrote:",
    "> imapquotedneedle",
    "",
    "--imap-content-boundary",
    "Content-Type: application/pdf",
    "Content-Disposition: attachment; filename=imapreportneedle.pdf",
    "Content-Transfer-Encoding: base64",
    "",
    "cGRmLWZpeHR1cmU=",
    "--imap-content-boundary--",
    "",
  ].join("\r\n");
  const uri =
    "data:message/rfc822;base64," +
    btoa(MailStringUtils.stringToByteString(raw));
  IMAPPump.mailbox.uidnext = 401;
  for (let i = 0; i < 2; i++) {
    const uid = IMAPPump.mailbox.uidnext++;
    serverUIDs.push(uid);
    IMAPPump.mailbox.addMessage(new ImapMessage(uri, uid, []));
  }
  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, listener);
  await listener.promise;
  headers = [...IMAPPump.inbox.messages];
  Assert.equal(headers.length, 2);
  Assert.equal(headers[0].messageId, headers[1].messageId);
  Assert.notEqual(headers[0].messageKey, headers[1].messageKey);
  for (const header of headers) {
    Assert.ok(
      !serverUIDs.includes(header.messageKey),
      "The fixture separates native physical keys from server UIDs"
    );
    Assert.equal(header.mime2DecodedSubject, "París imapmetadataneedle");
    Assert.equal(header.flags & Ci.nsMsgMessageFlags.Offline, 0);
    Assert.equal(
      messageDB.getSearchState(header.messageKey).folderId,
      IMAPPump.inbox.id
    );
  }

  sidecar = do_get_profile().clone();
  sidecar.append("native-imap-extraction.sqlite");
  sourceId = database.sourceId;
  service = await MailSearchService.open(sidecar, sourceId, messageDB);
  registerCleanupFunction(() => service.close());
});

add_task(async function test_uncachedImapKeepsMetadataWithoutDownloading() {
  const commands = serverCommands();
  const progress = await drainContentWork();
  Assert.greaterOrEqual(progress.unavailable, 2);
  const before = headers.map(header =>
    messageDB.getSearchState(header.messageKey)
  );
  const results = await service.collectResults("imapmetadataneedle");
  Assert.deepEqual(results.items.map(item => item.id).sort(), physicalKeys());
  Assert.deepEqual((await service.search("imapbodyneedle")).items, []);
  for (const header of headers) {
    const id = String(header.messageKey);
    const state = service.resolveDocument(id);
    Assert.ok(state.eligible);
    Assert.equal(state.originalContentAvailable, false);
    Assert.ok(
      state.canOpen,
      "Online opening availability does not invent cached bytes"
    );
    Assert.equal((await service.getText(id)).bodyIndexed, false);
    const result = results.items.find(item => item.id == id);
    Assert.deepEqual(result.snippet, {
      text: "",
      ranges: [],
      firstMatchText: null,
    });
    Assert.equal(result.originalContentAvailable, false);
    Assert.ok(result.canOpen);
    Assert.equal(result.attachmentPresence, null);
    Assert.equal(result.attachmentTypes, null);
    Assert.equal(header.flags & Ci.nsMsgMessageFlags.Offline, 0);
    Assert.deepEqual(
      messageDB.getSearchState(header.messageKey),
      before[headers.indexOf(header)]
    );
  }
  Assert.deepEqual(
    serverCommands(),
    commands,
    "Metadata indexing never downloads a body"
  );
});

add_task(
  async function test_explicitOfflineDownloadMakesBodyAndAttachmentSearchable() {
    const commands = serverCommands();
    const listener = new PromiseTestUtils.PromiseUrlListener();
    IMAPPump.inbox.downloadAllForOffline(listener, null);
    await listener.promise;
    Assert.ok(
      serverCommands()
        .slice(commands.length)
        .some(command =>
          /\bFETCH\b.*(?:BODY(?:\.PEEK)?\[|RFC822)/i.test(command)
        ),
      "The ordinary explicit download actually fetched message bytes"
    );
    for (const header of headers) {
      Assert.notEqual(header.flags & Ci.nsMsgMessageFlags.Offline, 0);
      Assert.ok(
        header.storeToken,
        "The real offline store supplied a body token"
      );
      const state = service.resolveDocument(String(header.messageKey));
      Assert.ok(state.originalContentAvailable);
      Assert.deepEqual(state.location, {
        folderId: IMAPPump.inbox.id,
        messageKey: header.messageKey,
      });
    }
    const afterDownload = serverCommands();
    await service.retryUnavailable();
    await drainContentWork();
    Assert.deepEqual(
      (await service.search("imapmetadataneedle imapbodyneedle")).items
        .map(item => item.id)
        .sort(),
      physicalKeys()
    );
    Assert.deepEqual(
      (await service.search("imapreportneedle")).items
        .map(item => item.id)
        .sort(),
      physicalKeys()
    );
    Assert.deepEqual((await service.search("imapquotedneedle")).items, []);
    for (const header of headers) {
      const text = await service.getText(String(header.messageKey));
      Assert.equal(text.bodyIndexed, true);
      Assert.ok(text.body.includes("imapbodyneedle café 自動"));
      Assert.equal(text.attachmentPresence, true);
      Assert.deepEqual(text.attachmentTypes, {
        types: ["application/pdf"],
        complete: true,
      });
    }
    Assert.deepEqual(
      serverCommands(),
      afterDownload,
      "MIME indexing reads the offline cache only"
    );
  }
);

add_task(async function test_reopenRetainsExtractedImapIdentity() {
  await service.close();
  service = await MailSearchService.open(sidecar, sourceId, messageDB);
  const commands = serverCommands();
  const page = await service.search("imapbodyneedle");
  Assert.deepEqual(page.items.map(item => item.id).sort(), physicalKeys());
  for (const header of headers) {
    const state = service.resolveDocument(String(header.messageKey));
    Assert.equal(state.location.folderId, IMAPPump.inbox.id);
    Assert.equal(state.location.messageKey, header.messageKey);
    Assert.ok(state.originalContentAvailable);
    Assert.equal(
      (await service.getText(String(header.messageKey))).bodyIndexed,
      true
    );
  }
  Assert.deepEqual(
    serverCommands(),
    commands,
    "Reopening retains text without another download"
  );
  await service.close();
});
