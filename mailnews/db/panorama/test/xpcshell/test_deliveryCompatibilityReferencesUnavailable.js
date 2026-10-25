/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

add_setup(async function () {
  Assert.deepEqual(PanoramaDelivery.expectedLane(), {
    backend: "panorama",
    store: "none",
  });
  await installDBFromFile("db/messages.sql");
  Assert.equal(
    PanoramaDelivery.assertBackend("panorama").QueryInterface(
      Ci.nsIDatabaseCore
    ),
    database
  );
});

add_task(function test_referencesDoNotInventHistoricalData() {
  const header = messageDB.getMessage(1);
  Assert.equal(header.messageId, "message1@invalid");
  Assert.throws(
    () => header.numReferences,
    error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
  );
  Assert.throws(
    () => header.getStringReference(0),
    error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
  );
});
