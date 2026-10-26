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
  async function test_rootGetterRetriesAfterNativeInitializationFailure() {
    const lane = PanoramaDelivery.expectedLane();
    Assert.equal(lane.backend, "panorama");
    Assert.ok(["mbox", "maildir"].includes(lane.store));
    Assert.strictEqual(
      mozinfo.debug,
      false,
      "The NS_ERROR control requires non-DEBUG"
    );
    const { folder: stable } =
      PanoramaDelivery.createLocalFixture("root-bystander");
    const stableId = stable.id;
    const stableParent = stable.parent;
    const stableURI = stable.URI;
    const key = "jsRootRetry";
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
      userName: "retry",
      hostname: "root-cache.invalid",
      storeContractID: storeContract,
    })) {
      Services.prefs.setStringPref(prefix + name, value);
    }
    const directory = do_get_profile();
    directory.append("js-root-retry");
    await IOUtils.makeDirectory(directory.path);
    Services.prefs.setComplexValue(prefix + "directory", Ci.nsIFile, directory);
    const rootId = folderDB.insertRoot(key);
    const knownId = folderDB.insertFolder(rootId, "Known");
    const nestedId = folderDB.insertFolder(knownId, "Nested");
    const inboxId = folderDB.insertFolder(rootId, "Inbox");
    const trashId = folderDB.insertFolder(rootId, "Trash");
    const expectedRows = [
      [rootId, 0, key],
      [knownId, rootId, "Known"],
      [nestedId, knownId, "Nested"],
      [inboxId, rootId, "Inbox"],
      [trashId, rootId, "Trash"],
    ].sort((a, b) => a[0] - b[0]);
    const bodies = [];
    for (const path of [
      PathUtils.join(directory.path, "Known"),
      PathUtils.join(directory.path, "Known.sbd", "Nested"),
      PathUtils.join(directory.path, "Inbox"),
      PathUtils.join(directory.path, "Trash"),
    ]) {
      let body = path;
      if (lane.store == "maildir") {
        await IOUtils.makeDirectory(PathUtils.join(path, "tmp"));
        body = PathUtils.join(path, "cur", "retained");
      }
      await IOUtils.makeDirectory(PathUtils.parent(body));
      await IOUtils.writeUTF8(body, "From sender@invalid\nroot retry body\n");
      bodies.push(body);
    }
    let stableBody = stable.filePath.path;
    if (lane.store == "maildir") {
      await IOUtils.makeDirectory(PathUtils.join(stableBody, "tmp"));
      stableBody = PathUtils.join(stableBody, "cur", "retained");
    }
    await IOUtils.makeDirectory(PathUtils.parent(stableBody));
    await IOUtils.writeUTF8(
      stableBody,
      "From sender@invalid\nroot retry body\n"
    );
    bodies.push(stableBody);
    const statement = database.connectionForTests.createStatement(
      "SELECT id, parent, name FROM folders " +
        "WHERE id IN (:root, :known, :nested, :inbox, :trash) ORDER BY id"
    );
    registerCleanupFunction(() => statement.finalize());
    statement.params.root = rootId;
    statement.params.known = knownId;
    statement.params.nested = nestedId;
    statement.params.inbox = inboxId;
    statement.params.trash = trashId;
    const before = [];
    while (statement.executeStep()) {
      before.push([statement.row.id, statement.row.parent, statement.row.name]);
    }
    statement.reset();
    Assert.deepEqual(
      before,
      expectedRows,
      "The persisted fixture is complete before initialization"
    );
    const events = [];
    const listener = {
      folderAdded(folder) {
        events.push(folder);
      },
    };
    MailServices.mfn.addListener(listener, MailServices.mfn.folderAdded);
    registerCleanupFunction(() => MailServices.mfn.removeListener(listener));
    const rootContract = "@mozilla.org/mail/folder;1?name=mailbox";
    const childContract = "@mozilla.org/mail/folder-factory;1?name=mailbox";
    const failed = Cc[rootContract].createInstance(Ci.nsIMsgFolder);
    const fresh = Cc[rootContract].createInstance(Ci.nsIMsgFolder);
    let rootCalls = 0;
    const rootCID = MockRegistrar.register(rootContract, () => {
      server = MailServices.accounts.getIncomingServer(key);
      Assert.ok(
        ++rootCalls <= 2,
        "At most the failed root and one fresh retry"
      );
      return rootCalls == 1 ? failed : fresh;
    });
    registerCleanupFunction(() => MockRegistrar.unregister(rootCID));
    let childCalls = 0;
    let witnessed = false;
    const childCID = MockRegistrar.register(childContract, () => {
      ++childCalls;
      Assert.ok(server instanceof Ci.nsIPop3IncomingServer);
      Assert.equal(server.type, "pop3");
      Assert.strictEqual(
        server.rootFolder,
        failed,
        "Reentry sees the provisional root"
      );
      Assert.equal(failed.id, rootId);
      Assert.equal(failed.URI, "mailbox://retry@root-cache.invalid");
      Assert.strictEqual(
        MailServices.folderLookup.getFolderForURL(failed.URI),
        failed
      );
      Assert.strictEqual(
        server.wrappedJSObject._rootMsgFolder,
        failed,
        "Lookup validation retains the provisional POP3 root"
      );
      Assert.equal(server.getStringValue("storeContractID"), storeContract);
      Assert.equal(server.msgStore.storeType, lane.store);
      witnessed = true;
      throw Components.Exception(
        "Root child factory fault",
        Cr.NS_ERROR_FAILURE
      );
    });
    registerCleanupFunction(() => MockRegistrar.unregister(childCID));
    Assert.throws(
      () => MailServices.accounts.getIncomingServer(key),
      /NS_ERROR_FAILURE/
    );
    MockRegistrar.unregister(childCID);
    Assert.ok(
      witnessed,
      "Native root initialization reached the child factory after publication"
    );
    Assert.equal(rootCalls, 1);
    Assert.equal(childCalls, 1);
    Assert.strictEqual(server.wrappedJSObject._rootFolder, null);
    Assert.strictEqual(server.wrappedJSObject._rootMsgFolder, null);
    Assert.equal(failed.id, 0);
    Assert.equal(failed.URI, "");
    Assert.equal(failed.parent, null);
    Assert.throws(
      () => failed.initWithFolderId(rootId),
      /NS_ERROR_ALREADY_INITIALIZED/
    );
    Assert.throws(
      () =>
        MailServices.folderLookup.getOrCreateFolderForURL(
          "mailbox://retry@root-cache.invalid"
        ),
      /NS_ERROR_UNEXPECTED/,
      "Native rollback evicted the failed root while it remains strongly held"
    );
    Assert.equal(
      rootCalls,
      1,
      "The cache-absence control did not initialize another root"
    );
    for (const phase of ["failed", "retried"]) {
      if (phase == "retried") {
        const root = server.rootFolder;
        Assert.strictEqual(
          root,
          fresh,
          "The public getter returns a fresh native object"
        );
        Assert.notEqual(root, failed);
        Assert.ok(root instanceof Ci.nsIMsgLocalMailFolder);
        Assert.equal(root.id, rootId);
        Assert.equal(root.parent, null);
        Assert.equal(root.URI, "mailbox://retry@root-cache.invalid");
        PanoramaDelivery._assertStore(root, lane);
        const known = root.getChildNamed("Known");
        const nested = known.getChildNamed("Nested");
        for (const [folder, id, parent, uri] of [
          [known, knownId, root, root.URI + "/Known"],
          [nested, nestedId, known, root.URI + "/Known/Nested"],
          [root.getChildNamed("Inbox"), inboxId, root, root.URI + "/Inbox"],
          [root.getChildNamed("Trash"), trashId, root, root.URI + "/Trash"],
        ]) {
          Assert.equal(folder.id, id);
          Assert.strictEqual(folder.parent, parent);
          Assert.equal(folder.URI, uri);
          Assert.strictEqual(
            MailServices.folderLookup.getFolderForURL(uri),
            folder
          );
        }
        Assert.strictEqual(known.server, server);
        Assert.strictEqual(known.parent, root);
        Assert.equal(known.URI, "mailbox://retry@root-cache.invalid/Known");
        PanoramaDelivery._assertStore(known, lane);
        Assert.notEqual(stableParent, root);
        Assert.deepEqual(root.subFolders.map(f => f.name).sort(), [
          "Inbox",
          "Known",
          "Trash",
        ]);
        Assert.deepEqual(known.subFolders, [nested]);
        Assert.strictEqual(server.rootFolder, root);
        Assert.strictEqual(server.rootMsgFolder, root);
        Assert.strictEqual(folderDB.getMsgFolderForFolder(rootId), root);
        Assert.strictEqual(
          MailServices.folderLookup.getFolderForURL(root.URI),
          root
        );
        Assert.equal(rootCalls, 2);
      }
      statement.params.root = rootId;
      statement.params.known = knownId;
      statement.params.nested = nestedId;
      statement.params.inbox = inboxId;
      statement.params.trash = trashId;
      const rows = [];
      while (statement.executeStep()) {
        rows.push([statement.row.id, statement.row.parent, statement.row.name]);
      }
      statement.reset();
      Assert.deepEqual(
        rows,
        expectedRows,
        phase + " retains every original row"
      );
      for (const body of bodies) {
        Assert.equal(
          await IOUtils.readUTF8(body),
          "From sender@invalid\nroot retry body\n"
        );
      }
      Assert.equal(stable.id, stableId);
      Assert.strictEqual(stable.parent, stableParent);
      Assert.equal(stable.URI, stableURI);
      Assert.strictEqual(
        MailServices.folderLookup.getFolderForURL(stableURI),
        stable
      );
      Assert.deepEqual(events, [], phase + " emits no folder-added event");
      Assert.strictEqual(stableParent, stable.server.rootFolder);
      Assert.equal(stableParent.URI, "mailbox://nobody@Local%20Folders");
      PanoramaDelivery._assertStore(stable, lane);
    }
    MockRegistrar.unregister(rootCID);
  }
);
