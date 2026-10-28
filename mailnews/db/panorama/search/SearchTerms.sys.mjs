/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Splits search text into words and double-quoted phrases.
 * An unmatched opening quote is ignored, as in the global search bar.
 *
 * @param {string} text - Search bar text.
 * @returns {string[]} Words and phrases without enclosing quotes.
 */
export function parseSearchTerms(text) {
  text = text.trim();
  const terms = [];
  while (text) {
    if (text.startsWith('"')) {
      const end = text.indexOf('"', 1);
      if (end == -1) {
        text = text.substring(1);
        continue;
      }
      const phrase = text.substring(1, end).trim();
      if (phrase) {
        terms.push(phrase);
      }
      text = text.substring(end + 1);
      continue;
    }
    const end = text.indexOf(" ");
    if (end == -1) {
      terms.push(text);
      break;
    }
    if (end) {
      terms.push(text.substring(0, end));
    }
    text = text.substring(end + 1);
  }
  return terms;
}

/**
 * Builds a mozporter FTS3 expression from parsed search terms.
 * Short Latin terms are omitted; one-character CJK terms use a prefix.
 *
 * @param {string[]} terms - Parsed words and phrases.
 * @param {boolean} [andTerms=true] - Require all terms instead of any term.
 * @returns {string} A bound MATCH expression, or empty for no usable terms.
 */
export function makeMatchExpression(terms, andTerms = true) {
  const expressions = [];
  for (const term of terms) {
    if (/^NEAR(\/\d+)?$/.test(term)) {
      expressions.push(term);
    } else if (term.length == 1 && term.charCodeAt(0) >= 0x2000) {
      expressions.push(term + "*");
    } else if (
      (term.length == 2 &&
        term.charCodeAt(0) >= 0x2000 &&
        term.charCodeAt(1) >= 0x2000) ||
      term.length >= 3
    ) {
      expressions.push('"' + term.replaceAll('"', " ") + '"');
    }
  }
  return expressions.join(andTerms ? " " : " OR ");
}
