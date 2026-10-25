/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { Gloda } = ChromeUtils.importESModule(
  "resource:///modules/gloda/GlodaPublic.sys.mjs"
);
const { GlodaMsgIndexer } = ChromeUtils.importESModule(
  "resource:///modules/gloda/IndexMsg.sys.mjs"
);
const { GlodaMsgSearcher } = ChromeUtils.importESModule(
  "resource:///modules/gloda/GlodaMsgSearcher.sys.mjs"
);

const tabmail = document.getElementById("tabmail");
const term = "facetbehaviorneedle";
const redKey = "facet-behavior-red";
const blueKey = "facet-behavior-blue";
const redLabel = "Facet red";
const blueLabel = "Facet blue";
const folders = [];
const messages = {};
const tabs = [];
/** @type {Window} */
let facetWindow;
/** @type {Document} */
let facetDocument;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["mailnews.database.global.indexer.enabled", true],
      ["mailnews.database.global.search.msg.limit", 100],
      ["mailnews.mark_message_read.auto", false],
      ["gloda.facetview.hidetimeline", true],
      ["gloda.show_as_list_by_default", false],
    ],
  });
  registerCleanupFunction(async () => {
    for (const tab of tabs.reverse()) {
      if (tabmail.tabInfo.includes(tab)) {
        tabmail.closeTab(tab);
      }
    }
    for (const folder of folders) {
      folder.parent.propagateDelete(folder, true);
    }
    MailServices.tags.deleteKey(redKey);
    MailServices.tags.deleteKey(blueKey);
    await SpecialPowers.popPrefEnv();
  });
  MailServices.tags.addTagForKey(redKey, redLabel, "#FF0000", "");
  MailServices.tags.addTagForKey(blueKey, blueLabel, "#0000FF", "");

  const rootFolder = MailServices.accounts.localFoldersServer.rootFolder;
  const generator = new MessageGenerator();
  for (const names of [
    ["A", "B", "C"],
    ["D", "E"],
  ]) {
    const folder = rootFolder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder("Facet " + names[0])
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    folders.push(folder);
    folder.addMessageBatch(
      names.map(name =>
        generator
          .makeMessage({
            subject: "Facet message " + name,
            body: { body: term },
          })
          .toMessageString()
      )
    );
    for (const header of folder.messages) {
      const name = header.subject.slice(-1);
      messages[name] = header;
      if (["A", "C", "E"].includes(name)) {
        folder.addKeywordsToMessages([header], redKey);
      }
      if (["B", "C"].includes(name)) {
        folder.addKeywordsToMessages([header], blueKey);
      }
      if (["A", "C"].includes(name)) {
        folder.markMessagesFlagged([header], true);
      }
    }
    const indexed = await new Promise(resolve => {
      Assert.ok(
        GlodaMsgIndexer.indexFolder(folder, { force: true, callback: resolve }),
        "Queued facet fixture folder for indexing"
      );
    });
    Assert.ok(indexed, "Completed facet fixture folder indexing");
  }
  for (const name of ["A", "B", "C", "D", "E"]) {
    Assert.ok(messages[name], "Created fixture " + name);
    await TestUtils.waitForCondition(() =>
      Gloda.isMessageIndexed(messages[name])
    );
  }
});

/**
 * Returns sorted physical locations for headers from either result view.
 *
 * @param {nsIMsgDBHdr[]} headers - The message headers.
 * @returns {string[]} Serialized folder/key pairs.
 */
function locations(headers) {
  return headers
    .map(header => JSON.stringify([header.folder.URI, header.messageKey]))
    .toSorted();
}

/**
 * Opens the production facet view and waits for all five fixture results.
 *
 * @returns {Promise<void>} Resolves when the result cards are rendered.
 */
async function openSearch() {
  const tab = tabmail.openTab("glodaFacet", {
    searcher: new GlodaMsgSearcher(null, term),
  });
  tabs.push(tab);
  await TestUtils.waitForCondition(
    () => tab.browser?.contentWindow.FacetContext?.everFaceted
  );
  facetWindow = tab.browser.contentWindow;
  facetDocument = facetWindow.document;
  await waitForResults(["A", "B", "C", "D", "E"]);
}

/**
 * Waits for rendered results to contain exactly the named fixture headers.
 *
 * @param {string[]} names - Expected fixture names.
 * @returns {Promise<void>} Resolves when the rendered membership matches.
 */
function waitForResults(names) {
  const expected = locations(names.map(name => messages[name]));
  return BrowserTestUtils.waitForMutationCondition(
    facetDocument.getElementById("results"),
    { childList: true, subtree: true },
    () => {
      const headers = [
        ...facetDocument.querySelectorAll("facet-result-message"),
      ].map(node => node.message.folderMessage);
      return (
        headers.every(Boolean) &&
        JSON.stringify(locations(headers)) == JSON.stringify(expected)
      );
    }
  );
}

/**
 * Checks the exact physical membership of the rendered result cards.
 *
 * @param {string[]} names - Expected fixture names.
 */
function assertResults(names) {
  const headers = [
    ...facetDocument.querySelectorAll("facet-result-message"),
  ].map(node => node.message.folderMessage);
  Assert.ok(headers.every(Boolean), "Every result resolves to a header");
  Assert.deepEqual(
    locations(headers),
    locations(names.map(name => messages[name]))
  );
}

/**
 * Finds a rendered facet row by its fixture-owned label.
 *
 * @param {string} attribute - The facet attribute name.
 * @param {string} label - The displayed tag or folder name.
 * @returns {HTMLLIElement} The matching row.
 */
function facetRow(attribute, label) {
  const facet = facetDocument.querySelector(
    'facet-discrete[name="' + attribute + '"]'
  );
  Assert.ok(facet, "Facet exists: " + attribute);
  const row = [...facet.querySelectorAll("li.bar")].find(
    node => node.querySelector(".bar-link").textContent == label
  );
  Assert.ok(row, "Facet row exists: " + label);
  return row;
}

/**
 * Chooses an include, exclude or undo action in the actual facet popup.
 *
 * @param {string} attribute - The facet attribute name.
 * @param {string} label - The displayed fixture label.
 * @param {string} action - The popup item's class: top, bottom or undo.
 * @param {string[]} expected - Expected result fixture names.
 * @returns {Promise<void>} Resolves after refinement and the row animation.
 */
async function chooseFacet(attribute, label, action, expected) {
  const row = facetRow(attribute, label);
  const facet = row.closest("facet-discrete");
  const popup = facetDocument.querySelector("facet-popup-menu");
  Assert.ok(popup, "Facet popup exists");
  row.scrollIntoView({ block: "center" });
  EventUtils.synthesizeMouseAtCenter(
    row.querySelector(".bar-link"),
    {},
    facetWindow
  );
  Assert.ok(BrowserTestUtils.isVisible(popup), "Facet popup is visible");
  const item = popup.querySelector(".popup-menuitem." + action);
  Assert.ok(item, "Requested facet action exists");
  Assert.ok(
    BrowserTestUtils.isVisible(item),
    "Requested facet action is visible"
  );
  const updated = waitForResults(expected);
  EventUtils.synthesizeMouseAtCenter(item, {}, facetWindow);
  await updated;
  Assert.equal(popup.getAttribute("variety"), "invisible", "Popup closes");
  // The original row is removed after the production animation or a rebuild.
  await BrowserTestUtils.waitForMutationCondition(
    facet,
    { childList: true, subtree: true },
    () => !row.isConnected
  );
  assertResults(expected);
}

add_task(async function test_refineFacets() {
  await openSearch();
  assertResults(["A", "B", "C", "D", "E"]);
  Assert.equal(
    facetRow("tag", redLabel).querySelector(".bar-count").textContent,
    "3"
  );
  Assert.equal(
    facetRow("tag", blueLabel).querySelector(".bar-count").textContent,
    "2"
  );
  const starCount = facetDocument.querySelector(
    "#facet-star .facet-checkbox-count"
  );
  Assert.ok(starCount, "Starred facet displays a count");
  Assert.equal(starCount.textContent, "2");

  await chooseFacet("tag", redLabel, "top", ["A", "C", "E"]);
  await chooseFacet("tag", blueLabel, "bottom", ["A", "E"]);
  const starred = facetDocument.querySelector("#facet-star input");
  Assert.ok(starred, "Starred facet has a checkbox");
  let updated = waitForResults(["A"]);
  EventUtils.synthesizeMouseAtCenter(starred, {}, facetWindow);
  await updated;
  assertResults(["A"]);
  updated = waitForResults(["A", "E"]);
  EventUtils.synthesizeMouseAtCenter(starred, {}, facetWindow);
  await updated;
  assertResults(["A", "E"]);

  const folderLabel =
    folders[0].localizedName + " (" + folders[0].rootFolder.localizedName + ")";
  await chooseFacet("folder", folderLabel, "top", ["A"]);
  await chooseFacet("folder", folderLabel, "undo", ["A", "E"]);
  await chooseFacet("tag", blueLabel, "undo", ["A", "C", "E"]);
  await chooseFacet("tag", redLabel, "undo", ["A", "B", "C", "D", "E"]);
  tabmail.closeTab(tabmail.currentTabInfo);
});

add_task(async function test_exportRefinedResultsAsList() {
  await openSearch();
  await chooseFacet("tag", redLabel, "top", ["A", "C", "E"]);
  await chooseFacet("tag", blueLabel, "bottom", ["A", "E"]);
  const opened = BrowserTestUtils.waitForEvent(tabmail.tabContainer, "TabOpen");
  const button = facetDocument.getElementById("gloda-showall");
  Assert.ok(button, "Result list export control exists");
  button.scrollIntoView({ block: "center" });
  EventUtils.synthesizeMouseAtCenter(button, {}, facetWindow);
  const {
    detail: { tabInfo },
  } = await opened;
  tabs.push(tabInfo);
  Assert.equal(tabInfo.mode.name, "mail3PaneTab");
  await TestUtils.waitForCondition(
    () => tabInfo.chromeBrowser.contentWindow.gDBView?.rowCount == 2
  );
  const about3Pane = tabInfo.chromeBrowser.contentWindow;
  Assert.ok(
    about3Pane.gViewWrapper.isSynthetic,
    "List displays search results"
  );
  Assert.deepEqual(
    locations([
      about3Pane.gDBView.getMsgHdrAt(0),
      about3Pane.gDBView.getMsgHdrAt(1),
    ]),
    locations([messages.A, messages.E]),
    "Exported list contains exactly the refined physical messages"
  );
});
