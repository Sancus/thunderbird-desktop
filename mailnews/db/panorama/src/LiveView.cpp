/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "LiveView.h"

#include <cmath>
#include <initializer_list>
#include <utility>

#include "DatabaseCore.h"
#include "DetachedMsgHdr.h"
#include "PerFolderDatabase.h"
#include "js/Array.h"
#include "js/CallAndConstruct.h"
#include "js/Date.h"
#include "js/Exception.h"
#include "js/GlobalObject.h"
#include "js/PropertyDescriptor.h"
#include "js/Proxy.h"
#include "js/Wrapper.h"
#include "jsapi.h"
#include "mozIStorageError.h"
#include "mozIStorageResultSet.h"
#include "mozIStorageRow.h"
#include "mozIStorageStatementCallback.h"
#include "mozStorageHelper.h"
#include "mozilla/Components.h"
#include "mozilla/Logging.h"
#include "mozilla/ProfilerMarkers.h"
#include "mozilla/RefPtr.h"
#include "mozilla/StaticPrefs_mail.h"
#include "mozilla/Try.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/fallible.h"
#include "nsIXPConnect.h"
#include "nsMsgFolderFlags.h"
#include "nsServiceManagerUtils.h"
#include "nsTHashMap.h"
#include "prtime.h"
#include "xpcpublic.h"

using JS::ConstUTF8CharsZ;
using JS::Heap;
using JS::MutableHandle;
using JS::NewArrayObject;
using JS::NewDateObject;
using JS::ObjectValue;
using JS::Rooted;
using JS::TimeClip;
using JS::Value;
using mozilla::LazyLogModule;
using mozilla::LogLevel;
using mozilla::dom::AutoJSAPI;
using mozilla::dom::Promise;
using xpc::CurrentNativeGlobal;
using xpc::IsInAutomation;
using xpc::PrivilegedJunkScope;

namespace mozilla::mailnews {

// Own data properties are inspected only while attaching the listener.
class LiveViewBatchCapability final {
 public:
  NS_INLINE_DECL_REFCOUNTING(LiveViewBatchCapability)
  LiveViewBatchCapability(JSContext* cx, JS::Handle<JSObject*> receiver,
                          JS::Handle<JSObject*> owner,
                          JS::Handle<JS::Value> invalidate, uint64_t generation)
      : object(cx, receiver),
        owner(cx, owner),
        invalidator(cx, invalidate),
        generation(generation) {}
  JS::PersistentRooted<JSObject*> object;
  JS::PersistentRooted<JSObject*> owner;
  JS::PersistentRooted<JS::Value> invalidator;
  const uint64_t generation;

 private:
  ~LiveViewBatchCapability() = default;
};

class CapturedLiveView final : public nsISupports {
 public:
  NS_DECL_ISUPPORTS
  struct Root {
    CapturedMessage message;
    nsCString group;
    nsTArray<CapturedMessage> members;
    nsTArray<nsCString> originalGroups;
  };
  nsCOMPtr<nsILiveViewListener> listener;
  RefPtr<LiveViewBatchCapability> capability;
  uint64_t attachment = 0, query = 0, configuration = 0;
  nsTArray<Root> roots;
  nsCString selectSQL, groupSQL;
  nsTArray<RefPtr<nsIVariant>> params;
  uint32_t grouping = nsILiveView::UNTHREADED, sortColumn = nsILiveView::DATE;
  bool descending = true;
  uint64_t viewGeneration = 0;
  RefPtr<CapturedLiveView> display, original;

 private:
  ~CapturedLiveView() = default;
};
NS_IMPL_ISUPPORTS(CapturedLiveView, nsISupports)

class PreparedLiveViewThreadBatch final : public nsISupports {
 public:
  NS_DECL_ISUPPORTS
  explicit PreparedLiveViewThreadBatch(JSContext* cx) : value(cx) {}
  nsCOMPtr<nsILiveViewListener> listener;
  RefPtr<LiveViewBatchCapability> capability;
  uint64_t attachment = 0, query = 0, configuration = 0, delivery = 0;
  nsCOMPtr<CapturedLiveView> before;
  bool hasPayload = false;
  JS::PersistentRooted<JS::Value> value;

 private:
  ~PreparedLiveViewThreadBatch() = default;
};
NS_IMPL_ISUPPORTS(PreparedLiveViewThreadBatch, nsISupports)

// This consumes only the existing public per-folder status notifications. It
// does not own the facade or alter the native captured-message contract.
class LiveViewFolderStatusListener final : public nsIDBChangeListener {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIDBCHANGELISTENER
  LiveViewFolderStatusListener(LiveView* owner, PerFolderDatabase* db,
                               uint64_t folder, uint64_t attachment)
      : mOwner(owner), mDB(db), mFolder(folder), mAttachment(attachment) {}
  void Detach() {
    mOwner = nullptr;
    RefPtr<PerFolderDatabase> db = mDB.get();
    mDB = nullptr;
    if (db) db->RemoveListener(this);
  }

 private:
  ~LiveViewFolderStatusListener() = default;
  LiveView* mOwner;
  WeakPtr<PerFolderDatabase> mDB;
  const uint64_t mFolder;
  const uint64_t mAttachment;
};
NS_IMPL_ISUPPORTS(LiveViewFolderStatusListener, nsIDBChangeListener)

struct LiveViewPublicStatus {
  struct Row {
    CapturedMessage raw;
    uint32_t flags;
  };
  nsTHashMap<nsMsgKey, Row> rows;
  nsTArray<RefPtr<LiveViewFolderStatusListener>> listeners;
  nsCString sourceId;
  ~LiveViewPublicStatus() {
    for (const auto& listener : listeners) listener->Detach();
  }
};

NS_IMETHODIMP LiveViewFolderStatusListener::OnHdrFlagsChanged(
    nsIMsgDBHdr* header, uint32_t oldFlags, uint32_t newFlags,
    nsIDBChangeListener*) {
  RefPtr<LiveView> owner = mOwner;
  if (!owner) return NS_OK;
  nsMsgKey key;
  nsresult rv = header->GetMessageKey(&key);
  if (NS_FAILED(rv)) {
    owner->OnPublicStatusClosed(mAttachment);
    return rv;
  }
  // Copy identity and outgoing scalar words before calling the view/JS
  // listener.
  owner->OnPublicStatusFlags(mAttachment, mFolder, key, oldFlags, newFlags);
  return NS_OK;
}
NS_IMETHODIMP LiveViewFolderStatusListener::OnAnnouncerGoingAway(
    nsIDBChangeAnnouncer*) {
  RefPtr<LiveView> owner = mOwner;
  mDB = nullptr;
  mOwner = nullptr;
  if (owner) owner->OnPublicStatusClosed(mAttachment);
  return NS_OK;
}
NS_IMETHODIMP LiveViewFolderStatusListener::OnHdrDeleted(nsIMsgDBHdr*, nsMsgKey,
                                                         int32_t,
                                                         nsIDBChangeListener*) {
  return NS_OK;
}
NS_IMETHODIMP LiveViewFolderStatusListener::OnHdrAdded(nsIMsgDBHdr*, nsMsgKey,
                                                       int32_t,
                                                       nsIDBChangeListener*) {
  return NS_OK;
}
NS_IMETHODIMP LiveViewFolderStatusListener::OnParentChanged(
    nsMsgKey, nsMsgKey, nsMsgKey, nsIDBChangeListener*) {
  return NS_OK;
}
NS_IMETHODIMP LiveViewFolderStatusListener::OnReadChanged(
    nsIDBChangeListener*) {
  return NS_OK;
}
NS_IMETHODIMP LiveViewFolderStatusListener::OnJunkScoreChanged(
    nsIDBChangeListener*) {
  return NS_OK;
}
NS_IMETHODIMP LiveViewFolderStatusListener::OnHdrPropertyChanged(
    nsIMsgDBHdr*, const nsACString&, bool, uint32_t*, nsIDBChangeListener*) {
  return NS_OK;
}
NS_IMETHODIMP LiveViewFolderStatusListener::OnEvent(nsIMsgDatabase*,
                                                    const char*) {
  return NS_OK;
}

void LiveView::ClearPublicStatus() {
  auto status = std::move(mPublicStatus);
  if (status) {
    for (const auto& listener : status->listeners) listener->Detach();
  }
}

nsresult LiveView::RefreshPublicStatus() {
  ClearPublicStatus();
  auto status = MakeUnique<LiveViewPublicStatus>();
  RefPtr<DatabaseCore> core = DatabaseCore::sInstance;
  MOZ_TRY(core->ReadSourceIdForFolderAdmission(status->sourceId));
  struct Folder {
    RefPtr<PerFolderDatabase> db;
    nsTArray<nsMsgKey> newKeys;
    nsTArray<nsMsgKey> extraNew;
    bool used = false;
  };
  nsTHashMap<uint64_t, UniquePtr<Folder>> folders;
  for (auto iter = core->mOpenDatabases.Iter(); !iter.Done(); iter.Next()) {
    RefPtr<PerFolderDatabase> db = iter.UserData().get();
    if (!db) continue;
    auto folder = MakeUnique<Folder>();
    folder->db = db;
    MOZ_TRY(db->GetNewList(folder->newKeys));
    folders.InsertOrUpdate(iter.Key(), std::move(folder));
  }
  if (!folders.IsEmpty()) {
    nsAutoCString sql("SELECT id, folderId FROM messages WHERE ");
    sql.Append(GetSQLClause());
    nsCOMPtr<mozIStorageStatement> statement;
    MOZ_TRY(Connection()->CreateStatement(sql, getter_AddRefs(statement)));
    PrepareStatement(statement);
    bool more;
    nsresult rv;
    while (NS_SUCCEEDED(rv = statement->ExecuteStep(&more)) && more) {
      int64_t id, folderId;
      MOZ_TRY(statement->GetInt64(0, &id));
      MOZ_TRY(statement->GetInt64(1, &folderId));
      auto folder = folders.Lookup(uint64_t(folderId));
      if (!folder) continue;
      nsCOMPtr<nsIMsgDBHdr> admitted;
      // Unlike GetNewList/ContainsKey this checks source and physical
      // membership.
      MOZ_TRY(folder.Data()->db->GetMsgHdrForKey(nsMsgKey(id),
                                                 getter_AddRefs(admitted)));
      NS_ENSURE_TRUE(admitted, NS_ERROR_UNEXPECTED);
      folder.Data()->used = true;
      LiveViewPublicStatus::Row row;
      MOZ_TRY(MessageDB().CaptureMessage(nsMsgKey(id), row.raw));
      NS_ENSURE_TRUE(row.raw.folderId == uint64_t(folderId),
                     NS_ERROR_NOT_AVAILABLE);
      row.flags = row.raw.flags;
      if (folder.Data()->newKeys.Contains(row.raw.id)) {
        row.flags |= nsMsgMessageFlags::New;
        if (!(row.raw.flags & nsMsgMessageFlags::New))
          folder.Data()->extraNew.AppendElement(row.raw.id);
      }
      status->rows.InsertOrUpdate(row.raw.id, std::move(row));
    }
    MOZ_TRY(rv);
  }
  nsCString flags("flags");
  nsCString extra;
  for (auto iter = folders.Iter(); !iter.Done(); iter.Next()) {
    const auto& folder = iter.Data();
    if (!folder->used) continue;
    if (!folder->extraNew.IsEmpty()) {
      if (!extra.IsEmpty()) extra.Append(" OR ");
      extra.AppendLiteral("(folderId = ");
      extra.AppendInt(int64_t(iter.Key()));
      extra.AppendLiteral(" AND id IN (");
      for (size_t i = 0; i < folder->extraNew.Length(); ++i) {
        if (i) extra.Append(',');
        extra.AppendInt(int64_t(folder->extraNew[i]));
      }
      extra.AppendLiteral("))");
    }
    if (mListener) {
      RefPtr<LiveViewFolderStatusListener> listener =
          new LiveViewFolderStatusListener(this, folder->db, iter.Key(),
                                           mAttachmentGeneration);
      MOZ_TRY(folder->db->AddListener(listener));
      status->listeners.AppendElement(listener);
    }
  }
  if (!extra.IsEmpty()) {
    flags.AssignLiteral("CASE WHEN ");
    flags.Append(extra);
    flags.AppendLiteral(" THEN (flags | ");
    flags.AppendInt(int64_t(nsMsgMessageFlags::New));
    flags.AppendLiteral(") ELSE flags END");
  }
  if (flags != mPublicFlagsSQL) {
    if (mSelectStmt) {
      mSelectStmt->Finalize();
      mSelectStmt = nullptr;
    }
    if (mSelectGroupStmt) {
      mSelectGroupStmt->Finalize();
      mSelectGroupStmt = nullptr;
    }
    mPublicFlagsSQL = flags;
  }
  mPublicStatus = std::move(status);
  return NS_OK;
}

void LiveView::OnPublicStatusClosed(uint64_t attachment) {
  if (attachment != mAttachmentGeneration) return;
  nsCOMPtr<nsILiveViewListener> listener = mListener;
  RefPtr<LiveViewBatchCapability> capability = mBatchCapability;
  InvalidateCapturedConsumer(listener, capability, attachment);
}

void LiveView::OnPublicStatusFlags(uint64_t attachment, uint64_t folderId,
                                   nsMsgKey key, uint32_t oldFlags,
                                   uint32_t newFlags) {
  if (attachment != mAttachmentGeneration || !mListener || !mPublicStatus)
    return;
  auto entry = mPublicStatus->rows.Lookup(key);
  if (!entry || entry.Data().raw.folderId != folderId) return;
  nsCString source;
  if (NS_FAILED(
          DatabaseCore::sInstance->ReadSourceIdForFolderAdmission(source)) ||
      source != mPublicStatus->sourceId) {
    OnPublicStatusClosed(attachment);
    return;
  }
  // Thread-state words do not change New. Only the actual projected status
  // transition belongs to this bridge; other raw deltas use native captures.
  const uint32_t changed = oldFlags ^ newFlags;
  if (!(changed & nsMsgMessageFlags::New)) return;
  const uint32_t displayed = entry.Data().flags;
  // A native header change supplies both frozen words. A NewList-only change
  // changes just New: retain raw fields already advanced by a nested listener.
  // In either case the displayed word, not oldFlags, supplies the count delta.
  const uint32_t projected = (changed & ~nsMsgMessageFlags::New)
                                 ? newFlags
                                 : (displayed & ~nsMsgMessageFlags::New) |
                                       (newFlags & nsMsgMessageFlags::New);

  if (displayed == projected) return;
  CapturedMessage row = entry.Data().raw;
  row.flags = projected;
  entry.Data().flags = projected;
  nsCOMPtr<nsILiveViewListener> listener = mListener;
  RefPtr<LiveViewBatchCapability> capability = mBatchCapability;
  AutoJSAPI jsapi;
  if (!jsapi.Init(PrivilegedJunkScope())) {
    InvalidateCapturedConsumer(listener, capability, attachment);
    return;
  }
  JSContext* cx = jsapi.cx();
  Rooted<JSObject*> object(cx);
  CreateJSMessage(row.id, row.folderId, row.messageId.get(), row.date,
                  row.sender.get(), row.recipients.get(), row.subject.get(),
                  row.flags, row.tags.get(), row.threadId, row.threadParent, cx,
                  object);
  if (!object || JS_IsExceptionPending(cx)) {
    InvalidateCapturedConsumer(listener, capability, attachment);
    return;
  }
  Rooted<Value> value(cx, ObjectValue(*object));
  if (NS_FAILED(listener->OnMessageFlagsChanged(value, displayed)))
    InvalidateCapturedConsumer(listener, capability, attachment);
}

LiveView::LiveView()
    : mSortColumn(nsILiveView::SortColumn::DATE),
      mSortDescending(true),
      mGrouping(nsILiveView::Grouping::UNTHREADED) {}

LiveView::~LiveView() {
  ClearPublicStatus();
  delete mFolderFilter;
  ResetStatements();
}

static nsresult ReadBatchCapability(nsILiveViewListener* listener,
                                    RefPtr<LiveViewBatchCapability>& output) {
  output = nullptr;
  nsCOMPtr<nsIXPConnectWrappedJS> wrapped = do_QueryInterface(listener);
  if (!wrapped) {
    return NS_OK;
  }
  AutoJSAPI jsapi;
  if (!jsapi.Init(wrapped->GetJSObjectGlobal())) {
    return NS_ERROR_FAILURE;
  }
  JSContext* cx = jsapi.cx();
  Rooted<JSObject*> object(cx, wrapped->GetJSObject());
  object = js::CheckedUnwrapStatic(object);
  if (!object || js::IsProxy(object)) {
    return NS_OK;
  }
  JSAutoRealm realm(cx, object);
  Rooted<mozilla::Maybe<JS::PropertyDescriptor>> version(cx), generation(cx),
      invalidator(cx), owner(cx);
  if (!JS_GetOwnPropertyDescriptor(cx, object, "panoramaThreadBatchVersion",
                                   &version) ||
      !JS_GetOwnPropertyDescriptor(cx, object, "panoramaThreadBatchGeneration",
                                   &generation) ||
      !JS_GetOwnPropertyDescriptor(cx, object, "panoramaThreadBatchOwner",
                                   &owner) ||
      !JS_GetOwnPropertyDescriptor(cx, object, "panoramaThreadBatchInvalidated",
                                   &invalidator)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  if (!version.get() || !version.get()->isDataDescriptor() ||
      !version.get()->value().isNumber() ||
      version.get()->value().toNumber() != 1 || !generation.get() ||
      !generation.get()->isDataDescriptor() ||
      !generation.get()->value().isNumber() || !owner.get() ||
      !owner.get()->isDataDescriptor() || !owner.get()->value().isObject() ||
      !invalidator.get() || !invalidator.get()->isDataDescriptor() ||
      !invalidator.get()->value().isObject() ||
      !JS::IsCallable(&invalidator.get()->value().toObject())) {
    return NS_OK;
  }
  double value = generation.get()->value().toNumber();
  if (!std::isfinite(value) || value < 0 || value > 9007199254740991.0 ||
      std::floor(value) != value) {
    return NS_OK;
  }
  Rooted<Value> callback(cx, invalidator.get()->value());
  Rooted<JSObject*> ownerObject(
      cx, js::CheckedUnwrapStatic(&owner.get()->value().toObject()));
  if (!ownerObject || js::IsProxy(ownerObject)) return NS_OK;
  output = new (fallible) LiveViewBatchCapability(cx, object, ownerObject,
                                                  callback, uint64_t(value));
  return output ? NS_OK : NS_ERROR_OUT_OF_MEMORY;
}

static bool BatchString(JSContext* cx, JS::Handle<JSObject*> object,
                        const char* name, const nsACString& text) {
  Rooted<JSString*> string(
      cx, JS_NewStringCopyUTF8N(
              cx, JS::UTF8Chars(text.BeginReading(), text.Length())));
  return string &&
         JS_DefineProperty(cx, object, name, string, JSPROP_ENUMERATE);
}

static bool BatchNumber(JSContext* cx, JS::Handle<JSObject*> object,
                        const char* name, double number) {
  return JS_DefineProperty(cx, object, name, number, JSPROP_ENUMERATE);
}

static bool BatchBoolean(JSContext* cx, JS::Handle<JSObject*> object,
                         const char* name, bool flag) {
  Rooted<Value> value(cx, JS::BooleanValue(flag));
  return JS_DefineProperty(cx, object, name, value, JSPROP_ENUMERATE);
}

static bool BatchPair(JSContext* cx, const CapturedMessage& row,
                      JS::MutableHandle<JSObject*> result) {
  result.set(JS_NewPlainObject(cx));
  return result && BatchNumber(cx, result, "folderId", double(row.folderId)) &&
         BatchNumber(cx, result, "id", row.id);
}

static bool BatchMessage(JSContext* cx, const CapturedMessage& row,
                         JS::MutableHandle<JSObject*> result) {
  auto date = TimeClip(row.date / PR_USEC_PER_MSEC);
  if (!row.id || row.id == nsMsgKey_None || !row.folderId ||
      row.folderId > 9007199254740991ULL || !date.isValid()) {
    return false;
  }
  if (!BatchPair(cx, row, result)) {
    return false;
  }
  Rooted<JSObject*> jsDate(cx, NewDateObject(cx, date));
  return jsDate &&
         JS_DefineProperty(cx, result, "date", jsDate, JSPROP_ENUMERATE) &&
         BatchString(cx, result, "messageId", row.messageId) &&
         BatchString(cx, result, "sender", row.sender) &&
         BatchString(cx, result, "recipients", row.recipients) &&
         BatchString(cx, result, "subject", row.subject) &&
         BatchString(cx, result, "tags", row.tags) &&
         BatchNumber(cx, result, "flags", row.flags) &&
         BatchNumber(cx, result, "threadId", row.threadId) &&
         BatchNumber(cx, result, "threadParent", row.threadParent);
}

// The only reads outside the captured component are complete affected sort
// groups. These run before commit/callbacks, and unchanged rows are owned on
// both sides.
class LiveViewThreadBatchBuilder {
 public:
  LiveViewThreadBatchBuilder(LiveView& view, PreparedThreadBatch& prepared,
                             CapturedLiveView* before)
      : mView(view), mBatch(prepared.captured), mBefore(before) {}
  struct Row {
    const CapturedMessage* before;
    const CapturedMessage* after;
    bool matchesBefore;
    bool matchesAfter;
  };
  struct Key {
    bool numeric = false;
    int64_t number = 0;
    nsCString text;
  };
  struct Group {
    Key key;
    nsTArray<uint32_t> members;
  };
  nsTArray<Row> rows;
  nsTArray<Group> beforeGroups, afterGroups;
  bool changedMatching = false;
  bool matching = false;

  nsresult Matches(const CapturedMessage& row, bool& matches) {
    RefPtr<DetachedMsgHdr> header = new (fallible) DetachedMsgHdr(row.folderId);
    NS_ENSURE_TRUE(header, NS_ERROR_OUT_OF_MEMORY);
    MOZ_TRY(header->SetFlags(row.flags));
    MOZ_TRY(header->SetDate(row.date));
    MOZ_TRY(header->SetThreadId(row.threadId));
    MOZ_TRY(header->SetStringProperty("keywords", row.tags));
    matches = mView.Matches(header, row.folderId);
    return NS_OK;
  }

  const CapturedLiveView::Root* OldRoot(const CapturedMessage& message) const {
    if (!mBefore || !mBefore->capability) return nullptr;
    for (const auto& root : mBefore->roots) {
      if (mView.mGrouping == nsILiveView::UNTHREADED) {
        if (root.message.id == message.id &&
            root.message.folderId == message.folderId)
          return &root;
      } else
        for (const auto& member : root.members)
          if (member.id == message.id && member.folderId == message.folderId)
            return &root;
    }
    return nullptr;
  }

  nsresult OldKeyFor(const CapturedMessage& message, Key& key) {
    const auto* root = OldRoot(message);
    if (!root) return NS_ERROR_UNEXPECTED;
    key.numeric = mView.mGrouping == nsILiveView::THREADED ||
                  mView.mSortColumn == nsILiveView::DATE;
    if (key.numeric) {
      nsresult rv;
      key.number = root->group.ToInteger64(&rv);
      return rv;
    }
    return key.text.Assign(root->group, fallible) ? NS_OK
                                                  : NS_ERROR_OUT_OF_MEMORY;
  }

  nsresult KeyFor(const CapturedMessage& row, Key& key) {
    if (mView.mGrouping == nsILiveView::THREADED) {
      key.numeric = true;
      key.number = row.threadId;
      return NS_OK;
    }
    if (mView.mSortColumn == nsILiveView::DATE) {
      if (!mDate) {
        MOZ_TRY(mView.Connection()->CreateStatement("SELECT DATE_GROUP(?1)"_ns,
                                                    getter_AddRefs(mDate)));
      }
      mozStorageStatementScoper reset(mDate);
      MOZ_TRY(mDate->BindInt64ByIndex(0, row.date));
      bool more;
      MOZ_TRY(mDate->ExecuteStep(&more));
      NS_ENSURE_TRUE(more, NS_ERROR_UNEXPECTED);
      key.numeric = true;
      return mDate->GetInt64(0, &key.number);
    }
    const nsCString* text = nullptr;
    switch (mView.mSortColumn) {
      case nsILiveView::SUBJECT:
        text = &row.subject;
        break;
      case nsILiveView::SENDER:
        text = &row.sender;
        break;
      case nsILiveView::RECIPIENTS:
        text = &row.recipients;
        break;
      default:
        return NS_ERROR_NOT_AVAILABLE;
    }
    return key.text.Assign(*text, fallible) ? NS_OK : NS_ERROR_OUT_OF_MEMORY;
  }

  nsresult Equal(const Key& a, const Key& b, bool& equal) {
    if (a.numeric || b.numeric) {
      equal = a.numeric && b.numeric && a.number == b.number;
      return NS_OK;
    }
    if (a.text.Equals(b.text)) {
      equal = a.text.Equals(b.text);
      return NS_OK;
    }
    if (!mEqual) {
      MOZ_TRY(mView.Connection()->CreateStatement(
          "SELECT ?1 = ?2 COLLATE locale"_ns, getter_AddRefs(mEqual)));
    }
    mozStorageStatementScoper reset(mEqual);
    MOZ_TRY(mEqual->BindUTF8StringByIndex(0, a.text));
    MOZ_TRY(mEqual->BindUTF8StringByIndex(1, b.text));
    bool more;
    MOZ_TRY(mEqual->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_UNEXPECTED);
    int32_t value;
    MOZ_TRY(mEqual->GetInt32(0, &value));
    equal = value != 0;
    return NS_OK;
  }

  nsresult AddGroup(nsTArray<Group>& groups, Key&& key, uint32_t member) {
    for (auto& group : groups) {
      bool equal;
      MOZ_TRY(Equal(group.key, key, equal));
      if (equal) {
        return group.members.AppendElement(member, fallible)
                   ? NS_OK
                   : NS_ERROR_OUT_OF_MEMORY;
      }
    }
    Group group;
    group.key = std::move(key);
    if (!group.members.AppendElement(member, fallible) ||
        !groups.AppendElement(std::move(group), fallible)) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
    return NS_OK;
  }

  nsresult AddRow(const CapturedMessage* before, const CapturedMessage* after) {
    for (const auto* capture : {before, after}) {
      if (capture &&
          (!capture->id || capture->id == nsMsgKey_None || !capture->folderId ||
           capture->folderId > 9007199254740991ULL ||
           !TimeClip(capture->date / PR_USEC_PER_MSEC).isValid())) {
        return NS_ERROR_ILLEGAL_VALUE;
      }
    }
    Row row{before, after, false, false};
    if (before) {
      if (mBefore && mBefore->capability)
        row.matchesBefore = OldRoot(*before);
      else
        MOZ_TRY(Matches(*before, row.matchesBefore));
    }
    if (after) MOZ_TRY(Matches(*after, row.matchesAfter));
    matching |= row.matchesBefore || row.matchesAfter;
    if (before && after && mBatch.changedKeys.Contains(before->id)) {
      changedMatching |= row.matchesBefore || row.matchesAfter;
    }
    return rows.AppendElement(row, fallible) ? NS_OK : NS_ERROR_OUT_OF_MEMORY;
  }

  nsresult Prepare() {
    for (const auto& before : mBatch.before) {
      const CapturedMessage* after = nullptr;
      for (const auto& candidate : mBatch.after) {
        if (candidate.id == before.id) {
          after = &candidate;
          break;
        }
      }
      NS_ENSURE_TRUE(after, NS_ERROR_INVALID_ARG);
      MOZ_TRY(AddRow(&before, after));
    }
    for (const auto& after : mBatch.after) {
      if (after.id == mBatch.publicationKey) MOZ_TRY(AddRow(nullptr, &after));
    }
    if (mView.mGrouping == nsILiveView::UNTHREADED) return NS_OK;
    // First obtain affected keys, then capture all other matching group
    // members.
    nsTArray<Group> affected;
    for (uint32_t i = 0; i < rows.Length(); ++i) {
      for (bool after : {false, true}) {
        if (after ? !rows[i].matchesAfter : !rows[i].matchesBefore) continue;
        Key key;
        if (!after && mBefore && mBefore->capability)
          MOZ_TRY(OldKeyFor(*rows[i].before, key));
        else
          MOZ_TRY(KeyFor(*(after ? rows[i].after : rows[i].before), key));
        MOZ_TRY(AddGroup(affected, std::move(key), i));
      }
    }
    if (mView.mGrouping == nsILiveView::GROUPED_BY_SORT) {
      if (mBefore && mBefore->capability) {
        for (const auto& root : mBefore->roots) {
          Key key;
          MOZ_TRY(OldKeyFor(root.message, key));
          bool affectedRoot = false;
          for (const auto& group : affected) {
            bool equal;
            MOZ_TRY(Equal(key, group.key, equal));
            affectedRoot |= equal;
          }
          if (!affectedRoot) continue;
          for (const auto& member : root.members) {
            bool component = false;
            for (const auto& row : mBatch.before)
              component |= row.id == member.id;
            if (!component && !mExtra.AppendElement(member, fallible))
              return NS_ERROR_OUT_OF_MEMORY;
          }
        }
      }
      for (const auto& group : affected)
        MOZ_TRY(CaptureOtherMembers(group.key));
      for (const auto& extra : mExtra) MOZ_TRY(AddRow(&extra, &extra));
    }
    for (uint32_t i = 0; i < rows.Length(); ++i) {
      if (rows[i].matchesBefore) {
        Key key;
        if (mBefore && mBefore->capability)
          MOZ_TRY(OldKeyFor(*rows[i].before, key));
        else
          MOZ_TRY(KeyFor(*rows[i].before, key));
        MOZ_TRY(AddGroup(beforeGroups, std::move(key), i));
      }
      if (rows[i].matchesAfter) {
        Key key;
        MOZ_TRY(KeyFor(*rows[i].after, key));
        MOZ_TRY(AddGroup(afterGroups, std::move(key), i));
      }
    }
    return NS_OK;
  }

  nsresult CaptureOtherMembers(const Key& key) {
    nsAutoCString sql("SELECT id FROM messages WHERE ");
    sql.Append(mView.GetSQLClause());
    switch (mView.mSortColumn) {
      case nsILiveView::DATE:
        sql.Append(" AND DATE_GROUP(date) = :batchGroup");
        break;
      case nsILiveView::SUBJECT:
        sql.Append(" AND COALESCE(subject, '') = :batchGroup COLLATE locale");
        break;
      case nsILiveView::SENDER:
        sql.Append(" AND COALESCE(sender, '') = :batchGroup COLLATE locale");
        break;
      case nsILiveView::RECIPIENTS:
        sql.Append(
            " AND COALESCE(recipients, '') = :batchGroup COLLATE locale");
        break;
      default:
        return NS_ERROR_NOT_AVAILABLE;
    }
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(mView.Connection()->CreateStatement(sql, getter_AddRefs(stmt)));
    mozStorageStatementScoper reset(stmt);
    for (uint32_t i = 0; i < mView.mParams.Length(); ++i) {
      MOZ_TRY(stmt->BindByIndex(i, mView.mParams[i]));
    }
    if (key.numeric)
      MOZ_TRY(stmt->BindInt64ByName("batchGroup"_ns, key.number));
    else
      MOZ_TRY(stmt->BindUTF8StringByName("batchGroup"_ns, key.text));
    bool more;
    while (NS_SUCCEEDED(mStep = stmt->ExecuteStep(&more)) && more) {
      int64_t id;
      MOZ_TRY(stmt->GetInt64(0, &id));
      NS_ENSURE_TRUE(id > 0 && id < nsMsgKey_None, NS_ERROR_ILLEGAL_VALUE);
      bool captured = false;
      for (const auto& row : mBatch.after) captured |= row.id == id;
      for (const auto& row : mExtra) captured |= row.id == id;
      if (captured) continue;
      CapturedMessage extra;
      MOZ_TRY(mView.MessageDB().CaptureMessage(nsMsgKey(id), extra));
      if (!mExtra.AppendElement(std::move(extra), fallible))
        return NS_ERROR_OUT_OF_MEMORY;
    }
    return mStep;
  }

  bool Serialize(JSContext* cx, uint64_t generation,
                 JS::MutableHandle<JSObject*> result) {
    result.set(JS_NewPlainObject(cx));
    Rooted<JSObject*> rowArray(cx, NewArrayObject(cx, 0));
    Rooted<JSObject*> components(cx, JS_NewPlainObject(cx));
    Rooted<JSObject*> groups(cx, JS_NewPlainObject(cx));
    if (!result || !rowArray || !components || !groups ||
        !BatchString(cx, result, "kind", "panorama-thread-batch"_ns) ||
        !BatchNumber(cx, result, "version", 1) ||
        !BatchNumber(cx, result, "viewGeneration", double(generation)))
      return false;
    nsAutoCString batchId;
    batchId.AppendInt(mBatch.batchId);
    if (!BatchString(cx, result, "batchId", batchId)) return false;
    for (uint32_t i = 0; i < rows.Length(); ++i) {
      Rooted<JSObject*> change(cx, JS_NewPlainObject(cx));
      if (!change) return false;
      for (bool after : {false, true}) {
        const auto* row = after ? rows[i].after : rows[i].before;
        Rooted<Value> value(cx, JS::NullValue());
        if (row) {
          Rooted<JSObject*> object(cx);
          if (!BatchMessage(cx, *row, &object)) return false;
          value.setObject(*object);
        }
        if (!JS_DefineProperty(cx, change, after ? "after" : "before", value,
                               JSPROP_ENUMERATE))
          return false;
      }
      if (!BatchBoolean(cx, change, "matchesBefore", rows[i].matchesBefore) ||
          !BatchBoolean(cx, change, "matchesAfter", rows[i].matchesAfter) ||
          !JS_DefineElement(cx, rowArray, i, change, JSPROP_ENUMERATE))
        return false;
    }
    for (bool after : {false, true}) {
      Rooted<JSObject*> ids(cx, NewArrayObject(cx, 0));
      Rooted<JSObject*> groupArray(cx, NewArrayObject(cx, 0));
      if (!ids || !groupArray) return false;
      nsTArray<nsMsgKey> seen;
      const auto& source = after ? mBatch.after : mBatch.before;
      for (const auto& row : source) {
        if (seen.Contains(row.threadId)) continue;
        if (!seen.AppendElement(row.threadId, fallible) ||
            !JS_DefineElement(cx, ids, seen.Length() - 1, double(row.threadId),
                              JSPROP_ENUMERATE))
          return false;
      }
      const auto& nativeGroups = after ? afterGroups : beforeGroups;
      for (uint32_t i = 0; i < nativeGroups.Length(); ++i) {
        Rooted<JSObject*> group(cx);
        if (!SerializeGroup(cx, nativeGroups[i], after, &group) ||
            !JS_DefineElement(cx, groupArray, i, group, JSPROP_ENUMERATE))
          return false;
      }
      if (!JS_DefineProperty(cx, components, after ? "after" : "before", ids,
                             JSPROP_ENUMERATE) ||
          !JS_DefineProperty(cx, groups, after ? "after" : "before", groupArray,
                             JSPROP_ENUMERATE))
        return false;
    }
    const CapturedMessage* publication = nullptr;
    for (const auto& row : mBatch.after)
      if (row.id == mBatch.publicationKey) publication = &row;
    Rooted<JSObject*> pair(cx);
    return publication && BatchPair(cx, *publication, &pair) &&
           JS_DefineProperty(cx, result, "publication", pair,
                             JSPROP_ENUMERATE) &&
           JS_DefineProperty(cx, result, "rows", rowArray, JSPROP_ENUMERATE) &&
           JS_DefineProperty(cx, result, "groups", groups, JSPROP_ENUMERATE) &&
           JS_DefineProperty(cx, result, "componentThreadIds", components,
                             JSPROP_ENUMERATE);
  }

  bool SerializeGroup(JSContext* cx, const Group& group, bool after,
                      JS::MutableHandle<JSObject*> result) {
    result.set(JS_NewPlainObject(cx));
    Rooted<JSObject*> key(cx, JS_NewPlainObject(cx));
    Rooted<JSObject*> members(cx, NewArrayObject(cx, 0));
    if (!result || !key || !members ||
        !BatchString(
            cx, key, "kind",
            mView.mGrouping == nsILiveView::THREADED ? "thread"_ns : "sort"_ns))
      return false;
    if (group.key.numeric) {
      if (!BatchNumber(cx, key, "value", group.key.number)) return false;
    } else if (!BatchString(cx, key, "value", group.key.text))
      return false;
    const CapturedMessage* representative = nullptr;
    uint32_t newCount = 0, unreadCount = 0;
    for (uint32_t i = 0; i < group.members.Length(); ++i) {
      const Row& change = rows[group.members[i]];
      const auto* row = after ? change.after : change.before;
      if (!representative || row->date > representative->date)
        representative = row;
      newCount += !!(row->flags & nsMsgMessageFlags::New);
      unreadCount += !(row->flags & nsMsgMessageFlags::Read);
      Rooted<JSObject*> pair(cx);
      if (!BatchPair(cx, *row, &pair) ||
          !JS_DefineElement(cx, members, i, pair, JSPROP_ENUMERATE))
        return false;
    }
    if (!after && mBefore && mBefore->capability && representative) {
      const auto* root = OldRoot(*representative);
      if (root) representative = &root->message;
    }
    Rooted<JSObject*> pair(cx);
    return representative && BatchPair(cx, *representative, &pair) &&
           JS_DefineProperty(cx, result, "key", key, JSPROP_ENUMERATE) &&
           JS_DefineProperty(cx, result, "representative", pair,
                             JSPROP_ENUMERATE) &&
           JS_DefineProperty(cx, result, "members", members,
                             JSPROP_ENUMERATE) &&
           BatchNumber(cx, result, "messageCount", group.members.Length()) &&
           BatchNumber(cx, result, "newCount", newCount) &&
           BatchNumber(cx, result, "unreadCount", unreadCount);
  }

 private:
  LiveView& mView;
  const MessageThreadBatch& mBatch;
  CapturedLiveView* mBefore;
  nsTArray<CapturedMessage> mExtra;
  nsCOMPtr<mozIStorageStatement> mDate, mEqual;
  nsresult mStep = NS_OK;
};

nsresult LiveView::CaptureQueryView(const CapturedLiveView* context,
                                    RefPtr<CapturedLiveView>& output) {
  RefPtr<CapturedLiveView> captured = new (fallible) CapturedLiveView();
  NS_ENSURE_TRUE(captured, NS_ERROR_OUT_OF_MEMORY);
  captured->listener = mListener;
  captured->capability = mBatchCapability;
  captured->attachment = mAttachmentGeneration;
  captured->query = mQueryGeneration;
  captured->configuration = mConfigurationGeneration;
  captured->grouping = context ? context->grouping : mGrouping;
  captured->sortColumn = context ? context->sortColumn : mSortColumn;
  captured->descending = context ? context->descending : mSortDescending;
  captured->viewGeneration = context            ? context->viewGeneration
                             : mBatchCapability ? mBatchCapability->generation
                                                : 0;
  captured->selectSQL = context ? context->selectSQL : SelectSQL();
  captured->groupSQL = context ? context->groupSQL
                       : captured->grouping == nsILiveView::UNTHREADED
                           ? nsCString()
                           : SelectGroupSQL();
  captured->params = context ? context->params.Clone() : mParams.Clone();
  if (mListener && mBatchCapability) {
    nsCOMPtr<mozIStorageStatement> roots, members;
    MOZ_TRY(Connection()->CreateStatement(captured->selectSQL,
                                          getter_AddRefs(roots)));
    for (size_t i = 0; i < captured->params.Length(); ++i)
      MOZ_TRY(roots->BindByIndex(i, captured->params[i]));
    if (captured->grouping != nsILiveView::UNTHREADED) {
      MOZ_TRY(Connection()->CreateStatement(captured->groupSQL,
                                            getter_AddRefs(members)));
    }
    bool more;
    nsresult rv;
    while (NS_SUCCEEDED(rv = roots->ExecuteStep(&more)) && more) {
      CapturedLiveView::Root root;
      int64_t key;
      MOZ_TRY(roots->GetInt64(0, &key));
      NS_ENSURE_TRUE(key > 0 && key < nsMsgKey_None, NS_ERROR_FILE_CORRUPTED);
      MOZ_TRY(MessageDB().CaptureMessage(nsMsgKey(key), root.message));
      if (members) {
        mozStorageStatementScoper scoper(members);
        for (size_t i = 0; i < captured->params.Length(); ++i)
          MOZ_TRY(members->BindByIndex(i, captured->params[i]));
        if (captured->grouping == nsILiveView::THREADED) {
          root.group.AppendInt(int64_t(root.message.threadId));
          MOZ_TRY(members->BindInt64ByName("group"_ns, root.message.threadId));
        } else if (captured->sortColumn == nsILiveView::DATE) {
          int64_t key = roots->AsInt64(14);
          root.group.AppendInt(key);
          MOZ_TRY(members->BindInt64ByName("group"_ns, key));
        } else {
          root.group = captured->sortColumn == nsILiveView::SUBJECT
                           ? root.message.subject
                       : captured->sortColumn == nsILiveView::SENDER
                           ? root.message.sender
                           : root.message.recipients;
          MOZ_TRY(members->BindUTF8StringByName("group"_ns, root.group));
        }
        bool hasMember;
        nsresult memberRV;
        while (NS_SUCCEEDED(memberRV = members->ExecuteStep(&hasMember)) &&
               hasMember) {
          CapturedMessage member;
          int64_t memberKey;
          MOZ_TRY(members->GetInt64(0, &memberKey));
          NS_ENSURE_TRUE(memberKey > 0 && memberKey < nsMsgKey_None,
                         NS_ERROR_FILE_CORRUPTED);
          MOZ_TRY(MessageDB().CaptureMessage(nsMsgKey(memberKey), member));
          if (!root.members.AppendElement(std::move(member), fallible))
            return NS_ERROR_OUT_OF_MEMORY;
        }
        MOZ_TRY(memberRV);
        NS_ENSURE_TRUE(!root.members.IsEmpty(), NS_ERROR_UNEXPECTED);
      }
      if (!captured->roots.AppendElement(std::move(root), fallible))
        return NS_ERROR_OUT_OF_MEMORY;
    }
    MOZ_TRY(rv);
  }
  if (context && captured->grouping != nsILiveView::UNTHREADED) {
    struct Binding {
      CapturedLiveView::Root* root;
      uint64_t folder;
    };
    nsTHashMap<nsMsgKey, Binding> groups;
    for (auto& root : captured->roots)
      for (const auto& member : root.members)
        if (!groups.InsertOrUpdate(member.id, Binding{&root, member.folderId},
                                   fallible))
          return NS_ERROR_OUT_OF_MEMORY;
    for (const auto& original : context->roots)
      for (const auto& member : original.members) {
        auto binding = groups.Lookup(member.id);
        if (!binding || binding.Data().folder != member.folderId) continue;
        auto& aliases = binding.Data().root->originalGroups;
        if (!aliases.Contains(original.group) &&
            !aliases.AppendElement(original.group, fallible))
          return NS_ERROR_OUT_OF_MEMORY;
      }
  }

  output = captured;
  return NS_OK;
}

nsresult LiveView::CaptureThreadViewBeforeInsert(
    nsCOMPtr<nsISupports>& output) {
  RefPtr<CapturedLiveView> captured;
  MOZ_TRY(CaptureQueryView(nullptr, captured));
  if (mMappedQuery && mBatchCapability) {
    MOZ_TRY(CaptureQueryView(mMappedQuery, captured->display));
    captured->display->original = mMappedQuery;
  }
  output = captured;
  return NS_OK;
}

static bool SerializeCapturedView(JSContext* cx, CapturedLiveView& captured,
                                  JS::MutableHandle<JSObject*> output,
                                  bool includeDisplay = true) {
  output.set(JS_NewPlainObject(cx));
  Rooted<JSObject*> roots(cx, NewArrayObject(cx, 0));
  if (!output || !roots ||
      !BatchNumber(cx, output, "grouping", captured.grouping) ||
      !BatchNumber(cx, output, "sortColumn", captured.sortColumn) ||
      !BatchBoolean(cx, output, "sortDescending", captured.descending))
    return false;
  for (size_t i = 0; i < captured.roots.Length(); ++i) {
    const auto& root = captured.roots[i];
    Rooted<JSObject*> entry(cx, JS_NewPlainObject(cx)), message(cx),
        members(cx, NewArrayObject(cx, 0));
    if (!entry || !members || !BatchMessage(cx, root.message, &message) ||
        !BatchString(cx, entry, "group", root.group) ||
        !JS_DefineProperty(cx, entry, "message", message, JSPROP_ENUMERATE))
      return false;
    for (size_t j = 0; j < root.members.Length(); ++j) {
      Rooted<JSObject*> member(cx);
      if (!BatchMessage(cx, root.members[j], &member) ||
          !JS_DefineElement(cx, members, j, member, JSPROP_ENUMERATE))
        return false;
    }
    Rooted<JSObject*> aliases(cx, NewArrayObject(cx, 0));
    if (!aliases) return false;
    for (size_t j = 0; j < root.originalGroups.Length(); ++j) {
      Rooted<JSString*> alias(
          cx, JS_NewStringCopyUTF8N(
                  cx, JS::UTF8Chars(root.originalGroups[j].BeginReading(),
                                    root.originalGroups[j].Length())));
      if (!alias || !JS_DefineElement(cx, aliases, j, alias, JSPROP_ENUMERATE))
        return false;
    }
    if (!JS_DefineProperty(cx, entry, "originalGroups", aliases,
                           JSPROP_ENUMERATE))
      return false;
    if (!JS_DefineProperty(cx, entry, "members", members, JSPROP_ENUMERATE) ||
        !JS_DefineElement(cx, roots, i, entry, JSPROP_ENUMERATE))
      return false;
  }
  if (captured.original) {
    Rooted<JSObject*> order(cx, NewArrayObject(cx, 0));
    if (!order) return false;
    for (size_t i = 0; i < captured.original->roots.Length(); ++i) {
      const auto& root = captured.original->roots[i];
      Rooted<JSObject*> pair(cx);
      if (!BatchPair(cx, root.message, &pair) ||
          !BatchString(cx, pair, "group", root.group) ||
          !JS_DefineElement(cx, order, i, pair, JSPROP_ENUMERATE))
        return false;
    }
    if (!JS_DefineProperty(cx, output, "order", order, JSPROP_ENUMERATE))
      return false;
  }
  if (includeDisplay) {
    Rooted<Value> value(cx, JS::NullValue());
    if (captured.display) {
      Rooted<JSObject*> display(cx);
      if (!SerializeCapturedView(cx, *captured.display, &display, false))
        return false;
      value.setObject(*display);
    }
    if (!JS_DefineProperty(cx, output, "displayView", value, JSPROP_ENUMERATE))
      return false;
  }
  return JS_DefineProperty(cx, output, "roots", roots, JSPROP_ENUMERATE);
}

nsresult LiveView::PrepareThreadBatch(const MessageThreadBatch& batch,
                                      PreparedThreadBatch& output) {
  return PrepareThreadBatch(batch, nullptr, output);
}

nsresult LiveView::PrepareThreadBatch(const MessageThreadBatch& batch,
                                      nsISupports* beforeView,
                                      PreparedThreadBatch& output) {
  NS_ENSURE_TRUE(batch.batchId != 0, NS_ERROR_INVALID_ARG);
  auto* before = static_cast<CapturedLiveView*>(beforeView);
  if (before && (before->listener != mListener ||
                 before->attachment != mAttachmentGeneration ||
                 before->query != mQueryGeneration ||
                 before->configuration != mConfigurationGeneration))
    return NS_ERROR_NOT_AVAILABLE;
  if (mListener && mBatchCapability && !before) return NS_ERROR_NOT_AVAILABLE;
  PreparedThreadBatch prepared;
  MOZ_TRY(MessageListener::PrepareThreadBatch(batch, prepared));
  if (!mListener) {
    output = std::move(prepared);
    return NS_OK;
  }
  LiveViewThreadBatchBuilder builder(*this, prepared, before);
  MOZ_TRY(builder.Prepare());
  if (mListener && builder.changedMatching && !mBatchCapability)
    return NS_ERROR_NOT_AVAILABLE;
  AutoJSAPI jsapi;
  if (!jsapi.Init(PrivilegedJunkScope())) return NS_ERROR_FAILURE;
  JSContext* cx = jsapi.cx();
  RefPtr<PreparedLiveViewThreadBatch> data =
      new (fallible) PreparedLiveViewThreadBatch(cx);
  NS_ENSURE_TRUE(data, NS_ERROR_OUT_OF_MEMORY);
  data->listener = mListener;
  data->capability = mBatchCapability;
  data->attachment = mAttachmentGeneration;
  data->query = mQueryGeneration;
  data->configuration = mConfigurationGeneration;
  data->delivery = mBatchDeliveryGeneration;
  data->before = before;
  if (mListener && builder.matching) {
    Rooted<JSObject*> object(cx);
    if (mBatchCapability) {
      Rooted<JSObject*> mapping(cx);
      if (!builder.Serialize(cx, mBatchCapability->generation, &object) ||
          !SerializeCapturedView(cx, *before, &mapping) ||
          !JS_DefineProperty(cx, object, "beforeView", mapping,
                             JSPROP_ENUMERATE))
        return NS_ERROR_OUT_OF_MEMORY;
    } else {
      for (const auto& row : builder.rows) {
        if (!row.before && row.matchesAfter &&
            !BatchMessage(cx, *row.after, &object))
          return NS_ERROR_OUT_OF_MEMORY;
      }
    }
    if (object) {
      data->value.setObject(*object);
      data->hasPayload = true;
    }
  }
  // Keep rooted payloads alive until queued delivery or rollback.
  prepared.liveViewData = data;
  output = std::move(prepared);
  return NS_OK;
}

void LiveView::DeliverThreadBatch(const PreparedThreadBatch& prepared) {
  auto* data =
      static_cast<PreparedLiveViewThreadBatch*>(prepared.liveViewData.get());
  if (!data || !data->hasPayload || !mListener) return;
  bool sameAttachment =
      data->listener == mListener && data->attachment == mAttachmentGeneration;
  bool sameConsumer =
      data->capability && mBatchCapability &&
      data->capability->owner.get() == mBatchCapability->owner.get() &&
      data->capability->generation == mBatchCapability->generation;
  if ((!sameAttachment && !sameConsumer) ||
      data->configuration != mConfigurationGeneration ||
      data->query + (mBatchDeliveryGeneration - data->delivery) !=
          mQueryGeneration)
    return;
  nsCOMPtr<nsILiveViewListener> listener = mListener;
  RefPtr<LiveViewBatchCapability> capability = mBatchCapability;
  uint64_t attachment = mAttachmentGeneration;
  uint64_t query = ++mQueryGeneration;
  ++mBatchDeliveryGeneration;
  AutoJSAPI api;
  nsresult rv = NS_ERROR_FAILURE;
  if (api.Init(PrivilegedJunkScope())) {
    Rooted<Value> value(api.cx(), data->value);
    rv = listener->OnMessageAdded(value);
  }
  if (NS_SUCCEEDED(rv)) {
    if (capability && data->before && listener == mListener &&
        capability == mBatchCapability && attachment == mAttachmentGeneration &&
        query == mQueryGeneration &&
        data->configuration == mConfigurationGeneration) {
      // The contextual install supersedes any pending count or select. Retain
      // its query context without linking successive historical captures.
      data->before->display = nullptr;
      data->before->original = nullptr;
      mMappedQuery = data->before.get();
      mCountQuery = nullptr;
    }
    return;
  }
  InvalidateCapturedConsumer(listener, capability, attachment);
}

void LiveView::InvalidateCapturedConsumer(nsILiveViewListener* listener,
                                          LiveViewBatchCapability* capability,
                                          uint64_t attachment) {
  NS_WARNING("Committed view consumer failed; database commit is retained");
  if (capability) {
    AutoJSAPI jsapi;
    if (jsapi.Init(JS::GetNonCCWObjectGlobal(capability->object))) {
      JSContext* cx = jsapi.cx();
      Rooted<Value> receiver(cx, ObjectValue(*capability->object));
      Rooted<Value> callback(cx, capability->invalidator), ignored(cx);
      if (!JS::Call(cx, receiver, callback, JS::HandleValueArray::empty(),
                    &ignored)) {
        NS_WARNING("Committed view invalidation callback failed");
      }
    }
  }
  if (listener == mListener && attachment == mAttachmentGeneration)
    ClearListener(mListener);
}

extern LazyLogModule gPanoramaLog;  // Defined by DatabaseCore.

NS_IMPL_ISUPPORTS(LiveView, nsILiveView)

NS_IMETHODIMP LiveView::InitWithFolder(uint64_t folderId) {
  if (folderId == 0) {
    NS_WARNING("Can't Init LiveView with 0 folderId");
    return NS_ERROR_INVALID_ARG;
  }
  if (mFolderFilter) {
    NS_WARNING("folder filter already set");
    return NS_ERROR_UNEXPECTED;
  }

  // TODO: LiveView should have access to concrete DB classes.
  nsCOMPtr<nsIDatabaseCore> database = components::DatabaseCore::Service();
  nsCOMPtr<nsIFolderDatabase> folderDB = database->GetFolderDB();
  uint32_t folderFlags;
  MOZ_TRY(folderDB->GetFolderFlags(folderId, &folderFlags));

  if (folderFlags & nsMsgFolderFlags::Virtual) {
    mFolderFilter = new VirtualFolderFilter(folderId);
  } else {
    mFolderFilter = new SingleFolderFilter(folderId);
  }
  return NS_OK;
}

NS_IMETHODIMP LiveView::InitWithFolders(nsTArray<uint64_t> const& folderIds) {
  if (folderIds.IsEmpty() || folderIds.Contains((uint64_t)0)) {
    NS_WARNING("Can't Init LiveView with 0 folderId in list");
    return NS_ERROR_INVALID_ARG;
  }
  if (mFolderFilter) {
    NS_WARNING("folder filter already set");
    return NS_ERROR_UNEXPECTED;
  }

  mFolderFilter = new MultiFolderFilter(folderIds);
  return NS_OK;
}

NS_IMETHODIMP LiveView::InitWithTag(const nsACString& aTag) {
  if (mFolderFilter) {
    NS_WARNING("folder filter already set");
    return NS_ERROR_UNEXPECTED;
  }

  mFolderFilter = new TaggedMessagesFilter(aTag, true);
  return NS_OK;
}

NS_IMETHODIMP LiveView::InitWithConversation(uint64_t aConversationId) {
  if (mFolderFilter) {
    NS_WARNING("folder filter already set");
    return NS_ERROR_UNEXPECTED;
  }

  mFolderFilter = new ConversationFilter(aConversationId);
  // Conversation view is always in date-ascending order.
  mSortColumn = nsILiveView::SortColumn::DATE;
  mSortDescending = false;
  return NS_OK;
}

NS_IMETHODIMP LiveView::InitWithUnreadMessages() {
  if (mFolderFilter) {
    NS_WARNING("folder filter already set");
    return NS_ERROR_UNEXPECTED;
  }

  mFolderFilter = new UnreadMessagesFilter();
  return NS_OK;
}

NS_IMETHODIMP LiveView::InitWithFlaggedMessages() {
  if (mFolderFilter) {
    NS_WARNING("folder filter already set");
    return NS_ERROR_UNEXPECTED;
  }

  mFolderFilter = new FlaggedMessagesFilter();
  return NS_OK;
}

NS_IMETHODIMP LiveView::InitWithDateRange(PRTime aStartDate, PRTime aEndDate) {
  if (mFolderFilter) {
    NS_WARNING("folder filter already set");
    return NS_ERROR_UNEXPECTED;
  }

  mFolderFilter = new DateRangeFilter(aStartDate, aEndDate);
  return NS_OK;
}

NS_IMETHODIMP LiveView::GetSortColumn(nsILiveView::SortColumn* aSortColumn) {
  *aSortColumn = mSortColumn;
  return NS_OK;
}

NS_IMETHODIMP LiveView::SetSortColumn(nsILiveView::SortColumn aSortColumn) {
  mSortColumn = aSortColumn;
  ResetStatements();
  return NS_OK;
}

NS_IMETHODIMP LiveView::GetSortDescending(bool* aSortDescending) {
  *aSortDescending = mSortDescending;
  return NS_OK;
}

NS_IMETHODIMP LiveView::SetSortDescending(bool aSortDescending) {
  mSortDescending = aSortDescending;
  ResetStatements();
  return NS_OK;
}

NS_IMETHODIMP LiveView::GetGrouping(nsILiveView::Grouping* aGrouping) {
  *aGrouping = mGrouping;
  return NS_OK;
}

NS_IMETHODIMP LiveView::SetGrouping(nsILiveView::Grouping aGrouping) {
  mGrouping = aGrouping;
  ResetStatements();
  return NS_OK;
}

void LiveView::ResetStatements() {
  ++mQueryGeneration;
  ++mConfigurationGeneration;
  if (mCountStmt) {
    mCountStmt->Finalize();
    mCountStmt = nullptr;
  }
  if (mCountUnreadStmt) {
    mCountUnreadStmt->Finalize();
    mCountUnreadStmt = nullptr;
  }
  if (mSelectStmt) {
    mSelectStmt->Finalize();
    mSelectStmt = nullptr;
  }
  if (mSelectGroupStmt) {
    mSelectGroupStmt->Finalize();
    mSelectGroupStmt = nullptr;
  }
}

/**
 * Create the WHERE part of an SQL query from the current filters.
 */
nsCString LiveView::GetSQLClause() {
  if (mClause.IsEmpty()) {
    mParams.Clear();
    if (mFolderFilter) {
      mClause.Append(mFolderFilter->mSQLClause);
      mParams.AppendElements(mFolderFilter->mSQLParams);
    }
    if (mClause.IsEmpty()) {
      mClause.Assign("1");
    }
  }
  return mClause;
}

NS_IMETHODIMP LiveView::GetSqlClauseForTests(nsACString& sqlClauseForTests) {
  if (!IsInAutomation()) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  sqlClauseForTests = GetSQLClause();
  return NS_OK;
}

NS_IMETHODIMP LiveView::GetSqlParamsForTests(
    nsTArray<RefPtr<nsIVariant>>& sqlParamsForTests) {
  if (!IsInAutomation()) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  sqlParamsForTests = mParams.Clone();
  return NS_OK;
}

/**
 * Fill the parameters in an SQL query from the current filters.
 */
void LiveView::PrepareStatement(mozIStorageStatement* statement) {
  for (size_t i = 0; i < mParams.Length(); i++) {
    statement->BindByIndex(i, mParams[i]);
  }
}

/**
 * Test if `aMessage` matches the current filters.
 */
bool LiveView::Matches(nsIMsgDBHdr* aMessage, uint64_t aFolderId) {
  if (mFolderFilter && !(mFolderFilter->Matches(aMessage, aFolderId))) {
    return false;
  }
  return true;
}

class CountMessagesListener final : public mozIStorageStatementCallback {
 public:
  nsMainThreadPtrHandle<Promise> mPromiseHolder;
  int64_t mResult;
  nsAutoCString mErrorMessage;

  explicit CountMessagesListener(JSContext* cx) {
    ErrorResult err;
    RefPtr<Promise> promise = Promise::Create(CurrentNativeGlobal(cx), err);
    mPromiseHolder = new nsMainThreadPtrHolder<Promise>(__func__, promise);
  }

  NS_DECL_ISUPPORTS

  NS_IMETHOD HandleError(mozIStorageError* error) override {
    error->GetMessage(mErrorMessage);
    return NS_OK;
  }
  NS_IMETHOD HandleResult(mozIStorageResultSet* resultSet) override {
    nsCOMPtr<mozIStorageRow> row;
    if (NS_SUCCEEDED(resultSet->GetNextRow(getter_AddRefs(row))) && row) {
      mResult = row->AsInt64(0);
    }
    return NS_OK;
  }
  NS_IMETHOD HandleCompletion(uint16_t reason) override {
    if (reason == mozIStorageStatementCallback::REASON_CANCELED) {
      mPromiseHolder.get()->MaybeRejectWithAbortError("SQL query cancelled.");
    } else if (reason == mozIStorageStatementCallback::REASON_ERROR) {
      mPromiseHolder.get()->MaybeRejectWithUnknownError(
          "SQL query failed: "_ns + mErrorMessage);
    }
    mPromiseHolder.get()->MaybeResolve(mResult);
    return NS_OK;
  }

 private:
  ~CountMessagesListener() {}
};
NS_IMPL_ISUPPORTS(CountMessagesListener, mozIStorageStatementCallback)

NS_IMETHODIMP LiveView::CountMessages(JSContext* cx, Promise** promise) {
  if (mBatchCapability) MOZ_TRY(CaptureQueryView(nullptr, mCountQuery));
  if (!mCountStmt) {
    nsAutoCString sql("SELECT COUNT(");
    if (mGrouping == nsILiveView::THREADED) {
      sql.Append("DISTINCT threadId");
    } else if (mGrouping == nsILiveView::GROUPED_BY_SORT) {
      switch (mSortColumn) {
        case nsILiveView::DATE:
          sql.Append("DISTINCT DATE_GROUP(date)");
          break;
        case nsILiveView::SortColumn::SUBJECT:
          sql.Append("DISTINCT COALESCE(subject, '') COLLATE locale");
          break;
        case nsILiveView::SortColumn::SENDER:
          sql.Append("DISTINCT COALESCE(sender, '') COLLATE locale");
          break;
        case nsILiveView::SortColumn::RECIPIENTS:
          sql.Append("DISTINCT COALESCE(recipients, '') COLLATE locale");
          break;
        default:
          MOZ_CRASH("Unexpected sort column for GROUPED_BY_SORT");
      }
    } else {
      sql.Append("*");
    }
    sql.Append(") AS count FROM messages WHERE ");
    sql.Append(GetSQLClause());
    MOZ_LOG(gPanoramaLog, LogLevel::Debug, ("LiveView SQL: %s", sql.get()));
    nsresult rv = DatabaseCore::sConnection->CreateStatement(
        sql, getter_AddRefs(mCountStmt));
    NS_ENSURE_SUCCESS(rv, rv);
  }
  mozStorageStatementScoper scoper(mCountStmt);

  PrepareStatement(mCountStmt);
  CountMessagesListener* listener = new CountMessagesListener(cx);
  nsCOMPtr<mozIStoragePendingStatement> unused;
  nsresult rv = mCountStmt->ExecuteAsync(listener, getter_AddRefs(unused));
  NS_ENSURE_SUCCESS(rv, rv);

  NS_ADDREF(*promise = listener->mPromiseHolder.get());
  return NS_OK;
}

NS_IMETHODIMP LiveView::CountUnreadMessages(JSContext* cx, Promise** promise) {
  if (!mCountUnreadStmt) {
    nsAutoCString sql("SELECT COUNT(");
    if (mGrouping == nsILiveView::THREADED) {
      sql.Append("DISTINCT threadId");
    } else if (mGrouping == nsILiveView::GROUPED_BY_SORT) {
      switch (mSortColumn) {
        case nsILiveView::DATE:
          sql.Append("DISTINCT DATE_GROUP(date)");
          break;
        case nsILiveView::SortColumn::SUBJECT:
          sql.Append("DISTINCT COALESCE(subject, '') COLLATE locale");
          break;
        case nsILiveView::SortColumn::SENDER:
          sql.Append("DISTINCT COALESCE(sender, '') COLLATE locale");
          break;
        case nsILiveView::SortColumn::RECIPIENTS:
          sql.Append("DISTINCT COALESCE(recipients, '') COLLATE locale");
          break;
        default:
          MOZ_CRASH("Unexpected sort column for GROUPED_BY_SORT");
      }
    } else {
      sql.Append("*");
    }
    sql.Append(") AS count FROM messages WHERE ");
    sql.Append(GetSQLClause());
    sql.AppendFmt(" AND ~flags & {}", (uint32_t)nsMsgMessageFlags::Read);
    MOZ_LOG(gPanoramaLog, LogLevel::Debug, ("LiveView SQL: %s", sql.get()));
    nsresult rv = DatabaseCore::sConnection->CreateStatement(
        sql, getter_AddRefs(mCountUnreadStmt));
    NS_ENSURE_SUCCESS(rv, rv);
  }
  mozStorageStatementScoper scoper(mCountUnreadStmt);

  PrepareStatement(mCountUnreadStmt);
  CountMessagesListener* listener = new CountMessagesListener(cx);
  nsCOMPtr<mozIStoragePendingStatement> unused;
  nsresult rv =
      mCountUnreadStmt->ExecuteAsync(listener, getter_AddRefs(unused));
  NS_ENSURE_SUCCESS(rv, rv);

  NS_ADDREF(*promise = listener->mPromiseHolder.get());
  return NS_OK;
}

class SelectMessagesListener final : public mozIStorageStatementCallback {
 public:
  nsMainThreadPtrHandle<Promise> mPromiseHolder;
  RefPtr<LiveView> mLiveView;
  uint32_t mColumnCount;
  Heap<JSObject*> mArr;
  uint32_t mStart = 0;
  uint32_t mCount;
  nsAutoCString mErrorMessage;
  nsCOMPtr<nsILiveViewListener> mListener;
  nsCOMPtr<mozIStoragePendingStatement> mPending;
  bool mGroupQuery;
  uint64_t mGeneration;

  bool IsCurrent() const {
    return mGeneration == (mGroupQuery ? mLiveView->mConfigurationGeneration
                                       : mLiveView->mQueryGeneration);
  }

  explicit SelectMessagesListener(JSContext* cx,
                                  nsCOMPtr<mozIStorageStatement> stmt,
                                  RefPtr<LiveView> liveView,
                                  nsCOMPtr<nsILiveViewListener> listener,
                                  bool groupQuery = false)
      : mLiveView(liveView),
        mListener(listener),
        mGroupQuery(groupQuery),
        mGeneration(groupQuery ? liveView->mConfigurationGeneration
                               : liveView->mQueryGeneration) {
    ErrorResult err;
    RefPtr<Promise> promise = Promise::Create(CurrentNativeGlobal(cx), err);
    mPromiseHolder = new nsMainThreadPtrHolder<Promise>(__func__, promise);
    stmt->GetColumnCount(&mColumnCount);

    mArr = NewArrayObject(cx, 0);
    mCount = 0;
    PROFILER_MARKER_TEXT(
        "SelectMessagesListener", MAILNEWS,
        mozilla::MarkerOptions(mozilla::MarkerTiming::IntervalStart()),
        "all results"_ns);
  }

  NS_DECL_ISUPPORTS

  NS_IMETHOD HandleError(mozIStorageError* error) override {
    error->GetMessage(mErrorMessage);
    return NS_OK;
  }
  NS_IMETHOD HandleResult(mozIStorageResultSet* resultSet) override {
    if (!IsCurrent()) return NS_OK;
    AUTO_PROFILER_LABEL("SelectMessagesListener::HandleResult", MAILNEWS);
    PROFILER_MARKER_TEXT("SelectMessagesListener", MAILNEWS, {}, "results"_ns);
    AutoJSAPI jsapi;
    if (!jsapi.Init(mPromiseHolder.get()->GetParentObject())) {
      mPromiseHolder.get()->MaybeRejectWithUnknownError(
          "Failed to get a JS API object");
      return NS_ERROR_FAILURE;
    }

    JSContext* cx = jsapi.cx();
    Rooted<JSObject*> arr(cx);
    arr = mArr;

    nsCOMPtr<mozIStorageRow> row;
    while (NS_SUCCEEDED(resultSet->GetNextRow(getter_AddRefs(row))) && row) {
      nsMsgKey id = (nsMsgKey)(row->AsInt64(0));
      uint64_t folderId = row->AsInt64(1);
      nsCString messageId;
      row->GetUTF8String(2, messageId);
      PRTime date = (PRTime)(row->AsDouble(3));
      nsCString sender;
      row->GetUTF8String(4, sender);
      nsCString recipients;
      row->GetUTF8String(5, recipients);
      nsCString subject;
      row->GetUTF8String(6, subject);
      uint32_t flags = (uint32_t)(row->AsInt64(7));
      if (mGroupQuery && mLiveView->mPublicStatus) {
        auto entry = mLiveView->mPublicStatus->rows.Lookup(id);
        if (entry && entry.Data().raw.folderId == folderId) {
          flags = (flags & ~nsMsgMessageFlags::New) |
                  (entry.Data().flags & nsMsgMessageFlags::New);
        }
      }
      nsCString tags;
      row->GetUTF8String(8, tags);
      nsMsgKey threadId = (nsMsgKey)(row->AsInt64(9));
      nsMsgKey threadParent = (nsMsgKey)(row->AsInt64(10));

      Rooted<JSObject*> obj(cx);
      CreateJSMessage(id, folderId, messageId.get(), date, sender.get(),
                      recipients.get(), subject.get(), flags, tags.get(),
                      threadId, threadParent, cx, obj);

      if (mColumnCount > 11) {
        if (mLiveView->mGrouping == nsILiveView::THREADED ||
            mLiveView->mGrouping == nsILiveView::GROUPED_BY_SORT) {
          uint64_t messageCount = row->AsInt64(11);
          JS_DefineProperty(cx, obj, "messageCount", (double)(messageCount),
                            JSPROP_ENUMERATE);
          uint64_t newCount = row->AsInt64(12);
          JS_DefineProperty(cx, obj, "newCount", (double)(newCount),
                            JSPROP_ENUMERATE);
          uint64_t unreadCount = row->AsInt64(13);
          JS_DefineProperty(cx, obj, "unreadCount", (double)(unreadCount),
                            JSPROP_ENUMERATE);
        }
        if (mLiveView->mGrouping == nsILiveView::GROUPED_BY_SORT &&
            mLiveView->mSortColumn == nsILiveView::DATE) {
          uint64_t dateGroup = row->AsInt64(14);
          JS_DefineProperty(cx, obj, "dateGroup", (double)(dateGroup),
                            JSPROP_ENUMERATE);
        }
      }

      Rooted<Value> message(cx, ObjectValue(*obj));
      JS_DefineElement(cx, arr, mCount++, message, JSPROP_ENUMERATE);
    }

    if (mListener &&
        mCount - mStart >= StaticPrefs::mail_panorama_liveViewChunkSize()) {
      Rooted<Value> obj(cx, ObjectValue(*arr));
      mListener->OnSelectedChunk(obj, mStart, mCount - 1);
      mStart = mCount;
    }
    return NS_OK;
  }
  NS_IMETHOD HandleCompletion(uint16_t reason) override {
    if (mLiveView->mPendingStmt == mPending) mLiveView->mPendingStmt = nullptr;
    mPending = nullptr;
    if (!IsCurrent()) {
      mPromiseHolder.get()->MaybeRejectWithAbortError(
          "View query invalidated.");
      return NS_OK;
    }
    AUTO_PROFILER_LABEL("SelectMessagesListener::HandleCompletion", MAILNEWS);
    PROFILER_MARKER_TEXT(
        "SelectMessagesListener", MAILNEWS,
        mozilla::MarkerOptions(mozilla::MarkerTiming::IntervalEnd()),
        "all results"_ns);
    if (reason == mozIStorageStatementCallback::REASON_CANCELED) {
      mPromiseHolder.get()->MaybeRejectWithAbortError("SQL query cancelled.");
      return NS_OK;
    }
    if (reason == mozIStorageStatementCallback::REASON_ERROR) {
      mPromiseHolder.get()->MaybeRejectWithUnknownError(
          "SQL query failed: "_ns + mErrorMessage);
      return NS_OK;
    }

    AutoJSAPI jsapi;
    if (!jsapi.Init(mPromiseHolder.get()->GetParentObject())) {
      mPromiseHolder.get()->MaybeRejectWithUnknownError(
          "Failed to get a JS API object");
      return NS_ERROR_FAILURE;
    }

    JSContext* cx = jsapi.cx();
    Rooted<JSObject*> arr(cx, mArr);
    if (mListener && mCount != mStart) {
      Rooted<Value> obj(cx, ObjectValue(*arr));
      mListener->OnSelectedChunk(obj, mStart, mCount - 1);
      mStart = mCount;
    }

    if (!IsCurrent()) {
      mPromiseHolder.get()->MaybeRejectWithAbortError(
          "View query invalidated.");
      return NS_OK;
    }
    mPromiseHolder.get()->MaybeResolve(arr);
    return NS_OK;
  }

 private:
  ~SelectMessagesListener() {}
};
NS_IMPL_ISUPPORTS(SelectMessagesListener, mozIStorageStatementCallback)

/**
 * Create an object of JS primitives representing a message.
 */
void CreateJSMessage(uint64_t id, uint64_t folderId, const char* messageId,
                     PRTime date, const char* sender, const char* recipients,
                     const char* subject, uint64_t flags, const char* tags,
                     uint64_t threadId, uint64_t threadParent, JSContext* cx,
                     Rooted<JSObject*>& obj) {
  obj.set(JS_NewPlainObject(cx));

  JS_DefineProperty(cx, obj, "id", (double)(id), JSPROP_ENUMERATE);

  JS_DefineProperty(cx, obj, "folderId", (double)(folderId), JSPROP_ENUMERATE);

  Rooted<JSString*> val1(cx);
  if (messageId)
    val1 = JS_NewStringCopyUTF8Z(cx, ConstUTF8CharsZ(messageId));
  else
    val1 = JS_GetEmptyString(cx);
  JS_DefineProperty(cx, obj, "messageId", val1, JSPROP_ENUMERATE);

  Rooted<JSObject*> val2(cx,
                         NewDateObject(cx, TimeClip(date / PR_USEC_PER_MSEC)));
  JS_DefineProperty(cx, obj, "date", val2, JSPROP_ENUMERATE);

  Rooted<JSString*> val3(cx);
  if (sender)
    val3 = JS_NewStringCopyUTF8Z(cx, ConstUTF8CharsZ(sender));
  else
    val3 = JS_GetEmptyString(cx);
  JS_DefineProperty(cx, obj, "sender", val3, JSPROP_ENUMERATE);

  Rooted<JSString*> val4(cx);
  if (recipients)
    val4 = JS_NewStringCopyUTF8Z(cx, ConstUTF8CharsZ(recipients));
  else
    val4 = JS_GetEmptyString(cx);
  JS_DefineProperty(cx, obj, "recipients", val4, JSPROP_ENUMERATE);

  Rooted<JSString*> val5(cx);
  if (subject)
    val5 = JS_NewStringCopyUTF8Z(cx, ConstUTF8CharsZ(subject));
  else
    val5 = JS_GetEmptyString(cx);
  JS_DefineProperty(cx, obj, "subject", val5, JSPROP_ENUMERATE);

  JS_DefineProperty(cx, obj, "flags", (double)(flags), JSPROP_ENUMERATE);

  Rooted<JSString*> val6(cx);
  if (tags)
    val6 = JS_NewStringCopyUTF8Z(cx, ConstUTF8CharsZ(tags));
  else
    val6 = JS_GetEmptyString(cx);
  JS_DefineProperty(cx, obj, "tags", val6, JSPROP_ENUMERATE);

  JS_DefineProperty(cx, obj, "threadId", (double)(threadId), JSPROP_ENUMERATE);
  JS_DefineProperty(cx, obj, "threadParent", (double)(threadParent),
                    JSPROP_ENUMERATE);
}

/**
 * Create an object of JS primitives representing a message.
 */
void CreateJSMessage(Message* aMessage, JSContext* cx, Rooted<JSObject*>& obj) {
  // Yes. This is a bit clunky for now.
  nsAutoCString messageId;
  PRTime date;
  nsAutoCString sender;
  nsAutoCString recipients;
  nsAutoCString subject;
  uint32_t flags;
  nsAutoCString tags;
  nsMsgKey threadId;
  nsMsgKey threadParent;

  aMessage->GetMessageId(messageId);
  aMessage->GetDate(&date);
  aMessage->GetAuthor(sender);
  aMessage->GetRecipients(recipients);
  aMessage->GetSubject(subject);
  aMessage->GetFlags(&flags);
  aMessage->GetStringProperty("keywords", tags);
  aMessage->GetThreadId(&threadId);
  aMessage->GetThreadParent(&threadParent);

  CreateJSMessage(aMessage->Key(), aMessage->FolderId(), messageId.get(), date,
                  sender.get(), recipients.get(), subject.get(), flags,
                  tags.get(), (uint64_t)threadId, (uint64_t)threadParent, cx,
                  obj);
}

nsCString LiveView::SelectSQL() {
  // FIXME: Address formatting is temporarily disabled.
  nsAutoCString sql(
      "SELECT \
          id, \
          folderId, \
          messageId, \
          date, \
          sender AS formattedSender, \
          recipients AS formattedRecipients, \
          subject, ");
  sql.Append(mPublicFlagsSQL);
  sql.Append(
      " AS flags, \
          tags, \
          threadId, \
          threadParent");
  if (mGrouping == nsILiveView::THREADED ||
      mGrouping == nsILiveView::GROUPED_BY_SORT) {
    sql.Append(", COUNT(*) AS messageCount");
    sql.Append(", SUM((");
    sql.Append(mPublicFlagsSQL);
    sql.AppendFmt(") & {} != 0) AS newCount", (uint32_t)nsMsgMessageFlags::New);
    sql.AppendFmt(", SUM(flags & {} = 0) AS unreadCount",
                  (uint32_t)nsMsgMessageFlags::Read);
  }
  if (mGrouping == nsILiveView::THREADED) {
    // Get only the newest message in each thread. This is the last column
    // and only exists to tell SQLite what to do, we don't use this data.
    sql.Append(", MAX(date) AS maxDate");
  } else if (mGrouping == nsILiveView::GROUPED_BY_SORT &&
             mSortColumn == nsILiveView::DATE) {
    sql.Append(", DATE_GROUP(date) AS dateGroup");
  }
  sql.Append(" FROM messages WHERE ");
  sql.Append(GetSQLClause());
  if (mGrouping == nsILiveView::THREADED) {
    sql.Append(" GROUP BY threadId ");
  } else if (mGrouping == nsILiveView::GROUPED_BY_SORT) {
    sql.Append(" GROUP BY ");
    switch (mSortColumn) {
      case nsILiveView::SortColumn::DATE:
        sql.Append("dateGroup ");
        break;
      case nsILiveView::SortColumn::SUBJECT:
        sql.Append("COALESCE(subject, '') COLLATE locale ");
        break;
      case nsILiveView::SortColumn::SENDER:
        sql.Append("COALESCE(formattedSender, '') COLLATE locale ");
        break;
      case nsILiveView::SortColumn::RECIPIENTS:
        sql.Append("COALESCE(formattedRecipients, '') COLLATE locale ");
        break;
      default:
        MOZ_CRASH("Unexpected sort column for GROUPED_BY_SORT");
    }
  }
  sql.Append(" ORDER BY ");
  switch (mSortColumn) {
    case nsILiveView::SortColumn::DATE:
      if (mGrouping == nsILiveView::GROUPED_BY_SORT) {
        sql.Append("dateGroup");
      } else {
        sql.Append("date");
      }
      break;
    case nsILiveView::SortColumn::SUBJECT:
      sql.Append("subject COLLATE locale");
      break;
    case nsILiveView::SortColumn::SENDER:
      sql.Append("formattedSender COLLATE locale");
      break;
    case nsILiveView::SortColumn::RECIPIENTS:
      sql.Append("formattedRecipients COLLATE locale");
      break;
    case nsILiveView::SortColumn::READ_FLAG:
      // Unread messages should be first when sorted in ascending order.
      sql.AppendFmt("flags & {}", (uint32_t)nsMsgMessageFlags::Read);
      break;
    case nsILiveView::SortColumn::MARKED_FLAG:
      // Twisted logic alert:
      // Marked messages should be first when sorted in ascending order.
      // The ~ flips the flags so marked = 0, unmarked = 1, and we
      // don't have to mess with the ascending/descending logic.
      sql.AppendFmt("~flags & {}", (uint32_t)nsMsgMessageFlags::Marked);
      break;
  }
  sql.Append(mSortDescending ? " DESC" : " ASC");
  return sql;
}

NS_IMETHODIMP LiveView::SelectMessages(JSContext* cx, Promise** promise) {
  AUTO_PROFILER_LABEL("LiveView::SelectMessages", MAILNEWS);
  ++mQueryGeneration;
  MOZ_TRY(RefreshPublicStatus());
  if (mBatchCapability) MOZ_TRY(CaptureQueryView(nullptr, mMappedQuery));
  if (mPendingStmt) {
    mPendingStmt->Cancel();
  }
  if (!mSelectStmt) {
    MOZ_TRY(Connection()->CreateStatement(SelectSQL(),
                                          getter_AddRefs(mSelectStmt)));
  }

  PrepareStatement(mSelectStmt);

  RefPtr<SelectMessagesListener> listener =
      new SelectMessagesListener(cx, mSelectStmt, this, mListener);
  nsresult rv =
      mSelectStmt->ExecuteAsync(listener, getter_AddRefs(listener->mPending));
  NS_ENSURE_SUCCESS(rv, rv);

  mPendingStmt = listener->mPending;

  NS_ADDREF(*promise = listener->mPromiseHolder.get());
  return NS_OK;
}

nsCString LiveView::SelectGroupSQL() {
  // FIXME: Address formatting is temporarily disabled.
  nsAutoCString sql(
      "SELECT \
          id, \
          folderId, \
          messageId, \
          date, \
          sender AS formattedSender, \
          recipients AS formattedRecipients, \
          subject, \
          flags, \
          tags, \
          threadId, \
          threadParent \
        FROM messages WHERE ");
  sql.Append(GetSQLClause());
  if (mGrouping == nsILiveView::THREADED) {
    sql.Append(" AND threadId = :group ORDER BY date ASC");
  } else if (mGrouping == nsILiveView::GROUPED_BY_SORT) {
    switch (mSortColumn) {
      case nsILiveView::SortColumn::DATE:
        sql.Append(" AND DATE_GROUP(date) = :group ORDER BY date");
        sql.Append(mSortDescending ? " DESC" : " ASC");
        break;
      case nsILiveView::SortColumn::SUBJECT:
        sql.Append(" AND COALESCE(subject, '') = :group COLLATE locale");
        // TODO: Does this ordering make sense?
        sql.Append(" ORDER BY date DESC");
        break;
      case nsILiveView::SortColumn::SENDER:
        sql.Append(
            " AND COALESCE(formattedSender, '') = :group COLLATE locale");
        // TODO: Does this ordering make sense?
        sql.Append(" ORDER BY date DESC");
        break;
      case nsILiveView::SortColumn::RECIPIENTS:
        sql.Append(
            " AND COALESCE(formattedRecipients, '') = :group COLLATE locale");
        // TODO: Does this ordering make sense?
        sql.Append(" ORDER BY date DESC");
        break;
      default:
        MOZ_CRASH("Unexpected sort column for GROUPED_BY_SORT");
    }
  } else {
    MOZ_CRASH("Unexpected grouping");
  }
  return sql;
}

NS_IMETHODIMP LiveView::SelectMessagesInGroup(const nsACString& group,
                                              JSContext* cx,
                                              Promise** promise) {
  AUTO_PROFILER_LABEL("LiveView::SelectMessagesInGroup", MAILNEWS);
  if (mPendingStmt) {
    mPendingStmt->Cancel();
  }
  if (!mSelectGroupStmt) {
    MOZ_TRY(Connection()->CreateStatement(SelectGroupSQL(),
                                          getter_AddRefs(mSelectGroupStmt)));
  }

  PrepareStatement(mSelectGroupStmt);
  if (mGrouping == nsILiveView::THREADED || mSortColumn == nsILiveView::DATE) {
    nsresult rv;
    int64_t groupInt = group.ToInteger(&rv);
    NS_ENSURE_SUCCESS(rv, rv);
    mSelectGroupStmt->BindInt64ByName("group"_ns, groupInt);
  } else {
    mSelectGroupStmt->BindUTF8StringByName("group"_ns, group);
  }

  RefPtr<SelectMessagesListener> listener =
      new SelectMessagesListener(cx, mSelectGroupStmt, this, nullptr, true);
  nsresult rv = mSelectGroupStmt->ExecuteAsync(
      listener, getter_AddRefs(listener->mPending));
  NS_ENSURE_SUCCESS(rv, rv);

  mPendingStmt = listener->mPending;

  NS_ADDREF(*promise = listener->mPromiseHolder.get());
  return NS_OK;
}

nsresult LiveView::MatchesCaptured(const CapturedMessage& message,
                                   bool& matches) {
  RefPtr<DetachedMsgHdr> header =
      new (fallible) DetachedMsgHdr(message.folderId);
  NS_ENSURE_TRUE(header, NS_ERROR_OUT_OF_MEMORY);
  MOZ_TRY(header->SetFlags(message.flags));
  MOZ_TRY(header->SetDate(message.date));
  MOZ_TRY(header->SetThreadId(message.threadId));
  MOZ_TRY(header->SetStringProperty("keywords", message.tags));
  matches = Matches(header, message.folderId);
  return NS_OK;
}

void LiveView::NotifyCaptured(const CapturedMessage* before,
                              const CapturedMessage* after,
                              CapturedChange change) {
  if (!mListener) return;
  nsCOMPtr<nsILiveViewListener> listener = mListener;
  RefPtr<LiveViewBatchCapability> capability = mBatchCapability;
  uint64_t attachment = mAttachmentGeneration;
  bool was = false, now = false;
  if ((before && NS_FAILED(MatchesCaptured(*before, was))) ||
      (after && NS_FAILED(MatchesCaptured(*after, now)))) {
    if (capability)
      InvalidateCapturedConsumer(listener, capability, attachment);
    return;
  }
  if (!was && !now) return;
  AutoJSAPI jsapi;
  if (!jsapi.Init(PrivilegedJunkScope())) {
    if (capability)
      InvalidateCapturedConsumer(listener, capability, attachment);
    return;
  }
  JSContext* cx = jsapi.cx();
  Rooted<JSObject*> object(cx);
  const auto& row = now ? *after : *before;
  uint32_t flags = row.flags;
  uint32_t displayedBefore = before ? before->flags : flags;
  if (mPublicStatus) {
    auto entry = mPublicStatus->rows.Lookup(row.id);
    if (entry && entry.Data().raw.folderId == row.folderId) {
      displayedBefore = entry.Data().flags;
      bool extraNew = (displayedBefore & nsMsgMessageFlags::New) &&
                      !(entry.Data().raw.flags & nsMsgMessageFlags::New);
      if (before && after &&
          (((before->flags ^ after->flags) & nsMsgMessageFlags::Read) ||
           ((before->flags & nsMsgMessageFlags::New) &&
            !(after->flags & nsMsgMessageFlags::New))))
        extraNew = false;
      if (extraNew) flags |= nsMsgMessageFlags::New;
      entry.Data().raw = row;
      entry.Data().flags = flags;
      if (!now) entry.Remove();
      if (change == CapturedChange::Flags && before && after &&
          before->flags != after->flags && displayedBefore == flags)
        return;
    }
  }
  // Ordinary metadata views also expose unassigned folders. Serialize the
  // captured scalars using their existing row contract, without a live header.
  CreateJSMessage(row.id, row.folderId, row.messageId.get(), row.date,
                  row.sender.get(), row.recipients.get(), row.subject.get(),
                  flags, row.tags.get(), row.threadId, row.threadParent, cx,
                  object);
  if (!object || JS_IsExceptionPending(cx)) {
    if (capability)
      InvalidateCapturedConsumer(listener, capability, attachment);
    return;
  }
  Rooted<Value> value(cx, ObjectValue(*object));
  nsresult rv = NS_OK;
  if (!was)
    rv = listener->OnMessageAdded(value);
  else if (!now)
    rv = listener->OnMessageRemoved(value);
  else if (change == CapturedChange::Flags)
    rv = listener->OnMessageFlagsChanged(value, displayedBefore);
  else if (change == CapturedChange::Tags)
    rv = listener->OnMessageTagsChanged(value, before->tags);
  if (NS_FAILED(rv) && capability)
    InvalidateCapturedConsumer(listener, capability, attachment);
}

void LiveView::OnMessagePublishedCaptured(const CapturedMessage& after,
                                          Message*, bool) {
  NotifyCaptured(nullptr, &after, CapturedChange::Added);
}
void LiveView::OnMessageRemovedCaptured(const CapturedMessage& before,
                                        Message*) {
  NotifyCaptured(&before, nullptr, CapturedChange::Removed);
}
void LiveView::OnMessageFlagsChangedCaptured(const CapturedMessage& before,
                                             const CapturedMessage& after,
                                             nsIMsgDBHdr*, Message*) {
  NotifyCaptured(&before, &after, CapturedChange::Flags);
}
void LiveView::OnMessageTagsChangedCaptured(const CapturedMessage& before,
                                            const CapturedMessage& after,
                                            nsIMsgDBHdr*, Message*) {
  NotifyCaptured(&before, &after, CapturedChange::Tags);
}
void LiveView::OnMessageBodyChangedCaptured(const CapturedMessage& before,
                                            const CapturedMessage& after,
                                            nsIMsgDBHdr*, Message*,
                                            const MessageBodyState& oldBody,
                                            const MessageBodyState& newBody) {
  if (oldBody.flags != newBody.flags)
    NotifyCaptured(&before, &after, CapturedChange::Flags);
}

void LiveView::OnMessageAdded(Message* aMessage) {
  if (!mListener || !Matches(aMessage, aMessage->FolderId())) {
    return;
  }

  AutoJSAPI jsapi;
  if (!jsapi.Init(PrivilegedJunkScope())) {
    return;
  }
  JSContext* cx = jsapi.cx();

  Rooted<JSObject*> obj(cx);
  CreateJSMessage(aMessage, cx, obj);
  Rooted<Value> message(cx, ObjectValue(*obj));
  MutableHandle<Value> handle(&message);
  mListener->OnMessageAdded(handle);
}

void LiveView::OnMessageRemoved(Message* aMessage, uint32_t oldFlags) {
  if (!mListener || !Matches(aMessage, aMessage->FolderId())) {
    return;
  }

  AutoJSAPI jsapi;
  if (!jsapi.Init(PrivilegedJunkScope())) {
    return;
  }
  JSContext* cx = jsapi.cx();

  Rooted<JSObject*> obj(cx);
  CreateJSMessage(aMessage, cx, obj);
  Rooted<Value> message(cx, ObjectValue(*obj));
  MutableHandle<Value> handle(&message);
  mListener->OnMessageRemoved(handle);
}

bool LiveView::CheckIfChangeMatches(nsIMsgDBHdr* oldMessage,
                                    Message* newMessage) {
  // Flag and tag changes preserve the folder identity of both snapshots.
  uint64_t folderId = newMessage->FolderId();
  bool matchesOld = Matches(oldMessage, folderId);
  bool matchesNew = Matches(newMessage, folderId);

  if (matchesNew && matchesOld) {
    // This is a change we are interested in. Return true so the caller files
    // a notification.
    return true;
  }

  if (!matchesNew && !matchesOld) {
    // This is a change we aren't interested in.
    return false;
  }

  AutoJSAPI jsapi;
  if (!jsapi.Init(PrivilegedJunkScope())) {
    return false;
  }
  JSContext* cx = jsapi.cx();

  Rooted<JSObject*> obj(cx);
  CreateJSMessage(newMessage, cx, obj);
  Rooted<Value> message(cx, ObjectValue(*obj));
  MutableHandle<Value> handle(&message);

  if (matchesNew) {
    // We weren't interested in this message, but now we are.
    mListener->OnMessageAdded(handle);
  } else {
    // We were interested in this message, but now we aren't.
    mListener->OnMessageRemoved(handle);
  }
  return false;
}

void LiveView::OnMessageFlagsChanged(nsIMsgDBHdr* oldMessage,
                                     Message* newMessage, uint32_t oldFlags,
                                     uint32_t newFlags) {
  if (!mListener || !CheckIfChangeMatches(oldMessage, newMessage)) {
    return;
  }

  AutoJSAPI jsapi;
  if (!jsapi.Init(PrivilegedJunkScope())) {
    return;
  }
  JSContext* cx = jsapi.cx();

  Rooted<JSObject*> obj(cx);
  CreateJSMessage(newMessage, cx, obj);
  Rooted<Value> message(cx, ObjectValue(*obj));
  MutableHandle<Value> handle(&message);
  mListener->OnMessageFlagsChanged(handle, oldFlags);
}

void LiveView::OnMessageTagsChanged(nsIMsgDBHdr* oldMessage,
                                    Message* newMessage,
                                    const nsACString& oldTags,
                                    const nsACString& newTags) {
  if (!mListener || !CheckIfChangeMatches(oldMessage, newMessage)) {
    return;
  }

  AutoJSAPI jsapi;
  if (!jsapi.Init(PrivilegedJunkScope())) {
    return;
  }
  JSContext* cx = jsapi.cx();

  Rooted<JSObject*> obj(cx);
  CreateJSMessage(newMessage, cx, obj);
  Rooted<Value> message(cx, ObjectValue(*obj));
  MutableHandle<Value> handle(&message);

  mListener->OnMessageTagsChanged(handle, oldTags);
}

NS_IMETHODIMP LiveView::SetListener(nsILiveViewListener* aListener) {
  RefPtr<LiveViewBatchCapability> capability;
  if (aListener) MOZ_TRY(ReadBatchCapability(aListener, capability));
  bool sameOwner = capability && mBatchCapability &&
                   capability->owner.get() == mBatchCapability->owner.get();
  if (!sameOwner) {
    mMappedQuery = nullptr;
    mCountQuery = nullptr;
  } else if (mCountQuery &&
             mCountQuery->viewGeneration == capability->generation &&
             mCountQuery->configuration == mConfigurationGeneration) {
    mMappedQuery = mCountQuery;
  }
  ClearPublicStatus();
  bool hadListener = mListener;
  mListener = aListener;
  mBatchCapability = capability;
  ++mAttachmentGeneration;
  if (!hadListener && aListener) MessageDB().AddMessageListener(this);
  if (hadListener && !aListener) MessageDB().RemoveMessageListener(this);
  return NS_OK;
}

NS_IMETHODIMP LiveView::ClearListener(nsILiveViewListener* aListener) {
  if (aListener && aListener != mListener) {
    return NS_OK;
  }

  ClearPublicStatus();
  mListener = nullptr;
  mBatchCapability = nullptr;
  mMappedQuery = nullptr;
  mCountQuery = nullptr;
  ++mAttachmentGeneration;
  ++mQueryGeneration;
  MessageDB().RemoveMessageListener(this);
  return NS_OK;
}

}  // namespace mozilla::mailnews
