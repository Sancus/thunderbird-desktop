/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchList.js */

"use strict";

Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchList.js", gTestPath).href,
  this
);

add_task(async function test_openConversationRejectsDeletedSelection() {
  await checkStaleConversationSelection("delete");
});

add_task(async function test_openConversationFromStandaloneWindow() {
  const { ConversationOpener } = ChromeUtils.importESModule(
    "resource:///modules/ConversationOpener.sys.mjs"
  );
  const { MailUtils } = ChromeUtils.importESModule(
    "resource:///modules/MailUtils.sys.mjs"
  );
  const { promise_new_window } = ChromeUtils.importESModule(
    "resource://testing-common/mail/WindowHelpers.sys.mjs"
  );
  const { wait_for_message_display_completion } = ChromeUtils.importESModule(
    "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["mailnews.database.global.indexer.enabled", true],
      ["mailnews.default_view_flags", 0],
    ],
  });
  const fixture = makeConversationCommandFixture("nativeconversationwindow");
  let origin;
  try {
    const opened = promise_new_window("mail:messageWindow");
    MailUtils.openMessageInNewWindow(fixture.selected);
    origin = await opened;
    await wait_for_message_display_completion(origin, true);
    Assert.equal(origin.document.getElementById("tabmail"), null);
    const tabmail = document.getElementById("tabmail");
    const tab = await new ConversationOpener(
      origin
    ).openConversationForMessages([fixture.selected]);
    const actual = await readMailSearchList(tab);
    const order = (left, right) => left.key - right.key;
    Assert.deepEqual(actual.toSorted(order), fixture.expected.toSorted(order));
    const pane = tab.chromeBrowser.contentWindow;
    Assert.deepEqual(
      fixture.physical(pane.gDBView.hdrForFirstSelectedMessage),
      fixture.expected[2],
      "The standalone origin opens the selected physical copy in the existing mail window"
    );
    await BrowserTestUtils.closeWindow(origin);
    origin = null;
    Assert.ok(
      tabmail.tabInfo.includes(tab),
      "Closing the completed origin keeps its result tab"
    );
    Assert.deepEqual(
      fixture.physical(pane.gDBView.hdrForFirstSelectedMessage),
      fixture.expected[2]
    );
    tabmail.closeTab(tab);
  } finally {
    if (origin && !origin.closed) {
      await BrowserTestUtils.closeWindow(origin);
    }
    await fixture.close();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(
  async function test_contextConversationKeepsCurrentPhysicalSelection() {
    const { MailServices } = ChromeUtils.importESModule(
      "resource:///modules/MailServices.sys.mjs"
    );
    const { MessageGenerator } = ChromeUtils.importESModule(
      "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
    );
    const { PromiseTestUtils } = ChromeUtils.importESModule(
      "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
    );
    const { be_in_folder, select_click_row } = ChromeUtils.importESModule(
      "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
    );
    const { getMailSearchService, closeMailSearch } =
      ChromeUtils.importESModule(
        "resource:///modules/panorama/MailSearch.sys.mjs"
      );
    Assert.ok(Services.prefs.getBoolPref("mail.panorama.enabled"));
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    );
    await SpecialPowers.pushPrefEnv({
      set: [
        ["mailnews.database.global.indexer.enabled", true],
        ["mailnews.default_view_flags", 0],
      ],
    });
    const tabmail = document.getElementById("tabmail");
    const origin = tabmail.currentTabInfo;
    const pane = origin.chromeBrowser.contentWindow;
    const menu = pane.document.getElementById("mailContext");
    const folders = [];
    registerCleanupFunction(async () => {
      if (menu.state == "open") {
        const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
        menu.hidePopup();
        await hidden;
      }
      while (tabmail.tabInfo.length > 1) {
        tabmail.closeTab(1);
      }
      await closeMailSearch();
      for (const folder of folders) {
        folder.parent.propagateDelete(folder, true);
      }
      await SpecialPowers.popPrefEnv();
    });
    const localRoot = MailServices.accounts.localFoldersServer.rootFolder;
    for (const [name, flag] of [
      ["Inbox", Ci.nsMsgFolderFlags.Inbox],
      ["Sent", Ci.nsMsgFolderFlags.SentMail],
      ["Archive", Ci.nsMsgFolderFlags.Archive],
    ]) {
      const folder = localRoot
        .createLocalSubfolder("ContextConversation095" + name)
        .QueryInterface(Ci.nsIMsgLocalMailFolder);
      folders.push(folder);
      folder.setFlag(flag);
      Assert.equal(folder.flags & flag, flag);
    }
    const [inbox, sent, archive] = folders;
    const generator = new MessageGenerator();
    const parentMail = generator.makeMessage({
      subject: "Context conversation 095",
    });
    parentMail.messageId = "context095-root@example.invalid";
    const replyMail = generator.makeMessage({ inReplyTo: parentMail });
    replyMail.messageId = "context095-reply@example.invalid";
    const tailMail = generator.makeMessage({ inReplyTo: replyMail });
    tailMail.messageId = "context095-tail@example.invalid";
    const controlMail = generator.makeMessage({ subject: parentMail.subject });
    controlMail.messageId = "context095-control@example.invalid";
    const parent = inbox.addMessage(parentMail.toMessageString());
    const reply = sent.addMessage(replyMail.toMessageString());
    const tail = archive.addMessage(tailMail.toMessageString());
    const control = sent.addMessage(controlMail.toMessageString());
    const physical = header => ({
      folderURI: header.folder.URI,
      key: header.messageKey,
      messageId: header.messageId,
    });
    Assert.equal(reply.getStringReference(0), parent.messageId);
    Assert.equal(
      tail.getStringReference(tail.numReferences - 1),
      reply.messageId
    );
    Assert.equal(control.numReferences, 0);
    Assert.equal(
      new Set([parent, reply, tail, control].map(header => header.messageId))
        .size,
      4,
      "Four distinct literal IDs isolate this reference chain and control"
    );
    Assert.equal(control.mime2DecodedSubject, parent.mime2DecodedSubject);
    const oldLocation = physical(reply);
    const transfers = [];
    const notification = {
      msgsMoveCopyCompleted(isMove, sources, target, messages) {
        if (target.URI == archive.URI) {
          transfers.push({
            isMove,
            sources: sources.map(header => ({
              folderURI: header.folder.URI,
              key: header.messageKey,
            })),
            keys: messages.map(header => header.messageKey),
          });
        }
      },
    };
    const listener = new PromiseTestUtils.PromiseCopyListener();
    MailServices.mfn.addListener(
      notification,
      MailServices.mfn.msgsMoveCopyCompleted
    );
    try {
      MailServices.copy.copyMessages(
        sent,
        [reply],
        archive,
        true,
        listener,
        null,
        false
      );
      await listener.promise;
    } finally {
      MailServices.mfn.removeListener(notification);
    }
    Assert.equal(
      transfers.length,
      1,
      "One completed physical Sent-to-Archive move"
    );
    Assert.equal(transfers[0].isMove, true);
    Assert.deepEqual(transfers[0].sources, [
      { folderURI: oldLocation.folderURI, key: oldLocation.key },
    ]);
    Assert.equal(transfers[0].keys.length, 1);
    const moved = archive.GetMessageHeader(transfers[0].keys[0]);
    Assert.equal(moved.folder.URI, archive.URI);
    Assert.notDeepEqual(physical(moved), oldLocation);
    const expected = [parent, moved, tail].map(physical);
    const service = await getMailSearchService();
    let progress;
    do {
      progress = await service.update({ limit: 500 });
    } while (progress.moreWork);

    /**
     * Opens the actual selected row's menu and checks its complete physical result.
     *
     * @param {nsIMsgDBHdr} selected - The current physical header to click.
     * @param {object[]} members - Independently injected expected header locations.
     */
    async function openFromMenu(selected, members) {
      await be_in_folder(selected.folder);
      const index = Array.from(
        { length: pane.gDBView.rowCount },
        (_, i) => i
      ).find(
        i => pane.gDBView.getMsgHdrAt(i).messageKey == selected.messageKey
      );
      Assert.notEqual(
        index,
        undefined,
        "The current physical row is displayed"
      );
      await select_click_row(index);
      Assert.deepEqual(
        physical(pane.gDBView.hdrForFirstSelectedMessage),
        physical(selected)
      );
      Assert.equal(pane.gDBView.selection.count, 1);
      const row = pane.threadTree.getRowAtIndex(index);
      Assert.ok(row, "The selected row is rendered in the real main window");
      const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
      EventUtils.synthesizeMouseAtCenter(row, { type: "contextmenu" }, pane);
      await shown;
      const openMenu = menu.querySelector("#mailContext-open");
      const submenu = menu.querySelector("#mailContext-openPopup");
      const submenuShown = BrowserTestUtils.waitForPopupEvent(submenu, "shown");
      openMenu.openMenu(true);
      await submenuShown;
      const item = menu.querySelector("#mailContext-openConversation");
      Assert.ok(
        BrowserTestUtils.isVisible(item),
        "Open Conversation is visible"
      );
      Assert.ok(
        !item.disabled,
        "Open Conversation is enabled for the current header"
      );
      Assert.ok(
        pane.commandController.isCommandEnabled("cmd_openConversation")
      );
      Assert.deepEqual(
        physical(pane.gDBView.hdrForFirstSelectedMessage),
        physical(selected)
      );
      const before = [...tabmail.tabInfo];
      const opened = BrowserTestUtils.waitForEvent(
        tabmail.tabContainer,
        "TabOpen"
      );
      const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
      menu.activateItem(item);
      await hidden;
      const {
        detail: { tabInfo: tab },
      } = await opened;
      const actual = await readMailSearchList(tab);
      Assert.equal(tab.mode.name, "mail3PaneTab");
      Assert.deepEqual(
        tabmail.tabInfo.filter(candidate => !before.includes(candidate)),
        [tab],
        "The real menu command opens exactly one result tab"
      );
      Assert.equal(tabmail.currentTabInfo, tab);
      Assert.deepEqual(
        actual.toSorted((a, b) => a.key - b.key),
        members.toSorted((a, b) => a.key - b.key),
        "Exact complete current physical members"
      );
      Assert.ok(
        actual.every(
          member =>
            member.folderURI != oldLocation.folderURI ||
            member.key != oldLocation.key
        ),
        "The old Sent physical location is absent"
      );
      const resultPane = tab.chromeBrowser.contentWindow;
      await TestUtils.waitForCondition(
        () => resultPane.gDBView.numSelected == 1,
        "The actual menu command selects its clicked physical member"
      );
      Assert.deepEqual(
        physical(resultPane.gDBView.hdrForFirstSelectedMessage),
        physical(selected)
      );
      tabmail.closeTab(tab);
      Assert.equal(tabmail.currentTabInfo, origin);
    }

    await openFromMenu(moved, expected);
    await openFromMenu(control, [physical(control)]);
  }
);
