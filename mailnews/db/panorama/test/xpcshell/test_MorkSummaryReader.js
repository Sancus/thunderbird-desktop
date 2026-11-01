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

add_task(async function test_genuineNativeRowPositionRefusal() {
  // A real MDB MoveRow/commit produced this input; native frozen reopen checks
  // full order [2,3,1,4] and every original cell. This is not positive import.
  const path = do_get_file("data/migration-row-position.mork").path;
  const bytes = await IOUtils.read(path);
  const original = bytes.slice();
  const body = MailStringUtils.uint8ArrayToByteString(bytes);
  const offset = body.indexOf("!2 ");
  Assert.greater(offset, 0, "The genuine input includes the native move delta");
  const sentinel = {};
  let snapshot = sentinel;
  Assert.throws(
    () => {
      snapshot = new MorkParser().parseForImport(body);
    },
    error =>
      error.name == "MorkImportError" &&
      error.code == "UNSUPPORTED_MORK" &&
      error.offset == offset &&
      error.message == "Row position hints are not supported at byte " + offset,
    "A valid native move cannot return stale pre-move membership"
  );
  Assert.equal(
    snapshot,
    sentinel,
    "No partial structural snapshot was returned"
  );
  let summary = sentinel;
  Assert.throws(
    () => {
      summary = parseMorkSummary(bytes);
    },
    error =>
      error.name == "MorkImportError" &&
      error.code == "UNSUPPORTED_MORK" &&
      error.offset == offset &&
      error.message == "Row position hints are not supported at byte " + offset,
    "The summary caller propagates the move refusal before projection"
  );
  Assert.equal(summary, sentinel, "No partial summary was returned");
  Assert.deepEqual(bytes, original, "Neither caller mutates the input buffer");
  Assert.deepEqual(
    await IOUtils.read(path),
    original,
    "Source file is unchanged"
  );
});

add_task(async function test_genuineNativeRowFormRefusal() {
  // The unchanged MDB writer committed this nondefault inline UTF-8 form.
  // A distinct frozen native reader checks exact bytes, form and presence.
  const path = do_get_file("data/migration-row-form.mork").path;
  const bytes = await IOUtils.read(path);
  const original = bytes.slice();
  const body = MailStringUtils.uint8ArrayToByteString(bytes);
  const offset = body.indexOf("[(f^");
  Assert.greater(offset, 0, "The genuine input contains native row metadata");
  const sentinel = {};
  let snapshot = sentinel;
  Assert.throws(
    () => {
      snapshot = new MorkParser().parseForImport(body);
    },
    error =>
      error.name == "MorkImportError" &&
      error.code == "UNSUPPORTED_MORK" &&
      error.offset == offset &&
      error.message == "Row metadata block at byte " + offset,
    "A valid unsupported native form must not be decoded as default text"
  );
  Assert.equal(
    snapshot,
    sentinel,
    "No partial structural snapshot was returned"
  );
  let summary = sentinel;
  Assert.throws(
    () => {
      summary = parseMorkSummary(bytes);
    },
    error =>
      error.name == "MorkImportError" &&
      error.code == "UNSUPPORTED_MORK" &&
      error.offset == offset &&
      error.message == "Row metadata block at byte " + offset,
    "The summary caller propagates the native row form refusal before projection"
  );
  Assert.equal(summary, sentinel, "No partial summary was returned");
  Assert.deepEqual(bytes, original, "Neither caller mutates the input buffer");
  Assert.deepEqual(
    await IOUtils.read(path),
    original,
    "Source file is unchanged"
  );
});

add_task(async function test_genuineNativeDictionaryFormRefusal() {
  // Native003 committed these bytes. Its discarded reader loses the alias form;
  // the migration reader must refuse the saved form rather than lose its meaning.
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

  const offset = body.indexOf("<(f^");
  Assert.greater(offset, 0);
  const sentinel = {};
  let snapshot = sentinel;
  Assert.throws(
    () => {
      snapshot = new MorkParser().parseForImport(body);
    },
    error =>
      error.name == "MorkImportError" &&
      error.code == "UNSUPPORTED_MORK" &&
      error.offset == offset &&
      error.message == "Per-alias form override at byte " + offset,
    "The structural reader refuses the unsupported alias form before decoding"
  );
  Assert.equal(
    snapshot,
    sentinel,
    "No partial structural snapshot was returned"
  );
  let summary = sentinel;
  Assert.throws(
    () => {
      summary = parseMorkSummary(bytes);
    },
    error =>
      error.name == "MorkImportError" &&
      error.code == "UNSUPPORTED_MORK" &&
      error.offset == offset &&
      error.message == "Per-alias form override at byte " + offset,
    "The summary caller propagates the exact alias-form refusal"
  );
  Assert.equal(summary, sentinel, "No partial summary was returned");
  Assert.deepEqual(bytes, original, "Neither caller mutates the input buffer");
  Assert.deepEqual(
    await IOUtils.read(path),
    original,
    "Source file is unchanged"
  );
});
