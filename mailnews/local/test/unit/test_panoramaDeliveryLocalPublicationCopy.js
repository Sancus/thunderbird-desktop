/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from ../../../db/panorama/test/xpcshell/head.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

/** @type {{folder: nsIMsgLocalMailFolder, rootFolder: nsIMsgLocalMailFolder}} */
let publicationFixture;

add_setup(function () {
  Assert.equal(
    PanoramaDelivery.expectedLane().backend,
    "panorama",
    "These controls require the complete Panorama publication seam"
  );
  publicationFixture = PanoramaDelivery.createLocalFixture("publication-copy");
});

/**
 * Reads and closes a complete message stream.
 *
 * @param {nsIInputStream} stream - The stream to consume.
 * @returns {string} The message bytes.
 */
function readPublicationBytes(stream) {
  try {
    let raw = "";
    while (stream.available()) {
      raw += NetUtil.readInputStreamToString(stream, stream.available());
    }
    return raw;
  } finally {
    stream.close();
  }
}

/**
 * Checks complete destination metadata and bytes at the first addition callback.
 *
 * @param {boolean} isMove - Whether to move the source message.
 * @returns {Promise<void>} Resolves after transfer and source checks.
 */
async function checkCompletePublication(isMove) {
  const lane = PanoramaDelivery.expectedLane();
  const name = isMove ? "complete-move" : "complete-copy";
  const source = publicationFixture.rootFolder
    .createLocalSubfolder(name + "-source")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const destination = publicationFixture.rootFolder
    .createLocalSubfolder(name + "-destination")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  PanoramaDelivery.assertFolder(source, lane);
  const db = PanoramaDelivery.assertFolder(destination, lane);
  const raw = [
    "From: Sender <sender@invalid>",
    "To: Recipient <recipient@invalid>",
    "Date: Tue, 01 Jan 2019 00:00:00 +0000",
    "Message-ID: <complete-copy@invalid>",
    "Subject: Wire subject",
    "",
    "From a destination body.",
    "Last destination line.",
    "",
  ].join("\r\n");
  Assert.equal(raw.length, 217, "The literal fixture size is independent");
  const original = source.addMessage(raw);
  original.subject = "Stored subject";
  original.flags =
    Ci.nsMsgMessageFlags.Read |
    Ci.nsMsgMessageFlags.Marked |
    Ci.nsMsgMessageFlags.Replied |
    Ci.nsMsgMessageFlags.Offline;
  original.charset = "utf-8";
  original.accountKey = "original-account";
  original.messageSize = 65535;
  original.offlineMessageSize = 123456;
  original.lineCount = 888;
  for (const [key, value] of [
    ["size", "000Ff"],
    ["numLines", "000Aa"],
    ["offlineMsgSize", "000Bf"],
    ["dateReceived", "00aBcD"],
  ]) {
    original.setStringProperty(key, value);
  }
  const sourceKey = original.messageKey;
  const sourceToken = original.storeToken;
  const additions = [];
  const changes = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged() {
      changes.push("flags");
    },
    onHdrDeleted() {},
    onParentChanged() {},
    onAnnouncerGoingAway() {},
    onReadChanged() {},
    onJunkScoreChanged() {},
    onHdrPropertyChanged() {
      changes.push("property");
    },
    onEvent() {},
    onHdrAdded(header) {
      const snapshot = {};
      additions.push(snapshot);
      try {
        snapshot.subject = header.subject;
        snapshot.messageId = header.messageId;
        snapshot.flags = header.flags;
        snapshot.size = header.messageSize;
        snapshot.offlineSize = header.offlineMessageSize;
        snapshot.lines = header.lineCount;
        snapshot.charset = header.charset;
        snapshot.account = header.accountKey;
        snapshot.extras = [
          "size",
          "numLines",
          "offlineMsgSize",
          "dateReceived",
        ].map(key => header.getStringProperty(key));
        snapshot.member = db.containsKey(header.messageKey);
        snapshot.total = destination.getTotalMessages(false);
        snapshot.unread = destination.getNumUnread(false);
        snapshot.hasToken = header.storeToken !== "";
        if (snapshot.hasToken) {
          snapshot.raw = readPublicationBytes(
            destination.getMsgInputStream(header)
          );
          snapshot.storeRaw = readPublicationBytes(
            destination.msgStore.getMsgInputStream(
              destination,
              header.storeToken,
              0
            )
          );
        }
      } catch (error) {
        snapshot.error = String(error);
      }
    },
  };
  db.addListener(listener);
  registerCleanupFunction(() => db.removeListener(listener));
  const stopped = new PromiseTestUtils.PromiseCopyListener();
  MailServices.copy.copyMessages(
    source,
    [original],
    destination,
    isMove,
    stopped,
    null,
    false
  );
  await stopped.promise;
  Assert.deepEqual(
    additions,
    [
      {
        subject: "Stored subject",
        messageId: "complete-copy@invalid",
        flags:
          Ci.nsMsgMessageFlags.Read |
          Ci.nsMsgMessageFlags.Marked |
          Ci.nsMsgMessageFlags.Replied,
        size: 217,
        offlineSize: 0,
        lines: 2,
        charset: "utf-8",
        account: "original-account",
        extras: ["000Ff", "000Aa", "000Bf", "00aBcD"],
        member: true,
        total: 1,
        unread: 0,
        hasToken: true,
        raw,
        storeRaw: raw,
      },
    ],
    "One addition exposes destination storage and complete metadata"
  );
  Assert.deepEqual(
    changes,
    [],
    "No later setters complete the published header"
  );
  PanoramaDelivery.assertFolder(destination, lane);
  const copied = Array.from(destination.messages);
  Assert.equal(copied.length, 1);
  Assert.equal(
    readPublicationBytes(destination.getMsgInputStream(copied[0])),
    raw
  );
  PanoramaDelivery.assertFolder(source, lane);
  Assert.deepEqual(source.msgDatabase.listAllKeys(), isMove ? [] : [sourceKey]);
  if (!isMove) {
    Assert.equal(original.storeToken, sourceToken);
    Assert.equal(original.messageSize, 65535);
    Assert.equal(original.offlineMessageSize, 123456);
    Assert.equal(original.lineCount, 888);
    Assert.equal(readPublicationBytes(source.getMsgInputStream(original)), raw);
  }
}

add_task(async function test_copyPublishesDestinationStorage() {
  await checkCompletePublication(false);
});

add_task(async function test_movePublishesDestinationStorage() {
  await checkCompletePublication(true);
});

add_task(async function test_propertyReadFailurePrecedesBodyWrite() {
  const lane = PanoramaDelivery.expectedLane();
  const source = publicationFixture.rootFolder
    .createLocalSubfolder("property-fault-source")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const destination = publicationFixture.rootFolder
    .createLocalSubfolder("property-fault-destination")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  PanoramaDelivery.assertFolder(source, lane);
  const db = PanoramaDelivery.assertFolder(destination, lane);
  const raw =
    "Date: Tue, 01 Jan 2019 00:00:00 +0000\r\n" +
    "Message-ID: <property-fault@invalid>\r\nSubject: Fault\r\n\r\nKeep.\r\n";
  const original = source.addMessage(raw);
  original.setStringProperty("localPublicationFault", "exact-value");
  const secondRaw = raw.replace(
    "property-fault@invalid",
    "property-control@invalid"
  );
  const second = source.addMessage(secondRaw);
  const key = original.messageKey;
  const keys = [key, second.messageKey];
  const token = original.storeToken;
  const sourcePaths =
    lane.store == "maildir"
      ? [original, second].map(header =>
          PathUtils.join(source.filePath.path, "cur", header.storeToken)
        )
      : [source.filePath.path];
  const sourceBytes = await Promise.all(
    sourcePaths.map(file => IOUtils.read(file))
  );
  const faults = [];
  const additions = [];
  const statuses = [];
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
      additions.push(header.messageId);
    },
  };
  const connection = database.connectionForTests;
  let active = true;
  const cleanup = () => {
    if (active) {
      active = false;
      db.removeListener(observer);
      try {
        connection.executeSimpleSQL(
          "DROP VIEW IF EXISTS temp.message_properties"
        );
      } finally {
        connection.removeFunction("delivery_local_property_fault");
      }
    }
  };
  connection.createFunction("delivery_local_property_fault", 3, {
    onFunctionCall(args) {
      if (
        args.getInt64(0) == key &&
        args.getUTF8String(1) == "localPublicationFault"
      ) {
        faults.push(args.getUTF8String(2));
        throw Components.Exception("Property read fault", Cr.NS_ERROR_FAILURE);
      }
      return args.getUTF8String(2);
    },
  });
  registerCleanupFunction(cleanup);
  db.addListener(observer);
  connection.executeSimpleSQL(
    "CREATE TEMP VIEW message_properties AS SELECT id, name, " +
      "delivery_local_property_fault(id, name, value) AS value FROM main.message_properties"
  );
  let synchronousError = null;
  let succeeded;
  try {
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
        [original, second],
        destination,
        true,
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
  Assert.deepEqual(
    faults,
    ["exact-value"],
    "The real property read failed once"
  );
  Assert.equal(synchronousError, Cr.NS_ERROR_FAILURE);
  Assert.equal(succeeded, false);
  Assert.deepEqual(statuses, [Cr.NS_ERROR_FAILURE]);
  Assert.deepEqual(additions, []);
  Assert.deepEqual(db.listAllKeys(), []);
  PanoramaDelivery.assertFolder(destination, lane);
  PanoramaDelivery.assertFolder(source, lane);
  Assert.deepEqual(source.msgDatabase.listAllKeys(), keys);
  Assert.equal(original.storeToken, token);
  Assert.equal(readPublicationBytes(source.getMsgInputStream(original)), raw);
  Assert.equal(
    readPublicationBytes(source.getMsgInputStream(second)),
    secondRaw
  );
  for (const [index, file] of sourcePaths.entries()) {
    Assert.deepEqual(
      await IOUtils.read(file),
      sourceBytes[index],
      "The failed move preserves exact source bytes"
    );
  }
  if (lane.store == "maildir") {
    for (const directory of ["tmp", "cur"]) {
      Assert.deepEqual(
        await IOUtils.getChildren(
          PathUtils.join(destination.filePath.path, directory)
        ),
        []
      );
    }
  } else {
    Assert.equal(
      destination.filePath.fileSize,
      0,
      "No destination bytes were written"
    );
  }
});

add_task(async function test_sqlFailureRetainsFinishedBody() {
  const lane = PanoramaDelivery.expectedLane();
  const folder = publicationFixture.rootFolder
    .createLocalSubfolder("publication-sql-fault")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const db = PanoramaDelivery.assertFolder(folder, lane);
  const raw =
    "Date: Tue, 01 Jan 2019 00:00:00 +0000\r\n" +
    "Message-ID: <publication-sql-fault@invalid>\r\n" +
    "Subject: SQL fault\r\n\r\nFinished body must remain.\r\n";
  const faults = [];
  const additions = [];
  const connection = database.connectionForTests;
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
      additions.push(header.messageId);
    },
  };
  connection.createFunction("delivery_local_publication_abort", 1, {
    onFunctionCall(args) {
      faults.push(args.getUTF8String(0));
      throw Components.Exception("Publication SQL fault", Cr.NS_ERROR_FAILURE);
    },
  });
  let active = true;
  const cleanup = () => {
    if (active) {
      active = false;
      db.removeListener(observer);
      try {
        connection.executeSimpleSQL(
          "DROP TRIGGER IF EXISTS temp.delivery_local_publication_abort"
        );
      } finally {
        connection.removeFunction("delivery_local_publication_abort");
      }
    }
  };
  registerCleanupFunction(cleanup);
  db.addListener(observer);
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER delivery_local_publication_abort BEFORE INSERT ON main.messages " +
      "WHEN NEW.subject = 'SQL fault' BEGIN SELECT " +
      "delivery_local_publication_abort(NEW.subject); END"
  );
  try {
    Assert.throws(() => folder.addMessage(raw), /NS_ERROR/);
  } finally {
    cleanup();
  }
  Assert.deepEqual(
    faults,
    ["SQL fault"],
    "SQL insertion reached the real fault"
  );
  Assert.deepEqual(additions, [], "A failed insertion is never published");
  Assert.deepEqual(db.listAllKeys(), []);
  let token;
  if (lane.store == "maildir") {
    Assert.deepEqual(
      await IOUtils.getChildren(PathUtils.join(folder.filePath.path, "tmp")),
      []
    );
    const files = await IOUtils.getChildren(
      PathUtils.join(folder.filePath.path, "cur")
    );
    Assert.equal(files.length, 1, "Finished bytes remain after SQL rollback");
    token = PathUtils.filename(files[0]);
  } else {
    token = "0";
    Assert.greater(folder.filePath.fileSize, raw.length);
  }
  Assert.equal(
    readPublicationBytes(folder.msgStore.getMsgInputStream(folder, token, 0)),
    raw,
    "The finished token still retrieves the exact body after SQL failure"
  );
  PanoramaDelivery.assertFolder(folder, lane);
});

add_task(async function test_opaqueNamesSurviveNativeStorageExclusions() {
  const lane = PanoramaDelivery.expectedLane();
  const source = publicationFixture.rootFolder
    .createLocalSubfolder("opaque-names-source")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const destination = publicationFixture.rootFolder
    .createLocalSubfolder("opaque-names-destination")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  PanoramaDelivery.assertFolder(source, lane);
  PanoramaDelivery.assertFolder(destination, lane);
  const raw = [
    "Date: Tue, 01 Jan 2019 00:00:00 +0000",
    "Message-ID: <opaque-properties@invalid>",
    "Subject: Opaque names",
    "",
    "Opaque body.",
    "",
  ].join("\r\n");
  Assert.equal(raw.length, 119);
  const original = source.addMessage(raw);
  original.messageSize = 65535;
  original.offlineMessageSize = 123456;
  original.lineCount = 888;
  original.setStringProperty("msgOffset", "source-offset");
  for (const [name, value] of [
    ["messageSize offlineMessageSize", "opaque sizes"],
    ["storeToken msgOffset", "opaque tokens"],
    ["messageSize ", "trailing space"],
    [" messageSize", "leading space"],
  ]) {
    original.setStringProperty(name, value);
  }
  // Keep the preference matcher separate from native-key exclusion.
  const pref = "mailnews.database.summary.dontPreserveOnCopy";
  const hadPref = Services.prefs.prefHasUserValue(pref);
  const oldPref = Services.prefs.getCharPref(pref, "");
  const restorePref = () => {
    if (hadPref) {
      Services.prefs.setCharPref(pref, oldPref);
    } else {
      Services.prefs.clearUserPref(pref);
    }
  };
  registerCleanupFunction(restorePref);
  Services.prefs.setCharPref(pref, "");
  try {
    const listener = new PromiseTestUtils.PromiseCopyListener();
    MailServices.copy.copyMessages(
      source,
      [original],
      destination,
      false,
      listener,
      null,
      false
    );
    await listener.promise;
  } finally {
    restorePref();
  }
  const copied = Array.from(destination.messages);
  Assert.equal(copied.length, 1);
  Assert.deepEqual(
    [
      copied[0].getStringProperty("messageSize offlineMessageSize"),
      copied[0].getStringProperty("storeToken msgOffset"),
      copied[0].getStringProperty("messageSize "),
      copied[0].getStringProperty(" messageSize"),
    ],
    ["opaque sizes", "opaque tokens", "trailing space", "leading space"]
  );
  Assert.equal(copied[0].messageSize, 119);
  Assert.equal(copied[0].offlineMessageSize, 0);
  Assert.equal(copied[0].lineCount, 1);
  Assert.equal(copied[0].getStringProperty("msgOffset"), "");
  Assert.notEqual(copied[0].storeToken, "");
  Assert.equal(
    readPublicationBytes(destination.getMsgInputStream(copied[0])),
    raw
  );
  PanoramaDelivery.assertFolder(destination, lane);
  PanoramaDelivery.assertFolder(source, lane);
  Assert.deepEqual(source.msgDatabase.listAllKeys(), [original.messageKey]);
  Assert.equal(readPublicationBytes(source.getMsgInputStream(original)), raw);
});

add_task(async function test_copyDataPreservesNativeReadFailure() {
  const lane = PanoramaDelivery.expectedLane();
  const source = publicationFixture.rootFolder
    .createLocalSubfolder("native-read-fault-source")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const destination = publicationFixture.rootFolder
    .createLocalSubfolder("native-read-fault-destination")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  PanoramaDelivery.assertFolder(source, lane);
  const db = PanoramaDelivery.assertFolder(destination, lane);
  const messages = ["first", "second"].map(name =>
    source.addMessage(
      "Date: Tue, 01 Jan 2019 00:00:00 +0000\r\n" +
        "Message-ID: <native-read-" +
        name +
        "@invalid>\r\n" +
        "Subject: Native read " +
        name +
        "\r\n\r\nKeep source bytes.\r\n"
    )
  );
  const keys = messages.map(header => header.messageKey);
  const tokens = messages.map(header => header.storeToken);
  const paths =
    lane.store == "maildir"
      ? tokens.map(token => PathUtils.join(source.filePath.path, "cur", token))
      : [source.filePath.path];
  const before = await Promise.all(paths.map(file => IOUtils.read(file)));
  const pipe = Cc["@mozilla.org/pipe;1"].createInstance(Ci.nsIPipe);
  pipe.init(true, true, 0, 0);
  const input = pipe.inputStream;
  const output = pipe.outputStream;
  registerCleanupFunction(() => {
    input.close();
    output.close();
  });
  input.closeWithStatus(Cr.NS_ERROR_FILE_CORRUPTED);
  Assert.throws(() => input.available(), /NS_ERROR_FILE_CORRUPTED/);
  const copy = destination.QueryInterface(Ci.nsICopyMessageListener);
  const progress = [];
  const readResults = [];
  const statuses = [];
  const listener = new PromiseTestUtils.PromiseCopyListener({
    onProgress(current, total) {
      progress.push([current, total]);
      if (progress.length != 1) {
        return;
      }
      // The real native pipe Read returns this error with zero bytes.
      try {
        copy.copyData(input, 1);
        readResults.push(Cr.NS_OK);
      } catch (error) {
        readResults.push(error.result);
      }
    },
    onStopCopy(status) {
      statuses.push(status);
    },
  });
  const stopped = listener.promise.then(
    () => true,
    () => false
  );
  MailServices.copy.copyMessages(
    source,
    messages,
    destination,
    true,
    listener,
    null,
    false
  );
  Assert.equal(
    await stopped,
    false,
    "The failed member cannot complete a move"
  );
  Assert.equal(
    progress.length,
    1,
    "The active destination stream was reached once"
  );
  Assert.deepEqual(
    readResults,
    [Cr.NS_ERROR_FILE_CORRUPTED],
    "CopyData returns the original zero-byte native Read failure"
  );
  Assert.deepEqual(statuses, [Cr.NS_ERROR_FAILURE]);
  Assert.deepEqual(db.listAllKeys(), [], "No failed member is published");
  PanoramaDelivery.assertFolder(destination, lane);
  PanoramaDelivery.assertFolder(source, lane);
  Assert.deepEqual(source.msgDatabase.listAllKeys(), keys);
  Assert.deepEqual(
    messages.map(header => header.storeToken),
    tokens
  );
  for (const [index, file] of paths.entries()) {
    Assert.deepEqual(await IOUtils.read(file), before[index]);
  }
  if (lane.store == "maildir") {
    for (const directory of ["tmp", "cur"]) {
      Assert.deepEqual(
        await IOUtils.getChildren(
          PathUtils.join(destination.filePath.path, directory)
        ),
        []
      );
    }
  } else {
    Assert.equal(destination.filePath.fileSize, 0);
  }
});
