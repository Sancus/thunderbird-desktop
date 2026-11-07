/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

add_task(async function test3PaneTab() {
  info("Opening a new 3-pane tab");
  window.MsgOpenNewTabForFolders([testFolder], {
    background: false,
    folderPaneVisible: true,
    messagePaneVisible: true,
  });
  let tab = tabmail.tabInfo[1];
  await BrowserTestUtils.waitForEvent(
    tab.chromeBrowser,
    "aboutMessageLoaded",
    true
  );
  await new Promise(resolve =>
    tab.chromeBrowser.contentWindow.setTimeout(resolve, 500)
  );

  tab.chromeBrowser.contentWindow.threadTree.selectedIndex = 0;
  await BrowserTestUtils.waitForEvent(tab.chromeBrowser, "MsgLoaded");
  await new Promise(resolve =>
    tab.chromeBrowser.contentWindow.setTimeout(resolve, 500)
  );

  info("Closing the tab");
  tabmail.closeOtherTabs(0);
  tab = null;

  await assertNoDetachedWindows();
});

add_task(async function testMessageTab() {
  info("Opening a new message tab");
  window.OpenMessageInNewTab(testMessages[0], { background: false });
  let tab = tabmail.tabInfo[1];
  await BrowserTestUtils.waitForEvent(
    tab.chromeBrowser,
    "aboutMessageLoaded",
    true
  );
  let aboutMessage = tab.chromeBrowser.contentWindow;
  await BrowserTestUtils.waitForEvent(aboutMessage, "MsgLoaded");
  await new Promise(resolve => aboutMessage.setTimeout(resolve, 500));

  aboutMessage.ReloadMessage();
  await BrowserTestUtils.waitForEvent(aboutMessage, "MsgLoaded");
  await new Promise(resolve => aboutMessage.setTimeout(resolve, 500));

  info("Closing the tab");
  tabmail.closeOtherTabs(0);
  tab = null;
  aboutMessage = null;

  await assertNoDetachedWindows();
});

add_task(async function testMessageWindow() {
  info("Opening a standalone message window");
  let win = await openMessageFromFile(
    new FileUtils.File(getTestFilePath("../files/sampleContent.eml"))
  );
  let aboutMessage = win.messageBrowser.contentWindow;
  await new Promise(resolve => aboutMessage.setTimeout(resolve, 500));

  aboutMessage.ReloadMessage();
  await BrowserTestUtils.waitForEvent(aboutMessage, "MsgLoaded");
  await new Promise(resolve => aboutMessage.setTimeout(resolve, 500));

  info("Closing the window");
  await BrowserTestUtils.closeWindow(win);
  win = null;
  aboutMessage = null;

  await assertNoDetachedWindows();
});
