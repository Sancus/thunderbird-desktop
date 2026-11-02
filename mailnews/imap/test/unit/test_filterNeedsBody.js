/*
 * This file tests the needsBody attribute added to a
 *  custom filter action in bug 555051.
 *
 * Original author: Kent James <kent@caspia.com>
 * adapted from test_imapFilterActions.js
 */

"use strict";

const { NetUtil: filterNetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

/* import-globals-from ../../../test/resources/logHelper.js */
load("../../../resources/logHelper.js");

// Globals
var gFilter; // a message filter with a subject search
var gAction; // current message action (reused)
var gMessage = "draft1"; // message file used as the test message
let gSecondAction = null;
let gExpectedUid;
let gBodyHeader = null;
let gParsedKey;
let gInjectedMessage;
let gInjectedSource;
let gBodyBytes;
let gFailedActions = [];

// Definition of tests
var tests = [
  setupFilterPump,
  setup,
  function NeedsBodyTrue() {
    gAction.type = Ci.nsMsgFilterAction.Custom;
    gAction.customId = "mailnews@mozilla.org#testOffline";
    actionTestOffline.needsBody = true;
    gAction.strValue = "true";
  },
  runFilterAction,
  function NeedsBodyFalse() {
    gAction.type = Ci.nsMsgFilterAction.Custom;
    gAction.customId = "mailnews@mozilla.org#testOffline";
    actionTestOffline.needsBody = false;
    gAction.strValue = "false";
  },
  runFilterAction,
];

/**
 * Starts the real server pump and awaits its native folder discovery.
 *
 * @returns {Promise<void>} Resolves after the selected store and INBOX exist.
 */
async function setupFilterPump() {
  const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  if (native) {
    const storePref = "mail.server.default.storeContractID";
    const autosyncPref = "mail.server.default.autosync_offline_stores";
    const hadStore = Services.prefs.prefHasUserValue(storePref);
    const oldStore = Services.prefs.getCharPref(storePref, "");
    const hadAutosync = Services.prefs.prefHasUserValue(autosyncPref);
    const oldAutosync = Services.prefs.getBoolPref(autosyncPref, true);
    registerCleanupFunction(() => {
      if (hadStore) {
        Services.prefs.setCharPref(storePref, oldStore);
      } else {
        Services.prefs.clearUserPref(storePref);
      }
      if (hadAutosync) {
        Services.prefs.setBoolPref(autosyncPref, oldAutosync);
      } else {
        Services.prefs.clearUserPref(autosyncPref);
      }
    });
    Services.prefs.setCharPref(
      storePref,
      Services.prefs.getCharPref("mail.serverDefaultStoreContractID")
    );
    Services.prefs.setBoolPref(autosyncPref, false);
  }
  registerCleanupFunction(() => {
    if (IMAPPump.incomingServer) {
      teardownIMAPPump();
    }
  });
  setupIMAPPump();
  if (native) {
    const root = IMAPPump.incomingServer.rootFolder;
    const discovered = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.discoverAllFolders(root, discovered, null);
    await discovered.promise;
    const inbox = root.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
    Assert.ok(inbox, "Native discovery supplied the actual INBOX");
    IMAPPump.inbox = inbox.QueryInterface(Ci.nsIMsgImapMailFolder);
    Assert.equal(IMAPPump.inbox.parent, root);
    Assert.equal(IMAPPump.inbox.server, IMAPPump.incomingServer);
    const expectedStore = {
      "@mozilla.org/msgstore/berkeleystore;1": "mbox",
      "@mozilla.org/msgstore/maildirstore;1": "maildir",
    }[Services.prefs.getCharPref("mail.serverDefaultStoreContractID")];
    Assert.ok(expectedStore);
    Assert.equal(IMAPPump.incomingServer.msgStore.storeType, expectedStore);
    Assert.equal(IMAPPump.inbox.msgStore.storeType, expectedStore);
  }
}

function setup() {
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    IMAPPump.mailbox.uidvalidity = 6301;
    IMAPPump.mailbox.uidnext = 6401;
  }
  // Create a test filter.
  const filterList = IMAPPump.incomingServer.getFilterList(null);
  gFilter = filterList.createFilter("test offline");
  const searchTerm = gFilter.createTerm();
  searchTerm.matchAll = true;

  gFilter.appendTerm(searchTerm);
  gFilter.enabled = true;

  // an action that can be modified by tests
  gAction = gFilter.createAction();

  // add the custom actions
  MailServices.filters.addCustomAction(actionTestOffline);
}

// basic preparation done for each test
async function runFilterAction() {
  const filterList = IMAPPump.incomingServer.getFilterList(null);
  while (filterList.filterCount) {
    filterList.removeFilterAt(0);
  }
  if (gFilter) {
    gFilter.clearActionList();
    if (gAction) {
      gFilter.appendAction(gAction);
      if (gSecondAction) {
        gFilter.appendAction(gSecondAction);
      }
      filterList.insertFilterAt(0, gFilter);
    }
  }
  gExpectedUid = IMAPPump.mailbox.uidnext++;
  let source = specForFileName(gMessage);
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    const raw = [
      "From: body-filter@example.invalid",
      "To: receiver@example.invalid",
      "Date: Mon, 02 Nov 2026 12:00:00 +0000",
      "Subject: body filter " + gExpectedUid,
      "Message-ID: <native-body-filter-" + gExpectedUid + "@example.invalid>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=us-ascii",
      "",
      "Body for UID " + gExpectedUid,
      "",
    ].join("\r\n");
    source = "data:text/plain;base64," + btoa(raw);
  }
  gInjectedSource = source;
  gInjectedMessage = new ImapMessage(source, gExpectedUid, []);
  IMAPPump.mailbox.addMessage(gInjectedMessage);
  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, listener);
  try {
    await listener.promise;
    if (
      Services.prefs.getBoolPref("mail.panorama.enabled", false) &&
      gAction.strValue == "false"
    ) {
      const published = IMAPPump.inbox.msgDatabase.getMsgHdrForKey(gParsedKey);
      Assert.equal(published.messageKey, gParsedKey);
      Assert.equal(published.getUint32Property("uidOnServer"), gExpectedUid);
      Assert.equal(
        published.messageId,
        "native-body-filter-" + gExpectedUid + "@example.invalid"
      );
      Assert.ok(!(published.flags & Ci.nsMsgMessageFlags.Offline));
    }
  } catch (error) {
    info(
      "Failed filter protocol transaction: " +
        JSON.stringify(IMAPPump.server.playTransaction())
    );
    throw error;
  }
}

function run_test() {
  for (const test of tests) {
    if (
      test.name == "NeedsBodyFalse" &&
      Services.prefs.getBoolPref("mail.panorama.enabled", false)
    ) {
      // Finish failure custody while all older messages already own a body.
      add_task(test_bodyFilterFailureRetainsPhysicalSource);
    }
    add_task(test);
  }
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    add_task(test_headerFilterFailureLeavesSourceUnpublished);
  }
  add_task(teardownIMAPPump);
  run_next_test();
}

// custom action to test offline status
var actionTestOffline = {
  id: "mailnews@mozilla.org#testOffline",
  name: "test if offline",
  applyAction(aMsgHdrs, aActionValue) {
    for (const msgHdr of aMsgHdrs) {
      const isOffline = msgHdr.flags & Ci.nsMsgMessageFlags.Offline;
      const needsBody =
        aActionValue == "true" ||
        aActionValue == "failFirst" ||
        aActionValue == "failLater";
      Assert.equal(!!isOffline, needsBody);
      if (
        needsBody &&
        Services.prefs.getBoolPref("mail.panorama.enabled", false)
      ) {
        Assert.equal(msgHdr.getUint32Property("uidOnServer"), gExpectedUid);
        Assert.notEqual(msgHdr.messageKey, gExpectedUid);
        Assert.notEqual(msgHdr.messageKey, 0xffffffff);
        Assert.equal(msgHdr.folder, IMAPPump.inbox);
        Assert.ok(IMAPPump.inbox.msgDatabase.containsKey(msgHdr.messageKey));
        Assert.equal(
          msgHdr.messageId,
          "native-body-filter-" + gExpectedUid + "@example.invalid"
        );
        const body = readFilterBody(msgHdr);
        Assert.ok(body.includes("Body for UID " + gExpectedUid + "\r\n"));
        gBodyHeader = msgHdr;
        gBodyBytes = body;
      }
      if (
        !needsBody &&
        Services.prefs.getBoolPref("mail.panorama.enabled", false)
      ) {
        gParsedKey = msgHdr.messageKey;
        Assert.notEqual(gParsedKey, 0);
        Assert.notEqual(gParsedKey, 0xffffffff);
        Assert.notEqual(gParsedKey, gExpectedUid);
        Assert.equal(msgHdr.getUint32Property("uidOnServer"), gExpectedUid);
        Assert.equal(msgHdr.folder, IMAPPump.inbox);
        Assert.ok(
          !IMAPPump.inbox.msgDatabase.containsKey(gParsedKey),
          "Header-only filtering owns an unpublished physical source"
        );
      }
      if (
        [
          "failFirst",
          "failLater",
          "failHeaderFirst",
          "failHeaderLater",
        ].includes(aActionValue)
      ) {
        gFailedActions.push(aActionValue);
        throw Components.Exception(
          "Deliberate body-filter action failure",
          aActionValue == "failFirst" || aActionValue == "failHeaderFirst"
            ? Cr.NS_ERROR_FAILURE
            : Cr.NS_ERROR_ABORT
        );
      }
    }
  },
  isValidForType() {
    return true;
  },

  validateActionValue() {
    return null;
  },

  allowDuplicates: false,

  needsBody: false, // set during test setup
};

/*
 * helper functions
 */

// given a test file, return the file uri spec
function specForFileName(aFileName) {
  const file = do_get_file(gDEPTH + "mailnews/data/" + aFileName);
  const msgfileuri = Services.io.newFileURI(file).QueryInterface(Ci.nsIFileURL);
  return msgfileuri.spec;
}

/**
 * Reads the bytes owned by the selected header from its physical store.
 *
 * @param {nsIMsgDBHdr} header - The actual provider-finished source header.
 * @returns {string} The retained RFC822 bytes.
 */
function readFilterBody(header) {
  const stream = IMAPPump.inbox.msgStore.getMsgInputStream(
    IMAPPump.inbox,
    header.storeToken,
    0
  );
  try {
    let raw = "";
    while (stream.available()) {
      raw += filterNetUtil.readInputStreamToString(stream, stream.available());
    }
    return raw;
  } finally {
    stream.close();
  }
}

async function test_bodyFilterFailureRetainsPhysicalSource() {
  gAction.type = Ci.nsMsgFilterAction.Custom;
  gAction.customId = actionTestOffline.id;
  gAction.strValue = "failFirst";
  actionTestOffline.needsBody = true;
  gSecondAction = gFilter.createAction();
  gSecondAction.type = Ci.nsMsgFilterAction.Custom;
  gSecondAction.customId = actionTestOffline.id;
  gSecondAction.strValue = "failLater";
  gBodyHeader = null;
  gFailedActions = [];
  try {
    await Assert.rejects(
      runFilterAction(),
      error => error.message == String(Cr.NS_ERROR_FAILURE),
      "The first body-filter failure reaches the original URL listener"
    );
    Assert.deepEqual(gFailedActions, ["failFirst", "failLater"]);
    Assert.ok(gBodyHeader, "Both actions received the actual finished source");
    Assert.equal(gBodyHeader.getUint32Property("uidOnServer"), gExpectedUid);
    Assert.ok(
      IMAPPump.inbox.msgDatabase.containsKey(gBodyHeader.messageKey),
      "The failed action retains the same published physical message"
    );
    Assert.ok(gBodyHeader.flags & Ci.nsMsgMessageFlags.Offline);
    Assert.equal(
      readFilterBody(gBodyHeader),
      gBodyBytes,
      "Failed filtering preserves every byte of the completed provider body"
    );
  } finally {
    gSecondAction = null;
    gBodyHeader = null;
  }
}

async function test_headerFilterFailureLeavesSourceUnpublished() {
  const database = IMAPPump.inbox.msgDatabase;
  const keys = [...database.enumerateMessages()].map(
    header => header.messageKey
  );
  const total = IMAPPump.inbox.getTotalMessages(false);
  const unread = IMAPPump.inbox.getNumUnread(false);
  const newMessages = IMAPPump.inbox.getNumNewMessages(false);
  gAction.strValue = "failHeaderFirst";
  actionTestOffline.needsBody = false;
  gSecondAction = gFilter.createAction();
  gSecondAction.type = Ci.nsMsgFilterAction.Custom;
  gSecondAction.customId = actionTestOffline.id;
  gSecondAction.strValue = "failHeaderLater";
  gFailedActions = [];
  try {
    await Assert.rejects(
      runFilterAction(),
      error => error.message == String(Cr.NS_ERROR_FAILURE),
      "The first header-filter failure reaches the original URL listener"
    );
    Assert.deepEqual(gFailedActions, ["failHeaderFirst", "failHeaderLater"]);
    Assert.ok(!database.containsKey(gParsedKey));
    Assert.deepEqual(
      [...database.enumerateMessages()].map(header => header.messageKey),
      keys,
      "Failed header filtering publishes no physical membership"
    );
    Assert.equal(IMAPPump.inbox.getTotalMessages(false), total);
    Assert.equal(IMAPPump.inbox.getNumUnread(false), unread);
    Assert.equal(IMAPPump.inbox.getNumNewMessages(false), newMessages);
    Assert.ok(IMAPPump.mailbox._messages.includes(gInjectedMessage));
    Assert.equal(gInjectedMessage.uid, gExpectedUid);
    Assert.equal(gInjectedMessage._URI, gInjectedSource);
    Assert.ok(!gInjectedMessage.flags.includes("\\Deleted"));
  } finally {
    gSecondAction = null;
  }
}
