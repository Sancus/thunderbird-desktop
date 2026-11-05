/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Bug 589008: moving several IMAP folders into one target on the same server at
 * once should move all of them. This queues the moves the way a multi-folder
 * drag does, then checks they all landed in the target.
 */

var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

const FOLDERS = ["a", "b", "c"];

add_setup(async function () {
  setupIMAPPump();
  const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  const databaseService = Cc[
    "@mozilla.org/msgDatabase/msgDBService;1"
  ].getService(Ci.nsIMsgDBService);
  Assert.equal(
    "nsIDatabaseCore" in Ci && databaseService instanceof Ci.nsIDatabaseCore,
    native,
    "The ordinary manifest selects the actual database backend"
  );
  const storeContract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  const storeType = {
    "@mozilla.org/msgstore/berkeleystore;1": "mbox",
    "@mozilla.org/msgstore/maildirstore;1": "maildir",
  }[storeContract];
  Assert.ok(storeType);
  Assert.equal(IMAPPump.incomingServer.msgStore.storeType, storeType);
  IMAPPump.inbox.hierarchyDelimiter = "/";
  IMAPPump.inbox.verifiedAsOnlineFolder = true;

  for (const name of [...FOLDERS, "dest"]) {
    IMAPPump.daemon.createMailbox(`INBOX/${name}`, { subscribed: true });
  }
  IMAPPump.server.performTest("LIST");

  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, listener);
  await listener.promise;
});

add_task(async function testMultiFolderMove() {
  const inbox = IMAPPump.inbox;
  const dest = inbox.getChildNamed("dest");

  // Queue all the moves at once, without awaiting in between.
  const moves = FOLDERS.map(name => {
    const listener = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyFolder(
      inbox.getChildNamed(name),
      dest,
      true,
      listener,
      null
    );
    return listener.promise;
  });
  await Promise.all(moves);

  for (const name of FOLDERS) {
    Assert.notStrictEqual(
      dest.getChildNamed(name),
      null,
      `${name} should be found in dest folder after move`
    );
    Assert.strictEqual(
      inbox.getChildNamed(name),
      null,
      `${name} should not be left in the Inbox after move`
    );
  }
});

add_task(async function testMoveFolderToAccountRoot() {
  const root = IMAPPump.incomingServer.rootFolder;
  const sourceParent = IMAPPump.inbox.getChildNamed("dest");
  const source = sourceParent.getChildNamed("a");
  Assert.ok(root.isServer, "The destination is the actual account root");
  Assert.ok(source);
  const listener = new PromiseTestUtils.PromiseCopyListener();
  MailServices.copy.copyFolder(source, root, true, listener, null);
  await listener.promise;
  Assert.ok(root.getChildNamed("a"), "The moved folder exists at the root");
  Assert.strictEqual(
    sourceParent.getChildNamed("a"),
    null,
    "The source folder is removed only after the successful root move"
  );
  Assert.ok(sourceParent.getChildNamed("b"), "The sibling folder is preserved");
  Assert.ok(sourceParent.getChildNamed("c"), "The other sibling is preserved");
});

add_task(function teardown() {
  teardownIMAPPump();
});
