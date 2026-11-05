/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const PREF_SHOW_AS_LIST = "gloda.show_as_list_by_default";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["mailnews.mark_message_read.auto", false]],
  });
});

registerCleanupFunction(function () {
  const tabmail = document.getElementById("tabmail");
  while (tabmail.tabInfo.length > 1) {
    tabmail.closeTab(1);
  }
});

/**
 * Create real local search members, including two physical copies with one ID.
 *
 * @param {string} term - Literal subject term unique to this fixture.
 * @param {number} count - Number of messages in the first physical folder.
 * @returns {Promise<object>} Folders, independent expected identities and service.
 */
async function makeMailSearchFixture(term, count) {
  const { MailServices } = ChromeUtils.importESModule(
    "resource:///modules/MailServices.sys.mjs"
  );
  const { MessageGenerator } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
  );
  const { getMailSearchService, closeMailSearch } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearch.sys.mjs"
  );
  const root =
    MailServices.accounts.localFoldersServer.rootFolder.QueryInterface(
      Ci.nsIMsgLocalMailFolder
    );
  const folders = [];
  const tabmail = document.getElementById("tabmail");
  registerCleanupFunction(async () => {
    while (tabmail.tabInfo.length > 1) {
      tabmail.closeTab(1);
    }
    await closeMailSearch();
    for (const folder of folders) {
      folder.parent.propagateDelete(folder, true);
    }
  });
  for (const suffix of ["First", "Second", "Excluded"]) {
    folders.push(
      root
        .createLocalSubfolder(term + suffix)
        .QueryInterface(Ci.nsIMsgLocalMailFolder)
    );
  }
  const [first, second, excluded] = folders;
  const generator = new MessageGenerator();
  const headers = [];
  let copiedMessage;
  for (let i = 0; i < count; i++) {
    const raw = generator
      .makeMessage({
        subject: term,
        from: ["Search Sender", `${term}@example.invalid`],
      })
      .toMessageString();
    copiedMessage ??= raw;
    headers.push(first.addMessage(raw));
  }
  const duplicate = second.addMessage(copiedMessage);
  headers.push(duplicate);
  excluded.addMessage(
    generator.makeMessage({ subject: "unrelated" }).toMessageString()
  );
  first.addKeywordsToMessages([headers[0]], "$label1");
  second.addKeywordsToMessages([duplicate], "$label1");
  const expected = headers.map(header => ({
    folderURI: header.folder.URI,
    key: header.messageKey,
    messageId: header.messageId,
  }));
  const { GlodaMsgIndexer } = ChromeUtils.importESModule(
    "resource:///modules/gloda/IndexMsg.sys.mjs"
  );
  const { waitForGlodaDBFlush } = ChromeUtils.importESModule(
    "resource://testing-common/gloda/GlodaTestHelperFunctions.sys.mjs"
  );
  await Promise.all(
    folders.map(
      folder =>
        new Promise((resolve, reject) => {
          const queued = GlodaMsgIndexer.indexFolder(folder, {
            callback(success) {
              if (!success) {
                reject(new Error("Fixture Gloda indexing did not complete"));
                return;
              }
              resolve();
            },
          });
          if (!queued) {
            reject(new Error("Fixture Gloda indexing was not queued"));
          }
        })
    )
  );
  // A completed indexing job may leave its transaction waiting for user idle.
  // Use the existing real commit barrier before snapshotting native metadata.
  await waitForGlodaDBFlush();
  const service = await getMailSearchService();
  let progress;
  do {
    progress = await service.update({ limit: 500 });
  } while (progress.moreWork);
  return { first, second, excluded, expected, service };
}

/**
 * Wait for the existing synthetic mail tab and return its actual view headers.
 *
 * @param {object} tab - The mail3PaneTab opened by the default search factory.
 * @returns {Promise<object[]>} Physical folder/key/Message-ID identities.
 */
async function readMailSearchList(tab) {
  await TestUtils.waitForCondition(() => {
    const about3Pane = tab.chromeBrowser?.contentWindow;
    return (
      about3Pane?.gViewWrapper?.isSynthetic &&
      about3Pane.dbViewWrapperListener.allMessagesLoaded &&
      about3Pane.gDBView
    );
  }, "Replacement search completes in the existing mail list");
  const view = tab.chromeBrowser.contentWindow.gDBView;
  return Array.from({ length: view.rowCount }, (_, index) => {
    const header = view.getMsgHdrAt(index);
    return {
      folderURI: header.folder.URI,
      key: header.messageKey,
      messageId: header.messageId,
    };
  });
}

/**
 * Create independently identified native conversation members using mail ingest.
 *
 * @param {string} name - Unique physical fixture prefix.
 * @returns {object} Stored headers, literal expected members and cleanup.
 */
function makeConversationCommandFixture(name) {
  const { MailServices } = ChromeUtils.importESModule(
    "resource:///modules/MailServices.sys.mjs"
  );
  const { MessageGenerator } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
  );
  const root =
    MailServices.accounts.localFoldersServer.rootFolder.QueryInterface(
      Ci.nsIMsgLocalMailFolder
    );
  const folders = ["First", "Second", "Outside"].map(suffix =>
    root
      .createLocalSubfolder(name + suffix)
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
  );
  const generator = new MessageGenerator();
  const parent = generator.makeMessage({ subject: name });
  parent.messageId = `${name}-parent@example.invalid`;
  const reply = generator.makeMessage({ inReplyTo: parent });
  reply.messageId = `${name}-reply@example.invalid`;
  const unrelated = generator.makeMessage({ subject: name });
  unrelated.messageId = `${name}-unrelated@example.invalid`;
  const a = folders[0].addMessage(parent.toMessageString());
  const b = folders[0].addMessage(reply.toMessageString());
  const selected = folders[1].addMessage(parent.toMessageString());
  const excluded = folders[2].addMessage(unrelated.toMessageString());
  const physical = header => ({
    folderURI: header.folder.URI,
    key: header.messageKey,
    messageId: header.messageId,
  });
  const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  );
  Assert.ok(core, "The real installed native backend supplies this command");
  info(
    "Native conversation ingress " +
      JSON.stringify(
        [a, b, selected, excluded].map(header => ({
          key: header.messageKey,
          folderId: header.folder.id,
          messageId: header.messageId,
          threadId: header.threadId,
          threadParent: header.threadParent,
          references: Array.from({ length: header.numReferences }, (_, index) =>
            header.getStringReference(index)
          ),
        }))
      )
  );
  Assert.equal(
    b.numReferences,
    1,
    "The stored reply retains its real parent reference"
  );
  Assert.equal(
    b.getStringReference(0),
    a.messageId,
    "The ordinary native ingress preserved the generated parent Message-ID"
  );
  return {
    selected,
    excluded,
    folders,
    expected: [a, b, selected].map(physical),
    physical,
    async close() {
      const tabmail = document.getElementById("tabmail");
      while (tabmail.tabInfo.length > 1) {
        tabmail.closeTab(1);
      }
      const { closeMailSearch } = ChromeUtils.importESModule(
        "resource:///modules/panorama/MailSearch.sys.mjs"
      );
      await closeMailSearch();
      for (const folder of folders) {
        folder.parent.propagateDelete(folder, true);
      }
    },
  };
}

/**
 * Change the selected physical member after a real conversation snapshot.
 *
 * @param {"move"|"delete"} action - The operation on the captured copy.
 */
async function checkStaleConversationSelection(action) {
  const { ConversationOpener } = ChromeUtils.importESModule(
    "resource:///modules/ConversationOpener.sys.mjs"
  );
  const { MailSearchService } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearchService.sys.mjs"
  );
  const { MailServices } = ChromeUtils.importESModule(
    "resource:///modules/MailServices.sys.mjs"
  );
  const { PromiseTestUtils: MailPromiseTestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
  );
  const { sinon } = ChromeUtils.importESModule(
    "resource://testing-common/Sinon.sys.mjs"
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["mailnews.database.global.indexer.enabled", true],
      ["mailnews.default_view_flags", 0],
    ],
  });
  const fixture = makeConversationCommandFixture(`nativeconversation${action}`);
  const tabmail = document.getElementById("tabmail");
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const original = MailSearchService.prototype.getConversationForHeader;
  const stub = sinon
    .stub(MailSearchService.prototype, "getConversationForHeader")
    .callsFake(async function (header, options) {
      const snapshot = await original.call(this, header, options);
      Assert.equal(snapshot.status, "ready");
      Assert.equal(snapshot.items.length, 3);
      entered.resolve();
      await release.promise;
      return snapshot;
    });
  let opening;
  try {
    const origin = tabmail.openTab("mail3PaneTab", {
      folderURI: fixture.folders[0].URI,
    });
    await TestUtils.waitForCondition(
      () => origin.chromeBrowser.contentWindow?.gDBView?.rowCount == 2,
      "The independent origin folder has both stored messages"
    );
    const pane = origin.chromeBrowser.contentWindow;
    pane.selectMessage(
      fixture.folders[0].msgDatabase.getMsgHdrForKey(fixture.expected[0].key)
    );
    await TestUtils.waitForCondition(
      () => pane.gDBView.numSelected == 1,
      "The original physical selection is installed"
    );
    const view = pane.gDBView;
    const capture = () => ({
      folderURI: pane.gViewWrapper.displayedFolder.URI,
      selected: view.getSelectedMsgHdrs().map(fixture.physical),
      current: view.selection.currentIndex,
      pivot: view.selection.shiftSelectPivot,
    });
    const before = capture();
    const tabsBefore = [...tabmail.tabInfo];
    const selectedKey = fixture.selected.messageKey;
    opening = new ConversationOpener(pane).openConversationForMessages([
      fixture.selected,
    ]);
    opening.catch(entered.reject);
    await entered.promise;
    if (action == "move") {
      const listener = new MailPromiseTestUtils.PromiseCopyListener();
      MailServices.copy.copyMessages(
        fixture.folders[1],
        [fixture.selected],
        fixture.folders[2],
        true,
        listener,
        null,
        false
      );
      await listener.promise;
    } else {
      fixture.folders[1].deleteMessages(
        [fixture.selected],
        null,
        true,
        false,
        null,
        false
      );
    }
    Assert.ok(
      !fixture.folders[1].msgDatabase.containsKey(selectedKey),
      "The captured physical member actually left its original folder"
    );
    Assert.equal(fixture.folders[0].getTotalMessages(false), 2);
    Assert.equal(fixture.folders[1].getTotalMessages(false), 0);
    Assert.equal(
      fixture.folders[2].getTotalMessages(false),
      action == "move" ? 2 : 1
    );
    release.resolve();
    await Assert.rejects(
      opening,
      error =>
        [Cr.NS_ERROR_NOT_AVAILABLE, Cr.NS_ERROR_IN_PROGRESS].includes(
          error.result
        ),
      "Stale membership fails instead of opening a subset or the equal-ID copy"
    );
    Assert.deepEqual(
      tabmail.tabInfo,
      tabsBefore,
      "No stale result tab remains"
    );
    Assert.equal(tabmail.currentTabInfo, origin);
    Assert.deepEqual(
      capture(),
      before,
      "The origin selection/current/pivot remain intact"
    );
  } finally {
    release.resolve();
    stub.restore();
    if (opening) {
      await opening.catch(() => {});
    }
    await fixture.close();
    await SpecialPowers.popPrefEnv();
  }
}
