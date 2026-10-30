/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { MessageGenerator, SyntheticMessageSet } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { add_message_sets_to_folders } = ChromeUtils.importESModule(
  "resource://testing-common/mail/MessageInjectionHelpers.sys.mjs"
);
const { Gloda } = ChromeUtils.importESModule(
  "resource:///modules/gloda/GlodaPublic.sys.mjs"
);
const { GlodaConstants } = ChromeUtils.importESModule(
  "resource:///modules/gloda/GlodaConstants.sys.mjs"
);
const { TagNoun } = ChromeUtils.importESModule(
  "resource:///modules/gloda/NounTag.sys.mjs"
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
const greenKey = "facet-behavior-green";
const greenLabel = "Facet green";
const own = ["Facet Own", "facet-own@example.invalid"];
const alice = ["Facet Alice", "facet-alice@example.invalid"];
const bob = ["Facet Bob", "facet-bob@example.invalid"];
const carol = ["Facet Carol", "facet-carol@example.invalid"];
const pagingTerm = "facetpagingneedle";
const duplicateTerm = "facetduplicateneedle";
const pagingNames = Array.from({ length: 12 }, (_, i) => "P" + i);
const fixture = {
  A: { from: own, to: [alice], date: new Date(2020, 0, 10, 12) },
  B: { from: alice, to: [bob], date: new Date(2020, 0, 20, 12) },
  C: { from: bob, to: [own], date: new Date(2020, 1, 15, 12) },
  D: { from: alice, to: [carol], date: new Date(2020, 2, 10, 12) },
  E: { from: carol, to: [own], date: new Date(2020, 2, 20, 12) },
};
const folders = [];
const messages = {};
const tabs = [];
/** @type {Window} */
let facetWindow;
/** @type {Document} */
let facetDocument;

add_setup(async function () {
  Assert.equal(
    Services.prefs.getBoolPref("mail.panorama.enabled", false),
    false
  );
  Assert.equal(
    Components.manager
      .QueryInterface(Ci.nsIComponentRegistrar)
      .contractIDToCID("@mozilla.org/msgDatabase/msgDBService;1")
      .toString(),
    "{03223c50-1e88-45e8-ba1a-7ce792dc3fc3}",
    "The facet behavior reference uses the legacy backend"
  );
  Assert.equal(MailServices.accounts.getIdentity("id1").email, own[1]);
  Assert.equal(MailServices.accounts.getIdentity("id1").fullName, own[0]);
  Assert.ok(
    Object.values(Gloda.myIdentities).some(
      identity => identity.value == own[1]
    ),
    "The ordinary manifest supplied our real identity before Gloda initialized"
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["mailnews.database.global.indexer.enabled", true],
      ["mailnews.database.global.search.msg.limit", 100],
      ["mailnews.mark_message_read.auto", false],
      ["gloda.facetview.hidetimeline", true],
      ["gloda.show_as_list_by_default", false],
      ["gloda.facetview.sortby", 0],
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
    MailServices.tags.deleteKey(greenKey);
    await SpecialPowers.popPrefEnv();
  });
  MailServices.tags.addTagForKey(redKey, redLabel, "#FF0000", "");
  MailServices.tags.addTagForKey(blueKey, blueLabel, "#0000FF", "");
  MailServices.tags.addTagForKey(greenKey, greenLabel, "#00FF00", "");
  Assert.equal(TagNoun.getTag(greenKey).tag, greenLabel);
  Assert.equal(TagNoun.getTag(redKey).tag, redLabel);
  Assert.equal(TagNoun.getTag(blueKey).tag, blueLabel);

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
    const synthetic = names.map(name =>
      generator.makeMessage({
        ...fixture[name],
        subject: "Facet message " + name,
        attachments: ["A", "C"].includes(name)
          ? [
              {
                body: "fixture attachment",
                filename: "facet.txt",
                contentType: "text/plain",
              },
            ]
          : undefined,
        body: { body: term },
      })
    );
    await add_message_sets_to_folders(
      [folder],
      [new SyntheticMessageSet(synthetic)]
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
      if (name == "D") {
        folder.addKeywordsToMessages([header], greenKey);
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
  const paging = pagingNames.map((name, index) =>
    generator.makeMessage({
      subject: "Facet page " + name,
      body: { body: pagingTerm },
      date: new Date(2021, 0, index + 1, 12),
      from: alice,
      to: [own],
    })
  );
  await add_message_sets_to_folders(
    [folders[0]],
    [new SyntheticMessageSet(paging)]
  );
  for (const header of folders[0].messages) {
    if (header.subject.startsWith("Facet page ")) {
      const name = header.subject.slice("Facet page ".length);
      messages[name] = header;
      if (Number(name.slice(1)) % 2 == 0) {
        folders[0].addKeywordsToMessages([header], redKey);
      }
    }
  }
  const duplicate = generator.makeMessage({
    subject: "Facet duplicate",
    body: { body: duplicateTerm },
    date: new Date(2022, 0, 1, 12),
    from: alice,
    to: [own],
  });
  for (const [index, folder] of folders.entries()) {
    await add_message_sets_to_folders(
      [folder],
      [new SyntheticMessageSet([duplicate])]
    );
    messages["copy" + index] = [...folder.messages].find(
      header => header.subject == "Facet duplicate"
    );
    const indexed = await new Promise(resolve => {
      Assert.ok(
        GlodaMsgIndexer.indexFolder(folder, { force: true, callback: resolve })
      );
    });
    Assert.ok(indexed, "Indexed paging messages and a real duplicate copy");
  }
  for (const name of Object.keys(messages)) {
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
 * Opens the production facet view and waits for the expected fixture results.
 *
 * @param {string} [text] - The fixture search term.
 * @param {?string[]} [expected] - The initially rendered fixture names, or null
 *   when observing the initially chosen duplicate representative.
 *
 * @returns {Promise<void>} Resolves when the result cards are rendered.
 */
async function openSearch(text = term, expected = ["A", "B", "C", "D", "E"]) {
  const tab = tabmail.openTab("glodaFacet", {
    searcher: new GlodaMsgSearcher(null, text),
  });
  tabs.push(tab);
  await TestUtils.waitForCondition(
    () => tab.browser?.contentWindow.FacetContext?.everFaceted
  );
  facetWindow = tab.browser.contentWindow;
  facetDocument = facetWindow.document;
  if (expected) {
    await waitForResults(expected);
  } else {
    await BrowserTestUtils.waitForMutationCondition(
      facetDocument.getElementById("results"),
      { childList: true, subtree: true },
      () => facetDocument.querySelectorAll("facet-result-message").length == 1
    );
  }
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
  const starBubble = facetDocument.querySelector(
    "#facet-star .facet-checkbox-bubble"
  );
  Assert.ok(BrowserTestUtils.isVisible(starBubble));
  starBubble.scrollIntoView({ block: "center" });
  let updated = waitForResults(["A"]);
  EventUtils.synthesizeMouseAtCenter(starBubble, {}, facetWindow);
  await updated;
  assertResults(["A"]);
  updated = waitForResults(["A", "E"]);
  EventUtils.synthesizeMouseAtCenter(starBubble, {}, facetWindow);
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

/**
 * Returns current rendered headers, retaining the displayed order.
 *
 * @returns {nsIMsgDBHdr[]} The physical headers on result cards.
 */
function renderedHeaders() {
  return [...facetDocument.querySelectorAll("facet-result-message")].map(
    node => node.message.folderMessage
  );
}

/**
 * Checks a boolean facet count against the independent fixture count.
 *
 * @param {string} attribute - The facet attribute.
 * @param {number} expected - The exact expected count.
 */
function assertBooleanCount(attribute, expected) {
  const facet = facetDocument.getElementById("facet-" + attribute);
  Assert.equal(
    Number(facet.querySelector(".facet-checkbox-count").textContent),
    expected,
    attribute + " count"
  );
}

/**
 * Toggles a real boolean control and checks its resulting physical set.
 *
 * @param {string} attribute - The facet attribute.
 * @param {string[]} expected - Expected fixture names after the click.
 * @returns {Promise<void>} Resolves after the rendered membership changes.
 */
async function toggleBoolean(attribute, expected) {
  const facet = facetDocument.getElementById("facet-" + attribute);
  Assert.ok(!facet.disabled, attribute + " is an actionable facet");
  const bubble = facet.querySelector(".facet-checkbox-bubble");
  bubble.scrollIntoView({ block: "center" });
  const updated = waitForResults(expected);
  EventUtils.synthesizeMouseAtCenter(bubble, {}, facetWindow);
  await updated;
  assertResults(expected);
}

/**
 * Shows the real timeline without changing its membership.
 *
 * @returns {Promise<void>} Resolves when the timeline is visible.
 */
async function showTimeline() {
  const date = facetDocument.getElementById("facet-date");
  const button = facetDocument.getElementById("date-toggle");
  if (date.hasAttribute("hide")) {
    button.scrollIntoView({ block: "center" });
    EventUtils.synthesizeMouseAtCenter(button, {}, facetWindow);
    Assert.ok(button.hasAttribute("checked"));
  }
  await BrowserTestUtils.waitForMutationCondition(
    date,
    { attributes: true },
    () => !date.hasAttribute("hide") && BrowserTestUtils.isVisible(date)
  );
  await TestUtils.waitForCondition(
    () => !date.getAnimations().length,
    "The timeline expansion has finished before clicking a calendar label"
  );
}

/**
 * Selects a rendered month label in the production timeline.
 *
 * @param {number} month - Zero-based month in the fixed 2020 fixture.
 * @param {string[]} expected - Independent expected physical membership.
 * @returns {Promise<void>} Resolves after the date constraint renders.
 */
async function chooseMonth(month, expected) {
  const date = facetDocument.getElementById("facet-date");
  // The pinned Protovis stores each actual SVG element on its scene node.
  // Locate the calendar interval in that rendered scene, then click its SVG.
  const scenes = date.vis.vis.scene.flatMap(panel => panel.children.flat());
  const label = scenes.find(scene => {
    const value = scene.data;
    return (
      Array.isArray(value) &&
      value[3]?.getFullYear?.() == 2020 &&
      value[3].getMonth() == month &&
      value[3].getDate() == 1 &&
      value[4].getMonth() == month + 1
    );
  })?.svg;
  Assert.ok(label, "The requested month has a rendered calendar control");
  label.scrollIntoView({ block: "center" });
  const updated = waitForResults(expected);
  EventUtils.synthesizeMouseAtCenter(label, {}, facetWindow);
  await updated;
  assertResults(expected);
  Assert.equal(date.getAttribute("zoomedout"), "false");
}

/**
 * Exports the active set through the real control and checks every list row.
 *
 * @param {string[]} expected - Exact fixture names in the exported set.
 * @returns {Promise<object>} The newly opened list tab.
 */
async function exportActiveSet(expected) {
  const opened = BrowserTestUtils.waitForEvent(tabmail.tabContainer, "TabOpen");
  const button = facetDocument.getElementById("gloda-showall");
  button.scrollIntoView({ block: "center" });
  EventUtils.synthesizeMouseAtCenter(button, {}, facetWindow);
  const {
    detail: { tabInfo },
  } = await opened;
  tabs.push(tabInfo);
  Assert.equal(tabInfo.mode.name, "mail3PaneTab");
  await TestUtils.waitForCondition(
    () =>
      tabInfo.chromeBrowser.contentWindow.gDBView?.numMsgsInView ==
      expected.length
  );
  const view = tabInfo.chromeBrowser.contentWindow.gDBView;
  const headers = Array.from({ length: view.rowCount }, (_, index) =>
    view.getMsgHdrAt(index)
  );
  Assert.deepEqual(
    locations(headers),
    locations(expected.map(name => messages[name]))
  );
  return tabInfo;
}

add_task(async function test_countsAndOwnIdentity() {
  await openSearch();
  for (const [label, count] of [
    [alice[0], 3],
    [bob[0], 2],
    [carol[0], 2],
  ]) {
    Assert.equal(
      Number(
        facetRow("involves", label).querySelector(".bar-count").textContent
      ),
      count
    );
  }
  const people = facetDocument.querySelector('facet-discrete[name="involves"]');
  Assert.equal(
    people.querySelectorAll("li.bar").length,
    3,
    "Own identity is excluded, with no extra people"
  );
  Assert.ok(!people.textContent.includes(own[0]));
  assertBooleanCount("fromMe", 1);
  assertBooleanCount("toMe", 2);
  assertBooleanCount("star", 2);
  assertBooleanCount("attachmentTypes", 2);
  for (const [index, count] of [
    [0, 3],
    [1, 2],
  ]) {
    const label =
      folders[index].localizedName +
      " (" +
      folders[index].rootFolder.localizedName +
      ")";
    Assert.equal(
      Number(facetRow("folder", label).querySelector(".bar-count").textContent),
      count
    );
  }
  const account = facetWindow.FacetContext.faceters.find(
    faceter => faceter.attrDef.attributeName == "account"
  );
  Assert.equal(account.orderedGroups.length, 1);
  Assert.deepEqual(
    locations(account.orderedGroups[0][1].map(item => item.folderMessage)),
    locations([messages.A, messages.B, messages.C, messages.D, messages.E])
  );
  Assert.equal(
    facetDocument.querySelector('facet-discrete[name="account"]'),
    null,
    "A single account has an exact five-message group and no redundant control"
  );
  const date = facetDocument.getElementById("facet-date").faceter;
  Assert.equal(date.validItems.length, 5);
  Assert.equal(date.missing, 0);
  Assert.equal(date.unreasonable, 0);
  Assert.equal(date.years[120]._dateCount, 5);
  Assert.deepEqual(
    [
      date.years[120][0]._dateCount,
      date.years[120][1]._dateCount,
      date.years[120][2]._dateCount,
    ],
    [2, 1, 2]
  );
  await toggleBoolean("fromMe", ["A"]);
  await toggleBoolean("fromMe", ["A", "B", "C", "D", "E"]);
  await toggleBoolean("toMe", ["C", "E"]);
  await toggleBoolean("toMe", ["A", "B", "C", "D", "E"]);
  await toggleBoolean("attachmentTypes", ["A", "C"]);
  await toggleBoolean("attachmentTypes", ["A", "B", "C", "D", "E"]);
  await toggleBoolean("attachmentTypes", ["A", "C"]);
  const attachment = facetDocument.getElementById("facet-attachmentTypes");
  const filter = attachment.querySelector(".facet-filter-list");
  Assert.equal(
    filter.options.length,
    2,
    "All plus the real text attachment category"
  );
  Assert.equal(filter.value, "all");
  const refined = BrowserTestUtils.waitForMutationCondition(
    facetDocument.getElementById("results"),
    { childList: true, subtree: true },
    () => filter.value != "all"
  );
  filter.focus();
  EventUtils.synthesizeKey("KEY_End", {}, facetWindow);
  await refined;
  Assert.equal(
    attachment.selectedValue,
    "other",
    "Plain text uses the legacy other category"
  );
  Assert.deepEqual(
    attachment.faceter.constraint.includedGroupValues.map(
      value => value.category
    ),
    ["other"]
  );
  assertResults(["A", "C"]);
  await toggleBoolean("attachmentTypes", ["A", "B", "C", "D", "E"]);
  Assert.equal(attachment.faceter.constraint, null);
  Assert.ok(
    !Object.hasOwn(
      facetWindow.FacetContext._activeConstraints,
      "attachmentTypes"
    )
  );
  Assert.equal(attachment.selectedValue, "all");
  Assert.equal(filter.value, "all");
  tabmail.closeTab(tabmail.currentTabInfo);
});

add_task(async function test_multipleIncludesDateAndRelaxation() {
  await openSearch();
  await chooseFacet("tag", redLabel, "top", ["A", "C", "E"]);
  await chooseFacet("tag", greenLabel, "top", ["A", "C", "D", "E"]);
  await chooseFacet("tag", blueLabel, "bottom", ["A", "D", "E"]);
  assertBooleanCount("star", 1);
  assertBooleanCount("attachmentTypes", 1);
  await showTimeline();
  await chooseMonth(2, ["D", "E"]);
  assertBooleanCount("star", 0);
  assertBooleanCount("attachmentTypes", 0);
  const zoom = facetDocument.querySelector(".facet-date-zoom-out");
  zoom.scrollIntoView({ block: "center" });
  const restored = waitForResults(["A", "D", "E"]);
  EventUtils.synthesizeMouseAtCenter(zoom, {}, facetWindow);
  await restored;
  assertResults(["A", "D", "E"]);
  Assert.equal(
    facetDocument.getElementById("facet-date").getAttribute("zoomedout"),
    "true"
  );
  await chooseFacet("tag", greenLabel, "undo", ["A", "E"]);
  await chooseFacet("tag", blueLabel, "undo", ["A", "C", "E"]);
  await chooseFacet("tag", redLabel, "undo", ["A", "B", "C", "D", "E"]);
  Assert.equal(
    Object.keys(facetWindow.FacetContext._activeConstraints).length,
    0,
    "Relaxing all controls clears every constraint"
  );
  tabmail.closeTab(tabmail.currentTabInfo);
});

add_task(async function test_dateOrderTimelineAndEmptyResults() {
  await openSearch();
  const sort = facetDocument.getElementById("sortby");
  sort.focus();
  EventUtils.synthesizeKey("KEY_End", {}, facetWindow);
  await BrowserTestUtils.waitForMutationCondition(
    facetDocument.getElementById("results"),
    { childList: true, subtree: true },
    () =>
      renderedHeaders()[0]?.messageKey == messages.E.messageKey &&
      renderedHeaders()[0]?.folder.URI == messages.E.folder.URI
  );
  Assert.equal(sort.value, "-date");
  Assert.deepEqual(
    renderedHeaders().map(header => [header.folder.URI, header.messageKey]),
    ["E", "D", "C", "B", "A"].map(name => [
      messages[name].folder.URI,
      messages[name].messageKey,
    ])
  );
  await showTimeline();
  await chooseMonth(0, ["A", "B"]);
  const list = await exportActiveSet(["A", "B"]);
  tabmail.closeTab(list);
  assertResults(["A", "B"]);
  Assert.equal(facetDocument.getElementById("sortby").value, "-date");
  tabmail.closeTab(tabmail.currentTabInfo);
  await openSearch("facetunmatchedneedle", []);
  Assert.ok(
    BrowserTestUtils.isVisible(facetDocument.getElementById("showEmpty"))
  );
  Assert.ok(
    BrowserTestUtils.isHidden(facetDocument.getElementById("showMore"))
  );
  Assert.ok(
    BrowserTestUtils.isHidden(facetDocument.getElementById("gloda-showall"))
  );
  tabmail.closeTab(tabmail.currentTabInfo);
});

add_task(async function test_moreResultsAndFilteredList() {
  // Tags affect relevance. Select the supported date-order preference before
  // opening this tab, so paging has a fixed independent order on both hosts.
  await SpecialPowers.pushPrefEnv({ set: [["gloda.facetview.sortby", 1]] });
  try {
    const ordered = pagingNames.toReversed();
    await openSearch(pagingTerm, ordered.slice(0, 10));
    Assert.equal(facetWindow.FacetContext.activeSet.length, 12);
    const more = facetDocument.getElementById("showMore");
    Assert.ok(more && BrowserTestUtils.isVisible(more));
    more.scrollIntoView({ block: "center" });
    const updated = waitForResults(ordered);
    EventUtils.synthesizeMouseAtCenter(more, {}, facetWindow);
    await updated;
    assertResults(ordered);
    Assert.ok(
      BrowserTestUtils.isHidden(facetDocument.getElementById("showMore"))
    );
    await chooseFacet("tag", redLabel, "top", [
      "P0",
      "P2",
      "P4",
      "P6",
      "P8",
      "P10",
    ]);
    const list = await exportActiveSet(["P0", "P2", "P4", "P6", "P8", "P10"]);
    tabmail.closeTab(list);
    assertResults(["P0", "P2", "P4", "P6", "P8", "P10"]);
    await chooseFacet("tag", redLabel, "undo", ordered);
    tabmail.closeTab(tabmail.currentTabInfo);
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_duplicatePhysicalCopiesAndOpening() {
  await openSearch(duplicateTerm, null);
  const items = facetWindow.FacetContext.collection.items;
  Assert.deepEqual(
    locations(renderedHeaders()),
    locations([items[0].folderMessage]),
    "An ordinary search presents its first retrieved Message-ID copy"
  );
  Assert.equal(
    items.length,
    2,
    "The real store query retains both physical copies"
  );
  Assert.deepEqual(
    locations(items.map(item => item.folderMessage)),
    locations([messages.copy0, messages.copy1])
  );
  Assert.equal(messages.copy0.messageId, messages.copy1.messageId);
  Assert.notEqual(messages.copy0.folder.URI, messages.copy1.folder.URI);
  tabmail.closeTab(tabmail.currentTabInfo);
  const byId = items.toSorted((a, b) => a.id - b.id);
  for (const descending of [true, false]) {
    const expected = byId[descending ? 1 : 0].folderMessage;
    const name =
      expected.folder.URI == messages.copy0.folder.URI ? "copy0" : "copy1";
    const query = Gloda.newQuery(GlodaConstants.NOUN_MESSAGE);
    query.id(...items.map(item => item.id));
    query.orderBy(descending ? "-id" : "id");
    const tab = tabmail.openTab("glodaFacet", { query });
    tabs.push(tab);
    await TestUtils.waitForCondition(
      () => tab.browser?.contentWindow.FacetContext?.everFaceted
    );
    facetWindow = tab.browser.contentWindow;
    facetDocument = facetWindow.document;
    await waitForResults([name]);
    assertResults([name]);
    Assert.equal(
      facetWindow.FacetContext.activeSet.length,
      1,
      "The first encountered Message-ID copy is the displayed representative"
    );
    const opened = BrowserTestUtils.waitForEvent(
      tabmail.tabContainer,
      "TabOpen"
    );
    const subject = facetDocument.querySelector(
      "facet-result-message .message-subject"
    );
    subject.scrollIntoView({ block: "center" });
    EventUtils.synthesizeMouseAtCenter(subject, {}, facetWindow);
    const {
      detail: { tabInfo },
    } = await opened;
    tabs.push(tabInfo);
    await TestUtils.waitForCondition(() => {
      const view = tabInfo.chromeBrowser?.contentWindow.gDBView;
      return view?.selection.currentIndex >= 0;
    });
    const view = tabInfo.chromeBrowser.contentWindow.gDBView;
    Assert.deepEqual(
      locations([view.getMsgHdrAt(view.selection.currentIndex)]),
      locations([messages[name]]),
      "The clicked card opens the chosen physical representative"
    );
    tabmail.closeTab(tabInfo);
    tabmail.closeTab(tab);
  }
});
