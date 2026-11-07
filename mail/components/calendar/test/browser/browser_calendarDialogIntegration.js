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

add_task(async function test_calendarDialogOpenAndClose() {
  let dialog = document.querySelector('[is="calendar-dialog"]');

  if (dialog) {
    dialog.remove();
  }

  let dialogs = [...document.querySelectorAll("dialog")].filter(
    _dialog => _dialog instanceof CalendarDialog
  );
  dialog = dialogs[0];

  Assert.equal(
    dialogs.length,
    0,
    "calendar dialog does not exist until opened"
  );

  await createEvent({ calendar });
  const eventBox = await openAndShowEvent();

  dialogs = [...document.querySelectorAll("dialog")].filter(
    _dialog => _dialog instanceof CalendarDialog
  );
  dialog = dialogs[0];

  Assert.equal(dialogs.length, 1, "calendar dialog exists after opening");

  Assert.ok(dialog.open, "dialog is open");

  EventUtils.synthesizeMouseAtCenter(
    dialog.querySelector(".close-button"),
    {},
    window
  );

  Assert.ok(!dialog.open, "dialog is hidden");

  await openEvent({ eventBox });

  dialogs = [...document.querySelectorAll("dialog")].filter(
    _dialog => _dialog instanceof CalendarDialog
  );
  const newDialog = dialogs[0];

  Assert.equal(dialogs.length, 1, "1 calendar dialog exists");
  Assert.ok(newDialog.open, "dialog is visible");
  Assert.equal(
    newDialog,
    dialog,
    "New dialog and old dialog are the same element"
  );

  await cleanUp(dialog, eventBox);
});

add_task(async function test_respondToRecurringInvitation() {
  const calendarUser = "mailto:receiver@example.com";
  const organizerId = "mailto:sender@example.com";
  calendar.setProperty("organizerId", calendarUser);

  let invitation = await createEvent({
    calendar,
    repeats: true,
    attendees: [
      {
        commonName: "Receiver",
        id: calendarUser,
        role: "REQ-PARTICIPANT",
        participationStatus: "NEEDS-ACTION",
      },
      {
        commonName: "Other",
        id: "mailto:other@example.com",
        role: "REQ-PARTICIPANT",
        participationStatus: "ACCEPTED",
      },
    ],
  });
  const updatedInvitation = invitation.clone();
  const organizer = new CalAttendee();
  organizer.id = organizerId;
  organizer.commonName = "Sender";
  organizer.participationStatus = "ACCEPTED";
  organizer.isOrganizer = true;
  updatedInvitation.organizer = organizer;
  invitation = await calendar.modifyItem(updatedInvitation, invitation);

  const eventBox = await openAndShowEvent();
  const occurrence = eventBox.occurrence;
  Assert.ok(occurrence.recurrenceId, "opened a recurring event occurrence");

  const dialog = document.querySelector('[is="calendar-dialog"]');
  const acceptanceWidget = dialog.querySelector("calendar-dialog-acceptance");
  Assert.equal(
    acceptanceWidget.getAttribute("status"),
    "NEEDS-ACTION",
    "the RSVP control shows the initial status when the dialog opens"
  );

  const sentItems = [];
  const getImipTransport = cal.itip.getImipTransport;
  cal.itip.getImipTransport = () => ({
    scheme: "mailto",
    type: "email",
    sendItems(recipients, itipItem, fromAttendee) {
      sentItems.push({ recipients, itipItem, fromAttendee });
      return true;
    },
  });

  const responseEvent = BrowserTestUtils.waitForEvent(
    acceptanceWidget,
    "setEventResponse"
  );
  await new Promise(resolve => setTimeout(resolve));
  EventUtils.synthesizeMouseAtCenter(
    acceptanceWidget.shadowRoot.querySelector('label[for="maybe"]'),
    {},
    window
  );
  Assert.equal(
    (await responseEvent).detail.status,
    "TENTATIVE",
    "the RSVP control sends the selected response"
  );

  let storedEvent;
  await TestUtils.waitForCondition(async () => {
    storedEvent = await calendar.getItem(invitation.id);
    const exception = storedEvent.recurrenceInfo.getExceptionFor(
      occurrence.recurrenceId
    );
    return (
      exception?.getAttendeeById(calendarUser).participationStatus ==
      "TENTATIVE"
    );
  }, "waiting for the RSVP response to be saved");
  await TestUtils.waitForCondition(
    () => sentItems.length == 1,
    "waiting for the RSVP response to be sent"
  );

  const exception = storedEvent.recurrenceInfo.getExceptionFor(
    occurrence.recurrenceId
  );
  Assert.equal(
    exception.getAttendeeById(calendarUser).participationStatus,
    "TENTATIVE",
    "the selected occurrence has the new RSVP status"
  );
  Assert.equal(
    storedEvent.getAttendeeById(calendarUser).participationStatus,
    "NEEDS-ACTION",
    "the recurring parent keeps its RSVP status"
  );

  Assert.equal(
    sentItems[0].recipients.length,
    1,
    "the reply has one recipient"
  );
  Assert.equal(
    sentItems[0].recipients[0].id,
    organizerId,
    "the reply is sent to the organizer"
  );
  Assert.equal(
    sentItems[0].fromAttendee.participationStatus,
    "TENTATIVE",
    "the reply has the new RSVP status"
  );

  Assert.equal(
    acceptanceWidget.getAttribute("status"),
    "TENTATIVE",
    "the RSVP control shows the new status"
  );
  const attendee = await TestUtils.waitForCondition(
    () =>
      Array.from(
        dialog.querySelectorAll("calendar-dialog-attendees-row:not([type]) li")
      ).find(element => element.attendee.id == calendarUser),
    "waiting for the invited attendee to render after the RSVP response"
  );
  Assert.equal(
    attendee.attendee.participationStatus,
    "TENTATIVE",
    "the attendee list shows the new RSVP status"
  );

  cal.itip.getImipTransport = getImipTransport;
  await calendar.deleteItem(invitation.parentItem);
  calendar.setProperty("organizerId", "mailto:organizer@example.com");
  dialog.close();
});

add_task(async function test_calendarDialogColors() {
  const category = "TEST";
  const formattedCategoryName = cal.view.formatStringForCSSRule(category);
  await SpecialPowers.pushPrefEnv({
    set: [[`calendar.category.color.${formattedCategoryName}`, "#0000ff"]],
  });
  const dialog = document.getElementById("calendarDialog");

  await createEvent({ calendar, categories: [category] });
  const eventBox = await openAndShowEvent();

  await BrowserTestUtils.waitForMutationCondition(
    dialog,
    {
      attributes: true,
      attributeFilter: ["style"],
    },
    () => dialog.style.getPropertyValue("--calendar-bar-color")
  );

  const calendarBarStyles = window.getComputedStyle(
    dialog.querySelector(".titlebar"),
    "::before"
  );
  Assert.equal(
    calendarBarStyles.backgroundColor,
    calendar.getProperty("color"),
    "Should apply the calendar color to the top bar"
  );

  const categoryItemStyles = window.getComputedStyle(
    dialog
      .querySelector("calendar-dialog-categories")
      .shadowRoot.querySelector(".categories-list li")
  );
  Assert.equal(
    categoryItemStyles.backgroundColor,
    "rgb(0, 0, 255)",
    "Should apply the category color the the background of the item"
  );

  await cleanUp(dialog, eventBox);
});

add_task(async function test_maxSize() {
  const style = document.createElement("style");
  style.textContent = `[is="calendar-dialog"] { height: 2000px; }`;
  document.head.appendChild(style);

  await createEvent({ calendar });
  const eventBox = await openAndShowEvent();

  const dialog = document.querySelector(`[is="calendar-dialog"]`);

  const dialogBox = dialog.getBoundingClientRect();
  const container = document.getElementById("calendarDisplayBox");
  const containerBox = container.getBoundingClientRect();

  Assert.lessOrEqual(
    Math.floor(dialogBox.height),
    Math.floor(containerBox.height - DEFAULT_DIALOG_MARGIN * 2),
    "The dialog height is restricted by the container"
  );

  await cleanUp(dialog, eventBox);
  style.remove();
});

add_task(async function test_resizeWindow() {
  const fixedDate = new Date(2025, 3, 6, 12, 0, 0, 0);

  const style = document.createElement("style");
  style.textContent = `[is="calendar-dialog"] { height: 2000px; }`;
  document.head.appendChild(style);

  await createEvent({ calendar, baseDate: fixedDate });
  const eventBox = await openAndShowEvent({ baseDate: fixedDate });

  const dialog = document.querySelector(`[is="calendar-dialog"]`);
  const container = document.getElementById("calendarDisplayBox");
  let dialogBox = dialog.getBoundingClientRect();
  let containerBox = container.getBoundingClientRect();

  Assert.lessOrEqual(
    Math.round(dialogBox.height),
    Math.round(containerBox.height - DEFAULT_DIALOG_MARGIN * 2),
    "The dialog height should be restricted by the container initially"
  );

  checkTolerance(eventBox, `Dialog has correct initial position`);

  await resizeWindow({ y: window.outerHeight - 100 });

  await TestUtils.waitForCondition(() => {
    dialogBox = dialog.getBoundingClientRect();
    containerBox = container.getBoundingClientRect();

    return (
      Math.round(dialogBox.height) <=
      Math.round(containerBox.height - DEFAULT_DIALOG_MARGIN * 2)
    );
  }, "Waiting for dialog to resize");

  Assert.lessOrEqual(
    Math.round(dialogBox.height),
    Math.round(containerBox.height - DEFAULT_DIALOG_MARGIN * 2),
    "The dialog height should be restricted by the container"
  );

  checkTolerance(eventBox, `Dialog should have correct final position`);

  await cleanUp(dialog, eventBox);
  style.remove();
});

add_task(async function test_attachmentLinkClick() {
  await createEvent({ calendar, attachments: ["https://example.com/"] });
  const eventBox = await openAndShowEvent();

  const dialog = document.getElementById("calendarDialog");
  await BrowserTestUtils.waitForAttributeRemoval(
    "hidden",
    dialog.querySelector("#attachmentsRow")
  );

  info("Open attachments subbiew...");
  EventUtils.synthesizeMouseAtCenter(
    dialog.querySelector("#expandAttachments"),
    {}
  );
  await BrowserTestUtils.waitForAttributeRemoval(
    "hidden",
    dialog.querySelector("#calendarAttachmentsSubview")
  );

  info("Clicking link...");
  const openPromise = MockExternalProtocolService.promiseLoad();
  EventUtils.synthesizeMouseAtCenter(
    dialog.querySelector('li[is="calendar-dialog-attachment"] a'),
    {}
  );
  Assert.equal(
    await openPromise,
    "https://example.com/",
    "Should try to open attachment URL"
  );

  await cleanUp(dialog, eventBox);
  MockExternalProtocolService.reset();
});
