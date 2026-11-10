/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { MorkParser } = ChromeUtils.importESModule(
  "resource:///modules/MorkParser.sys.mjs"
);
const { MailStringUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailStringUtils.sys.mjs"
);

const { parseMorkSummary } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MorkSummaryReader.sys.mjs"
);
const { parseMorkAddressBook } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MorkAddressBookReader.sys.mjs"
);
const { parseMorkFolderCache } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MorkFolderCache.sys.mjs"
);

add_task(async function test_legacySummarySnapshot() {
  const bytes = await IOUtils.read(do_get_file("data/migration.msf").path);
  const original = bytes.slice();
  const { messages, source } = parseMorkSummary(bytes);
  Assert.deepEqual(
    messages.map(message => message.sourceKey),
    [1, 3]
  );
  Assert.deepEqual(
    messages.map(message => message.messageId),
    ["162378@invalid", "345692@invalid"]
  );
  Assert.deepEqual(
    messages.map(message => message.storeToken),
    ["0", "1143"]
  );
  Assert.deepEqual(
    messages.map(message => message.messageSize),
    [578, 375]
  );
  Assert.deepEqual(
    messages.map(message => message.references),
    [[], []]
  );
  Assert.equal(messages[0].threadId, 0xfffffffe);
  Assert.equal(messages[1].threadId, 3);
  Assert.equal(messages[0].threadParent, 0xffffffff);
  Assert.ok(messages[0].properties.has("references"));
  Assert.equal(messages[0].properties.get("references"), "");
  Assert.equal(
    messages[0].properties.get("size"),
    "242",
    "Structural parsing keeps exact original text"
  );
  Assert.ok(
    source.rows.has("1:m"),
    "Thread metadata is retained for the coordinator"
  );
  Assert.deepEqual(bytes, original, "Parsing does not mutate input");
});

add_task(function test_exactPropertiesAndOrderedAncestors() {
  // Grammar unit input; the legacy-produced MSF above supplies format coverage.
  const input = String.raw`// <!-- <mdb:mork:z v="1.4"/> -->
< <(a=c)> (80=ns:msg:db:row:scope:msgs:all)(81=ns:msg:db:table:kind:msgs)
(82=message-id)(83=references)(84=Foo)(85=foo)(86=$C3$A9)(87=e$CC$81)(88=empty)>
{1:^80 {(k^81:c)(s=9)}
[1(^82=self)(^83=<root> <parent> <root> <self>)(^84=2a)(^85=00042)
(^86=one)(^87=two)(^88=)]
[2(^82=second)(^83=   legacy undelimited)]}
`;
  const { messages } = parseMorkSummary(new TextEncoder().encode(input));
  const properties = messages[0].properties;
  Assert.equal(properties.get("Foo"), "2a");
  Assert.equal(properties.get("foo"), "00042");
  Assert.equal(properties.get("é"), "one");
  Assert.equal(properties.get("e\u0301"), "two");
  Assert.ok(properties.has("empty"));
  Assert.equal(properties.get("empty"), "");
  Assert.ok(!properties.has("absent"));
  Assert.deepEqual(messages[0].references, ["root", "parent", "root"]);
  Assert.deepEqual(messages[1].references, ["legacy undelimited"]);
});

add_task(function test_cellsThatAreNotUTF8AreCarriedAsBytes() {
  // Old mail has raw 8-bit header bytes. nsMsgHdr keeps a cell as bytes and
  // decodes the displayed fields with the message's character set, so such a
  // cell is data: its text is its bytes read as ISO-8859-1, which keeps every
  // byte, and the bytes stay beside it for that decoding.
  const input = String.raw`// <!-- <mdb:mork:z v="1.4"/> -->
< <(a=c)> (80=ns:msg:db:row:scope:msgs:all)(81=ns:msg:db:table:kind:msgs)
(82=message-id)(83=subject)(84=sender)(85=custom)>
{1:^80 {(k^81:c)(s=9)}
[1(^82=raw)(^83=caf$E9 $FC$F1)(^84=Andr$C3$A9)(^85=$FF$FE)]
[2(^82=plain)(^83=Plain)]}
`;
  const { messages, source } = parseMorkSummary(
    Uint8Array.from(input, character => character.charCodeAt(0))
  );
  const [raw, plain] = messages;
  Assert.equal(raw.properties.get("subject"), "café üñ");
  Assert.equal(raw.properties.get("custom"), "ÿþ");
  Assert.equal(raw.properties.get("sender"), "André", "UTF-8 is decoded");
  Assert.deepEqual(
    [...raw.rawCells],
    [
      ["subject", "caf\xe9 \xfc\xf1"],
      ["custom", "\xff\xfe"],
    ],
    "Only the cells that are not UTF-8 keep their bytes beside the text"
  );
  Assert.ok(!("rawCells" in plain), "A UTF-8 header has no such cells");
  Assert.equal(
    source.rows.get("1:ns:msg:db:row:scope:msgs:all").cells.get("subject"),
    "caf\xe9 \xfc\xf1",
    "The original snapshot keeps the exact bytes"
  );
});

add_task(function test_summaryFactsReadFolderInfoOnce() {
  const { readMorkSummaryFacts } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MorkSummaryReader.sys.mjs"
  );
  const document = info =>
    Uint8Array.from(
      '// <!-- <mdb:mork:z v="1.4"/> -->\n' +
        "< <(a=c)> (80=ns:msg:db:row:scope:msgs:all)" +
        "(81=ns:msg:db:table:kind:msgs)" +
        "(82=ns:msg:db:row:scope:dbfolderinfo:all)" +
        "(83=ns:msg:db:table:kind:dbfolderinfo)" +
        "(84=flags)(85=onlineName)(86=folderName)(87=subject)>\n" +
        "{1:^80 {(k^81:c)(s=9)} [1(^87=not$FFutf8)]}\n" +
        info,
      character => character.charCodeAt(0)
    );
  Assert.deepEqual(
    readMorkSummaryFacts(
      document("{1:^82 {(k^83:c)(s=9)} [1(^84=1c)(^85=INBOX/caf$C3$A9)]}\n")
    ),
    { infoRows: 1, flags: "1c", onlineName: "INBOX/caf\xc3\xa9" },
    "Cells are original bytes; an absent cell is absent"
  );
  Assert.deepEqual(readMorkSummaryFacts(document("")), { infoRows: 0 });
  Assert.equal(
    readMorkSummaryFacts(
      document("{1:^82 {(k^83:c)(s=9)} [1(^86=First)] [2(^86=Second)]}\n")
    ).infoRows,
    2,
    "The caller decides what more than one folder-info row means"
  );
});

add_task(function test_threadRelationsFollowHeadersNotStaleThreadTables() {
  // Each header's own row names its thread and parent. The per-thread tables
  // and their cached root are a derived index real summaries leave stale.
  const { getMorkThreadRelations, getMorkThreadFlags } =
    ChromeUtils.importESModule(
      "resource:///modules/panorama/MigrationMessageMap.sys.mjs"
    );
  const summary = body =>
    parseMorkSummary(
      new TextEncoder().encode(
        '// <!-- <mdb:mork:z v="1.4"/> -->\n' +
          "< <(a=c)> (80=ns:msg:db:row:scope:msgs:all)" +
          "(81=ns:msg:db:table:kind:msgs)(82=ns:msg:db:table:kind:thread)" +
          "(83=msgThreadId)(84=threadParent)(85=threadRoot)(86=threadFlags)" +
          "(87=threadId)(88=children)>\n" +
          body
      )
    );
  const relations = body =>
    Object.fromEntries(
      [...getMorkThreadRelations(summary(body))].map(([key, value]) => [
        key,
        [value.root, value.parent],
      ])
    );
  // A consistent thread: root 2, child 3 below it, grandchild 4 below 3.
  const clean =
    "{1:^80 {(k^81:c)(s=9)} [2(^83=2)] [3(^83=2)(^84=2)] [4(^83=2)(^84=3)]}\n" +
    "{2:^80 {(k^82:c)(s=9) [2:m(^87=2)(^85=2)(^86=0)(^88=3)]} 2 3 4}\n";
  Assert.deepEqual(relations(clean), {
    2: [2, null],
    3: [2, 2],
    4: [2, 3],
  });
  Assert.deepEqual(
    relations(
      // The cached root (2) left the thread and was the parent of 3; the
      // parent of 5 was deleted; 6 names itself; 7 names a header of another
      // thread; 8 and 9 form a cycle; thread 14 has no table at all; header
      // 20 has no thread.
      "{1:^80 {(k^81:c)(s=9)} [3(^83=2)(^84=2)] [4(^83=2)(^84=3)]" +
        " [5(^83=2)(^84=63)] [6(^83=2)(^84=6)] [7(^83=2)(^84=14)]" +
        " [8(^83=2)(^84=9)] [9(^83=2)(^84=8)]" +
        " [14(^83=14)] [15(^83=14)(^84=14)] [20]}\n" +
        "{2:^80 {(k^82:c)(s=9) [2:m(^87=2)(^85=2)(^86=0)(^88=63)]} 3 4 9}\n"
    ),
    {
      3: [3, null],
      4: [3, 3],
      5: [3, 3],
      6: [3, 3],
      7: [3, 3],
      8: [3, 3],
      9: [3, 8],
      20: [20, null],
      21: [20, 20],
      32: [32, null],
    },
    "A header whose parent is not in its thread hangs below the root"
  );
  // The watch/ignore word is user data, read from the thread's own table.
  const watched = summary(
    "{1:^80 {(k^81:c)(s=9)} [2(^83=2)] [3(^83=2)(^84=2)] [9(^83=9)]}\n" +
      "{2:^80 {(k^82:c)(s=9) [2:m(^87=2)(^85=2)(^86=100)(^88=2)]} 2 3}\n" +
      "{9:^80 {(k^82:c)(s=9) [9:m(^87=9)(^85=9)(^86=not-hex)]} 9}\n"
  );
  Assert.deepEqual(
    getMorkThreadFlags(watched, getMorkThreadRelations(watched)),
    [[2, 0x100]]
  );
});

add_task(async function test_invalidStructuralTextRejectsSnapshot() {
  const bytes = await IOUtils.read(do_get_file("data/migration.msf").path);
  const source = String.fromCharCode(...bytes);
  Assert.ok(source.includes("(9A=242)"), "The frozen size cell is present");
  const invalid = source.replace("(9A=242)", "(9A=not-a-number)");
  Assert.throws(
    () => parseMorkSummary(new TextEncoder().encode(invalid)),
    error => error.name == "MorkImportError" && error.code == "MALFORMED_MORK",
    "Invalid structural fields cannot become a successful snapshot"
  );
});

/**
 * Parses one grammar-unit header without creating a production MSF fixture.
 *
 * @param {string} cells - Literal header cells.
 * @returns {import("resource:///modules/panorama/MorkSummaryReader.sys.mjs").MorkSummaryMessage}
 *   Parsed message with exact properties and its effective token.
 */
function messageWithBodyCells(cells) {
  const body =
    '// <!-- <mdb:mork:z v="1.4"/> -->\n' +
    "< <(a=c)> (80=ns:msg:db:row:scope:msgs:all)" +
    "(81=ns:msg:db:table:kind:msgs)>\n" +
    "{1:^80 {(k^81:c)(s=9)} [1" +
    cells +
    "]}";
  return parseMorkSummary(new TextEncoder().encode(body)).messages[0];
}

add_task(function test_msgOffsetFallbackWithoutStoreToken() {
  const message = messageWithBodyCells("(msgOffset=1000000000000001)");
  Assert.equal(message.storeToken, "1152921504606846977");
  Assert.equal(message.properties.get("msgOffset"), "1000000000000001");
  Assert.ok(
    !message.properties.has("storeToken"),
    "Fallback preserves absence"
  );
});

add_task(function test_emptyStoreTokenUsesMsgOffset() {
  const message = messageWithBodyCells(
    "(storeToken=)(msgOffset=000000000000002a)"
  );
  Assert.equal(message.storeToken, "42");
  Assert.ok(message.properties.has("storeToken"));
  Assert.equal(message.properties.get("storeToken"), "");
  Assert.equal(message.properties.get("msgOffset"), "000000000000002a");
});

add_task(function test_zeroOffsetBodyToken() {
  const message = messageWithBodyCells("(msgOffset=0)");
  Assert.equal(message.storeToken, "0");
});

add_task(function test_unsetOffsetSentinelKeepsEmptyToken() {
  const message = messageWithBodyCells("(msgOffset=ffffffffffffffff)");
  Assert.equal(message.storeToken, "");
  Assert.equal(message.properties.get("msgOffset"), "ffffffffffffffff");
});

add_task(function test_explicitBodyTokenPrecedesOffset() {
  const message = messageWithBodyCells(
    "(storeToken=1143)(msgOffset=not-a-number)"
  );
  Assert.equal(message.storeToken, "1143");
  Assert.equal(message.properties.get("msgOffset"), "not-a-number");
});

add_task(function test_emptyOffsetRejectsFallback() {
  Assert.throws(
    () => messageWithBodyCells("(msgOffset=)"),
    error => error.name == "MorkImportError" && error.code == "MALFORMED_MORK"
  );
});

add_task(function test_invalidOffsetRejectsFallback() {
  Assert.throws(
    () => messageWithBodyCells("(storeToken=)(msgOffset=2ag)"),
    error => error.name == "MorkImportError" && error.code == "MALFORMED_MORK"
  );
});

add_task(function test_offsetOverflowRejectsFallback() {
  Assert.throws(
    () => messageWithBodyCells("(msgOffset=10000000000000000)"),
    error => error.name == "MorkImportError" && error.code == "MALFORMED_MORK"
  );
});

add_task(function test_highestStoredOffsetBodyToken() {
  const message = messageWithBodyCells("(msgOffset=fffffffffffffffe)");
  Assert.equal(message.storeToken, "18446744073709551614");
});

/**
 * Reads a frozen native-written group/alias update, not generated Mork text.
 *
 * @param {string} name - Admitted summary basename.
 * @param {string} raw - Independent literal folded References text.
 * @param {string[]} references - Independent literal ordered ancestors.
 */
async function assertGenuineReferences(name, raw, references) {
  const bytes = await IOUtils.read(do_get_file("data/" + name + ".msf").path);
  const before = bytes.slice();
  const { messages, source } = parseMorkSummary(bytes);
  Assert.deepEqual(messages.map(message => message.messageId).sort(), [
    "162378@invalid",
    "345692@invalid",
  ]);
  const control = messages.find(
    message => message.messageId == "162378@invalid"
  );
  const child = messages.find(message => message.messageId == "345692@invalid");
  Assert.deepEqual(control.references, []);
  Assert.ok(control.properties.has("references"));
  Assert.equal(control.properties.get("references"), "");
  Assert.deepEqual(child.references, references);
  Assert.equal(child.properties.get("references"), raw);
  Assert.equal(
    child.properties.get("sender_name"),
    '0|"Zo\u00eb Yundt" <zoe.yundt@invalid>'
  );
  Assert.ok(!child.properties.has("growKeywords"));
  Assert.ok(!child.properties.has("recipients"));
  const messageScope = "ns:msg:db:row:scope:msgs:all";
  const threadScope = "ns:msg:db:row:scope:threads:all";
  const infoScope = "ns:msg:db:row:scope:dbfolderinfo:all";
  Assert.deepEqual(
    [...source.rows.keys()].sort(),
    [
      "1:m",
      "2:m",
      "3:m",
      "1:" + messageScope,
      "3:" + messageScope,
      "4294967294:" + threadScope,
      "3:" + threadScope,
      "1:" + infoScope,
    ].sort(),
    "All eight real scoped rows survive, including detached metadata"
  );
  Assert.deepEqual(
    [...source.tables.keys()].sort(),
    [
      "1:" + messageScope,
      "4294967294:" + messageScope,
      "3:" + messageScope,
      "4294967293:" + threadScope,
      "1:" + infoScope,
    ].sort(),
    "All five real tables survive the References-only update"
  );
  Assert.deepEqual(
    [...source.tables.get("1:" + messageScope).rows],
    ["1:" + messageScope, "3:" + messageScope]
  );
  Assert.deepEqual(bytes, before);
}

add_task(async function test_genuineFoldedReferencesUpdate() {
  await assertGenuineReferences(
    "deliveryMigrationReferences",
    "<ancestor@invalid>\r\n\t<parent@invalid> <nearest@invalid>",
    ["ancestor@invalid", "parent@invalid", "nearest@invalid"]
  );
});

add_task(async function test_genuineDuplicateReferencesUpdate() {
  await assertGenuineReferences(
    "deliveryMigrationDuplicateReferences",
    "<ancestor@invalid> <parent@invalid>\r\n\t<ancestor@invalid> <nearest@invalid>",
    [
      "ancestor@invalid",
      "parent@invalid",
      "ancestor@invalid",
      "nearest@invalid",
    ]
  );
});

add_task(async function test_genuineNativeRowPosition() {
  // Native MoveRow/commit/reopen produced this file and the literal order oracle.
  const path = do_get_file("data/migration-row-position.mork").path;
  const bytes = await IOUtils.read(path);
  const original = bytes.slice();
  const body = MailStringUtils.uint8ArrayToByteString(bytes);
  const offset = body.indexOf("!2 ");
  Assert.greater(offset, 0, "The genuine input includes the native move delta");
  const expected = await IOUtils.readJSON(
    do_get_file("data/migration-row-position.json").path
  );
  Assert.deepEqual(expected.finalIds, [2, 3, 1, 4]);
  const snapshot = new MorkParser().parseForImport(body);
  const table = snapshot.tables.get(expected.tableId + ":" + expected.scope);
  Assert.equal(snapshot.tables.size, 1);
  Assert.equal(snapshot.rows.size, 4);
  Assert.equal(table.cells.get("k"), expected.tableKind);
  Assert.deepEqual(
    table.rows,
    expected.finalIds.map(id => id + ":" + expected.scope),
    "The committed native move changes membership order without dropping row4"
  );
  for (const id of expected.initialIds) {
    const row = snapshot.rows.get(id + ":" + expected.scope);
    Assert.equal(row.id, id);
    Assert.equal(row.scope, expected.scope);
    Assert.deepEqual([...row.cells], Object.entries(expected.cells[id]));
  }
  const sentinel = {};
  let summary = sentinel;
  Assert.throws(
    () => {
      summary = parseMorkSummary(bytes);
    },
    error =>
      error.name == "MorkImportError" &&
      error.code == "UNSUPPORTED_MORK" &&
      error.message == "Expected one message table at byte 0",
    "A generic native fixture is not a mail summary"
  );
  Assert.equal(summary, sentinel, "No partial summary was returned");
  Assert.deepEqual(bytes, original, "Neither caller mutates the input buffer");
  Assert.deepEqual(
    await IOUtils.read(path),
    original,
    "Source file is unchanged"
  );
});

add_task(async function test_genuineNativeRowForm() {
  // Native committed this anonymous inline value with an explicit UTF-8 form.
  const path = do_get_file("data/migration-row-form.mork").path;
  const bytes = await IOUtils.read(path);
  const original = bytes.slice();
  const body = MailStringUtils.uint8ArrayToByteString(bytes);
  Assert.greater(body.indexOf("[(f^85)]"), 0);
  const expected = await IOUtils.readJSON(
    do_get_file("data/migration-forms.json").path
  );
  Assert.equal(
    expected.rowForm.Payload,
    "row-form-".repeat(128) + "ë\r\n(raw)\\$"
  );
  const snapshot = new MorkParser().parseForImport(body);
  const table = snapshot.tables.get(expected.tableId + ":" + expected.scope);
  const key = expected.rowForm.rowId + ":" + expected.scope;
  Assert.equal(snapshot.tables.size, 1);
  Assert.equal(snapshot.rows.size, 1);
  Assert.equal(table.cells.get("k"), expected.tableKind);
  Assert.deepEqual(table.rows, [key]);
  const row = snapshot.rows.get(key);
  Assert.equal(row.id, expected.rowForm.rowId);
  Assert.equal(row.scope, expected.scope);
  Assert.deepEqual(
    [...row.cells],
    [
      ["presentEmpty", ""],
      [
        "Payload",
        MailStringUtils.uint8ArrayToByteString(
          new TextEncoder().encode(expected.rowForm.Payload)
        ),
      ],
    ]
  );
  Assert.ok(!row.cells.has(expected.rowForm.absentCell));
  const sentinel = {};
  let summary = sentinel;
  Assert.throws(
    () => {
      summary = parseMorkSummary(bytes);
    },
    error =>
      error.name == "MorkImportError" &&
      error.code == "UNSUPPORTED_MORK" &&
      error.message == "Expected one message table at byte 0",
    "The form can be read without treating the generic table as mail"
  );
  Assert.equal(summary, sentinel, "No partial summary was returned");
  Assert.deepEqual(bytes, original, "Neither caller mutates the input buffer");
  Assert.deepEqual(
    await IOUtils.read(path),
    original,
    "Source file is unchanged"
  );
});

add_task(async function test_genuineNativeDictionaryForm() {
  // Native003 committed these bytes. Its discarded reader's form failure stays
  // historical; the retained migration reader must preserve the saved payload.
  const path = do_get_file("data/migration-dictionary-form.mork").path;
  const bytes = await IOUtils.read(path);
  const original = bytes.slice();
  const body = MailStringUtils.uint8ArrayToByteString(bytes);
  const expected = await IOUtils.readJSON(
    do_get_file("data/migration-forms.json").path
  );
  // Physical tokens were measured separately from the pre-production oracle.
  const tokens = {
    scope: "80",
    kind: "81",
    empty: "82",
    payload: "83",
    absent: "84",
    form: "85",
    value: "81",
  };
  Assert.ok(body.includes(`(${tokens.scope}=${expected.scope})`));
  Assert.ok(body.includes(`(${tokens.kind}=${expected.tableKind})`));
  Assert.ok(
    body.includes(`(${tokens.form}=${expected.dictionaryForm.formName})`)
  );
  Assert.ok(body.includes(`(${tokens.empty}=presentEmpty)`));
  Assert.ok(body.includes(`(${tokens.payload}=Payload)`));
  Assert.ok(
    body.includes(`(${tokens.absent}=${expected.dictionaryForm.absentCell})`)
  );
  // Independently spelled wire representation of the literal UTF-8 payload:
  // dictionary é (raw)\$; the IDs are measurements, never the semantic oracle.
  const encodedPayload = "dictionary $C3$A9 (raw\\)\\\\\\$";
  Assert.ok(
    body.includes(`(${tokens.value}\n<(f^${tokens.form})>=${encodedPayload})`),
    "The genuine dictionary retains the exact escaped UTF-8 value and form"
  );
  Assert.ok(
    body.includes(
      `{${expected.tableId}:^${tokens.scope} {(k^${tokens.kind}:c)(s=9)}`
    ),
    "The original table kind and scope remain linked"
  );
  Assert.ok(
    body.includes(
      `[${expected.dictionaryForm.rowId}(^${tokens.empty}=)\n` +
        `[(f^${tokens.form})](^${tokens.payload}^${tokens.value})]`
    ),
    "The scoped row keeps the empty default-form cell and nondefault payload alias"
  );
  Assert.ok(
    !body.includes(`(^${tokens.absent}`),
    "The absent cell stays absent"
  );

  Assert.equal(expected.dictionaryForm.Payload, "dictionary é (raw)\\$");
  const snapshot = new MorkParser().parseForImport(body);
  const table = snapshot.tables.get(expected.tableId + ":" + expected.scope);
  const key = expected.dictionaryForm.rowId + ":" + expected.scope;
  Assert.equal(snapshot.tables.size, 1);
  Assert.equal(snapshot.rows.size, 1);
  Assert.equal(table.cells.get("k"), expected.tableKind);
  Assert.deepEqual(table.rows, [key]);
  const row = snapshot.rows.get(key);
  Assert.equal(row.id, expected.dictionaryForm.rowId);
  Assert.equal(row.scope, expected.scope);
  Assert.deepEqual(
    [...row.cells],
    [
      ["presentEmpty", ""],
      [
        "Payload",
        MailStringUtils.uint8ArrayToByteString(
          new TextEncoder().encode(expected.dictionaryForm.Payload)
        ),
      ],
    ]
  );
  Assert.ok(!row.cells.has(expected.dictionaryForm.absentCell));
  const sentinel = {};
  let summary = sentinel;
  Assert.throws(
    () => {
      summary = parseMorkSummary(bytes);
    },
    error =>
      error.name == "MorkImportError" &&
      error.code == "UNSUPPORTED_MORK" &&
      error.message == "Expected one message table at byte 0",
    "The generic dictionary-form fixture is not a mail summary"
  );
  Assert.equal(summary, sentinel, "No partial summary was returned");
  Assert.deepEqual(bytes, original, "Neither caller mutates the input buffer");
  Assert.deepEqual(
    await IOUtils.read(path),
    original,
    "Source file is unchanged"
  );
});

add_task(async function test_genuineAddressBookConsumer() {
  const path = do_get_file("import.mab").path;
  const bytes = await IOUtils.read(path);
  const original = bytes.slice();
  const { cards, lists, metadata } = parseMorkAddressBook(bytes);
  Assert.equal(cards.length, 1);
  Assert.equal(lists.length, 1);
  Assert.equal(cards[0].sourceKey, 1);
  Assert.equal(cards[0].properties.get("DisplayName"), "contact number one");
  Assert.equal(cards[0].properties.get("PrimaryEmail"), "contact1@invalid");
  Assert.equal(cards[0].properties.get("RecordKey"), "1");
  Assert.ok(cards[0].properties.has("Notes"));
  Assert.equal(cards[0].properties.get("Notes"), "");
  Assert.ok(!cards[0].properties.has("UID"));
  Assert.equal(lists[0].sourceKey, 1, "Card and list IDs have separate scopes");
  Assert.equal(lists[0].properties.get("ListName"), "list");
  Assert.equal(lists[0].properties.get("ListDescription"), "a list of cards");
  Assert.deepEqual(lists[0].members, [1]);
  Assert.equal(
    metadata.get("1:ns:addrbk:db:row:scope:data:all").get("LastRecordKey"),
    "2"
  );
  Assert.deepEqual(bytes, original);
  Assert.deepEqual(await IOUtils.read(path), original);
});

add_task(async function test_genuineFolderCacheConsumer() {
  const path = do_get_file("panacea.dat").path;
  const bytes = await IOUtils.read(path);
  const original = bytes.slice();
  const { entries, source } = parseMorkFolderCache(bytes);
  Assert.equal(entries.size, 13);
  Assert.equal(source.rows.size, 13);
  const inbox = entries.get(
    "/foo/bar/profile-default/ImapMail/imap.localhost/INBOX.msf"
  );
  Assert.equal(inbox.sourceKey, 1);
  Assert.equal(inbox.properties.get("flags"), "88083014");
  Assert.equal(inbox.values.flags, 2282237972);
  Assert.equal(inbox.values.totalMsgs, 2);
  Assert.equal(
    inbox.values.MRUTime,
    "1628202593",
    "Unknown properties stay text"
  );
  const server = entries.get(
    "/foo/bar/profile-default/ImapMail/imap.localhost"
  );
  Assert.ok(server.properties.has("onlineName"));
  Assert.equal(server.properties.get("onlineName"), "");
  Assert.ok(!server.properties.has("absent"));
  Assert.equal(server.properties.get("folderSize"), "ffffffffffffffff");
  Assert.equal(server.values.folderSize, -1);
  Assert.equal(server.values.totalMsgs, -1);
  Assert.deepEqual(bytes, original);
  Assert.deepEqual(await IOUtils.read(path), original);
});

add_task(async function test_genuineInfoOnlyEmptyFolderSummary() {
  // A legacy compress commit of an empty folder keeps only its folder info.
  const path = do_get_file("data/migration-info-only-summary.msf").path;
  const bytes = await IOUtils.read(path);
  const original = bytes.slice();
  const summary = parseMorkSummary(bytes);
  Assert.deepEqual(summary.messages, [], "An empty folder has no messages");
  Assert.deepEqual(
    [...summary.source.tables.values()].map(table => table.cells.get("k")),
    ["ns:msg:db:table:kind:dbfolderinfo"]
  );
  const info = [...summary.source.rows.values()];
  Assert.equal(info.length, 1);
  Assert.equal(info[0].scope, "ns:msg:db:row:scope:dbfolderinfo:all");
  Assert.equal(info[0].cells.get("onlineName"), "Drafts");
  Assert.deepEqual(bytes, original, "The reader does not mutate its input");

  // A second all-headers table is still refused.
  const body = MailStringUtils.uint8ArrayToByteString(bytes);
  const tables = "{1:^80 {(k^96:c)(s=9)} }\n{2:^80 {(k^96:c)(s=9)} }\n";
  Assert.throws(
    () =>
      parseMorkSummary(
        MailStringUtils.byteStringToUint8Array(
          body.replace("{1:^9F", tables + "{1:^9F")
        )
      ),
    error =>
      error.name == "MorkImportError" &&
      error.message == "Expected one message table at byte 0"
  );
});
