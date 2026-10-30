/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests the Thread and ThreadEnumerator classes, and the functions which
 * create them.
 */

const { ProfileCreator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ProfileCreator.sys.mjs"
);

add_setup(async function () {
  await installDB(`
    INSERT INTO folders (id, parent, name) VALUES
      (1, 0, 'server1'),
      (2, 1, 'folderA');

    INSERT INTO messages (id, folderId, threadId, threadParent, messageId, date) VALUES
      (1, 2, 1, 0, 'message1@invalid', UNIXEPOCH('2025-05-29') * 1000000),
      (2, 2, 2, 0, 'message2@invalid', UNIXEPOCH('2025-05-30') * 1000000),
      (3, 2, 1, 1, 'message3@invalid', UNIXEPOCH('2025-05-31') * 1000000),
      (4, 2, 1, 1, 'message4@invalid', UNIXEPOCH('2025-06-01') * 1000000),
      (5, 2, 1, 3, 'message5@invalid', UNIXEPOCH('2025-06-02') * 1000000);
  `);

  const profile = new ProfileCreator(do_get_profile());
  const server = profile.addLocalServer();
  await server.rootFolder.addMailFolder("folderA");

  MailServices.accounts.accounts;
});

add_task(async function testEnumerateThreads() {
  const localServer = MailServices.accounts.localFoldersServer;
  const rootFolder = localServer.rootFolder;
  const folderA = MailServices.folderLookup.getFolderForURL(
    rootFolder.URI + "/folderA"
  );

  const folderDatabase = database.openFolderDB(folderA, false);
  const threads = [...folderDatabase.enumerateThreads()];
  Assert.equal(threads.length, 2);

  {
    const t = threads[0];
    Assert.equal(t.threadKey, 1);
    Assert.equal(t.numChildren, 4);
    Assert.equal(t.getRootHdr().messageId, "message1@invalid");
    Assert.equal(t.newestMsgDate, new Date("2025-06-02").valueOf() / 1000);

    {
      Assert.equal(t.getChildKeyAt(0), 1);
      const m = t.getChildHdrAt(0);
      Assert.equal(m.messageId, "message1@invalid");
      Assert.equal(m.threadId, 1);
      Assert.equal(m.threadParent, 0);
    }

    {
      Assert.equal(t.getChildKeyAt(1), 3);
      const m = t.getChildHdrAt(1);
      Assert.equal(m.messageId, "message3@invalid");
      Assert.equal(m.threadId, 1);
      Assert.equal(m.threadParent, 1);
    }

    {
      Assert.equal(t.getChildKeyAt(2), 5);
      const m = t.getChildHdrAt(2);
      Assert.equal(m.messageId, "message5@invalid");
      Assert.equal(m.threadId, 1);
      Assert.equal(m.threadParent, 3);
    }

    {
      Assert.equal(t.getChildKeyAt(3), 4);
      const m = t.getChildHdrAt(3);
      Assert.equal(m.messageId, "message4@invalid");
      Assert.equal(m.threadId, 1);
      Assert.equal(m.threadParent, 1);
    }

    Assert.throws(() => t.getChildKeyAt(4), /NS_ERROR_UNEXPECTED/);
    Assert.throws(() => t.getChildHdrAt(4), /NS_ERROR_UNEXPECTED/);

    Assert.deepEqual(
      Array.from(t.enumerateMessages(1), m => m.messageId),
      ["message3@invalid", "message4@invalid"]
    );
    Assert.deepEqual(
      Array.from(t.enumerateMessages(3), m => m.messageId),
      ["message5@invalid"]
    );
    Assert.deepEqual(
      Array.from(t.enumerateMessages(5), m => m.messageId),
      []
    );
    Assert.deepEqual(
      Array.from(t.enumerateMessages(4), m => m.messageId),
      []
    );
  }

  {
    const t = threads[1];
    Assert.equal(t.threadKey, 2);
    Assert.equal(t.numChildren, 1);
    Assert.equal(t.getRootHdr().messageId, "message2@invalid");
    Assert.equal(t.newestMsgDate, new Date("2025-05-30").valueOf() / 1000);

    {
      Assert.equal(t.getChildKeyAt(0), 2);
      const m = t.getChildHdrAt(0);
      Assert.equal(m.messageId, "message2@invalid");
      Assert.equal(m.threadId, 2);
      Assert.equal(m.threadParent, 0);
    }

    Assert.throws(() => t.getChildKeyAt(1), /NS_ERROR_UNEXPECTED/);
    Assert.throws(() => t.getChildHdrAt(1), /NS_ERROR_UNEXPECTED/);

    Assert.deepEqual(
      Array.from(t.enumerateMessages(2), m => m.messageId),
      []
    );
  }
});

add_task(async function testGetThreadContainingMsgHdr() {
  const localServer = MailServices.accounts.localFoldersServer;
  const rootFolder = localServer.rootFolder;
  const folderA = MailServices.folderLookup.getFolderForURL(
    rootFolder.URI + "/folderA"
  );

  const folderDatabase = database.openFolderDB(folderA, false);
  const message = folderDatabase.getMsgHdrForKey(4);

  const thread = folderDatabase.getThreadContainingMsgHdr(message);

  Assert.equal(thread.threadKey, 1);
  Assert.equal(thread.numChildren, 4);
  Assert.equal(thread.getRootHdr().messageId, "message1@invalid");
  Assert.equal(thread.newestMsgDate, new Date("2025-06-02").valueOf() / 1000);
});

add_task(function test_retainedThreadDateTracksPublishedMembersAndReadErrors() {
  const folder = MailServices.accounts.localFoldersServer.rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("retained-thread-date");
  const db = folder.msgDatabase;
  const oldest = Date.UTC(2025, 1, 1) / 1000;
  const newer = Date.UTC(2025, 1, 2) / 1000;
  const newest = Date.UTC(2025, 1, 3) / 1000;
  const draft = db.createNewHdr();
  draft.messageId = "retained-date-root@thread.invalid";
  draft.date = oldest * 1000000;
  const head = db.attachHdr(draft, false);
  const thread = db.getThreadContainingMsgHdr(head);
  const preloaded = [...db.enumerateThreads()].find(
    item => item.threadKey == head.messageKey
  );
  Assert.ok(preloaded);
  Assert.equal(thread.newestMsgDate, oldest);
  Assert.equal(preloaded.newestMsgDate, oldest);
  const reply = db.createNewHdr();
  reply.messageId = "retained-date-reply@thread.invalid";
  reply.setReferences(`<${head.messageId}>`);
  reply.date = newer * 1000000;
  const child = db.attachHdr(reply, false);
  Assert.equal(child.threadId, head.messageKey);
  Assert.equal(child.threadParent, head.messageKey);
  Assert.equal(thread.numChildren, 2);
  Assert.equal(thread.newestMsgDate, newer);
  Assert.equal(preloaded.newestMsgDate, newer);
  child.date = newest * 1000000;
  Assert.equal(thread.newestMsgDate, newest);
  Assert.equal(preloaded.newestMsgDate, newest);
  db.deleteMessage(child.messageKey, null, true);
  Assert.equal(thread.newestMsgDate, oldest);
  Assert.equal(preloaded.newestMsgDate, oldest);
  Assert.equal(head.date, oldest * 1000000);
  const connection = database.connectionForTests;
  connection.beginTransaction();
  try {
    Assert.equal(thread.newestMsgDate, oldest);
    Assert.ok(connection.transactionInProgress);
  } finally {
    connection.rollbackTransaction();
  }
  connection.executeSimpleSQL(
    "ALTER TABLE messages RENAME TO unavailable_thread_dates"
  );
  try {
    for (const retained of [thread, preloaded]) {
      Assert.throws(
        () => retained.newestMsgDate,
        error => error.result === Cr.NS_ERROR_FAILURE
      );
    }
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_thread_dates RENAME TO messages"
    );
  }
  Assert.equal(thread.newestMsgDate, oldest);
  Assert.equal(preloaded.newestMsgDate, oldest);
  db.deleteMessage(head.messageKey, null, true);
  Assert.equal(thread.numChildren, 0);
  Assert.equal(
    thread.newestMsgDate,
    0,
    "The checked native empty-thread default is zero"
  );
  Assert.equal(preloaded.newestMsgDate, 0);
  Assert.deepEqual(db.listAllKeys(), []);
});
