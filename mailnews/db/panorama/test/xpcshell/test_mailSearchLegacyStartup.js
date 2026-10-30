/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { MailGlue } = ChromeUtils.importESModule(
  "resource:///modules/MailGlue.sys.mjs"
);

const glue = Object.create(MailGlue.prototype);

add_setup(function setupLegacyBackend() {
  do_get_profile();
  Assert.equal(Services.prefs.getBoolPref("mail.panorama.enabled"), false);
  Assert.equal(
    Services.prefs.getBoolPref("mailnews.database.global.indexer.enabled"),
    false
  );
  Assert.ok(
    !(glue._getMailSearchBackend() instanceof Ci.nsIDatabaseCore),
    "This process must select the real legacy database before startup"
  );
  registerCleanupFunction(() => glue._shutdownMailSearch());
});

add_task(async function test_legacyStartupLoadsOnlyTheRetainedIndexer() {
  Assert.ok(
    !Cu.isESModuleLoaded("resource:///modules/gloda/GlodaPublic.sys.mjs")
  );
  Assert.ok(
    !Cu.isESModuleLoaded("resource:///modules/panorama/MailSearch.sys.mjs")
  );
  const starting = glue._initMailSearch();
  Assert.equal(glue._initMailSearch(), starting);
  await starting;
  Assert.ok(
    Cu.isESModuleLoaded("resource:///modules/gloda/GlodaPublic.sys.mjs"),
    "The real nonnative startup retains Gloda"
  );
  Assert.ok(
    !Cu.isESModuleLoaded("resource:///modules/panorama/MailSearch.sys.mjs"),
    "Legacy startup does not load the native factory"
  );
  const { GlodaIndexer } = ChromeUtils.importESModule(
    "resource:///modules/gloda/GlodaIndexer.sys.mjs"
  );
  Assert.equal(GlodaIndexer.enabled, false, "The indexing preference survives");
  Assert.equal(glue._mailSearchShutdownBlocker, null);
  const closing = glue._shutdownMailSearch();
  Assert.equal(glue._shutdownMailSearch(), closing);
  await closing;
  await glue._initMailSearch();
  Assert.ok(
    !Cu.isESModuleLoaded("resource:///modules/panorama/MailSearch.sys.mjs"),
    "Late idle startup and shutdown do not create a native service"
  );
});

add_task(async function test_nativeFactoryRejectsTheRealLegacyBackend() {
  const { getMailSearchService, closeMailSearch } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearch.sys.mjs"
  );
  await Assert.rejects(
    getMailSearchService(),
    error =>
      error.result === Cr.NS_ERROR_NOT_AVAILABLE &&
      error.message === "Panorama search requires the active native database"
  );
  await closeMailSearch();
  Assert.ok(
    !Cu.isESModuleLoaded(
      "resource:///modules/panorama/MailSearchService.sys.mjs"
    ),
    "Rejection happens before opening the native writer"
  );
  const profileFiles = await IOUtils.getChildren(PathUtils.profileDir);
  Assert.deepEqual(
    profileFiles
      .map(path => PathUtils.filename(path))
      .filter(name => /^panorama(?:-search-.*)?\.sqlite/.test(name)),
    [],
    "Neither a native core database nor a search sidecar was created"
  );
  Assert.equal(Services.prefs.getBoolPref("mail.panorama.enabled"), false);
});
