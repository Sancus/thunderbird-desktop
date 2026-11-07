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

const { AttachmentInfo } = ChromeUtils.importESModule(
  "resource:///modules/AttachmentInfo.sys.mjs"
);
const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);
let physicalFixtureIndex = 0;
let physicalNewsFixture = null;

/**
 * Makes literal multipart messages with duplicate Message-IDs and different
 * binary and nested attachment bodies.
 *
 * @param {number} index - Physical copy number.
 * @param {string} [group=""] - NNTP group header, if required.
 * @param {boolean} [pdf=false] - Include a real PDF as the first attachment.
 * @param {boolean} [eml=false] - Include a complete attached message instead.
 * @returns {string} Complete RFC822 source.
 */
function physicalAttachmentSource(index, group = "", pdf = false, eml = false) {
  let firstType = "application/octet-stream";
  let firstName = "physical.bin";
  let firstBody = "physical-" + index + "\x00\xff";
  if (eml) {
    firstType = "message/rfc822";
    firstName = "selected.eml";
    firstBody = physicalAttachedEML(index);
  } else if (pdf) {
    firstType = "application/pdf";
    firstName = "selected.pdf";
    firstBody = physicalPDF(index);
  }
  return [
    "From: sender@example.invalid",
    "To: recipient@example.invalid",
    "Date: Thu, 01 Oct 2026 12:00:00 +0000",
    "Message-ID: <shared-selected-part@example.invalid>",
    "Subject: Physical attachment " + index,
    ...(group ? ["Newsgroups: " + group] : []),
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=outer",
    "",
    "--outer",
    "Content-Type: text/plain",
    "",
    "Physical body " + index,
    "--outer",
    "Content-Type: " + firstType,
    "Content-Disposition: attachment; filename=" + firstName,
    "Content-Transfer-Encoding: base64",
    "",
    btoa(firstBody),
    "--outer",
    "Content-Type: multipart/mixed; boundary=nested",
    "",
    "--nested",
    "Content-Type: text/plain",
    "Content-Disposition: attachment; filename=nested.txt",
    "Content-Transfer-Encoding: base64",
    "",
    btoa("nested-" + index),
    "--nested--",
    "--outer--",
    "",
  ].join("\r\n");
}

/**
 * Builds the complete child message used by the real news EML cache control.
 *
 * @param {number} index - Physical copy number.
 * @returns {string} Complete attached RFC822 bytes.
 */
function physicalAttachedEML(index) {
  return [
    "From: child@example.invalid",
    "To: reader@example.invalid",
    "Subject: Physical child " + index,
    "Message-ID: <child-" + index + "@example.invalid>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Complete selected child " + index,
    "",
  ].join("\r\n");
}

/**
 * Encodes significant CR, NUL and non-ASCII bytes for the normal MIME decoder.
 *
 * @param {number} index - Physical source copy.
 * @param {string} group - Actual ingested newsgroup.
 * @returns {string} Complete raw RFC822 source.
 */
function physicalEncodedBinarySource(index, group) {
  return physicalAttachmentSource(index, group).replace(
    btoa("physical-" + index + "\x00\xff"),
    btoa("A\rB\x00\xff")
  );
}

/**
 * Creates a complete one-page PDF with copy-specific text and exact xref offsets.
 *
 * @param {number} index - Physical copy number.
 * @returns {string} ASCII PDF bytes.
 */
function physicalPDF(index) {
  const content = `BT /F1 12 Tf 40 100 Td (Physical PDF ${index}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let bytes = "%PDF-1.4\n";
  const offsets = [0];
  for (const [objectIndex, object] of objects.entries()) {
    offsets.push(bytes.length);
    bytes += `${objectIndex + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = bytes.length;
  bytes += "xref\n0 6\n0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    bytes += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  return (
    bytes + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  );
}

/**
 * Removes download entries created for these fixture-owned target paths.
 *
 * @param {string[]} targets - Exact paths owned by this fixture.
 */
async function removePhysicalDownloadEntries(targets) {
  const { Downloads } = ChromeUtils.importESModule(
    "resource://gre/modules/Downloads.sys.mjs"
  );
  const list = await Downloads.getList(Downloads.ALL);
  for (const download of await list.getAll()) {
    if (targets.includes(download.target.path)) {
      await list.remove(download);
      await download.finalize(true);
    }
  }
}

/**
 * Checks the actual DB service, source and store selected before account setup.
 *
 * @param {nsIMsgFolder} selectedFolder - Folder holding the real message.
 */
function assertPhysicalAttachmentBackend(selectedFolder) {
  const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.equal(service instanceof Ci.nsIDatabaseCore, native);
  const cid = Components.manager
    .QueryInterface(Ci.nsIComponentRegistrar)
    .contractIDToCID("@mozilla.org/msgDatabase/msgDBService;1")
    .toString();
  const legacyCID = "{03223c50-1e88-45e8-ba1a-7ce792dc3fc3}";
  if (native) {
    Assert.notEqual(cid, legacyCID, "Startup installed the native factory CID");
    Assert.equal(
      service,
      Cc["@mozilla.org/mailnews/database-core;1"].getService(Ci.nsIDatabaseCore)
    );
  } else {
    Assert.equal(cid, legacyCID);
  }
  const contract = Services.prefs.getCharPref(
    "mail.server.default.storeContractID"
  );
  Assert.equal(
    selectedFolder.msgStore.storeType,
    {
      "@mozilla.org/msgstore/berkeleystore;1": "mbox",
      "@mozilla.org/msgstore/maildirstore;1": "maildir",
    }[contract]
  );
  Assert.equal(
    service.openFolderDB(selectedFolder, false),
    selectedFolder.msgDatabase
  );
  if (native) {
    Assert.ok(service.sourceId, "A real native source is active");
  }
  info(
    "ATTACHMENT_SOURCE " +
      JSON.stringify({
        native,
        cid,
        store: selectedFolder.msgStore.storeType,
        source: native ? service.sourceId : "mork",
        folder: selectedFolder.URI,
      })
  );
}

/**
 * Completes the fixture-owned reader channel through the public protocol API.
 * Module data listeners already close their own channels; document loads also
 * own a native IMAP cache/listener chain until the reader request terminates.
 *
 * @param {nsIMsgIncomingServer} incoming - Actual owned protocol account.
 * @returns {{stopped: number}} Observed native reader completions.
 */
function closePhysicalReaderRequests(incoming) {
  const browser = aboutMessage.getMessagePaneBrowser();
  const active = new Map();
  const errors = [];
  const receipt = { started: 0, stopped: 0 };
  const listener = {
    QueryInterface: ChromeUtils.generateQI([
      "nsIWebProgressListener",
      "nsISupportsWeakReference",
    ]),
    onStateChange(_progress, request, flags) {
      if (
        !(flags & Ci.nsIWebProgressListener.STATE_START) ||
        !(request instanceof Ci.nsIImapMockChannel) ||
        active.has(request)
      ) {
        return;
      }
      try {
        const uri = request.URI.QueryInterface(Ci.nsIMsgMailNewsUrl);
        if (uri.server != incoming) {
          return;
        }
        // Native OnStopRequest precedes SetUrlState(false). Close removes the
        // channel from its load group, so waiting for web-progress STATE_STOP
        // before Close would wait on the very cleanup we need to perform.
        const terminal = {
          QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),
          OnStartRunningUrl() {},
          OnStopRunningUrl() {
            if (!active.delete(request)) {
              return;
            }
            try {
              request.Close();
              receipt.stopped++;
            } catch (error) {
              errors.push(error);
            }
          },
        };
        active.set(request, { uri, terminal });
        uri.RegisterListener(terminal);
        receipt.started++;
      } catch (error) {
        errors.push(error);
      }
    },
  };
  browser.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_STATE_REQUEST);
  registerCleanupFunction(() => {
    browser.removeProgressListener(listener);
    for (const [request, { uri, terminal }] of [...active]) {
      active.delete(request);
      // Detach the URL callback before cancellation can synchronously notify it.
      try {
        uri.UnRegisterListener(terminal);
      } catch (error) {
        errors.push(error);
      }
      try {
        request.cancel(Cr.NS_BINDING_ABORTED);
      } catch (error) {
        errors.push(error);
      }
      try {
        request.Close();
      } catch (error) {
        errors.push(error);
      }
    }
    info("ATTACHMENT_READER_TERMINALS " + JSON.stringify(receipt));
    if (errors.length) {
      throw new AggregateError(errors, "Owned reader protocol cleanup failed");
    }
  });
  return receipt;
}

/**
 * Ingests two physical messages through the real local or protocol store.
 * Fake servers use normal production discovery and header publication.
 *
 * @param {"local"|"imap"|"nntp"} protocol - Store/protocol to exercise.
 * @param {object} [options] - Fixture content.
 * @param {boolean} [options.pdf=false] - Include a PDF instead of the binary part.
 * @param {boolean} [options.eml=false] - Include an attached message instead.
 * @param {boolean} [options.encodedBinary=false] - Decode significant binary bytes.
 * @param {boolean} [options.uidplus=false] - Publish actual APPEND UID receipts.
 * @param {?string} [options.rights=null] - Real IMAP ACL rights for this fixture.
 * @returns {Promise<object>} Physical folders, headers and protocol controls.
 */
async function physicalAttachmentFixture(
  protocol,
  {
    pdf = false,
    eml = false,
    encodedBinary = false,
    uidplus = false,
    rights = null,
  } = {}
) {
  const id = ++physicalFixtureIndex;
  // Server folder URIs omit ports, so concurrently retained fixture accounts
  // need distinct usernames as well as distinct listening ports.
  const username = "attachment-" + id;
  const folders = [];
  let incoming, account, server, daemon;
  if (protocol == "local") {
    for (const index of [0, 1]) {
      const created = await create_folder(`PhysicalAttachment${id}-${index}`);
      folders.push(created);
      registerCleanupFunction(async () => {
        const tabmail = document.getElementById("tabmail");
        const mailTab = tabmail.tabInfo.find(
          tab => tab.mode.name == "mail3PaneTab"
        );
        Assert.ok(mailTab, "Owned source cleanup retains a live mail tab");
        tabmail.switchToTab(mailTab);
        const {
          get_about_3pane,
          get_about_message: cleanupGetAboutMessage,
          select_none,
          wait_for_blank_content_pane,
        } = ChromeUtils.importESModule(
          "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
        );
        const { MailServices: cleanupMailServices } =
          ChromeUtils.importESModule(
            "resource:///modules/MailServices.sys.mjs"
          );
        const pane = get_about_3pane();
        const reader = cleanupGetAboutMessage();
        if (
          pane.gFolder == created ||
          (reader.gMessageURI && reader.gFolder == created)
        ) {
          if (pane.gDBView?.selection) {
            await select_none();
          } else {
            reader.displayMessage();
            await wait_for_blank_content_pane();
          }
          await be_in_folder(
            cleanupMailServices.accounts.localFoldersServer.rootFolder
          );
        }
        created.deleteSelf(null);
      });
      created
        .QueryInterface(Ci.nsIMsgLocalMailFolder)
        .addMessage(physicalAttachmentSource(index, "", pdf, eml));
    }
  } else {
    const { nsMailServer } = ChromeUtils.importESModule(
      "resource://testing-common/mailnews/Maild.sys.mjs"
    );
    const { localAccountUtils } = ChromeUtils.importESModule(
      "resource://testing-common/mailnews/LocalAccountUtils.sys.mjs"
    );
    const retainedNews = protocol == "nntp" ? physicalNewsFixture : null;
    const names =
      protocol == "imap"
        ? [`Physical${id}First`, `Physical${id}Selected`]
        : [`physical.${id}.first`, `physical.${id}.selected`];
    if (protocol == "imap") {
      const {
        ImapDaemon,
        ImapMessage,
        IMAP_RFC3501_handler,
        IMAP_RFC4315_extension,
        IMAP_RFC4314_extension,
        mixinExtension,
      } = ChromeUtils.importESModule(
        "resource://testing-common/mailnews/Imapd.sys.mjs"
      );
      daemon = new ImapDaemon();
      for (const [index, name] of names.entries()) {
        daemon.createMailbox(name, { subscribed: true });
        const mailbox = daemon.getMailbox(name);
        mailbox.uidvalidity = 7101;
        if (rights !== null) {
          mailbox.rights = rights;
        }
        mailbox.addMessage(
          new ImapMessage(
            "data:text/plain;base64," +
              btoa(physicalAttachmentSource(index, "", pdf, eml)),
            5101,
            []
          )
        );
      }
      server = new nsMailServer(d => {
        const handler = new IMAP_RFC3501_handler(d, {
          username,
          password: "password",
        });
        if (rights !== null) {
          mixinExtension(handler, IMAP_RFC4314_extension);
        }
        if (uidplus) {
          mixinExtension(handler, IMAP_RFC4315_extension);
        }
        return handler;
      }, daemon);
    } else {
      const { NntpDaemon, NewsArticle, NNTP_RFC2980_handler } =
        ChromeUtils.importESModule(
          "resource://testing-common/mailnews/Nntpd.sys.mjs"
        );
      daemon = retainedNews?.daemon ?? new NntpDaemon();
      for (const [index, name] of names.entries()) {
        daemon.addGroup(name);
        daemon.addArticleToGroup(
          new NewsArticle(
            encodedBinary
              ? physicalEncodedBinarySource(index, name)
              : physicalAttachmentSource(index, name, pdf, eml)
          ),
          name,
          5101
        );
      }
      server =
        retainedNews?.server ??
        new nsMailServer(d => new NNTP_RFC2980_handler(d), daemon);
    }
    if (!retainedNews) {
      server.start();
      registerCleanupFunction(async () => {
        try {
          if (incoming) {
            try {
              const tabmail = document.getElementById("tabmail");
              const mailTab = tabmail.tabInfo.find(
                tab => tab.mode.name == "mail3PaneTab"
              );
              Assert.ok(mailTab, "Protocol teardown owns a live mail tab");
              tabmail.switchToTab(mailTab);
              const {
                get_about_3pane,
                get_about_message: cleanupGetAboutMessage,
                select_none,
                wait_for_blank_content_pane,
              } = ChromeUtils.importESModule(
                "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
              );
              const pane = get_about_3pane();
              const reader = cleanupGetAboutMessage();
              if (
                pane.gFolder?.server == incoming ||
                (reader.gMessageURI && reader.gFolder?.server == incoming)
              ) {
                if (pane.gDBView?.selection) {
                  await select_none();
                } else {
                  reader.displayMessage();
                  await wait_for_blank_content_pane();
                }
                await be_in_folder(
                  MailServices.accounts.localFoldersServer.rootFolder
                );
              }
            } finally {
              try {
                if (protocol == "imap") {
                  incoming
                    .QueryInterface(Ci.nsIImapServerSink)
                    .abortQueuedUrls();
                }
              } finally {
                try {
                  await TestUtils.waitForCondition(
                    () =>
                      protocol == "imap"
                        ? incoming.allConnectionsIdle
                        : incoming.wrappedJSObject._busyConnections.length == 0,
                    "Owned protocol requests finish before connection teardown"
                  );
                } finally {
                  incoming.closeCachedConnections();
                }
              }
            }
          }
        } finally {
          try {
            await server.stop();
          } finally {
            if (account) {
              MailServices.accounts.removeAccount(account, false);
              if (physicalNewsFixture?.incoming == incoming) {
                physicalNewsFixture = null;
              }
            }
          }
        }
      });
      const created = localAccountUtils.create_incoming_server_and_account(
        protocol,
        server.port,
        protocol == "imap" ? username : null,
        protocol == "imap" ? "password" : null
      );
      incoming = created.server;
      account = created.account;
      // LocalAccountUtils attaches the server while it is invalid. Publish the
      // valid account before discovery can emit child-folder notifications.
      account.incomingServer = incoming;
      const { get_about_3pane } = ChromeUtils.importESModule(
        "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
      );
      await TestUtils.waitForCondition(
        () =>
          get_about_3pane().folderPane.getRowForFolder(
            incoming.rootFolder,
            "all"
          ),
        "Valid protocol account has a real folder-pane root before discovery"
      );
      if (protocol == "imap") {
        account.addIdentity(MailServices.accounts.createIdentity());
        incoming.QueryInterface(Ci.nsIImapIncomingServer);
        incoming.maximumConnectionsNumber = 1;
        const listener = new PromiseTestUtils.PromiseUrlListener();
        MailServices.imap.discoverAllFolders(
          incoming.rootFolder,
          listener,
          null
        );
        await listener.promise;
      } else {
        incoming.QueryInterface(Ci.nsINntpIncomingServer);
        incoming.maximumConnectionsNumber = 1;
        incoming.pushAuth = false;
      }
      if (protocol == "nntp") {
        physicalNewsFixture = { daemon, server, incoming, account };
      }
    } else {
      ({ incoming, account } = retainedNews);
    }
    if (protocol == "nntp") {
      for (const name of names) {
        incoming.subscribeToNewsgroup(name);
      }
    }
    for (const name of names) {
      const createdFolder = incoming.rootFolder.getChildNamed(name);
      createdFolder.clearFlag(Ci.nsMsgFolderFlags.Offline);
      const listener = new PromiseTestUtils.PromiseUrlListener();
      if (protocol == "imap") {
        MailServices.imap.selectFolder(createdFolder, listener, null);
      } else {
        createdFolder.getNewMessages(null, listener);
      }
      await listener.promise;
      folders.push(createdFolder);
    }
  }
  const headers = folders.map(f => Array.from(f.messages)[0]);
  for (const [index, header] of headers.entries()) {
    assertPhysicalAttachmentBackend(folders[index]);
    Assert.ok(header, "Normal ingestion produced a real physical header");
    Assert.equal(header.folder, folders[index]);
    const uri = folders[index].getUriForMsg(header);
    const resolved =
      MailServices.messageServiceFromURI(uri).messageURIToMsgHdr(uri);
    Assert.equal(resolved.folder, folders[index]);
    Assert.equal(resolved.messageKey, header.messageKey);
    Assert.equal(folders[index].getTotalMessages(false), 1);
    if (
      protocol != "local" &&
      Services.prefs.getBoolPref("mail.panorama.enabled", false)
    ) {
      Assert.notEqual(
        header.messageKey,
        5101,
        "Physical key differs from wire ID"
      );
    }
  }
  Assert.equal(headers[0].messageId, headers[1].messageId);
  const readerLifetime =
    protocol == "imap" ? closePhysicalReaderRequests(incoming) : null;
  await be_in_folder(folders[1]);
  await select_click_row(0);
  const attachments = [...aboutMessage.currentAttachments];
  let expectedFirstName = "physical.bin";
  if (eml) {
    expectedFirstName = "selected.eml";
  } else if (pdf) {
    expectedFirstName = "selected.pdf";
  }
  Assert.deepEqual(
    attachments.map(a => a.name),
    [expectedFirstName, "nested.txt"]
  );
  Assert.deepEqual(
    attachments.map(a => a.partID),
    ["1.2", "1.3.1"]
  );
  for (const attachment of attachments) {
    const physicalURI = folders[1].getUriForMsg(headers[1]);
    if (protocol == "nntp") {
      const expected = new URL(
        MailServices.messageServiceFromURI(physicalURI).getUrlForUri(
          physicalURI
        ).spec
      );
      const parent = new URL(attachment.uri);
      Assert.equal(parent.protocol, "news:");
      Assert.equal(parent.pathname, expected.pathname);
      Assert.equal(parent.searchParams.get("group"), folders[1].name);
      Assert.equal(
        Number(parent.searchParams.get("key")),
        headers[1].messageKey
      );
    } else {
      Assert.equal(attachment.uri, physicalURI);
    }
    Assert.equal(attachment.message.messageKey, headers[1].messageKey);
  }
  if (readerLifetime) {
    await TestUtils.waitForCondition(
      () => readerLifetime.stopped > 0,
      "The actual fixture IMAP reader reached native terminal cleanup"
    );
  }
  return { folders, headers, attachments, incoming, server, daemon };
}

/**
 * Checks fetched and saved decoded bytes, including zero and non-ASCII bytes.
 *
 * @param {AttachmentInfo} attachment - The actual displayed selected part.
 * @param {string} expected - Binary string expected from the MIME decoder.
 */
async function assertSelectedAttachmentBytes(attachment, expected) {
  const bytes = Uint8Array.from(expected, c => c.charCodeAt(0));
  Assert.deepEqual(new Uint8Array(await attachment.fetchAttachment()), bytes);
  const target = PathUtils.join(savePath, "physical-selected.bin");
  try {
    await attachment.saveToFile(target);
    Assert.deepEqual(
      await IOUtils.read(target),
      bytes,
      "Saved exact selected part"
    );
  } finally {
    await removePhysicalDownloadEntries([target]);
    await IOUtils.remove(target, { ignoreAbsent: true });
  }
}

add_task(async function test_selectedLocalAttachmentBytesAndSavedTarget() {
  const { attachments } = await physicalAttachmentFixture("local");
  await assertSelectedAttachmentBytes(attachments[0], "physical-1\x00\xff");
  await assertSelectedAttachmentBytes(attachments[1], "nested-1");
  createMockedHandler(
    "application/octet-stream",
    Ci.nsIHandlerInfo.useHelperApp,
    false
  );
  const original = attachments[0]._openFile;
  let opened;
  attachments[0]._openFile = (_mime, file) => {
    opened = file;
  };
  try {
    await attachments[0].open(aboutMessage.browsingContext);
    Assert.ok(opened, "Existing attachment command handed off an actual file");
    Assert.deepEqual(
      await IOUtils.read(opened.path),
      Uint8Array.from("physical-1\x00\xff", c => c.charCodeAt(0))
    );
    if (AppConstants.platform != "win") {
      Assert.equal((await IOUtils.stat(opened.path)).permissions, 0o400);
    }
  } finally {
    attachments[0]._openFile = original;
    if (opened) {
      await deleteAttachmentFile(opened);
    }
  }
});

add_task(async function test_imapAttachmentRetainsPhysicalSourceAndPart() {
  const { attachments, folders, headers } =
    await physicalAttachmentFixture("imap");
  await assertSelectedAttachmentBytes(attachments[0], "physical-1\x00\xff");
  await assertSelectedAttachmentBytes(attachments[1], "nested-1");
  const selected = headers[1];
  const token = selected.storeToken;
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    const db = folders[1].msgDatabase;
    const epoch = db.dBFolderInfo.imapUidValidity;
    try {
      db.dBFolderInfo.imapUidValidity = epoch + 1;
      await Assert.rejects(
        attachments[0].fetchAttachment(),
        error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
        "An attachment from a retired UIDVALIDITY cannot be fetched"
      );
    } finally {
      db.dBFolderInfo.imapUidValidity = epoch;
    }
    Assert.equal(selected.storeToken, token);
  }
  Assert.equal(folders[0].getTotalMessages(false), 1);
  Assert.equal(folders[1].getTotalMessages(false), 1);
  await assertPhysicalPDFHandoff();
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    await assertPhysicalIMAPOfflineModification();
    await assertPhysicalIMAPDeniedModification();
    await assertPhysicalIMAPAmbiguousAppendRefusal();
  }
});

/**
 * Opens real selected PDF bytes and refuses a retained PDF after UID reuse.
 */
async function assertPhysicalPDFHandoff() {
  const fixture = await physicalAttachmentFixture("imap", { pdf: true });
  const attachment = fixture.attachments[0];
  const handler = mimeService.getFromTypeAndExtension("application/pdf", "pdf");
  const existed = handlerService.exists(handler);
  const previous = {
    action: handler.preferredAction,
    ask: handler.alwaysAskBeforeHandling,
  };
  handler.preferredAction = Ci.nsIHandlerInfo.handleInternally;
  handler.alwaysAskBeforeHandling = false;
  handlerService.store(handler);
  const tabmail = document.getElementById("tabmail");
  const mailTab = tabmail.currentTabInfo;
  Assert.equal(mailTab.mode.name, "mail3PaneTab");
  const tabs = [];
  const files = new Set();
  const open = async (part, index) => {
    const opened = BrowserTestUtils.waitForEvent(
      tabmail.tabContainer,
      "TabOpen",
      false,
      event => event.detail.tabInfo.mode.name == "contentTab"
    );
    const setup = part.setupTempFile;
    part.setupTempFile = async function (name) {
      const file = await setup.call(this, name);
      files.add(file.path);
      return file;
    };
    try {
      await part.open(aboutMessage.browsingContext);
    } finally {
      part.setupTempFile = setup;
    }
    const tab = (await opened).detail.tabInfo;
    tabs.push(tab);
    const rendered = BrowserTestUtils.waitForContentEvent(
      tab.browser,
      "textlayerrendered",
      false,
      null,
      true
    );
    await TestUtils.waitForCondition(
      () => tab.browser.currentURI.scheme == "file"
    );
    const url = new URL(tab.browser.currentURI.spec);
    Assert.equal(url.searchParams.get("type"), "application/pdf");
    const file = Services.io
      .newURI(url.href)
      .QueryInterface(Ci.nsIFileURL).file;
    files.add(file.path);
    Assert.equal(
      await IOUtils.readUTF8(file.path),
      physicalPDF(index),
      "PDF viewer receives exactly the selected physical bytes"
    );
    await rendered;
    await SpecialPowers.spawn(tab.browser, [], () => {
      const viewer = content.wrappedJSObject.PDFViewerApplication;
      Assert.ok(
        viewer.pdfDocument,
        "The real internal PDF viewer loaded the selected file"
      );
      Assert.equal(viewer.pdfDocument.numPages, 1);
    });
    return tab;
  };
  let operationError;
  const cleanupErrors = [];
  try {
    const first = await open(attachment, 1);
    const second = await open(attachment, 1);
    Assert.notEqual(
      first.browser.currentURI.spec,
      second.browser.currentURI.spec
    );
    if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
      const selectedFolder = fixture.folders[1];
      const oldKey = fixture.headers[1].messageKey;
      const epoch = selectedFolder.msgDatabase.dBFolderInfo.imapUidValidity;
      const { ImapMessage } = ChromeUtils.importESModule(
        "resource://testing-common/mailnews/Imapd.sys.mjs"
      );
      const mailbox = fixture.daemon.getMailbox(selectedFolder.name);
      await TestUtils.waitForCondition(
        () => fixture.incoming.allConnectionsIdle
      );
      fixture.incoming.closeCachedConnections();
      mailbox.uidvalidity = epoch + 1;
      mailbox._messages = [
        new ImapMessage(
          "data:text/plain;base64," +
            btoa(physicalAttachmentSource(0, "", true)),
          5101,
          []
        ),
      ];
      const listener = new PromiseTestUtils.PromiseUrlListener();
      MailServices.imap.selectFolder(selectedFolder, listener, null);
      await listener.promise;
      const count = tabmail.tabInfo.length;
      await Assert.rejects(
        attachment.open(aboutMessage.browsingContext),
        error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
        "Old PDF selection refuses the reused wire UID and retired epoch"
      );
      Assert.equal(
        tabmail.tabInfo.length,
        count,
        "No stale tab was opened or reused"
      );
      tabmail.switchToTab(mailTab);
      await be_in_folder(selectedFolder);
      await select_click_row(0);
      const current = aboutMessage.currentAttachments[0];
      Assert.notEqual(current.message.messageKey, oldKey);
      Assert.equal(current.message.getUint32Property("uidOnServer"), 5101);
      await open(current, 0);
    }
  } catch (error) {
    operationError = error;
  } finally {
    try {
      const closed = await Promise.allSettled(
        tabs.map(async tab => {
          let unloadError;
          try {
            await SpecialPowers.spawn(tab.browser, [], async () => {
              await content.wrappedJSObject.PDFViewerApplication?.close();
            });
            await BrowserTestUtils.loadURIString({
              browser: tab.browser,
              uriString: "about:blank",
            });
            // Complete a normal content round trip while the navigated context
            // is still alive, before closing this fixture-owned tab.
            await SpecialPowers.spawn(tab.browser, [], () => {
              Assert.equal(content.location.href, "about:blank");
            });
          } catch (error) {
            unloadError = error;
          }
          tabmail.closeTab(tab);
          if (unloadError) {
            throw unloadError;
          }
        })
      );
      if (tabmail.tabInfo.includes(mailTab)) {
        tabmail.switchToTab(mailTab);
      }
      cleanupErrors.push(
        ...closed
          .filter(result => result.status == "rejected")
          .map(result => result.reason)
      );
      const removed = await Promise.allSettled(
        [...files].map(async path => {
          if (await IOUtils.exists(path)) {
            await deleteAttachmentFile(getNsIFileFromPath(path));
          }
        })
      );
      cleanupErrors.push(
        ...removed
          .filter(result => result.status == "rejected")
          .map(result => result.reason)
      );
    } finally {
      try {
        handler.preferredAction = previous.action;
        handler.alwaysAskBeforeHandling = previous.ask;
        if (existed) {
          handlerService.store(handler);
        } else {
          handlerService.remove(handler);
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (cleanupErrors.length) {
    throw new AggregateError(
      operationError ? [operationError, ...cleanupErrors] : cleanupErrors,
      "PDF action or owned cleanup failed"
    );
  }
  if (operationError) {
    throw operationError;
  }
}

add_task(async function test_nntpAttachmentRetainsPhysicalSourceAndPart() {
  const { attachments, folders, headers } =
    await physicalAttachmentFixture("nntp");
  for (const attachment of attachments) {
    const url = new URL(attachment.url);
    Assert.equal(url.searchParams.get("group"), folders[1].name);
    Assert.equal(Number(url.searchParams.get("key")), headers[1].messageKey);
    Assert.equal(url.searchParams.get("part"), attachment.partID);
  }
  await assertSelectedAttachmentBytes(attachments[0], "physical-1\x00\xff");
  await assertSelectedAttachmentBytes(attachments[1], "nested-1");
  await be_in_folder(folders[0]);
  await select_click_row(0);
  await assertSelectedAttachmentBytes(
    aboutMessage.currentAttachments[0],
    "physical-0\x00\xff"
  );
  await assertSelectedAttachmentBytes(
    aboutMessage.currentAttachments[1],
    "nested-0"
  );
  await be_in_folder(folders[1]);
  await select_click_row(0);
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    const selected = headers[1];
    Assert.equal(
      selected.storeToken,
      "",
      "Offline-disabled display did not store the article"
    );
    Assert.equal(selected.flags & Ci.nsMsgMessageFlags.Offline, 0);
    folders[1].setFlag(Ci.nsMsgFolderFlags.Offline);
    folders[1].server.limitOfflineMessageSize = false;
    Services.cache2.clear();
    const target = PathUtils.join(savePath, "first-news-offline.bin");
    try {
      await attachments[0].saveToFile(target);
      Assert.deepEqual(
        await IOUtils.read(target),
        Uint8Array.from("physical-1\x00\xff", c => c.charCodeAt(0))
      );
      Assert.ok(
        selected.storeToken,
        "The successful selected fetch published its own first offline body"
      );
      Assert.ok(selected.flags & Ci.nsMsgMessageFlags.Offline);
      Assert.greater(selected.offlineMessageSize, 0);
      const token = selected.storeToken;
      const wasOffline = Services.io.offline;
      Services.io.offline = true;
      try {
        Assert.equal(
          new TextDecoder().decode(await attachments[1].fetchAttachment()),
          "nested-1"
        );
        Assert.equal(
          selected.storeToken,
          token,
          "The same selected offline body remains readable"
        );
      } finally {
        Services.io.offline = wasOffline;
      }
    } finally {
      try {
        await removePhysicalDownloadEntries([target]);
      } finally {
        await IOUtils.remove(target, {
          ignoreAbsent: true,
          retryReadonly: true,
        });
        folders[1].clearFlag(Ci.nsMsgFolderFlags.Offline);
      }
    }
  }
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    await assertPhysicalNewsPublicationMutation();
  }
  Assert.ok(
    !aboutMessage.CanDetachAttachments(),
    "NNTP detach remains disabled"
  );
  Assert.ok(
    !folders[1].canFileMessages,
    "Real selected news folder denies replacement filing"
  );
  await Assert.rejects(
    AttachmentInfo.stripAttachments(
      headers[1],
      new Map([[attachments[0].url, null]]),
      "DETACH"
    ),
    /Cannot file messages/,
    "The actual NNTP parent cannot bypass its detach permission"
  );
});

add_task(async function test_attachmentStaleSelectionRejectsBeforeOpening() {
  const { attachments, folders, headers } =
    await physicalAttachmentFixture("local");
  const attachment = attachments[0];
  let opened = false;
  attachment._openFile = () => {
    opened = true;
  };
  const target = PathUtils.join(savePath, "stale-part.bin");
  try {
    attachment.message = headers[0];
    await Assert.rejects(
      attachment.open(aboutMessage.browsingContext),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
    );
    await Assert.rejects(
      attachment.saveToFile(target),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
    );
    Assert.ok(!opened);
    Assert.ok(!(await IOUtils.exists(target)), "No stale target was written");
    attachment.contentType = "application/pdf";
    await Assert.rejects(
      attachment.open(aboutMessage.browsingContext),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
      "Direct PDF handoff also checks the physical selection"
    );
    attachment.message = headers[1];
    const part = attachment.partID;
    attachment.partID = "99.9";
    await Assert.rejects(
      attachment.fetchAttachment(),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
      "An unobserved MIME section cannot replace the selected part"
    );
    attachment.partID = part;
    folders[1].msgDatabase.deleteHeader(headers[1], null, true, true);
    await Assert.rejects(
      attachment.fetchAttachment(),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
      "Missing physical row cannot resolve by duplicate Message-ID"
    );
    Assert.equal(folders[0].getTotalMessages(false), 1);
    if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
      const current = await physicalAttachmentFixture("local");
      const retained = current.attachments[0];
      await assertAttachmentSourceReplacement(retained);
      const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
        Ci.nsIMsgDBService
      );
      const oldDB = current.folders[1].msgDatabase;
      await be_in_folder(current.folders[0]);
      service.forceFolderDBClosed(current.folders[1]);
      Assert.notEqual(current.folders[1].msgDatabase, oldDB);
      await Assert.rejects(
        retained.open(aboutMessage.browsingContext),
        error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
        "A retained command refuses an actual native facade replacement"
      );
    }
  } finally {
    try {
      await removePhysicalDownloadEntries([target]);
    } finally {
      await IOUtils.remove(target, { ignoreAbsent: true, retryReadonly: true });
    }
  }
});

/**
 * Replaces only the real native database incarnation and restores it in finally.
 * Stored headers and bodies come from ordinary ingestion, not SQL fixture rows.
 *
 * @param {AttachmentInfo} attachment - Retained real attachment selection.
 */
async function assertAttachmentSourceReplacement(attachment) {
  const core = Cc["@mozilla.org/mailnews/database-core;1"].getService(
    Ci.nsIDatabaseCore
  );
  const sourceId = core.sourceId;
  const connection = core.connectionForTests;
  const target = PathUtils.join(savePath, "foreign-source.bin");
  connection.executeSimpleSQL(
    "UPDATE database_identity SET sourceId='{87654321-4321-4321-4321-cba987654321}'"
  );
  try {
    await Assert.rejects(
      attachment.open(aboutMessage.browsingContext),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
    );
    await Assert.rejects(
      attachment.saveToFile(target),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
    );
    Assert.ok(
      !(await IOUtils.exists(target)),
      "Source replacement cannot publish bytes"
    );
  } finally {
    const restore = connection.createStatement(
      "UPDATE database_identity SET sourceId=:source"
    );
    try {
      restore.params.source = sourceId;
      restore.execute();
    } finally {
      restore.finalize();
    }
    await removePhysicalDownloadEntries([target]);
    await IOUtils.remove(target, { ignoreAbsent: true });
  }
  Assert.equal(core.sourceId, sourceId);
}

add_task(async function test_attachmentRetrievalFailureHasNoSideEffects() {
  const imap = await physicalAttachmentFixture("imap");
  const imapTarget = PathUtils.join(savePath, "failed-imap-part.bin");
  const imapToken = imap.headers[1].storeToken;
  await TestUtils.waitForCondition(() => imap.incoming.allConnectionsIdle);
  imap.incoming.closeCachedConnections();
  Services.cache2.clear();
  imap.daemon.commandToFail = "UID";
  try {
    const uri = imap.attachments[0].uri;
    const service = MailServices.messageServiceFromURI(uri);
    const listener = new PromiseTestUtils.PromiseStreamListener();
    const stop = listener.onStopRequest.bind(listener);
    listener.onStopRequest = (request, status) => {
      try {
        if (request instanceof Ci.nsIImapMockChannel) {
          request.Close();
        }
      } catch (error) {
        if (Components.isSuccessCode(status)) {
          listener._reject(error);
        } else {
          console.error(error);
        }
      }
      stop(request, status);
    };
    service
      .QueryInterface(Ci.nsIMsgMessageFetchPartService)
      .fetchMimePart(
        service.getUrlForUri(uri),
        uri + "?part=1.2",
        listener,
        null,
        null
      );
    let originalStatus;
    try {
      await Assert.rejects(
        listener.promise,
        error => {
          originalStatus = Number(error.message);
          return !Components.isSuccessCode(originalStatus);
        },
        "The real IMAP part service reports its terminal failure"
      );
    } finally {
      listener._stream?.close();
      listener._stream = null;
    }
    await Assert.rejects(
      imap.attachments[0].saveToFile(imapTarget),
      error => error.result == originalStatus,
      "Attachment save retains exactly the producer's original status"
    );
    Assert.ok(!(await IOUtils.exists(imapTarget)));
    await Assert.rejects(
      AttachmentInfo.deleteAttachments(imap.headers[1], [imap.attachments[0]]),
      error => error.result == originalStatus,
      "Actual IMAP strip streaming retains the failed producer terminal status"
    );
    Assert.ok(
      imap.folders[1].msgDatabase.containsKey(imap.headers[1].messageKey)
    );
    Assert.equal(imap.headers[1].storeToken, imapToken);
    Assert.equal(imap.folders[0].getTotalMessages(false), 1);
    Assert.equal(imap.folders[1].getTotalMessages(false), 1);
  } finally {
    imap.daemon.commandToFail = "";
    try {
      await removePhysicalDownloadEntries([imapTarget]);
    } finally {
      await IOUtils.remove(imapTarget, {
        ignoreAbsent: true,
        retryReadonly: true,
      });
    }
  }
  await assertSelectedAttachmentBytes(
    imap.attachments[0],
    "physical-1\x00\xff"
  );
  const { attachments, folders, headers, incoming, daemon } =
    await physicalAttachmentFixture("nntp");
  const selected = headers[1];
  const token = selected.storeToken;
  const flags = selected.flags;
  incoming.closeCachedConnections();
  Services.cache2.clear();
  daemon.removeArticleFromGroup(folders[1].name, 5101);
  // Legacy NNTP also supports unscoped Message-ID fetches. Remove that server
  // article too, while leaving the other group's physical row and article.
  delete daemon._messages["<shared-selected-part@example.invalid>"];
  const target = PathUtils.join(savePath, "failed-part.bin");
  try {
    await Assert.rejects(
      attachments[0].saveToFile(target),
      error => error.result == Cr.NS_ERROR_FAILURE,
      "Actual ARTICLE failure survives the attachment command"
    );
    Assert.ok(
      !(await IOUtils.exists(target)),
      "Failed retrieval published no bytes"
    );
    Assert.equal(selected.storeToken, token);
    Assert.equal(selected.flags, flags);
    Assert.equal(folders[0].getTotalMessages(false), 1);
    Assert.equal(folders[1].getTotalMessages(false), 1);
    const wasOffline = Services.io.offline;
    Services.io.offline = true;
    try {
      await Assert.rejects(
        attachments[1].fetchAttachment(),
        error => error.result == Cr.NS_ERROR_OFFLINE,
        "Unavailable offline part retains the transport error"
      );
    } finally {
      Services.io.offline = wasOffline;
    }
  } finally {
    try {
      await removePhysicalDownloadEntries([target]);
    } finally {
      await IOUtils.remove(target, { ignoreAbsent: true, retryReadonly: true });
    }
  }
});

add_task(async function test_attachmentCachedTempFileDoesNotOutliveSelection() {
  const { folders, headers } = await physicalAttachmentFixture("local");
  const nested = create_message({ subject: "Selected attached message" });
  const normalize = text => text.replace(/\r\n?|\n/g, "\n");
  const raw = physicalAttachmentSource(1)
    .replace(
      "Content-Type: application/octet-stream",
      "Content-Type: message/rfc822"
    )
    .replace(btoa("physical-1\x00\xff"), btoa(nested.toMessageString()));
  const selected = folders[1]
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .addMessage(raw);
  const uri = folders[1].getUriForMsg(selected);
  const url = new URL(
    MailServices.messageServiceFromURI(uri).getUrlForUri(uri).spec
  );
  url.searchParams.set("part", "1.2");
  const attachment = new AttachmentInfo({
    contentType: "message/rfc822",
    name: "attached.eml",
    uri,
    url: url.href,
    message: selected,
  });
  const { MailUtils } = ChromeUtils.importESModule(
    "resource:///modules/MailUtils.sys.mjs"
  );
  const original = MailUtils.openEMLFile;
  const setup = attachment.setupTempFile;
  const ownedFiles = new Set();
  let createdTempFiles = 0;
  attachment.setupTempFile = async function (name) {
    const file = await setup.call(this, name);
    ownedFiles.add(file.path);
    createdTempFiles++;
    return file;
  };
  const opened = [];
  MailUtils.openEMLFile = (_win, file) => opened.push(file);
  try {
    await attachment.open(aboutMessage.browsingContext);
    Assert.equal(opened.length, 1);
    Assert.ok(
      (await IOUtils.readUTF8(opened[0].path)).includes(
        "Selected attached message"
      )
    );
    Assert.equal(
      normalize(await IOUtils.readUTF8(opened[0].path)),
      normalize(nested.toMessageString()),
      "Owned EML contains the complete selected attached message"
    );
    await attachment.open(aboutMessage.browsingContext);
    Assert.equal(opened.length, 2);
    Assert.equal(
      opened[0].path,
      opened[1].path,
      "Current source reuses its own file"
    );
    attachment.message = headers[0];
    await Assert.rejects(
      attachment.open(aboutMessage.browsingContext),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE
    );
    Assert.equal(opened.length, 2, "Stale source cannot reuse a cached file");
    attachment.message = selected;
    if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
      const storage = {
        token: selected.storeToken,
        size: selected.messageSize,
        offlineSize: selected.offlineMessageSize,
      };
      const replacement = create_message({
        subject: "Replacement attached message",
      });
      const changed = folders[1]
        .QueryInterface(Ci.nsIMsgLocalMailFolder)
        .addMessage(
          raw.replace(
            btoa(nested.toMessageString()),
            btoa(replacement.toMessageString())
          )
        );
      try {
        selected.storeToken = changed.storeToken;
        selected.messageSize = changed.messageSize;
        selected.offlineMessageSize = changed.offlineMessageSize;
        await attachment.open(aboutMessage.browsingContext);
        Assert.equal(opened.length, 3);
        Assert.equal(
          createdTempFiles,
          2,
          "Changed stored identity creates a fresh EML even if its pathname is reused"
        );
        Assert.notEqual(
          opened[2].path,
          opened[1].path,
          "Changed stored identity also gets a fresh live file URI"
        );
        Assert.ok(
          (await IOUtils.readUTF8(opened[2].path)).includes(
            "Replacement attached message"
          )
        );
        Assert.equal(
          normalize(await IOUtils.readUTF8(opened[2].path)),
          normalize(replacement.toMessageString()),
          "Refetched EML contains the complete changed stored body"
        );
        Assert.equal(
          attachment.message,
          selected,
          "The real selected header was not swapped"
        );
      } finally {
        selected.storeToken = storage.token;
        selected.messageSize = storage.size;
        selected.offlineMessageSize = storage.offlineSize;
      }
      await attachment.open(aboutMessage.browsingContext);
      Assert.equal(opened.length, 4);
      Assert.ok(
        (await IOUtils.readUTF8(opened[3].path)).includes(
          "Selected attached message"
        )
      );
      Assert.equal(
        normalize(await IOUtils.readUTF8(opened[3].path)),
        normalize(nested.toMessageString())
      );
      // Force creation through the actual download, then change only the real
      // stored parent before the awaited saveToFile call returns to open().
      await IOUtils.remove(opened[3].path, {
        ignoreAbsent: true,
        retryReadonly: true,
      });
      const save = attachment.saveToFile;
      let changedDuringSave = false;
      attachment.saveToFile = async function (...args) {
        await save.apply(this, args);
        selected.storeToken = changed.storeToken;
        selected.messageSize = changed.messageSize;
        selected.offlineMessageSize = changed.offlineMessageSize;
        changedDuringSave = true;
      };
      try {
        await Assert.rejects(
          attachment.open(aboutMessage.browsingContext),
          error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
          "A body changed during the awaited save cannot label or open old EML bytes"
        );
        Assert.ok(
          changedDuringSave,
          "Actual file save completed before the real header changed"
        );
        Assert.equal(opened.length, 4, "No stale EML handoff occurred");
      } finally {
        attachment.saveToFile = save;
        selected.storeToken = storage.token;
        selected.messageSize = storage.size;
        selected.offlineMessageSize = storage.offlineSize;
      }
      await attachment.open(aboutMessage.browsingContext);
      Assert.equal(
        opened.length,
        5,
        "Restored source can create a fresh owned cache"
      );
      Assert.equal(
        normalize(await IOUtils.readUTF8(opened[4].path)),
        normalize(nested.toMessageString())
      );
      const core = Cc["@mozilla.org/mailnews/database-core;1"].getService(
        Ci.nsIDatabaseCore
      );
      const connection = core.connectionForTests;
      // Fault the body-admission query over this ingested physical row without
      // inserting a fake message/header or relocation record.
      connection.executeSimpleSQL(
        "CREATE TEMP VIEW body_relocations AS SELECT folderId, 0 AS state FROM main.messages WHERE id=" +
          selected.messageKey
      );
      try {
        Assert.throws(() => selected.storeToken, /NS_ERROR_IN_PROGRESS/);
        await Assert.rejects(
          attachment.open(aboutMessage.browsingContext),
          error => error.result == Cr.NS_ERROR_IN_PROGRESS,
          "Owned EML reuse reaches the actual native body-access failure"
        );
        Assert.equal(
          opened.length,
          5,
          "Unavailable body never hands off old bytes"
        );
      } finally {
        connection.executeSimpleSQL("DROP VIEW temp.body_relocations");
      }
      await assertAttachmentSourceReplacement(attachment);
      Assert.equal(opened.length, 5);
      const service = core.QueryInterface(Ci.nsIMsgDBService);
      await be_in_folder(folders[0]);
      service.forceFolderDBClosed(folders[1]);
      await Assert.rejects(
        attachment.open(aboutMessage.browsingContext),
        error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
        "A replaced database cannot reuse owned EML bytes"
      );
      Assert.equal(opened.length, 5);
    }
  } finally {
    MailUtils.openEMLFile = original;
    attachment.setupTempFile = setup;
    for (const path of ownedFiles) {
      await IOUtils.remove(path, { ignoreAbsent: true, retryReadonly: true });
    }
  }
});

/**
 * Reads a real physical parent through the existing unconverted message stream.
 *
 * @param {nsIMsgDBHdr} header - Real selected parent.
 * @returns {Promise<string>} Complete raw parent bytes.
 */
async function readPhysicalParent(header) {
  const uri = header.folder.getUriForMsg(header);
  const listener = new PromiseTestUtils.PromiseStreamListener(null, true);
  const stop = listener.onStopRequest.bind(listener);
  listener.onStopRequest = (request, status) => {
    try {
      if (request instanceof Ci.nsIImapMockChannel) {
        request.Close();
      }
    } catch (error) {
      if (Components.isSuccessCode(status)) {
        listener._reject(error);
      } else {
        console.error(error);
      }
    }
    stop(request, status);
  };
  try {
    MailServices.messageServiceFromURI(uri).streamMessage(
      uri,
      listener,
      null,
      null,
      false,
      "",
      false
    );
  } catch (error) {
    listener._reject(error);
  }
  try {
    return await listener.promise;
  } finally {
    listener._stream?.close();
    listener._stream = null;
  }
}

/**
 * Replaces the actual selected news body in the synchronous first-publication
 * notification, using a different normally downloaded body in the same store.
 * Both file output and actual EML cache handoff must refuse the old bytes.
 */
async function assertPhysicalNewsPublicationMutation() {
  const { NewsArticle } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/Nntpd.sys.mjs"
  );
  const { MailUtils } = ChromeUtils.importESModule(
    "resource:///modules/MailUtils.sys.mjs"
  );
  for (const mode of ["binary", "eml", "encodedCR"]) {
    const eml = mode == "eml";
    const encodedBinary = mode == "encodedCR";
    const { folders, headers, attachments, daemon, incoming } =
      await physicalAttachmentFixture("nntp", { eml, encodedBinary });
    const parent = folders[1];
    const selected = headers[1];
    const attachment = attachments[0];
    const donorID = encodedBinary
      ? selected.messageId
      : "publication-donor-" + physicalFixtureIndex + "@example.invalid";
    daemon.addArticleToGroup(
      new NewsArticle(
        encodedBinary
          ? physicalEncodedBinarySource(1, parent.name).replace(
              btoa("A\rB\x00\xff"),
              btoa("A\r\nB\x00\xff")
            )
          : physicalAttachmentSource(eml ? 7 : 1, parent.name, false, eml)
              .replace("shared-selected-part@example.invalid", donorID)
              .replace(
                "Subject: Physical attachment 1",
                "Subject: Unrelated stored parent"
              )
      ),
      parent.name,
      5102
    );
    const discovery = new PromiseTestUtils.PromiseUrlListener();
    parent.getNewMessages(null, discovery);
    await discovery.promise;
    const donor = [...parent.messages].find(
      header =>
        header.messageId == donorID && header.messageKey != selected.messageKey
    );
    Assert.ok(
      donor,
      "The donor is a normally ingested real row in this same store"
    );
    parent.setFlag(Ci.nsMsgFolderFlags.Offline);
    incoming.limitOfflineMessageSize = false;
    Services.cache2.clear();
    const donorRaw = await readPhysicalParent(donor);
    if (encodedBinary) {
      Assert.ok(
        donorRaw.includes(btoa("A\r\nB\x00\xff")),
        "The actual donor encodes its different decoded binary bytes"
      );
      Assert.notEqual(
        physicalEncodedBinarySource(1, parent.name),
        physicalEncodedBinarySource(1, parent.name).replace(
          btoa("A\rB\x00\xff"),
          btoa("A\r\nB\x00\xff")
        )
      );
    } else if (!eml) {
      Assert.ok(
        donorRaw.includes(btoa("physical-1\x00\xff")),
        "The binary donor has the same requested part but a different complete parent"
      );
      Assert.ok(donorRaw.includes("Subject: Unrelated stored parent"));
    }
    Assert.ok(donor.flags & Ci.nsMsgMessageFlags.Offline);
    Assert.ok(donor.storeToken);
    Assert.equal(selected.storeToken, "");
    const donorBody = [
      donor.storeToken,
      donor.messageSize,
      donor.offlineMessageSize,
    ];
    let published;
    const database = parent.msgDatabase;
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
      onHdrFlagsChanged(header, before, after) {
        if (
          header.messageKey == selected.messageKey &&
          !(before & Ci.nsMsgMessageFlags.Offline) &&
          after & Ci.nsMsgMessageFlags.Offline
        ) {
          Assert.ok(!published, "The selected producer publishes only once");
          published = [
            selected.storeToken,
            selected.messageSize,
            selected.offlineMessageSize,
          ];
          Assert.notEqual(published[0], donorBody[0]);
          selected.storeToken = donorBody[0];
          selected.messageSize = donorBody[1];
          selected.offlineMessageSize = donorBody[2];
        }
      },
    };
    const target = PathUtils.join(savePath, "news-publication-race.bin");
    const files = [];
    const setup = attachment.setupTempFile;
    const open = MailUtils.openEMLFile;
    const opened = [];
    attachment.setupTempFile = async function (...args) {
      const file = await setup.apply(this, args);
      files.push(file);
      return file;
    };
    MailUtils.openEMLFile = (_window, file) => opened.push(file);
    database.addListener(listener);
    let operationError;
    const cleanupErrors = [];
    try {
      incoming.closeCachedConnections();
      Services.cache2.clear();
      await Assert.rejects(
        eml
          ? attachment.open(aboutMessage.browsingContext)
          : attachment.saveToFile(target),
        error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
        "An unrelated body installed inside publication cannot label completed bytes"
      );
      Assert.ok(
        published,
        "The actual synchronous Offline publication callback was reached"
      );
      Assert.equal(selected.storeToken, donorBody[0]);
      Assert.ok(!(await IOUtils.exists(target)));
      Assert.equal(
        opened.length,
        0,
        "No old-byte EML handoff or cache publication"
      );
      for (const file of files) {
        Assert.ok(!file.exists(), "The refused EML target was removed");
      }
      database.removeListener(listener);
      selected.storeToken = published[0];
      selected.messageSize = published[1];
      selected.offlineMessageSize = published[2];
      if (eml) {
        const createdBefore = files.length;
        await attachment.open(aboutMessage.browsingContext);
        Assert.equal(
          files.length,
          createdBefore + 1,
          "The refusal did not cache an old file"
        );
        Assert.equal(opened.length, 1);
        Assert.equal(
          (await IOUtils.readUTF8(opened[0].path)).replace(/\r\n?|\n/g, "\n"),
          physicalAttachedEML(1).replace(/\r\n?|\n/g, "\n")
        );
      } else {
        await assertSelectedAttachmentBytes(
          attachment,
          encodedBinary ? "A\rB\x00\xff" : "physical-1\x00\xff"
        );
      }
      Assert.equal(parent.getTotalMessages(false), 2);
      Assert.equal(folders[0].getTotalMessages(false), 1);
    } catch (error) {
      operationError = error;
    } finally {
      for (const cleanup of [
        () => database.removeListener(listener),
        () => {
          MailUtils.openEMLFile = open;
        },
        () => {
          attachment.setupTempFile = setup;
        },
        ...["storeToken", "messageSize", "offlineMessageSize"].map(
          (property, index) => () => {
            if (published) {
              selected[property] = published[index];
            }
          }
        ),
        () => parent.clearFlag(Ci.nsMsgFolderFlags.Offline),
      ]) {
        try {
          cleanup();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        await removePhysicalDownloadEntries([target]);
      } catch (error) {
        cleanupErrors.push(error);
      }
      const results = await Promise.allSettled(
        [target, ...files.map(file => file.path)].map(path =>
          IOUtils.remove(path, { ignoreAbsent: true, retryReadonly: true })
        )
      );
      cleanupErrors.push(
        ...results
          .filter(result => result.status == "rejected")
          .map(result => result.reason)
      );
    }
    if (cleanupErrors.length) {
      throw new AggregateError(
        operationError ? [operationError, ...cleanupErrors] : cleanupErrors,
        "News publication action or owned cleanup failed"
      );
    }
    if (operationError) {
      throw operationError;
    }
  }
}

/**
 * First uncached native IMAP modifications may normally publish an offline
 * parent. Exercise both delete and saved-part detach through the real command.
 */
async function assertPhysicalIMAPOfflineModification() {
  const { get_about_3pane } = ChromeUtils.importESModule(
    "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
  );
  for (const operation of ["DELETE", "DETACH"]) {
    const { folders, headers, attachments, incoming, daemon } =
      await physicalAttachmentFixture("imap", { uidplus: true });
    const selected = headers[1];
    const parent = folders[1];
    const commandHeader = [...parent.messages].find(
      header => header.messageKey == selected.messageKey
    );
    Assert.notEqual(
      commandHeader,
      attachments[0].message,
      "Normal native enumeration supplies a distinct real header for the same row"
    );
    Assert.equal(commandHeader.folder, selected.folder);
    const originalKey = selected.messageKey;
    const originalURI = parent.getUriForMsg(selected);
    Assert.equal(selected.storeToken, "");
    Assert.equal(selected.flags & Ci.nsMsgMessageFlags.Offline, 0);
    if (operation == "DELETE") {
      parent.setFlag(Ci.nsMsgFolderFlags.Offline);
    }
    incoming.limitOfflineMessageSize = false;
    await TestUtils.waitForCondition(() => incoming.allConnectionsIdle);
    incoming.closeCachedConnections();
    Services.cache2.clear();
    const service = MailServices.messageServiceFromURI(originalURI);
    Assert.ok(
      !service.isMsgInMemCache(service.getUrlForUri(originalURI), parent)
    );
    const stageBefore = (await IOUtils.getChildren(PathUtils.tempDir))
      .filter(path => PathUtils.filename(path).startsWith("tmp-msg"))
      .sort();
    const directory = await IOUtils.createUniqueDirectory(
      savePath,
      "imap-first-" + operation
    );
    const target = PathUtils.join(directory, attachments[0].name);
    const events = [];
    const database = parent.msgDatabase;
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
      onHdrFlagsChanged(header, before, after) {
        if (
          header.messageKey == originalKey &&
          !(before & Ci.nsMsgMessageFlags.Offline) &&
          after & Ci.nsMsgMessageFlags.Offline
        ) {
          events.push("offline");
          Assert.ok(selected.storeToken);
          Assert.ok(database.containsKey(originalKey));
          Assert.equal(parent.getTotalMessages(false), 1);
        }
      },

      onHdrDeleted(header) {
        if (header.messageKey == originalKey) {
          events.push("delete");
          Assert.ok(events.includes("copy"));
        }
      },
    };
    const added = {
      msgAdded(header) {
        if (header.folder == parent && header.messageKey != originalKey) {
          events.push("copy");
          Assert.ok(
            database.containsKey(originalKey),
            "The replacement is published before original deletion"
          );
        }
      },
    };
    const save = attachments[0].saveToFile;
    if (operation == "DETACH") {
      attachments[0].saveToFile = async function (...args) {
        await save.apply(this, args);
        events.push("save");
        Assert.equal(
          selected.storeToken,
          "",
          "The saved part has no offline parent yet"
        );
        Assert.deepEqual(
          await IOUtils.read(target),
          Uint8Array.from("physical-1\x00\xff", c => c.charCodeAt(0))
        );
        parent.setFlag(Ci.nsMsgFolderFlags.Offline);
        await TestUtils.waitForCondition(() => incoming.allConnectionsIdle);
        incoming.closeCachedConnections();
        Services.cache2.clear();
        Assert.ok(
          !service.isMsgInMemCache(service.getUrlForUri(originalURI), parent)
        );
      };
    }
    database.addListener(listener);
    MailServices.mfn.addListener(added, MailServices.mfn.msgAdded);
    // Keep the actual reader out of the modifying command's notifications;
    // its retained attachment and physical header are still the inputs.
    try {
      await be_in_folder(folders[0]);
      if (operation == "DELETE") {
        await AttachmentInfo.deleteAttachments(commandHeader, [attachments[0]]);
      } else {
        await AttachmentInfo.detachAttachments(
          commandHeader,
          [attachments[0]],
          directory
        );
        Assert.deepEqual(
          await IOUtils.read(target),
          Uint8Array.from("physical-1\x00\xff", c => c.charCodeAt(0))
        );
      }
      Assert.ok(
        events.includes("offline"),
        "Normal first download published its offline body"
      );
      if (operation == "DETACH") {
        Assert.less(
          events.indexOf("save"),
          events.indexOf("offline"),
          "Strip preparation published only after the exact selected part was saved"
        );
      }
      Assert.less(events.indexOf("offline"), events.indexOf("copy"));
      Assert.less(events.indexOf("copy"), events.indexOf("delete"));
      Assert.ok(!database.containsKey(originalKey));
      Assert.equal(folders[0].getTotalMessages(false), 1);
      const live = [...parent.messages].filter(
        header => !(header.flags & Ci.nsMsgMessageFlags.IMAPDeleted)
      );
      Assert.equal(live.length, 1);
      const replacement = live[0];
      Assert.notEqual(replacement.messageKey, originalKey);
      const raw = await readPhysicalParent(replacement);
      Assert.ok(raw.includes("Subject: Physical attachment 1"));
      Assert.ok(!raw.includes(btoa("physical-1\x00\xff")));
      Assert.ok(
        raw.includes(btoa("nested-1")),
        "The other selected part remains exact"
      );
      Assert.ok(!raw.includes(btoa("physical-0\x00\xff")));
      if (operation == "DETACH") {
        Assert.ok(
          raw.includes(
            "X-Mozilla-External-Attachment-URL: " + PathUtils.toFileURI(target)
          )
        );
      } else {
        Assert.ok(raw.includes("text/x-moz-deleted"));
      }
      const wire = daemon
        .getMailbox(parent.name)
        ._messages.filter(message => !message.flags.includes("\\Deleted"));
      Assert.equal(
        wire.length,
        1,
        "The fake server has only the live replacement"
      );
      Assert.ok(!wire[0].getText().includes(btoa("physical-1\x00\xff")));
      Assert.deepEqual(
        (await IOUtils.getChildren(PathUtils.tempDir))
          .filter(path => PathUtils.filename(path).startsWith("tmp-msg"))
          .sort(),
        stageBefore,
        "No replacement staging file remains"
      );
      Assert.equal(get_about_3pane().gFolder, folders[0]);
    } finally {
      attachments[0].saveToFile = save;
      try {
        database.removeListener(listener);
      } finally {
        MailServices.mfn.removeListener(added);
      }
      parent.clearFlag(Ci.nsMsgFolderFlags.Offline);
      try {
        await removePhysicalDownloadEntries([target]);
      } finally {
        await IOUtils.remove(directory, {
          recursive: true,
          retryReadonly: true,
        });
      }
    }
  }
}

/**
 * Reports actual full-message FETCH/STORE and APPEND commands seen by the fake
 * transport, without confusing connection handshakes with body retrieval.
 *
 * @param {nsMailServer} server - The normally running owned fake server.
 * @returns {string[]} Complete relevant client command lines.
 */
function physicalModifyingCommands(server) {
  const transactions = server.playTransaction();
  return (Array.isArray(transactions) ? transactions : [transactions])
    .flatMap(transaction => transaction.them)
    .filter(line => /\b(?:UID (?:FETCH|STORE)|FETCH|APPEND)\b/i.test(line));
}

/**
 * Real native folder ACLs must refuse before the new parent preparation, even
 * when the selected uncached parent fits offline criteria or a FETCH would fail.
 */
async function assertPhysicalIMAPDeniedModification() {
  for (const denied of [
    {
      rights: "lrsi",
      canDelete: false,
      canFile: true,
      error: "Cannot delete messages",
    },
    {
      rights: "lrstd",
      canDelete: true,
      canFile: false,
      error: "Cannot file messages",
    },
  ]) {
    const { folders, headers, attachments, incoming, daemon, server } =
      await physicalAttachmentFixture("imap", {
        uidplus: true,
        rights: denied.rights,
      });
    const selected = headers[1];
    const parent = folders[1];
    // The existing production ACL publication interface acts on this actual
    // native folder; no folder/header object or permission getter is replaced.
    parent
      .QueryInterface(Ci.nsIMsgImapMailFolder)
      .addFolderRights(incoming.username, denied.rights);
    Assert.equal(parent.canDeleteMessages, denied.canDelete);
    Assert.equal(parent.canFileMessages, denied.canFile);
    Assert.equal(selected.storeToken, "");
    const before = [
      selected.storeToken,
      selected.messageSize,
      selected.offlineMessageSize,
      selected.flags,
    ];
    parent.setFlag(Ci.nsMsgFolderFlags.Offline);
    incoming.limitOfflineMessageSize = false;
    Assert.ok(parent.shouldStoreMsgOffline(selected.messageKey));
    await be_in_folder(folders[0]);
    await TestUtils.waitForCondition(() => incoming.allConnectionsIdle);
    incoming.closeCachedConnections();
    Services.cache2.clear();
    const service = MailServices.messageServiceFromURI(
      parent.getUriForMsg(selected)
    );
    Assert.ok(
      !service.isMsgInMemCache(
        service.getUrlForUri(parent.getUriForMsg(selected)),
        parent
      )
    );
    const directory = await IOUtils.createUniqueDirectory(
      savePath,
      "denied-imap"
    );
    const commands = physicalModifyingCommands(server);
    const stageBefore = (await IOUtils.getChildren(PathUtils.tempDir))
      .filter(path => PathUtils.filename(path).startsWith("tmp-msg"))
      .sort();
    try {
      for (const failingServer of [false, true]) {
        daemon.commandToFail = failingServer ? "UID" : "";
        await Assert.rejects(
          AttachmentInfo.deleteAttachments(selected, [attachments[0]]),
          error =>
            error.message == `DELETE FAILED. ${denied.error} in ${parent.URI}`,
          "The original permission refusal precedes any successful or failing producer"
        );
        await Assert.rejects(
          AttachmentInfo.detachAttachments(
            selected,
            [attachments[0]],
            directory
          ),
          error =>
            error.message == `DETACH FAILED. ${denied.error} in ${parent.URI}`,
          "Denied multi-detach cannot fetch or save a parent first"
        );
        await Assert.rejects(
          attachments[0].detachFromMessage(aboutMessage.browsingContext),
          error =>
            error.message == `DETACH FAILED. ${denied.error} in ${parent.URI}`,
          "Denied single-detach cannot fetch or show a save picker first"
        );
        Assert.deepEqual(
          physicalModifyingCommands(server),
          commands,
          "No FETCH, STORE or APPEND reaches the actual server"
        );
        Assert.deepEqual(
          [
            selected.storeToken,
            selected.messageSize,
            selected.offlineMessageSize,
            selected.flags,
          ],
          before,
          "No offline body metadata or flags are published"
        );
        Assert.equal(parent.getTotalMessages(false), 1);
        Assert.equal(folders[0].getTotalMessages(false), 1);
        Assert.ok(parent.msgDatabase.containsKey(selected.messageKey));
        Assert.equal((await IOUtils.getChildren(directory)).length, 0);
        Assert.deepEqual(
          (await IOUtils.getChildren(PathUtils.tempDir))
            .filter(path => PathUtils.filename(path).startsWith("tmp-msg"))
            .sort(),
          stageBefore
        );
      }
    } finally {
      daemon.commandToFail = "";
      parent
        .QueryInterface(Ci.nsIMsgImapMailFolder)
        .addFolderRights(incoming.username, "lrswipkxtea");
      parent.clearFlag(Ci.nsMsgFolderFlags.Offline);
      await IOUtils.remove(directory, { recursive: true, retryReadonly: true });
    }
  }
}

/**
 * Without APPENDUID, the actual fallback sees original and replacement sharing
 * an ID. Its real ambiguity error must leave the original and never resend.
 */
async function assertPhysicalIMAPAmbiguousAppendRefusal() {
  const { folders, headers, attachments, incoming, daemon, server } =
    await physicalAttachmentFixture("imap");
  const selected = headers[1];
  const parent = folders[1];
  const key = selected.messageKey;
  const stageBefore = (await IOUtils.getChildren(PathUtils.tempDir))
    .filter(path => PathUtils.filename(path).startsWith("tmp-msg"))
    .sort();
  parent.setFlag(Ci.nsMsgFolderFlags.Offline);
  incoming.limitOfflineMessageSize = false;
  await be_in_folder(folders[0]);
  await TestUtils.waitForCondition(() => incoming.allConnectionsIdle);
  incoming.closeCachedConnections();
  Services.cache2.clear();
  const before = physicalModifyingCommands(server);
  try {
    await Assert.rejects(
      AttachmentInfo.deleteAttachments(selected, [attachments[0]]),
      error =>
        error.result == Cr.NS_ERROR_NOT_AVAILABLE &&
        error.message.includes("Copy FAILED"),
      "The actual unreceipted duplicate-ID APPEND remains an exact ambiguity refusal"
    );
    Assert.ok(parent.msgDatabase.containsKey(key));
    Assert.equal(selected.messageKey, key);
    Assert.equal(selected.flags & Ci.nsMsgMessageFlags.IMAPDeleted, 0);
    Assert.ok(selected.storeToken);
    const raw = await readPhysicalParent(selected);
    Assert.ok(raw.includes(btoa("physical-1\x00\xff")));
    Assert.ok(raw.includes(btoa("nested-1")));
    Assert.equal(folders[0].getTotalMessages(false), 1);
    const wire = daemon.getMailbox(parent.name)._messages;
    Assert.equal(wire.length, 2, "The one acknowledged APPEND is not retried");
    Assert.equal(
      wire.filter(message => message.flags.includes("\\Deleted")).length,
      0
    );
    Assert.equal(
      wire.filter(message =>
        message.getText().includes(btoa("physical-1\x00\xff"))
      ).length,
      1
    );
    const commands = physicalModifyingCommands(server).slice(before.length);
    Assert.equal(commands.filter(line => /\bAPPEND\b/i.test(line)).length, 1);
    Assert.ok(
      !commands.some(line => /\bSTORE\b/i.test(line)),
      "No original deletion is dispatched after ambiguous copy"
    );
    Assert.deepEqual(
      (await IOUtils.getChildren(PathUtils.tempDir))
        .filter(path => PathUtils.filename(path).startsWith("tmp-msg"))
        .sort(),
      stageBefore
    );
  } finally {
    parent.clearFlag(Ci.nsMsgFolderFlags.Offline);
  }
}

/** Record the remaining native animation owner without changing UI state. */
add_task(function record_attachment_cleanup_animation_owner() {
  registerCleanupFunction(() => {
    const tabmail = document.getElementById("tabmail");
    const mailTab = tabmail.tabInfo.find(
      tab => tab.mode.name == "mail3PaneTab"
    );
    const pane = mailTab?.chromeBrowser.contentWindow;
    const reader = pane?.messageBrowser.contentWindow;
    const documents = [
      ["chrome", document],
      ["three-pane", pane?.document],
      ["message", reader?.document],
    ];
    info(
      "ATTACHMENT_CLEANUP_ANIMATION_OWNER " +
        JSON.stringify({
          native: Services.prefs.getBoolPref("mail.panorama.enabled", false),
          vsync: ChromeUtils.vsyncEnabled(),
          feedback: {
            started: window.MsgStatusFeedback._startRequests,
            spinning: window.MsgStatusFeedback._meteorsSpinning,
            startPending: window.MsgStatusFeedback._startTimeoutID != null,
            stopPending: window.MsgStatusFeedback._stopTimeoutID != null,
          },
          documents: documents.map(([label, doc]) => ({
            label,
            uri: doc?.documentURI,
            animations: (doc?.getAnimations() ?? []).map(animation => ({
              name: animation.animationName,
              state: animation.playState,
              target: animation.effect?.target?.localName,
              id: animation.effect?.target?.id,
              classes: String(animation.effect?.target?.className ?? ""),
            })),
          })),
          tabs: tabmail.tabInfo.map(tab => ({
            mode: tab.mode.name,
            busy: tab.busy,
            uri: tab.browser?.currentURI?.spec,
          })),
          message: {
            uri: reader?.gMessageURI,
            loading:
              reader?.getMessagePaneBrowser()?.webProgress.isLoadingDocument,
            browserURI: reader?.getMessagePaneBrowser()?.currentURI.spec,
          },
        })
    );
  });
});

// Register at file evaluation, before fixture cleanup is registered by tasks.
// The generic blank-pane helper skips hidden browsers; owned loads must finish
// before their folders and servers are removed, even after the pane is hidden.
registerCleanupFunction(async function finishOwnedHiddenAttachmentReader() {
  const tabmail = document.getElementById("tabmail");
  const mailTab = tabmail.tabInfo.find(tab => tab.mode.name == "mail3PaneTab");
  Assert.ok(mailTab, "Owned reader cleanup retains its mail tab");
  tabmail.switchToTab(mailTab);
  const { MailServices: readerMailServices } = ChromeUtils.importESModule(
    "resource:///modules/MailServices.sys.mjs"
  );
  await be_in_folder(readerMailServices.accounts.localFoldersServer.rootFolder);
  const pane = mailTab.chromeBrowser.contentWindow;
  const reader = pane.messageBrowser.contentWindow;
  const browser = reader.getMessagePaneBrowser();
  reader.displayMessage();
  // Start a real navigation even if currentURI is blank while an older load
  // is still pending. loadAboutBlank otherwise returns early in that state.
  await BrowserTestUtils.loadURIString({ browser, uriString: "about:blank" });
  await TestUtils.waitForCondition(
    () =>
      browser.currentURI.spec == "about:blank" &&
      !browser.webProgress.isLoadingDocument,
    "The owned hidden attachment reader reaches its real blank terminal"
  );
  Assert.equal(browser.currentURI.spec, "about:blank");
  Assert.ok(!browser.webProgress.isLoadingDocument);
  info("ATTACHMENT_HIDDEN_READER_TERMINAL " + browser.currentURI.spec);

  // Queue the observational detail after all already registered fixture
  // teardown. Do not finish, cancel or otherwise alter any animation.
  registerCleanupFunction(() => {
    const animations = pane.document.getAnimations();
    info(
      "ATTACHMENT_CLEANUP_ANIMATION_DETAILS " +
        JSON.stringify({
          vsync: ChromeUtils.vsyncEnabled(),
          feedbackStarts: window.MsgStatusFeedback._startRequests,
          spinning: window.MsgStatusFeedback._meteorsSpinning,
          animationCount: animations.length,
          animations: animations.map(animation => ({
            kind: animation.constructor.name,
            name: animation.animationName,
            transition: animation.transitionProperty,
            state: animation.playState,
            timing: animation.effect?.getComputedTiming(),
            target: animation.effect?.target?.localName,
            classes: String(animation.effect?.target?.className ?? ""),
            parentId: animation.effect?.target?.parentElement?.id,
            ancestorId: animation.effect?.target?.closest?.("[id]")?.id,
            shadowHost:
              animation.effect?.target?.getRootNode?.().host?.localName,
          })),
          browserURI: browser.currentURI.spec,
          loading: browser.webProgress.isLoadingDocument,
        })
    );
  });
});

// Identify the retained standard activity after normal owned teardown. This
// observes the real producer; it does not complete, cancel or remove activities.
registerCleanupFunction(() => {
  registerCleanupFunction(() => {
    const feedback = window.MsgStatusFeedback;
    info(
      "ATTACHMENT_CLEANUP_ACTIVITY_OWNER " +
        JSON.stringify({
          native: Services.prefs.getBoolPref("mail.panorama.enabled", false),
          indexerEnabled: Services.prefs.getBoolPref(
            "mailnews.database.global.indexer.enabled",
            false
          ),
          starts: feedback._startRequests,
          spinning: feedback._meteorsSpinning,
          activities: feedback._activeProcesses.map(activity => ({
            id: activity.id,
            state: activity.state,
            paused: activity.state == Ci.nsIActivityProcess.STATE_PAUSED,
            running: activity.state == Ci.nsIActivityProcess.STATE_INPROGRESS,
            displayText: activity.displayText,
            lastStatusText: activity.lastStatusText,
            contextType: activity.contextType,
            contextObj: String(activity.contextObj),
            percentComplete: activity.percentComplete,
          })),
        })
    );
  });
});
