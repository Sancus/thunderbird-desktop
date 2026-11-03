/*
 * This file tests imap filter actions, particularly as affected by the
 * addition of body searches in bug 127250. Actions that involves sending
 * mail are not tested. The tests check various counts, and the effects
 * on the message database of the filters. Effects on IMAP server
 * flags, if any, are not tested.
 *
 * Original author: Kent James <kent@caspia.com>
 * adapted from test_localToImapFilter.js
 */

const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

// Globals
var gSubfolder; // a local message folder used as a target for moves and copies
var gFilter; // a message filter with a subject search
var gAction; // current message action (reused)
var gBodyFilter; // a message filter with a body search
var gInboxListener; // database listener object
let gInboxDatabase = null;
let gIncomingUid;
var gHeader; // the current message db header
var gInboxCount; // the previous number of messages in the Inbox
var gSubfolderCount; // the previous number of messages in the subfolder
var gMessage = "image-attach-test"; // message file used as the test message

// subject of the test message
var gMessageSubject = "image attach test";

// a string in the body of the test message
var gMessageInBody = "01234567890test";

// various object references
var gDbService = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
  Ci.nsIMsgDBService
);

var gSmtpServerD = setupSmtpServerDaemon();

add_setup(async function setupNativeFilterActions() {
  const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  if (native) {
    const storePref = "mail.server.default.storeContractID";
    const autosyncPref = "mail.server.default.autosync_offline_stores";
    const hadStore = Services.prefs.prefHasUserValue(storePref);
    const oldStore = Services.prefs.getCharPref(storePref, "");
    const hadAutosync = Services.prefs.prefHasUserValue(autosyncPref);
    const oldAutosync = Services.prefs.getBoolPref(autosyncPref, true);
    registerCleanupFunction(() => {
      if (IMAPPump.incomingServer) {
        teardownIMAPPump();
      }
      if (hadStore) {
        Services.prefs.setCharPref(storePref, oldStore);
      } else {
        Services.prefs.clearUserPref(storePref);
      }
      if (hadAutosync) {
        Services.prefs.setBoolPref(autosyncPref, oldAutosync);
      } else {
        Services.prefs.clearUserPref(autosyncPref);
      }
    });
    Services.prefs.setCharPref(
      storePref,
      Services.prefs.getCharPref("mail.serverDefaultStoreContractID")
    );
    Services.prefs.setBoolPref(autosyncPref, false);
  }
  setupIMAPPump();
  if (native) {
    IMAPPump.mailbox.uidvalidity = 7301;
    IMAPPump.mailbox.uidnext = 7401;
    const root = IMAPPump.incomingServer.rootFolder;
    const discovered = new PromiseTestUtils.PromiseUrlListener();
    MailServices.imap.discoverAllFolders(root, discovered, null);
    await discovered.promise;
    const inbox = root.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
    Assert.ok(inbox, "Native discovery supplied the actual INBOX");
    IMAPPump.inbox = inbox.QueryInterface(Ci.nsIMsgImapMailFolder);
    Assert.equal(IMAPPump.inbox.parent, root);
    Assert.equal(IMAPPump.inbox.server, IMAPPump.incomingServer);
    const expectedStore = {
      "@mozilla.org/msgstore/berkeleystore;1": "mbox",
      "@mozilla.org/msgstore/maildirstore;1": "maildir",
    }[Services.prefs.getCharPref("mail.serverDefaultStoreContractID")];
    Assert.ok(expectedStore);
    Assert.equal(IMAPPump.incomingServer.msgStore.storeType, expectedStore);
    Assert.equal(IMAPPump.inbox.msgStore.storeType, expectedStore);
  }
  //   IMAPPump.server.setDebugLevel(nsMailServer.debugAll);
  gSmtpServerD.start();
  var gSmtpServer = localAccountUtils.create_outgoing_server(
    "smtp",
    "user",
    "password",
    { port: gSmtpServerD.port }
  );
  MailServices.accounts.defaultAccount.defaultIdentity.email =
    "from@tinderbox.invalid";
  MailServices.accounts.defaultAccount.defaultIdentity.smtpServerKey =
    gSmtpServer.key;

  setupFilters();

  registerCleanupFunction(() => {
    gSmtpServerD.stop();
    Services.prefs.clearUserPref("mail.filters.forward.enabled");
    Services.prefs.clearUserPref("mail.forward_message_mode");
    if (gInboxDatabase && gInboxListener) {
      gInboxDatabase.removeListener(gInboxListener);
      gInboxDatabase = null;
    } else if (gInboxListener) {
      gDbService.unregisterPendingListener(gInboxListener);
    }
    gInboxListener = null;
    MailServices.mailSession.RemoveFolderListener(FolderListener);
    teardownIMAPPump();
  });
});

// Configure the non-Trash regression before earlier tasks leave deleted server
// messages: changing to IMAPDelete also intentionally makes those messages visible.
add_task(async function test_nativeMoveWithNonTrashDeleteModel() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    return;
  }
  const server = IMAPPump.incomingServer;
  const oldDeleteModel = server.deleteModel;
  const commands = () => {
    const transaction = IMAPPump.server.playTransaction();
    return (Array.isArray(transaction) ? transaction : [transaction])
      .flatMap(item => item.them)
      .map(command => command.toUpperCase());
  };
  try {
    for (const deleteModel of [
      Ci.nsMsgImapDeleteModels.IMAPDelete,
      Ci.nsMsgImapDeleteModels.DeleteNoTrash,
    ]) {
      server.deleteModel = deleteModel;
      gFilter.enabled = true;
      gAction.type = Ci.nsMsgFilterAction.MoveToFolder;
      gAction.targetFolderUri = gSubfolder.URI;
      const oldKeys = new Set(
        Array.from(
          gSubfolder.msgDatabase.enumerateMessages(),
          header => header.messageKey
        )
      );
      const start = commands().length;
      const uid = IMAPPump.mailbox.uidnext;
      const sourceURI = specForFileName(gMessage);
      const sourceText = new ImapMessage(sourceURI, uid, []).getText();
      await setupTest(gFilter, gAction);
      Assert.equal(gIncomingUid, uid);
      Assert.equal(gInboxListener.counts.onHdrAdded, 1);
      Assert.equal(gInboxListener.lastAdded.uid, uid);
      Assert.notEqual(gInboxListener.lastAdded.key, uid);
      await TestUtils.waitForCondition(
        () => folderCount(gSubfolder) == oldKeys.size + 1,
        "the coalesced move finishes its real destination"
      );
      const moved = Array.from(
        gSubfolder.msgDatabase.enumerateMessages()
      ).filter(header => !oldKeys.has(header.messageKey));
      Assert.equal(moved.length, 1);
      Assert.notEqual(moved[0].messageKey, gInboxListener.lastAdded.key);
      Assert.equal(moved[0].getUint32Property("uidOnServer"), 0);
      Assert.stringContains(
        mailTestUtils.loadMessageToString(gSubfolder, moved[0]),
        gMessageInBody
      );
      const deletes = () =>
        commands()
          .slice(start)
          .filter(
            command =>
              command.includes("UID STORE") && command.includes("\\DELETED")
          );
      await TestUtils.waitForCondition(
        () => deletes().length == 1,
        "the successful move deletes its actual server source once"
      );
      Assert.ok(deletes()[0].includes(`UID STORE ${uid} `));
      const source = IMAPPump.mailbox._messages.find(
        message => message.uid == uid
      );
      Assert.ok(source);
      await TestUtils.waitForCondition(
        () => source.flags.includes("\\Deleted"),
        "the server confirms deletion of the selected source UID"
      );
      Assert.equal(source._URI, sourceURI);
      Assert.equal(source.getText(), sourceText);
      const bodyFetches = () =>
        commands()
          .slice(start)
          .filter(
            command =>
              command.includes("UID FETCH") && command.includes("BODY.PEEK[]")
          );
      const headerFetches = () =>
        commands()
          .slice(start)
          .filter(
            command =>
              command.includes("UID FETCH") &&
              command.includes("BODY.PEEK[HEADER")
          );
      Assert.equal(bodyFetches().length, 1);
      Assert.ok(bodyFetches()[0].includes(`UID FETCH ${uid} `));
      const fetched = headerFetches().length;
      Assert.equal(fetched, 1);
      for (let attempt = 0; attempt < 2; attempt++) {
        const listener = new PromiseTestUtils.PromiseUrlListener();
        IMAPPump.inbox.updateFolderWithListener(null, listener);
        await listener.promise;
        Assert.equal(folderCount(gSubfolder), oldKeys.size + 1);
        Assert.equal(gInboxListener.counts.onHdrAdded, 1);
        Assert.equal(deletes().length, 1);
        Assert.equal(bodyFetches().length, 1);
        Assert.equal(headerFetches().length, fetched);
      }
    }
  } finally {
    server.deleteModel = oldDeleteModel;
  }
});

add_task(async function MoveToFolder() {
  gAction.type = Ci.nsMsgFilterAction.MoveToFolder;
  gAction.targetFolderUri = gSubfolder.URI;
  gInboxCount = folderCount(IMAPPump.inbox);
  gSubfolderCount = folderCount(gSubfolder);
  await setupTest(gFilter, gAction);

  testCounts(false, 0, 0, 0);
  Assert.equal(gInboxCount, folderCount(IMAPPump.inbox));
  Assert.equal(gSubfolderCount + 1, folderCount(gSubfolder));
});

// do it again, sometimes that causes multiple downloads
add_task(async function MoveToFolder2() {
  gAction.type = Ci.nsMsgFilterAction.MoveToFolder;
  gAction.targetFolderUri = gSubfolder.URI;
  gInboxCount = folderCount(IMAPPump.inbox);
  gSubfolderCount = folderCount(gSubfolder);
  await setupTest(gFilter, gAction);

  testCounts(false, 0, 0, 0);
  Assert.equal(gInboxCount, folderCount(IMAPPump.inbox));
  Assert.equal(gSubfolderCount + 1, folderCount(gSubfolder));
});

add_task(async function MoveToFolderBody() {
  gAction.type = Ci.nsMsgFilterAction.MoveToFolder;
  gAction.targetFolderUri = gSubfolder.URI;
  gInboxCount = folderCount(IMAPPump.inbox);
  gSubfolderCount = folderCount(gSubfolder);
  await setupTest(gBodyFilter, gAction);

  testCounts(false, 0, 0, 0);
  Assert.equal(gSubfolderCount + 1, folderCount(gSubfolder));
  // no net messages were added to the inbox
  Assert.equal(gInboxCount, folderCount(IMAPPump.inbox));
});

add_task(async function MoveToFolderBody2() {
  gAction.type = Ci.nsMsgFilterAction.MoveToFolder;
  gAction.targetFolderUri = gSubfolder.URI;
  gInboxCount = folderCount(IMAPPump.inbox);
  gSubfolderCount = folderCount(gSubfolder);
  await setupTest(gBodyFilter, gAction);

  testCounts(false, 0, 0, 0);
  Assert.equal(gSubfolderCount + 1, folderCount(gSubfolder));
  // no net messages were added to the inbox
  Assert.equal(gInboxCount, folderCount(IMAPPump.inbox));
});

add_task(async function MarkRead() {
  gAction.type = Ci.nsMsgFilterAction.MarkRead;
  gInboxCount = folderCount(IMAPPump.inbox);
  await setupTest(gFilter, gAction);
  testCounts(false, 0, 0, 0);
  Assert.ok(gHeader.isRead);
  Assert.equal(gInboxCount + 1, folderCount(IMAPPump.inbox));
});

add_task(async function MarkReadBody() {
  gAction.type = Ci.nsMsgFilterAction.MarkRead;
  gInboxCount = folderCount(IMAPPump.inbox);
  await setupTest(gBodyFilter, gAction);

  testCounts(false, 0, 0, 0);
  Assert.ok(gHeader.isRead);
  Assert.equal(gInboxCount + 1, folderCount(IMAPPump.inbox));
});

add_task(async function KillThread() {
  gAction.type = Ci.nsMsgFilterAction.KillThread;
  await setupTest(gFilter, gAction);

  testCounts(false, 0, 0, 0);
  const thread = db().getThreadContainingMsgHdr(gHeader);
  Assert.notEqual(0, thread.flags & Ci.nsMsgMessageFlags.Ignored);
});

add_task(async function KillThreadBody() {
  gAction.type = Ci.nsMsgFilterAction.KillThread;
  await setupTest(gBodyFilter, gAction);

  testCounts(false, 0, 0, 0);
  const thread = db().getThreadContainingMsgHdr(gHeader);
  Assert.notEqual(0, thread.flags & Ci.nsMsgMessageFlags.Ignored);
});

add_task(async function KillSubthread() {
  gAction.type = Ci.nsMsgFilterAction.KillSubthread;
  await setupTest(gFilter, gAction);

  testCounts(false, 0, 0, 0);
  Assert.notEqual(0, gHeader.flags & Ci.nsMsgMessageFlags.Ignored);
});

add_task(async function KillSubthreadBody() {
  gAction.type = Ci.nsMsgFilterAction.KillSubthread;
  await setupTest(gBodyFilter, gAction);

  testCounts(false, 0, 0, 0);
  Assert.notEqual(0, gHeader.flags & Ci.nsMsgMessageFlags.Ignored);
});
add_task(async function DoNothing() {
  gAction.type = Ci.nsMsgFilterAction.StopExecution;
  await setupTest(gFilter, gAction);

  testCounts(true, 1, 1, 1);
});

add_task(async function DoNothingBody() {
  gAction.type = Ci.nsMsgFilterAction.StopExecution;
  await setupTest(gFilter, gAction);

  testCounts(true, 1, 1, 1);
});

// this tests for marking message as junk
add_task(async function JunkScore() {
  gAction.type = Ci.nsMsgFilterAction.JunkScore;
  gAction.junkScore = 100;
  await setupTest(gFilter, gAction);

  // marking as junk resets new but not unread
  testCounts(false, 1, 0, 0);
  Assert.equal(gHeader.getStringProperty("junkscore"), "100");
  Assert.equal(gHeader.getStringProperty("junkscoreorigin"), "filter");
});

// this tests for marking message as junk

add_task(async function JunkScoreBody() {
  gAction.type = Ci.nsMsgFilterAction.JunkScore;
  gAction.junkScore = 100;
  await setupTest(gBodyFilter, gAction);

  // marking as junk resets new but not unread
  testCounts(false, 1, 0, 0);
  Assert.equal(gHeader.getStringProperty("junkscore"), "100");
  Assert.equal(gHeader.getStringProperty("junkscoreorigin"), "filter");
});

// The remaining tests add new messages
add_task(async function MarkUnread() {
  gAction.type = Ci.nsMsgFilterAction.MarkUnread;
  await setupTest(gFilter, gAction);

  testCounts(true, 1, 1, 1);
  Assert.ok(!gHeader.isRead);
});

add_task(async function MarkUnreadBody() {
  gAction.type = Ci.nsMsgFilterAction.MarkUnread;
  await setupTest(gBodyFilter, gAction);

  testCounts(true, 1, 1, 1);
  Assert.ok(!gHeader.isRead);
});

add_task(async function WatchThread() {
  gAction.type = Ci.nsMsgFilterAction.WatchThread;
  await setupTest(gFilter, gAction);

  testCounts(true, 1, 1, 1);
  const thread = db().getThreadContainingMsgHdr(gHeader);
  Assert.notEqual(0, thread.flags & Ci.nsMsgMessageFlags.Watched);
});

add_task(async function WatchThreadBody() {
  gAction.type = Ci.nsMsgFilterAction.WatchThread;
  await setupTest(gBodyFilter, gAction);

  testCounts(true, 1, 1, 1);
  const thread = db().getThreadContainingMsgHdr(gHeader);
  Assert.notEqual(0, thread.flags & Ci.nsMsgMessageFlags.Watched);
});

add_task(async function MarkFlagged() {
  gAction.type = Ci.nsMsgFilterAction.MarkFlagged;
  await setupTest(gFilter, gAction);

  testCounts(true, 1, 1, 1);
  Assert.ok(gHeader.isFlagged);
});

add_task(async function MarkFlaggedBody() {
  gAction.type = Ci.nsMsgFilterAction.MarkFlagged;
  await setupTest(gBodyFilter, gAction);

  testCounts(true, 1, 1, 1);
  Assert.ok(gHeader.isFlagged);
});

add_task(async function ChangePriority() {
  gAction.type = Ci.nsMsgFilterAction.ChangePriority;
  gAction.priority = Ci.nsMsgPriority.highest;
  await setupTest(gFilter, gAction);

  testCounts(true, 1, 1, 1);
  Assert.equal(Ci.nsMsgPriority.highest, gHeader.priority);
});

add_task(async function ChangePriorityBody() {
  gAction.type = Ci.nsMsgFilterAction.ChangePriority;
  gAction.priority = Ci.nsMsgPriority.highest;
  await setupTest(gBodyFilter, gAction);

  testCounts(true, 1, 1, 1);
  Assert.equal(Ci.nsMsgPriority.highest, gHeader.priority);
});

add_task(async function AddTag() {
  gAction.type = Ci.nsMsgFilterAction.AddTag;
  gAction.strValue = "TheTag";
  await setupTest(gFilter, gAction);

  testCounts(true, 1, 1, 1);
  Assert.equal(gHeader.getStringProperty("keywords"), "thetag");
});

add_task(async function AddTagBody() {
  gAction.type = Ci.nsMsgFilterAction.AddTag;
  gAction.strValue = "TheTag2";
  await setupTest(gBodyFilter, gAction);

  testCounts(true, 1, 1, 1);
  Assert.equal(gHeader.getStringProperty("keywords"), "thetag2");
});

// this tests for marking message as good

add_task(async function JunkScoreAsGood() {
  gAction.type = Ci.nsMsgFilterAction.JunkScore;
  gAction.junkScore = 0;
  await setupTest(gFilter, gAction);

  testCounts(true, 1, 1, 1);
  Assert.equal(gHeader.getStringProperty("junkscore"), "0");
  Assert.equal(gHeader.getStringProperty("junkscoreorigin"), "filter");
});

// this tests for marking message as good
add_task(async function JunkScoreAsGoodBody() {
  gAction.type = Ci.nsMsgFilterAction.JunkScore;
  gAction.junkScore = 0;
  await setupTest(gBodyFilter, gAction);

  testCounts(true, 1, 1, 1);
  Assert.equal(gHeader.getStringProperty("junkscore"), "0");
  Assert.equal(gHeader.getStringProperty("junkscoreorigin"), "filter");
});

add_task(async function CopyToFolder() {
  gAction.type = Ci.nsMsgFilterAction.CopyToFolder;
  gAction.targetFolderUri = gSubfolder.URI;
  gInboxCount = folderCount(IMAPPump.inbox);
  gSubfolderCount = folderCount(gSubfolder);
  await setupTest(gFilter, gAction);

  testCounts(true, 1, 1, 1);
  Assert.equal(gInboxCount + 1, folderCount(IMAPPump.inbox));
  Assert.equal(gSubfolderCount + 1, folderCount(gSubfolder));
});

add_task(async function CopyToFolderBody() {
  gAction.type = Ci.nsMsgFilterAction.CopyToFolder;
  gAction.targetFolderUri = gSubfolder.URI;
  gInboxCount = folderCount(IMAPPump.inbox);
  gSubfolderCount = folderCount(gSubfolder);
  await setupTest(gBodyFilter, gAction);

  testCounts(true, 1, 1, 1);
  Assert.equal(gInboxCount + 1, folderCount(IMAPPump.inbox));
  Assert.equal(gSubfolderCount + 1, folderCount(gSubfolder));
});

add_task(async function ForwardInline() {
  await testForward(2);
});

add_task(async function ForwardAsAttachment() {
  await testForward(0);
});

add_task(async function ForwardDisabled() {
  Services.prefs.setBoolPref("mail.filters.forward.enabled", false);

  try {
    gSmtpServerD.resetTest();

    gAction.type = Ci.nsMsgFilterAction.Forward;
    gAction.strValue = "to@local";

    const markReadAction = gFilter.createAction();
    markReadAction.type = Ci.nsMsgFilterAction.MarkRead;

    await setupTest(gFilter, gAction, markReadAction);

    Assert.ok(
      !gSmtpServerD._daemon.post,
      "SMTP should not receive a message when filter forwarding is disabled"
    );
    Assert.ok(
      gHeader.isRead,
      "Filter actions after the blocked forwarding action should still execute"
    );
  } finally {
    Services.prefs.clearUserPref("mail.filters.forward.enabled");
  }
});

function setupFilters() {
  // Create a non-body filter.
  const filterList = IMAPPump.incomingServer.getFilterList(null);
  gFilter = filterList.createFilter("subject");
  let searchTerm = gFilter.createTerm();
  searchTerm.attrib = Ci.nsMsgSearchAttrib.Subject;
  searchTerm.op = Ci.nsMsgSearchOp.Is;
  var value = searchTerm.value;
  value.attrib = Ci.nsMsgSearchAttrib.Subject;
  value.str = gMessageSubject;
  searchTerm.value = value;
  searchTerm.booleanAnd = false;
  gFilter.appendTerm(searchTerm);
  gFilter.enabled = true;

  // Create a filter with a body term that that forces delayed application of
  // filters until after body download.
  gBodyFilter = filterList.createFilter("body");
  searchTerm = gBodyFilter.createTerm();
  searchTerm.attrib = Ci.nsMsgSearchAttrib.Body;
  searchTerm.op = Ci.nsMsgSearchOp.Contains;
  value = searchTerm.value;
  value.attrib = Ci.nsMsgSearchAttrib.Body;
  value.str = gMessageInBody;
  searchTerm.value = value;
  searchTerm.booleanAnd = false;
  gBodyFilter.appendTerm(searchTerm);
  gBodyFilter.enabled = true;

  // an action that can be modified by tests
  gAction = gFilter.createAction();

  gSubfolder = localAccountUtils.rootFolder.createLocalSubfolder("Subfolder");

  MailServices.mailSession.AddFolderListener(
    FolderListener,
    Ci.nsIFolderListener.event
  );
  gPreviousUnread = 0;

  // When a message body is not downloaded, and then later a filter is
  //   applied that requires a download of message bodies, then the previous
  //   bodies are downloaded - and the message filters are applied twice!
  //   See bug 1116228, but for now workaround by always downloading bodies.
  IMAPPump.incomingServer.downloadBodiesOnGetNewMail = true;
}

/*
 * functions used to support test setup and execution
 */

// basic preparation done for each test
async function setupTest(aFilter, ...aActions) {
  const filterList = IMAPPump.incomingServer.getFilterList(null);
  while (filterList.filterCount) {
    filterList.removeFilterAt(0);
  }
  if (aFilter) {
    aFilter.clearActionList();
    for (const action of aActions) {
      aFilter.appendAction(action);
    }
    if (aActions.length) {
      filterList.insertFilterAt(0, aFilter);
    }
  }
  if (gInboxDatabase && gInboxListener) {
    gInboxDatabase.removeListener(gInboxListener);
    gInboxDatabase = null;
  } else if (gInboxListener) {
    gDbService.unregisterPendingListener(gInboxListener);
  }

  IMAPPump.inbox.clearNewMessages();

  gInboxListener = new DBListener();
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    gInboxDatabase = IMAPPump.inbox.msgDatabase;
    gInboxDatabase.addListener(gInboxListener);
  } else {
    gDbService.registerPendingListener(IMAPPump.inbox, gInboxListener);
  }
  gIncomingUid = IMAPPump.mailbox.uidnext++;
  IMAPPump.mailbox.addMessage(
    new ImapMessage(specForFileName(gMessage), gIncomingUid, [])
  );
  const promiseUrlListener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.updateFolderWithListener(null, promiseUrlListener);
  await promiseUrlListener.promise;
  await PromiseTestUtils.promiseDelay(200);
}

/*
 * listener objects
 */

/** @implements {nsIFolderListener} */
var FolderListener = {
  onFolderEvent(aEventFolder, aEvent) {
    dump(
      "received folder event " + aEvent + " folder " + aEventFolder.name + "\n"
    );
  },
};

/**
 * Counts of calls are kept, but not currently used in the tests. Current role
 * is to provide a reference to the new message header.
 *
 * @implements {nsIDBChangeListener}
 */
function DBListener() {
  this.counts = {};
  const counts = this.counts;
  counts.onHdrFlagsChanged = 0;
  counts.onHdrDeleted = 0;
  counts.onHdrAdded = 0;
  counts.onParentChanged = 0;
  counts.onAnnouncerGoingAway = 0;
  counts.onReadChanged = 0;
  counts.onJunkScoreChanged = 0;
  counts.onHdrPropertyChanged = 0;
  counts.onEvent = 0;
}

DBListener.prototype = {
  onHdrFlagsChanged() {
    this.counts.onHdrFlagsChanged++;
  },

  onHdrDeleted() {
    this.counts.onHdrDeleted++;
  },

  onHdrAdded(aHdrChanged) {
    this.counts.onHdrAdded++;
    gHeader = aHdrChanged;
    if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
      Assert.equal(gHeader.getUint32Property("uidOnServer"), gIncomingUid);
      Assert.notEqual(gHeader.messageKey, gIncomingUid);
      Assert.ok(gInboxDatabase.containsKey(gHeader.messageKey));
      this.lastAdded = {
        key: gHeader.messageKey,
        uid: gHeader.getUint32Property("uidOnServer"),
      };
    }
  },

  onParentChanged() {
    this.counts.onParentChanged++;
  },

  onAnnouncerGoingAway() {
    if (gInboxListener) {
      try {
        (gInboxDatabase || IMAPPump.inbox.msgDatabase).removeListener(
          gInboxListener
        );
        gInboxDatabase = null;
      } catch (e) {
        dump(" listener not found\n");
      }
    }
    this.counts.onAnnouncerGoingAway++;
  },

  onReadChanged() {
    this.counts.onReadChanged++;
  },

  onJunkScoreChanged() {
    this.counts.onJunkScoreChanged++;
  },

  onHdrPropertyChanged() {
    this.counts.onHdrPropertyChanged++;
  },

  onEvent() {
    this.counts.onEvent++;
  },
};

/*
 * helper functions
 */

// return the number of messages in a folder (and check that the
// folder counts match the database counts)
function folderCount(folder) {
  // count using the database
  const dbCount = [...folder.msgDatabase.enumerateMessages()].length;

  // count using the folder
  const count = folder.getTotalMessages(false);

  // compare the two
  Assert.equal(dbCount, count);
  return dbCount;
}

// given a test file, return the file uri spec
function specForFileName(aFileName) {
  const file = do_get_file("../../../data/" + aFileName);
  const msgfileuri = Services.io.newFileURI(file).QueryInterface(Ci.nsIFileURL);
  return msgfileuri.spec;
}

// shorthand for the inbox message summary database
function db() {
  return IMAPPump.inbox.msgDatabase;
}

// static variables used in testCounts
var gPreviousUnread = 0;

// Test various counts.
//
//  aHasNew:         folder hasNew flag
//  aUnreadDelta:    change in unread count for the folder
//  aFolderNewDelta: change in new count for the folder
//  aDbNewDelta:     change in new count for the database
//
function testCounts(aHasNew, aUnreadDelta, aFolderNewDelta, aDbNewDelta) {
  const folderNew = IMAPPump.inbox.getNumNewMessages(false);
  const hasNew = IMAPPump.inbox.hasNewMessages;
  const unread = IMAPPump.inbox.getNumUnread(false);
  const arrayOut = db().getNewList();
  const dbNew = arrayOut.length;
  dump(
    " hasNew: " +
      hasNew +
      " unread: " +
      unread +
      " folderNew: " +
      folderNew +
      " dbNew: " +
      dbNew +
      " prevUnread " +
      gPreviousUnread +
      "\n"
  );
  Assert.equal(aHasNew, hasNew);
  Assert.equal(aUnreadDelta, unread - gPreviousUnread);
  gPreviousUnread = unread;
  // This seems to be reset for each folder update.
  //
  // This check seems to be failing in SeaMonkey builds, yet I can see no ill
  // effects of this in the actual program. Fixing this is complex because of
  // the messiness of new count management (see bug 507638 for a
  // refactoring proposal, and attachment 398899 on bug 514801 for one possible
  // fix to this particular test). So I am disabling this.
  // Assert.equal(aFolderNewDelta, folderNew);
  Assert.equal(aDbNewDelta, dbNew);
}

/**
 * Test that Ci.nsMsgFilterAction.Forward works.
 *
 * @param {number} mode - 0 means forward as attachment, 2 means forward inline.
 */
async function testForward(mode) {
  Services.prefs.setIntPref("mail.forward_message_mode", mode);

  gSmtpServerD.resetTest();
  gAction.type = Ci.nsMsgFilterAction.Forward;
  gAction.strValue = "to@local";
  await setupTest(gFilter, gAction);

  await TestUtils.waitForCondition(
    () => gSmtpServerD._daemon.post,
    "waiting for smtp to receive data"
  );

  const msgData = gSmtpServerD._daemon.post;
  Assert.ok(msgData.includes(`Subject: Fwd: ${gMessageSubject}`));
  Assert.ok(msgData.includes(`${gMessageInBody}`));
}

add_task(async function test_nativeHeaderDeleteWithoutTrash() {
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    await checkNativeDeleteWithoutTrash(false);
  }
});

add_task(async function test_nativeBodyDeleteWithoutTrash() {
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    await checkNativeDeleteWithoutTrash(true);
  }
});

/**
 * Checks a plain Delete against its physical source and actual server command.
 *
 * @param {boolean} needsBody - Whether the filter requires the finished body.
 * @returns {Promise<void>} Resolves after deletion and repeated synchronization.
 */
async function checkNativeDeleteWithoutTrash(needsBody) {
  const inbox = IMAPPump.inbox;
  const server = IMAPPump.incomingServer;
  const oldDeleteModel = server.deleteModel;
  const oldFolderBiff = inbox.performingBiff;
  const oldServerBiff = server.performingBiff;
  const commands = () => {
    const transaction = IMAPPump.server.playTransaction();
    return (Array.isArray(transaction) ? transaction : [transaction])
      .flatMap(item => item.them)
      .map(command => command.toUpperCase());
  };
  const start = commands().length;
  const uid = IMAPPump.mailbox.uidnext;
  const deletes = () =>
    commands()
      .slice(start)
      .filter(
        command =>
          command.includes("UID STORE") && command.includes("\\DELETED")
      );
  const headerFetches = () =>
    commands()
      .slice(start)
      .filter(
        command =>
          command.includes("UID FETCH") && command.includes("BODY.PEEK[HEADER")
      );
  try {
    server.deleteModel = Ci.nsMsgImapDeleteModels.IMAPDelete;
    inbox.performingBiff = true;
    gAction.type = Ci.nsMsgFilterAction.Delete;
    await setupTest(needsBody ? gBodyFilter : gFilter, gAction);
    const source = gHeader;
    const key = source.messageKey;
    Assert.equal(gIncomingUid, uid);
    Assert.equal(source.getUint32Property("uidOnServer"), uid);
    Assert.notEqual(key, uid);
    Assert.ok(inbox.msgDatabase.containsKey(key));
    Assert.ok(source.flags & Ci.nsMsgMessageFlags.IMAPDeleted);
    Assert.ok(source.isRead);
    Assert.ok(!(source.flags & Ci.nsMsgMessageFlags.New));
    Assert.equal(inbox.getNumNewMessages(false), 0);
    Assert.equal(inbox.hasNewMessages, false);
    if (needsBody) {
      Assert.ok(source.flags & Ci.nsMsgMessageFlags.Offline);
    }
    const message = IMAPPump.mailbox._messages.find(item => item.uid == uid);
    Assert.ok(message);
    await TestUtils.waitForCondition(
      () => message.flags.includes("\\Deleted"),
      "the actual source UID receives the deleted flag"
    );
    Assert.equal(deletes().length, 1);
    Assert.ok(deletes()[0].includes(`UID STORE ${uid} `));
    const fetched = headerFetches().length;
    Assert.equal(fetched, 1);
    for (let i = 0; i < 2; i++) {
      const listener = new PromiseTestUtils.PromiseUrlListener();
      inbox.updateFolderWithListener(null, listener);
      await listener.promise;
      Assert.ok(inbox.msgDatabase.containsKey(key));
      Assert.equal(
        inbox.msgDatabase.getMsgHdrForKey(key).getUint32Property("uidOnServer"),
        uid
      );
      Assert.equal(inbox.getNumNewMessages(false), 0);
    }
    Assert.equal(headerFetches().length, fetched);
    Assert.equal(deletes().length, 1);
    Assert.equal(
      IMAPPump.mailbox._messages.find(item => item.uid == uid),
      message
    );
  } finally {
    server.deleteModel = oldDeleteModel;
    inbox.performingBiff = oldFolderBiff;
    server.performingBiff = oldServerBiff;
  }
}

add_task(async function test_nativeMissingMoveTargetDisablesAndRecovers() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    return;
  }
  const inbox = IMAPPump.inbox;
  const root = IMAPPump.incomingServer.rootFolder;
  const commands = () => {
    const transaction = IMAPPump.server.playTransaction();
    return (Array.isArray(transaction) ? transaction : [transaction])
      .flatMap(item => item.them)
      .map(command => command.toUpperCase());
  };
  const rowsForUid = uid =>
    Array.from(inbox.msgDatabase.enumerateMessages()).filter(
      header => header.getUint32Property("uidOnServer") == uid
    );
  for (const needsBody of [false, true]) {
    const filter = needsBody ? gBodyFilter : gFilter;
    const target =
      root.URI +
      (needsBody
        ? "/missing-body-filter-target"
        : "/missing-header-filter-target");
    Assert.equal(MailServices.folderLookup.getFolderForURL(target), null);
    const start = commands().length;
    const uid = IMAPPump.mailbox.uidnext;
    const sourceDataURI = specForFileName(gMessage);
    const sourceText = new ImapMessage(sourceDataURI, uid, []).getText();
    gAction.type = Ci.nsMsgFilterAction.MoveToFolder;
    gAction.targetFolderUri = target;
    // setupTest supplies the same retained file/UID through the real producer.
    await Assert.rejects(
      setupTest(filter, gAction),
      error => Number(error.message) === Cr.NS_MSG_NOT_A_MAIL_FOLDER
    );
    Assert.equal(gIncomingUid, uid);
    const actualSource = IMAPPump.mailbox._messages.find(
      message => message.uid == uid
    );
    Assert.ok(actualSource);
    Assert.equal(actualSource._URI, sourceDataURI);
    Assert.equal(actualSource.getText(), sourceText);
    Assert.ok(!actualSource.flags.includes("\\Deleted"));
    Assert.equal(filter.enabled, false);
    const list = IMAPPump.incomingServer.getFilterList(null);
    Assert.ok(list.defaultFile.exists());
    const saved = MailServices.filters.OpenFilterList(
      list.defaultFile,
      root,
      null
    );
    const savedFilter = saved.getFilterNamed(filter.filterName);
    Assert.ok(savedFilter);
    Assert.equal(savedFilter.enabled, false);
    Assert.equal(savedFilter.getActionAt(0).targetFolderUri, target);
    const initialRows = rowsForUid(uid);
    Assert.equal(initialRows.length, needsBody ? 1 : 0);
    const originalKey = needsBody ? initialRows[0].messageKey : null;
    if (needsBody) {
      Assert.ok(initialRows[0].flags & Ci.nsMsgMessageFlags.Offline);
    }
    const headerFetches = () =>
      commands()
        .slice(start)
        .filter(
          command =>
            command.includes("UID FETCH") &&
            command.includes("BODY.PEEK[HEADER")
        ).length;
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = headerFetches();
      const listener = new PromiseTestUtils.PromiseUrlListener();
      inbox.updateFolderWithListener(null, listener);
      await listener.promise;
      const rows = rowsForUid(uid);
      Assert.equal(rows.length, 1);
      Assert.notEqual(rows[0].messageKey, uid);
      if (needsBody) {
        Assert.equal(rows[0].messageKey, originalKey);
        Assert.ok(rows[0].flags & Ci.nsMsgMessageFlags.Offline);
      }
      Assert.equal(
        headerFetches() - before,
        !needsBody && attempt == 0 ? 1 : 0
      );
      Assert.equal(
        IMAPPump.mailbox._messages.find(message => message.uid == uid),
        actualSource
      );
    }
    const nextUid = IMAPPump.mailbox.uidnext++;
    gIncomingUid = nextUid;
    IMAPPump.mailbox.addMessage(
      new ImapMessage(specForFileName(gMessage), nextUid, [])
    );
    const later = new PromiseTestUtils.PromiseUrlListener();
    inbox.updateFolderWithListener(null, later);
    await later.promise;
    Assert.equal(rowsForUid(uid).length, 1);
    Assert.equal(actualSource.getText(), sourceText);
    Assert.equal(rowsForUid(nextUid).length, 1);
    Assert.notEqual(rowsForUid(nextUid)[0].messageKey, nextUid);
    Assert.equal(MailServices.folderLookup.getFolderForURL(target), null);
    Assert.ok(
      !commands()
        .slice(start)
        .some(
          command =>
            command.includes("UID MOVE") ||
            command.includes("UID COPY") ||
            (command.includes("UID STORE") && command.includes("\\DELETED"))
        )
    );
  }
});

add_task(async function test_nativeExistingThreadActions() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    return;
  }
  const inbox = IMAPPump.inbox;
  const database = inbox.msgDatabase;
  const list = IMAPPump.incomingServer.getFilterList(null);
  const rowsForUid = uid =>
    Array.from(database.enumerateMessages()).filter(
      header => header.getUint32Property("uidOnServer") == uid
    );
  const clearFilters = () => {
    while (list.filterCount) {
      list.removeFilterAt(0);
    }
  };
  const sync = async () => {
    const listener = new PromiseTestUtils.PromiseUrlListener();
    inbox.updateFolderWithListener(null, listener);
    await listener.promise;
    await PromiseTestUtils.promiseDelay(200);
  };
  const inject = (id, parentId = null) => {
    const uid = IMAPPump.mailbox.uidnext++;
    const source = [
      "From: sender@example.invalid",
      "To: recipient@example.invalid",
      "Date: Sun, 1 Nov 2026 12:00:00 +0000",
      `Message-ID: <${id}>`,
      ...(parentId ? [`References: <${parentId}>`] : []),
      `Subject: ${gMessageSubject}`,
      "",
      gMessageInBody,
      "",
    ].join("\r\n");
    gIncomingUid = uid;
    const message = new ImapMessage(
      "data:text/plain;base64," + btoa(source),
      uid,
      []
    );
    IMAPPump.mailbox.addMessage(message);
    return { uid, message };
  };
  const added = gInboxListener.onHdrAdded;
  try {
    for (const needsBody of [false, true]) {
      clearFilters();
      const parentId = `native-filter-parent-${needsBody}@example.invalid`;
      const parentInput = inject(parentId);
      await sync();
      const parentRows = rowsForUid(parentInput.uid);
      Assert.equal(parentRows.length, 1);
      const parent = parentRows[0];
      Assert.notEqual(parent.messageKey, parentInput.uid);
      const threadKey = database.getThreadContainingMsgHdr(parent).threadKey;
      let children = 1;
      for (const type of [
        Ci.nsMsgFilterAction.KillThread,
        Ci.nsMsgFilterAction.WatchThread,
        Ci.nsMsgFilterAction.KillThread,
      ]) {
        const flag =
          type == Ci.nsMsgFilterAction.KillThread
            ? Ci.nsMsgMessageFlags.Ignored
            : Ci.nsMsgMessageFlags.Watched;
        const opposite =
          type == Ci.nsMsgFilterAction.KillThread
            ? Ci.nsMsgMessageFlags.Watched
            : Ci.nsMsgMessageFlags.Ignored;
        clearFilters();
        const filter = needsBody ? gBodyFilter : gFilter;
        filter.enabled = true;
        filter.clearActionList();
        gAction.type = type;
        filter.appendAction(gAction);
        list.insertFilterAt(0, filter);
        let publications = 0;
        gInboxListener.onHdrAdded = function (header) {
          added.call(this, header);
          publications++;
          if (!needsBody) {
            Assert.ok(database.getThreadContainingMsgHdr(header).flags & flag);
            Assert.equal(header.getUint32Property("ProtoThreadFlags"), 0);
          }
        };
        const input = inject(
          `native-filter-reply-${needsBody}-${children}@example.invalid`,
          parentId
        );
        await sync();
        const rows = rowsForUid(input.uid);
        Assert.equal(rows.length, 1);
        const reply = rows[0];
        Assert.equal(publications, 1);
        Assert.notEqual(reply.messageKey, input.uid);
        Assert.equal(reply.numReferences, 1);
        Assert.equal(reply.getStringReference(0), parentId);
        const thread = database.getThreadContainingMsgHdr(reply);
        Assert.equal(thread.threadKey, threadKey);
        Assert.equal(thread.numChildren, ++children);
        Assert.ok(thread.flags & flag);
        Assert.equal(thread.flags & opposite, 0);
        Assert.equal(reply.getUint32Property("ProtoThreadFlags"), 0);
        if (needsBody) {
          Assert.ok(reply.flags & Ci.nsMsgMessageFlags.Offline);
        }
        if (type == Ci.nsMsgFilterAction.KillThread) {
          Assert.ok(reply.isRead);
        }
        Assert.equal(
          IMAPPump.mailbox._messages.find(item => item.uid == input.uid),
          input.message
        );
        Assert.ok(!input.message.flags.includes("\\Deleted"));
        await sync();
        Assert.equal(rowsForUid(input.uid).length, 1);
        Assert.equal(rowsForUid(input.uid)[0].messageKey, reply.messageKey);
        Assert.equal(publications, 1);
        gInboxListener.onHdrAdded = added;
      }
    }
  } finally {
    gInboxListener.onHdrAdded = added;
    clearFilters();
  }
});
