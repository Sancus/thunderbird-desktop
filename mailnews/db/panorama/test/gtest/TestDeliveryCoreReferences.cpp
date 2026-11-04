/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <functional>
#include <utility>

#include "DatabaseCore.h"
#include "FolderDatabase.h"
#include "js/JSON.h"
#ifdef XP_WIN
#  include "MigrationFileSystem.h"
#endif
#include "Message.h"
#include "MessageDatabase.h"
#include "PerFolderDatabase.h"
#include "mozIStorageConnection.h"
#include "mozIStorageFunction.h"
#include "mozIStorageProgressHandler.h"
#include "mozIStorageService.h"
#include "mozIStorageStatement.h"
#include "mozIStorageValueArray.h"
#include "mozStorageHelper.h"
#include "mozilla/ResultExtensions.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/SpinEventLoopUntil.h"
#include "mozilla/Try.h"
#include "mozilla/dom/ScriptSettings.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsComponentManagerUtils.h"
#include "nsDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "nsIEventTarget.h"
#include "nsIFile.h"
#include "nsIInputStream.h"
#include "nsIInterfaceRequestorUtils.h"
#include "nsIMsgDatabase.h"
#include "nsIMsgFolder.h"
#include "nsIMsgOfflineImapOperation.h"
#include "nsIProperties.h"
#include "nsIVariant.h"
#include "nsImapCore.h"
#include "nsLocalFile.h"
#include "nsMsgFolderFlags.h"
#include "nsMsgKeySet.h"
#include "nsMsgMessageFlags.h"
#include "nsNetUtil.h"
#include "nsServiceManagerUtils.h"
#include "nsThreadUtils.h"
#include "xpcpublic.h"
#include "gtest/gtest.h"

namespace mozilla::mailnews {
namespace {

// Captured unversioned layout at 531bc469, without reconstructing lost tokens.
constexpr auto kOldSchema =
    "CREATE TABLE folders(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES "
    "folders(id), "
    "ordinal INTEGER DEFAULT NULL, name TEXT, flags INTEGER DEFAULT 0, "
    "UNIQUE(parent,name));"
    "CREATE TABLE folder_properties(id INTEGER REFERENCES folders(id), name "
    "TEXT, value ANY, PRIMARY KEY(id,name));"
    "CREATE TABLE messages(id INTEGER PRIMARY KEY, folderId INTEGER REFERENCES "
    "folders(id), "
    "threadId INTEGER REFERENCES messages(id), threadParent INTEGER REFERENCES "
    "messages(id), "
    "messageId TEXT, date INTEGER, sender TEXT, recipients TEXT, ccList TEXT, "
    "bccList TEXT, "
    "subject TEXT, flags INTEGER, tags TEXT, priority INTEGER);"
    "CREATE TABLE message_properties(id INTEGER REFERENCES messages(id), name "
    "TEXT, value ANY, PRIMARY KEY(id,name));"
    "CREATE TABLE virtualFolder_folders(virtualFolderId INTEGER REFERENCES "
    "folders(id), searchFolderId INTEGER REFERENCES folders(id));"
    "CREATE TABLE search_folder_hits(folder_id INTEGER REFERENCES folders(id), message_id INTEGER REFERENCES messages(id), PRIMARY KEY(folder_id,message_id));"_ns;

class FaultWitness final : public mozIStorageFunction {
 public:
  NS_DECL_ISUPPORTS
  uint32_t mCalls = 0;
  int64_t mLastKey = 0;
  nsresult mFailure = NS_OK;
  NS_IMETHOD OnFunctionCall(mozIStorageValueArray* args,
                            nsIVariant** result) override {
    ++mCalls;
    MOZ_TRY(args->GetInt64(0, &mLastKey));
    NS_ENSURE_SUCCESS(mFailure, mFailure);
    nsCOMPtr<nsIWritableVariant> value =
        do_CreateInstance("@mozilla.org/variant;1");
    NS_ENSURE_STATE(value);
    nsresult rv = value->SetAsInt32(0);
    NS_ENSURE_SUCCESS(rv, rv);
    nsCOMPtr<nsIVariant> returned = value;
    returned.forget(result);
    return NS_OK;
  }

 private:
  ~FaultWitness() = default;
};
NS_IMPL_ISUPPORTS(FaultWitness, mozIStorageFunction)

class UndoRemovalObserver final : public MessageListener {
 public:
  NS_DECL_ISUPPORTS
  explicit UndoRemovalObserver(std::function<void(Message*)> removed)
      : mRemoved(std::move(removed)) {}
  void OnMessageAdded(Message*) override {}
  void OnMessageRemoved(Message* message, uint32_t) override {
    mRemoved(message);
  }
  void OnMessageFlagsChanged(nsIMsgDBHdr*, Message*, uint32_t,
                             uint32_t) override {}
  void OnMessageTagsChanged(nsIMsgDBHdr*, Message*, const nsACString&,
                            const nsACString&) override {}

 private:
  ~UndoRemovalObserver() = default;
  std::function<void(Message*)> mRemoved;
};
NS_IMPL_ISUPPORTS(UndoRemovalObserver, nsISupports)

class PendingHeaderObserver final : public MessageListener {
 public:
  NS_DECL_ISUPPORTS
  explicit PendingHeaderObserver(std::function<void(Message*)> added)
      : mCallback(std::move(added)) {}
  uint32_t mAdded = 0;
  uint32_t mChanged = 0;
  void OnMessageAdded(Message* message) override {
    ++mAdded;
    mCallback(message);
  }
  void OnMessageRemoved(Message*, uint32_t) override { ++mChanged; }
  void OnMessageFlagsChanged(nsIMsgDBHdr*, Message*, uint32_t,
                             uint32_t) override {
    ++mChanged;
  }
  void OnMessageTagsChanged(nsIMsgDBHdr*, Message*, const nsACString&,
                            const nsACString&) override {
    ++mChanged;
  }
  void OnMessageBodyChanged(nsIMsgDBHdr*, Message*, const MessageBodyState&,
                            const MessageBodyState&) override {
    ++mChanged;
  }

 private:
  ~PendingHeaderObserver() = default;
  std::function<void(Message*)> mCallback;
};
NS_IMPL_ISUPPORTS(PendingHeaderObserver, nsISupports)

class AddedObserver final : public MessageListener {
 public:
  NS_DECL_ISUPPORTS
  explicit AddedObserver(std::function<void(Message*)> added)
      : mAdded(std::move(added)) {}
  void OnMessageAdded(Message* message) override { mAdded(message); }
  void OnMessageRemoved(Message*, uint32_t) override {}
  void OnMessageFlagsChanged(nsIMsgDBHdr*, Message*, uint32_t,
                             uint32_t) override {}
  void OnMessageTagsChanged(nsIMsgDBHdr*, Message*, const nsACString&,
                            const nsACString&) override {}

 private:
  ~AddedObserver() = default;
  std::function<void(Message*)> mAdded;
};
NS_IMPL_ISUPPORTS(AddedObserver, nsISupports)

class ThreadViewBefore final : public nsISupports {
 public:
  NS_DECL_ISUPPORTS
  nsTArray<CapturedMessage> rows;

 private:
  ~ThreadViewBefore() = default;
};
NS_IMPL_ISUPPORTS(ThreadViewBefore, nsISupports)

class ThreadQueueObserver final : public MessageListener {
 public:
  NS_DECL_ISUPPORTS
  using MessageListener::PrepareThreadBatch;
  std::function<void(char, const CapturedMessage&, const CapturedMessage&,
                     Message*, bool)>
      action;
  std::function<nsresult(nsCOMPtr<nsISupports>&)> captureView;
  std::function<nsresult(const MessageThreadBatch&, nsISupports*,
                         PreparedThreadBatch&)>
      prepareView;
  nsresult CaptureThreadViewBeforeInsert(
      nsCOMPtr<nsISupports>& output) override {
    return captureView ? captureView(output) : NS_OK;
  }
  nsresult PrepareThreadBatch(const MessageThreadBatch& batch,
                              nsISupports* beforeView,
                              PreparedThreadBatch& output) override {
    return prepareView ? prepareView(batch, beforeView, output)
                       : MessageListener::PrepareThreadBatch(batch, output);
  }
  MessageBodyState oldBody, newBody;
  uint32_t ordinary = 0;
  bool SupportsThreadChanges() const override { return true; }
  void OnMessageAdded(Message*) override { ++ordinary; }
  void OnMessageRemoved(Message*, uint32_t) override { ++ordinary; }
  void OnMessageFlagsChanged(nsIMsgDBHdr*, Message*, uint32_t,
                             uint32_t) override {
    ++ordinary;
  }
  void OnMessageTagsChanged(nsIMsgDBHdr*, Message*, const nsACString&,
                            const nsACString&) override {
    ++ordinary;
  }
  void OnMessageThreadChanged(const CapturedMessage& before,
                              const CapturedMessage& after,
                              Message* live) override {
    if (action) {
      action('T', before, after, live, true);
    }
  }
  void OnMessagePublishedCaptured(const CapturedMessage& after, Message* live,
                                  bool notify) override {
    if (action) {
      action('P', after, after, live, notify);
    }
  }
  void OnMessageRemovedCaptured(const CapturedMessage& before,
                                Message* live) override {
    if (action) {
      action('R', before, before, live, true);
    }
  }
  void OnMessageFlagsChangedCaptured(const CapturedMessage& before,
                                     const CapturedMessage& after, nsIMsgDBHdr*,
                                     Message* live) override {
    if (action) {
      action('F', before, after, live, true);
    }
  }
  void OnMessageTagsChangedCaptured(const CapturedMessage& before,
                                    const CapturedMessage& after, nsIMsgDBHdr*,
                                    Message* live) override {
    if (action) {
      action('G', before, after, live, true);
    }
  }
  void OnMessageBodyChangedCaptured(const CapturedMessage& before,
                                    const CapturedMessage& after, nsIMsgDBHdr*,
                                    Message* live,
                                    const MessageBodyState& oldValue,
                                    const MessageBodyState& newValue) override {
    oldBody = oldValue;
    newBody = newValue;
    if (action) {
      action('B', before, after, live, true);
    }
  }

 private:
  ~ThreadQueueObserver() = default;
};
NS_IMPL_ISUPPORTS(ThreadQueueObserver, nsISupports)

}  // namespace

class RecoveryPlanOwner final : public nsISupports, public SupportsWeakPtr {
 public:
  NS_DECL_ISUPPORTS

 private:
  ~RecoveryPlanOwner() = default;
};
NS_IMPL_ISUPPORTS(RecoveryPlanOwner, nsISupports)

class DeliveryCoreReferences : public testing::Test {
 protected:
  void SetUp() override {
    mDirectories = do_GetService(NS_DIRECTORY_SERVICE_CONTRACTID);
    ASSERT_TRUE(mDirectories);
    nsCOMPtr<nsIFile> base;
    if (NS_SUCCEEDED(mDirectories->Get(NS_APP_USER_PROFILE_50_DIR,
                                       NS_GET_IID(nsIFile),
                                       getter_AddRefs(mOldProfile)))) {
      base = mOldProfile;
    } else {
      mOldProfile = nullptr;
      ASSERT_EQ(NS_OK,
                NS_GetSpecialDirectory(NS_OS_TEMP_DIR, getter_AddRefs(base)));
    }
    ASSERT_EQ(NS_OK, base->Clone(getter_AddRefs(mProfile)));
    ASSERT_EQ(NS_OK, mProfile->Append(u"delivery-core-references"_ns));
    ASSERT_EQ(NS_OK, mProfile->CreateUnique(nsIFile::DIRECTORY_TYPE, 0700));
    mProfileCreated = true;
    mRestoreProfileCache =
        NS_SUCCEEDED(mDirectories->Undefine(NS_APP_USER_PROFILE_50_DIR));
    mDirectoryChanged = mRestoreProfileCache;
    ASSERT_EQ(NS_OK, mDirectories->Set(NS_APP_USER_PROFILE_50_DIR, mProfile));
    mDirectoryChanged = true;
    ASSERT_EQ(NS_OK, mProfile->Clone(getter_AddRefs(mFile)));
    ASSERT_EQ(NS_OK, mFile->Append(u"panorama.sqlite"_ns));
    mStorage = do_GetService("@mozilla.org/storage/service;1");
    ASSERT_TRUE(mStorage);
  }

  void TearDown() override {
    Stop();
    if (mDirectoryChanged) {
      // An uncached provider is restored by removing only our override.
      (void)mDirectories->Undefine(NS_APP_USER_PROFILE_50_DIR);
      if (mRestoreProfileCache && mOldProfile) {
        EXPECT_EQ(NS_OK,
                  mDirectories->Set(NS_APP_USER_PROFILE_50_DIR, mOldProfile));
      }
    }
    if (mProfileCreated) {
      EXPECT_EQ(NS_OK, mProfile->Remove(true));
    }
  }

  // A lower user_version must describe the old physical schema too. Remove
  // only the columns added in versions 16-19, preserving the older row data.
  nsresult RemoveReplayColumns(mozIStorageConnection* connection) {
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_operations DROP COLUMN guardPresence"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_operations DROP COLUMN guardFlags"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_operations DROP COLUMN guardLineCount"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_operations DROP COLUMN guardOfflineSize"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_operations DROP COLUMN guardMessageSize"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_operations DROP COLUMN guardStoreToken"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_operations DROP COLUMN guardLocationRevision"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_operations DROP COLUMN guardContentRevision"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_operations DROP COLUMN guardKey"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_operations DROP COLUMN guardFolderId"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_operations DROP COLUMN guardSourceId"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_operations DROP COLUMN flagClearMask"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_operations DROP COLUMN flagSetMask"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN settledOperationRetired"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN settledSourceRemoved"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN firstError"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN moveSettled"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN sourceExpungeError"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN sourceExpungeGeneration"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN sourceExpungeState"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN sourceStoreError"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN sourceStoreGeneration"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN sourceStoreState"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN flagClearError"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN flagClearGeneration"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN flagClearState"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN flagSetError"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN flagSetGeneration"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN flagSetState"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN moveExpunge"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN replayVersion"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN guardPresence"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN guardFlags"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN guardLineCount"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN guardOfflineSize"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN guardMessageSize"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN guardStoreToken"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN guardLocationRevision"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN guardContentRevision"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN guardKey"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN guardFolderId"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN guardSourceId"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN flagClearMask"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts DROP COLUMN flagSetMask"_ns));
    return NS_OK;
  }

  nsresult RemovePost15OfflineColumns(mozIStorageConnection* connection) {
    MOZ_TRY(RemoveReplayColumns(connection));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "ALTER TABLE offline_operations DROP COLUMN sourcePhysicalKey"_ns));
    for (const char* column : {"confirmedEpoch",
                               "transferFlags",
                               "transferLineCount",
                               "transferOfflineSize",
                               "transferMessageSize",
                               "transferStoreToken",
                               "transferLocationRevision",
                               "transferContentRevision",
                               "transferAccepted",
                               "copyOrdinal",
                               "transferOperationKey",
                               "transferSourceId",
                               "appendFlags",
                               "appendLineCount",
                               "appendOfflineSize",
                               "appendMessageSize",
                               "appendStoreToken",
                               "appendLocationRevision",
                               "appendContentRevision",
                               "appendSourceId",
                               "appendAccepted"}) {
      nsAutoCString sql("ALTER TABLE offline_attempts DROP COLUMN ");
      sql.Append(column);
      MOZ_TRY(connection->ExecuteSimpleSQL(sql));
    }
    return NS_OK;
  }

  nsresult QueuedReplayMove(nsMsgKey& source, nsMsgKey& target,
                            OfflineAttempt& attempt, uint32_t additional = 0,
                            bool confirm = true) {
    auto& db = mCore->MessageDB();
    MOZ_TRY(mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
    MOZ_TRY(Add("replay-source@invalid"_ns, {}, source));
    MOZ_TRY(db.BindMessageToServerUid(source, mFolderId, 7, source));
    uint64_t folder;
    nsAutoCString name("Replay");
    name.AppendInt(source);
    MOZ_TRY(mCore->FolderDB().InsertFolder(mFolderId, name, &folder));
    MOZ_TRY(mCore->FolderDB().SetFolderUidValidity(folder, 9));
    RawHdr raw;
    raw.messageId = "replay-destination@invalid"_ns;
    MOZ_TRY(db.AddMessage(folder, raw, true, &target));
    OfflineOperationData payload;
    payload.operation = nsIMsgOfflineImapOperation::kMsgMoved | additional;
    payload.pendingDestination = Some(PendingDestination{folder, target, 9});
    if (additional & nsIMsgOfflineImapOperation::kAddKeywords)
      payload.keywordsToAdd = "retained"_ns;
    MOZ_TRY(db.StoreOfflineOperation(mFolderId, source, payload));
    uint64_t id;
    MOZ_TRY(db.BeginOfflineAction(mFolderId, source,
                                  nsIMsgOfflineImapOperation::kMsgMoved,
                                  payload.pendingDestination, Nothing(), id));
    if (confirm) {
      MOZ_TRY(
          db.ConfirmOfflineAttempt(id, Some(ServerUidConfirmation{9, target})));
    } else {
      MOZ_TRY(db.GetOfflineAttempt(id, attempt));
      MOZ_TRY(db.RecordOfflineCopyAcceptedWithoutUid(attempt));
    }
    return db.GetOfflineAttempt(id, attempt);
  }

  nsresult QueuedReplayFlags(nsMsgKey& key, OfflineAttempt& attempt) {
    auto& db = mCore->MessageDB();
    MOZ_TRY(mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
    MOZ_TRY(Add("replay-flags@invalid"_ns, {}, key));
    MOZ_TRY(db.BindMessageToServerUid(key, mFolderId, 7, key));
    nsCString sourceId;
    MOZ_TRY(mCore->GetSourceId(sourceId));
    ServerMessageLocation source{mFolderId, key, 7, key};
    MOZ_TRY(db.QueueOfflineProtocolFlagMutation(sourceId, mFolderId, key,
                                                source, 0x81, true));
    MOZ_TRY(db.QueueOfflineProtocolFlagMutation(sourceId, mFolderId, key,
                                                source, 0x04, false));
    uint64_t id;
    MOZ_TRY(db.BeginOfflineAction(mFolderId, key,
                                  nsIMsgOfflineImapOperation::kFlagsChanged,
                                  Nothing(), Nothing(), id));
    return db.GetOfflineAttempt(id, attempt);
  }

  nsresult QueuedAppend(nsMsgKey& key, MessageBodyState& body,
                        OfflineAttempt& attempt, bool captureBody = true) {
    auto& db = mCore->MessageDB();
    MOZ_TRY(mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
    RawHdr raw;
    raw.messageId = "queued-append@invalid"_ns;
    raw.flags = nsMsgMessageFlags::Offline;
    raw.storeToken = Some(nsCString("0"_ns));
    raw.messageSize = Some(12u);
    raw.offlineMessageSize = Some(12u);
    raw.lineCount = Some(1u);
    MOZ_TRY(db.AddMessage(mFolderId, raw, true, &key));
    OfflineOperationData op;
    op.operation = nsIMsgOfflineImapOperation::kAppendDraft;
    op.pendingDestination = Some(PendingDestination{mFolderId, key, 7});
    MOZ_TRY(db.StoreOfflineOperation(mFolderId, key, op));
    MOZ_TRY(db.GetMessageBodyState(key, body));
    uint64_t id;
    MOZ_TRY(db.BeginOfflineAttempt(mFolderId, key, op.operation,
                                   op.pendingDestination, id,
                                   captureBody ? &body : nullptr));
    return db.GetOfflineAttempt(id, attempt);
  }

  nsresult QueuedCopy(nsMsgKey& source, uint64_t& folder, nsMsgKey& target,
                      OfflineAttempt& attempt, bool unobserved = false) {
    auto& db = mCore->MessageDB();
    MOZ_TRY(mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
    MOZ_TRY(Add("copy-source@invalid"_ns, {}, source));
    MOZ_TRY(db.BindMessageToServerUid(source, mFolderId, 7, source));
    nsAutoCString name("Receipt");
    name.AppendInt(source);
    MOZ_TRY(mCore->FolderDB().InsertFolder(mFolderId, name, &folder));
    if (!unobserved) {
      MOZ_TRY(mCore->FolderDB().SetFolderUidValidity(folder, 9));
    }
    RawHdr raw;
    raw.messageId = "metadata-only-copy@invalid"_ns;
    MOZ_TRY(db.AddMessage(folder, raw, true, &target));
    OfflineOperationData payload;
    payload.operation = nsIMsgOfflineImapOperation::kMsgCopy;
    payload.copyDestinations = {"imap://actual/Copy"_ns};
    payload.copyDestinationBindings = {
        Some(unobserved ? PendingDestination::Unobserved(folder, target)
                        : PendingDestination{folder, target, 9})};
    MOZ_TRY(db.StoreOfflineOperation(mFolderId, source, payload));
    uint64_t id;
    MOZ_TRY(db.BeginOfflineAction(mFolderId, source, payload.operation,
                                  payload.copyDestinationBindings[0], Some(0u),
                                  id));
    return db.GetOfflineAttempt(id, attempt);
  }

  nsresult QueuedSourceForUndo(nsMsgKey& source, nsMsgKey& target,
                               QueuedSourceIdentity& identity) {
    auto& db = mCore->MessageDB();
    MOZ_TRY(mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
    MOZ_TRY(Add("retained-source@invalid"_ns, {"raw"_ns, "raw"_ns}, source));
    MOZ_TRY(db.BindMessageToServerUid(source, mFolderId, 7, source));
    MOZ_TRY(Add("actual-destination@invalid"_ns, {}, target));
    OfflineOperationData payload;
    payload.operation = nsIMsgOfflineImapOperation::kMsgCopy |
                        nsIMsgOfflineImapOperation::kFlagsChanged;
    payload.copyDestinations = {"actual-copy"_ns};
    payload.copyDestinationBindings = {
        Some(PendingDestination{mFolderId, target, 7})};
    payload.flagOperation = 0x80000000;
    payload.newFlags = UINT32_MAX;
    payload.keywordsToAdd = "retained exact words"_ns;
    MOZ_TRY(db.StoreOfflineOperation(mFolderId, source, payload));
    OfflineOperationData counterpart;
    counterpart.operation = nsIMsgOfflineImapOperation::kMoveResult;
    counterpart.sourceKey = source;
    counterpart.sourceUid = source;
    counterpart.sourceFolderURI = "imap://actual/source"_ns;
    MOZ_TRY(db.StoreOfflineOperation(mFolderId, target, counterpart));
    return db.GetQueuedSourceIdentity(mFolderId, source, identity);
  }

  nsresult QueuedSourceForStagedReturn(nsMsgKey& source,
                                       nsTArray<PendingDestination>& targets,
                                       QueuedSourceIdentity& identity) {
    auto& db = mCore->MessageDB();
    nsMsgKey first;
    MOZ_TRY(QueuedSourceForUndo(source, first, identity));
    targets.AppendElement(PendingDestination{mFolderId, first, 7});
    uint64_t folder;
    MOZ_TRY(
        mCore->FolderDB().InsertFolder(mFolderId, "ReturnTail"_ns, &folder));
    MOZ_TRY(mCore->FolderDB().SetFolderUidValidity(folder, 9));
    for (uint32_t i = 0; i < 2; ++i) {
      RawHdr raw;
      raw.messageId = i ? "return-selected-move"_ns : "return-copy-tail"_ns;
      nsMsgKey key;
      MOZ_TRY(db.AddMessage(folder, raw, true, &key));
      targets.AppendElement(PendingDestination{folder, key, 9});
      OfflineOperationData child;
      child.operation = nsIMsgOfflineImapOperation::kMoveResult |
                        nsIMsgOfflineImapOperation::kFlagsChanged;
      child.sourceKey = source;
      child.sourceUid = source;
      child.sourceFolderURI = "imap://actual/source"_ns;
      child.flagOperation = 0x80000000;
      child.newFlags = UINT32_MAX;
      child.keywordsToAdd = "unchanged child words"_ns;
      MOZ_TRY(db.StoreOfflineOperation(folder, key, child));
    }
    OfflineOperationData payload;
    MOZ_TRY(db.GetOfflineOperation(mFolderId, source, payload));
    payload.operation |= nsIMsgOfflineImapOperation::kMsgMoved;
    payload.sourceUid = source;
    payload.messageSize = 12345;
    payload.keywordsToRemove = "unchanged removal words"_ns;
    payload.copyDestinations.AppendElement("actual-copy-tail"_ns);
    payload.copyDestinationBindings.AppendElement(Some(targets[1]));
    payload.pendingDestination = Some(targets[2]);
    payload.destinationFolderURI = "actual-selected-move"_ns;
    MOZ_TRY(db.StoreOfflineOperation(mFolderId, source, payload));
    return db.GetQueuedSourceIdentity(mFolderId, source, identity);
  }

  nsresult MessageIsStaged(nsMsgKey key, bool& staged) {
    return mCore->MessageDB().IsMessageStaged(key, staged);
  }

  mozIStorageConnection* Connection() const {
    return DatabaseCore::sConnection.get();
  }

  nsresult Open(mozIStorageConnection** connection) {
    return mStorage->OpenUnsharedDatabase(
        mFile, mozIStorageService::CONNECTION_DEFAULT, connection);
  }

  nsresult StartNews(RefPtr<PerFolderDatabase>& owner, nsCString& source,
                     nsMsgKeySet* set) {
    MOZ_TRY(Start());
    nsAutoCString sql("UPDATE folders SET flags=flags|");
    sql.AppendInt(nsMsgFolderFlags::Newsgroup);
    sql.AppendLiteral(" WHERE id=");
    sql.AppendInt(mFolderId);
    MOZ_TRY(mConnection->ExecuteSimpleSQL(sql));
    MOZ_TRY(mCore->GetSourceId(source));
    owner = new PerFolderDatabase(mFolderId, true);
    return owner->SetReadSet(set);
  }

  nsresult NewsArticle(const nsACString& source, uint64_t folder,
                       uint32_t article, NewsArticleIdentity& output) {
    NewsGroupIdentity group;
    MOZ_TRY(mCore->MessageDB().GetNewsGroupIdentity(source, folder, group));
    output = {std::move(group), article};
    return NS_OK;
  }

  nsresult ReadNewsZero(const nsACString& source, uint64_t folder,
                        const nsACString& fileRanges, Maybe<bool>& output) {
    return mCore->MessageDB().ReadNewsReadSetForInitialization(
        source, folder, fileRanges, output);
  }

  already_AddRefed<PerFolderDatabase> WeakFolderDatabase(uint64_t folderId) {
    RefPtr<PerFolderDatabase> facade = new PerFolderDatabase(folderId, false);
    // The facade owner changes its constructor separately. Enroll through the
    // real native seam so these controls work with either constructor version.
    mCore->MessageDB().RemoveMessageListener(facade);
    mCore->MessageDB().AddFolderMessageListener(facade);
    return facade.forget();
  }

  void EnrollWeakFolder(PerFolderDatabase* facade) {
    mCore->MessageDB().AddFolderMessageListener(facade);
  }

  void NotifyImported(nsMsgKey key) {
    RefPtr<Message> message = new Message(key);
    mCore->MessageDB().NotifyImportedMessage(message);
  }

  size_t CachedHeaderCount() const {
    return mCore->MessageDB().mMsgCache.count();
  }

  bool HeaderIsCached(nsMsgKey key) const {
    return bool(mCore->MessageDB().mMsgCache.lookup(key));
  }

  nsresult MarkFolderRead(uint64_t folder, nsTArray<nsMsgKey>& marked) {
    return mCore->MessageDB().MarkAllRead(folder, marked);
  }

  nsresult FolderUnreadCount(uint64_t folder, uint64_t& count) {
    return mCore->MessageDB().GetNumUnread(folder, &count);
  }

  nsresult SearchWatermark(uint64_t& sequence) {
    return mCore->MessageDB().GetSearchWatermark(sequence);
  }

  nsresult ReadFolderProperty(FolderDatabase* db, uint64_t folder,
                              const nsACString& name, nsACString& value) {
    return db->GetFolderProperty(folder, name, value);
  }

  nsresult ReadFolderProperty(FolderDatabase* db, uint64_t folder,
                              const nsACString& name, int64_t& value) {
    return db->GetFolderProperty(folder, name, &value);
  }

  nsresult WriteFolderProperty(FolderDatabase* db, uint64_t folder,
                               const nsACString& name,
                               const nsACString& value) {
    return db->SetFolderProperty(folder, name, value);
  }

  nsresult WriteFolderProperty(FolderDatabase* db, uint64_t folder,
                               const nsACString& name, int64_t value) {
    return db->SetFolderProperty(folder, name, value);
  }

  nsresult ReadVirtualFolders(FolderDatabase* db, uint64_t folder,
                              nsTArray<uint64_t>& members) {
    return db->GetVirtualFolderFolders(folder, members);
  }

  nsresult WriteVirtualFolders(FolderDatabase* db, uint64_t folder,
                               nsTArray<uint64_t>& members) {
    return db->SetVirtualFolderFolders(folder, members);
  }

  enum class StructuralFailure { None, CallerTransaction, Write, Commit };

  void CheckStructuralFieldWrites(bool staged, StructuralFailure failure) {
    ASSERT_EQ(NS_OK, Start());
    auto& db = mCore->MessageDB();
    RawHdr raw;
    raw.messageId = "structural-before"_ns;
    raw.sender = "before sender"_ns;
    raw.recipients = "before recipients"_ns;
    raw.ccList = "before cc"_ns;
    raw.bccList = "before bcc"_ns;
    raw.subject = "before subject"_ns;
    raw.date = 1234567890123;
    raw.priority = nsMsgPriority::lowest;
    raw.references = {"first"_ns, "second"_ns, "first"_ns};
    raw.extras.AppendElement(RawHdr::kv{"Exact"_ns, "00042"_ns});
    nsMsgKey key, control;
    ASSERT_EQ(NS_OK, staged ? db.StageMessage(mFolderId, raw, &key)
                            : db.AddMessage(mFolderId, raw, false, &key));
    ASSERT_EQ(NS_OK, Add("unrelated-control"_ns, {}, control));
    // These inputs are deliberately exact, including whitespace and UTF-8.
    const nsCString changed = "  Case Caf\xC3\xA9 00042  "_ns;
    const PRTime changedDate = 9876543210123;
    auto check = [&](bool updated) {
      nsMsgPriorityValue priority = nsMsgPriority::none;
      EXPECT_EQ(NS_OK, db.GetMessagePriority(key, priority));
      EXPECT_EQ(updated ? nsMsgPriority::highest : raw.priority, priority);
      PRTime date = -1;
      EXPECT_EQ(NS_OK, db.GetMessageDate(key, date));
      EXPECT_EQ(updated ? changedDate : raw.date, date);
      nsCString value;
      EXPECT_EQ(NS_OK, db.GetMessageMessageId(key, value));
      EXPECT_EQ(updated ? changed : raw.messageId, value);
      EXPECT_EQ(NS_OK, db.GetMessageSender(key, value));
      EXPECT_EQ(updated ? changed : raw.sender, value);
      EXPECT_EQ(NS_OK, db.GetMessageRecipients(key, value));
      EXPECT_EQ(updated ? changed : raw.recipients, value);
      EXPECT_EQ(NS_OK, db.GetMessageCcList(key, value));
      EXPECT_EQ(updated ? changed : raw.ccList, value);
      EXPECT_EQ(NS_OK, db.GetMessageBccList(key, value));
      EXPECT_EQ(updated ? nsCString() : raw.bccList, value);
      EXPECT_EQ(NS_OK, db.GetMessageSubject(key, value));
      EXPECT_EQ(updated ? changed : raw.subject, value);
    };
    check(false);  // Prime the real hot row before either SQL failure.
    const std::function<nsresult()> writes[] = {
        [&] { return db.SetMessagePriority(key, nsMsgPriority::highest); },
        [&] { return db.SetMessageDate(key, changedDate); },
        [&] { return db.SetMessageMessageId(key, changed); },
        [&] { return db.SetMessageSender(key, changed); },
        [&] { return db.SetMessageRecipients(key, changed); },
        [&] { return db.SetMessageCcList(key, changed); },
        [&] { return db.SetMessageBccList(key, EmptyCString()); },
        [&] { return db.SetMessageSubject(key, changed); }};
    {
      RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
      uint32_t callbacks = 0;
      observer->action = [&](char, const CapturedMessage&,
                             const CapturedMessage&, Message*,
                             bool) { ++callbacks; };
      db.AddMessageListener(observer);
      auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
      RefPtr<FaultWitness> witness = new FaultWitness();
      const bool fault = failure == StructuralFailure::Write ||
                         failure == StructuralFailure::Commit;
      if (fault) {
        ASSERT_EQ(NS_OK, mConnection->CreateFunction("structural_witness"_ns, 1,
                                                     witness));
        if (failure == StructuralFailure::Commit) {
          ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                               "PRAGMA foreign_keys=ON; CREATE TEMP TABLE "
                               "structural_parent(id INTEGER PRIMARY KEY); "
                               "CREATE TEMP TABLE structural_child(id INTEGER "
                               "REFERENCES structural_parent(id) DEFERRABLE "
                               "INITIALLY DEFERRED)"_ns));
        }
        nsAutoCString sql("CREATE TEMP TRIGGER structural_fault ");
        sql.Append(failure == StructuralFailure::Commit ? "AFTER" : "BEFORE");
        sql.AppendLiteral(" UPDATE ON main.");
        sql.Append(staged ? "staged_messages" : "messages");
        sql.AppendLiteral(" WHEN OLD.id=");
        sql.AppendInt(key);
        sql.AppendLiteral(" BEGIN SELECT structural_witness(OLD.id); ");
        sql.Append(failure == StructuralFailure::Commit
                       ? "INSERT INTO structural_child VALUES(OLD.id); END"
                       : "SELECT RAISE(ABORT,'structural write'); END");
        ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
      }
      auto cleanup = MakeScopeExit([&] {
        if (fault) {
          EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                               "DROP TRIGGER IF EXISTS structural_fault"_ns));
          EXPECT_EQ(NS_OK,
                    mConnection->RemoveFunction("structural_witness"_ns));
        }
        bool active = false;
        EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
        if (active) EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
      });
      if (failure == StructuralFailure::CallerTransaction) {
        ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
        ASSERT_EQ(NS_OK,
                  db.SetMessageProperty(control, "caller"_ns, "pending"_ns));
      }
      if (failure != StructuralFailure::None) {
        for (const auto& write : writes) {
          EXPECT_EQ(fault ? NS_ERROR_STORAGE_CONSTRAINT : NS_ERROR_IN_PROGRESS,
                    write());
          check(false);
        }
        bool active = false;
        ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
        EXPECT_EQ(failure == StructuralFailure::CallerTransaction, active);
        if (fault) {
          EXPECT_EQ(8u, witness->mCalls);
          EXPECT_EQ(int64_t(key), witness->mLastKey);
          ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                               "DROP TRIGGER structural_fault"_ns));
          if (failure == StructuralFailure::Commit) {
            nsCOMPtr<mozIStorageStatement> leftovers;
            ASSERT_EQ(NS_OK, mConnection->CreateStatement(
                                 "SELECT id FROM structural_child"_ns,
                                 getter_AddRefs(leftovers)));
            bool more = true;
            ASSERT_EQ(NS_OK, leftovers->ExecuteStep(&more));
            EXPECT_FALSE(more);
          }
        } else {
          nsCString value;
          ASSERT_EQ(NS_OK, db.GetMessageProperty(control, "caller"_ns, value));
          EXPECT_EQ("pending"_ns, value);
          ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
          check(false);
          ASSERT_EQ(NS_OK, db.GetMessageProperty(control, "caller"_ns, value));
          EXPECT_TRUE(value.IsEmpty());
        }
        EXPECT_EQ(0u, callbacks);
        EXPECT_EQ(0u, observer->ordinary);
      }
      // All eight operations retry normally after rejection/rollback.
      for (const auto& write : writes) ASSERT_EQ(NS_OK, write());
      check(true);
      EXPECT_EQ(0u, callbacks);
      EXPECT_EQ(0u, observer->ordinary);
      nsCString controlId;
      ASSERT_EQ(NS_OK, db.GetMessageMessageId(control, controlId));
      EXPECT_EQ("unrelated-control"_ns, controlId);
    }
    Stop();
    ASSERT_EQ(NS_OK, Start());
    // Use the reopened core rather than the destroyed db reference.
    auto& reopened = mCore->MessageDB();
    nsCString value;
    ASSERT_EQ(NS_OK, reopened.GetMessageMessageId(key, value));
    EXPECT_EQ(changed, value);
    ASSERT_EQ(NS_OK, reopened.GetMessageSender(key, value));
    EXPECT_EQ(changed, value);
    ASSERT_EQ(NS_OK, reopened.GetMessageRecipients(key, value));
    EXPECT_EQ(changed, value);
    ASSERT_EQ(NS_OK, reopened.GetMessageCcList(key, value));
    EXPECT_EQ(changed, value);
    ASSERT_EQ(NS_OK, reopened.GetMessageBccList(key, value));
    EXPECT_TRUE(value.IsEmpty());
    ASSERT_EQ(NS_OK, reopened.GetMessageSubject(key, value));
    EXPECT_EQ(changed, value);
    nsMsgPriorityValue priority = nsMsgPriority::none;
    ASSERT_EQ(NS_OK, reopened.GetMessagePriority(key, priority));
    EXPECT_EQ(nsMsgPriority::highest, priority);
    PRTime date = -1;
    ASSERT_EQ(NS_OK, reopened.GetMessageDate(key, date));
    EXPECT_EQ(changedDate, date);
    nsTArray<nsCString> refs;
    ASSERT_EQ(NS_OK, reopened.GetMessageReferences(key, refs));
    EXPECT_EQ(raw.references, refs);
    ASSERT_EQ(NS_OK, reopened.GetMessageProperty(key, "Exact"_ns, value));
    EXPECT_EQ("00042"_ns, value);
    bool published = false;
    ASSERT_EQ(NS_OK, reopened.MessageExists(key, published));
    EXPECT_EQ(!staged, published);
  }

  void CheckStagedChangeFailure(bool tags, bool commitFailure) {
    ASSERT_EQ(NS_OK, Start());
    auto& db = mCore->MessageDB();
    RawHdr raw;
    raw.messageId = "staged-change-fault"_ns;
    raw.flags = nsMsgMessageFlags::Marked;
    raw.keywords = "before"_ns;
    raw.references = {"first"_ns, "second"_ns, "first"_ns};
    nsMsgKey key, control;
    ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &key));
    ASSERT_EQ(NS_OK, Add("staged-unrelated"_ns, {}, control));
    ASSERT_EQ(NS_OK, db.SetMessageProperty(control, "Exact"_ns, "00042"_ns));
    uint32_t flags;
    nsCString text;
    ASSERT_EQ(NS_OK, db.GetMessageFlags(key, flags));
    ASSERT_EQ(NS_OK, db.GetMessageTags(key, text));
    EXPECT_EQ(raw.flags, flags);
    EXPECT_EQ(raw.keywords, text);
    RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
    uint32_t callbacks = 0;
    observer->action = [&](char, const CapturedMessage&, const CapturedMessage&,
                           Message*, bool) { ++callbacks; };
    db.AddMessageListener(observer);
    auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
    RefPtr<FaultWitness> witness = new FaultWitness();
    ASSERT_EQ(NS_OK, mConnection->CreateFunction("staged_change_fault"_ns, 1,
                                                 witness));
    if (commitFailure) {
      ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "PRAGMA foreign_keys=ON; CREATE TEMP TABLE "
                           "staged_parent(id INTEGER PRIMARY KEY); "
                           "CREATE TEMP TABLE staged_child(id INTEGER "
                           "REFERENCES staged_parent(id) DEFERRABLE "
                           "INITIALLY DEFERRED)"_ns));
    }
    nsAutoCString sql("CREATE TEMP TRIGGER fail_staged_change ");
    sql.Append(commitFailure ? "AFTER" : "BEFORE");
    sql.AppendLiteral(" UPDATE OF ");
    sql.Append(tags ? "tags" : "flags");
    sql.AppendLiteral(" ON main.staged_messages WHEN OLD.id=");
    sql.AppendInt(key);
    sql.AppendLiteral(" BEGIN SELECT staged_change_fault(OLD.id); ");
    sql.Append(commitFailure ? "INSERT INTO staged_child VALUES(OLD.id); END"
                             : "SELECT RAISE(ABORT,'staged change'); END");
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    auto cleanup = MakeScopeExit([&] {
      EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "DROP TRIGGER IF EXISTS fail_staged_change"_ns));
      EXPECT_EQ(NS_OK, mConnection->RemoveFunction("staged_change_fault"_ns));
    });
    auto write = [&]() -> nsresult {
      return tags ? db.SetMessageTags(key, "  Exact TAG 00042  "_ns)
                  : db.SetMessageFlags(key, UINT32_MAX);
    };
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, write());
    EXPECT_EQ(1u, witness->mCalls);
    EXPECT_EQ(int64_t(key), witness->mLastKey);
    bool active = true, exists = true;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    ASSERT_EQ(NS_OK, db.GetMessageFlags(key, flags));
    ASSERT_EQ(NS_OK, db.GetMessageTags(key, text));
    EXPECT_EQ(raw.flags, flags);
    EXPECT_EQ(raw.keywords, text);
    ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
    EXPECT_FALSE(exists);
    if (commitFailure) {
      nsCOMPtr<mozIStorageStatement> leftovers;
      ASSERT_EQ(NS_OK,
                mConnection->CreateStatement("SELECT id FROM staged_child"_ns,
                                             getter_AddRefs(leftovers)));
      bool more = true;
      ASSERT_EQ(NS_OK, leftovers->ExecuteStep(&more));
      EXPECT_FALSE(more);
    }
    EXPECT_EQ(0u, callbacks);
    EXPECT_EQ(0u, observer->ordinary);
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER fail_staged_change"_ns));
    ASSERT_EQ(NS_OK, write());
    ASSERT_EQ(NS_OK, write());  // A no-op remains silent.
    ASSERT_EQ(NS_OK, db.GetMessageFlags(key, flags));
    ASSERT_EQ(NS_OK, db.GetMessageTags(key, text));
    EXPECT_EQ(tags ? raw.flags : UINT32_MAX, flags);
    EXPECT_EQ(tags ? nsCString("  Exact TAG 00042  ") : raw.keywords, text);
    ASSERT_EQ(NS_OK, db.GetMessageProperty(control, "Exact"_ns, text));
    EXPECT_EQ("00042"_ns, text);
    nsTArray<nsCString> refs;
    ASSERT_EQ(NS_OK, db.GetMessageReferences(key, refs));
    EXPECT_EQ(raw.references, refs);
    EXPECT_EQ(0u, callbacks);
    EXPECT_EQ(0u, observer->ordinary);
  }

  void CheckBulkReadNotificationFailure(bool commitFailure) {
    ASSERT_EQ(NS_OK, Start());
    auto& db = mCore->MessageDB();
    RefPtr<PerFolderDatabase> facade = WeakFolderDatabase(mFolderId);
    RawHdr raw;
    raw.messageId = "bulk-notify-first"_ns;
    raw.flags = nsMsgMessageFlags::Marked;
    nsMsgKey first, second;
    ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &first));
    ASSERT_EQ(NS_OK, Add("bulk-notify-second"_ns, {}, second));
    uint32_t flags;
    ASSERT_EQ(NS_OK, db.GetMessageFlags(first, flags));
    ASSERT_EQ(NS_OK, db.GetMessageFlags(second, flags));
    nsTArray<nsMsgKey> originalNew;
    ASSERT_EQ(NS_OK, facade->GetNewList(originalNew));
    ASSERT_EQ((nsTArray<nsMsgKey>{first, second}), originalNew);
    uint64_t watermark;
    ASSERT_EQ(NS_OK, SearchWatermark(watermark));
    uint32_t callbacks = 0;
    RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
    observer->action = [&](char, const CapturedMessage&, const CapturedMessage&,
                           Message*, bool) { ++callbacks; };
    db.AddMessageListener(observer);
    auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
    RefPtr<FaultWitness> witness = new FaultWitness();
    ASSERT_EQ(NS_OK,
              mConnection->CreateFunction("bulk_notify_fault"_ns, 1, witness));
    if (commitFailure) {
      ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "PRAGMA foreign_keys=ON; CREATE TEMP TABLE "
                           "bulk_parent(id INTEGER PRIMARY KEY); "
                           "CREATE TEMP TABLE bulk_child(id INTEGER "
                           "REFERENCES bulk_parent(id) DEFERRABLE "
                           "INITIALLY DEFERRED)"_ns));
    }
    nsAutoCString trigger("CREATE TEMP TRIGGER fail_bulk_notify ");
    trigger.Append(commitFailure ? "AFTER" : "BEFORE");
    trigger.AppendLiteral(
        " UPDATE OF flags ON main.messages BEGIN "
        "SELECT bulk_notify_fault(OLD.id); ");
    if (commitFailure) {
      trigger.AppendLiteral("INSERT INTO bulk_child VALUES(OLD.id); END");
    } else {
      trigger.AppendLiteral("SELECT CASE WHEN OLD.id=");
      trigger.AppendInt(second);
      trigger.AppendLiteral(" THEN RAISE(FAIL,'bulk flags') END; END");
    }
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(trigger));
    auto cleanup = MakeScopeExit([&] {
      EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "DROP TRIGGER IF EXISTS fail_bulk_notify"_ns));
      EXPECT_EQ(NS_OK, mConnection->RemoveFunction("bulk_notify_fault"_ns));
    });
    nsTArray<nsMsgKey> marked{nsMsgKey_None - 1};
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, MarkFolderRead(mFolderId, marked));
    EXPECT_EQ((nsTArray<nsMsgKey>{nsMsgKey_None - 1}), marked);
    EXPECT_EQ(2u, witness->mCalls);
    EXPECT_EQ(int64_t(second), witness->mLastKey);
    bool active = true;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    ASSERT_EQ(NS_OK, db.GetMessageFlags(first, flags));
    EXPECT_EQ(nsMsgMessageFlags::Marked, flags);
    ASSERT_EQ(NS_OK, db.GetMessageFlags(second, flags));
    EXPECT_EQ(0u, flags);
    uint64_t unread, afterWatermark;
    ASSERT_EQ(NS_OK, FolderUnreadCount(mFolderId, unread));
    EXPECT_EQ(2u, unread);
    ASSERT_EQ(NS_OK, SearchWatermark(afterWatermark));
    EXPECT_EQ(watermark, afterWatermark);
    nsTArray<nsMsgKey> currentNew;
    ASSERT_EQ(NS_OK, facade->GetNewList(currentNew));
    EXPECT_EQ(originalNew, currentNew);
    EXPECT_EQ(0u, callbacks);
    EXPECT_EQ(0u, observer->ordinary);
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER fail_bulk_notify"_ns));
    ASSERT_EQ(NS_OK, MarkFolderRead(mFolderId, marked));
    EXPECT_EQ((nsTArray<nsMsgKey>{first, second}), marked);
    EXPECT_EQ(2u, callbacks);
    ASSERT_EQ(NS_OK, facade->GetNewList(currentNew));
    EXPECT_TRUE(currentNew.IsEmpty());
    ASSERT_EQ(NS_OK, MarkFolderRead(mFolderId, marked));
    EXPECT_TRUE(marked.IsEmpty());
    EXPECT_EQ(2u, callbacks);
  }

  void CheckHierarchyUpdateSettlement(uint32_t operation, bool commitFailure) {
    ASSERT_EQ(NS_OK, Start());
    auto& folders = mCore->FolderDB();
    nsAutoCString suffix;
    suffix.AppendInt(operation);
    suffix.Append(commitFailure ? " commit" : " write");
    nsAutoCString leftName("Settlement left ");
    leftName.Append(suffix);
    nsAutoCString rightName("Settlement right ");
    rightName.Append(suffix);
    uint64_t left, right, first, second;
    ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, leftName, &left));
    ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, rightName, &right));
    ASSERT_EQ(NS_OK, folders.InsertFolder(left, "Alpha"_ns, &first));
    ASSERT_EQ(NS_OK, folders.InsertFolder(left, "Beta"_ns, &second));
    ASSERT_EQ(NS_OK, folders.MoveFolderWithin(left, first, 0));
    ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(left, {second, first}));
    ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(first, left, "Alpha"_ns));
    nsCString originalPath;
    ASSERT_EQ(NS_OK, folders.GetFolderPath(first, originalPath));
    nsMsgKey key;
    const nsTArray<nsCString> references{"first"_ns, "second"_ns, "first"_ns};
    ASSERT_EQ(NS_OK, AddAt(first, "settlement-message"_ns, references, key));
    ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(key, "Exact"_ns,
                                                           "00042"_ns));
    uint64_t watermark;
    ASSERT_EQ(NS_OK, SearchWatermark(watermark));
    RefPtr<FaultWitness> witness = new FaultWitness();
    ASSERT_EQ(NS_OK, mConnection->CreateFunction("hierarchy_settle_fault"_ns, 1,
                                                 witness));
    if (commitFailure) {
      ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "PRAGMA foreign_keys=ON; CREATE TEMP TABLE "
                           "hierarchy_parent(id INTEGER PRIMARY KEY); "
                           "CREATE TEMP TABLE hierarchy_child(id INTEGER "
                           "REFERENCES hierarchy_parent(id) DEFERRABLE "
                           "INITIALLY DEFERRED)"_ns));
    }
    nsAutoCString sql(
        "CREATE TEMP TRIGGER fail_hierarchy_settlement "
        "AFTER UPDATE OF ");
    sql.Append(operation == 0 ? "name" : operation == 1 ? "parent" : "ordinal");
    sql.AppendLiteral(" ON main.folders WHEN OLD.id=");
    sql.AppendInt(first);
    sql.AppendLiteral(" BEGIN SELECT hierarchy_settle_fault(OLD.id); ");
    sql.Append(commitFailure
                   ? "INSERT INTO hierarchy_child VALUES(OLD.id); END"
                   : "SELECT RAISE(FAIL,'hierarchy after update'); END");
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    auto cleanup = MakeScopeExit([&] {
      EXPECT_EQ(NS_OK,
                mConnection->ExecuteSimpleSQL(
                    "DROP TRIGGER IF EXISTS fail_hierarchy_settlement"_ns));
      EXPECT_EQ(NS_OK,
                mConnection->RemoveFunction("hierarchy_settle_fault"_ns));
    });
    auto write = [&]() -> nsresult {
      if (operation == 0) {
        return folders.UpdateName(first, "Cafe\xCC\x81"_ns);
      }
      return operation == 1 ? folders.MoveFolderTo(right, first)
                            : folders.ResetChildOrder(left);
    };
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, write());
    EXPECT_EQ(1u, witness->mCalls);
    EXPECT_EQ(int64_t(first), witness->mLastKey);
    bool active = true;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(first, left, "Alpha"_ns));
    ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(second, left, "Beta"_ns));
    ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(left, {second, first}));
    ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(right, {}, false));
    nsCString path;
    ASSERT_EQ(NS_OK, folders.GetFolderPath(first, path));
    EXPECT_EQ(originalPath, path);
    uint64_t after;
    ASSERT_EQ(NS_OK, SearchWatermark(after));
    EXPECT_EQ(watermark, after);
    uint64_t physicalFolder;
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessageFolderId(key, physicalFolder));
    EXPECT_EQ(first, physicalFolder);
    nsTArray<nsCString> refs;
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(key, refs));
    EXPECT_EQ(references, refs);
    nsCString text;
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessageProperty(key, "Exact"_ns, text));
    EXPECT_EQ("00042"_ns, text);
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER fail_hierarchy_settlement"_ns));
    ASSERT_EQ(NS_OK, write());
    ASSERT_EQ(NS_OK, mConnection->RemoveFunction("hierarchy_settle_fault"_ns));
    cleanup.release();
    auto checkSettled = [&] {
      ASSERT_NO_FATAL_FAILURE(
          CheckFolderIdentity(first, operation == 1 ? right : left,
                              operation == 0 ? "Caf\xC3\xA9"_ns : "Alpha"_ns));
      if (operation == 1) {
        ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(left, {second}));
        ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(right, {first}, false));
      } else if (operation == 2) {
        ASSERT_NO_FATAL_FAILURE(
            CheckSiblingOrder(left, {first, second}, false));
      } else {
        ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(left, {second, first}));
      }
    };
    ASSERT_NO_FATAL_FAILURE(checkSettled());
    Stop();
    ASSERT_EQ(NS_OK, Start());
    ASSERT_NO_FATAL_FAILURE(checkSettled());
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessageFolderId(key, physicalFolder));
    EXPECT_EQ(first, physicalFolder);
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessageProperty(key, "Exact"_ns, text));
    EXPECT_EQ("00042"_ns, text);
  }

  // 0: delete failure; 1/3: insert failure; 2/4: deferred commit failure.
  // 0..2 exercise whole-set Reconcile, 3..4 the shared public insertion path.
  void CheckReconcileSettlement(uint32_t mode) {
    ASSERT_EQ(NS_OK, Start());
    auto& folders = mCore->FolderDB();
    nsAutoCString parentName("Reconcile settlement ");
    parentName.AppendInt(mode);
    uint64_t parent, victim, descendant, retained, virtualChild;
    ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, parentName, &parent));
    ASSERT_EQ(NS_OK, folders.InsertFolder(parent, "Old"_ns, &victim));
    ASSERT_EQ(NS_OK,
              folders.InsertFolder(victim, "Descendant"_ns, &descendant));
    ASSERT_EQ(NS_OK, folders.InsertFolder(parent, "Retained"_ns, &retained));
    ASSERT_EQ(NS_OK, folders.InsertFolder(parent, "Virtual"_ns, &virtualChild));
    ASSERT_EQ(NS_OK,
              folders.UpdateFlags(virtualChild, nsMsgFolderFlags::Virtual));
    nsMsgKey key;
    const nsTArray<nsCString> references{"one"_ns, "two"_ns, "one"_ns};
    // The deferred-commit seam enables real foreign keys. Keep its message in
    // a retained child so deletion itself does not hit an immediate message
    // foreign key before the insert trigger. Other modes cover retained
    // physical messages whose old owning folder is actually retired.
    const uint64_t messageFolder = mode == 2 ? retained : descendant;
    ASSERT_EQ(NS_OK,
              AddAt(messageFolder, "reconcile-control"_ns, references, key));
    ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(key, "Exact"_ns,
                                                           "00042"_ns));
    // Prime all pre-existing entries before any mutation can fail.
    nsTArray<uint64_t> original;
    ASSERT_EQ(NS_OK, folders.GetFolderChildren(parent, original));
    nsCString originalPath;
    ASSERT_EQ(NS_OK, folders.GetFolderPath(descendant, originalPath));
    auto highWater = [&](int64_t& value) -> nsresult {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(mConnection->CreateStatement(
          "SELECT highWater FROM folder_id_allocator WHERE singleton=1"_ns,
          getter_AddRefs(stmt)));
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_TRUE(more, NS_ERROR_UNEXPECTED);
      return stmt->GetInt64(0, &value);
    };
    int64_t high;
    ASSERT_EQ(NS_OK, highWater(high));
    uint64_t watermark;
    ASSERT_EQ(NS_OK, SearchWatermark(watermark));
    RefPtr<FaultWitness> witness = new FaultWitness();
    ASSERT_EQ(NS_OK,
              mConnection->CreateFunction("reconcile_fault"_ns, 1, witness));
    bool commitFailure = mode == 2 || mode == 4;
    if (commitFailure) {
      ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "PRAGMA foreign_keys=ON; CREATE TEMP TABLE "
                           "reconcile_parent(id INTEGER PRIMARY KEY); "
                           "CREATE TEMP TABLE reconcile_child(id INTEGER "
                           "REFERENCES reconcile_parent(id) DEFERRABLE "
                           "INITIALLY DEFERRED)"_ns));
    }
    nsAutoCString sql("CREATE TEMP TRIGGER fail_reconcile AFTER ");
    if (mode == 0) {
      sql.AppendLiteral("DELETE ON main.folders WHEN OLD.id=");
      sql.AppendInt(victim);
      sql.AppendLiteral(" BEGIN SELECT reconcile_fault(OLD.id); ");
    } else {
      sql.AppendLiteral(
          "INSERT ON main.folders WHEN NEW.name='Inserted' "
          "BEGIN SELECT reconcile_fault(NEW.id); ");
    }
    sql.Append(commitFailure
                   ? "INSERT INTO reconcile_child VALUES(NEW.id); END"
                   : "SELECT RAISE(FAIL,'reconcile after write'); END");
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    auto cleanup = MakeScopeExit([&] {
      EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "DROP TRIGGER IF EXISTS fail_reconcile"_ns));
      EXPECT_EQ(NS_OK, mConnection->RemoveFunction("reconcile_fault"_ns));
    });
    uint64_t inserted = UINT64_MAX;
    auto write = [&]() -> nsresult {
      return mode < 3
                 ? folders.Reconcile(parent, {"Retained"_ns, "Inserted"_ns})
                 : folders.InsertFolder(parent, "Inserted"_ns, &inserted);
    };
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, write());
    EXPECT_EQ(UINT64_MAX, inserted);
    EXPECT_EQ(1u, witness->mCalls);
    EXPECT_EQ(mode == 0 ? int64_t(victim) : high + 1, witness->mLastKey);
    bool active = true;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(victim, parent, "Old"_ns));
    ASSERT_NO_FATAL_FAILURE(
        CheckFolderIdentity(descendant, victim, "Descendant"_ns));
    nsTArray<uint64_t> children;
    ASSERT_EQ(NS_OK, folders.GetFolderChildren(parent, children));
    EXPECT_EQ(original, children);
    nsCString path;
    ASSERT_EQ(NS_OK, folders.GetFolderPath(descendant, path));
    EXPECT_EQ(originalPath, path);
    int64_t afterHigh;
    ASSERT_EQ(NS_OK, highWater(afterHigh));
    EXPECT_EQ(high, afterHigh);
    uint64_t after;
    ASSERT_EQ(NS_OK, SearchWatermark(after));
    EXPECT_EQ(watermark, after);
    ASSERT_EQ(NS_OK,
              mConnection->ExecuteSimpleSQL("DROP TRIGGER fail_reconcile"_ns));
    ASSERT_EQ(NS_OK, mConnection->RemoveFunction("reconcile_fault"_ns));
    cleanup.release();
    ASSERT_EQ(NS_OK, write());
    uint64_t actual;
    ASSERT_EQ(NS_OK,
              folders.GetFolderChildNamed(parent, "Inserted"_ns, &actual));
    ASSERT_GT(actual, uint64_t(high));
    if (mode >= 3) EXPECT_EQ(actual, inserted);
    auto checkSettled = [&] {
      ASSERT_NO_FATAL_FAILURE(
          CheckFolderIdentity(actual, parent, "Inserted"_ns));
      ASSERT_NO_FATAL_FAILURE(
          CheckFolderIdentity(retained, parent, "Retained"_ns));
      ASSERT_NO_FATAL_FAILURE(
          CheckFolderIdentity(virtualChild, parent, "Virtual"_ns));
      uint64_t physicalFolder;
      ASSERT_EQ(NS_OK,
                mCore->MessageDB().GetMessageFolderId(key, physicalFolder));
      EXPECT_EQ(messageFolder, physicalFolder);
      nsTArray<nsCString> refs;
      ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(key, refs));
      EXPECT_EQ(references, refs);
      nsCString text;
      ASSERT_EQ(NS_OK,
                mCore->MessageDB().GetMessageProperty(key, "Exact"_ns, text));
      EXPECT_EQ("00042"_ns, text);
      uint64_t value = UINT64_MAX;
      if (mode < 3) {
        EXPECT_EQ(NS_ERROR_UNEXPECTED, folders.GetFolderParent(victim, &value));
        EXPECT_EQ(UINT64_MAX, value);
        EXPECT_EQ(NS_ERROR_UNEXPECTED,
                  folders.GetFolderParent(descendant, &value));
        EXPECT_EQ(UINT64_MAX, value);
      } else {
        ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(victim, parent, "Old"_ns));
        ASSERT_NO_FATAL_FAILURE(
            CheckFolderIdentity(descendant, victim, "Descendant"_ns));
      }
    };
    ASSERT_NO_FATAL_FAILURE(checkSettled());
    Stop();
    ASSERT_EQ(NS_OK, Start());
    // Reacquire the database after a real core reopen, not a fresh header.
    ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(actual, parent, "Inserted"_ns));
    uint64_t value;
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageFolderId(key, value));
    EXPECT_EQ(messageFolder, value);
    nsTArray<nsCString> refs;
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(key, refs));
    EXPECT_EQ(references, refs);
    nsCString text;
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessageProperty(key, "Exact"_ns, text));
    EXPECT_EQ("00042"_ns, text);
  }

  nsresult CaptureRepair(uint64_t folder, FolderRepairSnapshot& output) {
    MOZ_TRY(WriteFolderProperty(&mCore->FolderDB(), folder, "summaryValid"_ns,
                                int64_t(0)));
    MOZ_TRY(WriteFolderProperty(&mCore->FolderDB(), folder, "forceReparse"_ns,
                                int64_t(1)));
    nsCString source;
    MOZ_TRY(mCore->GetSourceId(source));
    return mCore->MessageDB().CaptureFolderRepair(folder, source, output);
  }

  nsresult AddRepairRow(uint64_t folder, const nsACString& token,
                        nsMsgKey& key) {
    RawHdr raw;
    raw.messageId = "same@repair.invalid"_ns;
    raw.subject = "old subject"_ns;
    raw.storeToken = Some(nsCString(token));
    raw.messageSize = Some(7u);
    raw.lineCount = Some(1u);
    return mCore->MessageDB().AddMessage(folder, raw, true, &key);
  }

  nsresult Start() {
    // This native fixture selects the concrete Panorama implementation
    // directly.
    mCore = DatabaseCore::GetInstanceForService();
    auto cleanup = MakeScopeExit([&] { Stop(); });
    nsresult rv = mCore->Startup();
    mConnection = Connection();
    NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(mConnection, NS_ERROR_UNEXPECTED);
    nsCOMPtr<nsIFile> actualFile;
    MOZ_TRY(mConnection->GetDatabaseFile(getter_AddRefs(actualFile)));
    bool sameFile;
    MOZ_TRY(mFile->Equals(actualFile, &sameFile));
    NS_ENSURE_TRUE(sameFile, NS_ERROR_UNEXPECTED);
    if (!mFolderId) {
      uint64_t root;
      MOZ_TRY(mCore->FolderDB().InsertRoot("delivery-references"_ns, &root));
      MOZ_TRY(mCore->FolderDB().InsertFolder(root, "Inbox"_ns, &mFolderId));
    }
    cleanup.release();
    return NS_OK;
  }

  void Stop() {
    if (!mCore) {
      return;
    }
    nsCOMPtr<mozIStorageConnection> connection =
        mConnection ? mConnection.get() : Connection();
    nsCOMPtr<nsIEventTarget> target = do_GetInterface(connection);
    EXPECT_EQ(NS_OK, mCore->Observe(nullptr, "profile-before-change", nullptr));
    mConnection = nullptr;
    mCore = nullptr;
    if (!target) {
      return;
    }
    bool closed = false;
    // Observe queues AsyncClose before this barrier, with no intervening spin.
    ASSERT_EQ(
        NS_OK,
        target->Dispatch(
            NS_NewRunnableFunction(
                "ReferencesCloseBarrier",
                [&closed] {
                  MOZ_ALWAYS_SUCCEEDS(
                      NS_DispatchToMainThread(NS_NewRunnableFunction(
                          "ReferencesClosed", [&closed] { closed = true; })));
                }),
            NS_DISPATCH_NORMAL));
    EXPECT_TRUE(SpinEventLoopUntil("ReferencesClosed"_ns,
                                   [&closed] { return closed; }));
  }

  void CheckStagedParentWithGroupingOff() {
    ASSERT_EQ(NS_OK, Start());
    auto& db = mCore->MessageDB();
    ASSERT_FALSE(db.mConversationGroupingEnabled);
    nsMsgKey root, parent, staged;
    ASSERT_EQ(NS_OK, Add("default-root"_ns, {}, root));
    ASSERT_EQ(NS_OK, Add("default-parent"_ns, {"default-root"_ns}, parent));
    ASSERT_NE(root, parent);
    ASSERT_EQ(NS_OK,
              db.SetMessageFlag(parent, nsMsgMessageFlags::Ignored, true));
    CapturedMessage storedParent;
    ASSERT_EQ(NS_OK, db.CaptureMessage(parent, storedParent));
    ASSERT_EQ(root, storedParent.threadId);
    ASSERT_EQ(nsMsgMessageFlags::Ignored, storedParent.flags);

    uint32_t events = 0;
    RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
    observer->action = [&](char, const auto&, const auto&, Message*, bool) {
      ++events;
    };
    db.AddMessageListener(observer);
    auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
    RawHdr raw;
    raw.messageId = "default-staged"_ns;
    raw.references = {"default-parent"_ns};
    ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
    Maybe<CapturedMessage> state;
    ASSERT_EQ(NS_OK, db.CaptureHeaderState(staged, state));
    ASSERT_TRUE(state);
    EXPECT_EQ(mFolderId, state->folderId);
    EXPECT_EQ(root, state->threadId);
    EXPECT_EQ(parent, state->threadParent);
    EXPECT_EQ(0u, state->flags);
    nsTArray<nsCString> references;
    ASSERT_EQ(NS_OK, db.GetMessageReferences(staged, references));
    EXPECT_EQ((nsTArray<nsCString>{"default-parent"_ns}), references);
    bool published = true;
    ASSERT_EQ(NS_OK, db.MessageExists(staged, published));
    EXPECT_FALSE(published);
    nsTArray<nsMsgKey> keys;
    ASSERT_EQ(NS_OK, db.ListAllKeys(mFolderId, keys));
    keys.Sort();
    EXPECT_EQ((nsTArray<nsMsgKey>{root, parent}), keys);
    ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, keys));
    EXPECT_EQ((nsTArray<nsMsgKey>{staged}), keys);
    uint64_t count;
    ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
    EXPECT_EQ(2u, count);
    ASSERT_EQ(NS_OK, db.GetNumUnread(mFolderId, &count));
    EXPECT_EQ(2u, count);
    EXPECT_EQ(0u, events);
    EXPECT_EQ(0u, observer->ordinary);
  }

  nsresult StartGrouping() {
    MOZ_TRY(Start());
    mCore->MessageDB().mConversationGroupingEnabled = true;
    return NS_OK;
  }

  void CheckGroupingRollback(bool staged) {
    ASSERT_EQ(NS_OK, StartGrouping());
    auto& db = mCore->MessageDB();
    nsMsgKey child, control;
    ASSERT_EQ(NS_OK, AddAt(mFolderId, "rollback-child"_ns,
                           {"rollback-parent"_ns}, child));
    ASSERT_EQ(NS_OK, AddAt(mFolderId, "control"_ns, {}, control));
    ASSERT_EQ(NS_OK, db.SetMessageFlags(child, nsMsgMessageFlags::Marked));
    ASSERT_EQ(NS_OK, db.SetMessageTags(child, "old tags"_ns));
    ASSERT_EQ(NS_OK,
              db.SetMessageProperty(control, "control"_ns, "retained"_ns));
    RefPtr<Message> hot = new Message(child), sentinel = new Message(control);
    nsMsgKey oldThread;
    ASSERT_EQ(NS_OK, hot->GetThreadId(&oldThread));
    RawHdr parent;
    parent.messageId = "rollback-parent"_ns;
    parent.subject = "complete parent"_ns;
    parent.storeToken = Some(nsCString("finished"_ns));
    parent.messageSize = Some(42u);
    parent.extras.AppendElement(RawHdr::kv{"exact"_ns, "00042"_ns});
    nsMsgKey pending = nsMsgKey_None;
    if (staged) {
      ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, parent, &pending));
    }
    RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
    uint32_t calls = 0;
    Message* callbackPublication = nullptr;
    observer->action = [&](char kind, const auto&, const auto&, Message* live,
                           bool notify) {
      ++calls;
      if (kind == 'P') {
        callbackPublication = live;
        EXPECT_FALSE(notify);
        nsCString token, value;
        uint32_t size;
        EXPECT_EQ(NS_OK, live->GetStoreToken(token));
        EXPECT_EQ("finished"_ns, token);
        EXPECT_EQ(NS_OK, live->GetMessageSize(&size));
        EXPECT_EQ(42u, size);
        EXPECT_EQ(NS_OK, db.GetMessageProperty(live->Key(), "exact"_ns, value));
        EXPECT_EQ("00042"_ns, value);
      }
    };
    db.AddMessageListener(observer);
    auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
    RefPtr<FaultWitness> witness = new FaultWitness();
    ASSERT_EQ(NS_OK,
              mConnection->CreateFunction("thread_fault"_ns, 1, witness));
    // A missing late-parent update makes this injection unreached, not a
    // rollback failure.
    ASSERT_EQ(
        NS_OK,
        mConnection->ExecuteSimpleSQL(
            "CREATE TEMP TRIGGER fail_thread BEFORE UPDATE OF "
            "threadId,threadParent ON messages "
            "WHEN OLD.messageId='rollback-child' AND "
            "NEW.threadId<>OLD.threadId "
            "BEGIN SELECT thread_fault(OLD.id); SELECT RAISE(ABORT,'derived fault'); END"_ns));
    auto drop = MakeScopeExit([&] {
      EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "DROP TRIGGER IF EXISTS fail_thread"_ns));
      EXPECT_EQ(NS_OK, mConnection->RemoveFunction("thread_fault"_ns));
    });
    nsMsgKey key = nsMsgKey_None;
    Message* output = sentinel.get();
    nsresult rv = staged
                      ? db.PublishMessage(pending, false, &output)
                      : db.AddMessage(mFolderId, parent, false, &key, &output);
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, rv);
    EXPECT_EQ(nsMsgKey_None, key);
    EXPECT_EQ(sentinel.get(), output);
    if (output != sentinel.get() && output) {
      NS_RELEASE(output);
    }
    EXPECT_EQ(1u, witness->mCalls);
    EXPECT_EQ(int64_t(child), witness->mLastKey);
    EXPECT_EQ(0u, calls);
    bool active;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    CapturedMessage stored;
    ASSERT_EQ(NS_OK, db.CaptureMessage(child, stored));
    EXPECT_EQ(oldThread, stored.threadId);
    EXPECT_EQ(0u, stored.threadParent);
    EXPECT_EQ(nsMsgMessageFlags::Marked, stored.flags);
    EXPECT_EQ("old tags"_ns, stored.tags);
    nsMsgKey cachedThread;
    ASSERT_EQ(NS_OK, hot->GetThreadId(&cachedThread));
    EXPECT_EQ(oldThread, cachedThread);
    nsCString value;
    ASSERT_EQ(NS_OK, db.GetMessageProperty(control, "control"_ns, value));
    EXPECT_EQ("retained"_ns, value);
    if (staged) {
      bool exists;
      ASSERT_EQ(NS_OK, db.MessageExists(pending, exists));
      EXPECT_FALSE(exists);
      nsTArray<nsMsgKey> rows;
      ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, rows));
      EXPECT_EQ((nsTArray<nsMsgKey>{pending}), rows);
    }
    ASSERT_EQ(NS_OK,
              mConnection->ExecuteSimpleSQL("DROP TRIGGER fail_thread"_ns));
    RefPtr<Message> published;
    if (staged) {
      key = pending;
      ASSERT_EQ(NS_OK,
                db.PublishMessage(pending, false, getter_AddRefs(published)));
    } else {
      ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, parent, false, &key,
                                     getter_AddRefs(published)));
    }
    EXPECT_EQ(2u, calls);
    EXPECT_EQ(published.get(), callbackPublication);
    ASSERT_EQ(NS_OK, hot->GetThreadId(&cachedThread));
    EXPECT_EQ(key, cachedThread);
    nsMsgKey parentKey;
    ASSERT_EQ(NS_OK, hot->GetThreadParent(&parentKey));
    EXPECT_EQ(key, parentKey);
    EXPECT_EQ(0u, observer->ordinary);
  }

  void CheckPreinsertViewCapture(bool staged, bool failRead) {
    ASSERT_EQ(NS_OK, StartGrouping());
    auto& db = mCore->MessageDB();
    nsMsgKey child, control;
    ASSERT_EQ(NS_OK,
              Add("before-view-child"_ns, {"before-view-parent"_ns}, child));
    ASSERT_EQ(NS_OK, Add("before-view-control"_ns, {}, control));
    CapturedMessage oldChild;
    ASSERT_EQ(NS_OK, db.CaptureMessage(child, oldChild));
    RawHdr raw;
    raw.messageId = "before-view-parent"_ns;
    nsMsgKey pending = nsMsgKey_None;
    if (staged) {
      ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &pending));
    }
    RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
    uint32_t captures = 0, preparations = 0, publications = 0;
    observer->captureView = [&](nsCOMPtr<nsISupports>& output) -> nsresult {
      ++captures;
      bool active;
      MOZ_TRY(mConnection->GetTransactionInProgress(&active));
      EXPECT_TRUE(active);
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(mConnection->CreateStatement(
          failRead ? "SELECT abs(-9223372036854775808) FROM messages"_ns
                   : "SELECT id FROM messages ORDER BY id"_ns,
          getter_AddRefs(stmt)));
      RefPtr<ThreadViewBefore> before = new ThreadViewBefore();
      while (true) {
        bool more;
        MOZ_TRY(stmt->ExecuteStep(&more));
        if (!more) break;
        int64_t key;
        MOZ_TRY(stmt->GetInt64(0, &key));
        CapturedMessage row;
        MOZ_TRY(db.CaptureMessage(key, row));
        before->rows.AppendElement(std::move(row));
      }
      NS_ENSURE_TRUE(before->rows.Length() == 2, NS_ERROR_UNEXPECTED);
      EXPECT_EQ(child, before->rows[0].id);
      EXPECT_EQ(control, before->rows[1].id);
      EXPECT_EQ(oldChild.threadId, before->rows[0].threadId);
      EXPECT_EQ(0u, before->rows[0].threadParent);
      output = before;
      return NS_OK;
    };
    observer->prepareView = [&](const MessageThreadBatch& batch,
                                nsISupports* ownedBefore,
                                PreparedThreadBatch& output) -> nsresult {
      ++preparations;
      NS_ENSURE_TRUE(ownedBefore, NS_ERROR_UNEXPECTED);
      auto* before = static_cast<ThreadViewBefore*>(ownedBefore);
      NS_ENSURE_TRUE(before->rows.Length() == 2, NS_ERROR_UNEXPECTED);
      EXPECT_EQ(oldChild.threadId, before->rows[0].threadId);
      EXPECT_EQ(0u, before->rows[0].threadParent);
      CapturedMessage changed;
      MOZ_TRY(db.CaptureMessage(child, changed));
      EXPECT_EQ(batch.publicationKey, changed.threadId);
      EXPECT_EQ(batch.publicationKey, changed.threadParent);
      EXPECT_EQ(0u, publications);
      return observer->MessageListener::PrepareThreadBatch(batch, output);
    };
    observer->action = [&](char kind, const auto&, const auto&, Message*,
                           bool) {
      if (kind == 'P') ++publications;
    };
    db.AddMessageListener(observer);
    auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
    nsMsgKey output = nsMsgKey_None;
    RefPtr<Message> sentinel = new Message(control);
    Message* live = sentinel.get();
    nsresult rv = staged ? db.PublishMessage(pending, true, &live)
                         : db.AddMessage(mFolderId, raw, true, &output, &live);
    EXPECT_EQ(failRead ? NS_ERROR_FAILURE : NS_OK, rv);
    EXPECT_EQ(1u, captures);
    EXPECT_EQ(failRead ? 0u : 1u, preparations);
    EXPECT_EQ(failRead ? 0u : 1u, publications);
    if (failRead) {
      EXPECT_EQ(nsMsgKey_None, output);
      EXPECT_EQ(sentinel.get(), live);
      CapturedMessage unchanged;
      ASSERT_EQ(NS_OK, db.CaptureMessage(child, unchanged));
      EXPECT_EQ(oldChild.threadId, unchanged.threadId);
      EXPECT_EQ(oldChild.threadParent, unchanged.threadParent);
      if (staged) {
        nsTArray<nsMsgKey> keys;
        ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, keys));
        EXPECT_EQ((nsTArray<nsMsgKey>{pending}), keys);
      }
      uint64_t count;
      ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
      EXPECT_EQ(2u, count);
    }
    if (live && live != sentinel.get()) NS_RELEASE(live);
    bool active;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
  }

  void CheckEqualThreadWordMerge(uint32_t word) {
    ASSERT_EQ(NS_OK, StartGrouping());
    auto& db = mCore->MessageDB();
    nsMsgKey first, second, joined;
    ASSERT_EQ(NS_OK, Add("word-equal-a"_ns, {}, first));
    ASSERT_EQ(NS_OK, Add("word-equal-b"_ns, {}, second));
    CapturedMessage a, b;
    ASSERT_EQ(NS_OK, db.CaptureMessage(first, a));
    ASSERT_EQ(NS_OK, db.CaptureMessage(second, b));
    ASSERT_NE(a.threadId, b.threadId);
    ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, a.threadId, word));
    ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, b.threadId, word));
    ASSERT_EQ(NS_OK, Add("word-equal-join"_ns,
                         {"word-equal-a"_ns, "word-equal-b"_ns}, joined));
    CapturedMessage currentA, currentB;
    ASSERT_EQ(NS_OK, db.CaptureMessage(first, currentA));
    ASSERT_EQ(NS_OK, db.CaptureMessage(second, currentB));
    EXPECT_EQ(currentA.threadId, currentB.threadId);
    uint32_t stored = 7;
    ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, currentA.threadId, stored));
    EXPECT_EQ(word, stored);
    stored = 7;
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.GetThreadFlags(mFolderId, b.threadId, stored));
    EXPECT_EQ(7u, stored);
    nsTArray<nsCString> refs;
    ASSERT_EQ(NS_OK, Stored(joined, refs));
    EXPECT_EQ((nsTArray<nsCString>{"word-equal-a"_ns, "word-equal-b"_ns}),
              refs);
  }

  void CheckThreadWordConflict(bool staged, uint32_t firstWord,
                               uint32_t secondWord) {
    ASSERT_EQ(NS_OK, StartGrouping());
    auto& db = mCore->MessageDB();
    nsMsgKey first, second, control;
    ASSERT_EQ(NS_OK, Add("word-conflict-a"_ns, {}, first));
    ASSERT_EQ(NS_OK, Add("word-conflict-b"_ns, {}, second));
    ASSERT_EQ(NS_OK, Add("word-conflict-control"_ns, {}, control));
    CapturedMessage a, b;
    ASSERT_EQ(NS_OK, db.CaptureMessage(first, a));
    ASSERT_EQ(NS_OK, db.CaptureMessage(second, b));
    ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, a.threadId, firstWord));
    ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, b.threadId, secondWord));
    RefPtr<Message> hotA = new Message(first), hotB = new Message(second);
    nsMsgKey hotThread;
    ASSERT_EQ(NS_OK, hotA->GetThreadId(&hotThread));
    ASSERT_EQ(NS_OK, hotB->GetThreadId(&hotThread));
    RawHdr raw;
    raw.messageId = "word-conflict-join"_ns;
    raw.references = {"word-conflict-a"_ns, "word-conflict-b"_ns};
    raw.storeToken = Some(nsCString("retained-body"_ns));
    raw.extras.AppendElement(RawHdr::kv{"exact"_ns, "00042"_ns});
    nsMsgKey pending;
    if (staged) ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &pending));
    RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
    uint32_t calls = 0;
    observer->action = [&](char, const auto&, const auto&, Message*, bool) {
      ++calls;
    };
    db.AddMessageListener(observer);
    auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
    nsMsgKey output = nsMsgKey_None;
    RefPtr<Message> sentinel = new Message(control);
    Message* live = sentinel.get();
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              staged ? db.PublishMessage(pending, true, &live)
                     : db.AddMessage(mFolderId, raw, true, &output, &live));
    EXPECT_EQ(nsMsgKey_None, output);
    EXPECT_EQ(sentinel.get(), live);
    if (live && live != sentinel.get()) NS_RELEASE(live);
    EXPECT_EQ(0u, calls);
    for (const auto& old : {a, b}) {
      CapturedMessage current;
      ASSERT_EQ(NS_OK, db.CaptureMessage(old.id, current));
      EXPECT_EQ(old.threadId, current.threadId);
      EXPECT_EQ(old.threadParent, current.threadParent);
    }
    ASSERT_EQ(NS_OK, hotA->GetThreadId(&hotThread));
    EXPECT_EQ(a.threadId, hotThread);
    ASSERT_EQ(NS_OK, hotB->GetThreadId(&hotThread));
    EXPECT_EQ(b.threadId, hotThread);
    uint32_t word;
    ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, a.threadId, word));
    EXPECT_EQ(firstWord, word);
    ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, b.threadId, word));
    EXPECT_EQ(secondWord, word);
    uint64_t count;
    ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
    EXPECT_EQ(3u, count);
    if (staged) {
      nsTArray<nsCString> refs;
      ASSERT_EQ(NS_OK, db.GetMessageReferences(pending, refs));
      EXPECT_EQ(
          (nsTArray<nsCString>{"word-conflict-a"_ns, "word-conflict-b"_ns}),
          refs);
      nsCString exact;
      ASSERT_EQ(NS_OK, db.GetMessageProperty(pending, "exact"_ns, exact));
      EXPECT_EQ("00042"_ns, exact);
      ASSERT_EQ(NS_OK, db.GetMessageStoreToken(pending, exact));
      EXPECT_EQ("retained-body"_ns, exact);
    }
    bool active;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
  }

  void CheckQueuedChangeRollback(bool tags) {
    ASSERT_EQ(NS_OK, Start());
    auto& db = mCore->MessageDB();
    nsMsgKey key, control;
    ASSERT_EQ(NS_OK, Add("queued-change"_ns, {}, key));
    ASSERT_EQ(NS_OK, Add("queued-control"_ns, {}, control));
    ASSERT_EQ(NS_OK, db.SetMessageTags(key, "old"_ns));
    RefPtr<Message> hot = new Message(key);
    uint32_t flags;
    ASSERT_EQ(NS_OK, hot->GetFlags(&flags));
    EXPECT_EQ(0u, flags);
    RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
    uint32_t calls = 0;
    observer->action = [&](char, const auto&, const auto&, Message*, bool) {
      ++calls;
    };
    db.AddMessageListener(observer);
    auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
    RefPtr<FaultWitness> witness = new FaultWitness();
    ASSERT_EQ(NS_OK,
              mConnection->CreateFunction("change_fault"_ns, 1, witness));
    nsAutoCString sql("CREATE TEMP TRIGGER fail_change BEFORE UPDATE OF ");
    sql.Append(tags ? "tags" : "flags");
    sql.AppendLiteral(" ON messages WHEN OLD.id=");
    sql.AppendInt(key);
    sql.AppendLiteral(
        " BEGIN SELECT change_fault(OLD.id); SELECT RAISE(ABORT,'change "
        "fault'); END");
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    auto cleanup = MakeScopeExit([&] {
      EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "DROP TRIGGER IF EXISTS fail_change"_ns));
      EXPECT_EQ(NS_OK, mConnection->RemoveFunction("change_fault"_ns));
    });
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
              tags ? db.SetMessageTags(key, "new"_ns)
                   : db.SetMessageFlags(key, nsMsgMessageFlags::Read));
    EXPECT_EQ(1u, witness->mCalls);
    EXPECT_EQ(int64_t(key), witness->mLastKey);
    EXPECT_EQ(0u, calls);
    bool active;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    CapturedMessage row;
    ASSERT_EQ(NS_OK, db.CaptureMessage(key, row));
    EXPECT_EQ(0u, row.flags);
    EXPECT_EQ("old"_ns, row.tags);
    ASSERT_EQ(NS_OK, hot->GetFlags(&flags));
    EXPECT_EQ(0u, flags);
    nsCString text;
    ASSERT_EQ(NS_OK, hot->GetStringProperty("keywords", text));
    EXPECT_EQ("old"_ns, text);
    ASSERT_EQ(NS_OK, db.CaptureMessage(control, row));
    EXPECT_EQ("queued-control"_ns, row.messageId);
    EXPECT_EQ(0u, row.flags);
    ASSERT_EQ(NS_OK,
              mConnection->ExecuteSimpleSQL("DROP TRIGGER fail_change"_ns));
    ASSERT_EQ(NS_OK, tags ? db.SetMessageTags(key, "new"_ns)
                          : db.SetMessageFlags(key, nsMsgMessageFlags::Read));
    EXPECT_EQ(1u, calls);
    ASSERT_EQ(NS_OK, db.CaptureMessage(key, row));
    EXPECT_EQ(tags ? 0u : nsMsgMessageFlags::Read, row.flags);
    EXPECT_EQ(tags ? "new"_ns : "old"_ns, row.tags);
  }

  nsresult AddAt(uint64_t folderId, const nsACString& messageId,
                 const nsTArray<nsCString>& references, nsMsgKey& key) {
    RawHdr raw;
    raw.messageId = messageId;
    raw.references = references.Clone();
    raw.date = 1700000000000000;
    raw.sender = "sender@conversation.invalid"_ns;
    raw.recipients = "recipient@conversation.invalid"_ns;
    raw.subject = "Same subject"_ns;
    return mCore->MessageDB().AddMessage(folderId, raw, true, &key);
  }

  nsresult PlanConversation(nsMsgKey key, bool notifyLegacy,
                            MessageThreadBatch& output) {
    return mCore->MessageDB().PlanConversationInsertion(key, notifyLegacy,
                                                        output);
  }

  const CapturedMessage* Planned(const MessageThreadBatch& batch,
                                 nsMsgKey key) {
    for (const auto& row : batch.after) {
      if (row.id == key) {
        return &row;
      }
    }
    return nullptr;
  }

  nsresult PhysicalFolderKeys(uint64_t folderId, nsTArray<nsMsgKey>& keys) {
    return mCore->MessageDB().ListAllKeys(folderId, keys);
  }

  nsresult AdmissionSource(DatabaseCore* core, nsACString& output) {
    return core->ReadSourceIdForFolderAdmission(output);
  }

  nsresult ImapRelocationProperty(uint64_t folder, const nsACString& name,
                                  Maybe<nsCString>& output) {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(mConnection->CreateStatement(
        "SELECT value FROM folder_properties WHERE id=:id AND name=:name"_ns,
        getter_AddRefs(stmt)));
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, folder));
    MOZ_TRY(stmt->BindUTF8StringByName("name"_ns, name));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    Maybe<nsCString> found;
    if (more) {
      int32_t type;
      nsCString text;
      MOZ_TRY(stmt->GetTypeOfIndex(0, &type));
      NS_ENSURE_TRUE(type == mozIStorageStatement::VALUE_TYPE_TEXT,
                     NS_ERROR_FILE_CORRUPTED);
      MOZ_TRY(stmt->GetUTF8String(0, text));
      found = Some(std::move(text));
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
    }
    output = std::move(found);
    return NS_OK;
  }

  nsresult SeedImapRelocationProperty(uint64_t folder, const nsACString& name,
                                      const nsACString& text) {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(mConnection->CreateStatement(
        "REPLACE INTO folder_properties(id,name,value) VALUES(:id,:name,:value)"_ns,
        getter_AddRefs(stmt)));
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, folder));
    MOZ_TRY(stmt->BindUTF8StringByName("name"_ns, name));
    MOZ_TRY(stmt->BindUTF8StringByName("value"_ns, text));
    return stmt->Execute();
  }

  nsresult RemovalMetric(uint64_t folder, int64_t& output) {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(mConnection->CreateStatement(
        "SELECT value FROM folder_properties WHERE id=:folder "
        "AND name='expungedBytes'"_ns,
        getter_AddRefs(stmt)));
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folder));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    int64_t value = 0;
    if (more) MOZ_TRY(stmt->GetInt64(0, &value));
    output = value;
    return NS_OK;
  }

  void CheckFolderIdentity(uint64_t id, uint64_t parent,
                           const nsACString& name) {
    auto cachedParent = mCore->FolderDB().GetFolderParent(id);
    ASSERT_TRUE(cachedParent.isOk());
    EXPECT_EQ(parent, cachedParent.unwrap());
    auto cachedName = mCore->FolderDB().GetFolderName(id);
    ASSERT_TRUE(cachedName.isOk());
    EXPECT_EQ(name, cachedName.unwrap());
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
    nsCOMPtr<mozIStorageStatement> stmt;
    auto close = MakeScopeExit([&] {
      if (stmt) EXPECT_EQ(NS_OK, stmt->Finalize());
      EXPECT_EQ(NS_OK, reader->Close());
    });
    ASSERT_EQ(NS_OK, reader->CreateStatement(
                         "SELECT parent,name FROM folders WHERE id=:id"_ns,
                         getter_AddRefs(stmt)));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, id));
    bool more;
    ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
    ASSERT_TRUE(more);
    int64_t actualParent;
    nsCString actualName;
    ASSERT_EQ(NS_OK, stmt->GetInt64(0, &actualParent));
    ASSERT_EQ(NS_OK, stmt->GetUTF8String(1, actualName));
    EXPECT_EQ(parent, uint64_t(actualParent));
    EXPECT_EQ(name, actualName);
    ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
    EXPECT_FALSE(more);
  }

  nsresult SetRemovalMetric(uint64_t folder, int64_t value) {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(mConnection->CreateStatement(
        "REPLACE INTO folder_properties VALUES(:folder,'expungedBytes',:value)"_ns,
        getter_AddRefs(stmt)));
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folder));
    MOZ_TRY(stmt->BindInt64ByName("value"_ns, value));
    return stmt->Execute();
  }

  void CheckSiblingOrder(uint64_t parent, const nsTArray<uint64_t>& expected,
                         bool assigned = true) {
    auto actual = mCore->FolderDB().GetFolderChildren(parent);
    ASSERT_TRUE(actual.isOk());
    EXPECT_EQ(expected, actual.unwrap());
    for (uint32_t i = 0; i < expected.Length(); ++i) {
      auto ordinal = mCore->FolderDB().GetFolderOrdinal(expected[i]);
      ASSERT_TRUE(ordinal.isOk());
      if (assigned) {
        EXPECT_EQ(Some(uint64_t(i + 1)), ordinal.unwrap());
      } else {
        EXPECT_FALSE(ordinal.unwrap());
      }
    }
    // The second connection checks persisted rows independently of the cache.
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
    nsCOMPtr<mozIStorageStatement> stmt;
    auto close = MakeScopeExit([&] {
      if (stmt) EXPECT_EQ(NS_OK, stmt->Finalize());
      EXPECT_EQ(NS_OK, reader->Close());
    });
    ASSERT_EQ(NS_OK, reader->CreateStatement(
                         "SELECT id,ordinal FROM folders WHERE parent=:parent "
                         "ORDER BY ordinal,name"_ns,
                         getter_AddRefs(stmt)));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("parent"_ns, parent));
    for (uint32_t i = 0; i < expected.Length(); ++i) {
      bool more;
      ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
      ASSERT_TRUE(more);
      int64_t id;
      ASSERT_EQ(NS_OK, stmt->GetInt64(0, &id));
      EXPECT_EQ(expected[i], uint64_t(id));
      bool absent;
      ASSERT_EQ(NS_OK, stmt->GetIsNull(1, &absent));
      EXPECT_EQ(!assigned, absent);
      if (assigned) {
        int64_t ordinal;
        ASSERT_EQ(NS_OK, stmt->GetInt64(1, &ordinal));
        EXPECT_EQ(int64_t(i + 1), ordinal);
      }
    }
    bool more;
    ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
    EXPECT_FALSE(more);
  }

  nsresult Add(const nsACString& messageId,
               const nsTArray<nsCString>& references, nsMsgKey& key) {
    return mCore->MessageDB().AddMessage(
        mFolderId, messageId, references, 123456, "sender"_ns, "recipient"_ns,
        EmptyCString(), EmptyCString(), "subject"_ns, 0, EmptyCString(), 0,
        &key);
  }

  nsresult Stored(nsMsgKey key, nsTArray<nsCString>& values) {
    nsCOMPtr<mozIStorageConnection> reader;
    MOZ_TRY(Open(getter_AddRefs(reader)));
    nsCOMPtr<mozIStorageStatement> stmt;
    auto cleanup = MakeScopeExit([&] {
      if (stmt) {
        EXPECT_EQ(NS_OK, stmt->Finalize());
      }
      EXPECT_EQ(NS_OK, reader->Close());
    });
    MOZ_TRY(reader->CreateStatement(
        "SELECT token FROM message_references WHERE id = :id ORDER BY ordinal"_ns,
        getter_AddRefs(stmt)));
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    bool more;
    while (true) {
      MOZ_TRY(stmt->ExecuteStep(&more));
      if (!more) {
        break;
      }
      nsCString token;
      MOZ_TRY(stmt->GetUTF8String(0, token));
      values.AppendElement(token);
    }
    return NS_OK;
  }

  void CheckUsedDestinationRejected(OfflineAttemptState state) {
    ASSERT_EQ(NS_OK, Start());
    auto& db = mCore->MessageDB();
    uint32_t epoch = 91;
    ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, epoch));
    RawHdr raw;
    raw.messageId = "used-destination@invalid"_ns;
    nsMsgKey used, fresh;
    ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &used));
    raw.messageId = "fresh-destination@invalid"_ns;
    ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &fresh));
    OfflineOperationData payload;
    payload.operation = 0x10;
    ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, used, payload));
    uint64_t first;
    ASSERT_EQ(NS_OK,
              db.BeginOfflineAttempt(
                  mFolderId, used, 0x10,
                  Some(PendingDestination{mFolderId, used, epoch}), first));
    if (state == OfflineAttemptState::Ambiguous) {
      ASSERT_EQ(NS_OK, db.MarkOfflineAttemptAmbiguous(first));
    } else if (state == OfflineAttemptState::Confirmed) {
      ASSERT_EQ(NS_OK, db.ConfirmOfflineAttempt(
                           first, Some(ServerUidConfirmation{epoch, 42})));
      // Retiring the old binding does not make this physical key unused.
      ++epoch;
      ASSERT_EQ(NS_OK,
                mCore->FolderDB().SetFolderUidValidity(mFolderId, epoch));
    }
    nsTArray<nsCString> names;
    ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(used, names));
    ASSERT_FALSE(names.Contains("uidOnServer"_ns));
    OfflineAttempt original;
    ASSERT_EQ(NS_OK, db.GetOfflineAttempt(first, original));
    EXPECT_EQ(state, original.state);
    ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, fresh, payload));
    uint64_t output = 123;
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.BeginOfflineAttempt(
                  mFolderId, fresh, 0x10,
                  Some(PendingDestination{mFolderId, used, epoch}), output));
    EXPECT_EQ(123u, output);
    OfflineAttempt untouched;
    untouched.id = 88;
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.GetCurrentOfflineAttempt(mFolderId, fresh, untouched));
    EXPECT_EQ(88u, untouched.id);
    ASSERT_EQ(NS_OK,
              db.BeginOfflineAttempt(
                  mFolderId, fresh, 0x10,
                  Some(PendingDestination{mFolderId, fresh, epoch}), output));
    EXPECT_NE(first, output);
  }

  void CheckSelfDestinationRejected(uint32_t action) {
    ASSERT_EQ(NS_OK, Start());
    auto& db = mCore->MessageDB();
    ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 92));
    nsMsgKey source, destination;
    ASSERT_EQ(NS_OK, Add("self-source@invalid"_ns, {}, source));
    ASSERT_EQ(NS_OK, db.BindMessageToServerUid(source, mFolderId, 92, 42));
    RawHdr raw;
    raw.messageId = "distinct-destination@invalid"_ns;
    ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &destination));
    OfflineOperationData payload;
    payload.operation = action;
    ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, payload));
    uint64_t output = 123;
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.BeginOfflineAttempt(
                  mFolderId, source, action,
                  Some(PendingDestination{mFolderId, source, 92}), output));
    EXPECT_EQ(123u, output);
    ASSERT_EQ(NS_OK, db.BeginOfflineAttempt(
                         mFolderId, source, action,
                         Some(PendingDestination{mFolderId, destination, 92}),
                         output));
    OfflineAttempt attempt;
    ASSERT_EQ(NS_OK, db.GetOfflineAttempt(output, attempt));
    ASSERT_TRUE(attempt.source);
    ASSERT_TRUE(attempt.destination);
    EXPECT_EQ(source, attempt.source->key);
    EXPECT_EQ(destination, attempt.destination->key);
  }

  void CheckGroupingOff() {
    ASSERT_FALSE(mCore->MessageDB().mConversationGroupingEnabled);
  }

  void CheckRetiredReferences(bool stagedReply) {
    ASSERT_EQ(NS_OK, Start());
    auto& db = mCore->MessageDB();
    auto& folders = mCore->FolderDB();
    ASSERT_FALSE(db.mConversationGroupingEnabled);
    uint64_t retired, first, second;
    ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Retired"_ns, &retired));
    nsMsgKey oldRoot, oldCopy, oldReply;
    ASSERT_EQ(NS_OK, AddAt(retired, "0@made.up.invalid"_ns, {}, oldRoot));
    ASSERT_EQ(NS_OK, AddAt(retired, "0@made.up.invalid"_ns, {}, oldCopy));
    ASSERT_EQ(NS_OK, AddAt(retired, "1@made.up.invalid"_ns,
                           {"0@made.up.invalid"_ns}, oldReply));
    ASSERT_EQ(NS_OK, db.SetMessageStoreToken(oldRoot, "retained-body"_ns));
    MessageBodyState before;
    ASSERT_EQ(NS_OK, db.GetMessageBodyState(oldRoot, before));
    CapturedMessage historical;
    ASSERT_EQ(NS_OK, db.CaptureMessage(oldReply, historical));
    ASSERT_EQ(NS_OK, folders.DeleteFolder(retired));
    ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "First"_ns, &first));
    ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Second"_ns, &second));

    RawHdr raw;
    raw.messageId = "0@made.up.invalid"_ns;
    raw.subject = "Conversation root outside query"_ns;
    nsMsgKey root, reply, copy, tail, unrelated;
    ASSERT_EQ(NS_OK, db.AddMessage(first, raw, true, &root));
    ASSERT_GT(root, oldReply);
    raw.messageId = "1@made.up.invalid"_ns;
    raw.subject = "panoramafacetedphysicalneedle"_ns;
    raw.references = {"0@made.up.invalid"_ns};
    if (stagedReply) {
      ASSERT_EQ(NS_OK, db.StageMessage(second, raw, &reply));
      Maybe<CapturedMessage> staged;
      ASSERT_EQ(NS_OK, db.CaptureHeaderState(reply, staged));
      ASSERT_TRUE(staged);
      EXPECT_EQ(root, staged->threadId);
      EXPECT_EQ(root, staged->threadParent);
      bool exists = true;
      ASSERT_EQ(NS_OK, db.MessageExists(reply, exists));
      EXPECT_FALSE(exists);
      ASSERT_EQ(NS_OK, db.PublishMessage(reply, true));
    } else {
      ASSERT_EQ(NS_OK, db.AddMessage(second, raw, true, &reply));
    }
    ASSERT_EQ(NS_OK, db.AddMessage(first, raw, true, &copy));
    raw.messageId = "2@made.up.invalid"_ns;
    raw.subject = "Conversation tail outside query"_ns;
    raw.references = {"0@made.up.invalid"_ns, "1@made.up.invalid"_ns};
    ASSERT_EQ(NS_OK, db.AddMessage(second, raw, true, &tail));
    raw.messageId = "unrelated@invalid"_ns;
    raw.references.Clear();
    ASSERT_EQ(NS_OK, db.AddMessage(first, raw, true, &unrelated));
    for (auto pair : {std::pair{root, nsMsgKey{0}}, std::pair{reply, root},
                      std::pair{copy, root}, std::pair{tail, reply}}) {
      CapturedMessage stored;
      ASSERT_EQ(NS_OK, db.CaptureMessage(pair.first, stored));
      EXPECT_EQ(root, stored.threadId);
      EXPECT_EQ(pair.second, stored.threadParent);
    }
    // The same stored threadId predicate used by ConversationFilter must
    // include both nonmatching endpoints and both physical reply copies.
    nsCOMPtr<mozIStorageStatement> stmt;
    ASSERT_EQ(
        NS_OK,
        mConnection->CreateStatement(
            "SELECT id FROM messages WHERE threadId=:thread ORDER BY id"_ns,
            getter_AddRefs(stmt)));
    auto finalize = MakeScopeExit([&] { EXPECT_EQ(NS_OK, stmt->Finalize()); });
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("thread"_ns, root));
    nsTArray<nsMsgKey> members;
    bool more;
    while (true) {
      ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
      if (!more) break;
      int64_t key;
      ASSERT_EQ(NS_OK, stmt->GetInt64(0, &key));
      members.AppendElement(static_cast<nsMsgKey>(key));
    }
    EXPECT_EQ((nsTArray<nsMsgKey>{root, reply, copy, tail}), members);
    nsTArray<nsCString> references;
    ASSERT_EQ(NS_OK, Stored(tail, references));
    EXPECT_EQ(
        (nsTArray<nsCString>{"0@made.up.invalid"_ns, "1@made.up.invalid"_ns}),
        references);
    CapturedMessage control, retained;
    ASSERT_EQ(NS_OK, db.CaptureMessage(unrelated, control));
    EXPECT_EQ(unrelated, control.threadId);
    ASSERT_EQ(NS_OK, db.CaptureMessage(oldReply, retained));
    EXPECT_EQ(historical.threadId, retained.threadId);
    EXPECT_EQ(historical.threadParent, retained.threadParent);
    EXPECT_EQ(retired, retained.folderId);
    for (nsMsgKey key : {oldRoot, oldCopy, oldReply}) {
      bool exists = false;
      ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
      EXPECT_TRUE(exists);
    }
    MessageBodyState after;
    ASSERT_EQ(NS_OK, db.GetMessageBodyState(oldRoot, after));
    EXPECT_EQ(retired, after.folderId);
    EXPECT_EQ(Some(nsCString("retained-body"_ns)), after.storeToken);
    EXPECT_EQ(before.contentRevision, after.contentRevision);
    EXPECT_EQ(before.locationRevision, after.locationRevision);
    ASSERT_FALSE(db.mConversationGroupingEnabled);
  }

  void CheckOfflineSource(nsMsgKey key, uint32_t expectedEpoch,
                          uint32_t expectedUid) {
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
    nsCOMPtr<mozIStorageStatement> stmt;
    auto close = MakeScopeExit([&] {
      if (stmt) {
        EXPECT_EQ(NS_OK, stmt->Finalize());
      }
      EXPECT_EQ(NS_OK, reader->Close());
    });
    ASSERT_EQ(NS_OK,
              reader->CreateStatement(
                  "SELECT epoch, uid, folderEpoch FROM offline_operations "
                  "WHERE folderId = :folder AND messageKey = :key"_ns,
                  getter_AddRefs(stmt)));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("folder"_ns, mFolderId));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("key"_ns, key));
    bool more, folderWide;
    ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
    ASSERT_TRUE(more);
    int64_t epoch, uid;
    ASSERT_EQ(NS_OK, stmt->GetInt64(0, &epoch));
    ASSERT_EQ(NS_OK, stmt->GetInt64(1, &uid));
    ASSERT_EQ(NS_OK, stmt->GetIsNull(2, &folderWide));
    EXPECT_EQ(expectedEpoch, epoch);
    EXPECT_EQ(expectedUid, uid);
    EXPECT_TRUE(folderWide);
    ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
    EXPECT_FALSE(more);
  }

  nsresult PrepareRelocation(FolderBodyRelocation& plan) {
    plan.folderId = mFolderId;
    plan.token = "relocation-unit"_ns;
    MOZ_TRY(mCore->GetSourceId(plan.databaseSourceId));
    plan.originalSize = 64;
    plan.compactedSize = 32;
    for (auto pair : {std::pair{u"body.old", &plan.originalPath},
                      {u"body.compacted", &plan.compactedPath},
                      {u"body.backup", &plan.backupPath}}) {
      nsCOMPtr<nsIFile> file;
      MOZ_TRY(mProfile->Clone(getter_AddRefs(file)));
      MOZ_TRY(file->Append(nsDependentString(pair.first)));
      MOZ_TRY(file->GetPath(*pair.second));
      if (pair.second != &plan.backupPath) {
        MOZ_TRY(file->Create(nsIFile::NORMAL_FILE_TYPE, 0600));
        MOZ_TRY(file->SetFileSize(pair.second == &plan.originalPath ? 64 : 32));
      }
    }
    for (uint32_t i = 0; i < 2; ++i) {
      nsMsgKey key;
      nsAutoCString id("relocation-");
      id.AppendInt(i);
      MOZ_TRY(Add(id, {"ancestor"_ns, "ancestor"_ns}, key));
      RelocatedMessageBody* row = plan.messages.AppendElement();
      nsAutoCString token("old-");
      token.AppendInt(i);
      MOZ_TRY(mCore->MessageDB().SetMessageStoreToken(key, token));
      MOZ_TRY(mCore->MessageDB().SetMessageFlags(key, 5));
      MOZ_TRY(
          mCore->MessageDB().SetMessageProperty(key, "Case"_ns, "00042"_ns));
      MOZ_TRY(mCore->MessageDB().GetMessageBodyState(key, row->before));
      token.AssignLiteral("new-");
      token.AppendInt(i);
      row->storeToken = Some(nsCString(token));
      row->messageSize = 10 + i;
      row->offlineMessageSize = 8 + i;
      row->lineCount = 2 + i;
      row->offline = true;
    }
    return NS_OK;
  }

  nsresult InstallRelocation(const FolderBodyRelocation& plan) {
    nsCOMPtr<nsIFile> original, compacted, backup, directory;
    MOZ_TRY(NS_NewLocalFile(plan.originalPath, getter_AddRefs(original)));
    MOZ_TRY(NS_NewLocalFile(plan.compactedPath, getter_AddRefs(compacted)));
    MOZ_TRY(NS_NewLocalFile(plan.backupPath, getter_AddRefs(backup)));
    MOZ_TRY(original->GetParent(getter_AddRefs(directory)));
    nsAutoString oldName, backupName;
    MOZ_TRY(original->GetLeafName(oldName));
    MOZ_TRY(backup->GetLeafName(backupName));
    MOZ_TRY(original->RenameTo(directory, backupName));
    return compacted->RenameTo(directory, oldName);
  }

#ifdef XP_WIN
  nsresult ImportPathIdentity(nsIFile* file, FolderImportPathIdentity& output) {
    RefPtr<MigrationFileSystem> system = new MigrationFileSystem();
    nsCOMPtr<nsIPanoramaMigrationPath> lease;
    MOZ_TRY(system->Admit(file, mProfile,
                          nsIPanoramaMigrationFileSystem::KIND_FILE,
                          getter_AddRefs(lease)));
    auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, lease->Close()); });
    MOZ_TRY(file->GetPath(output.originalPath));
    MOZ_TRY(mProfile->GetPath(output.originalRoot));
    MOZ_TRY(lease->GetCanonicalPath(output.canonicalPath));
    MOZ_TRY(lease->GetCanonicalRoot(output.canonicalRoot));
    MOZ_TRY(lease->GetIdentity(output.id));
    MOZ_TRY(lease->GetParentIdentity(output.parentId));
    MOZ_TRY(lease->GetRootIdentity(output.rootId));
    return NS_OK;
  }
#endif

  nsresult PrepareNativeImport(FolderImportSnapshot& input, nsIFile** source) {
    uint64_t folder;
    MOZ_TRY(mCore->FolderDB().InsertFolder(mFolderId, "Import"_ns, &folder));
    input.identity.folderId = folder;
    input.identity.folderPath =
        MOZ_TRY(mCore->FolderDB().GetFolderPath(folder));
    input.identity.token = "native-import-token"_ns;
    input.identity.sourceId = "native-original-folder"_ns;
    MOZ_TRY(mCore->GetSourceId(input.identity.databaseSourceId));
    input.identity.sourceSha256 =
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"_ns;
    nsCOMPtr<nsIFile> file;
    MOZ_TRY(mProfile->Clone(getter_AddRefs(file)));
    MOZ_TRY(file->Append(u"native-source.bin"_ns));
    MOZ_TRY(file->Create(nsIFile::NORMAL_FILE_TYPE, 0600));
    MOZ_TRY(file->GetPath(input.identity.sourcePath));
#ifdef XP_WIN
    nsCOMPtr<nsIFile> store;
    MOZ_TRY(mProfile->Clone(getter_AddRefs(store)));
    MOZ_TRY(store->Append(u"native-body.bin"_ns));
    MOZ_TRY(store->Create(nsIFile::NORMAL_FILE_TYPE, 0600));
    FolderImportWindowsIdentity paths;
    MOZ_TRY(ImportPathIdentity(file, paths.summary));
    MOZ_TRY(ImportPathIdentity(store, paths.store));
    input.identity.sourcePath = paths.summary.canonicalPath;
    input.identity.windows = Some(std::move(paths));
#endif
    // Native transaction input, not a fabricated Mork/parser fixture.
    input.recordsComplete = true;
    FolderImportMessage* child = input.messages.AppendElement();
    child->sourceKey = 9;
    child->rootSourceKey = 0;
    child->parentSourceKey = Some(nsMsgKey(0));
    child->header.messageId = "child-import@invalid"_ns;
    child->header.subject = "imported child"_ns;
    child->header.storeToken = Some(nsCString("retained-original-body"_ns));
    child->header.messageSize = Some(uint32_t(0));
    child->header.references = {"root-import@invalid"_ns, "missing@invalid"_ns,
                                "root-import@invalid"_ns};
    child->header.extras = {{"Case"_ns, "00042"_ns},
                            {"case"_ns, "1e3"_ns},
                            {"keywords"_ns, "first"_ns},
                            {"keywords"_ns, "last"_ns}};
    FolderImportMessage* root = input.messages.AppendElement();
    root->sourceKey = 0;
    root->rootSourceKey = 0;
    root->header.messageId = "root-import@invalid"_ns;
    root->header.subject = "imported root"_ns;
    file.forget(source);
    return NS_OK;
  }

  nsresult ImportNativeFile(nsIFile* source, const FolderImportSnapshot& input,
                            FolderImportReceipt& output) {
    return mCore->ImportFolderSnapshotFromFile(source, input, output);
  }

  nsresult ThreadKeys(uint64_t folder, uint64_t parent, uint64_t thread,
                      nsTArray<nsMsgKey>& keys) {
    return mCore->MessageDB().ListThreadKeys(folder, parent, thread, keys);
  }
  nsresult ThreadChildren(uint64_t folder, uint64_t parent,
                          nsTArray<nsMsgKey>& keys) {
    return mCore->MessageDB().ListThreadChildKeys(folder, parent, keys);
  }
  nsresult ThreadCount(uint64_t folder, uint64_t thread, uint64_t* count) {
    return mCore->MessageDB().CountThreadKeys(folder, thread, count);
  }
  nsresult ThreadMaxDate(uint64_t folder, uint64_t thread, uint64_t* date) {
    return mCore->MessageDB().GetThreadMaxDate(folder, thread, date);
  }

  nsresult StoredKnownMarker(nsMsgKey key, bool& known) {
    nsCOMPtr<mozIStorageConnection> reader;
    MOZ_TRY(Open(getter_AddRefs(reader)));
    nsCOMPtr<mozIStorageStatement> stmt;
    auto cleanup = MakeScopeExit([&] {
      if (stmt) {
        EXPECT_EQ(NS_OK, stmt->Finalize());
      }
      EXPECT_EQ(NS_OK, reader->Close());
    });
    MOZ_TRY(reader->CreateStatement(
        "SELECT 1 FROM message_reference_sets WHERE id = :id"_ns,
        getter_AddRefs(stmt)));
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    return stmt->ExecuteStep(&known);
  }

  nsCOMPtr<nsIProperties> mDirectories;
  nsCOMPtr<nsIFile> mOldProfile, mProfile, mFile;
  nsCOMPtr<mozIStorageService> mStorage;
  RefPtr<DatabaseCore> mCore;
  nsCOMPtr<mozIStorageConnection> mConnection;
  bool mProfileCreated = false;
  bool mDirectoryChanged = false;
  bool mRestoreProfileCache = false;
  uint64_t mFolderId = 0;
};

namespace {

using DISABLED_DeliveryCoreReferences = DeliveryCoreReferences;

TEST_F(DeliveryCoreReferences, AddNotificationSeesCommittedReferences) {
  ASSERT_EQ(NS_OK, Start());
  uint32_t notifications = 0;
  nsMsgKey notified = 0;
  RefPtr<AddedObserver> observer = new AddedObserver([&](Message* message) {
    ++notifications;
    ASSERT_EQ(NS_OK, message->GetMessageKey(&notified));
    nsTArray<nsCString> got, stored;
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(notified, got));
    EXPECT_EQ(
        (nsTArray<nsCString>{"ancestor@invalid"_ns, "ancestor@invalid"_ns}),
        got);
    ASSERT_EQ(NS_OK, Stored(notified, stored));
    EXPECT_EQ(
        (nsTArray<nsCString>{"ancestor@invalid"_ns, "ancestor@invalid"_ns}),
        stored);
  });
  mCore->MessageDB().AddMessageListener(observer);
  auto cleanup = MakeScopeExit(
      [&] { mCore->MessageDB().RemoveMessageListener(observer); });
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("child@invalid"_ns,
                       {"ancestor@invalid"_ns, "ancestor@invalid"_ns}, key));
  EXPECT_EQ(1u, notifications);
  EXPECT_EQ(key, notified);
}

TEST_F(DeliveryCoreReferences, ExactTokensSurviveReopen) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("child@invalid"_ns,
                       {"Missing@invalid"_ns, ""_ns, "e\xcc\x81@invalid"_ns,
                        "\xc3\xa9@invalid"_ns, "Missing@invalid"_ns},
                       key));
  nsTArray<nsCString> got, stored;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(key, got));
  EXPECT_EQ(
      (nsTArray<nsCString>{"Missing@invalid"_ns, ""_ns, "e\xcc\x81@invalid"_ns,
                           "\xc3\xa9@invalid"_ns, "Missing@invalid"_ns}),
      got);
  ASSERT_EQ(NS_OK, Stored(key, stored));
  EXPECT_EQ(
      (nsTArray<nsCString>{"Missing@invalid"_ns, ""_ns, "e\xcc\x81@invalid"_ns,
                           "\xc3\xa9@invalid"_ns, "Missing@invalid"_ns}),
      stored);
  Stop();
  ASSERT_EQ(NS_OK, Start());
  got.Clear();
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(key, got));
  EXPECT_EQ(
      (nsTArray<nsCString>{"Missing@invalid"_ns, ""_ns, "e\xcc\x81@invalid"_ns,
                           "\xc3\xa9@invalid"_ns, "Missing@invalid"_ns}),
      got);
}

TEST_F(DeliveryCoreReferences, ReplaceAndClearDoNotRethread) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey parent, child;
  ASSERT_EQ(NS_OK, Add("parent@invalid"_ns, {}, parent));
  ASSERT_EQ(NS_OK, Add("child@invalid"_ns, {"parent@invalid"_ns}, child));
  nsMsgKey oldThread, oldParent, newThread, newParent;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageThreadId(child, oldThread));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageThreadParent(child, oldParent));
  ASSERT_EQ(parent, oldParent);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().SetMessageReferences(
                child, {"replacement@invalid"_ns, "replacement@invalid"_ns}));
  nsTArray<nsCString> got, stored;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(child, got));
  EXPECT_EQ(
      (nsTArray<nsCString>{"replacement@invalid"_ns, "replacement@invalid"_ns}),
      got);
  ASSERT_EQ(NS_OK, Stored(child, stored));
  EXPECT_EQ(
      (nsTArray<nsCString>{"replacement@invalid"_ns, "replacement@invalid"_ns}),
      stored);
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageReferences(child, {}));
  got.Clear();
  stored.Clear();
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(child, got));
  EXPECT_TRUE(got.IsEmpty());
  ASSERT_EQ(NS_OK, Stored(child, stored));
  EXPECT_TRUE(stored.IsEmpty());
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageThreadId(child, newThread));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageThreadParent(child, newParent));
  EXPECT_EQ(oldThread, newThread);
  EXPECT_EQ(oldParent, newParent);
  uint32_t flags;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageFlags(child, flags));
  EXPECT_EQ(0u, flags);
  uint64_t count;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(2u, count);
}

TEST_F(DeliveryCoreReferences, FailedReplacementPreservesCommittedSequence) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("child@invalid"_ns, {"original@invalid"_ns}, key));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("references_fault"_ns, 1, witness));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "CREATE TEMP TRIGGER fail_references BEFORE INSERT ON "
                "message_references "
                "WHEN NEW.ordinal = 1 BEGIN SELECT references_fault(NEW.id); "
                "SELECT RAISE(ABORT, 'references replacement fault'); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            mCore->MessageDB().SetMessageReferences(
                key, {"first@invalid"_ns, "second@invalid"_ns}));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(int64_t(key), witness->mLastKey);
  nsTArray<nsCString> got, stored;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(key, got));
  EXPECT_EQ((nsTArray<nsCString>{"original@invalid"_ns}), got);
  ASSERT_EQ(NS_OK, Stored(key, stored));
  EXPECT_EQ((nsTArray<nsCString>{"original@invalid"_ns}), stored);
  bool inTransaction;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&inTransaction));
  EXPECT_FALSE(inTransaction);
}

TEST_F(DeliveryCoreReferences, FailedClearPreservesCommittedSequence) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("child@invalid"_ns, {"original@invalid"_ns}, key));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("references_fault"_ns, 1, witness));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER fail_clear BEFORE DELETE ON message_references "
          "BEGIN SELECT references_fault(OLD.id); "
          "SELECT RAISE(ABORT, 'references clear fault'); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            mCore->MessageDB().SetMessageReferences(key, {}));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(int64_t(key), witness->mLastKey);
  nsTArray<nsCString> got, stored;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(key, got));
  EXPECT_EQ((nsTArray<nsCString>{"original@invalid"_ns}), got);
  ASSERT_EQ(NS_OK, Stored(key, stored));
  EXPECT_EQ((nsTArray<nsCString>{"original@invalid"_ns}), stored);
}

TEST_F(DeliveryCoreReferences, FailedAddRollsBackMessageAndReferences) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey control, failed = 0;
  ASSERT_EQ(NS_OK, Add("control@invalid"_ns, {"kept@invalid"_ns}, control));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("references_fault"_ns, 1, witness));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "CREATE TEMP TRIGGER fail_references BEFORE INSERT ON "
                "message_references "
                "WHEN NEW.ordinal = 1 BEGIN SELECT references_fault(NEW.id); "
                "SELECT RAISE(ABORT, 'references add fault'); END"_ns));
  EXPECT_EQ(
      NS_ERROR_STORAGE_CONSTRAINT,
      Add("failed@invalid"_ns, {"one@invalid"_ns, "two@invalid"_ns}, failed));
  EXPECT_EQ(1u, witness->mCalls);
  ASSERT_GT(witness->mLastKey, 0);
  ASSERT_LT(uint64_t(witness->mLastKey), uint64_t(nsMsgKey_None));
  EXPECT_NE(int64_t(control), witness->mLastKey);
  nsTArray<nsCString> absent;
  EXPECT_EQ(NS_ERROR_UNEXPECTED,
            mCore->MessageDB().GetMessageReferences(
                static_cast<nsMsgKey>(witness->mLastKey), absent));
  ASSERT_EQ(NS_OK, Stored(static_cast<nsMsgKey>(witness->mLastKey), absent));
  EXPECT_TRUE(absent.IsEmpty());
  uint64_t count;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(1u, count);
  nsTArray<nsCString> got;
  ASSERT_EQ(NS_OK, Stored(control, got));
  EXPECT_EQ((nsTArray<nsCString>{"kept@invalid"_ns}), got);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER fail_references"_ns));
  ASSERT_EQ(NS_OK, Add("retry@invalid"_ns, {"one@invalid"_ns}, failed));
  got.Clear();
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(failed, got));
  EXPECT_EQ((nsTArray<nsCString>{"one@invalid"_ns}), got);
}

TEST_F(DeliveryCoreReferences, MissingRowsAndStorageErrorsAreFailures) {
  ASSERT_EQ(NS_OK, Start());
  nsTArray<nsCString> got{"unchanged"_ns};
  EXPECT_EQ(NS_ERROR_UNEXPECTED,
            mCore->MessageDB().GetMessageReferences(123, got));
  EXPECT_EQ(NS_ERROR_UNEXPECTED,
            mCore->MessageDB().SetMessageReferences(123, {}));
  EXPECT_EQ((nsTArray<nsCString>{"unchanged"_ns}), got);
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("child@invalid"_ns, {}, key));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "ALTER TABLE message_references RENAME TO unavailable_references"_ns));
  EXPECT_EQ(NS_ERROR_FAILURE,
            mCore->MessageDB().GetMessageReferences(key, got));
  EXPECT_EQ((nsTArray<nsCString>{"unchanged"_ns}), got);
}

TEST_F(DeliveryCoreReferences, UpgradeKeepsOldReferencesUnavailable) {
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL(kOldSchema));
  ASSERT_EQ(
      NS_OK,
      old->ExecuteSimpleSQL(
          "INSERT INTO messages(id,messageId) VALUES(7,'historic@invalid')"_ns));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
  nsTArray<nsCString> got{"unchanged"_ns};
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->MessageDB().GetMessageReferences(7, got));
  EXPECT_EQ((nsTArray<nsCString>{"unchanged"_ns}), got);
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageReferences(7, {}));
  got.Clear();
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(7, got));
  EXPECT_TRUE(got.IsEmpty());
  int32_t version;
  ASSERT_EQ(NS_OK, mConnection->GetSchemaVersion(&version));
  EXPECT_EQ(19, version);
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(7, got));
  EXPECT_TRUE(got.IsEmpty());
}

TEST_F(DeliveryCoreReferences, UnsupportedSchemaCanRetryAfterRepair) {
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL(kOldSchema));
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL(
                       "ALTER TABLE messages ADD COLUMN alien TEXT"_ns));
  ASSERT_EQ(NS_OK, old->Close());
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, Start());
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK,
            old->ExecuteSimpleSQL("ALTER TABLE messages DROP COLUMN alien"_ns));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
}

TEST_F(DeliveryCoreReferences, DeleteRemovesSequenceAndKnownMarker) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("deleted@invalid"_ns, {"old@invalid"_ns}, key));
  bool known;
  ASSERT_EQ(NS_OK, StoredKnownMarker(key, known));
  ASSERT_TRUE(known);
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(key));
  ASSERT_EQ(NS_OK, StoredKnownMarker(key, known));
  EXPECT_FALSE(known);
  nsTArray<nsCString> got, stored;
  EXPECT_EQ(NS_ERROR_UNEXPECTED,
            mCore->MessageDB().GetMessageReferences(key, got));
  ASSERT_EQ(NS_OK, Stored(key, stored));
  EXPECT_TRUE(stored.IsEmpty());
  nsMsgKey replacement;
  ASSERT_EQ(NS_OK, Add("replacement@invalid"_ns, {}, replacement));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(replacement, got));
  EXPECT_TRUE(got.IsEmpty());
}

TEST_F(DeliveryCoreReferences, SetterDoesNotAdoptForeignTransaction) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("child@invalid"_ns, {"original@invalid"_ns}, key));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto cleanup = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            mCore->MessageDB().SetMessageReferences(key, {"other@invalid"_ns}));
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  nsTArray<nsCString> stored;
  ASSERT_EQ(NS_OK, Stored(key, stored));
  EXPECT_EQ((nsTArray<nsCString>{"original@invalid"_ns}), stored);
}

TEST_F(DeliveryCoreReferences, FailedUpgradeRollsBackAndCanRetry) {
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL(kOldSchema));
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL(
                       "CREATE TABLE message_references(unrelated TEXT)"_ns));
  ASSERT_EQ(NS_OK, old->Close());
  EXPECT_EQ(NS_ERROR_FAILURE, Start());
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  bool exists;
  ASSERT_EQ(NS_OK, old->TableExists("message_reference_sets"_ns, &exists));
  EXPECT_FALSE(exists);
  int32_t version;
  ASSERT_EQ(NS_OK, old->GetSchemaVersion(&version));
  EXPECT_EQ(0, version);
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL("DROP TABLE message_references"_ns));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
}

TEST_F(DeliveryCoreReferences, FutureSchemaIsNotSilentlyAccepted) {
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL(kOldSchema));
  ASSERT_EQ(NS_OK, old->SetSchemaVersion(99));
  ASSERT_EQ(NS_OK, old->Close());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, Start());
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  int32_t version;
  ASSERT_EQ(NS_OK, old->GetSchemaVersion(&version));
  EXPECT_EQ(99, version);
  ASSERT_EQ(NS_OK, old->SetSchemaVersion(0));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
}

TEST_F(DeliveryCoreReferences, ChangedDeleteTriggerIsUnsupported) {
  ASSERT_EQ(NS_OK, Start());
  Stop();
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(
      NS_OK,
      old->CreateStatement(
          "SELECT sql FROM sqlite_master WHERE name = 'delete_message_references'"_ns,
          getter_AddRefs(stmt)));
  bool more;
  ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
  ASSERT_TRUE(more);
  nsCString original;
  ASSERT_EQ(NS_OK, stmt->GetUTF8String(0, original));
  ASSERT_EQ(NS_OK, stmt->Finalize());
  ASSERT_EQ(NS_OK,
            old->ExecuteSimpleSQL("DROP TRIGGER delete_message_references"_ns));
  ASSERT_EQ(
      NS_OK,
      old->ExecuteSimpleSQL(
          "CREATE TRIGGER delete_message_references AFTER DELETE ON messages "
          "BEGIN SELECT 1; END"_ns));
  ASSERT_EQ(NS_OK, old->Close());
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, Start());
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK,
            old->ExecuteSimpleSQL("DROP TRIGGER delete_message_references"_ns));
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL(original));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
}

class PublicationObserver final : public MessageListener {
 public:
  NS_DECL_ISUPPORTS
  explicit PublicationObserver(std::function<void(Message*, bool)> published)
      : mPublished(std::move(published)) {}
  void OnMessagePublished(Message* message, bool notifyLegacy) override {
    mPublished(message, notifyLegacy);
  }
  void OnMessageAdded(Message*) override { ADD_FAILURE() << "Unbridged add"; }
  void OnMessageRemoved(Message*, uint32_t) override {}
  void OnMessageFlagsChanged(nsIMsgDBHdr*, Message*, uint32_t,
                             uint32_t) override {
    ++mChanges;
  }
  void OnMessageTagsChanged(nsIMsgDBHdr*, Message*, const nsACString&,
                            const nsACString&) override {
    ++mChanges;
  }
  uint32_t mChanges = 0;

 private:
  ~PublicationObserver() = default;
  std::function<void(Message*, bool)> mPublished;
};
NS_IMPL_ISUPPORTS(PublicationObserver, nsISupports)

class BodyObserver final : public MessageListener {
 public:
  NS_DECL_ISUPPORTS
  explicit BodyObserver(
      std::function<void(nsIMsgDBHdr*, Message*, const MessageBodyState&,
                         const MessageBodyState&)>
          changed)
      : mChanged(std::move(changed)) {}
  void OnMessageBodyChanged(nsIMsgDBHdr* old, Message* message,
                            const MessageBodyState& before,
                            const MessageBodyState& after) override {
    mChanged(old, message, before, after);
  }
  void OnMessageAdded(Message*) override { ADD_FAILURE() << "Unexpected add"; }
  void OnMessageRemoved(Message*, uint32_t) override {}
  void OnMessageFlagsChanged(nsIMsgDBHdr*, Message*, uint32_t,
                             uint32_t) override {
    ADD_FAILURE() << "Body update split into a flag callback";
  }
  void OnMessageTagsChanged(nsIMsgDBHdr*, Message*, const nsACString&,
                            const nsACString&) override {}

 private:
  ~BodyObserver() = default;
  std::function<void(nsIMsgDBHdr*, Message*, const MessageBodyState&,
                     const MessageBodyState&)>
      mChanged;
};
NS_IMPL_ISUPPORTS(BodyObserver, nsISupports)

nsresult PublicationCell(mozIStorageConnection* reader, nsMsgKey key,
                         const nsACString& sql, nsACString& value,
                         const nsACString* name = nullptr) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(reader->CreateStatement(sql, getter_AddRefs(stmt)));
  auto cleanup = MakeScopeExit([&] { EXPECT_EQ(NS_OK, stmt->Finalize()); });
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
  if (name) {
    MOZ_TRY(stmt->BindUTF8StringByName("name"_ns, *name));
  }
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
  return stmt->GetUTF8String(0, value);
}

TEST_F(DeliveryCoreReferences, NativePublicationIsCompleteAtFirstCallback) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey parent;
  ASSERT_EQ(NS_OK, Add("parent@invalid"_ns, {}, parent));
  RawHdr raw;
  raw.key = parent;
  raw.messageId = "complete@invalid"_ns;
  raw.references = {"parent@invalid"_ns, "missing@invalid"_ns,
                    "missing@invalid"_ns, "parent@invalid"_ns};
  raw.date = 123456789;
  raw.dateReceived = 483000000;
  raw.sender = "author@invalid"_ns;
  raw.recipients = "to@invalid"_ns;
  raw.ccList = "cc@invalid"_ns;
  raw.bccList = "bcc@invalid"_ns;
  raw.subject = "complete subject"_ns;
  raw.flags = 5;
  raw.priority = 5;
  raw.replyTo = "reply@invalid"_ns;
  raw.charset = "UTF-8"_ns;
  raw.accountKey = "account7"_ns;
  raw.keywords = "old-tag"_ns;
  raw.extras = {{"keywords"_ns, "final-tag"_ns}, {"custom"_ns, "00042"_ns}};
  raw.messageSize = Some(uint32_t(42));
  raw.storeToken = Some(nsCString("0"_ns));
  raw.offlineMessageSize = Some(uint32_t(17));
  raw.lineCount = Some(uint32_t(3));
  nsMsgKey key = nsMsgKey_None;
  Message* live = nullptr;
  uint32_t notifications = 0;
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([&](Message* message, bool notifyLegacy) {
        ++notifications;
        EXPECT_TRUE(notifyLegacy);
        EXPECT_EQ(message, live);
        nsMsgKey observed, thread, parentThread, threadParent;
        ASSERT_EQ(NS_OK, message->GetMessageKey(&observed));
        EXPECT_EQ(key, observed);
        EXPECT_NE(parent, observed);
        EXPECT_EQ(mFolderId, message->FolderId());
        ASSERT_EQ(NS_OK, message->GetThreadId(&thread));
        ASSERT_EQ(NS_OK,
                  mCore->MessageDB().GetMessageThreadId(parent, parentThread));
        EXPECT_NE(0u, thread);
        EXPECT_EQ(parentThread, thread);
        ASSERT_EQ(NS_OK, message->GetThreadParent(&threadParent));
        EXPECT_EQ(parent, threadParent);
        bool inTransaction = true;
        ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&inTransaction));
        EXPECT_FALSE(inTransaction);
        nsCString text;
        ASSERT_EQ(NS_OK, message->GetSubject(text));
        EXPECT_EQ("complete subject"_ns, text);
        ASSERT_EQ(NS_OK, message->GetMessageId(text));
        EXPECT_EQ("complete@invalid"_ns, text);
        ASSERT_EQ(NS_OK, message->GetAuthor(text));
        EXPECT_EQ("author@invalid"_ns, text);
        ASSERT_EQ(NS_OK, message->GetRecipients(text));
        EXPECT_EQ("to@invalid"_ns, text);
        ASSERT_EQ(NS_OK, message->GetCcList(text));
        EXPECT_EQ("cc@invalid"_ns, text);
        ASSERT_EQ(NS_OK, message->GetBccList(text));
        EXPECT_EQ("bcc@invalid"_ns, text);
        PRTime date;
        ASSERT_EQ(NS_OK, message->GetDate(&date));
        EXPECT_EQ(PRTime(123456789), date);
        uint32_t number;
        ASSERT_EQ(NS_OK, message->GetFlags(&number));
        EXPECT_EQ(5u, number);
        nsMsgPriorityValue priority;
        ASSERT_EQ(NS_OK, message->GetPriority(&priority));
        EXPECT_EQ(5, priority);
        ASSERT_EQ(NS_OK, message->GetMessageSize(&number));
        EXPECT_EQ(42u, number);
        ASSERT_EQ(NS_OK, message->GetOfflineMessageSize(&number));
        EXPECT_EQ(17u, number);
        ASSERT_EQ(NS_OK, message->GetLineCount(&number));
        EXPECT_EQ(3u, number);
        ASSERT_EQ(NS_OK, message->GetStoreToken(text));
        EXPECT_EQ("0"_ns, text);
        nsCOMPtr<mozIStorageConnection> reader;
        ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
        auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
        ASSERT_EQ(NS_OK,
                  PublicationCell(reader, key,
                                  "SELECT tags FROM messages WHERE id = :id"_ns,
                                  text));
        EXPECT_EQ("final-tag"_ns, text);
        const RawHdr::kv expected[] = {{"replyTo"_ns, "reply@invalid"_ns},
                                       {"msgCharSet"_ns, "UTF-8"_ns},
                                       {"account"_ns, "account7"_ns},
                                       {"custom"_ns, "00042"_ns},
                                       {"dateReceived"_ns, "1e3"_ns}};
        for (const auto& property : expected) {
          SCOPED_TRACE(property.k.get());
          ASSERT_EQ(NS_OK, message->GetStringProperty(property.k.get(), text));
          EXPECT_EQ(property.v, text);
          ASSERT_EQ(
              NS_OK,
              PublicationCell(
                  reader, key,
                  "SELECT value FROM message_properties WHERE id = :id AND name = :name"_ns,
                  text, &property.k));
          EXPECT_EQ(property.v, text);
        }
        ASSERT_EQ(NS_OK, message->GetStringProperty("keywords", text));
        EXPECT_EQ("final-tag"_ns, text);
        ASSERT_EQ(
            NS_OK,
            PublicationCell(
                reader, key,
                "SELECT count(*) FROM message_properties WHERE id = :id AND name = 'keywords'"_ns,
                text));
        EXPECT_EQ("0"_ns, text);
        nsTArray<nsCString> refs;
        ASSERT_EQ(NS_OK, Stored(key, refs));
        EXPECT_EQ(
            (nsTArray<nsCString>{"parent@invalid"_ns, "missing@invalid"_ns,
                                 "missing@invalid"_ns, "parent@invalid"_ns}),
            refs);
      });
  mCore->MessageDB().AddMessageListener(observer);
  auto cleanup = MakeScopeExit(
      [&] { mCore->MessageDB().RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().AddMessage(mFolderId, raw, true, &key, &live));
  RefPtr<Message> owned = dont_AddRef(live);
  EXPECT_EQ(1u, notifications);
  EXPECT_EQ(0u, observer->mChanges);
}

TEST_F(DeliveryCoreReferences,
       NativeQuietPublicationStillReachesInternalObservers) {
  ASSERT_EQ(NS_OK, Start());
  uint32_t publications = 0, oldCallbacks = 0;
  RefPtr<PublicationObserver> published =
      new PublicationObserver([&](Message*, bool notifyLegacy) {
        ++publications;
        EXPECT_FALSE(notifyLegacy);
      });
  RefPtr<AddedObserver> internal =
      new AddedObserver([&](Message*) { ++oldCallbacks; });
  mCore->MessageDB().AddMessageListener(published);
  mCore->MessageDB().AddMessageListener(internal);
  auto cleanup = MakeScopeExit([&] {
    mCore->MessageDB().RemoveMessageListener(published);
    mCore->MessageDB().RemoveMessageListener(internal);
  });
  RawHdr raw;
  raw.messageId = "quiet@invalid"_ns;
  nsMsgKey key;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolderId, raw, false, &key));
  EXPECT_EQ(1u, publications);
  EXPECT_EQ(1u, oldCallbacks);
  EXPECT_EQ(0u, published->mChanges);
  uint64_t count;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(1u, count);
}

TEST_F(DeliveryCoreReferences, NativeExtrasKeepExactNamesTextAndOrder) {
  ASSERT_EQ(NS_OK, Start());
  RawHdr raw;
  raw.replyTo = "default reply"_ns;
  raw.charset = "default charset"_ns;
  raw.accountKey = "default account"_ns;
  raw.keywords = "default tags"_ns;
  raw.dateReceived = 1000000;
  raw.extras = {{"replyTo"_ns, ""_ns},
                {"msgCharSet"_ns, "override charset"_ns},
                {"account"_ns, ""_ns},
                {"charset"_ns, "arbitrary charset"_ns},
                {"accountKey"_ns, "arbitrary accountKey"_ns},
                {"custom"_ns, "first"_ns},
                {"custom"_ns, "00042"_ns},
                {"Custom"_ns, "1e3"_ns},
                {"\xc3\xa9"_ns, "composed"_ns},
                {"e\xcc\x81"_ns, "decomposed"_ns},
                {""_ns, "empty name"_ns},
                {"dateReceived"_ns, "00042"_ns},
                {"keywords"_ns, "first tag"_ns},
                {"keywords"_ns, ""_ns},
                {"keywords"_ns, "e\xcc\x81"_ns}};
  nsMsgKey key;
  Message* live = nullptr;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().AddMessage(mFolderId, raw, true, &key, &live));
  RefPtr<Message> owned = dont_AddRef(live);
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
  const RawHdr::kv expected[] = {{"replyTo"_ns, ""_ns},
                                 {"msgCharSet"_ns, "override charset"_ns},
                                 {"account"_ns, ""_ns},
                                 {"charset"_ns, "arbitrary charset"_ns},
                                 {"accountKey"_ns, "arbitrary accountKey"_ns},
                                 {"custom"_ns, "00042"_ns},
                                 {"Custom"_ns, "1e3"_ns},
                                 {"\xc3\xa9"_ns, "composed"_ns},
                                 {"e\xcc\x81"_ns, "decomposed"_ns},
                                 {""_ns, "empty name"_ns},
                                 {"dateReceived"_ns, "00042"_ns}};
  for (const auto& property : expected) {
    SCOPED_TRACE(property.k.get());
    nsCString text;
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessageProperty(key, property.k, text));
    EXPECT_EQ(property.v, text);
    ASSERT_EQ(
        NS_OK,
        PublicationCell(
            reader, key,
            "SELECT value FROM message_properties WHERE id = :id AND name = :name"_ns,
            text, &property.k));
    EXPECT_EQ(property.v, text);
  }
  nsCString tags;
  ASSERT_EQ(NS_OK, live->GetStringProperty("keywords", tags));
  EXPECT_EQ("e\xcc\x81"_ns, tags);
  ASSERT_EQ(NS_OK, PublicationCell(
                       reader, key,
                       "SELECT tags FROM messages WHERE id = :id"_ns, tags));
  EXPECT_EQ("e\xcc\x81"_ns, tags);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessagePropertyNames(key, names));
  EXPECT_EQ(11u, names.Length());
  for (const auto& property : expected) {
    EXPECT_TRUE(names.Contains(property.k));
  }
  EXPECT_FALSE(names.Contains("keywords"_ns));
}

TEST_F(DeliveryCoreReferences, NativeEmptyKeywordsOverrideNamedDefault) {
  ASSERT_EQ(NS_OK, Start());
  RawHdr raw;
  raw.keywords = "named default"_ns;
  raw.extras = {{"keywords"_ns, "first"_ns}, {"keywords"_ns, ""_ns}};
  nsMsgKey key;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolderId, raw, true, &key));
  nsCString tags;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageTags(key, tags));
  EXPECT_TRUE(tags.IsEmpty());
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
  ASSERT_EQ(NS_OK, PublicationCell(
                       reader, key,
                       "SELECT tags FROM messages WHERE id = :id"_ns, tags));
  EXPECT_TRUE(tags.IsEmpty());
}

TEST_F(DeliveryCoreReferences, NativeAbsentStorageRetainsExactExtras) {
  ASSERT_EQ(NS_OK, Start());
  RawHdr raw;
  raw.extras = {{"messageSize"_ns, "00041"_ns},
                {"storeToken"_ns, "extra"_ns},
                {"offlineMessageSize"_ns, "17"_ns},
                {"lineCount"_ns, "3"_ns}};
  nsMsgKey key;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolderId, raw, true, &key));
  uint64_t size;
  uint32_t lines;
  nsCString text;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageSize(key, size));
  EXPECT_EQ(41u, size);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessageProperty(key, "messageSize"_ns, text));
  EXPECT_EQ("00041"_ns, text);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageStoreToken(key, text));
  EXPECT_EQ("extra"_ns, text);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageOfflineMessageSize(key, size));
  EXPECT_EQ(17u, size);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageLineCount(key, lines));
  EXPECT_EQ(3u, lines);
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
  ASSERT_EQ(
      NS_OK,
      PublicationCell(
          reader, key,
          "SELECT value FROM message_properties WHERE id = :id AND name = 'messageSize'"_ns,
          text));
  EXPECT_EQ("00041"_ns, text);
}

TEST_F(DeliveryCoreReferences, NativePresentStorageOverridesExactExtras) {
  ASSERT_EQ(NS_OK, Start());
  RawHdr raw;
  raw.extras = {{"messageSize"_ns, "41"_ns},
                {"storeToken"_ns, "extra"_ns},
                {"offlineMessageSize"_ns, "17"_ns},
                {"lineCount"_ns, "3"_ns}};
  raw.messageSize = Some(uint32_t(0));
  raw.storeToken = Some(nsCString());
  raw.offlineMessageSize = Some(uint32_t(0xffffffff));
  raw.lineCount = Some(uint32_t(0));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolderId, raw, true, &key));
  uint64_t size;
  uint32_t lines;
  nsCString text;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageSize(key, size));
  EXPECT_EQ(0u, size);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageStoreToken(key, text));
  EXPECT_TRUE(text.IsEmpty());
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageOfflineMessageSize(key, size));
  EXPECT_EQ(uint64_t(0xffffffff), size);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageLineCount(key, lines));
  EXPECT_EQ(0u, lines);
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
  ASSERT_EQ(
      NS_OK,
      PublicationCell(
          reader, key,
          "SELECT count(*) FROM message_properties WHERE id = :id AND name IN "
          "('messageSize','storeToken','offlineMessageSize','lineCount')"_ns,
          text));
  EXPECT_EQ("4"_ns, text);
}

TEST_F(DeliveryCoreReferences, NativeReceivedDateUsesLegacySecondsText) {
  ASSERT_EQ(NS_OK, Start());
  const struct {
    PRTime received;
    const char* text;
    uint32_t number;
    bool present;
  } cases[] = {{0, "", 0, false},
               {999999, "0", 0, true},
               {483000000, "1e3", 483, true},
               {-1000000, "ffffffff", 0xffffffff, true},
               {-999999, "0", 0, true},
               {4294967297000000LL, "1", 1, true}};
  for (const auto& test : cases) {
    SCOPED_TRACE(test.received);
    RawHdr raw;
    raw.dateReceived = test.received;
    nsMsgKey key;
    Message* live = nullptr;
    nsresult rv =
        mCore->MessageDB().AddMessage(mFolderId, raw, true, &key, &live);
    EXPECT_EQ(NS_OK, rv);
    if (NS_FAILED(rv)) {
      continue;
    }
    RefPtr<Message> owned = dont_AddRef(live);
    nsCString text;
    EXPECT_EQ(NS_OK, live->GetStringProperty("dateReceived", text));
    EXPECT_STREQ(test.text, text.get());
    uint32_t number = 99;
    EXPECT_EQ(NS_OK, live->GetUint32Property("dateReceived", &number));
    EXPECT_EQ(test.number, number);
    nsTArray<nsCString> names;
    EXPECT_EQ(NS_OK, mCore->MessageDB().GetMessagePropertyNames(key, names));
    EXPECT_EQ(test.present, names.Contains("dateReceived"_ns));
  }
}

TEST_F(DeliveryCoreReferences,
       NativePropertyFailureLeavesOutputsAndControlIntact) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("control@invalid"_ns, {"kept@invalid"_ns}, control));
  RefPtr<Message> sentinel = new Message(control);
  Message* live = sentinel.get();
  nsMsgKey key = 0x76543210;
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("publication_fault"_ns, 1, witness));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER fail_publication BEFORE INSERT ON "
          "message_properties "
          "WHEN NEW.name = 'late' BEGIN SELECT publication_fault(NEW.id); "
          "SELECT RAISE(ABORT, 'publication property fault'); END"_ns));
  uint32_t notifications = 0;
  RefPtr<AddedObserver> observer =
      new AddedObserver([&](Message*) { ++notifications; });
  mCore->MessageDB().AddMessageListener(observer);
  auto cleanup = MakeScopeExit(
      [&] { mCore->MessageDB().RemoveMessageListener(observer); });
  RawHdr raw;
  raw.messageId = "failed@invalid"_ns;
  raw.references = {"missing@invalid"_ns, "missing@invalid"_ns};
  raw.extras = {{"early"_ns, "00042"_ns}, {"late"_ns, "1e3"_ns}};
  raw.storeToken = Some(nsCString("finished-bytes"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            mCore->MessageDB().AddMessage(mFolderId, raw, true, &key, &live));
  EXPECT_EQ(1u, witness->mCalls);
  ASSERT_GT(witness->mLastKey, 0);
  ASSERT_LT(uint64_t(witness->mLastKey), uint64_t(nsMsgKey_None));
  EXPECT_EQ(nsMsgKey(0x76543210), key);
  EXPECT_EQ(sentinel.get(), live);
  EXPECT_EQ(0u, notifications);
  bool inTransaction = true;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&inTransaction));
  EXPECT_FALSE(inTransaction);
  nsMsgKey failed = static_cast<nsMsgKey>(witness->mLastKey);
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
  for (const auto& sql :
       {"SELECT count(*) FROM messages WHERE id = :id"_ns,
        "SELECT count(*) FROM message_properties WHERE id = :id"_ns,
        "SELECT count(*) FROM message_references WHERE id = :id"_ns,
        "SELECT count(*) FROM message_reference_sets WHERE id = :id"_ns}) {
    nsCString text;
    ASSERT_EQ(NS_OK, PublicationCell(reader, failed, sql, text));
    EXPECT_EQ("0"_ns, text);
  }
  nsCString subject;
  EXPECT_EQ(NS_ERROR_UNEXPECTED,
            mCore->MessageDB().GetMessageSubject(failed, subject));
  nsTArray<nsCString> stored;
  ASSERT_EQ(NS_OK, Stored(control, stored));
  EXPECT_EQ((nsTArray<nsCString>{"kept@invalid"_ns}), stored);
  nsCString text;
  ASSERT_EQ(NS_OK, PublicationCell(
                       reader, control,
                       "SELECT subject FROM messages WHERE id = :id"_ns, text));
  EXPECT_EQ("subject"_ns, text);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER fail_publication"_ns));
  live = nullptr;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().AddMessage(mFolderId, raw, true, &key, &live));
  RefPtr<Message> owned = dont_AddRef(live);
  EXPECT_EQ(1u, notifications);
  ASSERT_EQ(NS_OK, live->GetStoreToken(text));
  EXPECT_EQ("finished-bytes"_ns, text);
  ASSERT_EQ(NS_OK, PublicationCell(
                       reader, control,
                       "SELECT subject FROM messages WHERE id = :id"_ns, text));
  EXPECT_EQ("subject"_ns, text);
}

TEST_F(DeliveryCoreReferences,
       NativePublicationRejectsForeignTransactionAndNullKey) {
  ASSERT_EQ(NS_OK, Start());
  RawHdr raw;
  raw.subject = "must not be inserted"_ns;
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("foreign-control@invalid"_ns, {}, control));
  RefPtr<Message> sentinel = new Message(99);
  Message* live = sentinel.get();
  EXPECT_EQ(NS_ERROR_INVALID_ARG, mCore->MessageDB().AddMessage(
                                      mFolderId, raw, true, nullptr, &live));
  EXPECT_EQ(sentinel.get(), live);
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(control, "foreign"_ns,
                                                         "kept"_ns));
  nsMsgKey key = 0x12345678;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            mCore->MessageDB().AddMessage(mFolderId, raw, true, &key, &live));
  EXPECT_EQ(nsMsgKey(0x12345678), key);
  EXPECT_EQ(sentinel.get(), live);
  bool inTransaction = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&inTransaction));
  EXPECT_TRUE(inTransaction);
  nsCString value;
  ASSERT_EQ(
      NS_OK,
      PublicationCell(
          mConnection, control,
          "SELECT value FROM message_properties WHERE id = :id AND name = 'foreign'"_ns,
          value));
  EXPECT_EQ("kept"_ns, value);
}

TEST_F(DeliveryCoreReferences, NativeBorrowedInputSupportsReentrantReuse) {
  ASSERT_EQ(NS_OK, Start());
  RawHdr raw;
  raw.messageId = "reused@invalid"_ns;
  raw.references = {"unresolved@invalid"_ns, "unresolved@invalid"_ns};
  raw.extras = {{"custom"_ns, "00042"_ns}};
  nsMsgKey outer = nsMsgKey_None, inner = nsMsgKey_None;
  uint32_t notifications = 0;
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([&](Message* message, bool notifyLegacy) {
        ++notifications;
        nsMsgKey key;
        ASSERT_EQ(NS_OK, message->GetMessageKey(&key));
        if (notifications == 1) {
          EXPECT_TRUE(notifyLegacy);
          EXPECT_EQ(outer, key);
          ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolderId, raw, false,
                                                         &inner));
        } else {
          EXPECT_FALSE(notifyLegacy);
          EXPECT_EQ(inner, key);
        }
      });
  mCore->MessageDB().AddMessageListener(observer);
  auto cleanup = MakeScopeExit(
      [&] { mCore->MessageDB().RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolderId, raw, true, &outer));
  EXPECT_EQ(2u, notifications);
  EXPECT_NE(outer, inner);
  EXPECT_EQ(
      (nsTArray<nsCString>{"unresolved@invalid"_ns, "unresolved@invalid"_ns}),
      raw.references);
  ASSERT_EQ(1u, raw.extras.Length());
  EXPECT_EQ("custom"_ns, raw.extras[0].k);
  EXPECT_EQ("00042"_ns, raw.extras[0].v);
  for (nsMsgKey key : {outer, inner}) {
    nsTArray<nsCString> stored;
    ASSERT_EQ(NS_OK, Stored(key, stored));
    EXPECT_EQ(
        (nsTArray<nsCString>{"unresolved@invalid"_ns, "unresolved@invalid"_ns}),
        stored);
  }
}

CapturedMessage CaptureSentinel() {
  CapturedMessage value;
  value.id = 0xfffffff0;
  value.folderId = 0x123456789ULL;
  value.messageId = "sentinel-id"_ns;
  value.date = -2001;
  value.sender = "sentinel-sender"_ns;
  value.recipients = "sentinel-recipients"_ns;
  value.subject = "sentinel-subject"_ns;
  value.flags = 0xfedcba98;
  value.tags = "sentinel-tags"_ns;
  value.threadId = 0xf0000001;
  value.threadParent = 0xe0000001;
  return value;
}

void ExpectCapture(const CapturedMessage& expected,
                   const CapturedMessage& actual) {
  EXPECT_EQ(expected.id, actual.id);
  EXPECT_EQ(expected.folderId, actual.folderId);
  EXPECT_EQ(expected.messageId, actual.messageId);
  EXPECT_EQ(expected.date, actual.date);
  EXPECT_EQ(expected.sender, actual.sender);
  EXPECT_EQ(expected.recipients, actual.recipients);
  EXPECT_EQ(expected.subject, actual.subject);
  EXPECT_EQ(expected.flags, actual.flags);
  EXPECT_EQ(expected.tags, actual.tags);
  EXPECT_EQ(expected.threadId, actual.threadId);
  EXPECT_EQ(expected.threadParent, actual.threadParent);
}

class CaptureReadAbort final : public mozIStorageProgressHandler {
 public:
  NS_DECL_ISUPPORTS
  uint32_t mCalls = 0;
  uint32_t mAborts = 0;
  NS_IMETHOD OnProgress(mozIStorageConnection*, bool* interrupt) override {
    ++mCalls;
    *interrupt = mAborts == 0;
    if (*interrupt) {
      ++mAborts;
    }
    return NS_OK;
  }

 private:
  ~CaptureReadAbort() = default;
};
NS_IMPL_ISUPPORTS(CaptureReadAbort, mozIStorageProgressHandler)

class CapturedBatchObserver final : public MessageListener {
 public:
  NS_DECL_ISUPPORTS
  std::function<void(const CapturedMessage&, const CapturedMessage&, Message*)>
      mChanged;
  std::function<void(const CapturedMessage&, Message*)> mCaptured;
  uint32_t mAdded = 0;
  bool mNotifyLegacy = true;
  void OnMessageThreadChanged(const CapturedMessage& before,
                              const CapturedMessage& after,
                              Message* live) override {
    mChanged(before, after, live);
  }
  void OnMessagePublishedCaptured(const CapturedMessage& after, Message* live,
                                  bool notifyLegacy) override {
    mCaptured(after, live);
    MessageListener::OnMessagePublishedCaptured(after, live, notifyLegacy);
  }
  void OnMessagePublished(Message* live, bool notifyLegacy) override {
    mNotifyLegacy = notifyLegacy;
    MessageListener::OnMessagePublished(live, notifyLegacy);
  }
  void OnMessageAdded(Message*) override { ++mAdded; }
  void OnMessageRemoved(Message*, uint32_t) override {}
  void OnMessageFlagsChanged(nsIMsgDBHdr*, Message*, uint32_t,
                             uint32_t) override {}
  void OnMessageTagsChanged(nsIMsgDBHdr*, Message*, const nsACString&,
                            const nsACString&) override {}

 private:
  ~CapturedBatchObserver() = default;
};
NS_IMPL_ISUPPORTS(CapturedBatchObserver, nsISupports)

TEST_F(DeliveryCoreReferences, CaptureOwnsHistoricalRowFacts) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey parent;
  ASSERT_EQ(NS_OK, Add("capture-parent@invalid"_ns, {}, parent));
  nsMsgKey parentThread;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageThreadId(parent, parentThread));
  RawHdr raw;
  raw.messageId = "captured@invalid"_ns;
  raw.references = {"capture-parent@invalid"_ns};
  raw.date = 1700000000123456LL;
  raw.sender = "sender-original"_ns;
  raw.recipients = "recipients-original"_ns;
  raw.subject = "subject-original"_ns;
  raw.flags = 0x80000004;
  raw.keywords = "tag-one tag-two"_ns;
  nsMsgKey key;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolderId, raw, true, &key));
  CapturedMessage expected;
  expected.id = key;
  expected.folderId = mFolderId;
  expected.messageId = "captured@invalid"_ns;
  expected.date = 1700000000123456LL;
  expected.sender = "sender-original"_ns;
  expected.recipients = "recipients-original"_ns;
  expected.subject = "subject-original"_ns;
  expected.flags = 0x80000004;
  expected.tags = "tag-one tag-two"_ns;
  expected.threadId = parentThread;
  expected.threadParent = parent;
  CapturedMessage captured;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(key, captured));
  ExpectCapture(expected, captured);
  RefPtr<Message> live = new Message(key);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().SetMessageSubject(key, "later subject"_ns));
  nsCString text;
  ASSERT_EQ(NS_OK, live->GetSubject(text));
  EXPECT_EQ("later subject"_ns, text);
  ExpectCapture(expected, captured);
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(key));
  bool exists = true;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_FALSE(exists);
  EXPECT_EQ(NS_ERROR_UNEXPECTED,
            mCore->MessageDB().CaptureMessage(key, captured));
  ExpectCapture(expected, captured);
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
  ASSERT_EQ(
      NS_OK,
      PublicationCell(reader, key,
                      "SELECT count(*) FROM messages WHERE id = :id"_ns, text));
  EXPECT_EQ("0"_ns, text);
  ASSERT_EQ(NS_OK,
            PublicationCell(reader, parent,
                            "SELECT messageId FROM messages WHERE id = :id"_ns,
                            text));
  EXPECT_EQ("capture-parent@invalid"_ns, text);
}

TEST_F(DeliveryCoreReferences, CaptureMissingRowPreservesOutput) {
  ASSERT_EQ(NS_OK, Start());
  CapturedMessage output = CaptureSentinel();
  EXPECT_EQ(NS_ERROR_UNEXPECTED, mCore->MessageDB().CaptureMessage(0, output));
  ExpectCapture(CaptureSentinel(), output);
}

TEST_F(DeliveryCoreReferences, CaptureReadErrorPreservesOutput) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("capture-control@invalid"_ns, {}, control));
  CapturedMessage warm;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(control, warm));
  RefPtr<CaptureReadAbort> fault = new CaptureReadAbort();
  nsCOMPtr<mozIStorageProgressHandler> previous;
  ASSERT_EQ(NS_OK, mConnection->SetProgressHandler(1, fault,
                                                   getter_AddRefs(previous)));
  auto cleanup = MakeScopeExit([&] {
    nsCOMPtr<mozIStorageProgressHandler> removed;
    EXPECT_EQ(NS_OK,
              mConnection->RemoveProgressHandler(getter_AddRefs(removed)));
  });
  EXPECT_FALSE(previous);
  CapturedMessage output = CaptureSentinel();
  EXPECT_EQ(NS_ERROR_ABORT, mCore->MessageDB().CaptureMessage(control, output));
  EXPECT_GT(fault->mCalls, 0u);
  EXPECT_EQ(1u, fault->mAborts);
  ExpectCapture(CaptureSentinel(), output);
  nsCOMPtr<mozIStorageProgressHandler> removed;
  ASSERT_EQ(NS_OK, mConnection->RemoveProgressHandler(getter_AddRefs(removed)));
  cleanup.release();
  EXPECT_EQ(fault.get(), removed.get());
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(control, output));
  EXPECT_EQ(control, output.id);
  EXPECT_EQ(mFolderId, output.folderId);
  EXPECT_EQ("capture-control@invalid"_ns, output.messageId);
  EXPECT_EQ("subject"_ns, output.subject);
  bool inTransaction = true;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&inTransaction));
  EXPECT_FALSE(inTransaction);
}

TEST_F(DeliveryCoreReferences, PreparedBatchOwnsPendingPublication) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey first, second, publication, control;
  ASSERT_EQ(NS_OK, Add("batch-first@invalid"_ns, {}, first));
  ASSERT_EQ(NS_OK, Add("batch-second@invalid"_ns, {}, second));
  ASSERT_EQ(NS_OK, Add("batch-publication@invalid"_ns, {}, publication));
  ASSERT_EQ(NS_OK, Add("batch-control@invalid"_ns, {}, control));
  CapturedMessage oldFirst, oldSecond, added, unchanged;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(first, oldFirst));
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(second, oldSecond));
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(publication, added));
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(control, unchanged));
  // Compose a delta without changing stored threads or enabling dispatch.
  MessageThreadBatch batch;
  batch.batchId = 42;
  batch.before = {oldFirst, oldSecond, unchanged};
  batch.after = {oldFirst, oldSecond, unchanged, added};
  for (size_t i = 0; i < 2; ++i) {
    batch.after[i].threadId = added.threadId;
    batch.after[i].threadParent = publication;
  }
  batch.changedKeys = {first, second};
  if (first > second) {
    std::swap(batch.changedKeys[0], batch.changedKeys[1]);
  }
  nsTArray<nsMsgKey> expectedOrder = batch.changedKeys.Clone();
  nsMsgKey later = expectedOrder[1];
  batch.publicationKey = publication;
  batch.notifyLegacy = false;
  RefPtr<CapturedBatchObserver> observer = new CapturedBatchObserver();
  nsTArray<nsMsgKey> delivered;
  observer->mChanged = [&](const CapturedMessage& before,
                           const CapturedMessage& after, Message* live) {
    size_t index = delivered.Length();
    ASSERT_LT(index, 2u);
    EXPECT_EQ(expectedOrder[index], before.id);
    ExpectCapture(before.id == first ? oldFirst : oldSecond, before);
    EXPECT_EQ(before.id, after.id);
    EXPECT_EQ(added.threadId, after.threadId);
    EXPECT_EQ(publication, after.threadParent);
    EXPECT_EQ(before.id, live->Key());
    delivered.AppendElement(before.id);
    if (index == 0) {
      ASSERT_EQ(NS_OK,
                mCore->MessageDB().SetMessageSubject(later, "later edit"_ns));
      ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(later));
      ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(publication));
    } else {
      nsCString text;
      ASSERT_EQ(NS_OK, live->GetSubject(text));
      EXPECT_EQ("later edit"_ns, text);
      bool exists = true;
      ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(later, exists));
      EXPECT_FALSE(exists);
    }
  };
  observer->mCaptured = [&](const CapturedMessage& after, Message* live) {
    ExpectCapture(added, after);
    EXPECT_EQ(publication, live->Key());
    EXPECT_EQ(expectedOrder, delivered);
    bool exists = true;
    ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(publication, exists));
    EXPECT_FALSE(exists);
    delivered.AppendElement(publication);
  };
  PreparedThreadBatch prepared;
  ASSERT_EQ(NS_OK, observer->PrepareThreadBatch(batch, prepared));
  EXPECT_TRUE(delivered.IsEmpty());
  EXPECT_EQ(0u, observer->mAdded);
  ASSERT_EQ(4u, prepared.captured.after.Length());
  ExpectCapture(unchanged, prepared.captured.after[2]);
  batch.before[0].subject = "discarded before input"_ns;
  batch.after[3].subject = "discarded publication input"_ns;
  batch.before.Clear();
  batch.after.Clear();
  batch.changedKeys.Clear();
  observer->DeliverThreadBatch(prepared);
  expectedOrder.AppendElement(publication);
  EXPECT_EQ(expectedOrder, delivered);
  EXPECT_EQ(1u, observer->mAdded);
  EXPECT_FALSE(observer->mNotifyLegacy);
  EXPECT_EQ(42u, prepared.captured.batchId);
  CapturedMessage kept;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(control, kept));
  ExpectCapture(unchanged, kept);
}

TEST_F(DeliveryCoreReferences, BatchPreparationFailurePreservesOutput) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey publication;
  ASSERT_EQ(NS_OK, Add("prepare-publication@invalid"_ns, {}, publication));
  CapturedMessage added;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(publication, added));
  MessageThreadBatch batch;
  batch.after = {added};
  batch.publicationKey = publication;
  batch.notifyLegacy = false;
  uint32_t calls = 0;
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([&](Message* live, bool notifyLegacy) {
        ++calls;
        EXPECT_EQ(publication, live->Key());
        EXPECT_FALSE(notifyLegacy);
      });
  PreparedThreadBatch output;
  ASSERT_EQ(NS_OK, observer->PrepareThreadBatch(batch, output));
  Message* sentinel = output.publicationLive.get();
  EXPECT_EQ(0u, calls);
  batch.after.Clear();
  EXPECT_EQ(NS_ERROR_INVALID_ARG, observer->PrepareThreadBatch(batch, output));
  EXPECT_EQ(sentinel, output.publicationLive.get());
  ASSERT_EQ(1u, output.captured.after.Length());
  ExpectCapture(added, output.captured.after[0]);
  EXPECT_EQ(0u, calls);
  observer->DeliverThreadBatch(output);
  EXPECT_EQ(1u, calls);
}

TEST_F(DeliveryCoreReferences, CaptureReadsStagedSqlWithoutCacheMutation) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("capture-staged@invalid"_ns, {}, key));
  RefPtr<Message> live = new Message(key);
  nsCString text;
  ASSERT_EQ(NS_OK, live->GetSubject(text));
  EXPECT_EQ("subject"_ns, text);
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(
      NS_OK,
      mConnection->CreateStatement(
          "UPDATE messages SET subject = 'staged subject' WHERE id = :id"_ns,
          getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, key));
  ASSERT_EQ(NS_OK, stmt->Execute());
  ASSERT_EQ(NS_OK, stmt->Finalize());
  CapturedMessage captured;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(key, captured));
  EXPECT_EQ("staged subject"_ns, captured.subject);
  ASSERT_EQ(NS_OK, live->GetSubject(text));
  EXPECT_EQ("subject"_ns, text);
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  rollback.release();
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(key, captured));
  EXPECT_EQ("subject"_ns, captured.subject);
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
  ASSERT_EQ(NS_OK, PublicationCell(
                       reader, key,
                       "SELECT subject FROM messages WHERE id = :id"_ns, text));
  EXPECT_EQ("subject"_ns, text);
}

nsresult MakeDiscoveryFolders(DatabaseCore& core, uint64_t& a, uint64_t& b) {
  uint64_t root;
  MOZ_TRY(core.FolderDB().InsertRoot("discovery"_ns, &root));
  MOZ_TRY(core.FolderDB().InsertFolder(root, "A"_ns, &a));
  return core.FolderDB().InsertFolder(root, "B"_ns, &b);
}

nsresult AddDiscoveryMessage(MessageDatabase& db, uint64_t folderId,
                             const nsACString& messageId,
                             const nsTArray<nsCString>& references,
                             nsMsgKey& key,
                             const nsACString& subject = "subject"_ns) {
  RawHdr header;
  header.messageId = messageId;
  header.references = references.Clone();
  header.date = 1700000000000000;
  header.sender = "sender@conversation.invalid"_ns;
  header.recipients = "recipient@conversation.invalid"_ns;
  header.subject = subject;
  return db.AddMessage(folderId, header, true, &key);
}

void ExpectDiscovery(MessageDatabase& db, nsMsgKey seed,
                     const nsTArray<ConversationMember>& expected) {
  nsTArray<ConversationMember> actual;
  ASSERT_EQ(NS_OK, db.DiscoverConversationComponent(seed, actual));
  ASSERT_EQ(expected.Length(), actual.Length());
  for (size_t i = 1; i < actual.Length(); ++i) {
    EXPECT_LT(actual[i - 1].id, actual[i].id);
  }
  for (const auto& member : expected) {
    uint32_t matches = 0;
    for (const auto& found : actual) {
      if (found.id == member.id) {
        ++matches;
        EXPECT_EQ(member.folderId, found.folderId);
      }
    }
    EXPECT_EQ(1u, matches);
  }
}

void ExpectConversationRead(MessageDatabase& db, nsMsgKey seed,
                            const nsTArray<ConversationMember>& expected) {
  nsTArray<nsMsgKey> keys, output{nsMsgKey_None - 1};
  for (const auto& member : expected) keys.AppendElement(member.id);
  keys.Sort();
  ASSERT_EQ(NS_OK, db.GetConversationMessageKeys(seed, output));
  EXPECT_EQ(keys, output);
  for (const auto& member : expected) {
    CapturedMessage physical;
    ASSERT_EQ(NS_OK, db.CaptureMessage(member.id, physical));
    EXPECT_EQ(member.folderId, physical.folderId);
  }
}

TEST_F(DeliveryCoreReferences, DiscoverOrderedCrossFolder) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t a, b;
  ASSERT_EQ(NS_OK, MakeDiscoveryFolders(*mCore, a, b));
  auto& db = mCore->MessageDB();
  const nsCString subject("Ordered conversation");
  nsMsgKey root, reply, tail, unrelated;
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, a, "ordered-root@conversation.invalid"_ns,
                                {}, root, subject));
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, b, "ordered-reply@conversation.invalid"_ns,
                                {"ordered-root@conversation.invalid"_ns}, reply,
                                subject));
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, a, "ordered-tail@conversation.invalid"_ns,
                                {"ordered-root@conversation.invalid"_ns,
                                 "ordered-reply@conversation.invalid"_ns},
                                tail, subject));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, b, "ordered-unrelated@conversation.invalid"_ns, {},
                       unrelated, subject));
  for (nsMsgKey seed : {root, reply, tail}) {
    ExpectDiscovery(db, seed, {{root, a}, {reply, b}, {tail, a}});
  }
  ExpectDiscovery(db, unrelated, {{unrelated, b}});
  nsTArray<nsCString> stored;
  ASSERT_EQ(NS_OK, Stored(tail, stored));
  EXPECT_EQ((nsTArray<nsCString>{"ordered-root@conversation.invalid"_ns,
                                 "ordered-reply@conversation.invalid"_ns}),
            stored);
}

TEST_F(DeliveryCoreReferences, DiscoverReplyBeforeParent) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t a, b;
  ASSERT_EQ(NS_OK, MakeDiscoveryFolders(*mCore, a, b));
  auto& db = mCore->MessageDB();
  const nsCString subject("Reply before parent");
  nsMsgKey unrelated, reply, parent;
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, a, "reply-first-unrelated@conversation.invalid"_ns,
                       {}, unrelated, subject));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, b, "reply-first-child@conversation.invalid"_ns,
                       {"reply-first-parent@conversation.invalid"_ns}, reply,
                       subject));
  ExpectDiscovery(db, reply, {{reply, b}});
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, a, "reply-first-parent@conversation.invalid"_ns, {},
                       parent, subject));
  for (nsMsgKey seed : {reply, parent}) {
    ExpectDiscovery(db, seed, {{reply, b}, {parent, a}});
  }
  ExpectDiscovery(db, unrelated, {{unrelated, a}});
}

TEST_F(DeliveryCoreReferences, DiscoverSiblingsWithoutParent) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t a, b;
  ASSERT_EQ(NS_OK, MakeDiscoveryFolders(*mCore, a, b));
  auto& db = mCore->MessageDB();
  const nsCString subject("Siblings without parent");
  nsMsgKey unrelated, first, second;
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(
                db, a, "siblings-missing-unrelated@conversation.invalid"_ns, {},
                unrelated, subject));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, a, "siblings-missing-first@conversation.invalid"_ns,
                       {"siblings-missing-parent@conversation.invalid"_ns},
                       first, subject));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, b, "siblings-missing-second@conversation.invalid"_ns,
                       {"siblings-missing-parent@conversation.invalid"_ns},
                       second, subject));
  for (nsMsgKey seed : {first, second}) {
    ExpectDiscovery(db, seed, {{first, a}, {second, b}});
  }
  ExpectDiscovery(db, unrelated, {{unrelated, a}});
}

TEST_F(DeliveryCoreReferences, DiscoverSiblingsThenParent) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t a, b;
  ASSERT_EQ(NS_OK, MakeDiscoveryFolders(*mCore, a, b));
  auto& db = mCore->MessageDB();
  const nsCString subject("Siblings then parent");
  nsMsgKey first, second, unrelated, parent;
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, a, "siblings-late-first@conversation.invalid"_ns,
                       {"siblings-late-parent@conversation.invalid"_ns}, first,
                       subject));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, b, "siblings-late-second@conversation.invalid"_ns,
                       {"siblings-late-parent@conversation.invalid"_ns}, second,
                       subject));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, b, "siblings-late-unrelated@conversation.invalid"_ns,
                       {}, unrelated, subject));
  // Exercise the late arrival independently of the missing-parent assertion.
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, a, "siblings-late-parent@conversation.invalid"_ns,
                       {}, parent, subject));
  for (nsMsgKey seed : {first, second, parent}) {
    ExpectDiscovery(db, seed, {{first, a}, {second, b}, {parent, a}});
  }
  ExpectDiscovery(db, unrelated, {{unrelated, b}});
}

TEST_F(DeliveryCoreReferences, DiscoverDuplicatePhysicalCopies) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t a, b;
  ASSERT_EQ(NS_OK, MakeDiscoveryFolders(*mCore, a, b));
  auto& db = mCore->MessageDB();
  nsMsgKey first, second, child, unrelated;
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, a, "duplicate@invalid"_ns, {}, first));
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, b, "duplicate@invalid"_ns, {}, second));
  ASSERT_NE(first, second);
  ExpectDiscovery(db, first, {{first, a}});
  ExpectDiscovery(db, second, {{second, b}});
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, b, "unrelated@invalid"_ns, {}, unrelated));
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, a, "child@invalid"_ns,
                                {"duplicate@invalid"_ns, ""_ns,
                                 "absent@invalid"_ns, "duplicate@invalid"_ns},
                                child));
  ExpectDiscovery(db, child, {{first, a}, {second, b}, {child, a}});
  ExpectDiscovery(db, unrelated, {{unrelated, b}});
  nsTArray<nsCString> stored;
  ASSERT_EQ(NS_OK, Stored(child, stored));
  EXPECT_EQ((nsTArray<nsCString>{"duplicate@invalid"_ns, ""_ns,
                                 "absent@invalid"_ns, "duplicate@invalid"_ns}),
            stored);
}

TEST_F(DeliveryCoreReferences, DiscoverWholeStoredComponent) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey root, child, incoming;
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, mFolderId, "root@invalid"_ns, {}, root));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(db, mFolderId, "child@invalid"_ns,
                                       {"root@invalid"_ns}, child));
  CapturedMessage rootRow, childRow;
  ASSERT_EQ(NS_OK, db.CaptureMessage(root, rootRow));
  ASSERT_EQ(NS_OK, db.CaptureMessage(child, childRow));
  ASSERT_NE(0u, rootRow.threadId);
  ASSERT_EQ(rootRow.threadId, childRow.threadId);
  ASSERT_EQ(NS_OK, db.SetMessageReferences(child, {}));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(db, mFolderId, "incoming@invalid"_ns,
                                       {"child@invalid"_ns}, incoming));
  ExpectDiscovery(
      db, incoming,
      {{root, mFolderId}, {child, mFolderId}, {incoming, mFolderId}});
}

TEST_F(DeliveryCoreReferences, DiscoverExactReferenceTokens) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey first, same, lower, spaced, composed, decomposed, emptyA, emptyB;
  ASSERT_EQ(NS_OK, Add("first@invalid"_ns, {"Missing@invalid"_ns}, first));
  ASSERT_EQ(NS_OK, Add("same@invalid"_ns, {"Missing@invalid"_ns}, same));
  ASSERT_EQ(NS_OK, Add("lower@invalid"_ns, {"missing@invalid"_ns}, lower));
  ASSERT_EQ(NS_OK, Add("spaced@invalid"_ns, {" Missing@invalid"_ns}, spaced));
  ASSERT_EQ(NS_OK,
            Add("composed@invalid"_ns, {"caf\xc3\xa9@invalid"_ns}, composed));
  ASSERT_EQ(NS_OK, Add("decomposed@invalid"_ns, {"cafe\xcc\x81@invalid"_ns},
                       decomposed));
  ASSERT_EQ(NS_OK, Add(""_ns, {}, emptyA));
  ASSERT_EQ(NS_OK, Add(""_ns, {}, emptyB));
  CapturedMessage emptyRowA, emptyRowB;
  ASSERT_EQ(NS_OK, db.CaptureMessage(emptyA, emptyRowA));
  ASSERT_EQ(NS_OK, db.CaptureMessage(emptyB, emptyRowB));
  ASSERT_NE(0u, emptyRowA.threadId);
  ASSERT_NE(0u, emptyRowB.threadId);
  ASSERT_NE(emptyRowA.threadId, emptyRowB.threadId);
  ASSERT_EQ(NS_OK, db.SetMessageReferences(emptyA, {""_ns}));
  ASSERT_EQ(NS_OK, db.SetMessageReferences(emptyB, {""_ns}));
  for (nsMsgKey key : {emptyA, emptyB}) {
    nsTArray<nsCString> emptyReferences;
    ASSERT_EQ(NS_OK, Stored(key, emptyReferences));
    ASSERT_EQ(1u, emptyReferences.Length());
    EXPECT_EQ((nsTArray<nsCString>{""_ns}), emptyReferences);
  }
  ExpectDiscovery(db, first, {{first, mFolderId}, {same, mFolderId}});
  for (nsMsgKey seed : {lower, spaced, composed, decomposed, emptyA, emptyB}) {
    ExpectDiscovery(db, seed, {{seed, mFolderId}});
  }
  nsTArray<nsCString> stored;
  ASSERT_EQ(NS_OK, Stored(decomposed, stored));
  EXPECT_EQ((nsTArray<nsCString>{"cafe\xcc\x81@invalid"_ns}), stored);
}

TEST_F(DeliveryCoreReferences, DiscoverMissingRowPreservesOutput) {
  ASSERT_EQ(NS_OK, Start());
  nsTArray<ConversationMember> output{{0xfffffff0, 0x123456789ULL}};
  EXPECT_EQ(NS_ERROR_UNEXPECTED,
            mCore->MessageDB().DiscoverConversationComponent(0, output));
  ASSERT_EQ(1u, output.Length());
  EXPECT_EQ(0xfffffff0u, output[0].id);
  EXPECT_EQ(0x123456789ULL, output[0].folderId);
}

TEST_F(DeliveryCoreReferences, DiscoverUnavailableHistoryPreservesOutput) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey known, unknown;
  ASSERT_EQ(NS_OK, Add("known@invalid"_ns, {}, known));
  ASSERT_EQ(NS_OK, Add("unknown@invalid"_ns, {}, unknown));
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(NS_OK, mConnection->CreateStatement(
                       "DELETE FROM message_reference_sets WHERE id = :id"_ns,
                       getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, unknown));
  ASSERT_EQ(NS_OK, stmt->Execute());
  ASSERT_EQ(NS_OK, stmt->Finalize());
  nsTArray<ConversationMember> output{{0xfffffff0, 0x123456789ULL}};
  // Even unrelated lost history could hide a reverse/shared edge.
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.DiscoverConversationComponent(known, output));
  ASSERT_EQ(1u, output.Length());
  EXPECT_EQ(0xfffffff0u, output[0].id);
  EXPECT_EQ(0x123456789ULL, output[0].folderId);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.DiscoverConversationComponent(unknown, output));
  ASSERT_EQ(NS_OK, db.SetMessageReferences(unknown, {}));
  ExpectDiscovery(db, known, {{known, mFolderId}});
  ExpectDiscovery(db, unknown, {{unknown, mFolderId}});
}

TEST_F(DeliveryCoreReferences, DiscoverReadErrorPreservesOutput) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("discovery-control@invalid"_ns, {}, control));
  ExpectDiscovery(db, control, {{control, mFolderId}});
  RefPtr<CaptureReadAbort> fault = new CaptureReadAbort();
  nsCOMPtr<mozIStorageProgressHandler> previous;
  ASSERT_EQ(NS_OK, mConnection->SetProgressHandler(1, fault,
                                                   getter_AddRefs(previous)));
  auto cleanup = MakeScopeExit([&] {
    nsCOMPtr<mozIStorageProgressHandler> removed;
    EXPECT_EQ(NS_OK,
              mConnection->RemoveProgressHandler(getter_AddRefs(removed)));
  });
  EXPECT_FALSE(previous);
  nsTArray<ConversationMember> output{{0xfffffff0, 0x123456789ULL}};
  EXPECT_EQ(NS_ERROR_ABORT, db.DiscoverConversationComponent(control, output));
  EXPECT_GT(fault->mCalls, 0u);
  EXPECT_EQ(1u, fault->mAborts);
  ASSERT_EQ(1u, output.Length());
  EXPECT_EQ(0xfffffff0u, output[0].id);
  EXPECT_EQ(0x123456789ULL, output[0].folderId);
  nsCOMPtr<mozIStorageProgressHandler> removed;
  ASSERT_EQ(NS_OK, mConnection->RemoveProgressHandler(getter_AddRefs(removed)));
  cleanup.release();
  EXPECT_EQ(fault.get(), removed.get());
  ExpectDiscovery(db, control, {{control, mFolderId}});
  bool inTransaction = true;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&inTransaction));
  EXPECT_FALSE(inTransaction);
}

TEST_F(DeliveryCoreReferences, DiscoverReadsStagedReferences) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey child, parent;
  ASSERT_EQ(NS_OK, Add("child@invalid"_ns, {"absent@invalid"_ns}, child));
  ASSERT_EQ(NS_OK, Add("present@invalid"_ns, {}, parent));
  ExpectDiscovery(db, child, {{child, mFolderId}});
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(
      NS_OK,
      mConnection->CreateStatement(
          "UPDATE message_references SET token = 'present@invalid' WHERE id = :id"_ns,
          getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, child));
  ASSERT_EQ(NS_OK, stmt->Execute());
  ASSERT_EQ(NS_OK, stmt->Finalize());
  ExpectDiscovery(db, child, {{child, mFolderId}, {parent, mFolderId}});
  bool inTransaction = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&inTransaction));
  EXPECT_TRUE(inTransaction);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  rollback.release();
  ExpectDiscovery(db, child, {{child, mFolderId}});
  nsTArray<nsCString> stored;
  ASSERT_EQ(NS_OK, Stored(child, stored));
  EXPECT_EQ((nsTArray<nsCString>{"absent@invalid"_ns}), stored);
}

TEST_F(DeliveryCoreReferences, StagingKeepsPhysicalIdentityOutOfMembership) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("published@invalid"_ns, {}, control));
  uint32_t publications = 0;
  nsMsgKey staged = nsMsgKey_None;
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([&](Message* message, bool notifyLegacy) {
        ++publications;
        EXPECT_FALSE(notifyLegacy);
        nsMsgKey observed;
        ASSERT_EQ(NS_OK, message->GetMessageKey(&observed));
        EXPECT_EQ(staged, observed);
        bool active = true;
        ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
        EXPECT_FALSE(active);
        nsCString text;
        ASSERT_EQ(NS_OK, message->GetStoreToken(text));
        EXPECT_EQ("finished-token"_ns, text);
        ASSERT_EQ(NS_OK, message->GetStringProperty("keywords", text));
        EXPECT_EQ("filtered"_ns, text);
        uint32_t flags;
        ASSERT_EQ(NS_OK, message->GetFlags(&flags));
        EXPECT_EQ(5u, flags);
        nsTArray<nsCString> stored;
        ASSERT_EQ(NS_OK, Stored(observed, stored));
        EXPECT_EQ(
            (nsTArray<nsCString>{"missing@invalid"_ns, "missing@invalid"_ns}),
            stored);
        nsCOMPtr<mozIStorageConnection> reader;
        ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
        auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
        const RawHdr::kv expected[] = {{"custom"_ns, "00042:text"_ns},
                                       {"Custom"_ns, "1e3:text"_ns}};
        for (const auto& property : expected) {
          ASSERT_EQ(NS_OK,
                    PublicationCell(
                        reader, observed,
                        "SELECT value || ':' || typeof(value) FROM "
                        "message_properties WHERE id = :id AND name = :name"_ns,
                        text, &property.k));
          EXPECT_EQ(property.v, text);
        }
      });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  RawHdr raw;
  raw.messageId = "staged@invalid"_ns;
  raw.subject = "staged subject"_ns;
  raw.references = {"missing@invalid"_ns, "missing@invalid"_ns};
  raw.extras = {{"custom"_ns, "00042"_ns}, {"Custom"_ns, "1e3"_ns}};
  RefPtr<Message> header;
  ASSERT_EQ(NS_OK,
            db.StageMessage(mFolderId, raw, &staged, getter_AddRefs(header)));
  EXPECT_NE(0u, staged);
  EXPECT_NE(nsMsgKey_None, staged);
  EXPECT_NE(control, staged);
  nsCString text;
  ASSERT_EQ(NS_OK, header->GetSubject(text));
  EXPECT_EQ("staged subject"_ns, text);
  ASSERT_EQ(NS_OK, header->GetStringProperty("custom", text));
  EXPECT_EQ("00042"_ns, text);
  ASSERT_EQ(NS_OK, header->GetStringProperty("Custom", text));
  EXPECT_EQ("1e3"_ns, text);
  ASSERT_EQ(NS_OK, header->SetFlags(5));
  ASSERT_EQ(NS_OK, header->SetStringProperty("keywords", "filtered"_ns));
  ASSERT_EQ(NS_OK, header->SetStoreToken("finished-token"_ns));
  EXPECT_EQ(0u, observer->mChanges);
  EXPECT_EQ(0u, publications);
  bool exists = true;
  ASSERT_EQ(NS_OK, db.MessageExists(staged, exists));
  EXPECT_FALSE(exists);
  uint64_t count = 99;
  ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
  EXPECT_EQ(1u, count);
  nsTArray<nsMsgKey> pending;
  ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, pending));
  EXPECT_EQ((nsTArray<nsMsgKey>{staged}), pending);
  ASSERT_EQ(NS_OK,
            PublicationCell(
                mConnection, staged,
                "SELECT count(*) FROM message_changes WHERE messageId = :id"_ns,
                text));
  EXPECT_EQ("0"_ns, text);
  ASSERT_EQ(NS_OK, db.PublishMessage(staged, false));
  EXPECT_EQ(1u, publications);
  ASSERT_EQ(NS_OK, db.MessageExists(staged, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
  EXPECT_EQ(2u, count);
  ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, pending));
  EXPECT_TRUE(pending.IsEmpty());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.PublishMessage(staged, true));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.AbortMessage(staged));
  EXPECT_EQ(1u, publications);
}

TEST_F(DeliveryCoreReferences, StagedHeaderAndReservedKeySurviveReopen) {
  ASSERT_EQ(NS_OK, Start());
  RawHdr raw;
  raw.messageId = "restart-staged@invalid"_ns;
  raw.subject = "retained header"_ns;
  raw.storeToken = Some(nsCString("retained-body"_ns));
  raw.references = {"first@invalid"_ns, "last@invalid"_ns};
  nsMsgKey staged;
  ASSERT_EQ(NS_OK, mCore->MessageDB().StageMessage(mFolderId, raw, &staged));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsTArray<nsMsgKey> pending;
  ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, pending));
  EXPECT_EQ((nsTArray<nsMsgKey>{staged}), pending);
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK, db.GetMessage(staged, getter_AddRefs(header)));
  nsCString text;
  ASSERT_EQ(NS_OK, header->GetStoreToken(text));
  EXPECT_EQ("retained-body"_ns, text);
  ASSERT_EQ(NS_OK, header->GetSubject(text));
  EXPECT_EQ("retained header"_ns, text);
  nsTArray<nsCString> refs;
  ASSERT_EQ(NS_OK, db.GetMessageReferences(staged, refs));
  EXPECT_EQ((nsTArray<nsCString>{"first@invalid"_ns, "last@invalid"_ns}), refs);
  nsMsgKey later, newest;
  ASSERT_EQ(NS_OK, Add("later@invalid"_ns, {}, later));
  EXPECT_GT(later, staged);
  ASSERT_EQ(NS_OK, db.PublishMessage(staged, true));
  ASSERT_EQ(NS_OK, Add("newest@invalid"_ns, {}, newest));
  EXPECT_GT(newest, later);
}

TEST_F(DeliveryCoreReferences, AbortDropsOnlyStagedMetadataAndRetiresKey) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  RawHdr raw;
  raw.messageId = "abort@invalid"_ns;
  raw.storeToken = Some(nsCString("finished-body-owned-by-store"_ns));
  raw.extras = {{"custom"_ns, "preserved text"_ns}};
  raw.references = {"missing@invalid"_ns};
  nsMsgKey staged, control;
  ASSERT_EQ(NS_OK, Add("survivor@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  ASSERT_EQ(NS_OK, db.AbortMessage(staged));
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, db.MessageExists(staged, exists));
  EXPECT_FALSE(exists);
  nsCString text;
  ASSERT_EQ(
      NS_OK,
      PublicationCell(
          mConnection, staged,
          "SELECT (SELECT count(*) FROM staged_messages WHERE id = :id) + "
          "(SELECT count(*) FROM staged_message_properties WHERE id = :id) + "
          "(SELECT count(*) FROM staged_message_references WHERE id = :id) + "
          "(SELECT count(*) FROM staged_message_reference_sets WHERE id = :id)"_ns,
          text));
  EXPECT_EQ("0"_ns, text);
  nsMsgKey next;
  ASSERT_EQ(NS_OK, Add("next@invalid"_ns, {}, next));
  EXPECT_GT(next, staged);
}

TEST_F(DeliveryCoreReferences, PublicationFailureRetainsStagingAndOutput) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("control@invalid"_ns, {}, control));
  uint32_t publications = 0;
  RefPtr<AddedObserver> observer = new AddedObserver([&](Message* message) {
    ++publications;
    nsCString value;
    ASSERT_EQ(NS_OK, message->GetStringProperty("reject-publication", value));
    EXPECT_EQ("complete"_ns, value);
  });
  db.AddMessageListener(observer);
  auto remove = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  RawHdr raw;
  raw.messageId = "retry@invalid"_ns;
  raw.extras = {{"reject-publication"_ns, "complete"_ns}};
  nsMsgKey staged;
  RefPtr<Message> header;
  ASSERT_EQ(NS_OK,
            db.StageMessage(mFolderId, raw, &staged, getter_AddRefs(header)));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "CREATE TEMP TRIGGER reject_publication BEFORE INSERT ON "
                "message_properties "
                "WHEN NEW.name = 'reject-publication' BEGIN "
                "SELECT RAISE(ABORT, 'publication property failure'); END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS reject_publication"_ns));
  });
  Message* output = header.get();
  EXPECT_TRUE(NS_FAILED(db.PublishMessage(staged, true, &output)));
  EXPECT_EQ(header.get(), output);
  EXPECT_EQ(0u, publications);
  bool active = true, exists = true;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_EQ(NS_OK, db.MessageExists(staged, exists));
  EXPECT_FALSE(exists);
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
  nsCString text;
  ASSERT_EQ(NS_OK, header->GetStringProperty("reject-publication", text));
  EXPECT_EQ("complete"_ns, text);
  ASSERT_EQ(NS_OK,
            PublicationCell(
                mConnection, staged,
                "SELECT count(*) FROM message_changes WHERE messageId = :id"_ns,
                text));
  EXPECT_EQ("0"_ns, text);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER reject_publication"_ns));
  ASSERT_EQ(NS_OK, db.PublishMessage(staged, true));
  EXPECT_EQ(1u, publications);
  ASSERT_EQ(NS_OK, db.MessageExists(staged, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreReferences, StagedThreadActionIsCompleteAtFirstCallback) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  const uint32_t words[] = {
      nsMsgMessageFlags::Ignored, nsMsgMessageFlags::Watched,
      uint32_t(nsMsgMessageFlags::Ignored | nsMsgMessageFlags::Watched) |
          0x80000000u};
  for (uint32_t word : words) {
    SCOPED_TRACE(word);
    RawHdr raw;
    raw.messageId = "proto-first-"_ns;
    raw.messageId.AppendInt(int64_t(word));
    raw.flags = nsMsgMessageFlags::Read | nsMsgMessageFlags::Marked;
    nsMsgKey key;
    RefPtr<Message> staged;
    ASSERT_EQ(NS_OK,
              db.StageMessage(mFolderId, raw, &key, getter_AddRefs(staged)));
    ASSERT_EQ(NS_OK, staged->SetUint32Property("ProtoThreadFlags", word));
    Message* output = nullptr;
    uint32_t callbacks = 0;
    RefPtr<PublicationObserver> observer =
        new PublicationObserver([&](Message* message, bool notifyLegacy) {
          ++callbacks;
          EXPECT_TRUE(notifyLegacy);
          EXPECT_EQ(message, output);
          nsMsgKey thread;
          ASSERT_EQ(NS_OK, message->GetThreadId(&thread));
          uint32_t flags;
          ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, thread, flags));
          EXPECT_EQ(word, flags);
          ASSERT_EQ(NS_OK, message->GetFlags(&flags));
          EXPECT_EQ(raw.flags, flags);
          ASSERT_EQ(NS_OK,
                    message->GetUint32Property("ProtoThreadFlags", &flags));
          EXPECT_EQ(0u, flags);
          nsCOMPtr<mozIStorageConnection> reader;
          ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
          auto close =
              MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
          nsCString text;
          ASSERT_EQ(
              NS_OK,
              PublicationCell(
                  reader, key,
                  "SELECT flags FROM thread_flags WHERE "
                  "folderId=(SELECT folderId FROM messages WHERE id=:id) "
                  "AND threadId=(SELECT threadId FROM messages WHERE id=:id)"_ns,
                  text));
          nsAutoCString expected;
          expected.AppendInt(int64_t(word));
          EXPECT_EQ(expected, text);
          ASSERT_EQ(NS_OK,
                    PublicationCell(
                        reader, key,
                        "SELECT count(*) FROM staged_messages WHERE id=:id"_ns,
                        text));
          EXPECT_EQ("0"_ns, text);
          ASSERT_EQ(NS_OK, PublicationCell(
                               reader, key,
                               "SELECT value FROM message_properties WHERE "
                               "id=:id AND name='ProtoThreadFlags'"_ns,
                               text));
          EXPECT_EQ("0"_ns, text);
        });
    db.AddMessageListener(observer);
    auto remove = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
    ASSERT_EQ(NS_OK, db.PublishMessage(key, true, &output));
    RefPtr<Message> owned = dont_AddRef(output);
    EXPECT_EQ(1u, callbacks);
    EXPECT_EQ(0u, observer->mChanges);
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.PublishMessage(key, true, &output));
    EXPECT_EQ(owned.get(), output);
    EXPECT_EQ(1u, callbacks);
  }
}

TEST_F(DeliveryCoreReferences, StagedThreadActionUsesFinalScopedThread) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey root, thread, foreign;
  ASSERT_EQ(NS_OK, Add("proto-final-root@invalid"_ns, {}, root));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(root, thread));
  uint64_t otherFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "ProtoOther"_ns,
                                                  &otherFolder));
  RawHdr other;
  other.messageId = "proto-foreign@invalid"_ns;
  other.references = {"proto-final-root@invalid"_ns};
  ASSERT_EQ(NS_OK, db.AddMessage(otherFolder, other, true, &foreign));
  const uint32_t oldWord = 0x80000000u | nsMsgMessageFlags::Marked;
  const uint32_t foreignWord = 0x40000000u;
  ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, thread, oldWord));
  ASSERT_EQ(NS_OK, db.SetThreadFlags(otherFolder, thread, foreignWord));
  RawHdr raw;
  raw.messageId = "proto-final-child@invalid"_ns;
  raw.references = {"proto-final-root@invalid"_ns};
  raw.extras = {{"literal"_ns, "00042"_ns}};
  nsMsgKey key;
  RefPtr<Message> staged;
  ASSERT_EQ(NS_OK,
            db.StageMessage(mFolderId, raw, &key, getter_AddRefs(staged)));
  nsMsgKey stagedThread;
  ASSERT_EQ(NS_OK, staged->GetThreadId(&stagedThread));
  EXPECT_EQ(thread, stagedThread);
  EXPECT_NE(key, stagedThread);
  nsCString storedThread;
  ASSERT_EQ(NS_OK, PublicationCell(
                       mConnection, key,
                       "SELECT threadId FROM staged_messages WHERE id=:id"_ns,
                       storedThread));
  nsAutoCString expectedStoredThread;
  expectedStoredThread.AppendInt(int64_t(thread));
  EXPECT_EQ(expectedStoredThread, storedThread);
  const uint32_t pending =
      nsMsgMessageFlags::Ignored | nsMsgMessageFlags::Watched;
  ASSERT_EQ(NS_OK, staged->SetUint32Property("ProtoThreadFlags", pending));
  ASSERT_EQ(NS_OK, db.PublishMessage(key, true));
  nsMsgKey actual;
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(key, actual));
  EXPECT_EQ(thread, actual);
  uint32_t flags;
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(oldWord | pending, flags);
  ASSERT_EQ(NS_OK, db.GetThreadFlags(otherFolder, thread, flags));
  EXPECT_EQ(foreignWord, flags);
  nsCString consumed, literal;
  ASSERT_EQ(NS_OK, staged->GetStringProperty("ProtoThreadFlags", consumed));
  EXPECT_EQ("0"_ns, consumed);
  ASSERT_EQ(NS_OK, staged->GetStringProperty("literal", literal));
  EXPECT_EQ("00042"_ns, literal);

  // Carry the consumed property into a new unrelated staged header: the action
  // must not run again merely because its metadata was copied.
  RawHdr copied;
  copied.messageId = "proto-consumed-copy@invalid"_ns;
  copied.extras = {{"ProtoThreadFlags"_ns, consumed}};
  nsMsgKey copyKey;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, copied, &copyKey));
  ASSERT_EQ(NS_OK, db.PublishMessage(copyKey, true));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(copyKey, actual));
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, actual, flags));
  EXPECT_EQ(0u, flags);
}

TEST_F(DeliveryCoreReferences,
       StagedThreadActionPreservesAbsentAndZeroProperties) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  for (uint32_t mode = 0; mode < 3; ++mode) {
    SCOPED_TRACE(mode);
    RawHdr raw;
    raw.messageId = "proto-no-action-"_ns;
    raw.messageId.AppendInt(mode);
    raw.extras = {{"ProtoThreadFlags-other"_ns, "literal"_ns}};
    nsCString expected(mode == 1 ? ""_ns : "00000000"_ns);
    if (mode)
      raw.extras.AppendElement(RawHdr::kv{"ProtoThreadFlags"_ns, expected});
    nsMsgKey key;
    RefPtr<Message> header;
    ASSERT_EQ(NS_OK,
              db.StageMessage(mFolderId, raw, &key, getter_AddRefs(header)));
    ASSERT_EQ(NS_OK, db.PublishMessage(key, true));
    nsCString text;
    ASSERT_EQ(NS_OK,
              PublicationCell(mConnection, key,
                              "SELECT count(*) FROM message_properties "
                              "WHERE id=:id AND name='ProtoThreadFlags'"_ns,
                              text));
    EXPECT_EQ(mode ? "1"_ns : "0"_ns, text);
    if (mode) {
      ASSERT_EQ(NS_OK, header->GetStringProperty("ProtoThreadFlags", text));
      EXPECT_EQ(expected, text);
    }
    ASSERT_EQ(
        NS_OK,
        PublicationCell(
            mConnection, key,
            "SELECT count(*) FROM thread_flags WHERE "
            "folderId=(SELECT folderId FROM messages WHERE id=:id) "
            "AND threadId=(SELECT threadId FROM messages WHERE id=:id)"_ns,
            text));
    EXPECT_EQ("0"_ns, text);
    ASSERT_EQ(NS_OK, header->GetStringProperty("ProtoThreadFlags-other", text));
    EXPECT_EQ("literal"_ns, text);
  }
}

TEST_F(DeliveryCoreReferences,
       StagedThreadActionFailuresRetainPublicationAndRetry) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey root, thread;
  ASSERT_EQ(NS_OK, Add("proto-retry-root@invalid"_ns, {}, root));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(root, thread));
  for (uint32_t mode = 0; mode < 4; ++mode) {
    SCOPED_TRACE(mode);
    const uint32_t oldWord = 0x80000000u;
    ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, thread, oldWord));
    RawHdr raw;
    raw.messageId = "proto-retry-child-"_ns;
    raw.messageId.AppendInt(mode);
    raw.references = {"proto-retry-root@invalid"_ns};
    nsMsgKey key;
    RefPtr<Message> staged;
    ASSERT_EQ(NS_OK,
              db.StageMessage(mFolderId, raw, &key, getter_AddRefs(staged)));
    ASSERT_EQ(NS_OK, staged->SetUint32Property("ProtoThreadFlags",
                                               nsMsgMessageFlags::Watched));
    nsCString pending;
    ASSERT_EQ(NS_OK, staged->GetStringProperty("ProtoThreadFlags", pending));
    uint32_t callbacks = 0;
    RefPtr<PublicationObserver> observer =
        new PublicationObserver([&](Message*, bool) { ++callbacks; });
    db.AddMessageListener(observer);
    auto remove = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
    RefPtr<FaultWitness> witness = new FaultWitness();
    ASSERT_EQ(NS_OK,
              mConnection->CreateFunction("proto_action_fault"_ns, 1, witness));
    bool renamed = false;
    auto cleanup = MakeScopeExit([&] {
      EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "DROP TRIGGER IF EXISTS reject_proto_action"_ns));
      if (renamed) {
        EXPECT_EQ(
            NS_OK,
            mConnection->ExecuteSimpleSQL(
                "ALTER TABLE unavailable_proto_words RENAME TO thread_flags"_ns));
      }
      EXPECT_EQ(NS_OK, mConnection->RemoveFunction("proto_action_fault"_ns));
    });
    if (mode == 0) {
      ASSERT_EQ(
          NS_OK,
          mConnection->ExecuteSimpleSQL(
              "ALTER TABLE thread_flags RENAME TO unavailable_proto_words"_ns));
      renamed = true;
    } else if (mode == 1) {
      ASSERT_EQ(NS_OK,
                mConnection->ExecuteSimpleSQL(
                    "CREATE TEMP TRIGGER reject_proto_action BEFORE INSERT "
                    "ON main.thread_flags BEGIN SELECT "
                    "proto_action_fault(NEW.threadId); "
                    "SELECT RAISE(ABORT,'proto word'); END"_ns));
    } else if (mode == 2) {
      ASSERT_EQ(
          NS_OK,
          mConnection->ExecuteSimpleSQL(
              "CREATE TEMP TRIGGER reject_proto_action BEFORE UPDATE OF value "
              "ON main.message_properties WHEN OLD.name='ProtoThreadFlags' "
              "BEGIN "
              "SELECT proto_action_fault(NEW.id); SELECT RAISE(ABORT,'proto consume'); END"_ns));
    } else {
      ASSERT_EQ(
          NS_OK,
          mConnection->ExecuteSimpleSQL(
              "PRAGMA foreign_keys=ON; "
              "CREATE TEMP TABLE proto_commit_parent(id INTEGER PRIMARY KEY); "
              "CREATE TEMP TABLE proto_commit_child(id INTEGER REFERENCES "
              "proto_commit_parent(id) DEFERRABLE INITIALLY DEFERRED); "
              "CREATE TEMP TRIGGER reject_proto_action AFTER UPDATE OF value "
              "ON main.message_properties WHEN OLD.name='ProtoThreadFlags' "
              "BEGIN "
              "SELECT proto_action_fault(NEW.id); INSERT INTO "
              "proto_commit_child "
              "VALUES(NEW.id); END"_ns));
      nsCOMPtr<mozIStorageStatement> foreignKeys;
      ASSERT_EQ(NS_OK,
                mConnection->CreateStatement("PRAGMA foreign_keys"_ns,
                                             getter_AddRefs(foreignKeys)));
      bool more;
      ASSERT_EQ(NS_OK, foreignKeys->ExecuteStep(&more));
      ASSERT_TRUE(more);
      int32_t enabled;
      ASSERT_EQ(NS_OK, foreignKeys->GetInt32(0, &enabled));
      EXPECT_EQ(1, enabled);
      ASSERT_EQ(NS_OK, foreignKeys->Finalize());
    }
    Message* output = staged.get();
    EXPECT_EQ(mode == 0 ? NS_ERROR_FAILURE : NS_ERROR_STORAGE_CONSTRAINT,
              db.PublishMessage(key, true, &output));
    EXPECT_EQ(staged.get(), output);
    EXPECT_EQ(0u, callbacks);
    EXPECT_EQ(mode == 0 ? 0u : 1u, witness->mCalls);
    if (mode) EXPECT_EQ(int64_t(mode == 1 ? thread : key), witness->mLastKey);
    bool active = true, exists = true;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
    EXPECT_FALSE(exists);
    nsTArray<nsMsgKey> stagedKeys;
    ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, stagedKeys));
    EXPECT_EQ((nsTArray<nsMsgKey>{key}), stagedKeys);
    nsCString text;
    ASSERT_EQ(NS_OK, staged->GetStringProperty("ProtoThreadFlags", text));
    EXPECT_EQ(pending, text);
    nsTArray<nsCString> references;
    ASSERT_EQ(NS_OK, db.GetMessageReferences(key, references));
    EXPECT_EQ(raw.references, references);
    ASSERT_EQ(NS_OK,
              PublicationCell(
                  mConnection, key,
                  "SELECT count(*) FROM message_changes WHERE messageId=:id"_ns,
                  text));
    EXPECT_EQ("0"_ns, text);
    if (renamed) {
      ASSERT_EQ(
          NS_OK,
          mConnection->ExecuteSimpleSQL(
              "ALTER TABLE unavailable_proto_words RENAME TO thread_flags"_ns));
      renamed = false;
    }
    uint32_t flags;
    ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, thread, flags));
    EXPECT_EQ(oldWord, flags);
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS reject_proto_action"_ns));
    RefPtr<Message> published;
    ASSERT_EQ(NS_OK, db.PublishMessage(key, true, getter_AddRefs(published)));
    EXPECT_EQ(1u, callbacks);
    ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, thread, flags));
    EXPECT_EQ(oldWord | nsMsgMessageFlags::Watched, flags);
    ASSERT_EQ(NS_OK, published->GetStringProperty("ProtoThreadFlags", text));
    EXPECT_EQ("0"_ns, text);
  }
}

TEST_F(DeliveryCoreReferences,
       StagedThreadActionKeepsCallerTransactionAndQueueOrder) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey control, thread;
  ASSERT_EQ(NS_OK, Add("proto-transaction-control@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(control, thread));
  RawHdr raw;
  raw.messageId = "proto-queued-first@invalid"_ns;
  nsMsgKey first, second;
  RefPtr<Message> firstStage, secondStage;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &first,
                                   getter_AddRefs(firstStage)));
  raw.messageId = "proto-queued-second@invalid"_ns;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &second,
                                   getter_AddRefs(secondStage)));
  ASSERT_EQ(NS_OK, firstStage->SetUint32Property("ProtoThreadFlags",
                                                 nsMsgMessageFlags::Ignored));
  ASSERT_EQ(NS_OK, secondStage->SetUint32Property("ProtoThreadFlags",
                                                  nsMsgMessageFlags::Watched));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  {
    auto rollback = MakeScopeExit(
        [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
    ASSERT_EQ(NS_OK,
              db.SetMessageProperty(control, "caller"_ns, "retained"_ns));
    Message* output = firstStage.get();
    EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.PublishMessage(first, true, &output));
    EXPECT_EQ(firstStage.get(), output);
    EXPECT_EQ(NS_ERROR_IN_PROGRESS,
              db.SetThreadFlags(mFolderId, thread, UINT32_MAX));
    bool active = false;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_TRUE(active);
    nsCString text;
    ASSERT_EQ(NS_OK, db.GetMessageProperty(control, "caller"_ns, text));
    EXPECT_EQ("retained"_ns, text);
  }
  Message* firstOutput = nullptr;
  Message* secondOutput = nullptr;
  nsTArray<nsMsgKey> callbacks;
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([&](Message* message, bool) {
        nsMsgKey key, actualThread;
        ASSERT_EQ(NS_OK, message->GetMessageKey(&key));
        callbacks.AppendElement(key);
        EXPECT_EQ(key == first ? firstOutput : secondOutput, message);
        ASSERT_EQ(NS_OK, message->GetThreadId(&actualThread));
        uint32_t flags;
        ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, actualThread, flags));
        EXPECT_EQ(key == first ? nsMsgMessageFlags::Ignored
                               : nsMsgMessageFlags::Watched,
                  flags);
        if (key == first) {
          ASSERT_EQ(NS_OK, db.PublishMessage(second, true, &secondOutput));
          EXPECT_EQ((nsTArray<nsMsgKey>{first}), callbacks);
        }
      });
  db.AddMessageListener(observer);
  auto remove = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, db.PublishMessage(first, true, &firstOutput));
  RefPtr<Message> ownedFirst = dont_AddRef(firstOutput);
  RefPtr<Message> ownedSecond = dont_AddRef(secondOutput);
  EXPECT_EQ((nsTArray<nsMsgKey>{first, second}), callbacks);
  EXPECT_EQ(0u, observer->mChanges);
}

TEST_F(DeliveryCoreReferences,
       StagingFailurePreservesOutputsAndForeignTransaction) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("staging-control@invalid"_ns, {}, control));
  RefPtr<Message> controlHeader = new Message(control);
  RawHdr raw;
  raw.messageId = "failed-staging@invalid"_ns;
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_stage BEFORE INSERT ON "
          "staged_message_reference_sets "
          "BEGIN SELECT RAISE(ABORT, 'stage reference failure'); END"_ns));
  nsMsgKey key = 123;
  Message* outputHeader = controlHeader.get();
  EXPECT_TRUE(NS_FAILED(db.StageMessage(mFolderId, raw, &key, &outputHeader)));
  EXPECT_EQ(controlHeader.get(), outputHeader);
  EXPECT_EQ(123u, key);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER reject_stage"_ns));
  nsTArray<nsMsgKey> pending;
  ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, pending));
  EXPECT_TRUE(pending.IsEmpty());
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &key));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  nsMsgKey output = 456;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.StageMessage(mFolderId, raw, &output));
  EXPECT_EQ(456u, output);
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.PublishMessage(key, true));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.AbortMessage(key));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
}

TEST_F(DeliveryCoreReferences,
       EpochChangeRetiresStagedBindingWithoutLosingHeader) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 11));
  RawHdr raw;
  raw.messageId = "old-epoch@invalid"_ns;
  raw.storeToken = Some(nsCString("retained-body"_ns));
  raw.extras = {{"uidOnServer"_ns, "2a"_ns}, {"UidOnServer"_ns, "keep"_ns}};
  nsMsgKey key;
  RefPtr<Message> header;
  ASSERT_EQ(NS_OK,
            db.StageMessage(mFolderId, raw, &key, getter_AddRefs(header)));
  uint32_t uid = 99;
  ASSERT_EQ(NS_OK, header->GetUint32Property("uidOnServer", &uid));
  EXPECT_EQ(42u, uid);
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 12));
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(key, names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  EXPECT_TRUE(names.Contains("UidOnServer"_ns));
  nsCString token;
  ASSERT_EQ(NS_OK, header->GetStoreToken(token));
  EXPECT_EQ("retained-body"_ns, token);
  ASSERT_EQ(NS_OK, db.PublishMessage(key, true));
  nsMsgKey output = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetMessageKeyForServerUid(mFolderId, 12, 42, output));
  EXPECT_EQ(123u, output);
}

TEST_F(DeliveryCoreReferences, ImmediateAddRetainsMissingFolderCompatibility) {
  ASSERT_EQ(NS_OK, Start());
  RawHdr raw;
  raw.messageId = "no-folder@invalid"_ns;
  const uint64_t missingFolder = mFolderId + 1;
  nsMsgKey published;
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.AddMessage(missingFolder, raw, true, &published));
  bool exists = false;
  ASSERT_EQ(NS_OK, db.MessageExists(published, exists));
  EXPECT_TRUE(exists);
  nsMsgKey output = 77;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.StageMessage(missingFolder, raw, &output));
  EXPECT_EQ(77u, output);
  EXPECT_EQ(NS_ERROR_INVALID_ARG, db.StageMessage(0, raw, &output));
  EXPECT_EQ(77u, output);
}

TEST_F(DeliveryCoreReferences, MissingFolderPublicationRetainsStagedHeader) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t destination;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "Destination"_ns,
                                                  &destination));
  RawHdr raw;
  raw.messageId = "removed-folder@invalid"_ns;
  raw.storeToken = Some(nsCString("retained-body"_ns));
  nsMsgKey key;
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.StageMessage(destination, raw, &key));
  ASSERT_EQ(NS_OK, mCore->FolderDB().DeleteFolder(destination));
  EXPECT_EQ(NS_ERROR_UNEXPECTED, db.PublishMessage(key, true));
  nsTArray<nsMsgKey> staged;
  ASSERT_EQ(NS_OK, db.ListStagedMessages(destination, staged));
  EXPECT_EQ((nsTArray<nsMsgKey>{key}), staged);
  bool exists = true;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_FALSE(exists);
  nsCString token;
  ASSERT_EQ(NS_OK, db.GetMessageStoreToken(key, token));
  EXPECT_EQ("retained-body"_ns, token);
}

TEST_F(DeliveryCoreReferences, OfflineDeletesUseProtocolDeletedFlag) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey deleted, mdnSent, moved, copied;
  ASSERT_EQ(NS_OK, Add("protocol-deleted@invalid"_ns, {}, deleted));
  ASSERT_EQ(NS_OK, Add("protocol-mdn@invalid"_ns, {}, mdnSent));
  ASSERT_EQ(NS_OK, Add("protocol-moved@invalid"_ns, {}, moved));
  ASSERT_EQ(NS_OK, Add("protocol-copied@invalid"_ns, {}, copied));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kFlagsChanged;
  input.newFlags = kImapMsgDeletedFlag;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, deleted, input));
  input.newFlags = kImapMsgMDNSentFlag;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, mdnSent, input));
  input.operation = nsIMsgOfflineImapOperation::kMsgMoved;
  input.newFlags = 0;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, moved, input));
  // Copy: a flag value alone does not make it a deletion.
  input.operation = nsIMsgOfflineImapOperation::kMsgCopy;
  input.newFlags = kImapMsgDeletedFlag;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, copied, input));
  ASSERT_EQ(NS_OK, db.RemoveMessage(deleted));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().ListOfflineOperations(mFolderId, true, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{deleted, moved}), keys);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().ListOfflineOperations(mFolderId, false, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{deleted, mdnSent, moved, copied}), keys);
  bool exists = true;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(deleted, exists));
  EXPECT_FALSE(exists);
}

TEST_F(DeliveryCoreReferences,
       CombinedOfflinePayloadSurvivesDeletionAndReopen) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
  auto& db = mCore->MessageDB();
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, Add("offline@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, Add("control@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.SetMessageUidOnServer(key, 42));
  OfflineOperationData input;
  input.operation = 1 | 2 | 4 | 0x400 | 0x800;
  input.flagOperation = 0x80000000;
  input.newFlags = UINT32_MAX;
  input.sourceKey = control;
  input.sourceUid = UINT32_MAX;
  input.messageSize = UINT32_MAX;
  input.playingBack = false;
  input.sourceFolderURI = "imap://source/Inbox"_ns;
  input.destinationFolderURI = "imap://destination/Moved"_ns;
  input.keywordsToAdd = "first second"_ns;
  input.keywordsToRemove = "old"_ns;
  input.copyDestinations = {"imap://destination/One"_ns,
                            "imap://destination/Two"_ns,
                            "imap://destination/One"_ns};
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, input));
  ASSERT_EQ(NS_OK, db.SetOfflineOperationPlayingBack(mFolderId, key, true));
  ASSERT_NO_FATAL_FAILURE(CheckOfflineSource(key, 7, 42));
  ASSERT_EQ(NS_OK, db.RemoveMessage(key));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  OfflineOperationData stored;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetOfflineOperation(mFolderId, key, stored));
  EXPECT_EQ(uint32_t(1 | 2 | 4 | 0x400 | 0x800), stored.operation);
  EXPECT_EQ(0x80000000u, stored.flagOperation);
  EXPECT_EQ(UINT32_MAX, stored.newFlags);
  EXPECT_EQ(control, stored.sourceKey);
  EXPECT_EQ(UINT32_MAX, stored.sourceUid);
  EXPECT_EQ(UINT32_MAX, stored.messageSize);
  EXPECT_TRUE(stored.playingBack);
  EXPECT_EQ("imap://source/Inbox"_ns, stored.sourceFolderURI);
  EXPECT_EQ("imap://destination/Moved"_ns, stored.destinationFolderURI);
  EXPECT_EQ("first second"_ns, stored.keywordsToAdd);
  EXPECT_EQ("old"_ns, stored.keywordsToRemove);
  EXPECT_EQ((nsTArray<nsCString>{"imap://destination/One"_ns,
                                 "imap://destination/Two"_ns,
                                 "imap://destination/One"_ns}),
            stored.copyDestinations);
  nsTArray<nsMsgKey> deletes;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().ListOfflineOperations(mFolderId, true, deletes));
  EXPECT_EQ((nsTArray<nsMsgKey>{key}), deletes);
  ASSERT_NO_FATAL_FAILURE(CheckOfflineSource(key, 7, 42));
  stored.keywordsToAdd = "later edit"_ns;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().StoreOfflineOperation(mFolderId, key, stored));
  ASSERT_NO_FATAL_FAILURE(CheckOfflineSource(key, 7, 42));
  OfflineOperationData edited;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetOfflineOperation(mFolderId, key, edited));
  EXPECT_EQ("later edit"_ns, edited.keywordsToAdd);
  EXPECT_EQ(stored.copyDestinations, edited.copyDestinations);
  bool exists;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(control, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_FALSE(exists);
}

TEST_F(DeliveryCoreReferences,
       OfflinePayloadErrorsPreservePayloadAndReadOutput) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, Add("offline-error@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, Add("control@invalid"_ns, {}, control));
  OfflineOperationData input;
  input.operation = 4;
  input.keywordsToAdd = "original"_ns;
  input.copyDestinations = {"first"_ns, "second"_ns};
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, input));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_offline_copy BEFORE INSERT ON "
          "offline_copy_destinations "
          "WHEN NEW.uri = 'reject' BEGIN SELECT RAISE(ABORT, 'copy failure'); END"_ns));
  input.keywordsToAdd = "replacement"_ns;
  input.copyDestinations = {"new-first"_ns, "reject"_ns};
  EXPECT_TRUE(NS_FAILED(db.StoreOfflineOperation(mFolderId, key, input)));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER reject_offline_copy"_ns));
  OfflineOperationData stored;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, key, stored));
  EXPECT_EQ("original"_ns, stored.keywordsToAdd);
  EXPECT_EQ((nsTArray<nsCString>{"first"_ns, "second"_ns}),
            stored.copyDestinations);
  stored.keywordsToAdd = "sentinel"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetOfflineOperation(mFolderId, nsMsgKey_None, stored));
  EXPECT_EQ("sentinel"_ns, stored.keywordsToAdd);
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP VIEW offline_copy_destinations AS SELECT * "
          "FROM main.offline_copy_destinations WHERE abs(-9223372036854775808)"_ns));
  EXPECT_TRUE(NS_FAILED(db.GetOfflineOperation(mFolderId, key, stored)));
  EXPECT_EQ("sentinel"_ns, stored.keywordsToAdd);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.offline_copy_destinations"_ns));
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, key, stored));
  EXPECT_EQ("original"_ns, stored.keywordsToAdd);
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreReferences, ReservedOfflineKeySurvivesReopenWithoutMessage) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().ReserveOfflineOperationKey(mFolderId, key));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  OfflineOperationData payload;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetOfflineOperation(mFolderId, key, payload));
  EXPECT_EQ(0u, payload.operation);
  bool exists = true;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_FALSE(exists);
  nsMsgKey next;
  ASSERT_EQ(NS_OK, Add("after-reservation@invalid"_ns, {}, next));
  EXPECT_GT(next, key);
}

TEST_F(DeliveryCoreReferences,
       AppendAcceptedWithoutUidSurvivesReopenAndFencesReplay) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  MessageBodyState body;
  OfflineAttempt expected;
  ASSERT_EQ(NS_OK, QueuedAppend(key, body, expected));
  auto& db = mCore->MessageDB();
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.ValidateOfflineAppendAcceptedWithoutUid(expected));
  ASSERT_EQ(NS_OK, db.RecordOfflineAppendAcceptedWithoutUid(expected));
  ASSERT_EQ(NS_OK, db.ValidateOfflineAppendAcceptedWithoutUid(expected));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->MessageDB();
  OfflineAttempt actual;
  ASSERT_EQ(NS_OK, reopened.GetCurrentOfflineAttempt(mFolderId, key, actual));
  EXPECT_EQ(expected.id, actual.id);
  EXPECT_TRUE(actual.appendAccepted);
  EXPECT_EQ(OfflineAttemptState::Sent, actual.state);
  EXPECT_FALSE(actual.confirmedUid);
  ASSERT_TRUE(actual.appendBody);
  EXPECT_EQ(body.databaseSourceId, actual.appendBody->databaseSourceId);
  EXPECT_EQ(Some(nsCString("0"_ns)), actual.appendBody->storeToken);
  EXPECT_EQ(body.contentRevision, actual.appendBody->contentRevision);
  EXPECT_EQ(body.locationRevision, actual.appendBody->locationRevision);
  EXPECT_EQ(12u, actual.appendBody->messageSize);
  EXPECT_EQ(12u, actual.appendBody->offlineMessageSize);
  EXPECT_EQ(1u, actual.appendBody->lineCount);
  EXPECT_EQ(NS_OK, reopened.RecordOfflineAppendAcceptedWithoutUid(expected));
  EXPECT_EQ(NS_OK, reopened.ValidateOfflineAppendAcceptedWithoutUid(actual));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            reopened.ResolveOfflineAttemptNotApplied(actual.id));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            reopened.MarkOfflineAttemptAmbiguous(actual.id));
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            reopened.ConfirmOfflineAttempt(actual.id, Nothing()));
  uint64_t untouched = 99;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            reopened.BeginOfflineAttempt(mFolderId, key, actual.operation,
                                         actual.destination, untouched, &body));
  EXPECT_EQ(99u, untouched);
  OfflineOperationData op;
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperation(mFolderId, key, op));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            reopened.StoreOfflineOperation(mFolderId, key, op));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            reopened.RemoveOfflineOperation(mFolderId, key));
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, reopened.GetMessagePropertyNames(key, names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  bool exists = false;
  ASSERT_EQ(NS_OK, reopened.MessageExists(key, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, reopened.GetMessageBodyState(key, body));
  EXPECT_EQ(Some(nsCString("0"_ns)), body.storeToken);
  // Only a later authoritative UID receipt resolves identity.
  ASSERT_EQ(NS_OK, reopened.ConfirmOfflineAttempt(
                       actual.id, Some(ServerUidConfirmation{7, 42})));
  ASSERT_EQ(NS_OK, reopened.GetOfflineAttempt(actual.id, actual));
  EXPECT_TRUE(actual.appendAccepted);
  EXPECT_EQ(OfflineAttemptState::Confirmed, actual.state);
  EXPECT_EQ(Some(42u), actual.confirmedUid);
  EXPECT_EQ(NS_OK, reopened.ConfirmOfflineAttempt(
                       actual.id, Some(ServerUidConfirmation{7, 42})));
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            reopened.ConfirmOfflineAttempt(actual.id,
                                           Some(ServerUidConfirmation{7, 43})));
  EXPECT_EQ(NS_OK, reopened.RecordOfflineAppendAcceptedWithoutUid(expected));
}

TEST_F(DeliveryCoreReferences,
       CopyAcceptanceWithoutUidRetainsExactPhysicalState) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey source, target;
  uint64_t folder;
  OfflineAttempt expected;
  ASSERT_EQ(NS_OK, QueuedCopy(source, folder, target, expected));
  auto& db = mCore->MessageDB();
  ASSERT_TRUE(expected.transferBody);
  EXPECT_FALSE(expected.transferBody->storeToken);
  EXPECT_EQ(0u, expected.transferBody->flags & nsMsgMessageFlags::Offline);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.ValidateOfflineCopyAcceptedWithoutUid(expected));
  ASSERT_EQ(NS_OK, db.RemoveMessage(source));
  ASSERT_EQ(NS_OK, db.RecordOfflineCopyAcceptedWithoutUid(expected));
  ASSERT_EQ(NS_OK, db.ValidateOfflineCopyAcceptedWithoutUid(expected));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->MessageDB();
  OfflineAttempt actual;
  ASSERT_EQ(NS_OK,
            reopened.GetOfflineAttemptForAction(
                mFolderId, source, expected.operation, Some(0u), actual));
  EXPECT_EQ(expected.id, actual.id);
  EXPECT_EQ(expected.operationKey, actual.operationKey);
  EXPECT_EQ(Some(0u), actual.copyOrdinal);
  EXPECT_TRUE(actual.transferAccepted);
  EXPECT_EQ(OfflineAttemptState::Sent, actual.state);
  EXPECT_FALSE(actual.confirmedUid);
  ASSERT_TRUE(actual.transferBody);
  EXPECT_FALSE(actual.transferBody->storeToken);
  EXPECT_EQ(expected.transferSourceId, actual.transferBody->databaseSourceId);
  EXPECT_EQ(NS_OK, reopened.RecordOfflineCopyAcceptedWithoutUid(expected));
  EXPECT_EQ(NS_OK, reopened.ValidateOfflineCopyAcceptedWithoutUid(expected));
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            reopened.ConfirmOfflineAttempt(actual.id, Nothing()));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            reopened.ResolveOfflineAttemptNotApplied(actual.id));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            reopened.MarkOfflineAttemptAmbiguous(actual.id));
  uint64_t untouched = 99;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, reopened.BeginOfflineAction(
                                      mFolderId, source, actual.operation,
                                      actual.destination, Some(0u), untouched));
  EXPECT_EQ(99u, untouched);
  OfflineOperationData payload;
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperation(mFolderId, source, payload));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            reopened.StoreOfflineOperation(mFolderId, source, payload));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            reopened.RemoveOfflineOperation(mFolderId, source));
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, reopened.GetMessagePropertyNames(target, names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  ASSERT_EQ(NS_OK, reopened.ConfirmOfflineAttempt(
                       actual.id, Some(ServerUidConfirmation{9, 42})));
  ASSERT_EQ(NS_OK, reopened.GetOfflineAttempt(actual.id, actual));
  EXPECT_EQ(Some(42u), actual.confirmedUid);
  EXPECT_EQ(Some(9u), actual.confirmedEpoch);
  EXPECT_TRUE(actual.transferAccepted);
  EXPECT_EQ(NS_OK, reopened.RecordOfflineCopyAcceptedWithoutUid(expected));
  EXPECT_EQ(NS_OK, reopened.ConfirmOfflineAttempt(
                       actual.id, Some(ServerUidConfirmation{9, 42})));
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            reopened.ConfirmOfflineAttempt(actual.id,
                                           Some(ServerUidConfirmation{9, 43})));
}

TEST_F(DeliveryCoreReferences, CopyAcceptanceKeepsOrderedActionsIndependent) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
  nsMsgKey source, targets[3];
  ASSERT_EQ(NS_OK, Add("ordered-source"_ns, {}, source));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(source, mFolderId, 7, 42));
  for (auto& key : targets) {
    ASSERT_EQ(NS_OK, Add("ordered-target"_ns, {}, key));
  }
  OfflineOperationData payload;
  payload.operation = nsIMsgOfflineImapOperation::kMsgCopy |
                      nsIMsgOfflineImapOperation::kMsgMoved;
  payload.copyDestinations = {"same"_ns, "same"_ns};
  payload.copyDestinationBindings = {
      Some(PendingDestination{mFolderId, targets[0], 7}),
      Some(PendingDestination{mFolderId, targets[1], 7})};
  payload.pendingDestination =
      Some(PendingDestination{mFolderId, targets[2], 7});
  payload.flagOperation = 0x80000000;
  payload.newFlags = UINT32_MAX;
  payload.keywordsToAdd = "preserved tail"_ns;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, payload));
  nsCString databaseSourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(databaseSourceId));
  ASSERT_EQ(NS_OK,
            db.QueueOfflineProtocolFlagMutation(
                databaseSourceId, mFolderId, source,
                ServerMessageLocation{mFolderId, source, 7, 42}, 1, true));
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, source, payload));
  uint64_t first, second, move, flags;
  ASSERT_EQ(NS_OK, db.BeginOfflineAction(
                       mFolderId, source, nsIMsgOfflineImapOperation::kMsgCopy,
                       payload.copyDestinationBindings[0], Some(0u), first));
  OfflineAttempt actual;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(first, actual));
  ASSERT_EQ(NS_OK, db.RecordOfflineCopyAcceptedWithoutUid(actual));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.BeginOfflineAction(
                mFolderId, source, nsIMsgOfflineImapOperation::kMsgCopy,
                payload.copyDestinationBindings[0], Some(0u), second));
  ASSERT_EQ(NS_OK, db.BeginOfflineAction(
                       mFolderId, source, nsIMsgOfflineImapOperation::kMsgCopy,
                       payload.copyDestinationBindings[1], Some(1u), second));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(second, actual));
  EXPECT_EQ(Some(1u), actual.copyOrdinal);
  EXPECT_EQ(targets[1], actual.destination->key);
  // A lost receipt on the second COPY stays fenced independently.
  ASSERT_EQ(NS_OK, db.MarkOfflineAttemptAmbiguous(second));
  ASSERT_EQ(NS_OK, db.BeginOfflineAction(
                       mFolderId, source, nsIMsgOfflineImapOperation::kMsgMoved,
                       payload.pendingDestination, Nothing(), move));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(move, actual));
  EXPECT_FALSE(actual.copyOrdinal);
  ASSERT_EQ(NS_OK, db.RecordOfflineCopyAcceptedWithoutUid(actual));
  // This records COPY effect only, never successful MOVE source STORE/delete.
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAction(mFolderId, source,
                                  nsIMsgOfflineImapOperation::kFlagsChanged,
                                  Nothing(), Nothing(), flags));
  OfflineAttempt flagAttempt;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(flags, flagAttempt));
  OfflineReplayCommandToken flagToken;
  ASSERT_EQ(NS_OK, db.BeginOfflineReplayCommand(
                       flagAttempt, OfflineReplayCommand::FlagSet, flagToken));
  ASSERT_EQ(NS_OK, db.RecordOfflineReplayCommand(
                       flagToken, OfflineReplayReceipt::Acknowledged, NS_OK));
  ASSERT_EQ(NS_OK, db.ConfirmOfflineAttempt(flags, Nothing()));
  OfflineOperationData retained;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, source, retained));
  EXPECT_EQ(payload.operation, retained.operation);
  EXPECT_EQ(payload.copyDestinations, retained.copyDestinations);
  EXPECT_EQ(payload.keywordsToAdd, retained.keywordsToAdd);
  EXPECT_EQ(payload.newFlags, retained.newFlags);
  ASSERT_EQ(2u, retained.copyDestinationBindings.Length());
  EXPECT_EQ(targets[1], retained.copyDestinationBindings[1]->key);
  EXPECT_EQ(targets[2], retained.pendingDestination->key);
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.RemoveOfflineOperation(mFolderId, source));
  OfflineAttempt lookup;
  ASSERT_EQ(NS_OK, db.GetOfflineAttemptForAction(
                       mFolderId, source, nsIMsgOfflineImapOperation::kMsgCopy,
                       Some(0u), lookup));
  EXPECT_EQ(first, lookup.id);
  ASSERT_EQ(NS_OK, db.GetOfflineAttemptForAction(
                       mFolderId, source, nsIMsgOfflineImapOperation::kMsgCopy,
                       Some(1u), lookup));
  EXPECT_EQ(second, lookup.id);
  EXPECT_EQ(OfflineAttemptState::Ambiguous, lookup.state);
}

TEST_F(DeliveryCoreReferences, CopyAcceptanceRequiresExactAttemptAndOrdinal) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey source, target;
  uint64_t folder;
  OfflineAttempt expected;
  ASSERT_EQ(NS_OK, QueuedCopy(source, folder, target, expected));
  auto& db = mCore->MessageDB();
  auto reject = [&](const OfflineAttempt& bad) {
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.RecordOfflineCopyAcceptedWithoutUid(bad));
    OfflineAttempt actual;
    ASSERT_EQ(NS_OK, db.GetOfflineAttempt(expected.id, actual));
    EXPECT_FALSE(actual.transferAccepted);
    EXPECT_EQ(OfflineAttemptState::Sent, actual.state);
  };
  OfflineAttempt bad = expected;
  bad.copyOrdinal = Some(1u);
  reject(bad);
  bad = expected;
  ++bad.operationId;
  reject(bad);
  bad = expected;
  ++bad.revision;
  reject(bad);
  bad = expected;
  ++bad.operationKey;
  reject(bad);
  bad = expected;
  ++bad.source->uid;
  reject(bad);
  bad = expected;
  ++bad.destination->key;
  reject(bad);
  bad = expected;
  ++bad.destination->epoch;
  reject(bad);
  bad = expected;
  bad.transferSourceId.Append('x');
  reject(bad);
  bad = expected;
  bad.transferBody->storeToken = Some(nsCString("0"_ns));
  reject(bad);
  bad = expected;
  ++bad.transferBody->locationRevision;
  reject(bad);
  uint64_t unchanged = 123;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.BeginOfflineAction(mFolderId, source,
                                  nsIMsgOfflineImapOperation::kMsgCopy,
                                  expected.destination, Nothing(), unchanged));
  EXPECT_EQ(123u, unchanged);
  ASSERT_EQ(NS_OK, db.RecordOfflineCopyAcceptedWithoutUid(expected));
}

TEST_F(DeliveryCoreReferences, CopyAcceptanceLocalFailureRetainsKnownEffect) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey source, target;
  uint64_t folder;
  OfflineAttempt expected;
  ASSERT_EQ(NS_OK, QueuedCopy(source, folder, target, expected));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(folder, 10));
  ASSERT_EQ(NS_OK, db.RecordOfflineCopyAcceptedWithoutUid(expected));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.ValidateOfflineCopyAcceptedWithoutUid(expected));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.ConfirmOfflineAttempt(expected.id,
                                     Some(ServerUidConfirmation{9, 42})));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(folder, 9));
  ASSERT_EQ(NS_OK, db.ValidateOfflineCopyAcceptedWithoutUid(expected));
  ASSERT_EQ(NS_OK, db.SetMessageStoreToken(target, "different-body"_ns));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.ValidateOfflineCopyAcceptedWithoutUid(expected));
  ASSERT_EQ(NS_OK, db.RecordOfflineCopyAcceptedWithoutUid(expected));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.ResolveOfflineAttemptNotApplied(expected.id));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.RemoveOfflineOperation(mFolderId, source));
  OfflineAttempt actual;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(expected.id, actual));
  EXPECT_TRUE(actual.transferAccepted);
  EXPECT_FALSE(actual.confirmedUid);
}

TEST_F(DeliveryCoreReferences, CopyAcceptanceWriteAndCommitErrorsKeepFence) {
  ASSERT_EQ(NS_OK, Start());
  for (bool commitFailure : {false, true}) {
    nsMsgKey source, target;
    uint64_t folder;
    OfflineAttempt expected;
    ASSERT_EQ(NS_OK, QueuedCopy(source, folder, target, expected));
    auto& db = mCore->MessageDB();
    if (commitFailure) {
      ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "PRAGMA foreign_keys=ON; CREATE TEMP TABLE "
                           "copy_ack_parent(id INTEGER PRIMARY KEY);"
                           "CREATE TEMP TABLE copy_ack_child(id INTEGER "
                           "REFERENCES copy_ack_parent(id) "
                           "DEFERRABLE INITIALLY DEFERRED)"_ns));
    }
    RefPtr<FaultWitness> witness = new FaultWitness();
    ASSERT_EQ(NS_OK,
              mConnection->CreateFunction("copy_ack_fault"_ns, 1, witness));
    nsAutoCString sql(
        "CREATE TEMP TRIGGER reject_copy_ack AFTER UPDATE OF transferAccepted "
        "ON main.offline_attempts WHEN NEW.transferAccepted=1 BEGIN "
        "SELECT copy_ack_fault(NEW.id); ");
    sql.Append(commitFailure ? "INSERT INTO copy_ack_child VALUES(NEW.id); END"
                             : "SELECT RAISE(ABORT,'copy ack'); END");
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    auto cleanup = MakeScopeExit([&] {
      EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "DROP TRIGGER IF EXISTS reject_copy_ack"_ns));
      EXPECT_EQ(NS_OK, mConnection->RemoveFunction("copy_ack_fault"_ns));
    });
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
              db.RecordOfflineCopyAcceptedWithoutUid(expected));
    EXPECT_EQ(1u, witness->mCalls);
    bool active;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    OfflineAttempt actual;
    ASSERT_EQ(NS_OK, db.GetOfflineAttempt(expected.id, actual));
    EXPECT_FALSE(actual.transferAccepted);
    EXPECT_EQ(OfflineAttemptState::Sent, actual.state);
    EXPECT_EQ(NS_ERROR_IN_PROGRESS,
              db.RemoveOfflineOperation(mFolderId, source));
    ASSERT_EQ(NS_OK,
              mConnection->ExecuteSimpleSQL("DROP TRIGGER reject_copy_ack"_ns));
    ASSERT_EQ(NS_OK, db.RecordOfflineCopyAcceptedWithoutUid(expected));
  }
}

TEST_F(DeliveryCoreReferences,
       UnobservedCopyEpochRequiresActualFirstObservation) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey source, target;
  uint64_t folder;
  OfflineAttempt expected;
  ASSERT_EQ(NS_OK, QueuedCopy(source, folder, target, expected, true));
  auto& db = mCore->MessageDB();
  ASSERT_TRUE(expected.destination);
  EXPECT_FALSE(expected.destination->epochKnown);
  uint32_t untouched = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->FolderDB().GetFolderUidValidity(folder, untouched));
  EXPECT_EQ(123u, untouched);
  ASSERT_EQ(NS_OK, db.RecordOfflineCopyAcceptedWithoutUid(expected));
  ASSERT_EQ(NS_OK, db.ValidateOfflineCopyAcceptedWithoutUid(expected));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->MessageDB();
  OfflineOperationData payload;
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperation(mFolderId, source, payload));
  ASSERT_TRUE(payload.copyDestinationBindings[0]);
  EXPECT_FALSE(payload.copyDestinationBindings[0]->epochKnown);
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            reopened.ConfirmOfflineAttempt(expected.id, Nothing()));
  // Known epoch zero is valid actual evidence and distinct from absence.
  ASSERT_EQ(NS_OK, reopened.ConfirmOfflineAttempt(
                       expected.id, Some(ServerUidConfirmation{0, 42})));
  ASSERT_EQ(NS_OK, mCore->FolderDB().GetFolderUidValidity(folder, untouched));
  EXPECT_EQ(0u, untouched);
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperation(mFolderId, source, payload));
  EXPECT_TRUE(payload.copyDestinationBindings[0]->epochKnown);
  EXPECT_EQ(0u, payload.copyDestinationBindings[0]->epoch);
  ASSERT_EQ(NS_OK, reopened.GetOfflineAttempt(expected.id, expected));
  EXPECT_FALSE(expected.destination->epochKnown);
  EXPECT_EQ(Some(0u), expected.confirmedEpoch);
  EXPECT_EQ(Some(42u), expected.confirmedUid);
  EXPECT_EQ(NS_OK, reopened.ConfirmOfflineAttempt(
                       expected.id, Some(ServerUidConfirmation{0, 42})));
}

TEST_F(DeliveryCoreReferences,
       FirstDestinationEpochObservationGuardsQueuedIdentity) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey source, target;
  uint64_t folder;
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, QueuedCopy(source, folder, target, attempt, true));
  auto& db = mCore->MessageDB();
  QueuedSourceIdentity expected;
  ASSERT_EQ(NS_OK, db.GetQueuedSourceIdentity(mFolderId, source, expected));
  auto bad = expected;
  ++bad.revision;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.ObserveOfflineDestinationEpoch(bad, attempt.operation, Some(0u),
                                              *attempt.destination, 9));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.ObserveOfflineDestinationEpoch(
                                        expected, attempt.operation, Some(1u),
                                        *attempt.destination, 9));
  ASSERT_EQ(NS_OK, db.ObserveOfflineDestinationEpoch(
                       expected, attempt.operation, Some(0u),
                       *attempt.destination, 9));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.ObserveOfflineDestinationEpoch(
                                        expected, attempt.operation, Some(0u),
                                        *attempt.destination, 10));
  OfflineOperationData payload;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, source, payload));
  EXPECT_EQ(9u, payload.copyDestinationBindings[0]->epoch);
  EXPECT_TRUE(payload.copyDestinationBindings[0]->epochKnown);
  EXPECT_EQ(NS_OK, db.RecordOfflineCopyAcceptedWithoutUid(attempt));
  EXPECT_EQ(NS_OK, db.ValidateOfflineCopyAcceptedWithoutUid(attempt));
}

TEST_F(DeliveryCoreReferences,
       CopyAttemptSchemaPreservesLegacyAndTypedAbsence) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey source, target;
  uint64_t folder;
  OfflineAttempt expected;
  ASSERT_EQ(NS_OK, QueuedCopy(source, folder, target, expected));
  auto& db = mCore->MessageDB();
  for (const char* invalid :
       {"transferSourceId=NULL", "transferSourceId=''",
        "transferOperationKey=0", "copyOrdinal=NULL", "copyOrdinal=-1",
        "transferContentRevision=NULL", "transferLocationRevision='bad'",
        "transferMessageSize=-1", "transferFlags=-1",
        "transferAccepted=1,state=0", "confirmedUid=42"}) {
    ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
    nsAutoCString sql("UPDATE offline_attempts SET ");
    sql.Append(invalid);
    sql.AppendLiteral(" WHERE id=");
    sql.AppendInt(expected.id);
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    OfflineAttempt unchanged;
    unchanged.id = 123;
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
              db.GetOfflineAttempt(expected.id, unchanged));
    EXPECT_EQ(123u, unchanged.id);
    ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  }
  Stop();
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  for (const char* column :
       {"confirmedEpoch", "transferFlags", "transferLineCount",
        "transferOfflineSize", "transferMessageSize", "transferStoreToken",
        "transferLocationRevision", "transferContentRevision",
        "transferAccepted", "copyOrdinal", "transferOperationKey",
        "transferSourceId"}) {
    nsAutoCString sql("ALTER TABLE offline_attempts DROP COLUMN ");
    sql.Append(column);
    ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL(sql));
  }
  ASSERT_EQ(NS_OK, RemoveReplayColumns(old));
  ASSERT_EQ(NS_OK, old->SetSchemaVersion(17));
  ASSERT_EQ(NS_OK, old->Close());
  old = nullptr;
  ASSERT_EQ(NS_OK, Start());
  OfflineAttempt legacy;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetOfflineAttempt(expected.id, legacy));
  EXPECT_EQ(expected.operationId, legacy.operationId);
  EXPECT_EQ(expected.revision, legacy.revision);
  EXPECT_EQ(OfflineAttemptState::Sent, legacy.state);
  EXPECT_TRUE(legacy.transferSourceId.IsEmpty());
  EXPECT_FALSE(legacy.copyOrdinal);
  EXPECT_FALSE(legacy.transferBody);
  EXPECT_FALSE(legacy.transferAccepted);
  uint64_t unchanged = 123;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, mCore->MessageDB().BeginOfflineAction(
                                      mFolderId, source, legacy.operation,
                                      legacy.destination, Some(0u), unchanged));
  EXPECT_EQ(123u, unchanged);
}

TEST_F(DeliveryCoreReferences, AppendAcceptanceLocalFailureKeepsKnownEffect) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  MessageBodyState body;
  OfflineAttempt expected;
  ASSERT_EQ(NS_OK, QueuedAppend(key, body, expected));
  auto& db = mCore->MessageDB();
  // The actual tagged receipt must survive a local epoch change before ACK.
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 8));
  ASSERT_EQ(NS_OK, db.RecordOfflineAppendAcceptedWithoutUid(expected));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.ValidateOfflineAppendAcceptedWithoutUid(expected));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
  ASSERT_EQ(NS_OK, db.ValidateOfflineAppendAcceptedWithoutUid(expected));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "CREATE TEMP VIEW offline_operations AS SELECT * FROM "
                       "main.offline_operations "
                       "WHERE abs(-9223372036854775808)"_ns));
  OfflineOperationData op;
  nsresult original = db.GetOfflineOperation(mFolderId, key, op);
  ASSERT_TRUE(NS_FAILED(original));
  EXPECT_EQ(original, db.ValidateOfflineAppendAcceptedWithoutUid(expected));
  ASSERT_EQ(NS_OK, db.RecordOfflineAppendAcceptedWithoutUid(expected));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.offline_operations"_ns));
  // Ordinary read flags are not body identity; physical content changes are.
  ASSERT_EQ(NS_OK,
            db.SetMessageFlags(key, body.flags | nsMsgMessageFlags::Read));
  ASSERT_EQ(NS_OK, db.ValidateOfflineAppendAcceptedWithoutUid(expected));
  ASSERT_EQ(NS_OK, db.SetMessageStoreToken(key, "changed-body"_ns));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.ValidateOfflineAppendAcceptedWithoutUid(expected));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.ConfirmOfflineAttempt(expected.id,
                                     Some(ServerUidConfirmation{7, 42})));
  ASSERT_EQ(NS_OK, db.RecordOfflineAppendAcceptedWithoutUid(expected));
  OfflineAttempt actual;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(expected.id, actual));
  EXPECT_TRUE(actual.appendAccepted);
  EXPECT_EQ(OfflineAttemptState::Sent, actual.state);
  EXPECT_FALSE(actual.confirmedUid);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.ResolveOfflineAttemptNotApplied(actual.id));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.RemoveOfflineOperation(mFolderId, key));
  bool active = true;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, body));
  EXPECT_EQ(Some(nsCString("changed-body"_ns)), body.storeToken);
}

TEST_F(DeliveryCoreReferences, AppendAcceptanceWriteAndCommitErrorsKeepFence) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  for (bool commitFailure : {false, true}) {
    nsMsgKey key;
    MessageBodyState body;
    OfflineAttempt expected;
    ASSERT_EQ(NS_OK, QueuedAppend(key, body, expected));
    if (commitFailure) {
      ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "PRAGMA foreign_keys=ON; CREATE TEMP TABLE "
                           "ack_parent(id INTEGER PRIMARY KEY);"
                           "CREATE TEMP TABLE ack_child(id INTEGER REFERENCES "
                           "ack_parent(id) "
                           "DEFERRABLE INITIALLY DEFERRED)"_ns));
    }
    RefPtr<FaultWitness> witness = new FaultWitness();
    ASSERT_EQ(NS_OK,
              mConnection->CreateFunction("append_ack_fault"_ns, 1, witness));
    nsAutoCString sql(
        "CREATE TEMP TRIGGER reject_append_ack AFTER UPDATE OF appendAccepted "
        "ON main.offline_attempts WHEN NEW.appendAccepted=1 BEGIN "
        "SELECT append_ack_fault(NEW.id); ");
    sql.Append(commitFailure ? "INSERT INTO ack_child VALUES(NEW.id); END"
                             : "SELECT RAISE(ABORT,'ack write'); END");
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    auto cleanup = MakeScopeExit([&] {
      EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "DROP TRIGGER IF EXISTS reject_append_ack"_ns));
      EXPECT_EQ(NS_OK, mConnection->RemoveFunction("append_ack_fault"_ns));
    });
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
              db.RecordOfflineAppendAcceptedWithoutUid(expected));
    EXPECT_EQ(1u, witness->mCalls);
    EXPECT_EQ(int64_t(expected.id), witness->mLastKey);
    bool active = true;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    OfflineAttempt actual;
    ASSERT_EQ(NS_OK, db.GetOfflineAttempt(expected.id, actual));
    EXPECT_FALSE(actual.appendAccepted);
    EXPECT_EQ(OfflineAttemptState::Sent, actual.state);
    EXPECT_FALSE(actual.confirmedUid);
    EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.RemoveOfflineOperation(mFolderId, key));
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER reject_append_ack"_ns));
    ASSERT_EQ(NS_OK, db.RecordOfflineAppendAcceptedWithoutUid(expected));
    ASSERT_EQ(NS_OK, db.ValidateOfflineAppendAcceptedWithoutUid(expected));
  }
}

TEST_F(DeliveryCoreReferences, AppendAcceptanceRejectsForeignAttemptAndBody) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  MessageBodyState body;
  OfflineAttempt expected;
  ASSERT_EQ(NS_OK, QueuedAppend(key, body, expected));
  auto& db = mCore->MessageDB();
  for (uint32_t field = 0; field < 6; ++field) {
    OfflineAttempt changed = expected;
    switch (field) {
      case 0:
        ++changed.operationId;
        break;
      case 1:
        ++changed.revision;
        break;
      case 2:
        changed.operation = nsIMsgOfflineImapOperation::kAppendTemplate;
        break;
      case 3:
        ++changed.destination->key;
        break;
      case 4:
        changed.appendBody->storeToken.reset();
        break;
      case 5:
        changed.appendBody->databaseSourceId.AssignLiteral("foreign");
        break;
    }
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.RecordOfflineAppendAcceptedWithoutUid(changed));
  }
  OfflineAttempt invalid;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.RecordOfflineAppendAcceptedWithoutUid(invalid));
  nsCString source = body.databaseSourceId;
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "UPDATE database_identity SET sourceId='foreign'"_ns));
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            db.RecordOfflineAppendAcceptedWithoutUid(expected));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "UPDATE database_identity SET sourceId='{00000000-0000-4000-8000-000000000001}'"_ns));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.RecordOfflineAppendAcceptedWithoutUid(expected));
  nsCOMPtr<mozIStorageStatement> restore;
  ASSERT_EQ(NS_OK, mConnection->CreateStatement(
                       "UPDATE database_identity SET sourceId=:source"_ns,
                       getter_AddRefs(restore)));
  ASSERT_EQ(NS_OK, restore->BindUTF8StringByName("source"_ns, source));
  ASSERT_EQ(NS_OK, restore->Execute());
  restore = nullptr;
  ASSERT_EQ(NS_OK, db.RecordOfflineAppendAcceptedWithoutUid(expected));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.ValidateOfflineAppendAcceptedWithoutUid(expected));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.RecordOfflineAppendAcceptedWithoutUid(expected));
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  // Begin must compare the actual current body, leaving output unchanged.
  nsMsgKey second;
  MessageBodyState other;
  OfflineAttempt noBody;
  ASSERT_EQ(NS_OK, QueuedAppend(second, other, noBody, false));
  ASSERT_EQ(NS_OK, db.ResolveOfflineAttemptNotApplied(noBody.id));
  ++other.locationRevision;
  uint64_t untouched = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineAttempt(mFolderId, second, noBody.operation,
                                   noBody.destination, untouched, &other));
  EXPECT_EQ(123u, untouched);
  other.key = key;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.BeginOfflineAttempt(mFolderId, second, noBody.operation,
                                   noBody.destination, untouched, &other));
  EXPECT_EQ(123u, untouched);
}

TEST_F(DeliveryCoreReferences,
       AppendAcceptanceRequiresActualQueuedAcknowledgement) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  MessageBodyState body;
  OfflineAttempt expected;
  ASSERT_EQ(NS_OK, QueuedAppend(key, body, expected, false));
  EXPECT_FALSE(expected.appendBody);
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.RecordOfflineAppendAcceptedWithoutUid(expected));
  ASSERT_EQ(NS_OK, db.ResolveOfflineAttemptNotApplied(expected.id));
  uint64_t id;
  ASSERT_EQ(NS_OK, db.BeginOfflineAttempt(mFolderId, key, expected.operation,
                                          expected.destination, id, &body));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(id, expected));
  ASSERT_EQ(NS_OK, db.ResolveOfflineAttemptNotApplied(id));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.RecordOfflineAppendAcceptedWithoutUid(expected));
  ASSERT_EQ(NS_OK, db.BeginOfflineAttempt(mFolderId, key, expected.operation,
                                          expected.destination, id, &body));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(id, expected));
  ASSERT_EQ(NS_OK, db.MarkOfflineAttemptAmbiguous(id));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.ValidateOfflineAppendAcceptedWithoutUid(expected));
  // A late actual tagged OK resolves uncertainty to known acceptance, never
  // UID.
  ASSERT_EQ(NS_OK, db.RecordOfflineAppendAcceptedWithoutUid(expected));
  ASSERT_EQ(NS_OK, db.ValidateOfflineAppendAcceptedWithoutUid(expected));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.MarkOfflineAttemptAmbiguous(id));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.ResolveOfflineAttemptNotApplied(id));
}

TEST_F(DeliveryCoreReferences,
       AppendAcceptanceSchemaPreservesLegacyAndPresence) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  MessageBodyState body;
  OfflineAttempt expected;
  ASSERT_EQ(NS_OK, QueuedAppend(key, body, expected, false));
  Stop();
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  for (const char* column : {"confirmedEpoch",
                             "transferFlags",
                             "transferLineCount",
                             "transferOfflineSize",
                             "transferMessageSize",
                             "transferStoreToken",
                             "transferLocationRevision",
                             "transferContentRevision",
                             "transferAccepted",
                             "copyOrdinal",
                             "transferOperationKey",
                             "transferSourceId",
                             "appendFlags",
                             "appendLineCount",
                             "appendOfflineSize",
                             "appendMessageSize",
                             "appendStoreToken",
                             "appendLocationRevision",
                             "appendContentRevision",
                             "appendSourceId",
                             "appendAccepted"}) {
    nsAutoCString sql("ALTER TABLE offline_attempts DROP COLUMN ");
    sql.Append(column);
    ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL(sql));
  }
  ASSERT_EQ(NS_OK, RemoveReplayColumns(old));
  ASSERT_EQ(NS_OK, old->SetSchemaVersion(16));
  ASSERT_EQ(NS_OK, old->Close());
  old = nullptr;
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  OfflineAttempt actual;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(expected.id, actual));
  EXPECT_EQ(expected.operationId, actual.operationId);
  EXPECT_EQ(expected.revision, actual.revision);
  EXPECT_EQ(OfflineAttemptState::Sent, actual.state);
  EXPECT_FALSE(actual.appendAccepted);
  EXPECT_FALSE(actual.appendBody);
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.RecordOfflineAppendAcceptedWithoutUid(actual));
  ASSERT_EQ(NS_OK, db.ResolveOfflineAttemptNotApplied(actual.id));
  uint64_t id;
  ASSERT_EQ(NS_OK, db.BeginOfflineAttempt(mFolderId, key, actual.operation,
                                          actual.destination, id, &body));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(id, actual));
  ASSERT_TRUE(actual.appendBody);
  EXPECT_EQ(Some(nsCString("0"_ns)), actual.appendBody->storeToken);
  OfflineAttempt captured = actual;
  // NULL is an absent captured token, never the valid token "0".
  nsAutoCString sql(
      "UPDATE offline_attempts SET appendStoreToken=NULL WHERE id=");
  sql.AppendInt(id);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(id, actual));
  ASSERT_TRUE(actual.appendBody);
  EXPECT_FALSE(actual.appendBody->storeToken);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.RecordOfflineAppendAcceptedWithoutUid(captured));
  for (const char* invalid :
       {"appendContentRevision=NULL", "appendLocationRevision='invalid'",
        "appendMessageSize=-1", "appendFlags=0", "appendSourceId=NULL",
        "appendAccepted=1,state=0", "appendAccepted=1,state=3",
        "confirmedUid=42"}) {
    ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
    nsAutoCString corrupt("UPDATE offline_attempts SET ");
    corrupt.Append(invalid);
    corrupt.AppendLiteral(" WHERE id=");
    corrupt.AppendInt(id);
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(corrupt));
    OfflineAttempt untouched;
    untouched.id = 123;
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, db.GetOfflineAttempt(id, untouched));
    EXPECT_EQ(123u, untouched.id);
    ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  }
}

TEST_F(DeliveryCoreReferences,
       AppendAttemptRetainsDestinationIdentityAcrossReopen) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 17));
  RawHdr raw;
  raw.messageId = "append@invalid"_ns;
  raw.storeToken = Some(nsCString("finished-destination-body"_ns));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, mCore->MessageDB().StageMessage(mFolderId, raw, &key));
  OfflineOperationData payload;
  payload.operation = 0x10;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().StoreOfflineOperation(mFolderId, key, payload));
  uint64_t attemptId = 99;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().BeginOfflineAttempt(
                mFolderId, key, 0x10,
                Some(PendingDestination{mFolderId, key, 17}), attemptId));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, mCore->MessageDB().AbortMessage(key));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, db.GetCurrentOfflineAttempt(mFolderId, key, attempt));
  EXPECT_EQ(attemptId, attempt.id);
  EXPECT_EQ(OfflineAttemptState::Sent, attempt.state);
  OfflineAttempt unchanged;
  unchanged.id = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.GetOfflineAttempt(INT64_MAX, unchanged));
  EXPECT_EQ(123u, unchanged.id);
  EXPECT_FALSE(attempt.source);
  ASSERT_TRUE(attempt.destination);
  EXPECT_EQ(key, attempt.destination->key);
  EXPECT_EQ(mFolderId, attempt.destination->folderId);
  EXPECT_EQ(17u, attempt.destination->epoch);
  ASSERT_EQ(NS_OK, db.MarkOfflineAttemptAmbiguous(attemptId));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& recovered = mCore->MessageDB();
  ASSERT_EQ(NS_OK, recovered.GetCurrentOfflineAttempt(mFolderId, key, attempt));
  EXPECT_EQ(attemptId, attempt.id);
  EXPECT_EQ(OfflineAttemptState::Ambiguous, attempt.state);
  EXPECT_EQ(0x10u, attempt.operation);
  ASSERT_EQ(NS_OK,
            recovered.SetOfflineOperationPlayingBack(mFolderId, key, true));
  ASSERT_EQ(NS_OK, recovered.GetCurrentOfflineAttempt(mFolderId, key, attempt));
  EXPECT_EQ(OfflineAttemptState::Ambiguous, attempt.state);
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            recovered.StoreOfflineOperation(mFolderId, key, payload));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            recovered.RemoveOfflineOperation(mFolderId, key));
  ASSERT_EQ(NS_OK, recovered.ConfirmOfflineAttempt(
                       attemptId, Some(ServerUidConfirmation{17, UINT32_MAX})));
  ASSERT_EQ(NS_OK, recovered.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Confirmed, attempt.state);
  EXPECT_EQ(Some(uint32_t(UINT32_MAX)), attempt.confirmedUid);
  bool exists = true;
  ASSERT_EQ(NS_OK, recovered.MessageExists(key, exists));
  EXPECT_FALSE(exists);
  ASSERT_EQ(NS_OK, recovered.PublishMessage(key, true));
  nsMsgKey found = nsMsgKey_None;
  ASSERT_EQ(NS_OK, recovered.GetMessageKeyForServerUid(mFolderId, 17,
                                                       UINT32_MAX, found));
  EXPECT_EQ(key, found);
  ASSERT_EQ(NS_OK, recovered.ConfirmOfflineAttempt(
                       attemptId, Some(ServerUidConfirmation{17, UINT32_MAX})));
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            recovered.ConfirmOfflineAttempt(
                attemptId, Some(ServerUidConfirmation{17, 42})));
}

TEST_F(DeliveryCoreReferences, StaleAttemptNeedsExplicitResolutionBeforeRetry) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 27));
  RawHdr raw;
  raw.messageId = "stale-append@invalid"_ns;
  raw.storeToken = Some(nsCString("retained-body"_ns));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &key));
  OfflineOperationData payload;
  payload.operation = 0x10;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  uint64_t attemptId;
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(mFolderId, key, 0x10,
                                   Some(PendingDestination{mFolderId, key, 27}),
                                   attemptId));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 28));
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      db.ConfirmOfflineAttempt(attemptId, Some(ServerUidConfirmation{27, 42})));
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Sent, attempt.state);
  uint64_t untouched = 123;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.BeginOfflineAttempt(mFolderId, key, 0x10,
                                   Some(PendingDestination{mFolderId, key, 28}),
                                   untouched));
  EXPECT_EQ(123u, untouched);
  // No network is dispatched in this fixture: the operation had no server
  // effect.
  ASSERT_EQ(NS_OK, db.ResolveOfflineAttemptNotApplied(attemptId));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Pending, attempt.state);
  ASSERT_EQ(NS_OK, db.AbortMessage(key));
}

TEST_F(DeliveryCoreReferences, ConflictingConfirmationDoesNotBindDestination) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 31));
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("bound-control@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(control, mFolderId, 31, 55));
  RawHdr raw;
  raw.messageId = "pending-destination@invalid"_ns;
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &key));
  OfflineOperationData payload;
  payload.operation = 0x10;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  uint64_t attemptId;
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(mFolderId, key, 0x10,
                                   Some(PendingDestination{mFolderId, key, 31}),
                                   attemptId));
  EXPECT_EQ(
      NS_ERROR_FILE_CORRUPTED,
      db.ConfirmOfflineAttempt(attemptId, Some(ServerUidConfirmation{31, 55})));
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(key, names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Sent, attempt.state);
  nsMsgKey found = nsMsgKey_None;
  ASSERT_EQ(NS_OK, db.GetMessageKeyForServerUid(mFolderId, 31, 55, found));
  EXPECT_EQ(control, found);
}

TEST_F(DeliveryCoreReferences, ConfirmationStorageFailureRollsBackUidAndState) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 41));
  RawHdr raw;
  raw.messageId = "confirm-error@invalid"_ns;
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &key));
  OfflineOperationData payload;
  payload.operation = 0x10;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  uint64_t attemptId;
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(mFolderId, key, 0x10,
                                   Some(PendingDestination{mFolderId, key, 41}),
                                   attemptId));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_confirmation BEFORE UPDATE ON "
          "offline_attempts "
          "WHEN NEW.state = 2 BEGIN SELECT RAISE(ABORT, 'confirmation failure'); END"_ns));
  EXPECT_TRUE(NS_FAILED(db.ConfirmOfflineAttempt(
      attemptId, Some(ServerUidConfirmation{41, 42}))));
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(key, names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Sent, attempt.state);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER reject_confirmation"_ns));
  ASSERT_EQ(NS_OK, db.ConfirmOfflineAttempt(
                       attemptId, Some(ServerUidConfirmation{41, 42})));
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(key, names));
  EXPECT_TRUE(names.Contains("uidOnServer"_ns));
}

TEST_F(DeliveryCoreReferences, FolderWideOperationHasNoInventedMessageBinding) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 51));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.ReserveOfflineOperationKey(mFolderId, key));
  OfflineOperationData payload;
  payload.operation = 0x200;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  bool exists = true;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_FALSE(exists);
  uint64_t attemptId;
  ASSERT_EQ(NS_OK, db.BeginOfflineAttempt(mFolderId, key, 0x200, Nothing(),
                                          attemptId));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetCurrentOfflineAttempt(mFolderId, key,
                                                               attempt));
  EXPECT_EQ(attemptId, attempt.id);
  EXPECT_FALSE(attempt.source);
  EXPECT_FALSE(attempt.destination);
  EXPECT_EQ(Some(uint32_t(51)), attempt.folderEpoch);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().ConfirmOfflineAttempt(attemptId, Nothing()));
  nsMsgKey next;
  ASSERT_EQ(NS_OK, Add("next@invalid"_ns, {}, next));
  EXPECT_GT(next, key);
}

TEST_F(DeliveryCoreReferences, DeletedSourceRetainsExactDispatchedTuple) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 61));
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, Add("deleted-source@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, Add("survivor@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 61, 700));
  nsCString databaseSourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(databaseSourceId));
  ASSERT_EQ(NS_OK,
            db.QueueOfflineProtocolFlagMutation(
                databaseSourceId, mFolderId, key,
                ServerMessageLocation{mFolderId, key, 61, 700}, 128, true));
  OfflineOperationData payload;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, key, payload));
  ASSERT_EQ(NS_OK, db.RemoveMessage(key));
  uint64_t attemptId;
  ASSERT_EQ(NS_OK, db.BeginOfflineAction(mFolderId, key, 1, Nothing(),
                                         Nothing(), attemptId));
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  ASSERT_TRUE(attempt.source);
  EXPECT_EQ(mFolderId, attempt.source->folderId);
  EXPECT_EQ(key, attempt.source->key);
  EXPECT_EQ(61u, attempt.source->epoch);
  EXPECT_EQ(700u, attempt.source->uid);
  EXPECT_EQ(1u, attempt.operation);
  EXPECT_NE(key, attempt.source->uid);
  OfflineReplayCommandToken token;
  ASSERT_EQ(NS_OK, db.BeginOfflineReplayCommand(
                       attempt, OfflineReplayCommand::FlagSet, token));
  ASSERT_EQ(NS_OK, db.RecordOfflineReplayCommand(
                       token, OfflineReplayReceipt::Acknowledged, NS_OK));
  ASSERT_EQ(NS_OK, db.ConfirmOfflineAttempt(attemptId, Nothing()));
  ASSERT_EQ(NS_OK, db.RemoveOfflineOperation(mFolderId, key));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Confirmed, attempt.state);
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_FALSE(exists);
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreReferences, QueuedFolderWideOperationRejectsChangedEpoch) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 71));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.ReserveOfflineOperationKey(mFolderId, key));
  OfflineOperationData payload;
  payload.operation = 0x200;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 72));
  // Saving other payload metadata does not retarget an existing deletion
  // intent.
  payload.keywordsToAdd = "retained metadata"_ns;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  uint64_t attemptId = 123;
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      db.BeginOfflineAttempt(mFolderId, key, 0x200, Nothing(), attemptId));
  EXPECT_EQ(123u, attemptId);
  OfflineOperationData stored;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, key, stored));
  EXPECT_EQ(0x200u, stored.operation);
  EXPECT_EQ("retained metadata"_ns, stored.keywordsToAdd);
}

TEST_F(DeliveryCoreReferences, QueuedSourceIsNotSilentlyRetargeted) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 81));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("queued-source@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 81, 42));
  nsCString databaseSourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(databaseSourceId));
  ASSERT_EQ(NS_OK,
            db.QueueOfflineProtocolFlagMutation(
                databaseSourceId, mFolderId, key,
                ServerMessageLocation{mFolderId, key, 81, 42}, 128, true));
  OfflineOperationData payload;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, key, payload));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 81, 43));
  payload.keywordsToAdd = "another edit"_ns;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  uint64_t attemptId = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineAction(mFolderId, key, 1, Nothing(), Nothing(),
                                  attemptId));
  EXPECT_EQ(123u, attemptId);
  nsMsgKey found = nsMsgKey_None;
  ASSERT_EQ(NS_OK, db.GetMessageKeyForServerUid(mFolderId, 81, 43, found));
  EXPECT_EQ(key, found);
}

TEST_F(DeliveryCoreReferences, SentAttemptDestinationCannotBeReused) {
  CheckUsedDestinationRejected(OfflineAttemptState::Sent);
}

TEST_F(DeliveryCoreReferences, AmbiguousAttemptDestinationCannotBeReused) {
  CheckUsedDestinationRejected(OfflineAttemptState::Ambiguous);
}

TEST_F(DeliveryCoreReferences, ConfirmedAttemptDestinationCannotBeReused) {
  CheckUsedDestinationRejected(OfflineAttemptState::Confirmed);
}

TEST_F(DeliveryCoreReferences, CopyRequiresDistinctDestinationIdentity) {
  CheckSelfDestinationRejected(4);
}

TEST_F(DeliveryCoreReferences, MoveRequiresDistinctDestinationIdentity) {
  CheckSelfDestinationRejected(2);
}

TEST_F(DeliveryCoreReferences, BoundDestinationCannotStartAnotherAttempt) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 93));
  RawHdr raw;
  raw.messageId = "bound-destination@invalid"_ns;
  nsMsgKey bound, fresh;
  RefPtr<Message> header;
  ASSERT_EQ(NS_OK,
            db.StageMessage(mFolderId, raw, &bound, getter_AddRefs(header)));
  ASSERT_EQ(NS_OK, header->SetUint32Property("uidOnServer", 42));
  raw.messageId = "unbound-destination@invalid"_ns;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &fresh));
  OfflineOperationData payload;
  payload.operation = 0x10;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, fresh, payload));
  uint64_t output = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineAttempt(
                mFolderId, fresh, 0x10,
                Some(PendingDestination{mFolderId, bound, 93}), output));
  EXPECT_EQ(123u, output);
  ASSERT_EQ(NS_OK, db.BeginOfflineAttempt(
                       mFolderId, fresh, 0x10,
                       Some(PendingDestination{mFolderId, fresh, 93}), output));
  uint32_t uid = 77;
  ASSERT_EQ(NS_OK, header->GetUint32Property("uidOnServer", &uid));
  EXPECT_EQ(42u, uid);
}

TEST_F(DeliveryCoreReferences, NotAppliedDestinationAllowsExplicitRetry) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 94));
  RawHdr raw;
  raw.messageId = "not-applied@invalid"_ns;
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &key));
  OfflineOperationData payload;
  payload.operation = 0x10;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  uint64_t first, retry;
  auto destination = Some(PendingDestination{mFolderId, key, 94});
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(mFolderId, key, 0x10, destination, first));
  // This fixture dispatched no network operation.
  ASSERT_EQ(NS_OK, db.ResolveOfflineAttemptNotApplied(first));
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(mFolderId, key, 0x10, destination, retry));
  EXPECT_NE(first, retry);
  OfflineAttempt old;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(first, old));
  EXPECT_EQ(OfflineAttemptState::Pending, old.state);
}

TEST_F(DeliveryCoreReferences,
       PublishedBindingCannotCollideWithConfirmedStaging) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 95));
  RawHdr raw;
  raw.messageId = "confirmed-staging@invalid"_ns;
  nsMsgKey staged, control;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  ASSERT_EQ(NS_OK, Add("published-control@invalid"_ns, {}, control));
  OfflineOperationData payload;
  payload.operation = 0x10;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, staged, payload));
  uint64_t attemptId;
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(
                mFolderId, staged, 0x10,
                Some(PendingDestination{mFolderId, staged, 95}), attemptId));
  ASSERT_EQ(NS_OK, db.ConfirmOfflineAttempt(
                       attemptId, Some(ServerUidConfirmation{95, 55})));
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            db.BindMessageToServerUid(control, mFolderId, 95, 55));
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(control, names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(control, mFolderId, 95, 56));
  ASSERT_EQ(NS_OK, db.PublishMessage(staged, true));
  nsMsgKey found = nsMsgKey_None;
  ASSERT_EQ(NS_OK, db.GetMessageKeyForServerUid(mFolderId, 95, 55, found));
  EXPECT_EQ(staged, found);
  ASSERT_EQ(NS_OK, db.GetMessageKeyForServerUid(mFolderId, 95, 56, found));
  EXPECT_EQ(control, found);
}

TEST_F(DeliveryCoreReferences, ConfirmationDoesNotOverwriteDestinationUid) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 96));
  RawHdr raw;
  raw.messageId = "no-overwrite@invalid"_ns;
  nsMsgKey key;
  RefPtr<Message> header;
  ASSERT_EQ(NS_OK,
            db.StageMessage(mFolderId, raw, &key, getter_AddRefs(header)));
  OfflineOperationData payload;
  payload.operation = 0x10;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  uint64_t attemptId;
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(mFolderId, key, 0x10,
                                   Some(PendingDestination{mFolderId, key, 96}),
                                   attemptId));
  ASSERT_EQ(NS_OK, header->SetStringProperty("uidOnServer", "0002a"_ns));
  EXPECT_EQ(
      NS_ERROR_FILE_CORRUPTED,
      db.ConfirmOfflineAttempt(attemptId, Some(ServerUidConfirmation{96, 43})));
  uint32_t uid = 77;
  ASSERT_EQ(NS_OK, header->GetUint32Property("uidOnServer", &uid));
  EXPECT_EQ(42u, uid);
  nsCString text;
  ASSERT_EQ(NS_OK, header->GetStringProperty("uidOnServer", text));
  EXPECT_EQ("0002a"_ns, text);
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Sent, attempt.state);
  EXPECT_FALSE(attempt.confirmedUid);
  ASSERT_EQ(NS_OK, db.ConfirmOfflineAttempt(
                       attemptId, Some(ServerUidConfirmation{96, 42})));
  ASSERT_EQ(NS_OK, header->GetStringProperty("uidOnServer", text));
  EXPECT_EQ("0002a"_ns, text);
}

TEST_F(DeliveryCoreReferences, ConfirmationRequiresServerReportedEpoch) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 97));
  RawHdr raw;
  raw.messageId = "server-epoch@invalid"_ns;
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &key));
  OfflineOperationData payload;
  payload.operation = 0x10;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  uint64_t attemptId;
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(mFolderId, key, 0x10,
                                   Some(PendingDestination{mFolderId, key, 97}),
                                   attemptId));
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      db.ConfirmOfflineAttempt(attemptId, Some(ServerUidConfirmation{98, 42})));
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Sent, attempt.state);
  EXPECT_FALSE(attempt.confirmedUid);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(key, names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  ASSERT_EQ(NS_OK, db.ConfirmOfflineAttempt(
                       attemptId, Some(ServerUidConfirmation{97, 42})));
  EXPECT_EQ(
      NS_ERROR_FILE_CORRUPTED,
      db.ConfirmOfflineAttempt(attemptId, Some(ServerUidConfirmation{98, 42})));
  ASSERT_EQ(NS_OK, db.ConfirmOfflineAttempt(
                       attemptId, Some(ServerUidConfirmation{97, 42})));
}

TEST_F(DeliveryCoreReferences, BodySettlementPublishesCompleteStorageOnce) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK,
            Add("body@invalid"_ns, {"raw@invalid"_ns, "raw@invalid"_ns}, key));
  ASSERT_EQ(NS_OK, db.SetMessageStoreToken(key, "old-token"_ns));
  ASSERT_EQ(NS_OK, db.SetMessageSize(key, 123));
  ASSERT_EQ(NS_OK, db.SetMessageOfflineMessageSize(key, 111));
  ASSERT_EQ(NS_OK, db.SetMessageLineCount(key, 12));
  MessageBodyState expected;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  ASSERT_EQ(NS_OK, db.SetMessageFlags(key, 5));
  ASSERT_EQ(NS_OK, db.SetMessageProperty(key, "Case"_ns, "00042"_ns));
  ASSERT_EQ(NS_OK, db.SetMessageProperty(key, "case"_ns, "1e3"_ns));
  uint32_t calls = 0;
  RefPtr<BodyObserver> observer = new BodyObserver([&](nsIMsgDBHdr* old,
                                                       Message* message,
                                                       const MessageBodyState&
                                                           before,
                                                       const MessageBodyState&
                                                           after) {
    ++calls;
    EXPECT_EQ(key, before.key);
    EXPECT_EQ(key, after.key);
    ASSERT_TRUE(before.storeToken);
    EXPECT_EQ("old-token"_ns, *before.storeToken);
    EXPECT_EQ(123u, before.messageSize);
    EXPECT_EQ(5u, before.flags);
    EXPECT_GT(after.contentRevision, expected.contentRevision);
    EXPECT_GT(after.locationRevision, expected.locationRevision);
    bool active = true;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    nsCString token;
    ASSERT_EQ(NS_OK, old->GetStoreToken(token));
    EXPECT_EQ("old-token"_ns, token);
    ASSERT_EQ(NS_OK, message->GetStoreToken(token));
    EXPECT_EQ("finished-token"_ns, token);
    uint32_t size, flags;
    ASSERT_EQ(NS_OK, message->GetMessageSize(&size));
    EXPECT_EQ(456u, size);
    ASSERT_EQ(NS_OK, message->GetFlags(&flags));
    EXPECT_EQ(after.flags, flags);
    EXPECT_EQ(5u, flags & ~0x80u);
    EXPECT_TRUE(flags & 0x80u);
    nsTArray<nsCString> stored;
    ASSERT_EQ(NS_OK, Stored(key, stored));
    EXPECT_EQ((nsTArray<nsCString>{"raw@invalid"_ns, "raw@invalid"_ns}),
              stored);
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
    auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
    ASSERT_EQ(
        NS_OK,
        PublicationCell(
            reader, key,
            "SELECT value FROM message_properties WHERE id = :id AND name = 'storeToken'"_ns,
            token));
    EXPECT_EQ("finished-token"_ns, token);
  });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  FinishedMessageBody finished{"finished-token"_ns, 456, 400, 30, true};
  MessageBodyState output;
  ASSERT_EQ(NS_OK, db.SettleMessageBody(expected, finished, output));
  EXPECT_EQ(1u, calls);
  EXPECT_EQ(key, output.key);
  EXPECT_EQ(400u, output.offlineMessageSize);
  EXPECT_EQ(30u, output.lineCount);
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "Case"_ns, text));
  EXPECT_EQ("00042"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "case"_ns, text));
  EXPECT_EQ("1e3"_ns, text);
  db.RemoveMessageListener(observer);
  cleanup.release();
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageBodyState(key, expected));
  EXPECT_EQ(output.storeToken, expected.storeToken);
  EXPECT_EQ(output.contentRevision, expected.contentRevision);
}

TEST_F(DeliveryCoreReferences, BodySettlementRejectsStaleAndMissingGuards) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, Add("body-stale@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, Add("body-control@invalid"_ns, {}, control));
  MessageBodyState expected, output;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  FinishedMessageBody finished{"new"_ns, 20, 20, 2, true};
  output.key = 77;
  auto wrongDatabase = expected;
  wrongDatabase.databaseSourceId = "replaced-database"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.SettleMessageBody(wrongDatabase, finished, output));
  EXPECT_EQ(77u, output.key);
  auto wrongFolder = expected;
  ++wrongFolder.folderId;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.SettleMessageBody(wrongFolder, finished, output));
  EXPECT_EQ(77u, output.key);
  ASSERT_EQ(NS_OK, db.SetMessageSize(key, 21));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.SettleMessageBody(expected, finished, output));
  EXPECT_EQ(77u, output.key);
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  ASSERT_EQ(NS_OK, db.RemoveMessage(key));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.SettleMessageBody(expected, finished, output));
  EXPECT_EQ(77u, output.key);
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(control, output));
  EXPECT_EQ(control, output.key);
}

TEST_F(DeliveryCoreReferences,
       BodySettlementFailureRollsBackStorageAndJournal) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("body-failure@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, db.SetMessageStoreToken(key, "original"_ns));
  MessageBodyState expected, output;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  uint32_t calls = 0;
  RefPtr<BodyObserver> observer =
      new BodyObserver([&](nsIMsgDBHdr*, Message*, const MessageBodyState&,
                           const MessageBodyState&) { ++calls; });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_body_flags BEFORE UPDATE ON messages "
          "BEGIN SELECT RAISE(ABORT, 'body flags'); END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS reject_body_flags"_ns));
  });
  FinishedMessageBody finished{"finished"_ns, 20, 20, 2, true};
  output.key = 77;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.SettleMessageBody(expected, finished, output));
  EXPECT_EQ(77u, output.key);
  EXPECT_EQ(0u, calls);
  MessageBodyState retained;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, retained));
  EXPECT_EQ(expected.storeToken, retained.storeToken);
  EXPECT_EQ(expected.contentRevision, retained.contentRevision);
  EXPECT_EQ(expected.locationRevision, retained.locationRevision);
  EXPECT_EQ(expected.flags, retained.flags);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER reject_body_flags"_ns));
  ASSERT_EQ(NS_OK, db.SettleMessageBody(expected, finished, output));
  EXPECT_EQ(1u, calls);
  ASSERT_TRUE(output.storeToken);
  EXPECT_EQ("finished"_ns, *output.storeToken);
}

TEST_F(DeliveryCoreReferences,
       BodySettlementKeepsForeignTransactionAndFlagObservers) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("body-observers@invalid"_ns, {}, key));
  MessageBodyState expected, output;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  FinishedMessageBody finished{"body"_ns, 10, 10, 1, false};
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.SettleMessageBody(expected, finished, output));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([](Message*, bool) {
        ADD_FAILURE() << "Body settlement published a row";
      });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, db.SettleMessageBody(expected, finished, output));
  EXPECT_EQ(0u, observer->mChanges);
  expected = output;
  finished.offline = true;
  ASSERT_EQ(NS_OK, db.SettleMessageBody(expected, finished, output));
  EXPECT_EQ(1u, observer->mChanges);
}

TEST_F(DeliveryCoreReferences, NativeImportReceiptMapsForwardRootsAndReopens) {
  ASSERT_EQ(NS_OK, Start());
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  FolderImportReceipt receipt;
  uint32_t callbacks = 0;
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([&](Message* message, bool notifyLegacy) {
        ++callbacks;
        EXPECT_FALSE(notifyLegacy);
        ASSERT_EQ(2u, receipt.keys.Length());
        EXPECT_EQ(0u, receipt.keys[0].source);
        EXPECT_EQ(9u, receipt.keys[1].source);
        nsMsgKey root = receipt.keys[0].destination;
        nsMsgKey child = receipt.keys[1].destination;
        nsMsgKey thread, parent;
        ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageThreadId(child, thread));
        ASSERT_EQ(NS_OK,
                  mCore->MessageDB().GetMessageThreadParent(child, parent));
        EXPECT_EQ(root, thread);
        EXPECT_EQ(root, parent);
        nsCString subject;
        ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageSubject(root, subject));
        EXPECT_EQ("imported root"_ns, subject);
        nsTArray<nsCString> stored;
        ASSERT_EQ(NS_OK, Stored(child, stored));
        EXPECT_EQ(
            (nsTArray<nsCString>{"root-import@invalid"_ns, "missing@invalid"_ns,
                                 "root-import@invalid"_ns}),
            stored);
        bool active = true;
        ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
        EXPECT_FALSE(active);
        nsCString text;
        ASSERT_EQ(NS_OK, message->GetSubject(text));
        EXPECT_FALSE(text.IsEmpty());
      });
  auto& db = mCore->MessageDB();
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, receipt));
  EXPECT_EQ(2u, callbacks);
  nsMsgKey root = receipt.keys[0].destination;
  nsMsgKey child = receipt.keys[1].destination;
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(child, "Case"_ns, text));
  EXPECT_EQ("00042"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(child, "case"_ns, text));
  EXPECT_EQ("1e3"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageTags(child, text));
  EXPECT_EQ("last"_ns, text);
  FolderImportReceipt repeated;
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, repeated));
  EXPECT_EQ(2u, callbacks);
  EXPECT_EQ(root, repeated.keys[0].destination);
  EXPECT_EQ(child, repeated.keys[1].destination);
  db.RemoveMessageListener(observer);
  cleanup.release();
  Stop();
  ASSERT_EQ(NS_OK, Start());
  Maybe<FolderImportReceipt> recovered;
  ASSERT_EQ(NS_OK, mCore->GetFolderImportReceipt(input.identity, recovered));
  ASSERT_TRUE(recovered);
  ASSERT_EQ(2u, recovered->keys.Length());
  EXPECT_EQ(root, recovered->keys[0].destination);
  EXPECT_EQ(child, recovered->keys[1].destination);
  EXPECT_EQ(input.identity.databaseSourceId,
            recovered->identity.databaseSourceId);
}

TEST_F(DeliveryCoreReferences,
       NativeImportHistoricalPathRetryPreservesReceipt) {
  ASSERT_EQ(NS_OK, Start());
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  auto& folders = mCore->FolderDB();
  uint64_t literal = input.identity.folderId, slash;
  ASSERT_EQ(NS_OK, folders.UpdateName(literal, "I%2FO stuff"_ns));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "I/O stuff"_ns, &slash));
  nsCString prefix, slashPath;
  ASSERT_EQ(NS_OK, folders.GetFolderPath(mFolderId, prefix));
  ASSERT_EQ(NS_OK, folders.GetFolderPath(literal, input.identity.folderPath));
  ASSERT_EQ(NS_OK, folders.GetFolderPath(slash, slashPath));
  EXPECT_EQ(nsCString(prefix + "/I%252FO stuff"_ns), input.identity.folderPath);
  EXPECT_EQ(nsCString(prefix + "/I%2FO stuff"_ns), slashPath);
  for (uint64_t id : {literal, slash}) {
    nsCString path;
    ASSERT_EQ(NS_OK, folders.GetFolderPath(id, path));
    uint64_t found = 0;
    ASSERT_EQ(NS_OK, folders.GetFolderByPath(path, &found));
    EXPECT_EQ(id, found);
  }

  FolderImportReceipt first;
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, first));
  ASSERT_EQ(2u, first.keys.Length());
  EXPECT_EQ(input.identity.folderPath, first.identity.folderPath);
  const nsCString historical = slashPath;
  // Simulate exactly the persisted spelling written before the codec change.
  // The source, physical folder, complete imported rows and key map are real.
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(NS_OK, mConnection->CreateStatement(
                       "UPDATE folder_import_receipts SET folderPath = :path "
                       "WHERE token = :token"_ns,
                       getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindUTF8StringByName("path"_ns, historical));
  ASSERT_EQ(NS_OK,
            stmt->BindUTF8StringByName("token"_ns, input.identity.token));
  ASSERT_EQ(NS_OK, stmt->Execute());
  ASSERT_EQ(NS_OK, stmt->Finalize());
  stmt = nullptr;

  uint64_t watermark;
  ASSERT_EQ(NS_OK, SearchWatermark(watermark));
  {
    ASSERT_EQ(NS_OK,
              mConnection->ExecuteSimpleSQL("PRAGMA query_only = ON"_ns));
    auto writable = MakeScopeExit([&] {
      EXPECT_EQ(NS_OK,
                mConnection->ExecuteSimpleSQL("PRAGMA query_only = OFF"_ns));
    });
    uint32_t callbacks = 0;
    RefPtr<PublicationObserver> observer =
        new PublicationObserver([&](Message*, bool) { ++callbacks; });
    auto& db = mCore->MessageDB();
    db.AddMessageListener(observer);
    auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
    Maybe<FolderImportReceipt> recovered;
    ASSERT_EQ(NS_OK, mCore->GetFolderImportReceipt(input.identity, recovered));
    ASSERT_TRUE(recovered);
    EXPECT_EQ(historical, recovered->identity.folderPath);
    EXPECT_EQ(first.identity.token, recovered->identity.token);
    EXPECT_EQ(first.identity.databaseSourceId,
              recovered->identity.databaseSourceId);
    EXPECT_EQ(literal, recovered->identity.folderId);
    ASSERT_EQ(first.keys.Length(), recovered->keys.Length());
    for (uint32_t i = 0; i < first.keys.Length(); ++i) {
      EXPECT_EQ(first.keys[i].source, recovered->keys[i].source);
      EXPECT_EQ(first.keys[i].destination, recovered->keys[i].destination);
    }
    FolderImportReceipt repeated;
    ASSERT_EQ(NS_OK, ImportNativeFile(source, input, repeated));
    EXPECT_EQ(historical, repeated.identity.folderPath);
    ASSERT_EQ(first.keys.Length(), repeated.keys.Length());
    for (uint32_t i = 0; i < first.keys.Length(); ++i) {
      EXPECT_EQ(first.keys[i].source, repeated.keys[i].source);
      EXPECT_EQ(first.keys[i].destination, repeated.keys[i].destination);
    }
    EXPECT_EQ(0u, callbacks);
    bool active = true;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    uint64_t after;
    ASSERT_EQ(NS_OK, SearchWatermark(after));
    EXPECT_EQ(watermark, after);
    nsCString text;
    ASSERT_EQ(NS_OK, db.GetMessageProperty(first.keys[1].destination, "Case"_ns,
                                           text));
    EXPECT_EQ("00042"_ns, text);
    nsTArray<nsCString> references;
    ASSERT_EQ(NS_OK, Stored(first.keys[1].destination, references));
    EXPECT_EQ(
        (nsTArray<nsCString>{"root-import@invalid"_ns, "missing@invalid"_ns,
                             "root-import@invalid"_ns}),
        references);

    for (uint32_t change = 0; change < 5; ++change) {
      SCOPED_TRACE(change);
      auto conflict = input.identity;
      nsresult expected = NS_ERROR_ALREADY_INITIALIZED;
      switch (change) {
        case 0:
          conflict.token = "different-token"_ns;
          break;
        case 1:
          conflict.sourceId = "different-source"_ns;
          break;
        case 2:
          conflict.folderId = slash;
          conflict.folderPath = slashPath;
          break;
        case 3:
          conflict.databaseSourceId = "different-database"_ns;
          expected = NS_ERROR_NOT_AVAILABLE;
          break;
        case 4:
          conflict.sourceSha256.AssignLiteral(
              "000000000000000000000000000000000000000000000000000000000000000"
              "0");
#ifdef XP_WIN
          expected = NS_ERROR_NOT_AVAILABLE;
#endif
          break;
      }
      recovered->identity.token = "unchanged"_ns;
      EXPECT_EQ(expected, mCore->GetFolderImportReceipt(conflict, recovered));
      ASSERT_TRUE(recovered);
      EXPECT_EQ("unchanged"_ns, recovered->identity.token);
    }
    // The old spelling is not a second request-path or folder lookup alias.
    auto conflict = input.identity;
    conflict.folderPath = historical;
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              mCore->GetFolderImportReceipt(conflict, recovered));
    ASSERT_TRUE(recovered);
    EXPECT_EQ("unchanged"_ns, recovered->identity.token);
  }
  Stop();
  ASSERT_EQ(NS_OK, Start());
  Maybe<FolderImportReceipt> recovered;
  ASSERT_EQ(NS_OK, mCore->GetFolderImportReceipt(input.identity, recovered));
  ASSERT_TRUE(recovered);
  EXPECT_EQ(historical, recovered->identity.folderPath);
  EXPECT_EQ(first.keys[1].destination, recovered->keys[1].destination);
}

TEST_F(DeliveryCoreReferences, NativeImportReceiptFailureRollsBackWholeUnit) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("prior-control@invalid"_ns, {}, control));
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_import_receipt BEFORE INSERT ON "
          "folder_import_receipts BEGIN SELECT RAISE(ABORT, 'receipt failure'); END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS reject_import_receipt"_ns));
  });
  FolderImportReceipt output;
  output.identity.token = "unchanged"_ns;
  uint32_t callbacks = 0;
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([&](Message*, bool) { ++callbacks; });
  auto& db = mCore->MessageDB();
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            ImportNativeFile(source, input, output));
  EXPECT_EQ("unchanged"_ns, output.identity.token);
  EXPECT_EQ(0u, callbacks);
  uint64_t count;
  ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
  EXPECT_EQ(1u, count);
  bool exists = false, active = true;
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  Maybe<FolderImportReceipt> absent;
  ASSERT_EQ(NS_OK, mCore->GetFolderImportReceipt(input.identity, absent));
  EXPECT_FALSE(absent);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER reject_import_receipt"_ns));
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, output));
  EXPECT_EQ(2u, callbacks);
  ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
  EXPECT_EQ(3u, count);
}

TEST_F(DeliveryCoreReferences,
       NativeImportRejectsUnhandledAndConflictingIdentity) {
  ASSERT_EQ(NS_OK, Start());
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  FolderImportReceipt output;
  output.identity.token = "unchanged"_ns;
  input.recordsComplete = false;
  EXPECT_EQ(NS_ERROR_NOT_IMPLEMENTED, ImportNativeFile(source, input, output));
  EXPECT_EQ("unchanged"_ns, output.identity.token);
  input.recordsComplete = true;
  input.unhandledRecords.AppendElement("unconverted-offline-row"_ns);
  EXPECT_EQ(NS_ERROR_NOT_IMPLEMENTED, ImportNativeFile(source, input, output));
  EXPECT_EQ("unchanged"_ns, output.identity.token);
  input.unhandledRecords.Clear();
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, output));
  auto conflict = input.identity;
  conflict.token = "different-token"_ns;
  Maybe<FolderImportReceipt> sentinel;
  sentinel.emplace();
  sentinel->identity.token = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_ALREADY_INITIALIZED,
            mCore->GetFolderImportReceipt(conflict, sentinel));
  ASSERT_TRUE(sentinel);
  EXPECT_EQ("unchanged"_ns, sentinel->identity.token);
  conflict = input.identity;
  conflict.databaseSourceId = "different-database"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->GetFolderImportReceipt(conflict, sentinel));
  ASSERT_TRUE(sentinel);
  EXPECT_EQ("unchanged"_ns, sentinel->identity.token);
  conflict = input.identity;
  conflict.sourceSha256.AssignLiteral(
      "0000000000000000000000000000000000000000000000000000000000000000");
#ifdef XP_WIN
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->GetFolderImportReceipt(conflict, sentinel));
#else
  EXPECT_EQ(NS_ERROR_ALREADY_INITIALIZED,
            mCore->GetFolderImportReceipt(conflict, sentinel));
#endif
  ASSERT_TRUE(sentinel);
  EXPECT_EQ("unchanged"_ns, sentinel->identity.token);
}

TEST_F(DeliveryCoreReferences, NativeImportDoesNotInventOldHashOnlyKeyMap) {
  ASSERT_EQ(NS_OK, Start());
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(
      NS_OK,
      mConnection->CreateStatement(
          "INSERT INTO folder_properties(id, name, value) VALUES(:id, "
          "'morkMigrationSource', 'v1:sha256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=')"_ns,
          getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, input.identity.folderId));
  ASSERT_EQ(NS_OK, stmt->Execute());
  ASSERT_EQ(NS_OK, stmt->Finalize());
  Maybe<FolderImportReceipt> output;
  output.emplace();
  output->identity.token = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->GetFolderImportReceipt(input.identity, output));
  ASSERT_TRUE(output);
  EXPECT_EQ("unchanged"_ns, output->identity.token);
  FolderImportReceipt receipt;
  receipt.identity.token = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, ImportNativeFile(source, input, receipt));
  EXPECT_EQ("unchanged"_ns, receipt.identity.token);
}

TEST_F(DeliveryCoreReferences, NativeImportReceiptSqlErrorPreservesOutput) {
  ASSERT_EQ(NS_OK, Start());
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  FolderImportReceipt receipt;
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, receipt));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP VIEW folder_import_keys AS SELECT token, sourceKey, "
          "abs(-9223372036854775808) AS destinationKey FROM main.folder_import_keys"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.folder_import_keys"_ns));
  });
  Maybe<FolderImportReceipt> output;
  output.emplace();
  output->identity.token = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_FAILURE,
            mCore->GetFolderImportReceipt(input.identity, output));
  ASSERT_TRUE(output);
  EXPECT_EQ("unchanged"_ns, output->identity.token);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.folder_import_keys"_ns));
  ASSERT_EQ(NS_OK, mCore->GetFolderImportReceipt(input.identity, output));
  ASSERT_TRUE(output);
  EXPECT_EQ(2u, output->keys.Length());
}

TEST_F(DeliveryCoreReferences, NativeImportRejectsLostReceiptMapping) {
  ASSERT_EQ(NS_OK, Start());
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  FolderImportReceipt receipt;
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, receipt));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "DELETE FROM folder_import_keys WHERE sourceKey = 9"_ns));
  Maybe<FolderImportReceipt> output;
  output.emplace();
  output->identity.token = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            mCore->GetFolderImportReceipt(input.identity, output));
  ASSERT_TRUE(output);
  EXPECT_EQ("unchanged"_ns, output->identity.token);
  receipt.identity.token = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, ImportNativeFile(source, input, receipt));
  EXPECT_EQ("unchanged"_ns, receipt.identity.token);
  uint64_t count;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(2u, count);
}

TEST_F(DeliveryCoreReferences,
       NativeImportChecksSourceSizeAndForeignTransaction) {
  ASSERT_EQ(NS_OK, Start());
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  FolderImportReceipt output;
  output.identity.token = "unchanged"_ns;
  input.sourceSize = 1;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, ImportNativeFile(source, input, output));
  EXPECT_EQ("unchanged"_ns, output.identity.token);
  input.sourceSize = 0;
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active;
    if (NS_SUCCEEDED(mConnection->GetTransactionInProgress(&active)) &&
        active) {
      EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
    }
  });
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, ImportNativeFile(source, input, output));
  EXPECT_EQ("unchanged"_ns, output.identity.token);
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, output));
  EXPECT_EQ(2u, output.keys.Length());
}

}  // namespace

TEST_F(DeliveryCoreReferences, RelocationPendingSurvivesReopenAndGatesAccess) {
  ASSERT_EQ(NS_OK, Start());
  FolderBodyRelocation plan;
  ASSERT_EQ(NS_OK, PrepareRelocation(plan));
  auto key = plan.messages[0].before.key;
  uint64_t other;
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolderId, "Other"_ns, &other));
  RawHdr controlHeader;
  controlHeader.messageId = "unrelated-row"_ns;
  nsMsgKey control;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(other, controlHeader, false,
                                                 &control));
  ASSERT_EQ(NS_OK, mCore->MessageDB().PrepareBodyRelocation(plan));
  nsTArray<uint64_t> pending;
  ASSERT_EQ(NS_OK, mCore->MessageDB().ListPendingBodyRelocations(pending));
  EXPECT_EQ((nsTArray<uint64_t>{mFolderId}), pending);
  Stop();
  ASSERT_FALSE(mCore);
  ASSERT_FALSE(mConnection);
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  Maybe<FolderBodyRelocation> stored;
  ASSERT_EQ(NS_OK, db.GetBodyRelocation(mFolderId, stored));
  ASSERT_TRUE(stored);
  EXPECT_EQ(plan.originalPath, stored->originalPath);
  EXPECT_EQ(plan.backupPath, stored->backupPath);
  EXPECT_EQ(BodyRelocationState::Pending, stored->state);
  EXPECT_EQ(2u, stored->messages.Length());
  MessageBodyState output;
  output.key = 77;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.GetMessageBodyState(key, output));
  EXPECT_EQ(77u, output.key);
  nsCString token("sentinel");
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.GetMessageStoreToken(key, token));
  EXPECT_EQ("sentinel"_ns, token);
  EXPECT_EQ(NS_OK, db.SetMessageStoreToken(control, "unrelated-body"_ns));
  ASSERT_EQ(NS_OK, db.GetMessageStoreToken(control, token));
  EXPECT_EQ("unrelated-body"_ns, token);
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.SetMessageFlags(key, 1));
  nsMsgKey rejected = 77;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, Add("late"_ns, {}, rejected));
  EXPECT_EQ(77u, rejected);
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, db.RemoveMessage(key));
  bool exists = false;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_TRUE(exists);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.SettleBodyRelocation(mFolderId, plan.token,
                                    BodyRelocationOutcome::Installed));
  ASSERT_EQ(NS_OK, db.SettleBodyRelocation(mFolderId, plan.token,
                                           BodyRelocationOutcome::Restored));
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, output));
  EXPECT_EQ(plan.messages[0].before.storeToken, output.storeToken);
  EXPECT_EQ(plan.messages[0].before.contentRevision, output.contentRevision);
  EXPECT_EQ(NS_OK, db.SettleBodyRelocation(mFolderId, plan.token,
                                           BodyRelocationOutcome::Restored));
}

TEST_F(DeliveryCoreReferences, RelocationInstallsWholeSetBeforeFirstCallback) {
  ASSERT_EQ(NS_OK, Start());
  FolderBodyRelocation plan;
  ASSERT_EQ(NS_OK, PrepareRelocation(plan));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.PrepareBodyRelocation(plan));
  ASSERT_EQ(NS_OK, InstallRelocation(plan));
  uint32_t calls = 0;
  RefPtr<BodyObserver> observer = new BodyObserver([&](nsIMsgDBHdr* old,
                                                       Message* live,
                                                       const MessageBodyState&
                                                           before,
                                                       const MessageBodyState&
                                                           after) {
    ++calls;
    bool active = true;
    ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    for (const auto& expected : plan.messages) {
      MessageBodyState current;
      ASSERT_EQ(NS_OK, db.GetMessageBodyState(expected.before.key, current));
      EXPECT_EQ(expected.storeToken, current.storeToken);
      EXPECT_EQ(expected.messageSize, current.messageSize);
      EXPECT_GT(current.locationRevision, expected.before.locationRevision);
    }
    nsCString token;
    ASSERT_EQ(NS_OK, old->GetStoreToken(token));
    EXPECT_EQ(*before.storeToken, token);
    ASSERT_EQ(NS_OK, live->GetStoreToken(token));
    EXPECT_EQ(*after.storeToken, token);
    uint32_t flags = 0;
    ASSERT_EQ(NS_OK, live->GetFlags(&flags));
    EXPECT_EQ(5u | 0x80u, flags);
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
    auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
    for (const auto& row : plan.messages) {
      ASSERT_EQ(
          NS_OK,
          PublicationCell(
              reader, row.before.key,
              "SELECT value FROM message_properties WHERE id=:id AND name='storeToken'"_ns,
              token));
      EXPECT_EQ(*row.storeToken, token);
    }
  });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, db.SettleBodyRelocation(mFolderId, plan.token,
                                           BodyRelocationOutcome::Installed));
  EXPECT_EQ(2u, calls);
  EXPECT_EQ(NS_OK, db.SettleBodyRelocation(mFolderId, plan.token,
                                           BodyRelocationOutcome::Installed));
  EXPECT_EQ(2u, calls);
  for (const auto& row : plan.messages) {
    nsCString text;
    ASSERT_EQ(NS_OK, db.GetMessageProperty(row.before.key, "Case"_ns, text));
    EXPECT_EQ("00042"_ns, text);
    nsTArray<nsCString> references;
    ASSERT_EQ(NS_OK, Stored(row.before.key, references));
    EXPECT_EQ((nsTArray<nsCString>{"ancestor"_ns, "ancestor"_ns}), references);
  }
  nsCOMPtr<nsIFile> backup;
  ASSERT_EQ(NS_OK, NS_NewLocalFile(plan.backupPath, getter_AddRefs(backup)));
  int64_t size = 0;
  ASSERT_EQ(NS_OK, backup->GetFileSize(&size));
  EXPECT_EQ(64, size);
}

TEST_F(DeliveryCoreReferences, RelocationFailureKeepsIntentAndAllOldRows) {
  ASSERT_EQ(NS_OK, Start());
  FolderBodyRelocation plan;
  ASSERT_EQ(NS_OK, PrepareRelocation(plan));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.PrepareBodyRelocation(plan));
  auto readScalar = [&](const nsACString& sql, int64_t& value) -> nsresult {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(Connection()->CreateStatement(sql, getter_AddRefs(stmt)));
    auto finalize = MakeScopeExit([&] { EXPECT_EQ(NS_OK, stmt->Finalize()); });
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_UNEXPECTED);
    return stmt->GetInt64(0, &value);
  };
  int64_t watermark;
  ASSERT_EQ(NS_OK, readScalar("SELECT MAX(sequence) FROM message_changes"_ns,
                              watermark));
  ASSERT_EQ(NS_OK, InstallRelocation(plan));
  uint32_t calls = 0;
  RefPtr<BodyObserver> observer =
      new BodyObserver([&](nsIMsgDBHdr*, Message*, const MessageBodyState&,
                           const MessageBodyState&) { ++calls; });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(
      NS_OK,
      Connection()->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER fail_relocation BEFORE INSERT ON message_properties WHEN NEW.name='storeToken' AND NEW.value='new-1' BEGIN SELECT RAISE(ABORT,'second relocation'); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.SettleBodyRelocation(mFolderId, plan.token,
                                    BodyRelocationOutcome::Installed));
  EXPECT_EQ(0u, calls);
  int64_t sequence, oldTokens;
  ASSERT_EQ(NS_OK, readScalar("SELECT MAX(sequence) FROM message_changes"_ns,
                              sequence));
  EXPECT_EQ(watermark, sequence);
  ASSERT_EQ(
      NS_OK,
      readScalar(
          "SELECT COUNT(*) FROM message_properties WHERE name='storeToken' AND value IN('old-0','old-1')"_ns,
          oldTokens));
  EXPECT_EQ(2, oldTokens);
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.CheckFolderBodyAccess(mFolderId));
  bool active = true;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL("DROP TRIGGER fail_relocation"_ns));
  ASSERT_EQ(NS_OK, db.SettleBodyRelocation(mFolderId, plan.token,
                                           BodyRelocationOutcome::Installed));
  EXPECT_EQ(2u, calls);
}

TEST_F(DeliveryCoreReferences, RelocationRejectsIncompleteAndStaleSets) {
  ASSERT_EQ(NS_OK, Start());
  FolderBodyRelocation plan;
  ASSERT_EQ(NS_OK, PrepareRelocation(plan));
  auto& db = mCore->MessageDB();
  auto last = plan.messages.LastElement();
  plan.messages.RemoveLastElement();
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.PrepareBodyRelocation(plan));
  plan.messages.AppendElement(std::move(last));
  nsMsgKey late;
  ASSERT_EQ(NS_OK, Add("late-row"_ns, {}, late));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.PrepareBodyRelocation(plan));
  ASSERT_EQ(NS_OK, db.RemoveMessage(late));
  ASSERT_EQ(NS_OK, db.SetMessageProperty(plan.messages[0].before.key, "Case"_ns,
                                         "later"_ns));
  ASSERT_EQ(NS_OK, db.NoteMessageContentChanged(plan.messages[0].before.key));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.PrepareBodyRelocation(plan));
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(plan.messages[0].before.key,
                                          plan.messages[0].before));
  --plan.originalSize;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.PrepareBodyRelocation(plan));
  ++plan.originalSize;
  ASSERT_EQ(NS_OK, db.PrepareBodyRelocation(plan));
  ASSERT_EQ(NS_OK, db.SettleBodyRelocation(mFolderId, plan.token,
                                           BodyRelocationOutcome::Restored));
}

TEST_F(DeliveryCoreReferences, RelocationRejectsStagedBodyOwner) {
  ASSERT_EQ(NS_OK, Start());
  FolderBodyRelocation plan;
  ASSERT_EQ(NS_OK, PrepareRelocation(plan));
  auto& db = mCore->MessageDB();
  RawHdr raw;
  raw.messageId = "staged-body@invalid"_ns;
  raw.storeToken = Some(nsCString("unpublished-body"_ns));
  nsMsgKey staged;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  uint64_t otherFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "Other"_ns,
                                                  &otherFolder));
  nsMsgKey otherStaged;
  ASSERT_EQ(NS_OK, db.StageMessage(otherFolder, raw, &otherStaged));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.PrepareBodyRelocation(plan));
  Maybe<FolderBodyRelocation> intent;
  ASSERT_EQ(NS_OK, db.GetBodyRelocation(mFolderId, intent));
  EXPECT_FALSE(intent);
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{staged}), keys);
  bool exists = true;
  ASSERT_EQ(NS_OK, db.MessageExists(staged, exists));
  EXPECT_FALSE(exists);
  nsCString token;
  ASSERT_EQ(NS_OK, db.GetMessageStoreToken(staged, token));
  EXPECT_EQ("unpublished-body"_ns, token);
  MessageBodyState current;
  ASSERT_EQ(NS_OK,
            db.GetMessageBodyState(plan.messages[0].before.key, current));
  EXPECT_EQ(plan.messages[0].before.storeToken, current.storeToken);
  EXPECT_EQ(plan.messages[0].before.contentRevision, current.contentRevision);
  bool active = true;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_EQ(NS_OK, db.AbortMessage(staged));
  ASSERT_EQ(NS_OK, db.PrepareBodyRelocation(plan));
  ASSERT_EQ(NS_OK, db.SettleBodyRelocation(mFolderId, plan.token,
                                           BodyRelocationOutcome::Restored));
  EXPECT_EQ(NS_OK, db.CheckFolderBodyAccess(mFolderId));
  ASSERT_EQ(NS_OK, db.ListStagedMessages(otherFolder, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{otherStaged}), keys);
  ASSERT_EQ(NS_OK, db.AbortMessage(otherStaged));
}

TEST_F(DeliveryCoreReferences, RelocationReadErrorsPreserveOutputAndGate) {
  ASSERT_EQ(NS_OK, Start());
  FolderBodyRelocation plan;
  ASSERT_EQ(NS_OK, PrepareRelocation(plan));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.PrepareBodyRelocation(plan));
  Maybe<FolderBodyRelocation> output = Some(FolderBodyRelocation{});
  output->folderId = 77;
  ASSERT_EQ(
      NS_OK,
      Connection()->ExecuteSimpleSQL(
          "CREATE TEMP VIEW body_relocation_rows AS SELECT folderId,abs(-9223372036854775808) AS id,oldToken,content,location,size,offlineSize,lines,flags,newToken,newSize,newOfflineSize,newLines,offline FROM main.body_relocation_rows"_ns));
  EXPECT_EQ(NS_ERROR_FAILURE, db.GetBodyRelocation(mFolderId, output));
  ASSERT_TRUE(output);
  EXPECT_EQ(77u, output->folderId);
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "DROP VIEW temp.body_relocation_rows"_ns));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  nsTArray<uint64_t> pending{77};
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.ListPendingBodyRelocations(pending));
  EXPECT_EQ((nsTArray<uint64_t>{77}), pending);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  ASSERT_EQ(NS_OK, db.GetBodyRelocation(mFolderId, output));
  ASSERT_TRUE(output);
  EXPECT_EQ(BodyRelocationState::Pending, output->state);
  ASSERT_EQ(NS_OK, db.SettleBodyRelocation(mFolderId, plan.token,
                                           BodyRelocationOutcome::Restored));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.CheckMessageBodyAccess(plan.messages[0].before.key));
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  EXPECT_EQ(NS_OK, db.CheckMessageBodyAccess(plan.messages[0].before.key));
}

TEST_F(DeliveryCoreReferences, PendingAppendDestinationSurvivesReopen) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().SetFolderUidValidity(mFolderId, UINT32_MAX));
  RawHdr raw;
  raw.messageId = "queued-append@invalid"_ns;
  raw.storeToken = Some(nsCString("finished-body"_ns));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, mCore->MessageDB().StageMessage(mFolderId, raw, &key));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kAppendDraft;
  input.pendingDestination =
      Some(PendingDestination{mFolderId, key, UINT32_MAX});
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().StoreOfflineOperation(mFolderId, key, input));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, key, got));
  ASSERT_TRUE(got.pendingDestination);
  EXPECT_EQ(mFolderId, got.pendingDestination->folderId);
  EXPECT_EQ(key, got.pendingDestination->key);
  EXPECT_EQ(UINT32_MAX, got.pendingDestination->epoch);
  EXPECT_TRUE(got.copyDestinationBindings.IsEmpty());
  OfflineAttempt attempt;
  attempt.id = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetCurrentOfflineAttempt(mFolderId, key, attempt));
  EXPECT_EQ(123u, attempt.id);
  bool exists = true;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_FALSE(exists);
  nsTArray<nsMsgKey> staged;
  ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, staged));
  EXPECT_EQ((nsTArray<nsMsgKey>{key}), staged);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(key, names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  nsCString token;
  ASSERT_EQ(NS_OK, db.GetMessageStoreToken(key, token));
  EXPECT_EQ("finished-body"_ns, token);
}

TEST_F(DeliveryCoreReferences, PendingCopiesKeepOrderedPhysicalAssociations) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  uint64_t destinationFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "Copies"_ns,
                                                  &destinationFolder));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 31));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(destinationFolder,
                                                          UINT32_MAX));
  nsMsgKey source, staged, published;
  ASSERT_EQ(NS_OK, Add("source@invalid"_ns, {}, source));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(source, mFolderId, 31, 700));
  RawHdr raw;
  raw.messageId = "copy-stage@invalid"_ns;
  ASSERT_EQ(NS_OK, db.StageMessage(destinationFolder, raw, &staged));
  raw.messageId = "copy-published@invalid"_ns;
  ASSERT_EQ(NS_OK, db.AddMessage(destinationFolder, raw, true, &published));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kMsgCopy;
  input.copyDestinations = {"imap://same/Copies"_ns, "imap://legacy/Copies"_ns,
                            "imap://same/Copies"_ns};
  input.copyDestinationBindings.AppendElement(
      Some(PendingDestination{destinationFolder, staged, UINT32_MAX}));
  input.copyDestinationBindings.AppendElement(Nothing());
  input.copyDestinationBindings.AppendElement(
      Some(PendingDestination{destinationFolder, published, UINT32_MAX}));
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, input));
  ASSERT_EQ(NS_OK, db.RemoveMessage(source));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->MessageDB();
  {
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
    nsCOMPtr<mozIStorageStatement> stmt;
    auto close = MakeScopeExit([&] {
      if (stmt) {
        EXPECT_EQ(NS_OK, stmt->Finalize());
      }
      EXPECT_EQ(NS_OK, reader->Close());
    });
    ASSERT_EQ(NS_OK, reader->CreateStatement(
                         "SELECT "
                         "c.ordinal,c.uri,c.destinationFolderId,c."
                         "destinationKey,c.destinationEpoch "
                         "FROM offline_copy_destinations c JOIN "
                         "offline_operations o ON o.id=c.operationId "
                         "WHERE o.messageKey=:key ORDER BY c.ordinal"_ns,
                         getter_AddRefs(stmt)));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("key"_ns, source));
    const nsMsgKey expected[] = {staged, nsMsgKey_None, published};
    for (uint32_t i = 0; i < 3; ++i) {
      bool more, absent;
      ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
      ASSERT_TRUE(more);
      int64_t ordinal;
      ASSERT_EQ(NS_OK, stmt->GetInt64(0, &ordinal));
      EXPECT_EQ(i, ordinal);
      nsCString uri;
      ASSERT_EQ(NS_OK, stmt->GetUTF8String(1, uri));
      EXPECT_EQ(input.copyDestinations[i], uri);
      ASSERT_EQ(NS_OK, stmt->GetIsNull(2, &absent));
      EXPECT_EQ(expected[i] == nsMsgKey_None, absent);
      if (!absent) {
        int64_t folder, key, epoch;
        ASSERT_EQ(NS_OK, stmt->GetInt64(2, &folder));
        ASSERT_EQ(NS_OK, stmt->GetInt64(3, &key));
        ASSERT_EQ(NS_OK, stmt->GetInt64(4, &epoch));
        EXPECT_EQ(destinationFolder, uint64_t(folder));
        EXPECT_EQ(expected[i], key);
        EXPECT_EQ(UINT32_MAX, epoch);
      }
    }
    bool more;
    ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
    EXPECT_FALSE(more);
  }
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperation(mFolderId, source, got));
  EXPECT_EQ(input.copyDestinations, got.copyDestinations);
  ASSERT_EQ(3u, got.copyDestinationBindings.Length());
  ASSERT_TRUE(got.copyDestinationBindings[0]);
  EXPECT_EQ(destinationFolder, got.copyDestinationBindings[0]->folderId);
  EXPECT_EQ(staged, got.copyDestinationBindings[0]->key);
  EXPECT_EQ(UINT32_MAX, got.copyDestinationBindings[0]->epoch);
  EXPECT_FALSE(got.copyDestinationBindings[1]);
  ASSERT_TRUE(got.copyDestinationBindings[2]);
  EXPECT_EQ(published, got.copyDestinationBindings[2]->key);
  got.keywordsToAdd = "unrelated edit"_ns;
  ASSERT_EQ(NS_OK, reopened.StoreOfflineOperation(mFolderId, source, got));
  ASSERT_NO_FATAL_FAILURE(CheckOfflineSource(source, 31, 700));
  uint64_t attemptId = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            reopened.BeginOfflineAttempt(
                mFolderId, source, nsIMsgOfflineImapOperation::kMsgCopy,
                got.copyDestinationBindings[2], attemptId));
  EXPECT_EQ(123u, attemptId);
  got.copyDestinationBindings[0].reset();
  ASSERT_EQ(NS_OK, reopened.StoreOfflineOperation(mFolderId, source, got));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            reopened.BeginOfflineAttempt(
                mFolderId, source, nsIMsgOfflineImapOperation::kMsgCopy,
                got.copyDestinationBindings[2], attemptId));
  EXPECT_EQ(123u, attemptId);
  got.copyDestinationBindings[0] =
      Some(PendingDestination{destinationFolder, staged, UINT32_MAX});
  ASSERT_EQ(NS_OK, reopened.StoreOfflineOperation(mFolderId, source, got));
  ASSERT_EQ(NS_OK, reopened.BeginOfflineAttempt(
                       mFolderId, source, nsIMsgOfflineImapOperation::kMsgCopy,
                       got.copyDestinationBindings[0], attemptId));
  got.keywordsToAdd = "must not replace"_ns;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            reopened.StoreOfflineOperation(mFolderId, source, got));
  ASSERT_EQ(NS_OK, reopened.MarkOfflineAttemptAmbiguous(attemptId));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            reopened.StoreOfflineOperation(mFolderId, source, got));
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperation(mFolderId, source, got));
  EXPECT_EQ("unrelated edit"_ns, got.keywordsToAdd);
  EXPECT_EQ(staged, got.copyDestinationBindings[0]->key);
}

TEST_F(DeliveryCoreReferences, PendingDestinationRejectsInvalidIdentity) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 17));
  RawHdr raw;
  raw.messageId = "pending-identity@invalid"_ns;
  nsMsgKey key, other;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &key));
  ASSERT_EQ(NS_OK, Add("bound@invalid"_ns, {}, other));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(other, mFolderId, 17, 42));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kAppendDraft;
  input.pendingDestination = Some(PendingDestination{mFolderId, key, 17});
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, input));
  for (const auto& invalid :
       {PendingDestination{mFolderId, key, 18},
        PendingDestination{mFolderId + 100, key, 17},
        PendingDestination{mFolderId, other, 17},
        PendingDestination{mFolderId, nsMsgKey_None - 1, 17}}) {
    SCOPED_TRACE(invalid.key);
    input.pendingDestination = Some(invalid);
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.StoreOfflineOperation(mFolderId, key, input));
  }
  input.pendingDestination = Some(PendingDestination{mFolderId, 0, 17});
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.StoreOfflineOperation(mFolderId, key, input));
  input.pendingDestination = Some(PendingDestination{mFolderId, key, 17});
  input.operation = nsIMsgOfflineImapOperation::kAppendDraft |
                    nsIMsgOfflineImapOperation::kAppendTemplate;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.StoreOfflineOperation(mFolderId, key, input));
  input.operation = nsIMsgOfflineImapOperation::kMsgMoved;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.StoreOfflineOperation(mFolderId, key, input));
  input.operation = nsIMsgOfflineImapOperation::kMsgCopy;
  input.pendingDestination.reset();
  input.copyDestinations = {"imap://one"_ns};
  input.copyDestinationBindings.AppendElement(Nothing());
  input.copyDestinationBindings.AppendElement(Nothing());
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.StoreOfflineOperation(mFolderId, key, input));
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, key, got));
  EXPECT_EQ(uint32_t(nsIMsgOfflineImapOperation::kAppendDraft), got.operation);
  ASSERT_TRUE(got.pendingDestination);
  EXPECT_EQ(key, got.pendingDestination->key);
  EXPECT_EQ(17u, got.pendingDestination->epoch);
  EXPECT_TRUE(got.copyDestinations.IsEmpty());
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
}

TEST_F(DeliveryCoreReferences,
       PendingDestinationCannotBeClaimedByAnotherOperation) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 23));
  nsMsgKey first, second, target;
  ASSERT_EQ(NS_OK, Add("first-source@invalid"_ns, {}, first));
  ASSERT_EQ(NS_OK, Add("second-source@invalid"_ns, {}, second));
  ASSERT_EQ(NS_OK, Add("physical-target@invalid"_ns, {}, target));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(first, mFolderId, 23, 42));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(second, mFolderId, 23, 43));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kMsgMoved;
  input.pendingDestination = Some(PendingDestination{mFolderId, target, 23});
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, first, input));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.StoreOfflineOperation(mFolderId, second, input));
  input.pendingDestination.reset();
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, second, input));
  uint64_t output = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineAttempt(
                mFolderId, second, nsIMsgOfflineImapOperation::kMsgMoved,
                Some(PendingDestination{mFolderId, target, 23}), output));
  EXPECT_EQ(123u, output);
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, first, input));
  input.pendingDestination = Some(PendingDestination{mFolderId, target, 23});
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, second, input));
}

TEST_F(DeliveryCoreReferences,
       PendingDestinationEpochIsNotRefreshedAtDispatch) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 71));
  RawHdr raw;
  raw.messageId = "queued-epoch@invalid"_ns;
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &key));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kAppendDraft;
  input.pendingDestination = Some(PendingDestination{mFolderId, key, 71});
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, input));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 72));
  uint64_t output = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineAttempt(
                mFolderId, key, nsIMsgOfflineImapOperation::kAppendDraft,
                Some(PendingDestination{mFolderId, key, 72}), output));
  EXPECT_EQ(123u, output);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineAttempt(mFolderId, key,
                                   nsIMsgOfflineImapOperation::kAppendDraft,
                                   input.pendingDestination, output));
  EXPECT_EQ(123u, output);
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, key, got));
  ASSERT_TRUE(got.pendingDestination);
  EXPECT_EQ(71u, got.pendingDestination->epoch);
}

TEST_F(DeliveryCoreReferences,
       PendingBindingsRejectBoundAndDuplicateDestinations) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 29));
  nsMsgKey source, bound, fresh;
  ASSERT_EQ(NS_OK, Add("source@invalid"_ns, {}, source));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(source, mFolderId, 29, 42));
  RawHdr raw;
  raw.messageId = "bound-staged@invalid"_ns;
  RefPtr<Message> header;
  ASSERT_EQ(NS_OK,
            db.StageMessage(mFolderId, raw, &bound, getter_AddRefs(header)));
  ASSERT_EQ(NS_OK, header->SetUint32Property("uidOnServer", 0));
  raw.messageId = "fresh-staged@invalid"_ns;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &fresh));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kFlagsChanged;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, input));
  input.operation = nsIMsgOfflineImapOperation::kMsgMoved;
  input.pendingDestination = Some(PendingDestination{mFolderId, bound, 29});
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.StoreOfflineOperation(mFolderId, source, input));
  input.pendingDestination = Some(PendingDestination{mFolderId, fresh, 29});
  input.operation |= nsIMsgOfflineImapOperation::kMsgCopy;
  input.copyDestinations = {"imap://duplicate"_ns};
  input.copyDestinationBindings.AppendElement(input.pendingDestination);
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.StoreOfflineOperation(mFolderId, source, input));
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, source, got));
  EXPECT_EQ(uint32_t(nsIMsgOfflineImapOperation::kFlagsChanged), got.operation);
  EXPECT_FALSE(got.pendingDestination);
  EXPECT_TRUE(got.copyDestinations.IsEmpty());
}

TEST_F(DeliveryCoreReferences,
       PendingAssociationSqlFailurePreservesPayloadAndOutput) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 37));
  nsMsgKey source, control, first, second;
  ASSERT_EQ(NS_OK, Add("source@invalid"_ns, {}, source));
  ASSERT_EQ(NS_OK, Add("control@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(source, mFolderId, 37, 42));
  ASSERT_EQ(NS_OK, Add("target-one@invalid"_ns, {}, first));
  ASSERT_EQ(NS_OK, Add("target-two@invalid"_ns, {}, second));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kMsgCopy;
  input.copyDestinations = {"imap://old"_ns};
  input.keywordsToAdd = "old payload"_ns;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, input));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK, mConnection->CreateFunction("pending_fault"_ns, 1, witness));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "CREATE TEMP TRIGGER fail_pending_copy BEFORE INSERT ON "
                "offline_copy_destinations "
                "WHEN NEW.ordinal=1 BEGIN SELECT pending_fault(NEW.ordinal); "
                "SELECT RAISE(ABORT,'pending tuple write'); END"_ns));
  input.copyDestinations = {"imap://first"_ns, "imap://second"_ns};
  input.copyDestinationBindings.AppendElement(
      Some(PendingDestination{mFolderId, first, 37}));
  input.copyDestinationBindings.AppendElement(
      Some(PendingDestination{mFolderId, second, 37}));
  input.keywordsToAdd = "new payload"_ns;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.StoreOfflineOperation(mFolderId, source, input));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(1, witness->mLastKey);
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, source, got));
  EXPECT_EQ("old payload"_ns, got.keywordsToAdd);
  EXPECT_EQ((nsTArray<nsCString>{"imap://old"_ns}), got.copyDestinations);
  ASSERT_EQ(1u, got.copyDestinationBindings.Length());
  EXPECT_FALSE(got.copyDestinationBindings[0]);
  ASSERT_NO_FATAL_FAILURE(CheckOfflineSource(source, 37, 42));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER fail_pending_copy"_ns));
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, input));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "CREATE TEMP VIEW offline_copy_destinations AS SELECT * "
                       "FROM main.offline_copy_destinations "
                       "WHERE abs(-9223372036854775808)"_ns));
  got.operation = 123;
  got.pendingDestination = Some(PendingDestination{99, 98, 97});
  got.copyDestinations = {"untouched"_ns};
  EXPECT_EQ(NS_ERROR_FAILURE, db.GetOfflineOperation(mFolderId, source, got));
  EXPECT_EQ(123u, got.operation);
  ASSERT_TRUE(got.pendingDestination);
  EXPECT_EQ(99u, got.pendingDestination->folderId);
  EXPECT_EQ(98u, got.pendingDestination->key);
  EXPECT_EQ(97u, got.pendingDestination->epoch);
  EXPECT_EQ((nsTArray<nsCString>{"untouched"_ns}), got.copyDestinations);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.offline_copy_destinations"_ns));
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, source, got));
  EXPECT_EQ("new payload"_ns, got.keywordsToAdd);
  ASSERT_EQ(2u, got.copyDestinationBindings.Length());
  ASSERT_TRUE(got.copyDestinationBindings[1]);
  EXPECT_EQ(second, got.copyDestinationBindings[1]->key);
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "UPDATE offline_copy_destinations SET destinationKey=NULL WHERE ordinal=0"_ns));
  got.operation = 123;
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            db.GetOfflineOperation(mFolderId, source, got));
  EXPECT_EQ(123u, got.operation);
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, input));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  input.keywordsToAdd = "foreign transaction must remain owned"_ns;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.StoreOfflineOperation(mFolderId, source, input));
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, source, got));
  EXPECT_EQ("new payload"_ns, got.keywordsToAdd);
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreReferences,
       PendingBindingUpgradePreservesAbsentLegacyTuples) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 43));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("legacy-payload@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 43, 42));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kMsgCopy;
  input.copyDestinations = {"imap://repeat"_ns, "imap://repeat"_ns};
  input.keywordsToRemove = "preserved"_ns;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, input));
  Stop();
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  // Restore the exact previous columns on a real core-created database.
  ASSERT_EQ(
      NS_OK,
      old->ExecuteSimpleSQL(
          "DROP TABLE folder_import_windows;"
          "DROP TRIGGER thread_flags_message_delete; DROP TRIGGER "
          "thread_flags_folder_delete;"
          "DROP TABLE thread_flags;"
          "DROP TRIGGER guard_folder_id; DROP TRIGGER record_folder_id;"
          "DROP TRIGGER immutable_folder_id; DROP TABLE folder_id_allocator;"
          "ALTER TABLE offline_operations DROP COLUMN destinationFolderId;"
          "ALTER TABLE offline_operations DROP COLUMN destinationKey;"
          "ALTER TABLE offline_operations DROP COLUMN destinationEpoch;"
          "ALTER TABLE offline_copy_destinations DROP COLUMN "
          "destinationFolderId;"
          "ALTER TABLE offline_copy_destinations DROP COLUMN destinationKey;"
          "ALTER TABLE offline_copy_destinations DROP COLUMN destinationEpoch;"_ns));
  ASSERT_EQ(
      NS_OK,
      old->ExecuteSimpleSQL(
          "DROP TABLE folder_cache_bindings; DROP TABLE folder_cache_imports"_ns));
  ASSERT_EQ(NS_OK, RemovePost15OfflineColumns(old));
  ASSERT_EQ(NS_OK, old->SetSchemaVersion(10));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
  int32_t version;
  ASSERT_EQ(NS_OK, mConnection->GetSchemaVersion(&version));
  EXPECT_EQ(19, version);
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetOfflineOperation(mFolderId, key, got));
  EXPECT_EQ(input.operation, got.operation);
  EXPECT_EQ(input.copyDestinations, got.copyDestinations);
  EXPECT_EQ("preserved"_ns, got.keywordsToRemove);
  EXPECT_FALSE(got.pendingDestination);
  ASSERT_EQ(2u, got.copyDestinationBindings.Length());
  EXPECT_FALSE(got.copyDestinationBindings[0]);
  EXPECT_FALSE(got.copyDestinationBindings[1]);
  ASSERT_NO_FATAL_FAILURE(CheckOfflineSource(key, 43, 42));
}

TEST_F(DeliveryCoreReferences, PendingCopyTailRetainsIdentityWithoutDispatch) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 71));
  nsMsgKey source, first, second;
  ASSERT_EQ(NS_OK, Add("copy-source@invalid"_ns, {}, source));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(source, mFolderId, 71, 900));
  RawHdr raw;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &first));
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &second));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kMsgCopy;
  input.copyDestinations = {"imap://first"_ns, "imap://second"_ns};
  input.copyDestinationBindings = {
      Some(PendingDestination{mFolderId, first, 71}),
      Some(PendingDestination{mFolderId, second, 71})};
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, input));
  input.operation = 0;
  input.copyDestinations.RemoveElementAt(0);
  input.copyDestinationBindings.RemoveElementAt(0);
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, input));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->MessageDB();
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperation(mFolderId, source, got));
  EXPECT_EQ(0u, got.operation);
  EXPECT_EQ((nsTArray<nsCString>{"imap://second"_ns}), got.copyDestinations);
  ASSERT_EQ(1u, got.copyDestinationBindings.Length());
  ASSERT_TRUE(got.copyDestinationBindings[0]);
  EXPECT_EQ(second, got.copyDestinationBindings[0]->key);
  EXPECT_EQ(mFolderId, got.copyDestinationBindings[0]->folderId);
  EXPECT_EQ(71u, got.copyDestinationBindings[0]->epoch);
  uint64_t attempt = 123;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            reopened.BeginOfflineAttempt(
                mFolderId, source, nsIMsgOfflineImapOperation::kMsgCopy,
                got.copyDestinationBindings[0], attempt));
  EXPECT_EQ(123u, attempt);
  got.operation = nsIMsgOfflineImapOperation::kMsgCopy;
  ASSERT_EQ(NS_OK, reopened.StoreOfflineOperation(mFolderId, source, got));
  ASSERT_EQ(NS_OK, reopened.BeginOfflineAttempt(
                       mFolderId, source, nsIMsgOfflineImapOperation::kMsgCopy,
                       got.copyDestinationBindings[0], attempt));
  got.operation = 0;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            reopened.StoreOfflineOperation(mFolderId, source, got));
  ASSERT_EQ(NS_OK, reopened.MarkOfflineAttemptAmbiguous(attempt));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            reopened.StoreOfflineOperation(mFolderId, source, got));
}

TEST_F(DeliveryCoreReferences, PendingCopyTailStillValidatesPhysicalBinding) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 73));
  nsMsgKey source, destination;
  ASSERT_EQ(NS_OK, Add("tail-control@invalid"_ns, {}, source));
  RawHdr raw;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &destination));
  OfflineOperationData input;
  input.copyDestinations = {"imap://tail"_ns};
  input.copyDestinationBindings = {
      Some(PendingDestination{mFolderId, destination, 73})};
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, input));
  input.copyDestinationBindings[0]->epoch = 74;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.StoreOfflineOperation(mFolderId, source, input));
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, source, got));
  ASSERT_TRUE(got.copyDestinationBindings[0]);
  EXPECT_EQ(73u, got.copyDestinationBindings[0]->epoch);
  EXPECT_EQ(destination, got.copyDestinationBindings[0]->key);
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(destination, mFolderId, 73, 901));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.StoreOfflineOperation(mFolderId, source, got));
}

TEST_F(DeliveryCoreReferences, AccountRootRetirementGuardsPhysicalIdentity) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  auto& messages = mCore->MessageDB();
  nsCString sourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(sourceId));
  uint64_t root, child;
  ASSERT_EQ(NS_OK, folders.InsertRoot("retired-server"_ns, &root));
  ASSERT_EQ(NS_OK, folders.InsertFolder(root, "Saved"_ns, &child));
  RawHdr raw;
  raw.messageId = "retained-account@invalid"_ns;
  raw.subject = "retained subject"_ns;
  raw.storeToken = Some(nsCString("original-token"_ns));
  raw.messageSize = Some(uint32_t(123));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, messages.AddMessage(child, raw, true, &key));
  MessageBodyState before;
  ASSERT_EQ(NS_OK, messages.GetMessageBodyState(key, before));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            DatabaseCore::RetireAccountRoot(root, "retired-server"_ns,
                                            "wrong-db"_ns));
  EXPECT_EQ(NS_ERROR_UNEXPECTED, DatabaseCore::RetireAccountRoot(
                                     root, "another-server"_ns, sourceId));
  EXPECT_EQ(NS_ERROR_UNEXPECTED, folders.DeleteFolder(root));
  auto name = folders.GetFolderName(child);
  ASSERT_TRUE(name.isOk());
  EXPECT_EQ("Saved"_ns, name.unwrap());
  ASSERT_EQ(NS_OK, DatabaseCore::RetireAccountRoot(root, "retired-server"_ns,
                                                   sourceId));
  EXPECT_TRUE(folders.GetFolderName(root).isErr());
  EXPECT_TRUE(folders.GetFolderName(child).isErr());
  CapturedMessage captured;
  ASSERT_EQ(NS_OK, messages.CaptureMessage(key, captured));
  EXPECT_EQ(key, captured.id);
  EXPECT_EQ(child, captured.folderId);
  EXPECT_EQ("retained-account@invalid"_ns, captured.messageId);
  EXPECT_EQ("retained subject"_ns, captured.subject);
  MessageBodyState after;
  ASSERT_EQ(NS_OK, messages.GetMessageBodyState(key, after));
  EXPECT_EQ(child, after.folderId);
  EXPECT_EQ(Some(nsCString("original-token"_ns)), after.storeToken);
  EXPECT_EQ(123u, after.messageSize);
  EXPECT_EQ(before.contentRevision, after.contentRevision);
  EXPECT_EQ(before.locationRevision, after.locationRevision);
  uint64_t replacement;
  ASSERT_EQ(NS_OK, folders.InsertRoot("retired-server"_ns, &replacement));
  EXPECT_GT(replacement, child);
  uint64_t found;
  ASSERT_EQ(NS_OK, folders.GetFolderByPath("retired-server/Saved"_ns, &found));
  EXPECT_EQ(0u, found);
}

TEST_F(DeliveryCoreReferences, FolderDeletionFailureKeepsSqlCacheAndPolicy) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t branch, leaf, control;
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Doomed"_ns, &branch));
  ASSERT_EQ(NS_OK, folders.InsertFolder(branch, "Leaf"_ns, &leaf));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Control"_ns, &control));
  ASSERT_TRUE(folders.GetFolderName(branch).isOk());
  ASSERT_TRUE(folders.GetFolderName(leaf).isOk());
  nsCOMPtr<mozIStorageStatement> watermark;
  ASSERT_EQ(NS_OK,
            mConnection->CreateStatement(
                "SELECT COALESCE(MAX(sequence),0) FROM message_changes"_ns,
                getter_AddRefs(watermark)));
  bool more;
  ASSERT_EQ(NS_OK, watermark->ExecuteStep(&more));
  ASSERT_TRUE(more);
  int64_t before;
  ASSERT_EQ(NS_OK, watermark->GetInt64(0, &before));
  ASSERT_EQ(NS_OK, watermark->Finalize());
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK, mConnection->CreateFunction("folder_fault"_ns, 1, witness));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_folder_delete AFTER DELETE ON folders "
          "BEGIN SELECT folder_fault(OLD.id); SELECT RAISE(ABORT,'folder deletion'); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, folders.DeleteFolder(branch));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_TRUE(witness->mLastKey == int64_t(branch) ||
              witness->mLastKey == int64_t(leaf));
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  auto name = folders.GetFolderName(branch);
  ASSERT_TRUE(name.isOk());
  EXPECT_EQ("Doomed"_ns, name.unwrap());
  name = folders.GetFolderName(leaf);
  ASSERT_TRUE(name.isOk());
  EXPECT_EQ("Leaf"_ns, name.unwrap());
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  nsCOMPtr<mozIStorageStatement> stmt;
  auto close = MakeScopeExit([&] {
    if (stmt) {
      EXPECT_EQ(NS_OK, stmt->Finalize());
    }
    EXPECT_EQ(NS_OK, reader->Close());
  });
  ASSERT_EQ(
      NS_OK,
      reader->CreateStatement(
          "SELECT (SELECT COUNT(*) FROM folders WHERE id IN (:branch,:leaf)), "
          "(SELECT COALESCE(MAX(sequence),0) FROM message_changes)"_ns,
          getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("branch"_ns, branch));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("leaf"_ns, leaf));
  ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
  ASSERT_TRUE(more);
  int64_t count, after;
  ASSERT_EQ(NS_OK, stmt->GetInt64(0, &count));
  ASSERT_EQ(NS_OK, stmt->GetInt64(1, &after));
  EXPECT_EQ(2, count);
  EXPECT_EQ(before, after);
  ASSERT_EQ(NS_OK, stmt->Reset());
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER reject_folder_delete"_ns));
  ASSERT_EQ(NS_OK, folders.DeleteFolder(branch));
  EXPECT_TRUE(folders.GetFolderName(leaf).isErr());
  EXPECT_TRUE(folders.GetFolderName(control).isOk());
}

TEST_F(DeliveryCoreReferences, FolderMutationsLeaveCallerTransactionOwned) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  nsCString sourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(sourceId));
  auto root = folders.GetFolderRoot(mFolderId);
  ASSERT_TRUE(root.isOk());
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  uint64_t output = 123;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            folders.InsertFolder(mFolderId, "Pending"_ns, &output));
  EXPECT_EQ(123u, output);
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, folders.DeleteFolder(mFolderId));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            DatabaseCore::RetireAccountRoot(
                root.unwrap(), "delivery-references"_ns, sourceId));
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  uint64_t found;
  ASSERT_EQ(NS_OK, folders.GetFolderByPath(
                       "delivery-references/Inbox/Pending"_ns, &found));
  EXPECT_EQ(0u, found);
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Pending"_ns, &output));
  ASSERT_EQ(NS_OK, folders.GetFolderByPath(
                       "delivery-references/Inbox/Pending"_ns, &found));
  EXPECT_EQ(output, found);
}

TEST_F(DeliveryCoreReferences, FolderIdsSurviveReopenAndOldOrphanUpgrade) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t removed;
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolderId, "Retired"_ns, &removed));
  RawHdr raw;
  raw.messageId = "old-folder-history@invalid"_ns;
  nsMsgKey message;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(removed, raw, true, &message));
  ASSERT_EQ(NS_OK, mCore->FolderDB().DeleteFolder(removed));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  uint64_t next;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "Next"_ns, &next));
  EXPECT_GT(next, removed);
  ASSERT_EQ(NS_OK, mCore->FolderDB().DeleteFolder(next));
  Stop();
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  // The previous real layout had retained orphan rows but no folder allocator.
  ASSERT_EQ(
      NS_OK,
      old->ExecuteSimpleSQL(
          "DROP TABLE folder_import_windows;"
          "DROP TRIGGER thread_flags_message_delete; DROP TRIGGER "
          "thread_flags_folder_delete;"
          "DROP TABLE thread_flags;"
          "DROP TRIGGER guard_folder_id; DROP TRIGGER record_folder_id;"
          "DROP TRIGGER immutable_folder_id; DROP TABLE folder_id_allocator;"_ns));
  ASSERT_EQ(
      NS_OK,
      old->ExecuteSimpleSQL(
          "DROP TABLE folder_cache_bindings; DROP TABLE folder_cache_imports"_ns));
  ASSERT_EQ(NS_OK, RemovePost15OfflineColumns(old));
  ASSERT_EQ(NS_OK, old->SetSchemaVersion(11));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolderId, "Fresh"_ns, &next));
  EXPECT_GT(next, removed);
  CapturedMessage captured;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(message, captured));
  EXPECT_EQ(removed, captured.folderId);
  EXPECT_EQ("old-folder-history@invalid"_ns, captured.messageId);
}

TEST_F(DeliveryCoreReferences, RetiredFolderDatabaseCannotMutateReopenedCore) {
  ASSERT_EQ(NS_OK, Start());
  RefPtr<FolderDatabase> old = &mCore->FolderDB();
  ASSERT_TRUE(old->GetFolderName(mFolderId).isOk());
  Stop();
  ASSERT_EQ(NS_OK, Start());
  uint64_t output = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            old->InsertFolder(mFolderId, "Old writer"_ns, &output));
  EXPECT_EQ(123u, output);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, old->DeleteFolder(mFolderId));
  uint64_t found;
  ASSERT_EQ(NS_OK, mCore->FolderDB().GetFolderByPath(
                       "delivery-references/Inbox/Old%20writer"_ns, &found));
  EXPECT_EQ(0u, found);
  EXPECT_TRUE(mCore->FolderDB().GetFolderName(mFolderId).isOk());
}

TEST_F(DeliveryCoreReferences,
       FolderAllocationFailureLeavesOutputAndRowsIntact) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t output = 123;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            folders.InsertFolder(UINT64_MAX, "Invalid parent"_ns, &output));
  EXPECT_EQ(123u, output);
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "UPDATE folder_id_allocator SET highWater=9223372036854775807"_ns));
  EXPECT_EQ(NS_ERROR_ILLEGAL_VALUE,
            folders.InsertFolder(mFolderId, "Exhausted"_ns, &output));
  EXPECT_EQ(123u, output);
  uint64_t found;
  ASSERT_EQ(NS_OK, folders.GetFolderByPath(
                       "delivery-references/Inbox/Exhausted"_ns, &found));
  EXPECT_EQ(0u, found);
  EXPECT_TRUE(folders.GetFolderName(mFolderId).isOk());
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
}
TEST_F(DeliveryCoreReferences, ThreadOrderKeepsOrphansAndForeignConnectors) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  uint64_t otherFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "Other"_ns,
                                                  &otherFolder));
  nsMsgKey root, branch, child, sibling, grandchild, control, thread;
  ASSERT_EQ(NS_OK, Add("order-root@invalid"_ns, {}, root));
  RawHdr foreign;
  foreign.messageId = "foreign-branch@invalid"_ns;
  foreign.references = {"order-root@invalid"_ns};
  ASSERT_EQ(NS_OK, db.AddMessage(otherFolder, foreign, true, &branch));
  ASSERT_EQ(NS_OK,
            Add("local-child@invalid"_ns,
                {"order-root@invalid"_ns, "foreign-branch@invalid"_ns}, child));
  ASSERT_EQ(NS_OK,
            Add("sibling@invalid"_ns, {"order-root@invalid"_ns}, sibling));
  ASSERT_EQ(NS_OK,
            Add("grandchild@invalid"_ns,
                {"order-root@invalid"_ns, "sibling@invalid"_ns}, grandchild));
  ASSERT_EQ(NS_OK, Add("unrelated@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(root, thread));
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, ThreadKeys(mFolderId, 0, thread, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{root, child, sibling, grandchild}), keys);
  ASSERT_EQ(NS_OK, ThreadKeys(mFolderId, branch, thread, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{child}), keys);
  ASSERT_EQ(NS_OK, ThreadChildren(mFolderId, root, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{sibling}), keys);
  ASSERT_EQ(NS_OK, db.RemoveMessage(root));
  ASSERT_EQ(NS_OK, ThreadKeys(mFolderId, 0, thread, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{child, sibling, grandchild}), keys);
  ASSERT_EQ(NS_OK, db.RemoveMessage(branch));
  ASSERT_EQ(NS_OK, db.RemoveMessage(sibling));
  ASSERT_EQ(NS_OK, ThreadKeys(mFolderId, 0, thread, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{child, grandchild}), keys);
  uint64_t count, date;
  ASSERT_EQ(NS_OK, ThreadCount(mFolderId, thread, &count));
  EXPECT_EQ(2u, count);
  ASSERT_EQ(NS_OK, ThreadMaxDate(mFolderId, thread, &date));
  EXPECT_EQ(123456u, date);
  CapturedMessage captured;
  ASSERT_EQ(NS_OK, db.CaptureMessage(grandchild, captured));
  EXPECT_EQ(sibling, captured.threadParent);
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreReferences,
       ThreadReadErrorsPreserveOutputsAndCallerTransaction) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey root, child, thread, control;
  ASSERT_EQ(NS_OK, Add("read-root@invalid"_ns, {}, root));
  ASSERT_EQ(NS_OK,
            Add("late-fault@invalid"_ns, {"read-root@invalid"_ns}, child));
  ASSERT_EQ(NS_OK, Add("read-control@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(root, thread));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active;
    if (NS_SUCCEEDED(mConnection->GetTransactionInProgress(&active)) &&
        active) {
      EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
    }
  });
  ASSERT_EQ(NS_OK, db.SetMessageProperty(control, "caller"_ns, "retained"_ns));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP VIEW messages AS SELECT * FROM main.messages WHERE "
          "CASE WHEN messageId='late-fault@invalid' THEN "
          "abs(-9223372036854775808) "
          "ELSE 1 END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.messages"_ns));
  });
  nsTArray<nsMsgKey> children{77, 88}, members{99};
  EXPECT_EQ(NS_ERROR_FAILURE, ThreadChildren(mFolderId, root, children));
  EXPECT_EQ((nsTArray<nsMsgKey>{77, 88}), children);
  EXPECT_EQ(NS_ERROR_FAILURE, ThreadKeys(mFolderId, 0, thread, members));
  EXPECT_EQ((nsTArray<nsMsgKey>{99}), members);
  uint64_t count = 444, date = 555;
  EXPECT_EQ(NS_ERROR_FAILURE, ThreadCount(mFolderId, thread, &count));
  EXPECT_EQ(444u, count);
  EXPECT_EQ(NS_ERROR_FAILURE, ThreadMaxDate(mFolderId, thread, &date));
  EXPECT_EQ(555u, date);
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL("DROP VIEW temp.messages"_ns));
  ASSERT_EQ(NS_OK, ThreadChildren(mFolderId, root, children));
  EXPECT_EQ((nsTArray<nsMsgKey>{child}), children);
  ASSERT_EQ(NS_OK, ThreadKeys(mFolderId, 0, thread, members));
  EXPECT_EQ((nsTArray<nsMsgKey>{root, child}), members);
  ASSERT_EQ(NS_OK, ThreadCount(mFolderId, thread, &count));
  EXPECT_EQ(2u, count);
  ASSERT_EQ(NS_OK, ThreadMaxDate(mFolderId, thread, &date));
  EXPECT_EQ(123456u, date);
  ASSERT_EQ(NS_OK, mConnection->CommitTransaction());
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(control, "caller"_ns, text));
  EXPECT_EQ("retained"_ns, text);
}

TEST_F(DeliveryCoreReferences, ThreadReadsRejectInvalidKeysAndParentCycles) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey root, child, thread;
  ASSERT_EQ(NS_OK, Add("cycle-root@invalid"_ns, {}, root));
  ASSERT_EQ(NS_OK,
            Add("cycle-child@invalid"_ns, {"cycle-root@invalid"_ns}, child));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(root, thread));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "CREATE TEMP VIEW messages AS SELECT 4294967295 AS id,folderId,"
                "threadId,threadParent FROM main.messages"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.messages"_ns));
  });
  nsTArray<nsMsgKey> keys{77};
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, ThreadChildren(mFolderId, root, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{77}), keys);
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, ThreadKeys(mFolderId, 0, thread, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{77}), keys);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL("DROP VIEW temp.messages"_ns));
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(NS_OK, mConnection->CreateStatement(
                       "UPDATE messages SET threadParent=id WHERE id=:id"_ns,
                       getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, root));
  ASSERT_EQ(NS_OK, stmt->Execute());
  ASSERT_EQ(NS_OK, stmt->Finalize());
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, ThreadKeys(mFolderId, 0, thread, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{77}), keys);
  ASSERT_EQ(NS_OK, mConnection->CreateStatement(
                       "UPDATE messages SET threadParent=0 WHERE id=:id"_ns,
                       getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, root));
  ASSERT_EQ(NS_OK, stmt->Execute());
  ASSERT_EQ(NS_OK, stmt->Finalize());
  ASSERT_EQ(NS_OK, ThreadKeys(mFolderId, 0, thread, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{root, child}), keys);
}

TEST_F(DeliveryCoreReferences, ThreadFlagsAreScopedAndSeparateFromHeaderFlags) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  uint64_t otherFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "FlagsOther"_ns,
                                                  &otherFolder));
  nsMsgKey root, other, thread;
  ASSERT_EQ(NS_OK, Add("flags-root@invalid"_ns, {}, root));
  RawHdr raw;
  raw.messageId = "flags-other@invalid"_ns;
  raw.references = {"flags-root@invalid"_ns};
  ASSERT_EQ(NS_OK, db.AddMessage(otherFolder, raw, true, &other));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(root, thread));
  uint32_t flags = 99;
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(0u, flags);
  ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, thread, UINT32_MAX));
  ASSERT_EQ(NS_OK,
            db.SetThreadFlags(otherFolder, thread, nsMsgMessageFlags::Watched));
  ASSERT_EQ(NS_OK, db.GetMessageFlags(root, flags));
  EXPECT_EQ(0u, flags);
  ASSERT_EQ(NS_OK, db.GetMessageFlags(other, flags));
  EXPECT_EQ(0u, flags);
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(UINT32_MAX, flags);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetThreadFlags(otherFolder, thread, flags));
  EXPECT_EQ(nsMsgMessageFlags::Watched, flags);
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  nsCOMPtr<mozIStorageStatement> stmt;
  auto close = MakeScopeExit([&] {
    if (stmt) {
      EXPECT_EQ(NS_OK, stmt->Finalize());
    }
    EXPECT_EQ(NS_OK, reader->Close());
  });
  ASSERT_EQ(
      NS_OK,
      reader->CreateStatement(
          "SELECT flags FROM thread_flags WHERE folderId=:folder AND threadId=:thread"_ns,
          getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("folder"_ns, mFolderId));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("thread"_ns, thread));
  bool more;
  ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
  ASSERT_TRUE(more);
  int64_t stored;
  ASSERT_EQ(NS_OK, stmt->GetInt64(0, &stored));
  EXPECT_EQ(int64_t(UINT32_MAX), stored);
}

TEST_F(DeliveryCoreReferences, ThreadFlagsSurviveRootUntilLastScopedMember) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey root, child, thread;
  ASSERT_EQ(NS_OK, Add("state-root@invalid"_ns, {}, root));
  ASSERT_EQ(NS_OK,
            Add("state-child@invalid"_ns, {"state-root@invalid"_ns}, child));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(root, thread));
  ASSERT_EQ(NS_OK,
            db.SetThreadFlags(mFolderId, thread, nsMsgMessageFlags::Ignored));
  ASSERT_EQ(NS_OK, db.RemoveMessage(root));
  uint32_t flags;
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(nsMsgMessageFlags::Ignored, flags);
  ASSERT_EQ(NS_OK, db.RemoveMessage(child));
  flags = 99;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(99u, flags);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.SetThreadFlags(mFolderId, thread, 1));
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(NS_OK,
            mConnection->CreateStatement("SELECT COUNT(*) FROM thread_flags"_ns,
                                         getter_AddRefs(stmt)));
  bool more;
  ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
  ASSERT_TRUE(more);
  int64_t count;
  ASSERT_EQ(NS_OK, stmt->GetInt64(0, &count));
  EXPECT_EQ(0, count);
  ASSERT_EQ(NS_OK, stmt->Finalize());
}

TEST_F(DeliveryCoreReferences,
       ThreadFlagWriteFailureLeavesCallerAndWordIntact) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey root, thread, control;
  ASSERT_EQ(NS_OK, Add("word-root@invalid"_ns, {}, root));
  ASSERT_EQ(NS_OK, Add("word-control@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(root, thread));
  ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, thread, 0x80000000));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active;
    if (NS_SUCCEEDED(mConnection->GetTransactionInProgress(&active)) &&
        active) {
      EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
    }
  });
  ASSERT_EQ(NS_OK, db.SetMessageProperty(control, "caller"_ns, "retained"_ns));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.SetThreadFlags(mFolderId, thread, 1));
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->CommitTransaction());
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER fail_thread_word BEFORE UPDATE ON thread_flags "
          "BEGIN SELECT RAISE(ABORT,'thread word failure'); END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS fail_thread_word"_ns));
  });
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.SetThreadFlags(mFolderId, thread, 1));
  uint32_t flags;
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(0x80000000u, flags);
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(control, "caller"_ns, text));
  EXPECT_EQ("retained"_ns, text);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER fail_thread_word"_ns));
  ASSERT_EQ(NS_OK,
            db.SetThreadFlags(mFolderId, thread, nsMsgMessageFlags::Watched));
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(nsMsgMessageFlags::Watched, flags);
}

TEST_F(DeliveryCoreReferences, ThreadFlagReadFailureLeavesOutputAndStoredWord) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey root, thread;
  ASSERT_EQ(NS_OK, Add("word-read@invalid"_ns, {}, root));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(root, thread));
  ASSERT_EQ(NS_OK,
            db.SetThreadFlags(mFolderId, thread, nsMsgMessageFlags::Ignored));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP VIEW thread_flags AS SELECT folderId,threadId,"
          "abs(-9223372036854775808) AS flags FROM main.thread_flags"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.thread_flags"_ns));
  });
  uint32_t flags = 0xabcdef12;
  EXPECT_EQ(NS_ERROR_FAILURE, db.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(0xabcdef12u, flags);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP VIEW temp.thread_flags"_ns));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "CREATE TEMP VIEW thread_flags AS SELECT folderId,threadId,"
                "4294967296 AS flags FROM main.thread_flags"_ns));
  flags = 0x12345678;
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            db.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(0x12345678u, flags);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP VIEW temp.thread_flags"_ns));
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(nsMsgMessageFlags::Ignored, flags);
}

TEST_F(DeliveryCoreReferences, ThreadFlagsUpgradeDoesNotInferHeaderIgnored) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey root, thread;
  ASSERT_EQ(NS_OK, Add("old-thread@invalid"_ns, {"absent@invalid"_ns}, root));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageThreadId(root, thread));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageFlag(
                       root, nsMsgMessageFlags::Ignored, true));
  Stop();
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK,
            old->ExecuteSimpleSQL("DROP TABLE folder_import_windows;"
                                  "DROP TRIGGER thread_flags_message_delete; "
                                  "DROP TRIGGER thread_flags_folder_delete;"
                                  "DROP TABLE thread_flags"_ns));
  ASSERT_EQ(
      NS_OK,
      old->ExecuteSimpleSQL(
          "DROP TABLE folder_cache_bindings; DROP TABLE folder_cache_imports"_ns));
  ASSERT_EQ(NS_OK, RemovePost15OfflineColumns(old));
  ASSERT_EQ(NS_OK, old->SetSchemaVersion(12));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
  uint32_t flags = 99;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(0u, flags);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageFlags(root, flags));
  EXPECT_TRUE(flags & nsMsgMessageFlags::Ignored);
  nsTArray<nsCString> refs;
  ASSERT_EQ(NS_OK, Stored(root, refs));
  EXPECT_EQ((nsTArray<nsCString>{"absent@invalid"_ns}), refs);
}

TEST_F(DeliveryCoreReferences, ThreadFlagsRequirePhysicalFolderAndMembership) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key, thread;
  ASSERT_EQ(NS_OK, Add("physical-word@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(key, thread));
  uint64_t emptyFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "EmptyFlags"_ns,
                                                  &emptyFolder));
  uint32_t flags = 0x76543210;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetThreadFlags(emptyFolder, thread, flags));
  EXPECT_EQ(0x76543210u, flags);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.SetThreadFlags(emptyFolder, thread, 7));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.GetThreadFlags(0, thread, flags));
  EXPECT_EQ(0x76543210u, flags);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.SetThreadFlags(0, thread, 7));
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(0u, flags);
}

TEST_F(DeliveryCoreReferences, ConversationPlanOrderedCrossFolderChain) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t b;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "B"_ns, &b));
  nsMsgKey root, reply, tail, unrelated;
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "ordered-root@conversation.invalid"_ns, {}, root));
  ASSERT_EQ(NS_OK, AddAt(b, "ordered-reply@conversation.invalid"_ns,
                         {"ordered-root@conversation.invalid"_ns}, reply));
  ASSERT_EQ(NS_OK, AddAt(mFolderId, "ordered-tail@conversation.invalid"_ns,
                         {"ordered-root@conversation.invalid"_ns,
                          "ordered-reply@conversation.invalid"_ns},
                         tail));
  ASSERT_EQ(NS_OK, AddAt(b, "ordered-unrelated@conversation.invalid"_ns, {},
                         unrelated));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  MessageThreadBatch batch;
  ASSERT_EQ(NS_OK, PlanConversation(tail, true, batch));
  ASSERT_EQ(3u, batch.after.Length());
  ASSERT_EQ(2u, batch.before.Length());
  EXPECT_TRUE(batch.changedKeys.IsEmpty());
  ASSERT_TRUE(Planned(batch, root) && Planned(batch, reply) &&
              Planned(batch, tail));
  EXPECT_FALSE(Planned(batch, unrelated));
  EXPECT_EQ(root, Planned(batch, root)->threadId);
  EXPECT_EQ(0u, Planned(batch, root)->threadParent);
  EXPECT_EQ(root, Planned(batch, reply)->threadId);
  EXPECT_EQ(root, Planned(batch, reply)->threadParent);
  EXPECT_EQ(root, Planned(batch, tail)->threadId);
  EXPECT_EQ(reply, Planned(batch, tail)->threadParent);
  EXPECT_EQ(b, Planned(batch, reply)->folderId);
  EXPECT_EQ(mFolderId, Planned(batch, tail)->folderId);
}

TEST_F(DeliveryCoreReferences, ConversationPlanReplyBeforeParent) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t b;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "B"_ns, &b));
  nsMsgKey unrelated, reply, parent;
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "reply-first-unrelated@conversation.invalid"_ns,
                  {}, unrelated));
  ASSERT_EQ(NS_OK,
            AddAt(b, "reply-first-child@conversation.invalid"_ns,
                  {"reply-first-parent@conversation.invalid"_ns}, reply));
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "reply-first-parent@conversation.invalid"_ns, {},
                  parent));
  CapturedMessage before;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(reply, before));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  MessageThreadBatch batch;
  ASSERT_EQ(NS_OK, PlanConversation(parent, false, batch));
  ASSERT_EQ(2u, batch.after.Length());
  EXPECT_EQ((nsTArray<nsMsgKey>{reply}), batch.changedKeys);
  EXPECT_FALSE(batch.notifyLegacy);
  EXPECT_EQ(parent, batch.publicationKey);
  ASSERT_TRUE(Planned(batch, reply) && Planned(batch, parent));
  EXPECT_FALSE(Planned(batch, unrelated));
  EXPECT_EQ(parent, Planned(batch, reply)->threadId);
  EXPECT_EQ(parent, Planned(batch, reply)->threadParent);
  EXPECT_EQ(parent, Planned(batch, parent)->threadId);
  EXPECT_EQ(0u, Planned(batch, parent)->threadParent);
  CapturedMessage stored;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(reply, stored));
  EXPECT_EQ(before.threadId, stored.threadId);
  EXPECT_EQ(before.threadParent, stored.threadParent);
  EXPECT_EQ(before.flags, stored.flags);
  EXPECT_EQ(before.subject, stored.subject);
  nsTArray<nsCString> refs;
  ASSERT_EQ(NS_OK, Stored(reply, refs));
  EXPECT_EQ((nsTArray<nsCString>{"reply-first-parent@conversation.invalid"_ns}),
            refs);
}

TEST_F(DeliveryCoreReferences, ConversationPlanSiblingsWithMissingParent) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t b;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "B"_ns, &b));
  nsMsgKey unrelated, first, second;
  ASSERT_EQ(NS_OK, AddAt(mFolderId,
                         "siblings-missing-unrelated@conversation.invalid"_ns,
                         {}, unrelated));
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "siblings-missing-first@conversation.invalid"_ns,
                  {"siblings-missing-parent@conversation.invalid"_ns}, first));
  ASSERT_EQ(NS_OK,
            AddAt(b, "siblings-missing-second@conversation.invalid"_ns,
                  {"siblings-missing-parent@conversation.invalid"_ns}, second));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  MessageThreadBatch batch;
  ASSERT_EQ(NS_OK, PlanConversation(second, true, batch));
  ASSERT_EQ(2u, batch.after.Length());
  ASSERT_TRUE(Planned(batch, first) && Planned(batch, second));
  EXPECT_FALSE(Planned(batch, unrelated));
  EXPECT_EQ(first, Planned(batch, first)->threadId);
  EXPECT_EQ(first, Planned(batch, second)->threadId);
  EXPECT_EQ(0u, Planned(batch, first)->threadParent);
  EXPECT_EQ(0u, Planned(batch, second)->threadParent);
  EXPECT_TRUE(batch.changedKeys.IsEmpty());
}

TEST_F(DeliveryCoreReferences, ConversationPlanSiblingsThenParent) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t b;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "B"_ns, &b));
  nsMsgKey first, second, unrelated, parent;
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "siblings-late-first@conversation.invalid"_ns,
                  {"siblings-late-parent@conversation.invalid"_ns}, first));
  ASSERT_EQ(NS_OK,
            AddAt(b, "siblings-late-second@conversation.invalid"_ns,
                  {"siblings-late-parent@conversation.invalid"_ns}, second));
  ASSERT_EQ(NS_OK, AddAt(b, "siblings-late-unrelated@conversation.invalid"_ns,
                         {}, unrelated));
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "siblings-late-parent@conversation.invalid"_ns, {},
                  parent));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  MessageThreadBatch batch;
  ASSERT_EQ(NS_OK, PlanConversation(parent, true, batch));
  ASSERT_EQ(3u, batch.after.Length());
  EXPECT_EQ((nsTArray<nsMsgKey>{first, second}), batch.changedKeys);
  ASSERT_TRUE(Planned(batch, first) && Planned(batch, second) &&
              Planned(batch, parent));
  EXPECT_FALSE(Planned(batch, unrelated));
  EXPECT_EQ(parent, Planned(batch, first)->threadId);
  EXPECT_EQ(parent, Planned(batch, second)->threadId);
  EXPECT_EQ(parent, Planned(batch, first)->threadParent);
  EXPECT_EQ(parent, Planned(batch, second)->threadParent);
  EXPECT_EQ(parent, Planned(batch, parent)->threadId);
  EXPECT_EQ(0u, Planned(batch, parent)->threadParent);
}

TEST_F(DeliveryCoreReferences, ConversationPlanKeepsCopiesAndExactHistory) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t b;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "B"_ns, &b));
  nsMsgKey first, copy, ownIdOnly, incoming;
  ASSERT_EQ(NS_OK, AddAt(mFolderId, "copies-parent"_ns, {}, first));
  ASSERT_EQ(NS_OK, AddAt(b, "copies-parent"_ns, {}, copy));
  ASSERT_EQ(NS_OK, AddAt(b, "copies-child"_ns, {}, ownIdOnly));
  nsTArray<nsCString> expected{""_ns, "copies-parent"_ns, "copies-parent"_ns,
                               "unresolved"_ns};
  ASSERT_EQ(NS_OK, AddAt(mFolderId, "copies-child"_ns, expected, incoming));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  MessageThreadBatch batch;
  ASSERT_EQ(NS_OK, PlanConversation(incoming, true, batch));
  ASSERT_EQ(3u, batch.after.Length());
  ASSERT_TRUE(Planned(batch, first) && Planned(batch, copy) &&
              Planned(batch, incoming));
  EXPECT_FALSE(Planned(batch, ownIdOnly));
  EXPECT_EQ(b, Planned(batch, copy)->folderId);
  EXPECT_EQ(first, Planned(batch, incoming)->threadParent);
  EXPECT_EQ(first, Planned(batch, first)->threadId);
  EXPECT_EQ(first, Planned(batch, copy)->threadId);
  EXPECT_EQ(first, Planned(batch, incoming)->threadId);
  nsTArray<nsCString> stored;
  ASSERT_EQ(NS_OK, Stored(incoming, stored));
  EXPECT_EQ(expected, stored);
  CapturedMessage other;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(ownIdOnly, other));
  EXPECT_EQ(ownIdOnly, other.threadId);
}

TEST_F(DeliveryCoreReferences, ConversationPlanFailurePreservesOutputAndOwner) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey seed, control;
  ASSERT_EQ(NS_OK, AddAt(mFolderId, "plan-seed"_ns, {"missing"_ns}, seed));
  ASSERT_EQ(NS_OK, AddAt(mFolderId, "plan-control"_ns, {}, control));
  MessageThreadBatch batch;
  batch.batchId = 71;
  batch.publicationKey = 77;
  batch.after.SetLength(1);
  batch.after[0].subject = "sentinel"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, PlanConversation(seed, true, batch));
  EXPECT_EQ(71u, batch.batchId);
  EXPECT_EQ(77u, batch.publicationKey);
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(control, "caller"_ns,
                                                         "retained"_ns));
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(NS_OK, mConnection->CreateStatement(
                       "DELETE FROM message_reference_sets WHERE id=:id"_ns,
                       getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, control));
  ASSERT_EQ(NS_OK, stmt->Execute());
  ASSERT_EQ(NS_OK, stmt->Finalize());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, PlanConversation(seed, true, batch));
  EXPECT_EQ(71u, batch.batchId);
  EXPECT_EQ(77u, batch.publicationKey);
  ASSERT_EQ(1u, batch.after.Length());
  EXPECT_EQ("sentinel"_ns, batch.after[0].subject);
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  nsCString text;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessageProperty(control, "caller"_ns, text));
  EXPECT_EQ("retained"_ns, text);
}

TEST_F(DeliveryCoreReferences, ConversationPlanReadFailureIsNotAnEmptyPlan) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey seed;
  ASSERT_EQ(NS_OK, AddAt(mFolderId, "plan-fault"_ns, {"missing"_ns}, seed));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP VIEW message_references AS SELECT id,ordinal,"
          "abs(-9223372036854775808) AS token FROM main.message_references"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.message_references"_ns));
  });
  MessageThreadBatch batch;
  batch.publicationKey = 77;
  EXPECT_EQ(NS_ERROR_FAILURE, PlanConversation(seed, true, batch));
  EXPECT_EQ(77u, batch.publicationKey);
  EXPECT_TRUE(batch.after.IsEmpty());
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.message_references"_ns));
  ASSERT_EQ(NS_OK, PlanConversation(seed, true, batch));
  ASSERT_EQ(1u, batch.after.Length());
  EXPECT_EQ(seed, batch.publicationKey);
  EXPECT_EQ(seed, batch.after[0].threadId);
  EXPECT_EQ(0u, batch.after[0].threadParent);
}

TEST_F(DeliveryCoreReferences, ConversationPlanDoesNotCloseReferenceCycle) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey first, second;
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "cycle-first"_ns, {"cycle-second"_ns}, first));
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "cycle-second"_ns, {"cycle-first"_ns}, second));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  MessageThreadBatch batch;
  ASSERT_EQ(NS_OK, PlanConversation(second, true, batch));
  ASSERT_EQ(2u, batch.after.Length());
  const auto* a = Planned(batch, first);
  const auto* b = Planned(batch, second);
  ASSERT_TRUE(a && b);
  EXPECT_TRUE((a->threadParent == 0 && b->threadParent == first) ||
              (b->threadParent == 0 && a->threadParent == second));
  EXPECT_EQ(a->threadId, b->threadId);
  EXPECT_EQ(a->threadParent == 0 ? first : second, a->threadId);
  nsTArray<nsCString> refs;
  ASSERT_EQ(NS_OK, Stored(first, refs));
  EXPECT_EQ((nsTArray<nsCString>{"cycle-second"_ns}), refs);
  refs.Clear();
  ASSERT_EQ(NS_OK, Stored(second, refs));
  EXPECT_EQ((nsTArray<nsCString>{"cycle-first"_ns}), refs);
}

TEST_F(DeliveryCoreReferences, GroupImmediateFailureRollsBackHotMembers) {
  ASSERT_NO_FATAL_FAILURE(CheckGroupingRollback(false));
}

TEST_F(DeliveryCoreReferences, GroupStagedFailureRetainsUnpublishedHeader) {
  ASSERT_NO_FATAL_FAILURE(CheckGroupingRollback(true));
}

TEST_F(DeliveryCoreReferences, GroupUnknownListenerRejectsBeforeSuccess) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  nsMsgKey child;
  ASSERT_EQ(NS_OK, Add("unaware-child"_ns, {"unaware-parent"_ns}, child));
  uint32_t calls = 0;
  RefPtr<AddedObserver> unaware = new AddedObserver([&](Message*) { ++calls; });
  db.AddMessageListener(unaware);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(unaware); });
  nsMsgKey output = nsMsgKey_None;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, Add("unaware-parent"_ns, {}, output));
  EXPECT_EQ(nsMsgKey_None, output);
  EXPECT_EQ(0u, calls);
  CapturedMessage row;
  ASSERT_EQ(NS_OK, db.CaptureMessage(child, row));
  EXPECT_EQ(0u, row.threadParent);
  uint64_t count;
  ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
  EXPECT_EQ(1u, count);
  db.RemoveMessageListener(unaware);
  ASSERT_EQ(NS_OK, Add("unaware-parent"_ns, {}, output));
  ASSERT_EQ(NS_OK, db.CaptureMessage(child, row));
  EXPECT_EQ(output, row.threadId);
  EXPECT_EQ(output, row.threadParent);
}

TEST_F(DeliveryCoreReferences, GroupUnknownHistoryIsNotAnEmptySingleton) {
  ASSERT_EQ(NS_OK, StartGrouping());
  nsMsgKey old;
  ASSERT_EQ(NS_OK, Add("history-row"_ns, {}, old));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DELETE FROM message_reference_sets"_ns));
  nsMsgKey output = nsMsgKey_None;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, Add("new-known-empty"_ns, {}, output));
  EXPECT_EQ(nsMsgKey_None, output);
  uint64_t count;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(1u, count);
  nsTArray<nsCString> refs{"sentinel"_ns};
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->MessageDB().GetMessageReferences(old, refs));
  EXPECT_EQ((nsTArray<nsCString>{"sentinel"_ns}), refs);
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
}

TEST_F(DeliveryCoreReferences,
       GroupReentrantChangesFollowWholeHistoricalBatch) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  nsMsgKey child;
  ASSERT_EQ(NS_OK, Add("queue-child"_ns, {"queue-parent"_ns}, child));
  RefPtr<Message> hot = new Message(child);
  nsMsgKey beforeThread;
  ASSERT_EQ(NS_OK, hot->GetThreadId(&beforeThread));
  nsTArray<nsCString> order;
  RefPtr<ThreadQueueObserver> a = new ThreadQueueObserver(),
                              b = new ThreadQueueObserver();
  nsMsgKey publication = nsMsgKey_None, nested = nsMsgKey_None;
  bool reentered = false;
  auto record = [&](const char* name, char kind, const CapturedMessage& before,
                    const CapturedMessage& after, Message* live, bool notify) {
    nsAutoCString label(name);
    label.Append(kind == 'P' && after.messageId == "nested-row"_ns ? 'N'
                                                                   : kind);
    order.AppendElement(label);
    if (kind == 'T') {
      EXPECT_EQ(child, after.id);
      EXPECT_EQ(beforeThread, before.threadId);
      EXPECT_EQ(publication, after.threadId);
      EXPECT_EQ(publication, after.threadParent);
      nsMsgKey current;
      EXPECT_EQ(NS_OK, hot->GetThreadId(&current));
      EXPECT_EQ(publication, current);
    }
    if (kind == 'P' && after.id == publication) {
      EXPECT_FALSE(notify);
      EXPECT_EQ(0u, after.flags);
      EXPECT_EQ("before"_ns, after.tags);
      bool exists = true;
      EXPECT_EQ(NS_OK, db.MessageExists(publication, exists));
      EXPECT_FALSE(exists);
      nsCString subject;
      EXPECT_EQ(NS_OK, live->GetSubject(subject));
      EXPECT_EQ("parent"_ns, subject);
    }
    if (kind == 'F') {
      EXPECT_EQ(0u, before.flags);
      EXPECT_EQ(nsMsgMessageFlags::Read, after.flags);
    }
    if (kind == 'G') {
      EXPECT_EQ("before"_ns, before.tags);
      EXPECT_EQ("after"_ns, after.tags);
      EXPECT_EQ(nsMsgMessageFlags::Read, after.flags);
    }
    if (kind == 'B') {
      EXPECT_EQ(nsMsgMessageFlags::Read, before.flags);
      EXPECT_EQ(uint32_t(nsMsgMessageFlags::Read | nsMsgMessageFlags::Offline),
                after.flags);
    }
    if (kind == 'R') {
      EXPECT_EQ(uint32_t(nsMsgMessageFlags::Read | nsMsgMessageFlags::Offline),
                before.flags);
    }
  };
  a->action = [&](char kind, const auto& before, const auto& after,
                  Message* live, bool notify) {
    record("A", kind, before, after, live, notify);
    if (kind != 'T' || reentered) {
      return;
    }
    reentered = true;
    EXPECT_EQ(NS_OK, db.SetMessageFlags(publication, nsMsgMessageFlags::Read));
    EXPECT_EQ(NS_OK, db.SetMessageTags(publication, "after"_ns));
    MessageBodyState body;
    ASSERT_EQ(NS_OK, db.GetMessageBodyState(publication, body));
    FinishedMessageBody finished;
    finished.storeToken = "after-token"_ns;
    finished.messageSize = 2;
    finished.offline = true;
    MessageBodyState settled;
    ASSERT_EQ(NS_OK, db.SettleMessageBody(body, finished, settled));
    EXPECT_EQ("after-token"_ns, *settled.storeToken);
    EXPECT_EQ(NS_OK, db.RemoveMessage(publication));
    EXPECT_EQ(NS_OK, Add("nested-row"_ns, {}, nested));
    EXPECT_EQ(1u, order.Length());
  };
  b->action = [&](char kind, const auto& before, const auto& after,
                  Message* live, bool notify) {
    record("B", kind, before, after, live, notify);
  };
  db.AddMessageListener(a);
  db.AddMessageListener(b);
  auto unwatch = MakeScopeExit([&] {
    db.RemoveMessageListener(a);
    db.RemoveMessageListener(b);
  });
  RawHdr parent;
  parent.messageId = "queue-parent"_ns;
  parent.subject = "parent"_ns;
  parent.keywords = "before"_ns;
  parent.storeToken = Some(nsCString("before-token"_ns));
  parent.messageSize = Some(1u);
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, parent, false, &publication));
  EXPECT_TRUE(reentered);
  EXPECT_EQ((nsTArray<nsCString>{"AT"_ns, "AP"_ns, "BT"_ns, "BP"_ns, "AF"_ns,
                                 "BF"_ns, "AG"_ns, "BG"_ns, "AB"_ns, "BB"_ns,
                                 "AR"_ns, "BR"_ns, "AN"_ns, "BN"_ns}),
            order);
  EXPECT_EQ(0u, a->ordinary + b->ordinary);
  EXPECT_EQ(Some(nsCString("before-token"_ns)), a->oldBody.storeToken);
  EXPECT_EQ(Some(nsCString("after-token"_ns)), b->newBody.storeToken);
  uint64_t count;
  ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
  EXPECT_EQ(2u, count);
}

TEST_F(DeliveryCoreReferences,
       GroupListenerReattachmentDoesNotReceiveOldBatch) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  nsMsgKey child;
  ASSERT_EQ(NS_OK, Add("reattach-child"_ns, {"reattach-parent"_ns}, child));
  RefPtr<ThreadQueueObserver> a = new ThreadQueueObserver(),
                              b = new ThreadQueueObserver();
  nsTArray<char> seen;
  b->action = [&](char kind, const auto&, const auto&, Message*, bool) {
    seen.AppendElement(kind);
  };
  a->action = [&](char kind, const auto&, const auto&, Message*, bool) {
    if (kind != 'T') {
      return;
    }
    db.RemoveMessageListener(b);
    db.AddMessageListener(b);
    EXPECT_EQ(NS_OK, db.SetMessageFlags(child, nsMsgMessageFlags::Read));
  };
  db.AddMessageListener(a);
  db.AddMessageListener(b);
  auto unwatch = MakeScopeExit([&] {
    db.RemoveMessageListener(a);
    db.RemoveMessageListener(b);
  });
  nsMsgKey parent;
  ASSERT_EQ(NS_OK, Add("reattach-parent"_ns, {}, parent));
  EXPECT_EQ((nsTArray<char>{'F'}), seen);
}

TEST_F(DeliveryCoreReferences, OrdinaryPublicationQueuesReentrantFlagFanout) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  RefPtr<ThreadQueueObserver> a = new ThreadQueueObserver(),
                              b = new ThreadQueueObserver();
  nsTArray<nsCString> order;
  a->action = [&](char kind, const auto&, const auto& after, Message*, bool) {
    order.AppendElement(kind == 'P' ? "AP"_ns : "AF"_ns);
    if (kind == 'P') {
      EXPECT_EQ(NS_OK, db.SetMessageFlags(after.id, nsMsgMessageFlags::Read));
    }
  };
  b->action = [&](char kind, const auto&, const auto& after, Message*, bool) {
    order.AppendElement(kind == 'P' ? "BP"_ns : "BF"_ns);
    EXPECT_EQ(kind == 'P' ? 0u : nsMsgMessageFlags::Read, after.flags);
  };
  db.AddMessageListener(a);
  db.AddMessageListener(b);
  auto unwatch = MakeScopeExit([&] {
    db.RemoveMessageListener(a);
    db.RemoveMessageListener(b);
  });
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("ordinary-queue"_ns, {}, key));
  EXPECT_EQ((nsTArray<nsCString>{"AP"_ns, "BP"_ns, "AF"_ns, "BF"_ns}), order);
}

TEST_F(DeliveryCoreReferences,
       GroupSiblingsAndPhysicalCopiesAcquireLateParent) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  uint64_t other;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "B"_ns, &other));
  nsMsgKey first, second, copy, control;
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "siblings-late-first@conversation.invalid"_ns,
                  {"siblings-late-parent@conversation.invalid"_ns}, first));
  ASSERT_EQ(NS_OK,
            AddAt(other, "siblings-late-second@conversation.invalid"_ns,
                  {"siblings-late-parent@conversation.invalid"_ns}, second));
  ASSERT_EQ(NS_OK,
            AddAt(other, "siblings-late-first@conversation.invalid"_ns,
                  {"siblings-late-parent@conversation.invalid"_ns}, copy));
  ASSERT_EQ(NS_OK,
            AddAt(other, "siblings-late-unrelated@conversation.invalid"_ns, {},
                  control));
  CapturedMessage a, b;
  ASSERT_EQ(NS_OK, db.CaptureMessage(first, a));
  ASSERT_EQ(NS_OK, db.CaptureMessage(second, b));
  EXPECT_NE(0u, a.threadId);
  EXPECT_EQ(a.threadId, b.threadId);
  EXPECT_EQ(0u, a.threadParent);
  EXPECT_EQ(0u, b.threadParent);
  RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
  nsTArray<nsMsgKey> changed;
  uint32_t publications = 0;
  observer->action = [&](char kind, const auto&, const auto& after, Message*,
                         bool) {
    if (kind == 'T') {
      changed.AppendElement(after.id);
    }
    if (kind == 'P') {
      ++publications;
    }
  };
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  nsMsgKey parent;
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "siblings-late-parent@conversation.invalid"_ns, {},
                  parent));
  EXPECT_EQ((nsTArray<nsMsgKey>{first, second, copy}), changed);
  EXPECT_EQ(1u, publications);
  for (nsMsgKey key : {first, second, copy}) {
    CapturedMessage row;
    ASSERT_EQ(NS_OK, db.CaptureMessage(key, row));
    EXPECT_EQ(parent, row.threadId);
    EXPECT_EQ(parent, row.threadParent);
    nsTArray<nsCString> refs;
    ASSERT_EQ(NS_OK, Stored(key, refs));
    EXPECT_EQ(
        (nsTArray<nsCString>{"siblings-late-parent@conversation.invalid"_ns}),
        refs);
  }
  ASSERT_EQ(NS_OK, db.CaptureMessage(copy, b));
  EXPECT_EQ(other, b.folderId);
  ASSERT_EQ(NS_OK, db.CaptureMessage(control, b));
  EXPECT_EQ(control, b.threadId);
}

TEST_F(DeliveryCoreReferences, GroupStagedHistoryFailureRetainsCompleteDraft) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  nsMsgKey old;
  ASSERT_EQ(NS_OK, Add("old-history"_ns, {}, old));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DELETE FROM message_reference_sets"_ns));
  RawHdr raw;
  raw.messageId = "kept-staged"_ns;
  raw.storeToken = Some(nsCString(""_ns));
  raw.messageSize = Some(0u);
  nsMsgKey staged;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  Message* output = nullptr;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.PublishMessage(staged, true, &output));
  EXPECT_EQ(nullptr, output);
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{staged}), keys);
  nsTArray<nsCString> names, refs;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(staged, names));
  EXPECT_TRUE(names.Contains("storeToken"_ns));
  EXPECT_TRUE(names.Contains("messageSize"_ns));
  ASSERT_EQ(NS_OK, db.GetMessageReferences(staged, refs));
  EXPECT_TRUE(refs.IsEmpty());
  uint64_t count;
  ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
  EXPECT_EQ(1u, count);
}

TEST_F(DeliveryCoreReferences,
       HeaderStateReadsPublishedStagedAndGenuineAbsence) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey published, staged;
  ASSERT_EQ(NS_OK, Add("published-state"_ns, {}, published));
  RawHdr raw;
  raw.messageId = "staged-state"_ns;
  raw.flags = 0x80000000u;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  Maybe<CapturedMessage> state;
  ASSERT_EQ(NS_OK, db.CaptureHeaderState(staged, state));
  ASSERT_TRUE(state);
  EXPECT_EQ(staged, state->id);
  EXPECT_EQ(mFolderId, state->folderId);
  EXPECT_EQ(0x80000000u, state->flags);
  EXPECT_EQ(staged, state->threadId);
  EXPECT_EQ(0u, state->threadParent);
  bool exists = true;
  ASSERT_EQ(NS_OK, db.MessageExists(staged, exists));
  EXPECT_FALSE(exists);
  CapturedMessage publishedOnly;
  EXPECT_EQ(NS_ERROR_UNEXPECTED, db.CaptureMessage(staged, publishedOnly));
  ASSERT_EQ(NS_OK, db.CaptureHeaderState(published, state));
  ASSERT_TRUE(state);
  EXPECT_EQ(published, state->id);
  RefPtr<Message> hot = new Message(published);
  nsCString text;
  ASSERT_EQ(NS_OK, hot->GetSubject(text));
  ASSERT_EQ(NS_OK, db.RemoveMessage(published));
  ASSERT_EQ(NS_OK, db.CaptureHeaderState(published, state));
  EXPECT_FALSE(state);
  ASSERT_EQ(NS_OK, db.AbortMessage(staged));
  ASSERT_EQ(NS_OK, db.CaptureHeaderState(staged, state));
  EXPECT_FALSE(state);
}

TEST_F(DeliveryCoreReferences,
       HeaderStateErrorsPreserveOutputAndCallerTransaction) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("state-errors"_ns, {}, key));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  Maybe<CapturedMessage> state{Some(CapturedMessage{})};
  state->id = 77;
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP VIEW messages AS SELECT id,abs(-9223372036854775808) AS "
          "folderId,"
          "messageId,date,sender,recipients,subject,flags,tags,threadId,threadParent FROM main.messages"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(
        NS_OK,
        mConnection->ExecuteSimpleSQL(
            "DROP VIEW IF EXISTS temp.messages; DROP VIEW IF EXISTS temp.staged_messages"_ns));
  });
  EXPECT_EQ(NS_ERROR_FAILURE, db.CaptureHeaderState(key, state));
  ASSERT_TRUE(state);
  EXPECT_EQ(77u, state->id);
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "DROP VIEW temp.messages; CREATE TEMP VIEW staged_messages AS SELECT * FROM main.messages"_ns));
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, db.CaptureHeaderState(key, state));
  ASSERT_TRUE(state);
  EXPECT_EQ(77u, state->id);
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP VIEW temp.staged_messages"_ns));
  ASSERT_EQ(NS_OK, db.CaptureHeaderState(key, state));
  ASSERT_TRUE(state);
  EXPECT_EQ(key, state->id);
}

TEST_F(DeliveryCoreReferences, StagedHeaderStateUsesNearestPublishedParent) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  nsMsgKey root, parent, staged;
  ASSERT_EQ(NS_OK, Add("ancestry-root"_ns, {}, root));
  ASSERT_EQ(NS_OK, Add("ancestry-parent"_ns, {"ancestry-root"_ns}, parent));
  RawHdr raw;
  raw.messageId = "ancestry-staged"_ns;
  raw.references = {"ancestry-root"_ns, "ancestry-parent"_ns, "unresolved"_ns};
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  Maybe<CapturedMessage> state;
  ASSERT_EQ(NS_OK, db.CaptureHeaderState(staged, state));
  ASSERT_TRUE(state);
  EXPECT_EQ(root, state->threadId);
  EXPECT_EQ(parent, state->threadParent);
  bool published = true;
  ASSERT_EQ(NS_OK, db.MessageExists(staged, published));
  EXPECT_FALSE(published);
}

TEST_F(DeliveryCoreReferences, StagedParentUsesStoredThreadWithGroupingOff) {
  ASSERT_NO_FATAL_FAILURE(CheckStagedParentWithGroupingOff());
}

TEST_F(DeliveryCoreReferences, QueuedFlagFailureKeepsStoredAndHotFacts) {
  ASSERT_NO_FATAL_FAILURE(CheckQueuedChangeRollback(false));
}

TEST_F(DeliveryCoreReferences, QueuedTagFailureKeepsStoredAndHotFacts) {
  ASSERT_NO_FATAL_FAILURE(CheckQueuedChangeRollback(true));
}

TEST_F(DeliveryCoreReferences, QueuedChangesDoNotSettleCallerTransaction) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("caller-owned-change"_ns, {}, key));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  ASSERT_EQ(NS_OK, db.SetMessageProperty(key, "caller"_ns, "kept"_ns));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.SetMessageFlags(key, nsMsgMessageFlags::Read));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.SetMessageTags(key, "rejected"_ns));
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  CapturedMessage row;
  ASSERT_EQ(NS_OK, db.CaptureMessage(key, row));
  EXPECT_EQ(0u, row.flags);
  EXPECT_TRUE(row.tags.IsEmpty());
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "caller"_ns, text));
  EXPECT_EQ("kept"_ns, text);
}

TEST_F(DeliveryCoreReferences,
       ImmediateViewCaptureReadsRealPreinsertIdentities) {
  ASSERT_NO_FATAL_FAILURE(CheckPreinsertViewCapture(false, false));
}

TEST_F(DeliveryCoreReferences, StagedViewCaptureReadsRealPreinsertIdentities) {
  ASSERT_NO_FATAL_FAILURE(CheckPreinsertViewCapture(true, false));
}

TEST_F(DeliveryCoreReferences, ImmediateViewCaptureReadFailurePreservesOutput) {
  ASSERT_NO_FATAL_FAILURE(CheckPreinsertViewCapture(false, true));
}

TEST_F(DeliveryCoreReferences, StagedViewCaptureReadFailurePreservesDraft) {
  ASSERT_NO_FATAL_FAILURE(CheckPreinsertViewCapture(true, true));
}

TEST_F(DeliveryCoreReferences,
       GroupThreadWordRekeyPreservesFolderScopesAndRestart) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  uint64_t otherFolder, controlFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "WordOther"_ns,
                                                  &otherFolder));
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "WordControl"_ns,
                                                  &controlFolder));
  nsMsgKey first, second, control, parent;
  ASSERT_EQ(NS_OK, AddAt(mFolderId, "word-rekey-a"_ns, {"word-rekey-parent"_ns},
                         first));
  ASSERT_EQ(NS_OK, AddAt(otherFolder, "word-rekey-b"_ns,
                         {"word-rekey-parent"_ns}, second));
  ASSERT_EQ(NS_OK, AddAt(controlFolder, "word-control"_ns, {}, control));
  CapturedMessage a, b, c;
  ASSERT_EQ(NS_OK, db.CaptureMessage(first, a));
  ASSERT_EQ(NS_OK, db.CaptureMessage(second, b));
  ASSERT_EQ(NS_OK, db.CaptureMessage(control, c));
  ASSERT_EQ(a.threadId, b.threadId);
  uint32_t firstWord = 0x80000000u | nsMsgMessageFlags::Watched;
  uint32_t secondWord = 0x40000000u | nsMsgMessageFlags::Ignored;
  ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, a.threadId, firstWord));
  ASSERT_EQ(NS_OK, db.SetThreadFlags(otherFolder, b.threadId, secondWord));
  ASSERT_EQ(NS_OK, db.SetThreadFlags(controlFolder, c.threadId, 0xabcdef01u));
  ASSERT_EQ(NS_OK, Add("word-rekey-parent"_ns, {}, parent));
  CapturedMessage current;
  ASSERT_EQ(NS_OK, db.CaptureMessage(first, current));
  EXPECT_EQ(parent, current.threadId);
  EXPECT_EQ(parent, current.threadParent);
  uint32_t flags = 7;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetThreadFlags(mFolderId, a.threadId, flags));
  EXPECT_EQ(7u, flags);
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->MessageDB();
  ASSERT_EQ(NS_OK, reopened.GetThreadFlags(mFolderId, parent, flags));
  EXPECT_EQ(firstWord, flags);
  ASSERT_EQ(NS_OK, reopened.GetThreadFlags(otherFolder, parent, flags));
  EXPECT_EQ(secondWord, flags);
  ASSERT_EQ(NS_OK, reopened.GetThreadFlags(controlFolder, c.threadId, flags));
  EXPECT_EQ(0xabcdef01u, flags);
  nsTArray<nsCString> refs;
  ASSERT_EQ(NS_OK, Stored(first, refs));
  EXPECT_EQ((nsTArray<nsCString>{"word-rekey-parent"_ns}), refs);
  ASSERT_EQ(NS_OK, reopened.RemoveMessage(parent));
  ASSERT_EQ(NS_OK, reopened.GetThreadFlags(mFolderId, parent, flags));
  EXPECT_EQ(firstWord, flags);
  ASSERT_EQ(NS_OK, reopened.RemoveMessage(first));
  flags = 7;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            reopened.GetThreadFlags(mFolderId, parent, flags));
  EXPECT_EQ(7u, flags);
  ASSERT_EQ(NS_OK, reopened.GetThreadFlags(otherFolder, parent, flags));
  EXPECT_EQ(secondWord, flags);
  ASSERT_EQ(NS_OK, reopened.RemoveMessage(second));
  ASSERT_EQ(NS_OK, reopened.GetThreadFlags(controlFolder, c.threadId, flags));
  EXPECT_EQ(0xabcdef01u, flags);
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  nsCOMPtr<mozIStorageStatement> stmt;
  auto close = MakeScopeExit([&] {
    if (stmt) EXPECT_EQ(NS_OK, stmt->Finalize());
    EXPECT_EQ(NS_OK, reader->Close());
  });
  ASSERT_EQ(
      NS_OK,
      reader->CreateStatement(
          "SELECT folderId,threadId,flags FROM thread_flags ORDER BY folderId,threadId"_ns,
          getter_AddRefs(stmt)));
  bool more;
  ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
  ASSERT_TRUE(more);
  int64_t folder, thread, word;
  ASSERT_EQ(NS_OK, stmt->GetInt64(0, &folder));
  ASSERT_EQ(NS_OK, stmt->GetInt64(1, &thread));
  ASSERT_EQ(NS_OK, stmt->GetInt64(2, &word));
  EXPECT_EQ(controlFolder, uint64_t(folder));
  EXPECT_EQ(c.threadId, thread);
  EXPECT_EQ(int64_t(0xabcdef01u), word);
  ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
  EXPECT_FALSE(more);
}

TEST_F(DeliveryCoreReferences, GroupThreadWordsMergeExactEqualUnknownBits) {
  ASSERT_NO_FATAL_FAILURE(
      CheckEqualThreadWordMerge(0xa0000000u | nsMsgMessageFlags::Watched));
}

TEST_F(DeliveryCoreReferences, GroupThreadWordsMergeExplicitZero) {
  ASSERT_NO_FATAL_FAILURE(CheckEqualThreadWordMerge(0));
}

TEST_F(DeliveryCoreReferences, GroupThreadWordsRejectWatchedIgnoredConflict) {
  ASSERT_NO_FATAL_FAILURE(CheckThreadWordConflict(
      false, nsMsgMessageFlags::Watched, nsMsgMessageFlags::Ignored));
}

TEST_F(DeliveryCoreReferences,
       GroupThreadWordsRejectZeroNonzeroStagedConflict) {
  ASSERT_NO_FATAL_FAILURE(
      CheckThreadWordConflict(true, 0, nsMsgMessageFlags::Watched));
}

TEST_F(DeliveryCoreReferences,
       GroupThreadWordWriteFailureRollsBackDerivedState) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  nsMsgKey child, control;
  ASSERT_EQ(NS_OK, Add("word-write-child"_ns, {"word-write-parent"_ns}, child));
  ASSERT_EQ(NS_OK, Add("word-write-control"_ns, {}, control));
  CapturedMessage before;
  ASSERT_EQ(NS_OK, db.CaptureMessage(child, before));
  ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, before.threadId, 0x80000001u));
  RefPtr<Message> hot = new Message(child);
  nsMsgKey cachedThread;
  ASSERT_EQ(NS_OK, hot->GetThreadId(&cachedThread));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK, mConnection->CreateFunction("word_fault"_ns, 1, witness));
  // An unreached INSERT trigger requires a new failure injection point.
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER fail_word_rekey BEFORE INSERT ON thread_flags "
          "BEGIN SELECT word_fault(NEW.threadId); SELECT RAISE(ABORT,'word rekey fault'); END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS fail_word_rekey"_ns));
    EXPECT_EQ(NS_OK, mConnection->RemoveFunction("word_fault"_ns));
  });
  RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
  uint32_t calls = 0;
  observer->action = [&](char, const auto&, const auto&, Message*, bool) {
    ++calls;
  };
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  RawHdr raw;
  raw.messageId = "word-write-parent"_ns;
  nsMsgKey output = nsMsgKey_None;
  RefPtr<Message> sentinel = new Message(control);
  Message* live = sentinel.get();
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.AddMessage(mFolderId, raw, true, &output, &live));
  EXPECT_EQ(nsMsgKey_None, output);
  EXPECT_EQ(sentinel.get(), live);
  if (live && live != sentinel.get()) NS_RELEASE(live);
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_GT(witness->mLastKey, 0);
  EXPECT_EQ(0u, calls);
  ASSERT_EQ(NS_OK, hot->GetThreadId(&cachedThread));
  EXPECT_EQ(before.threadId, cachedThread);
  CapturedMessage actual;
  ASSERT_EQ(NS_OK, db.CaptureMessage(child, actual));
  EXPECT_EQ(before.threadId, actual.threadId);
  EXPECT_EQ(before.threadParent, actual.threadParent);
  ASSERT_EQ(NS_OK, db.CaptureMessage(control, actual));
  EXPECT_EQ("word-write-control"_ns, actual.messageId);
  uint32_t flags;
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, before.threadId, flags));
  EXPECT_EQ(0x80000001u, flags);
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER fail_word_rekey"_ns));
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &output));
  EXPECT_EQ(2u, calls);
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, output, flags));
  EXPECT_EQ(0x80000001u, flags);
}

TEST_F(DeliveryCoreReferences,
       GroupThreadWordPublishPreservesCallerTransaction) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  nsMsgKey child, pending;
  ASSERT_EQ(NS_OK, Add("word-owner-child"_ns, {"word-owner-parent"_ns}, child));
  CapturedMessage before;
  ASSERT_EQ(NS_OK, db.CaptureMessage(child, before));
  ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, before.threadId, 0x80000000u));
  RawHdr raw;
  raw.messageId = "word-owner-parent"_ns;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &pending));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active;
    if (NS_SUCCEEDED(mConnection->GetTransactionInProgress(&active)) && active)
      EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, db.SetMessageProperty(child, "caller"_ns, "kept"_ns));
  Message* output = nullptr;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.PublishMessage(pending, true, &output));
  EXPECT_EQ(nullptr, output);
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  uint32_t flags;
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, before.threadId, flags));
  EXPECT_EQ(0x80000000u, flags);
  ASSERT_EQ(NS_OK, mConnection->CommitTransaction());
  ASSERT_EQ(NS_OK, db.PublishMessage(pending, true));
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, pending, flags));
  EXPECT_EQ(0x80000000u, flags);
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(child, "caller"_ns, text));
  EXPECT_EQ("kept"_ns, text);
}

TEST_F(DeliveryCoreReferences,
       GroupThreadWordReadErrorPreservesPublicationOutput) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  nsMsgKey child;
  ASSERT_EQ(NS_OK, Add("word-read-child"_ns, {"word-read-parent"_ns}, child));
  CapturedMessage before;
  ASSERT_EQ(NS_OK, db.CaptureMessage(child, before));
  ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, before.threadId, 0x80000001u));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP VIEW thread_flags AS SELECT folderId,threadId,"
          "abs(-9223372036854775808) AS flags FROM main.thread_flags"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.thread_flags"_ns));
  });
  RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
  uint32_t calls = 0;
  observer->action = [&](char, const auto&, const auto&, Message*, bool) {
    ++calls;
  };
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  nsMsgKey output = nsMsgKey_None;
  EXPECT_EQ(NS_ERROR_FAILURE, Add("word-read-parent"_ns, {}, output));
  EXPECT_EQ(nsMsgKey_None, output);
  EXPECT_EQ(0u, calls);
  CapturedMessage current;
  ASSERT_EQ(NS_OK, db.CaptureMessage(child, current));
  EXPECT_EQ(before.threadId, current.threadId);
  EXPECT_EQ(before.threadParent, current.threadParent);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP VIEW temp.thread_flags"_ns));
  uint32_t flags;
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, before.threadId, flags));
  EXPECT_EQ(0x80000001u, flags);
  ASSERT_EQ(NS_OK, Add("word-read-parent"_ns, {}, output));
  EXPECT_EQ(2u, calls);
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, output, flags));
  EXPECT_EQ(0x80000001u, flags);
}

#ifdef XP_WIN
TEST_F(DeliveryCoreReferences, WindowsImportRequiresOriginalPhysicalContext) {
  ASSERT_EQ(NS_OK, Start());
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  auto paths = *input.identity.windows;
  FolderImportReceipt output;
  output.identity.token = "unchanged"_ns;
  input.identity.windows.reset();
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, ImportNativeFile(source, input, output));
  EXPECT_EQ("unchanged"_ns, output.identity.token);
  input.identity.windows = Some(paths);
  input.identity.windows->summary.id.Assign(
      "0000000000000000:00000000000000000000000000000000");
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, ImportNativeFile(source, input, output));
  EXPECT_EQ("unchanged"_ns, output.identity.token);
  uint64_t count;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(0u, count);
  input.identity.windows = Some(paths);
  input.identity.windows->summary.rootId.Assign(
      "0000000000000000:00000000000000000000000000000000");
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, ImportNativeFile(source, input, output));
  EXPECT_EQ("unchanged"_ns, output.identity.token);
  input.identity.windows = Some(paths);
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, output));
  ASSERT_TRUE(output.identity.windows);
  EXPECT_EQ(paths.summary.id, output.identity.windows->summary.id);
  EXPECT_EQ(paths.store.id, output.identity.windows->store.id);
  EXPECT_EQ(paths.summary.originalRoot,
            output.identity.windows->summary.originalRoot);
  Stop();
  ASSERT_EQ(NS_OK, Start());
  Maybe<FolderImportReceipt> recovered;
  ASSERT_EQ(NS_OK, mCore->GetFolderImportReceipt(input.identity, recovered));
  ASSERT_TRUE(recovered && recovered->identity.windows);
  EXPECT_EQ(paths.summary.id, recovered->identity.windows->summary.id);
  EXPECT_EQ(paths.summary.parentId,
            recovered->identity.windows->summary.parentId);
  EXPECT_EQ(paths.store.rootId, recovered->identity.windows->store.rootId);
}

TEST_F(DeliveryCoreReferences, WindowsImportCannotRebindOldReceipt) {
  ASSERT_EQ(NS_OK, Start());
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  FolderImportReceipt imported;
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, imported));
  // A v1 receipt has no native Windows sidecar, even when its digest matches.
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DELETE FROM folder_import_windows"_ns));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  Maybe<FolderImportReceipt> output(Some(FolderImportReceipt{}));
  output->identity.token = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->GetFolderImportReceipt(input.identity, output));
  ASSERT_TRUE(output);
  EXPECT_EQ("unchanged"_ns, output->identity.token);
  FolderImportReceipt retry;
  retry.identity.token = "still unchanged"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, ImportNativeFile(source, input, retry));
  EXPECT_EQ("still unchanged"_ns, retry.identity.token);
  uint64_t count;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(2u, count);
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(NS_OK, mConnection->CreateStatement(
                       "SELECT COUNT(*) FROM folder_import_windows"_ns,
                       getter_AddRefs(stmt)));
  bool more;
  ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
  ASSERT_TRUE(more);
  int64_t rows;
  ASSERT_EQ(NS_OK, stmt->GetInt64(0, &rows));
  EXPECT_EQ(0, rows);
  ASSERT_EQ(NS_OK, stmt->Finalize());
}

TEST_F(DeliveryCoreReferences, WindowsImportOwnsLeaseUntilPublicationReturns) {
  ASSERT_EQ(NS_OK, Start());
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  nsAutoString leaf;
  ASSERT_EQ(NS_OK, source->GetLeafName(leaf));
  ASSERT_EQ(NS_OK, source->RenameTo(mProfile, u"rename-control.bin"_ns));
  nsCOMPtr<nsIFile> renamed;
  ASSERT_EQ(NS_OK, mProfile->Clone(getter_AddRefs(renamed)));
  ASSERT_EQ(NS_OK, renamed->Append(u"rename-control.bin"_ns));
  ASSERT_EQ(NS_OK, renamed->RenameTo(mProfile, leaf));
  uint32_t calls = 0;
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([&](Message*, bool) {
        ++calls;
        // PrepareNativeImport closed its own admission leases before this call.
        EXPECT_TRUE(NS_FAILED(source->RenameTo(mProfile, u"blocked.bin"_ns)));
        bool exists;
        ASSERT_EQ(NS_OK, source->Exists(&exists));
        EXPECT_TRUE(exists);
      });
  auto& db = mCore->MessageDB();
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  FolderImportReceipt receipt;
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, receipt));
  EXPECT_EQ(2u, calls);
  ASSERT_EQ(NS_OK, source->RenameTo(mProfile, u"after-import.bin"_ns));
  ASSERT_EQ(NS_OK, mProfile->Clone(getter_AddRefs(renamed)));
  ASSERT_EQ(NS_OK, renamed->Append(u"after-import.bin"_ns));
  ASSERT_EQ(NS_OK, renamed->RenameTo(mProfile, leaf));
}
#endif

#ifdef XP_WIN
TEST_F(DeliveryCoreReferences,
       WindowsImportIdentityWriteFailureRollsBackReceipt) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("control@invalid"_ns, {}, control));
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_windows_identity BEFORE INSERT ON "
          "folder_import_windows BEGIN SELECT RAISE(ABORT, 'identity failure'); END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS reject_windows_identity"_ns));
  });
  uint32_t callbacks = 0;
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([&](Message*, bool) { ++callbacks; });
  auto& db = mCore->MessageDB();
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  FolderImportReceipt output;
  output.identity.token = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            ImportNativeFile(source, input, output));
  EXPECT_EQ("unchanged"_ns, output.identity.token);
  EXPECT_EQ(0u, callbacks);
  bool exists;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(control, exists));
  EXPECT_TRUE(exists);
  uint64_t count;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(1u, count);
  Maybe<FolderImportReceipt> receipt;
  ASSERT_EQ(NS_OK, mCore->GetFolderImportReceipt(input.identity, receipt));
  EXPECT_FALSE(receipt);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER reject_windows_identity"_ns));
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, output));
  EXPECT_EQ(2u, callbacks);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(3u, count);
}
#endif

TEST_F(DeliveryCoreReferences, Schema14UpgradeKeepsThreadAndPendingState) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey root, thread, staged;
  ASSERT_EQ(NS_OK, Add("schema14-root"_ns, {}, root));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(root, thread));
  ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, thread, 0x80000001));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 19));
  RawHdr raw;
  raw.messageId = "schema14-staged"_ns;
  raw.references = {"schema14-root"_ns};
  raw.storeToken = Some(nsCString("retained-body"_ns));
  raw.messageSize = Some(42u);
  raw.extras = {{"exact"_ns, "00042"_ns}};
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kAppendDraft;
  input.pendingDestination = Some(PendingDestination{mFolderId, staged, 19});
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, staged, input));
  nsCString sourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(sourceId));
  Stop();

  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK,
            old->ExecuteSimpleSQL("DROP TABLE folder_import_windows"_ns));
  ASSERT_EQ(
      NS_OK,
      old->ExecuteSimpleSQL(
          "DROP TABLE folder_cache_bindings; DROP TABLE folder_cache_imports"_ns));
  ASSERT_EQ(NS_OK, RemovePost15OfflineColumns(old));
  ASSERT_EQ(NS_OK, old->SetSchemaVersion(13));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
  int32_t version;
  ASSERT_EQ(NS_OK, mConnection->GetSchemaVersion(&version));
  EXPECT_EQ(19, version);
  nsCString reopenedId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(reopenedId));
  EXPECT_EQ(sourceId, reopenedId);
  auto& reopened = mCore->MessageDB();
  uint32_t flags;
  ASSERT_EQ(NS_OK, reopened.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(0x80000001u, flags);
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperation(mFolderId, staged, got));
  EXPECT_EQ(nsIMsgOfflineImapOperation::kAppendDraft, got.operation);
  ASSERT_TRUE(got.pendingDestination);
  EXPECT_EQ(mFolderId, got.pendingDestination->folderId);
  EXPECT_EQ(staged, got.pendingDestination->key);
  EXPECT_EQ(19u, got.pendingDestination->epoch);
  Maybe<CapturedMessage> captured;
  ASSERT_EQ(NS_OK, reopened.CaptureHeaderState(staged, captured));
  ASSERT_TRUE(captured);
  EXPECT_EQ(thread, captured->threadId);
  EXPECT_EQ(root, captured->threadParent);
  nsTArray<nsCString> references;
  ASSERT_EQ(NS_OK, reopened.GetMessageReferences(staged, references));
  EXPECT_EQ((nsTArray<nsCString>{"schema14-root"_ns}), references);
  nsCString text;
  ASSERT_EQ(NS_OK, reopened.GetMessageProperty(staged, "exact"_ns, text));
  EXPECT_EQ("00042"_ns, text);
  ASSERT_EQ(NS_OK, reopened.GetMessageStoreToken(staged, text));
  EXPECT_EQ("retained-body"_ns, text);
  uint64_t size;
  ASSERT_EQ(NS_OK, reopened.GetMessageSize(staged, size));
  EXPECT_EQ(42u, size);
  bool published = true;
  ASSERT_EQ(NS_OK, reopened.MessageExists(staged, published));
  EXPECT_FALSE(published);
}

TEST_F(DeliveryCoreReferences, QueuedSourceReadIsDurableAndReadOnly) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 61));
  auto& db = mCore->MessageDB();
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, Add("read-queued-source@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, Add("source-control@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 61, 700));
  OfflineOperationData payload;
  payload.operation = nsIMsgOfflineImapOperation::kFlagsChanged;
  // Mutable compatibility fields are not the captured source identity.
  payload.sourceKey = control;
  payload.sourceUid = UINT32_MAX;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  ASSERT_EQ(NS_OK, db.SetOfflineOperationPlayingBack(mFolderId, key, true));
  ASSERT_EQ(NS_OK, db.RemoveMessage(key));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 62));
  Maybe<ServerMessageLocation> source;
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperationSource(mFolderId, key, source));
  ASSERT_TRUE(source);
  EXPECT_EQ(mFolderId, source->folderId);
  EXPECT_EQ(key, source->key);
  EXPECT_EQ(61u, source->epoch);
  EXPECT_EQ(700u, source->uid);
  ASSERT_NO_FATAL_FAILURE(CheckOfflineSource(key, 61, 700));
  OfflineOperationData stored;
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperation(mFolderId, key, stored));
  EXPECT_EQ(control, stored.sourceKey);
  EXPECT_EQ(UINT32_MAX, stored.sourceUid);
  EXPECT_TRUE(stored.playingBack);
  // Reading neither dispatches nor changes the payload revision.
  nsCOMPtr<mozIStorageStatement> state;
  ASSERT_EQ(NS_OK,
            mConnection->CreateStatement(
                "SELECT revision, (SELECT COUNT(*) FROM offline_attempts) "
                "FROM offline_operations WHERE messageKey=:key"_ns,
                getter_AddRefs(state)));
  ASSERT_EQ(NS_OK, state->BindInt64ByName("key"_ns, key));
  bool more;
  ASSERT_EQ(NS_OK, state->ExecuteStep(&more));
  ASSERT_TRUE(more);
  int64_t revision, attempts;
  ASSERT_EQ(NS_OK, state->GetInt64(0, &revision));
  ASSERT_EQ(NS_OK, state->GetInt64(1, &attempts));
  EXPECT_EQ(1, revision);
  EXPECT_EQ(0, attempts);
  ASSERT_EQ(NS_OK, state->Finalize());
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperationSource(mFolderId, key, source));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  bool exists = true;
  ASSERT_EQ(NS_OK, reopened.MessageExists(key, exists));
  EXPECT_FALSE(exists);
  ASSERT_EQ(NS_OK, reopened.MessageExists(control, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreReferences, QueuedSourceAbsenceDoesNotCaptureLaterBinding) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("initially-unbound@invalid"_ns, {}, key));
  OfflineOperationData payload;
  payload.operation = nsIMsgOfflineImapOperation::kFlagsChanged;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 81));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 81, 42));
  payload.sourceUid = 999;
  payload.keywordsToAdd = "later edit"_ns;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  Maybe<ServerMessageLocation> source =
      Some(ServerMessageLocation{99, 98, 97, 96});
  ASSERT_EQ(NS_OK, db.GetOfflineOperationSource(mFolderId, key, source));
  EXPECT_FALSE(source);
  uint64_t attempt = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineAttempt(mFolderId, key,
                                   nsIMsgOfflineImapOperation::kFlagsChanged,
                                   Nothing(), attempt));
  EXPECT_EQ(123u, attempt);
  source = Some(ServerMessageLocation{99, 98, 97, 96});
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetOfflineOperationSource(mFolderId + 1, key, source));
  ASSERT_TRUE(source);
  EXPECT_EQ(96u, source->uid);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetOfflineOperationSource(mFolderId, nsMsgKey_None - 1, source));
  EXPECT_EQ(NS_ERROR_INVALID_ARG, db.GetOfflineOperationSource(0, key, source));
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.GetOfflineOperationSource(mFolderId, nsMsgKey_None, source));
  ASSERT_TRUE(source);
  EXPECT_EQ(99u, source->folderId);
  EXPECT_EQ(98u, source->key);
  EXPECT_EQ(97u, source->epoch);
  EXPECT_EQ(96u, source->uid);
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetOfflineOperationSource(mFolderId, key,
                                                                source));
  EXPECT_FALSE(source);
}

TEST_F(DeliveryCoreReferences, QueuedSourceErrorsPreserveOutput) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 91));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("source-read-fault@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 91, UINT32_MAX));
  OfflineOperationData payload;
  payload.operation = nsIMsgOfflineImapOperation::kFlagsChanged;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  for (const char* projection :
       {"id, revision, NULL AS epoch, uid, folderEpoch",
        "id, revision, -1 AS epoch, uid, folderEpoch",
        "id, revision, 'invalid' AS epoch, uid, folderEpoch",
        "id, revision, epoch, 4294967296 AS uid, folderEpoch",
        "id, 'invalid' AS revision, epoch, uid, folderEpoch"}) {
    nsCString sql("CREATE TEMP VIEW offline_operations AS SELECT ");
    sql.Append(projection);
    sql.AppendLiteral(
        ", sourcePhysicalKey, folderId, messageKey FROM "
        "main.offline_operations");
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    Maybe<ServerMessageLocation> source =
        Some(ServerMessageLocation{99, 98, 97, 96});
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
              db.GetOfflineOperationSource(mFolderId, key, source));
    ASSERT_TRUE(source);
    EXPECT_EQ(96u, source->uid);
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW temp.offline_operations"_ns));
  }
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "CREATE TEMP VIEW offline_operations AS SELECT * FROM "
                       "main.offline_operations "
                       "UNION ALL SELECT * FROM main.offline_operations"_ns));
  Maybe<ServerMessageLocation> source =
      Some(ServerMessageLocation{99, 98, 97, 96});
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            db.GetOfflineOperationSource(mFolderId, key, source));
  ASSERT_TRUE(source);
  EXPECT_EQ(96u, source->uid);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.offline_operations"_ns));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("source_read_fault"_ns, 1, witness));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "CREATE TEMP VIEW offline_operations AS SELECT id, revision, "
                "CASE WHEN source_read_fault(messageKey)=0 THEN "
                "abs(-9223372036854775808) "
                "ELSE epoch END AS epoch, uid, folderEpoch, sourcePhysicalKey, "
                "folderId, "
                "messageKey "
                "FROM main.offline_operations"_ns));
  EXPECT_EQ(NS_ERROR_FAILURE,
            db.GetOfflineOperationSource(mFolderId, key, source));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(key, witness->mLastKey);
  ASSERT_TRUE(source);
  EXPECT_EQ(96u, source->uid);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.offline_operations"_ns));
  ASSERT_EQ(NS_OK, db.GetOfflineOperationSource(mFolderId, key, source));
  ASSERT_TRUE(source);
  EXPECT_EQ(91u, source->epoch);
  EXPECT_EQ(UINT32_MAX, source->uid);
}

TEST_F(DeliveryCoreReferences, QueuedSourceCaptureFailureRollsBackIntent) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 101));
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, Add("source-write-fault@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, Add("source-write-control@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 101, 700));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(control, mFolderId, 101, 701));
  OfflineOperationData payload;
  payload.operation = nsIMsgOfflineImapOperation::kFlagsChanged;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, control, payload));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("source_write_fault"_ns, 1, witness));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_source_capture BEFORE INSERT ON "
          "offline_operations "
          "WHEN NEW.uid=700 BEGIN SELECT source_write_fault(NEW.messageKey); "
          "SELECT RAISE(ABORT, 'source capture failure'); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.StoreOfflineOperation(mFolderId, key, payload));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(key, witness->mLastKey);
  bool active = true;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  Maybe<ServerMessageLocation> source =
      Some(ServerMessageLocation{99, 98, 97, 96});
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetOfflineOperationSource(mFolderId, key, source));
  ASSERT_TRUE(source);
  EXPECT_EQ(96u, source->uid);
  ASSERT_EQ(NS_OK, db.GetOfflineOperationSource(mFolderId, control, source));
  ASSERT_TRUE(source);
  EXPECT_EQ(701u, source->uid);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER reject_source_capture"_ns));
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  ASSERT_NO_FATAL_FAILURE(CheckOfflineSource(key, 101, 700));
  uint64_t attemptId;
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(mFolderId, key,
                                   nsIMsgOfflineImapOperation::kFlagsChanged,
                                   Nothing(), attemptId));
  ASSERT_EQ(NS_OK, db.GetOfflineOperationSource(mFolderId, key, source));
  ASSERT_TRUE(source);
  EXPECT_EQ(700u, source->uid);
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Sent, attempt.state);
  EXPECT_EQ(1u, attempt.revision);
  ASSERT_EQ(NS_OK, db.MarkOfflineAttemptAmbiguous(attemptId));
  ASSERT_EQ(NS_OK, db.GetOfflineOperationSource(mFolderId, key, source));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Ambiguous, attempt.state);
  EXPECT_EQ(1u, attempt.revision);
}

TEST_F(DeliveryCoreReferences, RetiredReferencesKeepLiveConversationMembers) {
  ASSERT_NO_FATAL_FAILURE(CheckRetiredReferences(false));
}

TEST_F(DeliveryCoreReferences, StagedReferencesKeepLiveConversationMembers) {
  ASSERT_NO_FATAL_FAILURE(CheckRetiredReferences(true));
}

TEST_F(DeliveryCoreReferences,
       DefaultReferenceReadFailurePreservesPublication) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_NO_FATAL_FAILURE(CheckGroupingOff());
  nsMsgKey root, control;
  ASSERT_EQ(NS_OK, Add("reference-read-root"_ns, {}, root));
  ASSERT_EQ(NS_OK, Add("reference-read-control"_ns, {}, control));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("reference_read_fault"_ns, 1, witness));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "CREATE TEMP VIEW messages AS SELECT * FROM main.messages "
                "WHERE CASE WHEN reference_read_fault(id)=0 "
                "THEN abs(-9223372036854775808) ELSE 1 END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.messages"_ns));
  });
  auto failed = db.FindByMessageId("reference-read-root"_ns);
  ASSERT_TRUE(failed.isErr());
  EXPECT_EQ(NS_ERROR_FAILURE, failed.unwrapErr());
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(root, witness->mLastKey);
  uint32_t publications = 0;
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([&](Message*, bool) { ++publications; });
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  nsMsgKey output = 123;
  EXPECT_EQ(NS_ERROR_FAILURE,
            Add("reference-read-child"_ns, {"reference-read-root"_ns}, output));
  EXPECT_EQ(123u, output);
  EXPECT_EQ(0u, publications);
  bool active = true;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL("DROP VIEW temp.messages"_ns));
  bool exists = false;
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            Add("foreign-owner-child"_ns, {"reference-read-root"_ns}, output));
  EXPECT_EQ(123u, output);
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_EQ(NS_OK,
            Add("reference-read-child"_ns, {"reference-read-root"_ns}, output));
  EXPECT_EQ(1u, publications);
  CapturedMessage child;
  ASSERT_EQ(NS_OK, db.CaptureMessage(output, child));
  EXPECT_EQ(root, child.threadId);
  EXPECT_EQ(root, child.threadParent);
}

TEST_F(DeliveryCoreReferences,
       PartialCompletionPublishesOneCompleteExistingIdentity) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  RawHdr raw;
  raw.messageId = "partial@invalid"_ns;
  raw.subject = "old subject"_ns;
  raw.date = 100;
  raw.flags = nsMsgMessageFlags::Partial;
  raw.keywords = "old tags"_ns;
  raw.storeToken = Some(nsCString("partial-token"_ns));
  raw.messageSize = Some(uint32_t(12));
  raw.references = {"old@invalid"_ns};
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &key));
  ASSERT_EQ(NS_OK, db.SetMessageProperty(key, "unrelated"_ns, "1e3"_ns));
  MessageBodyState expected;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  ASSERT_EQ(NS_OK, db.SetMessageFlag(key, nsMsgMessageFlags::Read, true));
  ASSERT_EQ(NS_OK, db.SetMessageTags(key, "latest tags"_ns));
  RawHdr parsed;
  parsed.messageId = "complete@invalid"_ns;
  parsed.subject = "complete subject"_ns;
  parsed.sender = "parsed sender"_ns;
  parsed.recipients = "parsed recipients"_ns;
  parsed.ccList = "parsed cc"_ns;
  parsed.bccList = "parsed bcc"_ns;
  parsed.date = 300;
  parsed.priority = nsMsgPriority::highest;
  parsed.keywords = "stale parsed tags"_ns;
  parsed.dateReceived = 42000000;
  parsed.charset = "UTF-8"_ns;
  parsed.references = {"late@invalid"_ns, ""_ns, "late@invalid"_ns};
  parsed.extras = {
      {"Case"_ns, "00042"_ns},        {"Case"_ns, ""_ns},
      {"case"_ns, "1e3"_ns},          {"café"_ns, "composed"_ns},
      {"café"_ns, "decomposed"_ns},   {"messageSize"_ns, "00042"_ns},
      {"dateReceived"_ns, "0002a"_ns}};
  uint32_t calls = 0;
  RefPtr<BodyObserver> observer = new BodyObserver(
      [&](nsIMsgDBHdr* old, Message* live, const MessageBodyState& before,
          const MessageBodyState& after) {
        ++calls;
        EXPECT_EQ(key, after.key);
        EXPECT_TRUE(before.flags & nsMsgMessageFlags::Partial);
        EXPECT_FALSE(after.flags & nsMsgMessageFlags::Partial);
        EXPECT_TRUE(after.flags & nsMsgMessageFlags::Read);
        bool active;
        ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
        EXPECT_FALSE(active);
        nsCString text;
        ASSERT_EQ(NS_OK, old->GetSubject(text));
        EXPECT_EQ("old subject"_ns, text);
        PRTime date;
        ASSERT_EQ(NS_OK, old->GetDate(&date));
        EXPECT_EQ(100, date);
        ASSERT_EQ(NS_OK, live->GetSubject(text));
        EXPECT_EQ("complete subject"_ns, text);
        ASSERT_EQ(NS_OK, live->GetStoreToken(text));
        EXPECT_EQ("full-token"_ns, text);
        nsTArray<nsCString> refs;
        ASSERT_EQ(NS_OK, Stored(key, refs));
        EXPECT_EQ(
            (nsTArray<nsCString>{"late@invalid"_ns, ""_ns, "late@invalid"_ns}),
            refs);
      });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  FinishedMessageBody finished{"full-token"_ns, 123, 120, 7, true};
  MessageBodyState output;
  ASSERT_EQ(NS_OK,
            db.CompletePartialMessage(expected, parsed, finished, output));
  EXPECT_EQ(1u, calls);
  EXPECT_EQ(key, output.key);
  EXPECT_EQ(123u, output.messageSize);
  EXPECT_EQ(120u, output.offlineMessageSize);
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageTags(key, text));
  EXPECT_EQ("latest tags"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "unrelated"_ns, text));
  EXPECT_EQ("1e3"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "Case"_ns, text));
  EXPECT_TRUE(text.IsEmpty());
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(key, names));
  EXPECT_TRUE(names.Contains("Case"_ns));
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "café"_ns, text));
  EXPECT_EQ("composed"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "café"_ns, text));
  EXPECT_EQ("decomposed"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "dateReceived"_ns, text));
  EXPECT_EQ("0002a"_ns, text);
  nsMsgPriorityValue priority;
  ASSERT_EQ(NS_OK, db.GetMessagePriority(key, priority));
  EXPECT_EQ(nsMsgPriority::highest, priority);
  db.RemoveMessageListener(observer);
  cleanup.release();
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->MessageDB();
  MessageBodyState restored;
  ASSERT_EQ(NS_OK, reopened.GetMessageBodyState(key, restored));
  EXPECT_EQ(key, restored.key);
  EXPECT_EQ(output.storeToken, restored.storeToken);
  EXPECT_EQ(output.contentRevision, restored.contentRevision);
  EXPECT_EQ(output.locationRevision, restored.locationRevision);
  EXPECT_EQ(output.flags, restored.flags);
  CapturedMessage stored;
  ASSERT_EQ(NS_OK, reopened.CaptureMessage(key, stored));
  EXPECT_EQ("complete@invalid"_ns, stored.messageId);
  EXPECT_EQ("parsed sender"_ns, stored.sender);
  EXPECT_EQ("parsed recipients"_ns, stored.recipients);
  EXPECT_EQ("complete subject"_ns, stored.subject);
  EXPECT_EQ(PRTime(300), stored.date);
  EXPECT_EQ("latest tags"_ns, stored.tags);
  EXPECT_EQ(key, stored.threadId);
  EXPECT_EQ(0u, stored.threadParent);
  RefPtr<Message> header = new Message(key);
  ASSERT_EQ(NS_OK, header->GetCcList(text));
  EXPECT_EQ("parsed cc"_ns, text);
  ASSERT_EQ(NS_OK, header->GetBccList(text));
  EXPECT_EQ("parsed bcc"_ns, text);
  ASSERT_EQ(NS_OK, header->GetPriority(&priority));
  EXPECT_EQ(nsMsgPriority::highest, priority);
  nsTArray<nsCString> references;
  ASSERT_EQ(NS_OK, Stored(key, references));
  EXPECT_EQ((nsTArray<nsCString>{"late@invalid"_ns, ""_ns, "late@invalid"_ns}),
            references);
  ASSERT_EQ(NS_OK, reopened.GetMessageProperty(key, "unrelated"_ns, text));
  EXPECT_EQ("1e3"_ns, text);
}

TEST_F(DeliveryCoreReferences,
       PartialCompletionFailureRollsBackAllHeaderFacts) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, Add("partial-failure@invalid"_ns, {"old@invalid"_ns}, key));
  ASSERT_EQ(NS_OK, Add("partial-control@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.SetMessageFlag(key, nsMsgMessageFlags::Partial, true));
  ASSERT_EQ(NS_OK, db.SetMessageProperty(key, "Case"_ns, "old"_ns));
  MessageBodyState expected;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  RawHdr parsed;
  parsed.subject = "new subject"_ns;
  parsed.references = {"new@invalid"_ns};
  parsed.extras = {{"Case"_ns, "new"_ns}};
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK, mConnection->CreateFunction("partial_fault"_ns, 1, witness));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER fail_partial_metadata BEFORE UPDATE OF subject "
          "ON messages "
          "BEGIN SELECT partial_fault(NEW.id); SELECT RAISE(ABORT,'partial metadata'); END"_ns));
  FinishedMessageBody finished{"finished-retained"_ns, 321, 300, 8, true};
  MessageBodyState output;
  output.key = 123;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.CompletePartialMessage(expected, parsed, finished, output));
  EXPECT_EQ(123u, output.key);
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(key, witness->mLastKey);
  MessageBodyState current;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, current));
  EXPECT_EQ(expected.storeToken, current.storeToken);
  EXPECT_EQ(expected.contentRevision, current.contentRevision);
  EXPECT_EQ(expected.locationRevision, current.locationRevision);
  EXPECT_TRUE(current.flags & nsMsgMessageFlags::Partial);
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "Case"_ns, text));
  EXPECT_EQ("old"_ns, text);
  nsTArray<nsCString> refs;
  ASSERT_EQ(NS_OK, Stored(key, refs));
  EXPECT_EQ((nsTArray<nsCString>{"old@invalid"_ns}), refs);
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER fail_partial_metadata"_ns));
  ASSERT_EQ(NS_OK,
            db.CompletePartialMessage(expected, parsed, finished, output));
}

TEST_F(DeliveryCoreReferences, PartialCompletionRejectsStaleAndNonPartialRows) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("partial-guard@invalid"_ns, {}, key));
  MessageBodyState expected, output;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  RawHdr parsed;
  FinishedMessageBody finished{"finished"_ns, 1, 1, 1, false};
  output.key = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.CompletePartialMessage(expected, parsed, finished, output));
  EXPECT_EQ(123u, output.key);
  ASSERT_EQ(NS_OK, db.SetMessageFlag(key, nsMsgMessageFlags::Partial, true));
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  ASSERT_EQ(NS_OK, db.SetMessageSize(key, 99));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.CompletePartialMessage(expected, parsed, finished, output));
  EXPECT_EQ(123u, output.key);
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.CompletePartialMessage(expected, parsed, finished, output));
  EXPECT_EQ(123u, output.key);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_EQ(NS_OK, db.RemoveMessage(key));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.CompletePartialMessage(expected, parsed, finished, output));
  EXPECT_EQ(123u, output.key);
}

TEST_F(DeliveryCoreReferences, SiblingOrderWriteFailureRollsBackSqlAndCache) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t a, b, c;
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Alpha"_ns, &a));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Bravo"_ns, &b));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Charlie"_ns, &c));
  ASSERT_EQ(NS_OK, folders.MoveFolderWithin(mFolderId, c, a));
  ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(mFolderId, {c, a, b}));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK, mConnection->CreateFunction("ordinal_fault"_ns, 1, witness));
  nsAutoCString sql(
      "CREATE TEMP TRIGGER reject_ordinal BEFORE UPDATE OF ordinal "
      "ON folders WHEN OLD.id=");
  sql.AppendInt(c);
  sql.AppendLiteral(
      " AND NEW.ordinal=2 BEGIN SELECT ordinal_fault(OLD.id); "
      "SELECT RAISE(ABORT,'second ordinal failure'); END");
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS reject_ordinal"_ns));
  });
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            folders.MoveFolderWithin(mFolderId, a, c));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(int64_t(c), witness->mLastKey);
  bool active = true;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(mFolderId, {c, a, b}));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER reject_ordinal"_ns));
  ASSERT_EQ(NS_OK, folders.MoveFolderWithin(mFolderId, a, c));
  ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(mFolderId, {a, c, b}));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(mFolderId, {a, c, b}));
  ASSERT_EQ(NS_OK, mCore->FolderDB().ResetChildOrder(mFolderId));
  ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(mFolderId, {a, b, c}, false));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(mFolderId, {a, b, c}, false));
}

TEST_F(DeliveryCoreReferences, SiblingOrderCommitFailureKeepsSqlAndCache) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t a, b, c;
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Alpha"_ns, &a));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Bravo"_ns, &b));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Charlie"_ns, &c));
  ASSERT_EQ(NS_OK, folders.MoveFolderWithin(mFolderId, c, a));
  ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(mFolderId, {c, a, b}));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "PRAGMA foreign_keys=ON; "
                "CREATE TEMP TABLE ordinal_parent(id INTEGER PRIMARY KEY); "
                "CREATE TEMP TABLE ordinal_child(id INTEGER REFERENCES "
                "ordinal_parent(id) "
                "DEFERRABLE INITIALLY DEFERRED)"_ns));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("ordinal_commit_fault"_ns, 1, witness));
  nsAutoCString sql(
      "CREATE TEMP TRIGGER reject_ordinal_commit "
      "AFTER UPDATE OF ordinal ON main.folders WHEN OLD.id=");
  sql.AppendInt(c);
  sql.AppendLiteral(
      " AND NEW.ordinal=2 BEGIN SELECT ordinal_commit_fault(OLD.id); "
      "INSERT INTO ordinal_child VALUES(OLD.id); END");
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS reject_ordinal_commit"_ns));
  });
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            folders.MoveFolderWithin(mFolderId, a, c));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(int64_t(c), witness->mLastKey);
  bool active = true;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(mFolderId, {c, a, b}));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER reject_ordinal_commit"_ns));
  ASSERT_EQ(NS_OK, folders.MoveFolderWithin(mFolderId, a, c));
  ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(mFolderId, {a, c, b}));
}

TEST_F(DeliveryCoreReferences, SiblingOrderRefusesForeignTransaction) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t a, b, c;
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Alpha"_ns, &a));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Bravo"_ns, &b));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Charlie"_ns, &c));
  ASSERT_EQ(NS_OK, folders.MoveFolderWithin(mFolderId, c, a));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    if (active) EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 73));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, folders.MoveFolderWithin(mFolderId, a, c));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, folders.ResetChildOrder(mFolderId));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  int64_t metric = 0;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, metric));
  EXPECT_EQ(73, metric);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(mFolderId, {c, a, b}));
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, metric));
  EXPECT_EQ(0, metric);
}

TEST_F(DeliveryCoreReferences, SiblingOrderRejectsRetiredFolderDatabase) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t a, b, c;
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Alpha"_ns, &a));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Bravo"_ns, &b));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Charlie"_ns, &c));
  ASSERT_EQ(NS_OK, folders.MoveFolderWithin(mFolderId, c, a));
  RefPtr<FolderDatabase> retired = &folders;
  Stop();
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, retired->MoveFolderWithin(mFolderId, a, c));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, retired->ResetChildOrder(mFolderId));
  ASSERT_EQ(NS_OK, Start());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, retired->MoveFolderWithin(mFolderId, a, c));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, retired->ResetChildOrder(mFolderId));
  ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(mFolderId, {c, a, b}));
  ASSERT_EQ(NS_OK, mCore->FolderDB().MoveFolderWithin(mFolderId, a, c));
  ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(mFolderId, {a, c, b}));
}

TEST_F(DeliveryCoreReferences, FolderRemovalAccountsWideLocalBytesBeforeEvent) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  RawHdr raw;
  raw.messageId = "account-local"_ns;
  raw.subject = "retained deleted header"_ns;
  raw.references = {"absent-parent"_ns, "ordered-tail"_ns};
  raw.flags = nsMsgMessageFlags::Offline;
  raw.messageSize = Some(UINT32_MAX);
  raw.offlineMessageSize = Some(19u);
  raw.storeToken = Some(nsCString("finished-owned-by-provider"_ns));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &key));
  // Warm the existing header; a failed removal must not replace it early.
  nsCString subject;
  ASSERT_EQ(NS_OK, db.GetMessageSubject(key, subject));
  uint32_t removed = 0;
  RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
  observer->action = [&](char kind, const CapturedMessage& before,
                         const CapturedMessage&, Message* live, bool) {
    EXPECT_EQ('R', kind);
    ++removed;
    EXPECT_EQ(key, before.id);
    EXPECT_EQ(mFolderId, before.folderId);
    EXPECT_EQ(raw.subject, before.subject);
    bool active = true, exists = true;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    EXPECT_EQ(NS_OK, db.MessageExists(key, exists));
    EXPECT_FALSE(exists);
    int64_t expunged = -1;
    EXPECT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
    EXPECT_EQ(int64_t(UINT32_MAX), expunged);
    nsCString retained;
    EXPECT_EQ(NS_OK, live->GetSubject(retained));
    EXPECT_EQ(raw.subject, retained);
  };
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, db.RemoveMessageFromFolder(
                       key, mFolderId, source,
                       MessageRemovalAccounting::LocalMessageSize));
  EXPECT_EQ(1u, removed);
  nsTArray<nsCString> references;
  ASSERT_EQ(NS_OK, Stored(key, references));
  EXPECT_TRUE(references.IsEmpty());
  ASSERT_EQ(NS_OK, db.GetMessageSubject(key, subject));
  EXPECT_EQ(raw.subject, subject);
  db.RemoveMessageListener(observer);
  unwatch.release();
  Stop();
  ASSERT_EQ(NS_OK, Start());
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(int64_t(UINT32_MAX), expunged);
  bool exists = true;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_FALSE(exists);
}

TEST_F(DeliveryCoreReferences, ReconcileCanonicalNamesRetainPhysicalMembers) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  const nsCString nfc = "Caf\xC3\xA9"_ns;
  const nsCString nfd = "Cafe\xCC\x81"_ns;
  uint64_t child, nested;
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, nfc, &child));
  ASSERT_EQ(NS_OK, folders.InsertFolder(child, "Nested"_ns, &nested));
  nsMsgKey key;
  const nsTArray<nsCString> references = {"missing-root"_ns, ""_ns, "tail"_ns,
                                          "missing-root"_ns};
  ASSERT_EQ(NS_OK, AddAt(nested, "canonical-child"_ns, references, key));
  auto& db = mCore->MessageDB();
  const nsCString property = "Exact\xCC\x81"_ns;
  ASSERT_EQ(NS_OK, db.SetMessageProperty(key, property, ""_ns));
  // Warm the original paths/identities before reconciliation.
  auto path = folders.GetFolderPath(nested);
  ASSERT_TRUE(path.isOk());
  nsCString originalPath = path.unwrap();
  ASSERT_EQ(NS_OK, folders.Reconcile(mFolderId, {nfd}));
  for (const auto& name : {nfc, nfd}) {
    auto found = folders.GetFolderChildNamed(mFolderId, name);
    ASSERT_TRUE(found.isOk());
    EXPECT_EQ(child, found.unwrap());
  }
  auto parent = folders.GetFolderParent(nested);
  ASSERT_TRUE(parent.isOk());
  EXPECT_EQ(child, parent.unwrap());
  auto newPath = folders.GetFolderPath(nested);
  ASSERT_TRUE(newPath.isOk());
  EXPECT_EQ(originalPath, newPath.unwrap());
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, PhysicalFolderKeys(nested, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{key}), keys);
  nsTArray<nsCString> stored;
  ASSERT_EQ(NS_OK, db.GetMessageReferences(key, stored));
  EXPECT_EQ(references, stored);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(key, names));
  EXPECT_TRUE(names.Contains(property));
  nsCString value = "unchanged"_ns;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, property, value));
  EXPECT_TRUE(value.IsEmpty());
  ASSERT_EQ(NS_OK, folders.Reconcile(mFolderId, {nfc}));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto found = mCore->FolderDB().GetFolderChildNamed(mFolderId, nfd);
  ASSERT_TRUE(found.isOk());
  EXPECT_EQ(child, found.unwrap());
  keys.Clear();
  ASSERT_EQ(NS_OK, PhysicalFolderKeys(nested, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{key}), keys);
}

TEST_F(DeliveryCoreReferences, ReconcileCanonicalDuplicatesKeepVirtualControl) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  const nsCString nfc = "Caf\xC3\xA9"_ns;
  const nsCString nfd = "Cafe\xCC\x81"_ns;
  uint64_t child, obsolete, control;
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, nfd, &child));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Obsolete"_ns, &obsolete));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Saved"_ns, &control));
  ASSERT_EQ(NS_OK, folders.UpdateFlags(control, nsMsgFolderFlags::Virtual));
  ASSERT_EQ(NS_OK, folders.Reconcile(mFolderId, {nfd, nfc, nfd}));
  auto found = folders.GetFolderChildNamed(mFolderId, nfc);
  ASSERT_TRUE(found.isOk());
  EXPECT_EQ(child, found.unwrap());
  auto removed = folders.GetFolderChildNamed(mFolderId, "Obsolete"_ns);
  ASSERT_TRUE(removed.isOk());
  EXPECT_EQ(0u, removed.unwrap());
  auto children = folders.GetFolderChildren(mFolderId);
  ASSERT_TRUE(children.isOk());
  auto ids = children.unwrap();
  EXPECT_EQ(2u, ids.Length());
  EXPECT_TRUE(ids.Contains(child));
  EXPECT_TRUE(ids.Contains(control));
  auto flags = folders.GetFolderFlags(control);
  ASSERT_TRUE(flags.isOk());
  EXPECT_EQ(uint32_t(nsMsgFolderFlags::Virtual), flags.unwrap());
}

TEST_F(DeliveryCoreReferences, HierarchyRenameRefusesCallerTxAndRetiredOwner) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t child;
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Alpha"_ns, &child));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, mFolderId, "Alpha"_ns));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    if (active) EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 73));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, folders.UpdateName(child, "Transient"_ns));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  int64_t metric = 0;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, metric));
  EXPECT_EQ(73, metric);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, mFolderId, "Alpha"_ns));
  RefPtr<FolderDatabase> retired = &folders;
  Stop();
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, retired->UpdateName(child, "Stale"_ns));
  ASSERT_EQ(NS_OK, Start());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, retired->UpdateName(child, "Stale"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, mFolderId, "Alpha"_ns));
  ASSERT_EQ(NS_OK, mCore->FolderDB().UpdateName(child, "Cafe\xCC\x81"_ns));
  ASSERT_NO_FATAL_FAILURE(
      CheckFolderIdentity(child, mFolderId, "Caf\xC3\xA9"_ns));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ASSERT_NO_FATAL_FAILURE(
      CheckFolderIdentity(child, mFolderId, "Caf\xC3\xA9"_ns));
}

TEST_F(DeliveryCoreReferences,
       HierarchyReparentRefusesCallerTxAndRetiredOwner) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t left, right, child, nested;
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Left"_ns, &left));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Right"_ns, &right));
  ASSERT_EQ(NS_OK, folders.InsertFolder(left, "Child"_ns, &child));
  ASSERT_EQ(NS_OK, folders.InsertFolder(child, "Nested"_ns, &nested));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, AddAt(nested, "hierarchy-member"_ns, {}, key));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, left, "Child"_ns));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    if (active) EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 81));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, folders.MoveFolderTo(right, child));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, left, "Child"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(nested, child, "Nested"_ns));
  RefPtr<FolderDatabase> retired = &folders;
  Stop();
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, retired->MoveFolderTo(right, child));
  ASSERT_EQ(NS_OK, Start());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, retired->MoveFolderTo(right, child));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, left, "Child"_ns));
  ASSERT_EQ(NS_OK, mCore->FolderDB().MoveFolderTo(right, child));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, right, "Child"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(nested, child, "Nested"_ns));
  bool exists = false;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_TRUE(exists);
  uint64_t actualFolder;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageFolderId(key, actualFolder));
  EXPECT_EQ(nested, actualFolder);
}

TEST_F(DeliveryCoreReferences, HierarchyWriteFailureKeepsCachedPathAndRows) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t left, right, child;
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Left"_ns, &left));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Right"_ns, &right));
  ASSERT_EQ(NS_OK, folders.InsertFolder(left, "Child"_ns, &child));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, left, "Child"_ns));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("hierarchy_fault"_ns, 1, witness));
  nsAutoCString sql(
      "CREATE TEMP TRIGGER reject_hierarchy "
      "BEFORE UPDATE OF name,parent ON folders WHEN OLD.id=");
  sql.AppendInt(child);
  sql.AppendLiteral(
      " BEGIN SELECT hierarchy_fault(OLD.id); "
      "SELECT RAISE(ABORT,'hierarchy write failure'); END");
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS reject_hierarchy"_ns));
  });
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            folders.UpdateName(child, "Renamed"_ns));
  EXPECT_EQ(1u, witness->mCalls);
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, left, "Child"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, folders.MoveFolderTo(right, child));
  EXPECT_EQ(2u, witness->mCalls);
  EXPECT_EQ(int64_t(child), witness->mLastKey);
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, left, "Child"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(right, mFolderId, "Right"_ns));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER reject_hierarchy"_ns));
  ASSERT_EQ(NS_OK, folders.UpdateName(child, "Renamed"_ns));
  ASSERT_EQ(NS_OK, folders.MoveFolderTo(right, child));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, right, "Renamed"_ns));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, right, "Renamed"_ns));
}

TEST_F(DeliveryCoreReferences,
       FolderRemovalRemoteAndGenericPoliciesStayDistinct) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  RawHdr raw;
  raw.messageId = "remote-online"_ns;
  raw.messageSize = Some(97u);
  raw.offlineMessageSize = Some(UINT32_MAX);
  nsMsgKey online, offline, generic, absent;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &online));
  raw.messageId = "remote-offline"_ns;
  raw.flags = nsMsgMessageFlags::Offline;
  raw.offlineMessageSize = Some(0x80000000u);
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &offline));
  raw.messageId = "generic-unaccounted"_ns;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &generic));
  ASSERT_EQ(NS_OK, Add("absent-size"_ns, {}, absent));
  ASSERT_EQ(NS_OK, db.RemoveMessageFromFolder(
                       online, mFolderId, source,
                       MessageRemovalAccounting::OfflineMessageSize));
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(0, expunged);
  ASSERT_EQ(NS_OK, db.RemoveMessageFromFolder(
                       offline, mFolderId, source,
                       MessageRemovalAccounting::OfflineMessageSize));
  ASSERT_EQ(NS_OK, db.RemoveMessage(generic));
  ASSERT_EQ(NS_OK, db.RemoveMessageFromFolder(
                       absent, mFolderId, source,
                       MessageRemovalAccounting::LocalMessageSize));
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(int64_t(0x80000000u), expunged);
}

TEST_F(DeliveryCoreReferences,
       FolderRemovalRejectsForeignAndUnpublishedIdentity) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  uint64_t other;
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolderId, "Other"_ns, &other));
  nsMsgKey key, staged;
  ASSERT_EQ(NS_OK, Add("owned-removal"_ns, {}, key));
  RawHdr raw;
  raw.messageId = "unpublished-removal"_ns;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  auto policy = MessageRemovalAccounting::LocalMessageSize;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.RemoveMessageFromFolder(key, other, source, policy));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.RemoveMessageFromFolder(key, mFolderId, "other-incarnation"_ns,
                                       policy));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.RemoveMessageFromFolder(staged, mFolderId, source, policy));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.RemoveMessageFromFolder(1234567, mFolderId, source, policy));
  EXPECT_EQ(
      NS_ERROR_INVALID_ARG,
      db.RemoveMessageFromFolder(nsMsgKey_None, mFolderId, source, policy));
  bool exists = false;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_TRUE(exists);
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{staged}), keys);
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(0, expunged);
  ASSERT_EQ(NS_OK, RemovalMetric(other, expunged));
  EXPECT_EQ(0, expunged);
}

TEST_F(DeliveryCoreReferences, FolderRemovalRejectsSizeAndCounterOverflow) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("invalid-accounting"_ns, {}, key));
  for (const auto& size : {"-1"_ns, "4294967296"_ns}) {
    nsAutoCString sql("REPLACE INTO message_properties VALUES(");
    sql.AppendInt(key);
    sql.AppendLiteral(",'messageSize',");
    sql.Append(size);
    sql.Append(')');
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    EXPECT_EQ(
        NS_ERROR_LOSS_OF_SIGNIFICANT_DATA,
        db.RemoveMessageFromFolder(key, mFolderId, source,
                                   MessageRemovalAccounting::LocalMessageSize));
    bool exists = false;
    ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
    EXPECT_TRUE(exists);
  }
  ASSERT_EQ(NS_OK, db.SetMessageSize(key, 1));
  for (int64_t metric : {-int64_t(1), INT64_MAX}) {
    ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, metric));
    EXPECT_EQ(
        NS_ERROR_LOSS_OF_SIGNIFICANT_DATA,
        db.RemoveMessageFromFolder(key, mFolderId, source,
                                   MessageRemovalAccounting::LocalMessageSize));
    int64_t retained = 0;
    ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, retained));
    EXPECT_EQ(metric, retained);
    bool exists = false;
    ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
    EXPECT_TRUE(exists);
  }
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, INT64_MAX - 1));
  ASSERT_EQ(NS_OK, db.RemoveMessageFromFolder(
                       key, mFolderId, source,
                       MessageRemovalAccounting::LocalMessageSize));
  int64_t expunged = 0;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(INT64_MAX, expunged);
}

TEST_F(DeliveryCoreReferences,
       FolderRemovalWriteFailuresRollBackCounterAndRow) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  RawHdr raw;
  raw.messageId = "removal-fault"_ns;
  raw.subject = "warm unchanged"_ns;
  raw.references = {"first"_ns, ""_ns, "last"_ns};
  raw.messageSize = Some(42u);
  raw.storeToken = Some(nsCString("provider-body"_ns));
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &key));
  ASSERT_EQ(NS_OK, Add("removal-control"_ns, {}, control));
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 7));
  nsCString subject;
  ASSERT_EQ(NS_OK, db.GetMessageSubject(key, subject));
  MessageBodyState before;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, before));
  uint32_t removed = 0;
  RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
  observer->action = [&](char kind, const CapturedMessage&,
                         const CapturedMessage&, Message*, bool) {
    EXPECT_EQ('R', kind);
    ++removed;
  };
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK, mConnection->CreateFunction("removal_fault"_ns, 1, witness));
  const nsCString triggers[] = {
      "CREATE TEMP TRIGGER reject_removal BEFORE INSERT ON folder_properties "
      "WHEN NEW.name='expungedBytes' BEGIN SELECT removal_fault(NEW.id); "
      "SELECT RAISE(ABORT,'counter failure'); END"_ns,
      "CREATE TEMP TRIGGER reject_removal BEFORE DELETE ON messages "
      "BEGIN SELECT removal_fault(OLD.id); "
      "SELECT RAISE(ABORT,'delete failure'); END"_ns};
  for (uint32_t i = 0; i < 2; ++i) {
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(triggers[i]));
    auto drop = MakeScopeExit([&] {
      EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "DROP TRIGGER IF EXISTS reject_removal"_ns));
    });
    EXPECT_EQ(
        NS_ERROR_STORAGE_CONSTRAINT,
        db.RemoveMessageFromFolder(key, mFolderId, source,
                                   MessageRemovalAccounting::LocalMessageSize));
    EXPECT_EQ(i + 1, witness->mCalls);
    EXPECT_EQ(i == 0 ? int64_t(mFolderId) : int64_t(key), witness->mLastKey);
    EXPECT_EQ(0u, removed);
    bool active = true, exists = false;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
    EXPECT_TRUE(exists);
    ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
    EXPECT_TRUE(exists);
    int64_t expunged = -1;
    ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
    EXPECT_EQ(7, expunged);
    ASSERT_EQ(NS_OK, db.GetMessageSubject(key, subject));
    EXPECT_EQ(raw.subject, subject);
    MessageBodyState after;
    ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, after));
    EXPECT_EQ(before.storeToken, after.storeToken);
    EXPECT_EQ(before.contentRevision, after.contentRevision);
    EXPECT_EQ(before.locationRevision, after.locationRevision);
    nsTArray<nsCString> references;
    ASSERT_EQ(NS_OK, Stored(key, references));
    EXPECT_EQ(raw.references, references);
  }
  ASSERT_EQ(NS_OK, db.RemoveMessageFromFolder(
                       key, mFolderId, source,
                       MessageRemovalAccounting::LocalMessageSize));
  EXPECT_EQ(1u, removed);
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(49, expunged);
}

TEST_F(DeliveryCoreReferences,
       FolderRemovalReadFailurePreservesCounterAndEvents) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("removal-read-fault"_ns, {}, key));
  ASSERT_EQ(NS_OK, db.SetMessageSize(key, 23));
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 9));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("removal_read_fault"_ns, 1, witness));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "CREATE TEMP VIEW folder_properties AS SELECT id,name, "
                "CASE WHEN name='expungedBytes' AND removal_read_fault(id)=0 "
                "THEN abs(-9223372036854775808) ELSE value END AS value "
                "FROM main.folder_properties"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.folder_properties"_ns));
  });
  uint32_t removed = 0;
  RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
  observer->action = [&](char, const CapturedMessage&, const CapturedMessage&,
                         Message*, bool) { ++removed; };
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  EXPECT_EQ(NS_ERROR_FAILURE, db.RemoveMessageFromFolder(
                                  key, mFolderId, source,
                                  MessageRemovalAccounting::LocalMessageSize));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(int64_t(mFolderId), witness->mLastKey);
  EXPECT_EQ(0u, removed);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.folder_properties"_ns));
  bool exists = false;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_TRUE(exists);
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(9, expunged);
}

TEST_F(DeliveryCoreReferences, FolderRemovalDoesNotTakeCallerTransaction) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("removal-foreign-transaction"_ns, {}, key));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 83));
  EXPECT_EQ(
      NS_ERROR_IN_PROGRESS,
      db.RemoveMessageFromFolder(key, mFolderId, source,
                                 MessageRemovalAccounting::LocalMessageSize));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(83, expunged);
  ASSERT_EQ(NS_OK, mConnection->CommitTransaction());
  bool exists = false;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreReferences, FolderRemovalRespectsPendingBodyRelocation) {
  ASSERT_EQ(NS_OK, Start());
  FolderBodyRelocation plan;
  ASSERT_EQ(NS_OK, PrepareRelocation(plan));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.PrepareBodyRelocation(plan));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.RemoveMessageFromFolder(
                plan.messages[0].before.key, mFolderId, plan.databaseSourceId,
                MessageRemovalAccounting::LocalMessageSize));
  bool exists = false;
  ASSERT_EQ(NS_OK, db.MessageExists(plan.messages[0].before.key, exists));
  EXPECT_TRUE(exists);
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(0, expunged);
  ASSERT_EQ(NS_OK, db.SettleBodyRelocation(mFolderId, plan.token,
                                           BodyRelocationOutcome::Restored));
}

TEST_F(DeliveryCoreReferences,
       FolderRemovalCommitFailureRollsBackCounterAndRow) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  RawHdr raw;
  raw.messageId = "removal-commit-fault"_ns;
  raw.messageSize = Some(42u);
  raw.storeToken = Some(nsCString("retained-body"_ns));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &key));
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 7));
  MessageBodyState before;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, before));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "PRAGMA foreign_keys=ON; "
                "CREATE TEMP TABLE removal_parent(id INTEGER PRIMARY KEY); "
                "CREATE TEMP TABLE removal_child(id INTEGER REFERENCES "
                "removal_parent(id) "
                "DEFERRABLE INITIALLY DEFERRED)"_ns));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("removal_commit_fault"_ns, 1, witness));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER reject_removal_commit AFTER DELETE "
                       "ON main.messages "
                       "BEGIN SELECT removal_commit_fault(OLD.id); "
                       "INSERT INTO removal_child VALUES(OLD.id); END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS reject_removal_commit"_ns));
  });
  uint32_t removed = 0;
  RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
  observer->action = [&](char, const CapturedMessage&, const CapturedMessage&,
                         Message*, bool) { ++removed; };
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  EXPECT_EQ(
      NS_ERROR_STORAGE_CONSTRAINT,
      db.RemoveMessageFromFolder(key, mFolderId, source,
                                 MessageRemovalAccounting::LocalMessageSize));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(int64_t(key), witness->mLastKey);
  EXPECT_EQ(0u, removed);
  bool active = true, exists = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_TRUE(exists);
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(7, expunged);
  MessageBodyState after;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, after));
  EXPECT_EQ(before.storeToken, after.storeToken);
  EXPECT_EQ(before.contentRevision, after.contentRevision);
  EXPECT_EQ(before.locationRevision, after.locationRevision);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER reject_removal_commit"_ns));
  ASSERT_EQ(NS_OK, db.RemoveMessageFromFolder(
                       key, mFolderId, source,
                       MessageRemovalAccounting::LocalMessageSize));
  EXPECT_EQ(1u, removed);
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(49, expunged);
}

TEST_F(DeliveryCoreReferences,
       FolderAdmissionReadsCallerTransactionWithoutOwningIt) {
  ASSERT_EQ(NS_OK, Start());
  nsCString expected;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(expected));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    if (active) EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 83));
  nsCString admitted = "unchanged"_ns;
  ASSERT_EQ(NS_OK, AdmissionSource(mCore, admitted));
  EXPECT_EQ(expected, admitted);
  nsCString publicOutput = "public-unchanged"_ns;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, mCore->GetSourceId(publicOutput));
  EXPECT_EQ("public-unchanged"_ns, publicOutput);
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  int64_t expunged = 0;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(83, expunged);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(0, expunged);
  ASSERT_EQ(NS_OK, mCore->GetSourceId(publicOutput));
  EXPECT_EQ(admitted, publicOutput);
}

TEST_F(DeliveryCoreReferences,
       FolderAdmissionRolledBackIdentityCannotRemoveRows) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("admitted-incarnation"_ns, {}, key));
  nsCString committed;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(committed));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    if (active) EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
  });
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "UPDATE database_identity SET "
          "sourceId='{12345678-9ABC-4def-8123-0123456789ab}' WHERE singleton=1"_ns));
  nsCString admitted;
  ASSERT_EQ(NS_OK, AdmissionSource(mCore, admitted));
  EXPECT_EQ("{12345678-9ABC-4def-8123-0123456789ab}"_ns, admitted);
  EXPECT_NE(committed, admitted);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->MessageDB().RemoveMessageFromFolder(
                key, mFolderId, admitted,
                MessageRemovalAccounting::LocalMessageSize));
  bool exists = false;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_TRUE(exists);
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(0, expunged);
  EXPECT_EQ("{12345678-9ABC-4def-8123-0123456789ab}"_ns, admitted);
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessageFromFolder(
                       key, mFolderId, committed,
                       MessageRemovalAccounting::LocalMessageSize));
}

TEST_F(DeliveryCoreReferences,
       FolderAdmissionReadErrorsKeepOutputAndTransaction) {
  ASSERT_EQ(NS_OK, Start());
  nsCString expected;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(expected));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("admission_fault"_ns, 1, witness));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    if (active) EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 31));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "CREATE TEMP VIEW database_identity AS "
                       "SELECT singleton,sourceId FROM main.database_identity "
                       "WHERE CASE WHEN admission_fault(singleton)=0 "
                       "THEN abs(-9223372036854775808) ELSE 1 END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.database_identity"_ns));
  });
  nsCString output = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_FAILURE, AdmissionSource(mCore, output));
  EXPECT_EQ("unchanged"_ns, output);
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(1, witness->mLastKey);
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.database_identity"_ns));
  ASSERT_EQ(NS_OK, AdmissionSource(mCore, output));
  EXPECT_EQ(expected, output);
  ASSERT_EQ(NS_OK, mConnection->CommitTransaction());
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(31, expunged);
}

TEST_F(DeliveryCoreReferences, FolderAdmissionRejectsCorruptAndRetiredSources) {
  ASSERT_EQ(NS_OK, Start());
  nsCString expected;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(expected));
  for (const auto& sql :
       {"DELETE FROM database_identity"_ns,
        "UPDATE database_identity SET sourceId='not-a-uuid'"_ns,
        "UPDATE database_identity SET sourceId=''"_ns}) {
    ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
    auto rollback = MakeScopeExit([&] {
      bool active = false;
      EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
      if (active) EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
    });
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    nsCString output = "unchanged"_ns;
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, AdmissionSource(mCore, output));
    EXPECT_EQ("unchanged"_ns, output);
    ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  }
  RefPtr<DatabaseCore> retired = mCore;
  Stop();
  nsCString output = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, AdmissionSource(retired, output));
  EXPECT_EQ("unchanged"_ns, output);
  ASSERT_EQ(NS_OK, Start());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, AdmissionSource(retired, output));
  EXPECT_EQ("unchanged"_ns, output);
  ASSERT_EQ(NS_OK, AdmissionSource(mCore, output));
  EXPECT_EQ(expected, output);
}

TEST_F(DeliveryCoreReferences,
       UndoCaptureRestoresCompleteMetadataWithFreshIdentity) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  RawHdr raw;
  raw.messageId = "undo@invalid"_ns;
  raw.subject = "saved subject"_ns;
  raw.sender = "saved author"_ns;
  raw.recipients = "saved recipients"_ns;
  raw.ccList = "saved cc"_ns;
  raw.bccList = "saved bcc"_ns;
  raw.date = 123456789;
  raw.priority = nsMsgPriority::highest;
  raw.flags = nsMsgMessageFlags::Expunged | nsMsgMessageFlags::Read;
  raw.keywords = "saved tags"_ns;
  raw.references = {"missing@invalid"_ns, "missing@invalid"_ns, ""_ns};
  raw.storeToken = Some(nsCString("old-body"_ns));
  raw.messageSize = Some(uint32_t(21));
  raw.extras = {{"Case"_ns, "00042"_ns},
                {"case"_ns, "1e3"_ns},
                {"empty"_ns, ""_ns},
                {"msgCharSet"_ns, "UTF-8"_ns},
                {"replyTo"_ns, "reply@invalid"_ns},
                {"account"_ns, "old-account"_ns}};
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &key));
  ASSERT_EQ(NS_OK, db.SetMessageProperty(key, "native"_ns, UINT32_MAX));
  ASSERT_EQ(NS_OK, db.SetMessageUidOnServer(key, 42));
  RemovedMessage snapshot;
  uint32_t removed = 0;
  RefPtr<UndoRemovalObserver> removal =
      new UndoRemovalObserver([&](Message* old) {
        ++removed;
        ASSERT_TRUE(snapshot.Body());
        EXPECT_EQ(key, snapshot.Body()->key);
        EXPECT_EQ(Some(nsCString("old-body"_ns)), snapshot.Body()->storeToken);
        bool exists = true;
        ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
        EXPECT_FALSE(exists);
        nsCString subject;
        ASSERT_EQ(NS_OK, old->GetSubject(subject));
        EXPECT_EQ("saved subject"_ns, subject);
      });
  db.AddMessageListener(removal);
  auto remove = MakeScopeExit([&] { db.RemoveMessageListener(removal); });
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(key, snapshot));
  EXPECT_EQ(1u, removed);
  db.RemoveMessageListener(removal);
  remove.release();
  uint32_t published = 0;
  RefPtr<AddedObserver> observer = new AddedObserver([&](Message* restored) {
    ++published;
    EXPECT_FALSE(snapshot.Body());
    bool active;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    nsMsgKey actual;
    ASSERT_EQ(NS_OK, restored->GetMessageKey(&actual));
    EXPECT_NE(key, actual);
    nsCString text;
    ASSERT_EQ(NS_OK, restored->GetSubject(text));
    EXPECT_EQ("saved subject"_ns, text);
    ASSERT_EQ(NS_OK, restored->GetStoreToken(text));
    EXPECT_EQ("finished-body"_ns, text);
    ASSERT_EQ(NS_OK, restored->GetMessageId(text));
    EXPECT_EQ("undo@invalid"_ns, text);
    ASSERT_EQ(NS_OK, restored->GetAuthor(text));
    EXPECT_EQ("saved author"_ns, text);
    ASSERT_EQ(NS_OK, restored->GetRecipients(text));
    EXPECT_EQ("saved recipients"_ns, text);
    ASSERT_EQ(NS_OK, restored->GetCcList(text));
    EXPECT_EQ("saved cc"_ns, text);
    ASSERT_EQ(NS_OK, restored->GetBccList(text));
    EXPECT_EQ("saved bcc"_ns, text);
    PRTime date;
    ASSERT_EQ(NS_OK, restored->GetDate(&date));
    EXPECT_EQ(123456789, date);
    nsMsgPriorityValue priority;
    ASSERT_EQ(NS_OK, restored->GetPriority(&priority));
    EXPECT_EQ(nsMsgPriority::highest, priority);
    ASSERT_EQ(NS_OK, db.GetMessageTags(actual, text));
    EXPECT_EQ("saved tags"_ns, text);
    ASSERT_EQ(NS_OK, db.GetMessageProperty(actual, "replyTo"_ns, text));
    EXPECT_EQ("reply@invalid"_ns, text);
    ASSERT_EQ(NS_OK, db.GetMessageProperty(actual, "msgCharSet"_ns, text));
    EXPECT_EQ("UTF-8"_ns, text);
    ASSERT_EQ(NS_OK, db.GetMessageProperty(actual, "account"_ns, text));
    EXPECT_EQ("old-account"_ns, text);
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
    auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
    ASSERT_EQ(NS_OK, PublicationCell(
                         reader, actual,
                         "SELECT subject FROM messages WHERE id=:id"_ns, text));
    EXPECT_EQ("saved subject"_ns, text);
    ASSERT_EQ(
        NS_OK,
        PublicationCell(
            reader, actual,
            "SELECT typeof(value) FROM message_properties WHERE id=:id AND name='native'"_ns,
            text));
    EXPECT_EQ("integer"_ns, text);
    ASSERT_EQ(NS_OK, db.GetMessageProperty(actual, "Case"_ns, text));
    EXPECT_EQ("00042"_ns, text);
    nsTArray<nsCString> refs;
    ASSERT_EQ(NS_OK, Stored(actual, refs));
    EXPECT_EQ((nsTArray<nsCString>{"missing@invalid"_ns, "missing@invalid"_ns,
                                   ""_ns}),
              refs);
  });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  FinishedMessageBody finished{"finished-body"_ns, 101, 99, 8, true};
  nsMsgKey restored = nsMsgKey_None;
  ASSERT_EQ(NS_OK,
            db.RestoreMessageForUndo(mFolderId, snapshot, finished, &restored));
  EXPECT_EQ(1u, published);
  EXPECT_NE(key, restored);
  uint32_t flags;
  ASSERT_EQ(NS_OK, db.GetMessageFlags(restored, flags));
  EXPECT_EQ(uint32_t(nsMsgMessageFlags::Read | nsMsgMessageFlags::Offline),
            flags);
  uint32_t value = 0;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(restored, "native"_ns, value));
  EXPECT_EQ(UINT32_MAX, value);
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(restored, "case"_ns, text));
  EXPECT_EQ("1e3"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(restored, "empty"_ns, text));
  EXPECT_TRUE(text.IsEmpty());
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(restored, names));
  EXPECT_TRUE(names.Contains("empty"_ns));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  nsMsgKey untouched = 123;
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      db.RestoreMessageForUndo(mFolderId, snapshot, finished, &untouched));
  EXPECT_EQ(123u, untouched);
}

static void CheckUndoOfflinePayload(const OfflineOperationData& expected,
                                    const OfflineOperationData& actual) {
  EXPECT_EQ(expected.operation, actual.operation);
  EXPECT_EQ(expected.flagOperation, actual.flagOperation);
  EXPECT_EQ(expected.newFlags, actual.newFlags);
  EXPECT_EQ(expected.sourceKey, actual.sourceKey);
  EXPECT_EQ(expected.sourceUid, actual.sourceUid);
  EXPECT_EQ(expected.messageSize, actual.messageSize);
  EXPECT_EQ(expected.playingBack, actual.playingBack);
  EXPECT_EQ(expected.sourceFolderURI, actual.sourceFolderURI);
  EXPECT_EQ(expected.destinationFolderURI, actual.destinationFolderURI);
  EXPECT_EQ(expected.keywordsToAdd, actual.keywordsToAdd);
  EXPECT_EQ(expected.keywordsToRemove, actual.keywordsToRemove);
  EXPECT_EQ(expected.copyDestinations, actual.copyDestinations);
  auto target = [](const Maybe<PendingDestination>& a,
                   const Maybe<PendingDestination>& b) {
    ASSERT_EQ(a.isSome(), b.isSome());
    if (a) {
      EXPECT_EQ(a->folderId, b->folderId);
      EXPECT_EQ(a->key, b->key);
      EXPECT_EQ(a->epoch, b->epoch);
      EXPECT_EQ(a->epochKnown, b->epochKnown);
    }
  };
  target(expected.pendingDestination, actual.pendingDestination);
  ASSERT_EQ(expected.copyDestinationBindings.Length(),
            actual.copyDestinationBindings.Length());
  for (size_t i = 0; i < expected.copyDestinationBindings.Length(); ++i) {
    target(expected.copyDestinationBindings[i],
           actual.copyDestinationBindings[i]);
  }
}

TEST_F(DeliveryCoreReferences,
       RetainedSourceUndoSettlesChildrenBeforePublication) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey old, target;
  QueuedSourceIdentity identity;
  ASSERT_EQ(NS_OK, QueuedSourceForUndo(old, target, identity));
  OfflineOperationData expected;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, old, expected));
  OfflineOperationUndo offline;
  ASSERT_EQ(NS_OK, db.CaptureOfflineOperationForUndo(
                       mFolderId, old, identity.databaseSourceId, offline));
  RemovedMessage removed;
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(old, removed));
  // The actual replay operation stays present, unchanged, through source
  // removal.
  QueuedSourceIdentity retained;
  ASSERT_EQ(NS_OK, db.GetQueuedSourceIdentity(mFolderId, old, retained));
  EXPECT_EQ(identity.operationId, retained.operationId);
  EXPECT_EQ(identity.revision, retained.revision);
  uint32_t calls = 0;
  nsMsgKey fresh = nsMsgKey_None;
  Message* live = nullptr;
  RefPtr<AddedObserver> observer = new AddedObserver([&](Message* message) {
    ++calls;
    EXPECT_EQ(live, message);
    EXPECT_FALSE(removed.Body());
    EXPECT_FALSE(offline.Operation());
    OfflineOperationData child, source;
    ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, target, child));
    EXPECT_EQ(fresh, child.sourceKey);
    EXPECT_EQ(old, child.sourceUid);
    EXPECT_EQ("imap://actual/source"_ns, child.sourceFolderURI);
    ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, fresh, source));
    CheckUndoOfflinePayload(expected, source);
    QueuedSourceIdentity actual;
    ASSERT_EQ(NS_OK, db.GetQueuedSourceIdentity(mFolderId, fresh, actual));
    EXPECT_EQ(identity.operationId, actual.operationId);
    EXPECT_EQ(identity.revision, actual.revision);
    ASSERT_TRUE(actual.source);
    EXPECT_EQ(old, actual.source->key);
    EXPECT_EQ(old, actual.source->uid);
    EXPECT_EQ(7u, actual.source->epoch);
    bool active;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
  });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  FinishedMessageBody finished{"actual-finished-restore"_ns, 23, 23, 2, true};
  ASSERT_EQ(NS_OK, db.RestoreMessageForUndo(mFolderId, removed, finished,
                                            &fresh, &live, &offline));
  RefPtr<Message> hold = dont_AddRef(live);
  EXPECT_NE(old, fresh);
  EXPECT_EQ(1u, calls);
  cleanup.release();
  db.RemoveMessageListener(observer);
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->MessageDB();
  ASSERT_EQ(NS_OK,
            reopened.GetQueuedSourceIdentity(mFolderId, fresh, retained));
  EXPECT_EQ(identity.operationId, retained.operationId);
  EXPECT_EQ(identity.revision, retained.revision);
  OfflineOperationData child;
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperation(mFolderId, target, child));
  EXPECT_EQ(fresh, child.sourceKey);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            reopened.GetOfflineOperation(mFolderId, old, child));
}

TEST_F(DeliveryCoreReferences, RetainedSourceUndoRejectsChangedOrSentCustody) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  for (bool sent : {false, true}) {
    nsMsgKey old, target;
    QueuedSourceIdentity identity;
    ASSERT_EQ(NS_OK, QueuedSourceForUndo(old, target, identity));
    OfflineOperationUndo offline;
    ASSERT_EQ(NS_OK, db.CaptureOfflineOperationForUndo(
                         mFolderId, old, identity.databaseSourceId, offline));
    RemovedMessage removed;
    ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(old, removed));
    if (sent) {
      OfflineOperationData op;
      ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, old, op));
      uint64_t attempt;
      ASSERT_EQ(NS_OK, db.BeginOfflineAction(
                           mFolderId, old, nsIMsgOfflineImapOperation::kMsgCopy,
                           op.copyDestinationBindings[0], Some(0u), attempt));
    } else {
      OfflineOperationData child;
      ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, target, child));
      child.keywordsToAdd = "changed child"_ns;
      ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, target, child));
    }
    FinishedMessageBody finished{"finished-recovery-kept"_ns, 12, 12, 1, true};
    nsMsgKey untouched = 123;
    Message* live = nullptr;
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.RestoreMessageForUndo(mFolderId, removed, finished, &untouched,
                                       &live, &offline));
    EXPECT_EQ(123u, untouched);
    EXPECT_EQ(nullptr, live);
    EXPECT_TRUE(removed.Body());
    EXPECT_TRUE(offline.Operation());
    QueuedSourceIdentity retained;
    ASSERT_EQ(NS_OK, db.GetQueuedSourceIdentity(mFolderId, old, retained));
    EXPECT_EQ(identity.operationId, retained.operationId);
    OfflineOperationData child;
    ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, target, child));
    EXPECT_EQ(old, child.sourceKey);
    bool active;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
  }
}

TEST_F(DeliveryCoreReferences,
       RetainedSourceUndoRejectsChangedEpochOrMissingTarget) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  for (bool missing : {false, true}) {
    nsMsgKey old, target;
    QueuedSourceIdentity identity;
    ASSERT_EQ(NS_OK, QueuedSourceForUndo(old, target, identity));
    OfflineOperationUndo offline;
    ASSERT_EQ(NS_OK, db.CaptureOfflineOperationForUndo(
                         mFolderId, old, identity.databaseSourceId, offline));
    RemovedMessage removed;
    ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(old, removed));
    if (missing) {
      ASSERT_EQ(NS_OK, db.RemoveMessage(target));
    } else {
      ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 8));
    }
    FinishedMessageBody finished{"retained-recovery"_ns, 12, 12, 1, true};
    nsMsgKey unchanged = 123;
    Message* live = nullptr;
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.RestoreMessageForUndo(mFolderId, removed, finished, &unchanged,
                                       &live, &offline));
    EXPECT_EQ(123u, unchanged);
    EXPECT_EQ(nullptr, live);
    EXPECT_TRUE(removed.Body());
    EXPECT_TRUE(offline.Operation());
    QueuedSourceIdentity actual;
    ASSERT_EQ(NS_OK, db.GetQueuedSourceIdentity(mFolderId, old, actual));
    EXPECT_EQ(identity.operationId, actual.operationId);
    EXPECT_EQ(identity.revision, actual.revision);
    ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
  }
}

TEST_F(DeliveryCoreReferences,
       RetainedSourceUndoSqlFailureKeepsRecoveryAndMappings) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey old, target;
  QueuedSourceIdentity identity;
  ASSERT_EQ(NS_OK, QueuedSourceForUndo(old, target, identity));
  OfflineOperationUndo offline;
  ASSERT_EQ(NS_OK, db.CaptureOfflineOperationForUndo(
                       mFolderId, old, identity.databaseSourceId, offline));
  RemovedMessage removed;
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(old, removed));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("retained_undo_fault"_ns, 1, witness));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER reject_retained_source AFTER "
                       "UPDATE OF messageKey "
                       "ON main.offline_operations BEGIN SELECT "
                       "retained_undo_fault(NEW.id); "
                       "SELECT RAISE(ABORT,'retained source'); END"_ns));
  auto cleanup = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS reject_retained_source"_ns));
    EXPECT_EQ(NS_OK, mConnection->RemoveFunction("retained_undo_fault"_ns));
  });
  FinishedMessageBody finished{"finished-recovery-kept"_ns, 12, 12, 1, true};
  nsMsgKey untouched = 123;
  Message* live = nullptr;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.RestoreMessageForUndo(mFolderId, removed, finished, &untouched,
                                     &live, &offline));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(123u, untouched);
  EXPECT_EQ(nullptr, live);
  EXPECT_TRUE(removed.Body());
  EXPECT_TRUE(offline.Operation());
  QueuedSourceIdentity retained;
  ASSERT_EQ(NS_OK, db.GetQueuedSourceIdentity(mFolderId, old, retained));
  EXPECT_EQ(identity.operationId, retained.operationId);
  OfflineOperationData child;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, target, child));
  EXPECT_EQ(old, child.sourceKey);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER reject_retained_source"_ns));
  ASSERT_EQ(NS_OK, db.RestoreMessageForUndo(mFolderId, removed, finished,
                                            &untouched, &live, &offline));
  RefPtr<Message> hold = dont_AddRef(live);
  EXPECT_NE(123u, untouched);
}

TEST_F(DeliveryCoreReferences,
       TypedReturnHomeBindsCapturedTupleBeforePublication) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey old, target, staged;
  QueuedSourceIdentity identity;
  ASSERT_EQ(NS_OK, QueuedSourceForUndo(old, target, identity));
  ASSERT_EQ(NS_OK, db.RemoveMessage(old));
  RawHdr raw;
  raw.messageId = "returning-metadata-only"_ns;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  MessageBodyState returning;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(target, returning));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BindMessageToServerUid(staged, mFolderId, 7, old));
  ASSERT_EQ(NS_OK, db.BindStagedMessageToQueuedSource(
                       staged, mFolderId, identity, Some(0u), returning));
  uint32_t uid;
  RefPtr<Message> stagedHeader = new Message(staged);
  ASSERT_EQ(NS_OK, stagedHeader->GetUint32Property("uidOnServer", &uid));
  EXPECT_EQ(old, uid);
  nsCString stored;
  ASSERT_EQ(
      NS_OK,
      PublicationCell(
          mConnection, staged,
          "SELECT value FROM staged_message_properties WHERE id=:id AND name='uidOnServer'"_ns,
          stored));
  nsAutoCString expectedUid;
  expectedUid.AppendInt(old);
  EXPECT_EQ(expectedUid, stored);
  bool isStaged;
  ASSERT_EQ(NS_OK, MessageIsStaged(staged, isStaged));
  EXPECT_TRUE(isStaged);
  uint32_t calls = 0;
  RefPtr<AddedObserver> observer = new AddedObserver([&](Message* message) {
    ++calls;
    nsMsgKey actual;
    ASSERT_EQ(NS_OK, message->GetMessageKey(&actual));
    EXPECT_EQ(staged, actual);
    ASSERT_EQ(NS_OK, db.GetMessageUidOnServer(actual, uid));
    EXPECT_EQ(old, uid);
  });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, db.PublishMessage(staged, true));
  EXPECT_EQ(1u, calls);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BindStagedMessageToQueuedSource(staged, mFolderId, identity,
                                               Some(0u), returning));
}

TEST_F(DeliveryCoreReferences, TypedReturnHomeRejectsStaleTupleAndCollisions) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey old, target, staged;
  QueuedSourceIdentity identity;
  ASSERT_EQ(NS_OK, QueuedSourceForUndo(old, target, identity));
  RawHdr raw;
  raw.messageId = "typed-return-home"_ns;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  MessageBodyState returning;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(target, returning));
  // Preserve the existing typed binder's UID-collision error.
  // The still-live original owns this exact server tuple.
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            db.BindStagedMessageToQueuedSource(staged, mFolderId, identity,
                                               Some(0u), returning));
  ASSERT_EQ(NS_OK, db.RemoveMessage(old));
  auto bad = identity;
  ++bad.revision;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BindStagedMessageToQueuedSource(staged, mFolderId, bad, Some(0u),
                                               returning));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BindStagedMessageToQueuedSource(staged, mFolderId, identity,
                                               Some(1u), returning));
  auto changed = returning;
  changed.storeToken = Some(nsCString("0"_ns));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BindStagedMessageToQueuedSource(staged, mFolderId, identity,
                                               Some(0u), changed));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 8));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BindStagedMessageToQueuedSource(staged, mFolderId, identity,
                                               Some(0u), returning));
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(staged, names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
}

TEST_F(DeliveryCoreReferences,
       TypedReturnHomeRekeysWholeSourceBeforePublication) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey old, staged;
  nsTArray<PendingDestination> targets;
  QueuedSourceIdentity identity;
  ASSERT_EQ(NS_OK, QueuedSourceForStagedReturn(old, targets, identity));
  OfflineOperationData expected;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, old, expected));
  nsTArray<OfflineOperationData> childPayloads;
  for (const auto& target : targets) {
    auto& child = *childPayloads.AppendElement();
    ASSERT_EQ(NS_OK,
              db.GetOfflineOperation(target.folderId, target.key, child));
  }
  ASSERT_EQ(NS_OK, db.RemoveMessage(old));
  RawHdr raw;
  raw.messageId = "real-staged-return"_ns;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  MessageBodyState returning;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(targets[2].key, returning));
  uint32_t calls = 0;
  RefPtr<AddedObserver> observer = new AddedObserver([&](Message* message) {
    ++calls;
    nsMsgKey key;
    ASSERT_EQ(NS_OK, message->GetMessageKey(&key));
    EXPECT_EQ(staged, key);
    OfflineOperationData actual;
    ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, staged, actual));
    CheckUndoOfflinePayload(expected, actual);
    for (uint32_t i = 0; i < targets.Length(); ++i) {
      const auto& target = targets[i];
      OfflineOperationData child;
      ASSERT_EQ(NS_OK,
                db.GetOfflineOperation(target.folderId, target.key, child));
      childPayloads[i].sourceKey = staged;
      CheckUndoOfflinePayload(childPayloads[i], child);
      EXPECT_EQ(staged, child.sourceKey);
      EXPECT_EQ(old, child.sourceUid);
      EXPECT_EQ("imap://actual/source"_ns, child.sourceFolderURI);
    }
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.BindStagedMessageToQueuedSource(staged, mFolderId, identity,
                                                 Nothing(), returning));
  });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, db.BindStagedMessageToQueuedSource(
                       staged, mFolderId, identity, Nothing(), returning));
  EXPECT_EQ(0u, calls);
  QueuedSourceIdentity rekeyed;
  ASSERT_EQ(NS_OK, db.GetQueuedSourceIdentity(mFolderId, staged, rekeyed));
  EXPECT_EQ(identity.operationId, rekeyed.operationId);
  EXPECT_EQ(identity.revision, rekeyed.revision);
  ASSERT_TRUE(rekeyed.source);
  ASSERT_TRUE(identity.source);
  ASSERT_TRUE(rekeyed.source);
  EXPECT_EQ(identity.source->folderId, rekeyed.source->folderId);
  EXPECT_EQ(identity.source->key, rekeyed.source->key);
  EXPECT_EQ(identity.source->epoch, rekeyed.source->epoch);
  EXPECT_EQ(identity.source->uid, rekeyed.source->uid);
  EXPECT_EQ(old, rekeyed.source->key);
  OfflineOperationData absent;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetOfflineOperation(mFolderId, old, absent));
  // The actual caller cancels only the selected MOVE, on this same operation.
  // Its unrelated ordered COPY tail remains exclusively owned by this id.
  expected.operation &= ~nsIMsgOfflineImapOperation::kMsgMoved;
  expected.pendingDestination.reset();
  expected.destinationFolderURI.Truncate();
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, staged, expected));
  ASSERT_EQ(NS_OK, db.PublishMessage(staged, true));
  EXPECT_EQ(1u, calls);
  cleanup.release();
  db.RemoveMessageListener(observer);
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->MessageDB();
  ASSERT_EQ(NS_OK,
            reopened.GetQueuedSourceIdentity(mFolderId, staged, rekeyed));
  EXPECT_EQ(identity.operationId, rekeyed.operationId);
  EXPECT_EQ(identity.revision + 1, rekeyed.revision);
  ASSERT_TRUE(identity.source);
  ASSERT_TRUE(rekeyed.source);
  EXPECT_EQ(identity.source->folderId, rekeyed.source->folderId);
  EXPECT_EQ(identity.source->key, rekeyed.source->key);
  EXPECT_EQ(identity.source->epoch, rekeyed.source->epoch);
  EXPECT_EQ(identity.source->uid, rekeyed.source->uid);
  OfflineOperationData actual;
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperation(mFolderId, staged, actual));
  CheckUndoOfflinePayload(expected, actual);
}

TEST_F(DeliveryCoreReferences,
       TypedReturnHomeRekeyRollsBackUidSourceAndChildren) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey old, staged;
  nsTArray<PendingDestination> targets;
  QueuedSourceIdentity identity;
  ASSERT_EQ(NS_OK, QueuedSourceForStagedReturn(old, targets, identity));
  OfflineOperationData expected;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, old, expected));
  nsTArray<OfflineOperationData> childPayloads;
  for (const auto& target : targets) {
    auto& child = *childPayloads.AppendElement();
    ASSERT_EQ(NS_OK,
              db.GetOfflineOperation(target.folderId, target.key, child));
  }
  ASSERT_EQ(NS_OK, db.RemoveMessage(old));
  RawHdr raw;
  raw.messageId = "failed-staged-return"_ns;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  MessageBodyState returning;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(targets[2].key, returning));
  for (const auto& condition :
       {"NEW.messageKey != OLD.messageKey"_ns, "OLD.messageKey = "_ns}) {
    nsAutoCString sql(
        "CREATE TEMP TRIGGER reject_staged_rekey BEFORE UPDATE "
        "ON offline_operations WHEN ");
    sql.Append(condition);
    if (condition.EqualsLiteral("OLD.messageKey = ")) {
      // This is the final COPY child, after another child has been updated.
      sql.AppendInt(targets[1].key);
    }
    sql.AppendLiteral(" BEGIN SELECT RAISE(ABORT,'staged rekey'); END");
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
              db.BindStagedMessageToQueuedSource(staged, mFolderId, identity,
                                                 Nothing(), returning));
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER reject_staged_rekey"_ns));
    QueuedSourceIdentity actual;
    ASSERT_EQ(NS_OK, db.GetQueuedSourceIdentity(mFolderId, old, actual));
    EXPECT_EQ(identity.operationId, actual.operationId);
    EXPECT_EQ(identity.revision, actual.revision);
    ASSERT_TRUE(identity.source);
    ASSERT_TRUE(actual.source);
    EXPECT_EQ(identity.source->folderId, actual.source->folderId);
    EXPECT_EQ(identity.source->key, actual.source->key);
    EXPECT_EQ(identity.source->epoch, actual.source->epoch);
    EXPECT_EQ(identity.source->uid, actual.source->uid);
    OfflineOperationData payload;
    ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, old, payload));
    CheckUndoOfflinePayload(expected, payload);
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.GetOfflineOperation(mFolderId, staged, payload));
    for (uint32_t i = 0; i < targets.Length(); ++i) {
      const auto& target = targets[i];
      ASSERT_EQ(NS_OK,
                db.GetOfflineOperation(target.folderId, target.key, payload));
      CheckUndoOfflinePayload(childPayloads[i], payload);
      EXPECT_EQ(old, payload.sourceKey);
    }
    nsTArray<nsCString> names;
    ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(staged, names));
    EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  }
}

TEST_F(DeliveryCoreReferences,
       TypedReturnHomeRekeyRejectsChangedOrActiveCounterpart) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey old, staged;
  nsTArray<PendingDestination> targets;
  QueuedSourceIdentity identity;
  ASSERT_EQ(NS_OK, QueuedSourceForStagedReturn(old, targets, identity));
  ASSERT_EQ(NS_OK, db.RemoveMessage(old));
  RawHdr raw;
  raw.messageId = "guarded-staged-return"_ns;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  MessageBodyState returning;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(targets[2].key, returning));
  const auto& sibling = targets[1];
  OfflineOperationData child;
  ASSERT_EQ(NS_OK,
            db.GetOfflineOperation(sibling.folderId, sibling.key, child));
  child.sourceKey = targets[0].key;
  ASSERT_EQ(NS_OK,
            db.StoreOfflineOperation(sibling.folderId, sibling.key, child));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BindStagedMessageToQueuedSource(staged, mFolderId, identity,
                                               Nothing(), returning));
  child.sourceKey = old;
  child.playingBack = true;
  ASSERT_EQ(NS_OK,
            db.StoreOfflineOperation(sibling.folderId, sibling.key, child));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BindStagedMessageToQueuedSource(staged, mFolderId, identity,
                                               Nothing(), returning));
  QueuedSourceIdentity actual;
  ASSERT_EQ(NS_OK, db.GetQueuedSourceIdentity(mFolderId, old, actual));
  EXPECT_EQ(identity.operationId, actual.operationId);
  EXPECT_EQ(identity.revision, actual.revision);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(staged, names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
}

TEST_F(DeliveryCoreReferences,
       SelectedMoveUndoRedoOwnsFullIntentBeforeCallbacks) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey old;
  nsTArray<PendingDestination> targets;
  QueuedSourceIdentity identity;
  ASSERT_EQ(NS_OK, QueuedSourceForStagedReturn(old, targets, identity));
  const auto selected = targets[2];
  OfflineOperationData fullPayload, canceled;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, old, fullPayload));
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, old, canceled));
  canceled.operation &= ~nsIMsgOfflineImapOperation::kMsgMoved;
  canceled.pendingDestination.reset();
  canceled.destinationFolderURI.Truncate();
  OfflineOperationUndo full, redo;
  ASSERT_EQ(NS_OK, db.CaptureOfflineOperationForUndo(
                       mFolderId, old, identity.databaseSourceId, full));
  RemovedMessage removed;
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(old, removed));
  nsMsgKey fresh = nsMsgKey_None;
  Message* live = nullptr;
  uint32_t added = 0;
  RefPtr<AddedObserver> observer = new AddedObserver([&](Message* message) {
    ++added;
    EXPECT_EQ(live, message);
    EXPECT_FALSE(removed.Body());
    EXPECT_FALSE(full.Operation());
    ASSERT_TRUE(redo.Operation());
    CheckUndoOfflinePayload(fullPayload, *redo.Operation());
    OfflineOperationData actual;
    ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, fresh, actual));
    CheckUndoOfflinePayload(canceled, actual);
    uint32_t uid;
    ASSERT_EQ(NS_OK, db.GetMessageUidOnServer(fresh, uid));
    EXPECT_EQ(old, uid);
    for (const auto& target : targets) {
      ASSERT_EQ(NS_OK,
                db.GetOfflineOperation(target.folderId, target.key, actual));
      EXPECT_EQ(fresh, actual.sourceKey);
      EXPECT_EQ(target.key != selected.key,
                !!(actual.operation & nsIMsgOfflineImapOperation::kMoveResult));
      if (target.key == selected.key) {
        EXPECT_EQ(uint32_t(nsIMsgOfflineImapOperation::kFlagsChanged),
                  actual.operation);
        EXPECT_EQ(UINT32_MAX, actual.newFlags);
        EXPECT_EQ("unchanged child words"_ns, actual.keywordsToAdd);
      }
    }
  });
  db.AddMessageListener(observer);
  auto detach = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  FinishedMessageBody finished{"selected-move-finished"_ns, 12, 12, 1, true};
  ASSERT_EQ(NS_OK,
            db.RestoreMessageForUndo(mFolderId, removed, finished, &fresh,
                                     &live, &full, &selected, &redo));
  RefPtr<Message> hold = dont_AddRef(live);
  EXPECT_EQ(1u, added);
  EXPECT_NE(old, fresh);
  QueuedSourceIdentity current;
  ASSERT_EQ(NS_OK, db.GetQueuedSourceIdentity(mFolderId, fresh, current));
  EXPECT_EQ(identity.operationId, current.operationId);
  EXPECT_EQ(identity.revision + 1, current.revision);
  ASSERT_TRUE(current.source);
  EXPECT_EQ(old, current.source->key);
  EXPECT_EQ(old, current.source->uid);
  detach.release();
  db.RemoveMessageListener(observer);
  RemovedMessage removedAgain;
  OfflineOperationUndo next;
  uint32_t removedCalls = 0;
  RefPtr<UndoRemovalObserver> removal = new UndoRemovalObserver([&](Message*) {
    ++removedCalls;
    EXPECT_TRUE(removedAgain.Body());
    EXPECT_FALSE(redo.Operation());
    ASSERT_TRUE(next.Operation());
    CheckUndoOfflinePayload(fullPayload, *next.Operation());
    OfflineOperationData actual;
    ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, fresh, actual));
    CheckUndoOfflinePayload(fullPayload, actual);
    for (const auto& target : targets) {
      ASSERT_EQ(NS_OK,
                db.GetOfflineOperation(target.folderId, target.key, actual));
      EXPECT_TRUE(actual.operation & nsIMsgOfflineImapOperation::kMoveResult);
      EXPECT_EQ(fresh, actual.sourceKey);
    }
  });
  db.AddMessageListener(removal);
  auto detachRemoval =
      MakeScopeExit([&] { db.RemoveMessageListener(removal); });
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(
                       fresh, mFolderId, identity.databaseSourceId,
                       MessageRemovalAccounting::OfflineMessageSize,
                       removedAgain, &redo, &next));
  EXPECT_EQ(1u, removedCalls);
  EXPECT_FALSE(redo.Operation());
  ASSERT_EQ(NS_OK, db.GetQueuedSourceIdentity(mFolderId, fresh, current));
  EXPECT_EQ(identity.operationId, current.operationId);
  EXPECT_EQ(identity.revision + 2, current.revision);
  detachRemoval.release();
  db.RemoveMessageListener(removal);
  // A second Undo uses the newly owned full snapshot, not a borrowed consumed
  // Operation() or a reconstructed partial MOVE.
  nsMsgKey second = nsMsgKey_None;
  Message* secondLive = nullptr;
  OfflineOperationUndo secondRedo;
  finished.storeToken = "second-selected-move-finished"_ns;
  ASSERT_EQ(NS_OK, db.RestoreMessageForUndo(mFolderId, removedAgain, finished,
                                            &second, &secondLive, &next,
                                            &selected, &secondRedo));
  RefPtr<Message> secondHold = dont_AddRef(secondLive);
  EXPECT_NE(fresh, second);
  EXPECT_FALSE(next.Operation());
  ASSERT_TRUE(secondRedo.Operation());
  CheckUndoOfflinePayload(fullPayload, *secondRedo.Operation());
  OfflineOperationData actual;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, second, actual));
  CheckUndoOfflinePayload(canceled, actual);
}

TEST_F(DeliveryCoreReferences, SelectedMoveOnlyUndoKeepsNativeRedoCustody) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey old, target;
  QueuedSourceIdentity identity;
  ASSERT_EQ(NS_OK, QueuedSourceForUndo(old, target, identity));
  OfflineOperationData payload;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, old, payload));
  payload.operation = nsIMsgOfflineImapOperation::kMsgMoved;
  payload.copyDestinations.Clear();
  payload.copyDestinationBindings.Clear();
  const PendingDestination selected{mFolderId, target, 7};
  payload.pendingDestination = Some(selected);
  payload.destinationFolderURI = "actual-selected-move"_ns;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, old, payload));
  ASSERT_EQ(NS_OK, db.GetQueuedSourceIdentity(mFolderId, old, identity));
  OfflineOperationUndo full, redo;
  ASSERT_EQ(NS_OK, db.CaptureOfflineOperationForUndo(
                       mFolderId, old, identity.databaseSourceId, full));
  RemovedMessage removed;
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(old, removed));
  FinishedMessageBody finished{"move-only-finished"_ns, 15, 15, 2, true};
  nsMsgKey fresh;
  ASSERT_EQ(NS_OK,
            db.RestoreMessageForUndo(mFolderId, removed, finished, &fresh,
                                     nullptr, &full, &selected, &redo));
  OfflineOperationData actual;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, fresh, actual));
  EXPECT_EQ(0u, actual.operation);
  EXPECT_FALSE(actual.pendingDestination);
  EXPECT_TRUE(actual.destinationFolderURI.IsEmpty());
  EXPECT_FALSE(full.Operation());
  ASSERT_TRUE(redo.Operation());
  CheckUndoOfflinePayload(payload, *redo.Operation());
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(target, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, target, actual));
  EXPECT_EQ(0u, actual.operation);
  EXPECT_EQ(fresh, actual.sourceKey);
  // Ordinary observation skips canceled counterpart markers even after reopen.
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->MessageDB();
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperation(mFolderId, target, actual));
  EXPECT_EQ(0u, actual.operation);
  ASSERT_EQ(NS_OK, reopened.MessageExists(target, exists));
  EXPECT_TRUE(exists);
  // Actual replay removes both zero-bit records before a later user Redo.
  ASSERT_EQ(NS_OK, reopened.RemoveOfflineOperation(mFolderId, target));
  ASSERT_EQ(NS_OK, reopened.RemoveOfflineOperation(mFolderId, fresh));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            reopened.GetOfflineOperation(mFolderId, fresh, actual));
  RemovedMessage again;
  OfflineOperationUndo next;
  ASSERT_EQ(NS_OK, reopened.RemoveMessageForUndo(
                       fresh, mFolderId, identity.databaseSourceId,
                       MessageRemovalAccounting::OfflineMessageSize, again,
                       &redo, &next));
  ASSERT_TRUE(next.Operation());
  CheckUndoOfflinePayload(payload, *next.Operation());
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperation(mFolderId, target, actual));
  EXPECT_TRUE(actual.operation & nsIMsgOfflineImapOperation::kMoveResult);
  EXPECT_EQ(fresh, actual.sourceKey);
}

TEST_F(DeliveryCoreReferences,
       SelectedMoveUndoFailureKeepsFullCaptureAndOwningOutputs) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey old;
  nsTArray<PendingDestination> targets;
  QueuedSourceIdentity identity;
  ASSERT_EQ(NS_OK, QueuedSourceForStagedReturn(old, targets, identity));
  OfflineOperationData expected;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, old, expected));
  OfflineOperationUndo full, redo;
  ASSERT_EQ(NS_OK, db.CaptureOfflineOperationForUndo(
                       mFolderId, old, identity.databaseSourceId, full));
  RemovedMessage removed;
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(old, removed));
  FinishedMessageBody finished{"retry-selected-finished"_ns, 12, 12, 1, true};
  nsMsgKey untouched = 123;
  Message* live = nullptr;
  auto wrong = targets[0];
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.RestoreMessageForUndo(mFolderId, removed, finished, &untouched,
                                     &live, &full, &wrong, &redo));
  nsAutoCString sql(
      "CREATE TEMP TRIGGER fail_selected_cancel BEFORE UPDATE "
      "OF operation ON offline_operations WHEN OLD.id=");
  sql.AppendInt(identity.operationId);
  sql.AppendLiteral(" BEGIN SELECT RAISE(ABORT,'selected cancel'); END");
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.RestoreMessageForUndo(mFolderId, removed, finished, &untouched,
                                     &live, &full, &targets[2], &redo));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER fail_selected_cancel"_ns));
  EXPECT_EQ(123u, untouched);
  EXPECT_EQ(nullptr, live);
  EXPECT_TRUE(removed.Body());
  ASSERT_TRUE(full.Operation());
  EXPECT_FALSE(redo.Operation());
  CheckUndoOfflinePayload(expected, *full.Operation());
  OfflineOperationData actual;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, old, actual));
  CheckUndoOfflinePayload(expected, actual);
  ASSERT_EQ(NS_OK, db.GetQueuedSourceIdentity(mFolderId, old, identity));
  for (const auto& target : targets) {
    ASSERT_EQ(NS_OK,
              db.GetOfflineOperation(target.folderId, target.key, actual));
    EXPECT_EQ(old, actual.sourceKey);
  }
}

TEST_F(DeliveryCoreReferences,
       SelectedMoveRedoRemovalFailureKeepsCanceledSourceAndRetry) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey old;
  nsTArray<PendingDestination> targets;
  QueuedSourceIdentity identity;
  ASSERT_EQ(NS_OK, QueuedSourceForStagedReturn(old, targets, identity));
  OfflineOperationUndo full, redo;
  ASSERT_EQ(NS_OK, db.CaptureOfflineOperationForUndo(
                       mFolderId, old, identity.databaseSourceId, full));
  RemovedMessage removed;
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(old, removed));
  FinishedMessageBody finished{"redo-failure-finished"_ns, 12, 12, 1, true};
  nsMsgKey fresh;
  ASSERT_EQ(NS_OK,
            db.RestoreMessageForUndo(mFolderId, removed, finished, &fresh,
                                     nullptr, &full, &targets[2], &redo));
  OfflineOperationData canceled, canceledChild;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, fresh, canceled));
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(targets[2].folderId, targets[2].key,
                                          canceledChild));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER fail_selected_redo BEFORE DELETE "
          "ON messages BEGIN SELECT RAISE(ABORT,'selected redo'); END"_ns));
  RemovedMessage again;
  OfflineOperationUndo next;
  EXPECT_EQ(
      NS_ERROR_STORAGE_CONSTRAINT,
      db.RemoveMessageForUndo(fresh, mFolderId, identity.databaseSourceId,
                              MessageRemovalAccounting::OfflineMessageSize,
                              again, &redo, &next));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER fail_selected_redo"_ns));
  EXPECT_FALSE(again.Body());
  EXPECT_FALSE(next.Operation());
  ASSERT_TRUE(redo.Operation());
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(fresh, exists));
  EXPECT_TRUE(exists);
  OfflineOperationData actual;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, fresh, actual));
  CheckUndoOfflinePayload(canceled, actual);
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(targets[2].folderId, targets[2].key,
                                          actual));
  CheckUndoOfflinePayload(canceledChild, actual);
  EXPECT_FALSE(actual.operation & nsIMsgOfflineImapOperation::kMoveResult);
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(
                       fresh, mFolderId, identity.databaseSourceId,
                       MessageRemovalAccounting::OfflineMessageSize, again,
                       &redo, &next));
  EXPECT_FALSE(redo.Operation());
  ASSERT_TRUE(next.Operation());
}

TEST_F(DeliveryCoreReferences,
       SelectedMoveRedoRefusesChangedCounterpartWithoutSourceLoss) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey old;
  nsTArray<PendingDestination> targets;
  QueuedSourceIdentity identity;
  ASSERT_EQ(NS_OK, QueuedSourceForStagedReturn(old, targets, identity));
  OfflineOperationUndo full, redo;
  ASSERT_EQ(NS_OK, db.CaptureOfflineOperationForUndo(
                       mFolderId, old, identity.databaseSourceId, full));
  RemovedMessage removed;
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(old, removed));
  FinishedMessageBody finished{"stale-redo-finished"_ns, 12, 12, 1, true};
  nsMsgKey fresh;
  ASSERT_EQ(NS_OK,
            db.RestoreMessageForUndo(mFolderId, removed, finished, &fresh,
                                     nullptr, &full, &targets[2], &redo));
  OfflineOperationData expected, child;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, fresh, expected));
  ASSERT_EQ(NS_OK,
            db.GetOfflineOperation(targets[1].folderId, targets[1].key, child));
  child.keywordsToAdd = "later actual intent"_ns;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(targets[1].folderId, targets[1].key,
                                            child));
  RemovedMessage again;
  OfflineOperationUndo next;
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      db.RemoveMessageForUndo(fresh, mFolderId, identity.databaseSourceId,
                              MessageRemovalAccounting::OfflineMessageSize,
                              again, &redo, &next));
  EXPECT_FALSE(again.Body());
  EXPECT_FALSE(next.Operation());
  ASSERT_TRUE(redo.Operation());
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(fresh, exists));
  EXPECT_TRUE(exists);
  OfflineOperationData actual;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, fresh, actual));
  CheckUndoOfflinePayload(expected, actual);
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(targets[1].folderId, targets[1].key,
                                          actual));
  CheckUndoOfflinePayload(child, actual);
}

TEST_F(DeliveryCoreReferences,
       SelectedMoveCounterpartCancellationFailureRollsBackBeforePublication) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey old;
  nsTArray<PendingDestination> targets;
  QueuedSourceIdentity identity;
  ASSERT_EQ(NS_OK, QueuedSourceForStagedReturn(old, targets, identity));
  OfflineOperationData expected;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, old, expected));
  nsTArray<OfflineOperationData> children;
  for (const auto& target : targets) {
    auto& child = *children.AppendElement();
    ASSERT_EQ(NS_OK,
              db.GetOfflineOperation(target.folderId, target.key, child));
  }
  OfflineOperationUndo full, redo;
  ASSERT_EQ(NS_OK, db.CaptureOfflineOperationForUndo(
                       mFolderId, old, identity.databaseSourceId, full));
  RemovedMessage removed;
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(old, removed));
  nsAutoCString sql(
      "CREATE TEMP TRIGGER fail_selected_counterpart BEFORE UPDATE "
      "OF operation ON offline_operations WHEN OLD.messageKey=");
  sql.AppendInt(targets[2].key);
  sql.AppendLiteral(" AND (OLD.operation & ");
  sql.AppendInt(uint32_t(nsIMsgOfflineImapOperation::kMoveResult));
  sql.AppendLiteral(")!=0 AND (NEW.operation & ");
  sql.AppendInt(uint32_t(nsIMsgOfflineImapOperation::kMoveResult));
  sql.AppendLiteral(")=0 BEGIN SELECT RAISE(ABORT,'canceled child'); END");
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
  FinishedMessageBody finished{"child-failure-finished"_ns, 12, 12, 1, true};
  nsMsgKey result = 123;
  Message* live = nullptr;
  uint32_t publications = 0;
  RefPtr<AddedObserver> observer =
      new AddedObserver([&](Message*) { ++publications; });
  db.AddMessageListener(observer);
  auto detach = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.RestoreMessageForUndo(mFolderId, removed, finished, &result,
                                     &live, &full, &targets[2], &redo));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER fail_selected_counterpart"_ns));
  EXPECT_EQ(123u, result);
  EXPECT_EQ(nullptr, live);
  EXPECT_EQ(0u, publications);
  EXPECT_TRUE(removed.Body());
  ASSERT_TRUE(full.Operation());
  EXPECT_FALSE(redo.Operation());
  CheckUndoOfflinePayload(expected, *full.Operation());
  OfflineOperationData actual;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, old, actual));
  CheckUndoOfflinePayload(expected, actual);
  for (uint32_t i = 0; i < targets.Length(); ++i) {
    const auto& target = targets[i];
    ASSERT_EQ(NS_OK,
              db.GetOfflineOperation(target.folderId, target.key, actual));
    CheckUndoOfflinePayload(children[i], actual);
  }
}

TEST_F(DeliveryCoreReferences,
       SelectedMoveRedoRejectsCleanedCounterpartBodyChange) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey old, target;
  QueuedSourceIdentity identity;
  ASSERT_EQ(NS_OK, QueuedSourceForUndo(old, target, identity));
  OfflineOperationData payload;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, old, payload));
  payload.operation = nsIMsgOfflineImapOperation::kMsgMoved;
  payload.copyDestinations.Clear();
  payload.copyDestinationBindings.Clear();
  const PendingDestination selected{mFolderId, target, 7};
  payload.pendingDestination = Some(selected);
  payload.destinationFolderURI = "actual-selected-move"_ns;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, old, payload));
  OfflineOperationUndo full, redo;
  ASSERT_EQ(NS_OK, db.CaptureOfflineOperationForUndo(
                       mFolderId, old, identity.databaseSourceId, full));
  RemovedMessage removed;
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(old, removed));
  FinishedMessageBody finished{"changed-child-finished"_ns, 15, 15, 2, true};
  nsMsgKey fresh;
  ASSERT_EQ(NS_OK,
            db.RestoreMessageForUndo(mFolderId, removed, finished, &fresh,
                                     nullptr, &full, &selected, &redo));
  OfflineOperationData canceled;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, fresh, canceled));
  ASSERT_EQ(NS_OK, db.RemoveOfflineOperation(mFolderId, target));
  ASSERT_EQ(NS_OK,
            db.SetMessageStoreToken(target, "later-physical-location"_ns));
  RemovedMessage again;
  OfflineOperationUndo next;
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      db.RemoveMessageForUndo(fresh, mFolderId, identity.databaseSourceId,
                              MessageRemovalAccounting::OfflineMessageSize,
                              again, &redo, &next));
  EXPECT_FALSE(again.Body());
  EXPECT_FALSE(next.Operation());
  ASSERT_TRUE(redo.Operation());
  CheckUndoOfflinePayload(payload, *redo.Operation());
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(fresh, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, db.MessageExists(target, exists));
  EXPECT_TRUE(exists);
  OfflineOperationData actual;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, fresh, actual));
  CheckUndoOfflinePayload(canceled, actual);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetOfflineOperation(mFolderId, target, actual));
  MessageBodyState body;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(target, body));
  ASSERT_TRUE(body.storeToken);
  EXPECT_EQ("later-physical-location"_ns, *body.storeToken);
}

TEST_F(DeliveryCoreReferences, UndoOfflineRestorePublishesCompleteAssociation) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
  nsCString sourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(sourceId));
  nsMsgKey old, sourceKey, sibling;
  ASSERT_EQ(NS_OK,
            Add("offline-undo@invalid"_ns, {"raw"_ns, ""_ns, "raw"_ns}, old));
  ASSERT_EQ(NS_OK, Add("offline-source@invalid"_ns, {}, sourceKey));
  ASSERT_EQ(NS_OK, Add("offline-sibling@invalid"_ns, {}, sibling));
  ASSERT_EQ(NS_OK, db.SetMessageUidOnServer(sourceKey, 42));
  OfflineOperationData original;
  original.operation = nsIMsgOfflineImapOperation::kMoveResult |
                       nsIMsgOfflineImapOperation::kFlagsChanged;
  original.flagOperation = 0x80000000;
  original.newFlags = UINT32_MAX;
  original.sourceKey = sourceKey;
  original.sourceUid = 42;
  original.messageSize = UINT32_MAX;
  original.sourceFolderURI = "imap://source/Inbox"_ns;
  original.destinationFolderURI = "imap://destination/Copy"_ns;
  original.keywordsToAdd = "first second"_ns;
  original.keywordsToRemove = "old"_ns;
  original.copyDestinations = {"same"_ns, "same"_ns, "last"_ns};
  original.copyDestinationBindings = {Nothing(), Nothing(), Nothing()};
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, old, original));
  OfflineOperationData source;
  source.operation = nsIMsgOfflineImapOperation::kMsgCopy;
  source.copyDestinations = {"duplicate"_ns, "duplicate"_ns, "last"_ns};
  source.copyDestinationBindings = {
      Nothing(), Some(PendingDestination{mFolderId, old, 7}),
      Some(PendingDestination{mFolderId, sibling, 7})};
  source.keywordsToAdd = "source unchanged"_ns;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, sourceKey, source));
  OfflineUndoCounterpart counterpart{
      sourceId,          mFolderId,
      sourceKey,         nsIMsgOfflineImapOperation::kMsgCopy,
      Some(uint32_t(1)), {mFolderId, old, 7}};
  OfflineOperationUndo operation;
  ASSERT_EQ(NS_OK, db.CaptureOfflineOperationForUndo(mFolderId, old, sourceId,
                                                     operation, &counterpart));
  ASSERT_TRUE(operation.Operation());
  CheckUndoOfflinePayload(original, *operation.Operation());
  ASSERT_EQ(NS_OK, db.RemoveOfflineOperation(mFolderId, old));
  RemovedMessage removed;
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(old, removed));
  FinishedMessageBody finished{"new-finished-body"_ns, 23, 23, 2, true};
  nsMsgKey result = 123;
  Message* live = nullptr;
  uint32_t publications = 0;
  RefPtr<AddedObserver> observer = new AddedObserver([&](Message* message) {
    ++publications;
    EXPECT_FALSE(removed.Body());
    EXPECT_FALSE(operation.Operation());
    EXPECT_EQ(live, message);
    nsMsgKey actual;
    ASSERT_EQ(NS_OK, message->GetMessageKey(&actual));
    EXPECT_EQ(result, actual);
    EXPECT_NE(old, actual);
    OfflineOperationData restored, rebound;
    ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, actual, restored));
    CheckUndoOfflinePayload(original, restored);
    ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, sourceKey, rebound));
    source.copyDestinationBindings[1]->key = actual;
    CheckUndoOfflinePayload(source, rebound);
    bool active = true;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
    auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
    nsCString count;
    ASSERT_EQ(
        NS_OK,
        PublicationCell(
            reader, actual,
            "SELECT COUNT(*) FROM messages m JOIN offline_operations o "
            "ON o.messageKey=m.id AND o.folderId=m.folderId WHERE m.id=:id"_ns,
            count));
    EXPECT_EQ("1"_ns, count);
    ASSERT_EQ(
        NS_OK,
        PublicationCell(
            reader, actual,
            "SELECT COUNT(*) FROM message_properties WHERE id=:id AND name='uidOnServer'"_ns,
            count));
    EXPECT_EQ("0"_ns, count);
  });
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, db.RestoreMessageForUndo(mFolderId, removed, finished,
                                            &result, &live, &operation));
  RefPtr<Message> restored = dont_AddRef(live);
  EXPECT_EQ(1u, publications);
  db.RemoveMessageListener(observer);
  unwatch.release();
  Stop();
  ASSERT_EQ(NS_OK, Start());
  OfflineOperationData got;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetOfflineOperation(mFolderId, result, got));
  CheckUndoOfflinePayload(original, got);
  Maybe<ServerMessageLocation> queued;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetOfflineOperationSource(
                       mFolderId, result, queued));
  EXPECT_FALSE(queued);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetOfflineOperation(mFolderId, sourceKey, got));
  source.copyDestinationBindings[1]->key = result;
  CheckUndoOfflinePayload(source, got);
}

TEST_F(DeliveryCoreReferences, UndoOfflineRestoreKeepsSavedSourcePresence) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
  for (bool bound : {false, true}) {
    auto& db = mCore->MessageDB();
    nsMsgKey old, control;
    ASSERT_EQ(NS_OK, Add("queued-undo@invalid"_ns, {}, old));
    ASSERT_EQ(NS_OK, Add("unchanged-operation@invalid"_ns, {}, control));
    if (bound) ASSERT_EQ(NS_OK, db.SetMessageUidOnServer(old, 42));
    OfflineOperationData original;
    original.operation = bound ? nsIMsgOfflineImapOperation::kFlagsChanged
                               : nsIMsgOfflineImapOperation::kAppendDraft;
    if (!bound)
      original.pendingDestination = Some(PendingDestination{mFolderId, old, 7});
    original.newFlags = UINT32_MAX;
    ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, old, original));
    OfflineOperationData controlOp;
    controlOp.operation = nsIMsgOfflineImapOperation::kFlagsChanged;
    controlOp.newFlags = UINT32_MAX;
    ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, control, controlOp));
    // A later header binding must not turn captured Nothing into Some.
    if (!bound) ASSERT_EQ(NS_OK, db.SetMessageUidOnServer(old, 99));
    nsCString sourceId;
    ASSERT_EQ(NS_OK, mCore->GetSourceId(sourceId));
    OfflineOperationUndo operation;
    ASSERT_EQ(NS_OK, db.CaptureOfflineOperationForUndo(mFolderId, old, sourceId,
                                                       operation));
    // An exact retained capture may now rekey atomically. Keep the original
    // refusal/output-custody checks against a real later queue revision.
    OfflineOperationData intervening;
    ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, old, intervening));
    intervening.keywordsToAdd = "queued after capture"_ns;
    // This later queue revision drops its old APPEND association. The header
    // is already UID-bound, so it must not remain a pending APPEND target.
    intervening.pendingDestination.reset();
    ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, old, intervening));
    RemovedMessage removed;
    ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(old, removed));
    FinishedMessageBody finished{"finished-queued"_ns, 12, 12, 1, true};
    nsMsgKey result = 123;
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.RestoreMessageForUndo(mFolderId, removed, finished, &result,
                                       nullptr, &operation));
    EXPECT_EQ(123u, result);
    ASSERT_TRUE(removed.Body());
    ASSERT_TRUE(operation.Operation());
    OfflineOperationData retained;
    ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, old, retained));
    CheckUndoOfflinePayload(intervening, retained);
    ASSERT_EQ(NS_OK, db.RemoveOfflineOperation(mFolderId, old));
    ASSERT_EQ(NS_OK, db.RestoreMessageForUndo(mFolderId, removed, finished,
                                              &result, nullptr, &operation));
    EXPECT_NE(old, result);
    if (original.pendingDestination) original.pendingDestination->key = result;
    Stop();
    ASSERT_EQ(NS_OK, Start());
    auto& current = mCore->MessageDB();
    for (bool update : {false, true}) {
      if (update) {
        original.keywordsToAdd = "later payload update"_ns;
        ASSERT_EQ(NS_OK,
                  current.StoreOfflineOperation(mFolderId, result, original));
      }
      OfflineOperationData payload;
      ASSERT_EQ(NS_OK, current.GetOfflineOperation(mFolderId, result, payload));
      CheckUndoOfflinePayload(original, payload);
      Maybe<ServerMessageLocation> queued;
      ASSERT_EQ(NS_OK,
                current.GetOfflineOperationSource(mFolderId, result, queued));
      EXPECT_EQ(bound, queued.isSome());
      if (bound) {
        EXPECT_EQ(mFolderId, queued->folderId);
        EXPECT_EQ(old, queued->key);
        EXPECT_EQ(7u, queued->epoch);
        EXPECT_EQ(42u, queued->uid);
      }
      nsCString stored;
      ASSERT_EQ(
          NS_OK,
          PublicationCell(
              mConnection, result,
              "SELECT COALESCE(sourcePhysicalKey,'absent') FROM offline_operations WHERE messageKey=:id"_ns,
              stored));
      nsAutoCString expected;
      if (bound)
        expected.AppendInt(old);
      else
        expected = "absent"_ns;
      EXPECT_EQ(expected, stored);
    }
    nsTArray<nsCString> names;
    ASSERT_EQ(NS_OK, current.GetMessagePropertyNames(result, names));
    EXPECT_FALSE(names.Contains("uidOnServer"_ns));
    OfflineOperationData unchanged;
    ASSERT_EQ(NS_OK,
              current.GetOfflineOperation(mFolderId, control, unchanged));
    EXPECT_TRUE(unchanged.keywordsToAdd.IsEmpty());
    EXPECT_EQ(UINT32_MAX, unchanged.newFlags);
    nsCString revision;
    ASSERT_EQ(
        NS_OK,
        PublicationCell(
            mConnection, control,
            "SELECT revision FROM offline_operations WHERE messageKey=:id"_ns,
            revision));
    EXPECT_EQ("1"_ns, revision);
  }
}

TEST_F(DeliveryCoreReferences, UndoOfflineAssociationFailuresRetainEverything) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
  nsCString sourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(sourceId));
  for (bool commitFailure : {false, true}) {
    nsMsgKey old, sourceKey;
    ASSERT_EQ(NS_OK, Add("retained-source@invalid"_ns, {}, sourceKey));
    ASSERT_EQ(NS_OK, Add("failed-association@invalid"_ns,
                         {"retained-source@invalid"_ns}, old));
    OfflineOperationData own;
    own.operation = nsIMsgOfflineImapOperation::kMoveResult;
    own.copyDestinations = {"retained-copy"_ns};
    own.copyDestinationBindings = {Nothing()};
    ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, old, own));
    OfflineOperationData source;
    source.operation = nsIMsgOfflineImapOperation::kMsgMoved;
    source.pendingDestination = Some(PendingDestination{mFolderId, old, 7});
    ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, sourceKey, source));
    OfflineUndoCounterpart counterpart{
        sourceId,  mFolderId,
        sourceKey, nsIMsgOfflineImapOperation::kMsgMoved,
        Nothing(), {mFolderId, old, 7}};
    OfflineOperationUndo operation;
    ASSERT_EQ(NS_OK, db.CaptureOfflineOperationForUndo(
                         mFolderId, old, sourceId, operation, &counterpart));
    ASSERT_EQ(NS_OK, db.RemoveOfflineOperation(mFolderId, old));
    RemovedMessage removed;
    ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(old, removed));
    if (commitFailure) {
      // Enable deferred checking after the ordinary fixture setup. The
      // restored row has a real surviving parent, rather than a zero sentinel.
      ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "PRAGMA foreign_keys=ON; CREATE TEMP TABLE "
                           "undo_parent(id INTEGER PRIMARY KEY); "
                           "CREATE TEMP TABLE undo_child(id INTEGER REFERENCES "
                           "undo_parent(id) "
                           "DEFERRABLE INITIALLY DEFERRED)"_ns));
    }
    RefPtr<FaultWitness> witness = new FaultWitness();
    ASSERT_EQ(NS_OK, mConnection->CreateFunction("undo_association_fault"_ns, 1,
                                                 witness));
    nsAutoCString sql("CREATE TEMP TRIGGER fail_undo_association ");
    sql.Append(commitFailure ? "AFTER" : "BEFORE");
    sql.AppendLiteral(
        " UPDATE ON main.offline_operations WHEN NEW.messageKey=");
    sql.AppendInt(sourceKey);
    sql.AppendLiteral(
        " BEGIN SELECT undo_association_fault(NEW.destinationKey); ");
    sql.Append(commitFailure
                   ? "INSERT INTO undo_child VALUES(NEW.destinationKey); END"
                   : "SELECT RAISE(ABORT,'association write'); END");
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    auto cleanup = MakeScopeExit([&] {
      EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "DROP TRIGGER IF EXISTS fail_undo_association"_ns));
      EXPECT_EQ(NS_OK,
                mConnection->RemoveFunction("undo_association_fault"_ns));
    });
    uint32_t publications = 0;
    RefPtr<AddedObserver> observer =
        new AddedObserver([&](Message*) { ++publications; });
    db.AddMessageListener(observer);
    auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
    FinishedMessageBody finished{"retained-finished"_ns, 12, 12, 1, true};
    nsMsgKey result = 123;
    Message* live = nullptr;
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
              db.RestoreMessageForUndo(mFolderId, removed, finished, &result,
                                       &live, &operation));
    EXPECT_EQ(1u, witness->mCalls);
    EXPECT_EQ(123u, result);
    EXPECT_EQ(nullptr, live);
    EXPECT_EQ(0u, publications);
    ASSERT_TRUE(removed.Body());
    EXPECT_EQ(old, removed.Body()->key);
    ASSERT_TRUE(operation.Operation());
    CheckUndoOfflinePayload(own, *operation.Operation());
    bool active = true;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    OfflineOperationData unchanged;
    ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, sourceKey, unchanged));
    CheckUndoOfflinePayload(source, unchanged);
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
    auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
    for (const auto& query :
         {"SELECT COUNT(*) FROM messages WHERE id=:id"_ns,
          "SELECT COUNT(*) FROM message_properties WHERE id=:id"_ns,
          "SELECT COUNT(*) FROM offline_operations WHERE messageKey=:id"_ns}) {
      nsCString count;
      ASSERT_EQ(NS_OK,
                PublicationCell(reader, witness->mLastKey, query, count));
      EXPECT_EQ("0"_ns, count);
    }
    nsCString revision;
    ASSERT_EQ(
        NS_OK,
        PublicationCell(
            reader, sourceKey,
            "SELECT revision FROM offline_operations WHERE messageKey=:id"_ns,
            revision));
    EXPECT_EQ("1"_ns, revision);
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER fail_undo_association"_ns));
    ASSERT_EQ(NS_OK, db.RestoreMessageForUndo(mFolderId, removed, finished,
                                              &result, &live, &operation));
    RefPtr<Message> restored = dont_AddRef(live);
    EXPECT_EQ(1u, publications);
    EXPECT_FALSE(removed.Body());
    EXPECT_FALSE(operation.Operation());
  }
}

TEST_F(DeliveryCoreReferences, UndoOfflineCaptureAndRestoreGuardOwnedIdentity) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
  nsCString sourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(sourceId));
  nsMsgKey old, other, sourceKey;
  ASSERT_EQ(NS_OK, Add("guarded-offline-undo@invalid"_ns, {}, old));
  ASSERT_EQ(NS_OK, Add("wrong-capture@invalid"_ns, {}, other));
  ASSERT_EQ(NS_OK, Add("guarded-counterpart@invalid"_ns, {}, sourceKey));
  OfflineOperationData own;
  own.operation = nsIMsgOfflineImapOperation::kMoveResult;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, old, own));
  OfflineOperationData source;
  source.operation = nsIMsgOfflineImapOperation::kMsgCopy;
  source.copyDestinations = {"first"_ns};
  source.copyDestinationBindings = {
      Some(PendingDestination{mFolderId, old, 7})};
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, sourceKey, source));
  OfflineUndoCounterpart counterpart{
      sourceId,          mFolderId,
      sourceKey,         nsIMsgOfflineImapOperation::kMsgCopy,
      Some(uint32_t(0)), {mFolderId, old, 7}};
  OfflineOperationUndo operation;
  ASSERT_EQ(NS_OK, db.CaptureOfflineOperationForUndo(mFolderId, old, sourceId,
                                                     operation, &counterpart));
  counterpart.copyOrdinal = Some(uint32_t(1));
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.CaptureOfflineOperationForUndo(mFolderId, old, sourceId,
                                              operation, &counterpart));
  ASSERT_TRUE(operation.Operation());
  counterpart.copyOrdinal.reset();
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.CaptureOfflineOperationForUndo(mFolderId, old, sourceId,
                                              operation, &counterpart));
  counterpart.copyOrdinal = Some(uint32_t(0));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.CaptureOfflineOperationForUndo(mFolderId, old, "foreign"_ns,
                                              operation));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.CaptureOfflineOperationForUndo(
                                      mFolderId, old, sourceId, operation));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  // A checked payload edit invalidates the captured native revision.
  source.keywordsToAdd = "changed after capture"_ns;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, sourceKey, source));
  ASSERT_EQ(NS_OK, db.RemoveOfflineOperation(mFolderId, old));
  RemovedMessage removed, wrong;
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(old, removed));
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(other, wrong));
  FinishedMessageBody finished{"owned-finished"_ns, 12, 12, 1, true};
  nsMsgKey result = 123;
  Message* live = nullptr;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.RestoreMessageForUndo(mFolderId, wrong, finished, &result, &live,
                                     &operation));
  EXPECT_EQ(123u, result);
  EXPECT_EQ(nullptr, live);
  ASSERT_TRUE(wrong.Body());
  ASSERT_TRUE(operation.Operation());
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.RestoreMessageForUndo(mFolderId, removed, finished, &result,
                                     &live, &operation));
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  RefPtr<Message> held = new Message(sourceKey);
  live = held.get();
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.RestoreMessageForUndo(mFolderId, removed, finished, &result,
                                     &live, &operation));
  EXPECT_EQ(held.get(), live);
  live = nullptr;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.RestoreMessageForUndo(mFolderId, removed, finished, &result,
                                     &live, &operation));
  EXPECT_EQ(123u, result);
  ASSERT_TRUE(removed.Body());
  ASSERT_TRUE(operation.Operation());
  bool exists = true;
  ASSERT_EQ(NS_OK, db.MessageExists(old, exists));
  EXPECT_FALSE(exists);
}

TEST_F(DeliveryCoreReferences, UndoOfflineCaptureRejectsDispatchedOperations) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
  nsCString sourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(sourceId));
  for (OfflineAttemptState state :
       {OfflineAttemptState::Sent, OfflineAttemptState::Confirmed,
        OfflineAttemptState::Ambiguous}) {
    nsMsgKey key;
    ASSERT_EQ(NS_OK, Add("dispatched-undo@invalid"_ns, {}, key));
    ASSERT_EQ(NS_OK, db.SetMessageUidOnServer(key, 42));
    OfflineOperationData own;
    own.operation = nsIMsgOfflineImapOperation::kFlagsChanged |
                    nsIMsgOfflineImapOperation::kAddKeywords;
    ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, own));
    OfflineOperationUndo operation;
    ASSERT_EQ(NS_OK, db.CaptureOfflineOperationForUndo(mFolderId, key, sourceId,
                                                       operation));
    ASSERT_EQ(NS_OK, db.SetOfflineOperationPlayingBack(mFolderId, key, true));
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.CaptureOfflineOperationForUndo(
                                          mFolderId, key, sourceId, operation));
    ASSERT_EQ(NS_OK, db.SetOfflineOperationPlayingBack(mFolderId, key, false));
    uint64_t attemptId = 0;
    ASSERT_EQ(NS_OK,
              db.BeginOfflineAttempt(mFolderId, key,
                                     nsIMsgOfflineImapOperation::kFlagsChanged,
                                     Nothing(), attemptId));
    if (state == OfflineAttemptState::Confirmed) {
      ASSERT_EQ(NS_OK, db.ConfirmOfflineAttempt(attemptId, Nothing()));
    } else if (state == OfflineAttemptState::Ambiguous) {
      ASSERT_EQ(NS_OK, db.MarkOfflineAttemptAmbiguous(attemptId));
    }
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.CaptureOfflineOperationForUndo(
                                          mFolderId, key, sourceId, operation));
    ASSERT_TRUE(operation.Operation());
    EXPECT_EQ(own.operation, operation.Operation()->operation);
  }
}

TEST_F(DeliveryCoreReferences, UndoOfflineRestoreRejectsChangedCounterpart) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsCString sourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(sourceId));
  for (uint32_t failure : {0u, 1u, 2u}) {
    ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
    nsMsgKey old, sourceKey;
    ASSERT_EQ(NS_OK, Add("stale-target@invalid"_ns, {}, old));
    ASSERT_EQ(NS_OK, Add("stale-counterpart@invalid"_ns, {}, sourceKey));
    ASSERT_EQ(NS_OK, db.SetMessageUidOnServer(sourceKey, 42));
    OfflineOperationData own;
    own.operation = nsIMsgOfflineImapOperation::kMoveResult;
    ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, old, own));
    OfflineOperationData source;
    source.operation = nsIMsgOfflineImapOperation::kMsgMoved;
    source.pendingDestination = Some(PendingDestination{mFolderId, old, 7});
    ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, sourceKey, source));
    OfflineUndoCounterpart counterpart{
        sourceId,  mFolderId,
        sourceKey, nsIMsgOfflineImapOperation::kMsgMoved,
        Nothing(), {mFolderId, old, 7}};
    OfflineOperationUndo operation;
    ASSERT_EQ(NS_OK, db.CaptureOfflineOperationForUndo(
                         mFolderId, old, sourceId, operation, &counterpart));
    if (failure == 0) {
      // Same key and payload, different authoritative native identity.
      ASSERT_EQ(NS_OK, db.RemoveOfflineOperation(mFolderId, sourceKey));
      ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, sourceKey, source));
    } else if (failure == 1) {
      ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 8));
    } else {
      uint64_t attemptId;
      ASSERT_EQ(NS_OK,
                db.BeginOfflineAttempt(mFolderId, sourceKey,
                                       nsIMsgOfflineImapOperation::kMsgMoved,
                                       source.pendingDestination, attemptId));
    }
    ASSERT_EQ(NS_OK, db.RemoveOfflineOperation(mFolderId, old));
    RemovedMessage removed;
    ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(old, removed));
    FinishedMessageBody finished{"stale-finished"_ns, 12, 12, 1, true};
    nsMsgKey result = 123;
    Message* live = nullptr;
    uint32_t published = 0;
    RefPtr<AddedObserver> observer =
        new AddedObserver([&](Message*) { ++published; });
    db.AddMessageListener(observer);
    auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.RestoreMessageForUndo(mFolderId, removed, finished, &result,
                                       &live, &operation));
    EXPECT_EQ(123u, result);
    EXPECT_EQ(nullptr, live);
    EXPECT_EQ(0u, published);
    ASSERT_TRUE(removed.Body());
    ASSERT_TRUE(operation.Operation());
    OfflineOperationData unchanged;
    ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, sourceKey, unchanged));
    CheckUndoOfflinePayload(source, unchanged);
  }
}

TEST_F(DeliveryCoreReferences,
       OfflineUndoSourceSchemaPreservesLegacyAndRejectsCorruption) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("legacy-queued-source@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageUidOnServer(key, 42));
  OfflineOperationData op;
  op.operation = nsIMsgOfflineImapOperation::kFlagsChanged;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().StoreOfflineOperation(mFolderId, key, op));
  Stop();
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK, RemovePost15OfflineColumns(old));
  ASSERT_EQ(NS_OK, old->SetSchemaVersion(15));
  ASSERT_EQ(NS_OK, old->Close());
  old = nullptr;
  ASSERT_EQ(NS_OK, Start());
  int32_t version;
  ASSERT_EQ(NS_OK, mConnection->GetSchemaVersion(&version));
  EXPECT_EQ(19, version);
  auto& db = mCore->MessageDB();
  Maybe<ServerMessageLocation> source;
  ASSERT_EQ(NS_OK, db.GetOfflineOperationSource(mFolderId, key, source));
  ASSERT_TRUE(source);
  EXPECT_EQ(key, source->key);
  EXPECT_EQ(7u, source->epoch);
  EXPECT_EQ(42u, source->uid);
  for (const char* invalid : {"0", "4294967295", "-1", "'invalid'"}) {
    nsAutoCString sql("UPDATE offline_operations SET sourcePhysicalKey=");
    sql.Append(invalid);
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
              db.GetOfflineOperationSource(mFolderId, key, source));
    ASSERT_TRUE(source);
    EXPECT_EQ(key, source->key);
  }
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "UPDATE offline_operations SET sourcePhysicalKey=1,epoch=NULL,uid=NULL"_ns));
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            db.GetOfflineOperationSource(mFolderId, key, source));
  ASSERT_TRUE(source);
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "UPDATE offline_operations SET sourcePhysicalKey=NULL,epoch=7,uid=42"_ns));
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, op));
  ASSERT_EQ(NS_OK, db.GetOfflineOperationSource(mFolderId, key, source));
  ASSERT_TRUE(source);
  EXPECT_EQ(key, source->key);
}

TEST_F(DeliveryCoreReferences,
       UndoCaptureFailureRetainsRowsAndPreviousSnapshot) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey saved, target, control;
  ASSERT_EQ(NS_OK, Add("saved-undo@invalid"_ns, {}, saved));
  ASSERT_EQ(NS_OK, Add("target-undo@invalid"_ns, {"raw@invalid"_ns}, target));
  ASSERT_EQ(NS_OK, Add("control-undo@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.SetMessageProperty(target, "Case"_ns, "00042"_ns));
  RemovedMessage snapshot;
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(saved, snapshot));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK, mConnection->CreateFunction("undo_fault"_ns, 1, witness));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER fail_undo_delete BEFORE DELETE ON messages "
          "BEGIN "
          "SELECT undo_fault(OLD.id); SELECT RAISE(ABORT,'undo delete'); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.RemoveMessageForUndo(target, snapshot));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(target, witness->mLastKey);
  ASSERT_TRUE(snapshot.Body());
  EXPECT_EQ(saved, snapshot.Body()->key);
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(target, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
  nsTArray<nsCString> refs;
  ASSERT_EQ(NS_OK, Stored(target, refs));
  EXPECT_EQ((nsTArray<nsCString>{"raw@invalid"_ns}), refs);
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(target, "Case"_ns, text));
  EXPECT_EQ("00042"_ns, text);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER fail_undo_delete"_ns));
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(target, snapshot));
  EXPECT_EQ(target, snapshot.Body()->key);
}

TEST_F(DeliveryCoreReferences, UndoRestoreFailureRetainsCaptureAndOutput) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, Add("restore-undo@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, Add("restore-control@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.SetMessageProperty(key, "Case"_ns, "1e3"_ns));
  RemovedMessage snapshot;
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(key, snapshot));
  FinishedMessageBody finished{"provider-finished"_ns, 12, 12, 1, true};
  nsMsgKey result = 123;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.RestoreMessageForUndo(UINT64_MAX, snapshot, finished, &result));
  EXPECT_EQ(123u, result);
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.RestoreMessageForUndo(mFolderId, snapshot, finished, &result));
  EXPECT_EQ(123u, result);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK, mConnection->CreateFunction("undo_fault"_ns, 1, witness));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER fail_undo_restore BEFORE INSERT ON "
                       "message_properties "
                       "WHEN NEW.name='Case' BEGIN SELECT undo_fault(NEW.id); "
                       "SELECT RAISE(ABORT,'undo restore'); END"_ns));
  RefPtr<Message> held = new Message(control);
  Message* live = held.get();
  EXPECT_EQ(
      NS_ERROR_STORAGE_CONSTRAINT,
      db.RestoreMessageForUndo(mFolderId, snapshot, finished, &result, &live));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(123u, result);
  EXPECT_EQ(held.get(), live);
  ASSERT_TRUE(snapshot.Body());
  EXPECT_EQ(key, snapshot.Body()->key);
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_FALSE(exists);
  {
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
    auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
    nsCString count;
    nsMsgKey attempted = static_cast<nsMsgKey>(witness->mLastKey);
    ASSERT_EQ(NS_OK,
              PublicationCell(reader, attempted,
                              "SELECT COUNT(*) FROM messages WHERE id=:id"_ns,
                              count));
    EXPECT_EQ("0"_ns, count);
    ASSERT_EQ(
        NS_OK,
        PublicationCell(
            reader, attempted,
            "SELECT COUNT(*) FROM message_properties WHERE id=:id"_ns, count));
    EXPECT_EQ("0"_ns, count);
  }
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER fail_undo_restore"_ns));
  ASSERT_EQ(NS_OK,
            db.RestoreMessageForUndo(mFolderId, snapshot, finished, &result));
  EXPECT_NE(key, result);
}

TEST_F(DeliveryCoreReferences,
       UndoRetainsUnavailableReferenceHistoryAcrossReopen) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("unknown-undo@invalid"_ns, {}, key));
  // Remove only the availability marker on a real core-created row.
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DELETE FROM message_reference_sets"_ns));
  nsTArray<nsCString> refs;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->MessageDB().GetMessageReferences(key, refs));
  RemovedMessage snapshot;
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessageForUndo(key, snapshot));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  FinishedMessageBody finished{"finished-after-reopen"_ns, 12, 12, 1, true};
  nsMsgKey restored;
  ASSERT_EQ(NS_OK, mCore->MessageDB().RestoreMessageForUndo(
                       mFolderId, snapshot, finished, &restored));
  refs = {"untouched"_ns};
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->MessageDB().GetMessageReferences(restored, refs));
  EXPECT_EQ((nsTArray<nsCString>{"untouched"_ns}), refs);
}

TEST_F(DeliveryCoreReferences, UndoRetainsKnownEmptyReferences) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("empty-undo@invalid"_ns, {}, key));
  RemovedMessage snapshot;
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessageForUndo(key, snapshot));
  FinishedMessageBody finished{"finished-empty"_ns, 12, 12, 1, true};
  nsMsgKey restored;
  ASSERT_EQ(NS_OK, mCore->MessageDB().RestoreMessageForUndo(
                       mFolderId, snapshot, finished, &restored));
  nsTArray<nsCString> refs = {"not empty"_ns};
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(restored, refs));
  EXPECT_TRUE(refs.IsEmpty());
}

TEST_F(DeliveryCoreReferences,
       UndoCaptureRejectsUnsupportedStoredPropertyWithoutDeletion) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("unsupported-undo@invalid"_ns, {}, key));
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(
      NS_OK,
      mConnection->CreateStatement(
          "INSERT INTO message_properties VALUES(:id,'unsupported',1.25)"_ns,
          getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, key));
  ASSERT_EQ(NS_OK, stmt->Execute());
  ASSERT_EQ(NS_OK, stmt->Finalize());
  RemovedMessage snapshot;
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, db.RemoveMessageForUndo(key, snapshot));
  EXPECT_FALSE(snapshot.Body());
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreReferences, UndoCaptureRejectsNoneKeyWithoutDeletingRows) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("undo-sentinel-control@invalid"_ns, {}, control));
  RemovedMessage output;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.RemoveMessageForUndo(nsMsgKey_None, output));
  EXPECT_FALSE(output.Body());
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreReferences, UndoFolderCaptureAccountsAndRollsBackTogether) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  RawHdr raw;
  raw.messageId = "accounted-undo@invalid"_ns;
  raw.messageSize = Some(UINT32_MAX);
  raw.storeToken = Some(nsCString("removed-physical-body"_ns));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &key));
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 17));
  RemovedMessage snapshot;
  uint32_t removed = 0;
  RefPtr<UndoRemovalObserver> observer = new UndoRemovalObserver([&](Message*) {
    ++removed;
    ASSERT_TRUE(snapshot.Body());
    EXPECT_EQ(key, snapshot.Body()->key);
    bool active = true;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    int64_t metric = 0;
    ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, metric));
    EXPECT_EQ(int64_t(UINT32_MAX) + 17, metric);
  });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("undo_count_fault"_ns, 1, witness));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_accounted_undo BEFORE DELETE ON messages "
          "BEGIN SELECT undo_count_fault(OLD.id); "
          "SELECT RAISE(ABORT,'accounted undo'); END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS reject_accounted_undo"_ns));
  });
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.RemoveMessageForUndo(key, mFolderId, source,
                                    MessageRemovalAccounting::LocalMessageSize,
                                    snapshot));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(0u, removed);
  EXPECT_FALSE(snapshot.Body());
  int64_t metric = 0;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, metric));
  EXPECT_EQ(17, metric);
  bool exists = false;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_TRUE(exists);
  nsCString token;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "storeToken"_ns, token));
  EXPECT_EQ("removed-physical-body"_ns, token);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER reject_accounted_undo"_ns));
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(
                       key, mFolderId, source,
                       MessageRemovalAccounting::LocalMessageSize, snapshot));
  EXPECT_EQ(1u, removed);
  FinishedMessageBody finished{"fresh-provider-copy"_ns, 25, 0, 2, false};
  nsMsgKey restored;
  ASSERT_EQ(NS_OK,
            db.RestoreMessageForUndo(mFolderId, snapshot, finished, &restored));
  EXPECT_NE(key, restored);
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, metric));
  // Restore writes a fresh body. The old removed body is still expunged.
  EXPECT_EQ(int64_t(UINT32_MAX) + 17, metric);
}

TEST_F(DeliveryCoreReferences,
       UndoFolderCaptureRejectsForeignAndCallerOwnedWork) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("guarded-undo@invalid"_ns, {}, key));
  uint64_t other;
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolderId, "Other"_ns, &other));
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 31));
  RemovedMessage snapshot;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.RemoveMessageForUndo(key, other, source,
                                    MessageRemovalAccounting::LocalMessageSize,
                                    snapshot));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.RemoveMessageForUndo(
                key, mFolderId, "foreign"_ns,
                MessageRemovalAccounting::OfflineMessageSize, snapshot));
  EXPECT_FALSE(snapshot.Body());
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    if (active) EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 79));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.RemoveMessageForUndo(key, mFolderId, source,
                                    MessageRemovalAccounting::LocalMessageSize,
                                    snapshot));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  int64_t metric = 0;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, metric));
  EXPECT_EQ(79, metric);
  EXPECT_FALSE(snapshot.Body());
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, metric));
  EXPECT_EQ(31, metric);
  bool exists = false;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreReferences,
       StartupPreservesMalformedFileForExplicitRestore) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK,
            Add("corrupt-file-control"_ns, {"raw"_ns, ""_ns, "raw"_ns}, key));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().SetMessageProperty(key, "Exact"_ns, "00042"_ns));
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  Stop();

  // Preserve the closed, valid database before damaging only this test's copy.
  ASSERT_EQ(NS_OK, mFile->CopyToNative(mProfile, "lifecycle-backup.sqlite"_ns));
  nsCOMPtr<nsIFile> backup;
  ASSERT_EQ(NS_OK, mProfile->Clone(getter_AddRefs(backup)));
  ASSERT_EQ(NS_OK, backup->Append(u"lifecycle-backup.sqlite"_ns));
  int64_t size = 0;
  ASSERT_EQ(NS_OK, backup->GetFileSize(&size));
  ASSERT_GT(size, 31);
  ASSERT_EQ(NS_OK, mFile->SetFileSize(31));
  auto readBytes = [](nsIFile* file, nsACString& bytes) -> nsresult {
    nsCOMPtr<nsIInputStream> stream;
    MOZ_TRY(NS_NewLocalFileInputStream(getter_AddRefs(stream), file));
    auto close = MakeScopeExit([&] { stream->Close(); });
    return NS_ReadInputStreamToString(stream, bytes, -1);
  };
  nsCString damaged;
  ASSERT_EQ(NS_OK, readBytes(mFile, damaged));
  ASSERT_EQ(31U, damaged.Length());

  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, Start());
  EXPECT_FALSE(Connection());
  bool exists = false;
  ASSERT_EQ(NS_OK, mFile->Exists(&exists));
  ASSERT_TRUE(exists);
  nsCString retained;
  ASSERT_EQ(NS_OK, readBytes(mFile, retained));
  EXPECT_EQ(damaged, retained);
  ASSERT_EQ(NS_OK, backup->GetFileSize(&size));
  EXPECT_GT(size, 31);

  // Only explicit test recovery restores the backup. Keep the rejected input.
  nsCOMPtr<nsIFile> rejected;
  ASSERT_EQ(NS_OK, mFile->Clone(getter_AddRefs(rejected)));
  ASSERT_EQ(NS_OK,
            rejected->MoveToNative(mProfile, "lifecycle-rejected.sqlite"_ns));
  ASSERT_EQ(NS_OK, backup->CopyToNative(mProfile, "panorama.sqlite"_ns));
  ASSERT_EQ(NS_OK, Start());
  nsCString reopened;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(reopened));
  EXPECT_EQ(source, reopened);
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessageProperty(key, "Exact"_ns, retained));
  EXPECT_EQ("00042"_ns, retained);
  nsTArray<nsCString> refs;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(key, refs));
  EXPECT_EQ((nsTArray<nsCString>{"raw"_ns, ""_ns, "raw"_ns}), refs);
  ASSERT_EQ(NS_OK, readBytes(rejected, retained));
  EXPECT_EQ(damaged, retained);
}

TEST_F(DeliveryCoreReferences, StartupRefusesFutureSchemaWithoutLosingRows) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK,
            Add("future-version-control"_ns, {"raw"_ns, ""_ns, "raw"_ns}, key));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().SetMessageProperty(key, "Case"_ns, "00042"_ns));
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  int32_t supported;
  ASSERT_EQ(NS_OK, mConnection->GetSchemaVersion(&supported));
  ASSERT_LT(supported, INT32_MAX);
  Stop();
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  ASSERT_EQ(NS_OK, reader->SetSchemaVersion(supported + 1));
  ASSERT_EQ(NS_OK, reader->Close());
  reader = nullptr;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, Start());
  bool exists = false;
  ASSERT_EQ(NS_OK, mFile->Exists(&exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  auto close = MakeScopeExit([&] {
    if (reader) EXPECT_EQ(NS_OK, reader->Close());
  });
  int32_t retained;
  ASSERT_EQ(NS_OK, reader->GetSchemaVersion(&retained));
  EXPECT_EQ(supported + 1, retained);
  bool active = true;
  ASSERT_EQ(NS_OK, reader->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  nsCString stored;
  ASSERT_EQ(NS_OK,
            PublicationCell(reader, key,
                            "SELECT messageId FROM messages WHERE id=:id"_ns,
                            stored));
  EXPECT_EQ("future-version-control"_ns, stored);
  ASSERT_EQ(
      NS_OK,
      PublicationCell(
          reader, key,
          "SELECT value FROM message_properties WHERE id=:id AND name='Case'"_ns,
          stored));
  EXPECT_EQ("00042"_ns, stored);
  // Only the test restores the supported version; startup never rewrites it.
  ASSERT_EQ(NS_OK, reader->SetSchemaVersion(supported));
  ASSERT_EQ(NS_OK, reader->Close());
  reader = nullptr;
  ASSERT_EQ(NS_OK, Start());
  nsCString reopened;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(reopened));
  EXPECT_EQ(source, reopened);
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_TRUE(exists);
  nsTArray<nsCString> refs;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(key, refs));
  EXPECT_EQ((nsTArray<nsCString>{"raw"_ns, ""_ns, "raw"_ns}), refs);
}

TEST_F(DeliveryCoreReferences,
       StartupRejectsIncompatibleLayoutWithoutRebuilding) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("damaged-schema-control"_ns, {}, key));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().SetMessageProperty(key, "empty"_ns, ""_ns));
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  int32_t supported;
  ASSERT_EQ(NS_OK, mConnection->GetSchemaVersion(&supported));
  Stop();
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  ASSERT_EQ(NS_OK,
            reader->ExecuteSimpleSQL(
                "ALTER TABLE messages ADD COLUMN unsupported_layout TEXT"_ns));
  ASSERT_EQ(NS_OK, reader->Close());
  reader = nullptr;
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, Start());
  bool exists = false;
  ASSERT_EQ(NS_OK, mFile->Exists(&exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  auto close = MakeScopeExit([&] {
    if (reader) EXPECT_EQ(NS_OK, reader->Close());
  });
  int32_t retained;
  ASSERT_EQ(NS_OK, reader->GetSchemaVersion(&retained));
  EXPECT_EQ(supported, retained);
  nsCString stored;
  ASSERT_EQ(NS_OK,
            PublicationCell(reader, key,
                            "SELECT messageId FROM messages WHERE id=:id"_ns,
                            stored));
  EXPECT_EQ("damaged-schema-control"_ns, stored);
  ASSERT_EQ(
      NS_OK,
      PublicationCell(
          reader, key,
          "SELECT COUNT(*) FROM message_properties WHERE id=:id AND name='empty' AND value=''"_ns,
          stored));
  EXPECT_EQ("1"_ns, stored);
  // Explicit test repair, not product recovery or a replacement database.
  ASSERT_EQ(NS_OK,
            reader->ExecuteSimpleSQL(
                "ALTER TABLE messages DROP COLUMN unsupported_layout"_ns));
  ASSERT_EQ(NS_OK, reader->Close());
  reader = nullptr;
  ASSERT_EQ(NS_OK, Start());
  nsCString reopened;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(reopened));
  EXPECT_EQ(source, reopened);
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreReferences,
       GenericRemovalRejectsNoneAndPreservesCallerWork) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("generic-none-control"_ns, {}, key));
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 19));
  uint32_t removed = 0;
  RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
  observer->action = [&](char kind, const CapturedMessage& before,
                         const CapturedMessage&, Message*, bool) {
    EXPECT_EQ('R', kind);
    ++removed;
    EXPECT_EQ(key, before.id);
    bool active = true;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    int64_t metric = 0;
    ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, metric));
    EXPECT_EQ(19, metric);
  };
  db.AddMessageListener(observer);
  auto remove = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  EXPECT_EQ(NS_ERROR_INVALID_ARG, db.RemoveMessage(nsMsgKey_None));
  EXPECT_EQ(0u, removed);
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    if (active) EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 73));
  EXPECT_EQ(NS_ERROR_INVALID_ARG, db.RemoveMessage(nsMsgKey_None));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.RemoveMessage(key));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  int64_t metric = 0;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, metric));
  EXPECT_EQ(73, metric);
  bool exists = false;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_TRUE(exists);
  EXPECT_EQ(0u, removed);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  // The generic valid-key path still removes without folder-byte accounting.
  ASSERT_EQ(NS_OK, db.RemoveMessage(key));
  EXPECT_EQ(1u, removed);
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_FALSE(exists);
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, metric));
  EXPECT_EQ(19, metric);
}

TEST_F(DeliveryCoreReferences, WeakFolderListenerDoesNotOwnUnusedFacade) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  RefPtr<PerFolderDatabase> facade = WeakFolderDatabase(mFolderId);
  WeakPtr<PerFolderDatabase> weak(facade.get());
  facade = nullptr;
  EXPECT_FALSE(weak);
  uint32_t publications = 0;
  RefPtr<AddedObserver> ordinary =
      new AddedObserver([&](Message*) { ++publications; });
  MessageListener* identity = ordinary;
  db.AddMessageListener(ordinary);
  ordinary = nullptr;
  auto remove = MakeScopeExit([&] { db.RemoveMessageListener(identity); });
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("unused-weak-folder"_ns, {}, key));
  EXPECT_EQ(1u, publications);
  bool exists = false;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_TRUE(exists);
  EXPECT_FALSE(weak);
}

TEST_F(DeliveryCoreReferences, WeakFolderListenerKeepsExternalNewListsScoped) {
  ASSERT_EQ(NS_OK, Start());
  RefPtr<PerFolderDatabase> facade = WeakFolderDatabase(mFolderId);
  uint64_t otherFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "Bystander"_ns,
                                                  &otherFolder));
  RefPtr<PerFolderDatabase> other = WeakFolderDatabase(otherFolder);
  WeakPtr<PerFolderDatabase> weak(facade.get());
  ASSERT_EQ(NS_OK, facade->Close(false));
  ASSERT_TRUE(weak);
  nsMsgKey key, otherKey;
  ASSERT_EQ(NS_OK, Add("externally-held-folder"_ns, {}, key));
  ASSERT_EQ(NS_OK, AddAt(otherFolder, "other-held-folder"_ns, {}, otherKey));
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, facade->GetNewList(keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{key}), keys);
  ASSERT_EQ(NS_OK, other->GetNewList(keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{otherKey}), keys);
  facade = nullptr;
  EXPECT_FALSE(weak);
  ASSERT_EQ(NS_OK, other->GetNewList(keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{otherKey}), keys);
}

TEST_F(DeliveryCoreReferences, WeakFolderPreflightPinsThroughWholeDelivery) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  RefPtr<PerFolderDatabase> facade;
  WeakPtr<PerFolderDatabase> weak;
  uint32_t first = 0, last = 0;
  RefPtr<AddedObserver> before = new AddedObserver([&](Message*) {
    ++first;
    facade = nullptr;
    EXPECT_TRUE(weak);
  });
  db.AddMessageListener(before);
  facade = WeakFolderDatabase(mFolderId);
  weak = WeakPtr<PerFolderDatabase>(facade.get());
  RefPtr<AddedObserver> after = new AddedObserver([&](Message* message) {
    ++last;
    ASSERT_TRUE(weak);
    nsTArray<nsMsgKey> keys;
    ASSERT_EQ(NS_OK, weak->GetNewList(keys));
    EXPECT_EQ((nsTArray<nsMsgKey>{message->Key()}), keys);
  });
  db.AddMessageListener(after);
  auto remove = MakeScopeExit([&] {
    db.RemoveMessageListener(before);
    db.RemoveMessageListener(after);
  });
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("preflight-owned-folder"_ns, {}, key));
  EXPECT_EQ(1u, first);
  EXPECT_EQ(1u, last);
  EXPECT_FALSE(weak);
}

TEST_F(DeliveryCoreReferences, WeakFolderReenrollmentCancelsOldBatchToken) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  RefPtr<PerFolderDatabase> facade;
  bool reenrolled = false;
  RefPtr<AddedObserver> before = new AddedObserver([&](Message*) {
    if (!reenrolled) {
      reenrolled = true;
      db.RemoveMessageListener(facade);
      EnrollWeakFolder(facade);
    }
  });
  db.AddMessageListener(before);
  facade = WeakFolderDatabase(mFolderId);
  auto remove = MakeScopeExit([&] { db.RemoveMessageListener(before); });
  nsMsgKey first, second;
  ASSERT_EQ(NS_OK, Add("old-registration-token"_ns, {}, first));
  EXPECT_TRUE(reenrolled);
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, facade->GetNewList(keys));
  EXPECT_TRUE(keys.IsEmpty());
  ASSERT_EQ(NS_OK, Add("new-registration-token"_ns, {}, second));
  ASSERT_EQ(NS_OK, facade->GetNewList(keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{second}), keys);
  WeakPtr<PerFolderDatabase> weak(facade.get());
  ASSERT_EQ(NS_OK, facade->ForceClosed());
  EXPECT_FALSE(weak);
  ASSERT_EQ(NS_OK, facade->GetNewList(keys));
  EXPECT_TRUE(keys.IsEmpty());
  nsMsgKey third;
  ASSERT_EQ(NS_OK, Add("after-explicit-close"_ns, {}, third));
  ASSERT_EQ(NS_OK, facade->GetNewList(keys));
  EXPECT_TRUE(keys.IsEmpty());
  EXPECT_FALSE(weak);
}

TEST_F(DeliveryCoreReferences, WeakFolderImportPinsBeforeFirstCallback) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("import-recipient-control"_ns, {}, key));
  RefPtr<PerFolderDatabase> facade;
  WeakPtr<PerFolderDatabase> weak;
  uint32_t first = 0, last = 0;
  RefPtr<AddedObserver> before = new AddedObserver([&](Message*) {
    ++first;
    facade = nullptr;
    EXPECT_TRUE(weak);
  });
  db.AddMessageListener(before);
  facade = WeakFolderDatabase(mFolderId);
  weak = WeakPtr<PerFolderDatabase>(facade.get());
  RefPtr<AddedObserver> after = new AddedObserver([&](Message* message) {
    ++last;
    ASSERT_TRUE(weak);
    nsTArray<nsMsgKey> keys;
    ASSERT_EQ(NS_OK, weak->GetNewList(keys));
    EXPECT_EQ((nsTArray<nsMsgKey>{message->Key()}), keys);
  });
  db.AddMessageListener(after);
  auto remove = MakeScopeExit([&] {
    db.RemoveMessageListener(before);
    db.RemoveMessageListener(after);
  });
  NotifyImported(key);
  EXPECT_EQ(1u, first);
  EXPECT_EQ(1u, last);
  EXPECT_FALSE(weak);
}

TEST_F(DeliveryCoreReferences, HeaderCacheMissAcrossTrimKeepsPhysicalFields) {
  ASSERT_EQ(NS_OK, Start());
  nsTArray<nsMsgKey> keys;
  nsTArray<nsCString> subjects;
  constexpr uint32_t boundary = 512;
  keys.SetCapacity(boundary + 1);
  subjects.SetCapacity(boundary + 1);
  for (uint32_t i = 0; i <= boundary; ++i) {
    RawHdr raw;
    raw.messageId = "cache-boundary-"_ns;
    raw.messageId.AppendInt(i);
    raw.subject = "physical subject "_ns;
    raw.subject.AppendInt(i);
    nsMsgKey key;
    ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolderId, raw, true, &key));
    keys.AppendElement(key);
    subjects.AppendElement(raw.subject);
  }
  Stop();
  ASSERT_EQ(NS_OK, Start());
  EXPECT_EQ(0u, CachedHeaderCount());
  for (uint32_t i = 0; i < boundary; ++i) {
    RefPtr<Message> message = new Message(keys[i]);
    nsCString subject;
    ASSERT_EQ(NS_OK, message->GetSubject(subject));
    EXPECT_EQ(subjects[i], subject);
  }
  ASSERT_EQ(boundary, CachedHeaderCount());
  RefPtr<Message> last = new Message(keys.LastElement());
  nsCString subject;
  // The cold miss must cross TrimCache's removal before inserting this row.
  ASSERT_EQ(NS_OK, last->GetSubject(subject));
  EXPECT_EQ(subjects.LastElement(), subject);
  EXPECT_LE(CachedHeaderCount(), boundary);
  EXPECT_TRUE(HeaderIsCached(keys.LastElement()));
  bool reloaded = false;
  for (uint32_t i = 0; i < boundary; ++i) {
    if (!HeaderIsCached(keys[i])) {
      RefPtr<Message> message = new Message(keys[i]);
      ASSERT_EQ(NS_OK, message->GetSubject(subject));
      EXPECT_EQ(subjects[i], subject);
      EXPECT_TRUE(HeaderIsCached(keys[i]));
      reloaded = true;
      break;
    }
  }
  EXPECT_TRUE(reloaded);
}

TEST_F(DeliveryCoreReferences, MarkAllReadWriteFailureKeepsSqlCacheAndOutput) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  RawHdr raw;
  raw.messageId = "bulk-first@invalid"_ns;
  raw.flags = nsMsgMessageFlags::Forwarded | nsMsgMessageFlags::New;
  nsMsgKey first, second, read, foreign;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &first));
  raw.messageId = "bulk-second@invalid"_ns;
  raw.flags = 0;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &second));
  raw.messageId = "bulk-read@invalid"_ns;
  raw.flags = nsMsgMessageFlags::Read | nsMsgMessageFlags::Marked;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &read));
  uint64_t other;
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolderId, "Other"_ns, &other));
  raw.messageId = "bulk-foreign@invalid"_ns;
  raw.flags = 0;
  ASSERT_EQ(NS_OK, db.AddMessage(other, raw, true, &foreign));
  uint32_t flags;
  ASSERT_EQ(NS_OK, db.GetMessageFlags(first, flags));
  EXPECT_EQ(uint32_t{nsMsgMessageFlags::Forwarded | nsMsgMessageFlags::New},
            flags);
  ASSERT_EQ(NS_OK, db.GetMessageFlags(second, flags));
  EXPECT_EQ(0u, flags);

  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("mark_all_fault"_ns, 1, witness));
  nsAutoCString trigger(
      "CREATE TEMP TRIGGER fail_mark_all BEFORE UPDATE OF flags ON messages "
      "BEGIN SELECT mark_all_fault(OLD.id); SELECT CASE WHEN OLD.id="_ns);
  trigger.AppendInt(second);
  trigger.AppendLiteral(" THEN RAISE(FAIL,'bulk read fault') END; END");
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(trigger));
  auto cleanup = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS fail_mark_all"_ns));
    EXPECT_EQ(NS_OK, mConnection->RemoveFunction("mark_all_fault"_ns));
  });
  nsTArray<nsMsgKey> marked{nsMsgKey_None - 1};
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, MarkFolderRead(mFolderId, marked));
  EXPECT_EQ((nsTArray<nsMsgKey>{nsMsgKey_None - 1}), marked);
  EXPECT_EQ(2u, witness->mCalls);
  EXPECT_EQ(second, witness->mLastKey);
  bool active = true;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_EQ(NS_OK, db.GetMessageFlags(first, flags));
  EXPECT_EQ(uint32_t{nsMsgMessageFlags::Forwarded | nsMsgMessageFlags::New},
            flags);
  ASSERT_EQ(NS_OK, db.GetMessageFlags(second, flags));
  EXPECT_EQ(0u, flags);
  uint64_t unread;
  ASSERT_EQ(NS_OK, FolderUnreadCount(mFolderId, unread));
  EXPECT_EQ(2u, unread);

  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER fail_mark_all"_ns));
  ASSERT_EQ(NS_OK, MarkFolderRead(mFolderId, marked));
  EXPECT_EQ((nsTArray<nsMsgKey>{first, second}), marked);
  ASSERT_EQ(NS_OK, db.GetMessageFlags(first, flags));
  EXPECT_EQ(uint32_t{nsMsgMessageFlags::Forwarded | nsMsgMessageFlags::New |
                     nsMsgMessageFlags::Read},
            flags);
  ASSERT_EQ(NS_OK, db.GetMessageFlags(read, flags));
  EXPECT_EQ(uint32_t{nsMsgMessageFlags::Read | nsMsgMessageFlags::Marked},
            flags);
  ASSERT_EQ(NS_OK, db.GetMessageFlags(foreign, flags));
  EXPECT_EQ(0u, flags);
  ASSERT_EQ(NS_OK, FolderUnreadCount(mFolderId, unread));
  EXPECT_EQ(0u, unread);
  ASSERT_EQ(NS_OK, FolderUnreadCount(other, unread));
  EXPECT_EQ(1u, unread);
  ASSERT_EQ(NS_OK, MarkFolderRead(mFolderId, marked));
  EXPECT_TRUE(marked.IsEmpty());
  ASSERT_EQ(NS_OK, mConnection->RemoveFunction("mark_all_fault"_ns));
  cleanup.release();
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageFlags(first, flags));
  EXPECT_EQ(uint32_t{nsMsgMessageFlags::Forwarded | nsMsgMessageFlags::New |
                     nsMsgMessageFlags::Read},
            flags);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageFlags(foreign, flags));
  EXPECT_EQ(0u, flags);
}

TEST_F(DeliveryCoreReferences,
       MarkAllReadRefusesCallerTransactionWithoutOwningIt) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("caller-bulk@invalid"_ns, {}, key));
  uint32_t flags;
  ASSERT_EQ(NS_OK, db.GetMessageFlags(key, flags));
  EXPECT_EQ(0u, flags);
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    if (active) {
      EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
    }
  });
  ASSERT_EQ(NS_OK,
            db.SetMessageProperty(key, "caller-control"_ns, "pending"_ns));
  nsTArray<nsMsgKey> marked{nsMsgKey_None - 1};
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, MarkFolderRead(mFolderId, marked));
  EXPECT_EQ((nsTArray<nsMsgKey>{nsMsgKey_None - 1}), marked);
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  nsCString control;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "caller-control"_ns, control));
  EXPECT_EQ("pending"_ns, control);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_EQ(NS_OK, db.GetMessageFlags(key, flags));
  EXPECT_EQ(0u, flags);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "caller-control"_ns, control));
  EXPECT_TRUE(control.IsEmpty());
  ASSERT_EQ(NS_OK, MarkFolderRead(mFolderId, marked));
  EXPECT_EQ((nsTArray<nsMsgKey>{key}), marked);
}

TEST_F(DeliveryCoreReferences, DurableSearchReplaySurvivesCoreReopen) {
  ASSERT_EQ(NS_OK, Start());
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  uint64_t start;
  ASSERT_EQ(NS_OK, SearchWatermark(start));
  nsMsgKey retained, removed;
  ASSERT_EQ(NS_OK, Add("physical-copy@invalid"_ns, {}, retained));
  ASSERT_EQ(NS_OK, Add("physical-copy@invalid"_ns, {}, removed));
  ASSERT_NE(retained, removed);
  RefPtr<Message> header = new Message(retained);
  ASSERT_EQ(NS_OK, header->SetSubject("edited before reopen"_ns));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(
                       retained, "storeToken"_ns, "persisted-token"_ns));
  ASSERT_EQ(NS_OK, mCore->MessageDB().NoteSearchPolicyChanged());
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(removed));
  uint64_t watermark;
  ASSERT_EQ(NS_OK, SearchWatermark(watermark));
  ASSERT_GT(watermark, start);

  mozilla::dom::AutoJSAPI jsapi;
  ASSERT_TRUE(jsapi.Init(xpc::PrivilegedJunkScope()));
  JSContext* cx = jsapi.cx();
  auto stringify = [cx](JS::MutableHandle<JS::Value> value, nsString& text) {
    text.Truncate();
    return JS_Stringify(
        cx, value, nullptr, JS::NullHandleValue,
        [](const char16_t* data, uint32_t length, void* output) {
          static_cast<nsString*>(output)->Append(data, length);
          return true;
        },
        &text);
  };
  JS::Rooted<JS::Value> replay(cx), state(cx);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetSearchChanges(start, 1000, cx, &replay));
  nsString beforeReplay, beforeState;
  ASSERT_TRUE(stringify(&replay, beforeReplay));
  EXPECT_NE(kNotFound, beforeReplay.Find(u"\"messageKey\":null"_ns));
  EXPECT_NE(kNotFound, beforeReplay.Find(u"\"deleted\":true"_ns));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetSearchState(retained, cx, &state));
  ASSERT_TRUE(state.isObject());
  ASSERT_TRUE(stringify(&state, beforeState));
  EXPECT_NE(kNotFound, beforeState.Find(u"persisted-token"_ns));
  header = nullptr;
  Stop();
  ASSERT_EQ(NS_OK, Start());
  nsCString reopenedSource;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(reopenedSource));
  EXPECT_EQ(source, reopenedSource);
  uint64_t reopenedWatermark;
  ASSERT_EQ(NS_OK, SearchWatermark(reopenedWatermark));
  EXPECT_EQ(watermark, reopenedWatermark);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetSearchChanges(start, 1000, cx, &replay));
  nsString after;
  ASSERT_TRUE(stringify(&replay, after));
  EXPECT_EQ(beforeReplay, after);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetSearchState(retained, cx, &state));
  ASSERT_TRUE(stringify(&state, after));
  EXPECT_EQ(beforeState, after);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetSearchState(removed, cx, &state));
  EXPECT_TRUE(state.isNull());
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetSearchChanges(watermark, 1000, cx, &replay));
  ASSERT_TRUE(stringify(&replay, after));
  EXPECT_NE(kNotFound, after.Find(u"\"changes\":[]"_ns));

  nsMsgKey later;
  ASSERT_EQ(NS_OK, Add("after-reopen@invalid"_ns, {}, later));
  EXPECT_NE(later, retained);
  EXPECT_NE(later, removed);
  ASSERT_EQ(NS_OK, SearchWatermark(reopenedWatermark));
  EXPECT_GT(reopenedWatermark, watermark);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetSearchChanges(watermark, 1000, cx, &replay));
  ASSERT_TRUE(stringify(&replay, after));
  nsAutoString expected(u"\"messageKey\":"_ns);
  expected.AppendInt(later);
  expected.Append(u',');
  EXPECT_NE(kNotFound, after.Find(expected));
}

TEST_F(DeliveryCoreReferences,
       StagedAttributesKeepCopiesDistinctAndPublishComplete) {
  ASSERT_EQ(NS_OK, Start());
  nsCString sourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(sourceId));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 51));
  RawHdr raw;
  raw.messageId = "duplicate@invalid"_ns;
  raw.flags = nsMsgMessageFlags::Read;
  nsMsgKey first, second;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &first));
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &second));
  uint32_t completeCalls = 0;
  RefPtr<PendingHeaderObserver> observer =
      new PendingHeaderObserver([&](Message* message) {
        ++completeCalls;
        bool active = true;
        ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
        EXPECT_FALSE(active);
        nsMsgKey key = nsMsgKey_None;
        ASSERT_EQ(NS_OK, message->GetMessageKey(&key));
        EXPECT_EQ(first, key);
        nsCString text;
        ASSERT_EQ(NS_OK, message->GetStoreToken(text));
        EXPECT_EQ("finished-target"_ns, text);
        ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageTags(key, text));
        EXPECT_EQ("final tags"_ns, text);
        nsMsgPriorityValue priority = nsMsgPriority::notSet;
        ASSERT_EQ(NS_OK, message->GetPriority(&priority));
        EXPECT_EQ(nsMsgPriority::highest, priority);
        ASSERT_EQ(NS_OK,
                  mCore->MessageDB().GetMessageProperty(key, "wide"_ns, text));
        EXPECT_EQ("ffffffffffffffff"_ns, text);
      });
  db.AddMessageListener(observer);
  auto remove = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  nsTArray<PendingHeaderAttribute> attributes = {
      {"flags"_ns, ""_ns, Some(uint64_t(nsMsgMessageFlags::HasRe))},
      {"flags"_ns, ""_ns, Some(uint64_t(nsMsgMessageFlags::Marked))},
      {"keywords"_ns, "first tags"_ns, Nothing()},
      {"keywords"_ns, "final tags"_ns, Nothing()},
      {"priority"_ns, "6"_ns, Nothing()},
      {"Case"_ns, "00042"_ns, Nothing()},
      {"case"_ns, "1e3"_ns, Nothing()},
      {"empty"_ns, ""_ns, Nothing()},
      {"café"_ns, "composed"_ns, Nothing()},
      {"café"_ns, "decomposed"_ns, Nothing()},
      {"max32"_ns, ""_ns, Some(uint64_t(UINT32_MAX))},
      {"wide"_ns, ""_ns, Some(uint64_t(UINT64_MAX))},
      {"zero"_ns, ""_ns, Some(uint64_t(0))},
      {"storeToken"_ns, "finished-target"_ns, Nothing()},
      {"offlineMsgSize"_ns, ""_ns, Some(uint64_t(23))}};
  Maybe<FinishedMessageBody> finished =
      Some(FinishedMessageBody{"finished-target"_ns, 24, 23, 2, true});
  ASSERT_EQ(NS_OK, db.SetStagedHeaderAttributes(
                       sourceId, {mFolderId, first, 51}, attributes, finished));
  EXPECT_EQ(0u, observer->mAdded);
  EXPECT_EQ(0u, observer->mChanged);
  bool exists = true;
  ASSERT_EQ(NS_OK, db.MessageExists(first, exists));
  EXPECT_FALSE(exists);
  uint32_t flags = 0;
  ASSERT_EQ(NS_OK, db.GetMessageFlags(first, flags));
  EXPECT_EQ(uint32_t(nsMsgMessageFlags::Read | nsMsgMessageFlags::Marked |
                     nsMsgMessageFlags::Offline),
            flags);
  ASSERT_EQ(NS_OK, db.GetMessageFlags(second, flags));
  EXPECT_EQ(uint32_t(nsMsgMessageFlags::Read), flags);
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(first, "max32"_ns, text));
  EXPECT_EQ("ffffffff"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(first, "zero"_ns, text));
  EXPECT_EQ("0"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(first, "Case"_ns, text));
  EXPECT_EQ("00042"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(first, "case"_ns, text));
  EXPECT_EQ("1e3"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(first, "café"_ns, text));
  EXPECT_EQ("composed"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(first, "café"_ns, text));
  EXPECT_EQ("decomposed"_ns, text);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(first, names));
  EXPECT_TRUE(names.Contains("empty"_ns));
  EXPECT_FALSE(names.Contains("offlineMsgSize"_ns));
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(second, names));
  EXPECT_FALSE(names.Contains("Case"_ns));
  db.RemoveMessageListener(observer);
  remove.release();
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->MessageDB();
  nsTArray<PendingHeaderAttribute> afterReopen{
      {"after-reopen"_ns, ""_ns, Some(uint64_t(0))}};
  ASSERT_EQ(NS_OK, reopened.SetStagedHeaderAttributes(
                       sourceId, {mFolderId, first, 51}, afterReopen));
  reopened.AddMessageListener(observer);
  auto cleanup =
      MakeScopeExit([&] { reopened.RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, reopened.PublishMessage(first, true));
  EXPECT_EQ(1u, observer->mAdded);
  EXPECT_EQ(1u, completeCalls);
  EXPECT_EQ(0u, observer->mChanged);
  ASSERT_EQ(NS_OK, reopened.MessageExists(second, exists));
  EXPECT_FALSE(exists);
}

TEST_F(DeliveryCoreReferences, StagedAttributeFailureRollsBackWithoutEvents) {
  ASSERT_EQ(NS_OK, Start());
  nsCString sourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(sourceId));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 53));
  RawHdr raw;
  raw.keywords = "original"_ns;
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &key));
  ASSERT_EQ(NS_OK, db.SetMessageProperty(key, "good"_ns, "old"_ns));
  RefPtr<PendingHeaderObserver> observer =
      new PendingHeaderObserver([](Message*) {});
  db.AddMessageListener(observer);
  auto remove = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            Connection()->CreateFunction("pending_fault"_ns, 1, witness));
  auto unregister = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, Connection()->RemoveFunction("pending_fault"_ns));
  });
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL(
                "CREATE TEMP TRIGGER fail_pending_attr BEFORE INSERT ON "
                "staged_message_properties "
                "WHEN NEW.name='fail' BEGIN SELECT pending_fault(NEW.id); "
                "SELECT RAISE(ABORT,'pending attribute'); END"_ns));
  nsTArray<PendingHeaderAttribute> attributes = {
      {"good"_ns, "new"_ns, Nothing()},
      {"keywords"_ns, "changed"_ns, Nothing()},
      {"fail"_ns, ""_ns, Nothing()}};
  EXPECT_EQ(
      NS_ERROR_STORAGE_CONSTRAINT,
      db.SetStagedHeaderAttributes(sourceId, {mFolderId, key, 53}, attributes));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(key, witness->mLastKey);
  EXPECT_EQ(0u, observer->mAdded);
  EXPECT_EQ(0u, observer->mChanged);
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "good"_ns, text));
  EXPECT_EQ("old"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageTags(key, text));
  EXPECT_EQ("original"_ns, text);
  bool active = true;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "DROP TRIGGER fail_pending_attr"_ns));
  ASSERT_EQ(NS_OK, db.SetStagedHeaderAttributes(sourceId, {mFolderId, key, 53},
                                                attributes));
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "good"_ns, text));
  EXPECT_EQ("new"_ns, text);
  EXPECT_EQ(0u, observer->mAdded);
  EXPECT_EQ(0u, observer->mChanged);
}

TEST_F(DeliveryCoreReferences,
       StagedAttributesRejectWrongIdentityAndUnfinishedStorage) {
  ASSERT_EQ(NS_OK, Start());
  nsCString sourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(sourceId));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 55));
  RawHdr raw;
  nsMsgKey staged, published;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &published));
  nsTArray<PendingHeaderAttribute> attributes{{"keep"_ns, ""_ns, Nothing()}};
  uint64_t other;
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolderId, "Other"_ns, &other));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(other, 55));
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      db.SetStagedHeaderAttributes(sourceId, {other, staged, 55}, attributes));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.SetStagedHeaderAttributes("replaced-database"_ns,
                                         {mFolderId, staged, 55}, attributes));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.SetStagedHeaderAttributes(sourceId, {mFolderId, staged, 56},
                                         attributes));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.SetStagedHeaderAttributes(sourceId, {mFolderId, published, 55},
                                         attributes));
  attributes = {{"flags"_ns, ""_ns, Some(uint64_t(UINT64_MAX))}};
  EXPECT_EQ(NS_ERROR_ILLEGAL_VALUE,
            db.SetStagedHeaderAttributes(sourceId, {mFolderId, staged, 55},
                                         attributes));
  attributes = {{"storeToken"_ns, "source-token"_ns, Nothing()}};
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.SetStagedHeaderAttributes(sourceId, {mFolderId, staged, 55},
                                         attributes));
  attributes = {{"uidOnServer"_ns, "2a"_ns, Nothing()}};
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.SetStagedHeaderAttributes(sourceId, {mFolderId, staged, 55},
                                         attributes));
  attributes = {{"offlineMsgSize"_ns, ""_ns, Some(uint64_t(UINT64_MAX))}};
  Maybe<FinishedMessageBody> finished =
      Some(FinishedMessageBody{"target"_ns, 10, 10, 1, true});
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.SetStagedHeaderAttributes(sourceId, {mFolderId, staged, 55},
                                         attributes, finished));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  ASSERT_EQ(NS_OK,
            db.SetMessageProperty(staged, "caller-control"_ns, "pending"_ns));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.SetStagedHeaderAttributes(sourceId, {mFolderId, staged, 55},
                                         attributes, finished));
  bool active = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  nsCString control;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(staged, "caller-control"_ns, control));
  EXPECT_EQ("pending"_ns, control);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(staged, names));
  EXPECT_FALSE(names.Contains("keep"_ns));
  EXPECT_FALSE(names.Contains("storeToken"_ns));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
}

TEST_F(DeliveryCoreReferences,
       StagedAttributesCannotChangeSentOrAmbiguousDestination) {
  ASSERT_EQ(NS_OK, Start());
  nsCString sourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(sourceId));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 57));
  nsMsgKey source, destination;
  ASSERT_EQ(NS_OK, Add("pending-source@invalid"_ns, {}, source));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(source, mFolderId, 57, 907));
  RawHdr raw;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &destination));
  OfflineOperationData op;
  op.operation = nsIMsgOfflineImapOperation::kMsgCopy;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, op));
  PendingDestination target{mFolderId, destination, 57};
  nsTArray<PendingHeaderAttribute> attributes{
      {"value"_ns, "before"_ns, Nothing()}};
  ASSERT_EQ(NS_OK, db.SetStagedHeaderAttributes(sourceId, target, attributes));
  uint64_t attempt = 0;
  ASSERT_EQ(NS_OK, db.BeginOfflineAttempt(mFolderId, source,
                                          nsIMsgOfflineImapOperation::kMsgCopy,
                                          Some(target), attempt));
  attributes[0].text = "after"_ns;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.SetStagedHeaderAttributes(sourceId, target, attributes));
  ASSERT_EQ(NS_OK, db.MarkOfflineAttemptAmbiguous(attempt));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.SetStagedHeaderAttributes(sourceId, target, attributes));
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(destination, "value"_ns, text));
  EXPECT_EQ("before"_ns, text);
}

TEST_F(DeliveryCoreReferences, NativeSizeSettersKeepUint32Boundaries) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey published, staged;
  ASSERT_EQ(NS_OK, Add("size-published@invalid"_ns, {}, published));
  RawHdr raw;
  raw.messageId = "size-staged@invalid"_ns;
  raw.references = {"first@invalid"_ns, "second@invalid"_ns,
                    "first@invalid"_ns};
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  for (nsMsgKey key : {published, staged}) {
    SCOPED_TRACE(key);
    for (uint64_t value : {uint64_t(0), uint64_t(1), uint64_t(0x80000000),
                           uint64_t(UINT32_MAX)}) {
      ASSERT_EQ(NS_OK, db.SetMessageSize(key, value));
      ASSERT_EQ(NS_OK, db.SetMessageOfflineMessageSize(key, value));
      uint64_t actual = 17;
      ASSERT_EQ(NS_OK, db.GetMessageSize(key, actual));
      EXPECT_EQ(value, actual);
      actual = 23;
      ASSERT_EQ(NS_OK, db.GetMessageOfflineMessageSize(key, actual));
      EXPECT_EQ(value, actual);
    }
    for (uint64_t overflow : {uint64_t(UINT32_MAX) + 1, UINT64_MAX}) {
      EXPECT_EQ(NS_ERROR_ILLEGAL_VALUE, db.SetMessageSize(key, overflow));
      uint64_t actual = 17;
      ASSERT_EQ(NS_OK, db.GetMessageSize(key, actual));
      EXPECT_EQ(uint64_t(UINT32_MAX), actual);
      EXPECT_EQ(NS_ERROR_ILLEGAL_VALUE,
                db.SetMessageOfflineMessageSize(key, overflow));
      actual = 23;
      ASSERT_EQ(NS_OK, db.GetMessageOfflineMessageSize(key, actual));
      EXPECT_EQ(uint64_t(UINT32_MAX), actual);
    }
  }
  ASSERT_EQ(NS_OK, db.PublishMessage(staged, false));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  for (nsMsgKey key : {published, staged}) {
    uint64_t actual = 17;
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageSize(key, actual));
    EXPECT_EQ(uint64_t(UINT32_MAX), actual);
    actual = 23;
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessageOfflineMessageSize(key, actual));
    EXPECT_EQ(uint64_t(UINT32_MAX), actual);
  }
  nsTArray<nsCString> references;
  ASSERT_EQ(NS_OK, Stored(staged, references));
  EXPECT_EQ((nsTArray<nsCString>{"first@invalid"_ns, "second@invalid"_ns,
                                 "first@invalid"_ns}),
            references);
}

TEST_F(DeliveryCoreReferences,
       NativeSizeOverflowKeepsCallerTransactionAndStoredValues) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("size-transaction@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, db.SetMessageSize(key, 23));
  ASSERT_EQ(NS_OK, db.SetMessageOfflineMessageSize(key, 17));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, Connection()->RollbackTransaction()); });
  ASSERT_EQ(NS_OK, db.SetMessageSize(key, 42));
  ASSERT_EQ(NS_OK, db.SetMessageOfflineMessageSize(key, 0x80000000));
  ASSERT_EQ(NS_OK,
            db.SetMessageProperty(key, "caller-control"_ns, "pending"_ns));
  EXPECT_EQ(NS_ERROR_ILLEGAL_VALUE, db.SetMessageSize(key, UINT64_MAX));
  EXPECT_EQ(NS_ERROR_ILLEGAL_VALUE,
            db.SetMessageOfflineMessageSize(key, uint64_t(UINT32_MAX) + 1));
  // Body getters require committed state; inspect the caller's SQL directly.
  {
    nsCOMPtr<mozIStorageStatement> pending;
    ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                         "SELECT value FROM message_properties WHERE id=:id "
                         "AND name IN('messageSize','offlineMessageSize') "
                         "ORDER BY name"_ns,
                         getter_AddRefs(pending)));
    ASSERT_EQ(NS_OK, pending->BindInt64ByName("id"_ns, key));
    bool more = false;
    ASSERT_EQ(NS_OK, pending->ExecuteStep(&more));
    ASSERT_TRUE(more);
    int64_t value = 0;
    ASSERT_EQ(NS_OK, pending->GetInt64(0, &value));
    EXPECT_EQ(int64_t(42), value);
    ASSERT_EQ(NS_OK, pending->ExecuteStep(&more));
    ASSERT_TRUE(more);
    ASSERT_EQ(NS_OK, pending->GetInt64(0, &value));
    EXPECT_EQ(int64_t(0x80000000), value);
    ASSERT_EQ(NS_OK, pending->ExecuteStep(&more));
    EXPECT_FALSE(more);
  }
  bool active = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  nsCString control;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "caller-control"_ns, control));
  EXPECT_EQ("pending"_ns, control);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  rollback.release();
  uint64_t actual = 0;
  ASSERT_EQ(NS_OK, db.GetMessageSize(key, actual));
  EXPECT_EQ(23u, actual);
  ASSERT_EQ(NS_OK, db.GetMessageOfflineMessageSize(key, actual));
  EXPECT_EQ(17u, actual);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(key, names));
  EXPECT_FALSE(names.Contains("caller-control"_ns));
}

TEST_F(DeliveryCoreReferences, NativeSizeSettersPropagateReachedWriteErrors) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey published, staged;
  ASSERT_EQ(NS_OK, Add("size-fault-published@invalid"_ns, {}, published));
  RawHdr raw;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  for (nsMsgKey key : {published, staged}) {
    ASSERT_EQ(NS_OK, db.SetMessageSize(key, 23));
    ASSERT_EQ(NS_OK, db.SetMessageOfflineMessageSize(key, 17));
  }
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK, Connection()->CreateFunction("size_fault"_ns, 1, witness));
  auto remove = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, Connection()->RemoveFunction("size_fault"_ns)); });
  for (const auto& table :
       {"message_properties", "staged_message_properties"}) {
    nsAutoCString sql("CREATE TEMP TRIGGER fail_size_");
    sql.Append(table);
    sql.AppendLiteral(" BEFORE INSERT ON ");
    sql.Append(table);
    sql.AppendLiteral(
        " WHEN NEW.name IN('messageSize','offlineMessageSize') "
        "BEGIN SELECT size_fault(NEW.id); "
        "SELECT RAISE(ABORT,'size write'); END");
    ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(sql));
  }
  for (nsMsgKey key : {published, staged}) {
    uint32_t before = witness->mCalls;
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, db.SetMessageSize(key, UINT32_MAX));
    EXPECT_EQ(before + 1, witness->mCalls);
    EXPECT_EQ(int64_t(key), witness->mLastKey);
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
              db.SetMessageOfflineMessageSize(key, UINT32_MAX));
    EXPECT_EQ(before + 2, witness->mCalls);
    EXPECT_EQ(int64_t(key), witness->mLastKey);
    uint64_t actual = 0;
    ASSERT_EQ(NS_OK, db.GetMessageSize(key, actual));
    EXPECT_EQ(23u, actual);
    actual = 0;
    ASSERT_EQ(NS_OK, db.GetMessageOfflineMessageSize(key, actual));
    EXPECT_EQ(17u, actual);
    bool active = true;
    ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
  }
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "DROP TRIGGER fail_size_message_properties"_ns));
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "DROP TRIGGER fail_size_staged_message_properties"_ns));
  ASSERT_EQ(NS_OK, db.SetMessageSize(published, UINT32_MAX));
  ASSERT_EQ(NS_OK, db.SetMessageOfflineMessageSize(staged, UINT32_MAX));
}

TEST_F(DeliveryCoreReferences, BodyStateRejectsOutOfRangeNativeQuantities) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  RawHdr raw;
  raw.messageId = "body-bounds@invalid"_ns;
  raw.storeToken = Some(nsCString("original-token"_ns));
  raw.messageSize = Some(0u);
  raw.offlineMessageSize = Some(0u);
  raw.lineCount = Some(0u);
  raw.references = {"first@invalid"_ns, "second@invalid"_ns,
                    "first@invalid"_ns};
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, false, &key));
  MessageBodyState sentinel;
  sentinel.databaseSourceId = "untouched-source"_ns;
  sentinel.key = 77;
  sentinel.folderId = 88;
  sentinel.storeToken = Some(nsCString("untouched-token"_ns));
  sentinel.contentRevision = 91;
  sentinel.locationRevision = 92;
  sentinel.messageSize = 93;
  sentinel.offlineMessageSize = 94;
  sentinel.lineCount = 95;
  sentinel.flags = 96;
  auto checkUnchanged = [&](const MessageBodyState& output) {
    EXPECT_EQ(sentinel.databaseSourceId, output.databaseSourceId);
    EXPECT_EQ(sentinel.key, output.key);
    EXPECT_EQ(sentinel.folderId, output.folderId);
    EXPECT_EQ(sentinel.storeToken, output.storeToken);
    EXPECT_EQ(sentinel.contentRevision, output.contentRevision);
    EXPECT_EQ(sentinel.locationRevision, output.locationRevision);
    EXPECT_EQ(sentinel.messageSize, output.messageSize);
    EXPECT_EQ(sentinel.offlineMessageSize, output.offlineMessageSize);
    EXPECT_EQ(sentinel.lineCount, output.lineCount);
    EXPECT_EQ(sentinel.flags, output.flags);
  };
  MessageBodyState expected;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  uint32_t callbacks = 0;
  RefPtr<BodyObserver> observer =
      new BodyObserver([&](nsIMsgDBHdr*, Message*, const MessageBodyState&,
                           const MessageBodyState&) { ++callbacks; });
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  FinishedMessageBody finished{"must-not-install"_ns, 3, 2, 1, false};
  for (const char* field :
       {"flags", "messageSize", "offlineMessageSize", "lineCount"}) {
    SCOPED_TRACE(field);
    bool flags = nsDependentCString(field).EqualsLiteral("flags");
    auto write = [&](int64_t value) -> nsresult {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(Connection()->CreateStatement(
          flags
              ? "UPDATE messages SET flags=:value WHERE id=:id"_ns
              : "UPDATE message_properties SET value=:value WHERE id=:id AND name=:name"_ns,
          getter_AddRefs(stmt)));
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
      MOZ_TRY(stmt->BindInt64ByName("value"_ns, value));
      if (!flags) {
        MOZ_TRY(
            stmt->BindUTF8StringByName("name"_ns, nsDependentCString(field)));
      }
      return stmt->Execute();
    };
    for (int64_t invalid : {flags ? int64_t(INT32_MIN) - 1 : int64_t(-1),
                            int64_t(UINT32_MAX) + 1, INT64_MAX}) {
      SCOPED_TRACE(invalid);
      ASSERT_EQ(NS_OK, write(invalid));
      MessageBodyState output = sentinel;
      EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, db.GetMessageBodyState(key, output));
      checkUnchanged(output);
      output = sentinel;
      EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
                db.SettleMessageBody(expected, finished, output));
      checkUnchanged(output);
      if (flags) {
        EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
                  db.RemoveMessageFromFolder(
                      key, mFolderId, expected.databaseSourceId,
                      MessageRemovalAccounting::LocalMessageSize));
      }
      EXPECT_EQ(0u, callbacks);
      bool active = true;
      ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
      EXPECT_FALSE(active);
      // The read must retain the corrupt physical row; it is not a repair.
      nsCOMPtr<mozIStorageStatement> retained;
      ASSERT_EQ(
          NS_OK,
          Connection()->CreateStatement(
              flags
                  ? "SELECT flags FROM messages WHERE id=:id"_ns
                  : "SELECT value FROM message_properties WHERE id=:id AND name=:name"_ns,
              getter_AddRefs(retained)));
      ASSERT_EQ(NS_OK, retained->BindInt64ByName("id"_ns, key));
      if (!flags) {
        ASSERT_EQ(NS_OK, retained->BindUTF8StringByName(
                             "name"_ns, nsDependentCString(field)));
      }
      bool more = false;
      ASSERT_EQ(NS_OK, retained->ExecuteStep(&more));
      ASSERT_TRUE(more);
      int64_t value = 0;
      ASSERT_EQ(NS_OK, retained->GetInt64(0, &value));
      EXPECT_EQ(invalid, value);
      ASSERT_EQ(NS_OK, retained->ExecuteStep(&more));
      EXPECT_FALSE(more);
      ASSERT_EQ(NS_OK, write(0));
      ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, output));
      EXPECT_EQ(key, output.key);
      EXPECT_EQ(0u, output.messageSize);
      EXPECT_EQ(0u, output.offlineMessageSize);
      EXPECT_EQ(0u, output.lineCount);
      EXPECT_EQ(0u, output.flags);
      EXPECT_EQ(raw.storeToken, output.storeToken);
    }
  }
  nsTArray<nsCString> references;
  ASSERT_EQ(NS_OK, Stored(key, references));
  EXPECT_EQ(raw.references, references);
}

TEST_F(DeliveryCoreReferences, BodyStateUint32BoundsAndAbsenceSurviveReopen) {
  ASSERT_EQ(NS_OK, Start());
  RawHdr maximum;
  maximum.messageId = "maximum-body-bounds@invalid"_ns;
  maximum.flags = UINT32_MAX;
  maximum.storeToken = Some(nsCString(""_ns));
  maximum.messageSize = Some(uint32_t(UINT32_MAX));
  maximum.offlineMessageSize = Some(uint32_t(UINT32_MAX));
  maximum.lineCount = Some(uint32_t(UINT32_MAX));
  RawHdr absent;
  absent.messageId = "absent-body-bounds@invalid"_ns;
  nsMsgKey high, signedHighBit, positiveHigh, missing;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().AddMessage(mFolderId, maximum, false, &high));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().AddMessage(mFolderId, absent, false, &missing));
  maximum.flags = 0x80000000u;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolderId, maximum, false,
                                                 &signedHighBit));
  maximum.flags = 0;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolderId, maximum, false,
                                                 &positiveHigh));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().SetMessageFlags(positiveHigh, UINT32_MAX));
  for (bool reopened : {false, true}) {
    SCOPED_TRACE(reopened);
    if (reopened) {
      Stop();
      ASSERT_EQ(NS_OK, Start());
    }
    MessageBodyState state;
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageBodyState(high, state));
    EXPECT_EQ(UINT32_MAX, state.flags);
    EXPECT_EQ(UINT32_MAX, state.messageSize);
    EXPECT_EQ(UINT32_MAX, state.offlineMessageSize);
    EXPECT_EQ(UINT32_MAX, state.lineCount);
    ASSERT_TRUE(state.storeToken);
    EXPECT_TRUE(state.storeToken->IsEmpty());
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessageBodyState(signedHighBit, state));
    EXPECT_EQ(0x80000000u, state.flags);
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessageBodyState(positiveHigh, state));
    EXPECT_EQ(UINT32_MAX, state.flags);
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageBodyState(missing, state));
    EXPECT_EQ(0u, state.flags);
    EXPECT_EQ(0u, state.messageSize);
    EXPECT_EQ(0u, state.offlineMessageSize);
    EXPECT_EQ(0u, state.lineCount);
    EXPECT_FALSE(state.storeToken);
  }
}

TEST_F(DeliveryCoreReferences, FolderRemovalAcceptsNativeSignedFlagWords) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  int64_t expectedBytes = 0;
  for (auto policy : {MessageRemovalAccounting::LocalMessageSize,
                      MessageRemovalAccounting::OfflineMessageSize}) {
    for (uint32_t flags : {0x80000000u, UINT32_MAX}) {
      SCOPED_TRACE(flags);
      RawHdr raw;
      raw.flags = flags;
      raw.messageSize = Some(17u);
      raw.offlineMessageSize = Some(13u);
      raw.storeToken = Some(nsCString("retained-body"_ns));
      nsMsgKey key;
      ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, false, &key));
      MessageBodyState captured;
      ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, captured));
      EXPECT_EQ(flags, captured.flags);
      ASSERT_EQ(NS_OK,
                db.RemoveMessageFromFolder(key, mFolderId, source, policy));
      bool exists = true;
      ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
      EXPECT_FALSE(exists);
      if (policy == MessageRemovalAccounting::LocalMessageSize) {
        expectedBytes += 17;
      } else if (flags & nsMsgMessageFlags::Offline) {
        expectedBytes += 13;
      }
      int64_t actualBytes = -1;
      ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, actualBytes));
      EXPECT_EQ(expectedBytes, actualBytes);
    }
  }
}

TEST_F(DeliveryCoreReferences, StructuralFieldsCommitBeforeHotStateAndReopen) {
  for (bool staged : {false, true}) {
    ASSERT_NO_FATAL_FAILURE(
        CheckStructuralFieldWrites(staged, StructuralFailure::None));
    Stop();
  }
}

TEST_F(DeliveryCoreReferences,
       StructuralFieldsKeepCallerTransactionAndHotState) {
  for (bool staged : {false, true}) {
    ASSERT_NO_FATAL_FAILURE(CheckStructuralFieldWrites(
        staged, StructuralFailure::CallerTransaction));
    Stop();
  }
}

TEST_F(DeliveryCoreReferences,
       StructuralFieldWriteFailuresKeepStoredAndHotFacts) {
  for (bool staged : {false, true}) {
    ASSERT_NO_FATAL_FAILURE(
        CheckStructuralFieldWrites(staged, StructuralFailure::Write));
    Stop();
  }
}

TEST_F(DeliveryCoreReferences,
       StructuralFieldCommitFailuresKeepStoredAndHotFacts) {
  for (bool staged : {false, true}) {
    ASSERT_NO_FATAL_FAILURE(
        CheckStructuralFieldWrites(staged, StructuralFailure::Commit));
    Stop();
  }
}

TEST_F(DeliveryCoreReferences, ConversationReadOrderedCrossFolder) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t a, b;
  ASSERT_EQ(NS_OK, MakeDiscoveryFolders(*mCore, a, b));
  auto& db = mCore->MessageDB();
  const nsCString subject("Ordered conversation");
  nsMsgKey root, reply, tail, unrelated;
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, a, "ordered-root@conversation.invalid"_ns,
                                {}, root, subject));
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, b, "ordered-reply@conversation.invalid"_ns,
                                {"ordered-root@conversation.invalid"_ns}, reply,
                                subject));
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, a, "ordered-tail@conversation.invalid"_ns,
                                {"ordered-root@conversation.invalid"_ns,
                                 "ordered-reply@conversation.invalid"_ns},
                                tail, subject));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, b, "ordered-unrelated@conversation.invalid"_ns, {},
                       unrelated, subject));
  for (nsMsgKey seed : {root, reply, tail}) {
    ExpectConversationRead(db, seed, {{root, a}, {reply, b}, {tail, a}});
  }
  ExpectConversationRead(db, unrelated, {{unrelated, b}});
  nsTArray<nsCString> stored;
  ASSERT_EQ(NS_OK, Stored(tail, stored));
  EXPECT_EQ((nsTArray<nsCString>{"ordered-root@conversation.invalid"_ns,
                                 "ordered-reply@conversation.invalid"_ns}),
            stored);
}

TEST_F(DeliveryCoreReferences, ConversationReadReplyBeforeParent) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t a, b;
  ASSERT_EQ(NS_OK, MakeDiscoveryFolders(*mCore, a, b));
  auto& db = mCore->MessageDB();
  const nsCString subject("Reply before parent");
  nsMsgKey unrelated, reply, parent;
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, a, "reply-first-unrelated@conversation.invalid"_ns,
                       {}, unrelated, subject));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, b, "reply-first-child@conversation.invalid"_ns,
                       {"reply-first-parent@conversation.invalid"_ns}, reply,
                       subject));
  ExpectConversationRead(db, reply, {{reply, b}});
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, a, "reply-first-parent@conversation.invalid"_ns, {},
                       parent, subject));
  for (nsMsgKey seed : {reply, parent}) {
    ExpectConversationRead(db, seed, {{reply, b}, {parent, a}});
  }
  ExpectConversationRead(db, unrelated, {{unrelated, a}});
}

TEST_F(DeliveryCoreReferences, ConversationReadSiblingsWithoutParent) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t a, b;
  ASSERT_EQ(NS_OK, MakeDiscoveryFolders(*mCore, a, b));
  auto& db = mCore->MessageDB();
  const nsCString subject("Siblings without parent");
  nsMsgKey unrelated, first, second;
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(
                db, a, "siblings-missing-unrelated@conversation.invalid"_ns, {},
                unrelated, subject));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, a, "siblings-missing-first@conversation.invalid"_ns,
                       {"siblings-missing-parent@conversation.invalid"_ns},
                       first, subject));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, b, "siblings-missing-second@conversation.invalid"_ns,
                       {"siblings-missing-parent@conversation.invalid"_ns},
                       second, subject));
  for (nsMsgKey seed : {first, second}) {
    ExpectConversationRead(db, seed, {{first, a}, {second, b}});
  }
  ExpectConversationRead(db, unrelated, {{unrelated, a}});
}

TEST_F(DeliveryCoreReferences, ConversationReadSiblingsThenParent) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t a, b;
  ASSERT_EQ(NS_OK, MakeDiscoveryFolders(*mCore, a, b));
  auto& db = mCore->MessageDB();
  const nsCString subject("Siblings then parent");
  nsMsgKey first, second, unrelated, parent;
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, a, "siblings-late-first@conversation.invalid"_ns,
                       {"siblings-late-parent@conversation.invalid"_ns}, first,
                       subject));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, b, "siblings-late-second@conversation.invalid"_ns,
                       {"siblings-late-parent@conversation.invalid"_ns}, second,
                       subject));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, b, "siblings-late-unrelated@conversation.invalid"_ns,
                       {}, unrelated, subject));
  // Exercise the late arrival independently of the missing-parent assertion.
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, a, "siblings-late-parent@conversation.invalid"_ns,
                       {}, parent, subject));
  for (nsMsgKey seed : {first, second, parent}) {
    ExpectConversationRead(db, seed, {{first, a}, {second, b}, {parent, a}});
  }
  ExpectConversationRead(db, unrelated, {{unrelated, b}});
}

TEST_F(DeliveryCoreReferences, ConversationReadWholeStoredComponent) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey root, child, incoming;
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, mFolderId, "root@invalid"_ns, {}, root));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(db, mFolderId, "child@invalid"_ns,
                                       {"root@invalid"_ns}, child));
  CapturedMessage rootRow, childRow;
  ASSERT_EQ(NS_OK, db.CaptureMessage(root, rootRow));
  ASSERT_EQ(NS_OK, db.CaptureMessage(child, childRow));
  ASSERT_NE(0u, rootRow.threadId);
  ASSERT_EQ(rootRow.threadId, childRow.threadId);
  ASSERT_EQ(NS_OK, db.SetMessageReferences(child, {}));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(db, mFolderId, "incoming@invalid"_ns,
                                       {"child@invalid"_ns}, incoming));
  ExpectConversationRead(
      db, incoming,
      {{root, mFolderId}, {child, mFolderId}, {incoming, mFolderId}});
}

TEST_F(DeliveryCoreReferences, ConversationReadKeepsEveryReferencedCopy) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  uint64_t other;
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolderId, "Other"_ns, &other));
  nsMsgKey first, reply, selected, unrelated;
  ASSERT_EQ(NS_OK, AddAt(mFolderId, "physical-root"_ns, {}, first));
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "physical-reply"_ns, {"physical-root"_ns}, reply));
  ASSERT_EQ(NS_OK, AddAt(other, "physical-root"_ns, {}, selected));
  ASSERT_EQ(NS_OK, AddAt(other, "unrelated"_ns, {}, unrelated));
  CapturedMessage firstBefore, selectedBefore;
  ASSERT_EQ(NS_OK, db.CaptureMessage(first, firstBefore));
  ASSERT_EQ(NS_OK, db.CaptureMessage(selected, selectedBefore));
  ASSERT_NE(firstBefore.threadId, selectedBefore.threadId);
  uint64_t before, after;
  ASSERT_EQ(NS_OK, SearchWatermark(before));
  const size_t cached = CachedHeaderCount();
  for (nsMsgKey seed : {first, reply, selected}) {
    nsTArray<nsMsgKey> output;
    ASSERT_EQ(NS_OK, db.GetConversationMessageKeys(seed, output));
    EXPECT_EQ((nsTArray<nsMsgKey>{first, reply, selected}), output);
  }
  EXPECT_EQ(cached, CachedHeaderCount());
  ASSERT_EQ(NS_OK, SearchWatermark(after));
  EXPECT_EQ(before, after);
  CapturedMessage firstAfter, selectedAfter;
  ASSERT_EQ(NS_OK, db.CaptureMessage(first, firstAfter));
  ASSERT_EQ(NS_OK, db.CaptureMessage(selected, selectedAfter));
  EXPECT_EQ(firstBefore.threadId, firstAfter.threadId);
  EXPECT_EQ(selectedBefore.threadId, selectedAfter.threadId);
  EXPECT_EQ(mFolderId, firstAfter.folderId);
  EXPECT_EQ(other, selectedAfter.folderId);
  ExpectConversationRead(db, unrelated, {{unrelated, other}});
}

TEST_F(DeliveryCoreReferences, ConversationReadTraversesLateAncestorChain) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey leaf, middle, root;
  ASSERT_EQ(NS_OK, Add("late-leaf"_ns, {"late-middle"_ns}, leaf));
  ASSERT_EQ(NS_OK, Add("late-middle"_ns, {"late-root"_ns}, middle));
  ASSERT_EQ(NS_OK, Add("late-root"_ns, {}, root));
  CapturedMessage leafRow, middleRow, rootRow;
  ASSERT_EQ(NS_OK, db.CaptureMessage(leaf, leafRow));
  ASSERT_EQ(NS_OK, db.CaptureMessage(middle, middleRow));
  ASSERT_EQ(NS_OK, db.CaptureMessage(root, rootRow));
  ASSERT_NE(leafRow.threadId, middleRow.threadId);
  ASSERT_NE(middleRow.threadId, rootRow.threadId);
  for (nsMsgKey seed : {leaf, middle, root}) {
    ExpectConversationRead(
        db, seed, {{leaf, mFolderId}, {middle, mFolderId}, {root, mFolderId}});
  }
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ExpectConversationRead(
      mCore->MessageDB(), root,
      {{leaf, mFolderId}, {middle, mFolderId}, {root, mFolderId}});
}

TEST_F(DeliveryCoreReferences, ConversationReadKeepsExactTokenEdges) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey first, copy, lower, child, emptyFirst, emptySecond;
  ASSERT_EQ(NS_OK, Add("Case"_ns, {}, first));
  ASSERT_EQ(NS_OK, Add("Case"_ns, {}, copy));
  ASSERT_EQ(NS_OK, Add("case"_ns, {}, lower));
  ExpectConversationRead(db, first, {{first, mFolderId}});
  ExpectConversationRead(db, copy, {{copy, mFolderId}});
  ASSERT_EQ(NS_OK, Add("exact-child"_ns, {"Case"_ns, "Case"_ns}, child));
  ExpectConversationRead(
      db, copy, {{first, mFolderId}, {copy, mFolderId}, {child, mFolderId}});
  ExpectConversationRead(db, lower, {{lower, mFolderId}});
  ASSERT_EQ(NS_OK, Add(""_ns, {}, emptyFirst));
  ASSERT_EQ(NS_OK, Add(""_ns, {}, emptySecond));
  CapturedMessage emptyA, emptyB;
  ASSERT_EQ(NS_OK, db.CaptureMessage(emptyFirst, emptyA));
  ASSERT_EQ(NS_OK, db.CaptureMessage(emptySecond, emptyB));
  ASSERT_NE(emptyA.threadId, emptyB.threadId);
  ASSERT_EQ(NS_OK, db.SetMessageReferences(emptyFirst, {""_ns}));
  ASSERT_EQ(NS_OK, db.SetMessageReferences(emptySecond, {""_ns}));
  ExpectConversationRead(db, emptyFirst, {{emptyFirst, mFolderId}});
  ExpectConversationRead(db, emptySecond, {{emptySecond, mFolderId}});
  nsTArray<nsCString> raw;
  ASSERT_EQ(NS_OK, Stored(emptyFirst, raw));
  EXPECT_EQ((nsTArray<nsCString>{""_ns}), raw);
  raw.Clear();
  ASSERT_EQ(NS_OK, Stored(child, raw));
  EXPECT_EQ((nsTArray<nsCString>{"Case"_ns, "Case"_ns}), raw);
  nsMsgKey spaced, trimmed, shared;
  ASSERT_EQ(NS_OK, Add("spaced"_ns, {" absent "_ns}, spaced));
  ASSERT_EQ(NS_OK, Add("trimmed"_ns, {"absent"_ns}, trimmed));
  ASSERT_EQ(NS_OK, Add("shared"_ns, {" absent "_ns}, shared));
  ExpectConversationRead(db, spaced,
                         {{spaced, mFolderId}, {shared, mFolderId}});
  ExpectConversationRead(db, trimmed, {{trimmed, mFolderId}});
}

TEST_F(DeliveryCoreReferences, ConversationReadRejectsIncompleteAndOwnedState) {
  ASSERT_EQ(NS_OK, Start());
  RefPtr<MessageDatabase> held = &mCore->MessageDB();
  auto& db = *held;
  nsMsgKey seed, control, staged;
  ASSERT_EQ(NS_OK, Add("reader-seed"_ns, {}, seed));
  ASSERT_EQ(NS_OK, Add("reader-control"_ns, {}, control));
  RawHdr raw;
  raw.messageId = "unpublished"_ns;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  const nsTArray<nsMsgKey> sentinel{nsMsgKey_None - 2, nsMsgKey_None - 1};
  nsTArray<nsMsgKey> output = sentinel.Clone();
  EXPECT_EQ(NS_ERROR_INVALID_ARG, db.GetConversationMessageKeys(0, output));
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.GetConversationMessageKeys(nsMsgKey_None, output));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetConversationMessageKeys(nsMsgKey_None - 3, output));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetConversationMessageKeys(staged, output));
  EXPECT_EQ(sentinel, output);
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  ASSERT_EQ(NS_OK, db.SetMessageProperty(control, "caller"_ns, "pending"_ns));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.GetConversationMessageKeys(seed, output));
  EXPECT_EQ(sentinel, output);
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  nsCString pending;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(control, "caller"_ns, pending));
  EXPECT_EQ("pending"_ns, pending);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  // A removed known-history marker models unavailable native history, not a
  // fabricated legacy fixture or an empty References list.
  nsCOMPtr<mozIStorageStatement> remove;
  ASSERT_EQ(NS_OK, mConnection->CreateStatement(
                       "DELETE FROM message_reference_sets WHERE id=:id"_ns,
                       getter_AddRefs(remove)));
  ASSERT_EQ(NS_OK, remove->BindInt64ByName("id"_ns, control));
  ASSERT_EQ(NS_OK, remove->Execute());
  remove = nullptr;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetConversationMessageKeys(seed, output));
  EXPECT_EQ(sentinel, output);
  ASSERT_EQ(NS_OK, db.SetMessageReferences(control, {}));
  RefPtr<CaptureReadAbort> fault = new CaptureReadAbort();
  nsCOMPtr<mozIStorageProgressHandler> previous;
  ASSERT_EQ(NS_OK, mConnection->SetProgressHandler(1, fault,
                                                   getter_AddRefs(previous)));
  EXPECT_FALSE(previous);
  EXPECT_EQ(NS_ERROR_ABORT, db.GetConversationMessageKeys(seed, output));
  EXPECT_GT(fault->mCalls, 0u);
  EXPECT_EQ(1u, fault->mAborts);
  EXPECT_EQ(sentinel, output);
  nsCOMPtr<mozIStorageProgressHandler> removed;
  ASSERT_EQ(NS_OK, mConnection->RemoveProgressHandler(getter_AddRefs(removed)));
  EXPECT_EQ(fault.get(), removed.get());
  ASSERT_EQ(NS_OK, db.GetConversationMessageKeys(seed, output));
  EXPECT_EQ((nsTArray<nsMsgKey>{seed}), output);
  uint64_t other;
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolderId, "Retired"_ns, &other));
  nsMsgKey child;
  ASSERT_EQ(NS_OK, AddAt(other, "retired-child"_ns, {"reader-seed"_ns}, child));
  ASSERT_EQ(NS_OK, mCore->FolderDB().DeleteFolder(other));
  output = sentinel.Clone();
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetConversationMessageKeys(seed, output));
  EXPECT_EQ(sentinel, output);
  bool exists = false;
  ASSERT_EQ(NS_OK, db.MessageExists(child, exists));
  EXPECT_TRUE(exists);
  Stop();
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            held->GetConversationMessageKeys(seed, output));
  EXPECT_EQ(sentinel, output);
  EXPECT_FALSE(Connection());
}

TEST_F(DeliveryCoreReferences, StagedChangesPreserveCallerTransactionAndCache) {
  ASSERT_EQ(NS_OK, Start());
  RawHdr raw;
  raw.messageId = "staged-caller"_ns;
  raw.flags = nsMsgMessageFlags::Marked;
  raw.keywords = "before"_ns;
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, mCore->MessageDB().StageMessage(mFolderId, raw, &key));
  ASSERT_EQ(NS_OK, Add("staged-caller-control"_ns, {}, control));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_FALSE(HeaderIsCached(key));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto cleanup = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    if (active) EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, db.SetMessageProperty(control, "caller"_ns, "pending"_ns));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.SetMessageFlags(key, nsMsgMessageFlags::Read));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.SetMessageFlag(key, nsMsgMessageFlags::Read, true));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.SetMessageTags(key, "changed"_ns));
  EXPECT_FALSE(HeaderIsCached(key));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(control, "caller"_ns, text));
  EXPECT_EQ("pending"_ns, text);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  uint32_t flags = 0;
  ASSERT_EQ(NS_OK, db.GetMessageFlags(key, flags));
  ASSERT_EQ(NS_OK, db.GetMessageTags(key, text));
  EXPECT_EQ(raw.flags, flags);
  EXPECT_EQ(raw.keywords, text);
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.SetMessageFlags(key, UINT32_MAX));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.SetMessageTags(key, "changed"_ns));
  ASSERT_EQ(NS_OK, db.GetMessageFlags(key, flags));
  ASSERT_EQ(NS_OK, db.GetMessageTags(key, text));
  EXPECT_EQ(raw.flags, flags);
  EXPECT_EQ(raw.keywords, text);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_EQ(NS_OK, db.SetMessageFlags(key, UINT32_MAX));
  ASSERT_EQ(NS_OK, db.SetMessageTags(key, "  Exact TAG 00042  "_ns));
  bool published = true;
  ASSERT_EQ(NS_OK, db.MessageExists(key, published));
  EXPECT_FALSE(published);
  cleanup.release();
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageFlags(key, flags));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageTags(key, text));
  EXPECT_EQ(UINT32_MAX, flags);
  EXPECT_EQ("  Exact TAG 00042  "_ns, text);
  uint64_t folder = 0;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageFolderId(key, folder));
  EXPECT_EQ(mFolderId, folder);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessageProperty(control, "caller"_ns, text));
  EXPECT_TRUE(text.IsEmpty());
}

TEST_F(DeliveryCoreReferences, StagedChangeFailuresKeepSqlAndHotFacts) {
  for (bool tags : {false, true}) {
    for (bool commitFailure : {false, true}) {
      ASSERT_NO_FATAL_FAILURE(CheckStagedChangeFailure(tags, commitFailure));
      Stop();
    }
  }
}

TEST_F(DeliveryCoreReferences, FlagAndTagChangesDoNotOpenStoppedOrOldOwner) {
  ASSERT_EQ(NS_OK, Start());
  RefPtr<MessageDatabase> held = &mCore->MessageDB();
  RawHdr raw;
  raw.messageId = "staged-owner"_ns;
  raw.flags = nsMsgMessageFlags::Marked;
  raw.keywords = "retained"_ns;
  nsMsgKey staged, published;
  ASSERT_EQ(NS_OK, held->StageMessage(mFolderId, raw, &staged));
  ASSERT_EQ(NS_OK, Add("published-owner"_ns, {}, published));
  Stop();
  for (nsMsgKey key : {staged, published}) {
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, held->SetMessageFlags(key, UINT32_MAX));
    EXPECT_FALSE(Connection());
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              held->SetMessageFlag(key, nsMsgMessageFlags::Read, true));
    EXPECT_FALSE(Connection());
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, held->SetMessageTags(key, "rejected"_ns));
    EXPECT_FALSE(Connection());
  }
  ASSERT_EQ(NS_OK, Start());
  for (nsMsgKey key : {staged, published}) {
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, held->SetMessageFlags(key, UINT32_MAX));
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              held->SetMessageFlag(key, nsMsgMessageFlags::Read, true));
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, held->SetMessageTags(key, "rejected"_ns));
  }
  uint32_t flags = 0;
  nsCString text;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageFlags(staged, flags));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageTags(staged, text));
  EXPECT_EQ(raw.flags, flags);
  EXPECT_EQ(raw.keywords, text);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageFlags(published, flags));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageTags(published, text));
  EXPECT_EQ(0u, flags);
  EXPECT_TRUE(text.IsEmpty());
}

TEST_F(DeliveryCoreReferences,
       StoppedNativeWritersCannotReopenOrJoinReplacementCore) {
  ASSERT_EQ(NS_OK, Start());
  RefPtr<MessageDatabase> heldMessages = &mCore->MessageDB();
  RefPtr<FolderDatabase> heldFolders = &mCore->FolderDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK,
            Add("lifetime-control"_ns, {"raw"_ns, ""_ns, "raw"_ns}, key));
  ASSERT_EQ(NS_OK,
            heldMessages->SetMessageProperty(key, "Exact"_ns, "00042"_ns));
  RawHdr raw;
  raw.messageId = "retained-staged"_ns;
  nsMsgKey staged;
  ASSERT_EQ(NS_OK, heldMessages->StageMessage(mFolderId, raw, &staged));
  ASSERT_EQ(NS_OK, WriteFolderProperty(heldFolders, mFolderId, "Exact"_ns,
                                       "00042"_ns));
  ASSERT_EQ(NS_OK, WriteFolderProperty(heldFolders, mFolderId, "number"_ns,
                                       INT64_MAX));
  ASSERT_EQ(NS_OK, heldFolders->SetFolderUidValidity(mFolderId, 42));
  nsTArray<uint64_t> members{mFolderId};
  ASSERT_EQ(NS_OK, WriteVirtualFolders(heldFolders, mFolderId, members));
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  Stop();

  auto rejectRetired = [&] {
    nsCString text = "unchanged"_ns;
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              heldMessages->GetMessageProperty(key, "Exact"_ns, text));
    EXPECT_EQ("unchanged"_ns, text);
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              ReadFolderProperty(heldFolders, mFolderId, "Exact"_ns, text));
    EXPECT_EQ("unchanged"_ns, text);
    nsMsgKey output = nsMsgKey_None;
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              heldMessages->AddMessage(mFolderId, raw, false, &output));
    EXPECT_EQ(nsMsgKey_None, output);
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              heldMessages->SetMessageProperty(key, "Exact"_ns, "rejected"_ns));
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              heldMessages->SetMessageProperty(key, "Exact"_ns, uint32_t(99)));
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, heldMessages->AbortMessage(staged));
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              heldMessages->PublishMessage(staged, false));
    EXPECT_EQ(
        NS_ERROR_NOT_AVAILABLE,
        WriteFolderProperty(heldFolders, mFolderId, "Exact"_ns, "bad"_ns));
    EXPECT_EQ(
        NS_ERROR_NOT_AVAILABLE,
        WriteFolderProperty(heldFolders, mFolderId, "number"_ns, int64_t(99)));
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              heldFolders->SetFolderUidValidity(mFolderId, 99));
    nsTArray<uint64_t> empty;
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              WriteVirtualFolders(heldFolders, mFolderId, empty));
  };
  ASSERT_NO_FATAL_FAILURE(rejectRetired());
  EXPECT_FALSE(Connection());
  ASSERT_EQ(NS_OK, Start());
  auto* current = Connection();
  ASSERT_NO_FATAL_FAILURE(rejectRetired());
  EXPECT_EQ(current, Connection());

  // Current raw property calls still participate in a caller-owned transaction.
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(key, "Exact"_ns,
                                                         "caller"_ns));
  ASSERT_EQ(NS_OK, WriteFolderProperty(&mCore->FolderDB(), mFolderId,
                                       "Exact"_ns, "caller"_ns));
  ASSERT_NO_FATAL_FAILURE(rejectRetired());
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());

  nsCString text;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(text));
  EXPECT_EQ(source, text);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessageProperty(key, "Exact"_ns, text));
  EXPECT_EQ("00042"_ns, text);
  ASSERT_EQ(NS_OK, ReadFolderProperty(&mCore->FolderDB(), mFolderId, "Exact"_ns,
                                      text));
  EXPECT_EQ("00042"_ns, text);
  int64_t number = 0;
  ASSERT_EQ(NS_OK, ReadFolderProperty(&mCore->FolderDB(), mFolderId,
                                      "number"_ns, number));
  EXPECT_EQ(INT64_MAX, number);
  uint32_t epoch = 0;
  ASSERT_EQ(NS_OK, mCore->FolderDB().GetFolderUidValidity(mFolderId, epoch));
  EXPECT_EQ(42U, epoch);
  nsTArray<uint64_t> actualMembers;
  ASSERT_EQ(NS_OK,
            ReadVirtualFolders(&mCore->FolderDB(), mFolderId, actualMembers));
  EXPECT_EQ(members, actualMembers);
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, mCore->MessageDB().ListStagedMessages(mFolderId, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{staged}), keys);
  nsTArray<nsCString> refs;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(key, refs));
  EXPECT_EQ((nsTArray<nsCString>{"raw"_ns, ""_ns, "raw"_ns}), refs);
}

TEST_F(DeliveryCoreReferences, MarkAllReadPublishesCommittedFlagsInQueueOrder) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  uint64_t otherFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "Bystander"_ns,
                                                  &otherFolder));
  RefPtr<PerFolderDatabase> facade = WeakFolderDatabase(mFolderId);
  RefPtr<PerFolderDatabase> other = WeakFolderDatabase(otherFolder);
  RawHdr raw;
  raw.messageId = "bulk-captured-first"_ns;
  raw.flags = 0x80000000u | nsMsgMessageFlags::New | nsMsgMessageFlags::Marked;
  raw.references = {"raw-first"_ns, "raw-second"_ns, "raw-first"_ns};
  nsMsgKey first, second, read, staged, foreign;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &first));
  ASSERT_EQ(NS_OK, Add("bulk-captured-second"_ns, {}, second));
  ASSERT_EQ(NS_OK, db.SetMessageProperty(first, "Exact"_ns, "00042"_ns));
  RawHdr readRaw;
  readRaw.messageId = "bulk-already-read"_ns;
  readRaw.flags = nsMsgMessageFlags::Read;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, readRaw, true, &read));
  RawHdr stagedRaw;
  stagedRaw.messageId = "bulk-staged"_ns;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, stagedRaw, &staged));
  ASSERT_EQ(NS_OK, AddAt(otherFolder, "bulk-foreign"_ns, {}, foreign));
  uint32_t flags;
  ASSERT_EQ(NS_OK, db.GetMessageFlags(first, flags));
  ASSERT_EQ(NS_OK, db.GetMessageFlags(second, flags));
  nsTArray<nsMsgKey> marked{nsMsgKey_None - 1};
  nsTArray<nsCString> events;
  RefPtr<ThreadQueueObserver> before = new ThreadQueueObserver();
  RefPtr<ThreadQueueObserver> after = new ThreadQueueObserver();
  auto observe = [&](char recipient, char kind, const CapturedMessage& old,
                     const CapturedMessage& now, Message* live, bool) {
    nsAutoCString event;
    event.Append(recipient);
    event.Append(kind);
    event.AppendInt(now.id);
    events.AppendElement(event);
    EXPECT_EQ(now.id, live->Key());
    bool active = true;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    EXPECT_EQ((nsTArray<nsMsgKey>{first, second}), marked);
    for (nsMsgKey key : {first, second}) {
      uint32_t current;
      ASSERT_EQ(NS_OK, db.GetMessageFlags(key, current));
      EXPECT_TRUE(current & nsMsgMessageFlags::Read);
    }
    uint64_t unread;
    ASSERT_EQ(NS_OK, FolderUnreadCount(mFolderId, unread));
    EXPECT_EQ(0u, unread);
    if (kind == 'F') {
      EXPECT_EQ(mFolderId, old.folderId);
      EXPECT_EQ(old.id, now.id);
      EXPECT_FALSE(old.flags & nsMsgMessageFlags::Read);
      EXPECT_EQ(old.flags | nsMsgMessageFlags::Read, now.flags);
      EXPECT_TRUE(old.tags.IsEmpty());
      EXPECT_TRUE(now.tags.IsEmpty());  // Captured before reentrant tag edit.
      if (recipient == 'A' && now.id == first) {
        ASSERT_EQ(NS_OK, db.SetMessageTags(second, "nested exact tags"_ns));
      }
    } else {
      EXPECT_EQ('G', kind);
      EXPECT_EQ(second, now.id);
      EXPECT_TRUE(old.tags.IsEmpty());
      EXPECT_EQ("nested exact tags"_ns, now.tags);
    }
  };
  before->action = [&](char kind, const CapturedMessage& old,
                       const CapturedMessage& now, Message* live, bool notify) {
    observe('A', kind, old, now, live, notify);
  };
  after->action = [&](char kind, const CapturedMessage& old,
                      const CapturedMessage& now, Message* live, bool notify) {
    observe('B', kind, old, now, live, notify);
  };
  db.AddMessageListener(before);
  db.AddMessageListener(after);
  auto unwatch = MakeScopeExit([&] {
    db.RemoveMessageListener(before);
    db.RemoveMessageListener(after);
  });
  ASSERT_EQ(NS_OK, MarkFolderRead(mFolderId, marked));
  nsTArray<nsCString> expected;
  auto expectEvent = [&](const nsACString& prefix, nsMsgKey key) {
    nsAutoCString event(prefix);
    event.AppendInt(key);
    expected.AppendElement(event);
  };
  expectEvent("AF"_ns, first);
  expectEvent("BF"_ns, first);
  expectEvent("AF"_ns, second);
  expectEvent("BF"_ns, second);
  expectEvent("AG"_ns, second);
  expectEvent("BG"_ns, second);
  EXPECT_EQ(expected, events);
  EXPECT_EQ(0u, before->ordinary);
  EXPECT_EQ(0u, after->ordinary);
  nsTArray<nsMsgKey> newKeys;
  ASSERT_EQ(NS_OK, facade->GetNewList(newKeys));
  EXPECT_TRUE(newKeys.IsEmpty());
  ASSERT_EQ(NS_OK, other->GetNewList(newKeys));
  EXPECT_EQ((nsTArray<nsMsgKey>{foreign}), newKeys);
  ASSERT_EQ(NS_OK, db.GetMessageFlags(first, flags));
  EXPECT_EQ(raw.flags | nsMsgMessageFlags::Read, flags);
  ASSERT_EQ(NS_OK, db.GetMessageFlags(staged, flags));
  EXPECT_EQ(0u, flags);
  ASSERT_EQ(NS_OK, db.GetMessageFlags(foreign, flags));
  EXPECT_EQ(0u, flags);
  nsTArray<nsCString> refs;
  ASSERT_EQ(NS_OK, db.GetMessageReferences(first, refs));
  EXPECT_EQ(raw.references, refs);
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(first, "Exact"_ns, text));
  EXPECT_EQ("00042"_ns, text);
  ASSERT_EQ(NS_OK, MarkFolderRead(mFolderId, marked));
  EXPECT_TRUE(marked.IsEmpty());
  EXPECT_EQ(expected, events);
}

TEST_F(DeliveryCoreReferences, MarkAllReadFailuresDoNotPublishOrClearNewLists) {
  for (bool commitFailure : {false, true}) {
    ASSERT_NO_FATAL_FAILURE(CheckBulkReadNotificationFailure(commitFailure));
    Stop();
  }
}

TEST_F(DeliveryCoreReferences, FolderCacheMissAcrossTrimKeepsPhysicalIdentity) {
  ASSERT_EQ(NS_OK, Start());
  nsTArray<uint64_t> ids;
  nsTArray<nsCString> names;
  constexpr uint32_t boundary = 512;
  for (uint32_t i = 0; i <= boundary; ++i) {
    nsAutoCString name("Folder % / ");
    name.AppendInt(i);
    name.AppendLiteral(" \xC3\xA9");
    uint64_t id;
    ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, name, &id));
    ids.AppendElement(id);
    names.AppendElement(name);
  }
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  // No hierarchy read has warmed the new core. Warm exactly 512 names, then
  // load the next physical row through the real trim-and-insert boundary.
  for (uint32_t i = 0; i < boundary; ++i) {
    nsCString name;
    ASSERT_EQ(NS_OK, folders.GetFolderName(ids[i], name));
    EXPECT_EQ(names[i], name);
  }
  nsCString name;
  ASSERT_EQ(NS_OK, folders.GetFolderName(ids.LastElement(), name));
  EXPECT_EQ(names.LastElement(), name);
  // Reloading all rows also reaches the arbitrarily evicted entries. Names,
  // parent identity, ordinal absence and reversible paths must remain exact.
  for (uint32_t pass = 0; pass < 2; ++pass) {
    for (uint32_t i = 0; i <= boundary; ++i) {
      ASSERT_EQ(NS_OK, folders.GetFolderName(ids[i], name));
      EXPECT_EQ(names[i], name);
      auto parent = folders.GetFolderParent(ids[i]);
      ASSERT_TRUE(parent.isOk());
      EXPECT_EQ(mFolderId, parent.unwrap());
      auto ordinal = folders.GetFolderOrdinal(ids[i]);
      ASSERT_TRUE(ordinal.isOk());
      EXPECT_TRUE(ordinal.unwrap().isNothing());
      nsCString path;
      ASSERT_EQ(NS_OK, folders.GetFolderPath(ids[i], path));
      uint64_t resolved = 0;
      ASSERT_EQ(NS_OK, folders.GetFolderByPath(path, &resolved));
      EXPECT_EQ(ids[i], resolved);
    }
  }
}

TEST_F(DeliveryCoreReferences,
       HierarchyUpdatesRollbackAfterWriteAndCommitFaults) {
  for (uint32_t operation : {0u, 1u, 2u}) {
    for (bool commitFailure : {false, true}) {
      ASSERT_NO_FATAL_FAILURE(
          CheckHierarchyUpdateSettlement(operation, commitFailure));
      Stop();
    }
  }
}

TEST_F(DeliveryCoreReferences,
       FolderHierarchyCyclesKeepOutputsAndPhysicalRows) {
  ASSERT_EQ(NS_OK, Start());
  auto& initial = mCore->FolderDB();
  uint64_t a, b, leaf, self, control, root;
  ASSERT_EQ(NS_OK, initial.GetFolderRoot(mFolderId, &root));
  ASSERT_EQ(NS_OK, initial.InsertFolder(mFolderId, "Alpha"_ns, &a));
  ASSERT_EQ(NS_OK, initial.InsertFolder(a, "Beta"_ns, &b));
  ASSERT_EQ(NS_OK, initial.InsertFolder(b, "Leaf"_ns, &leaf));
  ASSERT_EQ(NS_OK, initial.InsertFolder(mFolderId, "Self"_ns, &self));
  ASSERT_EQ(NS_OK, initial.InsertFolder(mFolderId, "Control"_ns, &control));
  nsMsgKey key;
  const nsTArray<nsCString> references{"one"_ns, "two"_ns, "one"_ns};
  ASSERT_EQ(NS_OK, AddAt(b, "retained-cycle-row"_ns, references, key));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().SetMessageProperty(key, "Exact"_ns, "00042"_ns));
  Stop();
  {
    // Corrupt only parent links in a genuine native database after shutdown.
    // This is a storage-fault control, not a fabricated legacy artifact.
    nsCOMPtr<mozIStorageConnection> writer;
    ASSERT_EQ(NS_OK, Open(getter_AddRefs(writer)));
    nsCOMPtr<mozIStorageStatement> stmt;
    auto close = MakeScopeExit([&] {
      if (stmt) EXPECT_EQ(NS_OK, stmt->Finalize());
      EXPECT_EQ(NS_OK, writer->Close());
    });
    ASSERT_EQ(NS_OK, writer->CreateStatement(
                         "UPDATE folders SET parent=:parent WHERE id=:id"_ns,
                         getter_AddRefs(stmt)));
    for (const auto& change : {std::pair{a, b}, std::pair{self, self}}) {
      mozStorageStatementScoper scope(stmt);
      ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, change.first));
      ASSERT_EQ(NS_OK, stmt->BindInt64ByName("parent"_ns, change.second));
      ASSERT_EQ(NS_OK, stmt->Execute());
    }
  }
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t watermark;
  ASSERT_EQ(NS_OK, SearchWatermark(watermark));
  for (uint64_t id : {a, b, leaf, self}) {
    uint64_t value = UINT64_MAX;
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, folders.GetFolderRoot(id, &value));
    EXPECT_EQ(UINT64_MAX, value);
    nsCString path("unchanged path");
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, folders.GetFolderPath(id, path));
    EXPECT_EQ("unchanged path"_ns, path);
    nsTArray<uint64_t> ancestors{UINT64_MAX};
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
              folders.GetFolderAncestors(id, ancestors));
    EXPECT_EQ((nsTArray<uint64_t>{UINT64_MAX}), ancestors);
    bool descendant = true;
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
              folders.GetFolderIsDescendantOf(id, mFolderId, &descendant));
    EXPECT_TRUE(descendant);
    bool ancestor = true;
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
              folders.GetFolderIsAncestorOf(mFolderId, id, &ancestor));
    EXPECT_TRUE(ancestor);
    nsCOMPtr<nsIMsgFolder> facade;
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
              folders.GetMsgFolderForFolder(id, getter_AddRefs(facade)));
    EXPECT_FALSE(facade);
  }
  for (uint64_t id : {a, b, self}) {
    nsTArray<uint64_t> descendants{UINT64_MAX};
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
              folders.GetFolderDescendants(id, descendants));
    EXPECT_EQ((nsTArray<uint64_t>{UINT64_MAX}), descendants);
  }
  // The leaf has no descendants even though its ancestry is corrupt.
  nsTArray<uint64_t> descendants{UINT64_MAX};
  ASSERT_EQ(NS_OK, folders.GetFolderDescendants(leaf, descendants));
  EXPECT_TRUE(descendants.IsEmpty());
  uint64_t value = 0;
  ASSERT_EQ(NS_OK, folders.GetFolderRoot(control, &value));
  EXPECT_EQ(root, value);
  nsCString path;
  ASSERT_EQ(NS_OK, folders.GetFolderPath(control, path));
  EXPECT_EQ("delivery-references/Inbox/Control"_ns, path);
  ASSERT_EQ(NS_OK, folders.GetFolderDescendants(mFolderId, descendants));
  EXPECT_EQ((nsTArray<uint64_t>{control}), descendants);
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, folders.MoveFolderTo(control, leaf));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(a, b, "Alpha"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(b, a, "Beta"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(leaf, b, "Leaf"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(self, self, "Self"_ns));
  bool exists = false;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageFolderId(key, value));
  EXPECT_EQ(b, value);
  nsCString text;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessageProperty(key, "Exact"_ns, text));
  EXPECT_EQ("00042"_ns, text);
  nsTArray<nsCString> refs;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(key, refs));
  EXPECT_EQ(references, refs);
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    if (active) EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(key, "caller"_ns,
                                                         "pending"_ns));
  nsTArray<uint64_t> ancestors{UINT64_MAX};
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, folders.GetFolderAncestors(b, ancestors));
  EXPECT_EQ((nsTArray<uint64_t>{UINT64_MAX}), ancestors);
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessageProperty(key, "caller"_ns, text));
  EXPECT_EQ("pending"_ns, text);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  uint64_t after;
  ASSERT_EQ(NS_OK, SearchWatermark(after));
  EXPECT_EQ(watermark, after);
}

TEST_F(DeliveryCoreReferences,
       FolderSortReadErrorsPreserveOutputAndCallerState) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t parent, a, b, singleParent, single;
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Sort parent"_ns, &parent));
  ASSERT_EQ(NS_OK, folders.InsertFolder(parent, "Alpha"_ns, &a));
  ASSERT_EQ(NS_OK, folders.InsertFolder(parent, "Beta"_ns, &b));
  ASSERT_EQ(NS_OK, folders.UpdateFlags(a, nsMsgFolderFlags::Trash));
  ASSERT_EQ(NS_OK, folders.UpdateFlags(b, nsMsgFolderFlags::Inbox));
  ASSERT_EQ(NS_OK,
            folders.InsertFolder(mFolderId, "One child"_ns, &singleParent));
  ASSERT_EQ(NS_OK, folders.InsertFolder(singleParent, "Only"_ns, &single));
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("sort-control"_ns, {"one"_ns, "one"_ns}, control));
  uint64_t watermark;
  ASSERT_EQ(NS_OK, SearchWatermark(watermark));
  RefPtr<FaultWitness> witness = new FaultWitness();
  witness->mFailure = NS_ERROR_ABORT;
  ASSERT_EQ(NS_OK, mConnection->CreateFunction("unreadable_folder_flag"_ns, 1,
                                               witness));
  // The real id/parent/name/ordinal columns remain readable. Only evaluating
  // the flags column invokes the failing mozStorage function. No main row is
  // changed, so this reaches the actual sorting-key read, not a prior failure.
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP VIEW folders AS SELECT id,parent,ordinal,"
          "name,unreadable_folder_flag(id) AS flags FROM main.folders"_ns));
  auto cleanup = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.folders"_ns));
    EXPECT_EQ(NS_OK, mConnection->RemoveFunction("unreadable_folder_flag"_ns));
  });
  auto flags = folders.GetFolderFlags(a);
  ASSERT_TRUE(flags.isErr());
  nsresult original = flags.unwrapErr();
  EXPECT_TRUE(NS_FAILED(original));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(int64_t(a), witness->mLastKey);
  witness->mCalls = 0;
  nsTArray<uint64_t> children{UINT64_MAX};
  EXPECT_EQ(original, folders.GetFolderChildren(parent, children));
  EXPECT_EQ((nsTArray<uint64_t>{UINT64_MAX}), children);
  EXPECT_GT(witness->mCalls, 0u);
  EXPECT_TRUE(witness->mLastKey == int64_t(a) ||
              witness->mLastKey == int64_t(b));
  witness->mCalls = 0;
  EXPECT_EQ(original, folders.MoveFolderWithin(parent, a, 0));
  EXPECT_GT(witness->mCalls, 0u);
  auto ordinalA = folders.GetFolderOrdinal(a);
  auto ordinalB = folders.GetFolderOrdinal(b);
  ASSERT_TRUE(ordinalA.isOk());
  ASSERT_TRUE(ordinalB.isOk());
  EXPECT_FALSE(ordinalA.unwrap());
  EXPECT_FALSE(ordinalB.unwrap());
  // Preserve the existing no-comparison behavior for empty and single lists.
  witness->mCalls = 0;
  ASSERT_EQ(NS_OK, folders.GetFolderChildren(single, children));
  EXPECT_TRUE(children.IsEmpty());
  ASSERT_EQ(NS_OK, folders.GetFolderChildren(singleParent, children));
  EXPECT_EQ((nsTArray<uint64_t>{single}), children);
  EXPECT_EQ(0u, witness->mCalls);
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    if (active) EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(control, "caller"_ns,
                                                         "pending"_ns));
  children = {UINT64_MAX};
  EXPECT_EQ(original, folders.GetFolderChildren(parent, children));
  EXPECT_EQ((nsTArray<uint64_t>{UINT64_MAX}), children);
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  nsCString text;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessageProperty(control, "caller"_ns, text));
  EXPECT_EQ("pending"_ns, text);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL("DROP VIEW temp.folders"_ns));
  ASSERT_EQ(NS_OK, mConnection->RemoveFunction("unreadable_folder_flag"_ns));
  cleanup.release();
  ASSERT_EQ(NS_OK, folders.GetFolderChildren(parent, children));
  EXPECT_EQ((nsTArray<uint64_t>{b, a}), children);
  uint64_t after;
  ASSERT_EQ(NS_OK, SearchWatermark(after));
  EXPECT_EQ(watermark, after);
  // Every call must read current flags even when folder metadata is hot.
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  ASSERT_EQ(NS_OK, folders.UpdateFlags(a, nsMsgFolderFlags::Inbox));
  ASSERT_EQ(NS_OK, folders.UpdateFlags(b, nsMsgFolderFlags::Trash));
  ASSERT_EQ(NS_OK, folders.GetFolderChildren(parent, children));
  EXPECT_EQ((nsTArray<uint64_t>{a, b}), children);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_EQ(NS_OK, folders.GetFolderChildren(parent, children));
  EXPECT_EQ((nsTArray<uint64_t>{b, a}), children);
  ASSERT_EQ(NS_OK, SearchWatermark(after));
  EXPECT_EQ(watermark, after);
  ASSERT_EQ(NS_OK, folders.MoveFolderWithin(parent, a, b));
  ASSERT_EQ(NS_OK, folders.GetFolderChildren(parent, children));
  EXPECT_EQ((nsTArray<uint64_t>{a, b}), children);
  ASSERT_EQ(NS_OK, folders.ResetChildOrder(parent));
  ASSERT_EQ(NS_OK, folders.GetFolderChildren(parent, children));
  EXPECT_EQ((nsTArray<uint64_t>{b, a}), children);
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(a, parent, "Alpha"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(b, parent, "Beta"_ns));
  nsTArray<nsCString> refs;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(control, refs));
  EXPECT_EQ((nsTArray<nsCString>{"one"_ns, "one"_ns}), refs);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessageProperty(control, "caller"_ns, text));
  EXPECT_TRUE(text.IsEmpty());
}

TEST_F(DeliveryCoreReferences, ReconcileWriteAndCommitFailuresRestoreWholeSet) {
  for (uint32_t mode = 0; mode < 3; ++mode) {
    SCOPED_TRACE(mode);
    ASSERT_NO_FATAL_FAILURE(CheckReconcileSettlement(mode));
    Stop();
  }
}

TEST_F(DeliveryCoreReferences,
       FolderInsertFailuresKeepOutputCacheAndAllocator) {
  for (uint32_t mode = 3; mode < 5; ++mode) {
    SCOPED_TRACE(mode);
    ASSERT_NO_FATAL_FAILURE(CheckReconcileSettlement(mode));
    Stop();
  }
}

TEST_F(DeliveryCoreReferences,
       ReconcileRefusesCallerTransactionAndRetiredOwner) {
  ASSERT_EQ(NS_OK, Start());
  RefPtr<FolderDatabase> original = &mCore->FolderDB();
  uint64_t child;
  ASSERT_EQ(NS_OK,
            original->InsertFolder(mFolderId, "Caller child"_ns, &child));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("caller-reconcile"_ns, {}, key));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    if (active) EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(key, "caller"_ns,
                                                         "pending"_ns));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, original->Reconcile(mFolderId, {}));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  nsCString text;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessageProperty(key, "caller"_ns, text));
  EXPECT_EQ("pending"_ns, text);
  ASSERT_NO_FATAL_FAILURE(
      CheckFolderIdentity(child, mFolderId, "Caller child"_ns));
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  rollback.release();
  Stop();
  ASSERT_EQ(NS_OK, Start());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, original->Reconcile(mFolderId, {}));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            original->Reconcile(mFolderId, {"Inserted"_ns}));
  ASSERT_NO_FATAL_FAILURE(
      CheckFolderIdentity(child, mFolderId, "Caller child"_ns));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessageProperty(key, "caller"_ns, text));
  EXPECT_TRUE(text.IsEmpty());
}

TEST_F(DeliveryCoreReferences, FolderMissingParentKeepsPhysicalRowsAndOutputs) {
  ASSERT_EQ(NS_OK, Start());
  auto& initial = mCore->FolderDB();
  uint64_t orphan, leaf, control, root;
  ASSERT_EQ(NS_OK, initial.GetFolderRoot(mFolderId, &root));
  ASSERT_EQ(NS_OK, initial.InsertFolder(mFolderId, "Orphan"_ns, &orphan));
  ASSERT_EQ(NS_OK, initial.InsertFolder(orphan, "Leaf"_ns, &leaf));
  ASSERT_EQ(NS_OK, initial.InsertFolder(mFolderId, "Control"_ns, &control));
  nsMsgKey key;
  const nsTArray<nsCString> references{"one"_ns, "two"_ns, "one"_ns};
  ASSERT_EQ(NS_OK, AddAt(leaf, "retained-orphan-row"_ns, references, key));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().SetMessageProperty(key, "Exact"_ns, "00042"_ns));
  Stop();
  const uint64_t missingParent = INT64_MAX;
  {
    // Keep genuine native rows, but make one stored ancestor unavailable.
    nsCOMPtr<mozIStorageConnection> writer;
    ASSERT_EQ(NS_OK, Open(getter_AddRefs(writer)));
    nsCOMPtr<mozIStorageStatement> stmt;
    auto close = MakeScopeExit([&] {
      if (stmt) EXPECT_EQ(NS_OK, stmt->Finalize());
      EXPECT_EQ(NS_OK, writer->Close());
    });
    ASSERT_EQ(NS_OK, writer->CreateStatement(
                         "UPDATE folders SET parent=:parent WHERE id=:id"_ns,
                         getter_AddRefs(stmt)));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, orphan));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("parent"_ns, missingParent));
    ASSERT_EQ(NS_OK, stmt->Execute());
  }
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t watermark;
  ASSERT_EQ(NS_OK, SearchWatermark(watermark));
  for (uint64_t id : {orphan, leaf}) {
    uint64_t value = UINT64_MAX;
    EXPECT_EQ(NS_ERROR_UNEXPECTED, folders.GetFolderRoot(id, &value));
    EXPECT_EQ(UINT64_MAX, value);
    nsCString path("unchanged path");
    EXPECT_EQ(NS_ERROR_UNEXPECTED, folders.GetFolderPath(id, path));
    EXPECT_EQ("unchanged path"_ns, path);
    nsTArray<uint64_t> ancestors{UINT64_MAX};
    EXPECT_EQ(NS_ERROR_UNEXPECTED, folders.GetFolderAncestors(id, ancestors));
    EXPECT_EQ((nsTArray<uint64_t>{UINT64_MAX}), ancestors);
    bool descendant = true;
    EXPECT_EQ(NS_ERROR_UNEXPECTED,
              folders.GetFolderIsDescendantOf(id, mFolderId, &descendant));
    EXPECT_TRUE(descendant);
    nsCOMPtr<nsIMsgFolder> facade;
    EXPECT_EQ(NS_ERROR_UNEXPECTED,
              folders.GetMsgFolderForFolder(id, getter_AddRefs(facade)));
    EXPECT_FALSE(facade);
  }
  EXPECT_EQ(NS_ERROR_UNEXPECTED, folders.MoveFolderTo(leaf, control));
  EXPECT_EQ(NS_ERROR_UNEXPECTED, folders.MoveFolderTo(control, leaf));
  ASSERT_NO_FATAL_FAILURE(
      CheckFolderIdentity(orphan, missingParent, "Orphan"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(leaf, orphan, "Leaf"_ns));
  ASSERT_NO_FATAL_FAILURE(
      CheckFolderIdentity(control, mFolderId, "Control"_ns));
  uint64_t value = 0;
  ASSERT_EQ(NS_OK, folders.GetFolderRoot(control, &value));
  EXPECT_EQ(root, value);
  nsTArray<uint64_t> descendants;
  ASSERT_EQ(NS_OK, folders.GetFolderDescendants(mFolderId, descendants));
  EXPECT_EQ((nsTArray<uint64_t>{control}), descendants);
  bool exists = false;
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, db.GetMessageFolderId(key, value));
  EXPECT_EQ(leaf, value);
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "Exact"_ns, text));
  EXPECT_EQ("00042"_ns, text);
  nsTArray<nsCString> stored;
  ASSERT_EQ(NS_OK, db.GetMessageReferences(key, stored));
  EXPECT_EQ(references, stored);
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  ASSERT_EQ(NS_OK, db.SetMessageProperty(key, "caller"_ns, "pending"_ns));
  nsTArray<uint64_t> ancestors{UINT64_MAX};
  EXPECT_EQ(NS_ERROR_UNEXPECTED, folders.GetFolderAncestors(leaf, ancestors));
  EXPECT_EQ((nsTArray<uint64_t>{UINT64_MAX}), ancestors);
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "caller"_ns, text));
  EXPECT_EQ("pending"_ns, text);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  uint64_t after;
  ASSERT_EQ(NS_OK, SearchWatermark(after));
  EXPECT_EQ(watermark, after);
}

TEST_F(DeliveryCoreReferences, FolderRelocationPreservesSubtreeAndBindings) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t left, right, child, sibling, leaf;
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Left"_ns, &left));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Right"_ns, &right));
  ASSERT_EQ(NS_OK, folders.InsertFolder(left, "Original"_ns, &child));
  ASSERT_EQ(NS_OK, folders.InsertFolder(left, "Sibling"_ns, &sibling));
  ASSERT_EQ(NS_OK, folders.InsertFolder(child, "Leaf"_ns, &leaf));
  ASSERT_EQ(NS_OK, folders.MoveFolderWithin(left, child, 0));
  auto ordinalResult = folders.GetFolderOrdinal(child);
  ASSERT_TRUE(ordinalResult.isOk());
  auto ordinal = ordinalResult.unwrap();
  ASSERT_TRUE(ordinal);
  nsMsgKey key;
  const nsTArray<nsCString> references{"one"_ns, "two"_ns, "one"_ns};
  ASSERT_EQ(NS_OK,
            AddAt(leaf, "relocate-retained@invalid"_ns, references, key));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.SetMessageStoreToken(key, "retained-token"_ns));
  ASSERT_EQ(NS_OK, db.SetMessageProperty(key, "Exact"_ns, "00042"_ns));
  ASSERT_EQ(NS_OK, folders.SetFolderUidValidity(leaf, 71));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, leaf, 71, 83));
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  ASSERT_EQ(NS_OK, folders.RelocateFolder(source, child, left, "Original"_ns,
                                          left, "Cafe\xCC\x81"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, left, "Caf\xC3\xA9"_ns));
  auto renamedOrdinal = folders.GetFolderOrdinal(child);
  ASSERT_TRUE(renamedOrdinal.isOk());
  EXPECT_EQ(ordinal, renamedOrdinal.unwrap());
  ASSERT_EQ(NS_OK, folders.RelocateFolder(source, child, left, "Caf\xC3\xA9"_ns,
                                          right, "Moved %/leaf"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, right, "Moved %/leaf"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(leaf, child, "Leaf"_ns));
  auto movedOrdinal = folders.GetFolderOrdinal(child);
  ASSERT_TRUE(movedOrdinal.isOk());
  EXPECT_TRUE(movedOrdinal.unwrap().isNothing());
  uint64_t current;
  nsCString parentPath, path;
  ASSERT_EQ(NS_OK, folders.GetFolderPath(right, parentPath));
  ASSERT_EQ(NS_OK, folders.GetFolderPath(leaf, path));
  EXPECT_EQ(nsCString(parentPath + "/Moved %25%2Fleaf/Leaf"_ns), path);
  current = 0;
  ASSERT_EQ(NS_OK, folders.GetFolderByPath(path, &current));
  EXPECT_EQ(leaf, current);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            folders.RelocateFolder(source, child, left, "Caf\xC3\xA9"_ns, right,
                                   "Moved %/leaf"_ns));
  ASSERT_EQ(NS_OK,
            folders.RelocateFolder(source, child, right, "Moved %/leaf"_ns,
                                   right, "Moved %/leaf"_ns));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, right, "Moved %/leaf"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(leaf, child, "Leaf"_ns));
  auto& reopened = mCore->MessageDB();
  ASSERT_EQ(NS_OK, reopened.GetMessageFolderId(key, current));
  EXPECT_EQ(leaf, current);
  nsMsgKey resolved = nsMsgKey_None;
  ASSERT_EQ(NS_OK, reopened.GetMessageKeyForServerUid(leaf, 71, 83, resolved));
  EXPECT_EQ(key, resolved);
  nsCString text;
  ASSERT_EQ(NS_OK, reopened.GetMessageStoreToken(key, text));
  EXPECT_EQ("retained-token"_ns, text);
  ASSERT_EQ(NS_OK, reopened.GetMessageProperty(key, "Exact"_ns, text));
  EXPECT_EQ("00042"_ns, text);
  nsTArray<nsCString> stored;
  ASSERT_EQ(NS_OK, reopened.GetMessageReferences(key, stored));
  EXPECT_EQ(references, stored);
  // The same checked primitive also accepts a parent-only move.
  ASSERT_EQ(NS_OK, mCore->FolderDB().RelocateFolder(source, child, right,
                                                    "Moved %/leaf"_ns, left,
                                                    "Moved %/leaf"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, left, "Moved %/leaf"_ns));
}

TEST_F(DeliveryCoreReferences, FolderRelocationWriteAndCommitFailuresRollback) {
  for (bool commitFailure : {false, true}) {
    SCOPED_TRACE(commitFailure);
    ASSERT_EQ(NS_OK, Start());
    auto& folders = mCore->FolderDB();
    uint64_t left, right, child, sibling;
    nsAutoCString leftName("Left ");
    nsAutoCString rightName("Right ");
    leftName.Append(commitFailure ? "commit" : "write");
    rightName.Append(commitFailure ? "commit" : "write");
    ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, leftName, &left));
    ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, rightName, &right));
    ASSERT_EQ(NS_OK, folders.InsertFolder(left, "Original"_ns, &child));
    ASSERT_EQ(NS_OK, folders.InsertFolder(left, "Sibling"_ns, &sibling));
    ASSERT_EQ(NS_OK, folders.MoveFolderWithin(left, child, 0));
    ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(left, {sibling, child}));
    nsCString source, oldPath;
    ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
    ASSERT_EQ(NS_OK, folders.GetFolderPath(child, oldPath));
    nsMsgKey key;
    ASSERT_EQ(NS_OK, AddAt(child, "rollback-retained@invalid"_ns,
                           {"one"_ns, "one"_ns}, key));
    ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(key, "Exact"_ns,
                                                           "00042"_ns));
    uint64_t watermark;
    ASSERT_EQ(NS_OK, SearchWatermark(watermark));
    RefPtr<FaultWitness> witness = new FaultWitness();
    ASSERT_EQ(NS_OK, mConnection->CreateFunction("folder_relocate_fault"_ns, 1,
                                                 witness));
    if (commitFailure) {
      ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "PRAGMA foreign_keys=ON; CREATE TEMP TABLE "
                           "relocate_parent(id INTEGER PRIMARY KEY); "
                           "CREATE TEMP TABLE relocate_child(id INTEGER "
                           "REFERENCES relocate_parent(id) DEFERRABLE "
                           "INITIALLY DEFERRED)"_ns));
    }
    nsAutoCString sql(
        "CREATE TEMP TRIGGER fail_folder_relocation "
        "AFTER UPDATE OF name,parent ON main.folders WHEN OLD.id=");
    sql.AppendInt(child);
    sql.AppendLiteral(" BEGIN SELECT folder_relocate_fault(OLD.id); ");
    sql.Append(commitFailure
                   ? "INSERT INTO relocate_child VALUES(OLD.id); END"
                   : "SELECT RAISE(FAIL,'folder relocation write'); END");
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    auto cleanup = MakeScopeExit([&] {
      EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "DROP TRIGGER IF EXISTS fail_folder_relocation"_ns));
      EXPECT_EQ(NS_OK, mConnection->RemoveFunction("folder_relocate_fault"_ns));
    });
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
              folders.RelocateFolder(source, child, left, "Original"_ns, right,
                                     "Renamed"_ns));
    EXPECT_EQ(1u, witness->mCalls);
    EXPECT_EQ(int64_t(child), witness->mLastKey);
    bool active = true;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, left, "Original"_ns));
    ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(left, {sibling, child}));
    ASSERT_NO_FATAL_FAILURE(CheckSiblingOrder(right, {}, false));
    nsCString path, text;
    ASSERT_EQ(NS_OK, folders.GetFolderPath(child, path));
    EXPECT_EQ(oldPath, path);
    uint64_t current, after;
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageFolderId(key, current));
    EXPECT_EQ(child, current);
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessageProperty(key, "Exact"_ns, text));
    EXPECT_EQ("00042"_ns, text);
    ASSERT_EQ(NS_OK, SearchWatermark(after));
    EXPECT_EQ(watermark, after);
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER fail_folder_relocation"_ns));
    ASSERT_EQ(NS_OK, folders.RelocateFolder(source, child, left, "Original"_ns,
                                            right, "Renamed"_ns));
    ASSERT_EQ(NS_OK, mConnection->RemoveFunction("folder_relocate_fault"_ns));
    cleanup.release();
    ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, right, "Renamed"_ns));
    Stop();
    ASSERT_EQ(NS_OK, Start());
    ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, right, "Renamed"_ns));
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessageProperty(key, "Exact"_ns, text));
    EXPECT_EQ("00042"_ns, text);
    Stop();
  }
}

TEST_F(DeliveryCoreReferences, FolderRelocationRefusesStaleAndCallerState) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t child, leaf, target, collision, otherRoot;
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Original"_ns, &child));
  ASSERT_EQ(NS_OK, folders.InsertFolder(child, "Leaf"_ns, &leaf));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Target"_ns, &target));
  ASSERT_EQ(NS_OK, folders.InsertFolder(target, "Collision"_ns, &collision));
  ASSERT_EQ(NS_OK, folders.InsertRoot("different-account"_ns, &otherRoot));
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            folders.RelocateFolder("old-incarnation"_ns, child, mFolderId,
                                   "Original"_ns, target, "New"_ns));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            folders.RelocateFolder(source, child, target, "Original"_ns, target,
                                   "New"_ns));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            folders.RelocateFolder(source, child, mFolderId, "original"_ns,
                                   target, "New"_ns));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            folders.RelocateFolder(source, target, mFolderId, "Original"_ns,
                                   mFolderId, "New"_ns));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            folders.RelocateFolder(source, INT64_MAX, mFolderId, "Original"_ns,
                                   target, "New"_ns));
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            folders.RelocateFolder(source, 0, mFolderId, "Original"_ns, target,
                                   "New"_ns));
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            folders.RelocateFolder(source, child, mFolderId, "Original"_ns, 0,
                                   "New"_ns));
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            folders.RelocateFolder(source, child, mFolderId, "Original"_ns,
                                   UINT64_MAX, "New"_ns));
  for (uint64_t badParent : {child, leaf, otherRoot}) {
    EXPECT_EQ(NS_ERROR_UNEXPECTED,
              folders.RelocateFolder(source, child, mFolderId, "Original"_ns,
                                     badParent, "New"_ns));
  }
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            folders.RelocateFolder(source, child, mFolderId, "Original"_ns,
                                   target, "Collision"_ns));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, AddAt(child, "caller-state@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(key, "caller"_ns,
                                                         "pending"_ns));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            folders.RelocateFolder(source, child, mFolderId, "Original"_ns,
                                   target, "New"_ns));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  nsCString text;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessageProperty(key, "caller"_ns, text));
  EXPECT_EQ("pending"_ns, text);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  nsAutoCString sql("CREATE TEMP VIEW folders AS SELECT id,parent,ordinal,");
  sql.AppendLiteral("CASE WHEN id=");
  sql.AppendInt(child);
  sql.AppendLiteral(
      " THEN abs(-9223372036854775808) ELSE name END AS name,flags "
      "FROM main.folders");
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
  EXPECT_EQ(NS_ERROR_FAILURE,
            folders.RelocateFolder(source, child, mFolderId, "Original"_ns,
                                   target, "New"_ns));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL("DROP VIEW temp.folders"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, mFolderId, "Original"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(leaf, child, "Leaf"_ns));
  RefPtr<FolderDatabase> retired = &folders;
  Stop();
  ASSERT_EQ(NS_OK, Start());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            retired->RelocateFolder(source, child, mFolderId, "Original"_ns,
                                    target, "New"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, mFolderId, "Original"_ns));
}

TEST_F(DeliveryCoreReferences, FolderRelocationRefusesPendingSubtreeBodyWork) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t root, container;
  ASSERT_EQ(NS_OK, folders.GetFolderRoot(mFolderId, &root));
  ASSERT_EQ(NS_OK, folders.InsertFolder(root, "Container"_ns, &container));
  ASSERT_EQ(NS_OK, folders.MoveFolderTo(container, mFolderId));
  nsCString source, inboxName;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  ASSERT_EQ(NS_OK, folders.GetFolderName(mFolderId, inboxName));
  FolderBodyRelocation plan;
  ASSERT_EQ(NS_OK, PrepareRelocation(plan));
  ASSERT_EQ(NS_OK, mCore->MessageDB().PrepareBodyRelocation(plan));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->FolderDB();
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            reopened.RelocateFolder(source, container, root, "Container"_ns,
                                    root, "Renamed"_ns));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            reopened.RelocateFolder(source, mFolderId, container, inboxName,
                                    container, "Renamed"_ns));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP VIEW body_relocations AS SELECT folderId, "
          "abs(-9223372036854775808) AS state FROM main.body_relocations"_ns));
  EXPECT_EQ(NS_ERROR_FAILURE,
            reopened.RelocateFolder(source, container, root, "Container"_ns,
                                    root, "Renamed"_ns));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.body_relocations"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(container, root, "Container"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(mFolderId, container, inboxName));
  Maybe<FolderBodyRelocation> pending;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetBodyRelocation(mFolderId, pending));
  ASSERT_TRUE(pending);
  EXPECT_EQ(BodyRelocationState::Pending, pending->state);
  EXPECT_EQ(plan.token, pending->token);
  EXPECT_EQ(plan.messages.Length(), pending->messages.Length());
  for (const auto& path : {plan.originalPath, plan.compactedPath}) {
    nsCOMPtr<nsIFile> file;
    ASSERT_EQ(NS_OK, NS_NewLocalFile(path, getter_AddRefs(file)));
    bool exists = false;
    ASSERT_EQ(NS_OK, file->Exists(&exists));
    EXPECT_TRUE(exists);
  }
}

TEST_F(DeliveryCoreReferences,
       FolderResolverRefusesRetiredOwnerWithoutReopening) {
  ASSERT_EQ(NS_OK, Start());
  RefPtr<FolderDatabase> original = &mCore->FolderDB();
  nsCString path;
  ASSERT_EQ(NS_OK, original->GetFolderPath(mFolderId, path));
  Stop();
  nsCOMPtr<mozIStorageConnection> before = Connection();
  ASSERT_FALSE(before);
  nsCOMPtr<nsIMsgFolder> folder;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            original->GetMsgFolderForFolder(mFolderId, getter_AddRefs(folder)));
  EXPECT_FALSE(folder);
  nsCOMPtr<mozIStorageConnection> after = Connection();
  EXPECT_FALSE(after);
  ASSERT_EQ(NS_OK, Start());
  before = Connection();
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            original->GetMsgFolderForFolder(mFolderId, getter_AddRefs(folder)));
  EXPECT_FALSE(folder);
  after = Connection();
  EXPECT_EQ(before, after);
}

TEST_F(DeliveryCoreReferences, ImapFolderRelocationSettlesCompleteMetadata) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t left, trash, target, root, child, leaf;
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Left"_ns, &left));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Trash"_ns, &trash));
  ASSERT_EQ(NS_OK, folders.UpdateFlags(trash, nsMsgFolderFlags::Trash));
  ASSERT_EQ(NS_OK, folders.InsertFolder(trash, "Nested"_ns, &target));
  ASSERT_EQ(NS_OK, folders.InsertFolder(left, "Old"_ns, &root));
  ASSERT_EQ(NS_OK, folders.InsertFolder(root, "Child"_ns, &child));
  ASSERT_EQ(NS_OK, folders.InsertFolder(child, "Leaf"_ns, &leaf));
  const uint32_t flags = nsMsgFolderFlags::Favorite |
                         nsMsgFolderFlags::CheckNew | nsMsgFolderFlags::Offline;
  ASSERT_EQ(NS_OK, folders.UpdateFlags(root, flags));
  ASSERT_EQ(NS_OK, folders.UpdateFlags(child, flags));
  ASSERT_EQ(NS_OK, SeedImapRelocationProperty(root, "imapDisplayName"_ns,
                                              "Old display"_ns));
  ASSERT_EQ(NS_OK,
            SeedImapRelocationProperty(child, "imapDisplayName"_ns, ""_ns));
  ASSERT_EQ(NS_OK, SeedImapRelocationProperty(root, "Exact"_ns, "00042"_ns));
  ASSERT_EQ(NS_OK, SeedImapRelocationProperty(leaf, "empty"_ns, ""_ns));
  nsMsgKey key;
  const nsTArray<nsCString> references{"first"_ns, "last"_ns, "first"_ns};
  ASSERT_EQ(NS_OK, AddAt(leaf, "imap-relocation@invalid"_ns, references, key));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageStoreToken(key, "body"_ns));
  ASSERT_EQ(NS_OK, folders.SetFolderUidValidity(leaf, 57));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().BindMessageToServerUid(key, leaf, 57, 91));
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  ImapFolderRelocationMetadata metadata;
  metadata.folders = {
      {root, left, "Old"_ns, "Left/wire-&AOE-"_ns},
      {child, root, "Child"_ns, "Left/wire-&AOE-/Child"_ns},
      {leaf, child, "Leaf"_ns, "Left/wire-&AOE-/Child/Leaf"_ns}};
  metadata.displayName = Some(nsCString("folder \xC3\xA1"_ns));
  ASSERT_EQ(NS_OK, folders.RelocateImapFolder(source, root, left, "Old"_ns,
                                              left, "wire-&AOE-"_ns, metadata));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(root, left, "wire-&AOE-"_ns));
  auto storedFlags = folders.GetFolderFlags(root);
  ASSERT_TRUE(storedFlags.isOk());
  EXPECT_EQ(flags, storedFlags.unwrap());
  metadata.folders[0].expectedName = "wire-&AOE-"_ns;
  metadata.folders[0].onlineName = "Trash/Nested/wire-&AOE-"_ns;
  metadata.folders[1].onlineName = "Trash/Nested/wire-&AOE-/Child"_ns;
  metadata.folders[2].onlineName = "Trash/Nested/wire-&AOE-/Child/Leaf"_ns;
  metadata.displayName.reset();
  ASSERT_EQ(NS_OK,
            folders.RelocateImapFolder(source, root, left, "wire-&AOE-"_ns,
                                       target, "wire-&AOE-"_ns, metadata));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(root, target, "wire-&AOE-"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, root, "Child"_ns));
  for (const auto& entry : metadata.folders) {
    for (const auto& name : {"onlineName"_ns, "mailboxName"_ns}) {
      Maybe<nsCString> text;
      ASSERT_EQ(NS_OK, ImapRelocationProperty(entry.id, name, text));
      ASSERT_TRUE(text);
      EXPECT_EQ(entry.onlineName, *text);
    }
  }
  Maybe<nsCString> text;
  ASSERT_EQ(NS_OK, ImapRelocationProperty(root, "imapDisplayName"_ns, text));
  ASSERT_TRUE(text);
  EXPECT_EQ("folder \xC3\xA1"_ns, *text);
  ASSERT_EQ(NS_OK, ImapRelocationProperty(child, "imapDisplayName"_ns, text));
  ASSERT_TRUE(text);
  EXPECT_TRUE(text->IsEmpty());
  ASSERT_EQ(NS_OK, ImapRelocationProperty(leaf, "imapDisplayName"_ns, text));
  EXPECT_TRUE(text.isNothing());
  ASSERT_EQ(NS_OK, ImapRelocationProperty(root, "Exact"_ns, text));
  ASSERT_TRUE(text);
  EXPECT_EQ("00042"_ns, *text);
  ASSERT_EQ(NS_OK, ImapRelocationProperty(leaf, "empty"_ns, text));
  ASSERT_TRUE(text);
  EXPECT_TRUE(text->IsEmpty());
  auto rootFlags = mCore->FolderDB().GetFolderFlags(root);
  auto childFlags = mCore->FolderDB().GetFolderFlags(child);
  ASSERT_TRUE(rootFlags.isOk());
  ASSERT_TRUE(childFlags.isOk());
  EXPECT_EQ(uint32_t{nsMsgFolderFlags::Offline}, rootFlags.unwrap());
  EXPECT_EQ(flags, childFlags.unwrap());
  nsMsgKey resolved = nsMsgKey_None;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageKeyForServerUid(leaf, 57, 91,
                                                                resolved));
  EXPECT_EQ(key, resolved);
  nsCString token;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageStoreToken(key, token));
  EXPECT_EQ("body"_ns, token);
  nsTArray<nsCString> stored;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(key, stored));
  EXPECT_EQ(references, stored);
}

TEST_F(DeliveryCoreReferences,
       ImapFolderRelocationRejectsIncompleteAndStaleTargets) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t root, child, target;
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Old"_ns, &root));
  ASSERT_EQ(NS_OK, folders.InsertFolder(root, "Child"_ns, &child));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Target"_ns, &target));
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  ImapFolderRelocationMetadata valid;
  valid.folders = {{root, mFolderId, "Old"_ns, "New"_ns},
                   {child, root, "Child"_ns, "New/Child"_ns}};
  valid.displayName = Some(nsCString("New display"_ns));
  uint64_t watermark;
  ASSERT_EQ(NS_OK, SearchWatermark(watermark));
  for (uint32_t fault = 0; fault < 7; ++fault) {
    SCOPED_TRACE(fault);
    ImapFolderRelocationMetadata metadata;
    metadata.folders = valid.folders.Clone();
    metadata.displayName = valid.displayName;
    if (fault == 0) metadata.folders.RemoveLastElement();
    if (fault == 1) metadata.folders[1] = metadata.folders[0];
    if (fault == 2) metadata.folders[1].id = target;
    if (fault == 3) metadata.folders[1].expectedParent = target;
    if (fault == 4) metadata.folders[1].expectedName = "stale"_ns;
    if (fault == 5) metadata.folders[1].onlineName.Truncate();
    if (fault == 6) metadata.displayName.reset();
    EXPECT_EQ(fault >= 5 ? NS_ERROR_INVALID_ARG : NS_ERROR_NOT_AVAILABLE,
              folders.RelocateImapFolder(source, root, mFolderId, "Old"_ns,
                                         mFolderId, "New"_ns, metadata));
    ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(root, mFolderId, "Old"_ns));
    Maybe<nsCString> text;
    ASSERT_EQ(NS_OK, ImapRelocationProperty(root, "onlineName"_ns, text));
    EXPECT_TRUE(text.isNothing());
    uint64_t after;
    ASSERT_EQ(NS_OK, SearchWatermark(after));
    EXPECT_EQ(watermark, after);
  }
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            folders.RelocateImapFolder(source, root, mFolderId, "Old"_ns,
                                       target, "Old"_ns, valid));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    if (active) EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, SetRemovalMetric(root, 17));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            folders.RelocateImapFolder(source, root, mFolderId, "Old"_ns,
                                       mFolderId, "New"_ns, valid));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  int64_t metric = 0;
  ASSERT_EQ(NS_OK, RemovalMetric(root, metric));
  EXPECT_EQ(17, metric);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_EQ(NS_OK, RemovalMetric(root, metric));
  EXPECT_EQ(0, metric);
}

TEST_F(DeliveryCoreReferences, ImapFolderRelocationMetadataFailuresRollback) {
  for (bool commitFailure : {false, true}) {
    SCOPED_TRACE(commitFailure);
    ASSERT_EQ(NS_OK, Start());
    auto& folders = mCore->FolderDB();
    uint64_t parent, root, child, trash;
    ASSERT_EQ(NS_OK, folders.InsertFolder(
                         mFolderId, commitFailure ? "Commit"_ns : "Write"_ns,
                         &parent));
    ASSERT_EQ(NS_OK, folders.InsertFolder(parent, "Old"_ns, &root));
    ASSERT_EQ(NS_OK, folders.InsertFolder(root, "Child"_ns, &child));
    ASSERT_EQ(NS_OK, folders.InsertFolder(parent, "Trash"_ns, &trash));
    ASSERT_EQ(NS_OK, folders.UpdateFlags(trash, nsMsgFolderFlags::Trash));
    const uint32_t flags =
        nsMsgFolderFlags::CheckNew | nsMsgFolderFlags::Favorite;
    ASSERT_EQ(NS_OK, folders.UpdateFlags(root, flags));
    ASSERT_EQ(NS_OK,
              SeedImapRelocationProperty(root, "onlineName"_ns, "Old"_ns));
    ASSERT_EQ(NS_OK,
              SeedImapRelocationProperty(root, "mailboxName"_ns, "Old"_ns));
    ASSERT_EQ(NS_OK, SeedImapRelocationProperty(child, "onlineName"_ns,
                                                "Old/Child"_ns));
    ASSERT_EQ(NS_OK, SeedImapRelocationProperty(child, "mailboxName"_ns,
                                                "Old/Child"_ns));
    nsCString source;
    ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
    ImapFolderRelocationMetadata metadata;
    metadata.folders = {{root, parent, "Old"_ns, "Trash/New"_ns},
                        {child, root, "Child"_ns, "Trash/New/Child"_ns}};
    metadata.displayName = Some(nsCString("New display"_ns));
    uint64_t watermark;
    ASSERT_EQ(NS_OK, SearchWatermark(watermark));
    RefPtr<FaultWitness> witness = new FaultWitness();
    ASSERT_EQ(NS_OK, mConnection->CreateFunction("imap_metadata_fault"_ns, 1,
                                                 witness));
    if (commitFailure) {
      ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "PRAGMA foreign_keys=ON; CREATE TEMP TABLE "
                           "imap_relocate_parent(id INTEGER PRIMARY KEY); "
                           "CREATE TEMP TABLE imap_relocate_child(id INTEGER "
                           "REFERENCES imap_relocate_parent(id) DEFERRABLE "
                           "INITIALLY DEFERRED)"_ns));
    }
    nsAutoCString sql(
        "CREATE TEMP TRIGGER fail_imap_metadata AFTER INSERT ON "
        "main.folder_properties WHEN NEW.name='mailboxName' AND NEW.id=");
    sql.AppendInt(child);
    sql.AppendLiteral(" BEGIN SELECT imap_metadata_fault(NEW.id); ");
    sql.Append(commitFailure
                   ? "INSERT INTO imap_relocate_child VALUES(NEW.id); END"
                   : "SELECT RAISE(FAIL,'IMAP metadata write'); END");
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    auto cleanup = MakeScopeExit([&] {
      EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "DROP TRIGGER IF EXISTS fail_imap_metadata"_ns));
      EXPECT_EQ(NS_OK, mConnection->RemoveFunction("imap_metadata_fault"_ns));
    });
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
              folders.RelocateImapFolder(source, root, parent, "Old"_ns, trash,
                                         "New"_ns, metadata));
    EXPECT_EQ(1u, witness->mCalls);
    EXPECT_EQ(int64_t(child), witness->mLastKey);
    ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(root, parent, "Old"_ns));
    ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, root, "Child"_ns));
    Maybe<nsCString> text;
    ASSERT_EQ(NS_OK, ImapRelocationProperty(root, "onlineName"_ns, text));
    ASSERT_TRUE(text);
    EXPECT_EQ("Old"_ns, *text);
    ASSERT_EQ(NS_OK, ImapRelocationProperty(child, "mailboxName"_ns, text));
    ASSERT_TRUE(text);
    EXPECT_EQ("Old/Child"_ns, *text);
    ASSERT_EQ(NS_OK, ImapRelocationProperty(root, "imapDisplayName"_ns, text));
    EXPECT_TRUE(text.isNothing());
    auto afterFlags = folders.GetFolderFlags(root);
    ASSERT_TRUE(afterFlags.isOk());
    EXPECT_EQ(flags, afterFlags.unwrap());
    uint64_t after;
    ASSERT_EQ(NS_OK, SearchWatermark(after));
    EXPECT_EQ(watermark, after);
    bool active = true;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER fail_imap_metadata"_ns));
    ASSERT_EQ(NS_OK, folders.RelocateImapFolder(source, root, parent, "Old"_ns,
                                                trash, "New"_ns, metadata));
    ASSERT_EQ(NS_OK, mConnection->RemoveFunction("imap_metadata_fault"_ns));
    cleanup.release();
    Stop();
    ASSERT_EQ(NS_OK, Start());
    ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(root, trash, "New"_ns));
    ASSERT_EQ(NS_OK, ImapRelocationProperty(child, "mailboxName"_ns, text));
    ASSERT_TRUE(text);
    EXPECT_EQ("Trash/New/Child"_ns, *text);
    Stop();
  }
}

TEST_F(DeliveryCoreReferences,
       FolderRelocationRecoveryRetainsFailedOwnerAndBlocksSubtree) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  auto& messages = mCore->MessageDB();
  uint64_t root, child, sibling;
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Recovery"_ns, &root));
  ASSERT_EQ(NS_OK, folders.InsertFolder(root, "Child"_ns, &child));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Sibling"_ns, &sibling));
  nsMsgKey key, siblingKey;
  ASSERT_EQ(NS_OK,
            AddAt(child, "recovery@invalid"_ns, {"one"_ns, "one"_ns}, key));
  ASSERT_EQ(NS_OK, AddAt(sibling, "outside@invalid"_ns, {}, siblingKey));
  ASSERT_EQ(NS_OK, messages.SetMessageStoreToken(key, "retained-body"_ns));
  ASSERT_EQ(NS_OK, messages.SetMessageProperty(key, "Exact"_ns, "00042"_ns));
  RawHdr stagedHeader;
  stagedHeader.messageId = "staged-recovery@invalid"_ns;
  nsMsgKey stagedKey;
  ASSERT_EQ(NS_OK, messages.StageMessage(child, stagedHeader, &stagedKey));
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  uint64_t watermark;
  ASSERT_EQ(NS_OK, SearchWatermark(watermark));
  RefPtr<RecoveryPlanOwner> owner = new RecoveryPlanOwner();
  WeakPtr<RecoveryPlanOwner> alive(owner.get());
  RefPtr<FolderRelocationRecovery> recovery;
  ASSERT_EQ(NS_OK, mCore->PrepareFolderRelocationRecovery(
                       source, root, {root, child}, owner, recovery));
  ASSERT_EQ(NS_OK, mCore->ValidateFolderRelocationRecovery(recovery));
  ASSERT_EQ(NS_OK, messages.CheckFolderBodyAccess(child));
  ASSERT_EQ(NS_OK, messages.CheckMessageBodyAccess(key));
  ASSERT_EQ(NS_OK, messages.CheckMessageBodyAccess(stagedKey));
  owner = nullptr;
  ASSERT_TRUE(alive);
  recovery->BlockAfterFailedRestore(NS_ERROR_STORAGE_CONSTRAINT,
                                    NS_ERROR_FILE_ACCESS_DENIED);
  recovery->BlockAfterFailedRestore(NS_ERROR_UNEXPECTED, NS_ERROR_FAILURE);
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, recovery->PrimaryError());
  EXPECT_EQ(NS_ERROR_FILE_ACCESS_DENIED, recovery->RollbackError());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            mCore->ValidateFolderRelocationRecovery(recovery));
  mCore->DiscardFolderRelocationRecovery(recovery);
  recovery = nullptr;
  ASSERT_TRUE(alive);  // Core retains the recovery owner after stack eviction.
  for (uint64_t id : {root, child}) {
    EXPECT_EQ(NS_ERROR_IN_PROGRESS, mCore->CheckFolderRelocationRecovery(id));
    EXPECT_EQ(NS_ERROR_IN_PROGRESS, messages.CheckFolderBodyAccess(id));
  }
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, messages.CheckMessageBodyAccess(key));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, messages.CheckMessageBodyAccess(stagedKey));
  MessageBodyState output;
  output.key = nsMsgKey_None;
  output.storeToken = Some(nsCString("unchanged"_ns));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, messages.GetMessageBodyState(key, output));
  EXPECT_EQ(nsMsgKey_None, output.key);
  ASSERT_TRUE(output.storeToken);
  EXPECT_EQ("unchanged"_ns, *output.storeToken);
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, folders.UpdateName(root, "Unsafe"_ns));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, folders.UpdateName(mFolderId, "Unsafe"_ns));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, folders.MoveFolderTo(sibling, root));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, folders.MoveFolderTo(child, sibling));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, folders.DeleteFolder(mFolderId));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, folders.Reconcile(mFolderId, {}));
  uint64_t notInserted = UINT64_MAX;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            folders.InsertFolder(child, "Unsafe"_ns, &notInserted));
  EXPECT_EQ(UINT64_MAX, notInserted);
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            folders.RelocateFolder(source, root, mFolderId, "Recovery"_ns,
                                   sibling, "Moved"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(root, mFolderId, "Recovery"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckFolderIdentity(child, root, "Child"_ns));
  uint64_t after;
  ASSERT_EQ(NS_OK, SearchWatermark(after));
  EXPECT_EQ(watermark, after);
  nsCString text;
  ASSERT_EQ(NS_OK, messages.GetMessageProperty(key, "Exact"_ns, text));
  EXPECT_EQ("00042"_ns, text);
  nsTArray<nsCString> references;
  ASSERT_EQ(NS_OK, messages.GetMessageReferences(key, references));
  EXPECT_EQ((nsTArray<nsCString>{"one"_ns, "one"_ns}), references);
  ASSERT_EQ(NS_OK, messages.CheckFolderBodyAccess(sibling));
  ASSERT_EQ(NS_OK, messages.CheckMessageBodyAccess(siblingKey));
  ASSERT_EQ(NS_OK, mCore->CheckFolderRelocationRecovery(mFolderId));
  ASSERT_EQ(NS_OK, folders.UpdateName(sibling, "Still usable"_ns));
  Stop();  // No recovery I/O; releasing the core's last holder releases owner.
  EXPECT_FALSE(alive);
}

TEST_F(DeliveryCoreReferences,
       FolderRelocationRecoveryPreparationKeepsOutputAndCallerState) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t root, child, outside;
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Recovery"_ns, &root));
  ASSERT_EQ(NS_OK, folders.InsertFolder(root, "Child"_ns, &child));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Outside"_ns, &outside));
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  RefPtr<RecoveryPlanOwner> owner = new RecoveryPlanOwner();
  RefPtr<FolderRelocationRecovery> sentinel;
  ASSERT_EQ(NS_OK, mCore->PrepareFolderRelocationRecovery(
                       source, outside, {outside}, owner, sentinel));
  RefPtr<FolderRelocationRecovery> output = sentinel;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->PrepareFolderRelocationRecovery(
                "different-source"_ns, root, {root, child}, owner, output));
  EXPECT_EQ(sentinel, output);
  for (const auto& ids :
       {nsTArray<uint64_t>{root}, nsTArray<uint64_t>{root, root},
        nsTArray<uint64_t>{root, outside}}) {
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, mCore->PrepareFolderRelocationRecovery(
                                          source, root, ids, owner, output));
    EXPECT_EQ(sentinel, output);
  }
  EXPECT_EQ(NS_ERROR_INVALID_ARG, mCore->PrepareFolderRelocationRecovery(
                                      source, root, {root, 0}, owner, output));
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            mCore->PrepareFolderRelocationRecovery(source, root, {root, child},
                                                   nullptr, output));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->PrepareFolderRelocationRecovery(
                source, INT64_MAX, {uint64_t(INT64_MAX)}, owner, output));
  EXPECT_EQ(sentinel, output);
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            mCore->PrepareFolderRelocationRecovery(source, outside, {outside},
                                                   owner, output));
  EXPECT_EQ(sentinel, output);
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    if (active) EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, SetRemovalMetric(root, 47));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            mCore->PrepareFolderRelocationRecovery(source, root, {root, child},
                                                   owner, output));
  EXPECT_EQ(sentinel, output);
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  int64_t metric;
  ASSERT_EQ(NS_OK, RemovalMetric(root, metric));
  EXPECT_EQ(47, metric);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_EQ(NS_OK, RemovalMetric(root, metric));
  EXPECT_EQ(0, metric);
  mCore->DiscardFolderRelocationRecovery(sentinel);
  ASSERT_EQ(NS_OK, mCore->PrepareFolderRelocationRecovery(
                       source, root, {root, child}, owner, output));
  ASSERT_EQ(NS_OK, mCore->ValidateFolderRelocationRecovery(output));
  mCore->DiscardFolderRelocationRecovery(output);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->ValidateFolderRelocationRecovery(output));
}

TEST_F(DeliveryCoreReferences,
       FolderRelocationRecoveryRevalidatesSubtreeAndRetiredOwner) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t root, child;
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Recovery"_ns, &root));
  ASSERT_EQ(NS_OK, folders.InsertFolder(root, "Child"_ns, &child));
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  RefPtr<RecoveryPlanOwner> owner = new RecoveryPlanOwner();
  RefPtr<FolderRelocationRecovery> recovery;
  ASSERT_EQ(NS_OK, mCore->PrepareFolderRelocationRecovery(
                       source, root, {child, root}, owner, recovery));
  uint64_t late;
  ASSERT_EQ(NS_OK, folders.InsertFolder(root, "Late"_ns, &late));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->ValidateFolderRelocationRecovery(recovery));
  ASSERT_EQ(NS_OK, folders.DeleteFolder(late));
  ASSERT_EQ(NS_OK, mCore->ValidateFolderRelocationRecovery(recovery));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "CREATE TEMP VIEW database_identity AS SELECT "
                       "singleton,'{12345678-9ABC-4def-8123-0123456789ab}' AS "
                       "sourceId FROM main.database_identity"_ns));
  auto drop = MakeScopeExit([&] {
    if (mConnection)
      EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "DROP VIEW IF EXISTS temp.database_identity"_ns));
  });
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->ValidateFolderRelocationRecovery(recovery));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.database_identity"_ns));
  ASSERT_EQ(NS_OK, mCore->ValidateFolderRelocationRecovery(recovery));
  RefPtr<DatabaseCore> oldCore = mCore;
  Stop();
  EXPECT_FALSE(Connection());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            oldCore->ValidateFolderRelocationRecovery(recovery));
  EXPECT_FALSE(Connection());
  ASSERT_EQ(NS_OK, Start());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->ValidateFolderRelocationRecovery(recovery));
  recovery->BlockAfterFailedRestore(NS_ERROR_FAILURE,
                                    NS_ERROR_FILE_ACCESS_DENIED);
  ASSERT_EQ(NS_OK, mCore->MessageDB().CheckFolderBodyAccess(root));
  ASSERT_EQ(NS_OK, mCore->MessageDB().CheckFolderBodyAccess(child));
}

TEST_F(DeliveryCoreReferences,
       FolderRelocationRecoveryReadFailuresPreserveOutputAndPrimaryError) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t root;
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolderId, "Recovery"_ns, &root));
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  RefPtr<RecoveryPlanOwner> owner = new RecoveryPlanOwner();
  RefPtr<FolderRelocationRecovery> output;
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("recovery_read_fault"_ns, 1, witness));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "CREATE TEMP VIEW database_identity AS "
                       "SELECT singleton,sourceId FROM main.database_identity "
                       "WHERE CASE WHEN recovery_read_fault(singleton)=0 "
                       "THEN abs(-9223372036854775808) ELSE 1 END"_ns));
  auto cleanup = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.database_identity"_ns));
    EXPECT_EQ(NS_OK, mConnection->RemoveFunction("recovery_read_fault"_ns));
  });
  EXPECT_EQ(NS_ERROR_FAILURE, mCore->PrepareFolderRelocationRecovery(
                                  source, root, {root}, owner, output));
  EXPECT_FALSE(output);
  EXPECT_EQ(1u, witness->mCalls);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.database_identity"_ns));
  ASSERT_EQ(NS_OK, mCore->PrepareFolderRelocationRecovery(source, root, {root},
                                                          owner, output));
  output->BlockAfterFailedRestore(NS_ERROR_STORAGE_CONSTRAINT,
                                  NS_ERROR_FILE_ACCESS_DENIED);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "CREATE TEMP VIEW database_identity AS SELECT "
                       "singleton,sourceId FROM main.database_identity WHERE "
                       "CASE WHEN recovery_read_fault(singleton)=0 "
                       "THEN abs(-9223372036854775808) ELSE 1 END"_ns));
  EXPECT_EQ(NS_ERROR_FAILURE, mCore->MessageDB().CheckFolderBodyAccess(root));
  EXPECT_EQ(2u, witness->mCalls);
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, output->PrimaryError());
  EXPECT_EQ(NS_ERROR_FILE_ACCESS_DENIED, output->RollbackError());
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.database_identity"_ns));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            mCore->MessageDB().CheckFolderBodyAccess(root));
}

TEST_F(DeliveryCoreReferences,
       FolderRepairPreservesPhysicalIdentityAndUserState) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey first, second;
  ASSERT_EQ(NS_OK, AddRepairRow(mFolderId, "physical-a"_ns, first));
  ASSERT_EQ(NS_OK, AddRepairRow(mFolderId, "physical-b"_ns, second));
  RefPtr<Message> hot = new Message(first);
  nsCString text;
  ASSERT_EQ(NS_OK, hot->GetSubject(text));
  EXPECT_EQ("old subject"_ns, text);
  FolderRepairSnapshot snapshot;
  ASSERT_EQ(NS_OK, CaptureRepair(mFolderId, snapshot));
  // These user changes do not change the captured physical body association.
  const uint32_t retained = 0x80000000u | nsMsgMessageFlags::Read |
                            nsMsgMessageFlags::Marked | nsMsgMessageFlags::New;
  ASSERT_EQ(NS_OK, db.SetMessageFlags(first, retained));
  ASSERT_EQ(NS_OK, db.SetMessageTags(first, "user tags"_ns));
  ASSERT_EQ(NS_OK, db.SetMessagePriority(first, nsMsgPriority::highest));
  ASSERT_EQ(NS_OK, db.SetMessageProperty(first, "Exact"_ns, "00042"_ns));
  ASSERT_EQ(NS_OK, db.SetMessageProperty(first, "Empty"_ns, ""_ns));
  RawHdr parsed[3];
  for (auto& raw : parsed) {
    raw.key = first;  // Never an identity or allocation request.
    raw.messageId = "same-new@repair.invalid"_ns;
    raw.subject = "repaired subject"_ns;
    raw.sender = "new sender"_ns;
    raw.flags = nsMsgMessageFlags::Expunged;
    raw.priority = nsMsgPriority::lowest;
    raw.keywords = "stale disk tags"_ns;
    raw.extras = {{"Exact"_ns, "wrong"_ns}};
  }
  parsed[1].flags = nsMsgMessageFlags::Marked;
  parsed[2].references = {"raw"_ns, "raw"_ns, "e\xcc\x81"_ns};
  nsTArray<FolderRepairMessage> items = {
      {&parsed[0], "physical-b"_ns, 19, 3, true},
      {&parsed[1], "physical-new"_ns, 29, 4, true},
      {&parsed[2], "physical-a"_ns, 39, 5, true}};
  nsTArray<RefPtr<Message>> output;
  uint32_t calls = 0;
  RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
  observer->action = [&](char kind, const CapturedMessage&,
                         const CapturedMessage&, Message*, bool notify) {
    ++calls;
    ASSERT_EQ(3u, output.Length());
    EXPECT_FALSE(snapshot.Messages());
    for (auto& header : output) ASSERT_TRUE(header);
    bool active = true;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    ASSERT_EQ(NS_OK, hot->GetSubject(text));
    EXPECT_EQ("repaired subject"_ns, text);
    if (kind == 'P') EXPECT_FALSE(notify);
    int64_t valid = -1;
    ASSERT_EQ(NS_OK, ReadFolderProperty(&mCore->FolderDB(), mFolderId,
                                        "summaryValid"_ns, valid));
    EXPECT_EQ(1, valid);
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
    auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
    ASSERT_EQ(
        NS_OK,
        PublicationCell(
            reader, first,
            "SELECT count(*) FROM messages WHERE folderId=(SELECT folderId FROM messages WHERE id=:id)"_ns,
            text));
    EXPECT_EQ("3"_ns, text);
  };
  db.AddMessageListener(observer);
  auto remove = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK,
            db.CompleteFolderRepair(snapshot, items, NS_OK, true, output));
  EXPECT_EQ(3u, calls);
  nsMsgKey key;
  ASSERT_EQ(NS_OK, output[0]->GetMessageKey(&key));
  EXPECT_EQ(second, key);
  ASSERT_EQ(NS_OK, output[1]->GetMessageKey(&key));
  EXPECT_GT(key, second);
  ASSERT_EQ(NS_OK, output[2]->GetMessageKey(&key));
  EXPECT_EQ(first, key);
  uint32_t flags, size;
  nsMsgPriorityValue priority;
  ASSERT_EQ(NS_OK, hot->GetFlags(&flags));
  EXPECT_EQ(retained, flags);
  ASSERT_EQ(NS_OK, hot->GetPriority(&priority));
  EXPECT_EQ(nsMsgPriorityValue(nsMsgPriority::highest), priority);
  ASSERT_EQ(NS_OK, db.GetMessageTags(first, text));
  EXPECT_EQ("user tags"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(first, "Exact"_ns, text));
  EXPECT_EQ("00042"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(first, "Empty"_ns, text));
  EXPECT_EQ(""_ns, text);
  ASSERT_EQ(
      NS_OK,
      PublicationCell(
          mConnection, first,
          "SELECT count(*) FROM message_properties WHERE id=:id AND name='Missing'"_ns,
          text));
  EXPECT_EQ("0"_ns, text);
  ASSERT_EQ(NS_OK, hot->GetMessageSize(&size));
  EXPECT_EQ(39u, size);
  nsTArray<nsCString> references;
  ASSERT_EQ(NS_OK, db.GetMessageReferences(first, references));
  EXPECT_EQ(parsed[2].references, references);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.CompleteFolderRepair(snapshot, items, NS_OK, true, output));
  EXPECT_EQ(3u, calls);
}

TEST_F(DeliveryCoreReferences, FolderRepairRejectsAmbiguousAndUnmatchedInputs) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, AddRepairRow(mFolderId, "unique"_ns, key));
  FolderRepairSnapshot snapshot;
  ASSERT_EQ(NS_OK, CaptureRepair(mFolderId, snapshot));
  RawHdr raw;
  raw.subject = "new"_ns;
  FolderRepairMessage item{&raw, "unique"_ns, 9, 2, true};
  RefPtr<Message> sentinel = new Message(key);
  nsTArray<RefPtr<Message>> output{sentinel};
  nsTArray<FolderRepairMessage> items{item, item};
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.CompleteFolderRepair(snapshot, items, NS_OK, true, output));
  items.Clear();
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.CompleteFolderRepair(snapshot, items, NS_OK, true, output));
  items = {item};
  items[0].storeToken = "unknown"_ns;
  raw.key = key;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.CompleteFolderRepair(snapshot, items, NS_OK, true, output));
  items = {item};
  items[0].messageSize = uint64_t(UINT32_MAX) + 1;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.CompleteFolderRepair(snapshot, items, NS_OK, true, output));
  items = {item};
  raw.messageSize = Some(1u);
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.CompleteFolderRepair(snapshot, items, NS_OK, true, output));
  raw.messageSize.reset();
  raw.storeToken = Some(nsCString("different"_ns));
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.CompleteFolderRepair(snapshot, items, NS_OK, true, output));
  raw.storeToken.reset();
  raw.references = {"actual"_ns};
  items[0].referencesKnown = false;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.CompleteFolderRepair(snapshot, items, NS_OK, true, output));
  ASSERT_EQ(1u, output.Length());
  EXPECT_EQ(sentinel.get(), output[0].get());
  ASSERT_TRUE(snapshot.Messages());
  EXPECT_EQ(1u, snapshot.Messages()->Length());
  raw.references.Clear();
  items[0].referencesKnown = true;
  ASSERT_EQ(NS_OK,
            db.CompleteFolderRepair(snapshot, items, NS_OK, true, output));
  FolderRepairSnapshot occupied;
  ASSERT_EQ(NS_OK, CaptureRepair(mFolderId, occupied));
  nsMsgKey other;
  ASSERT_EQ(NS_OK, AddRepairRow(mFolderId, "unique"_ns, other));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, CaptureRepair(mFolderId, occupied));
  ASSERT_TRUE(occupied.Messages());
  EXPECT_EQ(1u, occupied.Messages()->Length());
}

TEST_F(DeliveryCoreReferences, FolderRepairScanErrorAndIncompleteLeaveCustody) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, AddRepairRow(mFolderId, "scan"_ns, key));
  FolderRepairSnapshot snapshot;
  ASSERT_EQ(NS_OK, CaptureRepair(mFolderId, snapshot));
  RawHdr raw;
  raw.subject = "after"_ns;
  nsTArray<FolderRepairMessage> items{{&raw, "scan"_ns, 8, 2, true}};
  RefPtr<Message> sentinel = new Message(key);
  nsTArray<RefPtr<Message>> output{sentinel};
  uint32_t calls = 0;
  RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
  observer->action = [&](char, const CapturedMessage&, const CapturedMessage&,
                         Message*, bool) { ++calls; };
  db.AddMessageListener(observer);
  auto remove = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            db.CompleteFolderRepair(snapshot, items, NS_ERROR_FILE_CORRUPTED,
                                    true, output));
  EXPECT_EQ(
      NS_ERROR_ABORT,
      db.CompleteFolderRepair(snapshot, items, NS_ERROR_ABORT, false, output));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.CompleteFolderRepair(snapshot, items, NS_OK, false, output));
  EXPECT_EQ(0u, calls);
  ASSERT_TRUE(snapshot.Messages());
  ASSERT_EQ(1u, output.Length());
  EXPECT_EQ(sentinel.get(), output[0].get());
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageSubject(key, text));
  EXPECT_EQ("old subject"_ns, text);
  int64_t valid = -1;
  ASSERT_EQ(NS_OK, ReadFolderProperty(&mCore->FolderDB(), mFolderId,
                                      "summaryValid"_ns, valid));
  EXPECT_EQ(0, valid);
  ASSERT_EQ(NS_OK,
            db.CompleteFolderRepair(snapshot, items, NS_OK, true, output));
  EXPECT_EQ(1u, calls);
}

TEST_F(DeliveryCoreReferences,
       FolderRepairRejectsChangedAssociationAndOldOwner) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, AddRepairRow(mFolderId, "original"_ns, key));
  FolderRepairSnapshot snapshot;
  ASSERT_EQ(NS_OK, CaptureRepair(mFolderId, snapshot));
  RawHdr raw;
  raw.subject = "must not publish"_ns;
  nsTArray<FolderRepairMessage> items{{&raw, "original"_ns, 8, 2, true}};
  nsTArray<RefPtr<Message>> output;
  ASSERT_EQ(NS_OK, db.SetMessageStoreToken(key, "changed"_ns));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.CompleteFolderRepair(snapshot, items, NS_OK, true, output));
  ASSERT_EQ(NS_OK, db.SetMessageStoreToken(key, "original"_ns));
  // Returning to the old spelling does not restore the captured revision.
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.CompleteFolderRepair(snapshot, items, NS_OK, true, output));
  ASSERT_TRUE(snapshot.Messages());
  FolderRepairSnapshot current;
  ASSERT_EQ(NS_OK, CaptureRepair(mFolderId, current));
  nsMsgKey extra;
  ASSERT_EQ(NS_OK, AddRepairRow(mFolderId, "extra"_ns, extra));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.CompleteFolderRepair(current, items, NS_OK, true, output));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, mCore->MessageDB().CompleteFolderRepair(
                                        current, items, NS_OK, true, output));
  EXPECT_TRUE(output.IsEmpty());
  nsCString text;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageSubject(key, text));
  EXPECT_EQ("old subject"_ns, text);
  int64_t valid = -1;
  ASSERT_EQ(NS_OK, ReadFolderProperty(&mCore->FolderDB(), mFolderId,
                                      "summaryValid"_ns, valid));
  EXPECT_EQ(0, valid);
}

TEST_F(DeliveryCoreReferences, FolderRepairReferencesPresenceAndReopen) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey first, second;
  ASSERT_EQ(NS_OK, AddRepairRow(mFolderId, "absent"_ns, first));
  ASSERT_EQ(NS_OK, AddRepairRow(mFolderId, "known-empty"_ns, second));
  FolderRepairSnapshot snapshot;
  ASSERT_EQ(NS_OK, CaptureRepair(mFolderId, snapshot));
  RawHdr raw;
  raw.subject = "parsed"_ns;
  nsTArray<FolderRepairMessage> items{{&raw, "absent"_ns, 10, 3, false},
                                      {&raw, "known-empty"_ns, 11, 4, true}};
  nsTArray<RefPtr<Message>> output;
  ASSERT_EQ(NS_OK,
            db.CompleteFolderRepair(snapshot, items, NS_OK, true, output));
  output.Clear();
  Stop();
  ASSERT_EQ(NS_OK, Start());
  nsTArray<nsCString> refs{"sentinel"_ns};
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->MessageDB().GetMessageReferences(first, refs));
  EXPECT_EQ((nsTArray<nsCString>{"sentinel"_ns}), refs);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(second, refs));
  EXPECT_TRUE(refs.IsEmpty());
  MessageBodyState body;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageBodyState(first, body));
  ASSERT_TRUE(body.storeToken);
  EXPECT_EQ("absent"_ns, *body.storeToken);
  EXPECT_EQ(10u, body.messageSize);
  int64_t valid = -1, force = -1;
  ASSERT_EQ(NS_OK, ReadFolderProperty(&mCore->FolderDB(), mFolderId,
                                      "summaryValid"_ns, valid));
  ASSERT_EQ(NS_OK, ReadFolderProperty(&mCore->FolderDB(), mFolderId,
                                      "forceReparse"_ns, force));
  EXPECT_EQ(1, valid);
  EXPECT_EQ(0, force);
}

TEST_F(DeliveryCoreReferences, FolderRepairRejectsCallerTransactionAndStaging) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, AddRepairRow(mFolderId, "caller"_ns, key));
  FolderRepairSnapshot snapshot;
  ASSERT_EQ(NS_OK, CaptureRepair(mFolderId, snapshot));
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  FolderRepairSnapshot untouched;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.CaptureFolderRepair(mFolderId, source, untouched));
  RawHdr raw;
  nsTArray<FolderRepairMessage> items{{&raw, "caller"_ns, 7, 1, true}};
  nsTArray<RefPtr<Message>> output;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.CompleteFolderRepair(snapshot, items, NS_OK, true, output));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  EXPECT_FALSE(untouched.Messages());
  ASSERT_TRUE(snapshot.Messages());
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  rollback.release();
  nsMsgKey staged;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.CaptureFolderRepair(mFolderId, source, untouched));
  ASSERT_EQ(NS_OK, db.AbortMessage(staged));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.CaptureFolderRepair(mFolderId, "foreign"_ns, untouched));
  ASSERT_EQ(NS_OK,
            db.CompleteFolderRepair(snapshot, items, NS_OK, true, output));
}

TEST_F(DeliveryCoreReferences,
       FolderRepairWriteSummaryAndCommitFailuresRollback) {
  ASSERT_EQ(NS_OK, Start());
  for (uint32_t mode = 0; mode < 4; ++mode) {
    SCOPED_TRACE(mode);
    auto& db = mCore->MessageDB();
    nsAutoCString name("RepairFault");
    name.AppendInt(mode);
    uint64_t folder;
    ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, name, &folder));
    nsMsgKey key;
    ASSERT_EQ(NS_OK, AddRepairRow(folder, "fault-source"_ns, key));
    FolderRepairSnapshot snapshot;
    ASSERT_EQ(NS_OK, CaptureRepair(folder, snapshot));
    RefPtr<Message> hot = new Message(key);
    nsCString text;
    ASSERT_EQ(NS_OK, hot->GetSubject(text));
    uint64_t watermark;
    ASSERT_EQ(NS_OK, SearchWatermark(watermark));
    if (mode == 0) {
      ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "CREATE TEMP TRIGGER repair_fault BEFORE UPDATE OF "
                           "subject ON main.messages "
                           "BEGIN SELECT RAISE(ABORT,'repair row'); END"_ns));
    } else if (mode == 1) {
      ASSERT_EQ(
          NS_OK,
          mConnection->ExecuteSimpleSQL(
              "CREATE TEMP TRIGGER repair_fault BEFORE INSERT ON "
              "main.message_properties "
              "WHEN NEW.name='messageSize' BEGIN SELECT RAISE(ABORT,'repair property'); END"_ns));
    } else if (mode == 2) {
      ASSERT_EQ(NS_OK,
                mConnection->ExecuteSimpleSQL(
                    "CREATE TEMP TRIGGER repair_fault BEFORE UPDATE ON "
                    "main.folder_properties "
                    "WHEN NEW.name='summaryValid' AND NEW.value=1 "
                    "BEGIN SELECT RAISE(ABORT,'repair summary'); END"_ns));
    } else {
      // A real deferred constraint reaches commit failure after all row writes.
      ASSERT_EQ(NS_OK,
                mConnection->ExecuteSimpleSQL(
                    "PRAGMA foreign_keys=ON; CREATE TEMP TABLE "
                    "repair_parent(id INTEGER PRIMARY KEY); "
                    "CREATE TEMP TABLE repair_child(id INTEGER REFERENCES "
                    "repair_parent(id) "
                    "DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER "
                    "repair_fault "
                    "AFTER INSERT ON main.message_properties WHEN "
                    "NEW.name='messageSize' "
                    "BEGIN INSERT INTO repair_child VALUES(NEW.id); END"_ns));
    }
    auto drop = MakeScopeExit([&] {
      EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "DROP TRIGGER IF EXISTS repair_fault"_ns));
    });
    RawHdr parsed, fresh;
    parsed.subject = "after repair"_ns;
    fresh.subject = "new row"_ns;
    nsTArray<FolderRepairMessage> items{
        {&parsed, "fault-source"_ns, 18, 3, true},
        {&fresh, "fresh-token"_ns, 22, 4, true}};
    if (mode == 3) {
      // Foreign-key enforcement also rejects the existing native zero-parent
      // convention for new rows. Exercise deferred commit failure on the
      // existing row; the other three modes retain fresh-key rollback checks.
      items.RemoveLastElement();
    }
    const uint32_t repairedCount = items.Length();
    nsTArray<RefPtr<Message>> output{hot};
    uint32_t calls = 0;
    RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
    observer->action = [&](char, const CapturedMessage&, const CapturedMessage&,
                           Message*, bool) { ++calls; };
    db.AddMessageListener(observer);
    auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
              db.CompleteFolderRepair(snapshot, items, NS_OK, true, output));
    EXPECT_EQ(0u, calls);
    bool active = true;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    ASSERT_EQ(1u, output.Length());
    EXPECT_EQ(hot.get(), output[0].get());
    ASSERT_TRUE(snapshot.Messages());
    ASSERT_EQ(NS_OK, hot->GetSubject(text));
    EXPECT_EQ("old subject"_ns, text);
    uint64_t after;
    ASSERT_EQ(NS_OK, SearchWatermark(after));
    EXPECT_EQ(watermark, after);
    int64_t valid = -1;
    ASSERT_EQ(NS_OK, ReadFolderProperty(&mCore->FolderDB(), folder,
                                        "summaryValid"_ns, valid));
    EXPECT_EQ(0, valid);
    ASSERT_EQ(
        NS_OK,
        PublicationCell(
            mConnection, key,
            "SELECT count(*) FROM messages WHERE folderId=(SELECT folderId FROM messages WHERE id=:id)"_ns,
            text));
    EXPECT_EQ("1"_ns, text);
    ASSERT_EQ(NS_OK,
              mConnection->ExecuteSimpleSQL("DROP TRIGGER repair_fault"_ns));
    drop.release();
    ASSERT_EQ(NS_OK,
              db.CompleteFolderRepair(snapshot, items, NS_OK, true, output));
    EXPECT_EQ(repairedCount, calls);
    ASSERT_EQ(repairedCount, output.Length());
    nsMsgKey repairedKey;
    ASSERT_EQ(NS_OK, output[0]->GetMessageKey(&repairedKey));
    EXPECT_EQ(key, repairedKey);
    if (mode != 3) {
      nsMsgKey freshKey;
      ASSERT_EQ(NS_OK, output[1]->GetMessageKey(&freshKey));
      EXPECT_EQ(nsMsgKey(key + 1), freshKey);
    }
    db.RemoveMessageListener(observer);
    unwatch.release();
    output.Clear();
    hot = nullptr;
    Stop();
    ASSERT_EQ(NS_OK, Start());
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageSubject(key, text));
    EXPECT_EQ("after repair"_ns, text);
    ASSERT_EQ(NS_OK, ReadFolderProperty(&mCore->FolderDB(), folder,
                                        "summaryValid"_ns, valid));
    EXPECT_EQ(1, valid);
  }
}

TEST_F(DeliveryCoreReferences,
       FolderRepairQueuesReentrantWritesAfterWholeBatch) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, AddRepairRow(mFolderId, "queue-source"_ns, key));
  FolderRepairSnapshot snapshot;
  ASSERT_EQ(NS_OK, CaptureRepair(mFolderId, snapshot));
  RawHdr parsed, fresh;
  parsed.subject = "settled"_ns;
  nsTArray<FolderRepairMessage> items{{&parsed, "queue-source"_ns, 8, 2, true},
                                      {&fresh, "queue-new"_ns, 9, 3, true}};
  nsTArray<RefPtr<Message>> output;
  nsTArray<char> order;
  nsMsgKey reentrant = nsMsgKey_None;
  RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
  observer->action = [&](char kind, const CapturedMessage&,
                         const CapturedMessage& after, Message*, bool) {
    order.AppendElement(kind);
    ASSERT_EQ(2u, output.Length());
    EXPECT_FALSE(snapshot.Messages());
    if (kind == 'B') {
      EXPECT_EQ(key, after.id);
      EXPECT_EQ("settled"_ns, after.subject);
      RawHdr nested;
      ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, nested, true, &reentrant));
      EXPECT_EQ(1u, order.Length());
    }
  };
  db.AddMessageListener(observer);
  auto remove = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK,
            db.CompleteFolderRepair(snapshot, items, NS_OK, true, output));
  EXPECT_EQ((nsTArray<char>{'B', 'P', 'P'}), order);
  EXPECT_NE(nsMsgKey_None, reentrant);
}

TEST_F(DeliveryCoreReferences, NewsReadSetColdSyncAndReopen) {
  RefPtr<nsMsgKeySet> set = nsMsgKeySet::Create("2,7-9");
  ASSERT_TRUE(set);
  ASSERT_GE(set->Add(0), 0);
  RefPtr<PerFolderDatabase> owner;
  nsCString source;
  ASSERT_EQ(NS_OK, StartNews(owner, source, set));
  auto& db = mCore->MessageDB();
  NewsArticleIdentity article;
  ASSERT_EQ(NS_OK, NewsArticle(source, mFolderId, 7, article));
  NewsGroupIdentity original = article.group;
  RawHdr raw;
  raw.flags = nsMsgMessageFlags::Marked | 0x80000000u;
  NewsArticleResult result;
  ASSERT_EQ(NS_OK, db.AddNewsArticle(article, raw, true, result));
  uint32_t flags;
  ASSERT_EQ(NS_OK, db.GetMessageFlags(result.physicalKey, flags));
  EXPECT_EQ(raw.flags | nsMsgMessageFlags::Read, flags);
  ASSERT_GE(set->Remove(7), 0);
  ASSERT_EQ(NS_OK, owner->SetReadSet(set));  // Same pointer, changed contents.
  ASSERT_EQ(NS_OK, db.GetMessageFlags(result.physicalKey, flags));
  EXPECT_EQ(raw.flags, flags);
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(
      NS_OK,
      mConnection->CreateStatement(
          "SELECT r.value,z.value FROM folder_properties r JOIN "
          "folder_properties z "
          "ON z.id=r.id AND z.name='readSetContainsZero' WHERE r.name='readSet'"_ns,
          getter_AddRefs(stmt)));
  bool more;
  ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
  ASSERT_TRUE(more);
  nsCString text;
  int64_t zero;
  ASSERT_EQ(NS_OK, stmt->GetUTF8String(0, text));
  ASSERT_EQ(NS_OK, stmt->GetInt64(1, &zero));
  EXPECT_EQ(1, zero);
  stmt = nullptr;
  nsMsgKey key = result.physicalKey;
  owner = nullptr;
  result.header = nullptr;
  Stop();
  ASSERT_EQ(NS_OK, Start());
  NewsGroupIdentity reopened;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetNewsGroupIdentity(source, mFolderId,
                                                           reopened));
  EXPECT_EQ(original.incarnation, reopened.incarnation);
  RefPtr<nsMsgKeySet> restored = nsMsgKeySet::Create(text.get());
  ASSERT_TRUE(restored);
  EXPECT_FALSE(
      restored->IsMember(0));  // Lossy file parse, not exact native state.
  owner = new PerFolderDatabase(mFolderId, true);
  ASSERT_EQ(NS_OK, owner->InitializeNewsReadSetFromNewsrc(restored, text));
  EXPECT_TRUE(restored->IsMember(0));
  EXPECT_FALSE(restored->IsMember(7));
  nsMsgKey found = nsMsgKey_None;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetNewsArticleKey(article, found));
  EXPECT_EQ(key, found);
  // Zero-only and empty have identical legacy file text.
  RefPtr<nsMsgKeySet> zeroOnly = nsMsgKeySet::Create();
  ASSERT_GE(zeroOnly->Add(0), 0);
  ASSERT_EQ(NS_OK, owner->SetReadSet(zeroOnly));
  RefPtr<nsMsgKeySet> emptyFile = nsMsgKeySet::Create("");
  EXPECT_FALSE(emptyFile->IsMember(0));
  ASSERT_EQ(NS_OK, owner->InitializeNewsReadSetFromNewsrc(emptyFile, ""_ns));
  EXPECT_TRUE(emptyFile->IsMember(0));
  RefPtr<nsMsgKeySet> explicitEmpty = nsMsgKeySet::Create("");
  ASSERT_EQ(NS_OK, owner->SetReadSet(explicitEmpty));
  EXPECT_FALSE(
      explicitEmpty->IsMember(0));  // Explicit same text is authoritative.
  // Opposite lossy case: range 1 parses zero as read, checkpoint says unread.
  RefPtr<nsMsgKeySet> one = nsMsgKeySet::Create("1");
  ASSERT_GE(one->Remove(0), 0);
  ASSERT_EQ(NS_OK, owner->SetReadSet(one));
  RefPtr<nsMsgKeySet> oneFile = nsMsgKeySet::Create("1");
  EXPECT_TRUE(oneFile->IsMember(0));
  ASSERT_EQ(NS_OK, owner->InitializeNewsReadSetFromNewsrc(oneFile, "1"_ns));
  EXPECT_FALSE(oneFile->IsMember(0));
  EXPECT_TRUE(oneFile->IsMember(1));
  RefPtr<nsMsgKeySet> changedFile = nsMsgKeySet::Create("01");
  EXPECT_TRUE(changedFile->IsMember(0));
  ASSERT_EQ(NS_OK,
            owner->InitializeNewsReadSetFromNewsrc(changedFile, "01"_ns));
  EXPECT_TRUE(changedFile->IsMember(0));  // Exact syntax changed; no match.
  EXPECT_TRUE(changedFile->IsMember(1));
}

TEST_F(DeliveryCoreReferences,
       NewsReadSetLiveFlagsKeepProtocolAndPhysicalIdentityDistinct) {
  RefPtr<nsMsgKeySet> set = nsMsgKeySet::Create();
  RefPtr<PerFolderDatabase> owner;
  nsCString source;
  ASSERT_EQ(NS_OK, StartNews(owner, source, set));
  auto& db = mCore->MessageDB();
  NewsArticleIdentity article;
  ASSERT_EQ(NS_OK, NewsArticle(source, mFolderId, 9000, article));
  RawHdr raw;
  raw.flags = nsMsgMessageFlags::Marked | 0x80000000u;
  raw.references = {"one"_ns, "two"_ns, "one"_ns};
  NewsArticleResult result;
  ASSERT_EQ(NS_OK, db.AddNewsArticle(article, raw, true, result));
  ASSERT_NE(article.articleNumber, result.physicalKey);
  nsMsgKeySet* borrowed = nullptr;
  ASSERT_EQ(NS_OK, owner->GetReadSet(&borrowed));
  ASSERT_EQ(set.get(), borrowed);
  ASSERT_EQ(NS_OK,
            result.header->SetFlags(raw.flags | nsMsgMessageFlags::Read));
  EXPECT_TRUE(set->IsMember(9000));
  EXPECT_FALSE(set->IsMember(result.physicalKey));
  ASSERT_EQ(NS_OK, db.SetMessageFlags(result.physicalKey, raw.flags));
  EXPECT_FALSE(set->IsMember(9000));
  uint32_t flags;
  ASSERT_EQ(NS_OK, db.GetMessageFlags(result.physicalKey, flags));
  EXPECT_EQ(raw.flags, flags);
  nsTArray<nsCString> references;
  ASSERT_EQ(NS_OK, db.GetMessageReferences(result.physicalKey, references));
  EXPECT_EQ(raw.references, references);
  EXPECT_EQ(
      NS_ERROR_INVALID_ARG,
      db.SetMessageProperty(result.physicalKey, "newsArticleNumber"_ns, 17u));
  // Present read intent wins in both directions, preserving unrelated words.
  NewsArticleIdentity readArticle;
  ASSERT_EQ(NS_OK, NewsArticle(source, mFolderId, 9001, readArticle));
  NewsArticleResult marked;
  ASSERT_EQ(NS_OK, db.AddNewsArticle(readArticle, raw, true, marked, nullptr,
                                     Some(true)));
  ASSERT_EQ(NS_OK, db.GetMessageFlags(marked.physicalKey, flags));
  EXPECT_EQ(raw.flags | nsMsgMessageFlags::Read, flags);
  EXPECT_TRUE(set->IsMember(9001));
  ASSERT_GE(set->Add(9002), 0);
  ASSERT_EQ(NS_OK, owner->SetReadSet(set));
  NewsArticleIdentity unreadArticle;
  ASSERT_EQ(NS_OK, NewsArticle(source, mFolderId, 9002, unreadArticle));
  const uint32_t unreadFlags = raw.flags;
  raw.flags |= nsMsgMessageFlags::Read;
  NewsArticleResult unmarked;
  ASSERT_EQ(NS_OK, db.AddNewsArticle(unreadArticle, raw, true, unmarked,
                                     nullptr, Some(false)));
  ASSERT_EQ(NS_OK, db.GetMessageFlags(unmarked.physicalKey, flags));
  EXPECT_EQ(unreadFlags, flags);
  EXPECT_FALSE(set->IsMember(9002));
  EXPECT_TRUE(set->IsMember(9001));
  ASSERT_EQ(NS_OK, db.GetMessageReferences(unmarked.physicalKey, references));
  EXPECT_EQ(raw.references, references);
}

TEST_F(DeliveryCoreReferences, NewsReadSetBulkReadPublishesCompleteSet) {
  RefPtr<nsMsgKeySet> set = nsMsgKeySet::Create();
  RefPtr<PerFolderDatabase> owner;
  nsCString source;
  ASSERT_EQ(NS_OK, StartNews(owner, source, set));
  auto& db = mCore->MessageDB();
  nsTArray<nsMsgKey> keys;
  for (uint32_t number : {0u, 20u, 2147483647u}) {
    NewsArticleIdentity article;
    ASSERT_EQ(NS_OK, NewsArticle(source, mFolderId, number, article));
    NewsArticleResult result;
    ASSERT_EQ(NS_OK, db.AddNewsArticle(article, RawHdr{}, true, result));
    keys.AppendElement(result.physicalKey);
  }
  nsTArray<nsMsgKey> marked;
  uint32_t callbacks = 0;
  RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
  observer->action = [&](char kind, const CapturedMessage&,
                         const CapturedMessage&, Message*, bool) {
    EXPECT_EQ('F', kind);
    ++callbacks;
    EXPECT_EQ(keys, marked);
    EXPECT_TRUE(set->IsMember(0));
    EXPECT_TRUE(set->IsMember(20));
    EXPECT_TRUE(set->IsMember(INT32_MAX));
    bool active = true;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
  };
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, MarkFolderRead(mFolderId, marked));
  EXPECT_EQ(3u, callbacks);
  EXPECT_EQ(keys, marked);
}

TEST_F(DeliveryCoreReferences,
       NewsReadSetPreparationReadWriteAndCommitFailuresRollback) {
  for (bool commitFailure : {false, true}) {
    RefPtr<nsMsgKeySet> set = nsMsgKeySet::Create();
    RefPtr<PerFolderDatabase> owner;
    nsCString source;
    ASSERT_EQ(NS_OK, StartNews(owner, source, set));
    auto& db = mCore->MessageDB();
    NewsArticleIdentity article;
    ASSERT_EQ(NS_OK, NewsArticle(source, mFolderId, 23, article));
    NewsArticleResult result;
    ASSERT_EQ(NS_OK, db.AddNewsArticle(article, RawHdr{}, true, result));
    RefPtr<CaptureReadAbort> readFault = new CaptureReadAbort();
    nsCOMPtr<mozIStorageProgressHandler> previous;
    ASSERT_EQ(NS_OK, mConnection->SetProgressHandler(1, readFault,
                                                     getter_AddRefs(previous)));
    EXPECT_FALSE(previous);
    NewsGroupIdentity unchanged{"sentinel"_ns, 999, "unchanged"_ns};
    EXPECT_EQ(NS_ERROR_ABORT,
              db.GetNewsGroupIdentity(source, mFolderId, unchanged));
    EXPECT_EQ("unchanged"_ns, unchanged.incarnation);
    EXPECT_EQ(999u, unchanged.folderId);
    EXPECT_EQ(1u, readFault->mAborts);
    readFault->mAborts = 0;
    Maybe<bool> zero = Some(true);
    EXPECT_EQ(NS_ERROR_ABORT, ReadNewsZero(source, mFolderId, ""_ns, zero));
    EXPECT_EQ(Some(true), zero);
    EXPECT_EQ(1u, readFault->mAborts);
    nsCOMPtr<mozIStorageProgressHandler> removed;
    ASSERT_EQ(NS_OK,
              mConnection->RemoveProgressHandler(getter_AddRefs(removed)));
    EXPECT_EQ(readFault.get(), removed.get());
    ASSERT_EQ(NS_OK, WriteFolderProperty(&mCore->FolderDB(), mFolderId,
                                         "readSetContainsZero"_ns, "bad"_ns));
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
              ReadNewsZero(source, mFolderId, ""_ns, zero));
    EXPECT_EQ(Some(true), zero);
    ASSERT_EQ(NS_OK, WriteFolderProperty(&mCore->FolderDB(), mFolderId,
                                         "readSetContainsZero"_ns, int64_t(0)));
    ASSERT_GE(set->Add(0), 0);
    ASSERT_EQ(NS_OK, owner->SetReadSet(set));  // Exact zero-only checkpoint.
    if (commitFailure) {
      ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "PRAGMA foreign_keys=ON; CREATE TEMP TABLE "
                           "news_parent(id INTEGER PRIMARY KEY);"
                           "CREATE TEMP TABLE news_child(id INTEGER REFERENCES "
                           "news_parent(id) "
                           "DEFERRABLE INITIALLY DEFERRED); CREATE TEMP "
                           "TRIGGER news_write_fault "
                           "AFTER INSERT ON main.folder_properties WHEN "
                           "NEW.name='readSet' BEGIN "
                           "INSERT INTO news_child VALUES(999); END"_ns));
    } else {
      ASSERT_EQ(
          NS_OK,
          mConnection->ExecuteSimpleSQL(
              "CREATE TEMP TRIGGER news_write_fault BEFORE INSERT ON "
              "main.folder_properties "
              "WHEN NEW.name='readSet' BEGIN SELECT RAISE(FAIL,'news checkpoint'); END"_ns));
    }
    uint32_t callbacks = 0;
    RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
    observer->action = [&](char, const CapturedMessage&, const CapturedMessage&,
                           Message*, bool) { ++callbacks; };
    db.AddMessageListener(observer);
    EXPECT_EQ(
        NS_ERROR_STORAGE_CONSTRAINT,
        db.SetMessageFlag(result.physicalKey, nsMsgMessageFlags::Read, true));
    EXPECT_FALSE(set->IsMember(23));
    uint32_t flags;
    ASSERT_EQ(NS_OK, db.GetMessageFlags(result.physicalKey, flags));
    EXPECT_FALSE(flags & nsMsgMessageFlags::Read);
    EXPECT_EQ(0u, callbacks);
    RefPtr<nsMsgKeySet> replacement = nsMsgKeySet::Create("23");
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, owner->SetReadSet(replacement));
    nsMsgKeySet* borrowed = nullptr;
    ASSERT_EQ(NS_OK, owner->GetReadSet(&borrowed));
    EXPECT_EQ(set.get(), borrowed);
    EXPECT_TRUE(replacement->IsMember(23));
    EXPECT_EQ(0u, callbacks);
    // Checkpoint write/commit failure rolls back typed filter intent too.
    NewsArticleIdentity failedArticle = article;
    failedArticle.articleNumber = 24;
    NewsArticleResult failedOutput = result;
    nsCOMPtr<nsIMsgDBHdr> failedHeader;
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
              db.AddNewsArticle(failedArticle, RawHdr{}, true, failedOutput,
                                getter_AddRefs(failedHeader), Some(true)));
    EXPECT_FALSE(failedHeader);
    EXPECT_EQ(result.header, failedOutput.header);
    EXPECT_EQ(result.physicalKey, failedOutput.physicalKey);
    EXPECT_EQ(result.inserted, failedOutput.inserted);
    EXPECT_FALSE(set->IsMember(24));
    EXPECT_FALSE(set->IsMember(23));
    EXPECT_EQ(0u, callbacks);
    nsMsgKey absent = 12345;
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.GetNewsArticleKey(failedArticle, absent));
    EXPECT_EQ(12345u, absent);
    RefPtr<nsMsgKeySet> passive = nsMsgKeySet::Create("");
    EXPECT_FALSE(passive->IsMember(0));
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
              owner->InitializeNewsReadSetFromNewsrc(passive, ""_ns));
    EXPECT_FALSE(
        passive->IsMember(0));  // Prepared zero correction never escaped.
    EXPECT_TRUE(set->IsMember(0));
    ASSERT_EQ(NS_OK, owner->GetReadSet(&borrowed));
    EXPECT_EQ(set.get(), borrowed);
    EXPECT_EQ(0u, callbacks);
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER news_write_fault"_ns));
    ASSERT_EQ(NS_OK, db.SetMessageFlag(result.physicalKey,
                                       nsMsgMessageFlags::Read, true));
    EXPECT_TRUE(set->IsMember(23));
    db.RemoveMessageListener(observer);
    owner = nullptr;
    result.header = nullptr;
    Stop();
  }
}

TEST_F(DeliveryCoreReferences,
       NewsReadSetForeignClosedAndCallerTransactionsPreserveOutputs) {
  RefPtr<nsMsgKeySet> set = nsMsgKeySet::Create("4");
  RefPtr<PerFolderDatabase> owner;
  nsCString source;
  ASSERT_EQ(NS_OK, StartNews(owner, source, set));
  auto& db = mCore->MessageDB();
  NewsGroupIdentity unchanged{"unchanged"_ns, 123, "original"_ns};
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetNewsGroupIdentity("foreign"_ns, mFolderId, unchanged));
  EXPECT_EQ("original"_ns, unchanged.incarnation);
  Maybe<bool> zero = Some(true);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            ReadNewsZero("foreign"_ns, mFolderId, "4"_ns, zero));
  EXPECT_EQ(Some(true), zero);
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, owner->SetReadSet(set));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            ReadNewsZero(source, mFolderId, "4"_ns, zero));
  EXPECT_EQ(Some(true), zero);
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            owner->InitializeNewsReadSetFromNewsrc(set, "4"_ns));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.GetNewsGroupIdentity(source, mFolderId, unchanged));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_EQ(NS_OK, owner->ForceClosed());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, owner->SetReadSet(set));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            owner->InitializeNewsReadSetFromNewsrc(set, "4"_ns));
  EXPECT_TRUE(set->IsMember(4));
}

TEST_F(DeliveryCoreReferences,
       NewsArticleBindingBoundsPresenceDuplicatesAndStaging) {
  RefPtr<nsMsgKeySet> set = nsMsgKeySet::Create();
  ASSERT_GE(set->Add(0), 0);
  RefPtr<PerFolderDatabase> owner;
  nsCString source;
  ASSERT_EQ(NS_OK, StartNews(owner, source, set));
  auto& db = mCore->MessageDB();
  NewsArticleIdentity zero;
  ASSERT_EQ(NS_OK, NewsArticle(source, mFolderId, 0, zero));
  NewsArticleResult result;
  ASSERT_EQ(NS_OK, db.AddNewsArticle(zero, RawHdr{}, true, result));
  EXPECT_TRUE(result.inserted);
  uint32_t flags;
  ASSERT_EQ(NS_OK, db.GetMessageFlags(result.physicalKey, flags));
  EXPECT_TRUE(flags & nsMsgMessageFlags::Read);
  NewsArticleResult duplicate;
  ASSERT_EQ(NS_OK, db.AddNewsArticle(zero, RawHdr{}, true, duplicate));
  EXPECT_FALSE(duplicate.inserted);
  EXPECT_EQ(result.physicalKey, duplicate.physicalKey);
  NewsArticleIdentity invalid = zero;
  invalid.articleNumber = uint32_t(INT32_MAX) + 1;
  nsMsgKey output = 12345;
  EXPECT_EQ(NS_ERROR_INVALID_ARG, db.GetNewsArticleKey(invalid, output));
  EXPECT_EQ(12345u, output);
  NewsArticleResult unchanged = duplicate;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.AddNewsArticle(invalid, RawHdr{}, true, unchanged));
  EXPECT_EQ(duplicate.physicalKey, unchanged.physicalKey);
  invalid = zero;
  invalid.group.incarnation = "foreign"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.GetNewsArticleKey(invalid, output));
  NewsArticleIdentity maximum = zero;
  maximum.articleNumber = INT32_MAX;
  NewsArticleResult maximumResult;
  ASSERT_EQ(NS_OK, db.AddNewsArticle(maximum, RawHdr{}, true, maximumResult));
  nsMsgKey selected = nsMsgKey_None;
  ASSERT_EQ(NS_OK, db.GetNewsArticleKey(maximum, selected));
  EXPECT_EQ(maximumResult.physicalKey, selected);
  ASSERT_EQ(NS_OK, db.GetNewsArticleKey(zero, selected));
  EXPECT_EQ(result.physicalKey, selected);
  NewsArticleIdentity missing = zero;
  missing.articleNumber = 1;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.GetNewsArticleKey(missing, output));
  EXPECT_EQ(12345u, output);

  // A targeted lookup must not hide malformed bindings on another article.
  for (const char* value : {"NULL", "'bad'", "X'00'", "-1", "2147483648"}) {
    nsAutoCString update("UPDATE message_properties SET value=");
    update.Append(value);
    update.AppendLiteral(" WHERE name='newsArticleNumber' AND id=");
    update.AppendInt(maximumResult.physicalKey);
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(update));
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, db.GetNewsArticleKey(zero, output));
    EXPECT_EQ(12345u, output);
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, db.GetNewsArticleKey(missing, output));
    EXPECT_EQ(12345u, output);
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
              db.AddNewsArticle(missing, RawHdr{}, true, unchanged));
    EXPECT_EQ(duplicate.physicalKey, unchanged.physicalKey);
    EXPECT_EQ(duplicate.header, unchanged.header);
    EXPECT_EQ(duplicate.inserted, unchanged.inserted);
  }
  nsAutoCString restoreArticle(
      "UPDATE message_properties SET value=2147483647 "
      "WHERE name='newsArticleNumber' AND id=");
  restoreArticle.AppendInt(maximumResult.physicalKey);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(restoreArticle));
  for (const char* value : {"NULL", "1", "'foreign'"}) {
    nsAutoCString update("UPDATE message_properties SET value=");
    update.Append(value);
    update.AppendLiteral(" WHERE name='newsGroupIncarnation' AND id=");
    update.AppendInt(maximumResult.physicalKey);
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(update));
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, db.GetNewsArticleKey(zero, output));
    EXPECT_EQ(12345u, output);
  }
  nsAutoCString removeGroup("DELETE FROM message_properties WHERE id=");
  removeGroup.AppendInt(maximumResult.physicalKey);
  removeGroup.AppendLiteral(" AND name='newsGroupIncarnation'");
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(removeGroup));
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, db.GetNewsArticleKey(zero, output));
  EXPECT_EQ(12345u, output);
  nsAutoCString restoreGroup(
      "INSERT INTO message_properties(id,name,value) SELECT ");
  restoreGroup.AppendInt(maximumResult.physicalKey);
  restoreGroup.AppendLiteral(",name,value FROM message_properties WHERE id=");
  restoreGroup.AppendInt(result.physicalKey);
  restoreGroup.AppendLiteral(" AND name='newsGroupIncarnation'");
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(restoreGroup));
  nsAutoCString removeArticle("DELETE FROM message_properties WHERE id=");
  removeArticle.AppendInt(maximumResult.physicalKey);
  removeArticle.AppendLiteral(" AND name='newsArticleNumber'");
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(removeArticle));
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, db.GetNewsArticleKey(zero, output));
  EXPECT_EQ(12345u, output);
  nsAutoCString restoreMissingArticle(
      "INSERT INTO message_properties(id,name,value) VALUES (");
  restoreMissingArticle.AppendInt(maximumResult.physicalKey);
  restoreMissingArticle.AppendLiteral(", 'newsArticleNumber', 2147483647)");
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(restoreMissingArticle));
  ASSERT_EQ(NS_OK, db.GetNewsArticleKey(zero, selected));
  EXPECT_EQ(result.physicalKey, selected);
  ASSERT_EQ(NS_OK, db.GetNewsArticleKey(maximum, selected));
  EXPECT_EQ(maximumResult.physicalKey, selected);

  nsMsgKey generic, staged;
  RawHdr raw;
  raw.extras = {{"newsArticleNumber"_ns, "0"_ns},
                {"newsGroupIncarnation"_ns, zero.group.incarnation}};
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &generic));
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  nsMsgKey found = nsMsgKey_None;
  ASSERT_EQ(NS_OK, db.GetNewsArticleKey(zero, found));
  EXPECT_EQ(result.physicalKey, found);
  nsAutoCString sql("INSERT INTO message_properties(id,name,value) SELECT ");
  sql.AppendInt(generic);
  sql.AppendLiteral(",name,value FROM message_properties WHERE id=");
  sql.AppendInt(result.physicalKey);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, db.GetNewsArticleKey(zero, output));
  EXPECT_EQ(12345u, output);
}

TEST_F(DeliveryCoreReferences,
       NewsArticlePublicationInstallsBindingBeforeCallbacks) {
  RefPtr<nsMsgKeySet> set = nsMsgKeySet::Create();
  RefPtr<PerFolderDatabase> owner;
  nsCString source;
  ASSERT_EQ(NS_OK, StartNews(owner, source, set));
  auto& db = mCore->MessageDB();
  NewsArticleIdentity article;
  ASSERT_EQ(NS_OK, NewsArticle(source, mFolderId, 51, article));
  NewsArticleResult output;
  nsCOMPtr<nsIMsgDBHdr> publicHeader;
  uint32_t callbacks = 0;
  RefPtr<AddedObserver> observer = new AddedObserver([&](Message* live) {
    ++callbacks;
    EXPECT_TRUE(output.inserted);
    EXPECT_EQ(live, output.header.get());
    EXPECT_EQ(static_cast<nsIMsgDBHdr*>(live), publicHeader.get());
    nsMsgKey publicKey = nsMsgKey_None;
    ASSERT_TRUE(publicHeader);
    ASSERT_EQ(NS_OK, publicHeader->GetMessageKey(&publicKey));
    EXPECT_EQ(live->Key(), publicKey);
    EXPECT_EQ(live->Key(), output.physicalKey);
    nsMsgKey found = nsMsgKey_None;
    ASSERT_EQ(NS_OK, db.GetNewsArticleKey(article, found));
    EXPECT_EQ(output.physicalKey, found);
    EXPECT_TRUE(set->IsMember(51));
    uint32_t flags;
    ASSERT_EQ(NS_OK, db.GetMessageFlags(found, flags));
    EXPECT_TRUE(flags & nsMsgMessageFlags::Read);
  });
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, db.AddNewsArticle(article, RawHdr{}, true, output,
                                     getter_AddRefs(publicHeader), Some(true)));
  EXPECT_EQ(1u, callbacks);
  ASSERT_TRUE(publicHeader);
  EXPECT_EQ(static_cast<nsIMsgDBHdr*>(output.header.get()), publicHeader.get());

  NewsArticleResult duplicate;
  nsCOMPtr<nsIMsgDBHdr> duplicateHeader;
  ASSERT_EQ(NS_OK, db.AddNewsArticle(article, RawHdr{}, true, duplicate,
                                     getter_AddRefs(duplicateHeader)));
  EXPECT_FALSE(duplicate.inserted);
  EXPECT_EQ(output.physicalKey, duplicate.physicalKey);
  ASSERT_TRUE(duplicateHeader);
  EXPECT_EQ(static_cast<nsIMsgDBHdr*>(duplicate.header.get()),
            duplicateHeader.get());
  EXPECT_EQ(1u, callbacks);

  // A supplied owning slot must be initially null; no overwrite or release of
  // the caller's existing value, result, or a published row is allowed.
  nsIMsgDBHdr* occupied = publicHeader.get();
  NewsArticleResult unchanged = duplicate;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.AddNewsArticle(article, RawHdr{}, true, unchanged, &occupied));
  EXPECT_EQ(publicHeader.get(), occupied);
  EXPECT_EQ(duplicate.header, unchanged.header);
  EXPECT_EQ(duplicate.physicalKey, unchanged.physicalKey);
  EXPECT_EQ(1u, callbacks);

  // Actual row/binding failure rolls back without installing either output.
  NewsArticleIdentity failed = article;
  failed.articleNumber = 52;
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER news_public_output_fault BEFORE INSERT ON "
          "main.message_properties WHEN NEW.name='newsArticleNumber' BEGIN "
          "SELECT RAISE(FAIL,'news public output'); END"_ns));
  auto dropFault = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER news_public_output_fault"_ns));
  });
  nsCOMPtr<nsIMsgDBHdr> failedHeader;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.AddNewsArticle(failed, RawHdr{}, true, unchanged,
                              getter_AddRefs(failedHeader)));
  EXPECT_FALSE(failedHeader);
  EXPECT_EQ(duplicate.header, unchanged.header);
  EXPECT_EQ(duplicate.physicalKey, unchanged.physicalKey);
  EXPECT_EQ(duplicate.inserted, unchanged.inserted);
  EXPECT_EQ(1u, callbacks);
  nsMsgKey missing = 12345;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.GetNewsArticleKey(failed, missing));
  EXPECT_EQ(12345u, missing);
  EXPECT_TRUE(set->IsMember(51));
  EXPECT_FALSE(set->IsMember(52));
}

TEST_F(DeliveryCoreReferences, NewsReadSetBorrowedSwapDetachAndReplacement) {
  RefPtr<nsMsgKeySet> first = nsMsgKeySet::Create("8");
  RefPtr<nsMsgKeySet> second = nsMsgKeySet::Create("9");
  RefPtr<PerFolderDatabase> owner;
  nsCString source;
  ASSERT_EQ(NS_OK, StartNews(owner, source, first));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, owner->SetReadSet(second));
  nsMsgKeySet* borrowed = nullptr;
  ASSERT_EQ(NS_OK, owner->GetReadSet(&borrowed));
  EXPECT_EQ(second.get(), borrowed);
  EXPECT_TRUE(first->IsMember(8));
  EXPECT_FALSE(first->IsMember(9));
  NewsArticleIdentity article;
  ASSERT_EQ(NS_OK, NewsArticle(source, mFolderId, 10, article));
  NewsArticleResult result;
  ASSERT_EQ(NS_OK, db.AddNewsArticle(article, RawHdr{}, true, result));
  ASSERT_EQ(NS_OK, db.SetMessageFlag(result.physicalKey,
                                     nsMsgMessageFlags::Read, true));
  EXPECT_TRUE(second->IsMember(10));
  EXPECT_FALSE(first->IsMember(10));
  ASSERT_EQ(NS_OK, owner->SetReadSet(nullptr));
  ASSERT_EQ(NS_OK, owner->SetReadSet(nullptr));
  first = nullptr;
  second = nullptr;  // A later native write must never dereference these.
  ASSERT_EQ(NS_OK, db.SetMessageFlag(result.physicalKey,
                                     nsMsgMessageFlags::Read, false));
  ASSERT_EQ(NS_OK, owner->GetReadSet(&borrowed));
  EXPECT_EQ(nullptr, borrowed);
}

TEST_F(DeliveryCoreReferences, NewsReadSetReentrantBatchOrdering) {
  RefPtr<nsMsgKeySet> set = nsMsgKeySet::Create();
  RefPtr<PerFolderDatabase> owner;
  nsCString source;
  ASSERT_EQ(NS_OK, StartNews(owner, source, set));
  auto& db = mCore->MessageDB();
  NewsArticleIdentity article;
  ASSERT_EQ(NS_OK, NewsArticle(source, mFolderId, 77, article));
  NewsArticleResult result;
  ASSERT_EQ(NS_OK, db.AddNewsArticle(article, RawHdr{}, true, result));
  nsTArray<char> order;
  RefPtr<ThreadQueueObserver> first = new ThreadQueueObserver();
  RefPtr<ThreadQueueObserver> second = new ThreadQueueObserver();
  first->action = [&](char kind, const CapturedMessage&,
                      const CapturedMessage& after, Message*, bool) {
    EXPECT_EQ('F', kind);
    order.AppendElement('A');
    if (after.flags & nsMsgMessageFlags::Read) {
      EXPECT_TRUE(set->IsMember(77));
      ASSERT_EQ(NS_OK, db.SetMessageFlag(result.physicalKey,
                                         nsMsgMessageFlags::Read, false));
      EXPECT_EQ(1u, order.Length());
    } else
      EXPECT_FALSE(set->IsMember(77));
  };
  second->action = [&](char kind, const CapturedMessage&,
                       const CapturedMessage&, Message*, bool) {
    EXPECT_EQ('F', kind);
    order.AppendElement('B');
  };
  db.AddMessageListener(first);
  db.AddMessageListener(second);
  auto unwatch = MakeScopeExit([&] {
    db.RemoveMessageListener(first);
    db.RemoveMessageListener(second);
  });
  ASSERT_EQ(NS_OK, db.SetMessageFlag(result.physicalKey,
                                     nsMsgMessageFlags::Read, true));
  EXPECT_EQ((nsTArray<char>{'A', 'B', 'A', 'B'}), order);
  EXPECT_FALSE(set->IsMember(77));
}

TEST_F(DeliveryCoreReferences,
       NewsGroupIncarnationStableWithoutInventedServerEpoch) {
  RefPtr<nsMsgKeySet> set = nsMsgKeySet::Create();
  RefPtr<PerFolderDatabase> owner;
  nsCString source;
  ASSERT_EQ(NS_OK, StartNews(owner, source, set));
  auto& db = mCore->MessageDB();
  NewsGroupIdentity first, again;
  ASSERT_EQ(NS_OK, db.GetNewsGroupIdentity(source, mFolderId, first));
  ASSERT_FALSE(first.incarnation.IsEmpty());
  ASSERT_EQ(NS_OK, owner->SetReadSet(set));
  ASSERT_EQ(NS_OK, db.GetNewsGroupIdentity(source, mFolderId, again));
  EXPECT_EQ(first.incarnation, again.incarnation);
  uint64_t other;
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolderId, "OtherNews"_ns, &other));
  nsAutoCString sql("UPDATE folders SET flags=flags|");
  sql.AppendInt(nsMsgFolderFlags::Newsgroup);
  sql.AppendLiteral(" WHERE id=");
  sql.AppendInt(other);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
  Maybe<bool> zero = Some(true);
  ASSERT_EQ(NS_OK, ReadNewsZero(source, mFolderId, ""_ns, zero));
  EXPECT_EQ(Some(false), zero);  // Known empty is present and false.
  ASSERT_EQ(NS_OK, ReadNewsZero(source, other, ""_ns, zero));
  EXPECT_TRUE(zero.isNothing());  // No checkpoint yet.
  ASSERT_EQ(NS_OK, WriteFolderProperty(&mCore->FolderDB(), other, "readSet"_ns,
                                       ""_ns));
  ASSERT_EQ(NS_OK, ReadNewsZero(source, other, ""_ns, zero));
  EXPECT_TRUE(zero.isNothing());  // Legacy empty without companion is unknown.
  RefPtr<PerFolderDatabase> otherOwner = new PerFolderDatabase(other, true);
  RefPtr<nsMsgKeySet> otherSet = nsMsgKeySet::Create();
  ASSERT_EQ(NS_OK, otherOwner->SetReadSet(otherSet));
  NewsGroupIdentity different;
  ASSERT_EQ(NS_OK, db.GetNewsGroupIdentity(source, other, different));
  EXPECT_NE(first.incarnation, different.incarnation);
  NewsArticleResult a, b;
  ASSERT_EQ(NS_OK, db.AddNewsArticle({first, 0}, RawHdr{}, true, a));
  ASSERT_EQ(NS_OK, db.AddNewsArticle({different, 0}, RawHdr{}, true, b));
  EXPECT_NE(a.physicalKey, b.physicalKey);
  EXPECT_EQ(first.folderId, mFolderId);
  EXPECT_EQ(different.folderId, other);
}

TEST_F(DeliveryCoreReferences,
       ReplayFlagsPreserveProvenanceAndUntouchedIntentAcrossReopen) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("delta@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 7, 42));
  nsCString sourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(sourceId));
  ServerMessageLocation source{mFolderId, key, 7, 42};
  OfflineOperationData original;
  original.operation = nsIMsgOfflineImapOperation::kAddKeywords;
  original.newFlags = UINT32_MAX;
  original.flagOperation = 0x80000000;
  original.keywordsToAdd = "retain"_ns;
  original.copyDestinations = {"one"_ns, "one"_ns, "two"_ns};
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, original));
  ASSERT_EQ(NS_OK, db.QueueOfflineProtocolFlagMutation(sourceId, mFolderId, key,
                                                       source, 0xDF, true));
  ASSERT_EQ(NS_OK, db.QueueOfflineProtocolFlagMutation(sourceId, mFolderId, key,
                                                       source, 0x85, false));
  ASSERT_EQ(NS_OK, db.QueueOfflineProtocolFlagMutation(sourceId, mFolderId, key,
                                                       source, 1, true));
  OfflineOperationData actual;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, key, actual));
  ASSERT_TRUE(actual.flagMutation);
  EXPECT_EQ(0x5Bu, actual.flagMutation->setMask);
  EXPECT_EQ(0x84u, actual.flagMutation->clearMask);
  EXPECT_EQ(UINT32_MAX, actual.newFlags);
  EXPECT_EQ(0x80000000u, actual.flagOperation);
  actual.keywordsToAdd = "later"_ns;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, actual));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetOfflineOperation(mFolderId, key, actual));
  ASSERT_TRUE(actual.flagMutation);
  EXPECT_EQ(0x5Bu, actual.flagMutation->setMask);
  EXPECT_EQ(0x84u, actual.flagMutation->clearMask);
  EXPECT_EQ(original.copyDestinations, actual.copyDestinations);
  EXPECT_EQ("later"_ns, actual.keywordsToAdd);
  EXPECT_FALSE(actual.invalidateFlagMutation);
  nsTArray<nsMsgKey> deletes;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().ListOfflineOperations(mFolderId, true, deletes));
  EXPECT_EQ((nsTArray<nsMsgKey>{key}), deletes);
}

TEST_F(DeliveryCoreReferences,
       ReplayFlagsRejectUnknownMasksAndPromotionWithoutChangingIntent) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("unknown-delta@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 7, 42));
  nsCString id;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(id));
  ServerMessageLocation source{mFolderId, key, 7, 42};
  for (int32_t mask : {-1, 0x20, 0x100, 0x10000})
    EXPECT_EQ(NS_ERROR_INVALID_ARG,
              db.QueueOfflineProtocolFlagMutation(id, mFolderId, key, source,
                                                  mask, true));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.QueueOfflineProtocolFlagMutation("foreign"_ns, mFolderId, key,
                                                source, 0, true));
  ASSERT_EQ(NS_OK, db.QueueOfflineProtocolFlagMutation(id, mFolderId, key,
                                                       source, 0, true));
  OfflineOperationData actual;
  actual.newFlags = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetOfflineOperation(mFolderId, key, actual));
  EXPECT_EQ(123u, actual.newFlags);
  OfflineOperationData legacy;
  legacy.operation = nsIMsgOfflineImapOperation::kFlagsChanged;
  legacy.newFlags = UINT32_MAX;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, legacy));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.QueueOfflineProtocolFlagMutation(
                                        id, mFolderId, key, source, 1, false));
  ASSERT_EQ(NS_OK, db.QueueOfflineProtocolFlagMutation(id, mFolderId, key,
                                                       source, 0, true));
  uint64_t attempt = 321;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineAction(mFolderId, key, legacy.operation, Nothing(),
                                  Nothing(), attempt));
  EXPECT_EQ(321u, attempt);
  legacy.flagMutation = Some(OfflineFlagMutation{1, 0});
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.StoreOfflineOperation(mFolderId, key, legacy));
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, key, actual));
  EXPECT_FALSE(actual.flagMutation);
  EXPECT_EQ(UINT32_MAX, actual.newFlags);
}

TEST_F(DeliveryCoreReferences,
       ReplayFlagsLegacyInvalidationCannotBlessUnknownHistory) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  OfflineAttempt unused;
  // Queue without dispatch so a legacy setter can explicitly replace it.
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
  ASSERT_EQ(NS_OK, Add("invalidate@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 7, 42));
  nsCString id;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(id));
  ServerMessageLocation source{mFolderId, key, 7, 42};
  ASSERT_EQ(NS_OK, db.QueueOfflineProtocolFlagMutation(id, mFolderId, key,
                                                       source, 1, true));
  OfflineOperationData payload;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, key, payload));
  payload.invalidateFlagMutation = true;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, key, payload));
  EXPECT_FALSE(payload.flagMutation);
  EXPECT_FALSE(payload.invalidateFlagMutation);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.QueueOfflineProtocolFlagMutation(
                                        id, mFolderId, key, source, 1, true));
}

TEST_F(DeliveryCoreReferences,
       ReplayFlagPartialReceiptsSurviveReopenWithoutDuplicateSet) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, QueuedReplayFlags(key, attempt));
  auto& db = mCore->MessageDB();
  OfflineReplayCommandToken set, clear;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineReplayCommand(
                attempt, OfflineReplayCommand::FlagClear, clear));
  ASSERT_EQ(NS_OK, db.BeginOfflineReplayCommand(
                       attempt, OfflineReplayCommand::FlagSet, set));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.ResolveOfflineAttemptNotApplied(attempt.id));
  ASSERT_EQ(NS_OK, db.RecordOfflineReplayCommand(
                       set, OfflineReplayReceipt::Acknowledged, NS_OK));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attempt.id, attempt));
  ASSERT_EQ(NS_OK, db.BeginOfflineReplayCommand(
                       attempt, OfflineReplayCommand::FlagClear, clear));
  ASSERT_EQ(NS_OK, db.RecordOfflineReplayCommand(
                       clear, OfflineReplayReceipt::RejectedNoEffect,
                       NS_ERROR_FAILURE));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.ConfirmOfflineAttempt(attempt.id, Nothing()));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->MessageDB();
  ASSERT_EQ(NS_OK, reopened.GetOfflineAttempt(attempt.id, attempt));
  ASSERT_TRUE(attempt.firstError);
  EXPECT_EQ(NS_ERROR_FAILURE, *attempt.firstError);
  OfflineReplayCommandToken retry;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            reopened.BeginOfflineReplayCommand(
                attempt, OfflineReplayCommand::FlagSet, retry));
  ASSERT_EQ(NS_OK, reopened.BeginOfflineReplayCommand(
                       attempt, OfflineReplayCommand::FlagClear, retry));
  EXPECT_EQ(2u, retry.generation);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            reopened.RecordOfflineReplayCommand(
                clear, OfflineReplayReceipt::Acknowledged, NS_OK));
  ASSERT_EQ(NS_OK, reopened.RecordOfflineReplayCommand(
                       retry, OfflineReplayReceipt::Acknowledged, NS_OK));
  ASSERT_EQ(NS_OK, reopened.ConfirmOfflineAttempt(attempt.id, Nothing()));
  ASSERT_EQ(NS_OK, reopened.GetOfflineAttempt(attempt.id, attempt));
  EXPECT_EQ(OfflineAttemptState::Confirmed, attempt.state);
  EXPECT_EQ(NS_ERROR_FAILURE, *attempt.firstError);
}

TEST_F(DeliveryCoreReferences,
       ReplayCommandWriteFailureRetainsSentFenceAndFirstError) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, QueuedReplayFlags(key, attempt));
  auto& db = mCore->MessageDB();
  OfflineReplayCommandToken token;
  token.generation = 123;
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_replay BEFORE UPDATE OF flagSetState ON offline_attempts WHEN NEW.flagSetState=1 BEGIN SELECT RAISE(ABORT,'dispatch'); END"_ns));
  EXPECT_TRUE(NS_FAILED(db.BeginOfflineReplayCommand(
      attempt, OfflineReplayCommand::FlagSet, token)));
  EXPECT_EQ(123u, token.generation);
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attempt.id, attempt));
  EXPECT_EQ(OfflineReplayCommandState::Pending, attempt.flagSet->state);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER reject_replay"_ns));
  ASSERT_EQ(NS_OK, db.BeginOfflineReplayCommand(
                       attempt, OfflineReplayCommand::FlagSet, token));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_receipt BEFORE UPDATE OF flagSetState ON offline_attempts WHEN NEW.flagSetState=3 BEGIN SELECT RAISE(ABORT,'receipt'); END"_ns));
  EXPECT_TRUE(NS_FAILED(db.RecordOfflineReplayCommand(
      token, OfflineReplayReceipt::Acknowledged, NS_OK)));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER reject_receipt"_ns));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attempt.id, attempt));
  EXPECT_EQ(OfflineReplayCommandState::Sent, attempt.flagSet->state);
  EXPECT_FALSE(attempt.firstError);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineReplayCommand(attempt, OfflineReplayCommand::FlagSet,
                                         token));
  ASSERT_EQ(NS_OK,
            db.RecordOfflineReplayCommand(
                token, OfflineReplayReceipt::Ambiguous, NS_ERROR_NET_TIMEOUT));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attempt.id, attempt));
  EXPECT_EQ(OfflineReplayCommandState::Ambiguous, attempt.flagSet->state);
  EXPECT_EQ(NS_ERROR_NET_TIMEOUT, *attempt.firstError);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.ResolveOfflineAttemptNotApplied(attempt.id));
}

TEST_F(DeliveryCoreReferences,
       ReplayMoveCapturedPlanAndSourceCommandsSurviveReopen) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey source, target;
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, QueuedReplayMove(source, target, attempt));
  auto& db = mCore->MessageDB();
  ASSERT_TRUE(attempt.moveSourceGuard);
  EXPECT_EQ(source, attempt.moveSourceGuard->original.key);
  OfflineAttempt planned;
  ASSERT_EQ(NS_OK, db.PlanOfflineMoveSource(attempt, {OfflineMoveExpunge::Uid},
                                            planned));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.PlanOfflineMoveSource(attempt, {OfflineMoveExpunge::Mailbox},
                                     planned));
  OfflineReplayCommandToken store;
  ASSERT_EQ(NS_OK, db.BeginOfflineReplayCommand(
                       planned, OfflineReplayCommand::MoveStore, store));
  ASSERT_EQ(NS_OK, db.RecordOfflineReplayCommand(
                       store, OfflineReplayReceipt::Acknowledged, NS_OK));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->MessageDB();
  ASSERT_EQ(NS_OK, reopened.GetOfflineAttempt(attempt.id, attempt));
  ASSERT_TRUE(attempt.moveSourcePlan);
  EXPECT_EQ(OfflineMoveExpunge::Uid, attempt.moveSourcePlan->expunge);
  OfflineReplayCommandToken expunge;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            reopened.BeginOfflineReplayCommand(
                attempt, OfflineReplayCommand::MoveStore, expunge));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            reopened.BeginOfflineReplayCommand(
                attempt, OfflineReplayCommand::MoveExpunge, expunge));
  ASSERT_EQ(NS_OK, reopened.BeginOfflineReplayCommand(
                       attempt, OfflineReplayCommand::MoveUidExpunge, expunge));
  ASSERT_EQ(NS_OK, reopened.RecordOfflineReplayCommand(
                       expunge, OfflineReplayReceipt::Acknowledged, NS_OK));
  ASSERT_EQ(NS_OK, reopened.GetOfflineAttempt(attempt.id, attempt));
  OfflineMoveSettlement result;
  ASSERT_EQ(NS_OK, reopened.SettleOfflineMove(attempt, result));
  EXPECT_EQ(target, result.destinationKey);
  EXPECT_TRUE(result.sourceRowRemoved);
  EXPECT_TRUE(result.operationRetired);
  bool exists;
  ASSERT_EQ(NS_OK, reopened.MessageExists(source, exists));
  EXPECT_FALSE(exists);
  ASSERT_EQ(NS_OK, reopened.MessageExists(target, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, reopened.SettleOfflineMove(attempt, result));
  EXPECT_TRUE(result.sourceRowRemoved);
  EXPECT_TRUE(result.operationRetired);
}

TEST_F(DeliveryCoreReferences,
       ReplayMoveAllowedAbsenceAndPersistentOutputBeforeCallbacks) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey source, target;
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, QueuedReplayMove(source, target, attempt));
  auto& db = mCore->MessageDB();
  // The real queued producer removes local membership before going online.
  ASSERT_EQ(NS_OK, db.RemoveMessage(source));
  nsAutoCString relocation("INSERT INTO body_relocations VALUES(");
  relocation.AppendInt(int64_t(mFolderId));
  relocation.AppendLiteral(
      ", 'pending-source', 'saved-source', '', '', '', 0, 0, 0, 0)");
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(relocation));
  OfflineAttempt held;
  held.id = 123;
  EXPECT_EQ(
      NS_ERROR_IN_PROGRESS,
      db.PlanOfflineMoveSource(attempt, {OfflineMoveExpunge::None}, held));
  EXPECT_EQ(123u, held.id);
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "DELETE FROM body_relocations WHERE token='pending-source'"_ns));

  ASSERT_EQ(NS_OK, db.PlanOfflineMoveSource(attempt, {OfflineMoveExpunge::None},
                                            attempt));
  OfflineReplayCommandToken token;
  ASSERT_EQ(NS_OK, db.BeginOfflineReplayCommand(
                       attempt, OfflineReplayCommand::MoveStore, token));
  ASSERT_EQ(NS_OK, db.RecordOfflineReplayCommand(
                       token, OfflineReplayReceipt::Acknowledged, NS_OK));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attempt.id, attempt));
  OfflineMoveSettlement result;
  ASSERT_EQ(NS_OK, db.SettleOfflineMove(attempt, result));
  EXPECT_FALSE(result.sourceRowRemoved);
  EXPECT_TRUE(result.operationRetired);
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->MessageDB().SettleOfflineMove(attempt, result));
  EXPECT_EQ(target, result.destinationKey);
  EXPECT_FALSE(result.sourceRowRemoved);
}

TEST_F(DeliveryCoreReferences,
       ReplayMoveKeepsUnknownEarlierIntentAndKnownDestination) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey source, target;
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, QueuedReplayMove(source, target, attempt,
                                    nsIMsgOfflineImapOperation::kFlagsChanged));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.PlanOfflineMoveSource(
                       attempt, {OfflineMoveExpunge::Mailbox}, attempt));
  OfflineReplayCommandToken token;
  token.generation = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineReplayCommand(
                attempt, OfflineReplayCommand::MoveStore, token));
  EXPECT_EQ(123u, token.generation);
  OfflineOperationData payload;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, source, payload));
  EXPECT_FALSE(payload.flagMutation);
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attempt.id, attempt));
  EXPECT_EQ(OfflineAttemptState::Confirmed, attempt.state);
  EXPECT_EQ(Some(target), attempt.confirmedUid);
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(source, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreReferences,
       ReplayMoveRejectsForeignBodySourceEpochAndNoUid) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey source, target;
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, QueuedReplayMove(source, target, attempt));
  auto& db = mCore->MessageDB();
  for (uint32_t field = 0; field < 7; ++field) {
    OfflineAttempt bad = attempt;
    switch (field) {
      case 0:
        ++bad.revision;
        break;
      case 1:
        ++bad.operationId;
        break;
      case 2:
        ++bad.source->key;
        break;
      case 3:
        ++bad.destination->key;
        break;
      case 4:
        ++bad.moveSourceGuard->original.contentRevision;
        break;
      case 5:
        bad.copyOrdinal = Some(0u);
        break;
      case 6:
        bad.replayVersion = 0;
        break;
    }
    OfflineAttempt output;
    output.id = 123;
    EXPECT_EQ(
        NS_ERROR_NOT_AVAILABLE,
        db.PlanOfflineMoveSource(bad, {OfflineMoveExpunge::None}, output));
    EXPECT_EQ(123u, output.id);
  }
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 8));
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      db.PlanOfflineMoveSource(attempt, {OfflineMoveExpunge::None}, attempt));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
  ASSERT_EQ(NS_OK, db.SetMessageStoreToken(source, "changed"_ns));
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      db.PlanOfflineMoveSource(attempt, {OfflineMoveExpunge::None}, attempt));
}

TEST_F(DeliveryCoreReferences,
       ReplayMoveSettlementRollsBackSourceAndPublishesOutputsOnce) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey source, target;
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, QueuedReplayMove(source, target, attempt));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.PlanOfflineMoveSource(attempt, {OfflineMoveExpunge::None},
                                            attempt));
  OfflineReplayCommandToken token;
  ASSERT_EQ(NS_OK, db.BeginOfflineReplayCommand(
                       attempt, OfflineReplayCommand::MoveStore, token));
  ASSERT_EQ(NS_OK, db.RecordOfflineReplayCommand(
                       token, OfflineReplayReceipt::Acknowledged, NS_OK));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attempt.id, attempt));
  OfflineMoveSettlement result;
  result.attemptId = 123;
  uint32_t events = 0;
  RefPtr<UndoRemovalObserver> observer = new UndoRemovalObserver([&](Message*) {
    ++events;
    EXPECT_EQ(attempt.id, result.attemptId);
    EXPECT_EQ(target, result.destinationKey);
    EXPECT_TRUE(result.sourceRowRemoved);
    EXPECT_TRUE(result.operationRetired);
    OfflineOperationData absent;
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.GetOfflineOperation(mFolderId, source, absent));
  });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_settle BEFORE UPDATE OF moveSettled ON offline_attempts WHEN NEW.moveSettled=1 BEGIN SELECT RAISE(ABORT,'settle'); END"_ns));
  EXPECT_TRUE(NS_FAILED(db.SettleOfflineMove(attempt, result)));
  EXPECT_EQ(123u, result.attemptId);
  EXPECT_EQ(0u, events);
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(source, exists));
  EXPECT_TRUE(exists);
  OfflineOperationData saved;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, source, saved));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attempt.id, attempt));
  EXPECT_FALSE(attempt.moveSettled);
  EXPECT_EQ(OfflineReplayCommandState::Acknowledged,
            attempt.sourceStore->state);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER reject_settle"_ns));
  ASSERT_EQ(NS_OK, db.SettleOfflineMove(attempt, result));
  EXPECT_EQ(1u, events);
  ASSERT_EQ(NS_OK, db.SettleOfflineMove(attempt, result));
  EXPECT_EQ(1u, events);
}

TEST_F(DeliveryCoreReferences,
       ReplayMoveSettlementCommitFailureIsLocalOnlyRetry) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey source, target;
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, QueuedReplayMove(source, target, attempt));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.PlanOfflineMoveSource(attempt, {OfflineMoveExpunge::None},
                                            attempt));
  OfflineReplayCommandToken token;
  ASSERT_EQ(NS_OK, db.BeginOfflineReplayCommand(
                       attempt, OfflineReplayCommand::MoveStore, token));
  ASSERT_EQ(NS_OK, db.RecordOfflineReplayCommand(
                       token, OfflineReplayReceipt::Acknowledged, NS_OK));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attempt.id, attempt));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "PRAGMA foreign_keys=ON; CREATE TEMP TABLE replay_parent(id INTEGER PRIMARY KEY); CREATE TEMP TABLE replay_child(id INTEGER REFERENCES replay_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER reject_settle_commit AFTER UPDATE OF moveSettled ON main.offline_attempts WHEN NEW.moveSettled=1 BEGIN INSERT INTO replay_child VALUES(NEW.id); END"_ns));
  OfflineMoveSettlement output;
  output.attemptId = 123;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, db.SettleOfflineMove(attempt, output));
  EXPECT_EQ(123u, output.attemptId);
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(source, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "DROP TRIGGER reject_settle_commit; PRAGMA foreign_keys=OFF"_ns));
  ASSERT_EQ(NS_OK, db.SettleOfflineMove(attempt, output));
  EXPECT_TRUE(output.operationRetired);
}

TEST_F(DeliveryCoreReferences,
       ReplayMetadataCorruptionAndCallerTransactionsPreserveOutput) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, QueuedReplayFlags(key, attempt));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  OfflineReplayCommandToken output;
  output.generation = 123;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.BeginOfflineReplayCommand(attempt, OfflineReplayCommand::FlagSet,
                                         output));
  EXPECT_EQ(123u, output.generation);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  for (const char* bad :
       {"flagSetMask=32", "flagClearMask=NULL", "flagSetGeneration=-1",
        "replayVersion=2", "sourceStoreState=0", "moveSettled=1",
        "settledSourceRemoved=1", "settledOperationRetired=0"}) {
    ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
    nsAutoCString sql("UPDATE offline_attempts SET ");
    sql.Append(bad);
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    OfflineAttempt untouched;
    untouched.id = 123;
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
              db.GetOfflineAttempt(attempt.id, untouched));
    EXPECT_EQ(123u, untouched.id);
    ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  }
}

TEST_F(DeliveryCoreReferences,
       ReplayMoveKnownCopyWithoutUidDoesNotAuthorizeSource) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey source, target;
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, QueuedReplayMove(source, target, attempt, 0, false));
  auto& db = mCore->MessageDB();
  ASSERT_TRUE(attempt.transferAccepted);
  ASSERT_FALSE(attempt.confirmedUid);
  ASSERT_FALSE(attempt.confirmedEpoch);
  OfflineAttempt output;
  output.id = 123;
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      db.PlanOfflineMoveSource(attempt, {OfflineMoveExpunge::None}, output));
  EXPECT_EQ(123u, output.id);
  OfflineReplayCommandToken token;
  token.generation = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineReplayCommand(
                attempt, OfflineReplayCommand::MoveStore, token));
  EXPECT_EQ(123u, token.generation);
  OfflineMoveSettlement settled;
  settled.attemptId = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.SettleOfflineMove(attempt, settled));
  EXPECT_EQ(123u, settled.attemptId);
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(source, exists));
  EXPECT_TRUE(exists);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.ResolveOfflineAttemptNotApplied(attempt.id));
}

TEST_F(DeliveryCoreReferences,
       ReplayMovePhaseFenceRejectsPayloadMutationAndSubstitutedReceipt) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey source, target;
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, QueuedReplayMove(source, target, attempt));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.PlanOfflineMoveSource(
                       attempt, {OfflineMoveExpunge::Mailbox}, attempt));
  OfflineOperationData payload;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, source, payload));
  payload.keywordsToAdd = "later must not enter sent snapshot"_ns;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.StoreOfflineOperation(mFolderId, source, payload));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.RemoveOfflineOperation(mFolderId, source));
  OfflineReplayCommandToken store;
  ASSERT_EQ(NS_OK, db.BeginOfflineReplayCommand(
                       attempt, OfflineReplayCommand::MoveStore, store));
  OfflineReplayCommandToken forged = store;
  forged.command = OfflineReplayCommand::MoveExpunge;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.RecordOfflineReplayCommand(
                forged, OfflineReplayReceipt::Acknowledged, NS_OK));
  ASSERT_EQ(NS_OK, db.RecordOfflineReplayCommand(
                       store, OfflineReplayReceipt::Acknowledged, NS_OK));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attempt.id, attempt));
  OfflineReplayCommandToken expunge;
  ASSERT_EQ(NS_OK, db.BeginOfflineReplayCommand(
                       attempt, OfflineReplayCommand::MoveExpunge, expunge));
  forged = store;
  forged.command = OfflineReplayCommand::MoveExpunge;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.RecordOfflineReplayCommand(
                forged, OfflineReplayReceipt::Acknowledged, NS_OK));
  ASSERT_EQ(NS_OK, db.RecordOfflineReplayCommand(
                       expunge, OfflineReplayReceipt::Ambiguous,
                       NS_ERROR_NET_TIMEOUT));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attempt.id, attempt));
  OfflineMoveSettlement settled;
  settled.attemptId = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.SettleOfflineMove(attempt, settled));
  EXPECT_EQ(123u, settled.attemptId);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineReplayCommand(
                attempt, OfflineReplayCommand::MoveExpunge, expunge));
}

TEST_F(DeliveryCoreReferences,
       ReplaySchema18MigrationPreservesUnknownWithoutInventingCommands) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey source, target;
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, QueuedReplayMove(source, target, attempt));
  Stop();
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK, RemoveReplayColumns(old));
  ASSERT_EQ(NS_OK, old->SetSchemaVersion(18));
  ASSERT_EQ(NS_OK, old->Close());
  old = nullptr;
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attempt.id, attempt));
  EXPECT_EQ(0u, attempt.replayVersion);
  EXPECT_FALSE(attempt.moveSourceGuard);
  EXPECT_FALSE(attempt.moveSourcePlan);
  EXPECT_FALSE(attempt.sourceStore);
  EXPECT_FALSE(attempt.sourceExpunge);
  EXPECT_EQ(OfflineAttemptState::Confirmed, attempt.state);
  EXPECT_EQ(Some(target), attempt.confirmedUid);
  OfflineOperationData payload;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, source, payload));
  EXPECT_FALSE(payload.flagMutation);
  EXPECT_FALSE(payload.moveSourceGuard);
  OfflineAttempt output;
  output.id = 123;
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      db.PlanOfflineMoveSource(attempt, {OfflineMoveExpunge::None}, output));
  EXPECT_EQ(123u, output.id);
  int32_t version;
  ASSERT_EQ(NS_OK, mConnection->GetSchemaVersion(&version));
  EXPECT_EQ(19, version);
}

TEST_F(DeliveryCoreReferences,
       ReplayMoveSettlementRetainsOtherNamedActionAndFrozenRevision) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey source, target;
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK,
            QueuedReplayMove(source, target, attempt,
                             nsIMsgOfflineImapOperation::kDeleteAllMsgs));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.PlanOfflineMoveSource(attempt, {OfflineMoveExpunge::None},
                                            attempt));
  OfflineReplayCommandToken token;
  ASSERT_EQ(NS_OK, db.BeginOfflineReplayCommand(
                       attempt, OfflineReplayCommand::MoveStore, token));
  ASSERT_EQ(NS_OK, db.RecordOfflineReplayCommand(
                       token, OfflineReplayReceipt::Acknowledged, NS_OK));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attempt.id, attempt));
  OfflineMoveSettlement result;
  ASSERT_EQ(NS_OK, db.SettleOfflineMove(attempt, result));
  EXPECT_TRUE(result.sourceRowRemoved);
  EXPECT_FALSE(result.operationRetired);
  OfflineOperationData payload;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, source, payload));
  EXPECT_EQ(uint32_t(nsIMsgOfflineImapOperation::kMsgMoved |
                     nsIMsgOfflineImapOperation::kDeleteAllMsgs),
            payload.operation);
  QueuedSourceIdentity identity;
  ASSERT_EQ(NS_OK, db.GetQueuedSourceIdentity(mFolderId, source, identity));
  EXPECT_EQ(attempt.operationId, identity.operationId);
  EXPECT_EQ(attempt.revision, identity.revision);
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attempt.id, attempt));
  EXPECT_TRUE(attempt.moveSettled);
  uint64_t folderWide;
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAction(mFolderId, source,
                                  nsIMsgOfflineImapOperation::kDeleteAllMsgs,
                                  Nothing(), Nothing(), folderWide));
  ASSERT_EQ(NS_OK, db.ConfirmOfflineAttempt(folderWide, Nothing()));
  EXPECT_EQ(NS_OK, db.RemoveOfflineOperation(mFolderId, source));
  ASSERT_EQ(NS_OK, db.SettleOfflineMove(attempt, result));
  EXPECT_FALSE(result.operationRetired);
  EXPECT_EQ(target, result.destinationKey);
}

TEST_F(DeliveryCoreReferences,
       ReplayFlagDeltaUsesSavedTupleAfterQueuedLocalRemoval) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
  nsMsgKey source;
  ASSERT_EQ(NS_OK, Add("removed-flag-source"_ns, {}, source));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(source, mFolderId, 7, 42));
  nsCString id;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(id));
  ASSERT_EQ(NS_OK,
            db.QueueOfflineProtocolFlagMutation(
                id, mFolderId, source,
                ServerMessageLocation{mFolderId, source, 7, 42}, 1, true));
  ASSERT_EQ(NS_OK, db.RemoveMessage(source));
  uint64_t attemptId;
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAction(mFolderId, source,
                                  nsIMsgOfflineImapOperation::kFlagsChanged,
                                  Nothing(), Nothing(), attemptId));
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  ASSERT_TRUE(attempt.source);
  EXPECT_EQ(source, attempt.source->key);
  EXPECT_EQ(42u, attempt.source->uid);
  OfflineReplayCommandToken token;
  ASSERT_EQ(NS_OK, db.BeginOfflineReplayCommand(
                       attempt, OfflineReplayCommand::FlagSet, token));
  ASSERT_EQ(NS_OK, db.RecordOfflineReplayCommand(
                       token, OfflineReplayReceipt::Acknowledged, NS_OK));
  ASSERT_EQ(NS_OK, db.ConfirmOfflineAttempt(attemptId, Nothing()));
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(source, exists));
  EXPECT_FALSE(exists);
}

TEST_F(DeliveryCoreReferences,
       ReplayOpaqueUndoPreservesProvenanceAndOriginalPhysicalGuard) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
  nsMsgKey source, target;
  ASSERT_EQ(NS_OK, Add("undo-replay-source"_ns, {}, source));
  ASSERT_EQ(NS_OK, Add("undo-replay-target"_ns, {}, target));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(source, mFolderId, 7, 42));
  nsCString sourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(sourceId));
  ASSERT_EQ(NS_OK,
            db.QueueOfflineProtocolFlagMutation(
                sourceId, mFolderId, source,
                ServerMessageLocation{mFolderId, source, 7, 42}, 0x81, true));
  OfflineOperationData payload;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, source, payload));
  payload.operation |= nsIMsgOfflineImapOperation::kMsgMoved;
  payload.pendingDestination = Some(PendingDestination{mFolderId, target, 7});
  payload.copyDestinations = {"same"_ns, "same"_ns};
  payload.keywordsToAdd = "untouched"_ns;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, payload));
  OfflineOperationUndo operation;
  ASSERT_EQ(NS_OK, db.CaptureOfflineOperationForUndo(mFolderId, source,
                                                     sourceId, operation));
  ASSERT_TRUE(operation.Operation());
  ASSERT_TRUE(operation.Operation()->flagMutation);
  ASSERT_TRUE(operation.Operation()->moveSourceGuard);
  const auto capturedBody = operation.Operation()->moveSourceGuard->original;
  ASSERT_EQ(NS_OK, db.RemoveOfflineOperation(mFolderId, source));
  RemovedMessage removed;
  ASSERT_EQ(NS_OK, db.RemoveMessageForUndo(source, removed));
  FinishedMessageBody finished{"finished-restored"_ns, 12, 12, 1, true};
  nsMsgKey fresh = 123;
  Message* live = nullptr;
  uint32_t callbacks = 0;
  RefPtr<AddedObserver> observer = new AddedObserver([&](Message*) {
    ++callbacks;
    ASSERT_NE(source, fresh);
    EXPECT_FALSE(operation.Operation());
    OfflineOperationData actual;
    ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, fresh, actual));
    ASSERT_TRUE(actual.flagMutation);
    ASSERT_TRUE(actual.moveSourceGuard);
    EXPECT_EQ(0x81u, actual.flagMutation->setMask);
    EXPECT_EQ(0u, actual.flagMutation->clearMask);
    EXPECT_EQ(source, actual.moveSourceGuard->original.key);
    EXPECT_EQ(capturedBody.contentRevision,
              actual.moveSourceGuard->original.contentRevision);
    EXPECT_EQ(capturedBody.storeToken,
              actual.moveSourceGuard->original.storeToken);
    EXPECT_EQ(payload.copyDestinations, actual.copyDestinations);
  });
  db.AddMessageListener(observer);
  ASSERT_EQ(NS_OK, db.RestoreMessageForUndo(mFolderId, removed, finished,
                                            &fresh, &live, &operation));
  RefPtr<Message> restored = dont_AddRef(live);
  db.RemoveMessageListener(observer);
  EXPECT_EQ(1u, callbacks);
  restored = nullptr;
  Stop();
  ASSERT_EQ(NS_OK, Start());
  OfflineOperationData actual;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetOfflineOperation(mFolderId, fresh, actual));
  ASSERT_TRUE(actual.flagMutation);
  ASSERT_TRUE(actual.moveSourceGuard);
  EXPECT_EQ(0x81u, actual.flagMutation->setMask);
  EXPECT_EQ(source, actual.moveSourceGuard->original.key);
  Maybe<ServerMessageLocation> tuple;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetOfflineOperationSource(mFolderId,
                                                                fresh, tuple));
  ASSERT_TRUE(tuple);
  EXPECT_EQ(source, tuple->key);
  EXPECT_EQ(42u, tuple->uid);
}

}  // namespace mozilla::mailnews
