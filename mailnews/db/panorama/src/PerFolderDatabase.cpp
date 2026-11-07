/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "PerFolderDatabase.h"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <utility>

#include "DatabaseCore.h"
#include "DetachedMsgHdr.h"
#include "MailNewsTypes.h"
#include "Message.h"
#include "MessageDatabase.h"
#include "SearchFolderHits.h"
#include "Thread.h"
#include "mozIStorageBindingParams.h"
#include "mozIStorageBindingParamsArray.h"
#include "mozIStorageConnection.h"
#include "mozIStorageStatement.h"
#include "mozStorageHelper.h"
#include "mozilla/AutoRestore.h"
#include "mozilla/CheckedInt.h"
#include "mozilla/Components.h"
#include "mozilla/Logging.h"
#include "mozilla/Preferences.h"
#include "mozilla/RefPtr.h"
#include "mozilla/ResultExtensions.h"
#include "nsComponentManagerUtils.h"
#include "nsIInputStream.h"
#include "nsIMsgDBView.h"
#include "nsIMsgIncomingServer.h"
#include "nsIMsgFolderNotificationService.h"
#include "nsIMsgOfflineImapOperation.h"
#include "nsIMsgPluggableStore.h"
#include "nsIMsgSearchSession.h"
#include "nsIProperty.h"
#include "nsISimpleEnumerator.h"
#include "nsIVariant.h"
#include "nsIWritablePropertyBag2.h"
#include "nsMsgMessageFlags.h"
#include "nsMsgFolderFlags.h"
#include "nsMsgSearchCore.h"
#include "nsMsgUtils.h"
#include "nsQueryObject.h"
#include "nsReadableUtils.h"
#include "nsServiceManagerUtils.h"
#include "prtime.h"

namespace mozilla::mailnews {

extern LazyLogModule gPanoramaLog;

static constexpr uint32_t kCacheImportClientMask =
    nsMsgFolderFlags::Elided | nsMsgFolderFlags::Offline |
    nsMsgFolderFlags::CheckNew | nsMsgFolderFlags::Favorite;

NS_IMPL_ADDREF(PerFolderDatabase)
NS_IMPL_RELEASE(PerFolderDatabase)
NS_INTERFACE_MAP_BEGIN(PerFolderDatabase)
  NS_INTERFACE_MAP_ENTRY(nsIDBChangeAnnouncer)
  NS_INTERFACE_MAP_ENTRY(nsIMsgDatabase)
  NS_INTERFACE_MAP_ENTRY(nsIMsgOfflineOpsDatabase)
  NS_INTERFACE_MAP_ENTRY_CONDITIONAL(nsINewsDatabase, mIsNewsFolder)
  NS_INTERFACE_MAP_ENTRY_AMBIGUOUS(nsISupports, nsIMsgOfflineOpsDatabase)
  NS_INTERFACE_MAP_ENTRY_CONCRETE(PerFolderDatabase)
NS_INTERFACE_MAP_END

PerFolderDatabase::PerFolderDatabase(uint64_t folderId, bool isNewsFolder)
    : mFolderId(folderId), mIsNewsFolder(isNewsFolder) {
  mDatabaseSourceStatus = CaptureDatabaseSourceId();
  MessageDB().AddFolderMessageListener(this);
}

PerFolderDatabase::~PerFolderDatabase() { DetachNewsReadSet(); }

void PerFolderDatabase::DetachNewsReadSet() {
  if (!mIsNewsFolder) {
    return;
  }
  // This is cleanup, including after shutdown/source change. Never dereference
  // the saved borrowed set, open a core, or serialize/checkpoint during detach.
  if (DatabaseCore::sInstance && DatabaseCore::sInstance->mMessageDatabase) {
    MessageDB().DetachNewsReadSet(*this, mNewsReadSet);
  }
  mNewsReadSet = nullptr;
  mNewsGroup.reset();
  ++mNewsReadSetGeneration;
}

void PerFolderDatabase::DetachNewsReadSetIfMatches(nsMsgKeySet* expected) {
  if (mNewsReadSet == expected) {
    DetachNewsReadSet();
  }
}

NS_IMETHODIMP PerFolderDatabase::GetReadSet(nsMsgKeySet** readSet) {
  NS_ENSURE_ARG_POINTER(readSet);
  *readSet = nullptr;
  NS_ENSURE_TRUE(mIsNewsFolder, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  *readSet = mNewsReadSet;
  return NS_OK;
}

NS_IMETHODIMP PerFolderDatabase::SetReadSet(nsMsgKeySet* proposed) {
  NS_ENSURE_TRUE(mIsNewsFolder, NS_ERROR_NOT_AVAILABLE);
  if (!proposed) {
    DetachNewsReadSet();
    return NS_OK;
  }
  RefPtr<PerFolderDatabase> self(this);
  RefPtr<nsMsgKeySet> pinned(proposed);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  // Core receives the persistent member slot. No local postcommit pointer or
  // identity repair is allowed before the existing notification batch.
  return MessageDB().SetNewsReadSet(mDatabaseSourceId, mFolderId, *this,
                                    proposed, mNewsReadSet);
}

nsresult PerFolderDatabase::InitializeNewsReadSetFromNewsrc(
    nsMsgKeySet* incoming, const nsACString& serializedRanges) {
  NS_ENSURE_ARG(incoming);
  NS_ENSURE_TRUE(mIsNewsFolder, NS_ERROR_NOT_AVAILABLE);
  RefPtr<PerFolderDatabase> self(this);
  RefPtr<nsMsgKeySet> pinned(incoming);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  nsCString serialized;
  NS_ENSURE_TRUE(serialized.Assign(serializedRanges, fallible),
                 NS_ERROR_OUT_OF_MEMORY);
  // Core prepares an owned clone. Neither a failed initialization nor a
  // changed file may partially edit the caller-owned borrowed set/slot.
  return MessageDB().SetNewsReadSet(mDatabaseSourceId, mFolderId, *this,
                                    incoming, mNewsReadSet,
                                    Some(std::move(serialized)));
}

nsresult PerFolderDatabase::PrepareNewsReadSetInstall(
    const NewsGroupIdentity& expectedGroup, nsMsgKeySet* targetBorrowedSet,
    nsMsgKeySet* preparedOwnedSet, bool attachAfterCommit,
    PreparedNewsReadSetInstall& output) {
  NS_ENSURE_TRUE(mIsNewsFolder, NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(targetBorrowedSet && preparedOwnedSet &&
                     targetBorrowedSet != preparedOwnedSet,
                 NS_ERROR_INVALID_ARG);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  NS_ENSURE_TRUE(expectedGroup.databaseSourceId == mDatabaseSourceId &&
                     expectedGroup.folderId == mFolderId &&
                     !expectedGroup.incarnation.IsEmpty(),
                 NS_ERROR_NOT_AVAILABLE);
  if (!attachAfterCommit) {
    NS_ENSURE_TRUE(
        mNewsReadSet == targetBorrowedSet && mNewsGroup.isSome() &&
            mNewsGroup->databaseSourceId == expectedGroup.databaseSourceId &&
            mNewsGroup->folderId == expectedGroup.folderId &&
            mNewsGroup->incarnation == expectedGroup.incarnation,
        NS_ERROR_NOT_AVAILABLE);
  }
  PreparedNewsReadSetInstall prepared;
  prepared.mOwner = this;
  prepared.mTarget = targetBorrowedSet;
  prepared.mPrepared = preparedOwnedSet;
  prepared.mGroup = expectedGroup;
  prepared.mGeneration = mNewsReadSetGeneration;
  prepared.mAttach = attachAfterCommit;
  output = std::move(prepared);
  return NS_OK;
}

void PerFolderDatabase::ApplyPreparedNewsReadSet(
    PreparedNewsReadSetInstall& prepared) {
  MOZ_ASSERT(prepared.mOwner == this);
  MOZ_ASSERT(!mForceClosed && prepared.mGeneration == mNewsReadSetGeneration);
  MOZ_ASSERT(prepared.mTarget && prepared.mPrepared);
  MOZ_ASSERT(prepared.mAttach || mNewsReadSet == prepared.mTarget);
  prepared.mTarget->SwapContents(*prepared.mPrepared);
  mNewsReadSet = prepared.mTarget;
  mNewsGroup = Some(std::move(prepared.mGroup));
  ++mNewsReadSetGeneration;
}

nsresult PerFolderDatabase::GetNewsArticleKey(uint32_t articleNumber,
                                              nsMsgKey& physicalKey) {
  NS_ENSURE_TRUE(mIsNewsFolder, NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(articleNumber <= INT32_MAX, NS_ERROR_INVALID_ARG);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  NS_ENSURE_TRUE(mNewsGroup.isSome(), NS_ERROR_NOT_AVAILABLE);
  NewsArticleIdentity expected{*mNewsGroup, articleNumber};
  return MessageDB().GetNewsArticleKey(expected, physicalKey);
}

nsresult PerFolderDatabase::GetNewsArticleHdr(uint32_t articleNumber,
                                              nsIMsgDBHdr** header) {
  NS_ENSURE_ARG_POINTER(header);
  *header = nullptr;
  nsMsgKey physicalKey;
  MOZ_TRY(GetNewsArticleKey(articleNumber, physicalKey));
  return GetMsgHdrForKey(physicalKey, header);
}

nsresult PerFolderDatabase::GetNewsArticleLocation(
    nsMsgKey physicalKey, NewsArticleIdentity& output) {
  NS_ENSURE_TRUE(mIsNewsFolder, NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(physicalKey && physicalKey != nsMsgKey_None,
                 NS_ERROR_INVALID_ARG);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  NS_ENSURE_TRUE(mNewsGroup.isSome(), NS_ERROR_NOT_AVAILABLE);
  RefPtr<MessageDatabase> messages = &MessageDB();
  MOZ_TRY(messages->RequireCommittedSearchRead());
  NewsGroupIdentity current;
  MOZ_TRY(
      messages->GetNewsGroupIdentity(mDatabaseSourceId, mFolderId, current));
  NS_ENSURE_TRUE(current.databaseSourceId == mNewsGroup->databaseSourceId &&
                     current.folderId == mNewsGroup->folderId &&
                     current.incarnation == mNewsGroup->incarnation,
                 NS_ERROR_NOT_AVAILABLE);
  Maybe<NewsArticleIdentity> article;
  MOZ_TRY(messages->ReadNewsArticle(physicalKey, article));
  NS_ENSURE_TRUE(article.isSome(), NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(article->group.databaseSourceId == current.databaseSourceId &&
                     article->group.folderId == current.folderId &&
                     article->group.incarnation == current.incarnation,
                 NS_ERROR_NOT_AVAILABLE);
  nsMsgKey mapped;
  MOZ_TRY(messages->GetNewsArticleKey(*article, mapped));
  NS_ENSURE_TRUE(mapped == physicalKey, NS_ERROR_FILE_CORRUPTED);
  output = std::move(*article);
  return NS_OK;
}

nsresult PerFolderDatabase::CaptureNewsArticleBody(nsMsgKey physicalKey,
                                                   NewsArticleIdentity& article,
                                                   MessageBodyState& body) {
  NewsArticleIdentity preparedArticle;
  MOZ_TRY(GetNewsArticleLocation(physicalKey, preparedArticle));
  MessageBodyState preparedBody;
  MOZ_TRY(MessageDB().GetMessageBodyState(physicalKey, preparedBody));
  NS_ENSURE_TRUE(
      preparedBody.databaseSourceId == preparedArticle.group.databaseSourceId &&
          preparedBody.folderId == preparedArticle.group.folderId &&
          preparedBody.key == physicalKey,
      NS_ERROR_NOT_AVAILABLE);
  article = std::move(preparedArticle);
  body = std::move(preparedBody);
  return NS_OK;
}

nsresult PerFolderDatabase::SettleNewsArticleBody(
    const NewsArticleIdentity& expectedArticle,
    const MessageBodyState& expectedBody, const FinishedMessageBody& finished,
    MessageBodyState& output) {
  RefPtr<PerFolderDatabase> self(this);
  NS_ENSURE_TRUE(expectedArticle.articleNumber <= INT32_MAX,
                 NS_ERROR_INVALID_ARG);
  NS_ENSURE_FALSE(finished.storeToken.IsEmpty(), NS_ERROR_INVALID_ARG);
  NewsArticleIdentity current;
  MOZ_TRY(GetNewsArticleLocation(expectedBody.key, current));
  NS_ENSURE_TRUE(
      current.group.databaseSourceId ==
              expectedArticle.group.databaseSourceId &&
          current.group.folderId == expectedArticle.group.folderId &&
          current.group.incarnation == expectedArticle.group.incarnation &&
          current.articleNumber == expectedArticle.articleNumber &&
          expectedBody.databaseSourceId == current.group.databaseSourceId &&
          expectedBody.folderId == current.group.folderId,
      NS_ERROR_NOT_AVAILABLE);
  // Core fills the caller's output before its committed callbacks. Do not
  // replace that output after a nested consumer has already observed it.
  return MessageDB().SettleMessageBody(expectedBody, finished, output);
}

nsresult PerFolderDatabase::RemoveNewsArticle(
    const NewsArticleIdentity& expectedArticle, nsMsgKey physicalKey) {
  RefPtr<PerFolderDatabase> self(this);
  NS_ENSURE_TRUE(expectedArticle.articleNumber <= INT32_MAX,
                 NS_ERROR_INVALID_ARG);
  NewsArticleIdentity current;
  MOZ_TRY(GetNewsArticleLocation(physicalKey, current));
  NS_ENSURE_TRUE(
      current.group.databaseSourceId ==
              expectedArticle.group.databaseSourceId &&
          current.group.folderId == expectedArticle.group.folderId &&
          current.group.incarnation == expectedArticle.group.incarnation &&
          current.articleNumber == expectedArticle.articleNumber,
      NS_ERROR_NOT_AVAILABLE);
  // This is the same physical removal used by DeleteMessages for news. The
  // validated news facade supplies its captured owner and offline accounting,
  // without resolving a different folder wrapper during the operation.
  return MessageDB().RemoveMessageFromFolder(
      physicalKey, mFolderId, mDatabaseSourceId,
      MessageRemovalAccounting::OfflineMessageSize);
}

nsresult PerFolderDatabase::CaptureDatabaseSourceId() {
  // Capture once without opening a core or changing a caller-owned transaction.
  // Keep both the original spelling and the first error for later admission.
  RefPtr<DatabaseCore> core = DatabaseCore::sInstance;
  NS_ENSURE_TRUE(core, NS_ERROR_NOT_AVAILABLE);
  return core->ReadSourceIdForFolderAdmission(mDatabaseSourceId);
}

class OfflineOperation final : public nsIMsgOfflineImapOperation {
 public:
  NS_DECL_ISUPPORTS
  OfflineOperation(PerFolderDatabase* database, nsMsgKey key)
      : mDatabase(database), mKey(key) {}

  NS_IMETHOD GetMessageKey(nsMsgKey* value) override {
    NS_ENSURE_ARG_POINTER(value);
    *value = mKey;
    return NS_OK;
  }
  NS_IMETHOD SetMessageKey(nsMsgKey value) override {
    // The factory supplies the immutable physical identity.
    return value == mKey ? NS_OK : NS_ERROR_INVALID_ARG;
  }
  NS_IMETHOD GetOperation(nsOfflineImapOperationType* value) override {
    NS_ENSURE_ARG_POINTER(value);
    OfflineOperationData data;
    MOZ_TRY(Read(data));
    *value = static_cast<nsOfflineImapOperationType>(data.operation);
    return NS_OK;
  }
  NS_IMETHOD SetOperation(nsOfflineImapOperationType value) override {
    return Update([&](auto& data) {
      data.operation |= static_cast<uint32_t>(value);
      return NS_OK;
    });
  }
  NS_IMETHOD ClearOperation(nsOfflineImapOperationType value) override {
    return Update([&](auto& data) -> nsresult {
      data.operation &= ~static_cast<uint32_t>(value);
      if (!(data.operation & kFlagsChanged)) {
        data.flagMutation.reset();
        if (value & kFlagsChanged) data.invalidateFlagMutation = true;
      }
      if (!(data.operation & (kMsgMoved | kAppendDraft | kAppendTemplate))) {
        data.pendingDestination.reset();
      }
      switch (value) {
        case kMsgMoved:
        case kAppendDraft:
        case kAppendTemplate:
          data.destinationFolderURI.Truncate();
          break;
        case kMsgCopy:
          NS_ENSURE_FALSE(data.copyDestinations.IsEmpty(), NS_ERROR_UNEXPECTED);
          data.copyDestinations.RemoveElementAt(0);
          if (!data.copyDestinationBindings.IsEmpty()) {
            data.copyDestinationBindings.RemoveElementAt(0);
          }
          break;
      }
      return NS_OK;
    });
  }
  NS_IMETHOD GetSrcMessageKey(nsMsgKey* value) override {
    return ReadNumber(&OfflineOperationData::sourceKey, value);
  }
  NS_IMETHOD SetSrcMessageKey(nsMsgKey value) override {
    return WriteField(&OfflineOperationData::sourceKey, value);
  }
  NS_IMETHOD GetSrcUid(ImapUid* value) override {
    return ReadNumber(&OfflineOperationData::sourceUid, value);
  }
  NS_IMETHOD SetSrcUid(ImapUid value) override {
    return WriteField(&OfflineOperationData::sourceUid, value);
  }
  NS_IMETHOD GetFlagOperation(imapMessageFlagsType* value) override {
    return ReadNumber(&OfflineOperationData::flagOperation, value);
  }
  NS_IMETHOD SetFlagOperation(imapMessageFlagsType value) override {
    return Update([&](auto& data) {
      data.operation |= kFlagsChanged;
      // A legacy whole-word writer supplies no protocol-delta provenance.
      data.flagMutation.reset();
      data.invalidateFlagMutation = true;
      data.newFlags = value;
      data.flagOperation |= value;
      return NS_OK;
    });
  }
  NS_IMETHOD GetNewFlags(imapMessageFlagsType* value) override {
    return ReadNumber(&OfflineOperationData::newFlags, value);
  }
  NS_IMETHOD SetNewFlags(imapMessageFlagsType value) override {
    return Update([&](auto& data) {
      data.newFlags = value;
      data.flagMutation.reset();
      data.invalidateFlagMutation = true;
      return NS_OK;
    });
  }
  NS_IMETHOD GetDestinationFolderURI(nsACString& value) override {
    return ReadString(&OfflineOperationData::destinationFolderURI, value);
  }
  NS_IMETHOD SetDestinationFolderURI(const nsACString& value) override {
    return WriteField(&OfflineOperationData::destinationFolderURI, value);
  }
  NS_IMETHOD GetSourceFolderURI(nsACString& value) override {
    return ReadString(&OfflineOperationData::sourceFolderURI, value);
  }
  NS_IMETHOD SetSourceFolderURI(const nsACString& value) override {
    return Update([&](auto& data) {
      data.operation |= kMoveResult;
      data.sourceFolderURI = value;
      return NS_OK;
    });
  }
  NS_IMETHOD GetKeywordsToAdd(char** value) override {
    return ReadCString(&OfflineOperationData::keywordsToAdd, value);
  }
  NS_IMETHOD GetKeywordsToRemove(char** value) override {
    return ReadCString(&OfflineOperationData::keywordsToRemove, value);
  }
  NS_IMETHOD AddKeywordToAdd(const char* value) override {
    NS_ENSURE_ARG_POINTER(value);
    return Update([&](auto& data) {
      data.operation |= kAddKeywords;
      AddKeyword(value, data.keywordsToAdd, data.keywordsToRemove);
      return NS_OK;
    });
  }
  NS_IMETHOD AddKeywordToRemove(const char* value) override {
    NS_ENSURE_ARG_POINTER(value);
    return Update([&](auto& data) {
      data.operation |= kRemoveKeywords;
      AddKeyword(value, data.keywordsToRemove, data.keywordsToAdd);
      return NS_OK;
    });
  }
  NS_IMETHOD AddMessageCopyOperation(const nsACString& value) override {
    return Update([&](auto& data) {
      data.operation |= kMsgCopy;
      data.copyDestinations.AppendElement(value);
      data.copyDestinationBindings.AppendElement(Nothing());
      return NS_OK;
    });
  }
  NS_IMETHOD GetCopyDestination(int32_t index, char** value) override {
    NS_ENSURE_ARG_POINTER(value);
    *value = nullptr;
    OfflineOperationData data;
    MOZ_TRY(Read(data));
    NS_ENSURE_TRUE(
        index >= 0 && uint32_t(index) < data.copyDestinations.Length(),
        NS_ERROR_ILLEGAL_VALUE);
    *value = ToNewCString(data.copyDestinations[index]);
    return *value ? NS_OK : NS_ERROR_OUT_OF_MEMORY;
  }
  NS_IMETHOD GetMsgSize(uint32_t* value) override {
    return ReadNumber(&OfflineOperationData::messageSize, value);
  }
  NS_IMETHOD SetMsgSize(uint32_t value) override {
    return WriteField(&OfflineOperationData::messageSize, value);
  }
  NS_IMETHOD GetPlayingBack(bool* value) override {
    NS_ENSURE_ARG_POINTER(value);
    OfflineOperationData data;
    MOZ_TRY(Read(data));
    *value = data.playingBack;
    return NS_OK;
  }
  NS_IMETHOD SetPlayingBack(bool value) override {
    MOZ_TRY(mDatabase->CheckFolderExists());
    MOZ_TRY(mDatabase->CheckDatabaseSource());
    return mDatabase->MessageDB().SetOfflineOperationPlayingBack(
        mDatabase->FolderId(), mKey, value);
  }

 private:
  ~OfflineOperation() = default;
  nsresult Read(OfflineOperationData& data) {
    MOZ_TRY(mDatabase->CheckFolderExists());
    MOZ_TRY(mDatabase->CheckDatabaseSource());
    return mDatabase->MessageDB().GetOfflineOperation(mDatabase->FolderId(),
                                                      mKey, data);
  }
  template <typename Change>
  nsresult Update(Change&& change) {
    OfflineOperationData data;
    MOZ_TRY(Read(data));
    MOZ_TRY(change(data));
    return mDatabase->MessageDB().StoreOfflineOperation(mDatabase->FolderId(),
                                                        mKey, data);
  }
  template <typename T>
  nsresult ReadNumber(uint32_t OfflineOperationData::* member, T* value) {
    NS_ENSURE_ARG_POINTER(value);
    OfflineOperationData data;
    MOZ_TRY(Read(data));
    CheckedInt<T> checked(data.*member);
    NS_ENSURE_TRUE(checked.isValid(), NS_ERROR_FILE_CORRUPTED);
    *value = checked.value();
    return NS_OK;
  }
  template <typename T, typename U>
  nsresult WriteField(T OfflineOperationData::* member, const U& value) {
    return Update([&](auto& data) {
      data.*member = value;
      return NS_OK;
    });
  }
  nsresult ReadString(nsCString OfflineOperationData::* member,
                      nsACString& value) {
    OfflineOperationData data;
    MOZ_TRY(Read(data));
    value = data.*member;
    return NS_OK;
  }
  nsresult ReadCString(nsCString OfflineOperationData::* member, char** value) {
    NS_ENSURE_ARG_POINTER(value);
    *value = nullptr;
    OfflineOperationData data;
    MOZ_TRY(Read(data));
    *value = ToNewCString(data.*member);
    return *value ? NS_OK : NS_ERROR_OUT_OF_MEMORY;
  }
  static void AddKeyword(const char* keyword, nsCString& add,
                         nsCString& remove) {
    nsDependentCString value(keyword);
    int32_t start, length;
    if (!MsgFindKeyword(value, add, &start, &length)) {
      if (!add.IsEmpty()) {
        add.Append(' ');
      }
      add.Append(value);
    }
    if (MsgFindKeyword(value, remove, &start, &length)) {
      remove.Cut(start, length);
    }
  }

  RefPtr<PerFolderDatabase> mDatabase;
  const nsMsgKey mKey;
};
NS_IMPL_ISUPPORTS(OfflineOperation, nsIMsgOfflineImapOperation)

nsresult PerFolderDatabase::QueueOfflineProtocolFlagMutation(
    nsMsgKey operationKey, const ServerMessageLocation& expectedSource,
    int32_t protocolMask, bool addFlags) {
  RefPtr<PerFolderDatabase> self(this);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  MOZ_TRY(CheckParsedServerWriteTransaction());
  NS_ENSURE_TRUE(expectedSource.folderId == mFolderId, NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(protocolMask >= 0 && !(uint32_t(protocolMask) & ~0xdfu),
                 NS_ERROR_INVALID_ARG);
  // Core owns the checked transaction, saved tuple and per-bit composition.
  // There are no callbacks or fallible facade lookups after this commit.
  // The IM caller retains its existing OfflineEvents notification/first error.
  return MessageDB().QueueOfflineProtocolFlagMutation(
      mDatabaseSourceId, mFolderId, operationKey, expectedSource, protocolMask,
      addFlags);
}

NS_IMETHODIMP PerFolderDatabase::GetOfflineOpForKey(
    nsMsgKey key, bool create, nsIMsgOfflineImapOperation** result) {
  NS_ENSURE_ARG_POINTER(result);
  *result = nullptr;
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  OfflineOperationData data;
  nsresult rv = MessageDB().GetOfflineOperation(mFolderId, key, data);
  if (rv == NS_ERROR_NOT_AVAILABLE) {
    if (!create) {
      return NS_OK;
    }
    Maybe<CapturedMessage> captured;
    MOZ_TRY(MessageDB().CaptureHeaderState(key, captured));
    NS_ENSURE_TRUE(captured && captured->folderId == mFolderId,
                   NS_ERROR_NOT_AVAILABLE);
    // Retain the legacy compatibility word, never a proven protocol snapshot.
    data.newFlags = static_cast<imapMessageFlagsType>(captured->flags);
    data.flagMutation.reset();
    MOZ_TRY(MessageDB().StoreOfflineOperation(mFolderId, key, data));
  } else {
    NS_ENSURE_SUCCESS(rv, rv);
  }
  if (create) {
    // If this later step fails, retain the durable operation and report
    // failure.
    RefPtr<FolderInfo> info = new FolderInfo(this);
    int32_t flags;
    MOZ_TRY(info->OrFlags(nsMsgFolderFlags::OfflineEvents, &flags));
    nsCOMPtr<nsIMsgFolder> folder;
    MOZ_TRY(GetFolder(getter_AddRefs(folder)));
    MOZ_TRY(folder->SetFlag(nsMsgFolderFlags::OfflineEvents));
  }
  RefPtr<OfflineOperation> operation = new OfflineOperation(this, key);
  operation.forget(result);
  return NS_OK;
}

NS_IMETHODIMP PerFolderDatabase::RemoveOfflineOp(
    nsIMsgOfflineImapOperation* op) {
  NS_ENSURE_ARG(op);
  MOZ_TRY(CheckFolderExists());
  nsMsgKey key;
  MOZ_TRY(op->GetMessageKey(&key));
  return MessageDB().RemoveOfflineOperation(mFolderId, key);
}

NS_IMETHODIMP PerFolderDatabase::ListAllOfflineOpIds(nsTArray<nsMsgKey>& keys) {
  MOZ_TRY(CheckFolderExists());
  nsTArray<nsMsgKey> pending;
  MOZ_TRY(MessageDB().ListOfflineOperations(mFolderId, false, pending));
  keys.AppendElements(pending);
  return NS_OK;
}

NS_IMETHODIMP PerFolderDatabase::ListAllOfflineDeletes(
    nsTArray<nsMsgKey>& keys) {
  MOZ_TRY(CheckFolderExists());
  nsTArray<nsMsgKey> pending;
  MOZ_TRY(MessageDB().ListOfflineOperations(mFolderId, true, pending));
  // SELECT appends these to its already collected published keys.
  keys.AppendElements(pending);
  return NS_OK;
}

NS_IMETHODIMP PerFolderDatabase::HasOfflineActivity(bool* hasOffline) {
  NS_ENSURE_ARG_POINTER(hasOffline);
  *hasOffline = false;
  nsTArray<nsMsgKey> keys;
  MOZ_TRY(ListAllOfflineOpIds(keys));
  *hasOffline = !keys.IsEmpty();
  return NS_OK;
}

// MessageListener:

void PerFolderDatabase::OnMessageAdded(Message* message) {
  OnMessagePublished(message, true);
}

void PerFolderDatabase::OnMessagePublished(Message* message,
                                           bool notifyLegacy) {
  if (mForceClosed) {
    return;
  }
  RefPtr<PerFolderDatabase> self(this);
  uint64_t msgFolderId;
  nsresult rv = MessageDB().GetMessageFolderId(message->Key(), msgFolderId);
  NS_ENSURE_SUCCESS_VOID(rv);
  if (msgFolderId == mFolderId) {
    uint32_t flags;
    rv = MessageDB().GetMessageFlags(message->Key(), flags);
    NS_ENSURE_SUCCESS_VOID(rv);
    // Only an explicit staged parser decision overrides the unread default.
    bool notNew = mParsedServerNotNew.RemoveElement(message->Key());
    if (!(flags & nsMsgMessageFlags::Read) && !notNew) {
      if (!mNewList.Contains(message->Key())) {
        mNewList.AppendElement(message->Key());
      }
    }
    if (!notifyLegacy) {
      return;
    }
    nsMsgKey parent;
    rv = message->GetThreadParent(&parent);
    NS_ENSURE_SUCCESS_VOID(rv);
    // Panorama stores an absent parent as zero.
    NotifyHdrAddedAll(message, parent ? parent : nsMsgKey_None,
                      StatusFlags(message->Key(), flags), nullptr);
  }
}

void PerFolderDatabase::OnMessageThreadChanged(const CapturedMessage& before,
                                               const CapturedMessage& after,
                                               Message*) {
  if (mForceClosed) {
    return;
  }
  if (before.folderId != mFolderId || after.folderId != mFolderId) {
    return;
  }
  nsMsgKey oldParent =
      before.threadParent ? before.threadParent : nsMsgKey_None;
  nsMsgKey newParent = after.threadParent ? after.threadParent : nsMsgKey_None;
  if (oldParent == newParent) {
    return;
  }
  // Earlier callbacks may have changed or removed the live header.
  RefPtr<PerFolderDatabase> self(this);
  NotifyParentChangedAll(after.id, oldParent, newParent, nullptr);
}

void PerFolderDatabase::OnMessageRemoved(Message* message, uint32_t oldFlags) {
  if (mForceClosed) {
    return;
  }
  RefPtr<PerFolderDatabase> self(this);
  uint64_t msgFolderId;
  nsresult rv = MessageDB().GetMessageFolderId(message->Key(), msgFolderId);
  NS_ENSURE_SUCCESS_VOID(rv);
  if (msgFolderId == mFolderId) {
    uint32_t status = StatusFlags(message->Key(), oldFlags);
    mNewList.RemoveElement(message->Key());
    NotifyHdrDeletedAll(message, nsMsgKey_None, status, nullptr);
  }
}

void PerFolderDatabase::OnMessageFlagsChanged(nsIMsgDBHdr* oldMessage,
                                              Message* message,
                                              uint32_t oldFlags,
                                              uint32_t newFlags) {
  if (mForceClosed) {
    return;
  }
  RefPtr<PerFolderDatabase> self(this);
  uint64_t msgFolderId;
  nsresult rv = MessageDB().GetMessageFolderId(message->Key(), msgFolderId);
  NS_ENSURE_SUCCESS_VOID(rv);
  if (msgFolderId == mFolderId) {
    CapturedMessage before, after;
    before.id = after.id = message->Key();
    before.folderId = after.folderId = mFolderId;
    before.flags = oldFlags;
    after.flags = newFlags;
    OnMessageFlagsChangedCaptured(before, after, oldMessage, message);
  }
}

void PerFolderDatabase::OnMessageTagsChanged(nsIMsgDBHdr* oldMessage,
                                             Message* message,
                                             const nsACString& oldTags,
                                             const nsACString& newTags) {
  if (mForceClosed) {
    return;
  }
  RefPtr<PerFolderDatabase> self(this);
  uint64_t msgFolderId;
  nsresult rv = MessageDB().GetMessageFolderId(message->Key(), msgFolderId);
  NS_ENSURE_SUCCESS_VOID(rv);
  if (msgFolderId != mFolderId) {
    return;
  }

  // There's no equivalent function in nsIDBChangeAnnouncer.
  for (RefPtr<nsIDBChangeListener> listener : mListeners.EndLimitedRange()) {
    uint32_t status = 0;
    listener->OnHdrPropertyChanged(message, "keywords"_ns, false, &status,
                                   nullptr);
  }
}

void PerFolderDatabase::OnMessagePublishedCaptured(const CapturedMessage& after,
                                                   Message* message,
                                                   bool notifyLegacy) {
  if (mForceClosed) {
    return;
  }
  if (after.folderId != mFolderId) {
    return;
  }
  RefPtr<PerFolderDatabase> self(this);
  bool notNew = mParsedServerNotNew.RemoveElement(after.id);
  if (!(after.flags & nsMsgMessageFlags::Read) && !notNew) {
    // Earlier native listeners may already have changed the live row. These
    // membership and notification facts belong to this captured publication.
    if (!mNewList.Contains(after.id)) {
      mNewList.AppendElement(after.id);
    }
  }
  if (notifyLegacy) {
    nsMsgKey parent = after.threadParent ? after.threadParent : nsMsgKey_None;
    NotifyHdrAddedAll(message, parent, StatusFlags(after.id, after.flags),
                      nullptr);
  }
}

void PerFolderDatabase::OnMessageRemovedCaptured(const CapturedMessage& before,
                                                 Message* message) {
  if (mForceClosed) {
    return;
  }
  if (before.folderId != mFolderId) {
    return;
  }
  RefPtr<PerFolderDatabase> self(this);
  uint32_t status = StatusFlags(before.id, before.flags);
  mNewList.RemoveElement(before.id);
  nsMsgKey parent = before.threadParent ? before.threadParent : nsMsgKey_None;
  NotifyHdrDeletedAll(message, parent, status, nullptr);
}

void PerFolderDatabase::OnMessageFlagsChangedCaptured(
    const CapturedMessage& before, const CapturedMessage& after, nsIMsgDBHdr*,
    Message* message) {
  if (mForceClosed) {
    return;
  }
  if (before.folderId != mFolderId || after.folderId != mFolderId ||
      before.flags == after.flags) {
    return;
  }
  RefPtr<PerFolderDatabase> self(this);
  uint32_t oldStatus = StatusFlags(before.id, before.flags);
  if (((before.flags ^ after.flags) & nsMsgMessageFlags::Read) ||
      ((before.flags & nsMsgMessageFlags::New) &&
       !(after.flags & nsMsgMessageFlags::New))) {
    mNewList.RemoveElement(after.id);
  }
  uint32_t newStatus = StatusFlags(after.id, after.flags);
  // Freeze both outgoing words before ordinary listeners can remove/re-add the
  // key, change flags again, or close this facade.
  NotifyHdrChangeAll(message, oldStatus, newStatus, nullptr);
  if (mIsNewsFolder &&
      ((before.flags ^ after.flags) & nsMsgMessageFlags::Read)) {
    // The native writer already committed the checkpoint and installed/swapped
    // the same borrowed set before delivering this captured flag event.
    NotifyReadChanged(nullptr);
  }
}

void PerFolderDatabase::OnMessageTagsChangedCaptured(
    const CapturedMessage& before, const CapturedMessage& after, nsIMsgDBHdr*,
    Message* message) {
  if (mForceClosed) {
    return;
  }
  if (before.folderId != mFolderId || after.folderId != mFolderId ||
      before.tags.Equals(after.tags)) {
    return;
  }
  RefPtr<PerFolderDatabase> self(this);
  for (RefPtr<nsIDBChangeListener> listener : mListeners.EndLimitedRange()) {
    uint32_t status = 0;
    listener->OnHdrPropertyChanged(message, "keywords"_ns, false, &status,
                                   nullptr);
  }
}

void PerFolderDatabase::OnMessageBodyChangedCaptured(
    const CapturedMessage& before, const CapturedMessage& after,
    nsIMsgDBHdr* oldHeader, Message* message, const MessageBodyState&,
    const MessageBodyState&) {
  if (mForceClosed) {
    return;
  }
  if (before.flags != after.flags) {
    OnMessageFlagsChangedCaptured(before, after, oldHeader, message);
  }
}

// nsIDBChangeAnnouncer:

NS_IMETHODIMP PerFolderDatabase::AddListener(nsIDBChangeListener* listener) {
  NS_ENSURE_ARG(listener);
  NS_ENSURE_FALSE(mForceClosed, NS_ERROR_NOT_AVAILABLE);
  mListeners.AppendElementUnlessExists(listener);
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::RemoveListener(nsIDBChangeListener* listener) {
  NS_ENSURE_ARG(listener);
  mListeners.RemoveElement(listener);
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::NotifyHdrChangeAll(
    nsIMsgDBHdr* hdrChanged, uint32_t oldFlags, uint32_t newFlags,
    nsIDBChangeListener* instigator) {
  NS_ENSURE_ARG(hdrChanged);
  for (RefPtr<nsIDBChangeListener> listener : mListeners.EndLimitedRange()) {
    listener->OnHdrFlagsChanged(hdrChanged, oldFlags, newFlags, instigator);
  }
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::NotifyHdrAddedAll(
    nsIMsgDBHdr* hdrAdded, nsMsgKey parentKey, int32_t flags,
    nsIDBChangeListener* instigator) {
  NS_ENSURE_ARG(hdrAdded);
  for (RefPtr<nsIDBChangeListener> listener : mListeners.EndLimitedRange()) {
    listener->OnHdrAdded(hdrAdded, parentKey, flags, instigator);
  }
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::NotifyHdrDeletedAll(
    nsIMsgDBHdr* hdrDeleted, nsMsgKey parentKey, int32_t flags,
    nsIDBChangeListener* instigator) {
  NS_ENSURE_ARG(hdrDeleted);
  for (RefPtr<nsIDBChangeListener> listener : mListeners.EndLimitedRange()) {
    listener->OnHdrDeleted(hdrDeleted, parentKey, flags, instigator);
  }
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::NotifyParentChangedAll(
    nsMsgKey keyReparented, nsMsgKey oldParent, nsMsgKey newParent,
    nsIDBChangeListener* instigator) {
  for (RefPtr<nsIDBChangeListener> listener : mListeners.EndLimitedRange()) {
    listener->OnParentChanged(keyReparented, oldParent, newParent, instigator);
  }
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::NotifyReadChanged(
    nsIDBChangeListener* instigator) {
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  RefPtr<PerFolderDatabase> self(this);
  for (RefPtr<nsIDBChangeListener> listener : mListeners.EndLimitedRange()) {
    listener->OnReadChanged(instigator);
  }
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::NotifyJunkScoreChanged(
    nsIDBChangeListener* instigator) {
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  RefPtr<PerFolderDatabase> self(this);
  for (RefPtr<nsIDBChangeListener> listener : mListeners.EndLimitedRange()) {
    listener->OnJunkScoreChanged(instigator);
  }
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::NotifyAnnouncerGoingAway(void) {
  if (mNotifyingGoingAway) {
    return NS_OK;
  }
  RefPtr<PerFolderDatabase> self(this);
  AutoRestore<bool> notifying(mNotifyingGoingAway);
  mNotifyingGoingAway = true;
  for (RefPtr<nsIDBChangeListener> listener : mListeners.EndLimitedRange()) {
    listener->OnAnnouncerGoingAway(this);
  }
  if (mForceClosed) {
    mListeners.Clear();
    mNewList.Clear();
  }
  return NS_OK;
}

// nsIMsgDatabase:

NS_IMETHODIMP PerFolderDatabase::OpenFromFile(nsIFile* aFolderName) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP PerFolderDatabase::Close(bool forceCommit) {
  ++mEnumeratorGeneration;
  DetachNewsReadSet();
  // Each native write is already committed. Never settle another caller's SQL.
  return forceCommit ? Commit(nsMsgDBCommitType::kSessionCommit) : NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::Commit(nsMsgDBCommit aCommitType) {
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::ForceClosed() {
  if (mForceClosed) {
    return NS_OK;
  }
  RefPtr<PerFolderDatabase> self(this);
  mForceClosed = true;
  DetachNewsReadSet();
  mParsedServerNotNew.Clear();
  mCachedHeaders.Clear();
  // Invalidate this wrapper's weak cache entries before a listener reopens it.
  DetachWeakPtr();
  if (DatabaseCore::sInstance && DatabaseCore::sInstance->mMessageDatabase) {
    MessageDB().RemoveMessageListener(this);
  }
  return NotifyAnnouncerGoingAway();
}
NS_IMETHODIMP PerFolderDatabase::ClearCachedHdrs() {
  // Drop only our strong header references, not external views or core data.
  mCachedHeaders.Clear();
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::ResetHdrCacheSize(uint32_t size) {
  if (mMsgHdrCacheSize > size) {
    mMsgHdrCacheSize = size;
    mCachedHeaders.Clear();
  }
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::GetDBFolderInfo(
    nsIDBFolderInfo** aDBFolderInfo) {
  NS_ENSURE_ARG_POINTER(aDBFolderInfo);
  NS_IF_ADDREF(*aDBFolderInfo = new FolderInfo(this));
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::GetDatabaseSize(int64_t* databaseSize) {
  NS_ENSURE_ARG_POINTER(databaseSize);
  *databaseSize = 0;
  return NS_OK;
}
uint32_t PerFolderDatabase::StatusFlags(nsMsgKey key, uint32_t rawFlags) const {
  return mNewList.Contains(key) ? rawFlags | nsMsgMessageFlags::New : rawFlags;
}

nsresult PerFolderDatabase::GetStatusFlags(nsMsgKey key, uint32_t rawFlags,
                                           uint32_t& status) const {
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  status = StatusFlags(key, rawFlags);
  return NS_OK;
}

nsresult PerFolderDatabase::CheckDatabaseSource() const {
  MOZ_TRY(mDatabaseSourceStatus);
  RefPtr<DatabaseCore> core = DatabaseCore::sInstance;
  NS_ENSURE_TRUE(core, NS_ERROR_NOT_AVAILABLE);
  nsCString sourceId;
  MOZ_TRY(core->ReadSourceIdForFolderAdmission(sourceId));
  return sourceId == mDatabaseSourceId ? NS_OK : NS_ERROR_NOT_AVAILABLE;
}

nsresult PerFolderDatabase::CheckEnumerationState(uint64_t generation) const {
  NS_ENSURE_TRUE(!mForceClosed && generation == mEnumeratorGeneration,
                 NS_ERROR_FAILURE);
  MOZ_TRY(mDatabaseSourceStatus);
  RefPtr<DatabaseCore> core = DatabaseCore::sInstance;
  NS_ENSURE_TRUE(core && core->mFolderDatabase && core->mMessageDatabase,
                 NS_ERROR_NOT_AVAILABLE);
  // This reader neither opens a connection nor settles a caller's transaction.
  nsCString sourceId;
  MOZ_TRY(core->ReadSourceIdForFolderAdmission(sourceId));
  NS_ENSURE_TRUE(sourceId == mDatabaseSourceId, NS_ERROR_NOT_AVAILABLE);
  return CheckFolderExists();
}

nsresult PerFolderDatabase::CheckFolderExists() const {
  NS_ENSURE_TRUE(!mForceClosed && DatabaseCore::sInstance &&
                     DatabaseCore::sInstance->mFolderDatabase,
                 NS_ERROR_NOT_AVAILABLE);
  CheckedInt<int64_t> id(mFolderId);
  NS_ENSURE_TRUE(mFolderId && id.isValid(), NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement("PerFolderDatabaseFolderExists"_ns,
                                     "SELECT 1 FROM folders WHERE id = :id"_ns,
                                     getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, id.value()));
  bool exists;
  MOZ_TRY(stmt->ExecuteStep(&exists));
  return exists ? NS_OK : NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP PerFolderDatabase::GetFolder(nsIMsgFolder** aFolder) {
  NS_ENSURE_ARG_POINTER(aFolder);
  *aFolder = nullptr;
  MOZ_TRY(CheckFolderExists());
  nsCOMPtr<nsIMsgFolder> folder;
  MOZ_TRY(FolderDB().GetMsgFolderForFolder(mFolderId, getter_AddRefs(folder)));
  NS_ENSURE_TRUE(folder, NS_ERROR_NOT_AVAILABLE);
  uint64_t id;
  MOZ_TRY(folder->GetId(&id));
  NS_ENSURE_TRUE(id == mFolderId, NS_ERROR_UNEXPECTED);
  folder.forget(aFolder);
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::GetLastUseTime(PRTime* aLastUseTime) {
  NS_ENSURE_ARG_POINTER(aLastUseTime);
  *aLastUseTime = mLastUseTime;
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::SetLastUseTime(PRTime aLastUseTime) {
  mLastUseTime = aLastUseTime;
  return NS_OK;
}
nsresult PerFolderDatabase::CacheHeader(nsMsgKey key, nsIMsgDBHdr* header) {
  // Preserve the legacy strict threshold: size zero can retain one header.
  if (mCachedHeaders.Count() > mMsgHdrCacheSize) {
    mCachedHeaders.Clear();
  }
  return mCachedHeaders.InsertOrUpdate(key, nsCOMPtr<nsIMsgDBHdr>(header),
                                       mozilla::fallible)
             ? NS_OK
             : NS_ERROR_OUT_OF_MEMORY;
}

NS_IMETHODIMP PerFolderDatabase::GetMsgHdrForKey(nsMsgKey key,
                                                 nsIMsgDBHdr** msgHdr) {
  NS_ENSURE_ARG_POINTER(msgHdr);
  *msgHdr = nullptr;
  RememberLastUseTime();
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  bool exists;
  MOZ_TRY(MessageDB().MessageExists(key, exists));
  NS_ENSURE_TRUE(exists, NS_ERROR_ILLEGAL_VALUE);
  CapturedMessage current;
  MOZ_TRY(MessageDB().CaptureMessage(key, current));
  if (current.folderId != mFolderId) {
    NS_WARNING("GetMsgHdrForKey() returned message not in folder");
    return NS_ERROR_ILLEGAL_VALUE;
  }

  // Membership and incarnation are checked even for a retained object.
  nsCOMPtr<nsIMsgDBHdr> header = mCachedHeaders.Get(key);
  if (!header) {
    RefPtr<Message> message;
    MOZ_TRY(MessageDB().GetMessage(key, getter_AddRefs(message)));
    MOZ_TRY(CacheHeader(key, message));
    header = message;
  }
  header.forget(msgHdr);
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::GetMsgHdrForMessageID(const char* messageID,
                                                       nsIMsgDBHdr** msgHdr) {
  NS_ENSURE_ARG_POINTER(msgHdr);
  *msgHdr = nullptr;
  NS_ENSURE_ARG_POINTER(messageID);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());

  RefPtr<Message> message;
  nsresult rv = MessageDB().GetMessageForMessageID(
      mFolderId, nsDependentCString(messageID), getter_AddRefs(message));
  if (rv == NS_ERROR_UNEXPECTED) {
    return NS_ERROR_ILLEGAL_VALUE;
  }
  NS_ENSURE_SUCCESS(rv, rv);
  nsMsgKey key;
  MOZ_TRY(message->GetMessageKey(&key));
  return GetMsgHdrForKey(key, msgHdr);
}
nsresult PerFolderDatabase::GetMsgHdrForProperty(const nsACString& name,
                                                 const nsACString& value,
                                                 nsIMsgDBHdr** result) {
  NS_ENSURE_ARG_POINTER(result);
  *result = nullptr;
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  nsTArray<nsMsgKey> keys;
  MOZ_TRY(ListAllKeys(keys));
  nsCOMPtr<nsIMsgDBHdr> found;
  for (nsMsgKey key : keys) {
    nsCOMPtr<nsIMsgDBHdr> header;
    MOZ_TRY(GetMsgHdrForKey(key, getter_AddRefs(header)));
    nsTArray<nsCString> names;
    MOZ_TRY(header->GetProperties(names));
    if (!names.Contains(name)) {
      continue;
    }
    nsAutoCString candidate;
    MOZ_TRY(
        header->GetStringProperty(PromiseFlatCString(name).get(), candidate));
    if (candidate.Equals(value)) {
      NS_ENSURE_FALSE(found, NS_ERROR_FILE_CORRUPTED);
      found = header;
    }
  }
  found.forget(result);
  return NS_OK;
}

NS_IMETHODIMP PerFolderDatabase::GetMsgHdrForGMMsgID(
    const char* aGmailMessageID, nsIMsgDBHdr** aRetVal) {
  NS_ENSURE_ARG_POINTER(aGmailMessageID);
  return GetMsgHdrForProperty("X-GM-MSGID"_ns,
                              nsDependentCString(aGmailMessageID), aRetVal);
}
NS_IMETHODIMP PerFolderDatabase::GetMsgHdrForEwsItemID(const nsACString& itemID,
                                                       nsIMsgDBHdr** aRetVal) {
  return GetMsgHdrForProperty("ewsId"_ns, itemID, aRetVal);
}

NS_IMETHODIMP PerFolderDatabase::ContainsKey(nsMsgKey key, bool* contains) {
  NS_ENSURE_ARG_POINTER(contains);
  *contains = false;

  bool exists;
  MOZ_TRY(MessageDB().MessageExists(key, exists));
  if (!exists) {
    return NS_OK;
  }

  // Recheck the physical row even when its old folder is still cached.
  CapturedMessage current;
  MOZ_TRY(MessageDB().CaptureMessage(key, current));
  *contains = current.folderId == mFolderId;
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::CreateNewHdr(nsIMsgDBHdr** aRetVal) {
  NS_ENSURE_ARG_POINTER(aRetVal);
  *aRetVal = nullptr;
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  RefPtr<DetachedMsgHdr> hdr = new DetachedMsgHdr(mFolderId);
  hdr->mParsedSourceId = mDatabaseSourceId;
  hdr->mPendingOwner = this;
  hdr->mPendingSourceId = mDatabaseSourceId;
  hdr.forget(aRetVal);
  return NS_OK;
}

// The existing detached implementation remains shared by all other producers.
// Only actual news drafts capture the explicit filter action before
// publication.
class NewsArticleDraft final : public DetachedMsgHdr {
 public:
  explicit NewsArticleDraft(uint64_t folderId) : DetachedMsgHdr(folderId) {}
  NS_IMETHOD MarkRead(bool read) override {
    MOZ_TRY(DetachedMsgHdr::MarkRead(read));
    mNewsReadIntent = Some(read);
    return NS_OK;
  }

 private:
  ~NewsArticleDraft() override = default;
};

NS_IMETHODIMP PerFolderDatabase::CreateNewHdrWithSpecificMsgKey(
    nsMsgKey articleNumber, nsIMsgDBHdr** result) {
  NS_ENSURE_ARG_POINTER(result);
  *result = nullptr;
  NS_ENSURE_TRUE(mIsNewsFolder && articleNumber <= INT32_MAX,
                 NS_ERROR_INVALID_ARG);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  NS_ENSURE_TRUE(mNewsGroup.isSome(), NS_ERROR_NOT_AVAILABLE);
  NewsGroupIdentity current;
  MOZ_TRY(
      MessageDB().GetNewsGroupIdentity(mDatabaseSourceId, mFolderId, current));
  NS_ENSURE_TRUE(current.incarnation == mNewsGroup->incarnation,
                 NS_ERROR_NOT_AVAILABLE);
  NewsArticleIdentity expected{current, articleNumber};
  nsMsgKey existing;
  nsresult rv = MessageDB().GetNewsArticleKey(expected, existing);
  if (NS_SUCCEEDED(rv)) {
    // A real retained article is already published; the protocol skips parser
    // edits/filter/add and uses its actual physical identity.
    return GetMsgHdrForKey(existing, result);
  }
  NS_ENSURE_TRUE(rv == NS_ERROR_NOT_AVAILABLE, rv);
  // Missing membership is accepted only in the same checked group/source.
  MOZ_TRY(CheckDatabaseSource());
  NewsGroupIdentity rechecked;
  MOZ_TRY(MessageDB().GetNewsGroupIdentity(mDatabaseSourceId, mFolderId,
                                           rechecked));
  NS_ENSURE_TRUE(rechecked.incarnation == current.incarnation,
                 NS_ERROR_NOT_AVAILABLE);
  RefPtr<DetachedMsgHdr> draft = new NewsArticleDraft(mFolderId);
  draft->mParsedSourceId = mDatabaseSourceId;
  draft->mNewsArticleNumber = Some(articleNumber);
  draft->mNewsGroupIncarnation = current.incarnation;
  draft.forget(result);
  return NS_OK;
}

nsresult PerFolderDatabase::AttachNewsHdr(DetachedMsgHdr& draft, bool notify,
                                          nsIMsgDBHdr** header) {
  NS_ENSURE_ARG_POINTER(header);
  *header = nullptr;
  NS_ENSURE_TRUE(mIsNewsFolder && draft.mNewsArticleNumber.isSome() &&
                     *draft.mNewsArticleNumber <= INT32_MAX &&
                     draft.mFolderId == mFolderId &&
                     draft.mParsedSourceId == mDatabaseSourceId &&
                     draft.mCopySourceId.IsEmpty(),
                 NS_ERROR_INVALID_ARG);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  NS_ENSURE_TRUE(mNewsGroup.isSome() &&
                     mNewsGroup->incarnation == draft.mNewsGroupIncarnation,
                 NS_ERROR_NOT_AVAILABLE);
  if (draft.mAttachState == DetachedMsgHdr::AttachState::Attached) {
    nsCOMPtr<nsIMsgDBHdr> live = draft.mAttachedHeader;
    live.forget(header);
    return NS_OK;
  }
  MOZ_TRY(draft.CheckMutable());
  RefPtr<PerFolderDatabase> self(this);
  RefPtr<DetachedMsgHdr> pinned(&draft);
  (void)pinned;
  nsresult rv = NS_OK;
  nsCOMPtr<nsIMsgFolderNotificationService> notifier;
  if (notify) {
    // Prepare the existing global notifier before any native settlement.
    notifier = components::FolderNotification::Service(&rv);
    NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(notifier, NS_ERROR_NOT_AVAILABLE);
  }
  draft.mAttachState = DetachedMsgHdr::AttachState::Attaching;
  NewsArticleIdentity expected{*mNewsGroup, *draft.mNewsArticleNumber};
  // The public AttachHdr owning output is filled by Core before callbacks.
  // The draft remains explicitly keyless and sealed, never a live proxy.
  rv = MessageDB().AddNewsArticle(expected, draft.mRaw, notify,
                                  draft.mNewsResult, header,
                                  draft.mNewsReadIntent);
  if (NS_FAILED(rv)) {
    draft.mAttachError = rv;
    draft.mAttachState = DetachedMsgHdr::AttachState::Failed;
    return rv;
  }
  MOZ_ASSERT(draft.mNewsResult.header &&
             draft.mNewsResult.physicalKey != nsMsgKey_None);
  draft.mAttachedHeader = draft.mNewsResult.header;
  draft.mAttachState = DetachedMsgHdr::AttachState::Attached;
  MOZ_ASSERT(*header == draft.mNewsResult.header);
  if (notifier && draft.mNewsResult.inserted) {
    // Existing global notification is once per actual insertion, including a
    // reentrant duplicate race. OP omits its native manual MFN notification.
    notifier->NotifyMsgAdded(draft.mNewsResult.header);
  }
  return NS_OK;
}

NS_IMETHODIMP PerFolderDatabase::AddNewHdrToDB(nsIMsgDBHdr* newHdr,
                                               bool notify) {
  NS_ENSURE_ARG(newHdr);
  RefPtr<DetachedMsgHdr> draft = do_QueryObject(newHdr);
  NS_ENSURE_TRUE(draft, NS_ERROR_INVALID_ARG);
  nsCOMPtr<nsIMsgDBHdr> live;
  return AttachNewsHdr(*draft, notify, getter_AddRefs(live));
}

nsresult PerFolderDatabase::CompletePartialHdr(
    const MessageBodyState& expected, nsIMsgDBHdr* parsed,
    const FinishedMessageBody& finished, nsIMsgDBHdr** realHdr) {
  NS_ENSURE_ARG_POINTER(realHdr);
  *realHdr = nullptr;
  NS_ENSURE_ARG(parsed);
  MOZ_TRY(CheckFolderExists());
  NS_ENSURE_TRUE(expected.folderId == mFolderId, NS_ERROR_INVALID_ARG);
  bool isLive;
  MOZ_TRY(parsed->GetIsLive(&isLive));
  NS_ENSURE_FALSE(isLive, NS_ERROR_INVALID_ARG);
  // Only native parser drafts carry the raw header and attachment state.
  RefPtr<DetachedMsgHdr> draft = do_QueryObject(parsed);
  NS_ENSURE_TRUE(draft, NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(draft->mFolderId == mFolderId, NS_ERROR_INVALID_ARG);
  MOZ_TRY(draft->CheckMutable());
  RefPtr<PerFolderDatabase> self(this);
  draft->mAttachState = DetachedMsgHdr::AttachState::Attaching;
  nsCOMPtr<nsIMsgDBHdr> live;
  nsresult rv = [&]() -> nsresult {
    // Prepare the result before mutation; no read can fail after commit.
    MOZ_TRY(GetMsgHdrForKey(expected.key, getter_AddRefs(live)));
    MessageBodyState updated;
    return MessageDB().CompletePartialMessage(expected, draft->mRaw, finished,
                                              updated);
  }();
  if (NS_FAILED(rv)) {
    // Finished bytes remain caller-owned; an error does not authorize replay.
    draft->mAttachError = rv;
    draft->mAttachState = DetachedMsgHdr::AttachState::Failed;
    return rv;
  }
  draft->mAttachedHeader = live;
  draft->mAttachState = DetachedMsgHdr::AttachState::Attached;
  live.forget(realHdr);
  return NS_OK;
}

NS_IMETHODIMP PerFolderDatabase::AttachHdr(nsIMsgDBHdr* detachedHdr,
                                           bool notify, nsIMsgDBHdr** realHdr) {
  NS_ENSURE_ARG(detachedHdr);
  NS_ENSURE_ARG_POINTER(realHdr);

  bool isLive;
  nsresult rv = detachedHdr->GetIsLive(&isLive);
  NS_ENSURE_SUCCESS(rv, rv);
  if (isLive) {
    NS_ERROR("Live nsIMsgDBHdr passed in to AttachHdr()");
    return NS_ERROR_INVALID_ARG;
  }

  // Publication state alone does not identify a native parser draft.
  RefPtr<DetachedMsgHdr> draft = do_QueryObject(detachedHdr);
  NS_ENSURE_TRUE(draft, NS_ERROR_INVALID_ARG);
  if (draft->mFolderId != mFolderId) {
    return NS_ERROR_INVALID_ARG;
  }
  if (draft->mNewsArticleNumber.isSome()) {
    return AttachNewsHdr(*draft, notify, realHdr);
  }
  if (draft->mAttachState == DetachedMsgHdr::AttachState::Attached) {
    nsCOMPtr<nsIMsgDBHdr> live = draft->mAttachedHeader;
    live.forget(realHdr);
    return NS_OK;
  }
  MOZ_TRY(draft->CheckMutable());
  if (!draft->mPendingAttributes.IsEmpty()) {
    MOZ_TRY(UpdatePendingAttributes(draft));
  }
  draft->mAttachState = DetachedMsgHdr::AttachState::Attaching;
  nsCOMPtr<nsIMsgDBHdr> live;
  rv = AddMsgHdr(&draft->mRaw, notify, getter_AddRefs(live));
  if (NS_FAILED(rv)) {
    // An error does not establish that SQL settlement permits replay.
    draft->mAttachError = rv;
    draft->mAttachState = DetachedMsgHdr::AttachState::Failed;
    return rv;
  }
  draft->mAttachedHeader = live;
  draft->mAttachState = DetachedMsgHdr::AttachState::Attached;
  live.forget(realHdr);
  return NS_OK;
}

struct FolderRepair::Data {
  enum class State { Collecting, Settling, Committed, Aborted };
  struct Entry {
    RefPtr<DetachedMsgHdr> draft;
    nsCString token;
    uint64_t size;
  };
  FolderRepairSnapshot snapshot;
  nsCString sourceId;
  nsTArray<Entry> entries;
  State state = State::Collecting;
  nsresult firstError = NS_OK;
};

FolderRepair::FolderRepair(PerFolderDatabase* owner)
    : mOwner(owner), mData(new (fallible) Data()) {}
FolderRepair::~FolderRepair() = default;

nsresult PerFolderDatabase::CheckFolderRepair(FolderRepair* repair) {
  NS_ENSURE_ARG(repair);
  NS_ENSURE_TRUE(repair->mOwner.get() == this && repair->mData,
                 NS_ERROR_INVALID_ARG);
  auto& data = *repair->mData;
  if (data.state == FolderRepair::Data::State::Settling) {
    return NS_ERROR_IN_PROGRESS;
  }
  if (NS_FAILED(data.firstError)) {
    return data.firstError;
  }
  NS_ENSURE_TRUE(data.state == FolderRepair::Data::State::Collecting,
                 NS_ERROR_ALREADY_INITIALIZED);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  NS_ENSURE_TRUE(data.sourceId == mDatabaseSourceId, NS_ERROR_NOT_AVAILABLE);
  return CheckParsedServerWriteTransaction();
}

nsresult PerFolderDatabase::FailFolderRepair(FolderRepair& repair,
                                             nsresult failure) {
  auto& data = *repair.mData;
  if (NS_FAILED(failure) && NS_SUCCEEDED(data.firstError)) {
    data.firstError = failure;
    for (auto& entry : data.entries) {
      entry.draft->mAttachError = failure;
      entry.draft->mAttachState = DetachedMsgHdr::AttachState::Failed;
    }
  }
  return data.firstError;
}

nsresult PerFolderDatabase::BeginFolderRepair(FolderRepair** repair) {
  NS_ENSURE_ARG_POINTER(repair);
  NS_ENSURE_FALSE(*repair, NS_ERROR_INVALID_ARG);
  RefPtr<PerFolderDatabase> self(this);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  MOZ_TRY(CheckParsedServerWriteTransaction());
  RefPtr<FolderRepair> result = new (fallible) FolderRepair(this);
  NS_ENSURE_TRUE(result && result->mData, NS_ERROR_OUT_OF_MEMORY);
  result->mData->sourceId = mDatabaseSourceId;
  // This is intentionally durable before the scan. Failure must not claim a
  // valid summary; only the complete native metadata transaction restores it.
  MOZ_TRY(SetSummaryValid(false));
  MOZ_TRY(MessageDB().CaptureFolderRepair(mFolderId, mDatabaseSourceId,
                                          result->mData->snapshot));
  result.forget(repair);
  return NS_OK;
}

nsresult PerFolderDatabase::AddFolderRepairMessage(
    FolderRepair* repair, nsIMsgDBHdr* parsed,
    const nsACString& scannedStoreToken, uint64_t scannedMessageSize) {
  RefPtr<PerFolderDatabase> self(this);
  RefPtr<FolderRepair> selected(repair);
  NS_ENSURE_ARG(repair);
  NS_ENSURE_TRUE(repair->mOwner.get() == this && repair->mData,
                 NS_ERROR_INVALID_ARG);
  auto& data = *repair->mData;
  nsresult rv = CheckFolderRepair(repair);
  if (NS_FAILED(rv)) {
    // A reentrant/caller-transaction refusal must not consume the operation.
    return rv == NS_ERROR_IN_PROGRESS ||
                   data.state != FolderRepair::Data::State::Collecting
               ? rv
               : FailFolderRepair(*repair, rv);
  }
  RefPtr<DetachedMsgHdr> draft = do_QueryObject(parsed);
  if (!draft || draft->mFolderId != mFolderId ||
      !draft->mParsedSourceId.Equals(data.sourceId) ||
      !draft->mCopySourceId.IsEmpty()) {
    return FailFolderRepair(*repair, NS_ERROR_INVALID_ARG);
  }
  if (scannedStoreToken.IsEmpty()) {
    return FailFolderRepair(*repair, NS_ERROR_INVALID_ARG);
  }
  if (scannedMessageSize > UINT32_MAX) {
    return FailFolderRepair(*repair, NS_ERROR_FILE_TOO_BIG);
  }
  for (const auto& entry : data.entries) {
    if (entry.draft == draft || entry.token.Equals(scannedStoreToken)) {
      return FailFolderRepair(*repair, NS_ERROR_INVALID_ARG);
    }
  }
  rv = draft->CheckMutable();
  if (NS_FAILED(rv)) {
    return FailFolderRepair(*repair, rv);
  }
  const RawHdr& raw = draft->mRaw;
  if (!raw.storeToken || !raw.storeToken->Equals(scannedStoreToken) ||
      !raw.messageSize || *raw.messageSize != scannedMessageSize ||
      !raw.lineCount || (raw.flags & nsMsgMessageFlags::Expunged)) {
    return FailFolderRepair(*repair, NS_ERROR_INVALID_ARG);
  }
  if (!data.entries.AppendElement(
          FolderRepair::Data::Entry{draft, nsCString(scannedStoreToken),
                                    scannedMessageSize},
          fallible)) {
    return FailFolderRepair(*repair, NS_ERROR_OUT_OF_MEMORY);
  }
  // No native stage or row is allocated here. Keep the exact parser data sealed
  // through parser Clear and the asynchronous scan's remaining callbacks.
  draft->mAttachState = DetachedMsgHdr::AttachState::Attaching;
  return NS_OK;
}

nsresult PerFolderDatabase::CommitFolderRepair(
    FolderRepair* repair, nsresult scanStatus, bool scanComplete,
    nsTArray<RefPtr<Message>>& repaired) {
  RefPtr<PerFolderDatabase> self(this);
  RefPtr<FolderRepair> selected(repair);
  NS_ENSURE_ARG(repair);
  NS_ENSURE_TRUE(repair->mOwner.get() == this && repair->mData,
                 NS_ERROR_INVALID_ARG);
  auto& data = *repair->mData;
  if (data.state == FolderRepair::Data::State::Settling) {
    return NS_ERROR_IN_PROGRESS;
  }
  NS_ENSURE_TRUE(repaired.IsEmpty(), NS_ERROR_INVALID_ARG);
  NS_ENSURE_FALSE(data.state == FolderRepair::Data::State::Committed,
                  NS_ERROR_ALREADY_INITIALIZED);
  if (NS_FAILED(data.firstError)) {
    return data.firstError;
  }
  if (NS_FAILED(scanStatus)) {
    return FailFolderRepair(*repair, scanStatus);
  }
  if (!scanComplete) {
    return FailFolderRepair(*repair, NS_ERROR_NOT_AVAILABLE);
  }
  nsresult rv = CheckFolderRepair(repair);
  if (NS_FAILED(rv)) {
    return rv == NS_ERROR_IN_PROGRESS ||
                   data.state != FolderRepair::Data::State::Collecting
               ? rv
               : FailFolderRepair(*repair, rv);
  }
  nsTArray<FolderRepairMessage> inputs;
  if (!inputs.SetCapacity(data.entries.Length(), fallible)) {
    return FailFolderRepair(*repair, NS_ERROR_OUT_OF_MEMORY);
  }
  for (const auto& entry : data.entries) {
    FolderRepairMessage& input = *inputs.AppendElement();
    input.parsed = &entry.draft->mRaw;
    input.storeToken = entry.token;
    input.messageSize = entry.size;
    input.lineCount = *entry.draft->mRaw.lineCount;
    // Normal parser FinalizeHeaders always calls SetReferences, including an
    // empty known set when neither References nor In-Reply-To is present.
    input.referencesKnown = true;
  }
  data.state = FolderRepair::Data::State::Settling;
  rv = MessageDB().CompleteFolderRepair(data.snapshot, inputs, scanStatus,
                                        scanComplete, repaired);
  if (NS_FAILED(rv)) {
    data.state = FolderRepair::Data::State::Collecting;
    return FailFolderRepair(*repair, rv);
  }
  // Core preallocates and installs every scan-order output before callbacks.
  // No fallible lookup, allocation or validity setter follows its commit.
  MOZ_ASSERT(repaired.Length() == data.entries.Length());
  data.state = FolderRepair::Data::State::Committed;
  for (size_t i = 0; i < data.entries.Length(); ++i) {
    data.entries[i].draft->mAttachedHeader = repaired[i];
    data.entries[i].draft->mAttachState = DetachedMsgHdr::AttachState::Attached;
  }
  return NS_OK;
}

nsresult PerFolderDatabase::AbortFolderRepair(FolderRepair* repair,
                                              nsresult firstError) {
  RefPtr<PerFolderDatabase> self(this);
  RefPtr<FolderRepair> selected(repair);
  NS_ENSURE_ARG(repair);
  NS_ENSURE_TRUE(repair->mOwner.get() == this && repair->mData,
                 NS_ERROR_INVALID_ARG);
  auto& data = *repair->mData;
  if (data.state == FolderRepair::Data::State::Settling) {
    return NS_ERROR_IN_PROGRESS;
  }
  NS_ENSURE_FALSE(data.state == FolderRepair::Data::State::Committed,
                  NS_ERROR_ALREADY_INITIALIZED);
  NS_ENSURE_TRUE(NS_FAILED(firstError), NS_ERROR_INVALID_ARG);
  nsresult rv = FailFolderRepair(*repair, firstError);
  data.state = FolderRepair::Data::State::Aborted;
  return rv;
}

ParsedServerHdr::ParsedServerHdr(PerFolderDatabase* owner,
                                 DetachedMsgHdr* draft, uint32_t epoch,
                                 uint32_t uid)
    : mOwner(owner), mDraft(draft), mSourceId(owner->mDatabaseSourceId) {
  mLocation.folderId = owner->mFolderId;
  mLocation.epoch = epoch;
  mLocation.uid = uid;
}

ParsedServerHdr::~ParsedServerHdr() = default;

NS_IMPL_ADDREF(ParsedServerHdr)
NS_IMPL_RELEASE(ParsedServerHdr)
NS_INTERFACE_MAP_BEGIN(ParsedServerHdr)
  NS_INTERFACE_MAP_ENTRY(nsIMsgDBHdr)
  NS_INTERFACE_MAP_ENTRY(DecodedSubjectHdr)
  NS_INTERFACE_MAP_ENTRY(nsISupports)
  NS_INTERFACE_MAP_ENTRY_CONCRETE(ParsedServerHdr)
NS_INTERFACE_MAP_END

nsresult ParsedServerHdr::Check(bool writing) {
  if (mState == State::Publishing || (writing && mWriting))
    return NS_ERROR_IN_PROGRESS;
  if (NS_FAILED(mError)) return mError;
  if (mState == State::Aborted) return NS_ERROR_NOT_AVAILABLE;
  MOZ_TRY(mOwner->ValidateParsedServerHdr(*this));
  if (writing) {
    MOZ_TRY(mOwner->CheckParsedServerWriteTransaction());
  }
  return NS_OK;
}

nsresult ParsedServerHdr::FinishWrite(nsresult rv) {
  if (NS_FAILED(rv) && NS_SUCCEEDED(mError)) {
    mError = rv;
    if (mState == State::Staged) {
      mDraft->mAttachError = rv;
      mDraft->mAttachState = DetachedMsgHdr::AttachState::Failed;
    }
  }
  return rv;
}

nsresult ParsedServerHdr::CheckProperty(const char* name) const {
  NS_ENSURE_ARG_POINTER(name);
  if (mState == State::Staged) {
    nsDependentCString property(name);
    NS_ENSURE_FALSE(property.EqualsLiteral("uidOnServer") ||
                        property.EqualsLiteral("storeToken") ||
                        property.EqualsLiteral("msgOffset") ||
                        property.EqualsLiteral("messageSize") ||
                        property.EqualsLiteral("offlineMessageSize") ||
                        property.EqualsLiteral("offlineMsgSize") ||
                        property.EqualsLiteral("lineCount"),
                    NS_ERROR_INVALID_ARG);
  }
  return NS_OK;
}

nsresult ParsedServerHdr::CheckFlags(uint32_t flags) const {
  if (mState == State::Staged) {
    uint32_t previous;
    MOZ_TRY(mHeader->GetFlags(&previous));
    NS_ENSURE_FALSE((previous ^ flags) & (nsMsgMessageFlags::Offline |
                                          nsMsgMessageFlags::Expunged),
                    NS_ERROR_INVALID_ARG);
  }
  return NS_OK;
}

nsresult ParsedServerHdr::GetLocation(ServerMessageLocation& location) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  location = mLocation;
  return NS_OK;
}

nsresult ParsedServerHdr::UpdateKeywords(const nsACString& keywords, bool add) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  nsCString result;
  MOZ_TRY(mHeader->GetStringProperty("keywords", result));
  nsTArray<nsCString> changes;
  ParseString(keywords, ' ', changes);
  for (const auto& token : changes) {
    int32_t start, length;
    bool present = MsgFindKeyword(token, result, &start, &length);
    if (add) {
      if (!present) {
        if (!result.IsEmpty()) result.Append(' ');
        result.Append(token);
      }
    } else if (present) {
      while (start && result.CharAt(start - 1) == ' ') {
        --start;
        ++length;
      }
      if (!start && length < static_cast<int32_t>(result.Length()) &&
          result.CharAt(length) == ' ') {
        ++length;
      }
      result.Cut(start, length);
    }
  }
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetStringProperty("keywords", result));
}

nsresult ParsedServerHdr::GetExistingThread(nsIMsgThread** thread) {
  RefPtr<ParsedServerHdr> self(this);
  NS_ENSURE_ARG_POINTER(thread);
  NS_ENSURE_FALSE(*thread, NS_ERROR_INVALID_ARG);
  MOZ_TRY(Check());
  nsMsgKey threadId;
  MOZ_TRY(mHeader->GetThreadId(&threadId));
  NS_ENSURE_TRUE(threadId && threadId != nsMsgKey_None, NS_ERROR_NOT_AVAILABLE);
  RefPtr<Thread> existing = new Thread(mLocation.folderId, threadId);
  uint32_t children;
  MOZ_TRY(existing->GetNumChildren(&children));
  if (children) existing.forget(thread);
  return NS_OK;
}

nsresult PerFolderDatabase::CheckParsedServerWriteTransaction() const {
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  return active ? NS_ERROR_IN_PROGRESS : NS_OK;
}

nsresult PerFolderDatabase::CheckParsedServerUid(uint32_t epoch, uint32_t uid,
                                                 nsMsgKey ownKey) {
  NS_ENSURE_TRUE(epoch && uid, NS_ERROR_INVALID_ARG);
  uint32_t current;
  MOZ_TRY(FolderDB().GetFolderUidValidity(mFolderId, current));
  NS_ENSURE_TRUE(current == epoch, NS_ERROR_NOT_AVAILABLE);
  nsMsgKey published = nsMsgKey_None;
  nsresult rv =
      MessageDB().GetMessageKeyForServerUid(mFolderId, epoch, uid, published);
  if (NS_FAILED(rv) && rv != NS_ERROR_NOT_AVAILABLE) return rv;
  NS_ENSURE_FALSE(NS_SUCCEEDED(rv) && published != ownKey,
                  NS_ERROR_ALREADY_INITIALIZED);
  nsTArray<nsMsgKey> keys;
  MOZ_TRY(MessageDB().ListStagedMessages(mFolderId, keys));
  for (nsMsgKey key : keys) {
    if (key == ownKey) continue;
    nsTArray<nsCString> names;
    MOZ_TRY(MessageDB().GetMessagePropertyNames(key, names));
    if (!names.Contains("uidOnServer"_ns)) continue;
    RefPtr<Message> header = new Message(key);
    uint32_t otherUid;
    MOZ_TRY(header->GetUint32Property("uidOnServer", &otherUid));
    NS_ENSURE_FALSE(otherUid == uid, NS_ERROR_ALREADY_INITIALIZED);
  }
  return NS_OK;
}

nsresult PerFolderDatabase::ValidateParsedServerHdr(ParsedServerHdr& staged,
                                                    bool requireStaged) {
  NS_ENSURE_TRUE(staged.mOwner.get() == this, NS_ERROR_INVALID_ARG);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  NS_ENSURE_TRUE(staged.mSourceId == mDatabaseSourceId &&
                     staged.mLocation.folderId == mFolderId,
                 NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(staged.mHeader && staged.mLocation.key &&
                     staged.mLocation.key != nsMsgKey_None,
                 NS_ERROR_NOT_AVAILABLE);
  if (requireStaged && staged.mState != ParsedServerHdr::State::Staged)
    return NS_ERROR_ALREADY_INITIALIZED;
  Maybe<CapturedMessage> current;
  MOZ_TRY(MessageDB().CaptureHeaderState(staged.mLocation.key, current));
  NS_ENSURE_TRUE(current && current->folderId == mFolderId,
                 NS_ERROR_NOT_AVAILABLE);
  bool published;
  MOZ_TRY(MessageDB().MessageExists(staged.mLocation.key, published));
  NS_ENSURE_TRUE(
      published == (staged.mState == ParsedServerHdr::State::Published),
      NS_ERROR_NOT_AVAILABLE);
  nsTArray<nsCString> names;
  MOZ_TRY(MessageDB().GetMessagePropertyNames(staged.mLocation.key, names));
  NS_ENSURE_TRUE(names.Contains("uidOnServer"_ns), NS_ERROR_NOT_AVAILABLE);
  uint32_t uid;
  MOZ_TRY(staged.mHeader->GetUint32Property("uidOnServer", &uid));
  NS_ENSURE_TRUE(uid == staged.mLocation.uid, NS_ERROR_NOT_AVAILABLE);
  return CheckParsedServerUid(staged.mLocation.epoch, uid,
                              staged.mLocation.key);
}

nsresult PerFolderDatabase::StageParsedServerHdr(nsIMsgDBHdr* parsed,
                                                 uint32_t epoch, uint32_t uid,
                                                 ParsedServerHdr** staged) {
  NS_ENSURE_ARG_POINTER(staged);
  NS_ENSURE_FALSE(*staged, NS_ERROR_INVALID_ARG);
  NS_ENSURE_ARG(parsed);
  RefPtr<PerFolderDatabase> self(this);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  RefPtr<DetachedMsgHdr> draft = do_QueryObject(parsed);
  NS_ENSURE_TRUE(draft && draft->mFolderId == mFolderId, NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(draft->mCopySourceId.IsEmpty(), NS_ERROR_INVALID_ARG);
  MOZ_TRY(draft->CheckMutable());
  nsTArray<nsCString> names;
  MOZ_TRY(draft->GetProperties(names));
  NS_ENSURE_TRUE(names.Contains("uidOnServer"_ns), NS_ERROR_NOT_AVAILABLE);
  uint32_t actual;
  MOZ_TRY(draft->GetUint32Property("uidOnServer", &actual));
  NS_ENSURE_TRUE(actual == uid, NS_ERROR_NOT_AVAILABLE);
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(CheckParsedServerUid(epoch, uid));
  RefPtr<ParsedServerHdr> result =
      new (fallible) ParsedServerHdr(this, draft, epoch, uid);
  NS_ENSURE_TRUE(result, NS_ERROR_OUT_OF_MEMORY);
  draft->mAttachState = DetachedMsgHdr::AttachState::Attaching;
  nsresult rv =
      MessageDB().StageMessage(mFolderId, draft->mRaw, &result->mLocation.key,
                               getter_AddRefs(result->mHeader));
  if (NS_FAILED(rv)) {
    draft->mAttachError = rv;
    draft->mAttachState = DetachedMsgHdr::AttachState::Failed;
    return rv;
  }
  result.forget(staged);
  return NS_OK;
}

nsresult PerFolderDatabase::PublishParsedServerHdr(ParsedServerHdr* staged,
                                                   bool notifyLegacy,
                                                   Message** liveHeader) {
  RefPtr<ParsedServerHdr> selected(staged);
  RefPtr<PerFolderDatabase> self(this);
  NS_ENSURE_ARG_POINTER(liveHeader);
  NS_ENSURE_FALSE(*liveHeader, NS_ERROR_INVALID_ARG);
  NS_ENSURE_ARG(staged);
  NS_ENSURE_TRUE(staged->mOwner.get() == this, NS_ERROR_INVALID_ARG);
  MOZ_TRY(staged->Check(true));
  MOZ_TRY(ValidateParsedServerHdr(*staged, true));
  // A nested native publication queues its callback until the current fanout
  // ends. Keep this exact key's intent in the owning facade, not on the stack
  // or in the caller's possibly released capability. Allocate before commit.
  if (staged->mSuppressNew &&
      !mParsedServerNotNew.AppendElement(staged->mLocation.key, fallible)) {
    return staged->FinishWrite(NS_ERROR_OUT_OF_MEMORY);
  }
  staged->mState = ParsedServerHdr::State::Publishing;
  nsresult rv = MessageDB().PublishMessage(staged->mLocation.key, notifyLegacy,
                                           liveHeader);
  if (NS_FAILED(rv)) {
    mParsedServerNotNew.RemoveElement(staged->mLocation.key);
    staged->mState = ParsedServerHdr::State::Staged;
    return staged->FinishWrite(rv);
  }
  staged->mState = ParsedServerHdr::State::Published;
  staged->mHeader = *liveHeader;
  staged->mDraft->mAttachedHeader = *liveHeader;
  staged->mDraft->mAttachState = DetachedMsgHdr::AttachState::Attached;
  return NS_OK;
}

nsresult PerFolderDatabase::AbortParsedServerHdr(ParsedServerHdr* staged) {
  RefPtr<ParsedServerHdr> selected(staged);
  RefPtr<PerFolderDatabase> self(this);
  NS_ENSURE_ARG(staged);
  NS_ENSURE_TRUE(staged->mOwner.get() == this, NS_ERROR_INVALID_ARG);
  NS_ENSURE_FALSE(
      staged->mWriting || staged->mState == ParsedServerHdr::State::Publishing,
      NS_ERROR_IN_PROGRESS);
  NS_ENSURE_TRUE(staged->mState == ParsedServerHdr::State::Staged,
                 NS_ERROR_ALREADY_INITIALIZED);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  NS_ENSURE_TRUE(staged->mSourceId == mDatabaseSourceId,
                 NS_ERROR_NOT_AVAILABLE);
  Maybe<CapturedMessage> current;
  MOZ_TRY(MessageDB().CaptureHeaderState(staged->mLocation.key, current));
  NS_ENSURE_TRUE(current && current->folderId == mFolderId,
                 NS_ERROR_NOT_AVAILABLE);
  bool published;
  MOZ_TRY(MessageDB().MessageExists(staged->mLocation.key, published));
  NS_ENSURE_FALSE(published, NS_ERROR_ALREADY_INITIALIZED);
  // The exact owned row may be abandoned after epoch retirement or a prior
  // error. AbortMessage independently refuses in-flight operation custody.
  MOZ_TRY(MessageDB().AbortMessage(staged->mLocation.key));
  mParsedServerNotNew.RemoveElement(staged->mLocation.key);
  staged->mState = ParsedServerHdr::State::Aborted;
  if (NS_SUCCEEDED(staged->mError)) staged->mError = NS_ERROR_ABORT;
  staged->mDraft->mAttachError = staged->mError;
  staged->mDraft->mAttachState = DetachedMsgHdr::AttachState::Failed;
  return NS_OK;
}

NS_IMETHODIMP
ParsedServerHdr::SetStringProperty(const char* propertyName,
                                   const nsACString& propertyValue) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  MOZ_TRY(CheckProperty(propertyName));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetStringProperty(propertyName, propertyValue));
}

NS_IMETHODIMP
ParsedServerHdr::GetStringProperty(const char* propertyName,
                                   nsACString& propertyValue) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetStringProperty(propertyName, propertyValue);
}

NS_IMETHODIMP
ParsedServerHdr::GetUint32Property(const char* propertyName,
                                   uint32_t* propertyValue) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetUint32Property(propertyName, propertyValue);
}

NS_IMETHODIMP
ParsedServerHdr::SetUint32Property(const char* propertyName,
                                   uint32_t propertyValue) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  MOZ_TRY(CheckProperty(propertyName));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetUint32Property(propertyName, propertyValue));
}

NS_IMETHODIMP
ParsedServerHdr::GetProperties(nsTArray<nsCString>& properties) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetProperties(properties);
}

NS_IMETHODIMP
ParsedServerHdr::GetIsRead(bool* isRead) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetIsRead(isRead);
}

NS_IMETHODIMP
ParsedServerHdr::GetIsFlagged(bool* isFlagged) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetIsFlagged(isFlagged);
}

NS_IMETHODIMP
ParsedServerHdr::GetIsKilled(bool* isKilled) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetIsKilled(isKilled);
}

NS_IMETHODIMP
ParsedServerHdr::MarkRead(bool read) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->MarkRead(read));
}

NS_IMETHODIMP
ParsedServerHdr::MarkFlagged(bool flagged) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->MarkFlagged(flagged));
}

NS_IMETHODIMP
ParsedServerHdr::MarkHasAttachments(bool hasAttachments) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->MarkHasAttachments(hasAttachments));
}

NS_IMETHODIMP
ParsedServerHdr::GetPriority(nsMsgPriorityValue* priority) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetPriority(priority);
}

NS_IMETHODIMP
ParsedServerHdr::SetPriority(nsMsgPriorityValue priority) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetPriority(priority));
}

NS_IMETHODIMP
ParsedServerHdr::GetFlags(uint32_t* flags) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetFlags(flags);
}

NS_IMETHODIMP
ParsedServerHdr::SetFlags(uint32_t flags) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  MOZ_TRY(CheckFlags(flags));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  nsresult rv = FinishWrite(mHeader->SetFlags(flags));
  if (NS_SUCCEEDED(rv) && mState == State::Staged) {
    mSuppressNew = !(flags & nsMsgMessageFlags::New);
  }
  return rv;
}

NS_IMETHODIMP
ParsedServerHdr::OrFlags(uint32_t flags, uint32_t* outFlags) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  uint32_t previous;
  MOZ_TRY(mHeader->GetFlags(&previous));
  MOZ_TRY(CheckFlags(previous | flags));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  nsresult rv = FinishWrite(mHeader->OrFlags(flags, outFlags));
  if (NS_SUCCEEDED(rv) && mState == State::Staged &&
      (flags & nsMsgMessageFlags::New)) {
    mSuppressNew = false;
  }
  return rv;
}

NS_IMETHODIMP
ParsedServerHdr::AndFlags(uint32_t flags, uint32_t* outFlags) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  uint32_t previous;
  MOZ_TRY(mHeader->GetFlags(&previous));
  MOZ_TRY(CheckFlags(previous & flags));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  nsresult rv = FinishWrite(mHeader->AndFlags(flags, outFlags));
  if (NS_SUCCEEDED(rv) && mState == State::Staged &&
      !(flags & nsMsgMessageFlags::New)) {
    mSuppressNew = true;
  }
  return rv;
}

NS_IMETHODIMP
ParsedServerHdr::GetThreadId(nsMsgKey* threadId) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetThreadId(threadId);
}

NS_IMETHODIMP
ParsedServerHdr::SetThreadId(nsMsgKey threadId) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetThreadId(threadId));
}

NS_IMETHODIMP
ParsedServerHdr::GetMessageKey(nsMsgKey* key) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetMessageKey(key);
}

NS_IMETHODIMP
ParsedServerHdr::SetMessageKey(nsMsgKey key) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetMessageKey(key));
}

NS_IMETHODIMP
ParsedServerHdr::GetThreadParent(nsMsgKey* threadParent) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetThreadParent(threadParent);
}

NS_IMETHODIMP
ParsedServerHdr::SetThreadParent(nsMsgKey threadParent) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetThreadParent(threadParent));
}

NS_IMETHODIMP
ParsedServerHdr::GetMessageSize(uint32_t* messageSize) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetMessageSize(messageSize);
}

NS_IMETHODIMP
ParsedServerHdr::SetMessageSize(uint32_t messageSize) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  NS_ENSURE_FALSE(mState == State::Staged, NS_ERROR_INVALID_ARG);
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetMessageSize(messageSize));
}

NS_IMETHODIMP
ParsedServerHdr::GetLineCount(uint32_t* lineCount) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetLineCount(lineCount);
}

NS_IMETHODIMP
ParsedServerHdr::SetLineCount(uint32_t lineCount) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  NS_ENSURE_FALSE(mState == State::Staged, NS_ERROR_INVALID_ARG);
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetLineCount(lineCount));
}

NS_IMETHODIMP
ParsedServerHdr::GetStoreToken(nsACString& storeToken) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetStoreToken(storeToken);
}

NS_IMETHODIMP
ParsedServerHdr::SetStoreToken(const nsACString& storeToken) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  NS_ENSURE_FALSE(mState == State::Staged, NS_ERROR_INVALID_ARG);
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetStoreToken(storeToken));
}

NS_IMETHODIMP
ParsedServerHdr::GetOfflineMessageSize(uint32_t* offlineMessageSize) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetOfflineMessageSize(offlineMessageSize);
}

NS_IMETHODIMP
ParsedServerHdr::SetOfflineMessageSize(uint32_t offlineMessageSize) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  NS_ENSURE_FALSE(mState == State::Staged, NS_ERROR_INVALID_ARG);
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetOfflineMessageSize(offlineMessageSize));
}

NS_IMETHODIMP
ParsedServerHdr::GetDate(PRTime* date) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetDate(date);
}

NS_IMETHODIMP
ParsedServerHdr::SetDate(PRTime date) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetDate(date));
}

NS_IMETHODIMP
ParsedServerHdr::GetDateInSeconds(uint32_t* dateInSeconds) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetDateInSeconds(dateInSeconds);
}

NS_IMETHODIMP
ParsedServerHdr::GetMessageId(nsACString& messageId) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetMessageId(messageId);
}

NS_IMETHODIMP
ParsedServerHdr::SetMessageId(const nsACString& messageId) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetMessageId(messageId));
}

NS_IMETHODIMP
ParsedServerHdr::GetCcList(nsACString& ccList) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetCcList(ccList);
}

NS_IMETHODIMP
ParsedServerHdr::SetCcList(const nsACString& ccList) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetCcList(ccList));
}

NS_IMETHODIMP
ParsedServerHdr::GetBccList(nsACString& bccList) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetBccList(bccList);
}

NS_IMETHODIMP
ParsedServerHdr::SetBccList(const nsACString& bccList) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetBccList(bccList));
}

NS_IMETHODIMP
ParsedServerHdr::GetAuthor(nsACString& author) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetAuthor(author);
}

NS_IMETHODIMP
ParsedServerHdr::SetAuthor(const nsACString& author) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetAuthor(author));
}

NS_IMETHODIMP
ParsedServerHdr::GetSubject(nsACString& subject) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetSubject(subject);
}

NS_IMETHODIMP
ParsedServerHdr::SetSubject(const nsACString& subject) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetSubject(subject));
}

NS_IMETHODIMP
ParsedServerHdr::GetRecipients(nsACString& recipients) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetRecipients(recipients);
}

NS_IMETHODIMP
ParsedServerHdr::SetRecipients(const nsACString& recipients) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetRecipients(recipients));
}

NS_IMETHODIMP
ParsedServerHdr::SetReferences(const nsACString& references) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetReferences(references));
}

NS_IMETHODIMP
ParsedServerHdr::GetNumReferences(uint16_t* numReferences) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetNumReferences(numReferences);
}

NS_IMETHODIMP
ParsedServerHdr::GetStringReference(int32_t refNum, nsACString& reference) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetStringReference(refNum, reference);
}

NS_IMETHODIMP
ParsedServerHdr::GetMime2DecodedAuthor(nsAString& mime2DecodedAuthor) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetMime2DecodedAuthor(mime2DecodedAuthor);
}

NS_IMETHODIMP
ParsedServerHdr::GetMime2DecodedSubject(nsAString& mime2DecodedSubject) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetMime2DecodedSubject(mime2DecodedSubject);
}

NS_IMETHODIMP
ParsedServerHdr::GetMime2DecodedRecipients(nsAString& mime2DecodedRecipients) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetMime2DecodedRecipients(mime2DecodedRecipients);
}

NS_IMETHODIMP
ParsedServerHdr::GetCharset(nsACString& charset) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetCharset(charset);
}

NS_IMETHODIMP
ParsedServerHdr::SetCharset(const nsACString& charset) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetCharset(charset));
}

NS_IMETHODIMP
ParsedServerHdr::GetEffectiveCharset(nsACString& effectiveCharset) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetEffectiveCharset(effectiveCharset);
}

NS_IMETHODIMP
ParsedServerHdr::GetAccountKey(nsACString& accountKey) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetAccountKey(accountKey);
}

NS_IMETHODIMP
ParsedServerHdr::SetAccountKey(const nsACString& accountKey) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check(true));
  AutoRestore<bool> changing(mWriting);
  mWriting = true;
  return FinishWrite(mHeader->SetAccountKey(accountKey));
}

NS_IMETHODIMP
ParsedServerHdr::GetFolder(nsIMsgFolder** aFolder) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetFolder(aFolder);
}

NS_IMETHODIMP
ParsedServerHdr::GetIsLive(bool* isLive) {
  RefPtr<ParsedServerHdr> self(this);
  MOZ_TRY(Check());
  return mHeader->GetIsLive(isLive);
}

NS_IMETHODIMP PerFolderDatabase::CopyHdrFromExistingHdr(
    nsMsgKey key, nsIMsgDBHdr* existingHdr, bool addHdrToDB,
    nsIMsgDBHdr** aRetVal) {
  NS_ENSURE_ARG_POINTER(aRetVal);
  *aRetVal = nullptr;
  NS_ENSURE_ARG(existingHdr);
  RefPtr<ParsedServerHdr> selected = do_QueryObject(existingHdr);
  if (selected) {
    MOZ_TRY(selected->Check());
  }
  MOZ_TRY(CheckFolderExists());
  // Global keys are allocated by the core, not requested by callers.
  NS_ENSURE_TRUE(key == nsMsgKey_None, NS_ERROR_NOT_IMPLEMENTED);

  RefPtr<DetachedMsgHdr> draft = new DetachedMsgHdr(mFolderId);
  RawHdr& raw = draft->mRaw;
  MOZ_TRY(existingHdr->GetMessageId(raw.messageId));
  MOZ_TRY(existingHdr->GetSubject(raw.subject));
  MOZ_TRY(existingHdr->GetAuthor(raw.sender));
  MOZ_TRY(existingHdr->GetRecipients(raw.recipients));
  MOZ_TRY(existingHdr->GetCcList(raw.ccList));
  MOZ_TRY(existingHdr->GetBccList(raw.bccList));
  MOZ_TRY(existingHdr->GetDate(&raw.date));
  MOZ_TRY(existingHdr->GetFlags(&raw.flags));
  MOZ_TRY(existingHdr->GetPriority(&raw.priority));
  MOZ_TRY(existingHdr->GetStringProperty("keywords", raw.keywords));

  bool isLive;
  MOZ_TRY(existingHdr->GetIsLive(&isLive));
  if (isLive) {
    nsMsgKey sourceKey;
    MOZ_TRY(existingHdr->GetMessageKey(&sourceKey));
    nsCOMPtr<nsIMsgFolder> folder;
    MOZ_TRY(existingHdr->GetFolder(getter_AddRefs(folder)));
    NS_ENSURE_TRUE(folder, NS_ERROR_NOT_AVAILABLE);
    uint64_t folderId, storedFolderId;
    MOZ_TRY(folder->GetId(&folderId));
    MOZ_TRY(MessageDB().GetMessageFolderId(sourceKey, storedFolderId));
    NS_ENSURE_TRUE(folderId == storedFolderId, NS_ERROR_ILLEGAL_VALUE);
    // Copy the admitted native word, not the facade's transient NewList bit.
    MOZ_TRY(MessageDB().GetMessageFlags(sourceKey, raw.flags));
    // The public getter filters self/empty tokens and has a uint16 limit.
    MOZ_TRY(MessageDB().GetMessageReferences(sourceKey, raw.references));
  } else if (selected) {
    MOZ_TRY(MessageDB().GetMessageReferences(selected->mLocation.key,
                                             raw.references));
  } else {
    // Only native drafts carry the complete unfiltered references.
    RefPtr<DetachedMsgHdr> source = do_QueryObject(existingHdr);
    NS_ENSURE_TRUE(source, NS_ERROR_ILLEGAL_VALUE);
    MOZ_TRY(source->CheckMutable());
    raw.references = source->mRaw.references.Clone();
  }

  nsTArray<nsCString> properties;
  MOZ_TRY(existingHdr->GetProperties(properties));
  for (const auto& name : properties) {
    uint32_t value;
    if (name.EqualsLiteral("messageSize")) {
      MOZ_TRY(existingHdr->GetMessageSize(&value));
      raw.messageSize = Some(value);
    } else if (name.EqualsLiteral("offlineMessageSize")) {
      MOZ_TRY(existingHdr->GetOfflineMessageSize(&value));
      raw.offlineMessageSize = Some(value);
    } else if (name.EqualsLiteral("lineCount")) {
      MOZ_TRY(existingHdr->GetLineCount(&value));
      raw.lineCount = Some(value);
    } else if (name.EqualsLiteral("storeToken")) {
      nsAutoCString token;
      MOZ_TRY(existingHdr->GetStoreToken(token));
      raw.storeToken = Some(nsCString(token));
    } else {
      nsAutoCString propertyValue;
      MOZ_TRY(existingHdr->GetStringProperty(name.get(), propertyValue));
      auto& extra = *raw.extras.AppendElement();
      extra.k = name;
      extra.v = propertyValue;
    }
  }
  if (selected) {
    MOZ_TRY(selected->Check());
  }
  // Source getters may have reentered during collection.
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  draft->mPendingOwner = this;
  draft->mPendingSourceId = mDatabaseSourceId;
  if (addHdrToDB) {
    return AttachHdr(draft, true, aRetVal);
  }
  draft.forget(aRetVal);
  return NS_OK;
}

nsresult PerFolderDatabase::CopyHdrForStore(nsIMsgDBHdr* existingHdr,
                                            bool preserveMessageSize,
                                            nsIMsgDBHdr** draft) {
  NS_ENSURE_ARG_POINTER(draft);
  *draft = nullptr;
  NS_ENSURE_ARG(existingHdr);
  RefPtr<PerFolderDatabase> self(this);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());

  nsCOMPtr<nsIMsgDBHdr> copy;
  MOZ_TRY(CopyHdrFromExistingHdr(nsMsgKey_None, existingHdr, false,
                                 getter_AddRefs(copy)));
  // Source getters can reenter while collecting the metadata.
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  RefPtr<DetachedMsgHdr> native = do_QueryObject(copy);
  NS_ENSURE_TRUE(native, NS_ERROR_UNEXPECTED);
  RawHdr& raw = native->mRaw;
  raw.storeToken = Nothing();
  raw.offlineMessageSize = Nothing();
  raw.lineCount = Nothing();
  if (!preserveMessageSize) {
    raw.messageSize = Nothing();
  }
  raw.flags &= ~nsMsgMessageFlags::Offline;
  raw.extras.RemoveElementsBy([preserveMessageSize](const auto& extra) {
    return extra.k.EqualsLiteral("storeToken") ||
           extra.k.EqualsLiteral("offlineMessageSize") ||
           extra.k.EqualsLiteral("lineCount") ||
           extra.k.EqualsLiteral("msgOffset") ||
           extra.k.EqualsLiteral("uidOnServer") ||
           (!preserveMessageSize && extra.k.EqualsLiteral("messageSize"));
  });
  native->mCopySourceId = mDatabaseSourceId;
  copy.forget(draft);
  return NS_OK;
}

nsresult PerFolderDatabase::StageHdrForOfflineCopy(nsIMsgDBHdr* detached,
                                                   nsMsgKey* stagedKey) {
  NS_ENSURE_ARG_POINTER(stagedKey);
  NS_ENSURE_ARG(detached);
  RefPtr<PerFolderDatabase> self(this);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  RefPtr<DetachedMsgHdr> draft = do_QueryObject(detached);
  NS_ENSURE_TRUE(draft && draft->mFolderId == mFolderId, NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(!draft->mCopySourceId.IsEmpty() &&
                     draft->mCopySourceId.Equals(mDatabaseSourceId),
                 NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(draft->CheckMutable());
  MOZ_TRY(UpdatePendingAttributes(draft));
  // Initial queued copies have no inferred source-server UID binding.
  NS_ENSURE_FALSE(
      std::any_of(draft->mRaw.extras.begin(), draft->mRaw.extras.end(),
                  [](const auto& extra) {
                    return extra.k.EqualsLiteral("uidOnServer");
                  }),
      NS_ERROR_INVALID_ARG);
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  draft->mAttachState = DetachedMsgHdr::AttachState::Attaching;
  nsresult rv = MessageDB().StageMessage(mFolderId, draft->mRaw, stagedKey);
  if (NS_FAILED(rv)) {
    draft->mAttachError = rv;
    draft->mAttachState = DetachedMsgHdr::AttachState::Failed;
    return rv;
  }
  draft->mCopyStagedKey = *stagedKey;
  // Attaching also seals the draft while the caller installs associations.
  return NS_OK;
}

nsresult PerFolderDatabase::PublishHdrForOfflineCopy(nsIMsgDBHdr* detached,
                                                     bool notifyLegacy,
                                                     Message** liveHeader) {
  NS_ENSURE_ARG_POINTER(liveHeader);
  NS_ENSURE_FALSE(*liveHeader, NS_ERROR_INVALID_ARG);
  NS_ENSURE_ARG(detached);
  RefPtr<PerFolderDatabase> self(this);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  RefPtr<DetachedMsgHdr> draft = do_QueryObject(detached);
  NS_ENSURE_TRUE(draft && draft->mFolderId == mFolderId, NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(!draft->mCopySourceId.IsEmpty() &&
                     draft->mCopySourceId.Equals(mDatabaseSourceId),
                 NS_ERROR_NOT_AVAILABLE);
  if (draft->mAttachState == DetachedMsgHdr::AttachState::Failed) {
    return draft->mAttachError;
  }
  NS_ENSURE_FALSE(draft->mAttachState == DetachedMsgHdr::AttachState::Attached,
                  NS_ERROR_ALREADY_INITIALIZED);
  NS_ENSURE_FALSE(draft->mCopyPublishing, NS_ERROR_IN_PROGRESS);
  NS_ENSURE_TRUE(
      draft->mAttachState == DetachedMsgHdr::AttachState::Attaching &&
          draft->mCopyStagedKey != nsMsgKey_None,
      NS_ERROR_INVALID_ARG);
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  Maybe<CapturedMessage> pending;
  MOZ_TRY(MessageDB().CaptureHeaderState(draft->mCopyStagedKey, pending));
  NS_ENSURE_TRUE(pending && pending->folderId == mFolderId,
                 NS_ERROR_NOT_AVAILABLE);
  AutoRestore<bool> publishing(draft->mCopyPublishing);
  draft->mCopyPublishing = true;
  // Native publication fills the persistent owning slot before callbacks.
  // No SQL or fallible lookup follows its commit.
  nsresult rv = MessageDB().PublishMessage(draft->mCopyStagedKey, notifyLegacy,
                                           liveHeader);
  if (NS_FAILED(rv)) {
    draft->mAttachError = rv;
    draft->mAttachState = DetachedMsgHdr::AttachState::Failed;
    return rv;
  }
  MOZ_ASSERT(*liveHeader);
  draft->mAttachedHeader = *liveHeader;
  draft->mAttachState = DetachedMsgHdr::AttachState::Attached;
  return NS_OK;
}

nsresult PerFolderDatabase::PublishHdrForOnlineTransfer(
    nsIMsgDBHdr* stagedDraft, const OnlineTransferDestination& expected,
    uint32_t observedEpoch, uint32_t observedUid, bool notifyLegacy,
    ServerMessageLocation& mapping, Message** liveHeader) {
  NS_ENSURE_ARG_POINTER(liveHeader);
  NS_ENSURE_FALSE(*liveHeader, NS_ERROR_INVALID_ARG);
  NS_ENSURE_ARG(stagedDraft);
  RefPtr<PerFolderDatabase> self(this);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  RefPtr<DetachedMsgHdr> draft = do_QueryObject(stagedDraft);
  NS_ENSURE_TRUE(draft && draft->mFolderId == mFolderId, NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(draft->mCopySourceId == mDatabaseSourceId &&
                     expected.databaseSourceId == mDatabaseSourceId &&
                     expected.destination.folderId == mFolderId,
                 NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_FALSE(draft->mAttachState == DetachedMsgHdr::AttachState::Attached,
                  NS_ERROR_ALREADY_INITIALIZED);
  NS_ENSURE_FALSE(draft->mCopyPublishing, NS_ERROR_IN_PROGRESS);
  NS_ENSURE_TRUE(
      draft->mAttachState == DetachedMsgHdr::AttachState::Attaching &&
          draft->mCopyStagedKey != nsMsgKey_None &&
          draft->mCopyStagedKey == expected.destination.key,
      NS_ERROR_INVALID_ARG);
  AutoRestore<bool> publishing(draft->mCopyPublishing);
  draft->mCopyPublishing = true;
  // Failure leaves the sealed draft in Attaching for explicit local recovery;
  // the caller retains its primary command error and owns the source bytes.
  MOZ_TRY(MessageDB().PublishOnlineTransferDestination(
      expected, observedEpoch, observedUid, notifyLegacy, mapping, liveHeader));
  // Both owning outputs were installed before callbacks. Nothing fallible may
  // follow that commit, even if a callback retired this facade's source.
  draft->mAttachedHeader = *liveHeader;
  draft->mAttachState = DetachedMsgHdr::AttachState::Attached;
  return NS_OK;
}

NS_IMETHODIMP PerFolderDatabase::AddMsgHdr(RawHdr* msg, bool notify,
                                           nsIMsgDBHdr** newHdr) {
  NS_ENSURE_ARG(msg);
  NS_ENSURE_ARG_POINTER(newHdr);

  nsMsgKey key;
  RefPtr<Message> message;
  MOZ_TRY(MessageDB().AddMessage(mFolderId, *msg, notify, &key,
                                 getter_AddRefs(message)));
  MOZ_ASSERT(key != nsMsgKey_None && message);
  message.forget(newHdr);
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::ListAllKeys(nsTArray<nsMsgKey>& aKeys) {
  return MessageDB().ListAllKeys(mFolderId, aKeys);
}
NS_IMETHODIMP PerFolderDatabase::EnumerateMessages(
    nsIMsgEnumerator** aEnumerator) {
  NS_ENSURE_ARG_POINTER(aEnumerator);
  *aEnumerator = nullptr;
  MOZ_TRY(CheckEnumerationState(mEnumeratorGeneration));
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv =
      DatabaseCore::GetStatement("GetAllMessages"_ns,
                                 "SELECT "_ns MESSAGE_SQL_FIELDS
                                 " FROM messages WHERE folderId = :folderId"_ns,
                                 getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<mozIStorageStatement> stmtClone;
  rv = stmt->Clone(getter_AddRefs(stmtClone));
  NS_ENSURE_SUCCESS(rv, rv);

  MOZ_TRY(stmtClone->BindInt64ByName("folderId"_ns, mFolderId));

  RefPtr<MessageEnumerator> enumerator = new MessageEnumerator(this, stmtClone);
  bool hasNext;
  MOZ_TRY(enumerator->HasMoreElements(&hasNext));
  enumerator.forget(aEnumerator);
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::ReverseEnumerateMessages(
    nsIMsgEnumerator** aEnumerator) {
  NS_ENSURE_ARG_POINTER(aEnumerator);
  *aEnumerator = nullptr;
  MOZ_TRY(CheckEnumerationState(mEnumeratorGeneration));
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "GetAllMessagesReverse"_ns,
      "SELECT "_ns MESSAGE_SQL_FIELDS
      " FROM messages WHERE folderId = :folderId ORDER BY id DESC"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<mozIStorageStatement> stmtClone;
  rv = stmt->Clone(getter_AddRefs(stmtClone));
  NS_ENSURE_SUCCESS(rv, rv);

  MOZ_TRY(stmtClone->BindInt64ByName("folderId"_ns, mFolderId));

  RefPtr<MessageEnumerator> enumerator = new MessageEnumerator(this, stmtClone);
  bool hasNext;
  MOZ_TRY(enumerator->HasMoreElements(&hasNext));
  enumerator.forget(aEnumerator);
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::EnumerateThreads(
    nsIMsgThreadEnumerator** aEnumerator) {
  NS_ENSURE_ARG_POINTER(aEnumerator);
  *aEnumerator = nullptr;
  MOZ_TRY(CheckEnumerationState(mEnumeratorGeneration));
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "GetMessageThreads"_ns,
      "SELECT threadId, MAX(date) AS maxDate FROM messages WHERE folderId = :folderId GROUP BY threadId"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<mozIStorageStatement> stmtClone;
  rv = stmt->Clone(getter_AddRefs(stmtClone));
  NS_ENSURE_SUCCESS(rv, rv);

  MOZ_TRY(stmtClone->BindInt64ByName("folderId"_ns, mFolderId));

  RefPtr<ThreadEnumerator> enumerator = new ThreadEnumerator(this, stmtClone);
  bool hasNext;
  MOZ_TRY(enumerator->HasMoreElements(&hasNext));
  enumerator.forget(aEnumerator);
  return NS_OK;
}

class FilterEnumerator final : public nsBaseMsgEnumerator {
 public:
  FilterEnumerator(PerFolderDatabase* db, nsIMsgSearchSession* session,
                   nsTArray<nsMsgKey>&& keys)
      : mDatabase(db),
        mGeneration(db->mEnumeratorGeneration),
        mSession(session),
        mKeys(std::move(keys)) {}

  NS_IMETHOD HasMoreElements(bool* result) override {
    NS_ENSURE_ARG_POINTER(result);
    *result = false;
    MOZ_TRY(CheckOwner());
    if (mNext) {
      nsMsgKey key;
      MOZ_TRY(mNext->GetMessageKey(&key));
      bool contains;
      MOZ_TRY(mDatabase->ContainsKey(key, &contains));
      if (!contains) {
        mNext = nullptr;
      }
    }
    while (!mNext && mIndex < mKeys.Length()) {
      bool contains;
      MOZ_TRY(mDatabase->ContainsKey(mKeys[mIndex], &contains));
      if (!contains) {
        ++mIndex;
        continue;
      }
      nsCOMPtr<nsIMsgDBHdr> header;
      MOZ_TRY(
          mDatabase->GetMsgHdrForKey(mKeys[mIndex], getter_AddRefs(header)));
      bool matches = false;
      // Matching can synchronously close the owner and release our members.
      RefPtr<PerFolderDatabase> database = mDatabase;
      nsCOMPtr<nsIMsgSearchSession> session = mSession;
      MOZ_TRY(session->MatchHdr(header, database, &matches));
      MOZ_TRY(CheckOwner());
      ++mIndex;
      if (matches) {
        mNext = header;
      }
    }
    *result = !!mNext;
    return NS_OK;
  }

  NS_IMETHOD GetNext(nsIMsgDBHdr** result) override {
    NS_ENSURE_ARG_POINTER(result);
    *result = nullptr;
    bool more;
    MOZ_TRY(HasMoreElements(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_FAILURE);
    mNext.forget(result);
    return NS_OK;
  }

 private:
  ~FilterEnumerator() = default;

  nsresult CheckOwner() {
    MOZ_TRY(mStatus);
    mStatus = mDatabase->CheckEnumerationState(mGeneration);
    if (NS_FAILED(mStatus)) {
      mNext = nullptr;
      mKeys.Clear();
      mSession = nullptr;
      mDatabase = nullptr;
    }
    return mStatus;
  }

  RefPtr<PerFolderDatabase> mDatabase;
  uint64_t mGeneration;
  nsresult mStatus = NS_OK;
  nsCOMPtr<nsIMsgSearchSession> mSession;
  nsTArray<nsMsgKey> mKeys;
  size_t mIndex = 0;
  nsCOMPtr<nsIMsgDBHdr> mNext;
};

NS_IMETHODIMP PerFolderDatabase::GetFilterEnumerator(
    const nsTArray<RefPtr<nsIMsgSearchTerm>>& searchTerms, bool reverse,
    nsIMsgEnumerator** aRetVal) {
  NS_ENSURE_ARG_POINTER(aRetVal);
  *aRetVal = nullptr;
  MOZ_TRY(CheckEnumerationState(mEnumeratorGeneration));
  nsCOMPtr<nsIMsgFolder> folder;
  MOZ_TRY(GetFolder(getter_AddRefs(folder)));
  nsresult rv;
  nsCOMPtr<nsIMsgSearchSession> session =
      do_CreateInstance("@mozilla.org/messenger/searchSession;1", &rv);
  MOZ_TRY(rv);
  MOZ_TRY(session->AddScopeTerm(nsMsgSearchScope::offlineMail, folder));
  for (const auto& term : searchTerms) {
    NS_ENSURE_ARG(term);
    MOZ_TRY(session->AppendTerm(term));
  }
  nsTArray<nsMsgKey> keys;
  MOZ_TRY(ListAllKeys(keys));
  if (reverse) {
    std::reverse(keys.begin(), keys.end());
  }
  RefPtr<FilterEnumerator> enumerator =
      new FilterEnumerator(this, session, std::move(keys));
  enumerator.forget(aRetVal);
  return NS_OK;
}
nsresult PerFolderDatabase::ReadCount(bool unread, int32_t* count) {
  NS_ENSURE_ARG_POINTER(count);
  *count = 0;
  RememberLastUseTime();
  MOZ_TRY(CheckFolderExists());
  uint32_t flags = MOZ_TRY(FolderDB().GetFolderFlags(mFolderId));
  if (flags & nsMsgFolderFlags::Virtual) {
    int64_t value = 0;
    RefPtr<FolderInfo> info = new FolderInfo(this);
    MOZ_TRY(
        info->GetInt64Property(unread ? "numNewMsgs" : "numMsgs", 0, &value));
    CheckedInt<int32_t> checked(value);
    NS_ENSURE_TRUE(checked.isValid(), NS_ERROR_LOSS_OF_SIGNIFICANT_DATA);
    *count = checked.value();
    return NS_OK;
  }
  uint64_t value;
  MOZ_TRY(unread ? MessageDB().GetNumUnread(mFolderId, &value)
                 : MessageDB().GetNumMessages(mFolderId, &value));
  CheckedInt<int32_t> checked(value);
  NS_ENSURE_TRUE(checked.isValid(), NS_ERROR_LOSS_OF_SIGNIFICANT_DATA);
  *count = checked.value();
  return NS_OK;
}

nsresult PerFolderDatabase::WriteCount(bool unread, int32_t count) {
  RememberLastUseTime();
  MOZ_TRY(CheckFolderExists());
  uint32_t flags = MOZ_TRY(FolderDB().GetFolderFlags(mFolderId));
  NS_ENSURE_TRUE(flags & nsMsgFolderFlags::Virtual, NS_ERROR_NOT_IMPLEMENTED);
  RefPtr<FolderInfo> info = new FolderInfo(this);
  return info->SetInt64Property(unread ? "numNewMsgs" : "numMsgs",
                                int64_t{count});
}

nsresult PerFolderDatabase::ChangeCount(bool unread, int32_t delta) {
  int32_t count;
  MOZ_TRY(ReadCount(unread, &count));
  CheckedInt<int32_t> changed(count);
  changed += delta;
  NS_ENSURE_TRUE(changed.isValid(), NS_ERROR_LOSS_OF_SIGNIFICANT_DATA);
  return WriteCount(unread, std::max(0, changed.value()));
}

NS_IMETHODIMP PerFolderDatabase::SyncCounts() {
  // Physical counts are derived; virtual folders retain their search summary.
  int32_t total, unread;
  MOZ_TRY(ReadCount(false, &total));
  return ReadCount(true, &unread);
}
NS_IMETHODIMP PerFolderDatabase::GetThreadContainingMsgHdr(
    nsIMsgDBHdr* msgHdr, nsIMsgThread** thread) {
  NS_ENSURE_ARG_POINTER(thread);
  *thread = nullptr;
  NS_ENSURE_ARG(msgHdr);
  nsMsgKey key;
  MOZ_TRY(msgHdr->GetMessageKey(&key));
  nsCOMPtr<nsIMsgDBHdr> member;
  MOZ_TRY(GetMsgHdrForKey(key, getter_AddRefs(member)));
  CapturedMessage current;
  MOZ_TRY(MessageDB().CaptureMessage(key, current));
  NS_ENSURE_TRUE(current.folderId == mFolderId, NS_ERROR_ILLEGAL_VALUE);
  NS_ENSURE_TRUE(current.threadId && current.threadId != nsMsgKey_None,
                 NS_ERROR_NOT_AVAILABLE);
  RefPtr<Thread> result = new Thread(mFolderId, current.threadId);
  result.forget(thread);
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::MarkNotNew(nsMsgKey aKey,
                                            nsIDBChangeListener* aInstigator) {
  RefPtr<PerFolderDatabase> self(this);
  nsCOMPtr<nsIMsgDBHdr> header;
  MOZ_TRY(GetMsgHdrForKey(aKey, getter_AddRefs(header)));
  uint32_t flags;
  MOZ_TRY(MessageDB().GetMessageFlags(aKey, flags));
  MOZ_TRY(MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::New, false));
  // A changed raw flag clears NewList before notifying listeners. Do not erase
  // an entry that a listener added again while handling that notification.
  if (!(flags & nsMsgMessageFlags::New) && mNewList.RemoveElement(aKey)) {
    // The raw setter was a no-op, but removing the list contribution changes
    // the public status. Do not manufacture a native flag write or event.
    return NotifyHdrChangeAll(header, flags | nsMsgMessageFlags::New, flags,
                              aInstigator);
  }
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::MarkMDNNeeded(
    nsMsgKey aKey, bool aNeeded, nsIDBChangeListener* aInstigator) {
  nsCOMPtr<nsIMsgDBHdr> member;
  MOZ_TRY(GetMsgHdrForKey(aKey, getter_AddRefs(member)));
  return MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::MDNReportNeeded,
                                    aNeeded);
}
NS_IMETHODIMP PerFolderDatabase::MarkMDNSent(nsMsgKey aKey, bool aSent,
                                             nsIDBChangeListener* aInstigator) {
  nsCOMPtr<nsIMsgDBHdr> member;
  MOZ_TRY(GetMsgHdrForKey(aKey, getter_AddRefs(member)));
  return MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::MDNReportSent,
                                    aSent);
}
NS_IMETHODIMP PerFolderDatabase::MarkRead(nsMsgKey aKey, bool aRead,
                                          nsIDBChangeListener* aInstigator) {
  nsCOMPtr<nsIMsgDBHdr> member;
  MOZ_TRY(GetMsgHdrForKey(aKey, getter_AddRefs(member)));
  return MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::Read, aRead);
}
NS_IMETHODIMP PerFolderDatabase::MarkMarked(nsMsgKey aKey, bool aMarked,
                                            nsIDBChangeListener* instigator) {
  nsCOMPtr<nsIMsgDBHdr> member;
  MOZ_TRY(GetMsgHdrForKey(aKey, getter_AddRefs(member)));
  return MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::Marked, aMarked);
}
NS_IMETHODIMP PerFolderDatabase::MarkReplied(nsMsgKey aKey, bool aReplied,
                                             nsIDBChangeListener* aInstigator) {
  nsCOMPtr<nsIMsgDBHdr> member;
  MOZ_TRY(GetMsgHdrForKey(aKey, getter_AddRefs(member)));
  return MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::Replied, aReplied);
}
NS_IMETHODIMP PerFolderDatabase::MarkForwarded(
    nsMsgKey aKey, bool aForwarded, nsIDBChangeListener* aInstigator) {
  nsCOMPtr<nsIMsgDBHdr> member;
  MOZ_TRY(GetMsgHdrForKey(aKey, getter_AddRefs(member)));
  return MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::Forwarded,
                                    aForwarded);
}
NS_IMETHODIMP PerFolderDatabase::MarkRedirected(
    nsMsgKey aKey, bool aRedirected, nsIDBChangeListener* aInstigator) {
  nsCOMPtr<nsIMsgDBHdr> member;
  MOZ_TRY(GetMsgHdrForKey(aKey, getter_AddRefs(member)));
  return MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::Redirected,
                                    aRedirected);
}
NS_IMETHODIMP PerFolderDatabase::MarkHasAttachments(
    nsMsgKey aKey, bool aHasAttachments, nsIDBChangeListener* aInstigator) {
  nsCOMPtr<nsIMsgDBHdr> member;
  MOZ_TRY(GetMsgHdrForKey(aKey, getter_AddRefs(member)));
  return MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::Attachment,
                                    aHasAttachments);
}
NS_IMETHODIMP PerFolderDatabase::MarkOffline(nsMsgKey aKey, bool aOffline,
                                             nsIDBChangeListener* instigator) {
  nsCOMPtr<nsIMsgDBHdr> member;
  MOZ_TRY(GetMsgHdrForKey(aKey, getter_AddRefs(member)));
  return MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::Offline, aOffline);
}
NS_IMETHODIMP PerFolderDatabase::MarkImapDeleted(
    nsMsgKey aKey, bool aDeleted, nsIDBChangeListener* instigator) {
  nsCOMPtr<nsIMsgDBHdr> member;
  MOZ_TRY(GetMsgHdrForKey(aKey, getter_AddRefs(member)));
  return MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::IMAPDeleted,
                                    aDeleted);
}
nsresult PerFolderDatabase::MarkThreadFlag(nsIMsgThread* thread, nsMsgKey key,
                                           uint32_t flag, bool set,
                                           nsIDBChangeListener* instigator) {
  NS_ENSURE_ARG(thread);
  nsCOMPtr<nsIMsgDBHdr> header;
  MOZ_TRY(GetMsgHdrForKey(key, getter_AddRefs(header)));
  nsMsgKey threadId;
  MOZ_TRY(thread->GetThreadKey(&threadId));
  CapturedMessage current;
  MOZ_TRY(MessageDB().CaptureMessage(key, current));
  NS_ENSURE_TRUE(current.folderId == mFolderId && current.threadId == threadId,
                 NS_ERROR_ILLEGAL_VALUE);
  nsCOMPtr<nsIMsgDBHdr> child;
  MOZ_TRY(thread->GetChild(key, getter_AddRefs(child)));
  NS_ENSURE_TRUE(child, NS_ERROR_UNEXPECTED);
  uint32_t oldFlags;
  MOZ_TRY(thread->GetFlags(&oldFlags));
  uint32_t flags = oldFlags;
  if (set) {
    flags |= flag;
    flags &= ~(flag == nsMsgMessageFlags::Ignored ? nsMsgMessageFlags::Watched
                                                  : nsMsgMessageFlags::Ignored);
  } else {
    flags &= ~flag;
  }
  MOZ_TRY(thread->SetFlags(flags));
  uint32_t status = StatusFlags(key, current.flags);
  return NotifyHdrChangeAll(header, oldFlags | status, flags | status,
                            instigator);
}

NS_IMETHODIMP PerFolderDatabase::MarkThreadIgnored(
    nsIMsgThread* thread, nsMsgKey threadKey, bool ignored,
    nsIDBChangeListener* instigator) {
  return MarkThreadFlag(thread, threadKey, nsMsgMessageFlags::Ignored, ignored,
                        instigator);
}
NS_IMETHODIMP PerFolderDatabase::MarkThreadWatched(
    nsIMsgThread* thread, nsMsgKey threadKey, bool watched,
    nsIDBChangeListener* instigator) {
  return MarkThreadFlag(thread, threadKey, nsMsgMessageFlags::Watched, watched,
                        instigator);
}
NS_IMETHODIMP PerFolderDatabase::MarkKilled(nsMsgKey key, bool killed,
                                            nsIDBChangeListener* instigator) {
  nsCOMPtr<nsIMsgDBHdr> member;
  MOZ_TRY(GetMsgHdrForKey(key, getter_AddRefs(member)));
  return MessageDB().SetMessageFlag(key, nsMsgMessageFlags::Ignored, killed);
}
NS_IMETHODIMP PerFolderDatabase::IsRead(nsMsgKey key, bool* read) {
  NS_ENSURE_ARG_POINTER(read);
  *read = false;
  nsCOMPtr<nsIMsgDBHdr> header;
  MOZ_TRY(GetMsgHdrForKey(key, getter_AddRefs(header)));
  return header->GetIsRead(read);
}
NS_IMETHODIMP PerFolderDatabase::IsIgnored(nsMsgKey key, bool* ignored) {
  NS_ENSURE_ARG_POINTER(ignored);
  *ignored = false;
  nsCOMPtr<nsIMsgDBHdr> header;
  MOZ_TRY(GetMsgHdrForKey(key, getter_AddRefs(header)));
  nsCOMPtr<nsIMsgThread> thread;
  MOZ_TRY(GetThreadContainingMsgHdr(header, getter_AddRefs(thread)));
  uint32_t flags;
  MOZ_TRY(thread->GetFlags(&flags));
  *ignored = !!(flags & nsMsgMessageFlags::Ignored);
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::IsWatched(nsMsgKey key, bool* watched) {
  NS_ENSURE_ARG_POINTER(watched);
  *watched = false;
  nsCOMPtr<nsIMsgDBHdr> header;
  MOZ_TRY(GetMsgHdrForKey(key, getter_AddRefs(header)));
  nsCOMPtr<nsIMsgThread> thread;
  MOZ_TRY(GetThreadContainingMsgHdr(header, getter_AddRefs(thread)));
  uint32_t flags;
  MOZ_TRY(thread->GetFlags(&flags));
  *watched = !!(flags & nsMsgMessageFlags::Watched);
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::IsMarked(nsMsgKey aKey, bool* aMarked) {
  NS_ENSURE_ARG_POINTER(aMarked);
  nsCOMPtr<nsIMsgDBHdr> member;
  MOZ_TRY(GetMsgHdrForKey(aKey, getter_AddRefs(member)));
  return MessageDB().GetMessageFlag(aKey, nsMsgMessageFlags::Marked, *aMarked);
}
NS_IMETHODIMP PerFolderDatabase::HasAttachments(nsMsgKey aKey,
                                                bool* aAttachments) {
  NS_ENSURE_ARG_POINTER(aAttachments);
  nsCOMPtr<nsIMsgDBHdr> member;
  MOZ_TRY(GetMsgHdrForKey(aKey, getter_AddRefs(member)));
  return MessageDB().GetMessageFlag(aKey, nsMsgMessageFlags::Attachment,
                                    *aAttachments);
}
NS_IMETHODIMP PerFolderDatabase::IsMDNSent(nsMsgKey aKey, bool* aMDNSent) {
  NS_ENSURE_ARG_POINTER(aMDNSent);
  nsCOMPtr<nsIMsgDBHdr> member;
  MOZ_TRY(GetMsgHdrForKey(aKey, getter_AddRefs(member)));
  return MessageDB().GetMessageFlag(aKey, nsMsgMessageFlags::MDNReportSent,
                                    *aMDNSent);
}
NS_IMETHODIMP PerFolderDatabase::MarkAllRead(nsTArray<nsMsgKey>& aMarkedKeys) {
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  return MessageDB().MarkAllRead(mFolderId, aMarkedKeys);
}

NS_IMETHODIMP PerFolderDatabase::DeleteMessages(
    const nsTArray<nsMsgKey>& nsMsgKeys, nsIDBChangeListener* instigator) {
  // NOTE: `instigator` ignored. There _will_ be a OnMessageRemoved()
  // callback (because we're a MessageListener), but that will send a null
  // instigator.
  if (nsMsgKeys.IsEmpty()) {
    return NS_OK;
  }
  RefPtr<PerFolderDatabase> self(this);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  RefPtr<MessageDatabase> messages = &MessageDB();
  MOZ_TRY(messages->CheckFolderBodyAccess(mFolderId));
  nsCOMPtr<nsIMsgFolder> folder;
  MOZ_TRY(GetFolder(getter_AddRefs(folder)));
  nsCOMPtr<nsIMsgIncomingServer> server;
  MOZ_TRY(folder->GetServer(getter_AddRefs(server)));
  NS_ENSURE_TRUE(server, NS_ERROR_NOT_AVAILABLE);
  nsCString databaseType;
  MOZ_TRY(server->GetLocalDatabaseType(databaseType));
  MessageRemovalAccounting accounting;
  if (databaseType.EqualsLiteral("mailbox")) {
    accounting = MessageRemovalAccounting::LocalMessageSize;
  } else if (databaseType.EqualsLiteral("imap") ||
             databaseType.EqualsLiteral("news")) {
    accounting = MessageRemovalAccounting::OfflineMessageSize;
  } else {
    return NS_ERROR_NOT_IMPLEMENTED;
  }
  for (nsMsgKey key : nsMsgKeys) {
    // A preceding removal callback may have closed this wrapper. Each native
    // removal also rechecks its captured physical folder and incarnation.
    MOZ_TRY(CheckFolderExists());
    MOZ_TRY(messages->RemoveMessageFromFolder(key, mFolderId, mDatabaseSourceId,
                                              accounting));
  }

  return NS_OK;
}

NS_IMETHODIMP PerFolderDatabase::DeleteMessage(nsMsgKey aKey,
                                               nsIDBChangeListener* instigator,
                                               bool commit) {
  // TODO: `instigator` and `commit` ignored.
  return DeleteMessages({aKey}, instigator);
}

NS_IMETHODIMP PerFolderDatabase::DeleteHeader(nsIMsgDBHdr* msgHdr,
                                              nsIDBChangeListener* instigator,
                                              bool commit, bool notify) {
  NS_ENSURE_ARG(msgHdr);
  RefPtr<PerFolderDatabase> self(this);
  nsMsgKey key;
  nsresult rv = msgHdr->GetMessageKey(&key);
  NS_ENSURE_SUCCESS(rv, rv);
  // TODO: `instigator`, `commit` and `notify` ignored.
  return DeleteMessages({key}, instigator);
}

nsresult PerFolderDatabase::RemoveHdrForUndo(
    nsMsgKey key, RemovedMessage& captured, OfflineOperationUndo* redo,
    OfflineOperationUndo* nextOffline) {
  RefPtr<PerFolderDatabase> self(this);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  RefPtr<MessageDatabase> messages = &MessageDB();
  MOZ_TRY(messages->CheckFolderBodyAccess(mFolderId));
  nsCOMPtr<nsIMsgFolder> folder;
  MOZ_TRY(GetFolder(getter_AddRefs(folder)));
  nsCOMPtr<nsIMsgIncomingServer> server;
  MOZ_TRY(folder->GetServer(getter_AddRefs(server)));
  NS_ENSURE_TRUE(server, NS_ERROR_NOT_AVAILABLE);
  nsCString databaseType;
  MOZ_TRY(server->GetLocalDatabaseType(databaseType));
  MessageRemovalAccounting accounting;
  if (databaseType.EqualsLiteral("mailbox")) {
    accounting = MessageRemovalAccounting::LocalMessageSize;
  } else if (databaseType.EqualsLiteral("imap") ||
             databaseType.EqualsLiteral("news")) {
    accounting = MessageRemovalAccounting::OfflineMessageSize;
  } else {
    return NS_ERROR_NOT_IMPLEMENTED;
  }
  return messages->RemoveMessageForUndo(key, mFolderId, mDatabaseSourceId,
                                        accounting, captured, redo,
                                        nextOffline);
}

nsresult PerFolderDatabase::CaptureOfflineOperationForUndo(
    nsMsgKey key, OfflineOperationUndo& output,
    const OfflineUndoCounterpart* counterpart) {
  RefPtr<PerFolderDatabase> self(this);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  RefPtr<MessageDatabase> messages = &MessageDB();
  return messages->CaptureOfflineOperationForUndo(
      mFolderId, key, mDatabaseSourceId, output, counterpart);
}

nsresult PerFolderDatabase::RestoreHdrForUndo(
    RemovedMessage& captured, const FinishedMessageBody& finished,
    nsMsgKey* key, Message** liveHeader, OfflineOperationUndo* offline,
    const PendingDestination* cancelMove, OfflineOperationUndo* redo) {
  NS_ENSURE_ARG_POINTER(key);
  NS_ENSURE_TRUE(!liveHeader || !*liveHeader, NS_ERROR_INVALID_ARG);
  RefPtr<PerFolderDatabase> self(this);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  const MessageBodyState* body = captured.Body();
  NS_ENSURE_TRUE(body && body->folderId == mFolderId &&
                     body->databaseSourceId == mDatabaseSourceId,
                 NS_ERROR_NOT_AVAILABLE);
  RefPtr<MessageDatabase> messages = &MessageDB();
  MOZ_TRY(messages->CheckFolderBodyAccess(mFolderId));
  // Do not substitute local output variables: native publication can reenter.
  return messages->RestoreMessageForUndo(mFolderId, captured, finished, key,
                                         liveHeader, offline, cancelMove, redo);
}

// This header is never published or returned. Its exact interface pointer is
// valid only while the owning wrapper's synchronous context is installed.
// No header getter supplies capture, provider completion or physical identity.
struct PerFolderDatabase::UndoDeleteContext {
  RemovedMessage& captured;
  const FinishedMessageBody& finished;
  nsMsgKey* key;
  Message** liveHeader;
  OfflineOperationUndo* offline;
  const PendingDestination* cancelMove;
  OfflineOperationUndo* redo;
  RefPtr<DetachedMsgHdr> header;
  bool entered = false;
};

nsresult PerFolderDatabase::UndoDeleteHdrForUndo(
    RemovedMessage& captured, const FinishedMessageBody& finished,
    nsMsgKey* key, Message** liveHeader, OfflineOperationUndo* offline,
    const PendingDestination* cancelMove, OfflineOperationUndo* redo) {
  NS_ENSURE_ARG_POINTER(key);
  NS_ENSURE_TRUE(!liveHeader || !*liveHeader, NS_ERROR_INVALID_ARG);
  RefPtr<PerFolderDatabase> self(this);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  NS_ENSURE_FALSE(mUndoDeleteContext, NS_ERROR_IN_PROGRESS);
  UndoDeleteContext context{
      captured, finished,   key,  liveHeader,
      offline,  cancelMove, redo, new DetachedMsgHdr(mFolderId)};
  // Restore the active pointer before context/header or self can be destroyed.
  // A failed call retains the real inputs for a fresh call by the owning entry.
  AutoRestore<UndoDeleteContext*> active(mUndoDeleteContext);
  mUndoDeleteContext = &context;
  return UndoDelete(context.header);
}

NS_IMETHODIMP PerFolderDatabase::UndoDelete(nsIMsgDBHdr* msgHdr) {
  NS_ENSURE_ARG_POINTER(msgHdr);
  RefPtr<PerFolderDatabase> self(this);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  UndoDeleteContext* context = mUndoDeleteContext;
  // Compare the private interface pointer directly: accepting a foreign QI or
  // an ordinary/live header would not establish ownership of the opaque input.
  NS_ENSURE_TRUE(context && msgHdr == context->header.get(),
                 NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_FALSE(context->entered, NS_ERROR_IN_PROGRESS);
  context->entered = true;
  return RestoreHdrForUndo(context->captured, context->finished, context->key,
                           context->liveHeader, context->offline,
                           context->cancelMove, context->redo);
}
NS_IMETHODIMP PerFolderDatabase::SetStringProperty(
    nsMsgKey key, const char* propertyName, const nsACString& propertyValue) {
  NS_ENSURE_ARG_POINTER(propertyName);
  nsCOMPtr<nsIMsgDBHdr> header;
  MOZ_TRY(GetMsgHdrForKey(key, getter_AddRefs(header)));
  return MessageDB().SetMessageProperty(key, nsDependentCString(propertyName),
                                        propertyValue);
}
NS_IMETHODIMP PerFolderDatabase::SetStringPropertyByHdr(
    nsIMsgDBHdr* msgHdr, const char* propertyName,
    const nsACString& propertyValue) {
  NS_ENSURE_ARG(msgHdr);
  return msgHdr->SetStringProperty(propertyName, propertyValue);
}
NS_IMETHODIMP PerFolderDatabase::SetUint32PropertyByHdr(
    nsIMsgDBHdr* msgHdr, const char* propertyName, uint32_t propertyValue) {
  NS_ENSURE_ARG(msgHdr);
  return msgHdr->SetUint32Property(propertyName, propertyValue);
}
NS_IMETHODIMP PerFolderDatabase::GetFirstNew(nsMsgKey* aFirstNew) {
  NS_ENSURE_ARG_POINTER(aFirstNew);
  if (mNewList.IsEmpty()) {
    *aFirstNew = nsMsgKey_None;
  } else {
    *aFirstNew = mNewList[0];
  }
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::GetMsgRetentionSettings(
    nsIMsgRetentionSettings** aMsgRetentionSettings) {
  NS_ENSURE_ARG_POINTER(aMsgRetentionSettings);
  *aMsgRetentionSettings = nullptr;
  RememberLastUseTime();
  MOZ_TRY(CheckDatabaseSource());
  MOZ_TRY(CheckFolderExists());
  RefPtr<FolderInfo> info = new FolderInfo(this);
  uint32_t retainBy, days, count;
  bool useDefaults, applyToFlagged;
  MOZ_TRY(info->GetUint32Property(
      "retainBy", nsIMsgRetentionSettings::nsMsgRetainAll, &retainBy));
  MOZ_TRY(info->GetUint32Property("daysToKeepHdrs", 0, &days));
  MOZ_TRY(info->GetUint32Property("numHdrsToKeep", 0, &count));
  MOZ_TRY(info->GetBooleanProperty("useServerDefaults", true, &useDefaults));
  MOZ_TRY(info->GetBooleanProperty("applyToFlaggedMessages", false,
                                   &applyToFlagged));
  nsresult rv;
  nsCOMPtr<nsIMsgRetentionSettings> settings =
      do_CreateInstance("@mozilla.org/msgDatabase/retentionSettings;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  MOZ_TRY(settings->SetRetainByPreference(retainBy));
  MOZ_TRY(settings->SetDaysToKeepHdrs(days));
  MOZ_TRY(settings->SetNumHeadersToKeep(count));
  MOZ_TRY(settings->SetUseServerDefaults(useDefaults));
  MOZ_TRY(settings->SetApplyToFlaggedMessages(applyToFlagged));
  settings.forget(aMsgRetentionSettings);
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::SetMsgRetentionSettings(
    nsIMsgRetentionSettings* aMsgRetentionSettings) {
  RememberLastUseTime();
  MOZ_TRY(CheckFolderExists());
  if (!aMsgRetentionSettings) {
    return NS_OK;
  }
  uint32_t retainBy, days, count;
  bool useDefaults, applyToFlagged;
  MOZ_TRY(aMsgRetentionSettings->GetRetainByPreference(&retainBy));
  MOZ_TRY(aMsgRetentionSettings->GetDaysToKeepHdrs(&days));
  MOZ_TRY(aMsgRetentionSettings->GetNumHeadersToKeep(&count));
  MOZ_TRY(aMsgRetentionSettings->GetUseServerDefaults(&useDefaults));
  MOZ_TRY(aMsgRetentionSettings->GetApplyToFlaggedMessages(&applyToFlagged));
  MOZ_TRY(CheckDatabaseSource());
  MOZ_TRY(CheckFolderExists());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool inTransaction;
  MOZ_TRY(connection->GetTransactionInProgress(&inTransaction));
  NS_ENSURE_FALSE(inTransaction, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(connection->BeginTransaction());
  RefPtr<FolderInfo> info = new FolderInfo(this);
  nsresult rv = [&]() -> nsresult {
    MOZ_TRY(info->SetUint32Property("retainBy", retainBy));
    MOZ_TRY(info->SetUint32Property("daysToKeepHdrs", days));
    MOZ_TRY(info->SetUint32Property("numHdrsToKeep", count));
    MOZ_TRY(info->SetBooleanProperty("useServerDefaults", useDefaults));
    MOZ_TRY(info->SetBooleanProperty("applyToFlaggedMessages", applyToFlagged));
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    nsresult cleanupRv = connection->GetTransactionInProgress(&inTransaction);
    if (NS_SUCCEEDED(cleanupRv) && inTransaction) {
      cleanupRv = connection->RollbackTransaction();
    }
    if (NS_FAILED(cleanupRv)) {
      MOZ_LOG(gPanoramaLog, LogLevel::Error,
              ("Retention settings rollback failed: 0x%08x",
               static_cast<uint32_t>(cleanupRv)));
    }
  }
  return rv;
}
NS_IMETHODIMP PerFolderDatabase::ApplyRetentionSettings(
    nsIMsgRetentionSettings* settings, bool deleteViaFolder) {
  NS_ENSURE_ARG(settings);
  RememberLastUseTime();
  nsCOMPtr<nsIMsgFolder> folder;
  MOZ_TRY(GetFolder(getter_AddRefs(folder)));
  bool special;
  MOZ_TRY(folder->IsSpecialFolder(nsMsgFolderFlags::Drafts |
                                      nsMsgFolderFlags::Templates |
                                      nsMsgFolderFlags::Queue,
                                  true, &special));
  if (special) {
    return NS_OK;
  }
  uint32_t retainBy, days, count;
  bool applyToFlagged;
  MOZ_TRY(settings->GetRetainByPreference(&retainBy));
  MOZ_TRY(settings->GetApplyToFlaggedMessages(&applyToFlagged));
  MOZ_TRY(settings->GetDaysToKeepHdrs(&days));
  MOZ_TRY(settings->GetNumHeadersToKeep(&count));
  NS_ENSURE_TRUE(
      retainBy == nsIMsgRetentionSettings::nsMsgRetainAll ||
          retainBy == nsIMsgRetentionSettings::nsMsgRetainByAge ||
          retainBy == nsIMsgRetentionSettings::nsMsgRetainByNumHeaders,
      NS_ERROR_ILLEGAL_VALUE);

  MOZ_TRY(CheckDatabaseSource());
  MOZ_TRY(CheckFolderExists());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool inTransaction;
  MOZ_TRY(connection->GetTransactionInProgress(&inTransaction));
  NS_ENSURE_FALSE(inTransaction, NS_ERROR_IN_PROGRESS);

  nsTArray<nsMsgKey> keys;
  nsTArray<std::pair<PRTime, nsMsgKey>> candidates;
  if (retainBy != nsIMsgRetentionSettings::nsMsgRetainAll) {
    MOZ_TRY(ListAllKeys(keys));
    CheckedInt<PRTime> cutoff(PR_Now());
    cutoff -= CheckedInt<PRTime>(days) * PR_USEC_PER_DAY;
    for (nsMsgKey key : keys) {
      CapturedMessage message;
      MOZ_TRY(MessageDB().CaptureMessage(key, message));
      NS_ENSURE_TRUE(message.folderId == mFolderId, NS_ERROR_NOT_AVAILABLE);
      if (!applyToFlagged && (message.flags & nsMsgMessageFlags::Marked)) {
        continue;
      }
      // An unrepresentably distant cutoff cannot expire any stored date.
      if (retainBy == nsIMsgRetentionSettings::nsMsgRetainByAge &&
          (!cutoff.isValid() || message.date >= cutoff.value())) {
        continue;
      }
      candidates.EmplaceBack(message.date, key);
    }
    candidates.Sort();
    if (retainBy == nsIMsgRetentionSettings::nsMsgRetainByNumHeaders) {
      size_t excess = keys.Length() > count ? keys.Length() - count : 0;
      candidates.TruncateLength(std::min<size_t>(excess, candidates.Length()));
    }
  }
  nsTArray<RefPtr<nsIMsgDBHdr>> headers;
  for (const auto& candidate : candidates) {
    nsCOMPtr<nsIMsgDBHdr> header;
    MOZ_TRY(GetMsgHdrForKey(candidate.second, getter_AddRefs(header)));
    headers.AppendElement(header);
  }
  char date[100];
  PRExplodedTime exploded;
  PR_ExplodeTime(PR_Now(), PR_LocalTimeParameters, &exploded);
  PR_FormatTimeUSEnglish(date, sizeof(date), "%a %b %d %H:%M:%S %Y", &exploded);
  RefPtr<FolderInfo> info = new FolderInfo(this);
  MOZ_TRY(info->SetCharProperty("LastPurgeTime", nsDependentCString(date)));
  if (headers.IsEmpty()) {
    return NS_OK;
  }
  if (deleteViaFolder) {
    return folder->DeleteMessages(headers, nullptr, true, false, nullptr,
                                  false);
  }
  // Each checked removal owns its transaction. A later failure leaves the
  // already-applied prefix; body storage remains the folder/provider's job.
  nsTArray<nsMsgKey> selected;
  selected.SetCapacity(candidates.Length());
  for (const auto& candidate : candidates) {
    selected.AppendElement(candidate.second);
  }
  return DeleteMessages(selected, nullptr);
}
NS_IMETHODIMP PerFolderDatabase::GetMsgDownloadSettings(
    nsIMsgDownloadSettings** aMsgDownloadSettings) {
  NS_ENSURE_ARG_POINTER(aMsgDownloadSettings);
  *aMsgDownloadSettings = nullptr;
  MOZ_TRY(CheckFolderExists());
  RefPtr<FolderInfo> info = new FolderInfo(this);
  bool useDefaults, byDate, unreadOnly;
  uint32_t ageLimit;
  MOZ_TRY(info->GetBooleanProperty("useServerDefaults", true, &useDefaults));
  MOZ_TRY(info->GetBooleanProperty("downloadByDate", false, &byDate));
  MOZ_TRY(info->GetBooleanProperty("downloadUnreadOnly", false, &unreadOnly));
  MOZ_TRY(info->GetUint32Property("ageLimit", 0, &ageLimit));
  nsresult rv;
  nsCOMPtr<nsIMsgDownloadSettings> settings =
      do_CreateInstance("@mozilla.org/msgDatabase/downloadSettings;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  MOZ_TRY(settings->SetUseServerDefaults(useDefaults));
  MOZ_TRY(settings->SetDownloadByDate(byDate));
  MOZ_TRY(settings->SetDownloadUnreadOnly(unreadOnly));
  MOZ_TRY(settings->SetAgeLimitOfMsgsToDownload(ageLimit));
  settings.forget(aMsgDownloadSettings);
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::SetMsgDownloadSettings(
    nsIMsgDownloadSettings* aMsgDownloadSettings) {
  MOZ_TRY(CheckFolderExists());
  if (!aMsgDownloadSettings) {
    return NS_OK;
  }
  bool useDefaults, byDate, unreadOnly;
  uint32_t ageLimit;
  MOZ_TRY(aMsgDownloadSettings->GetUseServerDefaults(&useDefaults));
  MOZ_TRY(aMsgDownloadSettings->GetDownloadByDate(&byDate));
  MOZ_TRY(aMsgDownloadSettings->GetDownloadUnreadOnly(&unreadOnly));
  MOZ_TRY(aMsgDownloadSettings->GetAgeLimitOfMsgsToDownload(&ageLimit));
  MOZ_TRY(DatabaseCore::EnsureConnection());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool inTransaction;
  MOZ_TRY(connection->GetTransactionInProgress(&inTransaction));
  NS_ENSURE_FALSE(inTransaction, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(connection->BeginTransaction());
  RefPtr<FolderInfo> info = new FolderInfo(this);
  nsresult rv = [&]() -> nsresult {
    MOZ_TRY(info->SetBooleanProperty("useServerDefaults", useDefaults));
    MOZ_TRY(info->SetBooleanProperty("downloadByDate", byDate));
    MOZ_TRY(info->SetBooleanProperty("downloadUnreadOnly", unreadOnly));
    MOZ_TRY(info->SetUint32Property("ageLimit", ageLimit));
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    nsresult cleanupRv = connection->GetTransactionInProgress(&inTransaction);
    if (NS_SUCCEEDED(cleanupRv) && inTransaction) {
      cleanupRv = connection->RollbackTransaction();
    }
    if (NS_FAILED(cleanupRv)) {
      MOZ_LOG(gPanoramaLog, LogLevel::Error,
              ("Download settings rollback failed: 0x%08x",
               static_cast<uint32_t>(cleanupRv)));
    }
  }
  return rv;
}
NS_IMETHODIMP PerFolderDatabase::HasNew(bool* aHasNew) {
  NS_ENSURE_ARG_POINTER(aHasNew);
  *aHasNew = !mNewList.IsEmpty();
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::SortNewKeysIfNeeded() {
  mNewList.Sort();
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::ClearNewList(bool aNotify) {
  RefPtr<PerFolderDatabase> self(this);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  struct Change {
    nsCOMPtr<nsIMsgDBHdr> header;
    uint32_t rawFlags;
  };
  nsTArray<Change> changes;
  if (aNotify) {
    // Finish all fallible reads before changing membership or notifying anyone.
    // These raw words remain historical even if an earlier listener mutates a
    // later header during fanout.
    for (nsMsgKey key : mNewList) {
      nsCOMPtr<nsIMsgDBHdr> header;
      MOZ_TRY(GetMsgHdrForKey(key, getter_AddRefs(header)));
      uint32_t flags;
      MOZ_TRY(MessageDB().GetMessageFlags(key, flags));
      if (!(flags & nsMsgMessageFlags::New)) {
        changes.AppendElement(Change{header, flags});
      }
    }
  }
  mNewList.Clear();
  for (const Change& change : changes) {
    if (mForceClosed) {
      break;
    }
    NotifyHdrChangeAll(change.header, change.rawFlags | nsMsgMessageFlags::New,
                       change.rawFlags, nullptr);
  }
  // Preserve entries added by a listener after the clear, and preserve stored
  // New bits: this operation removes only the facade's list contribution.
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::AddToNewList(nsMsgKey aKey) {
  nsCOMPtr<nsIMsgDBHdr> member;
  MOZ_TRY(GetMsgHdrForKey(aKey, getter_AddRefs(member)));
  if (!mNewList.Contains(aKey)) {
    mNewList.AppendElement(aKey);
  }
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::GetSummaryValid(bool* summaryValid) {
  NS_ENSURE_ARG_POINTER(summaryValid);
  *summaryValid = false;
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  // Existing databases have no invalid-summary marker until a repair starts.
  nsCOMPtr<nsIDBFolderInfo> info;
  MOZ_TRY(GetDBFolderInfo(getter_AddRefs(info)));
  bool valid = true;
  MOZ_TRY(info->GetBooleanProperty("summaryValid", true, &valid));
  *summaryValid = valid;
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::SetSummaryValid(bool summaryValid) {
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  nsCOMPtr<nsIDBFolderInfo> info;
  MOZ_TRY(GetDBFolderInfo(getter_AddRefs(info)));
  return info->SetBooleanProperty("summaryValid", summaryValid);
}
NS_IMETHODIMP PerFolderDatabase::ListAllOfflineMsgs(
    nsTArray<nsMsgKey>& aRetVal) {
  aRetVal.Clear();
  nsCOMPtr<nsIMsgFolder> folder;
  MOZ_TRY(GetFolder(getter_AddRefs(folder)));
  nsCOMPtr<nsIMsgPluggableStore> store;
  MOZ_TRY(folder->GetMsgStore(getter_AddRefs(store)));
  nsTArray<nsMsgKey> keys;
  MOZ_TRY(ListAllKeys(keys));
  nsTArray<nsMsgKey> offline;
  for (nsMsgKey key : keys) {
    nsCOMPtr<nsIMsgDBHdr> header;
    MOZ_TRY(GetMsgHdrForKey(key, getter_AddRefs(header)));
    uint32_t flags;
    MOZ_TRY(header->GetFlags(&flags));
    if (!(flags & nsMsgMessageFlags::Offline) ||
        (flags & nsMsgMessageFlags::Partial)) {
      continue;
    }
    nsAutoCString token;
    MOZ_TRY(header->GetStoreToken(token));
    if (token.IsEmpty()) {
      continue;
    }
    nsCOMPtr<nsIInputStream> stream;
    nsresult rv =
        store->GetMsgInputStream(folder, token, 0, getter_AddRefs(stream));
    if (rv == NS_ERROR_FILE_NOT_FOUND) {
      continue;
    }
    NS_ENSURE_SUCCESS(rv, rv);
    // Opening an mbox stream alone does not validate the token's offset.
    char firstByte;
    uint32_t read;
    rv = stream->Read(&firstByte, 1, &read);
    nsresult closeRv = stream->Close();
    NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_SUCCESS(closeRv, closeRv);
    if (read) {
      offline.AppendElement(key);
    }
  }
  aRetVal = std::move(offline);
  return NS_OK;
}
nsresult PerFolderDatabase::GetPendingHdr(nsIMsgDBHdr* header,
                                          RefPtr<DetachedMsgHdr>& draft) {
  NS_ENSURE_ARG(header);
  RefPtr<PerFolderDatabase> self(this);
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  RefPtr<DetachedMsgHdr> native = do_QueryObject(header);
  // A foreign QueryInterface can run code. Recheck before admitting its result.
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  NS_ENSURE_TRUE(native && native->mFolderId == mFolderId &&
                     native->mPendingOwner.get() == this &&
                     native->mPendingSourceId == mDatabaseSourceId,
                 NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(native->CheckMutable());
  draft = std::move(native);
  return NS_OK;
}

nsresult PerFolderDatabase::AppendPendingAttribute(
    nsIMsgDBHdr* header, const PendingHeaderAttribute& attribute) {
  RefPtr<DetachedMsgHdr> draft;
  MOZ_TRY(GetPendingHdr(header, draft));
  NS_ENSURE_FALSE(attribute.name.IsEmpty(), NS_ERROR_INVALID_ARG);
  // These fields can only come from checked server confirmation or the actual
  // destination provider's Finish receipt. The source header is not that proof.
  if (attribute.name.EqualsLiteral("uidOnServer") ||
      attribute.name.EqualsLiteral("storeToken") ||
      attribute.name.EqualsLiteral("messageSize") ||
      attribute.name.EqualsLiteral("offlineMsgSize") ||
      attribute.name.EqualsLiteral("offlineMessageSize") ||
      attribute.name.EqualsLiteral("lineCount")) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  if (attribute.name.EqualsLiteral("flags")) {
    NS_ENSURE_TRUE(attribute.integer && *attribute.integer <= UINT32_MAX,
                   NS_ERROR_ILLEGAL_VALUE);
    NS_ENSURE_FALSE(*attribute.integer & nsMsgMessageFlags::Offline,
                    NS_ERROR_NOT_AVAILABLE);
  }
  if (attribute.name.EqualsLiteral("priority")) {
    if (attribute.integer) {
      NS_ENSURE_TRUE(*attribute.integer <= nsMsgPriority::highest,
                     NS_ERROR_ILLEGAL_VALUE);
    } else {
      NS_ENSURE_TRUE(attribute.text.Length() == 1 && attribute.text[0] >= '0' &&
                         attribute.text[0] <= '6',
                     NS_ERROR_INVALID_ARG);
    }
  }
  draft->mPendingAttributes.AppendElement(attribute);
  return NS_OK;
}

NS_IMETHODIMP PerFolderDatabase::SetAttributeOnPendingHdr(
    nsIMsgDBHdr* pendingHdr, const char* property, const char* propertyVal) {
  NS_ENSURE_ARG_POINTER(property);
  NS_ENSURE_ARG_POINTER(propertyVal);
  return AppendPendingAttribute(
      pendingHdr, {nsCString(property), nsCString(propertyVal), Nothing()});
}
NS_IMETHODIMP PerFolderDatabase::SetUint32AttributeOnPendingHdr(
    nsIMsgDBHdr* pendingHdr, const char* property, uint32_t propertyVal) {
  return SetUint64AttributeOnPendingHdr(pendingHdr, property, propertyVal);
}
NS_IMETHODIMP PerFolderDatabase::SetUint64AttributeOnPendingHdr(
    nsIMsgDBHdr* pendingHdr, const char* property, uint64_t propertyVal) {
  NS_ENSURE_ARG_POINTER(property);
  return AppendPendingAttribute(
      pendingHdr, {nsCString(property), nsCString(), Some(propertyVal)});
}
NS_IMETHODIMP PerFolderDatabase::UpdatePendingAttributes(nsIMsgDBHdr* header) {
  RefPtr<DetachedMsgHdr> draft;
  MOZ_TRY(GetPendingHdr(header, draft));
  // Prepare the whole ordered batch before replacing metadata or consuming it.
  auto extras = draft->mRaw.extras.Clone();
  nsCString keywords = draft->mRaw.keywords;
  auto priority = draft->mRaw.priority;
  uint32_t flags = draft->mRaw.flags;
  for (const auto& attribute : draft->mPendingAttributes) {
    if (attribute.name.EqualsLiteral("flags")) {
      flags |= static_cast<uint32_t>(*attribute.integer);
    } else if (attribute.name.EqualsLiteral("priority")) {
      priority = static_cast<nsMsgPriorityValue>(
          attribute.integer ? *attribute.integer : attribute.text[0] - '0');
    } else {
      nsAutoCString text;
      if (attribute.integer) {
        text.AppendInt(*attribute.integer, 16);
      } else {
        text = attribute.text;
      }
      if (attribute.name.EqualsLiteral("keywords")) {
        keywords = text;
      } else {
        extras.AppendElement(RawHdr::kv{attribute.name, text});
        continue;
      }
    }
    extras.RemoveElementsBy(
        [&](const auto& extra) { return extra.k == attribute.name; });
  }
  draft->mRaw.extras = std::move(extras);
  draft->mRaw.keywords = std::move(keywords);
  draft->mRaw.priority = priority;
  draft->mRaw.flags = flags;
  draft->mPendingAttributes.Clear();
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::GetNextPseudoMsgKey(nsMsgKey* key) {
  NS_ENSURE_ARG_POINTER(key);
  *key = nsMsgKey_None;
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  *key = mNextPseudoMsgKey--;
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::SetNextPseudoMsgKey(nsMsgKey key) {
  MOZ_TRY(CheckFolderExists());
  MOZ_TRY(CheckDatabaseSource());
  mNextPseudoMsgKey = key;
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::GetNextFakeOfflineMsgKey(nsMsgKey* key) {
  NS_ENSURE_ARG_POINTER(key);
  *key = nsMsgKey_None;
  MOZ_TRY(CheckFolderExists());
  return MessageDB().ReserveOfflineOperationKey(mFolderId, *key);
}
NS_IMETHODIMP PerFolderDatabase::GetDefaultViewFlags(
    nsMsgViewFlagsTypeValue* viewFlags) {
  NS_ENSURE_ARG_POINTER(viewFlags);

  Preferences::GetInt(mIsNewsFolder ? "mailnews.default_news_view_flags"
                                    : "mailnews.default_view_flags",
                      viewFlags);
  if (*viewFlags < nsMsgViewFlagsType::kNone ||
      *viewFlags >
          (nsMsgViewFlagsType::kThreadedDisplay |
           nsMsgViewFlagsType::kShowIgnored | nsMsgViewFlagsType::kUnreadOnly |
           nsMsgViewFlagsType::kExpandAll | nsMsgViewFlagsType::kGroupBySort)) {
    *viewFlags = nsMsgViewFlagsType::kNone;
  }
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::GetDefaultSortType(
    nsMsgViewSortTypeValue* sortType) {
  NS_ENSURE_ARG_POINTER(sortType);

  Preferences::GetInt(mIsNewsFolder ? "mailnews.default_news_sort_type"
                                    : "mailnews.default_sort_type",
                      sortType);
  if (*sortType < nsMsgViewSortType::byDate ||
      *sortType > nsMsgViewSortType::byCorrespondent ||
      *sortType == nsMsgViewSortType::byCustom) {
    *sortType = nsMsgViewSortType::byDate;
  }
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::GetDefaultSortOrder(
    nsMsgViewSortOrderValue* sortOrder) {
  NS_ENSURE_ARG_POINTER(sortOrder);

  Preferences::GetInt(mIsNewsFolder ? "mailnews.default_news_sort_order"
                                    : "mailnews.default_sort_order",
                      sortOrder);
  if (*sortOrder != nsMsgViewSortOrder::descending) {
    *sortOrder = nsMsgViewSortOrder::ascending;
  }
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::GetMsgHdrCacheSize(
    uint32_t* aMsgHdrCacheSize) {
  NS_ENSURE_ARG_POINTER(aMsgHdrCacheSize);
  *aMsgHdrCacheSize = mMsgHdrCacheSize;
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::SetMsgHdrCacheSize(uint32_t aMsgHdrCacheSize) {
  mMsgHdrCacheSize = aMsgHdrCacheSize;
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::GetNewList(nsTArray<nsMsgKey>& aNewList) {
  aNewList = mNewList.Clone();
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::GetCachedHits(
    const nsACString& aSearchFolderUri, nsIMsgEnumerator** aRetVal) {
  NS_ENSURE_ARG_POINTER(aRetVal);
  *aRetVal = nullptr;
  MOZ_TRY(CheckEnumerationState(mEnumeratorGeneration));
  uint64_t folderId = MOZ_TRY(FolderURIToId(aSearchFolderUri));

  // The cache owns the original statement. Each cursor needs an independent
  // clone, including when an older cursor is retained across Close.
  nsCOMPtr<mozIStorageStatement> cached =
      MOZ_TRY(SearchFolderHitsCache::SelectAllForFolderStmt(folderId));
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(cached->Clone(getter_AddRefs(stmt)));
  MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, folderId));

  // `MessageEnumerator` works as long as the statement provides IDs that map to
  // the `messages` table, so although we're not reading directly from that
  // table it still works here.
  RefPtr<MessageEnumerator> enumerator = new MessageEnumerator(this, stmt);

  // Consumers expect us to return a null pointer rather than an empty
  // enumerator if we don't have any hits, because in a Mork world the lack of
  // hits shows by the absence of the relevant table in the folder's database.
  // This is not really a thing in the Panorama world but we need to preserve
  // this behaviour for compatibility.
  bool hasMessages;
  MOZ_TRY(enumerator->HasMoreElements(&hasMessages));
  if (hasMessages) {
    enumerator.forget(aRetVal);
  } else {
    *aRetVal = nullptr;
  }

  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::RefreshCache(
    const nsACString& aSearchFolderUri, const nsTArray<nsMsgKey>& aNewHits,
    nsTArray<nsMsgKey>& aStaleHits) {
  uint64_t folderId = MOZ_TRY(FolderURIToId(aSearchFolderUri));

  // Before we do any replacing, figure out what the current hits are, so we can
  // determine which ones are stale.
  nsCOMPtr<mozIStorageStatement> stmt =
      MOZ_TRY(SearchFolderHitsCache::SelectAllForFolderStmt(folderId));
  mozStorageStatementScoper scoper(stmt);

  nsTArray<nsMsgKey> currentHits;
  while (true) {
    bool hasResults;
    MOZ_TRY(stmt->ExecuteStep(&hasResults));
    if (!hasResults) {
      break;
    }

    nsMsgKey msgKey = stmt->AsInt32(0);
    currentHits.AppendElement(msgKey);
  }

  // If a hit isn't in `aNewHits` then we should mark it as stale for the
  // consumer.
  aStaleHits.Clear();
  for (uint64_t i = 0; i < currentHits.Length(); i++) {
    nsMsgKey msgId = currentHits[i];
    if (!aNewHits.Contains(msgId)) {
      aStaleHits.AppendElement(msgId);
    }
  }

  // Delete the previous list of hits for this folder so we can replace it with
  // the new list.
  MOZ_TRY(SearchFolderHitsCache::RemoveAllHitsForFolder(folderId));

  // Now insert the new list of hits.
  MOZ_TRY(SearchFolderHitsCache::AddHitsForFolder(folderId, aNewHits));

  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::UpdateHdrInCache(
    const nsACString& aSearchFolderUri, nsIMsgDBHdr* aHdr, bool aAdd) {
  uint64_t folderId = MOZ_TRY(FolderURIToId(aSearchFolderUri));

  nsMsgKey messageKey;
  MOZ_TRY(aHdr->GetMessageKey(&messageKey));

  if (aAdd) {
    MOZ_TRY(SearchFolderHitsCache::AddHitsForFolder(folderId, {messageKey}));
  } else {
    MOZ_TRY(SearchFolderHitsCache::RemoveHitForFolder(folderId, messageKey));
  }

  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::HdrIsInCache(
    const nsACString& aSearchFolderUri, nsIMsgDBHdr* aHdr, bool* aIsInCache) {
  uint64_t folderId = MOZ_TRY(FolderURIToId(aSearchFolderUri));

  nsMsgKey msgKey;
  MOZ_TRY(aHdr->GetMessageKey(&msgKey));

  bool inCache = MOZ_TRY(SearchFolderHitsCache::KeyIsInCache(folderId, msgKey));
  *aIsInCache = inCache;

  return NS_OK;
}

// The existing announcer owns this listener, not the enumerator. A cursor can
// therefore be dropped independently, while a retained cursor cannot keep its
// cloned statement open after the folder database goes away.
class MessageEnumeratorStatementCloser final : public nsIDBChangeListener,
                                               public SupportsWeakPtr {
 public:
  NS_DECL_ISUPPORTS

  MessageEnumeratorStatementCloser(PerFolderDatabase* owner,
                                   mozIStorageStatement* stmt)
      : mOwner(owner), mStmt(stmt) {}

  nsresult Watch() {
    return mOwner ? mOwner->AddListener(this) : NS_ERROR_NOT_AVAILABLE;
  }

  bool IsOpen() const { return !!mStmt; }

  nsresult Close() {
    RefPtr<MessageEnumeratorStatementCloser> self(this);
    nsresult rv = NS_OK;
    if (mStmt) {
      rv = mStmt->Finalize();
      mStmt = nullptr;
    }
    if (mOwner) {
      RefPtr<PerFolderDatabase> owner = mOwner.get();
      mOwner = nullptr;
      owner->RemoveListener(this);
    }
    return rv;
  }

  NS_IMETHOD OnAnnouncerGoingAway(nsIDBChangeAnnouncer*) override {
    return Close();
  }
  NS_IMETHOD OnHdrFlagsChanged(nsIMsgDBHdr*, uint32_t, uint32_t,
                               nsIDBChangeListener*) override {
    return NS_OK;
  }
  NS_IMETHOD OnHdrDeleted(nsIMsgDBHdr*, nsMsgKey, int32_t,
                          nsIDBChangeListener*) override {
    return NS_OK;
  }
  NS_IMETHOD OnHdrAdded(nsIMsgDBHdr*, nsMsgKey, int32_t,
                        nsIDBChangeListener*) override {
    return NS_OK;
  }
  NS_IMETHOD OnParentChanged(nsMsgKey, nsMsgKey, nsMsgKey,
                             nsIDBChangeListener*) override {
    return NS_OK;
  }
  NS_IMETHOD OnReadChanged(nsIDBChangeListener*) override { return NS_OK; }
  NS_IMETHOD OnJunkScoreChanged(nsIDBChangeListener*) override { return NS_OK; }
  NS_IMETHOD OnHdrPropertyChanged(nsIMsgDBHdr*, const nsACString&, bool,
                                  uint32_t*, nsIDBChangeListener*) override {
    return NS_OK;
  }
  NS_IMETHOD OnEvent(nsIMsgDatabase*, const char*) override { return NS_OK; }

 private:
  ~MessageEnumeratorStatementCloser() {
    // The owner's destruction also drops the listener without a callback.
    if (mStmt) {
      mStmt->Finalize();
    }
  }

  WeakPtr<PerFolderDatabase> mOwner;
  nsCOMPtr<mozIStorageStatement> mStmt;
};

NS_IMPL_ISUPPORTS(MessageEnumeratorStatementCloser, nsIDBChangeListener)

MessageEnumerator::MessageEnumerator(PerFolderDatabase* owner,
                                     mozIStorageStatement* stmt)
    : mOwner(owner), mGeneration(owner->mEnumeratorGeneration), mStmt(stmt) {
  RefPtr<MessageEnumeratorStatementCloser> closer =
      new MessageEnumeratorStatementCloser(owner, stmt);
  mStatus = closer->Watch();
  if (NS_FAILED(mStatus)) {
    closer->Close();
    mStmt = nullptr;
    return;
  }
  mStatementCloser = closer;
  Advance();
}

MessageEnumerator::~MessageEnumerator() { ReleaseStatement(); }

nsresult MessageEnumerator::ReleaseStatement() {
  nsresult rv = mStatementCloser ? mStatementCloser->Close() : NS_OK;
  mStatementCloser = nullptr;
  mStmt = nullptr;
  return rv;
}

bool MessageEnumerator::CheckOwner() {
  if (mOwner && !mOwner->mForceClosed &&
      mGeneration == mOwner->mEnumeratorGeneration &&
      (!mHasNext || (mStatementCloser && mStatementCloser->IsOpen()))) {
    if (NS_SUCCEEDED(mStatus)) {
      mStatus = mOwner->CheckEnumerationState(mGeneration);
    }
    if (NS_SUCCEEDED(mStatus)) {
      return true;
    }
  }
  mHasNext = false;
  nsresult rv = ReleaseStatement();
  if (NS_SUCCEEDED(mStatus)) {
    mStatus = rv;
  }
  mOwner = nullptr;
  return false;
}

void MessageEnumerator::Advance() {
  mHasNext = false;
  mStatus = mStmt->ExecuteStep(&mHasNext);
  if (!mHasNext) {
    // A reset clone still prevents connection shutdown. Finish its ownership
    // here, preserving the original step error over any finalization error.
    nsresult rv = ReleaseStatement();
    if (NS_SUCCEEDED(mStatus)) {
      mStatus = rv;
    }
  }
}

NS_IMETHODIMP MessageEnumerator::GetNext(nsIMsgDBHdr** item) {
  NS_ENSURE_ARG_POINTER(item);
  *item = nullptr;
  bool current = CheckOwner();
  MOZ_TRY(mStatus);
  NS_ENSURE_TRUE(current && mHasNext, NS_ERROR_FAILURE);
  nsMsgKey key = static_cast<nsMsgKey>(mStmt->AsInt64(0));
  RefPtr<Message> message = new Message(key);
  MOZ_TRY(mOwner->CacheHeader(key, message));
  message.forget(item);
  Advance();
  return NS_OK;
}

NS_IMETHODIMP MessageEnumerator::HasMoreElements(bool* hasNext) {
  NS_ENSURE_ARG_POINTER(hasNext);
  *hasNext = false;
  bool current = CheckOwner();
  MOZ_TRY(mStatus);
  NS_ENSURE_TRUE(current, NS_ERROR_FAILURE);
  *hasNext = mHasNext;
  return NS_OK;
}

ThreadEnumerator::ThreadEnumerator(PerFolderDatabase* owner,
                                   mozIStorageStatement* stmt)
    : mOwner(owner),
      mGeneration(owner->mEnumeratorGeneration),
      mStmt(stmt),
      mFolderId(owner->FolderId()) {
  Advance();
}

bool ThreadEnumerator::CheckOwner() {
  if (mOwner && !mOwner->mForceClosed &&
      mGeneration == mOwner->mEnumeratorGeneration) {
    if (NS_SUCCEEDED(mStatus)) {
      mStatus = mOwner->CheckEnumerationState(mGeneration);
    }
    if (NS_SUCCEEDED(mStatus)) {
      return true;
    }
  }
  mHasNext = false;
  mStmt = nullptr;
  mOwner = nullptr;
  return false;
}

void ThreadEnumerator::Advance() {
  mHasNext = false;
  mStatus = mStmt->ExecuteStep(&mHasNext);
  if (!mHasNext) {
    // Reset promptly for JS consumers, preserving the original step error.
    nsresult rv = mStmt->Reset();
    if (NS_SUCCEEDED(mStatus)) {
      mStatus = rv;
    }
  }
}

NS_IMETHODIMP ThreadEnumerator::GetNext(nsIMsgThread** item) {
  NS_ENSURE_ARG_POINTER(item);
  *item = nullptr;
  bool current = CheckOwner();
  MOZ_TRY(mStatus);
  NS_ENSURE_TRUE(current && mHasNext, NS_ERROR_FAILURE);
  uint64_t threadId = mStmt->AsInt64(0);
  uint64_t maxDate = mStmt->AsDouble(1);
  RefPtr<Thread> thread = new Thread(mFolderId, threadId, maxDate);
  thread.forget(item);
  Advance();
  return NS_OK;
}

NS_IMETHODIMP ThreadEnumerator::HasMoreElements(bool* hasNext) {
  NS_ENSURE_ARG_POINTER(hasNext);
  *hasNext = false;
  bool current = CheckOwner();
  MOZ_TRY(mStatus);
  // A closed thread cursor is exhausted, as in the retained legacy adapter.
  if (current) {
    *hasNext = mHasNext;
  }
  return NS_OK;
}

NS_IMPL_ISUPPORTS(FolderInfo, nsIDBFolderInfo)

NS_IMETHODIMP FolderInfo::GetFlags(int32_t* aFlags) {
  NS_ENSURE_ARG_POINTER(aFlags);
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  *aFlags = MOZ_TRY(FolderDB().GetFolderFlags(mFolderId));
  return NS_OK;
}

NS_IMETHODIMP FolderInfo::SetFlags(int32_t aFlags) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  MOZ_TRY(FolderDB().RecordCacheClientFlagAttempt(
      mPerFolderDatabase->mDatabaseSourceId, mFolderId,
      kCacheImportClientMask));
  return FolderDB().UpdateFlags(mFolderId, aFlags);
}

NS_IMETHODIMP FolderInfo::OrFlags(int32_t aFlags, int32_t* aOutFlags) {
  NS_ENSURE_ARG_POINTER(aOutFlags);
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  MOZ_TRY(FolderDB().RecordCacheClientFlagAttempt(
      mPerFolderDatabase->mDatabaseSourceId, mFolderId,
      kCacheImportClientMask));
  uint32_t flags = MOZ_TRY(FolderDB().GetFolderFlags(mFolderId));
  flags |= aFlags;
  MOZ_TRY(FolderDB().UpdateFlags(mFolderId, flags));
  *aOutFlags = flags;
  return NS_OK;
}

NS_IMETHODIMP FolderInfo::AndFlags(int32_t aFlags, int32_t* aOutFlags) {
  NS_ENSURE_ARG_POINTER(aOutFlags);
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  MOZ_TRY(FolderDB().RecordCacheClientFlagAttempt(
      mPerFolderDatabase->mDatabaseSourceId, mFolderId,
      kCacheImportClientMask));
  uint32_t flags = MOZ_TRY(FolderDB().GetFolderFlags(mFolderId));
  flags &= aFlags;
  MOZ_TRY(FolderDB().UpdateFlags(mFolderId, flags));
  *aOutFlags = flags;
  return NS_OK;
}

NS_IMETHODIMP FolderInfo::OnKeyAdded(nsMsgKey aNewKey) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP FolderInfo::GetHighWater(nsMsgKey* aHighWater) {
  NS_ENSURE_ARG_POINTER(aHighWater);
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  return GetUint32Property("highWaterKey", 0, aHighWater);
}
NS_IMETHODIMP FolderInfo::SetHighWater(nsMsgKey aHighWater) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  return SetUint32Property("highWaterKey", aHighWater);
}
NS_IMETHODIMP FolderInfo::GetFolderSize(int64_t* aFolderSize) {
  NS_ENSURE_ARG_POINTER(aFolderSize);
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  int64_t value = 0;
  MOZ_TRY(GetInt64Property("folderSize", 0, &value));
  *aFolderSize = value;
  return NS_OK;
}
NS_IMETHODIMP FolderInfo::SetFolderSize(int64_t aFolderSize) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  return SetInt64Property("folderSize", aFolderSize);
}
NS_IMETHODIMP FolderInfo::GetFolderDate(uint32_t* aFolderDate) {
  NS_ENSURE_ARG_POINTER(aFolderDate);
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  uint32_t value = 0;
  MOZ_TRY(GetUint32Property("folderDate", 0, &value));
  *aFolderDate = value;
  return NS_OK;
}
NS_IMETHODIMP FolderInfo::SetFolderDate(uint32_t aFolderDate) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  return SetUint32Property("folderDate", aFolderDate);
}
NS_IMETHODIMP FolderInfo::ChangeNumUnreadMessages(int32_t aDelta) {
  return mPerFolderDatabase->ChangeCount(true, aDelta);
}
NS_IMETHODIMP FolderInfo::ChangeNumMessages(int32_t aDelta) {
  return mPerFolderDatabase->ChangeCount(false, aDelta);
}
NS_IMETHODIMP FolderInfo::GetNumUnreadMessages(int32_t* aNumUnreadMessages) {
  return mPerFolderDatabase->ReadCount(true, aNumUnreadMessages);
}
NS_IMETHODIMP FolderInfo::SetNumUnreadMessages(int32_t aNumUnreadMessages) {
  return mPerFolderDatabase->WriteCount(true, aNumUnreadMessages);
}
NS_IMETHODIMP FolderInfo::GetNumMessages(int32_t* aNumMessages) {
  return mPerFolderDatabase->ReadCount(false, aNumMessages);
}
NS_IMETHODIMP FolderInfo::SetNumMessages(int32_t aNumMessages) {
  return mPerFolderDatabase->WriteCount(false, aNumMessages);
}
NS_IMETHODIMP FolderInfo::GetExpungedBytes(int64_t* aExpungedBytes) {
  NS_ENSURE_ARG_POINTER(aExpungedBytes);
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  int64_t value;
  MOZ_TRY(GetInt64Property("expungedBytes", 0, &value));
  NS_ENSURE_TRUE(value >= 0, NS_ERROR_LOSS_OF_SIGNIFICANT_DATA);
  *aExpungedBytes = value;
  return NS_OK;
}
NS_IMETHODIMP FolderInfo::SetExpungedBytes(int64_t aExpungedBytes) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  NS_ENSURE_TRUE(aExpungedBytes >= 0, NS_ERROR_ILLEGAL_VALUE);
  return SetInt64Property("expungedBytes", aExpungedBytes);
}
NS_IMETHODIMP FolderInfo::GetImapUidValidity(ImapUid* aImapUidValidity) {
  NS_ENSURE_ARG_POINTER(aImapUidValidity);
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  uint32_t epoch;
  nsresult rv = FolderDB().GetFolderUidValidity(mFolderId, epoch);
  if (rv == NS_ERROR_NOT_AVAILABLE) {
    MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
    epoch = 0;
  } else {
    NS_ENSURE_SUCCESS(rv, rv);
  }
  *aImapUidValidity = epoch;
  return NS_OK;
}
NS_IMETHODIMP FolderInfo::SetImapUidValidity(ImapUid aImapUidValidity) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  return FolderDB().SetFolderUidValidity(mFolderId, aImapUidValidity);
}
NS_IMETHODIMP FolderInfo::GetVersion(uint32_t* aVersion) {
  NS_ENSURE_ARG_POINTER(aVersion);
  *aVersion = 0;
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  return GetUint32Property("version", 0, aVersion);
}
NS_IMETHODIMP FolderInfo::SetVersion(uint32_t aVersion) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  return SetUint32Property("version", aVersion);
}
NS_IMETHODIMP FolderInfo::GetImapTotalPendingMessages(
    int32_t* aImapTotalPendingMessages) {
  NS_ENSURE_ARG_POINTER(aImapTotalPendingMessages);
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  uint32_t value;
  MOZ_TRY(GetUint32Property("totPendingMsgs", 0, &value));
  *aImapTotalPendingMessages = static_cast<int32_t>(value);
  return NS_OK;
}
NS_IMETHODIMP FolderInfo::SetImapTotalPendingMessages(
    int32_t aImapTotalPendingMessages) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  return SetUint32Property("totPendingMsgs",
                           static_cast<uint32_t>(aImapTotalPendingMessages));
}
NS_IMETHODIMP FolderInfo::GetImapUnreadPendingMessages(
    int32_t* aImapUnreadPendingMessages) {
  NS_ENSURE_ARG_POINTER(aImapUnreadPendingMessages);
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  uint32_t value;
  MOZ_TRY(GetUint32Property("unreadPendingMsgs", 0, &value));
  *aImapUnreadPendingMessages = static_cast<int32_t>(value);
  return NS_OK;
}
NS_IMETHODIMP FolderInfo::SetImapUnreadPendingMessages(
    int32_t aImapUnreadPendingMessages) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  return SetUint32Property("unreadPendingMsgs",
                           static_cast<uint32_t>(aImapUnreadPendingMessages));
}
NS_IMETHODIMP FolderInfo::GetUserSortOrder(uint32_t* userSortOrder) {
  NS_ENSURE_ARG_POINTER(userSortOrder);
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  uint32_t value;
  MOZ_TRY(
      GetUint32Property("userSortOrder", nsIMsgFolder::NO_SORT_VALUE, &value));
  *userSortOrder = value;
  return NS_OK;
}
NS_IMETHODIMP FolderInfo::SetUserSortOrder(uint32_t userSortOrder) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  return SetUint32Property("userSortOrder", userSortOrder);
}
NS_IMETHODIMP FolderInfo::GetViewType(nsMsgViewTypeValue* viewType) {
  NS_ENSURE_ARG_POINTER(viewType);
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  uint32_t value;
  MOZ_TRY(
      GetUint32Property("viewType", nsMsgViewType::eShowAllThreads, &value));
  *viewType = static_cast<nsMsgViewTypeValue>(value);
  return NS_OK;
}
NS_IMETHODIMP FolderInfo::SetViewType(nsMsgViewTypeValue aViewType) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  return SetUint32Property("viewType", static_cast<uint32_t>(aViewType));
}

NS_IMETHODIMP FolderInfo::GetViewFlags(nsMsgViewFlagsTypeValue* viewFlags) {
  NS_ENSURE_ARG_POINTER(viewFlags);
  nsMsgViewFlagsTypeValue defaultViewFlags;
  MOZ_TRY(mPerFolderDatabase->GetDefaultViewFlags(&defaultViewFlags));
  return GetUint32Property("viewFlags", defaultViewFlags, (uint32_t*)viewFlags);
}
NS_IMETHODIMP FolderInfo::SetViewFlags(nsMsgViewFlagsTypeValue viewFlags) {
  return SetUint32Property("viewFlags", viewFlags);
}
NS_IMETHODIMP FolderInfo::GetSortType(nsMsgViewSortTypeValue* sortType) {
  NS_ENSURE_ARG_POINTER(sortType);
  nsMsgViewSortTypeValue defaultSortType;
  MOZ_TRY(mPerFolderDatabase->GetDefaultSortType(&defaultSortType));
  return GetUint32Property("sortType", defaultSortType, (uint32_t*)sortType);
}
NS_IMETHODIMP FolderInfo::SetSortType(nsMsgViewSortTypeValue sortType) {
  return SetUint32Property("sortType", sortType);
}
NS_IMETHODIMP FolderInfo::GetSortOrder(nsMsgViewSortOrderValue* sortOrder) {
  NS_ENSURE_ARG_POINTER(sortOrder);
  nsMsgViewSortOrderValue defaultSortOrder;
  MOZ_TRY(mPerFolderDatabase->GetDefaultSortOrder(&defaultSortOrder));
  return GetUint32Property("sortOrder", defaultSortOrder, (uint32_t*)sortOrder);
}
NS_IMETHODIMP FolderInfo::SetSortOrder(nsMsgViewSortOrderValue sortOrder) {
  return SetUint32Property("sortOrder", sortOrder);
}
NS_IMETHODIMP FolderInfo::ChangeExpungedBytes(int32_t aDelta) {
  int64_t value;
  MOZ_TRY(GetExpungedBytes(&value));
  CheckedInt<int64_t> changed(value);
  changed += aDelta;
  NS_ENSURE_TRUE(changed.isValid(), NS_ERROR_LOSS_OF_SIGNIFICANT_DATA);
  return SetExpungedBytes(changed.value());
}
NS_IMETHODIMP FolderInfo::GetCharProperty(const char* propertyName,
                                          nsACString& propertyValue) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  return FolderDB().GetFolderProperty(
      mFolderId, nsDependentCString(propertyName), propertyValue);
}
NS_IMETHODIMP FolderInfo::SetCharProperty(const char* propertyName,
                                          const nsACString& propertyValue) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  return FolderDB().SetFolderProperty(
      mFolderId, nsDependentCString(propertyName), propertyValue);
}
NS_IMETHODIMP FolderInfo::GetUint32Property(const char* propertyName,
                                            uint32_t defaultValue,
                                            uint32_t* propertyValue) {
  NS_ENSURE_ARG_POINTER(propertyValue);
  *propertyValue = defaultValue;
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  int64_t value = defaultValue;
  MOZ_TRY(FolderDB().GetFolderProperty(
      mFolderId, nsDependentCString(propertyName), &value));
  CheckedInt<uint32_t> checkedValue(value);
  if (!checkedValue.isValid()) {
    return NS_ERROR_LOSS_OF_SIGNIFICANT_DATA;
  }
  *propertyValue = checkedValue.value();
  return NS_OK;
}
NS_IMETHODIMP FolderInfo::SetUint32Property(const char* propertyName,
                                            uint32_t propertyValue) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  return FolderDB().SetFolderProperty(
      mFolderId, nsDependentCString(propertyName), (int64_t)propertyValue);
}
NS_IMETHODIMP FolderInfo::GetInt64Property(const char* propertyName,
                                           int64_t defaultValue,
                                           int64_t* propertyValue) {
  NS_ENSURE_ARG_POINTER(propertyValue);
  *propertyValue = defaultValue;
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  return FolderDB().GetFolderProperty(
      mFolderId, nsDependentCString(propertyName), propertyValue);
}
NS_IMETHODIMP FolderInfo::SetInt64Property(const char* propertyName,
                                           int64_t propertyValue) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  return FolderDB().SetFolderProperty(
      mFolderId, nsDependentCString(propertyName), propertyValue);
}
NS_IMETHODIMP FolderInfo::GetBooleanProperty(const char* propertyName,
                                             bool defaultValue,
                                             bool* propertyValue) {
  NS_ENSURE_ARG_POINTER(propertyValue);
  *propertyValue = defaultValue;
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  int64_t value = defaultValue;
  MOZ_TRY(FolderDB().GetFolderProperty(
      mFolderId, nsDependentCString(propertyName), &value));
  *propertyValue = value != 0;
  return NS_OK;
}
NS_IMETHODIMP FolderInfo::SetBooleanProperty(const char* propertyName,
                                             bool propertyValue) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  return FolderDB().SetFolderProperty(
      mFolderId, nsDependentCString(propertyName), (int64_t)propertyValue);
}
NS_IMETHODIMP FolderInfo::GetProperty(const char* propertyName,
                                      nsAString& propertyValue) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  nsAutoCString value;
  nsresult rv = FolderDB().GetFolderProperty(
      mFolderId, nsDependentCString(propertyName), value);
  NS_ENSURE_SUCCESS(rv, rv);
  propertyValue.Assign(NS_ConvertUTF8toUTF16(value));
  return NS_OK;
}
NS_IMETHODIMP FolderInfo::SetProperty(const char* propertyName,
                                      const nsAString& propertyValue) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  return FolderDB().SetFolderProperty(mFolderId,
                                      nsDependentCString(propertyName),
                                      NS_ConvertUTF16toUTF8(propertyValue));
}
nsresult FolderInfo::ReadTransferProperties(
    nsTArray<FolderImportProperty>& properties) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  return FolderDB().GetFolderProperties(mFolderId, properties);
}

nsresult FolderInfo::EncodeTransferInfo(
    const nsTArray<FolderImportProperty>& properties,
    nsIPropertyBag2** transferInfo) {
  NS_ENSURE_ARG_POINTER(transferInfo);
  *transferInfo = nullptr;
  nsresult rv;
  nsCOMPtr<nsIWritablePropertyBag2> bag =
      do_CreateInstance("@mozilla.org/hash-property-bag;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  nsTArray<nsCString> names;
  for (const auto& property : properties) {
    NS_ConvertUTF8toUTF16 name(property.name);
    NS_ENSURE_TRUE(NS_ConvertUTF16toUTF8(name).Equals(property.name),
                   NS_ERROR_FILE_CORRUPTED);
    NS_ENSURE_FALSE(names.Contains(property.name), NS_ERROR_FILE_CORRUPTED);
    names.AppendElement(property.name);
    if (property.integer) {
      MOZ_TRY(bag->SetPropertyAsInt64(name, *property.integer));
    } else {
      MOZ_TRY(bag->SetPropertyAsACString(name, property.text));
    }
  }
  nsCOMPtr<nsIPropertyBag2> result = bag;
  result.forget(transferInfo);
  return NS_OK;
}

nsresult FolderInfo::DecodeTransferInfo(
    nsIPropertyBag2* transferInfo, nsTArray<FolderImportProperty>& properties) {
  NS_ENSURE_ARG(transferInfo);
  nsCOMPtr<nsISimpleEnumerator> enumerator;
  MOZ_TRY(transferInfo->GetEnumerator(getter_AddRefs(enumerator)));
  NS_ENSURE_STATE(enumerator);
  nsTArray<FolderImportProperty> decoded;
  bool more;
  while (true) {
    MOZ_TRY(enumerator->HasMoreElements(&more));
    if (!more) {
      break;
    }
    nsCOMPtr<nsISupports> item;
    MOZ_TRY(enumerator->GetNext(getter_AddRefs(item)));
    nsresult rv;
    nsCOMPtr<nsIProperty> entry = do_QueryInterface(item, &rv);
    NS_ENSURE_SUCCESS(rv, rv);
    nsAutoString name;
    MOZ_TRY(entry->GetName(name));
    FolderImportProperty property;
    CopyUTF16toUTF8(name, property.name);
    NS_ENSURE_TRUE(NS_ConvertUTF8toUTF16(property.name).Equals(name),
                   NS_ERROR_INVALID_ARG);
    for (const auto& previous : decoded) {
      NS_ENSURE_FALSE(previous.name == property.name, NS_ERROR_INVALID_ARG);
    }
    nsCOMPtr<nsIVariant> value;
    MOZ_TRY(entry->GetValue(getter_AddRefs(value)));
    NS_ENSURE_TRUE(value, NS_ERROR_INVALID_ARG);
    switch (value->GetDataType()) {
      case nsIDataType::VTYPE_INT8:
      case nsIDataType::VTYPE_INT16:
      case nsIDataType::VTYPE_INT32:
      case nsIDataType::VTYPE_INT64:
      case nsIDataType::VTYPE_UINT8:
      case nsIDataType::VTYPE_UINT16:
      case nsIDataType::VTYPE_UINT32: {
        int64_t integer;
        MOZ_TRY(value->GetAsInt64(&integer));
        property.integer = Some(integer);
        break;
      }
      case nsIDataType::VTYPE_UINT64: {
        uint64_t integer;
        MOZ_TRY(value->GetAsUint64(&integer));
        CheckedInt<int64_t> checked(integer);
        NS_ENSURE_TRUE(checked.isValid(), NS_ERROR_LOSS_OF_SIGNIFICANT_DATA);
        property.integer = Some(checked.value());
        break;
      }
      case nsIDataType::VTYPE_CSTRING:
        MOZ_TRY(value->GetAsACString(property.text));
        break;
      case nsIDataType::VTYPE_CHAR_STR:
      case nsIDataType::VTYPE_STRING_SIZE_IS: {
        uint32_t length;
        char* bytes = nullptr;
        MOZ_TRY(value->GetAsStringWithSize(&length, &bytes));
        property.text.Assign(bytes, length);
        std::free(bytes);
        break;
      }
      case nsIDataType::VTYPE_UTF8STRING:
        MOZ_TRY(value->GetAsAUTF8String(property.text));
        break;
      case nsIDataType::VTYPE_ASTRING:
      case nsIDataType::VTYPE_WCHAR_STR:
      case nsIDataType::VTYPE_WSTRING_SIZE_IS: {
        nsAutoString text;
        MOZ_TRY(value->GetAsAString(text));
        CopyUTF16toUTF8(text, property.text);
        NS_ENSURE_TRUE(NS_ConvertUTF8toUTF16(property.text).Equals(text),
                       NS_ERROR_INVALID_ARG);
        break;
      }
      default:
        return NS_ERROR_INVALID_ARG;
    }
    decoded.AppendElement(std::move(property));
  }
  properties = std::move(decoded);
  return NS_OK;
}

nsresult FolderInfo::ValidateTransferProperties(
    const nsTArray<FolderImportProperty>& properties) {
  for (const auto& property : properties) {
    const auto& name = property.name;
    // Widths of the retained FolderInfo fields, not unknown property names.
    bool unsigned32 =
        name.EqualsLiteral("highWaterKey") ||
        name.EqualsLiteral("folderDate") || name.EqualsLiteral("UIDValidity") ||
        name.EqualsLiteral("version") || name.EqualsLiteral("userSortOrder") ||
        name.EqualsLiteral("viewType") || name.EqualsLiteral("viewFlags") ||
        name.EqualsLiteral("sortType") || name.EqualsLiteral("sortOrder") ||
        name.EqualsLiteral("totPendingMsgs") ||
        name.EqualsLiteral("unreadPendingMsgs");
    bool count =
        name.EqualsLiteral("numMsgs") || name.EqualsLiteral("numNewMsgs");
    bool flags = name.EqualsLiteral("flags");
    bool signed64 =
        name.EqualsLiteral("folderSize") || name.EqualsLiteral("expungedBytes");
    if (!unsigned32 && !count && !flags && !signed64) {
      continue;
    }
    NS_ENSURE_TRUE(property.integer, NS_ERROR_INVALID_ARG);
    int64_t value = *property.integer;
    if (unsigned32) {
      NS_ENSURE_TRUE(CheckedInt<uint32_t>(value).isValid(),
                     NS_ERROR_LOSS_OF_SIGNIFICANT_DATA);
    } else if (count) {
      NS_ENSURE_TRUE(value >= 0 && CheckedInt<int32_t>(value).isValid(),
                     NS_ERROR_LOSS_OF_SIGNIFICANT_DATA);
    } else if (flags) {
      // The IDL setter also accepts signed32 flag bit patterns.
      NS_ENSURE_TRUE(value >= INT32_MIN && value <= UINT32_MAX,
                     NS_ERROR_LOSS_OF_SIGNIFICANT_DATA);
    }
  }
  return NS_OK;
}

NS_IMETHODIMP FolderInfo::GetTransferInfo(nsIPropertyBag2** transferInfo) {
  NS_ENSURE_ARG_POINTER(transferInfo);
  *transferInfo = nullptr;
  nsTArray<FolderImportProperty> properties;
  MOZ_TRY(ReadTransferProperties(properties));
  auto setInteger = [&](const nsACString& name, int64_t value) {
    for (auto& property : properties) {
      if (property.name == name) {
        property.text.Truncate();
        property.integer = Some(value);
        return;
      }
    }
    properties.AppendElement(
        FolderImportProperty{nsCString(name), ""_ns, Some(value)});
  };
  uint32_t flags = MOZ_TRY(FolderDB().GetFolderFlags(mFolderId));
  setInteger("flags"_ns, flags);
  if (!(flags & nsMsgFolderFlags::Virtual)) {
    int32_t total, unread;
    MOZ_TRY(GetNumMessages(&total));
    MOZ_TRY(GetNumUnreadMessages(&unread));
    setInteger("numMsgs"_ns, total);
    setInteger("numNewMsgs"_ns, unread);
  }
  nsresult rv = ValidateTransferProperties(properties);
  NS_ENSURE_TRUE(rv != NS_ERROR_INVALID_ARG, NS_ERROR_FILE_CORRUPTED);
  NS_ENSURE_SUCCESS(rv, rv);
  // Native bags keep TEXT as ACString and INTEGER as Int64, not hex strings.
  return EncodeTransferInfo(properties, transferInfo);
}
NS_IMETHODIMP FolderInfo::InitFromTransferInfo(nsIPropertyBag2* transferInfo) {
  NS_ENSURE_ARG(transferInfo);
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  nsTArray<FolderImportProperty> properties;
  MOZ_TRY(DecodeTransferInfo(transferInfo, properties));
  for (auto& property : properties) {
    if (property.integer) {
      continue;
    }
    // Exact edits made by rebuildFolderSummary in FolderCommands.mjs.
    if (((property.name.EqualsLiteral("numMsgs") ||
          property.name.EqualsLiteral("numNewMsgs")) &&
         property.text.EqualsLiteral("0")) ||
        (property.name.EqualsLiteral("UIDValidity") &&
         property.text.EqualsLiteral("-1"))) {
      property.integer = Some(int64_t{0});
      property.text.Truncate();
    }
  }
  MOZ_TRY(ValidateTransferProperties(properties));
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  uint32_t previousFlags = MOZ_TRY(FolderDB().GetFolderFlags(mFolderId));
  uint32_t flags = previousFlags;
  Maybe<uint32_t> transferredFlags, epoch;
  for (const auto& property : properties) {
    if (property.name.EqualsLiteral("flags")) {
      transferredFlags = Some(static_cast<uint32_t>(*property.integer));
      flags = *transferredFlags;
    } else if (property.name.EqualsLiteral("UIDValidity")) {
      epoch = Some(static_cast<uint32_t>(*property.integer));
    }
  }
  if (transferredFlags && *transferredFlags != previousFlags) {
    // Core flag caching cannot roll back a caller's transaction.
    bool active;
    MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
    NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  }
  // Replace the epoch through the binding-retirement operation.
  if (epoch) {
    MOZ_TRY(FolderDB().SetFolderUidValidity(mFolderId, *epoch));
  }
  if (transferredFlags) {
    MOZ_TRY(FolderDB().UpdateFlags(mFolderId, *transferredFlags));
  }
  // Earlier writes can persist when a later write fails.
  for (const auto& property : properties) {
    if (property.name.EqualsLiteral("flags") ||
        property.name.EqualsLiteral("UIDValidity")) {
      continue;
    }
    if (!(flags & nsMsgFolderFlags::Virtual) &&
        (property.name.EqualsLiteral("numMsgs") ||
         property.name.EqualsLiteral("numNewMsgs"))) {
      continue;
    }
    if (property.integer) {
      MOZ_TRY(FolderDB().SetFolderProperty(mFolderId, property.name,
                                           *property.integer));
    } else {
      MOZ_TRY(FolderDB().SetFolderProperty(mFolderId, property.name,
                                           property.text));
    }
  }
  return NS_OK;
}
NS_IMETHODIMP FolderInfo::GetLocale(nsAString& aLocale) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP FolderInfo::SetLocale(const nsAString& aLocale) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP FolderInfo::GetMailboxName(nsACString& aMailboxName) {
  nsAutoCString mailboxName;
  MOZ_TRY(GetCharProperty("mailboxName", mailboxName));
  aMailboxName = mailboxName;
  return NS_OK;
}
NS_IMETHODIMP FolderInfo::SetMailboxName(const nsACString& aMailboxName) {
  return SetCharProperty("mailboxName", aMailboxName);
}
NS_IMETHODIMP FolderInfo::GetKnownArtsSet(char** aKnownArtsSet) {
  NS_ENSURE_ARG_POINTER(aKnownArtsSet);
  *aKnownArtsSet = nullptr;
  nsAutoCString value;
  MOZ_TRY(GetCharProperty("knownArts", value));
  *aKnownArtsSet = ToNewCString(value, mozilla::fallible);
  return *aKnownArtsSet ? NS_OK : NS_ERROR_OUT_OF_MEMORY;
}
NS_IMETHODIMP FolderInfo::SetKnownArtsSet(const char* aKnownArtsSet) {
  return SetCharProperty(
      "knownArts", nsDependentCString(aKnownArtsSet ? aKnownArtsSet : ""));
}
NS_IMETHODIMP FolderInfo::GetFolderName(nsACString& aFolderName) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  aFolderName = MOZ_TRY(FolderDB().GetFolderName(mFolderId));
  return NS_OK;
}
NS_IMETHODIMP FolderInfo::SetFolderName(const nsACString& aFolderName) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
  MOZ_TRY(mPerFolderDatabase->CheckDatabaseSource());
  return FolderDB().UpdateName(mFolderId, aFolderName);
}

}  // namespace mozilla::mailnews
