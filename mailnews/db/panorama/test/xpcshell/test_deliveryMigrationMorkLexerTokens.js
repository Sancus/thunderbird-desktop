/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Format-reader evidence only; no database, backend or body store is exercised.
const { MorkByteLexer } = ChromeUtils.importESModule(
  "resource:///modules/panorama/StrictMorkReader.sys.mjs"
);

add_task(function test_readsByteSpansAndAtomSpellings() {
  const lexer = new MorkByteLexer(new TextEncoder().encode("(^aBcD=2a)"));
  Assert.deepEqual(lexer.readSymbol("("), {
    start: 0,
    end: 1,
    bytes: Uint8Array.of(40),
  });
  Assert.deepEqual(lexer.readSymbol("^"), {
    start: 1,
    end: 2,
    bytes: Uint8Array.of(94),
  });
  Assert.deepEqual(lexer.readHex(), {
    start: 2,
    end: 6,
    bytes: Uint8Array.of(97, 66, 99, 68),
  });
  Assert.deepEqual(lexer.readValue(), {
    start: 6,
    end: 10,
    bytes: Uint8Array.of(50, 97),
  });
  Assert.equal(lexer.peek(), null, "Only lexical EOF is established");
});

add_task(function test_exposesLayoutAtRequiredAdjacencyBoundary() {
  const lexer = new MorkByteLexer(new TextEncoder().encode("( name=v)"));
  const open = lexer.readSymbol("(");
  const name = lexer.readName();
  Assert.equal(open.end, 1);
  Assert.equal(name.start, 2);
  Assert.notEqual(
    name.start,
    open.end,
    "Spans expose layout the structural parser must reject here"
  );
});

add_task(function test_readsNativeNameCharacters() {
  const lexer = new MorkByteLexer(new TextEncoder().encode(":a_!+?-Z)"));
  Assert.deepEqual(
    lexer.readName().bytes,
    Uint8Array.of(58, 97, 95, 33, 43, 63, 45, 90)
  );
  lexer.readSymbol(")");
  Assert.equal(lexer.peek(), null);
});

add_task(function test_skipsNestedCommentsAndOutsideContinuation() {
  const lexer = new MorkByteLexer(
    new TextEncoder().encode("//x\r\n/*a/*b*/c*/\\\n[")
  );
  Assert.deepEqual(lexer.readSymbol("["), {
    start: 18,
    end: 19,
    bytes: Uint8Array.of(91),
  });
  Assert.equal(lexer.peek(), null);
});

add_task(function test_skipsOnlyNativeLayoutBytes() {
  const lexer = new MorkByteLexer(
    Uint8Array.of(8, 9, 10, 12, 13, 32, 127, 40, 41)
  );
  Assert.equal(lexer.readSymbol("(").start, 7);
  lexer.readSymbol(")");
  Assert.equal(lexer.peek(), null);
});

add_task(function test_preservesLiteralCommentTextAndLinebreaks() {
  const lexer = new MorkByteLexer(
    new TextEncoder().encode("=https://x/*y*/\r\n)")
  );
  Assert.deepEqual(
    lexer.readValue().bytes,
    Uint8Array.of(
      104,
      116,
      116,
      112,
      115,
      58,
      47,
      47,
      120,
      47,
      42,
      121,
      42,
      47,
      13,
      10
    )
  );
});

add_task(function test_decodesEscapesWithoutTextConversion() {
  const lexer = new MorkByteLexer(
    new TextEncoder().encode("=\\)\\\\\\$\\q$00$Ff$4a)")
  );
  Assert.deepEqual(
    lexer.readValue().bytes,
    Uint8Array.of(41, 92, 36, 113, 0, 255, 74)
  );
});

add_task(function test_preservesUnescapedBinaryValueBytes() {
  const lexer = new MorkByteLexer(Uint8Array.of(61, 0, 255, 192, 128, 41));
  Assert.deepEqual(lexer.readValue().bytes, Uint8Array.of(0, 255, 192, 128));
});

add_task(function test_removesOnlyEscapedLinebreaks() {
  for (const newline of ["\n", "\r", "\r\n", "\n\r"]) {
    const lexer = new MorkByteLexer(
      new TextEncoder().encode("=a\\" + newline + "$42\\" + newline + "\\)c)")
    );
    Assert.deepEqual(lexer.readValue().bytes, Uint8Array.of(97, 66, 41, 99));
  }
  const lexer = new MorkByteLexer(new TextEncoder().encode("=a\\\n\nb)"));
  Assert.deepEqual(lexer.readValue().bytes, Uint8Array.of(97, 10, 98));
});

add_task(function test_ownsInputAndReturnedBytes() {
  const input = Uint8Array.of(61, 65, 41, 61, 66, 41);
  const lexer = new MorkByteLexer(input);
  input.fill(0);
  const first = lexer.readValue();
  Assert.deepEqual(first.bytes, Uint8Array.of(65));
  first.bytes.fill(0);
  Assert.deepEqual(lexer.readValue().bytes, Uint8Array.of(66));
});

add_task(function test_preservesDistinctArbitraryNameBytes() {
  const lexer = new MorkByteLexer(
    new TextEncoder().encode("(80=caf$C3$A9)(81=cafe$CC$81)(82=X)(83=x)(84=)")
  );
  const names = [];
  for (const id of ["80", "81", "82", "83", "84"]) {
    lexer.readSymbol("(");
    Assert.equal(new TextDecoder().decode(lexer.readHex().bytes), id);
    names.push([...lexer.readValue().bytes]);
  }
  Assert.deepEqual(
    names,
    [[99, 97, 102, 195, 169], [99, 97, 102, 101, 204, 129], [88], [120], []],
    "No case folding, normalization, type inference or empty-cell omission"
  );
  Assert.equal(lexer.peek(), null);
});

add_task(async function test_readsFrozenSummaryAliases() {
  const lexer = new MorkByteLexer(
    await IOUtils.read(
      do_get_file("data/deliveryMigrationLexerSummary.mork").path
    )
  );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const aliases = [];
  lexer.readSymbol("<");
  while (lexer.peek() == 40) {
    lexer.readSymbol("(");
    aliases.push([
      decoder.decode(lexer.readHex().bytes),
      decoder.decode(lexer.readValue().bytes),
    ]);
  }
  lexer.readSymbol(">");
  Assert.equal(lexer.peek(), null);
  Assert.deepEqual(aliases, [
    ["8E", '"Cicero Kutch" <cicero.kutch@invalid>'],
    ["8F", "Secured value-added orchestration"],
    ["90", "162378@invalid"],
    ["91", ""],
    ["9A", "242"],
    ["94", "9"],
    ["95", "ffffffff"],
    ["97", "0|Cicero Kutch <cicero.kutch@invalid>"],
    ["99", "=?UTF-8?Q?Rene=CC=81e_Alsom?= <renee.alsom@invalid>"],
    ["AF", "$label5"],
    ["A4", '=?UTF-8?Q?"Zo=C3=AB_Yundt"?= <zoe.yundt@invalid>'],
    ["A5", "Intuitive full-range analyzer"],
    ["A6", "345692@invalid"],
    ["A8", "177"],
    ["A9", "4"],
    ["AC", "1143"],
    ["AB", '0|"Zoë Yundt" <zoe.yundt@invalid>'],
  ]);
});

add_task(async function test_readsFrozenCacheContinuation() {
  const lexer = new MorkByteLexer(
    await IOUtils.read(
      do_get_file("data/deliveryMigrationLexerCache.mork").path
    )
  );
  lexer.readSymbol("(");
  Assert.deepEqual(lexer.readHex().bytes, Uint8Array.of(56, 48));
  Assert.equal(
    new TextDecoder().decode(lexer.readValue().bytes),
    "/foo/bar/profile-default/ImapMail/imap.localhost/INBOX.msf"
  );
  Assert.equal(lexer.peek(), null);
});

add_task(function test_preservesSubviewBoundaries() {
  const backing = Uint8Array.of(0, 61, 65, 41, 255);
  const lexer = new MorkByteLexer(backing.subarray(1, 4));
  Assert.deepEqual(lexer.readValue(), {
    start: 0,
    end: 3,
    bytes: Uint8Array.of(65),
  });
  Assert.equal(lexer.peek(), null);
});

add_task(function test_acceptsTrailingLineCommentAtEof() {
  const lexer = new MorkByteLexer(new TextEncoder().encode("// trailing"));
  Assert.equal(lexer.peek(), null);
});

add_task(function test_leavesNonHexSuffixForStructuralValidation() {
  const lexer = new MorkByteLexer(new TextEncoder().encode("80z)"));
  Assert.deepEqual(lexer.readHex().bytes, Uint8Array.of(56, 48));
  Assert.equal(
    lexer.peek(),
    122,
    "The structural parser must reject the suffix"
  );
});

add_task(function test_leavesDigitAfterNativeBareName() {
  const lexer = new MorkByteLexer(new TextEncoder().encode("name2)"));
  Assert.deepEqual(lexer.readName().bytes, Uint8Array.of(110, 97, 109, 101));
  Assert.equal(
    lexer.peek(),
    50,
    "No unsupported name byte is silently discarded"
  );
});
