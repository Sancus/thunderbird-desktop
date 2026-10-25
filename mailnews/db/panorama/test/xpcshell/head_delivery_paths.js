/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var gDEPTH = Services.env.get("PANORAMA_DELIVERY_TEST_ROOT");
Assert.ok(gDEPTH, "The runner declares the matching installed test root");
Assert.ok(
  gDEPTH.endsWith("/") || gDEPTH.endsWith("\\"),
  "The installed test root has a trailing separator"
);
const deliveryShutdown = Cc["@mozilla.org/file/local;1"].createInstance(
  Ci.nsIFile
);
deliveryShutdown.initWithPath(gDEPTH);
for (const component of ["mailnews", "resources", "mailShutdown.js"]) {
  deliveryShutdown.append(component);
}
Assert.ok(
  deliveryShutdown.exists() && deliveryShutdown.isFile(),
  "The matching installed mailShutdown.js exists"
);
