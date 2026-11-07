/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

const { be_in_folder, create_folder, get_about_message, select_click_row } =
  ChromeUtils.importESModule(
    "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
  );
const { add_message_to_folder, create_message } = ChromeUtils.importESModule(
  "resource://testing-common/mail/MessageInjectionHelpers.sys.mjs"
);

const aboutMessage = get_about_message();

const mimeService = Cc["@mozilla.org/mime;1"].getService(Ci.nsIMIMEService);
const handlerService = Cc[
  "@mozilla.org/uriloader/handler-service;1"
].getService(Ci.nsIHandlerService);

const { MockFilePicker } = SpecialPowers;
MockFilePicker.init(window.browsingContext);

// At the time of writing, this pref was set to true on nightly channels only.
// The behaviour is slightly different when it is false.
const IMPROVEMENTS_PREF_SET = Services.prefs.getBoolPref(
  "browser.download.improvements_to_download_panel",
  true
);

let tmpD;
let savePath;
let homeDirectory;

let folder;

let mockedHandlerApp;
const mockedHandlers = new Set();

function getNsIFileFromPath(path) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  return file;
}

add_setup(async function () {
  folder = await create_folder("OpenAttachment");
  await be_in_folder(folder);

  // @see logic for tmpD in msgHdrView.js
  tmpD = PathUtils.join(PathUtils.tempDir, "pid-" + Services.appinfo.processID);

  savePath = await IOUtils.createUniqueDirectory(tmpD, "saveDestination");

  homeDirectory = await IOUtils.createUniqueDirectory(tmpD, "homeDirectory");

  homeDirectory = await IOUtils.createUniqueDirectory(tmpD, "homeDirectory");

  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.download.dir", savePath],
      ["browser.download.folderList", 2],
      ["browser.download.useDownloadDir", true],
      ["security.dialog_enable_delay", 0],
    ],
  });

  const mockExePath = PathUtils.join(PathUtils.tempDir, "mockedExecutable");
  await IOUtils.write(mockExePath, new Uint8Array(), {
    mode: "appendOrCreate",
  });
  await IOUtils.setPermissions(mockExePath, 0o755);
  const mockedExecutable = await IOUtils.getFile(mockExePath);

  mockedHandlerApp = Cc[
    "@mozilla.org/uriloader/local-handler-app;1"
  ].createInstance(Ci.nsILocalHandlerApp);
  mockedHandlerApp.executable = mockedExecutable;
  mockedHandlerApp.detailedDescription = "Mocked handler app";
  registerCleanupFunction(() => {
    if (mockedExecutable.exists()) {
      mockedExecutable.remove(true);
    }
  });
});

// The shared folder must remain live while owned fixtures leave their current
// selection. Register this before the original shared-folder cleanup.
const { select_none: s376SelectNone } = ChromeUtils.importESModule(
  "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
);
const s376LocalFolders = [];
let s376NewsPrefPushed = false;
registerCleanupFunction(async function cleanupSelectedAttachmentFixtures() {
  if (s376LocalFolders.length || s376Imap || s376News) {
    await be_in_folder(folder);
    await s376SelectNone();
  }
  for (const selectedFolder of s376LocalFolders) {
    selectedFolder.deleteSelf(null);
  }
  if (s376Imap) {
    s376Imap.incoming.closeCachedConnections();
    MailServices.accounts.removeAccount(s376Imap.account, false);
    s376Imap.server.close();
    s376Imap = null;
  }
  if (s376News) {
    s376News.incoming.closeCachedConnections();
    MailServices.accounts.removeAccount(s376News.account, false);
    s376News.helpers.shutdownNNTPServer(s376News.server);
    s376News = null;
  }
  if (s376NewsPrefPushed) {
    await SpecialPowers.popPrefEnv();
    s376NewsPrefPushed = false;
  }
});

registerCleanupFunction(async function () {
  MockFilePicker.cleanup();

  await IOUtils.remove(savePath, { recursive: true });
  await IOUtils.remove(homeDirectory, { recursive: true });

  for (const type of mockedHandlers) {
    const handlerInfo = mimeService.getFromTypeAndExtension(type, null);
    if (handlerService.exists(handlerInfo)) {
      handlerService.remove(handlerInfo);
    }
  }

  // Remove created folders.
  folder.deleteSelf(null);

  Services.focus.focusedWindow = window;
});

function createMockedHandler(type, preferredAction, alwaysAskBeforeHandling) {
  info(`Creating handler for ${type}`);

  const handlerInfo = mimeService.getFromTypeAndExtension(type, null);
  handlerInfo.preferredAction = preferredAction;
  handlerInfo.alwaysAskBeforeHandling = alwaysAskBeforeHandling;

  handlerInfo.description = mockedHandlerApp.detailedDescription;
  handlerInfo.possibleApplicationHandlers.appendElement(mockedHandlerApp);
  handlerInfo.hasDefaultHandler = true;
  handlerInfo.preferredApplicationHandler = mockedHandlerApp;

  handlerService.store(handlerInfo);
  mockedHandlers.add(type);
}

let messageIndex = -1;
async function createAndLoadMessage(
  type,
  { filename, isDetached = false } = {}
) {
  messageIndex++;

  if (!filename) {
    filename = `attachment${messageIndex}.test${messageIndex}`;
  }

  const attachment = {
    contentType: type,
    body: `${type}Attachment`,
    filename,
  };

  // Allow for generation of messages with detached attachments.
  if (isDetached) {
    // Generate a file with content to represent the attachment.
    const attachmentFile = Cc["@mozilla.org/file/local;1"].createInstance(
      Ci.nsIFile
    );
    attachmentFile.initWithPath(homeDirectory);
    attachmentFile.append(filename);
    if (!attachmentFile.exists()) {
      attachmentFile.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o755);
      await IOUtils.writeUTF8(attachmentFile.path, "some file content");
    }

    const fileHandler = Services.io
      .getProtocolHandler("file")
      .QueryInterface(Ci.nsIFileProtocolHandler);

    // Append relevant Thunderbird headers to indicate a detached file.
    attachment.extraHeaders = {
      "X-Mozilla-External-Attachment-URL":
        fileHandler.getURLSpecFromActualFile(attachmentFile),
      "X-Mozilla-Altered":
        'AttachmentDetached; date="Mon Apr 04 13:59:42 2022"',
    };
  }

  await add_message_to_folder(
    [folder],
    create_message({
      subject: `${type} attachment`,
      body: {
        body: "I'm an attached email!",
      },
      attachments: [attachment],
    })
  );
  await select_click_row(messageIndex);
}

async function singleClickAttachmentAndWaitForDialog(
  { mode = "save", rememberExpected = true, remember } = {},
  button = "cancel"
) {
  const dialogPromise = BrowserTestUtils.promiseAlertDialog(
    undefined,
    "chrome://mozapps/content/downloads/unknownContentType.xhtml",
    {
      async callback(dialogWindow) {
        // Wait for the buttons to be enabled, which requires focus plus
        // clearing the event queue.
        await SimpleTest.promiseFocus(dialogWindow);
        await TestUtils.waitForTick();

        const dialogDocument = dialogWindow.document;
        const rememberChoice = dialogDocument.getElementById("rememberChoice");
        Assert.equal(
          dialogDocument.getElementById("mode").selectedItem.id,
          mode,
          "correct action is selected"
        );
        Assert.equal(
          rememberChoice.checked,
          rememberExpected,
          "remember choice checkbox checked/not checked as expected"
        );
        if (remember !== undefined && remember != rememberExpected) {
          EventUtils.synthesizeMouseAtCenter(rememberChoice, {}, dialogWindow);
          Assert.equal(
            rememberChoice.checked,
            remember,
            "remember choice checkbox changed"
          );
        }

        dialogDocument.querySelector("dialog").getButton(button).click();
      },
    }
  );

  info(aboutMessage.document.getElementById("attachmentName").value);
  EventUtils.synthesizeMouseAtCenter(
    aboutMessage.document.getElementById("attachmentName"),
    {},
    aboutMessage
  );
  await dialogPromise;
}

async function singleClickAttachment() {
  info(aboutMessage.document.getElementById("attachmentName").value);
  EventUtils.synthesizeMouseAtCenter(
    aboutMessage.document.getElementById("attachmentName"),
    {},
    aboutMessage
  );
}

// Other test boilerplate should initialize a message with attachment; here we
// verify that it was created and return an nsIFile handle to it.
async function verifyAndFetchSavedAttachment(parentPath = savePath, leafName) {
  const expectedFile = getNsIFileFromPath(parentPath);
  if (leafName) {
    expectedFile.append(leafName);
  } else {
    expectedFile.append(`attachment${messageIndex}.test${messageIndex}`);
  }
  await TestUtils.waitForCondition(
    () => expectedFile.exists(),
    `attachment was not saved to ${expectedFile.path}`
  );
  Assert.ok(expectedFile.exists(), `${expectedFile.path} exists`);

  return expectedFile;
}

/** @param {nsIFile} file - File to delete. */
async function deleteAttachmentFile(file) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      // Wait a moment in case the file is still locked for writing.
      // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    try {
      await IOUtils.remove(file.path, { retryReadonly: true });
      info(`File '${file.path}' removed`);
      return;
    } catch (e) {
      if (attempt < 2) {
        info(`Removing file attempt ${attempt} FAILED: ${e}`);
      } else {
        info(`All attempts to remove file attempt ${attempt} FAILED: ${e}`);
        throw e;
      }
    }
  }
}

function checkHandler(type, preferredAction, alwaysAskBeforeHandling) {
  const handlerInfo = mimeService.getFromTypeAndExtension(type, null);
  Assert.equal(
    handlerInfo.preferredAction,
    preferredAction,
    `preferredAction of ${type}`
  );
  Assert.equal(
    handlerInfo.alwaysAskBeforeHandling,
    alwaysAskBeforeHandling,
    `alwaysAskBeforeHandling of ${type}`
  );
}

function promiseFileOpened() {
  const __openFile = aboutMessage.AttachmentInfo.prototype._openFile;
  return new Promise(resolve => {
    aboutMessage.AttachmentInfo.prototype._openFile = function (
      mimeInfo,
      file
    ) {
      aboutMessage.AttachmentInfo.prototype._openFile = __openFile;
      resolve({ mimeInfo, file });
    };
  });
}

/**
 * Check that the directory for saving is correct.
 * If not, we're gonna have a bad time.
 */
add_task(async function sanityCheck() {
  Assert.equal(
    await Downloads.getPreferredDownloadsDirectory(),
    savePath,
    "sanity check: correct downloads directory"
  );
});

// First, check content types we have no saved information about.

/**
 * Open a content type we've never seen before. Save, and remember the action.
 */
add_task(async function noHandler() {
  await createAndLoadMessage("test/foo");
  await singleClickAttachmentAndWaitForDialog(
    { rememberExpected: false, remember: true },
    "accept"
  );
  const file = await verifyAndFetchSavedAttachment();
  await deleteAttachmentFile(file);
  checkHandler("test/foo", Ci.nsIHandlerInfo.saveToDisk, false);
});

/**
 * Open a content type we've never seen before. Save, and DON'T remember the
 * action (except that we do remember it, but also remember to ask next time).
 */
add_task(async function noHandlerNoSave() {
  await createAndLoadMessage("test/bar");
  await singleClickAttachmentAndWaitForDialog(
    { rememberExpected: false, remember: false },
    "accept"
  );
  const file = await verifyAndFetchSavedAttachment();
  await deleteAttachmentFile(file);
  checkHandler("test/bar", Ci.nsIHandlerInfo.saveToDisk, true);
});

/**
 * The application/octet-stream type is handled weirdly. Check that opening it
 * still behaves in a useful way.
 */
add_task(async function applicationOctetStream() {
  await createAndLoadMessage("application/octet-stream");
  await singleClickAttachmentAndWaitForDialog(
    { rememberExpected: false },
    "accept"
  );
  const file = await verifyAndFetchSavedAttachment();
  await deleteAttachmentFile(file);
});

// Now we'll test the various states that handler info objects might be in.
// There's two fields: preferredAction and alwaysAskBeforeHandling. If the
// latter is true, we MUST get a prompt. Check that first.

/**
 * Open a content type set to save to disk, but always ask.
 */
add_task(async function saveToDiskAlwaysAsk() {
  createMockedHandler(
    "test/saveToDisk-true",
    Ci.nsIHandlerInfo.saveToDisk,
    true
  );
  await createAndLoadMessage("test/saveToDisk-true");
  await singleClickAttachmentAndWaitForDialog(
    { rememberExpected: false },
    "accept"
  );
  const file = await verifyAndFetchSavedAttachment();
  await deleteAttachmentFile(file);
  checkHandler("test/saveToDisk-true", Ci.nsIHandlerInfo.saveToDisk, true);
});

/**
 * Open a content type set to save to disk, but always ask, and with no
 * default download directory.
 */
add_task(async function saveToDiskAlwaysAskPromptLocation() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.download.useDownloadDir", false]],
  });

  createMockedHandler(
    "test/saveToDisk-true",
    Ci.nsIHandlerInfo.saveToDisk,
    true
  );
  await createAndLoadMessage("test/saveToDisk-true");

  const expectedFile = getNsIFileFromPath(tmpD);
  expectedFile.append(`attachment${messageIndex}.test${messageIndex}`);
  MockFilePicker.showCallback = function (instance) {
    Assert.equal(instance.defaultString, expectedFile.leafName);
    Assert.equal(instance.defaultExtension, `test${messageIndex}`);
  };
  MockFilePicker.setFiles([expectedFile]);
  MockFilePicker.returnValue = Ci.nsIFilePicker.returnOK;

  await singleClickAttachmentAndWaitForDialog(
    { rememberExpected: false },
    "accept"
  );
  const file = await verifyAndFetchSavedAttachment(tmpD);
  await deleteAttachmentFile(file);
  Assert.ok(MockFilePicker.shown, "file picker was shown");

  MockFilePicker.reset();
  await SpecialPowers.popPrefEnv();
});

/**
 * Open a content type set to always ask in both fields.
 */
add_task(async function alwaysAskAlwaysAsk() {
  createMockedHandler("test/alwaysAsk-true", Ci.nsIHandlerInfo.alwaysAsk, true);
  await createAndLoadMessage("test/alwaysAsk-true");
  await singleClickAttachmentAndWaitForDialog({
    mode: IMPROVEMENTS_PREF_SET ? "save" : "open",
    rememberExpected: false,
  });
});

/**
 * Open a content type set to use helper app, but always ask.
 */
add_task(async function useHelperAppAlwaysAsk() {
  createMockedHandler(
    "test/useHelperApp-true",
    Ci.nsIHandlerInfo.useHelperApp,
    true
  );
  await createAndLoadMessage("test/useHelperApp-true");
  await singleClickAttachmentAndWaitForDialog({
    mode: "open",
    rememberExpected: false,
  });
});

/*
 * Open a detached attachment with content type set to use helper app, but
 * always ask.
 */
add_task(async function detachedUseHelperAppAlwaysAsk() {
  const mimeType = "test/useHelperApp-true";
  const openedPromise = promiseFileOpened();

  createMockedHandler(mimeType, Ci.nsIHandlerInfo.useHelperApp, true);

  // Generate an email with detached attachment.
  await createAndLoadMessage(mimeType, { isDetached: true });
  await singleClickAttachmentAndWaitForDialog(
    { mode: "open", rememberExpected: false },
    "accept"
  );

  const expectedPath = PathUtils.join(
    homeDirectory,
    `attachment${messageIndex}.test${messageIndex}`
  );

  const { file } = await openedPromise;
  Assert.equal(
    file.path,
    expectedPath,
    "opened file should match attachment path"
  );

  await deleteAttachmentFile(file);
});

/**
 * Open a content type set to use the system default app, but always ask.
 */
add_task(async function useSystemDefaultAlwaysAsk() {
  createMockedHandler(
    "test/useSystemDefault-true",
    Ci.nsIHandlerInfo.useSystemDefault,
    true
  );
  await createAndLoadMessage("test/useSystemDefault-true");
  // Would be mode: "open" on all platforms except our handler isn't real.
  await singleClickAttachmentAndWaitForDialog({
    mode: AppConstants.platform == "win" ? "open" : "save",
    rememberExpected: false,
  });
});

// Check what happens with alwaysAskBeforeHandling set to false. We can't test
// the actions that would result in an external app opening the file.

/**
 * Open a content type set to save to disk without asking.
 */
add_task(async function saveToDisk() {
  createMockedHandler("test/saveToDisk-false", saveToDisk, false);
  await createAndLoadMessage("test/saveToDisk-false");
  await singleClickAttachment();
  const file = await verifyAndFetchSavedAttachment();
  await deleteAttachmentFile(file);
});

/**
 * Open a content type set to save to disk without asking, and with no
 * default download directory.
 */
add_task(async function saveToDiskPromptLocation() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.download.useDownloadDir", false]],
  });

  createMockedHandler(
    "test/saveToDisk-true",
    Ci.nsIHandlerInfo.saveToDisk,
    false
  );
  await createAndLoadMessage("test/saveToDisk-false");

  const expectedFile = getNsIFileFromPath(tmpD);
  expectedFile.append(`attachment${messageIndex}.test${messageIndex}`);
  MockFilePicker.showCallback = function (instance) {
    Assert.equal(instance.defaultString, expectedFile.leafName);
    Assert.equal(instance.defaultExtension, `test${messageIndex}`);
  };
  MockFilePicker.setFiles([expectedFile]);
  MockFilePicker.returnValue = Ci.nsIFilePicker.returnOK;

  await singleClickAttachment();
  const file = await verifyAndFetchSavedAttachment(tmpD);
  await deleteAttachmentFile(file);
  Assert.ok(MockFilePicker.shown, "file picker was shown");

  MockFilePicker.reset();
  await SpecialPowers.popPrefEnv();
});

/**
 * Open a content type set to always ask without asking (weird but plausible).
 * Check the action is saved and the "do this automatically" checkbox works.
 */
add_task(async function alwaysAskRemember() {
  createMockedHandler(
    "test/alwaysAsk-false",
    Ci.nsIHandlerInfo.alwaysAsk,
    false
  );
  await createAndLoadMessage("test/alwaysAsk-false");
  await singleClickAttachmentAndWaitForDialog(undefined, "accept");
  const file = await verifyAndFetchSavedAttachment();
  await deleteAttachmentFile(file);
  checkHandler("test/alwaysAsk-false", Ci.nsIHandlerInfo.saveToDisk, false);
}).skip(!IMPROVEMENTS_PREF_SET);

/**
 * Open a content type set to always ask without asking (weird but plausible).
 * Check the action is saved and the unticked "do this automatically" leaves
 * alwaysAskBeforeHandling set.
 */
add_task(async function alwaysAskForget() {
  createMockedHandler(
    "test/alwaysAsk-false",
    Ci.nsIHandlerInfo.alwaysAsk,
    false
  );
  await createAndLoadMessage("test/alwaysAsk-false");
  await singleClickAttachmentAndWaitForDialog({ remember: false }, "accept");
  const file = await verifyAndFetchSavedAttachment();
  await deleteAttachmentFile(file);
  checkHandler("test/alwaysAsk-false", Ci.nsIHandlerInfo.saveToDisk, true);
}).skip(!IMPROVEMENTS_PREF_SET);

/**
 * Open a content type set to use helper app.
 */
add_task(async function useHelperApp() {
  const openedPromise = promiseFileOpened();

  createMockedHandler(
    "test/useHelperApp-false",
    Ci.nsIHandlerInfo.useHelperApp,
    false
  );
  await createAndLoadMessage("test/useHelperApp-false");
  await singleClickAttachment();
  const attachmentFile = await verifyAndFetchSavedAttachment(tmpD);

  const { file } = await openedPromise;
  Assert.ok(file.path);

  // In the temp dir, files should be read-only.
  if (AppConstants.platform != "win") {
    const fileInfo = await IOUtils.stat(file.path);
    Assert.equal(
      fileInfo.permissions,
      0o400,
      `file ${file.path} should be read-only`
    );
  }
  attachmentFile.permissions = 0o755;
  await deleteAttachmentFile(attachmentFile);
});

/*
 * Open a detached attachment with content type set to use helper app.
 */
add_task(async function detachedUseHelperApp() {
  const mimeType = "test/useHelperApp-false";
  const openedPromise = promiseFileOpened();

  createMockedHandler(mimeType, Ci.nsIHandlerInfo.useHelperApp, false);

  // Generate an email with detached attachment.
  await createAndLoadMessage(mimeType, { isDetached: true });
  await singleClickAttachment();

  const expectedPath = PathUtils.join(
    homeDirectory,
    `attachment${messageIndex}.test${messageIndex}`
  );

  const { file } = await openedPromise;
  Assert.equal(
    file.path,
    expectedPath,
    "opened file should match attachment path"
  );

  await deleteAttachmentFile(file);
});

/**
 * Open a content type set to use the system default app.
 */
add_task(async function useSystemDefault() {
  const openedPromise = promiseFileOpened();

  createMockedHandler(
    "test/useSystemDefault-false",
    Ci.nsIHandlerInfo.useSystemDefault,
    false
  );
  await createAndLoadMessage("test/useSystemDefault-false");
  await singleClickAttachment();
  const attachmentFile = await verifyAndFetchSavedAttachment(tmpD);
  const { file } = await openedPromise;
  Assert.ok(file.path);

  // In the temp dir, files should be read-only.
  if (AppConstants.platform != "win") {
    const fileInfo = await IOUtils.stat(file.path);
    Assert.equal(
      fileInfo.permissions,
      0o400,
      `file ${file.path} should be read-only`
    );
  }
  attachmentFile.permissions = 0o755;
  await deleteAttachmentFile(attachmentFile);
});

/*
 * Open a detached attachment with content type set to use the system default
 * app.
 */
add_task(async function detachedUseSystemDefault() {
  const mimeType = "test/useSystemDefault-false";
  const openedPromise = promiseFileOpened();

  createMockedHandler(mimeType, Ci.nsIHandlerInfo.useSystemDefault, false);

  // Generate an email with detached attachment.
  await createAndLoadMessage(mimeType, { isDetached: true });
  await singleClickAttachment();

  const expectedPath = PathUtils.join(
    homeDirectory,
    `attachment${messageIndex}.test${messageIndex}`
  );

  const { file } = await openedPromise;
  Assert.equal(
    file.path,
    expectedPath,
    "opened file should match attachment path"
  );

  await deleteAttachmentFile(file);
});

/**
 * Save an attachment with characters that are illegal in a file name.
 * Check the characters are sanitized.
 */
add_task(async function filenameSanitisedSave() {
  createMockedHandler("test/bar", Ci.nsIHandlerInfo.saveToDisk, false);

  // Colon, slash and backslash are escaped on all platforms.
  // Backslash is double-escaped here because of the message generator.
  await createAndLoadMessage("test/bar", { filename: "f:i\\\\le/123.bar" });
  await singleClickAttachment();
  let file = await verifyAndFetchSavedAttachment(undefined, "f_i_le_123.bar");
  await deleteAttachmentFile(file);

  // Asterisk, question mark, pipe and angle brackets are escaped on Windows.
  await createAndLoadMessage("test/bar", { filename: "f*i?|le<123>.bar" });
  await singleClickAttachment();
  file = await verifyAndFetchSavedAttachment(undefined, "f_i__le_123_.bar");
  await deleteAttachmentFile(file);
});

/**
 * Open an attachment with characters that are illegal in a file name.
 * Check the characters are sanitized.
 */
add_task(async function filenameSanitisedOpen() {
  createMockedHandler("test/bar", Ci.nsIHandlerInfo.useHelperApp, false);

  let openedPromise = promiseFileOpened();

  // Colon, slash and backslash are escaped on all platforms.
  // Backslash is double-escaped here because of the message generator.
  await createAndLoadMessage("test/bar", { filename: "f:i\\\\le/123.bar" });
  await singleClickAttachment();
  let { file } = await openedPromise;
  let attachmentFile = await verifyAndFetchSavedAttachment(
    tmpD,
    "f_i_le_123.bar"
  );
  Assert.equal(file.leafName, "f_i_le_123.bar");
  // In the temp dir, files should be read-only.
  if (AppConstants.platform != "win") {
    const fileInfo = await IOUtils.stat(file.path);
    Assert.equal(
      fileInfo.permissions,
      0o400,
      `file ${file.path} should be read-only`
    );
  }
  attachmentFile.permissions = 0o755;
  await deleteAttachmentFile(attachmentFile);

  openedPromise = promiseFileOpened();

  // Asterisk, question mark, pipe and angle brackets are escaped on Windows.
  await createAndLoadMessage("test/bar", { filename: "f*i?|le<123>.bar" });
  await singleClickAttachment();
  ({ file } = await openedPromise);
  attachmentFile = await verifyAndFetchSavedAttachment(
    tmpD,
    "f_i__le_123_.bar"
  );
  Assert.equal(file.leafName, "f_i__le_123_.bar");
  attachmentFile.permissions = 0o755;
  await deleteAttachmentFile(attachmentFile);
});

const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

let s376FolderNumber = 0;
let s376Imap;
let s376News;

/**
 * Create and display a real selected local multipart message.
 *
 * @param {string} body - Exact attachment bytes.
 * @param {string} [contentType] - Attachment media type.
 * @param {string} [name] - Attachment name.
 * @returns {Promise<object>} Selected folder, header and actual reader attachment.
 */
async function s376LocalAttachment(
  body,
  contentType = "text/plain",
  name = "selected.txt"
) {
  const selectedFolder = await create_folder(`S376Open${s376FolderNumber++}`);
  s376LocalFolders.push(selectedFolder);
  const message = create_message({
    attachments: [{ body, contentType, filename: name, format: "" }],
  });
  await add_message_to_folder([selectedFolder], message);
  const [header] = [...selectedFolder.messages];
  await be_in_folder(selectedFolder);
  await select_click_row(0);
  await TestUtils.waitForCondition(
    () => aboutMessage.currentAttachments.length == 1
  );
  const [attachment] = aboutMessage.currentAttachments;
  Assert.equal(attachment.message.messageKey, header.messageKey);
  Assert.equal(attachment.message.folder.URI, selectedFolder.URI);
  const expectedStore = Services.prefs
    .getStringPref("mail.serverDefaultStoreContractID")
    .includes("maildirstore")
    ? "maildir"
    : "mbox";
  Assert.equal(selectedFolder.msgStore.storeType, expectedStore);
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    Assert.ok(
      Cc["@mozilla.org/mailnews/database-core;1"].getService(Ci.nsIDatabaseCore)
        .sourceId
    );
  }
  return { selectedFolder, header, attachment };
}

/**
 * Construct an unfetched part request from an actual selected physical header.
 *
 * @param {nsIMsgDBHdr} header - Ingested header in its real folder.
 * @returns {AttachmentInfo} Existing ordinary attachment caller.
 */
function s376UnfetchedAttachment(header) {
  const { AttachmentInfo } = ChromeUtils.importESModule(
    "resource:///modules/AttachmentInfo.sys.mjs"
  );
  const uri = header.folder.getUriForMsg(header);
  const url = MailServices.messageServiceFromURI(uri).getUrlForUri(uri).spec;
  return new AttachmentInfo({
    contentType: "text/plain",
    name: "selected.txt",
    uri,
    url: `${url}${url.includes("?") ? "&" : "?"}part=1.2&type=text/plain&filename=selected.txt`,
    message: header,
    isExternalAttachment: false,
  });
}

/**
 * Allocate only this test's save directory and remove its own download records.
 *
 * @returns {Promise<string>} Unique owned directory.
 */
async function s376SaveDirectory() {
  const path = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "s376-attachment"
  );
  registerCleanupFunction(async () => {
    const { Downloads } = ChromeUtils.importESModule(
      "resource://gre/modules/Downloads.sys.mjs"
    );
    const list = await Downloads.getList(Downloads.ALL);
    for (const download of await list.getAll()) {
      if (PathUtils.parent(download.target.path) == path) {
        await list.remove(download);
        await download.finalize(true);
      }
    }
    await IOUtils.remove(path, { recursive: true });
  });
  return path;
}

add_task(async function test_selectedLocalAttachmentBytesAndSavedTarget() {
  const body = "S376 selected local attachment, not another physical copy.";
  const { attachment } = await s376LocalAttachment(body);
  const directory = await s376SaveDirectory();
  const target = PathUtils.join(directory, "selected.txt");
  Assert.equal(
    new TextDecoder().decode(await attachment.fetchAttachment()),
    body
  );
  await attachment.saveToFile(target);
  Assert.equal(await IOUtils.readUTF8(target), body);
  Assert.deepEqual(await IOUtils.getChildren(directory), [target]);
});

add_task(async function test_imapAttachmentRetainsPhysicalSourceAndPart() {
  const { IMAPServer } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/IMAPServer.sys.mjs"
  );
  const { MessageGenerator } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
  );
  const { PromiseTestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
  );
  const server = new IMAPServer({ extensions: ["RFC4315"] });
  const account = MailServices.accounts.createAccount();
  const incoming = MailServices.accounts.createIncomingServer(
    "user",
    "localhost",
    "imap"
  );
  account.incomingServer = incoming;
  const identity = MailServices.accounts.createIdentity();
  identity.email = "s376-attachment@example.invalid";
  account.addIdentity(identity);
  incoming.port = server.port;
  incoming.password = "password";
  incoming.QueryInterface(Ci.nsIImapIncomingServer).maximumConnectionsNumber =
    1;
  incoming.useIdle = false;
  incoming.setBoolValue("autosync_offline_stores", false);
  s376Imap = { server, incoming, account };
  server.daemon.createMailbox("S376Other", { subscribed: true });
  for (const name of ["INBOX", "S376Other"]) {
    const mailbox = server.daemon.getMailbox(name);
    mailbox.uidvalidity = 7631;
    mailbox.uidnext = 5101;
  }
  const discovery = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(incoming.rootFolder, discovery, null);
  await discovery.promise;
  const folders = ["INBOX", "S376Other"].map(name =>
    incoming.rootFolder.getChildNamed(name)
  );
  const generator = new MessageGenerator();
  for (const [index, selectedFolder] of folders.entries()) {
    const body = `S376 IMAP physical part ${index}`;
    const message = generator.makeMessage({
      attachments: [{ body, filename: "selected.txt", format: "" }],
    });
    message.messageId = "s376-overlapping-imap@example.invalid";
    await server.addMessages(selectedFolder, [message]);
    const [header] = [...selectedFolder.messages];
    if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
      Assert.notEqual(
        header.messageKey,
        5101,
        "the physical key is not the wire UID"
      );
    }
    await be_in_folder(selectedFolder);
    await select_click_row(0);
    const reader = get_about_message();
    const [attachment] = reader.currentAttachments;
    Assert.equal(attachment.partID, "1.2");
    Assert.equal(attachment.message.folder.URI, selectedFolder.URI);
    Assert.equal(attachment.message.messageKey, header.messageKey);
    Assert.equal(
      new TextDecoder().decode(await attachment.fetchAttachment()),
      body
    );
    incoming.closeCachedConnections();
    Assert.equal(
      new TextDecoder().decode(await attachment.fetchAttachment()),
      body,
      "reconnect/cache reuse still names the selected physical part"
    );
  }
  // A MIME-supplied decoded file remains a file, even when its selected
  // parent is IMAP. This checks the carrier contract, not crypto decryption.
  const { AttachmentInfo } = ChromeUtils.importESModule(
    "resource:///modules/AttachmentInfo.sys.mjs"
  );
  const [selected] = [...folders[0].messages];
  const directory = await s376SaveDirectory();
  const file = PathUtils.join(directory, "mime-supplied.txt");
  const decoded = "Decoded bytes supplied by the current MIME reader.";
  await IOUtils.writeUTF8(file, decoded);
  const supplied = new AttachmentInfo({
    contentType: "text/plain",
    name: "mime-supplied.txt",
    url: `${PathUtils.toFileURI(file)}?part=1.2`,
    uri: selected.folder.getUriForMsg(selected),
    message: selected,
    isExternalAttachment: false,
  });
  Assert.equal(
    new TextDecoder().decode(await supplied.fetchAttachment()),
    decoded,
    "The local MIME-supplied part is not replaced by the IMAP wire part"
  );
  s376Imap = { server, incoming, account, folders, generator };
});

add_task(async function test_nntpAttachmentRetainsPhysicalSourceAndPart() {
  await SpecialPowers.pushPrefEnv({ set: [["mail.strict_threading", true]] });
  s376NewsPrefPushed = true;
  const helpers = ChromeUtils.importESModule(
    "resource://testing-common/mail/NNTPHelpers.sys.mjs"
  );
  const { NewsArticle } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/Nntpd.sys.mjs"
  );
  const { MessageGenerator } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
  );
  const { PromiseTestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
  );
  const daemon = helpers.setupNNTPDaemon();
  const names = ["test.filter", "test.subscribe.empty"];
  const generator = new MessageGenerator();
  for (const [index, name] of names.entries()) {
    const message = generator.makeMessage({
      attachments: [
        {
          body: `S376 NNTP physical part ${index}`,
          filename: "selected.txt",
          format: "",
        },
      ],
    });
    message.messageId = "s376-overlapping-news@example.invalid";
    daemon.addArticleToGroup(
      new NewsArticle(message.toMessageString()),
      name,
      101
    );
  }
  const server = helpers.startupNNTPServer(daemon, helpers.NNTP_PORT);
  const incoming = helpers.setupLocalServer(helpers.NNTP_PORT);
  const account = [...MailServices.accounts.accounts].find(
    a => a.incomingServer == incoming
  );
  s376News = { server, incoming, account, helpers };
  const folders = names.map(name => incoming.rootFolder.getChildNamed(name));
  for (const [index, selectedFolder] of folders.entries()) {
    const listener = new PromiseTestUtils.PromiseUrlListener();
    selectedFolder.getNewMessages(null, listener);
    await listener.promise;
    const [header] = [...selectedFolder.messages];
    Assert.ok(header, "normal NNTP overview ingests the real physical header");
    await be_in_folder(selectedFolder);
    await select_click_row(0);
    const reader = get_about_message();
    const [attachment] = reader.currentAttachments;
    Assert.equal(attachment.message.folder.URI, selectedFolder.URI);
    Assert.equal(attachment.message.messageKey, header.messageKey);
    Assert.equal(attachment.partID, "1.2");
    Assert.equal(
      new TextDecoder().decode(await attachment.fetchAttachment()),
      `S376 NNTP physical part ${index}`
    );
    Assert.equal(
      reader.CanDetachAttachments(),
      false,
      "NNTP detachment stays unavailable"
    );
  }
  s376News = {
    server,
    incoming,
    account,
    helpers,
    folders,
    names,
    daemon,
    generator,
    NewsArticle,
    PromiseTestUtils,
  };
});

add_task(async function test_attachmentStaleSelectionRejectsBeforeOpening() {
  const { selectedFolder, header, attachment } = await s376LocalAttachment(
    "stale selected body",
    "application/pdf",
    "selected.pdf"
  );
  const key = header.messageKey;
  const tabmail = document.getElementById("tabmail");
  const beforeTabs = tabmail.tabInfo.length;
  await be_in_folder(folder);
  await s376SelectNone();
  selectedFolder.deleteMessages([header], null, true, false, null, false);
  await TestUtils.waitForCondition(
    () => !selectedFolder.msgDatabase.containsKey(key)
  );
  await Assert.rejects(
    attachment.fetchAttachment(),
    e => e.result == Cr.NS_ERROR_NOT_AVAILABLE
  );
  await Assert.rejects(
    attachment.open(window.browsingContext),
    e => e.result == Cr.NS_ERROR_NOT_AVAILABLE
  );
  Assert.equal(
    tabmail.tabInfo.length,
    beforeTabs,
    "stale PDF selection opens no tab"
  );
});

add_task(async function test_attachmentRetrievalFailureHasNoSideEffects() {
  Assert.ok(s376Imap && s376News, "both real protocol fixtures completed");
  const { AttachmentInfo } = ChromeUtils.importESModule(
    "resource:///modules/AttachmentInfo.sys.mjs"
  );
  const directory = await s376SaveDirectory();
  const { server, folders, generator } = s376Imap;
  const message = generator.makeMessage({
    attachments: [
      { body: "IMAP failure source", filename: "selected.txt", format: "" },
    ],
  });
  await server.addMessages(folders[0], [message]);
  const header = [...folders[0].messages].find(
    h => h.messageId == message.messageId
  );
  Assert.ok(header);
  const key = header.messageKey;
  const imapPart = s376UnfetchedAttachment(header);
  const imapTarget = PathUtils.join(directory, "imap-failed.txt");
  const originalCommandToFail = server.daemon.commandToFail;
  server.daemon.commandToFail = "UID";
  try {
    await Assert.rejects(
      imapPart.saveToFile(imapTarget),
      e => e.result == Cr.NS_MSG_ERROR_IMAP_COMMAND_FAILED
    );
    for (const command of [
      () => imapPart.save(window.browsingContext),
      () => AttachmentInfo.saveAttachments([imapPart], window.browsingContext),
      () => imapPart.detachFromMessage(window.browsingContext),
    ]) {
      await Assert.rejects(
        command(),
        error => error.result == Cr.NS_MSG_ERROR_IMAP_COMMAND_FAILED
      );
    }
  } finally {
    server.daemon.commandToFail = originalCommandToFail;
  }
  Assert.equal(await IOUtils.exists(imapTarget), false);
  Assert.ok(
    folders[0].msgDatabase.containsKey(key),
    "failed FETCH retains the selected header"
  );

  const news = s376News;
  for (const [index, name] of news.names.entries()) {
    const article = news.generator.makeMessage({
      attachments: [
        {
          body: `NNTP failure control ${index}`,
          filename: "selected.txt",
          format: "",
        },
      ],
    });
    article.messageId = "s376-failed-news-part@example.invalid";
    news.daemon.addArticleToGroup(
      new news.NewsArticle(article.toMessageString()),
      name,
      202
    );
    const listener = new news.PromiseTestUtils.PromiseUrlListener();
    news.folders[index].getNewMessages(null, listener);
    await listener.promise;
  }
  const newsHeader = [...news.folders[0].messages].find(
    h => h.messageId == "s376-failed-news-part@example.invalid"
  );
  Assert.ok(newsHeader);
  const newsKey = newsHeader.messageKey;
  const newsPart = s376UnfetchedAttachment(newsHeader);
  news.daemon.removeArticleFromGroup(news.names[0], 202);
  const newsTarget = PathUtils.join(directory, "news-failed.txt");
  await Assert.rejects(
    newsPart.saveToFile(newsTarget),
    e => e.result == Cr.NS_ERROR_FAILURE
  );
  for (const command of [
    () => newsPart.save(window.browsingContext),
    () => AttachmentInfo.saveAttachments([newsPart], window.browsingContext),
    () => newsPart.detachFromMessage(window.browsingContext),
  ]) {
    await Assert.rejects(
      command(),
      error => error.result == Cr.NS_ERROR_FAILURE
    );
  }
  Assert.equal(await IOUtils.exists(newsTarget), false);
  Assert.ok(news.folders[0].msgDatabase.containsKey(newsKey));
  Assert.deepEqual(
    await IOUtils.getChildren(directory),
    [],
    "no failed retrieval publishes output"
  );
});

add_task(async function test_attachmentCachedTempFileDoesNotOutliveSelection() {
  const inner =
    "From: inner@example.invalid\r\nMessage-ID: <s376-inner@example.invalid>\r\nSubject: selected inner message\r\n\r\nOnly this selected inner body.\r\n";
  const { selectedFolder, header, attachment } = await s376LocalAttachment(
    inner,
    "message/rfc822",
    "selected.eml"
  );
  const { MailUtils } = ChromeUtils.importESModule(
    "resource:///modules/MailUtils.sys.mjs"
  );
  const originalOpen = MailUtils.openEMLFile;
  const originalSetup = attachment.setupTempFile;
  const temporaryPaths = new Set();
  attachment.setupTempFile = async function (name) {
    const file = await originalSetup.call(this, name);
    temporaryPaths.add(file.path);
    return file;
  };
  const originalFetch = attachment.fetchAttachment;
  const opened = [];
  let fetches = 0;
  MailUtils.openEMLFile = (_win, file) => opened.push(file.clone());
  attachment.fetchAttachment = function () {
    fetches++;
    return originalFetch.call(this);
  };
  try {
    await attachment.open(window.browsingContext);
    await attachment.open(window.browsingContext);
    Assert.equal(opened.length, 2);
    Assert.equal(
      fetches,
      1,
      "an unchanged selected parent reuses its owned temporary file"
    );
    Assert.equal(opened[0].path, opened[1].path);
    const raw = await IOUtils.readUTF8(opened[0].path);
    Assert.ok(raw.includes("Message-ID: <s376-inner@example.invalid>"));
    Assert.ok(raw.includes("Only this selected inner body."));
    const key = header.messageKey;
    await be_in_folder(folder);
    await s376SelectNone();
    selectedFolder.deleteMessages([header], null, true, false, null, false);
    await TestUtils.waitForCondition(
      () => !selectedFolder.msgDatabase.containsKey(key)
    );
    await Assert.rejects(
      attachment.open(window.browsingContext),
      e => e.result == Cr.NS_ERROR_NOT_AVAILABLE
    );
    Assert.equal(
      opened.length,
      2,
      "stale selection does not reopen a retained temporary file"
    );
  } finally {
    MailUtils.openEMLFile = originalOpen;
    attachment.setupTempFile = originalSetup;
    attachment.fetchAttachment = originalFetch;
    for (const path of temporaryPaths) {
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
  }
});

add_task(async function test_cachedMessageRejectsReplacedDatabaseFacade() {
  const inner =
    "From: selected@example.invalid\r\nSubject: retained source\r\n\r\nOnly the retained physical message.\r\n";
  const { selectedFolder, header, attachment } = await s376LocalAttachment(
    inner,
    "message/rfc822",
    "retained-source.eml"
  );
  const { MailUtils } = ChromeUtils.importESModule(
    "resource:///modules/MailUtils.sys.mjs"
  );
  const originalOpen = MailUtils.openEMLFile;
  const originalSetup = attachment.setupTempFile;
  const temporaryPaths = new Set();
  attachment.setupTempFile = async function (name) {
    const file = await originalSetup.call(this, name);
    temporaryPaths.add(file.path);
    return file;
  };
  const files = [];
  MailUtils.openEMLFile = (_win, file) => files.push(file.clone());
  try {
    await attachment.open(window.browsingContext);
    Assert.equal(files.length, 1);
    Assert.ok(
      (await IOUtils.readUTF8(files[0].path)).includes(
        "Only the retained physical message."
      )
    );
    const key = header.messageKey;
    await be_in_folder(folder);
    await s376SelectNone();
    const oldDB = selectedFolder.msgDatabase;
    oldDB.forceClosed();
    const currentDB = selectedFolder.msgDatabase;
    Assert.notStrictEqual(
      currentDB,
      oldDB,
      "The actual folder now has a replacement facade"
    );
    Assert.ok(
      currentDB.containsKey(key),
      "The physical message still exists in the new facade"
    );
    await Assert.rejects(
      attachment.open(window.browsingContext),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
    );
    await Assert.rejects(
      attachment.fetchAttachment(),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
    );
    Assert.equal(
      files.length,
      1,
      "The old retained source cannot reuse its cached EML"
    );
  } finally {
    MailUtils.openEMLFile = originalOpen;
    attachment.setupTempFile = originalSetup;
    for (const path of temporaryPaths) {
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
  }
});

add_task(async function test_nativeBodyFailurePrecedesSaveOrOpenEffects() {
  const { selectedFolder, header, attachment } = await s376LocalAttachment(
    "Retain this body after a real store read failure."
  );
  const directory = await s376SaveDirectory();
  const target = PathUtils.join(directory, "unavailable.txt");
  await be_in_folder(folder);
  await s376SelectNone();
  const token = header.storeToken;
  const expectedStore = selectedFolder.msgStore.storeType;
  let nativeError;
  try {
    header.storeToken =
      expectedStore == "maildir" ? "s376-missing-owned-body" : "123456789";
    nativeError = await new Promise(resolve => {
      const { NetUtil } = ChromeUtils.importESModule(
        "resource://gre/modules/NetUtil.sys.mjs"
      );
      const listener = {
        QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
        onStartRequest() {},
        onDataAvailable(_request, stream, _offset, count) {
          NetUtil.readInputStreamToString(stream, count);
        },
        onStopRequest(_request, status) {
          resolve(status);
        },
      };
      try {
        MailServices.messageServiceFromURI(
          selectedFolder.getUriForMsg(header)
        ).streamMessage(
          selectedFolder.getUriForMsg(header),
          listener,
          null,
          null,
          false,
          "",
          true
        );
      } catch (error) {
        resolve(error.result);
      }
    });
    Assert.ok(
      nativeError && !Components.isSuccessCode(nativeError),
      "The actual selected native store reports a failed terminal read"
    );
    await Assert.rejects(
      attachment.saveToFile(target),
      error => error.result == nativeError
    );
    await Assert.rejects(
      attachment.open(window.browsingContext),
      error => error.result == nativeError
    );
    Assert.equal(await IOUtils.exists(target), false);
    Assert.ok(selectedFolder.msgDatabase.containsKey(header.messageKey));
    Assert.equal(selectedFolder.getTotalMessages(false), 1);
  } finally {
    header.storeToken = token;
  }
  Assert.equal(
    new TextDecoder().decode(await attachment.fetchAttachment()),
    "Retain this body after a real store read failure."
  );
});

/**
 * Build a small valid one-page PDF with distinguishable selected bytes.
 *
 * @param {string} label - ASCII text in this fixture's PDF page.
 * @returns {string} Complete PDF source with exact cross-reference offsets.
 */
function s376Pdf(label) {
  const stream = `BT /F1 12 Tf 20 100 Td (${label}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\r\nstream\r\n${stream}\r\nendstream`,
  ];
  let pdf = "%PDF-1.4\r\n";
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\r\n${object}\r\nendobj\r\n`;
  }
  const start = pdf.length;
  pdf += `xref\r\n0 ${objects.length + 1}\r\n0000000000 65535 f \r\n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \r\n`;
  }
  return (
    pdf +
    `trailer\r\n<< /Size ${objects.length + 1} /Root 1 0 R >>\r\nstartxref\r\n${start}\r\n%%EOF\r\n`
  );
}

add_task(async function test_pdfTabUsesSelectedBytesAcrossImapUidReuse() {
  const { server, incoming, generator } = s376Imap;
  const { PromiseTestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
  );
  const name = "S376PdfEpoch";
  const mailbox = server.daemon.createMailbox(name, {
    subscribed: true,
    uidvalidity: 8101,
    uidnext: 12001,
  });
  const discovered = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(incoming.rootFolder, discovered, null);
  await discovered.promise;
  const selectedFolder = incoming.rootFolder.getChildNamed(name);
  const tabmail = document.getElementById("tabmail");
  const mailTab = tabmail.currentTabInfo;
  const handlerInfo = mimeService.getFromTypeAndExtension(
    "application/pdf",
    "pdf"
  );
  const oldHandler = {
    preferredAction: handlerInfo.preferredAction,
    alwaysAskBeforeHandling: handlerInfo.alwaysAskBeforeHandling,
  };
  const tabs = [];
  const files = new Set();
  handlerInfo.preferredAction = Ci.nsIHandlerInfo.handleInternally;
  handlerInfo.alwaysAskBeforeHandling = false;
  handlerService.store(handlerInfo);
  let firstAttachment;
  let firstTransport;
  let oldKey;
  try {
    for (const [index, label] of [
      "Original physical PDF",
      "Fresh physical PDF",
    ].entries()) {
      tabmail.switchToTab(mailTab);
      const pdf = s376Pdf(label);
      const message = generator.makeMessage({
        attachments: [
          {
            body: btoa(pdf),
            encoding: "base64",
            contentType: "application/pdf",
            filename: "selected.pdf",
          },
        ],
      });
      message.messageId = "s376-pdf-reused-uid@example.invalid";
      if (index) {
        await be_in_folder(folder);
        await s376SelectNone();
        incoming.closeCachedConnections();
        await TestUtils.waitForCondition(
          () => !server.daemon.getConnections().length
        );
        mailbox.uidvalidity = 8102;
        mailbox._messages.length = 0;
        mailbox.uidnext = 12001;
      }
      await server.addMessages(selectedFolder, [message]);
      await be_in_folder(selectedFolder);
      await select_click_row(0);
      const [attachment] = get_about_message().currentAttachments;
      Assert.equal(attachment.partID, "1.2");
      Assert.equal(
        new TextDecoder().decode(await attachment.fetchAttachment()),
        pdf
      );
      if (index) {
        Assert.equal(
          attachment.url,
          firstTransport,
          "The IMAP wire URL and part were reused"
        );
        if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
          Assert.notEqual(
            attachment.message.messageKey,
            oldKey,
            "The fresh epoch has a distinct native physical key"
          );
        }
        await Assert.rejects(
          firstAttachment.open(window.browsingContext),
          error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
        );
      } else {
        firstAttachment = attachment;
        firstTransport = attachment.url;
        oldKey = attachment.message.messageKey;
      }
      const opened = BrowserTestUtils.waitForEvent(
        tabmail.tabContainer,
        "TabOpen",
        false,
        event => event.detail.tabInfo.mode.name == "contentTab"
      );
      const rendered = opened.then(event =>
        BrowserTestUtils.waitForContentEvent(
          event.detail.tabInfo.browser,
          "textlayerrendered",
          false,
          null,
          true
        )
      );
      const originalSetup = attachment.setupTempFile;
      attachment.setupTempFile = async function (filename) {
        const file = await originalSetup.call(this, filename);
        files.add(file.path);
        return file;
      };
      try {
        await attachment.open(window.browsingContext);
      } finally {
        attachment.setupTempFile = originalSetup;
      }
      const tab = (await opened).detail.tabInfo;
      tabs.push(tab);
      await rendered;
      const fileURL = Services.io
        .newURI(tab.browser.currentURI.spec)
        .QueryInterface(Ci.nsIFileURL);
      await SpecialPowers.spawn(tab.browser, [label], async expected => {
        const pdfDocument =
          content.wrappedJSObject.PDFViewerApplication.pdfDocument;
        Assert.ok(
          pdfDocument,
          "The ordinary PDF viewer loaded the selected bytes"
        );
        // Promise resolution restores Xrays around the content-defined proxy.
        const page = Cu.waiveXrays(await pdfDocument.getPage(1));
        const text = Cu.waiveXrays(await page.getTextContent());
        Assert.ok(text.items.some(item => item.str == expected));
      });
      Assert.equal(await IOUtils.readUTF8(fileURL.file.path), pdf);
      if (index) {
        Assert.notEqual(
          tabs[0],
          tab,
          "A new physical message never switches to its predecessor's PDF tab"
        );
        Assert.notEqual(
          tabs[0].browser.currentURI.spec,
          tab.browser.currentURI.spec
        );
      }
    }
  } finally {
    handlerInfo.preferredAction = oldHandler.preferredAction;
    handlerInfo.alwaysAskBeforeHandling = oldHandler.alwaysAskBeforeHandling;
    handlerService.store(handlerInfo);
    tabmail.switchToTab(mailTab);
    for (const tab of tabs) {
      try {
        await SpecialPowers.spawn(tab.browser, [], async () => {
          await content.wrappedJSObject.PDFViewerApplication.testingClose();
        });
        // Release the loaded file document before destroying its tab and file.
        const blank = BrowserTestUtils.browserLoaded(tab.browser, {
          wantLoad: "about:blank",
        });
        BrowserTestUtils.startLoadingURIString(tab.browser, "about:blank");
        await blank;
      } finally {
        tabmail.closeTab(tab);
      }
    }
    for (const path of files) {
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
    await be_in_folder(folder);
    await s376SelectNone();
  }
});

add_task(async function test_helperApplicationReceivesCheckedSelectedBytes() {
  const body = "Only these physical bytes reach the helper application.";
  const type = "test/s376-helper";
  createMockedHandler(type, Ci.nsIHandlerInfo.useHelperApp, false);
  const { attachment } = await s376LocalAttachment(body, type, "selected.s376");
  const originalOpen = attachment._openFile;
  const originalSetup = attachment.setupTempFile;
  const paths = new Set();
  const opened = [];
  attachment.setupTempFile = async function (filename) {
    const file = await originalSetup.call(this, filename);
    paths.add(file.path);
    return file;
  };
  attachment._openFile = (_mimeInfo, file) => opened.push(file.clone());
  try {
    await attachment.open(window.browsingContext);
    Assert.equal(
      opened.length,
      1,
      "One helper dispatch follows the successful selected retrieval"
    );
    Assert.equal(await IOUtils.readUTF8(opened[0].path), body);
    Assert.equal(
      (await IOUtils.stat(opened[0].path)).permissions & 0o222,
      0,
      "The helper receives the ordinary read-only temporary attachment"
    );
  } finally {
    attachment._openFile = originalOpen;
    attachment.setupTempFile = originalSetup;
    for (const path of paths) {
      await IOUtils.setPermissions(path, 0o600);
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
  }
});
