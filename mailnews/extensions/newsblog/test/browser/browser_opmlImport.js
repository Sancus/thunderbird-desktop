/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
var { mailTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MailTestUtils.sys.mjs"
);

var { Feed } = ChromeUtils.importESModule("resource:///modules/Feed.sys.mjs");
var { FeedUtils } = ChromeUtils.importESModule(
  "resource:///modules/FeedUtils.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { MockFilePicker } = SpecialPowers;

const server = MailServices.accounts.getAccount("account1").incomingServer;
const rootFolder = server.rootFolder;

add_setup(() => {
  MockFilePicker.init(window.browsingContext);
  registerCleanupFunction(() => {
    MockFilePicker.cleanup();
    for (const prefix of ["fz", "tb"]) {
      const folder = rootFolder.getChildNamed(`Prefix ${prefix} Feed`);
      if (folder) {
        FeedUtils.deleteFeed(new Feed(feedURL(prefix), folder));
        rootFolder.propagateDelete(folder, true);
      }
    }
  });
});

function feedURL(prefix) {
  return `https://example.org/browser/comm/mailnews/extensions/newsblog/test/browser/data/rss.xml?${prefix}`;
}

/**
 * Open the feed subscriptions dialog with the account selected.
 *
 * @returns {Promise<Window>}
 */
async function openSubscriptionsDialog() {
  const dialogPromise = BrowserTestUtils.domWindowOpenedAndLoaded(
    null,
    win =>
      win.location.href ==
      "chrome://messenger-newsblog/content/feed-subscriptions.xhtml"
  );
  window.openDialog(
    "chrome://messenger-newsblog/content/feed-subscriptions.xhtml",
    "",
    "centerscreen,chrome,dialog=no,resizable",
    { folder: rootFolder }
  );
  const dialogWindow = await dialogPromise;
  await TestUtils.waitForCondition(
    () =>
      dialogWindow.FeedSubscriptions.mView.currentItem?.folder == rootFolder,
    "waiting for the account to be selected"
  );
  return dialogWindow;
}

async function closeSubscriptionsDialog(dialogWindow) {
  const closedPromise = BrowserTestUtils.domWindowClosed(dialogWindow);
  dialogWindow.close();
  await closedPromise;
}

/**
 * Import an OPML file through the feed subscriptions dialog.
 *
 * @param {string} prefix - The namespace prefix used in the OPML file.
 */
async function importOPML(prefix) {
  const dialogWindow = await openSubscriptionsDialog();
  const { FeedSubscriptions } = dialogWindow;

  MockFilePicker.setFiles([
    new FileUtils.File(getTestFilePath(`data/opml-prefix-${prefix}.opml`)),
  ]);
  MockFilePicker.returnValue = MockFilePicker.returnOK;
  const importButton = dialogWindow.document.getElementById("importOPML");
  EventUtils.synthesizeMouseAtCenter(importButton, {}, dialogWindow);
  await TestUtils.waitForCondition(
    () =>
      FeedUtils.feedAlreadyExists(feedURL(prefix), server) &&
      FeedSubscriptions.mActionMode === null,
    "waiting for the import to finish"
  );

  await closeSubscriptionsDialog(dialogWindow);
}

/**
 * Check that the feed imported from the given OPML file kept the settings
 * from the file.
 *
 * @param {string} prefix - The namespace prefix used in the OPML file.
 */
function checkImportedFeed(prefix) {
  const url = feedURL(prefix);
  Assert.ok(
    FeedUtils.feedAlreadyExists(url, server),
    `feed from the ${prefix}: file should be subscribed`
  );
  Assert.ok(
    FeedUtils.getSubscriptionAttr(url, server, "quickMode", false),
    `feed from the ${prefix}: file should be in summary mode`
  );
  const options = FeedUtils.getSubscriptionAttr(url, server, "options", null);
  Assert.equal(
    options?.updates.enabled,
    false,
    `feed from the ${prefix}: file should be paused`
  );
  Assert.equal(
    options?.updates.updateMinutes,
    7,
    `feed from the ${prefix}: file should keep its update interval`
  );
}

add_task(async function testImportStandardPrefix() {
  await importOPML("fz");
  checkImportedFeed("fz");
});

add_task(async function testImportOtherPrefix() {
  await importOPML("tb");
  checkImportedFeed("tb");
});

add_task(async function testExport() {
  const dialogWindow = await openSubscriptionsDialog();
  const exportPath = PathUtils.join(PathUtils.tempDir, "opml-export.opml");
  registerCleanupFunction(() => IOUtils.remove(exportPath));

  MockFilePicker.setFiles([new FileUtils.File(exportPath)]);
  MockFilePicker.returnValue = MockFilePicker.returnOK;
  const exportButton = dialogWindow.document.getElementById("exportOPML");
  EventUtils.synthesizeMouseAtCenter(exportButton, {}, dialogWindow);
  await TestUtils.waitForCondition(
    () => IOUtils.exists(exportPath),
    "waiting for the export to be written"
  );
  await closeSubscriptionsDialog(dialogWindow);

  const text = await IOUtils.readUTF8(exportPath);
  Assert.equal(
    text.match(/xmlns:fz=/g)?.length,
    1,
    "export should declare the fz namespace once"
  );
  const doc = new DOMParser().parseFromString(text, "application/xml");
  Assert.equal(
    doc.documentElement.lookupNamespaceURI("fz"),
    FeedUtils.FZ_NS,
    "export should declare the fz namespace on the root"
  );
  for (const prefix of ["fz", "tb"]) {
    const outline = doc.querySelector(`outline[xmlUrl="${feedURL(prefix)}"]`);
    Assert.equal(
      outline?.getAttributeNS(FeedUtils.FZ_NS, "quickMode"),
      "true",
      `exported ${prefix}: feed should be in summary mode`
    );
    const options = JSON.parse(
      outline.getAttributeNS(FeedUtils.FZ_NS, "options")
    );
    Assert.equal(
      options.updates.enabled,
      false,
      `exported ${prefix}: feed should be paused`
    );
  }
});

add_task(async function test_importReusesExistingFolder() {
  const name = "OPML existing folder";
  const url = "https://example.invalid/opml-existing.xml";
  Assert.equal(rootFolder.getChildNamed(name), null);
  const folder = rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder(name);
  registerCleanupFunction(() => {
    FeedUtils.deleteFeed(new Feed(url, folder));
    rootFolder.propagateDelete(folder, true);
  });
  const message = new MessageGenerator().makeMessage();
  const header = folder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .addMessage(message.toMessageString());
  header.markRead(true);
  header.markFlagged(true);
  folder.setFlag(Ci.nsMsgFolderFlags.Favorite);
  const uri = folder.URI;
  const parentURI = folder.parent.URI;
  const path = folder.filePath.path;
  const flags = folder.flags;
  const key = header.messageKey;
  const messageId = header.messageId;
  const token = header.storeToken;
  const body = mailTestUtils.loadMessageToString(folder, header);
  const dialogWindow = await openSubscriptionsDialog();
  registerCleanupFunction(() => {
    if (!dialogWindow.closed) {
      return closeSubscriptionsDialog(dialogWindow);
    }
    return undefined;
  });
  const doc = new DOMParser().parseFromString(
    "<body><outline text='" +
      name +
      "'><outline type='rss' text='Existing feed' xmlUrl='" +
      url +
      "'/></outline></body>",
    "application/xml"
  );
  const result = await new Promise(resolve => {
    dialogWindow.FeedSubscriptions.importOPMLOutlines(
      doc.documentElement,
      server,
      (status, lastFolder) => resolve({ status, lastFolder })
    );
  });
  await closeSubscriptionsDialog(dialogWindow);

  Assert.ok(FeedUtils.feedAlreadyExists(url, server));
  Assert.equal(
    result.lastFolder.URI,
    uri,
    "The import uses the existing folder"
  );
  Assert.deepEqual(FeedUtils.getFeedUrlsInFolder(folder), [url]);
  const retained = rootFolder.getChildNamed(name);
  Assert.ok(retained);
  Assert.equal(retained.URI, uri);
  Assert.equal(retained.parent.URI, parentURI);
  Assert.equal(retained.filePath.path, path);
  Assert.equal(retained.flags, flags);
  Assert.equal(retained.getTotalMessages(false), 1);
  const stored = retained.GetMessageHeader(key);
  Assert.equal(stored.messageId, messageId);
  Assert.equal(stored.storeToken, token);
  Assert.ok(stored.isRead);
  Assert.ok(stored.isFlagged);
  Assert.equal(mailTestUtils.loadMessageToString(retained, stored), body);
});

add_task(async function test_importCreateCollisionKeepsOtherFolder() {
  const name = "OPML intervening folder";
  const skippedURL = "https://example.invalid/opml-skipped.xml";
  const nextName = "OPML after failed create";
  const nextURL = "https://example.invalid/opml-after-failure.xml";
  Assert.equal(rootFolder.getChildNamed(name), null);
  Assert.equal(rootFolder.getChildNamed(nextName), null);
  registerCleanupFunction(() => {
    for (const folderName of [name, nextName]) {
      const folder = rootFolder.getChildNamed(folderName);
      if (folder) {
        for (const url of FeedUtils.getFeedUrlsInFolder(folder) || []) {
          FeedUtils.deleteFeed(new Feed(url, folder));
        }
        rootFolder.propagateDelete(folder, true);
      }
    }
  });
  const dialogWindow = await openSubscriptionsDialog();
  registerCleanupFunction(() => {
    if (!dialogWindow.closed) {
      return closeSubscriptionsDialog(dialogWindow);
    }
    return undefined;
  });
  const localRoot = rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  const logger = FeedUtils.log;
  const originalInfo = logger.info;
  const errors = [];
  let intervened = false;
  let folder, key, messageId, token, flags, body, path, uri, parentURI;
  let expectedError;
  logger.info = function (message, ...args) {
    originalInfo.call(this, message, ...args);
    if (
      typeof message == "string" &&
      message.startsWith("importOPMLOutlines: creating folder - '" + name + "'")
    ) {
      Assert.ok(!intervened, "The import attempts this outline once");
      intervened = true;
      // Create real stored data after the import's preflight lookup.
      folder = localRoot.createLocalSubfolder(name);
      const header = folder
        .QueryInterface(Ci.nsIMsgLocalMailFolder)
        .addMessage(new MessageGenerator().makeMessage().toMessageString());
      header.markRead(true);
      header.markFlagged(true);
      folder.setFlag(Ci.nsMsgFolderFlags.Favorite);
      key = header.messageKey;
      messageId = header.messageId;
      token = header.storeToken;
      flags = folder.flags;
      body = mailTestUtils.loadMessageToString(folder, header);
      path = folder.filePath.path;
      uri = folder.URI;
      parentURI = folder.parent.URI;
      // Capture the real duplicate-create error; the importer must hit it too.
      try {
        localRoot.createLocalSubfolder(name);
      } catch (error) {
        expectedError = error.result;
      }
      Assert.notEqual(expectedError, undefined);
      Assert.ok(!Components.isSuccessCode(expectedError));
    } else if (
      typeof message == "string" &&
      message.startsWith(
        "importOPMLOutlines: skipping, error creating folder - '" + name + "'"
      )
    ) {
      errors.push(args[0]);
    }
  };
  let result;
  try {
    const doc = new DOMParser().parseFromString(
      "<body><outline text='" +
        name +
        "'><outline type='rss' text='Skipped' xmlUrl='" +
        skippedURL +
        "'/></outline>" +
        "<outline type='rss' text='" +
        nextName +
        "' xmlUrl='" +
        nextURL +
        "'/></body>",
      "application/xml"
    );
    result = await new Promise(resolve => {
      dialogWindow.FeedSubscriptions.importOPMLOutlines(
        doc.documentElement,
        server,
        (status, lastFolder) => resolve({ status, lastFolder })
      );
    });
  } finally {
    logger.info = originalInfo;
  }
  await closeSubscriptionsDialog(dialogWindow);

  Assert.ok(intervened, "The collision follows the successful preflight check");
  Assert.ok(!FeedUtils.feedAlreadyExists(skippedURL, server));
  Assert.ok(
    FeedUtils.feedAlreadyExists(nextURL, server),
    "Import continues after failure"
  );
  Assert.equal(result.lastFolder.name, nextName);
  Assert.deepEqual(FeedUtils.getFeedUrlsInFolder(result.lastFolder), [nextURL]);
  const retained = rootFolder.getChildNamed(name);
  Assert.ok(
    retained,
    "The failed import must not delete the other creator's folder"
  );
  Assert.equal(retained.URI, uri);
  Assert.equal(retained.parent.URI, parentURI);
  Assert.equal(retained.name, name);
  Assert.equal(retained.filePath.path, path);
  Assert.equal(retained.flags, flags);
  Assert.equal(retained.getTotalMessages(false), 1);
  const stored = retained.GetMessageHeader(key);
  Assert.equal(stored.messageId, messageId);
  Assert.equal(stored.storeToken, token);
  Assert.ok(stored.isRead);
  Assert.ok(stored.isFlagged);
  Assert.equal(mailTestUtils.loadMessageToString(retained, stored), body);
  Assert.equal(errors.length, 1, "The original create error is logged once");
  Assert.ok(errors[0], "The caught native error is retained in the log");
  Assert.equal(errors[0].result, expectedError);
});
