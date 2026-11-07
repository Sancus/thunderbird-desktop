/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * globals createCalendar, createEvent, openEvent, cal, CalendarTestUtils,
 * checkTolerance
 */

"use strict";

add_setup(setupPositioning);

add_task(async function test_scrollPositions() {
  await runPositioningTest([sizes[0]], [0, 1, 2]);
});
