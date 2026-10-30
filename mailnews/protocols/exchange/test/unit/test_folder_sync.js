/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

var { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { localAccountUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/LocalAccountUtils.sys.mjs"
);
var { EwsServer } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/EwsServer.sys.mjs"
);
var { RemoteFolder } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MockServer.sys.mjs"
);

var incomingServer;
var ewsServer;

const ewsIdPropertyName = "ewsId";

add_setup(async function () {
  // Ensure we have an on-disk profile.
  do_get_profile();

  // Create a new mock EWS server, and start it.
  ewsServer = new EwsServer();
  ewsServer.start();
  registerCleanupFunction(() => ewsServer.stop());

  // Create and configure the EWS incoming server.
  incomingServer = localAccountUtils.create_incoming_server(
    "ews",
    ewsServer.port,
    "user",
    "password"
  );
  incomingServer.setStringValue(
    "ews_url",
    `http://127.0.0.1:${ewsServer.port}/EWS/Exchange.asmx`
  );

  const expectedContract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  Assert.equal(
    incomingServer.getStringValue("storeContractID"),
    expectedContract,
    "The actual protocol consumer uses the configured store contract"
  );
  Assert.equal(
    incomingServer.msgStore.storeType,
    {
      "@mozilla.org/msgstore/berkeleystore;1": "mbox",
      "@mozilla.org/msgstore/maildirstore;1": "maildir",
    }[expectedContract],
    "The actual consumer uses the configured body store"
  );
  const databaseService = Cc[
    "@mozilla.org/msgDatabase/msgDBService;1"
  ].getService(Ci.nsIMsgDBService);
  Assert.equal(
    "nsIDatabaseCore" in Ci && databaseService instanceof Ci.nsIDatabaseCore,
    Services.prefs.getBoolPref("mail.panorama.enabled", false),
    "The configured backend is active for this real incoming server"
  );
  Assert.ok(incomingServer.rootFolder instanceof Ci.IExchangeFolder);

  const exchangeServer = incomingServer.QueryInterface(
    Ci.IExchangeIncomingServer
  );
  registerCleanupFunction(async () => {
    incomingServer.shutdown();
    await TestUtils.waitForCondition(
      () => !exchangeServer.protocolClientRunning,
      "waiting for the EWS client to shut down"
    );
  });
});

// Persisted folder IDs are a Panorama-only input. The existing tasks below
// exercise the Mork store-discovery and protocol-sync path too.
if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(
    async function test_restoresPersistedHierarchyWithoutBodyDirectories() {
      const key = "factoryEws";
      const prefix = `mail.server.${key}.`;
      Assert.equal(Services.prefs.getChildList(prefix).length, 0);
      const account = MailServices.accounts.createAccount();
      const cleanup = { server: null };
      registerCleanupFunction(() => {
        try {
          cleanup.server?.shutdown();
          MailServices.accounts.removeAccount(account, false);
        } finally {
          Services.prefs.deleteBranch(prefix);
        }
      });
      const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
        Ci.nsIMsgDBService
      );
      Assert.ok(service instanceof Ci.nsIDatabaseCore);
      const folders = service.QueryInterface(Ci.nsIDatabaseCore).folderDB;
      const contract = Services.prefs.getCharPref(
        "mail.serverDefaultStoreContractID"
      );
      const store = {
        "@mozilla.org/msgstore/berkeleystore;1": "mbox",
        "@mozilla.org/msgstore/maildirstore;1": "maildir",
      }[contract];
      Assert.ok(store, "The configured store is supported");
      for (const [name, value] of Object.entries({
        type: "ews",
        userName: "factory",
        hostname: "ews-folder-init.invalid",
        storeContractID: contract,
      })) {
        Services.prefs.setCharPref(prefix + name, value);
      }
      Services.prefs.setBoolPref(prefix + "valid", false);
      const directory = do_get_profile();
      directory.append("factory-ews");
      await IOUtils.makeDirectory(directory.path);
      Services.prefs.setComplexValue(
        prefix + "directory",
        Ci.nsIFile,
        directory
      );

      const rootId = folders.insertRoot(key);
      const childId = folders.insertFolder(rootId, "Server Only");
      const grandchildId = folders.insertFolder(childId, "Nested");
      const flags =
        (Ci.nsMsgFolderFlags.Mail |
          Ci.nsMsgFolderFlags.Offline |
          Ci.nsMsgFolderFlags.Favorite) >>>
        0;
      folders.updateFlags(childId, flags);
      folders.updateFlags(grandchildId, flags);
      Assert.deepEqual(await IOUtils.getChildren(directory.path), []);

      const server = MailServices.accounts.getIncomingServer(key);
      cleanup.server = server;
      account.incomingServer = server;
      Assert.ok(server instanceof Ci.IExchangeIncomingServer);
      Assert.equal(server.localStoreType, "ews");
      const root = server.rootFolder;
      Assert.ok(root instanceof Ci.IExchangeFolder);
      Assert.equal(root.id, rootId);
      Assert.equal(root.parent, null);
      Assert.equal(root.server.key, key);
      Assert.equal(root.filePath.path, directory.path);
      Assert.equal(server.getStringValue("storeContractID"), contract);
      Assert.equal(root.msgStore.storeType, store);
      Assert.equal(root.URI, "ews://factory@ews-folder-init.invalid");
      Assert.equal(
        root.generateMessageURI(7),
        "ews-message://factory@ews-folder-init.invalid#7"
      );

      const children = root.subFolders;
      Assert.deepEqual(
        children.map(folder => folder.id),
        [childId]
      );
      const child = children[0];
      Assert.ok(child instanceof Ci.IExchangeFolder);
      Assert.equal(child.parent.id, rootId);
      Assert.equal(child.server.key, key);
      Assert.equal(child.name, "Server Only");
      Assert.equal(child.URI, root.URI + "/Server%20Only");
      Assert.equal(
        child.generateMessageURI(7),
        "ews-message://factory@ews-folder-init.invalid/Server%20Only#7"
      );
      Assert.equal(child.flags, flags);
      const descendants = child.subFolders;
      Assert.deepEqual(
        descendants.map(folder => folder.id),
        [grandchildId]
      );
      const grandchild = descendants[0];
      Assert.ok(grandchild instanceof Ci.IExchangeFolder);
      Assert.equal(grandchild.parent.id, childId);
      Assert.equal(grandchild.server.key, key);
      Assert.equal(grandchild.URI, child.URI + "/Nested");
      Assert.equal(
        grandchild.generateMessageURI(7),
        "ews-message://factory@ews-folder-init.invalid/Server%20Only/Nested#7"
      );
      Assert.equal(grandchild.flags, flags);
      Assert.deepEqual(grandchild.subFolders, []);
      Assert.ok(!child.filePath.exists(), "The child requires no body file");
      Assert.ok(
        !grandchild.filePath.exists(),
        "The grandchild requires no body file"
      );
      Assert.deepEqual(
        await IOUtils.getChildren(directory.path),
        [],
        "Enumeration creates no body directories or summaries"
      );
      for (let repeat = 0; repeat < 2; repeat++) {
        Assert.deepEqual(
          root.subFolders.map(folder => folder.id),
          [childId]
        );
        Assert.deepEqual(
          child.subFolders.map(folder => folder.id),
          [grandchildId]
        );
        Assert.deepEqual(folders.getFolderChildren(rootId), [childId]);
        Assert.deepEqual(folders.getFolderChildren(childId), [grandchildId]);
        Assert.equal(folders.getMsgFolderForFolder(childId).URI, child.URI);
        Assert.equal(
          folders.getMsgFolderForFolder(grandchildId).URI,
          grandchild.URI
        );
      }
    }
  );

  add_task(async function test_ignoresUnregisteredBodyStoreFolders() {
    const key = "factoryEwsBodyInventory";
    const prefix = `mail.server.${key}.`;
    Assert.equal(Services.prefs.getChildList(prefix).length, 0);
    const account = MailServices.accounts.createAccount();
    const cleanup = { server: null };
    registerCleanupFunction(() => {
      try {
        cleanup.server?.shutdown();
        MailServices.accounts.removeAccount(account, false);
      } finally {
        Services.prefs.deleteBranch(prefix);
      }
    });
    const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    );
    Assert.ok(service instanceof Ci.nsIDatabaseCore);
    const folders = service.QueryInterface(Ci.nsIDatabaseCore).folderDB;
    const contract = Services.prefs.getCharPref(
      "mail.serverDefaultStoreContractID"
    );
    const store = {
      "@mozilla.org/msgstore/berkeleystore;1": "mbox",
      "@mozilla.org/msgstore/maildirstore;1": "maildir",
    }[contract];
    Assert.ok(store, "The configured store is supported");
    for (const [name, value] of Object.entries({
      type: "ews",
      userName: "inventory",
      hostname: "ews-body-inventory.invalid",
      storeContractID: contract,
    })) {
      Services.prefs.setCharPref(prefix + name, value);
    }
    Services.prefs.setBoolPref(prefix + "valid", false);
    const directory = do_get_profile();
    directory.append("factory-ews-inventory");
    await IOUtils.makeDirectory(directory.path);
    Services.prefs.setComplexValue(prefix + "directory", Ci.nsIFile, directory);
    const rootId = folders.insertRoot(key);
    const childId = folders.insertFolder(rootId, "Recorded Remote Child");

    // A retained local artifact is not a server-discovered folder or DB member.
    const artifact = PathUtils.join(directory.path, "body-only");
    let retainedBody = artifact;
    if (store == "maildir") {
      await IOUtils.makeDirectory(PathUtils.join(artifact, "cur"));
      await IOUtils.makeDirectory(PathUtils.join(artifact, "tmp"));
      retainedBody = PathUtils.join(artifact, "cur", "retained");
    }
    await IOUtils.writeUTF8(retainedBody, "Retained local bytes\n");
    const server = MailServices.accounts.getIncomingServer(key);
    cleanup.server = server;
    account.incomingServer = server;
    const root = server.rootFolder;
    Assert.ok(root instanceof Ci.IExchangeFolder);
    Assert.equal(root.id, rootId);
    Assert.equal(root.server.key, key);
    Assert.equal(server.getStringValue("storeContractID"), contract);
    Assert.equal(root.msgStore.storeType, store);
    for (let repeat = 0; repeat < 2; repeat++) {
      Assert.deepEqual(
        root.subFolders.map(folder => folder.id),
        [childId],
        "Only the recorded remote child is enumerated"
      );
      Assert.deepEqual(
        folders.getFolderChildren(rootId),
        [childId],
        "Store inventory must not add a remote DB folder by leaf name"
      );
      Assert.equal(
        await IOUtils.readUTF8(retainedBody),
        "Retained local bytes\n"
      );
    }
  });

  add_task(async function test_renamesUncachedFolder() {
    const oldName = "uncached_original";
    const newName = "uncached_renamed";
    ewsServer.appendRemoteFolder(
      new RemoteFolder(oldName, "root", oldName, oldName)
    );
    const root = incomingServer.rootFolder;
    await syncFolder(incomingServer, root);
    const original = root.getChildNamed(oldName);
    const id = original.id;
    Assert.equal(original.getTotalMessages(false), 0);
    const oldPath = original.filePath.path;
    // Evict this empty folder's cache before the server reports a rename.
    await IOUtils.remove(oldPath, { recursive: true });
    Assert.ok(!(await IOUtils.exists(oldPath)));
    Assert.ok(!(await IOUtils.exists(oldPath + ".msf")));
    ewsServer.renameFolderById(oldName, newName);
    await syncFolder(incomingServer, root);
    const renamed = root.getChildNamed(newName);
    Assert.ok(renamed instanceof Ci.IExchangeFolder);
    Assert.equal(renamed.id, id, "An uncached folder keeps its physical ID");
    Assert.equal(renamed.getStringProperty(ewsIdPropertyName), oldName);
    Assert.equal(renamed.parent.id, root.id);
    Assert.equal(renamed.server.key, incomingServer.key);
    Assert.equal(renamed.URI, root.URI + "/" + newName);
    Assert.equal(root.getChildNamed(oldName), null);
    Assert.ok(
      !renamed.filePath.exists(),
      "A rename need not create cached bytes"
    );
  });

  add_task(async function test_failedRenameRetainsSource() {
    const oldName = "blocked_rename_original";
    const newName = "blocked_rename_target";
    const selectedName = "a_completed_before_failure";
    const selectedNewName = "a_completed_after_update";
    ewsServer.appendRemoteFolder(
      new RemoteFolder(selectedName, "root", selectedName, selectedName)
    );
    ewsServer.appendRemoteFolder(
      new RemoteFolder(oldName, "root", oldName, oldName)
    );
    const root = incomingServer.rootFolder;
    await syncFolder(incomingServer, root);
    const original = root.getChildNamed(oldName);
    const selected = root.getChildNamed(selectedName);
    const selectedId = selected.id;
    const id = original.id;
    const uri = original.URI;
    original.setFlag(Ci.nsMsgFolderFlags.Favorite);
    const flags = original.flags;
    original.setStringProperty("ewsIdentityMarker", "Caf\u00e9");
    const members = root.subFolders.map(folder => folder.id);
    const store = root.msgStore.storeType;
    const sourcePath = original.filePath.path;
    const sourceBody =
      store == "maildir"
        ? PathUtils.join(sourcePath, "cur", "retained")
        : sourcePath;
    const retained = "Retained cache marker\n";
    await IOUtils.writeUTF8(sourceBody, retained);
    const obstruction = original.filePath.clone();
    obstruction.leafName = newName;
    Assert.ok(!obstruction.exists());
    await IOUtils.writeUTF8(obstruction.path, "Fixture-owned obstruction\n");
    // Publish one real update before the obstructed update retires its selected
    // wrapper. The later hierarchy error must still complete that request.
    ewsServer.renameFolderById(selectedName, selectedNewName);
    ewsServer.renameFolderById(oldName, newName);
    const stops = [];
    const listener = new PromiseTestUtils.PromiseUrlListener({
      OnStopRunningUrl(_url, status) {
        stops.push(status);
      },
    });
    incomingServer.getNewMessages(selected, null, listener);
    await Assert.rejects(
      listener.promise,
      error => error.message == String(Cr.NS_ERROR_FILE_ALREADY_EXISTS),
      "The original destination obstruction error reaches completion"
    );
    await TestUtils.waitForCondition(
      () => root.getChildNamed(selectedNewName),
      "The earlier unblocked hierarchy update is published"
    );
    Assert.equal(root.getChildNamed(selectedNewName).id, selectedId);
    Assert.equal(root.getChildNamed(selectedName), null);
    Assert.throws(
      () => selected.getStringProperty(ewsIdPropertyName),
      /NS_ERROR_NOT_AVAILABLE/,
      "The selected original wrapper is retired by the confirmed update"
    );
    Assert.deepEqual(stops, [Cr.NS_ERROR_FILE_ALREADY_EXISTS]);
    Assert.equal(root.getChildNamed(oldName), original);
    Assert.equal(root.getChildNamed(newName), null);
    Assert.equal(original.id, id);
    Assert.equal(original.URI, uri);
    Assert.equal(original.parent.id, root.id);
    Assert.equal(original.flags, flags);
    Assert.equal(original.getStringProperty(ewsIdPropertyName), oldName);
    Assert.equal(original.getStringProperty("ewsIdentityMarker"), "Caf\u00e9");
    Assert.deepEqual(
      root.subFolders.map(folder => folder.id),
      members
    );
    Assert.equal(await IOUtils.readUTF8(sourceBody), retained);
    Assert.equal(
      await IOUtils.readUTF8(obstruction.path),
      "Fixture-owned obstruction\n"
    );

    // Only remove our checked obstruction, then issue a new explicit request.
    await IOUtils.remove(obstruction.path);
    await syncFolder(incomingServer, root);
    const renamed = root.getChildNamed(newName);
    Assert.equal(renamed.id, id);
    Assert.equal(renamed.parent.id, root.id);
    Assert.equal(renamed.getStringProperty(ewsIdPropertyName), oldName);
    Assert.equal(renamed.getStringProperty("ewsIdentityMarker"), "Caf\u00e9");
    Assert.equal(renamed.flags, flags);
    Assert.equal(root.getChildNamed(oldName), null);
    const destinationBody =
      store == "maildir"
        ? PathUtils.join(renamed.filePath.path, "cur", "retained")
        : renamed.filePath.path;
    Assert.equal(await IOUtils.readUTF8(destinationBody), retained);
    Assert.ok(!(await IOUtils.exists(sourcePath)));
    Assert.deepEqual(
      stops,
      [Cr.NS_ERROR_FILE_ALREADY_EXISTS],
      "The failed request completed once"
    );
  });
}

/**
 * Tests that triggering a folder hierarchy sync via
 * `nsIMsgFolder::GetNewMessages` correctly populates subfolders.
 */
add_task(async function test_get_new_messages() {
  // Populate the mock EWS server with all base folders.

  const rootFolder = incomingServer.rootFolder;
  await syncFolder(incomingServer, rootFolder);

  // Check that all of the subfolders have been created.
  for (const folder of ewsServer.folders) {
    if (folder.distinguishedId == "msgfolderroot") {
      // The root folder should not be a subfolder of itself.
      continue;
    }

    const child = rootFolder.getChildNamed(folder.displayName);
    Assert.ok(!!child, `${folder.displayName} should exist`);
  }

  // TODO: Check that items are also populated.
});

/**
 * Tests that adding a new folder causes it to show up on the next sync via
 * `nsIMSgFolder::GetNewMessages`. The implementation of the mock server also
 * ensures that this test is testing repeat creations of existing folders as the
 * mock server sends a complete sync for every request for new messages.
 */
add_task(async function test_create_folder() {
  const newFolderName = "created_folder";

  const rootFolder = incomingServer.rootFolder;
  await syncFolder(incomingServer, rootFolder);
  const childShouldNotExist = rootFolder.getChildNamed(newFolderName);
  Assert.ok(!childShouldNotExist, `${newFolderName} should not exist.`);

  ewsServer.appendRemoteFolder(
    new RemoteFolder(newFolderName, "root", newFolderName, newFolderName)
  );

  await syncFolder(incomingServer, rootFolder);
  const child = rootFolder.getChildNamed(newFolderName);
  Assert.ok(!!child, `${newFolderName} should exist.`);
});

/**
 * Tests that deleting a folder causes it to be remove on the next
 * sync via `nsIMsgFolder::GetNewMessages`.
 */
add_task(async function test_delete_folder() {
  const folderToDeleteName = "folder_to_delete";

  ewsServer.appendRemoteFolder(
    new RemoteFolder(
      folderToDeleteName,
      "root",
      folderToDeleteName,
      folderToDeleteName
    )
  );

  const rootFolder = incomingServer.rootFolder;
  await syncFolder(incomingServer, rootFolder);
  const child = rootFolder.getChildNamed(folderToDeleteName);
  Assert.ok(!!child, `${folderToDeleteName} should exist.`);

  ewsServer.deleteRemoteFolderById(folderToDeleteName);
  Assert.equal(1, ewsServer.deletedFolders.length);
  await syncFolder(incomingServer, rootFolder);
  const deletedChild = rootFolder.getChildNamed(folderToDeleteName);
  Assert.ok(!deletedChild, `${folderToDeleteName} should not exist.`);
});

add_task(async function test_rename_folder() {
  const initialFolderName = "rename_folder_original";
  const finalFolderName = "rename_folder_new";

  ewsServer.appendRemoteFolder(
    new RemoteFolder(
      initialFolderName,
      "root",
      initialFolderName,
      initialFolderName
    )
  );

  const rootFolder = incomingServer.rootFolder;
  await syncFolder(incomingServer, rootFolder);
  const child = rootFolder.getChildNamed(initialFolderName);
  Assert.ok(!!child, `${initialFolderName} should exist.`);
  const initialEwsId = child.getStringProperty(ewsIdPropertyName);
  const initialPhysicalId = Services.prefs.getBoolPref(
    "mail.panorama.enabled",
    false
  )
    ? child.id
    : null;

  ewsServer.renameFolderById(initialFolderName, finalFolderName);
  await syncFolder(incomingServer, rootFolder);
  const renamedChild = rootFolder.getChildNamed(finalFolderName);
  Assert.ok(!!renamedChild, `${finalFolderName} should exist.`);
  const finalEwsId = renamedChild.getStringProperty(ewsIdPropertyName);
  if (initialPhysicalId !== null) {
    Assert.equal(
      renamedChild.id,
      initialPhysicalId,
      "The physical folder ID is retained"
    );
  }
  Assert.equal(
    finalEwsId,
    initialEwsId,
    "EWS ID should be maintained through rename."
  );
});

add_task(async function test_reparent_folder() {
  const childName = "reparent_child";
  const parent1Name = "reparent_parent_1";
  const parent2Name = "reparent_parent_2";
  const parentNames = [parent1Name, parent2Name];

  parentNames.forEach(name => {
    ewsServer.appendRemoteFolder(new RemoteFolder(name, "root", name, name));
  });

  const rootFolder = incomingServer.rootFolder;
  await syncFolder(incomingServer, rootFolder);
  const parent1 = rootFolder.getChildNamed(parent1Name);
  Assert.ok(!!parent1, `${parent1Name} should exist.`);
  const parent2 = rootFolder.getChildNamed(parent2Name);
  Assert.ok(!!parent2, `${parent2Name} should exist.`);

  // Add the child to the first parent.
  ewsServer.appendRemoteFolder(
    new RemoteFolder(childName, parent1Name, childName, childName)
  );

  await syncFolder(incomingServer, parent1);
  const child = parent1.getChildNamed(childName);
  Assert.ok(!!child, `${childName} should exist in ${parent1Name}`);
  Assert.ok(
    !parent2.getChildNamed(childName),
    `${childName} should not exist in ${parent2Name}`
  );
  const initialEwsId = child.getStringProperty(ewsIdPropertyName);
  const initialPhysicalId = Services.prefs.getBoolPref(
    "mail.panorama.enabled",
    false
  )
    ? child.id
    : null;

  ewsServer.reparentFolderById(childName, parent2Name);

  await syncFolder(incomingServer, parent1);
  await syncFolder(incomingServer, parent2);
  const renamedChild = parent2.getChildNamed(childName);
  Assert.ok(!!renamedChild, `${childName} should exist in ${parent2Name}`);
  Assert.ok(
    !parent1.getChildNamed(childName),
    `${childName} should not exist in ${parent1Name}`
  );
  const finalEwsId = renamedChild.getStringProperty(ewsIdPropertyName);
  if (initialPhysicalId !== null) {
    Assert.equal(
      renamedChild.id,
      initialPhysicalId,
      "The physical folder ID is retained"
    );
  }
  Assert.equal(
    finalEwsId,
    initialEwsId,
    "EWS ID should be maintained through reparent."
  );
});

add_task(async function test_reparent_folder_tree() {
  const parent1Name = "parent_1";
  const parent2Name = "parent_2";
  const child1Name = "child_1";
  const child2Name = "child_2";
  const child3Name = "child_3";

  // Create the parents.
  const parentNames = [parent1Name, parent2Name];
  parentNames.forEach(name => {
    ewsServer.appendRemoteFolder(new RemoteFolder(name, "root", name, name));
  });
  const rootFolder = incomingServer.rootFolder;
  await syncFolder(incomingServer, rootFolder);
  const parentFolders = parentNames.map(name => {
    const parentFolder = rootFolder.getChildNamed(name);
    Assert.ok(!!parentFolder, `${name} should exist in root folder.`);
    return parentFolder;
  });

  // Create the hierarchy under the first parent:
  // parent
  // | -- child1
  //      | -- child2
  //           | -- child3
  // Do this level-by-level to make it easier to know
  // when the async operations have completed.
  const ensureCreateFolder = async (childName, parentFolder) => {
    ewsServer.appendRemoteFolder(
      new RemoteFolder(childName, parentFolder.name, childName, childName)
    );
    await syncFolder(incomingServer, parentFolder);
    const newChild = parentFolder.getChildNamed(childName);
    Assert.ok(!!newChild, `${childName} should exist in ${parentFolder.name}`);
    return newChild;
  };
  const child1Folder = await ensureCreateFolder(child1Name, parentFolders[0]);
  const child2Folder = await ensureCreateFolder(child2Name, child1Folder);
  const child3Folder = await ensureCreateFolder(child3Name, child2Folder);

  const child1FolderEwsId = child1Folder.getStringProperty(ewsIdPropertyName);
  const child2FolderEwsId = child2Folder.getStringProperty(ewsIdPropertyName);
  const child3FolderEwsId = child3Folder.getStringProperty(ewsIdPropertyName);
  const physicalIds = Services.prefs.getBoolPref("mail.panorama.enabled", false)
    ? [child1Folder.id, child2Folder.id, child3Folder.id]
    : null;

  const assertHierarchy = parentName => {
    const parent = rootFolder.getChildNamed(parentName);
    Assert.ok(!!parent, `${parentName} should exist in root folder.`);
    const child1 = parent.getChildNamed(child1Name);
    Assert.ok(!!child1, `${child1Name} should exist in ${parentName}`);
    const child2 = child1.getChildNamed(child2Name);
    Assert.ok(!!child2, `${child2Name} should exist in ${child1Name}`);
    const child3 = child2.getChildNamed(child3Name);
    Assert.ok(!!child3, `${child3Name} should exist in ${child2Name}`);
  };

  assertHierarchy(parent1Name);

  // Reparent the entire hierarchy at once and wait for
  // the full operation to complete.
  ewsServer.reparentFolderById(child1Name, parent2Name);
  await syncFolder(incomingServer, parentFolders[0]);
  await syncFolder(incomingServer, parentFolders[1]);

  assertHierarchy(parent2Name);

  const child1Reparented = parentFolders[1].getChildNamed(child1Name);
  const child2Reparented = child1Reparented.getChildNamed(child2Name);
  const child3Reparented = child2Reparented.getChildNamed(child3Name);
  if (physicalIds) {
    Assert.deepEqual(
      [child1Reparented.id, child2Reparented.id, child3Reparented.id],
      physicalIds,
      "Every descendant retains its physical ID"
    );
  }

  Assert.equal(
    child1Reparented.getStringProperty(ewsIdPropertyName),
    child1FolderEwsId,
    `${child1Name} EWS ID should be the same after reparenting.`
  );
  Assert.equal(
    child2Reparented.getStringProperty(ewsIdPropertyName),
    child2FolderEwsId,
    `${child2Name} EWS ID should be the same after reparenting.`
  );
  Assert.equal(
    child3Reparented.getStringProperty(ewsIdPropertyName),
    child3FolderEwsId,
    `${child3Name} EWS ID should be the same after reparenting.`
  );
});
