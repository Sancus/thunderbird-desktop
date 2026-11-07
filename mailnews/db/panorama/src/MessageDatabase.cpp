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
#include "PerFolderDatabase.h"
#include "js/Array.h"
#include "js/CharacterEncoding.h"
#include "js/String.h"
#include "jsapi.h"
#include "mozIStorageConnection.h"
#include "mozIStorageStatement.h"
#include "mozIStorageValueArray.h"
#include "mozStorageHelper.h"
#include "mozilla/AutoRestore.h"
#include "mozilla/CheckedInt.h"
#include "mozilla/Components.h"
#include "mozilla/Logging.h"
#include "mozilla/ResultExtensions.h"
#include "mozilla/Try.h"
#include "mozilla/UniquePtr.h"
#include "mozilla/fallible.h"
#include "nsIFile.h"
#include "nsIMsgDatabase.h"
#include "nsIMsgOfflineImapOperation.h"
#include "nsIUUIDGenerator.h"
#include "nsImapCore.h"
#include "nsLocalFile.h"
#include "nsMsgFolderFlags.h"
#include "nsMsgKeySet.h"
#include "nsMsgMessageFlags.h"
#include "nsMsgUtils.h"
#include "nsReadableUtils.h"
#include "nsTHashMap.h"
#include "nsTHashSet.h"
#include <cstdlib>

using mozilla::LazyLogModule;
using mozilla::LogLevel;

namespace mozilla::mailnews {

extern LazyLogModule gPanoramaLog;  // Defined by DatabaseCore.

NS_IMPL_ISUPPORTS(MessageDatabase, nsIMessageDatabase)

struct MessageDatabase::ListenerRegistration {
  NS_INLINE_DECL_REFCOUNTING(ListenerRegistration)
 public:
  explicit ListenerRegistration(MessageListener* value)
      : identity(value), strongListener(value) {}
  explicit ListenerRegistration(PerFolderDatabase* value)
      : identity(value), folderListener(value) {}
  RefPtr<MessageListener> Resolve() const {
    if (strongListener) {
      return strongListener;
    }
    RefPtr<MessageListener> listener = folderListener.get();
    return listener;
  }
  bool Expired() const { return !strongListener && !folderListener; }
  // Identity is compared only, including after ForceClosed detaches WeakPtr.
  MessageListener* const identity;

 private:
  ~ListenerRegistration() = default;
  RefPtr<MessageListener> strongListener;
  WeakPtr<PerFolderDatabase> folderListener;
};

struct MessageDatabase::QueuedMessageBatch {
  enum class Kind { Publication, Thread, Removed, Flags, Tags, Body, Repair };
  struct Delivery {
    RefPtr<ListenerRegistration> registration;
    RefPtr<MessageListener> listener;
    nsCOMPtr<nsISupports> beforeViewData;
    PreparedThreadBatch prepared;
  };
  struct Flags {
    CapturedMessage before, after;
    RefPtr<nsIMsgDBHdr> oldHeader;
    RefPtr<Message> live;
  };
  struct Body {
    CapturedMessage before, after;
    MessageBodyState oldBody, newBody;
    RefPtr<nsIMsgDBHdr> oldHeader;
    RefPtr<Message> live;
  };
  uint64_t id{0};
  Kind kind{Kind::Publication};
  bool notifyLegacy{true};
  CapturedMessage before, after;
  RefPtr<nsIMsgDBHdr> oldHeader;
  RefPtr<Message> live;
  nsTArray<Delivery> deliveries;
  struct Repair {
    Body change;
    bool added{false};
  };
  nsTArray<Repair> repairs;
  nsTArray<Body> bodies;
  nsTArray<Flags> flagChanges;
};

struct OfflineOperationUndo::Data {
  struct Operation {
    uint64_t folderId{0};
    nsMsgKey key{nsMsgKey_None};
    int64_t id{0};
    int64_t revision{0};
    OfflineOperationData payload;
    Maybe<ServerMessageLocation> source;
    Maybe<uint32_t> folderEpoch;
    // Only the selected canceled counterpart has native Redo body custody.
    Maybe<MessageBodyState> restoredBody;
  } operation;
  nsCString databaseSourceId;
  Maybe<OfflineUndoCounterpart> counterpart;
  Operation counterpartOperation;
  // Actual typed destinations of a captured SOURCE operation, including absent
  // counterpart operations so a later claimant cannot silently join the
  // restore.
  nsTArray<Operation> destinationOperations;
  // Only explicit selected-MOVE Undo produces a separate owning Redo token.
  // The original full payload above stays immutable; this is its canceled
  // state.
  UniquePtr<Data> redoState;
  Maybe<MessageBodyState> restoredBody;
};

OfflineOperationUndo::OfflineOperationUndo() = default;
OfflineOperationUndo::~OfflineOperationUndo() = default;
OfflineOperationUndo::OfflineOperationUndo(OfflineOperationUndo&&) = default;
OfflineOperationUndo& OfflineOperationUndo::operator=(OfflineOperationUndo&&) =
    default;
const OfflineOperationData* OfflineOperationUndo::Operation() const {
  return mData ? &mData->operation.payload : nullptr;
}

struct MessageDatabase::NewsReadSetBinding {
  WeakPtr<PerFolderDatabase> owner;
  PerFolderDatabase* identity{nullptr};
  nsMsgKeySet** slot{nullptr};
  NewsGroupIdentity group;
};

struct MessageDatabase::PreparedNewsReadSet {
  NewsGroupIdentity group;
  RefPtr<nsMsgKeySet> contents;
  nsCString checkpoint;
  nsTArray<PreparedNewsReadSetInstall> recipients;
};

MessageDatabase::MessageDatabase() = default;
MessageDatabase::~MessageDatabase() = default;

void MessageDatabase::NotifyImportedMessage(Message* message) {
  // Preserve this helper's per-message boundary, pinning every live recipient
  // before any callback can release an externally owned folder wrapper.
  struct Recipient {
    RefPtr<ListenerRegistration> registration;
    RefPtr<MessageListener> listener;
  };
  PruneExpiredFolderListeners();
  nsTArray<Recipient> listeners;
  listeners.SetCapacity(mMessageListeners.Length());
  for (const auto& registration : mMessageListeners) {
    if (auto listener = registration->Resolve()) {
      listeners.AppendElement(Recipient{registration, std::move(listener)});
    }
  }
  for (const auto& recipient : listeners) {
    if (mMessageListeners.Contains(recipient.registration)) {
      recipient.listener->OnMessagePublished(message, false);
    }
  }
}

nsresult MessageDatabase::PrepareMessageBatch(
    UniquePtr<QueuedMessageBatch>& output) {
  NS_ENSURE_TRUE(mLastMessageBatch < UINT64_MAX, NS_ERROR_ILLEGAL_VALUE);
  auto batch =
      UniquePtr<QueuedMessageBatch>(new (fallible) QueuedMessageBatch());
  NS_ENSURE_TRUE(batch, NS_ERROR_OUT_OF_MEMORY);
  batch->id = mLastMessageBatch + 1;
  PruneExpiredFolderListeners();
  if (!batch->deliveries.SetCapacity(mMessageListeners.Length(), fallible) ||
      !mMessageBatches.SetCapacity(mMessageBatches.Length() + 1, fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  for (const auto& registration : mMessageListeners) {
    if (auto listener = registration->Resolve()) {
      QueuedMessageBatch::Delivery* delivery =
          batch->deliveries.AppendElement();
      delivery->registration = registration;
      delivery->listener = std::move(listener);
    }
  }
  output = std::move(batch);
  return NS_OK;
}

nsresult MessageDatabase::CaptureThreadViewsBeforeInsert(
    QueuedMessageBatch& batch) {
  for (auto& delivery : batch.deliveries) {
    MOZ_TRY(delivery.listener->CaptureThreadViewBeforeInsert(
        delivery.beforeViewData));
  }
  return NS_OK;
}

void MessageDatabase::QueueMessageBatch(UniquePtr<QueuedMessageBatch> batch) {
  MOZ_ASSERT(batch->id == mLastMessageBatch + 1);
  mLastMessageBatch = batch->id;
  mMessageBatches.AppendElement(std::move(batch));
  DrainMessageBatches();
}

void MessageDatabase::DrainMessageBatches() {
  if (mDeliveringMessageBatches) {
    return;
  }
  RefPtr<MessageDatabase> self(this);
  AutoRestore<bool> delivering(mDeliveringMessageBatches);
  mDeliveringMessageBatches = true;
  while (!mMessageBatches.IsEmpty()) {
    auto batch = std::move(mMessageBatches[0]);
    mMessageBatches.RemoveElementAt(0);
    if (batch->kind == QueuedMessageBatch::Kind::Flags &&
        !batch->flagChanges.IsEmpty()) {
      for (const auto& change : batch->flagChanges) {
        for (auto& delivery : batch->deliveries) {
          if (mMessageListeners.Contains(delivery.registration)) {
            delivery.listener->OnMessageFlagsChangedCaptured(
                change.before, change.after, change.oldHeader, change.live);
          }
        }
      }
      continue;
    }
    if (batch->kind == QueuedMessageBatch::Kind::Repair) {
      for (const auto& repaired : batch->repairs) {
        const auto& change = repaired.change;
        for (auto& delivery : batch->deliveries) {
          if (!mMessageListeners.Contains(delivery.registration)) continue;
          if (repaired.added) {
            delivery.listener->OnMessagePublishedCaptured(change.after,
                                                          change.live, false);
          } else {
            delivery.listener->OnMessageBodyChangedCaptured(
                change.before, change.after, change.oldHeader, change.live,
                change.oldBody, change.newBody);
          }
        }
      }
      continue;
    }
    if (batch->kind == QueuedMessageBatch::Kind::Body) {
      for (const auto& body : batch->bodies) {
        for (auto& delivery : batch->deliveries) {
          if (mMessageListeners.Contains(delivery.registration)) {
            delivery.listener->OnMessageBodyChangedCaptured(
                body.before, body.after, body.oldHeader, body.live,
                body.oldBody, body.newBody);
          }
        }
      }
      continue;
    }
    for (auto& delivery : batch->deliveries) {
      if (!mMessageListeners.Contains(delivery.registration)) {
        continue;
      }
      auto* listener = delivery.listener.get();
      switch (batch->kind) {
        case QueuedMessageBatch::Kind::Thread:
          listener->DeliverThreadBatch(delivery.prepared);
          break;
        case QueuedMessageBatch::Kind::Publication:
          listener->OnMessagePublishedCaptured(batch->after, batch->live,
                                               batch->notifyLegacy);
          break;
        case QueuedMessageBatch::Kind::Removed:
          listener->OnMessageRemovedCaptured(batch->before, batch->live);
          break;
        case QueuedMessageBatch::Kind::Flags:
          listener->OnMessageFlagsChangedCaptured(
              batch->before, batch->after, batch->oldHeader, batch->live);
          break;
        case QueuedMessageBatch::Kind::Tags:
          listener->OnMessageTagsChangedCaptured(batch->before, batch->after,
                                                 batch->oldHeader, batch->live);
          break;
        case QueuedMessageBatch::Kind::Body:
        case QueuedMessageBatch::Kind::Repair:
          MOZ_ASSERT_UNREACHABLE("bulk batch handled above");
      }
    }
  }
}

struct FolderRepairSnapshot::Data {
  RefPtr<MessageDatabase> owner;
  nsCString sourceId;
  uint64_t folderId{0};
  uint64_t parent{0};
  nsCString name;
  nsTArray<MessageBodyState> messages;
};

FolderRepairSnapshot::FolderRepairSnapshot() = default;
FolderRepairSnapshot::~FolderRepairSnapshot() = default;
FolderRepairSnapshot::FolderRepairSnapshot(FolderRepairSnapshot&&) = default;
FolderRepairSnapshot& FolderRepairSnapshot::operator=(FolderRepairSnapshot&&) =
    default;
const nsTArray<MessageBodyState>* FolderRepairSnapshot::Messages() const {
  return mData ? &mData->messages : nullptr;
}

struct RemovedMessage::Data {
  struct Property {
    nsCString name;
    nsCString text;
    Maybe<int64_t> integer;
  };
  RawHdr header;
  MessageBodyState body;
  nsTArray<Property> properties;
  nsMsgKey threadId{0};
  nsMsgKey threadParent{0};
  bool referencesKnown{false};
  int64_t deletionSequence{0};
};

RemovedMessage::RemovedMessage() = default;
RemovedMessage::~RemovedMessage() = default;
RemovedMessage::RemovedMessage(RemovedMessage&&) = default;
RemovedMessage& RemovedMessage::operator=(RemovedMessage&&) = default;
const MessageBodyState* RemovedMessage::Body() const {
  return mData ? &mData->body : nullptr;
}

void MessageDatabase::Startup() {
  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("MessageDatabase starting up"));
  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("MessageDatabase startup complete"));
}

void MessageDatabase::Shutdown() {
  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("MessageDatabase shutting down"));
  nsTArray<RefPtr<ListenerRegistration>> listeners;
  listeners.SwapElements(mMessageListeners);
  mMessageBatches.Clear();
  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("MessageDatabase shutdown complete"));
}

namespace {

constexpr uint64_t kMaxSearchSequence = 9007199254740991;

nsresult ChangeHeader(const CapturedMessage& captured,
                      RefPtr<DetachedMsgHdr>& output);
nsresult RollbackMessageChange(mozIStorageConnection* connection,
                               nsresult original);

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

nsresult MessageDatabase::RequireCurrentOwner() const {
  NS_ENSURE_TRUE(DatabaseCore::sInstance && DatabaseCore::sConnection &&
                     DatabaseCore::sInstance->mMessageDatabase.get() == this,
                 NS_ERROR_NOT_AVAILABLE);
  return NS_OK;
}

nsresult MessageDatabase::RequireCommittedSearchRead() {
  MOZ_TRY(RequireCurrentOwner());
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  return active ? NS_ERROR_IN_PROGRESS : NS_OK;
}

namespace {

bool SameNewsGroup(const NewsGroupIdentity& a, const NewsGroupIdentity& b) {
  return a.folderId == b.folderId && a.databaseSourceId == b.databaseSourceId &&
         a.incarnation == b.incarnation;
}

bool IsNewsBindingProperty(const nsACString& name) {
  return name.EqualsLiteral("newsArticleNumber") ||
         name.EqualsLiteral("newsGroupIncarnation");
}

nsresult SerializeNewsSet(nsMsgKeySet& set, nsCString& output) {
  char* text = nullptr;
  nsresult rv = set.Output(&text);
  if (NS_FAILED(rv)) {
    free(text);
    return rv;
  }
  NS_ENSURE_TRUE(text, NS_ERROR_OUT_OF_MEMORY);
  output.Assign(text);
  free(text);
  return NS_OK;
}

// The legacy parser/serializer canonicalizes article 0. Restore its explicit
// membership bit on owned storage; never use serialized emptiness as presence.
nsresult CloneNewsSet(nsMsgKeySet& source, RefPtr<nsMsgKeySet>& output) {
  bool zero = source.IsMember(0);
  nsCString text;
  MOZ_TRY(SerializeNewsSet(source, text));
  RefPtr<nsMsgKeySet> copy = nsMsgKeySet::Create(text.get());
  NS_ENSURE_TRUE(copy, NS_ERROR_OUT_OF_MEMORY);
  int result = zero ? copy->Add(0) : copy->Remove(0);
  NS_ENSURE_TRUE(result >= 0, NS_ERROR_OUT_OF_MEMORY);
  output = std::move(copy);
  return NS_OK;
}

}  // namespace

nsresult MessageDatabase::ReadNewsGroupIdentity(const nsACString& sourceId,
                                                uint64_t folderId,
                                                NewsGroupIdentity& output,
                                                bool create) {
  MOZ_TRY(RequireCurrentOwner());
  NS_ENSURE_TRUE(folderId && folderId <= INT64_MAX && !sourceId.IsEmpty(),
                 NS_ERROR_INVALID_ARG);
  nsCString current;
  MOZ_TRY(DatabaseCore::sInstance->ReadSourceIdForFolderAdmission(current));
  NS_ENSURE_TRUE(current == sourceId, NS_ERROR_NOT_AVAILABLE);
  NewsGroupIdentity result;
  result.databaseSourceId = current;
  result.folderId = folderId;
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "ReadNewsGroupIdentity"_ns,
        "SELECT f.flags,p.value,typeof(p.value) FROM folders f "
        "LEFT JOIN folder_properties p ON p.id=f.id "
        "AND p.name='newsGroupIncarnation' WHERE f.id=:folder"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
    int64_t flags;
    MOZ_TRY(stmt->GetInt64(0, &flags));
    NS_ENSURE_TRUE(flags & nsMsgFolderFlags::Newsgroup, NS_ERROR_NOT_AVAILABLE);
    nsCString type;
    MOZ_TRY(stmt->GetUTF8String(2, type));
    if (type.EqualsLiteral("text")) {
      MOZ_TRY(stmt->GetUTF8String(1, result.incarnation));
      NS_ENSURE_TRUE(!result.incarnation.IsEmpty(), NS_ERROR_FILE_CORRUPTED);
    } else {
      NS_ENSURE_TRUE(type.EqualsLiteral("null"), NS_ERROR_FILE_CORRUPTED);
      NS_ENSURE_TRUE(create, NS_ERROR_NOT_AVAILABLE);
    }
  }
  if (result.incarnation.IsEmpty()) {
    nsCOMPtr<nsIUUIDGenerator> generator = components::UUIDGenerator::Service();
    NS_ENSURE_TRUE(generator, NS_ERROR_FAILURE);
    nsID id;
    MOZ_TRY(generator->GenerateUUIDInPlace(&id));
    char value[NSID_LENGTH];
    id.ToProvidedString(value);
    result.incarnation.Assign(value);
  }
  output = std::move(result);
  return NS_OK;
}

nsresult MessageDatabase::GetNewsGroupIdentity(const nsACString& sourceId,
                                               uint64_t folderId,
                                               NewsGroupIdentity& output) {
  MOZ_TRY(RequireCommittedSearchRead());
  return ReadNewsGroupIdentity(sourceId, folderId, output, false);
}

nsresult MessageDatabase::ReadNewsReadSetForInitialization(
    const nsACString& sourceId, uint64_t folderId,
    const nsACString& exactFileSerialization, Maybe<bool>& zeroOverride) {
  MOZ_TRY(RequireCommittedSearchRead());
  NS_ENSURE_TRUE(folderId && folderId <= INT64_MAX && !sourceId.IsEmpty(),
                 NS_ERROR_INVALID_ARG);
  nsCString current;
  MOZ_TRY(DatabaseCore::sInstance->ReadSourceIdForFolderAdmission(current));
  NS_ENSURE_TRUE(current == sourceId, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ReadNewsInitialization"_ns,
      "SELECT f.flags,r.name IS NOT NULL,r.value,typeof(r.value),"
      "z.name IS NOT NULL,z.value,typeof(z.value),g.name IS NOT NULL,"
      "g.value,typeof(g.value) FROM folders f "
      "LEFT JOIN folder_properties r ON r.id=f.id AND r.name='readSet' "
      "LEFT JOIN folder_properties z ON z.id=f.id AND "
      "z.name='readSetContainsZero' "
      "LEFT JOIN folder_properties g ON g.id=f.id AND "
      "g.name='newsGroupIncarnation' "
      "WHERE f.id=:folder"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
  int64_t flags, hasRead, hasZero, hasGroup;
  MOZ_TRY(stmt->GetInt64(0, &flags));
  MOZ_TRY(stmt->GetInt64(1, &hasRead));
  MOZ_TRY(stmt->GetInt64(4, &hasZero));
  MOZ_TRY(stmt->GetInt64(7, &hasGroup));
  NS_ENSURE_TRUE(flags & nsMsgFolderFlags::Newsgroup, NS_ERROR_NOT_AVAILABLE);
  if (!hasRead) {
    NS_ENSURE_TRUE(!hasZero && !hasGroup, NS_ERROR_FILE_CORRUPTED);
    zeroOverride.reset();
    return NS_OK;
  }
  nsCString text, readType;
  MOZ_TRY(stmt->GetUTF8String(3, readType));
  NS_ENSURE_TRUE(readType.EqualsLiteral("text"), NS_ERROR_FILE_CORRUPTED);
  MOZ_TRY(stmt->GetUTF8String(2, text));
  if (hasGroup) {
    nsCString incarnation, groupType;
    MOZ_TRY(stmt->GetUTF8String(9, groupType));
    NS_ENSURE_TRUE(groupType.EqualsLiteral("text"), NS_ERROR_FILE_CORRUPTED);
    MOZ_TRY(stmt->GetUTF8String(8, incarnation));
    NS_ENSURE_TRUE(!incarnation.IsEmpty(), NS_ERROR_FILE_CORRUPTED);
  }
  Maybe<bool> result;
  if (hasZero) {
    NS_ENSURE_TRUE(hasGroup, NS_ERROR_FILE_CORRUPTED);
    nsCString zeroType;
    MOZ_TRY(stmt->GetUTF8String(6, zeroType));
    NS_ENSURE_TRUE(zeroType.EqualsLiteral("integer"), NS_ERROR_FILE_CORRUPTED);
    int64_t zero;
    MOZ_TRY(stmt->GetInt64(5, &zero));
    NS_ENSURE_TRUE(zero == 0 || zero == 1, NS_ERROR_FILE_CORRUPTED);
    if (text == exactFileSerialization) {
      result = Some(zero == 1);
    }
  }
  // A legacy readSet without the typed companion is unknown, even if empty.
  // Changed file ranges are incoming authority; never repair them by inference.
  zeroOverride = result;
  return NS_OK;
}

nsresult MessageDatabase::ReadNewsArticle(nsMsgKey key,
                                          Maybe<NewsArticleIdentity>& output) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ReadNewsArticle"_ns,
      "SELECT m.folderId,a.value,typeof(a.value),g.value,typeof(g.value) "
      "FROM messages m LEFT JOIN message_properties a ON a.id=m.id "
      "AND a.name='newsArticleNumber' LEFT JOIN message_properties g "
      "ON g.id=m.id AND g.name='newsGroupIncarnation' WHERE m.id=:key"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("key"_ns, key));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
  nsCString articleType, groupType;
  MOZ_TRY(stmt->GetUTF8String(2, articleType));
  MOZ_TRY(stmt->GetUTF8String(4, groupType));
  if (articleType.EqualsLiteral("null") && groupType.EqualsLiteral("null")) {
    output.reset();
    return NS_OK;
  }
  NS_ENSURE_TRUE(
      articleType.EqualsLiteral("integer") && groupType.EqualsLiteral("text"),
      NS_ERROR_FILE_CORRUPTED);
  int64_t folderId, article;
  MOZ_TRY(stmt->GetInt64(0, &folderId));
  MOZ_TRY(stmt->GetInt64(1, &article));
  NS_ENSURE_TRUE(folderId > 0 && article >= 0 && article <= INT32_MAX,
                 NS_ERROR_FILE_CORRUPTED);
  NewsArticleIdentity result;
  nsCString source;
  MOZ_TRY(DatabaseCore::sInstance->ReadSourceIdForFolderAdmission(source));
  MOZ_TRY(ReadNewsGroupIdentity(source, folderId, result.group, false));
  nsCString incarnation;
  MOZ_TRY(stmt->GetUTF8String(3, incarnation));
  NS_ENSURE_TRUE(incarnation == result.group.incarnation,
                 NS_ERROR_FILE_CORRUPTED);
  result.articleNumber = article;
  output = Some(std::move(result));
  return NS_OK;
}

nsresult MessageDatabase::GetNewsArticleKey(const NewsArticleIdentity& expected,
                                            nsMsgKey& physicalKey) {
  MOZ_TRY(RequireCommittedSearchRead());
  NS_ENSURE_TRUE(expected.articleNumber <= INT32_MAX, NS_ERROR_INVALID_ARG);
  NewsGroupIdentity current;
  MOZ_TRY(ReadNewsGroupIdentity(expected.group.databaseSourceId,
                                expected.group.folderId, current, false));
  NS_ENSURE_TRUE(SameNewsGroup(current, expected.group),
                 NS_ERROR_NOT_AVAILABLE);
  // Filter valid unrelated bindings in SQL, while still surfacing corruption
  // anywhere in the group. Do not re-read source/group identity for every row.
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "FindNewsArticle"_ns,
      "SELECT m.id,a.value,typeof(a.value),g.value,typeof(g.value) "
      "FROM messages m LEFT JOIN message_properties a ON a.id=m.id "
      "AND a.name='newsArticleNumber' LEFT JOIN message_properties g "
      "ON g.id=m.id AND g.name='newsGroupIncarnation' "
      "WHERE m.folderId=:folder "
      "AND (a.name IS NOT NULL OR g.name IS NOT NULL) "
      "AND (a.value=:article OR m.id<=0 OR m.id>=:invalidKey "
      "OR typeof(a.value)!='integer' OR a.value<0 OR a.value>:maxArticle "
      "OR typeof(g.value)!='text' OR g.value!=:incarnation) ORDER BY m.id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folder"_ns, current.folderId));
  MOZ_TRY(stmt->BindInt64ByName("article"_ns, expected.articleNumber));
  MOZ_TRY(stmt->BindInt64ByName("invalidKey"_ns, nsMsgKey_None));
  MOZ_TRY(stmt->BindInt64ByName("maxArticle"_ns, INT32_MAX));
  MOZ_TRY(stmt->BindUTF8StringByName("incarnation"_ns, current.incarnation));
  Maybe<nsMsgKey> found;
  while (true) {
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (!more) break;
    int64_t key;
    MOZ_TRY(stmt->GetInt64(0, &key));
    NS_ENSURE_TRUE(key > 0 && key < nsMsgKey_None, NS_ERROR_FILE_CORRUPTED);
    nsCString articleType, groupType;
    MOZ_TRY(stmt->GetUTF8String(2, articleType));
    MOZ_TRY(stmt->GetUTF8String(4, groupType));
    NS_ENSURE_TRUE(
        articleType.EqualsLiteral("integer") && groupType.EqualsLiteral("text"),
        NS_ERROR_FILE_CORRUPTED);
    int64_t article;
    MOZ_TRY(stmt->GetInt64(1, &article));
    NS_ENSURE_TRUE(article >= 0 && article <= INT32_MAX &&
                       article == int64_t(expected.articleNumber),
                   NS_ERROR_FILE_CORRUPTED);
    nsCString incarnation;
    MOZ_TRY(stmt->GetUTF8String(3, incarnation));
    NS_ENSURE_TRUE(incarnation == current.incarnation, NS_ERROR_FILE_CORRUPTED);
    NS_ENSURE_TRUE(!found, NS_ERROR_FILE_CORRUPTED);
    found = Some(nsMsgKey(key));
  }
  NS_ENSURE_TRUE(found, NS_ERROR_NOT_AVAILABLE);
  physicalKey = *found;
  return NS_OK;
}

nsresult MessageDatabase::PrepareNewsRecipients(PreparedNewsReadSet& prepared,
                                                PerFolderDatabase* replacing) {
  MOZ_TRY(SerializeNewsSet(*prepared.contents, prepared.checkpoint));
  for (const auto& binding : mNewsReadSets) {
    RefPtr<PerFolderDatabase> owner = binding->owner.get();
    if (!owner || owner == replacing ||
        !SameNewsGroup(binding->group, prepared.group)) {
      continue;
    }
    // Only a live, source-checked concrete facade permits slot dereference.
    MOZ_TRY(owner->CheckDatabaseSource());
    NS_ENSURE_TRUE(binding->slot && *binding->slot, NS_ERROR_NOT_AVAILABLE);
    RefPtr<nsMsgKeySet> contents;
    MOZ_TRY(CloneNewsSet(*prepared.contents, contents));
    PreparedNewsReadSetInstall recipient;
    MOZ_TRY(owner->PrepareNewsReadSetInstall(prepared.group, *binding->slot,
                                             contents, false, recipient));
    if (!prepared.recipients.AppendElement(std::move(recipient), fallible)) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
  }
  return NS_OK;
}

nsresult MessageDatabase::WriteNewsReadSets(
    const nsTArray<UniquePtr<PreparedNewsReadSet>>& prepared) {
  for (const auto& item : prepared) {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "WriteNewsReadSet"_ns,
        "REPLACE INTO folder_properties(id,name,value) VALUES "
        "(:folder,'readSet',:set),(:folder,'readSetContainsZero',:zero),"
        "(:folder,'newsGroupIncarnation',:group)"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, item->group.folderId));
    MOZ_TRY(stmt->BindUTF8StringByName("set"_ns, item->checkpoint));
    MOZ_TRY(
        stmt->BindInt64ByName("zero"_ns, item->contents->IsMember(0) ? 1 : 0));
    MOZ_TRY(stmt->BindUTF8StringByName("group"_ns, item->group.incarnation));
    MOZ_TRY(stmt->Execute());
  }
  return NS_OK;
}

void MessageDatabase::InstallNewsReadSets(
    nsTArray<UniquePtr<PreparedNewsReadSet>>& prepared) {
  for (auto& item : prepared) {
    for (auto& recipient : item->recipients) {
      recipient.mOwner->ApplyPreparedNewsReadSet(recipient);
    }
  }
}

nsresult MessageDatabase::PrepareNewsReadChanges(
    const nsTArray<CapturedMessage>& rows,
    nsTArray<UniquePtr<PreparedNewsReadSet>>& output) {
  nsTArray<UniquePtr<PreparedNewsReadSet>> prepared;
  for (const auto& row : rows) {
    Maybe<NewsArticleIdentity> article;
    MOZ_TRY(ReadNewsArticle(row.id, article));
    if (!article) {
      continue;
    }
    PreparedNewsReadSet* item = nullptr;
    for (auto& candidate : prepared) {
      if (SameNewsGroup(candidate->group, article->group)) {
        item = candidate.get();
        break;
      }
    }
    if (!item) {
      auto next = MakeUnique<PreparedNewsReadSet>();
      next->group = article->group;
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "ReadNewsCheckpoint"_ns,
          "SELECT r.value,typeof(r.value),z.value,typeof(z.value) "
          "FROM folder_properties r LEFT JOIN folder_properties z "
          "ON z.id=r.id AND z.name='readSetContainsZero' "
          "WHERE r.id=:folder AND r.name='readSet'"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("folder"_ns, article->group.folderId));
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
      nsCString checkpoint, readType, zeroType;
      MOZ_TRY(stmt->GetUTF8String(0, checkpoint));
      MOZ_TRY(stmt->GetUTF8String(1, readType));
      MOZ_TRY(stmt->GetUTF8String(3, zeroType));
      int64_t zero;
      MOZ_TRY(stmt->GetInt64(2, &zero));
      NS_ENSURE_TRUE(readType.EqualsLiteral("text") &&
                         zeroType.EqualsLiteral("integer") &&
                         (zero == 0 || zero == 1),
                     NS_ERROR_FILE_CORRUPTED);
      next->contents = nsMsgKeySet::Create(checkpoint.get());
      NS_ENSURE_TRUE(next->contents, NS_ERROR_OUT_OF_MEMORY);
      NS_ENSURE_TRUE(
          (zero ? next->contents->Add(0) : next->contents->Remove(0)) >= 0,
          NS_ERROR_OUT_OF_MEMORY);
      item = next.get();
      if (!prepared.AppendElement(std::move(next), fallible)) {
        return NS_ERROR_OUT_OF_MEMORY;
      }
    }
    int result = row.flags & nsMsgMessageFlags::Read
                     ? item->contents->Add(article->articleNumber)
                     : item->contents->Remove(article->articleNumber);
    NS_ENSURE_TRUE(result >= 0, NS_ERROR_OUT_OF_MEMORY);
  }
  for (auto& item : prepared) {
    MOZ_TRY(PrepareNewsRecipients(*item));
  }
  output = std::move(prepared);
  return NS_OK;
}

void MessageDatabase::DetachNewsReadSet(PerFolderDatabase& owner,
                                        nsMsgKeySet*& installed) {
  mNewsReadSets.RemoveElementsBy([&](const auto& binding) {
    return binding->identity == &owner && binding->slot == &installed;
  });
  installed = nullptr;
}

nsresult MessageDatabase::SetNewsReadSet(
    const nsACString& sourceId, uint64_t folderId, PerFolderDatabase& owner,
    nsMsgKeySet* proposed, nsMsgKeySet*& installed,
    const Maybe<nsCString>& serializedNewsrc) {
  if (!proposed) {
    DetachNewsReadSet(owner, installed);
    return NS_OK;
  }
  MOZ_TRY(RequireCommittedSearchRead());
  MOZ_TRY(owner.CheckDatabaseSource());
  NS_ENSURE_TRUE(owner.mIsNewsFolder && owner.mFolderId == folderId &&
                     owner.mDatabaseSourceId == sourceId &&
                     &installed == &owner.mNewsReadSet,
                 NS_ERROR_NOT_AVAILABLE);
  RefPtr<PerFolderDatabase> pin = &owner;
  RefPtr<nsMsgKeySet> incoming = proposed;
  auto item = MakeUnique<PreparedNewsReadSet>();
  MOZ_TRY(ReadNewsGroupIdentity(sourceId, folderId, item->group, true));
  MOZ_TRY(CloneNewsSet(*incoming, item->contents));
  if (serializedNewsrc) {
    Maybe<bool> zeroOverride;
    MOZ_TRY(ReadNewsReadSetForInitialization(sourceId, folderId,
                                             *serializedNewsrc, zeroOverride));
    if (zeroOverride) {
      int changed =
          *zeroOverride ? item->contents->Add(0) : item->contents->Remove(0);
      NS_ENSURE_TRUE(changed >= 0, NS_ERROR_OUT_OF_MEMORY);
    }
  }
  MOZ_TRY(PrepareNewsRecipients(*item, &owner));
  PreparedNewsReadSetInstall attach;
  RefPtr<nsMsgKeySet> contents;
  MOZ_TRY(CloneNewsSet(*item->contents, contents));
  MOZ_TRY(owner.PrepareNewsReadSetInstall(item->group, proposed, contents, true,
                                          attach));
  NS_ENSURE_TRUE(item->recipients.AppendElement(std::move(attach), fallible),
                 NS_ERROR_OUT_OF_MEMORY);
  auto binding = MakeUnique<NewsReadSetBinding>();
  binding->owner = &owner;
  binding->identity = &owner;
  binding->slot = &installed;
  binding->group = item->group;
  NS_ENSURE_TRUE(
      mNewsReadSets.SetCapacity(mNewsReadSets.Length() + 1, fallible),
      NS_ERROR_OUT_OF_MEMORY);
  nsTArray<UniquePtr<PreparedNewsReadSet>> prepared;
  NS_ENSURE_TRUE(prepared.AppendElement(std::move(item), fallible),
                 NS_ERROR_OUT_OF_MEMORY);
  UniquePtr<QueuedMessageBatch> notification;
  MOZ_TRY(PrepareMessageBatch(notification));
  notification->kind = QueuedMessageBatch::Kind::Flags;
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    nsTArray<nsMsgKey> keys;
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "NewsReadSetRows"_ns,
          "SELECT id FROM messages WHERE folderId=:folder ORDER BY id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
      while (true) {
        bool more;
        MOZ_TRY(stmt->ExecuteStep(&more));
        if (!more) break;
        int64_t key;
        MOZ_TRY(stmt->GetInt64(0, &key));
        NS_ENSURE_TRUE(key > 0 && key < nsMsgKey_None, NS_ERROR_FILE_CORRUPTED);
        NS_ENSURE_TRUE(keys.AppendElement(nsMsgKey(key), fallible),
                       NS_ERROR_OUT_OF_MEMORY);
      }
    }
    for (nsMsgKey key : keys) {
      Maybe<NewsArticleIdentity> article;
      MOZ_TRY(ReadNewsArticle(key, article));
      if (!article) continue;
      NS_ENSURE_TRUE(SameNewsGroup(article->group, binding->group),
                     NS_ERROR_NOT_AVAILABLE);
      QueuedMessageBatch::Flags change;
      MOZ_TRY(CaptureMessage(key, change.before));
      uint32_t flags = change.before.flags & ~nsMsgMessageFlags::Read;
      if (prepared[0]->contents->IsMember(article->articleNumber))
        flags |= nsMsgMessageFlags::Read;
      if (flags == change.before.flags) continue;
      RefPtr<DetachedMsgHdr> old;
      MOZ_TRY(ChangeHeader(change.before, old));
      change.oldHeader = old;
      change.live = new (fallible) Message(key);
      NS_ENSURE_TRUE(change.live, NS_ERROR_OUT_OF_MEMORY);
      {
        nsCOMPtr<mozIStorageStatement> stmt;
        MOZ_TRY(DatabaseCore::GetStatement(
            "NewsReconcileRead"_ns,
            "UPDATE messages SET flags=:flags WHERE id=:id"_ns,
            getter_AddRefs(stmt)));
        mozStorageStatementScoper scope(stmt);
        MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
        MOZ_TRY(stmt->BindInt64ByName("flags"_ns, flags));
        MOZ_TRY(stmt->Execute());
      }
      MOZ_TRY(CaptureMessage(key, change.after));
      NS_ENSURE_TRUE(
          notification->flagChanges.AppendElement(std::move(change), fallible),
          NS_ERROR_OUT_OF_MEMORY);
    }
    MOZ_TRY(WriteNewsReadSets(prepared));
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) return RollbackMessageChange(connection, rv);
  // No allocation, SQL or external code after commit until every recipient and
  // persistent slot/cache is installed. Notifications may reenter afterwards.
  InstallNewsReadSets(prepared);
  for (const auto& change : notification->flagChanges) {
    auto entry = mMsgCache.lookup(change.after.id);
    if (entry) entry->value().flags = change.after.flags;
  }
  mNewsReadSets.RemoveElementsBy([&](const auto& old) {
    return !old->owner || old->owner.get() == &owner;
  });
  installed = proposed;
  mNewsReadSets.AppendElement(std::move(binding));
  if (!notification->flagChanges.IsEmpty())
    QueueMessageBatch(std::move(notification));
  return NS_OK;
}

nsresult MessageDatabase::AddNewsArticle(const NewsArticleIdentity& expected,
                                         const ::RawHdr& parsed,
                                         bool notifyLegacy,
                                         NewsArticleResult& output,
                                         nsIMsgDBHdr** liveHeader,
                                         const Maybe<bool>& readIntent) {
  NS_ENSURE_TRUE(!liveHeader || !*liveHeader, NS_ERROR_INVALID_ARG);
  MOZ_TRY(RequireCommittedSearchRead());
  NS_ENSURE_TRUE(expected.articleNumber <= INT32_MAX, NS_ERROR_INVALID_ARG);
  nsMsgKey existing;
  nsresult rv = GetNewsArticleKey(expected, existing);
  if (NS_SUCCEEDED(rv)) {
    RefPtr<Message> message = new (fallible) Message(existing);
    NS_ENSURE_TRUE(message, NS_ERROR_OUT_OF_MEMORY);
    nsCOMPtr<nsIMsgDBHdr> owningHeader = message.get();
    output = {false, existing, message};
    if (liveHeader) {
      owningHeader.forget(liveHeader);
    }
    return NS_OK;
  }
  NS_ENSURE_TRUE(rv == NS_ERROR_NOT_AVAILABLE, rv);
  NewsGroupIdentity current;
  MOZ_TRY(ReadNewsGroupIdentity(expected.group.databaseSourceId,
                                expected.group.folderId, current, false));
  NS_ENSURE_TRUE(SameNewsGroup(current, expected.group),
                 NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "NewsArticleCheckpoint"_ns,
      "SELECT r.value,typeof(r.value),z.value,typeof(z.value) "
      "FROM folder_properties r JOIN folder_properties z ON z.id=r.id "
      "AND z.name='readSetContainsZero' WHERE r.id=:folder AND r.name='readSet'"_ns,
      getter_AddRefs(stmt)));
  nsCString checkpoint, readType, zeroType;
  int64_t zero;
  {
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, current.folderId));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(stmt->GetUTF8String(0, checkpoint));
    MOZ_TRY(stmt->GetUTF8String(1, readType));
    MOZ_TRY(stmt->GetInt64(2, &zero));
    MOZ_TRY(stmt->GetUTF8String(3, zeroType));
  }
  NS_ENSURE_TRUE(readType.EqualsLiteral("text") &&
                     zeroType.EqualsLiteral("integer") &&
                     (zero == 0 || zero == 1),
                 NS_ERROR_FILE_CORRUPTED);
  RefPtr<nsMsgKeySet> set = nsMsgKeySet::Create(checkpoint.get());
  NS_ENSURE_TRUE(set, NS_ERROR_OUT_OF_MEMORY);
  NS_ENSURE_TRUE((zero ? set->Add(0) : set->Remove(0)) >= 0,
                 NS_ERROR_OUT_OF_MEMORY);
  // RawHdr owns move-only ordered arrays. Borrow the complete parsed input;
  // only the typed Read word is resolved for the existing insertion path.
  const Maybe<bool> insertionRead =
      readIntent.isSome() ? readIntent
                          : Some(set->IsMember(expected.articleNumber));
  nsMsgKey key;
  return InsertMessage(current.folderId, parsed, false, notifyLegacy, &key,
                       nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
                       &expected, &output, liveHeader, &insertionRead);
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

NS_IMETHODIMP
MessageDatabase::GetSearchState(nsMsgKey key, JSContext* cx,
                                JS::MutableHandle<JS::Value> result) {
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
  MOZ_TRY(DatabaseCore::sInstance->CheckFolderRelocationRecovery(folderId));
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
  if (DatabaseCore::sInstance->HasFailedFolderRelocationRecovery()) {
    nsCOMPtr<mozIStorageStatement> folders;
    MOZ_TRY(DatabaseCore::GetStatement(
        "ReadMessageRecoveryFolder"_ns,
        "SELECT folderId FROM messages WHERE id=:id UNION SELECT folderId "
        "FROM staged_messages WHERE id=:id"_ns,
        getter_AddRefs(folders)));
    mozStorageStatementScoper reset(folders);
    MOZ_TRY(folders->BindInt64ByName("id"_ns, key));
    bool more;
    MOZ_TRY(folders->ExecuteStep(&more));
    if (more) {
      int32_t type;
      int64_t folder;
      MOZ_TRY(folders->GetTypeOfIndex(0, &type));
      MOZ_TRY(folders->GetInt64(0, &folder));
      NS_ENSURE_TRUE(
          type == mozIStorageStatement::VALUE_TYPE_INTEGER && folder > 0,
          NS_ERROR_FILE_CORRUPTED);
      MOZ_TRY(folders->ExecuteStep(&more));
      NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
      MOZ_TRY(DatabaseCore::sInstance->CheckFolderRelocationRecovery(folder));
    }
  }
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
  UniquePtr<QueuedMessageBatch> notification;
  MOZ_TRY(PrepareMessageBatch(notification));
  notification->kind = QueuedMessageBatch::Kind::Body;
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
        CapturedMessage prior;
        MOZ_TRY(CaptureMessage(actual.key, prior));
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
        auto* change = notification->bodies.AppendElement(fallible);
        NS_ENSURE_TRUE(change, NS_ERROR_OUT_OF_MEMORY);
        change->before = std::move(prior);
        MOZ_TRY(CaptureMessage(live.LastElement()->Key(), change->after));
        change->oldBody = std::move(before.LastElement());
        change->newBody = std::move(after.LastElement());
        change->oldHeader = oldHeaders.LastElement();
        change->live = live.LastElement();
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
  if (!notification->bodies.IsEmpty()) {
    QueueMessageBatch(std::move(notification));
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
  // InsertMessage uses signed32 flags; later flag writes use unsigned32.
  NS_ENSURE_TRUE(flags >= INT32_MIN && flags <= int64_t(UINT32_MAX),
                 NS_ERROR_FILE_CORRUPTED);
  for (int64_t quantity : {size, offlineSize, lines}) {
    NS_ENSURE_TRUE(quantity >= 0 && uint64_t(quantity) <= UINT32_MAX,
                   NS_ERROR_FILE_CORRUPTED);
  }
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

nsresult MessageDatabase::ReadFolderRepairState(
    uint64_t folderId, const nsACString& databaseSourceId,
    FolderRepairSnapshot::Data& output) {
  MOZ_TRY(RequireCurrentOwner());
  NS_ENSURE_TRUE(
      folderId && folderId <= INT64_MAX && !databaseSourceId.IsEmpty(),
      NS_ERROR_INVALID_ARG);
  MOZ_TRY(CheckPendingFolderRelocation(folderId));
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "FolderRepairIdentity"_ns,
        "SELECT f.parent,f.name,d.sourceId,p.value,typeof(p.value) "
        "FROM folders f JOIN database_identity d ON d.singleton=1 "
        "LEFT JOIN folder_properties p ON p.id=f.id AND p.name='summaryValid' "
        "WHERE f.id=:folder"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
    int64_t parent, valid;
    nsCString source, type;
    MOZ_TRY(stmt->GetInt64(0, &parent));
    MOZ_TRY(stmt->GetUTF8String(1, output.name));
    MOZ_TRY(stmt->GetUTF8String(2, source));
    MOZ_TRY(stmt->GetInt64(3, &valid));
    MOZ_TRY(stmt->GetUTF8String(4, type));
    NS_ENSURE_TRUE(parent >= 0, NS_ERROR_FILE_CORRUPTED);
    NS_ENSURE_TRUE(source == databaseSourceId &&
                       type.EqualsLiteral("integer") && valid == 0,
                   NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
    output.parent = static_cast<uint64_t>(parent);
  }
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "FolderRepairPendingStage"_ns,
        "SELECT 1 FROM staged_messages WHERE folderId=:folder LIMIT 1"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_FALSE(more, NS_ERROR_IN_PROGRESS);
  }
  nsTArray<nsMsgKey> keys;
  MOZ_TRY(ListAllKeys(folderId, keys));
  keys.Sort();
  if (!output.messages.SetCapacity(keys.Length(), fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  nsTHashSet<nsCStringHashKey> tokens;
  for (nsMsgKey key : keys) {
    MessageBodyState body;
    MOZ_TRY(ReadMessageBodyState(key, body));
    NS_ENSURE_TRUE(body.folderId == folderId &&
                       body.databaseSourceId == databaseSourceId &&
                       body.storeToken && !body.storeToken->IsEmpty() &&
                       !tokens.Contains(*body.storeToken),
                   NS_ERROR_NOT_AVAILABLE);
    tokens.Insert(*body.storeToken);
    output.messages.AppendElement(std::move(body));
  }
  output.owner = this;
  output.sourceId = databaseSourceId;
  output.folderId = folderId;
  return NS_OK;
}

nsresult MessageDatabase::CaptureFolderRepair(
    uint64_t folderId, const nsACString& databaseSourceId,
    FolderRepairSnapshot& output) {
  MOZ_TRY(RequireCommittedSearchRead());
  // The experimental aggregate is not activated or silently approximated here.
  NS_ENSURE_FALSE(mConversationGroupingEnabled, NS_ERROR_NOT_AVAILABLE);
  auto captured = UniquePtr<FolderRepairSnapshot::Data>(
      new (fallible) FolderRepairSnapshot::Data());
  NS_ENSURE_TRUE(captured, NS_ERROR_OUT_OF_MEMORY);
  RefPtr<MessageDatabase> self(this);
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = ReadFolderRepairState(folderId, databaseSourceId, *captured);
  if (NS_SUCCEEDED(rv)) rv = connection->CommitTransaction();
  if (NS_FAILED(rv)) return RollbackMessageChange(connection, rv);
  output.mData = std::move(captured);
  return NS_OK;
}

nsresult MessageDatabase::CompleteFolderRepair(
    FolderRepairSnapshot& snapshot,
    const nsTArray<FolderRepairMessage>& messages, nsresult scanStatus,
    bool scanComplete, nsTArray<RefPtr<Message>>& output) {
  // The scanner's original first error outranks a later cleanup/owner error.
  NS_ENSURE_SUCCESS(scanStatus, scanStatus);
  NS_ENSURE_TRUE(scanComplete, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(RequireCommittedSearchRead());
  NS_ENSURE_TRUE(snapshot.mData && snapshot.mData->owner.get() == this &&
                     !mConversationGroupingEnabled,
                 NS_ERROR_NOT_AVAILABLE);
  const auto& saved = *snapshot.mData;
  RefPtr<MessageDatabase> self(this);
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  nsTArray<RefPtr<Message>> result;
  nsTArray<UniquePtr<CachedMsg>> cached;
  nsTArray<Maybe<uint32_t>> matches;
  if (!result.SetLength(messages.Length(), fallible) ||
      !cached.SetLength(messages.Length(), fallible) ||
      !matches.SetLength(messages.Length(), fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  // CachedMsg contains inline strings and must not be memmoved by nsTArray.
  for (auto& row : cached) {
    row.reset(new (fallible) CachedMsg());
    NS_ENSURE_TRUE(row, NS_ERROR_OUT_OF_MEMORY);
  }
  UniquePtr<QueuedMessageBatch> notification;
  MOZ_TRY(PrepareMessageBatch(notification));
  notification->kind = QueuedMessageBatch::Kind::Repair;
  notification->notifyLegacy = false;
  if (!notification->repairs.SetLength(messages.Length(), fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    FolderRepairSnapshot::Data actual;
    MOZ_TRY(ReadFolderRepairState(saved.folderId, saved.sourceId, actual));
    NS_ENSURE_TRUE(actual.parent == saved.parent && actual.name == saved.name &&
                       actual.messages.Length() == saved.messages.Length(),
                   NS_ERROR_NOT_AVAILABLE);
    nsTHashMap<nsCStringHashKey, uint32_t> existing;
    for (uint32_t i = 0; i < saved.messages.Length(); ++i) {
      const auto& before = saved.messages[i];
      const auto& now = actual.messages[i];
      NS_ENSURE_TRUE(
          now.key == before.key && now.storeToken == before.storeToken &&
              now.contentRevision == before.contentRevision &&
              now.locationRevision == before.locationRevision &&
              now.messageSize == before.messageSize &&
              now.offlineMessageSize == before.offlineMessageSize &&
              now.lineCount == before.lineCount &&
              !((now.flags ^ before.flags) & nsMsgMessageFlags::Offline),
          NS_ERROR_NOT_AVAILABLE);
      existing.InsertOrUpdate(*before.storeToken, i);
    }
    nsTHashSet<nsCStringHashKey> scanned;
    for (uint32_t i = 0; i < messages.Length(); ++i) {
      const auto& item = messages[i];
      NS_ENSURE_TRUE(item.parsed && !item.storeToken.IsEmpty() &&
                         item.messageSize <= UINT32_MAX &&
                         !scanned.Contains(item.storeToken),
                     NS_ERROR_INVALID_ARG);
      const auto& header = *item.parsed;
      NS_ENSURE_TRUE(
          (item.referencesKnown || header.references.IsEmpty()) &&
              (!header.storeToken || *header.storeToken == item.storeToken) &&
              (!header.messageSize ||
               *header.messageSize == item.messageSize) &&
              (!header.lineCount || *header.lineCount == item.lineCount),
          NS_ERROR_INVALID_ARG);
      scanned.Insert(item.storeToken);
      if (auto match = existing.Lookup(item.storeToken)) {
        matches[i] = Some(match.Data());
      } else {
        NS_ENSURE_FALSE(header.flags & nsMsgMessageFlags::Expunged,
                        NS_ERROR_INVALID_ARG);
      }
    }
    for (const auto& before : saved.messages) {
      NS_ENSURE_TRUE(scanned.Contains(*before.storeToken),
                     NS_ERROR_NOT_AVAILABLE);
    }
    for (uint32_t i = 0; i < messages.Length(); ++i) {
      const auto& item = messages[i];
      const auto& parsed = *item.parsed;
      auto& row = *cached[i];
      auto& repaired = notification->repairs[i];
      auto& change = repaired.change;
      repaired.added = !matches[i];
      if (matches[i]) {
        change.oldBody = actual.messages[*matches[i]];
        MOZ_TRY(FetchMsg(change.oldBody.key, row));
        MOZ_TRY(CaptureMessage(row.key, change.before));
        RefPtr<DetachedMsgHdr> old;
        MOZ_TRY(ChangeHeader(change.before, old));
        change.oldHeader = old;
      } else {
        MOZ_TRY(DatabaseCore::GetNextMessageKey(row.key));
        row.folderId = saved.folderId;
        row.threadId = row.key;
        row.threadParent = 0;
        row.flags = parsed.flags;
        row.priority = parsed.priority;
        row.tags = parsed.keywords;
        for (const auto& extra : parsed.extras) {
          NS_ENSURE_FALSE(extra.k.EqualsLiteral("uidOnServer"),
                          NS_ERROR_INVALID_ARG);
          if (extra.k.EqualsLiteral("keywords")) row.tags = extra.v;
        }
      }
      row.messageId = MOZ_TRY(DatabaseUtils::Normalize(parsed.messageId));
      row.date = parsed.date;
      row.sender = MOZ_TRY(DatabaseUtils::Normalize(parsed.sender));
      row.recipients = MOZ_TRY(DatabaseUtils::Normalize(parsed.recipients));
      row.ccList = MOZ_TRY(DatabaseUtils::Normalize(parsed.ccList));
      row.bccList = MOZ_TRY(DatabaseUtils::Normalize(parsed.bccList));
      row.subject = MOZ_TRY(DatabaseUtils::Normalize(parsed.subject));
      {
        nsCOMPtr<mozIStorageStatement> stmt;
        MOZ_TRY(DatabaseCore::GetStatement(
            repaired.added ? "InsertFolderRepairMessage"_ns
                           : "UpdateFolderRepairMessage"_ns,
            repaired.added ? "INSERT INTO messages("_ns MESSAGE_SQL_FIELDS
                             ") VALUES "
                             "(:id,:folder,:thread,:parent,:messageId,:date,:"
                             "sender,:recipients,"
                             ":cc,:bcc,:subject,:flags,:tags,:priority)"_ns
                           : "UPDATE messages SET "
                             "messageId=:messageId,date=:date,sender=:sender,"
                             "recipients=:recipients,ccList=:cc,bccList=:bcc,"
                             "subject=:subject "
                             "WHERE id=:id"_ns,
            getter_AddRefs(stmt)));
        mozStorageStatementScoper scope(stmt);
        MOZ_TRY(stmt->BindInt64ByName("id"_ns, row.key));
        MOZ_TRY(stmt->BindUTF8StringByName("messageId"_ns, row.messageId));
        MOZ_TRY(stmt->BindInt64ByName("date"_ns, row.date));
        MOZ_TRY(stmt->BindUTF8StringByName("sender"_ns, row.sender));
        MOZ_TRY(stmt->BindUTF8StringByName("recipients"_ns, row.recipients));
        MOZ_TRY(stmt->BindUTF8StringByName("cc"_ns, row.ccList));
        MOZ_TRY(stmt->BindUTF8StringByName("bcc"_ns, row.bccList));
        MOZ_TRY(stmt->BindUTF8StringByName("subject"_ns, row.subject));
        if (repaired.added) {
          MOZ_TRY(stmt->BindInt64ByName("folder"_ns, row.folderId));
          MOZ_TRY(stmt->BindInt64ByName("thread"_ns, row.threadId));
          MOZ_TRY(stmt->BindInt64ByName("parent"_ns, row.threadParent));
          MOZ_TRY(stmt->BindInt64ByName("flags"_ns, row.flags));
          MOZ_TRY(stmt->BindUTF8StringByName("tags"_ns, row.tags));
          MOZ_TRY(stmt->BindInt32ByName("priority"_ns, row.priority));
        }
        MOZ_TRY(stmt->Execute());
      }
      if (item.referencesKnown) {
        MOZ_TRY(
            WriteMessageReferencesInTransaction(row.key, parsed.references));
      } else {
        for (const auto& sql :
             {"DELETE FROM message_references WHERE id=:id"_ns,
              "DELETE FROM message_reference_sets WHERE id=:id"_ns}) {
          nsCOMPtr<mozIStorageStatement> stmt;
          MOZ_TRY(connection->CreateStatement(sql, getter_AddRefs(stmt)));
          mozStorageStatementScoper scope(stmt);
          MOZ_TRY(stmt->BindInt64ByName("id"_ns, row.key));
          MOZ_TRY(stmt->Execute());
        }
      }
      if (repaired.added) {
        if (!parsed.replyTo.IsEmpty())
          MOZ_TRY(SetMessageProperty(row.key, "replyTo"_ns, parsed.replyTo));
        if (!parsed.charset.IsEmpty())
          MOZ_TRY(SetMessageProperty(row.key, "msgCharSet"_ns, parsed.charset));
        if (!parsed.accountKey.IsEmpty())
          MOZ_TRY(SetMessageProperty(row.key, "account"_ns, parsed.accountKey));
        if (parsed.dateReceived) {
          uint32_t seconds;
          PRTime2Seconds(parsed.dateReceived, &seconds);
          nsAutoCString value;
          value.AppendInt(seconds, 16);
          MOZ_TRY(SetMessageProperty(row.key, "dateReceived"_ns, value));
        }
        for (const auto& extra : parsed.extras) {
          if (!extra.k.EqualsLiteral("keywords"))
            MOZ_TRY(SetMessageProperty(row.key, extra.k, extra.v));
        }
        MOZ_TRY(SetMessageProperty(row.key, "storeToken"_ns, item.storeToken));
        if (parsed.offlineMessageSize)
          MOZ_TRY(SetMessageProperty(row.key, "offlineMessageSize"_ns,
                                     *parsed.offlineMessageSize));
      }
      MOZ_TRY(SetMessageProperty(row.key, "messageSize"_ns,
                                 uint32_t(item.messageSize)));
      MOZ_TRY(SetMessageProperty(row.key, "lineCount"_ns, item.lineCount));
      // Existing user flags, tags, priority and all other properties are not
      // copied from the on-disk parser draft.
    }
    for (uint32_t i = 0; i < messages.Length(); ++i) {
      auto& row = *cached[i];
      auto& change = notification->repairs[i].change;
      if (notification->repairs[i].added &&
          !messages[i].parsed->references.IsEmpty()) {
        const auto& refs = messages[i].parsed->references;
        nsMsgKey root = MOZ_TRY(FindByMessageId(refs[0]));
        nsMsgKey parent = MOZ_TRY(FindByMessageId(refs.LastElement()));
        row.threadId = root && root != row.key ? root : row.key;
        row.threadParent = parent != row.key ? parent : 0;
        nsCOMPtr<mozIStorageStatement> stmt;
        MOZ_TRY(DatabaseCore::GetStatement(
            "FolderRepairNewThread"_ns,
            "UPDATE messages SET threadId=:thread,threadParent=:parent WHERE id=:id"_ns,
            getter_AddRefs(stmt)));
        mozStorageStatementScoper scope(stmt);
        MOZ_TRY(stmt->BindInt64ByName("id"_ns, row.key));
        MOZ_TRY(stmt->BindInt64ByName("thread"_ns, row.threadId));
        MOZ_TRY(stmt->BindInt64ByName("parent"_ns, row.threadParent));
        MOZ_TRY(stmt->Execute());
      }
      MOZ_TRY(CaptureMessage(row.key, change.after));
      MOZ_TRY(ReadMessageBodyState(row.key, change.newBody));
      change.live = new (fallible) Message(row.key);
      NS_ENSURE_TRUE(change.live, NS_ERROR_OUT_OF_MEMORY);
      result[i] = change.live;
    }
    auto capacity = CheckedInt<size_t>(mMsgCache.count()) + messages.Length();
    NS_ENSURE_TRUE(capacity.isValid() && mMsgCache.reserve(capacity.value()),
                   NS_ERROR_OUT_OF_MEMORY);
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "CompleteFolderRepairSummary"_ns,
          "INSERT INTO folder_properties(id,name,value) VALUES "
          "(:folder,'summaryValid',1),(:folder,'forceReparse',0) "
          "ON CONFLICT(id,name) DO UPDATE SET value=excluded.value"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("folder"_ns, saved.folderId));
      MOZ_TRY(stmt->Execute());
    }
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) return RollbackMessageChange(connection, rv);
  for (auto& row : cached) {
    auto entry = mMsgCache.lookup(row->key);
    if (entry)
      entry->value() = std::move(*row);
    else
      mMsgCache.putNewInfallible(row->key, std::move(*row));
  }
  snapshot.mData = nullptr;
  output = std::move(result);
  QueueMessageBatch(std::move(notification));
  return NS_OK;
}

nsresult MessageDatabase::SettleMessageBody(const MessageBodyState& expected,
                                            const FinishedMessageBody& finished,
                                            MessageBodyState& output) {
  return SettleMessageBodyInternal(expected, finished, nullptr, output);
}

nsresult MessageDatabase::CompletePartialMessage(
    const MessageBodyState& expected, const RawHdr& parsed,
    const FinishedMessageBody& finished, MessageBodyState& output) {
  return SettleMessageBodyInternal(expected, finished, &parsed, output);
}

nsresult MessageDatabase::SettleMessageBodyInternal(
    const MessageBodyState& expected, const FinishedMessageBody& finished,
    const RawHdr* parsed, MessageBodyState& output) {
  MOZ_TRY(RequireCommittedSearchRead());
  MOZ_TRY(CheckMessageBodyAccess(expected.key));
  RefPtr<MessageDatabase> self(this);
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MessageBodyState before, after, callerResult;
  CachedMsg cached;
  RefPtr<DetachedMsgHdr> oldMessage;
  RefPtr<Message> message;
  UniquePtr<QueuedMessageBatch> notification;
  MOZ_TRY(PrepareMessageBatch(notification));
  notification->kind = QueuedMessageBatch::Kind::Body;
  if (!notification->bodies.SetLength(1, fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    MOZ_TRY(ReadMessageBodyState(expected.key, before));
    MOZ_TRY(CaptureMessage(expected.key, notification->bodies[0].before));
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
    NS_ENSURE_TRUE(!parsed || (before.flags & nsMsgMessageFlags::Partial),
                   NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(FetchMsg(expected.key, cached));
    oldMessage = new DetachedMsgHdr(before.folderId);
    MOZ_TRY(oldMessage->SetMessageId(cached.messageId));
    MOZ_TRY(oldMessage->SetAuthor(cached.sender));
    MOZ_TRY(oldMessage->SetRecipients(cached.recipients));
    MOZ_TRY(oldMessage->SetCcList(cached.ccList));
    MOZ_TRY(oldMessage->SetBccList(cached.bccList));
    MOZ_TRY(oldMessage->SetPriority(cached.priority));
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
    if (parsed) {
      cached.messageId = MOZ_TRY(DatabaseUtils::Normalize(parsed->messageId));
      cached.date = parsed->date;
      cached.sender = MOZ_TRY(DatabaseUtils::Normalize(parsed->sender));
      cached.recipients = MOZ_TRY(DatabaseUtils::Normalize(parsed->recipients));
      cached.ccList = MOZ_TRY(DatabaseUtils::Normalize(parsed->ccList));
      cached.bccList = MOZ_TRY(DatabaseUtils::Normalize(parsed->bccList));
      cached.subject = MOZ_TRY(DatabaseUtils::Normalize(parsed->subject));
      cached.priority = parsed->priority;
      if (!parsed->replyTo.IsEmpty()) {
        MOZ_TRY(
            SetMessageProperty(expected.key, "replyTo"_ns, parsed->replyTo));
      }
      if (!parsed->charset.IsEmpty()) {
        MOZ_TRY(
            SetMessageProperty(expected.key, "msgCharSet"_ns, parsed->charset));
      }
      if (!parsed->accountKey.IsEmpty()) {
        MOZ_TRY(
            SetMessageProperty(expected.key, "account"_ns, parsed->accountKey));
      }
      if (parsed->dateReceived) {
        uint32_t seconds;
        PRTime2Seconds(parsed->dateReceived, &seconds);
        nsAutoCString text;
        text.AppendInt(seconds, 16);
        MOZ_TRY(SetMessageProperty(expected.key, "dateReceived"_ns, text));
      }
      for (const auto& extra : parsed->extras) {
        if (extra.k.EqualsLiteral("keywords")) {
          cached.tags = extra.v;
        } else {
          MOZ_TRY(SetMessageProperty(expected.key, extra.k, extra.v));
        }
      }
      MOZ_TRY(WriteMessageReferencesInTransaction(expected.key,
                                                  parsed->references));
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "CompletePartialMetadata"_ns,
          "UPDATE messages SET messageId=:messageId,date=:date,sender=:sender,"
          "recipients=:recipients,ccList=:ccList,bccList=:bccList,subject=:"
          "subject,"
          "priority=:priority,tags=:tags WHERE id=:id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, expected.key));
      MOZ_TRY(stmt->BindUTF8StringByName("messageId"_ns, cached.messageId));
      MOZ_TRY(stmt->BindInt64ByName("date"_ns, cached.date));
      MOZ_TRY(stmt->BindUTF8StringByName("sender"_ns, cached.sender));
      MOZ_TRY(stmt->BindUTF8StringByName("recipients"_ns, cached.recipients));
      MOZ_TRY(stmt->BindUTF8StringByName("ccList"_ns, cached.ccList));
      MOZ_TRY(stmt->BindUTF8StringByName("bccList"_ns, cached.bccList));
      MOZ_TRY(stmt->BindUTF8StringByName("subject"_ns, cached.subject));
      MOZ_TRY(stmt->BindInt32ByName("priority"_ns, cached.priority));
      MOZ_TRY(stmt->BindUTF8StringByName("tags"_ns, cached.tags));
      MOZ_TRY(stmt->Execute());
    }
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
    cached.flags =
        (before.flags & ~(nsMsgMessageFlags::Offline |
                          (parsed ? nsMsgMessageFlags::Partial : 0))) |
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
    message = new (fallible) Message(expected.key);
    NS_ENSURE_TRUE(message, NS_ERROR_OUT_OF_MEMORY);
    auto& change = notification->bodies[0];
    MOZ_TRY(CaptureMessage(expected.key, change.after));
    change.oldBody = before;
    change.newBody = after;
    change.oldHeader = oldMessage;
    change.live = message;
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
  QueueMessageBatch(std::move(notification));
  return NS_OK;
}

NS_IMETHODIMP
MessageDatabase::GetSearchChanges(uint64_t after, uint32_t limit, JSContext* cx,
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

NS_IMETHODIMP
MessageDatabase::GetSearchSnapshot(nsMsgKey after, uint32_t limit,
                                   JSContext* cx,
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
  MOZ_LOG(gPanoramaLog, LogLevel::Debug,
          ("Message content changed key=%u", key));
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

nsresult MessageDatabase::InsertMessage(
    uint64_t aFolderId, const ::RawHdr& header, bool staged, bool notifyLegacy,
    nsMsgKey* aKey, Message** liveHeader, RemovedMessage* restoring,
    const FinishedMessageBody* finished, OfflineOperationUndo* offline,
    const PendingDestination* cancelMove, OfflineOperationUndo* redo,
    const NewsArticleIdentity* news, NewsArticleResult* newsOutput,
    nsIMsgDBHdr** newsLiveHeader, const Maybe<bool>* newsReadIntent) {
  NS_ENSURE_ARG_POINTER(aKey);
  NS_ENSURE_TRUE(!newsLiveHeader || (news && newsOutput && !*newsLiveHeader),
                 NS_ERROR_INVALID_ARG);
  if (staged) {
    NS_ENSURE_TRUE(aFolderId && aFolderId <= INT64_MAX, NS_ERROR_INVALID_ARG);
  }
  MOZ_TRY(RequireCurrentOwner());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool inTransaction;
  MOZ_TRY(connection->GetTransactionInProgress(&inTransaction));
  if (inTransaction) {
    return NS_ERROR_IN_PROGRESS;
  }

  MOZ_TRY(CheckFolderBodyAccess(aFolderId));

  nsMsgKey threadId = 0;
  nsMsgKey parentId = 0;
  if (!staged && !mConversationGroupingEnabled &&
      !header.references.IsEmpty()) {
    threadId = MOZ_TRY(FindByMessageId(header.references[0]));
    parentId = MOZ_TRY(FindByMessageId(header.references.LastElement()));
  }

  CachedMsg cached;
  RefPtr<Message> message;
  nsCOMPtr<nsIMsgDBHdr> owningNewsHeader;
  UniquePtr<QueuedMessageBatch> notification;
  MessageThreadBatch captured;
  OfflineOperationUndo canceledState;
  nsTArray<UniquePtr<PreparedNewsReadSet>> newsPrepared;
  if (!staged) {
    MOZ_TRY(PrepareMessageBatch(notification));
    notification->notifyLegacy = notifyLegacy;
  }
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    if (!staged && mConversationGroupingEnabled) {
      MOZ_TRY(CaptureThreadViewsBeforeInsert(*notification));
    }
    if (staged || restoring) {
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
    if (restoring) {
      const auto& body = restoring->mData->body;
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "RequireUndoTombstone"_ns,
          "SELECT sequence,deleted FROM message_changes "
          "WHERE messageId=:id ORDER BY sequence DESC LIMIT 1"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, body.key));
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
      int64_t sequence, deleted;
      MOZ_TRY(stmt->GetInt64(0, &sequence));
      MOZ_TRY(stmt->GetInt64(1, &deleted));
      NS_ENSURE_TRUE(
          deleted == 1 && sequence == restoring->mData->deletionSequence,
          NS_ERROR_NOT_AVAILABLE);
      bool exists;
      MOZ_TRY(MessageExists(body.key, exists));
      NS_ENSURE_FALSE(exists, NS_ERROR_NOT_AVAILABLE);
    }
    nsMsgKey allocated;
    MOZ_TRY(DatabaseCore::GetNextMessageKey(allocated));
    if (newsLiveHeader) {
      message = new (fallible) Message(allocated);
      NS_ENSURE_TRUE(message, NS_ERROR_OUT_OF_MEMORY);
      owningNewsHeader = message;
    }
    if (staged) {
      nsCOMPtr<mozIStorageStatement> parent;
      MOZ_TRY(
          DatabaseCore::GetStatement("FindStagedMessageParent"_ns,
                                     "SELECT m.id,m.threadId FROM messages m "
                                     "JOIN folders f ON f.id=m.folderId WHERE "
                                     "m.messageId=:token COLLATE BINARY "
                                     "AND m.id<>:key ORDER BY m.id LIMIT 1"_ns,
                                     getter_AddRefs(parent)));
      for (uint32_t ordinal = header.references.Length(); ordinal;) {
        const auto& token = header.references[--ordinal];
        if (token.IsEmpty()) {
          continue;
        }
        mozStorageStatementScoper scope(parent);
        MOZ_TRY(parent->BindUTF8StringByName("token"_ns, token));
        MOZ_TRY(parent->BindInt64ByName("key"_ns, allocated));
        bool more;
        MOZ_TRY(parent->ExecuteStep(&more));
        if (!more) {
          continue;
        }
        int64_t physical, thread;
        MOZ_TRY(parent->GetInt64(0, &physical));
        MOZ_TRY(parent->GetInt64(1, &thread));
        NS_ENSURE_TRUE(physical > 0 && physical < nsMsgKey_None && thread > 0 &&
                           thread < nsMsgKey_None,
                       NS_ERROR_FILE_CORRUPTED);
        parentId = static_cast<nsMsgKey>(physical);
        threadId = static_cast<nsMsgKey>(thread);
        break;
      }
    }
    {
      nsCString messageId =
          restoring ? header.messageId
                    : MOZ_TRY(DatabaseUtils::Normalize(header.messageId));
      nsCString sender = restoring
                             ? header.sender
                             : MOZ_TRY(DatabaseUtils::Normalize(header.sender));
      nsCString recipients =
          restoring ? header.recipients
                    : MOZ_TRY(DatabaseUtils::Normalize(header.recipients));
      nsCString ccList = restoring
                             ? header.ccList
                             : MOZ_TRY(DatabaseUtils::Normalize(header.ccList));
      nsCString bccList =
          restoring ? header.bccList
                    : MOZ_TRY(DatabaseUtils::Normalize(header.bccList));
      nsCString subject =
          restoring ? header.subject
                    : MOZ_TRY(DatabaseUtils::Normalize(header.subject));
      nsCString tags = restoring
                           ? header.keywords
                           : MOZ_TRY(DatabaseUtils::Normalize(header.keywords));
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
      uint32_t flags =
          restoring ? (header.flags & ~(nsMsgMessageFlags::Expunged |
                                        nsMsgMessageFlags::Offline)) |
                          (finished->offline ? nsMsgMessageFlags::Offline : 0)
                    : header.flags;
      // A keyless news filter records presence separately from its raw word.
      // Only the typed insertion route may override the checkpoint default.
      if (news && newsReadIntent && newsReadIntent->isSome()) {
        flags &= ~nsMsgMessageFlags::Read;
        if (**newsReadIntent) {
          flags |= nsMsgMessageFlags::Read;
        }
      }
      MOZ_TRY(stmt->BindInt32ByName("flags"_ns, flags));
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

    if (restoring) {
      if (restoring->mData->referencesKnown) {
        MOZ_TRY(
            WriteMessageReferencesInTransaction(cached.key, header.references));
      }
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "RestoreMessageProperties"_ns,
          "INSERT INTO message_properties(id,name,value) VALUES(:id,:name,:value)"_ns,
          getter_AddRefs(stmt)));
      for (const auto& property : restoring->mData->properties) {
        // A server binding belongs to the old physical row, not its restored
        // copy.
        if (property.name.EqualsLiteral("uidOnServer") ||
            IsNewsBindingProperty(property.name)) {
          continue;
        }
        mozStorageStatementScoper scope(stmt);
        MOZ_TRY(stmt->BindInt64ByName("id"_ns, cached.key));
        MOZ_TRY(stmt->BindUTF8StringByName("name"_ns, property.name));
        if (property.integer) {
          MOZ_TRY(stmt->BindInt64ByName("value"_ns, *property.integer));
        } else {
          MOZ_TRY(stmt->BindUTF8StringByName("value"_ns, property.text));
        }
        MOZ_TRY(stmt->Execute());
      }
      MOZ_TRY(SetMessageProperty(cached.key, "storeToken"_ns,
                                 finished->storeToken));
      MOZ_TRY(SetMessageProperty(cached.key, "messageSize"_ns,
                                 finished->messageSize));
      MOZ_TRY(SetMessageProperty(cached.key, "offlineMessageSize"_ns,
                                 finished->offlineMessageSize));
      MOZ_TRY(
          SetMessageProperty(cached.key, "lineCount"_ns, finished->lineCount));
    } else {
      MOZ_TRY(
          WriteMessageReferencesInTransaction(cached.key, header.references));

      if (!header.replyTo.IsEmpty()) {
        MOZ_TRY(SetMessageProperty(cached.key, "replyTo"_ns, header.replyTo));
      }
      if (!header.charset.IsEmpty()) {
        MOZ_TRY(
            SetMessageProperty(cached.key, "msgCharSet"_ns, header.charset));
      }
      if (!header.accountKey.IsEmpty()) {
        MOZ_TRY(
            SetMessageProperty(cached.key, "account"_ns, header.accountKey));
      }
      if (header.dateReceived != 0) {
        uint32_t seconds;
        PRTime2Seconds(header.dateReceived, &seconds);
        nsAutoCString text;
        text.AppendInt(seconds, 16);
        MOZ_TRY(SetMessageProperty(cached.key, "dateReceived"_ns, text));
      }
      for (const auto& extra : header.extras) {
        if (!extra.k.EqualsLiteral("keywords") &&
            !IsNewsBindingProperty(extra.k)) {
          MOZ_TRY(SetMessageProperty(cached.key, extra.k, extra.v));
        }
      }
      // Only the new native storage inputs override matching extras.
      if (header.messageSize) {
        MOZ_TRY(SetMessageProperty(cached.key, "messageSize"_ns,
                                   *header.messageSize));
      }
      if (header.storeToken) {
        MOZ_TRY(SetMessageProperty(cached.key, "storeToken"_ns,
                                   *header.storeToken));
      }
      if (header.offlineMessageSize) {
        MOZ_TRY(SetMessageProperty(cached.key, "offlineMessageSize"_ns,
                                   *header.offlineMessageSize));
      }
      if (header.lineCount) {
        MOZ_TRY(
            SetMessageProperty(cached.key, "lineCount"_ns, *header.lineCount));
      }
    }

    if (news) {
      NS_ENSURE_TRUE(!staged && !restoring && newsOutput &&
                         news->articleNumber <= INT32_MAX,
                     NS_ERROR_INVALID_ARG);
      NewsGroupIdentity current;
      MOZ_TRY(ReadNewsGroupIdentity(news->group.databaseSourceId, aFolderId,
                                    current, false));
      NS_ENSURE_TRUE(SameNewsGroup(current, news->group),
                     NS_ERROR_NOT_AVAILABLE);
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "BindNewsArticle"_ns,
          "INSERT INTO message_properties(id,name,value) VALUES "
          "(:id,'newsArticleNumber',:article),(:id,'newsGroupIncarnation',:group)"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, cached.key));
      MOZ_TRY(stmt->BindInt64ByName("article"_ns, news->articleNumber));
      MOZ_TRY(stmt->BindUTF8StringByName("group"_ns, current.incarnation));
      MOZ_TRY(stmt->Execute());
    }

    if (offline) {
      if (cancelMove) {
        MOZ_TRY(ValidateOfflineUndoState(*offline->mData));
      }
      MOZ_TRY(RestoreOfflineOperationInTransaction(aFolderId, cached.key,
                                                   *restoring, *offline));
      if (cancelMove) {
        MOZ_TRY(CancelOfflineMoveInTransaction(
            aFolderId, cached.key, *cancelMove, *offline, canceledState));
      }
    }
    if (!staged) {
      if (mConversationGroupingEnabled) {
        MOZ_TRY(PrepareConversationBatch(cached.key, notifyLegacy,
                                         *notification, captured));
        for (const auto& row : captured.after) {
          if (row.id == cached.key) {
            cached.threadId = row.threadId;
            cached.threadParent = row.threadParent;
          }
        }
      } else {
        MOZ_TRY(CaptureMessage(cached.key, notification->after));
      }
    }
    if (news) {
      CapturedMessage row;
      MOZ_TRY(CaptureMessage(cached.key, row));
      nsTArray<CapturedMessage> rows;
      NS_ENSURE_TRUE(rows.AppendElement(std::move(row), fallible),
                     NS_ERROR_OUT_OF_MEMORY);
      MOZ_TRY(PrepareNewsReadChanges(rows, newsPrepared));
      MOZ_TRY(WriteNewsReadSets(newsPrepared));
    }
    if (!mMsgCache.reserve(mMsgCache.count() + 1)) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
    if (!message) {
      message = new (fallible) Message(cached.key);
      NS_ENSURE_TRUE(message, NS_ERROR_OUT_OF_MEMORY);
    }
    if (notification) {
      notification->live = message;
      if (notification->kind == QueuedMessageBatch::Kind::Thread) {
        for (auto& delivery : notification->deliveries) {
          delivery.prepared.publicationLive = message;
        }
      }
    }
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
  if (!staged && mConversationGroupingEnabled) {
    InstallThreadCache(captured);
  }
  nsMsgKey key = cached.key;
  auto entry = mMsgCache.lookup(key);
  if (entry) {
    entry->value() = std::move(cached);
  } else {
    mMsgCache.putNewInfallible(key, std::move(cached));
  }
  InstallNewsReadSets(newsPrepared);
  if (newsOutput) {
    *newsOutput = {true, key, message};
  }
  if (newsLiveHeader) {
    owningNewsHeader.forget(newsLiveHeader);
  }
  *aKey = key;
  if (liveHeader) {
    RefPtr<Message> result = message;
    result.forget(liveHeader);
  }
  if (restoring) {
    restoring->mData.reset();
  }
  if (offline) {
    if (redo) {
      offline->mData->redoState = std::move(canceledState.mData);
      redo->mData = std::move(offline->mData);
    } else {
      offline->mData.reset();
    }
  }
  if (notification) {
    QueueMessageBatch(std::move(notification));
  }
  return NS_OK;
}

nsresult MessageDatabase::SetStagedHeaderAttributes(
    const nsACString& databaseSourceId, const PendingDestination& target,
    const nsTArray<PendingHeaderAttribute>& attributes,
    const Maybe<FinishedMessageBody>& finished) {
  NS_ENSURE_TRUE(target.folderId && target.folderId <= INT64_MAX &&
                     target.key && target.key < nsMsgKey_None,
                 NS_ERROR_INVALID_ARG);
  MOZ_TRY(RequireCommittedSearchRead());
  MOZ_TRY(CheckPendingFolderRelocation(target.folderId));
  RefPtr<MessageDatabase> self(this);
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  nsCString currentSourceId;
  MOZ_TRY(DatabaseCore::sInstance->GetSourceId(currentSourceId));
  NS_ENSURE_TRUE(currentSourceId == databaseSourceId, NS_ERROR_NOT_AVAILABLE);
  CachedMsg cached;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    uint32_t epoch;
    MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(
        target.folderId, epoch));
    NS_ENSURE_TRUE(epoch == target.epoch, NS_ERROR_NOT_AVAILABLE);
    bool staged, published;
    MOZ_TRY(IsMessageStaged(target.key, staged));
    NS_ENSURE_TRUE(staged, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(MessageExists(target.key, published));
    NS_ENSURE_FALSE(published, NS_ERROR_FILE_CORRUPTED);
    MOZ_TRY(FetchMsg(target.key, cached));
    NS_ENSURE_TRUE(cached.folderId == target.folderId, NS_ERROR_NOT_AVAILABLE);
    uint32_t originalFlags = cached.flags;
    Maybe<uint32_t> queuedFlags;
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "PendingHeaderInFlight"_ns,
          "SELECT 1 FROM offline_attempts WHERE destinationKey=:id "
          "AND state IN(1,2,3) UNION ALL SELECT 1 FROM "
          "staged_message_properties "
          "WHERE id=:id AND name='uidOnServer' LIMIT 1"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, target.key));
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_FALSE(more, NS_ERROR_IN_PROGRESS);
    }
    for (const auto& attribute : attributes) {
      NS_ENSURE_TRUE(!attribute.integer || attribute.text.IsEmpty(),
                     NS_ERROR_INVALID_ARG);
      if (attribute.name.EqualsLiteral("uidOnServer")) {
        // Only checked server confirmation may establish this binding.
        return NS_ERROR_NOT_AVAILABLE;
      }
      if (attribute.name.EqualsLiteral("storeToken")) {
        NS_ENSURE_TRUE(finished, NS_ERROR_NOT_AVAILABLE);
        NS_ENSURE_TRUE(
            !attribute.integer && attribute.text == finished->storeToken,
            NS_ERROR_INVALID_ARG);
        continue;
      }
      const uint32_t* size = nullptr;
      if (attribute.name.EqualsLiteral("messageSize")) {
        if (finished) size = &finished->messageSize;
      } else if (attribute.name.EqualsLiteral("offlineMsgSize") ||
                 attribute.name.EqualsLiteral("offlineMessageSize")) {
        if (finished) size = &finished->offlineMessageSize;
      } else if (attribute.name.EqualsLiteral("lineCount")) {
        if (finished) size = &finished->lineCount;
      } else if (attribute.name.EqualsLiteral("flags")) {
        NS_ENSURE_TRUE(attribute.integer && *attribute.integer <= UINT32_MAX,
                       NS_ERROR_ILLEGAL_VALUE);
        queuedFlags = Some(static_cast<uint32_t>(*attribute.integer));
        continue;
      } else if (attribute.name.EqualsLiteral("priority")) {
        uint64_t priority;
        if (attribute.integer) {
          priority = *attribute.integer;
        } else {
          // The existing IMAP producer supplies one decimal priority digit.
          NS_ENSURE_TRUE(attribute.text.Length() == 1 &&
                             attribute.text[0] >= '0' &&
                             attribute.text[0] <= '6',
                         NS_ERROR_INVALID_ARG);
          priority = attribute.text[0] - '0';
        }
        NS_ENSURE_TRUE(priority <= nsMsgPriority::highest,
                       NS_ERROR_ILLEGAL_VALUE);
        cached.priority = static_cast<nsMsgPriorityValue>(priority);
        continue;
      } else {
        nsAutoCString text;
        if (attribute.integer) {
          text.AppendInt(*attribute.integer, 16);
        } else {
          text = attribute.text;
        }
        if (attribute.name.EqualsLiteral("keywords")) {
          cached.tags = text;
        } else {
          MOZ_TRY(SetMessageProperty(target.key, attribute.name, text));
        }
        continue;
      }
      NS_ENSURE_TRUE(finished, NS_ERROR_NOT_AVAILABLE);
      NS_ENSURE_TRUE(size && attribute.integer && *attribute.integer == *size,
                     NS_ERROR_INVALID_ARG);
    }
    if (queuedFlags) {
      cached.flags |= *queuedFlags;
    }
    if (finished) {
      // A queued source flag cannot contradict the finished destination body.
      NS_ENSURE_TRUE(
          !(cached.flags & nsMsgMessageFlags::Offline) || finished->offline,
          NS_ERROR_INVALID_ARG);
      MOZ_TRY(SetMessageProperty(target.key, "storeToken"_ns,
                                 finished->storeToken));
      MOZ_TRY(SetMessageProperty(target.key, "messageSize"_ns,
                                 finished->messageSize));
      MOZ_TRY(SetMessageProperty(target.key, "offlineMessageSize"_ns,
                                 finished->offlineMessageSize));
      MOZ_TRY(
          SetMessageProperty(target.key, "lineCount"_ns, finished->lineCount));
      if (finished->offline) cached.flags |= nsMsgMessageFlags::Offline;
    } else {
      NS_ENSURE_TRUE(
          !((cached.flags & ~originalFlags) & nsMsgMessageFlags::Offline),
          NS_ERROR_NOT_AVAILABLE);
    }
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "SetPendingHeaderFields"_ns,
          "UPDATE staged_messages SET flags=:flags,tags=:tags,priority=:priority WHERE id=:id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, target.key));
      MOZ_TRY(stmt->BindInt64ByName("flags"_ns, cached.flags));
      MOZ_TRY(stmt->BindUTF8StringByName("tags"_ns, cached.tags));
      MOZ_TRY(stmt->BindInt32ByName("priority"_ns, cached.priority));
      MOZ_TRY(stmt->Execute());
    }
    if (!mMsgCache.reserve(mMsgCache.count() + 1))
      return NS_ERROR_OUT_OF_MEMORY;
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) return RollbackBody(connection, rv);
  auto entry = mMsgCache.lookup(target.key);
  if (entry)
    entry->value() = std::move(cached);
  else
    mMsgCache.putNewInfallible(target.key, std::move(cached));
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
  MOZ_TRY(RequireCurrentOwner());
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
  MOZ_TRY(RequireCurrentOwner());
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

nsresult MessageDatabase::ConsumeProtoThreadFlagsInTransaction(
    nsMsgKey key, uint64_t folderId, nsMsgKey threadId) {
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_TRUE(active, NS_ERROR_IN_PROGRESS);

  nsAutoCString text;
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "ReadPublishedProtoThreadFlags"_ns,
        "SELECT value FROM message_properties "
        "WHERE id=:id AND name='ProtoThreadFlags'"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (!more) {
      return NS_OK;
    }
    MOZ_TRY(stmt->GetUTF8String(0, text));
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  }
  // This is an ordinary header uint32 property, not a decimal storage field.
  uint32_t pending = static_cast<uint32_t>(
      MsgUnhex(text.get(), std::min<uint32_t>(8, text.Length())));
  if (!pending) {
    // Do not manufacture a property or normalize an existing empty/zero value.
    return NS_OK;
  }
  uint32_t flags;
  MOZ_TRY(GetThreadFlags(folderId, threadId, flags));
  {
    // SetThreadFlags deliberately rejects active caller transactions. This
    // private write belongs to the publication that just inserted this member.
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "PublishProtoThreadFlags"_ns,
        "INSERT INTO thread_flags(folderId,threadId,flags) "
        "SELECT :folder,:thread,:flags WHERE EXISTS(SELECT 1 FROM messages "
        "WHERE folderId=:folder AND threadId=:thread) "
        "ON CONFLICT(folderId,threadId) DO UPDATE SET flags=excluded.flags "
        "RETURNING folderId"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
    MOZ_TRY(stmt->BindInt64ByName("thread"_ns, threadId));
    MOZ_TRY(stmt->BindInt64ByName("flags"_ns, flags | pending));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  }
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ConsumePublishedProtoThreadFlags"_ns,
      "UPDATE message_properties SET value='0' "
      "WHERE id=:id AND name='ProtoThreadFlags' RETURNING id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  return NS_OK;
}

nsresult MessageDatabase::PublishOnlineTransferDestination(
    const OnlineTransferDestination& expected, uint32_t observedEpoch,
    uint32_t observedUid, bool notifyLegacy, ServerMessageLocation& mapping,
    Message** liveHeader) {
  NS_ENSURE_ARG_POINTER(liveHeader);
  NS_ENSURE_FALSE(*liveHeader, NS_ERROR_INVALID_ARG);
  const auto& target = expected.destination;
  NS_ENSURE_TRUE(!expected.databaseSourceId.IsEmpty() && target.folderId &&
                     target.folderId <= INT64_MAX && target.key &&
                     target.key < nsMsgKey_None && target.epochKnown &&
                     observedEpoch && observedUid &&
                     target.epoch == observedEpoch,
                 NS_ERROR_INVALID_ARG);
  // Listener preparation can reenter. Never borrow a caller's mutable input
  // through that preparation or the synchronous postcommit fanout.
  OnlineTransferDestination selected(expected);
  return PublishMessageInternal(target.key, notifyLegacy, liveHeader, &selected,
                                observedEpoch, observedUid, &mapping);
}

nsresult MessageDatabase::ValidateOnlineTransferDestination(
    const OnlineTransferDestination& expected, uint32_t epoch,
    const Maybe<uint32_t>& uid, bool staged) {
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_TRUE(active, NS_ERROR_UNEXPECTED);
  const auto& target = expected.destination;
  // This private validator runs only inside our publication transaction.
  // Keep relocation/recovery fences without asking that owned transaction to
  // satisfy the public committed-reader guard.
  MOZ_TRY(CheckPendingFolderRelocation(target.folderId));
  uint32_t currentEpoch;
  MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(
      target.folderId, currentEpoch));
  NS_ENSURE_TRUE(currentEpoch == epoch, NS_ERROR_NOT_AVAILABLE);
  uint32_t flags;
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        staged ? "OnlineStagedDestination"_ns : "OnlinePublishedDestination"_ns,
        staged ? "SELECT m.folderId,m.flags,d.sourceId FROM staged_messages m "
                 "JOIN database_identity d ON d.singleton=1 WHERE m.id=:key"_ns
               : "SELECT m.folderId,m.flags,d.sourceId FROM messages m "
                 "JOIN database_identity d ON d.singleton=1 WHERE m.id=:key"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("key"_ns, target.key));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
    int64_t folder, storedFlags;
    nsCString source;
    MOZ_TRY(stmt->GetInt64(0, &folder));
    MOZ_TRY(stmt->GetInt64(1, &storedFlags));
    MOZ_TRY(stmt->GetUTF8String(2, source));
    NS_ENSURE_TRUE(folder > 0 && uint64_t(folder) == target.folderId &&
                       source == expected.databaseSourceId,
                   NS_ERROR_NOT_AVAILABLE);
    NS_ENSURE_TRUE(
        storedFlags >= INT32_MIN && storedFlags <= int64_t(UINT32_MAX),
        NS_ERROR_FILE_CORRUPTED);
    flags = static_cast<uint32_t>(storedFlags);
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  }
  {
    // Even Pending and held imports own their destination. No ordinary-online
    // entry point may promote that custody, including orphaned old attempts.
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "OnlineDestinationQueuedCustody"_ns,
        "SELECT 1 FROM offline_operations WHERE messageKey=:key "
        "OR destinationKey=:key UNION ALL SELECT 1 FROM "
        "offline_copy_destinations WHERE destinationKey=:key UNION ALL "
        "SELECT 1 FROM offline_attempts WHERE destinationKey=:key OR "
        "sourceKey=:key UNION ALL SELECT 1 FROM imap_import_operation_holds "
        "WHERE messageKey=:key LIMIT 1"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("key"_ns, target.key));
    bool claimed;
    MOZ_TRY(stmt->ExecuteStep(&claimed));
    NS_ENSURE_FALSE(claimed, NS_ERROR_NOT_AVAILABLE);
  }
  Maybe<nsCString> token;
  Maybe<uint32_t> size, offlineSize, lines, actualUid;
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        staged ? "OnlineStagedBody"_ns : "OnlinePublishedBody"_ns,
        staged ? "SELECT name,value FROM staged_message_properties "
                 "WHERE id=:key AND name IN('storeToken','messageSize',"
                 "'offlineMessageSize','lineCount','uidOnServer')"_ns
               : "SELECT name,value FROM message_properties WHERE id=:key "
                 "AND name IN('storeToken','messageSize','offlineMessageSize',"
                 "'lineCount','uidOnServer')"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("key"_ns, target.key));
    while (true) {
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      if (!more) break;
      nsCString name;
      MOZ_TRY(stmt->GetUTF8String(0, name));
      int32_t type;
      MOZ_TRY(stmt->GetTypeOfIndex(1, &type));
      if (name.EqualsLiteral("storeToken")) {
        NS_ENSURE_TRUE(type == mozIStorageValueArray::VALUE_TYPE_TEXT,
                       NS_ERROR_FILE_CORRUPTED);
        nsCString text;
        MOZ_TRY(stmt->GetUTF8String(1, text));
        token = Some(std::move(text));
      } else if (name.EqualsLiteral("uidOnServer")) {
        // Message::SetUint32Property stores ordinary header properties as
        // hexadecimal TEXT. Body sizes and line counts use native INTEGERs.
        NS_ENSURE_TRUE(type == mozIStorageValueArray::VALUE_TYPE_TEXT,
                       NS_ERROR_FILE_CORRUPTED);
        nsCString text;
        MOZ_TRY(stmt->GetUTF8String(1, text));
        NS_ENSURE_TRUE(!text.IsEmpty() && text.Length() <= 8,
                       NS_ERROR_FILE_CORRUPTED);
        for (uint32_t i = 0; i < text.Length(); ++i) {
          char digit = text.CharAt(i);
          NS_ENSURE_TRUE(
              (digit >= '0' && digit <= '9') || (digit >= 'a' && digit <= 'f'),
              NS_ERROR_FILE_CORRUPTED);
        }
        uint32_t value =
            static_cast<uint32_t>(MsgUnhex(text.get(), text.Length()));
        nsAutoCString canonical;
        canonical.AppendInt(value, 16);
        NS_ENSURE_TRUE(text == canonical, NS_ERROR_FILE_CORRUPTED);
        actualUid = Some(value);
      } else {
        NS_ENSURE_TRUE(type == mozIStorageValueArray::VALUE_TYPE_INTEGER,
                       NS_ERROR_FILE_CORRUPTED);
        int64_t value;
        MOZ_TRY(stmt->GetInt64(1, &value));
        NS_ENSURE_TRUE(value >= 0 && value <= UINT32_MAX,
                       NS_ERROR_FILE_CORRUPTED);
        auto number = Some(static_cast<uint32_t>(value));
        if (name.EqualsLiteral("messageSize")) size = number;
        if (name.EqualsLiteral("offlineMessageSize")) offlineSize = number;
        if (name.EqualsLiteral("lineCount")) lines = number;
      }
    }
  }
  NS_ENSURE_TRUE(actualUid == uid, NS_ERROR_NOT_AVAILABLE);
  if (expected.finished) {
    const auto& finished = *expected.finished;
    NS_ENSURE_TRUE(
        !finished.storeToken.IsEmpty() && token == Some(finished.storeToken) &&
            size == Some(finished.messageSize) &&
            offlineSize == Some(finished.offlineMessageSize) &&
            lines == Some(finished.lineCount) &&
            bool(flags & nsMsgMessageFlags::Offline) == finished.offline,
        NS_ERROR_NOT_AVAILABLE);
  } else {
    NS_ENSURE_TRUE(expected.sourceLocation && expected.sourceBody && !token &&
                       !offlineSize && !lines &&
                       !(flags & nsMsgMessageFlags::Offline),
                   NS_ERROR_NOT_AVAILABLE);
  }
  NS_ENSURE_TRUE(!expected.sourceLocation || expected.sourceBody,
                 NS_ERROR_INVALID_ARG);
  if (expected.sourceBody) {
    const auto& source = *expected.sourceBody;
    NS_ENSURE_TRUE(source.key != target.key &&
                       source.databaseSourceId == expected.databaseSourceId,
                   NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(CheckPendingMessageRelocation(source.key));
    MessageBodyState current;
    MOZ_TRY(ReadMessageBodyState(source.key, current));
    NS_ENSURE_TRUE(SameBodyGuard(current, source), NS_ERROR_NOT_AVAILABLE);
    if (expected.sourceLocation) {
      const auto& location = *expected.sourceLocation;
      NS_ENSURE_TRUE(location.key == source.key &&
                         location.folderId == source.folderId &&
                         location.epoch && location.uid,
                     NS_ERROR_INVALID_ARG);
      nsMsgKey found;
      MOZ_TRY(GetMessageKeyForServerUid(location.folderId, location.epoch,
                                        location.uid, found));
      NS_ENSURE_TRUE(found == source.key, NS_ERROR_NOT_AVAILABLE);
    }
  }
  if (uid) {
    // Also recheck all published/staged aliases after listener preparation.
    // This is read-only for the exact UID property already installed above.
    MOZ_TRY(BindMessageToServerUidInTransaction(target.key, target.folderId,
                                                epoch, *uid, true));
  }
  return NS_OK;
}

nsresult MessageDatabase::PublishMessage(nsMsgKey key, bool notifyLegacy,
                                         Message** liveHeader) {
  return PublishMessageInternal(key, notifyLegacy, liveHeader);
}

nsresult MessageDatabase::PublishMessageInternal(
    nsMsgKey key, bool notifyLegacy, Message** liveHeader,
    const OnlineTransferDestination* online, uint32_t epoch, uint32_t uid,
    ServerMessageLocation* mapping) {
  MOZ_TRY(RequireCurrentOwner());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool active;
  MOZ_TRY(connection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  CachedMsg cached;
  RefPtr<Message> message;
  UniquePtr<QueuedMessageBatch> notification;
  MOZ_TRY(PrepareMessageBatch(notification));
  notification->notifyLegacy = notifyLegacy;
  MessageThreadBatch captured;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    bool staged;
    MOZ_TRY(IsMessageStaged(key, staged));
    NS_ENSURE_TRUE(staged, NS_ERROR_NOT_AVAILABLE);
    if (online) {
      MOZ_TRY(
          ValidateOnlineTransferDestination(*online, epoch, Nothing(), true));
      MOZ_TRY(BindMessageToServerUidInTransaction(
          key, online->destination.folderId, epoch, uid, true));
      MOZ_TRY(
          ValidateOnlineTransferDestination(*online, epoch, Some(uid), true));
    }
    MOZ_TRY(FetchMsg(key, cached));
    if (mConversationGroupingEnabled) {
      MOZ_TRY(CaptureThreadViewsBeforeInsert(*notification));
    }
    cached.threadId = key;
    cached.threadParent = 0;
    if (!mConversationGroupingEnabled) {
      nsTArray<nsCString> references;
      MOZ_TRY(GetMessageReferences(key, references));
      if (!references.IsEmpty()) {
        nsMsgKey root = MOZ_TRY(FindByMessageId(references[0]));
        if (root) {
          cached.threadId = root;
        }
        cached.threadParent =
            MOZ_TRY(FindByMessageId(references.LastElement()));
      }
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
    if (mConversationGroupingEnabled) {
      MOZ_TRY(PrepareConversationBatch(key, notifyLegacy, *notification,
                                       captured, true));
      for (const auto& row : captured.after) {
        if (row.id == key) {
          cached.threadId = row.threadId;
          cached.threadParent = row.threadParent;
        }
      }
    } else {
      MOZ_TRY(ConsumeProtoThreadFlagsInTransaction(key, cached.folderId,
                                                   cached.threadId));
      MOZ_TRY(CaptureMessage(key, notification->after));
    }
    if (!mMsgCache.reserve(mMsgCache.count() + 1)) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
    message = new (fallible) Message(key);
    NS_ENSURE_TRUE(message, NS_ERROR_OUT_OF_MEMORY);
    notification->live = message;
    if (notification->kind == QueuedMessageBatch::Kind::Thread) {
      for (auto& delivery : notification->deliveries) {
        delivery.prepared.publicationLive = message;
      }
    }
    if (online) {
      MOZ_TRY(
          ValidateOnlineTransferDestination(*online, epoch, Some(uid), false));
    }
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
  if (mConversationGroupingEnabled) {
    InstallThreadCache(captured);
  }
  auto entry = mMsgCache.lookup(key);
  if (entry) {
    entry->value() = std::move(cached);
  } else {
    mMsgCache.putNewInfallible(key, std::move(cached));
  }
  if (online) {
    *mapping = {online->destination.folderId, key, epoch, uid};
  }
  if (liveHeader) {
    RefPtr<Message> result = message;
    result.forget(liveHeader);
  }
  QueueMessageBatch(std::move(notification));
  return NS_OK;
}

namespace {

using OfflineOp = nsIMsgOfflineImapOperation;

// Private postbinding provenance in the existing property table. Ordinary
// header writers may read it but cannot mint or replace this native stamp.
constexpr char kAcceptedAppendObservationProperty[] =
    "panoramaAcceptedAppendObservation";

nsCString AcceptedAppendObservationStamp(const OfflineAttempt& attempt,
                                         uint32_t epoch, uint32_t uid,
                                         uint64_t locationRevision) {
  nsAutoCString stamp("1:");
  for (uint64_t value :
       {attempt.id, attempt.operationId, attempt.revision,
        attempt.destination->folderId, uint64_t(attempt.destination->key),
        uint64_t(epoch), uint64_t(uid), attempt.appendBody->contentRevision,
        attempt.appendBody->locationRevision, locationRevision}) {
    stamp.AppendInt(static_cast<int64_t>(value));
    stamp.Append(':');
  }
  stamp.Append(attempt.appendBody->databaseSourceId);
  return stamp;
}

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

nsresult ReadOfflineDestination(mozIStorageStatement* stmt, uint32_t column,
                                Maybe<PendingDestination>& output) {
  bool absent;
  MOZ_TRY(stmt->GetIsNull(column, &absent));
  bool keyAbsent, epochAbsent;
  MOZ_TRY(stmt->GetIsNull(column + 1, &keyAbsent));
  MOZ_TRY(stmt->GetIsNull(column + 2, &epochAbsent));
  NS_ENSURE_TRUE(keyAbsent == absent && (!absent || epochAbsent),
                 NS_ERROR_FILE_CORRUPTED);
  if (absent) {
    output.reset();
    return NS_OK;
  }
  int32_t type;
  int64_t folder;
  MOZ_TRY(stmt->GetTypeOfIndex(column, &type));
  MOZ_TRY(stmt->GetInt64(column, &folder));
  NS_ENSURE_TRUE(
      type == mozIStorageValueArray::VALUE_TYPE_INTEGER && folder > 0,
      NS_ERROR_FILE_CORRUPTED);
  PendingDestination found;
  found.folderId = folder;
  MOZ_TRY(OfflineUint32(stmt, column + 1, found.key));
  NS_ENSURE_TRUE(found.key && found.key < nsMsgKey_None,
                 NS_ERROR_FILE_CORRUPTED);
  found.epochKnown = !epochAbsent;
  if (found.epochKnown) {
    MOZ_TRY(OfflineUint32(stmt, column + 2, found.epoch));
  }
  output = Some(found);
  return NS_OK;
}

nsresult BindOfflineDestination(mozIStorageStatement* stmt,
                                const Maybe<PendingDestination>& destination) {
  if (destination) {
    MOZ_TRY(
        stmt->BindInt64ByName("destinationFolder"_ns, destination->folderId));
    MOZ_TRY(stmt->BindInt64ByName("destinationKey"_ns, destination->key));
    return destination->epochKnown
               ? stmt->BindInt64ByName("destinationEpoch"_ns,
                                       destination->epoch)
               : stmt->BindNullByName("destinationEpoch"_ns);
  }
  MOZ_TRY(stmt->BindNullByName("destinationFolder"_ns));
  MOZ_TRY(stmt->BindNullByName("destinationKey"_ns));
  return stmt->BindNullByName("destinationEpoch"_ns);
}

bool SamePendingDestination(const PendingDestination& a,
                            const PendingDestination& b) {
  return a.folderId == b.folderId && a.key == b.key &&
         a.epochKnown == b.epochKnown && (!a.epochKnown || a.epoch == b.epoch);
}

bool SameOfflineSource(const Maybe<ServerMessageLocation>& a,
                       const Maybe<ServerMessageLocation>& b) {
  return a.isSome() == b.isSome() &&
         (!a || (a->folderId == b->folderId && a->key == b->key &&
                 a->epoch == b->epoch && a->uid == b->uid));
}

bool SameFlagMutation(const Maybe<OfflineFlagMutation>& a,
                      const Maybe<OfflineFlagMutation>& b) {
  return a.isSome() == b.isSome() &&
         (!a || (a->setMask == b->setMask && a->clearMask == b->clearMask));
}

bool SameMoveGuard(const Maybe<OfflineMoveSourceGuard>& a,
                   const Maybe<OfflineMoveSourceGuard>& b) {
  return a.isSome() == b.isSome() &&
         (!a || (a->presence == b->presence &&
                 SameBodyGuard(a->original, b->original)));
}

nsresult ReplayInteger(mozIStorageStatement* stmt, uint32_t column,
                       int64_t& value) {
  int32_t type;
  MOZ_TRY(stmt->GetTypeOfIndex(column, &type));
  NS_ENSURE_TRUE(type == mozIStorageValueArray::VALUE_TYPE_INTEGER,
                 NS_ERROR_FILE_CORRUPTED);
  return stmt->GetInt64(column, &value);
}

nsresult ReadReplayPayload(mozIStorageStatement* stmt, uint32_t offset,
                           Maybe<OfflineFlagMutation>& flags,
                           Maybe<OfflineMoveSourceGuard>& guard) {
  bool absent, other;
  MOZ_TRY(stmt->GetIsNull(offset, &absent));
  MOZ_TRY(stmt->GetIsNull(offset + 1, &other));
  NS_ENSURE_TRUE(absent == other, NS_ERROR_FILE_CORRUPTED);
  if (!absent) {
    uint32_t set, clear;
    MOZ_TRY(OfflineUint32(stmt, offset, set));
    MOZ_TRY(OfflineUint32(stmt, offset + 1, clear));
    NS_ENSURE_TRUE(!((set | clear) & ~0xDFu) && !(set & clear),
                   NS_ERROR_FILE_CORRUPTED);
    flags = Some(OfflineFlagMutation{uint16_t(set), uint16_t(clear)});
  }
  MOZ_TRY(stmt->GetIsNull(offset + 2, &absent));
  for (uint32_t i = 3; i < 13; ++i) {
    if (i == 7) continue;  // The store token has its own presence.
    MOZ_TRY(stmt->GetIsNull(offset + i, &other));
    NS_ENSURE_TRUE(absent == other, NS_ERROR_FILE_CORRUPTED);
  }
  if (absent) {
    MOZ_TRY(stmt->GetIsNull(offset + 7, &other));
    NS_ENSURE_TRUE(other, NS_ERROR_FILE_CORRUPTED);
    return NS_OK;
  }
  OfflineMoveSourceGuard found;
  auto& body = found.original;
  int32_t type;
  MOZ_TRY(stmt->GetTypeOfIndex(offset + 2, &type));
  NS_ENSURE_TRUE(type == mozIStorageValueArray::VALUE_TYPE_TEXT,
                 NS_ERROR_FILE_CORRUPTED);
  MOZ_TRY(stmt->GetUTF8String(offset + 2, body.databaseSourceId));
  NS_ENSURE_TRUE(!body.databaseSourceId.IsEmpty(), NS_ERROR_FILE_CORRUPTED);
  int64_t value;
  MOZ_TRY(ReplayInteger(stmt, offset + 3, value));
  NS_ENSURE_TRUE(value > 0, NS_ERROR_FILE_CORRUPTED);
  body.folderId = value;
  MOZ_TRY(OfflineUint32(stmt, offset + 4, body.key));
  NS_ENSURE_TRUE(body.key && body.key < nsMsgKey_None, NS_ERROR_FILE_CORRUPTED);
  MOZ_TRY(ReplayInteger(stmt, offset + 5, value));
  NS_ENSURE_TRUE(value > 0, NS_ERROR_FILE_CORRUPTED);
  body.contentRevision = value;
  MOZ_TRY(ReplayInteger(stmt, offset + 6, value));
  NS_ENSURE_TRUE(value > 0, NS_ERROR_FILE_CORRUPTED);
  body.locationRevision = value;
  MOZ_TRY(stmt->GetIsNull(offset + 7, &absent));
  if (!absent) {
    MOZ_TRY(stmt->GetTypeOfIndex(offset + 7, &type));
    NS_ENSURE_TRUE(type == mozIStorageValueArray::VALUE_TYPE_TEXT,
                   NS_ERROR_FILE_CORRUPTED);
    nsCString token;
    MOZ_TRY(stmt->GetUTF8String(offset + 7, token));
    body.storeToken = Some(std::move(token));
  }
  MOZ_TRY(OfflineUint32(stmt, offset + 8, body.messageSize));
  MOZ_TRY(OfflineUint32(stmt, offset + 9, body.offlineMessageSize));
  MOZ_TRY(OfflineUint32(stmt, offset + 10, body.lineCount));
  MOZ_TRY(OfflineUint32(stmt, offset + 11, body.flags));
  MOZ_TRY(ReplayInteger(stmt, offset + 12, value));
  NS_ENSURE_TRUE(value == 0 || value == 1, NS_ERROR_FILE_CORRUPTED);
  found.presence = static_cast<OfflineMoveLocalPresence>(value);
  guard = Some(std::move(found));
  return NS_OK;
}

nsresult BindReplayPayload(mozIStorageStatement* stmt,
                           const Maybe<OfflineFlagMutation>& flags,
                           const Maybe<OfflineMoveSourceGuard>& guard) {
  if (flags) {
    MOZ_TRY(stmt->BindInt64ByName("flagSetMask"_ns, flags->setMask));
    MOZ_TRY(stmt->BindInt64ByName("flagClearMask"_ns, flags->clearMask));
  } else {
    MOZ_TRY(stmt->BindNullByName("flagSetMask"_ns));
    MOZ_TRY(stmt->BindNullByName("flagClearMask"_ns));
  }
  if (guard) {
    const auto& b = guard->original;
    MOZ_TRY(stmt->BindUTF8StringByName("guardSourceId"_ns, b.databaseSourceId));
    MOZ_TRY(stmt->BindInt64ByName("guardFolderId"_ns, b.folderId));
    MOZ_TRY(stmt->BindInt64ByName("guardKey"_ns, b.key));
    MOZ_TRY(
        stmt->BindInt64ByName("guardContentRevision"_ns, b.contentRevision));
    MOZ_TRY(
        stmt->BindInt64ByName("guardLocationRevision"_ns, b.locationRevision));
    if (b.storeToken) {
      MOZ_TRY(stmt->BindUTF8StringByName("guardStoreToken"_ns, *b.storeToken));
    } else {
      MOZ_TRY(stmt->BindNullByName("guardStoreToken"_ns));
    }
    MOZ_TRY(stmt->BindInt64ByName("guardMessageSize"_ns, b.messageSize));
    MOZ_TRY(stmt->BindInt64ByName("guardOfflineSize"_ns, b.offlineMessageSize));
    MOZ_TRY(stmt->BindInt64ByName("guardLineCount"_ns, b.lineCount));
    MOZ_TRY(stmt->BindInt64ByName("guardFlags"_ns, b.flags));
    MOZ_TRY(
        stmt->BindInt64ByName("guardPresence"_ns, int64_t(guard->presence)));
  } else {
    for (const char* n :
         {"guardSourceId", "guardFolderId", "guardKey", "guardContentRevision",
          "guardLocationRevision", "guardStoreToken", "guardMessageSize",
          "guardOfflineSize", "guardLineCount", "guardFlags",
          "guardPresence"}) {
      MOZ_TRY(stmt->BindNullByName(nsDependentCString(n)));
    }
  }
  return NS_OK;
}

nsresult ReadReplayError(mozIStorageStatement* stmt, uint32_t column,
                         Maybe<nsresult>& error) {
  bool absent;
  MOZ_TRY(stmt->GetIsNull(column, &absent));
  if (!absent) {
    uint32_t value;
    MOZ_TRY(OfflineUint32(stmt, column, value));
    NS_ENSURE_TRUE(NS_FAILED(nsresult(value)), NS_ERROR_FILE_CORRUPTED);
    error = Some(nsresult(value));
  }
  return NS_OK;
}

nsresult ReadReplayProgress(mozIStorageStatement* stmt, uint32_t offset,
                            Maybe<OfflineReplayCommandProgress>& output) {
  bool absent, generationAbsent;
  MOZ_TRY(stmt->GetIsNull(offset, &absent));
  MOZ_TRY(stmt->GetIsNull(offset + 1, &generationAbsent));
  NS_ENSURE_TRUE(absent == generationAbsent, NS_ERROR_FILE_CORRUPTED);
  if (absent) {
    MOZ_TRY(stmt->GetIsNull(offset + 2, &absent));
    return absent ? NS_OK : NS_ERROR_FILE_CORRUPTED;
  }
  int64_t state, generation;
  MOZ_TRY(ReplayInteger(stmt, offset, state));
  MOZ_TRY(ReplayInteger(stmt, offset + 1, generation));
  NS_ENSURE_TRUE(state >= 0 && state <= 4 && generation >= 0 &&
                     ((state == 0) == (generation == 0)),
                 NS_ERROR_FILE_CORRUPTED);
  OfflineReplayCommandProgress found;
  found.state = static_cast<OfflineReplayCommandState>(state);
  found.generation = generation;
  MOZ_TRY(ReadReplayError(stmt, offset + 2, found.firstError));
  output = Some(found);
  return NS_OK;
}

nsresult BindReplayProgress(mozIStorageStatement* stmt, const char* prefix,
                            const Maybe<OfflineReplayCommandProgress>& value) {
  nsAutoCString state(prefix), generation(prefix), error(prefix);
  state.AppendLiteral("State");
  generation.AppendLiteral("Generation");
  error.AppendLiteral("Error");
  if (!value) {
    MOZ_TRY(stmt->BindNullByName(state));
    MOZ_TRY(stmt->BindNullByName(generation));
    return stmt->BindNullByName(error);
  }
  MOZ_TRY(stmt->BindInt64ByName(state, int64_t(value->state)));
  MOZ_TRY(stmt->BindInt64ByName(generation, value->generation));
  return value->firstError
             ? stmt->BindInt64ByName(error, uint32_t(*value->firstError))
             : stmt->BindNullByName(error);
}

nsresult WriteOfflineReplayPayload(mozIStorageConnection* connection,
                                   int64_t id,
                                   const Maybe<OfflineFlagMutation>& flags,
                                   const Maybe<OfflineMoveSourceGuard>& guard) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(connection->CreateStatement(
      "UPDATE offline_operations SET flagSetMask=:flagSetMask, flagClearMask=:flagClearMask, guardSourceId=:guardSourceId, guardFolderId=:guardFolderId, guardKey=:guardKey, guardContentRevision=:guardContentRevision, guardLocationRevision=:guardLocationRevision, guardStoreToken=:guardStoreToken, guardMessageSize=:guardMessageSize, guardOfflineSize=:guardOfflineSize, guardLineCount=:guardLineCount, guardFlags=:guardFlags, guardPresence=:guardPresence WHERE id=:id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, id));
  MOZ_TRY(BindReplayPayload(stmt, flags, guard));
  return stmt->Execute();
}

nsresult WriteReplayAttempt(mozIStorageConnection* connection,
                            const OfflineAttempt& attempt) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(connection->CreateStatement(
      "UPDATE offline_attempts SET flagSetMask=:flagSetMask, flagClearMask=:flagClearMask, guardSourceId=:guardSourceId, guardFolderId=:guardFolderId, guardKey=:guardKey, guardContentRevision=:guardContentRevision, guardLocationRevision=:guardLocationRevision, guardStoreToken=:guardStoreToken, guardMessageSize=:guardMessageSize, guardOfflineSize=:guardOfflineSize, guardLineCount=:guardLineCount, guardFlags=:guardFlags, guardPresence=:guardPresence, replayVersion=:replayVersion, moveExpunge=:moveExpunge, flagSetState=:flagSetState, flagSetGeneration=:flagSetGeneration, flagSetError=:flagSetError, flagClearState=:flagClearState, flagClearGeneration=:flagClearGeneration, flagClearError=:flagClearError, sourceStoreState=:sourceStoreState, sourceStoreGeneration=:sourceStoreGeneration, sourceStoreError=:sourceStoreError, sourceExpungeState=:sourceExpungeState, sourceExpungeGeneration=:sourceExpungeGeneration, sourceExpungeError=:sourceExpungeError, moveSettled=:moveSettled, firstError=:firstError WHERE id=:id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, attempt.id));
  MOZ_TRY(
      BindReplayPayload(stmt, attempt.flagMutation, attempt.moveSourceGuard));
  MOZ_TRY(stmt->BindInt64ByName("replayVersion"_ns, attempt.replayVersion));
  if (attempt.moveSourcePlan) {
    MOZ_TRY(stmt->BindInt64ByName("moveExpunge"_ns,
                                  int64_t(attempt.moveSourcePlan->expunge)));
  } else {
    MOZ_TRY(stmt->BindNullByName("moveExpunge"_ns));
  }
  MOZ_TRY(BindReplayProgress(stmt, "flagSet", attempt.flagSet));
  MOZ_TRY(BindReplayProgress(stmt, "flagClear", attempt.flagClear));
  MOZ_TRY(BindReplayProgress(stmt, "sourceStore", attempt.sourceStore));
  MOZ_TRY(BindReplayProgress(stmt, "sourceExpunge", attempt.sourceExpunge));
  MOZ_TRY(stmt->BindInt64ByName("moveSettled"_ns, attempt.moveSettled));
  if (attempt.firstError) {
    MOZ_TRY(
        stmt->BindInt64ByName("firstError"_ns, uint32_t(*attempt.firstError)));
  } else {
    MOZ_TRY(stmt->BindNullByName("firstError"_ns));
  }
  return stmt->Execute();
}

bool ReplayAcknowledged(const Maybe<OfflineReplayCommandProgress>& step) {
  return step && step->state == OfflineReplayCommandState::Acknowledged;
}

Maybe<OfflineReplayCommandProgress>* ReplayStep(OfflineAttempt& attempt,
                                                OfflineReplayCommand command) {
  switch (command) {
    case OfflineReplayCommand::FlagSet:
      return &attempt.flagSet;
    case OfflineReplayCommand::FlagClear:
      return &attempt.flagClear;
    case OfflineReplayCommand::MoveStore:
      return &attempt.sourceStore;
    case OfflineReplayCommand::MoveUidExpunge:
      return attempt.moveSourcePlan &&
                     attempt.moveSourcePlan->expunge == OfflineMoveExpunge::Uid
                 ? &attempt.sourceExpunge
                 : nullptr;
    case OfflineReplayCommand::MoveExpunge:
      return attempt.moveSourcePlan && attempt.moveSourcePlan->expunge ==
                                           OfflineMoveExpunge::Mailbox
                 ? &attempt.sourceExpunge
                 : nullptr;
  }
  return nullptr;
}

bool SameOfflinePayload(const OfflineOperationData& a,
                        const OfflineOperationData& b) {
  if (!SameFlagMutation(a.flagMutation, b.flagMutation) ||
      !SameMoveGuard(a.moveSourceGuard, b.moveSourceGuard) ||
      a.operation != b.operation || a.flagOperation != b.flagOperation ||
      a.newFlags != b.newFlags || a.sourceKey != b.sourceKey ||
      a.sourceUid != b.sourceUid || a.messageSize != b.messageSize ||
      a.playingBack != b.playingBack ||
      a.sourceFolderURI != b.sourceFolderURI ||
      a.destinationFolderURI != b.destinationFolderURI ||
      a.keywordsToAdd != b.keywordsToAdd ||
      a.keywordsToRemove != b.keywordsToRemove ||
      a.copyDestinations != b.copyDestinations ||
      a.pendingDestination.isSome() != b.pendingDestination.isSome() ||
      (a.pendingDestination &&
       !SamePendingDestination(*a.pendingDestination, *b.pendingDestination)) ||
      a.copyDestinationBindings.Length() !=
          b.copyDestinationBindings.Length()) {
    return false;
  }
  for (size_t i = 0; i < a.copyDestinationBindings.Length(); ++i) {
    const auto& x = a.copyDestinationBindings[i];
    const auto& y = b.copyDestinationBindings[i];
    if (x.isSome() != y.isSome() || (x && !SamePendingDestination(*x, *y))) {
      return false;
    }
  }
  return true;
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
      "SELECT id, revision, epoch, uid, folderEpoch, sourcePhysicalKey "
      "FROM offline_operations "
      "WHERE folderId = :folder AND messageKey = :key"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
  MOZ_TRY(stmt->BindInt64ByName("key"_ns, key));
  bool more, epochNull, uidNull;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
  int64_t foundId, foundRevision;
  for (uint32_t column : {0u, 1u}) {
    int32_t type;
    MOZ_TRY(stmt->GetTypeOfIndex(column, &type));
    NS_ENSURE_TRUE(type == mozIStorageValueArray::VALUE_TYPE_INTEGER,
                   NS_ERROR_FILE_CORRUPTED);
  }
  MOZ_TRY(stmt->GetInt64(0, &foundId));
  MOZ_TRY(stmt->GetInt64(1, &foundRevision));
  NS_ENSURE_TRUE(foundId > 0 && foundRevision > 0, NS_ERROR_FILE_CORRUPTED);
  MOZ_TRY(stmt->GetIsNull(2, &epochNull));
  MOZ_TRY(stmt->GetIsNull(3, &uidNull));
  NS_ENSURE_TRUE(epochNull == uidNull, NS_ERROR_FILE_CORRUPTED);
  bool keyNull;
  MOZ_TRY(stmt->GetIsNull(5, &keyNull));
  NS_ENSURE_TRUE(!epochNull || keyNull, NS_ERROR_FILE_CORRUPTED);
  Maybe<ServerMessageLocation> target;
  if (!epochNull) {
    ServerMessageLocation location{folderId, key};
    if (!keyNull) {
      MOZ_TRY(OfflineUint32(stmt, 5, location.key));
      NS_ENSURE_TRUE(location.key && location.key < nsMsgKey_None,
                     NS_ERROR_FILE_CORRUPTED);
    }
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
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  if (folderEpoch) {
    *folderEpoch = scopeEpoch;
  }
  id = foundId;
  revision = foundRevision;
  source = target;
  return NS_OK;
}

nsresult MessageDatabase::GetOfflineOperationSource(
    uint64_t folderId, nsMsgKey key, Maybe<ServerMessageLocation>& output) {
  NS_ENSURE_TRUE(
      folderId && folderId <= INT64_MAX && key && key < nsMsgKey_None,
      NS_ERROR_INVALID_ARG);
  int64_t id, revision;
  Maybe<ServerMessageLocation> source;
  MOZ_TRY(ReadOfflineOperationIdentity(folderId, key, id, revision, source));
  output = source;
  return NS_OK;
}

nsresult MessageDatabase::GetQueuedSourceIdentity(
    uint64_t folderId, nsMsgKey key, QueuedSourceIdentity& output) {
  QueuedSourceIdentity found;
  int64_t id, revision;
  MOZ_TRY(
      ReadOfflineOperationIdentity(folderId, key, id, revision, found.source));
  MOZ_TRY(DatabaseCore::sInstance->ReadSourceIdForFolderAdmission(
      found.databaseSourceId));
  found.folderId = folderId;
  found.key = key;
  found.operationId = id;
  found.revision = revision;
  output = found;
  return NS_OK;
}

nsresult MessageDatabase::ValidateQueuedSourceIdentity(
    const QueuedSourceIdentity& expected) {
  NS_ENSURE_TRUE(!expected.databaseSourceId.IsEmpty() && expected.operationId &&
                     expected.revision,
                 NS_ERROR_INVALID_ARG);
  QueuedSourceIdentity actual;
  MOZ_TRY(GetQueuedSourceIdentity(expected.folderId, expected.key, actual));
  NS_ENSURE_TRUE(actual.databaseSourceId == expected.databaseSourceId &&
                     actual.operationId == expected.operationId &&
                     actual.revision == expected.revision &&
                     SameOfflineSource(actual.source, expected.source),
                 NS_ERROR_NOT_AVAILABLE);
  return NS_OK;
}

nsresult MessageDatabase::ObserveDestinationEpochInTransaction(
    const QueuedSourceIdentity& expected, uint32_t action,
    const Maybe<uint32_t>& copyOrdinal, const PendingDestination& destination,
    uint32_t observedEpoch) {
  MOZ_TRY(ValidateQueuedSourceIdentity(expected));
  NS_ENSURE_TRUE(
      (action == OfflineOp::kMsgCopy) == copyOrdinal.isSome() &&
          (action == OfflineOp::kMsgCopy || action == OfflineOp::kMsgMoved ||
           action == OfflineOp::kAppendDraft ||
           action == OfflineOp::kAppendTemplate),
      NS_ERROR_INVALID_ARG);
  OfflineOperationData payload;
  MOZ_TRY(GetOfflineOperation(expected.folderId, expected.key, payload));
  NS_ENSURE_TRUE(payload.operation & action, NS_ERROR_NOT_AVAILABLE);
  Maybe<PendingDestination> saved;
  if (copyOrdinal) {
    NS_ENSURE_TRUE(*copyOrdinal < payload.copyDestinationBindings.Length(),
                   NS_ERROR_NOT_AVAILABLE);
    saved = payload.copyDestinationBindings[*copyOrdinal];
  } else {
    saved = payload.pendingDestination;
  }
  NS_ENSURE_TRUE(
      saved && saved->folderId == destination.folderId &&
          saved->key == destination.key &&
          (!saved->epochKnown || saved->epoch == observedEpoch) &&
          (!destination.epochKnown || destination.epoch == observedEpoch),
      NS_ERROR_NOT_AVAILABLE);
  MessageBodyState body;
  MOZ_TRY(ReadMessageBodyState(destination.key, body));
  NS_ENSURE_TRUE(body.folderId == destination.folderId &&
                     body.databaseSourceId == expected.databaseSourceId,
                 NS_ERROR_NOT_AVAILABLE);
  uint32_t current;
  nsresult rv = DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(
      destination.folderId, current);
  if (NS_SUCCEEDED(rv)) {
    NS_ENSURE_TRUE(current == observedEpoch, NS_ERROR_NOT_AVAILABLE);
  } else {
    NS_ENSURE_TRUE(rv == NS_ERROR_NOT_AVAILABLE, rv);
    // This is only first observation. Never retire another message's UID as a
    // side effect of binding a previously unobserved queued destination.
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "OfflineFirstEpochUidCollision"_ns,
        "SELECT 1 FROM message_properties p JOIN messages m ON m.id=p.id "
        "WHERE m.folderId=:folder AND p.name='uidOnServer' UNION ALL "
        "SELECT 1 FROM staged_message_properties p JOIN staged_messages m "
        "ON m.id=p.id WHERE m.folderId=:folder AND p.name='uidOnServer' LIMIT 1"_ns,
        getter_AddRefs(stmt)));
    {
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("folder"_ns, destination.folderId));
      bool collision;
      MOZ_TRY(stmt->ExecuteStep(&collision));
      NS_ENSURE_FALSE(collision, NS_ERROR_NOT_AVAILABLE);
    }
    MOZ_TRY(DatabaseCore::GetStatement(
        "OfflineFirstEpoch"_ns,
        "INSERT INTO folder_properties(id,name,value) SELECT id,'UIDValidity',"
        ":epoch FROM folders WHERE id=:folder RETURNING id"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, destination.folderId));
    MOZ_TRY(stmt->BindInt64ByName("epoch"_ns, observedEpoch));
    bool changed;
    MOZ_TRY(stmt->ExecuteStep(&changed));
    NS_ENSURE_TRUE(changed, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(stmt->ExecuteStep(&changed));
    NS_ENSURE_FALSE(changed, NS_ERROR_UNEXPECTED);
  }
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      copyOrdinal ? "ObserveOfflineCopyEpoch"_ns
                  : "ObserveOfflineTargetEpoch"_ns,
      copyOrdinal
          ? "UPDATE offline_copy_destinations SET destinationEpoch=:epoch "
            "WHERE operationId=:id AND ordinal=:ordinal AND "
            "destinationFolderId=:folder AND destinationKey=:key"_ns
          : "UPDATE offline_operations SET destinationEpoch=:epoch "
            "WHERE id=:id AND destinationFolderId=:folder AND destinationKey=:key"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, expected.operationId));
  MOZ_TRY(stmt->BindInt64ByName("folder"_ns, destination.folderId));
  MOZ_TRY(stmt->BindInt64ByName("key"_ns, destination.key));
  MOZ_TRY(stmt->BindInt64ByName("epoch"_ns, observedEpoch));
  if (copyOrdinal) {
    MOZ_TRY(stmt->BindInt64ByName("ordinal"_ns, *copyOrdinal));
  }
  return stmt->Execute();
}

nsresult MessageDatabase::ObserveOfflineDestinationEpoch(
    const QueuedSourceIdentity& expected, uint32_t action,
    const Maybe<uint32_t>& copyOrdinal, const PendingDestination& destination,
    uint32_t observedEpoch) {
  MOZ_TRY(RequireCurrentOwner());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool active;
  MOZ_TRY(connection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = ObserveDestinationEpochInTransaction(
      expected, action, copyOrdinal, destination, observedEpoch);
  if (NS_SUCCEEDED(rv)) {
    rv = connection->CommitTransaction();
  }
  return FinishOfflineWrite(connection, rv);
}

nsresult MessageDatabase::BindStagedMessageToQueuedSource(
    nsMsgKey stagedKey, uint64_t folderId, const QueuedSourceIdentity& expected,
    const Maybe<uint32_t>& copyOrdinal, const MessageBodyState& returning) {
  MOZ_TRY(RequireCurrentOwner());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool active;
  MOZ_TRY(connection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    MOZ_TRY(ValidateQueuedSourceIdentity(expected));
    NS_ENSURE_TRUE(expected.source && folderId == expected.source->folderId &&
                       stagedKey != returning.key && stagedKey != expected.key,
                   NS_ERROR_NOT_AVAILABLE);
    OfflineOperationData payload;
    MOZ_TRY(GetOfflineOperation(expected.folderId, expected.key, payload));
    MOZ_TRY(RequireOfflineUndoQueued(expected.operationId, payload));
    Maybe<PendingDestination> target;
    if (copyOrdinal) {
      NS_ENSURE_TRUE(
          (payload.operation & OfflineOp::kMsgCopy) &&
              *copyOrdinal < payload.copyDestinationBindings.Length(),
          NS_ERROR_NOT_AVAILABLE);
      target = payload.copyDestinationBindings[*copyOrdinal];
    } else {
      NS_ENSURE_TRUE(payload.operation & OfflineOp::kMsgMoved,
                     NS_ERROR_NOT_AVAILABLE);
      target = payload.pendingDestination;
    }
    NS_ENSURE_TRUE(target && target->folderId == returning.folderId &&
                       target->key == returning.key,
                   NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(ValidatePendingDestination(*target, expected.folderId, expected.key,
                                       false, expected.operationId));
    MessageBodyState actual;
    MOZ_TRY(ReadMessageBodyState(returning.key, actual));
    NS_ENSURE_TRUE(SameBodyGuard(actual, returning), NS_ERROR_NOT_AVAILABLE);
    // Staged rows have no published journal revision. Guard their actual
    // physical key/folder and current incarnation, not a fabricated body state.
    bool isStaged;
    MOZ_TRY(IsMessageStaged(stagedKey, isStaged));
    NS_ENSURE_TRUE(isStaged, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(BindMessageToServerUidInTransaction(stagedKey, folderId,
                                                expected.source->epoch,
                                                expected.source->uid, true));
    // This is the same queued SOURCE, not a new operation claiming its tail.
    // Validate the whole physical counterpart set before changing any key.
    nsTArray<OfflineOperationUndo::Data::Operation> children;
    auto captureChild =
        [&](const Maybe<PendingDestination>& destination) -> nsresult {
      if (!destination) {
        return NS_OK;
      }
      NS_ENSURE_TRUE(destination->key != stagedKey, NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(ValidatePendingDestination(*destination, expected.folderId,
                                         expected.key, false,
                                         expected.operationId));
      for (const auto& child : children) {
        NS_ENSURE_TRUE(child.key != destination->key, NS_ERROR_NOT_AVAILABLE);
      }
      auto& child = *children.AppendElement();
      child.folderId = destination->folderId;
      child.key = destination->key;
      MOZ_TRY(ReadOfflineOperationIdentity(child.folderId, child.key, child.id,
                                           child.revision, child.source));
      MOZ_TRY(GetOfflineOperation(child.folderId, child.key, child.payload));
      NS_ENSURE_TRUE((child.payload.operation & OfflineOp::kMoveResult) &&
                         child.payload.sourceKey == expected.key,
                     NS_ERROR_NOT_AVAILABLE);
      return RequireOfflineUndoQueued(child.id, child.payload);
    };
    MOZ_TRY(captureChild(payload.pendingDestination));
    for (const auto& destination : payload.copyDestinationBindings) {
      MOZ_TRY(captureChild(destination));
    }
    int64_t otherId, otherRevision;
    Maybe<ServerMessageLocation> otherSource;
    nsresult other = ReadOfflineOperationIdentity(folderId, stagedKey, otherId,
                                                  otherRevision, otherSource);
    NS_ENSURE_TRUE(other == NS_ERROR_NOT_AVAILABLE,
                   NS_SUCCEEDED(other) ? NS_ERROR_NOT_AVAILABLE : other);
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "RekeyStagedOfflineSource"_ns,
          "UPDATE offline_operations SET messageKey=:fresh WHERE id=:id "
          "AND revision=:revision AND folderId=:folder AND messageKey=:old "
          "RETURNING id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("fresh"_ns, stagedKey));
      MOZ_TRY(stmt->BindInt64ByName("folder"_ns, expected.folderId));
      MOZ_TRY(stmt->BindInt64ByName("old"_ns, expected.key));
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, expected.operationId));
      MOZ_TRY(stmt->BindInt64ByName("revision"_ns, expected.revision));
      bool changed;
      MOZ_TRY(stmt->ExecuteStep(&changed));
      NS_ENSURE_TRUE(changed, NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(stmt->ExecuteStep(&changed));
      NS_ENSURE_FALSE(changed, NS_ERROR_FILE_CORRUPTED);
    }
    // Store retains each existing child's identity and captured tuple. A write
    // failure rolls back its siblings, the SOURCE key and the staged UID.
    for (auto& child : children) {
      child.payload.sourceKey = stagedKey;
      MOZ_TRY(StoreOfflineOperationInTransaction(child.folderId, child.key,
                                                 child.payload));
    }
    return connection->CommitTransaction();
  }();
  return FinishOfflineWrite(connection, rv);
}

nsresult MessageDatabase::ReadOfflineImportHold(int64_t operationId,
                                                bool& held) {
  MOZ_TRY(RequireCurrentOwner());
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ReadOfflineImportHold"_ns,
      "SELECT "
      "h.databaseSourceId,h.folderId,h.messageKey,o.folderId,o.messageKey "
      "FROM imap_import_operation_holds h LEFT JOIN offline_operations o "
      "ON o.id=h.operationId WHERE h.operationId=:id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, operationId));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  if (more) {
    nsCString storedSource, source;
    MOZ_TRY(stmt->GetUTF8String(0, storedSource));
    MOZ_TRY(DatabaseCore::sInstance->ReadSourceIdForFolderAdmission(source));
    NS_ENSURE_TRUE(source == storedSource, NS_ERROR_NOT_AVAILABLE);
    for (uint32_t column : {1u, 2u}) {
      int64_t saved, actual;
      bool missing;
      MOZ_TRY(stmt->GetIsNull(column + 2, &missing));
      NS_ENSURE_FALSE(missing, NS_ERROR_FILE_CORRUPTED);
      MOZ_TRY(stmt->GetInt64(column, &saved));
      MOZ_TRY(stmt->GetInt64(column + 2, &actual));
      NS_ENSURE_TRUE(saved > 0 && saved == actual, NS_ERROR_FILE_CORRUPTED);
    }
  }
  held = more;
  return NS_OK;
}

nsresult MessageDatabase::IsOfflineImportHeld(uint64_t folderId, nsMsgKey key,
                                              bool& held) {
  NS_ENSURE_TRUE(
      folderId && folderId <= INT64_MAX && key && key < nsMsgKey_None,
      NS_ERROR_INVALID_ARG);
  MOZ_TRY(RequireCurrentOwner());
  int64_t id, revision;
  Maybe<ServerMessageLocation> source;
  MOZ_TRY(ReadOfflineOperationIdentity(folderId, key, id, revision, source));
  return ReadOfflineImportHold(id, held);
}

nsresult MessageDatabase::RequireOfflineImportDispatchable(
    int64_t operationId) {
  bool held;
  MOZ_TRY(ReadOfflineImportHold(operationId, held));
  return held ? NS_ERROR_NOT_AVAILABLE : NS_OK;
}

nsresult MessageDatabase::RequireOfflineOperationMutable(int64_t id) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "OfflineOperationInFlight"_ns,
      "SELECT 1 FROM offline_attempts WHERE operationId = :id "
      "AND (state IN (1,3) OR (replayVersion=1 AND moveExpunge IS NOT NULL AND moveSettled=0)) LIMIT 1"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, id));
  bool active;
  MOZ_TRY(stmt->ExecuteStep(&active));
  return active ? NS_ERROR_IN_PROGRESS : NS_OK;
}

nsresult MessageDatabase::RequireOfflineUndoQueued(
    int64_t id, const OfflineOperationData& operation) {
  MOZ_TRY(RequireOfflineImportDispatchable(id));
  NS_ENSURE_FALSE(operation.playingBack, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "OfflineUndoDispatched"_ns,
      "SELECT 1 FROM offline_attempts WHERE operationId=:id "
      "AND state IN (1,2,3) LIMIT 1"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, id));
  bool dispatched;
  MOZ_TRY(stmt->ExecuteStep(&dispatched));
  return dispatched ? NS_ERROR_NOT_AVAILABLE : NS_OK;
}

nsresult MessageDatabase::CaptureOfflineOperationForUndo(
    uint64_t folderId, nsMsgKey key, const nsACString& databaseSourceId,
    OfflineOperationUndo& output, const OfflineUndoCounterpart* counterpart) {
  NS_ENSURE_TRUE(folderId && folderId <= INT64_MAX && key &&
                     key < nsMsgKey_None && !databaseSourceId.IsEmpty(),
                 NS_ERROR_INVALID_ARG);
  if (counterpart) {
    NS_ENSURE_TRUE(
        counterpart->folderId && counterpart->folderId <= INT64_MAX &&
            counterpart->key && counterpart->key < nsMsgKey_None &&
            counterpart->destination.folderId == folderId &&
            counterpart->destination.key == key &&
            (counterpart->folderId != folderId || counterpart->key != key) &&
            (counterpart->action == OfflineOp::kMsgCopy ||
             counterpart->action == OfflineOp::kMsgMoved) &&
            (counterpart->action == OfflineOp::kMsgCopy) ==
                counterpart->copyOrdinal.isSome(),
        NS_ERROR_INVALID_ARG);
    NS_ENSURE_TRUE(counterpart->databaseSourceId == databaseSourceId,
                   NS_ERROR_NOT_AVAILABLE);
  }
  MOZ_TRY(RequireCommittedSearchRead());
  MOZ_TRY(CheckFolderBodyAccess(folderId));
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  OfflineOperationUndo prepared;
  nsresult rv = CaptureOfflineOperationInTransaction(
      folderId, key, databaseSourceId, prepared, counterpart);
  if (NS_SUCCEEDED(rv)) {
    rv = connection->CommitTransaction();
  }
  MOZ_TRY(FinishOfflineWrite(connection, rv));
  output.mData = std::move(prepared.mData);
  return NS_OK;
}

nsresult MessageDatabase::CaptureOfflineOperationInTransaction(
    uint64_t folderId, nsMsgKey key, const nsACString& databaseSourceId,
    OfflineOperationUndo& output, const OfflineUndoCounterpart* counterpart,
    const PendingDestination* extraTarget) {
  auto saved = MakeUnique<OfflineOperationUndo::Data>();
  saved->databaseSourceId = databaseSourceId;
  saved->operation.folderId = folderId;
  saved->operation.key = key;
  nsCString current;
  MOZ_TRY(DatabaseCore::sInstance->ReadSourceIdForFolderAdmission(current));
  NS_ENSURE_TRUE(current == databaseSourceId, NS_ERROR_NOT_AVAILABLE);
  MessageBodyState body;
  MOZ_TRY(ReadMessageBodyState(key, body));
  NS_ENSURE_TRUE(body.folderId == folderId, NS_ERROR_NOT_AVAILABLE);
  auto capture = [&](OfflineOperationUndo::Data::Operation& op) -> nsresult {
    MOZ_TRY(ReadOfflineOperationIdentity(
        op.folderId, op.key, op.id, op.revision, op.source, &op.folderEpoch));
    MOZ_TRY(GetOfflineOperation(op.folderId, op.key, op.payload));
    return RequireOfflineUndoQueued(op.id, op.payload);
  };
  MOZ_TRY(capture(saved->operation));
  auto captureDestination = [&](const Maybe<PendingDestination>& target,
                                bool canceledMove = false) -> nsresult {
    if (!target || (target->folderId == folderId && target->key == key)) {
      return NS_OK;
    }
    auto& child = *saved->destinationOperations.AppendElement();
    child.folderId = target->folderId;
    child.key = target->key;
    nsresult found = ReadOfflineOperationIdentity(
        child.folderId, child.key, child.id, child.revision, child.source,
        &child.folderEpoch);
    if (found == NS_ERROR_NOT_AVAILABLE) {
      NS_ENSURE_FALSE(canceledMove, NS_ERROR_NOT_AVAILABLE);
      return NS_OK;
    }
    MOZ_TRY(found);
    MOZ_TRY(GetOfflineOperation(child.folderId, child.key, child.payload));
    MOZ_TRY(RequireOfflineUndoQueued(child.id, child.payload));
    NS_ENSURE_TRUE(
        child.payload.sourceKey == key &&
            (canceledMove ? !(child.payload.operation & OfflineOp::kMoveResult)
                          : (child.payload.operation & OfflineOp::kMoveResult)),
        NS_ERROR_NOT_AVAILABLE);
    if (canceledMove) {
      MessageBodyState body;
      MOZ_TRY(ReadMessageBodyState(child.key, body));
      NS_ENSURE_TRUE(body.folderId == child.folderId, NS_ERROR_NOT_AVAILABLE);
      child.restoredBody = Some(std::move(body));
    }
    return NS_OK;
  };
  MOZ_TRY(captureDestination(saved->operation.payload.pendingDestination));
  for (const auto& target : saved->operation.payload.copyDestinationBindings) {
    MOZ_TRY(captureDestination(target));
  }
  if (extraTarget) {
    MOZ_TRY(captureDestination(Some(*extraTarget), true));
  }
  if (counterpart) {
    saved->counterpart = Some(*counterpart);
    auto& op = saved->counterpartOperation;
    op.folderId = counterpart->folderId;
    op.key = counterpart->key;
    MOZ_TRY(capture(op));
    NS_ENSURE_TRUE(op.payload.operation & counterpart->action,
                   NS_ERROR_NOT_AVAILABLE);
    Maybe<PendingDestination> target;
    if (counterpart->copyOrdinal) {
      uint32_t ordinal = *counterpart->copyOrdinal;
      NS_ENSURE_TRUE(ordinal < op.payload.copyDestinationBindings.Length(),
                     NS_ERROR_INVALID_ARG);
      target = op.payload.copyDestinationBindings[ordinal];
    } else {
      target = op.payload.pendingDestination;
    }
    NS_ENSURE_TRUE(
        target && SamePendingDestination(*target, counterpart->destination),
        NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(
        ValidatePendingDestination(*target, op.folderId, op.key, false, op.id));
  }
  output.mData = std::move(saved);
  return NS_OK;
}

nsresult MessageDatabase::ValidateOfflineUndoState(
    const OfflineOperationUndo::Data& saved, bool allowMissingEmpty) {
  nsCString sourceId;
  MOZ_TRY(DatabaseCore::sInstance->ReadSourceIdForFolderAdmission(sourceId));
  NS_ENSURE_TRUE(sourceId == saved.databaseSourceId, NS_ERROR_NOT_AVAILABLE);
  auto validate =
      [&](const OfflineOperationUndo::Data::Operation& expected) -> nsresult {
    if (expected.restoredBody) {
      MessageBodyState body;
      MOZ_TRY(ReadMessageBodyState(expected.key, body));
      NS_ENSURE_TRUE(SameBodyGuard(body, *expected.restoredBody),
                     NS_ERROR_NOT_AVAILABLE);
    }
    int64_t id = 0, revision = 0;
    Maybe<ServerMessageLocation> source;
    Maybe<uint32_t> folderEpoch;
    nsresult found = ReadOfflineOperationIdentity(
        expected.folderId, expected.key, id, revision, source, &folderEpoch);
    if (!expected.id && found == NS_ERROR_NOT_AVAILABLE) {
      return NS_OK;
    }
    if (found == NS_ERROR_NOT_AVAILABLE && allowMissingEmpty &&
        (&expected == &saved.operation || expected.restoredBody) &&
        !expected.payload.operation) {
      // Ordinary replay removes zero-bit records. Only the native Redo owner
      // can recover this canceled intent; retained dispatch fences still apply.
      MOZ_TRY(RequireOfflineUndoQueued(expected.id, expected.payload));
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "CanceledOfflineIdentityStillAbsent"_ns,
          "SELECT 1 FROM offline_operations WHERE id=:id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, expected.id));
      bool exists;
      MOZ_TRY(stmt->ExecuteStep(&exists));
      NS_ENSURE_FALSE(exists, NS_ERROR_NOT_AVAILABLE);
      if (expected.source) {
        uint32_t epoch;
        MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(
            expected.source->folderId, epoch));
        NS_ENSURE_TRUE(epoch == expected.source->epoch, NS_ERROR_NOT_AVAILABLE);
      }
      return NS_OK;
    }
    MOZ_TRY(found);
    NS_ENSURE_TRUE(expected.id && id == expected.id &&
                       revision == expected.revision &&
                       SameOfflineSource(source, expected.source) &&
                       folderEpoch == expected.folderEpoch,
                   NS_ERROR_NOT_AVAILABLE);
    OfflineOperationData payload;
    MOZ_TRY(GetOfflineOperation(expected.folderId, expected.key, payload));
    NS_ENSURE_TRUE(SameOfflinePayload(payload, expected.payload),
                   NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(RequireOfflineUndoQueued(id, payload));
    if (source) {
      uint32_t epoch;
      MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(
          source->folderId, epoch));
      NS_ENSURE_TRUE(epoch == source->epoch, NS_ERROR_NOT_AVAILABLE);
    }
    return NS_OK;
  };
  MOZ_TRY(validate(saved.operation));
  for (const auto& child : saved.destinationOperations) {
    MOZ_TRY(validate(child));
  }
  return NS_OK;
}

nsresult MessageDatabase::CancelOfflineMoveInTransaction(
    uint64_t folderId, nsMsgKey key, const PendingDestination& selected,
    const OfflineOperationUndo& full, OfflineOperationUndo& canceled) {
  const auto& saved = *full.mData;
  const auto& op = saved.operation;
  NS_ENSURE_TRUE(
      !saved.counterpart && op.source && op.source->folderId == folderId &&
          (op.payload.operation & OfflineOp::kMsgMoved) &&
          op.payload.pendingDestination &&
          SamePendingDestination(*op.payload.pendingDestination, selected),
      NS_ERROR_NOT_AVAILABLE);
  bool counterpart = false;
  for (const auto& child : saved.destinationOperations) {
    if (child.folderId == selected.folderId && child.key == selected.key) {
      NS_ENSURE_TRUE(child.id &&
                         (child.payload.operation & OfflineOp::kMoveResult) &&
                         child.payload.sourceKey == op.key,
                     NS_ERROR_NOT_AVAILABLE);
      counterpart = true;
    }
  }
  NS_ENSURE_TRUE(counterpart, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(BindMessageToServerUidInTransaction(key, folderId, op.source->epoch,
                                              op.source->uid, false));
  OfflineOperationData payload;
  MOZ_TRY(GetOfflineOperation(folderId, key, payload));
  payload.operation &= ~OfflineOp::kMsgMoved;
  payload.pendingDestination.reset();
  payload.destinationFolderURI.Truncate();
  MOZ_TRY(StoreOfflineOperationInTransaction(folderId, key, payload));
  OfflineOperationData child;
  MOZ_TRY(GetOfflineOperation(selected.folderId, selected.key, child));
  NS_ENSURE_TRUE(
      (child.operation & OfflineOp::kMoveResult) && child.sourceKey == key,
      NS_ERROR_NOT_AVAILABLE);
  // The canceled counterpart is no longer an active requested destination.
  // Preserve every other word and the physical row for the owning Redo.
  child.operation &= ~OfflineOp::kMoveResult;
  MOZ_TRY(StoreOfflineOperationInTransaction(selected.folderId, selected.key,
                                             child));
  // Keep the selected physical counterpart as explicitly owned Redo recovery.
  // No accepted/unresolved row or provider body is deleted by cancellation.
  MOZ_TRY(CaptureOfflineOperationInTransaction(
      folderId, key, saved.databaseSourceId, canceled, nullptr, &selected));
  MessageBodyState body;
  MOZ_TRY(ReadMessageBodyState(key, body));
  canceled.mData->restoredBody = Some(std::move(body));
  return NS_OK;
}

nsresult MessageDatabase::ReapplyOfflineMoveInTransaction(
    uint64_t folderId, nsMsgKey key, const OfflineOperationUndo& redo,
    OfflineOperationUndo& nextOffline) {
  NS_ENSURE_TRUE(redo.mData && redo.mData->redoState, NS_ERROR_NOT_AVAILABLE);
  const auto& saved = *redo.mData;
  const auto& canceled = *saved.redoState;
  NS_ENSURE_TRUE(canceled.restoredBody &&
                     canceled.operation.folderId == folderId &&
                     canceled.operation.key == key &&
                     canceled.operation.id == saved.operation.id,
                 NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(ValidateOfflineUndoState(canceled, true));
  MessageBodyState body;
  MOZ_TRY(ReadMessageBodyState(key, body));
  NS_ENSURE_TRUE(SameBodyGuard(body, *canceled.restoredBody),
                 NS_ERROR_NOT_AVAILABLE);
  const auto& payload = saved.operation.payload;
  NS_ENSURE_TRUE(
      (payload.operation & OfflineOp::kMsgMoved) && payload.pendingDestination,
      NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(ValidatePendingDestination(*payload.pendingDestination, folderId, key,
                                     false, canceled.operation.id));
  for (const auto& target : payload.copyDestinationBindings) {
    if (target) {
      MOZ_TRY(ValidatePendingDestination(*target, folderId, key, false,
                                         canceled.operation.id));
    }
  }
  uint32_t uid;
  MOZ_TRY(GetMessageUidOnServer(key, uid));
  NS_ENSURE_TRUE(saved.operation.source && uid == saved.operation.source->uid,
                 NS_ERROR_NOT_AVAILABLE);
  bool reactivated = false;
  for (uint32_t i = 0; i < canceled.destinationOperations.Length(); ++i) {
    const auto& child = canceled.destinationOperations[i];
    if (!child.restoredBody) {
      continue;
    }
    NS_ENSURE_TRUE(!reactivated &&
                       child.folderId == payload.pendingDestination->folderId &&
                       child.key == payload.pendingDestination->key,
                   NS_ERROR_NOT_AVAILABLE);
    const OfflineOperationUndo::Data::Operation* original = nullptr;
    for (const auto& candidate : saved.destinationOperations) {
      if (candidate.id == child.id && candidate.folderId == child.folderId &&
          candidate.key == child.key) {
        original = &candidate;
        break;
      }
    }
    NS_ENSURE_TRUE(
        original && (original->payload.operation & OfflineOp::kMoveResult),
        NS_ERROR_NOT_AVAILABLE);
    const auto& full = original->payload;
    OfflineOperationData restored{full.operation,
                                  full.flagOperation,
                                  full.newFlags,
                                  key,
                                  full.sourceUid,
                                  full.messageSize,
                                  full.playingBack,
                                  full.sourceFolderURI,
                                  full.destinationFolderURI,
                                  full.keywordsToAdd,
                                  full.keywordsToRemove,
                                  full.copyDestinations.Clone(),
                                  full.pendingDestination,
                                  full.copyDestinationBindings.Clone(),
                                  full.flagMutation,
                                  full.moveSourceGuard};
    int64_t id, revision;
    Maybe<ServerMessageLocation> source;
    nsresult found = ReadOfflineOperationIdentity(child.folderId, child.key, id,
                                                  revision, source);
    NS_ENSURE_TRUE(NS_SUCCEEDED(found) || found == NS_ERROR_NOT_AVAILABLE,
                   found);
    bool cleanedEmpty = found == NS_ERROR_NOT_AVAILABLE;
    MOZ_TRY(StoreOfflineOperationInTransaction(
        child.folderId, child.key, restored, cleanedEmpty ? &redo : nullptr,
        cleanedEmpty, cleanedEmpty ? Some(i) : Nothing()));
    reactivated = true;
  }
  NS_ENSURE_TRUE(reactivated, NS_ERROR_NOT_AVAILABLE);
  int64_t id, revision;
  Maybe<ServerMessageLocation> source;
  nsresult found =
      ReadOfflineOperationIdentity(folderId, key, id, revision, source);
  NS_ENSURE_TRUE(NS_SUCCEEDED(found) || found == NS_ERROR_NOT_AVAILABLE, found);
  bool cleanedEmpty = found == NS_ERROR_NOT_AVAILABLE;
  MOZ_TRY(StoreOfflineOperationInTransaction(
      folderId, key, payload, cleanedEmpty ? &redo : nullptr, cleanedEmpty));
  return CaptureOfflineOperationInTransaction(
      folderId, key, saved.databaseSourceId, nextOffline, nullptr);
}

nsresult MessageDatabase::RestoreOfflineOperationInTransaction(
    uint64_t folderId, nsMsgKey key, const RemovedMessage& removed,
    OfflineOperationUndo& offline) {
  const auto& saved = *offline.mData;
  const auto& op = saved.operation;
  const auto& body = removed.mData->body;
  NS_ENSURE_TRUE(folderId == op.folderId && folderId == body.folderId &&
                     op.key == body.key &&
                     saved.databaseSourceId == body.databaseSourceId,
                 NS_ERROR_NOT_AVAILABLE);
  nsCString current;
  MOZ_TRY(DatabaseCore::sInstance->ReadSourceIdForFolderAdmission(current));
  NS_ENSURE_TRUE(current == saved.databaseSourceId, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(RequireOfflineUndoQueued(op.id, op.payload));
  int64_t retainedId = 0, retainedRevision = 0;
  Maybe<ServerMessageLocation> retainedSource;
  Maybe<uint32_t> retainedEpoch;
  nsresult retained = ReadOfflineOperationIdentity(
      op.folderId, op.key, retainedId, retainedRevision, retainedSource,
      &retainedEpoch);
  if (NS_FAILED(retained) && retained != NS_ERROR_NOT_AVAILABLE) {
    return retained;
  }
  if (NS_SUCCEEDED(retained)) {
    OfflineOperationData payload;
    MOZ_TRY(GetOfflineOperation(op.folderId, op.key, payload));
    NS_ENSURE_TRUE(retainedId == op.id && retainedRevision == op.revision &&
                       SameOfflineSource(retainedSource, op.source) &&
                       retainedEpoch == op.folderEpoch &&
                       SameOfflinePayload(payload, op.payload),
                   NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(RequireOfflineUndoQueued(retainedId, payload));
  }
  // Retained operations bypass Store's source capture. Recheck the immutable
  // server epoch and every actual physical target before rekeying that intent.
  if (op.source) {
    uint32_t epoch;
    MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(
        op.source->folderId, epoch));
    NS_ENSURE_TRUE(epoch == op.source->epoch, NS_ERROR_NOT_AVAILABLE);
  }
  auto validateTarget = [&](const Maybe<PendingDestination>& target,
                            bool selfAppend) -> nsresult {
    if (!target) {
      return NS_OK;
    }
    auto currentTarget = *target;
    if (selfAppend) {
      currentTarget.key = key;
    }
    return ValidatePendingDestination(
        currentTarget, folderId, selfAppend ? key : op.key, selfAppend, op.id);
  };
  bool selfAppend = op.payload.pendingDestination &&
                    op.payload.pendingDestination->folderId == folderId &&
                    op.payload.pendingDestination->key == op.key &&
                    (op.payload.operation &
                     (OfflineOp::kAppendDraft | OfflineOp::kAppendTemplate));
  MOZ_TRY(validateTarget(op.payload.pendingDestination, selfAppend));
  for (const auto& target : op.payload.copyDestinationBindings) {
    MOZ_TRY(validateTarget(target, false));
  }
  // Validate the whole captured target set before changing any association.
  for (const auto& child : saved.destinationOperations) {
    int64_t id = 0, revision = 0;
    Maybe<ServerMessageLocation> source;
    nsresult found = ReadOfflineOperationIdentity(child.folderId, child.key, id,
                                                  revision, source);
    if (!child.id && found == NS_ERROR_NOT_AVAILABLE) {
      continue;
    }
    MOZ_TRY(found);
    NS_ENSURE_TRUE(child.id && id == child.id && revision == child.revision &&
                       SameOfflineSource(source, child.source),
                   NS_ERROR_NOT_AVAILABLE);
    OfflineOperationData payload;
    MOZ_TRY(GetOfflineOperation(child.folderId, child.key, payload));
    NS_ENSURE_TRUE(SameOfflinePayload(payload, child.payload),
                   NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(RequireOfflineUndoQueued(id, payload));
  }
  OfflineOperationData restored{op.payload.operation,
                                op.payload.flagOperation,
                                op.payload.newFlags,
                                op.payload.sourceKey,
                                op.payload.sourceUid,
                                op.payload.messageSize,
                                op.payload.playingBack,
                                op.payload.sourceFolderURI,
                                op.payload.destinationFolderURI,
                                op.payload.keywordsToAdd,
                                op.payload.keywordsToRemove,
                                op.payload.copyDestinations.Clone(),
                                op.payload.pendingDestination,
                                op.payload.copyDestinationBindings.Clone(),
                                op.payload.flagMutation,
                                op.payload.moveSourceGuard};
  // An explicitly saved APPEND target is the operation's own physical row.
  // Reattach that actual binding, never a URI/key-based inferred counterpart.
  if (restored.pendingDestination &&
      restored.pendingDestination->folderId == folderId &&
      restored.pendingDestination->key == op.key) {
    NS_ENSURE_TRUE(restored.operation &
                       (OfflineOp::kAppendDraft | OfflineOp::kAppendTemplate),
                   NS_ERROR_INVALID_ARG);
    restored.pendingDestination->key = key;
  }
  if (NS_SUCCEEDED(retained)) {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "RestoreRetainedOfflineSource"_ns,
        "UPDATE offline_operations SET messageKey=:fresh, "
        "destinationKey=CASE WHEN destinationFolderId=:folder AND "
        "destinationKey=:old THEN :fresh ELSE destinationKey END "
        "WHERE id=:id AND revision=:revision AND folderId=:folder AND "
        "messageKey=:old RETURNING id"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("fresh"_ns, key));
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
    MOZ_TRY(stmt->BindInt64ByName("old"_ns, op.key));
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, op.id));
    MOZ_TRY(stmt->BindInt64ByName("revision"_ns, op.revision));
    bool changed;
    MOZ_TRY(stmt->ExecuteStep(&changed));
    NS_ENSURE_TRUE(changed, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(stmt->ExecuteStep(&changed));
    NS_ENSURE_FALSE(changed, NS_ERROR_FILE_CORRUPTED);
  } else {
    MOZ_TRY(
        StoreOfflineOperationInTransaction(folderId, key, restored, &offline));
  }
  for (const auto& child : saved.destinationOperations) {
    if (!child.id) {
      continue;
    }
    OfflineOperationData payload;
    MOZ_TRY(GetOfflineOperation(child.folderId, child.key, payload));
    payload.sourceKey = key;
    MOZ_TRY(
        StoreOfflineOperationInTransaction(child.folderId, child.key, payload));
  }
  if (saved.counterpart) {
    const auto& expected = saved.counterpartOperation;
    const auto& binding = *saved.counterpart;
    int64_t id, revision;
    Maybe<ServerMessageLocation> source;
    MOZ_TRY(ReadOfflineOperationIdentity(expected.folderId, expected.key, id,
                                         revision, source));
    NS_ENSURE_TRUE(id == expected.id && revision == expected.revision,
                   NS_ERROR_NOT_AVAILABLE);
    OfflineOperationData payload;
    MOZ_TRY(GetOfflineOperation(expected.folderId, expected.key, payload));
    MOZ_TRY(RequireOfflineUndoQueued(id, payload));
    NS_ENSURE_TRUE(payload.operation & binding.action, NS_ERROR_NOT_AVAILABLE);
    Maybe<PendingDestination>* target;
    if (binding.copyOrdinal) {
      NS_ENSURE_TRUE(
          *binding.copyOrdinal < payload.copyDestinationBindings.Length(),
          NS_ERROR_NOT_AVAILABLE);
      target = &payload.copyDestinationBindings[*binding.copyOrdinal];
    } else {
      target = &payload.pendingDestination;
    }
    NS_ENSURE_TRUE(
        *target && SamePendingDestination(**target, binding.destination),
        NS_ERROR_NOT_AVAILABLE);
    (*target)->key = key;
    MOZ_TRY(StoreOfflineOperationInTransaction(expected.folderId, expected.key,
                                               payload));
  }
  return NS_OK;
}

nsresult MessageDatabase::ValidatePendingDestination(
    const PendingDestination& destination, uint64_t folderId, nsMsgKey key,
    bool append, int64_t operationId) {
  NS_ENSURE_TRUE(destination.folderId && destination.folderId <= INT64_MAX &&
                     destination.key && destination.key < nsMsgKey_None,
                 NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(
      append ? (destination.folderId == folderId && destination.key == key)
             : destination.key != key,
      NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(DatabaseCore::sInstance, NS_ERROR_NOT_AVAILABLE);
  uint32_t epoch;
  nsresult epochRv = DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(
      destination.folderId, epoch);
  if (destination.epochKnown) {
    MOZ_TRY(epochRv);
    NS_ENSURE_TRUE(epoch == destination.epoch, NS_ERROR_NOT_AVAILABLE);
  } else {
    NS_ENSURE_TRUE(destination.epoch == 0, NS_ERROR_INVALID_ARG);
    if (NS_FAILED(epochRv) && epochRv != NS_ERROR_NOT_AVAILABLE) {
      return epochRv;
    }
    if (NS_SUCCEEDED(epochRv)) {
      nsCOMPtr<mozIStorageStatement> queued;
      MOZ_TRY(DatabaseCore::GetStatement(
          "UnobservedDestinationAlreadyQueued"_ns,
          "SELECT 1 FROM offline_operations WHERE id=:id AND "
          "destinationFolderId=:folder AND destinationKey=:key AND "
          "destinationEpoch IS NULL UNION ALL SELECT 1 FROM "
          "offline_copy_destinations WHERE operationId=:id AND "
          "destinationFolderId=:folder AND destinationKey=:key AND "
          "destinationEpoch IS NULL LIMIT 1"_ns,
          getter_AddRefs(queued)));
      mozStorageStatementScoper scope(queued);
      MOZ_TRY(queued->BindInt64ByName("id"_ns, operationId));
      MOZ_TRY(queued->BindInt64ByName("folder"_ns, destination.folderId));
      MOZ_TRY(queued->BindInt64ByName("key"_ns, destination.key));
      bool prior;
      MOZ_TRY(queued->ExecuteStep(&prior));
      NS_ENSURE_TRUE(prior, NS_ERROR_NOT_AVAILABLE);
    }
  }
  {
    nsCOMPtr<mozIStorageStatement> member;
    MOZ_TRY(DatabaseCore::GetStatement(
        "OfflineDestinationMember"_ns,
        "SELECT folderId FROM messages WHERE id = :key UNION ALL "
        "SELECT folderId FROM staged_messages WHERE id = :key"_ns,
        getter_AddRefs(member)));
    mozStorageStatementScoper scope(member);
    MOZ_TRY(member->BindInt64ByName("key"_ns, destination.key));
    bool exists;
    MOZ_TRY(member->ExecuteStep(&exists));
    NS_ENSURE_TRUE(exists, NS_ERROR_NOT_AVAILABLE);
    int64_t actual;
    MOZ_TRY(member->GetInt64(0, &actual));
    NS_ENSURE_TRUE(actual > 0 && uint64_t(actual) == destination.folderId,
                   NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(member->ExecuteStep(&exists));
    NS_ENSURE_FALSE(exists, NS_ERROR_FILE_CORRUPTED);
  }
  nsTArray<nsCString> names;
  MOZ_TRY(GetMessagePropertyNames(destination.key, names));
  NS_ENSURE_FALSE(names.Contains("uidOnServer"_ns), NS_ERROR_NOT_AVAILABLE);
  {
    nsCOMPtr<mozIStorageStatement> used;
    MOZ_TRY(DatabaseCore::GetStatement(
        "OfflineDestinationAlreadyUsed"_ns,
        "SELECT 1 FROM offline_attempts WHERE destinationKey = :key "
        "AND state IN (1, 2, 3) LIMIT 1"_ns,
        getter_AddRefs(used)));
    mozStorageStatementScoper scope(used);
    MOZ_TRY(used->BindInt64ByName("key"_ns, destination.key));
    bool exists;
    MOZ_TRY(used->ExecuteStep(&exists));
    NS_ENSURE_FALSE(exists, NS_ERROR_NOT_AVAILABLE);
  }
  nsCOMPtr<mozIStorageStatement> claimed;
  MOZ_TRY(DatabaseCore::GetStatement(
      "OfflineDestinationClaimed"_ns,
      "SELECT 1 FROM offline_operations WHERE destinationKey = :key AND id <> "
      ":id "
      "UNION ALL SELECT 1 FROM offline_copy_destinations WHERE destinationKey "
      "= :key "
      "AND operationId <> :id LIMIT 1"_ns,
      getter_AddRefs(claimed)));
  mozStorageStatementScoper scope(claimed);
  MOZ_TRY(claimed->BindInt64ByName("key"_ns, destination.key));
  MOZ_TRY(claimed->BindInt64ByName("id"_ns, operationId));
  bool exists;
  MOZ_TRY(claimed->ExecuteStep(&exists));
  return exists ? NS_ERROR_NOT_AVAILABLE : NS_OK;
}

nsresult MessageDatabase::GetOfflineOperation(uint64_t folderId, nsMsgKey key,
                                              OfflineOperationData& output) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ReadOfflineOperation"_ns,
      "SELECT id, operation, flagOperation, newFlags, sourceKey, sourceUid, "
      "messageSize, playingBack, sourceFolderURI, destinationFolderURI, "
      "keywordsToAdd, keywordsToRemove, destinationFolderId, destinationKey, "
      "destinationEpoch, flagSetMask, flagClearMask, guardSourceId, "
      "guardFolderId, guardKey, guardContentRevision, guardLocationRevision, "
      "guardStoreToken, guardMessageSize, guardOfflineSize, guardLineCount, "
      "guardFlags, guardPresence FROM offline_operations "
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
  MOZ_TRY(ReadOfflineDestination(stmt, 12, found.pendingDestination));
  MOZ_TRY(
      ReadReplayPayload(stmt, 15, found.flagMutation, found.moveSourceGuard));
  nsCOMPtr<mozIStorageStatement> copies;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ReadOfflineCopies"_ns,
      "SELECT ordinal, uri, destinationFolderId, destinationKey, "
      "destinationEpoch "
      "FROM offline_copy_destinations WHERE operationId = :id "
      "ORDER BY ordinal"_ns,
      getter_AddRefs(copies)));
  mozStorageStatementScoper copyScoper(copies);
  MOZ_TRY(copies->BindInt64ByName("id"_ns, id));
  while (true) {
    MOZ_TRY(copies->ExecuteStep(&more));
    if (!more) {
      break;
    }
    uint32_t ordinal;
    MOZ_TRY(OfflineUint32(copies, 0, ordinal));
    NS_ENSURE_TRUE(ordinal == found.copyDestinations.Length(),
                   NS_ERROR_FILE_CORRUPTED);
    nsCString uri;
    MOZ_TRY(copies->GetUTF8String(1, uri));
    Maybe<PendingDestination> destination;
    MOZ_TRY(ReadOfflineDestination(copies, 2, destination));
    found.copyDestinations.AppendElement(std::move(uri));
    found.copyDestinationBindings.AppendElement(destination);
  }
  output = std::move(found);
  return NS_OK;
}

nsresult MessageDatabase::QueueOfflineProtocolFlagMutation(
    const nsACString& databaseSourceId, uint64_t folderId,
    nsMsgKey operationKey, const ServerMessageLocation& expectedSource,
    int32_t protocolMask, bool addFlags) {
  NS_ENSURE_TRUE(protocolMask >= 0 && !(uint32_t(protocolMask) & ~0xDFu) &&
                     folderId && folderId <= INT64_MAX && operationKey &&
                     operationKey < nsMsgKey_None &&
                     expectedSource.folderId == folderId &&
                     expectedSource.key && expectedSource.key < nsMsgKey_None,
                 NS_ERROR_INVALID_ARG);
  MOZ_TRY(RequireCommittedSearchRead());
  nsCString sourceId;
  MOZ_TRY(DatabaseCore::sInstance->ReadSourceIdForFolderAdmission(sourceId));
  NS_ENSURE_TRUE(sourceId == databaseSourceId, NS_ERROR_NOT_AVAILABLE);
  auto connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    int64_t id = 0, revision = 0;
    Maybe<ServerMessageLocation> source;
    nsresult found = ReadOfflineOperationIdentity(folderId, operationKey, id,
                                                  revision, source);
    OfflineOperationData payload;
    if (found == NS_ERROR_NOT_AVAILABLE) {
      MessageBodyState body;
      MOZ_TRY(ReadMessageBodyState(operationKey, body));
      NS_ENSURE_TRUE(
          body.folderId == folderId && operationKey == expectedSource.key,
          NS_ERROR_NOT_AVAILABLE);
      uint32_t epoch, uid;
      nsTArray<nsCString> names;
      MOZ_TRY(GetMessagePropertyNames(operationKey, names));
      NS_ENSURE_TRUE(names.Contains("uidOnServer"_ns), NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(GetMessageUidOnServer(operationKey, uid));
      MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(folderId,
                                                                       epoch));
      NS_ENSURE_TRUE(uid == expectedSource.uid && epoch == expectedSource.epoch,
                     NS_ERROR_NOT_AVAILABLE);
    } else {
      MOZ_TRY(found);
      NS_ENSURE_TRUE(SameOfflineSource(source, Some(expectedSource)),
                     NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(GetOfflineOperation(folderId, operationKey, payload));
    }
    if (!protocolMask) return connection->CommitTransaction();
    NS_ENSURE_TRUE(
        !(payload.operation & OfflineOp::kFlagsChanged) || payload.flagMutation,
        NS_ERROR_NOT_AVAILABLE);
    if (!payload.flagMutation)
      payload.flagMutation = Some(OfflineFlagMutation{});
    auto& flags = *payload.flagMutation;
    uint16_t mask = uint16_t(protocolMask);
    if (addFlags) {
      flags.setMask |= mask;
      flags.clearMask &= ~mask;
    } else {
      flags.clearMask |= mask;
      flags.setMask &= ~mask;
    }
    payload.operation |= OfflineOp::kFlagsChanged;
    MOZ_TRY(StoreOfflineOperationInTransaction(
        folderId, operationKey, payload, nullptr, false, Nothing(), true));
    return connection->CommitTransaction();
  }();
  return FinishOfflineWrite(connection, rv);
}

nsresult MessageDatabase::ReadExpectedReplayAttempt(
    const OfflineAttempt& expected, OfflineAttempt& actual) {
  NS_ENSURE_TRUE(expected.id, NS_ERROR_INVALID_ARG);
  MOZ_TRY(GetOfflineAttempt(expected.id, actual));
  NS_ENSURE_TRUE(
      actual.replayVersion == 1 && expected.replayVersion == 1 &&
          actual.operationId == expected.operationId &&
          actual.revision == expected.revision &&
          actual.operation == expected.operation &&
          actual.folderId == expected.folderId &&
          actual.operationKey == expected.operationKey &&
          actual.copyOrdinal == expected.copyOrdinal &&
          actual.confirmedUid == expected.confirmedUid &&
          actual.confirmedEpoch == expected.confirmedEpoch &&
          actual.transferSourceId == expected.transferSourceId &&
          SameOfflineSource(actual.source, expected.source) &&
          actual.destination.isSome() == expected.destination.isSome() &&
          (!actual.destination ||
           SamePendingDestination(*actual.destination,
                                  *expected.destination)) &&
          actual.transferBody.isSome() == expected.transferBody.isSome() &&
          (!actual.transferBody ||
           SameBodyGuard(*actual.transferBody, *expected.transferBody)) &&
          SameFlagMutation(actual.flagMutation, expected.flagMutation) &&
          SameMoveGuard(actual.moveSourceGuard, expected.moveSourceGuard),
      NS_ERROR_NOT_AVAILABLE);
  nsCString sourceId;
  MOZ_TRY(DatabaseCore::sInstance->ReadSourceIdForFolderAdmission(sourceId));
  NS_ENSURE_TRUE(actual.transferSourceId == sourceId, NS_ERROR_NOT_AVAILABLE);
  return NS_OK;
}

nsresult MessageDatabase::ValidateReplaySource(const OfflineAttempt& attempt,
                                               bool& present) {
  NS_ENSURE_TRUE(attempt.source, NS_ERROR_NOT_AVAILABLE);
  uint32_t epoch;
  MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(
      attempt.source->folderId, epoch));
  NS_ENSURE_TRUE(epoch == attempt.source->epoch, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(DatabaseCore::sInstance->CheckFolderRelocationRecovery(
      attempt.source->folderId));
  {
    nsCOMPtr<mozIStorageStatement> relocation;
    MOZ_TRY(DatabaseCore::GetStatement(
        "ReplaySourceFolderRelocation"_ns,
        "SELECT 1 FROM body_relocations WHERE folderId=:folder AND state NOT IN(1,2) LIMIT 1"_ns,
        getter_AddRefs(relocation)));
    mozStorageStatementScoper scope(relocation);
    MOZ_TRY(relocation->BindInt64ByName("folder"_ns, attempt.source->folderId));
    bool pending;
    MOZ_TRY(relocation->ExecuteStep(&pending));
    NS_ENSURE_FALSE(pending, NS_ERROR_IN_PROGRESS);
  }
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ReplaySourceMember"_ns,
      "SELECT folderId,0 FROM messages WHERE id=:key UNION ALL "
      "SELECT folderId,1 FROM staged_messages WHERE id=:key"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("key"_ns, attempt.source->key));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  if (!more) {
    // A proven queued flag action addresses the once-captured server tuple.
    // The queued MOVE producer may already have removed local membership.
    // Absence grants no UID/epoch inference and no destructive MOVE authority.
    if (attempt.operation == OfflineOp::kFlagsChanged && attempt.flagMutation) {
      present = false;
      return NS_OK;
    }

    NS_ENSURE_TRUE(
        attempt.moveSourceGuard && attempt.moveSourceGuard->presence ==
                                       OfflineMoveLocalPresence::ExactOrAbsent,
        NS_ERROR_NOT_AVAILABLE);
    const auto& original = attempt.moveSourceGuard->original;
    NS_ENSURE_TRUE(original.key == attempt.source->key &&
                       original.folderId == attempt.source->folderId &&
                       original.databaseSourceId == attempt.transferSourceId,
                   NS_ERROR_NOT_AVAILABLE);
    present = false;
    return NS_OK;
  }
  int64_t folder, staged;
  MOZ_TRY(ReplayInteger(stmt, 0, folder));
  MOZ_TRY(ReplayInteger(stmt, 1, staged));
  NS_ENSURE_TRUE(
      folder > 0 && uint64_t(folder) == attempt.source->folderId && !staged,
      NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  nsTArray<nsCString> names;
  MOZ_TRY(GetMessagePropertyNames(attempt.source->key, names));
  NS_ENSURE_TRUE(names.Contains("uidOnServer"_ns), NS_ERROR_NOT_AVAILABLE);
  uint32_t uid;
  MOZ_TRY(GetMessageUidOnServer(attempt.source->key, uid));
  NS_ENSURE_TRUE(uid == attempt.source->uid, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(CheckPendingMessageRelocation(attempt.source->key));
  if (attempt.moveSourceGuard) {
    MessageBodyState actual;
    MOZ_TRY(ReadMessageBodyState(attempt.source->key, actual));
    NS_ENSURE_TRUE(SameBodyGuard(actual, attempt.moveSourceGuard->original),
                   NS_ERROR_NOT_AVAILABLE);
  }
  present = true;
  return NS_OK;
}

nsresult MessageDatabase::OfflineReplayActionsComplete(
    const OfflineAttempt& move, bool sourceOnly, bool& complete) {
  OfflineOperationData payload;
  MOZ_TRY(GetOfflineOperation(move.folderId, move.operationKey, payload));
  for (uint32_t action = 1; action <= OfflineOp::kRemoveKeywords;
       action <<= 1) {
    if (!(payload.operation & action) || action == OfflineOp::kMoveResult ||
        action == OfflineOp::kAddedHeader)
      continue;
    if (action == OfflineOp::kMsgMoved) continue;
    if (sourceOnly && action != OfflineOp::kFlagsChanged &&
        action != OfflineOp::kAddKeywords &&
        action != OfflineOp::kRemoveKeywords && action != OfflineOp::kMsgCopy)
      continue;
    uint32_t count =
        action == OfflineOp::kMsgCopy ? payload.copyDestinations.Length() : 1;
    if (!count) {
      complete = false;
      return NS_OK;
    }
    for (uint32_t i = 0; i < count; ++i) {
      OfflineAttempt other;
      nsresult rv = GetOfflineAttemptForAction(
          move.folderId, move.operationKey, action,
          action == OfflineOp::kMsgCopy ? Some(i) : Nothing(), other);
      if (rv == NS_ERROR_NOT_AVAILABLE) {
        complete = false;
        return NS_OK;
      }
      MOZ_TRY(rv);
      if (other.state != OfflineAttemptState::Confirmed ||
          other.revision != move.revision) {
        complete = false;
        return NS_OK;
      }
    }
  }
  complete = true;
  return NS_OK;
}

nsresult MessageDatabase::ValidateReplayMove(const OfflineAttempt& attempt) {
  NS_ENSURE_TRUE(attempt.operation == OfflineOp::kMsgMoved &&
                     !attempt.copyOrdinal && attempt.moveSourceGuard &&
                     attempt.confirmedUid && attempt.confirmedEpoch &&
                     attempt.state == OfflineAttemptState::Confirmed &&
                     attempt.transferBody && attempt.destination,
                 NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(ValidateTransferTargetInTransaction(attempt));
  uint32_t uid;
  nsTArray<nsCString> names;
  MOZ_TRY(GetMessagePropertyNames(attempt.destination->key, names));
  NS_ENSURE_TRUE(names.Contains("uidOnServer"_ns), NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(GetMessageUidOnServer(attempt.destination->key, uid));
  NS_ENSURE_TRUE(uid == *attempt.confirmedUid, NS_ERROR_NOT_AVAILABLE);
  uint32_t epoch;
  MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(
      attempt.destination->folderId, epoch));
  NS_ENSURE_TRUE(epoch == *attempt.confirmedEpoch, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(CheckPendingMessageRelocation(attempt.destination->key));
  bool present;
  MOZ_TRY(ValidateReplaySource(attempt, present));
  return NS_OK;
}

nsresult MessageDatabase::PlanOfflineMoveSource(
    const OfflineAttempt& expected, const OfflineMoveSourcePlan& plan,
    OfflineAttempt& output) {
  NS_ENSURE_TRUE(uint8_t(plan.expunge) <= uint8_t(OfflineMoveExpunge::Mailbox),
                 NS_ERROR_INVALID_ARG);
  MOZ_TRY(RequireCommittedSearchRead());
  auto connection = DatabaseCore::sConnection;
  OfflineAttempt actual;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    MOZ_TRY(ReadExpectedReplayAttempt(expected, actual));
    MOZ_TRY(ValidateReplayMove(actual));
    if (actual.moveSourcePlan) {
      NS_ENSURE_TRUE(actual.moveSourcePlan->expunge == plan.expunge,
                     NS_ERROR_NOT_AVAILABLE);
    } else {
      actual.moveSourcePlan = Some(plan);
      actual.sourceStore = Some(OfflineReplayCommandProgress{});
      if (plan.expunge != OfflineMoveExpunge::None)
        actual.sourceExpunge = Some(OfflineReplayCommandProgress{});
      MOZ_TRY(WriteReplayAttempt(DatabaseCore::sConnection, actual));
    }
    return connection->CommitTransaction();
  }();
  MOZ_TRY(FinishOfflineWrite(connection, rv));
  output = std::move(actual);
  return NS_OK;
}

nsresult MessageDatabase::BeginOfflineReplayCommand(
    const OfflineAttempt& expected, OfflineReplayCommand command,
    OfflineReplayCommandToken& output) {
  MOZ_TRY(RequireCommittedSearchRead());
  auto connection = DatabaseCore::sConnection;
  OfflineReplayCommandToken prepared;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    auto& actual = prepared.attempt;
    MOZ_TRY(ReadExpectedReplayAttempt(expected, actual));
    NS_ENSURE_FALSE(actual.moveSettled, NS_ERROR_NOT_AVAILABLE);
    QueuedSourceIdentity identity{actual.transferSourceId, actual.folderId,
                                  actual.operationKey,     actual.operationId,
                                  actual.revision,         actual.source};
    MOZ_TRY(ValidateQueuedSourceIdentity(identity));
    auto* selected = ReplayStep(actual, command);
    NS_ENSURE_TRUE(selected && *selected, NS_ERROR_NOT_AVAILABLE);
    auto& step = **selected;
    NS_ENSURE_TRUE(
        step.state == OfflineReplayCommandState::Pending ||
            step.state == OfflineReplayCommandState::RejectedNoEffect,
        NS_ERROR_NOT_AVAILABLE);
    NS_ENSURE_TRUE(step.generation < INT64_MAX, NS_ERROR_ILLEGAL_VALUE);
    if (command == OfflineReplayCommand::FlagSet ||
        command == OfflineReplayCommand::FlagClear) {
      NS_ENSURE_TRUE(actual.operation == OfflineOp::kFlagsChanged &&
                         actual.state == OfflineAttemptState::Sent,
                     NS_ERROR_NOT_AVAILABLE);
      bool present;
      MOZ_TRY(ValidateReplaySource(actual, present));
      if (command == OfflineReplayCommand::FlagClear && actual.flagSet)
        NS_ENSURE_TRUE(ReplayAcknowledged(actual.flagSet),
                       NS_ERROR_NOT_AVAILABLE);
    } else {
      MOZ_TRY(ValidateReplayMove(actual));
      bool complete;
      MOZ_TRY(OfflineReplayActionsComplete(actual, true, complete));
      NS_ENSURE_TRUE(complete, NS_ERROR_NOT_AVAILABLE);
      if (command != OfflineReplayCommand::MoveStore)
        NS_ENSURE_TRUE(ReplayAcknowledged(actual.sourceStore),
                       NS_ERROR_NOT_AVAILABLE);
    }
    step.state = OfflineReplayCommandState::Sent;
    ++step.generation;
    prepared.command = command;
    prepared.generation = step.generation;
    MOZ_TRY(WriteReplayAttempt(DatabaseCore::sConnection, actual));
    return connection->CommitTransaction();
  }();
  MOZ_TRY(FinishOfflineWrite(connection, rv));
  output = std::move(prepared);
  return NS_OK;
}

nsresult MessageDatabase::RecordOfflineReplayCommand(
    const OfflineReplayCommandToken& token, OfflineReplayReceipt receipt,
    nsresult actualStatus) {
  NS_ENSURE_TRUE(uint8_t(receipt) <= uint8_t(OfflineReplayReceipt::Ambiguous) &&
                     token.generation && token.generation <= INT64_MAX &&
                     (receipt != OfflineReplayReceipt::Acknowledged ||
                      NS_SUCCEEDED(actualStatus)) &&
                     (receipt != OfflineReplayReceipt::RejectedNoEffect ||
                      NS_FAILED(actualStatus)),
                 NS_ERROR_INVALID_ARG);
  MOZ_TRY(RequireCommittedSearchRead());
  auto connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    OfflineAttempt actual;
    MOZ_TRY(ReadExpectedReplayAttempt(token.attempt, actual));
    NS_ENSURE_TRUE(actual.moveSourcePlan.isSome() ==
                           token.attempt.moveSourcePlan.isSome() &&
                       (!actual.moveSourcePlan ||
                        actual.moveSourcePlan->expunge ==
                            token.attempt.moveSourcePlan->expunge),
                   NS_ERROR_NOT_AVAILABLE);
    OfflineAttempt sent = token.attempt;
    auto* dispatched = ReplayStep(sent, token.command);
    NS_ENSURE_TRUE(
        dispatched && *dispatched &&
            (**dispatched).state == OfflineReplayCommandState::Sent &&
            (**dispatched).generation == token.generation,
        NS_ERROR_NOT_AVAILABLE);
    auto* selected = ReplayStep(actual, token.command);
    NS_ENSURE_TRUE(selected && *selected, NS_ERROR_NOT_AVAILABLE);
    auto& step = **selected;
    NS_ENSURE_TRUE(step.generation == token.generation, NS_ERROR_NOT_AVAILABLE);
    auto state = receipt == OfflineReplayReceipt::Acknowledged
                     ? OfflineReplayCommandState::Acknowledged
                 : receipt == OfflineReplayReceipt::RejectedNoEffect
                     ? OfflineReplayCommandState::RejectedNoEffect
                     : OfflineReplayCommandState::Ambiguous;
    if (step.state == state) return connection->CommitTransaction();
    NS_ENSURE_TRUE(step.state == OfflineReplayCommandState::Sent,
                   NS_ERROR_NOT_AVAILABLE);
    QueuedSourceIdentity identity{actual.transferSourceId, actual.folderId,
                                  actual.operationKey,     actual.operationId,
                                  actual.revision,         actual.source};
    MOZ_TRY(ValidateQueuedSourceIdentity(identity));
    // A receipt records the wire fact even if the local body subsequently
    // changed. Destructive dispatch/settlement still revalidate all physical
    // guards.
    step.state = state;
    if (NS_FAILED(actualStatus)) {
      if (!step.firstError) step.firstError = Some(actualStatus);
      if (!actual.firstError) actual.firstError = Some(actualStatus);
    }
    MOZ_TRY(WriteReplayAttempt(DatabaseCore::sConnection, actual));
    return connection->CommitTransaction();
  }();
  return FinishOfflineWrite(connection, rv);
}

nsresult MessageDatabase::FinishOfflineMoveInTransaction(
    const OfflineAttempt& attempt, bool removed,
    OfflineMoveSettlement& output) {
  bool complete;
  MOZ_TRY(OfflineReplayActionsComplete(attempt, false, complete));
  if (complete) {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "RetireSettledOfflineMove"_ns,
        "DELETE FROM offline_operations WHERE id=:id AND revision=:revision RETURNING id"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, attempt.operationId));
    MOZ_TRY(stmt->BindInt64ByName("revision"_ns, attempt.revision));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_FALSE(more, NS_ERROR_UNEXPECTED);
  }
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "SettleOfflineMove"_ns,
      "UPDATE offline_attempts SET moveSettled=1,settledSourceRemoved=:removed,"
      "settledOperationRetired=:retired WHERE id=:id AND moveSettled=0 RETURNING id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, attempt.id));
  MOZ_TRY(stmt->BindInt64ByName("removed"_ns, removed));
  MOZ_TRY(stmt->BindInt64ByName("retired"_ns, complete));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_FALSE(more, NS_ERROR_UNEXPECTED);
  output = {attempt.id, attempt.destination->key, removed, complete};
  return NS_OK;
}

nsresult MessageDatabase::SettleOfflineMove(const OfflineAttempt& expected,
                                            OfflineMoveSettlement& output) {
  MOZ_TRY(RequireCommittedSearchRead());
  RefPtr<MessageDatabase> self(this);
  OfflineAttempt actual;
  MOZ_TRY(ReadExpectedReplayAttempt(expected, actual));
  NS_ENSURE_TRUE(
      actual.operation == OfflineOp::kMsgMoved && actual.destination &&
          actual.moveSourcePlan && ReplayAcknowledged(actual.sourceStore) &&
          (!actual.sourceExpunge || ReplayAcknowledged(actual.sourceExpunge)),
      NS_ERROR_NOT_AVAILABLE);
  if (actual.moveSettled) {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "ReadSettledOfflineMove"_ns,
        "SELECT settledSourceRemoved,settledOperationRetired FROM offline_attempts WHERE id=:id"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, actual.id));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
    uint32_t removed, retired;
    MOZ_TRY(OfflineUint32(stmt, 0, removed));
    MOZ_TRY(OfflineUint32(stmt, 1, retired));
    NS_ENSURE_TRUE(removed <= 1 && retired <= 1, NS_ERROR_FILE_CORRUPTED);
    output = {actual.id, actual.destination->key, bool(removed), bool(retired)};
    return NS_OK;
  }
  MOZ_TRY(ValidateReplayMove(actual));
  bool present;
  MOZ_TRY(ValidateReplaySource(actual, present));
  if (present) {
    return RemoveMessageInternal(actual.source->key, actual.source->folderId,
                                 &actual.transferSourceId,
                                 MessageRemovalAccounting::OfflineMessageSize,
                                 nullptr, nullptr, nullptr, &actual, &output);
  }
  auto connection = DatabaseCore::sConnection;
  OfflineMoveSettlement prepared;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    MOZ_TRY(ValidateReplayMove(actual));
    MOZ_TRY(FinishOfflineMoveInTransaction(actual, false, prepared));
    return connection->CommitTransaction();
  }();
  MOZ_TRY(FinishOfflineWrite(connection, rv));
  output = prepared;
  return NS_OK;
}

nsresult MessageDatabase::ReserveOfflineOperationKey(uint64_t folderId,
                                                     nsMsgKey& key) {
  MOZ_TRY(RequireCurrentOwner());
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
  NS_ENSURE_TRUE(input.copyDestinationBindings.IsEmpty() ||
                     input.copyDestinationBindings.Length() ==
                         input.copyDestinations.Length(),
                 NS_ERROR_INVALID_ARG);
  MOZ_TRY(RequireCurrentOwner());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool active;
  MOZ_TRY(connection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = StoreOfflineOperationInTransaction(folderId, key, input);
  if (NS_SUCCEEDED(rv)) {
    rv = connection->CommitTransaction();
  }
  return FinishOfflineWrite(connection, rv);
}

nsresult MessageDatabase::ImportOfflineOperationInTransaction(
    uint64_t folderId, nsMsgKey key, const OfflineOperationData& input,
    const Maybe<ServerMessageLocation>& source, uint64_t& operationId,
    uint64_t& revision) {
  MOZ_TRY(RequireCurrentOwner());
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_TRUE(active && folderId && key && key < nsMsgKey_None,
                 NS_ERROR_INVALID_ARG);
  NS_ENSURE_FALSE(
      input.playingBack || input.flagMutation || input.moveSourceGuard,
      NS_ERROR_NOT_AVAILABLE);
  if (source) {
    NS_ENSURE_TRUE(source->folderId == folderId && source->key == key,
                   NS_ERROR_INVALID_ARG);
    uint32_t epoch;
    MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(folderId,
                                                                     epoch));
    NS_ENSURE_TRUE(epoch == source->epoch && epoch && source->uid,
                   NS_ERROR_NOT_AVAILABLE);
  }
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ImportOfflineOperationIdentity"_ns,
      "INSERT INTO offline_operations(folderId,messageKey,revision,epoch,uid,"
      "sourcePhysicalKey,operation,flagOperation,newFlags,sourceKey,sourceUid,"
      "messageSize,playingBack,sourceFolderURI,destinationFolderURI,"
      "keywordsToAdd,keywordsToRemove) VALUES(:folder,:key,1,:epoch,:uid,"
      ":physical,0,0,0,4294967295,0,0,0,'','','','')"_ns,
      getter_AddRefs(stmt)));
  {
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
    MOZ_TRY(stmt->BindInt64ByName("key"_ns, key));
    if (source) {
      MOZ_TRY(stmt->BindInt64ByName("epoch"_ns, source->epoch));
      MOZ_TRY(stmt->BindInt64ByName("uid"_ns, source->uid));
      MOZ_TRY(stmt->BindInt64ByName("physical"_ns, source->key));
    } else {
      MOZ_TRY(stmt->BindNullByName("epoch"_ns));
      MOZ_TRY(stmt->BindNullByName("uid"_ns));
      MOZ_TRY(stmt->BindNullByName("physical"_ns));
    }
    MOZ_TRY(stmt->Execute());
  }
  // Legacy words do not carry the typed replay provenance required by MOVE
  // and flag mutation. Preserve the complete data under an atomic private hold;
  // neither the imported UID nor a later live header can supply that authority.
  if (input.operation & (OfflineOp::kMsgMoved | OfflineOp::kFlagsChanged)) {
    nsCString sourceId;
    MOZ_TRY(DatabaseCore::sInstance->ReadSourceIdForFolderAdmission(sourceId));
    MOZ_TRY(DatabaseCore::GetStatement(
        "HoldImportedOfflineOperation"_ns,
        "INSERT INTO imap_import_operation_holds(operationId,databaseSourceId,"
        "folderId,messageKey) SELECT id,:source,folderId,messageKey "
        "FROM offline_operations WHERE folderId=:folder AND messageKey=:key"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindUTF8StringByName("source"_ns, sourceId));
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
    MOZ_TRY(stmt->BindInt64ByName("key"_ns, key));
    MOZ_TRY(stmt->Execute());
  }
  // The existing whole-payload writer retains all ordinary correspondence and
  // mutation checks. Only the durable hold permits data without replay guards.
  MOZ_TRY(StoreOfflineOperationInTransaction(folderId, key, input));
  int64_t id, rev;
  Maybe<ServerMessageLocation> captured;
  MOZ_TRY(ReadOfflineOperationIdentity(folderId, key, id, rev, captured));
  NS_ENSURE_TRUE(id > 0 && rev > 0, NS_ERROR_FILE_CORRUPTED);
  operationId = id;
  revision = rev;
  return NS_OK;
}

nsresult MessageDatabase::StoreOfflineOperationInTransaction(
    uint64_t folderId, nsMsgKey key, const OfflineOperationData& input,
    const OfflineOperationUndo* restoring, bool restoreEmptyCanceledMove,
    const Maybe<uint32_t>& canceledDestination, bool typedFlagMutation) {
  int64_t id = 0, revision = 0;
  Maybe<ServerMessageLocation> source;
  Maybe<uint32_t> folderEpoch;
  nsresult found = ReadOfflineOperationIdentity(folderId, key, id, revision,
                                                source, &folderEpoch);
  if (NS_FAILED(found) && found != NS_ERROR_NOT_AVAILABLE) {
    return found;
  }
  if (restoring) {
    NS_ENSURE_FALSE(id, NS_ERROR_NOT_AVAILABLE);
    source = restoring->mData->operation.source;
    folderEpoch = restoring->mData->operation.folderEpoch;
  }
  if (restoreEmptyCanceledMove) {
    NS_ENSURE_TRUE(restoring && restoring->mData->redoState,
                   NS_ERROR_NOT_AVAILABLE);
    const auto& state = *restoring->mData->redoState;
    const auto* canceled = &state.operation;
    if (canceledDestination) {
      NS_ENSURE_TRUE(
          *canceledDestination < state.destinationOperations.Length(),
          NS_ERROR_NOT_AVAILABLE);
      canceled = &state.destinationOperations[*canceledDestination];
      NS_ENSURE_TRUE(canceled->restoredBody, NS_ERROR_NOT_AVAILABLE);
    }
    NS_ENSURE_TRUE(!canceled->payload.operation &&
                       canceled->folderId == folderId && canceled->key == key,
                   NS_ERROR_NOT_AVAILABLE);
    id = canceled->id;
    revision = canceled->revision;
    source = canceled->source;
    folderEpoch = canceled->folderEpoch;
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
      MOZ_TRY(member->ExecuteStep(&exists));
      NS_ENSURE_FALSE(exists, NS_ERROR_FILE_CORRUPTED);
      // A missing historical tuple must never acquire a later binding.
      if (!id && !restoring && names.Contains("uidOnServer"_ns)) {
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
  bool held = false;
  if (id) {
    MOZ_TRY(ReadOfflineImportHold(id, held));
  }
  NS_ENSURE_FALSE(held && input.playingBack, NS_ERROR_NOT_AVAILABLE);
  Maybe<OfflineFlagMutation> replayFlags;
  Maybe<OfflineMoveSourceGuard> replayGuard;
  OfflineOperationData previous;
  if (id && !restoreEmptyCanceledMove) {
    MOZ_TRY(GetOfflineOperation(folderId, key, previous));
    replayFlags = previous.flagMutation;
    replayGuard = previous.moveSourceGuard;
  } else if (restoring) {
    replayFlags = input.flagMutation;
    replayGuard = input.moveSourceGuard;
  }
  if (typedFlagMutation) {
    replayFlags = input.flagMutation;
  } else if (input.invalidateFlagMutation) {
    replayFlags.reset();
  } else {
    NS_ENSURE_TRUE(SameFlagMutation(input.flagMutation, replayFlags),
                   NS_ERROR_NOT_AVAILABLE);
  }
  if (replayFlags) {
    NS_ENSURE_TRUE(
        !((replayFlags->setMask | replayFlags->clearMask) & ~0xDFu) &&
            !(replayFlags->setMask & replayFlags->clearMask),
        NS_ERROR_INVALID_ARG);
  }
  NS_ENSURE_TRUE(SameMoveGuard(input.moveSourceGuard, replayGuard),
                 NS_ERROR_NOT_AVAILABLE);
  if (!held && !restoring && !replayGuard &&
      (input.operation & OfflineOp::kMsgMoved) &&
      !(previous.operation & OfflineOp::kMsgMoved)) {
    if (source) {
      MessageBodyState original;
      MOZ_TRY(ReadMessageBodyState(source->key, original));
      NS_ENSURE_TRUE(original.folderId == source->folderId,
                     NS_ERROR_NOT_AVAILABLE);
      replayGuard = Some(OfflineMoveSourceGuard{
          std::move(original), OfflineMoveLocalPresence::ExactOrAbsent});
    }
  }
  nsTArray<nsMsgKey> destinations;
  if (input.pendingDestination) {
    uint32_t action =
        input.operation & (OfflineOp::kMsgMoved | OfflineOp::kAppendDraft |
                           OfflineOp::kAppendTemplate);
    NS_ENSURE_TRUE(action && !(action & (action - 1)), NS_ERROR_INVALID_ARG);
    bool append = action != OfflineOp::kMsgMoved;
    MOZ_TRY(ValidatePendingDestination(*input.pendingDestination, folderId, key,
                                       append, id));
    destinations.AppendElement(input.pendingDestination->key);
  }
  for (const auto& destination : input.copyDestinationBindings) {
    if (!destination) {
      continue;
    }
    // Clearing COPY consumes only its first entry; the saved tail is not
    // dispatch authority until COPY is explicitly queued again.
    NS_ENSURE_FALSE(destinations.Contains(destination->key),
                    NS_ERROR_INVALID_ARG);
    MOZ_TRY(ValidatePendingDestination(*destination, folderId, key, false, id));
    destinations.AppendElement(destination->key);
  }
  if (input.operation & OfflineOp::kDeleteAllMsgs) {
    if (!folderEpoch) {
      NS_ENSURE_TRUE(DatabaseCore::sInstance, NS_ERROR_NOT_AVAILABLE);
      uint32_t epoch;
      MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(folderId,
                                                                       epoch));
      folderEpoch = Some(epoch);
    }
  } else {
    folderEpoch.reset();
  }
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "StoreOfflineOperation"_ns,
        "INSERT INTO offline_operations(id, folderId, messageKey, revision, "
        "epoch, uid, folderEpoch, sourcePhysicalKey, "
        "operation, flagOperation, newFlags, sourceKey, sourceUid, "
        "messageSize, "
        "playingBack, sourceFolderURI, destinationFolderURI, keywordsToAdd, "
        "keywordsToRemove, destinationFolderId, destinationKey, "
        "destinationEpoch) "
        "VALUES(:retainedId, :folder, :key, :revision, :epoch, :uid, "
        ":folderEpoch, "
        ":sourcePhysicalKey, "
        ":operation, :flags, "
        ":newFlags, "
        ":sourceKey, :sourceUid, :size, :playing, :sourceURI, "
        ":destinationURI, :add, :remove, :destinationFolder, "
        ":destinationKey, :destinationEpoch) "
        "ON CONFLICT(folderId, messageKey) DO UPDATE SET revision = "
        "excluded.revision, "
        "epoch = excluded.epoch, uid = excluded.uid, folderEpoch = "
        "excluded.folderEpoch, sourcePhysicalKey = excluded.sourcePhysicalKey, "
        "operation = "
        "excluded.operation, "
        "flagOperation = excluded.flagOperation, newFlags = "
        "excluded.newFlags, "
        "sourceKey = excluded.sourceKey, sourceUid = excluded.sourceUid, "
        "messageSize = excluded.messageSize, playingBack = "
        "excluded.playingBack, "
        "sourceFolderURI = excluded.sourceFolderURI, destinationFolderURI = "
        "excluded.destinationFolderURI, "
        "keywordsToAdd = excluded.keywordsToAdd, keywordsToRemove = "
        "excluded.keywordsToRemove, destinationFolderId = "
        "excluded.destinationFolderId, "
        "destinationKey = excluded.destinationKey, destinationEpoch = "
        "excluded.destinationEpoch "
        "RETURNING id"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scoper(stmt);
    if (restoreEmptyCanceledMove) {
      MOZ_TRY(stmt->BindInt64ByName("retainedId"_ns, id));
    } else {
      MOZ_TRY(stmt->BindNullByName("retainedId"_ns));
    }
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
    MOZ_TRY(stmt->BindInt64ByName("key"_ns, key));
    MOZ_TRY(stmt->BindInt64ByName("revision"_ns, revision + 1));
    if (source) {
      MOZ_TRY(stmt->BindInt64ByName("epoch"_ns, source->epoch));
      MOZ_TRY(stmt->BindInt64ByName("uid"_ns, source->uid));
      MOZ_TRY(stmt->BindInt64ByName("sourcePhysicalKey"_ns, source->key));
    } else {
      MOZ_TRY(stmt->BindNullByName("epoch"_ns));
      MOZ_TRY(stmt->BindNullByName("uid"_ns));
      MOZ_TRY(stmt->BindNullByName("sourcePhysicalKey"_ns));
    }
    if (folderEpoch) {
      MOZ_TRY(stmt->BindInt64ByName("folderEpoch"_ns, *folderEpoch));
    } else {
      MOZ_TRY(stmt->BindNullByName("folderEpoch"_ns));
    }
    MOZ_TRY(BindOfflineDestination(stmt, input.pendingDestination));
    MOZ_TRY(stmt->BindInt64ByName("operation"_ns, input.operation));
    MOZ_TRY(stmt->BindInt64ByName("flags"_ns, input.flagOperation));
    MOZ_TRY(stmt->BindInt64ByName("newFlags"_ns, input.newFlags));
    MOZ_TRY(stmt->BindInt64ByName("sourceKey"_ns, input.sourceKey));
    MOZ_TRY(stmt->BindInt64ByName("sourceUid"_ns, input.sourceUid));
    MOZ_TRY(stmt->BindInt64ByName("size"_ns, input.messageSize));
    MOZ_TRY(stmt->BindInt32ByName("playing"_ns, input.playingBack));
    MOZ_TRY(stmt->BindUTF8StringByName("sourceURI"_ns, input.sourceFolderURI));
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
  MOZ_TRY(WriteOfflineReplayPayload(DatabaseCore::sConnection, id, replayFlags,
                                    replayGuard));
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
      "INSERT INTO offline_copy_destinations(operationId, ordinal, uri, "
      "destinationFolderId, destinationKey, destinationEpoch) "
      "VALUES(:id, :ordinal, :uri, :destinationFolder, :destinationKey, :destinationEpoch)"_ns,
      getter_AddRefs(copy)));
  for (size_t i = 0; i < input.copyDestinations.Length(); ++i) {
    mozStorageStatementScoper scoper(copy);
    MOZ_TRY(copy->BindInt64ByName("id"_ns, id));
    MOZ_TRY(copy->BindInt64ByName("ordinal"_ns, i));
    MOZ_TRY(copy->BindUTF8StringByName("uri"_ns, input.copyDestinations[i]));
    Maybe<PendingDestination> destination;
    if (!input.copyDestinationBindings.IsEmpty()) {
      destination = input.copyDestinationBindings[i];
    }
    MOZ_TRY(BindOfflineDestination(copy, destination));
    MOZ_TRY(copy->Execute());
  }
  return NS_OK;
}

nsresult MessageDatabase::SetOfflineOperationPlayingBack(uint64_t folderId,
                                                         nsMsgKey key,
                                                         bool playingBack) {
  MOZ_TRY(RequireCurrentOwner());
  if (playingBack) {
    int64_t id, revision;
    Maybe<ServerMessageLocation> source;
    MOZ_TRY(ReadOfflineOperationIdentity(folderId, key, id, revision, source));
    MOZ_TRY(RequireOfflineImportDispatchable(id));
  }
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
  MOZ_TRY(RequireCurrentOwner());
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
      "((operation & :flagsChanged) != 0 AND ((flagSetMask IS NULL AND (newFlags & :deleted) != 0) OR (flagSetMask & :deleted) != 0))) ORDER BY messageKey"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
  MOZ_TRY(stmt->BindInt32ByName("deletesOnly"_ns, deletesOnly));
  MOZ_TRY(stmt->BindInt64ByName("moved"_ns, OfflineOp::kMsgMoved));
  MOZ_TRY(stmt->BindInt64ByName("flagsChanged"_ns, OfflineOp::kFlagsChanged));
  MOZ_TRY(stmt->BindInt64ByName("deleted"_ns, kImapMsgDeletedFlag));
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
    const Maybe<PendingDestination>& destination, uint64_t& attemptId,
    const MessageBodyState* appendBody) {
  return BeginOfflineAttemptInternal(folderId, key, operation, destination,
                                     attemptId, appendBody, nullptr);
}

nsresult MessageDatabase::BeginOfflineAction(
    uint64_t folderId, nsMsgKey key, uint32_t action,
    const Maybe<PendingDestination>& destination,
    const Maybe<uint32_t>& copyOrdinal, uint64_t& attemptId) {
  NS_ENSURE_TRUE((action == OfflineOp::kMsgCopy) == copyOrdinal.isSome() &&
                     action != OfflineOp::kAppendDraft &&
                     action != OfflineOp::kAppendTemplate,
                 NS_ERROR_INVALID_ARG);
  return BeginOfflineAttemptInternal(folderId, key, action, destination,
                                     attemptId, nullptr, &copyOrdinal);
}

nsresult MessageDatabase::BeginOfflineAttemptInternal(
    uint64_t folderId, nsMsgKey key, uint32_t operation,
    const Maybe<PendingDestination>& destination, uint64_t& attemptId,
    const MessageBodyState* appendBody, const Maybe<uint32_t>* copyOrdinal) {
  NS_ENSURE_TRUE(DatabaseCore::sInstance, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(RequireCurrentOwner());
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
    MOZ_TRY(RequireOfflineImportDispatchable(id));
    if (copyOrdinal) {
      MOZ_TRY(RequireOfflineActionDispatchable(id, revision, operation,
                                               *copyOrdinal));
    } else {
      MOZ_TRY(RequireOfflineOperationMutable(id));
    }
    OfflineOperationData payload;
    MOZ_TRY(GetOfflineOperation(folderId, key, payload));
    NS_ENSURE_TRUE(
        operation && !(operation & (operation - 1)) &&
            operation <= OfflineOp::kRemoveKeywords &&
            !(operation & (OfflineOp::kMoveResult | OfflineOp::kAddedHeader)) &&
            (payload.operation & operation),
        NS_ERROR_INVALID_ARG);
    if (operation == OfflineOp::kFlagsChanged) {
      NS_ENSURE_TRUE(copyOrdinal && payload.flagMutation &&
                         (payload.flagMutation->setMask ||
                          payload.flagMutation->clearMask),
                     NS_ERROR_NOT_AVAILABLE);
    }
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
    Maybe<PendingDestination> saved;
    if (operation == OfflineOp::kMsgCopy) {
      if (!payload.copyDestinationBindings.IsEmpty()) {
        uint32_t ordinal = copyOrdinal ? **copyOrdinal : 0;
        NS_ENSURE_TRUE(ordinal < payload.copyDestinationBindings.Length(),
                       NS_ERROR_NOT_AVAILABLE);
        saved = payload.copyDestinationBindings[ordinal];
        if (!saved && !copyOrdinal) {
          // A later binding cannot stand in for the unresolved first copy.
          for (const auto& binding : payload.copyDestinationBindings) {
            NS_ENSURE_FALSE(binding, NS_ERROR_NOT_AVAILABLE);
          }
        }
      }
    } else if (operation & (OfflineOp::kMsgMoved | OfflineOp::kAppendDraft |
                            OfflineOp::kAppendTemplate)) {
      saved = payload.pendingDestination;
    }
    if (copyOrdinal && (operation == OfflineOp::kMsgCopy ||
                        operation == OfflineOp::kMsgMoved)) {
      NS_ENSURE_TRUE(saved, NS_ERROR_NOT_AVAILABLE);
    }
    if (saved) {
      NS_ENSURE_TRUE(
          destination && SamePendingDestination(*saved, *destination),
          NS_ERROR_NOT_AVAILABLE);
    }
    if (destination) {
      bool selfAppend = (operation & (OfflineOp::kAppendDraft |
                                      OfflineOp::kAppendTemplate)) &&
                        destination->key == key;
      MOZ_TRY(ValidatePendingDestination(*destination, folderId, key,
                                         selfAppend, id));
    }
    if (appendBody) {
      NS_ENSURE_TRUE((operation == OfflineOp::kAppendDraft ||
                      operation == OfflineOp::kAppendTemplate) &&
                         destination && destination->folderId == folderId &&
                         destination->key == key &&
                         appendBody->folderId == folderId &&
                         appendBody->key == key && appendBody->storeToken &&
                         (appendBody->flags & nsMsgMessageFlags::Offline),
                     NS_ERROR_INVALID_ARG);
      MessageBodyState actual;
      MOZ_TRY(ReadMessageBodyState(key, actual));
      NS_ENSURE_TRUE(SameBodyGuard(actual, *appendBody),
                     NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(CheckPendingMessageRelocation(key));
    }
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "BeginOfflineAttempt"_ns,
          "INSERT INTO offline_attempts(operationId, revision, state, "
          "sourceFolderId, sourceKey, sourceEpoch, sourceUid, "
          "destinationFolderId, destinationKey, destinationEpoch, "
          "operationFolderId, operationEpoch, operation, appendSourceId, "
          "appendContentRevision, appendLocationRevision, appendStoreToken, "
          "appendMessageSize, appendOfflineSize, appendLineCount, appendFlags) "
          "VALUES(:operation, :revision, 1, :sourceFolder, :sourceKey, "
          ":sourceEpoch, "
          ":sourceUid, :destinationFolder, :destinationKey, :destinationEpoch, "
          ":folder, :folderEpoch, :action, "
          ":appendSource, :appendContent, :appendLocation, :appendToken, "
          ":appendSize, :appendOfflineSize, :appendLines, :appendFlags) RETURNING id"_ns,
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
        if (destination->epochKnown) {
          MOZ_TRY(
              stmt->BindInt64ByName("destinationEpoch"_ns, destination->epoch));
        } else {
          MOZ_TRY(stmt->BindNullByName("destinationEpoch"_ns));
        }
      } else {
        for (const char* name :
             {"destinationFolder", "destinationKey", "destinationEpoch"}) {
          MOZ_TRY(stmt->BindNullByName(nsDependentCString(name)));
        }
      }
      if (appendBody) {
        MOZ_TRY(stmt->BindUTF8StringByName("appendSource"_ns,
                                           appendBody->databaseSourceId));
        MOZ_TRY(stmt->BindInt64ByName("appendContent"_ns,
                                      appendBody->contentRevision));
        MOZ_TRY(stmt->BindInt64ByName("appendLocation"_ns,
                                      appendBody->locationRevision));
        MOZ_TRY(stmt->BindUTF8StringByName("appendToken"_ns,
                                           *appendBody->storeToken));
        MOZ_TRY(
            stmt->BindInt64ByName("appendSize"_ns, appendBody->messageSize));
        MOZ_TRY(stmt->BindInt64ByName("appendOfflineSize"_ns,
                                      appendBody->offlineMessageSize));
        MOZ_TRY(stmt->BindInt64ByName("appendLines"_ns, appendBody->lineCount));
        MOZ_TRY(stmt->BindInt64ByName("appendFlags"_ns, appendBody->flags));
      } else {
        for (const char* name :
             {"appendSource", "appendContent", "appendLocation", "appendToken",
              "appendSize", "appendOfflineSize", "appendLines",
              "appendFlags"}) {
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
    if (copyOrdinal) {
      nsCString sourceId;
      MOZ_TRY(
          DatabaseCore::sInstance->ReadSourceIdForFolderAdmission(sourceId));
      Maybe<MessageBodyState> transfer;
      if (operation == OfflineOp::kMsgCopy ||
          operation == OfflineOp::kMsgMoved) {
        MessageBodyState body;
        MOZ_TRY(ReadMessageBodyState(destination->key, body));
        NS_ENSURE_TRUE(body.folderId == destination->folderId &&
                           body.databaseSourceId == sourceId,
                       NS_ERROR_NOT_AVAILABLE);
        transfer = Some(std::move(body));
      }
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "SnapshotOfflineAction"_ns,
          "UPDATE offline_attempts SET transferSourceId=:source, "
          "transferOperationKey=:key, copyOrdinal=:ordinal, "
          "transferContentRevision=:content, "
          "transferLocationRevision=:location, "
          "transferStoreToken=:token, transferMessageSize=:size, "
          "transferOfflineSize=:offlineSize, transferLineCount=:lines, "
          "transferFlags=:flags WHERE id=:id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, created));
      MOZ_TRY(stmt->BindUTF8StringByName("source"_ns, sourceId));
      MOZ_TRY(stmt->BindInt64ByName("key"_ns, key));
      if (*copyOrdinal) {
        MOZ_TRY(stmt->BindInt64ByName("ordinal"_ns, **copyOrdinal));
      } else {
        MOZ_TRY(stmt->BindNullByName("ordinal"_ns));
      }
      if (transfer) {
        MOZ_TRY(stmt->BindInt64ByName("content"_ns, transfer->contentRevision));
        MOZ_TRY(
            stmt->BindInt64ByName("location"_ns, transfer->locationRevision));
        if (transfer->storeToken) {
          MOZ_TRY(
              stmt->BindUTF8StringByName("token"_ns, *transfer->storeToken));
        } else {
          MOZ_TRY(stmt->BindNullByName("token"_ns));
        }
        MOZ_TRY(stmt->BindInt64ByName("size"_ns, transfer->messageSize));
        MOZ_TRY(stmt->BindInt64ByName("offlineSize"_ns,
                                      transfer->offlineMessageSize));
        MOZ_TRY(stmt->BindInt64ByName("lines"_ns, transfer->lineCount));
        MOZ_TRY(stmt->BindInt64ByName("flags"_ns, transfer->flags));
      } else {
        for (const char* name : {"content", "location", "token", "size",
                                 "offlineSize", "lines", "flags"}) {
          MOZ_TRY(stmt->BindNullByName(nsDependentCString(name)));
        }
      }
      MOZ_TRY(stmt->Execute());
    }
    if (copyOrdinal) {
      OfflineAttempt replay;
      replay.id = created;
      replay.replayVersion = 1;
      if (operation == OfflineOp::kFlagsChanged) {
        replay.flagMutation = payload.flagMutation;
        if (replay.flagMutation->setMask)
          replay.flagSet = Some(OfflineReplayCommandProgress{});
        if (replay.flagMutation->clearMask)
          replay.flagClear = Some(OfflineReplayCommandProgress{});
      }
      if (operation == OfflineOp::kMsgMoved)
        replay.moveSourceGuard = payload.moveSourceGuard;
      MOZ_TRY(WriteReplayAttempt(DatabaseCore::sConnection, replay));
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
      "operationFolderId, operationEpoch, operation, appendAccepted, "
      "appendSourceId, "
      "appendContentRevision, appendLocationRevision, appendStoreToken, "
      "appendMessageSize, appendOfflineSize, appendLineCount, appendFlags, "
      "transferSourceId, transferOperationKey, copyOrdinal, transferAccepted, "
      "transferContentRevision, transferLocationRevision, transferStoreToken, "
      "transferMessageSize, transferOfflineSize, transferLineCount, "
      "transferFlags, "
      "confirmedEpoch, flagSetMask, flagClearMask, guardSourceId, guardFolderId, guardKey, guardContentRevision, guardLocationRevision, guardStoreToken, guardMessageSize, guardOfflineSize, guardLineCount, guardFlags, guardPresence, replayVersion, moveExpunge, flagSetState, flagSetGeneration, flagSetError, flagClearState, flagClearGeneration, flagClearError, sourceStoreState, sourceStoreGeneration, sourceStoreError, sourceExpungeState, sourceExpungeGeneration, sourceExpungeError, moveSettled, firstError, settledSourceRemoved, settledOperationRetired FROM offline_attempts WHERE id = :id"_ns,
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
  MOZ_TRY(RequireOfflineImportDispatchable(id));
  found.operationId = id;
  found.revision = revision;
  found.state = static_cast<OfflineAttemptState>(state);
  bool sourceNull;
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
  MOZ_TRY(ReadOfflineDestination(stmt, 7, found.destination));
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
  uint32_t accepted;
  MOZ_TRY(OfflineUint32(stmt, 14, accepted));
  NS_ENSURE_TRUE(accepted <= 1, NS_ERROR_FILE_CORRUPTED);
  found.appendAccepted = accepted;
  bool bodyAbsent;
  MOZ_TRY(stmt->GetIsNull(15, &bodyAbsent));
  if (bodyAbsent) {
    for (uint32_t column = 16; column <= 22; ++column) {
      bool absent;
      MOZ_TRY(stmt->GetIsNull(column, &absent));
      NS_ENSURE_TRUE(absent, NS_ERROR_FILE_CORRUPTED);
    }
    NS_ENSURE_FALSE(found.appendAccepted, NS_ERROR_FILE_CORRUPTED);
  } else {
    NS_ENSURE_TRUE(found.destination &&
                       found.destination->folderId == found.folderId &&
                       (found.operation == OfflineOp::kAppendDraft ||
                        found.operation == OfflineOp::kAppendTemplate),
                   NS_ERROR_FILE_CORRUPTED);
    MessageBodyState body;
    body.key = found.destination->key;
    body.folderId = found.destination->folderId;
    int32_t type;
    MOZ_TRY(stmt->GetTypeOfIndex(15, &type));
    NS_ENSURE_TRUE(type == mozIStorageValueArray::VALUE_TYPE_TEXT,
                   NS_ERROR_FILE_CORRUPTED);
    MOZ_TRY(stmt->GetUTF8String(15, body.databaseSourceId));
    NS_ENSURE_TRUE(!body.databaseSourceId.IsEmpty(), NS_ERROR_FILE_CORRUPTED);
    for (uint32_t column : {16, 17}) {
      MOZ_TRY(stmt->GetTypeOfIndex(column, &type));
      int64_t value;
      MOZ_TRY(stmt->GetInt64(column, &value));
      NS_ENSURE_TRUE(
          type == mozIStorageValueArray::VALUE_TYPE_INTEGER && value > 0,
          NS_ERROR_FILE_CORRUPTED);
      (column == 16 ? body.contentRevision : body.locationRevision) = value;
    }
    bool tokenAbsent;
    MOZ_TRY(stmt->GetIsNull(18, &tokenAbsent));
    if (!tokenAbsent) {
      MOZ_TRY(stmt->GetTypeOfIndex(18, &type));
      NS_ENSURE_TRUE(type == mozIStorageValueArray::VALUE_TYPE_TEXT,
                     NS_ERROR_FILE_CORRUPTED);
      nsCString token;
      MOZ_TRY(stmt->GetUTF8String(18, token));
      body.storeToken = Some(std::move(token));
    }
    MOZ_TRY(OfflineUint32(stmt, 19, body.messageSize));
    MOZ_TRY(OfflineUint32(stmt, 20, body.offlineMessageSize));
    MOZ_TRY(OfflineUint32(stmt, 21, body.lineCount));
    MOZ_TRY(OfflineUint32(stmt, 22, body.flags));
    NS_ENSURE_TRUE((body.flags & nsMsgMessageFlags::Offline) &&
                       (found.state == OfflineAttemptState::Confirmed
                            ? found.confirmedUid.isSome()
                            : found.confirmedUid.isNothing()) &&
                       (!found.appendAccepted ||
                        found.state == OfflineAttemptState::Sent ||
                        found.state == OfflineAttemptState::Confirmed),
                   NS_ERROR_FILE_CORRUPTED);
    found.appendBody = Some(std::move(body));
  }
  bool transferAbsent;
  MOZ_TRY(stmt->GetIsNull(23, &transferAbsent));
  MOZ_TRY(OfflineUint32(stmt, 26, accepted));
  NS_ENSURE_TRUE(accepted <= 1, NS_ERROR_FILE_CORRUPTED);
  found.transferAccepted = accepted;
  if (transferAbsent) {
    for (uint32_t column : {24, 25, 27, 28, 29, 30, 31, 32, 33}) {
      bool absent;
      MOZ_TRY(stmt->GetIsNull(column, &absent));
      NS_ENSURE_TRUE(absent, NS_ERROR_FILE_CORRUPTED);
    }
    NS_ENSURE_FALSE(found.transferAccepted, NS_ERROR_FILE_CORRUPTED);
  } else {
    int32_t type;
    MOZ_TRY(stmt->GetTypeOfIndex(23, &type));
    NS_ENSURE_TRUE(type == mozIStorageValueArray::VALUE_TYPE_TEXT,
                   NS_ERROR_FILE_CORRUPTED);
    MOZ_TRY(stmt->GetUTF8String(23, found.transferSourceId));
    NS_ENSURE_TRUE(!found.transferSourceId.IsEmpty(), NS_ERROR_FILE_CORRUPTED);
    MOZ_TRY(OfflineUint32(stmt, 24, found.operationKey));
    NS_ENSURE_TRUE(found.operationKey && found.operationKey < nsMsgKey_None,
                   NS_ERROR_FILE_CORRUPTED);
    bool ordinalAbsent;
    MOZ_TRY(stmt->GetIsNull(25, &ordinalAbsent));
    if (!ordinalAbsent) {
      uint32_t ordinal;
      MOZ_TRY(OfflineUint32(stmt, 25, ordinal));
      found.copyOrdinal = Some(ordinal);
    }
    NS_ENSURE_TRUE(
        (found.operation == OfflineOp::kMsgCopy) == found.copyOrdinal.isSome(),
        NS_ERROR_FILE_CORRUPTED);
    if (found.operation == OfflineOp::kMsgCopy ||
        found.operation == OfflineOp::kMsgMoved) {
      NS_ENSURE_TRUE(found.destination && found.source && !found.appendBody,
                     NS_ERROR_FILE_CORRUPTED);
      MessageBodyState body;
      body.databaseSourceId = found.transferSourceId;
      body.folderId = found.destination->folderId;
      body.key = found.destination->key;
      for (uint32_t column : {27, 28}) {
        MOZ_TRY(stmt->GetTypeOfIndex(column, &type));
        int64_t value;
        MOZ_TRY(stmt->GetInt64(column, &value));
        NS_ENSURE_TRUE(
            type == mozIStorageValueArray::VALUE_TYPE_INTEGER && value > 0,
            NS_ERROR_FILE_CORRUPTED);
        (column == 27 ? body.contentRevision : body.locationRevision) = value;
      }
      bool tokenAbsent;
      MOZ_TRY(stmt->GetIsNull(29, &tokenAbsent));
      if (!tokenAbsent) {
        MOZ_TRY(stmt->GetTypeOfIndex(29, &type));
        NS_ENSURE_TRUE(type == mozIStorageValueArray::VALUE_TYPE_TEXT,
                       NS_ERROR_FILE_CORRUPTED);
        nsCString token;
        MOZ_TRY(stmt->GetUTF8String(29, token));
        body.storeToken = Some(std::move(token));
      }
      MOZ_TRY(OfflineUint32(stmt, 30, body.messageSize));
      MOZ_TRY(OfflineUint32(stmt, 31, body.offlineMessageSize));
      MOZ_TRY(OfflineUint32(stmt, 32, body.lineCount));
      MOZ_TRY(OfflineUint32(stmt, 33, body.flags));
      found.transferBody = Some(std::move(body));
      NS_ENSURE_TRUE((found.state == OfflineAttemptState::Confirmed) ==
                         found.confirmedUid.isSome(),
                     NS_ERROR_FILE_CORRUPTED);
      NS_ENSURE_TRUE(!found.transferAccepted ||
                         found.state == OfflineAttemptState::Sent ||
                         found.state == OfflineAttemptState::Confirmed,
                     NS_ERROR_FILE_CORRUPTED);
    } else {
      NS_ENSURE_FALSE(found.transferAccepted, NS_ERROR_FILE_CORRUPTED);
      for (uint32_t column = 27; column <= 33; ++column) {
        bool absent;
        MOZ_TRY(stmt->GetIsNull(column, &absent));
        NS_ENSURE_TRUE(absent, NS_ERROR_FILE_CORRUPTED);
      }
    }
  }
  bool confirmationAbsent;
  MOZ_TRY(stmt->GetIsNull(34, &confirmationAbsent));
  if (!confirmationAbsent) {
    uint32_t epoch;
    MOZ_TRY(OfflineUint32(stmt, 34, epoch));
    NS_ENSURE_TRUE(found.confirmedUid && found.destination,
                   NS_ERROR_FILE_CORRUPTED);
    found.confirmedEpoch = Some(epoch);
  } else if (found.confirmedUid && found.destination &&
             found.destination->epochKnown) {
    // Existing schema-17 confirmations retain their original known epoch.
    found.confirmedEpoch = Some(found.destination->epoch);
  }
  MOZ_TRY(
      ReadReplayPayload(stmt, 35, found.flagMutation, found.moveSourceGuard));
  MOZ_TRY(OfflineUint32(stmt, 48, found.replayVersion));
  NS_ENSURE_TRUE(found.replayVersion <= 1, NS_ERROR_FILE_CORRUPTED);
  bool planAbsent;
  MOZ_TRY(stmt->GetIsNull(49, &planAbsent));
  if (!planAbsent) {
    uint32_t value;
    MOZ_TRY(OfflineUint32(stmt, 49, value));
    NS_ENSURE_TRUE(value <= 2, NS_ERROR_FILE_CORRUPTED);
    found.moveSourcePlan =
        Some(OfflineMoveSourcePlan{static_cast<OfflineMoveExpunge>(value)});
  }
  MOZ_TRY(ReadReplayProgress(stmt, 50, found.flagSet));
  MOZ_TRY(ReadReplayProgress(stmt, 53, found.flagClear));
  MOZ_TRY(ReadReplayProgress(stmt, 56, found.sourceStore));
  MOZ_TRY(ReadReplayProgress(stmt, 59, found.sourceExpunge));
  uint32_t settled;
  MOZ_TRY(OfflineUint32(stmt, 62, settled));
  NS_ENSURE_TRUE(settled <= 1, NS_ERROR_FILE_CORRUPTED);
  found.moveSettled = settled;
  MOZ_TRY(ReadReplayError(stmt, 63, found.firstError));
  for (uint32_t column : {64, 65}) {
    bool absent;
    MOZ_TRY(stmt->GetIsNull(column, &absent));
    NS_ENSURE_TRUE(absent == !found.moveSettled, NS_ERROR_FILE_CORRUPTED);
    if (!absent) {
      uint32_t value;
      MOZ_TRY(OfflineUint32(stmt, column, value));
      NS_ENSURE_TRUE(value <= 1, NS_ERROR_FILE_CORRUPTED);
    }
  }

  if (!found.replayVersion) {
    NS_ENSURE_TRUE(!found.flagMutation && !found.moveSourceGuard &&
                       !found.moveSourcePlan && !found.flagSet &&
                       !found.flagClear && !found.sourceStore &&
                       !found.sourceExpunge && !found.moveSettled &&
                       !found.firstError,
                   NS_ERROR_FILE_CORRUPTED);
  } else {
    NS_ENSURE_TRUE(!found.transferSourceId.IsEmpty(), NS_ERROR_FILE_CORRUPTED);
    if (found.operation == OfflineOp::kFlagsChanged) {
      NS_ENSURE_TRUE(
          found.flagMutation &&
              found.flagSet.isSome() == bool(found.flagMutation->setMask) &&
              found.flagClear.isSome() == bool(found.flagMutation->clearMask),
          NS_ERROR_FILE_CORRUPTED);
    } else {
      NS_ENSURE_TRUE(!found.flagMutation && !found.flagSet && !found.flagClear,
                     NS_ERROR_FILE_CORRUPTED);
    }
    NS_ENSURE_TRUE(
        !found.moveSourceGuard || found.operation == OfflineOp::kMsgMoved,
        NS_ERROR_FILE_CORRUPTED);
    NS_ENSURE_TRUE(found.moveSourcePlan.isSome() == found.sourceStore.isSome(),
                   NS_ERROR_FILE_CORRUPTED);
    NS_ENSURE_TRUE(found.sourceExpunge.isSome() ==
                       (found.moveSourcePlan && found.moveSourcePlan->expunge !=
                                                    OfflineMoveExpunge::None),
                   NS_ERROR_FILE_CORRUPTED);
    if (found.moveSourcePlan) {
      NS_ENSURE_TRUE(found.operation == OfflineOp::kMsgMoved &&
                         found.moveSourceGuard &&
                         found.state == OfflineAttemptState::Confirmed &&
                         found.confirmedUid && found.confirmedEpoch &&
                         found.transferBody && !found.copyOrdinal,
                     NS_ERROR_FILE_CORRUPTED);
      NS_ENSURE_TRUE(!found.sourceExpunge || !found.sourceExpunge->generation ||
                         ReplayAcknowledged(found.sourceStore),
                     NS_ERROR_FILE_CORRUPTED);
    }
    NS_ENSURE_TRUE(
        !found.moveSettled ||
            (ReplayAcknowledged(found.sourceStore) &&
             (!found.sourceExpunge || ReplayAcknowledged(found.sourceExpunge))),
        NS_ERROR_FILE_CORRUPTED);
  }
  output = std::move(found);
  return NS_OK;
}

nsresult MessageDatabase::RequireOfflineActionDispatchable(
    int64_t id, int64_t revision, uint32_t action,
    const Maybe<uint32_t>& copyOrdinal) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "OfflineActionInFlight"_ns,
      "SELECT 1 FROM offline_attempts WHERE operationId=:id AND "
      "state IN (1,2,3) AND (transferSourceId IS NULL OR "
      "(revision=:revision AND operation=:action AND copyOrdinal IS :ordinal)) "
      "LIMIT 1"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, id));
  MOZ_TRY(stmt->BindInt64ByName("revision"_ns, revision));
  MOZ_TRY(stmt->BindInt64ByName("action"_ns, action));
  if (copyOrdinal) {
    MOZ_TRY(stmt->BindInt64ByName("ordinal"_ns, *copyOrdinal));
  } else {
    MOZ_TRY(stmt->BindNullByName("ordinal"_ns));
  }
  bool blocked;
  MOZ_TRY(stmt->ExecuteStep(&blocked));
  return blocked ? NS_ERROR_IN_PROGRESS : NS_OK;
}

nsresult MessageDatabase::GetOfflineAttemptForAction(
    uint64_t folderId, nsMsgKey key, uint32_t action,
    const Maybe<uint32_t>& copyOrdinal, OfflineAttempt& output) {
  NS_ENSURE_TRUE((action == OfflineOp::kMsgCopy) == copyOrdinal.isSome(),
                 NS_ERROR_INVALID_ARG);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "CurrentOfflineAction"_ns,
      "SELECT a.id FROM offline_attempts a JOIN offline_operations o "
      "ON o.id=a.operationId AND o.revision=a.revision "
      "WHERE o.folderId=:folder AND o.messageKey=:key AND "
      "a.transferSourceId IS NOT NULL AND a.operation=:action AND "
      "a.copyOrdinal IS :ordinal ORDER BY a.id DESC LIMIT 1"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
  MOZ_TRY(stmt->BindInt64ByName("key"_ns, key));
  MOZ_TRY(stmt->BindInt64ByName("action"_ns, action));
  if (copyOrdinal) {
    MOZ_TRY(stmt->BindInt64ByName("ordinal"_ns, *copyOrdinal));
  } else {
    MOZ_TRY(stmt->BindNullByName("ordinal"_ns));
  }
  bool found;
  MOZ_TRY(stmt->ExecuteStep(&found));
  NS_ENSURE_TRUE(found, NS_ERROR_NOT_AVAILABLE);
  int64_t id;
  MOZ_TRY(stmt->GetInt64(0, &id));
  NS_ENSURE_TRUE(id > 0, NS_ERROR_FILE_CORRUPTED);
  return GetOfflineAttempt(id, output);
}

nsresult MessageDatabase::ReadExpectedTransferAttempt(
    const OfflineAttempt& expected, OfflineAttempt& actual) {
  NS_ENSURE_TRUE(expected.id && expected.transferBody && expected.destination &&
                     expected.source && !expected.transferSourceId.IsEmpty() &&
                     (expected.operation == OfflineOp::kMsgCopy ||
                      expected.operation == OfflineOp::kMsgMoved),
                 NS_ERROR_INVALID_ARG);
  MOZ_TRY(GetOfflineAttempt(expected.id, actual));
  NS_ENSURE_TRUE(
      actual.transferBody && actual.destination &&
          actual.transferSourceId == expected.transferSourceId &&
          actual.operationKey == expected.operationKey &&
          actual.folderId == expected.folderId &&
          actual.operationId == expected.operationId &&
          actual.revision == expected.revision &&
          actual.operation == expected.operation &&
          actual.copyOrdinal == expected.copyOrdinal &&
          SameOfflineSource(actual.source, expected.source) &&
          SamePendingDestination(*actual.destination, *expected.destination) &&
          SameBodyGuard(*actual.transferBody, *expected.transferBody),
      NS_ERROR_NOT_AVAILABLE);
  nsCString sourceId;
  MOZ_TRY(DatabaseCore::sInstance->ReadSourceIdForFolderAdmission(sourceId));
  NS_ENSURE_TRUE(sourceId == actual.transferSourceId, NS_ERROR_NOT_AVAILABLE);
  return NS_OK;
}

nsresult MessageDatabase::ValidateTransferTargetInTransaction(
    const OfflineAttempt& attempt) {
  QueuedSourceIdentity identity{attempt.transferSourceId, attempt.folderId,
                                attempt.operationKey,     attempt.operationId,
                                attempt.revision,         attempt.source};
  MOZ_TRY(ValidateQueuedSourceIdentity(identity));
  OfflineOperationData payload;
  MOZ_TRY(GetOfflineOperation(attempt.folderId, attempt.operationKey, payload));
  NS_ENSURE_TRUE(payload.operation & attempt.operation, NS_ERROR_NOT_AVAILABLE);
  Maybe<PendingDestination> saved;
  if (attempt.copyOrdinal) {
    NS_ENSURE_TRUE(
        *attempt.copyOrdinal < payload.copyDestinationBindings.Length(),
        NS_ERROR_NOT_AVAILABLE);
    saved = payload.copyDestinationBindings[*attempt.copyOrdinal];
  } else {
    saved = payload.pendingDestination;
  }
  const auto& target = *attempt.destination;
  NS_ENSURE_TRUE(saved && saved->folderId == target.folderId &&
                     saved->key == target.key &&
                     (!target.epochKnown ||
                      (saved->epochKnown && saved->epoch == target.epoch)),
                 NS_ERROR_NOT_AVAILABLE);
  uint32_t epoch;
  MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(
      attempt.source->folderId, epoch));
  NS_ENSURE_TRUE(epoch == attempt.source->epoch, NS_ERROR_NOT_AVAILABLE);
  nsresult rv = DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(
      target.folderId, epoch);
  if (saved->epochKnown) {
    MOZ_TRY(rv);
    NS_ENSURE_TRUE(epoch == saved->epoch, NS_ERROR_NOT_AVAILABLE);
  } else {
    NS_ENSURE_TRUE(rv == NS_ERROR_NOT_AVAILABLE,
                   NS_FAILED(rv) ? rv : NS_ERROR_NOT_AVAILABLE);
  }
  MessageBodyState current;
  MOZ_TRY(ReadMessageBodyState(target.key, current));
  NS_ENSURE_TRUE(SameBodyGuard(current, *attempt.transferBody),
                 NS_ERROR_NOT_AVAILABLE);
  return NS_OK;
}

nsresult MessageDatabase::RecordOfflineCopyAcceptedWithoutUid(
    const OfflineAttempt& expected) {
  MOZ_TRY(RequireCommittedSearchRead());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    OfflineAttempt actual;
    MOZ_TRY(ReadExpectedTransferAttempt(expected, actual));
    if (actual.transferAccepted) {
      return connection->CommitTransaction();
    }
    NS_ENSURE_TRUE((actual.state == OfflineAttemptState::Sent ||
                    actual.state == OfflineAttemptState::Ambiguous) &&
                       !actual.confirmedUid,
                   NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "AcceptOfflineCopyWithoutUid"_ns,
        "UPDATE offline_attempts SET transferAccepted=1,state=1 WHERE id=:id"_ns,
        getter_AddRefs(stmt)));
    {
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, actual.id));
      MOZ_TRY(stmt->Execute());
    }
    return connection->CommitTransaction();
  }();
  return FinishOfflineWrite(connection, rv);
}

nsresult MessageDatabase::ValidateOfflineCopyAcceptedWithoutUid(
    const OfflineAttempt& expected) {
  MOZ_TRY(RequireCommittedSearchRead());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    OfflineAttempt actual;
    MOZ_TRY(ReadExpectedTransferAttempt(expected, actual));
    NS_ENSURE_TRUE(actual.transferAccepted && !actual.confirmedUid &&
                       actual.state == OfflineAttemptState::Sent,
                   NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(ValidateTransferTargetInTransaction(actual));
    return connection->CommitTransaction();
  }();
  return FinishOfflineWrite(connection, rv);
}

// Compare immutable native Begin input, not a caller's later mutable state.
nsresult MessageDatabase::ReadExpectedAppendAttempt(
    const OfflineAttempt& expected, OfflineAttempt& actual) {
  NS_ENSURE_TRUE(expected.id && expected.id <= INT64_MAX &&
                     expected.appendBody && expected.destination &&
                     expected.operationId && expected.revision &&
                     (expected.operation == OfflineOp::kAppendDraft ||
                      expected.operation == OfflineOp::kAppendTemplate),
                 NS_ERROR_INVALID_ARG);
  MOZ_TRY(GetOfflineAttempt(expected.id, actual));
  NS_ENSURE_TRUE(
      actual.appendBody && actual.destination &&
          actual.operationId == expected.operationId &&
          actual.revision == expected.revision &&
          actual.folderId == expected.folderId &&
          actual.operation == expected.operation &&
          actual.folderEpoch == expected.folderEpoch &&
          SamePendingDestination(*actual.destination, *expected.destination) &&
          actual.source.isSome() == expected.source.isSome() &&
          SameBodyGuard(*actual.appendBody, *expected.appendBody),
      NS_ERROR_NOT_AVAILABLE);
  if (actual.source) {
    const auto& a = *actual.source;
    const auto& b = *expected.source;
    NS_ENSURE_TRUE(a.folderId == b.folderId && a.key == b.key &&
                       a.epoch == b.epoch && a.uid == b.uid,
                   NS_ERROR_NOT_AVAILABLE);
  }
  nsCString source;
  MOZ_TRY(DatabaseCore::sInstance->ReadSourceIdForFolderAdmission(source));
  NS_ENSURE_TRUE(source == actual.appendBody->databaseSourceId,
                 NS_ERROR_NOT_AVAILABLE);
  return NS_OK;
}

nsresult MessageDatabase::ValidateAppendTargetInTransaction(
    const OfflineAttempt& attempt) {
  const auto& body = *attempt.appendBody;
  nsCString sourceId;
  MOZ_TRY(DatabaseCore::sInstance->ReadSourceIdForFolderAdmission(sourceId));
  NS_ENSURE_TRUE(sourceId == body.databaseSourceId, NS_ERROR_NOT_AVAILABLE);
  int64_t id, revision;
  Maybe<ServerMessageLocation> source;
  MOZ_TRY(ReadOfflineOperationIdentity(body.folderId, body.key, id, revision,
                                       source));
  NS_ENSURE_TRUE(uint64_t(id) == attempt.operationId &&
                     uint64_t(revision) == attempt.revision,
                 NS_ERROR_NOT_AVAILABLE);
  OfflineOperationData payload;
  MOZ_TRY(GetOfflineOperation(body.folderId, body.key, payload));
  NS_ENSURE_TRUE(payload.operation & attempt.operation, NS_ERROR_NOT_AVAILABLE);
  uint32_t epoch;
  MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(
      body.folderId, epoch));
  NS_ENSURE_TRUE(epoch == attempt.destination->epoch, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(CheckPendingMessageRelocation(body.key));
  NS_ENSURE_TRUE(!payload.pendingDestination ||
                     SamePendingDestination(*payload.pendingDestination,
                                            *attempt.destination),
                 NS_ERROR_NOT_AVAILABLE);
  nsTArray<nsCString> names;
  MOZ_TRY(GetMessagePropertyNames(body.key, names));
  NS_ENSURE_FALSE(names.Contains("uidOnServer"_ns), NS_ERROR_NOT_AVAILABLE);
  MessageBodyState current;
  MOZ_TRY(ReadMessageBodyState(body.key, current));
  NS_ENSURE_TRUE(SameBodyGuard(current, body), NS_ERROR_NOT_AVAILABLE);
  return NS_OK;
}

nsresult MessageDatabase::RecordOfflineAppendAcceptedWithoutUid(
    const OfflineAttempt& expected) {
  MOZ_TRY(RequireCommittedSearchRead());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    OfflineAttempt actual;
    MOZ_TRY(ReadExpectedAppendAttempt(expected, actual));
    // A duplicate cannot undo a later actual UID confirmation.
    if (actual.appendAccepted) {
      return connection->CommitTransaction();
    }
    NS_ENSURE_TRUE((actual.state == OfflineAttemptState::Sent ||
                    actual.state == OfflineAttemptState::Ambiguous) &&
                       !actual.confirmedUid,
                   NS_ERROR_NOT_AVAILABLE);
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "AcceptOfflineAppendWithoutUid"_ns,
          "UPDATE offline_attempts SET appendAccepted = 1, state = 1 WHERE id = :id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, actual.id));
      MOZ_TRY(stmt->Execute());
    }
    return connection->CommitTransaction();
  }();
  return FinishOfflineWrite(connection, rv);
}

nsresult MessageDatabase::ValidateOfflineAppendAcceptedWithoutUid(
    const OfflineAttempt& expected) {
  MOZ_TRY(RequireCommittedSearchRead());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    OfflineAttempt actual;
    MOZ_TRY(ReadExpectedAppendAttempt(expected, actual));
    NS_ENSURE_TRUE(actual.appendAccepted &&
                       actual.state == OfflineAttemptState::Sent &&
                       !actual.confirmedUid,
                   NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(ValidateAppendTargetInTransaction(actual));
    return connection->CommitTransaction();
  }();
  return FinishOfflineWrite(connection, rv);
}

nsresult MessageDatabase::ReadRetainedAcceptedAppend(
    const OfflineAttempt& expected, bool& observed) {
  MOZ_TRY(RequireCommittedSearchRead());
  RefPtr<MessageDatabase> self(this);
  const OfflineAttempt selected(expected);
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  auto read = [&](bool& bound) -> nsresult {
    OfflineAttempt actual;
    MOZ_TRY(ReadExpectedAppendAttempt(selected, actual));
    Maybe<uint32_t> uid;
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "ReadRetainedAcceptedAppendUid"_ns,
          "SELECT value FROM message_properties WHERE id=:key AND "
          "name='uidOnServer'"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("key"_ns, actual.destination->key));
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      if (more) {
        int32_t type;
        MOZ_TRY(stmt->GetTypeOfIndex(0, &type));
        NS_ENSURE_TRUE(type == mozIStorageValueArray::VALUE_TYPE_TEXT,
                       NS_ERROR_FILE_CORRUPTED);
        nsCString text;
        MOZ_TRY(stmt->GetUTF8String(0, text));
        NS_ENSURE_TRUE(!text.IsEmpty() && text.Length() <= 8,
                       NS_ERROR_FILE_CORRUPTED);
        for (uint32_t i = 0; i < text.Length(); ++i) {
          char digit = text.CharAt(i);
          NS_ENSURE_TRUE(
              (digit >= '0' && digit <= '9') || (digit >= 'a' && digit <= 'f'),
              NS_ERROR_FILE_CORRUPTED);
        }
        uint32_t value =
            static_cast<uint32_t>(MsgUnhex(text.get(), text.Length()));
        nsAutoCString canonical;
        canonical.AppendInt(value, 16);
        NS_ENSURE_TRUE(text == canonical, NS_ERROR_FILE_CORRUPTED);
        NS_ENSURE_TRUE(value, NS_ERROR_NOT_AVAILABLE);
        uid = Some(value);
        MOZ_TRY(stmt->ExecuteStep(&more));
        NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
      }
    }
    MOZ_TRY(ReadAcceptedAppendObservationInTransaction(
        actual, actual.destination->epoch, uid, bound));
    NS_ENSURE_TRUE(bound == uid.isSome(), NS_ERROR_NOT_AVAILABLE);
    return NS_OK;
  };
  bool result = false;
  nsresult rv = [&]() -> nsresult {
    MOZ_TRY(read(result));
    // SQL functions can reenter; revalidate the same immutable input before
    // committing our read. No externally visible output precedes that commit.
    MOZ_TRY(RequireCurrentOwner());
    bool checked;
    MOZ_TRY(read(checked));
    NS_ENSURE_TRUE(checked == result, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(RequireCurrentOwner());
    return connection->CommitTransaction();
  }();
  MOZ_TRY(FinishOfflineWrite(connection, rv));
  observed = result;
  return NS_OK;
}

nsresult MessageDatabase::ReadAcceptedAppendObservationInTransaction(
    const OfflineAttempt& attempt, uint32_t epoch, const Maybe<uint32_t>& uid,
    bool& associated) {
  MOZ_TRY(RequireCurrentOwner());
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_TRUE(active, NS_ERROR_UNEXPECTED);
  NS_ENSURE_TRUE(attempt.appendAccepted &&
                     attempt.state == OfflineAttemptState::Sent &&
                     !attempt.confirmedUid && !attempt.confirmedEpoch &&
                     attempt.appendBody && attempt.destination,
                 NS_ERROR_NOT_AVAILABLE);
  const auto& body = *attempt.appendBody;
  const auto& target = *attempt.destination;
  NS_ENSURE_TRUE(target.epochKnown && epoch && (!uid || *uid) &&
                     target.epoch == epoch &&
                     body.folderId == target.folderId && body.key == target.key,
                 NS_ERROR_NOT_AVAILABLE);
  uint32_t currentEpoch;
  MOZ_TRY(DatabaseCore::sInstance->FolderDB().GetFolderUidValidity(
      target.folderId, currentEpoch));
  NS_ENSURE_TRUE(currentEpoch == epoch, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(CheckPendingMessageRelocation(body.key));
  OfflineAttempt currentAttempt;
  MOZ_TRY(GetCurrentOfflineAttempt(body.folderId, body.key, currentAttempt));
  NS_ENSURE_TRUE(currentAttempt.id == attempt.id, NS_ERROR_NOT_AVAILABLE);
  int64_t operation, revision;
  Maybe<ServerMessageLocation> source;
  MOZ_TRY(ReadOfflineOperationIdentity(body.folderId, body.key, operation,
                                       revision, source));
  NS_ENSURE_TRUE(uint64_t(operation) == attempt.operationId &&
                     uint64_t(revision) == attempt.revision &&
                     source.isSome() == attempt.source.isSome(),
                 NS_ERROR_NOT_AVAILABLE);
  if (source) {
    const auto& expected = *attempt.source;
    NS_ENSURE_TRUE(
        source->folderId == expected.folderId && source->key == expected.key &&
            source->epoch == expected.epoch && source->uid == expected.uid,
        NS_ERROR_NOT_AVAILABLE);
  }
  OfflineOperationData payload;
  MOZ_TRY(GetOfflineOperation(body.folderId, body.key, payload));
  NS_ENSURE_TRUE(
      (payload.operation & attempt.operation) &&
          (!payload.pendingDestination ||
           SamePendingDestination(*payload.pendingDestination, target)),
      NS_ERROR_NOT_AVAILABLE);
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "AcceptedAppendOtherCustody"_ns,
        "SELECT 1 FROM offline_operations WHERE id<>:operation AND "
        "(messageKey=:key OR destinationKey=:key) UNION ALL SELECT 1 FROM "
        "offline_copy_destinations WHERE destinationKey=:key UNION ALL "
        "SELECT 1 FROM offline_attempts WHERE id<>:attempt AND "
        "(sourceKey=:key OR destinationKey=:key) UNION ALL SELECT 1 FROM "
        "imap_import_operation_holds WHERE messageKey=:key LIMIT 1"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("operation"_ns, attempt.operationId));
    MOZ_TRY(stmt->BindInt64ByName("attempt"_ns, attempt.id));
    MOZ_TRY(stmt->BindInt64ByName("key"_ns, body.key));
    bool claimed;
    MOZ_TRY(stmt->ExecuteStep(&claimed));
    NS_ENSURE_FALSE(claimed, NS_ERROR_NOT_AVAILABLE);
  }
  // Provider-finished zeroes are values, never missing or coerced cells.
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "AcceptedAppendBodyPresence"_ns,
        "SELECT count(*) FROM message_properties WHERE id=:key AND "
        "((name='storeToken' AND typeof(value)='text' AND length(value)>0) OR "
        "(name IN('messageSize','offlineMessageSize','lineCount') AND "
        "typeof(value)='integer' AND value BETWEEN 0 AND 4294967295))"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("key"_ns, body.key));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_UNEXPECTED);
    int64_t present;
    MOZ_TRY(stmt->GetInt64(0, &present));
    NS_ENSURE_TRUE(present == 4, NS_ERROR_NOT_AVAILABLE);
  }
  MessageBodyState current;
  MOZ_TRY(ReadMessageBodyState(body.key, current));
  Maybe<nsCString> stamp;
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "ReadAcceptedAppendObservation"_ns,
        "SELECT value FROM message_properties WHERE id=:key AND "
        "name='panoramaAcceptedAppendObservation'"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("key"_ns, body.key));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (more) {
      int32_t type;
      MOZ_TRY(stmt->GetTypeOfIndex(0, &type));
      NS_ENSURE_TRUE(type == mozIStorageValueArray::VALUE_TYPE_TEXT,
                     NS_ERROR_FILE_CORRUPTED);
      nsCString value;
      MOZ_TRY(stmt->GetUTF8String(0, value));
      stamp = Some(std::move(value));
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
    }
  }
  nsTArray<nsCString> names;
  MOZ_TRY(GetMessagePropertyNames(body.key, names));
  if (stamp) {
    NS_ENSURE_TRUE(
        uid && names.Contains("uidOnServer"_ns) &&
            current.locationRevision > body.locationRevision &&
            *stamp == AcceptedAppendObservationStamp(attempt, epoch, *uid,
                                                     current.locationRevision),
        NS_ERROR_NOT_AVAILABLE);
    auto bound = body;
    bound.locationRevision = current.locationRevision;
    NS_ENSURE_TRUE(SameBodyGuard(current, bound), NS_ERROR_NOT_AVAILABLE);
    uint32_t actualUid;
    MOZ_TRY(GetMessageUidOnServer(body.key, actualUid));
    NS_ENSURE_TRUE(actualUid == *uid, NS_ERROR_NOT_AVAILABLE);
    // The row is already proven published by ReadMessageBodyState. With an
    // existing equal property this only reads back all published/staged
    // aliases; it must not create another journal event on repeated discovery.
    MOZ_TRY(BindMessageToServerUidInTransaction(body.key, body.folderId, epoch,
                                                *uid, true));
  } else {
    NS_ENSURE_TRUE(
        !names.Contains("uidOnServer"_ns) && SameBodyGuard(current, body),
        NS_ERROR_NOT_AVAILABLE);
  }
  associated = stamp.isSome();
  return NS_OK;
}

nsresult MessageDatabase::AssociateAcceptedAppendObservation(
    const OfflineAttempt& expected, uint32_t observedEpoch,
    uint32_t observedUid, ServerMessageLocation& mapping,
    Message** liveHeader) {
  NS_ENSURE_ARG_POINTER(liveHeader);
  NS_ENSURE_FALSE(*liveHeader, NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(observedEpoch && observedUid, NS_ERROR_INVALID_ARG);
  MOZ_TRY(RequireCommittedSearchRead());
  // Do not borrow a caller's mutable snapshot across any native SQL reentry.
  const OfflineAttempt selected(expected);
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  RefPtr<Message> header;
  ServerMessageLocation result;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    OfflineAttempt actual;
    MOZ_TRY(ReadExpectedAppendAttempt(selected, actual));
    bool associated;
    MOZ_TRY(ReadAcceptedAppendObservationInTransaction(
        actual, observedEpoch, Some(observedUid), associated));
    const auto& body = *actual.appendBody;
    if (!associated) {
      MOZ_TRY(BindMessageToServerUidInTransaction(
          body.key, body.folderId, observedEpoch, observedUid, false));
      MOZ_TRY(RequireCurrentOwner());
      MessageBodyState bound;
      MOZ_TRY(ReadMessageBodyState(body.key, bound));
      auto original = body;
      original.locationRevision = bound.locationRevision;
      NS_ENSURE_TRUE(bound.locationRevision > body.locationRevision &&
                         SameBodyGuard(bound, original),
                     NS_ERROR_NOT_AVAILABLE);
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "StoreAcceptedAppendObservation"_ns,
          "INSERT INTO message_properties(id,name,value) VALUES(:key,"
          "'panoramaAcceptedAppendObservation',:stamp) RETURNING id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("key"_ns, body.key));
      MOZ_TRY(stmt->BindUTF8StringByName(
          "stamp"_ns,
          AcceptedAppendObservationStamp(actual, observedEpoch, observedUid,
                                         bound.locationRevision)));
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
    }
    // Any trigger/reentry changes to the original attempt/body/source or final
    // mapping fail before commit. The attempt/operation/receipt rows are
    // read-only.
    MOZ_TRY(RequireCurrentOwner());
    MOZ_TRY(ReadExpectedAppendAttempt(selected, actual));
    MOZ_TRY(ReadAcceptedAppendObservationInTransaction(
        actual, observedEpoch, Some(observedUid), associated));
    NS_ENSURE_TRUE(associated, NS_ERROR_NOT_AVAILABLE);
    result = {actual.destination->folderId, actual.destination->key,
              observedEpoch, observedUid};
    header = new (fallible) Message(result.key);
    NS_ENSURE_TRUE(header, NS_ERROR_OUT_OF_MEMORY);
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    return FinishOfflineWrite(connection, rv);
  }
  // This is an existing published member, not a second publication. Install
  // both owning outputs without a fallible lookup or message-added callback.
  mapping = result;
  header.forget(liveHeader);
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
  MOZ_TRY(RequireCurrentOwner());
  OfflineAttempt attempt;
  MOZ_TRY(GetOfflineAttempt(attemptId, attempt));
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ResolveOfflineAttemptNotApplied"_ns,
      "UPDATE offline_attempts SET state = 0 WHERE id = :id AND state IN (1,3) "
      "AND appendAccepted = 0 AND transferAccepted = 0 AND (replayVersion = 0 "
      "OR (operation <> 1 AND moveExpunge IS NULL)) "
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
  MOZ_TRY(RequireCurrentOwner());
  OfflineAttempt attempt;
  MOZ_TRY(GetOfflineAttempt(attemptId, attempt));
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "MarkOfflineAttemptAmbiguous"_ns,
      "UPDATE offline_attempts SET state = 3 WHERE id = :id AND state IN (1,3) "
      "AND appendAccepted = 0 AND transferAccepted = 0 AND (replayVersion = 0 "
      "OR (operation <> 1 AND moveExpunge IS NULL)) "
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
  MOZ_TRY(RequireCurrentOwner());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool active;
  MOZ_TRY(connection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    OfflineAttempt attempt;
    MOZ_TRY(GetOfflineAttempt(attemptId, attempt));
    if (attempt.operation == OfflineOp::kFlagsChanged &&
        attempt.replayVersion) {
      NS_ENSURE_TRUE(
          (!attempt.flagSet || ReplayAcknowledged(attempt.flagSet)) &&
              (!attempt.flagClear || ReplayAcknowledged(attempt.flagClear)),
          NS_ERROR_NOT_AVAILABLE);
    }
    NS_ENSURE_TRUE(attempt.destination.isSome() == destinationUid.isSome(),
                   NS_ERROR_INVALID_ARG);
    if (attempt.state == OfflineAttemptState::Confirmed) {
      NS_ENSURE_TRUE(
          destinationUid
              ? (attempt.confirmedUid == Some(destinationUid->uid) &&
                 attempt.confirmedEpoch == Some(destinationUid->epoch))
              : attempt.confirmedUid.isNothing(),
          NS_ERROR_FILE_CORRUPTED);
      return connection->CommitTransaction();
    }
    NS_ENSURE_TRUE(attempt.state == OfflineAttemptState::Sent ||
                       attempt.state == OfflineAttemptState::Ambiguous,
                   NS_ERROR_NOT_AVAILABLE);
    if (!attempt.transferSourceId.IsEmpty()) {
      QueuedSourceIdentity identity{
          attempt.transferSourceId, attempt.folderId, attempt.operationKey,
          attempt.operationId,      attempt.revision, attempt.source};
      MOZ_TRY(ValidateQueuedSourceIdentity(identity));
    }
    if (attempt.transferBody) {
      MOZ_TRY(ValidateTransferTargetInTransaction(attempt));
    }
    if (attempt.appendBody) {
      MOZ_TRY(ValidateAppendTargetInTransaction(attempt));
    }
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
      if (attempt.destination->epochKnown) {
        NS_ENSURE_TRUE(destinationUid->epoch == attempt.destination->epoch,
                       NS_ERROR_NOT_AVAILABLE);
      } else {
        NS_ENSURE_TRUE(!attempt.transferSourceId.IsEmpty(),
                       NS_ERROR_NOT_AVAILABLE);
        QueuedSourceIdentity identity{
            attempt.transferSourceId, attempt.folderId, attempt.operationKey,
            attempt.operationId,      attempt.revision, attempt.source};
        MOZ_TRY(ObserveDestinationEpochInTransaction(
            identity, attempt.operation, attempt.copyOrdinal,
            *attempt.destination, destinationUid->epoch));
      }
      MOZ_TRY(BindMessageToServerUidInTransaction(
          attempt.destination->key, attempt.destination->folderId,
          destinationUid->epoch, destinationUid->uid, true));
      if (attempt.replayVersion == 1 &&
          attempt.operation == OfflineOp::kMsgMoved &&
          attempt.moveSourceGuard) {
        // This checked UID-property write advances the destination journal.
        // Retain its resulting incarnation inside the same confirmation TX;
        // never accept a later lookup as proof that the COPY body still
        // matches.
        MessageBodyState bound;
        MOZ_TRY(ReadMessageBodyState(attempt.destination->key, bound));
        auto before = *attempt.transferBody;
        before.contentRevision = bound.contentRevision;
        before.locationRevision = bound.locationRevision;
        NS_ENSURE_TRUE(SameBodyGuard(before, bound), NS_ERROR_NOT_AVAILABLE);
        nsCOMPtr<mozIStorageStatement> update;
        MOZ_TRY(DatabaseCore::GetStatement(
            "ConfirmMoveBodyIncarnation"_ns,
            "UPDATE offline_attempts SET transferContentRevision=:content,"
            "transferLocationRevision=:location WHERE id=:id"_ns,
            getter_AddRefs(update)));
        mozStorageStatementScoper scope(update);
        MOZ_TRY(update->BindInt64ByName("content"_ns, bound.contentRevision));
        MOZ_TRY(update->BindInt64ByName("location"_ns, bound.locationRevision));
        MOZ_TRY(update->BindInt64ByName("id"_ns, attempt.id));
        MOZ_TRY(update->Execute());
      }
    }
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "ConfirmOfflineAttempt"_ns,
          "UPDATE offline_attempts SET state = 2, confirmedUid = :uid, "
          "confirmedEpoch=:epoch WHERE id = :id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, attemptId));
      if (destinationUid) {
        MOZ_TRY(stmt->BindInt64ByName("uid"_ns, destinationUid->uid));
        MOZ_TRY(stmt->BindInt64ByName("epoch"_ns, destinationUid->epoch));
      } else {
        MOZ_TRY(stmt->BindNullByName("uid"_ns));
        MOZ_TRY(stmt->BindNullByName("epoch"_ns));
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
  MOZ_TRY(RequireCurrentOwner());
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
  NS_ENSURE_TRUE(DatabaseCore::sInstance && DatabaseCore::sConnection &&
                     DatabaseCore::sInstance->mMessageDatabase.get() == this,
                 NS_ERROR_NOT_AVAILABLE);
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
  NS_ENSURE_TRUE(key != nsMsgKey_None, NS_ERROR_INVALID_ARG);
  return RemoveMessageInternal(key, 0, nullptr,
                               MessageRemovalAccounting::LocalMessageSize);
}

nsresult MessageDatabase::RemoveMessageFromFolder(
    nsMsgKey key, uint64_t folderId, const nsACString& databaseSourceId,
    MessageRemovalAccounting accounting) {
  NS_ENSURE_TRUE(key != nsMsgKey_None && folderId && folderId <= INT64_MAX &&
                     !databaseSourceId.IsEmpty(),
                 NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(accounting == MessageRemovalAccounting::LocalMessageSize ||
                     accounting == MessageRemovalAccounting::OfflineMessageSize,
                 NS_ERROR_INVALID_ARG);
  MOZ_TRY(RequireCommittedSearchRead());
  return RemoveMessageInternal(key, folderId, &databaseSourceId, accounting);
}

nsresult MessageDatabase::RemoveMessageForUndo(nsMsgKey key,
                                               RemovedMessage& output) {
  NS_ENSURE_TRUE(key != nsMsgKey_None, NS_ERROR_INVALID_ARG);
  MOZ_TRY(RequireCommittedSearchRead());
  MOZ_TRY(CheckMessageBodyAccess(key));
  RefPtr<MessageDatabase> self(this);
  return RemoveMessageInternal(
      key, 0, nullptr, MessageRemovalAccounting::LocalMessageSize, &output);
}

nsresult MessageDatabase::RemoveMessageForUndo(
    nsMsgKey key, uint64_t folderId, const nsACString& databaseSourceId,
    MessageRemovalAccounting accounting, RemovedMessage& output,
    OfflineOperationUndo* redo, OfflineOperationUndo* nextOffline) {
  NS_ENSURE_TRUE(key != nsMsgKey_None && folderId && folderId <= INT64_MAX &&
                     !databaseSourceId.IsEmpty(),
                 NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(accounting == MessageRemovalAccounting::LocalMessageSize ||
                     accounting == MessageRemovalAccounting::OfflineMessageSize,
                 NS_ERROR_INVALID_ARG);
  MOZ_TRY(RequireCommittedSearchRead());
  RefPtr<MessageDatabase> self(this);
  NS_ENSURE_TRUE((redo == nullptr) == (nextOffline == nullptr),
                 NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(!redo || (redo != nextOffline && redo->mData &&
                           redo->mData->redoState && !nextOffline->mData),
                 NS_ERROR_NOT_AVAILABLE);
  return RemoveMessageInternal(key, folderId, &databaseSourceId, accounting,
                               &output, redo, nextOffline);
}

nsresult MessageDatabase::RestoreMessageForUndo(
    uint64_t folderId, RemovedMessage& captured,
    const FinishedMessageBody& finished, nsMsgKey* key, Message** liveHeader,
    OfflineOperationUndo* offline, const PendingDestination* cancelMove,
    OfflineOperationUndo* redo) {
  NS_ENSURE_ARG_POINTER(key);
  NS_ENSURE_TRUE(!offline || !liveHeader || !*liveHeader, NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(!offline || (offline->mData && !offline->mData->redoState),
                 NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE((cancelMove == nullptr) == (redo == nullptr),
                 NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(!redo || (offline && offline != redo && !redo->mData),
                 NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(captured.mData, NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(folderId && folderId <= INT64_MAX, NS_ERROR_INVALID_ARG);
  MOZ_TRY(RequireCommittedSearchRead());
  nsCString source;
  MOZ_TRY(DatabaseCore::sInstance->GetSourceId(source));
  NS_ENSURE_TRUE(source == captured.mData->body.databaseSourceId,
                 NS_ERROR_NOT_AVAILABLE);
  RefPtr<MessageDatabase> self(this);
  return InsertMessage(folderId, captured.mData->header, false, true, key,
                       liveHeader, &captured, &finished, offline, cancelMove,
                       redo);
}

nsresult MessageDatabase::ReadRemovedMessage(nsMsgKey key,
                                             RemovedMessage& output) {
  auto saved = MakeUnique<RemovedMessage::Data>();
  MOZ_TRY(ReadMessageBodyState(key, saved->body));
  CachedMsg row;
  MOZ_TRY(FetchMsg(key, row));
  saved->header.key = key;
  saved->header.messageId = row.messageId;
  saved->header.date = row.date;
  saved->header.sender = row.sender;
  saved->header.recipients = row.recipients;
  saved->header.ccList = row.ccList;
  saved->header.bccList = row.bccList;
  saved->header.subject = row.subject;
  saved->header.flags = row.flags;
  saved->header.keywords = row.tags;
  saved->header.priority = row.priority;
  saved->threadId = row.threadId;
  saved->threadParent = row.threadParent;
  nsresult refs = GetMessageReferences(key, saved->header.references);
  if (NS_FAILED(refs) && refs != NS_ERROR_NOT_AVAILABLE) {
    return refs;
  }
  saved->referencesKnown = NS_SUCCEEDED(refs);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "CaptureRemovedProperties"_ns,
      "SELECT name,value FROM message_properties WHERE id=:id ORDER BY name COLLATE BINARY"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
  while (true) {
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (!more) {
      break;
    }
    RemovedMessage::Data::Property* property =
        saved->properties.AppendElement();
    int32_t type;
    MOZ_TRY(stmt->GetTypeOfIndex(0, &type));
    NS_ENSURE_TRUE(type == mozIStorageValueArray::VALUE_TYPE_TEXT,
                   NS_ERROR_FILE_CORRUPTED);
    MOZ_TRY(stmt->GetUTF8String(0, property->name));
    MOZ_TRY(stmt->GetTypeOfIndex(1, &type));
    if (type == mozIStorageValueArray::VALUE_TYPE_INTEGER) {
      int64_t value;
      MOZ_TRY(stmt->GetInt64(1, &value));
      property->integer = Some(value);
    } else {
      NS_ENSURE_TRUE(type == mozIStorageValueArray::VALUE_TYPE_TEXT,
                     NS_ERROR_FILE_CORRUPTED);
      MOZ_TRY(stmt->GetUTF8String(1, property->text));
    }
  }
  output.mData = std::move(saved);
  return NS_OK;
}

// Called only inside the removal transaction. Read the authoritative row and
// storage properties, rather than a possibly retained or warmed header.
nsresult MessageDatabase::AccountRemovedMessage(
    nsMsgKey key, uint64_t folderId, const nsACString& databaseSourceId,
    MessageRemovalAccounting accounting) {
  MOZ_TRY(CheckPendingMessageRelocation(key));
  uint32_t flags;
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(
        DatabaseCore::GetStatement("RemovalPhysicalIdentity"_ns,
                                   "SELECT m.flags, d.sourceId FROM messages m "
                                   "JOIN folders f ON f.id=m.folderId "
                                   "JOIN database_identity d ON d.singleton=1 "
                                   "WHERE m.id=:id AND m.folderId=:folder"_ns,
                                   getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
    int64_t storedFlags;
    nsCString source;
    MOZ_TRY(stmt->GetInt64(0, &storedFlags));
    MOZ_TRY(stmt->GetUTF8String(1, source));
    NS_ENSURE_TRUE(source == databaseSourceId, NS_ERROR_NOT_AVAILABLE);
    NS_ENSURE_TRUE(
        storedFlags >= INT32_MIN && storedFlags <= int64_t(UINT32_MAX),
        NS_ERROR_FILE_CORRUPTED);
    flags = static_cast<uint32_t>(storedFlags);
  }
  if (accounting == MessageRemovalAccounting::OfflineMessageSize &&
      !(flags & nsMsgMessageFlags::Offline)) {
    return NS_OK;
  }

  int64_t size = 0;
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "RemovalStorageSize"_ns,
        "SELECT value FROM message_properties WHERE id=:id AND name=:name"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    MOZ_TRY(stmt->BindUTF8StringByName(
        "name"_ns, accounting == MessageRemovalAccounting::LocalMessageSize
                       ? "messageSize"_ns
                       : "offlineMessageSize"_ns));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (more) {
      MOZ_TRY(stmt->GetInt64(0, &size));
    }
    // The public size view is uint32. Do not wrap corrupt signed/wide values
    // or narrow legitimate sizes through int32 before accounting.
    NS_ENSURE_TRUE(size >= 0 && uint64_t(size) <= UINT32_MAX,
                   NS_ERROR_LOSS_OF_SIGNIFICANT_DATA);
  }
  int64_t expunged = 0;
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "RemovalExpungedBytes"_ns,
        "SELECT value FROM folder_properties WHERE id=:folder "
        "AND name='expungedBytes'"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (more) {
      MOZ_TRY(stmt->GetInt64(0, &expunged));
    }
    NS_ENSURE_TRUE(expunged >= 0, NS_ERROR_LOSS_OF_SIGNIFICANT_DATA);
  }
  CheckedInt<int64_t> total(expunged);
  total += size;
  NS_ENSURE_TRUE(total.isValid(), NS_ERROR_LOSS_OF_SIGNIFICANT_DATA);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "AccountRemovedMessage"_ns,
      "REPLACE INTO folder_properties(id,name,value) "
      "VALUES(:folder,'expungedBytes',:value)"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
  MOZ_TRY(stmt->BindInt64ByName("value"_ns, total.value()));
  return stmt->Execute();
}

nsresult MessageDatabase::RemoveMessageInternal(
    nsMsgKey key, uint64_t folderId, const nsACString* databaseSourceId,
    MessageRemovalAccounting accounting, RemovedMessage* output,
    OfflineOperationUndo* redo, OfflineOperationUndo* nextOffline,
    const OfflineAttempt* settlement, OfflineMoveSettlement* settledOutput) {
  MOZ_ASSERT(key != nsMsgKey_None);
  MOZ_TRY(RequireCurrentOwner());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool inTransaction;
  MOZ_TRY(connection->GetTransactionInProgress(&inTransaction));
  if (inTransaction) {
    return NS_ERROR_IN_PROGRESS;
  }

  OfflineMoveSettlement settled;
  RemovedMessage captured;
  OfflineOperationUndo preparedOffline;
  CachedMsg cached;
  RefPtr<Message> message;
  UniquePtr<QueuedMessageBatch> notification;
  MOZ_TRY(PrepareMessageBatch(notification));
  notification->kind = QueuedMessageBatch::Kind::Removed;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    if (settlement) {
      OfflineAttempt actual;
      MOZ_TRY(ReadExpectedReplayAttempt(*settlement, actual));
      MOZ_TRY(ValidateReplayMove(actual));
      NS_ENSURE_TRUE(!actual.moveSettled &&
                         ReplayAcknowledged(actual.sourceStore) &&
                         (!actual.sourceExpunge ||
                          ReplayAcknowledged(actual.sourceExpunge)),
                     NS_ERROR_NOT_AVAILABLE);
      bool present;
      MOZ_TRY(ValidateReplaySource(actual, present));
      NS_ENSURE_TRUE(present && actual.source->key == key,
                     NS_ERROR_NOT_AVAILABLE);
    }
    if (databaseSourceId) {
      MOZ_TRY(
          AccountRemovedMessage(key, folderId, *databaseSourceId, accounting));
    }
    if (output) {
      MOZ_TRY(ReadRemovedMessage(key, captured));
    }
    if (redo) {
      MOZ_TRY(ReapplyOfflineMoveInTransaction(folderId, key, *redo,
                                              preparedOffline));
    }
    MOZ_TRY(CaptureMessage(key, notification->before));
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
    if (output) {
      // Property deletion may itself advance revisions before the row delete.
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "CaptureUndoTombstone"_ns,
          "SELECT sequence,deleted FROM message_changes WHERE messageId=:id "
          "ORDER BY sequence DESC LIMIT 1"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
      int64_t deleted;
      MOZ_TRY(stmt->GetInt64(0, &captured.mData->deletionSequence));
      MOZ_TRY(stmt->GetInt64(1, &deleted));
      NS_ENSURE_TRUE(deleted == 1 && captured.mData->deletionSequence > 0,
                     NS_ERROR_FILE_CORRUPTED);
    }
    if (!mMsgCache.reserve(mMsgCache.count() + 1)) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
    message = new (fallible) Message(key);
    NS_ENSURE_TRUE(message, NS_ERROR_OUT_OF_MEMORY);
    notification->live = message;
    if (settlement)
      MOZ_TRY(FinishOfflineMoveInTransaction(*settlement, true, settled));
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
  auto entry = mMsgCache.lookup(key);
  if (entry) {
    entry->value() = std::move(cached);
  } else {
    mMsgCache.putNewInfallible(key, std::move(cached));
  }
  if (output) {
    *output = std::move(captured);
  }
  if (redo) {
    *nextOffline = std::move(preparedOffline);
    redo->mData.reset();
  }
  if (settledOutput) *settledOutput = settled;
  QueueMessageBatch(std::move(notification));
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

namespace {

nsresult ReadThreadKey(mozIStorageStatement* stmt, uint32_t column, bool parent,
                       nsMsgKey& output) {
  int32_t type;
  MOZ_TRY(stmt->GetTypeOfIndex(column, &type));
  if (parent && type == mozIStorageStatement::VALUE_TYPE_NULL) {
    output = 0;
    return NS_OK;
  }
  NS_ENSURE_TRUE(type == mozIStorageStatement::VALUE_TYPE_INTEGER,
                 NS_ERROR_FILE_CORRUPTED);
  int64_t value;
  MOZ_TRY(stmt->GetInt64(column, &value));
  NS_ENSURE_TRUE(
      value >= (parent ? 0 : 1) &&
          uint64_t(value) <= (parent ? nsMsgKey_None : nsMsgKey_None - 1),
      NS_ERROR_FILE_CORRUPTED);
  output = static_cast<nsMsgKey>(value);
  return NS_OK;
}

}  // namespace

nsresult MessageDatabase::ListThreadKeys(uint64_t folderId, uint64_t parent,
                                         uint64_t threadId,
                                         nsTArray<nsMsgKey>& keys) {
  NS_ENSURE_TRUE(folderId && folderId <= INT64_MAX && threadId &&
                     threadId < nsMsgKey_None && parent <= nsMsgKey_None,
                 NS_ERROR_INVALID_ARG);
  struct Member {
    nsMsgKey key, parent;
    uint64_t folder;
    nsTArray<uint32_t> children;
  };
  nsTArray<Member> members;
  nsTHashMap<nsMsgKey, uint32_t> indexes;
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "ThreadMembersForOrder"_ns,
        "SELECT id,threadParent,folderId FROM messages "
        "WHERE threadId=:threadId ORDER BY id"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("threadId"_ns, threadId));
    while (true) {
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      if (!more) {
        break;
      }
      Member* member = members.AppendElement();
      MOZ_TRY(ReadThreadKey(stmt, 0, false, member->key));
      MOZ_TRY(ReadThreadKey(stmt, 1, true, member->parent));
      int64_t folder;
      MOZ_TRY(stmt->GetInt64(2, &folder));
      NS_ENSURE_TRUE(folder >= 0, NS_ERROR_FILE_CORRUPTED);
      member->folder = folder;
      uint32_t duplicate;
      NS_ENSURE_FALSE(indexes.Get(member->key, &duplicate),
                      NS_ERROR_FILE_CORRUPTED);
      indexes.InsertOrUpdate(member->key, members.Length() - 1);
    }
  }
  nsTArray<uint32_t> roots;
  for (uint32_t i = 0; i < members.Length(); ++i) {
    uint32_t parentIndex;
    if (indexes.Get(members[i].parent, &parentIndex)) {
      members[parentIndex].children.AppendElement(i);
    } else {
      // An absent parent changes traversal order, never stored membership.
      roots.AppendElement(i);
    }
  }
  nsTArray<uint32_t> pending;
  if (parent) {
    uint32_t index;
    if (indexes.Get(parent, &index)) {
      pending.AppendElement(index);
    }
  } else {
    for (uint32_t i = roots.Length(); i; --i) {
      pending.AppendElement(roots[i - 1]);
    }
  }
  nsTArray<uint8_t> visited;
  visited.SetLength(members.Length());
  for (auto& value : visited) {
    value = 0;
  }
  uint32_t seen = 0;
  nsTArray<nsMsgKey> found;
  while (!pending.IsEmpty()) {
    uint32_t index = pending.LastElement();
    pending.RemoveLastElement();
    NS_ENSURE_FALSE(visited[index], NS_ERROR_FILE_CORRUPTED);
    visited[index] = 1;
    ++seen;
    const auto& member = members[index];
    if (member.folder == folderId) {
      found.AppendElement(member.key);
    }
    for (uint32_t i = member.children.Length(); i; --i) {
      pending.AppendElement(member.children[i - 1]);
    }
  }
  // Do not silently omit a component with a parent cycle.
  NS_ENSURE_TRUE(parent || seen == members.Length(), NS_ERROR_FILE_CORRUPTED);
  keys = std::move(found);
  return NS_OK;
}

nsresult MessageDatabase::GetThreadFlags(uint64_t folderId, uint64_t threadId,
                                         uint32_t& output) {
  NS_ENSURE_TRUE(DatabaseCore::sInstance && DatabaseCore::sConnection &&
                     DatabaseCore::sInstance->mMessageDatabase.get() == this,
                 NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(
      folderId && folderId <= INT64_MAX && threadId && threadId < nsMsgKey_None,
      NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "GetThreadFlags"_ns,
      "SELECT t.folderId,t.flags FROM folders f LEFT JOIN thread_flags t "
      "ON t.folderId=f.id AND t.threadId=:thread WHERE f.id=:folder AND "
      "EXISTS(SELECT 1 FROM messages m WHERE m.folderId=f.id AND m.threadId=:thread)"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
  MOZ_TRY(stmt->BindInt64ByName("thread"_ns, threadId));
  bool more, absent;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(stmt->GetIsNull(0, &absent));
  int64_t flags = 0;
  if (!absent) {
    int32_t type;
    MOZ_TRY(stmt->GetTypeOfIndex(1, &type));
    NS_ENSURE_TRUE(type == mozIStorageStatement::VALUE_TYPE_INTEGER,
                   NS_ERROR_FILE_CORRUPTED);
    MOZ_TRY(stmt->GetInt64(1, &flags));
    NS_ENSURE_TRUE(flags >= 0 && uint64_t(flags) <= UINT32_MAX,
                   NS_ERROR_FILE_CORRUPTED);
  }
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  output = static_cast<uint32_t>(flags);
  return NS_OK;
}

nsresult MessageDatabase::SetThreadFlags(uint64_t folderId, uint64_t threadId,
                                         uint32_t flags) {
  NS_ENSURE_TRUE(DatabaseCore::sInstance && DatabaseCore::sConnection &&
                     DatabaseCore::sInstance->mMessageDatabase.get() == this,
                 NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(
      folderId && folderId <= INT64_MAX && threadId && threadId < nsMsgKey_None,
      NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(RequireCommittedSearchRead());
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "SetThreadFlags"_ns,
      "INSERT INTO thread_flags(folderId,threadId,flags) "
      "SELECT :folder,:thread,:flags WHERE EXISTS(SELECT 1 FROM folders WHERE "
      "id=:folder) "
      "AND EXISTS(SELECT 1 FROM messages WHERE folderId=:folder AND "
      "threadId=:thread) "
      "ON CONFLICT(folderId,threadId) DO UPDATE SET flags=excluded.flags RETURNING folderId"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
  MOZ_TRY(stmt->BindInt64ByName("thread"_ns, threadId));
  MOZ_TRY(stmt->BindInt64ByName("flags"_ns, flags));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  return NS_OK;
}

nsresult MessageDatabase::GetThreadMaxDate(uint64_t folderId, uint64_t threadId,
                                           uint64_t* maxDate) {
  NS_ENSURE_ARG_POINTER(maxDate);
  NS_ENSURE_TRUE(
      folderId && folderId <= INT64_MAX && threadId && threadId < nsMsgKey_None,
      NS_ERROR_INVALID_ARG);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "GetThreadMaxDate"_ns,
      "SELECT MAX(date) AS maxDate FROM messages WHERE folderId = :folderId AND threadId = :threadId"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, folderId));
  MOZ_TRY(stmt->BindInt64ByName("threadId"_ns, threadId));
  bool more, absent;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
  MOZ_TRY(stmt->GetIsNull(0, &absent));
  int64_t date = 0;
  if (!absent) {
    MOZ_TRY(stmt->GetInt64(0, &date));
  }
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  *maxDate = static_cast<uint64_t>(date);
  return NS_OK;
}

nsresult MessageDatabase::CountThreadKeys(uint64_t folderId, uint64_t threadId,
                                          uint64_t* numMessages) {
  NS_ENSURE_ARG_POINTER(numMessages);
  NS_ENSURE_TRUE(
      folderId && folderId <= INT64_MAX && threadId && threadId < nsMsgKey_None,
      NS_ERROR_INVALID_ARG);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "CountThreadKeys"_ns,
      "SELECT COUNT(*) AS numMessages FROM messages WHERE folderId = :folderId AND threadId = :threadId"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, folderId));
  MOZ_TRY(stmt->BindInt64ByName("threadId"_ns, threadId));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
  int64_t count;
  MOZ_TRY(stmt->GetInt64(0, &count));
  NS_ENSURE_TRUE(count >= 0, NS_ERROR_FILE_CORRUPTED);
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  *numMessages = static_cast<uint64_t>(count);
  return NS_OK;
}

nsresult MessageDatabase::ListThreadChildKeys(uint64_t folderId,
                                              uint64_t parent,
                                              nsTArray<nsMsgKey>& keys) {
  NS_ENSURE_TRUE(folderId && folderId <= INT64_MAX && parent <= nsMsgKey_None,
                 NS_ERROR_INVALID_ARG);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ListThreadChildKeys"_ns,
      "SELECT id FROM messages WHERE folderId = :folderId AND threadParent = :parent ORDER BY id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, folderId));
  MOZ_TRY(stmt->BindInt64ByName("parent"_ns, parent));
  nsTArray<nsMsgKey> found;
  while (true) {
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (!more) {
      break;
    }
    nsMsgKey key;
    MOZ_TRY(ReadThreadKey(stmt, 0, false, key));
    found.AppendElement(key);
  }
  keys = std::move(found);
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
    // Trimming can invalidate the insertion slot captured by lookupForAdd.
    if (!mMsgCache.relookupOrAdd(p, key, msg)) {
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

// Retired folders retain message history, but cannot supply new parents.
Result<nsMsgKey, nsresult> MessageDatabase::FindByMessageId(
    nsACString const& messageId) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "FindByMessageId"_ns,
      "SELECT m.id FROM messages m JOIN folders f ON f.id=m.folderId "
      "WHERE m.messageId=:messageId COLLATE BINARY ORDER BY m.id LIMIT 1"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindUTF8StringByName("messageId"_ns, messageId));

  bool hasResult;
  MOZ_TRY(stmt->ExecuteStep(&hasResult));
  if (!hasResult) {
    return nsMsgKey{0};
  }
  nsMsgKey key;
  MOZ_TRY(ReadThreadKey(stmt, 0, false, key));
  MOZ_TRY(stmt->ExecuteStep(&hasResult));
  if (hasResult) {
    return Err(NS_ERROR_FILE_CORRUPTED);
  }
  return key;
}

namespace {
nsresult RollbackMessageChange(mozIStorageConnection* connection,
                               nsresult original);
nsresult ChangeHeader(const CapturedMessage& row,
                      RefPtr<DetachedMsgHdr>& output);
}  // namespace

nsresult MessageDatabase::MarkAllRead(uint64_t aFolderId,
                                      nsTArray<nsMsgKey>& aMarkedKeys) {
  MOZ_TRY(RequireCommittedSearchRead());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  nsTArray<nsMsgKey> marked;
  nsTArray<UniquePtr<PreparedNewsReadSet>> newsPrepared;
  UniquePtr<QueuedMessageBatch> notification;
  MOZ_TRY(PrepareMessageBatch(notification));
  notification->kind = QueuedMessageBatch::Kind::Flags;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    // Capture every affected physical row before changing any flags. Existing
    // per-message listeners receive one commit-ordered batch after settlement.
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "MarkAllReadBefore"_ns,
          "SELECT id FROM messages WHERE folderId=:folderId "
          "AND flags & :flag = 0 ORDER BY id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, aFolderId));
      MOZ_TRY(stmt->BindInt64ByName("flag"_ns, nsMsgMessageFlags::Read));
      while (true) {
        bool more;
        MOZ_TRY(stmt->ExecuteStep(&more));
        if (!more) {
          break;
        }
        int64_t key;
        MOZ_TRY(stmt->GetInt64(0, &key));
        NS_ENSURE_TRUE(key > 0 && key < nsMsgKey_None, NS_ERROR_FILE_CORRUPTED);
        QueuedMessageBatch::Flags change;
        MOZ_TRY(CaptureMessage(static_cast<nsMsgKey>(key), change.before));
        RefPtr<DetachedMsgHdr> old;
        MOZ_TRY(ChangeHeader(change.before, old));
        change.oldHeader = old;
        change.live = new (fallible) Message(static_cast<nsMsgKey>(key));
        NS_ENSURE_TRUE(change.live, NS_ERROR_OUT_OF_MEMORY);
        if (!notification->flagChanges.AppendElement(std::move(change),
                                                     fallible)) {
          return NS_ERROR_OUT_OF_MEMORY;
        }
      }
    }
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(
          DatabaseCore::GetStatement("MarkAllRead"_ns,
                                     "UPDATE messages SET flags = flags | "
                                     ":flag WHERE folderId = :folderId "
                                     "AND flags & :flag = 0 RETURNING id"_ns,
                                     getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("flag"_ns, nsMsgMessageFlags::Read));
      MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, aFolderId));
      while (true) {
        bool more;
        MOZ_TRY(stmt->ExecuteStep(&more));
        if (!more) {
          break;
        }
        int64_t key;
        MOZ_TRY(stmt->GetInt64(0, &key));
        NS_ENSURE_TRUE(key > 0 && key < nsMsgKey_None, NS_ERROR_FILE_CORRUPTED);
        if (!marked.AppendElement(static_cast<nsMsgKey>(key), fallible)) {
          return NS_ERROR_OUT_OF_MEMORY;
        }
      }
    }
    marked.Sort();
    NS_ENSURE_TRUE(marked.Length() == notification->flagChanges.Length(),
                   NS_ERROR_FILE_CORRUPTED);
    for (size_t i = 0; i < marked.Length(); ++i) {
      auto& change = notification->flagChanges[i];
      NS_ENSURE_TRUE(marked[i] == change.before.id, NS_ERROR_FILE_CORRUPTED);
      MOZ_TRY(CaptureMessage(marked[i], change.after));
    }
    nsTArray<CapturedMessage> rows;
    for (const auto& change : notification->flagChanges) {
      NS_ENSURE_TRUE(rows.AppendElement(change.after, fallible),
                     NS_ERROR_OUT_OF_MEMORY);
    }
    MOZ_TRY(PrepareNewsReadChanges(rows, newsPrepared));
    MOZ_TRY(WriteNewsReadSets(newsPrepared));
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    return RollbackMessageChange(connection, rv);
  }
  // SQL, including every returned key, is settled before cache or caller
  // output.
  for (nsMsgKey key : marked) {
    auto entry = mMsgCache.lookup(key);
    if (entry) {
      entry->value().flags |= nsMsgMessageFlags::Read;
    }
  }
  InstallNewsReadSets(newsPrepared);
  aMarkedKeys = std::move(marked);
  if (!notification->flagChanges.IsEmpty()) {
    QueueMessageBatch(std::move(notification));
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
    // Native association provenance belongs to this physical incarnation;
    // ordinary header copies/undo metadata must not transplant it.
    if (!name.EqualsLiteral(kAcceptedAppendObservationProperty)) {
      found.AppendElement(std::move(name));
    }
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
  NS_ENSURE_TRUE(!IsNewsBindingProperty(aName) &&
                     !aName.EqualsLiteral(kAcceptedAppendObservationProperty),
                 NS_ERROR_INVALID_ARG);
  if (MOZ_LOG_TEST(gPanoramaLog, LogLevel::Debug)) {
    nsAutoCString existing;
    nsresult readResult = GetMessageProperty(aKey, aName, existing);
    MOZ_LOG(gPanoramaLog, LogLevel::Debug,
            ("Property string key=%u name=%s unchanged=%d read=0x%08x", aKey,
             PromiseFlatCString(aName).get(),
             NS_SUCCEEDED(readResult) && existing.Equals(aValue),
             static_cast<uint32_t>(readResult)));
  }

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
  NS_ENSURE_TRUE(!IsNewsBindingProperty(aName) &&
                     !aName.EqualsLiteral(kAcceptedAppendObservationProperty),
                 NS_ERROR_INVALID_ARG);
  if (MOZ_LOG_TEST(gPanoramaLog, LogLevel::Debug)) {
    uint32_t existing = 0;
    nsresult readResult = GetMessageProperty(aKey, aName, existing);
    MOZ_LOG(gPanoramaLog, LogLevel::Debug,
            ("Property uint32 key=%u name=%s unchanged=%d read=0x%08x", aKey,
             PromiseFlatCString(aName).get(),
             NS_SUCCEEDED(readResult) && existing == aValue,
             static_cast<uint32_t>(readResult)));
  }
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
  if (aListener) {
    PruneExpiredFolderListeners();
    mMessageListeners.AppendElement(new ListenerRegistration(aListener));
  }
}

void MessageDatabase::AddFolderMessageListener(PerFolderDatabase* listener) {
  if (listener) {
    PruneExpiredFolderListeners();
    mMessageListeners.AppendElement(new ListenerRegistration(listener));
  }
}

void MessageDatabase::PruneExpiredFolderListeners() {
  for (size_t i = mMessageListeners.Length(); i; --i) {
    if (mMessageListeners[i - 1]->Expired()) {
      mMessageListeners.RemoveElementAt(i - 1);
    }
  }
}

NS_IMETHODIMP_(void)
MessageDatabase::RemoveMessageListener(MessageListener* aListener) {
  for (size_t i = 0; i < mMessageListeners.Length(); ++i) {
    if (mMessageListeners[i]->identity == aListener) {
      mMessageListeners.RemoveElementAt(i);
      break;
    }
  }
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
  MOZ_TRY(RequireCurrentOwner());
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

namespace {

nsresult ChangeHeader(const CapturedMessage& captured,
                      RefPtr<DetachedMsgHdr>& output) {
  RefPtr<DetachedMsgHdr> header =
      new (fallible) DetachedMsgHdr(captured.folderId);
  NS_ENSURE_TRUE(header, NS_ERROR_OUT_OF_MEMORY);
  MOZ_TRY(header->SetMessageId(captured.messageId));
  MOZ_TRY(header->SetAuthor(captured.sender));
  MOZ_TRY(header->SetRecipients(captured.recipients));
  MOZ_TRY(header->SetSubject(captured.subject));
  MOZ_TRY(header->SetFlags(captured.flags));
  MOZ_TRY(header->SetStringProperty("keywords", captured.tags));
  MOZ_TRY(header->SetDate(captured.date));
  MOZ_TRY(header->SetThreadId(captured.threadId));
  output = std::move(header);
  return NS_OK;
}

nsresult RollbackMessageChange(mozIStorageConnection* connection,
                               nsresult original) {
  bool active;
  nsresult cleanup = connection->GetTransactionInProgress(&active);
  if (NS_SUCCEEDED(cleanup) && active) {
    cleanup = connection->RollbackTransaction();
  }
  if (NS_FAILED(cleanup)) {
    MOZ_LOG(gPanoramaLog, LogLevel::Error,
            ("Message change rollback failed: 0x%08x", uint32_t(cleanup)));
  }
  return original;
}

}  // namespace

nsresult MessageDatabase::SetMessageFlags(nsMsgKey key, uint32_t newFlags) {
  MOZ_TRY(RequireCommittedSearchRead());
  bool staged;
  MOZ_TRY(IsMessageStaged(key, staged));
  if (staged) {
    nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
    MOZ_TRY(connection->BeginTransaction());
    nsresult rv = [&]() -> nsresult {
      CachedMsg previous;
      MOZ_TRY(FetchMsg(key, previous));
      if (previous.flags == newFlags) {
        return connection->CommitTransaction();
      }
      {
        nsCOMPtr<mozIStorageStatement> stmt;
        MOZ_TRY(GetHeaderStatement(
            key, "SetMessageFlags"_ns, HeaderTable::Messages, "UPDATE "_ns,
            " SET flags=:flags WHERE id=:id"_ns, getter_AddRefs(stmt)));
        mozStorageStatementScoper scope(stmt);
        MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
        MOZ_TRY(stmt->BindInt64ByName("flags"_ns, newFlags));
        MOZ_TRY(stmt->Execute());
      }
      return connection->CommitTransaction();
    }();
    if (NS_FAILED(rv)) {
      return RollbackMessageChange(connection, rv);
    }
    auto entry = mMsgCache.lookup(key);
    if (entry) {
      entry->value().flags = newFlags;
    }
    return NS_OK;
  }
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  UniquePtr<QueuedMessageBatch> notification;
  MOZ_TRY(PrepareMessageBatch(notification));
  notification->kind = QueuedMessageBatch::Kind::Flags;
  bool changed = false;
  nsTArray<UniquePtr<PreparedNewsReadSet>> newsPrepared;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    MOZ_TRY(CaptureMessage(key, notification->before));
    if (notification->before.flags == newFlags) {
      return connection->CommitTransaction();
    }
    RefPtr<DetachedMsgHdr> old;
    MOZ_TRY(ChangeHeader(notification->before, old));
    notification->oldHeader = old;
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(GetHeaderStatement(
          key, "SetMessageFlags"_ns, HeaderTable::Messages, "UPDATE "_ns,
          " SET flags=:flags WHERE id=:id"_ns, getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
      MOZ_TRY(stmt->BindInt64ByName("flags"_ns, newFlags));
      MOZ_TRY(stmt->Execute());
    }
    MOZ_TRY(CaptureMessage(key, notification->after));
    notification->live = new (fallible) Message(key);
    NS_ENSURE_TRUE(notification->live, NS_ERROR_OUT_OF_MEMORY);
    if ((notification->before.flags ^ newFlags) & nsMsgMessageFlags::Read) {
      nsTArray<CapturedMessage> rows;
      NS_ENSURE_TRUE(rows.AppendElement(notification->after, fallible),
                     NS_ERROR_OUT_OF_MEMORY);
      MOZ_TRY(PrepareNewsReadChanges(rows, newsPrepared));
      MOZ_TRY(WriteNewsReadSets(newsPrepared));
    }
    changed = true;
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    return RollbackMessageChange(connection, rv);
  }
  if (!changed) {
    return NS_OK;
  }
  auto entry = mMsgCache.lookup(key);
  if (entry) {
    entry->value().flags = notification->after.flags;
  }
  InstallNewsReadSets(newsPrepared);
  QueueMessageBatch(std::move(notification));
  return NS_OK;
}

nsresult MessageDatabase::SetMessageFlag(nsMsgKey key, uint32_t flag,
                                         bool value) {
  MOZ_TRY(RequireCommittedSearchRead());
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
  MOZ_TRY(RequireCommittedSearchRead());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      nsresult statementRv = GetHeaderStatement(
          key, "SetMessagePriority"_ns, HeaderTable::Messages, "UPDATE "_ns,
          " SET priority = :priority WHERE id = :id"_ns, getter_AddRefs(stmt));
      NS_ENSURE_SUCCESS(statementRv, statementRv);
      mozStorageStatementScoper scoper(stmt);

      MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
      MOZ_TRY(stmt->BindInt32ByName("priority"_ns, priority));
      statementRv = stmt->Execute();
      NS_ENSURE_SUCCESS(statementRv, statementRv);
    }
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    return RollbackMessageChange(connection, rv);
  }

  // Install hot state only after the owned transaction commits.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().priority = priority;
  }

  // TODO: notifications.
  return NS_OK;
}

nsresult MessageDatabase::SetMessageOfflineMessageSize(nsMsgKey key,
                                                       uint64_t size) {
  NS_ENSURE_TRUE(size <= UINT32_MAX, NS_ERROR_ILLEGAL_VALUE);
  return SetMessageProperty(key, "offlineMessageSize"_ns,
                            static_cast<uint32_t>(size));
}

nsresult MessageDatabase::SetMessageDate(nsMsgKey key, PRTime date) {
  MOZ_TRY(RequireCommittedSearchRead());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      nsresult statementRv = GetHeaderStatement(
          key, "SetMessageDate"_ns, HeaderTable::Messages, "UPDATE "_ns,
          " SET date = :date WHERE id = :id"_ns, getter_AddRefs(stmt));
      NS_ENSURE_SUCCESS(statementRv, statementRv);
      mozStorageStatementScoper scoper(stmt);

      MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
      MOZ_TRY(stmt->BindInt64ByName("date"_ns, (int64_t)date));
      statementRv = stmt->Execute();
      NS_ENSURE_SUCCESS(statementRv, statementRv);
    }
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    return RollbackMessageChange(connection, rv);
  }

  // Install hot state only after the owned transaction commits.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().date = date;
  }

  // TODO: notifications.
  return NS_OK;
}

nsresult MessageDatabase::SetMessageSize(nsMsgKey key, uint64_t size) {
  NS_ENSURE_TRUE(size <= UINT32_MAX, NS_ERROR_ILLEGAL_VALUE);
  return SetMessageProperty(key, "messageSize"_ns, static_cast<uint32_t>(size));
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
  MOZ_TRY(RequireCommittedSearchRead());
  nsCString cachedValue;
  if (!cachedValue.Assign(messageId, fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      nsresult statementRv = GetHeaderStatement(
          key, "SetMessageMessageId"_ns, HeaderTable::Messages, "UPDATE "_ns,
          " SET messageId = :messageId WHERE id = :id"_ns,
          getter_AddRefs(stmt));
      NS_ENSURE_SUCCESS(statementRv, statementRv);
      mozStorageStatementScoper scoper(stmt);

      MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
      MOZ_TRY(stmt->BindUTF8StringByName("messageId"_ns, messageId));
      statementRv = stmt->Execute();
      NS_ENSURE_SUCCESS(statementRv, statementRv);
    }
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    return RollbackMessageChange(connection, rv);
  }

  // Install hot state only after the owned transaction commits.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().messageId = std::move(cachedValue);
  }

  // TODO: notifications.
  return NS_OK;
}

nsresult MessageDatabase::SetMessageCcList(nsMsgKey key,
                                           const nsACString& ccList) {
  MOZ_TRY(RequireCommittedSearchRead());
  nsCString cachedValue;
  if (!cachedValue.Assign(ccList, fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      nsresult statementRv = GetHeaderStatement(
          key, "SetMessageCcList"_ns, HeaderTable::Messages, "UPDATE "_ns,
          " SET ccList = :ccList WHERE id = :id"_ns, getter_AddRefs(stmt));
      NS_ENSURE_SUCCESS(statementRv, statementRv);
      mozStorageStatementScoper scoper(stmt);

      MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
      MOZ_TRY(stmt->BindUTF8StringByName("ccList"_ns, ccList));
      statementRv = stmt->Execute();
      NS_ENSURE_SUCCESS(statementRv, statementRv);
    }
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    return RollbackMessageChange(connection, rv);
  }

  // Install hot state only after the owned transaction commits.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().ccList = std::move(cachedValue);
  }

  // TODO: notifications.
  return NS_OK;
}

nsresult MessageDatabase::SetMessageBccList(nsMsgKey key,
                                            const nsACString& bccList) {
  MOZ_TRY(RequireCommittedSearchRead());
  nsCString cachedValue;
  if (!cachedValue.Assign(bccList, fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      nsresult statementRv = GetHeaderStatement(
          key, "SetMessageBccList"_ns, HeaderTable::Messages, "UPDATE "_ns,
          " SET bccList = :bccList WHERE id = :id"_ns, getter_AddRefs(stmt));
      NS_ENSURE_SUCCESS(statementRv, statementRv);
      mozStorageStatementScoper scoper(stmt);

      MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
      MOZ_TRY(stmt->BindUTF8StringByName("bccList"_ns, bccList));
      statementRv = stmt->Execute();
      NS_ENSURE_SUCCESS(statementRv, statementRv);
    }
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    return RollbackMessageChange(connection, rv);
  }

  // Install hot state only after the owned transaction commits.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().bccList = std::move(cachedValue);
  }

  // TODO: notifications.
  return NS_OK;
}

nsresult MessageDatabase::SetMessageSender(nsMsgKey key,
                                           const nsACString& sender) {
  MOZ_TRY(RequireCommittedSearchRead());
  nsCString cachedValue;
  if (!cachedValue.Assign(sender, fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      nsresult statementRv = GetHeaderStatement(
          key, "SetMessageSender"_ns, HeaderTable::Messages, "UPDATE "_ns,
          " SET sender = :sender WHERE id = :id"_ns, getter_AddRefs(stmt));
      NS_ENSURE_SUCCESS(statementRv, statementRv);
      mozStorageStatementScoper scoper(stmt);

      MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
      MOZ_TRY(stmt->BindUTF8StringByName("sender"_ns, sender));
      statementRv = stmt->Execute();
      NS_ENSURE_SUCCESS(statementRv, statementRv);
    }
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    return RollbackMessageChange(connection, rv);
  }

  // Install hot state only after the owned transaction commits.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().sender = std::move(cachedValue);
  }

  // TODO: notifications.
  return NS_OK;
}

nsresult MessageDatabase::SetMessageSubject(nsMsgKey key,
                                            const nsACString& subject) {
  MOZ_TRY(RequireCommittedSearchRead());
  nsCString cachedValue;
  if (!cachedValue.Assign(subject, fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      nsresult statementRv = GetHeaderStatement(
          key, "SetMessageSubject"_ns, HeaderTable::Messages, "UPDATE "_ns,
          " SET subject = :subject WHERE id = :id"_ns, getter_AddRefs(stmt));
      NS_ENSURE_SUCCESS(statementRv, statementRv);
      mozStorageStatementScoper scoper(stmt);

      MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
      MOZ_TRY(stmt->BindUTF8StringByName("subject"_ns, subject));
      statementRv = stmt->Execute();
      NS_ENSURE_SUCCESS(statementRv, statementRv);
    }
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    return RollbackMessageChange(connection, rv);
  }

  // Install hot state only after the owned transaction commits.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().subject = std::move(cachedValue);
  }

  // TODO: notifications.
  return NS_OK;
}

nsresult MessageDatabase::SetMessageRecipients(nsMsgKey key,
                                               const nsACString& recipients) {
  MOZ_TRY(RequireCommittedSearchRead());
  nsCString cachedValue;
  if (!cachedValue.Assign(recipients, fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      nsresult statementRv = GetHeaderStatement(
          key, "SetMessageRecipients"_ns, HeaderTable::Messages, "UPDATE "_ns,
          " SET recipients = :recipients WHERE id = :id"_ns,
          getter_AddRefs(stmt));
      NS_ENSURE_SUCCESS(statementRv, statementRv);
      mozStorageStatementScoper scoper(stmt);

      MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
      MOZ_TRY(stmt->BindUTF8StringByName("recipients"_ns, recipients));
      statementRv = stmt->Execute();
      NS_ENSURE_SUCCESS(statementRv, statementRv);
    }
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    return RollbackMessageChange(connection, rv);
  }

  // Install hot state only after the owned transaction commits.
  auto p = mMsgCache.lookup(key);
  if (p) {
    p->value().recipients = std::move(cachedValue);
  }

  // TODO: notifications.
  return NS_OK;
}

nsresult MessageDatabase::SetMessageTags(nsMsgKey key, nsACString const& tags) {
  MOZ_LOG(gPanoramaLog, LogLevel::Debug, ("Message tags key=%u", key));
  MOZ_TRY(RequireCommittedSearchRead());
  bool staged;
  MOZ_TRY(IsMessageStaged(key, staged));
  nsAutoCString cachedTags;
  if (!cachedTags.Assign(tags, fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  if (staged) {
    nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
    MOZ_TRY(connection->BeginTransaction());
    nsresult rv = [&]() -> nsresult {
      CachedMsg previous;
      MOZ_TRY(FetchMsg(key, previous));
      if (previous.tags == tags) {
        return connection->CommitTransaction();
      }
      {
        nsCOMPtr<mozIStorageStatement> stmt;
        MOZ_TRY(GetHeaderStatement(
            key, "SetMessageTags"_ns, HeaderTable::Messages, "UPDATE "_ns,
            " SET tags=:tags WHERE id=:id"_ns, getter_AddRefs(stmt)));
        mozStorageStatementScoper scope(stmt);
        MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
        MOZ_TRY(stmt->BindUTF8StringByName("tags"_ns, tags));
        MOZ_TRY(stmt->Execute());
      }
      return connection->CommitTransaction();
    }();
    if (NS_FAILED(rv)) {
      return RollbackMessageChange(connection, rv);
    }
    auto entry = mMsgCache.lookup(key);
    if (entry) {
      entry->value().tags = std::move(cachedTags);
    }
    return NS_OK;
  }
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  UniquePtr<QueuedMessageBatch> notification;
  MOZ_TRY(PrepareMessageBatch(notification));
  notification->kind = QueuedMessageBatch::Kind::Tags;
  bool changed = false;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    MOZ_TRY(CaptureMessage(key, notification->before));
    if (notification->before.tags == tags) {
      return connection->CommitTransaction();
    }
    RefPtr<DetachedMsgHdr> old;
    MOZ_TRY(ChangeHeader(notification->before, old));
    notification->oldHeader = old;
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(GetHeaderStatement(
          key, "SetMessageTags"_ns, HeaderTable::Messages, "UPDATE "_ns,
          " SET tags=:tags WHERE id=:id"_ns, getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
      MOZ_TRY(stmt->BindUTF8StringByName("tags"_ns, tags));
      MOZ_TRY(stmt->Execute());
    }
    MOZ_TRY(CaptureMessage(key, notification->after));
    if (!cachedTags.Assign(notification->after.tags, fallible)) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
    notification->live = new (fallible) Message(key);
    NS_ENSURE_TRUE(notification->live, NS_ERROR_OUT_OF_MEMORY);
    changed = true;
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    return RollbackMessageChange(connection, rv);
  }
  if (!changed) {
    return NS_OK;
  }
  auto entry = mMsgCache.lookup(key);
  if (entry) {
    entry->value().tags = std::move(cachedTags);
  }
  QueueMessageBatch(std::move(notification));
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

nsresult MessageDatabase::CaptureHeaderState(nsMsgKey key,
                                             Maybe<CapturedMessage>& output) {
  NS_ENSURE_TRUE(DatabaseCore::sInstance && DatabaseCore::sConnection &&
                     DatabaseCore::sInstance->mMessageDatabase.get() == this,
                 NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(key && key < nsMsgKey_None, NS_ERROR_INVALID_ARG);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "CaptureHeaderState"_ns,
      "SELECT folderId,messageId,date,sender,recipients,subject,flags,tags,"
      "threadId,threadParent FROM messages WHERE id=:id UNION ALL "
      "SELECT folderId,messageId,date,sender,recipients,subject,flags,tags,"
      "threadId,threadParent FROM staged_messages WHERE id=:id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  if (!more) {
    output.reset();
    return NS_OK;
  }
  CapturedMessage row;
  row.id = key;
  int64_t value;
  MOZ_TRY(stmt->GetInt64(0, &value));
  NS_ENSURE_TRUE(value >= 0, NS_ERROR_FILE_CORRUPTED);
  row.folderId = value;
  MOZ_TRY(stmt->GetUTF8String(1, row.messageId));
  MOZ_TRY(stmt->GetInt64(2, &value));
  row.date = static_cast<PRTime>(value);
  MOZ_TRY(stmt->GetUTF8String(3, row.sender));
  MOZ_TRY(stmt->GetUTF8String(4, row.recipients));
  MOZ_TRY(stmt->GetUTF8String(5, row.subject));
  MOZ_TRY(stmt->GetInt64(6, &value));
  NS_ENSURE_TRUE(value >= INT32_MIN && value <= int64_t(UINT32_MAX),
                 NS_ERROR_FILE_CORRUPTED);
  row.flags = static_cast<uint32_t>(value);
  MOZ_TRY(stmt->GetUTF8String(7, row.tags));
  MOZ_TRY(stmt->GetInt64(8, &value));
  NS_ENSURE_TRUE(value >= 0 && value < nsMsgKey_None, NS_ERROR_FILE_CORRUPTED);
  row.threadId = static_cast<nsMsgKey>(value);
  MOZ_TRY(stmt->GetInt64(9, &value));
  NS_ENSURE_TRUE(value >= 0 && value <= nsMsgKey_None, NS_ERROR_FILE_CORRUPTED);
  row.threadParent = static_cast<nsMsgKey>(value);
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  output = Some(std::move(row));
  return NS_OK;
}

PreparedThreadBatch::PreparedThreadBatch() = default;
PreparedThreadBatch::~PreparedThreadBatch() = default;
PreparedThreadBatch::PreparedThreadBatch(PreparedThreadBatch&&) = default;
PreparedThreadBatch& PreparedThreadBatch::operator=(PreparedThreadBatch&&) =
    default;

nsresult MessageDatabase::PlanConversationInsertion(
    nsMsgKey key, bool notifyLegacy, MessageThreadBatch& output) {
  NS_ENSURE_TRUE(DatabaseCore::sInstance && DatabaseCore::sConnection &&
                     DatabaseCore::sInstance->mMessageDatabase.get() == this,
                 NS_ERROR_NOT_AVAILABLE);
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_TRUE(active, NS_ERROR_NOT_AVAILABLE);

  nsTArray<ConversationMember> members;
  MOZ_TRY(DiscoverConversationComponent(key, members));
  MessageThreadBatch batch;
  batch.publicationKey = key;
  batch.notifyLegacy = notifyLegacy;
  if (!batch.after.SetLength(members.Length(), fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  nsTArray<nsTArray<nsCString>> references;
  nsTArray<Maybe<uint32_t>> parents;
  if (!references.SetLength(members.Length(), fallible) ||
      !parents.SetLength(members.Length(), fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  Maybe<uint32_t> publication;
  for (uint32_t i = 0; i < members.Length(); ++i) {
    MOZ_TRY(CaptureMessage(members[i].id, batch.after[i]));
    NS_ENSURE_TRUE(batch.after[i].folderId == members[i].folderId,
                   NS_ERROR_FILE_CORRUPTED);
    MOZ_TRY(GetMessageReferences(members[i].id, references[i]));
    if (members[i].id == key) {
      publication = Some(i);
    }
  }
  NS_ENSURE_TRUE(publication, NS_ERROR_UNEXPECTED);
  MOZ_TRY(CopyThreadCaptures(batch.after, batch.before));
  batch.before.RemoveElementAt(*publication);

  // Discovery and captures are key-ordered. Resolve nearest stored tokens
  // first, breaking physical-copy ties by key without closing a parent cycle.
  for (uint32_t i = 0; i < members.Length(); ++i) {
    for (uint32_t ordinal = references[i].Length(); ordinal && !parents[i];) {
      const auto& token = references[i][--ordinal];
      if (token.IsEmpty()) {
        continue;
      }
      for (uint32_t candidate = 0; candidate < members.Length(); ++candidate) {
        if (candidate == i || !batch.after[candidate].messageId.Equals(token)) {
          continue;
        }
        uint32_t ancestor = candidate;
        while (ancestor != i && parents[ancestor]) {
          ancestor = *parents[ancestor];
        }
        if (ancestor != i) {
          parents[i] = Some(candidate);
          break;
        }
      }
    }
  }
  Maybe<nsMsgKey> root;
  for (uint32_t i = 0; i < members.Length(); ++i) {
    if (!parents[i]) {
      root = Some(members[i].id);
      break;
    }
  }
  NS_ENSURE_TRUE(root, NS_ERROR_FILE_CORRUPTED);
  for (uint32_t i = 0; i < members.Length(); ++i) {
    auto& after = batch.after[i];
    nsMsgKey parent = parents[i] ? members[*parents[i]].id : 0;
    if (after.id != key &&
        (after.threadId != *root || after.threadParent != parent) &&
        !batch.changedKeys.AppendElement(after.id, fallible)) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
    after.threadId = *root;
    after.threadParent = parent;
  }
  NS_ENSURE_TRUE(ValidThreadBatch(batch), NS_ERROR_FILE_CORRUPTED);
  output = std::move(batch);
  return NS_OK;
}

nsresult MessageDatabase::ReadThreadWord(uint64_t folder, nsMsgKey thread,
                                         uint32_t& flags, bool& present) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ReadGroupingThreadWord"_ns,
      "SELECT flags FROM thread_flags WHERE folderId=:folder AND threadId=:thread"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folder));
  MOZ_TRY(stmt->BindInt64ByName("thread"_ns, thread));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  uint32_t word = 0;
  bool found = more;
  if (more) {
    int32_t type;
    int64_t value;
    MOZ_TRY(stmt->GetTypeOfIndex(0, &type));
    NS_ENSURE_TRUE(type == mozIStorageValueArray::VALUE_TYPE_INTEGER,
                   NS_ERROR_FILE_CORRUPTED);
    MOZ_TRY(stmt->GetInt64(0, &value));
    NS_ENSURE_TRUE(value >= 0 && uint64_t(value) <= UINT32_MAX,
                   NS_ERROR_FILE_CORRUPTED);
    word = static_cast<uint32_t>(value);
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  }
  flags = word;
  present = found;
  return NS_OK;
}

nsresult MessageDatabase::PrepareThreadWordRemap(
    const MessageThreadBatch& batch, nsTArray<ThreadWordRemap>& output) {
  bool available;
  MOZ_TRY(
      DatabaseCore::sConnection->TableExists("thread_flags"_ns, &available));
  nsTArray<ThreadWordRemap> remaps;
  if (!available) {
    output.Clear();
    return NS_OK;
  }
  for (const auto& before : batch.before) {
    const auto* after = FindThreadCapture(batch.after, before.id);
    NS_ENSURE_TRUE(after && after->folderId == before.folderId &&
                       before.threadId && before.threadId < nsMsgKey_None,
                   NS_ERROR_FILE_CORRUPTED);
    size_t index = 0;
    while (index < remaps.Length() &&
           remaps[index].folderId != before.folderId) {
      ++index;
    }
    if (index == remaps.Length()) {
      auto* remap = remaps.AppendElement(fallible);
      NS_ENSURE_TRUE(remap, NS_ERROR_OUT_OF_MEMORY);
      remap->folderId = before.folderId;
      remap->threadId = after->threadId;
    }
    auto& remap = remaps[index];
    NS_ENSURE_TRUE(remap.threadId == after->threadId, NS_ERROR_FILE_CORRUPTED);
    if (!remap.oldThreads.Contains(before.threadId) &&
        !remap.oldThreads.AppendElement(before.threadId, fallible)) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
  }
  for (auto& remap : remaps) {
    if (remap.oldThreads.Length() == 1 &&
        remap.oldThreads[0] == remap.threadId) {
      continue;
    }
    Maybe<uint32_t> common;
    auto collect = [&](nsMsgKey thread) -> nsresult {
      uint32_t word;
      bool present;
      MOZ_TRY(ReadThreadWord(remap.folderId, thread, word, present));
      NS_ENSURE_TRUE(!common || *common == word, NS_ERROR_NOT_AVAILABLE);
      common = Some(word);
      remap.present |= present;
      return NS_OK;
    };
    for (nsMsgKey oldThread : remap.oldThreads) {
      MOZ_TRY(collect(oldThread));
    }
    if (!remap.oldThreads.Contains(remap.threadId)) {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "GroupingDestinationScope"_ns,
          "SELECT EXISTS(SELECT 1 FROM messages WHERE folderId=:folder "
          "AND threadId=:thread AND id<>:publication), "
          "EXISTS(SELECT 1 FROM thread_flags WHERE folderId=:folder AND threadId=:thread)"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("folder"_ns, remap.folderId));
      MOZ_TRY(stmt->BindInt64ByName("thread"_ns, remap.threadId));
      MOZ_TRY(stmt->BindInt64ByName("publication"_ns, batch.publicationKey));
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
      int32_t members, stored;
      MOZ_TRY(stmt->GetInt32(0, &members));
      MOZ_TRY(stmt->GetInt32(1, &stored));
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
      // A new publication contributes no competing implicit zero word.
      if (members || stored) {
        MOZ_TRY(collect(remap.threadId));
      }
    }
    NS_ENSURE_TRUE(common, NS_ERROR_FILE_CORRUPTED);
    remap.flags = *common;
  }
  output = std::move(remaps);
  return NS_OK;
}

nsresult MessageDatabase::ApplyThreadWordRemap(
    const nsTArray<ThreadWordRemap>& remaps) {
  for (const auto& remap : remaps) {
    if (remap.oldThreads.Length() == 1 &&
        remap.oldThreads[0] == remap.threadId) {
      continue;
    }
    if (remap.present) {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "RemapGroupingThreadWord"_ns,
          "INSERT INTO thread_flags(folderId,threadId,flags) "
          "SELECT :folder,:thread,:flags WHERE EXISTS(SELECT 1 FROM messages "
          "WHERE folderId=:folder AND threadId=:thread) "
          "ON CONFLICT(folderId,threadId) DO UPDATE SET flags=excluded.flags RETURNING folderId"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("folder"_ns, remap.folderId));
      MOZ_TRY(stmt->BindInt64ByName("thread"_ns, remap.threadId));
      MOZ_TRY(stmt->BindInt64ByName("flags"_ns, remap.flags));
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
      int64_t folder;
      MOZ_TRY(stmt->GetInt64(0, &folder));
      NS_ENSURE_TRUE(uint64_t(folder) == remap.folderId,
                     NS_ERROR_FILE_CORRUPTED);
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
    }
    for (nsMsgKey oldThread : remap.oldThreads) {
      if (oldThread == remap.threadId) {
        continue;
      }
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "RetireGroupingThreadWord"_ns,
          "DELETE FROM thread_flags WHERE folderId=:folder AND "
          "threadId=:thread "
          "AND NOT EXISTS(SELECT 1 FROM messages WHERE folderId=:folder AND threadId=:thread)"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("folder"_ns, remap.folderId));
      MOZ_TRY(stmt->BindInt64ByName("thread"_ns, oldThread));
      MOZ_TRY(stmt->Execute());
    }
  }
  return NS_OK;
}

nsresult MessageDatabase::PrepareConversationBatch(
    nsMsgKey key, bool notifyLegacy, QueuedMessageBatch& notification,
    MessageThreadBatch& captured, bool consumeProtoThreadFlags) {
  CapturedMessage publicationBefore;
  MOZ_TRY(CaptureMessage(key, publicationBefore));
  MOZ_TRY(PlanConversationInsertion(key, notifyLegacy, captured));
  captured.batchId = notification.id;
  nsTArray<ThreadWordRemap> remaps;
  MOZ_TRY(PrepareThreadWordRemap(captured, remaps));
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ApplyConversationThread"_ns,
      "UPDATE messages SET threadId=:thread,threadParent=:parent "
      "WHERE id=:id AND folderId=:folder RETURNING id"_ns,
      getter_AddRefs(stmt)));
  for (const auto& row : captured.after) {
    if (row.id == key) {
      if (row.threadId == publicationBefore.threadId &&
          row.threadParent == publicationBefore.threadParent) {
        continue;
      }
    } else if (!captured.changedKeys.Contains(row.id)) {
      continue;
    }
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, row.id));
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, row.folderId));
    MOZ_TRY(stmt->BindInt64ByName("thread"_ns, row.threadId));
    MOZ_TRY(stmt->BindInt64ByName("parent"_ns, row.threadParent));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
    int64_t confirmed;
    MOZ_TRY(stmt->GetInt64(0, &confirmed));
    NS_ENSURE_TRUE(confirmed == row.id, NS_ERROR_FILE_CORRUPTED);
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  }
  MOZ_TRY(ApplyThreadWordRemap(remaps));
  if (consumeProtoThreadFlags) {
    const auto* publication = FindThreadCapture(captured.after, key);
    NS_ENSURE_TRUE(publication, NS_ERROR_FILE_CORRUPTED);
    MOZ_TRY(ConsumeProtoThreadFlagsInTransaction(key, publication->folderId,
                                                 publication->threadId));
  }
  notification.kind = QueuedMessageBatch::Kind::Thread;
  for (auto& delivery : notification.deliveries) {
    auto* listener = delivery.listener.get();
    NS_ENSURE_TRUE(
        captured.changedKeys.IsEmpty() || listener->SupportsThreadChanges(),
        NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(listener->PrepareThreadBatch(
        captured, delivery.beforeViewData.get(), delivery.prepared));
  }
  return NS_OK;
}

void MessageDatabase::InstallThreadCache(const MessageThreadBatch& batch) {
  for (const auto& row : batch.after) {
    if (row.id != batch.publicationKey && batch.changedKeys.Contains(row.id)) {
      auto entry = mMsgCache.lookup(row.id);
      if (entry) {
        entry->value().threadId = row.threadId;
        entry->value().threadParent = row.threadParent;
      }
    }
  }
}

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

NS_IMETHODIMP
MessageDatabase::GetConversationMessageKeys(nsMsgKey key,
                                            nsTArray<nsMsgKey>& output) {
  NS_ENSURE_ARG(key && key != nsMsgKey_None);
  MOZ_TRY(RequireCommittedSearchRead());
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "ReadConversationMessageKeys"_ns,
      "WITH RECURSIVE availability(seedExists,unknownHistory) AS ("
      "SELECT EXISTS(SELECT 1 FROM messages WHERE id=:id), "
      "EXISTS(SELECT 1 FROM messages m LEFT JOIN message_reference_sets s "
      "ON s.id=m.id WHERE s.id IS NULL)), "
      // Physical rows, raw tokens and stored components are distinct vertices.
      // An own-ID token is reachable only when a real row references it, so
      // equal own IDs alone do not connect otherwise independent copies.
      "walk(kind,id,token) AS ("
      "SELECT 0,id,'' FROM messages WHERE id=:id "
      "UNION SELECT 1,0,r.token FROM walk w "
      "JOIN message_references r ON w.kind=0 AND r.id=w.id "
      "WHERE r.token<>'' "
      "UNION SELECT 1,0,m.messageId FROM walk w "
      "JOIN messages m ON w.kind=0 AND m.id=w.id "
      "WHERE m.messageId<>'' AND EXISTS(SELECT 1 FROM message_references r "
      "JOIN messages owner ON owner.id=r.id "
      "WHERE r.token=m.messageId COLLATE BINARY AND r.token<>'') "
      "UNION SELECT 0,m.id,'' FROM walk w "
      "JOIN messages m ON w.kind=1 AND m.messageId=w.token COLLATE BINARY "
      "UNION SELECT 0,m.id,'' FROM walk w "
      "JOIN message_references r ON w.kind=1 AND r.token=w.token COLLATE "
      "BINARY "
      "JOIN messages m ON m.id=r.id "
      "UNION SELECT 2,m.threadId,'' FROM walk w "
      "JOIN messages m ON w.kind=0 AND m.id=w.id WHERE m.threadId<>0 "
      "UNION SELECT 0,m.id,'' FROM walk w "
      "JOIN messages m ON w.kind=2 AND m.threadId=w.id) "
      "SELECT a.seedExists,a.unknownHistory,m.id,m.folderId,f.id,m.threadId "
      "FROM availability a LEFT JOIN walk w "
      "ON a.seedExists AND NOT a.unknownHistory AND w.kind=0 "
      "LEFT JOIN messages m ON m.id=w.id "
      "LEFT JOIN folders f ON f.id=m.folderId ORDER BY m.id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scope(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_UNEXPECTED);
  int32_t exists, unavailable;
  MOZ_TRY(stmt->GetInt32(0, &exists));
  MOZ_TRY(stmt->GetInt32(1, &unavailable));
  NS_ENSURE_TRUE(exists && !unavailable, NS_ERROR_NOT_AVAILABLE);
  nsTArray<nsMsgKey> found;
  do {
    int64_t id, folderId, threadId;
    MOZ_TRY(stmt->GetInt64(2, &id));
    MOZ_TRY(stmt->GetInt64(3, &folderId));
    MOZ_TRY(stmt->GetInt64(5, &threadId));
    NS_ENSURE_TRUE(id > 0 && id < int64_t(nsMsgKey_None) && folderId > 0 &&
                       threadId >= 0 && threadId < int64_t(nsMsgKey_None),
                   NS_ERROR_FILE_CORRUPTED);
    bool missingFolder;
    MOZ_TRY(stmt->GetIsNull(4, &missingFolder));
    // Do not advertise a partial component by silently dropping retired rows.
    NS_ENSURE_FALSE(missingFolder, NS_ERROR_NOT_AVAILABLE);
    if (!found.AppendElement(static_cast<nsMsgKey>(id), fallible)) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
    MOZ_TRY(stmt->ExecuteStep(&more));
  } while (more);
  output.SwapElements(found);
  return NS_OK;
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
