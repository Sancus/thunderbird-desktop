/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { MailServices } from "resource:///modules/MailServices.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  DownloadPaths: "resource://gre/modules/DownloadPaths.sys.mjs",
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  MailStringUtils: "resource:///modules/MailStringUtils.sys.mjs",
  MailUtils: "resource:///modules/MailUtils.sys.mjs",
  MIME_PART_RE: "resource:///modules/panorama/MimeMessage.sys.mjs",
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
  captureNativeNewsArticle: "resource:///modules/NntpClient.sys.mjs",
  revalidateNativeNewsArticle: "resource:///modules/NntpClient.sys.mjs",
});

XPCOMUtils.defineLazyServiceGetters(lazy, {
  gHandlerService: [
    "@mozilla.org/uriloader/handler-service;1",
    Ci.nsIHandlerService,
  ],
  gMIMEService: ["@mozilla.org/mime;1", Ci.nsIMIMEService],
});

ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () => new Localization(["messenger/attachmentInfo.ftl"])
);

/**
 * A class to handle attachment information and actions.
 */
export class AttachmentInfo {
  /**
   * A cache of message/rfc822 attachments saved to temporary files for display.
   * Saving the same attachment again is avoided.
   *
   * @type {Map<string, {file: nsIFile, body: ?string}>}
   */
  #temporaryFiles = new Map();

  /** @type {WeakMap<ArrayBuffer, {body: ?string}>} */
  #fetchedBodies = new WeakMap();

  /** @type {Map<string, {body: ?string}>} */
  #savedBodies = new Map();

  /**
   * The physical parent and part retained when this attachment was displayed.
   * Standalone files and compose attachments can have no parent header.
   *
   * @type {?object}
   */
  #selection = null;

  /**
   * A function to call when checking to see if an attachment exists or not, so
   * that the display can be updated.
   *
   * @type {Function}
   */
  #updateAttachmentsDisplayFn = null;

  /**
   * Create a new attachment object which goes into the data attachment array.
   * This method checks whether the passed attachment is empty or not.
   *
   * @param {object} options
   * @param {string} options.contentType - The attachment's mimetype.
   * @param {string} options.url - The URL for the attachment.
   * @param {string} options.name - The name to be displayed for this attachment
   *   (usually the filename).
   * @param {string} options.uri - The URI for the message containing the
   *   attachment.
   * @param {boolean} [options.isExternalAttachment] - true if the attachment has
   *   been detached to file or is a link attachment.
   * @param {nsIMsgDBHdr} [options.message] - The message object associated to this
   *   attachment.
   * @param {Function} [options.updateAttachmentsDisplayFn] - An optional callback
   *   function that is called to update the attachment display at appropriate
   *   times.
   */
  constructor({
    contentType,
    url,
    name,
    uri,
    isExternalAttachment,
    message,
    updateAttachmentsDisplayFn,
  }) {
    this.message = message;
    this.contentType = contentType;
    this.name = name;
    if (/-message:\/\//.test(url)) {
      throw new Error(`Not a neckoURL: ${url}`);
    }
    this.url = url;
    this.uri = uri;
    this.isExternalAttachment = isExternalAttachment;
    this.#updateAttachmentsDisplayFn = updateAttachmentsDisplayFn;
    // A |size| value of -1 means we don't have a valid size. Check again if
    // |sizeResolved| is false. For internal attachments and link attachments
    // with a reported size, libmime streams values to addAttachmentField()
    // which updates this object. For external file attachments, |size| is updated
    // in the #() function when the list is built. Deleted attachments
    // are resolved to -1.
    this.size = -1;
    this.sizeResolved = this.isDeleted;

    // Remove [?&]part= from remote urls, after getting the partID.
    // Remote urls, unlike non external mail part urls, may also contain query
    // strings starting with ?; PART_RE does not handle this.
    if (this.isLinkAttachment || this.isFileAttachment) {
      let match = url.match(/[?&]part=[^&]+$/);
      match = match && match[0];
      this.partID = match && match.split("part=")[1];
      this.url = url.replace(match, "");
    } else {
      const match = lazy.MIME_PART_RE.exec(url);
      this.partID = match && match[1];
    }
    if (message?.folder) {
      const folder = message.folder;
      const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
      const database = folder.msgDatabase;
      this.#selection = {
        message,
        folder,
        database,
        key: message.messageKey,
        uri: folder.getUriForMsg(message),
        inputURI: uri,
        url: this.url,
        part: this.partID,
        sourceId: native
          ? Cc["@mozilla.org/mailnews/database-core;1"].getService(
              Ci.nsIDatabaseCore
            ).sourceId
          : null,
        epoch:
          native && folder instanceof Ci.nsIMsgImapMailFolder
            ? database.dBFolderInfo.imapUidValidity
            : null,
        uid:
          native && folder instanceof Ci.nsIMsgImapMailFolder
            ? message.getUint32Property("uidOnServer")
            : null,
        news:
          native && folder instanceof Ci.nsIMsgNewsFolder
            ? lazy.captureNativeNewsArticle(folder, message.messageKey)
            : null,
      };
    }
  }

  /**
   * Checks the retained physical parent and MIME section. Native getter errors
   * propagate unchanged; an explicit identity mismatch reports NOT_AVAILABLE.
   *
   * @param {nsIMsgDBHdr} [message=this.message] - Parent for a modifying command.
   * @throws {nsIException} If the selected source or part is no longer current.
   */
  #validateSelection(message = this.message) {
    const selected = this.#selection;
    if (!selected) {
      return;
    }
    const unavailable = () => {
      throw Components.Exception(
        "Attachment selection is no longer current",
        Cr.NS_ERROR_NOT_AVAILABLE
      );
    };
    if (
      this.message !== selected.message ||
      this.uri !== selected.inputURI ||
      this.url !== selected.url ||
      this.partID !== selected.part
    ) {
      unavailable();
    }
    if (selected.sourceId !== null) {
      const core = Cc["@mozilla.org/mailnews/database-core;1"].getService(
        Ci.nsIDatabaseCore
      );
      if (core.sourceId !== selected.sourceId) {
        unavailable();
      }
    }
    // Normal enumeration and display can return different real header objects
    // for this same physical row. Validate the command header's native folder
    // and key below, rather than requiring JavaScript wrapper identity.
    const { folder, database, key } = selected;
    if (!database.containsKey(key)) {
      unavailable();
    }
    const current = database.getMsgHdrForKey(key);
    if (
      message.folder !== folder ||
      message.messageKey !== key ||
      current.folder !== folder ||
      folder.getUriForMsg(current) !== selected.uri ||
      folder.msgDatabase !== database
    ) {
      unavailable();
    }
    if (
      selected.epoch !== null &&
      (database.dBFolderInfo.imapUidValidity !== selected.epoch ||
        current.getUint32Property("uidOnServer") !== selected.uid)
    ) {
      unavailable();
    }
    if (selected.news) {
      lazy.revalidateNativeNewsArticle(selected.news);
    }
    if (
      !this.isExternalAttachment &&
      (folder instanceof Ci.nsIMsgLocalMailFolder ||
        folder instanceof Ci.nsIMsgNewsFolder)
    ) {
      const expected = new URL(
        MailServices.messageServiceFromURI(selected.uri).getUrlForUri(
          selected.uri
        ).spec
      );
      const actual = new URL(this.url);
      if (
        actual.protocol !== expected.protocol ||
        actual.hostname !== expected.hostname ||
        actual.port !== expected.port ||
        actual.pathname !== expected.pathname ||
        ["number", "group", "key"].some(
          field =>
            actual.searchParams.get(field) !== expected.searchParams.get(field)
        )
      ) {
        unavailable();
      }
    }
  }

  /**
   * Reads native stored-body identity through the existing body-access gate.
   * Standalone and legacy attachments do not have a native body snapshot.
   *
   * @returns {?string} The current token and sizes, or null for non-native input.
   * @throws {nsIException} The original native body-access failure.
   */
  #bodyIdentity() {
    if (!this.#selection?.sourceId || this.isExternalAttachment) {
      return null;
    }
    const { message } = this.#selection;
    return JSON.stringify([
      message.storeToken,
      message.messageSize,
      message.offlineMessageSize,
    ]);
  }

  /**
   * Checks that bytes still belong to the captured native stored body.
   *
   * @param {?string} body - Identity captured before retrieving the bytes.
   * @throws {nsIException} The original access error or NOT_AVAILABLE on change.
   */
  #validateBodyIdentity(body) {
    this.#validateSelection();
    if (this.#bodyIdentity() !== body) {
      throw Components.Exception(
        "Attachment body changed during retrieval or saving",
        Cr.NS_ERROR_NOT_AVAILABLE
      );
    }
  }

  /**
   * Releases the completed IMAP channel's listener/load-group ownership using
   * its existing public terminal close operation. Other protocols settle their
   * own channels. Callers preserve an earlier producer error over cleanup.
   *
   * @param {?nsIRequest} request - The terminal request delivered to our listener.
   */
  static #closeCompletedRequest(request) {
    if (request instanceof Ci.nsIImapMockChannel) {
      request.Close();
    }
  }

  /**
   * Completes an initial remote offline download before consuming a part or
   * stripping its parent. A mutable header at completion is not a receipt:
   * compare the complete successfully streamed parent with the actual stored
   * parent before accepting its new identity. Then subsequent reads use that
   * fixed identity, including across synchronous publication listeners.
   *
   * @returns {Promise<?string>} The checked stored-body identity.
   */
  async #prepareRemoteBody() {
    this.#validateSelection();
    const before = this.#bodyIdentity();
    const selected = this.#selection;
    if (
      !before ||
      this.isExternalAttachment ||
      !(
        selected.folder instanceof Ci.nsIMsgNewsFolder ||
        selected.folder instanceof Ci.nsIMsgImapMailFolder
      ) ||
      JSON.parse(before)[0] ||
      this.message.flags & Ci.nsMsgMessageFlags.Offline ||
      !selected.folder.shouldStoreMsgOffline(selected.key)
    ) {
      return before;
    }

    const { promise, resolve, reject } = Promise.withResolvers();
    const chunks = [];
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
      onStartRequest() {},
      onDataAvailable(request, stream, _offset, count) {
        try {
          chunks.push(lazy.NetUtil.readInputStreamToString(stream, count));
        } catch (error) {
          reject(error);
          request.cancel(error.result || Cr.NS_ERROR_FAILURE);
        }
      },
      onStopRequest(request, status) {
        let failure = Components.isSuccessCode(status)
          ? null
          : Components.Exception(
              "Failed to download attachment parent",
              status
            );
        try {
          AttachmentInfo.#closeCompletedRequest(request);
        } catch (error) {
          if (!failure) {
            failure = error;
          } else {
            console.error(error);
          }
        }
        if (failure) {
          reject(failure);
        } else {
          resolve(chunks.join(""));
        }
        chunks.length = 0;
      },
    };
    try {
      MailServices.messageServiceFromURI(selected.uri).streamMessage(
        selected.uri,
        listener,
        null,
        null,
        false,
        "",
        false
      );
    } catch (error) {
      reject(error);
    }
    const raw = await promise;
    this.#validateSelection();
    const body = this.#bodyIdentity();
    if (body === before) {
      return body;
    }
    const published = JSON.parse(body);
    if (
      !published[0] ||
      !published[2] ||
      !(this.message.flags & Ci.nsMsgMessageFlags.Offline)
    ) {
      this.#validateBodyIdentity(before);
    }

    // Read the selected store directly. No memory cache or protocol fallback
    // may substitute for the body whose identity is about to be retained.
    const stream = selected.folder.getMsgInputStream(this.message);
    let stored = "";
    let readError;
    try {
      while (stream.available()) {
        stored += lazy.NetUtil.readInputStreamToString(
          stream,
          stream.available()
        );
      }
    } catch (error) {
      readError = error;
    }
    try {
      stream.close();
    } catch (error) {
      if (!readError) {
        readError = error;
      } else {
        console.error(error);
      }
    }
    if (readError) {
      throw readError;
    }
    this.#validateBodyIdentity(body);
    // The standard offline writers prepend exactly these two bookkeeping
    // lines and use native line endings. Compare every original header and
    // body byte after that prefix, not merely the requested MIME part.
    const normalize = data => data.replace(/\r\n/g, "\n");
    const prefix =
      /^X-Mozilla-Status: [\da-f]{4}\nX-Mozilla-Status2: [\da-f]{8}\n/i;
    stored = normalize(stored);
    if (!prefix.test(stored) || stored.replace(prefix, "") !== normalize(raw)) {
      throw Components.Exception(
        "Published attachment parent differs from the completed download",
        Cr.NS_ERROR_NOT_AVAILABLE
      );
    }
    return body;
  }

  /**
   * A filename, based on the attachment name, that is safe to use as a single
   * path component.
   *
   * @type {string}
   */
  get #filename() {
    return lazy.DownloadPaths.sanitize(this.name) || "attachment";
  }

  /**
   * Get a filename for each attachment, numbering names that would otherwise
   * collide, so that no two attachments are saved to the same file.
   *
   * @param {AttachmentInfo[]} attachments - The attachments to name.
   * @returns {Map<string,string>} map of attachment URL to filename.
   */
  static #uniqueFilenames(attachments) {
    const filenames = new Map();
    const reservedNames = new Set(
      attachments.map(a => a.#filename.toLowerCase())
    );
    const usedNames = new Set();
    for (const attachment of attachments) {
      let filename = attachment.#filename;
      if (usedNames.has(filename.toLowerCase())) {
        const [base, ext] =
          lazy.DownloadPaths.splitBaseNameAndExtension(filename);
        for (
          let i = 1;
          reservedNames.has(filename.toLowerCase()) ||
          usedNames.has(filename.toLowerCase());
          i++
        ) {
          filename = `${base}(${i})${ext}`;
        }
      }
      usedNames.add(filename.toLowerCase());
      filenames.set(attachment.url, filename);
    }
    return filenames;
  }

  /**
   * Save this attachment to a file.
   *
   * @param {BrowsingContext} browsingContext - The browsing context to use.
   * @param {string} [fpDialogTitle] - File picker dialog title, to override
   *   the default "save attachment" title.
   * @returns {?string} the path of the saved attachment. null if not saved.
   */
  async save(browsingContext, fpDialogTitle) {
    if (!this.hasFile) {
      return null;
    }
    if (await this.isEmpty()) {
      return null;
    }

    const title =
      fpDialogTitle ||
      (await lazy.l10n.formatValue("attachment-save-dialog-title"));
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(browsingContext, title, Ci.nsIFilePicker.modeSave);
    fp.defaultString = this.name.replaceAll(/[/:*?\"<>|]/g, "_");
    const ext = this.name.includes(".") ? this.name.split(".").pop() : null;
    if (ext && !ext.includes(" ")) {
      fp.defaultExtension = ext;
      try {
        const mimeInfo = lazy.gMIMEService.getFromTypeAndExtension("", ext);
        fp.appendFilter(mimeInfo?.description, `*.${ext}`);
      } catch (e) {} // Nothing registered for that ext.
    }
    fp.appendFilters(Ci.nsIFilePicker.filterAll);

    try {
      const lastSaveDir = Services.prefs.getComplexValue(
        "messenger.save.dir",
        Ci.nsIFile
      );
      fp.displayDirectory = lastSaveDir;
    } catch (e) {} // Pref may not be set, yet.

    const result = await new Promise(resolve => fp.open(resolve));
    if (result == Ci.nsIFilePicker.returnCancel) {
      return null;
    }

    Services.prefs.setComplexValue(
      "messenger.save.dir",
      Ci.nsIFile,
      fp.file.parent
    );
    const path = fp.file.path;
    try {
      await this.saveToFile(path);
    } catch (e) {
      console.warn(`Saving ${this.name} to ${path} FAILED.`, e);
      Services.prompt.alert(
        null,
        title,
        await lazy.l10n.formatValue("attachment-save-failed")
      );
      return this.save(browsingContext, fpDialogTitle);
    }
    browsingContext.window.dispatchEvent(
      new CustomEvent("attachmentSaved", { detail: { name: this.name, path } })
    );
    return path;
  }

  /**
   * Save attachments to a file.
   *
   * @param {AttachmentInfo[]} attachments - The attachments to save.
   * @param {BrowsingContext} browsingContext - The browsing context to use.
   * @param {string} [fpDialogTitle] - File picker dialog title, to override
   *   the default "save attachment" title.
   * @returns {?string} the dir path of the saved attachments. null if not saved.
   */
  static async saveAttachments(attachments, browsingContext, fpDialogTitle) {
    for (const attachment of attachments) {
      if (!attachment.hasFile) {
        return null;
      }
      if (await attachment.isEmpty()) {
        return null;
      }
    }

    const title =
      fpDialogTitle ||
      (await lazy.l10n.formatValue("attachment-save-all-dialog-title"));
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(browsingContext, title, Ci.nsIFilePicker.modeGetFolder);
    try {
      const lastSaveDir = Services.prefs.getComplexValue(
        "messenger.save.dir",
        Ci.nsIFile
      );
      fp.displayDirectory = lastSaveDir;
    } catch (e) {} // Pref may not be set, yet.

    const result = await new Promise(resolve => fp.open(resolve));
    if (result == Ci.nsIFilePicker.returnCancel) {
      return null;
    }

    Services.prefs.setComplexValue("messenger.save.dir", Ci.nsIFile, fp.file);

    const filenames = AttachmentInfo.#uniqueFilenames(attachments);
    try {
      for (const attachment of attachments) {
        const filename = filenames.get(attachment.url);
        const path = PathUtils.join(fp.file.path, filename);
        attachment.#savedBodies.delete(path);
        if (await IOUtils.exists(path)) {
          const message = await lazy.l10n.formatValue(
            "attachment-file-exists",
            { filename }
          );
          if (!Services.prompt.confirm(browsingContext.window, null, message)) {
            // Skip if the user choose not to replace the existing.
            continue;
          }
        }
        await attachment.saveToFile(path);
      }
    } catch (e) {
      console.warn(`Saving attachments to ${fp.file.path} FAILED.`, e);
      Services.prompt.alert(
        browsingContext.window,
        title,
        await lazy.l10n.formatValue("attachment-save-failed")
      );
      return null;
    }
    browsingContext.window.dispatchEvent(
      new CustomEvent("attachmentsSaved", { detail: { path: fp.file.path } })
    );
    return fp.file.path;
  }

  /**
   * Fetch the attachment.
   *
   * @returns {Promise<ArrayBuffer>} Decoded bytes after successful retrieval.
   * @throws {nsIException} The retrieval error, or NOT_AVAILABLE for a stale selection.
   */
  async fetchAttachment() {
    this.#validateSelection();
    let url = this.url;
    if (!this.isAllowedURL) {
      throw new Error(`URL not allowed: ${url}`);
    }
    if (
      this.contentType == "message/rfc822" ||
      /[?&]filename=.*\.eml(&|$)/.test(url)
    ) {
      url += url.includes("?") ? "&outputformat=raw" : "?outputformat=raw";
    }
    const body = await this.#prepareRemoteBody();
    if (
      this.#selection &&
      !this.isExternalAttachment &&
      this.#selection.folder instanceof Ci.nsIMsgImapMailFolder
    ) {
      const { uri, part } = this.#selection;
      if (!/^\d+(?:\.\d+)*$/.test(part)) {
        throw Components.Exception(
          "Invalid MIME part",
          Cr.NS_ERROR_NOT_AVAILABLE
        );
      }
      const service = MailServices.messageServiceFromURI(uri);
      const presentation = new URL(url).searchParams;
      const params = new URLSearchParams({ part });
      for (const field of ["type", "filename", "outputformat"]) {
        if (presentation.has(field)) {
          params.set(field, presentation.get(field));
        }
      }
      const chunks = [];
      let length = 0;
      const buffer = await new Promise((resolve, reject) => {
        const listener = {
          QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
          onStartRequest() {},
          onDataAvailable(request, stream, _offset, count) {
            try {
              const binary = Cc[
                "@mozilla.org/binaryinputstream;1"
              ].createInstance(Ci.nsIBinaryInputStream);
              binary.setInputStream(stream);
              chunks.push(Uint8Array.from(binary.readByteArray(count)));
              length += count;
            } catch (error) {
              reject(error);
              request.cancel(error.result || Cr.NS_ERROR_FAILURE);
            }
          },
          onStopRequest(request, status) {
            let failure = Components.isSuccessCode(status)
              ? null
              : Components.Exception(`Failed to fetch ${uri}`, status);
            try {
              AttachmentInfo.#closeCompletedRequest(request);
            } catch (error) {
              if (!failure) {
                failure = error;
              } else {
                console.error(error);
              }
            }
            if (failure) {
              chunks.length = 0;
              reject(failure);
              return;
            }
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.length;
            }
            resolve(bytes.buffer);
          },
        };
        service
          .QueryInterface(Ci.nsIMsgMessageFetchPartService)
          .fetchMimePart(
            service.getUrlForUri(uri),
            uri + "?" + params,
            listener,
            null,
            null
          );
      });
      this.#validateBodyIdentity(body);
      this.#fetchedBodies.set(buffer, { body });
      return buffer;
    }
    const sourceURI = Services.io.newURI(url);
    const buffer = await new Promise((resolve, reject) => {
      lazy.NetUtil.asyncFetch(
        {
          uri: sourceURI,
          loadUsingSystemPrincipal: true,
        },
        (inputStream, status, request) => {
          let buffer, completedBody, failure;
          try {
            if (!Components.isSuccessCode(status)) {
              throw new Components.Exception(`Failed to fetch ${url}`, status);
            }
            buffer = lazy.NetUtil.readInputStream(inputStream);
            this.#validateBodyIdentity(body);
            completedBody = body;
          } catch (error) {
            failure = error;
          } finally {
            try {
              inputStream.close();
            } catch (error) {
              if (!failure) {
                failure = error;
              } else {
                console.error(error);
              }
            }
          }
          try {
            AttachmentInfo.#closeCompletedRequest(request);
          } catch (error) {
            if (!failure) {
              failure = error;
            } else {
              console.error(error);
            }
          }
          if (failure) {
            reject(failure);
          } else {
            this.#fetchedBodies.set(buffer, { body: completedBody });
            resolve(buffer);
          }
        }
      );
    });
    this.#validateBodyIdentity(this.#fetchedBodies.get(buffer).body);
    return buffer;
  }

  /**
   * Save the attachment to a given file.
   *
   * @param {string} target - Path to save to.
   * @param {boolean} [isTmp=false] - Treat it as a temporary file.
   */
  async saveToFile(target, isTmp = false) {
    this.#validateSelection();
    const before = this.#bodyIdentity();
    this.#savedBodies.delete(target);
    const buffer = await this.fetchAttachment();
    const body = this.#fetchedBodies.get(buffer)?.body ?? before;
    this.#validateBodyIdentity(body);
    const blob = new Blob([new Uint8Array(buffer)], {
      type: "application/octet-stream",
    });
    const source = URL.createObjectURL(blob);

    // Create a download so that saved files show up under... Saved Files.
    try {
      const download = await lazy.Downloads.createDownload({
        source,
        target,
        startTime: new Date(),
      });
      let list;
      try {
        this.#validateBodyIdentity(body);
        await download.start();
        this.#validateBodyIdentity(body);
        if (!isTmp) {
          list = await lazy.Downloads.getList(lazy.Downloads.ALL);
          this.#validateBodyIdentity(body);
          await list.add(download);
        }
        this.#validateBodyIdentity(body);
        this.#savedBodies.set(target, { body });
      } catch (error) {
        const wroteTarget = download.succeeded;
        if (list) {
          await list.remove(download).catch(console.error);
        }
        await download.finalize(true).catch(console.error);
        if (wroteTarget) {
          await IOUtils.remove(target, {
            ignoreAbsent: true,
            retryReadonly: true,
          }).catch(console.error);
        }
        throw error;
      }
    } finally {
      URL.revokeObjectURL(source);
    }
  }

  /**
   * Create a temp file in an appropriate non-predictable temp folder.
   *
   * @param {string} filename - Preferred filename.
   * @returns {nsIFile} the created file.
   */
  async setupTempFile(filename) {
    const tmpPath = PathUtils.join(
      PathUtils.tempDir,
      "pid-" + Services.appinfo.processID
    );
    await IOUtils.makeDirectory(tmpPath, { permissions: 0o700 });
    const tempFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    tempFile.initWithPath(tmpPath);

    tempFile.append(filename);
    tempFile.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);

    Cc["@mozilla.org/uriloader/external-helper-app-service;1"]
      .getService(Ci.nsPIExternalAppLauncher)
      .deleteTemporaryFileOnExit(tempFile);
    return tempFile;
  }

  /**
   * Import this message/rfc822 attachment into a mail folder.
   * Fetches the raw data via fetchAttachment(), normalizes line endings to
   * CRLF, writes to a temp file, and imports via copyFileMessageAsync.
   *
   * @param {nsIMsgFolder} targetFolder - The folder to import into.
   */
  async importToFolder(targetFolder) {
    const buffer = await this.fetchAttachment();

    // Normalize line endings to CRLF. The raw fetch may return data with
    // native LF line endings. IMAP APPEND requires CRLF per RFC 5322 §2.1.
    const uint8 = new Uint8Array(buffer);
    const chunks = [];

    // Process in 8KB chunks to stay under the Function.apply argument limit
    for (let j = 0; j < uint8.length; j += 8192) {
      chunks.push(String.fromCharCode.apply(null, uint8.subarray(j, j + 8192)));
    }

    // Join once to prevent intermediate string garbage collection
    const rawStr = chunks.join("");
    const normalized = rawStr.replace(/\r\n?|\n/g, "\r\n");

    // Write to a temp file, then import into the target folder.
    const tempFile = await this.setupTempFile("imported-message.eml");
    try {
      await IOUtils.write(
        tempFile.path,
        lazy.MailStringUtils.byteStringToUint8Array(normalized)
      );

      await lazy.MailUtils.copyFileMessageAsync(tempFile, targetFolder, null);
    } finally {
      // Clean up the temp file even if the copy fails.
      await IOUtils.remove(tempFile.path);
    }
  }

  /**
   * Open this attachment.
   *
   * @param {BrowsingContext} browsingContext - The browsingContext of the
   *   browser that this attachment is being opened from.
   */
  async open(browsingContext) {
    this.#validateSelection();
    if (!this.hasFile) {
      return;
    }

    const win = browsingContext.topChromeWindow;
    const empty = await this.isEmpty();
    if (empty) {
      const prompt = await lazy.l10n.formatValue(
        this.isExternalAttachment
          ? "attachment-external-not-found"
          : "attachment-empty"
      );
      Services.prompt.alert(win, null, prompt);
      return;
    }

    // @see MsgComposeCommands.js which has simililar opening functionality
    const dotPos = this.name.lastIndexOf(".");
    const extension =
      dotPos >= 0 ? this.name.substring(dotPos + 1).toLowerCase() : "";
    if (this.contentType == "application/pdf" || extension == "pdf") {
      const handlerInfo = lazy.gMIMEService.getFromTypeAndExtension(
        this.contentType,
        extension
      );
      // Only open a new tab for pdfs if we are handling them internally.
      if (
        !handlerInfo.alwaysAskBeforeHandling &&
        handlerInfo.preferredAction == Ci.nsIHandlerInfo.handleInternally
      ) {
        // Add the content type to avoid a "how do you want to open this?"
        // dialog. For most attachments the MIME code has already put it in the
        // URL, but not for external attachments.
        let url = this.url;
        const parsedURL = URL.parse(url);
        if (parsedURL && !parsedURL.searchParams.has("type")) {
          parsedURL.searchParams.set("type", "application/pdf");
          url = parsedURL.href;
        }
        let tabmail = win.document.getElementById("tabmail");
        if (!tabmail) {
          // If no tabmail available in this window, try and find it in
          // another.
          const win2 = Services.wm.getMostRecentWindow("mail:3pane");
          tabmail = win2?.document.getElementById("tabmail");
        }
        if (tabmail) {
          // Fetch through the same checked part reader before handing bytes to
          // the PDF viewer. A transport URL alone does not retain an IMAP key.
          if (this.#selection && !this.isExternalAttachment) {
            const body = this.#bodyIdentity();
            const tempFile = await this.setupTempFile(this.#filename);
            try {
              await this.saveToFile(tempFile.path, true);
              await IOUtils.setPermissions(tempFile.path, 0o400);
              this.#validateBodyIdentity(
                this.#savedBodies.get(tempFile.path)?.body ?? body
              );
              url =
                Services.io.newFileURI(tempFile).spec + "?type=application/pdf";
            } catch (error) {
              await IOUtils.remove(tempFile.path, {
                ignoreAbsent: true,
                retryReadonly: true,
              }).catch(console.error);
              throw error;
            }
          }
          this.#validateSelection();
          tabmail.openTab("contentTab", {
            url,
            background: false,
            linkHandler: "single-page",
          });
          tabmail.documentGlobal.focus();
          return;
        }
        // If no tabmail, open PDF same as other attachments.
      }
    }

    if (this.contentType == "message/rfc822") {
      const body = this.#bodyIdentity();
      let cached = this.#temporaryFiles.get(this.url);
      let staleFile;
      if (cached && cached.body !== body) {
        this.#temporaryFiles.delete(this.url);
        staleFile = cached.file;
        cached = null;
      }
      let tempFile = cached?.file;
      if (!tempFile?.exists()) {
        // Try to use the name of the attachment for the temporary file, so
        // that the name is included in the URI of the message that is
        // opened, and possibly saved as a file later by the user.
        let sanitizedName = lazy.DownloadPaths.sanitize(this.name);
        if (!sanitizedName) {
          sanitizedName = "message.eml";
        } else if (!/\.eml$/i.test(sanitizedName)) {
          sanitizedName += ".eml";
        }
        tempFile = await this.setupTempFile(sanitizedName);
        if (staleFile) {
          await IOUtils.remove(staleFile.path, {
            ignoreAbsent: true,
            retryReadonly: true,
          }).catch(console.error);
        }
        try {
          await this.saveToFile(tempFile.path, true);
        } catch (error) {
          await IOUtils.remove(tempFile.path, {
            ignoreAbsent: true,
            retryReadonly: true,
          }).catch(console.error);
          throw error;
        }

        try {
          const savedBody = this.#savedBodies.get(tempFile.path)?.body ?? body;
          this.#validateBodyIdentity(savedBody);
          this.#temporaryFiles.set(this.url, {
            file: tempFile,
            body: savedBody,
          });
        } catch (error) {
          await IOUtils.remove(tempFile.path, {
            ignoreAbsent: true,
            retryReadonly: true,
          }).catch(console.error);
          throw error;
        }
      }

      this.#validateBodyIdentity(this.#temporaryFiles.get(this.url).body);
      lazy.MailUtils.openEMLFile(
        win,
        tempFile,
        Services.io.newFileURI(tempFile)
      );
      return;
    }

    // Get the MIME info from the service.
    let mimeInfo;
    try {
      mimeInfo = lazy.gMIMEService.getFromTypeAndExtension(
        this.contentType,
        extension
      );
    } catch (ex) {
      // If the call above fails, which can happen on Windows where there's
      // nothing registered for the file type, assume this generic type.
      mimeInfo = lazy.gMIMEService.getFromTypeAndExtension(
        "application/octet-stream",
        ""
      );
    }
    // The default action is saveToDisk, which is not what we want.
    // If we don't have a stored handler, ask before handling.
    if (!lazy.gHandlerService.exists(mimeInfo)) {
      mimeInfo.alwaysAskBeforeHandling = true;
      mimeInfo.preferredAction = Ci.nsIHandlerInfo.alwaysAsk;
    }

    // If we know what to do, do it.

    const name = lazy.DownloadPaths.sanitize(this.name);

    const createTemporaryFileAndOpen = async fileMimeInfo => {
      const body = this.#bodyIdentity();
      const tempFile = await this.setupTempFile(name);

      try {
        await this.saveToFile(tempFile.path, true);
        // Before opening from the temp dir, make the file read-only so that
        // users don't edit and lose their edits...
        await IOUtils.setPermissions(tempFile.path, 0o400); // Set read-only
        this.#validateBodyIdentity(
          this.#savedBodies.get(tempFile.path)?.body ?? body
        );
        this._openFile(fileMimeInfo, tempFile);
      } catch (error) {
        await IOUtils.remove(tempFile.path, {
          ignoreAbsent: true,
          retryReadonly: true,
        }).catch(console.error);
        throw error;
      }
    };

    const openLocalFile = fileMimeInfo => {
      this.#validateSelection();
      const fileHandler = Services.io
        .getProtocolHandler("file")
        .QueryInterface(Ci.nsIFileProtocolHandler);

      try {
        const externalFile = fileHandler.getFileFromURLSpec(this.displayUrl);
        this._openFile(fileMimeInfo, externalFile);
      } catch (ex) {
        console.error(
          `Open file for ${this.displayUrl} FAILED; ${ex.message}`,
          ex
        );
      }
    };

    if (!mimeInfo.alwaysAskBeforeHandling) {
      switch (mimeInfo.preferredAction) {
        case Ci.nsIHandlerInfo.saveToDisk:
          if (Services.prefs.getBoolPref("browser.download.useDownloadDir")) {
            const destFile = new lazy.FileUtils.File(
              await lazy.Downloads.getPreferredDownloadsDirectory()
            );
            destFile.append(name);
            destFile.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o755);
            destFile.remove(false);
            await this.saveToFile(destFile.path);
          } else {
            const filePicker = Cc["@mozilla.org/filepicker;1"].createInstance(
              Ci.nsIFilePicker
            );
            filePicker.defaultString = this.name;
            filePicker.defaultExtension = extension;
            filePicker.init(
              win.browsingContext,
              await lazy.l10n.formatValue("attachment-save-dialog-title"),
              Ci.nsIFilePicker.modeSave
            );
            const rv = await new Promise(resolve => filePicker.open(resolve));
            if (rv != Ci.nsIFilePicker.returnCancel) {
              await this.saveToFile(filePicker.file.path);
            }
          }
          return;
        case Ci.nsIHandlerInfo.useHelperApp:
        case Ci.nsIHandlerInfo.useSystemDefault:
          // Attachments can be detached and, if this is the case, opened from
          // their location on disk instead of copied to a temporary file.
          if (this.isExternalAttachment) {
            openLocalFile(mimeInfo);
            return;
          }

          await createTemporaryFileAndOpen(mimeInfo);
          return;
      }
    }

    // Ask what to do, then do it.
    const appLauncherDialog = Cc[
      "@mozilla.org/helperapplauncherdialog;1"
    ].createInstance(Ci.nsIHelperAppLauncherDialog);

    const attachment = this;
    appLauncherDialog.show(
      {
        QueryInterface: ChromeUtils.generateQI(["nsIHelperAppLauncher"]),
        MIMEInfo: mimeInfo,
        source: Services.io.newURI(this.url),
        suggestedFileName: this.name,
        cancel() {},
        promptForSaveDestination() {
          appLauncherDialog.promptForSaveToFileAsync(
            this,
            win,
            this.suggestedFileName,
            "." + extension, // Dot stripped by promptForSaveToFileAsync.
            false
          );
        },
        launchLocalFile() {
          openLocalFile(mimeInfo);
        },
        async setDownloadToLaunch() {
          await createTemporaryFileAndOpen(mimeInfo);
        },
        /** @param {nsIFile} file */
        async saveDestinationAvailable(file) {
          if (file) {
            await attachment.saveToFile(file.path);
          }
        },
        setWebProgressListener() {},
        targetFile: null,
        targetFileIsExecutable: null,
        timeDownloadStarted: null,
        contentLength: this.size,
        browsingContextId: browsingContext.id,
      },
      win,
      null
    );
  }

  /**
   * Unless overridden by a test, opens a saved attachment when called by `open`.
   *
   * @param {nsIMIMEInfo} mimeInfo
   * @param {nsIFile} file
   */
  _openFile(mimeInfo, file) {
    mimeInfo.launchWithFile(file);
  }

  /**
   * Delete this attachment from the message. Deleting removes the attachment
   * from the message, leavning only a placeholder noting that the message used
   * to contain an attachment.
   */
  async deleteFromMessage() {
    return AttachmentInfo.deleteAttachments(this.message, [this], false);
  }

  /**
   * Delete attachments from the message. Deleting removes an attachment
   * from the message, leavning only a placeholder noting that the message used
   * to contain an attachment.
   *
   * @param {nsIMsgDBHdr} msgHdr - The message holding the attachments.
   * @param {AttachmentInfo[]} attachments - Attachments to detach.
   * @param {boolean} [silent=true] - If true, ask for confirmation to proceed.
   */
  static async deleteAttachments(msgHdr, attachments, silent = true) {
    for (const attachment of attachments) {
      attachment.#validateSelection(msgHdr);
    }
    if (attachments.some(a => a.contentType == "text/x-moz-deleted")) {
      throw new Error(`An attachment was already deleted.`);
    }
    if (!silent) {
      // Confirm to proceed.
      const message = await lazy.l10n.formatValue("attachment-delete-confirm", {
        attachments: attachments.map(a => a.name).join("\n"),
      });
      if (!Services.prompt.confirm(null, null, message)) {
        return;
      }
    }
    for (const attachment of attachments) {
      attachment.#validateSelection(msgHdr);
    }
    const attachmentsMap = new Map(attachments.map(a => [a.url, null]));
    await AttachmentInfo.#modifyMessage(
      msgHdr,
      attachmentsMap,
      "DELETE",
      attachments
    );
  }

  /**
   * Detach this attachment from the message. Detaching removes the attachment
   * from the message, but leaves a link to file system location where the
   * attachment can be found.
   *
   * @param {BrowsingContext} browsingContext - The browsing context to use.
   */
  async detachFromMessage(browsingContext) {
    this.#validateSelection();
    AttachmentInfo.#validateModificationPermissions(
      this.message.folder,
      "DETACH"
    );
    if (this.contentType == "text/x-moz-deleted") {
      throw new Error(`${this.name} was already deleted.`);
    }
    // Ask where to save.
    const fpDialogTitle = await lazy.l10n.formatValue(
      "attachment-detach-dialog-title"
    );
    const path = await this.save(browsingContext, fpDialogTitle);
    if (!path) {
      return;
    }
    const body = this.#savedBodies.get(path)?.body ?? this.#bodyIdentity();
    // Confirm to proceed.
    const message = await lazy.l10n.formatValue("attachment-detach-confirm", {
      attachments: this.name,
    });
    if (!Services.prompt.confirm(browsingContext.window, null, message)) {
      return;
    }
    this.#validateSelection();
    await AttachmentInfo.#modifyMessage(
      this.message,
      new Map([[this.url, path]]),
      "DETACH",
      [this],
      [body]
    );
  }

  /**
   * Detach attachments from the message. Detaching removes an attachment
   * from the message, but leaves a link to file system location where the
   * attachment can be found.
   *
   * @param {nsIMsgDBHdr} msgHdr - The message holding the attachments.
   * @param {AttachmentInfo[]} attachments - Attachments to detach.
   * @param {string} [detachDir] - Base directory to use for detach.
   * @param {BrowsingContext} [browsingContext] - The browsing context to use.
   *   Must be set if detachDir is not set.
   */
  static async detachAttachments(
    msgHdr,
    attachments,
    detachDir = null,
    browsingContext = null
  ) {
    for (const attachment of attachments) {
      attachment.#validateSelection(msgHdr);
    }
    AttachmentInfo.#validateModificationPermissions(msgHdr.folder, "DETACH");
    if (attachments.some(a => a.contentType == "text/x-moz-deleted")) {
      throw new Error(`An attachment was already deleted.`);
    }
    const before = attachments.map(attachment => attachment.#bodyIdentity());
    const silent = !!detachDir;
    if (!silent) {
      // Non-silent mode. No dir provided - need to ask for dir where to save.
      const fpDialogTitle = await lazy.l10n.formatValue(
        "attachment-detach-all-dialog-title"
      );
      detachDir = await AttachmentInfo.saveAttachments(
        attachments,
        browsingContext,
        fpDialogTitle
      );
      if (!detachDir) {
        return;
      }
    }
    const filenames = AttachmentInfo.#uniqueFilenames(attachments);
    const attachmentsMap = new Map(
      attachments.map(a => [
        a.url,
        PathUtils.join(detachDir, filenames.get(a.url)),
      ])
    );
    if (silent) {
      for (const attachment of attachments) {
        await attachment.saveToFile(attachmentsMap.get(attachment.url));
      }
    } else {
      // Non-silent mode. Confirm before delete.
      const message = await lazy.l10n.formatValue("attachment-detach-confirm", {
        attachments: attachments.map(a => a.name).join("\n"),
      });
      if (!Services.prompt.confirm(null, null, message)) {
        return;
      }
    }
    for (const attachment of attachments) {
      attachment.#validateSelection(msgHdr);
    }
    await AttachmentInfo.#modifyMessage(
      msgHdr,
      attachmentsMap,
      "DETACH",
      attachments,
      attachments.map(
        (attachment, index) =>
          attachment.#savedBodies.get(attachmentsMap.get(attachment.url))
            ?.body ?? before[index]
      )
    );
  }

  /**
   * Enforces the existing deletion and replacement-filing permissions before
   * any modifying command prepares bytes, and again at its actual handoffs.
   *
   * @param {nsIMsgFolder} folder - Actual selected parent folder.
   * @param {"DELETE"|"DETACH"} operation - Existing modifying command.
   */
  static #validateModificationPermissions(folder, operation) {
    if (!folder.canDeleteMessages) {
      throw new Error(
        `${operation} FAILED. Cannot delete messages in ${folder.URI}`
      );
    }
    if (!folder.canFileMessages) {
      throw new Error(
        `${operation} FAILED. Cannot file messages in ${folder.URI}`
      );
    }
  }

  /**
   * Modify the the provided message by deleting/detaching attachments.
   * This is a high level back-end call. Callers need to have set up all the
   *  needed information beforehand.
   *
   * @param {nsIMsgDBHdr} msgHdr - The message holding the attachments.
   * @param {Map<string,string>} attachmentsMap - Map of attachmentURL to
   *   full path were each attachment has been stored.
   *   For deletion, paths will be null.
   * @param {"DELETE"|"DETACH"} operation - Delete or detach.
   * @param {AttachmentInfo[]} attachments - Retained physical selections.
   * @param {?Array<?string>} [bodies=null] - Saved-byte identities, or current bodies for deletion.
   */
  static async #modifyMessage(
    msgHdr,
    attachmentsMap,
    operation,
    attachments,
    bodies = null
  ) {
    const folder = msgHdr.folder;
    AttachmentInfo.#validateModificationPermissions(folder, operation);
    bodies ??= attachments.map(attachment => attachment.#bodyIdentity());
    for (const [index, attachment] of attachments.entries()) {
      attachment.#validateSelection(msgHdr);
      attachment.#validateBodyIdentity(bodies[index]);
    }
    // The initial full-parent stream may publish its own offline body. Prove
    // that publication against all streamed parent bytes before stripping, so
    // saved parts keep their parent binding without trusting a mutable token.
    if (attachments.length) {
      const prepared = await attachments[0].#prepareRemoteBody();
      bodies = bodies.map(() => prepared);
    }
    for (const [index, attachment] of attachments.entries()) {
      attachment.#validateBodyIdentity(bodies[index]);
    }
    const data = await AttachmentInfo.stripAttachments(
      msgHdr,
      attachmentsMap,
      operation
    );
    if (!data) {
      return;
    }

    for (const [index, attachment] of attachments.entries()) {
      attachment.#validateSelection(msgHdr);
      attachment.#validateBodyIdentity(bodies[index]);
    }
    AttachmentInfo.#validateModificationPermissions(folder, operation);
    await AttachmentInfo.#copyMessageToOriginalFolder(
      data,
      msgHdr,
      attachments,
      operation
    );
    // A completed copy remains published if this guard or deletion fails.
    // Preserve both rows rather than delete through a changed selection.
    for (const [index, attachment] of attachments.entries()) {
      attachment.#validateSelection(msgHdr);
      attachment.#validateBodyIdentity(bodies[index]);
    }
    AttachmentInfo.#validateModificationPermissions(folder, operation);
    await AttachmentInfo.#deleteOriginal(msgHdr);
    await AttachmentInfo.#updateFolder(folder);
  }

  /**
   * Strip attachment(s) from a message. This function performs the low level
   * stripping by streaming the message through libmime, with appropriate
   * filter parameters set.
   * The resulting output is a the MIME data of the modified message.
   *
   * @param {nsIMsgDBHdr} msgHdr - The message holding the attachments.
   * @param {Map<string,string>} attachmentsMap - Map of attachmentURL to
   *   path were the attachment has been stored.
   *   For deletion, path will be undefined.
   * @param {"DELETE"|"DETACH"} operation - Delete or detach.
   * @returns {string} returns the data of the modified message.
   */
  static async stripAttachments(msgHdr, attachmentsMap, operation) {
    AttachmentInfo.#validateModificationPermissions(msgHdr.folder, operation);

    // We'll remove any subparts which will be removed automatically by the
    // removal of the parent.
    //
    // E.g. the attachment list processing (showing only part ids)
    // before: 1.11, 1.3, 1.2, 1.2.1.3, 1.4.1.2
    // after:  1.2, 1.3, 1.4.1.2, 1.11
    const topLevelUrls = new Set(
      Array.from(attachmentsMap.entries())
        .map(([url, value]) => ({
          url,
          value,
          part: new URL(url).searchParams.get("part"),
        }))
        .filter(entry => entry.part)
        .filter(
          (entry, _, arr) =>
            !arr.some(
              other =>
                other !== entry && entry.part.startsWith(other.part + ".")
            )
        )
        .map(entry => entry.url)
    );

    for (const url of attachmentsMap.keys()) {
      if (!topLevelUrls.has(url)) {
        attachmentsMap.delete(url);
      }
    }

    const { promise, resolve, reject } = Promise.withResolvers();
    /** @implements {nsIStreamListener} */
    const streamListener = {
      _data: [],
      _stream: null,
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
      onDataAvailable(_request, inputStream, _offset, count) {
        if (!this._stream) {
          this._stream = Cc[
            "@mozilla.org/scriptableinputstream;1"
          ].createInstance(Ci.nsIScriptableInputStream);
          this._stream.init(inputStream);
        }
        this._data.push(this._stream.read(count));
      },
      onStartRequest() {},
      onStopRequest(request, statusCode) {
        let failure = Components.isSuccessCode(statusCode)
          ? null
          : Components.Exception(
              `${operation} - strip FAILED: ${statusCode.toString(16)}`,
              statusCode
            );
        let data;
        try {
          if (!failure) {
            data = this._data.join("").replace(/\r\n?|\n/g, "\r\n");
          }
        } catch (error) {
          failure = error;
        }
        try {
          this._stream?.close();
        } catch (error) {
          if (!failure) {
            failure = error;
          } else {
            console.error(error);
          }
        }
        this._stream = null;
        this._data = [];
        try {
          AttachmentInfo.#closeCompletedRequest(request);
        } catch (error) {
          if (!failure) {
            failure = error;
          } else {
            console.error(error);
          }
        }
        if (failure) {
          reject(failure);
        } else {
          resolve(data);
        }
      },
    };

    const params = new URLSearchParams();
    for (const url of attachmentsMap.keys()) {
      params.append("del", new URL(url).searchParams.get("part"));
      if (operation == "DETACH") {
        const path = attachmentsMap.get(url);
        params.append("detachTo", PathUtils.toFileURI(path));
      }
    }

    const msgURI = msgHdr.folder.getUriForMsg(msgHdr);
    try {
      MailServices.messageServiceFromURI(msgURI).streamMessage(
        msgURI,
        streamListener,
        null, // aMsgWindow
        null, // aUrlListener
        true, // aConvertData
        "attach&" + params.toString(), // aAdditionalHeader
        false // aLocalOnly
      );
    } catch (error) {
      reject(error);
    }
    return promise;
  }

  /**
   * Make a copy of the modified message in its original folder.
   *
   * @param {string} data - The modified message data.
   * @param {nsIMsgDBHdr} msgHdr - The message to replace.
   * @param {AttachmentInfo[]} attachments - Selections to check before copying.
   * @param {"DELETE"|"DETACH"} operation - Existing modifying command.
   */
  static async #copyMessageToOriginalFolder(
    data,
    msgHdr,
    attachments,
    operation
  ) {
    const msgFilePath = await IOUtils.createUniqueFile(
      PathUtils.tempDir,
      "tmp-msg.eml",
      0o600
    );
    let failure;
    try {
      await IOUtils.write(
        msgFilePath,
        lazy.MailStringUtils.byteStringToUint8Array(data)
      );
      const msgFile = await IOUtils.getFile(msgFilePath);

      const { promise, resolve, reject } = Promise.withResolvers();
      /** @implements {nsIMsgCopyServiceListener} */
      const copyServiceListener = {
        onStartCopy() {},
        onProgress() {},
        setMessageKey(key) {
          Services.obs.notifyObservers(
            null,
            "attachment-delete-msgkey-changed",
            JSON.stringify({
              oldMessageKey: msgHdr.messageKey,
              newMessageKey: key,
              folderURI: msgHdr.folder.URI,
            })
          );
        },
        getMessageId() {
          return null;
        },
        onStopCopy(statusCode) {
          if (!Components.isSuccessCode(statusCode)) {
            reject(
              Components.Exception(
                `Copy FAILED: ${statusCode.toString(16)}`,
                statusCode
              )
            );
            return;
          }
          resolve();
        },
      };

      for (const attachment of attachments) {
        attachment.#validateSelection(msgHdr);
      }
      AttachmentInfo.#validateModificationPermissions(msgHdr.folder, operation);
      try {
        MailServices.copy.copyFileMessage(
          msgFile,
          msgHdr.folder,
          msgHdr,
          false,
          msgHdr.flags,
          msgHdr.getStringProperty("keywords"),
          copyServiceListener,
          null
        );
      } catch (error) {
        reject(error);
      }
      await promise;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const cleanup = IOUtils.remove(msgFilePath);
      if (failure) {
        await cleanup.catch(console.error);
      } else {
        await cleanup;
      }
    }
  }

  /**
   * Delete original message (for message that got modified.)
   *
   * @param {nsIMsgDBHdr} msgHdr - The message to delete.
   */
  static async #deleteOriginal(msgHdr) {
    const { promise, resolve, reject } = Promise.withResolvers();
    /** @implements {nsIMsgCopyServiceListener} */
    const copyServiceListener = {
      onStartCopy() {},
      onProgress() {},
      setMessageKey() {},
      getMessageId() {
        return null;
      },
      onStopCopy(statusCode) {
        if (!Components.isSuccessCode(statusCode)) {
          reject(
            Components.Exception(
              `Delete original FAILED: ${statusCode.toString(16)}`,
              statusCode
            )
          );
          return;
        }
        resolve();
      },
    };
    msgHdr.setUint32Property("attachmentDetached", 1);
    try {
      msgHdr.folder.deleteMessages(
        [msgHdr],
        null,
        true,
        false,
        copyServiceListener,
        false
      );
    } catch (error) {
      reject(error);
    }
    await promise;
  }

  /**
   * Update the imap folder for recent changes.
   *
   * @param {nsIMsgFolder} folder - Folder to update.
   */
  static async #updateFolder(folder) {
    if (!(folder instanceof Ci.nsIMsgImapMailFolder)) {
      return;
    }
    const { promise, resolve, reject } = Promise.withResolvers();
    /**  @implements {nsIUrlListener} */
    const urlListener = {
      OnStartRunningUrl() {},
      OnStopRunningUrl(url, statusCode) {
        if (!Components.isSuccessCode(statusCode)) {
          reject(
            Components.Exception(
              `Update folder FAILED: ${statusCode}`,
              statusCode
            )
          );
          return;
        }
        resolve();
      },
    };
    try {
      folder.updateFolderWithListener(null, urlListener);
    } catch (error) {
      reject(error);
    }
    await promise;
  }

  /**
   * This method checks whether the attachment has been deleted or not.
   *
   * @returns {boolean} true if the attachment has been deleted, false otherwise.
   */
  get isDeleted() {
    return this.contentType == "text/x-moz-deleted";
  }

  /**
   * This method checks whether the attachment is a detached file.
   *
   * @returns {boolean} true if the attachment is a detached file, false otherwise.
   */
  get isFileAttachment() {
    return this.isExternalAttachment && /^file:\/\/\//.test(this.url);
  }

  /**
   * This method checks whether the attachment is an http link.
   *
   * @returns {boolean} true if the attachment is an http link, false otherwise.
   */
  get isLinkAttachment() {
    return this.isExternalAttachment && /^https?:/.test(this.url);
  }

  /**
   * This method checks whether the attachment has an associated file or not.
   * Deleted attachments or detached attachments with missing external files
   * do *not* have a file.
   *
   * @returns {boolean} true if the attachment has an associated file, false otherwise.
   */
  get hasFile() {
    if (this.sizeResolved && this.size == -1) {
      return false;
    }
    if (!this.isAllowedURL) {
      return false;
    }

    return true;
  }

  /**
   * Return display url, decoded and converted to utf8 from IDN punycode ascii,
   * if the attachment is external (http or file schemes).
   *
   * @returns {string} url.
   */
  get displayUrl() {
    if (this.isExternalAttachment) {
      // For status bar url display purposes, we want the displaySpec.
      // The ?part= has already been removed.
      return decodeURI(Services.io.newURI(this.url).displaySpec);
    }

    return this.url;
  }

  /**
   * @returns {boolean} true if this attachment is allowed to be loaded.
   */
  get isAllowedURL() {
    if (!URL.canParse(this.url)) {
      return false;
    }

    // const u = new URL(this.url);
    // if (u.protocol == "file:" && u.hostname) {
    //   // Bug 1507354 will make this work, and would be a better way of
    //   // handling the below.
    //  return false;
    // }

    if (/^file:\/\/\/[^A-Za-z]/i.test(this.url)) {
      // Looks like a non-local (remote UNC) file URL. Don't allow that
      // unless it's been explicitel allowed for that hostname.
      const allow = Services.prefs
        .getStringPref("mail.allowed_attachment_hostnames", "")
        .split(",")
        .filter(Boolean)
        .some(h =>
          new RegExp(`^file:\/+${RegExp.escape(h)}/`, "i").test(this.url)
        );
      if (!allow) {
        console.warn(
          `Attachment blocked for UNC path ${this.url}. To unblock, add the hostname to mail.allowed_attachment_hostnames`
        );
        return false;
      }
      return true;
    }

    if (this.message && this.message.flags & Ci.nsMsgMessageFlags.FeedMsg) {
      // Feed enclosures allow only http.
      return /^https?:/i.test(this.url);
    }

    // Don't allow http for other cases.
    return /^(file|data|mailbox|imap|s?news|x-moz-ews|x-moz-graph):/i.test(
      this.url
    );
  }

  /**
   * This method checks whether the attachment url location exists and
   * is accessible. For http and file urls, fetch() will have the size
   * in the content-length header.
   *
   * @returns {boolean} true if the attachment is empty or error.
   */
  async isEmpty() {
    this.#validateSelection();
    if (this.isDeleted) {
      return true;
    }

    if (!this.isAllowedURL) {
      return true;
    }

    const isFetchable = url => {
      const uri = Services.io.newURI(url);
      return !(uri.username || uri.userPass);
    };

    // We have a resolved size.
    if (this.sizeResolved) {
      return this.size < 1;
    }

    if (this.#selection && !this.isExternalAttachment) {
      const buffer = await this.fetchAttachment();
      this.size = buffer.byteLength;
      this.sizeResolved = true;
      return this.size == 0;
    }

    if (!isFetchable(this.url)) {
      return false;
    }

    let empty = true;
    let size = -1;
    const options = { method: "GET" };

    const request = new Request(this.url, options);

    if (this.isExternalAttachment && this.#updateAttachmentsDisplayFn) {
      this.#updateAttachmentsDisplayFn(this, true);
    }

    await fetch(request)
      .then(response => {
        if (!response.ok) {
          console.warn(
            "AttachmentInfo.#: fetch response error - " +
              response.statusText +
              ", response.url - " +
              response.url
          );
          return null;
        }

        if (this.isLinkAttachment) {
          if (response.status < 200 || response.status > 304) {
            console.warn(
              "AttachmentInfo.#: link fetch response status - " +
                response.status +
                ", response.url - " +
                response.url
            );
            return null;
          }
        }

        return response;
      })
      .then(async response => {
        if (this.isExternalAttachment) {
          size = response ? response.headers.get("content-length") : -1;
        } else {
          // Check the attachment again if addAttachmentField() sets a
          // libmime -1 return value for size in this object.
          // Note: just test for a non zero size, don't need to drain the
          // stream. We only get here if the url is fetchable.
          // The size for internal attachments is not calculated here but
          // will come from libmime.
          const reader = response.body.getReader();
          const result = await reader.read();
          reader.cancel();
          size = result && result.value ? result.value.length : -1;
        }

        if (size > 0) {
          empty = false;
        }
      })
      .catch(error => {
        console.warn(`AttachmentInfo.#: ${error.message} url - ${this.url}`);
      });

    this.sizeResolved = true;

    if (this.isExternalAttachment) {
      // For link attachments, we may have had a published value or -1
      // indicating unknown value. We now know the real size, so set it and
      // update the ui. For detached file attachments, get the size here
      // instead of the old xpcom way.
      this.size = size;
      this.#updateAttachmentsDisplayFn?.(this, false);
    }

    return empty;
  }

  /**
   * Open a file attachment's containing folder.
   */
  openFolder() {
    if (!this.isFileAttachment || !this.hasFile) {
      return;
    }

    // The file url is stored in the attachment info part with unix path and
    // needs to be converted to os path for nsIFile.
    const fileHandler = Services.io
      .getProtocolHandler("file")
      .QueryInterface(Ci.nsIFileProtocolHandler);
    try {
      fileHandler.getFileFromURLSpec(this.displayUrl).reveal();
    } catch (ex) {
      console.error(
        `Open folder for ${this.displayUrl} FAILED; ${ex.message}`,
        ex
      );
    }
  }
}
