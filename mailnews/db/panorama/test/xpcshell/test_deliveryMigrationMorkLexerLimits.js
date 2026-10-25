/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { MorkByteLexer, MorkLexError } = ChromeUtils.importESModule(
  "resource:///modules/panorama/StrictMorkReader.sys.mjs"
);

/**
 * Requires an explicit resource-limit failure at the first excluded source byte.
 *
 * @param {function(): void} operation - One bounded lexical operation.
 * @param {number} offset - Expected source byte offset.
 */
function assertLimit(operation, offset) {
  let failure;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  Assert.ok(failure instanceof MorkLexError);
  Assert.deepEqual(
    { code: failure.code, offset: failure.offset },
    { code: "RESOURCE_LIMIT", offset }
  );
}

add_task(function test_boundsInputBeforeCopying() {
  assertLimit(
    () =>
      new MorkByteLexer(Uint8Array.of(40, 41, 40, 41), { maxInputBytes: 3 }),
    3
  );
});

add_task(function test_acceptsExactInputAndTokenLimits() {
  const lexer = new MorkByteLexer(new TextEncoder().encode("=a)"), {
    maxInputBytes: 3,
    maxTokenBytes: 3,
    maxTokens: 1,
  });
  Assert.deepEqual(lexer.readValue().bytes, Uint8Array.of(97));
  Assert.equal(lexer.peek(), null);
  Assert.equal(lexer.peek(), null, "EOF does not consume the token budget");
});

add_task(function test_boundsEncodedValueSpan() {
  const lexer = new MorkByteLexer(new TextEncoder().encode("=ab)"), {
    maxTokenBytes: 3,
  });
  assertLimit(() => lexer.readValue(), 3);
});

add_task(function test_boundsEscapeSourceBytes() {
  const lexer = new MorkByteLexer(new TextEncoder().encode("=$41)"), {
    maxTokenBytes: 3,
  });
  assertLimit(() => lexer.readValue(), 3);
});

add_task(function test_boundsNameSpan() {
  const lexer = new MorkByteLexer(new TextEncoder().encode("name)"), {
    maxTokenBytes: 3,
  });
  assertLimit(() => lexer.readName(), 3);
});

add_task(function test_boundsAtomSpan() {
  const lexer = new MorkByteLexer(new TextEncoder().encode("1234)"), {
    maxTokenBytes: 3,
  });
  assertLimit(() => lexer.readHex(), 3);
});

add_task(function test_boundsCommentDepth() {
  const lexer = new MorkByteLexer(new TextEncoder().encode("/*a/*b*/c*/"), {
    maxCommentDepth: 1,
  });
  assertLimit(() => lexer.peek(), 3);
});

add_task(function test_boundsCommentSpan() {
  const lexer = new MorkByteLexer(new TextEncoder().encode("/**/"), {
    maxTokenBytes: 3,
  });
  assertLimit(() => lexer.peek(), 3);
});

add_task(function test_boundsTokenCount() {
  const lexer = new MorkByteLexer(new TextEncoder().encode("()("), {
    maxTokens: 2,
  });
  lexer.readSymbol("(");
  lexer.readSymbol(")");
  assertLimit(() => lexer.readSymbol("("), 2);
});

add_task(function test_rejectsInvalidLimitsAndInput() {
  // Built-in errors originate in the imported module's global.
  Assert.throws(
    () => new MorkByteLexer("=x)"),
    error =>
      error.name === "TypeError" && error.message === "Expected Uint8Array"
  );
  for (const value of [0, -1, 1.5, NaN, Infinity]) {
    for (const name of [
      "maxInputBytes",
      "maxTokenBytes",
      "maxTokens",
      "maxCommentDepth",
    ]) {
      Assert.throws(
        () => new MorkByteLexer(new Uint8Array(), { [name]: value }),
        error =>
          error.name === "RangeError" && error.message === "Invalid " + name
      );
    }
  }
});

add_task(function test_acceptsExactCommentDepthAndSpan() {
  const lexer = new MorkByteLexer(new TextEncoder().encode("/*a/*b*/c*/("), {
    maxCommentDepth: 2,
    maxTokenBytes: 11,
  });
  Assert.equal(lexer.readSymbol("(").start, 11);
});

add_task(function test_countsDifferentReadKindsTogether() {
  const lexer = new MorkByteLexer(new TextEncoder().encode("(a=)"), {
    maxTokens: 2,
  });
  lexer.readSymbol("(");
  lexer.readName();
  assertLimit(() => lexer.readValue(), 2);
});
