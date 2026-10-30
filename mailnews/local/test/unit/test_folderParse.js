/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Tests to check local folder parsing.
 */

const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

/**
 * Sanity check for folder parsing.
 */
add_task(async function test_folderParse() {
  // Run the test for each store type.
  for (const storeKind of localAccountUtils.pluggableStores) {
    info(`Running test with ${storeKind}`);
    Services.prefs.setCharPref("mail.serverDefaultStoreContractID", storeKind);
    Services.prefs.setCharPref(
      "mail.server.default.storeContractID",
      storeKind
    );
    await doTestFolderParse(storeKind);
  }
});

/**
 * Rebuild a real store and retain every original message byte.
 *
 * @param {string} storeKind - Expected store contract.
 */
async function doTestFolderParse(storeKind) {
  const msgs = [
    // 0
    "To: bob@invalid\r\n" +
      "From: alice@invalid\r\n" +
      "Subject: Hello\r\n" +
      "\r\n" +
      "Hello, Bob! Haven't heard\r\n" +
      "From you in a while...\r\n", // Will be escaped/unescaped by mbox store.

    // 1
    "To: alice@invalid\r\n" +
      "From: bob@invalid\r\n" +
      "Subject: Re: Hello\r\n" +
      "\r\n" +
      "Hi there Alice! All good here.\r\n",
  ];

  localAccountUtils.loadLocalMailAccount();

  const inbox = localAccountUtils.inboxFolder;
  const storeType =
    storeKind == "@mozilla.org/msgstore/berkeleystore;1" ? "mbox" : "maildir";
  Assert.equal(inbox.msgStore.storeType, storeType);
  Assert.equal(inbox.server.msgStore.storeType, storeType);

  // Load messages into the msgStore (this will perform whatever escaping is
  // required).
  inbox.addMessageBatch(msgs);

  // Close and delete the db (.msf) file.
  inbox.msgDatabase.forceClosed();
  inbox.msgDatabase = null;
  await IOUtils.remove(inbox.summaryFile.path);

  // Force a folder parse to recreate the DB.
  const parseUrlListener = new PromiseTestUtils.PromiseUrlListener();
  try {
    inbox.getDatabaseWithReparse(parseUrlListener, null /* window */);
  } catch (ex) {
    Assert.equal(ex.result, Cr.NS_ERROR_NOT_INITIALIZED);
  }
  await parseUrlListener.promise;

  // Check all the messages are the right size.
  // Even if a message requires escaping in the msgStore, we should still see
  // the size of the original (unescaped) message here. Escaping should
  // be handled entirely within the msgStore.
  // We sort because we can't be sure the message order is preserved.
  const expectedSizes = msgs.map(m => m.length).sort();
  const gotSizes = Array.from(inbox.messages, m => m.messageSize).sort();
  Assert.deepEqual(expectedSizes, gotSizes);
  Assert.deepEqual(
    Array.from(inbox.messages, header =>
      mailTestUtils.loadMessageToString(inbox, header)
    ).sort(),
    msgs.toSorted(),
    "Repair preserves every original header and body byte"
  );

  // Clear up so we can run again on different store type.
  localAccountUtils.clearAll();
}

/**
 * A failed final summary write must reach the repair completion listener.
 */
add_task(async function test_folderParseSummaryFailure() {
  const { FeedbackService } = ChromeUtils.importESModule(
    "resource:///modules/FeedbackService.sys.mjs"
  );
  const preference = "mail.serverDefaultStoreContractID";
  const defaultPreference = "mail.server.default.storeContractID";
  const preferences = [preference, defaultPreference].map(name => ({
    name,
    present: Services.prefs.prefHasUserValue(name),
    value: Services.prefs.getCharPref(name, ""),
  }));
  const reportStatus = FeedbackService.prototype.reportStatus;
  let retained;
  let original;
  try {
    localAccountUtils.clearAll();
    for (const name of [preference, defaultPreference]) {
      Services.prefs.setCharPref(name, "@mozilla.org/msgstore/berkeleystore;1");
    }
    localAccountUtils.loadLocalMailAccount();
    const folder = localAccountUtils.inboxFolder;
    Assert.equal(folder.msgStore.storeType, "mbox");
    Assert.equal(folder.server.msgStore.storeType, "mbox");
    Assert.ok(!Services.prefs.getBoolPref("mail.panorama.enabled", false));
    original = folder.filePath.clone();
    const bytes = await IOUtils.read(original.path);
    Assert.equal(bytes.length, 0);
    Assert.deepEqual(folder.msgDatabase.listAllKeys(), []);
    folder.msgDatabase.forceClosed();
    folder.msgDatabase = null;
    await IOUtils.remove(folder.summaryFile.path);

    let faults = 0;
    FeedbackService.prototype.reportStatus = function (message, meteors) {
      reportStatus.call(this, message, meteors);
      if (meteors == "start-meteors" && !faults) {
        // The empty scan is queued but has no open input handle. Preserve its
        // actual body file elsewhere before the real final summary setter.
        retained = original.clone();
        retained.moveTo(null, original.leafName + ".retained");
        faults++;
      }
    };
    const statuses = [];
    const listener = new PromiseTestUtils.PromiseUrlListener({
      OnStopRunningUrl(url, status) {
        statuses.push(status);
      },
    });
    folder.parseFolder(null, listener);
    await Assert.rejects(
      listener.promise,
      error => Number(error.message) === Cr.NS_MSG_ERROR_FOLDER_MISSING
    );
    Assert.equal(faults, 1);
    Assert.deepEqual(statuses, [Cr.NS_MSG_ERROR_FOLDER_MISSING]);
    Assert.ok(!folder.locked);
    Assert.ok(!original.exists());
    Assert.ok(retained.exists());
    Assert.deepEqual(await IOUtils.read(retained.path), bytes);
    Assert.deepEqual(folder.msgDatabase.listAllKeys(), []);

    FeedbackService.prototype.reportStatus = reportStatus;
    retained.moveTo(null, original.leafName);
    retained = null;
    folder.msgDatabase.forceClosed();
    folder.msgDatabase = null;
    await IOUtils.remove(folder.summaryFile.path);
    const retry = new PromiseTestUtils.PromiseUrlListener();
    folder.parseFolder(null, retry);
    await retry.promise;
    Assert.ok(!folder.locked);
    Assert.ok(folder.msgDatabase.summaryValid);
    Assert.deepEqual(folder.msgDatabase.listAllKeys(), []);
    Assert.deepEqual(await IOUtils.read(original.path), bytes);
  } finally {
    FeedbackService.prototype.reportStatus = reportStatus;
    if (retained?.exists() && !original.exists()) {
      retained.moveTo(null, original.leafName);
    }
    localAccountUtils.clearAll();
    for (const { name, present, value } of preferences) {
      if (present) {
        Services.prefs.setCharPref(name, value);
      } else {
        Services.prefs.clearUserPref(name);
      }
    }
  }
});
