/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const tabmail = document.getElementById("tabmail");
let win, doc;

add_setup(async function () {
  const tab = tabmail.openTab("contentTab", {
    url: "chrome://mochitests/content/browser/comm/mail/base/test/browser/widgets/files/glodaFacetResultMessage.xhtml",
  });

  info("Loading tab...");
  await BrowserTestUtils.browserLoaded(tab.browser);
  tab.browser.focus();

  win = tab.browser.contentWindow;
  doc = win.document;
  await win.customElements.whenDefined("facet-result-message");

  // The facet host supplies this context before any result cards are built.
  win.FacetContext = {
    collection: {},
    hoverFacet() {},
    unhoverFacet() {},
  };

  registerCleanupFunction(() => {
    tabmail.closeOtherTabs(tabmail.tabInfo[0]);
  });
});

/**
 * Create a minimal gloda-like message object.
 *
 * @param {object[]} aRecipients - The recipient identities.
 * @returns {object} The message.
 */
function createMessage(aRecipients) {
  return {
    subject: "Test subject",
    from: { value: "author@example.com", contact: { name: "Author" } },
    date: new Date(),
    recipients: aRecipients,
    starred: false,
    read: true,
  };
}

/**
 * Render a message with the given recipients and return the resulting nodes.
 *
 * @param {object[]} aRecipients - The recipient identities.
 * @returns {Element} The facet-result-message element.
 */
function renderMessage(aRecipients) {
  const element = doc.createElement("facet-result-message");
  element.message = createMessage(aRecipients);
  doc.body.appendChild(element);
  return element;
}

/**
 * Get the rendered recipient names.
 *
 * @param {Element} aElement - The facet-result-message element.
 * @returns {string[]} The rendered recipient names.
 */
function getRecipients(aElement) {
  return [...aElement.querySelectorAll(".message-recipient")].map(
    node => node.textContent
  );
}

function recipient(name) {
  return { contact: { name } };
}

add_task(function testSingleRecipient() {
  const element = renderMessage([recipient("Alice")]);

  Assert.deepEqual(
    getRecipients(element),
    ["Alice"],
    "a single recipient should be shown"
  );
  element.remove();
});

add_task(function testMultipleRecipients() {
  const element = renderMessage([recipient("Alice"), recipient("Bob")]);

  Assert.deepEqual(
    getRecipients(element),
    ["Alice", "Bob"],
    "all recipients should be shown"
  );
  element.remove();
});

add_task(function testExactlyMaxRecipients() {
  const element = renderMessage([
    recipient("Alice"),
    recipient("Bob"),
    recipient("Carol"),
  ]);

  Assert.deepEqual(
    getRecipients(element),
    ["Alice", "Bob", "Carol"],
    "all three recipients should be shown"
  );
  Assert.ok(
    !element.textContent.includes("other"),
    "no 'others' label should be shown for exactly three recipients"
  );
  element.remove();
});

add_task(function testOneOtherRecipient() {
  const element = renderMessage([
    recipient("Alice"),
    recipient("Bob"),
    recipient("Carol"),
    recipient("Dave"),
  ]);

  Assert.deepEqual(
    getRecipients(element),
    ["Alice", "Bob", "Carol", "1 other"],
    "the singular 'other' form should be used for a single extra recipient"
  );
  element.remove();
});

add_task(function testMoreThanMaxRecipients() {
  const element = renderMessage([
    recipient("Alice"),
    recipient("Bob"),
    recipient("Carol"),
    recipient("Dave"),
    recipient("Erin"),
  ]);

  Assert.deepEqual(
    getRecipients(element),
    ["Alice", "Bob", "Carol", "2 others"],
    "the recipients should be limited and an 'others' label added"
  );
  element.remove();
});

add_task(function testSeparatorsAreClassified() {
  const element = renderMessage([
    recipient("Alice"),
    recipient("Bob"),
    recipient("Carol"),
  ]);

  Assert.deepEqual(
    [...element.querySelectorAll(".message-recipient-separator")].map(
      node => node.textContent
    ),
    [", ", ", and "],
    "separator nodes should be rendered by Intl.ListFormat"
  );
  element.remove();
});

add_task(function testRecipientWithoutNameIsSkipped() {
  const element = renderMessage([
    { contact: { name: "" } },
    { contact: {} },
    recipient("Bob"),
  ]);

  Assert.deepEqual(
    getRecipients(element),
    ["Bob", "2 others"],
    "recipients without a name should not be rendered, but still be counted"
  );
  element.remove();
});

add_task(function testOthersCountUsesAllRecipients() {
  // The "N others" count must cover every recipient that is not shown, so
  // that the names on screen plus the label always add up to the total
  // number of recipients.
  const element = renderMessage([
    { contact: { name: "" } },
    recipient("Bob"),
    recipient("Carol"),
    recipient("Dave"),
  ]);

  Assert.deepEqual(
    getRecipients(element),
    ["Bob", "Carol", "Dave", "1 other"],
    "the three named recipients are shown and the nameless one is counted as other"
  );
  element.remove();
});

add_task(function testToLabel() {
  const element = renderMessage([recipient("Alice")]);

  const toLabel = element.querySelector(".message-to-label");
  Assert.ok(toLabel, "the To: label should be present");
  Assert.equal(toLabel.textContent, "to:", "the To: label should read 'to:'");
  element.remove();
});

/**
 * Renders a body with supplied FTS byte offsets in the isolated widget fixture.
 * Sets the fixture collection to the supplied offsets.
 *
 * @param {string} body - The exact indexed body revision used by the offsets.
 * @param {string} offsets - FTS column/term/UTF-8 offset/byte-length tuples.
 * @returns {HTMLElement} The rendered result card.
 */
function renderSnippet(body, offsets) {
  const element = doc.createElement("facet-result-message");
  element.message = {
    ...createMessage([]),
    id: 1,
    indexedBodyText: body,
  };
  win.FacetContext.collection = { stashedColumns: { 1: [offsets] } };
  registerCleanupFunction(() => element.remove());
  doc.body.appendChild(element);
  return element;
}

add_task(function test_snippetMultibyteOffsets() {
  // Prefix: é (2), space (1), 😀 (4), space (1). Hits: café (5), 自動 (6).
  const element = renderSnippet("é 😀 café 自動 end", "0 0 8 5 0 1 14 6");
  const snippet = element.querySelector(".message-body");
  Assert.ok(snippet, "Result has a body snippet");
  Assert.equal(snippet.textContent, "é 😀 café 自動 end");
  Assert.deepEqual(
    [...snippet.querySelectorAll(".message-body-fulltext-match")].map(
      node => node.textContent
    ),
    ["café", "自動"],
    "UTF-8 offsets highlight whole multibyte words after a supplementary character"
  );
  Assert.equal(element.firstMatchText, "café");
  element.remove();
});

add_task(function test_snippetSupplementaryHit() {
  const element = renderSnippet("lead 😀 tail", "0 0 5 4");
  const match = element.querySelector(".message-body-fulltext-match");
  Assert.ok(match, "Supplementary character has a highlight");
  Assert.equal(match.textContent, "😀", "Both surrogate halves stay together");
  Assert.equal(element.firstMatchText, "😀");
  const snippet = element.querySelector(".message-body");
  Assert.ok(snippet, "Result has a body snippet");
  Assert.equal(snippet.textContent, "lead 😀 tail");
  element.remove();
});

add_task(function test_snippetMatchContext() {
  // The ASCII hit begins after 5 + 4 + 4 + 6 bytes of preceding lines.
  const element = renderSnippet(
    "zero\none\ntwo\nthree\nneedle\nfive\nsix\nseven\neight\nnine\n",
    "0 0 19 6"
  );
  const snippet = element.querySelector(".message-body");
  Assert.ok(snippet, "Result has a body snippet");
  Assert.equal(
    snippet.textContent,
    "…\ntwo\nthree\nneedle\nfive\nsix…",
    "Snippet shows context around the first hit and marks omitted lines"
  );
  const match = snippet.querySelector(".message-body-fulltext-match");
  Assert.ok(match, "Context snippet contains the requested hit");
  Assert.equal(match.textContent, "needle");
  Assert.equal(element.firstMatchText, "needle");
  element.remove();
});

add_task(function test_snippetSubjectOnlyMatch() {
  const element = renderSnippet("ordinary\ntext", "1 0 0 5");
  const snippet = element.querySelector(".message-body");
  Assert.ok(snippet, "Result has a body snippet");
  Assert.equal(snippet.textContent, "ordinary\ntext");
  Assert.equal(
    snippet.querySelectorAll(".message-body-fulltext-match").length,
    0
  );
  Assert.equal(
    element.firstMatchText,
    undefined,
    "Subject offsets do not mark the body"
  );
  element.remove();
});
