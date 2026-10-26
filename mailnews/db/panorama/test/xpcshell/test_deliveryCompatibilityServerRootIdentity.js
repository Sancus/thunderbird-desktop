/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from head_delivery.js */

const { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);

add_task(
  async function test_successfulRootKeepsIdentityDuringAndAfterInitialization() {
    const lane = PanoramaDelivery.expectedLane();
    Assert.equal(lane.backend, "panorama");
    Assert.ok(["mbox", "maildir"].includes(lane.store));
    do_get_profile();
    loadExistingDB();
    PanoramaDelivery.assertBackend(lane.backend);
    const key = "jsRootIdentity";
    const prefix = "mail.server." + key + ".";
    let server;
    registerCleanupFunction(() => {
      try {
        if (server) {
          MailServices.accounts.removeIncomingServer(server, false);
        }
      } finally {
        Services.prefs.deleteBranch(prefix);
      }
    });
    const storeContract = {
      mbox: "@mozilla.org/msgstore/berkeleystore;1",
      maildir: "@mozilla.org/msgstore/maildirstore;1",
    }[lane.store];
    for (const [name, value] of Object.entries({
      type: "pop3",
      userName: "identity",
      hostname: "root-identity.invalid",
      storeContractID: storeContract,
    })) {
      Services.prefs.setStringPref(prefix + name, value);
    }
    const directory = do_get_profile();
    directory.append("js-root-identity");
    await IOUtils.makeDirectory(directory.path);
    Services.prefs.setComplexValue(prefix + "directory", Ci.nsIFile, directory);
    const rootId = folderDB.insertRoot(key);
    const expected = [];
    for (const name of ["Inbox", "Known", "Trash"]) {
      const id = folderDB.insertFolder(rootId, name);
      expected.push([name, id]);
      let body = PathUtils.join(directory.path, name);
      if (lane.store == "maildir") {
        await IOUtils.makeDirectory(PathUtils.join(body, "tmp"));
        body = PathUtils.join(body, "cur", "retained");
      }
      await IOUtils.makeDirectory(PathUtils.parent(body));
      await IOUtils.writeUTF8(body, "From sender@invalid\nidentity body\n");
    }
    const rootContract = "@mozilla.org/mail/folder;1?name=mailbox";
    const childContract = "@mozilla.org/mail/folder-factory;1?name=mailbox";
    const nativeRoot = Cc[rootContract].createInstance(Ci.nsIMsgFolder);
    const nativeChildren = Array.from({ length: 3 }, () =>
      Cc[childContract].createInstance(Ci.nsIMsgFolder)
    );
    let rootCalls = 0;
    const rootCID = MockRegistrar.register(rootContract, () => {
      server = MailServices.accounts.getIncomingServer(key);
      Assert.equal(++rootCalls, 1, "Reentry must not construct a second root");
      return nativeRoot;
    });
    registerCleanupFunction(() => MockRegistrar.unregister(rootCID));
    let childCalls = 0;
    const childCID = MockRegistrar.register(childContract, () => {
      Assert.strictEqual(server.rootFolder, nativeRoot);
      Assert.equal(nativeRoot.id, rootId);
      Assert.equal(nativeRoot.URI, "mailbox://identity@root-identity.invalid");
      Assert.strictEqual(
        MailServices.folderLookup.getFolderForURL(nativeRoot.URI),
        nativeRoot
      );
      Assert.ok(childCalls < nativeChildren.length);
      return nativeChildren[childCalls++];
    });
    registerCleanupFunction(() => MockRegistrar.unregister(childCID));
    const incoming = MailServices.accounts.getIncomingServer(key);
    Assert.strictEqual(incoming, server);
    Assert.ok(incoming instanceof Ci.nsIPop3IncomingServer);
    Assert.equal(incoming.type, "pop3");
    const root = incoming.rootFolder;
    Assert.strictEqual(root, nativeRoot);
    Assert.ok(root instanceof Ci.nsIMsgLocalMailFolder);
    Assert.equal(root.id, rootId);
    Assert.equal(root.URI, "mailbox://identity@root-identity.invalid");
    PanoramaDelivery._assertStore(root, lane);
    Assert.deepEqual(root.subFolders.map(f => [f.name, f.id]).sort(), expected);
    for (const [name, id] of expected) {
      const child = root.getChildNamed(name);
      Assert.ok(nativeChildren.includes(child));
      Assert.equal(child.id, id);
      Assert.strictEqual(child.parent, root);
      Assert.equal(child.URI, root.URI + "/" + name);
      Assert.strictEqual(folderDB.getMsgFolderForFolder(id), child);
      if (name == "Known") {
        PanoramaDelivery._assertStore(child, lane);
      }
    }
    Assert.strictEqual(server.rootFolder, root);
    Assert.strictEqual(server.rootMsgFolder, root);
    Assert.strictEqual(
      MailServices.folderLookup.getFolderForURL(root.URI),
      root
    );
    Assert.equal(rootCalls, 1);
    Assert.equal(
      childCalls,
      3,
      "Successful cached reads never restore children again"
    );
    MockRegistrar.unregister(childCID);
    MockRegistrar.unregister(rootCID);
  }
);
