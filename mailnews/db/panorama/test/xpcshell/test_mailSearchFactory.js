/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {
  getMailSearchService,
  closeMailSearch,
  openDefaultMailSearchList,
  findMailSearchResults,
  openDefaultMailSearchResultsList,
  retryUnavailableMailSearch,
} = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearch.sys.mjs"
);
const { MailSearchView } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchView.sys.mjs"
);

add_setup(function setupNativeFactory() {
  do_get_profile();
  loadExistingDB();
  Assert.equal(
    typeof database.sourceId,
    "string",
    "Core048 durable identity is required"
  );
  registerCleanupFunction(closeMailSearch);
});

add_task(async function test_coalescesNativeIdentityAndReopensSidecar() {
  const [first, second] = await Promise.all([
    getMailSearchService(),
    getMailSearchService(),
  ]);
  Assert.equal(first, second, "Default factory owns one writer");
  const progress = await first.update({ limit: 1 });
  Assert.equal(progress.sourceId, database.sourceId);
  await closeMailSearch();
  const reopened = await getMailSearchService();
  const resumed = await reopened.update({ limit: 1 });
  Assert.equal(resumed.sourceId, database.sourceId);
  Assert.greaterOrEqual(
    resumed.acceptedThrough,
    progress.acceptedThrough,
    "Reopening does not reset the sidecar checkpoint"
  );
});

add_task(async function test_defaultEntryUsesExistingListAndCancellation() {
  const opened = [];
  const tab = {};
  const tabmail = {
    openTab(name, options) {
      opened.push({ name, options });
      return tab;
    },
  };
  const result = await openDefaultMailSearchList(tabmail, "cobalt", {
    andTerms: false,
    title: "Search results",
    background: true,
  });
  Assert.equal(result, tab);
  Assert.equal(opened.length, 1);
  Assert.equal(opened[0].name, "mail3PaneTab");
  Assert.ok(opened[0].options.syntheticView instanceof MailSearchView);
  Assert.equal(opened[0].options.folderPaneVisible, false);
  Assert.equal(opened[0].options.title, "Search results");
  Assert.equal(opened[0].options.background, true);

  const controller = new AbortController();
  const reason = new Error("Cancel default search tab");
  controller.abort(reason);
  await Assert.rejects(
    openDefaultMailSearchList(tabmail, "cobalt", { signal: controller.signal }),
    error => error === reason
  );
  Assert.equal(opened.length, 1, "Cancelled entry does not open a tab");
});

add_task(async function test_typedFactoryAndFacetSubsetUseNativeSource() {
  const snapshot = await findMailSearchResults("", {
    selection: { type: "tag", key: "no-such-factory-tag" },
  });
  Assert.equal(snapshot.sourceId, database.sourceId);
  Assert.equal(typeof snapshot.resultSetId, "string");
  Assert.ok(snapshot.resultSetId);
  Assert.deepEqual(snapshot.items, []);
  const opened = [];
  const statuses = [];
  const tabmail = {
    tabInfo: opened,
    registerTabMonitor() {},
    unregisterTabMonitor() {},
    openTab(name, options) {
      Assert.equal(name, "mail3PaneTab");
      opened.push(options);
      options.syntheticView.search({
        onNewSearch() {},
        onSearchHit() {
          Assert.ok(false, "These literal selections have no native member");
        },
        onSearchDone(status) {
          statuses.push(status);
        },
      });
      return options;
    },
  };
  await openDefaultMailSearchList(tabmail, "", {
    selection: {
      type: "person",
      emails: ["no-such-factory-person@example.invalid"],
    },
    title: "Selected person",
  });
  await openDefaultMailSearchResultsList(tabmail, snapshot, {
    title: "Active facets",
  });
  Assert.equal(opened.length, 2);
  Assert.equal(opened[0].title, "Selected person");
  Assert.equal(opened[1].title, "Active facets");
  Assert.deepEqual(
    statuses,
    [Cr.NS_OK, Cr.NS_OK],
    "Captured lists finish before the factory returns"
  );
});

add_task(async function test_defaultUnavailableRetryAndCancellation() {
  const progress = await retryUnavailableMailSearch();
  Assert.equal(progress.sourceId, database.sourceId);
  const controller = new AbortController();
  const reason = new Error("Cancel default retry action");
  controller.abort(reason);
  await Assert.rejects(
    retryUnavailableMailSearch({ signal: controller.signal }),
    error => error === reason
  );
});

add_task(async function test_defaultActivationIndexesWithoutAQuery() {
  await closeMailSearch();
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
  const service = await getMailSearchService();
  const indexed = Promise.withResolvers();
  let watermark;
  const onProgress = service.onProgress;
  const onError = service.onError;
  service.onError = error => indexed.reject(error);
  service.onProgress = progress => {
    if (!progress.moreWork && progress.acceptedThrough >= watermark) {
      indexed.resolve();
    }
  };
  try {
    const folder = MailServices.accounts
      .createLocalMailAccount()
      .incomingServer.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder("default-activation")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const header = folder.addMessage(
      "From: sender@example.invalid\r\nSubject: activationneedle\r\nContent-Type: text/plain\r\n\r\nbackgroundbodyneedle\r\n"
    );
    watermark = messageDB.getSearchChanges(0, 1).watermark;
    await indexed.promise;
    const text = await service.getText(String(header.messageKey));
    Assert.ok(
      text,
      "Factory activation indexed a native addition without search or manual update"
    );
    Assert.ok(text.bodyIndexed);
    Assert.equal(text.body, "backgroundbodyneedle");
  } finally {
    service.onProgress = onProgress;
    service.onError = onError;
    await closeMailSearch();
  }
});

// Advancing shutdown is irreversible, so this must remain the last task.
add_task(async function test_shutdownPreventsReopening() {
  await closeMailSearch();
  Services.startup.advanceShutdownPhase(
    Ci.nsIAppStartup.SHUTDOWN_PHASE_APPSHUTDOWNCONFIRMED
  );
  Assert.ok(Services.startup.shuttingDown, "Shutdown has been confirmed");
  try {
    await Assert.rejects(
      getMailSearchService(),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
      "A caller cannot open a new search writer during shutdown"
    );
  } finally {
    await closeMailSearch();
  }
});
