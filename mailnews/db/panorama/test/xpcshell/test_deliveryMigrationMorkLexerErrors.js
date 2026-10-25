/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { MorkByteLexer, MorkLexError } = ChromeUtils.importESModule(
  "resource:///modules/panorama/StrictMorkReader.sys.mjs"
);

/**
 * Checks a rejected lexical read against a literal error position.
 *
 * @param {string} input - Encoded source fragment.
 * @param {string} method - Lexer read method.
 * @param {string} code - Expected error code.
 * @param {number} offset - Expected zero-based source byte offset; EOF is length.
 */
function assertFailure(input, method, code, offset) {
  const lexer = new MorkByteLexer(new TextEncoder().encode(input));
  let failure;
  try {
    lexer[method]();
  } catch (error) {
    failure = error;
  }
  Assert.ok(
    failure instanceof MorkLexError,
    "The intended lexical read rejects"
  );
  Assert.deepEqual(
    { code: failure.code, offset: failure.offset },
    { code, offset }
  );
}

add_task(function test_rejectsFirstInvalidEscapeDigit() {
  assertFailure("=a$Q0)", "readValue", "MALFORMED_MORK", 3);
});
add_task(function test_rejectsSecondInvalidEscapeDigit() {
  assertFailure("=a$0q)", "readValue", "MALFORMED_MORK", 4);
});
add_task(function test_rejectsMissingEscapeDigits() {
  assertFailure("=$", "readValue", "TRUNCATED_MORK", 2);
});
add_task(function test_rejectsMissingSecondEscapeDigit() {
  assertFailure("=$A", "readValue", "TRUNCATED_MORK", 3);
});
add_task(function test_rejectsTruncatedQuotedByte() {
  assertFailure("=x\\", "readValue", "TRUNCATED_MORK", 3);
});
add_task(function test_rejectsUnterminatedValue() {
  assertFailure("=x", "readValue", "TRUNCATED_MORK", 2);
});
add_task(function test_rejectsEmptyTruncatedValue() {
  assertFailure("=", "readValue", "TRUNCATED_MORK", 1);
});
add_task(function test_rejectsUnterminatedComment() {
  assertFailure("/*x", "peek", "TRUNCATED_MORK", 3);
});
add_task(function test_rejectsUnterminatedOuterComment() {
  assertFailure("/*a/*b*/", "peek", "TRUNCATED_MORK", 8);
});
add_task(function test_rejectsBareSlash() {
  assertFailure("/x", "peek", "MALFORMED_MORK", 1);
});
add_task(function test_rejectsOutsideNonContinuation() {
  assertFailure("\\x", "peek", "MALFORMED_MORK", 1);
});
add_task(function test_rejectsTruncatedOutsideContinuation() {
  assertFailure("\\", "peek", "TRUNCATED_MORK", 1);
});
add_task(function test_rejectsInvalidNameStart() {
  assertFailure("9)", "readName", "MALFORMED_MORK", 0);
});
add_task(function test_rejectsUndelimitedName() {
  assertFailure("name", "readName", "TRUNCATED_MORK", 4);
});
add_task(function test_rejectsInvalidAtomStart() {
  assertFailure("G)", "readHex", "MALFORMED_MORK", 0);
});
add_task(function test_rejectsUndelimitedAtom() {
  assertFailure("80", "readHex", "TRUNCATED_MORK", 2);
});
add_task(function test_reportsOriginalByteOffsetAfterContinuation() {
  assertFailure("=a\\\r\n$0Z)", "readValue", "MALFORMED_MORK", 7);
});
add_task(function test_reportsByteOffsetAfterMultibyteText() {
  assertFailure("=é$Z0)", "readValue", "MALFORMED_MORK", 4);
});

add_task(function test_rejectsSymbolMismatch() {
  const lexer = new MorkByteLexer(Uint8Array.of(93));
  Assert.throws(
    () => lexer.readSymbol("["),
    error =>
      error instanceof MorkLexError &&
      error.code == "MALFORMED_MORK" &&
      error.offset == 0
  );
});

add_task(function test_rejectsMissingRequiredSymbol() {
  const lexer = new MorkByteLexer(new Uint8Array());
  Assert.throws(
    () => lexer.readSymbol("["),
    error =>
      error instanceof MorkLexError &&
      error.code == "TRUNCATED_MORK" &&
      error.offset == 0
  );
});
