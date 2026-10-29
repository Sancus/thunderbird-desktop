/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { MailSearchAutoComplete } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchAutoComplete.sys.mjs"
);
const { canCompleteMailSearchPeople } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchCompletion.sys.mjs"
);
const {
  getMailSearchService,
  closeMailSearch,
  completeMailSearch,
  findMailSearchResults,
} = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearch.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
const { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);
const completionPref = "mailnews.database.global.indexer.enabled";
let completionService, folderA, folderB, copyA, copyB;

/**
 * Observes the actual autocomplete protocol, keeping snapshots of each status.
 *
 * @param {nsIAutoCompleteSearch} provider - Search implementation.
 * @param {string} text - Search input.
 * @param {string} [param="global"] - Controller mode.
 * @returns {{done: Promise<object>, statuses: number[]}} Terminal result and notifications.
 */
function autocomplete(provider, text, param = "global") {
  const terminal = Promise.withResolvers();
  const statuses = [];
  provider.startSearch(text, param, null, {
    onSearchResult(search, result) {
      Assert.equal(search.wrappedJSObject, provider.wrappedJSObject);
      statuses.push(result.searchResult);
      if (
        ![
          Ci.nsIAutoCompleteResult.RESULT_SUCCESS_ONGOING,
          Ci.nsIAutoCompleteResult.RESULT_NOMATCH_ONGOING,
        ].includes(result.searchResult)
      ) {
        terminal.resolve(result.wrappedJSObject);
      }
    },
  });
  return { done: terminal.promise, statuses };
}

/**
 * Attaches the production search to a real controller through a test-local
 * contract. Input/popup fields follow toolkit's head_autocomplete.js fixture.
 *
 * @param {MailSearchAutoComplete} provider - Production search with deferred completion.
 * @param {string} text - Initial textbox value.
 * @returns {{controller: nsIAutoCompleteController, input: nsIAutoCompleteInput,
 *   done: Promise<void>}} Attached controller and terminal notification.
 */
function completionController(provider, text) {
  const name = "panorama-mail-completion-" + Services.uuid.generateUUID();
  const cid = MockRegistrar.register(
    "@mozilla.org/autocomplete/search;1?name=" + name,
    provider
  );
  registerCleanupFunction(() => MockRegistrar.unregister(cid));
  const controller = Cc[
    "@mozilla.org/autocomplete/controller;1"
  ].createInstance(Ci.nsIAutoCompleteController);
  registerCleanupFunction(() => {
    controller.input = null;
    provider.stopSearch();
  });
  const terminal = Promise.withResolvers();
  const input = {
    QueryInterface: ChromeUtils.generateQI(["nsIAutoCompleteInput"]),
    controller,
    searchCount: 1,
    getSearchAt(index) {
      Assert.equal(index, 0);
      return name;
    },
    searchParam: "global",
    timeout: 0,
    minResultsForPopup: 1,
    disableAutoComplete: false,
    completeDefaultIndex: false,
    completeSelectedIndex: false,
    invalidatePreviousResult: true,
    userContextId: 0,
    textValue: text,
    selectionStart: text.length,
    selectionEnd: text.length,
    selectTextRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
    onSearchBegin() {},
    onSearchComplete() {
      terminal.resolve();
    },
    popupOpen: false,
    popup: {
      QueryInterface: ChromeUtils.generateQI(["nsIAutoCompletePopup"]),
      selectedIndex: -1,
      invalidate() {},
    },
  };
  controller.input = input;
  return { controller, input, done: terminal.promise };
}

/**
 * Adds real MIME with a shared Message-ID, independent physical folder/key.
 *
 * @param {nsIMsgLocalMailFolder} folder - Physical destination.
 * @param {string} from - Encoded sender header.
 * @returns {nsIMsgDBHdr} Published native header.
 */
function addCompletionMail(folder, from) {
  return folder.addMessage(
    [
      "From: " + from,
      "To: =?UTF-8?Q?=E5=8F=97=E4=BF=A1=E4=BA=BA?= <cjk@example.invalid>",
      "Cc: Carbon Completion <carbon@example.invalid>",
      "Bcc: Blind Visible <blind@example.invalid>",
      "Date: Tue, 01 Jan 2019 00:00:00 +0000",
      "Message-ID: <completion-shared@example.invalid>",
      "Subject: Completion fixture",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "body",
      "",
    ].join("\r\n")
  );
}

/** Drains this small fixture through the existing bounded update API. */
async function drainCompletion() {
  for (let i = 0; i < 100; i++) {
    if (!(await completionService.update({ limit: 500 })).moreWork) {
      return;
    }
  }
  throw new Error("Completion fixture did not finish indexing");
}

add_setup(async function setupNativeCompletion() {
  do_get_profile();
  loadExistingDB();
  const had = Services.prefs.prefHasUserValue(completionPref);
  const old = Services.prefs.getBoolPref(completionPref, false);
  Services.prefs.setBoolPref(completionPref, true);
  registerCleanupFunction(async () => {
    await closeMailSearch();
    had
      ? Services.prefs.setBoolPref(completionPref, old)
      : Services.prefs.clearUserPref(completionPref);
  });
  const book = MailServices.ab.getDirectory("jsaddrbook://abook.sqlite");
  for (const [email, name] of [
    ["elodie@example.invalid", "Catalog Élodie"],
    ["blind@example.invalid", "BlindCatalog"],
  ]) {
    const card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
      Ci.nsIAbCard
    );
    card.primaryEmail = email;
    card.displayName = name;
    const added = book.addCard(card);
    registerCleanupFunction(() => book.deleteCards([added]));
  }
  MailServices.tags.addTagForKey(
    "completion-azure",
    "Azure Work",
    "#0000ff",
    ""
  );
  MailServices.tags.addTagForKey(
    "completion-percent",
    "Literal%Task",
    "#0000ff",
    ""
  );
  registerCleanupFunction(() => {
    MailServices.tags.deleteKey("completion-azure");
    MailServices.tags.deleteKey("completion-percent");
  });
  const parent = MailServices.accounts
    .createLocalMailAccount()
    .incomingServer.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  folderA = parent
    .createLocalSubfolder("completion-a")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  folderB = parent
    .createLocalSubfolder("completion-b")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const sender = "=?UTF-8?Q?=C3=89lodie_Header?= <ELODIE@example.invalid>";
  copyA = addCompletionMail(folderA, sender);
  copyB = addCompletionMail(folderB, sender);
  copyA.setStringProperty("keywords", "completion-azure");
  copyB.setStringProperty("keywords", "completion-azure");
  addCompletionMail(folderA, "Literal%Name <percent@example.invalid>");
  addCompletionMail(folderA, "LiteralXName <different@example.invalid>");
  messageDB.addMessage(
    folderA.id,
    "completion-metadata@example.invalid",
    [],
    1546300800000000,
    "Unavailable Person <unavailable@example.invalid>",
    "",
    "",
    "",
    "Metadata only",
    0,
    "",
    Ci.nsMsgPriority.notSet
  );
  completionService = await getMailSearchService();
  await drainCompletion();
});

add_task(async function test_registeredNativeCompletionAndTypedSelection() {
  const search = Cc["@mozilla.org/autocomplete/search;1?name=gloda"].getService(
    Ci.nsIAutoCompleteSearch
  );
  const provider = search.wrappedJSObject;
  Assert.ok(provider instanceof MailSearchAutoComplete);
  Assert.ok(provider.isNativeMailSearch);
  const observed = autocomplete(search, "éLO");
  const result = await observed.done;
  Assert.equal(
    result.QueryInterface(Ci.nsIAutoCompleteResult).searchString,
    "éLO"
  );
  Assert.equal(result.sourceId, database.sourceId);
  Assert.equal(result.defaultIndex, -1);
  Assert.equal(result.matchCount, 1);
  Assert.deepEqual(observed.statuses, [
    Ci.nsIAutoCompleteResult.RESULT_NOMATCH_ONGOING,
    Ci.nsIAutoCompleteResult.RESULT_SUCCESS,
  ]);
  const row = result.getObjectAt(0);
  Assert.equal(row.label, "Catalog Élodie");
  Assert.deepEqual(row.selection, {
    type: "person",
    emails: ["elodie@example.invalid"],
  });
  Assert.equal(row.item.contact.name, row.label);
  Assert.equal(result.getValueAt(0), "elodie@example.invalid");
  Assert.equal(result.getLabelAt(0), "Catalog Élodie");
  Assert.equal(result.getCommentAt(0), "elodie@example.invalid");
  Assert.equal(result.getStyleAt(0), "gloda-single-identity-richlistitem");
  Assert.equal(result.getObjectAt(-1), null);
  Assert.equal(result.getObjectAt(result.matchCount), null);
  Assert.equal(result.isRemovableAt(0), false);
  Assert.equal(row.nounDef, undefined, "No invented Gloda noun");
  for (const module of [
    "GlodaConstants",
    "GlodaPublic",
    "GlodaDatastore",
    "GlodaIndexer",
  ]) {
    Assert.ok(
      !Cu.isESModuleLoaded("resource:///modules/gloda/" + module + ".sys.mjs"),
      "Native completion did not load " + module
    );
  }
  provider.stopSearch();
  Assert.equal(
    provider.curResult.getObjectAt(0),
    row,
    "EnterMatch reads the selected row after StopSearch"
  );
  Assert.equal(result.getFinalCompleteValueAt(0), "elodie@example.invalid");
  const selected = await findMailSearchResults("", {
    selection: row.selection,
  });
  Assert.equal(copyA.messageId, copyB.messageId);
  Assert.notEqual(copyA.messageKey, copyB.messageKey);
  Assert.deepEqual(
    selected.items.map(item => item.id).sort(),
    [String(copyA.messageKey), String(copyB.messageKey)].sort()
  );
});

add_task(async function test_peopleHeadersMetadataOnlyAndLiteralTags() {
  for (const [query, email] of [
    ["Carbon", "carbon@example.invalid"],
    ["BlindCatalog", "blind@example.invalid"],
    ["受", "cjk@example.invalid"],
    ["Unavailable", "unavailable@example.invalid"],
  ]) {
    const data = await completeMailSearch(query);
    Assert.deepEqual(
      data.items
        .filter(item => item.selection.type == "person")
        .map(item => item.selection.emails[0]),
      [email],
      query
    );
  }
  const cjk = await completeMailSearch("受");
  Assert.equal(cjk.items[0].label, "受信人");
  const selected = await completionService.collectResults("Completion fixture", {
    selection: cjk.items[0].selection,
  });
  Assert.deepEqual(
    selected.items.find(item => item.id == String(copyA.messageKey)).to,
    [{ name: "受信人", email: "cjk@example.invalid" }]
  );
  Assert.ok(
    (await completionService.getText(String(copyA.messageKey))).recipients.includes("受信人")
  );
  const literal = await completeMailSearch("ral%");
  Assert.deepEqual(
    literal.items.map(item => item.selection),
    [
      { type: "person", emails: ["percent@example.invalid"] },
      { type: "tag", key: "completion-percent" },
    ]
  );
  const limited = await completeMailSearch("literal", { limit: 1 });
  Assert.equal(
    limited.items.filter(item => item.selection.type == "person").length,
    1
  );
  Assert.equal(
    limited.items.filter(item => item.selection.type == "tag").length,
    1
  );
  await Assert.rejects(
    completeMailSearch("literal", { limit: 0 }),
    error =>
      error.name == "RangeError" &&
      error.message == "Completion limit must be from 1 to 100"
  );
  const tag = await completeMailSearch("az");
  Assert.deepEqual(tag.items, [
    {
      label: "Azure Work",
      selection: { type: "tag", key: "completion-azure" },
    },
  ]);
  const provider = new MailSearchAutoComplete();
  const result = await autocomplete(provider, "Azure").done;
  Assert.equal(result.getObjectAt(1).item.key, "completion-azure");
  Assert.equal(result.getObjectAt(1).item.tag, "Azure Work");
  Assert.equal(result.getStyleAt(1), "gloda-single-tag-richlistitem");
  provider.stopSearch();
});

add_task(async function test_retainedThresholdsAndFullTextHints() {
  Assert.ok(!canCompleteMailSearchPeople("ab"));
  Assert.ok(canCompleteMailSearchPeople("abc"));
  for (const text of ["受", "あ", "한", "ｶ"]) {
    Assert.ok(canCompleteMailSearchPeople(text), text);
  }
  let calls = 0;
  const provider = new MailSearchAutoComplete(async () => {
    calls++;
    return { sourceId: database.sourceId, items: [] };
  });
  Assert.equal(
    (await autocomplete(provider, "a").done).searchResult,
    Ci.nsIAutoCompleteResult.RESULT_NOMATCH
  );
  Assert.equal(calls, 0);
  Assert.equal((await autocomplete(provider, "ab").done).matchCount, 0);
  Assert.equal(calls, 1, "Two letters may complete tags");
  Assert.equal((await autocomplete(provider, "abc").done).matchCount, 0);
  const text = '"alpha, beta" gamma,';
  const result = await autocomplete(provider, text).done;
  Assert.equal(
    result.getValueAt(0),
    text,
    "Retain the complete submitted query"
  );
  Assert.deepEqual(result.getObjectAt(0).words, ["alpha, beta", "gamma"]);
  Assert.equal(result.getStyleAt(0), "gloda-fulltext-all-richlistitem");
  const single = await autocomplete(provider, "report").done;
  Assert.equal(single.getStyleAt(0), "gloda-fulltext-single-richlistitem");
  const count = calls;
  Assert.equal(
    (await autocomplete(provider, "report", "other").done).matchCount,
    0
  );
  Assert.equal(calls, count, "Unsupported modes do not start native queries");
  provider.stopSearch();
});

add_task(async function test_stopAndReplacementDiscardLateCompletion() {
  const pending = [];
  const provider = new MailSearchAutoComplete((text, { signal }) => {
    const deferred = Promise.withResolvers();
    pending.push({ ...deferred, signal, text });
    return deferred.promise;
  });
  const old = autocomplete(provider, "older");
  await TestUtils.waitForCondition(() => pending.length == 1);
  const initial = provider.curResult;
  const next = autocomplete(provider, "newer");
  Assert.ok(pending[0].signal.aborted, "A new query cancels its predecessor");
  Assert.equal(initial.matchCount, 0, "Pending work has no selectable rows");
  Assert.equal(initial.getObjectAt(0), null);
  await TestUtils.waitForCondition(() => pending.length == 2);
  pending[0].resolve({
    sourceId: "discarded",
    items: [{ label: "Old", selection: { type: "tag", key: "old" } }],
  });
  pending[1].resolve({
    sourceId: database.sourceId,
    items: [{ label: "New", selection: { type: "tag", key: "new" } }],
  });
  const result = await next.done;
  Assert.equal(old.statuses.length, 1, "Stopped work has no late notification");
  Assert.equal(provider.curResult, result);
  Assert.equal(initial.active, false);
  Assert.equal(result.getObjectAt(1).selection.key, "new");
  Assert.ok(Object.isFrozen(result.getObjectAt(1).selection));
  provider.stopSearch();
});

add_task(async function test_failureIsNotFullTextOrEmptySuccess() {
  for (const failure of [
    new Error("Original completion failure"),
    new Error(""),
    null,
    undefined,
    false,
    0,
    "",
  ]) {
    const provider = new MailSearchAutoComplete(() => Promise.reject(failure));
    const result = await autocomplete(provider, "failure").done;
    Assert.equal(result.searchResult, Ci.nsIAutoCompleteResult.RESULT_FAILURE);
    Assert.strictEqual(result.error, failure);
    Assert.equal(result.errorDescription, "");
    Assert.equal(result.matchCount, 0);
    Assert.equal(result.getObjectAt(0), null);
    provider.stopSearch();
  }
  const malformed = new MailSearchAutoComplete(async () => ({ items: [] }));
  const malformedResult = await autocomplete(malformed, "missing-source").done;
  Assert.equal(
    malformedResult.searchResult,
    Ci.nsIAutoCompleteResult.RESULT_FAILURE
  );
  Assert.equal(malformedResult.error.name, "TypeError");
  Assert.equal(malformedResult.errorDescription, "");
  Assert.equal(malformedResult.matchCount, 0);
  malformed.stopSearch();
  const inFlight = new AbortController();
  const inFlightReason = new Error("Cancel queued native completion");
  const work = completionService.complete("élo", { signal: inFlight.signal });
  inFlight.abort(inFlightReason);
  await Assert.rejects(work, error => error === inFlightReason);
  const controller = new AbortController();
  const reason = new Error("Cancelled native completion");
  controller.abort(reason);
  await Assert.rejects(
    completeMailSearch("élo", { signal: controller.signal }),
    error => error === reason
  );
});

add_task(async function test_controllerPublishesRowsOnlyAfterSuccess() {
  const pending = Promise.withResolvers();
  const provider = new MailSearchAutoComplete(() => pending.promise);
  const { controller, done } = completionController(provider, "waiting");
  controller.startSearch("waiting");
  Assert.equal(
    controller.searchStatus,
    Ci.nsIAutoCompleteController.STATUS_SEARCHING
  );
  Assert.equal(controller.matchCount, 0);
  Assert.equal(
    provider.curResult.searchResult,
    Ci.nsIAutoCompleteResult.RESULT_NOMATCH_ONGOING
  );
  pending.resolve({
    sourceId: database.sourceId,
    items: [{ label: "Work", selection: { type: "tag", key: "work" } }],
  });
  await done;
  Assert.equal(
    controller.searchStatus,
    Ci.nsIAutoCompleteController.STATUS_COMPLETE_MATCH
  );
  Assert.equal(
    controller.matchCount,
    2,
    "Full-text and tag appear together on success"
  );
  Assert.equal(controller.getValueAt(0), "waiting");
  Assert.equal(controller.getValueAt(1), "Work");
  Assert.equal(provider.curResult.sourceId, database.sourceId);
  controller.stopSearch();
  Assert.equal(provider.curResult.getObjectAt(1).selection.key, "work");
});

add_task(async function test_controllerDisablingInFlightLeavesNoMatches() {
  const pending = Promise.withResolvers();
  const started = Promise.withResolvers();
  const provider = new MailSearchAutoComplete(() => {
    started.resolve();
    return pending.promise;
  });
  const { controller, input, done } = completionController(provider, "disable");
  controller.startSearch("disable");
  await started.promise;
  Assert.equal(controller.matchCount, 0, "Pending full-text is not counted");
  Assert.equal(
    provider.curResult.searchResult,
    Ci.nsIAutoCompleteResult.RESULT_NOMATCH_ONGOING
  );
  try {
    Services.prefs.setBoolPref(completionPref, false);
    pending.resolve({
      sourceId: database.sourceId,
      items: [{ label: "Private", selection: { type: "tag", key: "private" } }],
    });
    await done;
    Assert.equal(
      controller.searchStatus,
      Ci.nsIAutoCompleteController.STATUS_COMPLETE_NO_MATCH
    );
    Assert.equal(
      controller.matchCount,
      0,
      "Disabling leaves no phantom full-text match"
    );
    Assert.equal(input.popupOpen, false);
    Assert.equal(
      provider.curResult.searchResult,
      Ci.nsIAutoCompleteResult.RESULT_NOMATCH
    );
    Assert.equal(provider.curResult.matchCount, 0);
    Assert.equal(provider.curResult.getObjectAt(0), null);
  } finally {
    Services.prefs.setBoolPref(completionPref, true);
  }
});

add_task(async function test_controllerBackendRejectionHasNoMatches() {
  for (const failure of [
    new Error("Original controller completion failure"),
    new Error(""),
    null,
    undefined,
    false,
    0,
    "",
  ]) {
    const pending = Promise.withResolvers();
    const started = Promise.withResolvers();
    const provider = new MailSearchAutoComplete(() => {
      started.resolve();
      return pending.promise;
    });
    const { controller, input, done } = completionController(
      provider,
      "failure"
    );
    controller.startSearch("failure");
    await started.promise;
    Assert.equal(controller.matchCount, 0);
    pending.reject(failure);
    await done;
    Assert.equal(
      controller.searchStatus,
      Ci.nsIAutoCompleteController.STATUS_COMPLETE_NO_MATCH
    );
    Assert.equal(
      controller.matchCount,
      0,
      "Failure has no selectable popup row"
    );
    Assert.equal(input.popupOpen, false);
    Assert.equal(
      provider.curResult.searchResult,
      Ci.nsIAutoCompleteResult.RESULT_FAILURE
    );
    Assert.strictEqual(provider.curResult.error, failure);
    Assert.equal(provider.curResult.errorDescription, "");
    Assert.equal(provider.curResult.matchCount, 0);
    Assert.equal(provider.curResult.getObjectAt(0), null);
  }
});

add_task(async function test_cardNameChangesInvalidateCompletionLabels() {
  await drainCompletion();
  Assert.deepEqual(
    (await completeMailSearch("Catalog Élodie")).items.map(item => item.label),
    ["Catalog Élodie"]
  );
  const book = MailServices.ab.getDirectory("jsaddrbook://abook.sqlite");
  const card = MailServices.ab.cardForEmailAddress("elodie@example.invalid");
  card.displayName = "RenamedPerson";
  book.modifyCard(card);
  Assert.deepEqual(
    (await completeMailSearch("Catalog Élodie")).items,
    [],
    "The old card name cannot suggest stale metadata during refresh"
  );
  await drainCompletion();
  Assert.deepEqual((await completeMailSearch("RenamedPerson")).items, [
    {
      label: "RenamedPerson",
      selection: { type: "person", emails: ["elodie@example.invalid"] },
    },
  ]);
});

add_task(async function test_currentExclusionDeletionAndDisabledPreference() {
  folderA.setStringProperty("indexingPriority", "-1");
  // A folder-policy marker invalidates all projections until the normal rescan.
  await drainCompletion();
  let data = await completeMailSearch("élo");
  Assert.equal(
    data.items.length,
    1,
    "The other physical copy still proves this mailbox"
  );
  messageDB.removeMessage(copyB.messageKey);
  data = await completeMailSearch("élo");
  Assert.deepEqual(
    data.items,
    [],
    "Excluded and deleted copies never suggest an old mailbox"
  );
  Services.prefs.setBoolPref(completionPref, false);
  try {
    const provider = new MailSearchAutoComplete(() => {
      Assert.ok(false, "Disabled search must not issue completion work");
    });
    Assert.equal((await autocomplete(provider, "Azure").done).matchCount, 0);
    provider.stopSearch();
    Assert.deepEqual((await completeMailSearch("Azure")).items, []);
  } finally {
    Services.prefs.setBoolPref(completionPref, true);
    folderA.setStringProperty("indexingPriority", "20");
  }
});

add_task(
  async function test_initialCallbackCannotCancelItsReentrantSuccessor() {
    const calls = [];
    const provider = new MailSearchAutoComplete(async text => {
      calls.push(text);
      return { sourceId: database.sourceId, items: [] };
    });
    const failure = new Error("Original controller callback failure");
    let next;
    Assert.throws(
      () =>
        provider.startSearch("replaced", "global", null, {
          onSearchResult() {
            next = autocomplete(provider, "successor");
            throw failure;
          },
        }),
      error => error === failure
    );
    const result = await next.done;
    Assert.equal(result.searchString, "successor");
    Assert.equal(result.searchResult, Ci.nsIAutoCompleteResult.RESULT_SUCCESS);
    Assert.deepEqual(
      calls,
      ["successor"],
      "The old initial callback never starts backend work"
    );
    provider.stopSearch();
  }
);
