/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * @returns {nsIFolderDatabase} Current native folder database.
 */
function folderDatabase() {
  return Cc["@mozilla.org/mailnews/database-core;1"].getService(
    Ci.nsIDatabaseCore
  ).folderDB;
}

/** MIME streaming must not expose decrypted content to the search index. */
export const MAIL_SEARCH_MIME_OPTIONS = Object.freeze({
  saneBodySize: true,
  examineEncryptedParts: false,
});

/**
 * Returns the existing folder preference or its flag-based indexing priority.
 *
 * @param {nsIMsgFolder} folder - Physical mail folder.
 * @param {boolean} [allowSpecialFolderIndexing=false] - Include Trash/Junk by default.
 * @returns {number} Priority, or -1 for excluded folders.
 */
export function getFolderIndexingPriority(
  folder,
  allowSpecialFolderIndexing = false
) {
  let priority = NaN;
  try {
    priority = parseInt(folder.getStringProperty("indexingPriority"));
  } catch {}
  if (!Number.isNaN(priority)) {
    return priority;
  }
  const folders = folderDatabase();
  for (let id = folder.id; id; id = folders.getFolderParent(id)) {
    if (
      folders.getFolderFlags(id) &
      (Ci.nsMsgFolderFlags.Trash | Ci.nsMsgFolderFlags.Junk)
    ) {
      return allowSpecialFolderIndexing ? 20 : -1;
    }
  }
  const flags = folders.getFolderFlags(folder.id);
  if (flags & (Ci.nsMsgFolderFlags.Queue | Ci.nsMsgFolderFlags.Newsgroup)) {
    return -1;
  }
  if (flags & Ci.nsMsgFolderFlags.Inbox) {
    return 50;
  }
  if (flags & Ci.nsMsgFolderFlags.SentMail) {
    return 60;
  }
  if (flags & Ci.nsMsgFolderFlags.Favorite) {
    return 40;
  }
  return flags & Ci.nsMsgFolderFlags.CheckNew ? 30 : 20;
}

/**
 * Checks the current global preference, folder exclusion and junk policy.
 * Row existence and physical identity must be checked by the caller's resolver.
 * This does not grant permission to index encrypted MIME parts.
 *
 * @param {nsIMsgDBHdr} header - Current physical message header.
 * @returns {{eligible: boolean, reason: string, priority: number}} Current policy.
 */
export function getMailSearchPolicy(header) {
  if (
    !Services.prefs.getBoolPref(
      "mailnews.database.global.indexer.enabled",
      false
    )
  ) {
    return { eligible: false, reason: "disabled", priority: -1 };
  }
  const folder = header.folder;
  if (!folder) {
    return { eligible: false, reason: "folder", priority: -1 };
  }
  // nsIMsgFolder can retain cached flags after a native folder update.
  const flags = folderDatabase().getFolderFlags(folder.id);
  if (
    !(flags & Ci.nsMsgFolderFlags.Mail) ||
    flags & Ci.nsMsgFolderFlags.Virtual
  ) {
    return { eligible: false, reason: "folder", priority: -1 };
  }
  const priority = getFolderIndexingPriority(folder);
  if (priority == -1) {
    return { eligible: false, reason: "excluded", priority };
  }
  if (header.flags & Ci.nsMsgMessageFlags.Expunged) {
    return { eligible: false, reason: "deleted", priority };
  }
  if (
    header.getStringProperty("junkscore") ==
    Ci.nsIJunkMailPlugin.IS_SPAM_SCORE.toString()
  ) {
    return { eligible: false, reason: "junk", priority };
  }
  return { eligible: true, reason: "eligible", priority };
}

/**
 * Retrieves a fresh header only when its current physical folder owns the key.
 * A header wrapper or Message-ID does not establish membership.
 *
 * @param {{folder: ?nsIMsgFolder, location: ?{folderId: number, messageKey: number}}} state -
 *   Folder and location from the authoritative identity resolver.
 * @returns {?nsIMsgDBHdr} Current physical header, or null for a stale location.
 */
export function getMailSearchHeader({ folder, location }) {
  if (
    !folder ||
    !location ||
    !Number.isSafeInteger(location.folderId) ||
    location.folderId <= 0 ||
    !Number.isSafeInteger(location.messageKey) ||
    location.messageKey < 0 ||
    location.messageKey > 0xffffffff ||
    folder.id != location.folderId
  ) {
    return null;
  }
  const db = folder.msgDatabase;
  if (!db.containsKey(location.messageKey)) {
    return null;
  }
  const header = db.getMsgHdrForKey(location.messageKey);
  return header?.folder?.id == location.folderId &&
    header.messageKey == location.messageKey
    ? header
    : null;
}
