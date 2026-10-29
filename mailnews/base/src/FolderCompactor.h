/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_BASE_SRC_FOLDERCOMPACTOR_H_
#define COMM_MAILNEWS_BASE_SRC_FOLDERCOMPACTOR_H_

#include "nsTArray.h"
#include "nsISupports.h"
#include "mozilla/RefPtr.h"

class nsIFile;
class nsIMsgFolder;
class nsIMsgWindow;
class nsIUrlListener;
enum class nsresult : uint32_t;

// Private mbox/folder handshake; not a scriptable store callback.
#define NS_IMBOXCOMPACTIONCOMMIT_IID \
  {0x9bf4d761, 0xaaf9, 0x4777, {0x8f, 0xbc, 0x6c, 0x19, 0x7a, 0xab, 0xa5, 0x71}}

class nsIMboxCompactionCommit : public nsISupports {
 public:
  NS_INLINE_DECL_STATIC_IID(NS_IMBOXCOMPACTIONCOMMIT_IID)
  virtual bool RequiresBodyRelocation() const = 0;
  // Before the original body is renamed. The completed new body still exists.
  NS_IMETHOD PrepareBodyRelocation(nsIFile* original, nsIFile* compacted,
                                   nsIFile* backup) = 0;
  // After checked installation, before the original backup may be deleted.
  NS_IMETHOD CompleteBodyRelocation() = 0;
  // After a known failed first atomic rename, while original bytes are intact.
  NS_IMETHOD AbandonBodyRelocation() = 0;
};

/**
 * Perform compaction on the given folders.
 * Compaction means removing deleted messages from the msgStore and
 * updating the retained messages in the database with new storeTokens
 * (and sizes).
 *
 * - Progress/status updates will be communicated to the GUI window.
 * - When the operation completes, listener.onStopRunningUrl() will be called.
 * - listener.onStartRunningUrl() is never called.
 * - The operation is considered complete when all the folders have been
 *   compacted.
 * - It's safe to call this with an empty list of folders. The listener
 *   will still be called.
 * - The listener will _never_ be called before AsyncCompactFolders()
 *   returns.
 * - If AsyncCompactFolders() returns a failure code, no listener callbacks
 *   will be invoked.
 * - Failed compaction retains its originals or recovery files. Panorama may
 *   require checked recovery before new body access resumes. Successfully
 *   compacted folders stay compacted.
 *
 * This routine DOES NOT perform an expunge for IMAP folders, or attempt to
 * rebuild missing/out-of-date databases for local folders.
 * Previous compaction code did attempt to handle this, but it was
 * inconsistent and got very confusing. The folder-specific implementations
 * (e.g. nsImapMailFolder::Compact()) deal with that stuff _before_ calling
 * AsyncCompactFolders().
 *
 * @param folders  - The folders to compact.
 * @param listener - Callback to invoke when operation is complete.
 *                   The request param will be nullptr, and the status param
 *                   indicates the success or failure of the operation.
 */
nsresult AsyncCompactFolders(nsTArray<RefPtr<nsIMsgFolder>> const& folders,
                             nsIUrlListener* listener, nsIMsgWindow* window);

#endif  // COMM_MAILNEWS_BASE_SRC_FOLDERCOMPACTOR_H_
