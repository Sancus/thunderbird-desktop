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

/**
 * Open a real folder tab and hold only its completed prior-selection MIME calls.
 *
 * @returns {Promise<object>} Stored headers, live pane, pending calls and cleanup.
 */
async function createLiveSnippetFixture() {
  const suffix = ++summaryFixtureCount;
  const folders = ["prior", "current", "outside"].map(name =>
    rootFolder
      .createLocalSubfolder(`snippet-${suffix}-${name}`)
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
  );
  const [prior, current, outside] = folders;
  const generator = new MessageGenerator();
  const sharedId = `snippet-shared-${suffix}@example.invalid`;
  const aRoot = generator.makeMessage({
    subject: "Prior physical selection",
    body: { body: "Prior physical A snippet." },
  });
  aRoot.messageId = sharedId;
  const aReply = generator.makeMessage({
    inReplyTo: aRoot,
    body: { body: "Prior A reply snippet." },
  });
  aReply.messageId = `snippet-prior-reply-${suffix}@example.invalid`;
  const bRoot = generator.makeMessage({
    subject: "Current physical selection",
    body: { body: "Current physical B snippet." },
  });
  bRoot.messageId = sharedId;
  const bReply = generator.makeMessage({
    subject: "Additional current physical selection",
    body: { body: "Current B additional snippet." },
  });
  bReply.messageId = `snippet-current-reply-${suffix}@example.invalid`;
  const control = generator.makeMessage({
    subject: "Independent control selection",
    body: { body: "Independent control snippet." },
  });
  control.messageId = `snippet-control-${suffix}@example.invalid`;
  const priorHeaders = [aRoot, aReply].map(message =>
    prior.addMessage(message.toMessageString())
  );
  const currentHeaders = [bRoot, bReply, control].map(message =>
    current.addMessage(message.toMessageString())
  );
  const excluded = outside.addMessage(bRoot.toMessageString());
  const originalTab = tabmail.currentTabInfo;
  const originalList =
    multiMessageBrowser.contentDocument.getElementById("messageList").outerHTML;
  const tab = tabmail.openTab("mail3PaneTab", { folderURI: prior.URI });
  let win = null;
  let originalMime = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    if (win && !win.closed && originalMime) {
      win.MsgHdrToMimeMessage = originalMime;
    }
    if (tabmail.tabInfo.includes(tab)) {
      tabmail.closeTab(tab);
    }
    for (const folder of folders) {
      if (rootFolder.containsChildNamed(folder.name)) {
        folder.deleteSelf(null);
      }
    }
  };
  registerCleanupFunction(cleanup);
  await BrowserTestUtils.browserLoaded(tab.chromeBrowser);
  const pane = tab.chromeBrowser.contentWindow;
  await pane.hasDOMContentLoaded.promise;
  await TestUtils.waitForCondition(
    () =>
      pane.gDBView?.rowCount && pane.dbViewWrapperListener.allMessagesLoaded,
    "The real prior folder view has loaded"
  );
  pane.gViewWrapper.showThreaded = false;
  pane.threadTree.selectedIndices = [];
  await TestUtils.waitForCondition(
    () => pane.multiMessageBrowser.contentWindow.gMessageSummary,
    "The real summary document is ready"
  );
  win = pane.multiMessageBrowser.contentWindow;
  originalMime = win.MsgHdrToMimeMessage;
  const pending = [];
  win.MsgHdrToMimeMessage = (header, context, callback, ...args) =>
    originalMime(
      header,
      context,
      function (...values) {
        if (header.folder.URI != prior.URI) {
          callback.apply(this, values);
          return;
        }
        Assert.deepEqual(
          physicalSummaryIdentity(values[0]),
          physicalSummaryIdentity(header),
          "The completed real stream belongs to the requested physical header"
        );
        Assert.ok(values[1], "The real MIME stream supplied a message tree");
        pending.push(() => callback.apply(this, values));
      },
      ...args
    );
  const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  const factory = Cc["@mozilla.org/msgDatabase/msgDBService;1"];
  if (native) {
    Assert.ok(factory.getService(Ci.nsIDatabaseCore));
  }
  info(`Snippet099 actual startup native=${native}`);
  const loaded = BrowserTestUtils.waitForEvent(pane, "MsgsLoaded");
  pane.threadTree.focus();
  EventUtils.synthesizeKey("a", { accelKey: true }, pane);
  await loaded;
  Assert.ok(BrowserTestUtils.isVisible(pane.multiMessageBrowser));
  Assert.deepEqual(
    pane.gDBView.getSelectedMsgHdrs().map(physicalSummaryIdentity),
    priorHeaders.map(physicalSummaryIdentity),
    "The real summary selection contains exactly both stored prior headers"
  );
  await TestUtils.waitForCondition(
    () => pending.length == 2,
    "Both real prior MIME completions are held at the consumer boundary"
  );
  const oldSnippets = [...win.document.querySelectorAll(".snippet")];
  Assert.equal(oldSnippets.length, 2);
  Assert.deepEqual(
    oldSnippets.map(node => node.textContent),
    ["", ""]
  );
  return {
    prior,
    current,
    outside,
    priorHeaders,
    currentHeaders,
    excluded,
    originalTab,
    originalList,
    tab,
    pane,
    win,
    pending,
    oldSnippets,
    cleanup,
  };
}

add_task(async function test_selectionChangeRejectsLateMimeSnippet() {
  const fixture = await createLiveSnippetFixture();
  const { pane, win, current, currentHeaders, priorHeaders } = fixture;
  try {
    pane.displayFolder(current.URI);
    await TestUtils.waitForCondition(
      () =>
        pane.gDBView?.rowCount &&
        pane.gDBView.getMsgHdrAt(0).folder.URI == current.URI &&
        pane.dbViewWrapperListener.allMessagesLoaded,
      "The actual folder switch has installed the current physical rows"
    );
    pane.gViewWrapper.showThreaded = false;
    const loaded = BrowserTestUtils.waitForEvent(pane, "MsgsLoaded");
    pane.threadTree.focus();
    EventUtils.synthesizeKey("a", { accelKey: true }, pane);
    await loaded;
    const selected = currentHeaders.map(physicalSummaryIdentity);
    Assert.deepEqual(
      pane.gDBView.getSelectedMsgHdrs().map(physicalSummaryIdentity),
      selected
    );
    Assert.equal(priorHeaders[0].messageId, currentHeaders[0].messageId);
    Assert.notEqual(priorHeaders[0].folder.URI, currentHeaders[0].folder.URI);
    const list = win.document.getElementById("messageList");
    try {
      await BrowserTestUtils.waitForMutationCondition(
        list,
        { subtree: true, childList: true, characterData: true },
        () =>
          list.children.length == 3 &&
          [...list.querySelectorAll(".snippet")].every(node => node.textContent)
      );
    } catch (error) {
      info(
        "Snippet099 current summary " +
          JSON.stringify({
            rows: [...list.children].map(node => ({
              id: node.dataset.messageId,
              snippet: node.querySelector(".snippet").textContent,
            })),
            threads: currentHeaders.map(header => {
              const thread = pane.gDBView.getThreadContainingMsgHdr(header);
              return {
                physical: physicalSummaryIdentity(header),
                threadKey: thread.threadKey,
                root: physicalSummaryIdentity(thread.getRootHdr()),
              };
            }),
          })
      );
      throw error;
    }
    const rows = [...list.children];
    const row = rows.find(
      node => node.dataset.messageId == currentHeaders[0].messageId
    );
    const control = rows.find(
      node => node.dataset.messageId == currentHeaders[2].messageId
    );
    Assert.ok(row, "The current physical thread has a real summary row");
    Assert.ok(control, "The unrelated control has its own summary row");
    const additional = rows.find(
      node => node.dataset.messageId == currentHeaders[1].messageId
    );
    Assert.ok(additional, "The additional current header has its own row");
    Assert.equal(
      additional.querySelector(".snippet").textContent,
      "Current B additional snippet."
    );
    Assert.deepEqual(
      rows.map(node => node.dataset.messageId),
      currentHeaders.map(header => header.messageId),
      "Exactly all three independently selected current rows are displayed"
    );
    Assert.equal(
      row.querySelector(".snippet").textContent,
      "Current physical B snippet."
    );
    Assert.equal(
      control.querySelector(".snippet").textContent,
      "Independent control snippet."
    );
    const html = rows.map(node => node.outerHTML);
    for (const callback of fixture.pending.splice(0)) {
      callback();
    }
    Assert.deepEqual(
      fixture.oldSnippets.map(node => node.textContent),
      ["", ""],
      "The superseded real MIME callbacks cannot publish to their old rows"
    );
    Assert.ok(fixture.oldSnippets.every(node => !node.isConnected));
    Assert.deepEqual(
      [...list.children],
      rows,
      "Current summary rows are retained"
    );
    Assert.deepEqual(
      rows.map(node => node.outerHTML),
      html,
      "Current B and the unrelated control are unchanged after actual A callbacks"
    );
    Assert.deepEqual(
      pane.gDBView.getSelectedMsgHdrs().map(physicalSummaryIdentity),
      selected,
      "Late callbacks preserve the exact selected physical headers"
    );
    Assert.ok(
      fixture.outside.msgDatabase.containsKey(fixture.excluded.messageKey),
      "The unselected equal-ID copy remains outside the actual selection"
    );
    info("Snippet099 real selection A-to-B stale callbacks complete");
  } finally {
    fixture.cleanup();
  }
});

add_task(async function test_closedSummaryRejectsLateMimeSnippet() {
  const fixture = await createLiveSnippetFixture();
  const { win, tab } = fixture;
  const summary = win.gMessageSummary;
  try {
    const unloaded = BrowserTestUtils.waitForEvent(win, "unload");
    tabmail.closeTab(tab);
    await unloaded;
    Assert.ok(
      !tabmail.tabInfo.includes(tab),
      "The actual summary tab is closed"
    );
    Assert.equal(
      summary._folderStates.size,
      0,
      "Unload released summary subscriptions"
    );
    for (const callback of fixture.pending.splice(0)) {
      callback();
    }
    Assert.deepEqual(
      fixture.oldSnippets.map(node => node.textContent),
      ["", ""],
      "Real MIME completions cannot publish after the summary consumer closes"
    );
    Assert.ok(fixture.oldSnippets.every(node => !node.isConnected));
    Assert.strictEqual(
      tabmail.currentTabInfo,
      fixture.originalTab,
      "Closing the consumer returns to the original real tab"
    );
    Assert.equal(
      multiMessageBrowser.contentDocument.getElementById("messageList")
        .outerHTML,
      fixture.originalList,
      "The surviving consumer is unchanged by the old callbacks"
    );
    info("Snippet099 real summary-tab close stale callbacks complete");
  } finally {
    fixture.cleanup();
  }
});

/**
 * Create stored summary members and independent location-collision controls.
 *
 * @returns {object} Real folders, headers, summary and task cleanup.
 */
function createSummaryLocationFixture() {
  const fixture = createSummaryFixture();
  const { first, second, outside, a, b, c, d, view } = fixture;
  const names = [first.name, second.name, outside.name];
  const destination = rootFolder
    .createLocalSubfolder(`summary-location-${summaryFixtureCount}`)
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  names.push(destination.name);
  const generator = new MessageGenerator();
  const decoy = generator.makeMessage({
    subject: "Unselected destination copy",
    body: { body: "Destination collision must stay outside the summary." },
  });
  decoy.messageId = a.messageId;
  const collision = destination.addMessage(decoy.toMessageString());
  const tagA = `summary-location-a-${summaryFixtureCount}`;
  const tagB = `summary-location-b-${summaryFixtureCount}`;
  const tagC = `summary-location-c-${summaryFixtureCount}`;
  const listeners = [];
  const win = multiMessageBrowser.contentWindow;
  const summary = win.gMessageSummary;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    for (const listener of listeners) {
      MailServices.mfn.removeListener(listener);
    }
    summary.clear();
    view.close();
    for (const tag of [tagA, tagB, tagC]) {
      MailServices.tags.deleteKey(tag);
    }
    for (const name of names) {
      if (rootFolder.containsChildNamed(name)) {
        rootFolder.getChildNamed(name).deleteSelf(null);
      }
    }
  };
  registerCleanupFunction(cleanup);
  MailServices.tags.addTagForKey(tagA, "Location A", "#ff0000", "");
  MailServices.tags.addTagForKey(tagB, "Location B", "#0000ff", "");
  MailServices.tags.addTagForKey(tagC, "Location C", "#00ff00", "");
  first.markMessagesRead([a, b], true);
  second.markMessagesRead([c, d], true);
  first.markMessagesFlagged([a, b], true);
  second.markMessagesFlagged([c, d], true);
  first.addKeywordsToMessages([a], tagA);
  second.addKeywordsToMessages([c], tagA);
  first.addKeywordsToMessages([b], tagB);
  const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  const factory = Cc["@mozilla.org/msgDatabase/msgDBService;1"];
  if (native) {
    Assert.ok(factory.getService(Ci.nsIDatabaseCore));
  }
  Assert.equal(
    first.server.msgStore.storeType,
    "mbox",
    "The location fixture uses the actual local mbox store"
  );
  info(`Summary100 actual startup native=${native}`);
  return {
    ...fixture,
    // The source header is removed by the real move. Retain its known identity.
    rootMessageId: a.messageId,
    destination,
    collision,
    names,
    listeners,
    win,
    summary,
    tagA,
    tagB,
    tagC,
    cleanup,
  };
}

/**
 * Display known stored members through the ordinary search view and summary.
 *
 * @param {object} fixture - The physical location fixture.
 * @param {nsIMsgDBHdr[]} headers - Independently known current stored headers.
 * @param {Function} onSelect - Receives the real clicked row's physical members.
 * @returns {Promise<HTMLLIElement>} The displayed row for the known root ID.
 */
async function showSummaryLocationMembers(fixture, headers, onSelect) {
  const { view, summary, win, rootMessageId } = fixture;
  const notify = view.QueryInterface(Ci.nsIMsgSearchNotify);
  notify.onNewSearch();
  for (const header of headers) {
    notify.onSearchHit(header, header.folder);
  }
  notify.onSearchDone(Cr.NS_OK);
  summary.summarize("multipleselection", headers, view, onSelect);
  const list = win.document.getElementById("messageList");
  await TestUtils.waitForCondition(
    () =>
      [...list.querySelectorAll(".snippet")].every(node => node.textContent),
    "The real stored MIME summaries have loaded"
  );
  const row = [...list.children].find(
    node => node.dataset.messageId == rootMessageId
  );
  Assert.ok(row, "The known selected root has a summary row");
  Assert.equal(
    row.querySelector(".snippet").textContent,
    "The retained summary body."
  );
  return row;
}

add_task(async function test_summaryMoveKeepsCurrentPhysicalMembers() {
  await SpecialPowers.pushPrefEnv({
    set: [["mailnews.database.global.indexer.enabled", false]],
  });
  const fixture = createSummaryLocationFixture();
  const { first, outside, a, b, c, d, destination, collision, win } = fixture;
  const { tagC } = fixture;
  let selected;
  const row = await showSummaryLocationMembers(
    fixture,
    [a, c, b, d],
    headers => (selected = headers)
  );
  const control = [...win.document.querySelectorAll("#messageList > li")].find(
    node => node.dataset.messageId == d.messageId
  );
  Assert.ok(control);
  const controlHTML = control.outerHTML;
  const oldSource = physicalSummaryIdentity(a);
  let completed;
  const notification = new Promise(resolve => {
    const listener = {
      msgsMoveCopyCompleted(isMove, sources, target, targets) {
        if (target.URI != destination.URI) {
          return;
        }
        completed = {
          isMove,
          source: sources.map(physicalSummaryIdentity),
          destination: targets.map(physicalSummaryIdentity),
          headers: [...targets],
        };
        MailServices.mfn.removeListener(listener);
        resolve();
      },
    };
    fixture.listeners.push(listener);
    MailServices.mfn.addListener(
      listener,
      MailServices.mfn.msgsMoveCopyCompleted
    );
  });
  const copy = new PromiseTestUtils.PromiseCopyListener();
  MailServices.copy.copyMessages(
    first,
    [a],
    destination,
    true,
    copy,
    null,
    false
  );
  await Promise.all([notification, copy.promise]);
  Assert.ok(completed.isMove);
  Assert.deepEqual(
    completed.source,
    [oldSource],
    "Mfn snapshots the actual source before deletion"
  );
  Assert.equal(completed.headers.length, 1);
  const moved = destination.msgDatabase.getMsgHdrForKey(
    completed.headers[0].messageKey
  );
  Assert.deepEqual(completed.destination, [physicalSummaryIdentity(moved)]);
  Assert.equal(moved.messageId, oldSource[2]);
  Assert.equal(moved.folder.URI, destination.URI);
  Assert.ok(
    !first.msgDatabase.containsKey(oldSource[1]),
    "The completed move removed the exact old source pair"
  );
  Assert.ok(first.msgDatabase.containsKey(b.messageKey));
  Assert.ok(destination.msgDatabase.containsKey(collision.messageKey));
  await new Promise(resolve => win.queueMicrotask(resolve));
  EventUtils.synthesizeMouseAtCenter(row.querySelector(".subject"), {}, win);
  Assert.deepEqual(
    selected.map(physicalSummaryIdentity),
    [c, b].map(physicalSummaryIdentity),
    "The original summary selects only surviving members in original order"
  );
  Assert.equal(
    control.outerHTML,
    controlHTML,
    "Moving a selected member preserves the independent row"
  );

  const currentRow = await showSummaryLocationMembers(
    fixture,
    [moved, c, b, d],
    headers => (selected = headers)
  );
  EventUtils.synthesizeMouseAtCenter(
    currentRow.querySelector(".subject"),
    {},
    win
  );
  const current = [moved, c, b].map(physicalSummaryIdentity);
  Assert.deepEqual(
    selected.map(physicalSummaryIdentity),
    current,
    "Fresh selection uses the actual moved header, unchanged copy and reply in order"
  );
  const currentControl = [
    ...win.document.querySelectorAll("#messageList > li"),
  ].find(node => node.dataset.messageId == d.messageId);
  Assert.ok(currentControl);
  const currentControlHTML = currentControl.outerHTML;
  destination.markMessagesRead([moved], false);
  destination.markMessagesFlagged([moved], false);
  destination.addKeywordsToMessages([moved], tagC);
  outside.markMessagesRead([fixture.excluded], false);
  outside.markMessagesFlagged([fixture.excluded], false);
  destination.markMessagesRead([collision], false);
  destination.markMessagesFlagged([collision], false);
  destination.addKeywordsToMessages([collision], tagC);
  await new Promise(resolve => win.queueMicrotask(resolve));
  Assert.ok(currentRow.classList.contains("unread"));
  Assert.ok(
    currentRow.classList.contains("starred"),
    "Unchanged members retain any-star aggregation"
  );
  Assert.equal(
    win.document
      .getElementById("starMessageButton")
      .getAttribute("aria-pressed"),
    "false"
  );
  Assert.deepEqual(
    [...currentRow.querySelectorAll(".tag")].map(node => node.textContent),
    ["Location A", "Location B", "Location C"]
  );
  destination.markMessagesRead([moved], true);
  destination.markMessagesFlagged([moved], true);
  await new Promise(resolve => win.queueMicrotask(resolve));
  Assert.ok(
    !currentRow.classList.contains("unread"),
    "Only the selected current physical members contribute read state"
  );
  Assert.equal(
    win.document
      .getElementById("starMessageButton")
      .getAttribute("aria-pressed"),
    "true",
    "Unselected unflagged equal-ID copies cannot change the all-selected aggregate"
  );
  EventUtils.synthesizeMouseAtCenter(
    currentRow.querySelector(".subject"),
    {},
    win
  );
  Assert.deepEqual(selected.map(physicalSummaryIdentity), current);
  Assert.equal(currentControl.outerHTML, currentControlHTML);
  Assert.equal(
    currentRow.querySelector(".snippet").textContent,
    "The retained summary body."
  );
  Assert.ok(
    !selected.some(
      header =>
        header.folder.URI == outside.URI ||
        (header.folder.URI == destination.URI &&
          header.messageKey == collision.messageKey)
    )
  );
  fixture.cleanup();
  info("Summary100 actual completed move/current physical selection complete");
});

add_task(async function test_summaryFolderRenameKeepsCurrentPhysicalMembers() {
  await SpecialPowers.pushPrefEnv({
    set: [["mailnews.database.global.indexer.enabled", false]],
  });
  const fixture = createSummaryLocationFixture();
  const { first, outside, a, b, c, d, win, tagC } = fixture;
  let selected;
  const row = await showSummaryLocationMembers(
    fixture,
    [a, c, b, d],
    headers => (selected = headers)
  );
  const control = [...win.document.querySelectorAll("#messageList > li")].find(
    node => node.dataset.messageId == d.messageId
  );
  Assert.ok(control);
  const controlHTML = control.outerHTML;
  const oldURI = first.URI;
  const oldName = first.name;
  const knownIds = [a.messageId, b.messageId];
  const newName = `${oldName}-renamed`;
  fixture.names.push(newName);
  const renamed = PromiseTestUtils.promiseFolderNotification(
    null,
    "folderRenamed"
  );
  first.rename(newName, null);
  const [original, replacement] = await renamed;
  Assert.equal(original.URI, oldURI);
  Assert.notEqual(replacement.URI, oldURI);
  Assert.equal(replacement.name, newName);
  Assert.ok(
    !rootFolder.containsChildNamed(oldName),
    "The actual rename removed the obsolete folder location"
  );
  const stored = [...replacement.messages];
  const currentHeaders = knownIds.map(id => {
    const matches = stored.filter(header => header.messageId == id);
    Assert.equal(
      matches.length,
      1,
      "The independently known message has one actual renamed-folder header"
    );
    return matches[0];
  });
  const expected = [currentHeaders[0], c, currentHeaders[1]].map(
    physicalSummaryIdentity
  );
  Assert.ok(
    currentHeaders.every(header => header.folder.URI == replacement.URI)
  );

  // Reoccupy the obsolete path with real, unselected equal-ID messages.
  const obsolete = rootFolder
    .createLocalSubfolder(oldName)
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const generator = new MessageGenerator();
  const decoys = knownIds.map((id, index) => {
    const message = generator.makeMessage({
      subject: `Unselected obsolete location ${index}`,
      body: { body: "Obsolete folder collision must not become current." },
    });
    message.messageId = id;
    return obsolete.addMessage(message.toMessageString());
  });
  info(
    "Summary100 actual rename locations " +
      JSON.stringify({
        prior: [oldURI, a.messageKey, b.messageKey],
        current: currentHeaders.map(physicalSummaryIdentity),
        obsolete: decoys.map(physicalSummaryIdentity),
      })
  );
  await new Promise(resolve => win.queueMicrotask(resolve));
  EventUtils.synthesizeMouseAtCenter(row.querySelector(".subject"), {}, win);
  Assert.deepEqual(
    selected.map(physicalSummaryIdentity),
    expected,
    "The retained summary resolves renamed current headers in original member order, never old-path decoys"
  );
  replacement.markMessagesRead([currentHeaders[0]], false);
  replacement.markMessagesFlagged([currentHeaders[0]], false);
  replacement.addKeywordsToMessages([currentHeaders[0]], tagC);
  obsolete.markMessagesRead(decoys, false);
  obsolete.markMessagesFlagged(decoys, false);
  outside.markMessagesRead([fixture.excluded], false);
  await new Promise(resolve => win.queueMicrotask(resolve));
  Assert.ok(
    row.classList.contains("unread"),
    "Actual new-folder metadata reaches the retained summary"
  );
  Assert.ok(
    row.classList.contains("starred"),
    "Unchanged current members retain any-star aggregation"
  );
  Assert.deepEqual(
    [...row.querySelectorAll(".tag")].map(node => node.textContent),
    ["Location A", "Location B", "Location C"]
  );
  Assert.equal(
    win.document
      .getElementById("starMessageButton")
      .getAttribute("aria-pressed"),
    "false"
  );
  replacement.markMessagesRead(currentHeaders, true);
  replacement.markMessagesFlagged(currentHeaders, true);
  await new Promise(resolve => win.queueMicrotask(resolve));
  Assert.ok(
    !row.classList.contains("unread"),
    "Obsolete and outside copies cannot affect current read aggregation"
  );
  Assert.equal(
    win.document
      .getElementById("starMessageButton")
      .getAttribute("aria-pressed"),
    "true"
  );
  EventUtils.synthesizeMouseAtCenter(row.querySelector(".subject"), {}, win);
  Assert.deepEqual(selected.map(physicalSummaryIdentity), expected);
  Assert.equal(
    row.querySelector(".snippet").textContent,
    "The retained summary body."
  );
  Assert.equal(
    control.outerHTML,
    controlHTML,
    "The independent physical control row stays unchanged"
  );
  Assert.ok(
    selected.every(
      header => header.folder.URI != oldURI && header.folder.URI != outside.URI
    )
  );
  fixture.cleanup();
  info("Summary100 actual folder rename/current physical selection complete");
});
