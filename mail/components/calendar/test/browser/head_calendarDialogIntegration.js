/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * globals createCalendar, createEvent, openEvent, cal, CalendarTestUtils,
 * checkTolerance
 */

/* import-globals-from head.js */

"use strict";

const { CalendarDialog } = ChromeUtils.importESModule(
  "moz-src:///comm/mail/components/calendar/content/calendar-dialog.mjs",
  { global: "current" }
);

const { MockExternalProtocolService } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MockExternalProtocolService.sys.mjs"
);

const tabmail = document.getElementById("tabmail");
let calendar;

add_setup(() => {
  MockExternalProtocolService.init();
  calendar = createCalendar({
    name: "TB CAL TEST",
    color: "rgb(255, 187, 255)",
  });

  registerCleanupFunction(() => {
    CalendarTestUtils.removeCalendar(calendar);
    tabmail.closeOtherTabs(0);
    MockExternalProtocolService.cleanup();
  });
});

/**
 * Clean up the state of the calendar tab by closing the dialog and removing the
 * event used for the test.
 *
 * @param {CalendarDialog} dialog - The calendar dialog that was opened in the
 *  test.
 * @param {Element} eventBox - The event box holding the event the dialog was
 *  opened for. Usually this was resolved to by |openAndShowEvent|.
 */
async function cleanUp(dialog, eventBox) {
  EventUtils.synthesizeMouseAtCenter(
    dialog.querySelector(".close-button"),
    {},
    window
  );

  await calendar.deleteItem(eventBox.occurrence);
}

/**
 * Get the week view column of the day after the given date, wrapping from
 * Saturday to Sunday.
 *
 * @param {Date} date
 * @returns {number}
 */
function nextDayColumn(date) {
  return ((date.getDay() + 1) % 7) + 1;
}

/**
 * Click a link in the description and wait for the global launchBrowser
 * function to be called.
 *
 * @param {string} expectedUrl - The url that launchBrowser should have been
 * called with.
 */
async function waitForLaunchBrowser(expectedUrl) {
  const { promise, resolve } = Promise.withResolvers();

  window.launchBrowser = (url, event) => {
    event.stopPropagation();
    event.preventDefault();

    Assert.equal(url, expectedUrl, "Should launch the correct url");

    resolve();
  };

  const expandedDescription = document.querySelector("#expandedDescription");
  const richDescription =
    expandedDescription.querySelector(".rich-description");

  EventUtils.synthesizeMouseAtCenter(
    document.querySelector("#expandDescription"),
    {},
    window
  );

  await TestUtils.waitForCondition(
    () => BrowserTestUtils.isVisible(richDescription.contentDocument.body),
    "wait for description document to be visible"
  );

  EventUtils.synthesizeMouseAtCenter(
    richDescription.contentDocument.querySelector("a"),
    {},
    richDescription.contentWindow
  );

  await promise;

  window.launchBrowser = () => {};
}

/**
 * Create an event with a given description and open the dialog to make sure
 * the plain text and rich description are properly set and displayed.
 *
 * @param {object} options - An options object for checking the description.
 * @param {string} options.description - The description to create the event with.
 * @param {string} options.descriptionHTML - A HTML string to pass to the event creation.
 * @param {string} options.resultHTML - A HTML string of the displayed DOM.
 * @param {string} options.launch - A URL to pass to waitForLaunchBrowser.
 */
async function checkDescription({
  description,
  descriptionHTML,
  resultHTML,
  launch,
}) {
  await createEvent({
    calendar,
    description,
    descriptionHTML,
  });
  const eventBox = await openAndShowEvent();

  const expandedDescription = document.querySelector("#expandedDescription");
  const richDescription =
    expandedDescription.querySelector(".rich-description");

  const plainText = expandedDescription.querySelector(
    ".plain-text-description"
  );

  await TestUtils.waitForCondition(
    () => plainText.textContent == description,
    "Waiting for description to update"
  );

  Assert.equal(
    plainText.textContent,
    description,
    "Should display correct description in plain text"
  );
  Assert.equal(
    richDescription.contentDocument.body.innerHTML.trim(),
    resultHTML,
    "Should display correct description in browser body"
  );

  if (launch) {
    await waitForLaunchBrowser(launch);
  }

  await calendar.deleteItem(eventBox.occurrence);
}

/**
 * Open the menu in the dialog and select "Delete Event", and use the
 * promptPromise to interact with the calendar modal to delete an event.
 *
 * @param {Promise} promptPromise - The promise for the prompt to delete an event.
 * @param {number} eventBoxDay - The day number in the week that is used to
 * find the event box.
 */
async function subtestDeleteEventPrompt(promptPromise, eventBoxDay) {
  const dialog = document.getElementById("calendarDialog");
  const menu = dialog.querySelector("menupopup");

  const menuShownPromise = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(dialog.querySelector(".menu-button"), {});
  await menuShownPromise;

  Assert.ok(
    BrowserTestUtils.isVisible(menu),
    "The menupopup should visible after clicking menu button"
  );

  const deleteEventPromise = BrowserTestUtils.waitForEvent(
    dialog,
    "command",
    true
  );

  const eventBoxRemovalPromise = BrowserTestUtils.waitForMutationCondition(
    weekView.getColumnContainer(window, eventBoxDay),
    { childList: true, subtree: true },
    () => !weekView.getEventBoxAt(window, eventBoxDay, 1),
    "Calendar event box should be removed"
  );

  menu.activateItem(menu.querySelector("#deleteEvent"));
  await deleteEventPromise;
  await promptPromise;
  await eventBoxRemovalPromise;
}
