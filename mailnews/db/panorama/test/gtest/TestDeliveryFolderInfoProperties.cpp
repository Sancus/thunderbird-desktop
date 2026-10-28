/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <cstddef>
#include <cstdint>
#include <limits>
#include <type_traits>

#include "DatabaseCore.h"
#include "PerFolderDatabase.h"
#include "gtest/gtest.h"
#include "mozilla/ResultExtensions.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/SpinEventLoopUntil.h"
#include "mozIStorageConnection.h"
#include "mozIStorageFunction.h"
#include "mozIStorageStatement.h"
#include "mozIStorageValueArray.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsCOMPtr.h"
#include "nsComponentManagerUtils.h"
#include "nsIDBFolderInfo.h"
#include "nsIEventTarget.h"
#include "nsIFile.h"
#include "nsIFolderDatabase.h"
#include "nsIInterfaceRequestorUtils.h"
#include "nsIProperties.h"
#include "nsIVariant.h"
#include "nsServiceManagerUtils.h"
#include "nsString.h"
#include "nsThreadUtils.h"
#include "nsXPCOMCID.h"

namespace mozilla::mailnews {
namespace {

constexpr uint32_t kDefault = 0x13579bdf;
constexpr uint32_t kCanary = 0xa5c37e19;

struct alignas(int64_t) GuardedOutput {
  uint32_t value;
  volatile uint32_t canary;
};

static_assert(std::is_standard_layout_v<GuardedOutput>);
static_assert(offsetof(GuardedOutput, canary) == sizeof(uint32_t));
static_assert(sizeof(GuardedOutput) == sizeof(int64_t));

constexpr uint8_t kBooleanCanary = 0xa5;

static_assert(sizeof(bool) < sizeof(int64_t));

struct alignas(int64_t) GuardedBooleanOutput {
  bool value;
  volatile uint8_t canary[sizeof(int64_t) - sizeof(bool)];
};

static_assert(std::is_standard_layout_v<GuardedBooleanOutput>);
static_assert(offsetof(GuardedBooleanOutput, canary) == sizeof(bool));
static_assert(sizeof(GuardedBooleanOutput) == sizeof(int64_t));

}  // namespace

class DeliveryFolderInfoProperties : public ::testing::Test {
 protected:
  static void SetUpTestSuite() {
    ASSERT_FALSE(DatabaseCore::sInstance);
    ASSERT_FALSE(Connection());
    sDirectories = do_GetService(NS_DIRECTORY_SERVICE_CONTRACTID);
    ASSERT_TRUE(sDirectories);
    ASSERT_EQ(NS_OK,
              sDirectories->Get(NS_APP_USER_PROFILE_50_DIR, NS_GET_IID(nsIFile),
                                getter_AddRefs(sOldProfile)));
    ASSERT_TRUE(sOldProfile);
    ASSERT_EQ(NS_OK, sOldProfile->Clone(getter_AddRefs(sProfile)));
    ASSERT_EQ(NS_OK, sProfile->Append(u"delivery-folder-info"_ns));
    ASSERT_EQ(NS_OK, sProfile->CreateUnique(nsIFile::DIRECTORY_TYPE, 0700));
    sProfileCreated = true;
    nsresult rv = sDirectories->Undefine(NS_APP_USER_PROFILE_50_DIR);
    sDirectoryChanged = NS_SUCCEEDED(rv);
    ASSERT_EQ(NS_OK, rv);
    rv = sDirectories->Set(NS_APP_USER_PROFILE_50_DIR, sProfile);
    sProfileInstalled = NS_SUCCEEDED(rv);
    ASSERT_EQ(NS_OK, rv);
    nsCOMPtr<nsIFile> expectedFile;
    ASSERT_EQ(NS_OK, sProfile->Clone(getter_AddRefs(expectedFile)));
    ASSERT_EQ(NS_OK, expectedFile->Append(u"panorama.sqlite"_ns));
    sCore = DatabaseCore::GetInstanceForService();
    ASSERT_EQ(NS_OK, sCore->Startup());
    ASSERT_TRUE(Connection());
    nsCOMPtr<nsIFile> actualFile;
    ASSERT_EQ(NS_OK, Connection()->GetDatabaseFile(getter_AddRefs(actualFile)));
    bool sameFile = false;
    ASSERT_EQ(NS_OK, expectedFile->Equals(actualFile, &sameFile));
    ASSERT_TRUE(sameFile);
    ASSERT_EQ(NS_OK, sCore->GetFolderDB(getter_AddRefs(sFolders)));
    ASSERT_TRUE(sFolders);
    ASSERT_EQ(NS_OK,
              sFolders->InsertRoot("delivery-folder-info-width"_ns, &sRoot));
  }

  static void TearDownTestSuite() {
    sFolders = nullptr;
    bool closeDrained = true;
    if (sCore) {
      nsCOMPtr<mozIStorageConnection> connection = Connection();
      nsCOMPtr<nsIEventTarget> target = do_GetInterface(connection);
      if (connection) {
        EXPECT_TRUE(target);
      }
      nsresult rv = sCore->Observe(nullptr, "profile-before-change", nullptr);
      EXPECT_EQ(NS_OK, rv);
      sCore = nullptr;
      closeDrained = NS_SUCCEEDED(rv);
      if (connection) {
        closeDrained = target && WaitForClose(target) && closeDrained;
      }
    }
    bool restored = RestoreProfile();
    if (sProfileCreated) {
      EXPECT_TRUE(closeDrained);
      EXPECT_TRUE(restored);
      // Retain only our child directory if close or restoration failed.
      if (closeDrained && restored) {
        EXPECT_EQ(NS_OK, sProfile->Remove(true));
        bool exists = true;
        EXPECT_EQ(NS_OK, sProfile->Exists(&exists));
        EXPECT_FALSE(exists);
      }
    }
    sProfile = nullptr;
    sOldProfile = nullptr;
    sDirectories = nullptr;
    sProfileCreated = false;
    sDirectoryChanged = false;
    sProfileInstalled = false;
    sRoot = 0;
  }

  void SetUp() override {
    ASSERT_TRUE(sFolders);
    uint64_t folderId;
    const nsDependentCString name(
        ::testing::UnitTest::GetInstance()->current_test_info()->name());
    ASSERT_EQ(NS_OK, sFolders->GetFolderChildNamed(sRoot, name, &folderId));
    if (!folderId) {
      ASSERT_EQ(NS_OK, sFolders->InsertFolder(sRoot, name, &folderId));
    }
    mDatabase = new PerFolderDatabase(folderId, false);
    ASSERT_EQ(NS_OK, mDatabase->GetDBFolderInfo(getter_AddRefs(mInfo)));
    ASSERT_TRUE(mInfo);
  }

  void TearDown() override {
    mInfo = nullptr;
    if (mDatabase) {
      sCore->MessageDB().RemoveMessageListener(mDatabase);
      mDatabase = nullptr;
    }
  }

  void Store(int64_t value) {
    ASSERT_EQ(NS_OK, mInfo->SetInt64Property("value", value));
    int64_t stored = 0;
    ASSERT_EQ(NS_OK, mInfo->GetInt64Property("value", 0, &stored));
    ASSERT_EQ(value, stored);
  }

  void CheckRead(nsresult expectedResult, uint32_t expectedValue) {
    GuardedOutput output{0x33445566, kCanary};
    EXPECT_EQ(expectedResult,
              mInfo->GetUint32Property("value", kDefault, &output.value));
    EXPECT_EQ(expectedValue, output.value);
    EXPECT_EQ(kCanary, static_cast<uint32_t>(output.canary));
  }

  void StoreBoolean(bool value) {
    ASSERT_EQ(NS_OK, mInfo->SetBooleanProperty("value", value));
    int64_t stored = -1;
    ASSERT_EQ(NS_OK, mInfo->GetInt64Property("value", 0, &stored));
    ASSERT_EQ(value ? 1 : 0, stored);
  }

  void CheckBooleanRead(bool defaultValue, bool expectedValue) {
    GuardedBooleanOutput output{!expectedValue, {}};
    for (auto& byte : output.canary) {
      byte = kBooleanCanary;
    }
    EXPECT_EQ(NS_OK,
              mInfo->GetBooleanProperty("value", defaultValue, &output.value));
    EXPECT_EQ(expectedValue, output.value);
    for (size_t i = 0; i < sizeof(output.canary); ++i) {
      EXPECT_EQ(kBooleanCanary, static_cast<uint8_t>(output.canary[i]))
          << "Canary byte " << i;
    }
  }

  static mozIStorageConnection* Connection() {
    return DatabaseCore::sConnection.get();
  }

  static bool CoreReleased() { return !DatabaseCore::sInstance; }

  static bool WaitForClose(nsIEventTarget* target) {
    sCloseCompleted = false;
    // Observe queues AsyncClose before this barrier, with no intervening spin.
    nsresult rv = target->Dispatch(
        NS_NewRunnableFunction(
            "FolderInfoCloseBarrier",
            [] {
              MOZ_ALWAYS_SUCCEEDS(
                  NS_DispatchToMainThread(NS_NewRunnableFunction(
                      "FolderInfoClosed", [] { sCloseCompleted = true; })));
            }),
        NS_DISPATCH_NORMAL);
    EXPECT_EQ(NS_OK, rv);
    if (NS_FAILED(rv)) {
      return false;
    }
    bool drained = SpinEventLoopUntil("FolderInfoClosed"_ns,
                                      [] { return sCloseCompleted; });
    EXPECT_TRUE(drained);
    return drained;
  }

  static bool RestoreProfile() {
    if (!sDirectoryChanged) {
      return true;
    }
    if (sProfileInstalled) {
      EXPECT_EQ(NS_OK, sDirectories->Undefine(NS_APP_USER_PROFILE_50_DIR));
    }
    EXPECT_EQ(NS_OK,
              sDirectories->Set(NS_APP_USER_PROFILE_50_DIR, sOldProfile));
    nsCOMPtr<nsIFile> restored;
    nsresult rv =
        sDirectories->Get(NS_APP_USER_PROFILE_50_DIR, NS_GET_IID(nsIFile),
                          getter_AddRefs(restored));
    EXPECT_EQ(NS_OK, rv);
    bool sameProfile = false;
    if (NS_SUCCEEDED(rv) && restored) {
      EXPECT_EQ(NS_OK, sOldProfile->Equals(restored, &sameProfile));
    }
    EXPECT_TRUE(sameProfile);
    return sameProfile;
  }

  static inline RefPtr<DatabaseCore> sCore;
  static inline nsCOMPtr<nsIFolderDatabase> sFolders;
  static inline uint64_t sRoot = 0;
  static inline nsCOMPtr<nsIProperties> sDirectories;
  static inline nsCOMPtr<nsIFile> sOldProfile, sProfile;
  static inline bool sProfileCreated = false;
  static inline bool sDirectoryChanged = false;
  static inline bool sProfileInstalled = false;
  static inline bool sCloseCompleted = false;
  RefPtr<PerFolderDatabase> mDatabase;
  nsCOMPtr<nsIDBFolderInfo> mInfo;
};

namespace {

using DISABLED_DeliveryFolderInfoProperties = DeliveryFolderInfoProperties;

class KnownArtsFaultWitness final : public mozIStorageFunction {
 public:
  NS_DECL_ISUPPORTS
  explicit KnownArtsFaultWitness(bool fail = false) : mFail(fail) {}
  uint32_t mCalls = 0;
  int64_t mLastId = 0;
  NS_IMETHOD OnFunctionCall(mozIStorageValueArray* args,
                            nsIVariant** result) override {
    ++mCalls;
    MOZ_TRY(args->GetInt64(0, &mLastId));
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
  ~KnownArtsFaultWitness() = default;
  bool mFail;
};
NS_IMPL_ISUPPORTS(KnownArtsFaultWitness, mozIStorageFunction)

TEST_F(DISABLED_DeliveryFolderInfoProperties, MissingUsesDefault) {
  CheckRead(NS_OK, kDefault);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties, StoredZeroKeepsCanary) {
  ASSERT_NO_FATAL_FAILURE(Store(0));
  CheckRead(NS_OK, 0);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties, StoredMaxKeepsCanary) {
  ASSERT_NO_FATAL_FAILURE(Store(std::numeric_limits<uint32_t>::max()));
  CheckRead(NS_OK, std::numeric_limits<uint32_t>::max());
}

TEST_F(DISABLED_DeliveryFolderInfoProperties, RepeatedReadsKeepCanary) {
  ASSERT_NO_FATAL_FAILURE(Store(42));
  CheckRead(NS_OK, 42);
  CheckRead(NS_OK, 42);
  CheckRead(NS_OK, 42);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties, NegativePreservesDefault) {
  ASSERT_NO_FATAL_FAILURE(Store(-1));
  CheckRead(NS_ERROR_LOSS_OF_SIGNIFICANT_DATA, kDefault);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties, TooLargePreservesDefault) {
  ASSERT_NO_FATAL_FAILURE(Store(int64_t{1} << 32));
  CheckRead(NS_ERROR_LOSS_OF_SIGNIFICANT_DATA, kDefault);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties, NullOutputFails) {
  EXPECT_EQ(NS_ERROR_INVALID_POINTER,
            mInfo->GetUint32Property("value", kDefault, nullptr));
}

TEST_F(DISABLED_DeliveryFolderInfoProperties, BooleanStoredFalseKeepsCanary) {
  ASSERT_NO_FATAL_FAILURE(StoreBoolean(false));
  CheckBooleanRead(true, false);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties, BooleanStoredTrueKeepsCanary) {
  ASSERT_NO_FATAL_FAILURE(StoreBoolean(true));
  CheckBooleanRead(false, true);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties, BooleanMissingDefaultsFalse) {
  CheckBooleanRead(false, false);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties, BooleanMissingDefaultsTrue) {
  CheckBooleanRead(true, true);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties, BooleanRepeatedReadsKeepCanary) {
  ASSERT_NO_FATAL_FAILURE(StoreBoolean(true));
  CheckBooleanRead(false, true);
  CheckBooleanRead(true, true);
  CheckBooleanRead(false, true);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties, BooleanNullOutputFails) {
  EXPECT_EQ(NS_ERROR_INVALID_POINTER,
            mInfo->GetBooleanProperty("value", false, nullptr));
}

TEST_F(DISABLED_DeliveryFolderInfoProperties, BooleanZeroIsFalse) {
  ASSERT_NO_FATAL_FAILURE(Store(0));
  CheckBooleanRead(true, false);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties, BooleanPositiveIsTrue) {
  ASSERT_NO_FATAL_FAILURE(Store(2));
  CheckBooleanRead(false, true);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties, BooleanNegativeIsTrue) {
  ASSERT_NO_FATAL_FAILURE(Store(-1));
  CheckBooleanRead(false, true);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties, BooleanWideIsTrue) {
  ASSERT_NO_FATAL_FAILURE(Store(int64_t{1} << 32));
  CheckBooleanRead(false, true);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties, BooleanMinInt64IsTrue) {
  ASSERT_NO_FATAL_FAILURE(Store(std::numeric_limits<int64_t>::min()));
  CheckBooleanRead(false, true);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties, BooleanMaxInt64IsTrue) {
  ASSERT_NO_FATAL_FAILURE(Store(std::numeric_limits<int64_t>::max()));
  CheckBooleanRead(false, true);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       KnownArtsMissingReturnsOwnedEmpty) {
  char* result = nullptr;
  ASSERT_EQ(NS_OK, mInfo->GetKnownArtsSet(&result));
  ASSERT_TRUE(result);
  nsCString owned;
  owned.Adopt(result);
  EXPECT_TRUE(owned.IsEmpty());
  nsCOMPtr<mozIStorageStatement> statement;
  ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                       "SELECT count(*) FROM folder_properties "
                       "WHERE id = :id AND name = 'knownArts'"_ns,
                       getter_AddRefs(statement)));
  ASSERT_EQ(NS_OK, statement->BindInt64ByName("id"_ns, mDatabase->FolderId()));
  bool row;
  ASSERT_EQ(NS_OK, statement->ExecuteStep(&row));
  ASSERT_TRUE(row);
  EXPECT_EQ(0, statement->AsInt32(0));
}

TEST_F(DISABLED_DeliveryFolderInfoProperties, KnownArtsNullOutputFails) {
  EXPECT_EQ(NS_ERROR_INVALID_POINTER, mInfo->GetKnownArtsSet(nullptr));
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       KnownArtsOpaqueAliasIsFolderScoped) {
  const nsLiteralCString opaque =
      " 0007-0009,3,3-2,not-a-range,\xc3\xa9,e\xcc\x81 "_ns;
  ASSERT_EQ(NS_OK, mInfo->SetCharProperty("knownArts", opaque));
  ASSERT_EQ(NS_OK, mInfo->SetCharProperty("knownArtsSet", "literal key"_ns));
  ASSERT_EQ(NS_OK, mInfo->SetCharProperty("readSet", "2-4"_ns));
  ASSERT_EQ(NS_OK, mInfo->SetMailboxName("Unchanged/InBoX"_ns));
  uint64_t otherId;
  ASSERT_EQ(NS_OK,
            sFolders->InsertFolder(sRoot, "known-arts-other"_ns, &otherId));
  RefPtr<PerFolderDatabase> otherDatabase =
      new PerFolderDatabase(otherId, false);
  nsCOMPtr<nsIDBFolderInfo> otherInfo;
  auto cleanupOther = MakeScopeExit([&] {
    otherInfo = nullptr;
    sCore->MessageDB().RemoveMessageListener(otherDatabase);
  });
  ASSERT_EQ(NS_OK, otherDatabase->GetDBFolderInfo(getter_AddRefs(otherInfo)));
  ASSERT_TRUE(otherInfo);
  ASSERT_EQ(NS_OK, otherInfo->SetCharProperty("knownArts", "other group"_ns));
  nsCString held;
  ASSERT_EQ(NS_OK, mInfo->GetKnownArtsSet(getter_Copies(held)));
  EXPECT_EQ(opaque, held);
  ASSERT_EQ(NS_OK, mInfo->SetKnownArtsSet("9-1,0002,0002"));
  EXPECT_EQ(opaque, held);
  nsAutoCString value;
  ASSERT_EQ(NS_OK, mInfo->GetCharProperty("knownArts", value));
  EXPECT_EQ("9-1,0002,0002"_ns, value);
  ASSERT_EQ(NS_OK, mInfo->GetCharProperty("knownArtsSet", value));
  EXPECT_EQ("literal key"_ns, value);
  ASSERT_EQ(NS_OK, mInfo->GetCharProperty("readSet", value));
  EXPECT_EQ("2-4"_ns, value);
  ASSERT_EQ(NS_OK, mInfo->GetMailboxName(value));
  EXPECT_EQ("Unchanged/InBoX"_ns, value);
  ASSERT_EQ(NS_OK, otherInfo->GetCharProperty("knownArts", value));
  EXPECT_EQ("other group"_ns, value);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       KnownArtsEmptyAndNullRemainPresent) {
  for (const char* empty : {"", static_cast<const char*>(nullptr)}) {
    ASSERT_EQ(NS_OK, mInfo->SetKnownArtsSet("original"));
    ASSERT_EQ(NS_OK, mInfo->SetKnownArtsSet(empty));
    char* result = nullptr;
    ASSERT_EQ(NS_OK, mInfo->GetKnownArtsSet(&result));
    ASSERT_TRUE(result);
    nsCString owned;
    owned.Adopt(result);
    EXPECT_TRUE(owned.IsEmpty());
    nsCOMPtr<mozIStorageStatement> statement;
    ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                         "SELECT count(*) FROM folder_properties "
                         "WHERE id = :id AND name = 'knownArts'"_ns,
                         getter_AddRefs(statement)));
    ASSERT_EQ(NS_OK,
              statement->BindInt64ByName("id"_ns, mDatabase->FolderId()));
    bool row;
    ASSERT_EQ(NS_OK, statement->ExecuteStep(&row));
    ASSERT_TRUE(row);
    EXPECT_EQ(1, statement->AsInt32(0));
  }
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       KnownArtsReadStepFailureClearsOutput) {
  ASSERT_EQ(NS_OK, mInfo->SetKnownArtsSet("original,0007"));
  ASSERT_EQ(NS_OK, mInfo->SetCharProperty("readSet", "2-4"_ns));
  RefPtr<KnownArtsFaultWitness> witness = new KnownArtsFaultWitness(true);
  {
    ASSERT_EQ(NS_OK,
              Connection()->CreateFunction("known_arts_fault"_ns, 1, witness));
    auto cleanup = MakeScopeExit([] {
      EXPECT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                           "DROP VIEW IF EXISTS temp.folder_properties"_ns));
      EXPECT_EQ(NS_OK, Connection()->RemoveFunction("known_arts_fault"_ns));
    });
    ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "CREATE TEMP VIEW folder_properties AS "
                         "SELECT id, name, known_arts_fault(id) AS value "
                         "FROM main.folder_properties"_ns));
    nsCOMPtr<mozIStorageStatement> prepared;
    ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                         "SELECT value FROM folder_properties "
                         "WHERE id = :id AND name = :name"_ns,
                         getter_AddRefs(prepared)));
    ASSERT_EQ(NS_OK, prepared->Finalize());
    EXPECT_EQ(0u, witness->mCalls);
    char canary[] = "untouched";
    char* result = canary;
    EXPECT_EQ(NS_ERROR_FAILURE, mInfo->GetKnownArtsSet(&result));
    nsCString owned;
    if (result && result != canary) {
      owned.Adopt(result);
    }
    EXPECT_EQ(nullptr, result);
    EXPECT_EQ(1u, witness->mCalls);
    EXPECT_EQ(int64_t(mDatabase->FolderId()), witness->mLastId);
  }
  nsCString value;
  ASSERT_EQ(NS_OK, mInfo->GetKnownArtsSet(getter_Copies(value)));
  EXPECT_EQ("original,0007"_ns, value);
  ASSERT_EQ(NS_OK, mInfo->GetCharProperty("readSet", value));
  EXPECT_EQ("2-4"_ns, value);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       KnownArtsWriteAbortPreservesRows) {
  ASSERT_EQ(NS_OK, mInfo->SetKnownArtsSet("original,0007"));
  ASSERT_EQ(NS_OK, mInfo->SetCharProperty("readSet", "2-4"_ns));
  uint64_t otherId;
  ASSERT_EQ(NS_OK, sFolders->InsertFolder(sRoot, "known-arts-write-control"_ns,
                                          &otherId));
  RefPtr<PerFolderDatabase> otherDatabase =
      new PerFolderDatabase(otherId, false);
  nsCOMPtr<nsIDBFolderInfo> otherInfo;
  auto cleanupOther = MakeScopeExit([&] {
    otherInfo = nullptr;
    sCore->MessageDB().RemoveMessageListener(otherDatabase);
  });
  ASSERT_EQ(NS_OK, otherDatabase->GetDBFolderInfo(getter_AddRefs(otherInfo)));
  ASSERT_TRUE(otherInfo);
  ASSERT_EQ(NS_OK, otherInfo->SetCharProperty("knownArts", "other group"_ns));
  RefPtr<KnownArtsFaultWitness> witness = new KnownArtsFaultWitness();
  {
    ASSERT_EQ(NS_OK,
              Connection()->CreateFunction("known_arts_fault"_ns, 1, witness));
    auto cleanup = MakeScopeExit([] {
      EXPECT_EQ(NS_OK,
                Connection()->ExecuteSimpleSQL(
                    "DROP TRIGGER IF EXISTS temp.known_arts_write_fault"_ns));
      EXPECT_EQ(NS_OK, Connection()->RemoveFunction("known_arts_fault"_ns));
    });
    ASSERT_EQ(NS_OK,
              Connection()->ExecuteSimpleSQL(
                  "CREATE TEMP TRIGGER known_arts_write_fault "
                  "BEFORE INSERT ON main.folder_properties "
                  "WHEN NEW.name = 'knownArts' BEGIN "
                  "SELECT known_arts_fault(NEW.id); "
                  "SELECT RAISE(ABORT, 'known arts write fault'); END"_ns));
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
              mInfo->SetKnownArtsSet("replacement"));
    EXPECT_EQ(1u, witness->mCalls);
    EXPECT_EQ(int64_t(mDatabase->FolderId()), witness->mLastId);
  }
  nsCString value;
  ASSERT_EQ(NS_OK, mInfo->GetKnownArtsSet(getter_Copies(value)));
  EXPECT_EQ("original,0007"_ns, value);
  ASSERT_EQ(NS_OK, mInfo->GetCharProperty("readSet", value));
  EXPECT_EQ("2-4"_ns, value);
  ASSERT_EQ(NS_OK, otherInfo->GetCharProperty("knownArts", value));
  EXPECT_EQ("other group"_ns, value);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       KnownArtsColdReopenRetainsValues) {
  const nsLiteralCString opaque = "0007-0009,3,3-2,\xc3\xa9,e\xcc\x81 "_ns;
  const char* const expectedValues[] = {opaque.get(), ""};
  for (const char* expected : expectedValues) {
    ASSERT_EQ(NS_OK, mInfo->SetKnownArtsSet(expected));
    ASSERT_EQ(NS_OK, mInfo->SetCharProperty("readSet", "2-4"_ns));
    const uint64_t folderId = mDatabase->FolderId();
    mInfo = nullptr;
    sCore->MessageDB().RemoveMessageListener(mDatabase);
    mDatabase = nullptr;
    sFolders = nullptr;
    nsCOMPtr<mozIStorageConnection> connection = Connection();
    nsCOMPtr<nsIEventTarget> target = do_GetInterface(connection);
    ASSERT_TRUE(target);
    ASSERT_EQ(NS_OK, sCore->Observe(nullptr, "profile-before-change", nullptr));
    sCore = nullptr;
    ASSERT_TRUE(WaitForClose(target));
    target = nullptr;
    connection = nullptr;
    ASSERT_FALSE(Connection());
    ASSERT_TRUE(CoreReleased());
    sCore = DatabaseCore::GetInstanceForService();
    ASSERT_EQ(NS_OK, sCore->Startup());
    ASSERT_EQ(NS_OK, sCore->GetFolderDB(getter_AddRefs(sFolders)));
    mDatabase = new PerFolderDatabase(folderId, false);
    ASSERT_EQ(NS_OK, mDatabase->GetDBFolderInfo(getter_AddRefs(mInfo)));
    char* result = nullptr;
    ASSERT_EQ(NS_OK, mInfo->GetKnownArtsSet(&result));
    ASSERT_TRUE(result);
    nsCString owned;
    owned.Adopt(result);
    EXPECT_STREQ(expected, owned.get());
    nsAutoCString value;
    ASSERT_EQ(NS_OK, mInfo->GetCharProperty("readSet", value));
    EXPECT_EQ("2-4"_ns, value);
    nsCOMPtr<mozIStorageStatement> statement;
    ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                         "SELECT count(*) FROM folder_properties "
                         "WHERE id = :id AND name = 'knownArts'"_ns,
                         getter_AddRefs(statement)));
    ASSERT_EQ(NS_OK, statement->BindInt64ByName("id"_ns, folderId));
    bool row;
    ASSERT_EQ(NS_OK, statement->ExecuteStep(&row));
    ASSERT_TRUE(row);
    EXPECT_EQ(1, statement->AsInt32(0));
  }
}

}  // namespace
}  // namespace mozilla::mailnews
