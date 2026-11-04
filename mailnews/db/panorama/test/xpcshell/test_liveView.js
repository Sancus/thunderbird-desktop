/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests live views are initialised correctly and find the right messages.
 */

const { VirtualFolderHelper } = ChromeUtils.importESModule(
  "resource:///modules/VirtualFolderWrapper.sys.mjs"
);

const { ProfileCreator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ProfileCreator.sys.mjs"
);

const LiveView = Components.Constructor(
  "@mozilla.org/mailnews/live-view;1",
  "nsILiveView"
);

add_setup(async function () {
  const profile = new ProfileCreator(do_get_profile());
  const server = profile.addLocalServer();
  await server.rootFolder.addMailFolder("folderA");
  await server.rootFolder.addMailFolder("folderB");
  await server.rootFolder.addMailFolder("folderC");
  await installDBFromFile("db/messages.sql");
});

add_task(async function testMessageProperties() {
  const liveView = new LiveView();

  const [message] = await liveView.selectMessages();
  Assert.equal(message.id, 8);
  Assert.equal(message.folderId, 4);
  Assert.equal(message.messageId, "message8@invalid");
  Assert.equal(message.date.toISOString(), "2023-08-06T06:02:00.000Z");
  // FIXME: Address formatting is temporarily disabled.
  // Assert.equal(message.sender, "Edgár Stokes <edgar@stokes.invalid>");
  Assert.equal(message.subject, "Balanced static project déjà vu");
  Assert.equal(message.flags, 0);
  Assert.equal(message.tags, "$label1");
  Assert.equal(message.threadId, 0);
  Assert.equal(message.threadParent, 0);
}).skip(); // This is broken until we can select a specific message again.

add_task(async function testInitWithFolder() {
  const folderA = folderDB.getFolderByPath("server1/folderA");

  const liveView = new LiveView();
  Assert.throws(
    () => liveView.initWithFolder(0),
    // NOTE (BenC): LiveView::InitWithFolder(0) returns NS_ERROR_INVALID_ARG,
    // but for some reason it shows up here as NS_ERROR_UNEXPECTED.
    // I'm baffled.
    /NS_ERROR_/,
    "setting with 0 folder should throw"
  );

  liveView.initWithFolder(folderA);
  assertInitFails(liveView);

  Assert.equal(
    await liveView.countMessages(),
    4,
    "countMessages should return the total number of messages"
  );
  Assert.equal(
    await liveView.countUnreadMessages(),
    3,
    "countUnreadMessages should return the number of unread messages"
  );
  Assert.deepEqual(
    Array.from(await liveView.selectMessages(), m => m.id),
    [4, 3, 2, 1],
    "selectMessages with no arguments should return all the messages"
  );

  assertInitFails(liveView);
});

add_task(async function testInitWithFolders() {
  const folderA = folderDB.getFolderByPath("server1/folderA");
  const folderB = folderDB.getFolderByPath("server1/folderB");
  const folderC = folderDB.getFolderByPath("server1/folderC");

  const liveView = new LiveView();
  Assert.throws(
    () => liveView.initWithFolders([0, folderA]),
    /NS_ERROR_/,
    "initWithFolders should fail if there are any null folderIds"
  );
  Assert.throws(
    () => liveView.initWithFolders([]),
    /NS_ERROR_/,
    "initWithFolders should fail with an empty list"
  );

  liveView.initWithFolders([folderA, folderB, folderC]);
  assertInitFails(liveView);

  Assert.equal(
    await liveView.countMessages(),
    10,
    "countMessages should return the total number of messages"
  );
  Assert.equal(
    await liveView.countUnreadMessages(),
    6,
    "countUnreadMessages should return the number of unread messages"
  );
  Assert.deepEqual(
    Array.from(await liveView.selectMessages(), m => m.id),
    [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    "selectMessages with no arguments should return all the messages"
  );

  assertInitFails(liveView);
});

add_task(async function testInitWithVirtualFolder() {
  const folderA = folderDB.getFolderByPath("server1/folderA");
  const folderC = folderDB.getFolderByPath("server1/folderC");

  MailServices.accounts.accounts;
  const wrapper = VirtualFolderHelper.createNewVirtualFolder(
    "virtual",
    MailServices.accounts.localFoldersServer.rootFolder,
    [
      folderDB.getMsgFolderForFolder(folderA),
      folderDB.getMsgFolderForFolder(folderC),
    ],
    "AND (subject,contains,ing)",
    false
  );

  const virtualFolder = folderDB.getFolderByPath("server1/virtual");

  let liveView = new LiveView();
  liveView.initWithFolder(virtualFolder);
  assertInitFails(liveView);

  Assert.equal(
    await liveView.countMessages(),
    2,
    "countMessages should return the total number of messages"
  );
  Assert.equal(
    await liveView.countUnreadMessages(),
    1,
    "countUnreadMessages should return the number of unread messages"
  );
  Assert.deepEqual(
    Array.from(await liveView.selectMessages(), m => m.id),
    [6, 1],
    "selectMessages with no arguments should return all the messages"
  );

  assertInitFails(liveView);

  wrapper.searchString = "AND (date,is before,10-May-2023)";
  // TODO: We shouldn't need this. Updating the wrapper should cause the live
  // view to refresh itself.
  liveView = new LiveView();
  liveView.initWithFolder(virtualFolder);

  Assert.deepEqual(
    Array.from(await liveView.selectMessages(), m => m.id),
    [5, 4, 3, 2, 1],
    "selectMessages with no arguments should return all the messages"
  );

  wrapper.searchString =
    "AND (date,is after,1-Jan-2020) AND (date,is before,10-May-2023)";
  liveView = new LiveView();
  liveView.initWithFolder(virtualFolder);

  Assert.deepEqual(
    Array.from(await liveView.selectMessages(), m => m.id),
    [5],
    "selectMessages with no arguments should return all the messages"
  );

  wrapper.searchString =
    "AND (date,is before,01-Jan-2020) OR (date,is after,10-May-2023)";
  liveView = new LiveView();
  liveView.initWithFolder(virtualFolder);

  Assert.deepEqual(
    Array.from(await liveView.selectMessages(), m => m.id),
    [10, 9, 8, 7, 6, 4, 3, 2, 1],
    "selectMessages with no arguments should return all the messages"
  );
});

add_task(async function testInitWithTag() {
  const liveView = new LiveView();
  liveView.initWithTag("$label1");
  assertInitFails(liveView);

  Assert.equal(
    await liveView.countMessages(),
    3,
    "countMessages should return the total number of messages"
  );
  Assert.equal(
    await liveView.countUnreadMessages(),
    2,
    "countUnreadMessages should return the number of unread messages"
  );
  Assert.deepEqual(
    Array.from(await liveView.selectMessages(), m => m.id),
    [8, 3, 2],
    "selectMessages with no arguments should return all the messages"
  );

  assertInitFails(liveView);
});

add_task(async function testInitWithUnreadMessages() {
  const liveView = new LiveView();
  liveView.initWithUnreadMessages();

  Assert.equal(
    await liveView.countMessages(),
    6,
    "countMessages should return the total number of messages"
  );
  Assert.equal(
    await liveView.countUnreadMessages(),
    6,
    "countUnreadMessages should return the number of unread messages"
  );
  Assert.deepEqual(
    Array.from(await liveView.selectMessages(), m => m.id),
    [9, 8, 7, 4, 2, 1],
    "selectMessages with no arguments should return all the messages"
  );
});

add_task(async function testInitWithFlaggedMessages() {
  const liveView = new LiveView();
  liveView.initWithFlaggedMessages();

  Assert.equal(
    await liveView.countMessages(),
    3,
    "countMessages should return the total number of messages"
  );
  Assert.equal(
    await liveView.countUnreadMessages(),
    1,
    "countUnreadMessages should return the number of unread messages"
  );
  Assert.deepEqual(
    Array.from(await liveView.selectMessages(), m => m.id),
    [10, 4, 3],
    "selectMessages with no arguments should return all the messages"
  );
});

add_task(async function testInitWithDateRange() {
  let liveView = new LiveView();
  liveView.initWithDateRange(0, Date.now() * 1000);

  Assert.equal(
    await liveView.countMessages(),
    10,
    "countMessages should return the total number of messages"
  );
  Assert.equal(
    await liveView.countUnreadMessages(),
    6,
    "countUnreadMessages should return the number of unread messages"
  );
  Assert.deepEqual(
    Array.from(await liveView.selectMessages(), m => m.id),
    [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    "selectMessages with no arguments should return all the messages"
  );

  liveView = new LiveView();
  liveView.initWithDateRange(0, 1600000000000000);

  Assert.equal(
    await liveView.countMessages(),
    4,
    "countMessages should return the total number of messages"
  );
  Assert.deepEqual(
    await Array.from(await liveView.selectMessages(), m => m.id),
    [4, 3, 2, 1],
    "selectMessages with no arguments should return all the messages"
  );
});

add_task(async function testSort() {
  const liveView = new LiveView();

  liveView.sortDescending = false;
  Assert.deepEqual(
    Array.from(await liveView.selectMessages(), m => m.date.toISOString()),
    [
      "2019-02-01T00:00:00.000Z",
      "2019-09-14T00:00:00.000Z",
      "2019-11-02T00:00:00.000Z",
      "2019-11-03T12:34:56.000Z",
      "2023-04-10T00:00:00.000Z",
      "2023-05-13T00:00:00.000Z",
      "2023-06-26T00:00:00.000Z",
      "2023-08-06T06:02:00.000Z",
      "2023-08-14T00:00:00.000Z",
      "2023-09-14T00:00:00.000Z",
    ],
    "messages should be in ascending date order"
  );

  liveView.sortDescending = true;
  Assert.deepEqual(
    Array.from(await liveView.selectMessages(), m => m.date.toISOString()),
    [
      "2023-09-14T00:00:00.000Z",
      "2023-08-14T00:00:00.000Z",
      "2023-08-06T06:02:00.000Z",
      "2023-06-26T00:00:00.000Z",
      "2023-05-13T00:00:00.000Z",
      "2023-04-10T00:00:00.000Z",
      "2019-11-03T12:34:56.000Z",
      "2019-11-02T00:00:00.000Z",
      "2019-09-14T00:00:00.000Z",
      "2019-02-01T00:00:00.000Z",
    ],
    "messages should be in descending date order"
  );

  liveView.sortColumn = Ci.nsILiveView.SUBJECT;
  Assert.deepEqual(
    Array.from(await liveView.selectMessages(), m => m.subject),
    [
      "Virtual solution-oriented knowledge user",
      "Universal 5th generation conglomeration",
      "Streamlined bandwidth-monitored help-desk",
      "Self-enabling clear-thinking archive",
      "Proactive intermediate collaboration",
      "Networked even-keeled forecast",
      "Fundamental empowering pricing structure",
      "Enterprise-wide mission-critical middleware",
      "Distributed mobile access",
      "Balanced static project déjà vu",
    ],
    "messages should be in descending subject order"
  );

  liveView.sortDescending = false;
  Assert.deepEqual(
    Array.from(await liveView.selectMessages(), m => m.subject),
    [
      "Balanced static project déjà vu",
      "Distributed mobile access",
      "Enterprise-wide mission-critical middleware",
      "Fundamental empowering pricing structure",
      "Networked even-keeled forecast",
      "Proactive intermediate collaboration",
      "Self-enabling clear-thinking archive",
      "Streamlined bandwidth-monitored help-desk",
      "Universal 5th generation conglomeration",
      "Virtual solution-oriented knowledge user",
    ],
    "messages should be in ascending subject order"
  );

  // FIXME: Address formatting is temporarily disabled.
  // liveView.sortColumn = Ci.nsILiveView.SENDER;
  // Assert.deepEqual(
  //   Array.from(await liveView.selectMessages(), m => m.sender),
  //   [
  //     "Abe Koepp <abe@koepp.invalid>",
  //     "Christian Murray <christian@murray.invalid>",
  //     "Edgár Stokes <edgar@stokes.invalid>",
  //     "Eliseo Bauch <eliseo@bauch.invalid>",
  //     "Frederick Rolfson <frederick@rolfson.invalid>",
  //     "Hope Bosco <hope@bosco.invalid>",
  //     "Kip Mann <kip@mann.invalid>",
  //     "Lydia Rau <lydia@rau.invalid>",
  //     "Neal Jast <neal@jast.invalid>",
  //     "Tara White <tara@white.invalid>",
  //   ],
  //   "messages should be in ascending sender order"
  // );

  liveView.sortDescending = true;
  // Assert.deepEqual(
  //   Array.from(await liveView.selectMessages(), m => m.sender),
  //   [
  //     "Tara White <tara@white.invalid>",
  //     "Neal Jast <neal@jast.invalid>",
  //     "Lydia Rau <lydia@rau.invalid>",
  //     "Kip Mann <kip@mann.invalid>",
  //     "Hope Bosco <hope@bosco.invalid>",
  //     "Frederick Rolfson <frederick@rolfson.invalid>",
  //     "Eliseo Bauch <eliseo@bauch.invalid>",
  //     "Edgár Stokes <edgar@stokes.invalid>",
  //     "Christian Murray <christian@murray.invalid>",
  //     "Abe Koepp <abe@koepp.invalid>",
  //   ],
  //   "messages should be in descending sender order"
  // );

  liveView.sortColumn = Ci.nsILiveView.READ_FLAG;
  Assert.deepEqual(
    Array.from(
      await liveView.selectMessages(),
      m => m.flags & Ci.nsMsgMessageFlags.Read
    ),
    [1, 1, 1, 1, 0, 0, 0, 0, 0, 0],
    "messages should be sorted with unread messages last"
  );

  liveView.sortDescending = false;
  Assert.deepEqual(
    Array.from(
      await liveView.selectMessages(),
      m => m.flags & Ci.nsMsgMessageFlags.Read
    ),
    [0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
    "messages should be sorted with unread messages first"
  );

  liveView.sortColumn = Ci.nsILiveView.MARKED_FLAG;
  Assert.deepEqual(
    Array.from(
      await liveView.selectMessages(),
      m => m.flags & Ci.nsMsgMessageFlags.Marked
    ),
    [4, 4, 4, 0, 0, 0, 0, 0, 0, 0],
    "messages should be sorted with flagged messages first"
  );

  liveView.sortDescending = true;
  Assert.deepEqual(
    Array.from(
      await liveView.selectMessages(),
      m => m.flags & Ci.nsMsgMessageFlags.Marked
    ),
    [0, 0, 0, 0, 0, 0, 0, 4, 4, 4],
    "messages should be sorted with flagged messages last"
  );
});

add_task(async function testEmojiCharacters() {
  const added = addMessage({
    sender: "🤷‍♂️",
    subject: "🤦‍♂️",
  });

  const liveView = new LiveView();

  const [message] = await liveView.selectMessages(1, 0);
  Assert.equal(message.id, added);
  Assert.equal(message.sender, "🤷‍♂️");
  Assert.equal(message.subject, "🤦‍♂️");

  messageDB.removeMessage(added);
});

function assertInitFails(liveView) {
  const folderA = folderDB.getFolderByPath("server1/folderA");

  Assert.throws(
    () => liveView.initWithFolder(folderA),
    /NS_ERROR_UNEXPECTED/,
    "setting the folder a second time should throw"
  );
  Assert.throws(
    () => liveView.initWithFolders([folderA]),
    /NS_ERROR_UNEXPECTED/,
    "setting the folder a second time should throw"
  );
  Assert.throws(
    () => liveView.initWithTag("$labelX"),
    /NS_ERROR_UNEXPECTED/,
    "setting the folder a second time should throw"
  );
  Assert.throws(
    () => liveView.initWithConversation(1),
    /NS_ERROR_UNEXPECTED/,
    "setting the folder a second time should throw"
  );
}

/**
 * Public New follows this physical facade without recapturing reentrant flags.
 */
add_task(async function test_publicNewUsesFrozenPhysicalStatus() {
  const seen = [];
  // Register the native view first. The adapter cases exercise the inverse
  // native/public order with their already open physical-folder facades.
  const view = new LiveView();
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsILiveViewListener"]),
    onSelectedChunk() {},
    onMessageAdded() {},
    onMessageRemoved() {},
    onMessageTagsChanged() {},
    onMessageFlagsChanged(message, oldFlags) {
      seen.push({ key: message.id, flags: message.flags, oldFlags });
    },
  };
  view.setListener(listener);
  const { MessageInjection } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/MessageInjection.sys.mjs"
  );
  const { MessageGenerator, SyntheticMessageSet } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
  );
  const injection = new MessageInjection({ mode: "local" });
  const generator = new MessageGenerator();
  const parent = generator.makeMessage({ subject: "public-new-physical" });
  const child = generator.makeMessage({ inReplyTo: parent });
  const folder = await injection.makeEmptyFolder();
  const other = await injection.makeEmptyFolder();
  const set = new SyntheticMessageSet([parent, child]);
  const copy = new SyntheticMessageSet([parent]);
  await injection.addSetsToFolders([folder], [set]);
  await injection.addSetsToFolders([other], [copy]);
  Assert.equal(
    folder.server.getStringValue("storeContractID"),
    "@mozilla.org/msgstore/berkeleystore;1"
  );
  Assert.ok(database instanceof Ci.nsIDatabaseCore);
  const [root, reply] = set.msgHdrList;
  const db = folder.msgDatabase;
  root.flags = 0;
  reply.flags = Ci.nsMsgMessageFlags.New | Ci.nsMsgMessageFlags.Marked;
  db.addToNewList(root.messageKey);
  const copyBefore = copy.msgHdrList[0].flags;
  const folderId = folderDB.getFolderByPath(
    `${folder.server.key}/${folder.name}`
  );
  Assert.greater(folderId, 0);
  let reentry = "readd";
  const earlier = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onReadChanged() {},
    onAnnouncerGoingAway() {},
    onHdrFlagsChanged(header, oldFlags, newFlags) {
      if (header.messageKey != root.messageKey) {
        return;
      }
      if (reentry == "readd" && newFlags & Ci.nsMsgMessageFlags.Read) {
        db.addToNewList(root.messageKey);
      } else if (
        reentry == "readDuringClear" &&
        oldFlags & Ci.nsMsgMessageFlags.New &&
        !(newFlags & Ci.nsMsgMessageFlags.New)
      ) {
        reentry = "none";
        db.markRead(root.messageKey, true, null);
      }
    },
  };
  db.addListener(earlier);
  view.initWithFolder(folderId);
  try {
    const rows = await view.selectMessages();
    Assert.deepEqual(
      rows.map(row => [row.folderId, row.id]).sort((a, b) => a[1] - b[1]),
      [root, reply]
        .map(header => [folderId, header.messageKey])
        .sort((a, b) => a[1] - b[1])
    );
    Assert.equal(
      rows.find(row => row.id == root.messageKey).flags,
      Ci.nsMsgMessageFlags.New
    );
    Assert.equal(
      rows.find(row => row.id == reply.messageKey).flags,
      Ci.nsMsgMessageFlags.New | Ci.nsMsgMessageFlags.Marked
    );
    seen.length = 0;
    db.markRead(root.messageKey, true, null);
    Assert.ok(
      root.flags & Ci.nsMsgMessageFlags.New,
      "The earlier listener really re-added NewList after the frozen word"
    );
    const changed = seen.filter(row => row.key == root.messageKey);
    Assert.greater(changed.length, 0);
    Assert.ok(
      changed.every(row => !(row.flags & Ci.nsMsgMessageFlags.New)),
      "The retained consumer never reads future reentrant NewList state"
    );
    Assert.deepEqual(
      changed.map(row => row.flags),
      [Ci.nsMsgMessageFlags.Read],
      "Native and public delivery install the complete changed word exactly once"
    );
    Assert.equal(copy.msgHdrList[0].flags, copyBefore);
    Assert.equal(
      reply.flags,
      Ci.nsMsgMessageFlags.New | Ci.nsMsgMessageFlags.Marked
    );
    await view.selectMessages();
    seen.length = 0;
    db.clearNewList(true);
    Assert.ok(
      seen.some(
        row =>
          row.key == root.messageKey && row.flags == Ci.nsMsgMessageFlags.Read
      ),
      "A public NewList-only change reaches the consumer without a raw flag write"
    );
    reentry = "none";
    db.markRead(root.messageKey, false, null);
    db.addToNewList(root.messageKey);
    await view.selectMessages();
    seen.length = 0;
    reentry = "readDuringClear";
    db.clearNewList(true);
    Assert.ok(
      root.isRead,
      "The earlier clear listener performed a real nested read"
    );
    Assert.deepEqual(
      seen.filter(row => row.key == root.messageKey).map(row => row.flags),
      [Ci.nsMsgMessageFlags.Read],
      "The outer NewList-only word does not undo an already observed nested raw read"
    );
    const pending = view.selectMessages();
    view.clearListener(listener);
    await Assert.rejects(pending, error => error.name == "AbortError");
    const count = seen.length;
    db.markRead(root.messageKey, false, null);
    Assert.equal(
      seen.length,
      count,
      "Detached listeners receive no later update"
    );
    view.setListener(listener);
    await view.selectMessages();
    const closePending = view.selectMessages();
    folder.ForceDBClosed();
    await Assert.rejects(closePending, error => error.name == "AbortError");
    const afterClose = seen.length;
    folder.msgDatabase.markRead(root.messageKey, true, null);
    Assert.equal(
      seen.length,
      afterClose,
      "The closed facade's observer stays detached"
    );
  } finally {
    view.clearListener(listener);
    db.removeListener(earlier);
  }
});
