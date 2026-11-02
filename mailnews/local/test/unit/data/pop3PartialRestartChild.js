/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* globals pop3RestartInput, print, quit */

/**
 * Read the complete selected provider message without changing its bytes.
 *
 * @param {nsIMsgFolder} folder - Physical destination.
 * @param {string} token - Actual finished provider token.
 * @returns {string} Stored message bytes.
 */
function readBody(folder, token) {
  const input = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
    Ci.nsIScriptableInputStream
  );
  input.init(folder.msgStore.getMsgInputStream(folder, token, 0));
  try {
    let raw = "";
    while (input.available()) {
      raw += input.read(input.available());
    }
    return raw;
  } finally {
    input.close();
  }
}

/**
 * Deliver literal bytes through the existing native Partial sink route.
 *
 * @param {nsIPop3IncomingServer} incoming - Original source account.
 * @param {nsIMsgLocalMailFolder} folder - Physical Inbox.
 * @param {string} raw - Literal complete or Partial message.
 * @param {number} flags - Incoming Partial flag, or zero.
 * @param {string} [uri=""] - Original physical Partial URI.
 * @returns {nsIPop3Sink} The settled native sink.
 */
function deliver(incoming, folder, raw, flags, uri = "") {
  const sink = Cc["@mozilla.org/messenger/pop3-sink;1"].createInstance(
    Ci.nsIPop3Sink
  );
  sink.popServer = incoming;
  sink.folder = folder;
  sink.origMessageUri = uri;
  sink.buildMessageUri = !!uri;
  sink.baseMessageUri = folder.baseMessageURI;
  sink.beginMailDelivery(true, null);
  let finished = false;
  try {
    sink.incorporateBegin("restart-partial-uidl", flags);
    for (const line of raw.match(/[^\n]*\n/g)) {
      sink.incorporateWrite(line, line.length);
    }
    sink.incorporateComplete(null, pop3RestartInput.complete.length);
    sink.endMailDelivery(null);
    finished = true;
    return sink;
  } finally {
    if (!finished) {
      try {
        sink.abortMailDelivery(null);
      } catch {
        // Preserve the original native completion failure.
      }
    }
  }
}

/** @returns {Promise<void>} The finished row is saved or checked after restart. */
async function checkRestart() {
  const resources = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler);
  resources.setSubstitution(
    "testing-common",
    Services.io.newURI(pop3RestartInput.testingCommon)
  );
  const { Assert } = ChromeUtils.importESModule(
    "resource://testing-common/Assert.sys.mjs"
  );
  const { updateAppInfo } = ChromeUtils.importESModule(
    "resource://testing-common/AppInfo.sys.mjs"
  );
  updateAppInfo();

  const profile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  profile.initWithPath(pop3RestartInput.profilePath);
  // Use the profile keys registered by the ordinary xpcshell harness.
  const profileProvider = {
    getFile(prop, persistent) {
      if (["ProfD", "ProfLD", "ProfDS", "ProfLDS", "TmpD"].includes(prop)) {
        persistent.value = true;
        return profile.clone();
      }
      return null;
    },
    QueryInterface: ChromeUtils.generateQI(["nsIDirectoryServiceProvider"]),
  };
  Services.dirsvc
    .QueryInterface(Ci.nsIDirectoryService)
    .registerProvider(profileProvider);
  for (const key of ["ProfD", "ProfLD", "ProfDS", "ProfLDS", "TmpD"]) {
    try {
      Services.dirsvc.undefine(key);
    } catch (error) {
      if (error.result != Cr.NS_ERROR_FAILURE) {
        throw error;
      }
    }
  }
  const prefsFile = profile.clone();
  prefsFile.append("prefs.js");
  if (pop3RestartInput.stage == "read") {
    Services.prefs.readUserPrefsFromFile(prefsFile);
  }
  Services.prefs.setBoolPref("security.nocertdb", true);
  Services.prefs.setBoolPref("mail.panorama.enabled", true);
  Services.obs.notifyObservers(
    null,
    "profile-do-change",
    "xpcshell-do-get-profile"
  );

  const { MailServices } = ChromeUtils.importESModule(
    "resource:///modules/MailServices.sys.mjs"
  );
  const { localAccountUtils } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/LocalAccountUtils.sys.mjs"
  );
  const expectedPath = PathUtils.join(profile.path, "partial-expected.json");
  if (pop3RestartInput.stage == "write") {
    const contract =
      pop3RestartInput.store == "mbox"
        ? "@mozilla.org/msgstore/berkeleystore;1"
        : "@mozilla.org/msgstore/maildirstore;1";
    Services.prefs.setCharPref("mail.serverDefaultStoreContractID", contract);
    Services.prefs.setCharPref("mail.server.default.storeContractID", contract);
    localAccountUtils.loadLocalMailAccount();
    const { server: incoming } =
      localAccountUtils.create_incoming_server_and_account(
        "pop3",
        1,
        "restart-partial-user",
        "password"
      );
    const folder = localAccountUtils.inboxFolder;
    Assert.equal(folder.msgStore.storeType, pop3RestartInput.store);
    deliver(
      incoming,
      folder,
      pop3RestartInput.partial,
      Ci.nsMsgMessageFlags.Partial
    );
    const [original] = [...folder.messages];
    Assert.ok(original.flags & Ci.nsMsgMessageFlags.Partial);
    const key = original.messageKey;
    const oldToken = original.storeToken;
    const uri = folder.getUriForMsg(original);
    original.flags |= Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked;
    original.priority = Ci.nsMsgPriority.high;
    original.setStringProperty("keywords", "restart-tag");
    original.setStringProperty("opaque empty", "");
    original.setStringProperty("opaque text", "0007");
    original.setStringProperty("opaque unicode", "café 日本語 📧");
    const sink = deliver(incoming, folder, pop3RestartInput.complete, 0, uri);
    Assert.ok(sink.confirmedPartialCompletion);
    Assert.equal(sink.messageUri, uri);
    Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
    const completed = folder.msgDatabase.getMsgHdrForKey(key);
    Assert.notEqual(completed.storeToken, oldToken);
    const raw = readBody(folder, completed.storeToken);
    Assert.ok(raw.endsWith(pop3RestartInput.complete));
    const database = Cc["@mozilla.org/mailnews/database-core;1"].getService(
      Ci.nsIDatabaseCore
    );
    await IOUtils.writeJSON(expectedPath, {
      sourceId: database.sourceId,
      incomingKey: incoming.key,
      accountKey: localAccountUtils.msgAccount.key,
      folderId: folder.id,
      folderURI: folder.URI,
      key,
      uri,
      token: completed.storeToken,
      flags: completed.flags,
      messageSize: completed.messageSize,
      lineCount: completed.lineCount,
      raw,
    });
    Services.prefs.savePrefFile(prefsFile);
  } else {
    const expected = await IOUtils.readJSON(expectedPath);
    const incoming = MailServices.accounts
      .getIncomingServer(expected.incomingKey)
      .QueryInterface(Ci.nsIPop3IncomingServer);
    Assert.equal(incoming.deferredToAccount, expected.accountKey);
    const folder = incoming.rootMsgFolder.getFolderWithFlags(
      Ci.nsMsgFolderFlags.Inbox
    );
    Assert.equal(folder.id, expected.folderId);
    Assert.equal(folder.URI, expected.folderURI);
    Assert.equal(folder.msgStore.storeType, pop3RestartInput.store);
    const database = Cc["@mozilla.org/mailnews/database-core;1"].getService(
      Ci.nsIDatabaseCore
    );
    Assert.equal(database.sourceId, expected.sourceId);
    Assert.deepEqual(folder.msgDatabase.listAllKeys(), [expected.key]);
    const header = folder.msgDatabase.getMsgHdrForKey(expected.key);
    Assert.equal(folder.getUriForMsg(header), expected.uri);
    Assert.equal(header.storeToken, expected.token);
    Assert.equal(header.flags, expected.flags);
    Assert.ok(!(header.flags & Ci.nsMsgMessageFlags.Partial));
    Assert.equal(header.priority, Ci.nsMsgPriority.high);
    Assert.equal(header.subject, "Completed partial");
    Assert.equal(header.messageSize, expected.messageSize);
    Assert.equal(header.lineCount, expected.lineCount);
    Assert.equal(header.lineCount, 2);
    Assert.equal(header.getStringProperty("keywords"), "restart-tag");
    Assert.ok(header.properties.includes("opaque empty"));
    Assert.equal(header.getStringProperty("opaque empty"), "");
    Assert.equal(header.getStringProperty("opaque text"), "0007");
    Assert.equal(header.getStringProperty("opaque unicode"), "café 日本語 📧");
    Assert.deepEqual(
      Array.from({ length: header.numReferences }, (_, i) =>
        header.getStringReference(i)
      ),
      ["root@example.invalid", "parent@example.invalid", "root@example.invalid"]
    );
    const raw = readBody(folder, header.storeToken);
    Assert.equal(raw, expected.raw);
    Assert.ok(raw.endsWith(pop3RestartInput.complete));
    Assert.equal(raw.length, header.messageSize);
    Assert.ok(!folder.locked);
  }
  // Close actual native state before this process exits; the next call starts anew.
  Services.obs.notifyObservers(null, "profile-before-change", null);
}

let settled = false;
let result = 0;
checkRestart().then(
  () => {
    print(`POP3-PARTIAL-RESTART ${pop3RestartInput.stage} PASS`);
    settled = true;
  },
  error => {
    print(`POP3-PARTIAL-RESTART FAIL ${error}\n${error.stack || ""}`);
    result = 1;
    settled = true;
  }
);
Services.tm.spinEventLoopUntil("TestPop3PartialRestart", () => settled);
quit(result);
