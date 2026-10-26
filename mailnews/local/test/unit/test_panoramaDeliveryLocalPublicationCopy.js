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

/**
 * Checks a failed intermediate member followed by a reentrant mailbox move.
 *
 * @param {boolean} isMove - Whether the first request moves its three messages.
 * @returns {Promise<void>} Resolves after both requests and store checks.
 */
async function checkDeferredMailboxPublicationFailure(isMove) {
  const lane = PanoramaDelivery.expectedLane();
  const name = isMove ? "deferred-move" : "deferred-copy";
  const source = publicationFixture.rootFolder
    .createLocalSubfolder(name + "-source")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const secondSource = publicationFixture.rootFolder
    .createLocalSubfolder(name + "-second-source")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const destination = publicationFixture.rootFolder
    .createLocalSubfolder(name + "-destination")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  PanoramaDelivery.assertFolder(source, lane);
  PanoramaDelivery.assertFolder(secondSource, lane);
  const db = PanoramaDelivery.assertFolder(destination, lane);
  const subjects = ["Kept prefix", "Deferred attach fault", "Refused suffix"];
  const raws = subjects.map((subject, index) =>
    [
      "From: sender@invalid",
      "To: recipient@invalid",
      "Date: Tue, 01 Jan 2019 00:00:00 +0000",
      "Message-ID: <" + name + "-first-" + index + "@invalid>",
      "Subject: " + subject,
      "",
      "First request body " + index + ".",
      "",
    ].join("\r\n")
  );
  const secondRaws = ["one", "two"].map(word =>
    [
      "From: second@invalid",
      "To: destination@invalid",
      "Date: Wed, 02 Jan 2019 00:00:00 +0000",
      "Message-ID: <" + name + "-second-" + word + "@invalid>",
      "Subject: Second wire " + word,
      "",
      "Second request body " + word + ".",
      "",
    ].join("\r\n")
  );
  const messages = raws.map(raw => source.addMessage(raw));
  const secondMessages = secondRaws.map(raw => secondSource.addMessage(raw));
  const firstFlags = Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked;
  for (const header of messages) {
    header.flags = firstFlags;
  }
  const secondFlags = [
    Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Replied,
    Ci.nsMsgMessageFlags.Read |
      Ci.nsMsgMessageFlags.Marked |
      Ci.nsMsgMessageFlags.Replied,
  ];
  for (const [index, header] of secondMessages.entries()) {
    header.subject = "Second stored " + ["one", "two"][index];
    header.flags = secondFlags[index];
  }
  const keys = messages.map(header => header.messageKey);
  const tokens = messages.map(header => header.storeToken);
  const secondKeys = secondMessages.map(header => header.messageKey);
  const secondTokens = secondMessages.map(header => header.storeToken);
  const sourcePaths =
    lane.store == "maildir"
      ? tokens.map(token => PathUtils.join(source.filePath.path, "cur", token))
      : [source.filePath.path];
  const before = await Promise.all(sourcePaths.map(file => IOUtils.read(file)));
  Assert.deepEqual(
    messages.map(header =>
      readPublicationBytes(source.getMsgInputStream(header))
    ),
    raws
  );
  Assert.deepEqual(
    secondMessages.map(header =>
      readPublicationBytes(secondSource.getMsgInputStream(header))
    ),
    secondRaws
  );

  const events = [];
  const faults = [];
  const additions = [];
  const firstStatuses = [];
  const secondStatuses = [];
  const firstProgress = [];
  const secondProgress = [];
  let firstStop;
  let secondStop;
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
      try {
        additions.push([
          header.messageId,
          header.subject,
          header.author,
          header.recipients,
          header.flags,
          readPublicationBytes(destination.getMsgInputStream(header)),
          secondSource.msgDatabase.listAllKeys(),
        ]);
      } catch (error) {
        additions.push(["callback error", String(error)]);
      }
    },
  };
  const secondListener = new PromiseTestUtils.PromiseCopyListener({
    onStartCopy() {
      events.push("second-start");
    },
    onProgress(current, total) {
      secondProgress.push([
        current,
        total,
        secondSource.msgDatabase.listAllKeys(),
      ]);
    },
    onStopCopy(status) {
      events.push("second-stop");
      secondStatuses.push(status);
      secondStop = secondSource.msgDatabase.listAllKeys();
    },
  });
  const secondStopped = secondListener.promise.then(
    () => true,
    () => false
  );
  let started;
  let startFailed;
  const secondStarted = new Promise((resolve, reject) => {
    started = resolve;
    startFailed = reject;
  });
  const firstListener = new PromiseTestUtils.PromiseCopyListener({
    onStartCopy() {
      events.push("first-start");
    },
    onProgress(current, total) {
      firstProgress.push([current, total]);
    },
    onStopCopy(status) {
      events.push("first-stop");
      firstStatuses.push(status);
      if (firstStatuses.length != 1) {
        return;
      }
      try {
        firstStop = {
          sourceKeys: source.msgDatabase.listAllKeys(),
          secondKeys: secondSource.msgDatabase.listAllKeys(),
          destinationIds: Array.from(
            destination.messages,
            header => header.messageId
          ),
          sourceBodies: messages.map(header =>
            readPublicationBytes(source.getMsgInputStream(header))
          ),
          secondBodies: secondMessages.map(header =>
            readPublicationBytes(secondSource.getMsgInputStream(header))
          ),
        };
        MailServices.copy.copyMessages(
          secondSource,
          secondMessages,
          destination,
          true,
          secondListener,
          null,
          false
        );
        started();
      } catch (error) {
        startFailed(error);
      }
    },
  });
  const firstStopped = firstListener.promise.then(
    () => true,
    () => false
  );
  const connection = database.connectionForTests;
  connection.createFunction("delivery_local_deferred_abort", 1, {
    onFunctionCall(args) {
      events.push("fault");
      faults.push(args.getUTF8String(0));
      throw Components.Exception(
        "Deferred AttachHdr fault",
        Cr.NS_ERROR_FAILURE
      );
    },
  });
  let active = true;
  const cleanup = () => {
    if (active) {
      active = false;
      db.removeListener(observer);
      try {
        connection.executeSimpleSQL(
          "DROP TRIGGER IF EXISTS temp.delivery_local_deferred_abort"
        );
      } finally {
        connection.removeFunction("delivery_local_deferred_abort");
      }
    }
  };
  registerCleanupFunction(cleanup);
  db.addListener(observer);
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER delivery_local_deferred_abort BEFORE INSERT ON main.messages " +
      "WHEN NEW.subject = 'Deferred attach fault' BEGIN SELECT " +
      "delivery_local_deferred_abort(NEW.subject); END"
  );
  let firstSucceeded;
  let secondSucceeded;
  const scan = new PromiseTestUtils.PromiseStoreScanListener();
  try {
    MailServices.copy.copyMessages(
      source,
      messages,
      destination,
      isMove,
      firstListener,
      null,
      false
    );
    firstSucceeded = await firstStopped;
    await secondStarted;
    secondSucceeded = await secondStopped;
    destination.msgStore.asyncScan(destination, scan);
    await scan.promise;
  } finally {
    cleanup();
  }
  Assert.equal(firstSucceeded, false);
  Assert.equal(secondSucceeded, true);
  Assert.deepEqual(faults, ["Deferred attach fault"]);
  Assert.deepEqual(firstStatuses, [Cr.NS_ERROR_FAILURE]);
  Assert.deepEqual(secondStatuses, [Cr.NS_OK]);
  Assert.deepEqual(events, [
    "first-start",
    "fault",
    "first-stop",
    "second-start",
    "second-stop",
  ]);
  Assert.deepEqual(firstProgress, [
    [1, 3],
    [2, 3],
  ]);
  Assert.deepEqual(secondProgress, [
    [1, 2, secondKeys],
    [2, 2, secondKeys],
  ]);
  Assert.deepEqual(firstStop, {
    sourceKeys: keys,
    secondKeys,
    destinationIds: [name + "-first-0@invalid"],
    sourceBodies: raws,
    secondBodies: secondRaws,
  });
  Assert.deepEqual(
    secondStop,
    [],
    "Only the successful second move deletes its sources"
  );
  Assert.deepEqual(additions, [
    [
      name + "-first-0@invalid",
      "Kept prefix",
      "sender@invalid",
      "recipient@invalid",
      firstFlags,
      raws[0],
      secondKeys,
    ],
    [
      name + "-second-one@invalid",
      "Second stored one",
      "second@invalid",
      "destination@invalid",
      secondFlags[0],
      secondRaws[0],
      secondKeys,
    ],
    [
      name + "-second-two@invalid",
      "Second stored two",
      "second@invalid",
      "destination@invalid",
      secondFlags[1],
      secondRaws[1],
      secondKeys,
    ],
  ]);
  Assert.deepEqual(
    Array.from(destination.messages, header => [
      header.messageId,
      header.subject,
      header.flags,
    ]).toSorted((a, b) => a[0].localeCompare(b[0])),
    [
      [name + "-first-0@invalid", "Kept prefix", firstFlags],
      [name + "-second-one@invalid", "Second stored one", secondFlags[0]],
      [name + "-second-two@invalid", "Second stored two", secondFlags[1]],
    ]
  );
  Assert.deepEqual(
    scan.messages.toSorted(),
    [raws[0], raws[1], ...secondRaws].toSorted(),
    "The store keeps the prefix, finished unpublished member and only the second request bodies"
  );
  const failedIndex = scan.messages.indexOf(raws[1]);
  Assert.notEqual(scan.tokens[failedIndex], "");
  Assert.equal(
    readPublicationBytes(
      destination.msgStore.getMsgInputStream(
        destination,
        scan.tokens[failedIndex],
        0
      )
    ),
    raws[1]
  );
  Assert.deepEqual(source.msgDatabase.listAllKeys(), keys);
  Assert.deepEqual(
    messages.map(header => header.storeToken),
    tokens
  );
  Assert.deepEqual(
    messages.map(header => header.subject),
    subjects
  );
  Assert.deepEqual(
    messages.map(header => header.flags),
    [firstFlags, firstFlags, firstFlags]
  );
  for (const [index, file] of sourcePaths.entries()) {
    Assert.deepEqual(await IOUtils.read(file), before[index]);
  }
  Assert.deepEqual(
    messages.map(header =>
      readPublicationBytes(source.getMsgInputStream(header))
    ),
    raws
  );
  Assert.deepEqual(secondSource.msgDatabase.listAllKeys(), []);
  if (lane.store == "maildir") {
    Assert.deepEqual(
      await IOUtils.getChildren(
        PathUtils.join(destination.filePath.path, "tmp")
      ),
      []
    );
    Assert.equal(
      (
        await IOUtils.getChildren(
          PathUtils.join(destination.filePath.path, "cur")
        )
      ).length,
      4
    );
    for (const token of secondTokens) {
      Assert.equal(
        await IOUtils.exists(
          PathUtils.join(secondSource.filePath.path, "cur", token)
        ),
        false
      );
    }
  }
  for (const folder of [source, secondSource, destination]) {
    PanoramaDelivery.assertFolder(folder, lane);
  }
}

add_task(async function test_copyDefersFailedMailboxCompletion() {
  await checkDeferredMailboxPublicationFailure(false);
});

add_task(async function test_moveDefersFailedMailboxCompletion() {
  await checkDeferredMailboxPublicationFailure(true);
});

/**
 * Checks absent account and charset rows through the header and another connection.
 *
 * @param {nsIMsgDBHdr} header - The header whose stored names are checked.
 * @param {mozIStorageConnection} reader - An independent connection to Panorama.
 */
function assertNoStoredAccountOrCharset(header, reader) {
  Assert.deepEqual(
    header.properties.filter(name => name == "account" || name == "msgCharSet"),
    []
  );
  const statement = reader.createStatement(
    "SELECT name FROM message_properties WHERE id = :id " +
      "AND name IN ('account', 'msgCharSet') ORDER BY name"
  );
  try {
    statement.params.id = header.messageKey;
    Assert.equal(
      statement.executeStep(),
      false,
      "Neither effective default is stored"
    );
  } finally {
    statement.finalize();
  }
}

add_task(async function test_copyKeepsAbsentAccountAndCharsetAcrossServers() {
  const lane = PanoramaDelivery.expectedLane();
  const source = publicationFixture.rootFolder
    .createLocalSubfolder("absent-account-source")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  PanoramaDelivery.assertFolder(source, lane);
  const sourceAccount = MailServices.accounts.findAccountForServer(
    source.server
  );
  Assert.ok(sourceAccount, "The source belongs to a real account");
  const server = MailServices.accounts.createIncomingServer(
    "publication-fallback",
    "destination.invalid",
    "none"
  );
  server.setStringValue(
    "storeContractID",
    lane.store == "maildir"
      ? "@mozilla.org/msgstore/maildirstore;1"
      : "@mozilla.org/msgstore/berkeleystore;1"
  );
  const account = MailServices.accounts.createAccount();
  account.incomingServer = server;
  registerCleanupFunction(() =>
    MailServices.accounts.removeAccount(account, false)
  );
  const root = server.rootMsgFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  const destination = root
    .createLocalSubfolder("absent-account-destination")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  PanoramaDelivery.assertFolder(destination, lane);
  Assert.notEqual(source.server.key, destination.server.key);
  Assert.notEqual(sourceAccount.key, account.key);
  Assert.equal(
    MailServices.accounts.findAccountForServer(destination.server).key,
    account.key
  );
  const raw =
    "From: absent@invalid\r\nTo: recipient@invalid\r\n" +
    "Date: Tue, 01 Jan 2019 00:00:00 +0000\r\n" +
    "Message-ID: <absent-account-copy@invalid>\r\n" +
    "Subject: Absent stored defaults\r\n\r\nKeep defaults absent.\r\n";
  const original = source.addMessage(raw);
  const key = original.messageKey;
  const token = original.storeToken;
  const file = do_get_profile();
  file.append("panorama.sqlite");
  const reader = Services.storage.openUnsharedDatabase(file);
  try {
    Assert.equal(original.accountKey, sourceAccount.key);
    Assert.equal(original.charset, "");
    assertNoStoredAccountOrCharset(original, reader);
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
    const copied = Array.from(destination.messages);
    Assert.equal(copied.length, 1);
    Assert.equal(copied[0].messageId, "absent-account-copy@invalid");
    Assert.equal(copied[0].subject, "Absent stored defaults");
    Assert.equal(
      copied[0].accountKey,
      account.key,
      "The destination uses its own account fallback"
    );
    Assert.notEqual(copied[0].accountKey, sourceAccount.key);
    Assert.equal(copied[0].charset, "");
    assertNoStoredAccountOrCharset(copied[0], reader);
    assertNoStoredAccountOrCharset(original, reader);
    Assert.equal(
      readPublicationBytes(destination.getMsgInputStream(copied[0])),
      raw
    );
  } finally {
    reader.close();
  }
  Assert.deepEqual(source.msgDatabase.listAllKeys(), [key]);
  Assert.equal(original.storeToken, token);
  Assert.equal(readPublicationBytes(source.getMsgInputStream(original)), raw);
  PanoramaDelivery.assertFolder(source, lane);
  PanoramaDelivery.assertFolder(destination, lane);
});
