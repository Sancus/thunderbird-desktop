/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests bug 450059: creating a virtual folder (saved search) under an IMAP
 * account, deleting it, and then creating an ordinary folder with the same
 * name must not leave the new folder with the Virtual flag.
 *
 * The stale virtual folder object is removed from the folder tree on deletion
 * (parent set to null), but a strong reference may keep the object alive so
 * that the folder lookup service's weak reference still resolves. Recreating a
 * folder at the same URI must not reuse it, otherwise the new folder
 * incorrectly inherits the Virtual flag.
 */

var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

add_setup(async function () {
  setupIMAPPump();
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
});

add_task(async function test_public_factory_preserves_imap_identity() {
  const { VirtualFolderHelper } = ChromeUtils.importESModule(
    "resource:///modules/VirtualFolderWrapper.sys.mjs"
  );
  const root = IMAPPump.incomingServer.rootFolder;
  const added = PromiseTestUtils.promiseFolderAdded("FactoryParent");
  root.createSubfolder("FactoryParent", null);
  const parent = await added;
  const panorama = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  const expectedStore = Services.prefs
    .getCharPref(
      "mail.serverDefaultStoreContractID",
      "@mozilla.org/msgstore/berkeleystore;1"
    )
    .includes("maildir")
    ? "maildir"
    : "mbox";
  Assert.equal(parent.msgStore.storeType, expectedStore);
  const name = "Saved ☃";
  const uri = parent.URI + "/" + encodeURIComponent(name);
  const children = parent.subFolders;
  const originalOffline = IMAPPump.incomingServer.offlineDownload;
  let wrapped;
  IMAPPump.incomingServer.offlineDownload = true;
  try {
    wrapped = VirtualFolderHelper.createNewVirtualFolder(
      name,
      parent,
      [parent],
      "ALL",
      false
    );
  } finally {
    IMAPPump.incomingServer.offlineDownload = originalOffline;
  }
  const folder = wrapped.virtualFolder;
  Assert.ok(folder instanceof Ci.nsIMsgImapMailFolder);
  Assert.equal(folder.parent, parent);
  Assert.equal(folder.server, IMAPPump.incomingServer);
  Assert.equal(folder.name, name);
  Assert.equal(folder.URI, uri);
  Assert.equal(
    folder.generateMessageURI(7),
    uri.replace("imap:", "imap-message:") + "#7"
  );
  Assert.strictEqual(MailServices.folderLookup.getFolderForURL(uri), folder);
  Assert.deepEqual(parent.subFolders, [...children, folder]);
  const expectedPath = parent.filePath.clone();
  expectedPath.leafName += ".sbd";
  expectedPath.append(name);
  Assert.ok(folder.filePath.equals(expectedPath));
  Assert.equal(folder.msgStore.storeType, expectedStore);
  Assert.ok(folder.getFlag(Ci.nsMsgFolderFlags.Virtual));
  Assert.ok(folder.getFlag(Ci.nsMsgFolderFlags.Mail));
  Assert.ok(folder.getFlag(Ci.nsMsgFolderFlags.Offline));
  Assert.equal(wrapped.searchString, "ALL");
  Assert.equal(wrapped.onlineSearch, false);
  Assert.deepEqual(wrapped.searchFolders, [parent]);
  let core;
  let id;
  if (panorama) {
    core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    );
    id = folder.id;
    Assert.greater(id, 0);
    Assert.equal(core.folderDB.getFolderChildNamed(parent.id, name), id);
    Assert.strictEqual(core.folderDB.getMsgFolderForFolder(id), folder);
  }
  for (const duplicateName of [name, name.toLowerCase()]) {
    Assert.throws(
      () =>
        VirtualFolderHelper.createNewVirtualFolder(
          duplicateName,
          parent,
          [],
          "NONE",
          true
        ),
      error => error.result == Cr.NS_MSG_FOLDER_EXISTS
    );
    Assert.strictEqual(parent.getChildNamed(name), folder);
    Assert.strictEqual(MailServices.folderLookup.getFolderForURL(uri), folder);
    Assert.deepEqual(parent.subFolders, [...children, folder]);
    Assert.equal(folder.parent, parent);
    Assert.equal(folder.server, IMAPPump.incomingServer);
    Assert.equal(wrapped.searchString, "ALL");
    Assert.equal(wrapped.onlineSearch, false);
    Assert.deepEqual(wrapped.searchFolders, [parent]);
    if (panorama) {
      Assert.equal(folder.id, id);
      Assert.equal(core.folderDB.getFolderChildNamed(parent.id, name), id);
      Assert.deepEqual(core.folderDB.getFolderChildren(parent.id), [id]);
    }
  }
  if (panorama) {
    const originalPath = parent.filePath;
    const overriddenPath = originalPath.clone();
    overriddenPath.leafName += "-override";
    const refusedName = "RefusedFactory";
    const refusedURI = parent.URI + "/" + refusedName;
    let retainedId;
    parent.filePath = overriddenPath;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        Assert.throws(
          () =>
            VirtualFolderHelper.createNewVirtualFolder(
              refusedName,
              parent,
              [parent],
              "ALL",
              false
            ),
          error => error.result == Cr.NS_ERROR_NOT_IMPLEMENTED
        );
        const pending = core.folderDB.getFolderChildNamed(
          parent.id,
          refusedName
        );
        Assert.greater(
          pending,
          0,
          "The failed attempt retains its physical row"
        );
        if (retainedId !== undefined) {
          Assert.equal(pending, retainedId);
        }
        retainedId = pending;
        Assert.equal(parent.getChildNamed(refusedName), null);
        Assert.equal(
          MailServices.folderLookup.getFolderForURL(refusedURI),
          null
        );
        Assert.deepEqual(parent.subFolders, [...children, folder]);
        Assert.strictEqual(parent.getChildNamed(name), folder);
        Assert.strictEqual(core.folderDB.getMsgFolderForFolder(id), folder);
        Assert.equal(folder.parent, parent);
        Assert.equal(wrapped.searchString, "ALL");
        Assert.deepEqual(wrapped.searchFolders, [parent]);
        Assert.ok(folder.filePath.equals(expectedPath));
      }
    } finally {
      parent.filePath = originalPath;
    }
    const repaired = VirtualFolderHelper.createNewVirtualFolder(
      refusedName,
      parent,
      [parent],
      "ALL",
      false
    ).virtualFolder;
    Assert.equal(
      repaired.id,
      retainedId,
      "Repair reuses the original physical row"
    );
    Assert.strictEqual(
      core.folderDB.getMsgFolderForFolder(retainedId),
      repaired
    );
    Assert.equal(repaired.parent, parent);
    Assert.equal(repaired.server, IMAPPump.incomingServer);
    Assert.equal(repaired.URI, refusedURI);
    Assert.deepEqual(
      core.folderDB.getFolderChildren(parent.id).sort(),
      [id, retainedId].sort()
    );
  }
});

add_task(async function test_virtual_folder_not_reused_after_delete() {
  const rootFolder = IMAPPump.incomingServer.rootFolder;

  // Create a parent folder (like a "Label" folder), then the virtual folder
  // (saved search) under it, the same way VirtualFolderWrapper does: the VF is
  // created locally via addSubfolder (it has no server mailbox) and then
  // flagged Virtual. Keep the strong reference so that the folder lookup
  // service's weak reference still resolves after deletion.
  rootFolder.createSubfolder("Label-A", null);
  await PromiseTestUtils.promiseFolderAdded("Label-A");
  const parent = rootFolder.getChildNamed("Label-A");

  const vf = parent.addSubfolder("AB");
  vf.setFlag(Ci.nsMsgFolderFlags.Virtual);

  // Delete the virtual folder. Virtual folders are deleted locally (no server
  // round trip), which removes them from the folder tree.
  vf.deleteSelf(null);
  Assert.equal(vf.parent, null, "deleted virtual folder should have no parent");
  Assert.equal(
    parent.getChildNamed("AB"),
    null,
    "virtual folder should be gone"
  );

  // Recreate an ordinary folder with the same name. For IMAP this goes through
  // the server (CREATE followed by folder discovery), which ends up in
  // AddSubfolderWithPath -> GetOrCreateFolderForURL.
  parent.createSubfolder("AB", null);
  const recreated = await PromiseTestUtils.promiseFolderAdded("AB");

  Assert.ok(
    !recreated.getFlag(Ci.nsMsgFolderFlags.Virtual),
    "recreated folder should not inherit the Virtual flag"
  );
});
