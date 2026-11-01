/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const lazy = XPCOMUtils.declareLazy({
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
});

// Load subscript shared with all menu tests.
Services.scriptloader.loadSubScript(
  new URL("head_menus.js", gTestPath).href,
  this
);

let gAccount, gFolders, gMessage;

add_setup(async () => {
  await lazy.SearchService.init();

  gAccount = createAccount();
  addIdentity(gAccount);
  gFolders = gAccount.incomingServer.rootFolder.subFolders;
  await createMessages(gFolders[0], {
    count: 1,
    body: {
      contentType: "text/html",
      body: await IOUtils.readUTF8(getTestFilePath(`data/content.html`)),
    },
  });
  gMessage = [...gFolders[0].messages][0];

  document.getElementById("tabmail").currentAbout3Pane.restoreState({
    folderPaneVisible: true,
    folderURI: gAccount.incomingServer.rootFolder.URI,
  });
});

async function subtest_tab(manifest) {
  async function checkTabEvent(index, active, type) {
    await openMenuPopup(menu, tabs[index], {
      type: "contextmenu",
    });
    Assert.ok(menu.querySelector("#menus_mochi_test-menuitem-_tab"));
    await closeMenuPopup(menu);

    await checkShownEvent(
      extension,
      { menuIds: ["tab"], contexts: ["tab"] },
      { active, index, type }
    );
  }

  const extension = await getMenuExtension(manifest);

  await extension.startup();
  await extension.awaitMessage("menus-created");

  const tabmail = document.getElementById("tabmail");
  const configTab = window.openContentTab("about:config");
  await awaitBrowserLoaded(configTab.browser, "about:config");
  const mozillaTab = window.openContentTab("about:mozilla");
  await awaitBrowserLoaded(mozillaTab.browser, "about:mozilla");
  tabmail.openTab("mail3PaneTab", { folderURI: gFolders[0].URI });

  const tabs = document.getElementById("tabmail-tabs").allTabs;
  const menu = document.getElementById("tabContextMenu");

  await checkTabEvent(0, false, "mail");
  await checkTabEvent(1, false, "special");
  await checkTabEvent(2, false, "special");
  await checkTabEvent(3, true, "mail");

  await extension.unload();

  tabmail.closeOtherTabs(0);
}
add_task(async function test_tab_mv2() {
  await subtest_tab({
    manifest_version: 2,
  });
});
add_task(async function test_tab_mv3() {
  await subtest_tab({
    manifest_version: 3,
  });
});

/**
 * Observe real search tabs and their physical selection through an extension.
 *
 * @param {number} manifestVersion - Supported extension manifest version.
 */
async function checkGlobalResults(manifestVersion) {
  Assert.ok(Services.prefs.getBoolPref("mail.panorama.enabled"));
  Assert.ok(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    ) instanceof Ci.nsIDatabaseCore,
    "The actual startup database is Panorama"
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["mailnews.database.global.indexer.enabled", true],
      ["mailnews.default_view_flags", 0],
      ["mailnews.mark_message_read.auto", false],
    ],
  });
  const { getMailSearchService, closeMailSearch } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearch.sys.mjs"
  );
  const { getMailSearchHeader } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearchPolicy.sys.mjs"
  );
  const tabmail = document.getElementById("tabmail");
  const folders = [];
  for (const name of ["First", "Second", "Excluded"]) {
    folders.push(
      await createSubfolder(
        gAccount.incomingServer.rootFolder,
        `Extension101${manifestVersion}${name}`
      )
    );
  }
  const [first, second, excluded] = folders;
  Assert.equal(first.msgStore.storeType, "mbox", "The fixture uses real mbox");
  excluded.setStringProperty("indexingPriority", "-1");
  const term = `extensionphysicalneedle${manifestVersion}`;
  const generator = new MessageGenerator();
  const message = generator.makeMessage({ subject: term });
  message.messageId = `extension101-${manifestVersion}@example.invalid`;
  const copy = message.toMessageString();
  await createMessageFromString(first, copy);
  await createMessageFromString(second, copy);
  await createMessageFromString(excluded, copy);
  await createMessages(first, { count: 1, subject: `${term} distinct` });
  await createMessages(excluded, { count: 1, subject: "Outside control" });
  const firstHeaders = [...first.messages];
  const selected = [...second.messages][0];
  const expected = [...firstHeaders, selected];
  const outside = [...excluded.messages];
  const physical = header => [
    header.folder.URI,
    header.messageKey,
    header.messageId,
  ];
  Assert.equal(firstHeaders[0].messageId, selected.messageId);
  Assert.equal(outside[0].messageId, selected.messageId);
  const expectedPhysical = expected.map(physical).sort();
  let extension;
  registerCleanupFunction(async () => {
    tabmail.closeOtherTabs(0);
    if (extension) {
      await extension.unload();
    }
    await closeMailSearch();
    for (const folder of folders) {
      if (folder.parent) {
        folder.parent.propagateDelete(folder, true);
      }
    }
  });
  const service = await getMailSearchService();
  let progress;
  do {
    progress = await service.update({ limit: 500 });
  } while (progress.moreWork);

  const background = async () => {
    const events = [];
    let watchedSelection;
    browser.tabs.onCreated.addListener(tab => {
      events.push(["created", tab]);
      browser.test.sendMessage("created", tab);
    });
    browser.tabs.onActivated.addListener(info => {
      events.push(["activated", info]);
    });
    browser.tabs.onUpdated.addListener((id, change, tab) => {
      events.push(["updated", id, change, tab]);
    });
    browser.tabs.onRemoved.addListener((id, info) => {
      events.push(["removed", id, info]);
      browser.test.sendMessage("removed", id);
    });
    browser.menus.onShown.addListener((info, tab) => {
      browser.test.sendMessage("shown", [info, tab]);
    });
    browser.menus.onClicked.addListener((info, tab) => {
      browser.test.sendMessage("clicked", [info, tab]);
    });
    if (browser.mailTabs.onSelectedMessagesChanged) {
      browser.mailTabs.onSelectedMessagesChanged.addListener((tab, list) => {
        events.push(["selected", tab, list]);
        if (
          list.messages.length == 1 &&
          list.messages[0].id == watchedSelection
        ) {
          browser.test.sendMessage("selected", [tab, list]);
        }
      });
    }
    await new Promise(resolve =>
      browser.menus.create(
        {
          id: "search-tab",
          title: "Extension101 tab",
          contexts: ["tab"],
        },
        resolve
      )
    );
    await new Promise(resolve =>
      browser.menus.create(
        {
          id: "search-message",
          title: "Extension101 message",
          contexts: ["message_list"],
        },
        resolve
      )
    );
    browser.test.onMessage.addListener(async (command, id) => {
      if (command == "watch-selection") {
        watchedSelection = id;
        browser.test.sendMessage("watching");
      } else if (command == "state") {
        browser.test.sendMessage("state", {
          events,
          tabs: await browser.tabs.query({}),
          selected: await browser.mailTabs.getSelectedMessages(id),
          listed: await browser.mailTabs.getListedMessages(id),
        });
      } else if (command == "activate") {
        await browser.tabs.update(id, { active: true });
        browser.test.sendMessage("activated");
      } else if (command == "remove") {
        await browser.tabs.remove(id);
      }
    });
    browser.test.sendMessage("ready");
  };
  extension = ExtensionTestUtils.loadExtension({
    background,
    manifest: {
      manifest_version: manifestVersion,
      permissions: ["tabs", "menus", "accountsRead", "messagesRead"],
    },
  });
  await extension.startup();
  await extension.awaitMessage("ready");
  const facet = tabmail.openTab("glodaFacet", { mailSearch: { text: term } });
  const facetAPI = await extension.awaitMessage("created");
  Assert.equal(facetAPI.type, "special", "Real global results are special");
  await TestUtils.waitForCondition(() => facet.searchPromise);
  await facet.searchPromise;
  const context = facet.browser.contentWindow.FacetContext;
  Assert.deepEqual(
    context.fullSet
      .map(item =>
        physical(getMailSearchHeader(service.resolveDocument(item.id)))
      )
      .sort(),
    expectedPhysical,
    "The actual global search retains all three physical matches"
  );
  const menu = document.getElementById("tabContextMenu");
  await openMenuPopup(menu, facet.tabNode, { type: "contextmenu" });
  const [facetInfo, shownFacet] = await extension.awaitMessage("shown");
  Assert.equal(shownFacet.id, facetAPI.id);
  Assert.equal(shownFacet.type, "special");
  Assert.deepEqual(facetInfo.menuIds, ["search-tab"]);
  const item = [...menu.querySelectorAll("menuitem")].find(
    node => node.label == "Extension101 tab"
  );
  Assert.ok(item, "The real tab menu includes the extension action");
  const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.activateItem(item);
  await hidden;
  const [clickedInfo, clickedTab] = await extension.awaitMessage("clicked");
  Assert.equal(clickedInfo.menuItemId, "search-tab");
  Assert.equal(clickedTab.id, facetAPI.id);

  const list = await context.showActiveSetInTab();
  const listAPI = await extension.awaitMessage("created");
  Assert.equal(listAPI.type, "mail", "A real synthetic results list is mail");
  await TestUtils.waitForCondition(() => {
    const pane = list.chromeBrowser?.contentWindow;
    return (
      pane?.gViewWrapper?.isSynthetic &&
      pane.dbViewWrapperListener.allMessagesLoaded
    );
  });
  const pane = list.chromeBrowser.contentWindow;
  const index = pane.gDBView.findIndexOfMsgHdr(selected, true);
  Assert.notEqual(index, 0xffffffff);
  pane.threadTree.selectedIndices = [];
  extension.sendMessage(
    "watch-selection",
    WebExtensionPolicy.getByID(extension.id).extension.messageManager.convert(
      selected
    ).id
  );
  await extension.awaitMessage("watching");
  pane.threadTree.selectedIndex = index;
  const [selectedTab, selectedList] = await extension.awaitMessage("selected");
  Assert.equal(selectedTab.id ?? selectedTab.tabId, listAPI.id);
  const resolvePhysical = apiMessages =>
    apiMessages.map(apiMessage =>
      physical(
        WebExtensionPolicy.getByID(extension.id).extension.messageManager.get(
          apiMessage.id
        )
      )
    );
  Assert.deepEqual(resolvePhysical(selectedList.messages), [
    physical(selected),
  ]);
  extension.sendMessage("state", listAPI.id);
  const state = await extension.awaitMessage("state");
  Assert.deepEqual(resolvePhysical(state.selected.messages), [
    physical(selected),
  ]);
  Assert.deepEqual(
    resolvePhysical(state.listed.messages).sort(),
    expectedPhysical
  );
  Assert.equal(state.listed.id, null);
  Assert.equal(
    state.tabs.length,
    3,
    "Only origin, global results and list exist"
  );
  Assert.ok(
    state.events.some(
      event => event[0] == "activated" && event[1].tabId == listAPI.id
    )
  );
  Assert.ok(
    state.events.some(
      event =>
        event[0] == "updated" &&
        event[1] == listAPI.id &&
        event[2].status == "complete"
    )
  );
  const messageMenu = pane.document.getElementById("mailContext");
  await openMenuPopup(messageMenu, pane.threadTree.getRowAtIndex(index), {
    type: "contextmenu",
  });
  const [messageInfo, messageTab] = await extension.awaitMessage("shown");
  Assert.equal(messageTab.id, listAPI.id);
  Assert.deepEqual(messageInfo.menuIds, ["search-message"]);
  Assert.deepEqual(resolvePhysical(messageInfo.selectedMessages.messages), [
    physical(selected),
  ]);
  Assert.ok(
    !messageInfo.displayedFolder,
    "A synthetic list has no physical displayed folder"
  );
  await closeMenuPopup(messageMenu);
  const denied = ExtensionTestUtils.loadExtension({
    background: async () => {
      browser.menus.onShown.addListener((info, tab) => {
        browser.test.assertFalse(
          "selectedMessages" in info,
          "No physical messages without messagesRead"
        );
        browser.test.assertFalse(
          "displayedFolder" in info,
          "No folder without accountsRead"
        );
        browser.test.assertEq("mail", tab.type);
        browser.test.sendMessage("redacted");
      });
      await browser.menus.create({
        id: "redacted",
        title: "Extension101 redacted",
        contexts: ["message_list"],
      });
      browser.test.sendMessage("ready");
    },
    manifest: { manifest_version: manifestVersion, permissions: ["menus"] },
  });
  await denied.startup();
  await denied.awaitMessage("ready");
  await openMenuPopup(messageMenu, pane.threadTree.getRowAtIndex(index), {
    type: "contextmenu",
  });
  await denied.awaitMessage("redacted");
  await extension.awaitMessage("shown");
  await closeMenuPopup(messageMenu);
  await denied.unload();
  extension.sendMessage("activate", facetAPI.id);
  await extension.awaitMessage("activated");
  Assert.equal(tabmail.currentTabInfo, facet);
  extension.sendMessage("activate", listAPI.id);
  await extension.awaitMessage("activated");
  Assert.equal(tabmail.currentTabInfo, list);
  extension.sendMessage("remove", listAPI.id);
  Assert.equal(await extension.awaitMessage("removed"), listAPI.id);
  extension.sendMessage("remove", facetAPI.id);
  Assert.equal(await extension.awaitMessage("removed"), facetAPI.id);
  Assert.equal(tabmail.tabInfo.length, 1);
  await extension.unload();
  extension = null;
  await closeMailSearch();
  for (const folder of folders) {
    folder.parent.propagateDelete(folder, true);
    Assert.ok(!folder.parent, "Only each owned fixture folder was removed");
  }
  await SpecialPowers.popPrefEnv();
}

add_task(async function test_globalResultsMv2() {
  await checkGlobalResults(2);
});

add_task(async function test_globalResultsMv3() {
  await checkGlobalResults(3);
});
