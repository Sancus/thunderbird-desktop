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
#include "mozilla/Logging.h"
#include "mozilla/Preferences.h"
#include "mozilla/RefPtr.h"
#include "mozilla/ResultExtensions.h"
#include "nsComponentManagerUtils.h"
#include "nsIInputStream.h"
#include "nsIMsgDBView.h"
#include "nsIMsgIncomingServer.h"
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
#include "nsReadableUtils.h"
#include "nsServiceManagerUtils.h"

namespace mozilla::mailnews {

extern LazyLogModule gPanoramaLog;

NS_IMPL_ISUPPORTS(PerFolderDatabase, nsIDBChangeAnnouncer, nsIMsgDatabase,
                  nsIMsgOfflineOpsDatabase)

PerFolderDatabase::PerFolderDatabase(uint64_t folderId, bool isNewsFolder)
    : mFolderId(folderId), mIsNewsFolder(isNewsFolder) {
  mDatabaseSourceStatus = CaptureDatabaseSourceId();
  MessageDB().AddMessageListener(this);
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
      data.newFlags = value;
      data.flagOperation |= value;
      return NS_OK;
    });
  }
  NS_IMETHOD GetNewFlags(imapMessageFlagsType* value) override {
    return ReadNumber(&OfflineOperationData::newFlags, value);
  }
  NS_IMETHOD SetNewFlags(imapMessageFlagsType value) override {
    return WriteField(&OfflineOperationData::newFlags, value);
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
    return mDatabase->MessageDB().SetOfflineOperationPlayingBack(
        mDatabase->FolderId(), mKey, value);
  }

 private:
  ~OfflineOperation() = default;
  nsresult Read(OfflineOperationData& data) {
    MOZ_TRY(mDatabase->CheckFolderExists());
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

NS_IMETHODIMP PerFolderDatabase::GetOfflineOpForKey(
    nsMsgKey key, bool create, nsIMsgOfflineImapOperation** result) {
  NS_ENSURE_ARG_POINTER(result);
  *result = nullptr;
  MOZ_TRY(CheckFolderExists());
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
    data.newFlags = static_cast<imapMessageFlagsType>(captured->flags);
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
    rv = message->GetFlags(&flags);
    NS_ENSURE_SUCCESS_VOID(rv);
    // Unread messages join NewList even when legacy notifications are
    // suppressed.
    if (!(flags & nsMsgMessageFlags::Read)) {
      rv = AddToNewList(message->Key());
      NS_ENSURE_SUCCESS_VOID(rv);
    }
    if (!notifyLegacy) {
      return;
    }
    nsMsgKey parent;
    rv = message->GetThreadParent(&parent);
    NS_ENSURE_SUCCESS_VOID(rv);
    // Panorama stores an absent parent as zero.
    NotifyHdrAddedAll(message, parent ? parent : nsMsgKey_None, flags, nullptr);
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
    NotifyHdrDeletedAll(message, nsMsgKey_None, oldFlags, nullptr);
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
    NotifyHdrChangeAll(message, oldFlags, newFlags, nullptr);
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
  if (!(after.flags & nsMsgMessageFlags::Read)) {
    nsresult rv = AddToNewList(after.id);
    NS_ENSURE_SUCCESS_VOID(rv);
  }
  if (notifyLegacy) {
    nsMsgKey parent = after.threadParent ? after.threadParent : nsMsgKey_None;
    NotifyHdrAddedAll(message, parent, after.flags, nullptr);
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
  mNewList.RemoveElement(before.id);
  nsMsgKey parent = before.threadParent ? before.threadParent : nsMsgKey_None;
  NotifyHdrDeletedAll(message, parent, before.flags, nullptr);
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
  if (((before.flags ^ after.flags) & nsMsgMessageFlags::Read) ||
      ((before.flags & nsMsgMessageFlags::New) &&
       !(after.flags & nsMsgMessageFlags::New))) {
    mNewList.RemoveElement(after.id);
  }
  NotifyHdrChangeAll(message, before.flags, after.flags, nullptr);
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
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP PerFolderDatabase::NotifyJunkScoreChanged(
    nsIDBChangeListener* aInstigator) {
  return NS_ERROR_NOT_IMPLEMENTED;
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
  // Invalidate this wrapper's weak cache entries before a listener reopens it.
  DetachWeakPtr();
  if (DatabaseCore::sInstance && DatabaseCore::sInstance->mMessageDatabase) {
    MessageDB().RemoveMessageListener(this);
  }
  return NotifyAnnouncerGoingAway();
}
NS_IMETHODIMP PerFolderDatabase::ClearCachedHdrs() {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP PerFolderDatabase::ResetHdrCacheSize(uint32_t size) {
  return NS_ERROR_NOT_IMPLEMENTED;
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
NS_IMETHODIMP PerFolderDatabase::GetMsgHdrForKey(nsMsgKey key,
                                                 nsIMsgDBHdr** msgHdr) {
  NS_ENSURE_ARG_POINTER(msgHdr);
  *msgHdr = nullptr;
  MOZ_TRY(CheckFolderExists());
  bool exists;
  MOZ_TRY(MessageDB().MessageExists(key, exists));
  NS_ENSURE_TRUE(exists, NS_ERROR_ILLEGAL_VALUE);

  RefPtr<Message> message;
  MOZ_TRY(MessageDB().GetMessage(key, getter_AddRefs(message)));
  {
    // Sanity check.
    CapturedMessage current;
    MOZ_TRY(MessageDB().CaptureMessage(key, current));
    if (current.folderId != mFolderId) {
      NS_WARNING("GetMsgHdrForKey() returned message not in folder");
      return NS_ERROR_ILLEGAL_VALUE;
    }
  }

  NS_IF_ADDREF(*msgHdr = message);
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::GetMsgHdrForMessageID(const char* messageID,
                                                       nsIMsgDBHdr** msgHdr) {
  NS_ENSURE_ARG_POINTER(msgHdr);
  *msgHdr = nullptr;
  NS_ENSURE_ARG_POINTER(messageID);
  MOZ_TRY(CheckFolderExists());

  RefPtr<Message> message;
  nsresult rv = MessageDB().GetMessageForMessageID(
      mFolderId, nsDependentCString(messageID), getter_AddRefs(message));
  if (rv == NS_ERROR_UNEXPECTED) {
    return NS_ERROR_ILLEGAL_VALUE;
  }
  NS_ENSURE_SUCCESS(rv, rv);
  NS_IF_ADDREF(*msgHdr = message);
  return NS_OK;
}
nsresult PerFolderDatabase::GetMsgHdrForProperty(const nsACString& name,
                                                 const nsACString& value,
                                                 nsIMsgDBHdr** result) {
  NS_ENSURE_ARG_POINTER(result);
  *result = nullptr;
  MOZ_TRY(CheckFolderExists());
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

  nsresult rv = MessageDB().MessageExists(key, *contains);
  NS_ENSURE_SUCCESS(rv, rv);
  if (!*contains) {
    return NS_OK;
  }

  // Sanity check.
  uint64_t msgFolderId;
  rv = MessageDB().GetMessageFolderId(key, msgFolderId);
  NS_ENSURE_SUCCESS(rv, rv);
  if (msgFolderId != mFolderId) {
    *contains = false;
  }
  return NS_OK;
}

NS_IMETHODIMP PerFolderDatabase::CreateNewHdr(nsIMsgDBHdr** aRetVal) {
  NS_ENSURE_ARG_POINTER(aRetVal);
  RefPtr<DetachedMsgHdr> hdr = new DetachedMsgHdr(mFolderId);
  hdr.forget(aRetVal);
  return NS_OK;
}

NS_IMETHODIMP PerFolderDatabase::CreateNewHdrWithSpecificMsgKey(
    nsMsgKey aKey, nsIMsgDBHdr** aRetVal) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP PerFolderDatabase::AddNewHdrToDB(nsIMsgDBHdr* newHdr,
                                               bool notify) {
  NS_ERROR("AddNewHdrToDB() not supported");
  return NS_ERROR_NOT_IMPLEMENTED;
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
  // The parser uses the native CreateNewHdr implementation, as in AttachHdr.
  RefPtr<DetachedMsgHdr> draft = static_cast<DetachedMsgHdr*>(parsed);
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

  // CreateNewHdr supplies the native detached implementation.
  RefPtr<DetachedMsgHdr> draft = static_cast<DetachedMsgHdr*>(detachedHdr);
  if (draft->mFolderId != mFolderId) {
    return NS_ERROR_INVALID_ARG;
  }
  if (draft->mAttachState == DetachedMsgHdr::AttachState::Attached) {
    nsCOMPtr<nsIMsgDBHdr> live = draft->mAttachedHeader;
    live.forget(realHdr);
    return NS_OK;
  }
  MOZ_TRY(draft->CheckMutable());
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

NS_IMETHODIMP PerFolderDatabase::CopyHdrFromExistingHdr(
    nsMsgKey key, nsIMsgDBHdr* existingHdr, bool addHdrToDB,
    nsIMsgDBHdr** aRetVal) {
  NS_ENSURE_ARG_POINTER(aRetVal);
  *aRetVal = nullptr;
  NS_ENSURE_ARG(existingHdr);
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
    // The public getter filters self/empty tokens and has a uint16 limit.
    MOZ_TRY(MessageDB().GetMessageReferences(sourceKey, raw.references));
  } else {
    // Like AttachHdr, this accepts the native CreateNewHdr implementation.
    auto* source = static_cast<DetachedMsgHdr*>(existingHdr);
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
  if (addHdrToDB) {
    return AttachHdr(draft, true, aRetVal);
  }
  draft.forget(aRetVal);
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
  mNewList.RemoveElement(aKey);
  return MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::New, false);
}
NS_IMETHODIMP PerFolderDatabase::MarkMDNNeeded(
    nsMsgKey aKey, bool aNeeded, nsIDBChangeListener* aInstigator) {
  return MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::MDNReportNeeded,
                                    aNeeded);
}
NS_IMETHODIMP PerFolderDatabase::MarkMDNSent(nsMsgKey aKey, bool aSent,
                                             nsIDBChangeListener* aInstigator) {
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
  return MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::Marked, aMarked);
}
NS_IMETHODIMP PerFolderDatabase::MarkReplied(nsMsgKey aKey, bool aReplied,
                                             nsIDBChangeListener* aInstigator) {
  return MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::Replied, aReplied);
}
NS_IMETHODIMP PerFolderDatabase::MarkForwarded(
    nsMsgKey aKey, bool aForwarded, nsIDBChangeListener* aInstigator) {
  return MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::Forwarded,
                                    aForwarded);
}
NS_IMETHODIMP PerFolderDatabase::MarkRedirected(
    nsMsgKey aKey, bool aRedirected, nsIDBChangeListener* aInstigator) {
  return MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::Redirected,
                                    aRedirected);
}
NS_IMETHODIMP PerFolderDatabase::MarkHasAttachments(
    nsMsgKey aKey, bool aHasAttachments, nsIDBChangeListener* aInstigator) {
  return MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::Attachment,
                                    aHasAttachments);
}
NS_IMETHODIMP PerFolderDatabase::MarkOffline(nsMsgKey aKey, bool aOffline,
                                             nsIDBChangeListener* instigator) {
  return MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::Offline, aOffline);
}
NS_IMETHODIMP PerFolderDatabase::MarkImapDeleted(
    nsMsgKey aKey, bool aDeleted, nsIDBChangeListener* instigator) {
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
  return NotifyHdrChangeAll(header, oldFlags | current.flags,
                            flags | current.flags, instigator);
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
  return MessageDB().GetMessageFlag(aKey, nsMsgMessageFlags::Marked, *aMarked);
}
NS_IMETHODIMP PerFolderDatabase::HasAttachments(nsMsgKey aKey,
                                                bool* aAttachments) {
  return MessageDB().GetMessageFlag(aKey, nsMsgMessageFlags::Attachment,
                                    *aAttachments);
}
NS_IMETHODIMP PerFolderDatabase::IsMDNSent(nsMsgKey aKey, bool* aMDNSent) {
  return MessageDB().GetMessageFlag(aKey, nsMsgMessageFlags::MDNReportSent,
                                    *aMDNSent);
}
NS_IMETHODIMP PerFolderDatabase::MarkAllRead(nsTArray<nsMsgKey>& aMarkedKeys) {
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
  NS_ENSURE_SUCCESS(mDatabaseSourceStatus, mDatabaseSourceStatus);
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

NS_IMETHODIMP PerFolderDatabase::UndoDelete(nsIMsgDBHdr* msgHdr) {
  return NS_ERROR_NOT_IMPLEMENTED;
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
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP PerFolderDatabase::SetMsgRetentionSettings(
    nsIMsgRetentionSettings* aMsgRetentionSettings) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP PerFolderDatabase::ApplyRetentionSettings(
    nsIMsgRetentionSettings* aMsgRetentionSettings, bool aDeleteViaFolder) {
  return NS_ERROR_NOT_IMPLEMENTED;
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
  mNewList.Clear();
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::AddToNewList(nsMsgKey aKey) {
  if (!mNewList.Contains(aKey)) {
    mNewList.AppendElement(aKey);
  }
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::GetSummaryValid(bool* summaryValid) {
  NS_ENSURE_ARG_POINTER(summaryValid);
  *summaryValid = true;
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::SetSummaryValid(bool aSummaryValid) {
  // Sure. Okay. Whatever.
  return NS_OK;
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
NS_IMETHODIMP PerFolderDatabase::SetAttributeOnPendingHdr(
    nsIMsgDBHdr* pendingHdr, const char* property, const char* propertyVal) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP PerFolderDatabase::SetUint32AttributeOnPendingHdr(
    nsIMsgDBHdr* pendingHdr, const char* property, uint32_t propertyVal) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP PerFolderDatabase::SetUint64AttributeOnPendingHdr(
    nsIMsgDBHdr* aPendingHdr, const char* aProperty, uint64_t aPropertyVal) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP PerFolderDatabase::UpdatePendingAttributes(nsIMsgDBHdr* aNewHdr) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP PerFolderDatabase::GetNextPseudoMsgKey(
    nsMsgKey* aNextPseudoMsgKey) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP PerFolderDatabase::SetNextPseudoMsgKey(
    nsMsgKey aNextPseudoMsgKey) {
  return NS_ERROR_NOT_IMPLEMENTED;
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
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP PerFolderDatabase::SetMsgHdrCacheSize(uint32_t aMsgHdrCacheSize) {
  return NS_ERROR_NOT_IMPLEMENTED;
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

MessageEnumerator::MessageEnumerator(PerFolderDatabase* owner,
                                     mozIStorageStatement* stmt)
    : mOwner(owner), mGeneration(owner->mEnumeratorGeneration), mStmt(stmt) {
  Advance();
}

bool MessageEnumerator::CheckOwner() {
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

void MessageEnumerator::Advance() {
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

NS_IMETHODIMP MessageEnumerator::GetNext(nsIMsgDBHdr** item) {
  NS_ENSURE_ARG_POINTER(item);
  *item = nullptr;
  bool current = CheckOwner();
  MOZ_TRY(mStatus);
  NS_ENSURE_TRUE(current && mHasNext, NS_ERROR_FAILURE);
  nsMsgKey key = static_cast<nsMsgKey>(mStmt->AsInt64(0));
  RefPtr<Message> message = new Message(key);
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
  *aFlags = MOZ_TRY(FolderDB().GetFolderFlags(mFolderId));
  return NS_OK;
}

NS_IMETHODIMP FolderInfo::SetFlags(int32_t aFlags) {
  return FolderDB().UpdateFlags(mFolderId, aFlags);
}

NS_IMETHODIMP FolderInfo::OrFlags(int32_t aFlags, int32_t* aOutFlags) {
  NS_ENSURE_ARG_POINTER(aOutFlags);
  uint32_t flags = MOZ_TRY(FolderDB().GetFolderFlags(mFolderId));
  flags |= aFlags;
  MOZ_TRY(FolderDB().UpdateFlags(mFolderId, flags));
  *aOutFlags = flags;
  return NS_OK;
}

NS_IMETHODIMP FolderInfo::AndFlags(int32_t aFlags, int32_t* aOutFlags) {
  NS_ENSURE_ARG_POINTER(aOutFlags);
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
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP FolderInfo::SetFolderSize(int64_t aFolderSize) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP FolderInfo::GetFolderDate(uint32_t* aFolderDate) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP FolderInfo::SetFolderDate(uint32_t aFolderDate) {
  return NS_ERROR_NOT_IMPLEMENTED;
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
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP FolderInfo::SetUserSortOrder(uint32_t userSortOrder) {
  return NS_ERROR_NOT_IMPLEMENTED;
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
  return FolderDB().GetFolderProperty(
      mFolderId, nsDependentCString(propertyName), propertyValue);
}
NS_IMETHODIMP FolderInfo::SetCharProperty(const char* propertyName,
                                          const nsACString& propertyValue) {
  return FolderDB().SetFolderProperty(
      mFolderId, nsDependentCString(propertyName), propertyValue);
}
NS_IMETHODIMP FolderInfo::GetUint32Property(const char* propertyName,
                                            uint32_t defaultValue,
                                            uint32_t* propertyValue) {
  NS_ENSURE_ARG_POINTER(propertyValue);
  *propertyValue = defaultValue;
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
  return FolderDB().SetFolderProperty(
      mFolderId, nsDependentCString(propertyName), (int64_t)propertyValue);
}
NS_IMETHODIMP FolderInfo::GetInt64Property(const char* propertyName,
                                           int64_t defaultValue,
                                           int64_t* propertyValue) {
  NS_ENSURE_ARG_POINTER(propertyValue);
  *propertyValue = defaultValue;
  return FolderDB().GetFolderProperty(
      mFolderId, nsDependentCString(propertyName), propertyValue);
}
NS_IMETHODIMP FolderInfo::SetInt64Property(const char* propertyName,
                                           int64_t propertyValue) {
  return FolderDB().SetFolderProperty(
      mFolderId, nsDependentCString(propertyName), propertyValue);
}
NS_IMETHODIMP FolderInfo::GetBooleanProperty(const char* propertyName,
                                             bool defaultValue,
                                             bool* propertyValue) {
  NS_ENSURE_ARG_POINTER(propertyValue);
  *propertyValue = defaultValue;
  int64_t value = defaultValue;
  MOZ_TRY(FolderDB().GetFolderProperty(
      mFolderId, nsDependentCString(propertyName), &value));
  *propertyValue = value != 0;
  return NS_OK;
}
NS_IMETHODIMP FolderInfo::SetBooleanProperty(const char* propertyName,
                                             bool propertyValue) {
  return FolderDB().SetFolderProperty(
      mFolderId, nsDependentCString(propertyName), (int64_t)propertyValue);
}
NS_IMETHODIMP FolderInfo::GetProperty(const char* propertyName,
                                      nsAString& propertyValue) {
  nsAutoCString value;
  nsresult rv = FolderDB().GetFolderProperty(
      mFolderId, nsDependentCString(propertyName), value);
  NS_ENSURE_SUCCESS(rv, rv);
  propertyValue.Assign(NS_ConvertUTF8toUTF16(value));
  return NS_OK;
}
NS_IMETHODIMP FolderInfo::SetProperty(const char* propertyName,
                                      const nsAString& propertyValue) {
  return FolderDB().SetFolderProperty(mFolderId,
                                      nsDependentCString(propertyName),
                                      NS_ConvertUTF16toUTF8(propertyValue));
}
nsresult FolderInfo::ReadTransferProperties(
    nsTArray<FolderImportProperty>& properties) {
  MOZ_TRY(mPerFolderDatabase->CheckFolderExists());
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
  aFolderName = MOZ_TRY(FolderDB().GetFolderName(mFolderId));
  return NS_OK;
}
NS_IMETHODIMP FolderInfo::SetFolderName(const nsACString& aFolderName) {
  return FolderDB().UpdateName(mFolderId, aFolderName);
}

}  // namespace mozilla::mailnews
