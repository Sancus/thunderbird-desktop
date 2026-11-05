/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from head_delivery.js */

const { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);

const cacheClientMask = 0xa8000010;

/**
 * Reads the private version-one origin produced by native discovery.
 *
 * @param {nsIMsgFolder} folder - The actual physical folder.
 * @returns {{text: string, mask: number, revision: number, pending: number,
 *   used: number, generation: string, source: string, id: number, parent: number,
 *   name: string, birth: number}|null} The stored origin, or no record.
 */
function readCacheOrigin(folder) {
  const statement = database.connectionForTests.createStatement(
    "SELECT value FROM folder_properties WHERE id = :id " +
      "AND name = 'panoramaCacheImportOrigin'"
  );
  try {
    statement.params.id = folder.id;
    if (!statement.executeStep()) {
      return null;
    }
    const text = statement.getUTF8String(0);
    Assert.ok(!statement.executeStep(), "One private origin per physical row");
    const cells = text.split("\n");
    Assert.equal(cells.length, 13);
    Assert.equal(cells[0], "1");
    Assert.equal(cells[12], "end");
    Assert.equal(Number(cells[3]), folder.id);
    Assert.ok(cells[1], "The native database source is bound");
    Assert.ok(cells[2], "The native birth generation is bound");
    return {
      text,
      mask: Number(cells[7]),
      revision: Number(cells[8]),
      pending: Number(cells[9]),
      used: Number(cells[10]),
      generation: cells[2],
      source: cells[1],
      id: Number(cells[3]),
      parent: Number(cells[4]),
      name: atob(cells[5]),
      birth: Number(cells[6]),
    };
  } finally {
    statement.finalize();
  }
}

/**
 * Lets the real mailbox store discover children before their wrappers exist.
 *
 * @param {string} label - The independent ordinary fixture name.
 * @param {string[]} names - Child body-store names to discover.
 * @param {function(): void} [beforeInit] - Optional factory fault setup.
 * @param {string[]} [rootNames] - Additional real root-level body-store names.
 * @param {"none"|"rss"} [serverType="none"] - The native account to create.
 * @returns {Promise<nsIMsgFolder>} The normally initialized physical parent.
 */
async function createObservedCacheChildren(
  label,
  names,
  beforeInit,
  rootNames = [],
  serverType = "none"
) {
  const lane = PanoramaDelivery.expectedLane();
  do_get_profile();
  loadExistingDB();
  const directory = do_get_profile();
  directory.append(label);
  await IOUtils.makeDirectory(directory.path);
  const parentPath = PathUtils.join(directory.path, "ObservedParent");
  const bodies = [
    parentPath,
    ...names.map(name => PathUtils.join(parentPath + ".sbd", name)),
    ...rootNames.map(name => PathUtils.join(directory.path, name)),
  ];
  for (let body of bodies) {
    if (lane.store == "maildir") {
      await IOUtils.makeDirectory(PathUtils.join(body, "tmp"));
      body = PathUtils.join(body, "cur", "retained");
    }
    await IOUtils.makeDirectory(PathUtils.parent(body));
    await IOUtils.writeUTF8(body, "From sender@invalid\norigin control body\n");
  }
  // getIncomingServer creates and initializes the root before returning.
  // Prepare its real store and preferences before that first exposure.
  const serverKey = label;
  const prefPrefix = "mail.server." + serverKey + ".";
  let server = null;
  registerCleanupFunction(() => {
    try {
      server ??= MailServices.accounts.getIncomingServer(serverKey);
      MailServices.accounts.removeIncomingServer(server, false);
    } finally {
      Services.prefs.deleteBranch(prefPrefix);
    }
  });
  Services.prefs.setStringPref(prefPrefix + "type", serverType);
  Services.prefs.setStringPref(prefPrefix + "userName", label);
  Services.prefs.setStringPref(prefPrefix + "hostname", label + ".invalid");
  Services.prefs.setStringPref(
    prefPrefix + "storeContractID",
    {
      mbox: "@mozilla.org/msgstore/berkeleystore;1",
      maildir: "@mozilla.org/msgstore/maildirstore;1",
    }[lane.store]
  );
  Services.prefs.setComplexValue(
    prefPrefix + "directory",
    Ci.nsIFile,
    directory
  );
  Assert.equal(
    folderDB.getFolderChildNamed(0, serverKey),
    0,
    "No native root exists before the prepared store is exposed"
  );
  beforeInit?.();
  server = MailServices.accounts.getIncomingServer(serverKey);
  const root = server.rootFolder;
  Assert.ok(readCacheOrigin(root), "Normal native root creation was observed");
  const parent = root.getChildNamed("ObservedParent");
  Assert.ok(parent, "The real root store discovered its parent");
  Assert.ok(readCacheOrigin(parent), "Native discovery classified the parent");
  for (const name of names) {
    const child = parent.getChildNamed(name);
    Assert.ok(child, "The store discovered " + name);
    Assert.equal(child.parent, parent);
    Assert.strictEqual(
      MailServices.folderLookup.getFolderForURL(child.URI),
      child
    );
    Assert.ok(readCacheOrigin(child), "Actual native child birth was observed");
  }
  return parent;
}

add_task(function test_reusesCachedChildWithoutDuplicateAttachment() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.ok(["mbox", "maildir"].includes(lane.store));
  const { folder } = PanoramaDelivery.createLocalFixture("init-identity");
  const id = folderDB.insertFolder(folder.id, "Cached");
  const child = Cc[
    "@mozilla.org/mail/folder-factory;1?name=mailbox"
  ].createInstance(Ci.nsIMsgFolder);
  child.initWithFolderId(id);
  child.parent = folder;
  const uri = folder.URI + "/Cached";
  Assert.strictEqual(MailServices.folderLookup.getFolderForURL(uri), child);
  Assert.deepEqual(folder.subFolders, []);
  Assert.strictEqual(folder.addSubfolder("Cached"), child);
  Assert.strictEqual(folder.addSubfolder("Cached"), child);
  Assert.deepEqual(folder.subFolders, [child]);
  Assert.equal(child.id, id);
  Assert.equal(
    readCacheOrigin(child),
    null,
    "Public insertion did not gain origin"
  );
  Assert.equal(child.parent, folder);
  Assert.equal(child.URI, uri);
  Assert.strictEqual(MailServices.folderLookup.getFolderForURL(uri), child);
  Assert.deepEqual(folderDB.getFolderChildren(folder.id), [id]);
});

add_task(async function test_explicitFlagAttemptsIncludeZeroAndNoOps() {
  const attempts = [
    [
      "SetZero",
      folder => {
        folder.flags = 0;
      },
    ],
    [
      "SetEqual",
      folder => {
        const flags = folder.flags;
        folder.flags = flags;
      },
    ],
    ["AddZero", folder => folder.setFlag(0)],
    ["ClearZero", folder => folder.clearFlag(0)],
    ["ToggleZero", folder => folder.toggleFlag(0)],
    [
      "InfoZero",
      (folder, info) => {
        info.flags = 0;
      },
    ],
    ["InfoOrZero", (folder, info) => info.orFlags(0)],
    ["InfoAndEqual", (folder, info) => info.andFlags(-1)],
  ];
  const parent = await createObservedCacheChildren(
    "origin-attempts",
    attempts.map(([name]) => name)
  );
  for (const [name, attempt] of attempts) {
    const folder = parent.getChildNamed(name);
    const info = folder.msgDatabase.dBFolderInfo;
    const before = readCacheOrigin(folder);
    Assert.equal(before.mask, 0, "Opening the facade did not invent a choice");
    const flags = folderDB.getFolderFlags(folder.id);
    attempt(folder, info);
    const after = readCacheOrigin(folder);
    Assert.equal(after.mask, cacheClientMask, name + " is native authority");
    Assert.greater(
      after.revision,
      before.revision,
      name + " records its attempt"
    );
    Assert.equal(
      folderDB.getFolderFlags(folder.id),
      flags,
      "No-op keeps native flags"
    );
    Assert.equal(after.generation, before.generation, "No renewed origin");
    const text = after.text;
    folder.msgDatabase.forceClosed();
    Assert.equal(folder.msgDatabase.dBFolderInfo.flags >>> 0, flags >>> 0);
    Assert.equal(
      readCacheOrigin(folder).text,
      text,
      "Ordinary DB reopen keeps intent"
    );
  }
});

add_task(async function test_prebindZeroIsRestrictiveBeforeFactoryCallbacks() {
  const contract = "@mozilla.org/mail/folder-factory;1?name=mailbox";
  const created = Array.from({ length: 8 }, () =>
    Cc[contract].createInstance(Ci.nsIMsgFolder)
  );
  let cid;
  let calls = 0;
  registerCleanupFunction(() => {
    if (cid) {
      MockRegistrar.unregister(cid);
    }
  });
  let parent;
  try {
    parent = await createObservedCacheChildren(
      "origin-prebind",
      ["Prebind"],
      () => {
        // A real factory hook is necessary to attempt a write BEFORE ID binding.
        // All returned objects are ordinary native folders, not JS/QI proxies.
        cid = MockRegistrar.register(contract, () => {
          Assert.less(calls, created.length);
          const child = created[calls++];
          Assert.equal(child.id, 0);
          child.flags = 0;
          return child;
        });
      }
    );
  } finally {
    if (cid) {
      MockRegistrar.unregister(cid);
      cid = null;
    }
  }
  Assert.greaterOrEqual(
    calls,
    2,
    "Real native child factories attempted zero before binding"
  );
  const child = parent.getChildNamed("Prebind");
  Assert.ok(created.includes(child));
  Assert.equal(child.flags, 0);
  Assert.equal(readCacheOrigin(child).mask, cacheClientMask);
});

add_task(async function test_reentrantChoicesKeepTheirAuthority() {
  const parent = await createObservedCacheChildren("origin-reentry", [
    "First",
    "Sibling",
  ]);
  const first = parent.getChildNamed("First");
  const sibling = parent.getChildNamed("Sibling");
  const info = first.msgDatabase.dBFolderInfo;
  Assert.equal(readCacheOrigin(first).mask, 0);
  Assert.equal(readCacheOrigin(sibling).mask, 0);
  let calls = 0;
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIFolderListener"]),
    onFolderIntPropertyChanged(folder, property) {
      if (folder != first || property != "FolderFlag" || calls) {
        return;
      }
      calls++;
      first.flags = 0;
      info.flags = 0;
      sibling.clearFlag(Ci.nsMsgFolderFlags.Favorite);
    },
  };
  first.AddFolderListener(listener);
  registerCleanupFunction(() => first.RemoveFolderListener(listener));
  first.setFlag(Ci.nsMsgFolderFlags.Favorite);
  Assert.equal(calls, 1, "The real synchronous flag callback ran");
  Assert.equal(
    first.flags,
    0,
    "The outer call did not republish an old warm word"
  );
  Assert.equal(folderDB.getFolderFlags(first.id), 0);
  Assert.equal(readCacheOrigin(first).mask, cacheClientMask);
  Assert.equal(readCacheOrigin(sibling).mask, cacheClientMask);
  Assert.equal(readCacheOrigin(first).pending, 0);
});

add_task(async function test_lockedFlagsRecordIntentBeforeTheirEarlyReturn() {
  const lane = PanoramaDelivery.expectedLane();
  const server = MailServices.accounts.createIncomingServer(
    "origin-locked",
    "origin-locked.invalid",
    "imap"
  );
  registerCleanupFunction(() =>
    MailServices.accounts.removeIncomingServer(server, false)
  );
  // The factory already initialized the root with the lane's store and path.
  // Retain that physical identity when creating the Inbox.
  const root = server.rootFolder.QueryInterface(Ci.nsIMsgImapMailFolder);
  PanoramaDelivery._assertStore(root, lane);
  // kImapInbox in nsImapCore.h. This is production client metadata creation;
  // the original IM whole cohort separately qualifies real LIST/LSUB traffic.
  root.createClientSubfolderInfo("INBOX", "/", 0x4000, false);
  const folder = root.getChildNamed("INBOX");
  Assert.ok(folder.getFlag(Ci.nsMsgFolderFlags.Inbox));
  const before = readCacheOrigin(folder);
  Assert.equal(
    before.mask,
    0,
    "Initial native box/default writes are classified"
  );
  for (const mutate of [
    () => folder.clearFlag(Ci.nsMsgFolderFlags.Inbox),
    () => folder.toggleFlag(Ci.nsMsgFolderFlags.Inbox),
  ]) {
    const previous = readCacheOrigin(folder);
    mutate();
    Assert.ok(
      folder.getFlag(Ci.nsMsgFolderFlags.Inbox),
      "The locked structural bit remains"
    );
    const after = readCacheOrigin(folder);
    Assert.equal(after.mask, cacheClientMask);
    Assert.greater(
      after.revision,
      previous.revision,
      "Locked no-op still records intent"
    );
  }
});

add_task(async function test_localDefaultsConsumeNativeInitialActionOnce() {
  const lane = PanoramaDelivery.expectedLane();
  const roles = [
    ["Inbox", Ci.nsMsgFolderFlags.Inbox],
    ["Sent", Ci.nsMsgFolderFlags.SentMail],
    ["Drafts", Ci.nsMsgFolderFlags.Drafts],
    ["Templates", Ci.nsMsgFolderFlags.Templates],
    ["Trash", Ci.nsMsgFolderFlags.Trash],
    ["Unsent Messages", Ci.nsMsgFolderFlags.Queue],
    ["Junk", Ci.nsMsgFolderFlags.Junk],
    ["Archives", Ci.nsMsgFolderFlags.Archive],
  ];
  const parent = await createObservedCacheChildren(
    "origin-local-defaults",
    [],
    undefined,
    roles.map(([name]) => name)
  );
  const root = parent.parent;
  const server = MailServices.accounts.getIncomingServer(
    "origin-local-defaults"
  );
  const localServer = server.QueryInterface(Ci.nsILocalMailIncomingServer);
  Assert.equal(
    readCacheOrigin(root).mask,
    0,
    "Child roles did not veto the root"
  );
  const snapshots = [];
  for (const [name, role] of roles) {
    const folder = root.getChildNamed(name);
    Assert.ok(folder, "The real store contains " + name);
    const origin = readCacheOrigin(folder);
    Assert.equal(origin.source, database.sourceId);
    Assert.equal(origin.id, folder.id);
    Assert.equal(origin.parent, root.id);
    Assert.equal(origin.name, name);
    Assert.equal(origin.birth, 1, "Native local discovery owns the phase");
    Assert.equal(origin.mask, 0, "Initial role is not public flag intent");
    Assert.equal(
      origin.used & 2,
      2,
      "The one local initial action was consumed"
    );
    Assert.equal(origin.pending, 0);
    Assert.equal(origin.generation, readCacheOrigin(root).generation);
    Assert.ok(folder.flags & role, "Public canonical role " + name);
    Assert.ok(folderDB.getFolderFlags(folder.id) & role);
    const body =
      lane.store == "maildir"
        ? PathUtils.join(folder.filePath.path, "cur", "retained")
        : folder.filePath.path;
    const bytes = await IOUtils.readUTF8(body);
    Assert.equal(bytes, "From sender@invalid\norigin control body\n");
    snapshots.push({ folder, origin, flags: folder.flags, body, bytes });
  }
  const ids = root.subFolders.map(folder => folder.id);
  localServer.createDefaultMailboxes();
  Assert.deepEqual(
    root.subFolders.map(folder => folder.id),
    ids
  );
  for (const { folder, origin, flags, body, bytes } of snapshots) {
    Assert.equal(readCacheOrigin(folder).text, origin.text, "No phase replay");
    Assert.equal(folder.flags, flags);
    Assert.equal(folderDB.getFolderFlags(folder.id), flags);
    Assert.strictEqual(
      MailServices.folderLookup.getFolderForURL(folder.URI),
      folder
    );
    Assert.equal(await IOUtils.readUTF8(body), bytes);
  }
  const trash = root.getChildNamed("Trash");
  const beforeZero = readCacheOrigin(trash);
  trash.flags = 0;
  const explicit = readCacheOrigin(trash);
  Assert.equal(explicit.mask, cacheClientMask);
  Assert.greater(explicit.revision, beforeZero.revision);
  localServer.createDefaultMailboxes();
  Assert.ok(root.subFolders.includes(trash));
  Assert.equal(
    trash.flags,
    0,
    "Repeated internal entry preserves explicit zero"
  );
  Assert.equal(folderDB.getFolderFlags(trash.id), 0);
  Assert.equal(readCacheOrigin(trash).text, explicit.text);
  localServer.setFlagsOnDefaultMailboxes();
  Assert.ok(
    trash.flags & Ci.nsMsgFolderFlags.Trash,
    "The public sweep stays explicit"
  );
  const publicSweep = readCacheOrigin(trash);
  Assert.equal(publicSweep.mask, cacheClientMask);
  Assert.greater(publicSweep.revision, explicit.revision);
  const flags = folderDB.getFolderFlags(trash.id);
  trash.msgDatabase.forceClosed();
  Assert.equal(trash.msgDatabase.dBFolderInfo.flags >>> 0, flags >>> 0);
  Assert.equal(readCacheOrigin(trash).text, publicSweep.text);
});

add_task(async function test_localDefaultNewAndPublicRowsRemainUnqualified() {
  const label = "origin-local-public";
  const parent = await createObservedCacheChildren(label, [], () => {
    Services.prefs.setBoolPref("mail.server." + label + ".hidden", true);
  });
  const root = parent.parent;
  const server = MailServices.accounts.getIncomingServer(label);
  Assert.equal(root.getChildNamed("Trash"), null);
  const id = folderDB.insertFolder(root.id, "Trash");
  let body = PathUtils.join(server.localPath.path, "Trash");
  if (PanoramaDelivery.expectedLane().store == "maildir") {
    await IOUtils.makeDirectory(PathUtils.join(body, "tmp"));
    body = PathUtils.join(body, "cur", "retained");
  }
  await IOUtils.makeDirectory(PathUtils.parent(body));
  await IOUtils.writeUTF8(
    body,
    "From sender@invalid\npublic native row body\n"
  );
  const trash = root.addSubfolder("Trash");
  Assert.equal(trash.id, id);
  Assert.equal(
    readCacheOrigin(trash),
    null,
    "A body does not promote a public row"
  );
  server.hidden = false;
  server.QueryInterface(Ci.nsILocalMailIncomingServer).createDefaultMailboxes();
  Assert.strictEqual(root.getChildNamed("Trash"), trash);
  Assert.equal(readCacheOrigin(trash), null);
  Assert.ok(trash.flags & Ci.nsMsgFolderFlags.Trash);
  Assert.ok(folderDB.getFolderFlags(id) & Ci.nsMsgFolderFlags.Trash);
  const queue = root.getChildNamed("Unsent Messages");
  Assert.ok(queue, "The normal store created the missing default");
  Assert.ok(
    queue.flags & Ci.nsMsgFolderFlags.Queue,
    "Creation forwards its role"
  );
  Assert.ok(folderDB.getFolderFlags(queue.id) & Ci.nsMsgFolderFlags.Queue);
  Assert.equal(
    readCacheOrigin(queue),
    null,
    "Public creation is not native birth proof"
  );
  Assert.ok(await IOUtils.exists(queue.filePath.path));
  Assert.equal(
    await IOUtils.readUTF8(body),
    "From sender@invalid\npublic native row body\n"
  );
  Assert.strictEqual(
    MailServices.folderLookup.getFolderForURL(trash.URI),
    trash
  );
});

add_task(async function test_feedsNamesKeepTheirOrdinaryRoles() {
  const lane = PanoramaDelivery.expectedLane();
  const names = ["Drafts", "Archives", "Sent", "Templates", "Junk"];
  const roleMask =
    Ci.nsMsgFolderFlags.SentMail |
    Ci.nsMsgFolderFlags.Drafts |
    Ci.nsMsgFolderFlags.Templates |
    Ci.nsMsgFolderFlags.Junk |
    Ci.nsMsgFolderFlags.Archive;
  const parent = await createObservedCacheChildren(
    "origin-feeds-cold",
    [],
    undefined,
    names,
    "rss"
  );
  const coldRoot = parent.parent;
  const publicParent = await createObservedCacheChildren(
    "origin-feeds-public",
    [],
    undefined,
    [],
    "rss"
  );
  const publicRoot = publicParent.parent;
  const localRoot = publicRoot.QueryInterface(Ci.nsIMsgLocalMailFolder);
  for (const name of names) {
    const folder = localRoot.createLocalSubfolder(name);
    Assert.equal(
      readCacheOrigin(folder),
      null,
      "Public creation has no origin"
    );
  }
  for (const root of [coldRoot, publicRoot]) {
    Assert.equal(root.server.type, "rss");
    Assert.equal(root.server.localStoreType, "mailbox");
    PanoramaDelivery._assertStore(root, lane);
    const snapshots = [];
    for (const name of names) {
      const folder = root.getChildNamed(name);
      Assert.ok(folder, "The native Feeds root contains " + name);
      Assert.equal(folder.parent, root);
      Assert.equal(folderDB.getFolderParent(folder.id), root.id);
      const expectedMailFlag = root == coldRoot ? 0 : Ci.nsMsgFolderFlags.Mail;
      Assert.equal(
        folder.flags & Ci.nsMsgFolderFlags.Mail,
        expectedMailFlag,
        "Public creation sets Mail; cold discovery keeps its native baseline"
      );
      Assert.equal(
        folderDB.getFolderFlags(folder.id) & Ci.nsMsgFolderFlags.Mail,
        expectedMailFlag,
        "The native row retains its discovery or creation baseline"
      );
      Assert.equal(
        folder.flags & roleMask,
        0,
        "A Feeds name does not grant a mail special-use role"
      );
      Assert.equal(folderDB.getFolderFlags(folder.id) & roleMask, 0);
      const origin = readCacheOrigin(folder);
      if (root == coldRoot) {
        Assert.ok(origin, "Cold store discovery has native origin");
        Assert.equal(origin.mask, 0, "Discovery is not public flag intent");
      } else {
        Assert.equal(origin, null, "Public rows stay unqualified");
      }
      snapshots.push({ folder, flags: folder.flags });
    }
    root.server
      .QueryInterface(Ci.nsILocalMailIncomingServer)
      .setFlagsOnDefaultMailboxes();
    const trash = root.getChildNamed("Trash");
    Assert.ok(trash.flags & Ci.nsMsgFolderFlags.Trash, "Feeds keeps its Trash");
    Assert.ok(folderDB.getFolderFlags(trash.id) & Ci.nsMsgFolderFlags.Trash);
    for (const { folder, flags } of snapshots) {
      Assert.equal(
        folder.flags,
        flags,
        "The Feeds sweep leaves this row alone"
      );
      Assert.equal(folderDB.getFolderFlags(folder.id), flags);
      folder.msgDatabase.forceClosed();
      Assert.equal(folder.msgDatabase.dBFolderInfo.flags >>> 0, flags >>> 0);
      Assert.strictEqual(
        MailServices.folderLookup.getFolderForURL(folder.URI),
        folder
      );
    }
  }
});
