/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
const Reader = ChromeUtils.importESModule(
  "resource:///modules/panorama/MorkFolderImport.sys.mjs"
);
const Adapter = ChromeUtils.importESModule(
  "resource:///modules/panorama/MorkSnapshotAdapter.sys.mjs"
);
const { MigrationJournal } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationJournal.sys.mjs"
);
const Coordinator = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationCoordinator.sys.mjs"
);
const { createMigrationBackup } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationBackup.sys.mjs"
);

const DB_SERVICE = "@mozilla.org/msgDatabase/msgDBService;1";
const LEGACY_SERVICE = "{03223c50-1e88-45e8-ba1a-7ce792dc3fc3}";
const OP = Ci.nsIMsgOfflineImapOperation;
const NAMES = [
  "MigrationClassic",
  "MigrationExplicit",
  "MigrationCopyOne",
  "MigrationCopyTwo",
  "MigrationMove",
  "MigrationAppend",
];
let core,
  members,
  ledger,
  work,
  backup,
  lock,
  unit,
  entries,
  journal,
  journalPath;
let receipt, selectedProfile;
const inventories = new Map();

/**
 * Reads provider-finished bytes through the selected physical header.
 *
 * @param {nsIMsgFolder} folder - Actual owning folder.
 * @param {nsIMsgDBHdr} header - Actual returned physical header.
 * @returns {string} Stored RFC5322 bytes, without a second Finish call.
 */
function bodyBytes(folder, header) {
  const input = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
    Ci.nsIScriptableInputStream
  );
  input.init(folder.getMsgInputStream(header));
  let bytes = "";
  try {
    while (input.available()) {
      bytes += input.read(input.available());
    }
  } finally {
    input.close();
  }
  return bytes;
}

/**
 * Captures public header values before a real offline move removes its source.
 *
 * @param {nsIMsgDBHdr} header - Live native header, never passed to an MDB cast.
 * @returns {object} Actual parsed fields, UID presence and finished body bytes.
 */
function captureHeader(header) {
  const properties = [...header.properties];
  const result = {
    nativeKey: header.messageKey,
    uid: properties.includes("uidOnServer")
      ? header.getUint32Property("uidOnServer")
      : null,
    messageId: header.messageId,
    subject: header.subject,
    author: header.author,
    recipients: header.recipients,
    ccList: header.ccList,
    bccList: header.bccList,
    date: header.date,
    flags: header.flags,
    priority: header.priority,
    messageSize: header.messageSize,
    storeToken: header.storeToken,
    offlineMessageSize: header.offlineMessageSize,
    lineCount: header.lineCount,
    references: header.getStringProperty("references"),
    keywords: header.getStringProperty("keywords"),
    body: bodyBytes(header.folder, header),
  };
  Assert.ok(result.storeToken, "The actual provider finished a physical body");
  Assert.ok(result.flags & Ci.nsMsgMessageFlags.Offline);
  return result;
}

/**
 * Reads the complete public combined operation without changing its COPY tail.
 *
 * @param {nsIMsgOfflineImapOperation} operation - Persisted native or MDB row.
 * @returns {object} Values and ordered destinations returned by the real row.
 */
function captureOperation(operation) {
  try {
    const copies = [];
    for (let ordinal = 0; ; ordinal++) {
      Assert.less(ordinal, 16, "This finite fixture has a bounded COPY tail");
      try {
        copies.push(operation.getCopyDestination(ordinal));
      } catch (error) {
        Assert.ok(
          [Cr.NS_ERROR_ILLEGAL_VALUE, Cr.NS_ERROR_INVALID_ARG].includes(
            error.result
          ),
          "Only end-of-list terminates the typed COPY read"
        );
        break;
      }
    }
    return {
      messageKey: operation.messageKey,
      operation: operation.operation,
      flagOperation: operation.flagOperation,
      newFlags: operation.newFlags,
      srcMessageKey: operation.srcMessageKey,
      srcUid: operation.srcUid,
      sourceFolderURI: operation.sourceFolderURI,
      destinationFolderURI: operation.destinationFolderURI,
      keywordsToAdd: operation.keywordsToAdd,
      keywordsToRemove: operation.keywordsToRemove,
      msgSize: operation.msgSize,
      playingBack: operation.playingBack,
      copies,
    };
  } finally {
    // Do not retain the live row through an exception or caller frame.
    operation = null;
  }
}

/**
 * Waits for normal SELECT/FETCH completion and the actual folder epoch.
 *
 * @param {nsIMsgFolder} folder - Discovered IMAP server folder.
 * @returns {Promise<void>} Resolves after the real URL listener succeeds.
 */
async function selectFolder(folder) {
  const imapFolder = folder.QueryInterface(Ci.nsIMsgImapMailFolder);
  const listener = new PromiseTestUtils.PromiseUrlListener();
  imapFolder.updateFolderWithListener(null, listener);
  await listener.promise;
}

/**
 * Copies or moves through the ordinary application producer while offline.
 *
 * @param {nsIMsgDBHdr} header - Selected source physical message.
 * @param {nsIMsgFolder} destination - Actual destination folder.
 * @param {boolean} move - Whether the producer removes the local source.
 * @returns {Promise<nsIMsgDBHdr>} The listener-returned physical destination.
 */
async function offlineCopy(header, destination, move) {
  const listener = new PromiseTestUtils.PromiseCopyListener();
  MailServices.copy.copyMessages(
    header.folder,
    [header],
    destination,
    move,
    listener,
    null,
    true
  );
  const result = await listener.promise;
  Assert.equal(result.messageKeys.length, 1);
  const physical = destination.msgDatabase.getMsgHdrForKey(
    result.messageKeys[0]
  );
  Assert.ok(physical);
  Assert.ok(!physical.properties.includes("uidOnServer"));
  return physical;
}

/**
 * @typedef {object} RetainedDatabase
 * @property {nsIMsgDBService|null} service - Private service, released first.
 * @property {nsIMsgDatabase|null} database - Rooted until its service is released.
 * @property {boolean} closed - Whether forceClosed released the owned store.
 * @property {WeakRef<nsIMsgOfflineImapOperation>[]} operations - Weak references
 *   to owned row wrappers, without a wrapped-JS XPCOM participant.
 */

/**
 * Retains six MDB writers and six unused readers before native account startup.
 *
 * @returns {{writer: RetainedDatabase, reader: RetainedDatabase}[]} Distinct
 *   services whose reader caches have not opened any source database.
 */
function retainLegacyServices() {
  Assert.equal(
    Cc[DB_SERVICE].number,
    LEGACY_SERVICE,
    "The original MDB factory is still selected before account startup"
  );
  const instances = new Set();
  const create = () => {
    const service = Cc[DB_SERVICE].createInstance(Ci.nsIMsgDBService);
    Assert.ok(!(service instanceof Ci.nsIDatabaseCore));
    Assert.ok(
      !instances.has(service),
      "Each retained service owns a fresh cache"
    );
    instances.add(service);
    return service;
  };
  const retain = () => ({
    service: create(),
    database: null,
    closed: false,
    operations: [],
  });
  const retained = NAMES.map(() => ({ writer: retain(), reader: retain() }));
  Assert.equal(instances.size, 12, "Exactly six writers and six readers");
  Assert.equal(
    Cc[DB_SERVICE].number,
    LEGACY_SERVICE,
    "Creating isolated MDB instances did not start or replace the global service"
  );
  return retained;
}

/**
 * Checks a retained MDB instance while keeping the native global service active.
 *
 * @param {nsIMsgDBService} service - Prestartup writer or unused reader instance.
 * @returns {nsIMsgDBService} The same isolated retained instance.
 */
function legacyService(service) {
  Assert.ok(service, "The finite prestartup service instance is retained");
  Assert.ok(!(service instanceof Ci.nsIDatabaseCore));
  Assert.strictEqual(
    Cc[DB_SERVICE].getService(Ci.nsIDatabaseCore),
    core,
    "The global native service is unchanged"
  );
  return service;
}

/**
 * Collects unused wrappers and awaits their deferred native releases.
 *
 * @returns {Promise<void>} Resolves after ending the owning JS job, GC/CC/
 *   shrinking GC and the following main-thread task.
 */
async function finalizeRetainedWrappers() {
  // WeakRef construction keeps its target alive until the current JS job ends.
  // Cross a task boundary so ClearKeptObjects runs before the precise GC.
  await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
  await schedulePreciseGCAndForceCC(1);
  // Native accessors hold their XPConnect parent wrapper. Normal GC may
  // preserve JIT stubs that root those accessors; a shrinking GC discards
  // inactive accessor stubs before the strict owned-wrapper release check.
  await new Promise(resolve => Cu.schedulePreciseShrinkingGC(resolve));
  // AfterProcessTask drains native finalizers after its microtask checkpoint.
  // Dispatch a task so closure cannot run in the GC callback's microtasks.
  await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
}

/**
 * Keeps an already-reported assertion abort readable during fixture cleanup.
 *
 * @param {unknown} error - Original native error, thrown value or harness marker.
 * @returns {unknown} The same value, or an Error whose cause is the exact symbol.
 */
function reportableFixtureError(error) {
  return typeof error == "symbol"
    ? new Error("Fixture assertion aborted; original harness marker retained", {
        cause: error,
      })
    : error;
}

/**
 * Commits and force-closes only a fixture-owned MDB store, retaining its handle.
 *
 * @param {RetainedDatabase} record - Owned DB and private service lifetime.
 * @param {number} [commitType] - Existing MDB commit mode before final closure.
 * @returns {Promise<void>} Resolves after wrapper release and store closure.
 * @throws {*} The first release, commit or closure error. Live row wrappers
 *   prevent forced closure.
 */
async function finishRetainedDatabase(
  record,
  commitType = Ci.nsMsgDBCommitType.kSessionCommit
) {
  if (!record.database || record.closed) {
    return;
  }
  let firstError;
  let failed = false;
  const attempt = async action => {
    try {
      await action();
    } catch (error) {
      if (!failed) {
        firstError = reportableFixtureError(error);
        failed = true;
      }
    }
  };
  let wrappersReleased = false;
  await attempt(async () => {
    // Drop cached headers/threads before collecting wrappers in returned helpers.
    record.database.clearCachedHdrs();
    await finalizeRetainedWrappers();
    wrappersReleased = record.operations.every(
      reference => reference.deref() === undefined
    );
    Assert.ok(
      wrappersReleased,
      "Every owned offline-operation wrapper is gone before forced store closure"
    );
    if (!wrappersReleased) {
      throw new Error(
        "Owned offline-operation wrapper survived before store closure"
      );
    }
    record.operations.length = 0;
  });
  // CloseMDB discards Commit's result, so observe the explicit commit first.
  await attempt(() => record.database.commit(commitType));
  if (wrappersReleased) {
    await attempt(() => {
      record.database.forceClosed();
      record.closed = true;
    });
  }
  if (failed) {
    throw firstError;
  }
}

/**
 * Releases private service wrappers before their rooted, force-closed DBs.
 *
 * @param {RetainedDatabase[]} records - Only the finite fixture-owned records.
 * @returns {Promise<void>} Resolves after services and closed DBs are released.
 * @throws {*} The first release error after attempting the remaining cleanup.
 */
async function releaseRetainedServices(records) {
  if (records.every(record => !record.service && !record.database)) {
    return;
  }
  let firstError;
  let failed = false;
  const remember = error => {
    if (!failed) {
      firstError = reportableFixtureError(error);
      failed = true;
    }
  };
  for (const record of records) {
    try {
      await finishRetainedDatabase(record);
    } catch (error) {
      remember(error);
    }
  }
  // These services cache raw DB pointers. Never query their caches again;
  // dispose of the service wrappers while all referenced DB handles are rooted.
  for (const record of records) {
    record.service = null;
  }
  let collectedServices = false;
  try {
    await finalizeRetainedWrappers();
    collectedServices = true;
  } catch (error) {
    remember(error);
  }
  if (collectedServices) {
    for (const record of records) {
      record.database = null;
    }
    try {
      await finalizeRetainedWrappers();
    } catch (error) {
      remember(error);
    }
  }
  if (failed) {
    throw firstError;
  }
}

/**
 * Writes captured parsed values using the retained typed MDB header setters.
 *
 * @param {nsIMsgDatabase} database - Isolated MDB writer.
 * @param {object} captured - Actual native capture.
 * @param {number} key - Actual classic UID or retained MDB allocated fake key.
 * @param {boolean} explicitUid - Whether this form saves uidOnServer explicitly.
 * @returns {number} The actual attached legacy header's physical message key.
 */
function writeHeader(database, captured, key, explicitUid) {
  let header =
    key === null
      ? database.createNewHdr()
      : database.createNewHdrWithSpecificMsgKey(key);
  try {
    for (const name of [
      "messageId",
      "subject",
      "author",
      "recipients",
      "ccList",
      "bccList",
      "date",
      "priority",
      "messageSize",
      "storeToken",
      "offlineMessageSize",
      "lineCount",
    ]) {
      header[name] = captured[name];
    }
    header.flags = captured.flags;
    header.setStringProperty("references", captured.references);
    header.setStringProperty("keywords", captured.keywords);
    if (explicitUid) {
      Assert.notEqual(captured.uid, null);
      header.setUint32Property("uidOnServer", captured.uid);
    }
    database.addNewHdrToDB(header, false);
    return header.messageKey;
  } finally {
    header = null;
  }
}

/**
 * Saves a captured operation through the retained typed MDB API.
 *
 * @param {RetainedDatabase} record - Isolated writer and owned row lifetime.
 * @param {object} captured - Actual operation and translated allocated keys.
 */
function writeOperation(record, captured) {
  const database = record.database.QueryInterface(Ci.nsIMsgOfflineOpsDatabase);
  let operation = database.getOfflineOpForKey(captured.messageKey, true);
  record.operations.push(new WeakRef(operation));
  try {
    for (const name of [
      "srcMessageKey",
      "srcUid",
      "flagOperation",
      "newFlags",
      "msgSize",
      "playingBack",
    ]) {
      operation[name] = captured[name];
    }
    if (captured.sourceFolderURI) {
      operation.sourceFolderURI = captured.sourceFolderURI;
    }
    if (captured.destinationFolderURI) {
      operation.destinationFolderURI = captured.destinationFolderURI;
    }
    if (captured.keywordsToAdd) {
      operation.addKeywordToAdd(captured.keywordsToAdd);
    }
    if (captured.keywordsToRemove) {
      operation.addKeywordToRemove(captured.keywordsToRemove);
    }
    for (const destination of captured.copies) {
      operation.addMessageCopyOperation(destination);
    }
    // These setters OR bits into the word, even when their payload is zero.
    // This mask has no COPY-tail or move/APPEND-destination clear side effects.
    // Preserve every payload, then OR the exact captured word into the cleared bits.
    operation.clearOperation(
      OP.kFlagsChanged | OP.kMoveResult | OP.kAddKeywords | OP.kRemoveKeywords
    );
    operation.operation = captured.operation;
    Assert.deepEqual(captureOperation(operation), captured);
  } finally {
    operation = null;
  }
}

/**
 * Writes the captured operation set without retaining wrappers in async setup.
 *
 * @param {RetainedDatabase} record - Owned writer.
 * @param {object} member - Actual source folder capture.
 * @param {Map<string, Map<number, number>>} keyMaps - Actual allocated legacy keys.
 * @param {number} originalKey - Actual moved source key.
 * @returns {object[]} Plain translated operation values.
 */
function writeRetainedOperations(record, member, keyMaps, originalKey) {
  const database = record.database.QueryInterface(Ci.nsIMsgOfflineOpsDatabase);
  const native = member.folder.msgDatabase.QueryInterface(
    Ci.nsIMsgOfflineOpsDatabase
  );
  const operations = native.listAllOfflineOpIds().map(key => {
    const row = captureOperation(native.getOfflineOpForKey(key, false));
    const sourceURI = row.sourceFolderURI || member.folder.URI;
    return {
      ...row,
      messageKey: keyMaps.get(member.folder.URI).get(row.messageKey),
      srcMessageKey:
        row.srcMessageKey == 0xffffffff
          ? row.srcMessageKey
          : keyMaps.get(sourceURI).get(row.srcMessageKey),
    };
  });
  for (const operation of operations) {
    Assert.ok(Number.isInteger(operation.messageKey));
    Assert.ok(Number.isInteger(operation.srcMessageKey));
    writeOperation(record, operation);
  }
  if (member.name == NAMES[0]) {
    database.deleteMessage(
      keyMaps.get(member.folder.URI).get(originalKey),
      null,
      false
    );
  }
  database.summaryValid = true;
  return operations;
}

/**
 * Publishes plain retained-row values only after their native caller returns.
 *
 * @param {function(): object[]} action - One synchronous retained writer or
 *   reader capture. Both return arrays of plain values, never live MDB objects.
 * @returns {Promise<object[]>} The captured values from the following task.
 */
function captureRetainedRows(action) {
  return new Promise((resolve, reject) => {
    Services.tm.dispatchToMainThread(() => {
      let values;
      let firstError;
      let failed = false;
      try {
        values = action();
      } catch (error) {
        firstError = reportableFixtureError(error);
        failed = true;
      } finally {
        action = null;
      }
      // Return from the complete synchronous XPConnect caller before setup
      // can resume and start collection/closure. Only plain values cross tasks.
      Services.tm.dispatchToMainThread(() => {
        if (failed) {
          reject(firstError);
        } else {
          resolve(values);
        }
      });
    });
  });
}

/**
 * Captures one retained row and clears its strong reference on every outcome.
 *
 * @param {RetainedDatabase} record - Owned independent reader.
 * @param {number} key - Persisted operation key.
 * @returns {object} Plain complete row values, including the ordered COPY tail.
 */
function captureRetainedOperation(record, key) {
  const database = record.database.QueryInterface(Ci.nsIMsgOfflineOpsDatabase);
  let operation = database.getOfflineOpForKey(key, false);
  record.operations.push(new WeakRef(operation));
  try {
    return captureOperation(operation);
  } finally {
    operation = null;
  }
}

/**
 * Reads and checks the reopened source before returning only plain header values.
 *
 * @param {RetainedDatabase} record - Owned independent reader.
 * @param {object} member - Actual captured folder and epoch.
 * @param {object[]} operations - Exact captured operations to compare.
 * @param {number} originalUid - UID of the actual moved source.
 * @returns {object[]} Plain source header values.
 */
function readRetainedSnapshot(record, member, operations, originalUid) {
  const reader = record.database.QueryInterface(Ci.nsIMsgOfflineOpsDatabase);
  Assert.equal(reader.dBFolderInfo.imapUidValidity, member.epoch);
  Assert.equal(
    reader.dBFolderInfo.flags >>> 0,
    member.folderFlags,
    "Reopened flags match the actual captured folder"
  );
  Assert.deepEqual(
    reader
      .listAllOfflineOpIds()
      .map(key => captureRetainedOperation(record, key)),
    operations
  );
  const headers = [...reader.enumerateMessages()].map(header => ({
    key: header.messageKey,
    uid: [...header.properties].includes("uidOnServer")
      ? header.getUint32Property("uidOnServer")
      : null,
    messageId: header.messageId,
    storeToken: header.storeToken,
    size: header.messageSize,
    offlineSize: header.offlineMessageSize,
  }));
  if (member.name == NAMES[0]) {
    Assert.equal(
      headers.length,
      1,
      "A classic live row and a distinct operation-only source survive"
    );
    Assert.ok(!headers.some(header => header.key == originalUid));
  }
  if (NAMES.indexOf(member.name) > 1) {
    Assert.ok(
      headers.every(header => header.uid === null),
      "Fake pending keys carry no UID"
    );
  }
  return headers;
}

/**
 * Hashes each real body file without changing its provider token or layout.
 *
 * @param {string} path - Actual mbox file or maildir directory.
 * @param {string} [root=path] - Original absolute file or directory root.
 * @returns {Promise<object[]>} Slash-separated relative names, hashes and bytes.
 */
async function measureBodies(path, root = path) {
  if (!(await IOUtils.exists(path))) {
    return [];
  }
  const stat = await IOUtils.stat(path);
  if (stat.type == "directory") {
    const files = [];
    for (const child of (await IOUtils.getChildren(path)).sort()) {
      files.push(...(await measureBodies(child, root)));
    }
    return files;
  }
  Assert.equal(stat.type, "regular");
  const bytes = await IOUtils.read(path);
  Assert.less(
    bytes.length,
    1024 * 1024,
    "The ordinary source fixture is finite"
  );
  return [
    {
      relative:
        path == root
          ? ""
          : new FileUtils.File(path).getRelativePath(new FileUtils.File(root)),
      size: bytes.length,
      sha256: await IOUtils.computeHexDigest(path, "sha256"),
      base64: btoa(String.fromCharCode(...bytes)),
    },
  ];
}

add_setup(async function captureRealOfflineOperationsAndMdbReadback() {
  const retained = retainLegacyServices();
  core = PanoramaDelivery.assertBackend("panorama").QueryInterface(
    Ci.nsIDatabaseCore
  );
  work = await IOUtils.createUniqueDirectory(
    PathUtils.parent(do_get_profile().path),
    "s518-input-"
  );
  const wasOffline = Services.io.offline;
  registerCleanupFunction(async () => {
    let firstError;
    let failed = false;
    const remember = error => {
      if (!failed) {
        firstError = reportableFixtureError(error);
        failed = true;
      }
    };
    const attempt = action => {
      try {
        action();
      } catch (error) {
        remember(error);
      }
    };
    try {
      await releaseRetainedServices(
        retained.flatMap(pair => [pair.writer, pair.reader])
      );
    } catch (error) {
      remember(error);
    }
    attempt(() => journal?.close());
    attempt(() => {
      if (lock) {
        lock.unlock();
        lock = null;
      }
    });
    attempt(() => {
      if (selectedProfile) {
        selectedProfile.remove(false);
        selectedProfile = null;
      }
    });
    attempt(() => {
      if (IMAPPump.incomingServer) {
        teardownIMAPPump();
      }
    });
    attempt(() => {
      Services.io.offline = wasOffline;
    });
    try {
      await IOUtils.remove(work, { recursive: true });
    } catch (error) {
      remember(error);
    }
    if (failed) {
      throw firstError;
    }
  });
  Services.prefs.setCharPref(
    "mail.server.default.storeContractID",
    Services.prefs.getCharPref("mail.serverDefaultStoreContractID")
  );
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
  setupIMAPPump("RFC2195,RFC4315");
  for (const name of NAMES) {
    IMAPPump.daemon.createMailbox(name, {
      subscribed: true,
      uidvalidity: IMAPPump.daemon.uidvalidity++,
    });
  }
  const discovery = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(
    IMAPPump.incomingServer.rootFolder,
    discovery,
    null
  );
  await discovery.promise;
  IMAPPump.inbox = IMAPPump.incomingServer.rootFolder.getFolderWithFlags(
    Ci.nsMsgFolderFlags.Inbox
  );
  members = NAMES.map(name => ({
    name,
    folder: IMAPPump.incomingServer.rootFolder
      .getChildNamed(name)
      .QueryInterface(Ci.nsIMsgImapMailFolder),
  }));
  const uri = Services.io.newFileURI(do_get_file("../../../data/bugmail10"));
  for (const name of ["INBOX", NAMES[0], NAMES[1]]) {
    const mailbox = IMAPPump.daemon.getMailbox(name);
    mailbox.addMessage(
      new ImapMessage(uri.spec, mailbox.uidnext++, ["\\Seen"])
    );
    if (name != "INBOX") {
      mailbox.addMessage(
        new ImapMessage(uri.spec, mailbox.uidnext++, ["\\Seen"])
      );
    }
  }
  for (const folder of [
    IMAPPump.inbox,
    ...members.map(member => member.folder),
  ]) {
    await selectFolder(folder);
    const listener = new PromiseTestUtils.PromiseUrlListener();
    folder.downloadAllForOffline(listener, null);
    await listener.promise;
  }
  const original = [...members[0].folder.messages][0];
  const explicit = [...members[1].folder.messages][0];
  Assert.ok(original && explicit);
  const originalCapture = captureHeader(original);
  Assert.equal(
    originalCapture.uid,
    captureHeader(explicit).uid,
    "Independent folders actually supplied the same UID"
  );
  IMAPPump.incomingServer.closeCachedConnections();
  Services.io.offline = true;
  original.folder.markMessagesFlagged([original], true);
  original.folder.markMessagesRead([original], false);
  original.folder.addKeywordsToMessages([original], "s518-added");
  original.folder.removeKeywordsFromMessages([original], "s518-removed");
  await offlineCopy(original, members[2].folder, false);
  await offlineCopy(original, members[3].folder, false);
  await offlineCopy(original, members[4].folder, true);
  Assert.ok(
    !members[0].folder.msgDatabase.containsKey(originalCapture.nativeKey)
  );
  const appended = new PromiseTestUtils.PromiseCopyListener();
  MailServices.copy.copyFileMessage(
    do_get_file("../../../data/bugmail10"),
    members[5].folder,
    null,
    false,
    0,
    "",
    appended,
    null
  );
  const appendResult = await appended.promise;
  Assert.equal(appendResult.messageKeys.length, 1);
  const appendedHeader = members[5].folder.msgDatabase.getMsgHdrForKey(
    appendResult.messageKeys[0]
  );
  Assert.ok(!appendedHeader.properties.includes("uidOnServer"));

  ledger = {
    version: 1,
    backend: "panorama",
    platform: AppConstants.platform,
    captureProfilePath: do_get_profile().path,
    store: members[0].folder.msgStore.storeType,
    configuredStoreContractID: Services.prefs.getCharPref(
      "mail.server.default.storeContractID"
    ),
    members: [],
  };
  const keyMaps = new Map();
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    const writer = retained[i].writer;
    Assert.ok(
      !member.folder.summaryFile.exists(),
      "The native backend has not fabricated an MSF"
    );
    writer.database = legacyService(writer.service).openDBFromFile(
      member.folder.summaryFile,
      member.folder,
      true,
      true
    );
    const database = writer.database.QueryInterface(
      Ci.nsIMsgOfflineOpsDatabase
    );
    const captured = [...member.folder.messages].map(captureHeader);
    if (i == 0) {
      captured.push(originalCapture);
    }
    const map = new Map();
    for (const header of captured) {
      let key = null;
      if (i == 0) {
        key = header.uid;
      } else if (header.uid === null) {
        key = database.nextFakeOfflineMsgKey;
      }
      const savedKey = writeHeader(database, header, key, i == 1);
      map.set(header.nativeKey, savedKey);
    }
    keyMaps.set(member.folder.URI, map);
    member.folderFlags = member.folder.flags;
    Assert.equal(
      core.folderDB.getFolderFlags(member.folder.id),
      member.folderFlags
    );
    database.dBFolderInfo.flags = member.folderFlags;
    Assert.equal(database.dBFolderInfo.flags >>> 0, member.folderFlags);
    database.dBFolderInfo.imapUidValidity =
      member.folder.msgDatabase.dBFolderInfo.imapUidValidity;
    member.captured = captured;
    member.epoch = database.dBFolderInfo.imapUidValidity;
  }
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    let operations, headers;
    {
      const writer = retained[i].writer;
      operations = await captureRetainedRows(() =>
        writeRetainedOperations(
          writer,
          member,
          keyMaps,
          originalCapture.nativeKey
        )
      );
      await finishRetainedDatabase(writer, Ci.nsMsgDBCommitType.kLargeCommit);
      // The unused retained reader cache is independent of the writer and parser.
      const readback = retained[i].reader;
      readback.database = legacyService(readback.service).openDBFromFile(
        member.folder.summaryFile,
        member.folder,
        false,
        true
      );
      headers = await captureRetainedRows(() =>
        readRetainedSnapshot(readback, member, operations, originalCapture.uid)
      );
      await finishRetainedDatabase(readback);
    }
    await releaseRetainedServices([retained[i].writer, retained[i].reader]);
    const bytes = await IOUtils.read(member.folder.summaryFile.path);
    const source = {
      name: member.name,
      uri: member.folder.URI,
      folderId: member.folder.id,
      folder: {
        id: member.folder.id,
        uri: member.folder.URI,
        protocol: member.folder.incomingServerType,
        summaryPath: member.folder.summaryFile.path,
        storePath: member.folder.filePath.path,
        storeType: member.folder.msgStore.storeType,
        rootURI: IMAPPump.incomingServer.rootFolder.URI,
        serverKey: IMAPPump.incomingServer.key,
        mailRoot: IMAPPump.incomingServer.localPath.path,
      },
      epoch: member.epoch,
      folderFlags: member.folderFlags,
      headers,
      operations,
      keyMap: [...keyMaps.get(member.folder.URI)],
      sha256: await IOUtils.computeHexDigest(
        member.folder.summaryFile.path,
        "sha256"
      ),
      size: bytes.length,
      base64: btoa(String.fromCharCode(...bytes)),
      bodies: await measureBodies(member.folder.filePath.path),
      captured: member.captured,
    };
    ledger.members.push(source);
    info("S518_GENUINE_SOURCE " + JSON.stringify(source));
  }
  info("S518_INPUT_LEDGER " + JSON.stringify(ledger));
  // Only the native destination metadata is cleared. Closed MSF source bytes and
  // provider-finished bodies remain intact, at their actual bound folder paths.
  for (const member of members) {
    const database = member.folder.msgDatabase.QueryInterface(
      Ci.nsIMsgOfflineOpsDatabase
    );
    for (const key of database.listAllOfflineOpIds()) {
      database.removeOfflineOp(database.getOfflineOpForKey(key, false));
    }
    database.deleteMessages(
      [...member.folder.messages].map(header => header.messageKey),
      null
    );
    Assert.equal([...member.folder.messages].length, 0);
    Assert.equal(database.listAllOfflineOpIds().length, 0);
  }
  for (let i = 0; i < members.length; i++) {
    Assert.equal(
      await IOUtils.computeHexDigest(
        members[i].folder.summaryFile.path,
        "sha256"
      ),
      ledger.members[i].sha256
    );
    Assert.deepEqual(
      await measureBodies(members[i].folder.filePath.path),
      ledger.members[i].bodies
    );
  }
  const profileRoot = PathUtils.join(work, "source-profile");
  await IOUtils.makeDirectory(profileRoot);
  const provider = Cc["@mozilla.org/xre/directory-provider;1"]
    .getService(Ci.nsIDirectoryServiceProvider)
    .QueryInterface(Ci.nsIXREDirProvider);
  for (const key of ["DefProfRt", "DefProfLRt", "UAppData"]) {
    Services.dirsvc.set(key, provider.getFile(key, {}).clone());
  }
  const profileService = Cc[
    "@mozilla.org/toolkit/profile-service;1"
  ].getService(Ci.nsIToolkitProfileService);
  selectedProfile = profileService.createProfile(
    new FileUtils.File(profileRoot),
    "s518-closed-source",
    "tests"
  );
  lock = selectedProfile.lock({});
  const mailRoot = IMAPPump.incomingServer.localPath.path;
  backup = await createMigrationBackup(
    profileRoot,
    [mailRoot],
    PathUtils.join(work, "backup")
  );
  entries = [];
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    const inventory =
      AppConstants.platform == "win"
        ? Reader.captureMorkFolderWindowsInventory(
            member.folder.summaryFile,
            new FileUtils.File(mailRoot),
            member.folder.filePath,
            new FileUtils.File(mailRoot)
          )
        : undefined;
    inventories.set(member.name, inventory);
    const input = await Reader.readMorkFolderImport(
      member.folder,
      "s518-member-" + i,
      inventory
    );
    const source = {
      id: member.name,
      token: input.token,
      protocol: "imap",
      originalFolderURI: member.folder.URI,
      databaseSourceId: core.sourceId,
      path: input.source.path,
      sha256: input.source.sha256,
      size: input.source.size,
      messageKeys: input.source.messageKeys,
      destinationFolderId: member.folder.id,
      ...(inventory ? { inventory } : {}),
    };
    Assert.equal(source.sha256, ledger.members[i].sha256);
    const folderFlags = core.folderDB.getFolderFlags(member.folder.id);
    Assert.equal(
      (folderFlags ^ member.folderFlags) & ~Ci.nsMsgFolderFlags.OfflineEvents,
      0,
      "Clearing pending target metadata preserves all other captured folder flags"
    );
    entries.push({ input, source, folderFlags });
  }
  entries.sort((left, right) => left.source.id.localeCompare(right.source.id));
  journalPath = PathUtils.join(work, "progress.json");
  journal = await MigrationJournal.create(journalPath, {
    profilePath: lock.directory.path,
    mailPaths: [mailRoot],
    backupPath: PathUtils.parent(backup.path),
    sources: entries.map(entry => entry.source),
  });
  await journal.recordBackup(backup);
  const token = await journal.beginImportUnit(
    entries.map(entry => entry.source.id)
  );
  for (const entry of entries) {
    entry.source = journal.state.sources.find(
      source => source.id == entry.source.id
    );
    const member = members.find(value => value.name == entry.source.id);
    entry.input = await Reader.readMorkFolderImport(
      member.folder,
      entry.source.token,
      inventories.get(member.name)
    );
  }
  unit = Adapter.convertMorkProtocolUnit(entries, token, core.sourceId);
  await journal.bindImportUnit(unit);
  Assert.equal(unit.version, 3);
  Assert.equal(unit.protocol, "imap");
  Assert.equal(unit.folders.length, members.length);
});

/**
 * Returns the actual folder bound to the first member of a complete request.
 *
 * @param {object} [request=unit] - Actual converted request or negative variant.
 * @returns {nsIMsgFolder} The native anchor folder, without URI/key guessing.
 */
function anchor(request = unit) {
  const folder = members.find(
    member => member.folder.id == request.folders[0].folder.id
  )?.folder;
  Assert.ok(folder, "The request has an actual native anchor");
  return folder;
}

/** @returns {object} The existing normal platform-specific coordinator target. */
function target() {
  const factory =
    AppConstants.platform == "win"
      ? Coordinator.createWindowsPanoramaMigrationTarget
      : Coordinator.createPanoramaMigrationTarget;
  return factory(
    journal,
    core,
    id => {
      const member = members.find(value => value.name == id);
      Assert.ok(member, "The source ID resolves a retained physical folder");
      return member.folder;
    },
    lock
  );
}

/** @returns {Promise<void>} Original summary and body bytes are still unchanged. */
async function assertSourcesUnchanged() {
  for (const original of ledger.members) {
    const member = members.find(value => value.name == original.name);
    Assert.equal(
      await IOUtils.computeHexDigest(member.folder.summaryFile.path, "sha256"),
      original.sha256
    );
    Assert.deepEqual(
      await measureBodies(member.folder.filePath.path),
      original.bodies
    );
  }
}

/** @returns {void} No partial native member, staged row or transaction leaked. */
function assertEmptyUnit() {
  for (const member of members) {
    Assert.equal([...member.folder.messages].length, 0);
    Assert.equal(
      member.folder.msgDatabase
        .QueryInterface(Ci.nsIMsgOfflineOpsDatabase)
        .listAllOfflineOpIds().length,
      0
    );
  }
  Assert.ok(!core.connectionForTests.transactionInProgress);
}

/**
 * Executes a malformed typed request and checks actual native rollback.
 *
 * @param {object} request - One changed captured identity or association.
 * @returns {Promise<void>} Resolves after the real native refusal and source checks.
 */
async function nativeRefuses(request) {
  await Assert.rejects(
    Promise.resolve().then(() => core.importFolderSnapshot(anchor(), request)),
    error =>
      Number.isInteger(error.result) && !Components.isSuccessCode(error.result),
    "The native receiver refuses the changed source identity before publication"
  );
  assertEmptyUnit();
  await assertSourcesUnchanged();
}

add_task(
  async function staleMissingAndConflictingEpochOrUidRefusesBeforePublication() {
    const absent = structuredClone(unit);
    const bound = absent.folders.find(folder => folder.imap.serverUids.length);
    bound.imap.uidValidity = { present: false };
    await nativeRefuses(absent);
    const stale = structuredClone(unit);
    stale.folders[0].imap.uidValidity.value++;
    await nativeRefuses(stale);
    const collision = structuredClone(unit);
    const folder = collision.folders.find(
      value => value.imap.serverUids.length > 1
    );
    Assert.ok(
      folder,
      "The real explicit capture has two different UID bindings"
    );
    folder.imap.serverUids[1].uid = folder.imap.serverUids[0].uid;
    await nativeRefuses(collision);
  }
);

add_task(async function missingForeignOrAmbiguousCounterpartRefusesWholeUnit() {
  Assert.throws(
    () =>
      Adapter.convertMorkProtocolUnit(
        entries.filter(entry => entry.source.id != NAMES[2]),
        unit.token,
        core.sourceId
      ),
    /counterpart|destination|Unresolved/,
    "The real saved COPY URI requires its physical member"
  );
  const foreign = structuredClone(unit);
  foreign.folders[0].folder.id = foreign.folders[1].folder.id;
  await nativeRefuses(foreign);
  const missing = structuredClone(unit);
  const operation = missing.folders
    .flatMap(folder => folder.imap.operations)
    .find(value => value.copies?.length);
  Assert.ok(operation, "The real producer supplied an ordered COPY tail");
  operation.copies = [];
  await nativeRefuses(missing);
});

add_task(
  async function storageFailureAndCancelPreserveFirstErrorSourceAndPendingBodyCustody() {
    const cancelled = new AbortController();
    cancelled.abort();
    await Assert.rejects(
      Coordinator.resumeMorkImports(journal, target(), cancelled.signal),
      error => error.name == "AbortError",
      "Actual coordinator cancellation happens before native publication"
    );
    Assert.ok(journal.state.cancelled);
    assertEmptyUnit();
    await assertSourcesUnchanged();
    await journal.setCancelled(false);
    const connection = core.connectionForTests;
    let storageCalls = 0;
    let nativeResult;
    let firstError;
    let failed = false;
    const remember = error => {
      if (!failed) {
        firstError = reportableFixtureError(error);
        failed = true;
      }
    };
    connection.createFunction("s518_storage_fault", 0, {
      onFunctionCall() {
        storageCalls++;
        return 0;
      },
    });
    try {
      connection.executeSimpleSQL(
        "CREATE TEMP TRIGGER s518_fail_insert BEFORE INSERT ON messages " +
          "BEGIN SELECT s518_storage_fault(); " +
          "SELECT RAISE(ABORT, 'S518 actual import storage failure'); END"
      );
      await Assert.rejects(
        Promise.resolve().then(() => core.importFolderSnapshot(anchor(), unit)),
        error => {
          nativeResult = error.result;
          return nativeResult === Cr.NS_ERROR_STORAGE_CONSTRAINT;
        },
        "The native import preserves the actual SQL trigger constraint error"
      );
      Assert.equal(
        storageCalls,
        1,
        "The messages INSERT actually reached the storage fault"
      );
      if (
        nativeResult !== Cr.NS_ERROR_STORAGE_CONSTRAINT ||
        storageCalls !== 1
      ) {
        throw new Error(
          "The expected messages INSERT constraint fault was not observed"
        );
      }
    } catch (error) {
      remember(error);
    } finally {
      for (const action of [
        () =>
          connection.executeSimpleSQL(
            "DROP TRIGGER IF EXISTS s518_fail_insert"
          ),
        () => connection.removeFunction("s518_storage_fault"),
      ]) {
        try {
          action();
        } catch (error) {
          remember(error);
        }
      }
      info(
        "S518_STORAGE_FAULT " + JSON.stringify({ storageCalls, nativeResult })
      );
    }
    if (failed) {
      throw firstError;
    }
    assertEmptyUnit();
    await assertSourcesUnchanged();
  }
);

add_task(async function capturedUidValidityAndFolderScopedUidImportAndReopen() {
  await Coordinator.resumeMorkImports(journal, target());
  Assert.equal(journal.state.stage, "validate");
  Assert.ok(journal.state.sources.every(source => source.state == "imported"));
  receipt = core.getFolderImportReceipt(anchor(), unit);
  Assert.equal(receipt.version, 3);
  Assert.equal(receipt.databaseSourceId, core.sourceId);
  Assert.equal(receipt.token, unit.token);
  Assert.equal(receipt.folders.length, members.length);
  for (const imported of receipt.folders) {
    const member = members.find(value => value.folder.id == imported.folderId);
    const expected = ledger.members.find(value => value.name == member.name);
    const keys = new Map(imported.keys);
    Assert.deepEqual(
      [...keys.keys()].sort((a, b) => a - b),
      expected.headers.map(header => header.key).sort((a, b) => a - b)
    );
    Assert.equal(
      member.folder.msgDatabase.dBFolderInfo.imapUidValidity,
      expected.epoch
    );
    for (const original of expected.headers) {
      const header = member.folder.msgDatabase.getMsgHdrForKey(
        keys.get(original.key)
      );
      Assert.equal(header.folder, member.folder);
      Assert.equal(header.messageId, original.messageId);
      Assert.equal(header.storeToken, original.storeToken);
      Assert.equal(header.messageSize, original.size);
      const nativeKey = expected.keyMap.find(
        ([, key]) => key == original.key
      )[0];
      const capture = expected.captured.find(
        value => value.nativeKey == nativeKey
      );
      Assert.equal(bodyBytes(member.folder, header), capture.body);
      if (capture.uid === null) {
        Assert.ok(!header.properties.includes("uidOnServer"));
      } else {
        Assert.equal(header.getUint32Property("uidOnServer"), capture.uid);
      }
    }
  }
  journal.close();
  journal = await MigrationJournal.open(journalPath, lock.directory.path);
  Assert.deepEqual(journal.state.protocolUnits[0].receipt, receipt);
  await assertSourcesUnchanged();
  info("S518_ACTUAL_RECEIPT " + JSON.stringify(receipt));
});

add_task(function sameUidInDifferentFoldersDoesNotAliasPhysicalKeys() {
  const live = [];
  for (const imported of receipt.folders) {
    const member = members.find(value => value.folder.id == imported.folderId);
    for (const [, key] of imported.keys) {
      const header = member.folder.msgDatabase.getMsgHdrForKey(key);
      if (header.properties.includes("uidOnServer")) {
        live.push({
          folder: member.folder.id,
          key,
          uid: header.getUint32Property("uidOnServer"),
        });
      }
    }
  }
  const same = live.find(left =>
    live.some(right => left.folder != right.folder && left.uid == right.uid)
  );
  Assert.ok(same, "The imported real captures contain a shared numeric UID");
  const other = live.find(
    right => right.folder != same.folder && right.uid == same.uid
  );
  Assert.notEqual(
    same.key,
    other.key,
    "Each server identity owns a separate allocated physical row"
  );
});

add_task(
  function genuineOrderedCopiesRetainActualPhysicalCounterpartsAndCombinedFlagsKeywords() {
    for (const imported of receipt.folders) {
      const member = members.find(
        value => value.folder.id == imported.folderId
      );
      const expected = ledger.members.find(value => value.name == member.name);
      const database = member.folder.msgDatabase.QueryInterface(
        Ci.nsIMsgOfflineOpsDatabase
      );
      Assert.equal(
        database.listAllOfflineOpIds().length,
        expected.operations.length
      );
      for (const original of expected.operations) {
        const mapped = imported.imap.operations.find(
          value => value.sourceKey == original.messageKey
        );
        Assert.ok(mapped, "The receipt retains the actual old operation key");
        Assert.greater(mapped.id, 0);
        Assert.greater(mapped.revision, 0);
        const operation = database.getOfflineOpForKey(mapped.key, false);
        Assert.ok(operation);
        Assert.equal(operation.operation, original.operation);
        Assert.equal(operation.flagOperation, original.flagOperation);
        Assert.equal(operation.newFlags, original.newFlags);
        Assert.equal(operation.srcUid, original.srcUid);
        Assert.equal(operation.keywordsToAdd, original.keywordsToAdd);
        Assert.equal(operation.keywordsToRemove, original.keywordsToRemove);
        Assert.equal(operation.playingBack, original.playingBack);
        Assert.deepEqual(captureOperation(operation).copies, original.copies);
        if (original.copies.length) {
          Assert.deepEqual(original.copies, [
            members[2].folder.URI,
            members[3].folder.URI,
          ]);
          Assert.ok(
            !database.containsKey(mapped.key),
            "The imported queued MOVE source is an operation-only key"
          );
        }
      }
    }
  }
);

add_task(
  async function genuineOfflineAppendKeepsFinishedBodyAndUidAbsentAcrossImportRestart() {
    const member = members[5];
    const imported = receipt.folders.find(
      value => value.folderId == member.folder.id
    );
    const original = ledger.members.find(value => value.name == member.name);
    Assert.equal(imported.keys.length, 1);
    const header = member.folder.msgDatabase.getMsgHdrForKey(
      imported.keys[0][1]
    );
    Assert.ok(!header.properties.includes("uidOnServer"));
    const operation = member.folder.msgDatabase
      .QueryInterface(Ci.nsIMsgOfflineOpsDatabase)
      .getOfflineOpForKey(header.messageKey, false);
    Assert.ok(operation.operation & OP.kAppendDraft);
    Assert.equal(bodyBytes(member.folder, header), original.captured[0].body);
    const profileFile = do_get_profile().clone();
    profileFile.append("panorama.sqlite");
    const reopened = Services.storage.openUnsharedDatabase(profileFile);
    try {
      const statement = reopened.createStatement(
        "SELECT folderId FROM messages WHERE id = :key"
      );
      try {
        statement.params.key = header.messageKey;
        Assert.ok(
          statement.executeStep(),
          "A fresh storage connection sees the real committed row"
        );
        Assert.equal(statement.row.folderId, member.folder.id);
      } finally {
        statement.finalize();
      }
    } finally {
      reopened.close();
    }
    Assert.deepEqual(core.getFolderImportReceipt(anchor(), unit), receipt);
    await assertSourcesUnchanged();
  }
);

add_task(
  async function repeatCommittedReceiptCreatesNoSecondPendingIntentOrNetworkCommand() {
    const before = members.map(member =>
      [...member.folder.messages].map(header => header.messageKey)
    );
    const operations = members.map(member =>
      member.folder.msgDatabase
        .QueryInterface(Ci.nsIMsgOfflineOpsDatabase)
        .listAllOfflineOpIds()
    );
    const transactions = IMAPPump.server.playTransaction();
    const changes = core.connectionForTests.createStatement(
      "SELECT total_changes() AS value"
    );
    let count;
    try {
      Assert.ok(changes.executeStep());
      count = changes.row.value;
    } finally {
      changes.finalize();
    }
    await Coordinator.resumeMorkImports(journal, target());
    Assert.deepEqual(await core.importFolderSnapshot(anchor(), unit), receipt);
    Assert.deepEqual(core.getFolderImportReceipt(anchor(), unit), receipt);
    Assert.deepEqual(
      members.map(member =>
        [...member.folder.messages].map(header => header.messageKey)
      ),
      before
    );
    Assert.deepEqual(
      members.map(member =>
        member.folder.msgDatabase
          .QueryInterface(Ci.nsIMsgOfflineOpsDatabase)
          .listAllOfflineOpIds()
      ),
      operations
    );
    Assert.deepEqual(
      IMAPPump.server.playTransaction(),
      transactions,
      "Import and receipt retry never issue a protocol command"
    );
    const after = core.connectionForTests.createStatement(
      "SELECT total_changes() AS value"
    );
    try {
      Assert.ok(after.executeStep());
      Assert.equal(after.row.value, count);
    } finally {
      after.finalize();
    }
    await assertSourcesUnchanged();
  }
);

add_task(
  async function changedSummaryBodySourceIncarnationOrReceiptCannotRebind() {
    const foreign = structuredClone(unit);
    foreign.databaseSourceId += "-foreign";
    Assert.throws(
      () => core.getFolderImportReceipt(anchor(), foreign),
      error => Number.isInteger(error.result)
    );
    const changed = structuredClone(unit);
    changed.folders[0].source.sha256 = "0".repeat(64);
    Assert.throws(
      () => core.getFolderImportReceipt(anchor(), changed),
      error => Number.isInteger(error.result)
    );
    // Native receipt proof hashes the real provider stream, not an input digest.
    const member = members[5];
    const original = ledger.members.find(value => value.name == member.name);
    const imported = receipt.folders.find(
      value => value.folderId == member.folder.id
    );
    Assert.equal(
      imported.keys.length,
      1,
      "The real offline APPEND owns one body"
    );
    const header = member.folder.msgDatabase.getMsgHdrForKey(
      imported.keys[0][1]
    );
    Assert.equal(header.storeToken, original.headers[0].storeToken);
    const root = member.folder.filePath.path;
    const store = member.folder.msgStore.storeType;
    let path;
    let start;
    if (store == "maildir") {
      path = PathUtils.join(root, "cur", header.storeToken);
      start = 0;
    } else {
      Assert.equal(store, "mbox");
      path = root;
      Assert.ok(/^[0-9]+$/.test(header.storeToken));
      start = Number(header.storeToken);
      Assert.ok(Number.isSafeInteger(start));
    }
    const tracked = original.bodies.find(file =>
      new FileUtils.File(
        file.relative ? PathUtils.join(root, ...file.relative.split("/")) : root
      ).equals(new FileUtils.File(path))
    );
    Assert.ok(
      tracked,
      "The selected token names an actually captured body file"
    );
    const bytes = await IOUtils.read(path);
    Assert.equal(bytes.length, tracked.size);
    Assert.equal(
      await IOUtils.computeHexDigest(path, "sha256"),
      tracked.sha256
    );
    const before = bodyBytes(member.folder, header);
    Assert.equal(before, original.captured[0].body);
    const requestBefore = JSON.stringify(unit);
    const text = String.fromCharCode(...bytes);
    const crlf = text.indexOf("\r\n\r\n", start);
    const lf = text.indexOf("\n\n", start);
    const separators = [
      ...(crlf < 0 ? [] : [{ offset: crlf, width: 4 }]),
      ...(lf < 0 ? [] : [{ offset: lf, width: 2 }]),
    ].sort((left, right) => left.offset - right.offset);
    Assert.ok(
      separators.length,
      "The stored message has a real header/body boundary"
    );
    let offset = separators[0].offset + separators[0].width;
    while ([9, 10, 13, 32].includes(bytes[offset])) {
      offset++;
    }
    Assert.less(offset, bytes.length);
    Assert.ok(bytes[offset] >= 33 && bytes[offset] <= 126);
    const changedBytes = bytes.slice();
    changedBytes[offset] ^= 1;
    /**
     * Overwrites the same existing file without create, truncate or replacement.
     *
     * @param {Uint8Array} replacement - Same-length temporary or original bytes.
     */
    const writeBodyBytes = replacement => {
      Assert.equal(replacement.length, bytes.length);
      const output = Cc[
        "@mozilla.org/network/file-output-stream;1"
      ].createInstance(Ci.nsIFileOutputStream);
      output.init(new FileUtils.File(path), 0x02, 0, 0); // write existing file
      try {
        const content = String.fromCharCode(...replacement);
        Assert.equal(output.write(content, content.length), content.length);
        output.flush();
      } finally {
        output.close();
      }
    };
    try {
      writeBodyBytes(changedBytes);
      const changedHash = await IOUtils.computeHexDigest(path, "sha256");
      Assert.notEqual(changedHash, tracked.sha256);
      const changedBody = bodyBytes(member.folder, header);
      Assert.notEqual(
        changedBody,
        before,
        "The selected provider stream sees changed body bytes"
      );
      Assert.equal(
        changedBody.length,
        before.length,
        "Message framing and token remain valid"
      );
      for (const saved of ledger.members) {
        const source = members.find(value => value.name == saved.name);
        Assert.equal(
          await IOUtils.computeHexDigest(
            source.folder.summaryFile.path,
            "sha256"
          ),
          saved.sha256
        );
      }
      let result;
      Assert.throws(
        () => core.getFolderImportReceipt(anchor(), unit),
        error => {
          result = error.result;
          return result === Cr.NS_ERROR_ALREADY_INITIALIZED;
        },
        "Changed measured body proof cannot reconcile the committed receipt"
      );
      Assert.equal(
        JSON.stringify(unit),
        requestBefore,
        "No supplied request digest was changed"
      );
      info(
        "S518_BODY_REFUSAL " +
          JSON.stringify({
            store,
            token: header.storeToken,
            path,
            originalSha256: tracked.sha256,
            changedSha256: changedHash,
            result,
            receiptToken: receipt.token,
          })
      );
    } finally {
      writeBodyBytes(bytes);
      Assert.deepEqual(
        await IOUtils.read(path),
        bytes,
        "Restore every original file byte"
      );
      Assert.equal(
        await IOUtils.computeHexDigest(path, "sha256"),
        tracked.sha256
      );
      Assert.equal(
        bodyBytes(member.folder, header),
        before,
        "The provider stream is restored"
      );
      Assert.deepEqual(core.getFolderImportReceipt(anchor(), unit), receipt);
      await assertSourcesUnchanged();
    }
    Assert.deepEqual(core.getFolderImportReceipt(anchor(), unit), receipt);
    await assertSourcesUnchanged();
  }
);
