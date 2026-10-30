/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// This tests that renaming non-ASCII name folder works, and that the settings
// of a renamed folder are not lost.

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

// The flags a user can turn on for a single folder in its properties dialog.
const settingFlags = {
  Offline: Ci.nsMsgFolderFlags.Offline,
  CheckNew: Ci.nsMsgFolderFlags.CheckNew,
  Favorite: Ci.nsMsgFolderFlags.Favorite,
};

const panorama = Services.prefs.getBoolPref("mail.panorama.enabled", false);

add_setup(async function () {
  const contract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  Services.prefs.setCharPref("mail.server.default.storeContractID", contract);
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
  setupIMAPPump();
  registerCleanupFunction(() => {
    if (IMAPPump.incomingServer) {
      teardownIMAPPump();
    }
  });
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.equal(
    "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
    panorama,
    "the requested database backend is active"
  );
  const store = {
    "@mozilla.org/msgstore/berkeleystore;1": "mbox",
    "@mozilla.org/msgstore/maildirstore;1": "maildir",
  }[contract];
  Assert.ok(store, "the requested store is supported");
  Assert.equal(IMAPPump.incomingServer.msgStore.storeType, store);
  const discovery = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(
    IMAPPump.incomingServer.rootFolder,
    discovery,
    null
  );
  await discovery.promise;
  IMAPPump.inbox = IMAPPump.incomingServer.rootFolder
    .getChildNamed("INBOX")
    .QueryInterface(Ci.nsIMsgImapMailFolder);
  const added = PromiseTestUtils.promiseFolderAdded("folder 1");
  IMAPPump.incomingServer.rootFolder.createSubfolder("folder 1", null);
  await added;

  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, listener);
  await listener.promise;
});

// Exercise a real server message before changing the native folder hierarchy.
// The fake server changes UIDVALIDITY on RENAME; local settlement must preserve
// the existing binding until a later SELECT reports that different epoch.
add_task(async function test_nativeRenameAndReparentKeepPhysicalMessage() {
  if (!panorama) {
    return;
  }

  const root = IMAPPump.incomingServer.rootFolder;
  let added = PromiseTestUtils.promiseFolderAdded("physical source");
  root.createSubfolder("physical source", null);
  const source = await added;
  const sourceImap = source.QueryInterface(Ci.nsIMsgImapMailFolder);
  const mailbox = IMAPPump.daemon.getMailbox("physical source");
  mailbox.uidvalidity = 7101;
  const messageFile = Services.io.newFileURI(
    do_get_file("../../../data/draft1")
  );
  mailbox.addMessage(new ImapMessage(messageFile.spec, 6101, []));
  mailbox.uidnext = 6102;
  const downloaded = new PromiseTestUtils.PromiseUrlListener();
  sourceImap.downloadAllForOffline(downloaded, null);
  await downloaded.promise;

  const [header, extra] = source.msgDatabase.enumerateMessages();
  Assert.ok(header, "the message was ingested from the server");
  Assert.equal(extra, undefined, "exactly one real message was ingested");
  Assert.equal(header.messageId, "4849BF7B.2030800@example.com");
  Assert.notEqual(
    header.messageKey,
    6101,
    "physical key is not the server UID"
  );
  Assert.equal(header.getUint32Property("uidOnServer"), 6101);
  Assert.ok(header.flags & Ci.nsMsgMessageFlags.Offline);
  Assert.equal(source.msgDatabase.dBFolderInfo.imapUidValidity, 7101);
  const key = header.messageKey;
  const id = source.id;
  const token = header.getStringProperty("storeToken");
  Assert.ok(token, "the downloaded body has a real store token");
  const bytes = readStoredMessage(source, token);
  Assert.ok(bytes.includes("Hello, did you receive my bugmail?"));

  // An issued store write is not covered by the folder semaphore. Refusal
  // must retain the writer so its owner can finish it once and retry normally.
  const store = source.msgStore;
  const issued = store.getNewMsgOutputStream(source);
  let finished = false;
  const pendingBody =
    "From: retained@example.invalid\r\nSubject: retained writer\r\n\r\nkept before\r\n";
  const suffix = "kept after refusal\r\n";
  try {
    issued.write(pendingBody, pendingBody.length);
    Assert.throws(
      () => MailServices.imap.renameLeaf(source, "busy target", null, null),
      error => error.result == Cr.NS_MSG_FOLDER_BUSY,
      "an issued provider write refuses before network or publication"
    );
    Assert.equal(source.parent, root);
    Assert.equal(source.id, id);
    Assert.equal(IMAPPump.daemon.getMailbox("busy target"), null);
    Assert.equal(readStoredMessage(source, token), bytes);
    issued.write(suffix, suffix.length);
    const issuedToken = store.finishNewMessage(source, issued);
    finished = true;
    Assert.equal(readStoredMessage(source, issuedToken), pendingBody + suffix);
    Assert.throws(
      () => store.finishNewMessage(source, issued),
      error => error.result == Cr.NS_ERROR_ILLEGAL_VALUE,
      "the refused operation did not finish the issued writer"
    );
  } finally {
    if (!finished) {
      store.discardNewMessage(source, issued);
    }
  }

  // A real destination obstruction is not a logical folder or permission to
  // replace bytes. Prepare must refuse before sending RENAME to the server.
  const obstructed = source.filePath.parent.clone();
  obstructed.append("collision target");
  await IOUtils.writeUTF8(obstructed.path, "retained obstruction");
  try {
    Assert.throws(
      () =>
        MailServices.imap.renameLeaf(source, "collision target", null, null),
      error => error.result == Cr.NS_ERROR_FILE_ALREADY_EXISTS,
      "a physical collision refuses before dispatch"
    );
    Assert.equal(
      await IOUtils.readUTF8(obstructed.path),
      "retained obstruction"
    );
    Assert.equal(IMAPPump.daemon.getMailbox("collision target"), null);
    Assert.equal(source.parent, root);
    Assert.equal(source.id, id);
    Assert.equal(source.msgDatabase.getMsgHdrForKey(key).messageKey, key);
    Assert.equal(readStoredMessage(source, token), bytes);
  } finally {
    await IOUtils.remove(obstructed.path);
  }

  added = PromiseTestUtils.promiseFolderAdded("kept child");
  source.createSubfolder("kept child", null);
  const originalChild = await added;
  const childMailbox = IMAPPump.daemon.getMailbox("physical source/kept child");
  childMailbox.uidvalidity = 7103;
  childMailbox.addMessage(new ImapMessage(messageFile.spec, 6103, []));
  childMailbox.uidnext = 6104;
  const childDownload = new PromiseTestUtils.PromiseUrlListener();
  originalChild
    .QueryInterface(Ci.nsIMsgImapMailFolder)
    .downloadAllForOffline(childDownload, null);
  await childDownload.promise;
  const [childHeader, childExtra] =
    originalChild.msgDatabase.enumerateMessages();
  Assert.ok(childHeader);
  Assert.equal(childExtra, undefined);
  Assert.notEqual(childHeader.messageKey, 6103);
  const childId = originalChild.id;
  const childKey = childHeader.messageKey;
  const childToken = childHeader.getStringProperty("storeToken");
  const childBytes = readStoredMessage(originalChild, childToken);
  Assert.ok(childBytes.includes("Hello, did you receive my bugmail?"));

  const originalChildPath = originalChild.filePath;
  const externalParent = do_get_tempdir();
  externalParent.append("external-imap-child");
  externalParent.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  originalChildPath.copyTo(externalParent, "kept child");
  const externalChild = externalParent.clone();
  externalChild.append("kept child");
  try {
    originalChild.filePath = externalChild;
    Assert.equal(readStoredMessage(originalChild, childToken), childBytes);
    Assert.throws(
      () =>
        MailServices.imap.renameLeaf(source, "external refused", null, null),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
      "a root-only plan cannot abandon a child's external effective body path"
    );
    Assert.equal(originalChild.filePath.path, externalChild.path);
    Assert.equal(originalChild.id, childId);
    Assert.equal(originalChild.parent, source);
    Assert.equal(
      originalChild.msgDatabase.getMsgHdrForKey(childKey).messageKey,
      childKey
    );
    Assert.equal(readStoredMessage(originalChild, childToken), childBytes);
    Assert.equal(source.parent, root);
    Assert.equal(source.id, id);
    Assert.equal(readStoredMessage(source, token), bytes);
    Assert.equal(IMAPPump.daemon.getMailbox("external refused"), null);
  } finally {
    originalChild.filePath = originalChildPath;
    externalParent.remove(true);
  }
  Assert.equal(readStoredMessage(originalChild, childToken), childBytes);
  Assert.equal(originalChild.filePath.path, originalChildPath.path);

  const renamedListener = new PromiseTestUtils.PromiseUrlListener();
  let renameCompletions = 0;
  const stopRename = renamedListener.OnStopRunningUrl.bind(renamedListener);
  renamedListener.OnStopRunningUrl = (url, status) => {
    renameCompletions++;
    stopRename(url, status);
  };
  MailServices.imap.renameLeaf(
    source,
    "physical renamed",
    renamedListener,
    null
  );
  await renamedListener.promise;

  const renamed = root.getChildNamed("physical renamed");
  const renamedURI = renamed.URI;
  Assert.equal(renameCompletions, 1, "rename completes exactly once");
  Assert.equal(source.parent, null, "the old wrapper is detached");
  Assert.equal(MailServices.folderLookup.getFolderForURL(source.URI), null);
  Assert.equal(MailServices.folderLookup.getFolderForURL(renamedURI), renamed);
  Assert.equal(renamed.id, id, "rename retains the physical folder row");
  Assert.equal(renamed.parent, root);
  Assert.equal(renamed.getTotalMessages(false), 1);
  const renamedHeader = renamed.msgDatabase.getMsgHdrForKey(key);
  Assert.equal(
    renamedHeader.messageKey,
    key,
    "rename retains the physical key"
  );
  Assert.equal(
    renamedHeader.folder,
    renamed,
    "header resolves the new wrapper"
  );
  Assert.equal(renamedHeader.getUint32Property("uidOnServer"), 6101);
  Assert.equal(renamed.msgDatabase.dBFolderInfo.imapUidValidity, 7101);
  Assert.equal(renamedHeader.getStringProperty("storeToken"), token);
  Assert.equal(
    readStoredMessage(renamed, token),
    bytes,
    "rename retains body bytes"
  );

  const renamedChild = renamed.getChildNamed("kept child");
  Assert.equal(originalChild.parent, null);
  Assert.equal(renamedChild.id, childId);
  Assert.equal(renamedChild.parent, renamed);
  Assert.equal(
    renamedChild.msgDatabase.getMsgHdrForKey(childKey).folder,
    renamedChild
  );
  Assert.equal(renamedChild.msgDatabase.dBFolderInfo.imapUidValidity, 7103);
  Assert.equal(
    renamedChild.msgDatabase
      .getMsgHdrForKey(childKey)
      .getUint32Property("uidOnServer"),
    6103
  );
  Assert.equal(
    renamedChild.msgDatabase
      .getMsgHdrForKey(childKey)
      .getStringProperty("storeToken"),
    childToken
  );
  Assert.equal(readStoredMessage(renamedChild, childToken), childBytes);

  added = PromiseTestUtils.promiseFolderAdded("physical destination");
  root.createSubfolder("physical destination", null);
  const destination = await added;
  const moveWrite = renamed.msgStore.getNewMsgOutputStream(renamed);
  let moveWriteFinished = false;
  try {
    const body = "From: move@example.invalid\r\n\r\nretained move writer\r\n";
    moveWrite.write(body, body.length);
    const refused = new PromiseTestUtils.PromiseCopyListener();
    let refusals = 0;
    const stopRefused = refused.onStopCopy.bind(refused);
    refused.onStopCopy = status => {
      refusals++;
      stopRefused(status);
    };
    const refusedResult = refused.promise.then(
      () => Cr.NS_OK,
      error => Number(error.message)
    );
    try {
      MailServices.copy.copyFolder(renamed, destination, true, refused, null);
    } catch (error) {
      Assert.equal(error.result, Cr.NS_MSG_FOLDER_BUSY);
    }
    Assert.equal(await refusedResult, Cr.NS_MSG_FOLDER_BUSY);
    Assert.equal(
      refusals,
      1,
      "a refused move completes its real copy request once"
    );
    Assert.equal(renamed.parent, root);
    Assert.equal(renamed.id, id);
    Assert.equal(readStoredMessage(renamed, token), bytes);
    const moveToken = renamed.msgStore.finishNewMessage(renamed, moveWrite);
    moveWriteFinished = true;
    Assert.equal(readStoredMessage(renamed, moveToken), body);
  } finally {
    if (!moveWriteFinished) {
      renamed.msgStore.discardNewMessage(renamed, moveWrite);
    }
  }
  // This real CopyService retry must succeed on the same destination after
  // refusal, so stale destination state cannot be hidden by a new wrapper.
  const copied = new PromiseTestUtils.PromiseCopyListener();
  let moveCompletions = 0;
  const stopCopy = copied.onStopCopy.bind(copied);
  copied.onStopCopy = status => {
    moveCompletions++;
    stopCopy(status);
  };
  MailServices.copy.copyFolder(renamed, destination, true, copied, null);
  // An unrelated raw URL has no captured relocation or copy-request identity.
  // Its error must not complete the real move still awaiting its server reply.
  const unrelatedUrl = Services.io.newURI(destination.URI);
  unrelatedUrl.QueryInterface(Ci.nsIImapUrl).imapAction =
    Ci.nsIImapUrl.nsImapMoveFolderHierarchy;
  unrelatedUrl.QueryInterface(Ci.nsIMsgMailNewsUrl).folder = destination;
  destination
    .QueryInterface(Ci.nsIUrlListener)
    .OnStopRunningUrl(unrelatedUrl, Cr.NS_ERROR_ABORT);
  Assert.equal(moveCompletions, 0, "an unrelated URL cannot finish this move");
  Assert.equal(renamed.parent, root);
  Assert.equal(readStoredMessage(renamed, token), bytes);
  await copied.promise;

  const moved = destination.getChildNamed("physical renamed");
  Assert.equal(moveCompletions, 1, "reparent completes exactly once");
  Assert.equal(renamed.parent, null, "the previous wrapper is detached");
  Assert.equal(MailServices.folderLookup.getFolderForURL(renamedURI), null);
  Assert.equal(MailServices.folderLookup.getFolderForURL(moved.URI), moved);
  Assert.equal(moved.id, id, "reparent retains the physical folder row");
  Assert.equal(moved.parent, destination);
  Assert.equal(moved.getTotalMessages(false), 1);
  const movedHeader = moved.msgDatabase.getMsgHdrForKey(key);
  Assert.equal(
    movedHeader.messageKey,
    key,
    "reparent retains the physical key"
  );
  Assert.equal(movedHeader.folder, moved);
  Assert.equal(movedHeader.getUint32Property("uidOnServer"), 6101);
  Assert.equal(moved.msgDatabase.dBFolderInfo.imapUidValidity, 7101);
  Assert.equal(movedHeader.getStringProperty("storeToken"), token);
  Assert.equal(
    readStoredMessage(moved, token),
    bytes,
    "reparent retains body bytes"
  );

  const movedChild = moved.getChildNamed("kept child");
  Assert.equal(renamedChild.parent, null);
  Assert.equal(movedChild.id, childId);
  Assert.equal(movedChild.parent, moved);
  Assert.equal(
    movedChild.msgDatabase.getMsgHdrForKey(childKey).folder,
    movedChild
  );
  Assert.equal(movedChild.msgDatabase.dBFolderInfo.imapUidValidity, 7103);
  Assert.equal(
    movedChild.msgDatabase
      .getMsgHdrForKey(childKey)
      .getUint32Property("uidOnServer"),
    6103
  );
  Assert.equal(
    movedChild.msgDatabase
      .getMsgHdrForKey(childKey)
      .getStringProperty("storeToken"),
    childToken
  );
  Assert.equal(readStoredMessage(movedChild, childToken), childBytes);

  const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  );
  Assert.equal(core.folderDB.getFolderParent(id), destination.id);
  Assert.equal(
    core.folderDB.getFolderChildNamed(root.id, "physical source"),
    0
  );
  Assert.equal(
    core.folderDB.getFolderChildNamed(root.id, "physical renamed"),
    0
  );
  Assert.equal(
    core.folderDB.getFolderChildNamed(destination.id, "physical renamed"),
    id
  );
});

/**
 * Read the bytes of a previously downloaded message directly from its store.
 *
 * @param {nsIMsgFolder} folder - Folder that owns the body.
 * @param {string} token - Body token returned by the real store.
 * @returns {string} The stored message bytes.
 */
function readStoredMessage(folder, token) {
  const stream = folder.msgStore.getMsgInputStream(folder, token, 0);
  const reader = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
    Ci.nsIScriptableInputStream
  );
  reader.init(stream);
  try {
    let bytes = "";
    while (reader.available()) {
      bytes += reader.read(reader.available());
    }
    return bytes;
  } finally {
    reader.close();
  }
}

// A server ACK does not authorize local publication after a captured epoch
// changed, or after native settlement fails and the physical move rolls back.
add_task(async function test_nativeRenameLocalFailureRetainsSource() {
  if (!panorama) {
    return;
  }
  const root = IMAPPump.incomingServer.rootFolder;
  const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  );
  const connection = core.connectionForTests;
  const proto = IMAP_RFC3501_handler.prototype;
  const originalRename = proto.RENAME;
  for (const [phase, uid, epoch, expected] of [
    ["epoch", 6301, 7301, Cr.NS_ERROR_NOT_AVAILABLE],
    ["commit", 6302, 7302, Cr.NS_ERROR_STORAGE_CONSTRAINT],
  ]) {
    const oldName = "retained " + phase;
    const newName = "refused " + phase;
    const added = PromiseTestUtils.promiseFolderAdded(oldName);
    root.createSubfolder(oldName, null);
    const source = await added;
    const imap = source.QueryInterface(Ci.nsIMsgImapMailFolder);
    const mailbox = IMAPPump.daemon.getMailbox(oldName);
    mailbox.uidvalidity = epoch;
    mailbox.addMessage(
      new ImapMessage(
        Services.io.newFileURI(do_get_file("../../../data/draft1")).spec,
        uid,
        []
      )
    );
    mailbox.uidnext = uid + 1;
    const downloaded = new PromiseTestUtils.PromiseUrlListener();
    imap.downloadAllForOffline(downloaded, null);
    await downloaded.promise;
    const [header, extra] = source.msgDatabase.enumerateMessages();
    Assert.ok(header);
    Assert.equal(extra, undefined);
    const key = header.messageKey;
    const id = source.id;
    Assert.notEqual(key, uid);
    const token = header.getStringProperty("storeToken");
    const bytes = readStoredMessage(source, token);
    const path = source.filePath.path;
    const renamed = [];
    const observer = {
      folderRenamed(oldFolder, fresh) {
        renamed.push([oldFolder, fresh]);
      },
    };
    MailServices.mfn.addListener(observer, MailServices.mfn.folderRenamed);
    let serverRenames = 0;
    let completions = 0;
    try {
      if (phase == "commit") {
        connection.executeSimpleSQL(
          "CREATE TEMP TRIGGER refuse_imap_settlement BEFORE UPDATE OF name,parent " +
            "ON folders WHEN OLD.id=" +
            id +
            " BEGIN SELECT RAISE(ABORT, 'IMAP settlement fault'); END"
        );
      }
      proto.RENAME = function (args) {
        const response = originalRename.call(this, args);
        if (args[0] == oldName && args[1] == newName) {
          Assert.ok(
            response.startsWith("OK"),
            "the actual server accepted RENAME"
          );
          serverRenames++;
          if (phase == "epoch") {
            source.msgDatabase.dBFolderInfo.imapUidValidity = epoch + 1000;
          }
        }
        return response;
      };
      const listener = new PromiseTestUtils.PromiseUrlListener();
      const stop = listener.OnStopRunningUrl.bind(listener);
      listener.OnStopRunningUrl = (url, status) => {
        completions++;
        stop(url, status);
      };
      const result = listener.promise.then(
        () => Cr.NS_OK,
        error => Number(error.message)
      );
      MailServices.imap.renameLeaf(source, newName, listener, null);
      Assert.equal(
        await result,
        expected,
        "the first local failure reaches the URL listener"
      );
      Assert.equal(serverRenames, 1);
      Assert.equal(completions, 1);
      Assert.equal(
        renamed.length,
        0,
        "no successful local rename was published"
      );
      Assert.equal(source.parent, root);
      Assert.equal(source.id, id);
      Assert.equal(source.filePath.path, path);
      Assert.equal(core.folderDB.getFolderName(id), oldName);
      Assert.equal(core.folderDB.getFolderChildNamed(root.id, newName), 0);
      Assert.equal(
        MailServices.folderLookup.getFolderForURL(source.URI),
        source
      );
      const retained = source.msgDatabase.getMsgHdrForKey(key);
      Assert.equal(retained.messageKey, key);
      Assert.equal(retained.folder, source);
      Assert.equal(retained.getStringProperty("storeToken"), token);
      Assert.equal(source.getTotalMessages(false), 1);
      Assert.equal(readStoredMessage(source, token), bytes);
      Assert.equal(
        source.msgDatabase.dBFolderInfo.imapUidValidity,
        phase == "epoch" ? epoch + 1000 : epoch
      );
      Assert.ok(
        IMAPPump.daemon.getMailbox(newName),
        "server ACK is distinct from failed local settlement"
      );
    } finally {
      proto.RENAME = originalRename;
      if (phase == "commit") {
        connection.executeSimpleSQL("DROP TRIGGER refuse_imap_settlement");
      }
      MailServices.mfn.removeListener(observer);
    }
  }
});

add_task(async function test_rename() {
  const rootFolder = IMAPPump.incomingServer.rootFolder;
  const targetFolder = rootFolder.getChildNamed("folder 1");
  const oldURI = targetFolder.URI;
  applySettings(targetFolder);
  if (panorama) {
    const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    );
    Assert.greater(
      targetFolder.id,
      0,
      "the actual native source has an identity"
    );
    Assert.equal(targetFolder.parent, rootFolder);
    Assert.equal(core.folderDB.getFolderParent(targetFolder.id), rootFolder.id);
    Assert.equal(core.folderDB.getFolderRoot(targetFolder.id), rootFolder.id);
    Assert.equal(core.folderDB.getFolderName(targetFolder.id), "folder 1");
    Assert.equal(
      targetFolder.QueryInterface(Ci.nsIMsgImapMailFolder).onlineName,
      "folder 1"
    );
    Assert.equal(targetFolder.hierarchyDelimiter, "/");
  }

  targetFolder.rename("folder \u00e1", null);

  IMAPPump.server.performTest("RENAME");
  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, listener);
  await listener.promise;

  const folder = rootFolder.getChildNamed("folder \u00e1");
  Assert.ok(folder.msgDatabase.summaryValid);
  Assert.equal("folder &AOE-", folder.filePath.leafName);
  Assert.equal("folder \u00e1", folder.name);

  // The folder is addressed by its encoded name, so the settings have to reach
  // it under that name and no summary file may appear under the decoded one.
  assertSettings(folder, "the folder renamed to a non-ASCII name");
  const decodedSummaryFile = folder.filePath.parent.clone();
  decodedSummaryFile.append("folder \u00e1.msf");
  Assert.ok(
    !decodedSummaryFile.exists(),
    "no summary file for a second folder"
  );

  Assert.equal(
    targetFolder.parent,
    null,
    "the folder object at the old URI should be detached"
  );
  const folderAdded = PromiseTestUtils.promiseFolderAdded("folder 1");
  rootFolder.createSubfolder("folder 1", null);
  const recreatedFolder = await folderAdded;
  Assert.notEqual(
    recreatedFolder,
    targetFolder,
    "recreating the old URI should create a fresh folder object"
  );
  Assert.equal(
    MailServices.folderLookup.getFolderForURL(oldURI),
    recreatedFolder,
    "lookup should return the recreated folder"
  );
});

// Renaming an IMAP folder replaces its database with an empty one, so
// everything the user configured on the folder has to be carried over.
add_task(async function test_renameKeepsSettings() {
  const rootFolder = IMAPPump.incomingServer.rootFolder;

  // A folder the user has configured.
  const folderAdded = PromiseTestUtils.promiseFolderAdded("with settings");
  rootFolder.createSubfolder("with settings", null);
  const folder = await folderAdded;
  applySettings(folder);

  // Rename it, which is what the properties dialog and the context menu do.
  folder.rename("renamed", null);
  IMAPPump.server.performTest("RENAME");

  // Let the rename settle before looking at the result.
  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, listener);
  await listener.promise;

  const renamedFolder = rootFolder.getChildNamed("renamed");
  Assert.ok(renamedFolder.msgDatabase.summaryValid, "the rename went through");
  assertSettings(renamedFolder, "the renamed folder");

  // The server hands out a new UIDVALIDITY for the renamed mailbox, which makes
  // the first sync of the folder replace the database once more.
  const syncListener = new PromiseTestUtils.PromiseUrlListener();
  renamedFolder
    .QueryInterface(Ci.nsIMsgImapMailFolder)
    .updateFolderWithListener(null, syncListener);
  await syncListener.promise;
  assertSettings(renamedFolder, "the renamed folder after its first sync");
});

// The rename writes retention settings, so make sure it doesn't hand its own
// to a folder that just follows the account.
add_task(async function test_renameKeepsFollowingTheAccount() {
  const rootFolder = IMAPPump.incomingServer.rootFolder;

  // A folder the user has not configured, so it follows the account.
  const folderAdded = PromiseTestUtils.promiseFolderAdded("without settings");
  rootFolder.createSubfolder("without settings", null);
  const folder = await folderAdded;

  folder.rename("renamed again", null);
  IMAPPump.server.performTest("RENAME");

  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, listener);
  await listener.promise;

  Assert.ok(
    rootFolder.getChildNamed("renamed again").retentionSettings
      .useServerDefaults,
    "the renamed folder has no retention settings of its own"
  );
});

// Moving an IMAP folder renames it on the server, so it loses its database the
// same way.
add_task(async function test_moveKeepsSettings() {
  const rootFolder = IMAPPump.incomingServer.rootFolder;

  // Somewhere to move to.
  let folderAdded = PromiseTestUtils.promiseFolderAdded("destination");
  rootFolder.createSubfolder("destination", null);
  const destination = await folderAdded;

  // A folder the user has configured.
  folderAdded = PromiseTestUtils.promiseFolderAdded("to move");
  rootFolder.createSubfolder("to move", null);
  const folder = await folderAdded;
  const oldURI = folder.URI;
  applySettings(folder);

  // Move it, which is what dragging it in the folder pane does.
  const copyListener = new PromiseTestUtils.PromiseCopyListener();
  MailServices.copy.copyFolder(folder, destination, true, copyListener, null);
  await copyListener.promise;

  assertSettings(destination.getChildNamed("to move"), "the moved folder");

  Assert.equal(
    folder.parent,
    null,
    "the folder object at the old URI should be detached"
  );
  folderAdded = PromiseTestUtils.promiseFolderAdded("to move");
  rootFolder.createSubfolder("to move", null);
  const recreatedFolder = await folderAdded;
  Assert.notEqual(
    recreatedFolder,
    folder,
    "recreating the old URI after a move should create a fresh folder object"
  );
  Assert.equal(
    MailServices.folderLookup.getFolderForURL(oldURI),
    recreatedFolder,
    "lookup should return the recreated folder"
  );
});

// Deleting a folder moves it to the trash, which is a rename as well. A folder
// on its way out must not get the settings back.
add_task(async function test_moveToTrashDropsSettings() {
  const rootFolder = IMAPPump.incomingServer.rootFolder;
  const trash = rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Trash);
  Assert.ok(trash, "the account has a trash folder");

  // A folder the user has configured.
  const folderAdded = PromiseTestUtils.promiseFolderAdded("to delete");
  rootFolder.createSubfolder("to delete", null);
  const folder = await folderAdded;
  applySettings(folder);

  // Delete it, which moves it to the trash.
  const copyListener = new PromiseTestUtils.PromiseCopyListener();
  MailServices.copy.copyFolder(folder, trash, true, copyListener, null);
  await copyListener.promise;

  const deletedFolder = trash.getChildNamed("to delete");
  Assert.ok(
    !(deletedFolder.flags & Ci.nsMsgFolderFlags.Favorite),
    "the deleted folder is no longer a favourite"
  );
  Assert.ok(
    !(deletedFolder.flags & Ci.nsMsgFolderFlags.CheckNew),
    "the deleted folder is no longer checked for new messages"
  );
});

// Renaming a folder recreates its subfolders under the new name, so they have
// to follow it, with online names that point at the new path on the server.
add_task(async function test_renameKeepsSubfolders() {
  const rootFolder = IMAPPump.incomingServer.rootFolder;

  // A folder with a subfolder.
  const parentAdded = PromiseTestUtils.promiseFolderAdded("parent to rename");
  rootFolder.createSubfolder("parent to rename", null);
  const parent = await parentAdded;

  const childAdded = PromiseTestUtils.promiseFolderAdded("child");
  parent.createSubfolder("child", null);
  await childAdded;

  parent.rename("renamed parent", null);
  IMAPPump.server.performTest("RENAME");

  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, listener);
  await listener.promise;

  const renamedParent = rootFolder.getChildNamed("renamed parent");
  Assert.ok(renamedParent, "the renamed folder exists");
  Assert.equal(parent.parent, null, "the old folder object is detached");

  const child = renamedParent
    .getChildNamed("child")
    .QueryInterface(Ci.nsIMsgImapMailFolder);
  Assert.equal(
    child.parent,
    renamedParent,
    "the subfolder moved with the renamed folder"
  );
  Assert.equal(
    child.onlineName,
    "renamed parent" + child.hierarchyDelimiter + "child",
    "the subfolder's online name points at the new path"
  );
});

/**
 * Give a folder the settings the tests check for. These are the settings a user
 * can make for a single folder, as opposed to the whole account.
 *
 * @param {nsIMsgFolder} folder
 */
function applySettings(folder) {
  for (const flag of Object.values(settingFlags)) {
    folder.setFlag(flag);
  }

  const retentionSettings = Cc[
    "@mozilla.org/msgDatabase/retentionSettings;1"
  ].createInstance(Ci.nsIMsgRetentionSettings);
  retentionSettings.useServerDefaults = false;
  retentionSettings.retainByPreference =
    Ci.nsIMsgRetentionSettings.nsMsgRetainByNumHeaders;
  retentionSettings.numHeadersToKeep = 42;
  retentionSettings.applyToFlaggedMessages = true;
  // Through the database, so the folder has to read them back the way it does
  // after a restart, instead of answering from memory.
  folder.msgDatabase.msgRetentionSettings = retentionSettings;

  // Where the user dragged the folder to in a manually sorted folder list.
  folder.userSortOrder = 7;
}

/**
 * Check the settings applied by applySettings, in the folder and in
 * its database. The renamed folder is a new object with a new database, so its
 * values can only come from the folder it was renamed from.
 *
 * @param {nsIMsgFolder} folder
 * @param {string} what - Names the folder in the assertion messages.
 */
function assertSettings(folder, what) {
  for (const [name, flag] of Object.entries(settingFlags)) {
    Assert.ok(folder.flags & flag, `${what} has the ${name} flag`);
    Assert.ok(
      folder.msgDatabase.dBFolderInfo.flags & flag,
      `${what} has the ${name} flag in its database`
    );
  }

  Assert.equal(folder.userSortOrder, 7, `${what} keeps its place in the list`);
  Assert.equal(
    folder.msgDatabase.dBFolderInfo.userSortOrder,
    7,
    `${what} has its place in the list in its database`
  );

  const retentionSettings = folder.retentionSettings;
  Assert.equal(
    retentionSettings.useServerDefaults,
    false,
    `${what} overrides the server retention settings`
  );
  Assert.equal(
    retentionSettings.retainByPreference,
    Ci.nsIMsgRetentionSettings.nsMsgRetainByNumHeaders,
    `${what} retains messages by number`
  );
  Assert.equal(
    retentionSettings.numHeadersToKeep,
    42,
    `${what} keeps 42 messages`
  );
  Assert.ok(
    retentionSettings.applyToFlaggedMessages,
    `${what} applies retention to starred messages`
  );
  // The folder answers from memory, so read the database row itself to see that
  // the settings were written down.
  Assert.equal(
    folder.msgDatabase.dBFolderInfo.getUint32Property("numHdrsToKeep", 0),
    42,
    `${what} has its retention settings in its database`
  );
}
