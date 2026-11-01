/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* globals ReloadMessage, getMessagePaneBrowser, openContentTab,
   gMessageNotificationBar */

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { FeedUtils } = ChromeUtils.importESModule(
  "resource:///modules/FeedUtils.sys.mjs"
);
var { MailE10SUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailE10SUtils.sys.mjs"
);
var { openLinkExternally } = ChromeUtils.importESModule(
  "resource:///modules/LinkHelper.sys.mjs"
);

ChromeUtils.defineESModuleGetters(this, {
  MsgHdrToMimeMessage: "resource:///modules/panorama/MimeMessage.sys.mjs",
});

var FeedMessageHandler = {
  gShowSummary: true,
  gToggle: false,
  kSelectOverrideWebPage: 0,
  kSelectOverrideSummary: 1,
  kSelectFeedDefault: 2,
  kOpenWebPage: 0,
  kOpenSummary: 1,
  kOpenToggleInMessagePane: 2,
  kOpenLoadInBrowser: 3,

  FeedAccountTypes: ["rss"],

  /**
   * How to load message on threadpane select.
   */
  get onSelectPref() {
    return Services.prefs.getIntPref("rss.show.summary");
  },

  set onSelectPref(val) {
    Services.prefs.setIntPref("rss.show.summary", val);
    ReloadMessage();
  },

  /**
   * How to load message on open (enter/dbl click in threadpane, contextmenu).
   */
  get onOpenPref() {
    return Services.prefs.getIntPref("rss.show.content-base");
  },

  set onOpenPref(val) {
    Services.prefs.setIntPref("rss.show.content-base", val);
  },

  /**
   * Determine whether to show a feed message summary or load a web page in the
   * message pane.
   *
   * @param {nsIMsgDBHdr} aMsgHdr - The message.
   * @param {boolean} aToggle - true if in toggle mode, false otherwise.
   *
   * @returns {boolean} - true if summary is to be displayed, false if web page.
   */
  shouldShowSummary(aMsgHdr, aToggle) {
    // Not a feed message, always show summary (the message).
    if (!FeedUtils.isFeedMessage(aMsgHdr)) {
      return true;
    }

    // Notified of a summary reload when toggling, reset toggle and return.
    if (!aToggle && this.gToggle) {
      return !(this.gToggle = false);
    }

    let showSummary = true;
    this.gToggle = aToggle;

    // Thunderbird 2 rss messages with 'Show article summary' not selected,
    // ie message body constructed to show web page in an iframe, can't show
    // a summary - notify user.
    const browser = getMessagePaneBrowser();
    const contentDoc = browser ? browser.contentDocument : null;
    const rssIframe = contentDoc
      ? contentDoc.getElementById("_mailrssiframe")
      : null;
    if (rssIframe) {
      if (this.gToggle || this.onSelectPref == this.kSelectOverrideSummary) {
        this.gToggle = false;
      }

      return false;
    }

    if (aToggle) {
      // Toggle mode, flip value.
      return (this.gShowSummary = !this.gShowSummary);
    }

    const wintype = document.documentElement.getAttribute("windowtype");
    const tabMail = document.getElementById("tabmail");
    const messageTab = tabMail && tabMail.currentTabInfo.mode.type == "message";
    const messageWindow = wintype == "mail:messageWindow";

    switch (this.onSelectPref) {
      case this.kSelectOverrideWebPage:
        showSummary = false;
        break;
      case this.kSelectOverrideSummary:
        showSummary = true;
        break;
      case this.kSelectFeedDefault: {
        // Get quickmode per feed folder pref from feed subscriptions. If the feed
        // message is not in a feed account folder (hence the folder is not in
        // the feeds database), err on the side of showing the summary.
        // For the former, toggle or global override is necessary; for the
        // latter, a show summary checkbox toggle in Subscribe dialog will set
        // one on the path to bliss.
        const folder = aMsgHdr.folder;
        showSummary = true;
        const ds = FeedUtils.getSubscriptionsDS(folder.server);
        for (const sub of ds.data) {
          if (sub.destFolder == folder.URI) {
            showSummary = sub.quickMode;
            break;
          }
        }
        break;
      }
    }

    this.gShowSummary = showSummary;

    if (messageWindow || messageTab) {
      // Message opened in either standalone window or tab, due to either
      // message open pref (we are here only if the pref is 0 or 1) or
      // contextmenu open.
      switch (this.onOpenPref) {
        case this.kOpenToggleInMessagePane:
          // Opened by contextmenu, use the value derived above.
          // XXX: allow a toggle via crtl?
          break;
        case this.kOpenWebPage:
          showSummary = false;
          break;
        case this.kOpenSummary:
          showSummary = true;
          break;
      }
    }

    return showSummary;
  },

  /**
   * The current setContent page retrieval, cleared when it settles or a summary
   * is requested. Older failures must not reveal a newer page's hidden body.
   *
   * @type {?Promise<nsIURI>}
   */
  _pendingWebPage: null,

  /**
   * Loads a feed article's Content-Base URL using the retained MIME utility.
   * Reports failures even when the existing UI caller ignores the result.
   *
   * @param {nsIMsgDBHdr} aMessageHdr - The stored feed message.
   * @param {{messagepane?: boolean, browser?: boolean, tab?: boolean,
   *   window?: boolean}} aWhere - Where to load the article.
   * @returns {Promise<nsIURI>} The article URI after starting its load. Rejects
   *   with the original lookup/start exception or terminal failure code. A
   *   missing MIME result or Content-Base rejects with NS_ERROR_NOT_AVAILABLE.
   */
  loadWebPage(aMessageHdr, aWhere) {
    const pending = new Promise((resolve, reject) => {
      MsgHdrToMimeMessage(aMessageHdr, null, (aMsgHdr, aMimeMsg, status) => {
        try {
          if (!Components.isSuccessCode(status)) {
            throw Components.Exception("Feed article retrieval failed", status);
          }
          const contentBase = aMimeMsg?.headers["content-base"]?.[0];
          if (!contentBase) {
            throw Components.Exception(
              "Feed article Content-Base is unavailable",
              Cr.NS_ERROR_NOT_AVAILABLE
            );
          }
          // Stored MIME headers contain UTF-8 bytes; this URI API takes UTF-16.
          const url = decodeURIComponent(escape(contentBase));
          const uri = Services.io.newURI(url);
          // Browser is currently used by SearchDialog for kOpenLoadInBrowser.
          if (aWhere.browser) {
            openLinkExternally(uri, { addToHistory: false });
          } else if (aWhere.messagepane) {
            const browser = getMessagePaneBrowser();
            // Clear sandbox flags before switching to the web document.
            MailE10SUtils.loadAboutBlank(browser);
            MailE10SUtils.loadURI(browser, url);
          } else if (aWhere.tab) {
            openContentTab(url, "tab", null);
          } else if (aWhere.window) {
            openContentTab(url, "window", null);
          }
          resolve(uri);
        } catch (error) {
          reject(error);
        }
      });
    });
    // Attach a handler to the returned promise itself. Fire-and-forget UI
    // callers remain safe, while callers that await it receive the same error.
    pending.catch(error => {
      FeedUtils.log.info(
        "FeedMessageHandler.loadWebPage: article load failed",
        error
      );
    });
    return pending;
  },

  /**
   * Displays a feed summary or starts loading its article web page. Restores
   * the current summary body when its page retrieval fails.
   *
   * @param {nsIMsgDBHdr} aMsgHdr - The message.
   * @param {boolean} aShowSummary - Whether to display the summary.
   * @returns {Promise<?nsIURI>} The page load result, or null for a summary.
   *   Page failures retain the loadWebPage rejection and are handled internally
   *   for existing callers that ignore the returned promise.
   */
  setContent(aMsgHdr, aShowSummary) {
    if (aShowSummary) {
      this._pendingWebPage = null;
      // Only here if toggling to summary in 3pane.
      if (this.gToggle && window.gDBView) {
        ReloadMessage();
      }
      return Promise.resolve(null);
    }

    const browser = getMessagePaneBrowser();
    const body = browser?.contentDocument?.body;
    if (body) {
      body.hidden = true;
    }
    // Remote-content notifications do not apply to the article web page.
    gMessageNotificationBar.clearMsgNotifications();
    const pending = this.loadWebPage(aMsgHdr, { messagepane: true });
    this._pendingWebPage = pending;
    this.gToggle = false;
    pending.then(
      () => {
        if (this._pendingWebPage == pending) {
          this._pendingWebPage = null;
        }
      },
      () => {
        if (this._pendingWebPage == pending) {
          this._pendingWebPage = null;
          if (body && browser.contentDocument?.body == body) {
            body.hidden = false;
          }
        }
      }
    );
    return pending;
  },
};

// Special case attempts to reply/forward/edit as new RSS articles. For
// messages stored prior to Tb15, we are here only if the message's folder's
// account server is rss and feed messages moved to other types will have their
// summaries loaded, as viewing web pages only happened in an rss account.
// The user may choose whether to load a summary or web page link by ensuring
// the current feed message is being viewed as either a summary or web page.
function openComposeWindowForRSSArticle(
  aMsgComposeWindow,
  aMsgHdr,
  aMessageUri,
  aType,
  aFormat,
  aIdentity,
  aMsgWindow
) {
  // Ensure right content is handled for web pages in window/tab.
  const tabmail = document.getElementById("tabmail");
  const is3pane =
    tabmail && tabmail.selectedTab && tabmail.selectedTab.mode
      ? tabmail.selectedTab.mode.type == "folder"
      : false;
  const showingwebpage =
    "FeedMessageHandler" in window &&
    !is3pane &&
    FeedMessageHandler.onOpenPref == FeedMessageHandler.kOpenWebPage;

  if (FeedMessageHandler.gShowSummary && !showingwebpage) {
    // The user is viewing the summary.
    MailServices.compose.OpenComposeWindow(
      aMsgComposeWindow,
      aMsgHdr,
      aMessageUri,
      aType,
      aFormat,
      aIdentity,
      null,
      aMsgWindow
    );
  } else {
    // Set up the compose message and get the feed message's web page link.
    const msgHdr = aMsgHdr;
    const type = aType;
    let subject = msgHdr.mime2DecodedSubject;
    let fwdPrefix = Services.prefs.getCharPref("mail.forward_subject_prefix");
    fwdPrefix = fwdPrefix ? fwdPrefix + ": " : "";

    const params = Cc[
      "@mozilla.org/messengercompose/composeparams;1"
    ].createInstance(Ci.nsIMsgComposeParams);

    const composeFields = Cc[
      "@mozilla.org/messengercompose/composefields;1"
    ].createInstance(Ci.nsIMsgCompFields);

    if (
      type == Ci.nsIMsgCompType.Reply ||
      type == Ci.nsIMsgCompType.ReplyAll ||
      type == Ci.nsIMsgCompType.ReplyToSender ||
      type == Ci.nsIMsgCompType.ReplyToGroup ||
      type == Ci.nsIMsgCompType.ReplyToSenderAndGroup ||
      type == Ci.nsIMsgCompType.ReplyToList
    ) {
      subject = "Re: " + subject;
    } else if (
      type == Ci.nsIMsgCompType.ForwardInline ||
      type == Ci.nsIMsgCompType.ForwardAsAttachment
    ) {
      subject = fwdPrefix + subject;
    }

    params.composeFields = composeFields;
    params.composeFields.subject = subject;
    params.composeFields.body = "";
    params.bodyIsLink = false;
    params.identity = aIdentity;

    try {
      // The feed's web page url is stored in the Content-Base header.
      MsgHdrToMimeMessage(
        msgHdr,
        null,
        function (messageHeader, aMimeMsg) {
          if (
            aMimeMsg &&
            aMimeMsg.headers["content-base"] &&
            aMimeMsg.headers["content-base"][0]
          ) {
            const url = decodeURIComponent(
              escape(aMimeMsg.headers["content-base"])
            );
            params.composeFields.body = url;
            params.bodyIsLink = true;
            MailServices.compose.OpenComposeWindowWithParams(null, params);
          } else {
            // No content-base url, use the summary.
            MailServices.compose.OpenComposeWindow(
              aMsgComposeWindow,
              messageHeader,
              aMessageUri,
              aType,
              aFormat,
              aIdentity,
              null,
              aMsgWindow
            );
          }
        },
        false,
        { saneBodySize: true }
      );
    } catch (ex) {
      // Error getting header, use the summary.
      MailServices.compose.OpenComposeWindow(
        aMsgComposeWindow,
        aMsgHdr,
        aMessageUri,
        aType,
        aFormat,
        aIdentity,
        null,
        aMsgWindow
      );
    }
  }
}
