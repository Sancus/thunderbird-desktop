/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

let root;

add_setup(function () {
  do_get_profile();
  const contract = "@mozilla.org/msgstore/berkeleystore;1";
  Services.prefs.setCharPref("mail.serverDefaultStoreContractID", contract);
  Services.prefs.setCharPref("mail.server.default.storeContractID", contract);
  loadExistingDB();
  Assert.equal(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"]
      .getService(Ci.nsIMsgDBService)
      .QueryInterface(Ci.nsIDatabaseCore),
    database
  );
  const account = MailServices.accounts.createLocalMailAccount();
  registerCleanupFunction(() => {
    MailServices.accounts.removeAccount(account, false);
    Services.prefs.clearUserPref("mail.serverDefaultStoreContractID");
    Services.prefs.clearUserPref("mail.server.default.storeContractID");
  });
  root = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  Assert.equal(root.msgStore.storeType, "mbox");
  Assert.equal(root.server.getStringValue("storeContractID"), contract);
});

function makeDraft(db, id) {
  const header = db.createNewHdr();
  header.messageId = id;
  header.subject = "Exact subject";
  header.author = "Author <author@example.invalid>";
  header.recipients = "To <to@example.invalid>";
  header.ccList = "cc@example.invalid";
  header.bccList = "bcc@example.invalid";
  header.date = 1234567000000;
  header.priority = Ci.nsMsgPriority.high;
  header.flags = Ci.nsMsgMessageFlags.Read;
  header.setStringProperty("custom", "00042");
  header.setStringProperty("Custom", "different");
  header.setStringProperty("empty", "");
  header.accountKey = "";
  header.charset = "ISO-8859-1";
  header.setStringProperty("keywords", "tag1 tag2");
  header.messageSize = 0;
  header.storeToken = "";
  return header;
}

function checkCopy(header, folder) {
  Assert.equal(header.folder, folder);
  Assert.equal(header.subject, "Exact subject");
  Assert.equal(header.author, "Author <author@example.invalid>");
  Assert.equal(header.recipients, "To <to@example.invalid>");
  Assert.equal(header.ccList, "cc@example.invalid");
  Assert.equal(header.bccList, "bcc@example.invalid");
  Assert.equal(header.date, 1234567000000);
  Assert.equal(header.priority, Ci.nsMsgPriority.high);
  Assert.equal(header.flags, Ci.nsMsgMessageFlags.Read);
  Assert.equal(header.getStringProperty("custom"), "00042");
  Assert.equal(header.getStringProperty("Custom"), "different");
  Assert.equal(header.getStringProperty("empty"), "");
  Assert.equal(header.accountKey, "");
  Assert.equal(header.charset, "ISO-8859-1");
  Assert.equal(header.getStringProperty("keywords"), "tag1 tag2");
  const names = header.properties;
  for (const name of ["empty", "account", "messageSize", "storeToken"]) {
    Assert.ok(names.includes(name), name + " is explicitly present");
  }
  Assert.ok(!names.includes("offlineMessageSize"));
  Assert.ok(!names.includes("lineCount"));
  Assert.equal(header.messageSize, 0);
  Assert.equal(header.storeToken, "");
}

function storedReferences(key) {
  const statement = database.connectionForTests.createStatement(
    "SELECT token FROM message_references WHERE id = :id ORDER BY ordinal"
  );
  statement.params.id = key;
  const result = [];
  try {
    while (statement.executeStep()) {
      result.push(statement.row.token);
    }
  } finally {
    statement.finalize();
  }
  return result;
}

add_task(function test_copyDetachedHeaderWithoutPublishing() {
  const source = root.createLocalSubfolder("copy-draft-source");
  const destination = root.createLocalSubfolder("copy-draft-destination");
  const original = makeDraft(source.msgDatabase, "draft@copy.invalid");
  original.setReferences("<first@copy.invalid> <last@copy.invalid>");
  const db = destination.msgDatabase;
  const copy = db.copyHdrFromExistingHdr(0xffffffff, original, false);
  Assert.equal(copy.isLive, false);
  Assert.equal(copy.messageKey, 0xffffffff);
  Assert.deepEqual(db.listAllKeys(), []);
  checkCopy(copy, destination);
  copy.subject = "Changed copy";
  Assert.equal(original.subject, "Exact subject");
  const live = db.attachHdr(copy, false);
  Assert.equal(live.subject, "Changed copy");
  Assert.equal(live.numReferences, 2);
  Assert.equal(live.getStringReference(1), "last@copy.invalid");
  Assert.deepEqual(storedReferences(live.messageKey), [
    "first@copy.invalid",
    "last@copy.invalid",
  ]);
});

add_task(
  function test_copyLiveHeaderPreservesLiteralReferencesAndPublishesOnce() {
    const source = root.createLocalSubfolder("copy-live-source");
    const destination = root.createLocalSubfolder("copy-live-destination");
    const original = source.msgDatabase.attachHdr(
      makeDraft(source.msgDatabase, "self@copy.invalid"),
      false
    );
    original.setReferences(
      "<first@copy.invalid> <self@copy.invalid> <unresolved@copy.invalid> <first@copy.invalid>"
    );
    Assert.equal(original.getStringProperty("keywords"), "tag1 tag2");
    Assert.ok(!original.properties.includes("keywords"));
    const db = destination.msgDatabase;
    const added = [];
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
        checkCopy(header, destination);
        added.push(header.messageKey);
        Assert.deepEqual(storedReferences(header.messageKey), [
          "first@copy.invalid",
          "self@copy.invalid",
          "unresolved@copy.invalid",
          "first@copy.invalid",
        ]);
      },
    };
    db.addListener(listener);
    let copy;
    try {
      copy = db.copyHdrFromExistingHdr(0xffffffff, original, true);
    } finally {
      db.removeListener(listener);
    }
    Assert.ok(copy.isLive);
    Assert.notEqual(copy.messageKey, original.messageKey);
    Assert.deepEqual(added, [copy.messageKey]);
    Assert.deepEqual(db.listAllKeys(), [copy.messageKey]);
    Assert.equal(original.folder, source);
    Assert.equal(copy.numReferences, 3);
    Assert.equal(copy.getStringReference(2), "first@copy.invalid");
  }
);

add_task(function test_copyErrorsLeaveDestinationUnchanged() {
  const source = root.createLocalSubfolder("copy-error-source");
  const destination = root.createLocalSubfolder("copy-error-destination");
  const original = source.msgDatabase.attachHdr(
    makeDraft(source.msgDatabase, "error@copy.invalid"),
    false
  );
  const db = destination.msgDatabase;
  Assert.throws(
    () => db.copyHdrFromExistingHdr(123, original, true),
    /NS_ERROR_NOT_IMPLEMENTED/
  );
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER reject_copy BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'copy error'); END"
  );
  try {
    Assert.throws(
      () => db.copyHdrFromExistingHdr(0xffffffff, original, true),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.deepEqual(db.listAllKeys(), []);
    Assert.equal(
      source.msgDatabase.getMsgHdrForKey(original.messageKey).messageId,
      "error@copy.invalid"
    );
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_copy");
  }
});

add_task(function test_unavailableReferencesDoNotBecomeKnownEmptyCopies() {
  const source = root.createLocalSubfolder("copy-unavailable-source");
  const destination = root.createLocalSubfolder("copy-unavailable-destination");
  const original = source.msgDatabase.attachHdr(
    makeDraft(source.msgDatabase, "unavailable@copy.invalid"),
    false
  );
  database.connectionForTests.executeSimpleSQL(
    "DELETE FROM message_reference_sets WHERE id = " + original.messageKey
  );
  Assert.throws(
    () =>
      destination.msgDatabase.copyHdrFromExistingHdr(
        0xffffffff,
        original,
        true
      ),
    /NS_ERROR_NOT_AVAILABLE/
  );
  Assert.deepEqual(destination.msgDatabase.listAllKeys(), []);
  Assert.equal(original.folder, source);
});

add_task(function test_liveHeaderFolderRemainsReadableAfterDeletion() {
  const folder = root.createLocalSubfolder("header-folder-deleted");
  const db = folder.msgDatabase;
  const header = db.attachHdr(makeDraft(db, "folder@copy.invalid"), false);
  const key = header.messageKey;
  const uri = folder.URI;
  Assert.equal(header.folder, folder);
  const deleted = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged() {},
    onHdrAdded() {},
    onParentChanged() {},
    onAnnouncerGoingAway() {},
    onReadChanged() {},
    onJunkScoreChanged() {},
    onHdrPropertyChanged() {},
    onEvent() {},
    onHdrDeleted(removed) {
      Assert.equal(removed.messageKey, key);
      Assert.equal(removed.folder, folder);
      Assert.equal(removed.folder.URI, uri);
      Assert.ok(!db.containsKey(key));
      deleted.push(removed.messageKey);
    },
  };
  db.addListener(listener);
  try {
    messageDB.removeMessage(key);
  } finally {
    db.removeListener(listener);
  }
  Assert.deepEqual(deleted, [key]);
  Assert.equal(header.folder, folder);
  Assert.equal(header.folder.URI, uri);
  Assert.ok(!db.containsKey(key));
});

add_task(function test_logicalRecipientsSurviveDraftAttachmentAndCopy() {
  const source = root.createLocalSubfolder("logical-recipients-source");
  const destination = root.createLocalSubfolder("logical-recipients-copy");
  const db = source.msgDatabase;
  const inputs = [
    "",
    "ASCII <ascii@mime.invalid>",
    "Müller <unicode@mime.invalid>, 中文 <other@mime.invalid>",
    '"=?UTF-8?Q?hello?=" <literal@mime.invalid>',
  ];
  for (const [index, recipients] of inputs.entries()) {
    const draft = makeDraft(db, `recipients-${index}@mime.invalid`);
    draft.recipients = recipients;
    // Native header fields already contain logical UTF-8. An unrelated body
    // charset must not reinterpret them or decode literal encoded words again.
    draft.charset = "windows-1252";
    const draftProperties = draft.properties;
    Assert.equal(draft.mime2DecodedRecipients, recipients);
    Assert.equal(draft.recipients, recipients);
    Assert.deepEqual(draft.properties, draftProperties);
    const header = db.attachHdr(draft, false);
    Assert.strictEqual(header.folder, source);
    Assert.equal(header.mime2DecodedRecipients, recipients);
    Assert.equal(header.recipients, recipients);
    Assert.equal(header.charset, "windows-1252");
    const properties = header.properties;
    Assert.equal(header.mime2DecodedRecipients, recipients);
    Assert.deepEqual(header.properties, properties);
    const copy = destination.msgDatabase.copyHdrFromExistingHdr(
      0xffffffff,
      header,
      true
    );
    Assert.notEqual(copy.messageKey, header.messageKey);
    Assert.strictEqual(copy.folder, destination);
    Assert.equal(copy.recipients, recipients);
    Assert.equal(copy.mime2DecodedRecipients, recipients);
    Assert.equal(header.mime2DecodedRecipients, recipients);
    Assert.strictEqual(header.folder, source);
  }
});

add_task(function test_decodedRecipientsPropagateActualHeaderReadErrors() {
  const connection = database.connectionForTests;
  const row = connection.createStatement("SELECT 1 FROM messages WHERE id = 0");
  try {
    Assert.ok(
      !row.executeStep(),
      "The negative key has no physical message row"
    );
  } finally {
    row.finalize();
  }
  // Use the actual public factory's missing-key input, not a stand-in header.
  const missing = messageDB.getMessage(0);
  Assert.throws(() => missing.recipients, /NS_ERROR_UNEXPECTED/);
  Assert.throws(() => missing.mime2DecodedRecipients, /NS_ERROR_UNEXPECTED/);
  connection.executeSimpleSQL(
    "ALTER TABLE messages RENAME TO unavailable_recipient_messages"
  );
  try {
    Assert.throws(
      () => missing.recipients,
      error => error.result === Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => missing.mime2DecodedRecipients,
      error => error.result === Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_recipient_messages RENAME TO messages"
    );
  }
});

add_task(function test_effectiveCharsetPreservesRawValuesAndPresence() {
  const folder = root.createLocalSubfolder("effective-charset");
  const db = folder.msgDatabase;
  const draft = db.createNewHdr();
  draft.messageId = "charset-absent@mime.invalid";
  const properties = draft.properties;
  Assert.ok(!properties.includes("msgCharSet"));
  Assert.equal(draft.charset, "");
  Assert.equal(draft.effectiveCharset, "UTF-8");
  Assert.deepEqual(draft.properties, properties);
  const header = db.attachHdr(draft, false);
  Assert.strictEqual(header.folder, folder);
  Assert.equal(header.effectiveCharset, "UTF-8");
  Assert.ok(!header.properties.includes("msgCharSet"));
  for (const [index, charset] of [
    "",
    "us-ascii",
    "US-ASCII",
    "ISO-8859-1",
    "UTF-8",
    "X-Exact",
  ].entries()) {
    const pending = makeDraft(db, `charset-${index}@mime.invalid`);
    pending.charset = charset;
    const expected = !charset || charset === "us-ascii" ? "UTF-8" : charset;
    const before = pending.properties;
    Assert.ok(before.includes("msgCharSet"));
    Assert.equal(pending.charset, charset);
    Assert.equal(pending.effectiveCharset, expected);
    Assert.deepEqual(pending.properties, before);
    const attached = db.attachHdr(pending, false);
    const attachedProperties = attached.properties;
    Assert.ok(attachedProperties.includes("msgCharSet"));
    Assert.equal(attached.charset, charset);
    Assert.equal(attached.effectiveCharset, expected);
    Assert.deepEqual(attached.properties, attachedProperties);
    Assert.strictEqual(attached.folder, folder);
  }
});

add_task(function test_effectiveNewsCharsetUsesActualServer() {
  const server = MailServices.accounts.createIncomingServer(
    "",
    "charset.invalid",
    "nntp"
  );
  const account = MailServices.accounts.createAccount();
  account.incomingServer = server;
  registerCleanupFunction(() =>
    MailServices.accounts.removeAccount(account, false)
  );
  const news = server.QueryInterface(Ci.nsINntpIncomingServer);
  news.charset = "windows-1251";
  const folder = server.rootFolder
    .QueryInterface(Ci.nsIMsgNewsFolder)
    .addNewsgroup("charset.group", "");
  Assert.strictEqual(folder.server, server);
  const db = database
    .QueryInterface(Ci.nsIMsgDBService)
    .openFolderDB(folder, false);
  for (const [index, charset] of [
    "",
    "us-ascii",
    "US-ASCII",
    "ISO-8859-1",
  ].entries()) {
    const pending = makeDraft(db, `news-charset-${index}@mime.invalid`);
    pending.charset = charset;
    const expected =
      !charset || charset === "us-ascii" ? "windows-1251" : charset;
    Assert.strictEqual(pending.folder, folder);
    Assert.equal(pending.effectiveCharset, expected);
    Assert.equal(pending.charset, charset);
    const header = db.attachHdr(pending, false);
    Assert.strictEqual(header.folder, folder);
    Assert.equal(header.effectiveCharset, expected);
    Assert.equal(header.charset, charset);
  }
});

add_task(function test_effectiveCharsetKeepsOriginalReadErrors() {
  const connection = database.connectionForTests;
  const row = connection.createStatement("SELECT 1 FROM messages WHERE id = 0");
  try {
    Assert.ok(!row.executeStep());
  } finally {
    row.finalize();
  }
  const folder = root.createLocalSubfolder("charset-read-error");
  const db = folder.msgDatabase;
  const pending = makeDraft(db, "charset-read-error@mime.invalid");
  const header = db.attachHdr(pending, false);
  connection.executeSimpleSQL(
    "ALTER TABLE message_properties RENAME TO unavailable_charset_properties"
  );
  try {
    Assert.throws(
      () => header.charset,
      error => error.result === Cr.NS_ERROR_FAILURE
    );
    Assert.throws(
      () => header.effectiveCharset,
      error => error.result === Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_charset_properties RENAME TO message_properties"
    );
  }
  Assert.equal(header.charset, "ISO-8859-1");
  Assert.equal(header.effectiveCharset, "ISO-8859-1");
  const missing = messageDB.getMessage(0);
  Assert.equal(missing.charset, "");
  Assert.throws(() => missing.effectiveCharset, /NS_ERROR_UNEXPECTED/);
  connection.executeSimpleSQL(
    "ALTER TABLE messages RENAME TO unavailable_charset_messages"
  );
  try {
    Assert.throws(
      () => missing.effectiveCharset,
      error => error.result === Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_charset_messages RENAME TO messages"
    );
  }
});

add_task(function test_publicHeaderLivenessTracksPublishedMembership() {
  const folder = root.createLocalSubfolder("header-liveness");
  const db = folder.msgDatabase;
  const pending = makeDraft(db, "live@header.invalid");
  Assert.ok(!pending.isLive);
  const header = db.attachHdr(pending, false);
  const key = header.messageKey;
  Assert.ok(header.isLive);
  Assert.ok(db.containsKey(key));
  const connection = database.connectionForTests;
  connection.beginTransaction();
  try {
    Assert.ok(header.isLive);
    Assert.ok(connection.transactionInProgress);
  } finally {
    connection.rollbackTransaction();
  }
  Assert.ok(!connection.transactionInProgress);
  Assert.equal(header.subject, "Exact subject");
  db.deleteMessages([key], null);
  Assert.ok(!db.containsKey(key));
  Assert.ok(!header.isLive, "A retained removed header is not published");
  Assert.equal(header.subject, "Exact subject");
  const remaining = db.listAllKeys();
  const count = db.dBFolderInfo.numMessages;
  Assert.throws(
    () => db.attachHdr(header, false),
    error => error.result === Cr.NS_ERROR_ILLEGAL_VALUE
  );
  Assert.throws(
    () => db.copyHdrFromExistingHdr(0xffffffff, header, true),
    error => error.result === Cr.NS_ERROR_ILLEGAL_VALUE
  );
  Assert.deepEqual(db.listAllKeys(), remaining);
  Assert.equal(db.dBFolderInfo.numMessages, count);
  const missing = messageDB.getMessage(0);
  Assert.ok(!missing.isLive, "A factory key view does not imply membership");
  Assert.throws(
    () => db.attachHdr(missing, false),
    error => error.result === Cr.NS_ERROR_ILLEGAL_VALUE
  );
  Assert.throws(
    () => db.copyHdrFromExistingHdr(0xffffffff, missing, true),
    error => error.result === Cr.NS_ERROR_UNEXPECTED
  );
  Assert.deepEqual(db.listAllKeys(), remaining);
  Assert.equal(db.dBFolderInfo.numMessages, count);
});

add_task(function test_headerLivenessPreservesStorageErrors() {
  const folder = root.createLocalSubfolder("header-liveness-error");
  const db = folder.msgDatabase;
  const pending = makeDraft(db, "live-error@header.invalid");
  const header = db.attachHdr(pending, false);
  Assert.ok(header.isLive);
  const connection = database.connectionForTests;
  connection.executeSimpleSQL(
    "ALTER TABLE messages RENAME TO unavailable_live_messages"
  );
  try {
    Assert.throws(
      () => header.isLive,
      error => error.result === Cr.NS_ERROR_FAILURE
    );
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_live_messages RENAME TO messages"
    );
  }
  Assert.ok(header.isLive);
});
