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
