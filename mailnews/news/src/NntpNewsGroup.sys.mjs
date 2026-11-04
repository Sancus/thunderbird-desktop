/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MailServices } from "resource:///modules/MailServices.sys.mjs";

import { MsgKeySet } from "resource:///modules/MsgKeySet.sys.mjs";

/**
 * A helper class for NntpClient to deal with msg db and folders.
 */
export class NntpNewsGroup {
  /**
   * @param {nsINntpIncomingServer} server - The associated server instance.
   * @param {nsIMsgNewsFolder} folder - The associated news folder.
   */
  constructor(server, folder) {
    this._server = server;
    this._folder = folder;
    this._db = this._folder.msgDatabase;
    this._msgHdrs = [];
    this._nativeBackend = Services.prefs.getBoolPref(
      "mail.panorama.enabled",
      false
    );
    // Protocol article numbers remain distinct from native physical keys.
    this._articleNumbers = new WeakMap();
    this._oldReadRange = null;
    // The msg hdrs created from the XOVER response, by article number.
    this._xoverHdrs = new Map();
    this._commitReadKeySet = false;
    this._skipHead = false;
  }

  /**
   * @type {boolean} value - Whether to fetch old messages.
   */
  set getOldMessages(value) {
    this._getOldMessages = value;
  }

  /**
   * Get the articles range to fetch, depending on server setting and user
   * selection.
   *
   * @type {nsIMsgWindow} msgWindow - The associated msg window.
   * @type {number} firstPossible - The first article that can be fetched.
   * @type {number} lastPossible - The last article that can be fetched.
   * @returns {[number, number]} A tuple of the first and last article to fetch.
   */
  getArticlesRangeToFetch(msgWindow, firstPossible, lastPossible) {
    this._lastPossible = lastPossible;
    this._msgWindow = msgWindow;
    if (!this._msgWindow) {
      try {
        this._msgWindow = MailServices.mailSession.topmostMsgWindow;
      } catch (e) {}
    }

    this._folderFilterList = this._folder.getFilterList(this._msgWindow);
    this._serverFilterList = this._server.getFilterList(this._msgWindow);
    this._filterHeaders = new Set(
      (
        this._folderFilterList.arbitraryHeaders +
        " " +
        this._serverFilterList.arbitraryHeaders
      )
        .split(" ")
        .filter(Boolean)
    );
    this._readKeySet = new MsgKeySet(
      this._folder.newsrcLine.split(":")[1].trim()
    );

    const groupInfo = this._db.dBFolderInfo;
    if (groupInfo) {
      this._knownKeySet = new MsgKeySet(groupInfo.knownArtsSet);
    } else {
      this._knownKeySet = new MsgKeySet();
    }

    if (this._getOldMessages || !this._knownKeySet.has(lastPossible)) {
      let [start, end] = this._knownKeySet.getLastMissingRange(
        firstPossible,
        lastPossible
      );
      if (this._getOldMessages) {
        return [Math.max(start, end - this._server.maxArticles + 1), end];
      }
      if (
        start &&
        end - start > this._server.maxArticles &&
        this._server.notifyOn
      ) {
        // Show a dialog to let user decide how many articles to download.

        const propBag = Cc["@mozilla.org/hash-property-bag;1"].createInstance(
          Ci.nsIWritablePropertyBag2
        );
        propBag.setPropertyAsInt32("articleCount", end - start + 1);
        propBag.setPropertyAsAString("groupName", this._folder.name);
        propBag.setPropertyAsACString("serverKey", this._server.key);
        Services.wm
          .getMostRecentWindow("mail:3pane")
          .openDialog(
            "chrome://messenger/content/downloadheaders.xhtml",
            "_blank",
            "centerscreen,chrome,modal,titlebar",
            propBag
          );
        if (!propBag.getPropertyAsBool("hitOK")) {
          return [];
        }
        start = propBag.getPropertyAsBool("downloadAll")
          ? start
          : end - this._server.maxArticles + 1;
        if (this._server.markOldRead) {
          this._readKeySet.addRange(firstPossible, start - 1);
          this._commitReadKeySet = true;
          this._oldReadRange = [firstPossible, start - 1];
        }
      }
      return [start, end];
    }
    return [];
  }

  /**
   * Set a message subject and its HasRe flag.
   *
   * @param {nsIMsgDBHdr} msgHdr - The message header to update.
   * @param {string} subject - The unprocessed subject.
   */
  setSubject(msgHdr, subject) {
    const hasEncodedWords = subject.includes("=?");
    const decodedSubject = hasEncodedWords
      ? MailServices.mimeConverter.decodeMimeHeader(subject, null, false, true)
      : subject;
    const strippedSubject =
      MailServices.subjects.stripReplyPrefixes(decodedSubject);
    const hadReplyPrefix = strippedSubject != decodedSubject;
    if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
      msgHdr.subject = strippedSubject;
    } else if (hadReplyPrefix && hasEncodedWords) {
      msgHdr.subject =
        MailServices.subjects.encodeForLegacyStorage(strippedSubject);
    } else if (hadReplyPrefix) {
      msgHdr.subject = strippedSubject;
    } else {
      msgHdr.subject = subject;
    }
    msgHdr.flags =
      (msgHdr.flags & ~Ci.nsMsgMessageFlags.HasRe) |
      (hadReplyPrefix ? Ci.nsMsgMessageFlags.HasRe : 0);
  }

  /**
   * Parse an XOVER line to a msg hdr.
   *
   * @param {string} line - An XOVER response line.
   */
  processXOverLine(line) {
    const parts = line.split("\t");
    if (parts.length < 8) {
      return;
    }
    const [
      articleNumber,
      subject,
      from,
      date,
      messageId,
      references,
      bytes,
      lines,
    ] = parts;
    const msgHdr = this._createHeader(Number(articleNumber));
    if (this._nativeBackend && msgHdr.isLive) {
      return;
    }
    msgHdr.orFlags(Ci.nsMsgMessageFlags.New);
    this.setSubject(msgHdr, subject);
    msgHdr.author = from;
    msgHdr.date = new Date(date).valueOf() * 1000;
    msgHdr.messageId = messageId;
    msgHdr.setReferences(references);
    msgHdr.messageSize = bytes;
    msgHdr.lineCount = lines;
    this._msgHdrs.push(msgHdr);
    this._xoverHdrs.set(Number(articleNumber), msgHdr);
  }

  /**
   * Add a range (usually XOVER range) to the known key set.
   */
  addKnownArticles(start, end) {
    this._knownKeySet.addRange(start, end);
  }

  /**
   * Finish processing XOVER responses.
   */
  finishProcessingXOver() {
    this._runFilters();
    const groupInfo = this._db.dBFolderInfo;
    if (groupInfo) {
      groupInfo.knownArtsSet = this._knownKeySet.toString();
    }
  }

  /**
   * Extra headers needed by filters, but not returned in XOVER response.
   */
  getXHdrFields() {
    return [...this._filterHeaders].filter(
      x => !["message-id", "references"].includes(x)
    );
  }

  /**
   * Update msgHdr according to XHDR line.
   *
   * @param {string} header - The requested header.
   * @param {string} line - A XHDR response line.
   */
  processXHdrLine(header, line) {
    const spaceIndex = line.indexOf(" ");
    const articleNumber = line.slice(0, spaceIndex);
    const value = line.slice(spaceIndex).trim();
    // Skip articles that weren't in the XOVER response, there's no msg hdr
    // to update.
    const msgHdr = this._xoverHdrs.get(+articleNumber);
    if (!msgHdr) {
      return;
    }
    msgHdr.setStringProperty(header, value);
  }

  /**
   * Init a msgHdr to prepare to take HEAD response.
   *
   * @param {number} articleNumber - The article number.
   */
  initHdr(articleNumber) {
    if (this._msgHdr) {
      this._msgHdrs.push(this._msgHdr);
    }

    this._msgHdr = null;
    this._skipHead = false;
    if (articleNumber >= 0) {
      const header = this._createHeader(articleNumber);
      if (this._nativeBackend && header.isLive) {
        this._skipHead = true;
      } else {
        this._msgHdr = header;
      }
    }
  }

  /**
   * Create a header while retaining its captured protocol article number.
   *
   * @param {number} articleNumber - The server's article number, including zero.
   * @returns {nsIMsgDBHdr} The header returned by the news database.
   * @throws {nsIException} If a native article cannot fit in the read-key set.
   */
  _createHeader(articleNumber) {
    if (
      this._nativeBackend &&
      (!Number.isInteger(articleNumber) ||
        articleNumber < 0 ||
        articleNumber > 0x7fffffff)
    ) {
      throw Components.Exception(
        "Invalid news article number",
        Cr.NS_ERROR_ILLEGAL_VALUE
      );
    }
    const header = this._db.createNewHdrWithSpecificMsgKey(articleNumber);
    this._articleNumbers.set(header, articleNumber);
    return header;
  }

  /**
   * Merge the explicitly selected old-article range into the current read set.
   * Keep later read changes to other articles when a request finishes.
   */
  _saveOldReadRange() {
    if (this._nativeBackend && this._oldReadRange[0] > 0) {
      // GROUP already marked earlier expired articles read. The existing
      // native summary operation adds exactly that union while retaining the
      // original native zero bit, which serialized newsrc cannot represent.
      this._folder.updateSummaryFromNNTPInfo(
        this._oldReadRange[1] + 1,
        this._lastPossible,
        this._folder.getTotalMessages(false)
      );
    } else {
      const current = new MsgKeySet(
        this._folder.newsrcLine.split(":")[1].trim()
      );
      current.addRange(...this._oldReadRange);
      this._folder.setReadSetFromStr(current.toString());
    }
    this._commitReadKeySet = false;
    this._oldReadRange = null;
  }

  /**
   * Update msgHdr according to HEAD line.
   *
   * @param {string} line - A HEAD response line.
   */
  processHeadLine(line) {
    if (this._skipHead) {
      return;
    }
    const colonIndex = line.indexOf(":");
    const name = line.slice(0, colonIndex).toLowerCase();
    const value = line.slice(colonIndex + 1).trim();
    switch (name) {
      case "from":
        this._msgHdr.author = value;
        break;
      case "date":
        this._msgHdr.date = new Date(value).valueOf() * 1000;
        break;
      case "subject":
        this.setSubject(this._msgHdr, value);
        this._msgHdr.orFlags(Ci.nsMsgMessageFlags.New);
        break;
      case "message-id":
        this._msgHdr.messageId = value;
        break;
      case "references":
        this._msgHdr.setReferences(value);
        break;
      case "bytes":
        this._msgHdr.messageSize = value;
        break;
      case "lines":
        this._msgHdr.lineCount = value;
        break;
      default:
        if (this._filterHeaders.has(name)) {
          this._msgHdr.setStringProperty(name, value);
        }
    }
  }

  /**
   * Run filters to all newly added msg hdrs.
   */
  _runFilters() {
    if (this._nativeBackend && this._commitReadKeySet) {
      this._saveOldReadRange();
    }
    const folderFilterCount = this._folderFilterList.filterCount;
    const serverFilterCount = this._serverFilterList.filterCount;

    for (const msgHdr of this._msgHdrs) {
      const article = this._articleNumbers.get(msgHdr);
      if (this._nativeBackend) {
        const current = new MsgKeySet(
          this._folder.newsrcLine.split(":")[1].trim()
        );
        if (current.has(article)) {
          msgHdr.orFlags(Ci.nsMsgMessageFlags.Read);
        }
      }
      this._filteringHdr = msgHdr;
      this._addHdrToDB = true;
      let headers = "";
      if (folderFilterCount || serverFilterCount) {
        const author = this._filteringHdr.author;
        const subject = this._filteringHdr.subject;
        if (author) {
          headers += `From: ${author}\0`;
        }
        if (subject) {
          headers += `Subject: ${subject}\0`;
        }
      }
      if (folderFilterCount) {
        this._folderFilterList.applyFiltersToHdr(
          Ci.nsMsgFilterType.NewsRule,
          msgHdr,
          this._folder,
          this._db,
          headers,
          this,
          this._msgWindow
        );
        this._folderFilterList.flushLogIfNecessary();
      }
      if (serverFilterCount) {
        this._serverFilterList.applyFiltersToHdr(
          Ci.nsMsgFilterType.NewsRule,
          msgHdr,
          this._folder,
          this._db,
          headers,
          this,
          this._msgWindow
        );
        this._serverFilterList.flushLogIfNecessary();
      }
      if (
        this._addHdrToDB &&
        (this._nativeBackend || !this._db.containsKey(msgHdr.messageKey))
      ) {
        if (!this._nativeBackend && this._readKeySet.has(article)) {
          msgHdr.flags |= Ci.nsMsgMessageFlags.Read;
        }
        let published;
        if (this._nativeBackend) {
          // The native facade returns the real physical header. It owns the
          // inserted/dedup result and sends the global notification once.
          published = this._db.attachHdr(msgHdr, true);
        } else {
          this._db.addNewHdrToDB(msgHdr, true);
          MailServices.mfn.notifyMsgAdded(msgHdr);
          published = msgHdr;
        }
        this._folder.orProcessingFlags(
          published.messageKey,
          Ci.nsMsgProcessingFlags.NotReportedClassified
        );
      }
    }
  }

  /**
   * Callback of nsIMsgFilterList.applyFiltersToHdr.
   *
   * @see nsIMsgFilterHitNotify
   */
  applyFilterHit(filter, msgWindow) {
    const loggingEnabled = filter.filterList.loggingEnabled;
    let applyMore = true;

    for (const action of filter.sortedActionList) {
      switch (action.type) {
        case Ci.nsMsgFilterAction.Delete:
          this._addHdrToDB = false;
          break;
        case Ci.nsMsgFilterAction.MarkRead:
          if (this._nativeBackend) {
            this._filteringHdr.markRead(true);
          } else {
            this._db.markRead(this._filteringHdr.messageKey, true, null);
          }
          break;
        case Ci.nsMsgFilterAction.MarkUnread:
          if (this._nativeBackend) {
            this._filteringHdr.markRead(false);
          } else {
            this._db.markRead(this._filteringHdr.messageKey, false, null);
          }
          break;
        case Ci.nsMsgFilterAction.KillThread:
          this._filteringHdr.setUint32Property(
            "ProtoThreadFlags",
            Ci.nsMsgMessageFlags.Ignored
          );
          break;
        case Ci.nsMsgFilterAction.KillSubthread:
          this._filteringHdr.orFlags(Ci.nsMsgMessageFlags.Ignored);
          break;
        case Ci.nsMsgFilterAction.WatchThread:
          this._filteringHdr.orFlags(Ci.nsMsgMessageFlags.Watched);
          break;
        case Ci.nsMsgFilterAction.MarkFlagged:
          this._filteringHdr.markFlagged(true);
          break;
        case Ci.nsMsgFilterAction.ChangePriority:
          this._filteringHdr.priority = action.priority;
          break;
        case Ci.nsMsgFilterAction.AddTag:
          this._folder.addKeywordsToMessages(
            [this._filteringHdr],
            action.strValue
          );
          break;
        case Ci.nsMsgFilterAction.StopExecution:
          applyMore = false;
          break;
        case Ci.nsMsgFilterAction.Custom:
          action.customAction.applyAction(
            [this._filteringHdr],
            action.strValue,
            null,
            Ci.nsMsgFilterType.NewsRule,
            msgWindow
          );
          break;
        default:
          if (loggingEnabled) {
            filter.logRuleHitFail(
              action,
              this._filteringHdr,
              Cr.NS_ERROR_UNEXPECTED,
              "filter-failure-action"
            );
          }
          applyMore = false;
      }
      if (loggingEnabled && applyMore) {
        filter.logRuleHit(action, this._filteringHdr);
      }
    }
    return applyMore;
  }

  /**
   * Commit changes to msg db.
   */
  cleanUp() {
    if (this._commitReadKeySet) {
      if (this._nativeBackend) {
        this._saveOldReadRange();
      } else {
        this._folder.setReadSetFromStr(this._readKeySet.toString());
        this._commitReadKeySet = false;
      }
    }
    this._folder.notifyFinishedDownloadinghdrs();
    this._db.commit(Ci.nsMsgDBCommitType.kSessionCommit);
    if (!this._nativeBackend) {
      this._db.close(true);
    }
    // Native writes are already committed. Keep the folder-owned read-set
    // binding for live flag/listener updates until real folder/database close.
  }
}
