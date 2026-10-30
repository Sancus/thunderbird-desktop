/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { MailSearchService } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchService.sys.mjs"
);
const { readMailSearchResult, getMailSearchFacets, copyMailSearchSelection } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearchResult.sys.mjs"
  );

const { getSearchHighlightRanges } = ChromeUtils.importESModule(
  "resource:///modules/panorama/SearchOffsets.sys.mjs"
);

const { MailStringUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailStringUtils.sys.mjs"
);

let service, rootFolder;

/** @type {{folder: nsIMsgLocalMailFolder, id: number, name: string}[]} */
const resultFolders = [];

add_setup(async function setupNativeResults() {
  do_get_profile();
  loadExistingDB();
  Assert.equal(typeof messageDB.getSearchState, "function");
  const pref = "mailnews.database.global.indexer.enabled";
  const hadPref = Services.prefs.prefHasUserValue(pref);
  const oldPref = Services.prefs.getBoolPref(pref, false);
  Services.prefs.setBoolPref(pref, true);
  registerCleanupFunction(() => {
    if (hadPref) {
      Services.prefs.setBoolPref(pref, oldPref);
    } else {
      Services.prefs.clearUserPref(pref);
    }
  });
  const account = MailServices.accounts.createLocalMailAccount();
  rootFolder = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const file = do_get_profile().clone();
  file.append("result-projection.sqlite");
  service = await MailSearchService.open(
    file,
    "isolated-result-test-core",
    messageDB
  );
  registerCleanupFunction(() => service.close());
});

/**
 * Drains this small native result fixture through bounded service updates.
 *
 * @returns {Promise<void>} Resolves when current source work has been accepted.
 */
async function drainResultWork() {
  for (let i = 0; ; i++) {
    Assert.less(i, 100, "Small native fixture finishes bounded work");
    if (!(await service.update({ limit: 50 })).moreWork) {
      return;
    }
  }
}

/**
 * Retires only the previous helper fixture after its consuming task finishes.
 * The next fixture's drain accepts the removals together with its new messages.
 */
function retireResultFixtures() {
  for (const { folder, id, name } of resultFolders.splice(0)) {
    // The orphan-folder task deliberately removes the folder database row.
    if (folderDB.getFolderChildNamed(rootFolder.id, name) != id) {
      continue;
    }
    for (const header of [...folder.messages]) {
      messageDB.removeMessage(header.messageKey);
    }
    rootFolder.propagateDelete(folder, true);
  }
}

/**
 * Adds two real copies and queries their independently supplied subject/body.
 *
 * @param {string} name - Literal unique query word and folder prefix.
 * @returns {Promise<object>} Native copies and their physical hits.
 */
async function resultCopies(name) {
  retireResultFixtures();
  const raw = [
    "From: Sender <sender@example.invalid>",
    "To: Recipient <recipient@example.invalid>",
    "Cc: Carbon <carbon@example.invalid>",
    "Bcc: Blind <blind@example.invalid>",
    "Date: Tue, 01 Jan 2019 00:00:00 +0000",
    "Message-ID: <shared-result@example.invalid>",
    "Subject: " + name,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "é 😀 café 自動 end",
    "",
  ].join("\r\n");
  const firstFolder = rootFolder
    .createLocalSubfolder(name + "-first")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const selectedFolder = rootFolder
    .createLocalSubfolder(name + "-selected")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  resultFolders.push(
    { folder: firstFolder, id: firstFolder.id, name: name + "-first" },
    { folder: selectedFolder, id: selectedFolder.id, name: name + "-selected" }
  );
  const first = firstFolder.addMessage(MailStringUtils.stringToByteString(raw));
  const selected = selectedFolder.addMessage(
    MailStringUtils.stringToByteString(raw)
  );
  selected.flags |= Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked;
  selected.setStringProperty("keywords", "tag-alpha tag-beta");
  await drainResultWork();
  const page = await service.search(name + " cafe");
  Assert.deepEqual(
    page.items.map(hit => hit.id).sort(),
    [String(first.messageKey), String(selected.messageKey)].sort()
  );
  return {
    first,
    selected,
    firstHit: page.items.find(hit => hit.id == String(first.messageKey)),
    selectedHit: page.items.find(hit => hit.id == String(selected.messageKey)),
  };
}

add_task(async function test_collectionRefreshesQueuedPhysicalMetadata() {
  const { first, selected } = await resultCopies("freshphysicalmetadata");
  const file = do_get_profile().clone();
  file.append("isolated-fresh-metadata.sqlite");
  const isolated = await MailSearchService.open(
    file,
    "isolated-fresh-metadata",
    messageDB
  );
  registerCleanupFunction(() => isolated.close());
  // Populate this writer without starting its idle observer. The query must
  // accept the subsequent tag changes itself, not inherit a queued idle batch.
  for (let i = 0; ; i++) {
    Assert.less(i, 100, "The isolated native fixture finishes bounded work");
    if (!(await isolated.update({ limit: 500 })).moreWork) {
      break;
    }
  }
  first.setStringProperty("keywords", "fresh-query-tag");
  selected.setStringProperty("keywords", "fresh-query-tag");
  const result = await isolated.collectResults("", {
    selection: { type: "tag", key: "fresh-query-tag" },
  });
  Assert.deepEqual(
    result.items.map(item => item.id).sort(),
    [String(first.messageKey), String(selected.messageKey)].sort(),
    "A query refreshes both existing physical copies after native tag changes"
  );
  await isolated.close();
});

add_task(
  async function test_refreshFailureReportsOriginalAndKeepsCurrentResults() {
    const { first, selected } = await resultCopies("failedrefreshcurrent");
    const update = service.update;
    const onError = service.onError;
    const failure = new Error("Unrelated background replay failed");
    const errors = [];
    service.update = async () => {
      throw failure;
    };
    service.onError = error => errors.push(error);
    try {
      const result = await service.collectResults("failedrefreshcurrent");
      Assert.deepEqual(
        result.items.map(item => item.id).sort(),
        [String(first.messageKey), String(selected.messageKey)].sort(),
        "An unrelated refresh error does not hide current physical results"
      );
      Assert.ok(
        errors.includes(failure),
        "The original background failure is reported"
      );
      Assert.ok(errors.every(error => error === failure));
      const controller = new AbortController();
      const reason = new Error("Cancel the pre-query refresh");
      service.update = async () => {
        controller.abort(reason);
        throw reason;
      };
      await Assert.rejects(
        service.collectResults("failedrefreshcurrent", {
          signal: controller.signal,
        }),
        error => error === reason
      );
    } finally {
      service.update = update;
      service.onError = onError;
    }
  }
);

add_task(async function test_physicalMetadataAndSnippet() {
  const { first, selected, selectedHit } = await resultCopies("previewresult");
  const result = await readMailSearchResult(service, selectedHit);
  Assert.equal(result.id, String(selected.messageKey));
  Assert.notEqual(result.id, String(first.messageKey));
  Assert.equal(
    result.messageId,
    first.messageId,
    "Message-ID is presentation data only"
  );
  Assert.deepEqual(result.location, {
    folderId: selected.folder.id,
    messageKey: selected.messageKey,
  });
  Assert.equal(result.textRevision, selectedHit.textRevision);
  Assert.equal(result.subject, "previewresult");
  Assert.equal(result.date.toISOString(), "2019-01-01T00:00:00.000Z");
  Assert.deepEqual(result.from, [
    { name: "Sender", email: "sender@example.invalid" },
  ]);
  Assert.deepEqual(result.to, [
    { name: "Recipient", email: "recipient@example.invalid" },
  ]);
  Assert.deepEqual(result.cc, [
    { name: "Carbon", email: "carbon@example.invalid" },
  ]);
  Assert.deepEqual(result.bcc, [
    { name: "Blind", email: "blind@example.invalid" },
  ]);
  Assert.deepEqual(result.tagKeys, ["tag-alpha", "tag-beta"]);
  Assert.ok(result.read);
  Assert.ok(result.starred);
  Assert.equal(result.hasAttachments, false);
  Assert.ok(result.originalContentAvailable);
  Assert.ok(result.canOpen);
  Assert.equal(result.snippet.firstMatchText, "café");
  const range = result.snippet.ranges[0];
  Assert.equal(result.snippet.text.substring(range.start, range.end), "café");
});

add_task(async function test_resultMailboxesUseCurrentAddressBookNames() {
  const book = MailServices.ab.getDirectory("jsaddrbook://abook.sqlite");
  const cards = [];
  try {
    for (const [email, name] of [
      ["sender@example.invalid", "Catalog Sender"],
      ["recipient@example.invalid", "Catalog Recipient"],
      ["carbon@example.invalid", "Catalog Carbon"],
      ["blind@example.invalid", "Catalog Blind"],
    ]) {
      const card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
        Ci.nsIAbCard
      );
      card.primaryEmail = email;
      card.displayName = name;
      cards.push(book.addCard(card));
    }
    const { first, selected, firstHit, selectedHit } = await resultCopies(
      "namedphysicalresult"
    );
    const expectedIds = [
      String(first.messageKey),
      String(selected.messageKey),
    ].sort();
    const result = await readMailSearchResult(service, selectedHit);
    for (const [role, email, name] of [
      ["from", "sender@example.invalid", "Catalog Sender"],
      ["to", "recipient@example.invalid", "Catalog Recipient"],
      ["cc", "carbon@example.invalid", "Catalog Carbon"],
      ["bcc", "blind@example.invalid", "Catalog Blind"],
    ]) {
      Assert.deepEqual(result[role], [{ name, email }]);
    }
    Assert.equal(result.id, String(selected.messageKey));
    Assert.deepEqual(result.location, {
      folderId: selected.folder.id,
      messageKey: selected.messageKey,
    });
    Assert.equal(
      (await readMailSearchResult(service, firstHit)).id,
      String(first.messageKey),
      "A shared contact name does not collapse physical copies"
    );
    cards[0].displayName = "Renamed Catalog Sender";
    book.modifyCard(cards[0]);
    Assert.equal(
      await readMailSearchResult(service, selectedHit),
      null,
      "A card edit invalidates the old text token"
    );
    await drainResultWork();
    const renamedPage = await service.search("namedphysicalresult cafe");
    Assert.deepEqual(renamedPage.items.map(hit => hit.id).sort(), expectedIds);
    const renamedHit = renamedPage.items.find(
      hit => hit.id == String(selected.messageKey)
    );
    Assert.deepEqual(
      (await readMailSearchResult(service, renamedHit)).from,
      [{ name: "Renamed Catalog Sender", email: "sender@example.invalid" }],
      "The current projection uses the edited card"
    );
    book.deleteCards(cards);
    cards.length = 0;
    Assert.equal(
      await readMailSearchResult(service, renamedHit),
      null,
      "Card deletion also rejects the old text token"
    );
    await drainResultWork();
    const restoredPage = await service.search("namedphysicalresult cafe");
    Assert.deepEqual(restoredPage.items.map(hit => hit.id).sort(), expectedIds);
    const restoredHit = restoredPage.items.find(
      hit => hit.id == String(selected.messageKey)
    );
    const restored = await readMailSearchResult(service, restoredHit);
    for (const [role, email, name] of [
      ["from", "sender@example.invalid", "Sender"],
      ["to", "recipient@example.invalid", "Recipient"],
      ["cc", "carbon@example.invalid", "Carbon"],
      ["bcc", "blind@example.invalid", "Blind"],
    ]) {
      Assert.deepEqual(restored[role], [{ name, email }]);
    }
  } finally {
    if (cards.length) {
      book.deleteCards(cards);
    }
  }
});

add_task(async function test_nativeChangeBetweenTextAndMetadataRejects() {
  const { first, selected, firstHit, selectedHit } =
    await resultCopies("changedresult");
  const changing = {
    async getText(id, options) {
      const text = await service.getText(id, options);
      selected.subject = "replacementresult";
      return text;
    },
    resolveDocument: (...args) => service.resolveDocument(...args),
  };
  Assert.equal(await readMailSearchResult(changing, selectedHit), null);
  Assert.equal(
    (await readMailSearchResult(service, firstHit)).id,
    String(first.messageKey),
    "Another physical copy stays available"
  );
});

add_task(async function test_deletedSelectedCopyAndCancellation() {
  const { first, selected, firstHit, selectedHit } =
    await resultCopies("deletedresult");
  messageDB.removeMessage(selected.messageKey);
  Assert.equal(
    await readMailSearchResult(service, selectedHit),
    null,
    "Deleted selected identity does not resolve another copy with the same Message-ID"
  );
  Assert.equal(
    (await readMailSearchResult(service, firstHit)).id,
    String(first.messageKey)
  );
  const controller = new AbortController();
  const reason = new Error("Cancel result projection");
  controller.abort(reason);
  await Assert.rejects(
    readMailSearchResult(service, firstHit, { signal: controller.signal }),
    error => error === reason
  );
});

add_task(async function test_deletedFolderRetainsExcludedPhysicalIdentity() {
  const { first, selected, selectedHit } = await resultCopies("orphanresult");
  const key = selected.messageKey;
  const folderId = selected.folder.id;
  folderDB.deleteFolder(folderId);
  const raw = messageDB.getSearchState(key);
  Assert.equal(raw.folderId, folderId, "Core retains the physical row");
  Assert.equal(raw.folderFlags, null);
  const state = service.resolveDocument(String(key));
  Assert.equal(state.eligible, false);
  Assert.equal(state.folder, null);
  Assert.equal(state.originalContentAvailable, false);
  Assert.equal(state.canOpen, false);
  Assert.equal(await readMailSearchResult(service, selectedHit), null);
  Assert.ok(service.resolveDocument(String(first.messageKey)).eligible);
  // Folder policy invalidation changes every generation; obtain a fresh hit.
  await drainResultWork();
  const page = await service.search("orphanresult cafe");
  Assert.deepEqual(
    page.items.map(hit => hit.id),
    [String(first.messageKey)]
  );
  Assert.equal(
    (await readMailSearchResult(service, page.items[0])).id,
    String(first.messageKey)
  );
});

/**
 * Stores independent address, tag and physical-copy controls.
 *
 * @param {string} name - Unique subject and folder prefix.
 * @returns {Promise<object>} Named native headers and the second copy's folder.
 */
async function typedResultFixture(name) {
  retireResultFixtures();
  const folder = rootFolder
    .createLocalSubfolder(name)
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const otherFolder = rootFolder
    .createLocalSubfolder(name + "-copy")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  resultFolders.push(
    { folder, id: folder.id, name },
    { folder: otherFolder, id: otherFolder.id, name: name + "-copy" }
  );
  const definitions = [
    {
      from: "person@example.invalid",
      to: "PERSON@example.invalid",
      tags: "primary",
    },
    { to: "person@example.invalid", tags: "primary-extra" },
    { cc: "PERSON@example.invalid", tags: "other" },
    { bcc: "person@example.invalid", tags: "primary primary" },
    { from: "alias@example.invalid", tags: "primary" },
    { from: "person@example.invalid", tags: "primary", folder: otherFolder },
    { body: "person@example.invalid", tags: "primary" },
    { from: "person+extra@example.invalid", tags: "primary-extra" },
  ];
  const headers = definitions.map(definition => {
    const header = (definition.folder || folder).addMessage(
      [
        "From: Sender <" + (definition.from || "other@example.invalid") + ">",
        "To: Recipient <" +
          (definition.to || "recipient@example.invalid") +
          ">",
        "Cc: Carbon <" + (definition.cc || "carbon@example.invalid") + ">",
        "Bcc: Blind <" + (definition.bcc || "blind@example.invalid") + ">",
        "Date: Tue, 01 Jan 2019 00:00:00 +0000",
        "Message-ID: <same-typed@example.invalid>",
        "Subject: " + name,
        "Content-Type: text/plain; charset=utf-8",
        "",
        definition.body || "unrelated body",
        "",
      ].join("\r\n")
    );
    header.setStringProperty("keywords", definition.tags);
    return header;
  });
  const [from, to, cc, bcc, alias, copy, bodyOnly, prefix] = headers;
  Assert.equal(from.messageId, copy.messageId);
  Assert.notEqual(from.messageKey, copy.messageKey);
  await drainResultWork();
  return { from, to, cc, bcc, alias, copy, bodyOnly, prefix, otherFolder };
}

add_task(async function test_typedPersonAndTagSelections() {
  const { from, to, cc, bcc, alias, copy, bodyOnly, prefix } =
    await typedResultFixture("typedresultneedle");
  const person = await service.collectResults("typedresultneedle", {
    selection: { type: "person", emails: ["PERSON@example.invalid"] },
  });
  Assert.deepEqual(
    person.items.map(item => item.id).sort(),
    [from, to, cc, bcc, copy].map(header => String(header.messageKey)).sort(),
    "Exact mailboxes include every address role, not body text or address prefixes"
  );
  Assert.ok(!person.items.some(item => item.id == String(bodyOnly.messageKey)));
  Assert.ok(!person.items.some(item => item.id == String(prefix.messageKey)));
  const selected = await service.collectResults("typedresultneedle", {
    selection: {
      type: "person",
      emails: ["person@example.invalid", "alias@example.invalid"],
    },
  });
  Assert.equal(selected.sourceId, "isolated-result-test-core");
  Assert.deepEqual(
    selected.items.map(item => item.id).sort(),
    [from, to, cc, bcc, alias, copy]
      .map(header => String(header.messageKey))
      .sort(),
    "A person with several email addresses uses OR semantics"
  );
  const tags = await service.collectResults("typedresultneedle", {
    selection: { type: "tag", key: "primary" },
  });
  Assert.deepEqual(
    tags.items.map(item => item.id).sort(),
    [from, bcc, alias, copy, bodyOnly]
      .map(header => String(header.messageKey))
      .sort(),
    "Tag keys use exact membership rather than text or prefix matching"
  );
});

add_task(async function test_facetGroupsPreservePhysicalMembers() {
  const { from, to, cc, bcc, alias, copy, bodyOnly, otherFolder } =
    await typedResultFixture("facetresultneedle");
  const results = await service.collectResults("facetresultneedle");
  const facets = getMailSearchFacets(results);
  Assert.equal(facets.resultSetId, results.resultSetId);
  Assert.deepEqual(
    facets.participants
      .find(group => group.value == "person@example.invalid")
      .ids.sort(),
    [from, to, cc, bcc, copy].map(header => String(header.messageKey)).sort(),
    "Repeated addresses in one physical message count once"
  );
  const primary = facets.tags.find(group => group.value == "primary");
  Assert.deepEqual(
    primary.ids.slice().sort(),
    [from, bcc, alias, copy, bodyOnly]
      .map(header => String(header.messageKey))
      .sort()
  );
  Assert.equal(primary.ids.length, 5);
  Assert.deepEqual(
    facets.folders.find(group => group.value == otherFolder.id).ids,
    [String(copy.messageKey)]
  );
});

add_task(async function test_activeListMembershipChecksCurrentCopies() {
  const { from, bcc, alias, copy } =
    await typedResultFixture("activelistneedle");
  const results = await service.collectResults("activelistneedle");
  const ids = [from, bcc, alias, copy].map(header => String(header.messageKey));
  const active = {
    ...results,
    items: results.items.filter(item => ids.includes(item.id)),
  };
  const exported = [];
  const delivery = await service.streamResultHeaders(active, header =>
    exported.push(header.messageKey)
  );
  Assert.equal(delivery.resultSetId, results.resultSetId);
  Assert.equal(delivery.count, 4);
  Assert.deepEqual(
    exported.sort((a, b) => a - b),
    [from.messageKey, bcc.messageKey, alias.messageKey, copy.messageKey].sort(
      (a, b) => a - b
    )
  );
  messageDB.removeMessage(copy.messageKey);
  from.setStringProperty("keywords", "other");
  const current = [];
  await service.streamResultHeaders(active, header =>
    current.push(header.messageKey)
  );
  Assert.deepEqual(
    current.sort((a, b) => a - b),
    [bcc.messageKey, alias.messageKey].sort((a, b) => a - b),
    "A stale active subset omits changed/deleted copies without rerunning the text query"
  );
  Assert.throws(
    () =>
      service.streamResultHeaders(
        { ...active, sourceId: "another-core" },
        () => {}
      ),
    /this mail database/
  );
  const controller = new AbortController();
  const reason = new Error("Cancel facet export");
  controller.abort(reason);
  await Assert.rejects(
    service.streamResultHeaders(
      active,
      () => Assert.ok(false, "No cancelled delivery"),
      {
        signal: controller.signal,
      }
    ),
    error => error === reason
  );
});

add_task(function test_selectionCopiesDoNotRetainAutocompleteObjects() {
  const selection = {
    type: "person",
    emails: ["ONE@example.invalid", "one@example.invalid"],
  };
  const copied = copyMailSearchSelection(selection);
  selection.emails.push("other@example.invalid");
  Assert.deepEqual(copied, { type: "person", emails: ["one@example.invalid"] });
  Assert.throws(
    () => copyMailSearchSelection({ type: "person", emails: [] }),
    error =>
      error.name == "TypeError" &&
      error.message == "Expected a person or tag search selection"
  );
  Assert.throws(
    () => copyMailSearchSelection({ type: "tag", key: "" }),
    error =>
      error.name == "TypeError" &&
      error.message == "Expected a person or tag search selection"
  );
  Assert.throws(
    () =>
      copyMailSearchSelection({
        type: "identity",
        value: "one@example.invalid",
      }),
    error =>
      error.name == "TypeError" &&
      error.message == "Expected a person or tag search selection"
  );
});

add_task(async function test_typedSelectionReachesLaterMetadataPage() {
  const folder = rootFolder.createLocalSubfolder("later-typed-page");
  const controls = [];
  for (let i = 0; i < 100; i++) {
    controls.push(
      messageDB.addMessage(
        folder.id,
        "same-page@example.invalid",
        [],
        123456,
        "Control <control@example.invalid>",
        "",
        "",
        "",
        "typedpagingneedle",
        0,
        "",
        Ci.nsMsgPriority.notSet
      )
    );
  }
  const expected = messageDB.addMessage(
    folder.id,
    "same-page@example.invalid",
    [],
    123456,
    "Selected <late-person@example.invalid>",
    "",
    "",
    "",
    "typedpagingneedle",
    0,
    "",
    Ci.nsMsgPriority.notSet
  );
  await drainResultWork();
  const results = await service.collectResults("", {
    selection: { type: "person", emails: ["late-person@example.invalid"] },
  });
  Assert.deepEqual(
    results.items.map(item => item.id),
    [String(expected)]
  );
  Assert.equal(results.items[0].originalContentAvailable, false);
  Assert.deepEqual(results.items[0].snippet, {
    text: "",
    ranges: [],
    firstMatchText: null,
  });

  // Later cases must not reindex this fixture's unavailable paging controls.
  for (const key of [...controls, expected]) {
    messageDB.removeMessage(key);
  }
  rootFolder.propagateDelete(folder, true);
  await drainResultWork();
});

add_task(async function test_cancelledCollectionDeliversNoSnapshot() {
  const controller = new AbortController();
  const reason = new Error("Cancel typed result collection");
  controller.abort(reason);
  await Assert.rejects(
    service.collectResults("", {
      selection: { type: "person", emails: ["person@example.invalid"] },
      signal: controller.signal,
    }),
    error => error === reason
  );
});

add_task(async function test_attachmentProofDiffersFromUnavailableFlag() {
  const { selected, selectedHit } = await resultCopies("attachmentproofresult");
  Assert.equal(
    (await readMailSearchResult(service, selectedHit)).attachmentPresence,
    false,
    "A parsed plain message proves absence"
  );
  const key = messageDB.addMessage(
    selected.folder.id,
    "missing-proof@example.invalid",
    [],
    123456,
    "Sender <sender@example.invalid>",
    "",
    "",
    "",
    "missingattachmentproof",
    Ci.nsMsgMessageFlags.Attachment,
    "",
    Ci.nsMsgPriority.notSet
  );
  await drainResultWork();
  const page = await service.search("missingattachmentproof");
  Assert.deepEqual(
    page.items.map(hit => hit.id),
    [String(key)]
  );
  const result = await readMailSearchResult(service, page.items[0]);
  Assert.ok(
    result.hasAttachments,
    "The native heuristic flag remains available"
  );
  Assert.equal(
    result.attachmentPresence,
    null,
    "Unavailable MIME is not known false or true"
  );
});

add_task(
  async function test_attachmentDetailsKeepPhysicalCopyAndProjectionIdentity() {
    const raw = [
      "From: sender@example.invalid",
      "Message-ID: <shared-attachment@example.invalid>",
      "Subject: attachmentdetailsneedle",
      "MIME-Version: 1.0",
      "Content-Type: multipart/mixed; boundary=details",
      "",
      "--details",
      "Content-Type: text/plain",
      "",
      "details body",
      "--details",
      "Content-Type: application/octet-stream",
      "Content-Disposition: attachment; filename=report.txt",
      "Content-Transfer-Encoding: base64",
      "",
      "YWJj",
      "--details--",
      "",
    ].join("\r\n");
    const first = rootFolder
      .createLocalSubfolder("attachment-details-first")
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .addMessage(raw);
    const selected = rootFolder
      .createLocalSubfolder("attachment-details-selected")
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .addMessage(raw);
    await drainResultWork();
    const hits = (await service.search("attachmentdetailsneedle")).items;
    Assert.deepEqual(
      hits.map(hit => hit.id).sort(),
      [String(first.messageKey), String(selected.messageKey)].sort()
    );
    const hit = hits.find(item => item.id == String(selected.messageKey));
    const result = await readMailSearchResult(service, hit);
    Assert.equal(result.id, String(selected.messageKey));
    Assert.equal(result.textRevision, hit.textRevision);
    Assert.equal(result.attachmentInfos.complete, true);
    const [attachment] = result.attachmentInfos.items;
    Assert.equal(result.attachmentInfos.items.length, 1);
    Assert.equal(attachment.name, "report.txt");
    Assert.equal(attachment.contentType, "application/octet-stream");
    Assert.equal(attachment.part, "1.2");
    Assert.equal(attachment.isExternal, false);
    Assert.equal(attachment.externalUrl, null);
    attachment.name = "caller mutation";
    Assert.equal(
      (await service.getText(result.id)).attachmentInfos.items[0].name,
      "report.txt"
    );
    messageDB.removeMessage(selected.messageKey);
    Assert.equal(await readMailSearchResult(service, hit), null);
    Assert.equal(
      (
        await readMailSearchResult(
          service,
          hits.find(item => item.id == String(first.messageKey))
        )
      ).id,
      String(first.messageKey)
    );
  }
);

add_task(async function test_completeExportChecksEveryPhysicalToken() {
  const { first, selected } = await resultCopies("strictphysicalexport");
  const results = await service.collectResults("strictphysicalexport");
  const exported = [];
  const receipt = await service.streamResultHeaders(
    results,
    header => exported.push(header.messageKey),
    { requireComplete: true }
  );
  Assert.equal(receipt.count, 2);
  Assert.deepEqual(
    exported.sort((a, b) => a - b),
    [first.messageKey, selected.messageKey].sort((a, b) => a - b)
  );
  selected.setStringProperty("keywords", "changed-after-capture");
  await Assert.rejects(
    service.streamResultHeaders(
      results,
      () => Assert.ok(false, "All tokens are checked before delivery"),
      { requireComplete: true }
    ),
    error => error.result == Cr.NS_ERROR_IN_PROGRESS
  );
  await drainResultWork();
  const fresh = await service.collectResults("strictphysicalexport");
  let calls = 0;
  await Assert.rejects(
    service.streamResultHeaders(
      fresh,
      () => {
        calls++;
        if (calls == 2) {
          first.setStringProperty("keywords", "changed-during-delivery");
        }
      },
      { requireComplete: true }
    ),
    error => error.result == Cr.NS_ERROR_IN_PROGRESS
  );
  Assert.equal(
    calls,
    2,
    "Mutation by a delivery callback cannot certify the older set"
  );
});

add_task(async function test_nativeTextRevisionRejectsOldOffsetsAfterRefresh() {
  const { first, selected, firstHit, selectedHit } = await resultCopies(
    "revisionrefreshresult"
  );
  const before = await service.getText(String(selected.messageKey));
  Assert.equal(before.body, "é 😀 café 自動 end");
  Assert.deepEqual(getSearchHighlightRanges(selectedHit, before), [
    { start: 5, end: 9 },
  ]);

  selected.subject = "refreshedrevisionresult";
  await drainResultWork();
  const current = await service.getText(String(selected.messageKey));
  Assert.equal(current.body, "é 😀 café 自動 end");
  Assert.notEqual(current.textRevision, before.textRevision);
  Assert.equal(
    getSearchHighlightRanges(selectedHit, current),
    null,
    "Unchanged body bytes do not make an old projection's offsets current"
  );
  Assert.equal(await readMailSearchResult(service, selectedHit), null);
  const page = await service.search("refreshedrevisionresult cafe");
  Assert.deepEqual(
    page.items.map(hit => hit.id),
    [String(selected.messageKey)]
  );
  const result = await readMailSearchResult(service, page.items[0]);
  Assert.equal(result.textRevision, current.textRevision);
  Assert.deepEqual(result.location, {
    folderId: selected.folder.id,
    messageKey: selected.messageKey,
  });
  Assert.equal(result.snippet.text, "é 😀 café 自動 end");
  Assert.deepEqual(result.snippet.ranges, [{ start: 5, end: 9 }]);
  Assert.equal(result.snippet.firstMatchText, "café");

  const unchanged = await readMailSearchResult(service, firstHit);
  Assert.equal(unchanged.id, String(first.messageKey));
  Assert.equal(unchanged.textRevision, firstHit.textRevision);
  Assert.deepEqual(unchanged.snippet.ranges, [{ start: 5, end: 9 }]);
  Assert.deepEqual(
    (await service.search("revisionrefreshresult cafe")).items.map(
      hit => hit.id
    ),
    [String(first.messageKey)],
    "Only the changed physical copy leaves the old subject query"
  );
});
