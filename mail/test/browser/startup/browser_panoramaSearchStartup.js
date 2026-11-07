/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { MailGlue } = ChromeUtils.importESModule(
  "resource:///modules/MailGlue.sys.mjs"
);
const { AsyncShutdown } = ChromeUtils.importESModule(
  "resource://gre/modules/AsyncShutdown.sys.mjs"
);

/**
 * Exercises search lifecycle methods without registering another application's
 * observers/actors. Each fixture removes its own profile blocker, leaving the
 * application's real shared search service under application ownership.
 *
 * @returns {MailGlue} Search-only receiver for the production prototype methods.
 */
function searchGlue() {
  const glue = Object.create(MailGlue.prototype);
  registerCleanupFunction(() => {
    if (glue._chatSearchShutdownBlocker) {
      AsyncShutdown.profileBeforeChange.removeBlocker(
        glue._chatSearchShutdownBlocker
      );
    }
    if (glue._mailSearchShutdownBlocker) {
      AsyncShutdown.profileBeforeChange.removeBlocker(
        glue._mailSearchShutdownBlocker
      );
    }
  });
  return glue;
}

add_task(async function test_idleStartupLoadsTheNativeFactory() {
  await MailGlue.afterStartUp;
  Assert.ok(
    Cu.isESModuleLoaded("resource:///modules/panorama/MailSearch.sys.mjs"),
    "The retained native idle startup loads the factory before the startup marker"
  );
});

add_task(async function test_nativeActivityDoesNotStartTheLegacyIndexer() {
  const legacyModule = "resource:///modules/gloda/GlodaPublic.sys.mjs";
  Assert.ok(
    !Cu.isESModuleLoaded(legacyModule),
    "Native startup has not started the legacy mail indexer"
  );
  const manager = Cc["@mozilla.org/activity-manager;1"].getService(
    Ci.nsIActivityManager
  );
  const process = Cc["@mozilla.org/activity-process;1"].createInstance(
    Ci.nsIActivityProcess
  );
  process.init("Native search activity regression", "native-search-regression");
  process.contextType = "panorama-search";
  manager.addActivity(process);
  try {
    Assert.equal(
      window.MsgStatusFeedback._observedProcesses.get(process.id),
      process,
      "The status bar observes the real native activity"
    );
    Assert.ok(
      !Cu.isESModuleLoaded(legacyModule),
      "Showing native search progress does not start the legacy mail indexer"
    );
  } finally {
    process.state = Ci.nsIActivityProcess.STATE_COMPLETED;
    manager.removeActivity(process.id);
  }
  Assert.ok(
    !window.MsgStatusFeedback._observedProcesses.has(process.id),
    "The completed native activity is no longer observed"
  );
});

add_task(async function test_nonPanoramaBackendRetainsLegacyStartup() {
  const glue = searchGlue();
  let legacy = 0;
  glue._getMailSearchBackend = () => ({});
  glue._startLegacyMailSearch = () => legacy++;
  Object.defineProperty(glue, "_mailSearchModule", {
    get() {
      throw new Error("A non-native backend must not load the native factory");
    },
  });
  const first = glue._initMailSearch();
  const second = glue._initMailSearch();
  Assert.equal(first, second);
  await first;
  await glue._initMailSearch();
  Assert.equal(legacy, 1);
  Assert.equal(glue._mailSearchShutdownBlocker, null);
  await glue._shutdownMailSearch();
  Assert.equal(legacy, 1, "Shutdown does not restart either indexer");
});

add_task(async function test_registeredNativeBackendCoalescesStartupAndClose() {
  const glue = searchGlue();
  let opens = 0;
  let closes = 0;
  let legacy = 0;
  glue._startLegacyMailSearch = () => legacy++;
  Object.defineProperty(glue, "_mailSearchModule", {
    value: {
      async getMailSearchService() {
        opens++;
      },
      async closeMailSearch() {
        closes++;
      },
    },
  });
  try {
    Assert.ok(
      glue._getMailSearchBackend() instanceof Ci.nsIDatabaseCore,
      "The native manifest selected the actual backend before startup"
    );
    const first = glue._initMailSearch();
    Assert.equal(first, glue._initMailSearch());
    await first;
    Assert.equal(opens, 1);
    Assert.equal(legacy, 0);
    Assert.equal(typeof glue._mailSearchShutdownBlocker, "function");
    const closing = glue._mailSearchShutdownBlocker();
    Assert.equal(closing, glue._shutdownMailSearch());
    await closing;
    await glue._initMailSearch();
    Assert.equal(opens, 1, "Late idle startup cannot reopen after shutdown");
    Assert.equal(closes, 1);
    Assert.equal(legacy, 0);
  } finally {
    await glue._shutdownMailSearch();
  }
});

add_task(
  async function test_shutdownBeforeIdlePreventsBackendAndModuleAccess() {
    const glue = searchGlue();
    let backendReads = 0;
    let moduleReads = 0;
    let legacy = 0;
    glue._getMailSearchBackend = () => {
      backendReads++;
      return {};
    };
    glue._startLegacyMailSearch = () => legacy++;
    Object.defineProperty(glue, "_mailSearchModule", {
      get() {
        moduleReads++;
        return {};
      },
    });
    const queued = glue._initMailSearch();
    const closing = glue._shutdownMailSearch();
    await Promise.all([queued, closing]);
    await glue._initMailSearch();
    Assert.equal(backendReads, 0);
    Assert.equal(moduleReads, 0);
    Assert.equal(legacy, 0);
    Assert.equal(glue._mailSearchShutdownBlocker, null);
  }
);

add_task(async function test_shutdownDuringOpenWaitsForTheSameFactory() {
  const glue = searchGlue();
  const opening = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const closeEntered = Promise.withResolvers();
  let opens = 0;
  let closes = 0;
  let drained = false;
  glue._startLegacyMailSearch = () =>
    Assert.ok(false, "Native open cannot fall back");
  Object.defineProperty(glue, "_mailSearchModule", {
    value: {
      getMailSearchService() {
        opens++;
        entered.resolve();
        return opening.promise;
      },
      closeMailSearch() {
        closes++;
        closeEntered.resolve();
        return opening.promise.then(() => {
          drained = true;
        });
      },
    },
  });
  const starting = glue._initMailSearch();
  try {
    await entered.promise;
    const closing = glue._mailSearchShutdownBlocker();
    Assert.equal(closing, glue._shutdownMailSearch());
    await closeEntered.promise;
    Assert.equal(
      drained,
      false,
      "The profile blocker waits for an unfinished open"
    );
    opening.resolve();
    await Promise.all([starting, closing]);
    Assert.equal(opens, 1);
    Assert.equal(closes, 1);
    Assert.equal(drained, true);
  } finally {
    opening.resolve();
    await glue._shutdownMailSearch();
  }
});

add_task(async function test_nativeStartupErrorDoesNotLoadLegacyOrRetry() {
  const glue = searchGlue();
  const failure = Components.Exception(
    "Native source identity unavailable",
    Cr.NS_ERROR_NOT_AVAILABLE
  );
  let opens = 0;
  let legacy = 0;
  glue._startLegacyMailSearch = () => legacy++;
  Object.defineProperty(glue, "_mailSearchModule", {
    value: {
      async getMailSearchService() {
        opens++;
        throw failure;
      },
      async closeMailSearch() {},
    },
  });
  const starting = glue._initMailSearch();
  await Assert.rejects(starting, error => error === failure);
  Assert.equal(glue._initMailSearch(), starting);
  await Assert.rejects(glue._initMailSearch(), error => error === failure);
  Assert.equal(opens, 1);
  Assert.equal(legacy, 0);
  await glue._shutdownMailSearch();
});

add_task(async function test_nativeCloseErrorIsPreservedOnce() {
  const glue = searchGlue();
  const failure = new Error("Native search close failed");
  let closes = 0;
  glue._startLegacyMailSearch = () =>
    Assert.ok(false, "Native close cannot fall back");
  Object.defineProperty(glue, "_mailSearchModule", {
    value: {
      async getMailSearchService() {},
      async closeMailSearch() {
        closes++;
        throw failure;
      },
    },
  });
  await glue._initMailSearch();
  const closing = glue._shutdownMailSearch();
  await Assert.rejects(closing, error => error === failure);
  Assert.equal(glue._shutdownMailSearch(), closing);
  await Assert.rejects(
    glue._mailSearchShutdownBlocker(),
    error => error === failure
  );
  Assert.equal(closes, 1);
});

add_task(async function test_startupUsesTheActualSharedNativeFactory() {
  const glue = searchGlue();
  glue._startLegacyMailSearch = () =>
    Assert.ok(false, "The active native backend must not import Gloda");
  const starting = glue._initMailSearch();
  Assert.equal(starting, glue._initMailSearch());
  await starting;
  const { getMailSearchService } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearch.sys.mjs"
  );
  const [first, second] = await Promise.all([
    getMailSearchService(),
    getMailSearchService(),
  ]);
  Assert.equal(
    first,
    second,
    "Startup and query callers share the default writer"
  );
  const backend = glue
    ._getMailSearchBackend()
    .QueryInterface(Ci.nsIDatabaseCore);
  const progress = await first.update({ limit: 1 });
  Assert.equal(progress.sourceId, backend.sourceId);
  Assert.ok(progress.sourceId);
  // Do not close the application's shared service from this fixture. Its actual
  // MailGlue and service profile blockers retain shutdown ownership.
});

add_task(async function test_idleChatStartupLoadsTheSeparateNativeProvider() {
  Assert.ok(Services.prefs.getBoolPref("mail.chat.enabled"));
  await TestUtils.waitForCondition(
    () =>
      Cu.isESModuleLoaded(
        "resource:///modules/panorama/ChatSearchService.sys.mjs"
      ),
    "The actual native idle task loads the separate chat provider"
  );
  Assert.ok(!Cu.isESModuleLoaded("resource:///modules/index_im.sys.mjs"));
});

add_task(async function test_chatStartupUsesTheActualSharedNativeService() {
  const glue = searchGlue();
  glue._startLegacyChatSearch = () =>
    Assert.ok(false, "Native chat cannot fall back to Gloda");
  const starting = glue._initChatSearch();
  Assert.equal(starting, glue._initChatSearch());
  await starting;
  const { getChatSearchService } = ChromeUtils.importESModule(
    "resource:///modules/panorama/ChatSearchService.sys.mjs"
  );
  const [first, second] = await Promise.all([
    getChatSearchService(),
    getChatSearchService(),
  ]);
  Assert.equal(first, second);
  Assert.deepEqual(
    (await first.search("unusedstartuptranscriptneedle")).items,
    []
  );
  Assert.ok(!Cu.isESModuleLoaded("resource:///modules/index_im.sys.mjs"));
  // As above, the application's actual MailGlue owns this shared service close.
});

add_task(async function test_chatShutdownDuringOpenDrainsTheSameFactory() {
  const glue = searchGlue();
  const opening = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const closeEntered = Promise.withResolvers();
  let opens = 0;
  let closes = 0;
  let drained = false;
  glue._startLegacyChatSearch = () =>
    Assert.ok(false, "Native open never imports the retired indexer");
  Object.defineProperty(glue, "_chatSearchModule", {
    value: {
      getChatSearchService() {
        opens++;
        entered.resolve();
        return opening.promise;
      },
      closeChatSearch() {
        closes++;
        closeEntered.resolve();
        return opening.promise.then(() => {
          drained = true;
        });
      },
    },
  });
  const starting = glue._initChatSearch();
  try {
    await entered.promise;
    const closing = glue._chatSearchShutdownBlocker();
    Assert.equal(closing, glue._shutdownChatSearch());
    await closeEntered.promise;
    Assert.equal(drained, false);
    opening.resolve();
    await Promise.all([starting, closing]);
    await glue._initChatSearch();
    Assert.equal(opens, 1);
    Assert.equal(closes, 1);
    Assert.equal(drained, true);
  } finally {
    opening.resolve();
    await glue._shutdownChatSearch();
  }
});

add_task(
  async function test_disabledAndNonNativeChatPreserveStartupSelection() {
    const disabled = searchGlue();
    disabled._getMailSearchBackend = () => {
      throw new Error("Disabled chat must not select a backend");
    };
    await SpecialPowers.pushPrefEnv({ set: [["mail.chat.enabled", false]] });
    try {
      await disabled._initChatSearch();
      await disabled._shutdownChatSearch();
      Assert.equal(disabled._chatSearchShutdownBlocker, null);
    } finally {
      await SpecialPowers.popPrefEnv();
    }
    const legacy = searchGlue();
    let starts = 0;
    legacy._getMailSearchBackend = () => ({});
    legacy._startLegacyChatSearch = () => starts++;
    Object.defineProperty(legacy, "_chatSearchModule", {
      get() {
        throw new Error("A nonnative backend must not open the native sidecar");
      },
    });
    await legacy._initChatSearch();
    await legacy._initChatSearch();
    await legacy._shutdownChatSearch();
    Assert.equal(starts, 1);
    Assert.equal(legacy._chatSearchShutdownBlocker, null);
  }
);

add_task(async function test_chatStartupErrorAndEarlyShutdownDoNotRetry() {
  const glue = searchGlue();
  const failure = new Error("Actual chat factory failure");
  let opens = 0;
  let closes = 0;
  glue._startLegacyChatSearch = () =>
    Assert.ok(false, "A native error cannot activate Gloda");
  Object.defineProperty(glue, "_chatSearchModule", {
    value: {
      getChatSearchService() {
        opens++;
        throw failure;
      },
      async closeChatSearch() {
        closes++;
      },
    },
  });
  const starting = glue._initChatSearch();
  await Assert.rejects(starting, error => error === failure);
  Assert.equal(glue._initChatSearch(), starting);
  await Assert.rejects(glue._initChatSearch(), error => error === failure);
  await glue._shutdownChatSearch();
  Assert.equal(opens, 1);
  Assert.equal(closes, 1);
  const early = searchGlue();
  let backendReads = 0;
  early._getMailSearchBackend = () => {
    backendReads++;
    throw new Error("Early shutdown must prevent backend access");
  };
  const queued = early._initChatSearch();
  await Promise.all([queued, early._shutdownChatSearch()]);
  Assert.equal(backendReads, 0);
  Assert.equal(early._chatSearchShutdownBlocker, null);
});
