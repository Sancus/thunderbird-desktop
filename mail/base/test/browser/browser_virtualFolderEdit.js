/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests the selection of a virtual folder's searched folders.
 */

var { VirtualFolderHelper } = ChromeUtils.importESModule(
  "resource:///modules/VirtualFolderWrapper.sys.mjs"
);

const about3Pane = document.getElementById("tabmail").currentAbout3Pane;
const context = about3Pane.document.getElementById("folderPaneContext");

let rootFolder, wrappedVirtual, virtualFolder, first, second, third, fourth;

add_setup(async function setup_savedSearchFolders() {
  const localAccount = MailServices.accounts.createLocalMailAccount();
  rootFolder = localAccount.incomingServer.rootFolder;
  rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);

  first = rootFolder.createLocalSubfolder("first");
  second = rootFolder.createLocalSubfolder("second");
  third = rootFolder.createLocalSubfolder("third");
  third.QueryInterface(Ci.nsIMsgLocalMailFolder);
  fourth = third.createLocalSubfolder("fourth");

  wrappedVirtual = VirtualFolderHelper.createNewVirtualFolder(
    "virtual",
    rootFolder,
    [first, second],
    "ALL",
    false
  );
  virtualFolder = wrappedVirtual.virtualFolder;

  const pop3Account = MailServices.accounts.createAccount();
  pop3Account.incomingServer = MailServices.accounts.createIncomingServer(
    "nobody",
    "localhost",
    "pop3"
  );

  registerCleanupFunction(() => {
    MailServices.accounts.removeAccount(localAccount, false);
    MailServices.accounts.removeAccount(pop3Account, false);
  });
});

add_task(async function test_editSearchedFolders() {
  const virtualPropsPromise = BrowserTestUtils.promiseAlertDialog(
    undefined,
    "chrome://messenger/content/virtualFolderProperties.xhtml",
    {
      async callback(win) {
        await SimpleTest.promiseFocus(win);

        const doc = win.document;
        const chosenFoldersCount = doc.getElementById("chosenFoldersCount");
        const folderListButton = doc.getElementById("folderListPicker");
        const acceptButton = doc.querySelector("dialog").getButton("accept");

        if (doc.hasPendingL10nMutations) {
          await BrowserTestUtils.waitForEvent(doc, "L10nMutationsFinished");
        }

        Assert.equal(chosenFoldersCount.textContent, "2 folders chosen");

        // Open the folder selection dialog.
        folderListButton.click();
        await folderSelectionPromise;
        await SimpleTest.promiseFocus(win);

        Assert.equal(chosenFoldersCount.textContent, "3 folders chosen");

        acceptButton.click();
      },
    }
  );
  const folderSelectionPromise = BrowserTestUtils.promiseAlertDialog(
    undefined,
    "chrome://messenger/content/virtualFolderListEdit.xhtml",
    {
      async callback(win) {
        await SimpleTest.promiseFocus(win);
        await new Promise(resolve => win.requestAnimationFrame(resolve));

        const doc = win.document;
        const tree = doc.getElementById("folderPickerTree");
        const acceptButton = doc.querySelector("dialog").getButton("accept");

        // Check the initial state.
        Assert.equal(tree.view.rowCount, 7);
        Assert.ok(
          !tree.view.isContainerOpen(0),
          "pop3 root folder should not be open"
        );
        Assert.ok(
          tree.view.isContainerOpen(1),
          "local root folder should be open"
        );
        Assert.ok(
          !tree.view.isContainerOpen(6),
          "unselected folder should not be open"
        );
        tree.view.toggleOpenState(6); // Open "third" folder.
        Assert.equal(tree.view.rowCount, 8);
        await new Promise(resolve => win.requestAnimationFrame(resolve));

        Assert.equal(tree.view.getCellText(0, "name"), "nobody on localhost");
        Assert.equal(tree.view.getCellText(1, "name"), "Local Folders");
        Assert.equal(tree.view.getCellText(2, "name"), "Trash");
        Assert.equal(tree.view.getCellText(3, "name"), "Outbox");
        Assert.equal(tree.view.getCellText(4, "name"), "first");
        Assert.equal(tree.view.getCellText(5, "name"), "second");
        Assert.equal(tree.view.getCellText(6, "name"), "third");
        Assert.equal(tree.view.getCellText(7, "name"), "fourth");

        // Check the initial selection.
        const isSelected = index =>
          tree.view.rowAt(index).hasProperty("checked") &&
          tree.getRowAtIndex(index).querySelector("input").checked;
        Assert.ok(!isSelected(0));
        Assert.ok(!isSelected(1));
        Assert.ok(!isSelected(2));
        Assert.ok(!isSelected(3));
        Assert.ok(isSelected(4));
        Assert.ok(isSelected(5));
        Assert.ok(!isSelected(6));
        Assert.ok(!isSelected(7));

        // Change the selection by clicking on a check box.
        await BrowserTestUtils.waitForMutationCondition(
          tree.table.body,
          { subtree: true, childList: true },
          () => tree.table.body.rows[4].querySelector('input[type="checkbox"]')
        );
        EventUtils.synthesizeMouseAtCenter(
          tree.table.body.rows[4].querySelector('input[type="checkbox"]'),
          {},
          win
        );
        // ... and using the keyboard.
        tree.table.body.rows[6].querySelector('input[type="checkbox"]').focus();
        EventUtils.synthesizeKey(" ", {}, win);
        EventUtils.synthesizeKey("KEY_Tab", {}, win);
        EventUtils.synthesizeKey(" ", {}, win);

        // Check the changed selection.
        Assert.ok(!isSelected(0));
        Assert.ok(!isSelected(1));
        Assert.ok(!isSelected(2));
        Assert.ok(!isSelected(3));
        Assert.ok(!isSelected(4));
        Assert.ok(isSelected(5));
        Assert.ok(isSelected(6));
        Assert.ok(isSelected(7));

        acceptButton.click();
      },
    }
  );

  // Check the state before we begin.
  Assert.equal(wrappedVirtual.searchString, `ALL`);
  Assert.equal(wrappedVirtual.searchFolderURIs, `${first.URI}|${second.URI}`);

  // Open the virtual folder properties dialog.
  EventUtils.synthesizeMouseAtCenter(
    about3Pane.folderPane.getRowForFolder(virtualFolder).querySelector(".name"),
    { type: "contextmenu" },
    about3Pane
  );
  await BrowserTestUtils.waitForPopupEvent(context, "shown");
  context.activateItem(
    about3Pane.document.getElementById("folderPaneContext-properties")
  );
  await BrowserTestUtils.waitForPopupEvent(context, "hidden");
  await virtualPropsPromise;

  // Check the state after we finish.
  Assert.equal(wrappedVirtual.searchString, `ALL`);
  Assert.equal(
    wrappedVirtual.searchFolderURIs,
    `${second.URI}|${third.URI}|${fourth.URI}`
  );
});

/**
 * Tests that the "Search online" checkbox in virtual folder properties
 * remembers its state across dialog opens (bug 2053894).
 */
add_task(async function test_searchOnline() {
  // Create an IMAP account. IMAP servers have offlineSupportLevel > 0, which
  // enables the "Search online" checkbox.
  const imapServer = MailServices.accounts
    .createIncomingServer("nobody", "imap.example.com", "imap")
    .QueryInterface(Ci.nsIImapIncomingServer);
  const imapAccount = MailServices.accounts.createAccount();
  imapAccount.incomingServer = imapServer;
  const imapIdentity = MailServices.accounts.createIdentity();
  imapIdentity.email = "tinderbox@example.com";
  imapAccount.addIdentity(imapIdentity);

  const imapRootFolder = imapServer.rootFolder;

  registerCleanupFunction(() => {
    MailServices.accounts.removeAccount(imapAccount, false);
  });

  // Create a virtual folder that searches the IMAP root folder, with online
  // search initially enabled.
  const onlineWrapped = VirtualFolderHelper.createNewVirtualFolder(
    "onlineTest",
    rootFolder,
    [imapRootFolder],
    "ALL",
    true
  );
  const onlineVF = onlineWrapped.virtualFolder;

  // Helper: open the properties dialog via context menu.
  async function openPropertiesViaContextMenu(winCallback) {
    const virtualPropsPromise = BrowserTestUtils.promiseAlertDialog(
      undefined,
      "chrome://messenger/content/virtualFolderProperties.xhtml",
      { callback: winCallback }
    );

    EventUtils.synthesizeMouseAtCenter(
      about3Pane.folderPane.getRowForFolder(onlineVF).querySelector(".name"),
      { type: "contextmenu" },
      about3Pane
    );
    await BrowserTestUtils.waitForPopupEvent(context, "shown");
    context.activateItem(
      about3Pane.document.getElementById("folderPaneContext-properties")
    );
    await BrowserTestUtils.waitForPopupEvent(context, "hidden");
    await virtualPropsPromise;
  }

  // First open: checkbox should be enabled and checked.
  await openPropertiesViaContextMenu(async win => {
    await SimpleTest.promiseFocus(win);
    const doc = win.document;
    if (doc.hasPendingL10nMutations) {
      await BrowserTestUtils.waitForEvent(doc, "L10nMutationsFinished");
    }

    const checkbox = doc.getElementById("searchOnline");
    Assert.ok(
      !checkbox.disabled,
      "Search online should be enabled for IMAP search folders"
    );
    Assert.ok(
      checkbox.checked,
      "Search online should be checked when onlineSearch was set to true at creation"
    );

    doc.querySelector("dialog").getButton("accept").click();
  });

  // Second open: the checkbox should still be enabled and checked — it must not
  // have been reset by updateOnlineSearchState().
  await openPropertiesViaContextMenu(async win => {
    await SimpleTest.promiseFocus(win);
    const doc = win.document;
    if (doc.hasPendingL10nMutations) {
      await BrowserTestUtils.waitForEvent(doc, "L10nMutationsFinished");
    }

    const checkbox = doc.getElementById("searchOnline");
    Assert.ok(
      !checkbox.disabled,
      "Search online should still be enabled after reopening"
    );
    Assert.ok(
      checkbox.checked,
      "Search online should still be checked after reopening"
    );

    doc.querySelector("dialog").getButton("cancel").click();
  });
});

/**
 * Stores a real local message for retained edit/selection controls.
 *
 * @param {nsIMsgFolder} folder - Physical destination.
 * @param {string} id - Literal Message-ID without brackets.
 * @returns {nsIMsgDBHdr} The actual stored header.
 */
function addEditMessage(folder, id) {
  const contract = Services.prefs.getCharPref(
    "mail.server.default.storeContractID"
  );
  Assert.equal(
    folder.server.msgStore.storeType,
    contract.includes("maildirstore") ? "maildir" : "mbox",
    "Actual local store"
  );
  return folder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .addMessage(
      "From: edit@example.invalid\r\nTo: reader@example.invalid\r\n" +
        "Date: Tue, 1 Sep 2026 12:00:00 +0000\r\n" +
        `Message-ID: <${id}>\r\nSubject: scope-edit\r\n\r\nStored body.\r\n`
    );
}

add_task(async function test_scopeEditPreservesPhysicalSelectionAndGrouping() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    info(
      "Native physical scope controls; original dialog cases retain Mork coverage"
    );
    return;
  }
  Assert.ok(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(Ci.nsIDatabaseCore)
  );
  const a = rootFolder.createLocalSubfolder("edit-a");
  const b = rootFolder.createLocalSubfolder("edit-b");
  const c = rootFolder.createLocalSubfolder("edit-c");
  const removed = addEditMessage(a, "same-edit-id@example.invalid");
  const retained = addEditMessage(b, "same-edit-id@example.invalid");
  const copy = addEditMessage(c, "same-edit-id@example.invalid");
  const saved = VirtualFolderHelper.createNewVirtualFolder(
    "retained-edit",
    rootFolder,
    [a, b],
    "AND (subject,contains,scope-edit)",
    false
  ).virtualFolder;
  const oldMessagePane = about3Pane.paneLayout.messagePaneVisible;
  about3Pane.paneLayout.messagePaneVisible = false;
  try {
    about3Pane.displayFolder(saved.URI);
    await TestUtils.waitForCondition(
      () =>
        about3Pane.gViewWrapper.displayedFolder == saved &&
        !about3Pane.gViewWrapper.searching &&
        about3Pane.gDBView?.numMsgsInView == 2,
      "The original real saved-search view is loaded"
    );
    const wrapper = about3Pane.gViewWrapper;
    wrapper.beginViewUpdate();
    wrapper.sort("subjectCol", Ci.nsMsgViewSortOrder.ascending);
    wrapper.showGroupedBySort = true;
    wrapper.endViewUpdate();
    await TestUtils.waitForCondition(
      () => !wrapper.searching && wrapper.dbView?.rowCount > 0
    );
    wrapper.dbView.doCommand(Ci.nsMsgViewCommandType.expandAll);
    const view = wrapper.dbView;
    const keepIndex = view.findIndexOfMsgHdr(retained, true);
    const dropIndex = view.findIndexOfMsgHdr(removed, true);
    Assert.notEqual(keepIndex, 0xffffffff);
    Assert.notEqual(dropIndex, 0xffffffff);
    view.selection.rangedSelect(dropIndex, dropIndex, false);
    view.selection.rangedSelect(keepIndex, keepIndex, true);
    view.selection.currentIndex = keepIndex;
    const flags = view.viewFlags;
    const props = BrowserTestUtils.promiseAlertDialog(
      undefined,
      "chrome://messenger/content/virtualFolderProperties.xhtml",
      {
        async callback(win) {
          await SimpleTest.promiseFocus(win);
          // The existing picker callback feeds the real retained accept handler.
          win.onFolderListDialogCallback(`${b.URI}|${c.URI}`);
          win.document.querySelector("dialog").getButton("accept").click();
        },
      }
    );
    window.openDialog(
      "chrome://messenger/content/virtualFolderProperties.xhtml",
      "",
      "chrome,titlebar,modal,centerscreen",
      {
        folder: saved,
        editExistingFolder: true,
        onOKCallback() {
          wrapper.open(saved);
        },
      }
    );
    await props;
    await TestUtils.waitForCondition(
      () => !wrapper.searching && wrapper.dbView != view,
      "The real properties accept rebuilt the retained view"
    );
    Assert.ok(
      wrapper.showGroupedBySort,
      "Grouping survives the scope edit and reopen"
    );
    Assert.equal(wrapper.dbView.viewFlags, flags);
    Assert.equal(wrapper.primarySortColumnId, "subjectCol");
    const identity = header => [header.folder.URI, header.messageKey];
    Assert.deepEqual(
      wrapper.dbView.getSelectedMsgHdrs().map(identity),
      [identity(retained)],
      "Only the surviving physical selection is restored"
    );
    Assert.deepEqual(
      identity(
        wrapper.dbView.getMsgHdrAt(wrapper.dbView.selection.currentIndex)
      ),
      identity(retained),
      "The current physical header survives"
    );
    Assert.notEqual(
      retained.messageKey,
      copy.messageKey,
      "Equal Message-ID copies remain distinct"
    );
    Assert.equal(wrapper.dbView.findIndexOfMsgHdr(removed, false), 0xffffffff);
    Assert.notEqual(wrapper.dbView.findIndexOfMsgHdr(copy, true), 0xffffffff);
  } finally {
    about3Pane.displayFolder(first.URI);
    about3Pane.paneLayout.messagePaneVisible = oldMessagePane;
    saved.parent.propagateDelete(saved, true);
  }
});

add_task(async function test_scopeEditErrorsAreNotSuccessfulReopen() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    return;
  }
  const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  );
  const source = rootFolder.createLocalSubfolder("edit-errors");
  const header = addEditMessage(source, "error-edit@example.invalid");
  const saved = VirtualFolderHelper.createNewVirtualFolder(
    "retained-edit-error",
    rootFolder,
    [source],
    "AND (subject,contains,scope-edit)",
    false
  ).virtualFolder;
  const connection = core.connectionForTests;
  let unavailable = false;
  try {
    about3Pane.displayFolder(saved.URI);
    await TestUtils.waitForCondition(
      () =>
        !about3Pane.gViewWrapper.searching &&
        about3Pane.gViewWrapper.displayedFolder == saved &&
        about3Pane.gDBView?.rowCount == 1
    );
    const wrapper = about3Pane.gViewWrapper;
    const oldView = wrapper.dbView;
    let accepted = false;
    const props = BrowserTestUtils.promiseAlertDialog(
      undefined,
      "chrome://messenger/content/virtualFolderProperties.xhtml",
      {
        async callback(win) {
          await SimpleTest.promiseFocus(win);
          connection.executeSimpleSQL(
            "ALTER TABLE folder_properties RENAME TO s371_unavailable_properties"
          );
          unavailable = true;
          try {
            Assert.throws(
              () => wrapper.open(saved),
              error => error.result == Cr.NS_ERROR_FAILURE,
              "Reopen returns the actual native definition read error"
            );
            Assert.equal(
              wrapper.dbView,
              oldView,
              "Preflight failure preserves the usable old view"
            );
            Assert.equal(
              wrapper.dbView.getMsgHdrAt(0).messageKey,
              header.messageKey
            );
            const failed = new Promise(resolve => {
              win.addEventListener(
                "error",
                event => {
                  event.preventDefault();
                  resolve(event.error);
                },
                { once: true }
              );
            });
            win.document.querySelector("dialog").getButton("accept").click();
            const error = await failed;
            Assert.equal(
              error.result,
              Cr.NS_ERROR_FAILURE,
              "The accept handler exposes its original write error"
            );
            Assert.ok(
              !win.closed,
              "A failed native write cannot accept/close the real dialog"
            );
            Assert.ok(!accepted, "The success callback did not run");
          } finally {
            connection.executeSimpleSQL(
              "ALTER TABLE s371_unavailable_properties RENAME TO folder_properties"
            );
            unavailable = false;
          }
          win.document.querySelector("dialog").getButton("accept").click();
        },
      }
    );
    window.openDialog(
      "chrome://messenger/content/virtualFolderProperties.xhtml",
      "",
      "chrome,titlebar,modal,centerscreen",
      {
        folder: saved,
        editExistingFolder: true,
        onOKCallback() {
          accepted = true;
          wrapper.open(saved);
        },
      }
    );
    await props;
    Assert.ok(
      accepted,
      "The ordinary edit succeeds after restoring the real producer"
    );
    await TestUtils.waitForCondition(
      () => !wrapper.searching && wrapper.dbView?.rowCount == 1
    );
  } finally {
    if (unavailable) {
      connection.executeSimpleSQL(
        "ALTER TABLE s371_unavailable_properties RENAME TO folder_properties"
      );
    }
    about3Pane.displayFolder(first.URI);
    saved.parent.propagateDelete(saved, true);
  }
});
