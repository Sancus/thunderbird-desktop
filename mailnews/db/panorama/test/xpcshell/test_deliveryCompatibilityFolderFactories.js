/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from head_delivery.js */

add_task(async function test_restoresImapHierarchyWithoutBodyDirectories() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.ok(["mbox", "maildir"].includes(lane.store));
  do_get_profile();
  loadExistingDB();
  PanoramaDelivery.assertBackend(lane.backend);
  const serverKey = "factoryImap";
  const prefPrefix = "mail.server." + serverKey + ".";
  const localPath = PathUtils.join(do_get_profile().path, "factory-imap");
  await IOUtils.makeDirectory(localPath);
  const storeContract = {
    mbox: "@mozilla.org/msgstore/berkeleystore;1",
    maildir: "@mozilla.org/msgstore/maildirstore;1",
  }[lane.store];
  const prefs = {
    type: "imap",
    userName: "factory",
    hostname: "localhost",
    storeContractID: storeContract,
  };
  let account = null;
  let incomingServer = null;
  registerCleanupFunction(() => {
    try {
      if (incomingServer) {
        incomingServer.QueryInterface(Ci.nsIImapServerSink).abortQueuedUrls();
        incomingServer.closeCachedConnections();
      }
    } finally {
      try {
        if (account) {
          MailServices.accounts.removeAccount(account, false);
        } else if (incomingServer) {
          MailServices.accounts.removeIncomingServer(incomingServer, false);
        }
      } finally {
        Services.prefs.deleteBranch(prefPrefix);
      }
    }
  });
  for (const [name, value] of Object.entries(prefs)) {
    Services.prefs.setStringPref(prefPrefix + name, value);
  }

  const directory = do_get_profile();
  directory.append("factory-imap");
  Services.prefs.setComplexValue(
    prefPrefix + "directory",
    Ci.nsIFile,
    directory
  );

  // Persist a server-known hierarchy through the production folder API.
  const rootId = folderDB.insertRoot(serverKey);
  const inboxId = folderDB.insertFolder(rootId, "INBOX");
  folderDB.updateFlags(
    inboxId,
    Ci.nsMsgFolderFlags.Mail | Ci.nsMsgFolderFlags.Inbox
  );
  const childId = folderDB.insertFolder(rootId, "Server Only");
  const grandchildId = folderDB.insertFolder(childId, "Nested");
  folderDB.updateFlags(childId, Ci.nsMsgFolderFlags.Mail);
  folderDB.updateFlags(grandchildId, Ci.nsMsgFolderFlags.Mail);
  Assert.deepEqual(await IOUtils.getChildren(localPath), []);

  incomingServer = MailServices.accounts.getIncomingServer(serverKey);
  account = MailServices.accounts.createAccount();
  account.incomingServer = incomingServer;
  const root = incomingServer.rootFolder;
  Assert.ok(
    root instanceof Ci.nsIMsgImapMailFolder,
    "Root uses the IMAP class"
  );
  Assert.equal(root.id, rootId);
  Assert.equal(root.server, incomingServer);
  Assert.equal(root.URI, "imap://factory@localhost");
  Assert.equal(
    root.generateMessageURI(7),
    "imap-message://factory@localhost#7"
  );
  PanoramaDelivery._assertStore(root, lane);
  Assert.equal(folderDB.getMsgFolderForFolder(rootId), root);

  const children = root.subFolders;
  Assert.deepEqual(
    children.map(folder => folder.name).sort(),
    ["INBOX", "Server Only"],
    "Stored server children survive without corresponding body directories"
  );
  const child = root.getChildNamed("Server Only");
  Assert.ok(
    child instanceof Ci.nsIMsgImapMailFolder,
    "Child uses the IMAP class"
  );
  Assert.equal(child.id, childId);
  Assert.equal(folderDB.getMsgFolderForFolder(childId), child);
  Assert.equal(child.parent, root);
  Assert.equal(child.server, incomingServer);
  Assert.equal(child.URI, "imap://factory@localhost/Server%20Only");
  Assert.equal(
    child.generateMessageURI(7),
    "imap-message://factory@localhost/Server%20Only#7"
  );
  const grandchild = child.getChildNamed("Nested");
  Assert.ok(grandchild instanceof Ci.nsIMsgImapMailFolder);
  Assert.equal(grandchild.id, grandchildId);
  Assert.equal(grandchild.parent, child);
  Assert.equal(grandchild.URI, "imap://factory@localhost/Server%20Only/Nested");
  Assert.equal(
    grandchild.generateMessageURI(7),
    "imap-message://factory@localhost/Server%20Only/Nested#7"
  );
  Assert.ok(!child.filePath.exists(), "No body path is required for the child");
  Assert.ok(
    !grandchild.filePath.exists(),
    "No body path is required for its child"
  );
  Assert.deepEqual(
    folderDB.getFolderChildren(rootId).sort(),
    [inboxId, childId].sort()
  );
  Assert.deepEqual(folderDB.getFolderChildren(childId), [grandchildId]);
});
