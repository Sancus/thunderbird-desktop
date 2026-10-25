/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

const { ProfileCreator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ProfileCreator.sys.mjs"
);

add_task(async function test_remapsThreadRootsAndParents() {
  const profile = new ProfileCreator(do_get_profile());
  const server = profile.addLocalServer();
  const files = await server.rootFolder.addMailFolder("threads", {
    summary: do_get_file("data/migration.msf"),
    mbox: do_get_file("data/migration"),
  });
  await server.rootFolder.addMailFolder("existing");
  const summaryFile = Cc["@mozilla.org/file/local;1"].createInstance(
    Ci.nsIFile
  );
  summaryFile.initWithPath(files.summaryFilePath);
  const legacy = Cc["@mozilla.org/nsMsgDatabase/msgDB-mailbox"].createInstance(
    Ci.nsIMsgDatabase
  );
  registerCleanupFunction(() => legacy.close(false));
  legacy.openFromFile(summaryFile);

  // Build actual legacy threads through attachment, not by editing thread IDs.
  for (const [id, references] of [
    ["delivery-migration-reply@invalid", "<162378@invalid>"],
    [
      "delivery-migration-grandchild@invalid",
      "<162378@invalid> <delivery-migration-reply@invalid>",
    ],
  ]) {
    const message = [
      "From - Tue Jan 01 00:00:00 2030",
      "From: Delivery <delivery@invalid>",
      "To: Recipient <recipient@invalid>",
      "Subject: Migration reply",
      "Message-ID: <" + id + ">",
      "References: " + references,
      "Date: Tue, 01 Jan 2030 00:00:00 +0000",
      "",
      "Migration thread fixture.",
      "",
    ].join("\r\n");
    const offset = (await IOUtils.stat(files.mailFilePath)).size;
    await IOUtils.writeUTF8(files.mailFilePath, message, { mode: "append" });
    const detached = legacy.createNewHdr();
    detached.messageId = id;
    detached.author = "Delivery <delivery@invalid>";
    detached.recipients = "Recipient <recipient@invalid>";
    detached.subject = "Migration reply";
    detached.date = new Date("2030-01-01T00:00:00Z").valueOf() * 1000;
    detached.flags = 0;
    detached.storeToken = String(offset);
    detached.messageSize = new TextEncoder().encode(message).length;
    detached.setReferences(references);
    legacy.attachHdr(detached, false);
  }
  legacy.forceClosed();

  const reader = Cc["@mozilla.org/nsMsgDatabase/msgDB-mailbox"].createInstance(
    Ci.nsIMsgDatabase
  );
  registerCleanupFunction(() => reader.close(false));
  reader.openFromFile(summaryFile);
  const sourceRoot = reader.getMsgHdrForMessageID("162378@invalid");
  const sourceReply = reader.getMsgHdrForMessageID(
    "delivery-migration-reply@invalid"
  );
  const sourceGrandchild = reader.getMsgHdrForMessageID(
    "delivery-migration-grandchild@invalid"
  );
  Assert.equal([...reader.enumerateMessages()].length, 4);
  Assert.equal(sourceReply.threadParent, sourceRoot.messageKey);
  Assert.equal(sourceGrandchild.threadParent, sourceReply.messageKey);
  Assert.equal(sourceReply.threadId, sourceRoot.threadId);
  Assert.equal(sourceGrandchild.threadId, sourceRoot.threadId);
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
  const existing = rootFolder.getChildNamed("existing");
  PanoramaDelivery.assertFolder(existing, lane);
  // Existing messages guard against key collisions during migration.
  addMessage({ folderId: existing.id, messageId: "existing-one@invalid" });
  addMessage({ folderId: existing.id, messageId: "existing-two@invalid" });
  const existingBefore = Array.from(existing.messages, message => [
    message.messageId,
    message.messageKey,
  ]).toSorted((a, b) => a[0].localeCompare(b[0]));
  const folder = rootFolder.getChildNamed("threads");
  PanoramaDelivery.assertFolder(folder, lane);
  Assert.equal(folder.getTotalMessages(false), 0);
  await database.migrateFolderDatabase(folder);
  Assert.equal([...folder.messages].length, 4);
  const existingAfter = Array.from(existing.messages, message => [
    message.messageId,
    message.messageKey,
  ]).toSorted((a, b) => a[0].localeCompare(b[0]));
  Assert.deepEqual(
    existingAfter,
    existingBefore,
    "Existing messages keep their keys"
  );
  const destinationKeys = [
    ...Array.from(folder.messages, message => message.messageKey),
    ...existingAfter.map(([, key]) => key),
  ];
  Assert.equal(destinationKeys.length, 6);
  Assert.equal(
    new Set(destinationKeys).size,
    6,
    "All destination keys are distinct"
  );
  Assert.ok(
    destinationKeys.every(key => key != 0),
    "All destination keys are nonzero"
  );
  const db = folder.msgDatabase;
  const root = db.getMsgHdrForMessageID("162378@invalid");
  const reply = db.getMsgHdrForMessageID("delivery-migration-reply@invalid");
  const grandchild = db.getMsgHdrForMessageID(
    "delivery-migration-grandchild@invalid"
  );
  Assert.ok(root);
  Assert.ok(reply);
  Assert.ok(grandchild);
  const other = db.getMsgHdrForMessageID("345692@invalid");
  Assert.ok(other);
  Assert.notEqual(root.threadId, 0, "The migrated thread has an identity");
  Assert.notEqual(other.threadId, 0);
  Assert.notEqual(
    other.threadId,
    root.threadId,
    "The other thread is distinct"
  );
  for (const message of [root, reply, grandchild]) {
    Assert.equal(
      message.threadId,
      root.threadId,
      "Root, reply, and grandchild share one thread identity"
    );
  }
  Assert.equal(root.threadParent, 0, "The root has no parent in Panorama");
  Assert.equal(reply.threadParent, root.messageKey);
  Assert.equal(grandchild.threadParent, reply.messageKey);
  Assert.equal(
    [...db.enumerateThreads()].length,
    2,
    "Unrelated threads stay apart"
  );
  for (const message of [root, reply, grandchild]) {
    const thread = db.getThreadContainingMsgHdr(message);
    Assert.equal(thread.numChildren, 3);
    Assert.equal(thread.getRootHdr().messageId, "162378@invalid");
  }
  const otherThread = db.getThreadContainingMsgHdr(other);
  Assert.equal(otherThread.numChildren, 1);
  Assert.equal(otherThread.getRootHdr().messageId, "345692@invalid");
  Assert.equal(other.threadParent, 0);

  const statement = database.connectionForTests.createStatement(
    "SELECT m.messageId, m.threadId, p.messageId AS parent " +
      "FROM messages m LEFT JOIN messages p ON p.id = m.threadParent " +
      "WHERE m.folderId = :folderId ORDER BY m.messageId"
  );
  const rows = [];
  try {
    statement.params.folderId = folder.id;
    while (statement.executeStep()) {
      rows.push([
        statement.row.messageId,
        statement.row.threadId,
        statement.row.parent,
      ]);
    }
  } finally {
    statement.finalize();
  }
  Assert.deepEqual(
    rows.map(([id, , parent]) => [id, parent]),
    [
      ["162378@invalid", null],
      ["345692@invalid", null],
      [
        "delivery-migration-grandchild@invalid",
        "delivery-migration-reply@invalid",
      ],
      ["delivery-migration-reply@invalid", "162378@invalid"],
    ],
    "Stored parent edges identify the correct messages"
  );
  Assert.deepEqual(
    rows.map(([, threadId]) => threadId),
    [root.threadId, other.threadId, root.threadId, root.threadId],
    "Stored thread membership agrees with the public headers"
  );
  Assert.deepEqual(
    Array.from(existing.messages, message => message.messageId).toSorted(),
    ["existing-one@invalid", "existing-two@invalid"],
    "Migration preserves messages already in Panorama"
  );
  Assert.deepEqual(
    await IOUtils.read(files.mailFilePath),
    originalMbox,
    "Thread migration preserves the mbox bytes"
  );
});
