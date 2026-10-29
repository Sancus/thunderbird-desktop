/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests that messages marked as "not junk" in a virtual folder are returned
 * to the inbox for the account they belong to (see bug 1884660).
 */

const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { SmartMailboxUtils } = ChromeUtils.importESModule(
  "resource:///modules/SmartMailboxUtils.sys.mjs"
);
const { VirtualFolderHelper } = ChromeUtils.importESModule(
  "resource:///modules/VirtualFolderWrapper.sys.mjs"
);

const about3Pane = document.getElementById("tabmail").currentAbout3Pane;
let inbox, junk;
let otherInbox, otherJunk;
let smartJunk;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["mailnews.ui.junk.manualMarkAsJunkMarksRead", true],
      ["mail.spam.manualMark", true],
      ["mail.spam.manualMarkMode", Ci.nsISpamSettings.MANUAL_MARK_MODE_MOVE],
    ],
  });

  const server = MailServices.accounts.localFoldersServer;
  const rootFolder = server.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);

  // I hate that I have to do this, but even if the previous test cleaned up
  // these special folders, they'd still exist in the folder lookup service,
  // and that causes problems. So we might as well use the existing folder.
  inbox = rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
  if (!inbox) {
    inbox = rootFolder.createLocalSubfolder("Inbox");
    inbox.setFlag(Ci.nsMsgFolderFlags.Inbox);
  }

  junk = rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Junk);
  if (!junk) {
    junk = rootFolder.createLocalSubfolder("Junk");
    junk.setFlag(Ci.nsMsgFolderFlags.Junk);
  }

  const generator = new MessageGenerator();
  inbox.QueryInterface(Ci.nsIMsgLocalMailFolder);
  inbox.addMessageBatch(
    generator
      .makeMessages({ count: 3 })
      .map(message => message.toMessageString())
  );

  const otherAccount = MailServices.accounts.createAccount();
  const otherServer = MailServices.accounts.createIncomingServer(
    "nobody",
    "nowhere",
    "none"
  );
  const otherRootFolder = otherServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  otherAccount.incomingServer = otherServer;

  otherInbox = otherRootFolder.createLocalSubfolder("Inbox");
  otherInbox.setFlag(Ci.nsMsgFolderFlags.Inbox);

  otherJunk = otherRootFolder.createLocalSubfolder("Junk");
  otherJunk.setFlag(Ci.nsMsgFolderFlags.Junk);

  otherInbox.QueryInterface(Ci.nsIMsgLocalMailFolder);
  otherInbox.addMessageBatch(
    generator
      .makeMessages({ count: 2 })
      .map(message => message.toMessageString())
  );

  about3Pane.folderPane.activeModes = ["all", "smart"];
  smartJunk = SmartMailboxUtils.getSmartMailbox().getSmartFolder("Junk");

  registerCleanupFunction(function () {
    inbox.deleteSelf(null);
    junk.deleteSelf(null);
    MailServices.accounts.removeAccount(otherAccount, false);
  });
});

add_task(async function () {
  Assert.equal(inbox.getTotalMessages(false), 3);
  Assert.equal(otherInbox.getTotalMessages(false), 2);

  // Mark the messages in inbox as junk.

  about3Pane.displayFolder(inbox);
  about3Pane.threadTree.selectAll();
  const move1 = PromiseTestUtils.promiseFolderEvent(
    inbox,
    "DeleteOrMoveMsgCompleted"
  );
  EventUtils.synthesizeKey("j", {}, about3Pane);
  await move1;
  Assert.equal(inbox.getTotalMessages(false), 0);

  // Mark the messages in otherInbox as junk.

  about3Pane.displayFolder(otherInbox);
  about3Pane.threadTree.selectAll();
  const move2 = PromiseTestUtils.promiseFolderEvent(
    otherInbox,
    "DeleteOrMoveMsgCompleted"
  );
  EventUtils.synthesizeKey("j", {}, about3Pane);
  await move2;
  Assert.equal(otherInbox.getTotalMessages(false), 0);

  // Open the smart junk folder.

  about3Pane.displayFolder(smartJunk);
  await TestUtils.waitForCondition(
    () => about3Pane.dbViewWrapperListener.allMessagesLoaded
  );
  about3Pane.threadTree.selectAll();
  Assert.equal(about3Pane.gDBView.getSelectedMsgHdrs().length, 5);
  Assert.equal(smartJunk.getTotalMessages(false), 5);

  // Unmark the messages.

  const move3 = PromiseTestUtils.promiseFolderEvent(
    junk,
    "DeleteOrMoveMsgCompleted"
  );
  const move4 = PromiseTestUtils.promiseFolderEvent(
    otherJunk,
    "DeleteOrMoveMsgCompleted"
  );
  EventUtils.synthesizeKey("j", { shiftKey: true }, about3Pane);
  await Promise.all([move3, move4]);
  await TestUtils.waitForCondition(
    () => [inbox, junk, otherInbox, otherJunk].every(folder => !folder.locked),
    "The move completion events precede release of the destination locks"
  );

  Assert.equal(inbox.getTotalMessages(false), 3);
  Assert.equal(otherInbox.getTotalMessages(false), 2);
});

add_task(async function testJunkActionsUseEachPhysicalFolder() {
  const generator = new MessageGenerator();
  const firstMessage = generator.makeMessage();
  firstMessage.messageId = "junk-physical-first@example.invalid";
  const secondMessage = generator.makeMessage();
  secondMessage.messageId = "junk-physical-second@example.invalid";
  const first = inbox.addMessage(firstMessage.toMessageString());
  const second = otherInbox.addMessage(secondMessage.toMessageString());
  const firstId = first.messageId;
  const secondId = second.messageId;
  const firstKey = first.messageKey;
  const secondKey = second.messageKey;
  const inboxCount = inbox.getTotalMessages(false);
  const otherInboxCount = otherInbox.getTotalMessages(false);

  await about3Pane.performActionsOnJunkMsgs([first, second], []);
  Assert.equal(inbox.getTotalMessages(false), inboxCount - 1);
  Assert.equal(otherInbox.getTotalMessages(false), otherInboxCount - 1);
  Assert.ok(!inbox.msgDatabase.containsKey(firstKey));
  Assert.ok(!otherInbox.msgDatabase.containsKey(secondKey));
  Assert.deepEqual(
    [...junk.messages].map(header => header.messageId),
    [firstId]
  );
  Assert.deepEqual(
    [...otherJunk.messages].map(header => header.messageId),
    [secondId]
  );

  await about3Pane.performActionsOnJunkMsgs(
    [],
    [...junk.messages, ...otherJunk.messages]
  );
  Assert.equal(junk.getTotalMessages(false), 0);
  Assert.equal(otherJunk.getTotalMessages(false), 0);
  Assert.equal(inbox.getTotalMessages(false), inboxCount);
  Assert.equal(otherInbox.getTotalMessages(false), otherInboxCount);
  Assert.ok([...inbox.messages].some(header => header.messageId == firstId));
  Assert.ok(![...inbox.messages].some(header => header.messageId == secondId));
  Assert.ok(
    [...otherInbox.messages].some(header => header.messageId == secondId)
  );
  Assert.ok(
    ![...otherInbox.messages].some(header => header.messageId == firstId)
  );
});

add_task(async function testJunkControlsUseEachServersWhitelist() {
  await SpecialPowers.pushPrefEnv({
    set: [["mail.trusteddomains", "whitelist.invalid"]],
  });
  const server = inbox.server;
  const otherServer = otherInbox.server;
  const settings = server.spamSettings;
  const otherSettings = otherServer.spamSettings;
  settings.initialize(server);
  otherSettings.initialize(otherServer);
  settings.useWhiteList = true;
  otherSettings.useWhiteList = false;
  const generator = new MessageGenerator();
  const firstFolder = server.rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("whitelistFirst")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const secondFolder = otherServer.rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("whitelistSecond")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const first = firstFolder.addMessage(
    generator
      .makeMessage({ from: ["Trusted Sender", "sender@whitelist.invalid"] })
      .toMessageString()
  );
  const second = secondFolder.addMessage(
    generator
      .makeMessage({ from: ["Trusted Sender", "sender@whitelist.invalid"] })
      .toMessageString()
  );
  const search = VirtualFolderHelper.createNewVirtualFolder(
    "whitelistSearch",
    server.rootFolder,
    [firstFolder, secondFolder],
    "ALL",
    false
  ).virtualFolder;
  try {
    Assert.ok(settings.checkWhiteList(first));
    Assert.ok(!otherSettings.checkWhiteList(second));
    about3Pane.displayFolder(search);
    await TestUtils.waitForCondition(
      () => about3Pane.dbViewWrapperListener.allMessagesLoaded
    );
    Assert.equal(
      about3Pane.gDBView.rowCount,
      2,
      "Only the two fixture messages are classified"
    );
    const finished = TestUtils.topicObserved("message-classification-complete");
    about3Pane.goDoCommand("cmd_runJunkControls");
    await finished;
    Assert.equal(first.getStringProperty("junkscoreorigin"), "whitelist");
    Assert.equal(second.getStringProperty("junkscoreorigin"), "plugin");
  } finally {
    about3Pane.displayFolder(inbox);
    search.deleteSelf(null);
    firstFolder.deleteSelf(null);
    secondFolder.deleteSelf(null);
    await SpecialPowers.popPrefEnv();
    settings.initialize(server);
    otherSettings.initialize(otherServer);
  }
});

/**
 * Hold a real plugin result across a physical move, deletion, or user override.
 *
 * @param {"move"|"delete"|"user"} action - The change before delivering the result.
 * @param {boolean} [includeQueuedMessage=false] - Also delete a queued message.
 */
async function checkStaleClassification(action, includeQueuedMessage = false) {
  const prefix =
    action + (includeQueuedMessage ? "Queued" : "") + "PendingClassification";
  const root = inbox.server.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  const source = root
    .createLocalSubfolder(prefix + "Source")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const destination = root
    .createLocalSubfolder(prefix + "Destination")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const outside = root
    .createLocalSubfolder(prefix + "Outside")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const generator = new MessageGenerator();
  const rawMessage = generator.makeMessage().toMessageString();
  const header = source.addMessage(rawMessage);
  const queued = includeQueuedMessage ? source.addMessage(rawMessage) : null;
  const queuedKey = queued?.messageKey;
  const excluded = outside.addMessage(rawMessage);
  const key = header.messageKey;
  const messageId = header.messageId;
  const excludedKey = excluded.messageKey;
  const settings = source.server.spamSettings;
  const oldWhiteList = settings.useWhiteList;
  settings.useWhiteList = false;
  const classifier = new about3Pane.MessageClassifier(
    includeQueuedMessage ? 2 : 1
  );
  const deliver = classifier.onMessageClassified.bind(classifier);
  const classified = Promise.withResolvers();
  classifier.onMessageClassified = (uri, classification, percent) => {
    if (uri) {
      classified.resolve({ uri, classification, percent });
    }
  };
  let completions = 0;
  const observer = () => completions++;
  Services.obs.addObserver(observer, "message-classification-complete");
  try {
    classifier.analyzeMessage(header, settings);
    if (queued) {
      classifier.analyzeMessage(queued, settings);
    }
    const result = await classified.promise;
    Assert.equal(result.uri, source.generateMessageURI(key));
    if (action == "user") {
      source.setJunkScoreForMessages(
        [header],
        Ci.nsIJunkMailPlugin.IS_HAM_SCORE,
        "user",
        -1
      );
    } else {
      const listener = new PromiseTestUtils.PromiseCopyListener();
      if (action == "move") {
        MailServices.copy.copyMessages(
          source,
          [header],
          destination,
          true,
          listener,
          null,
          false
        );
      } else {
        source.deleteMessages(
          queued ? [header, queued] : [header],
          null,
          true,
          false,
          listener,
          false
        );
      }
      await listener.promise;
      Assert.ok(
        !source.msgDatabase.containsKey(key),
        "The captured source is gone"
      );
    }
    const moved = [...destination.messages];
    Assert.equal(moved.length, action == "move" ? 1 : 0);
    const destinationKey = moved[0]?.messageKey;
    if (action == "move") {
      Assert.equal(moved[0].messageId, messageId);
    }
    await deliver(result.uri, result.classification, result.percent);
    Assert.equal(
      completions,
      1,
      "The stale result still settles the classifier"
    );
    Assert.equal(source.getTotalMessages(false), action == "user" ? 1 : 0);
    if (queued) {
      Assert.ok(!source.msgDatabase.containsKey(queuedKey));
      Assert.equal(classifier.mMessageQueue.length, 0);
      Assert.deepEqual(Object.keys(classifier.mMessages), []);
    }
    Assert.equal(destination.getTotalMessages(false), action == "move" ? 1 : 0);
    for (const stored of [
      outside.msgDatabase.getMsgHdrForKey(excludedKey),
      ...(action == "move"
        ? [destination.msgDatabase.getMsgHdrForKey(destinationKey)]
        : []),
    ]) {
      Assert.equal(stored.messageId, messageId);
      Assert.equal(stored.getStringProperty("junkscore"), "");
      Assert.equal(stored.getStringProperty("junkscoreorigin"), "");
      Assert.equal(stored.getStringProperty("junkpercent"), "");
    }
    if (action == "user") {
      const current = source.msgDatabase.getMsgHdrForKey(key);
      Assert.equal(current.messageId, messageId);
      Assert.equal(current.getStringProperty("junkscore"), "0");
      Assert.equal(current.getStringProperty("junkscoreorigin"), "user");
      Assert.equal(current.getStringProperty("junkpercent"), "");
    }
    await deliver(result.uri, result.classification, result.percent);
    Assert.equal(completions, 1, "A repeated result does not repeat actions");
  } finally {
    Services.obs.removeObserver(observer, "message-classification-complete");
    settings.useWhiteList = oldWhiteList;
    source.deleteSelf(null);
    destination.deleteSelf(null);
    outside.deleteSelf(null);
  }
}

add_task(async function testDeletedClassificationResultIgnored() {
  await checkStaleClassification("delete");
});

add_task(async function testMovedClassificationResultIgnored() {
  await checkStaleClassification("move");
});

add_task(async function testUserClassificationWinsOverPendingResult() {
  await checkStaleClassification("user");
});

add_task(async function testDeletedQueuedClassificationIsSkipped() {
  await checkStaleClassification("delete", true);
});

add_task(async function testGroupedSearchDeletionRemovesPhysicalRows() {
  const root = inbox.server.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  const first = root.createLocalSubfolder("groupedDeleteFirst");
  const second = root.createLocalSubfolder("groupedDeleteSecond");
  const outside = root.createLocalSubfolder("groupedDeleteOutside");
  const generator = new MessageGenerator();
  const message = generator.makeMessage({ subject: "Grouped deletion" });
  message.messageId = "grouped-first@example.invalid";
  const a = first
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .addMessage(message.toMessageString());
  const excluded = outside
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .addMessage(message.toMessageString());
  message.messageId = "grouped-second@example.invalid";
  const b = second
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .addMessage(message.toMessageString());
  const firstKey = a.messageKey;
  const secondKey = b.messageKey;
  const excludedKey = excluded.messageKey;
  const identity = header => [
    header.folder.URI,
    header.messageKey,
    header.messageId,
  ];
  const expectedFirst = identity(a);
  const expectedSecond = identity(b);
  const view = Cc[
    "@mozilla.org/messenger/msgdbview;1?type=search"
  ].createInstance(Ci.nsIMsgDBView);
  try {
    view.init(null, null);
    view.open(
      null,
      Ci.nsMsgViewSortType.bySubject,
      Ci.nsMsgViewSortOrder.ascending,
      Ci.nsMsgViewFlagsType.kThreadedDisplay |
        Ci.nsMsgViewFlagsType.kGroupBySort
    );
    const notify = view.QueryInterface(Ci.nsIMsgSearchNotify);
    notify.onNewSearch();
    notify.onSearchHit(a, first);
    notify.onSearchHit(b, second);
    notify.onSearchDone(Cr.NS_OK);
    view.doCommand(Ci.nsMsgViewCommandType.expandAll);
    const tree = view.QueryInterface(Ci.nsITreeView);
    const members = () =>
      Array.from({ length: tree.rowCount }, (_, index) => index)
        .filter(index => tree.getLevel(index) > 0)
        .map(index => identity(view.getMsgHdrAt(index)))
        .sort((left, right) => left[0].localeCompare(right[0]));
    Assert.equal(tree.rowCount, 3, "One group and both physical child rows");
    Assert.deepEqual(members(), [expectedFirst, expectedSecond]);
    Assert.equal(view.findIndexOfMsgHdr(excluded, false), 0xffffffff);

    const firstDeleted = new PromiseTestUtils.PromiseCopyListener();
    first.deleteMessages([a], null, true, false, firstDeleted, false);
    await firstDeleted.promise;
    Assert.ok(!first.msgDatabase.containsKey(firstKey));
    Assert.ok(second.msgDatabase.containsKey(secondKey));
    Assert.equal(tree.rowCount, 2, "The group and surviving child remain");
    Assert.deepEqual(members(), [expectedSecond]);
    Assert.equal(view.findIndexOfMsgHdr(a, false), 0xffffffff);

    const secondDeleted = new PromiseTestUtils.PromiseCopyListener();
    second.deleteMessages([b], null, true, false, secondDeleted, false);
    await secondDeleted.promise;
    Assert.ok(!second.msgDatabase.containsKey(secondKey));
    Assert.equal(
      tree.rowCount,
      0,
      "The last child and its dummy row are removed"
    );
    Assert.ok(outside.msgDatabase.containsKey(excludedKey));
    Assert.deepEqual([...outside.messages].map(identity), [identity(excluded)]);
  } finally {
    view.close();
    first.deleteSelf(null);
    second.deleteSelf(null);
    outside.deleteSelf(null);
  }
});
