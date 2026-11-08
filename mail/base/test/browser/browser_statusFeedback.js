/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { ensure_cards_view } = ChromeUtils.importESModule(
  "resource://testing-common/MailViewHelpers.sys.mjs"
);

const statusText = document.getElementById("statusText");
const urlText = document.getElementById("urlText");
const tabmail = document.getElementById("tabmail");
const about3Pane = tabmail.currentAbout3Pane;
const { threadTree } = about3Pane;

const LINK = "https://www.example.com/";

add_setup(async function () {
  // Create an account for the test.
  const account = MailServices.accounts.createLocalMailAccount();
  account.addIdentity(MailServices.accounts.createIdentity());

  // Create a folder for the account to store test messages.
  const rootFolder = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const testFolder = rootFolder
    .createLocalSubfolder("statusFeedback")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);

  // Generate a test message.
  const generator = new MessageGenerator();
  testFolder.addMessage(
    generator
      .makeMessage({
        body: {
          body: `<a href="${LINK}">www.example.com</a>`,
          contentType: "text/html",
        },
      })
      .toMessageString()
  );

  // Use the test folder.
  about3Pane.displayFolder(testFolder.URI);
  await ensure_cards_view(document);

  // Remove test account on cleanup.
  registerCleanupFunction(() => {
    MailServices.accounts.removeAccount(account, false);
  });
});

/**
 * Tests that the correct status message appears when opening a message.
 */
add_task(async function testMessageOpen() {
  const row = threadTree.getRowAtIndex(0);
  const subjectLine = row.querySelector(
    ".thread-card-subject-container .subject"
  );

  // Click on the email.
  const selectPromise = BrowserTestUtils.waitForEvent(threadTree, "select");
  EventUtils.synthesizeMouseAtCenter(
    subjectLine,
    { clickCount: 1 },
    about3Pane
  );
  await selectPromise;

  // Check the value of the status message.
  Assert.equal(
    statusText.value,
    "Loading Message…",
    "correct status message is shown"
  );

  // Check that the status message eventually reset
  await TestUtils.waitForCondition(
    () => statusText.value == "",
    "status message should eventually reset"
  );
});

add_task(async function testOverLink() {
  const link = tabmail.currentAboutMessage
    .getMessagePaneBrowser()
    .contentDocument.body.getElementsByTagName("a")[0];

  // Hover the link in the mail.
  const hovered = BrowserTestUtils.waitForEvent(link, "mouseover");
  EventUtils.synthesizeMouseAtCenter(
    link,
    { type: "mouseover" },
    link.documentGlobal
  );
  await hovered;

  // Check that the URL part of the status bar is expanded and the link is
  // shown.
  Assert.equal(urlText.collapsed, false);
  Assert.equal(urlText.value, LINK);

  // Hover over anything else.
  const unhovered = BrowserTestUtils.waitForEvent(threadTree, "mouseover");
  EventUtils.synthesizeMouseAtCenter(
    threadTree,
    { type: "mouseover" },
    threadTree.documentGlobal
  );
  await unhovered;

  // Check that the URL part is collapsed and its value cleared.
  Assert.equal(urlText.value, "");
  Assert.equal(urlText.collapsed, true);
});

add_task(async function testManyStatuses() {
  await TestUtils.waitForCondition(
    () => !window.MsgStatusFeedback._statusQueue?.length,
    "waiting for status queue to be empty"
  );

  const statuses = [];
  for (let i = 0; i < 25; i++) {
    const str = `Hey hey hey #${i}`;
    if (i < 10) {
      // after 10 messages, messages should get dropped
      statuses.push(
        BrowserTestUtils.waitForMutationCondition(
          statusText,
          {
            attributes: true,
            attributeFilter: ["value"],
          },
          () => statusText.value == str
        )
      );
    }
    MailServices.feedback.reportStatus(str);
  }
  await Promise.all(statuses);
  Assert.ok(true, `The ${statuses.length} first statuses should be shown`);

  // After that, it should clear up.
  await BrowserTestUtils.waitForMutationCondition(
    statusText,
    {
      attributes: true,
      attributeFilter: ["value"],
    },
    () => statusText.value == ""
  );
});

add_task(async function test_statusWithMeteors() {
  const status = window.MsgStatusFeedback;
  await TestUtils.waitForCondition(
    () => !status._statusQueue.length && !status._meteorsSpinning,
    "waiting for status bar to be idle"
  );

  MailServices.feedback.reportStatus("Working…", "start-meteors");
  await TestUtils.waitForCondition(
    () => status._meteorsSpinning,
    "meteors should start spinning"
  );
  await BrowserTestUtils.waitForMutationCondition(
    statusText,
    {
      attributes: true,
      attributeFilter: ["value"],
    },
    () => statusText.value == "Working…",
    { msg: "status message should be shown" }
  );
  Assert.equal(status._startRequests, 1, "should have one start request");

  MailServices.feedback.reportStatus("Done.", "stop-meteors");
  await TestUtils.waitForCondition(
    () => !status._meteorsSpinning,
    "meteors should stop spinning"
  );
  Assert.equal(status._startRequests, 0, "should have no start requests");
});

add_task(async function test_pausedActivitiesResumeWithoutLeakingStatus() {
  const status = window.MsgStatusFeedback;
  const states = Ci.nsIActivityProcess;
  const manager = Cc["@mozilla.org/activity-manager;1"].getService(
    Ci.nsIActivityManager
  );
  const process = Cc["@mozilla.org/activity-process;1"].createInstance(states);
  process.init("Pause and resume status regression", "status-feedback-test");
  await TestUtils.waitForCondition(
    () => !status._meteorsSpinning && !status._stopTimeoutID,
    "The status bar is idle before the real process starts"
  );
  const starts = status._startRequests;
  let registered = true;
  manager.addActivity(process);
  try {
    for (const state of [
      states.STATE_PAUSED,
      states.STATE_WAITINGFORINPUT,
      states.STATE_WAITINGFORRETRY,
    ]) {
      Assert.equal(
        status._startRequests,
        starts + 1,
        "A running process contributes exactly one request"
      );
      await TestUtils.waitForCondition(
        () => status._meteorsSpinning,
        "The real running process makes the throbber busy"
      );
      process.state = state;
      Assert.equal(
        status._startRequests,
        starts,
        "Paused or waiting work releases only its running request"
      );
      Assert.ok(
        !status._busyProcesses.has(process),
        "Paused or waiting work is not a running process"
      );
      Assert.equal(
        manager.getActivity(process.id),
        process,
        "The same unfinished work remains in the Activity Manager"
      );
      Assert.ok(
        status._activeProcesses.includes(process),
        "Paused or waiting work remains tracked for resume"
      );
      await TestUtils.waitForCondition(
        () =>
          !status._meteorsSpinning &&
          !status._startTimeoutID &&
          !status._stopTimeoutID,
        "The paused process stops the real animation normally"
      );
      Assert.ok(
        BrowserTestUtils.isHidden(status._progressBarContainer),
        "The idle progress bar is hidden"
      );
      process.state = states.STATE_INPROGRESS;
      status.onStateChanged(process);
      Assert.equal(
        status._startRequests,
        starts + 1,
        "Resume and duplicate state notification contribute only once"
      );
    }
    process.state = states.STATE_COMPLETED;
    Assert.equal(
      status._startRequests,
      starts,
      "Completion releases the resumed request once"
    );
    Assert.ok(
      !status._activeProcesses.includes(process),
      "A completed process is no longer tracked"
    );
    manager.removeActivity(process.id);
    registered = false;
    Assert.equal(
      status._startRequests,
      starts,
      "Removal after completion cannot decrement another request"
    );
  } finally {
    if (registered) {
      if (
        process.state != states.STATE_COMPLETED &&
        process.state != states.STATE_CANCELED
      ) {
        if (process.state != states.STATE_INPROGRESS) {
          process.state = states.STATE_INPROGRESS;
        }
        process.state = states.STATE_CANCELED;
      }
      manager.removeActivity(process.id);
    }
  }
  await TestUtils.waitForCondition(
    () => !status._meteorsSpinning && !status._stopTimeoutID,
    "The process finishes with the normal idle status bar"
  );
});
