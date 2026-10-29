/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_DB_PANORAMA_SRC_PERFOLDERDATABASE_H_
#define COMM_MAILNEWS_DB_PANORAMA_SRC_PERFOLDERDATABASE_H_

#include "DatabaseCore.h"
#include "FolderDatabase.h"
#include "MessageDatabase.h"
#include "mozilla/RefPtr.h"
#include "mozilla/WeakPtr.h"
#include "nsCOMPtr.h"
#include "nsIDBChangeListener.h"
#include "nsIDBFolderInfo.h"
#include "nsIMsgDatabase.h"
#include "nsIMsgFolder.h"
#include "nsIMsgThread.h"
#include "nsMsgEnumerator.h"
#include "prtime.h"

class mozIStorageStatement;
class nsIDBChangeListener;

namespace mozilla::mailnews {

class PerFolderDatabase : public nsIMsgOfflineOpsDatabase,
                          public SupportsWeakPtr,
                          public MessageListener {
 public:
  explicit PerFolderDatabase(uint64_t folderId, bool isNewsFolder)
      : mFolderId(folderId), mIsNewsFolder(isNewsFolder) {
    MessageDB().AddMessageListener(this);
  }

  NS_DECL_ISUPPORTS
  NS_DECL_NSIDBCHANGEANNOUNCER
  NS_DECL_NSIMSGDATABASE
  NS_DECL_NSIMSGOFFLINEOPSDATABASE

  // MessageListener functions.
  void OnMessageAdded(Message* message) override;
  void OnMessagePublished(Message* message, bool notifyLegacy) override;
  void OnMessageThreadChanged(const CapturedMessage& before,
                              const CapturedMessage& after,
                              Message* borrowedLive) override;
  void OnMessageRemoved(Message* message, uint32_t oldFlags) override;
  void OnMessageFlagsChanged(nsIMsgDBHdr* oldMessage, Message* message,
                             uint32_t oldFlags, uint32_t newFlags) override;
  void OnMessageTagsChanged(nsIMsgDBHdr* oldMessage, Message* message,
                            const nsACString& oldTags,
                            const nsACString& newTags) override;

  bool SupportsThreadChanges() const override { return true; }
  void OnMessagePublishedCaptured(const CapturedMessage& after,
                                  Message* message, bool notifyLegacy) override;
  void OnMessageRemovedCaptured(const CapturedMessage& before,
                                Message* message) override;
  void OnMessageFlagsChangedCaptured(const CapturedMessage& before,
                                     const CapturedMessage& after,
                                     nsIMsgDBHdr* oldHeader,
                                     Message* message) override;
  void OnMessageTagsChangedCaptured(const CapturedMessage& before,
                                    const CapturedMessage& after,
                                    nsIMsgDBHdr* oldHeader,
                                    Message* message) override;
  void OnMessageBodyChangedCaptured(const CapturedMessage& before,
                                    const CapturedMessage& after,
                                    nsIMsgDBHdr* oldHeader, Message* message,
                                    const MessageBodyState& oldBody,
                                    const MessageBodyState& newBody) override;

  uint64_t FolderId() { return mFolderId; }

  // Same-key completion from the actual parsed CreateNewHdr draft.
  // Once claimed, a failure seals the draft; caller retains finished bytes.
  nsresult CompletePartialHdr(const MessageBodyState& expected,
                              nsIMsgDBHdr* parsed,
                              const FinishedMessageBody& finished,
                              nsIMsgDBHdr** realHdr);

 private:
  friend class FolderInfo;
  friend class OfflineOperation;

  virtual ~PerFolderDatabase(){};

  FolderDatabase& FolderDB() const {
    return *DatabaseCore::sInstance->mFolderDatabase;
  }
  MessageDatabase& MessageDB() const {
    return *DatabaseCore::sInstance->mMessageDatabase;
  }
  nsresult CheckFolderExists() const;
  nsresult ReadCount(bool unread, int32_t* count);
  nsresult WriteCount(bool unread, int32_t count);
  nsresult ChangeCount(bool unread, int32_t delta);
  void RememberLastUseTime() { mLastUseTime = PR_Now(); }
  nsresult GetMsgHdrForProperty(const nsACString& name,
                                const nsACString& value,
                                nsIMsgDBHdr** result);

  uint64_t mFolderId;
  bool mIsNewsFolder;
  PRTime mLastUseTime = PR_Now();
  bool mForceClosed = false;
  bool mNotifyingGoingAway = false;
  nsTArray<nsMsgKey> mNewList;
  nsTObserverArray<RefPtr<nsIDBChangeListener>> mListeners;
};

class MessageEnumerator : public nsBaseMsgEnumerator {
 public:
  explicit MessageEnumerator(mozIStorageStatement* aStmt);

  // nsIMsgEnumerator support.
  NS_IMETHOD GetNext(nsIMsgDBHdr** aItem) override;
  NS_IMETHOD HasMoreElements(bool* aResult) override;

 private:
  ~MessageEnumerator() = default;

  nsCOMPtr<mozIStorageStatement> mStmt;
  bool mHasNext = false;
};

class ThreadEnumerator : public nsBaseMsgThreadEnumerator {
 public:
  ThreadEnumerator(mozIStorageStatement* stmt, uint64_t folderId);

  // nsIMsgEnumerator support.
  NS_IMETHOD GetNext(nsIMsgThread** item) override;
  NS_IMETHOD HasMoreElements(bool* hasNext) override;

 private:
  ~ThreadEnumerator() = default;

  nsCOMPtr<mozIStorageStatement> mStmt;
  uint64_t mFolderId;
  bool mHasNext = false;
};

class FolderInfo : public nsIDBFolderInfo {
 public:
  explicit FolderInfo(PerFolderDatabase* perFolderDatabase)
      : mPerFolderDatabase(perFolderDatabase),
        mFolderId(perFolderDatabase->FolderId()) {}

  NS_DECL_ISUPPORTS
  NS_DECL_NSIDBFOLDERINFO

 private:
  friend class DeliveryFolderInfoProperties;

  nsresult ReadTransferProperties(nsTArray<FolderImportProperty>& properties);
  static nsresult ValidateTransferProperties(
      const nsTArray<FolderImportProperty>& properties);
  static nsresult EncodeTransferInfo(
      const nsTArray<FolderImportProperty>& properties,
      nsIPropertyBag2** transferInfo);
  static nsresult DecodeTransferInfo(
      nsIPropertyBag2* transferInfo,
      nsTArray<FolderImportProperty>& properties);

  virtual ~FolderInfo() {}

  FolderDatabase& FolderDB() const {
    return *DatabaseCore::sInstance->mFolderDatabase;
  }
  MessageDatabase& MessageDB() const {
    return *DatabaseCore::sInstance->mMessageDatabase;
  }
  RefPtr<PerFolderDatabase> mPerFolderDatabase;
  uint64_t mFolderId;
};

}  // namespace mozilla::mailnews

#endif  // COMM_MAILNEWS_DB_PANORAMA_SRC_PERFOLDERDATABASE_H_
