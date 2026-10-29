/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { openMailSearchResult, resolveMailSearchResult } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/SearchResultOpener.sys.mjs"
  );
const { MailUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailUtils.sys.mjs"
);

let first, second, locations, opened;
const INDEXER_PREF = "mailnews.database.global.indexer.enabled";

add_setup(function setupResultOpening() {
  do_get_profile();
  loadExistingDB();
  const hadPref = Services.prefs.prefHasUserValue(INDEXER_PREF);
  const oldPref = Services.prefs.getBoolPref(INDEXER_PREF, false);
  Services.prefs.setBoolPref(INDEXER_PREF, true);
  const displayMessage = MailUtils.displayMessage;
  opened = [];
  MailUtils.displayMessage = (...args) => opened.push(args);
  registerCleanupFunction(() => {
    MailUtils.displayMessage = displayMessage;
    if (hadPref) {
      Services.prefs.setBoolPref(INDEXER_PREF, oldPref);
    } else {
      Services.prefs.clearUserPref(INDEXER_PREF);
    }
  });
  const account = MailServices.accounts.createLocalMailAccount();
  const root = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const raw = [
    "From: Sender <sender@example.invalid>",
    "To: Recipient <recipient@example.invalid>",
    "Date: Tue, 01 Jan 2019 00:00:00 +0000",
    "Message-ID: <same-id@example.invalid>",
    "Subject: Two physical copies",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Same content in separate folders.",
    "",
  ].join("\r\n");
  first = root
    .createLocalSubfolder("first-copy")
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .addMessage(raw);
  second = root
    .createLocalSubfolder("second-copy")
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .addMessage(raw);
  locations = new Map([
    ["physical-first", location(first)],
    ["physical-second", location(second)],
  ]);
});

/**
 * Constructs a location fixture from a real physical header.
 *
 * @param {nsIMsgDBHdr} header - Independently added message.
 * @returns {object} Current-location fixture.
 */
function location(header) {
  return {
    eligible: true,
    location: { folderId: header.folder.id, messageKey: header.messageKey },
    folder: header.folder,
    originalContentAvailable: true,
    canOpen: true,
  };
}

add_task(async function test_selectedPhysicalCopyAndReaderArguments() {
  opened.length = 0;
  Assert.equal(first.messageId, second.messageId, "Message-ID is not unique");
  const ids = [];
  const viewWrapper = {};
  const tabmail = {};
  const result = await openMailSearchResult(
    "physical-second",
    id => {
      ids.push(id);
      return locations.get(id) || null;
    },
    { viewWrapper, tabmail }
  );
  Assert.deepEqual(ids, ["physical-second"]);
  Assert.equal(result.status, "ready");
  Assert.equal(result.header.messageKey, second.messageKey);
  Assert.equal(result.header.folder, second.folder);
  Assert.deepEqual(opened, [[result.header, viewWrapper, tabmail]]);
  Assert.notEqual(
    result.header.folder,
    first.folder,
    "The other copy was not opened"
  );
});

add_task(async function test_currentPolicyAndUnavailableOriginal() {
  opened.length = 0;
  const state = locations.get("physical-first");
  state.canOpen = false;
  state.originalContentAvailable = false;
  let result = await openMailSearchResult("physical-first", id =>
    locations.get(id)
  );
  Assert.equal(result.status, "unavailable");
  Assert.equal(result.originalContentAvailable, false);
  Assert.equal(
    opened.length,
    0,
    "Unavailable content did not invoke the reader"
  );
  state.canOpen = true;
  result = await resolveMailSearchResult("physical-first", id =>
    locations.get(id)
  );
  Assert.equal(
    result.status,
    "ready",
    "An online-capable open is independent of local text"
  );
  Assert.equal(result.originalContentAvailable, false);

  first.setStringProperty(
    "junkscore",
    Ci.nsIJunkMailPlugin.IS_SPAM_SCORE.toString()
  );
  result = await openMailSearchResult("physical-first", id =>
    locations.get(id)
  );
  Assert.equal(
    result.status,
    "ineligible",
    "Current junk policy defeats stale eligibility"
  );
  first.setStringProperty("junkscore", "");
  Services.prefs.setBoolPref(INDEXER_PREF, false);
  Assert.equal(
    (await openMailSearchResult("physical-first", id => locations.get(id)))
      .status,
    "ineligible"
  );
  Services.prefs.setBoolPref(INDEXER_PREF, true);
  Assert.equal(opened.length, 0);
});

add_task(async function test_wrongFolderAndDeletedRowDoNotOpen() {
  opened.length = 0;
  const state = locations.get("physical-first");
  const originalFolderId = state.location.folderId;
  state.location.folderId = second.folder.id;
  Assert.equal(
    (await openMailSearchResult("physical-first", id => locations.get(id)))
      .status,
    "unavailable"
  );
  state.location.folderId = originalFolderId;
  messageDB.removeMessage(first.messageKey);
  Assert.equal(
    (await openMailSearchResult("physical-first", id => locations.get(id)))
      .status,
    "unavailable",
    "A stale location does not make a deleted header live"
  );
  locations.delete("physical-first");
  Assert.equal(
    (await openMailSearchResult("physical-first", id => locations.get(id)))
      .status,
    "deleted"
  );
  Assert.equal(opened.length, 0);
  Assert.equal(
    (await resolveMailSearchResult("physical-second", id => locations.get(id)))
      .status,
    "ready",
    "Deleting one copy preserves the other copy"
  );
});

add_task(async function test_cancellationAndErrorsPreventOpening() {
  opened.length = 0;
  const controller = new AbortController();
  const reason = new Error("Cancel opening");
  await Assert.rejects(
    openMailSearchResult(
      "physical-second",
      () => {
        controller.abort(reason);
        return locations.get("physical-second");
      },
      { signal: controller.signal }
    ),
    error => error === reason
  );
  const failure = new Error("Location lookup failed");
  await Assert.rejects(
    openMailSearchResult("physical-second", () => {
      throw failure;
    }),
    error => error === failure
  );
  Assert.equal(opened.length, 0);
});
