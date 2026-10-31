/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

var { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
var { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

const VALID_TAG_KEY = "validtag";
const MALFORMED_TAG_KEY = "invalid)";
// Thunderbird formerly derived non-ASCII tag keys using modified UTF-7 and
// lowercased the result.
const LEGACY_TAG_KEY = "&aok-";
// The fake server normalizes keyword capitalization before storing it.
const NORMALIZED_VALID_TAG_KEY = "Validtag";
const NORMALIZED_LEGACY_TAG_KEY = "&Aok-";

var gServerMessageForMixedKeywords;
var gServerMessageForKeywordAdd;
var gServerMessageForKeywordRemove;
var gSynthMessageForMixedKeywords;
var gSynthMessageForKeywordAdd;
var gSynthMessageForKeywordRemove;

add_setup(async function () {
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );

  Services.prefs.setCharPref(
    "mail.server.default.storeContractID",
    Services.prefs.getCharPref("mail.serverDefaultStoreContractID")
  );
  setupIMAPPump();
  registerCleanupFunction(teardownIMAPPump);
  IMAPPump.mailbox.uidnext = 5001;
  IMAPPump.mailbox.uidvalidity = 7801;
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.equal(
    "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
    Services.prefs.getBoolPref("mail.panorama.enabled", false),
    "The active backend matches the startup configuration"
  );
  const expectedStoreType = {
    "@mozilla.org/msgstore/berkeleystore;1": "mbox",
    "@mozilla.org/msgstore/maildirstore;1": "maildir",
  }[Services.prefs.getCharPref("mail.serverDefaultStoreContractID")];
  Assert.ok(expectedStoreType, "The fixture selects a supported body store");
  Assert.equal(
    IMAPPump.incomingServer.msgStore.storeType,
    expectedStoreType,
    "The fixture uses the configured body store"
  );

  const messageGenerator = new MessageGenerator();
  gSynthMessageForMixedKeywords = messageGenerator.makeMessage();
  gSynthMessageForKeywordAdd = messageGenerator.makeMessage({
    body: { body: "Retain these exact keyword source bytes." },
  });
  gSynthMessageForKeywordRemove = messageGenerator.makeMessage();

  gServerMessageForMixedKeywords = addMessageToServer(
    gSynthMessageForMixedKeywords,
    []
  );
  gServerMessageForKeywordAdd = addMessageToServer(
    gSynthMessageForKeywordAdd,
    []
  );
  gServerMessageForKeywordRemove = addMessageToServer(
    gSynthMessageForKeywordRemove,
    []
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
  Assert.equal(IMAPPump.inbox.msgStore.storeType, expectedStoreType);
  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, listener);
  await listener.promise;
});

add_task(async function testStoreValidKeywordAlongsideMalformedKeyword() {
  const header = IMAPPump.inbox.msgDatabase.getMsgHdrForMessageID(
    gSynthMessageForMixedKeywords.messageId
  );

  try {
    await storeCustomKeywords(
      header,
      `${VALID_TAG_KEY} ${MALFORMED_TAG_KEY}`,
      ""
    );
  } catch {
    // Check the server state even if it rejected the malformed batch.
  }

  Assert.ok(
    gServerMessageForMixedKeywords.flags.includes(NORMALIZED_VALID_TAG_KEY),
    "A valid keyword should be stored when another keyword is malformed"
  );
});

add_task(async function testStoreLegacyCustomKeyword() {
  const addHeader = IMAPPump.inbox.msgDatabase.getMsgHdrForMessageID(
    gSynthMessageForKeywordAdd.messageId
  );
  const removeHeader = IMAPPump.inbox.msgDatabase.getMsgHdrForMessageID(
    gSynthMessageForKeywordRemove.messageId
  );

  await storeCustomKeywords(addHeader, LEGACY_TAG_KEY, "");
  gServerMessageForKeywordRemove.setFlag(NORMALIZED_LEGACY_TAG_KEY);
  await storeCustomKeywords(removeHeader, "", LEGACY_TAG_KEY);

  Assert.deepEqual(
    {
      added: gServerMessageForKeywordAdd.flags.includes(
        NORMALIZED_LEGACY_TAG_KEY
      ),
      removed: !gServerMessageForKeywordRemove.flags.includes(
        NORMALIZED_LEGACY_TAG_KEY
      ),
    },
    { added: true, removed: true },
    "A legacy modified UTF-7 keyword should be added and removed"
  );
});

add_task(async function test_translatesGlobalKeysToServerUids() {
  const header = IMAPPump.inbox.msgDatabase.getMsgHdrForMessageID(
    gSynthMessageForKeywordAdd.messageId
  );
  const messageService = MailServices.messageServiceFromURI(
    IMAPPump.inbox.getUriForMsg(header)
  );
  const url = messageService.getUrlForUri(
    IMAPPump.inbox.getUriForMsg(header),
    null
  );
  Assert.equal(
    url.QueryInterface(Ci.nsIImapUrl).listOfMessageIds,
    "5002",
    "The fetch URL contains the server UID rather than the local key"
  );
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    Assert.notEqual(header.messageKey, 5002, "Panorama allocates a global key");
  }

  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.storeImapFlags(
    0x0004 /* kImapMsgFlaggedFlag */,
    true,
    [header.messageKey],
    listener
  );
  await listener.promise;
  Assert.ok(
    gServerMessageForKeywordAdd.flags.includes("\\Flagged"),
    "STORE targets the message with UID 5002"
  );
  Assert.ok(
    !gServerMessageForMixedKeywords.flags.includes("\\Flagged"),
    "STORE leaves the other server message unchanged"
  );
});

add_task(async function test_rejectsMissingAndAmbiguousBindings() {
  const folder = IMAPPump.inbox;
  const header = folder.msgDatabase.getMsgHdrForMessageID(
    gSynthMessageForKeywordAdd.messageId
  );
  const other = folder.msgDatabase.getMsgHdrForMessageID(
    gSynthMessageForKeywordRemove.messageId
  );
  const service = MailServices.messageServiceFromURI(
    folder.getUriForMsg(header)
  );
  Assert.throws(
    () => folder.storeCustomKeywords(null, "blocked", "", [0xffffffff]),
    error => error.result == Cr.NS_ERROR_INVALID_ARG,
    "The reserved message key cannot be sent to the server"
  );
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    const originalUid = header.getUint32Property("uidOnServer");
    const otherUid = other.getUint32Property("uidOnServer");
    const flagsBefore = IMAPPump.mailbox._messages.map(message => [
      ...message.flags,
    ]);
    try {
      header.setUint32Property("uidOnServer", 0);
      Assert.throws(
        () => service.getUrlForUri(folder.getUriForMsg(header), null),
        error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
        "A missing binding cannot produce a fetch URL"
      );
      Assert.throws(
        () =>
          folder.storeCustomKeywords(null, "blocked", "", [
            other.messageKey,
            header.messageKey,
          ]),
        error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
        "A batch with a missing binding cannot issue a partial STORE"
      );
      header.setUint32Property("uidOnServer", otherUid);
      Assert.throws(
        () => service.getUrlForUri(folder.getUriForMsg(header), null),
        error => error.result == Cr.NS_ERROR_FILE_CORRUPTED,
        "Two physical messages bound to one UID are ambiguous"
      );
      Assert.throws(
        () =>
          folder.storeImapFlags(
            0x0001 /* kImapMsgSeenFlag */,
            true,
            [header.messageKey],
            null
          ),
        error => error.result == Cr.NS_ERROR_FILE_CORRUPTED,
        "An ambiguous binding cannot issue STORE"
      );
      header.setUint32Property("uidOnServer", 0xffffffff);
      Assert.equal(
        service
          .getUrlForUri(folder.getUriForMsg(header), null)
          .QueryInterface(Ci.nsIImapUrl).listOfMessageIds,
        "4294967295",
        "The largest UID is independent of the reserved global key"
      );
    } finally {
      header.setUint32Property("uidOnServer", originalUid);
    }
    // Complete a later command so a mistakenly queued partial STORE is visible.
    await storeCustomKeywords(header, "translationbarrier", "");
    await storeCustomKeywords(header, "", "translationbarrier");
    Assert.deepEqual(
      IMAPPump.mailbox._messages.map(message => message.flags),
      flagsBefore,
      "Rejected translations leave every server message unchanged"
    );
  }
});

add_task(async function test_rejectedKeywordAddStopsBeforeRemove() {
  await checkRejectedKeywordStore("+FLAGS", "NO");
});

add_task(async function test_badKeywordAddStopsBeforeRemove() {
  await checkRejectedKeywordStore("+FLAGS", "BAD");
});

add_task(async function test_rejectedKeywordRemoveReportsPartialSuccess() {
  await checkRejectedKeywordStore("-FLAGS", "NO");
});

/**
 * Rejects one real keyword STORE and checks the error, retained bytes and retry.
 *
 * @param {string} rejectedAction - STORE action rejected by the server.
 * @param {string} response - Tagged failure response, NO or BAD.
 * @returns {Promise<void>} Resolves after checking retained bytes and retry.
 */
async function checkRejectedKeywordStore(rejectedAction, response) {
  const folder = IMAPPump.inbox;
  const header = folder.msgDatabase.getMsgHdrForMessageID(
    gSynthMessageForKeywordAdd.messageId
  );
  const key = header.messageKey;
  const uid = Services.prefs.getBoolPref("mail.panorama.enabled", false)
    ? header.getUint32Property("uidOnServer")
    : key;
  Assert.equal(uid, 5002);
  Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 7801);
  await storeCustomKeywords(header, "removeme", "addedlater");
  const downloaded = new PromiseTestUtils.PromiseUrlListener();
  folder.downloadAllForOffline(downloaded, null);
  await downloaded.promise;
  Assert.ok(header.flags & Ci.nsMsgMessageFlags.Offline);
  const token = header.storeToken;
  Assert.ok(token);
  const readBody = () => {
    const stream = folder.getMsgInputStream(header);
    try {
      let body = "";
      while (stream.available()) {
        body += NetUtil.readInputStreamToString(stream, stream.available());
      }
      return body;
    } finally {
      stream.close();
    }
  };
  const bytes = readBody();
  Assert.ok(bytes.includes("Retain these exact keyword source bytes."), bytes);
  const keys = folder.msgDatabase.listAllKeys();
  const texts = IMAPPump.mailbox._messages.map(message => message.getText());
  const flags = IMAPPump.mailbox._messages.map(message => [...message.flags]);
  const commands = [];
  const proto = IMAP_RFC3501_handler.prototype;
  const originalStore = proto.STORE;
  proto.STORE = function (args, isUid) {
    commands.push([String(args[0]), args[1]]);
    if (args[1] == rejectedAction) {
      return `${response} keyword rejected`;
    }
    return originalStore.call(this, args, isUid);
  };
  const deleted = [];
  const listener = {
    msgsDeleted(items) {
      deleted.push(...items.filter(item => item.folder == folder));
    },
  };
  MailServices.mfn.addListener(
    listener,
    Ci.nsIMsgFolderNotificationService.msgsDeleted
  );
  try {
    const calls = { starts: 0, stops: 0 };
    const completion = new PromiseTestUtils.PromiseUrlListener({
      OnStartRunningUrl() {
        calls.starts++;
      },
      OnStopRunningUrl() {
        calls.stops++;
      },
    });
    const uri = folder.storeCustomKeywords(null, "addedlater", "removeme", [
      key,
    ]);
    uri.QueryInterface(Ci.nsIMsgMailNewsUrl).RegisterListener(completion);
    const result = await completion.promise.then(
      () => Cr.NS_OK,
      error => Number(error.message)
    );
    Assert.equal(result, Cr.NS_MSG_ERROR_IMAP_COMMAND_FAILED);
    Assert.deepEqual(calls, { starts: 1, stops: 1 });
    const expectedCommands = [["5002", "+FLAGS"]];
    const expectedFlags = [...flags[1]];
    if (rejectedAction == "-FLAGS") {
      expectedCommands.push(["5002", "-FLAGS"]);
      expectedFlags.push("Addedlater");
    }
    Assert.deepEqual(commands, expectedCommands);
    Assert.deepEqual(gServerMessageForKeywordAdd.flags, expectedFlags);
    Assert.deepEqual(IMAPPump.mailbox._messages[0].flags, flags[0]);
    Assert.deepEqual(IMAPPump.mailbox._messages[2].flags, flags[2]);
    Assert.deepEqual(folder.msgDatabase.listAllKeys(), keys);
    Assert.equal(header.messageKey, key);
    Assert.equal(header.storeToken, token);
    Assert.equal(readBody(), bytes);
    Assert.deepEqual(
      IMAPPump.mailbox._messages.map(message => message.uid),
      [5001, 5002, 5003]
    );
    Assert.deepEqual(
      IMAPPump.mailbox._messages.map(message => message.getText()),
      texts
    );
    Assert.deepEqual(deleted, []);
  } finally {
    proto.STORE = originalStore;
    MailServices.mfn.removeListener(listener);
  }
  // Retry the requested pair; the previously applied addition is idempotent.
  await storeCustomKeywords(header, "addedlater", "removeme");
  Assert.ok(gServerMessageForKeywordAdd.flags.includes("Addedlater"));
  Assert.ok(!gServerMessageForKeywordAdd.flags.includes("Removeme"));
  Assert.equal(header.messageKey, key);
  Assert.equal(header.storeToken, token);
  Assert.equal(readBody(), bytes);
}

add_task(async function test_rejectedFullMaskDoesNotSendComplement() {
  const folder = IMAPPump.inbox;
  const header = folder.msgDatabase.getMsgHdrForMessageID(
    gSynthMessageForKeywordAdd.messageId
  );
  const key = header.messageKey;
  const marked = new PromiseTestUtils.PromiseUrlListener();
  folder.storeImapFlags(0x06, true, [key], marked); // Answered and Flagged.
  await marked.promise;
  Assert.ok(gServerMessageForKeywordAdd.flags.includes("\\Answered"));
  Assert.ok(gServerMessageForKeywordAdd.flags.includes("\\Flagged"));
  const flags = IMAPPump.mailbox._messages.map(message => [...message.flags]);
  const keys = folder.msgDatabase.listAllKeys();
  const localFlags = header.flags;
  const token = header.storeToken;
  const readBody = () => {
    const stream = folder.getMsgInputStream(header);
    try {
      let body = "";
      while (stream.available()) {
        body += NetUtil.readInputStreamToString(stream, stream.available());
      }
      return body;
    } finally {
      stream.close();
    }
  };
  const bytes = readBody();
  Assert.ok(bytes.includes("Retain these exact keyword source bytes."));
  const texts = IMAPPump.mailbox._messages.map(message => message.getText());
  const proto = IMAP_RFC3501_handler.prototype;
  const originalStore = proto.STORE;
  const commands = [];
  let reject = true;
  proto.STORE = function (args, isUid) {
    const action = args[1].toUpperCase();
    commands.push([String(args[0]), action]);
    if (reject && action == "+FLAGS") {
      return "NO full mask addition rejected";
    }
    return originalStore.call(this, args, isUid);
  };
  const setFlags = async () => {
    const calls = { starts: 0, stops: 0 };
    const listener = new PromiseTestUtils.PromiseUrlListener({
      OnStartRunningUrl() {
        calls.starts++;
      },
      OnStopRunningUrl() {
        calls.stops++;
      },
    });
    const uri = folder.setImapFlags([key], 0x05); // Seen and Flagged.
    uri.QueryInterface(Ci.nsIMsgMailNewsUrl).RegisterListener(listener);
    const result = await listener.promise.then(
      () => Cr.NS_OK,
      error => Number(error.message)
    );
    Assert.deepEqual(calls, { starts: 1, stops: 1 });
    return result;
  };
  try {
    Assert.equal(await setFlags(), Cr.NS_MSG_ERROR_IMAP_COMMAND_FAILED);
    Assert.deepEqual(commands, [["5002", "+FLAGS"]]);
    Assert.deepEqual(
      IMAPPump.mailbox._messages.map(message => message.flags),
      flags
    );
    Assert.deepEqual(folder.msgDatabase.listAllKeys(), keys);
    Assert.equal(header.messageKey, key);
    Assert.equal(header.flags, localFlags);
    Assert.equal(header.storeToken, token);
    Assert.equal(readBody(), bytes);
    reject = false;
    commands.length = 0;
    Assert.equal(await setFlags(), Cr.NS_OK);
    Assert.deepEqual(commands, [
      ["5002", "+FLAGS"],
      ["5002", "-FLAGS"],
    ]);
    Assert.ok(gServerMessageForKeywordAdd.flags.includes("\\Seen"));
    Assert.ok(gServerMessageForKeywordAdd.flags.includes("\\Flagged"));
    Assert.ok(!gServerMessageForKeywordAdd.flags.includes("\\Answered"));
    Assert.deepEqual(IMAPPump.mailbox._messages[0].flags, flags[0]);
    Assert.deepEqual(IMAPPump.mailbox._messages[2].flags, flags[2]);
    Assert.deepEqual(
      IMAPPump.mailbox._messages.map(message => message.getText()),
      texts
    );
    Assert.equal(readBody(), bytes);
  } finally {
    proto.STORE = originalStore;
  }
});

add_task(async function test_sparseKeywordChunksStopAtFirstFailureAndRetry() {
  const folder = IMAPPump.inbox;
  const selectedUids = [];
  const expectedTexts = [];
  for (let uid = 10001; uid <= 10400; uid++) {
    const text = [
      "From: chunk@example.invalid",
      "To: user@example.invalid",
      `Message-ID: <keyword-chunk-${uid}@example.invalid>`,
      `Subject: Sparse keyword chunk ${uid}`,
      "",
      `Keep exact chunk body ${uid}.`,
      "",
    ].join("\r\n");
    const uri = "data:text/plain;base64," + btoa(text);
    const message = new ImapMessage(uri, uid, []);
    message.setFlag("Keepchunk");
    IMAPPump.mailbox.addMessage(message);
    expectedTexts.push(text);
    if (uid % 2) {
      selectedUids.push(uid);
    }
  }
  IMAPPump.mailbox.uidnext = 10401;
  const selected = new PromiseTestUtils.PromiseUrlListener();
  folder.updateFolderWithListener(null, selected);
  await selected.promise;
  const keys = selectedUids.map(uid => {
    const header = folder.msgDatabase.getMsgHdrForMessageID(
      `keyword-chunk-${uid}@example.invalid`
    );
    Assert.ok(header);
    Assert.equal(header.folder, folder);
    if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
      Assert.notEqual(header.messageKey, uid);
      Assert.equal(header.getUint32Property("uidOnServer"), uid);
    } else {
      Assert.equal(header.messageKey, uid);
    }
    return header.messageKey;
  });
  Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 7801);
  const liveKeys = folder.msgDatabase.listAllKeys();
  Assert.equal(liveKeys.length, 403);
  const proto = IMAP_RFC3501_handler.prototype;
  const originalStore = proto.STORE;
  const commands = [];
  const dispatchedUids = [];
  let reject = true;
  proto.STORE = function (args, isUid) {
    commands.push(String(args[0]));
    Assert.ok(isUid);
    Assert.equal(args[1], "+FLAGS");
    Assert.deepEqual(args[2], ["Chunkadded"]);
    if (reject) {
      return "NO first keyword chunk rejected";
    }
    dispatchedUids.push(
      ...this._parseSequenceSet(args[0], isUid, []).map(message => message.uid)
    );
    return originalStore.call(this, args, isUid);
  };
  const runStore = async () => {
    const calls = { starts: 0, stops: 0 };
    const listener = new PromiseTestUtils.PromiseUrlListener({
      OnStartRunningUrl() {
        calls.starts++;
      },
      OnStopRunningUrl() {
        calls.stops++;
      },
    });
    const uri = folder.storeCustomKeywords(null, "chunkadded", "", keys);
    uri.QueryInterface(Ci.nsIMsgMailNewsUrl).RegisterListener(listener);
    const result = await listener.promise.then(
      () => Cr.NS_OK,
      error => Number(error.message)
    );
    Assert.deepEqual(calls, { starts: 1, stops: 1 });
    return result;
  };
  try {
    Assert.equal(await runStore(), Cr.NS_MSG_ERROR_IMAP_COMMAND_FAILED);
    Assert.equal(commands.length, 1, "A rejection stops later UID chunks");
    const messages = IMAPPump.mailbox._messages.slice(3);
    Assert.equal(messages.length, 400);
    for (const message of messages) {
      Assert.deepEqual(message.flags, ["Keepchunk"]);
    }
    reject = false;
    commands.length = 0;
    Assert.equal(await runStore(), Cr.NS_OK);
    Assert.greater(commands.length, 1, "The real UID set requires chunking");
    Assert.deepEqual(
      dispatchedUids,
      selectedUids,
      "Each requested UID occurs once"
    );
    for (const message of messages) {
      Assert.deepEqual(
        message.flags,
        message.uid % 2 ? ["Keepchunk", "Chunkadded"] : ["Keepchunk"]
      );
    }
    Assert.deepEqual(
      messages.map(message => message.getText()),
      expectedTexts
    );
    Assert.deepEqual(folder.msgDatabase.listAllKeys(), liveKeys);
  } finally {
    proto.STORE = originalStore;
  }
});

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_rejectsReusedUidAfterReconnect() {
    const folder = await createImapSubfolder("KeywordReusedEpoch");
    folder.clearFlag(Ci.nsMsgFolderFlags.Offline);
    const mailbox = IMAPPump.daemon.getMailbox("KeywordReusedEpoch");
    mailbox.uidvalidity = 7801;
    const originalMessage = new ImapMessage(
      "data:text/plain;base64," + btoa(gServerMessageForKeywordAdd.getText()),
      5002,
      []
    );
    mailbox.addMessage(originalMessage);
    mailbox.uidnext = 5003;
    const synchronized = new PromiseTestUtils.PromiseUrlListener();
    folder.updateFolderWithListener(null, synchronized);
    await synchronized.promise;
    const header = folder.msgDatabase.getMsgHdrForMessageID(
      gSynthMessageForKeywordAdd.messageId
    );
    const downloaded = new PromiseTestUtils.PromiseUrlListener();
    folder.downloadAllForOffline(downloaded, null);
    await downloaded.promise;
    Assert.ok(header.flags & Ci.nsMsgMessageFlags.Offline);
    const key = header.messageKey;
    Assert.notEqual(key, 5002);
    Assert.equal(header.getUint32Property("uidOnServer"), 5002);
    Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 7801);
    const token = header.storeToken;
    const readBody = (stream = folder.getMsgInputStream(header)) => {
      try {
        let text = "";
        while (stream.available()) {
          text += NetUtil.readInputStreamToString(stream, stream.available());
        }
        return text;
      } finally {
        stream.close();
      }
    };
    const bytes = readBody();
    Assert.ok(bytes.includes("Retain these exact keyword source bytes."));
    const keys = folder.msgDatabase.listAllKeys();
    IMAPPump.incomingServer.closeCachedConnections();
    await TestUtils.waitForCondition(
      () => !IMAPPump.daemon.getConnections().length
    );
    const replacementText = [
      "From: replacement@example.invalid",
      "To: user@example.invalid",
      "Message-ID: <replacement-epoch-7802@example.invalid>",
      "Subject: A different physical server message",
      "",
      "The reused UID must not receive the old epoch's keyword.",
      "",
    ].join("\r\n");
    const replacement = new ImapMessage(
      "data:text/plain;base64," + btoa(replacementText),
      5002,
      []
    );
    const index = mailbox._messages.indexOf(originalMessage);
    Assert.greaterOrEqual(index, 0);
    mailbox._messages.splice(index, 1, replacement);
    mailbox.uidvalidity = 7802;
    const proto = IMAP_RFC3501_handler.prototype;
    const originalSelect = proto.SELECT;
    const originalStore = proto.STORE;
    const selectedEpochs = [];
    const stores = [];
    proto.SELECT = function (args) {
      const result = originalSelect.call(this, args);
      if (args[0] == "KeywordReusedEpoch") {
        selectedEpochs.push(this._selectedMailbox.uidvalidity);
        Assert.ok(result.includes("[UIDVALIDITY 7802]"));
      }
      return result;
    };
    proto.STORE = function (args, uid) {
      stores.push(String(args[0]));
      return originalStore.call(this, args, uid);
    };
    try {
      const calls = { starts: 0, stops: 0 };
      const completion = new PromiseTestUtils.PromiseUrlListener({
        OnStartRunningUrl() {
          calls.starts++;
        },
        OnStopRunningUrl() {
          calls.stops++;
        },
      });
      const uri = folder.storeCustomKeywords(null, "wrong-epoch", "", [key]);
      Assert.equal(uri.QueryInterface(Ci.nsIImapUrl).listOfMessageIds, "5002");
      uri.QueryInterface(Ci.nsIMsgMailNewsUrl).RegisterListener(completion);
      const result = await completion.promise.then(
        () => Cr.NS_OK,
        error => Number(error.message)
      );
      Assert.deepEqual(calls, { starts: 1, stops: 1 });
      Assert.deepEqual(selectedEpochs, [7802]);
      Assert.deepEqual(stores, []);
      Assert.deepEqual(replacement.flags, []);
      Assert.equal(replacement.getText(), replacementText);
      Assert.deepEqual(folder.msgDatabase.listAllKeys(), keys);
      Assert.equal(header.messageKey, key);
      Assert.equal(header.storeToken, token);
      Assert.equal(readBody(), bytes);
      Assert.equal(
        header.getUint32Property("uidOnServer"),
        5002,
        "Observation retains the old binding for checked reconciliation"
      );
      Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 7801);
      Assert.equal(result, Cr.NS_ERROR_NOT_AVAILABLE);

      const resynchronized = new PromiseTestUtils.PromiseUrlListener();
      folder.updateFolderWithListener(null, resynchronized);
      await resynchronized.promise;
      const database = folder.msgDatabase;
      const replacementHeader = database.getMsgHdrForMessageID(
        "replacement-epoch-7802@example.invalid"
      );
      Assert.equal(database.dBFolderInfo.imapUidValidity, 7802);
      Assert.ok(!database.containsKey(key), "The old physical row is removed");
      Assert.equal(replacementHeader.folder, folder);
      Assert.notEqual(replacementHeader.messageKey, key);
      Assert.equal(replacementHeader.getUint32Property("uidOnServer"), 5002);
      Assert.deepEqual(database.listAllKeys(), [replacementHeader.messageKey]);
      Assert.equal(database.dBFolderInfo.numMessages, 1);
      Assert.equal(folder.getTotalMessages(false), 1);
      Assert.equal(
        readBody(folder.msgStore.getMsgInputStream(folder, token, 0)),
        bytes,
        "Epoch reconciliation retains the original physical body bytes"
      );

      const repeated = new PromiseTestUtils.PromiseUrlListener();
      folder.updateFolderWithListener(null, repeated);
      await repeated.promise;
      Assert.deepEqual(
        folder.msgDatabase.listAllKeys(),
        [replacementHeader.messageKey],
        "Repeated synchronization creates no duplicate or orphan rows"
      );
      Assert.equal(replacementHeader.getUint32Property("uidOnServer"), 5002);
      Assert.deepEqual(replacement.flags, []);
      Assert.equal(replacement.getText(), replacementText);
    } finally {
      proto.SELECT = originalSelect;
      proto.STORE = originalStore;
      IMAPPump.incomingServer.closeCachedConnections();
      await TestUtils.waitForCondition(
        () => !IMAPPump.daemon.getConnections().length
      );
      mailbox._messages.splice(index, 1, originalMessage);
      mailbox.uidvalidity = 7801;
    }
  });
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_rawUidKeywordsWithoutStoredEpoch() {
    const name = "raw-keywords";
    IMAPPump.daemon.createMailbox(name, {
      subscribed: true,
      uidvalidity: 7901,
    });
    const remote = IMAPPump.daemon.getMailbox(name);
    const text = [
      "From: raw@example.invalid",
      "To: user@example.invalid",
      "Message-ID: <raw-keyword-uid-6101@example.invalid>",
      "Subject: Raw protocol UID",
      "",
      "Keep these independent raw UID bytes.",
      "",
    ].join("\r\n");
    const message = new ImapMessage(
      "data:text/plain;base64," + btoa(text),
      6101,
      []
    );
    remote.addMessage(message);
    remote.uidnext = 6102;
    const discovered = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.discoverAllFolders(
      IMAPPump.incomingServer.rootFolder,
      discovered,
      null
    );
    await discovered.promise;
    const folder = IMAPPump.incomingServer.rootFolder.getChildNamed(name);
    Assert.ok(folder.id);
    Assert.equal(
      folder.msgStore.storeType,
      IMAPPump.incomingServer.msgStore.storeType
    );
    Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 0);
    Assert.deepEqual(folder.msgDatabase.listAllKeys(), []);
    const listener = new PromiseTestUtils.PromiseUrlListener();
    const uri = MailServices.imap.storeCustomKeywords(
      folder,
      null,
      "rawcold",
      "",
      "6101"
    );
    Assert.equal(uri.QueryInterface(Ci.nsIImapUrl).listOfMessageIds, "6101");
    uri.QueryInterface(Ci.nsIMsgMailNewsUrl).RegisterListener(listener);
    await listener.promise;
    Assert.deepEqual(message.flags, ["Rawcold"]);
    Assert.equal(message.uid, 6101);
    Assert.equal(message.getText(), text);
    Assert.equal(remote.uidvalidity, 7901);
    Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 7901);
  });
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_missingKeywordUidHasNoConfirmation() {
    await checkKeywordCommandEvidence("missing");
  });
  add_task(async function test_cachedKeywordNeedsFreshResponse() {
    await checkKeywordCommandEvidence("cached");
  });
  add_task(async function test_keywordFlagsWithoutUidAreNotEvidence() {
    await checkKeywordCommandEvidence("flags-only");
  });
  add_task(async function test_unappliedKeywordIsNotConfirmed() {
    await checkKeywordCommandEvidence("unapplied");
  });
  add_task(async function test_unappliedKeywordRemovalIsNotConfirmed() {
    await checkKeywordCommandEvidence("remove-unapplied");
  });
  add_task(async function test_keywordCompletionRejectsBindingCollision() {
    await checkKeywordCommandEvidence("collision");
  });
  add_task(async function test_keywordCompletionRejectsChangedEpoch() {
    await checkKeywordChangedEpoch();
  });
  add_task(async function test_keywordCommandFailurePrecedesStorageFailure() {
    await checkKeywordCommandEvidence("storage-no");
  });
  add_task(async function test_keywordStorageFailureReachesListener() {
    await checkKeywordCommandEvidence("storage");
  });
}

/**
 * Checks fresh UID/keyword evidence, native settlement errors and retry.
 *
 * @param {string} mode - Missing response, cached state, FLAGS-only response,
 *   unapplied addition/removal, changed identity or a native metadata error.
 */
async function checkKeywordCommandEvidence(mode) {
  const folder = IMAPPump.inbox;
  const db = folder.msgDatabase;
  const header = db.getMsgHdrForMessageID(gSynthMessageForKeywordAdd.messageId);
  const key = header.messageKey;
  Assert.notEqual(key, 5002);
  const keyword = `evidence-${mode}`;
  const removing = mode == "remove-unapplied";
  const other = db.getMsgHdrForMessageID(
    gSynthMessageForKeywordRemove.messageId
  );
  const otherUid = other.getUint32Property("uidOnServer");
  const otherKeywords = other.getStringProperty("keywords");
  if (mode == "cached" || removing) {
    await storeCustomKeywords(header, keyword, "");
    Assert.ok(
      header.getStringProperty("keywords").toLowerCase().includes(keyword)
    );
  }
  const downloaded = new PromiseTestUtils.PromiseUrlListener();
  folder.downloadAllForOffline(downloaded, null);
  await downloaded.promise;
  const token = header.storeToken;
  Assert.ok(token);
  const readBody = () => {
    const stream = folder.getMsgInputStream(header);
    try {
      let bytes = "";
      while (stream.available()) {
        bytes += NetUtil.readInputStreamToString(stream, stream.available());
      }
      return bytes;
    } finally {
      stream.close();
    }
  };
  const bytes = readBody();
  Assert.ok(bytes.includes("Retain these exact keyword source bytes."));
  const keys = db.listAllKeys();
  const serverMessages = [...IMAPPump.mailbox._messages];
  const texts = serverMessages.map(message => message.getText());
  const otherFlags = serverMessages
    .filter(message => message.uid != 5002)
    .map(message => [...message.flags]);
  const keywords = header.getStringProperty("keywords");
  const connection = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  ).connectionForTests;
  if (mode.startsWith("storage")) {
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER reject_keyword_settlement BEFORE UPDATE OF tags ON messages " +
        `WHEN OLD.id=${key} BEGIN SELECT RAISE(ABORT,'keyword settlement'); END`
    );
  }
  const proto = IMAP_RFC3501_handler.prototype;
  const originalStore = proto.STORE;
  const commands = [];
  proto.STORE = function (args, isUid) {
    commands.push([String(args[0]), args[1]]);
    Assert.ok(isUid);
    if (mode == "missing") {
      IMAPPump.mailbox._messages = serverMessages.filter(
        message => message.uid != 5002
      );
    } else if (mode == "cached") {
      return "OK STORE completed";
    } else if (mode == "unapplied" || removing) {
      return `* 2 FETCH (FLAGS (${gServerMessageForKeywordAdd.flags.join(" ")}) UID 5002)\0OK STORE completed`;
    }
    const response = originalStore.call(this, args, isUid);
    if (mode == "collision") {
      other.setUint32Property("uidOnServer", 5002);
    }
    if (mode == "storage-no") {
      return response.replace(
        /OK STORE completed$/,
        "NO partial STORE rejected"
      );
    }
    return mode == "flags-only" ? response.replace(/ UID \d+/g, "") : response;
  };
  const deleted = [];
  const notifier = {
    msgsDeleted(items) {
      deleted.push(...items.filter(item => item.folder == folder));
    },
  };
  MailServices.mfn.addListener(
    notifier,
    Ci.nsIMsgFolderNotificationService.msgsDeleted
  );
  try {
    const calls = { starts: 0, stops: 0 };
    const listener = new PromiseTestUtils.PromiseUrlListener({
      OnStartRunningUrl() {
        calls.starts++;
      },
      OnStopRunningUrl() {
        calls.stops++;
      },
    });
    const uri = folder.storeCustomKeywords(
      null,
      removing ? "" : keyword,
      removing ? keyword : "",
      [key]
    );
    uri.QueryInterface(Ci.nsIMsgMailNewsUrl).RegisterListener(listener);
    const result = await listener.promise.then(
      () => Cr.NS_OK,
      error => Number(error.message)
    );
    let expectedResult = Cr.NS_ERROR_NOT_AVAILABLE;
    if (mode == "storage-no") {
      expectedResult = Cr.NS_MSG_ERROR_IMAP_COMMAND_FAILED;
    } else if (mode == "storage") {
      expectedResult = Cr.NS_ERROR_STORAGE_CONSTRAINT;
    } else if (mode == "collision") {
      expectedResult = Cr.NS_ERROR_FILE_CORRUPTED;
    }
    Assert.equal(result, expectedResult, mode);
    Assert.deepEqual(calls, { starts: 1, stops: 1 });
    Assert.deepEqual(commands, [["5002", removing ? "-FLAGS" : "+FLAGS"]]);
    // Check rejected identity changes before restoring only the injected fixture.
    Assert.equal(header.getStringProperty("keywords"), keywords);
    Assert.equal(other.getStringProperty("keywords"), otherKeywords);
    if (mode == "collision") {
      Assert.equal(other.getUint32Property("uidOnServer"), 5002);
      other.setUint32Property("uidOnServer", otherUid);
    }
    Assert.deepEqual(db.listAllKeys(), keys);
    Assert.equal(header.messageKey, key);
    Assert.equal(header.getUint32Property("uidOnServer"), 5002);
    Assert.equal(db.dBFolderInfo.imapUidValidity, 7801);
    Assert.equal(header.storeToken, token);
    Assert.equal(readBody(), bytes);
    Assert.deepEqual(
      serverMessages.map(message => message.getText()),
      texts
    );
    Assert.deepEqual(
      serverMessages
        .filter(message => message.uid != 5002)
        .map(message => [...message.flags]),
      otherFlags
    );
    Assert.deepEqual(deleted, []);
  } finally {
    proto.STORE = originalStore;
    IMAPPump.mailbox._messages = serverMessages;
    if (mode == "collision") {
      other.setUint32Property("uidOnServer", otherUid);
    }
    MailServices.mfn.removeListener(notifier);
    if (mode.startsWith("storage")) {
      connection.executeSimpleSQL("DROP TRIGGER reject_keyword_settlement");
    }
  }
  await storeCustomKeywords(
    header,
    removing ? "" : keyword,
    removing ? keyword : ""
  );
  Assert.equal(
    gServerMessageForKeywordAdd.flags.some(
      flag => flag.toLowerCase() == keyword
    ),
    !removing
  );
  Assert.equal(
    header
      .getStringProperty("keywords")
      .toLowerCase()
      .split(" ")
      .includes(keyword),
    !removing
  );
  Assert.equal(header.storeToken, token);
  Assert.equal(readBody(), bytes);
}

/** Checks completion after native epoch retirement without reactivating it. */
async function checkKeywordChangedEpoch() {
  const name = "keyword-completion-epoch";
  const remote = IMAPPump.daemon.createMailbox(name, {
    subscribed: true,
    uidvalidity: 8101,
  });
  const text = [
    "From: epoch@example.invalid",
    "To: user@example.invalid",
    "Message-ID: <keyword-completion-epoch@example.invalid>",
    "Subject: Retain physical source after epoch change",
    "",
    "Retain these independent epoch source bytes.",
    "",
  ].join("\r\n");
  const message = new ImapMessage(
    "data:text/plain;base64," + btoa(text),
    9101,
    []
  );
  remote.addMessage(message);
  remote.uidnext = 9102;
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
  const db = folder.msgDatabase;
  const header = db.getMsgHdrForMessageID(
    "keyword-completion-epoch@example.invalid"
  );
  Assert.ok(header);
  const key = header.messageKey;
  Assert.notEqual(key, 9101);
  Assert.equal(header.getUint32Property("uidOnServer"), 9101);
  Assert.equal(db.dBFolderInfo.imapUidValidity, 8101);
  const downloaded = new PromiseTestUtils.PromiseUrlListener();
  folder.downloadAllForOffline(downloaded, null);
  await downloaded.promise;
  const token = header.storeToken;
  Assert.ok(token);
  const readBody = () => {
    const stream = folder.getMsgInputStream(header);
    try {
      let bytes = "";
      while (stream.available()) {
        bytes += NetUtil.readInputStreamToString(stream, stream.available());
      }
      return bytes;
    } finally {
      stream.close();
    }
  };
  const bytes = readBody();
  Assert.ok(bytes.includes("Retain these independent epoch source bytes."));
  const keywords = header.getStringProperty("keywords");
  const proto = IMAP_RFC3501_handler.prototype;
  const originalStore = proto.STORE;
  let stores = 0;
  proto.STORE = function (args, isUid) {
    Assert.equal(this._selectedMailbox, remote);
    Assert.ok(isUid);
    Assert.deepEqual(
      [String(args[0]), args[1], args[2].map(flag => flag.toLowerCase())],
      ["9101", "+FLAGS", ["epochguard"]]
    );
    stores++;
    const response = originalStore.call(this, args, isUid);
    // Epoch changes retire bindings. The test never resets or guesses one.
    db.dBFolderInfo.imapUidValidity = 8102;
    return response;
  };
  const deleted = [];
  const notifier = {
    msgsDeleted(items) {
      deleted.push(...items.filter(item => item.folder == folder));
    },
  };
  MailServices.mfn.addListener(
    notifier,
    Ci.nsIMsgFolderNotificationService.msgsDeleted
  );
  try {
    const calls = { starts: 0, stops: 0 };
    const listener = new PromiseTestUtils.PromiseUrlListener({
      OnStartRunningUrl() {
        calls.starts++;
      },
      OnStopRunningUrl() {
        calls.stops++;
      },
    });
    const uri = folder.storeCustomKeywords(null, "epochguard", "", [key]);
    uri.QueryInterface(Ci.nsIMsgMailNewsUrl).RegisterListener(listener);
    const result = await listener.promise.then(
      () => Cr.NS_OK,
      error => Number(error.message)
    );
    Assert.equal(result, Cr.NS_ERROR_NOT_AVAILABLE);
    Assert.deepEqual(calls, { starts: 1, stops: 1 });
    Assert.equal(stores, 1);
    Assert.equal(db.dBFolderInfo.imapUidValidity, 8102);
    Assert.equal(header.getUint32Property("uidOnServer"), 0);
    Assert.deepEqual(db.listAllKeys(), [key]);
    Assert.equal(header.getStringProperty("keywords"), keywords);
    Assert.equal(header.storeToken, token);
    Assert.equal(readBody(), bytes);
    Assert.deepEqual(message.flags, ["Epochguard"]);
    Assert.equal(message.getText(), text);
    Assert.equal(remote.uidvalidity, 8101);
    Assert.deepEqual(
      remote._messages.map(item => item.uid),
      [9101]
    );
    Assert.deepEqual(deleted, []);
    Assert.throws(
      () => folder.storeCustomKeywords(null, "blocked", "", [key]),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
      "A retired binding cannot be guessed for retry"
    );
    Assert.equal(stores, 1);
  } finally {
    proto.STORE = originalStore;
    MailServices.mfn.removeListener(notifier);
  }
}

add_task(async function test_rawKeywordStoreKeepsUncachedUids() {
  const name = "raw-uncached-keywords";
  const remote = IMAPPump.daemon.createMailbox(name, {
    subscribed: true,
    uidvalidity: 8201,
  });
  const text = uid =>
    [
      "From: uncached@example.invalid",
      "To: user@example.invalid",
      `Message-ID: <uncached-keyword-${uid}@example.invalid>`,
      "Subject: Retain every requested UID",
      "",
      `Literal uncached UID ${uid} body.`,
      "",
    ].join("\r\n");
  const known = new ImapMessage(
    "data:text/plain;base64," + btoa(text(1001)),
    1001,
    []
  );
  remote.addMessage(known);
  remote.uidnext = 1002;
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
  Assert.equal(
    folder.msgStore.storeType,
    IMAPPump.incomingServer.msgStore.storeType
  );
  const selected = new PromiseTestUtils.PromiseUrlListener();
  folder.updateFolderWithListener(null, selected);
  await selected.promise;
  const header = folder.msgDatabase.getMsgHdrForMessageID(
    "uncached-keyword-1001@example.invalid"
  );
  Assert.ok(header);
  const key = header.messageKey;
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    Assert.notEqual(key, 1001);
  }
  Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 8201);
  const downloaded = new PromiseTestUtils.PromiseUrlListener();
  folder.downloadAllForOffline(downloaded, null);
  await downloaded.promise;
  const token = header.storeToken;
  Assert.ok(token);
  const readBody = () => {
    const stream = folder.getMsgInputStream(header);
    try {
      let bytes = "";
      while (stream.available()) {
        bytes += NetUtil.readInputStreamToString(stream, stream.available());
      }
      return bytes;
    } finally {
      stream.close();
    }
  };
  const bytes = readBody();
  Assert.ok(bytes.includes("Literal uncached UID 1001 body."));
  const flags = [...known.flags];
  // Real arrivals after SELECT. Do not reset or manufacture the client cache.
  for (const uid of [1003, 1004, 1005]) {
    remote.addMessage(
      new ImapMessage("data:text/plain;base64," + btoa(text(uid)), uid, [])
    );
  }
  remote.uidnext = 1006;
  const proto = IMAP_RFC3501_handler.prototype;
  const originalStore = proto.STORE;
  const commands = [];
  proto.STORE = function (args, isUid) {
    Assert.equal(this._selectedMailbox, remote);
    Assert.ok(isUid);
    commands.push([String(args[0]), args[1]]);
    return originalStore.call(this, args, isUid);
  };
  try {
    for (const [uids, keyword] of [
      ["1003,1005", "uncached"],
      ["1005:1003", "reverserange"],
    ]) {
      const calls = { starts: 0, stops: 0 };
      const listener = new PromiseTestUtils.PromiseUrlListener({
        OnStartRunningUrl() {
          calls.starts++;
        },
        OnStopRunningUrl() {
          calls.stops++;
        },
      });
      const uri = MailServices.imap.storeCustomKeywords(
        folder,
        null,
        keyword,
        "",
        uids
      );
      uri.QueryInterface(Ci.nsIMsgMailNewsUrl).RegisterListener(listener);
      await listener.promise;
      Assert.deepEqual(calls, { starts: 1, stops: 1 });
      if (keyword == "uncached") {
        Assert.deepEqual(commands, [["1003,1005", "+FLAGS"]]);
        Assert.deepEqual(
          remote._messages[2].flags,
          [],
          "UID1004 was not requested"
        );
      }
    }
    Assert.deepEqual(commands, [
      ["1003,1005", "+FLAGS"],
      ["1005,1004,1003", "+FLAGS"],
    ]);
    Assert.deepEqual(
      remote._messages.map(message => message.uid),
      [1001, 1003, 1004, 1005]
    );
    Assert.deepEqual(known.flags, flags);
    for (const message of remote._messages) {
      Assert.equal(message.getText(), text(message.uid));
      if (message.uid != 1001) {
        Assert.deepEqual(
          message.flags,
          message.uid == 1004 ? ["Reverserange"] : ["Uncached", "Reverserange"]
        );
      }
    }
    Assert.equal(header.messageKey, key);
    Assert.ok(folder.msgDatabase.containsKey(key));
    Assert.equal(header.storeToken, token);
    Assert.equal(readBody(), bytes);
    Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 8201);
  } finally {
    proto.STORE = originalStore;
  }
});

add_task(function test_rejectsRetiredBindings() {
  const folder = IMAPPump.inbox;
  const header = folder.msgDatabase.getMsgHdrForMessageID(
    gSynthMessageForKeywordAdd.messageId
  );
  const uri = folder.getUriForMsg(header);
  const service = MailServices.messageServiceFromURI(uri);
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    const info = folder.msgDatabase.dBFolderInfo;
    info.imapUidValidity++;
    Assert.ok(
      folder.msgDatabase.containsKey(header.messageKey),
      "Changing the epoch retains the physical message"
    );
    Assert.throws(
      () => service.getUrlForUri(uri, null),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
      "An old epoch's binding cannot produce a fetch URL"
    );
    Assert.throws(
      () =>
        folder.storeCustomKeywords(null, "blocked", "", [header.messageKey]),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
      "An old epoch's binding cannot issue STORE"
    );
  } else {
    Assert.equal(
      service.getUrlForUri(uri, null).QueryInterface(Ci.nsIImapUrl)
        .listOfMessageIds,
      "5002",
      "The legacy reference continues to use its UID-as-key mapping"
    );
  }
});

function addMessageToServer(synthMessage, flags) {
  const msgURI = Services.io.newURI(
    "data:text/plain;base64," + btoa(synthMessage.toMessageString())
  );
  const message = new ImapMessage(
    msgURI.spec,
    IMAPPump.mailbox.uidnext++,
    flags
  );
  IMAPPump.mailbox.addMessage(message);
  return message;
}

async function storeCustomKeywords(header, flagsToAdd, flagsToRemove) {
  const uri = IMAPPump.inbox.storeCustomKeywords(
    null,
    flagsToAdd,
    flagsToRemove,
    [header.messageKey]
  );
  uri.QueryInterface(Ci.nsIMsgMailNewsUrl);
  const listener = new PromiseTestUtils.PromiseUrlListener();
  uri.RegisterListener(listener);
  try {
    await listener.promise;
  } catch (error) {
    info(
      `Keyword key=${header.messageKey} add=${flagsToAdd} remove=${flagsToRemove}; local=${header.getStringProperty("keywords")}`
    );
    throw error;
  }
}
