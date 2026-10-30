/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const panorama = Services.prefs.getBoolPref("mail.panorama.enabled", false);

add_setup(async function () {
  const contract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  Services.prefs.setCharPref("mail.server.default.storeContractID", contract);
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
  setupIMAPPump();
  registerCleanupFunction(() => {
    if (IMAPPump.incomingServer) {
      teardownIMAPPump();
    }
  });
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.equal(
    "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
    panorama,
    "the requested database backend is active"
  );
  const store = {
    "@mozilla.org/msgstore/berkeleystore;1": "mbox",
    "@mozilla.org/msgstore/maildirstore;1": "maildir",
  }[contract];
  Assert.ok(store);
  Assert.equal(IMAPPump.incomingServer.msgStore.storeType, store);
  const discovery = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(
    IMAPPump.incomingServer.rootFolder,
    discovery,
    null
  );
  await discovery.promise;
});

add_task(async function test_rejectedRenameRetainsSourceAndReportsFailure() {
  const root = IMAPPump.incomingServer.rootFolder;
  const added = PromiseTestUtils.promiseFolderAdded("rejected source");
  root.createSubfolder("rejected source", null);
  const source = await added;
  const mailbox = IMAPPump.daemon.getMailbox("rejected source");
  mailbox.uidvalidity = 7201;
  const file = Services.io.newFileURI(do_get_file("../../../data/draft1"));
  mailbox.addMessage(new ImapMessage(file.spec, 6201, []));
  mailbox.uidnext = 6202;
  const download = new PromiseTestUtils.PromiseUrlListener();
  source
    .QueryInterface(Ci.nsIMsgImapMailFolder)
    .downloadAllForOffline(download, null);
  await download.promise;
  const [header, extra] = source.msgDatabase.enumerateMessages();
  Assert.ok(header, "the source is a real downloaded server message");
  Assert.equal(extra, undefined);
  Assert.equal(header.messageId, "4849BF7B.2030800@example.com");
  const key = header.messageKey;
  const token = header.getStringProperty("storeToken");
  Assert.ok(token);
  const bytes = readStoredMessage(source, token);
  Assert.ok(bytes.includes("Hello, did you receive my bugmail?"));
  if (panorama) {
    Assert.notEqual(key, 6201);
    Assert.equal(header.getUint32Property("uidOnServer"), 6201);
  }

  const proto = IMAP_RFC3501_handler.prototype;
  const originalRename = proto.RENAME;
  const originalList = proto.LIST;
  const originalLsub = proto.LSUB;
  let target;
  let rejected;
  let targetLists;
  const renamed = [];
  const observer = {
    folderRenamed(oldFolder, newFolder) {
      renamed.push([oldFolder, newFolder]);
    },
  };
  MailServices.mfn.addListener(observer, MailServices.mfn.folderRenamed);
  try {
    Assert.ok(IMAPPump.incomingServer.usingSubscription);
    for (const [phase, response] of [
      ["RENAME", "NO"],
      ["RENAME", "BAD"],
      ["LSUB", "NO"],
      ["LSUB", "BAD"],
    ]) {
      target = "rename rejected " + phase + " " + response;
      rejected = 0;
      targetLists = 0;
      let renames = 0;
      proto.RENAME = function (args) {
        if (args[0] == "rejected source" && args[1] == target) {
          renames++;
          if (phase == "RENAME") {
            rejected++;
            return response + " refused rename";
          }
        }
        return originalRename.call(this, args);
      };
      proto.LSUB = function (args) {
        if (phase == "LSUB" && args[1] == "rejected source/*") {
          rejected++;
          return response + " refused hierarchy listing";
        }
        return originalLsub.call(this, args);
      };
      proto.LIST = function (args) {
        if (args[1] == target) {
          targetLists++;
        }
        return originalList.call(this, args);
      };
      const listener = new PromiseTestUtils.PromiseUrlListener();
      let completions = 0;
      const stop = listener.OnStopRunningUrl.bind(listener);
      listener.OnStopRunningUrl = (url, status) => {
        completions++;
        stop(url, status);
      };
      const result = listener.promise.then(
        () => Cr.NS_OK,
        error => Number(error.message)
      );
      MailServices.imap.renameLeaf(source, target, listener, null);
      Assert.equal(
        await result,
        Cr.NS_MSG_ERROR_IMAP_COMMAND_FAILED,
        phase + " " + response + " reaches the existing URL listener"
      );
      Assert.equal(completions, 1, "the request completes exactly once");
      Assert.equal(rejected, 1, "exactly one server command was rejected");
      Assert.equal(renames, phase == "RENAME" ? 1 : 0);
      Assert.equal(targetLists, 0, "no later LIST replaces the first failure");
      Assert.equal(renamed.length, 0, "failure does not publish a rename");
      Assert.equal(root.getChildNamed("rejected source"), source);
      Assert.equal(root.getChildNamed(target), null);
      Assert.equal(source.parent, root);
      Assert.equal(
        MailServices.folderLookup.getFolderForURL(source.URI),
        source
      );
      Assert.equal(source.getTotalMessages(false), 1);
      const retained = source.msgDatabase.getMsgHdrForKey(key);
      Assert.equal(retained.messageKey, key);
      Assert.equal(retained.getStringProperty("storeToken"), token);
      Assert.equal(source.msgDatabase.dBFolderInfo.imapUidValidity, 7201);
      Assert.equal(readStoredMessage(source, token), bytes);
      Assert.equal(IMAPPump.daemon.getMailbox(target), null);
      Assert.deepEqual(
        mailbox._messages.map(message => message.uid),
        [6201]
      );
    }
  } finally {
    proto.RENAME = originalRename;
    proto.LIST = originalList;
    proto.LSUB = originalLsub;
    MailServices.mfn.removeListener(observer);
  }
});

/**
 * Read the bytes of a previously downloaded message directly from its store.
 *
 * @param {nsIMsgFolder} folder - Folder that owns the body.
 * @param {string} token - Body token returned by the real store.
 * @returns {string} The stored message bytes.
 */
function readStoredMessage(folder, token) {
  const stream = folder.msgStore.getMsgInputStream(folder, token, 0);
  const reader = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
    Ci.nsIScriptableInputStream
  );
  reader.init(stream);
  try {
    let bytes = "";
    while (reader.available()) {
      bytes += reader.read(reader.available());
    }
    return bytes;
  } finally {
    reader.close();
  }
}
