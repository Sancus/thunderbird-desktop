/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Test functionality in the message header.
 */

"use strict";

const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);
const MESSENGER_WINDOW = "chrome://messenger/content/messenger.xhtml";

const tabmail = document.getElementById("tabmail");
const about3Pane = tabmail.currentAbout3Pane;
const { multiMessageBrowser, threadPane, threadTree } = about3Pane;
let rootFolder, testFolder, testMessages;

const customizeData = {
  showAvatar: true,
  showBigAvatar: false,
  showFullAddress: true,
  hideLabels: true,
  subjectLarge: true,
  buttonStyle: "default",
};

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["ui.prefersReducedMotion", 1]],
  });
  const generator = new MessageGenerator();

  const account = MailServices.accounts.createLocalMailAccount();
  account.addIdentity(MailServices.accounts.createIdentity());
  rootFolder = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );

  testFolder = rootFolder
    .createLocalSubfolder("threads")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);

  testFolder.addMessageBatch(
    generator
      .makeMessages({ count: 20, msgsPerThread: 5 })
      .map(message => message.toMessageString())
  );
  testMessages = [...testFolder.messages];

  about3Pane.displayFolder(testFolder.URI);
  goDoCommand("cmd_collapseAllThreads");

  await new Promise(about3Pane.requestAnimationFrame);

  registerCleanupFunction(async () => {
    MailServices.accounts.removeAccount(account, false);
    Services.xulStore.removeDocument(MESSENGER_WINDOW);
  });
});

add_task(async function testButtonsStyle() {
  info("Test that the header button styles follow the user's customization.");

  about3Pane.threadTree.selectedIndex = 0;
  const row = threadTree.getRowAtIndex(0);
  Assert.ok(
    row.classList.contains("collapsed"),
    "The thread row should be collapsed"
  );
  Assert.ok(
    BrowserTestUtils.isVisible(multiMessageBrowser),
    "The multi message browser should be visible"
  );
  const headerBar =
    multiMessageBrowser.contentDocument.getElementById("headingWrapper");

  info("Check that icons + text is the current configuration.");
  Assert.ok(
    !headerBar.classList.contains("message-header-buttons-only-icons"),
    "The multi message header buttons aren't showing only icons"
  );
  Assert.ok(
    !headerBar.classList.contains("message-header-buttons-only-text"),
    "The multi message header buttons aren't showing only text"
  );

  info("Switch to only icons visible");

  customizeData.buttonStyle = "only-icons";
  Services.xulStore.setValue(
    MESSENGER_WINDOW,
    "messageHeader",
    "layout",
    JSON.stringify(customizeData)
  );
  // The multiMessageBrowser doesn't hot reload based on XUL store changes
  // because the user can't change those settings without accessing a single
  // message, so select another message to see the changes reflected.
  about3Pane.threadTree.selectedIndex = 1;
  await new Promise(about3Pane.requestAnimationFrame);
  Assert.ok(
    headerBar.classList.contains("message-header-buttons-only-icons"),
    "The multi message header buttons are showing only icons"
  );

  info("Switch to only text visible");

  customizeData.buttonStyle = "only-text";
  Services.xulStore.setValue(
    MESSENGER_WINDOW,
    "messageHeader",
    "layout",
    JSON.stringify(customizeData)
  );
  about3Pane.threadTree.selectedIndex = 2;
  await new Promise(about3Pane.requestAnimationFrame);
  Assert.ok(
    headerBar.classList.contains("message-header-buttons-only-text"),
    "The multi message header buttons are showing only text"
  );

  info("Switch back to default style");

  customizeData.buttonStyle = "default";
  Services.xulStore.setValue(
    MESSENGER_WINDOW,
    "messageHeader",
    "layout",
    JSON.stringify(customizeData)
  );
  about3Pane.threadTree.selectedIndex = 0;
  await new Promise(about3Pane.requestAnimationFrame);

  Assert.ok(
    !headerBar.classList.contains("message-header-buttons-only-icons"),
    "The multi message header buttons aren't showing only icons"
  );
  Assert.ok(
    !headerBar.classList.contains("message-header-buttons-only-text"),
    "The multi message header buttons aren't showing only text"
  );
});

add_task(async function testStarredButtonReactivity() {
  info("Mark thread flagged and see if the icon turns on.");

  let row = threadTree.getRowAtIndex(1);
  EventUtils.synthesizeMouseAtCenter(
    row.querySelector(".button-star"),
    {},
    about3Pane
  );
  about3Pane.threadTree.selectedIndex = 1;
  await new Promise(about3Pane.requestAnimationFrame);
  const starButton =
    multiMessageBrowser.contentDocument.getElementById("starMessageButton");
  Assert.equal(
    starButton.getAttribute("aria-pressed"),
    "true",
    "The multi message header Star button should expose pressed state when flagged."
  );
  Assert.ok(
    !starButton.hasAttribute("aria-checked"),
    "The multi message header Star button should not expose checkbox state."
  );
  Assert.ok(
    starButton.classList.contains("flagged"),
    "The thread is flagged so the multi message header Star button should be flagged."
  );
  about3Pane.threadTree.selectedIndex = 0;

  info("Mark thread unflagged and see if the icon turns off.");

  EventUtils.synthesizeMouseAtCenter(
    row.querySelector(".button-star"),
    {},
    about3Pane
  );
  about3Pane.threadTree.selectedIndex = 1;
  await new Promise(about3Pane.requestAnimationFrame);
  Assert.equal(
    starButton.getAttribute("aria-pressed"),
    "false",
    "The multi message header Star button should expose unpressed state when unflagged."
  );
  Assert.ok(
    !starButton.classList.contains("flagged"),
    "The thread is unflagged so the multi message header Star button should not be flagged."
  );

  info("Open thread and mark single message flagged, the icon should be off");

  goDoCommand("cmd_expandAllThreads");
  await new Promise(about3Pane.requestAnimationFrame);

  row = threadTree.getRowAtIndex(0);
  EventUtils.synthesizeMouseAtCenter(
    row.querySelector(".button-star"),
    {},
    about3Pane
  );

  goDoCommand("cmd_collapseAllThreads");
  await new Promise(about3Pane.requestAnimationFrame);
  about3Pane.threadTree.selectedIndex = 0;

  Assert.ok(
    !starButton.classList.contains("flagged"),
    "Only the first message of the thread is flagged so the multi message header Star button should not be flagged."
  );

  info("Test that clicking on the star button in the multi message view works");

  about3Pane.threadTree.selectedIndex = 1;
  EventUtils.synthesizeMouseAtCenter(
    starButton,
    {},
    multiMessageBrowser.contentWindow
  );
  await new Promise(about3Pane.requestAnimationFrame);
  row = threadTree.getRowAtIndex(1);
  Assert.ok(
    row.dataset.properties.includes("flagged"),
    "The thread should have been starred."
  );

  EventUtils.synthesizeMouseAtCenter(
    starButton,
    {},
    multiMessageBrowser.contentWindow
  );
  await new Promise(about3Pane.requestAnimationFrame);
  row = threadTree.getRowAtIndex(1);
  Assert.ok(
    !row.dataset.properties.includes("flagged"),
    "The thread should not be starred."
  );
});

let summaryFixtureCount = 0;

/**
 * Create real cross-folder search members, including two copies of one message.
 *
 * @returns {object} Physical folders, headers and the existing search view.
 */
function createSummaryFixture() {
  const suffix = ++summaryFixtureCount;
  const folders = ["first", "second", "outside"].map(name =>
    rootFolder
      .createLocalSubfolder(`summary-${suffix}-${name}`)
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
  );
  const [first, second, outside] = folders;
  const generator = new MessageGenerator();
  const root = generator.makeMessage({
    subject: "Retained summary thread",
    body: { body: "The retained summary body.\n\n> Quoted reply text." },
  });
  root.messageId = `summary-root-${suffix}@example.invalid`;
  const reply = generator.makeMessage({ inReplyTo: root });
  reply.messageId = `summary-reply-${suffix}@example.invalid`;
  const other = generator.makeMessage({ subject: "Other summary thread" });
  other.messageId = `summary-other-${suffix}@example.invalid`;
  const a = first.addMessage(root.toMessageString());
  const b = first.addMessage(reply.toMessageString());
  const c = second.addMessage(root.toMessageString());
  const d = second.addMessage(other.toMessageString());
  const excluded = outside.addMessage(root.toMessageString());
  const messages = [a, c, b, d];
  const view = Cc[
    "@mozilla.org/messenger/msgdbview;1?type=search"
  ].createInstance(Ci.nsIMsgDBView);
  view.init(null, null);
  view.open(
    null,
    Ci.nsMsgViewSortType.byDate,
    Ci.nsMsgViewSortOrder.ascending,
    Ci.nsMsgViewFlagsType.kThreadedDisplay
  );
  const notify = view.QueryInterface(Ci.nsIMsgSearchNotify);
  notify.onNewSearch();
  for (const message of messages) {
    notify.onSearchHit(message, message.folder);
  }
  notify.onSearchDone(Cr.NS_OK);
  return {
    first,
    second,
    outside,
    messages,
    excluded,
    a,
    b,
    c,
    d,
    view,
    close() {
      multiMessageBrowser.contentWindow.gMessageSummary.clear();
      view.close();
      for (const folder of folders) {
        folder.deleteSelf(null);
      }
    },
  };
}

/**
 * @param {nsIMsgDBHdr} header - A stored physical message.
 * @returns {[string, number, string]} Folder URI, key and logical Message-ID.
 */
function physicalSummaryIdentity(header) {
  return [header.folder.URI, header.messageKey, header.messageId];
}

add_task(async function test_liveMetadataKeepsUnchangedMembers() {
  await SpecialPowers.pushPrefEnv({
    set: [["mailnews.database.global.indexer.enabled", false]],
  });
  const fixture = createSummaryFixture();
  const { first, second, outside, messages, excluded, view } = fixture;
  const { a, b, c, d } = fixture;
  const win = multiMessageBrowser.contentWindow;
  const summary = win.gMessageSummary;
  const doc = win.document;
  const tagA = "summary-tag-a";
  const tagB = "summary-tag-b";
  MailServices.tags.addTagForKey(tagA, "Summary A", "#ff0000", "");
  MailServices.tags.addTagForKey(tagB, "Summary B", "#0000ff", "");
  try {
    Assert.equal(
      view.getThreadContainingMsgHdr(a).threadKey,
      view.getThreadContainingMsgHdr(b).threadKey
    );
    Assert.equal(
      view.getThreadContainingMsgHdr(a).threadKey,
      view.getThreadContainingMsgHdr(c).threadKey
    );
    Assert.notEqual(
      view.getThreadContainingMsgHdr(a).threadKey,
      view.getThreadContainingMsgHdr(d).threadKey
    );
    first.markMessagesRead([a, b], true);
    second.markMessagesRead([c, d], true);
    first.markMessagesRead([b], false);
    first.markMessagesFlagged([a], true);
    first.addKeywordsToMessages([a, b], tagA);
    // Metadata updates must also work for messages excluded from global search.
    a.setStringProperty("junkscore", "100");
    let selected;
    summary.summarize(
      "multipleselection",
      messages,
      view,
      headers => (selected = headers)
    );
    const rows = [...doc.querySelectorAll("#messageList > li")];
    Assert.equal(
      rows.length,
      2,
      "Existing UI groups all selected physical copies"
    );
    const row = rows.find(node => node.dataset.messageId == a.messageId);
    const otherRow = rows.find(node => node != row);
    const tags = () =>
      [...row.querySelectorAll(".tag")].map(node => node.textContent);
    Assert.ok(row.classList.contains("unread"));
    Assert.ok(row.classList.contains("starred"));
    Assert.deepEqual(tags(), ["Summary A"], "A shared tag appears once");
    const snippets = [...doc.querySelectorAll(".snippet")];
    await TestUtils.waitForCondition(
      () => snippets.every(node => node.textContent),
      "Both existing MIME snippets load without a global search subscription"
    );
    const oldSnippet = row.querySelector(".snippet").textContent;
    Assert.equal(oldSnippet, "The retained summary body.");
    const oldOtherRow = otherRow.outerHTML;
    const starButton = doc.getElementById("starMessageButton");
    Assert.equal(starButton.getAttribute("aria-pressed"), "false");

    first.markMessagesRead([a], false);
    first.removeKeywordsFromMessages([a], tagA);
    second.addKeywordsToMessages([c], tagB);
    await TestUtils.waitForCondition(
      () => tags().includes("Summary B"),
      "The existing folder keywords callback updates the summary"
    );
    Assert.deepEqual(
      tags(),
      ["Summary A", "Summary B"],
      "The unchanged reply retains its tag"
    );
    first.markMessagesRead([a], true);
    await new Promise(resolve => win.queueMicrotask(resolve));
    Assert.ok(
      row.classList.contains("unread"),
      "The unchanged reply stays unread"
    );
    first.markMessagesFlagged([b], true);
    first.markMessagesFlagged([a], false);
    await new Promise(resolve => win.queueMicrotask(resolve));
    Assert.ok(
      row.classList.contains("starred"),
      "The other member stays flagged"
    );
    Assert.equal(
      starButton.getAttribute("aria-pressed"),
      "false",
      "A flagged group does not mean all selected messages are flagged"
    );
    first.markMessagesRead([b], true);
    await new Promise(resolve => win.queueMicrotask(resolve));
    Assert.ok(!row.classList.contains("unread"));
    Assert.strictEqual(doc.querySelector("#messageList > li"), rows[0]);
    Assert.equal(row.querySelector(".snippet").textContent, oldSnippet);
    Assert.equal(
      otherRow.outerHTML,
      oldOtherRow,
      "The unrelated summary stays intact"
    );

    first.markMessagesFlagged([a, b], true);
    second.markMessagesFlagged([c, d], true);
    await new Promise(resolve => win.queueMicrotask(resolve));
    Assert.equal(
      starButton.getAttribute("aria-pressed"),
      "true",
      "All selected physical messages are flagged"
    );
    second.markMessagesFlagged([c], false);
    outside.markMessagesRead([excluded], true);
    outside.markMessagesRead([excluded], false);
    outside.markMessagesFlagged([excluded], true);
    outside.addKeywordsToMessages([excluded], tagB);
    await new Promise(resolve => win.queueMicrotask(resolve));
    Assert.deepEqual(tags(), ["Summary A", "Summary B"]);
    Assert.ok(
      !row.classList.contains("unread"),
      "The excluded equal-Message-ID copy cannot change the selected row"
    );
    Assert.equal(
      starButton.getAttribute("aria-pressed"),
      "false",
      "The excluded flagged copy cannot replace an unflagged selected copy"
    );
    row.querySelector(".subject").click();
    Assert.deepEqual(
      selected.map(physicalSummaryIdentity),
      [a, c, b].map(physicalSummaryIdentity),
      "The row selects both physical copies and the reply, never the excluded copy"
    );
    const removedKey = c.messageKey;
    const survivingIdentities = [a, b].map(physicalSummaryIdentity);
    const removed = new PromiseTestUtils.PromiseCopyListener();
    second.deleteMessages([c], null, true, false, removed, false);
    await removed.promise;
    await new Promise(resolve => win.queueMicrotask(resolve));
    Assert.ok(!second.msgDatabase.containsKey(removedKey));
    Assert.ok(outside.msgDatabase.containsKey(excluded.messageKey));
    Assert.strictEqual(
      win.document.querySelector("#messageList > li"),
      rows[0]
    );
    row.querySelector(".subject").click();
    Assert.deepEqual(
      selected.map(physicalSummaryIdentity),
      survivingIdentities,
      "Deleting one copy leaves the original surviving physical members in order"
    );
    Assert.equal(
      starButton.getAttribute("aria-pressed"),
      "true",
      "Only surviving selected messages contribute to the toolbar aggregate"
    );
  } finally {
    fixture.close();
    MailServices.tags.deleteKey(tagA);
    MailServices.tags.deleteKey(tagB);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_clearAndCloseSettleSubscriptions() {
  const fixture = createSummaryFixture();
  const { first, messages, view } = fixture;
  const win = multiMessageBrowser.contentWindow;
  const summary = win.gMessageSummary;
  try {
    let oldStarted = 0;
    let oldCompleted = 0;
    let completed = 0;
    summary.summarize("thread", messages, view, () => {}, {
      onLoadStarted() {
        oldStarted++;
      },
      onLoadCompleted() {
        oldCompleted++;
      },
    });
    const oldRow = win.document.querySelector("#messageList > li");
    const oldState = summary._folderStates.get(first.URI);
    first.markMessagesRead([messages[0]], !messages[0].isRead);
    summary.summarize("thread", messages, view, () => {}, {
      onLoadStarted() {},
      onLoadCompleted() {
        completed++;
      },
    });
    await new Promise(resolve => win.queueMicrotask(resolve));
    Assert.equal(oldStarted, 1);
    Assert.equal(
      oldCompleted,
      0,
      "The superseded load never completes the next summary"
    );
    Assert.equal(completed, 1, "The current load completes once");
    Assert.equal(oldState.database, null, "Clear releases the old database");
    Assert.equal(oldState.listener, null, "Clear releases the old listener");
    Assert.ok(!oldRow.isConnected);
    const state = summary._folderStates.get(first.URI);
    state.database.forceClosed();
    Assert.equal(
      state.database,
      null,
      "The announcer closing releases its database"
    );
    Assert.equal(state.listener, null);
    const currentRows = [...win.document.querySelectorAll("#messageList > li")];
    summary.clear();
    first.markMessagesRead(
      [first.msgDatabase.getMsgHdrForKey(messages[0].messageKey)],
      true
    );
    await new Promise(resolve => win.queueMicrotask(resolve));
    Assert.equal(summary._folderStates.size, 0);
    Assert.equal(win.document.querySelectorAll("#messageList > li").length, 0);
    Assert.ok(currentRows.every(node => !node.isConnected));
    Assert.equal(completed, 1);
  } finally {
    fixture.close();
  }
});

add_task(async function test_supersededMimeCallbackDoesNotUpdateRows() {
  const fixture = createSummaryFixture();
  const { messages, view } = fixture;
  const win = multiMessageBrowser.contentWindow;
  const summary = win.gMessageSummary;
  const original = win.MsgHdrToMimeMessage;
  const callbacks = [];
  try {
    win.MsgHdrToMimeMessage = (header, context, callback, ...args) =>
      original(
        header,
        context,
        (...values) => callbacks.push(() => callback(...values)),
        ...args
      );
    summary.summarize("thread", [messages[0]], view, () => {});
    const oldSnippet = win.document.querySelector(".snippet");
    await TestUtils.waitForCondition(
      () => callbacks.length == 1,
      "Capture the real completed MIME stream callback"
    );
    summary.clear();
    callbacks.shift()();
    Assert.equal(
      oldSnippet.textContent,
      "",
      "A late stream cannot write a cleared summary"
    );
    win.MsgHdrToMimeMessage = original;
    summary.summarize("thread", [fixture.c], view, () => {});
    const snippet = win.document.querySelector(".snippet");
    await TestUtils.waitForCondition(
      () => snippet.textContent,
      "The replacement physical copy loads its own real MIME snippet"
    );
    Assert.equal(snippet.textContent, "The retained summary body.");

    win.MsgHdrToMimeMessage = () => {
      throw Components.Exception("Offline", Cr.NS_ERROR_FAILURE);
    };
    summary.summarize("thread", [messages[0]], view, () => {});
    Assert.equal(
      win.document.querySelector(".snippet").textContent,
      "...",
      "The existing offline fallback remains visible"
    );
    const error = new Error("summary MIME failure");
    win.MsgHdrToMimeMessage = () => {
      throw error;
    };
    Assert.throws(
      () => summary.summarize("thread", [messages[0]], view, () => {}),
      value => value === error,
      "Unexpected MIME errors retain the original error"
    );
  } finally {
    win.MsgHdrToMimeMessage = original;
    fixture.close();
  }
});
