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

function tracksentMessages(aSubject, aTopic, aMsgID) {
  // The aMsgID starts with < and ends with > which is not used by the API.
  const headerMessageId = aMsgID.replace(/^<|>$/g, "");
  gSentMessages.push(headerMessageId);
}

let gServer, gOutbox, gPopAccount, gLocalAccount;
const gSentMessages = [];

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
  const rootFolder = gLocalAccount.incomingServer.rootFolder;
  await createSubfolder(rootFolder, "Sent");

  // Test using an additional fcc folder.
  await createSubfolder(rootFolder, "FCC");

  MailServices.accounts.setSpecialFolders();
  gOutbox = rootFolder.getChildNamed("Unsent Messages");

  Services.obs.addObserver(tracksentMessages, "mail:composeSendSucceeded");

  registerCleanupFunction(() => {
    gServer.stop();
    Services.obs.removeObserver(tracksentMessages, "mail:composeSendSucceeded");
  });
});

add_task(async function test_no_permission() {
  const files = {
    "background.js": async () => {
      const details = {
        to: ["send@test.invalid"],
        subject: "Test send",
      };

      // Open a compose window with a message.
      const tab = await browser.compose.beginNew(details);

      // Send now. It should fail due to the missing compose.send permission.
      await browser.test.assertThrows(
        () => browser.compose.sendMessage(tab.id),
        /browser.compose.sendMessage is not a function/,
        "browser.compose.sendMessage() should reject, if the permission compose.send is not granted."
      );

      // Clean up.
      const removedWindowPromise = window.waitForEvent("windows.onRemoved");
      browser.tabs.remove(tab.id);
      await removedWindowPromise;

      browser.test.notifyPass("finished");
    },
    "utils.js": await getUtilsJS(),
  };
  const extension = ExtensionTestUtils.loadExtension({
    files,
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["compose"],
    },
  });

  await extension.startup();
  await extension.awaitFinish("finished");
  await extension.unload();
});

add_task(async function test_fail() {
  const files = {
    "background.js": async () => {
      const details = {
        to: ["send@test.invalid"],
        subject: "Test send",
      };

      // Open a compose window with a message.
      const createdWindowPromise = window.waitForEvent("windows.onCreated");
      await browser.compose.beginNew(details);
      const [createdWindow] = await createdWindowPromise;
      browser.test.assertEq("messageCompose", createdWindow.type);

      await window.sendMessage("checkWindow", details);

      const [tab] = await browser.tabs.query({ windowId: createdWindow.id });

      browser.compose.onBeforeSend.addListener(() => {
        return { cancel: true };
      });

      // Add onAfterSend listener
      const collectedEventsMap = new Map();
      function onAfterSendListener(sendingTab, info) {
        collectedEventsMap.set(sendingTab.id, info);
      }
      browser.compose.onAfterSend.addListener(onAfterSendListener);

      // Send now. It should fail due to the aborting onBeforeSend listener.
      await browser.test.assertRejects(
        browser.compose.sendMessage(tab.id),
        /Send aborted by an onBeforeSend event/,
        "browser.compose.sendMessage() should reject, if the message could not be send."
      );

      // Check onAfterSend listener
      browser.compose.onAfterSend.removeListener(onAfterSendListener);
      browser.test.assertEq(
        1,
        collectedEventsMap.size,
        "Should have received the correct number of onAfterSend events"
      );
      browser.test.assertEq(
        "Send aborted by an onBeforeSend event",
        collectedEventsMap.get(tab.id).error,
        "Should have received the correct error"
      );

      // Clean up.
      const removedWindowPromise = window.waitForEvent("windows.onRemoved");
      browser.windows.remove(createdWindow.id);
      await removedWindowPromise;

      browser.test.notifyPass("finished");
    },
    "utils.js": await getUtilsJS(),
  };
  const extension = ExtensionTestUtils.loadExtension({
    files,
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["compose", "compose.send"],
    },
  });

  extension.onMessage("checkWindow", async expected => {
    await checkComposeHeaders(expected);
    extension.sendMessage();
  });

  extension.onMessage("getSentMessages", async () => {
    extension.sendMessage(gSentMessages);
  });

  await extension.startup();
  await extension.awaitFinish("finished");
  await extension.unload();
});

add_task(async function test_send_with_additional_fcc_and_onAfterSend() {
  const files = {
    "background.js": async () => {
      const [fccFolder] = await browser.folders.query({ name: "FCC" });
      browser.test.assertEq(
        "FCC",
        fccFolder.name,
        "Folder should be found and have the correct name"
      );

      const details = {
        to: ["send@test.invalid"],
        subject: "Test send",
        additionalFccFolder: fccFolder,
      };

      // Open a compose window with a message.
      const createdWindowPromise = window.waitForEvent("windows.onCreated");
      await browser.compose.beginNew(details);
      const [createdWindow] = await createdWindowPromise;
      browser.test.assertEq("messageCompose", createdWindow.type);

      await window.sendMessage("checkWindow", details);

      const [tab] = await browser.tabs.query({ windowId: createdWindow.id });

      // Add onAfterSend listener
      const collectedEventsMap = new Map();
      function onAfterSendListener(sendingTab, info) {
        collectedEventsMap.set(sendingTab.id, info);
      }
      browser.compose.onAfterSend.addListener(onAfterSendListener);

      // Send now.
      const removedWindowPromise = window.waitForEvent("windows.onRemoved");
      const rv = await browser.compose.sendMessage(tab.id);
      const [sentMessages] = await window.sendMessage("getSentMessages");

      browser.test.assertEq(
        1,
        sentMessages.length,
        "Number of total messages sent should be correct."
      );
      browser.test.assertEq(
        "sendNow",
        rv.mode,
        "The mode of the last message operation should be correct."
      );
      browser.test.assertEq(
        sentMessages[0],
        rv.headerMessageId,
        "The headerMessageId of last message sent should be correct."
      );

      // Window should have closed after send.
      await removedWindowPromise;

      // Check onAfterSend listener
      browser.compose.onAfterSend.removeListener(onAfterSendListener);
      browser.test.assertEq(
        1,
        collectedEventsMap.size,
        "Should have received the correct number of onAfterSend events"
      );
      browser.test.assertTrue(
        collectedEventsMap.has(tab.id),
        "The received event should belong to the correct tab."
      );
      browser.test.assertEq(
        "sendNow",
        collectedEventsMap.get(tab.id).mode,
        "The received event should have the correct mode."
      );
      browser.test.assertEq(
        sentMessages[0],
        collectedEventsMap.get(tab.id).headerMessageId,
        "The received event should have the correct headerMessageId."
      );

      const EXPECTED_FOLDERS = ["Sent", "FCC"];
      browser.test.assertEq(
        EXPECTED_FOLDERS.length,
        collectedEventsMap.get(tab.id).messages.length,
        "[onAfterSend] number of send messages should be correct."
      );
      browser.test.assertEq(
        EXPECTED_FOLDERS.length,
        rv.messages.length,
        "[messageSend()] number of send messages should be correct."
      );
      for (let i = 0; i < EXPECTED_FOLDERS.length; i++) {
        browser.test.assertEq(
          sentMessages[0],
          collectedEventsMap.get(tab.id).messages[i].headerMessageId,
          `[onAfterSend] message #${i + 1} should have the correct headerMessageId.`
        );
        browser.test.assertEq(
          EXPECTED_FOLDERS[i],
          collectedEventsMap.get(tab.id).messages[i].folder.name,
          `[onAfterSend] message #${i + 1} should be stored in the correct folder.`
        );
        browser.test.assertEq(
          sentMessages[0],
          rv.messages[i].headerMessageId,
          `[messageSend()] message #${i + 1} should have the correct headerMessageId.`
        );
        browser.test.assertEq(
          EXPECTED_FOLDERS[i],
          rv.messages[i].folder.name,
          `[messageSend()] message #${i + 1} should be stored in the correct folder.`
        );
      }
      browser.test.notifyPass("finished");
    },
    "utils.js": await getUtilsJS(),
  };
  const extension = ExtensionTestUtils.loadExtension({
    files,
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["compose", "compose.send", "messagesRead", "accountsRead"],
    },
  });

  extension.onMessage("checkWindow", async expected => {
    await checkComposeHeaders(expected);
    extension.sendMessage();
  });

  extension.onMessage("getSentMessages", async () => {
    extension.sendMessage(gSentMessages);
  });

  await extension.startup();
  await extension.awaitFinish("finished");
  await extension.unload();
});

add_task(async function test_sendDefault() {
  const files = {
    "background.js": async () => {
      const details = {
        to: ["sendDefault@test.invalid"],
        subject: "Test sendDefault",
      };

      // Open a compose window with a message.
      const createdWindowPromise = window.waitForEvent("windows.onCreated");
      await browser.compose.beginNew(details);
      const [createdWindow] = await createdWindowPromise;
      browser.test.assertEq("messageCompose", createdWindow.type);

      await window.sendMessage("checkWindow", details);

      const [tab] = await browser.tabs.query({ windowId: createdWindow.id });

      // Send via default mode, which should be sendNow.
      const removedWindowPromise = window.waitForEvent("windows.onRemoved");
      const rv = await browser.compose.sendMessage(tab.id, {
        mode: "default",
      });
      const [sentMessages] = await window.sendMessage("getSentMessages");

      browser.test.assertEq(
        2,
        sentMessages.length,
        "Number of total messages sent should be correct."
      );
      browser.test.assertEq(
        "sendNow",
        rv.mode,
        "The mode of the last message operation should be correct."
      );
      browser.test.assertEq(
        sentMessages[1],
        rv.headerMessageId,
        "The headerMessageId of last message sent should be correct."
      );

      // Window should have closed after send.
      await removedWindowPromise;

      const EXPECTED_FOLDERS = ["Sent"];
      browser.test.assertEq(
        EXPECTED_FOLDERS.length,
        rv.messages.length,
        "[messageSend()] number of send messages should be correct."
      );
      for (let i = 0; i < EXPECTED_FOLDERS.length; i++) {
        browser.test.assertEq(
          sentMessages[1],
          rv.messages[i].headerMessageId,
          `[messageSend()] message #${i + 1} should have the correct headerMessageId.`
        );
        browser.test.assertEq(
          EXPECTED_FOLDERS[i],
          rv.messages[i].folder.name,
          `[messageSend()] message #${i + 1} should be stored in the correct folder.`
        );
      }

      browser.test.notifyPass("finished");
    },
    "utils.js": await getUtilsJS(),
  };
  const extension = ExtensionTestUtils.loadExtension({
    files,
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["compose", "compose.send", "messagesRead", "accountsRead"],
    },
  });

  extension.onMessage("checkWindow", async expected => {
    await checkComposeHeaders(expected);
    extension.sendMessage();
  });

  extension.onMessage("getSentMessages", async () => {
    extension.sendMessage(gSentMessages);
  });

  await extension.startup();
  await extension.awaitFinish("finished");
  await extension.unload();
  gServer.resetTest();
});

add_task(async function test_sendNow() {
  const files = {
    "background.js": async () => {
      const details = {
        to: ["sendNow@test.invalid"],
        subject: "Test sendNow",
      };

      // Open a compose window with a message.
      const createdWindowPromise = window.waitForEvent("windows.onCreated");
      await browser.compose.beginNew(details);
      const [createdWindow] = await createdWindowPromise;
      browser.test.assertEq("messageCompose", createdWindow.type);

      await window.sendMessage("checkWindow", details);

      const [tab] = await browser.tabs.query({ windowId: createdWindow.id });

      // Send via sendNow mode.
      const removedWindowPromise = window.waitForEvent("windows.onRemoved");
      const rv = await browser.compose.sendMessage(tab.id, { mode: "sendNow" });
      const [sentMessages] = await window.sendMessage("getSentMessages");

      browser.test.assertEq(
        3,
        sentMessages.length,
        "Number of total messages sent should be correct."
      );
      browser.test.assertEq(
        "sendNow",
        rv.mode,
        "The mode of the last message operation should be correct."
      );
      browser.test.assertEq(
        sentMessages[2],
        rv.headerMessageId,
        "The headerMessageId of last message sent should be correct."
      );

      // Window should have closed after send.
      await removedWindowPromise;

      const EXPECTED_FOLDERS = ["Sent"];
      browser.test.assertEq(
        EXPECTED_FOLDERS.length,
        rv.messages.length,
        "[messageSend()] number of send messages should be correct."
      );
      for (let i = 0; i < EXPECTED_FOLDERS.length; i++) {
        browser.test.assertEq(
          sentMessages[2],
          rv.messages[i].headerMessageId,
          `[messageSend()] message #${i + 1} should have the correct headerMessageId.`
        );
        browser.test.assertEq(
          EXPECTED_FOLDERS[i],
          rv.messages[i].folder.name,
          `[messageSend()] message #${i + 1} should be stored in the correct folder.`
        );
      }

      browser.test.notifyPass("finished");
    },
    "utils.js": await getUtilsJS(),
  };
  const extension = ExtensionTestUtils.loadExtension({
    files,
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["compose", "compose.send", "messagesRead", "accountsRead"],
    },
  });

  extension.onMessage("checkWindow", async expected => {
    await checkComposeHeaders(expected);
    extension.sendMessage();
  });

  extension.onMessage("getSentMessages", async () => {
    extension.sendMessage(gSentMessages);
  });

  await extension.startup();
  await extension.awaitFinish("finished");
  await extension.unload();
});

add_task(async function test_sendLater_with_additional_fcc_and_onAfterSend() {
  const files = {
    "background.js": async () => {
      const [fccFolder] = await browser.folders.query({ name: "FCC" });
      browser.test.assertEq(
        "FCC",
        fccFolder.name,
        "Folder should be found and have the correct name"
      );

      const details = {
        to: ["sendLater@test.invalid"],
        subject: "Test sendLater",
        additionalFccFolder: fccFolder,
      };

      const createdWindowPromise = window.waitForEvent("windows.onCreated");
      await browser.compose.beginNew(details);
      const [createdWindow] = await createdWindowPromise;
      browser.test.assertEq("messageCompose", createdWindow.type);

      await window.sendMessage("checkWindow", details);

      const [tab] = await browser.tabs.query({ windowId: createdWindow.id });

      // Add onAfterSend listener
      const collectedEventsMap = new Map();
      function onAfterSendListener(sendingTab, info) {
        collectedEventsMap.set(sendingTab.id, info);
      }
      browser.compose.onAfterSend.addListener(onAfterSendListener);

      // Send Later.
      const rv = await browser.compose.sendMessage(tab.id, {
        mode: "sendLater",
      });
      const [outboxMessage] = await window.sendMessage(
        "checkMessagesInOutbox",
        details
      );

      browser.test.assertEq(
        "sendLater",
        rv.mode,
        "The mode of the last message operation should be correct."
      );

      // Check onAfterSend listener
      browser.compose.onAfterSend.removeListener(onAfterSendListener);
      browser.test.assertEq(
        1,
        collectedEventsMap.size,
        "Should have received the correct number of onAfterSend events"
      );
      browser.test.assertTrue(
        collectedEventsMap.has(tab.id),
        "The received event should belong to the correct tab."
      );
      browser.test.assertEq(
        "sendLater",
        collectedEventsMap.get(tab.id).mode,
        "The received event should have the correct mode."
      );

      const EXPECTED_FOLDERS = ["Outbox", "FCC"];
      browser.test.assertEq(
        EXPECTED_FOLDERS.length,
        collectedEventsMap.get(tab.id).messages.length,
        "[onAfterSend] number of send messages should be correct."
      );
      browser.test.assertEq(
        EXPECTED_FOLDERS.length,
        rv.messages.length,
        "[messageSend()] number of send messages should be correct."
      );
      for (let i = 0; i < EXPECTED_FOLDERS.length; i++) {
        browser.test.assertEq(
          outboxMessage,
          collectedEventsMap.get(tab.id).messages[i].headerMessageId,
          `[onAfterSend] message #${i + 1} should have the correct headerMessageId.`
        );
        browser.test.assertEq(
          EXPECTED_FOLDERS[i],
          collectedEventsMap.get(tab.id).messages[i].folder.name,
          `[onAfterSend] message #${i + 1} should be stored in the correct folder.`
        );
        browser.test.assertEq(
          outboxMessage,
          rv.messages[i].headerMessageId,
          `[messageSend()] message #${i + 1} should have the correct headerMessageId.`
        );
        browser.test.assertEq(
          EXPECTED_FOLDERS[i],
          rv.messages[i].folder.name,
          `[messageSend()] message #${i + 1} should be stored in the correct folder.`
        );
      }

      await window.sendMessage("clearMessagesInOutbox");
      browser.test.notifyPass("finished");
    },
    "utils.js": await getUtilsJS(),
  };
  const extension = ExtensionTestUtils.loadExtension({
    files,
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["compose", "compose.send", "messagesRead", "accountsRead"],
    },
  });

  extension.onMessage("checkMessagesInOutbox", async expected => {
    // Check if the sendLater request did put the message in the outbox.
    const outboxMessages = [...gOutbox.messages];
    Assert.equal(outboxMessages.length, 1);
    const sentMessage = outboxMessages.shift();
    Assert.equal(sentMessage.subject, expected.subject, "subject is correct");
    Assert.equal(sentMessage.recipients, expected.to, "recipient is correct");
    extension.sendMessage(sentMessage.messageId);
  });

  extension.onMessage("clearMessagesInOutbox", async () => {
    const outboxMessages = [...gOutbox.messages];
    await new Promise(resolve => {
      gOutbox.deleteMessages(
        outboxMessages,
        null,
        true,
        false,
        { onStopCopy: resolve },
        false
      );
    });

    Assert.equal(0, [...gOutbox.messages].length, "outbox should be empty");
    extension.sendMessage();
  });

  extension.onMessage("checkWindow", async expected => {
    await checkComposeHeaders(expected);
    extension.sendMessage();
  });

  await extension.startup();
  await extension.awaitFinish("finished");
  await extension.unload();
});

add_task(async function test_onComposeStateChanged() {
  const files = {
    "background.js": async () => {
      let numberOfEvents = 0;
      browser.compose.onComposeStateChanged.addListener(async (tab, state) => {
        numberOfEvents++;
        browser.test.log(`State #${numberOfEvents}: ${JSON.stringify(state)}`);
        switch (numberOfEvents) {
          case 1:
            // The fresh created composer has no recipient, send is disabled.
            browser.test.assertEq(false, state.canSendNow);
            browser.test.assertEq(false, state.canSendLater);
            break;

          case 2:
            // The composer updated its initial details data, send is enabled.
            browser.test.assertEq(true, state.canSendNow);
            browser.test.assertEq(true, state.canSendLater);
            break;

          case 3:
            // The recipient has been invalidated, send is disabled.
            browser.test.assertEq(false, state.canSendNow);
            browser.test.assertEq(false, state.canSendLater);
            break;

          case 4: {
            // The recipient has been reverted, send is enabled.
            browser.test.assertEq(true, state.canSendNow);
            browser.test.assertEq(true, state.canSendLater);

            // Clean up.

            const removedWindowPromise =
              window.waitForEvent("windows.onRemoved");
            browser.windows.remove(createdWindow.id);
            await removedWindowPromise;

            browser.test.notifyPass("finished");
            break;
          }
        }
      });

      // The call to beginNew should create two onComposeStateChanged events,
      // one after the empty window has been created and one after the initial
      // details have been set.
      const createdWindowPromise = window.waitForEvent("windows.onCreated");
      const createdTab = await browser.compose.beginNew({
        to: ["test@test.invalid"],
        subject: "Test part 1",
        body: "Original body.",
      });
      const [createdWindow] = await createdWindowPromise;
      browser.test.assertEq("messageCompose", createdWindow.type);

      // Trigger an onComposeStateChanged event by invalidating the recipient.
      await browser.compose.setComposeDetails(createdTab.id, {
        to: ["test"],
        subject: "Test part 2",
      });

      // Trigger an onComposeStateChanged event by reverting the recipient.
      await browser.compose.setComposeDetails(createdTab.id, {
        to: ["test@test.invalid"],
        subject: "Test part 3",
      });
    },
    "utils.js": await getUtilsJS(),
  };
  const extension = ExtensionTestUtils.loadExtension({
    files,
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["compose"],
    },
  });

  await extension.startup();
  await extension.awaitFinish("finished");
  await extension.unload();
});

add_task(async function test_sendNow_without_fcc_succeeds() {
  const root = gLocalAccount.incomingServer.rootFolder;
  const storedMessages = () =>
    root.subFolders.flatMap(folder =>
      [...folder.messages].map(header => ({
        folderURI: folder.URI,
        key: header.messageKey,
        messageId: header.messageId,
      }))
    );
  const before = storedMessages();
  const sentCount = gSentMessages.length;
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const tab = await browser.compose.beginNew({
          to: ["nocopy@example.invalid"],
          subject: "No-copy sendNow completion",
          plainTextBody: "The SMTP message is sent without saving an FCC.",
          overrideDefaultFccFolder: "",
        });
        const completed = window.waitForEvent("compose.onAfterSend");
        const removed = window.waitForEvent("windows.onRemoved");
        const result = await browser.compose.sendMessage(tab.id, {
          mode: "sendNow",
        });
        const [sentTab, info] = await completed;
        await removed;
        browser.test.assertEq("sendNow", result.mode);
        browser.test.assertTrue(!!result.headerMessageId);
        browser.test.assertEq(0, result.messages.length);
        browser.test.assertEq(tab.id, sentTab.id);
        browser.test.assertEq("sendNow", info.mode);
        browser.test.assertEq(undefined, info.error);
        browser.test.assertEq(result.headerMessageId, info.headerMessageId);
        browser.test.assertEq(0, info.messages.length);
        const [delivered] = await window.sendMessage("getNoCopyDelivery");
        browser.test.assertDeepEq([result.headerMessageId], delivered.sentIds);
        browser.test.assertEq(
          result.headerMessageId,
          delivered.smtpMessage.match(/^message-id:\s*<([^>]+)>/im)?.[1],
          "The successful result identifies the actual SMTP message"
        );
        browser.test.assertTrue(
          delivered.smtpMessage.includes("No-copy sendNow completion")
        );
        browser.test.notifyPass("nocopy-sendNow");
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["compose", "compose.send", "messagesRead", "accountsRead"],
    },
  });
  extension.onMessage("getNoCopyDelivery", () =>
    extension.sendMessage({
      sentIds: gSentMessages.slice(sentCount),
      smtpMessage: gServer._daemon.post,
    })
  );
  await extension.startup();
  await extension.awaitFinish("nocopy-sendNow");
  await extension.unload();
  Assert.deepEqual(
    storedMessages(),
    before,
    "No-copy send preserves every physical stored message"
  );
});

/**
 * Sends through real SMTP and files the result through real IMAP APPEND.
 *
 * @param {boolean} retry - Reject the first APPEND and choose the normal retry.
 * @returns {Promise<void>} Resolves after physical filing and event checks.
 */
async function checkImapFcc(retry) {
  Assert.ok(
    Cc["@mozilla.org/mailnews/database-core;1"].getService(Ci.nsIDatabaseCore),
    "The installed native database serves this compose consumer"
  );
  Assert.ok(Services.prefs.getBoolPref("mail.panorama.enabled"));
  const account = MailServices.accounts.createAccount();
  let accountRemoved = false;
  registerCleanupFunction(() => {
    if (!accountRemoved) {
      accountRemoved = true;
      cleanUpAccount(account);
    }
  });
  const imap = new IMAPServer({ extensions: ["RFC4315"] });
  imap.open();
  account.incomingServer = MailServices.accounts.createIncomingServer(
    "user",
    "localhost",
    "imap"
  );
  const incoming = account.incomingServer.QueryInterface(
    Ci.nsIImapIncomingServer
  );
  Assert.equal(incoming.msgStore.storeType, "mbox", "The declared native mbox store is selected");
  incoming.port = imap.port;
  incoming.password = "password";
  incoming.maximumConnectionsNumber = 1;
  incoming.useIdle = false;
  incoming.downloadOnBiff = false;
  incoming.setBoolValue("autosync_offline_stores", false);
  const root = incoming.rootFolder;
  const discovery = new MailPromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(root, discovery, null);
  await discovery.promise;
  Assert.ok(
    root.getChildNamed("INBOX"),
    "Real LIST discovers the native INBOX"
  );
  const sent = await createSubfolder(root, "ConfiguredSent");
  const outside = await createSubfolder(root, "OtherIdentitySent");
  const controlBody = [
    "From: control@example.invalid",
    "To: recipient@example.invalid",
    "Subject: Unrelated sent copy",
    "Message-ID: <s375-fcc-control@example.invalid>",
    "",
    "Keep this physical control.",
    "",
  ].join("\r\n");
  await imap.addMessages(outside, [controlBody]);
  const control = [...outside.messages].map(header => ({
    folderURI: header.folder.URI,
    key: header.messageKey,
    messageId: header.messageId,
  }));
  Assert.equal(control.length, 1);
  const identity = addIdentity(account, "imap-fcc@example.invalid");
  identity.smtpServerKey = gPopAccount.defaultIdentity.smtpServerKey;
  identity.doFcc = true;
  identity.fccFolderURI = sent.URI;
  const subject = retry
    ? "IMAP FCC after rejected APPEND"
    : "Configured IMAP FCC";
  const body = "Exactly one SMTP delivery and one confirmed IMAP sent copy.";
  const sentCount = gSentMessages.length;
  let prompts = 0;
  const originalPrompt = Services.prompt;
  let loaded = false;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    Services.prompt = originalPrompt;
    imap.daemon.commandToFail = "";
    for (const win of Services.wm.getEnumerator("msgcompose")) {
      if (win.gMsgCompose.compFields.subject == subject) {
        win.gMsgCompose.bodyModified = false;
        win.gContentChanged = false;
        win.close();
      }
    }
    if (loaded) {
      loaded = false;
      await extension.unload();
    }
    if (!accountRemoved) {
      accountRemoved = true;
      cleanUpAccount(account);
    }
  };
  registerCleanupFunction(cleanup);
  if (retry) {
    imap.daemon.commandToFail = "APPEND";
    Services.prompt = {
      QueryInterface: ChromeUtils.generateQI(["nsIPromptService"]),
      confirmEx() {
        prompts++;
        Assert.equal(
          prompts,
          1,
          "The real failed APPEND asks once for recovery"
        );
        Assert.equal(
          imap.daemon.getMailbox("ConfiguredSent")._messages.length,
          0,
          "A rejected APPEND has not published a sent message"
        );
        Assert.equal(
          gSentMessages.length,
          sentCount + 1,
          "SMTP has already succeeded before copy recovery"
        );
        imap.daemon.commandToFail = "";
        return 0; // Retry the copy, not the already delivered SMTP message.
      },
    };
  }
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const [config] = await window.sendMessage("getImapFccConfig");
        const tab = await browser.compose.beginNew({
          identityId: config.identityId,
          to: ["fcc-recipient@example.invalid"],
          subject: config.subject,
          plainTextBody: config.body,
          isPlainText: true,
        });
        const events = [];
        const after = window.waitForEvent("compose.onAfterSend");
        const listener = (sendingTab, info) => events.push([sendingTab, info]);
        browser.compose.onAfterSend.addListener(listener);
        const removed = window.waitForEvent("windows.onRemoved");
        const result = await browser.compose.sendMessage(tab.id, {
          mode: "sendNow",
        });
        const [sendingTab, info] = await after;
        await removed;
        browser.compose.onAfterSend.removeListener(listener);
        browser.test.assertEq(1, events.length, "Exactly one final send event");
        browser.test.assertEq(tab.id, sendingTab.id);
        browser.test.assertEq("sendNow", result.mode);
        browser.test.assertEq(undefined, info.error);
        browser.test.assertEq(result.headerMessageId, info.headerMessageId);
        browser.test.assertEq(1, result.messages.length);
        browser.test.assertDeepEq(result.messages, info.messages);
        const [message] = result.messages;
        browser.test.assertEq(config.accountId, message.folder.accountId);
        browser.test.assertEq("/ConfiguredSent", message.folder.path);
        browser.test.assertEq(result.headerMessageId, message.headerMessageId);
        const stored = await browser.messages.get(message.id);
        browser.test.assertEq(config.subject, stored.subject);
        browser.test.assertEq(message.folder.id, stored.folder.id);
        const raw = await browser.messages.getRaw(message.id);
        browser.test.assertTrue(
          raw.includes(config.body),
          "Stored body is current"
        );
        await window.sendMessage("checkImapFccStored", result.headerMessageId);
        browser.test.notifyPass("imap-fcc");
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["compose", "compose.send", "messagesRead", "accountsRead"],
    },
  });
  extension.onMessage("getImapFccConfig", () =>
    extension.sendMessage({
      identityId: identity.key,
      accountId: account.key,
      subject,
      body,
    })
  );
  extension.onMessage("checkImapFccStored", async messageId => {
    const listener = new MailPromiseTestUtils.PromiseUrlListener();
    sent.updateFolderWithListener(null, listener);
    await listener.promise;
    const messages = [...sent.messages];
    Assert.equal(
      messages.length,
      1,
      "Only one physical sent message is published"
    );
    Assert.equal(messages[0].folder.URI, sent.URI);
    Assert.equal(messages[0].messageId, messageId);
    Assert.equal(messages[0].subject, subject);
    Assert.equal(messages[0].author, identity.email);
    const wire = imap.daemon.getMailbox("ConfiguredSent")._messages;
    Assert.equal(
      wire.length,
      1,
      "APPEND retry has not duplicated the stored body"
    );
    Assert.ok(wire[0].getText().includes(body));
    Assert.deepEqual(
      [...outside.messages].map(header => ({
        folderURI: header.folder.URI,
        key: header.messageKey,
        messageId: header.messageId,
      })),
      control,
      "The other identity's physical sent message is unchanged"
    );
    Assert.equal(
      imap.daemon.getMailbox("OtherIdentitySent")._messages[0].getText(),
      controlBody
    );
    Assert.deepEqual(gSentMessages.slice(sentCount), [messageId]);
    Assert.ok(gServer._daemon.post.includes(body));
    Assert.equal(prompts, retry ? 1 : 0);
    extension.sendMessage();
  });
  await extension.startup();
  loaded = true;
  await extension.awaitFinish("imap-fcc");
  await cleanup();
}

add_task(async function test_sendNowFilesToConfiguredImapFolder() {
  await checkImapFcc(false);
});

add_task(async function test_failedImapFccRetriesOnlyCopy() {
  await checkImapFcc(true);
});
