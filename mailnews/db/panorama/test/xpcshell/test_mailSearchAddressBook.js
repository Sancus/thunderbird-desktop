/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { MailSearchService } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchService.sys.mjs"
);

let folder, service;

add_setup(async function setupNativeAddressBookSearch() {
  do_get_profile();
  loadExistingDB();
  const pref = "mailnews.database.global.indexer.enabled";
  const hadPref = Services.prefs.prefHasUserValue(pref);
  const previous = Services.prefs.getBoolPref(pref, false);
  Services.prefs.setBoolPref(pref, true);
  registerCleanupFunction(() => {
    if (hadPref) {
      Services.prefs.setBoolPref(pref, previous);
    } else {
      Services.prefs.clearUserPref(pref);
    }
  });
  const account = MailServices.accounts.createLocalMailAccount();
  registerCleanupFunction(() => MailServices.accounts.removeAccount(account));
  folder = account.incomingServer.rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("live-card-names")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const file = do_get_profile().clone();
  file.append("live-card-search.sqlite");
  service = await MailSearchService.open(file, database.sourceId, messageDB);
  registerCleanupFunction(() => service.close());
});

/**
 * Stores one physical copy with a deliberately shared Message-ID.
 *
 * @param {nsIMsgLocalMailFolder} destination - Physical destination folder.
 * @param {string} subject - Literal subject.
 * @param {string} sender - Literal sender address.
 * @returns {nsIMsgDBHdr} The newly stored physical header.
 */
function addStoredMessage(destination, subject, sender) {
  return destination.addMessage(
    [
      "From: Sender <" + sender + ">",
      "To: Recipient <recipient@example.invalid>",
      "Date: Tue, 01 Jan 2019 00:00:00 +0000",
      "Message-ID: <shared@example.invalid>",
      "Subject: " + subject,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "nativebodyneedle",
      "",
    ].join("\r\n")
  );
}

add_task(async function test_cardNotificationsRefreshBothPhysicalCopies() {
  const other = folder
    .createLocalSubfolder("other-copy")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const book = MailServices.ab.getDirectory("jsaddrbook://abook.sqlite");
  const card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
    Ci.nsIAbCard
  );
  card.primaryEmail = "live-catalog@example.invalid";
  card.displayName = "InitialLiveCatalog";
  const added = book.addCard(card);
  let removed = false;
  registerCleanupFunction(() => {
    if (!removed) {
      book.deleteCards([added]);
    }
  });
  const headers = [
    addStoredMessage(folder, "livecardneedle", card.primaryEmail),
    addStoredMessage(other, "livecardneedle", card.primaryEmail),
  ];
  const ids = headers.map(header => String(header.messageKey)).sort();
  Assert.equal(headers[0].messageId, headers[1].messageId);
  let settled = Promise.withResolvers();
  const errors = [];
  service.onError = error => {
    errors.push(error);
    settled.reject(error);
  };
  service.onProgress = progress => {
    if (!progress.moreWork) {
      settled.resolve();
    }
  };
  service.start();
  await settled.promise;
  const states = headers.map(header =>
    messageDB.getSearchState(header.messageKey)
  );
  const before = await Promise.all(ids.map(id => service.getText(id)));
  Assert.ok(before.every(text => text.author.includes("InitialLiveCatalog")));

  settled = Promise.withResolvers();
  for (const name of ["IntermediateLiveCatalog", "FinalLiveCatalog"]) {
    added.displayName = name;
    book.modifyCard(added);
  }
  // Only the real card notifications can wake this completed background run.
  // Do not query or call update before its next completion.
  await settled.promise;
  const refreshed = await Promise.all(ids.map(id => service.getText(id)));
  for (let i = 0; i < ids.length; i++) {
    Assert.equal(refreshed[i].id, ids[i]);
    Assert.ok(refreshed[i].author.includes("FinalLiveCatalog"));
    Assert.ok(!refreshed[i].author.includes("InitialLiveCatalog"));
    Assert.notEqual(refreshed[i].textRevision, before[i].textRevision);
    Assert.equal(refreshed[i].body, "nativebodyneedle");
    Assert.equal(refreshed[i].bodyIndexed, true);
  }

  settled = Promise.withResolvers();
  book.deleteCards([added]);
  removed = true;
  await settled.promise;
  const deleted = await Promise.all(ids.map(id => service.getText(id)));
  for (let i = 0; i < ids.length; i++) {
    Assert.equal(deleted[i].author, "Sender <live-catalog@example.invalid>");
    Assert.notEqual(deleted[i].textRevision, refreshed[i].textRevision);
    Assert.equal(deleted[i].body, "nativebodyneedle");
    Assert.equal(deleted[i].bodyIndexed, true);
  }
  Assert.deepEqual((await service.search("InitialLiveCatalog")).items, []);
  Assert.deepEqual((await service.search("IntermediateLiveCatalog")).items, []);
  Assert.deepEqual((await service.search("FinalLiveCatalog")).items, []);
  Assert.deepEqual(
    (await service.search("livecardneedle")).items.map(hit => hit.id).sort(),
    ids
  );
  for (let i = 0; i < headers.length; i++) {
    const current = messageDB.getSearchState(headers[i].messageKey);
    Assert.equal(current.generation, states[i].generation);
    Assert.equal(current.policyRevision, states[i].policyRevision);
    Assert.equal(current.folderId, headers[i].folder.id);
  }
  Assert.deepEqual(errors, []);
  await service.close();
});
