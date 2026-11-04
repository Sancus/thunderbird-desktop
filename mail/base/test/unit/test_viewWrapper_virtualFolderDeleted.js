/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Test bug 450059: a virtual folder (saved search) that is deleted while it is
 * displayed in a DBViewWrapper must not be resurrected.
 *
 * The view wrapper's close() used to call endFolderLoading() even for folders
 * being deleted, which runs UpdateSummaryTotals() -> FlushToFolderCache() and
 * re-writes the folder cache entry (including the Virtual flag) for a folder
 * whose cache entry and summary file were just removed by the deletion. A
 * subsequent folder created with the same name would then incorrectly read the
 * Virtual flag back from the cache.
 */

/* import-globals-from resources/viewWrapperTestUtils.js */
load("resources/viewWrapperTestUtils.js");
initViewWrapperTestUtils({ mode: "local" });

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

/**
 * Reads the existing native folder row without resolving or recreating a URI.
 *
 * @param {mozIStorageConnection} connection - The current native connection.
 * @param {number} id - The captured physical folder ID.
 * @returns {number|null} The current flags, or null for a retired folder.
 */
function nativeFolderFlags(connection, id) {
  const statement = connection.createStatement(
    "SELECT flags FROM folders WHERE id = :id"
  );
  try {
    statement.params.id = id;
    return statement.executeStep() ? statement.row.flags : null;
  } finally {
    statement.finalize();
  }
}

/**
 * Captures the native cache and metadata handles before deleting a saved search.
 *
 * @param {nsIMsgFolder} folder - The saved search being displayed.
 * @param {nsIMsgFolder} source - Its real physical source.
 * @returns {object|null} Captured native state, or null for the legacy backend.
 */
function nativeSavedSearchState(folder, source) {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    return null;
  }
  const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  );
  const connection = core.connectionForTests;
  Assert.ok(connection.connectionReady, "The native database is open");
  Assert.equal(
    source.server.getStringValue("storeContractID"),
    Services.prefs.getCharPref("mail.server.default.storeContractID"),
    "The fixture uses the declared physical store"
  );
  const database = folder.msgDatabase;
  const state = {
    connection,
    id: folder.id,
    uri: folder.URI,
    database,
    info: database.dBFolderInfo,
  };
  Assert.ok(
    nativeFolderFlags(connection, state.id) & Ci.nsMsgFolderFlags.Virtual,
    "The native row is a saved search before deletion"
  );
  Assert.greater(
    Array.from(source.msgDatabase.getCachedHits(state.uri) ?? []).length,
    0,
    "The real saved-search cache has hits before deletion"
  );
  return state;
}

/**
 * Checks that closing the old view cannot revive retired native metadata/cache.
 *
 * @param {object} state - Native handles captured before deletion.
 */
function assertNativeSavedSearchRetired(state) {
  Assert.equal(
    nativeFolderFlags(state.connection, state.id),
    null,
    "Deletion removed the original native folder row"
  );
  Assert.throws(
    () => state.database.folder,
    /NS_ERROR_NOT_AVAILABLE/,
    "The old database no longer resolves a live folder"
  );
  Assert.throws(
    () => state.info.setCharProperty("s371-deleted-folder", "late"),
    /NS_ERROR_NOT_AVAILABLE/,
    "A stale summary writer cannot re-create deleted metadata"
  );
  Assert.throws(
    () => state.database.getCachedHits(state.uri),
    error =>
      error.result == Cr.NS_ERROR_FAILURE ||
      error.result == Cr.NS_ERROR_NOT_AVAILABLE,
    "The retired database rejects cached-hit access after close or deletion"
  );
  Assert.equal(
    nativeFolderFlags(state.connection, state.id),
    null,
    "Rejected stale reads/writes did not resurrect the folder row"
  );
}

/**
 * Deleting a virtual folder that is displayed in a view wrapper must not
 * re-add its entry to the folder cache (bug 450059).
 */
add_task(async function test_deleted_virtual_folder_not_reflushed_to_cache() {
  const viewWrapper = make_view_wrapper();

  const [[folderOne]] = await messageInjection.makeFoldersWithSets(1, [{}]);
  const virtFolder = messageInjection.makeVirtualFolder([folderOne], {});
  await view_open(viewWrapper, virtFolder);
  Assert.ok(viewWrapper.isVirtual);

  const native = nativeSavedSearchState(virtFolder, folderOne);
  let cache, cacheKey;
  if (!native) {
    // For a non-server folder the folder cache key is the persistent descriptor
    // of its summary file.
    cache = MailServices.accounts.folderCache;
    cacheKey = virtFolder.summaryFile.persistentDescriptor;

    // The entry exists while the folder exists. getCacheElement throws
    // NS_ERROR_NOT_AVAILABLE when the key is not present.
    cache.getCacheElement(cacheKey, false);
  }

  const parent = virtFolder.parent;
  parent.propagateDelete(virtFolder, true);
  Assert.equal(virtFolder.parent, null, "deleted virtual folder has no parent");
  Assert.equal(
    viewWrapper.displayedFolder,
    null,
    "view wrapper should have closed on deletion"
  );
  Assert.ok(
    !viewWrapper.isFolderLoading(),
    "view wrapper should no longer be loading a folder"
  );

  if (native) {
    assertNativeSavedSearchRetired(native);
  } else {
    // The deletion must not have re-added the folder's entry to the folder
    // cache (the stale object would carry the Virtual flag).
    Assert.throws(
      () => cache.getCacheElement(cacheKey, false),
      /NS_ERROR_NOT_AVAILABLE/,
      "deleted folder should not be re-added to the folder cache"
    );
  }
});

/**
 * Recreating a folder with the same name after deleting a displayed virtual
 * folder must not inherit the Virtual flag (bug 450059).
 */
add_task(async function test_recreated_folder_does_not_inherit_virtual() {
  const viewWrapper = make_view_wrapper();

  const [[folderOne]] = await messageInjection.makeFoldersWithSets(1, [{}]);
  const virtFolder = messageInjection.makeVirtualFolder([folderOne], {});
  await view_open(viewWrapper, virtFolder);

  const native = nativeSavedSearchState(virtFolder, folderOne);
  const parent = virtFolder.parent;
  const name = virtFolder.name;
  parent.propagateDelete(virtFolder, true);
  if (native) {
    assertNativeSavedSearchRetired(native);
  }

  const recreated = parent.addSubfolder(name);
  Assert.notEqual(recreated, virtFolder, "recreated folder should be fresh");
  Assert.ok(
    !recreated.getFlag(Ci.nsMsgFolderFlags.Virtual),
    "recreated folder should not inherit the Virtual flag"
  );

  if (native) {
    Assert.notEqual(
      recreated.id,
      native.id,
      "The new native folder has a fresh ID"
    );
    Assert.equal(
      nativeFolderFlags(native.connection, recreated.id) &
        Ci.nsMsgFolderFlags.Virtual,
      0,
      "The recreated native row does not inherit saved-search metadata"
    );
    assertNativeSavedSearchRetired(native);
  }

  // Clean up the recreated folder.
  recreated.parent.propagateDelete(recreated, true);
});
