/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

ChromeUtils.defineESModuleGetters(this, {
  DisplayNameUtils: "resource:///modules/DisplayNameUtils.sys.mjs",
  MailUtils: "resource:///modules/MailUtils.sys.mjs",
  MessageArchiver: "resource:///modules/MessageArchiver.sys.mjs",
  MsgHdrToMimeMessage: "resource:///modules/panorama/MimeMessage.sys.mjs",
  TagUtils: "resource:///modules/TagUtils.sys.mjs",
  UIDensity: "resource:///modules/UIDensity.sys.mjs",
  UIFontSize: "resource:///modules/UIFontSize.sys.mjs",
  makeFriendlyDateAgo: "resource:///modules/TemplateUtils.sys.mjs",
  mimeMsgToContentSnippetAndMeta:
    "resource:///modules/panorama/MessageContent.sys.mjs",
});

ChromeUtils.defineLazyGetter(
  this,
  "l10n",
  () => new Localization(["messenger/multimessageview.ftl"], true)
);

window.addEventListener("DOMContentLoaded", event => {
  if (event.target != document) {
    return;
  }

  UIDensity.registerWindow(window);
  UIFontSize.registerWindow(window);
});

/**
 * A LimitIterator is a utility class that allows limiting the maximum number
 * of items to iterate over.
 */
class LimitIterator {
  /**
   *
   * @param {any[]} aArray - The array to iterate over (can be anything with a
   *   .length property and a subscript operator.
   * @param {int} aMaxLength - The maximum number of items to iterate over.
   */
  constructor(aArray, aMaxLength) {
    this._array = aArray;
    this._maxLength = aMaxLength;
  }

  /**
   * Iterate over the array until we hit the end or the maximum length,
   * whichever comes first.
   */
  *[Symbol.iterator]() {
    const length = this.length;
    for (let i = 0; i < length; i++) {
      yield this._array[i];
    }
  }

  /**
   * Returns true if the iterator won't actually iterate over everything in the
   * array.
   */
  get limited() {
    return this._array.length > this._maxLength;
  }

  /**
   * Returns the number of elements that will actually be iterated over.
   */
  get length() {
    return Math.min(this._array.length, this._maxLength);
  }

  /**
   * Returns the real number of elements in the array.
   */
  get trueLength() {
    return this._array.length;
  }
}

/**
 * The MultiMessageSummary class is responsible for populating the message pane
 * with a reasonable summary of a set of messages.
 */
class MultiMessageSummary {
  constructor() {
    this._summarizers = {};
    this._folderStates = new Map();
    this._summaryNodes = new Set();
    this._generation = 0;
    this._nextMemberOrder = 0;
    window.addEventListener("unload", () => this.clear(), { once: true });
  }
  /**
   * The maximum number of messages to examine in any way.
   */
  kMaxMessages = 10000;

  /**
   * The URL of the document used to store XUL properties.
   *
   * @type {string}
   */
  #docURL = "chrome://messenger/content/messenger.xhtml";

  /**
   * The object storing the button style saved customization options.
   *
   * @property {string} buttonStyle - The style in which the buttons should be
   *   rendered:
   *   - "default" = icons+text
   *   - "only-icons" = only icons
   *   - "only-text" = only text
   */
  #customizeData = {
    buttonStyle: "default",
  };

  /**
   * Register a summarizer for a particular type of message summary.
   *
   * @param {ThreadSummarizer|MultipleSelectionSummarizer} aSummarizer - The summarizer object.
   */
  registerSummarizer(aSummarizer) {
    this._summarizers[aSummarizer.name] = aSummarizer;
    aSummarizer.onregistered(this);
  }

  /**
   * Store the physical message identity and metadata for a summary node.
   *
   * @param {nsIMsgDBHdr} aMsgHdr - The nsIMsgDBHdr.
   * @param {Node} aNode - The related DOM node.
   */
  mapMsgToNode(aMsgHdr, aNode) {
    const folder = aMsgHdr.folder;
    let state = this._folderStates.get(folder.URI);
    if (!state) {
      state = { folder, members: new Map(), database: null, listener: null };
      this._folderStates.set(folder.URI, state);
    }
    state.members.set(aMsgHdr.messageKey, {
      node: aNode,
      order: this._nextMemberOrder++,
      ...this._readMetadata(aMsgHdr),
    });
    this._summaryNodes.add(aNode);
  }

  /**
   * Clear all the content from the summary.
   */
  clear() {
    this._selectCallback = null;
    this._listener = null;
    this._generation++;
    this._refreshPending = false;
    for (const state of this._folderStates.values()) {
      this._stopListening(state);
    }
    this._folderStates.clear();
    this._summaryNodes.clear();
    this._nextMemberOrder = 0;

    // Clear the messages list.
    const messageList = document.getElementById("messageList");
    messageList.replaceChildren();

    // Clear the notice.
    document.getElementById("notice").textContent = "";
  }

  _archiveBtnClickHandler = event => {
    if (event.button == 0) {
      window.browsingContext.topChromeWindow.goDoCommand("cmd_archive");
    }
  };

  _trashBtnClickHandler = event => {
    if (event.button == 0) {
      window.browsingContext.topChromeWindow.goDoCommand(
        event.shiftKey && event.target.dataset.imapDeleted == "false"
          ? "cmd_shiftDelete"
          : "cmd_delete"
      );
    }
  };

  _flagBtnClickHandler = event => {
    if (event.button == 0) {
      window.browsingContext.topChromeWindow.goDoCommand("cmd_markAsFlagged");
    }
  };

  /**
   * Fill in the summary pane describing the selected messages.
   *
   * @param {string} aType - The type of summary to perform (e.g. 'multimessage').
   * @param {nsIMsgDBHdr[]} aMessages - The messages to summarize.
   * @param {nsIMsgDBView} aDBView - The current DB view.
   * @param {function(nsIMsgDBHdr[]):void} aSelectCallback - Called with an
   *   array of messages when one of a summarized message is clicked on.
   * @param {Function} [aListener] A listener to be notified when the summary
   *   starts and finishes.
   */
  summarize(aType, aMessages, aDBView, aSelectCallback, aListener) {
    this.clear();

    this._selectCallback = aSelectCallback;
    this._listener = aListener;
    if (this._listener) {
      this._listener.onLoadStarted();
    }

    if (Services.xulStore.hasValue(this.#docURL, "messageHeader", "layout")) {
      this.#customizeData = JSON.parse(
        Services.xulStore.getValue(this.#docURL, "messageHeader", "layout")
      );
    }

    const headerBar = document.getElementById("headingWrapper");
    // Always clear existing styles to avoid visual issues.
    headerBar.classList.remove(
      "message-header-large-subject",
      "message-header-buttons-only-icons",
      "message-header-buttons-only-text",
      "message-header-hide-label-column"
    );

    switch (this.#customizeData.buttonStyle) {
      case "only-icons":
      case "only-text":
        headerBar.classList.add(
          `message-header-buttons-${this.#customizeData.buttonStyle}`
        );
        break;

      case "default":
      default:
        headerBar.classList.remove(
          "message-header-buttons-only-icons",
          "message-header-buttons-only-text"
        );
        break;
    }

    const archiveBtn = document.getElementById("hdrArchiveButton");
    archiveBtn.hidden = !MessageArchiver.canArchive(aMessages);
    archiveBtn.addEventListener("click", this._archiveBtnClickHandler);

    const trashBtn = document.getElementById("hdrTrashButton");
    trashBtn.addEventListener("click", this._trashBtnClickHandler);
    const areIMAPDeleted = aDBView
      ?.getSelectedMsgHdrs()
      .every(msg => msg.flags & Ci.nsMsgMessageFlags.IMAPDeleted);
    document.l10n.setAttributes(
      trashBtn,
      areIMAPDeleted
        ? "multi-message-undelete-button"
        : "multi-message-delete-button"
    );
    trashBtn.dataset.imapDeleted = !!areIMAPDeleted;

    // Set the flag/star button on click listener.
    const flagButton = document.getElementById("starMessageButton");
    flagButton.addEventListener("click", this._flagBtnClickHandler);

    headerToolbarNavigation.init();
    headerToolbarNavigation.updateRovingTab();

    const summarizer = this._summarizers[aType];
    if (!summarizer) {
      throw new Error('Unknown summarizer "' + aType + '"');
    }

    const messages = new LimitIterator(aMessages, this.kMaxMessages);
    summarizer.summarize(messages, aDBView);

    try {
      for (const state of this._folderStates.values()) {
        this._startListening(state);
      }
      this._computeSize(messages);
    } catch (error) {
      this.clear();
      throw error;
    }

    const generation = this._generation;
    queueMicrotask(() => {
      if (generation == this._generation && this._listener) {
        const listener = this._listener;
        this._listener = null;
        listener.onLoadCompleted();
      }
    });
  }

  /**
   * Set the heading for the summary.
   *
   * @param {string} title - The title for the heading.
   * @param {string} subtitle - A smaller subtitle for the heading.
   */
  setHeading(title, subtitle) {
    const titleNode = document.getElementById("summaryTitle");
    const subtitleNode = document.getElementById("summarySubtitle");
    titleNode.textContent = title || "";
    subtitleNode.textContent = subtitle || "";
  }

  /**
   * Create a summary item for a message or thread.
   *
   * @param {nsIMsgDBHdr[]} messages - An array of messages to summarize.
   * @param {object} [options={}] - Optional object to customize the output:
   * @param {boolean} options.showSubject - true if the subject of the message
   *   should be shown.
   * @param {integer} options.snippetLength - The length in bytes of the message
   *   snippet.
   * @param {boolean} options.belongsToThread - true if we're rendering a
   *   message that belongs to the currently single selected thread.
   * @returns {HTMLLIElement} - The list item node.
   */
  makeSummaryItem(messages, options = {}) {
    const firstMessage = messages[0];
    const isStarred = messages.some(message => message.isFlagged);

    const unreadCount = messages.filter(message => !message.isRead).length;
    const tags = new Map();
    for (const message of messages) {
      for (const tag of this._getTagsForMsg(message)) {
        tags.set(tag.key, tag);
      }
    }

    const listItem = document
      .getElementById(
        options.belongsToThread ? "threadTemplate" : "multiSelectionTemplate"
      )
      .content.cloneNode(true).firstElementChild;
    listItem.dataset.messageId = firstMessage.messageId;
    listItem.classList.toggle("unread", unreadCount);
    listItem.classList.toggle("starred", isStarred);

    const author = listItem.querySelector(".author");
    author.textContent = DisplayNameUtils.formatDisplayNameList(
      firstMessage.mime2DecodedAuthor,
      "from"
    );

    if (options.showSubject) {
      const subjectNode = listItem.querySelector(".subject");
      subjectNode.textContent =
        firstMessage.mime2DecodedSubject || l10n.formatValueSync("no-subject");
      subjectNode.addEventListener("click", () =>
        this._selectSummaryItem(listItem)
      );

      if (messages?.length > 1) {
        let countStr = l10n.formatValueSync("num-messages", {
          count: messages.length,
        });
        if (unreadCount) {
          countStr += l10n.formatValueSync("num-unread", {
            count: unreadCount,
          });
        }
        listItem.querySelector(".count").textContent = countStr;
      }
    } else {
      listItem.querySelector(".date").textContent = makeFriendlyDateAgo(
        new Date(firstMessage.date / 1000)
      );
      author.addEventListener("click", () => {
        this._selectSummaryItem(listItem);
      });
    }

    this._addTagNodes(tags.values(), listItem.querySelector(".tags"));

    const snippetNode = listItem.querySelector(".snippet");
    const generation = this._generation;
    const folder = firstMessage.folder;
    try {
      MsgHdrToMimeMessage(
        firstMessage,
        null,
        (messageHeader, mimeMessage) => {
          if (generation != this._generation || mimeMessage == null) {
            // Shouldn't happen, but sometimes does?
            return;
          }
          const [text, meta] = mimeMsgToContentSnippetAndMeta(
            mimeMessage,
            folder,
            options.snippetLength
          );
          snippetNode.textContent = text;
          if (meta.author) {
            author.textContent = meta.author;
          }
        },
        false,
        { saneBodySize: true }
      );
    } catch (e) {
      if (e.result == Cr.NS_ERROR_FAILURE) {
        // Offline messages generate exceptions, which is unfortunate.  When
        // that's fixed, this code should adapt. XXX
        snippetNode.textContent = "...";
      } else {
        throw e;
      }
    }
    return listItem;
  }

  /**
   * Show an informative notice about the summarized messages (e.g. if we only
   * summarized some of them).
   *
   * @param {string} aNoticeText The text to show in the notice.
   */
  showNotice(aNoticeText) {
    const notice = document.getElementById("notice");
    notice.textContent = aNoticeText;
  }

  /**
   * Given a msgHdr, return a list of tag objects. This function just does the
   * messy work of understanding how tags are stored in nsIMsgDBHdrs.  It would
   * be a good candidate for a utility library.
   *
   * @param {nsIMsgDBHdr} aMsgHdr - The msgHdr whose tags we want.
   * @returns {nsIMsgTag[]} An array of nsIMsgTag objects.
   */
  _getTagsForMsg(aMsgHdr) {
    const keywords = new Set(aMsgHdr.getStringProperty("keywords").split(" "));
    const allTags = MailServices.tags.getAllTags();

    return allTags.filter(function (tag) {
      return keywords.has(tag.key);
    });
  }

  /**
   * Add a list of tags to a DOM node.
   *
   * @param {nsIMsgTag[]} aTags - An array of nsIMsgTag objects.
   * @param {Node} aTagsNode - The DOM node to contain the list of tags.
   */
  _addTagNodes(aTags, aTagsNode) {
    // Make sure the tags are sorted in their natural order.
    const sortedTags = [...aTags];
    sortedTags.sort(function (a, b) {
      return a.key.localeCompare(b.key) || a.ordinal.localeCompare(b.ordinal);
    });

    for (const tag of sortedTags) {
      const tagNode = document.createElement("span");

      tagNode.className = "tag";
      const color = MailServices.tags.getColorForKey(tag.key);
      if (color) {
        const textColor = !TagUtils.isColorContrastEnough(color)
          ? "white"
          : "black";
        tagNode.setAttribute(
          "style",
          "color: " + textColor + "; background-color: " + color + ";"
        );
      }
      tagNode.dataset.tag = tag.tag;
      tagNode.textContent = tag.tag;
      aTagsNode.appendChild(tagNode);
    }
  }

  /**
   * Compute the size of the messages in the selection and display it in the
   * element of id "size".
   *
   * @param {nsIMsgDBHdr} aMessages - Messages.
   */
  _computeSize(aMessages) {
    let numBytes = 0;
    for (const msgHdr of aMessages) {
      numBytes += msgHdr.messageSize;
      // XXX do something about news?
    }

    document.getElementById("size").textContent = l10n.formatValueSync(
      aMessages.limited
        ? "messages-total-size-more-than"
        : "messages-total-size",
      {
        numBytes: MailUtils.formatFileSize(numBytes),
      }
    );
  }

  /**
   * Toggle the flagged state of the star button in the multimessage view header
   * only if all messages are currently flagged.
   *
   * @param {boolean} allFlagged
   */
  toggleFlaggedButton(allFlagged) {
    const flagButton = document.getElementById("starMessageButton");
    flagButton.classList.toggle("flagged", allFlagged);
    flagButton.setAttribute("aria-pressed", allFlagged);
  }

  /**
   * Select surviving members using their original physical folder and key.
   *
   * @param {HTMLLIElement} node - The clicked summary row.
   */
  _selectSummaryItem(node) {
    const messages = [];
    for (const state of this._folderStates.values()) {
      let database;
      for (const [key, member] of state.members) {
        if (member.node != node) {
          continue;
        }
        database ??= state.folder.msgDatabase;
        if (database.containsKey(key)) {
          messages.push({
            order: member.order,
            header: database.getMsgHdrForKey(key),
          });
        }
      }
    }
    if (messages.length) {
      messages.sort((left, right) => left.order - right.order);
      this._selectCallback?.(messages.map(member => member.header));
    }
  }

  /**
   * Read current metadata for one selected physical message.
   *
   * @param {nsIMsgDBHdr} header - The current stored header.
   * @returns {object} Read, flagged and tag state.
   */
  _readMetadata(header) {
    return {
      read: header.isRead,
      flagged: header.isFlagged,
      tags: this._getTagsForMsg(header),
    };
  }

  /**
   * Subscribe to metadata changes in one selected physical folder.
   *
   * @param {object} state - The folder and its selected members.
   */
  _startListening(state) {
    const generation = this._generation;
    const contains = header =>
      generation == this._generation &&
      header.folder.URI == state.folder.URI &&
      state.members.has(header.messageKey);
    state.listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
      onHdrFlagsChanged: header => {
        if (contains(header)) {
          this._queueRefresh();
        }
      },
      onHdrPropertyChanged: (header, property, preChange) => {
        if (!preChange && property == "keywords" && contains(header)) {
          this._queueRefresh();
        }
      },
      onHdrDeleted: header => {
        if (contains(header)) {
          state.members.delete(header.messageKey);
          this._queueRefresh();
        }
      },
      onAnnouncerGoingAway: () => this._stopListening(state),
      onHdrAdded() {},
      onParentChanged() {},
      onReadChanged() {},
      onJunkScoreChanged() {},
      onEvent() {},
    };
    state.database = state.folder.msgDatabase;
    state.database.addListener(state.listener);
  }

  /**
   * Release a database subscription without reopening the folder.
   *
   * @param {object} state - The subscribed folder state.
   */
  _stopListening(state) {
    if (state.database) {
      state.database.removeListener(state.listener);
      state.database = null;
      state.listener = null;
    }
  }

  /**
   * Refresh current metadata after the database finishes notifying listeners.
   */
  _queueRefresh() {
    if (this._refreshPending) {
      return;
    }
    this._refreshPending = true;
    const generation = this._generation;
    queueMicrotask(() => {
      if (generation == this._generation) {
        this._refreshPending = false;
        this._refreshMetadata();
      }
    });
  }

  /**
   * Recompute each row from all surviving members, including unchanged ones.
   * Keep the existing rows, snippets and selection callbacks.
   */
  _refreshMetadata() {
    const nodes = new Map(
      [...this._summaryNodes].map(node => [
        node,
        { unread: 0, starred: false, tags: new Map(), count: 0 },
      ])
    );
    let allFlagged = true;
    let count = 0;
    for (const state of this._folderStates.values()) {
      for (const [key, member] of state.members) {
        if (state.database) {
          if (!state.database.containsKey(key)) {
            state.members.delete(key);
            continue;
          }
          Object.assign(
            member,
            this._readMetadata(state.database.getMsgHdrForKey(key))
          );
        }
        const flags = nodes.get(member.node);
        flags.count++;
        flags.unread += !member.read;
        flags.starred ||= member.flagged;
        for (const tag of member.tags) {
          flags.tags.set(tag.key, tag);
        }
        allFlagged &&= member.flagged;
        count++;
      }
    }

    for (const [node, flags] of nodes) {
      node.classList.toggle("unread", flags.unread > 0);
      node.classList.toggle("starred", flags.starred);
      const tagsNode = node.querySelector(".tags");
      tagsNode.replaceChildren();
      this._addTagNodes(flags.tags.values(), tagsNode);
      const countNode = node.querySelector(".count");
      if (countNode) {
        let text = "";
        if (flags.count > 1) {
          text = l10n.formatValueSync("num-messages", { count: flags.count });
          if (flags.unread) {
            text += l10n.formatValueSync("num-unread", { count: flags.unread });
          }
        }
        countNode.textContent = text;
      }
    }
    this.toggleFlaggedButton(count > 0 && allFlagged);
  }
}

/**
 * A summarizer to use for a single thread.
 */
class ThreadSummarizer {
  /**
   * The maximum number of messages to summarize.
   */
  kMaxSummarizedMessages = 100;

  /**
   * The length of message snippets.
   */
  kSnippetLength = 300;

  /**
   * @returns {string} returns a canonical name for this summarizer.
   */
  get name() {
    return "thread";
  }

  /**
   * A function to be called once the summarizer has been registered with the
   * main summary object.
   *
   * @param {MultiMessageSummary} aContext - The MultiMessageSummary object holding this summarizer.
   */
  onregistered(aContext) {
    this.context = aContext;
  }

  /**
   * Summarize a list of messages.
   *
   * @param {nsIMsgDBHdr[]} aMessages - The messages to summarize.
   * @returns {nsIMsgDBHdr[]} an array of the messages actually summarized.
   */
  summarize(aMessages) {
    const messageList = document.getElementById("messageList");

    // Remove all ignored messages from summarization.
    const summarizedMessages = [];
    for (const message of aMessages) {
      if (!message.isKilled) {
        summarizedMessages.push(message);
      }
    }
    const ignoredCount = aMessages.trueLength - summarizedMessages.length;

    // Summarize the selected messages.
    let subject = null;
    let maxCountExceeded = false;
    for (const [i, msgHdr] of summarizedMessages.entries()) {
      if (i == this.kMaxSummarizedMessages) {
        summarizedMessages.length = i;
        maxCountExceeded = true;
        break;
      }

      if (subject == null) {
        subject = msgHdr.mime2DecodedSubject;
      }

      const msgNode = this.context.makeSummaryItem([msgHdr], {
        snippetLength: this.kSnippetLength,
        belongsToThread: true,
      });
      messageList.appendChild(msgNode);

      this.context.mapMsgToNode(msgHdr, msgNode);
    }

    gMessageSummary.toggleFlaggedButton(
      summarizedMessages.every(message => message.isFlagged)
    );

    // Set the heading based on the subject and number of messages.
    let countInfo = l10n.formatValueSync("num-messages", {
      count: aMessages.length,
    });
    if (ignoredCount != 0) {
      countInfo += l10n.formatValueSync(
        aMessages.limited ? "at-least-num-ignored" : "num-ignored",
        { count: ignoredCount }
      );
    }

    this.context.setHeading(
      subject || l10n.formatValueSync("no-subject"),
      countInfo
    );

    if (maxCountExceeded) {
      this.context.showNotice(
        l10n.formatValueSync("max-count-exceeded", {
          total: aMessages.trueLength,
          shown: this.kMaxSummarizedMessages,
        })
      );
    }
    return summarizedMessages;
  }
}

/**
 * A summarizer to use when multiple threads are selected.
 */
class MultipleSelectionSummarizer {
  /**
   * The maximum number of threads to summarize.
   */
  kMaxSummarizedThreads = 100;

  /**
   * The length of message snippets.
   */
  kSnippetLength = 300;

  /**
   * Returns a canonical name for this summarizer.
   */
  get name() {
    return "multipleselection";
  }

  /**
   * A function to be called once the summarizer has been registered with the
   * main summary object.
   *
   * @param {MultiMessageSummary} aContext - The MultiMessageSummary object
   *   holding this summarizer.
   */
  onregistered(aContext) {
    this.context = aContext;
  }

  /**
   * Summarize a list of messages.
   *
   * @param {nsIMsgDBHdr[]} aMessages - The messages to summarize.
   */
  summarize(aMessages, aDBView) {
    const messageList = document.getElementById("messageList");

    const threads = this._buildThreads(aMessages, aDBView);
    const threadsCount = threads.length;

    // Set the heading based on the number of messages & threads.
    this.context.setHeading(
      l10n.formatValueSync(
        aMessages.limited ? "at-least-num-conversations" : "num-conversations",
        { count: threads.length }
      )
    );

    // Summarize the selected messages by thread.
    let maxCountExceeded = false;
    for (const [i, msgs] of threads.entries()) {
      if (i == this.kMaxSummarizedThreads) {
        threads.length = i;
        maxCountExceeded = true;
        break;
      }

      const msgNode = this.context.makeSummaryItem(msgs, {
        showSubject: true,
        snippetLength: this.kSnippetLength,
        belongsToThread: false,
      });
      messageList.appendChild(msgNode);

      for (const msgHdr of msgs) {
        this.context.mapMsgToNode(msgHdr, msgNode);
      }
    }

    if (maxCountExceeded) {
      this.context.showNotice(
        l10n.formatValueSync("max-thread-count-exceeded", {
          total: threadsCount,
          shown: this.kMaxSummarizedThreads,
        })
      );

      // Return only the messages for the threads we're actually showing. We
      // need to collapse our array-of-arrays into a flat array.
      return threads.reduce(function (accum, curr) {
        accum.push(...curr);
        return accum;
      }, []);
    }

    gMessageSummary.toggleFlaggedButton(
      [...aMessages].every(message => message.isFlagged)
    );

    // Return everything, since we're showing all the threads. Don't forget to
    // turn it into an array, though!
    return [...aMessages];
  }

  /**
   * Group all the messages to be summarized into threads.
   *
   * @param {nsIMsgDBHdr[]} aMessages The messages to group.
   * @returns {nsIMsgDBHdr[]} An array of arrays of messages, grouped by thread.
   */
  _buildThreads(aMessages, aDBView) {
    // First, we group the messages in threads and count the threads.
    const threads = [];
    const threadMap = {};
    for (const msgHdr of aMessages) {
      const viewThreadId = aDBView.getThreadContainingMsgHdr(msgHdr).threadKey;
      if (!(viewThreadId in threadMap)) {
        threadMap[viewThreadId] = threads.length;
        threads.push([msgHdr]);
      } else {
        threads[threadMap[viewThreadId]].push(msgHdr);
      }
    }
    return threads;
  }
}

var gMessageSummary = new MultiMessageSummary();
gMessageSummary.registerSummarizer(new ThreadSummarizer());
gMessageSummary.registerSummarizer(new MultipleSelectionSummarizer());

/**
 * Roving tab navigation for the header buttons.
 */
const headerToolbarNavigation = {
  /**
   * If the roving tab has already been loaded.
   *
   * @type {boolean}
   */
  isLoaded: false,
  /**
   * Get all currently clickable buttons of the message header toolbar.
   *
   * @returns {Array} An array of buttons.
   */
  get headerButtons() {
    return this.headerToolbar.querySelectorAll(
      `toolbarbutton:not([hidden],[disabled])`
    );
  },

  init() {
    // Bail out if we already initialized this.
    if (this.isLoaded) {
      return;
    }
    this.headerToolbar = document.getElementById("header-view-toolbar");
    this.headerToolbar.addEventListener("keypress", event => {
      this.triggerMessageHeaderRovingTab(event);
    });
    this.isLoaded = true;
  },

  /**
   * Update the `tabindex` attribute of the currently clickable buttons.
   */
  updateRovingTab() {
    for (const button of this.headerButtons) {
      button.tabIndex = -1;
    }
    // Allow focus on the first available button.
    // We use `setAttribute` to guarantee compatibility with XUL toolbarbuttons.
    this.headerButtons[0].setAttribute("tabindex", "0");
  },

  /**
   * Handles the keypress event on the message header toolbar.
   *
   * @param {Event} event - The keypress DOMEvent.
   */
  triggerMessageHeaderRovingTab(event) {
    // Expected keyboard actions are Left, Right, Home, End, Space, and Enter.
    if (!["ArrowRight", "ArrowLeft", " ", "Enter"].includes(event.key)) {
      return;
    }

    const headerButtons = [...this.headerButtons];
    const focusableButton = headerButtons.find(b => b.tabIndex != -1);
    let elementIndex = headerButtons.indexOf(focusableButton);

    // TODO: Remove once the buttons are updated to not be XUL
    // NOTE: Normally a button click handler would cover Enter and Space key
    // events. However, we need to prevent the default behavior and explicitly
    // trigger the button click because the XUL toolbarbuttons do not work when
    // the Enter key is pressed. They do work when the Space key is pressed.
    // However, if the toolbarbutton is a dropdown menu, the Space key
    // does not open the menu.
    if (
      event.key == "Enter" ||
      (event.key == " " && event.target.hasAttribute("type"))
    ) {
      event.preventDefault();
      event.target.click();
      return;
    }

    // Find the adjacent focusable element based on the pressed key.
    const isRTL = document.dir == "rtl";
    if (
      (isRTL && event.key == "ArrowLeft") ||
      (!isRTL && event.key == "ArrowRight")
    ) {
      elementIndex++;
      if (elementIndex > headerButtons.length - 1) {
        elementIndex = 0;
      }
    } else if (
      (!isRTL && event.key == "ArrowLeft") ||
      (isRTL && event.key == "ArrowRight")
    ) {
      elementIndex--;
      if (elementIndex == -1) {
        elementIndex = headerButtons.length - 1;
      }
    }

    // Move the focus to a new toolbar button and update the tabindex attribute.
    const newFocusableButton = headerButtons[elementIndex];
    if (newFocusableButton) {
      focusableButton.tabIndex = -1;
      newFocusableButton.setAttribute("tabindex", "0");
      newFocusableButton.focus();
    }
  },
};
