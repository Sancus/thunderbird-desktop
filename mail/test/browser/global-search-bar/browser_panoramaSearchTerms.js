/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchCompletion.js */

// Use the same ordinary fixture for every bounded whole-file scenario.
Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchCompletion.js", gTestPath).href,
  this
);

add_task(async function test_nativeToolbarQuotedPhraseAndTermOrder() {
  await searchToolbarQuery('"s410amber s410violet"', queryFixture.phrase, true);
  await searchToolbarQuery("s410amber s410violet", queryFixture.terms, true);
});

add_task(async function test_nativeToolbarUnmatchedQuoteKeepsBothTerms() {
  await searchToolbarQuery('"s410amber s410violet', queryFixture.terms, false);
});

add_task(async function test_nativeToolbarAccentAndCjkInput() {
  await searchToolbarQuery("CAFÉ", queryFixture.accent, true);
  await searchToolbarQuery("cafe", queryFixture.accent, false);
  await searchToolbarQuery("東京検索", queryFixture.phrase, false);
});
