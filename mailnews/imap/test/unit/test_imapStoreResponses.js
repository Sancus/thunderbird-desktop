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
