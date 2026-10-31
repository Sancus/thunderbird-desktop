/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

import { MailServices } from "resource:///modules/MailServices.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Gloda: "resource:///modules/gloda/Gloda.sys.mjs",
  GlodaSyntheticView: "resource:///modules/gloda/GlodaSyntheticView.sys.mjs",
  getMailSearchService: "resource:///modules/panorama/MailSearch.sys.mjs",
  getMailSearchHeader: "resource:///modules/panorama/MailSearchPolicy.sys.mjs",
  getMailSearchPolicy: "resource:///modules/panorama/MailSearchPolicy.sys.mjs",
  openMailSearchResultsList:
    "resource:///modules/panorama/MailSearchView.sys.mjs",
});

/**
 * @returns {?nsIDatabaseCore} The registered native backend, or null for legacy.
 */
function nativeCore() {
  MailServices.accounts;
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  return "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore
    ? service.QueryInterface(Ci.nsIDatabaseCore)
    : null;
}

/**
 * Resolve the captured physical selection without opening a message body.
 *
 * @param {nsIDatabaseCore} core - The active native database.
 * @param {object} selection - Captured physical selection.
 * @param {nsIMsgFolder} selection.folder - Original physical folder.
 * @param {number} selection.folderId - Original native folder ID.
 * @param {number} selection.key - Original global message key.
 * @returns {?nsIMsgDBHdr} The current eligible original copy.
 */
function resolveSelection(core, { folder, folderId, key }) {
  const state = core.messageDB.getSearchState(key);
  if (!state || state.folderFlags === null || state.folderId !== folderId) {
    return null;
  }
  const header = lazy.getMailSearchHeader({
    folder,
    location: { folderId, messageKey: key },
  });
  return header && lazy.getMailSearchPolicy(header).eligible ? header : null;
}

/**
 * Capture an eligible header's original physical folder and key.
 *
 * @param {nsIDatabaseCore} core - The active native database.
 * @param {nsIMsgDBHdr} header - The selected header.
 * @returns {?object} Physical identity and a current scoped header.
 */
function nativeSelection(core, header) {
  const key = header?.messageKey;
  if (!Number.isInteger(key) || key <= 0 || key >= 0xffffffff) {
    return null;
  }
  const state = core.messageDB.getSearchState(key);
  if (!state || state.folderFlags === null) {
    return null;
  }
  const folder = header.folder;
  if (!folder || folder.id !== state.folderId) {
    return null;
  }
  const selection = { folder, folderId: state.folderId, key };
  const current = resolveSelection(core, selection);
  return current ? { ...selection, header: current } : null;
}

export class ConversationOpener {
  static isMessageIndexed(message) {
    if (
      !Services.prefs.getBoolPref("mailnews.database.global.indexer.enabled")
    ) {
      return false;
    }
    if (!message) {
      return false;
    }
    const core = nativeCore();
    if (core) {
      return !!nativeSelection(core, message);
    }
    return !!message.folder && lazy.Gloda.isMessageIndexed(message);
  }

  constructor(window) {
    this.window = window;
  }
  /**
   * Open the selected native conversation, or start the legacy lookup.
   *
   * @param {nsIMsgDBHdr[]} messages - Selected headers; native uses the first.
   * @returns {Promise<?object>|undefined} Native completion, or no legacy result.
   */
  openConversationForMessages(messages) {
    if (messages.length < 1) {
      return undefined;
    }
    try {
      const core = nativeCore();
      if (core) {
        return this._openNative(messages[0], core);
      }
    } catch (error) {
      return Promise.reject(error);
    }
    try {
      this._items = [];
      this._msgHdr = messages[0];
      this._queries = [
        lazy.Gloda.getMessageCollectionForHeaders(messages, this),
      ];
    } catch (e) {
      console.error(e);
    }
    return undefined;
  }
  /**
   * Start a native opening and settle cancellation when the origin closes.
   *
   * @param {nsIMsgDBHdr} header - The requested physical selection.
   * @param {nsIDatabaseCore} core - The registered native backend.
   * @returns {Promise<?object>} The opened mail tab, or null when not available.
   */
  _openNative(header, core) {
    if (
      this.window.closed ||
      !Services.prefs.getBoolPref("mailnews.database.global.indexer.enabled")
    ) {
      return Promise.resolve(null);
    }
    const selection = nativeSelection(core, header);
    if (!selection) {
      return Promise.resolve(null);
    }
    const title = selection.header.mime2DecodedSubject;
    const sourceId = core.sourceId;
    const controller = new AbortController();
    const { promise, resolve, reject } = Promise.withResolvers();
    const abort = () => {
      controller.abort(
        new DOMException("Conversation origin closed", "AbortError")
      );
      resolve(null);
    };
    this.window.addEventListener("unload", abort, { once: true });
    if (this.window.closed) {
      abort();
    }
    this._openNativeSelection(selection, sourceId, title, controller.signal)
      .finally(() => this.window.removeEventListener("unload", abort))
      .then(resolve, reject);
    return promise;
  }

  /**
   * Open all captured native conversation members, then focus the exact copy.
   *
   * @param {object} selection - Original physical folder and key.
   * @param {string} sourceId - Original native database incarnation.
   * @param {string} title - Existing message subject for the tab title.
   * @param {AbortSignal} signal - Cancels delivery when the origin closes.
   * @returns {Promise<?object>} The completed mail tab, or null on cancellation.
   */
  async _openNativeSelection(selection, sourceId, title, signal) {
    let tabmail;
    let tab;
    try {
      signal.throwIfAborted();
      const service = await lazy.getMailSearchService();
      signal.throwIfAborted();
      let core = nativeCore();
      if (!core || core.sourceId !== sourceId) {
        throw Components.Exception(
          "Mail database changed",
          Cr.NS_ERROR_NOT_AVAILABLE
        );
      }
      const header = resolveSelection(core, selection);
      if (!header) {
        return null;
      }
      const snapshot = await service.getConversationForHeader(header, {
        signal,
      });
      signal.throwIfAborted();
      if (snapshot.status != "ready") {
        return null;
      }
      if (
        snapshot.sourceId !== sourceId ||
        snapshot.selectedId !== String(selection.key) ||
        snapshot.selectedMessage.messageKey !== selection.key ||
        snapshot.selectedMessage.folder.id !== selection.folderId
      ) {
        throw Components.Exception(
          "Conversation selection changed",
          Cr.NS_ERROR_NOT_AVAILABLE
        );
      }
      tabmail = await this._nativeTabmail(signal);
      signal.throwIfAborted();
      tab = await lazy.openMailSearchResultsList(tabmail, service, snapshot, {
        signal,
        title,
        background: false,
      });
      signal.throwIfAborted();
      core = nativeCore();
      const current =
        core?.sourceId === sourceId && resolveSelection(core, selection);
      const pane = tab.chromeBrowser?.contentWindow;
      const view = pane?.gDBView;
      const index = current && view?.findIndexOfMsgHdr(current, true);
      const row =
        index !== false && index != undefined && index != 0xffffffff
          ? view.getMsgHdrAt(index)
          : null;
      if (
        !tabmail.tabInfo.includes(tab) ||
        !pane?.gViewWrapper?.isSynthetic ||
        row?.messageKey !== selection.key ||
        row.folder.id !== selection.folderId
      ) {
        throw Components.Exception(
          "Conversation selection is no longer available",
          Cr.NS_ERROR_NOT_AVAILABLE
        );
      }
      // selectMessage falls back to a folder when the row is absent; never use it then.
      pane.selectMessage(row);
      return tab;
    } catch (error) {
      if (tab && tabmail?.tabInfo.includes(tab)) {
        tabmail.closeTab(tab);
      }
      if (signal.aborted || error?.name == "AbortError") {
        return null;
      }
      throw error;
    }
  }

  /**
   * Find the existing mail window, or wait for a newly created one to start.
   *
   * @param {AbortSignal} signal - Cancels a pending new window.
   * @returns {Promise<Element>} The normal mail window's tab manager.
   */
  async _nativeTabmail(signal) {
    signal.throwIfAborted();
    const existing =
      this.window.top.document.getElementById("tabmail") ??
      Services.wm
        .getMostRecentWindow("mail:3pane")
        ?.document.getElementById("tabmail");
    if (existing) {
      return existing;
    }
    signal.throwIfAborted();
    const win = Services.ww.openWindow(
      null,
      "chrome://messenger/content/messenger.xhtml",
      "_blank",
      "chrome,dialog=no,all",
      Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString)
    );
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        Services.obs.removeObserver(observer, "mail-startup-done");
        signal.removeEventListener("abort", abort);
        Services.ww.unregisterNotification(closed);
      };
      const abort = () => {
        cleanup();
        win.close();
        reject(signal.reason);
      };
      const closed = {
        observe(subject, topic) {
          if (topic != "domwindowclosed" || subject != win) {
            return;
          }
          cleanup();
          reject(
            new DOMException("Mail window closed before startup", "AbortError")
          );
        },
      };
      const observer = {
        observe(subject) {
          if (subject == win) {
            cleanup();
            resolve(win.document.getElementById("tabmail"));
          }
        },
      };
      Services.obs.addObserver(observer, "mail-startup-done");
      signal.addEventListener("abort", abort, { once: true });
      Services.ww.registerNotification(closed);
      if (signal.aborted) {
        abort();
      } else if (win.closed) {
        closed.observe(win, "domwindowclosed");
      }
    });
  }

  onItemsAdded() {}
  onItemsModified() {}
  onItemsRemoved() {}
  onQueryCompleted(collection) {
    try {
      if (!collection.items.length) {
        console.error("Couldn't find a collection for msg: " + this._msgHdr);
      } else {
        const message = collection.items[0];
        const tabType = "mail3PaneTab";
        const tabParams = {
          folderPaneVisible: false,
          syntheticView: new lazy.GlodaSyntheticView({
            conversation: message.conversation,
            message,
          }),
          title: message.conversation.subject,
          background: false,
        };
        const tabmail =
          this.window.top.document.getElementById("tabmail") ??
          Services.wm
            .getMostRecentWindow("mail:3pane")
            ?.document.getElementById("tabmail");
        if (tabmail) {
          tabmail.openTab(tabType, tabParams);
        } else {
          const win = Services.ww.openWindow(
            null,
            "chrome://messenger/content/messenger.xhtml",
            "_blank",
            "chrome,dialog=no,all",
            Cc["@mozilla.org/supports-string;1"].createInstance(
              Ci.nsISupportsString
            )
          );
          const mailStartupObserver = {
            observe(subject) {
              if (subject == win) {
                win.document
                  .getElementById("tabmail")
                  .openTab(tabType, tabParams);
                Services.obs.removeObserver(this, "mail-startup-done");
              }
            },
          };
          Services.obs.addObserver(mailStartupObserver, "mail-startup-done");
        }
      }
    } catch (e) {
      console.error(e);
    }
  }
}
