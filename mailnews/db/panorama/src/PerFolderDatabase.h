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
#include "nsIMsgHdr.h"
#include "nsIMsgThread.h"
#include "nsMsgEnumerator.h"
#include "nsTHashMap.h"
#include "prtime.h"

class mozIStorageStatement;
class nsIDBChangeListener;

namespace mozilla::mailnews {

class OfflineOperationUndo;
struct OfflineUndoCounterpart;
class MessageEnumeratorStatementCloser;

class PerFolderDatabase : public nsIMsgOfflineOpsDatabase,
                          public SupportsWeakPtr,
                          public MessageListener {
 public:
  explicit PerFolderDatabase(uint64_t folderId, bool isNewsFolder);

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

  // Copy metadata without source storage identity into an unpublished draft.
  // Local writes replace messageSize; uncached queued copies may retain it.
  nsresult CopyHdrForStore(nsIMsgDBHdr* existingHdr, bool preserveMessageSize,
                           nsIMsgDBHdr** draft);

  // Only an opaque common-copy draft may cross this initial offline-copy cut.
  // Stage seals its metadata and returns a fresh unpublished physical key.
  nsresult StageHdrForOfflineCopy(nsIMsgDBHdr* draft, nsMsgKey* stagedKey);
  // The caller installs operation/counterpart mappings before publication.
  // Its owning native output slot must be null and is filled before callbacks.
  nsresult PublishHdrForOfflineCopy(nsIMsgDBHdr* draft, bool notifyLegacy,
                                    Message** liveHeader);

  // Callers own complete metadata and recovery bytes before removal callbacks.
  nsresult RemoveHdrForUndo(nsMsgKey key, RemovedMessage& captured,
                            OfflineOperationUndo* redo = nullptr,
                            OfflineOperationUndo* nextOffline = nullptr);
  nsresult CaptureOfflineOperationForUndo(
      nsMsgKey key, OfflineOperationUndo& output,
      const OfflineUndoCounterpart* counterpart = nullptr);
  // Native commit fills persistent output slots before notifying listeners.
  // Errors leave the captures and output values unchanged.
  nsresult RestoreHdrForUndo(RemovedMessage& captured,
                             const FinishedMessageBody& finished, nsMsgKey* key,
                             Message** liveHeader = nullptr,
                             OfflineOperationUndo* offline = nullptr,
                             const PendingDestination* cancelMove = nullptr,
                             OfflineOperationUndo* redo = nullptr);

  // Borrow the caller-owned capture/finished state only for this synchronous
  // public UndoDelete call. Persistent outputs are filled before callbacks.
  nsresult UndoDeleteHdrForUndo(RemovedMessage& captured,
                                const FinishedMessageBody& finished,
                                nsMsgKey* key, Message** liveHeader = nullptr,
                                OfflineOperationUndo* offline = nullptr,
                                const PendingDestination* cancelMove = nullptr,
                                OfflineOperationUndo* redo = nullptr);

  // Same-key completion from the actual parsed CreateNewHdr draft.
  // Once claimed, a failure seals the draft; caller retains finished bytes.
  nsresult CompletePartialHdr(const MessageBodyState& expected,
                              nsIMsgDBHdr* parsed,
                              const FinishedMessageBody& finished,
                              nsIMsgDBHdr** realHdr);

 private:
  friend class Message;
  friend class FolderInfo;
  friend class OfflineOperation;
  friend class MessageEnumerator;
  friend class ThreadEnumerator;
  friend class FilterEnumerator;

  struct UndoDeleteContext;
  UndoDeleteContext* mUndoDeleteContext = nullptr;

  virtual ~PerFolderDatabase() {};

  FolderDatabase& FolderDB() const {
    return *DatabaseCore::sInstance->mFolderDatabase;
  }
  MessageDatabase& MessageDB() const {
    return *DatabaseCore::sInstance->mMessageDatabase;
  }
  uint32_t StatusFlags(nsMsgKey key, uint32_t rawFlags) const;
  nsresult GetStatusFlags(nsMsgKey key, uint32_t rawFlags,
                          uint32_t& status) const;
  nsresult CheckFolderExists() const;
  nsresult CaptureDatabaseSourceId();
  nsresult CheckDatabaseSource() const;
  nsresult CacheHeader(nsMsgKey key, nsIMsgDBHdr* header);
  nsresult CheckEnumerationState(uint64_t generation) const;
  nsresult MarkThreadFlag(nsIMsgThread* thread, nsMsgKey key, uint32_t flag,
                          bool set, nsIDBChangeListener* instigator);
  nsresult ReadCount(bool unread, int32_t* count);
  nsresult WriteCount(bool unread, int32_t count);
  nsresult ChangeCount(bool unread, int32_t delta);
  void RememberLastUseTime() { mLastUseTime = PR_Now(); }
  nsresult GetMsgHdrForProperty(const nsACString& name, const nsACString& value,
                                nsIMsgDBHdr** result);

  uint64_t mFolderId;
  bool mIsNewsFolder;
  nsCString mDatabaseSourceId;
  nsresult mDatabaseSourceStatus = NS_ERROR_NOT_AVAILABLE;
  PRTime mLastUseTime = PR_Now();
  // Retained header-object threshold, matching nsMsgDatabase::AddHdrToCache.
  uint32_t mMsgHdrCacheSize = 512;
  nsTHashMap<nsMsgKey, nsCOMPtr<nsIMsgDBHdr>> mCachedHeaders;
  uint64_t mEnumeratorGeneration = 0;
  bool mForceClosed = false;
  bool mNotifyingGoingAway = false;
  nsTArray<nsMsgKey> mNewList;
  nsTObserverArray<RefPtr<nsIDBChangeListener>> mListeners;
};

class MessageEnumerator : public nsBaseMsgEnumerator {
 public:
  MessageEnumerator(PerFolderDatabase* owner, mozIStorageStatement* stmt);

  // nsIMsgEnumerator support.
  NS_IMETHOD GetNext(nsIMsgDBHdr** aItem) override;
  NS_IMETHOD HasMoreElements(bool* aResult) override;

 private:
  ~MessageEnumerator();
  bool CheckOwner();
  void Advance();
  nsresult ReleaseStatement();

  WeakPtr<PerFolderDatabase> mOwner;
  uint64_t mGeneration;
  nsresult mStatus = NS_OK;
  nsCOMPtr<mozIStorageStatement> mStmt;
  WeakPtr<MessageEnumeratorStatementCloser> mStatementCloser;
  bool mHasNext = false;
};

class ThreadEnumerator : public nsBaseMsgThreadEnumerator {
 public:
  ThreadEnumerator(PerFolderDatabase* owner, mozIStorageStatement* stmt);

  // nsIMsgEnumerator support.
  NS_IMETHOD GetNext(nsIMsgThread** item) override;
  NS_IMETHOD HasMoreElements(bool* hasNext) override;

 private:
  ~ThreadEnumerator() = default;
  bool CheckOwner();
  void Advance();

  WeakPtr<PerFolderDatabase> mOwner;
  uint64_t mGeneration;
  nsresult mStatus = NS_OK;
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
