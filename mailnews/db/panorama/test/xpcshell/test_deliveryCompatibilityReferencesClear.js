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

add_task(function test_setReferencesMakesHistoricalDataKnownEmpty() {
  const header = messageDB.getMessage(1);
  Assert.equal(header.messageId, "message1@invalid");
  header.setReferences("");
  Assert.equal(header.numReferences, 0);
  Assert.equal(messageDB.getMessage(1).numReferences, 0);
  Assert.throws(
    () => header.getStringReference(0),
    error => error.result == Cr.NS_ERROR_ILLEGAL_VALUE
  );
});
