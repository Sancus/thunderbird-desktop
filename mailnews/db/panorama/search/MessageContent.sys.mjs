/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Counts leading quote markers, preserving whitespace after the last marker.
 *
 * @param {string} aLine - One plaintext body line.
 * @returns {[number, string]} Quote depth and text after the quote markers.
 */
function countQuoteDepthAndNormalize(aLine) {
  let count = 0;
  let lastStartOffset = 0;

  for (let i = 0; i < aLine.length; i++) {
    const c = aLine[i];
    if (c == ">") {
      count++;
      lastStartOffset = i + 1;
    } else if (c != " ") {
      return [
        count,
        lastStartOffset ? aLine.substring(lastStartOffset) : aLine,
      ];
    }
  }

  return [count, lastStartOffset ? aLine.substring(lastStartOffset) : aLine];
}

/**
 * Emits the existing ordinary-mail content and quote hunks.
 *
 * @param {object} aMeta - Provider metadata; unused for ordinary mail.
 * @param {string[]} aBodyLines - Plaintext lines; not modified.
 * @param {object} aContent - Consumer with volunteerContent, content and quoted.
 * @returns {boolean} Whether the consumer accepted ordinary-mail content.
 */
export function whittleMessageContent(aMeta, aBodyLines, aContent) {
  if (!aContent.volunteerContent(aContent.kPriorityBase)) {
    return false;
  }

  // duplicate the list; we mutate somewhat...
  const bodyLines = aBodyLines.concat();

  // lastNonBlankLine originally was just for detecting quoting idioms where
  //  the "wrote" line was separated from the quoted block by a blank line.
  // Now we also use it for whitespace suppression at the boundaries of
  //  quoted and un-quoted text.  (We keep blank lines within the same
  //  'block' of quoted or non-quoted text.)
  // Because we now have two goals for it, and we still want to suppress blank
  //  lines when there is a 'wrote' line involved, we introduce...
  //  prevLastNonBlankLine!  This arguably suggests refactoring should be the
  //  next step, but things work for now.
  let rangeStart = 0,
    lastNonBlankLine = null,
    prevLastNonBlankLine = null;
  let inQuoteDepth = 0;
  for (let [iLine, line] of bodyLines.entries()) {
    if (!line || line == "\xa0") {
      /* unicode non breaking space */
      continue;
    }

    if (line.startsWith(">")) {
      if (!inQuoteDepth) {
        let rangeEnd = iLine - 1;
        let quoteRangeStart = iLine;
        // see if the last non-blank-line was a lead-in...
        if (lastNonBlankLine != null) {
          // TODO: localize quote range start detection
          if (aBodyLines[lastNonBlankLine].includes("wrote")) {
            quoteRangeStart = lastNonBlankLine;
            rangeEnd = lastNonBlankLine - 1;
            // we 'used up' lastNonBlankLine, let's promote the prev guy to
            //  be the new lastNonBlankLine for the next logic block
            lastNonBlankLine = prevLastNonBlankLine;
          }
          // eat the trailing whitespace...
          if (lastNonBlankLine != null) {
            rangeEnd = Math.min(rangeEnd, lastNonBlankLine);
          }
        }
        if (rangeEnd >= rangeStart) {
          aContent.content(aBodyLines.slice(rangeStart, rangeEnd + 1));
        }

        [inQuoteDepth, line] = countQuoteDepthAndNormalize(line);
        bodyLines[iLine] = line;
        rangeStart = quoteRangeStart;
      } else {
        let curQuoteDepth;
        [curQuoteDepth, line] = countQuoteDepthAndNormalize(line);
        bodyLines[iLine] = line;

        if (curQuoteDepth != inQuoteDepth) {
          // we could do some "wrote" compensation here, but it's not really
          //  as important.  let's wait for a more clever algorithm.
          aContent.quoted(aBodyLines.slice(rangeStart, iLine), inQuoteDepth);
          inQuoteDepth = curQuoteDepth;
          rangeStart = iLine;
        }
      }
    } else if (inQuoteDepth) {
      aContent.quoted(aBodyLines.slice(rangeStart, iLine), inQuoteDepth);
      inQuoteDepth = 0;
      rangeStart = iLine;
    }

    prevLastNonBlankLine = lastNonBlankLine;
    lastNonBlankLine = iLine;
  }

  if (inQuoteDepth) {
    aContent.quoted(aBodyLines.slice(rangeStart), inQuoteDepth);
  } else {
    aContent.content(aBodyLines.slice(rangeStart, lastNonBlankLine + 1));
  }

  return true;
}

/**
 * Returns ordinary-mail content without quoted replies and their lead-ins.
 *
 * @param {string[]} bodyLines - Decoded plaintext lines.
 * @returns {string} Text with the same content-hunk boundaries used for indexing.
 */
export function getMailBodyText(bodyLines) {
  let text = "";
  whittleMessageContent({}, bodyLines, {
    kPriorityBase: 0,
    volunteerContent: () => true,
    content(lines) {
      const part = lines.join("\n");
      text = text ? text + "\n" + part : part;
    },
    quoted() {},
  });
  return text;
}

/**
 * Returns an ordinary-mail snippet and its source subject metadata.
 * Removes quoted replies and their lead-ins using the mail content whittler.
 *
 * @param {MimeMessage} mimeMessage - Decoded MIME tree.
 * @param {?nsIMsgFolder} folder - HTML conversion folder; plaintext permits null.
 * @param {number} [length] - Snippet limit in UTF-16 code units, including ellipsis.
 * @returns {[string, {subject: ?string}]} Snippet and metadata; no author override.
 * @throws {Error} Original MIME conversion errors.
 */
export function mimeMsgToContentSnippetAndMeta(mimeMessage, folder, length) {
  let text = getMailBodyText(
    mimeMessage.coerceBodyToPlaintext(folder).split(/\r?\n/)
  );
  if (length + 1) {
    text = text.substring(0, length + 1);
  }
  if (length && text.length > length) {
    let end = length - 1;
    if (text.codePointAt(end - 1) > 0xffff) {
      end--;
    }
    text = text.substring(0, end) + "…";
  }
  return [text, { subject: mimeMessage.get("subject") }];
}
