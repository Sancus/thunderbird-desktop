/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

let account, rootFolder, subFolders;

/**
 * This file contains unit test for the different pagination options of the
 * MessageList implementation.
 */

add_setup(async function setup() {
  account = await createAccount();
  rootFolder = account.incomingServer.rootFolder;
  subFolders = {
    test1: await createSubfolder(rootFolder, "test1"),
  };
  await createMessages(subFolders.test1, 99);

  registerCleanupFunction(() => {
    // Cleanup the mocked functions of the messageListTracker.
    const {
      Management: {
        global: { messageListTracker },
      },
    } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
    messageListTracker.approvePageFnForTests = null;
    messageListTracker.checkSearchCriteriaFnForTests = null;
  });

  // Start with no user value for the preference modified by the last test.
  await SpecialPowers.pushPrefEnv({
    clear: [["extensions.webextensions.messagesPerPage"]],
  });
});

/**
 * Test messages.query() to return pages as soon as they are filled, and not after
 * all messages have been processed and all pages have been filled. Also tests
 * messages.abortList().
 */
add_task(async function test_query_auto_early_page_return() {
  const {
    Management: {
      global: { messageListTracker },
    },
  } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
  // Reset mocked functions of the messageListTracker.
  messageListTracker.approvePageFnForTests = null;
  messageListTracker.checkSearchCriteriaFnForTests = null;

  const files = {
    "background.js": async () => {
      const [folder] = await browser.folders.query({ name: "test1" });

      // Pre-emptive approve the first page to be completed, otherwise the Promise
      // returned by brower.messages.query() will not resolve.
      await window.sendMessage("approve-page-1");

      let page = await browser.messages.query({
        folderId: folder.id,
        messagesPerPage: 10,
      });
      const listId = page.id;

      // This test uses 10 messages per page and intercepts the creation of pages,
      // preventing the 2nd to be completed. The first page should have been
      // returned as soon as it has been completely filled.
      browser.test.assertEq(
        36,
        listId.length,
        "The listId should have the correct length"
      );
      browser.test.assertEq(
        10,
        page.messages.length,
        "The page should have the correct number of messages"
      );

      // Aborting before the second page has been completed prevents further
      // messages from being added. Therefore, we should not be able to receive
      // all 10 pages, but only 2, and the second page should not include a listId.
      browser.messages.abortList(listId);

      // Search for the last page.
      let pageCount = 1;
      while (page.id) {
        pageCount++;
        browser.test.assertEq(listId, page.id, "The listId should be correct");
        page = await browser.messages.continueList(listId);
      }

      browser.test.assertEq(2, pageCount, "Should have received only 2 pages.");
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

  // Intercept the creation of pages. The second page is never approved, because
  // its Promise is never resolved.
  const pages = new Map();
  pages.set(1, Promise.withResolvers());
  pages.set(2, Promise.withResolvers());
  messageListTracker.approvePageFnForTests = async page => {
    await pages.get(page).promise;
  };

  await extension.startup();

  await extension.awaitMessage("approve-page-1");
  pages.get(1).resolve();
  extension.sendMessage();

  await extension.awaitFinish("finished");
  await extension.unload();
});

async function subtest_query_auto_pagination_timeout(subTestPaginationTimeout) {
  const {
    Management: {
      global: { messageListTracker },
    },
  } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
  // Reset mocked functions of the messageListTracker.
  messageListTracker.approvePageFnForTests = null;
  messageListTracker.checkSearchCriteriaFnForTests = null;

  const files = {
    "background.js": async () => {
      const [paginationTimeout] = await window.sendMessage(
        "get-pagination-timeout"
      );
      const [folder] = await browser.folders.query({ name: "test1" });
      // Used for logging and timing verification, not in QueryDetails.
      const PAGINATION_TIMEOUT = paginationTimeout ?? 1000;

      // This test will search 99 messages, but will delay adding the 3rd, 7th,
      // 12th and 31th message until a pagination timeout occured, creating early
      // pages after the custom pagination timeout.
      let startTime = Date.now();

      const queryDetails = {
        folderId: folder.id,
      };
      // Specify a autoPaginationTimeout only if one is given.
      if (paginationTimeout) {
        queryDetails.autoPaginationTimeout = paginationTimeout;
      }
      // The first page should have message #1 and #2.
      const firstPage = await browser.messages.query(queryDetails);
      const firstPageCreationTime = Date.now();

      const listId = firstPage.id;
      browser.test.assertEq(
        36,
        listId.length,
        "The listId should have the correct length"
      );
      browser.test.assertEq(
        2,
        firstPage.messages.length,
        "The 1st page should be correct"
      );
      browser.test.assertTrue(
        firstPageCreationTime - startTime >= PAGINATION_TIMEOUT,
        `The 1st page should have been created after pagination timeout of ${PAGINATION_TIMEOUT}: ${
          firstPageCreationTime - startTime
        }`
      );

      // Resume test by approving message #3.
      startTime = Date.now();
      await window.sendMessage("approve-message-3");

      // The 2nd page should have message #3. #4, #5 and #6.
      const secondPage = await browser.messages.continueList(listId);
      const secondPageCreationTime = Date.now();

      browser.test.assertEq(
        listId,
        secondPage.id,
        "The listId should be correct"
      );
      browser.test.assertEq(
        4,
        secondPage.messages.length,
        "The 2nd page should be correct"
      );
      browser.test.assertTrue(
        secondPageCreationTime - startTime >= PAGINATION_TIMEOUT,
        `The 2st page should have been created after pagination timeout of ${PAGINATION_TIMEOUT}: ${
          secondPageCreationTime - startTime
        }`
      );

      // Resume test by approving message #7.
      startTime = Date.now();
      await window.sendMessage("approve-message-7");

      // The 3rd page should have messages #7. #8, #9, #10 and #11.
      const thirdPage = await browser.messages.continueList(listId);
      const thirdPageCreationTime = Date.now();

      browser.test.assertEq(
        listId,
        thirdPage.id,
        "The listId should be correct"
      );
      browser.test.assertEq(
        5,
        thirdPage.messages.length,
        "The 3rd page should be correct"
      );
      browser.test.assertTrue(
        thirdPageCreationTime - startTime >= PAGINATION_TIMEOUT,
        `The 3rd page should have been created after pagination timeout of ${PAGINATION_TIMEOUT}: ${
          thirdPageCreationTime - startTime
        }`
      );

      // Resume test by approving message #12.
      startTime = Date.now();
      await window.sendMessage("approve-message-12");

      // The 4th page should have message #12 till #30.
      const fourthPage = await browser.messages.continueList(listId);
      const fourthPageCreationTime = Date.now();

      browser.test.assertEq(
        listId,
        fourthPage.id,
        "The listId should be correct"
      );
      browser.test.assertEq(
        19,
        fourthPage.messages.length,
        "The 4th page should be correct"
      );
      browser.test.assertTrue(
        fourthPageCreationTime - startTime >= PAGINATION_TIMEOUT,
        `The 4th page should have been created after pagination timeout of ${PAGINATION_TIMEOUT}: ${
          fourthPageCreationTime - startTime
        }`
      );

      // Resume test by approving message #31.
      await window.sendMessage("approve-message-31");

      // The 5th page should have message #31 till #99. The page is filled without
      // further interuption and will not be forced to exceed the pagination timeout.
      const fifthPage = await browser.messages.continueList(listId);

      browser.test.assertEq(
        null,
        fifthPage.id,
        "The listId of the final page should be null"
      );
      browser.test.assertEq(
        69,
        fifthPage.messages.length,
        "The 5th page should be correct"
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
      permissions: ["accountsRead", "messagesRead"],
    },
  });

  const messages = new Map();
  messages.set(3, Promise.withResolvers());
  messages.set(7, Promise.withResolvers());
  messages.set(12, Promise.withResolvers());
  messages.set(31, Promise.withResolvers());

  let msgCounter = 1;
  // Mock the function which checks the search criteria to intercept the addition
  // of some messages.
  messageListTracker.checkSearchCriteriaFnForTests = async () => {
    if (messages.has(msgCounter)) {
      console.log(
        `Simulating a prolonged asynchronous search for message #${msgCounter}`
      );
      await messages.get(msgCounter).promise;
    }
    msgCounter++;
    return true;
  };

  await extension.startup();

  await extension.awaitMessage("get-pagination-timeout");
  extension.sendMessage(subTestPaginationTimeout);

  await extension.awaitMessage("approve-message-3");
  messages.get(3).resolve();
  extension.sendMessage();

  await extension.awaitMessage("approve-message-7");
  messages.get(7).resolve();
  extension.sendMessage();

  await extension.awaitMessage("approve-message-12");
  messages.get(12).resolve();
  extension.sendMessage();

  await extension.awaitMessage("approve-message-31");
  messages.get(31).resolve();
  extension.sendMessage();

  await extension.awaitFinish("finished");
  await extension.unload();
}

/**
 * Test the default auto-pagination mechanism and the ability to retrieve pages
 * as soon as they have been created. Auto pagination will cause pages to be
 * created after 1000ms, even if pages are not yet full.
 */
add_task(async function test_query_auto_pagination() {
  await subtest_query_auto_pagination_timeout();
});

/**
 * Test the auto-pagination mechanism with a custom pagination timeout of 1500ms.
 */
add_task(async function test_query_auto_pagination_custom_timeout() {
  await subtest_query_auto_pagination_timeout(1500);
});

/**
 * Test that the default pagination can be disabled.
 */
add_task(async function test_query_disabled_auto_pagination() {
  const {
    Management: {
      global: { messageListTracker },
    },
  } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
  // Reset mocked functions of the messageListTracker.
  messageListTracker.approvePageFnForTests = null;
  messageListTracker.checkSearchCriteriaFnForTests = null;

  const files = {
    "background.js": async () => {
      const [folder] = await browser.folders.query({ name: "test1" });

      // This test will return 99 messages, but will need 700ms to find the 2nd,
      // 6th, 10th and 30th message. Since auto-pagination is disabled, the query
      // should return a single page with all messages after the query has finished,
      // ignoring the default pagination timeout of 1000ms.
      const now = Date.now();
      const firstPage = await browser.messages.query({
        folderId: folder.id,
        autoPaginationTimeout: 0,
      });
      const firstPageCreationTime = Date.now();

      browser.test.assertEq(
        null,
        firstPage.id,
        "The listId should not be present"
      );
      browser.test.assertEq(
        99,
        firstPage.messages.length,
        "The first page should be correct"
      );

      browser.test.assertTrue(
        firstPageCreationTime - now > 1000,
        `Should create only one page even if creation time is longer than default pagination timeout of 1000ms: ${
          firstPageCreationTime - now
        }`
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
      permissions: ["accountsRead", "messagesRead"],
    },
  });

  // This test will delay the retrieval of 4 messages to prolong the search time
  // beyond twice the auto-pagination timeout.
  const messageDelays = new Map();
  messageDelays.set(2, 700);
  messageDelays.set(6, 700);
  messageDelays.set(10, 700);
  messageDelays.set(30, 700);
  let msgCounter = 1;
  // Mock the function which checks the search criteria to delay the addition of
  // some messages.
  messageListTracker.checkSearchCriteriaFnForTests = async () => {
    const delay = messageDelays.get(msgCounter) || 0;
    if (delay) {
      console.log(
        `Simulating a prolonged asynchronous search for message #${msgCounter}`
      );
      const start = Date.now();
      while (Date.now() - start < delay) {
        // No Op.
      }
    }
    msgCounter++;
    return true;
  };

  await extension.startup();
  await extension.awaitFinish("finished");
  await extension.unload();
});

/**
 * Test the returnMessageListId option, which should return the list Id
 * immediately, even before the first page has been completed.
 */
add_task(async function test_query_returnMessageListId() {
  const {
    Management: {
      global: { messageListTracker },
    },
  } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
  // Reset mocked functions of the messageListTracker.
  messageListTracker.approvePageFnForTests = null;
  messageListTracker.checkSearchCriteriaFnForTests = null;

  const files = {
    "background.js": async () => {
      const [folder] = await browser.folders.query({ name: "test1" });

      // This test intercepts the completion of pages. Since returnMessageListId
      // is requested, the query should return directly, before even the first
      // page is completed.
      const now = Date.now();
      const listId = await browser.messages.query({
        folderId: folder.id,
        autoPaginationTimeout: 0,
        returnMessageListId: true,
      });
      browser.test.assertEq(
        36,
        listId.length,
        "The listId should have the correct length"
      );

      // This test will return 2 messages, but will need 700ms to check the 2nd,
      // 6th, 10th and 30th message. Since auto-pagination is disabled, the query
      // will return a single page with all messages after the query has finished,
      // ignoring the default pagination timeout of 1000ms.
      // Note: The approve-page-1 message is not waiting for the page to be
      //       completed, it just *approves* the first page, *whenever* that will
      //       be.
      await window.sendMessage("approve-page-1");

      const firstPage = await browser.messages.continueList(listId);
      const firstPageCreationTime = Date.now();

      browser.test.assertEq(null, firstPage.id, "The listId should be correct");
      browser.test.assertEq(
        2,
        firstPage.messages.length,
        "The page should be correct"
      );

      browser.test.assertTrue(
        firstPageCreationTime - now > 1000,
        `Should create only one page even if creation time is longer than default pagination timeout of 1000ms: ${
          firstPageCreationTime - now
        }`
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
      permissions: ["accountsRead", "messagesRead"],
    },
  });

  // In this test we expect at most 1 page to ask for approval to be completed.
  const pages = new Map();
  pages.set(1, Promise.withResolvers());
  messageListTracker.approvePageFnForTests = async page => {
    await pages.get(page).promise;
  };

  // This test will delay the retrieval of 4 messages to prolong the search time
  // beyond twice the auto-pagination timeout of 1000ms. Only 2 messages will be
  // "found".
  const messageDelays = new Map();
  messageDelays.set(2, 700);
  messageDelays.set(6, 700);
  messageDelays.set(10, 700);
  messageDelays.set(30, 700);
  const searchResults = new Map();
  searchResults.set(6, true);
  searchResults.set(55, true);
  let msgCounter = 1;
  // Mock the function which checks the search criteria to delay and supress the
  // addition of some messages.
  messageListTracker.checkSearchCriteriaFnForTests = async () => {
    const delay = messageDelays.get(msgCounter) || 0;
    if (delay) {
      console.log(
        `Simulating a prolonged asynchronous search for message #${msgCounter}`
      );
      const start = Date.now();
      while (Date.now() - start < delay) {
        // No Op.
      }
    }
    msgCounter++;
    return searchResults.has(msgCounter);
  };

  await extension.startup();

  await extension.awaitMessage("approve-page-1");
  pages.get(1).resolve();
  extension.sendMessage();

  await extension.awaitFinish("finished");
  await extension.unload();
});

add_task(async function test_query_failure_rejects_pending_page() {
  const {
    Management: {
      global: { messageListTracker },
    },
  } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
  const { ExtensionError } = ChromeUtils.importESModule(
    "resource://gre/modules/ExtensionUtils.sys.mjs"
  );
  messageListTracker.approvePageFnForTests = null;
  messageListTracker.checkSearchCriteriaFnForTests = async () => {
    throw new ExtensionError("Injected query failure");
  };
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "utils.js": await getUtilsJS(),
      "background.js": async () => {
        const [folder] = await browser.folders.query({ name: "test1" });
        await browser.test.assertRejects(
          browser.messages.query({ folderId: folder.id }),
          /Injected query failure/,
          "A failed producer rejects the waiting query page"
        );
        await window.sendMessage("recover-query");
        const page = await browser.messages.query({
          folderId: folder.id,
          messagesPerPage: 150,
          autoPaginationTimeout: 0,
        });
        browser.test.assertEq(null, page.id);
        browser.test.assertEq(99, page.messages.length);
        browser.test.assertEq(
          99,
          new Set(page.messages.map(message => message.id)).size
        );
        browser.test.assertTrue(
          page.messages.every(message => message.folder.id == folder.id)
        );
        browser.test.notifyPass("query-recovered");
      },
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["accountsRead", "messagesRead"],
    },
  });
  try {
    await extension.startup();
    await extension.awaitMessage("recover-query");
    messageListTracker.checkSearchCriteriaFnForTests = null;
    extension.sendMessage();
    await extension.awaitFinish("query-recovered");
    Assert.equal(subFolders.test1.getTotalMessages(false), 99);
  } finally {
    messageListTracker.checkSearchCriteriaFnForTests = null;
    await extension.unload();
  }
});

/**
 * Hold the existing query predicate until a continuation is waiting or aborted.
 *
 * @param {boolean} abortFirst - Abort before delivering the predicate failure.
 */
async function checkLateQueryFailure(abortFirst) {
  const {
    Management: {
      global: { messageListTracker },
    },
  } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
  const { ExtensionError } = ChromeUtils.importESModule(
    "resource://gre/modules/ExtensionUtils.sys.mjs"
  );
  const resume = Promise.withResolvers();
  let checked = 0;
  messageListTracker.approvePageFnForTests = null;
  messageListTracker.checkSearchCriteriaFnForTests = async () => {
    if (!abortFirst && ++checked <= 11) {
      return true;
    }
    await resume.promise;
    throw new ExtensionError("Deferred query failure");
  };
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "utils.js": await getUtilsJS(),
      "background.js": async () => {
        const [abort] = await window.sendMessage("get-abort");
        const [folder] = await browser.folders.query({ name: "test1" });
        const initial = await browser.messages.query({
          folderId: folder.id,
          messagesPerPage: 10,
          autoPaginationTimeout: 0,
          returnMessageListId: abort,
        });
        const id = abort ? initial : initial.id;
        if (!abort) {
          browser.test.assertEq(
            10,
            initial.messages.length,
            "The first complete page was delivered before the later error"
          );
          browser.test.assertTrue(
            initial.messages.every(message => message.folder.id == folder.id)
          );
        }
        if (abort) {
          await browser.messages.abortList(id);
        }
        const pending = browser.messages.continueList(id);
        await window.sendMessage("fail-query");
        if (abort) {
          window.assertDeepEqual({ id: null, messages: [] }, await pending);
        } else {
          await browser.test.assertRejects(
            pending,
            /Deferred query failure/,
            "A failed producer rejects a pending continuation"
          );
        }
        await browser.test.assertRejects(
          browser.messages.continueList(id),
          new RegExp(`No message list for id ${id}`),
          "The terminal list is removed from the tracker"
        );
        browser.test.notifyPass("query-terminal");
      },
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["accountsRead", "messagesRead"],
    },
  });
  try {
    await extension.startup();
    await extension.awaitMessage("get-abort");
    extension.sendMessage(abortFirst);
    await extension.awaitMessage("fail-query");
    resume.resolve();
    extension.sendMessage();
    await extension.awaitFinish("query-terminal");
    Assert.equal(subFolders.test1.getTotalMessages(false), 99);
  } finally {
    resume.resolve();
    messageListTracker.checkSearchCriteriaFnForTests = null;
    await extension.unload();
  }
}

add_task(async function test_query_failure_rejects_pending_continuation() {
  await checkLateQueryFailure(false);
});

add_task(async function test_aborted_query_ignores_late_failure() {
  await checkLateQueryFailure(true);
});

add_task(
  async function test_saved_search_query_failure_and_recovery_without_fts() {
    const { VirtualFolderHelper } = ChromeUtils.importESModule(
      "resource:///modules/VirtualFolderWrapper.sys.mjs"
    );
    const {
      Management: {
        global: { messageListTracker },
      },
    } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
    messageListTracker.approvePageFnForTests = null;
    messageListTracker.checkSearchCriteriaFnForTests = null;
    await SpecialPowers.pushPrefEnv({
      set: [["mailnews.database.global.indexer.enabled", false]],
    });
    const saved = VirtualFolderHelper.createNewVirtualFolder(
      "queryFailureSavedSearch",
      rootFolder,
      [subFolders.test1],
      "ALL",
      false
    );
    const [header] = subFolders.test1.messages;
    subFolders.test1.msgDatabase.refreshCache(saved.virtualFolder.URI, [
      header.messageKey,
    ]);
    const invalid = "AND (subject,unsupported-operation,scope)";
    // Native saved searches refuse an unparseable definition when it is set.
    Assert.throws(() => {
      saved.searchString = invalid;
    }, /NS_ERROR_ILLEGAL_VALUE/);
    // A definition already stored, as by an older profile, is read unchanged.
    saved.virtualFolder.setStringProperty("searchStr", invalid);
    Assert.equal(saved.searchString, invalid);
    const extension = ExtensionTestUtils.loadExtension({
      files: {
        "utils.js": await getUtilsJS(),
        "background.js": async () => {
          const [folder] = await browser.folders.query({
            name: "queryFailureSavedSearch",
          });
          const [physicalFolder] = await browser.folders.query({
            name: "test1",
          });
          await browser.test.assertRejects(
            browser.messages.query({ folderId: folder.id }),
            /An unexpected error occurred/,
            "The actual invalid saved-search condition rejects instead of hanging"
          );
          await window.sendMessage("repair-saved-search");
          const result = await browser.messages.query({
            folderId: folder.id,
            messagesPerPage: 150,
            autoPaginationTimeout: 0,
          });
          const physical = await browser.messages.list(physicalFolder.id);
          browser.test.assertEq(null, result.id);
          browser.test.assertEq(99, result.messages.length);
          browser.test.assertTrue(
            result.messages.every(
              message => message.folder.id == physicalFolder.id
            )
          );
          window.assertDeepEqual(
            physical.messages.map(message => message.id).sort((a, b) => a - b),
            result.messages.map(message => message.id).sort((a, b) => a - b)
          );
          browser.test.notifyPass("saved-search-query-recovered");
        },
      },
      manifest: {
        background: { scripts: ["utils.js", "background.js"] },
        permissions: ["accountsRead", "messagesRead"],
      },
    });
    try {
      Assert.ok(
        !Services.prefs.getBoolPref("mailnews.database.global.indexer.enabled")
      );
      await extension.startup();
      await extension.awaitMessage("repair-saved-search");
      saved.searchString = "ALL";
      extension.sendMessage();
      await extension.awaitFinish("saved-search-query-recovered");
      Assert.equal(subFolders.test1.getTotalMessages(false), 99);
    } finally {
      await extension.unload();
      saved.virtualFolder.deleteSelf(null);
      await SpecialPowers.popPrefEnv();
    }
  }
);

add_task(async function test_list_failure_rejects_pending_page() {
  const {
    Management: {
      global: { messageListTracker },
    },
  } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
  const { ExtensionError } = ChromeUtils.importESModule(
    "resource://gre/modules/ExtensionUtils.sys.mjs"
  );
  await SpecialPowers.pushPrefEnv({
    set: [["extensions.webextensions.messagesPerPage", 10]],
  });
  messageListTracker.checkSearchCriteriaFnForTests = null;
  messageListTracker.approvePageFnForTests = async () => {
    throw new ExtensionError("Injected list failure");
  };
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "utils.js": await getUtilsJS(),
      "background.js": async () => {
        const [folder] = await browser.folders.query({ name: "test1" });
        await browser.test.assertRejects(
          browser.messages.list(folder.id),
          /Injected list failure/,
          "List producer failure rejects its pending page"
        );
        await window.sendMessage("recover-list");
        let page = await browser.messages.list(folder.id);
        const messages = [...page.messages];
        while (page.id) {
          page = await browser.messages.continueList(page.id);
          messages.push(...page.messages);
        }
        browser.test.assertEq(99, messages.length);
        browser.test.assertEq(
          99,
          new Set(messages.map(message => message.id)).size
        );
        browser.test.assertTrue(
          messages.every(message => message.folder.id == folder.id)
        );
        browser.test.notifyPass("list-recovered");
      },
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["accountsRead", "messagesRead"],
    },
  });
  try {
    await extension.startup();
    await extension.awaitMessage("recover-list");
    messageListTracker.approvePageFnForTests = null;
    extension.sendMessage();
    await extension.awaitFinish("list-recovered");
    Assert.equal(subFolders.test1.getTotalMessages(false), 99);
  } finally {
    messageListTracker.approvePageFnForTests = null;
    await extension.unload();
    await SpecialPowers.popPrefEnv();
  }
});

/**
 * Test messages.list() to return pages as soon as they are filled, and not after
 * all messages have been processed and all pages have been filled. Also tests
 * messages.abortList().
 *
 * Note: Run this test last.
 */
add_task(async function test_list_auto_early_page_return() {
  await SpecialPowers.pushPrefEnv({
    set: [["extensions.webextensions.messagesPerPage", 10]],
  });

  const {
    Management: {
      global: { messageListTracker },
    },
  } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
  // Reset mocked functions of the messageListTracker.
  messageListTracker.approvePageFnForTests = null;
  messageListTracker.checkSearchCriteriaFnForTests = null;

  const files = {
    "background.js": async () => {
      const [folder] = await browser.folders.query({ name: "test1" });

      // Pre-emptive approve the first page to be completed, otherwise the Promise
      // returned by brower.messages.list() will not resolve.
      await window.sendMessage("approve-page-1");

      let page = await browser.messages.list(folder.id);
      const listId = page.id;
      // This test uses 10 messages per page and intercepts the creation of pages,
      // preventing the 2nd to be completed. The first page should have been
      // returned as soon as it has been completely filled.
      browser.test.assertEq(
        36,
        listId.length,
        "The listId should have the correct length"
      );
      browser.test.assertEq(
        10,
        page.messages.length,
        "The page should have the correct number of messages"
      );

      // Aborting before the second page has been completed prevents further
      // messages from being added. Therefore, we should not be able to receive
      // all 10 pages, but only 2, and the second page should not include a listId.
      browser.messages.abortList(listId);

      // Search for the last page.
      let pageCount = 1;
      while (page.id) {
        pageCount++;
        browser.test.assertEq(listId, page.id, "The listId should be correct");
        page = await browser.messages.continueList(listId);
      }

      browser.test.assertEq(2, pageCount, "Should have received only 2 pages.");
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

  // Intercept the creation of pages. The second page is never approved, because
  // its Promise is never resolved.
  const pages = new Map();
  pages.set(1, Promise.withResolvers());
  pages.set(2, Promise.withResolvers());
  messageListTracker.approvePageFnForTests = async page => {
    await pages.get(page).promise;
  };

  await extension.startup();

  await extension.awaitMessage("approve-page-1");
  pages.get(1).resolve();
  extension.sendMessage();

  await extension.awaitFinish("finished");
  await extension.unload();

  await SpecialPowers.popPrefEnv();
});

add_setup(function setupNativePagination() {
  Assert.ok(Services.prefs.getBoolPref("mail.panorama.enabled"));
  Assert.ok(
    !Services.prefs.getBoolPref("mailnews.database.global.indexer.enabled")
  );
  Assert.ok(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    ) instanceof Ci.nsIDatabaseCore
  );
  Assert.equal(subFolders.test1.msgStore.storeType, "mbox");
});

/**
 * Hold a real producer while two extension continuation calls enter the list.
 *
 * @param {boolean} query - Use messages.query instead of messages.list.
 * @param {boolean} [fail=false] - Reject the held producer with its original error.
 */
async function checkConcurrentPages(query, fail = false) {
  const {
    Management: {
      global: { messageListTracker },
    },
  } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
  const { ExtensionError } = ChromeUtils.importESModule(
    "resource://gre/modules/ExtensionUtils.sys.mjs"
  );
  const held = Promise.withResolvers();
  const release = Promise.withResolvers();
  const readersEntered = Promise.withResolvers();
  const failure = new ExtensionError("Concurrent producer failure");
  const headers = [...subFolders.test1.messages];
  const physical = headers.map(header => [
    header.folder.URI,
    header.messageKey,
  ]);
  messageListTracker.checkSearchCriteriaFnForTests = null;
  messageListTracker.approvePageFnForTests = async page => {
    if (page == 2) {
      held.resolve();
      await release.promise;
      if (fail) {
        throw failure;
      }
    }
  };
  await SpecialPowers.pushPrefEnv({
    set: [["extensions.webextensions.messagesPerPage", 10]],
  });
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "utils.js": await getUtilsJS(),
      "background.js": async () => {
        const [{ query: useQuery, fail: rejectProducer, expected }] =
          await window.sendMessage("fixtures");
        const [folder] = await browser.folders.query({ name: "test1" });
        let page = useQuery
          ? await browser.messages.query({
              folderId: folder.id,
              messagesPerPage: 10,
              autoPaginationTimeout: 0,
            })
          : await browser.messages.list(folder.id);
        const id = page.id;
        window.assertDeepEqual(
          expected.slice(0, 10),
          page.messages.map(m => m.id)
        );
        await window.sendMessage("initial-page", id);
        const settled = [0, 0];
        const pending = [0, 1].map(index =>
          browser.messages.continueList(id).then(
            result => {
              settled[index]++;
              return result;
            },
            error => {
              settled[index]++;
              throw error;
            }
          )
        );
        // Attach rejection handlers before the parent releases a failing producer.
        const results = Promise.allSettled(pending);
        await window.sendMessage("release-continuations");
        const received = await results;
        window.assertDeepEqual([1, 1], settled);
        if (rejectProducer) {
          for (const result of received) {
            browser.test.assertEq("rejected", result.status);
            browser.test.assertEq(
              "Concurrent producer failure",
              result.reason.message
            );
          }
        } else {
          const all = [...page.messages];
          for (let index = 0; index < 2; index++) {
            browser.test.assertEq("fulfilled", received[index].status);
            page = received[index].value;
            browser.test.assertEq(id, page.id);
            window.assertDeepEqual(
              expected.slice(10 + index * 10, 20 + index * 10),
              page.messages.map(m => m.id)
            );
            all.push(...page.messages);
          }
          while (page.id) {
            page = await browser.messages.continueList(id);
            all.push(...page.messages);
          }
          window.assertDeepEqual(
            expected,
            all.map(m => m.id)
          );
          browser.test.assertEq(99, new Set(all.map(m => m.id)).size);
          browser.test.assertTrue(all.every(m => m.folder.id == folder.id));
          browser.test.assertEq(null, page.id);
        }
        await browser.test.assertRejects(
          browser.messages.continueList(id),
          new RegExp(`No message list for id ${id}`)
        );
        browser.test.notifyPass("concurrent-pages");
      },
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["accountsRead", "messagesRead"],
    },
  });
  let list;
  let originalRead;
  let entered = 0;
  try {
    await extension.startup();
    await extension.awaitMessage("fixtures");
    const nativeExtension = WebExtensionPolicy.getByID(extension.id).extension;
    extension.sendMessage({
      query,
      fail,
      expected: headers.map(
        header => nativeExtension.messageManager.convert(header).id
      ),
    });
    const id = await extension.awaitMessage("initial-page");
    await held.promise;
    list = messageListTracker.getList(id, nativeExtension);
    originalRead = list.getNextUnreadPage;
    // Observe actual API entry; never replace the producer or its page result.
    list.getNextUnreadPage = function (...args) {
      if (++entered == 2) {
        readersEntered.resolve();
      }
      return originalRead.apply(this, args);
    };
    extension.sendMessage();
    await extension.awaitMessage("release-continuations");
    await readersEntered.promise;
    Assert.equal(entered, 2, "Both real continuation calls entered while held");
    list.getNextUnreadPage = originalRead;
    release.resolve();
    extension.sendMessage();
    await extension.awaitFinish("concurrent-pages");
    if (fail) {
      Assert.strictEqual(
        list.failure.error,
        failure,
        "Retain the original producer error"
      );
    }
    Assert.deepEqual(
      [...subFolders.test1.messages].map(header => [
        header.folder.URI,
        header.messageKey,
      ]),
      physical,
      "Physical fixtures were not changed by pagination"
    );
  } finally {
    release.resolve();
    if (list && originalRead) {
      list.getNextUnreadPage = originalRead;
    }
    messageListTracker.approvePageFnForTests = null;
    messageListTracker.checkSearchCriteriaFnForTests = null;
    await extension.unload();
    await SpecialPowers.popPrefEnv();
  }
}

add_task(async function test_continueListConcurrentQueryPages() {
  await checkConcurrentPages(true);
});

add_task(async function test_continueListConcurrentFolderPages() {
  await checkConcurrentPages(false);
});

add_task(async function test_continueListConcurrentFailureSettlesOnce() {
  await checkConcurrentPages(true, true);
  await checkConcurrentPages(false, true);
});

add_task(async function test_queryPrevalidationReleasesLists() {
  const {
    Management: {
      global: { messageListTracker },
    },
  } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
  const headers = [...subFolders.test1.messages];
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "utils.js": await getUtilsJS(),
      "background.js": async () => {
        const [{ folderId, expected }] = await window.sendMessage("fixtures");
        const missing = `${folderId}/missing-s426`;
        await browser.test.assertRejects(
          browser.messages.query({ folderId: missing }),
          new RegExp(`Folder not found: ${missing}`)
        );
        await window.sendMessage("list-count");
        await browser.test.assertRejects(
          browser.messages.query({ online: true }),
          /Property headerMessageId is required for online queries\./
        );
        await window.sendMessage("list-count");
        const empty = await browser.messages.query({
          tags: { mode: "all", tags: { "missing-s426-tag": true } },
        });
        window.assertDeepEqual({ id: null, messages: [] }, empty);
        await window.sendMessage("list-count");
        const recovered = await browser.messages.query({
          folderId,
          messagesPerPage: 150,
          autoPaginationTimeout: 0,
        });
        browser.test.assertEq(null, recovered.id);
        window.assertDeepEqual(
          expected,
          recovered.messages.map(m => m.id)
        );
        browser.test.assertTrue(
          recovered.messages.every(m => m.folder.id == folderId)
        );
        await window.sendMessage("list-count");
        browser.test.notifyPass("prevalidation");
      },
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["accountsRead", "messagesRead"],
    },
  });
  let folderId;
  try {
    await extension.startup();
    await extension.awaitMessage("fixtures");
    const nativeExtension = WebExtensionPolicy.getByID(extension.id).extension;
    const baseline =
      messageListTracker._contextLists.get(nativeExtension)?.size ?? 0;
    folderId = nativeExtension.folderManager.convert(subFolders.test1).id;
    extension.sendMessage({
      folderId,
      expected: headers.map(
        header => nativeExtension.messageManager.convert(header).id
      ),
    });
    for (let i = 0; i < 4; i++) {
      await extension.awaitMessage("list-count");
      Assert.equal(
        messageListTracker._contextLists.get(nativeExtension)?.size ?? 0,
        baseline,
        "Settled validation/empty/recovery leaves no inaccessible list"
      );
      extension.sendMessage();
    }
    await extension.awaitFinish("prevalidation");
  } finally {
    await extension.unload();
  }

  const denied = ExtensionTestUtils.loadExtension({
    files: {
      "utils.js": await getUtilsJS(),
      "background.js": async () => {
        const [targetFolderId] = await window.sendMessage("folder-id");
        await browser.test.assertRejects(
          browser.messages.query({ folderId: targetFolderId }),
          /Querying by folder requires the "accountsRead" permission/
        );
        await window.sendMessage("denied-settled");
        browser.test.notifyPass("permission-prevalidation");
      },
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["messagesRead"],
    },
  });
  try {
    await denied.startup();
    await denied.awaitMessage("folder-id");
    const nativeExtension = WebExtensionPolicy.getByID(denied.id).extension;
    const baseline =
      messageListTracker._contextLists.get(nativeExtension)?.size ?? 0;
    denied.sendMessage(folderId);
    await denied.awaitMessage("denied-settled");
    Assert.equal(
      messageListTracker._contextLists.get(nativeExtension)?.size ?? 0,
      baseline
    );
    denied.sendMessage();
    await denied.awaitFinish("permission-prevalidation");
  } finally {
    await denied.unload();
  }
});

/**
 * Abort a real producer inside its existing page-approval await.
 *
 * @param {boolean} query - Use messages.query instead of messages.list.
 */
async function checkAbortPendingPage(query) {
  const {
    Management: {
      global: { messageListTracker },
    },
  } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
  const held = Promise.withResolvers();
  const release = Promise.withResolvers();
  const producerReturned = Promise.withResolvers();
  messageListTracker.checkSearchCriteriaFnForTests = null;
  messageListTracker.approvePageFnForTests = async page => {
    if (page == 2) {
      held.resolve();
      await release.promise;
    }
  };
  await SpecialPowers.pushPrefEnv({
    set: [["extensions.webextensions.messagesPerPage", 10]],
  });
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "utils.js": await getUtilsJS(),
      "background.js": async () => {
        const [{ query: useQuery, expected }] =
          await window.sendMessage("fixtures");
        const [folder] = await browser.folders.query({ name: "test1" });
        const first = useQuery
          ? await browser.messages.query({
              folderId: folder.id,
              messagesPerPage: 10,
              autoPaginationTimeout: 0,
            })
          : await browser.messages.list(folder.id);
        window.assertDeepEqual(
          expected.slice(0, 10),
          first.messages.map(m => m.id)
        );
        await window.sendMessage("initial-page", first.id);
        await browser.messages.abortList(first.id);
        const last = await browser.messages.continueList(first.id);
        browser.test.assertEq(null, last.id);
        window.assertDeepEqual(
          expected.slice(10, 20),
          last.messages.map(m => m.id)
        );
        browser.test.assertTrue(
          last.messages.every(m => m.folder.id == folder.id)
        );
        await window.sendMessage("release-producer");
        await browser.test.assertRejects(
          browser.messages.continueList(first.id),
          new RegExp(`No message list for id ${first.id}`)
        );
        browser.test.notifyPass("aborted-page");
      },
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["accountsRead", "messagesRead"],
    },
  });
  const originalCreate = messageListTracker.createList;
  let list;
  let originalAdd;
  try {
    await extension.startup();
    await extension.awaitMessage("fixtures");
    const nativeExtension = WebExtensionPolicy.getByID(extension.id).extension;
    messageListTracker.createList = function (context, options) {
      const created = originalCreate.call(this, context, options);
      if (context == nativeExtension) {
        list = created;
        originalAdd = list.addMessage;
        // Observe the real pending add returning after abort, without a timer.
        list.addMessage = async function (...args) {
          try {
            return await originalAdd.apply(this, args);
          } finally {
            if (this.isDone) {
              producerReturned.resolve();
            }
          }
        };
      }
      return created;
    };
    const headers = [...subFolders.test1.messages];
    const physical = headers.map(header => [
      header.folder.URI,
      header.messageKey,
    ]);
    extension.sendMessage({
      query,
      expected: headers.map(
        header => nativeExtension.messageManager.convert(header).id
      ),
    });
    const id = await extension.awaitMessage("initial-page");
    await held.promise;
    Assert.strictEqual(list, messageListTracker.getList(id, nativeExtension));
    Assert.equal(list.pages.length, 2);
    const buffered = list.currentPage.messages.map(message => message.id);
    Assert.equal(buffered.length, 10);
    extension.sendMessage();
    await extension.awaitMessage("release-producer");
    release.resolve();
    await producerReturned.promise;
    Assert.equal(list.pages.length, 2, "No page is created after abort");
    Assert.deepEqual(
      list.currentPage.messages.map(message => message.id),
      buffered
    );
    Assert.equal(
      list.log.size,
      20,
      "The pending twenty-first physical message was not added"
    );
    Assert.ok(!messageListTracker._contextLists.get(nativeExtension).has(id));
    extension.sendMessage();
    await extension.awaitFinish("aborted-page");
    Assert.deepEqual(
      [...subFolders.test1.messages].map(header => [
        header.folder.URI,
        header.messageKey,
      ]),
      physical
    );
  } finally {
    release.resolve();
    messageListTracker.createList = originalCreate;
    if (list && originalAdd) {
      list.addMessage = originalAdd;
    }
    messageListTracker.approvePageFnForTests = null;
    messageListTracker.checkSearchCriteriaFnForTests = null;
    await extension.unload();
    await SpecialPowers.popPrefEnv();
  }
}

add_task(async function test_abortListStopsPendingPage() {
  await checkAbortPendingPage(true);
  await checkAbortPendingPage(false);
});
