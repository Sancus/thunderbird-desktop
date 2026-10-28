/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "MessageDatabase.h"

#include <cstdint>
#include <utility>

#include "DatabaseCore.h"
#include "DatabaseUtils.h"
#include "DetachedMsgHdr.h"
#include "Message.h"
#include "mozilla/Logging.h"
#include "mozilla/ResultExtensions.h"
#include "mozilla/Try.h"
#include "mozilla/fallible.h"
#include "mozIStorageConnection.h"
#include "mozIStorageStatement.h"
#include "mozStorageHelper.h"
#include "nsIMsgDatabase.h"
#include "nsMsgMessageFlags.h"
#include "nsMsgUtils.h"

using mozilla::LazyLogModule;
using mozilla::LogLevel;

namespace mozilla::mailnews {

extern LazyLogModule gPanoramaLog;  // Defined by DatabaseCore.

NS_IMPL_ISUPPORTS(MessageDatabase, nsIMessageDatabase)

void MessageDatabase::Startup() {
  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("MessageDatabase starting up"));
  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("MessageDatabase startup complete"));
}

void MessageDatabase::Shutdown() {
  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("MessageDatabase shutting down"));
  mMessageListeners.Clear();
  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("MessageDatabase shutdown complete"));
}

NS_IMETHODIMP
MessageDatabase::GetTotalCount(uint64_t* aTotalCount) {
  NS_ENSURE_ARG_POINTER(aTotalCount);
  *aTotalCount = 0;
  nsCOMPtr<mozIStorageStatement> stmt;

  nsresult rv = DatabaseCore::GetStatement("TotalCount"_ns,
                                           "SELECT COUNT(*) FROM messages"_ns,
                                           getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);

  bool hasResult;
  rv = stmt->ExecuteStep(&hasResult);
  NS_ENSURE_SUCCESS(rv, rv);
  if (hasResult) {
    *aTotalCount = stmt->AsInt64(0);
  }

  return rv;
}

NS_IMETHODIMP MessageDatabase::AddMessage(
    uint64_t aFolderId, const nsACString& aMessageId,
    nsTArray<nsCString> const& aReferences, PRTime aDate,
    const nsACString& aSender, const nsACString& aRecipients,
    const nsACString& aCcList, const nsACString& aBccList,
    const nsACString& aSubject, uint32_t aFlags, const nsACString& aTags,
    nsMsgPriorityValue aPriority, nsMsgKey* aKey) {
  NS_ENSURE_ARG_POINTER(aKey);
  RawHdr header;
  header.messageId = aMessageId;
  header.references = aReferences.Clone();
  header.date = aDate;
  header.sender = aSender;
  header.recipients = aRecipients;
  header.ccList = aCcList;
  header.bccList = aBccList;
  header.subject = aSubject;
  header.flags = aFlags;
  header.keywords = aTags;
  header.priority = aPriority;
  return AddMessage(aFolderId, header, true, aKey);
}

nsresult MessageDatabase::AddMessage(uint64_t aFolderId, const ::RawHdr& header,
                                     bool notifyLegacy, nsMsgKey* aKey,
                                     Message** liveHeader) {
  NS_ENSURE_ARG_POINTER(aKey);
  MOZ_TRY(DatabaseCore::EnsureConnection());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool inTransaction;
  MOZ_TRY(connection->GetTransactionInProgress(&inTransaction));
  if (inTransaction) {
    return NS_ERROR_IN_PROGRESS;
  }

  // This still assumes that referenced parents are already in the database.
  nsMsgKey threadId = 0;
  nsMsgKey parentId = 0;
  if (!header.references.IsEmpty()) {
    threadId = MOZ_TRY(FindByMessageId(header.references[0]));
    parentId = MOZ_TRY(FindByMessageId(header.references.LastElement()));
  }

  CachedMsg cached;
  RefPtr<Message> message;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    {
      nsCString messageId = MOZ_TRY(DatabaseUtils::Normalize(header.messageId));
      nsCString sender = MOZ_TRY(DatabaseUtils::Normalize(header.sender));
      nsCString recipients =
          MOZ_TRY(DatabaseUtils::Normalize(header.recipients));
      nsCString ccList = MOZ_TRY(DatabaseUtils::Normalize(header.ccList));
      nsCString bccList = MOZ_TRY(DatabaseUtils::Normalize(header.bccList));
      nsCString subject = MOZ_TRY(DatabaseUtils::Normalize(header.subject));
      nsCString tags = MOZ_TRY(DatabaseUtils::Normalize(header.keywords));
      for (const auto& extra : header.extras) {
        if (extra.k.EqualsLiteral("keywords")) {
          tags = extra.v;
        }
      }
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement("AddNativeMessage"_ns,
                                         "INSERT INTO messages ( \
             folderId, threadId, threadParent, messageId, date, sender, recipients, ccList, bccList, subject, flags, tags, priority \
           ) VALUES ( \
             :folderId, :threadId, :threadParent, :messageId, :date, :sender, :recipients, :ccList, :bccList, :subject, :flags, :tags, :priority \
           ) RETURNING "_ns MESSAGE_SQL_FIELDS,
                                         getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);

      MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, aFolderId));
      MOZ_TRY(stmt->BindInt32ByName("threadId"_ns, threadId));
      MOZ_TRY(stmt->BindInt32ByName("threadParent"_ns, parentId));
      MOZ_TRY(stmt->BindUTF8StringByName("messageId"_ns, messageId));
      MOZ_TRY(stmt->BindInt64ByName("date"_ns, header.date));
      MOZ_TRY(stmt->BindUTF8StringByName("sender"_ns, sender));
      MOZ_TRY(stmt->BindUTF8StringByName("recipients"_ns, recipients));
      MOZ_TRY(stmt->BindUTF8StringByName("ccList"_ns, ccList));
      MOZ_TRY(stmt->BindUTF8StringByName("bccList"_ns, bccList));
      MOZ_TRY(stmt->BindUTF8StringByName("subject"_ns, subject));
      MOZ_TRY(stmt->BindInt32ByName("flags"_ns, header.flags));
      MOZ_TRY(stmt->BindUTF8StringByName("tags"_ns, tags));
      MOZ_TRY(stmt->BindInt32ByName("priority"_ns, header.priority));

      bool hasResult;
      MOZ_TRY(stmt->ExecuteStep(&hasResult));
      if (!hasResult) {
        return NS_ERROR_UNEXPECTED;
      }
      uint32_t len;
      cached.key = (nsMsgKey)stmt->AsInt64(0);
      cached.folderId = stmt->AsInt64(1);
      cached.threadId = (nsMsgKey)stmt->AsInt64(2);
      cached.threadParent = (nsMsgKey)stmt->AsInt64(3);
      cached.messageId = stmt->AsSharedUTF8String(4, &len);
      cached.date = (PRTime)stmt->AsInt64(5);
      cached.sender = stmt->AsSharedUTF8String(6, &len);
      cached.recipients = stmt->AsSharedUTF8String(7, &len);
      cached.ccList = stmt->AsSharedUTF8String(8, &len);
      cached.bccList = stmt->AsSharedUTF8String(9, &len);
      cached.subject = stmt->AsSharedUTF8String(10, &len);
      cached.flags = (uint32_t)stmt->AsInt64(11);
      cached.tags = stmt->AsSharedUTF8String(12, &len);
      cached.priority = (nsMsgPriorityValue)stmt->AsInt32(13);
      MOZ_TRY(stmt->ExecuteStep(&hasResult));
      if (hasResult) {
        return NS_ERROR_UNEXPECTED;
      }
    }

    // The root's key was unavailable until the insert completed.
    if (cached.threadId == 0) {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "SetThreadIdToId"_ns,
          "UPDATE messages SET threadId = id WHERE id = :id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, cached.key));
      MOZ_TRY(stmt->Execute());
      cached.threadId = cached.key;
    }

    MOZ_TRY(WriteMessageReferencesInTransaction(cached.key, header.references));

    if (!header.replyTo.IsEmpty()) {
      MOZ_TRY(SetMessageProperty(cached.key, "replyTo"_ns, header.replyTo));
    }
    if (!header.charset.IsEmpty()) {
      MOZ_TRY(SetMessageProperty(cached.key, "msgCharSet"_ns, header.charset));
    }
    if (!header.accountKey.IsEmpty()) {
      MOZ_TRY(SetMessageProperty(cached.key, "account"_ns, header.accountKey));
    }
    if (header.dateReceived != 0) {
      uint32_t seconds;
      PRTime2Seconds(header.dateReceived, &seconds);
      nsAutoCString text;
      text.AppendInt(seconds, 16);
      MOZ_TRY(SetMessageProperty(cached.key, "dateReceived"_ns, text));
    }
    for (const auto& extra : header.extras) {
      if (!extra.k.EqualsLiteral("keywords")) {
        MOZ_TRY(SetMessageProperty(cached.key, extra.k, extra.v));
      }
    }
    // Only the new native storage inputs override matching extras.
    if (header.messageSize) {
      MOZ_TRY(SetMessageProperty(cached.key, "messageSize"_ns,
                                 *header.messageSize));
    }
    if (header.storeToken) {
      MOZ_TRY(
          SetMessageProperty(cached.key, "storeToken"_ns, *header.storeToken));
    }
    if (header.offlineMessageSize) {
      MOZ_TRY(SetMessageProperty(cached.key, "offlineMessageSize"_ns,
                                 *header.offlineMessageSize));
    }
    if (header.lineCount) {
      MOZ_TRY(
          SetMessageProperty(cached.key, "lineCount"_ns, *header.lineCount));
    }

    if (!mMsgCache.reserve(mMsgCache.count() + 1)) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
    message = new Message(cached.key);
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    nsresult cleanupRv = connection->GetTransactionInProgress(&inTransaction);
    if (NS_SUCCEEDED(cleanupRv) && inTransaction) {
      cleanupRv = connection->RollbackTransaction();
    }
    // Preserve the write error; a cleanup error leaves rollback unconfirmed.
    if (NS_FAILED(cleanupRv)) {
      MOZ_LOG(gPanoramaLog, LogLevel::Error,
              ("AddMessage cleanup failed: 0x%08x",
               static_cast<uint32_t>(cleanupRv)));
    }
    return rv;
  }

  // All fallible work precedes commit; no observer sees an unfinished write.
  nsMsgKey key = cached.key;
  auto entry = mMsgCache.lookup(key);
  if (entry) {
    entry->value() = std::move(cached);
  } else {
    mMsgCache.putNewInfallible(key, std::move(cached));
  }
  *aKey = key;
  if (liveHeader) {
    RefPtr<Message> result = message;
    result.forget(liveHeader);
  }
  for (MessageListener* listener : mMessageListeners.EndLimitedRange()) {
    listener->OnMessagePublished(message, notifyLegacy);
  }
  return NS_OK;
}

nsresult MessageDatabase::GetMessage(nsMsgKey key, Message** message) {
  RefPtr<Message> m = new Message(key);
  m.forget(message);
  return NS_OK;
}

NS_IMETHODIMP MessageDatabase::GetMessage(nsMsgKey key, nsIMsgDBHdr** message) {
  *message = new Message(key);
  NS_IF_ADDREF(*message);
  return NS_OK;
}

nsresult MessageDatabase::GetMessageReferences(
    nsMsgKey key, nsTArray<nsCString>& references) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "GetMessageReferences"_ns,
      "SELECT s.id, r.token FROM messages m "
      "LEFT JOIN message_reference_sets s ON s.id = m.id "
      "LEFT JOIN message_references r ON r.id = s.id "
      "WHERE m.id = :id ORDER BY r.ordinal"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  if (!more) {
    return NS_ERROR_UNEXPECTED;
  }
  bool isNull;
  MOZ_TRY(stmt->GetIsNull(0, &isNull));
  if (isNull) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  nsTArray<nsCString> result;
  do {
    MOZ_TRY(stmt->GetIsNull(1, &isNull));
    if (!isNull) {
      nsCString token;
      MOZ_TRY(stmt->GetUTF8String(1, token));
      result.AppendElement(token);
    }
    MOZ_TRY(stmt->ExecuteStep(&more));
  } while (more);
  references.SwapElements(result);
  return NS_OK;
}

nsresult MessageDatabase::WriteMessageReferencesInTransaction(
    nsMsgKey key, const nsTArray<nsCString>& references) {
  bool inTransaction;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&inTransaction));
  NS_ENSURE_TRUE(inTransaction, NS_ERROR_UNEXPECTED);
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "RequireMessageForReferences"_ns,
        "SELECT 1 FROM messages WHERE id = :id"_ns, getter_AddRefs(stmt)));
    mozStorageStatementScoper scoper(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    bool exists;
    MOZ_TRY(stmt->ExecuteStep(&exists));
    NS_ENSURE_TRUE(exists, NS_ERROR_UNEXPECTED);
  }
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "ClearMessageReferences"_ns,
        "DELETE FROM message_references WHERE id = :id"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scoper(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    MOZ_TRY(stmt->Execute());
  }
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "MarkMessageReferencesKnown"_ns,
        "INSERT OR IGNORE INTO message_reference_sets(id) VALUES(:id)"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scoper(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    MOZ_TRY(stmt->Execute());
  }
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "InsertMessageReference"_ns,
      "INSERT INTO message_references(id, ordinal, token) "
      "VALUES(:id, :ordinal, :token)"_ns,
      getter_AddRefs(stmt)));
  for (uint32_t i = 0; i < references.Length(); ++i) {
    mozStorageStatementScoper scoper(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    MOZ_TRY(stmt->BindInt64ByName("ordinal"_ns, i));
    MOZ_TRY(stmt->BindUTF8StringByName("token"_ns, references[i]));
    MOZ_TRY(stmt->Execute());
  }
  return NS_OK;
}

nsresult MessageDatabase::SetMessageReferences(
    nsMsgKey key, const nsTArray<nsCString>& references) {
  MOZ_TRY(DatabaseCore::EnsureConnection());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool inTransaction;
  MOZ_TRY(connection->GetTransactionInProgress(&inTransaction));
  NS_ENSURE_FALSE(inTransaction, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = WriteMessageReferencesInTransaction(key, references);
  if (NS_SUCCEEDED(rv)) {
    rv = connection->CommitTransaction();
  }
  if (NS_FAILED(rv)) {
    nsresult cleanupRv = connection->GetTransactionInProgress(&inTransaction);
    if (NS_SUCCEEDED(cleanupRv) && inTransaction) {
      cleanupRv = connection->RollbackTransaction();
    }
    if (NS_FAILED(cleanupRv)) {
      MOZ_LOG(gPanoramaLog, LogLevel::Error,
              ("References cleanup failed: 0x%08x",
               static_cast<uint32_t>(cleanupRv)));
    }
  }
  return rv;
}

nsresult MessageDatabase::MessageExists(nsMsgKey key, bool& exists) {
  // Removed headers stay cached for listeners; membership comes from storage.
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement("MessageExists"_ns,
                                     "SELECT 1 FROM messages WHERE id = :id"_ns,
                                     getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));

  bool hasResult;
  MOZ_TRY(stmt->ExecuteStep(&hasResult));
  exists = hasResult;
  return NS_OK;
}

NS_IMETHODIMP MessageDatabase::RemoveMessage(nsMsgKey key) {
  MOZ_ASSERT(key != nsMsgKey_None);
  MOZ_TRY(DatabaseCore::EnsureConnection());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool inTransaction;
  MOZ_TRY(connection->GetTransactionInProgress(&inTransaction));
  if (inTransaction) {
    return NS_ERROR_IN_PROGRESS;
  }

  CachedMsg cached;
  RefPtr<Message> message;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "RemoveMessage_properties"_ns,
          "DELETE FROM message_properties WHERE id = :id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
      MOZ_TRY(stmt->Execute());
    }
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "RemoveMessage"_ns,
          "DELETE FROM messages WHERE id = :id RETURNING "_ns MESSAGE_SQL_FIELDS,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
      bool hasResult;
      MOZ_TRY(stmt->ExecuteStep(&hasResult));
      if (!hasResult) {
        return NS_ERROR_UNEXPECTED;
      }
      int64_t value;
      MOZ_TRY(stmt->GetInt64(0, &value));
      cached.key = static_cast<nsMsgKey>(value);
      MOZ_TRY(stmt->GetInt64(1, &value));
      cached.folderId = static_cast<uint64_t>(value);
      MOZ_TRY(stmt->GetInt64(2, &value));
      cached.threadId = static_cast<nsMsgKey>(value);
      MOZ_TRY(stmt->GetInt64(3, &value));
      cached.threadParent = static_cast<nsMsgKey>(value);
      MOZ_TRY(stmt->GetUTF8String(4, cached.messageId));
      MOZ_TRY(stmt->GetInt64(5, &value));
      cached.date = static_cast<PRTime>(value);
      MOZ_TRY(stmt->GetUTF8String(6, cached.sender));
      MOZ_TRY(stmt->GetUTF8String(7, cached.recipients));
      MOZ_TRY(stmt->GetUTF8String(8, cached.ccList));
      MOZ_TRY(stmt->GetUTF8String(9, cached.bccList));
      MOZ_TRY(stmt->GetUTF8String(10, cached.subject));
      MOZ_TRY(stmt->GetInt64(11, &value));
      cached.flags = static_cast<uint32_t>(value);
      MOZ_TRY(stmt->GetUTF8String(12, cached.tags));
      int32_t priority;
      MOZ_TRY(stmt->GetInt32(13, &priority));
      cached.priority = static_cast<nsMsgPriorityValue>(priority);
      MOZ_TRY(stmt->ExecuteStep(&hasResult));
      if (hasResult) {
        return NS_ERROR_UNEXPECTED;
      }
    }
    if (!mMsgCache.reserve(mMsgCache.count() + 1)) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
    message = new Message(key);
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    nsresult cleanupRv = connection->GetTransactionInProgress(&inTransaction);
    if (NS_SUCCEEDED(cleanupRv) && inTransaction) {
      cleanupRv = connection->RollbackTransaction();
    }
    if (NS_FAILED(cleanupRv)) {
      MOZ_LOG(gPanoramaLog, LogLevel::Error,
              ("RemoveMessage cleanup failed: 0x%08x",
               static_cast<uint32_t>(cleanupRv)));
    }
    return rv;
  }

  // Retain the returned fields for observers, without restoring stored
  // membership.
  uint32_t oldFlags = cached.flags;
  auto entry = mMsgCache.lookup(key);
  if (entry) {
    entry->value() = std::move(cached);
  } else {
    mMsgCache.putNewInfallible(key, std::move(cached));
  }
  for (MessageListener* listener : mMessageListeners.EndLimitedRange()) {
    listener->OnMessageRemoved(message, oldFlags);
  }
  return NS_OK;
}

nsresult MessageDatabase::ListAllKeys(uint64_t folderId,
                                      nsTArray<nsMsgKey>& keys) {
  keys.Clear();

  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "ListAllKeys"_ns, "SELECT id FROM messages WHERE folderId = :folderId"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);
  stmt->BindInt64ByName("folderId"_ns, folderId);

  bool hasResult;
  while (NS_SUCCEEDED(stmt->ExecuteStep(&hasResult)) && hasResult) {
    keys.AppendElement((nsMsgKey)(stmt->AsInt64(0)));
  }

  return NS_OK;
}

nsresult MessageDatabase::ListThreadKeys(uint64_t folderId, uint64_t parent,
                                         uint64_t threadId,
                                         nsTArray<nsMsgKey>& keys) {
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "ListThreadKeys"_ns,
      "WITH RECURSIVE parents("
      "  id, parent, level, folderId"
      ") AS ("
      "  VALUES(:parent, 0, 0, :folderId)"
      "  UNION ALL"
      "  SELECT"
      "    m.id, m.threadParent, p.level + 1 AS next_level, m.folderId"
      "  FROM"
      "    messages m, parents p ON m.threadParent = p.id"
      "  WHERE threadId = :threadId"
      "  ORDER BY next_level DESC, m.id"
      ")"
      "SELECT id FROM parents WHERE id > 0 AND folderId = :folderId"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, folderId));
  MOZ_TRY(stmt->BindInt64ByName("parent"_ns, parent));
  MOZ_TRY(stmt->BindInt64ByName("threadId"_ns, threadId));

  nsTArray<nsMsgKey> found;
  while (true) {
    bool hasResult;
    MOZ_TRY(stmt->ExecuteStep(&hasResult));
    if (!hasResult) {
      break;
    }
    int64_t key;
    MOZ_TRY(stmt->GetInt64(0, &key));
    found.AppendElement(static_cast<nsMsgKey>(key));
  }
  keys = std::move(found);

  return NS_OK;
}

nsresult MessageDatabase::GetThreadMaxDate(uint64_t folderId, uint64_t threadId,
                                           uint64_t* maxDate) {
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "GetThreadMaxDate"_ns,
      "SELECT MAX(date) AS maxDate FROM messages WHERE folderId = :folderId AND threadId = :threadId"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);
  stmt->BindInt64ByName("folderId"_ns, folderId);
  stmt->BindInt64ByName("threadId"_ns, threadId);

  *maxDate = 0;
  bool hasResult;
  if (NS_SUCCEEDED(stmt->ExecuteStep(&hasResult)) && hasResult) {
    *maxDate = (uint64_t)stmt->AsInt64(0);
  }
  return NS_OK;
}

nsresult MessageDatabase::CountThreadKeys(uint64_t folderId, uint64_t threadId,
                                          uint64_t* numMessages) {
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "CountThreadKeys"_ns,
      "SELECT COUNT(*) AS numMessages FROM messages WHERE folderId = :folderId AND threadId = :threadId"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);
  stmt->BindInt64ByName("folderId"_ns, folderId);
  stmt->BindInt64ByName("threadId"_ns, threadId);

  *numMessages = 0;
  bool hasResult;
  if (NS_SUCCEEDED(stmt->ExecuteStep(&hasResult)) && hasResult) {
    *numMessages = (uint64_t)stmt->AsInt64(0);
  }
  return NS_OK;
}

nsresult MessageDatabase::ListThreadChildKeys(uint64_t folderId,
                                              uint64_t parent,
                                              nsTArray<nsMsgKey>& keys) {
  keys.Clear();

  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "ListThreadChildKeys"_ns,
      "SELECT id FROM messages WHERE folderId = :folderId AND threadParent = :parent"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);
  stmt->BindInt64ByName("folderId"_ns, folderId);
  stmt->BindInt64ByName("parent"_ns, parent);

  bool hasResult;
  while (NS_SUCCEEDED(stmt->ExecuteStep(&hasResult)) && hasResult) {
    keys.AppendElement((nsMsgKey)(stmt->AsInt64(0)));
  }

  return NS_OK;
}

// Populate a CachedMsg entry from the database.
nsresult MessageDatabase::FetchMsg(nsMsgKey key, CachedMsg& cached) {
  // TODO: Likely we'll eventually need to collect from multiple tables, either
  // with JOINs or multiple queries.
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement("FetchCachedMsg"_ns,
                                           "SELECT "_ns MESSAGE_SQL_FIELDS
                                           " FROM messages WHERE id = :id"_ns,
                                           getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);
  stmt->BindInt64ByName("id"_ns, (uint64_t)key);

  bool hasResult;
  rv = stmt->ExecuteStep(&hasResult);
  NS_ENSURE_SUCCESS(rv, rv);
  if (!hasResult) {
    return NS_ERROR_UNEXPECTED;
  }

  uint32_t len;
  cached.key = (nsMsgKey)stmt->AsInt64(0);
  cached.folderId = stmt->AsInt64(1);
  cached.threadId = (nsMsgKey)stmt->AsInt64(2);
  cached.threadParent = (nsMsgKey)stmt->AsInt64(3);
  cached.messageId = stmt->AsSharedUTF8String(4, &len);
  cached.date = (PRTime)stmt->AsInt64(5);
  cached.sender = stmt->AsSharedUTF8String(6, &len);
  cached.recipients = stmt->AsSharedUTF8String(7, &len);
  cached.ccList = stmt->AsSharedUTF8String(8, &len);
  cached.bccList = stmt->AsSharedUTF8String(9, &len);
  cached.subject = stmt->AsSharedUTF8String(10, &len);
  cached.flags = (uint32_t)stmt->AsInt64(11);
  cached.tags = stmt->AsSharedUTF8String(12, &len);
  // `nsMsgPriorityValue` is a signed int32.
  cached.priority = (nsMsgPriorityValue)stmt->AsInt32(13);

  return NS_OK;
}

Result<MessageDatabase::CachedMsg*, nsresult> MessageDatabase::EnsureCached(
    nsMsgKey key) {
  auto p = mMsgCache.lookupForAdd(key);
  if (!p) {
    TrimCache();
    CachedMsg msg;
    nsresult rv = FetchMsg(key, msg);
    if (NS_FAILED(rv)) {
      return Err(rv);
    }
    if (!mMsgCache.add(p, key, msg)) {
      return Err(NS_ERROR_FAILURE);
    }
  }
  return &p->value();
}

void MessageDatabase::TrimCache() {
  // Standin cache policy:
  // Grow to maxEntries, then discard an arbitrary 25%.
  // Could be waaaay more clever here, but let do some real-world
  // profiling before getting cute.
  constexpr uint32_t maxEntries = 512;  // (roughly 256KB).
  if (mMsgCache.count() < maxEntries) {
    return;
  }
  // Throw away 25%. Don't care which.
  uint32_t n = maxEntries / 4;
  for (auto it = mMsgCache.modIter(); !it.done(); it.next()) {
    if (!n) {
      break;
    }
    it.remove();
    --n;
  }
}

// NOTE: this query restricts the search to the same folder.
nsresult MessageDatabase::GetMessageForMessageID(uint64_t aFolderId,
                                                 const nsACString& aMessageId,
                                                 Message** aMessage) {
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "GetMessageByMessageId"_ns,
      "SELECT id"_ns
      " FROM messages WHERE folderId = :folderId AND messageId = :messageId"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);
  stmt->BindInt64ByName("folderId"_ns, aFolderId);
  stmt->BindUTF8StringByName("messageId"_ns, aMessageId);

  bool hasResult;
  rv = stmt->ExecuteStep(&hasResult);
  NS_ENSURE_SUCCESS(rv, rv);
  if (!hasResult) {
    return NS_ERROR_UNEXPECTED;
  }
  nsMsgKey key = (nsMsgKey)stmt->AsInt64(0);

  RefPtr<Message> message = new Message(key);
  message.forget(aMessage);

  return NS_OK;
}

// TODO: This is a quick hack.
// Doesn't take into account various corner cases (eg multiple
// messages with same message-id!).
Result<nsMsgKey, nsresult> MessageDatabase::FindByMessageId(
    nsACString const& messageId) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "FindByMessageId"_ns,
      "SELECT id FROM messages WHERE messageId = :messageId"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindUTF8StringByName("messageId"_ns, messageId));

  bool hasResult;
  MOZ_TRY(stmt->ExecuteStep(&hasResult));
  if (!hasResult) {
    return nsMsgKey{0};
  }
  return (nsMsgKey)stmt->AsInt64(0);
}

nsresult MessageDatabase::MarkAllRead(uint64_t aFolderId,
                                      nsTArray<nsMsgKey>& aMarkedKeys) {
  aMarkedKeys.Clear();

  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "MarkAllRead"_ns,
      "UPDATE messages SET flags = flags | :flag WHERE folderId = :folderId AND flags & :flag = 0 RETURNING id"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);

  stmt->BindInt64ByName("flag"_ns, nsMsgMessageFlags::Read);
  stmt->BindInt64ByName("folderId"_ns, aFolderId);

  bool hasResult;
  while (NS_SUCCEEDED(stmt->ExecuteStep(&hasResult)) && hasResult) {
    aMarkedKeys.AppendElement((nsMsgKey)(stmt->AsInt64(0)));
  }

  // Update affected cache entries.
  for (nsMsgKey key : aMarkedKeys) {
    auto p = mMsgCache.lookup(key);
    if (p) {
      p->value().flags |= nsMsgMessageFlags::Read;
    }
  }

  return NS_OK;
}

nsresult MessageDatabase::GetNumMessages(uint64_t folderId,
                                         uint64_t* numMessages) {
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "GetNumMessages"_ns,
      "SELECT COUNT(*) AS numMessages FROM messages WHERE folderId = :folderId"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);

  stmt->BindInt64ByName("folderId"_ns, folderId);

  *numMessages = 0;
  bool hasResult;
  if (NS_SUCCEEDED(stmt->ExecuteStep(&hasResult)) && hasResult) {
    *numMessages = (uint64_t)stmt->AsInt64(0);
  }

  return rv;
}

nsresult MessageDatabase::GetNumUnread(uint64_t folderId, uint64_t* numUnread) {
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "GetNumUnread"_ns,
      "SELECT COUNT(*) AS numUnread FROM messages WHERE folderId = :folderId AND flags & :flag = 0"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);

  stmt->BindInt64ByName("folderId"_ns, folderId);
  stmt->BindInt64ByName("flag"_ns, nsMsgMessageFlags::Read);

  *numUnread = 0;
  bool hasResult;
  if (NS_SUCCEEDED(stmt->ExecuteStep(&hasResult)) && hasResult) {
    *numUnread = (uint64_t)stmt->AsInt64(0);
  }

  return rv;
}

nsresult MessageDatabase::GetMessagePropertyNames(nsMsgKey key,
                                                  nsTArray<nsCString>& names) {
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "GetMessageProperties"_ns,
      "SELECT name FROM message_properties WHERE id = :id"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);

  MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));

  nsTArray<nsCString> found;
  while (true) {
    bool hasResult;
    MOZ_TRY(stmt->ExecuteStep(&hasResult));
    if (!hasResult) {
      break;
    }
    nsCString name;
    MOZ_TRY(stmt->GetUTF8String(0, name));
    found.AppendElement(std::move(name));
  }
  names = std::move(found);

  return NS_OK;
}

NS_IMETHODIMP MessageDatabase::GetMessageProperty(nsMsgKey aKey,
                                                  const nsACString& aName,
                                                  nsACString& aValue) {
  MOZ_ASSERT(!aName.EqualsLiteral("keywords"));  // Use GetMessageTags().

  // TODO: might want to cache selected properties.
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "GetMessageProperty"_ns,
      "SELECT value FROM message_properties WHERE id = :id AND name = :name"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);

  MOZ_TRY(stmt->BindInt64ByName("id"_ns, aKey));
  MOZ_TRY(stmt->BindUTF8StringByName("name"_ns, aName));

  bool hasResult;
  MOZ_TRY(stmt->ExecuteStep(&hasResult));
  if (hasResult) {
    return stmt->GetUTF8String(0, aValue);
  }
  aValue.Truncate();
  return NS_OK;
}

nsresult MessageDatabase::GetMessageProperty(nsMsgKey key,
                                             const nsACString& name,
                                             uint32_t& value) {
  // TODO: might want to cache selected properties.
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "GetMessageProperty"_ns,
      "SELECT value FROM message_properties WHERE id = :id AND name = :name"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);

  MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
  MOZ_TRY(stmt->BindUTF8StringByName("name"_ns, name));

  bool hasResult;
  MOZ_TRY(stmt->ExecuteStep(&hasResult));
  int64_t stored = 0;
  if (hasResult) {
    MOZ_TRY(stmt->GetInt64(0, &stored));
  }
  value = static_cast<uint32_t>(stored);
  return NS_OK;
}

nsresult MessageDatabase::SetMessageProperty(nsMsgKey aKey,
                                             const nsACString& aName,
                                             const nsACString& aValue) {
  MOZ_ASSERT(!aName.EqualsLiteral("keywords"));  // Use SetMessageTags().

  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "SetMessageProperty"_ns,
      "REPLACE INTO message_properties (id, name, value) VALUES (:id, :name, :value)"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);

  MOZ_TRY(stmt->BindInt64ByName("id"_ns, aKey));
  MOZ_TRY(stmt->BindUTF8StringByName("name"_ns, aName));
  MOZ_TRY(stmt->BindUTF8StringByName("value"_ns, aValue));
  rv = stmt->Execute();
  NS_ENSURE_SUCCESS(rv, rv);
  // TODO: might want to cache selected properties.
  return NS_OK;
}

nsresult MessageDatabase::SetMessageProperty(nsMsgKey aKey,
                                             const nsACString& aName,
                                             uint32_t aValue) {
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "SetMessageProperty"_ns,
      "REPLACE INTO message_properties (id, name, value) VALUES (:id, :name, :value)"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);

  MOZ_TRY(stmt->BindInt64ByName("id"_ns, aKey));
  MOZ_TRY(stmt->BindUTF8StringByName("name"_ns, aName));
  MOZ_TRY(stmt->BindInt64ByName("value"_ns, aValue));
  rv = stmt->Execute();
  NS_ENSURE_SUCCESS(rv, rv);
  // TODO: might want to cache selected properties.
  return NS_OK;
}

NS_IMETHODIMP_(void)
MessageDatabase::AddMessageListener(MessageListener* aListener) {
  mMessageListeners.AppendElement(aListener);
}

NS_IMETHODIMP_(void)
MessageDatabase::RemoveMessageListener(MessageListener* aListener) {
  mMessageListeners.RemoveElement(aListener);
}

// Message functions

nsresult MessageDatabase::GetMessageFlags(nsMsgKey key, uint32_t& flags) {
  CachedMsg* cached = MOZ_TRY(EnsureCached(key));
  flags = cached->flags;
  return NS_OK;
}

nsresult MessageDatabase::GetMessageFlag(nsMsgKey key, uint32_t flag,
                                         bool& value) {
  uint32_t flags;
  MOZ_TRY(GetMessageFlags(key, flags));
  value = (flags & flag) ? true : false;
  return NS_OK;
}

nsresult MessageDatabase::GetMessagePriority(nsMsgKey key,
                                             nsMsgPriorityValue& priority) {
  CachedMsg* cached = MOZ_TRY(EnsureCached(key));
  priority = cached->priority;
  return NS_OK;
}

nsresult MessageDatabase::GetMessageOfflineMessageSize(nsMsgKey key,
                                                       uint64_t& size) {
  uint32_t tmp;
  MOZ_TRY(GetMessageProperty(key, "offlineMessageSize"_ns, tmp));
  size = tmp;
  return NS_OK;
}

nsresult MessageDatabase::GetMessageDate(nsMsgKey key, PRTime& date) {
  CachedMsg* cached = MOZ_TRY(EnsureCached(key));
  date = cached->date;
  return NS_OK;
}

nsresult MessageDatabase::GetMessageSize(nsMsgKey key, uint64_t& size) {
  uint32_t tmp;
  MOZ_TRY(GetMessageProperty(key, "messageSize"_ns, tmp));
  size = tmp;
  return NS_OK;
}

nsresult MessageDatabase::GetMessageLineCount(nsMsgKey key, uint32_t& count) {
  uint32_t tmp;
  MOZ_TRY(GetMessageProperty(key, "lineCount"_ns, tmp));
  count = tmp;
  return NS_OK;
}

nsresult MessageDatabase::GetMessageStoreToken(nsMsgKey key,
                                               nsACString& token) {
  return GetMessageProperty(key, "storeToken"_ns, token);
}

nsresult MessageDatabase::GetMessageMessageId(nsMsgKey key,
                                              nsACString& messageId) {
  CachedMsg* cached = MOZ_TRY(EnsureCached(key));
  messageId.Assign(cached->messageId);
  return NS_OK;
}

nsresult MessageDatabase::GetMessageCcList(nsMsgKey key, nsACString& ccList) {
  CachedMsg* cached = MOZ_TRY(EnsureCached(key));
  ccList.Assign(cached->ccList);
  return NS_OK;
}

nsresult MessageDatabase::GetMessageBccList(nsMsgKey key, nsACString& bccList) {
  CachedMsg* cached = MOZ_TRY(EnsureCached(key));
  bccList.Assign(cached->bccList);
  return NS_OK;
}

nsresult MessageDatabase::GetMessageSender(nsMsgKey key, nsACString& sender) {
  CachedMsg* cached = MOZ_TRY(EnsureCached(key));
  sender.Assign(cached->sender);
  return NS_OK;
}

nsresult MessageDatabase::GetMessageSubject(nsMsgKey key, nsACString& subject) {
  CachedMsg* cached = MOZ_TRY(EnsureCached(key));
  subject.Assign(cached->subject);
  return NS_OK;
}

nsresult MessageDatabase::GetMessageRecipients(nsMsgKey key,
                                               nsACString& recipients) {
  CachedMsg* cached = MOZ_TRY(EnsureCached(key));
  recipients.Assign(cached->recipients);
  return NS_OK;
}

nsresult MessageDatabase::GetMessageTags(nsMsgKey key, nsACString& tags) {
  CachedMsg* cached = MOZ_TRY(EnsureCached(key));
  tags.Assign(cached->tags);
  return NS_OK;
}

nsresult MessageDatabase::GetMessageUidOnServer(nsMsgKey key,
                                                uint32_t& uidOnServer) {
  bool exists;
  MOZ_TRY(MessageExists(key, exists));
  NS_ENSURE_TRUE(exists, NS_ERROR_UNEXPECTED);

  RefPtr<Message> message = new Message(key);
  uint32_t value;
  MOZ_TRY(message->GetUint32Property("uidOnServer", &value));
  uidOnServer = value;
  return NS_OK;
}

nsresult MessageDatabase::GetMessageKeyForServerUid(uint64_t folderId,
                                                    uint32_t epoch,
                                                    uint32_t uid,
                                                    nsMsgKey& key) {
  NS_ENSURE_TRUE(DatabaseCore::sInstance, NS_ERROR_NOT_AVAILABLE);
  uint32_t current;
  MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(folderId,
                                                                   current));
  if (current != epoch) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "MembersWithServerUid"_ns,
      "SELECT m.id FROM messages m JOIN message_properties p ON p.id = m.id "
      "AND p.name = 'uidOnServer' WHERE m.folderId = :folderId ORDER BY m.id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, folderId));
  nsMsgKey found = nsMsgKey_None;
  while (true) {
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (!more) {
      break;
    }
    int64_t storedKey;
    MOZ_TRY(stmt->GetInt64(0, &storedKey));
    if (storedKey <= 0 || storedKey >= nsMsgKey_None) {
      return NS_ERROR_FILE_CORRUPTED;
    }
    uint32_t storedUid;
    MOZ_TRY(GetMessageUidOnServer(static_cast<nsMsgKey>(storedKey), storedUid));
    if (storedUid != uid) {
      continue;
    }
    if (found != nsMsgKey_None) {
      return NS_ERROR_FILE_CORRUPTED;
    }
    found = static_cast<nsMsgKey>(storedKey);
  }
  if (found == nsMsgKey_None) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  key = found;
  return NS_OK;
}

nsresult MessageDatabase::BindMessageToServerUid(nsMsgKey key,
                                                 uint64_t folderId,
                                                 uint32_t epoch, uint32_t uid) {
  if (!key || key == nsMsgKey_None || !folderId || folderId > INT64_MAX) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  NS_ENSURE_TRUE(DatabaseCore::sInstance, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(DatabaseCore::EnsureConnection());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool active;
  MOZ_TRY(connection->GetTransactionInProgress(&active));
  if (active) {
    return NS_ERROR_IN_PROGRESS;
  }
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    uint32_t current;
    MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(folderId,
                                                                     current));
    if (current != epoch) {
      return NS_ERROR_NOT_AVAILABLE;
    }
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "MessageInServerUidFolder"_ns,
          "SELECT id FROM messages WHERE id = :id AND folderId = :folderId"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
      MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, folderId));
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      if (!more) {
        return NS_ERROR_NOT_AVAILABLE;
      }
    }
    nsMsgKey existing;
    nsresult lookupRv =
        GetMessageKeyForServerUid(folderId, epoch, uid, existing);
    if (NS_FAILED(lookupRv) && lookupRv != NS_ERROR_NOT_AVAILABLE) {
      return lookupRv;
    }
    if (NS_SUCCEEDED(lookupRv) && existing != key) {
      return NS_ERROR_FILE_CORRUPTED;
    }
    MOZ_TRY(SetMessageUidOnServer(key, uid));
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    nsresult cleanupRv = connection->GetTransactionInProgress(&active);
    if (NS_SUCCEEDED(cleanupRv) && active) {
      cleanupRv = connection->RollbackTransaction();
    }
    if (NS_FAILED(cleanupRv)) {
      MOZ_LOG(gPanoramaLog, LogLevel::Error,
              ("Server UID binding cleanup failed: 0x%08x",
               static_cast<uint32_t>(cleanupRv)));
    }
  }
  return rv;
}

nsresult MessageDatabase::GetMessageThreadId(nsMsgKey key, nsMsgKey& threadId) {
  CachedMsg* cached = MOZ_TRY(EnsureCached(key));
  threadId = cached->threadId;
  return NS_OK;
}

nsresult MessageDatabase::GetMessageThreadParent(nsMsgKey key,
                                                 nsMsgKey& threadParent) {
  CachedMsg* cached = MOZ_TRY(EnsureCached(key));
  threadParent = cached->threadParent;
  return NS_OK;
}

nsresult MessageDatabase::GetMessageFolderId(nsMsgKey key, uint64_t& folderId) {
  CachedMsg* cached = MOZ_TRY(EnsureCached(key));
  folderId = cached->folderId;
  return NS_OK;
}

nsresult MessageDatabase::SetMessageFlags(nsMsgKey key, uint32_t newFlags) {
  uint32_t oldFlags;
  MOZ_TRY(GetMessageFlags(key, oldFlags));

  if (NS_WARN_IF(oldFlags == newFlags)) {
    return NS_OK;
  }

  nsAutoCString tags;
  MOZ_TRY(GetMessageTags(key, tags));
  PRTime date;
  MOZ_TRY(GetMessageDate(key, date));
  nsMsgKey threadId;
  MOZ_TRY(GetMessageThreadId(key, threadId));
  uint64_t folderId;
  MOZ_TRY(GetMessageFolderId(key, folderId));
  RefPtr<DetachedMsgHdr> oldMessage = new DetachedMsgHdr(folderId);
  MOZ_TRY(oldMessage->SetFlags(oldFlags));
  MOZ_TRY(oldMessage->SetStringProperty("keywords", tags));
  MOZ_TRY(oldMessage->SetDate(date));
  MOZ_TRY(oldMessage->SetThreadId(threadId));

  // Update in DB.
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    nsresult rv = DatabaseCore::GetStatement(
        "SetMessageFlags"_ns,
        "UPDATE messages SET flags = :flags WHERE id = :id"_ns,
        getter_AddRefs(stmt));
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    stmt->BindInt64ByName("id"_ns, key);
    stmt->BindInt64ByName("flags"_ns, (int64_t)newFlags);
    rv = stmt->Execute();
    NS_ENSURE_SUCCESS(rv, rv);
  }

  // Update cache.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().flags = newFlags;
  }

  // Notify.
  RefPtr<Message> message = new Message(key);
  for (MessageListener* listener : mMessageListeners.EndLimitedRange()) {
    listener->OnMessageFlagsChanged(oldMessage, message, oldFlags, newFlags);
  }
  return NS_OK;
}

nsresult MessageDatabase::SetMessageFlag(nsMsgKey key, uint32_t flag,
                                         bool value) {
  uint32_t flags;
  MOZ_TRY(GetMessageFlags(key, flags));
  if (value) {
    flags |= flag;
  } else {
    flags &= ~flag;
  }
  return SetMessageFlags(key, flags);
}

nsresult MessageDatabase::SetMessagePriority(nsMsgKey key,
                                             nsMsgPriorityValue priority) {
  // Update DB.
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    nsresult rv = DatabaseCore::GetStatement(
        "SetMessagePriority"_ns,
        "UPDATE messages SET priority = :priority WHERE id = :id"_ns,
        getter_AddRefs(stmt));
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    stmt->BindInt64ByName("id"_ns, key);
    stmt->BindInt32ByName("priority"_ns, priority);
    rv = stmt->Execute();
    NS_ENSURE_SUCCESS(rv, rv);
  }

  // Update cache.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().priority = priority;
  }

  // TODO: notifications.
  return NS_OK;
}

nsresult MessageDatabase::SetMessageOfflineMessageSize(nsMsgKey key,
                                                       uint64_t size) {
  return SetMessageProperty(key, "offlineMessageSize"_ns, (uint32_t)size);
}

nsresult MessageDatabase::SetMessageDate(nsMsgKey key, PRTime date) {
  // Update DB.
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    nsresult rv = DatabaseCore::GetStatement(
        "SetMessageDate"_ns,
        "UPDATE messages SET date = :date WHERE id = :id"_ns,
        getter_AddRefs(stmt));
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    stmt->BindInt64ByName("id"_ns, key);
    stmt->BindInt64ByName("date"_ns, (int64_t)date);
    rv = stmt->Execute();
    NS_ENSURE_SUCCESS(rv, rv);
  }

  // Update cache.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().date = date;
  }
  // TODO: notifications.
  return NS_OK;
}

nsresult MessageDatabase::SetMessageSize(nsMsgKey key, uint64_t size) {
  return SetMessageProperty(key, "messageSize"_ns, (uint32_t)size);
}

nsresult MessageDatabase::SetMessageLineCount(nsMsgKey key, uint32_t count) {
  return SetMessageProperty(key, "lineCount"_ns, (uint32_t)count);
}

nsresult MessageDatabase::SetMessageStoreToken(nsMsgKey key,
                                               const nsACString& token) {
  return SetMessageProperty(key, "storeToken"_ns, token);
}

nsresult MessageDatabase::SetMessageMessageId(nsMsgKey key,
                                              const nsACString& messageId) {
  // Update DB.
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    nsresult rv = DatabaseCore::GetStatement(
        "SetMessageMessageId"_ns,
        "UPDATE messages SET messageId = :messageId WHERE id = :id"_ns,
        getter_AddRefs(stmt));
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    stmt->BindInt64ByName("id"_ns, key);
    stmt->BindUTF8StringByName("messageId"_ns, messageId);
    rv = stmt->Execute();
    NS_ENSURE_SUCCESS(rv, rv);
  }

  // Update cache.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().messageId = messageId;
  }

  // TODO: notifications.
  return NS_OK;
}

nsresult MessageDatabase::SetMessageCcList(nsMsgKey key,
                                           const nsACString& ccList) {
  // Update DB.
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    nsresult rv = DatabaseCore::GetStatement(
        "SetMessageCcList"_ns,
        "UPDATE messages SET ccList = :ccList WHERE id = :id"_ns,
        getter_AddRefs(stmt));
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    stmt->BindInt64ByName("id"_ns, key);
    stmt->BindUTF8StringByName("ccList"_ns, ccList);
    rv = stmt->Execute();
    NS_ENSURE_SUCCESS(rv, rv);
  }

  // Update cache.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().ccList = ccList;
  }

  // TODO: notifications.
  return NS_OK;
}

nsresult MessageDatabase::SetMessageBccList(nsMsgKey key,
                                            const nsACString& bccList) {
  // Update DB.
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    nsresult rv = DatabaseCore::GetStatement(
        "SetMessageBccList"_ns,
        "UPDATE messages SET bccList = :bccList WHERE id = :id"_ns,
        getter_AddRefs(stmt));
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    stmt->BindInt64ByName("id"_ns, key);
    stmt->BindUTF8StringByName("bccList"_ns, bccList);
    rv = stmt->Execute();
    NS_ENSURE_SUCCESS(rv, rv);
  }

  // Update cache.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().bccList = bccList;
  }

  // TODO: notifications.
  return NS_OK;
}

nsresult MessageDatabase::SetMessageSender(nsMsgKey key,
                                           const nsACString& sender) {
  // Update DB.
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    nsresult rv = DatabaseCore::GetStatement(
        "SetMessageSender"_ns,
        "UPDATE messages SET sender = :sender WHERE id = :id"_ns,
        getter_AddRefs(stmt));
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    stmt->BindInt64ByName("id"_ns, key);
    stmt->BindUTF8StringByName("sender"_ns, sender);
    rv = stmt->Execute();
    NS_ENSURE_SUCCESS(rv, rv);
  }

  // Update cache.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().sender = sender;
  }

  // TODO: notifications.
  return NS_OK;
}

nsresult MessageDatabase::SetMessageSubject(nsMsgKey key,
                                            const nsACString& subject) {
  // Update DB.
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    nsresult rv = DatabaseCore::GetStatement(
        "SetMessageSubject"_ns,
        "UPDATE messages SET subject = :subject WHERE id = :id"_ns,
        getter_AddRefs(stmt));
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    stmt->BindInt64ByName("id"_ns, key);
    stmt->BindUTF8StringByName("subject"_ns, subject);
    rv = stmt->Execute();
    NS_ENSURE_SUCCESS(rv, rv);
  }

  // Update cache.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().subject = subject;
  }

  // TODO: notifications.
  return NS_OK;
}

nsresult MessageDatabase::SetMessageRecipients(nsMsgKey key,
                                               const nsACString& recipients) {
  // Update DB.
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    nsresult rv = DatabaseCore::GetStatement(
        "SetMessageRecipients"_ns,
        "UPDATE messages SET recipients = :recipients WHERE id = :id"_ns,
        getter_AddRefs(stmt));
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    stmt->BindInt64ByName("id"_ns, key);
    stmt->BindUTF8StringByName("recipients"_ns, recipients);
    rv = stmt->Execute();
    NS_ENSURE_SUCCESS(rv, rv);
  }

  // Update cache.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().recipients = recipients;
  }

  // TODO: notifications.
  return NS_OK;
}

nsresult MessageDatabase::SetMessageTags(nsMsgKey key, nsACString const& tags) {
  nsAutoCString oldTags;
  MOZ_TRY(GetMessageTags(key, oldTags));

  if (NS_WARN_IF(oldTags.Equals(tags))) {
    return NS_OK;
  }

  uint32_t flags;
  MOZ_TRY(GetMessageFlags(key, flags));
  PRTime date;
  MOZ_TRY(GetMessageDate(key, date));
  nsMsgKey threadId;
  MOZ_TRY(GetMessageThreadId(key, threadId));
  uint64_t folderId;
  MOZ_TRY(GetMessageFolderId(key, folderId));
  RefPtr<DetachedMsgHdr> oldMessage = new DetachedMsgHdr(folderId);
  MOZ_TRY(oldMessage->SetFlags(flags));
  MOZ_TRY(oldMessage->SetStringProperty("keywords", oldTags));
  MOZ_TRY(oldMessage->SetDate(date));
  MOZ_TRY(oldMessage->SetThreadId(threadId));

  // Update DB.
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    nsresult rv = DatabaseCore::GetStatement(
        "SetMessageTags"_ns,
        "UPDATE messages SET tags = :tags WHERE id = :id"_ns,
        getter_AddRefs(stmt));
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    stmt->BindInt64ByName("id"_ns, key);
    stmt->BindUTF8StringByName("tags"_ns, tags);
    rv = stmt->Execute();
    NS_ENSURE_SUCCESS(rv, rv);
  }

  // Update cache.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().tags = tags;
  }

  // Notify.
  RefPtr<Message> message = new Message(key);
  for (MessageListener* listener : mMessageListeners.EndLimitedRange()) {
    listener->OnMessageTagsChanged(oldMessage, message, oldTags, tags);
  }
  return NS_OK;
}

nsresult MessageDatabase::SetMessageUidOnServer(nsMsgKey key,
                                                uint32_t uidOnServer) {
  bool exists;
  MOZ_TRY(MessageExists(key, exists));
  NS_ENSURE_TRUE(exists, NS_ERROR_UNEXPECTED);

  RefPtr<Message> message = new Message(key);
  return message->SetUint32Property("uidOnServer", uidOnServer);
}

namespace {

const CapturedMessage* FindThreadCapture(const nsTArray<CapturedMessage>& rows,
                                         nsMsgKey key) {
  for (const auto& row : rows) {
    if (row.id == key) {
      return &row;
    }
  }
  return nullptr;
}

nsresult CopyThreadCaptures(const nsTArray<CapturedMessage>& source,
                            nsTArray<CapturedMessage>& target) {
  if (!target.SetLength(source.Length(), fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  for (size_t i = 0; i < source.Length(); ++i) {
    const auto& from = source[i];
    auto& to = target[i];
    to.id = from.id;
    to.folderId = from.folderId;
    to.date = from.date;
    to.flags = from.flags;
    to.threadId = from.threadId;
    to.threadParent = from.threadParent;
    if (!to.messageId.Assign(from.messageId, fallible) ||
        !to.sender.Assign(from.sender, fallible) ||
        !to.recipients.Assign(from.recipients, fallible) ||
        !to.subject.Assign(from.subject, fallible) ||
        !to.tags.Assign(from.tags, fallible)) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
  }
  return NS_OK;
}

bool ValidThreadBatch(const MessageThreadBatch& batch) {
  if (batch.publicationKey == 0 || batch.publicationKey == nsMsgKey_None ||
      batch.after.Length() <= batch.before.Length() ||
      batch.after.Length() - batch.before.Length() != 1 ||
      FindThreadCapture(batch.before, batch.publicationKey) ||
      !FindThreadCapture(batch.after, batch.publicationKey)) {
    return false;
  }
  for (const auto& rows : {&batch.before, &batch.after}) {
    for (const auto& row : *rows) {
      if (row.id == 0 || row.id == nsMsgKey_None ||
          FindThreadCapture(*rows, row.id) != &row) {
        return false;
      }
    }
  }
  for (const auto& before : batch.before) {
    const auto* after = FindThreadCapture(batch.after, before.id);
    if (!after || before.folderId != after->folderId) {
      return false;
    }
    bool changed = before.threadId != after->threadId ||
                   before.threadParent != after->threadParent;
    if (changed != batch.changedKeys.Contains(before.id)) {
      return false;
    }
  }
  nsMsgKey previous = 0;
  for (nsMsgKey key : batch.changedKeys) {
    if (key <= previous || !FindThreadCapture(batch.before, key)) {
      return false;
    }
    previous = key;
  }
  return true;
}

}  // namespace

nsresult MessageDatabase::CaptureMessage(nsMsgKey key,
                                         CapturedMessage& output) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "CaptureMessage"_ns,
      "SELECT folderId, messageId, date, sender, recipients, subject, flags, "
      "tags, threadId, threadParent FROM messages WHERE id = :id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_UNEXPECTED);
  CapturedMessage captured;
  captured.id = key;
  int64_t value;
  MOZ_TRY(stmt->GetInt64(0, &value));
  captured.folderId = static_cast<uint64_t>(value);
  MOZ_TRY(stmt->GetUTF8String(1, captured.messageId));
  MOZ_TRY(stmt->GetInt64(2, &value));
  captured.date = static_cast<PRTime>(value);
  MOZ_TRY(stmt->GetUTF8String(3, captured.sender));
  MOZ_TRY(stmt->GetUTF8String(4, captured.recipients));
  MOZ_TRY(stmt->GetUTF8String(5, captured.subject));
  MOZ_TRY(stmt->GetInt64(6, &value));
  captured.flags = static_cast<uint32_t>(value);
  MOZ_TRY(stmt->GetUTF8String(7, captured.tags));
  MOZ_TRY(stmt->GetInt64(8, &value));
  captured.threadId = static_cast<nsMsgKey>(value);
  MOZ_TRY(stmt->GetInt64(9, &value));
  captured.threadParent = static_cast<nsMsgKey>(value);
  output = std::move(captured);
  return NS_OK;
}

PreparedThreadBatch::PreparedThreadBatch() = default;
PreparedThreadBatch::~PreparedThreadBatch() = default;
PreparedThreadBatch::PreparedThreadBatch(PreparedThreadBatch&&) = default;
PreparedThreadBatch& PreparedThreadBatch::operator=(PreparedThreadBatch&&) =
    default;

nsresult MessageListener::PrepareThreadBatch(const MessageThreadBatch& batch,
                                             PreparedThreadBatch& output) {
  NS_ENSURE_TRUE(ValidThreadBatch(batch), NS_ERROR_INVALID_ARG);
  PreparedThreadBatch prepared;
  prepared.captured.batchId = batch.batchId;
  prepared.captured.publicationKey = batch.publicationKey;
  prepared.captured.notifyLegacy = batch.notifyLegacy;
  MOZ_TRY(CopyThreadCaptures(batch.before, prepared.captured.before));
  MOZ_TRY(CopyThreadCaptures(batch.after, prepared.captured.after));
  if (!prepared.captured.changedKeys.Assign(batch.changedKeys, fallible) ||
      !prepared.changedLive.SetLength(batch.changedKeys.Length(), fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  for (size_t i = 0; i < batch.changedKeys.Length(); ++i) {
    prepared.changedLive[i] = new (fallible) Message(batch.changedKeys[i]);
    if (!prepared.changedLive[i]) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
  }
  prepared.publicationLive = new (fallible) Message(batch.publicationKey);
  if (!prepared.publicationLive) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  output = std::move(prepared);
  return NS_OK;
}

void MessageListener::DeliverThreadBatch(const PreparedThreadBatch& prepared) {
  const auto& batch = prepared.captured;
  MOZ_ASSERT(prepared.changedLive.Length() == batch.changedKeys.Length());
  for (size_t i = 0; i < batch.changedKeys.Length(); ++i) {
    const auto* before = FindThreadCapture(batch.before, batch.changedKeys[i]);
    const auto* after = FindThreadCapture(batch.after, batch.changedKeys[i]);
    MOZ_ASSERT(before && after && prepared.changedLive[i]);
    OnMessageThreadChanged(*before, *after, prepared.changedLive[i].get());
  }
  const auto* publication =
      FindThreadCapture(batch.after, batch.publicationKey);
  MOZ_ASSERT(publication && prepared.publicationLive);
  OnMessagePublishedCaptured(*publication, prepared.publicationLive.get(),
                             batch.notifyLegacy);
}

nsresult MessageDatabase::DiscoverConversationComponent(
    nsMsgKey key, nsTArray<ConversationMember>& output) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "DiscoverConversationComponent"_ns,
      "WITH availability(seedExists, unknownHistory) AS ("
      "SELECT EXISTS(SELECT 1 FROM messages WHERE id = :id), "
      "EXISTS(SELECT 1 FROM messages m LEFT JOIN message_reference_sets s "
      "ON s.id = m.id WHERE s.id IS NULL)"
      "), direct(id) AS ("
      "SELECT id FROM messages WHERE id = :id "
      "UNION SELECT p.id FROM message_references r "
      "JOIN messages p ON p.messageId = r.token COLLATE BINARY "
      "WHERE r.id = :id AND r.token <> '' "
      "UNION SELECT child.id FROM messages added "
      "JOIN message_references r ON r.token = added.messageId COLLATE BINARY "
      "JOIN messages child ON child.id = r.id "
      "WHERE added.id = :id AND added.messageId <> '' "
      "UNION SELECT sibling.id FROM message_references incoming "
      "JOIN message_references existing "
      "ON existing.token = incoming.token COLLATE BINARY "
      "JOIN messages sibling ON sibling.id = existing.id "
      "WHERE incoming.id = :id AND incoming.token <> ''"
      ") SELECT a.seedExists, a.unknownHistory, m.id, m.folderId "
      "FROM availability a LEFT JOIN messages m "
      "ON a.seedExists AND NOT a.unknownHistory AND ("
      "m.id IN (SELECT id FROM direct) OR m.threadId IN ("
      "SELECT old.threadId FROM messages old JOIN direct ON direct.id = old.id "
      "WHERE old.threadId <> 0)) ORDER BY m.id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_UNEXPECTED);
  int32_t exists, unavailable;
  MOZ_TRY(stmt->GetInt32(0, &exists));
  MOZ_TRY(stmt->GetInt32(1, &unavailable));
  NS_ENSURE_TRUE(exists, NS_ERROR_UNEXPECTED);
  // Lost history anywhere could hide a reverse or shared-token edge.
  NS_ENSURE_TRUE(!unavailable, NS_ERROR_NOT_AVAILABLE);

  nsTArray<ConversationMember> result;
  do {
    int64_t id, folderId;
    MOZ_TRY(stmt->GetInt64(2, &id));
    MOZ_TRY(stmt->GetInt64(3, &folderId));
    NS_ENSURE_TRUE(
        id > 0 && id < static_cast<int64_t>(nsMsgKey_None) && folderId > 0,
        NS_ERROR_FILE_CORRUPTED);
    ConversationMember member{static_cast<nsMsgKey>(id),
                              static_cast<uint64_t>(folderId)};
    if (!result.AppendElement(member, fallible)) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
    MOZ_TRY(stmt->ExecuteStep(&more));
  } while (more);
  output.SwapElements(result);
  return NS_OK;
}

}  // namespace mozilla::mailnews
