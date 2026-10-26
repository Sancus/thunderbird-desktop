/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

add_task(function test_uint32WritesLowercaseHexAndReplacesBothViews() {
  Assert.deepEqual(PanoramaDelivery.expectedLane(), {
    backend: "panorama",
    store: "none",
  });
  const file = do_get_profile().clone();
  file.append("panorama.sqlite");
  loadExistingDB();
  Assert.equal(
    PanoramaDelivery.assertBackend("panorama").QueryInterface(
      Ci.nsIDatabaseCore
    ),
    database
  );
  Assert.equal(database.connectionForTests.databaseFile.path, file.path);
  const root = folderDB.insertRoot("header-uint32");
  const folder = folderDB.insertFolder(root, "Inbox");
  const id = addMessage({
    folderId: folder,
    messageId: "header-uint32@invalid",
  });
  const header = messageDB.getMessage(id);

  const cases = [
    [0, "0"],
    [16, "10"],
    [42, "2a"],
    [11259375, "abcdef"],
    [2147483648, "80000000"],
    [4294967295, "ffffffff"],
  ];
  for (const [index, [number]] of cases.entries()) {
    header.setUint32Property("delivery.number." + index, number);
  }
  const fetched = messageDB.getMessage(id);
  Assert.deepEqual(
    cases.map((_, index) => {
      const name = "delivery.number." + index;
      return [
        fetched.getUint32Property(name),
        fetched.getStringProperty(name),
        messageDB.getMessageProperty(id, name),
      ];
    }),
    cases.map(([number, text]) => [number, text, text])
  );
  header.setStringProperty("delivery.transition", "2ag");
  Assert.equal(fetched.getUint32Property("delivery.transition"), 42);
  header.setUint32Property("delivery.transition", 17);
  Assert.equal(fetched.getStringProperty("delivery.transition"), "11");
  Assert.equal(fetched.getUint32Property("delivery.transition"), 17);
  header.setStringProperty("delivery.transition", "00042");
  Assert.equal(fetched.getStringProperty("delivery.transition"), "00042");
  Assert.equal(fetched.getUint32Property("delivery.transition"), 66);
  header.setStringProperty("delivery.transition", "");
  Assert.equal(fetched.getUint32Property("delivery.transition"), 0);
  Assert.ok(fetched.properties.includes("delivery.transition"));
});
