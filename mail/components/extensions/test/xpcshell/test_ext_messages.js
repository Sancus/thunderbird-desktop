/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var { ExtensionTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ExtensionXPCShellUtils.sys.mjs"
);
var { ExtensionsUI } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionsUI.sys.mjs"
);

let account, rootFolder, subFolders;

add_setup(
  {
    skip_if: () => IS_NNTP,
  },
  async function setup() {
    account = await createAccount();
    rootFolder = account.incomingServer.rootFolder;
    subFolders = {
      test3: await createSubfolder(rootFolder, "test3"),
      test4: await createSubfolder(rootFolder, "test4"),
      trash: rootFolder.getChildNamed("Trash"),
    };
    await createMessages(subFolders.trash, 99);
    await createMessages(subFolders.test4, 1);

    // There are a couple of deprecated properties in MV3, which we still want to
    // test in MV2 but also report to the user. By default, tests throw when
    // deprecated properties are used.
    ExtensionTestUtils.failOnSchemaWarnings(false);
    registerCleanupFunction(async () => {
      ExtensionTestUtils.failOnSchemaWarnings(true);
    });
    await new Promise(resolve => executeSoon(resolve));
  }
);

add_task(async function non_canonical_permission_description_mapping() {
  const { msgs } = ExtensionsUI._buildStrings({
    addon: { name: "FakeExtension" },
    permissions: {
      origins: [],
      permissions: ["accountsRead", "messagesMove"],
    },
  });
  equal(2, msgs.length, "Correct amount of descriptions");
  equal(
    "See your mail accounts, their identities and their folders",
    msgs[0],
    "Correct description for accountsRead"
  );
  equal(
    "Copy or move your email messages (including moving them to the trash folder)",
    msgs[1],
    "Correct description for messagesMove"
  );
});

add_task(
  {
    skip_if: () => IS_NNTP,
  },
  async function test_standard_pagination() {
    const files = {
      "background.js": async () => {
        // Test a response of 99 messages at 10 messages per page.
        const [folder] = await window.waitForMessage();
        let page = await browser.messages.list(folder);
        browser.test.assertEq(36, page.id.length);
        browser.test.assertEq(10, page.messages.length);

        const originalPageId = page.id;
        let numPages = 1;
        let numMessages = 10;
        while (page.id) {
          page = await browser.messages.continueList(page.id);
          browser.test.assertTrue(page.messages.length > 0);
          numPages++;
          numMessages += page.messages.length;
          if (numMessages < 99) {
            browser.test.assertEq(originalPageId, page.id);
          } else {
            browser.test.assertEq(null, page.id);
          }
        }
        browser.test.assertEq(10, numPages);
        browser.test.assertEq(99, numMessages);

        browser.test.assertRejects(
          browser.messages.continueList(originalPageId),
          /No message list for id .*\. Have you reached the end of a list\?/
        );

        await window.sendMessage("setPref");

        // Do the same test, but with the default 100 messages per page.
        page = await browser.messages.list(folder);
        browser.test.assertEq(null, page.id);
        browser.test.assertEq(99, page.messages.length);

        browser.test.notifyPass("finished");
      },
      "utils.js": await getUtilsJS(),
    };
    const extension = ExtensionTestUtils.loadExtension({
      files,
      manifest: {
        manifest_version: 2,
        background: { scripts: ["utils.js", "background.js"] },
        permissions: ["accountsRead", "messagesRead"],
      },
    });

    Services.prefs.setIntPref("extensions.webextensions.messagesPerPage", 10);

    await extension.startup();
    extension.sendMessage({ accountId: account.key, path: "/Trash" });

    await extension.awaitMessage("setPref");
    Services.prefs.clearUserPref("extensions.webextensions.messagesPerPage");
    extension.sendMessage();

    await extension.awaitFinish("finished");
    await extension.unload();
  }
);

add_task(
  {
    skip_if: () => IS_NNTP,
  },
  async function test_delete_without_permission() {
    const files = {
      "background.js": async () => {
        const [accountId] = await window.waitForMessage();
        const { folders } = await browser.accounts.get(accountId);
        const testFolder4 = folders.find(f => f.name == "test4");

        const { messages: folder4Messages } =
          await browser.messages.list(testFolder4);

        // Try to delete a message.
        await browser.test.assertThrows(
          () =>
            browser.messages.delete([folder4Messages[0].id], {
              deletePermanently: true,
            }),
          `browser.messages.delete is not a function`,
          "Should reject deleting without proper permission"
        );

        browser.test.notifyPass("finished");
      },
      "utils.js": await getUtilsJS(),
    };
    const extension = ExtensionTestUtils.loadExtension({
      files,
      manifest: {
        manifest_version: 2,
        background: { scripts: ["utils.js", "background.js"] },
        browser_specific_settings: {
          gecko: { id: "messages.delete@mochi.test" },
        },
        permissions: ["accountsRead", "messagesMove", "messagesRead"],
      },
    });

    await extension.startup();
    extension.sendMessage(account.key);
    await extension.awaitFinish("finished");
    await extension.unload();
  }
);

add_task(
  {
    skip_if: () => IS_NNTP,
  },
  async function test_move_and_copy_without_permission() {
    const files = {
      "background.js": async () => {
        const [accountId] = await window.waitForMessage();
        const { folders } = await browser.accounts.get(accountId);
        const testFolder4 = folders.find(f => f.name == "test4");
        const testFolder3 = folders.find(f => f.name == "test3");

        const { messages: folder4Messages } =
          await browser.messages.list(testFolder4);

        // Try to move a message.
        await browser.test.assertRejects(
          browser.messages.move([folder4Messages[0].id], testFolder3),
          `Using messages.move() requires the "accountsRead" and the "messagesMove" permission`,
          "Should reject move without proper permission"
        );

        // Try to copy a message.
        await browser.test.assertRejects(
          browser.messages.copy([folder4Messages[0].id], testFolder3),
          `Using messages.copy() requires the "accountsRead" and the "messagesMove" permission`,
          "Should reject copy without proper permission"
        );

        browser.test.notifyPass("finished");
      },
      "utils.js": await getUtilsJS(),
    };
    const extension = ExtensionTestUtils.loadExtension({
      files,
      manifest: {
        manifest_version: 2,
        background: { scripts: ["utils.js", "background.js"] },
        browser_specific_settings: {
          gecko: { id: "messages.move@mochi.test" },
        },
        permissions: ["messagesRead", "accountsRead"],
      },
    });

    await extension.startup();
    extension.sendMessage(account.key);
    await extension.awaitFinish("finished");
    await extension.unload();
  }
);

// The IMAP fakeserver just can't handle this.
add_task(
  {
    skip_if: () => IS_IMAP || IS_NNTP,
  },
  async function test_archive() {
    const account2 = await createAccount();
    addIdentity(account2);
    const inbox2 = await createSubfolder(
      account2.incomingServer.rootFolder,
      "test"
    );
    await createMessages(inbox2, 15);

    let month = 10;
    for (const message of inbox2.messages) {
      message.date = new Date(2018, month++, 15) * 1000;
    }

    const files = {
      "background.js": async () => {
        const [accountId] = await window.waitForMessage();

        const accountBefore = await browser.accounts.get(accountId);
        browser.test.assertEq(3, accountBefore.folders.length);
        browser.test.assertEq("/test", accountBefore.folders[2].path);

        const messagesBefore = await browser.messages.list(
          accountBefore.folders[2]
        );
        browser.test.assertEq(15, messagesBefore.messages.length);
        await browser.messages.archive([]);
        browser.test.assertEq(
          15,
          (await browser.messages.list(accountBefore.folders[2])).messages
            .length,
          "An empty archive request leaves the source untouched"
        );
        await browser.messages.archive(messagesBefore.messages.map(m => m.id));

        const accountAfter = await browser.accounts.get(accountId);
        browser.test.assertEq(4, accountAfter.folders.length);
        browser.test.assertEq("/test", accountAfter.folders[3].path);
        browser.test.assertEq("/Archives", accountAfter.folders[0].path);
        browser.test.assertEq(3, accountAfter.folders[0].subFolders.length);
        browser.test.assertEq(
          "/Archives/2018",
          accountAfter.folders[0].subFolders[0].path
        );
        browser.test.assertEq(
          "/Archives/2019",
          accountAfter.folders[0].subFolders[1].path
        );
        browser.test.assertEq(
          "/Archives/2020",
          accountAfter.folders[0].subFolders[2].path
        );

        const messagesAfter = await browser.messages.list(
          accountAfter.folders[3]
        );
        browser.test.assertEq(0, messagesAfter.messages.length);

        const messages2018 = await browser.messages.list(
          accountAfter.folders[0].subFolders[0]
        );
        browser.test.assertEq(2, messages2018.messages.length);

        const messages2019 = await browser.messages.list(
          accountAfter.folders[0].subFolders[1]
        );
        browser.test.assertEq(12, messages2019.messages.length);

        const messages2020 = await browser.messages.list(
          accountAfter.folders[0].subFolders[2]
        );
        browser.test.assertEq(1, messages2020.messages.length);

        browser.test.notifyPass("finished");
      },
      "utils.js": await getUtilsJS(),
    };
    const extension = ExtensionTestUtils.loadExtension({
      files,
      manifest: {
        manifest_version: 2,
        background: { scripts: ["utils.js", "background.js"] },
        permissions: ["accountsRead", "messagesMove", "messagesRead"],
      },
    });

    await extension.startup();
    extension.sendMessage(account2.key);
    await extension.awaitFinish("finished");
    await extension.unload();
  }
);

add_task(
  {
    skip_if: () => IS_IMAP || IS_NNTP || IS_EWS,
  },
  async function test_archive_while_another_operation_pending() {
    const { MessageArchiver } = ChromeUtils.importESModule(
      "resource:///modules/MessageArchiver.sys.mjs"
    );
    const archiveAccount = await createAccount();
    addIdentity(archiveAccount);
    const source = await createSubfolder(
      archiveAccount.incomingServer.rootFolder,
      "pendingArchive"
    );
    await createMessages(source, 2);
    const oldCompleted = Promise.withResolvers();
    let oldCompletions = 0;
    const oldArchiver = new MessageArchiver();
    oldArchiver.oncomplete = () => {
      oldCompletions++;
      oldCompleted.resolve();
    };
    await oldArchiver.archiveMessages([[...source.messages][0]]);
    await oldCompleted.promise;
    Assert.equal(source.getTotalMessages(false), 1);
    const entered = Promise.withResolvers();
    let copyListener;
    const customAction = {
      QueryInterface: ChromeUtils.generateQI(["nsIMsgFilterCustomAction"]),
      id: "pending-archive@mochi.test#wait",
      name: "Wait for the archive error check",
      allowDuplicates: false,
      isAsync: true,
      needsBody: false,
      isValidForType() {
        return true;
      },
      validateActionValue() {
        return "";
      },
      applyAction(headers, value, listener) {
        copyListener = listener;
        entered.resolve();
      },
    };
    MailServices.filters.addCustomAction(customAction);
    const list = source.getFilterList(null);
    const filter = list.createFilter("Pending archive");
    filter.enabled = true;
    filter.filterType = Ci.nsMsgFilterType.Archive;
    const term = filter.createTerm();
    term.matchAll = true;
    filter.appendTerm(term);
    const action = filter.createAction();
    action.type = Ci.nsMsgFilterAction.Custom;
    action.customId = customAction.id;
    filter.appendAction(action);
    list.insertFilterAt(0, filter);
    const completed = Promise.withResolvers();
    const archiver = new MessageArchiver();
    archiver.oncomplete = completed.resolve;
    const extension = ExtensionTestUtils.loadExtension({
      manifest: {
        permissions: ["accountsRead", "messagesRead", "messagesMove"],
      },
      background: async () => {
        const [folder] = await browser.folders.query({
          name: "pendingArchive",
        });
        const [message] = (await browser.messages.list(folder.id)).messages;
        await browser.test.assertRejects(
          browser.messages.archive([message.id]),
          /Error archiving message: Can only have one MessageArchiver running at once/,
          "A pending archive rejects a second request instead of leaving it pending"
        );
        browser.test.assertEq(
          folder.id,
          (await browser.messages.get(message.id)).folder.id,
          "The rejected operation preserves its source"
        );
        browser.test.notifyPass("pending-archive");
      },
    });
    try {
      await archiver.archiveMessages([...source.messages]);
      await entered.promise;
      oldArchiver.onStopCopy(Cr.NS_OK);
      Assert.equal(
        oldCompletions,
        1,
        "A late copy callback does not complete again"
      );
      await extension.startup();
      await extension.awaitFinish("pending-archive");
    } finally {
      if (copyListener) {
        copyListener.onStopCopy(Cr.NS_OK);
        copyListener = null;
        await completed.promise;
      }
      list.removeFilter(filter);
      await extension.unload();
      cleanUpAccount(archiveAccount);
    }
  }
);

add_task(
  { skip_if: () => IS_IMAP || IS_NNTP || IS_EWS },
  async function test_archiveProcessingErrors() {
    const { sinon } = ChromeUtils.importESModule(
      "resource://testing-common/Sinon.sys.mjs"
    );
    const { MessageArchiver } = ChromeUtils.importESModule(
      "resource:///modules/MessageArchiver.sys.mjs"
    );
    for (const failure of ["preparation", "copy"]) {
      const archiveAccount = await createAccount();
      addIdentity(archiveAccount);
      const source = await createSubfolder(
        archiveAccount.incomingServer.rootFolder,
        `archive-${failure}-failure`
      );
      await createMessages(source, 1);
      const [header] = source.messages;
      const originalKey = header.messageKey;
      const originalMessageId = header.messageId;
      const error = new Error("Archive preparation failed");
      // Inject an error at the existing async preparation/copy callback boundary.
      // No native copy is attempted before these failures.
      const step = sinon
        .stub(MessageArchiver.prototype, "continueBatch")
        .callsFake(async function () {
          if (failure == "preparation") {
            throw error;
          }
          this.onStopCopy(Cr.NS_ERROR_FILE_ACCESS_DENIED);
        });
      let restored = false;
      const extension = ExtensionTestUtils.loadExtension({
        files: {
          "utils.js": await getUtilsJS(),
          "background.js": async () => {
            const [name] = await window.waitForMessage();
            const [folder] = await browser.folders.query({ name });
            const [message] = (await browser.messages.list(folder.id)).messages;
            await browser.test.assertRejects(
              browser.messages.archive([message.id]),
              /Error archiving message: Archive (preparation failed|copy failed)/,
              "A processing failure rejects instead of successful completion"
            );
            browser.test.assertEq(
              folder.id,
              (await browser.messages.get(message.id)).folder.id,
              "The failed operation keeps the source physical copy"
            );
            browser.test.sendMessage("error-checked");
            await window.waitForMessage();
            await browser.messages.archive([message.id]);
            browser.test.assertEq(
              0,
              (await browser.messages.list(folder.id)).messages.length,
              "A later real archive is not left locked by the failure"
            );
            browser.test.notifyPass("archive-processing-error");
          },
        },
        manifest: {
          permissions: ["accountsRead", "messagesRead", "messagesMove"],
          background: { scripts: ["utils.js", "background.js"] },
        },
      });
      try {
        await extension.startup();
        extension.sendMessage(source.name);
        await extension.awaitMessage("error-checked");
        Assert.ok(source.msgDatabase.containsKey(originalKey));
        Assert.equal(
          source.GetMessageHeader(originalKey).messageId,
          originalMessageId
        );
        Assert.equal(source.getTotalMessages(false), 1);
        step.restore();
        restored = true;
        extension.sendMessage("retry");
        await extension.awaitFinish("archive-processing-error");
        Assert.equal(source.getTotalMessages(false), 0);
        Assert.ok(!source.msgDatabase.containsKey(originalKey));
      } finally {
        if (!restored) {
          step.restore();
        }
        await extension.unload();
        cleanUpAccount(archiveAccount);
      }
    }
  }
);

add_task(
  { skip_if: () => IS_IMAP || IS_NNTP || IS_EWS },
  async function test_archiveFilterFailureContinues() {
    const { MessageArchiver } = ChromeUtils.importESModule(
      "resource:///modules/MessageArchiver.sys.mjs"
    );
    const archiveAccount = await createAccount();
    addIdentity(archiveAccount);
    const source = await createSubfolder(
      archiveAccount.incomingServer.rootFolder,
      "archive-filter-failure"
    );
    await createMessages(source, 1);
    const failedFilter = {
      QueryInterface: ChromeUtils.generateQI(["nsIMsgFilterCustomAction"]),
      id: "archive-error@mochi.test#continue",
      name: "Report an archive filter error",
      allowDuplicates: false,
      isAsync: true,
      needsBody: false,
      isValidForType() {
        return true;
      },
      validateActionValue() {
        return "";
      },
      applyAction(headers, value, listener) {
        listener.onStopCopy(Cr.NS_ERROR_FAILURE);
      },
    };
    MailServices.filters.addCustomAction(failedFilter);
    const list = source.getFilterList(null);
    const filter = list.createFilter("Failed archive filter");
    filter.enabled = true;
    filter.filterType = Ci.nsMsgFilterType.Archive;
    const term = filter.createTerm();
    term.matchAll = true;
    filter.appendTerm(term);
    const action = filter.createAction();
    action.type = Ci.nsMsgFilterAction.Custom;
    action.customId = failedFilter.id;
    filter.appendAction(action);
    list.insertFilterAt(0, filter);
    const completed = Promise.withResolvers();
    let completions = 0;
    const archiver = new MessageArchiver();
    archiver.oncomplete = (status, error) => {
      completions++;
      completed.resolve({ status, error });
    };
    try {
      await archiver.archiveMessages([...source.messages]);
      const result = await completed.promise;
      Assert.equal(
        result.status,
        Cr.NS_OK,
        "The existing policy continues normal archiving after a filter error"
      );
      Assert.equal(result.error, null);
      Assert.equal(completions, 1);
      Assert.equal(source.getTotalMessages(false), 0);
    } finally {
      list.removeFilter(filter);
      cleanUpAccount(archiveAccount);
    }
  }
);

add_task(
  { skip_if: () => IS_IMAP || IS_NNTP || IS_EWS },
  async function test_archiveKeepsOriginalPhysicalSources() {
    const { sinon } = ChromeUtils.importESModule(
      "resource://testing-common/Sinon.sys.mjs"
    );
    const { MailUtils } = ChromeUtils.importESModule(
      "resource:///modules/MailUtils.sys.mjs"
    );
    const { MessageArchiver } = ChromeUtils.importESModule(
      "resource:///modules/MessageArchiver.sys.mjs"
    );
    const physical = header => [
      header.folder.URI,
      header.messageKey,
      header.messageId,
    ];
    for (const stage of ["preparation", "filter"]) {
      for (const operation of ["move", "delete"]) {
        const archiveAccount = await createAccount();
        const identity = addIdentity(archiveAccount);
        const root = archiveAccount.incomingServer.rootFolder;
        const source = await createSubfolder(
          root,
          `source-${stage}-${operation}`
        );
        const target = await createSubfolder(
          root,
          `target-${stage}-${operation}`
        );
        const outside = await createSubfolder(
          root,
          `outside-${stage}-${operation}`
        );
        const archives = await createSubfolder(
          root,
          `archives-${stage}-${operation}`
        );
        identity.archivesFolderURI = archives.URI;
        archives.setFlag(Ci.nsMsgFolderFlags.Archive);
        const synthetic = new MessageGenerator().makeMessage();
        synthetic.messageId = `archive-${stage}-${operation}@example.invalid`;
        await addGeneratedMessages(source, [synthetic]);
        await addGeneratedMessages(outside, [synthetic]);
        const [header] = source.messages;
        const service = Cc[
          "@mozilla.org/msgDatabase/msgDBService;1"
        ].getService(Ci.nsIMsgDBService);
        Assert.equal(
          "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
          Services.prefs.getBoolPref("mail.panorama.enabled", false),
          "The installed backend matches the requested startup configuration"
        );
        Assert.equal(
          source.server.msgStore.storeType,
          "mbox",
          "The ordinary local fixture uses the actual mbox store"
        );
        const key = header.messageKey;
        const excludedIdentity = physical([...outside.messages][0]);
        const entered = Promise.withResolvers();
        const resume = Promise.withResolvers();
        const completed = Promise.withResolvers();
        let completions = 0;
        let identityStub;
        let filter;
        let list;
        let filterContinuation;
        let released = false;
        if (stage == "preparation") {
          identityStub = sinon.stub(MailUtils, "getIdentityForHeader").returns([
            {
              archiveEnabled: true,
              archiveGranularity: identity.archiveGranularity,
              archiveKeepFolderStructure: identity.archiveKeepFolderStructure,
              archiveRecreateInbox: identity.archiveRecreateInbox,
              async getOrCreateArchivesFolderAsync() {
                entered.resolve();
                await resume.promise;
                return archives;
              },
            },
          ]);
        } else {
          const waitAction = {
            QueryInterface: ChromeUtils.generateQI([
              "nsIMsgFilterCustomAction",
            ]),
            id: `archive-identity-${operation}@mochi.test#wait`,
            name: "Pause archive filtering for a physical source change",
            allowDuplicates: false,
            isAsync: true,
            needsBody: false,
            isValidForType() {
              return true;
            },
            validateActionValue() {
              return "";
            },
            applyAction(headers, value, listener) {
              filterContinuation = listener;
              entered.resolve();
            },
          };
          MailServices.filters.addCustomAction(waitAction);
          list = source.getFilterList(null);
          filter = list.createFilter("Wait for the original physical source");
          filter.enabled = true;
          filter.filterType = Ci.nsMsgFilterType.Archive;
          const term = filter.createTerm();
          term.matchAll = true;
          filter.appendTerm(term);
          const action = filter.createAction();
          action.type = Ci.nsMsgFilterAction.Custom;
          action.customId = waitAction.id;
          filter.appendAction(action);
          list.insertFilterAt(0, filter);
        }
        const archiver = new MessageArchiver();
        archiver.oncomplete = (status, error) => {
          completions++;
          completed.resolve({ status, error });
        };
        const starting = archiver.archiveMessages([header]);
        starting.catch(entered.reject);
        const release = () => {
          if (released) {
            return;
          }
          released = true;
          resume.resolve();
          filterContinuation?.onStopCopy(Cr.NS_OK);
        };
        try {
          await entered.promise;
          const changed = new MailPromiseTestUtils.PromiseCopyListener();
          const current = source.GetMessageHeader(key);
          if (operation == "move") {
            MailServices.copy.copyMessages(
              source,
              [current],
              target,
              true,
              changed,
              null,
              false
            );
          } else {
            source.deleteMessages([current], null, true, false, changed, false);
          }
          await changed.promise;
          Assert.ok(!source.msgDatabase.containsKey(key));
          const targetIdentities = [...target.messages].map(physical);
          Assert.equal(targetIdentities.length, operation == "move" ? 1 : 0);
          release();
          await starting;
          const result = await completed.promise;
          Assert.equal(
            result.status,
            Cr.NS_OK,
            "There is no remaining original physical source to archive"
          );
          Assert.equal(result.error, null);
          Assert.equal(completions, 1);
          Assert.equal(source.getTotalMessages(false), 0);
          Assert.equal(
            archives.getTotalMessages(true),
            0,
            "The archive never follows a moved wrapper or another logical copy"
          );
          Assert.deepEqual(
            [...target.messages].map(physical),
            targetIdentities
          );
          Assert.deepEqual([...outside.messages].map(physical), [
            excludedIdentity,
          ]);
        } finally {
          release();
          const started = await starting.then(
            () => true,
            () => false
          );
          if (started) {
            await completed.promise;
          }
          identityStub?.restore();
          if (filter) {
            list.removeFilter(filter);
          }
          archives.clearFlag(Ci.nsMsgFolderFlags.Archive);
          cleanUpAccount(archiveAccount);
        }
      }
    }
  }
);
