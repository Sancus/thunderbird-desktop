/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

const { MockRegistrar: discoveryMockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);

let fixture;

add_setup(function setupDiscovery() {
  const lane = PanoramaDelivery.expectedLane();
  info(
    "DELIVERY_IMAP_FIXTURE " +
      JSON.stringify({ ...lane, mode: "preconfigured-store", discoveryCase })
  );
  fixture = PanoramaDelivery.createImapFixture();
});

/**
 * Seeds only the server. The client must learn these folders through LIST/LSUB.
 *
 * @param {boolean} nested - Whether to include a nested mailbox.
 */
function seedMailboxes(nested) {
  const { daemon, rootFolder } = fixture;
  Assert.equal(rootFolder.getChildNamed("DeliveryParent"), null);
  daemon.createMailbox("DeliveryParent", {
    subscribed: true,
    uidvalidity: daemon.uidvalidity++,
  });
  if (nested) {
    daemon.createMailbox("DeliveryParent/DeliveryChild", {
      subscribed: true,
      uidvalidity: daemon.uidvalidity++,
    });
  }
  Assert.deepEqual(
    daemon.root.allChildren.map(mailbox => mailbox.fullName).sort(),
    nested
      ? ["DeliveryParent", "DeliveryParent/DeliveryChild", "INBOX"]
      : ["DeliveryParent", "INBOX"],
    "The fake server has exactly the intended mailbox hierarchy"
  );
}

/**
 * Runs production discovery and verifies actual mailbox listing commands.
 *
 * @returns {Promise<void>} Resolves when the discovery URL completes.
 * @throws {Error} Rejects with the original discovery URL error.
 */
async function discover() {
  info('DELIVERY_PHASE {"phase":"imap-discovery-started"}');
  const listingCount = () =>
    [fixture.server.playTransaction()]
      .flat()
      .reduce(
        (count, transaction) =>
          count +
          transaction.them.filter(line => /^\S+ (LIST|LSUB) /i.test(line))
            .length,
        0
      );
  const previousListings = listingCount();
  let completions = 0;
  const listener = new PromiseTestUtils.PromiseUrlListener({
    OnStopRunningUrl() {
      completions++;
    },
  });
  MailServices.imap.discoverAllFolders(fixture.rootFolder, listener, null);
  try {
    await listener.promise;
  } finally {
    Assert.equal(completions, 1, "Discovery completes its URL listener once");
    Assert.greater(
      listingCount(),
      previousListings,
      "Discovery reached the fake server's mailbox listing commands"
    );
  }
  info('DELIVERY_PHASE {"phase":"imap-discovery-url-complete"}');
}

/**
 * Checks a server-discovered child without creating a client folder.
 *
 * @param {nsIMsgFolder} parent - The expected client parent.
 * @param {string} name - The literal leaf name.
 * @param {string} uri - The expected URI.
 * @returns {nsIMsgImapMailFolder} The discovered protocol folder.
 */
function discoveredChild(parent, name, uri) {
  const folder = parent.getChildNamed(name);
  Assert.ok(folder, "Discovery materialized " + uri);
  folder.QueryInterface(Ci.nsIMsgImapMailFolder);
  Assert.equal(folder.parent, parent, "The discovered parent is preserved");
  Assert.equal(folder.server, fixture.incomingServer);
  Assert.equal(folder.name, name);
  Assert.equal(folder.URI, uri);
  Assert.equal(MailServices.folderLookup.getFolderForURL(uri), folder);
  Assert.equal(
    parent.subFolders.filter(child => child.name == name).length,
    1,
    "The parent exposes exactly one child with this name"
  );
  if (fixture.core) {
    Assert.greater(folder.id, 0, "The discovered child has a Panorama ID");
    Assert.equal(
      fixture.core.folderDB.getFolderChildNamed(parent.id, name),
      folder.id,
      "The persisted hierarchy identifies the discovered child"
    );
    Assert.equal(
      fixture.core.folderDB.getMsgFolderForFolder(folder.id),
      folder
    );
  }
  return folder;
}

// The independently selected cache policy permits only these client bits.
const cacheClientFlags =
  (Ci.nsMsgFolderFlags.Elided |
    Ci.nsMsgFolderFlags.Offline |
    Ci.nsMsgFolderFlags.CheckNew |
    Ci.nsMsgFolderFlags.Favorite) >>>
  0;

/**
 * Reads the committed native word without consulting the folder wrapper.
 *
 * @param {nsIMsgFolder} folder - The actual physical native folder.
 * @returns {number} The unsigned committed folder flags.
 */
function storedFolderFlags(folder) {
  const statement = fixture.core.connectionForTests.createStatement(
    "SELECT flags FROM folders WHERE id = :id"
  );
  try {
    statement.params.id = folder.id;
    Assert.ok(statement.executeStep(), "The physical folder row exists");
    const flags = statement.getInt64(0) >>> 0;
    Assert.ok(!statement.executeStep(), "The physical ID has one row");
    return flags;
  } finally {
    statement.finalize();
  }
}

/**
 * Reads the native-only origin record; this test never creates an origin grant.
 *
 * @param {nsIMsgFolder} folder - The actual physical native folder.
 * @returns {{ explicitClientMask: number }} The native client-choice veto.
 */
function storedDiscoveryOrigin(folder) {
  const statement = fixture.core.connectionForTests.createStatement(
    "SELECT value FROM folder_properties " +
      "WHERE id = :id AND name = 'panoramaCacheImportOrigin'"
  );
  try {
    statement.params.id = folder.id;
    Assert.ok(statement.executeStep(), "Actual discovery persisted its origin");
    const fields = statement.getUTF8String(0).split("\n");
    Assert.equal(
      fields.length,
      13,
      "The native origin has its complete v1 shape"
    );
    Assert.equal(fields[0], "1");
    Assert.equal(fields[3], String(folder.id));
    Assert.equal(fields[4], String(folder.parent.id));
    Assert.equal(fields[12], "end");
    Assert.ok(fields[1], "The native origin binds its database source");
    Assert.ok(fields[2], "The native origin binds its birth generation");
    Assert.ok(
      /^\d+$/.test(fields[7]),
      "The explicit veto is a literal integer"
    );
    const explicitClientMask = Number(fields[7]);
    Assert.ok(Number.isSafeInteger(explicitClientMask));
    Assert.equal(explicitClientMask >>> 0, explicitClientMask);
    Assert.ok(!statement.executeStep(), "The folder has one origin record");
    return { explicitClientMask };
  } finally {
    statement.finalize();
  }
}

async function test_discoversChild() {
  seedMailboxes(false);
  const { rootFolder, incomingServer, account, core, daemon } = fixture;
  const junkURI = rootFolder.URI + "/Junk";
  const templatesURI = rootFolder.URI + "/UnlistedTemplates";
  if (core) {
    account.defaultIdentity.templatesFolderURI = templatesURI;
    incomingServer.spamSettings.actionTargetAccount = rootFolder.URI;
    incomingServer.spamSettings.moveTargetMode =
      Ci.nsISpamSettings.MOVE_TARGET_MODE_ACCOUNT;
    Assert.equal(incomingServer.spamSettings.spamFolderURI, junkURI);
  }
  await discover();
  const folder = discoveredChild(
    fixture.rootFolder,
    "DeliveryParent",
    fixture.rootFolder.URI + "/DeliveryParent"
  );
  PanoramaDelivery.assertFolder(folder, fixture.lane);
  if (core) {
    for (const [name, uri] of [
      ["Junk", junkURI],
      ["UnlistedTemplates", templatesURI],
    ]) {
      Assert.equal(rootFolder.getChildNamed(name), null);
      Assert.equal(core.folderDB.getFolderChildNamed(rootFolder.id, name), 0);
      Assert.equal(MailServices.folderLookup.getFolderForURL(uri), null);
      Assert.equal(
        daemon.getMailbox(name),
        null,
        "Discovery invents no server mailbox"
      );
    }
    Assert.equal(account.defaultIdentity.templatesFolderURI, templatesURI);
    Assert.equal(incomingServer.spamSettings.spamFolderURI, junkURI);
    daemon.createMailbox("Junk", { subscribed: true });
    daemon.createMailbox("UnlistedTemplates", { subscribed: true });
    await discover();
    const junk = discoveredChild(rootFolder, "Junk", junkURI);
    const templates = discoveredChild(
      rootFolder,
      "UnlistedTemplates",
      templatesURI
    );
    const ids = [junk.id, templates.id];
    Assert.ok(junk.getFlag(Ci.nsMsgFolderFlags.Junk));
    Assert.ok(templates.getFlag(Ci.nsMsgFolderFlags.Templates));
    incomingServer.spamSettings.actionTargetFolder =
      rootFolder.URI + "/AbsentTarget";
    incomingServer.spamSettings.moveTargetMode =
      Ci.nsISpamSettings.MOVE_TARGET_MODE_FOLDER;
    await discover();
    Assert.equal(incomingServer.spamSettings.spamFolderURI, junkURI);
    Assert.equal(
      incomingServer.getStringValue("spamActionTargetFolder"),
      junkURI
    );
    Assert.equal(
      core.folderDB.getFolderChildNamed(rootFolder.id, "AbsentTarget"),
      0
    );
    incomingServer.spamSettings.actionTargetFolder = folder.URI;
    await discover();
    Assert.equal(incomingServer.spamSettings.spamFolderURI, folder.URI);
    Assert.ok(folder.getFlag(Ci.nsMsgFolderFlags.Junk));
    Assert.strictEqual(rootFolder.getChildNamed("Junk"), junk);
    Assert.strictEqual(
      rootFolder.getChildNamed("UnlistedTemplates"),
      templates
    );
    Assert.deepEqual([junk.id, templates.id], ids);

    const settings = incomingServer.spamSettings;
    const previousAccount = settings.actionTargetAccount;
    const previousMode = settings.moveTargetMode;
    const previousStoredAccount = incomingServer.getStringValue(
      "spamActionTargetAccount"
    );
    const absentAccountURI = "imap://removed-discovery-account@127.0.0.1";
    const rootIds = core.folderDB.getFolderChildren(0);
    const childIds = core.folderDB.getFolderChildren(rootFolder.id);
    try {
      settings.actionTargetAccount = absentAccountURI;
      settings.moveTargetMode = Ci.nsISpamSettings.MOVE_TARGET_MODE_ACCOUNT;
      await discover();
      Assert.equal(settings.actionTargetAccount, absentAccountURI);
      Assert.equal(
        settings.moveTargetMode,
        Ci.nsISpamSettings.MOVE_TARGET_MODE_ACCOUNT
      );
      Assert.equal(
        incomingServer.getStringValue("spamActionTargetAccount"),
        previousStoredAccount,
        "Discovery preserves the configured account preference"
      );
      Assert.equal(
        MailServices.folderLookup.getFolderForURL(absentAccountURI),
        null
      );
      Assert.equal(
        MailServices.folderLookup.getFolderForURL(absentAccountURI + "/Junk"),
        null
      );
      Assert.deepEqual(core.folderDB.getFolderChildren(0), rootIds);
      Assert.deepEqual(
        core.folderDB.getFolderChildren(rootFolder.id),
        childIds
      );
      const selectCount = () =>
        [fixture.server.playTransaction()]
          .flat()
          .reduce(
            (count, transaction) =>
              count +
              transaction.them.filter(line =>
                /^\S+ (SELECT|EXAMINE) /i.test(line)
              ).length,
            0
          );
      const previousSelects = selectCount();
      let completions = 0;
      const listener = new PromiseTestUtils.PromiseUrlListener({
        OnStopRunningUrl() {
          completions++;
        },
      });
      folder.updateFolderWithListener(null, listener);
      await listener.promise;
      Assert.equal(completions, 1, "A later folder update finishes once");
      Assert.greater(
        selectCount(),
        previousSelects,
        "A later URL reaches SELECT"
      );
      Assert.strictEqual(rootFolder.getChildNamed("DeliveryParent"), folder);
      Assert.deepEqual(core.folderDB.getFolderChildren(0), rootIds);
      Assert.deepEqual(
        core.folderDB.getFolderChildren(rootFolder.id),
        childIds
      );
    } finally {
      settings.actionTargetAccount = previousAccount;
      settings.moveTargetMode = previousMode;
    }
  }
  info('DELIVERY_PHASE {"phase":"imap-discovery-child-verified"}');
}

async function test_discoversNestedChild() {
  seedMailboxes(true);
  await discover();
  const parent = discoveredChild(
    fixture.rootFolder,
    "DeliveryParent",
    fixture.rootFolder.URI + "/DeliveryParent"
  );
  const child = discoveredChild(
    parent,
    "DeliveryChild",
    fixture.rootFolder.URI + "/DeliveryParent/DeliveryChild"
  );
  Assert.deepEqual(child.subFolders, [], "The nested mailbox has no children");
  PanoramaDelivery.assertFolder(parent, fixture.lane);
  PanoramaDelivery.assertFolder(child, fixture.lane);
  info('DELIVERY_PHASE {"phase":"imap-discovery-nested-verified"}');
}

/**
 * Checks genuine discovery history without changing the native origin record.
 *
 * @param {nsIMsgFolder[]} folders - Physical folders reached by normal LIST.
 * @param {string} stage - The completed read or discovery boundary.
 */
function assertDiscoveryHasNoClientChoice(folders, stage) {
  Assert.equal(
    cacheClientFlags,
    0xa8000010,
    "The complete client mask is exact"
  );
  for (const folder of folders) {
    Assert.equal(
      (storedDiscoveryOrigin(folder).explicitClientMask & cacheClientFlags) >>>
        0,
      0,
      stage + ": no explicit client choice is inferred"
    );
  }
}

async function test_repeatedDiscoveryPreservesIdentity() {
  seedMailboxes(true);
  await discover();
  const root = fixture.rootFolder;
  const parent = discoveredChild(
    root,
    "DeliveryParent",
    root.URI + "/DeliveryParent"
  );
  const child = discoveredChild(
    parent,
    "DeliveryChild",
    root.URI + "/DeliveryParent/DeliveryChild"
  );
  const ids = fixture.core ? [parent.id, child.id] : null;
  const rootChildren = root.subFolders;
  const nestedChildren = parent.subFolders;
  if (fixture.core) {
    assertDiscoveryHasNoClientChoice([parent, child], "Initial real LIST");
  }
  const heldDatabase = fixture.core ? child.msgDatabase : null;
  if (fixture.core) {
    assertDiscoveryHasNoClientChoice([parent, child], "Open native database");
  }
  info('DELIVERY_PHASE {"phase":"imap-discovery-repeat-ready"}');
  await discover();
  Assert.equal(
    discoveredChild(root, "DeliveryParent", root.URI + "/DeliveryParent"),
    parent,
    "Repeated discovery retains the parent object"
  );
  Assert.equal(
    discoveredChild(
      parent,
      "DeliveryChild",
      root.URI + "/DeliveryParent/DeliveryChild"
    ),
    child,
    "Repeated discovery retains the nested object"
  );
  Assert.deepEqual(
    root.subFolders.map(folder => folder.URI).sort(),
    rootChildren.map(folder => folder.URI).sort(),
    "Repeated discovery adds no root children"
  );
  Assert.deepEqual(
    parent.subFolders.map(folder => folder.URI).sort(),
    nestedChildren.map(folder => folder.URI).sort(),
    "Repeated discovery adds no nested children"
  );
  if (ids) {
    assertDiscoveryHasNoClientChoice([parent, child], "Repeated real LIST");
    Assert.strictEqual(
      child.msgDatabase,
      heldDatabase,
      "LIST preserves an already open database"
    );
    child.msgDatabase = null;
    Assert.equal(child.databaseOpen, false);
    await discover();
    Assert.equal(
      child.databaseOpen,
      false,
      "LIST releases only the metadata database it opened"
    );
    assertDiscoveryHasNoClientChoice([parent, child], "Closed-database LIST");
    Assert.deepEqual(
      [parent.id, child.id],
      ids,
      "Repeated discovery retains the persisted folder identities"
    );
  }
  PanoramaDelivery.assertFolder(parent, fixture.lane);
  PanoramaDelivery.assertFolder(child, fixture.lane);
  if (fixture.core) {
    for (const folder of [parent, child]) {
      const origin = storedDiscoveryOrigin(folder);
      Assert.equal((origin.explicitClientMask & cacheClientFlags) >>> 0, 0);
      folder.setFlag(cacheClientFlags);
      folder.clearFlag(cacheClientFlags);
      folder.flags = 0;
      folder.flags = 0;
      Assert.equal((folder.flags & cacheClientFlags) >>> 0, 0);
      Assert.equal((storedFolderFlags(folder) & cacheClientFlags) >>> 0, 0);
      Assert.equal(
        (storedDiscoveryOrigin(folder).explicitClientMask &
          cacheClientFlags) >>>
          0,
        cacheClientFlags,
        "An equal whole-word zero is still an explicit client choice"
      );
    }
    await discover();
    for (const folder of [parent, child]) {
      Assert.equal((folder.flags & cacheClientFlags) >>> 0, 0);
      Assert.equal((storedFolderFlags(folder) & cacheClientFlags) >>> 0, 0);
      folder.ForceDBClosed();
      Assert.equal(
        (folder.msgDatabase.dBFolderInfo.flags & cacheClientFlags) >>> 0,
        0
      );
      Assert.equal(
        (storedDiscoveryOrigin(folder).explicitClientMask &
          cacheClientFlags) >>>
          0,
        cacheClientFlags,
        "LIST and metadata reopen cannot reset the explicit-zero veto"
      );
    }
    const parentPath = parent.filePath;
    const childPath = child.filePath.path;
    const unsupportedPath = parentPath.clone();
    unsupportedPath.leafName = "DifferentDeliveryParent";
    let retryId;
    parent.filePath = unsupportedPath;
    try {
      fixture.daemon.createMailbox("DeliveryParent/DeliveryRetry", {
        subscribed: true,
      });
      Assert.deepEqual(
        fixture.daemon.root.allChildren.map(mailbox => mailbox.fullName).sort(),
        [
          "DeliveryParent",
          "DeliveryParent/DeliveryChild",
          "DeliveryParent/DeliveryRetry",
          "INBOX",
          "Trash",
        ]
      );
      await Assert.rejects(
        discover(),
        error => error.message == String(Cr.NS_ERROR_NOT_IMPLEMENTED),
        "The unsupported effective parent path reports its original error"
      );
      Assert.equal(
        parent.getChildNamed("DeliveryRetry"),
        null,
        "An unsupported effective parent path cannot publish a child"
      );
      retryId = fixture.core.folderDB.getFolderChildNamed(
        parent.id,
        "DeliveryRetry"
      );
      Assert.greater(
        retryId,
        0,
        "The server-known row survives the failed attempt"
      );
      Assert.equal(
        MailServices.folderLookup.getFolderForURL(
          parent.URI + "/DeliveryRetry"
        ),
        null,
        "The failed object is absent from the live folder cache"
      );
      Assert.equal(parent.getChildNamed("DeliveryChild"), child);
      Assert.equal(child.filePath.path, childPath);
    } finally {
      parent.filePath = parentPath;
    }
    await discover();
    const retry = discoveredChild(
      parent,
      "DeliveryRetry",
      parent.URI + "/DeliveryRetry"
    );
    Assert.equal(
      retry.id,
      retryId,
      "Retry materializes the retained server row"
    );
    Assert.equal(retry.onlineName, "DeliveryParent/DeliveryRetry");
    Assert.equal(retry.hierarchyDelimiter, "/");
    const expectedPath = parentPath.clone();
    expectedPath.leafName += ".sbd";
    expectedPath.append("DeliveryRetry");
    Assert.ok(retry.filePath.equals(expectedPath));
    PanoramaDelivery.assertFolder(retry, fixture.lane);
    await discover();
    Assert.equal(parent.getChildNamed("DeliveryRetry"), retry);
    Assert.equal(parent.getChildNamed("DeliveryChild"), child);
    Assert.equal(child.filePath.path, childPath);
    Assert.deepEqual([parent.id, child.id], ids);
    fixture.daemon.createMailbox("DeliveryParent/FactoryRetry", {
      subscribed: true,
    });
    let factoryCalls = 0;
    let pendingId;
    const cid = discoveryMockRegistrar.register(
      "@mozilla.org/mail/folder-factory;1?name=imap",
      () => {
        factoryCalls++;
        // The sibling's inert discovery ticket grants this callback nothing.
        parent.flags = 0;
        child.flags = 0;
        throw Components.Exception(
          "Discovery factory failure",
          Cr.NS_ERROR_FAILURE
        );
      }
    );
    try {
      await Assert.rejects(
        discover(),
        error => error.message == String(Cr.NS_ERROR_FAILURE),
        "The actual child factory failure reaches discovery completion"
      );
      Assert.greater(factoryCalls, 0);
      pendingId = fixture.core.folderDB.getFolderChildNamed(
        parent.id,
        "FactoryRetry"
      );
      Assert.greater(
        pendingId,
        0,
        "Failed initialization retains the server row"
      );
      Assert.equal(parent.getChildNamed("FactoryRetry"), null);
      Assert.equal(
        MailServices.folderLookup.getFolderForURL(parent.URI + "/FactoryRetry"),
        null,
        "A failed factory never publishes a live wrapper"
      );
      Assert.strictEqual(parent.getChildNamed("DeliveryChild"), child);
      Assert.equal(child.filePath.path, childPath);
    } finally {
      discoveryMockRegistrar.unregister(cid);
    }
    await discover();
    const completed = discoveredChild(
      parent,
      "FactoryRetry",
      parent.URI + "/FactoryRetry"
    );
    Assert.equal(completed.id, pendingId);
    Assert.equal(completed.onlineName, "DeliveryParent/FactoryRetry");
    Assert.deepEqual([parent.id, child.id], ids);
    Assert.equal((parent.flags & cacheClientFlags) >>> 0, 0);
    Assert.equal((child.flags & cacheClientFlags) >>> 0, 0);

    let callbackWrites = 0;
    const callbackURI = parent.URI + "/CallbackChoice";
    const listener = {
      onFolderIntPropertyChanged(folder, property) {
        if (
          folder.URI == callbackURI &&
          property == "FolderFlag" &&
          callbackWrites == 0
        ) {
          callbackWrites++;
          // This runs synchronously after the box ticket was consumed. Neither
          // this folder nor a sibling may inherit permission for client bits.
          folder.flags = 0;
          parent.flags = 0;
        }
      },
      QueryInterface: ChromeUtils.generateQI(["nsIFolderListener"]),
    };
    MailServices.mailSession.AddFolderListener(
      listener,
      Ci.nsIFolderListener.intPropertyChanged
    );
    try {
      fixture.daemon.createMailbox("DeliveryParent/CallbackChoice", {
        subscribed: true,
      });
      await discover();
      Assert.equal(callbackWrites, 1, "A real initial flag callback ran once");
    } finally {
      MailServices.mailSession.RemoveFolderListener(listener);
    }
    const callbackFolder = discoveredChild(
      parent,
      "CallbackChoice",
      callbackURI
    );
    const callbackId = callbackFolder.id;
    for (const folder of [callbackFolder, parent]) {
      Assert.equal((folder.flags & cacheClientFlags) >>> 0, 0);
      Assert.equal((storedFolderFlags(folder) & cacheClientFlags) >>> 0, 0);
      Assert.equal(
        (storedDiscoveryOrigin(folder).explicitClientMask &
          cacheClientFlags) >>>
          0,
        cacheClientFlags
      );
    }
    await discover();
    Assert.strictEqual(parent.getChildNamed("CallbackChoice"), callbackFolder);
    Assert.equal(callbackFolder.id, callbackId);
    Assert.equal((callbackFolder.flags & cacheClientFlags) >>> 0, 0);
    Assert.equal(
      (storedFolderFlags(callbackFolder) & cacheClientFlags) >>> 0,
      0
    );

    const explicitFolder = root.addSubfolder("ExplicitCreation");
    const explicitId = explicitFolder.id;
    explicitFolder.flags = 0;
    const originQuery = fixture.core.connectionForTests.createStatement(
      "SELECT value FROM folder_properties " +
        "WHERE id = :id AND name = 'panoramaCacheImportOrigin'"
    );
    try {
      originQuery.params.id = explicitId;
      Assert.ok(
        !originQuery.executeStep(),
        "Arbitrary public creation cannot manufacture discovery origin"
      );
    } finally {
      originQuery.finalize();
    }
    fixture.daemon.createMailbox("ExplicitCreation", { subscribed: true });
    await discover();
    Assert.strictEqual(root.getChildNamed("ExplicitCreation"), explicitFolder);
    Assert.equal(explicitFolder.id, explicitId);
    Assert.equal((explicitFolder.flags & cacheClientFlags) >>> 0, 0);
    Assert.equal(
      (storedFolderFlags(explicitFolder) & cacheClientFlags) >>> 0,
      0
    );
    explicitFolder.ForceDBClosed();
    Assert.equal(
      (explicitFolder.msgDatabase.dBFolderInfo.flags & cacheClientFlags) >>> 0,
      0,
      "A real later LIST cannot treat the existing public zero as absent"
    );
  }
  info('DELIVERY_PHASE {"phase":"imap-discovery-repeat-verified"}');
}

async function test_discoveryStoresOnlineName() {
  seedMailboxes(true);
  await discover();
  const parent = discoveredChild(
    fixture.rootFolder,
    "DeliveryParent",
    fixture.rootFolder.URI + "/DeliveryParent"
  );
  const child = discoveredChild(
    parent,
    "DeliveryChild",
    fixture.rootFolder.URI + "/DeliveryParent/DeliveryChild"
  );
  PanoramaDelivery.assertFolder(child, fixture.lane);
  Assert.equal(child.onlineName, "DeliveryParent/DeliveryChild");
  child.ForceDBClosed();
  const db = PanoramaDelivery.assertFolder(child, fixture.lane);
  Assert.equal(
    db.dBFolderInfo.getCharProperty("onlineName"),
    "DeliveryParent/DeliveryChild",
    "The stored online-name property retains the complete server mailbox name"
  );
  info('DELIVERY_PHASE {"phase":"imap-discovery-online-property-verified"}');
  Assert.equal(
    db.dBFolderInfo.mailboxName,
    "DeliveryParent/DeliveryChild",
    "The mailbox-name accessor retains the complete server mailbox name"
  );
  if (fixture.core) {
    const connection = fixture.core.connectionForTests;
    const id = child.id;
    const path = child.filePath.path;
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER fail_discovery_pref BEFORE INSERT ON folder_properties " +
        "WHEN NEW.id = " +
        id +
        " AND NEW.name = 'hierDelim' " +
        "BEGIN SELECT RAISE(ABORT, 'discovery pref failure'); END"
    );
    try {
      await Assert.rejects(
        discover(),
        error => error.message == String(Cr.NS_ERROR_STORAGE_CONSTRAINT),
        "A real retained-row metadata write failure is not a successful LIST"
      );
      Assert.strictEqual(parent.getChildNamed("DeliveryChild"), child);
      Assert.equal(child.id, id);
      Assert.equal(child.filePath.path, path);
      Assert.equal(
        fixture.core.folderDB.getFolderChildNamed(parent.id, "DeliveryChild"),
        id
      );
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER fail_discovery_pref");
    }
    await discover();
    Assert.strictEqual(parent.getChildNamed("DeliveryChild"), child);
    Assert.equal(child.id, id);
    Assert.equal(child.onlineName, "DeliveryParent/DeliveryChild");
    const beforeFlags = child.flags;
    const beforeStoredFlags = storedFolderFlags(child);
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER fail_discovery_flags BEFORE UPDATE OF flags ON folders " +
        "WHEN OLD.id = " +
        id +
        " BEGIN SELECT RAISE(ABORT, 'discovery flag failure'); END"
    );
    try {
      await Assert.rejects(
        discover(),
        error => error.message == String(Cr.NS_ERROR_STORAGE_CONSTRAINT),
        "A checked discovery flag write preserves its actual native failure"
      );
      Assert.strictEqual(parent.getChildNamed("DeliveryChild"), child);
      Assert.equal(child.id, id);
      Assert.equal(child.filePath.path, path);
      Assert.equal(
        child.flags,
        beforeFlags,
        "Failed flags are not published warm"
      );
      Assert.equal(storedFolderFlags(child), beforeStoredFlags);
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER fail_discovery_flags");
    }
    await discover();
    Assert.strictEqual(parent.getChildNamed("DeliveryChild"), child);
    Assert.equal(child.id, id);
    Assert.equal(child.flags, beforeFlags);
    Assert.equal(storedFolderFlags(child), beforeStoredFlags);
    Assert.throws(
      () =>
        fixture.incomingServer
          .QueryInterface(Ci.nsIImapServerSink)
          .possibleImapMailbox("", "/", 0),
      /NS_ERROR_FAILURE/,
      "An invalid mailbox declaration preserves its original error"
    );
  }
  info('DELIVERY_PHASE {"phase":"imap-discovery-online-name-verified"}');
}

async function test_discoveryReportsDelimiter() {
  seedMailboxes(true);
  await discover();
  const parent = discoveredChild(
    fixture.rootFolder,
    "DeliveryParent",
    fixture.rootFolder.URI + "/DeliveryParent"
  );
  const child = discoveredChild(
    parent,
    "DeliveryChild",
    fixture.rootFolder.URI + "/DeliveryParent/DeliveryChild"
  );
  Assert.equal(fixture.daemon.getMailbox("DeliveryParent").delimiter, "/");
  Assert.equal(
    fixture.daemon.getMailbox("DeliveryParent/DeliveryChild").delimiter,
    "/"
  );
  Assert.equal(parent.hierarchyDelimiter, "/");
  Assert.equal(child.hierarchyDelimiter, "/");
  const parentDB = PanoramaDelivery.assertFolder(parent, fixture.lane);
  const childDB = PanoramaDelivery.assertFolder(child, fixture.lane);
  if (fixture.core) {
    Assert.equal(parentDB.dBFolderInfo.getUint32Property("hierDelim", 0), 47);
    Assert.equal(childDB.dBFolderInfo.getUint32Property("hierDelim", 0), 47);
  }
  if (fixture.core) {
    const ids = [parent.id, child.id];
    for (const mailbox of [
      fixture.daemon.root,
      ...fixture.daemon.root.allChildren,
    ]) {
      mailbox.delimiter = ".";
    }
    fixture.incomingServer.closeCachedConnections();
    await discover();
    Assert.strictEqual(
      fixture.rootFolder.getChildNamed("DeliveryParent"),
      parent
    );
    Assert.strictEqual(parent.getChildNamed("DeliveryChild"), child);
    Assert.deepEqual([parent.id, child.id], ids);
    Assert.equal(
      fixture.daemon.getMailbox("DeliveryParent.DeliveryChild").delimiter,
      "."
    );
    Assert.equal(parent.hierarchyDelimiter, ".");
    Assert.equal(child.hierarchyDelimiter, ".");
    Assert.equal(child.onlineName, "DeliveryParent.DeliveryChild");
    Assert.equal(
      child.msgDatabase.dBFolderInfo.getUint32Property("hierDelim", 0),
      46
    );
    child.ForceDBClosed();
    Assert.equal(
      child.msgDatabase.dBFolderInfo.mailboxName,
      "DeliveryParent.DeliveryChild"
    );
  }
  info('DELIVERY_PHASE {"phase":"imap-discovery-delimiter-verified"}');
}

// Each manual manifest selects one task in a fresh process. No skipped tasks.
const discoveryCase = Services.prefs.getStringPref(
  "mail.test.panorama.discovery_case"
);
const discoveryTasks = {
  child: test_discoversChild,
  nested: test_discoversNestedChild,
  repeat: test_repeatedDiscoveryPreservesIdentity,
  "online-name": test_discoveryStoresOnlineName,
  delimiter: test_discoveryReportsDelimiter,
};
if (!Object.hasOwn(discoveryTasks, discoveryCase)) {
  throw new Error("Unsupported IMAP discovery case: " + discoveryCase);
}
add_task(discoveryTasks[discoveryCase]);
