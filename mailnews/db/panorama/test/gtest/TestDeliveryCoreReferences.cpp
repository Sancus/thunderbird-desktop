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
#include "mozIStorageService.h"
#include "mozIStorageStatement.h"
#include "mozIStorageValueArray.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "nsIEventTarget.h"
#include "nsIFile.h"
#include "nsIInterfaceRequestorUtils.h"
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
  EXPECT_EQ(2, version);
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

}  // namespace
}  // namespace mozilla::mailnews
