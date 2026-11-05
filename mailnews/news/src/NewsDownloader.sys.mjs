/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { NntpUtils } from "resource:///modules/NntpUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () => new Localization(["messenger/news.ftl"])
);
ChromeUtils.defineLazyGetter(lazy, "messengerBundle", () =>
  Services.strings.createBundle(
    "chrome://messenger/locale/messenger.properties"
  )
);

/**
 * Download articles in subscribed newsgroups for offline use.
 */
export class NewsDownloader {
  _logger = NntpUtils.logger;

  /**
   * @param {nsIMsgWindow} msgWindow - The associated msg window.
   * @param {nsIUrlListener} [urlListener=null] - Optional callback for the
   *   request.
   */
  constructor(msgWindow, urlListener) {
    this._msgWindow = msgWindow;
    this._urlListener = urlListener;
  }

  /**
   * Downloads matching articles in all groups configured for offline use.
   * The optional batch listener receives the first error after all started
   * servers settle; each failed server stops before its next folder.
   *
   * @returns {Promise<void>} Resolves after successful downloads, or rejects
   *   with the original selection, body, provider or callback error.
   */
  async downloadAllOfflineNewsgroups() {
    this._logger.debug("Start downloading articles for offline use");
    let failure = null;
    try {
      this._urlListener?.OnStartRunningUrl(null);
      const servers = MailServices.accounts.allServers.filter(
        x => x.type == "nntp"
      );
      // Keep existing server concurrency, but settle every started server before
      // reporting the first actual failure to the batch listener.
      await Promise.all(
        servers.map(async server => {
          try {
            for (const folder of server.rootFolder.descendants) {
              if (folder.flags & Ci.nsMsgFolderFlags.Offline) {
                await this._downloadArticles(folder);
              }
            }
          } catch (error) {
            failure ??= error;
          }
        })
      );
    } catch (error) {
      failure ??= error;
    }
    try {
      this._urlListener?.OnStopRunningUrl(
        null,
        failure?.result ?? (failure ? Cr.NS_ERROR_FAILURE : Cr.NS_OK)
      );
    } catch (error) {
      failure ??= error;
    }
    this._clearStatus();
    if (failure) {
      throw failure;
    }
    this._logger.debug("Finished downloading articles for offline use");
  }

  /**
   * Download all matching articles in a single newsgroup.
   *
   * @param {nsIMsgFolder} folder - The newsgroup folder.
   * @returns {Promise<void>} Resolves on success or rejects with the original
   *   selection/body error, after restoring the offline mode.
   */
  async downloadFolder(folder) {
    this._logger.debug(
      "Start downloading articles for offline use in single folder."
    );

    try {
      await this._downloadArticles(folder);
      this._logger.debug(
        "Finished downloading articles for offline use in single folder."
      );
    } finally {
      this._clearStatus();
    }
  }

  /**
   * Download specific articles in a single newsgroup.
   *
   * @param {nsIMsgFolder} folder - The newsgroup folder.
   * @param {nsMsgKey[]} keys - The physical keys of messages to download.
   * @returns {Promise<void>} Resolves on success or rejects with the original
   *   download error, after restoring the offline mode.
   */
  async downloadMessages(folder, keys) {
    this._logger.debug("Start downloading specific articles for offline use");

    try {
      await this._downloadArticles(folder, keys);
      this._logger.debug(
        "Finished downloading specific articles for offline use"
      );
    } finally {
      this._clearStatus();
    }
  }

  /**
   * Download articles in a newsgroup one by one.
   *
   * @param {nsIMsgFolder} folder - The newsgroup folder.
   * @param {nsMsgKey[]} [keys=null] - If set, the keys of the messages to
   *   download, otherwise all messages matching the download settings for
   *   the folder are retrieved.
   */
  async _downloadArticles(folder, keys = null) {
    this._logger.debug(`Start downloading ${folder.URI}`);

    folder.QueryInterface(Ci.nsIMsgNewsFolder);
    const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
    const previousSaveOffline = folder.saveArticleOffline;
    if (native && previousSaveOffline) {
      throw Components.Exception(
        "News download already active",
        Cr.NS_MSG_FOLDER_BUSY
      );
    }
    folder.saveArticleOffline = true;
    try {
      keys ??= [...(await this._getKeysToDownload(folder))];
      if (!keys.length) {
        await this._updateStatus(folder, "no-articles-to-download", {
          newsgroup: folder.localizedName,
        });
        return;
      }

      await this._updateStatus(folder, "downloading-articles-for-offline", {
        count: keys.length,
        newsgroup: folder.localizedName,
      });

      for (const key of keys) {
        await new Promise((resolve, reject) => {
          MailServices.nntp.fetchMessage(folder, key, this._msgWindow, null, {
            OnStartRunningUrl() {},
            OnStopRunningUrl(uri, status) {
              if (Components.isSuccessCode(status)) {
                resolve();
              } else {
                reject(
                  Components.Exception("Offline news download failed", status)
                );
              }
            },
          });
        });
      }
      folder.refreshSizeOnDisk();
    } finally {
      folder.saveArticleOffline = previousSaveOffline;
    }

    this._logger.debug(`Finished downloading ${folder.URI}`);
  }

  /**
   * Use a search session to find messages that match the download settings,
   * excluding those already available offline or belonging to ignored
   * (sub-)threads.
   *
   * @param {nsIMsgFolder} folder - The newsgroup folder.
   * @returns {Promise<Set<number>>} The selected physical message keys.
   */
  async _getKeysToDownload(folder) {
    const searchSession = Cc[
      "@mozilla.org/messenger/searchSession;1"
    ].createInstance(Ci.nsIMsgSearchSession);
    const termValue = searchSession.createTerm().value;

    const downloadSettings = folder.downloadSettings;
    if (downloadSettings.downloadUnreadOnly) {
      termValue.attrib = Ci.nsMsgSearchAttrib.MsgStatus;
      termValue.status = Ci.nsMsgMessageFlags.Read;
      searchSession.addSearchTerm(
        Ci.nsMsgSearchAttrib.MsgStatus,
        Ci.nsMsgSearchOp.Isnt,
        termValue,
        true,
        null
      );
    }
    if (downloadSettings.downloadByDate) {
      termValue.attrib = Ci.nsMsgSearchAttrib.AgeInDays;
      termValue.age = downloadSettings.ageLimitOfMsgsToDownload;
      searchSession.addSearchTerm(
        Ci.nsMsgSearchAttrib.AgeInDays,
        Ci.nsMsgSearchOp.IsLessThan,
        termValue,
        true,
        null
      );
    }
    termValue.attrib = Ci.nsMsgSearchAttrib.MsgStatus;
    termValue.status = Ci.nsMsgMessageFlags.Offline;
    searchSession.addSearchTerm(
      Ci.nsMsgSearchAttrib.MsgStatus,
      Ci.nsMsgSearchOp.Isnt,
      termValue,
      true,
      null
    );

    if (folder.server.limitOfflineMessageSize && folder.server.maxMessageSize) {
      termValue.attrib = Ci.nsMsgSearchAttrib.Size;
      termValue.size = folder.server.maxMessageSize;
      searchSession.addSearchTerm(
        Ci.nsMsgSearchAttrib.Size,
        Ci.nsMsgSearchOp.IsLessThan,
        termValue,
        true,
        null
      );
    }

    const keysToDownload = new Set();
    const msgDatabase = folder.msgDatabase;
    const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
    let selectionError = null;
    await new Promise((resolve, reject) => {
      searchSession.registerListener(
        {
          onSearchHit(hdr) {
            if (selectionError) {
              return;
            }
            try {
              if (native) {
                if (
                  folder.msgDatabase != msgDatabase ||
                  hdr.folder.id != folder.id
                ) {
                  throw Components.Exception(
                    "News selection owner changed",
                    Cr.NS_ERROR_NOT_AVAILABLE
                  );
                }
                folder.getMessageIdForKey(hdr.messageKey);
              }
              if (
                hdr.flags & Ci.nsMsgMessageFlags.Offline ||
                hdr.isKilled ||
                msgDatabase.isIgnored(hdr.messageKey)
              ) {
                return;
              }
              keysToDownload.add(hdr.messageKey);
            } catch (error) {
              selectionError = error;
            }
          },
          onSearchDone: status => {
            try {
              if (selectionError) {
                throw selectionError;
              }
              if (!Components.isSuccessCode(status)) {
                throw Components.Exception(
                  "News download selection failed",
                  status
                );
              }
              if (native && folder.msgDatabase != msgDatabase) {
                throw Components.Exception(
                  "News selection owner changed",
                  Cr.NS_ERROR_NOT_AVAILABLE
                );
              }
              resolve();
            } catch (error) {
              reject(error);
            }
          },
        },
        Ci.nsIMsgSearchSession.allNotifications
      );
      searchSession.addScopeTerm(Ci.nsMsgSearchScope.localNews, folder);
      searchSession.search(this._msgWindow);
    });

    return keysToDownload;
  }

  /** Clears status without replacing an earlier download failure. */
  _clearStatus() {
    try {
      MailServices.feedback.reportStatus("");
    } catch (error) {
      this._logger.warn("Failed to clear news download status", error);
    }
  }

  /**
   * Show a status message in the status bar.
   *
   * @param {nsIMsgFolder} folder - The newsgroup folder the message is about.
   * @param {string} statusName - A string name in news.ftl.
   * @param {object} params - Params to format the string.
   */
  async _updateStatus(folder, statusName, params) {
    MailServices.feedback.reportStatus(
      lazy.messengerBundle.formatStringFromName("statusMessage", [
        folder.server.prettyName,
        await lazy.l10n.formatValue(statusName, params),
      ])
    );
  }
}
