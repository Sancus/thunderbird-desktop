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
  await SpecialPowers.pushPrefEnv({ set: [["mail.panorama.enabled", false]] });
  try {
    Assert.ok(
      glue._getMailSearchBackend() instanceof Ci.nsIDatabaseCore,
      "Changing the live preference does not replace the startup-selected native backend"
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
    await SpecialPowers.popPrefEnv();
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
