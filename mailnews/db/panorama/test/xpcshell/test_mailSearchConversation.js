/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */

const { MailSearchService } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchService.sys.mjs"
);
const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);
let conversationRoot;

add_setup(function setupConversationLookup() {
  do_get_profile();
  loadExistingDB();
  const pref = "mailnews.database.global.indexer.enabled";
  const hadPref = Services.prefs.prefHasUserValue(pref);
  const oldPref = Services.prefs.getBoolPref(pref, false);
  Services.prefs.setBoolPref(pref, true);
  registerCleanupFunction(() =>
    hadPref
      ? Services.prefs.setBoolPref(pref, oldPref)
      : Services.prefs.clearUserPref(pref)
  );
  conversationRoot = MailServices.accounts
    .createLocalMailAccount()
    .incomingServer.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
});

/**
 * Adds independently stored MIME with explicit References and no subject grouping.
 *
 * @param {nsIMsgLocalMailFolder} folder - Physical destination.
 * @param {string} messageId - Literal header identity, not the result identity.
 * @param {string[]} references - Ordered References header IDs.
 * @returns {nsIMsgDBHdr} Published physical header.
 */
function addConversationMail(folder, messageId, references) {
  return folder.addMessage(
    [
      "From: sender@example.invalid",
      "To: recipient@example.invalid",
      "Date: Tue, 01 Jan 2019 00:00:00 +0000",
      "Message-ID: <" + messageId + ">",
      ...(references.length
        ? ["References: " + references.map(id => "<" + id + ">").join(" ")]
        : []),
      "Subject: Shared conversation subject",
      "Content-Type: text/plain",
      "",
      "body",
      "",
    ].join("\r\n")
  );
}

/**
 * Builds an ordered cross-folder chain, a duplicate physical reply, missing body,
 * and unrelated same-subject control through normal ingestion APIs.
 *
 * @param {string} name - Unique fixture suffix.
 * @returns {Promise<object>} Service, headers and literal expected member locations.
 */
async function conversationFixture(name) {
  const a = conversationRoot
    .createLocalSubfolder("conversation-" + name + "-a")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const b = conversationRoot
    .createLocalSubfolder("conversation-" + name + "-b")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const rootId = name + "-root@conversation.invalid";
  const replyId = name + "-reply@conversation.invalid";
  const root = addConversationMail(a, rootId, []);
  const reply = addConversationMail(b, replyId, [rootId]);
  const clicked = addConversationMail(a, replyId, [rootId]);
  const tail = addConversationMail(b, name + "-tail@conversation.invalid", [
    rootId,
    replyId,
  ]);
  const missingKey = messageDB.addMessage(
    b.id,
    name + "-missing@conversation.invalid",
    [rootId],
    1546300800000000,
    "sender@example.invalid",
    "recipient@example.invalid",
    "",
    "",
    "Shared conversation subject",
    0,
    "",
    Ci.nsMsgPriority.notSet
  );
  const missing = messageDB.getMessage(missingKey);
  const unrelated = addConversationMail(
    a,
    name + "-unrelated@conversation.invalid",
    []
  );
  const file = do_get_profile().clone();
  file.append("conversation-lookup-" + name + ".sqlite");
  const service = await MailSearchService.open(
    file,
    database.sourceId,
    messageDB
  );
  registerCleanupFunction(() => service.close());
  // Initialize the existing policy fingerprint without indexing any messages.
  Assert.equal(await service.getText(String(clicked.messageKey)), null);
  return { a, b, root, reply, clicked, tail, missing, unrelated, service };
}

/**
 * Captures the native result token for the chosen physical copy, without FTS.
 *
 * @param {MailSearchService} service - Current native resolver.
 * @param {nsIMsgDBHdr} header - Exact selected physical header.
 * @returns {object} Source/revision/location token used by the public service.
 */
function conversationSelection(service, header) {
  const id = String(header.messageKey);
  const state = service.resolveDocument(id);
  return {
    sourceId: database.sourceId,
    id,
    generation: state.generation,
    policyRevision: state.policyRevision,
    contentRevision: state.contentRevision,
    location: { ...state.location },
  };
}

/**
 * Compares complete physical membership to independently named fixture headers.
 *
 * @param {MailSearchConversationSnapshot} snapshot - Native lookup result.
 * @param {nsIMsgDBHdr[]} expected - Literal expected physical members.
 */
function assertConversationMembers(snapshot, expected) {
  Assert.equal(snapshot.status, "ready");
  Assert.deepEqual(
    snapshot.items
      .map(item => [item.location.folderId, Number(item.id)])
      .toSorted((a, b) => a[1] - b[1]),
    expected
      .map(header => [header.folder.id, header.messageKey])
      .toSorted((a, b) => a[1] - b[1])
  );
}

add_task(async function test_completeUnindexedConversationAndClickedCopy() {
  const f = await conversationFixture("complete");
  const request = conversationSelection(f.service, f.clicked);
  const resolving = f.service.getConversation(request);
  request.id = String(f.unrelated.messageKey);
  request.location.folderId = f.b.id;
  const snapshot = await resolving;
  assertConversationMembers(snapshot, [
    f.root,
    f.reply,
    f.clicked,
    f.tail,
    f.missing,
  ]);
  Assert.equal(f.clicked.messageId, f.reply.messageId);
  Assert.equal(snapshot.selectedId, String(f.clicked.messageKey));
  Assert.equal(snapshot.selectedMessage.messageKey, f.clicked.messageKey);
  Assert.equal(snapshot.selectedMessage.folder.id, f.a.id);
  Assert.equal(snapshot.excludedCount, 0);
  Assert.equal(snapshot.sourceId, database.sourceId);
  Assert.equal(
    snapshot.conversationId,
    f.clicked.threadId,
    "Only the current native thread is used"
  );
  Assert.ok(snapshot.resultSetId);
  Assert.equal(
    snapshot.items.find(item => item.id == String(f.missing.messageKey))
      .originalContentAvailable,
    false
  );
  Assert.equal(
    await f.service.getText(String(f.missing.messageKey)),
    null,
    "A member with no indexed body or original bytes is still included"
  );
  const headers = [];
  await f.service.streamResultHeaders(snapshot, header => headers.push(header));
  Assert.deepEqual(
    headers.map(header => header.messageKey).toSorted((a, b) => a - b),
    [f.root, f.reply, f.clicked, f.tail, f.missing]
      .map(header => header.messageKey)
      .toSorted((a, b) => a - b)
  );
});

add_task(
  async function test_staleDeletedAndForeignSelectionNeverUsesDuplicate() {
    const f = await conversationFixture("stale");
    const request = conversationSelection(f.service, f.clicked);
    await Assert.rejects(
      f.service.getConversation({ ...request, sourceId: "foreign-source" }),
      /this mail database/
    );
    await Assert.rejects(
      f.service.getConversation({ ...request, id: "0" }),
      /physical mail identity/
    );
    f.a.markMessagesRead([f.clicked], true);
    Assert.equal((await f.service.getConversation(request)).status, "stale");
    const current = conversationSelection(f.service, f.clicked);
    messageDB.removeMessage(f.clicked.messageKey);
    Assert.equal((await f.service.getConversation(current)).status, "deleted");
    Assert.ok(
      messageDB.getSearchState(f.reply.messageKey),
      "The other Message-ID copy still exists"
    );
  }
);

add_task(async function test_membershipMutationRejectsTheInFlightSnapshot() {
  const f = await conversationFixture("mutation");
  const request = conversationSelection(f.service, f.clicked);
  const pending = f.service.getConversation(request);
  const added = addConversationMail(
    f.b,
    "mutation-added@conversation.invalid",
    [f.root.messageId]
  );
  const stale = await pending;
  Assert.equal(stale.status, "stale");
  Assert.ok(!("items" in stale), "No partial membership is delivered");
  const current = await f.service.getConversation(
    conversationSelection(f.service, f.clicked)
  );
  assertConversationMembers(current, [
    f.root,
    f.reply,
    f.clicked,
    f.tail,
    f.missing,
    added,
  ]);
});

add_task(async function test_policyAndDeletedRootDoNotDependOnBodyIndex() {
  const f = await conversationFixture("policy");
  f.a.setStringProperty("indexingPriority", "-1");
  const snapshot = await f.service.getConversation(
    conversationSelection(f.service, f.reply)
  );
  assertConversationMembers(snapshot, [f.reply, f.tail, f.missing]);
  Assert.equal(
    snapshot.excludedCount,
    2,
    "Excluded root/copy are not presented as eligible"
  );
  Assert.equal(
    (
      await f.service.getConversation(
        conversationSelection(f.service, f.clicked)
      )
    ).status,
    "ineligible"
  );
  f.a.setStringProperty("indexingPriority", "20");
  messageDB.removeMessage(f.root.messageKey);
  const after = await f.service.getConversation(
    conversationSelection(f.service, f.reply)
  );
  assertConversationMembers(after, [f.reply, f.clicked, f.tail, f.missing]);
});

add_task(async function test_cancellationAndServiceCloseStopDelivery() {
  const f = await conversationFixture("cancel");
  const request = conversationSelection(f.service, f.clicked);
  const controller = new AbortController();
  const reason = new Error("Cancel native conversation lookup");
  const pending = f.service.getConversation(request, {
    signal: controller.signal,
  });
  controller.abort(reason);
  await Assert.rejects(pending, error => error === reason);
  await Assert.rejects(
    f.service.getConversation(request, { signal: controller.signal }),
    error => error === reason
  );
  const closingLookup = f.service.getConversation(request);
  const closing = f.service.close();
  await Assert.rejects(closingLookup, /Mail search closed/);
  await closing;
  await Assert.rejects(f.service.getConversation(request), /closed/);
});

add_task(async function test_moveUsesTheActualTransferKeyAndCurrentLocation() {
  const f = await conversationFixture("move");
  const request = conversationSelection(f.service, f.clicked);
  const destination = conversationRoot
    .createLocalSubfolder("conversation-move-destination")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const transfers = [];
  const notification = {
    msgsMoveCopyCompleted(isMove, sources, target, messages) {
      if (target.URI == destination.URI) {
        transfers.push({
          isMove,
          sources: sources.map(header => ({
            key: header.messageKey,
            folderURI: header.folder.URI,
          })),
          messageKeys: messages.map(header => header.messageKey),
        });
      }
    },
  };
  const listener = new PromiseTestUtils.PromiseCopyListener();
  MailServices.mfn.addListener(
    notification,
    MailServices.mfn.msgsMoveCopyCompleted
  );
  try {
    MailServices.copy.copyMessages(
      f.a,
      [f.clicked],
      destination,
      true,
      listener,
      null,
      false
    );
    await listener.promise;
  } finally {
    MailServices.mfn.removeListener(notification);
  }
  Assert.equal(transfers.length, 1, "One completed physical transfer");
  const [transfer] = transfers;
  Assert.ok(transfer.isMove);
  Assert.deepEqual(transfer.sources, [
    {
      key: request.location.messageKey,
      folderURI: f.a.URI,
    },
  ]);
  Assert.equal(
    transfer.messageKeys.length,
    1,
    "The completed transfer notification supplies the destination physical key"
  );
  const moved = messageDB.getMessage(transfer.messageKeys[0]);
  Assert.equal(moved.folder.id, destination.id);
  Assert.equal(
    (await f.service.getConversation(request)).status,
    moved.messageKey == request.location.messageKey ? "stale" : "deleted"
  );
  const current = await f.service.getConversation(
    conversationSelection(f.service, moved)
  );
  assertConversationMembers(current, [
    f.root,
    f.reply,
    moved,
    f.tail,
    f.missing,
  ]);
  Assert.equal(current.selectedMessage.messageKey, moved.messageKey);
  Assert.equal(current.selectedMessage.folder.id, destination.id);
  const fromHeader = await f.service.getConversationForHeader(moved);
  assertConversationMembers(fromHeader, [
    f.root,
    f.reply,
    moved,
    f.tail,
    f.missing,
  ]);
  Assert.equal(fromHeader.selectedMessage.messageKey, moved.messageKey);
  Assert.equal(fromHeader.selectedMessage.folder.id, destination.id);
});

/**
 * Reopens the same native messages with a fresh, unprepared sidecar.
 *
 * @param {string} name - Unique fixture suffix.
 * @returns {Promise<object>} Native fixture with a cold service.
 */
async function coldConversationFixture(name) {
  const fixture = await conversationFixture(name);
  await fixture.service.close();
  const file = do_get_profile().clone();
  file.append("conversation-unprepared-" + name + ".sqlite");
  const service = await MailSearchService.open(
    file,
    database.sourceId,
    messageDB
  );
  registerCleanupFunction(() => service.close());
  return { ...fixture, service };
}

add_task(
  async function test_headerEntryIncludesUnindexedMissingBodySelection() {
    const f = await coldConversationFixture("header-cold");
    const snapshot = await f.service.getConversationForHeader(f.missing);
    assertConversationMembers(snapshot, [
      f.root,
      f.reply,
      f.clicked,
      f.tail,
      f.missing,
    ]);
    Assert.equal(snapshot.selectedId, String(f.missing.messageKey));
    Assert.equal(snapshot.selectedMessage.messageKey, f.missing.messageKey);
    Assert.equal(snapshot.selectedMessage.folder.id, f.b.id);
    Assert.equal(snapshot.sourceId, database.sourceId);
    const selected = snapshot.items.find(
      item => item.id == snapshot.selectedId
    );
    Assert.equal(selected.originalContentAvailable, false);
    Assert.equal(selected.canOpen, false);
    Assert.equal(await f.service.getText(snapshot.selectedId), null);
    assertConversationMembers(
      await f.service.getConversationForHeader(f.unrelated),
      [f.unrelated]
    );
  }
);

add_task(async function test_headerEntryKeepsPolicyAndDeletedCopyGuards() {
  const f = await coldConversationFixture("header-policy");
  const pending = f.service.getConversationForHeader(f.clicked);
  messageDB.removeMessage(f.clicked.messageKey);
  Assert.equal((await pending).status, "deleted");
  Assert.ok(messageDB.getSearchState(f.reply.messageKey));
  const pref = "mailnews.database.global.indexer.enabled";
  const oldPref = Services.prefs.getBoolPref(pref, false);
  try {
    Services.prefs.setBoolPref(pref, false);
    Assert.equal(
      (await f.service.getConversationForHeader(f.reply)).status,
      "ineligible"
    );
  } finally {
    Services.prefs.setBoolPref(pref, oldPref);
  }
  f.reply.setStringProperty(
    "junkscore",
    Ci.nsIJunkMailPlugin.IS_SPAM_SCORE.toString()
  );
  Assert.equal(
    (await f.service.getConversationForHeader(f.reply)).status,
    "ineligible"
  );
});

add_task(async function test_headerEntryPreservesCancellationAndErrors() {
  const f = await coldConversationFixture("header-errors");
  const resolveDocument = f.service.resolveDocument;
  const failure = new Error("Original header conversation lookup failure");
  let lookups = 0;
  f.service.resolveDocument = () => {
    lookups++;
    throw failure;
  };
  try {
    const controller = new AbortController();
    const reason = new Error("Cancel header conversation lookup");
    controller.abort(reason);
    await Assert.rejects(
      f.service.getConversationForHeader(f.clicked, {
        signal: controller.signal,
      }),
      error => error === reason
    );
    Assert.equal(lookups, 0);
    await Assert.rejects(
      f.service.getConversationForHeader(f.clicked),
      error => error === failure
    );
  } finally {
    f.service.resolveDocument = resolveDocument;
  }
  await Assert.rejects(
    f.service.getConversationForHeader(null),
    /physical mail identity/
  );
  const controller = new AbortController();
  const reason = new Error("Cancel header conversation preference preparation");
  const pending = f.service.getConversationForHeader(f.clicked, {
    signal: controller.signal,
  });
  controller.abort(reason);
  await Assert.rejects(pending, error => error === reason);
  const closingLookup = f.service.getConversationForHeader(f.clicked);
  const closing = f.service.close();
  await Assert.rejects(closingLookup, /Mail search closed/);
  await closing;
});
