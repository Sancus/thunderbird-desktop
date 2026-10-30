/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { mailTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MailTestUtils.sys.mjs"
);

add_task(async function testTopicRestored() {
  const account = IMServices.accounts.createAccount(
    "testuser",
    "prpl-mochitest"
  );
  const passwordPromise = TestUtils.topicObserved("account-updated");
  account.password = "this is a test";
  await passwordPromise;
  account.connect();

  await openChatTab();
  ok(BrowserTestUtils.isVisible(document.getElementById("chatPanel")));

  const conversation =
    account.prplAccount.wrappedJSObject.makeMUC("logs topic");
  let convNode = getConversationItem(conversation);
  ok(convNode);

  await EventUtils.synthesizeMouseAtCenter(convNode, {});

  let chatConv = getChatConversationElement(conversation);
  ok(chatConv, "found conversation");
  const browserDisplayed = BrowserTestUtils.waitForEvent(
    chatConv.convBrowser,
    "MessagesDisplayed"
  );
  ok(BrowserTestUtils.isVisible(chatConv), "conversation visible");

  conversation.addParticipant("topic");
  conversation.addMessages([
    {
      who: "topic",
      content: "hi",
      options: {
        incoming: true,
      },
    },
  ]);
  await browserDisplayed;

  // Close and re-open conversation to get logs
  conversation.close();
  const newConversation =
    account.prplAccount.wrappedJSObject.makeMUC("logs topic");
  convNode = getConversationItem(newConversation);
  ok(convNode);

  let conversationLoaded = waitForConversationLoad();
  await EventUtils.synthesizeMouseAtCenter(convNode, {});

  chatConv = getChatConversationElement(newConversation);
  ok(chatConv, "found conversation");
  ok(BrowserTestUtils.isVisible(chatConv), "conversation visible");

  const topicChanged = waitForNotification(
    newConversation,
    "chat-update-topic"
  );
  newConversation.setTopic("foo bar", "topic");
  await topicChanged;
  const logTree = document.getElementById("logTree");
  const chatTopInfo = document.querySelector("chat-conversation-info");

  is(chatTopInfo.topic.value, "foo bar");

  // Wait for log list to be populated, sadly there is no event and it is delayed by promises.
  await TestUtils.waitForCondition(() => logTree.view.rowCount > 0);

  await conversationLoaded;
  const logBrowser = document.getElementById("conv-log-browser");
  conversationLoaded = waitForConversationLoad(logBrowser);
  mailTestUtils.treeClick(EventUtils, window, logTree, 0, 0, {
    clickCount: 1,
  });
  await conversationLoaded;

  ok(BrowserTestUtils.isVisible(logBrowser));
  is(chatTopInfo.topic.value, "", "Topic is cleared when viewing logs");

  EventUtils.synthesizeMouseAtCenter(
    document.getElementById("goToConversation"),
    {}
  );

  ok(BrowserTestUtils.isHidden(logBrowser));
  is(chatTopInfo.topic.value, "foo bar");

  newConversation.close();
  account.disconnect();
  IMServices.accounts.deleteAccount(account.id);
  await Promise.resolve(); // Ensure login removal.
});

const { GlodaIMSearcher } = ChromeUtils.importESModule(
  "resource:///modules/GlodaIMSearcher.sys.mjs"
);
const { GlodaIndexer, IndexingJob } = ChromeUtils.importESModule(
  "resource:///modules/gloda/GlodaIndexer.sys.mjs"
);
const { GlodaConstants } = ChromeUtils.importESModule(
  "resource:///modules/gloda/GlodaConstants.sys.mjs"
);
const { getLogWriter, gFilePromises } = ChromeUtils.importESModule(
  "resource:///modules/logger.sys.mjs"
);

const legacyChat = { conversations: [], paths: [], tabs: [] };

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
    "The independent chat reference uses the retained legacy backend"
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["mailnews.database.global.indexer.enabled", true],
      ["mailnews.database.global.search.im.limit", 100],
      ["gloda.show_as_list_by_default", false],
      ["purple.logging.log_chats", true],
    ],
  });
  registerCleanupFunction(async () => {
    await cleanupLegacyChat();
    await SpecialPowers.popPrefEnv();
  });

  const account = (legacyChat.account = IMServices.accounts.createAccount(
    "legacy-search-account",
    "prpl-mochitest"
  ));
  const updated = TestUtils.topicObserved("account-updated");
  account.password = "legacy reference";
  await updated;
  account.connect();

  for (const name of ["legacy alpha", "legacy beta", "legacy gamma"]) {
    legacyChat.conversations.push(
      account.prplAccount.wrappedJSObject.makeMUC(name)
    );
  }
  const [alpha, beta, gamma] = legacyChat.conversations;
  alpha.writeMessage("PlainSpeaker", "legacychat cobalt river café 東京検索", {
    incoming: true,
    remoteId: "plain",
  });
  alpha.writeMessage("PlainSpeaker", "logonlyneedle", {
    incoming: true,
    remoteId: "remove",
  });
  alpha.writeMessage("PlainSpeaker", "oldeditneedle", {
    incoming: true,
    remoteId: "edit",
  });
  alpha.writeMessage("PlainSpeaker", "redactneedle", {
    incoming: true,
    remoteId: "redact",
  });
  alpha.writeMessage("PlainSpeaker", "nologsecretneedle", {
    incoming: true,
    noLog: true,
  });
  beta.writeMessage(
    "OriginalSpeaker",
    '<p class="attributeonlyneedle">legacychat cobalt distant river <b>markupneedle</b> &amp; entityword</p>',
    {
      incoming: true,
      _alias: "AliasSpeaker",
    }
  );
  gamma.writeMessage("FallbackSpeaker", "legacychat river", { incoming: true });
  for (const conversation of legacyChat.conversations) {
    const paths =
      await IMServices.logs.getLogPathsForConversation(conversation);
    Assert.equal(
      paths.length,
      1,
      "The logger created one physical fixture log"
    );
    legacyChat.paths.push(paths[0]);
  }
  await indexLegacyChatLogs();
});

/** Close the owned tabs, conversations and account before the shared head checks. */
async function cleanupLegacyChat() {
  const tabmail = document.getElementById("tabmail");
  for (const tab of legacyChat.tabs) {
    if (tabmail.tabInfo.includes(tab)) {
      tabmail.closeTab(tab);
    }
  }
  for (const conversation of legacyChat.conversations) {
    conversation.close();
  }
  if (legacyChat.account) {
    const account = legacyChat.account;
    legacyChat.account = null;
    if (IMServices.accounts.getAccounts().some(item => item.id == account.id)) {
      account.disconnect();
      IMServices.accounts.deleteAccount(account.id);
      await Promise.resolve();
    }
  }
}

/** Queue the retained IM indexer's normal startup sweep and await its work. */
async function indexLegacyChatLogs() {
  await new Promise(resolve => {
    const listener = status => {
      if (status == GlodaConstants.kIndexerIdle) {
        GlodaIndexer.removeListener(listener);
        resolve();
      }
    };
    GlodaIndexer.indexJob(new IndexingJob("logsFolderSweep", null));
    GlodaIndexer.addListener(listener);
  });
}

/**
 * Query the retained Gloda IM index and return its actual collection items.
 *
 * @param {string} text - Search text.
 * @param {boolean} [andTerms=true] - Require all parsed terms.
 * @returns {Promise<Array<{id: number, path: string, content: string}>>} Indexed physical log results.
 */
function searchLegacyChat(text, andTerms = true) {
  return new Promise(resolve => {
    const searcher = new GlodaIMSearcher(null, text, andTerms);
    searcher.getCollection({
      onItemsAdded() {},
      onItemsModified() {},
      onItemsRemoved() {},
      onQueryCompleted(collection) {
        Assert.ok(searcher.completed, "The real Gloda search completed");
        resolve(collection.items);
      },
    });
  });
}

/**
 * Check exact profile-relative log paths independently of Gloda result IDs.
 *
 * @param {string} text - Search text.
 * @param {string[]} paths - Expected physical logger paths.
 * @param {boolean} [andTerms=true] - Require all parsed terms.
 * @returns {Promise<Array<{id: number, path: string, content: string}>>} Actual indexed results.
 */
async function assertLegacyChatPaths(text, paths, andTerms = true) {
  const items = await searchLegacyChat(text, andTerms);
  Assert.deepEqual(
    items.map(item => item.path).sort(),
    paths.map(path => PathUtils.split(path).slice(-4).join("/")).sort(),
    `Exact physical logs for ${JSON.stringify(text)}`
  );
  return items;
}

add_task(async function test_legacyChatSearchUsesLoggedTextAndSpeaker() {
  const [alpha, beta, gamma] = legacyChat.paths;
  await assertLegacyChatPaths("legacychat", [alpha, beta, gamma]);
  await assertLegacyChatPaths("cobalt river", [alpha, beta]);
  await assertLegacyChatPaths('"cobalt river"', [alpha]);
  await assertLegacyChatPaths("cobalt absentneedle", []);
  await assertLegacyChatPaths("cobalt absentneedle", [alpha, beta], false);
  await assertLegacyChatPaths("markupneedle", [beta]);
  await assertLegacyChatPaths("attributeonlyneedle", []);
  await assertLegacyChatPaths("café", [alpha]);
  await assertLegacyChatPaths("東京", [alpha]);
  await assertLegacyChatPaths("PlainSpeaker", [alpha]);
  await assertLegacyChatPaths("AliasSpeaker", [beta]);
  await assertLegacyChatPaths("FallbackSpeaker", [gamma]);
  await assertLegacyChatPaths("nologsecretneedle", []);
  Assert.ok(
    !(await IOUtils.readUTF8(alpha)).includes("nologsecretneedle"),
    "The real logger excludes noLog before indexing"
  );
  const [item] = await searchLegacyChat("markupneedle");
  Assert.ok(item.content.includes("AliasSpeaker: legacychat"));
  Assert.ok(item.content.includes("markupneedle & entityword"));
  Assert.ok(!item.content.includes("<b>"), "HTML is converted to plain text");
});

add_task(
  async function test_legacyChatAppendEditAndRedactionReplaceIndexedText() {
    const alpha = legacyChat.conversations[0];
    const path = legacyChat.paths[0];
    const [before] = await assertLegacyChatPaths("oldeditneedle", [path]);
    alpha.writeMessage("PlainSpeaker", "appendneedle", { incoming: true });
    alpha.removeMessage("remove");
    alpha.updateMessage("PlainSpeaker", "neweditneedle", {
      incoming: true,
      remoteId: "edit",
    });
    alpha.updateMessage("PlainSpeaker", "Message was redacted", {
      incoming: true,
      remoteId: "redact",
      deleted: true,
    });
    await IMServices.logs.getLogPathsForConversation(alpha);
    await indexLegacyChatLogs();
    await assertLegacyChatPaths("appendneedle", [path]);
    await assertLegacyChatPaths("logonlyneedle", [path]);
    const [after] = await assertLegacyChatPaths("neweditneedle", [path]);
    Assert.equal(
      after.id,
      before.id,
      "Reindexing updates the same physical log"
    );
    await assertLegacyChatPaths("oldeditneedle", []);
    await assertLegacyChatPaths("redactneedle", []);
    await assertLegacyChatPaths('"Message was redacted"', []);
    const log = await IMServices.logs.getLogFromFile(path);
    const conversation = await log.getConversation();
    Assert.deepEqual(
      conversation
        .getMessages()
        .filter(message => !message.noLog)
        .map(message => message.remoteId)
        .filter(Boolean)
        .sort(),
      ["edit", "plain", "remove"],
      "The real parser keeps the edited message and removes its redacted peer"
    );
  }
);

add_task(
  async function test_legacyChatRotationAndStartupSweepKeepPhysicalLogs() {
    const alpha = legacyChat.conversations[0];
    const writer = getLogWriter(alpha);
    const time = Math.floor(alpha.startDate / 1000000) + 31 * 60;
    alpha.writeMessage("PlainSpeaker", "legacychat rotationneedle", {
      incoming: true,
      time,
    });
    const paths = await IMServices.logs.getLogPathsForConversation(alpha);
    Assert.equal(paths.length, 2, "Inactivity creates a second real log file");
    Assert.notEqual(paths[0], paths[1]);
    legacyChat.rotatedPath = paths[1];
    await indexLegacyChatLogs();
    const first = await assertLegacyChatPaths("legacychat", [
      ...legacyChat.paths,
      paths[1],
    ]);
    await assertLegacyChatPaths("rotationneedle", [paths[1]]);
    alpha.close();
    await gFilePromises.get(writer.currentPath);
    await indexLegacyChatLogs();
    const next = await assertLegacyChatPaths("legacychat", [
      ...legacyChat.paths,
      paths[1],
    ]);
    Assert.deepEqual(
      next.map(item => [item.path, item.id]).sort(),
      first.map(item => [item.path, item.id]).sort(),
      "A fresh startup-style sweep does not duplicate closed physical logs"
    );
  }
);

/**
 * Click a real global Gloda chat result and check its opened log and first match.
 *
 * @param {string} text - Global search text.
 * @param {string} expectedPath - Expected physical search hit.
 * @param {string} [expectedName="legacy alpha"] - Expected logged conversation name.
 * @returns {Promise<void>}
 */
async function openLegacyChatHit(
  text,
  expectedPath,
  expectedName = "legacy alpha"
) {
  const tabmail = document.getElementById("tabmail");
  tabmail.selectedTab = tabmail.tabInfo[0];
  const input = document.querySelector(
    "#unifiedToolbarContent global-search-bar"
  );
  Assert.ok(input, "Use the retained global toolbar consumer");
  input.popup.selectedIndex = -1;
  input.dispatchEvent(new CustomEvent("search", { detail: text }));
  const tab = tabmail.currentTabInfo;
  legacyChat.tabs.push(tab);
  Assert.equal(tab.mode.name, "glodaFacet");
  Assert.ok(tab.IMSearcher instanceof GlodaIMSearcher);
  await TestUtils.waitForCondition(
    () => tab.browser?.contentWindow.FacetContext?.fullSet?.length,
    "The actual legacy global result is rendered"
  );
  const facetWindow = tab.browser.contentWindow;
  const rows = [
    ...facetWindow.document.querySelectorAll("facet-result-message"),
  ];
  Assert.equal(rows.length, 1, "Only the expected physical log matches");
  const row = rows[0];
  Assert.equal(
    row.message.path,
    PathUtils.split(expectedPath).slice(-4).join("/")
  );
  Assert.equal(
    row.firstMatchText,
    text,
    "The clicked row supplies its first match"
  );
  const browser = document.getElementById("conv-log-browser");
  const loaded = waitForConversationLoad(browser);
  EventUtils.synthesizeMouseAtCenter(
    row.querySelector(".message-subject"),
    {},
    facetWindow
  );
  await loaded;
  await TestUtils.waitForCondition(
    () => browser.contentWindow.getSelection().toString() == text,
    "The real findbar selects the clicked result's first matching text"
  );
  Assert.equal(tabmail.currentTabInfo.mode.name, "chat");
  Assert.equal(
    document.getElementById("searchResultConv").log.path,
    row.message.path
  );
  Assert.equal(browser._conv.normalizedName, expectedName);
  Assert.ok(BrowserTestUtils.isVisible(browser));
  Assert.equal(document.getElementById("log-findbar")._findField.value, text);
  const view = window.chatHandler._treeView;
  const selected = view._rowMap[view.selection.currentIndex].log;
  const day = PathUtils.filename(expectedPath).slice(0, 10);
  const expectedPaths = [...legacyChat.paths, legacyChat.rotatedPath].filter(
    path =>
      PathUtils.parent(path) == PathUtils.parent(expectedPath) &&
      PathUtils.filename(path).slice(0, 10) == day
  );
  Assert.deepEqual(
    selected._entryPaths.toSorted(),
    expectedPaths.toSorted(),
    "The exact clicked physical hit selects its real day group"
  );
  tabmail.closeTab(tab);
}

add_task(
  async function test_legacyGlobalChatOpensRenamedAndRemovedAccountLogs() {
    await openLegacyChatHit("markupneedle", legacyChat.paths[1], "legacy beta");
    await openLegacyChatHit("東京", legacyChat.paths[0]);
    await openLegacyChatHit("AliasSpeaker", legacyChat.paths[1], "legacy beta");
    legacyChat.account.alias = "Renamed legacy account";
    await openLegacyChatHit("rotationneedle", legacyChat.rotatedPath);
    for (const conversation of legacyChat.conversations) {
      conversation.close();
    }
    legacyChat.account.disconnect();
    IMServices.accounts.deleteAccount(legacyChat.account.id);
    legacyChat.account = null;
    await Promise.resolve();
    await openLegacyChatHit("rotationneedle", legacyChat.rotatedPath);
  }
);

add_task(
  async function test_legacyMissingAndCorruptOriginalRetainsSearchText() {
    const path = legacyChat.paths[1];
    const original = await IOUtils.read(path);
    const [before] = await assertLegacyChatPaths("markupneedle", [path]);
    try {
      await IOUtils.remove(path);
      await indexLegacyChatLogs();
      const [missing] = await assertLegacyChatPaths("markupneedle", [path]);
      Assert.equal(
        missing.id,
        before.id,
        "The legacy sweep retains an absent log's indexed text"
      );
      const absentLog = await IMServices.logs.getLogFromFile(path);
      Assert.equal(
        await absentLog.getConversation(),
        null,
        "The original logger cannot open the missing source"
      );
      await Assert.rejects(
        IMServices.logs.getLogFromFile(path, true),
        /invalid argument/,
        "The retained grouped-open API rejects an absent day's only source"
      );
      await IOUtils.writeUTF8(path, "not a JSON log\n");
      await indexLegacyChatLogs();
      const [corrupt] = await assertLegacyChatPaths("markupneedle", [path]);
      Assert.equal(
        corrupt.id,
        before.id,
        "A corrupt source does not erase the old searchable row"
      );
      const corruptLog = await IMServices.logs.getLogFromFile(path);
      Assert.equal(await corruptLog.getConversation(), null);
    } finally {
      await IOUtils.write(path, original);
      await indexLegacyChatLogs();
      await cleanupLegacyChat();
    }
    await assertLegacyChatPaths("markupneedle", [path]);
  }
);
