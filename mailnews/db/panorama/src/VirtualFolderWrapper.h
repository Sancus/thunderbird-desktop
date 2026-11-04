/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_DB_PANORAMA_SRC_VIRTUALFOLDERWRAPPER_H_
#define COMM_MAILNEWS_DB_PANORAMA_SRC_VIRTUALFOLDERWRAPPER_H_

#include "nsIVirtualFolderWrapper.h"
#include "mozIStorageConnection.h"

#include "DatabaseCore.h"
#include "FolderDatabase.h"
#include "mozilla/Components.h"
#include "nsCOMPtr.h"
#include "nsIFactory.h"
#include "nsIMsgFolder.h"

namespace mozilla::mailnews {

class SavedSearchBindings;
class MessageDatabase;

class VirtualFolderWrapper : public nsIVirtualFolderWrapper {
 public:
  VirtualFolderWrapper();
  explicit VirtualFolderWrapper(uint64_t folderId);

  NS_DECL_ISUPPORTS
  NS_DECL_NSIVIRTUALFOLDERWRAPPER

  nsTArray<uint64_t> GetSearchFolderIds();

 private:
  friend class SavedSearchBindings;
  static mozIStorageConnection* CurrentConnection();
  static MessageDatabase* CurrentMessages();
  static nsresult CurrentSource(nsACString& source);
  static nsresult SavedFolderIds(nsTArray<uint64_t>& ids,
                                 nsTArray<uint64_t>& current);
  nsresult CheckCurrent(bool refresh = true);
  nsresult RetireMissingSources(const nsTArray<uint64_t>& current,
                                bool& changed);

 protected:
  virtual ~VirtualFolderWrapper() {};

  FolderDatabase& FolderDB() const {
    return *DatabaseCore::sInstance->mFolderDatabase;
  }

  nsCOMPtr<nsIMsgFolder> mMsgFolder;
  uint64_t mVirtualFolderId = 0;
  nsCOMPtr<mozIStorageConnection> mConnection;
  nsCString mSource;
  nsresult mSourceResult = NS_ERROR_NOT_AVAILABLE;
};

class VirtualFolderWrapperFactory final : public nsIFactory {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIFACTORY
  VirtualFolderWrapperFactory();

 private:
  ~VirtualFolderWrapperFactory();
  RefPtr<SavedSearchBindings> mBindings;
};

}  // namespace mozilla::mailnews

#endif  // COMM_MAILNEWS_DB_PANORAMA_SRC_VIRTUALFOLDERWRAPPER_H_
