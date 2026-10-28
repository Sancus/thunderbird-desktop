/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "PerFolderDatabase.h"

#include <algorithm>
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
#include "mozilla/CheckedInt.h"
#include "mozilla/Logging.h"
#include "mozilla/Preferences.h"
#include "mozilla/RefPtr.h"
#include "nsComponentManagerUtils.h"
#include "nsIInputStream.h"
#include "nsIMsgDBView.h"
#include "nsIMsgPluggableStore.h"
#include "nsIMsgSearchSession.h"
#include "nsMsgMessageFlags.h"
#include "nsMsgSearchCore.h"
#include "nsMsgUtils.h"
#include "nsReadableUtils.h"
#include "nsServiceManagerUtils.h"

namespace mozilla::mailnews {

extern LazyLogModule gPanoramaLog;

NS_IMPL_ISUPPORTS(PerFolderDatabase, nsIDBChangeAnnouncer, nsIMsgDatabase)

// MessageListener:

void PerFolderDatabase::OnMessageAdded(Message* message) {
  OnMessagePublished(message, true);
}

void PerFolderDatabase::OnMessagePublished(Message* message,
                                           bool notifyLegacy) {
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

void PerFolderDatabase::OnMessageRemoved(Message* message, uint32_t oldFlags) {
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

// nsIDBChangeAnnouncer:

NS_IMETHODIMP PerFolderDatabase::AddListener(nsIDBChangeListener* listener) {
  NS_ENSURE_ARG(listener);
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
  return NS_ERROR_NOT_IMPLEMENTED;
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
  return NS_ERROR_NOT_IMPLEMENTED;
}

// nsIMsgDatabase:

NS_IMETHODIMP PerFolderDatabase::OpenFromFile(nsIFile* aFolderName) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP PerFolderDatabase::Close(bool aForceCommit) { return NS_OK; }
NS_IMETHODIMP PerFolderDatabase::Commit(nsMsgDBCommit aCommitType) {
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::ForceClosed() { return NS_OK; }
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
nsresult
PerFolderDatabase::CheckFolderExists() const
{
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
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP PerFolderDatabase::SetLastUseTime(PRTime aLastUseTime) {
  return NS_ERROR_NOT_IMPLEMENTED;
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
    uint64_t msgFolderId;
    MOZ_TRY(MessageDB().GetMessageFolderId(key, msgFolderId));
    if (msgFolderId != mFolderId) {
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
nsresult
PerFolderDatabase::GetMsgHdrForProperty(const nsACString& name,
                                        const nsACString& value,
                                        nsIMsgDBHdr** result)
{
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
  return GetMsgHdrForProperty(
    "X-GM-MSGID"_ns, nsDependentCString(aGmailMessageID), aRetVal);
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

  stmtClone->BindInt64ByName("folderId"_ns, mFolderId);

  RefPtr<MessageEnumerator> enumerator = new MessageEnumerator(stmtClone);
  enumerator.forget(aEnumerator);
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::ReverseEnumerateMessages(
    nsIMsgEnumerator** aEnumerator) {
  NS_ENSURE_ARG_POINTER(aEnumerator);
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

  stmtClone->BindInt64ByName("folderId"_ns, mFolderId);

  RefPtr<MessageEnumerator> enumerator = new MessageEnumerator(stmtClone);
  enumerator.forget(aEnumerator);
  return NS_OK;
}
NS_IMETHODIMP PerFolderDatabase::EnumerateThreads(
    nsIMsgThreadEnumerator** aEnumerator) {
  NS_ENSURE_ARG_POINTER(aEnumerator);
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "GetMessageThreads"_ns,
      "SELECT threadId, MAX(date) AS maxDate FROM messages WHERE folderId = :folderId GROUP BY threadId"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<mozIStorageStatement> stmtClone;
  rv = stmt->Clone(getter_AddRefs(stmtClone));
  NS_ENSURE_SUCCESS(rv, rv);

  stmtClone->BindInt64ByName("folderId"_ns, mFolderId);

  RefPtr<ThreadEnumerator> enumerator =
      new ThreadEnumerator(stmtClone, mFolderId);
  enumerator.forget(aEnumerator);
  return NS_OK;
}

namespace {

class FilterEnumerator final : public nsBaseMsgEnumerator {
 public:
  FilterEnumerator(nsIMsgDatabase* db, nsIMsgSearchSession* session,
                   nsTArray<nsMsgKey>&& keys)
      : mDatabase(db), mSession(session), mKeys(std::move(keys)) {}

  NS_IMETHOD HasMoreElements(bool* result) override {
    NS_ENSURE_ARG_POINTER(result);
    *result = false;
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
      MOZ_TRY(mSession->MatchHdr(header, mDatabase, &matches));
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
  nsCOMPtr<nsIMsgDatabase> mDatabase;
  nsCOMPtr<nsIMsgSearchSession> mSession;
  nsTArray<nsMsgKey> mKeys;
  size_t mIndex = 0;
  nsCOMPtr<nsIMsgDBHdr> mNext;
};

}  // namespace

NS_IMETHODIMP PerFolderDatabase::GetFilterEnumerator(
    const nsTArray<RefPtr<nsIMsgSearchTerm>>& searchTerms, bool reverse,
    nsIMsgEnumerator** aRetVal) {
  NS_ENSURE_ARG_POINTER(aRetVal);
  *aRetVal = nullptr;
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
NS_IMETHODIMP PerFolderDatabase::SyncCounts() {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP PerFolderDatabase::GetThreadContainingMsgHdr(
    nsIMsgDBHdr* msgHdr, nsIMsgThread** thread) {
  NS_ENSURE_ARG(msgHdr);
  NS_ENSURE_ARG_POINTER(thread);

  nsMsgKey key;
  nsresult rv = msgHdr->GetMessageKey(&key);
  NS_ENSURE_SUCCESS(rv, rv);

  nsMsgKey threadId;
  rv = MessageDB().GetMessageThreadId(key, threadId);
  NS_ENSURE_SUCCESS(rv, rv);

  NS_ADDREF(*thread = new Thread(mFolderId, threadId));
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
NS_IMETHODIMP PerFolderDatabase::MarkThreadIgnored(
    nsIMsgThread* thread, nsMsgKey threadKey, bool bIgnored,
    nsIDBChangeListener* aInstigator) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP PerFolderDatabase::MarkThreadWatched(
    nsIMsgThread* thread, nsMsgKey threadKey, bool bWatched,
    nsIDBChangeListener* aInstigator) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP PerFolderDatabase::MarkKilled(nsMsgKey aKey, bool aIgnored,
                                            nsIDBChangeListener* aInstigator) {
  return MessageDB().SetMessageFlag(aKey, nsMsgMessageFlags::Ignored, aIgnored);
}
NS_IMETHODIMP PerFolderDatabase::IsRead(nsMsgKey aKey, bool* aRead) {
  return MessageDB().GetMessageFlag(aKey, nsMsgMessageFlags::Read, *aRead);
}
NS_IMETHODIMP PerFolderDatabase::IsIgnored(nsMsgKey aKey, bool* aIgnored) {
  return MessageDB().GetMessageFlag(aKey, nsMsgMessageFlags::Ignored,
                                    *aIgnored);
}
NS_IMETHODIMP PerFolderDatabase::IsWatched(nsMsgKey aKey, bool* aWatched) {
  return MessageDB().GetMessageFlag(aKey, nsMsgMessageFlags::Watched,
                                    *aWatched);
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
  for (nsMsgKey key : nsMsgKeys) {
    nsresult rv = MessageDB().RemoveMessage(key);
    NS_ENSURE_SUCCESS(rv, rv);
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
NS_IMETHODIMP PerFolderDatabase::GetNextFakeOfflineMsgKey(
    nsMsgKey* aNextFakeOfflineMsgKey) {
  return NS_ERROR_NOT_IMPLEMENTED;
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
  uint64_t folderId = MOZ_TRY(FolderURIToId(aSearchFolderUri));

  // We don't need a `mozStorageStatementScoper` (in fact we can't use one here)
  // because we'll hand the statement over to the `MessageEnumerator`, which
  // takes care of resetting it when relevant.
  nsCOMPtr<mozIStorageStatement> stmt =
      MOZ_TRY(SearchFolderHitsCache::SelectAllForFolderStmt(folderId));

  // `MessageEnumerator` works as long as the statement provides IDs that map to
  // the `messages` table, so although we're not reading directly from that
  // table it still works here.
  RefPtr<MessageEnumerator> enumerator = new MessageEnumerator(stmt);

  // Consumers expect us to return a null pointer rather than an empty
  // enumerator if we don't have any hits, because in a Mork world the lack of
  // hits shows by the absence of the relevant table in the folder's database.
  // This is not really a thing in the Panorama world but we need to preserve
  // this behaviour for compatibility.
  bool hasMessages;
  enumerator->HasMoreElements(&hasMessages);
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

MessageEnumerator::MessageEnumerator(mozIStorageStatement* aStmt)
    : mStmt(aStmt) {
  mStmt->ExecuteStep(&mHasNext);

  if (!mHasNext) {
    // The statement didn't yield any result, so let's reset it right away.
    // Ideally we'd reset in the destructor, but this enumerator might be used
    // in JS in which case we can't always ensure the destructor is called at
    // the right time.
    mStmt->Reset();
  }
}

NS_IMETHODIMP MessageEnumerator::GetNext(nsIMsgDBHdr** aItem) {
  NS_ENSURE_ARG_POINTER(aItem);
  *aItem = nullptr;

  if (!mHasNext) {
    return NS_ERROR_FAILURE;
  }

  nsMsgKey key = (nsMsgKey)mStmt->AsInt64(0);
  RefPtr<Message> message = new Message(key);
  message.forget(aItem);
  mStmt->ExecuteStep(&mHasNext);

  if (!mHasNext) {
    // We won't be using the statement anymore, so let's reset it. Ideally we'd
    // reset in the destructor, but this enumerator might be used in JS in which
    // case we can't always ensure the destructor is called at the right time.
    mStmt->Reset();
  }

  return NS_OK;
}

NS_IMETHODIMP MessageEnumerator::HasMoreElements(bool* aHasNext) {
  NS_ENSURE_ARG_POINTER(aHasNext);

  *aHasNext = mHasNext;
  return NS_OK;
}

ThreadEnumerator::ThreadEnumerator(mozIStorageStatement* stmt,
                                   uint64_t folderId)
    : mStmt(stmt), mFolderId(folderId) {
  mStmt->ExecuteStep(&mHasNext);

  if (!mHasNext) {
    // The statement didn't yield any result, so let's reset it right away.
    // Ideally we'd reset in the destructor, but this enumerator might be used
    // in JS in which case we can't always ensure the destructor is called at
    // the right time.
    mStmt->Reset();
  }
}

NS_IMETHODIMP ThreadEnumerator::GetNext(nsIMsgThread** item) {
  NS_ENSURE_ARG_POINTER(item);
  *item = nullptr;

  if (!mHasNext) {
    return NS_ERROR_FAILURE;
  }

  uint64_t threadId = mStmt->AsInt64(0);
  uint64_t maxDate = mStmt->AsDouble(1);

  RefPtr<Thread> thread = new Thread(mFolderId, threadId, maxDate);
  thread.forget(item);
  mStmt->ExecuteStep(&mHasNext);

  if (!mHasNext) {
    // We won't be using the statement anymore, so let's reset it. Ideally we'd
    // reset in the destructor, but this enumerator might be used in JS in which
    // case we can't always ensure the destructor is called at the right time.
    mStmt->Reset();
  }

  return NS_OK;
}

NS_IMETHODIMP ThreadEnumerator::HasMoreElements(bool* hasNext) {
  NS_ENSURE_ARG_POINTER(hasNext);

  *hasNext = mHasNext;
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
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP FolderInfo::SetHighWater(nsMsgKey aHighWater) {
  return NS_ERROR_NOT_IMPLEMENTED;
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
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP FolderInfo::ChangeNumMessages(int32_t aDelta) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP FolderInfo::GetNumUnreadMessages(int32_t* aNumUnreadMessages) {
  NS_ENSURE_ARG_POINTER(aNumUnreadMessages);
  uint64_t out;
  nsresult rv = MessageDB().GetNumUnread(mFolderId, &out);
  *aNumUnreadMessages = (int32_t)out;
  return rv;
}
NS_IMETHODIMP FolderInfo::SetNumUnreadMessages(int32_t aNumUnreadMessages) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP FolderInfo::GetNumMessages(int32_t* aNumMessages) {
  NS_ENSURE_ARG_POINTER(aNumMessages);
  uint64_t out;
  nsresult rv = MessageDB().GetNumMessages(mFolderId, &out);
  *aNumMessages = (int32_t)out;
  return rv;
}
NS_IMETHODIMP FolderInfo::SetNumMessages(int32_t aNumMessages) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP FolderInfo::GetExpungedBytes(int64_t* aExpungedBytes) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP FolderInfo::SetExpungedBytes(int64_t aExpungedBytes) {
  return NS_ERROR_NOT_IMPLEMENTED;
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
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP FolderInfo::SetImapTotalPendingMessages(
    int32_t aImapTotalPendingMessages) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP FolderInfo::GetImapUnreadPendingMessages(
    int32_t* aImapUnreadPendingMessages) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP FolderInfo::SetImapUnreadPendingMessages(
    int32_t aImapUnreadPendingMessages) {
  return NS_ERROR_NOT_IMPLEMENTED;
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
  return NS_ERROR_NOT_IMPLEMENTED;
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
NS_IMETHODIMP FolderInfo::GetTransferInfo(nsIPropertyBag2** _retval) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP FolderInfo::InitFromTransferInfo(nsIPropertyBag2* transferInfo) {
  return NS_ERROR_NOT_IMPLEMENTED;
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
