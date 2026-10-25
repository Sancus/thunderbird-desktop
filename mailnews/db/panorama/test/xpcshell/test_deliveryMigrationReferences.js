/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

// Exercise References independently of thread remapping and custom properties.
const { ProfileCreator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ProfileCreator.sys.mjs"
);

add_task(async function test_preservesOrderedReferences() {
  const profile = new ProfileCreator(do_get_profile());
  const server = profile.addLocalServer();
  const files = await server.rootFolder.addMailFolder("references", {
    summary: do_get_file("data/migration.msf"),
    mbox: do_get_file("data/migration"),
  });
  const summaryFile = Cc["@mozilla.org/file/local;1"].createInstance(
    Ci.nsIFile
  );
  summaryFile.initWithPath(files.summaryFilePath);
  const legacy = Cc["@mozilla.org/nsMsgDatabase/msgDB-mailbox"].createInstance(
    Ci.nsIMsgDatabase
  );
  registerCleanupFunction(() => legacy.close(false));
  legacy.openFromFile(summaryFile);
  const original = legacy.getMsgHdrForMessageID("345692@invalid");
  // All ancestors are outside this folder, so its existing root is still valid.
  original.setReferences(
    "<ancestor@invalid>\r\n\t<parent@invalid> <nearest@invalid>"
  );
  legacy.forceClosed();

  const reader = Cc["@mozilla.org/nsMsgDatabase/msgDB-mailbox"].createInstance(
    Ci.nsIMsgDatabase
  );
  registerCleanupFunction(() => reader.close(false));
  reader.openFromFile(summaryFile);
  const saved = reader.getMsgHdrForMessageID("345692@invalid");
  Assert.equal(
    saved.numReferences,
    3,
    "The legacy fixture has three ancestors"
  );
  Assert.deepEqual(
    Array.from({ length: saved.numReferences }, (_, i) =>
      saved.getStringReference(i)
    ),
    ["ancestor@invalid", "parent@invalid", "nearest@invalid"],
    "The legacy engine persisted the References in header order"
  );
  Assert.equal(reader.getMsgHdrForMessageID("162378@invalid").numReferences, 0);
  reader.forceClosed();
  const originalMbox = await IOUtils.read(files.mailFilePath);

  loadExistingDB();
  MailServices.accounts.accounts;
  const lane = PanoramaDelivery.expectedLane();
  Assert.deepEqual(lane, { backend: "panorama", store: "mbox" });
  const selectedDatabase = PanoramaDelivery.assertBackend(
    lane.backend
  ).QueryInterface(Ci.nsIDatabaseCore);
  Assert.equal(
    selectedDatabase,
    database,
    "The selected message database service is Panorama"
  );
  const rootFolder = MailServices.accounts.localFoldersServer.rootFolder;
  const folder = rootFolder.getChildNamed("references");
  PanoramaDelivery.assertFolder(folder, lane);
  Assert.equal(folder.getTotalMessages(false), 0);
  await database.migrateFolderDatabase(folder);
  Assert.equal([...folder.messages].length, 2);

  const migrated = folder.msgDatabase.getMsgHdrForMessageID("345692@invalid");
  Assert.ok(migrated, "The message with References is present in Panorama");
  Assert.equal(migrated.numReferences, 3, "All References survive migration");
  Assert.deepEqual(
    Array.from({ length: migrated.numReferences }, (_, i) =>
      migrated.getStringReference(i)
    ),
    ["ancestor@invalid", "parent@invalid", "nearest@invalid"],
    "Migration preserves every ancestor in header order"
  );
  const noReferences =
    folder.msgDatabase.getMsgHdrForMessageID("162378@invalid");
  Assert.ok(noReferences);
  Assert.equal(noReferences.numReferences, 0, "No References are invented");
  Assert.deepEqual(
    await IOUtils.read(files.mailFilePath),
    originalMbox,
    "Summary migration preserves the mbox bytes"
  );
});
