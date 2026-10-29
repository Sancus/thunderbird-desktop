/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Functions use for junk processing commands
 */

/*
 * globals prerequisites used:
 *
 *   top.window.MsgStatusFeedback
 */

/* globals gDBView, gViewWrapper, VirtualFolderHelper */

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

/**
 * Apply junk actions through each message's physical folder.
 * Skip messages moved, deleted or reclassified before their folder action.
 *
 * @param {nsIMsgDBHdr[]} aJunkMsgHdrs - New junk messages.
 * @param {nsIMsgDBHdr[]} aGoodMsgHdrs - New good messages.
 * @returns {Promise<void>} Resolves after all folder actions complete, or
 *   rejects if a folder action fails.
 */
async function performActionsOnJunkMsgs(aJunkMsgHdrs, aGoodMsgHdrs) {
  const batches = [];
  for (const [messages, isJunk] of [
    [aJunkMsgHdrs, true],
    [aGoodMsgHdrs, false],
  ]) {
    const folders = new Map();
    for (const header of messages) {
      const folder = header.folder;
      if (!folders.has(folder.URI)) {
        folders.set(folder.URI, { folder, messages: [], isJunk });
      }
      folders.get(folder.URI).messages.push({
        key: header.messageKey,
        origin: header.getStringProperty("junkscoreorigin"),
        score: header.getStringProperty("junkscore"),
      });
    }
    batches.push(...folders.values());
  }
  for (const { folder, messages, isJunk } of batches) {
    const db = folder.msgDatabase;
    const headers = messages.flatMap(({ key, origin, score }) => {
      if (!db.containsKey(key)) {
        return [];
      }
      const header = db.getMsgHdrForKey(key);
      return header.getStringProperty("junkscoreorigin") == origin &&
        header.getStringProperty("junkscore") == score
        ? [header]
        : [];
    });
    if (!headers.length) {
      continue;
    }
    await new Promise((resolve, reject) => {
      folder.performActionsOnJunkMsgs(headers, isJunk, top.msgWindow, {
        OnStopRunningUrl(url, status) {
          if (Components.isSuccessCode(status)) {
            resolve();
          } else {
            reject(
              new Error(
                `performActionsOnJunkMsgs failed with status: ${status.toString(16)}`
              )
            );
          }
        },
      });
    });
  }
}

/**
 * Write classification fields while the original message has no user override.
 *
 * @param {{folder: nsIMsgFolder, key: integer}} message - Captured location.
 * @param {Array<[string, string|number]>} properties - Ordered field writes.
 * @returns {boolean} Whether the message remains without a user override.
 */
function setJunkProperties(message, properties) {
  const db = message.folder.msgDatabase;
  const isCurrent = () =>
    db.containsKey(message.key) &&
    db.getMsgHdrForKey(message.key).getStringProperty("junkscoreorigin") !=
      "user";
  for (const [name, value] of properties) {
    if (!isCurrent()) {
      return false;
    }
    db.setStringProperty(message.key, name, value);
  }
  return isCurrent();
}

/**
 * Helper object storing the list of pending messages to process,
 * and implementing junk processing callback.
 *
 * @param {integer} aTotalMessages - Number of messages to process, used for
 *   progress report only.
 */

function MessageClassifier(aTotalMessages) {
  this.mJunkMessages = [];
  this.mGoodMessages = [];
  this.mMessages = {};
  this.mMessageQueue = [];
  this.mTotalMessages = aTotalMessages;
  this.mProcessedMessages = 0;
  this.firstMessage = true;
  this.lastStatusTime = Date.now();
}

/**
 * @implements {nsIJunkMailClassificationListener}
 */
MessageClassifier.prototype = {
  /**
   * Starts the message classification process for a message. If the message
   * sender's address is whitelisted, the message is skipped.
   *
   * @param {nsIMsgDBHdr} aMsgHdr - The header of the message to classify.
   * @param {nsISpamSettings} aSpamSettings - The object with information about
   *   whitelists
   */
  analyzeMessage(aMsgHdr, aSpamSettings) {
    const message = { folder: aMsgHdr.folder, key: aMsgHdr.messageKey };
    if (!message.folder.msgDatabase.containsKey(message.key)) {
      return;
    }
    const origin = aMsgHdr.getStringProperty("junkscoreorigin");
    if (origin == "user") {
      // Don't override user-set junk status.
      return;
    }

    if (aSpamSettings.checkWhiteList(aMsgHdr)) {
      if (
        setJunkProperties(message, [
          ["junkscore", Ci.nsIJunkMailPlugin.IS_HAM_SCORE],
          ["junkscoreorigin", "whitelist"],
        ])
      ) {
        this.mGoodMessages.push({
          ...message,
          origin: "whitelist",
          score: String(Ci.nsIJunkMailPlugin.IS_HAM_SCORE),
        });
      }
      return;
    }

    const messageURI = message.folder.generateMessageURI(message.key);
    if (Object.hasOwn(this.mMessages, messageURI)) {
      return;
    }
    this.mMessages[messageURI] = message;
    if (this.firstMessage) {
      this.firstMessage = false;
      MailServices.junk.classifyMessage(messageURI, top.msgWindow, this);
    } else {
      this.mMessageQueue.push(messageURI);
    }
  },

  /**
   * Callback function from nsIJunkMailPlugin with classification results.
   *
   * @param {string} aClassifiedMsgURI - URI of classified message.
   * @param {integer} aClassification - Junk classification (0: UNCLASSIFIED, 1: GOOD, 2: JUNK)
   * @param {integer} aJunkPercent - 0 - 100 indicator of junk likelihood,
   *   with 100 meaning probably junk.
   * @see {nsIJunkMailClassificationListener}
   */
  async onMessageClassified(aClassifiedMsgURI, aClassification, aJunkPercent) {
    if (
      !aClassifiedMsgURI ||
      !Object.hasOwn(this.mMessages, aClassifiedMsgURI)
    ) {
      return;
    }
    const message = this.mMessages[aClassifiedMsgURI];
    delete this.mMessages[aClassifiedMsgURI];
    const score =
      aClassification == Ci.nsIJunkMailPlugin.JUNK
        ? Ci.nsIJunkMailPlugin.IS_SPAM_SCORE
        : Ci.nsIJunkMailPlugin.IS_HAM_SCORE;
    const statusDisplayInterval = 1000; // milliseconds between status updates

    if (
      setJunkProperties(message, [
        ["junkscore", score],
        ["junkscoreorigin", "plugin"],
        ["junkpercent", aJunkPercent],
      ])
    ) {
      if (aClassification == Ci.nsIJunkMailPlugin.JUNK) {
        this.mJunkMessages.push({
          ...message,
          origin: "plugin",
          score: String(score),
        });
      } else if (aClassification == Ci.nsIJunkMailPlugin.GOOD) {
        this.mGoodMessages.push({
          ...message,
          origin: "plugin",
          score: String(score),
        });
      }
    }

    if (this.mMessageQueue.length) {
      ++this.mProcessedMessages;
      if (Date.now() > this.lastStatusTime + statusDisplayInterval) {
        this.lastStatusTime = Date.now();
        const percentage = this.mTotalMessages
          ? this.mProcessedMessages / this.mTotalMessages
          : 0;
        const status = await document.l10n.formatValue(
          "spam-analysis-percentage",
          {
            percentage,
          }
        );
        MailServices.feedback.reportStatus(status);
      }
    }
    let nextMsgURI = this.mMessageQueue.shift();
    while (nextMsgURI) {
      const nextMessage = this.mMessages[nextMsgURI];
      if (nextMessage?.folder.msgDatabase.containsKey(nextMessage.key)) {
        break;
      }
      delete this.mMessages[nextMsgURI];
      nextMsgURI = this.mMessageQueue.shift();
    }
    if (nextMsgURI) {
      MailServices.junk.classifyMessage(nextMsgURI, top.msgWindow, this);
    } else {
      const status = await document.l10n.formatValue("spam-processing-message");
      MailServices.feedback.reportStatus(status);
      await this.performActions();
      // This notification only exists for tests.
      Services.obs.notifyObservers(null, "message-classification-complete");
      setTimeout(() => {
        MailServices.feedback.reportStatus("");
      }, 500);
    }
  },

  /**
   * Apply actions to messages with the captured location and classification.
   *
   * @returns {Promise<void>} Resolves after the surviving messages' actions.
   */
  async performActions() {
    const currentHeaders = messages =>
      messages.flatMap(({ folder, key, origin, score }) => {
        const db = folder.msgDatabase;
        if (!db.containsKey(key)) {
          return [];
        }
        const header = db.getMsgHdrForKey(key);
        return header.getStringProperty("junkscoreorigin") == origin &&
          header.getStringProperty("junkscore") == score
          ? [header]
          : [];
      });
    await performActionsOnJunkMsgs(
      currentHeaders(this.mJunkMessages),
      currentHeaders(this.mGoodMessages)
    );
  },
};

/**
 * Filter all messages in the current folder for junk
 */
async function filterFolderForJunk() {
  await processFolderForJunk(true);
}

/**
 * Filter selected messages in the current folder for junk
 */
async function analyzeMessagesForJunk() {
  await processFolderForJunk(false);
}

/**
 * Filter messages in the current folder for junk
 *
 * @param {boolean} aAll - true to filter all messages, else filter selection.
 */
async function processFolderForJunk(aAll) {
  let indices;
  if (aAll) {
    // need to expand all threads, so we analyze everything
    gDBView.doCommand(Ci.nsMsgViewCommandType.expandAll);
    var treeView = gDBView.QueryInterface(Ci.nsITreeView);
    var count = treeView.rowCount;
    if (!count) {
      return;
    }
  } else {
    indices =
      AppConstants.MOZ_APP_NAME == "seamonkey"
        ? window.GetSelectedIndices(gDBView)
        : window.threadTree?.selectedIndices;
    if (!indices || !indices.length) {
      return;
    }
  }
  const totalMessages = aAll ? count : indices.length;

  const messages = [];
  for (let i = 0; i < totalMessages; i++) {
    const index = aAll ? i : indices[i];
    try {
      const msgURI = gDBView.getURIForViewIndex(index);
      if (!msgURI) {
        continue;
      }
      const header =
        MailServices.messageServiceFromURI(msgURI).messageURIToMsgHdr(msgURI);
      messages.push({ folder: header.folder, key: header.messageKey });
    } catch (ex) {
      // Dummy headers do not identify physical messages.
    }
  }
  const msgClassifier = new MessageClassifier(totalMessages);
  for (const { folder, key } of messages) {
    const db = folder.msgDatabase;
    if (db.containsKey(key)) {
      msgClassifier.analyzeMessage(
        db.getMsgHdrForKey(key),
        folder.server.spamSettings
      );
    }
  }
  if (msgClassifier.firstMessage) {
    // The async plugin was not used, maybe all messages were whitelisted.
    await msgClassifier.performActions();
  }
}

/**
 * Delete junk messages in the current folder. This provides the guarantee that
 * the method will be synchronous if no messages are deleted.
 *
 * @param {nsIMsgFolder} folder
 * @returns {integer} The number of messages deleted.
 */
function deleteJunkInFolder(folder) {
  // use direct folder commands if possible so we don't mess with the selection
  if (folder.getFlag(Ci.nsMsgFolderFlags.Virtual)) {
    const virtualFolder = VirtualFolderHelper.wrapVirtualFolder(folder);

    let count = 0;
    for (const searchFolder of virtualFolder.searchFolders) {
      count += deleteJunkInFolder(searchFolder);
    }

    return count;
  }

  const junkMsgHdrs = [];
  for (const msgHdr of folder.messages) {
    const junkScore = msgHdr.getStringProperty("junkscore");
    if (junkScore == Ci.nsIJunkMailPlugin.IS_SPAM_SCORE) {
      junkMsgHdrs.push(msgHdr);
    }
  }

  if (junkMsgHdrs.length) {
    folder.deleteMessages(junkMsgHdrs, top.msgWindow, false, false, null, true);
  }
  return junkMsgHdrs.length;
}
