/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "MessageDatabase.h"

#include <algorithm>
#include <cstdint>
#include <utility>

#include "DatabaseCore.h"
#include "DatabaseUtils.h"
#include "DetachedMsgHdr.h"
#include "Message.h"
#include "js/Array.h"
#include "js/CharacterEncoding.h"
#include "js/String.h"
#include "jsapi.h"
#include "mozIStorageConnection.h"
#include "mozIStorageStatement.h"
#include "mozIStorageValueArray.h"
#include "mozStorageHelper.h"
#include "mozilla/Logging.h"
#include "mozilla/ResultExtensions.h"
#include "mozilla/Try.h"
#include "mozilla/fallible.h"
#include "mozilla/UniquePtr.h"
#include "nsIFile.h"
#include "nsLocalFile.h"
#include "nsIMsgDatabase.h"
#include "nsIMsgOfflineImapOperation.h"
#include "nsMsgMessageFlags.h"
#include "nsMsgUtils.h"
#include "nsReadableUtils.h"

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

namespace {

constexpr uint64_t kMaxSearchSequence = 9007199254740991;

bool SearchText(JSContext* cx, JS::Handle<JSObject*> object, const char* name,
                const nsACString& text) {
  nsAutoCString flat(text);
  JS::Rooted<JSString*> string(
      cx, JS_NewStringCopyUTF8Z(
              cx, JS::ConstUTF8CharsZ(flat.get(), flat.Length())));
  if (!string) {
    return false;
  }
  JS::Rooted<JS::Value> value(cx, JS::StringValue(string));
  return JS_DefineProperty(cx, object, name, value, JSPROP_ENUMERATE);
}

bool SearchRevision(JSContext* cx, JS::Handle<JSObject*> object,
                    const char* name, int64_t revision) {
  nsAutoCString text;
  text.AppendInt(revision);
  return SearchText(cx, object, name, text);
}

}  // namespace

nsresult MessageDatabase::RequireCommittedSearchRead() {
  NS_ENSURE_TRUE(DatabaseCore::sInstance && DatabaseCore::sConnection &&
                     DatabaseCore::sInstance->mMessageDatabase.get() == this,
                 NS_ERROR_NOT_AVAILABLE);
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  return active ? NS_ERROR_IN_PROGRESS : NS_OK;
}

nsresult MessageDatabase::GetSearchWatermark(uint64_t& sequence) {
  MOZ_TRY(RequireCommittedSearchRead());
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "SearchWatermark"_ns,
      "SELECT COALESCE(MAX(sequence), 0) FROM message_changes"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
  int64_t value;
  MOZ_TRY(stmt->GetInt64(0, &value));
  NS_ENSURE_TRUE(value >= 0 && uint64_t(value) <= kMaxSearchSequence,
                 NS_ERROR_FILE_CORRUPTED);
  sequence = value;
  return NS_OK;
}

NS_IMETHODIMP MessageDatabase::GetSearchState(
    nsMsgKey key, JSContext* cx, JS::MutableHandle<JS::Value> result) {
  MOZ_TRY(RequireCommittedSearchRead());
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "SearchMessageState"_ns,
      "SELECT m.folderId, m.flags, f.flags, c.sequence, c.contentRevision, "
      "c.locationRevision, (SELECT COALESCE(MAX(sequence), 0) FROM "
      "message_changes "
      "WHERE messageId IS NULL), "
      "(SELECT value FROM message_properties WHERE id = m.id AND name = "
      "'storeToken'), "
      "(SELECT value FROM message_properties WHERE id = m.id AND name = "
      "'junkscore'), f.id "
      "FROM messages m LEFT JOIN folders f ON f.id = m.folderId JOIN "
      "message_changes c "
      "ON c.sequence = (SELECT MAX(sequence) FROM message_changes WHERE "
      "messageId = m.id) "
      "WHERE m.id = :id AND c.deleted = 0"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  if (!more) {
    bool exists;
    MOZ_TRY(MessageExists(key, exists));
    NS_ENSURE_TRUE(!exists, NS_ERROR_FILE_CORRUPTED);
    result.setNull();
    return NS_OK;
  }
  int64_t folder, flags, folderFlags = 0, sequence, content, location, policy;
  bool folderMissing;
  MOZ_TRY(stmt->GetInt64(0, &folder));
  MOZ_TRY(CheckFolderBodyAccess(static_cast<uint64_t>(folder)));
  MOZ_TRY(stmt->GetInt64(1, &flags));
  MOZ_TRY(stmt->GetIsNull(9, &folderMissing));
  if (!folderMissing) {
    MOZ_TRY(stmt->GetInt64(2, &folderFlags));
  }
  MOZ_TRY(stmt->GetInt64(3, &sequence));
  MOZ_TRY(stmt->GetInt64(4, &content));
  MOZ_TRY(stmt->GetInt64(5, &location));
  MOZ_TRY(stmt->GetInt64(6, &policy));
  NS_ENSURE_TRUE(folder > 0 && uint64_t(folder) <= kMaxSearchSequence &&
                     sequence > 0 && uint64_t(sequence) <= kMaxSearchSequence &&
                     content > 0 && content <= sequence && location > 0 &&
                     location <= sequence && policy >= 0 &&
                     uint64_t(policy) <= kMaxSearchSequence,
                 NS_ERROR_FILE_CORRUPTED);
  nsCString token, junk;
  MOZ_TRY(stmt->GetUTF8String(7, token));
  MOZ_TRY(stmt->GetUTF8String(8, junk));
  JS::Rooted<JSObject*> object(cx, JS_NewPlainObject(cx));
  NS_ENSURE_TRUE(object, NS_ERROR_OUT_OF_MEMORY);
  JS::Rooted<JS::Value> folderState(
      cx,
      folderMissing ? JS::NullValue() : JS::DoubleValue(uint32_t(folderFlags)));
  if (!JS_DefineProperty(cx, object, "messageKey", double(key),
                         JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, object, "folderId", double(folder),
                         JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, object, "flags", double(uint32_t(flags)),
                         JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, object, "folderFlags", folderState,
                         JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, object, "generation",
                         double(std::max(sequence, policy)),
                         JSPROP_ENUMERATE) ||
      !SearchRevision(cx, object, "metadataRevision", sequence) ||
      !SearchRevision(cx, object, "contentRevision", content) ||
      !SearchRevision(cx, object, "locationRevision", location) ||
      !SearchRevision(cx, object, "policyRevision", policy) ||
      !SearchText(cx, object, "storeToken", token) ||
      !SearchText(cx, object, "junkScore", junk)) {
    return NS_ERROR_FAILURE;
  }
  result.setObject(*object);
  return NS_OK;
}

namespace {

bool SameBodyGuard(const MessageBodyState& a, const MessageBodyState& b) {
  return a.databaseSourceId == b.databaseSourceId && a.key == b.key &&
         a.folderId == b.folderId && a.storeToken == b.storeToken &&
         a.contentRevision == b.contentRevision &&
         a.locationRevision == b.locationRevision &&
         a.messageSize == b.messageSize &&
         a.offlineMessageSize == b.offlineMessageSize &&
         a.lineCount == b.lineCount &&
         !((a.flags ^ b.flags) & nsMsgMessageFlags::Offline);
}

nsresult BodyFile(const nsAString& path, Maybe<uint64_t> size) {
  nsCOMPtr<nsIFile> file;
  MOZ_TRY(NS_NewLocalFile(path, getter_AddRefs(file)));
  bool exists;
  MOZ_TRY(file->Exists(&exists));
  NS_ENSURE_TRUE(exists == size.isSome(), NS_ERROR_NOT_AVAILABLE);
  if (exists) {
    bool regular, link;
    MOZ_TRY(file->IsFile(&regular));
    MOZ_TRY(file->IsSymlink(&link));
    NS_ENSURE_TRUE(regular && !link, NS_ERROR_NOT_AVAILABLE);
    int64_t actual;
    MOZ_TRY(file->GetFileSize(&actual));
    NS_ENSURE_TRUE(actual >= 0 && uint64_t(actual) == *size,
                   NS_ERROR_NOT_AVAILABLE);
  }
  return NS_OK;
}

nsresult RelocationFiles(const FolderBodyRelocation& plan,
                         Maybe<BodyRelocationOutcome> outcome = Nothing()) {
  NS_ENSURE_TRUE(
      !plan.originalPath.IsEmpty() && !plan.compactedPath.IsEmpty() &&
          !plan.backupPath.IsEmpty() &&
          plan.originalPath != plan.compactedPath &&
          plan.originalPath != plan.backupPath &&
          plan.compactedPath != plan.backupPath &&
          plan.originalSize <= INT64_MAX && plan.compactedSize <= INT64_MAX,
      NS_ERROR_INVALID_ARG);
  bool installed = outcome && *outcome == BodyRelocationOutcome::Installed;
  MOZ_TRY(BodyFile(plan.originalPath,
                   Some(installed ? plan.compactedSize : plan.originalSize)));
  MOZ_TRY(BodyFile(plan.compactedPath,
                   installed ? Nothing() : Some(plan.compactedSize)));
  return BodyFile(plan.backupPath,
                  installed ? Some(plan.originalSize) : Nothing());
}

nsresult RollbackBody(mozIStorageConnection* connection, nsresult original) {
  bool active;
  nsresult cleanup = connection->GetTransactionInProgress(&active);
  if (NS_SUCCEEDED(cleanup) && active) {
    cleanup = connection->RollbackTransaction();
  }
  if (NS_FAILED(cleanup)) {
    MOZ_LOG(gPanoramaLog, LogLevel::Error,
            ("Body relocation rollback failed: 0x%08x",
             static_cast<uint32_t>(cleanup)));
  }
  return original;
}

}  // namespace

nsresult MessageDatabase::CheckFolderBodyAccess(uint64_t folderId) {
  MOZ_TRY(RequireCommittedSearchRead());
  return CheckPendingFolderRelocation(folderId);
}

nsresult MessageDatabase::CheckPendingFolderRelocation(uint64_t folderId) {
  NS_ENSURE_TRUE(DatabaseCore::sInstance && DatabaseCore::sConnection &&
                     DatabaseCore::sInstance->mMessageDatabase.get() == this,
                 NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "CheckFolderBodyAccess"_ns,
      "SELECT 1 FROM body_relocations WHERE folderId=:folder AND state NOT IN(1,2)"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  return more ? NS_ERROR_IN_PROGRESS : NS_OK;
}

nsresult MessageDatabase::CheckMessageBodyAccess(nsMsgKey key) {
  MOZ_TRY(RequireCommittedSearchRead());
  return CheckPendingMessageRelocation(key);
}

nsresult MessageDatabase::CheckPendingMessageRelocation(nsMsgKey key) {
  NS_ENSURE_TRUE(DatabaseCore::sInstance && DatabaseCore::sConnection &&
                     DatabaseCore::sInstance->mMessageDatabase.get() == this,
                 NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "CheckMessageBodyAccess"_ns,
      "SELECT 1 FROM body_relocations WHERE state NOT IN(1,2) AND folderId IN "
      "(SELECT folderId FROM messages WHERE id=:id UNION SELECT folderId FROM staged_messages WHERE id=:id)"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  return more ? NS_ERROR_IN_PROGRESS : NS_OK;
}

nsresult MessageDatabase::GetBodyRelocation(
    uint64_t folderId, Maybe<FolderBodyRelocation>& output) {
  MOZ_TRY(RequireCommittedSearchRead());
  Maybe<FolderBodyRelocation> found;
  MOZ_TRY(ReadBodyRelocation(folderId, found));
  if (found) {
    nsCString source;
    MOZ_TRY(DatabaseCore::sInstance->GetSourceId(source));
    NS_ENSURE_TRUE(found->databaseSourceId == source, NS_ERROR_NOT_AVAILABLE);
  }
  output = std::move(found);
  return NS_OK;
}

nsresult MessageDatabase::ListPendingBodyRelocations(
    nsTArray<uint64_t>& output) {
  MOZ_TRY(RequireCommittedSearchRead());
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ListPendingBodyRelocations"_ns,
      "SELECT folderId FROM body_relocations WHERE state NOT IN(1,2) ORDER BY folderId"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  nsTArray<uint64_t> found;
  while (true) {
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (!more) {
      break;
    }
    int64_t folder;
    MOZ_TRY(stmt->GetInt64(0, &folder));
    NS_ENSURE_TRUE(folder > 0, NS_ERROR_FILE_CORRUPTED);
    found.AppendElement(folder);
  }
  output = std::move(found);
  return NS_OK;
}

nsresult MessageDatabase::ReadBodyRelocation(
    uint64_t folderId, Maybe<FolderBodyRelocation>& output) {
  FolderBodyRelocation plan;
  plan.folderId = folderId;
  int64_t count;
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "ReadBodyRelocation"_ns,
        "SELECT "
        "token,sourceId,original,compacted,backup,originalSize,compactedSize,"
        "state,messageCount "
        "FROM body_relocations WHERE folderId=:folder"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (!more) {
      output.reset();
      return NS_OK;
    }
    MOZ_TRY(stmt->GetUTF8String(0, plan.token));
    MOZ_TRY(stmt->GetUTF8String(1, plan.databaseSourceId));
    MOZ_TRY(stmt->GetString(2, plan.originalPath));
    MOZ_TRY(stmt->GetString(3, plan.compactedPath));
    MOZ_TRY(stmt->GetString(4, plan.backupPath));
    int64_t original, compacted, state;
    MOZ_TRY(stmt->GetInt64(5, &original));
    MOZ_TRY(stmt->GetInt64(6, &compacted));
    MOZ_TRY(stmt->GetInt64(7, &state));
    MOZ_TRY(stmt->GetInt64(8, &count));
    NS_ENSURE_TRUE(original >= 0 && compacted >= 0 && state >= 0 &&
                       state <= 2 && count >= 0 &&
                       uint64_t(count) <= UINT32_MAX && !plan.token.IsEmpty() &&
                       !plan.databaseSourceId.IsEmpty(),
                   NS_ERROR_FILE_CORRUPTED);
    plan.originalSize = original;
    plan.compactedSize = compacted;
    plan.state = static_cast<BodyRelocationState>(state);
  }
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ReadBodyRelocationRows"_ns,
      "SELECT "
      "id,oldToken,content,location,size,offlineSize,lines,flags,newToken,"
      "newSize,newOfflineSize,newLines,offline "
      "FROM body_relocation_rows WHERE folderId=:folder ORDER BY id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
  while (true) {
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (!more) {
      break;
    }
    RelocatedMessageBody* row = plan.messages.AppendElement();
    row->before.folderId = folderId;
    row->before.databaseSourceId = plan.databaseSourceId;
    int64_t value;
    MOZ_TRY(stmt->GetInt64(0, &value));
    NS_ENSURE_TRUE(value > 0 && value < nsMsgKey_None, NS_ERROR_FILE_CORRUPTED);
    row->before.key = value;
    for (auto pair :
         {std::pair{1, &row->before.storeToken}, {8, &row->storeToken}}) {
      bool absent;
      MOZ_TRY(stmt->GetIsNull(pair.first, &absent));
      if (!absent) {
        nsCString token;
        MOZ_TRY(stmt->GetUTF8String(pair.first, token));
        *pair.second = Some(std::move(token));
      }
    }
    MOZ_TRY(stmt->GetInt64(2, &value));
    NS_ENSURE_TRUE(value > 0, NS_ERROR_FILE_CORRUPTED);
    row->before.contentRevision = value;
    MOZ_TRY(stmt->GetInt64(3, &value));
    NS_ENSURE_TRUE(value > 0, NS_ERROR_FILE_CORRUPTED);
    row->before.locationRevision = value;
    for (auto pair : {std::pair{4, &row->before.messageSize},
                      {5, &row->before.offlineMessageSize},
                      {6, &row->before.lineCount},
                      {7, &row->before.flags},
                      {9, &row->messageSize},
                      {10, &row->offlineMessageSize},
                      {11, &row->lineCount}}) {
      MOZ_TRY(stmt->GetInt64(pair.first, &value));
      NS_ENSURE_TRUE(value >= 0 && uint64_t(value) <= UINT32_MAX,
                     NS_ERROR_FILE_CORRUPTED);
      *pair.second = static_cast<uint32_t>(value);
    }
    MOZ_TRY(stmt->GetInt64(12, &value));
    NS_ENSURE_TRUE(value == 0 || value == 1, NS_ERROR_FILE_CORRUPTED);
    row->offline = value;
  }
  NS_ENSURE_TRUE(plan.messages.Length() == uint64_t(count),
                 NS_ERROR_FILE_CORRUPTED);
  output = Some(std::move(plan));
  return NS_OK;
}

nsresult MessageDatabase::VerifyBodyRelocationRows(
    const FolderBodyRelocation& plan) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "VerifyBodyRelocationRows"_ns,
      "SELECT id FROM messages WHERE folderId=:folder ORDER BY id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folder"_ns, plan.folderId));
  uint32_t index = 0;
  while (true) {
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (!more) {
      break;
    }
    int64_t id;
    MOZ_TRY(stmt->GetInt64(0, &id));
    NS_ENSURE_TRUE(
        index < plan.messages.Length() && id == plan.messages[index].before.key,
        NS_ERROR_NOT_AVAILABLE);
    MessageBodyState current;
    MOZ_TRY(ReadMessageBodyState(static_cast<nsMsgKey>(id), current));
    NS_ENSURE_TRUE(current.folderId == plan.folderId &&
                       current.databaseSourceId == plan.databaseSourceId &&
                       SameBodyGuard(current, plan.messages[index].before),
                   NS_ERROR_NOT_AVAILABLE);
    ++index;
  }
  return index == plan.messages.Length() ? NS_OK : NS_ERROR_NOT_AVAILABLE;
}

nsresult MessageDatabase::PrepareBodyRelocation(
    const FolderBodyRelocation& input) {
  MOZ_TRY(RequireCommittedSearchRead());
  MOZ_TRY(CheckFolderBodyAccess(input.folderId));
  NS_ENSURE_TRUE(input.folderId && input.folderId <= INT64_MAX &&
                     !input.token.IsEmpty() && input.token.FindChar(0) < 0 &&
                     input.state == BodyRelocationState::Pending,
                 NS_ERROR_INVALID_ARG);
  nsCString source;
  MOZ_TRY(DatabaseCore::sInstance->GetSourceId(source));
  NS_ENSURE_TRUE(source == input.databaseSourceId, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(RelocationFiles(input));
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    {
      nsCOMPtr<mozIStorageStatement> folder;
      MOZ_TRY(DatabaseCore::GetStatement(
          "RelocationFolderExists"_ns,
          "SELECT 1 FROM folders WHERE id=:folder"_ns, getter_AddRefs(folder)));
      mozStorageStatementScoper scope(folder);
      MOZ_TRY(folder->BindInt64ByName("folder"_ns, input.folderId));
      bool exists;
      MOZ_TRY(folder->ExecuteStep(&exists));
      NS_ENSURE_TRUE(exists, NS_ERROR_NOT_AVAILABLE);
    }
    Maybe<FolderBodyRelocation> previous;
    MOZ_TRY(ReadBodyRelocation(input.folderId, previous));
    NS_ENSURE_TRUE(!previous || previous->state != BodyRelocationState::Pending,
                   NS_ERROR_IN_PROGRESS);
    NS_ENSURE_TRUE(!previous || previous->token != input.token,
                   NS_ERROR_ALREADY_INITIALIZED);
    {
      nsCOMPtr<mozIStorageStatement> staged;
      MOZ_TRY(DatabaseCore::GetStatement(
          "RelocationStagedOwners"_ns,
          "SELECT 1 FROM staged_messages WHERE folderId=:folder LIMIT 1"_ns,
          getter_AddRefs(staged)));
      mozStorageStatementScoper scope(staged);
      MOZ_TRY(staged->BindInt64ByName("folder"_ns, input.folderId));
      bool exists;
      MOZ_TRY(staged->ExecuteStep(&exists));
      NS_ENSURE_FALSE(exists, NS_ERROR_IN_PROGRESS);
    }
    MOZ_TRY(VerifyBodyRelocationRows(input));
    for (const auto* table : {"body_relocation_rows", "body_relocations"}) {
      nsAutoCString sql("DELETE FROM ");
      sql.Append(table);
      sql.AppendLiteral(" WHERE folderId=:folder");
      nsCOMPtr<mozIStorageStatement> stmt;
      nsAutoCString label("Replace_");
      label.Append(table);
      MOZ_TRY(DatabaseCore::GetStatement(label, sql, getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("folder"_ns, input.folderId));
      MOZ_TRY(stmt->Execute());
    }
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "PrepareBodyRelocation"_ns,
          "INSERT INTO body_relocations "
          "VALUES(:folder,:token,:source,:original,:compacted,:backup,"
          ":originalSize,:compactedSize,0,:count)"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("folder"_ns, input.folderId));
      MOZ_TRY(stmt->BindUTF8StringByName("token"_ns, input.token));
      MOZ_TRY(stmt->BindUTF8StringByName("source"_ns, input.databaseSourceId));
      MOZ_TRY(stmt->BindStringByName("original"_ns, input.originalPath));
      MOZ_TRY(stmt->BindStringByName("compacted"_ns, input.compactedPath));
      MOZ_TRY(stmt->BindStringByName("backup"_ns, input.backupPath));
      MOZ_TRY(stmt->BindInt64ByName("originalSize"_ns, input.originalSize));
      MOZ_TRY(stmt->BindInt64ByName("compactedSize"_ns, input.compactedSize));
      MOZ_TRY(stmt->BindInt64ByName("count"_ns, input.messages.Length()));
      MOZ_TRY(stmt->Execute());
    }
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "PrepareBodyRelocationRow"_ns,
        "INSERT INTO body_relocation_rows "
        "VALUES(:folder,:id,:oldToken,:content,:location,:size,"
        ":offlineSize,:lines,:flags,:newToken,:newSize,:newOfflineSize,:newLines,:offline)"_ns,
        getter_AddRefs(stmt)));
    for (const auto& row : input.messages) {
      NS_ENSURE_TRUE(row.storeToken || !row.offline, NS_ERROR_INVALID_ARG);
      MessageBodyState current;
      MOZ_TRY(ReadMessageBodyState(row.before.key, current));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("folder"_ns, input.folderId));
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, current.key));
      for (auto pair : {std::pair<const char*, const Maybe<nsCString>*>{
                            "oldToken", &current.storeToken},
                        {"newToken", &row.storeToken}}) {
        if (*pair.second) {
          MOZ_TRY(stmt->BindUTF8StringByName(nsDependentCString(pair.first),
                                             **pair.second));
        } else {
          MOZ_TRY(stmt->BindNullByName(nsDependentCString(pair.first)));
        }
      }
      for (auto pair : {std::pair{"content", current.contentRevision},
                        {"location", current.locationRevision},
                        {"size", uint64_t(current.messageSize)},
                        {"offlineSize", uint64_t(current.offlineMessageSize)},
                        {"lines", uint64_t(current.lineCount)},
                        {"flags", uint64_t(current.flags)},
                        {"newSize", uint64_t(row.messageSize)},
                        {"newOfflineSize", uint64_t(row.offlineMessageSize)},
                        {"newLines", uint64_t(row.lineCount)},
                        {"offline", uint64_t(row.offline)}}) {
        MOZ_TRY(
            stmt->BindInt64ByName(nsDependentCString(pair.first), pair.second));
      }
      MOZ_TRY(stmt->Execute());
    }
    MOZ_TRY(RelocationFiles(input));
    return connection->CommitTransaction();
  }();
  return NS_FAILED(rv) ? RollbackBody(connection, rv) : NS_OK;
}

nsresult MessageDatabase::SettleBodyRelocation(uint64_t folderId,
                                               const nsACString& token,
                                               BodyRelocationOutcome outcome) {
  NS_ENSURE_TRUE(outcome == BodyRelocationOutcome::Installed ||
                     outcome == BodyRelocationOutcome::Restored,
                 NS_ERROR_INVALID_ARG);
  MOZ_TRY(RequireCommittedSearchRead());
  Maybe<FolderBodyRelocation> found;
  MOZ_TRY(ReadBodyRelocation(folderId, found));
  NS_ENSURE_TRUE(found && found->token == token, NS_ERROR_NOT_AVAILABLE);
  auto desired = outcome == BodyRelocationOutcome::Installed
                     ? BodyRelocationState::Installed
                     : BodyRelocationState::Restored;
  if (found->state != BodyRelocationState::Pending) {
    return found->state == desired ? NS_OK : NS_ERROR_ALREADY_INITIALIZED;
  }
  nsCString source;
  MOZ_TRY(DatabaseCore::sInstance->GetSourceId(source));
  NS_ENSURE_TRUE(source == found->databaseSourceId, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(RelocationFiles(*found, Some(outcome)));
  RefPtr<MessageDatabase> self(this);
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  nsTArray<UniquePtr<CachedMsg>> prepared;
  nsTArray<RefPtr<DetachedMsgHdr>> oldHeaders;
  nsTArray<RefPtr<Message>> live;
  nsTArray<MessageBodyState> before, after;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    Maybe<FolderBodyRelocation> current;
    MOZ_TRY(ReadBodyRelocation(folderId, current));
    NS_ENSURE_TRUE(current && current->token == token &&
                       current->databaseSourceId == source &&
                       current->state == BodyRelocationState::Pending,
                   NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(VerifyBodyRelocationRows(*current));
    MOZ_TRY(RelocationFiles(*current, Some(outcome)));
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "ResolveBodyRelocation"_ns,
          "UPDATE body_relocations SET state=:state WHERE folderId=:folder"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("state"_ns, uint32_t(desired)));
      MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
      MOZ_TRY(stmt->Execute());
    }
    if (outcome == BodyRelocationOutcome::Installed) {
      for (const auto& row : current->messages) {
        MessageBodyState actual;
        MOZ_TRY(ReadMessageBodyState(row.before.key, actual));
        uint32_t flags = (actual.flags & ~nsMsgMessageFlags::Offline) |
                         (row.offline ? nsMsgMessageFlags::Offline : 0);
        if (actual.storeToken == row.storeToken &&
            actual.messageSize == row.messageSize &&
            actual.offlineMessageSize == row.offlineMessageSize &&
            actual.lineCount == row.lineCount && actual.flags == flags) {
          continue;
        }
        auto cached = MakeUnique<CachedMsg>();
        MOZ_TRY(FetchMsg(actual.key, *cached));
        RefPtr<DetachedMsgHdr> old = new DetachedMsgHdr(folderId);
        MOZ_TRY(old->SetMessageId(cached->messageId));
        MOZ_TRY(old->SetAuthor(cached->sender));
        MOZ_TRY(old->SetRecipients(cached->recipients));
        MOZ_TRY(old->SetSubject(cached->subject));
        MOZ_TRY(old->SetFlags(actual.flags));
        MOZ_TRY(old->SetDate(cached->date));
        MOZ_TRY(old->SetThreadId(cached->threadId));
        MOZ_TRY(old->SetStringProperty("keywords", cached->tags));
        if (actual.storeToken) {
          MOZ_TRY(old->SetStoreToken(*actual.storeToken));
        }
        MOZ_TRY(old->SetMessageSize(actual.messageSize));
        MOZ_TRY(old->SetOfflineMessageSize(actual.offlineMessageSize));
        MOZ_TRY(old->SetLineCount(actual.lineCount));
        {
          nsCOMPtr<mozIStorageStatement> stmt;
          MOZ_TRY(DatabaseCore::GetStatement(
              "RelocateBodyFields"_ns,
              "INSERT INTO message_properties(id,name,value) VALUES "
              "(:id,'messageSize',:size),"
              "(:id,'offlineMessageSize',:offlineSize),(:id,'lineCount',:lines)"
              " "
              "ON CONFLICT(id,name) DO UPDATE SET value=excluded.value"_ns,
              getter_AddRefs(stmt)));
          mozStorageStatementScoper scope(stmt);
          MOZ_TRY(stmt->BindInt64ByName("id"_ns, actual.key));
          MOZ_TRY(stmt->BindInt64ByName("size"_ns, row.messageSize));
          MOZ_TRY(
              stmt->BindInt64ByName("offlineSize"_ns, row.offlineMessageSize));
          MOZ_TRY(stmt->BindInt64ByName("lines"_ns, row.lineCount));
          MOZ_TRY(stmt->Execute());
        }
        if (row.storeToken) {
          MOZ_TRY(
              SetMessageProperty(actual.key, "storeToken"_ns, *row.storeToken));
        } else {
          nsCOMPtr<mozIStorageStatement> stmt;
          MOZ_TRY(DatabaseCore::GetStatement(
              "ForgetRelocatedBodyToken"_ns,
              "DELETE FROM message_properties WHERE id=:id AND name='storeToken'"_ns,
              getter_AddRefs(stmt)));
          mozStorageStatementScoper scope(stmt);
          MOZ_TRY(stmt->BindInt64ByName("id"_ns, actual.key));
          MOZ_TRY(stmt->Execute());
        }
        {
          nsCOMPtr<mozIStorageStatement> stmt;
          MOZ_TRY(DatabaseCore::GetStatement(
              "RelocateBodyFlags"_ns,
              "UPDATE messages SET flags=:flags WHERE id=:id"_ns,
              getter_AddRefs(stmt)));
          mozStorageStatementScoper scope(stmt);
          MOZ_TRY(stmt->BindInt64ByName("id"_ns, actual.key));
          MOZ_TRY(stmt->BindInt64ByName("flags"_ns, flags));
          MOZ_TRY(stmt->Execute());
        }
        MessageBodyState settled;
        MOZ_TRY(ReadMessageBodyState(actual.key, settled));
        cached->flags = flags;
        before.AppendElement(std::move(actual));
        after.AppendElement(std::move(settled));
        oldHeaders.AppendElement(old);
        live.AppendElement(new Message(cached->key));
        prepared.AppendElement(std::move(cached));
      }
    }
    if (!mMsgCache.reserve(mMsgCache.count() + prepared.Length())) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    return RollbackBody(connection, rv);
  }
  for (auto& cached : prepared) {
    auto entry = mMsgCache.lookup(cached->key);
    if (entry) {
      entry->value() = std::move(*cached);
    } else {
      mMsgCache.putNewInfallible(cached->key, std::move(*cached));
    }
  }
  for (uint32_t i = 0; i < live.Length(); ++i) {
    for (MessageListener* listener : mMessageListeners.EndLimitedRange()) {
      listener->OnMessageBodyChanged(oldHeaders[i], live[i], before[i],
                                     after[i]);
    }
  }
  return NS_OK;
}

nsresult MessageDatabase::GetMessageBodyState(nsMsgKey key,
                                              MessageBodyState& output) {
  MOZ_TRY(RequireCommittedSearchRead());
  MOZ_TRY(CheckMessageBodyAccess(key));
  return ReadMessageBodyState(key, output);
}

nsresult MessageDatabase::ReadMessageBodyState(nsMsgKey key,
                                               MessageBodyState& output) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "MessageBodyState"_ns,
      "SELECT m.folderId, p.id, p.value, c.contentRevision, "
      "c.locationRevision, "
      "m.flags, "
      "(SELECT value FROM message_properties WHERE id = m.id AND name = "
      "'messageSize'), "
      "(SELECT value FROM message_properties WHERE id = m.id AND name = "
      "'offlineMessageSize'), "
      "(SELECT value FROM message_properties WHERE id = m.id AND name = "
      "'lineCount'), d.sourceId "
      "FROM messages m LEFT JOIN message_properties p "
      "ON p.id = m.id AND p.name = 'storeToken' JOIN message_changes c "
      "ON c.sequence = (SELECT MAX(sequence) FROM message_changes "
      "WHERE messageId = m.id) JOIN database_identity d ON d.singleton = 1 "
      "WHERE m.id = :id AND c.deleted = 0"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  if (!more) {
    bool exists;
    MOZ_TRY(MessageExists(key, exists));
    NS_ENSURE_TRUE(!exists, NS_ERROR_FILE_CORRUPTED);
    return NS_ERROR_NOT_AVAILABLE;
  }
  int64_t folder, content, location;
  MOZ_TRY(stmt->GetInt64(0, &folder));
  MOZ_TRY(stmt->GetInt64(3, &content));
  MOZ_TRY(stmt->GetInt64(4, &location));
  NS_ENSURE_TRUE(folder > 0 && content > 0 && location > 0,
                 NS_ERROR_FILE_CORRUPTED);
  MessageBodyState state;
  MOZ_TRY(stmt->GetUTF8String(9, state.databaseSourceId));
  NS_ENSURE_TRUE(!state.databaseSourceId.IsEmpty(), NS_ERROR_FILE_CORRUPTED);
  state.key = key;
  state.folderId = static_cast<uint64_t>(folder);
  state.contentRevision = static_cast<uint64_t>(content);
  state.locationRevision = static_cast<uint64_t>(location);
  int64_t flags, size, offlineSize, lines;
  MOZ_TRY(stmt->GetInt64(5, &flags));
  MOZ_TRY(stmt->GetInt64(6, &size));
  MOZ_TRY(stmt->GetInt64(7, &offlineSize));
  MOZ_TRY(stmt->GetInt64(8, &lines));
  state.flags = static_cast<uint32_t>(flags);
  state.messageSize = static_cast<uint32_t>(size);
  state.offlineMessageSize = static_cast<uint32_t>(offlineSize);
  state.lineCount = static_cast<uint32_t>(lines);
  bool tokenAbsent;
  MOZ_TRY(stmt->GetIsNull(1, &tokenAbsent));
  if (!tokenAbsent) {
    nsCString token;
    MOZ_TRY(stmt->GetUTF8String(2, token));
    state.storeToken = Some(std::move(token));
  }
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  output = std::move(state);
  return NS_OK;
}

nsresult MessageDatabase::SettleMessageBody(const MessageBodyState& expected,
                                            const FinishedMessageBody& finished,
                                            MessageBodyState& output) {
  MOZ_TRY(RequireCommittedSearchRead());
  MOZ_TRY(CheckMessageBodyAccess(expected.key));
  RefPtr<MessageDatabase> self(this);
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MessageBodyState before, after, callerResult;
  CachedMsg cached;
  RefPtr<DetachedMsgHdr> oldMessage;
  RefPtr<Message> message;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    MOZ_TRY(ReadMessageBodyState(expected.key, before));
    NS_ENSURE_TRUE(
        before.databaseSourceId == expected.databaseSourceId &&
            before.folderId == expected.folderId &&
            before.storeToken == expected.storeToken &&
            before.contentRevision == expected.contentRevision &&
            before.locationRevision == expected.locationRevision &&
            before.messageSize == expected.messageSize &&
            before.offlineMessageSize == expected.offlineMessageSize &&
            before.lineCount == expected.lineCount &&
            !((before.flags ^ expected.flags) & nsMsgMessageFlags::Offline),
        NS_ERROR_NOT_AVAILABLE);
    {
      nsCOMPtr<mozIStorageStatement> folder;
      MOZ_TRY(DatabaseCore::GetStatement(
          "BodySettlementFolder"_ns, "SELECT 1 FROM folders WHERE id = :id"_ns,
          getter_AddRefs(folder)));
      mozStorageStatementScoper scoper(folder);
      MOZ_TRY(folder->BindInt64ByName("id"_ns, expected.folderId));
      bool exists;
      MOZ_TRY(folder->ExecuteStep(&exists));
      NS_ENSURE_TRUE(exists, NS_ERROR_NOT_AVAILABLE);
    }
    MOZ_TRY(FetchMsg(expected.key, cached));
    oldMessage = new DetachedMsgHdr(before.folderId);
    MOZ_TRY(oldMessage->SetMessageId(cached.messageId));
    MOZ_TRY(oldMessage->SetAuthor(cached.sender));
    MOZ_TRY(oldMessage->SetRecipients(cached.recipients));
    MOZ_TRY(oldMessage->SetSubject(cached.subject));
    MOZ_TRY(oldMessage->SetDate(cached.date));
    MOZ_TRY(oldMessage->SetThreadId(cached.threadId));
    MOZ_TRY(oldMessage->SetFlags(before.flags));
    MOZ_TRY(oldMessage->SetStringProperty("keywords", cached.tags));
    if (before.storeToken) {
      MOZ_TRY(oldMessage->SetStoreToken(*before.storeToken));
    }
    MOZ_TRY(oldMessage->SetMessageSize(before.messageSize));
    MOZ_TRY(oldMessage->SetOfflineMessageSize(before.offlineMessageSize));
    MOZ_TRY(oldMessage->SetLineCount(before.lineCount));
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "SettleMessageBodyProperties"_ns,
          "INSERT INTO message_properties(id, name, value) VALUES "
          "(:id, 'storeToken', :token), (:id, 'messageSize', :size), "
          "(:id, 'offlineMessageSize', :offlineSize), (:id, 'lineCount', "
          ":lines) "
          "ON CONFLICT(id, name) DO UPDATE SET value = excluded.value"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, expected.key));
      MOZ_TRY(stmt->BindUTF8StringByName("token"_ns, finished.storeToken));
      MOZ_TRY(stmt->BindInt64ByName("size"_ns, finished.messageSize));
      MOZ_TRY(
          stmt->BindInt64ByName("offlineSize"_ns, finished.offlineMessageSize));
      MOZ_TRY(stmt->BindInt64ByName("lines"_ns, finished.lineCount));
      MOZ_TRY(stmt->Execute());
    }
    cached.flags = (before.flags & ~nsMsgMessageFlags::Offline) |
                   (finished.offline ? nsMsgMessageFlags::Offline : 0);
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "SettleMessageBodyFlags"_ns,
          "UPDATE messages SET flags = :flags WHERE id = :id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, expected.key));
      MOZ_TRY(stmt->BindInt64ByName("flags"_ns, cached.flags));
      MOZ_TRY(stmt->Execute());
    }
    MOZ_TRY(ReadMessageBodyState(expected.key, after));
    callerResult = after;
    if (!mMsgCache.reserve(mMsgCache.count() + 1)) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
    message = new Message(expected.key);
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    bool active;
    nsresult cleanup = connection->GetTransactionInProgress(&active);
    if (NS_SUCCEEDED(cleanup) && active) {
      cleanup = connection->RollbackTransaction();
    }
    if (NS_FAILED(cleanup)) {
      MOZ_LOG(gPanoramaLog, LogLevel::Error,
              ("Body settlement rollback failed: 0x%08x",
               static_cast<uint32_t>(cleanup)));
    }
    return rv;
  }
  auto entry = mMsgCache.lookup(expected.key);
  if (entry) {
    entry->value() = std::move(cached);
  } else {
    mMsgCache.putNewInfallible(expected.key, std::move(cached));
  }
  output = std::move(callerResult);
  for (MessageListener* listener : mMessageListeners.EndLimitedRange()) {
    listener->OnMessageBodyChanged(oldMessage, message, before, after);
  }
  return NS_OK;
}

NS_IMETHODIMP MessageDatabase::GetSearchChanges(
    uint64_t after, uint32_t limit, JSContext* cx,
    JS::MutableHandle<JS::Value> result) {
  NS_ENSURE_ARG(limit > 0 && limit <= 1000 && after <= kMaxSearchSequence);
  uint64_t watermark;
  MOZ_TRY(GetSearchWatermark(watermark));
  NS_ENSURE_TRUE(after <= watermark, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "SearchChanges"_ns,
      "SELECT sequence, messageId, contentRevision, locationRevision, deleted "
      "FROM message_changes WHERE sequence > :after AND sequence <= :watermark "
      "ORDER BY sequence LIMIT :limit"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("after"_ns, after));
  MOZ_TRY(stmt->BindInt64ByName("watermark"_ns, watermark));
  MOZ_TRY(stmt->BindInt64ByName("limit"_ns, limit));
  JS::Rooted<JSObject*> changes(cx, JS::NewArrayObject(cx, 0));
  NS_ENSURE_TRUE(changes, NS_ERROR_OUT_OF_MEMORY);
  uint32_t count = 0;
  uint64_t next = after;
  while (true) {
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (!more) {
      break;
    }
    int64_t sequence, id = 0, content, location, deleted;
    bool policy;
    MOZ_TRY(stmt->GetInt64(0, &sequence));
    MOZ_TRY(stmt->GetIsNull(1, &policy));
    if (!policy) {
      MOZ_TRY(stmt->GetInt64(1, &id));
    }
    MOZ_TRY(stmt->GetInt64(2, &content));
    MOZ_TRY(stmt->GetInt64(3, &location));
    MOZ_TRY(stmt->GetInt64(4, &deleted));
    NS_ENSURE_TRUE(sequence > 0 && uint64_t(sequence) <= watermark &&
                       (policy || (id > 0 && id < nsMsgKey_None)) &&
                       content >= 0 && content <= sequence && location >= 0 &&
                       location <= sequence && (deleted == 0 || deleted == 1),
                   NS_ERROR_FILE_CORRUPTED);
    JS::Rooted<JSObject*> row(cx, JS_NewPlainObject(cx));
    NS_ENSURE_TRUE(row, NS_ERROR_OUT_OF_MEMORY);
    JS::Rooted<JS::Value> key(cx,
                              policy ? JS::NullValue() : JS::DoubleValue(id));
    JS::Rooted<JS::Value> removed(cx, JS::BooleanValue(deleted != 0));
    if (!JS_DefineProperty(cx, row, "sequence", double(sequence),
                           JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, row, "messageKey", key, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, row, "deleted", removed, JSPROP_ENUMERATE) ||
        !SearchRevision(cx, row, "contentRevision", content) ||
        !SearchRevision(cx, row, "locationRevision", location)) {
      return NS_ERROR_FAILURE;
    }
    JS::Rooted<JS::Value> value(cx, JS::ObjectValue(*row));
    if (!JS_DefineElement(cx, changes, count++, value, JSPROP_ENUMERATE)) {
      return NS_ERROR_FAILURE;
    }
    next = sequence;
  }
  JS::Rooted<JSObject*> object(cx, JS_NewPlainObject(cx));
  NS_ENSURE_TRUE(object, NS_ERROR_OUT_OF_MEMORY);
  JS::Rooted<JS::Value> rows(cx, JS::ObjectValue(*changes));
  if (!JS_DefineProperty(cx, object, "watermark", double(watermark),
                         JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, object, "nextSequence", double(next),
                         JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, object, "changes", rows, JSPROP_ENUMERATE)) {
    return NS_ERROR_FAILURE;
  }
  result.setObject(*object);
  return NS_OK;
}

NS_IMETHODIMP MessageDatabase::GetSearchSnapshot(
    nsMsgKey after, uint32_t limit, JSContext* cx,
    JS::MutableHandle<JS::Value> result) {
  NS_ENSURE_ARG(limit > 0 && limit <= 1000 && after != nsMsgKey_None);
  uint64_t watermark;
  MOZ_TRY(GetSearchWatermark(watermark));
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "SearchSnapshotKeys"_ns,
      "SELECT id FROM messages WHERE id > :after ORDER BY id LIMIT :limit"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("after"_ns, after));
  MOZ_TRY(stmt->BindInt64ByName("limit"_ns, limit));
  JS::Rooted<JSObject*> messages(cx, JS::NewArrayObject(cx, 0));
  NS_ENSURE_TRUE(messages, NS_ERROR_OUT_OF_MEMORY);
  uint32_t count = 0;
  nsMsgKey next = after;
  while (true) {
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (!more) {
      break;
    }
    int64_t id;
    MOZ_TRY(stmt->GetInt64(0, &id));
    NS_ENSURE_TRUE(id > 0 && id < nsMsgKey_None, NS_ERROR_FILE_CORRUPTED);
    JS::Rooted<JS::Value> state(cx);
    MOZ_TRY(GetSearchState(static_cast<nsMsgKey>(id), cx, &state));
    NS_ENSURE_TRUE(state.isObject(), NS_ERROR_FILE_CORRUPTED);
    if (!JS_DefineElement(cx, messages, count++, state, JSPROP_ENUMERATE)) {
      return NS_ERROR_FAILURE;
    }
    next = id;
  }
  JS::Rooted<JSObject*> object(cx, JS_NewPlainObject(cx));
  NS_ENSURE_TRUE(object, NS_ERROR_OUT_OF_MEMORY);
  JS::Rooted<JS::Value> rows(cx, JS::ObjectValue(*messages));
  if (!JS_DefineProperty(cx, object, "watermark", double(watermark),
                         JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, object, "nextKey", double(next),
                         JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, object, "messages", rows, JSPROP_ENUMERATE)) {
    return NS_ERROR_FAILURE;
  }
  result.setObject(*object);
  return NS_OK;
}

NS_IMETHODIMP MessageDatabase::NoteMessageContentChanged(nsMsgKey key) {
  MOZ_TRY(RequireCommittedSearchRead());
  MOZ_TRY(CheckMessageBodyAccess(key));
  bool exists;
  MOZ_TRY(MessageExists(key, exists));
  NS_ENSURE_TRUE(exists, NS_ERROR_UNEXPECTED);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "RecordMessageContentChange"_ns,
      "INSERT INTO message_changes(messageId, contentRevision, "
      "locationRevision, deleted) "
      "SELECT :id, contentRevision + 1, locationRevision, 0 FROM "
      "message_changes "
      "WHERE messageId = :id ORDER BY sequence DESC LIMIT 1 RETURNING sequence"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(!more, NS_ERROR_FILE_CORRUPTED);
  return NS_OK;
}

NS_IMETHODIMP MessageDatabase::NoteSearchPolicyChanged() {
  MOZ_TRY(RequireCommittedSearchRead());
  return DatabaseCore::sConnection->ExecuteSimpleSQL(
      "INSERT INTO message_changes(messageId, contentRevision, "
      "locationRevision, deleted) "
      "VALUES(NULL, 0, 0, 0)"_ns);
}

NS_IMETHODIMP MessageDatabase::GetTotalCount(uint64_t* totalCount) {
  NS_ENSURE_ARG_POINTER(totalCount);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement("TotalCount"_ns,
                                     "SELECT COUNT(*) FROM messages"_ns,
                                     getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
  int64_t count;
  MOZ_TRY(stmt->GetInt64(0, &count));
  NS_ENSURE_TRUE(count >= 0, NS_ERROR_FILE_CORRUPTED);
  *totalCount = count;
  return NS_OK;
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

nsresult MessageDatabase::AddMessage(uint64_t folderId, const ::RawHdr& header,
                                     bool notifyLegacy, nsMsgKey* key,
                                     Message** liveHeader) {
  return InsertMessage(folderId, header, false, notifyLegacy, key, liveHeader);
}

nsresult MessageDatabase::StageMessage(uint64_t folderId,
                                       const ::RawHdr& header, nsMsgKey* key,
                                       Message** liveHeader) {
  return InsertMessage(folderId, header, true, false, key, liveHeader);
}

nsresult MessageDatabase::InsertMessage(uint64_t aFolderId,
                                        const ::RawHdr& header, bool staged,
                                        bool notifyLegacy, nsMsgKey* aKey,
                                        Message** liveHeader) {
  NS_ENSURE_ARG_POINTER(aKey);
  if (staged) {
    NS_ENSURE_TRUE(aFolderId && aFolderId <= INT64_MAX, NS_ERROR_INVALID_ARG);
  }
  MOZ_TRY(DatabaseCore::EnsureConnection());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool inTransaction;
  MOZ_TRY(connection->GetTransactionInProgress(&inTransaction));
  if (inTransaction) {
    return NS_ERROR_IN_PROGRESS;
  }

  MOZ_TRY(CheckFolderBodyAccess(aFolderId));

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
    if (staged) {
      nsCOMPtr<mozIStorageStatement> folder;
      MOZ_TRY(DatabaseCore::GetStatement(
          "RequireHeaderFolder"_ns, "SELECT 1 FROM folders WHERE id = :id"_ns,
          getter_AddRefs(folder)));
      mozStorageStatementScoper scoper(folder);
      MOZ_TRY(folder->BindInt64ByName("id"_ns, aFolderId));
      bool exists;
      MOZ_TRY(folder->ExecuteStep(&exists));
      NS_ENSURE_TRUE(exists, NS_ERROR_NOT_AVAILABLE);
    }
    nsMsgKey allocated;
    MOZ_TRY(DatabaseCore::GetNextMessageKey(allocated));
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
      nsAutoCString sql((staged ? "INSERT INTO staged_messages ( "_ns
                                : "INSERT INTO messages ( "_ns) +
                        " \
             id, folderId, threadId, threadParent, messageId, date, sender, recipients, ccList, bccList, subject, flags, tags, priority \
           ) VALUES ( \
             :id, :folderId, :threadId, :threadParent, :messageId, :date, :sender, :recipients, :ccList, :bccList, :subject, :flags, :tags, :priority \
           ) RETURNING "_ns MESSAGE_SQL_FIELDS);
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          staged ? "StageNativeMessage"_ns : "AddNativeMessage"_ns, sql,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);

      MOZ_TRY(stmt->BindInt64ByName("id"_ns, allocated));
      MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, aFolderId));
      MOZ_TRY(stmt->BindInt64ByName("threadId"_ns, threadId));
      MOZ_TRY(stmt->BindInt64ByName("threadParent"_ns, parentId));
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
      int64_t storedKey;
      MOZ_TRY(stmt->GetInt64(0, &storedKey));
      NS_ENSURE_TRUE(storedKey == allocated, NS_ERROR_FILE_CORRUPTED);
      cached.key = allocated;
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

    if (staged) {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "ReserveStagedKey"_ns,
          "UPDATE message_key_allocator SET highWater = :id WHERE singleton = 1"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, allocated));
      MOZ_TRY(stmt->Execute());
    }

    // The root's key was unavailable until the insert completed.
    if (cached.threadId == 0) {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(GetHeaderStatement(
          cached.key, "SetThreadIdToId"_ns, HeaderTable::Messages, "UPDATE "_ns,
          " SET threadId = id WHERE id = :id"_ns, getter_AddRefs(stmt)));
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
  if (!staged) {
    for (MessageListener* listener : mMessageListeners.EndLimitedRange()) {
      listener->OnMessagePublished(message, notifyLegacy);
    }
  }
  return NS_OK;
}

nsresult MessageDatabase::IsMessageStaged(nsMsgKey key, bool& staged) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "IsMessageStaged"_ns, "SELECT 1 FROM staged_messages WHERE id = :id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
  bool found;
  MOZ_TRY(stmt->ExecuteStep(&found));
  staged = found;
  return NS_OK;
}

nsresult MessageDatabase::GetHeaderStatement(
    nsMsgKey key, const nsACString& label, HeaderTable table,
    const nsACString& prefix, const nsACString& suffix,
    mozIStorageStatement** statement, bool* staged) {
  bool pending;
  MOZ_TRY(IsMessageStaged(key, pending));
  if (!StringBeginsWith(prefix, "SELECT"_ns)) {
    MOZ_TRY(CheckPendingMessageRelocation(key));
  }
  const char* name = nullptr;
  switch (table) {
    case HeaderTable::Messages:
      name = pending ? "staged_messages" : "messages";
      break;
    case HeaderTable::Properties:
      name = pending ? "staged_message_properties" : "message_properties";
      break;
    case HeaderTable::References:
      name = pending ? "staged_message_references" : "message_references";
      break;
    case HeaderTable::ReferenceSets:
      name =
          pending ? "staged_message_reference_sets" : "message_reference_sets";
      break;
  }
  NS_ENSURE_TRUE(name, NS_ERROR_INVALID_ARG);
  nsAutoCString statementLabel(label);
  if (pending) {
    statementLabel.AppendLiteral("_staged");
  }
  nsAutoCString sql(prefix);
  sql.Append(name);
  sql.Append(suffix);
  MOZ_TRY(DatabaseCore::GetStatement(statementLabel, sql, statement));
  if (staged) {
    *staged = pending;
  }
  return NS_OK;
}

nsresult MessageDatabase::ListStagedMessages(uint64_t folderId,
                                             nsTArray<nsMsgKey>& keys) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ListStagedMessages"_ns,
      "SELECT id FROM staged_messages WHERE folderId = :folderId ORDER BY id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, folderId));
  nsTArray<nsMsgKey> found;
  bool more;
  while (true) {
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (!more) {
      break;
    }
    int64_t key;
    MOZ_TRY(stmt->GetInt64(0, &key));
    NS_ENSURE_TRUE(key > 0 && key < nsMsgKey_None, NS_ERROR_FILE_CORRUPTED);
    found.AppendElement(static_cast<nsMsgKey>(key));
  }
  keys = std::move(found);
  return NS_OK;
}

nsresult MessageDatabase::AbortMessage(nsMsgKey key) {
  MOZ_TRY(DatabaseCore::EnsureConnection());
  {
    nsCOMPtr<mozIStorageStatement> attempt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "StagedIdentityInFlight"_ns,
        "SELECT 1 FROM offline_attempts WHERE (destinationKey = :key OR "
        "sourceKey = :key) "
        "AND state IN (1,3) LIMIT 1"_ns,
        getter_AddRefs(attempt)));
    mozStorageStatementScoper scoper(attempt);
    MOZ_TRY(attempt->BindInt64ByName("key"_ns, key));
    bool active;
    MOZ_TRY(attempt->ExecuteStep(&active));
    NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  }
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "AbortStagedMessage"_ns,
      "DELETE FROM staged_messages WHERE id = :id RETURNING id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_FALSE(more, NS_ERROR_UNEXPECTED);
  mMsgCache.remove(key);
  return NS_OK;
}

nsresult MessageDatabase::PublishMessage(nsMsgKey key, bool notifyLegacy,
                                         Message** liveHeader) {
  MOZ_TRY(DatabaseCore::EnsureConnection());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool active;
  MOZ_TRY(connection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  CachedMsg cached;
  RefPtr<Message> message;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    bool staged;
    MOZ_TRY(IsMessageStaged(key, staged));
    NS_ENSURE_TRUE(staged, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(FetchMsg(key, cached));
    nsTArray<nsCString> references;
    MOZ_TRY(GetMessageReferences(key, references));
    cached.threadId = key;
    cached.threadParent = 0;
    if (!references.IsEmpty()) {
      nsMsgKey root = MOZ_TRY(FindByMessageId(references[0]));
      if (root) {
        cached.threadId = root;
      }
      cached.threadParent = MOZ_TRY(FindByMessageId(references.LastElement()));
    }
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "PublishStagedMessage"_ns,
          "INSERT INTO messages ("_ns MESSAGE_SQL_FIELDS
          ") SELECT "
          "s.id, s.folderId, :threadId, :parent, s.messageId, s.date, "
          "s.sender, "
          "s.recipients, s.ccList, s.bccList, s.subject, s.flags, s.tags, "
          "s.priority "
          "FROM staged_messages s JOIN folders f ON f.id = s.folderId "
          "WHERE s.id = :id RETURNING id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
      MOZ_TRY(stmt->BindInt64ByName("threadId"_ns, cached.threadId));
      MOZ_TRY(stmt->BindInt64ByName("parent"_ns, cached.threadParent));
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_TRUE(more, NS_ERROR_UNEXPECTED);
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_FALSE(more, NS_ERROR_UNEXPECTED);
    }
    // The staged row remains until all children have been copied successfully.
    for (const auto& table : {"message_properties", "message_reference_sets",
                              "message_references"}) {
      nsAutoCString sql("INSERT INTO ");
      sql.Append(table);
      sql.AppendLiteral(" SELECT * FROM staged_");
      sql.Append(table);
      sql.AppendLiteral(" WHERE id = ");
      sql.AppendInt(key);
      MOZ_TRY(connection->ExecuteSimpleSQL(sql));
    }
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "ConsumeStagedMessage"_ns,
          "DELETE FROM staged_messages WHERE id = :id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
      MOZ_TRY(stmt->Execute());
    }
    if (!mMsgCache.reserve(mMsgCache.count() + 1)) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
    message = new Message(key);
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    nsresult cleanupRv = connection->GetTransactionInProgress(&active);
    if (NS_SUCCEEDED(cleanupRv) && active) {
      cleanupRv = connection->RollbackTransaction();
    }
    if (NS_FAILED(cleanupRv)) {
      MOZ_LOG(gPanoramaLog, LogLevel::Error,
              ("Publication cleanup failed: 0x%08x",
               static_cast<uint32_t>(cleanupRv)));
    }
    return rv;
  }
  auto entry = mMsgCache.lookup(key);
  if (entry) {
    entry->value() = std::move(cached);
  } else {
    mMsgCache.putNewInfallible(key, std::move(cached));
  }
  if (liveHeader) {
    RefPtr<Message> result = message;
    result.forget(liveHeader);
  }
  for (MessageListener* listener : mMessageListeners.EndLimitedRange()) {
    listener->OnMessagePublished(message, notifyLegacy);
  }
  return NS_OK;
}

namespace {

using OfflineOp = nsIMsgOfflineImapOperation;

nsresult OfflineUint32(mozIStorageStatement* stmt, uint32_t column,
                       uint32_t& output) {
  int32_t type;
  MOZ_TRY(stmt->GetTypeOfIndex(column, &type));
  NS_ENSURE_TRUE(type == mozIStorageValueArray::VALUE_TYPE_INTEGER,
                 NS_ERROR_FILE_CORRUPTED);
  int64_t value;
  MOZ_TRY(stmt->GetInt64(column, &value));
  NS_ENSURE_TRUE(value >= 0 && value <= UINT32_MAX, NS_ERROR_FILE_CORRUPTED);
  output = static_cast<uint32_t>(value);
  return NS_OK;
}

nsresult FinishOfflineWrite(mozIStorageConnection* connection, nsresult rv) {
  if (NS_FAILED(rv)) {
    bool active;
    nsresult cleanup = connection->GetTransactionInProgress(&active);
    if (NS_SUCCEEDED(cleanup) && active) {
      cleanup = connection->RollbackTransaction();
    }
    if (NS_FAILED(cleanup)) {
      MOZ_LOG(gPanoramaLog, LogLevel::Error,
              ("Offline operation rollback failed: 0x%08x",
               static_cast<uint32_t>(cleanup)));
    }
  }
  return rv;
}

}  // namespace

nsresult MessageDatabase::ReadOfflineOperationIdentity(
    uint64_t folderId, nsMsgKey key, int64_t& id, int64_t& revision,
    Maybe<ServerMessageLocation>& source, Maybe<uint32_t>* folderEpoch) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "OfflineOperationIdentity"_ns,
      "SELECT id, revision, epoch, uid, folderEpoch FROM offline_operations "
      "WHERE folderId = :folder AND messageKey = :key"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
  MOZ_TRY(stmt->BindInt64ByName("key"_ns, key));
  bool more, epochNull, uidNull;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
  int64_t foundId, foundRevision;
  MOZ_TRY(stmt->GetInt64(0, &foundId));
  MOZ_TRY(stmt->GetInt64(1, &foundRevision));
  NS_ENSURE_TRUE(foundId > 0 && foundRevision > 0, NS_ERROR_FILE_CORRUPTED);
  MOZ_TRY(stmt->GetIsNull(2, &epochNull));
  MOZ_TRY(stmt->GetIsNull(3, &uidNull));
  NS_ENSURE_TRUE(epochNull == uidNull, NS_ERROR_FILE_CORRUPTED);
  Maybe<ServerMessageLocation> target;
  if (!epochNull) {
    ServerMessageLocation location{folderId, key};
    MOZ_TRY(OfflineUint32(stmt, 2, location.epoch));
    MOZ_TRY(OfflineUint32(stmt, 3, location.uid));
    target = Some(location);
  }
  Maybe<uint32_t> scopeEpoch;
  bool scopeNull;
  MOZ_TRY(stmt->GetIsNull(4, &scopeNull));
  if (!scopeNull) {
    uint32_t epoch;
    MOZ_TRY(OfflineUint32(stmt, 4, epoch));
    scopeEpoch = Some(epoch);
  }
  if (folderEpoch) {
    *folderEpoch = scopeEpoch;
  }
  id = foundId;
  revision = foundRevision;
  source = target;
  return NS_OK;
}

nsresult MessageDatabase::RequireOfflineOperationMutable(int64_t id) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "OfflineOperationInFlight"_ns,
      "SELECT 1 FROM offline_attempts WHERE operationId = :id "
      "AND state IN (1,3) LIMIT 1"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, id));
  bool active;
  MOZ_TRY(stmt->ExecuteStep(&active));
  return active ? NS_ERROR_IN_PROGRESS : NS_OK;
}

nsresult MessageDatabase::GetOfflineOperation(uint64_t folderId, nsMsgKey key,
                                              OfflineOperationData& output) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ReadOfflineOperation"_ns,
      "SELECT id, operation, flagOperation, newFlags, sourceKey, sourceUid, "
      "messageSize, playingBack, sourceFolderURI, destinationFolderURI, "
      "keywordsToAdd, keywordsToRemove FROM offline_operations "
      "WHERE folderId = :folder AND messageKey = :key"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
  MOZ_TRY(stmt->BindInt64ByName("key"_ns, key));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
  int64_t id;
  MOZ_TRY(stmt->GetInt64(0, &id));
  NS_ENSURE_TRUE(id > 0, NS_ERROR_FILE_CORRUPTED);
  OfflineOperationData found;
  MOZ_TRY(OfflineUint32(stmt, 1, found.operation));
  MOZ_TRY(OfflineUint32(stmt, 2, found.flagOperation));
  MOZ_TRY(OfflineUint32(stmt, 3, found.newFlags));
  MOZ_TRY(OfflineUint32(stmt, 4, found.sourceKey));
  MOZ_TRY(OfflineUint32(stmt, 5, found.sourceUid));
  MOZ_TRY(OfflineUint32(stmt, 6, found.messageSize));
  uint32_t playing;
  MOZ_TRY(OfflineUint32(stmt, 7, playing));
  NS_ENSURE_TRUE(playing <= 1, NS_ERROR_FILE_CORRUPTED);
  found.playingBack = playing;
  MOZ_TRY(stmt->GetUTF8String(8, found.sourceFolderURI));
  MOZ_TRY(stmt->GetUTF8String(9, found.destinationFolderURI));
  MOZ_TRY(stmt->GetUTF8String(10, found.keywordsToAdd));
  MOZ_TRY(stmt->GetUTF8String(11, found.keywordsToRemove));
  nsCOMPtr<mozIStorageStatement> copies;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ReadOfflineCopies"_ns,
      "SELECT uri FROM offline_copy_destinations WHERE operationId = :id "
      "ORDER BY ordinal"_ns,
      getter_AddRefs(copies)));
  mozStorageStatementScoper copyScoper(copies);
  MOZ_TRY(copies->BindInt64ByName("id"_ns, id));
  while (true) {
    MOZ_TRY(copies->ExecuteStep(&more));
    if (!more) {
      break;
    }
    nsCString uri;
    MOZ_TRY(copies->GetUTF8String(0, uri));
    found.copyDestinations.AppendElement(std::move(uri));
  }
  output = std::move(found);
  return NS_OK;
}

nsresult MessageDatabase::ReserveOfflineOperationKey(uint64_t folderId,
                                                     nsMsgKey& key) {
  MOZ_TRY(DatabaseCore::EnsureConnection());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool active;
  MOZ_TRY(connection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  nsMsgKey allocated = nsMsgKey_None;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    MOZ_TRY(DatabaseCore::GetNextMessageKey(allocated));
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "ReserveFolderOfflineOperation"_ns,
          "INSERT INTO offline_operations(folderId, messageKey, revision, "
          "operation, "
          "flagOperation, newFlags, sourceKey, sourceUid, messageSize, "
          "playingBack, "
          "sourceFolderURI, destinationFolderURI, keywordsToAdd, "
          "keywordsToRemove) "
          "SELECT id, :key, 1, 0, 0, 0, 4294967295, 0, 0, 0, '', '', '', '' "
          "FROM folders WHERE id = :folder RETURNING id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
      MOZ_TRY(stmt->BindInt64ByName("key"_ns, allocated));
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_FALSE(more, NS_ERROR_UNEXPECTED);
    }
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "ReserveStagedKey"_ns,
          "UPDATE message_key_allocator SET highWater = :id WHERE singleton = 1"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, allocated));
      MOZ_TRY(stmt->Execute());
    }
    return connection->CommitTransaction();
  }();
  MOZ_TRY(FinishOfflineWrite(connection, rv));
  key = allocated;
  return NS_OK;
}

nsresult MessageDatabase::StoreOfflineOperation(
    uint64_t folderId, nsMsgKey key, const OfflineOperationData& input) {
  NS_ENSURE_TRUE(
      folderId && folderId <= INT64_MAX && key && key < nsMsgKey_None,
      NS_ERROR_INVALID_ARG);
  MOZ_TRY(DatabaseCore::EnsureConnection());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool active;
  MOZ_TRY(connection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    int64_t id = 0, revision = 0;
    Maybe<ServerMessageLocation> source;
    Maybe<uint32_t> folderEpoch;
    nsresult found = ReadOfflineOperationIdentity(folderId, key, id, revision,
                                                  source, &folderEpoch);
    if (NS_FAILED(found) && found != NS_ERROR_NOT_AVAILABLE) {
      return found;
    }
    if (id) {
      MOZ_TRY(RequireOfflineOperationMutable(id));
      NS_ENSURE_TRUE(revision < INT64_MAX, NS_ERROR_ILLEGAL_VALUE);
    }
    {
      nsCOMPtr<mozIStorageStatement> member;
      MOZ_TRY(DatabaseCore::GetStatement(
          "OfflineOperationMember"_ns,
          "SELECT folderId FROM messages WHERE id = :key UNION ALL "
          "SELECT folderId FROM staged_messages WHERE id = :key"_ns,
          getter_AddRefs(member)));
      mozStorageStatementScoper scoper(member);
      MOZ_TRY(member->BindInt64ByName("key"_ns, key));
      bool exists;
      MOZ_TRY(member->ExecuteStep(&exists));
      if (!exists) {
        // Existing operations survive local deletion with their captured tuple.
        NS_ENSURE_TRUE(id, NS_ERROR_NOT_AVAILABLE);
      } else {
        int64_t actualFolder;
        MOZ_TRY(member->GetInt64(0, &actualFolder));
        NS_ENSURE_TRUE(actualFolder > 0 && uint64_t(actualFolder) == folderId,
                       NS_ERROR_NOT_AVAILABLE);
        nsTArray<nsCString> names;
        MOZ_TRY(GetMessagePropertyNames(key, names));
        if (!source && names.Contains("uidOnServer"_ns)) {
          ServerMessageLocation location{folderId, key};
          RefPtr<Message> header = new Message(key);
          MOZ_TRY(header->GetUint32Property("uidOnServer", &location.uid));
          NS_ENSURE_TRUE(DatabaseCore::sInstance, NS_ERROR_NOT_AVAILABLE);
          MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(
              folderId, location.epoch));
          source = Some(location);
        }
      }
    }
    if (input.operation & OfflineOp::kDeleteAllMsgs) {
      if (!folderEpoch) {
        NS_ENSURE_TRUE(DatabaseCore::sInstance, NS_ERROR_NOT_AVAILABLE);
        uint32_t epoch;
        MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(
            folderId, epoch));
        folderEpoch = Some(epoch);
      }
    } else {
      folderEpoch.reset();
    }
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "StoreOfflineOperation"_ns,
          "INSERT INTO offline_operations(folderId, messageKey, revision, "
          "epoch, uid, folderEpoch, "
          "operation, flagOperation, newFlags, sourceKey, sourceUid, "
          "messageSize, "
          "playingBack, sourceFolderURI, destinationFolderURI, keywordsToAdd, "
          "keywordsToRemove) "
          "VALUES(:folder, :key, :revision, :epoch, :uid, :folderEpoch, "
          ":operation, :flags, "
          ":newFlags, "
          ":sourceKey, :sourceUid, :size, :playing, :sourceURI, "
          ":destinationURI, :add, :remove) "
          "ON CONFLICT(folderId, messageKey) DO UPDATE SET revision = "
          "excluded.revision, "
          "epoch = excluded.epoch, uid = excluded.uid, folderEpoch = "
          "excluded.folderEpoch, operation = "
          "excluded.operation, "
          "flagOperation = excluded.flagOperation, newFlags = "
          "excluded.newFlags, "
          "sourceKey = excluded.sourceKey, sourceUid = excluded.sourceUid, "
          "messageSize = excluded.messageSize, playingBack = "
          "excluded.playingBack, "
          "sourceFolderURI = excluded.sourceFolderURI, destinationFolderURI = "
          "excluded.destinationFolderURI, "
          "keywordsToAdd = excluded.keywordsToAdd, keywordsToRemove = "
          "excluded.keywordsToRemove "
          "RETURNING id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
      MOZ_TRY(stmt->BindInt64ByName("key"_ns, key));
      MOZ_TRY(stmt->BindInt64ByName("revision"_ns, revision + 1));
      if (source) {
        MOZ_TRY(stmt->BindInt64ByName("epoch"_ns, source->epoch));
        MOZ_TRY(stmt->BindInt64ByName("uid"_ns, source->uid));
      } else {
        MOZ_TRY(stmt->BindNullByName("epoch"_ns));
        MOZ_TRY(stmt->BindNullByName("uid"_ns));
      }
      if (folderEpoch) {
        MOZ_TRY(stmt->BindInt64ByName("folderEpoch"_ns, *folderEpoch));
      } else {
        MOZ_TRY(stmt->BindNullByName("folderEpoch"_ns));
      }
      MOZ_TRY(stmt->BindInt64ByName("operation"_ns, input.operation));
      MOZ_TRY(stmt->BindInt64ByName("flags"_ns, input.flagOperation));
      MOZ_TRY(stmt->BindInt64ByName("newFlags"_ns, input.newFlags));
      MOZ_TRY(stmt->BindInt64ByName("sourceKey"_ns, input.sourceKey));
      MOZ_TRY(stmt->BindInt64ByName("sourceUid"_ns, input.sourceUid));
      MOZ_TRY(stmt->BindInt64ByName("size"_ns, input.messageSize));
      MOZ_TRY(stmt->BindInt32ByName("playing"_ns, input.playingBack));
      MOZ_TRY(
          stmt->BindUTF8StringByName("sourceURI"_ns, input.sourceFolderURI));
      MOZ_TRY(stmt->BindUTF8StringByName("destinationURI"_ns,
                                         input.destinationFolderURI));
      MOZ_TRY(stmt->BindUTF8StringByName("add"_ns, input.keywordsToAdd));
      MOZ_TRY(stmt->BindUTF8StringByName("remove"_ns, input.keywordsToRemove));
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_TRUE(more, NS_ERROR_UNEXPECTED);
      MOZ_TRY(stmt->GetInt64(0, &id));
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_FALSE(more, NS_ERROR_UNEXPECTED);
    }
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "ClearOfflineCopies"_ns,
          "DELETE FROM offline_copy_destinations WHERE operationId = :id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, id));
      MOZ_TRY(stmt->Execute());
    }
    nsCOMPtr<mozIStorageStatement> copy;
    MOZ_TRY(DatabaseCore::GetStatement(
        "StoreOfflineCopy"_ns,
        "INSERT INTO offline_copy_destinations(operationId, ordinal, uri) "
        "VALUES(:id, :ordinal, :uri)"_ns,
        getter_AddRefs(copy)));
    for (size_t i = 0; i < input.copyDestinations.Length(); ++i) {
      mozStorageStatementScoper scoper(copy);
      MOZ_TRY(copy->BindInt64ByName("id"_ns, id));
      MOZ_TRY(copy->BindInt64ByName("ordinal"_ns, i));
      MOZ_TRY(copy->BindUTF8StringByName("uri"_ns, input.copyDestinations[i]));
      MOZ_TRY(copy->Execute());
    }
    return connection->CommitTransaction();
  }();
  return FinishOfflineWrite(connection, rv);
}

nsresult MessageDatabase::SetOfflineOperationPlayingBack(uint64_t folderId,
                                                         nsMsgKey key,
                                                         bool playingBack) {
  MOZ_TRY(DatabaseCore::EnsureConnection());
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "SetOfflinePlayingBack"_ns,
      "UPDATE offline_operations SET playingBack = :playing "
      "WHERE folderId = :folder AND messageKey = :key RETURNING id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
  MOZ_TRY(stmt->BindInt64ByName("key"_ns, key));
  MOZ_TRY(stmt->BindInt32ByName("playing"_ns, playingBack));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(stmt->ExecuteStep(&more));
  return more ? NS_ERROR_UNEXPECTED : NS_OK;
}

nsresult MessageDatabase::RemoveOfflineOperation(uint64_t folderId,
                                                 nsMsgKey key) {
  MOZ_TRY(DatabaseCore::EnsureConnection());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool active;
  MOZ_TRY(connection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    int64_t id, revision;
    Maybe<ServerMessageLocation> source;
    MOZ_TRY(ReadOfflineOperationIdentity(folderId, key, id, revision, source));
    MOZ_TRY(RequireOfflineOperationMutable(id));
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "RemoveOfflineOperation"_ns,
        "DELETE FROM offline_operations WHERE id = :id"_ns,
        getter_AddRefs(stmt)));
    {
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, id));
      MOZ_TRY(stmt->Execute());
    }
    return connection->CommitTransaction();
  }();
  return FinishOfflineWrite(connection, rv);
}

nsresult MessageDatabase::ListOfflineOperations(uint64_t folderId,
                                                bool deletesOnly,
                                                nsTArray<nsMsgKey>& keys) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ListOfflineOperations"_ns,
      "SELECT messageKey FROM offline_operations WHERE folderId = :folder AND "
      "(:deletesOnly = 0 OR (operation & :moved) != 0 OR "
      "((operation & :flagsChanged) != 0 AND (newFlags & :deleted) != 0)) ORDER BY messageKey"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
  MOZ_TRY(stmt->BindInt32ByName("deletesOnly"_ns, deletesOnly));
  MOZ_TRY(stmt->BindInt64ByName("moved"_ns, OfflineOp::kMsgMoved));
  MOZ_TRY(stmt->BindInt64ByName("flagsChanged"_ns, OfflineOp::kFlagsChanged));
  MOZ_TRY(stmt->BindInt64ByName("deleted"_ns, OfflineOp::kMsgMarkedDeleted));
  nsTArray<nsMsgKey> result;
  bool more;
  while (true) {
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (!more) {
      break;
    }
    int64_t key;
    MOZ_TRY(stmt->GetInt64(0, &key));
    NS_ENSURE_TRUE(key > 0 && key < nsMsgKey_None, NS_ERROR_FILE_CORRUPTED);
    result.AppendElement(static_cast<nsMsgKey>(key));
  }
  keys = std::move(result);
  return NS_OK;
}

nsresult MessageDatabase::BeginOfflineAttempt(
    uint64_t folderId, nsMsgKey key, uint32_t operation,
    const Maybe<PendingDestination>& destination, uint64_t& attemptId) {
  NS_ENSURE_TRUE(DatabaseCore::sInstance, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(DatabaseCore::EnsureConnection());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool active;
  MOZ_TRY(connection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  int64_t created = 0;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    int64_t id, revision;
    Maybe<ServerMessageLocation> source;
    Maybe<uint32_t> folderEpoch;
    MOZ_TRY(ReadOfflineOperationIdentity(folderId, key, id, revision, source,
                                         &folderEpoch));
    MOZ_TRY(RequireOfflineOperationMutable(id));
    OfflineOperationData payload;
    MOZ_TRY(GetOfflineOperation(folderId, key, payload));
    NS_ENSURE_TRUE(
        operation && !(operation & (operation - 1)) &&
            operation <= OfflineOp::kRemoveKeywords &&
            !(operation & (OfflineOp::kMoveResult | OfflineOp::kAddedHeader)) &&
            (payload.operation & operation),
        NS_ERROR_INVALID_ARG);
    // One dispatched action from the combined payload, never an implicit batch.
    NS_ENSURE_TRUE(source || (operation & (OfflineOp::kAppendDraft |
                                           OfflineOp::kAppendTemplate |
                                           OfflineOp::kDeleteAllMsgs)),
                   NS_ERROR_NOT_AVAILABLE);
    if (operation == OfflineOp::kDeleteAllMsgs) {
      NS_ENSURE_TRUE(folderEpoch, NS_ERROR_NOT_AVAILABLE);
      uint32_t epoch;
      MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(folderId,
                                                                       epoch));
      NS_ENSURE_TRUE(epoch == *folderEpoch, NS_ERROR_NOT_AVAILABLE);
    } else {
      folderEpoch.reset();
    }
    if (source) {
      uint32_t epoch;
      MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(
          source->folderId, epoch));
      NS_ENSURE_TRUE(epoch == source->epoch, NS_ERROR_NOT_AVAILABLE);
      bool exists;
      MOZ_TRY(MessageExists(source->key, exists));
      if (exists) {
        nsCOMPtr<mozIStorageStatement> member;
        MOZ_TRY(DatabaseCore::GetStatement(
            "OfflineSourceFolder"_ns,
            "SELECT folderId FROM messages WHERE id = :key"_ns,
            getter_AddRefs(member)));
        mozStorageStatementScoper scoper(member);
        MOZ_TRY(member->BindInt64ByName("key"_ns, source->key));
        bool found;
        MOZ_TRY(member->ExecuteStep(&found));
        NS_ENSURE_TRUE(found, NS_ERROR_NOT_AVAILABLE);
        int64_t actualFolder;
        MOZ_TRY(member->GetInt64(0, &actualFolder));
        NS_ENSURE_TRUE(
            actualFolder > 0 && uint64_t(actualFolder) == source->folderId,
            NS_ERROR_NOT_AVAILABLE);
        uint32_t uid;
        nsTArray<nsCString> names;
        MOZ_TRY(GetMessagePropertyNames(source->key, names));
        NS_ENSURE_TRUE(names.Contains("uidOnServer"_ns),
                       NS_ERROR_NOT_AVAILABLE);
        MOZ_TRY(GetMessageUidOnServer(source->key, uid));
        NS_ENSURE_TRUE(uid == source->uid, NS_ERROR_NOT_AVAILABLE);
      }
    }
    NS_ENSURE_TRUE(destination || !(operation & (OfflineOp::kMsgMoved |
                                                 OfflineOp::kMsgCopy |
                                                 OfflineOp::kAppendDraft |
                                                 OfflineOp::kAppendTemplate)),
                   NS_ERROR_INVALID_ARG);
    if (destination) {
      NS_ENSURE_TRUE(
          !(operation & (OfflineOp::kMsgMoved | OfflineOp::kMsgCopy)) ||
              destination->key != key,
          NS_ERROR_NOT_AVAILABLE);
      uint32_t epoch;
      MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(
          destination->folderId, epoch));
      NS_ENSURE_TRUE(epoch == destination->epoch, NS_ERROR_NOT_AVAILABLE);
      nsCOMPtr<mozIStorageStatement> member;
      MOZ_TRY(DatabaseCore::GetStatement(
          "OfflineDestinationMember"_ns,
          "SELECT folderId FROM messages WHERE id = :key UNION ALL "
          "SELECT folderId FROM staged_messages WHERE id = :key"_ns,
          getter_AddRefs(member)));
      mozStorageStatementScoper scoper(member);
      MOZ_TRY(member->BindInt64ByName("key"_ns, destination->key));
      bool exists;
      MOZ_TRY(member->ExecuteStep(&exists));
      NS_ENSURE_TRUE(exists, NS_ERROR_NOT_AVAILABLE);
      int64_t actual;
      MOZ_TRY(member->GetInt64(0, &actual));
      NS_ENSURE_TRUE(actual > 0 && uint64_t(actual) == destination->folderId,
                     NS_ERROR_NOT_AVAILABLE);
      nsTArray<nsCString> names;
      MOZ_TRY(GetMessagePropertyNames(destination->key, names));
      NS_ENSURE_FALSE(names.Contains("uidOnServer"_ns), NS_ERROR_NOT_AVAILABLE);
      nsCOMPtr<mozIStorageStatement> used;
      MOZ_TRY(DatabaseCore::GetStatement(
          "OfflineDestinationAlreadyUsed"_ns,
          "SELECT 1 FROM offline_attempts WHERE destinationKey = :key "
          "AND state IN (1, 2, 3) LIMIT 1"_ns,
          getter_AddRefs(used)));
      mozStorageStatementScoper usedScoper(used);
      MOZ_TRY(used->BindInt64ByName("key"_ns, destination->key));
      MOZ_TRY(used->ExecuteStep(&exists));
      NS_ENSURE_FALSE(exists, NS_ERROR_NOT_AVAILABLE);
    }
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "BeginOfflineAttempt"_ns,
          "INSERT INTO offline_attempts(operationId, revision, state, "
          "sourceFolderId, sourceKey, sourceEpoch, sourceUid, "
          "destinationFolderId, destinationKey, destinationEpoch, "
          "operationFolderId, operationEpoch, operation) "
          "VALUES(:operation, :revision, 1, :sourceFolder, :sourceKey, "
          ":sourceEpoch, "
          ":sourceUid, :destinationFolder, :destinationKey, :destinationEpoch, :folder, :folderEpoch, :action) RETURNING id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("operation"_ns, id));
      MOZ_TRY(stmt->BindInt64ByName("revision"_ns, revision));
      MOZ_TRY(stmt->BindInt64ByName("action"_ns, operation));
      MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
      if (folderEpoch) {
        MOZ_TRY(stmt->BindInt64ByName("folderEpoch"_ns, *folderEpoch));
      } else {
        MOZ_TRY(stmt->BindNullByName("folderEpoch"_ns));
      }
      if (source) {
        MOZ_TRY(stmt->BindInt64ByName("sourceFolder"_ns, source->folderId));
        MOZ_TRY(stmt->BindInt64ByName("sourceKey"_ns, source->key));
        MOZ_TRY(stmt->BindInt64ByName("sourceEpoch"_ns, source->epoch));
        MOZ_TRY(stmt->BindInt64ByName("sourceUid"_ns, source->uid));
      } else {
        for (const char* name :
             {"sourceFolder", "sourceKey", "sourceEpoch", "sourceUid"}) {
          MOZ_TRY(stmt->BindNullByName(nsDependentCString(name)));
        }
      }
      if (destination) {
        MOZ_TRY(stmt->BindInt64ByName("destinationFolder"_ns,
                                      destination->folderId));
        MOZ_TRY(stmt->BindInt64ByName("destinationKey"_ns, destination->key));
        MOZ_TRY(
            stmt->BindInt64ByName("destinationEpoch"_ns, destination->epoch));
      } else {
        for (const char* name :
             {"destinationFolder", "destinationKey", "destinationEpoch"}) {
          MOZ_TRY(stmt->BindNullByName(nsDependentCString(name)));
        }
      }
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_TRUE(more, NS_ERROR_UNEXPECTED);
      MOZ_TRY(stmt->GetInt64(0, &created));
      NS_ENSURE_TRUE(created > 0, NS_ERROR_FILE_CORRUPTED);
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_FALSE(more, NS_ERROR_UNEXPECTED);
    }
    return connection->CommitTransaction();
  }();
  MOZ_TRY(FinishOfflineWrite(connection, rv));
  attemptId = static_cast<uint64_t>(created);
  return NS_OK;
}

nsresult MessageDatabase::GetOfflineAttempt(uint64_t attemptId,
                                            OfflineAttempt& output) {
  NS_ENSURE_TRUE(attemptId && attemptId <= INT64_MAX, NS_ERROR_INVALID_ARG);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "GetOfflineAttempt"_ns,
      "SELECT operationId, revision, state, sourceFolderId, sourceKey, "
      "sourceEpoch, "
      "sourceUid, destinationFolderId, destinationKey, destinationEpoch, "
      "confirmedUid, "
      "operationFolderId, operationEpoch, operation "
      "FROM offline_attempts WHERE id = :id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, attemptId));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
  OfflineAttempt found;
  found.id = attemptId;
  int64_t id, revision, state;
  MOZ_TRY(stmt->GetInt64(0, &id));
  MOZ_TRY(stmt->GetInt64(1, &revision));
  MOZ_TRY(stmt->GetInt64(2, &state));
  NS_ENSURE_TRUE(id > 0 && revision > 0 && state >= 0 && state <= 3,
                 NS_ERROR_FILE_CORRUPTED);
  found.operationId = id;
  found.revision = revision;
  found.state = static_cast<OfflineAttemptState>(state);
  bool sourceNull, destinationNull;
  MOZ_TRY(stmt->GetIsNull(3, &sourceNull));
  for (uint32_t column : {4, 5, 6}) {
    bool null;
    MOZ_TRY(stmt->GetIsNull(column, &null));
    NS_ENSURE_TRUE(null == sourceNull, NS_ERROR_FILE_CORRUPTED);
  }
  if (!sourceNull) {
    ServerMessageLocation location;
    MOZ_TRY(stmt->GetInt64(3, &id));
    NS_ENSURE_TRUE(id > 0, NS_ERROR_FILE_CORRUPTED);
    location.folderId = id;
    MOZ_TRY(OfflineUint32(stmt, 4, location.key));
    NS_ENSURE_TRUE(location.key && location.key < nsMsgKey_None,
                   NS_ERROR_FILE_CORRUPTED);
    MOZ_TRY(OfflineUint32(stmt, 5, location.epoch));
    MOZ_TRY(OfflineUint32(stmt, 6, location.uid));
    found.source = Some(location);
  }
  MOZ_TRY(stmt->GetIsNull(7, &destinationNull));
  for (uint32_t column : {8, 9}) {
    bool null;
    MOZ_TRY(stmt->GetIsNull(column, &null));
    NS_ENSURE_TRUE(null == destinationNull, NS_ERROR_FILE_CORRUPTED);
  }
  if (!destinationNull) {
    PendingDestination location;
    MOZ_TRY(stmt->GetInt64(7, &id));
    NS_ENSURE_TRUE(id > 0, NS_ERROR_FILE_CORRUPTED);
    location.folderId = id;
    MOZ_TRY(OfflineUint32(stmt, 8, location.key));
    NS_ENSURE_TRUE(location.key && location.key < nsMsgKey_None,
                   NS_ERROR_FILE_CORRUPTED);
    MOZ_TRY(OfflineUint32(stmt, 9, location.epoch));
    found.destination = Some(location);
  }
  bool uidNull;
  MOZ_TRY(stmt->GetIsNull(10, &uidNull));
  if (!uidNull) {
    uint32_t uid;
    MOZ_TRY(OfflineUint32(stmt, 10, uid));
    found.confirmedUid = Some(uid);
  }
  MOZ_TRY(stmt->GetInt64(11, &id));
  NS_ENSURE_TRUE(id > 0, NS_ERROR_FILE_CORRUPTED);
  found.folderId = id;
  MOZ_TRY(OfflineUint32(stmt, 13, found.operation));
  bool epochNull;
  MOZ_TRY(stmt->GetIsNull(12, &epochNull));
  if (!epochNull) {
    uint32_t epoch;
    MOZ_TRY(OfflineUint32(stmt, 12, epoch));
    found.folderEpoch = Some(epoch);
  }
  output = std::move(found);
  return NS_OK;
}

nsresult MessageDatabase::GetCurrentOfflineAttempt(uint64_t folderId,
                                                   nsMsgKey key,
                                                   OfflineAttempt& output) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "CurrentOfflineAttempt"_ns,
      "SELECT a.id FROM offline_attempts a JOIN offline_operations o "
      "ON o.id = a.operationId AND o.revision = a.revision "
      "WHERE o.folderId = :folder AND o.messageKey = :key "
      "ORDER BY a.id DESC LIMIT 1"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
  MOZ_TRY(stmt->BindInt64ByName("key"_ns, key));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
  int64_t id;
  MOZ_TRY(stmt->GetInt64(0, &id));
  NS_ENSURE_TRUE(id > 0, NS_ERROR_FILE_CORRUPTED);
  return GetOfflineAttempt(id, output);
}

nsresult MessageDatabase::ResolveOfflineAttemptNotApplied(uint64_t attemptId) {
  NS_ENSURE_TRUE(attemptId && attemptId <= INT64_MAX, NS_ERROR_INVALID_ARG);
  MOZ_TRY(DatabaseCore::EnsureConnection());
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ResolveOfflineAttemptNotApplied"_ns,
      "UPDATE offline_attempts SET state = 0 WHERE id = :id AND state IN (1,3) "
      "RETURNING id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, attemptId));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(stmt->ExecuteStep(&more));
  return more ? NS_ERROR_UNEXPECTED : NS_OK;
}

nsresult MessageDatabase::MarkOfflineAttemptAmbiguous(uint64_t attemptId) {
  NS_ENSURE_TRUE(attemptId && attemptId <= INT64_MAX, NS_ERROR_INVALID_ARG);
  MOZ_TRY(DatabaseCore::EnsureConnection());
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "MarkOfflineAttemptAmbiguous"_ns,
      "UPDATE offline_attempts SET state = 3 WHERE id = :id AND state IN (1,3) "
      "RETURNING id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, attemptId));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(stmt->ExecuteStep(&more));
  return more ? NS_ERROR_UNEXPECTED : NS_OK;
}

nsresult MessageDatabase::ConfirmOfflineAttempt(
    uint64_t attemptId, const Maybe<ServerUidConfirmation>& destinationUid) {
  NS_ENSURE_TRUE(attemptId && attemptId <= INT64_MAX, NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(DatabaseCore::sInstance, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(DatabaseCore::EnsureConnection());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool active;
  MOZ_TRY(connection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    OfflineAttempt attempt;
    MOZ_TRY(GetOfflineAttempt(attemptId, attempt));
    NS_ENSURE_TRUE(attempt.destination.isSome() == destinationUid.isSome(),
                   NS_ERROR_INVALID_ARG);
    if (attempt.state == OfflineAttemptState::Confirmed) {
      NS_ENSURE_TRUE(destinationUid
                         ? (attempt.confirmedUid == Some(destinationUid->uid) &&
                            attempt.destination->epoch == destinationUid->epoch)
                         : attempt.confirmedUid.isNothing(),
                     NS_ERROR_FILE_CORRUPTED);
      return connection->CommitTransaction();
    }
    NS_ENSURE_TRUE(attempt.state == OfflineAttemptState::Sent ||
                       attempt.state == OfflineAttemptState::Ambiguous,
                   NS_ERROR_NOT_AVAILABLE);
    if (attempt.folderEpoch) {
      uint32_t epoch;
      MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(
          attempt.folderId, epoch));
      NS_ENSURE_TRUE(epoch == *attempt.folderEpoch, NS_ERROR_NOT_AVAILABLE);
    }
    if (attempt.source) {
      uint32_t epoch;
      MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(
          attempt.source->folderId, epoch));
      NS_ENSURE_TRUE(epoch == attempt.source->epoch, NS_ERROR_NOT_AVAILABLE);
    }
    if (attempt.destination) {
      NS_ENSURE_TRUE(destinationUid->epoch == attempt.destination->epoch,
                     NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(BindMessageToServerUidInTransaction(
          attempt.destination->key, attempt.destination->folderId,
          destinationUid->epoch, destinationUid->uid, true));
    }
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "ConfirmOfflineAttempt"_ns,
          "UPDATE offline_attempts SET state = 2, confirmedUid = :uid WHERE id = :id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, attemptId));
      if (destinationUid) {
        MOZ_TRY(stmt->BindInt64ByName("uid"_ns, destinationUid->uid));
      } else {
        MOZ_TRY(stmt->BindNullByName("uid"_ns));
      }
      MOZ_TRY(stmt->Execute());
    }
    return connection->CommitTransaction();
  }();
  return FinishOfflineWrite(connection, rv);
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
  bool staged;
  MOZ_TRY(IsMessageStaged(key, staged));
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      staged ? "GetStagedReferences"_ns : "GetMessageReferences"_ns,
      staged ? "SELECT s.id, r.token FROM staged_messages m "
               "LEFT JOIN staged_message_reference_sets s ON s.id = m.id "
               "LEFT JOIN staged_message_references r ON r.id = s.id "
               "WHERE m.id = :id ORDER BY r.ordinal"_ns
             : "SELECT s.id, r.token FROM messages m "
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
    MOZ_TRY(GetHeaderStatement(key, "RequireMessageForReferences"_ns,
                               HeaderTable::Messages, "SELECT 1 FROM "_ns,
                               " WHERE id = :id"_ns, getter_AddRefs(stmt)));
    mozStorageStatementScoper scoper(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    bool exists;
    MOZ_TRY(stmt->ExecuteStep(&exists));
    NS_ENSURE_TRUE(exists, NS_ERROR_UNEXPECTED);
  }
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(GetHeaderStatement(key, "ClearMessageReferences"_ns,
                               HeaderTable::References, "DELETE FROM "_ns,
                               " WHERE id = :id"_ns, getter_AddRefs(stmt)));
    mozStorageStatementScoper scoper(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    MOZ_TRY(stmt->Execute());
  }
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(GetHeaderStatement(key, "MarkMessageReferencesKnown"_ns,
                               HeaderTable::ReferenceSets,
                               "INSERT OR IGNORE INTO "_ns,
                               "(id) VALUES(:id)"_ns, getter_AddRefs(stmt)));
    mozStorageStatementScoper scoper(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    MOZ_TRY(stmt->Execute());
  }
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(GetHeaderStatement(
      key, "InsertMessageReference"_ns, HeaderTable::References,
      "INSERT INTO "_ns,
      "(id, ordinal, token) VALUES(:id, :ordinal, :token)"_ns,
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
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ListAllKeys"_ns, "SELECT id FROM messages WHERE folderId = :folderId"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, folderId));
  nsTArray<nsMsgKey> found;
  while (true) {
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (!more) {
      break;
    }
    int64_t id;
    MOZ_TRY(stmt->GetInt64(0, &id));
    if (id <= 0 || id >= nsMsgKey_None) {
      return NS_ERROR_FILE_CORRUPTED;
    }
    found.AppendElement(static_cast<nsMsgKey>(id));
  }
  keys = std::move(found);
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
  nsresult rv =
      GetHeaderStatement(key, "FetchCachedMsg"_ns, HeaderTable::Messages,
                         "SELECT "_ns MESSAGE_SQL_FIELDS " FROM "_ns,
                         " WHERE id = :id"_ns, getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));

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
  NS_ENSURE_ARG_POINTER(numMessages);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "GetNumMessages"_ns,
      "SELECT COUNT(*) AS numMessages FROM messages WHERE folderId = :folderId"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, folderId));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
  int64_t count;
  MOZ_TRY(stmt->GetInt64(0, &count));
  NS_ENSURE_TRUE(count >= 0, NS_ERROR_FILE_CORRUPTED);
  *numMessages = count;
  return NS_OK;
}

nsresult MessageDatabase::GetNumUnread(uint64_t folderId, uint64_t* numUnread) {
  NS_ENSURE_ARG_POINTER(numUnread);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "GetNumUnread"_ns,
      "SELECT COUNT(*) AS numUnread FROM messages WHERE folderId = :folderId AND flags & :flag = 0"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, folderId));
  MOZ_TRY(stmt->BindInt64ByName("flag"_ns, nsMsgMessageFlags::Read));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
  int64_t count;
  MOZ_TRY(stmt->GetInt64(0, &count));
  NS_ENSURE_TRUE(count >= 0, NS_ERROR_FILE_CORRUPTED);
  *numUnread = count;
  return NS_OK;
}

nsresult MessageDatabase::GetMessagePropertyNames(nsMsgKey key,
                                                  nsTArray<nsCString>& names) {
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = GetHeaderStatement(
      key, "GetMessageProperties"_ns, HeaderTable::Properties,
      "SELECT name FROM "_ns, " WHERE id = :id"_ns, getter_AddRefs(stmt));
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
  if (aName.EqualsLiteral("storeToken") || aName.EqualsLiteral("messageSize") ||
      aName.EqualsLiteral("offlineMessageSize") ||
      aName.EqualsLiteral("lineCount")) {
    MOZ_TRY(CheckMessageBodyAccess(aKey));
  }
  MOZ_ASSERT(!aName.EqualsLiteral("keywords"));  // Use GetMessageTags().

  // TODO: might want to cache selected properties.
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = GetHeaderStatement(
      aKey, "GetMessageProperty"_ns, HeaderTable::Properties,
      "SELECT value FROM "_ns, " WHERE id = :id AND name = :name"_ns,
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
  if (name.EqualsLiteral("storeToken") || name.EqualsLiteral("messageSize") ||
      name.EqualsLiteral("offlineMessageSize") ||
      name.EqualsLiteral("lineCount")) {
    MOZ_TRY(CheckMessageBodyAccess(key));
  }
  // TODO: might want to cache selected properties.
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = GetHeaderStatement(
      key, "GetMessageProperty"_ns, HeaderTable::Properties,
      "SELECT value FROM "_ns, " WHERE id = :id AND name = :name"_ns,
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
  nsresult rv = GetHeaderStatement(
      aKey, "SetMessageProperty"_ns, HeaderTable::Properties,
      "REPLACE INTO "_ns, " (id, name, value) VALUES (:id, :name, :value)"_ns,
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
  nsresult rv = GetHeaderStatement(
      aKey, "SetMessageProperty"_ns, HeaderTable::Properties,
      "REPLACE INTO "_ns, " (id, name, value) VALUES (:id, :name, :value)"_ns,
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
    MOZ_TRY(
        BindMessageToServerUidInTransaction(key, folderId, epoch, uid, false));
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

nsresult MessageDatabase::BindMessageToServerUidInTransaction(
    nsMsgKey key, uint64_t folderId, uint32_t epoch, uint32_t uid,
    bool allowStaged) {
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_TRUE(active, NS_ERROR_UNEXPECTED);
  uint32_t current;
  MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(folderId,
                                                                   current));
  if (current != epoch) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "MessageInServerUidFolderOrStaging"_ns,
        "SELECT id FROM messages WHERE id = :id AND folderId = :folderId "
        "UNION ALL SELECT id FROM staged_messages WHERE :allowStaged != 0 "
        "AND id = :id AND folderId = :folderId"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scoper(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, folderId));
    MOZ_TRY(stmt->BindInt32ByName("allowStaged"_ns, allowStaged));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (!more) {
      return NS_ERROR_NOT_AVAILABLE;
    }
  }
  nsMsgKey existing;
  nsresult lookupRv = GetMessageKeyForServerUid(folderId, epoch, uid, existing);
  if (NS_FAILED(lookupRv) && lookupRv != NS_ERROR_NOT_AVAILABLE) {
    return lookupRv;
  }
  if (NS_SUCCEEDED(lookupRv) && existing != key) {
    return NS_ERROR_FILE_CORRUPTED;
  }
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "StagedMembersWithServerUid"_ns,
        "SELECT s.id FROM staged_messages s JOIN staged_message_properties p "
        "ON p.id = s.id AND p.name = 'uidOnServer' WHERE s.folderId = :folder "
        "AND s.id != :key"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scoper(stmt);
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
    MOZ_TRY(stmt->BindInt64ByName("key"_ns, key));
    bool more;
    while (true) {
      MOZ_TRY(stmt->ExecuteStep(&more));
      if (!more) {
        break;
      }
      uint32_t otherKey, otherUid;
      MOZ_TRY(OfflineUint32(stmt, 0, otherKey));
      NS_ENSURE_TRUE(otherKey && otherKey < nsMsgKey_None,
                     NS_ERROR_FILE_CORRUPTED);
      RefPtr<Message> header = new Message(otherKey);
      MOZ_TRY(header->GetUint32Property("uidOnServer", &otherUid));
      NS_ENSURE_TRUE(otherUid != uid, NS_ERROR_FILE_CORRUPTED);
    }
  }
  if (allowStaged) {
    RefPtr<Message> header = new Message(key);
    nsTArray<nsCString> names;
    MOZ_TRY(GetMessagePropertyNames(key, names));
    if (names.Contains("uidOnServer"_ns)) {
      uint32_t existingUid;
      MOZ_TRY(header->GetUint32Property("uidOnServer", &existingUid));
      NS_ENSURE_TRUE(existingUid == uid, NS_ERROR_FILE_CORRUPTED);
      return NS_OK;
    }
    MOZ_TRY(header->SetUint32Property("uidOnServer", uid));
  } else {
    MOZ_TRY(SetMessageUidOnServer(key, uid));
  }
  return NS_OK;
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

  bool staged;
  // Update in DB.
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    nsresult rv = GetHeaderStatement(
        key, "SetMessageFlags"_ns, HeaderTable::Messages, "UPDATE "_ns,
        " SET flags = :flags WHERE id = :id"_ns, getter_AddRefs(stmt), &staged);
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    MOZ_TRY(stmt->BindInt64ByName("flags"_ns, (int64_t)newFlags));
    rv = stmt->Execute();
    NS_ENSURE_SUCCESS(rv, rv);
  }

  // Update cache.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().flags = newFlags;
  }

  if (staged) {
    return NS_OK;
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
    nsresult rv = GetHeaderStatement(
        key, "SetMessagePriority"_ns, HeaderTable::Messages, "UPDATE "_ns,
        " SET priority = :priority WHERE id = :id"_ns, getter_AddRefs(stmt));
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    MOZ_TRY(stmt->BindInt32ByName("priority"_ns, priority));
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
    nsresult rv = GetHeaderStatement(
        key, "SetMessageDate"_ns, HeaderTable::Messages, "UPDATE "_ns,
        " SET date = :date WHERE id = :id"_ns, getter_AddRefs(stmt));
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    MOZ_TRY(stmt->BindInt64ByName("date"_ns, (int64_t)date));
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
    nsresult rv = GetHeaderStatement(
        key, "SetMessageMessageId"_ns, HeaderTable::Messages, "UPDATE "_ns,
        " SET messageId = :messageId WHERE id = :id"_ns, getter_AddRefs(stmt));
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    MOZ_TRY(stmt->BindUTF8StringByName("messageId"_ns, messageId));
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
    nsresult rv = GetHeaderStatement(
        key, "SetMessageCcList"_ns, HeaderTable::Messages, "UPDATE "_ns,
        " SET ccList = :ccList WHERE id = :id"_ns, getter_AddRefs(stmt));
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    MOZ_TRY(stmt->BindUTF8StringByName("ccList"_ns, ccList));
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
    nsresult rv = GetHeaderStatement(
        key, "SetMessageBccList"_ns, HeaderTable::Messages, "UPDATE "_ns,
        " SET bccList = :bccList WHERE id = :id"_ns, getter_AddRefs(stmt));
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    MOZ_TRY(stmt->BindUTF8StringByName("bccList"_ns, bccList));
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
    nsresult rv = GetHeaderStatement(
        key, "SetMessageSender"_ns, HeaderTable::Messages, "UPDATE "_ns,
        " SET sender = :sender WHERE id = :id"_ns, getter_AddRefs(stmt));
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    MOZ_TRY(stmt->BindUTF8StringByName("sender"_ns, sender));
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
    nsresult rv = GetHeaderStatement(
        key, "SetMessageSubject"_ns, HeaderTable::Messages, "UPDATE "_ns,
        " SET subject = :subject WHERE id = :id"_ns, getter_AddRefs(stmt));
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    MOZ_TRY(stmt->BindUTF8StringByName("subject"_ns, subject));
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
    nsresult rv = GetHeaderStatement(
        key, "SetMessageRecipients"_ns, HeaderTable::Messages, "UPDATE "_ns,
        " SET recipients = :recipients WHERE id = :id"_ns,
        getter_AddRefs(stmt));
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    MOZ_TRY(stmt->BindUTF8StringByName("recipients"_ns, recipients));
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

  bool staged;
  // Update DB.
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    nsresult rv = GetHeaderStatement(
        key, "SetMessageTags"_ns, HeaderTable::Messages, "UPDATE "_ns,
        " SET tags = :tags WHERE id = :id"_ns, getter_AddRefs(stmt), &staged);
    NS_ENSURE_SUCCESS(rv, rv);
    mozStorageStatementScoper scoper(stmt);

    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    MOZ_TRY(stmt->BindUTF8StringByName("tags"_ns, tags));
    rv = stmt->Execute();
    NS_ENSURE_SUCCESS(rv, rv);
  }

  // Update cache.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().tags = tags;
  }

  if (staged) {
    return NS_OK;
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
