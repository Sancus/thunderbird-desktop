/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

let rootFolder;

add_setup(function () {
  Services.prefs.setCharPref(
    "mail.server.default.storeContractID",
    Services.prefs.getCharPref("mail.serverDefaultStoreContractID")
  );
  const account = MailServices.accounts.createLocalMailAccount();
  rootFolder = account.incomingServer.rootFolder;
  rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  Assert.equal(account.incomingServer.msgStore.storeType, "maildir");
  Assert.equal(rootFolder.msgStore.storeType, "maildir");
  const databaseService = Cc[
    "@mozilla.org/msgDatabase/msgDBService;1"
  ].getService(Ci.nsIMsgDBService);
  Assert.equal(
    "nsIDatabaseCore" in Ci && databaseService instanceof Ci.nsIDatabaseCore,
    Services.prefs.getBoolPref("mail.panorama.enabled", false)
  );
});

add_task(function test_folder_not_reused_after_rename() {
  const folderName = "FolderToRename";
  const folder = rootFolder.createLocalSubfolder(folderName);
  const oldURI = folder.URI;

  folder.rename("RenamedFolder", null);
  Assert.equal(folder.parent, null, "renamed folder should be detached");

  const recreated = rootFolder.createLocalSubfolder(folderName);
  Assert.notEqual(
    recreated,
    folder,
    "recreated folder should be a fresh object"
  );
  Assert.equal(
    MailServices.folderLookup.getFolderForURL(oldURI),
    recreated,
    "lookup should return the recreated folder"
  );
});

add_task(function test_folder_not_reused_after_delete() {
  const folderName = "FolderToDelete";
  const folder = rootFolder.createLocalSubfolder(folderName);
  const oldURI = folder.URI;

  rootFolder.propagateDelete(folder, true);
  Assert.equal(folder.parent, null, "deleted folder should be detached");

  const recreated = rootFolder.createLocalSubfolder(folderName);
  Assert.notEqual(
    recreated,
    folder,
    "recreating the old URI should create a fresh folder object"
  );
  Assert.equal(
    MailServices.folderLookup.getFolderForURL(oldURI),
    recreated,
    "lookup should return the recreated folder"
  );
});

add_task(function test_empty_trash_preserves_folder_object() {
  let trashFolder = rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Trash);
  if (!trashFolder) {
    trashFolder = rootFolder.createLocalSubfolder("Trash");
    trashFolder.setFlag(Ci.nsMsgFolderFlags.Trash);
  }
  const trashURI = trashFolder.URI;
  trashFolder.createSubfolder("FolderInTrash", null);

  trashFolder.emptyTrash(null);

  Assert.equal(
    rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Trash),
    trashFolder,
    "emptying maildir Trash should preserve its folder object"
  );
  Assert.equal(
    MailServices.folderLookup.getFolderForURL(trashURI),
    trashFolder,
    "lookup should still return the original Trash folder"
  );
});

/**
 * Create a real local Trash with the selected provider and restore store prefs.
 *
 * @param {string} storeType - The mbox or maildir provider.
 * @param {Function} run - Receives the root, Trash and actual native service.
 * @returns {Promise<void>} Completes the callback and restores account prefs.
 */
async function withTrashStore(storeType, run) {
  // The original reuse tasks have finished with their local-folders account.
  if (rootFolder) {
    MailServices.accounts.removeAccount(
      MailServices.accounts.findAccountForServer(rootFolder.server)
    );
    rootFolder = null;
  }
  const names = [
    "mail.serverDefaultStoreContractID",
    "mail.server.default.storeContractID",
  ];
  const prefs = names.map(name => ({
    name,
    hadValue: Services.prefs.prefHasUserValue(name),
    value: Services.prefs.getCharPref(name),
  }));
  const contract =
    storeType === "mbox"
      ? "@mozilla.org/msgstore/berkeleystore;1"
      : "@mozilla.org/msgstore/maildirstore;1";
  for (const name of names) {
    Services.prefs.setCharPref(name, contract);
  }
  let account;
  try {
    account = MailServices.accounts.createLocalMailAccount();
    const root = account.incomingServer.rootFolder.QueryInterface(
      Ci.nsIMsgLocalMailFolder
    );
    const trash = (
      root.getFolderWithFlags(Ci.nsMsgFolderFlags.Trash) ||
      root.createLocalSubfolder("Trash")
    ).QueryInterface(Ci.nsIMsgLocalMailFolder);
    trash.setFlag(Ci.nsMsgFolderFlags.Trash);
    const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    );
    const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
    Assert.equal(
      "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
      native
    );
    Assert.equal(account.incomingServer.msgStore.storeType, storeType);
    Assert.equal(trash.msgStore.storeType, storeType);
    await run(
      root,
      trash,
      native ? service.QueryInterface(Ci.nsIDatabaseCore) : null
    );
  } finally {
    if (account) {
      MailServices.accounts.removeAccount(account);
    }
    for (const { name, hadValue, value } of prefs) {
      if (hadValue) {
        Services.prefs.setCharPref(name, value);
      } else {
        Services.prefs.clearUserPref(name);
      }
    }
  }
}

/**
 * Read exact body files and their provider names without using message metadata.
 *
 * @param {nsIMsgFolder} folder - A real local folder.
 * @returns {Promise<Array<[string, Uint8Array]>>} Names and exact file bytes.
 */
async function trashBodyFiles(folder) {
  if (folder.msgStore.storeType === "mbox") {
    return [
      [folder.filePath.leafName, await IOUtils.read(folder.filePath.path)],
    ];
  }
  const files = await IOUtils.getChildren(
    PathUtils.join(folder.filePath.path, "cur")
  );
  return Promise.all(
    files
      .sort()
      .map(async path => [PathUtils.filename(path), await IOUtils.read(path)])
  );
}

/**
 * Populate Trash and its descendants through the actual local delivery path.
 *
 * @param {nsIMsgLocalMailFolder} root - The local account root.
 * @param {nsIMsgLocalMailFolder} trash - The canonical Trash.
 * @returns {object} Physical source identity, retired headers and child folders.
 */
function populateTrash(root, trash) {
  const raw =
    "From: sender@example.invalid\r\nSubject: Empty Trash body\r\nMessage-ID: <empty-trash@example.invalid>\r\n\r\nExact retained body.\r\n";
  const source = root
    .createLocalSubfolder("source")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const sourceHeader = source.addMessage(raw);
  const headers = [
    trash.addMessage(raw),
    trash.addMessage(raw.replace("Exact retained", "Second retained")),
  ];
  const child = trash
    .createLocalSubfolder("child")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const grandchild = child
    .createLocalSubfolder("grandchild")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  child.addMessage(raw);
  grandchild.addMessage(raw);
  return { source, sourceHeader, headers, child, grandchild };
}

/**
 * Empty real nested Trash and retain its canonical folder and an unrelated body.
 *
 * @param {string} storeType - The mbox or maildir provider.
 */
async function checkCanonicalTrash(storeType) {
  await withTrashStore(storeType, async (root, trash, core) => {
    const { source, sourceHeader, headers, child, grandchild } = populateTrash(
      root,
      trash
    );
    const sourceKey = sourceHeader.messageKey;
    const sourceToken = sourceHeader.storeToken;
    const sourceBody = mailTestUtils.loadMessageToString(source, sourceHeader);
    const originalSourceBytes = await trashBodyFiles(source);
    const uri = trash.URI;
    const id = core ? trash.id : null;
    const path = trash.filePath.path;
    const retiredKeys = headers.map(header => header.messageKey);
    const deleted = [];
    const added = [];
    const listener = {
      folderDeleted(folder) {
        deleted.push(folder);
      },
      folderAdded(folder) {
        added.push(folder);
      },
    };
    MailServices.mfn.addListener(
      listener,
      Ci.nsIMsgFolderNotificationService.folderDeleted |
        Ci.nsIMsgFolderNotificationService.folderAdded
    );
    try {
      trash.emptyTrash(null);
    } finally {
      MailServices.mfn.removeListener(listener);
    }
    Assert.strictEqual(
      root.getFolderWithFlags(Ci.nsMsgFolderFlags.Trash),
      trash
    );
    Assert.strictEqual(MailServices.folderLookup.getFolderForURL(uri), trash);
    Assert.strictEqual(trash.parent, root);
    Assert.equal(trash.URI, uri);
    Assert.equal(trash.filePath.path, path);
    if (core) {
      Assert.equal(trash.id, id);
      Assert.ok(!deleted.includes(trash));
      Assert.ok(!added.includes(trash));
    }
    Assert.equal(trash.getTotalMessages(false), 0);
    Assert.equal(trash.msgDatabase.dBFolderInfo.numMessages, 0);
    Assert.equal(trash.expungedBytes, 0);
    Assert.deepEqual(trash.subFolders, []);
    for (const key of retiredKeys) {
      Assert.ok(!trash.msgDatabase.containsKey(key));
    }
    Assert.equal(child.parent, null);
    Assert.equal(grandchild.parent, null);
    Assert.ok(!child.filePath.exists());
    Assert.ok(!grandchild.filePath.exists());
    const bodies = await trashBodyFiles(trash);
    Assert.deepEqual(
      bodies,
      storeType === "mbox" ? [[trash.filePath.leafName, new Uint8Array()]] : []
    );
    Assert.equal(sourceHeader.messageKey, sourceKey);
    Assert.equal(sourceHeader.storeToken, sourceToken);
    Assert.equal(
      mailTestUtils.loadMessageToString(source, sourceHeader),
      sourceBody
    );
    Assert.deepEqual(await trashBodyFiles(source), originalSourceBytes);
    trash.emptyTrash(null);
    Assert.strictEqual(root.getChildNamed("Trash"), trash);
  });
}

/**
 * Reject metadata retirement failure before any Trash body or child is removed.
 *
 * @param {string} storeType - The mbox or maildir provider.
 */
async function checkTrashRemovalFailure(storeType) {
  await withTrashStore(storeType, async (root, trash, core) => {
    const { headers, child, grandchild } = populateTrash(root, trash);
    const bytes = await trashBodyFiles(trash);
    const childBytes = await trashBodyFiles(child);
    const grandchildBytes = await trashBodyFiles(grandchild);
    const keys = headers.map(header => header.messageKey);
    const tokens = headers.map(header => header.storeToken);
    const connection = core.connectionForTests;
    connection.executeSimpleSQL(
      `CREATE TEMP TRIGGER fail_empty_trash BEFORE DELETE ON main.messages WHEN OLD.id=${keys[0]} BEGIN SELECT RAISE(ABORT, 'Trash row retirement failed'); END`
    );
    try {
      Assert.throws(
        () => trash.emptyTrash(null),
        error => error.result === Cr.NS_ERROR_STORAGE_CONSTRAINT
      );
      Assert.deepEqual(trash.msgDatabase.listAllKeys(), keys);
      Assert.deepEqual(
        headers.map(header => header.storeToken),
        tokens
      );
      Assert.equal(trash.expungedBytes, 0);
      Assert.strictEqual(trash.parent, root);
      Assert.strictEqual(child.parent, trash);
      Assert.strictEqual(grandchild.parent, child);
      Assert.deepEqual(await trashBodyFiles(trash), bytes);
      Assert.deepEqual(await trashBodyFiles(child), childBytes);
      Assert.deepEqual(await trashBodyFiles(grandchild), grandchildBytes);
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER temp.fail_empty_trash");
    }
    trash.emptyTrash(null);
    Assert.equal(trash.getTotalMessages(true), 0);
  });
}

/**
 * Refuse to delete an issued provider write and keep its exact stream usable.
 *
 * @param {string} storeType - The mbox or maildir provider.
 */
async function checkTrashUnfinishedWrite(storeType) {
  await withTrashStore(storeType, async (_root, trash) => {
    const store = trash.msgStore;
    const stream = store.getNewMsgOutputStream(trash);
    const raw =
      "From: pending@example.invalid\r\nSubject: Pending write\r\n\r\nPending exact bytes.\r\n";
    let finishAttempted = false;
    try {
      stream.write(raw, raw.length);
      stream.flush();
      const bytes = await trashBodyFiles(trash);
      let pending;
      if (storeType === "maildir") {
        const files = await IOUtils.getChildren(
          PathUtils.join(trash.filePath.path, "tmp")
        );
        Assert.equal(files.length, 1);
        pending = [files[0], await IOUtils.read(files[0])];
      }
      Assert.throws(
        () => trash.emptyTrash(null),
        error => error.result === Cr.NS_ERROR_IN_PROGRESS
      );
      Assert.deepEqual(await trashBodyFiles(trash), bytes);
      if (pending) {
        Assert.deepEqual(
          await IOUtils.getChildren(PathUtils.join(trash.filePath.path, "tmp")),
          [pending[0]]
        );
        Assert.deepEqual(await IOUtils.read(pending[0]), pending[1]);
      }
      const tail = "Still owned.\r\n";
      Assert.equal(stream.write(tail, tail.length), tail.length);
      finishAttempted = true;
      const token = store.finishNewMessage(trash, stream);
      Assert.equal(typeof token, "string");
      Assert.notEqual(token, "");
      const reader = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
        Ci.nsIScriptableInputStream
      );
      reader.init(store.getMsgInputStream(trash, token, 0));
      let actual = "";
      try {
        let chunk;
        while ((chunk = reader.read(4096))) {
          actual += chunk;
        }
      } finally {
        reader.close();
      }
      Assert.equal(actual, raw + tail);
      trash.emptyTrash(null);
      Assert.equal(trash.getTotalMessages(false), 0);
    } finally {
      if (!finishAttempted) {
        store.discardNewMessage(trash, stream);
      }
    }
  });
}

/**
 * Preserve old and newly delivered body bytes when a close callback adds a row.
 *
 * @param {string} storeType - The mbox or maildir provider.
 * @param {boolean} inChild - Publish into a child instead of canonical Trash.
 */
async function checkTrashLatePublication(storeType, inChild) {
  await withTrashStore(storeType, async (root, trash) => {
    const { child } = populateTrash(root, trash);
    const target = inChild ? child : trash;
    const parent = inChild ? trash : root;
    const original = await trashBodyFiles(target);
    const db = target.msgDatabase;
    const raw =
      "From: late@example.invalid\r\nSubject: Delivery while closing\r\nMessage-ID: <late-trash@example.invalid>\r\n\r\nLate exact bytes.\r\n";
    let header;
    let deliveryError;
    let calls = 0;
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
      onAnnouncerGoingAway() {
        calls++;
        try {
          header = target.addMessage(raw);
        } catch (error) {
          deliveryError = error;
        }
      },
    };
    db.addListener(listener);
    try {
      let failure;
      try {
        trash.emptyTrash(null);
      } catch (error) {
        failure = error;
      }
      Assert.equal(calls, 1);
      Assert.equal(deliveryError, undefined);
      Assert.ok(header);
      Assert.equal(failure?.result, Cr.NS_ERROR_NOT_AVAILABLE);
      Assert.strictEqual(target.parent, parent);
      Assert.strictEqual(
        MailServices.folderLookup.getFolderForURL(target.URI),
        target
      );
      Assert.ok(target.msgDatabase.containsKey(header.messageKey));
      Assert.equal(mailTestUtils.loadMessageToString(target, header), raw);
      const after = await trashBodyFiles(target);
      for (const [name, bytes] of original) {
        const found = after.find(([fileName]) => fileName === name);
        Assert.ok(found);
        Assert.deepEqual(
          storeType === "mbox" ? found[1].slice(0, bytes.length) : found[1],
          bytes
        );
      }
      Assert.strictEqual(root.getChildNamed("Trash"), trash);
      if (inChild) {
        // A failed scoped EmptyTrash must not guard a later ordinary deletion.
        target.deleteSelf(null);
        Assert.equal(target.parent, null);
        Assert.ok(!target.filePath.exists());
        Assert.strictEqual(root.getChildNamed("Trash"), trash);
      }
    } finally {
      db.removeListener(listener);
    }
  });
}

add_task(async function test_emptyTrashCanonicalMbox() {
  await checkCanonicalTrash("mbox");
});
add_task(async function test_emptyTrashCanonicalMaildir() {
  await checkCanonicalTrash("maildir");
});
if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_emptyTrashRemovalFailureMbox() {
    await checkTrashRemovalFailure("mbox");
  });
  add_task(async function test_emptyTrashRemovalFailureMaildir() {
    await checkTrashRemovalFailure("maildir");
  });
  add_task(async function test_emptyTrashUnfinishedWriteMbox() {
    await checkTrashUnfinishedWrite("mbox");
  });
  add_task(async function test_emptyTrashUnfinishedWriteMaildir() {
    await checkTrashUnfinishedWrite("maildir");
  });
  add_task(async function test_emptyTrashLatePublicationMbox() {
    await checkTrashLatePublication("mbox", false);
  });
  add_task(async function test_emptyTrashLatePublicationMaildir() {
    await checkTrashLatePublication("maildir", false);
  });
  add_task(async function test_emptyTrashLateChildPublicationMbox() {
    await checkTrashLatePublication("mbox", true);
  });
  add_task(async function test_emptyTrashLateChildPublicationMaildir() {
    await checkTrashLatePublication("maildir", true);
  });
}

/**
 * Keep ordinary permanent deletion of nonempty Trash children independent of
 * the scoped empty-contents requirement used by canonical EmptyTrash.
 *
 * @param {string} storeType - The mbox or maildir provider.
 */
async function checkPermanentTrashChildDeletion(storeType) {
  await withTrashStore(storeType, async (root, trash, core) => {
    const { source, sourceHeader, child, grandchild } = populateTrash(
      root,
      trash
    );
    const sourceKey = sourceHeader.messageKey;
    const sourceToken = sourceHeader.storeToken;
    const sourceBody = mailTestUtils.loadMessageToString(source, sourceHeader);
    const sourceFiles = await trashBodyFiles(source);
    const trashKeys = trash.msgDatabase.listAllKeys();
    const trashFiles = await trashBodyFiles(trash);
    const childName = child.name;
    const childURI = child.URI;
    const childId = core ? child.id : null;
    const grandchildId = core ? grandchild.id : null;
    Assert.greater(child.getTotalMessages(false), 0);
    Assert.greater(grandchild.getTotalMessages(false), 0);

    child.deleteSelf(null);
    Assert.equal(child.parent, null);
    Assert.equal(grandchild.parent, null);
    Assert.ok(!child.filePath.exists());
    Assert.ok(!grandchild.filePath.exists());
    Assert.ok(!trash.subFolders.includes(child));
    Assert.strictEqual(root.getChildNamed("Trash"), trash);
    Assert.deepEqual(trash.msgDatabase.listAllKeys(), trashKeys);
    Assert.deepEqual(await trashBodyFiles(trash), trashFiles);
    if (core) {
      const statement = core.connectionForTests.createStatement(
        "SELECT id FROM folders WHERE id IN (:child, :grandchild)"
      );
      try {
        statement.params.child = childId;
        statement.params.grandchild = grandchildId;
        Assert.ok(
          !statement.executeStep(),
          "Deleted physical folder rows retire"
        );
      } finally {
        statement.finalize();
      }
    }
    const replacement = trash.createLocalSubfolder(childName);
    Assert.notEqual(replacement, child);
    Assert.strictEqual(
      MailServices.folderLookup.getFolderForURL(childURI),
      replacement
    );
    if (core) {
      Assert.notEqual(replacement.id, childId);
    }
    const retained = source.msgDatabase.getMsgHdrForKey(sourceKey);
    Assert.equal(retained.storeToken, sourceToken);
    Assert.equal(
      mailTestUtils.loadMessageToString(source, retained),
      sourceBody
    );
    Assert.deepEqual(await trashBodyFiles(source), sourceFiles);
  });
}

add_task(async function test_deleteNonemptyTrashChildMbox() {
  await checkPermanentTrashChildDeletion("mbox");
});
add_task(async function test_deleteNonemptyTrashChildMaildir() {
  await checkPermanentTrashChildDeletion("maildir");
});

/**
 * A failed provider removal returns its first error and keeps later bodies.
 * This tests the store-only API, not SQL/body deletion settlement.
 */
add_task(async function test_maildirDeleteFailureKeepsRemainingBodies() {
  await withTrashStore("maildir", async root => {
    const folder = root.createLocalSubfolder("provider-removal");
    const store = folder.msgStore;
    Assert.equal(store.storeType, "maildir");
    const messages = [
      "Subject: Obstructed removal\r\n\r\nFirst exact body.\r\n",
      "Subject: Later removal\r\n\r\nLater exact body.\r\n",
    ];
    const tokens = [];
    for (const message of messages) {
      const stream = store.getNewMsgOutputStream(folder);
      stream.write(message, message.length);
      tokens.push(store.finishNewMessage(folder, stream));
    }
    const first = PathUtils.join(folder.filePath.path, "cur", tokens[0]);
    const later = PathUtils.join(folder.filePath.path, "cur", tokens[1]);
    const saved = PathUtils.join(folder.filePath.path, "retained-body");
    await IOUtils.move(first, saved, { noOverwrite: true });
    await IOUtils.makeDirectory(first);
    const blocker = PathUtils.join(first, "owned-blocker");
    await IOUtils.writeUTF8(blocker, "Keep this obstruction.");
    try {
      Assert.throws(
        () =>
          store.deleteStoreMessages(folder, [
            "",
            "absent-body",
            tokens[0],
            tokens[1],
          ]),
        error => error.result === Cr.NS_ERROR_FILE_DIR_NOT_EMPTY
      );
      Assert.equal(await IOUtils.readUTF8(saved), messages[0]);
      Assert.equal(await IOUtils.readUTF8(later), messages[1]);
      Assert.equal(await IOUtils.readUTF8(blocker), "Keep this obstruction.");
    } finally {
      await IOUtils.remove(blocker);
      await IOUtils.remove(first);
      await IOUtils.move(saved, first, { noOverwrite: true });
    }
    // Empty and missing tokens retain their existing successful no-op meaning.
    store.deleteStoreMessages(folder, ["", "absent-body"]);
    Assert.equal(await IOUtils.readUTF8(first), messages[0]);
    Assert.equal(await IOUtils.readUTF8(later), messages[1]);
    store.deleteStoreMessages(folder, tokens);
    Assert.ok(!(await IOUtils.exists(first)));
    Assert.ok(!(await IOUtils.exists(later)));
  });
});

/**
 * A first provider failure keeps rows and reports the actual deletion result.
 * This does not promise rollback after successful removal or a later SQL error.
 */
add_task(async function test_maildirFolderDeleteFailureKeepsRows() {
  await withTrashStore("maildir", async root => {
    const folder = root
      .createLocalSubfolder("checked-folder-removal")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const raw = [
      "Subject: First retained row\r\n\r\nFirst exact row body.\r\n",
      "Subject: Later retained row\r\n\r\nLater exact row body.\r\n",
    ];
    const headers = raw.map(message => folder.addMessage(message));
    const keys = headers.map(header => header.messageKey);
    const tokens = headers.map(header => header.storeToken);
    const sizes = headers.map(header => header.messageSize);
    const flags = headers.map(header => header.flags);
    const first = PathUtils.join(folder.filePath.path, "cur", tokens[0]);
    const later = PathUtils.join(folder.filePath.path, "cur", tokens[1]);
    const saved = PathUtils.join(folder.filePath.path, "retained-row-body");
    await IOUtils.move(first, saved, { noOverwrite: true });
    await IOUtils.makeDirectory(first);
    const blocker = PathUtils.join(first, "owned-blocker");
    await IOUtils.writeUTF8(blocker, "Retain this child.");
    let starts = 0;
    const stops = [];
    const listener = new PromiseTestUtils.PromiseCopyListener({
      onStartCopy() {
        starts++;
      },
      onStopCopy(status) {
        stops.push(status);
      },
    });
    try {
      Assert.throws(
        () =>
          folder.deleteMessages(headers, null, true, false, listener, false),
        error => error.result === Cr.NS_ERROR_FILE_DIR_NOT_EMPTY
      );
      await Assert.rejects(
        listener.promise,
        error => Number(error.message) === Cr.NS_ERROR_FILE_DIR_NOT_EMPTY
      );
      Assert.equal(starts, 1);
      Assert.deepEqual(stops, [Cr.NS_ERROR_FILE_DIR_NOT_EMPTY]);
      Assert.deepEqual(folder.msgDatabase.listAllKeys(), keys);
      Assert.equal(await IOUtils.readUTF8(saved), raw[0]);
      Assert.equal(await IOUtils.readUTF8(later), raw[1]);
      Assert.equal(await IOUtils.readUTF8(blocker), "Retain this child.");
    } finally {
      await IOUtils.remove(blocker);
      await IOUtils.remove(first);
      await IOUtils.move(saved, first, { noOverwrite: true });
    }
    for (let i = 0; i < keys.length; i++) {
      const retained = folder.msgDatabase.getMsgHdrForKey(keys[i]);
      Assert.equal(retained.storeToken, tokens[i]);
      Assert.equal(retained.messageSize, sizes[i]);
      Assert.equal(retained.flags, flags[i]);
      Assert.equal(mailTestUtils.loadMessageToString(folder, retained), raw[i]);
    }
    Assert.equal(folder.getTotalMessages(false), 2);
    const retryStops = [];
    const retried = new PromiseTestUtils.PromiseCopyListener({
      onStopCopy(status) {
        retryStops.push(status);
      },
    });
    folder.deleteMessages(headers, null, true, false, retried, false);
    await retried.promise;
    Assert.deepEqual(retryStops, [Cr.NS_OK]);
    Assert.deepEqual(folder.msgDatabase.listAllKeys(), []);
    Assert.equal(folder.getTotalMessages(false), 0);
    Assert.ok(!(await IOUtils.exists(first)));
    Assert.ok(!(await IOUtils.exists(later)));
  });
});

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_nativeMaildirFastCopyDeclinesWithoutMutation() {
    await withTrashStore("maildir", async root => {
      const source = root
        .createLocalSubfolder("fast-copy-source")
        .QueryInterface(Ci.nsIMsgLocalMailFolder);
      const destination = root
        .createLocalSubfolder("fast-copy-destination")
        .QueryInterface(Ci.nsIMsgLocalMailFolder);
      Assert.equal(source.msgStore.storeType, "maildir");
      Assert.equal(destination.msgStore.storeType, "maildir");
      const raw =
        "From: sender@example.invalid\r\n" +
        "Subject: Fast copy refusal\r\n" +
        "Message-ID: <fast-copy-source@example.invalid>\r\n\r\n" +
        "Exact source bytes stay owned.\r\n";
      const header = source.addMessage(raw);
      header.setStringProperty("fastCopyProperty", "unchanged source value");
      const existing = destination.addMessage(
        raw.replace("fast-copy-source@", "fast-copy-destination@")
      );
      const sourceKey = header.messageKey;
      const sourceToken = header.storeToken;
      const destinationKey = existing.messageKey;
      const destinationToken = existing.storeToken;
      const sourceFlags = header.flags;
      const destinationFlags = existing.flags;
      const sourceSize = header.messageSize;
      const destinationSize = existing.messageSize;
      const sourceFiles = await trashBodyFiles(source);
      const destinationFiles = await trashBodyFiles(destination);
      const sourceTemp = PathUtils.join(source.filePath.path, "tmp");
      const destinationTemp = PathUtils.join(destination.filePath.path, "tmp");
      Assert.deepEqual(await IOUtils.getChildren(sourceTemp), []);
      Assert.deepEqual(await IOUtils.getChildren(destinationTemp), []);
      for (const isMove of [false, true]) {
        const copiedHeaders = {};
        const undoAction = {};
        Assert.equal(
          destination.msgStore.copyMessages(
            isMove,
            [header],
            destination,
            copiedHeaders,
            undoAction
          ),
          false,
          "The native store leaves the real copy to the folder fallback"
        );
        Assert.deepEqual(copiedHeaders.value, []);
        Assert.equal(undoAction.value, null);
        Assert.deepEqual(source.msgDatabase.listAllKeys(), [sourceKey]);
        Assert.deepEqual(destination.msgDatabase.listAllKeys(), [
          destinationKey,
        ]);
        const retained = source.GetMessageHeader(sourceKey);
        Assert.equal(retained.folder, source);
        Assert.equal(retained.storeToken, sourceToken);
        Assert.equal(retained.messageSize, sourceSize);
        Assert.equal(retained.flags, sourceFlags);
        Assert.equal(
          retained.getStringProperty("fastCopyProperty"),
          "unchanged source value"
        );
        Assert.equal(mailTestUtils.loadMessageToString(source, retained), raw);
        const untouched = destination.GetMessageHeader(destinationKey);
        Assert.equal(untouched.folder, destination);
        Assert.equal(untouched.storeToken, destinationToken);
        Assert.equal(untouched.messageSize, destinationSize);
        Assert.equal(untouched.flags, destinationFlags);
        Assert.equal(
          mailTestUtils.loadMessageToString(destination, untouched),
          raw.replace("fast-copy-source@", "fast-copy-destination@")
        );
        Assert.deepEqual(await trashBodyFiles(source), sourceFiles);
        Assert.deepEqual(await trashBodyFiles(destination), destinationFiles);
        Assert.deepEqual(await IOUtils.getChildren(sourceTemp), []);
        Assert.deepEqual(await IOUtils.getChildren(destinationTemp), []);
        Assert.ok(!source.locked);
        Assert.ok(!destination.locked);
      }
    });
  });
}

if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
  add_task(async function test_maildirFinishFailureKeepsOwnedIdentity() {
    await withTrashStore("maildir", async root => {
      const folder = root
        .createLocalSubfolder("failed-finish")
        .QueryInterface(Ci.nsIMsgLocalMailFolder);
      const other = root
        .createLocalSubfolder("independent-finish")
        .QueryInterface(Ci.nsIMsgLocalMailFolder);
      const store = folder.msgStore;
      const raw =
        "Subject: Existing body\r\n\r\nRetain the original bytes.\r\n";
      const resident = folder.addMessage(raw);
      const key = resident.messageKey;
      const token = resident.storeToken;
      const flags = resident.flags;
      const size = resident.messageSize;
      const originalFiles = await trashBodyFiles(folder);
      const pending =
        "Subject: Failed rename\r\n\r\nRetain the unfinished bytes.\r\n";
      const stream = store.getNewMsgOutputStream(folder);
      const independent = store.getNewMsgOutputStream(other);
      try {
        stream.write(pending, pending.length);
        stream.flush();
        const tmp = PathUtils.join(folder.filePath.path, "tmp");
        const ownedFiles = await IOUtils.getChildren(tmp);
        Assert.equal(ownedFiles.length, 1);
        const cur = PathUtils.join(folder.filePath.path, "cur");
        const saved = PathUtils.join(
          folder.filePath.path,
          "cur-before-failure"
        );
        await IOUtils.move(cur, saved, { noOverwrite: true });
        const obstruction = "This is not a destination directory.";
        try {
          // MoveTo requires a directory parent on both Unix and Windows.
          await IOUtils.writeUTF8(cur, obstruction);
          Assert.throws(
            () => store.finishNewMessage(folder, stream),
            error => error.result == Cr.NS_ERROR_FILE_DESTINATION_NOT_DIR
          );
        } finally {
          if (await IOUtils.exists(cur)) {
            Assert.equal(
              await IOUtils.readUTF8(cur),
              obstruction,
              "Only the fixture's known obstruction may be removed"
            );
            await IOUtils.remove(cur);
          }
          await IOUtils.move(saved, cur, { noOverwrite: true });
        }
        // Restoring the directory must not retry an uncertain failed rename.
        Assert.throws(
          () => store.finishNewMessage(folder, stream),
          error => error.result == Cr.NS_ERROR_FILE_DESTINATION_NOT_DIR
        );
        Assert.throws(
          () => store.getNewMsgOutputStream(folder),
          error => error.result == Cr.NS_ERROR_FILE_DESTINATION_NOT_DIR
        );
        Assert.throws(
          () => store.discardNewMessage(folder, stream),
          error => error.result == Cr.NS_ERROR_FILE_DESTINATION_NOT_DIR,
          "Discard must not delete possibly settled cur content"
        );
        Assert.throws(
          () => store.finishNewMessage(folder, independent),
          error => error.result == Cr.NS_ERROR_ILLEGAL_VALUE
        );
        Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
        const retained = folder.GetMessageHeader(key);
        Assert.equal(retained.storeToken, token);
        Assert.equal(retained.flags, flags);
        Assert.equal(retained.messageSize, size);
        Assert.equal(mailTestUtils.loadMessageToString(folder, retained), raw);
        Assert.deepEqual(await trashBodyFiles(folder), originalFiles);
        Assert.deepEqual(await IOUtils.getChildren(tmp), ownedFiles);
        Assert.equal(await IOUtils.readUTF8(ownedFiles[0]), pending);
        // The error belongs to this folder/write, not every provider write.
        const independentRaw =
          "Subject: Independent\r\n\r\nA complete body.\r\n";
        independent.write(independentRaw, independentRaw.length);
        const independentToken = store.finishNewMessage(other, independent);
        Assert.notEqual(independentToken, "");
        Assert.equal(
          await IOUtils.readUTF8(
            PathUtils.join(other.filePath.path, "cur", independentToken)
          ),
          independentRaw
        );
        Assert.deepEqual(await trashBodyFiles(folder), originalFiles);
        Assert.equal(await IOUtils.readUTF8(ownedFiles[0]), pending);
      } finally {
        stream.close();
        independent.close();
      }
    });
  });

  add_task(async function test_maildirFinishAlreadyCurReturnsOwnedToken() {
    await withTrashStore("maildir", async root => {
      const folder = root
        .createLocalSubfolder("already-cur-finish")
        .QueryInterface(Ci.nsIMsgLocalMailFolder);
      const other = root
        .createLocalSubfolder("foreign-finish")
        .QueryInterface(Ci.nsIMsgLocalMailFolder);
      const store = folder.msgStore;
      const stream = store.getNewMsgOutputStream(folder);
      const foreign = store.getNewMsgOutputStream(other);
      try {
        const raw =
          "Subject: Filter-settled body\r\n\r\nExact finished body.\r\n";
        stream.write(raw, raw.length);
        stream.close();
        const tmp = PathUtils.join(folder.filePath.path, "tmp");
        const pending = await IOUtils.getChildren(tmp);
        Assert.equal(pending.length, 1);
        const filename = PathUtils.filename(pending[0]);
        const cur = PathUtils.join(folder.filePath.path, "cur", filename);
        // A real filter may settle this owned file before Finish runs.
        await IOUtils.move(pending[0], cur, { noOverwrite: true });
        Assert.throws(
          () => store.finishNewMessage(folder, foreign),
          error => error.result == Cr.NS_ERROR_ILLEGAL_VALUE
        );
        Assert.throws(
          () => store.discardNewMessage(folder, foreign),
          error => error.result == Cr.NS_ERROR_ILLEGAL_VALUE
        );
        Assert.equal(await IOUtils.readUTF8(cur), raw);
        const token = store.finishNewMessage(folder, stream);
        Assert.equal(token, filename);
        Assert.notEqual(token, "");
        Assert.equal(await IOUtils.readUTF8(cur), raw);
        Assert.deepEqual(await IOUtils.getChildren(tmp), []);
        const foreignRaw =
          "Subject: Other folder\r\n\r\nIndependent bytes.\r\n";
        foreign.write(foreignRaw, foreignRaw.length);
        const foreignToken = store.finishNewMessage(other, foreign);
        Assert.notEqual(foreignToken, "");
        Assert.equal(
          await IOUtils.readUTF8(
            PathUtils.join(other.filePath.path, "cur", foreignToken)
          ),
          foreignRaw
        );
        Assert.equal(await IOUtils.readUTF8(cur), raw);
        // This is provider settlement, not implicit header publication.
        Assert.deepEqual(folder.msgDatabase.listAllKeys(), []);
        Assert.deepEqual(other.msgDatabase.listAllKeys(), []);
      } finally {
        stream.close();
        foreign.close();
      }
    });
  });
}

/**
 * Keep a preempted copy's write error and the provider's newer owned stream.
 *
 * @param {boolean} isMove - Request a move instead of a copy.
 * @returns {Promise<void>} Completes the request and discards only our new write.
 */
async function checkPreemptedCopy(isMove) {
  await withTrashStore("maildir", async root => {
    const destination = root.createLocalSubfolder(
      `preempted-${isMove ? "move" : "copy"}`
    );
    const contract = "@mozilla.org/msgstore/berkeleystore;1";
    Services.prefs.setCharPref("mail.serverDefaultStoreContractID", contract);
    Services.prefs.setCharPref("mail.server.default.storeContractID", contract);
    const server = MailServices.accounts.createIncomingServer(
      "preempted-source",
      "preempted-source.invalid",
      "none"
    );
    server.setStringValue("storeContractID", contract);
    const account = MailServices.accounts.createAccount();
    account.incomingServer = server;
    let replacement;
    try {
      const source = server.rootMsgFolder
        .QueryInterface(Ci.nsIMsgLocalMailFolder)
        .createLocalSubfolder("source")
        .QueryInterface(Ci.nsIMsgLocalMailFolder);
      Assert.equal(server.msgStore.storeType, "mbox");
      Assert.equal(source.msgStore.storeType, "mbox");
      Assert.equal(destination.msgStore.storeType, "maildir");
      const raw =
        "From: sender@example.invalid\r\n" +
        "Message-ID: <preempted-copy@example.invalid>\r\n" +
        "Subject: Retain source on preempted copy\r\n\r\n" +
        "Exact retained source body.\r\n";
      const header = source.addMessage(raw);
      source.markMessagesRead([header], true);
      header.setStringProperty("preemptionNote", "Keep this exact value");
      const original = {
        key: header.messageKey,
        token: header.storeToken,
        size: header.messageSize,
        flags: header.flags,
        bytes: await IOUtils.read(source.filePath.path),
      };
      const replacementBody = "Exact independent provider write.\r\n";
      let starts = 0;
      let stops = 0;
      let progress = 0;
      let written;
      let injectionError;
      let resolve;
      const done = new Promise(callback => {
        resolve = callback;
      });
      const listener = {
        QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
        onStartCopy() {
          starts++;
        },
        onProgress() {
          if (++progress != 1) {
            return;
          }
          try {
            // The provider's existing per-folder contract closes the old
            // stream before issuing this new one. The copy must not discard it.
            replacement =
              destination.msgStore.getNewMsgOutputStream(destination);
            written = replacement.write(
              replacementBody,
              replacementBody.length
            );
            replacement.flush();
          } catch (error) {
            injectionError = error;
          }
        },
        setMessageKey() {},
        getMessageId() {
          return "";
        },
        onStopCopy(status) {
          stops++;
          resolve(status);
        },
      };
      MailServices.copy.copyMessages(
        source,
        [header],
        destination,
        isMove,
        listener,
        null,
        false
      );
      const status = await done;
      Assert.equal(injectionError, undefined);
      Assert.ok(replacement);
      Assert.equal(written, replacementBody.length);
      Assert.equal(starts, 1);
      Assert.equal(stops, 1);
      Assert.equal(progress, 1);
      Assert.equal(status, Cr.NS_BASE_STREAM_CLOSED);
      Assert.deepEqual(source.msgDatabase.listAllKeys(), [original.key]);
      const retained = source.msgDatabase.getMsgHdrForKey(original.key);
      Assert.equal(retained.messageId, "preempted-copy@example.invalid");
      Assert.equal(retained.storeToken, original.token);
      Assert.equal(retained.messageSize, original.size);
      Assert.equal(retained.flags, original.flags);
      Assert.ok(retained.properties.includes("preemptionNote"));
      Assert.equal(
        retained.getStringProperty("preemptionNote"),
        "Keep this exact value"
      );
      Assert.equal(mailTestUtils.loadMessageToString(source, retained), raw);
      Assert.deepEqual(
        await IOUtils.read(source.filePath.path),
        original.bytes
      );
      Assert.deepEqual(destination.msgDatabase.listAllKeys(), []);
      Assert.deepEqual(
        await IOUtils.getChildren(
          PathUtils.join(destination.filePath.path, "cur")
        ),
        []
      );
      const pending = await IOUtils.getChildren(
        PathUtils.join(destination.filePath.path, "tmp")
      );
      Assert.equal(pending.length, 1);
      Assert.equal(await IOUtils.readUTF8(pending[0]), replacementBody);
      replacement.streamStatus();
      Assert.ok(!destination.locked);
      Assert.ok(!source.locked);
    } finally {
      if (replacement) {
        destination.msgStore.discardNewMessage(destination, replacement);
      }
      MailServices.accounts.removeAccount(account);
    }
  });
}

add_task(async function test_copyPreemptedWrite() {
  await checkPreemptedCopy(false);
});
add_task(async function test_movePreemptedWrite() {
  await checkPreemptedCopy(true);
});

/**
 * Keep a failed synchronous file copy from settling a later real request.
 *
 * @param {boolean} queuedMove - Move the next source instead of copying it.
 * @returns {Promise<void>} Waits for the blocked and independent requests.
 */
async function checkFileFinishContinuation(queuedMove) {
  await withTrashStore("maildir", async root => {
    const label = `file-finish-${queuedMove ? "move" : "copy"}`;
    const destination = root.createLocalSubfolder(label);
    const independent = root.createLocalSubfolder(`${label}-independent`);
    const contract = "@mozilla.org/msgstore/berkeleystore;1";
    Services.prefs.setCharPref("mail.serverDefaultStoreContractID", contract);
    Services.prefs.setCharPref("mail.server.default.storeContractID", contract);
    const server = MailServices.accounts.createIncomingServer(
      label,
      `${label}.invalid`,
      "none"
    );
    server.setStringValue("storeContractID", contract);
    const account = MailServices.accounts.createAccount();
    account.incomingServer = server;
    const cur = destination.filePath.clone();
    cur.append("cur");
    const held = destination.filePath.clone();
    held.append("cur-before-file-finish");
    let heldCur = false;
    const restore = () => {
      if (heldCur) {
        if (!cur.isFile() || cur.fileSize != 0) {
          throw new Error("Refusing to remove unexpected destination content");
        }
        cur.remove(false);
        held.moveTo(destination.filePath, "cur");
        heldCur = false;
      }
    };
    try {
      const source = server.rootMsgFolder
        .QueryInterface(Ci.nsIMsgLocalMailFolder)
        .createLocalSubfolder("source")
        .QueryInterface(Ci.nsIMsgLocalMailFolder);
      Assert.equal(source.msgStore.storeType, "mbox");
      Assert.equal(server.msgStore.storeType, "mbox");
      Assert.equal(destination.msgStore.storeType, "maildir");
      Assert.equal(independent.msgStore.storeType, "maildir");
      const raw =
        "From: sender@example.invalid\r\n" +
        `Message-ID: <${label}-source@example.invalid>\r\n` +
        "Subject: Retain queued source\r\n\r\nExact queued source body.\r\n";
      const header = source.addMessage(raw);
      header.setStringProperty("fileFinishNote", "Exact queued property");
      const original = {
        key: header.messageKey,
        token: header.storeToken,
        size: header.messageSize,
        flags: header.flags,
        bytes: await IOUtils.read(source.filePath.path),
      };
      const fileRaw =
        "X-Mozilla-Status: 0001\r\n" +
        "X-Mozilla-Status2: 00000000\r\n" +
        "X-Mozilla-Keys: \r\n" +
        "From: file@example.invalid\r\n" +
        `Message-ID: <${label}-file@example.invalid>\r\n` +
        "Subject: Failed file Finish\r\n\r\nExact failed file body.\r\n";
      const file = do_get_profile();
      file.append(`${label}.eml`);
      await IOUtils.writeUTF8(file.path, fileRaw);
      Assert.ok(cur.isDirectory());
      Assert.ok(!held.exists());
      const starts = [0, 0, 0];
      const progress = [0, 0, 0];
      const statuses = [[], [], []];
      let injected = false;
      let resolve;
      let reject;
      const done = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const listeners = starts.map((unused, index) => ({
        QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
        onStartCopy() {
          starts[index]++;
        },
        onProgress() {
          progress[index]++;
          if (index == 0 && !injected) {
            try {
              cur.clone().moveTo(held.parent, held.leafName);
              heldCur = true;
              cur.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
              injected = true;
            } catch (error) {
              reject(error);
            }
          }
        },
        setMessageKey() {},
        getMessageId() {
          return "";
        },
        onStopCopy(status) {
          statuses[index].push(status);
          try {
            if (index == 0) {
              restore();
              // The provider still retains the failed Finish. This next
              // same-folder request must fail once with that actual error.
              MailServices.copy.copyMessages(
                source,
                [header],
                destination,
                queuedMove,
                listeners[1],
                null,
                false
              );
            } else if (index == 1) {
              // A blocked folder must not strand an independent valid copy.
              MailServices.copy.copyMessages(
                source,
                [header],
                independent,
                false,
                listeners[2],
                null,
                false
              );
            } else {
              resolve();
            }
          } catch (error) {
            reject(error);
          }
        },
      }));
      let fileResult = Cr.NS_OK;
      try {
        MailServices.copy.copyFileMessage(
          file,
          destination,
          null,
          false,
          0,
          "",
          listeners[0],
          null
        );
      } catch (error) {
        fileResult = error.result;
      }
      await done;
      Assert.ok(injected);
      Assert.equal(fileResult, Cr.NS_ERROR_FILE_DESTINATION_NOT_DIR);
      Assert.deepEqual(starts, [1, 1, 1]);
      Assert.deepEqual(progress, [1, 0, 1]);
      Assert.deepEqual(statuses, [
        [Cr.NS_ERROR_FILE_DESTINATION_NOT_DIR],
        [Cr.NS_ERROR_FILE_DESTINATION_NOT_DIR],
        [Cr.NS_OK],
      ]);
      Assert.equal(await IOUtils.readUTF8(file.path), fileRaw);
      Assert.deepEqual(source.msgDatabase.listAllKeys(), [original.key]);
      const retained = source.msgDatabase.getMsgHdrForKey(original.key);
      Assert.equal(retained.messageId, `${label}-source@example.invalid`);
      Assert.equal(retained.storeToken, original.token);
      Assert.equal(retained.messageSize, original.size);
      Assert.equal(retained.flags, original.flags);
      Assert.equal(
        retained.getStringProperty("fileFinishNote"),
        "Exact queued property"
      );
      Assert.equal(mailTestUtils.loadMessageToString(source, retained), raw);
      Assert.deepEqual(
        await IOUtils.read(source.filePath.path),
        original.bytes
      );
      Assert.deepEqual(destination.msgDatabase.listAllKeys(), []);
      Assert.deepEqual(await IOUtils.getChildren(cur.path), []);
      const pending = await IOUtils.getChildren(
        PathUtils.join(destination.filePath.path, "tmp")
      );
      Assert.equal(pending.length, 1);
      Assert.equal(await IOUtils.readUTF8(pending[0]), fileRaw);
      const completed = [...independent.messages];
      Assert.equal(completed.length, 1);
      Assert.equal(completed[0].messageId, retained.messageId);
      Assert.equal(completed[0].folder, independent);
      Assert.notEqual(completed[0].storeToken, "");
      Assert.equal(
        completed[0].getStringProperty("fileFinishNote"),
        "Exact queued property"
      );
      Assert.equal(
        mailTestUtils.loadMessageToString(independent, completed[0]),
        raw
      );
      Assert.ok(!destination.locked);
      Assert.ok(!independent.locked);
      Assert.ok(!source.locked);
    } finally {
      restore();
      MailServices.accounts.removeAccount(account);
    }
  });
}

add_task(async function test_fileFinishQueuedCopy() {
  await checkFileFinishContinuation(false);
});
add_task(async function test_fileFinishQueuedMove() {
  await checkFileFinishContinuation(true);
});

/** Preserve a possibly settled body and its issued identity during preemption. */
add_task(async function test_preemptionRetainsUncertainWrite() {
  await withTrashStore("maildir", async root => {
    const folder = root.createLocalSubfolder("uncertain-preemption");
    const store = folder.msgStore;
    const raw =
      "From: sender@example.invalid\r\n" +
      "Message-ID: <uncertain-preemption@example.invalid>\r\n" +
      "Subject: Retain possibly settled bytes\r\n\r\nExact retained body.\r\n";
    const issued = store.getNewMsgOutputStream(folder);
    Assert.equal(issued.write(raw, raw.length), raw.length);
    issued.close();
    const tmp = PathUtils.join(folder.filePath.path, "tmp");
    const pending = await IOUtils.getChildren(tmp);
    Assert.equal(pending.length, 1);
    const oldFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    oldFile.initWithPath(pending[0]);
    const token = oldFile.leafName;
    const cur = folder.filePath.clone();
    cur.append("cur");
    // This is a real file move, not provider Finish. A preempting writer may
    // neither forget the issued write nor delete a possibly settled cur body.
    oldFile.moveTo(cur, token);
    Assert.equal(await IOUtils.readUTF8(oldFile.path), raw);
    let replacement;
    try {
      Assert.throws(
        () => {
          replacement = store.getNewMsgOutputStream(folder);
        },
        error => error.result == Cr.NS_ERROR_FILE_NOT_FOUND
      );
      Assert.throws(
        () => store.getNewMsgOutputStream(folder),
        error => error.result == Cr.NS_ERROR_FILE_NOT_FOUND
      );
      Assert.throws(
        () => store.finishNewMessage(folder, issued),
        error => error.result == Cr.NS_ERROR_FILE_NOT_FOUND
      );
      Assert.throws(
        () => store.discardNewMessage(folder, issued),
        error => error.result == Cr.NS_ERROR_FILE_NOT_FOUND
      );
      Assert.equal(replacement, undefined);
      Assert.deepEqual(await IOUtils.getChildren(tmp), []);
      Assert.deepEqual(await IOUtils.getChildren(cur.path), [oldFile.path]);
      Assert.equal(await IOUtils.readUTF8(oldFile.path), raw);
      Assert.deepEqual(folder.msgDatabase.listAllKeys(), []);
    } finally {
      // Needed only for the old-source negative: dispose the actually returned
      // new stream without touching the original file now under cur.
      if (replacement) {
        store.discardNewMessage(folder, replacement);
      }
    }
  });
});
