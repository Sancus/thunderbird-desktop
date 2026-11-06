/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {
  checkSearchWriterAdmission,
  drainSearchMigrationWriters,
  releaseSearchMigrationWriters,
} = ChromeUtils.importESModule(
  "resource:///modules/panorama/SearchMigrationHold.sys.mjs"
);

/**
 * Returns the actual native process gate without creating a selected lease.
 *
 * @returns {nsIObserver} Native fixed-domain admission service.
 */
function writerGate() {
  return Cc["@mozilla.org/mailnews/migration-writer-lease;1"].getService(
    Ci.nsIObserver
  );
}

add_task(function test_coldSearchImportsDoNotStartChatOrSearchWriters() {
  const bag = writerGate().QueryInterface(Ci.nsIPropertyBag2);
  for (const domain of ["mail-search", "chat-search", "chat"]) {
    Assert.equal(bag.getPropertyAsUint32("writer-history." + domain), 0);
  }
  ChromeUtils.importESModule("resource:///modules/panorama/MailSearch.sys.mjs");
  ChromeUtils.importESModule(
    "resource:///modules/panorama/ChatSearchService.sys.mjs"
  );
  ChromeUtils.importESModule(
    "resource:///modules/panorama/ChatSearchProvider.sys.mjs"
  );
  for (const domain of ["mail-search", "chat-search", "chat"]) {
    Assert.equal(
      bag.getPropertyAsUint32("writer-history." + domain),
      0,
      "Cold search imports cannot start the native domain or logger"
    );
  }
});

add_task(function test_exactAdmissionUsesStickyNativeHistory() {
  const gate = writerGate();
  const bag = gate.QueryInterface(Ci.nsIPropertyBag2);
  const subject = bag.getPropertyAsInterface(
    "writer-admission-subject",
    Ci.nsISupports
  );
  Assert.throws(
    () => checkSearchWriterAdmission("Mail-Search"),
    error => error.result === Cr.NS_ERROR_INVALID_ARG
  );
  for (const domain of ["mail-search", "chat-search"]) {
    gate.observe(subject, "check-writer-never-started", domain);
    Assert.equal(checkSearchWriterAdmission(domain), undefined);
    Assert.equal(bag.getPropertyAsUint32("writer-history." + domain), 1);
    Assert.throws(
      () => gate.observe(subject, "check-writer-never-started", domain),
      error => error.result === Cr.NS_ERROR_NOT_AVAILABLE,
      "An allowed attempt irreversibly records native Started history"
    );
  }
});

add_task(function test_processSubjectCannotGrantSelectedOwnership() {
  const gate = writerGate();
  const subject = gate
    .QueryInterface(Ci.nsIPropertyBag2)
    .getPropertyAsInterface("writer-admission-subject", Ci.nsISupports);
  Assert.throws(
    () => gate.observe(subject, "validate-selected-view", "after-await"),
    error => error.result === Cr.NS_ERROR_NOT_AVAILABLE,
    "The actual process subject is not a selected snapshot view"
  );
  Assert.throws(
    () => gate.observe(subject, "release", "mail-search"),
    error => error.result === Cr.NS_ERROR_INVALID_ARG,
    "Script cannot complete a domain or release the native lease"
  );
});

/**
 * Opens a real sidecar with the normal native database fixture. These ordinary
 * tests never arm a lease or substitute the process subject for selected Held.
 * The positive selected-XRE cases belong to the same-whole native fixture.
 *
 * @param {string} name - Unique actual sidecar filename.
 * @returns {Promise<MailSearchService>} Real service with normal close cleanup.
 */
async function nativeSearchFixture(name) {
  do_get_profile();
  loadExistingDB();
  const { MailSearchService } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearchService.sys.mjs"
  );
  const file = do_get_profile().clone();
  file.append(name + ".sqlite");
  const service = await MailSearchService.open(
    file,
    database.sourceId,
    messageDB
  );
  registerCleanupFunction(() => service.close());
  return service;
}

add_task(async function test_processSubjectCannotDrainAnActualSearchWriter() {
  const service = await nativeSearchFixture("migration-foreign-subject");
  const subject = writerGate()
    .QueryInterface(Ci.nsIPropertyBag2)
    .getPropertyAsInterface("writer-admission-subject", Ci.nsISupports);
  try {
    await Assert.rejects(
      drainSearchMigrationWriters(subject),
      error => error.result === Cr.NS_ERROR_NOT_AVAILABLE,
      "A real process subject cannot acquire or detach a selected writer"
    );
    await Assert.rejects(
      releaseSearchMigrationWriters(subject, Cr.NS_OK),
      error => error.result === Cr.NS_ERROR_INVALID_ARG,
      "An unowned subject cannot release a selected generation"
    );
    Assert.ok(
      !service.closed,
      "Refused acquisition leaves the real writer owned"
    );
    const progress = await service.update({ limit: 1 });
    Assert.equal(progress.sourceId, database.sourceId);
  } finally {
    await service.close();
  }
});

add_task(async function test_realSidecarCloseJoinsDeliveryAndIsIdempotent() {
  const service = await nativeSearchFixture("migration-close-terminal");
  let readSettled = false;
  const read = service.getRecoveryRecords().finally(() => {
    readSettled = true;
  });
  const readResult = Promise.allSettled([read]);
  const first = service.close();
  Assert.equal(
    service.close(),
    first,
    "Repeated close retains its actual terminal promise"
  );
  await first;
  Assert.ok(
    readSettled,
    "Storage close cannot acknowledge an unsettled registered read"
  );
  await readResult;
  Assert.ok(service.closed, "Closed means actual sidecar close succeeded");
  Assert.equal(
    writerGate()
      .QueryInterface(Ci.nsIPropertyBag2)
      .getPropertyAsUint32("writer-history.mail-search"),
    1,
    "Normal close cannot reset native writer history"
  );
});

add_task(
  async function test_cancelledOperationRetainsItsOriginalFailureAfterClose() {
    const service = await nativeSearchFixture("migration-cancel-error");
    const reason = new Error("Original search update cancellation");
    const controller = new AbortController();
    controller.abort(reason);
    await Assert.rejects(
      service.update({ limit: 1, signal: controller.signal }),
      error => error === reason
    );
    await service.close();
    Assert.ok(service.closed, "Actual storage cleanup still completes");
    Assert.equal(
      service.migrationFailures[0],
      reason,
      "Successful cleanup never normalizes the original operation rejection"
    );
  }
);

add_task(
  async function test_failedNativeOpenPreservesItsOriginalStorageError() {
    const { MailSearchService } = ChromeUtils.importESModule(
      "resource:///modules/panorama/MailSearchService.sys.mjs"
    );
    const parent = PathUtils.join(
      do_get_profile().path,
      "migration-regular-file-parent"
    );
    const bytes = "Retained source: this is a file, never a sidecar directory.";
    await IOUtils.writeUTF8(parent, bytes);
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(PathUtils.join(parent, "cannot-open.sqlite"));
    await Assert.rejects(
      MailSearchService.open(file, database.sourceId, messageDB),
      error =>
        typeof error.result === "number" &&
        !Components.isSuccessCode(error.result),
      "The real storage-open exception survives failed-open cleanup without a wrapper"
    );
    Assert.equal(
      await IOUtils.readUTF8(parent),
      bytes,
      "Failed open and cleanup preserve the genuine original file bytes"
    );
  }
);
