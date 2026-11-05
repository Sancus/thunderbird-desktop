/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

const [popDaemon, popServer, popHandler] = setupServerDaemon();
popHandler.kUsername = "partial-user";
popHandler.kPassword = "password";
popServer.start();
registerCleanupFunction(() => popServer.stop());

const PARTIAL =
  "From: partial@example.invalid\r\n" +
  "To: original@example.invalid\r\n" +
  "Subject: Partial shell\r\n" +
  "Message-ID: <completed-partial@example.invalid>\r\n" +
  "Date: Wed, 10 Jun 2026 12:00:00 +0000\r\n" +
  "References: <old-root@example.invalid>\r\n\r\n" +
  "Truncated body.\r\n";
const COMPLETE =
  "From: complete@example.invalid\r\n" +
  "To: recipient@example.invalid\r\n" +
  "Cc: copy@example.invalid\r\n" +
  "Bcc: hidden@example.invalid\r\n" +
  "Subject: Completed partial\r\n" +
  "Message-ID: <completed-partial@example.invalid>\r\n" +
  "Date: Wed, 10 Jun 2026 13:00:00 +0000\r\n" +
  "References: <root@example.invalid> <parent@example.invalid> <root@example.invalid>\r\n" +
  "Content-Type: text/plain; charset=UTF-8\r\n\r\n" +
  "Completed body.\r\nSecond completed line.\r\n";

/**
 * Run with a real deferred POP3 account and selected local store.
 *
 * @param {string} store - Store type.
 * @param {function(nsIPop3IncomingServer, nsIMsgLocalMailFolder): Promise<void>} check
 */
async function withPartialStore(store, check) {
  const prefs = [
    "mail.serverDefaultStoreContractID",
    "mail.server.default.storeContractID",
  ].map(name => ({
    name,
    hadValue: Services.prefs.prefHasUserValue(name),
    value: Services.prefs.getCharPref(name, ""),
  }));
  localAccountUtils.clearAll();
  let account;
  try {
    for (const { name } of prefs) {
      Services.prefs.setCharPref(
        name,
        store == "mbox"
          ? "@mozilla.org/msgstore/berkeleystore;1"
          : "@mozilla.org/msgstore/maildirstore;1"
      );
    }
    localAccountUtils.loadLocalMailAccount();
    const created = localAccountUtils.create_incoming_server_and_account(
      "pop3",
      popServer.port,
      "partial-user",
      "password"
    );
    account = created.account;
    const folder = localAccountUtils.inboxFolder;
    Assert.ok(
      Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
        Ci.nsIMsgDBService
      ) instanceof Ci.nsIDatabaseCore
    );
    Assert.equal(folder.msgStore.storeType, store);
    Assert.equal(folder.server.msgStore.storeType, store);
    Assert.equal(created.server.msgStore.storeType, store);
    Assert.equal(
      created.server.deferredToAccount,
      localAccountUtils.msgAccount.key
    );
    await check(created.server, folder);
  } finally {
    try {
      if (account) {
        MailServices.accounts.removeAccount(account);
      }
    } finally {
      try {
        localAccountUtils.clearAll();
      } finally {
        for (const { name, hadValue, value } of prefs) {
          if (hadValue) {
            Services.prefs.setCharPref(name, value);
          } else {
            Services.prefs.clearUserPref(name);
          }
        }
      }
    }
  }
}

/**
 * Pass literal message bytes through the native POP3 sink/provider path.
 *
 * @param {nsIPop3IncomingServer} incoming - POP3 account.
 * @param {nsIMsgLocalMailFolder} folder - Destination folder.
 * @param {string} raw - Message bytes.
 * @param {number} flags - Incoming flags.
 * @param {string} [originalURI=""] - Explicit physical Partial identity.
 * @returns {nsIPop3Sink} Sink with a message awaiting completion.
 */
function beginPartialDelivery(incoming, folder, raw, flags, originalURI = "") {
  const sink = Cc["@mozilla.org/messenger/pop3-sink;1"].createInstance(
    Ci.nsIPop3Sink
  );
  sink.popServer = incoming;
  sink.folder = folder;
  sink.origMessageUri = originalURI;
  sink.buildMessageUri = !!originalURI;
  sink.baseMessageUri = folder.baseMessageURI;
  sink.beginMailDelivery(true, null);
  try {
    sink.incorporateBegin("completion-uidl", flags);
    for (const line of raw.match(/[^\n]*\n/g)) {
      sink.incorporateWrite(line, line.length);
    }
    return sink;
  } catch (error) {
    try {
      sink.abortMailDelivery(null);
    } catch {
      // The original write/setup error remains the test failure.
    }
    throw error;
  }
}

/**
 * Complete the source Partial or retain it after a reached SQL failure.
 *
 * @param {string} store - Store type.
 * @param {boolean} failSettlement - Abort the actual same-key metadata update.
 */
async function checkPartialCompletion(store, failSettlement) {
  await withPartialStore(store, async (incoming, folder) => {
    const initial = beginPartialDelivery(
      incoming,
      folder,
      PARTIAL,
      Ci.nsMsgMessageFlags.Partial
    );
    let initialFinished = false;
    try {
      initial.incorporateComplete(null, COMPLETE.length);
      initial.endMailDelivery(null);
      initialFinished = true;
    } finally {
      if (!initialFinished) {
        try {
          initial.abortMailDelivery(null);
        } catch {
          // The original setup exception remains the test failure.
        }
      }
    }
    const [header] = [...folder.messages];
    Assert.ok(header.flags & Ci.nsMsgMessageFlags.Partial);
    header.flags =
      (header.flags |
        Ci.nsMsgMessageFlags.Read |
        Ci.nsMsgMessageFlags.Marked |
        Ci.nsMsgMessageFlags.Replied) &
      ~Ci.nsMsgMessageFlags.New;
    header.priority = Ci.nsMsgPriority.high;
    header.setStringProperty("keywords", "$label1 complete-tag");
    header.setStringProperty("opaque empty", "");
    header.setStringProperty("opaque text", "0007");
    const key = header.messageKey;
    const token = header.storeToken;
    const flags = header.flags;
    const size = header.messageSize;
    const lines = header.lineCount;
    const oldRaw = mailTestUtils.loadMessageToString(folder, header);
    Assert.ok(oldRaw.endsWith(PARTIAL));
    const uri = folder.getUriForMsg(header);
    const added = [];
    const listener = {
      msgAdded(addedHeader) {
        if (addedHeader.folder == folder) {
          added.push(addedHeader.messageKey);
        }
      },
    };
    MailServices.mfn.addListener(listener, MailServices.mfn.msgAdded);
    const connection = Cc["@mozilla.org/mailnews/database-core;1"].getService(
      Ci.nsIDatabaseCore
    ).connectionForTests;
    let faults = 0;
    let sink;
    let deliveryFinished = false;
    try {
      if (failSettlement) {
        connection.createFunction("partial_completion_fault", 0, {
          onFunctionCall() {
            faults++;
            return 0;
          },
        });
        connection.executeSimpleSQL(
          "CREATE TEMP TRIGGER partial_completion_fault BEFORE UPDATE OF subject ON main.messages " +
            `WHEN OLD.id = ${key} BEGIN SELECT partial_completion_fault(); ` +
            "SELECT RAISE(ABORT, 'Partial completion metadata failed'); END"
        );
      }
      sink = beginPartialDelivery(incoming, folder, COMPLETE, 0, uri);
      Assert.ok(!sink.confirmedPartialCompletion);
      if (failSettlement) {
        Assert.throws(
          () => sink.incorporateComplete(null, COMPLETE.length),
          error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
        );
        Assert.equal(faults, 1);
        Assert.ok(
          !sink.confirmedPartialCompletion,
          "Failed SQL is not a receipt"
        );
        Assert.throws(
          () => sink.incorporateComplete(null, COMPLETE.length),
          error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
        );
        Assert.throws(
          () => sink.abortMailDelivery(null),
          error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
        );
        deliveryFinished = true;
        const retained = folder.msgDatabase.getMsgHdrForKey(key);
        Assert.equal(retained.storeToken, token);
        Assert.equal(retained.messageSize, size);
        Assert.equal(retained.lineCount, lines);
        Assert.equal(retained.offlineMessageSize, 0);
        Assert.equal(retained.author, "partial@example.invalid");
        Assert.equal(retained.recipients, "original@example.invalid");
        Assert.equal(retained.date, Date.parse("2026-06-10T12:00:00Z") * 1000);
        Assert.equal(retained.numReferences, 1);
        Assert.equal(
          retained.getStringReference(0),
          "old-root@example.invalid"
        );
        Assert.equal(retained.flags, flags);
        Assert.equal(retained.subject, "Partial shell");
        Assert.equal(
          mailTestUtils.loadMessageToString(folder, retained),
          oldRaw
        );
        const scan = new PromiseTestUtils.PromiseStoreScanListener();
        folder.msgStore.asyncScan(folder, scan);
        await scan.promise;
        Assert.equal(scan.messages.length, 2);
        Assert.ok(scan.messages.includes(oldRaw));
        Assert.equal(
          scan.messages.filter(raw => raw.endsWith(COMPLETE)).length,
          1
        );
      } else {
        sink.incorporateComplete(null, COMPLETE.length);
        Assert.ok(sink.confirmedPartialCompletion);
        sink.endMailDelivery(null);
        Assert.ok(sink.confirmedPartialCompletion);
        deliveryFinished = true;
        const completed = folder.msgDatabase.getMsgHdrForKey(key);
        Assert.equal(sink.messageUri, uri);
        Assert.equal(completed.subject, "Completed partial");
        Assert.equal(completed.author, "complete@example.invalid");
        Assert.equal(completed.recipients, "recipient@example.invalid");
        Assert.equal(completed.ccList, "copy@example.invalid");
        Assert.equal(completed.bccList, "hidden@example.invalid");
        Assert.equal(completed.date, Date.parse("2026-06-10T13:00:00Z") * 1000);
        Assert.equal(completed.charset, "UTF-8");
        Assert.equal(
          completed.getStringProperty("dateReceived"),
          Math.trunc(Date.parse("2026-06-10T13:00:00Z") / 1000).toString(16)
        );
        Assert.equal(
          completed.flags,
          flags & ~(Ci.nsMsgMessageFlags.Partial | Ci.nsMsgMessageFlags.Offline)
        );
        Assert.equal(completed.numReferences, 3);
        Assert.deepEqual(
          Array.from({ length: completed.numReferences }, (_, i) =>
            completed.getStringReference(i)
          ),
          [
            "root@example.invalid",
            "parent@example.invalid",
            "root@example.invalid",
          ]
        );
        const raw = mailTestUtils.loadMessageToString(folder, completed);
        Assert.ok(raw.endsWith(COMPLETE));
        Assert.equal(completed.messageSize, raw.length);
        Assert.equal(completed.lineCount, 2);
        Assert.equal(completed.offlineMessageSize, 0);
        Assert.notEqual(completed.storeToken, token);
      }
      Assert.deepEqual(
        added,
        [],
        "Completion publishes no new message identity"
      );
      Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
      const current = folder.msgDatabase.getMsgHdrForKey(key);
      Assert.equal(current.priority, Ci.nsMsgPriority.high);
      Assert.equal(
        current.getStringProperty("keywords"),
        "$label1 complete-tag"
      );
      Assert.ok(current.properties.includes("opaque empty"));
      Assert.equal(current.getStringProperty("opaque empty"), "");
      Assert.equal(current.getStringProperty("opaque text"), "0007");
      Assert.ok(!folder.locked);
    } finally {
      MailServices.mfn.removeListener(listener);
      try {
        if (failSettlement) {
          connection.executeSimpleSQL(
            "DROP TRIGGER IF EXISTS temp.partial_completion_fault"
          );
          connection.removeFunction("partial_completion_fault");
        }
      } finally {
        if (sink && !deliveryFinished) {
          try {
            sink.abortMailDelivery(null);
          } catch {
            // Cleanup retains the original completion failure.
          }
        }
      }
    }
  });
}

add_task(async function test_pop3CompletePartialSameKeyMbox() {
  await checkPartialCompletion("mbox", false);
});

add_task(async function test_pop3CompletePartialSameKeyMaildir() {
  await checkPartialCompletion("maildir", false);
});

add_task(async function test_pop3CompletePartialSqlFailureMbox() {
  await checkPartialCompletion("mbox", true);
});

add_task(async function test_pop3CompletePartialSqlFailureMaildir() {
  await checkPartialCompletion("maildir", true);
});

/**
 * Seed a Partial through the normal native sink, then release its folder lock.
 *
 * @param {nsIPop3IncomingServer} incoming - Source POP3 account.
 * @param {nsIMsgLocalMailFolder} folder - Physical message folder.
 * @returns {nsIMsgDBHdr} Published Partial header.
 */
function seedPartial(incoming, folder) {
  const sink = beginPartialDelivery(
    incoming,
    folder,
    PARTIAL,
    Ci.nsMsgMessageFlags.Partial
  );
  let finished = false;
  try {
    sink.incorporateComplete(null, COMPLETE.length);
    sink.endMailDelivery(null);
    finished = true;
    return [...folder.messages][0];
  } finally {
    if (!finished) {
      try {
        sink.abortMailDelivery(null);
      } catch {
        // Preserve the original setup failure.
      }
    }
  }
}

/**
 * Reject an explicit physical source whose server identity does not match.
 *
 * @param {string} store - Store type.
 * @param {boolean} foreignAccount - Use a different actual POP3 account.
 */
async function checkPartialIdentityRejected(store, foreignAccount) {
  await withPartialStore(store, async (incoming, folder) => {
    const original = seedPartial(incoming, folder);
    const key = original.messageKey;
    const token = original.storeToken;
    const flags = original.flags;
    const raw = mailTestUtils.loadMessageToString(folder, original);
    let other;
    const sink = Cc["@mozilla.org/messenger/pop3-sink;1"].createInstance(
      Ci.nsIPop3Sink
    );
    let started = false;
    let finished = false;
    try {
      if (foreignAccount) {
        other = localAccountUtils.create_incoming_server_and_account(
          "pop3",
          popServer.port,
          "another-partial-user",
          "password"
        );
        Assert.notEqual(
          other.account.key,
          MailServices.accounts.findAccountForServer(incoming).key
        );
        Assert.equal(other.server.msgStore.storeType, store);
      }
      sink.popServer = other?.server ?? incoming;
      sink.folder = folder;
      sink.origMessageUri = folder.getUriForMsg(original);
      sink.beginMailDelivery(true, null);
      started = true;
      const uidl = foreignAccount ? "completion-uidl" : "different-uidl";
      Assert.throws(
        () => sink.incorporateBegin(uidl, 0),
        error => error.result == Cr.NS_ERROR_INVALID_ARG
      );
      Assert.throws(
        () => sink.incorporateBegin("completion-uidl", 0),
        error => error.result == Cr.NS_ERROR_INVALID_ARG,
        "A rejected source does not authorize retrying the same delivery"
      );
      Assert.throws(
        () => sink.abortMailDelivery(null),
        error => error.result == Cr.NS_ERROR_INVALID_ARG
      );
      finished = true;
      const current = folder.msgDatabase.getMsgHdrForKey(key);
      Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
      Assert.equal(current.storeToken, token);
      Assert.equal(current.flags, flags);
      Assert.ok(current.flags & Ci.nsMsgMessageFlags.Partial);
      Assert.equal(mailTestUtils.loadMessageToString(folder, current), raw);
      const scan = new PromiseTestUtils.PromiseStoreScanListener();
      folder.msgStore.asyncScan(folder, scan);
      await scan.promise;
      Assert.deepEqual(scan.messages, [raw]);
      Assert.ok(!folder.locked);
    } finally {
      try {
        if (started && !finished) {
          try {
            sink.abortMailDelivery(null);
          } catch {
            // Preserve the original source-validation failure.
          }
        }
      } finally {
        if (other) {
          MailServices.accounts.removeAccount(other.account);
        }
      }
    }
  });
}

/**
 * Count the finished body without truncating the parser's uint16 line counter.
 *
 * @param {string} store - Store type.
 */
async function checkPartialFullLineCount(store) {
  await withPartialStore(store, async (incoming, folder) => {
    const original = seedPartial(incoming, folder);
    const key = original.messageKey;
    const uri = folder.getUriForMsg(original);
    const raw =
      COMPLETE.slice(0, COMPLETE.indexOf("\r\n\r\n") + 4).replace(
        "completed-partial@example.invalid",
        "replacement-id@example.invalid"
      ) + "x\r\n".repeat(65537);
    const updated = [];
    const observer = (subject, _topic, data) => {
      const current = folder.msgDatabase.getMsgHdrForKey(key);
      updated.push({
        original: subject.QueryInterface(Ci.nsISupportsString).data,
        completed: data,
        key: current.messageKey,
        lines: current.lineCount,
        token: current.storeToken,
        partial: !!(current.flags & Ci.nsMsgMessageFlags.Partial),
      });
    };
    Services.obs.addObserver(observer, "message-content-updated");
    let sink;
    let finished = false;
    try {
      sink = beginPartialDelivery(incoming, folder, raw, 0, uri);
      sink.incorporateComplete(null, raw.length);
      sink.endMailDelivery(null);
      finished = true;
      const current = folder.msgDatabase.getMsgHdrForKey(key);
      const stored = mailTestUtils.loadMessageToString(folder, current);
      Assert.ok(stored.endsWith(raw));
      Assert.equal(current.messageSize, stored.length);
      Assert.equal(current.messageId, "replacement-id@example.invalid");
      Assert.equal(current.lineCount, 65537);
      Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
      Assert.deepEqual(updated, [
        {
          original: uri,
          completed: uri,
          key,
          lines: 65537,
          token: current.storeToken,
          partial: false,
        },
      ]);
    } finally {
      Services.obs.removeObserver(observer, "message-content-updated");
      if (sink && !finished) {
        try {
          sink.abortMailDelivery(null);
        } catch {
          // Preserve the original completion failure.
        }
      }
    }
  });
}

add_task(async function test_pop3CompletePartialWrongUidlMbox() {
  await checkPartialIdentityRejected("mbox", false);
});

add_task(async function test_pop3CompletePartialWrongUidlMaildir() {
  await checkPartialIdentityRejected("maildir", false);
});

add_task(async function test_pop3CompletePartialWrongAccountMbox() {
  await checkPartialIdentityRejected("mbox", true);
});

add_task(async function test_pop3CompletePartialWrongAccountMaildir() {
  await checkPartialIdentityRejected("maildir", true);
});

add_task(async function test_pop3CompletePartialFullLineCountMbox() {
  await checkPartialFullLineCount("mbox");
});

add_task(async function test_pop3CompletePartialFullLineCountMaildir() {
  await checkPartialFullLineCount("maildir");
});

/**
 * Install an ordinary unconditional InboxRule and retain it for cleanup.
 *
 * @param {nsIMsgFilterList} list - Actual account filter list.
 * @param {{type: number, strValue?: string,
 *   targetFolderUri?: string}[]} actions - Rule action fields.
 * @returns {nsIMsgFilter} Installed rule.
 */
function addCompletedPartialFilter(list, actions) {
  const filter = list.createFilter("Completed Partial actions");
  const term = filter.createTerm();
  term.matchAll = true;
  filter.appendTerm(term);
  for (const properties of actions) {
    const action = filter.createAction();
    Object.assign(action, properties);
    filter.appendAction(action);
  }
  filter.enabled = true;
  filter.filterType = Ci.nsMsgFilterType.InboxRule;
  list.insertFilterAt(list.filterCount, filter);
  return filter;
}

/**
 * Exercise completed-row filtering after the actual provider/SQL settlement.
 *
 * @param {string} store - Store type.
 * @param {string} mode - Supported, action-error, move, or single-UIDL.
 */
async function checkCompletedPartialFilters(store, mode) {
  await withPartialStore(store, async (incoming, folder) => {
    const original = seedPartial(incoming, folder);
    original.flags =
      Ci.nsMsgMessageFlags.Partial | Ci.nsMsgMessageFlags.Replied;
    original.setStringProperty("keywords", "$label1 complete-tag");
    original.setStringProperty("opaque empty", "");
    original.setStringProperty("opaque text", "0007");
    const key = original.messageKey;
    const oldToken = original.storeToken;
    const oldRaw = mailTestUtils.loadMessageToString(folder, original);
    const uri = folder.getUriForMsg(original);
    const filters = incoming.getFilterList(null);
    const deferredFilters = folder.server.getFilterList(null);
    const installed = [];
    const add = (list, actions) => {
      const filter = addCompletedPartialFilter(list, actions);
      installed.push([list, filter]);
      return filter;
    };
    const connection = Cc["@mozilla.org/mailnews/database-core;1"].getService(
      Ci.nsIDatabaseCore
    ).connectionForTests;
    const added = [];
    const listener = {
      msgAdded(header) {
        if (header.folder == folder) {
          added.push(header.messageKey);
        }
      },
    };
    MailServices.mfn.addListener(listener, MailServices.mfn.msgAdded);
    let destination;
    let faults = 0;
    let sink;
    let started = false;
    let finished = false;
    let triggerInstalled = false;
    let faultFunctionInstalled = false;
    try {
      if (mode == "supported") {
        add(filters, [
          { type: Ci.nsMsgFilterAction.FetchBodyFromPop3Server },
          { type: Ci.nsMsgFilterAction.AddTag, strValue: "partial-filter-tag" },
          { type: Ci.nsMsgFilterAction.MarkRead },
          { type: Ci.nsMsgFilterAction.StopExecution },
        ]);
        add(filters, [
          { type: Ci.nsMsgFilterAction.AddTag, strValue: "must-not-run" },
        ]);
        add(deferredFilters, [
          { type: Ci.nsMsgFilterAction.MarkFlagged },
          {
            type: Ci.nsMsgFilterAction.AddTag,
            strValue: "deferred-filter-tag",
          },
        ]);
      } else if (mode == "action-error") {
        add(filters, [
          { type: Ci.nsMsgFilterAction.MarkFlagged },
          { type: Ci.nsMsgFilterAction.AddTag, strValue: "must-not-run" },
        ]);
        add(deferredFilters, [
          { type: Ci.nsMsgFilterAction.AddTag, strValue: "must-not-run" },
        ]);
        connection.createFunction("partial_filter_fault", 0, {
          onFunctionCall() {
            faults++;
            return 0;
          },
        });
        faultFunctionInstalled = true;
        connection.executeSimpleSQL(
          "CREATE TEMP TRIGGER partial_filter_fault BEFORE UPDATE OF flags ON main.messages " +
            `WHEN NEW.id = ${key} AND (NEW.flags & ${Ci.nsMsgMessageFlags.Marked}) != 0 ` +
            "BEGIN SELECT partial_filter_fault(); " +
            "SELECT RAISE(ABORT, 'Completed Partial filter failed'); END"
        );
        triggerInstalled = true;
      } else {
        destination = folder.parent
          .QueryInterface(Ci.nsIMsgLocalMailFolder)
          .createLocalSubfolder("HeldPartialMove");
        add(filters, [
          { type: Ci.nsMsgFilterAction.MarkRead },
          { type: Ci.nsMsgFilterAction.AddTag, strValue: "must-not-run" },
          {
            type: Ci.nsMsgFilterAction.MoveToFolder,
            targetFolderUri: destination.URI,
          },
        ]);
      }
      sink = Cc["@mozilla.org/messenger/pop3-sink;1"].createInstance(
        Ci.nsIPop3Sink
      );
      sink.popServer = incoming;
      sink.folder = folder;
      sink.origMessageUri = uri;
      sink.beginMailDelivery(mode == "single-UIDL", null);
      started = true;
      sink.incorporateBegin("completion-uidl", 0);
      for (const line of COMPLETE.match(/[^\n]*\n/g)) {
        sink.incorporateWrite(line, line.length);
      }
      if (mode == "move") {
        const stops = [];
        const stopped = Promise.withResolvers();
        sink.incorporateComplete(null, COMPLETE.length, {
          onStopOperation(status) {
            stops.push(status);
            stopped.resolve(status);
          },
        });
        Assert.equal(await stopped.promise, Cr.NS_OK);
        sink.endMailDelivery(null);
        finished = true;
        Assert.deepEqual(stops, [Cr.NS_OK]);
        Assert.ok(sink.confirmedPartialCompletion);
        Assert.deepEqual(folder.msgDatabase.listAllKeys(), []);
        const moved = [...destination.messages];
        Assert.equal(moved.length, 1);
        const current = moved[0];
        Assert.equal(current.folder, destination);
        Assert.notEqual(current.messageKey, key);
        Assert.ok(current.storeToken);
        Assert.equal(current.subject, "Completed partial");
        Assert.equal(current.author, "complete@example.invalid");
        Assert.equal(
          current.flags,
          Ci.nsMsgMessageFlags.Replied | Ci.nsMsgMessageFlags.Read
        );
        Assert.equal(
          current.getStringProperty("keywords"),
          "$label1 complete-tag must-not-run"
        );
        Assert.equal(current.getStringProperty("opaque empty"), "");
        Assert.equal(current.getStringProperty("opaque text"), "0007");
        const raw = mailTestUtils.loadMessageToString(destination, current);
        Assert.ok(raw.endsWith(COMPLETE));
        Assert.ok(raw.includes("X-UIDL: completion-uidl"));
        Assert.equal(current.messageSize, raw.length);
        Assert.equal(current.lineCount, 2);
        Assert.equal(current.offlineMessageSize, 0);
        const scan = new PromiseTestUtils.PromiseStoreScanListener();
        folder.msgStore.asyncScan(folder, scan);
        await scan.promise;
        Assert.equal(scan.messages[scan.tokens.indexOf(oldToken)], oldRaw);
        // The old shell is retained; the completed source has been retired.
        Assert.equal(scan.messages.length, store == "mbox" ? 2 : 1);
        Assert.deepEqual(added, []);
        Assert.equal(faults, 0);
        Assert.ok(!folder.locked);
        Assert.ok(!destination.locked);
        return;
      }
      let error;
      if (mode == "action-error") {
        error = Cr.NS_ERROR_STORAGE_CONSTRAINT;
      } else if (mode == "unsupported") {
        error = Cr.NS_ERROR_NOT_IMPLEMENTED;
      } else {
        error = Cr.NS_OK;
      }
      if (error == Cr.NS_OK) {
        sink.incorporateComplete(null, COMPLETE.length);
        Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
        Assert.ok(
          !(
            folder.msgDatabase.getMsgHdrForKey(key).flags &
            Ci.nsMsgMessageFlags.Partial
          )
        );
        sink.endMailDelivery(null);
      } else {
        Assert.throws(
          () => sink.incorporateComplete(null, COMPLETE.length),
          exception => exception.result == error
        );
        Assert.throws(
          () => sink.incorporateComplete(null, COMPLETE.length),
          exception => exception.result == error,
          "Filtering failure cannot replay Finish"
        );
        Assert.throws(
          () => sink.abortMailDelivery(null),
          exception => exception.result == error
        );
      }
      finished = true;
      Assert.equal(faults, mode == "action-error" ? 1 : 0);
      const completed = folder.msgDatabase.getMsgHdrForKey(key);
      Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
      Assert.notEqual(completed.storeToken, oldToken);
      Assert.equal(completed.subject, "Completed partial");
      Assert.equal(completed.author, "complete@example.invalid");
      Assert.equal(completed.lineCount, 2);
      Assert.equal(completed.offlineMessageSize, 0);
      Assert.equal(
        completed.flags,
        Ci.nsMsgMessageFlags.Replied |
          (mode == "supported"
            ? Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked
            : 0)
      );
      Assert.equal(completed.priority, Ci.nsMsgPriority.none);
      Assert.equal(
        completed.getStringProperty("keywords"),
        mode == "supported"
          ? "$label1 complete-tag partial-filter-tag deferred-filter-tag"
          : "$label1 complete-tag"
      );
      Assert.ok(completed.properties.includes("opaque empty"));
      Assert.equal(completed.getStringProperty("opaque empty"), "");
      Assert.equal(completed.getStringProperty("opaque text"), "0007");
      const raw = mailTestUtils.loadMessageToString(folder, completed);
      Assert.ok(raw.endsWith(COMPLETE));
      Assert.equal(completed.messageSize, raw.length);
      const scan = new PromiseTestUtils.PromiseStoreScanListener();
      folder.msgStore.asyncScan(folder, scan);
      await scan.promise;
      Assert.equal(scan.messages.length, 2);
      Assert.equal(scan.messages[scan.tokens.indexOf(oldToken)], oldRaw);
      Assert.equal(
        scan.messages.filter(message => message.endsWith(COMPLETE)).length,
        1
      );
      if (destination) {
        Assert.deepEqual(destination.msgDatabase.listAllKeys(), []);
      }
      Assert.deepEqual(added, []);
      Assert.ok(!folder.locked);
    } finally {
      MailServices.mfn.removeListener(listener);
      try {
        if (triggerInstalled) {
          connection.executeSimpleSQL("DROP TRIGGER temp.partial_filter_fault");
        }
      } finally {
        try {
          if (faultFunctionInstalled) {
            connection.removeFunction("partial_filter_fault");
          }
        } finally {
          try {
            if (sink && started && !finished) {
              try {
                sink.abortMailDelivery(null);
              } catch {
                // Keep the original preparation/action failure.
              }
            }
          } finally {
            for (const [list, filter] of installed.reverse()) {
              list.removeFilter(filter);
            }
          }
        }
      }
    }
  });
}

add_task(async function test_pop3CompletePartialFilterActionsMbox() {
  await checkCompletedPartialFilters("mbox", "supported");
});

add_task(async function test_pop3CompletePartialFilterActionsMaildir() {
  await checkCompletedPartialFilters("maildir", "supported");
});

add_task(async function test_pop3CompletePartialFilterErrorMbox() {
  await checkCompletedPartialFilters("mbox", "action-error");
});

add_task(async function test_pop3CompletePartialFilterErrorMaildir() {
  await checkCompletedPartialFilters("maildir", "action-error");
});

add_task(async function test_pop3CompletePartialFilterMoveMbox() {
  await checkCompletedPartialFilters("mbox", "move");
});

add_task(async function test_pop3CompletePartialFilterMoveMaildir() {
  await checkCompletedPartialFilters("maildir", "move");
});

add_task(
  async function test_pop3CompletePartialSingleUidlFiltersDisabledMbox() {
    await checkCompletedPartialFilters("mbox", "single-UIDL");
  }
);

add_task(
  async function test_pop3CompletePartialSingleUidlFiltersDisabledMaildir() {
    await checkCompletedPartialFilters("maildir", "single-UIDL");
  }
);

const PARTIAL_CONDITIONAL_TERM =
  "local-storage-tests@example.invalid#partial-condition";
let partialConditionalCalls = 0;

add_setup(function setupPartialConditionalTerm() {
  MailServices.filters.addCustomTerm({
    id: PARTIAL_CONDITIONAL_TERM,
    name: "Partial conditional failure",
    needsBody: false,
    getEnabled: () => true,
    getAvailable: () => true,
    getAvailableOperators: () => [Ci.nsMsgSearchOp.Is],
    match() {
      partialConditionalCalls++;
      throw Components.Exception(
        "Partial condition failed",
        Cr.NS_ERROR_FILE_ACCESS_DENIED
      );
    },
  });
});

/**
 * Add real conditional terms to the existing action fixture.
 *
 * @param {nsIMsgFilterList} list - Actual account filter list.
 * @param {{attribute: number, value: string, and?: boolean}[]} terms
 *   Attribute/value pairs and Boolean joins.
 * @param {{type: number, strValue?: string}[]} actions - Rule action fields.
 * @returns {nsIMsgFilter} Installed conditional rule.
 */
function addConditionalPartialFilter(list, terms, actions) {
  const filter = addCompletedPartialFilter(list, actions);
  filter.searchTerms = [];
  for (const { attribute, value, and = true } of terms) {
    const term = filter.createTerm();
    term.attrib = attribute;
    term.op =
      attribute == Ci.nsMsgSearchAttrib.Custom
        ? Ci.nsMsgSearchOp.Is
        : Ci.nsMsgSearchOp.Contains;
    term.booleanAnd = and;
    if (attribute == Ci.nsMsgSearchAttrib.Custom) {
      term.customId = PARTIAL_CONDITIONAL_TERM;
    }
    const searchValue = term.value;
    searchValue.attrib = attribute;
    searchValue.str = value;
    term.value = searchValue;
    filter.appendTerm(term);
  }
  return filter;
}

/**
 * Run conditional matching against the actual same-key completed body.
 *
 * @param {string} store - Store type.
 * @param {string} mode - Normal, failure, or short-circuit expression.
 */
async function checkPartialConditionalFilters(store, mode) {
  await withPartialStore(store, async (incoming, folder) => {
    const original = seedPartial(incoming, folder);
    original.flags =
      Ci.nsMsgMessageFlags.Partial | Ci.nsMsgMessageFlags.Replied;
    original.setStringProperty("keywords", "retained-tag");
    original.setStringProperty("literal empty", "");
    const key = original.messageKey;
    const token = original.storeToken;
    const oldRaw = mailTestUtils.loadMessageToString(folder, original);
    const uri = folder.getUriForMsg(original);
    const origin = incoming.getFilterList(null);
    const deferred = folder.server.getFilterList(null);
    const rules = [];
    const add = (list, terms, actions) => {
      const filter = addConditionalPartialFilter(list, terms, actions);
      rules.push([list, filter]);
    };
    let sink;
    let started = false;
    let finished = false;
    try {
      if (mode == "normal") {
        add(
          origin,
          [{ attribute: Ci.nsMsgSearchAttrib.Body, value: "Completed body." }],
          [{ type: Ci.nsMsgFilterAction.AddTag, strValue: "body-hit" }]
        );
      } else if (mode == "failure") {
        add(
          origin,
          [{ attribute: Ci.nsMsgSearchAttrib.Custom, value: "fail" }],
          [{ type: Ci.nsMsgFilterAction.AddTag, strValue: "must-not-run" }]
        );
        add(
          origin,
          [{ attribute: Ci.nsMsgSearchAttrib.Subject, value: "Completed" }],
          [
            {
              type: Ci.nsMsgFilterAction.AddTag,
              strValue: "later-must-not-run",
            },
          ]
        );
      } else {
        add(
          origin,
          [
            { attribute: Ci.nsMsgSearchAttrib.Subject, value: "Completed" },
            {
              attribute: Ci.nsMsgSearchAttrib.Custom,
              value: "fail",
              and: false,
            },
          ],
          [{ type: Ci.nsMsgFilterAction.AddTag, strValue: "or-hit" }]
        );
      }
      add(
        origin,
        [
          { attribute: Ci.nsMsgSearchAttrib.Subject, value: "absent subject" },
          ...(mode == "short-circuit"
            ? [{ attribute: Ci.nsMsgSearchAttrib.Custom, value: "fail" }]
            : []),
        ],
        [{ type: Ci.nsMsgFilterAction.MarkRead }]
      );
      add(
        deferred,
        [
          {
            attribute: Ci.nsMsgSearchAttrib.Subject,
            value: "Completed partial",
          },
        ],
        [{ type: Ci.nsMsgFilterAction.MarkFlagged }]
      );
      partialConditionalCalls = 0;
      sink = Cc["@mozilla.org/messenger/pop3-sink;1"].createInstance(
        Ci.nsIPop3Sink
      );
      sink.popServer = incoming;
      sink.folder = folder;
      sink.origMessageUri = uri;
      sink.beginMailDelivery(false, null);
      started = true;
      sink.incorporateBegin("completion-uidl", 0);
      for (const line of COMPLETE.match(/[^\n]*\n/g)) {
        sink.incorporateWrite(line, line.length);
      }
      if (mode == "failure") {
        for (const finish of [
          () => sink.incorporateComplete(null, COMPLETE.length),
          () => sink.incorporateComplete(null, COMPLETE.length),
          () => sink.abortMailDelivery(null),
        ]) {
          Assert.throws(
            finish,
            error => error.result == Cr.NS_ERROR_FILE_ACCESS_DENIED
          );
        }
      } else {
        sink.incorporateComplete(null, COMPLETE.length);
        Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
        Assert.ok(
          !(
            folder.msgDatabase.getMsgHdrForKey(key).flags &
            Ci.nsMsgMessageFlags.Partial
          )
        );
        sink.endMailDelivery(null);
      }
      finished = true;
      Assert.equal(partialConditionalCalls, mode == "failure" ? 1 : 0);
      const completed = folder.msgDatabase.getMsgHdrForKey(key);
      Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
      Assert.notEqual(completed.storeToken, token);
      Assert.equal(completed.subject, "Completed partial");
      Assert.equal(completed.lineCount, 2);
      Assert.equal(completed.offlineMessageSize, 0);
      Assert.equal(
        completed.flags,
        Ci.nsMsgMessageFlags.Replied |
          (mode == "failure" ? 0 : Ci.nsMsgMessageFlags.Marked)
      );
      const keywords = completed.getStringProperty("keywords");
      let expectedKeywords;
      if (mode == "normal") {
        expectedKeywords = "retained-tag body-hit";
      } else if (mode == "failure") {
        expectedKeywords = "retained-tag";
      } else {
        expectedKeywords = "retained-tag or-hit";
      }
      Assert.equal(keywords, expectedKeywords);
      Assert.ok(completed.properties.includes("literal empty"));
      Assert.equal(completed.getStringProperty("literal empty"), "");
      const raw = mailTestUtils.loadMessageToString(folder, completed);
      Assert.ok(raw.endsWith(COMPLETE));
      Assert.equal(completed.messageSize, raw.length);
      const scan = new PromiseTestUtils.PromiseStoreScanListener();
      folder.msgStore.asyncScan(folder, scan);
      await scan.promise;
      Assert.equal(scan.messages.length, 2);
      Assert.equal(scan.messages[scan.tokens.indexOf(token)], oldRaw);
      for (const [, rule] of rules) {
        Assert.equal(rule.scope, null, "Conditional scope is restored");
      }
      Assert.ok(!folder.locked);
    } finally {
      try {
        if (sink && started && !finished) {
          try {
            sink.abortMailDelivery(null);
          } catch {
            // Keep the original parser/matcher/action error.
          }
        }
      } finally {
        for (const [list, rule] of rules.reverse()) {
          list.removeFilter(rule);
        }
      }
    }
  });
}

add_task(async function test_pop3CompletePartialConditionalMbox() {
  await checkPartialConditionalFilters("mbox", "normal");
});
add_task(async function test_pop3CompletePartialConditionalMaildir() {
  await checkPartialConditionalFilters("maildir", "normal");
});
add_task(async function test_pop3CompletePartialConditionalErrorMbox() {
  await checkPartialConditionalFilters("mbox", "failure");
});
add_task(async function test_pop3CompletePartialConditionalErrorMaildir() {
  await checkPartialConditionalFilters("maildir", "failure");
});
add_task(async function test_pop3CompletePartialConditionalShortCircuitMbox() {
  await checkPartialConditionalFilters("mbox", "short-circuit");
});
add_task(
  async function test_pop3CompletePartialConditionalShortCircuitMaildir() {
    await checkPartialConditionalFilters("maildir", "short-circuit");
  }
);

const { MockRegistrar: PartialCopyRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);

/**
 * Complete a real Partial with a retained copy or rejected dispatch.
 *
 * @param {string} store - Selected store.
 * @param {string} mode - Copy success, destination failure, or cancellation.
 */
async function checkPartialAsyncCopy(store, mode) {
  await withPartialStore(store, async (incoming, folder) => {
    const original = seedPartial(incoming, folder);
    const key = original.messageKey;
    const oldToken = original.storeToken;
    const oldRaw = mailTestUtils.loadMessageToString(folder, original);
    const destination = folder.parent
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder("completed-copy");
    Assert.equal(destination.msgStore.storeType, store);
    const list = incoming.getFilterList(null);
    const deferred = folder.server.getFilterList(null);
    const rule = addCompletedPartialFilter(list, [
      { type: Ci.nsMsgFilterAction.CopyToFolder },
    ]);
    const after = addCompletedPartialFilter(list, [
      { type: Ci.nsMsgFilterAction.AddTag, strValue: "after-copy" },
    ]);
    rule.getActionAt(0).targetFolderUri = destination.URI;
    const later = addCompletedPartialFilter(deferred, [
      { type: Ci.nsMsgFilterAction.MarkFlagged },
    ]);
    const contract = "@mozilla.org/messenger/messagecopyservice;1";
    const nativeCopy = Cc[contract].getService(Ci.nsIMsgCopyService);
    const nativeStopped = Promise.withResolvers();
    let release;
    let faults = 0;
    let copyCalls = 0;
    const stops = [];
    let sink;
    let cid;
    let terminal = false;
    const connection = Cc["@mozilla.org/mailnews/database-core;1"].getService(
      Ci.nsIDatabaseCore
    ).connectionForTests;
    const proxy = {
      QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyService"]),
      copyMessages(source, headers, target, move, listener, window, undo) {
        copyCalls++;
        Assert.equal(source, folder);
        Assert.equal(target, destination);
        Assert.ok(!move);
        if (mode == "reject" || mode == "reentrant-reject") {
          // Explicit service-boundary rejection control: no native transfer
          // started and no destination body/success is claimed.
          nativeStopped.resolve(Cr.NS_ERROR_FILE_ACCESS_DENIED);
          if (mode == "reentrant-reject") {
            listener.onStopCopy(Cr.NS_OK);
          }
          throw Components.Exception(
            "copy dispatch rejected",
            Cr.NS_ERROR_FILE_ACCESS_DENIED
          );
        }
        const forwarding = {
          QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
          onStartCopy() {
            listener.onStartCopy();
          },
          onProgress(...args) {
            listener.onProgress(...args);
          },
          setMessageKey(keyValue) {
            listener.setMessageKey(keyValue);
          },
          getMessageId() {
            return listener.getMessageId();
          },
          onStopCopy(status) {
            // Withhold only the actual terminal callback, never invent it.
            release = () => listener.onStopCopy(status);
            nativeStopped.resolve(status);
          },
        };
        nativeCopy.copyMessages(
          source,
          headers,
          target,
          move,
          forwarding,
          window,
          undo
        );
      },
      copyFolder(...args) {
        nativeCopy.copyFolder(...args);
      },
      copyFileMessage(...args) {
        nativeCopy.copyFileMessage(...args);
      },
      notifyCompletion(...args) {
        nativeCopy.notifyCompletion(...args);
      },
      getArrivedFolder(...args) {
        return nativeCopy.getArrivedFolder(...args);
      },
    };
    try {
      if (mode == "failure") {
        connection.createFunction("partial_copy_fault", 0, {
          onFunctionCall() {
            faults++;
            return 0;
          },
        });
        connection.executeSimpleSQL(
          "CREATE TEMP TRIGGER partial_copy_fault BEFORE INSERT ON main.messages " +
            `WHEN NEW.folderId = ${destination.id} BEGIN SELECT partial_copy_fault(); ` +
            "SELECT RAISE(ABORT, 'destination publication failed'); END"
        );
      }
      cid = PartialCopyRegistrar.register(contract, proxy);
      sink = Cc["@mozilla.org/messenger/pop3-sink;1"].createInstance(
        Ci.nsIPop3Sink
      );
      sink.popServer = incoming;
      sink.folder = folder;
      sink.origMessageUri = folder.getUriForMsg(original);
      sink.beginMailDelivery(false, null);
      sink.incorporateBegin("completion-uidl", 0);
      for (const line of COMPLETE.match(/[^\n]*\n/g)) {
        sink.incorporateWrite(line, line.length);
      }
      sink.incorporateComplete(null, 0, {
        onStopOperation(status) {
          stops.push(status);
        },
      });
      Assert.equal(
        copyCalls,
        1,
        "The registered copy service received this request"
      );
      const nativeStatus = await nativeStopped.promise;
      Assert.ok(
        sink.confirmedPartialCompletion,
        "The source row is saved before copy settlement"
      );
      const rejected = mode == "reject" || mode == "reentrant-reject";
      Assert.deepEqual(
        stops,
        rejected ? [Cr.NS_ERROR_FILE_ACCESS_DENIED] : [],
        "Dispatch return cannot hide the terminal copy status"
      );
      const completed = folder.msgDatabase.getMsgHdrForKey(key);
      const token = completed.storeToken;
      Assert.notEqual(token, oldToken);
      const completedRaw = mailTestUtils.loadMessageToString(folder, completed);
      Assert.ok(completedRaw.endsWith(COMPLETE));
      Assert.equal(completed.messageSize, completedRaw.length);
      Assert.equal(completed.lineCount, 2);
      Assert.equal(completed.offlineMessageSize, 0);
      Assert.equal(completed.getStringProperty("keywords"), "");
      Assert.ok(!(completed.flags & Ci.nsMsgMessageFlags.Marked));
      if (!rejected) {
        Assert.throws(
          () => sink.incorporateBegin("other", 0),
          error => error.result == Cr.NS_ERROR_IN_PROGRESS
        );
        Assert.throws(
          () => sink.incorporateComplete(null, 0),
          error => error.result == Cr.NS_ERROR_IN_PROGRESS
        );
        Assert.throws(
          () => sink.endMailDelivery(null),
          error => error.result == Cr.NS_ERROR_IN_PROGRESS
        );
      }
      Assert.ok(
        sink.confirmedPartialCompletion,
        "Rejected reentry retains the current outcome"
      );
      if (mode == "cancel") {
        Assert.throws(
          () => sink.incorporateAbort(),
          error => error.result == Cr.NS_BINDING_ABORTED
        );
        Assert.deepEqual(stops, [], "Cancellation waits for the accepted copy");
      }
      if (release) {
        release();
      }
      let expected;
      if (rejected) {
        expected = Cr.NS_ERROR_FILE_ACCESS_DENIED;
      } else if (mode == "cancel") {
        expected = Cr.NS_BINDING_ABORTED;
      } else if (mode == "failure") {
        expected = Cr.NS_ERROR_STORAGE_CONSTRAINT;
      } else {
        expected = Cr.NS_OK;
      }
      let expectedNativeStatus;
      if (rejected) {
        expectedNativeStatus = Cr.NS_ERROR_FILE_ACCESS_DENIED;
      } else if (mode == "failure") {
        expectedNativeStatus = Cr.NS_ERROR_STORAGE_CONSTRAINT;
      } else {
        expectedNativeStatus = Cr.NS_OK;
      }
      Assert.equal(nativeStatus, expectedNativeStatus);
      Assert.deepEqual(stops, [expected]);
      Assert.ok(
        sink.confirmedPartialCompletion,
        "Copy error/cancel retains confirmed delivery"
      );
      if (release) {
        release();
      }
      Assert.deepEqual(
        stops,
        [expected],
        "A duplicate/stale copy callback cannot finish twice"
      );
      Assert.equal(faults, mode == "failure" ? 1 : 0);
      Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
      Assert.equal(completed.storeToken, token);
      Assert.equal(
        completed.getStringProperty("keywords"),
        mode == "success" ? "after-copy" : ""
      );
      Assert.equal(
        !!(completed.flags & Ci.nsMsgMessageFlags.Marked),
        mode == "success"
      );
      const copied = [...destination.messages];
      Assert.equal(copied.length, mode == "failure" || rejected ? 0 : 1);
      if (copied.length) {
        Assert.equal(copied[0].subject, "Completed partial");
        const copiedRaw = mailTestUtils.loadMessageToString(
          destination,
          copied[0]
        );
        Assert.ok(copiedRaw.endsWith(COMPLETE));
        Assert.equal(copied[0].messageSize, copiedRaw.length);
        Assert.equal(copied[0].lineCount, 2);
        Assert.equal(copied[0].offlineMessageSize, 0);
        Assert.equal(copied[0].getStringProperty("keywords"), "");
      }
      if (mode == "success") {
        Assert.throws(
          () => sink.incorporateComplete(null, 0),
          error => error.result == Cr.NS_ERROR_ALREADY_INITIALIZED
        );
      }
      Assert.throws(
        () => sink.abortMailDelivery(null),
        error =>
          error.result ==
          (mode == "success" ? Cr.NS_ERROR_ALREADY_INITIALIZED : expected)
      );
      terminal = true;
      const scan = new PromiseTestUtils.PromiseStoreScanListener();
      folder.msgStore.asyncScan(folder, scan);
      await scan.promise;
      Assert.equal(
        scan.messages.length,
        2,
        "No repeated provider Finish/body write"
      );
      Assert.equal(scan.messages[scan.tokens.indexOf(oldToken)], oldRaw);
    } finally {
      if (release && !stops.length) {
        release();
      }
      if (sink && !terminal) {
        try {
          sink.abortMailDelivery(null);
        } catch {}
      }
      if (cid) {
        PartialCopyRegistrar.unregister(cid);
        Assert.equal(Cc[contract].getService(Ci.nsIMsgCopyService), nativeCopy);
      }
      if (mode == "failure") {
        connection.executeSimpleSQL(
          "DROP TRIGGER IF EXISTS partial_copy_fault"
        );
        connection.removeFunction("partial_copy_fault");
      }
      list.removeFilter(rule);
      list.removeFilter(after);
      deferred.removeFilter(later);
    }
  });
}

add_task(async function test_pop3PartialAsyncCopyMbox() {
  await checkPartialAsyncCopy("mbox", "success");
});
add_task(async function test_pop3PartialAsyncCopyMaildir() {
  await checkPartialAsyncCopy("maildir", "success");
});
add_task(async function test_pop3PartialAsyncCopyFailureMbox() {
  await checkPartialAsyncCopy("mbox", "failure");
});
add_task(async function test_pop3PartialAsyncCopyFailureMaildir() {
  await checkPartialAsyncCopy("maildir", "failure");
});
add_task(async function test_pop3PartialAsyncCopyCancelMbox() {
  await checkPartialAsyncCopy("mbox", "cancel");
});
add_task(async function test_pop3PartialAsyncCopyCancelMaildir() {
  await checkPartialAsyncCopy("maildir", "cancel");
});

add_task(async function test_pop3PartialCopyLaunchRejectedMbox() {
  await checkPartialAsyncCopy("mbox", "reject");
});
add_task(async function test_pop3PartialCopyLaunchRejectedMaildir() {
  await checkPartialAsyncCopy("maildir", "reject");
});
add_task(async function test_pop3PartialCopyReentrantRejectedMbox() {
  await checkPartialAsyncCopy("mbox", "reentrant-reject");
});
add_task(async function test_pop3PartialCopyReentrantRejectedMaildir() {
  await checkPartialAsyncCopy("maildir", "reentrant-reject");
});

/**
 * Observe actual provider completion calling the listener synchronously.
 *
 * @param {string} store - Selected store.
 */
async function checkPartialSynchronousCallback(store) {
  await withPartialStore(store, async (incoming, folder) => {
    const original = seedPartial(incoming, folder);
    const key = original.messageKey;
    const sink = beginPartialDelivery(
      incoming,
      folder,
      COMPLETE,
      0,
      folder.getUriForMsg(original)
    );
    const stops = [];
    sink.incorporateComplete(null, 0, {
      onStopOperation: status => stops.push(status),
    });
    Assert.deepEqual(
      stops,
      [Cr.NS_OK],
      "Real no-async completion is reentrant"
    );
    Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
    Assert.ok(
      mailTestUtils.loadMessageToString(folder, original).endsWith(COMPLETE)
    );
    sink.endMailDelivery(null);
    let rejectedCallbacks = 0;
    Assert.throws(
      () =>
        sink.incorporateComplete(null, 0, {
          onStopOperation() {
            rejectedCallbacks++;
          },
        }),
      error => error.result == Cr.NS_ERROR_ALREADY_INITIALIZED
    );
    Assert.equal(
      rejectedCallbacks,
      0,
      "Rejected request owns no callback or second Finish"
    );
  });
}
add_task(async function test_pop3PartialSynchronousCallbackMbox() {
  await checkPartialSynchronousCallback("mbox");
});
add_task(async function test_pop3PartialSynchronousCallbackMaildir() {
  await checkPartialSynchronousCallback("maildir");
});

/**
 * A new accepted incorporation resets the receipt; rejected reentry does not.
 *
 * @param {string} store - Store type.
 */
async function checkPartialReceiptReset(store) {
  await withPartialStore(store, async (incoming, folder) => {
    const original = seedPartial(incoming, folder);
    const key = original.messageKey;
    const sink = beginPartialDelivery(
      incoming,
      folder,
      COMPLETE,
      0,
      folder.getUriForMsg(original)
    );
    try {
      sink.incorporateComplete(null, 0);
      Assert.ok(sink.confirmedPartialCompletion);
      const token = original.storeToken;
      const raw = mailTestUtils.loadMessageToString(folder, original);
      sink.origMessageUri = "";
      sink.incorporateBegin("next-incorporation", Ci.nsMsgMessageFlags.Partial);
      Assert.ok(
        !sink.confirmedPartialCompletion,
        "Only the new write resets the outcome"
      );
      sink.incorporateAbort();
      sink.endMailDelivery(null);
      Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
      Assert.equal(original.storeToken, token);
      Assert.equal(mailTestUtils.loadMessageToString(folder, original), raw);
      const scan = new PromiseTestUtils.PromiseStoreScanListener();
      folder.msgStore.asyncScan(folder, scan);
      await scan.promise;
      Assert.equal(
        scan.messages.length,
        2,
        "Aborted next write adds no finished body"
      );
    } finally {
      try {
        sink.abortMailDelivery(null);
      } catch {}
    }
  });
}

/**
 * Real selected/global batch: a late destination failure must not refetch a
 * completed UIDL as a new message. Observe the actual client's final status.
 *
 * @param {string} store - Store type.
 */
async function checkPartialBatchReceipt(store) {
  await withPartialStore(store, async (incoming, folder) => {
    incoming.deferGetNewMail = true;
    incoming.leaveMessagesOnServer = true;
    incoming.headersOnly = true;
    const expectedComplete =
      AppConstants.platform == "win"
        ? COMPLETE
        : COMPLETE.replaceAll("\r\n", "\n");
    const second = COMPLETE.replaceAll(
      "completed-partial",
      "second-partial"
    ).replace("Subject: Completed partial", "Subject: Second partial");
    popDaemon.setMessages([{ fileData: COMPLETE }, { fileData: second }]);
    const implementation = incoming.wrappedJSObject;
    const withClient = implementation.withClient;
    let wait;
    implementation.withClient = function (handler) {
      const stopped = wait;
      wait = null;
      return withClient.call(this, client => {
        handler(client);
        const onDone = client.onDone;
        client.onDone = status => {
          onDone?.(status);
          stopped.resolve({ client, status });
        };
      });
    };
    const run = start => {
      wait = Promise.withResolvers();
      const promise = wait.promise;
      popServer.resetTest();
      start();
      return promise;
    };
    const getMail = () =>
      MailServices.pop3.GetNewMail(null, null, folder, incoming);
    /** @returns {string[]} Commands from the most recent connection. */
    const latestCommands = () => {
      let transaction = popServer.playTransaction();
      if (Array.isArray(transaction)) {
        transaction = transaction[transaction.length - 1];
      }
      return transaction.them;
    };
    const connection = Cc["@mozilla.org/mailnews/database-core;1"].getService(
      Ci.nsIDatabaseCore
    ).connectionForTests;
    let rule;
    let later;
    let trigger = false;
    let functionInstalled = false;
    let faults = 0;
    try {
      Assert.equal((await run(getMail)).status, Cr.NS_OK);
      const headers = [...folder.messages];
      Assert.equal(headers.length, 2);
      const first = headers.find(
        header => header.subject == "Completed partial"
      );
      const other = headers.find(header => header.subject == "Second partial");
      Assert.ok(first.flags & Ci.nsMsgMessageFlags.Partial);
      Assert.ok(other.flags & Ci.nsMsgMessageFlags.Partial);
      first.setStringProperty("receipt-extra", "000A");
      const key = first.messageKey;
      const oldToken = first.storeToken;
      const oldRaw = mailTestUtils.loadMessageToString(folder, first);
      const otherToken = other.storeToken;
      const otherRaw = mailTestUtils.loadMessageToString(folder, other);
      const uidl = /^X-UIDL: ([^\r\n]+)/m.exec(oldRaw)[1];
      const otherUidl = /^X-UIDL: ([^\r\n]+)/m.exec(otherRaw)[1];
      const destination = folder.parent
        .QueryInterface(Ci.nsIMsgLocalMailFolder)
        .createLocalSubfolder("batch-copy-failure");
      Assert.equal(destination.msgStore.storeType, store);
      Assert.equal(destination.server.msgStore.storeType, store);
      const list = incoming.getFilterList(null);
      rule = addCompletedPartialFilter(list, [
        { type: Ci.nsMsgFilterAction.CopyToFolder },
      ]);
      rule.getActionAt(0).targetFolderUri = destination.URI;
      later = addCompletedPartialFilter(list, [
        { type: Ci.nsMsgFilterAction.AddTag, strValue: "must-not-run" },
      ]);
      connection.createFunction("partial_receipt_fault", 0, {
        onFunctionCall() {
          faults++;
          return 0;
        },
      });
      functionInstalled = true;
      connection.executeSimpleSQL(
        "CREATE TEMP TRIGGER partial_receipt_fault BEFORE INSERT ON main.messages " +
          `WHEN NEW.folderId = ${destination.id} BEGIN SELECT partial_receipt_fault(); ` +
          "SELECT RAISE(ABORT, 'batch destination failed'); END"
      );
      trigger = true;
      incoming.headersOnly = false;
      const before = Math.floor(Date.now() / 1000);
      const result = await run(() =>
        folder.downloadMessagesForOffline([first, other], null)
      );
      Assert.equal(result.status, Cr.NS_ERROR_STORAGE_CONSTRAINT);
      Assert.ok(
        !folder.locked,
        "Aggregate failure released the destination lock"
      );
      Assert.equal(
        result.client._sink.origMessageUri,
        "",
        "Use the actual selected-batch route"
      );
      Assert.ok(result.client._sink.confirmedPartialCompletion);
      Assert.equal(faults, 1);
      const commands = latestCommands();
      Assert.ok(commands.includes("RETR 1"));
      Assert.ok(
        !commands.includes("RETR 2"),
        "No next message after failed copy"
      );
      Assert.ok(!commands.some(command => command.startsWith("DELE")));
      Assert.equal(popDaemon.getTotalMessages(), 2);
      Assert.deepEqual(
        folder.msgDatabase.listAllKeys(),
        headers.map(header => header.messageKey)
      );
      Assert.equal(first.messageKey, key);
      Assert.notEqual(first.storeToken, oldToken);
      Assert.ok(!(first.flags & Ci.nsMsgMessageFlags.Partial));
      Assert.equal(first.getStringProperty("receipt-extra"), "000A");
      Assert.equal(first.getStringProperty("keywords"), "");
      const completedToken = first.storeToken;
      const completedRaw = mailTestUtils.loadMessageToString(folder, first);
      Assert.ok(completedRaw.endsWith(expectedComplete));
      Assert.equal(first.messageSize, completedRaw.length);
      Assert.equal(first.lineCount, 2);
      Assert.equal(other.storeToken, otherToken);
      Assert.ok(other.flags & Ci.nsMsgMessageFlags.Partial);
      Assert.equal(mailTestUtils.loadMessageToString(folder, other), otherRaw);
      Assert.equal(destination.getTotalMessages(false), 0);
      const destinationScan = new PromiseTestUtils.PromiseStoreScanListener();
      destination.msgStore.asyncScan(destination, destinationScan);
      await destinationScan.promise;
      Assert.equal(
        destinationScan.messages.length,
        1,
        "Failed publication retains the finished copy bytes"
      );
      Assert.ok(destinationScan.messages[0].endsWith(expectedComplete));
      const stateFile = PathUtils.join(incoming.localPath.path, "popstate.dat");
      const state = (await IOUtils.readUTF8(stateFile)).split(/\r?\n/);
      const [status, , receivedAt] = state
        .find(line => line.split(" ")[1] == uidl)
        .split(" ");
      Assert.equal(status, "k");
      Assert.greaterOrEqual(Number(receivedAt), before);
      Assert.ok(state.some(line => line.startsWith(`f ${otherUidl} `)));
      const scan = new PromiseTestUtils.PromiseStoreScanListener();
      folder.msgStore.asyncScan(folder, scan);
      await scan.promise;
      Assert.equal(scan.messages.length, 3);
      Assert.equal(scan.messages[scan.tokens.indexOf(oldToken)], oldRaw);
      Assert.equal(scan.messages[scan.tokens.indexOf(otherToken)], otherRaw);
      list.removeFilter(rule);
      rule = null;
      list.removeFilter(later);
      later = null;
      connection.executeSimpleSQL("DROP TRIGGER partial_receipt_fault");
      connection.removeFunction("partial_receipt_fault");
      functionInstalled = false;
      trigger = false;
      // Finish the unrelated selected Partial through its own guarded route.
      // This request also sees the first UIDL and must not retrieve it again.
      Assert.equal(
        (await run(() => folder.downloadMessagesForOffline([other], null)))
          .status,
        Cr.NS_OK
      );
      const nextCommands = latestCommands();
      Assert.ok(
        !nextCommands.includes("RETR 1"),
        "Saved failed-filter message is not refetched"
      );
      Assert.ok(
        nextCommands.includes("RETR 2"),
        "Unrelated pending message is retained"
      );
      Assert.ok(!nextCommands.some(command => command.startsWith("DELE")));
      Assert.equal(folder.getTotalMessages(false), 2);
      Assert.ok(!(other.flags & Ci.nsMsgMessageFlags.Partial));
      Assert.equal((await run(getMail)).status, Cr.NS_OK);
      Assert.ok(
        !latestCommands().some(
          command => command.startsWith("RETR") || command.startsWith("DELE")
        ),
        "A later normal fetch retrieves neither confirmed message"
      );
      Assert.equal(folder.getTotalMessages(false), 2);
      Assert.equal(first.storeToken, completedToken);
      Assert.equal(
        scan.tokens[scan.messages.indexOf(completedRaw)],
        completedToken
      );
      Assert.equal(
        mailTestUtils.loadMessageToString(folder, first),
        completedRaw
      );
      const after = new PromiseTestUtils.PromiseStoreScanListener();
      folder.msgStore.asyncScan(folder, after);
      await after.promise;
      Assert.equal(
        after.messages.length,
        4,
        "One later body, no duplicate completed delivery"
      );
    } finally {
      implementation.withClient = withClient;
      const list = incoming.getFilterList(null);
      if (rule) {
        list.removeFilter(rule);
      }
      if (later) {
        list.removeFilter(later);
      }
      if (trigger) {
        connection.executeSimpleSQL(
          "DROP TRIGGER IF EXISTS partial_receipt_fault"
        );
      }
      if (functionInstalled) {
        connection.removeFunction("partial_receipt_fault");
      }
    }
  });
}

add_task(async function test_pop3PartialReceiptResetMbox() {
  await checkPartialReceiptReset("mbox");
});
add_task(async function test_pop3PartialReceiptResetMaildir() {
  await checkPartialReceiptReset("maildir");
});
add_task(async function test_pop3PartialBatchFailureReceiptMbox() {
  await checkPartialBatchReceipt("mbox");
});
add_task(async function test_pop3PartialBatchFailureReceiptMaildir() {
  await checkPartialBatchReceipt("maildir");
});

add_task(async function test_pop3PartialFinishFailureHasNoReceipt() {
  await withPartialStore("maildir", async (incoming, folder) => {
    const original = seedPartial(incoming, folder);
    const key = original.messageKey;
    const token = original.storeToken;
    const oldRaw = mailTestUtils.loadMessageToString(folder, original);
    const sink = beginPartialDelivery(
      incoming,
      folder,
      COMPLETE,
      0,
      folder.getUriForMsg(original)
    );
    const cur = PathUtils.join(folder.filePath.path, "cur");
    const saved = PathUtils.join(folder.filePath.path, "saved-receipt-cur");
    await IOUtils.move(cur, saved, { noOverwrite: true });
    try {
      await IOUtils.writeUTF8(cur, "block destination directory");
      Assert.throws(
        () => sink.incorporateComplete(null, 0),
        error => error.result == Cr.NS_ERROR_FILE_DESTINATION_NOT_DIR
      );
      Assert.ok(!sink.confirmedPartialCompletion);
      const pending = await IOUtils.getChildren(
        PathUtils.join(folder.filePath.path, "tmp")
      );
      Assert.equal(pending.length, 1);
      const bytes = await IOUtils.read(pending[0]);
      Assert.greater(bytes.length, 0);
      for (const cleanup of [
        () => sink.incorporateComplete(null, 0),
        () => sink.abortMailDelivery(null),
      ]) {
        Assert.throws(
          cleanup,
          error => error.result == Cr.NS_ERROR_FILE_DESTINATION_NOT_DIR
        );
        Assert.ok(!sink.confirmedPartialCompletion);
        Assert.deepEqual(await IOUtils.read(pending[0]), bytes);
      }
    } finally {
      await IOUtils.remove(cur, { ignoreAbsent: true });
      await IOUtils.move(saved, cur, { noOverwrite: true });
      try {
        sink.abortMailDelivery(null);
      } catch {}
    }
    Assert.deepEqual(folder.msgDatabase.listAllKeys(), [key]);
    Assert.equal(original.storeToken, token);
    Assert.ok(original.flags & Ci.nsMsgMessageFlags.Partial);
    Assert.equal(mailTestUtils.loadMessageToString(folder, original), oldRaw);
  });
});

/**
 * Complete a real Partial in one process and read its persisted row in another.
 *
 * @param {string} store - Native provider selected in both processes.
 * @returns {Promise<void>} Both independent process lifetimes have ended.
 */
async function checkPartialProcessRestart(store) {
  const { Subprocess } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs"
  );
  const resources = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler);
  const profilePath = PathUtils.join(
    do_get_profile().path,
    "partial-process-restart-" + store
  );
  await IOUtils.makeDirectory(profilePath);
  registerCleanupFunction(() =>
    IOUtils.remove(profilePath, { recursive: true })
  );
  for (const stage of ["write", "read"]) {
    const child = await Subprocess.call({
      command: Services.dirsvc.get("XREExeF", Ci.nsIFile).path,
      arguments: [
        "-g",
        Services.dirsvc.get("GreD", Ci.nsIFile).path,
        "-a",
        Services.dirsvc.get("XCurProcD", Ci.nsIFile).path,
        "-e",
        `const pop3RestartInput = ${JSON.stringify({
          stage,
          store,
          profilePath,
          testingCommon: resources.getSubstitution("testing-common").spec,
          partial: PARTIAL,
          complete: COMPLETE,
        })};`,
        "-f",
        do_get_file("data/pop3PartialRestartChild.js").path,
      ],
      stderr: "stdout",
    });
    let output = "";
    try {
      for (let chunk; (chunk = await child.stdout.readString()); ) {
        output += chunk;
      }
      const { exitCode } = await child.wait();
      Assert.equal(
        exitCode,
        0,
        `${store} ${stage} exit=${exitCode}: ${JSON.stringify(output)}`
      );
      Assert.ok(output.includes(`POP3-PARTIAL-RESTART ${stage} PASS`));
    } finally {
      if (child.exitCode === null) {
        await child.kill();
      }
    }
  }
}

add_task(async function test_partialPhysicalAssociationAfterRestartMbox() {
  await checkPartialProcessRestart("mbox");
});

add_task(async function test_partialPhysicalAssociationAfterRestartMaildir() {
  await checkPartialProcessRestart("maildir");
});

/**
 * Run a real fresh POP filter transfer and a second same-UIDL session.
 *
 * @param {string} store - Actual local provider.
 * @param {string} mode - Move/delete, write/Finish/publication/cleanup error,
 *   rejected copy start, or cancellation after a real native move.
 */
async function checkFreshFilterTransfer(store, mode) {
  const storeContract = `@mozilla.org/msgstore/${store == "mbox" ? "berkeleystore" : "maildirstore"};1`;
  const nativeStore = Cc[storeContract].createInstance(Ci.nsIMsgPluggableStore);
  const copyContract = "@mozilla.org/messenger/messagecopyservice;1";
  const nativeCopy = Cc[copyContract].getService(Ci.nsIMsgCopyService);
  const events = [];
  let sourceURI;
  let targetURI;
  let faultStream;
  let faultNativeStream;
  let copyCid;
  let release;
  let calls = 0;
  let sourceKey;
  let sourceRaw;
  let receiptURI;
  let client;
  let doneCalls = 0;
  let faults = 0;
  const nativeStopped = Promise.withResolvers();
  const failure = Cr.NS_ERROR_FILE_ACCESS_DENIED;
  const provider = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgPluggableStore"]),
    get storeType() {
      return nativeStore.storeType;
    },
    get supportsCompaction() {
      return nativeStore.supportsCompaction;
    },
    getNewMsgOutputStream(folder) {
      const stream = nativeStore.getNewMsgOutputStream(folder);
      events.push(["open", folder.URI]);
      if (mode != "write" || folder.URI != targetURI) {
        return stream;
      }
      faultNativeStream = stream;
      // nsIOutputStream is builtinclass. Use a native pipe carrying the exact
      // write error; retain the real provider stream for Discard.
      const pipe = Cc["@mozilla.org/pipe;1"].createInstance(Ci.nsIPipe);
      pipe.init(true, true, 0, 0);
      const input = pipe.inputStream;
      const output = pipe.outputStream;
      registerCleanupFunction(() => {
        input.close();
        output.close();
      });
      output.closeWithStatus(failure);
      faultStream = output;
      return faultStream;
    },
    finishNewMessage(folder, stream) {
      events.push(["finish-entry", folder.URI]);
      const token = nativeStore.finishNewMessage(folder, stream);
      events.push(["finish", folder.URI, token]);
      if (mode == "finish" && folder.URI == targetURI) {
        // The real provider has safely settled this stream. Report an error
        // after that settlement to prove the caller never Discards/retries it.
        throw Components.Exception("settled filter Finish failed", failure);
      }
      return token;
    },
    discardNewMessage(folder, stream) {
      events.push(["discard", folder.URI]);
      return nativeStore.discardNewMessage(
        folder,
        folder.URI == targetURI && faultStream ? faultNativeStream : stream
      );
    },
    deleteMessages(headers) {
      if (headers[0]?.folder.URI == sourceURI) {
        events.push(["delete", sourceURI]);
        if (mode == "cleanup") {
          throw Components.Exception("source retirement refused", failure);
        }
      }
      return nativeStore.deleteMessages(headers);
    },
  };
  for (const method of [
    "discoverSubFolders",
    "discoverChildFolders",
    "createFolder",
    "ensureLocalStore",
    "deleteFolder",
    "renameFolder",
    "hasSpaceAvailable",
    "copyFolder",
    "getMsgInputStream",
    "deleteStoreMessages",
    "copyMessages",
    "asyncCompact",
    "isSummaryFileValid",
    "setSummaryFileValid",
    "asyncScan",
    "changeFlags",
    "changeKeywords",
    "estimateFolderSize",
  ]) {
    provider[method] = (...args) => nativeStore[method](...args);
  }
  const storeCid = PartialCopyRegistrar.register(storeContract, () => provider);
  try {
    await withPartialStore(store, async (incoming, folder) => {
      sourceURI = folder.URI;
      incoming.deferGetNewMail = true;
      incoming.leaveMessagesOnServer = true;
      incoming.headersOnly = false;
      const destination =
        mode == "delete"
          ? folder.parent.getFolderWithFlags(Ci.nsMsgFolderFlags.Trash)
          : folder.parent
              .QueryInterface(Ci.nsIMsgLocalMailFolder)
              .createLocalSubfolder(`fresh-filter-${mode}`);
      Assert.ok(destination);
      Assert.equal(folder.msgStore.storeType, store);
      Assert.equal(destination.msgStore.storeType, store);
      targetURI = destination.URI;
      if (["move", "delete"].includes(mode)) {
        folder.hasNewMessages = false;
        destination.hasNewMessages = false;
        folder.biffState = Ci.nsIMsgFolder.nsMsgBiffState_NoMail;
        folder.setNumNewMessages(0);
        destination.setNumNewMessages(0);
      }
      const list = incoming.getFilterList(null);
      const deferred = folder.server.getFilterList(null);
      const rule = addCompletedPartialFilter(list, [
        { type: Ci.nsMsgFilterAction.MarkFlagged },
        mode == "delete"
          ? { type: Ci.nsMsgFilterAction.Delete }
          : {
              type: Ci.nsMsgFilterAction.MoveToFolder,
              targetFolderUri: destination.URI,
            },
      ]);
      const after = addCompletedPartialFilter(list, [
        { type: Ci.nsMsgFilterAction.AddTag, strValue: "must-not-run" },
      ]);
      const later = addCompletedPartialFilter(deferred, [
        { type: Ci.nsMsgFilterAction.AddTag, strValue: "must-not-run" },
      ]);
      const expectedRaw =
        AppConstants.platform == "win"
          ? COMPLETE
          : COMPLETE.replaceAll("\r\n", "\n");
      popDaemon.setMessages([{ fileData: COMPLETE }]);
      const implementation = incoming.wrappedJSObject;
      const withClient = implementation.withClient;
      let wait;
      implementation.withClient = function (handler) {
        const stopped = wait;
        wait = null;
        return withClient.call(this, actual => {
          client = actual;
          handler(actual);
          const onDone = actual.onDone;
          actual.onDone = status => {
            doneCalls++;
            onDone?.(status);
            stopped.resolve(status);
          };
        });
      };
      /** @returns {Promise<number>} Terminal status from the real POP client. */
      const getMail = () => {
        wait = Promise.withResolvers();
        const result = wait.promise;
        popServer.resetTest();
        MailServices.pop3.GetNewMail(null, null, folder, incoming);
        return result;
      };
      /** @returns {string[]} Commands from the latest real server connection. */
      const commands = () => {
        let transaction = popServer.playTransaction();
        if (Array.isArray(transaction)) {
          transaction = transaction[transaction.length - 1];
        }
        return transaction.them;
      };
      const proxy = {
        QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyService"]),
        copyMessages(source, headers, target, move, listener, window, undo) {
          calls++;
          try {
            Assert.equal(source, folder);
            Assert.equal(target, destination);
            Assert.ok(move);
            Assert.ok(!undo);
            Assert.equal(headers.length, 1);
            const header = headers[0];
            Assert.ok(header.isLive);
            Assert.equal(header.folder, folder);
            sourceKey = header.messageKey;
            sourceRaw = mailTestUtils.loadMessageToString(folder, header);
            receiptURI = folder.getUriForMsg(header);
            Assert.ok(sourceRaw.endsWith(expectedRaw));
            Assert.equal(header.messageSize, sourceRaw.length);
            Assert.ok(header.flags & Ci.nsMsgMessageFlags.Marked);
            Assert.equal(
              events.filter(
                ([event, uri]) => event == "finish" && uri == sourceURI
              ).length,
              1
            );
            if (mode == "reject") {
              nativeStopped.resolve(failure);
              throw Components.Exception("filter copy start refused", failure);
            }
            nativeCopy.copyMessages(
              source,
              headers,
              target,
              move,
              {
                QueryInterface: ChromeUtils.generateQI([
                  "nsIMsgCopyServiceListener",
                ]),
                onStartCopy() {
                  listener.onStartCopy();
                },
                onProgress(...args) {
                  listener.onProgress(...args);
                },
                setMessageKey(key) {
                  listener.setMessageKey(key);
                },
                getMessageId() {
                  return listener.getMessageId();
                },
                onStopCopy(status) {
                  if (mode == "cancel") {
                    release = () => listener.onStopCopy(status);
                  } else {
                    listener.onStopCopy(status);
                  }
                  nativeStopped.resolve(status);
                },
              },
              window,
              undo
            );
          } catch (error) {
            // Do not turn a dispatch assertion/error into an unbounded wait.
            nativeStopped.resolve(error.result || Cr.NS_ERROR_FAILURE);
            throw error;
          }
        },
      };
      for (const method of [
        "copyFolder",
        "copyFileMessage",
        "notifyCompletion",
        "getArrivedFolder",
      ]) {
        proxy[method] = (...args) => nativeCopy[method](...args);
      }
      const connection = Cc["@mozilla.org/mailnews/database-core;1"].getService(
        Ci.nsIDatabaseCore
      ).connectionForTests;
      let trigger = false;
      let functionInstalled = false;
      let reentrantCancels = 0;
      const publicationListener = {
        msgAdded(header) {
          if (mode == "reentrant-cancel" && header.folder == folder) {
            reentrantCancels++;
            Assert.ok(client._pendingIncorporation.dispatching);
            Assert.equal(
              client._sink.messageUri,
              folder.getUriForMsg(header),
              "The Attach-returned URI is available before MFN can retire the row"
            );
            client._actionDone(Cr.NS_BINDING_ABORTED);
          }
        },
      };
      MailServices.mfn.addListener(
        publicationListener,
        MailServices.mfn.msgAdded
      );
      try {
        if (mode == "publication") {
          connection.createFunction("fresh_filter_fault", 0, {
            onFunctionCall() {
              faults++;
              return 0;
            },
          });
          functionInstalled = true;
          connection.executeSimpleSQL(
            "CREATE TEMP TRIGGER fresh_filter_fault BEFORE INSERT ON main.messages " +
              `WHEN NEW.folderId = ${destination.id} BEGIN SELECT fresh_filter_fault(); ` +
              "SELECT RAISE(ABORT, 'fresh destination publication failed'); END"
          );
          trigger = true;
        }
        copyCid = PartialCopyRegistrar.register(copyContract, proxy);
        const before = Math.floor(Date.now() / 1000);
        const first = getMail();
        const nativeStatus = await nativeStopped.promise;
        let expected;
        if (["move", "delete"].includes(mode)) {
          expected = Cr.NS_OK;
        } else if (mode == "publication") {
          expected = Cr.NS_ERROR_STORAGE_CONSTRAINT;
        } else if (["cancel", "reentrant-cancel"].includes(mode)) {
          expected = Cr.NS_BINDING_ABORTED;
        } else {
          expected = failure;
        }
        if (mode == "cancel") {
          Assert.equal(
            nativeStatus,
            Cr.NS_OK,
            "Withhold only a real native completion"
          );
          Assert.ok(release);
          Assert.throws(
            () => client._sink.incorporateBegin("other", 0),
            error => error.result == Cr.NS_ERROR_IN_PROGRESS
          );
          Assert.equal(client._sink.messageUri, receiptURI);
          const cancelled = client._actionDone(Cr.NS_BINDING_ABORTED);
          release();
          release();
          await cancelled;
        } else {
          Assert.equal(
            nativeStatus,
            mode == "reentrant-cancel" ? Cr.NS_OK : expected
          );
        }
        Assert.equal(await first, expected);
        Assert.equal(reentrantCancels, mode == "reentrant-cancel" ? 1 : 0);
        Assert.equal(doneCalls, 1);
        Assert.equal(calls, 1);
        Assert.ok(
          !client._sink.confirmedPartialCompletion,
          "A fresh receipt is not a Partial completion"
        );
        Assert.equal(client._sink.messageUri, receiptURI);
        Assert.ok(commands().includes("RETR 1"));
        Assert.ok(!commands().some(command => command.startsWith("DELE")));
        Assert.equal(popDaemon.getTotalMessages(), 1);
        Assert.equal(faults, mode == "publication" ? 1 : 0);
        const sourceRetained = ![
          "move",
          "delete",
          "cancel",
          "reentrant-cancel",
        ].includes(mode);
        const destinationPublished = [
          "move",
          "delete",
          "cleanup",
          "cancel",
          "reentrant-cancel",
        ].includes(mode);
        Assert.equal(folder.getTotalMessages(false), sourceRetained ? 1 : 0);
        Assert.equal(
          destination.getTotalMessages(false),
          destinationPublished ? 1 : 0
        );
        if (sourceRetained) {
          const current = folder.msgDatabase.getMsgHdrForKey(sourceKey);
          Assert.equal(
            mailTestUtils.loadMessageToString(folder, current),
            sourceRaw
          );
          Assert.equal(current.getStringProperty("keywords"), "");
        }
        if (["move", "delete"].includes(mode)) {
          Assert.equal(folder.getNumNewMessages(false), 0);
          Assert.ok(!folder.hasNewMessages);
          Assert.equal(
            destination.getNumNewMessages(false),
            mode == "move" ? 1 : 0
          );
          Assert.equal(destination.hasNewMessages, mode == "move");
          // Biff is per server; Inbox and target share this deferred account.
          const biff =
            mode == "move"
              ? Ci.nsIMsgFolder.nsMsgBiffState_NewMail
              : Ci.nsIMsgFolder.nsMsgBiffState_NoMail;
          Assert.equal(folder.biffState, biff);
          Assert.equal(destination.biffState, biff);
        }
        const targets = [...destination.messages];
        if (destinationPublished) {
          Assert.equal(targets.length, 1);
          Assert.equal(targets[0].folder, destination);
          Assert.notEqual(targets[0].messageKey, sourceKey);
          Assert.ok(targets[0].storeToken);
          Assert.equal(targets[0].getStringProperty("keywords"), "");
          Assert.ok(targets[0].flags & Ci.nsMsgMessageFlags.Marked);
          Assert.ok(
            mailTestUtils
              .loadMessageToString(destination, targets[0])
              .endsWith(expectedRaw)
          );
        }
        const count = (event, uri) =>
          events.filter(([kind, owner]) => kind == event && owner == uri)
            .length;
        Assert.equal(count("finish-entry", sourceURI), 1);
        Assert.equal(count("discard", sourceURI), 0);
        Assert.equal(
          count("finish-entry", targetURI),
          ["write", "reject"].includes(mode) ? 0 : 1
        );
        Assert.equal(count("discard", targetURI), mode == "write" ? 1 : 0);
        Assert.equal(count("delete", sourceURI), destinationPublished ? 1 : 0);
        Assert.ok(!folder.locked);
        Assert.ok(!destination.locked);
        const uidl = /^X-UIDL: ([^\r\n]+)/m.exec(sourceRaw)[1];
        const stateFile = PathUtils.join(
          incoming.localPath.path,
          "popstate.dat"
        );
        const saved = (await IOUtils.readUTF8(stateFile))
          .split(/\r?\n/)
          .find(line => line.split(" ")[1] == uidl);
        Assert.ok(saved);
        Assert.equal(saved.split(" ")[0], "k");
        Assert.greaterOrEqual(Number(saved.split(" ")[2]), before);
        const sourceScan = new PromiseTestUtils.PromiseStoreScanListener();
        folder.msgStore.asyncScan(folder, sourceScan);
        await sourceScan.promise;
        Assert.equal(
          sourceScan.messages.length,
          sourceRetained || store == "mbox" ? 1 : 0
        );
        const targetScan = new PromiseTestUtils.PromiseStoreScanListener();
        destination.msgStore.asyncScan(destination, targetScan);
        await targetScan.promise;
        Assert.equal(
          targetScan.messages.length,
          [
            "move",
            "delete",
            "cleanup",
            "cancel",
            "publication",
            "finish",
            "reentrant-cancel",
          ].includes(mode)
            ? 1
            : 0
        );
        if (targetScan.messages.length) {
          Assert.ok(targetScan.messages[0].endsWith(expectedRaw));
        }
        const sourceKeys = folder.msgDatabase.listAllKeys();
        const targetKeys = destination.msgDatabase.listAllKeys();
        const tokens = targets.map(header => header.storeToken);
        // The same UIDL is still on the real server. Its saved receipt must
        // prevent another RETR, another destination, or another filter action.
        Assert.equal(await getMail(), Cr.NS_OK);
        Assert.equal(doneCalls, 2);
        Assert.ok(!commands().some(command => command.startsWith("RETR")));
        Assert.equal(calls, 1);
        Assert.deepEqual(folder.msgDatabase.listAllKeys(), sourceKeys);
        Assert.deepEqual(destination.msgDatabase.listAllKeys(), targetKeys);
        Assert.deepEqual(
          [...destination.messages].map(header => header.storeToken),
          tokens
        );
        const retried = new PromiseTestUtils.PromiseStoreScanListener();
        destination.msgStore.asyncScan(destination, retried);
        await retried.promise;
        Assert.deepEqual(retried.tokens, targetScan.tokens);
        Assert.deepEqual(retried.messages, targetScan.messages);
        Assert.equal(
          (await IOUtils.readUTF8(stateFile))
            .split(/\r?\n/)
            .find(line => line.split(" ")[1] == uidl),
          saved
        );
      } finally {
        if (release) {
          release();
        }
        MailServices.mfn.removeListener(publicationListener);
        implementation.withClient = withClient;
        if (copyCid) {
          PartialCopyRegistrar.unregister(copyCid);
          copyCid = null;
        }
        try {
          if (trigger) {
            connection.executeSimpleSQL("DROP TRIGGER temp.fresh_filter_fault");
          }
        } finally {
          if (functionInstalled) {
            connection.removeFunction("fresh_filter_fault");
          }
          list.removeFilter(rule);
          list.removeFilter(after);
          deferred.removeFilter(later);
        }
      }
    });
  } finally {
    if (copyCid) {
      PartialCopyRegistrar.unregister(copyCid);
    }
    PartialCopyRegistrar.unregister(storeCid);
    Assert.equal(Cc[copyContract].getService(Ci.nsIMsgCopyService), nativeCopy);
  }
}

/**
 * Move a completed Partial to Trash using its confirmed physical source.
 *
 * @param {string} store - Actual local provider.
 */
async function checkCompletedPartialDelete(store) {
  await withPartialStore(store, async (incoming, folder) => {
    const original = seedPartial(incoming, folder);
    const key = original.messageKey;
    const list = incoming.getFilterList(null);
    const rule = addCompletedPartialFilter(list, [
      { type: Ci.nsMsgFilterAction.Delete },
    ]);
    const sink = Cc["@mozilla.org/messenger/pop3-sink;1"].createInstance(
      Ci.nsIPop3Sink
    );
    let ended = false;
    try {
      sink.popServer = incoming;
      sink.folder = folder;
      sink.origMessageUri = folder.getUriForMsg(original);
      sink.beginMailDelivery(false, null);
      sink.incorporateBegin("completion-uidl", 0);
      for (const line of COMPLETE.match(/[^\n]*\n/g)) {
        sink.incorporateWrite(line, line.length);
      }
      const stopped = Promise.withResolvers();
      const stops = [];
      sink.incorporateComplete(null, 0, {
        onStopOperation(status) {
          stops.push(status);
          stopped.resolve(status);
        },
      });
      Assert.equal(await stopped.promise, Cr.NS_OK);
      sink.endMailDelivery(null);
      ended = true;
      Assert.deepEqual(stops, [Cr.NS_OK]);
      Assert.ok(sink.confirmedPartialCompletion);
      Assert.deepEqual(folder.msgDatabase.listAllKeys(), []);
      const trash = folder.parent.getFolderWithFlags(Ci.nsMsgFolderFlags.Trash);
      const headers = [...trash.messages];
      Assert.equal(headers.length, 1);
      Assert.equal(headers[0].folder, trash);
      Assert.notEqual(headers[0].messageKey, key);
      Assert.ok(!(headers[0].flags & Ci.nsMsgMessageFlags.Partial));
      const raw = mailTestUtils.loadMessageToString(trash, headers[0]);
      Assert.ok(raw.endsWith(COMPLETE));
      Assert.ok(raw.includes("X-UIDL: completion-uidl"));
      Assert.ok(!folder.locked);
      Assert.ok(!trash.locked);
    } finally {
      if (!ended) {
        try {
          sink.abortMailDelivery(null);
        } catch {}
      }
      list.removeFilter(rule);
    }
  });
}

/**
 * Reject another physical folder even with the same Message-ID and UIDL.
 *
 * @param {string} store - Actual local provider.
 */
async function checkPartialWrongFolder(store) {
  await withPartialStore(store, async (incoming, folder) => {
    const original = seedPartial(incoming, folder);
    const otherFolder = folder.parent
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder("wrong-partial-folder");
    const other = seedPartial(incoming, otherFolder);
    const originals = [original, other].map(header => ({
      key: header.messageKey,
      token: header.storeToken,
      raw: mailTestUtils.loadMessageToString(header.folder, header),
    }));
    const sink = Cc["@mozilla.org/messenger/pop3-sink;1"].createInstance(
      Ci.nsIPop3Sink
    );
    try {
      sink.popServer = incoming;
      sink.folder = folder;
      sink.origMessageUri = otherFolder.getUriForMsg(other);
      sink.buildMessageUri = true;
      sink.beginMailDelivery(true, null);
      Assert.throws(
        () => sink.incorporateBegin("completion-uidl", 0),
        error => error.result == Cr.NS_ERROR_INVALID_ARG
      );
      Assert.ok(!sink.confirmedPartialCompletion);
      Assert.throws(
        () => sink.messageUri,
        error => error.result == Cr.NS_ERROR_FAILURE
      );
    } finally {
      try {
        sink.abortMailDelivery(null);
      } catch {}
    }
    for (const [index, physical] of [folder, otherFolder].entries()) {
      Assert.deepEqual(physical.msgDatabase.listAllKeys(), [
        originals[index].key,
      ]);
      const header = physical.msgDatabase.getMsgHdrForKey(originals[index].key);
      Assert.equal(header.storeToken, originals[index].token);
      Assert.equal(
        mailTestUtils.loadMessageToString(physical, header),
        originals[index].raw
      );
    }
  });
}

/**
 * Clear a fresh receipt on a new admitted write, without confirming failed SQL.
 *
 * @param {string} store - Actual local provider.
 */
async function checkFreshPublicationReceiptReset(store) {
  await withPartialStore(store, async (incoming, folder) => {
    const sink = Cc["@mozilla.org/messenger/pop3-sink;1"].createInstance(
      Ci.nsIPop3Sink
    );
    const connection = Cc["@mozilla.org/mailnews/database-core;1"].getService(
      Ci.nsIDatabaseCore
    ).connectionForTests;
    let trigger = false;
    sink.popServer = incoming;
    sink.folder = folder;
    sink.buildMessageUri = true;
    sink.beginMailDelivery(true, null);
    try {
      sink.incorporateBegin("receipt-first", 0);
      for (const line of COMPLETE.match(/[^\n]*\n/g)) {
        sink.incorporateWrite(line, line.length);
      }
      sink.incorporateComplete(null, 0);
      const [first] = [...folder.messages];
      Assert.equal(sink.messageUri, folder.getUriForMsg(first));
      Assert.ok(!sink.confirmedPartialCompletion);
      const token = first.storeToken;
      const raw = mailTestUtils.loadMessageToString(folder, first);
      sink.incorporateBegin("receipt-unpublished", 0);
      Assert.throws(
        () => sink.messageUri,
        error => error.result == Cr.NS_ERROR_FAILURE
      );
      connection.executeSimpleSQL(
        "CREATE TEMP TRIGGER fresh_unpublished BEFORE INSERT ON main.messages " +
          `WHEN NEW.folderId = ${folder.id} BEGIN ` +
          "SELECT RAISE(ABORT, 'fresh source publication failed'); END"
      );
      trigger = true;
      for (const line of COMPLETE.match(/[^\n]*\n/g)) {
        sink.incorporateWrite(line, line.length);
      }
      const stops = [];
      sink.incorporateComplete(null, 0, {
        onStopOperation(status) {
          stops.push(status);
        },
      });
      Assert.deepEqual(stops, [Cr.NS_ERROR_STORAGE_CONSTRAINT]);
      Assert.throws(
        () => sink.messageUri,
        error => error.result == Cr.NS_ERROR_FAILURE
      );
      Assert.ok(!sink.confirmedPartialCompletion);
      Assert.throws(
        () => sink.incorporateComplete(null, 0),
        error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
      );
      Assert.throws(
        () => sink.abortMailDelivery(null),
        error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
      );
      Assert.deepEqual(stops, [Cr.NS_ERROR_STORAGE_CONSTRAINT]);
      Assert.deepEqual(folder.msgDatabase.listAllKeys(), [first.messageKey]);
      Assert.equal(first.storeToken, token);
      Assert.equal(mailTestUtils.loadMessageToString(folder, first), raw);
      const scan = new PromiseTestUtils.PromiseStoreScanListener();
      folder.msgStore.asyncScan(folder, scan);
      await scan.promise;
      Assert.equal(
        scan.messages.length,
        2,
        "Unpublished finished bytes are retained"
      );
      Assert.ok(!folder.locked);
    } finally {
      if (trigger) {
        connection.executeSimpleSQL("DROP TRIGGER temp.fresh_unpublished");
      }
      try {
        sink.abortMailDelivery(null);
      } catch {}
    }
  });
}

add_task(async function test_pop3FreshFilterMoveDeleteMbox() {
  await checkFreshFilterTransfer("mbox", "move");
  await checkFreshFilterTransfer("mbox", "delete");
  await checkCompletedPartialDelete("mbox");
});
add_task(async function test_pop3FreshFilterMoveDeleteMaildir() {
  await checkFreshFilterTransfer("maildir", "move");
  await checkFreshFilterTransfer("maildir", "delete");
  await checkCompletedPartialDelete("maildir");
});
add_task(async function test_pop3FilterFinishOwnershipErrorsMbox() {
  await checkFreshFilterTransfer("mbox", "write");
  await checkFreshFilterTransfer("mbox", "finish");
  await checkFreshPublicationReceiptReset("mbox");
});
add_task(async function test_pop3FilterFinishOwnershipErrorsMaildir() {
  await checkFreshFilterTransfer("maildir", "write");
  await checkFreshFilterTransfer("maildir", "finish");
  await checkFreshPublicationReceiptReset("maildir");
});
add_task(async function test_pop3FilterPublishCleanupLifetimeMbox() {
  await checkFreshFilterTransfer("mbox", "publication");
  await checkFreshFilterTransfer("mbox", "cleanup");
  await checkFreshFilterTransfer("mbox", "cancel");
  await checkFreshFilterTransfer("mbox", "reentrant-cancel");
});
add_task(async function test_pop3FilterPublishCleanupLifetimeMaildir() {
  await checkFreshFilterTransfer("maildir", "publication");
  await checkFreshFilterTransfer("maildir", "cleanup");
  await checkFreshFilterTransfer("maildir", "cancel");
  await checkFreshFilterTransfer("maildir", "reentrant-cancel");
});
add_task(async function test_pop3FilterCopyStartPhysicalIdentityMbox() {
  await checkFreshFilterTransfer("mbox", "reject");
  await checkCompletedPartialFilters("mbox", "unsupported");
  await checkPartialIdentityRejected("mbox", false);
  await checkPartialIdentityRejected("mbox", true);
  await checkPartialWrongFolder("mbox");
});
add_task(async function test_pop3FilterCopyStartPhysicalIdentityMaildir() {
  await checkFreshFilterTransfer("maildir", "reject");
  await checkCompletedPartialFilters("maildir", "unsupported");
  await checkPartialIdentityRejected("maildir", false);
  await checkPartialIdentityRejected("maildir", true);
  await checkPartialWrongFolder("maildir");
});

/**
 * Keep the preexisting fresh action set on the real deferred POP account.
 *
 * @param {string} store - Actual local provider.
 * @param {string} mode - Existing actions, same-folder Move, or queued forward
 *   after a real Move. Every case retrieves two distinct fresh messages.
 */
async function checkFreshExistingActions(store, mode) {
  await withPartialStore(store, async (incoming, folder) => {
    incoming.deferGetNewMail = true;
    incoming.leaveMessagesOnServer = true;
    incoming.headersOnly = false;
    folder.hasNewMessages = false;
    folder.biffState = Ci.nsIMsgFolder.nsMsgBiffState_NoMail;
    folder.setNumNewMessages(0);
    const destination = folder.parent
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder(`existing-actions-${mode}`);
    const firstId = `fresh-first-${store}-${mode}@example.invalid`;
    const laterId = `fresh-later-${store}-${mode}@example.invalid`;
    const firstRaw = COMPLETE.replace(
      "completed-partial@example.invalid",
      firstId
    ).replace("Completed partial", "Fresh action target");
    const laterRaw = COMPLETE.replace(
      "completed-partial@example.invalid",
      laterId
    )
      .replace("Completed partial", "Later fresh message")
      .replace(/^References:.*\r\n/m, "");
    popDaemon.setMessages([{ fileData: firstRaw }, { fileData: laterRaw }]);
    const composeContract = "@mozilla.org/messengercompose;1";
    const nativeCompose = Cc[composeContract].getService(
      Ci.nsIMsgComposeService
    );
    const composeCalls = [];
    let customCalls = 0;
    let customFinished = false;
    const custom = {
      QueryInterface: ChromeUtils.generateQI(["nsIMsgFilterCustomAction"]),
      id: `s373-fresh-${store}-${mode}@example.invalid#published`,
      name: "Fresh published header",
      allowDuplicates: false,
      isAsync: true,
      needsBody: true,
      isValidForType() {
        return true;
      },
      validateActionValue() {
        return "";
      },
      applyAction(headers, value, listener, type) {
        customCalls++;
        Assert.equal(headers.length, 1);
        Assert.equal(value, "completed-custom");
        Assert.equal(type, Ci.nsMsgFilterType.InboxRule);
        const header = headers[0];
        Assert.ok(header.isLive);
        Assert.equal(header.folder, folder);
        Assert.equal(header.messageId, firstId);
        Assert.ok(
          mailTestUtils.loadMessageToString(folder, header).includes(firstId)
        );
        Assert.equal(
          composeCalls.length,
          0,
          "Compose is queued until filters finish"
        );
        // Normal actions retain their order across this async boundary.
        const thread = folder.msgDatabase.getThreadContainingMsgHdr(header);
        Assert.ok(thread.flags & Ci.nsMsgMessageFlags.Watched);
        folder.addKeywordsToMessages(headers, value);
        Services.tm.dispatchToMainThread(() => {
          customFinished = true;
          listener.onStopCopy(Cr.NS_OK);
          listener.onStopCopy(Cr.NS_ERROR_FAILURE); // A stale duplicate cannot settle twice.
        });
      },
    };
    MailServices.filters.addCustomAction(custom);
    const compose = {
      QueryInterface: ChromeUtils.generateQI(["nsIMsgComposeService"]),
      forwardMessage(to, header, window, server) {
        Assert.equal(to, "forward@example.invalid");
        Assert.equal(server, incoming.QueryInterface(Ci.nsIMsgIncomingServer));
        Assert.ok(header.isLive);
        Assert.equal(header.messageId, firstId);
        const physical = mode == "forward-after-move" ? destination : folder;
        Assert.equal(header.folder, physical);
        // A lookup may return another live facade for the same physical row.
        const current = physical.msgDatabase.getMsgHdrForKey(header.messageKey);
        Assert.deepEqual(
          [
            current.isLive,
            current.folder.URI,
            current.messageKey,
            current.storeToken,
          ],
          [true, physical.URI, header.messageKey, header.storeToken]
        );
        Assert.ok(
          mailTestUtils.loadMessageToString(physical, header).includes(firstId)
        );
        if (mode == "existing-actions") {
          Assert.ok(customFinished);
          Assert.equal(
            header.getStringProperty("keywords"),
            "completed-custom later-own-rule"
          );
        } else {
          Assert.equal(
            folder.getTotalMessages(false),
            0,
            "Move retired its actual source"
          );
        }
        composeCalls.push(["forward", header.messageKey]);
      },
      replyWithTemplate(header, uri, window, server) {
        Assert.equal(uri, "mailbox://s373-template");
        Assert.equal(server, incoming.QueryInterface(Ci.nsIMsgIncomingServer));
        Assert.ok(customFinished);
        Assert.ok(header.isLive);
        Assert.equal(header.folder, folder);
        Assert.equal(header.messageId, firstId);
        composeCalls.push(["reply", header.messageKey]);
      },
    };
    const list = incoming.getFilterList(null);
    const deferred = folder.server.getFilterList(null);
    let actions;
    if (mode == "existing-actions") {
      actions = [
        {
          type: Ci.nsMsgFilterAction.ChangePriority,
          priority: Ci.nsMsgPriority.high,
        },
        { type: Ci.nsMsgFilterAction.JunkScore, junkScore: 100 },
        { type: Ci.nsMsgFilterAction.WatchThread },
        {
          type: Ci.nsMsgFilterAction.Forward,
          strValue: "forward@example.invalid",
        },
        {
          type: Ci.nsMsgFilterAction.Reply,
          strValue: "mailbox://s373-template",
        },
        {
          type: Ci.nsMsgFilterAction.Custom,
          customId: custom.id,
          strValue: "completed-custom",
        },
        { type: Ci.nsMsgFilterAction.KillThread },
        { type: Ci.nsMsgFilterAction.KillSubthread },
        { type: Ci.nsMsgFilterAction.DeleteFromPop3Server },
      ];
    } else if (mode == "same-folder-move") {
      actions = [
        {
          type: Ci.nsMsgFilterAction.MoveToFolder,
          targetFolderUri: folder.URI,
        },
      ];
    } else {
      actions = [
        {
          type: Ci.nsMsgFilterAction.Forward,
          strValue: "forward@example.invalid",
        },
        {
          type: Ci.nsMsgFilterAction.MoveToFolder,
          targetFolderUri: destination.URI,
        },
      ];
    }
    const rule = addCompletedPartialFilter(list, actions);
    const term = rule.createTerm();
    term.attrib = Ci.nsMsgSearchAttrib.Subject;
    term.op = Ci.nsMsgSearchOp.Is;
    const value = term.value;
    value.str = "Fresh action target";
    term.value = value;
    rule.searchTerms = [term];
    const after = addCompletedPartialFilter(list, [
      { type: Ci.nsMsgFilterAction.AddTag, strValue: "later-own-rule" },
    ]);
    const deferredRule = addCompletedPartialFilter(deferred, [
      { type: Ci.nsMsgFilterAction.MarkFlagged },
    ]);
    const implementation = incoming.wrappedJSObject;
    const withClient = implementation.withClient;
    const stopped = Promise.withResolvers();
    const stops = [];
    let client;
    let composeCid;
    implementation.withClient = function (handler) {
      return withClient.call(this, actual => {
        client = actual;
        handler(actual);
        const onDone = actual.onDone;
        actual.onDone = status => {
          stops.push(status);
          onDone?.(status);
          stopped.resolve(status);
        };
      });
    };
    try {
      composeCid = PartialCopyRegistrar.register(composeContract, compose);
      popServer.resetTest();
      MailServices.pop3.GetNewMail(null, null, folder, incoming);
      Assert.equal(await stopped.promise, Cr.NS_OK);
      Assert.deepEqual(stops, [Cr.NS_OK]);
      Assert.ok(client._nativeDelivery);
      Assert.ok(client._sink.buildMessageUri);
      Assert.ok(!client._sink.confirmedPartialCompletion);
      let transaction = popServer.playTransaction();
      if (Array.isArray(transaction)) {
        transaction = transaction[transaction.length - 1];
      }
      const commands = transaction.them;
      Assert.equal(commands.filter(command => command == "RETR 1").length, 1);
      Assert.equal(commands.filter(command => command == "RETR 2").length, 1);
      Assert.deepEqual(
        commands.filter(command => command.startsWith("DELE")),
        mode == "existing-actions" ? ["DELE 1"] : []
      );
      Assert.equal(
        popDaemon.getTotalMessages(),
        mode == "existing-actions" ? 1 : 2
      );
      const headers = [...folder.messages];
      const first =
        mode == "forward-after-move"
          ? [...destination.messages][0]
          : headers.find(header => header.messageId == firstId);
      const later = headers.find(header => header.messageId == laterId);
      Assert.ok(first);
      Assert.ok(
        later,
        "A valid existing action does not stop the remaining download"
      );
      Assert.equal(
        first.folder,
        mode == "forward-after-move" ? destination : folder
      );
      Assert.equal(later.folder, folder);
      Assert.ok(first.isLive);
      Assert.ok(later.isLive);
      Assert.ok(later.flags & Ci.nsMsgMessageFlags.Marked);
      Assert.equal(later.getStringProperty("keywords"), "later-own-rule");
      Assert.equal(client._sink.messageUri, folder.getUriForMsg(later));
      if (mode == "existing-actions") {
        Assert.equal(first.priority, Ci.nsMsgPriority.high);
        Assert.equal(first.getStringProperty("junkscore"), "100");
        Assert.equal(first.getStringProperty("junkscoreorigin"), "filter");
        Assert.ok(first.flags & Ci.nsMsgMessageFlags.Ignored);
        const thread = folder.msgDatabase.getThreadContainingMsgHdr(first);
        Assert.ok(!(thread.flags & Ci.nsMsgMessageFlags.Watched));
        Assert.ok(thread.flags & Ci.nsMsgMessageFlags.Ignored);
        Assert.equal(customCalls, 1);
        Assert.deepEqual(composeCalls, [
          ["forward", first.messageKey],
          ["reply", first.messageKey],
        ]);
        Assert.equal(
          first.getStringProperty("keywords"),
          "completed-custom later-own-rule"
        );
        Assert.equal(
          folder.getNumNewMessages(false),
          1,
          "Spam is not a new biff message"
        );
      } else if (mode == "same-folder-move") {
        Assert.equal(
          first.getStringProperty("keywords"),
          "",
          "Same-folder Move stops own rules"
        );
        Assert.ok(
          first.flags & Ci.nsMsgMessageFlags.Marked,
          "Deferred account still runs"
        );
        Assert.deepEqual(composeCalls, []);
        Assert.equal(folder.getNumNewMessages(false), 2);
      } else {
        Assert.deepEqual(composeCalls, [["forward", first.messageKey]]);
        Assert.equal(first.getStringProperty("keywords"), "");
        Assert.ok(!(first.flags & Ci.nsMsgMessageFlags.Marked));
        Assert.equal(folder.getNumNewMessages(false), 1);
        Assert.equal(destination.getNumNewMessages(false), 1);
        Assert.ok(destination.hasNewMessages);
      }
      Assert.ok(folder.hasNewMessages);
      Assert.equal(folder.biffState, Ci.nsIMsgFolder.nsMsgBiffState_NewMail);
      Assert.ok(!folder.locked);
      Assert.ok(!destination.locked);
    } finally {
      implementation.withClient = withClient;
      if (composeCid) {
        PartialCopyRegistrar.unregister(composeCid);
      }
      list.removeFilter(rule);
      list.removeFilter(after);
      deferred.removeFilter(deferredRule);
      Assert.equal(
        Cc[composeContract].getService(Ci.nsIMsgComposeService),
        nativeCompose
      );
    }
  });
}

add_task(async function test_pop3FreshExistingActionsMbox() {
  await checkFreshExistingActions("mbox", "existing-actions");
  await checkFreshExistingActions("mbox", "same-folder-move");
  await checkFreshExistingActions("mbox", "forward-after-move");
});
add_task(async function test_pop3FreshExistingActionsMaildir() {
  await checkFreshExistingActions("maildir", "existing-actions");
  await checkFreshExistingActions("maildir", "same-folder-move");
  await checkFreshExistingActions("maildir", "forward-after-move");
});

/**
 * Move a fresh POP message to the real IMAP daemon before downloading later mail.
 * Compose must receive the live local source, never an APPENDUID as a row key.
 *
 * @param {string} store - Actual local provider, mbox or maildir.
 * @param {boolean} uidplus - Advertise UIDPLUS and return an APPENDUID.
 * @returns {Promise<void>} Resolves after delivery and ordinary server cleanup.
 */
async function checkFreshImapMove(store, uidplus) {
  const { IMAPPump, setupIMAPPump, teardownIMAPPump } =
    ChromeUtils.importESModule(
      "resource://testing-common/mailnews/IMAPpump.sys.mjs"
    );
  await withPartialStore(store, async (incoming, folder) => {
    const accountKeys = new Set(
      MailServices.accounts.accounts.map(account => account.key)
    );
    const prefs = [
      ["mail.server.default.max_cached_connections", "Int"],
      ["mail.server.default.download_on_biff", "Bool"],
      ["mail.biff.play_sound", "Bool"],
      ["mail.biff.show_alert", "Bool"],
      ["mail.biff.show_tray_icon", "Bool"],
      ["mail.biff.animate_dock_icon", "Bool"],
      ["mail.biff.alert.show_preview", "Bool"],
    ].map(([name, type]) => ({
      name,
      type,
      hadValue: Services.prefs.prefHasUserValue(name),
      value: Services.prefs[`get${type}Pref`](name, type == "Int" ? 0 : false),
    }));
    incoming.deferGetNewMail = true;
    incoming.leaveMessagesOnServer = true;
    incoming.headersOnly = false;
    const firstId = `fresh-imap-${store}-${uidplus}@example.invalid`;
    const laterId = `later-imap-${store}-${uidplus}@example.invalid`;
    const firstRaw = COMPLETE.replace(
      "completed-partial@example.invalid",
      firstId
    ).replace("Completed partial", "Fresh IMAP Move");
    // RETR writes use the POP client's platform separator. The stored payload
    // follows the native metadata headers; compare it without normalizing it.
    const expectedLocalMessage =
      AppConstants.platform == "win"
        ? firstRaw
        : firstRaw.replaceAll("\r\n", "\n");
    const laterRaw = COMPLETE.replace(
      "completed-partial@example.invalid",
      laterId
    ).replace("Completed partial", "Later IMAP Move message");
    popDaemon.setMessages([{ fileData: firstRaw }, { fileData: laterRaw }]);
    const contract = "@mozilla.org/messengercompose;1";
    const nativeCompose = Cc[contract].getService(Ci.nsIMsgComposeService);
    const composeCalls = [];
    let source;
    let sourceKey;
    const checkCompose = header => {
      Assert.ok(header.isLive);
      Assert.equal(header.folder, folder);
      Assert.equal(header.messageId, firstId);
      Assert.ok(header.storeToken);
      Assert.equal(
        mailTestUtils
          .loadMessageToString(folder, header)
          .slice(-expectedLocalMessage.length),
        expectedLocalMessage
      );
      if (source) {
        Assert.equal(header.messageKey, sourceKey);
        Assert.equal(header.storeToken, source.storeToken);
      } else {
        source = header;
        sourceKey = header.messageKey;
      }
    };
    const compose = {
      QueryInterface: ChromeUtils.generateQI(["nsIMsgComposeService"]),
      forwardMessage(to, header, window, server) {
        Assert.equal(to, "forward@example.invalid");
        Assert.equal(server, incoming.QueryInterface(Ci.nsIMsgIncomingServer));
        checkCompose(header);
        composeCalls.push(["forward", header.messageKey]);
      },
      replyWithTemplate(header, uri, window, server) {
        Assert.equal(uri, "mailbox://s373-template");
        Assert.equal(server, incoming.QueryInterface(Ci.nsIMsgIncomingServer));
        checkCompose(header);
        composeCalls.push(["reply", header.messageKey]);
      },
    };
    const list = incoming.getFilterList(null);
    const implementation = incoming.wrappedJSObject;
    const withClient = implementation.withClient;
    const stopped = Promise.withResolvers();
    const stops = [];
    let client;
    let rule;
    let cid;
    let started = false;
    implementation.withClient = function (handler) {
      return withClient.call(this, actual => {
        client = actual;
        handler(actual);
        const onDone = actual.onDone;
        actual.onDone = status => {
          stops.push(status);
          onDone?.(status);
          stopped.resolve(status);
        };
      });
    };
    try {
      started = true;
      const destination = await setupIMAPPump(
        uidplus ? "RFC2195,RFC4315" : "RFC2195",
        { awaitInbox: true }
      );
      IMAPPump.incomingServer.setBoolValue("autosync_offline_stores", false);
      Assert.ok(destination instanceof Ci.nsIMsgImapMailFolder);
      const updated = new PromiseTestUtils.PromiseUrlListener();
      destination.updateFolderWithListener(null, updated);
      await updated.promise;
      rule = addCompletedPartialFilter(list, [
        {
          type: Ci.nsMsgFilterAction.Forward,
          strValue: "forward@example.invalid",
        },
        {
          type: Ci.nsMsgFilterAction.Reply,
          strValue: "mailbox://s373-template",
        },
        {
          type: Ci.nsMsgFilterAction.MoveToFolder,
          targetFolderUri: destination.URI,
        },
      ]);
      const term = rule.createTerm();
      term.attrib = Ci.nsMsgSearchAttrib.Subject;
      term.op = Ci.nsMsgSearchOp.Is;
      const value = term.value;
      value.str = "Fresh IMAP Move";
      term.value = value;
      rule.searchTerms = [term];
      cid = PartialCopyRegistrar.register(contract, compose);
      popServer.resetTest();
      MailServices.pop3.GetNewMail(null, null, folder, incoming);
      Assert.equal(await stopped.promise, Cr.NS_OK);
      Assert.deepEqual(stops, [Cr.NS_OK]);
      Assert.ok(client._nativeDelivery);
      Assert.deepEqual(composeCalls, [
        ["forward", sourceKey],
        ["reply", sourceKey],
      ]);
      Assert.ok(source);
      Assert.ok(
        !source.isLive,
        "The confirmed APPEND retired its local source"
      );
      const headers = [...folder.messages];
      Assert.equal(headers.length, 1);
      Assert.equal(headers[0].messageId, laterId);
      Assert.notEqual(headers[0].messageKey, sourceKey);
      Assert.equal(client._sink.messageUri, folder.getUriForMsg(headers[0]));
      Assert.equal(IMAPPump.mailbox._messages.length, 1);
      const appended = IMAPPump.mailbox._messages[0];
      Assert.ok(appended.getText().includes(firstId));
      Assert.ok(appended.getText().includes("Completed body.\r\n"));
      const imapTransactions = IMAPPump.server.playTransaction();
      const imapWire = Array.isArray(imapTransactions)
        ? imapTransactions
        : [imapTransactions];
      Assert.equal(
        imapWire
          .flatMap(transaction => transaction.them)
          .filter(command => /^(?:\S+ )?APPEND /i.test(command)).length,
        1
      );
      Assert.equal(
        imapWire
          .flatMap(transaction => transaction.us)
          .some(response => response.includes("[APPENDUID ")),
        uidplus
      );
      let popTransaction = popServer.playTransaction();
      if (Array.isArray(popTransaction)) {
        popTransaction = popTransaction[popTransaction.length - 1];
      }
      Assert.equal(
        popTransaction.them.filter(command => command == "RETR 1").length,
        1
      );
      Assert.equal(
        popTransaction.them.filter(command => command == "RETR 2").length,
        1
      );
      Assert.ok(
        !popTransaction.them.some(command => command.startsWith("DELE"))
      );
      Assert.equal(folder.getNumNewMessages(false), 1);
      Assert.equal(destination.getNumNewMessages(false), 1);
      Assert.ok(folder.hasNewMessages);
      Assert.ok(destination.hasNewMessages);
      Assert.ok(!folder.locked);
      Assert.ok(!destination.locked);
    } finally {
      implementation.withClient = withClient;
      if (cid) {
        PartialCopyRegistrar.unregister(cid);
      }
      if (rule) {
        list.removeFilter(rule);
      }
      try {
        if (started) {
          teardownIMAPPump();
        }
      } finally {
        for (const account of MailServices.accounts.accounts) {
          if (!accountKeys.has(account.key)) {
            MailServices.accounts.removeAccount(account);
          }
        }
        for (const { name, type, hadValue, value } of prefs) {
          if (hadValue) {
            Services.prefs[`set${type}Pref`](name, value);
          } else {
            Services.prefs.clearUserPref(name);
          }
        }
      }
      Assert.equal(
        Cc[contract].getService(Ci.nsIMsgComposeService),
        nativeCompose
      );
    }
  });
}

/**
 * Apply Watch or Kill to a fresh reply whose thread root is in another folder.
 *
 * @param {string} store - Actual local provider, mbox or maildir.
 * @param {boolean} ignored - Apply Kill Thread instead of Watch Thread.
 * @returns {Promise<void>} Resolves after both fresh messages finish delivery.
 */
async function checkFreshForeignRoot(store, ignored) {
  await withPartialStore(store, async (incoming, folder) => {
    incoming.deferGetNewMail = true;
    incoming.leaveMessagesOnServer = true;
    incoming.headersOnly = false;
    const archive = folder.parent
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder("foreign-thread-root");
    const rootId = `foreign-root-${store}-${ignored}@example.invalid`;
    archive.addMessage(
      COMPLETE.replace("completed-partial@example.invalid", rootId).replace(
        /^References:.*\r\n/m,
        ""
      )
    );
    const root = archive.msgDatabase.getMsgHdrForMessageID(rootId);
    Assert.ok(root.isLive);
    Assert.equal(root.folder, archive);
    const rootKey = root.messageKey;
    const firstId = `foreign-reply-${store}-${ignored}@example.invalid`;
    const laterId = `foreign-later-${store}-${ignored}@example.invalid`;
    const firstRaw = COMPLETE.replace(
      "completed-partial@example.invalid",
      firstId
    )
      .replace("Completed partial", "Foreign root reply")
      .replace(/^References:.*\r\n/m, `References: <${rootId}>\r\n`);
    const laterRaw = COMPLETE.replace(
      "completed-partial@example.invalid",
      laterId
    ).replace(/^References:.*\r\n/m, "");
    popDaemon.setMessages([{ fileData: firstRaw }, { fileData: laterRaw }]);
    const list = incoming.getFilterList(null);
    const rule = addCompletedPartialFilter(list, [
      {
        type: ignored
          ? Ci.nsMsgFilterAction.KillThread
          : Ci.nsMsgFilterAction.WatchThread,
      },
      { type: Ci.nsMsgFilterAction.AddTag, strValue: "after-thread-action" },
    ]);
    const term = rule.createTerm();
    term.attrib = Ci.nsMsgSearchAttrib.Subject;
    term.op = Ci.nsMsgSearchOp.Is;
    const value = term.value;
    value.str = "Foreign root reply";
    term.value = value;
    rule.searchTerms = [term];
    const implementation = incoming.wrappedJSObject;
    const withClient = implementation.withClient;
    const stopped = Promise.withResolvers();
    const stops = [];
    let client;
    implementation.withClient = function (handler) {
      return withClient.call(this, actual => {
        client = actual;
        handler(actual);
        const onDone = actual.onDone;
        actual.onDone = status => {
          stops.push(status);
          onDone?.(status);
          stopped.resolve(status);
        };
      });
    };
    try {
      popServer.resetTest();
      MailServices.pop3.GetNewMail(null, null, folder, incoming);
      Assert.equal(await stopped.promise, Cr.NS_OK);
      Assert.deepEqual(stops, [Cr.NS_OK]);
      Assert.ok(client._nativeDelivery);
      const headers = [...folder.messages];
      Assert.equal(headers.length, 2);
      const reply = headers.find(header => header.messageId == firstId);
      const later = headers.find(header => header.messageId == laterId);
      Assert.ok(reply);
      Assert.ok(
        later,
        "A foreign root does not stop the remaining POP download"
      );
      Assert.ok(reply.isLive);
      Assert.equal(reply.folder, folder);
      Assert.notEqual(reply.messageKey, rootKey);
      Assert.ok(!folder.msgDatabase.listAllKeys().includes(rootKey));
      const thread = folder.msgDatabase.getThreadContainingMsgHdr(reply);
      Assert.equal(thread.threadKey, rootKey);
      Assert.equal(
        Boolean(thread.flags & Ci.nsMsgMessageFlags.Ignored),
        ignored
      );
      Assert.equal(
        Boolean(thread.flags & Ci.nsMsgMessageFlags.Watched),
        !ignored
      );
      Assert.equal(reply.getStringProperty("keywords"), "after-thread-action");
      Assert.equal(later.getStringProperty("keywords"), "");
      Assert.equal(client._sink.messageUri, folder.getUriForMsg(later));
      Assert.ok(root.isLive);
      Assert.equal(root.folder, archive);
      let transaction = popServer.playTransaction();
      if (Array.isArray(transaction)) {
        transaction = transaction[transaction.length - 1];
      }
      Assert.equal(
        transaction.them.filter(command => command == "RETR 1").length,
        1
      );
      Assert.equal(
        transaction.them.filter(command => command == "RETR 2").length,
        1
      );
      Assert.ok(!folder.locked);
      Assert.ok(!archive.locked);
    } finally {
      implementation.withClient = withClient;
      list.removeFilter(rule);
    }
  });
}

add_task(async function test_pop3FreshImapMoveUidplusMbox() {
  await checkFreshImapMove("mbox", true);
});
add_task(async function test_pop3FreshImapMoveUidplusMaildir() {
  await checkFreshImapMove("maildir", true);
});
add_task(async function test_pop3FreshImapMoveNoUidplusMbox() {
  await checkFreshImapMove("mbox", false);
});
add_task(async function test_pop3FreshImapMoveNoUidplusMaildir() {
  await checkFreshImapMove("maildir", false);
});
add_task(async function test_pop3FreshForeignRootWatchMbox() {
  await checkFreshForeignRoot("mbox", false);
});
add_task(async function test_pop3FreshForeignRootWatchMaildir() {
  await checkFreshForeignRoot("maildir", false);
});
add_task(async function test_pop3FreshForeignRootKillMbox() {
  await checkFreshForeignRoot("mbox", true);
});
add_task(async function test_pop3FreshForeignRootKillMaildir() {
  await checkFreshForeignRoot("maildir", true);
});
