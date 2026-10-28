/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <functional>
#include <utility>

#include "DatabaseCore.h"
#include "Message.h"
#include "MessageDatabase.h"
#include "gtest/gtest.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/ResultExtensions.h"
#include "mozilla/Try.h"
#include "mozilla/SpinEventLoopUntil.h"
#include "mozIStorageConnection.h"
#include "mozIStorageFunction.h"
#include "mozIStorageProgressHandler.h"
#include "mozIStorageService.h"
#include "mozIStorageStatement.h"
#include "mozIStorageValueArray.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "nsIEventTarget.h"
#include "nsIFile.h"
#include "nsIInterfaceRequestorUtils.h"
#include "nsIMsgDatabase.h"
#include "nsIProperties.h"
#include "nsIVariant.h"
#include "nsComponentManagerUtils.h"
#include "nsServiceManagerUtils.h"
#include "nsThreadUtils.h"

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
  NS_IMETHOD OnFunctionCall(mozIStorageValueArray* args,
                            nsIVariant** result) override {
    ++mCalls;
    MOZ_TRY(args->GetInt64(0, &mLastKey));
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

}  // namespace

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

  mozIStorageConnection* Connection() const {
    return DatabaseCore::sConnection.get();
  }

  nsresult Open(mozIStorageConnection** connection) {
    return mStorage->OpenUnsharedDatabase(
        mFile, mozIStorageService::CONNECTION_DEFAULT, connection);
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

TEST_F(DISABLED_DeliveryCoreReferences,
       AddNotificationSeesCommittedReferences) {
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

TEST_F(DISABLED_DeliveryCoreReferences, ExactTokensSurviveReopen) {
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

TEST_F(DISABLED_DeliveryCoreReferences, ReplaceAndClearDoNotRethread) {
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

TEST_F(DISABLED_DeliveryCoreReferences,
       FailedReplacementPreservesCommittedSequence) {
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

TEST_F(DISABLED_DeliveryCoreReferences, FailedClearPreservesCommittedSequence) {
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

TEST_F(DISABLED_DeliveryCoreReferences,
       FailedAddRollsBackMessageAndReferences) {
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

TEST_F(DISABLED_DeliveryCoreReferences,
       MissingRowsAndStorageErrorsAreFailures) {
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

TEST_F(DISABLED_DeliveryCoreReferences, UpgradeKeepsOldReferencesUnavailable) {
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
  EXPECT_EQ(8, version);
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(7, got));
  EXPECT_TRUE(got.IsEmpty());
}

TEST_F(DISABLED_DeliveryCoreReferences, UnsupportedSchemaCanRetryAfterRepair) {
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

TEST_F(DISABLED_DeliveryCoreReferences, DeleteRemovesSequenceAndKnownMarker) {
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

TEST_F(DISABLED_DeliveryCoreReferences, SetterDoesNotAdoptForeignTransaction) {
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

TEST_F(DISABLED_DeliveryCoreReferences, FailedUpgradeRollsBackAndCanRetry) {
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

TEST_F(DISABLED_DeliveryCoreReferences, FutureSchemaIsNotSilentlyAccepted) {
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

TEST_F(DISABLED_DeliveryCoreReferences, ChangedDeleteTriggerIsUnsupported) {
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

TEST_F(DISABLED_DeliveryCoreReferences,
       NativePublicationIsCompleteAtFirstCallback) {
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

TEST_F(DISABLED_DeliveryCoreReferences,
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

TEST_F(DISABLED_DeliveryCoreReferences,
       NativeExtrasKeepExactNamesTextAndOrder) {
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

TEST_F(DISABLED_DeliveryCoreReferences,
       NativeEmptyKeywordsOverrideNamedDefault) {
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

TEST_F(DISABLED_DeliveryCoreReferences, NativeAbsentStorageRetainsExactExtras) {
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

TEST_F(DISABLED_DeliveryCoreReferences,
       NativePresentStorageOverridesExactExtras) {
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

TEST_F(DISABLED_DeliveryCoreReferences,
       NativeReceivedDateUsesLegacySecondsText) {
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

TEST_F(DISABLED_DeliveryCoreReferences,
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

TEST_F(DISABLED_DeliveryCoreReferences,
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

TEST_F(DISABLED_DeliveryCoreReferences,
       NativeBorrowedInputSupportsReentrantReuse) {
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

TEST_F(DISABLED_DeliveryCoreReferences, CaptureOwnsHistoricalRowFacts) {
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

TEST_F(DISABLED_DeliveryCoreReferences, CaptureMissingRowPreservesOutput) {
  ASSERT_EQ(NS_OK, Start());
  CapturedMessage output = CaptureSentinel();
  EXPECT_EQ(NS_ERROR_UNEXPECTED, mCore->MessageDB().CaptureMessage(0, output));
  ExpectCapture(CaptureSentinel(), output);
}

TEST_F(DISABLED_DeliveryCoreReferences, CaptureReadErrorPreservesOutput) {
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

TEST_F(DISABLED_DeliveryCoreReferences, PreparedBatchOwnsPendingPublication) {
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

TEST_F(DISABLED_DeliveryCoreReferences,
       BatchPreparationFailurePreservesOutput) {
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

TEST_F(DISABLED_DeliveryCoreReferences,
       CaptureReadsStagedSqlWithoutCacheMutation) {
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

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverOrderedCrossFolder) {
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

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverReplyBeforeParent) {
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

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverSiblingsWithoutParent) {
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

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverSiblingsThenParent) {
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

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverDuplicatePhysicalCopies) {
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

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverWholeStoredComponent) {
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

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverExactReferenceTokens) {
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

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverMissingRowPreservesOutput) {
  ASSERT_EQ(NS_OK, Start());
  nsTArray<ConversationMember> output{{0xfffffff0, 0x123456789ULL}};
  EXPECT_EQ(NS_ERROR_UNEXPECTED,
            mCore->MessageDB().DiscoverConversationComponent(0, output));
  ASSERT_EQ(1u, output.Length());
  EXPECT_EQ(0xfffffff0u, output[0].id);
  EXPECT_EQ(0x123456789ULL, output[0].folderId);
}

TEST_F(DISABLED_DeliveryCoreReferences,
       DiscoverUnavailableHistoryPreservesOutput) {
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

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverReadErrorPreservesOutput) {
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

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverReadsStagedReferences) {
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
  OfflineOperationData payload;
  payload.operation = 1;
  payload.newFlags = 128;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  ASSERT_EQ(NS_OK, db.RemoveMessage(key));
  uint64_t attemptId;
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(mFolderId, key, 1, Nothing(), attemptId));
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  ASSERT_TRUE(attempt.source);
  EXPECT_EQ(mFolderId, attempt.source->folderId);
  EXPECT_EQ(key, attempt.source->key);
  EXPECT_EQ(61u, attempt.source->epoch);
  EXPECT_EQ(700u, attempt.source->uid);
  EXPECT_EQ(1u, attempt.operation);
  EXPECT_NE(key, attempt.source->uid);
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
  OfflineOperationData payload;
  payload.operation = 1;
  payload.newFlags = 128;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 81, 43));
  payload.keywordsToAdd = "another edit"_ns;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  uint64_t attemptId = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineAttempt(mFolderId, key, 1, Nothing(), attemptId));
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

}  // namespace
}  // namespace mozilla::mailnews
