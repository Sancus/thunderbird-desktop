/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

add_task(async function testSearchMessagesDialog() {
  info("Opening the search messages dialog");
  const about3Pane = tabmail.currentAbout3Pane;
  const context = about3Pane.document.getElementById("folderPaneContext");
  const searchMessagesItem = about3Pane.document.getElementById(
    "folderPaneContext-searchMessages"
  );

  const shownPromise = BrowserTestUtils.waitForEvent(context, "popupshown");
  EventUtils.synthesizeMouseAtCenter(
    about3Pane.folderPane.getRowForFolder(testFolder).querySelector(".name"),
    { type: "contextmenu" },
    about3Pane
  );
  await shownPromise;

  let searchWindowPromise = BrowserTestUtils.domWindowOpenedAndLoaded(
    null,
    w =>
      w.document.documentURI == "chrome://messenger/content/searchDialog.xhtml"
  );
  context.activateItem(searchMessagesItem);
  let searchWindow = await searchWindowPromise;

  await new Promise(resolve => searchWindow.setTimeout(resolve, 500));

  info("Closing the dialog");
  await BrowserTestUtils.closeWindow(searchWindow);
  searchWindowPromise = null;
  searchWindow = null;

  await assertNoDetachedWindows();
});

add_task(async function testAddressBookTab() {
  info("Opening the Address Book");
  const addressBookReady = (async () => {
    const tabEvent = await BrowserTestUtils.waitForEvent(
      tabmail.tabContainer,
      "TabOpen",
      false,
      event => event.detail.tabInfo.mode.type == "addressBookTab"
    );
    await BrowserTestUtils.waitForEvent(
      tabEvent.detail.tabInfo.browser,
      "about-addressbook-ready",
      true
    );
  })();
  await window.toAddressBook();
  await addressBookReady;

  info("Closing the tab");
  tabmail.closeOtherTabs(0);

  await assertNoDetachedWindows();
});
