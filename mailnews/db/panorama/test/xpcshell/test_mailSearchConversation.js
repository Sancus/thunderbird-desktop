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
let conversationInitialFolderURIs;

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
  conversationInitialFolderURIs = new Set(
    [...conversationRoot.subFolders].map(folder => folder.URI)
  );
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
    "Conversation metadata names the selected copy’s current native thread"
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

add_task(async function test_completeConversationIncludesDuplicateRootCopies() {
  const a = conversationRoot
    .createLocalSubfolder("duplicate-root-a")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const b = conversationRoot
    .createLocalSubfolder("duplicate-root-b")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const c = conversationRoot
    .createLocalSubfolder("duplicate-root-control")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const rootId = "duplicate-root@conversation.invalid";
  const root = addConversationMail(a, rootId, []);
  const reply = addConversationMail(
    a,
    "duplicate-root-reply@conversation.invalid",
    [rootId]
  );
  const clicked = addConversationMail(b, rootId, []);
  const unrelated = addConversationMail(
    c,
    "duplicate-root-unrelated@conversation.invalid",
    []
  );
  const file = do_get_profile().clone();
  file.append("conversation-duplicate-root.sqlite");
  const service = await MailSearchService.open(
    file,
    database.sourceId,
    messageDB
  );
  registerCleanupFunction(() => service.close());
  Assert.equal(root.messageId, clicked.messageId);
  Assert.notEqual(root.messageKey, clicked.messageKey);
  Assert.equal(await service.getText(String(clicked.messageKey)), null);
  const snapshot = await service.getConversationForHeader(clicked);
  assertConversationMembers(snapshot, [root, reply, clicked]);
  Assert.equal(snapshot.selectedId, String(clicked.messageKey));
  Assert.equal(snapshot.selectedMessage.messageKey, clicked.messageKey);
  Assert.equal(snapshot.selectedMessage.folder.id, b.id);
  Assert.equal(snapshot.excludedCount, 0);
  const exported = [];
  await service.streamResultHeaders(snapshot, header => exported.push(header));
  Assert.deepEqual(
    exported
      .map(header => [header.folder.id, header.messageKey])
      .toSorted((x, y) => x[1] - y[1]),
    [root, reply, clicked]
      .map(header => [header.folder.id, header.messageKey])
      .toSorted((x, y) => x[1] - y[1])
  );
  assertConversationMembers(await service.getConversationForHeader(unrelated), [
    unrelated,
  ]);
});

add_task(async function test_sameMessageIdWithoutReferencesIsNotAnEdge() {
  const a = conversationRoot
    .createLocalSubfolder("same-id-no-references-a")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const b = conversationRoot
    .createLocalSubfolder("same-id-no-references-b")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const id = "same-id-no-references@conversation.invalid";
  const first = addConversationMail(a, id, []);
  const clicked = addConversationMail(b, id, []);
  const file = do_get_profile().clone();
  file.append("conversation-same-id-no-references.sqlite");
  const service = await MailSearchService.open(
    file,
    database.sourceId,
    messageDB
  );
  registerCleanupFunction(() => service.close());
  Assert.equal(first.messageId, clicked.messageId);
  Assert.notEqual(first.messageKey, clicked.messageKey);
  const snapshot = await service.getConversationForHeader(clicked);
  assertConversationMembers(snapshot, [clicked]);
  Assert.equal(snapshot.selectedId, String(clicked.messageKey));
  Assert.equal(snapshot.selectedMessage.folder.id, b.id);
});

add_task(
  async function test_multipleStoredReferenceRootsKeepEveryPhysicalMember() {
    const a = conversationRoot
      .createLocalSubfolder("conversation-stored-roots-a")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const b = conversationRoot
      .createLocalSubfolder("conversation-stored-roots-b")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const firstId = "stored-first@conversation.invalid";
    const secondId = "stored-second@conversation.invalid";
    const first = addConversationMail(a, firstId, []);
    const second = addConversationMail(b, secondId, []);
    addConversationMail(b, "stored-unrelated@conversation.invalid", []);
    Assert.notEqual(first.threadId, second.threadId);
    const file = do_get_profile().clone();
    file.append("conversation-stored-roots.sqlite");
    const service = await MailSearchService.open(
      file,
      database.sourceId,
      messageDB
    );
    registerCleanupFunction(() => service.close());
    Assert.equal(await service.getText(String(first.messageKey)), null);
    for (const header of [first, second]) {
      assertConversationMembers(
        await service.getConversation(conversationSelection(service, header)),
        [header]
      );
    }

    // Capture the legacy omission input: both referenced roots already exist in
    // distinct native components when the message connecting them is ingested.
    const bridge = addConversationMail(
      a,
      "stored-bridge@conversation.invalid",
      [firstId, secondId]
    );
    Assert.equal(bridge.numReferences, 2);
    Assert.equal(bridge.getStringReference(0), firstId);
    Assert.equal(bridge.getStringReference(1), secondId);
    const expected = [first, second, bridge];
    for (const selected of expected) {
      const snapshot = await service.getConversation(
        conversationSelection(service, selected)
      );
      assertConversationMembers(snapshot, expected);
      Assert.equal(snapshot.selectedId, String(selected.messageKey));
      Assert.equal(snapshot.selectedMessage.messageKey, selected.messageKey);
      Assert.equal(snapshot.selectedMessage.folder.id, selected.folder.id);
      const streamed = [];
      await service.streamResultHeaders(snapshot, header =>
        streamed.push(header)
      );
      Assert.deepEqual(
        streamed
          .map(header => [header.folder.id, header.messageKey])
          .toSorted((left, right) => left[1] - right[1]),
        expected
          .map(header => [header.folder.id, header.messageKey])
          .toSorted((left, right) => left[1] - right[1]),
        "Every reference-connected physical member streams from every seed"
      );
    }
  }
);

/**
 * Checks current physical selection and complete streamed conversation members.
 *
 * @param {MailSearchService} service - Current native conversation consumer.
 * @param {nsIMsgDBHdr} selected - Independently selected physical header.
 * @param {nsIMsgDBHdr[]} expected - Complete independent physical member set.
 * @returns {Promise<void>} Resolves after the real header stream finishes.
 */
async function assertCurrentConversation(service, selected, expected) {
  const snapshot = await service.getConversationForHeader(selected);
  assertConversationMembers(snapshot, expected);
  Assert.equal(snapshot.selectedId, String(selected.messageKey));
  Assert.equal(snapshot.selectedMessage.messageKey, selected.messageKey);
  Assert.equal(snapshot.selectedMessage.folder.id, selected.folder.id);
  const headers = [];
  await service.streamResultHeaders(snapshot, header => headers.push(header));
  Assert.deepEqual(
    headers
      .map(header => [header.folder.id, header.messageKey])
      .toSorted((a, b) => a[1] - b[1]),
    expected
      .map(header => [header.folder.id, header.messageKey])
      .toSorted((a, b) => a[1] - b[1]),
    "The full current conversation streams each physical copy exactly once"
  );
}

/**
 * Drains the small fixture through ordinary bounded sidecar indexing updates.
 *
 * @param {MailSearchService} service - Native service owning the derived index.
 * @returns {Promise<object>} Completed durable progress and source watermark.
 */
async function drainConversationIndex(service) {
  for (let i = 0; i < 200; i++) {
    const progress = await service.update({ limit: 500 });
    if (!progress.moreWork) {
      Assert.equal(progress.rebuilding, false);
      Assert.equal(progress.acceptedThrough, progress.sourceWatermark);
      return progress;
    }
  }
  throw new Error("Conversation fixture indexing did not finish bounded work");
}

add_task(
  async function test_physicalCopyReindexAndLastDeletionKeepCurrentMembership() {
    // Finished snapshot cases retain stored messages in this shared core. Retire
    // only their fixture folders before rebuilding this case's derived index.
    for (const folder of [...conversationRoot.subFolders]) {
      if (!conversationInitialFolderURIs.has(folder.URI)) {
        conversationRoot.propagateDelete(folder, true);
      }
    }
    const a = conversationRoot
      .createLocalSubfolder("conversation-copy-reindex-a")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const b = conversationRoot
      .createLocalSubfolder("conversation-copy-reindex-b")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const c = conversationRoot
      .createLocalSubfolder("conversation-copy-reindex-c")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const rootId = "copy-reindex-root@conversation.invalid";
    const root = addConversationMail(a, rootId, []);
    const reply = addConversationMail(
      b,
      "copy-reindex-reply@conversation.invalid",
      [rootId]
    );
    const control = addConversationMail(
      a,
      "copy-reindex-control@conversation.invalid",
      []
    );
    const file = do_get_profile().clone();
    file.append("conversation-before-copy-reindex.sqlite");
    const service = await MailSearchService.open(
      file,
      database.sourceId,
      messageDB
    );
    registerCleanupFunction(() => service.close());
    await assertCurrentConversation(service, reply, [root, reply]);
    const transfers = [];
    const notification = {
      msgsMoveCopyCompleted(isMove, sources, target, messages) {
        if (target.URI == c.URI) {
          transfers.push({
            isMove,
            sources: sources.map(header => ({
              key: header.messageKey,
              folderURI: header.folder.URI,
            })),
            keys: messages.map(header => header.messageKey),
          });
        }
      },
    };
    const copyListener = new PromiseTestUtils.PromiseCopyListener();
    MailServices.mfn.addListener(
      notification,
      MailServices.mfn.msgsMoveCopyCompleted
    );
    try {
      MailServices.copy.copyMessages(
        a,
        [root],
        c,
        false,
        copyListener,
        null,
        false
      );
      await copyListener.promise;
    } finally {
      MailServices.mfn.removeListener(notification);
    }
    Assert.equal(transfers.length, 1, "One actual completed native copy");
    Assert.equal(transfers[0].isMove, false);
    Assert.deepEqual(transfers[0].sources, [
      { key: root.messageKey, folderURI: a.URI },
    ]);
    Assert.equal(transfers[0].keys.length, 1);
    const copied = messageDB.getMessage(transfers[0].keys[0]);
    Assert.equal(copied.folder.id, c.id);
    Assert.equal(copied.messageId, root.messageId);
    Assert.notEqual(copied.messageKey, root.messageKey);
    Assert.equal(messageDB.getMessage(root.messageKey).folder.id, a.id);
    Assert.equal(await service.getText(String(copied.messageKey)), null);
    for (const selected of [root, reply, copied]) {
      await assertCurrentConversation(service, selected, [root, reply, copied]);
    }
    await service.close();

    // Rebuild a fresh derived sidecar from the same committed native messages.
    // Neither physical identity nor complete membership depends on FTS state.
    const rebuiltFile = do_get_profile().clone();
    rebuiltFile.append("conversation-after-copy-reindex.sqlite");
    const rebuilt = await MailSearchService.open(
      rebuiltFile,
      database.sourceId,
      messageDB
    );
    registerCleanupFunction(() => rebuilt.close());
    await assertCurrentConversation(rebuilt, copied, [root, reply, copied]);
    await drainConversationIndex(rebuilt);
    Assert.ok(
      await rebuilt.getText(String(copied.messageKey)),
      "The copied stored bytes were actually indexed"
    );
    for (const selected of [root, reply, copied]) {
      await assertCurrentConversation(rebuilt, selected, [root, reply, copied]);
    }

    const removedTokens = [];
    for (const [removed, after] of [
      [root, [reply, copied]],
      [copied, [reply]],
      [reply, []],
    ]) {
      const token = conversationSelection(rebuilt, removed);
      removedTokens.push(token);
      const deleteListener = new PromiseTestUtils.PromiseCopyListener();
      removed.folder.deleteMessages(
        [removed],
        null,
        true,
        false,
        deleteListener,
        false
      );
      await deleteListener.promise;
      const deleted = await rebuilt.getConversation(token);
      Assert.equal(deleted.status, "deleted");
      Assert.equal(Object.hasOwn(deleted, "items"), false);
      if (after.length) {
        await assertCurrentConversation(rebuilt, after.at(-1), after);
      }
      await drainConversationIndex(rebuilt);
      for (const old of removedTokens) {
        const result = await rebuilt.getConversation(old);
        Assert.equal(result.status, "deleted");
        Assert.equal(Object.hasOwn(result, "items"), false);
      }
      if (after.length) {
        await assertCurrentConversation(rebuilt, after.at(-1), after);
      }
    }
    await assertCurrentConversation(rebuilt, control, [control]);
  }
);

add_task(async function test_inboxSentArchiveRolesKeepCurrentMovedSelection() {
  const inbox = conversationRoot
    .createLocalSubfolder("conversation-roles-inbox")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const sent = conversationRoot
    .createLocalSubfolder("conversation-roles-sent")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const archive = conversationRoot
    .createLocalSubfolder("conversation-roles-archive")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  for (const [folder, flag] of [
    [inbox, Ci.nsMsgFolderFlags.Inbox],
    [sent, Ci.nsMsgFolderFlags.SentMail],
    [archive, Ci.nsMsgFolderFlags.Archive],
  ]) {
    folder.setFlag(flag);
    Assert.equal(folder.flags & flag, flag);
  }
  const rootId = "roles-root@conversation.invalid";
  const replyId = "roles-reply@conversation.invalid";
  const root = addConversationMail(inbox, rootId, []);
  const reply = addConversationMail(sent, replyId, [rootId]);
  const tail = addConversationMail(archive, "roles-tail@conversation.invalid", [
    rootId,
    replyId,
  ]);
  const control = addConversationMail(
    sent,
    "roles-unrelated@conversation.invalid",
    []
  );
  Assert.equal(root.folder.id, inbox.id);
  Assert.equal(reply.folder.id, sent.id);
  Assert.equal(tail.folder.id, archive.id);
  const file = do_get_profile().clone();
  file.append("conversation-folder-roles.sqlite");
  const service = await MailSearchService.open(
    file,
    database.sourceId,
    messageDB
  );
  registerCleanupFunction(() => service.close());
  Assert.equal(await service.getText(String(reply.messageKey)), null);
  for (const selected of [root, reply, tail]) {
    await assertCurrentConversation(service, selected, [root, reply, tail]);
  }
  const token = conversationSelection(service, reply);
  const before = { key: reply.messageKey, folderURI: sent.URI };
  const transfers = [];
  const notification = {
    msgsMoveCopyCompleted(isMove, sources, target, messages) {
      if (target.URI == archive.URI) {
        transfers.push({
          isMove,
          sources: sources.map(header => ({
            key: header.messageKey,
            folderURI: header.folder.URI,
          })),
          keys: messages.map(header => header.messageKey),
        });
      }
    },
  };
  const copyListener = new PromiseTestUtils.PromiseCopyListener();
  MailServices.mfn.addListener(
    notification,
    MailServices.mfn.msgsMoveCopyCompleted
  );
  try {
    MailServices.copy.copyMessages(
      sent,
      [reply],
      archive,
      true,
      copyListener,
      null,
      false
    );
    await copyListener.promise;
  } finally {
    MailServices.mfn.removeListener(notification);
  }
  Assert.equal(
    transfers.length,
    1,
    "One completed native Sent-to-Archive move"
  );
  Assert.equal(transfers[0].isMove, true);
  Assert.deepEqual(transfers[0].sources, [before]);
  Assert.equal(transfers[0].keys.length, 1);
  const moved = messageDB.getMessage(transfers[0].keys[0]);
  Assert.equal(moved.folder.id, archive.id);
  Assert.equal(
    moved.folder.flags & Ci.nsMsgFolderFlags.Archive,
    Ci.nsMsgFolderFlags.Archive
  );
  Assert.equal(moved.messageId, replyId);
  Assert.ok(moved.messageKey != before.key || moved.folder.id != sent.id);
  Assert.equal(
    (await service.getConversation(token)).status,
    moved.messageKey == before.key ? "stale" : "deleted"
  );
  for (const selected of [root, moved, tail]) {
    await assertCurrentConversation(service, selected, [root, moved, tail]);
  }
  await assertCurrentConversation(service, control, [control]);
});
