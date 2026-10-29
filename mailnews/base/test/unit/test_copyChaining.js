/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Test of chaining copies between the same folders

var { addMessagesToFolder, MessageGenerator, MessageScenarioFactory } =
  ChromeUtils.importESModule(
    "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
  );

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

var gCopySource;
var gCopyDest;
var gMessages;
var gSourceSnapshots;
var gExpectedDest = [];
var gCurTestNum = 1;

// main test

var gTestArray = [
  function copyMsg1() {
    gMessages = [...gCopySource.msgDatabase.enumerateMessages()];
    gSourceSnapshots = new Map(
      gMessages.map(header => [
        header.messageKey,
        {
          messageId: header.messageId,
          flags: header.flags,
          storeToken: header.storeToken,
          size: header.messageSize,
          raw: mailTestUtils.loadMessageToString(gCopySource, header),
        },
      ])
    );
    CopyNextMessage();
  },
  function copyMsg2() {
    CopyNextMessage();
  },
  function copyMsg3() {
    CopyNextMessage();
  },
  function copyMsg4() {
    CopyNextMessage();
  },
];

function CopyNextMessage() {
  if (gMessages.length > 0) {
    const msgHdr = gMessages.shift();
    gExpectedDest.push(gSourceSnapshots.get(msgHdr.messageKey));
    MailServices.copy.copyMessages(
      gCopySource,
      [msgHdr],
      gCopyDest,
      true,
      copyListener,
      null,
      false
    );
  } else {
    do_throw("TEST FAILED - out of messages");
  }
}

function run_test() {
  localAccountUtils.loadLocalMailAccount();
  registerCleanupFunction(() => localAccountUtils.clearAll());
  const database = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.equal(
    "nsIDatabaseCore" in Ci && database instanceof Ci.nsIDatabaseCore,
    Services.prefs.getBoolPref("mail.panorama.enabled", false)
  );
  const messageGenerator = new MessageGenerator();
  const scenarioFactory = new MessageScenarioFactory(messageGenerator);

  // "Master" do_test_pending(), paired with a do_test_finished() at the end of
  // all the operations.
  do_test_pending();

  gCopyDest = localAccountUtils.inboxFolder.createLocalSubfolder("copyDest");
  // build up a diverse list of messages
  let messages = [];
  messages = messages.concat(scenarioFactory.directReply(10));
  gCopySource = localAccountUtils.rootFolder.createLocalSubfolder("copySource");
  addMessagesToFolder(messages, gCopySource);
  const storeType = Services.prefs
    .getCharPref("mail.serverDefaultStoreContractID")
    .includes("maildirstore")
    ? "maildir"
    : "mbox";
  Assert.equal(gCopySource.msgStore.storeType, storeType);
  Assert.equal(gCopyDest.msgStore.storeType, storeType);
  Assert.equal(localAccountUtils.incomingServer.msgStore.storeType, storeType);

  mailTestUtils.updateFolderAndNotify(gCopySource, doTest);
  return true;
}

function doTest() {
  var test = gCurTestNum;
  if (test <= gTestArray.length) {
    var testFn = gTestArray[test - 1];
    dump("Doing test " + test + " " + testFn.name + "\n");

    try {
      testFn();
    } catch (ex) {
      do_throw("TEST FAILED " + ex);
    }
  } else {
    endTest();
  }
}

/**
 * Check the final moved and retained bodies after the reentrant copy chain.
 */
function endTest() {
  const remaining = [...gCopySource.messages];
  Assert.equal(remaining.length, 6);
  Assert.deepEqual(
    remaining.map(header => header.messageKey).toSorted((a, b) => a - b),
    gMessages.map(header => header.messageKey).toSorted((a, b) => a - b)
  );
  for (const header of remaining) {
    const original = gSourceSnapshots.get(header.messageKey);
    Assert.equal(header.storeToken, original.storeToken);
    Assert.equal(header.flags, original.flags);
    Assert.equal(header.messageSize, original.size);
    Assert.equal(
      mailTestUtils.loadMessageToString(gCopySource, header),
      original.raw
    );
  }
  const copied = [...gCopyDest.messages];
  Assert.equal(copied.length, 4);
  Assert.deepEqual(
    copied.map(header => header.messageId).toSorted(),
    gExpectedDest.map(original => original.messageId).toSorted()
  );
  for (const header of copied) {
    const original = gExpectedDest.find(
      item => item.messageId == header.messageId
    );
    Assert.notEqual(header.storeToken, ""); // Offset zero is a valid mbox token.
    // Mork's New bit comes from the source folder's m_newSet, not its row.
    // Compare stored flags; local destinations never inherit Offline.
    const folderFlags = Ci.nsMsgMessageFlags.New | Ci.nsMsgMessageFlags.Offline;
    Assert.equal(header.flags & ~folderFlags, original.flags & ~folderFlags);
    Assert.ok(!(header.flags & Ci.nsMsgMessageFlags.Offline));
    Assert.equal(header.messageSize, original.size);
    Assert.equal(
      mailTestUtils.loadMessageToString(gCopyDest, header),
      original.raw
    );
  }
  // Cleanup, null out everything
  dump(" Exiting mail tests\n");
  gMessages = null;
  do_test_finished(); // for the one in run_test()
}

/**
 * @implements {nsIMsgCopyServiceListener}
 */
var copyListener = {
  onStartCopy() {},
  onProgress() {},
  setMessageKey() {},
  getMessageId() {
    return null;
  },
  onStopCopy(aStatus) {
    // Check: message successfully copied.
    Assert.equal(aStatus, 0);
    ++gCurTestNum;
    doTest();
  },
};
