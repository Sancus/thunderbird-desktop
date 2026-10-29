/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var { ExtensionSupport } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
var { localAccountUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/LocalAccountUtils.sys.mjs"
);
// Import the smtp server scripts
var { nsMailServer } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/Maild.sys.mjs"
);
var { SmtpDaemon, SMTP_RFC2821_handler } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/Smtpd.sys.mjs"
);
var { AuthPLAIN, AuthLOGIN, AuthCRAM } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/Auth.sys.mjs"
);

// Setup the daemon and server
function setupServerDaemon(handler) {
  if (!handler) {
    handler = function (d) {
      return new SMTP_RFC2821_handler(d);
    };
  }
  const server = new nsMailServer(handler, new SmtpDaemon());
  return server;
}

function getBasicSmtpServer(port = 1, hostname = "localhost") {
  const server = localAccountUtils.create_outgoing_server(
    "smtp",
    "user",
    "password",
    { port, hostname }
  );

  return server;
}

function getSmtpIdentity(senderName, smtpServer) {
  // Set up the identity.
  const identity = MailServices.accounts.createIdentity();
  identity.email = senderName;
  identity.smtpServerKey = smtpServer.key;

  return identity;
}

let gServer, gLocalRootFolder, gPopAccount, gLocalAccount;

add_setup(async () => {
  // Override the default greeting so we get something predictable
  // in the EHLO message.
  await SpecialPowers.pushPrefEnv({
    set: [["mail.smtpserver.default.hello_argument", "test"]],
  });

  gServer = setupServerDaemon();
  gServer.start();

  // Test needs a non-local default account to be able to send messages.
  gPopAccount = createAccount("pop3");
  gLocalAccount = createAccount("local");
  MailServices.accounts.defaultAccount = gPopAccount;

  const identity = getSmtpIdentity(
    "identity@foo.invalid",
    getBasicSmtpServer(gServer.port)
  );
  gPopAccount.addIdentity(identity);
  gPopAccount.defaultIdentity = identity;

  // Test is using the Sent folder and Outbox folder of the local account.
  gLocalRootFolder = gLocalAccount.incomingServer.rootFolder;
  identity.fccFolderURI = (await createSubfolder(gLocalRootFolder, "Sent")).URI;
  identity.draftsFolderURI = (
    await createSubfolder(gLocalRootFolder, "Drafts")
  ).URI;
  await createSubfolder(gLocalRootFolder, "Fcc");
  MailServices.accounts.setSpecialFolders();

  requestLongerTimeout(4);

  registerCleanupFunction(() => {
    gServer.stop();
  });
});

// Helper function to test saving messages.
async function runTest(testConfig) {
  const files = {
    "background.js": async () => {
      const [config] = await window.sendMessage("getConfig");

      const accounts = await browser.accounts.list();
      browser.test.assertEq(2, accounts.length, "number of accounts");
      const localAccount = accounts.find(a => a.type == "none");
      const fccFolder = localAccount.folders.find(f => f.name == "Fcc");
      browser.test.assertTrue(
        !!fccFolder,
        "should find the additional fcc folder"
      );

      // Prepare test data.
      const allDetails = [];
      for (let i = 0; i < 5; i++) {
        allDetails.push({
          to: [`test${i}@test.invalid`],
          subject: `Test${i} save as ${config.config.mode}`,
          additionalFccFolder:
            config.config.fcc.length > 1 ? fccFolder : undefined,
        });
      }

      // Open multiple compose windows.
      for (const details of allDetails) {
        details.tab = await browser.compose.beginNew(details);
      }

      // Add onAfterSave listener
      const collectedEventsMap = new Map();
      function onAfterSaveListener(tab, info) {
        collectedEventsMap.set(tab.id, info);
      }
      browser.compose.onAfterSave.addListener(onAfterSaveListener);

      // Initiate saving of all compose windows at the same time.
      const allPromises = [];
      for (const details of allDetails) {
        allPromises.push(
          browser.compose.saveMessage(details.tab.id, config.mode)
        );
      }

      // Wait until all messages have been saved.
      const allRv = await Promise.all(allPromises);

      for (let i = 0; i < allDetails.length; i++) {
        const rv = allRv[i];
        const details = allDetails[i];
        // Find the message with a matching headerMessageId.

        browser.test.assertEq(
          config.expected.mode,
          rv.mode,
          "The mode of the last message operation should be correct."
        );
        browser.test.assertEq(
          config.expected.fcc.length,
          rv.messages.length,
          "Should find the correct number of saved messages for this save operation."
        );

        // Check expected FCC folders.
        for (let j = 0; j < config.expected.fcc.length; j++) {
          // Read the actual messages in the fcc folder.
          const savedMessages = await window.sendMessage(
            "getMessagesInFolder",
            `${config.expected.fcc[j]}`
          );
          // Find the currently processed message.
          const savedMessage = savedMessages.find(
            m => m.messageId == rv.messages[j].headerMessageId
          );
          // Compare saved message to original message.
          browser.test.assertEq(
            details.subject,
            savedMessage.subject,
            "The subject of the message in the fcc folder should be correct."
          );

          // Check returned details.
          browser.test.assertEq(
            details.subject,
            rv.messages[j].subject,
            "The subject of the saved message should be correct."
          );
          browser.test.assertEq(
            details.to[0],
            rv.messages[j].recipients[0],
            "The recipients of the saved message should be correct."
          );
          browser.test.assertEq(
            `/${config.expected.fcc[j]}`,
            rv.messages[j].folder.path,
            "The saved message should be in the correct folder."
          );
        }

        const removedWindowPromise = window.waitForEvent("windows.onRemoved");
        browser.tabs.remove(details.tab.id);
        await removedWindowPromise;
      }

      // Check onAfterSave listener
      browser.compose.onAfterSave.removeListener(onAfterSaveListener);
      browser.test.assertEq(
        allDetails.length,
        collectedEventsMap.size,
        "Should have received the correct number of onAfterSave events"
      );
      const collectedEvents = [...collectedEventsMap.values()];
      for (const detail of allDetails) {
        const msg = collectedEvents.find(
          e => e.messages[0].subject == detail.subject
        );
        browser.test.assertTrue(
          msg,
          "Should have received an onAfterSave event for every single message"
        );
      }
      browser.test.assertEq(
        collectedEventsMap.size,
        collectedEvents.filter(e => e.mode == config.expected.mode).length,
        "All events should have the correct mode."
      );

      // Remove all saved messages.
      for (const fcc of config.expected.fcc) {
        await window.sendMessage("clearMessagesInFolder", fcc);
      }

      browser.test.notifyPass("finished");
    },
    "utils.js": await getUtilsJS(),
  };
  const extension = ExtensionTestUtils.loadExtension({
    files,
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["compose", "compose.save", "messagesRead", "accountsRead"],
    },
  });

  extension.onMessage("getConfig", async () => {
    extension.sendMessage(testConfig);
  });

  extension.onMessage("getMessagesInFolder", async folderName => {
    const folder = gLocalRootFolder.getChildNamed(folderName);
    const messages = [...folder.messages].map(m => {
      const { subject, messageId, recipients } = m;
      return { subject, messageId, recipients };
    });
    extension.sendMessage(...messages);
  });

  extension.onMessage("clearMessagesInFolder", async folderName => {
    const folder = gLocalRootFolder.getChildNamed(folderName);
    const messages = [...folder.messages];
    await new Promise(resolve => {
      folder.deleteMessages(
        messages,
        null,
        true,
        false,
        { onStopCopy: resolve },
        false
      );
    });

    Assert.equal(0, [...folder.messages].length, "folder should be empty");
    extension.sendMessage();
  });

  extension.onMessage("checkWindow", async expected => {
    await checkComposeHeaders(expected);
    extension.sendMessage();
  });

  await extension.startup();
  await extension.awaitFinish("finished");
  await extension.unload();
  gServer.resetTest();
}

// Test with default save mode.
add_task(async function test_default() {
  await runTest({
    mode: null,
    config: {
      mode: "draft",
      fcc: ["Drafts"],
    },
    expected: {
      mode: "draft",
      fcc: ["Drafts"],
    },
  });
});

// Test with default save mode and additional fcc.
add_task(async function test_default_with_additional_fcc() {
  await runTest({
    mode: null,
    config: {
      mode: "draft",
      fcc: ["Drafts", "Fcc"],
    },
    // Since Bug 279366 the additional fcc folder is ignored while saving drafts.
    expected: {
      mode: "draft",
      fcc: ["Drafts"],
    },
  });
});

// Test with draft save mode.
add_task(async function test_saveAsDraft() {
  await runTest({
    mode: { mode: "draft" },
    config: {
      mode: "draft",
      fcc: ["Drafts"],
    },
    expected: {
      mode: "draft",
      fcc: ["Drafts"],
    },
  });
});

// Test with draft save mode and additional fcc.
add_task(async function test_saveAsDraft_with_additional_fcc() {
  await runTest({
    mode: { mode: "draft" },
    config: {
      mode: "draft",
      fcc: ["Drafts", "Fcc"],
    },
    // Since Bug 279366 the additional fcc folder is ignored while saving drafts.
    expected: {
      mode: "draft",
      fcc: ["Drafts"],
    },
  });
});

// Test onAfterSave when saving drafts for MV3
add_task(async function test_onAfterSave_MV3_event_pages() {
  const files = {
    "background.js": async () => {
      // Whenever the extension starts or wakes up, hasFired is set to false. In
      // case of a wake-up, the first fired event is the one that woke up the background.
      let hasFired = false;

      browser.compose.onAfterSave.addListener((tab, saveInfo) => {
        // Only send the first event after background wake-up, this should be
        // the only one expected.
        if (!hasFired) {
          hasFired = true;
          browser.test.sendMessage("onAfterSave received", saveInfo);
        }
      });

      browser.test.sendMessage("background started");
    },
    "utils.js": await getUtilsJS(),
  };
  const extension = ExtensionTestUtils.loadExtension({
    files,
    manifest: {
      manifest_version: 3,
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["compose"],
      browser_specific_settings: {
        gecko: { id: "compose.onAfterSave@xpcshell.test" },
      },
    },
  });

  function checkPersistentListeners({ primed }) {
    // A persistent event is referenced by its moduleName as defined in
    // ext-mails.json, not by its actual namespace.
    const persistent_events = ["compose.onAfterSave"];

    for (const event of persistent_events) {
      const [moduleName, eventName] = event.split(".");
      assertPersistentListeners(extension, moduleName, eventName, {
        primed,
      });
    }
  }

  const composeWindow = await openComposeWindow(gPopAccount);
  await focusWindow(composeWindow);

  await extension.startup();
  await extension.awaitMessage("background started");
  // The listeners should be persistent, but not primed.
  checkPersistentListeners({ primed: false });

  // Trigger onAfterSave without terminating the background first.

  composeWindow.SetComposeDetails({
    to: "first@invalid.net",
    subject: "test_onAfterSave_MV3_event_pages",
  });
  composeWindow.SaveAsDraft();
  const firstSaveInfo = await extension.awaitMessage("onAfterSave received");
  Assert.equal(
    "draft",
    firstSaveInfo.mode,
    "Returned SaveInfo should be correct"
  );
  Assert.deepEqual(
    firstSaveInfo.details,
    {
      from: "identity@foo.invalid",
      to: ["first@invalid.net"],
      cc: [],
      bcc: [],
      type: "new",
      replyTo: [],
      followupTo: [],
      newsgroups: [],
      subject: "test_onAfterSave_MV3_event_pages",
      isPlainText: false,
      body: '<!DOCTYPE html>\n<html><head>\n<meta http-equiv="content-type" content="text/html; charset=UTF-8"></head><body><p><br></p></body></html>',
      plainTextBody: "",
      customHeaders: [],
      priority: "normal",
      returnReceipt: false,
      deliveryStatusNotification: false,
      attachPublicPGPKey: false,
      attachVCard: false,
      isModified: true,
      deliveryFormat: "auto",
    },
    "Returned details in SaveInfo should be correct"
  );

  // Terminate background and re-trigger onAfterSave.

  await extension.terminateBackground({ disableResetIdleForTest: true });
  // The listeners should be primed.
  checkPersistentListeners({ primed: true });

  composeWindow.SetComposeDetails({
    to: "second@invalid.net",
    subject: "test_onAfterSave_MV3_event_pages",
  });
  composeWindow.SaveAsDraft();
  const secondSaveInfo = await extension.awaitMessage("onAfterSave received");
  Assert.equal(
    "draft",
    secondSaveInfo.mode,
    "Returned SaveInfo should be correct"
  );
  Assert.deepEqual(
    secondSaveInfo.details,
    {
      from: "identity@foo.invalid",
      to: ["second@invalid.net"],
      cc: [],
      bcc: [],
      type: "new",
      replyTo: [],
      followupTo: [],
      newsgroups: [],
      subject: "test_onAfterSave_MV3_event_pages",
      isPlainText: false,
      body: '<!DOCTYPE html>\n<html><head>\n<meta http-equiv="content-type" content="text/html; charset=UTF-8"></head><body><p><br></p></body></html>',
      plainTextBody: "",
      customHeaders: [],
      priority: "normal",
      returnReceipt: false,
      deliveryStatusNotification: false,
      attachPublicPGPKey: false,
      attachVCard: false,
      isModified: true,
      deliveryFormat: "auto",
    },
    "Returned details in SaveInfo should be correct again"
  );

  // The background should have been restarted.
  await extension.awaitMessage("background started");
  // The listener should no longer be primed.
  checkPersistentListeners({ primed: false });

  await extension.unload();
  composeWindow.close();
});

/**
 * Reject a failed or cancelled save, then save through the real store path.
 *
 * @param {"progress"|"abort"} failure - Existing completion callback to fail.
 * @param {"draft"|"template"} [mode="draft"] - The saved message type.
 * @returns {Promise<void>} Resolves after failure, retry and replacement checks.
 */
async function checkSaveFailure(failure, mode = "draft") {
  const subject = `${mode} recovery after ${failure}`;
  const folderName = mode == "template" ? "Templates" : "Drafts";
  const identity = gPopAccount.defaultIdentity;
  const oldTemplatesURI = identity.templatesFolderURI;
  if (mode == "template") {
    const folder = gLocalRootFolder.containsChildNamed(folderName)
      ? gLocalRootFolder.getChildNamed(folderName)
      : await createSubfolder(gLocalRootFolder, folderName);
    identity.templatesFolderURI = folder.URI;
    folder.setFlag(Ci.nsMsgFolderFlags.Templates);
  }
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const [
          {
            subject: savedSubject,
            mode: saveMode,
            folderName: savedFolderName,
          },
        ] = await window.sendMessage("getConfig");
        const [before] = await window.sendMessage("getStoredMessages");
        const tab = await browser.compose.beginNew({
          to: ["save-recovery@example.invalid"],
          subject: savedSubject,
        });
        await window.sendMessage("failNextSave");
        const failureEvent = window.waitForEvent("compose.onAfterSave");
        await browser.test.assertRejects(
          browser.compose.saveMessage(tab.id, { mode: saveMode }),
          /Message operation failed/,
          "The failed save rejects instead of returning an empty success"
        );
        const [failedTab, failureInfo] = await failureEvent;
        browser.test.assertEq(tab.id, failedTab.id);
        browser.test.assertEq(saveMode, failureInfo.mode);
        browser.test.assertEq("Message operation failed", failureInfo.error);
        browser.test.assertEq(0, failureInfo.messages.length);
        const [afterFailure] = await window.sendMessage("getStoredMessages");
        browser.test.assertDeepEq(
          before,
          afterFailure,
          "Failure before storage leaves every original physical draft intact"
        );

        const successEvent = window.waitForEvent("compose.onAfterSave");
        const saved = await browser.compose.saveMessage(tab.id, {
          mode: saveMode,
        });
        const [savedTab, successInfo] = await successEvent;
        browser.test.assertEq(tab.id, savedTab.id);
        browser.test.assertEq(saveMode, saved.mode);
        browser.test.assertEq(1, saved.messages.length);
        browser.test.assertEq(undefined, successInfo.error);
        browser.test.assertDeepEq(saved.messages, successInfo.messages);
        const [current] = await window.sendMessage("getStoredMessages");
        browser.test.assertEq(before.length + 1, current.length);
        const stored = current.filter(
          message => message.subject == savedSubject
        );
        browser.test.assertEq(1, stored.length);
        browser.test.assertEq(
          saved.messages[0].headerMessageId,
          stored[0].messageId,
          "The successful result identifies the actual stored message"
        );
        browser.test.assertEq(
          `/${savedFolderName}`,
          saved.messages[0].folder.path
        );
        browser.test.assertDeepEq(
          before,
          current.filter(message => message.subject != savedSubject),
          "The retry preserves the original physical drafts"
        );
        const fetched = await browser.messages.get(saved.messages[0].id);
        browser.test.assertEq(savedSubject, fetched.subject);
        browser.test.assertEq(saved.messages[0].folder.id, fetched.folder.id);

        const updatedSubject = savedSubject + " updated";
        await browser.compose.setComposeDetails(tab.id, {
          subject: updatedSubject,
        });
        const replacementEvent = window.waitForEvent("compose.onAfterSave");
        const replacement = await browser.compose.saveMessage(tab.id, {
          mode: saveMode,
        });
        const [replacementTab, replacementInfo] = await replacementEvent;
        browser.test.assertEq(tab.id, replacementTab.id);
        browser.test.assertEq(saveMode, replacement.mode);
        browser.test.assertEq(1, replacement.messages.length);
        browser.test.assertDeepEq(
          replacement.messages,
          replacementInfo.messages
        );
        const [afterReplacement] =
          await window.sendMessage("getStoredMessages");
        browser.test.assertEq(before.length + 1, afterReplacement.length);
        browser.test.assertFalse(
          afterReplacement.some(message => message.key == stored[0].key),
          "The replaced physical message has been removed"
        );
        browser.test.assertDeepEq(
          before,
          afterReplacement.filter(message => message.subject != updatedSubject),
          "Replacement preserves all unrelated physical messages"
        );
        const [updated] = afterReplacement.filter(
          message => message.subject == updatedSubject
        );
        browser.test.assertTrue(!!updated);
        browser.test.assertEq(
          replacement.messages[0].headerMessageId,
          updated.messageId
        );
        browser.test.assertEq(
          `/${savedFolderName}`,
          replacement.messages[0].folder.path
        );
        await browser.test.assertRejects(
          browser.messages.get(saved.messages[0].id),
          /Message not found:/,
          "The replaced API identity no longer resolves"
        );
        const removed = window.waitForEvent("windows.onRemoved");
        await browser.tabs.remove(tab.id);
        await removed;
        browser.test.notifyPass("save-recovery");
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["compose", "compose.save", "messagesRead", "accountsRead"],
    },
  });
  let composeWindow;
  let originalSend;
  let loaded = false;
  const cleanup = async () => {
    if (originalSend && !composeWindow.closed) {
      composeWindow.CompleteGenericSendMessage = originalSend;
    }
    if (composeWindow && !composeWindow.closed) {
      composeWindow.gMsgCompose.bodyModified = false;
      composeWindow.gContentChanged = false;
      composeWindow.close();
    }
    if (loaded) {
      loaded = false;
      await extension.unload();
    }
    identity.templatesFolderURI = oldTemplatesURI;
  };
  registerCleanupFunction(cleanup);
  extension.onMessage("getConfig", () =>
    extension.sendMessage({ subject, mode, folderName })
  );
  extension.onMessage("getStoredMessages", () => {
    const folder = gLocalRootFolder.getChildNamed(folderName);
    extension.sendMessage(
      [...folder.messages]
        .map(header => ({
          key: header.messageKey,
          messageId: header.messageId,
          subject: header.subject,
        }))
        .sort((a, b) => a.key - b.key)
    );
  });
  extension.onMessage("failNextSave", () => {
    composeWindow = [...Services.wm.getEnumerator("msgcompose")].find(
      win => win.gMsgCompose.compFields.subject == subject
    );
    Assert.ok(composeWindow, "The expected compose window exists");
    originalSend = composeWindow.CompleteGenericSendMessage;
    composeWindow.CompleteGenericSendMessage = async () => {
      composeWindow.CompleteGenericSendMessage = originalSend;
      if (failure == "progress") {
        composeWindow.progressListener.onStateChange(
          null,
          null,
          Ci.nsIWebProgressListener.STATE_STOP,
          Cr.NS_ERROR_FAILURE
        );
      } else {
        composeWindow.gMsgCompose.onSendNotPerformed(null, Cr.NS_ERROR_ABORT);
      }
      // Delivery can fail on an earlier turn than preparation completes.
      await TestUtils.waitForTick();
    };
    extension.sendMessage();
  });
  await extension.startup();
  loaded = true;
  await extension.awaitFinish("save-recovery");
  await cleanup();
}

add_task(async function test_save_copy_failure_then_retry() {
  await checkSaveFailure("progress");
});

add_task(async function test_save_not_performed_then_retry() {
  await checkSaveFailure("abort");
});

add_task(async function test_template_copy_failure_then_replace() {
  await checkSaveFailure("progress", "template");
});
