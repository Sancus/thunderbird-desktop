/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server_setup.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

var { MsgKeySet } = ChromeUtils.importESModule(
  "resource:///modules/MsgKeySet.sys.mjs"
);

add_task(async function test_preservesNewsFolderIdentity() {
  const lane = PanoramaDelivery.expectedLane();
  const service = PanoramaDelivery.assertBackend(lane.backend);
  const account = MailServices.accounts.createAccount();
  let incomingServer;
  registerCleanupFunction(() => {
    incomingServer?.closeCachedConnections();
    MailServices.accounts.removeAccount(account, false);
  });
  incomingServer = MailServices.accounts.createIncomingServer(
    "",
    "news-folder-init.invalid",
    "nntp"
  );
  incomingServer.valid = false;
  account.incomingServer = incomingServer;
  incomingServer.QueryInterface(Ci.nsINntpIncomingServer);

  let core, rootId, savedId;
  if (lane.backend == "panorama") {
    core = service.QueryInterface(Ci.nsIDatabaseCore);
    rootId = core.folderDB.insertRoot(incomingServer.key);
    savedId = core.folderDB.insertFolder(rootId, "test.saved");
    core.folderDB.updateFlags(
      savedId,
      Ci.nsMsgFolderFlags.Newsgroup | Ci.nsMsgFolderFlags.Offline
    );
  }
  const localPath = incomingServer.localPath;
  await IOUtils.writeUTF8(
    incomingServer.newsrcFilePath.path,
    "test.saved: 5001\n"
  );
  info('DELIVERY_PHASE {"phase":"news-folder-init"}');
  const rootFolder = incomingServer.rootFolder;
  incomingServer.valid = true;
  Assert.ok(
    rootFolder instanceof Ci.nsIMsgNewsFolder,
    "Root uses the native news folder"
  );
  Assert.equal(rootFolder.URI, incomingServer.serverURI, "Root keeps its URI");
  Assert.equal(rootFolder.parent, null, "Root has no parent");
  Assert.equal(
    rootFolder.filePath.path,
    localPath.path,
    "Root keeps its body path"
  );
  PanoramaDelivery._assertStore(rootFolder, lane);

  const saved = rootFolder.getChildNamed("test.saved");
  Assert.ok(
    saved instanceof Ci.nsIMsgNewsFolder,
    "Saved group is a news folder"
  );
  Assert.ok(
    new MsgKeySet(
      saved.QueryInterface(Ci.nsIMsgNewsFolder).newsrcLine.split(":")[1].trim()
    ).has(5001),
    "The saved article read set is restored"
  );
  Assert.equal(
    saved.parent.URI,
    rootFolder.URI,
    "Saved group keeps its parent"
  );
  Assert.equal(
    saved.server.key,
    incomingServer.key,
    "Saved group keeps its server"
  );
  Assert.equal(saved.name, "test.saved", "Saved group keeps its name");
  Assert.equal(
    saved.URI,
    rootFolder.URI + "/test.saved",
    "Saved group keeps its URI"
  );
  const expectedPath = rootFolder.filePath.clone();
  expectedPath.append("test.saved");
  Assert.equal(
    saved.filePath.path,
    expectedPath.path,
    "Saved group keeps its body path"
  );
  saved.setFlag(Ci.nsMsgFolderFlags.Offline);
  saved.setStringProperty("newsFactoryMetadata", "retained value");
  const flags = saved.flags;
  const newsRoot = rootFolder.QueryInterface(Ci.nsIMsgNewsFolder);
  if (core) {
    Assert.equal(rootFolder.id, rootId, "Root reuses its stored ID");
    Assert.equal(saved.id, savedId, "Saved group reuses its stored ID");
    const repeated = newsRoot.addNewsgroup("test.saved", "5001");
    Assert.equal(repeated.id, savedId, "Repeated creation keeps the group ID");
    Assert.equal(repeated.flags, flags, "Repeated creation preserves flags");
    Assert.equal(
      repeated.getStringProperty("newsFactoryMetadata"),
      "retained value",
      "Repeated creation preserves metadata"
    );
    Assert.equal(
      repeated.filePath.path,
      expectedPath.path,
      "Body path is stable"
    );
  }

  const created = newsRoot.addNewsgroup("test.created", "6001");
  Assert.ok(
    created instanceof Ci.nsIMsgNewsFolder,
    "New group is a news folder"
  );
  Assert.equal(
    created.parent.URI,
    rootFolder.URI,
    "New group has the news root parent"
  );
  Assert.equal(created.name, "test.created", "New group keeps its name");
  Assert.equal(
    created.URI,
    rootFolder.URI + "/test.created",
    "New group has its own URI"
  );
  const createdPath = rootFolder.filePath.clone();
  createdPath.append("test.created");
  Assert.equal(
    created.filePath.path,
    createdPath.path,
    "New group uses its own body path"
  );
  Assert.ok(
    new MsgKeySet(
      created
        .QueryInterface(Ci.nsIMsgNewsFolder)
        .newsrcLine.split(":")[1]
        .trim()
    ).has(6001),
    "New group retains its article read set"
  );
  Assert.ok(
    created.getFlag(Ci.nsMsgFolderFlags.Newsgroup),
    "New group has the news flag"
  );
  Assert.equal(
    saved.getStringProperty("newsFactoryMetadata"),
    "retained value",
    "Adding another group leaves saved metadata unchanged"
  );
  if (core) {
    Assert.equal(incomingServer.rootFolder.id, rootId, "Root ID is stable");
    Assert.notEqual(created.id, savedId, "Groups have independent IDs");
    Assert.equal(
      core.folderDB.getFolderChildNamed(rootId, "test.created"),
      created.id,
      "The new group is registered under the root"
    );
    Assert.equal(
      core.folderDB.getFolderParent(created.id),
      rootId,
      "The new group records its parent ID"
    );
  }
  Assert.deepEqual(
    Array.from(rootFolder.subFolders, folder => folder.name).sort(),
    ["test.created", "test.saved"],
    "The root contains each group once"
  );
  Assert.equal(
    incomingServer.rootFolder.URI,
    rootFolder.URI,
    "Root URI is stable"
  );
  info('DELIVERY_PHASE {"phase":"news-folder-init-verified"}');
});
