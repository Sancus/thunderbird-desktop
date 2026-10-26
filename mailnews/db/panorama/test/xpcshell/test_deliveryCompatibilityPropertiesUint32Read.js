/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_delivery.js */

add_task(function test_uint32ReadsBoundedHexPrefixes() {
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

  Assert.equal(header.getUint32Property("delivery.absent"), 0);
  Assert.equal(header.getStringProperty("delivery.absent"), "");
  Assert.ok(!header.properties.includes("delivery.absent"));
  const cases = [
    ["00042", 66],
    ["1e3", 483],
    ["2a", 42],
    ["2A", 42],
    ["2ag", 42],
    ["xyz", 0],
    ["", 0],
    ["0", 0],
    [" 2a", 0],
    ["+2a", 0],
    ["-1", 0],
    ["0x2a", 0],
    ["g2a", 0],
    ["☃ff", 0],
    ["fFfFfFfF", 4294967295],
    ["100000000", 268435456],
    ["000000001", 0],
    ["fffffffff", 4294967295],
    ["123456789", 305419896],
    ["deadbeef-tail", 3735928559],
    ["a\0f", 10],
    ["\0ff", 0],
  ];
  for (const [index, [text]] of cases.entries()) {
    header.setStringProperty("delivery.prefix." + index, text);
  }
  const fetched = messageDB.getMessage(id);
  const actual = cases.map((_, index) => {
    const name = "delivery.prefix." + index;
    return [
      fetched.getStringProperty(name),
      fetched.getUint32Property(name),
      messageDB.getMessageProperty(id, name),
      fetched.properties.includes(name),
    ];
  });
  Assert.deepEqual(
    actual,
    cases.map(([text, expected]) => [text, expected, text, true]),
    "Every literal prefix result preserves the exact text and presence"
  );
});
