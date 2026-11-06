/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests that sending a message updates the taskbar progress meter.
 */

const { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);

const { PromiseTestUtils: MailPromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

const gProgressEvents = [];
let smtpIdentity;

add_setup(async function () {
  await addLoginInfo("imap://test.test", "user", "password");
  await addLoginInfo("smtp://test.test", "user", "password");

  const [imapServer] = await ServerTestUtils.createServers([
    {
      ...ServerTestUtils.serverDefs.imap.plain,
      baseOptions: { extensions: ["RFC2195", "RFC4315"] },
    },
    ServerTestUtils.serverDefs.smtp.plain,
  ]);
  imapServer.daemon.createMailbox("Drafts", {
    flags: ["\\Drafts"],
    subscribed: true,
  });
  imapServer.daemon.createMailbox("Sent", {
    flags: ["\\Sent"],
    subscribed: true,
  });

  let smtpAccount, smtpOutgoingServer;
  ({ smtpAccount, smtpIdentity, smtpOutgoingServer } =
    createSMTPAccount("imap"));

  const incomingServer = smtpAccount.incomingServer;
  Assert.ok(
    Cc["@mozilla.org/mailnews/database-core;1"].getService(Ci.nsIDatabaseCore)
  );
  Assert.ok(Services.prefs.getBoolPref("mail.panorama.enabled"));
  Assert.equal(
    incomingServer.msgStore.storeType,
    "mbox",
    "The declared native mbox store is selected"
  );
  let mockTaskbar;
  registerCleanupFunction(async function () {
    incomingServer.closeCachedConnections();
    smtpOutgoingServer.closeCachedConnections();
    MailServices.accounts.removeAccount(smtpAccount, false);
    await Services.logins.removeAllLoginsAsync();
    MockRegistrar.unregister(mockTaskbar);
  });
  const discovery = new MailPromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(
    incomingServer.rootFolder,
    discovery,
    null
  );
  await discovery.promise;
  incomingServer.performBiff(window.msgWindow);
  await TestUtils.waitForCondition(
    () => incomingServer.rootFolder.containsChildNamed("Sent"),
    "waiting for folders to sync with the server"
  );
  smtpIdentity.draftsFolderURI = incomingServer.serverURI + "/Drafts";
  smtpIdentity.fccFolderURI = incomingServer.serverURI + "/Sent";
  smtpIdentity.fullName = "Bart Simpson";

  if (AppConstants.platform == "win") {
    mockTaskbar = MockRegistrar.register("@mozilla.org/windows-taskbar;1", {
      QueryInterface: ChromeUtils.generateQI(["nsIWinTaskbar"]),
      get available() {
        return true;
      },
      getTaskbarProgress(docShell) {
        return {
          QueryInterface: ChromeUtils.generateQI(["nsITaskbarProgress"]),
          setProgressState(state, current, maximum) {
            gProgressEvents.push({
              windowId: docShell.outerWindowID,
              state,
              current,
              maximum,
            });
          },
        };
      },
    });
  } else if (AppConstants.platform == "macosx") {
    mockTaskbar = MockRegistrar.register(
      "@mozilla.org/widget/macdocksupport;1",
      {
        QueryInterface: ChromeUtils.generateQI(["nsITaskbarProgress"]),
        setProgressState(state, current, maximum) {
          gProgressEvents.push({ state, current, maximum });
        },
      }
    );
  } else if (AppConstants.platform == "linux") {
    mockTaskbar = MockRegistrar.register(
      "@mozilla.org/widget/taskbarprogress/gtk;1",
      {
        QueryInterface: ChromeUtils.generateQI(["nsIGtkTaskbarProgress"]),
        setProgressState(state, current, maximum) {
          gProgressEvents.push({
            windowId: this._currentWindowId,
            state,
            current,
            maximum,
          });
        },
        setPrimaryWindow(win) {
          this._currentWindowId = win.docShell.outerWindowID;
        },
      }
    );
  }
});

/**
 * Wait until the send or save progress of a compose window stops. The final
 * taskbar progress event is set just before this notification, and can be
 * delivered after the compose window has closed, so waiting for the window to
 * close is not enough.
 *
 * @param {DOMWindow} composeWindow
 * @returns {Promise}
 */
function progressStopPromise(composeWindow) {
  const doc = composeWindow.document;
  const saveButton = doc.getElementById("button-save");
  const bounds = saveButton.getBoundingClientRect();
  const center = doc.elementFromPoint(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2
  );
  info(
    "S375_SAVE_PREPARE=" +
      JSON.stringify({
        defaultSaveOperation: composeWindow.defaultSaveOperation,
        saveInProgress: composeWindow.gSaveOperationInProgress,
        button: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        },
        center: {
          id: center?.id,
          node: center?.localName,
          classes: center?.getAttribute("class"),
        },
        main: saveButton
          .querySelector(".toolbarbutton-menubutton-button")
          ?.getBoundingClientRect(),
      })
  );
  const recordEvent = event => {
    info(
      "S375_SAVE_EVENT=" +
        JSON.stringify({
          type: event.type,
          target: event.target.id,
          path: event
            .composedPath()
            .filter(node => node.localName)
            .map(node => ({
              id: node.id,
              node: node.localName,
              classes: node.getAttribute("class"),
            })),
          defaultSaveOperation: composeWindow.defaultSaveOperation,
          saveInProgress: composeWindow.gSaveOperationInProgress,
          popup: doc.getElementById("button-savePopup").state,
          progressEvents: gProgressEvents.length,
        })
    );
  };
  const eventTypes = ["click", "command", "popupshown"];
  registerCleanupFunction(() => {
    for (const type of eventTypes) {
      composeWindow.removeEventListener(type, recordEvent, true);
    }
  });
  for (const type of eventTypes) {
    composeWindow.addEventListener(type, recordEvent, true);
  }
  return TestUtils.topicObserved(
    "mail:composeSendProgressStop",
    subject => subject.wrappedJSObject.composeWindow == composeWindow
  );
}

/**
 * Test sending a small message. There should be no taskbar progress updates.
 */
add_task(async function testSendSmall() {
  gProgressEvents.length = 0;

  const { composeWindow } = await newComposeWindow(
    smtpIdentity,
    "I will not waste chalk.\n"
  );
  const composeDocument = composeWindow.document;
  const toolbarButton = composeDocument.getElementById("button-send");

  Assert.ok(!toolbarButton.disabled, "toolbar button should not be disabled");
  const progressStopped = progressStopPromise(composeWindow);
  const windowClosed = BrowserTestUtils.domWindowClosed(composeWindow);
  EventUtils.synthesizeMouseAtCenter(toolbarButton, {}, composeWindow);
  await Promise.all([progressStopped, windowClosed]);

  Assert.equal(
    gProgressEvents.length,
    3,
    "expected number of progress event should have occurred"
  );
  Assert.equal(
    gProgressEvents[0].state,
    Ci.nsITaskbarProgress.STATE_NORMAL,
    "event 0 should be the start event"
  );
  Assert.equal(
    gProgressEvents[1].state,
    Ci.nsITaskbarProgress.STATE_NO_PROGRESS,
    "event 1 must be in the no progress state"
  );
  Assert.equal(
    gProgressEvents[2].state,
    Ci.nsITaskbarProgress.STATE_NO_PROGRESS,
    "event 2 must be in the no progress state"
  );
});

/**
 * Test sending a large message. There should be taskbar progress updates.
 */
add_task(async function testSendLarge() {
  gProgressEvents.length = 0;

  const { composeWindow } = await newComposeWindow(
    smtpIdentity,
    // We need enough data to get more than one progress report. Each chunk is
    // 65536 bytes, so this is plenty.
    "I will not waste chalk.\n".repeat(6000)
  );
  const windowId = composeWindow.docShell.outerWindowID;
  const composeDocument = composeWindow.document;
  const toolbarButton = composeDocument.getElementById("button-send");

  Assert.ok(!toolbarButton.disabled, "toolbar button should not be disabled");
  const progressStopped = progressStopPromise(composeWindow);
  const windowClosed = BrowserTestUtils.domWindowClosed(composeWindow);
  EventUtils.synthesizeMouseAtCenter(toolbarButton, {}, composeWindow);
  await Promise.all([progressStopped, windowClosed]);

  const progressEventCount = gProgressEvents.length;
  let previous = 0;
  Assert.greaterOrEqual(
    progressEventCount,
    2,
    "at least two progress events should have occurred"
  );
  // The events setting the progress come first, the events clearing it last.
  const firstClearedIndex = gProgressEvents.findIndex(
    event => event.state == Ci.nsITaskbarProgress.STATE_NO_PROGRESS
  );
  Assert.greater(
    firstClearedIndex,
    0,
    "the progress should have been set, then cleared"
  );
  for (let i = 0; i < progressEventCount; i++) {
    const progressEvent = gProgressEvents[i];
    if ("windowId" in progressEvent) {
      // Not on macOS.
      Assert.equal(
        progressEvent.windowId,
        windowId,
        "progress events should be on the compose window"
      );
    }
    if (i < firstClearedIndex) {
      Assert.equal(
        progressEvent.state,
        Ci.nsITaskbarProgress.STATE_NORMAL,
        `event ${i} must be in the normal state`
      );
      Assert.greaterOrEqual(
        progressEvent.current,
        previous,
        `event ${i} must have a sane current value`
      );
      Assert.lessOrEqual(
        progressEvent.current,
        progressEvent.maximum,
        `event ${i} must have a sane current value`
      );
      previous = progressEvent.current;
    } else {
      Assert.equal(
        progressEvent.state,
        Ci.nsITaskbarProgress.STATE_NO_PROGRESS,
        `event ${i} must be in the no progress state`
      );
      Assert.equal(
        progressEvent.current,
        0,
        `event ${i} must have no current value`
      );
      Assert.equal(
        progressEvent.maximum,
        0,
        `event ${i} must have no maximum value`
      );
    }
  }
});

/**
 * Test saving a large message but not closing the window. There should be
 * taskbar progress updates, but they should be cleared after saving.
 */
add_task(async function testSaveLarge() {
  gProgressEvents.length = 0;

  const { composeWindow } = await newComposeWindow(
    smtpIdentity,
    // We need enough data to get more than one progress report. Each chunk is
    // 65536 bytes, so this is plenty.
    "I will not waste chalk.\n".repeat(6000)
  );
  const composeDocument = composeWindow.document;
  const toolbarButton = composeDocument.getElementById("button-save");

  Assert.ok(!toolbarButton.disabled, "toolbar button should not be disabled");
  const progressStopped = progressStopPromise(composeWindow);
  EventUtils.synthesizeMouseAtCenter(toolbarButton, {}, composeWindow);
  // Wait until saving stops, then wait more to see if anything else happens.
  await progressStopped;
  await new Promise(resolve => composeWindow.setTimeout(resolve, 500));
  Assert.greaterOrEqual(
    gProgressEvents.length,
    2,
    "at least two progress events should have occurred"
  );

  Assert.equal(
    gProgressEvents.at(0).state,
    Ci.nsITaskbarProgress.STATE_NORMAL,
    "first event must be in the normal state"
  );
  Assert.equal(
    gProgressEvents.at(-1).state,
    Ci.nsITaskbarProgress.STATE_NO_PROGRESS,
    "last event must be in the no progress state"
  );

  await BrowserTestUtils.closeWindow(composeWindow);
});

add_task(async function test_progressFailurePreservesOriginalStatus() {
  let unavailableTaskbar;
  let registered = false;
  if (AppConstants.platform == "win") {
    unavailableTaskbar = MockRegistrar.register(
      "@mozilla.org/windows-taskbar;1",
      {
        QueryInterface: ChromeUtils.generateQI(["nsIWinTaskbar"]),
        available: false,
        getTaskbarProgress() {
          Assert.ok(false, "An unavailable taskbar must not be requested");
          throw Components.Exception(
            "Taskbar unavailable",
            Cr.NS_ERROR_NOT_AVAILABLE
          );
        },
      }
    );
    registered = true;
  }
  registerCleanupFunction(() => {
    if (registered) {
      MockRegistrar.unregister(unavailableTaskbar);
    }
  });
  const { composeWindow } = await newComposeWindow(
    smtpIdentity,
    "Queue failure status."
  );
  let closed = false;
  registerCleanupFunction(async () => {
    if (!closed && !composeWindow.closed) {
      await BrowserTestUtils.closeWindow(composeWindow);
    }
  });
  const { TaskbarProgress } = ChromeUtils.importESModule(
    "resource:///modules/TaskbarProgress.sys.mjs"
  );
  const progress = TaskbarProgress.getTaskbarProgress(composeWindow);
  if (AppConstants.platform == "win") {
    Assert.equal(progress, null, "The unavailable Windows taskbar is optional");
  } else {
    Assert.ok(
      progress,
      "The existing platform progress mock remains available"
    );
  }
  gProgressEvents.length = 0;
  let completions = 0;
  const observe = subject => {
    if (subject.wrappedJSObject.composeWindow == composeWindow) {
      completions++;
    }
  };
  Services.obs.addObserver(observe, "mail:composeSendProgressStop");
  registerCleanupFunction(() =>
    Services.obs.removeObserver(observe, "mail:composeSendProgressStop")
  );
  const stopped = progressStopPromise(composeWindow);
  composeWindow.progressListener.onStateChange(
    null,
    null,
    Ci.nsIWebProgressListener.STATE_START,
    Cr.NS_OK
  );
  composeWindow.progressListener.onStateChange(
    null,
    null,
    Ci.nsIWebProgressListener.STATE_STOP,
    Cr.NS_ERROR_FAILURE
  );
  const [subject] = await stopped;
  Assert.equal(subject.wrappedJSObject.status, Cr.NS_ERROR_FAILURE);
  Assert.equal(completions, 1, "The original failed operation completes once");
  Assert.deepEqual(
    gProgressEvents.map(event => event.state),
    AppConstants.platform == "win"
      ? []
      : [
          Ci.nsITaskbarProgress.STATE_NORMAL,
          Ci.nsITaskbarProgress.STATE_NO_PROGRESS,
        ],
    "Available progress surfaces update; unavailable surfaces are not requested"
  );
  await BrowserTestUtils.closeWindow(composeWindow);
  closed = true;
  if (registered) {
    MockRegistrar.unregister(unavailableTaskbar);
    registered = false;
  }
});
