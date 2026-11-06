/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This file tests that a message saved as draft in an IMAP folder is correctly
 * marked as unread.
 */

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);
var { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

var gDraftsFolder;

add_setup(function () {
  setupIMAPPump();
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
});

add_task(async function createDraftsFolder() {
  IMAPPump.incomingServer.rootFolder.createSubfolder("Drafts", null);
  await PromiseTestUtils.promiseFolderAdded("Drafts");
  gDraftsFolder = IMAPPump.incomingServer.rootFolder.getChildNamed("Drafts");
  Assert.ok(gDraftsFolder instanceof Ci.nsIMsgImapMailFolder);
  const listener = new PromiseTestUtils.PromiseUrlListener();
  gDraftsFolder.updateFolderWithListener(null, listener);
  await listener.promise;
});

add_task(async function saveDraft() {
  const msgCompose = Cc[
    "@mozilla.org/messengercompose/compose;1"
  ].createInstance(Ci.nsIMsgCompose);
  const fields = Cc[
    "@mozilla.org/messengercompose/composefields;1"
  ].createInstance(Ci.nsIMsgCompFields);
  fields.from = "Nobody <nobody@tinderbox.test>";

  const params = Cc[
    "@mozilla.org/messengercompose/composeparams;1"
  ].createInstance(Ci.nsIMsgComposeParams);
  params.composeFields = fields;
  msgCompose.initialize(params);

  // Set up the identity
  const identity = MailServices.accounts.getFirstIdentityForServer(
    IMAPPump.incomingServer
  );
  identity.draftsFolderURI = gDraftsFolder.URI;

  const progress = Cc["@mozilla.org/messenger/progress;1"].createInstance(
    Ci.nsIMsgProgress
  );
  const progressListener = new PromiseTestUtils.WebProgressListener();
  progress.registerListener(progressListener);
  msgCompose.sendMsg(Ci.nsIMsgSend.nsMsgSaveAsDraft, identity, "", progress);
  await progressListener.promise;
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 1000));
});

add_task(async function updateDrafts() {
  const listener = new PromiseTestUtils.PromiseUrlListener();
  gDraftsFolder.updateFolderWithListener(null, listener);
  await listener.promise;
});

add_task(function checkResult() {
  Assert.equal(gDraftsFolder.getTotalMessages(false), 1);
  Assert.equal(gDraftsFolder.getNumUnread(false), 1);
});

add_task(async function test_onlineAppendReceiptOwnsPhysicalKey() {
  await checkOnlineAppendIdentity("receipt");
});

add_task(async function test_onlineAppendUniqueDiscoveryOwnsPhysicalKey() {
  await checkOnlineAppendIdentity("observed");
});

add_task(async function test_onlineAppendAmbiguityRetainsRecovery() {
  await checkOnlineAppendIdentity("ambiguous");
});

add_task(async function test_onlineAppendMissingCandidateRetainsRecovery() {
  await checkOnlineAppendIdentity("missing");
});

add_task(async function test_onlineAppendSearchErrorRetainsRecovery() {
  await checkOnlineAppendIdentity("searchFailure");
});

add_task(async function test_onlineAppendDifferentBodyRetainsRecovery() {
  await checkOnlineAppendIdentity("wrongBody");
});

add_task(async function test_onlineAppendChangedEpochRetainsRecovery() {
  await checkOnlineAppendIdentity("epochChanged");
});

add_task(async function test_onlineAppendLostReplyDoesNotResend() {
  await checkOnlineAppendIdentity("lostReply");
});

/**
 * Exercises one real file APPEND and its ordinary native completion.
 *
 * @param {string} mode - The command receipt or reached discovery fault.
 * @returns {Promise<void>} Resolves after checking source, body and callbacks.
 */
async function checkOnlineAppendIdentity(mode) {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    return;
  }
  const name = "identity-" + mode;
  const mailbox = IMAPPump.daemon.createMailbox(name, {
    subscribed: true,
    uidvalidity: 9503,
  });
  mailbox.uidnext = 87001;
  const discovered = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(
    IMAPPump.incomingServer.rootFolder,
    discovered,
    null
  );
  await discovered.promise;
  const folder = IMAPPump.incomingServer.rootFolder
    .getChildNamed(name)
    .QueryInterface(Ci.nsIMsgImapMailFolder);
  const selected = new PromiseTestUtils.PromiseUrlListener();
  folder.updateFolderWithListener(null, selected);
  await selected.promise;
  const raw = [
    "From: source@example.invalid",
    "To: destination@example.invalid",
    `Message-ID: <${mode}@append-identity.invalid>`,
    "References: <root@append-identity.invalid> <parent@append-identity.invalid>",
    "Subject: Actual online identity " + mode,
    "Content-Type: text/plain; charset=us-ascii",
    "",
    "Retained body for " + mode + ".",
    "",
  ].join("\r\n");
  const file = do_get_profile();
  file.append(name + ".eml");
  await IOUtils.writeUTF8(file.path, raw);
  const proto = IMAP_RFC3501_handler.prototype;
  const saved = {
    APPEND: proto.APPEND,
    SEARCH: proto.SEARCH,
    FETCH: proto.FETCH,
    CAPABILITY: proto.CAPABILITY,
  };
  let appends = 0;
  let searches = 0;
  let readbacks = 0;
  proto.CAPABILITY = function (...args) {
    const response = saved.CAPABILITY.apply(this, args);
    return mode == "receipt"
      ? response.replace("IMAP4rev1", "IMAP4rev1 UIDPLUS")
      : response;
  };
  proto.APPEND = function (args) {
    if (args[0] != name) return saved.APPEND.call(this, args);
    appends++;
    const response = saved.APPEND.call(this, args);
    Assert.equal(response, "OK APPEND complete");
    Assert.equal(mailbox._messages.length, 1);
    Assert.equal(mailbox._messages[0].getText(), raw);
    if (mode == "ambiguous") {
      mailbox.addMessage(
        new ImapMessage(
          "data:text/plain," + encodeURI(raw),
          mailbox.uidnext++,
          []
        )
      );
    }
    if (mode == "wrongBody") {
      mailbox._messages[0] = new ImapMessage(
        "data:text/plain," +
          encodeURI(raw.replace("Retained body", "Changed! body")),
        87001,
        []
      );
    }
    if (mode == "epochChanged") mailbox.uidvalidity++;
    if (mode == "lostReply") {
      this.closing = true;
      return "";
    }
    return mode == "receipt"
      ? "OK [APPENDUID 9503 87001] APPEND complete"
      : response;
  };
  proto.SEARCH = function (args) {
    if (this._selectedMailbox != mailbox) return saved.SEARCH.call(this, args);
    searches++;
    if (mode == "missing") return "* SEARCH\0OK SEARCH completed";
    if (mode == "searchFailure") return "NO actual discovery refusal";
    return saved.SEARCH.call(this, args);
  };
  proto.FETCH = function (args, uid) {
    if (this._selectedMailbox == mailbox) readbacks++;
    return saved.FETCH.call(this, args, uid);
  };
  const keys = [];
  let completions = 0;
  const listener = new PromiseTestUtils.PromiseCopyListener({
    setMessageKey(key) {
      keys.push(key);
      const header = folder.msgDatabase.getMsgHdrForKey(key);
      Assert.equal(header.folder, folder);
      Assert.equal(header.getUint32Property("uidOnServer"), 87001);
      Assert.notEqual(
        key,
        87001,
        "Success owns a physical key distinct from UID"
      );
      Assert.ok(header.flags & Ci.nsMsgMessageFlags.Offline);
      Assert.equal(readOnlineIdentityBody(folder, header.storeToken), raw);
      Assert.equal(
        folder.getTotalMessages(false),
        1,
        "Membership precedes callback"
      );
    },
    onStopCopy() {
      completions++;
    },
  });
  try {
    IMAPPump.incomingServer.closeCachedConnections();
    MailServices.copy.copyFileMessage(
      file,
      folder,
      null,
      true,
      0,
      "",
      listener,
      null
    );
    const status = await listener.promise.then(
      () => Cr.NS_OK,
      error => Number(error.message)
    );
    const success = mode == "receipt" || mode == "observed";
    if (success) {
      Assert.equal(status, Cr.NS_OK);
      Assert.equal(keys.length, 1);
      const header = folder.msgDatabase.getMsgHdrForKey(keys[0]);
      Assert.equal(header.messageId, `${mode}@append-identity.invalid`);
      Assert.equal(header.numReferences, 2);
      Assert.equal(folder.getTotalMessages(false), 1);
      Assert.equal(folder.getNumUnread(false), 1);
      const refreshed = new PromiseTestUtils.PromiseUrlListener();
      folder.updateFolderWithListener(null, refreshed);
      await refreshed.promise;
      Assert.equal(folder.getTotalMessages(false), 1);
      Assert.equal(folder.getNumUnread(false), 1);
      const current = [...folder.messages];
      Assert.equal(current.length, 1);
      Assert.equal(current[0].messageKey, keys[0]);
      Assert.equal(readOnlineIdentityBody(folder, current[0].storeToken), raw);
      if (mode == "observed") {
        Assert.greater(searches, 0);
        Assert.greater(readbacks, 0);
      }
    } else {
      Assert.notEqual(
        status,
        Cr.NS_OK,
        "Unresolved identity cannot enter success cleanup"
      );
      Assert.deepEqual(keys, []);
      Assert.equal(folder.getTotalMessages(false), 0);
      Assert.equal([...folder.messages].length, 0);
      const connection = Cc[
        "@mozilla.org/msgDatabase/msgDBService;1"
      ].getService(Ci.nsIDatabaseCore).connectionForTests;
      const rows = connection.createStatement(
        "SELECT m.id,p.value AS token FROM staged_messages m " +
          "JOIN staged_message_properties p ON p.id=m.id AND p.name='storeToken' " +
          "WHERE m.folderId=:folder"
      );
      rows.params.folder = folder.id;
      try {
        Assert.ok(
          rows.executeStep(),
          "The genuine finished body remains unpublished recovery"
        );
        Assert.equal(readOnlineIdentityBody(folder, rows.row.token), raw);
        Assert.ok(!rows.executeStep(), "Exactly one retained staged append");
      } finally {
        rows.finalize();
      }
    }
    Assert.equal(appends, 1, "Discovery and lost replies never resend APPEND");
    Assert.equal(completions, 1);
    Assert.equal(
      await IOUtils.readUTF8(file.path),
      raw,
      "Original input is unchanged"
    );
  } finally {
    Object.assign(proto, saved);
    IMAPPump.incomingServer.closeCachedConnections();
  }
}

/**
 * Reads the real provider bytes without consuming a cached message string.
 *
 * @param {nsIMsgFolder} folder - The owner of the opaque token.
 * @param {string} token - The actual provider token, including retained staging.
 * @returns {string} The complete verbatim message bytes.
 */
function readOnlineIdentityBody(folder, token) {
  const { NetUtil } = ChromeUtils.importESModule(
    "resource://gre/modules/NetUtil.sys.mjs"
  );
  const stream = folder.msgStore.getMsgInputStream(folder, token, 0);
  try {
    let bytes = "";
    while (stream.available())
      bytes += NetUtil.readInputStreamToString(stream, stream.available());
    return bytes;
  } finally {
    stream.close();
  }
}

add_task(function endTest() {
  teardownIMAPPump();
});
