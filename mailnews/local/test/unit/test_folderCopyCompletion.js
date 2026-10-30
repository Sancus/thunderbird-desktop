/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

/**
 * Copy or move a real local tree and inspect the original root completion.
 *
 * @param {string} storeType - Destination mbox or maildir store.
 * @param {boolean} isMove - Whether each finished source message is retired.
 * @param {string} [failure=""] - Actual child-creation, maildir Finish or reentrant-write fault.
 * @param {boolean} [emptyRoot=false] - Whether only descendants have messages.
 * @returns {Promise<void>} Resolves after the copy result and cleanup checks.
 */
async function checkFolderCopy(
  storeType,
  isMove,
  failure = "",
  emptyRoot = false
) {
  const accounts = [];
  const prefs = [
    "mail.serverDefaultStoreContractID",
    "mail.server.default.storeContractID",
  ].map(name => ({
    name,
    hadValue: Services.prefs.prefHasUserValue(name),
    value: Services.prefs.getCharPref(name, ""),
  }));
  let cur;
  let held;
  let destination;
  let folderObserver;
  const makeParent = (name, type) => {
    const contract =
      type == "mbox"
        ? "@mozilla.org/msgstore/berkeleystore;1"
        : "@mozilla.org/msgstore/maildirstore;1";
    for (const { name: pref } of prefs) {
      Services.prefs.setCharPref(pref, contract);
    }
    const server = MailServices.accounts.createIncomingServer(
      name,
      `${name}.invalid`,
      "none"
    );
    server.setStringValue("storeContractID", contract);
    const account = MailServices.accounts.createAccount();
    accounts.push(account);
    account.incomingServer = server;
    const parent = server.rootMsgFolder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder(name)
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    Assert.equal(parent.msgStore.storeType, type);
    Assert.equal(server.msgStore.storeType, type);
    return parent;
  };
  const raw = name =>
    "From: sender@example.invalid\r\n" +
    `Message-ID: <${name}@folder-copy.invalid>\r\n` +
    "References: <first@example.invalid> <second@example.invalid>\r\n" +
    `Subject: ${name}\r\n\r\nExact ${name} body.\r\n`;
  const snapshot = folder =>
    [...folder.messages].map(header => ({
      key: header.messageKey,
      id: header.messageId,
      token: header.storeToken,
      size: header.messageSize,
      flags: header.flags,
      property: header.getStringProperty("folderCopyValue"),
      references: Array.from({ length: header.numReferences }, (_, i) =>
        header.getStringReference(i)
      ),
      body: mailTestUtils.loadMessageToString(folder, header),
    }));
  const summary = folder => ({
    name: folder.name,
    messages: [...folder.messages].map(header => header.messageId),
    children: [...folder.subFolders].map(summary),
  });
  try {
    const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
    const sourceParent = makeParent(
      "tree-source",
      storeType == "mbox" ? "maildir" : "mbox"
    );
    destination = makeParent("tree-destination", storeType);
    const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    );
    Assert.equal(
      "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
      native
    );
    const source = sourceParent
      .createLocalSubfolder("Tree")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const first = source
      .createLocalSubfolder("First")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const nested = first.createLocalSubfolder("Nested");
    const later = source.createLocalSubfolder("Later");
    const folders = [source, first, nested, later];
    for (const folder of folders) {
      folder.QueryInterface(Ci.nsIMsgLocalMailFolder);
      if (folder != source || !emptyRoot) {
        const header = folder.addMessage(raw(folder.name));
        folder.markMessagesRead([header], true);
        folder.markMessagesFlagged([header], true);
        header.setStringProperty("folderCopyValue", "Exact café 日本語");
      }
    }
    Assert.deepEqual(
      [...source.subFolders].map(folder => folder.name),
      ["First", "Later"]
    );
    const before = folders.map(snapshot);
    const expectedTree = summary(source);
    let expectedStatus = Cr.NS_OK;
    if (failure == "create") {
      expectedStatus = 0x80550013; // NS_MSG_FOLDER_EXISTS.
    } else if (failure == "busy") {
      expectedStatus = Cr.NS_MSG_FOLDER_BUSY;
    } else if (failure == "finish" || failure == "queued") {
      expectedStatus = Cr.NS_ERROR_FILE_DESTINATION_NOT_DIR;
    }
    let starts = 0;
    const stops = [];
    let treeAtStop;
    let arrivedAtStop;
    let injectionError;
    let injected = false;
    let conflict;
    let rootLockedDuringChild = false;
    let renameChecked = false;
    let renameError;
    let queuedStarts = 0;
    const queuedStops = [];
    let resolveQueued;
    const queuedDone = new Promise(resolve => {
      resolveQueued = resolve;
    });
    let resolveFault;
    const faultReached = new Promise(resolve => {
      resolveFault = resolve;
    });
    let resolveStop;
    const stopped = new Promise(resolve => {
      resolveStop = resolve;
    });
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
      onStartCopy() {
        starts++;
      },
      onProgress() {
        const arrived = destination.getChildNamed("Tree");
        if (arrived.containsChildNamed("First")) {
          rootLockedDuringChild = arrived.locked;
          if (native && !renameChecked && !failure) {
            renameChecked = true;
            try {
              arrived.rename("MustRemainTree", null);
            } catch (error) {
              renameError = error.result;
            }
          }
        }
        if (!failure || injected || injectionError) {
          return;
        }
        try {
          const copied = destination.getChildNamed("Tree");
          if (failure == "create") {
            conflict = copied
              .QueryInterface(Ci.nsIMsgLocalMailFolder)
              .createLocalSubfolder("First");
            conflict
              .QueryInterface(Ci.nsIMsgLocalMailFolder)
              .addMessage(raw("conflict"));
          } else {
            if (!copied.containsChildNamed("First")) {
              return;
            }
            const target = copied.getChildNamed("First");
            if (failure == "queued") {
              const queuedListener = {
                QueryInterface: ChromeUtils.generateQI([
                  "nsIMsgCopyServiceListener",
                ]),
                onStartCopy() {
                  queuedStarts++;
                },
                onProgress() {},
                setMessageKey() {},
                getMessageId() {
                  return "";
                },
                onStopCopy(status) {
                  queuedStops.push(status);
                  resolveQueued(status);
                },
              };
              // The exact same source/name and parent must queue until the
              // active request settles, then reach its own creation result.
              MailServices.copy.copyFolder(
                source,
                destination,
                isMove,
                queuedListener,
                null
              );
              Assert.equal(queuedStarts, 0);
            }
            cur = target.filePath.clone();
            cur.append("cur");
            held = target.filePath.clone();
            held.append("held-cur");
            // BeginCopy has issued the real write. Block its final MoveTo.
            cur.clone().moveTo(held.parent, held.leafName);
            cur.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
          }
          injected = true;
          resolveFault();
        } catch (error) {
          injectionError = error;
          resolveFault();
        }
      },
      setMessageKey() {},
      getMessageId() {
        return "";
      },
      onStopCopy(status) {
        stops.push(status);
        arrivedAtStop = MailServices.copy.getArrivedFolder(source);
        treeAtStop = summary(destination.getChildNamed("Tree"));
        resolveStop(status);
      },
    };
    let concurrent;
    if (failure == "busy") {
      const other = sourceParent
        .createLocalSubfolder("Other")
        .QueryInterface(Ci.nsIMsgLocalMailFolder);
      const otherHeader = other.addMessage(raw("concurrent"));
      concurrent = new PromiseTestUtils.PromiseCopyListener();
      folderObserver = {
        QueryInterface: ChromeUtils.generateQI(["nsIFolderListener"]),
        onMessageAdded() {},
        onFolderAdded(parent, child) {
          if (parent != destination || child.name != "Tree") {
            return;
          }
          try {
            MailServices.copy.copyMessages(
              other,
              [otherHeader],
              child,
              false,
              concurrent,
              null,
              false
            );
            injected = true;
            resolveFault();
          } catch (error) {
            injectionError = error;
            resolveFault();
          }
        },
      };
      MailServices.mailSession.AddFolderListener(
        folderObserver,
        Ci.nsIFolderListener.added
      );
    }
    let launchStatus = Cr.NS_OK;
    try {
      MailServices.copy.copyFolder(source, destination, isMove, listener, null);
    } catch (error) {
      if (failure != "busy") {
        throw error;
      }
      launchStatus = error.result;
    }
    Assert.equal(
      launchStatus,
      failure == "busy" ? Cr.NS_MSG_FOLDER_BUSY : Cr.NS_OK
    );
    const status = await stopped;
    if (failure) {
      await faultReached;
      Assert.equal(injectionError, undefined);
      Assert.ok(injected, "The real child failure boundary was reached");
    }
    const copied = destination.getChildNamed("Tree");
    if (failure == "finish" || failure == "queued") {
      // Also lets the old broken implementation release its late child write
      // before the negative control restores the directory and removes accounts.
      await TestUtils.waitForCondition(
        () => !copied.getChildNamed("First").locked
      );
    }
    if (failure == "busy") {
      await concurrent.promise;
      Assert.equal(starts, 1);
      Assert.deepEqual(stops, [Cr.NS_MSG_FOLDER_BUSY]);
      Assert.equal(status, Cr.NS_MSG_FOLDER_BUSY);
      for (let i = 0; i < folders.length; i++) {
        Assert.deepEqual(snapshot(folders[i]), before[i]);
      }
      Assert.deepEqual([...copied.subFolders], []);
      const retainedConcurrent = snapshot(copied);
      Assert.equal(
        retainedConcurrent.length,
        1,
        "The other request's copy state was not cleared"
      );
      Assert.equal(retainedConcurrent[0].body, raw("concurrent"));
      Assert.ok(!copied.locked);
      return;
    }
    Assert.equal(starts, 1);
    Assert.deepEqual(stops, [expectedStatus]);
    Assert.equal(
      arrivedAtStop,
      copied,
      "The callback retains the actual arrived root on success or child failure"
    );
    Assert.ok(
      !copied.locked,
      "The root lock is released before final completion"
    );
    if (!failure) {
      Assert.ok(
        rootLockedDuringChild,
        "The root stays busy through descendant copies"
      );
      if (native) {
        Assert.ok(renameChecked);
        Assert.equal(renameError, Cr.NS_MSG_FOLDER_BUSY);
        Assert.equal(copied.parent, destination);
        Assert.equal(copied.name, "Tree");
      }
      Assert.equal(status, Cr.NS_OK);
      Assert.deepEqual(
        treeAtStop,
        expectedTree,
        "Every descendant is finished when the root listener completes"
      );
      const targets = [
        copied,
        copied.getChildNamed("First"),
        copied.getChildNamed("First").getChildNamed("Nested"),
        copied.getChildNamed("Later"),
      ];
      for (let i = 0; i < folders.length; i++) {
        const actual = snapshot(targets[i]);
        Assert.equal(actual.length, before[i].length);
        for (let j = 0; j < actual.length; j++) {
          const { key, token, ...metadata } = actual[j];
          const { key: oldKey, token: oldToken, ...oldMetadata } = before[i][j];
          Assert.notEqual(token, "");
          Assert.notEqual(oldToken, "");
          if (native) {
            Assert.notEqual(key, oldKey);
          }
          const storedFlags = ~(
            Ci.nsMsgMessageFlags.New | Ci.nsMsgMessageFlags.Offline
          );
          Assert.equal(
            metadata.flags & storedFlags,
            oldMetadata.flags & storedFlags
          );
          Assert.equal(metadata.flags & Ci.nsMsgMessageFlags.Offline, 0);
          metadata.flags = oldMetadata.flags;
          Assert.deepEqual(metadata, oldMetadata);
        }
        Assert.deepEqual(snapshot(folders[i]), isMove ? [] : before[i]);
        Assert.ok(!targets[i].locked);
      }
    } else {
      const expected =
        failure == "create" ? 0x80550013 : Cr.NS_ERROR_FILE_DESTINATION_NOT_DIR;
      Assert.equal(
        status,
        expected,
        "The first real child error is the root result"
      );
      Assert.ok(
        !copied.containsChildNamed("Later"),
        "No later child launches after failure"
      );
      for (let i = 1; i < folders.length; i++) {
        Assert.deepEqual(
          snapshot(folders[i]),
          before[i],
          "Failed and unstarted sources keep their exact bodies and identities"
        );
      }
      Assert.deepEqual(snapshot(source), isMove ? [] : before[0]);
      const firstTarget = copied.getChildNamed("First");
      Assert.ok(!firstTarget.containsChildNamed("Nested"));
      if (failure == "create") {
        Assert.equal(firstTarget, conflict);
        const existing = [...firstTarget.messages];
        Assert.equal(existing.length, 1);
        Assert.equal(
          mailTestUtils.loadMessageToString(firstTarget, existing[0]),
          raw("conflict")
        );
      } else {
        Assert.deepEqual([...firstTarget.messages], []);
      }
      const retry = new PromiseTestUtils.PromiseCopyListener();
      MailServices.copy.copyMessages(
        first,
        [...first.messages],
        destination,
        false,
        retry,
        null,
        false
      );
      await retry.promise;
      Assert.deepEqual(
        stops,
        [expected],
        "The root callback is not replayed by the next request"
      );
      const next = snapshot(destination);
      Assert.equal(
        next.length,
        1,
        "A subsequent request to the same parent is not stuck behind this folder request"
      );
      Assert.equal(next[0].body, before[1][0].body);
      Assert.deepEqual(snapshot(first), before[1]);
      if (failure == "queued") {
        const queuedStatus = await queuedDone;
        Assert.equal(
          queuedStarts,
          1,
          "The queued operation actually starts after the first failure"
        );
        Assert.equal(
          queuedStatus,
          0x80550013,
          "The queued operation reports its own folder-exists result"
        );
        Assert.deepEqual(queuedStops, [0x80550013]);
        Assert.deepEqual(stops, [expected]);
      }
      const finishedRoot = snapshot(copied);
      Assert.equal(
        finishedRoot.length,
        before[0].length,
        "Completed root copy is retained"
      );
      if (finishedRoot.length) {
        Assert.equal(finishedRoot[0].body, before[0][0].body);
        Assert.equal(finishedRoot[0].id, before[0][0].id);
      }
    }
  } finally {
    if (folderObserver) {
      MailServices.mailSession.RemoveFolderListener(folderObserver);
    }
    if (destination) {
      // A failing negative control must not remove an account under a late
      // child write. This wait is cleanup, after the completion assertions.
      await TestUtils.waitForCondition(() =>
        [...destination.descendants].every(folder => !folder.locked)
      );
    }
    if (held?.exists()) {
      Assert.ok(cur.isFile());
      Assert.equal(cur.fileSize, 0);
      cur.remove(false);
      held.moveTo(held.parent, "cur");
    }
    for (const account of accounts.reverse()) {
      MailServices.accounts.removeAccount(account, false);
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

add_task(async function test_copyTreeToMbox() {
  await checkFolderCopy("mbox", false);
});
add_task(async function test_moveTreeToMbox() {
  await checkFolderCopy("mbox", true);
});
add_task(async function test_copyTreeToMaildir() {
  await checkFolderCopy("maildir", false);
});
add_task(async function test_moveTreeToMaildir() {
  await checkFolderCopy("maildir", true);
});
add_task(async function test_copyEmptyRootToMbox() {
  await checkFolderCopy("mbox", false, "", true);
});
add_task(async function test_moveEmptyRootToMaildir() {
  await checkFolderCopy("maildir", true, "", true);
});
add_task(async function test_copyChildCreationErrorMbox() {
  await checkFolderCopy("mbox", false, "create");
});
add_task(async function test_moveChildCreationErrorMbox() {
  await checkFolderCopy("mbox", true, "create");
});
add_task(async function test_copyChildCreationErrorMaildir() {
  await checkFolderCopy("maildir", false, "create");
});
add_task(async function test_moveChildCreationErrorMaildir() {
  await checkFolderCopy("maildir", true, "create");
});
add_task(async function test_copyChildFinishError() {
  await checkFolderCopy("maildir", false, "finish");
});
add_task(async function test_moveChildFinishError() {
  await checkFolderCopy("maildir", true, "finish");
});

add_task(async function test_reentrantCopyKeepsMboxWrite() {
  await checkFolderCopy("mbox", false, "busy");
});
add_task(async function test_reentrantCopyKeepsMaildirWrite() {
  await checkFolderCopy("maildir", false, "busy");
});

add_task(async function test_queuedCopyKeepsItsOwnError() {
  await checkFolderCopy("maildir", false, "queued");
});
add_task(async function test_queuedMoveKeepsItsOwnError() {
  await checkFolderCopy("maildir", true, "queued");
});
