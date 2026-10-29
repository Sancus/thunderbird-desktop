/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { getSearchHighlightRanges, getSearchBodySnippet } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/SearchOffsets.sys.mjs"
  );

const text = {
  id: "104",
  textRevision: "projection-1",
  subject: "subject",
  body: "é 😀 café 自動 end",
};
const hit = {
  id: "104",
  textRevision: "projection-1",
  offsetsUtf8: "1 1 14 6 1 0 8 5",
};

add_task(function test_utf8RangesUseUtf16Boundaries() {
  Assert.deepEqual(getSearchHighlightRanges(hit, text), [
    { start: 5, end: 9 },
    { start: 10, end: 12 },
  ]);
  Assert.deepEqual(
    getSearchHighlightRanges({ ...hit, offsetsUtf8: "1 0 3 4" }, text),
    [{ start: 2, end: 4 }],
    "A supplementary character keeps both UTF-16 code units"
  );
  Assert.equal(text.body.slice(2, 4), "😀");
  Assert.deepEqual(
    getSearchHighlightRanges({ ...hit, offsetsUtf8: "0 0 0 7" }, text),
    [],
    "Legacy body-column numbering is not applied to replacement body text"
  );
});

add_task(function test_overlappingAndDuplicateRangesMerge() {
  Assert.deepEqual(
    getSearchHighlightRanges(
      {
        ...hit,
        offsetsUtf8: "1 1 17 3 1 0 8 5 1 2 14 6 1 3 8 5",
      },
      text
    ),
    [
      { start: 5, end: 9 },
      { start: 10, end: 12 },
    ]
  );
  Assert.deepEqual(
    getSearchHighlightRanges({ ...hit, offsetsUtf8: "" }, text),
    []
  );
});

add_task(function test_wrongPhysicalCopyAndProjectionDoNotHighlight() {
  Assert.equal(getSearchHighlightRanges(hit, { ...text, id: "106" }), null);
  Assert.equal(
    getSearchHighlightRanges(hit, { ...text, textRevision: "projection-2" }),
    null
  );
  Assert.equal(
    getSearchHighlightRanges(
      { ...hit, textRevision: "" },
      { ...text, textRevision: "" }
    ),
    null
  );
  Assert.equal(getSearchHighlightRanges(hit, null), null);
});

add_task(function test_malformedOrSplitCharacterOffsetsReject() {
  for (const offsetsUtf8 of [
    "1 0 0",
    "1 0 -1 2",
    "1 0 1e2 2",
    "5 0 0 1",
    "1 0 0 0",
  ]) {
    Assert.throws(
      () => getSearchHighlightRanges({ ...hit, offsetsUtf8 }, text),
      error =>
        error.name == "TypeError" && error.message == "Malformed FTS offsets",
      offsetsUtf8
    );
  }
  for (const offsetsUtf8 of [
    "1 0 0 1",
    "1 0 4 1",
    "1 0 200 1",
    "1 0 9007199254740991 2",
  ]) {
    Assert.throws(
      () => getSearchHighlightRanges({ ...hit, offsetsUtf8 }, text),
      error =>
        error.name == "RangeError" &&
        [
          "Invalid UTF-8 range",
          "FTS range is outside a UTF-8 character boundary",
        ].includes(error.message),
      offsetsUtf8
    );
  }
  Assert.throws(
    () => getSearchHighlightRanges(hit, text, "unknown"),
    error =>
      error.name == "TypeError" && error.message == "Unknown search text field"
  );
});

add_task(function test_bodySnippetContextAndOffsets() {
  const document = {
    ...text,
    body: "zero\none\ntwo\nthree\nneedle\nfive\nsix\nseven\neight\nnine\n",
  };
  const result = getSearchBodySnippet(
    { ...hit, offsetsUtf8: "1 0 19 6 1 1 41 5" },
    document
  );
  Assert.equal(result.text, "…\ntwo\nthree\nneedle\nfive\nsix…");
  Assert.deepEqual(result.ranges, [{ start: 12, end: 18 }]);
  Assert.equal(result.firstMatchText, "needle");
  Assert.equal(result.text.substring(12, 18), "needle");
});

add_task(function test_bodySnippetUsesWholeUnicodeMatches() {
  const result = getSearchBodySnippet(hit, text);
  Assert.equal(result.text, text.body);
  Assert.deepEqual(result.ranges, [
    { start: 5, end: 9 },
    { start: 10, end: 12 },
  ]);
  Assert.equal(result.firstMatchText, "café");
  const supplementary = getSearchBodySnippet(
    { ...hit, offsetsUtf8: "1 0 3 4" },
    text
  );
  Assert.equal(supplementary.firstMatchText, "😀");
});

add_task(function test_subjectOnlyAndUnavailableBodySnippets() {
  const subjectOnly = getSearchBodySnippet(
    { ...hit, offsetsUtf8: "0 0 0 7" },
    text
  );
  Assert.equal(subjectOnly.text, text.body);
  Assert.deepEqual(subjectOnly.ranges, []);
  Assert.equal(subjectOnly.firstMatchText, null);
  Assert.deepEqual(
    getSearchBodySnippet(
      { ...hit, offsetsUtf8: "" },
      { ...text, body: "", bodyIndexed: false }
    ),
    {
      text: "",
      ranges: [],
      firstMatchText: null,
    }
  );
  Assert.equal(
    getSearchBodySnippet(hit, { ...text, textRevision: "projection-2" }),
    null
  );
});
