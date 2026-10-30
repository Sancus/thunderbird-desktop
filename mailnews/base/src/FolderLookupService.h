/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef COMM_MAILNEWS_BASE_SRC_FOLDERLOOKUPSERVICE_H_
#define COMM_MAILNEWS_BASE_SRC_FOLDERLOOKUPSERVICE_H_

#include "nsIFolderLookupService.h"
#include "nsIMsgFolder.h"
#include "nsIWeakReferenceUtils.h"
#include "nsTHashMap.h"

#define NATIVE_FOLDER_LOOKUP_IID \
  {0x205b4186, 0x5a21, 0x4f49, {0xb9, 0x81, 0x52, 0xb1, 0x76, 0x78, 0x6e, 0x02}}

class FolderLookupService final : public nsIFolderLookupService {
 public:
  NS_INLINE_DECL_STATIC_IID(NATIVE_FOLDER_LOOKUP_IID)
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIFOLDERLOOKUPSERVICE

  FolderLookupService() = default;
  FolderLookupService(const FolderLookupService&) = delete;
  FolderLookupService& operator=(const FolderLookupService&) = delete;

 protected:
  virtual ~FolderLookupService() = default;

 private:
  friend class nsMsgDBFolder;
  uint64_t mCacheGeneration{0};
  /**
   * Internal helper to find a folder (which may or may not be dangling).
   * Will return `nullptr` if the folder does not exist, and will only
   * fail on invalid input arguments.
   */
  nsCOMPtr<nsIMsgFolder> GetExisting(const nsACString& url);
  /**
   * Internal helper to create a new folder given a URL and place it
   * in the cache. The newly created folder will be dangling and
   * needs to be parented by a calling function.
   */
  nsresult CreateDangling(const nsACString& url, nsIMsgFolder** folder);

  nsTHashMap<nsCString, nsWeakPtr> mFolderCache;
};

#endif  // COMM_MAILNEWS_BASE_SRC_FOLDERLOOKUPSERVICE_H_
