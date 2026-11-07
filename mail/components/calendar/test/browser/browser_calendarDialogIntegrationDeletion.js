/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * globals createCalendar, createEvent, openEvent, cal, CalendarTestUtils,
 * checkTolerance
 */

/* import-globals-from head_calendarDialogIntegration.js */

Services.scriptloader.loadSubScript(
  new URL("head_calendarDialogIntegration.js", gTestPath).href,
  this
);

add_task(async function test_dialogDeleteMenuItem() {
  await createEvent({ calendar });
  const testDate = new Date();
  const eventBox = await openAndShowEvent({ baseDate: testDate });

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
  const deletePromptPromise = BrowserTestUtils.promiseAlertDialogOpen(
    "cancel",
    "chrome://messenger/content/calendarPrompt.xhtml"
  );

  menu.activateItem(menu.querySelector("#deleteEvent"));

  await deleteEventPromise;
  await deletePromptPromise;

  await cleanUp(dialog, eventBox);
});

add_task(async function test_dialogDeleteMenuSingleEvent() {
  await createEvent({ calendar });
  const testDate = new Date();
  await openAndShowEvent({ baseDate: testDate });

  const dialog = document.getElementById("calendarDialog");
  const eventId = dialog.getAttribute("event-id");

  const deletePromptPromise = BrowserTestUtils.promiseAlertDialogOpen(
    "delete",
    "chrome://messenger/content/calendarPrompt.xhtml"
  );
  await subtestDeleteEventPrompt(deletePromptPromise, testDate.getDay() + 1);

  const event = await calendar.getItem(eventId);
  Assert.ok(!event, "The event in the calendar should have been deleted");

  EventUtils.synthesizeMouseAtCenter(
    dialog.querySelector(".close-button"),
    {},
    window
  );
});

add_task(async function test_dialogDeleteMenuRecurringEvents() {
  // The following day's occurrence has to be in the displayed week.
  const testDate = new Date(todayDate);
  if (testDate.getDay() == 6) {
    testDate.setDate(testDate.getDate() - 1);
  }
  await createEvent({ calendar, repeats: true, baseDate: testDate });
  await openAndShowEvent({ baseDate: testDate });

  const dialog = document.getElementById("calendarDialog");
  const eventId = dialog.getAttribute("event-id");
  Assert.ok(
    weekView.getEventBoxAt(window, nextDayColumn(testDate), 1),
    "The following day calendar event box should exist"
  );

  const deleteAllEventsPromise = BrowserTestUtils.promiseAlertDialogOpen(
    null,
    "chrome://messenger/content/calendarPrompt.xhtml",
    {
      async callback(win) {
        const promptDialog = win.document.querySelector("dialog");
        const allEventsRadioOption = promptDialog.querySelector(
          "#allEventsRadioOption"
        );
        const deleteButton = promptDialog.querySelector("#delete");
        EventUtils.synthesizeMouseAtCenter(allEventsRadioOption, {}, win);
        EventUtils.synthesizeMouseAtCenter(deleteButton, {}, win);
      },
    }
  );
  await subtestDeleteEventPrompt(deleteAllEventsPromise, testDate.getDay() + 1);

  Assert.ok(
    !weekView.getEventBoxAt(window, nextDayColumn(testDate), 1),
    "The following day calendar event box should be removed"
  );

  const event = await calendar.getItem(eventId);
  Assert.ok(!event, "The event in the calendar should have been deleted");

  EventUtils.synthesizeMouseAtCenter(
    dialog.querySelector(".close-button"),
    {},
    window
  );
});

add_task(async function test_dialogDeleteMenuSingleOccurence() {
  await createEvent({ calendar, repeats: true });
  const testDate = new Date();
  await openAndShowEvent({ baseDate: testDate, offset: 1 });

  const dialog = document.getElementById("calendarDialog");
  const eventId = dialog.getAttribute("event-id");

  const deletePromptPromise = BrowserTestUtils.promiseAlertDialogOpen(
    "delete",
    "chrome://messenger/content/calendarPrompt.xhtml"
  );

  await subtestDeleteEventPrompt(deletePromptPromise, nextDayColumn(testDate));

  const event = await calendar.getItem(eventId);
  Assert.ok(event, "The event in the calendar should still exist");

  EventUtils.synthesizeMouseAtCenter(
    dialog.querySelector(".close-button"),
    {},
    window
  );

  await calendar.deleteItem(event);
});

add_task(async function test_closeDialogOnTabSwitch() {
  await createEvent({ calendar });
  const eventBox = await openAndShowEvent();

  const dialog = document.querySelector(`[is="calendar-dialog"]`);

  Assert.ok(dialog.open, "Dialog should be open");

  const dialogClose = BrowserTestUtils.waitForEvent(dialog, "close");
  tabmail.switchToTab(0);
  await dialogClose;

  Assert.ok(!dialog.open, "Dialog should report it is closed");
  Assert.ok(BrowserTestUtils.isHidden(dialog), "Dialog should not be visible");

  await CalendarTestUtils.openCalendarTab(window);

  Assert.ok(
    !dialog.open,
    "Dialog should stay closed after switching back to calendar tab"
  );
  Assert.ok(
    BrowserTestUtils.isHidden(dialog),
    "Dialog should still not be visible"
  );

  await calendar.deleteItem(eventBox.occurrence);
});

add_task(async function test_setFullDescription() {
  const originalLaunchBrowser = window.launchBrowser;
  window.launchBrowser = () => {};
  const beforeUnloadGuard = () => {
    info("Unloading!");
    Assert.ok(false, "Should never call beforeunload");
  };

  const expandedDescription = document.querySelector("#expandedDescription");
  const richDescription =
    expandedDescription.querySelector(".rich-description");
  richDescription.contentWindow.addEventListener(
    "beforeunload",
    beforeUnloadGuard
  );

  await checkDescription({ description: "foo", resultHTML: "foo" });
  await checkDescription({
    description: "foo 2\nTest",
    descriptionHTML: "<p>foo 2</p><button>Test</button>",
    resultHTML: "<p>foo 2</p>",
  });
  await checkDescription({
    description: "Link",
    descriptionHTML: `<a href="https://example.com/">Link</a>`,
    resultHTML: `<a href="https://example.com/">Link</a>`,
    launch: "https://example.com/",
  });
  await checkDescription({
    description: "Link",
    descriptionHTML: `<a href="mailto:thunderbird@example.com">Link</a>`,
    resultHTML: `<a href="mailto:thunderbird@example.com">Link</a>`,
    launch: "mailto:thunderbird@example.com",
  });

  richDescription.contentWindow.removeEventListener(
    "beforeunload",
    beforeUnloadGuard
  );
  window.launchBrowser = originalLaunchBrowser;
});
