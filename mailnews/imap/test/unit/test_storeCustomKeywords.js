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
    const folder = IMAPPump.inbox;
    const header = folder.msgDatabase.getMsgHdrForMessageID(
      gSynthMessageForKeywordAdd.messageId
    );
    const key = header.messageKey;
    Assert.notEqual(key, 5002);
    Assert.equal(header.getUint32Property("uidOnServer"), 5002);
    Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 7801);
    const token = header.storeToken;
    const readBody = () => {
      const stream = folder.getMsgInputStream(header);
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
    const mailbox = IMAPPump.mailbox;
    const index = mailbox._messages.indexOf(gServerMessageForKeywordAdd);
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
      if (args[0] == "INBOX") {
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
      Assert.equal(header.getUint32Property("uidOnServer"), 5002);
      Assert.equal(folder.msgDatabase.dBFolderInfo.imapUidValidity, 7801);
      Assert.equal(result, Cr.NS_ERROR_NOT_AVAILABLE);
    } finally {
      proto.SELECT = originalSelect;
      proto.STORE = originalStore;
      IMAPPump.incomingServer.closeCachedConnections();
      await TestUtils.waitForCondition(
        () => !IMAPPump.daemon.getConnections().length
      );
      mailbox._messages.splice(index, 1, gServerMessageForKeywordAdd);
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
  await listener.promise;
}
