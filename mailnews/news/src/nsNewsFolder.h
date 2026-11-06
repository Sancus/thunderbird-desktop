/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
   Interface for representing News folders.
*/

#ifndef COMM_MAILNEWS_NEWS_SRC_NSNEWSFOLDER_H_
#define COMM_MAILNEWS_NEWS_SRC_NSNEWSFOLDER_H_

#include "nsMsgDBFolder.h"
#include "nsIFile.h"
#include "nsMsgKeySet.h"
#include "nsIMsgNewsFolder.h"
#include "nsCOMPtr.h"
#include "nsIMsgFilterList.h"
#ifdef MOZ_PANORAMA
#  include "mozilla/Maybe.h"
#endif

class nsINewsDatabase;

#ifdef MOZ_PANORAMA
#  define NS_MSG_NEWS_FOLDER_IID \
    {0xf5381803,                 \
     0x376a,                     \
     0x49ba,                     \
     {0x8c, 0xc4, 0xe7, 0x8f, 0x80, 0x7c, 0x95, 0xae}}
#endif

class nsMsgNewsFolder : public nsMsgDBFolder, public nsIMsgNewsFolder {
 public:
  nsMsgNewsFolder(void);
#ifdef MOZ_PANORAMA
  // Concrete QI is internal to the registered native news factory caller.
  NS_INLINE_DECL_STATIC_IID(NS_MSG_NEWS_FOLDER_IID)
#endif

  NS_DECL_ISUPPORTS_INHERITED
  NS_DECL_NSIMSGNEWSFOLDER

  // nsIMsgFolder methods:
  NS_IMETHOD GetMsgDatabase(nsIMsgDatabase** database) override;
  NS_IMETHOD SetMsgDatabase(nsIMsgDatabase* database) override;

  NS_IMETHOD GetSubFolders(nsTArray<RefPtr<nsIMsgFolder>>& folders) override;

  NS_IMETHOD UpdateFolder(nsIMsgWindow* aWindow) override;

  NS_IMETHOD CreateSubfolder(const nsACString& folderName,
                             nsIMsgWindow* msgWindow) override;

  NS_IMETHOD DeleteStorage() override;
  NS_IMETHOD Rename(const nsACString& newName,
                    nsIMsgWindow* msgWindow) override;

  NS_IMETHOD GetAbbreviatedName(nsAString& aAbbreviatedName) override;

  NS_IMETHOD GetExpungedBytesCount(int64_t* count);
  NS_IMETHOD GetDeletable(bool* deletable) override;

  NS_IMETHOD GetSizeOnDisk(int64_t* size) override;

  NS_IMETHOD GetDBFolderInfoAndDB(nsIDBFolderInfo** folderInfo,
                                  nsIMsgDatabase** db) override;

  NS_IMETHOD DeleteMessages(nsTArray<RefPtr<nsIMsgDBHdr>> const& messages,
                            nsIMsgWindow* msgWindow, bool deleteStorage,
                            bool isMove, nsIMsgCopyServiceListener* listener,
                            bool allowUndo) override;
  NS_IMETHOD GetNewMessages(nsIMsgWindow* aWindow,
                            nsIUrlListener* aListener) override;

  NS_IMETHOD GetCanSubscribe(bool* aResult) override;
  NS_IMETHOD GetCanFileMessages(bool* aResult) override;
  NS_IMETHOD GetCanCreateSubfolders(bool* aResult) override;
  NS_IMETHOD GetCanRename(bool* aResult) override;
  NS_IMETHOD GetCanCompact(bool* aResult) override;
  NS_IMETHOD OnReadChanged(nsIDBChangeListener* aInstigator) override;

  NS_IMETHOD DownloadMessagesForOffline(
      nsTArray<RefPtr<nsIMsgDBHdr>> const& messages,
      nsIMsgWindow* window) override;
  NS_IMETHOD DownloadAllForOffline(nsIUrlListener* listener,
                                   nsIMsgWindow* msgWindow) override;

  NS_IMETHOD Shutdown(bool shutdownChildren) override;

  NS_IMETHOD GetFilterList(nsIMsgWindow* aMsgWindow,
                           nsIMsgFilterList** aFilterList) override;
  NS_IMETHOD GetEditableFilterList(nsIMsgWindow* aMsgWindow,
                                   nsIMsgFilterList** aFilterList) override;
  NS_IMETHOD SetFilterList(nsIMsgFilterList* aFilterList) override;
  NS_IMETHOD SetEditableFilterList(nsIMsgFilterList* aFilterList) override;
  NS_IMETHOD ApplyRetentionSettings() override;
  NS_IMETHOD GetIncomingServerType(nsACString& serverType) override;

 protected:
  virtual ~nsMsgNewsFolder();
  // helper routine to parse the URI and update member variables
  nsresult AbbreviatePrettyName(nsAString& prettyName, int32_t fullwords);
  nsresult ParseFolder(nsIFile* path);
  nsresult CreateSubFolders(nsIFile* path);
  nsresult AddDirectorySeparator(nsIFile* path);
  nsresult GetDatabase() override;
  static nsresult CheckMigrationWriterAdmission();

#ifdef MOZ_PANORAMA
  nsresult GetNativeDatabase();
  nsresult StoreNativeNewsArticle(uint32_t articleNumber,
                                  const nsACString& data);
  nsresult InitializeNativeDatabase(nsIMsgDatabase* database);
  void DetachNativeReadSet();
  nsresult ApplyNativeReadRange(int32_t first, int32_t last);
  nsresult SetNativeReadSetFromStr(const nsACString& ranges, bool passive);
  nsresult AddNewsgroupWithFolderId(const nsACString& name,
                                    const nsACString& setStr,
                                    nsIMsgFolder** child, bool passive = false);
#endif

  nsresult LoadNewsrcFileAndCreateNewsgroups();
  int32_t RememberLine(const nsACString& line);
  nsresult RememberUnsubscribedGroup(const nsACString& newsgroup,
                                     const nsACString& setStr);
  nsresult ForgetLine(void);
  nsresult GetNewsMessages(nsIMsgWindow* aMsgWindow, bool getOld,
                           nsIUrlListener* aListener);

  nsresult HandleNewsrcLine(const char* line, uint32_t line_size);
  virtual nsresult CreateBaseMessageURI(const nsACString& aURI) override;

 protected:
  int64_t mExpungedBytes;
  bool mGettingNews;
  bool mInitialized;
  bool m_downloadMessageForOfflineUse;

  RefPtr<nsMsgKeySet> mReadSet;
#ifdef MOZ_PANORAMA
  // Distinguish nested replacement, including replacement with the same facade.
  uint64_t mNativeDatabaseGeneration{0};
  bool mNativeDatabaseInitializing{false};
  bool mNativeDatabaseReadingSummary{false};
  bool mNativeOfflineWriting{false};
  class NativeDownload;
  RefPtr<NativeDownload> mNativeDownload;
  // Binding ownership outlives the optional cached mDatabase reference.
  nsCOMPtr<nsINewsDatabase> mReadSetDatabase;
  // Only a passive file load may restore a known lossy zero companion.
  mozilla::Maybe<nsCString> mPendingNewsrcReadSet;
#endif

  nsCOMPtr<nsIFile> mNewsrcFilePath;

  // used for auth news
  nsCString mGroupUsername;
  nsCString mGroupPassword;

  // the name of the newsgroup.
  nsCString mRawName;

 private:
  nsCOMPtr<nsIMsgFilterList> mFilterList;
};

#endif  // COMM_MAILNEWS_NEWS_SRC_NSNEWSFOLDER_H_
