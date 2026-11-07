/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_markAsRead.js */

requestLongerTimeout(AppConstants.MOZ_CODE_COVERAGE ? 3 : 2);

Services.scriptloader.loadSubScript(
  new URL("head_markAsRead.js", gTestPath).href,
  this
);

add_setup(async function () {
  await setupMarkAsRead("imap");
});

add_task(async function testIMAP() {
  // Our IMAP code marks a message as read if we have to fetch it from the
  // server for display, unless we tell it not to. Check we didn't break that.
  await subtest(imapTestFolder);
});
