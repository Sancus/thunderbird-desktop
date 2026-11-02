/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * This file tests hdr parsing in the filter running context, specifically
 * filters on custom headers.
 * See https://bugzilla.mozilla.org/show_bug.cgi?id=655578
 * for more info.
 *
 * Original author: David Bienvenu <bienvenu@mozilla.com>
 */

var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

// IMAP pump

var { IMAPPump, setupIMAPPump, teardownIMAPPump } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/IMAPpump.sys.mjs"
);

let customHeaderUid;

add_setup(async function setupNativeCustomHeaders() {
  const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  if (native) {
    const storePref = "mail.server.default.storeContractID";
    const autosyncPref = "mail.server.default.autosync_offline_stores";
    const hadStore = Services.prefs.prefHasUserValue(storePref);
    const oldStore = Services.prefs.getCharPref(storePref, "");
    const hadAutosync = Services.prefs.prefHasUserValue(autosyncPref);
    const oldAutosync = Services.prefs.getBoolPref(autosyncPref, true);
    registerCleanupFunction(() => {
      if (IMAPPump.incomingServer) {
        teardownIMAPPump();
      }
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
  setupIMAPPump();
  if (native) {
    IMAPPump.mailbox.uidvalidity = 7301;
    IMAPPump.mailbox.uidnext = 7401;
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

  // Create a test filter.
  const filterList = IMAPPump.incomingServer.getFilterList(null);
  const filter = filterList.createFilter("test list-id");
  const searchTerm = filter.createTerm();
  searchTerm.attrib = Ci.nsMsgSearchAttrib.OtherHeader + 1;
  searchTerm.op = Ci.nsMsgSearchOp.Contains;
  const value = searchTerm.value;
  value.attrib = Ci.nsMsgSearchAttrib.OtherHeader;
  value.str = "gnupg-users.gnupg.org";
  searchTerm.value = value;
  searchTerm.booleanAnd = false;
  searchTerm.arbitraryHeader = "List-Id";
  filter.appendTerm(searchTerm);
  filter.enabled = true;

  // create a mark read action
  const action = filter.createAction();
  action.type = Ci.nsMsgFilterAction.MarkRead;
  filter.appendAction(action);
  filterList.insertFilterAt(0, filter);
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
  const file = do_get_file("../../../data/bugmail19");
  const msgfileuri = Services.io.newFileURI(file).QueryInterface(Ci.nsIFileURL);

  customHeaderUid = IMAPPump.mailbox.uidnext++;
  IMAPPump.mailbox.addMessage(
    new ImapMessage(msgfileuri.spec, customHeaderUid, [])
  );
  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, listener);
  await listener.promise;
});

add_task(function checkFilterResults() {
  const msgHdr = mailTestUtils.firstMsgHdr(IMAPPump.inbox);
  Assert.ok(msgHdr.isRead);
  IMAPPump.server.performTest("UID STORE");
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    Assert.equal(msgHdr.getUint32Property("uidOnServer"), customHeaderUid);
    Assert.notEqual(msgHdr.messageKey, customHeaderUid);
    Assert.ok(IMAPPump.inbox.msgDatabase.containsKey(msgHdr.messageKey));
    const transaction = IMAPPump.server.playTransaction();
    const commands = (Array.isArray(transaction) ? transaction : [transaction])
      .flatMap(item => item.them)
      .map(command => command.toUpperCase());
    Assert.ok(
      commands.some(command =>
        command.includes("UID STORE " + customHeaderUid + " ")
      ),
      "The parsed custom-header hit stores the actual source UID"
    );
  }
  teardownIMAPPump();
});
