/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from ../../../db/panorama/test/xpcshell/head.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

add_task(async function test_declinesFastMoveBeforeChangingFiles() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.equal(lane.store, "maildir");
  const { folder: source, rootFolder } =
    PanoramaDelivery.createLocalFixture("fast-move-source");
  const destination = rootFolder
    .createLocalSubfolder("fast-move-destination")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  PanoramaDelivery.assertFolder(destination, lane);

  const raw = [
    "From: Sender <sender@invalid>",
    "To: Recipient <recipient@invalid>",
    "Date: Tue, 01 Jan 2019 00:00:00 +0000",
    "Message-ID: <fast-move@invalid>",
    "Subject: Preserve fast move source",
    "",
    "The original source must remain readable.",
    "",
  ].join("\r\n");
  const residentRaw = raw.replaceAll("fast-move@invalid", "resident@invalid");
  const header = source.addMessage(raw);
  const resident = destination.addMessage(residentRaw);
  const sourceToken = header.storeToken;
  const residentToken = resident.storeToken;
  Assert.notEqual(sourceToken, "", "The source has a final locator");
  Assert.notEqual(residentToken, "", "The destination bystander has a locator");

  const sourceCur = PathUtils.join(source.filePath.path, "cur");
  const destinationCur = PathUtils.join(destination.filePath.path, "cur");
  const sourcePath = PathUtils.join(sourceCur, sourceToken);
  const residentPath = PathUtils.join(destinationCur, residentToken);
  const sourceFiles = (await IOUtils.getChildren(sourceCur)).sort();
  const destinationFiles = (await IOUtils.getChildren(destinationCur)).sort();
  Assert.equal(await IOUtils.readUTF8(sourcePath), raw);
  Assert.equal(await IOUtils.readUTF8(residentPath), residentRaw);

  const completed = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgFolderListener"]),
    msgsMoveCopyCompleted() {
      completed.push(true);
    },
  };
  MailServices.mfn.addListener(
    listener,
    MailServices.mfn.msgsMoveCopyCompleted
  );
  registerCleanupFunction(() => MailServices.mfn.removeListener(listener));
  const destinationHeaders = {};
  const undoAction = {};
  let handled;
  let failure = null;
  info('DELIVERY_PHASE {"phase":"maildir-fast-move-invoked"}');
  try {
    handled = source.msgStore.copyMessages(
      true,
      [header],
      destination,
      destinationHeaders,
      undoAction
    );
  } catch (error) {
    failure = error;
  }

  Assert.ok(await IOUtils.exists(sourcePath), "The original file still exists");
  Assert.equal(
    await IOUtils.readUTF8(sourcePath),
    raw,
    "Source bytes are intact"
  );
  Assert.equal(
    header.storeToken,
    sourceToken,
    "The source locator is unchanged"
  );
  Assert.deepEqual((await IOUtils.getChildren(sourceCur)).sort(), sourceFiles);
  Assert.deepEqual(
    (await IOUtils.getChildren(destinationCur)).sort(),
    destinationFiles,
    "Declining the fast path creates no destination file"
  );
  Assert.equal(await IOUtils.readUTF8(residentPath), residentRaw);
  Assert.deepEqual(source.msgDatabase.listAllKeys(), [header.messageKey]);
  Assert.deepEqual(destination.msgDatabase.listAllKeys(), [
    resident.messageKey,
  ]);
  Assert.deepEqual(completed, [], "No completed transfer was announced");
  Assert.equal(
    failure,
    null,
    "An unsupported fast path declines without error"
  );
  Assert.strictEqual(
    handled,
    false,
    "The caller must perform the streaming move"
  );
  Assert.deepEqual(
    destinationHeaders.value,
    [],
    "No destination header was made"
  );
  Assert.equal(undoAction.value, null, "No undo action was made");
  info('DELIVERY_PHASE {"phase":"maildir-fast-move-decline-verified"}');
});
