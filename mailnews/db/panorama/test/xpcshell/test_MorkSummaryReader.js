/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

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
