/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { getChatSearchService, closeChatSearch } = ChromeUtils.importESModule(
  "resource:///modules/panorama/ChatSearchService.sys.mjs"
);
const { chatSearchDocumentId } = ChromeUtils.importESModule(
  "resource:///modules/panorama/ChatSearchProvider.sys.mjs"
);
const {
  logs,
  getLogWriter,
  closeLogWriter,
  queueFileOperation,
  gFilePromises,
} = ChromeUtils.importESModule("resource:///modules/logger.sys.mjs");
const nativeChatTabmail = document.getElementById("tabmail");
const nativeChatFixtures = [];
let nativeChatAccount;
let nativeChatService;
let nativeChatSerial = 0;

add_setup(async function setupNativeChatSearch() {
  Assert.ok(Services.prefs.getBoolPref("mail.panorama.enabled"));
  Assert.ok(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    ) instanceof Ci.nsIDatabaseCore,
    "The process started with the real native backend"
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["mail.chat.enabled", true],
      ["mailnews.database.global.indexer.enabled", true],
      ["purple.logging.log_chats", true],
      ["chat.logging.cleanup", false],
      ["gloda.show_as_list_by_default", false],
    ],
  });
  registerCleanupFunction(async () => {
    while (nativeChatTabmail.tabInfo.length > 1) {
      nativeChatTabmail.closeTab(1);
    }
    for (const fixture of nativeChatFixtures) {
      fixture.conversation.close();
      closeLogWriter(fixture.conversation);
    }
    await closeChatSearch();
    for (const fixture of nativeChatFixtures) {
      for (const path of fixture.writer.paths) {
        await gFilePromises.get(path);
        await IOUtils.remove(path, { ignoreAbsent: true });
      }
    }
    if (nativeChatAccount) {
      nativeChatAccount.disconnect();
      IMServices.accounts.deleteAccount(nativeChatAccount.id);
      await Promise.resolve();
    }
  });
  nativeChatAccount = IMServices.accounts.createAccount(
    "native-search-account",
    "prpl-mochitest"
  );
  const updated = TestUtils.topicObserved("account-updated");
  nativeChatAccount.password = "native search fixture";
  await updated;
  nativeChatAccount.connect();
  nativeChatService = await getChatSearchService();
});

/**
 * Writes a real protocol message through the logger and native service.
 *
 * @param {string} text - Actual logged body.
 * @param {string} [name] - Conversation title, independent of the remote message id.
 * @returns {Promise<object>} Physical logger fixture.
 */
async function nativeChatFixture(text, name = "native conversation") {
  const conversation = nativeChatAccount.prplAccount.wrappedJSObject.makeMUC(
    name + " " + ++nativeChatSerial
  );
  const fixture = { conversation, writer: getLogWriter(conversation) };
  nativeChatFixtures.push(fixture);
  conversation.writeMessage("NativeSpeaker", text, {
    incoming: true,
    remoteId: "equal-remote-id",
  });
  await nativeChatService.flush();
  fixture.path = fixture.writer.currentPath;
  fixture.id = chatSearchDocumentId(fixture.path);
  Assert.ok(await IOUtils.exists(fixture.path), "The physical source exists");
  return fixture;
}

/**
 * Searches through the retained toolbar and waits for its actual native view.
 *
 * @param {string} text - Literal global query.
 * @returns {Promise<{tab: object, context: object, win: Window}>} Retained view.
 */
async function nativeChatQuery(text) {
  const input = document.querySelector(
    "#unifiedToolbarContent global-search-bar"
  );
  input.popup.selectedIndex = -1;
  input.dispatchEvent(new CustomEvent("search", { detail: text }));
  const tab = nativeChatTabmail.currentTabInfo;
  Assert.equal(tab.mode.name, "glodaFacet");
  await TestUtils.waitForCondition(() => tab.searchPromise);
  Assert.ok(await tab.searchPromise, "The actual native query succeeded");
  const win = tab.browser.contentWindow;
  return { tab, context: win.FacetContext, win };
}

/**
 * Gets the captured row for one physical log, without a logical-id lookup.
 *
 * @param {object} view - Current retained query view.
 * @param {object} fixture - Actual logger fixture.
 * @returns {object} Captured hit, document and snippet.
 */
function nativeChatItem(view, fixture) {
  const item = view.context.chatSearchResultSet.items.find(
    entry => entry.hit.id === fixture.id
  );
  Assert.ok(item, "The query includes the selected physical transcript");
  return item;
}

/**
 * Clicks the physical row and waits for real conversation load and match display.
 *
 * @param {object} view - Retained native query view.
 * @param {object} fixture - Selected physical transcript.
 * @returns {Promise<Element>} Existing conversation browser.
 */
async function clickNativeChat(view, fixture) {
  const item = nativeChatItem(view, fixture);
  const row = [
    ...view.win.document.querySelectorAll(".native-chat-result"),
  ].find(node => node.dataset.id === fixture.id);
  Assert.ok(row, "A real native row was rendered");
  const browser = document.getElementById("conv-log-browser");
  const loaded = waitForConversationLoad(browser);
  const displayed = BrowserTestUtils.waitForEvent(browser, "MessagesDisplayed");
  EventUtils.synthesizeMouseAtCenter(row.querySelector("button"), {}, view.win);
  await loaded;
  await displayed;
  await view.tab.chatSearchOpenPromise;
  Assert.equal(nativeChatTabmail.currentTabInfo.mode.name, "chat");
  Assert.equal(
    document.getElementById("searchResultConv").nativeChatLog.resolved.id,
    fixture.id,
    "The reader keeps the clicked physical identity"
  );
  if (item.snippet.firstMatchText) {
    await TestUtils.waitForCondition(
      () =>
        browser.contentWindow.getSelection().toString() ===
        item.snippet.firstMatchText,
      "The real findbar selects the current Unicode match"
    );
  } else {
    Assert.equal(document.getElementById("log-findbar")._findField.value, "");
    Assert.ok(
      BrowserTestUtils.isHidden(document.getElementById("log-findbar"))
    );
  }
  return browser;
}

add_task(
  async function test_nativeChatQueryKeepsUnicodeAndClickedPhysicalLog() {
    const selected = await nativeChatFixture(
      "nativeunicode 😀 café 東京 selectedcopy"
    );
    const peer = await nativeChatFixture(
      "nativeunicode 😀 café 東京 foreigncopy"
    );
    const view = await nativeChatQuery("café");
    Assert.notEqual(selected.id, peer.id);
    Assert.deepEqual(
      view.context.chatSearchResultSet.items.map(item => item.hit.id).sort(),
      [selected.id, peer.id].sort(),
      "Equal remote message ids do not merge physical logs"
    );
    const item = nativeChatItem(view, selected);
    Assert.equal(item.snippet.firstMatchText, "café");
    Assert.greater(item.snippet.ranges.length, 0);
    const marks = [
      ...view.win.document.querySelectorAll(".native-chat-result mark"),
    ];
    Assert.equal(
      marks.length,
      2,
      "Both physical café rows render a real highlight"
    );
    Assert.ok(marks.every(mark => mark.textContent === "café"));
    const browser = await clickNativeChat(view, selected);
    const text = browser._conv
      .getMessages()
      .map(message => message.message)
      .join("\n");
    Assert.ok(text.includes("selectedcopy"));
    Assert.ok(!text.includes("foreigncopy"));
    const cjkView = await nativeChatQuery("東京");
    Assert.equal(
      nativeChatItem(cjkView, selected).snippet.firstMatchText,
      "東京"
    );
    const cjkMarks = [
      ...cjkView.win.document.querySelectorAll(".native-chat-result mark"),
    ];
    Assert.equal(
      cjkMarks.length,
      2,
      "Both physical CJK rows render a real highlight"
    );
    Assert.ok(cjkMarks.every(mark => mark.textContent === "東京"));
    await clickNativeChat(cjkView, selected);
    const titleOnly = await nativeChatFixture(
      "unmatched body",
      "nativetitleonlyneedle"
    );
    const titleView = await nativeChatQuery("nativetitleonlyneedle");
    Assert.strictEqual(
      nativeChatItem(titleView, titleOnly).snippet.firstMatchText,
      null
    );
    await clickNativeChat(titleView, titleOnly);
  }
);

add_task(
  async function test_nativeChatOpenRejectsStaleMissingAndIneligibleLog() {
    const stale = await nativeChatFixture("nativestaleneedle before");
    const view = await nativeChatQuery("nativestaleneedle");
    const old = nativeChatItem(view, stale);
    stale.conversation.writeMessage("NativeSpeaker", "later physical append", {
      incoming: true,
      remoteId: "later",
    });
    await nativeChatService.flush();
    const tabs = nativeChatTabmail.tabInfo.length;
    Assert.equal(await view.context.openChatSearchConversation(old), null);
    Assert.equal(nativeChatTabmail.tabInfo.length, tabs);

    const missing = await nativeChatFixture("nativemissingneedle");
    const missingView = await nativeChatQuery("nativemissingneedle");
    const missingItem = nativeChatItem(missingView, missing);
    closeLogWriter(missing.conversation);
    await queueFileOperation(missing.path, () => IOUtils.remove(missing.path));
    Assert.equal(
      await missingView.context.openChatSearchConversation(missingItem),
      null
    );
    Assert.notEqual(nativeChatTabmail.currentTabInfo.mode.name, "chat");

    const privateLog = await nativeChatFixture("nativeeligibilityneedle");
    const privateView = await nativeChatQuery("nativeeligibilityneedle");
    const captured = nativeChatItem(privateView, privateLog);
    await SpecialPowers.pushPrefEnv({
      set: [["mailnews.database.global.indexer.enabled", false]],
    });
    try {
      await nativeChatService.flush();
      Assert.equal(
        await privateView.context.openChatSearchConversation(captured),
        null
      );
      Assert.notEqual(nativeChatTabmail.currentTabInfo.mode.name, "chat");
    } finally {
      await SpecialPowers.popPrefEnv();
      await nativeChatService.flush();
    }
  }
);

add_task(
  async function test_nativeChatOpenPreservesParseIoAndCancellationErrors() {
    const fixture = await nativeChatFixture("nativefailureneedle");
    const view = await nativeChatQuery("nativefailureneedle");
    const item = nativeChatItem(view, fixture);
    const original = logs.getLogFromFile;
    const parseFailure = new Error(
      "Declared parser failure after the real transcript parse"
    );
    let parsedPhysicalLog = false;
    const parserMethods = [];
    logs.getLogFromFile = async function (...args) {
      const log = await original.apply(this, args);
      if (args[0] === fixture.path) {
        const parse = log.getConversation;
        parserMethods.push([log, parse]);
        log.getConversation = async function () {
          await parse.call(this);
          parsedPhysicalLog = true;
          throw parseFailure;
        };
      }
      return log;
    };
    try {
      await Assert.rejects(
        view.context.openChatSearchConversation(item),
        error => error === parseFailure
      );
      Assert.ok(
        parsedPhysicalLog,
        "The fault follows the actual physical logger parse"
      );
    } finally {
      logs.getLogFromFile = original;
      for (const [log, parse] of parserMethods) {
        log.getConversation = parse;
      }
    }

    // A directory in place of the file is a real native I/O failure, not absence.
    closeLogWriter(fixture.conversation);
    const bytes = await queueFileOperation(fixture.path, () =>
      IOUtils.read(fixture.path)
    );
    await IOUtils.remove(fixture.path);
    await IOUtils.makeDirectory(fixture.path);
    try {
      await Assert.rejects(
        view.context.openChatSearchConversation(item),
        error => /directory/i.test(error.message)
      );
      Assert.notEqual(nativeChatTabmail.currentTabInfo.mode.name, "chat");
    } finally {
      await IOUtils.remove(fixture.path);
      await IOUtils.write(fixture.path, bytes);
    }

    const entered = Promise.withResolvers();
    const gate = Promise.withResolvers();
    const held = queueFileOperation(fixture.path, async () => {
      entered.resolve();
      await gate.promise;
    });
    registerCleanupFunction(() => gate.resolve());
    await entered.promise;
    const opening = view.context.openChatSearchConversation(item);
    const reason = new Error("Cancel this physical opening");
    view.context.chatSearchOpenController.abort(reason);
    await Assert.rejects(opening, error => error === reason);
    gate.resolve();
    await held;
    Assert.notEqual(nativeChatTabmail.currentTabInfo.mode.name, "chat");
  }
);

add_task(async function test_nativeChatQueryAndReaderIgnoreRetiredSelection() {
  const fixture = await nativeChatFixture("nativeretiredneedle");
  const view = await nativeChatQuery("nativeretiredneedle");
  const queryEntered = Promise.withResolvers();
  const queryGate = Promise.withResolvers();
  const queryHeld = queueFileOperation(fixture.path, async () => {
    queryEntered.resolve();
    await queryGate.promise;
  });
  registerCleanupFunction(() => queryGate.resolve());
  await queryEntered.promise;
  fixture.conversation.writeMessage("NativeSpeaker", "queued source append", {
    incoming: true,
    remoteId: "retired-append",
  });
  const retiredQuery = view.context.loadMailSearch();
  view.tab.mailSearch.text = "nativeabsentreplacementneedle";
  const replacementQuery = view.context.loadMailSearch();
  Assert.equal(
    await retiredQuery,
    null,
    "The replaced query settles before the logger is released"
  );
  queryGate.resolve();
  await queryHeld;
  await replacementQuery;
  Assert.deepEqual(view.context.chatSearchResultSet.items, []);
  Assert.equal(
    view.win.document.querySelectorAll(".native-chat-result").length,
    0
  );
  view.tab.mailSearch.text = "nativeretiredneedle";
  await view.context.loadMailSearch();
  const item = nativeChatItem(view, fixture);
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const held = queueFileOperation(fixture.path, async () => {
    entered.resolve();
    await gate.promise;
  });
  registerCleanupFunction(() => gate.resolve());
  await entered.promise;
  const opening = view.context.openChatSearchConversation(item);
  // The current controller belongs to the retained tab and closes its frame.
  nativeChatTabmail.closeTab(view.tab);
  await Assert.rejects(opening, error => error.name === "AbortError");
  gate.resolve();
  await held;
  Assert.notEqual(nativeChatTabmail.currentTabInfo.mode.name, "chat");

  const current = await nativeChatFixture("nativecurrentneedle");
  const currentView = await nativeChatQuery("nativecurrentneedle");
  const logBrowser = document.getElementById("conv-log-browser");
  let retiredDuringLoad = false;
  const retire = subject => {
    if (subject === logBrowser) {
      Services.obs.removeObserver(retire, "conversation-loaded");
      retiredDuringLoad = true;
      nativeChatTabmail.selectedTab = currentView.tab;
    }
  };
  Services.obs.addObserver(retire, "conversation-loaded");
  registerCleanupFunction(() => {
    if (!retiredDuringLoad) {
      Services.obs.removeObserver(retire, "conversation-loaded");
    }
  });
  const loaded = waitForConversationLoad(logBrowser);
  await currentView.context.openChatSearchConversation(
    nativeChatItem(currentView, current)
  );
  await loaded;
  Assert.ok(
    retiredDuringLoad,
    "The selection retired at an actual reader load"
  );
  Assert.ok(BrowserTestUtils.isHidden(document.getElementById("logDisplay")));
  Assert.equal(document.getElementById("log-findbar")._findField.value, "");
  const browser = await clickNativeChat(currentView, current);
  Assert.ok(
    browser._conv
      .getMessages()
      .some(message => message.message === "nativecurrentneedle")
  );
  // Retiring the query cannot leave its old term/content selected in another tab.
  nativeChatTabmail.selectedTab = currentView.tab;
  Assert.ok(BrowserTestUtils.isHidden(document.getElementById("logDisplay")));
  Assert.equal(document.getElementById("log-findbar")._findField.value, "");
  Assert.equal(
    document.getElementById("searchResultConv").nativeChatLog,
    undefined
  );
});
