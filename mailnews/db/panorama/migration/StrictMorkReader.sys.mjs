/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const DEFAULT_LIMITS = {
  maxInputBytes: 1024 * 1024,
  maxTokenBytes: 64 * 1024,
  maxTokens: 100000,
  maxCommentDepth: 16,
};
const WHITE = new Set([8, 9, 10, 12, 13, 32, 127]);

/**
 * @typedef {object} MorkLexToken
 * @property {number} start - Original source byte offset, inclusive.
 * @property {number} end - Original source byte offset, exclusive.
 * @property {Uint8Array} bytes - Owned bytes; only values have escapes decoded.
 */

/** A lexical failure with an original byte offset; EOF uses the input length. */
export class MorkLexError extends SyntaxError {
  /**
   * @param {string} code - MALFORMED_MORK, TRUNCATED_MORK or RESOURCE_LIMIT.
   * @param {number} offset - Original source byte offset.
   */
  constructor(code, offset) {
    super(code + " at byte " + offset);
    this.name = "MorkLexError";
    this.code = code;
    this.offset = offset;
  }
}

/**
 * Reads Mork lexical fragments from an owned byte copy.
 * Each read skips native layout first. At raw Getc boundaries, the structural
 * parser must require token.start === previousToken.end (cell columns, ^IDs,
 * mid suffixes and group markers). Between a plain alias ID and '=', allow
 * only whitespace, not comments or continuations.
 * Does not resolve atoms or validate scopes, rows, groups, domains or document EOF.
 * Discard the lexer after an error. This is not an importable snapshot.
 */
export class MorkByteLexer {
  /** @type {Uint8Array} */
  #bytes;
  #position = 0;
  #tokens = 0;
  /** @type {typeof DEFAULT_LIMITS} */
  #limits;

  /**
   * @param {Uint8Array} input - Original bytes; no text decoding or normalization.
   * @param {object} [limits] - Positive safe integer bounds.
   * @param {number} [limits.maxInputBytes=1048576] - Limit checked before copying.
   * @param {number} [limits.maxTokenBytes=65536] - Encoded span per token/comment.
   * @param {number} [limits.maxTokens=100000] - Number of successful read tokens.
   * @param {number} [limits.maxCommentDepth=16] - Maximum nested block depth.
   * @throws {TypeError} For a non-byte input.
   * @throws {RangeError} For an invalid limit.
   * @throws {MorkLexError} If input exceeds its byte limit.
   */
  constructor(input, limits = {}) {
    if (
      !ArrayBuffer.isView(input) ||
      Object.prototype.toString.call(input) != "[object Uint8Array]"
    ) {
      throw new TypeError("Expected Uint8Array");
    }
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
    for (const name of Object.keys(DEFAULT_LIMITS)) {
      const value = this.#limits[name];
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError("Invalid " + name);
      }
    }
    if (input.length > this.#limits.maxInputBytes) {
      throw new MorkLexError("RESOURCE_LIMIT", this.#limits.maxInputBytes);
    }
    this.#bytes = new Uint8Array(input);
  }

  /**
   * Skips native layout and returns the next byte without consuming it.
   * A null result establishes lexical EOF only, not document validity.
   *
   * @returns {number|null} Next byte or null.
   * @throws {MorkLexError} For malformed/truncated layout or a comment limit.
   */
  peek() {
    while (this.#position < this.#bytes.length) {
      const byte = this.#bytes[this.#position];
      if (WHITE.has(byte)) {
        this.#position++;
      } else if (byte == 47) {
        this.#skipComment();
      } else if (byte == 92) {
        const start = this.#position;
        this.#take(start);
        const newline = this.#take(start);
        if (newline != 10 && newline != 13) {
          throw new MorkLexError("MALFORMED_MORK", this.#position - 1);
        }
        this.#skipNewlinePair(start, newline);
      } else {
        return byte;
      }
    }
    return null;
  }

  /**
   * Skips native layout, then consumes one required ASCII byte.
   *
   * @param {string} expected - One ASCII character required by the caller.
   * @returns {MorkLexToken} Exact source byte and span.
   * @throws {TypeError} For an invalid expected character.
   * @throws {MorkLexError} For mismatch, truncation or a resource limit.
   */
  readSymbol(expected) {
    if (
      typeof expected != "string" ||
      expected.length != 1 ||
      expected.charCodeAt(0) > 127
    ) {
      throw new TypeError("Expected one ASCII character");
    }
    const start = this.#start();
    if (this.#bytes[start] != expected.charCodeAt(0)) {
      throw new MorkLexError("MALFORMED_MORK", start);
    }
    return this.#finish(start, Uint8Array.of(this.#take(start)));
  }

  /**
   * Skips native layout, then consumes a bare name.
   * Arbitrary property names also occur in atom values.
   *
   * @returns {MorkLexToken} Exact name bytes, without Unicode normalization.
   * @throws {MorkLexError} For invalid start, missing delimiter or a limit.
   */
  readName() {
    return this.#readRun(isNameStart, isNameMore);
  }

  /**
   * Skips native layout, then consumes hexadecimal ID spelling.
   * Keeps spelling for diagnostics; a resolver must compare numeric IDs.
   * Leaves the following byte for the future structural parser to validate.
   *
   * @returns {MorkLexToken} Exact case-preserved ID bytes, excluding any caret.
   * @throws {MorkLexError} For invalid start, missing delimiter or a limit.
   */
  readHex() {
    return this.#readRun(
      byte => hexDigit(byte) >= 0,
      byte => hexDigit(byte) >= 0
    );
  }

  /**
   * Skips native layout before '=', then consumes through its unescaped ')'.
   * Decodes quoted bytes, dollar hex pairs and escaped linebreaks only.
   * Literal linebreaks, comment-like text and invalid UTF-8 remain exact bytes.
   *
   * @returns {MorkLexToken} Decoded value bytes; span includes '=' and ')'.
   * @throws {MorkLexError} For mismatch, bad escape, truncation or a limit.
   */
  readValue() {
    const start = this.#start();
    if (this.#take(start) != 61) {
      throw new MorkLexError("MALFORMED_MORK", start);
    }
    const value = [];
    while (true) {
      let byte = this.#take(start);
      if (byte == 41) {
        return this.#finish(start, Uint8Array.from(value));
      }
      if (byte == 92) {
        byte = this.#take(start);
        if (byte == 10 || byte == 13) {
          this.#skipNewlinePair(start, byte);
          continue;
        }
      } else if (byte == 36) {
        const first = this.#readHexDigit(start);
        byte = first * 16 + this.#readHexDigit(start);
      }
      value.push(byte);
    }
  }

  /**
   * Returns a content offset after layout and checks the token budget.
   *
   * @returns {number} Source offset.
   */
  #start() {
    if (this.peek() === null) {
      throw new MorkLexError("TRUNCATED_MORK", this.#position);
    }
    if (this.#tokens >= this.#limits.maxTokens) {
      throw new MorkLexError("RESOURCE_LIMIT", this.#position);
    }
    return this.#position;
  }

  /**
   * Copies a name/ID run selected by byte predicates.
   *
   * @param {function(number): boolean} first - Allowed first byte.
   * @param {function(number): boolean} more - Allowed following bytes.
   * @returns {MorkLexToken} Exact run and source span.
   */
  #readRun(first, more) {
    const start = this.#start();
    if (!first(this.#bytes[start])) {
      throw new MorkLexError("MALFORMED_MORK", start);
    }
    this.#take(start);
    while (
      this.#position < this.#bytes.length &&
      more(this.#bytes[this.#position])
    ) {
      this.#take(start);
    }
    if (this.#position == this.#bytes.length) {
      throw new MorkLexError("TRUNCATED_MORK", this.#position);
    }
    return this.#finish(start, this.#bytes.slice(start, this.#position));
  }

  /**
   * Returns one source byte, enforcing EOF and the encoded-span limit.
   *
   * @param {number} start - Start of the current bounded span.
   * @returns {number} Consumed byte.
   */
  #take(start) {
    if (this.#position == this.#bytes.length) {
      throw new MorkLexError("TRUNCATED_MORK", this.#position);
    }
    if (this.#position - start >= this.#limits.maxTokenBytes) {
      throw new MorkLexError("RESOURCE_LIMIT", this.#position);
    }
    return this.#bytes[this.#position++];
  }

  /**
   * Decodes one required hex digit at its original byte position.
   *
   * @param {number} start - Start of the current bounded span.
   * @returns {number} Digit value from 0 through 15.
   */
  #readHexDigit(start) {
    const digit = hexDigit(this.#take(start));
    if (digit < 0) {
      throw new MorkLexError("MALFORMED_MORK", this.#position - 1);
    }
    return digit;
  }

  /**
   * Removes the optional unlike second byte of a CR/LF linebreak pair.
   *
   * @param {number} start - Start of the current bounded span.
   * @param {number} first - Already consumed CR or LF.
   */
  #skipNewlinePair(start, first) {
    const next = this.#bytes[this.#position];
    if ((next == 10 || next == 13) && next != first) {
      this.#take(start);
    }
  }

  /** Skips a line comment or an iteratively counted nested block comment. */
  #skipComment() {
    const start = this.#position;
    this.#take(start);
    const kind = this.#take(start);
    if (kind == 47) {
      while (
        this.#position < this.#bytes.length &&
        this.#bytes[this.#position] != 10 &&
        this.#bytes[this.#position] != 13
      ) {
        this.#take(start);
      }
      return;
    }
    if (kind != 42) {
      throw new MorkLexError("MALFORMED_MORK", this.#position - 1);
    }
    let depth = 1;
    while (depth) {
      const byte = this.#take(start);
      const next = this.#bytes[this.#position];
      if (byte == 42 && next == 47) {
        this.#take(start);
        depth--;
      } else if (byte == 47 && next == 42) {
        if (depth >= this.#limits.maxCommentDepth) {
          throw new MorkLexError("RESOURCE_LIMIT", this.#position - 1);
        }
        this.#take(start);
        depth++;
      }
    }
  }

  #finish(start, bytes) {
    this.#tokens++;
    return { start, end: this.#position, bytes };
  }
}

/**
 * Returns an ASCII hex digit's value, or -1. Not a header numeric getter.
 *
 * @param {number} byte - Source byte.
 * @returns {number} Hex digit value, or -1.
 */
function hexDigit(byte) {
  if (byte >= 48 && byte <= 57) {
    return byte - 48;
  }
  if (byte >= 65 && byte <= 70) {
    return byte - 55;
  }
  if (byte >= 97 && byte <= 102) {
    return byte - 87;
  }
  return -1;
}

/**
 * Tests the native morkCh_IsName set, not arbitrary atom value bytes.
 *
 * @param {number} byte - Source byte.
 * @returns {boolean} Whether this byte can start a bare name.
 */
function isNameStart(byte) {
  return (
    (byte >= 65 && byte <= 90) ||
    (byte >= 97 && byte <= 122) ||
    byte == 95 ||
    byte == 58
  );
}

/**
 * Tests native morkCh_IsMore; decimal digits are not in this set.
 *
 * @param {number} byte - Source byte.
 * @returns {boolean} Whether this byte can continue a bare name.
 */
function isNameMore(byte) {
  return (
    isNameStart(byte) || byte == 33 || byte == 43 || byte == 45 || byte == 63
  );
}
