/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

let rootFolder, folder, db;

add_setup(function () {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.equal(lane.store, "mbox");
  do_get_profile();
  loadExistingDB();
  const account = MailServices.accounts.createLocalMailAccount();
  rootFolder = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  folder = rootFolder
    .createLocalSubfolder("compatibility")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  db = PanoramaDelivery.assertFolder(folder, lane);
});

add_task(function test_onHdrAddedPublishesCompleteMessage() {
  const raw = [
    "From: Sender <sender@invalid>",
    "To: Recipient <recipient@invalid>",
    "Date: Tue, 01 Jan 2019 00:00:00 +0000",
    "Message-ID: <publication@invalid>",
    "References: <ancestor@invalid> <parent@invalid>",
    "Subject: Publication",
    "Content-Type: text/plain; charset=us-ascii",
    "",
    "Callback publication body.",
    "",
  ].join("\r\n");
  Assert.deepEqual(db.listAllKeys(), [], "The mbox starts empty");
  const published = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged() {},
    onHdrDeleted() {},
    onParentChanged() {},
    onAnnouncerGoingAway() {},
    onReadChanged() {},
    onJunkScoreChanged() {},
    onHdrPropertyChanged() {},
    onEvent() {},
    onHdrAdded(header) {
      const snapshot = {
        storeToken: header.storeToken,
        messageSize: header.messageSize,
        references: [],
      };
      published.push(snapshot);
      for (let index = 0; index < header.numReferences; index++) {
        snapshot.references.push(header.getStringReference(index));
      }
    },
  };
  db.addListener(listener);
  registerCleanupFunction(() => db.removeListener(listener));
  folder.addMessage(raw);

  // The first message starts at mbox offset zero; ASCII code units are bytes.
  Assert.deepEqual(
    published,
    [
      {
        storeToken: "0",
        messageSize: raw.length,
        references: ["ancestor@invalid", "parent@invalid"],
      },
    ],
    "The addition callback observes complete storage and References metadata"
  );
});
