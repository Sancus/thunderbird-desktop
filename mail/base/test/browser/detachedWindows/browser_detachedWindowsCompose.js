/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

add_task(async function testSecondMessengerWindow() {
  info("Opening a new messenger window");
  // We need to wait for the window to load AND for about:3pane to load.
  // Conveniently, `mail-startup-done` is fired at that point, even though
  // this isn't the first window.
  let openPromise = TestUtils.topicObserved("mail-startup-done");
  window.MsgOpenNewWindowForFolder(testFolder.URI, -1);
  let [secondWindow] = await openPromise;
  await new Promise(resolve => secondWindow.setTimeout(resolve, 500));

  info("Closing the window");
  await BrowserTestUtils.closeWindow(secondWindow);
  // Apparently we need to wait a moment for things to clean up properly.
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 500));
  secondWindow = null;
  openPromise = null;

  await assertNoDetachedWindows();
});

add_task(async function testComposeWindow() {
  // Release the async frame that owns the compose window and its promises
  // before the memory reporter tests for detached windows.
  await (async () => {
    info("Opening a compose window");
    let composeWindowPromise = BrowserTestUtils.domWindowOpenedAndLoaded(
      null,
      win =>
        win.document.documentURI ===
        "chrome://messenger/content/messengercompose/messengercompose.xhtml"
    );
    window.MsgNewMessage();

    let composeWindow = await composeWindowPromise;
    await SimpleTest.promiseFocus(composeWindow);
    await TestUtils.waitForCondition(() => composeWindow.gLoadingComplete);
    await new Promise(resolve => composeWindow.setTimeout(resolve, 500));

    info("Closing the window");
    await BrowserTestUtils.closeWindow(composeWindow);
    composeWindow = null;
    composeWindowPromise = null;
  })();

  await assertNoDetachedWindows();
});
