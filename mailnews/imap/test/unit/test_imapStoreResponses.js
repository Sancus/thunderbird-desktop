/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * Selects three messages whose UIDs differ from their sequence numbers.
 *
 * @returns {{handler: IMAP_RFC3501_handler, messages: ImapMessage[]}}
 *   The selected handler and its messages in sequence order.
 */
function makeStoreFixture() {
  const daemon = new ImapDaemon();
  const messages = [41, 73, 105].map(uid => {
    const message = new ImapMessage("data:text/plain,", uid, []);
    message.setFlag("\\Seen");
    daemon.inbox.addMessage(message);
    return message;
  });
  const handler = new IMAP_RFC3501_handler(daemon);
  handler.SELECT(["INBOX"]);
  Assert.equal(handler._selectedMailbox, daemon.inbox);
  return { handler, messages };
}

add_task(function test_uidStoreReportsMessageUids() {
  const { handler, messages } = makeStoreFixture();
  Assert.equal(
    handler.UID(["STORE", "41,105", "+FLAGS", ["$Forwarded"]]),
    "* 1 FETCH (FLAGS (\\Seen $Forwarded) UID 41)\0" +
      "* 3 FETCH (FLAGS (\\Seen $Forwarded) UID 105)\0" +
      "OK STORE completed",
    "Each response keeps the sequence number and includes the actual UID"
  );
  Assert.deepEqual(
    messages.map(message => message.flags),
    [["\\Seen", "$Forwarded"], ["\\Seen"], ["\\Seen", "$Forwarded"]]
  );
  Assert.deepEqual(
    messages.map(message => message.uid),
    [41, 73, 105]
  );
});

add_task(function test_sequenceStorePreservesFlagsOnlyResponse() {
  const { handler, messages } = makeStoreFixture();
  Assert.equal(
    handler.STORE([2, "FLAGS", ["\\Flagged"]]),
    "* 2 FETCH (FLAGS (\\Flagged))\0OK STORE completed",
    "A sequence-number STORE retains its existing FLAGS-only response"
  );
  Assert.deepEqual(
    messages.map(message => message.flags),
    [["\\Seen"], ["\\Flagged"], ["\\Seen"]]
  );
});

add_task(function test_silentStoreChangesFlagsWithoutFetch() {
  for (const uid of [false, true]) {
    const { handler, messages } = makeStoreFixture();
    for (const [operation, flags, expected] of [
      ["+FLAGS.SILENT", ["\\Flagged"], ["\\Seen", "\\Flagged"]],
      ["-FLAGS.SILENT", ["\\Seen"], ["\\Flagged"]],
      ["FLAGS.SILENT", ["\\Answered"], ["\\Answered"]],
    ]) {
      const args = [uid ? "73" : 2, operation, flags];
      Assert.equal(
        uid ? handler.UID(["STORE", ...args]) : handler.STORE(args),
        "OK STORE completed",
        `${uid ? "UID " : ""}STORE ${operation} sends no FETCH response`
      );
      Assert.deepEqual(messages[1].flags, expected);
      Assert.deepEqual(messages[0].flags, ["\\Seen"]);
      Assert.deepEqual(messages[2].flags, ["\\Seen"]);
    }
  }
});

add_task(function test_missingUidAndBadOperationPreserveMessages() {
  const { handler, messages } = makeStoreFixture();
  Assert.equal(
    handler.UID(["STORE", "999", "+FLAGS", ["\\Flagged"]]),
    "OK STORE completed"
  );
  Assert.deepEqual(
    messages.map(message => message.flags),
    [["\\Seen"], ["\\Seen"], ["\\Seen"]]
  );
  Assert.equal(handler.STORE([2, "INVALID", []]), "BAD change what now?");
  Assert.deepEqual(
    messages.map(message => message.flags),
    [["\\Seen"], ["\\Seen"], ["\\Seen"]]
  );
});

/**
 * Adds a UIDPLUS destination with a different UIDVALIDITY and UID range.
 *
 * @returns {{handler: IMAP_RFC3501_handler, messages: ImapMessage[],
 *   destination: ImapMailbox}} The selected source and distinct destination.
 */
function makeUidplusTransferFixture() {
  const { IMAP_MOVE_extension } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/Imapd.sys.mjs"
  );
  const { handler, messages } = makeStoreFixture();
  mixinExtension(handler, IMAP_MOVE_extension);
  mixinExtension(handler, IMAP_RFC4315_extension);
  handler._selectedMailbox.uidvalidity = 111;
  messages.forEach((message, index) => {
    message._URI =
      "data:text/plain," +
      encodeURIComponent(
        `Subject: source ${index}\r\n\r\nExact body ${index}.\r\n`
      );
  });
  Assert.ok(
    handler._daemon.createMailbox("destination", {
      uidvalidity: 9001,
      uidnext: 501,
    })
  );
  const destination = handler._daemon.getMailbox("destination");
  Assert.equal(destination.uidvalidity, 9001);
  Assert.equal(destination.uidnext, 501);
  return { handler, messages, destination };
}

add_task(function test_uidplusCopyUsesDestinationAndActualSourceUids() {
  for (const uid of [false, true]) {
    const { handler, messages, destination } = makeUidplusTransferFixture();
    const source = [...messages];
    const response = uid
      ? handler.UID(["COPY", "41,999,105", "destination"])
      : handler.COPY(["1,3,99", "destination"]);
    Assert.equal(response, "OK [COPYUID 9001 41,105 501:502] COPY completed");
    Assert.deepEqual(
      destination._messages.map(message => message.uid),
      [501, 502]
    );
    Assert.deepEqual(
      destination._messages.map(message => message.getText()),
      [source[0].getText(), source[2].getText()]
    );
    Assert.deepEqual(
      destination._messages.map(message => message.flags),
      [["\\Seen"], ["\\Seen"]]
    );
    Assert.deepEqual(handler._selectedMailbox._messages, source);
    Assert.notEqual(destination._messages[0].flags, source[0].flags);
    Assert.equal(destination.uidnext, 503);
  }
});

add_task(function test_uidplusMoveMapsUidsBeforeExpunge() {
  for (const uid of [false, true]) {
    const { handler, messages, destination } = makeUidplusTransferFixture();
    const source = [...messages];
    const response = uid
      ? handler.UID(["MOVE", "41,999,105", "destination"])
      : handler.MOVE(["1,3,99", "destination"]);
    Assert.equal(
      response,
      "* 3 EXPUNGE\0* 1 EXPUNGE\0OK [COPYUID 9001 41,105 501:502] completed"
    );
    Assert.deepEqual(
      destination._messages.map(message => message.uid),
      [501, 502]
    );
    Assert.deepEqual(
      destination._messages.map(message => message.getText()),
      [source[0].getText(), source[2].getText()]
    );
    Assert.deepEqual(
      destination._messages.map(message => message.flags),
      [["\\Seen"], ["\\Seen"]]
    );
    Assert.deepEqual(handler._selectedMailbox._messages, [source[1]]);
    Assert.notEqual(destination._messages[0].flags, source[0].flags);
    Assert.equal(destination.uidnext, 503);
  }
});

add_task(function test_uidplusEmptyAndRejectedTransfersPreserveMessages() {
  for (const command of ["COPY", "MOVE"]) {
    const { handler, messages, destination } = makeUidplusTransferFixture();
    const source = [...messages];
    Assert.equal(
      handler.UID([command, "999", "destination"]),
      `OK ${command} completed`,
      "An empty match has no invented COPYUID mapping"
    );
    Assert.equal(
      handler.UID([command, "73", "missing"]),
      "NO [TRYCREATE] what mailbox?",
      "A missing destination keeps the original refusal"
    );
    Assert.throws(
      () => handler.UID([command, "invalid", "destination"]),
      /BAD invalid UID/,
      "An invalid source set keeps the original error"
    );
    Assert.deepEqual(handler._selectedMailbox._messages, source);
    Assert.deepEqual(destination._messages, []);
    Assert.equal(destination.uidnext, 501);
    Assert.deepEqual(
      source.map(message => message.flags),
      [["\\Seen"], ["\\Seen"], ["\\Seen"]]
    );
  }
});

add_task(function test_uidplusExpungeOnlyRequestedDeletedUids() {
  const { handler, messages, destination } = makeUidplusTransferFixture();
  const mailbox = handler._selectedMailbox;
  messages[0].setFlag("\\Deleted");
  messages[1].setFlag("\\Deleted");
  const uidnext = mailbox.uidnext;
  let synchronized = 0;
  handler._daemon.syncFunc = () => {
    synchronized++;
  };

  Assert.equal(
    handler.UID(["EXPUNGE", "1,41,105,999"]),
    "* 1 EXPUNGE\0OK UID EXPUNGE completed"
  );
  Assert.deepEqual(mailbox._messages, [messages[1], messages[2]]);
  Assert.equal(mailbox._messages[0], messages[1]);
  Assert.equal(mailbox._messages[1], messages[2]);
  Assert.deepEqual(messages[1].flags, ["\\Seen", "\\Deleted"]);
  Assert.deepEqual(messages[2].flags, ["\\Seen"]);
  Assert.deepEqual(destination._messages, []);
  Assert.equal(mailbox.uidnext, uidnext);
  Assert.equal(synchronized, 1);

  Assert.equal(
    handler.UID(["EXPUNGE", "1:2,999"]),
    "OK UID EXPUNGE completed",
    "Sequence numbers must not remove different UIDs"
  );
  Assert.deepEqual(mailbox._messages, [messages[1], messages[2]]);
  Assert.equal(synchronized, 2);
});

add_task(function test_uidplusExpungeRangesAndSequenceRenumbering() {
  for (const set of ["105:41,73,41", "41:*"]) {
    const { handler, messages } = makeUidplusTransferFixture();
    const mailbox = handler._selectedMailbox;
    const uidnext = mailbox.uidnext;
    for (const message of messages) {
      message.setFlag("\\Deleted");
    }
    Assert.equal(mailbox._highestuid, 105);
    Assert.equal(
      handler.UID(["EXPUNGE", set]),
      "* 1 EXPUNGE\0* 1 EXPUNGE\0* 1 EXPUNGE\0OK UID EXPUNGE completed",
      "Overlapping UID members produce one current sequence response per message"
    );
    Assert.deepEqual(mailbox._messages, []);
    Assert.equal(mailbox._highestuid, 0);
    Assert.equal(mailbox.uidnext, uidnext);
    Assert.equal(handler.UID(["EXPUNGE", "*"]), "OK UID EXPUNGE completed");
  }
});

add_task(function test_uidplusExpungeRefusalsPreserveMessages() {
  const { handler, messages } = makeUidplusTransferFixture();
  messages[0].setFlag("\\Deleted");
  const source = [...messages];
  let synchronized = 0;
  handler._daemon.syncFunc = () => {
    synchronized++;
  };
  for (const args of [
    ["EXPUNGE"],
    ["EXPUNGE", "41", "73"],
    ["EXPUNGE", "invalid"],
    ["EXPUNGE", "0"],
    ["EXPUNGE", "41,"],
    ["EXPUNGE", "41::105"],
    ["EXPUNGE", ["41"]],
  ]) {
    Assert.equal(handler.UID(args), "BAD invalid UID EXPUNGE sequence set");
    Assert.deepEqual(handler._selectedMailbox._messages, source);
  }
  handler._tag = "T1";
  handler._daemon.commandToFail = "UID";
  Assert.equal(
    handler._dispatchCommand("UID", ["EXPUNGE", "41"]),
    "T1 NO UID failed",
    "The existing forced command refusal runs before UID EXPUNGE"
  );
  handler._daemon.commandToFail = "";
  handler._readOnly = true;
  Assert.equal(handler.UID(["EXPUNGE", "41"]), "NO mailbox is read-only");
  handler._readOnly = false;
  handler._state = 1;
  Assert.equal(
    handler._dispatchCommand("UID", ["EXPUNGE", "41"]),
    "T1 BAD illegal command for current state 1"
  );
  Assert.deepEqual(handler._selectedMailbox._messages, source);
  Assert.deepEqual(messages[0].flags, ["\\Seen", "\\Deleted"]);
  Assert.equal(synchronized, 0);
});

add_task(function test_uidplusPreservesOrdinaryExpungeAndUnsupportedUid() {
  const { handler, messages } = makeStoreFixture();
  messages[0].setFlag("\\Deleted");
  messages[2].setFlag("\\Deleted");
  Assert.equal(handler.UID(["EXPUNGE", "41"]), "BAD illegal command EXPUNGE");
  Assert.deepEqual(handler._selectedMailbox._messages, messages);
  mixinExtension(handler, IMAP_RFC4315_extension);
  Assert.equal(handler.UID(["UNKNOWN", "41"]), "BAD illegal command UNKNOWN");
  Assert.equal(
    handler.EXPUNGE(),
    "* 1 EXPUNGE\0* 2 EXPUNGE\0OK EXPUNGE completed",
    "Ordinary EXPUNGE still removes every deleted message"
  );
  Assert.deepEqual(handler._selectedMailbox._messages, [messages[1]]);
});
