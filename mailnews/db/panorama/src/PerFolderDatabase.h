/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_DB_PANORAMA_SRC_PERFOLDERDATABASE_H_
#define COMM_MAILNEWS_DB_PANORAMA_SRC_PERFOLDERDATABASE_H_

#include "DatabaseCore.h"
#include "FolderDatabase.h"
#include "Message.h"
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
#include "nsINewsDatabase.h"
#include "nsMsgKeySet.h"
#include "nsMsgEnumerator.h"
#include "nsTHashMap.h"
#include "prtime.h"

class mozIStorageStatement;
class nsIDBChangeListener;

namespace mozilla::mailnews {

class OfflineOperationUndo;
struct OfflineUndoCounterpart;

class DetachedMsgHdr;
class PerFolderDatabase;

#define NS_PARSED_SERVER_HDR_IID \
  {0x1c541b0d, 0xf213, 0x47dc, {0x9e, 0x24, 0x51, 0x93, 0xd1, 0x61, 0x08, 0x4c}}

// A selected incoming header, not a published folder member until publication.
// The strong owner and original draft survive parser Clear and copy callbacks.
class ParsedServerHdr final : public DecodedSubjectHdr {
 public:
  NS_INLINE_DECL_STATIC_IID(NS_PARSED_SERVER_HDR_IID)
  NS_DECL_ISUPPORTS
  NS_DECL_NSIMSGDBHDR

  nsresult GetLocation(ServerMessageLocation& location);
  nsresult UpdateKeywords(const nsACString& keywords, bool add);
  nsresult GetExistingThread(nsIMsgThread** thread);

 private:
  friend class PerFolderDatabase;
  enum class State { Staged, Publishing, Published, Aborted };
  ParsedServerHdr(PerFolderDatabase* owner, DetachedMsgHdr* draft,
                  uint32_t epoch, uint32_t uid);
  ~ParsedServerHdr();
  nsresult Check(bool writing = false);
  nsresult FinishWrite(nsresult rv);
  nsresult CheckProperty(const char* name) const;
  nsresult CheckFlags(uint32_t flags) const;

  RefPtr<PerFolderDatabase> mOwner;
  RefPtr<DetachedMsgHdr> mDraft;
  RefPtr<Message> mHeader;
  ServerMessageLocation mLocation;
  nsCString mSourceId;
  State mState = State::Staged;
  nsresult mError = NS_OK;
  bool mWriting = false;
  // No explicit New action keeps the ordinary unread publication default.
  bool mSuppressNew = false;
};
// One semaphore-guarded complete store scan. Accumulation owns only detached
// parser metadata; native rows change only at successful complete settlement.
class FolderRepair final {
 public:
  NS_INLINE_DECL_REFCOUNTING(FolderRepair)

 private:
  friend class PerFolderDatabase;
  explicit FolderRepair(PerFolderDatabase* owner);
  ~FolderRepair();
  struct Data;
  RefPtr<PerFolderDatabase> mOwner;
  UniquePtr<Data> mData;
};

// Concrete synchronous preparation shared only with the native news writer.
// Strong pins expire at the end of that write; the installed slot stays
// borrowed.
class PreparedNewsReadSetInstall final {
 public:
  PreparedNewsReadSetInstall() = default;
  PreparedNewsReadSetInstall(PreparedNewsReadSetInstall&&) = default;
  PreparedNewsReadSetInstall& operator=(PreparedNewsReadSetInstall&&) = default;

 private:
  friend class MessageDatabase;
  friend class PerFolderDatabase;
  RefPtr<PerFolderDatabase> mOwner;
  RefPtr<nsMsgKeySet> mTarget;
  RefPtr<nsMsgKeySet> mPrepared;
  NewsGroupIdentity mGroup;
  uint64_t mGeneration = 0;
  bool mAttach = false;
};

class MessageEnumeratorStatementCloser;

#define NS_PER_FOLDER_DATABASE_IID \
  {0x3a369f26, 0x552d, 0x4ff8, {0xa2, 0x80, 0x8c, 0x8a, 0x40, 0x73, 0xb9, 0xf4}}

class PerFolderDatabase : public nsIMsgOfflineOpsDatabase,
                          public nsINewsDatabase,
                          public SupportsWeakPtr,
                          public MessageListener {
 public:
  NS_INLINE_DECL_STATIC_IID(NS_PER_FOLDER_DATABASE_IID)
  explicit PerFolderDatabase(uint64_t folderId, bool isNewsFolder);

  NS_DECL_ISUPPORTS
  NS_DECL_NSIDBCHANGEANNOUNCER
  NS_DECL_NSIMSGDATABASE
  NS_DECL_NSIMSGOFFLINEOPSDATABASE
  NS_DECL_NSINEWSDATABASE

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

  // Explicit article namespace for existing C++ news consumers. Ordinary
  // nsIMsgDatabase keys remain global physical keys, even for a news folder.
  nsresult GetNewsArticleKey(uint32_t articleNumber, nsMsgKey& physicalKey);
  nsresult GetNewsArticleHdr(uint32_t articleNumber, nsIMsgDBHdr** header);
  // Passive load preserves known zero on exact unchanged serialized ranges.
  // Explicit SetReadSet stays authoritative; failure leaves the target
  // untouched.
  nsresult InitializeNewsReadSetFromNewsrc(nsMsgKeySet* incoming,
                                           const nsACString& serializedRanges);
  // Matching-only cleanup for the C++ news owner. A stale owner cannot detach
  // a replacement set; cleanup never reads storage or dereferences the set.
  void DetachNewsReadSetIfMatches(nsMsgKeySet* expected);

  // Explicit protocol delta against an actual saved native source tuple.
  // No client flag conversion, new owning output or postcommit lookup.
  nsresult QueueOfflineProtocolFlagMutation(
      nsMsgKey operationKey, const ServerMessageLocation& expectedSource,
      int32_t protocolMask, bool addFlags);

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

  // Server parser input is distinct from the UID-free offline-copy input.
  // The null persistent output owns a fresh unpublished physical identity.
  nsresult StageParsedServerHdr(nsIMsgDBHdr* parsed, uint32_t epoch,
                                uint32_t uid, ParsedServerHdr** staged);
  nsresult PublishParsedServerHdr(ParsedServerHdr* staged, bool notifyLegacy,
                                  Message** liveHeader);
  // Explicit metadata cleanup only. The caller keeps its primary error/bytes.
  nsresult AbortParsedServerHdr(ParsedServerHdr* staged);

  nsresult BeginFolderRepair(FolderRepair** repair);
  nsresult AddFolderRepairMessage(FolderRepair* repair, nsIMsgDBHdr* parsed,
                                  const nsACString& scannedStoreToken,
                                  uint64_t scannedMessageSize);
  nsresult CommitFolderRepair(FolderRepair* repair, nsresult scanStatus,
                              bool scanComplete,
                              nsTArray<RefPtr<Message>>& repaired);
  nsresult AbortFolderRepair(FolderRepair* repair, nsresult firstError);

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
  friend class MessageDatabase;
  friend class ParsedServerHdr;
  friend class FolderInfo;
  friend class OfflineOperation;
  friend class MessageEnumerator;
  friend class ThreadEnumerator;
  friend class FilterEnumerator;

  nsresult CheckFolderRepair(FolderRepair* repair);
  nsresult FailFolderRepair(FolderRepair& repair, nsresult failure);

  nsresult ValidateParsedServerHdr(ParsedServerHdr& staged,
                                   bool requireStaged = false);
  nsresult CheckParsedServerWriteTransaction() const;
  nsresult CheckParsedServerUid(uint32_t epoch, uint32_t uid,
                                nsMsgKey ownKey = nsMsgKey_None);

  struct UndoDeleteContext;
  UndoDeleteContext* mUndoDeleteContext = nullptr;

  virtual ~PerFolderDatabase();

  nsresult PrepareNewsReadSetInstall(const NewsGroupIdentity& expectedGroup,
                                     nsMsgKeySet* targetBorrowedSet,
                                     nsMsgKeySet* preparedOwnedSet,
                                     bool attachAfterCommit,
                                     PreparedNewsReadSetInstall& output);
  void ApplyPreparedNewsReadSet(PreparedNewsReadSetInstall& prepared);
  void DetachNewsReadSet();
  nsresult AttachNewsHdr(DetachedMsgHdr& draft, bool notify,
                         nsIMsgDBHdr** header);

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
  // Owned by nsMsgNewsFolder, explicitly detached before that owner releases
  // it.
  nsMsgKeySet* mNewsReadSet = nullptr;
  Maybe<NewsGroupIdentity> mNewsGroup;
  uint64_t mNewsReadSetGeneration = 0;
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
  // Only pending publication callbacks for explicitly not-New parsed headers.
  // Entries are consumed before legacy fanout, or removed on failure/close.
  nsTArray<nsMsgKey> mParsedServerNotNew;
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
