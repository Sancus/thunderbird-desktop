/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <cstddef>
#include <cstdint>
#include <type_traits>

#include "DatabaseCore.h"
#include "MessageDatabase.h"
#include "gtest/gtest.h"
#include "mozilla/ResultExtensions.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/SpinEventLoopUntil.h"
#include "mozilla/Try.h"
#include "mozIStorageConnection.h"
#include "mozIStorageFunction.h"
#include "mozIStorageService.h"
#include "mozIStorageStatement.h"
#include "mozIStorageValueArray.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsComponentManagerUtils.h"
#include "nsDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "nsIEventTarget.h"
#include "nsIFile.h"
#include "nsIInterfaceRequestorUtils.h"
#include "nsIMsgHdr.h"
#include "nsIProperties.h"
#include "nsIVariant.h"
#include "nsServiceManagerUtils.h"
#include "nsString.h"
#include "nsThreadUtils.h"
#include "nsXPCOMCID.h"

namespace mozilla::mailnews {
namespace {

constexpr uint16_t kCountCanary = 0xa5c3;
struct alignas(int64_t) GuardedCount {
  uint16_t value;
  volatile uint16_t canary[3];
};
static_assert(std::is_standard_layout_v<GuardedCount>);
static_assert(offsetof(GuardedCount, canary) == sizeof(uint16_t));
static_assert(sizeof(GuardedCount) == sizeof(int64_t));

constexpr uint32_t kHeaderUint32Sentinel = 0x6ac13f27;
constexpr uint32_t kHeaderUint32Canary = 0xa5c39e71;
struct alignas(int64_t) GuardedHeaderUint32 {
  uint32_t value;
  volatile uint32_t canary;
};
static_assert(std::is_standard_layout_v<GuardedHeaderUint32>);
static_assert(offsetof(GuardedHeaderUint32, canary) == sizeof(uint32_t));
static_assert(sizeof(GuardedHeaderUint32) == sizeof(int64_t));

void CheckHeaderUint32Output(nsIMsgDBHdr* header, nsresult expectedResult,
                             uint32_t expectedValue) {
  GuardedHeaderUint32 output{kHeaderUint32Sentinel, kHeaderUint32Canary};
  EXPECT_EQ(expectedResult,
            header->GetUint32Property("delivery.uint32", &output.value));
  EXPECT_EQ(expectedValue, output.value);
  EXPECT_EQ(kHeaderUint32Canary, static_cast<uint32_t>(output.canary));
}

}  // namespace

class DeliveryMessageReferencesFaultWitness final : public mozIStorageFunction {
 public:
  NS_DECL_ISUPPORTS
  explicit DeliveryMessageReferencesFaultWitness(bool fail = false)
      : mFail(fail) {}
  uint32_t mCalls = 0;
  int64_t mLastKey = 0;
  NS_IMETHOD OnFunctionCall(mozIStorageValueArray* args,
                            nsIVariant** result) override {
    ++mCalls;
    MOZ_TRY(args->GetInt64(0, &mLastKey));
    if (mFail) {
      return NS_ERROR_FAILURE;
    }
    nsCOMPtr<nsIWritableVariant> value =
        do_CreateInstance("@mozilla.org/variant;1");
    NS_ENSURE_STATE(value);
    MOZ_TRY(value->SetAsInt32(0));
    nsCOMPtr<nsIVariant> returned = value;
    returned.forget(result);
    return NS_OK;
  }

 private:
  ~DeliveryMessageReferencesFaultWitness() = default;
  bool mFail;
};
NS_IMPL_ISUPPORTS(DeliveryMessageReferencesFaultWitness, mozIStorageFunction)

class DeliveryMessageReferences : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_FALSE(DatabaseCore::sInstance);
    ASSERT_FALSE(Connection());
    mDirectories = do_GetService(NS_DIRECTORY_SERVICE_CONTRACTID);
    ASSERT_TRUE(mDirectories);
    ASSERT_EQ(NS_OK,
              mDirectories->Get(NS_APP_USER_PROFILE_50_DIR, NS_GET_IID(nsIFile),
                                getter_AddRefs(mOldProfile)));
    ASSERT_TRUE(mOldProfile);
    // Keep failed fixtures outside the harness-owned profile's cleanup tree.
    ASSERT_EQ(NS_OK,
              NS_GetSpecialDirectory(NS_OS_TEMP_DIR, getter_AddRefs(mProfile)));
    ASSERT_EQ(NS_OK, mProfile->Append(u"delivery-message-references"_ns));
    ASSERT_EQ(NS_OK, mProfile->CreateUnique(nsIFile::DIRECTORY_TYPE, 0700));
    mProfileCreated = true;
    nsresult rv = mDirectories->Undefine(NS_APP_USER_PROFILE_50_DIR);
    mDirectoryChanged = NS_SUCCEEDED(rv);
    ASSERT_EQ(NS_OK, rv);
    rv = mDirectories->Set(NS_APP_USER_PROFILE_50_DIR, mProfile);
    mProfileInstalled = NS_SUCCEEDED(rv);
    ASSERT_EQ(NS_OK, rv);
    ASSERT_EQ(NS_OK, mProfile->Clone(getter_AddRefs(mFile)));
    ASSERT_EQ(NS_OK, mFile->Append(u"panorama.sqlite"_ns));
    mCore = DatabaseCore::GetInstanceForService();
    ASSERT_EQ(NS_OK, mCore->Startup());
    ASSERT_TRUE(Connection());
    nsCOMPtr<nsIFile> actualFile;
    ASSERT_EQ(NS_OK, Connection()->GetDatabaseFile(getter_AddRefs(actualFile)));
    bool sameFile = false;
    ASSERT_EQ(NS_OK, mFile->Equals(actualFile, &sameFile));
    ASSERT_TRUE(sameFile);
    uint64_t root;
    ASSERT_EQ(NS_OK,
              mCore->FolderDB().InsertRoot("native-references"_ns, &root));
    ASSERT_EQ(NS_OK,
              mCore->FolderDB().InsertFolder(root, "Inbox"_ns, &mFolder));
  }

  void TearDown() override {
    mHeader = nullptr;
    bool drained = Stop();
    mWitness = nullptr;
    bool restored = RestoreProfile();
    if (mProfileCreated) {
      EXPECT_TRUE(drained);
      EXPECT_TRUE(restored);
      if (drained && restored && !HasFailure()) {
        EXPECT_EQ(NS_OK, mProfile->Remove(true));
        bool exists = true;
        EXPECT_EQ(NS_OK, mProfile->Exists(&exists));
        EXPECT_FALSE(exists);
      } else {
        nsAutoCString retained;
        EXPECT_EQ(NS_OK, mProfile->GetNativePath(retained));
        RecordProperty("retained_profile", retained.get());
      }
    }
  }

  static mozIStorageConnection* Connection() {
    return DatabaseCore::sConnection.get();
  }

  bool Stop() {
    if (!mCore) {
      return true;
    }
    nsCOMPtr<mozIStorageConnection> connection = Connection();
    nsCOMPtr<nsIEventTarget> target = do_GetInterface(connection);
    if (connection) {
      EXPECT_TRUE(target);
    }
    nsresult rv = mCore->Observe(nullptr, "profile-before-change", nullptr);
    EXPECT_EQ(NS_OK, rv);
    mCore = nullptr;
    bool drained = NS_SUCCEEDED(rv);
    if (connection) {
      drained = target && WaitForClose(target) && drained;
    }
    return drained;
  }

  static bool WaitForClose(nsIEventTarget* target) {
    sCloseCompleted = false;
    // Observe queues AsyncClose before this barrier, with no intervening spin.
    nsresult rv = target->Dispatch(
        NS_NewRunnableFunction(
            "DeliveryMessageReferencesCloseBarrier",
            [] {
              MOZ_ALWAYS_SUCCEEDS(NS_DispatchToMainThread(
                  NS_NewRunnableFunction("DeliveryMessageReferencesClosed",
                                         [] { sCloseCompleted = true; })));
            }),
        NS_DISPATCH_NORMAL);
    EXPECT_EQ(NS_OK, rv);
    if (NS_FAILED(rv)) {
      return false;
    }
    bool drained = SpinEventLoopUntil("DeliveryMessageReferencesClosed"_ns,
                                      [] { return sCloseCompleted; });
    EXPECT_TRUE(drained);
    return drained;
  }

  bool RestoreProfile() {
    if (!mDirectoryChanged) {
      return true;
    }
    bool restored = true;
    if (mProfileInstalled) {
      nsresult rv = mDirectories->Undefine(NS_APP_USER_PROFILE_50_DIR);
      EXPECT_EQ(NS_OK, rv);
      restored = NS_SUCCEEDED(rv);
    }
    nsresult rv = mDirectories->Set(NS_APP_USER_PROFILE_50_DIR, mOldProfile);
    EXPECT_EQ(NS_OK, rv);
    restored = NS_SUCCEEDED(rv) && restored;
    nsCOMPtr<nsIFile> actual;
    rv = mDirectories->Get(NS_APP_USER_PROFILE_50_DIR, NS_GET_IID(nsIFile),
                           getter_AddRefs(actual));
    EXPECT_EQ(NS_OK, rv);
    bool sameProfile = false;
    if (NS_SUCCEEDED(rv) && actual) {
      rv = mOldProfile->Equals(actual, &sameProfile);
      EXPECT_EQ(NS_OK, rv);
      restored = NS_SUCCEEDED(rv) && restored;
    }
    EXPECT_TRUE(sameProfile);
    return sameProfile && restored;
  }

  void Create(const nsTArray<nsCString>& references) {
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().AddMessage(
                  mFolder, "child@invalid"_ns, references, 123456, "sender"_ns,
                  "recipient"_ns, EmptyCString(), EmptyCString(), "subject"_ns,
                  0, EmptyCString(), 0, &mKey));
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessage(mKey, getter_AddRefs(mHeader)));
    ASSERT_TRUE(mHeader);
  }

  void CreateOversized() {
    nsTArray<nsCString> tokens;
    for (uint32_t i = 0; i < 65535; ++i) {
      tokens.AppendElement("visible@invalid"_ns);
    }
    tokens.AppendElement("last@invalid"_ns);
    ASSERT_NO_FATAL_FAILURE(Create(tokens));
  }

  void CheckMessageRow(bool expected) {
    nsCOMPtr<mozIStorageStatement> stmt;
    auto cleanup = MakeScopeExit([&] {
      if (stmt) {
        EXPECT_EQ(NS_OK, stmt->Finalize());
      }
    });
    ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                         "SELECT 1 FROM messages WHERE id = :id"_ns,
                         getter_AddRefs(stmt)));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, mKey));
    bool exists = !expected;
    ASSERT_EQ(NS_OK, stmt->ExecuteStep(&exists));
    ASSERT_EQ(expected, exists);
  }

  void MakeUnavailable() {
    ASSERT_NO_FATAL_FAILURE(Create({}));
    // A missing marker is the representation of discarded historical tokens.
    ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "DELETE FROM message_reference_sets"_ns));
    ASSERT_NO_FATAL_FAILURE(CheckMessageRow(true));
  }

  void MakeMissing() {
    ASSERT_NO_FATAL_FAILURE(Create({}));
    ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(mKey));
    ASSERT_NO_FATAL_FAILURE(CheckMessageRow(false));
  }

  void InstallWitness(bool fail = false) {
    mWitness = new DeliveryMessageReferencesFaultWitness(fail);
    ASSERT_EQ(NS_OK, Connection()->CreateFunction(
                         "delivery_references_fault"_ns, 1, mWitness));
  }

  void MakeReadFault() {
    ASSERT_NO_FATAL_FAILURE(Create({"original@invalid"_ns}));
    ASSERT_NO_FATAL_FAILURE(InstallWitness(true));
    ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "CREATE TEMP VIEW message_references AS "
                         "SELECT id, ordinal, delivery_references_fault(id) "
                         "AS token FROM main.message_references"_ns));
    nsCOMPtr<mozIStorageStatement> prepared;
    ASSERT_EQ(NS_OK,
              Connection()->CreateStatement(
                  "SELECT token FROM message_references WHERE id = :id"_ns,
                  getter_AddRefs(prepared)));
    EXPECT_EQ(0u, mWitness->mCalls);
    ASSERT_EQ(NS_OK, prepared->Finalize());
  }

  void MakePropertyReadFault() {
    ASSERT_NO_FATAL_FAILURE(Create({}));
    ASSERT_EQ(NS_OK, mHeader->SetStringProperty("delivery.uint32", "2a"_ns));
    ASSERT_NO_FATAL_FAILURE(InstallWitness(true));
    ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "CREATE TEMP VIEW message_properties AS "
                         "SELECT id, name, delivery_references_fault(id) "
                         "AS value FROM main.message_properties"_ns));
    nsCOMPtr<mozIStorageStatement> prepared;
    ASSERT_EQ(NS_OK,
              Connection()->CreateStatement(
                  "SELECT value FROM message_properties WHERE id = :id"_ns,
                  getter_AddRefs(prepared)));
    ASSERT_EQ(NS_OK, prepared->Finalize());
    EXPECT_EQ(0u, mWitness->mCalls);
  }

  void CheckWitness() {
    ASSERT_TRUE(mWitness);
    EXPECT_EQ(1u, mWitness->mCalls);
    EXPECT_EQ(int64_t(mKey), mWitness->mLastKey);
  }

  void CheckCount(nsresult expectedResult, uint16_t expectedValue) {
    GuardedCount output{1234, {kCountCanary, kCountCanary, kCountCanary}};
    EXPECT_EQ(expectedResult, mHeader->GetNumReferences(&output.value));
    EXPECT_EQ(expectedValue, output.value);
    for (auto canary : output.canary) {
      EXPECT_EQ(kCountCanary, static_cast<uint16_t>(canary));
    }
  }

  void CheckStored(const nsTArray<nsCString>& expected) {
    nsCOMPtr<mozIStorageService> storage =
        do_GetService("@mozilla.org/storage/service;1");
    ASSERT_TRUE(storage);
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, storage->OpenUnsharedDatabase(
                         mFile, mozIStorageService::CONNECTION_DEFAULT,
                         getter_AddRefs(reader)));
    nsCOMPtr<mozIStorageStatement> stmt;
    auto cleanup = MakeScopeExit([&] {
      if (stmt) {
        EXPECT_EQ(NS_OK, stmt->Finalize());
      }
      EXPECT_EQ(NS_OK, reader->Close());
    });
    ASSERT_EQ(NS_OK, reader->CreateStatement(
                         "SELECT ordinal, token FROM message_references "
                         "WHERE id = :id ORDER BY ordinal"_ns,
                         getter_AddRefs(stmt)));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, mKey));
    nsTArray<nsCString> got;
    bool more;
    while (true) {
      ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
      if (!more) {
        break;
      }
      int64_t ordinal;
      ASSERT_EQ(NS_OK, stmt->GetInt64(0, &ordinal));
      EXPECT_EQ(int64_t(got.Length()), ordinal);
      nsCString token;
      ASSERT_EQ(NS_OK, stmt->GetUTF8String(1, token));
      got.AppendElement(token);
    }
    EXPECT_EQ(expected, got);
  }

  void CheckNoTransaction() {
    bool active = true;
    ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
  }

  RefPtr<DatabaseCore> mCore;
  nsCOMPtr<nsIProperties> mDirectories;
  nsCOMPtr<nsIFile> mOldProfile, mProfile, mFile;
  nsCOMPtr<nsIMsgDBHdr> mHeader;
  RefPtr<DeliveryMessageReferencesFaultWitness> mWitness;
  bool mProfileCreated = false;
  bool mDirectoryChanged = false;
  bool mProfileInstalled = false;
  uint64_t mFolder = 0;
  nsMsgKey mKey = nsMsgKey_None;
  static inline bool sCloseCompleted = false;
};

namespace {

using DISABLED_DeliveryMessageReferences = DeliveryMessageReferences;

TEST_F(DISABLED_DeliveryMessageReferences, CountSuccessAssignsOnlyUint16) {
  ASSERT_NO_FATAL_FAILURE(Create({"first@invalid"_ns, ""_ns, "child@invalid"_ns,
                                  "missing@invalid"_ns, "first@invalid"_ns}));
  CheckCount(NS_OK, 3);
}

TEST_F(DISABLED_DeliveryMessageReferences, CountKnownEmptyAssignsZero) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  CheckCount(NS_OK, 0);
}

TEST_F(DISABLED_DeliveryMessageReferences, CountUnavailableLeavesZero) {
  ASSERT_NO_FATAL_FAILURE(MakeUnavailable());
  CheckCount(NS_ERROR_NOT_AVAILABLE, 0);
}

TEST_F(DISABLED_DeliveryMessageReferences, CountMissingLeavesZero) {
  ASSERT_NO_FATAL_FAILURE(MakeMissing());
  CheckCount(NS_ERROR_UNEXPECTED, 0);
}

TEST_F(DISABLED_DeliveryMessageReferences, CountReadStepErrorLeavesZero) {
  ASSERT_NO_FATAL_FAILURE(MakeReadFault());
  CheckCount(NS_ERROR_FAILURE, 0);
  CheckWitness();
}

TEST_F(DISABLED_DeliveryMessageReferences, CountOverflowLeavesZero) {
  ASSERT_NO_FATAL_FAILURE(CreateOversized());
  CheckCount(NS_ERROR_LOSS_OF_SIGNIFICANT_DATA, 0);
}

TEST_F(DISABLED_DeliveryMessageReferences,
       IndexedUnavailablePreservesSentinel) {
  ASSERT_NO_FATAL_FAILURE(MakeUnavailable());
  nsAutoCString output("unavailable-sentinel");
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, mHeader->GetStringReference(0, output));
  EXPECT_EQ("unavailable-sentinel"_ns, output);
}

TEST_F(DISABLED_DeliveryMessageReferences, IndexedMissingPreservesSentinel) {
  ASSERT_NO_FATAL_FAILURE(MakeMissing());
  nsAutoCString output("missing-sentinel");
  EXPECT_EQ(NS_ERROR_UNEXPECTED, mHeader->GetStringReference(0, output));
  EXPECT_EQ("missing-sentinel"_ns, output);
}

TEST_F(DISABLED_DeliveryMessageReferences,
       IndexedReadStepErrorPreservesSentinel) {
  ASSERT_NO_FATAL_FAILURE(MakeReadFault());
  nsAutoCString output("read-error-sentinel");
  EXPECT_EQ(NS_ERROR_FAILURE, mHeader->GetStringReference(0, output));
  EXPECT_EQ("read-error-sentinel"_ns, output);
  CheckWitness();
}

TEST_F(DISABLED_DeliveryMessageReferences, IndexedNegativePreservesSentinel) {
  ASSERT_NO_FATAL_FAILURE(Create({"first@invalid"_ns}));
  nsAutoCString output("negative-index-sentinel");
  EXPECT_EQ(NS_ERROR_ILLEGAL_VALUE, mHeader->GetStringReference(-1, output));
  EXPECT_EQ("negative-index-sentinel"_ns, output);
}

TEST_F(DISABLED_DeliveryMessageReferences, IndexedPastEndPreservesSentinel) {
  ASSERT_NO_FATAL_FAILURE(Create({"first@invalid"_ns}));
  nsAutoCString output("past-end-sentinel");
  EXPECT_EQ(NS_ERROR_ILLEGAL_VALUE, mHeader->GetStringReference(1, output));
  EXPECT_EQ("past-end-sentinel"_ns, output);
}

TEST_F(DISABLED_DeliveryMessageReferences, NullCountKnownOversizedSucceeds) {
  ASSERT_NO_FATAL_FAILURE(CreateOversized());
  EXPECT_EQ(NS_OK, mHeader->GetNumReferences(nullptr));
  nsAutoCString last;
  ASSERT_EQ(NS_OK, mHeader->GetStringReference(65535, last));
  EXPECT_EQ("last@invalid"_ns, last);
}

TEST_F(DISABLED_DeliveryMessageReferences, NullCountUnavailablePropagates) {
  ASSERT_NO_FATAL_FAILURE(MakeUnavailable());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, mHeader->GetNumReferences(nullptr));
}

TEST_F(DISABLED_DeliveryMessageReferences, NullCountMissingPropagates) {
  ASSERT_NO_FATAL_FAILURE(MakeMissing());
  EXPECT_EQ(NS_ERROR_UNEXPECTED, mHeader->GetNumReferences(nullptr));
}

TEST_F(DISABLED_DeliveryMessageReferences, NullCountReadStepErrorPropagates) {
  ASSERT_NO_FATAL_FAILURE(MakeReadFault());
  EXPECT_EQ(NS_ERROR_FAILURE, mHeader->GetNumReferences(nullptr));
  CheckWitness();
}

TEST_F(DISABLED_DeliveryMessageReferences,
       EmbeddedNulStopsDelimitedReferences) {
  ASSERT_NO_FATAL_FAILURE(Create({"old@invalid"_ns}));
  constexpr char raw[] = "<first@invalid>\0<ignored@invalid>";
  const nsDependentCString input(raw, sizeof(raw) - 1);
  ASSERT_EQ(sizeof(raw) - 1, input.Length());
  ASSERT_EQ(NS_OK, mHeader->SetReferences(input));
  CheckCount(NS_OK, 1);
  nsAutoCString first;
  ASSERT_EQ(NS_OK, mHeader->GetStringReference(0, first));
  EXPECT_EQ("first@invalid"_ns, first);
  CheckStored({"first@invalid"_ns});
}

TEST_F(DISABLED_DeliveryMessageReferences, EmbeddedNulStopsBareReference) {
  ASSERT_NO_FATAL_FAILURE(Create({"old@invalid"_ns}));
  constexpr char raw[] = "  bare@invalid\0<ignored@invalid>";
  const nsDependentCString input(raw, sizeof(raw) - 1);
  ASSERT_EQ(sizeof(raw) - 1, input.Length());
  ASSERT_EQ(NS_OK, mHeader->SetReferences(input));
  CheckCount(NS_OK, 1);
  nsAutoCString first;
  ASSERT_EQ(NS_OK, mHeader->GetStringReference(0, first));
  EXPECT_EQ("bare@invalid"_ns, first);
  CheckStored({"bare@invalid"_ns});
}

TEST_F(DISABLED_DeliveryMessageReferences,
       SetReferencesInsertAbortPreservesCommittedTokens) {
  ASSERT_NO_FATAL_FAILURE(Create(
      {"original@invalid"_ns, "missing@invalid"_ns, "original@invalid"_ns}));
  ASSERT_NO_FATAL_FAILURE(CheckStored(
      {"original@invalid"_ns, "missing@invalid"_ns, "original@invalid"_ns}));
  ASSERT_NO_FATAL_FAILURE(InstallWitness());
  ASSERT_NO_FATAL_FAILURE(CheckNoTransaction());
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER delivery_insert_fault "
                       "BEFORE INSERT ON main.message_references "
                       "WHEN NEW.ordinal = 1 BEGIN "
                       "SELECT delivery_references_fault(NEW.id); "
                       "SELECT RAISE(ABORT, 'delivery insert fault'); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            mHeader->SetReferences("<first@invalid> <second@invalid>"_ns));
  CheckWitness();
  CheckNoTransaction();
  CheckStored(
      {"original@invalid"_ns, "missing@invalid"_ns, "original@invalid"_ns});
}

TEST_F(DISABLED_DeliveryMessageReferences,
       SetReferencesDeferredCommitFailurePreservesCommittedTokens) {
  ASSERT_NO_FATAL_FAILURE(Create({"original@invalid"_ns}));
  ASSERT_NO_FATAL_FAILURE(CheckStored({"original@invalid"_ns}));
  ASSERT_NO_FATAL_FAILURE(CheckNoTransaction());
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL("PRAGMA foreign_keys = ON"_ns));
  ASSERT_EQ(
      NS_OK,
      Connection()->ExecuteSimpleSQL(
          "CREATE TABLE delivery_commit_parent(id INTEGER PRIMARY KEY);"
          "CREATE TABLE delivery_commit_child(id INTEGER REFERENCES "
          "delivery_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)"_ns));
  // Establish that this fixture fails at COMMIT, after a successful write.
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "INSERT INTO delivery_commit_child VALUES(777)"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, Connection()->CommitTransaction());
  bool active = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  ASSERT_TRUE(active);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  ASSERT_NO_FATAL_FAILURE(InstallWitness());
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER delivery_commit_fault "
                       "AFTER INSERT ON main.message_references BEGIN "
                       "INSERT INTO delivery_commit_child VALUES(NEW.id); "
                       "SELECT delivery_references_fault(NEW.id); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            mHeader->SetReferences("<first@invalid> <second@invalid>"_ns));
  EXPECT_EQ(2u, mWitness->mCalls);
  EXPECT_EQ(int64_t(mKey), mWitness->mLastKey);
  CheckNoTransaction();
  CheckStored({"original@invalid"_ns});
}

using DISABLED_DeliveryHeaderProperties = DeliveryMessageReferences;

TEST_F(DISABLED_DeliveryHeaderProperties, Uint32SuccessAssignsOnlyUint32) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  ASSERT_EQ(NS_OK, mHeader->SetStringProperty("delivery.uint32", "2a"_ns));
  CheckHeaderUint32Output(mHeader, NS_OK, 42);
}

TEST_F(DISABLED_DeliveryHeaderProperties, Uint32MaximumAssignsOnlyUint32) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  ASSERT_EQ(NS_OK, mHeader->SetUint32Property("delivery.uint32", 0xffffffff));
  CheckHeaderUint32Output(mHeader, NS_OK, 0xffffffff);
  nsAutoCString text;
  ASSERT_EQ(NS_OK, mHeader->GetStringProperty("delivery.uint32", text));
  EXPECT_EQ("ffffffff"_ns, text);
}

TEST_F(DISABLED_DeliveryHeaderProperties,
       Uint32MissingReplacesSentinelWithZero) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  CheckHeaderUint32Output(mHeader, NS_OK, 0);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, mHeader->GetProperties(names));
  EXPECT_FALSE(names.Contains("delivery.uint32"_ns));
}

TEST_F(DISABLED_DeliveryHeaderProperties, Uint32EmptyReplacesSentinelWithZero) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  ASSERT_EQ(NS_OK,
            mHeader->SetStringProperty("delivery.uint32", EmptyCString()));
  CheckHeaderUint32Output(mHeader, NS_OK, 0);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, mHeader->GetProperties(names));
  EXPECT_TRUE(names.Contains("delivery.uint32"_ns));
}

TEST_F(DISABLED_DeliveryHeaderProperties,
       Uint32InvalidPrefixReplacesSentinelWithZero) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  ASSERT_EQ(NS_OK, mHeader->SetStringProperty("delivery.uint32", "g2a"_ns));
  CheckHeaderUint32Output(mHeader, NS_OK, 0);
}

TEST_F(DISABLED_DeliveryHeaderProperties, Uint32NineDigitsUseFirstEight) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  ASSERT_EQ(NS_OK,
            mHeader->SetStringProperty("delivery.uint32", "100000000"_ns));
  CheckHeaderUint32Output(mHeader, NS_OK, 0x10000000);
}

TEST_F(DISABLED_DeliveryHeaderProperties, Uint32NullKnownOutputIsRejected) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  ASSERT_EQ(NS_OK, mHeader->SetStringProperty("delivery.uint32", "2a"_ns));
  EXPECT_EQ(NS_ERROR_NULL_POINTER,
            mHeader->GetUint32Property("delivery.uint32", nullptr));
  CheckHeaderUint32Output(mHeader, NS_OK, 42);
}

TEST_F(DISABLED_DeliveryHeaderProperties, Uint32NullOutputDoesNotEvaluateSQL) {
  ASSERT_NO_FATAL_FAILURE(MakePropertyReadFault());
  EXPECT_EQ(NS_ERROR_NULL_POINTER,
            mHeader->GetUint32Property("delivery.uint32", nullptr));
  EXPECT_EQ(0u, mWitness->mCalls);
  CheckHeaderUint32Output(mHeader, NS_ERROR_FAILURE, kHeaderUint32Sentinel);
  CheckWitness();
}

TEST_F(DISABLED_DeliveryHeaderProperties, Uint32PrepareErrorPreservesSentinel) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  // Keep the getter's statement cold so the missing table fails preparation.
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL("DROP TABLE message_properties"_ns));
  nsCOMPtr<mozIStorageStatement> prepared;
  ASSERT_EQ(NS_ERROR_FAILURE,
            Connection()->CreateStatement(
                "SELECT value FROM message_properties WHERE id = :id"_ns,
                getter_AddRefs(prepared)));
  ASSERT_FALSE(prepared);
  CheckHeaderUint32Output(mHeader, NS_ERROR_FAILURE, kHeaderUint32Sentinel);
}

TEST_F(DISABLED_DeliveryHeaderProperties,
       Uint32ReadStepErrorPreservesSentinel) {
  ASSERT_NO_FATAL_FAILURE(MakePropertyReadFault());
  CheckHeaderUint32Output(mHeader, NS_ERROR_FAILURE, kHeaderUint32Sentinel);
  CheckWitness();
}

}  // namespace
}  // namespace mozilla::mailnews
