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

  setupIMAPPump();
  registerCleanupFunction(teardownIMAPPump);
  IMAPPump.mailbox.uidnext = 5001;
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
  gSynthMessageForKeywordAdd = messageGenerator.makeMessage();
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
