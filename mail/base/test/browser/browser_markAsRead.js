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
  await setupMarkAsRead("local");
});

add_task(async function testLocal() {
  await subtest(localTestFolder);
});
