/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from ../../../db/panorama/test/xpcshell/head.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

/**
 * @typedef {object} HeaderStructure
 * @property {string} subject - The stored subject.
 * @property {string} author - The From header.
 * @property {string} recipients - The To header.
 * @property {string} ccList - The Cc header.
 * @property {string} bccList - The Bcc header.
 * @property {string} messageId - The message identity from its header.
 * @property {number} date - The date in microseconds.
 * @property {number} flags - The persistent read/star/reply flags.
 * @property {number} priority - The stored priority.
 * @property {string} keywords - The stored tags.
 * @property {string[]} references - The exposed references in order.
 */

/** @type {{folder: nsIMsgLocalMailFolder, rootFolder: nsIMsgLocalMailFolder}} */
let structureFixture;

add_setup(function () {
  structureFixture = PanoramaDelivery.createLocalFixture("copy-source");
});

/**
 * Returns structural values without reading body or arbitrary properties.
 *
 * @param {nsIMsgDBHdr} header - The header to read.
 * @returns {HeaderStructure} A snapshot of the structural fields.
 */
function readStructure(header) {
  return {
    subject: header.subject,
    author: header.author,
    recipients: header.recipients,
    ccList: header.ccList,
    bccList: header.bccList,
    messageId: header.messageId,
    date: header.date,
    flags:
      header.flags &
      (Ci.nsMsgMessageFlags.Read |
        Ci.nsMsgMessageFlags.Marked |
        Ci.nsMsgMessageFlags.Replied),
    priority: header.priority,
    keywords: header.getStringProperty("keywords"),
    references: Array.from({ length: header.numReferences }, (_, index) =>
      header.getStringReference(index)
    ),
  };
}

/**
 * Fails a structural References read before the selected output stream opens.
 *
 * @param {number} failIndex - The first or second message index.
 * @param {boolean} emptyInput - Whether to truncate the last message's bytes.
 * @returns {Promise<void>} Resolves after checking failure and source retention.
 */
async function checkStructuralFailure(failIndex, emptyInput) {
  const lane = PanoramaDelivery.expectedLane();
  const name = "copy-fault-" + failIndex + "-" + emptyInput;
  const source = structureFixture.rootFolder
    .createLocalSubfolder(name + "-source")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const destination = structureFixture.rootFolder
    .createLocalSubfolder(name + "-destination")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  PanoramaDelivery.assertFolder(source, lane);
  const db = PanoramaDelivery.assertFolder(destination, lane);
  const messages = [];
  for (const value of ["first", "second"]) {
    messages.push(
      source.addMessage(
        [
          "From: Sender <sender@invalid>",
          "To: Recipient <recipient@invalid>",
          "Date: Tue, 01 Jan 2019 00:00:00 +0000",
          "Message-ID: <fault-" + value + "@invalid>",
          "References: <fault-parent@invalid>",
          "Subject: Fault " + value,
          "",
          "Original source body.",
          "",
        ].join("\r\n")
      )
    );
  }
  const resident = destination.addMessage(
    "Date: Tue, 01 Jan 2019 00:00:00 +0000\r\n" +
      "Message-ID: <fault-resident@invalid>\r\nSubject: Resident\r\n\r\nKeep.\r\n"
  );
  const tokens = messages.map(header => header.storeToken);
  const keys = messages.map(header => header.messageKey);
  const paths =
    lane.store == "maildir"
      ? tokens.map(token => PathUtils.join(source.filePath.path, "cur", token))
      : [source.filePath.path];
  if (emptyInput) {
    Assert.equal(failIndex, 1, "Only the final message is truncated");
    if (lane.store == "maildir") {
      await IOUtils.write(paths[1], new Uint8Array());
      Assert.equal((await IOUtils.stat(paths[1])).size, 0);
    } else {
      // The public mbox token is the message's file offset.
      const offset = Number(tokens[1]);
      const bytes = await IOUtils.read(paths[0]);
      Assert.ok(
        Number.isSafeInteger(offset) && offset > 0 && offset < bytes.length
      );
      await IOUtils.write(paths[0], bytes.subarray(0, offset));
      Assert.equal((await IOUtils.stat(paths[0])).size, offset);
    }
  }
  const before = await Promise.all(paths.map(file => IOUtils.read(file)));
  const residentPath =
    lane.store == "maildir"
      ? PathUtils.join(destination.filePath.path, "cur", resident.storeToken)
      : destination.filePath.path;
  const residentBytes = await IOUtils.read(residentPath);
  const faultKey = keys[failIndex];
  const faults = [];
  const additions = [];
  const completed = [];
  const statuses = [];
  const connection = database.connectionForTests;
  let setupError = null;
  let active = true;
  let functionAdded = false;
  const installFault = () =>
    connection.executeSimpleSQL(
      "CREATE TEMP VIEW message_references AS SELECT id, ordinal, " +
        "delivery_local_structure_fault(id, token) AS token FROM main.message_references"
    );
  const observer = {
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
      additions.push(header.subject);
      if (failIndex == 1 && header.subject == "Fault first") {
        try {
          installFault();
        } catch (error) {
          setupError = String(error);
        }
      }
    },
  };
  const notifier = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgFolderListener"]),
    msgsMoveCopyCompleted(isMove, sourceHeaders, folder) {
      if (folder == destination) {
        completed.push(isMove);
      }
    },
  };
  const cleanup = () => {
    if (!active) {
      return;
    }
    active = false;
    db.removeListener(observer);
    MailServices.mfn.removeListener(notifier);
    try {
      connection.executeSimpleSQL(
        "DROP VIEW IF EXISTS temp.message_references"
      );
    } finally {
      if (functionAdded) {
        connection.removeFunction("delivery_local_structure_fault");
      }
    }
  };
  registerCleanupFunction(cleanup);
  db.addListener(observer);
  MailServices.mfn.addListener(
    notifier,
    MailServices.mfn.msgsMoveCopyCompleted
  );
  let synchronousError = null;
  let succeeded;
  try {
    connection.createFunction("delivery_local_structure_fault", 2, {
      onFunctionCall(args) {
        if (args.getInt64(0) == faultKey) {
          faults.push(faultKey);
          throw Components.Exception(
            "Structural read fault",
            Cr.NS_ERROR_FAILURE
          );
        }
        return args.getUTF8String(1);
      },
    });
    functionAdded = true;
    if (failIndex == 0) {
      installFault();
    }
    const listener = new PromiseTestUtils.PromiseCopyListener({
      onStopCopy(status) {
        statuses.push(status);
      },
    });
    const stopped = listener.promise.then(
      () => true,
      () => false
    );
    try {
      MailServices.copy.copyMessages(
        source,
        messages,
        destination,
        false,
        listener,
        null,
        false
      );
    } catch (error) {
      synchronousError = error.result;
    }
    succeeded = await stopped;
  } finally {
    cleanup();
  }
  Assert.equal(setupError, null, "The later-message fault was installed");
  Assert.deepEqual(
    faults,
    [faultKey],
    "The selected native References read failed once"
  );
  Assert.equal(succeeded, false, "The failed transfer is reported as failure");
  Assert.equal(
    synchronousError,
    failIndex == 0 ? Cr.NS_ERROR_FAILURE : null,
    "Initial StartMessage failure propagates synchronously"
  );
  Assert.deepEqual(statuses, [Cr.NS_ERROR_FAILURE], "One failed completion");
  Assert.deepEqual(completed, [], "No completed transfer notification");
  Assert.deepEqual(additions, failIndex == 0 ? [] : ["Fault first"]);
  Assert.deepEqual(
    Array.from(destination.messages, header => header.subject).sort(),
    failIndex == 0 ? ["Resident"] : ["Fault first", "Resident"],
    "Only the completed prefix is published"
  );
  PanoramaDelivery.assertFolder(source, lane);
  PanoramaDelivery.assertFolder(destination, lane);
  Assert.deepEqual(
    source.msgDatabase.listAllKeys(),
    keys,
    "Every source identity remains"
  );
  Assert.deepEqual(
    messages.map(header => header.storeToken),
    tokens
  );
  for (const [index, file] of paths.entries()) {
    Assert.deepEqual(
      await IOUtils.read(file),
      before[index],
      "Exact source bytes remain"
    );
  }
  const residentAfter = await IOUtils.read(residentPath);
  Assert.deepEqual(
    lane.store == "mbox" && failIndex == 1
      ? residentAfter.subarray(0, residentBytes.length)
      : residentAfter,
    residentBytes,
    "The destination bystander bytes remain"
  );
  if (lane.store == "maildir") {
    Assert.equal(
      (
        await IOUtils.getChildren(
          PathUtils.join(destination.filePath.path, "tmp")
        )
      ).length,
      0
    );
    Assert.equal(
      (
        await IOUtils.getChildren(
          PathUtils.join(destination.filePath.path, "cur")
        )
      ).length,
      failIndex == 0 ? 1 : 2,
      "No failed-member body file was created"
    );
  }
}

add_task(
  { skip_if: () => PanoramaDelivery.expectedLane().backend != "panorama" },
  async function test_firstStructuralFailure() {
    await checkStructuralFailure(0, false);
  }
);

add_task(
  { skip_if: () => PanoramaDelivery.expectedLane().backend != "panorama" },
  async function test_laterStructuralFailure() {
    await checkStructuralFailure(1, false);
  }
);

add_task(
  { skip_if: () => PanoramaDelivery.expectedLane().backend != "panorama" },
  async function test_emptyInputStructuralFailure() {
    await checkStructuralFailure(1, true);
  }
);

add_task(async function test_copyStructuralFields() {
  const lane = PanoramaDelivery.expectedLane();
  const { folder: source, rootFolder } = structureFixture;
  const destination = rootFolder
    .createLocalSubfolder("copy-destination")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const db = PanoramaDelivery.assertFolder(destination, lane);
  const messages = [];
  for (const name of ["first", "second"]) {
    messages.push(
      source.addMessage(
        [
          "From: Sender <sender@invalid>",
          "To: Recipient <recipient@invalid>",
          "Cc: Copy <copy@invalid>",
          "Bcc: Blind <blind@invalid>",
          "Date: Tue, 01 Jan 2019 00:00:00 +0000",
          "Message-ID: <" + name + "-structure@invalid>",
          "References: <ancestor@invalid> <parent@invalid>",
          "Subject: Wire subject",
          "",
          "Stored body.",
          "",
        ].join("\r\n")
      )
    );
  }
  // The stored subject differs from the body header, so reparsing is insufficient.
  messages[0].subject = "First stored";
  messages[1].subject = "Second stored";
  source.markMessagesRead([messages[0]], true);
  source.markMessagesFlagged([messages[0]], true);
  messages[1].orFlags(Ci.nsMsgMessageFlags.Replied);
  messages[0].priority = Ci.nsMsgPriority.high;
  messages[1].priority = Ci.nsMsgPriority.low;
  messages[1].setReferences("");
  messages[0].setStringProperty("keywords", "structural-tag");
  const expected = [
    {
      subject: "First stored",
      author: "Sender <sender@invalid>",
      recipients: "Recipient <recipient@invalid>",
      ccList: "Copy <copy@invalid>",
      bccList: "Blind <blind@invalid>",
      messageId: "first-structure@invalid",
      date: 1546300800000000,
      flags: Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked,
      priority: Ci.nsMsgPriority.high,
      keywords: "structural-tag",
      references: ["ancestor@invalid", "parent@invalid"],
    },
    {
      subject: "Second stored",
      author: "Sender <sender@invalid>",
      recipients: "Recipient <recipient@invalid>",
      ccList: "Copy <copy@invalid>",
      bccList: "Blind <blind@invalid>",
      messageId: "second-structure@invalid",
      date: 1546300800000000,
      flags: Ci.nsMsgMessageFlags.Replied,
      priority: Ci.nsMsgPriority.low,
      keywords: "",
      references: [],
    },
  ];
  Assert.deepEqual(
    messages.map(readStructure),
    expected,
    "Source fixture values"
  );

  if (lane.backend == "panorama") {
    for (const header of messages) {
      header.orFlags(Ci.nsMsgMessageFlags.Offline);
    }
    Assert.deepEqual(
      messages.map(header =>
        Boolean(header.flags & Ci.nsMsgMessageFlags.Offline)
      ),
      [true, true],
      "The source fixture has destination-invalid Offline flags"
    );
  }
  const callbackFlags = [];
  const additions = [];
  const observer = {
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
      const snapshot = { messageId: "" };
      additions.push(snapshot);
      try {
        callbackFlags.push(header.flags);
        Object.assign(snapshot, readStructure(header));
      } catch (error) {
        snapshot.error = String(error);
      }
    },
  };
  registerCleanupFunction(() => db.removeListener(observer));
  db.addListener(observer);
  const listener = new PromiseTestUtils.PromiseCopyListener();
  MailServices.copy.copyMessages(
    source,
    messages,
    destination,
    false,
    listener,
    null,
    false
  );
  await listener.promise;
  PanoramaDelivery.assertFolder(source, lane);
  PanoramaDelivery.assertFolder(destination, lane);
  Assert.deepEqual(
    callbackFlags.map(flags => Boolean(flags & Ci.nsMsgMessageFlags.Offline)),
    [false, false],
    "Addition callbacks never expose the local Offline flag"
  );
  const byId = (a, b) => a.messageId.localeCompare(b.messageId);
  Assert.deepEqual(
    additions.sort(byId),
    expected,
    "Each addition exposes exact structural fields before later updates"
  );
  Assert.deepEqual(
    Array.from(destination.messages, readStructure).sort(byId),
    expected,
    "Destination headers retain exact structural fields"
  );
  Assert.deepEqual(
    Array.from(source.messages, readStructure).sort(byId),
    expected,
    "Source membership and structural fields match the operation"
  );
  if (lane.backend == "panorama") {
    Assert.deepEqual(
      messages.map(header =>
        Boolean(header.flags & Ci.nsMsgMessageFlags.Offline)
      ),
      [true, true],
      "Copy leaves the source Offline flags unchanged"
    );
  }
  info('DELIVERY_PHASE {"phase":"local-copy-structure-verified"}');
});
