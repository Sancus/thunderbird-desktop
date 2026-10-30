/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_LOCAL_SRC_NSMSGLOCALSTOREUTILS_H_
#define COMM_MAILNEWS_LOCAL_SRC_NSMSGLOCALSTOREUTILS_H_

#include "nsCOMPtr.h"
#include "nsIDirectoryEnumerator.h"
#include "nsIFile.h"
#include "nsString.h"
#include "nsTArray.h"

class nsIRandomAccessStream;

/**
 * Utility Class for handling local mail stores. Berkeley Mailbox
 * and MailDir stores inherit from this class to share some code.
 */

class nsMsgLocalStoreUtils {
 public:
  static bool nsShouldIgnoreFile(nsIFile* path);

 protected:
  nsMsgLocalStoreUtils();

  static nsresult AddDirectorySeparator(nsIFile* path);
  static nsresult ChangeKeywordsHelper(
      nsIRandomAccessStream* seekable, nsTArray<nsCString> const& keywordsToAdd,
      nsTArray<nsCString> const& keywordsToRemove, bool& notEnoughSpace);

  bool DiskSpaceAvailableInStore(nsIFile* aFile, uint64_t aSpaceRequested);

  /**
   * Details about the location of the X-Mozilla-Status/Status2 headers
   * within a message. Points at the value parts of those headers within
   * the message, the parts which can safely edited in-place.
   */
  struct StatusDetails {
    // Extent of X-Mozilla-Status value.
    int64_t statusValOffset{-1};  // Relative to msgStart (-1 = not found).
    uint32_t statusValSize{0};    // Size of value (not including EOL).
    // Extent of X-Mozilla-Status2 value.
    int64_t status2ValOffset{-1};  // Relative to msgStart (-1 = not found).
    uint32_t status2ValSize{0};    // Size of value (not including EOL).
    // The message flags parsed out of the header values.
    uint32_t msgFlags{0};
  };

  /**
   * Find the X-Mozilla-Status and X-Mozilla-Status2 headers in a message.
   *
   * @param stream - A stream containing the message.
   * @param msgStart - The offset of the message start within the stream.
   *                   For mbox with will be the "From " line (which will
   *                   be ignored), for maildir it'll be 0 (as each message
   *                   is stored verbatim in separate files).
   * @returns a struct detailing the location of the headers.
   *
   * If any error occurs, an empty struct will be returned (the same as if
   * no X-Mozilla-Status headers were found).
   */
  static StatusDetails FindXMozillaStatusHeaders(nsIRandomAccessStream* stream,
                                                 int64_t msgStart);
  /**
   * Write newFlags back into the message X-Mozilla-Status headers.
   * It will only write changed data (newFlags is checked against
   * details.msgFlags).
   *
   * @param stream - The stream containing the message.
   * @param msgStart - Offset of the message start within the stream.
   * @param details - The locations of the editable values.
   * @param newFlags - The Flags to write into the X-Mozilla-Status headers.
   */
  static nsresult PatchXMozillaStatusHeaders(nsIRandomAccessStream* stream,
                                             int64_t msgStart,
                                             StatusDetails const& details,
                                             uint32_t newFlags);
};

#ifdef MOZ_PANORAMA
namespace mozilla::mailnews {

/**
 * Move existing body, summary and child storage without changing folder rows.
 * Callers exclude concurrent store use and close their handles before Apply().
 * Missing parts are allowed for folders without an offline cache. Local folder
 * callers must separately require their body store to exist.
 *
 * Prepare() checks all paths without changing files. Apply() uses same-volume
 * RenameTo(), never a copy/delete fallback. On failure it restores earlier
 * moves and returns the original error; RollbackStatus() exposes a restoration
 * error. After a known metadata failure the caller explicitly calls Rollback().
 * Neither destruction nor a metadata error deletes files or retries Finish.
 * This does not make filesystem changes and database commits atomic.
 */
class FolderStorageMove final {
 public:
  FolderStorageMove() = default;
  FolderStorageMove(const FolderStorageMove&) = delete;
  FolderStorageMove& operator=(const FolderStorageMove&) = delete;

  nsresult Prepare(nsIFile* source, nsIFile* destination);
  nsresult Apply();
  nsresult Rollback();
  nsresult RollbackStatus() const { return mRollbackStatus; }
  bool HasPendingMoves() const;

 private:
  struct Move {
    nsCOMPtr<nsIFile> source;
    nsCOMPtr<nsIFile> destination;
    bool moved{false};
  };

  static nsresult Rename(nsIFile* source, nsIFile* destination);
  nsTArray<Move> mMoves;
  bool mPrepared{false};
  bool mAttempted{false};
  nsresult mRollbackStatus{NS_OK};
};

}  // namespace mozilla::mailnews
#endif

#endif  // COMM_MAILNEWS_LOCAL_SRC_NSMSGLOCALSTOREUTILS_H_
