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
#include "nsIMsgHdr.h"
#include "nsIProperties.h"
#include "nsIVariant.h"
#include "nsIWritablePropertyBag.h"
#include "nsIWritablePropertyBag2.h"
#include "nsMsgFolderFlags.h"
#include "nsMsgMessageFlags.h"
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

  static nsresult Encode(const nsTArray<FolderImportProperty>& properties,
                         nsIPropertyBag2** info) {
    return FolderInfo::EncodeTransferInfo(properties, info);
  }

  static nsresult Decode(nsIPropertyBag2* info,
                         nsTArray<FolderImportProperty>& properties) {
    return FolderInfo::DecodeTransferInfo(info, properties);
  }

  nsresult ReadTransfer(nsTArray<FolderImportProperty>& properties) {
    RefPtr<FolderInfo> info = new FolderInfo(mDatabase);
    return info->ReadTransferProperties(properties);
  }

  static void ExpectProperties(const nsTArray<FolderImportProperty>& expected,
                               const nsTArray<FolderImportProperty>& actual) {
    ASSERT_EQ(expected.Length(), actual.Length());
    for (const auto& wanted : expected) {
      const FolderImportProperty* found = nullptr;
      for (const auto& property : actual) {
        if (wanted.name == property.name) {
          EXPECT_FALSE(found);
          found = &property;
        }
      }
      ASSERT_TRUE(found);
      EXPECT_EQ(wanted.integer, found->integer);
      EXPECT_EQ(wanted.text, found->text);
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

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       TransferConversionRoundTripsExactTypes) {
  const nsTArray<FolderImportProperty> expected{
      {""_ns, "empty name"_ns, Nothing()},
      {"Case"_ns, "upper"_ns, Nothing()},
      {"case"_ns, "lower"_ns, Nothing()},
      {"Caf\xC3\xA9"_ns, "composed"_ns, Nothing()},
      {"Cafe\xCC\x81"_ns, "decomposed"_ns, Nothing()},
      {"empty"_ns, ""_ns, Nothing()},
      {"zeros"_ns, "00042"_ns, Nothing()},
      {"exponent"_ns, "1e3"_ns, Nothing()},
      {"bytes"_ns, nsCString("a\0b", 3), Nothing()},
      {nsCString("n\0m", 3), "name with NUL"_ns, Nothing()},
      {"minimum"_ns, ""_ns, Some(std::numeric_limits<int64_t>::min())},
      {"maximum"_ns, ""_ns, Some(std::numeric_limits<int64_t>::max())},
      {"zero"_ns, ""_ns, Some(int64_t{0})}};
  nsCOMPtr<nsIPropertyBag2> bag;
  ASSERT_EQ(NS_OK, Encode(expected, getter_AddRefs(bag)));
  bool present = true;
  ASSERT_EQ(NS_OK, bag->HasKey(u"absent"_ns, &present));
  EXPECT_FALSE(present);
  ASSERT_EQ(NS_OK, bag->HasKey(u"empty"_ns, &present));
  EXPECT_TRUE(present);
  nsCOMPtr<nsIVariant> value;
  ASSERT_EQ(NS_OK, bag->GetProperty(u"zeros"_ns, getter_AddRefs(value)));
  EXPECT_EQ(nsIDataType::VTYPE_CSTRING, value->GetDataType());
  ASSERT_EQ(NS_OK, bag->GetProperty(u"maximum"_ns, getter_AddRefs(value)));
  EXPECT_EQ(nsIDataType::VTYPE_INT64, value->GetDataType());
  nsAutoCString decimal;
  ASSERT_EQ(NS_OK, bag->GetPropertyAsACString(u"maximum"_ns, decimal));
  EXPECT_EQ("9223372036854775807"_ns, decimal);
  ASSERT_EQ(NS_OK, bag->GetPropertyAsACString(u"minimum"_ns, decimal));
  EXPECT_EQ("-9223372036854775808"_ns, decimal);
  nsTArray<FolderImportProperty> actual;
  ASSERT_EQ(NS_OK, Decode(bag, actual));
  ExpectProperties(expected, actual);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       TransferConversionPreservesUnicodeVariants) {
  nsCOMPtr<nsIWritablePropertyBag2> bag =
      do_CreateInstance("@mozilla.org/hash-property-bag;1");
  ASSERT_TRUE(bag);
  ASSERT_EQ(NS_OK,
            bag->SetPropertyAsAString(u"wide"_ns, u"\u03b1\U0001f600"_ns));
  ASSERT_EQ(NS_OK, bag->SetPropertyAsAUTF8String(
                       u"utf8"_ns, "\xCE\xB1\xF0\x9F\x98\x80"_ns));
  nsTArray<FolderImportProperty> actual;
  ASSERT_EQ(NS_OK, Decode(bag, actual));
  const nsTArray<FolderImportProperty> expected{
      {"wide"_ns, "\xCE\xB1\xF0\x9F\x98\x80"_ns, Nothing()},
      {"utf8"_ns, "\xCE\xB1\xF0\x9F\x98\x80"_ns, Nothing()}};
  ExpectProperties(expected, actual);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       TransferConversionPreservesSizedBytes) {
  nsCOMPtr<nsIWritablePropertyBag2> bag =
      do_CreateInstance("@mozilla.org/hash-property-bag;1");
  ASSERT_TRUE(bag);
  nsCOMPtr<nsIWritablePropertyBag> generic = do_QueryInterface(bag);
  ASSERT_TRUE(generic);
  nsCOMPtr<nsIWritableVariant> value =
      do_CreateInstance("@mozilla.org/variant;1");
  ASSERT_TRUE(value);
  ASSERT_EQ(NS_OK, value->SetAsStringWithSize(3, "a\0b"));
  ASSERT_EQ(NS_OK, generic->SetProperty(u"bytes"_ns, value));
  nsTArray<FolderImportProperty> properties;
  ASSERT_EQ(NS_OK, Decode(bag, properties));
  ExpectProperties({{"bytes"_ns, nsCString("a\0b", 3), Nothing()}}, properties);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       TransferConversionUnsignedOverflowKeepsOutput) {
  nsCOMPtr<nsIWritablePropertyBag2> bag =
      do_CreateInstance("@mozilla.org/hash-property-bag;1");
  ASSERT_TRUE(bag);
  ASSERT_EQ(NS_OK, bag->SetPropertyAsUint64(
                       u"wide"_ns, static_cast<uint64_t>(
                                       std::numeric_limits<int64_t>::max())));
  nsTArray<FolderImportProperty> actual;
  ASSERT_EQ(NS_OK, Decode(bag, actual));
  ExpectProperties(
      {{"wide"_ns, ""_ns, Some(std::numeric_limits<int64_t>::max())}}, actual);
  ASSERT_EQ(NS_OK, bag->SetPropertyAsUint64(
                       u"wide"_ns, std::numeric_limits<uint64_t>::max()));
  const nsTArray<FolderImportProperty> sentinel{
      {"sentinel"_ns, "unchanged"_ns, Nothing()}};
  actual = sentinel.Clone();
  EXPECT_EQ(NS_ERROR_LOSS_OF_SIGNIFICANT_DATA, Decode(bag, actual));
  ExpectProperties(sentinel, actual);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       TransferConversionRejectsUnsupportedBeforeOutput) {
  nsCOMPtr<nsIWritablePropertyBag2> bag =
      do_CreateInstance("@mozilla.org/hash-property-bag;1");
  ASSERT_TRUE(bag);
  ASSERT_EQ(NS_OK, bag->SetPropertyAsACString(u"valid"_ns, "keep text"_ns));
  ASSERT_EQ(NS_OK, bag->SetPropertyAsDouble(u"unsupported"_ns, 1.5));
  const nsTArray<FolderImportProperty> sentinel{
      {"sentinel"_ns, "unchanged"_ns, Nothing()}};
  nsTArray<FolderImportProperty> actual = sentinel.Clone();
  EXPECT_EQ(NS_ERROR_INVALID_ARG, Decode(bag, actual));
  ExpectProperties(sentinel, actual);
  ASSERT_EQ(NS_OK, bag->SetPropertyAsBool(u"unsupported"_ns, true));
  EXPECT_EQ(NS_ERROR_INVALID_ARG, Decode(bag, actual));
  ExpectProperties(sentinel, actual);
  EXPECT_EQ(NS_ERROR_INVALID_ARG, Decode(nullptr, actual));
  ExpectProperties(sentinel, actual);
  EXPECT_EQ(NS_ERROR_INVALID_POINTER, Encode(sentinel, nullptr));
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       TransferConversionRejectsInvalidNamesAndDuplicates) {
  nsCOMPtr<nsIWritablePropertyBag2> bag =
      do_CreateInstance("@mozilla.org/hash-property-bag;1");
  ASSERT_TRUE(bag);
  nsAutoString name;
  name.Append(char16_t{0xd800});
  ASSERT_EQ(NS_OK, bag->SetPropertyAsACString(name, "text"_ns));
  const nsTArray<FolderImportProperty> sentinel{
      {"sentinel"_ns, "unchanged"_ns, Nothing()}};
  nsTArray<FolderImportProperty> actual = sentinel.Clone();
  EXPECT_EQ(NS_ERROR_INVALID_ARG, Decode(bag, actual));
  ExpectProperties(sentinel, actual);
  nsCOMPtr<nsIPropertyBag2> output;
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            Encode({{"duplicate"_ns, "first"_ns, Nothing()},
                    {"duplicate"_ns, "second"_ns, Nothing()}},
                   getter_AddRefs(output)));
  EXPECT_FALSE(output);
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, Encode({{"\xFF"_ns, "text"_ns, Nothing()}},
                                            getter_AddRefs(output)));
  EXPECT_FALSE(output);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       TransferConversionRejectsInvalidUnicodeText) {
  nsCOMPtr<nsIWritablePropertyBag2> bag =
      do_CreateInstance("@mozilla.org/hash-property-bag;1");
  ASSERT_TRUE(bag);
  nsAutoString text;
  text.Append(char16_t{0xd800});
  ASSERT_EQ(NS_OK, bag->SetPropertyAsAString(u"invalid"_ns, text));
  const nsTArray<FolderImportProperty> sentinel{
      {"sentinel"_ns, "unchanged"_ns, Nothing()}};
  nsTArray<FolderImportProperty> properties = sentinel.Clone();
  EXPECT_EQ(NS_ERROR_INVALID_ARG, Decode(bag, properties));
  ExpectProperties(sentinel, properties);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       TransferSnapshotPreservesPhysicalOwnership) {
  ASSERT_EQ(NS_OK, mInfo->SetCharProperty("id", "metadata id"_ns));
  ASSERT_EQ(NS_OK, mInfo->SetCharProperty("parent", "metadata parent"_ns));
  ASSERT_EQ(NS_OK, mInfo->SetCharProperty("path", "metadata path"_ns));
  ASSERT_EQ(NS_OK, mInfo->SetCharProperty("folderName", "metadata display"_ns));
  ASSERT_EQ(NS_OK, mInfo->SetCharProperty("number", "00042"_ns));
  uint64_t id = mDatabase->FolderId(), parent;
  nsAutoCString name;
  ASSERT_EQ(NS_OK, sFolders->GetFolderParent(id, &parent));
  ASSERT_EQ(NS_OK, sFolders->GetFolderName(id, name));
  uint64_t foreign;
  ASSERT_EQ(NS_OK, sFolders->InsertFolder(id, "foreign"_ns, &foreign));
  RefPtr<PerFolderDatabase> other = new PerFolderDatabase(foreign, false);
  auto cleanup =
      MakeScopeExit([&] { sCore->MessageDB().RemoveMessageListener(other); });
  nsCOMPtr<nsIDBFolderInfo> otherInfo;
  ASSERT_EQ(NS_OK, other->GetDBFolderInfo(getter_AddRefs(otherInfo)));
  ASSERT_EQ(NS_OK, otherInfo->SetCharProperty("foreign", "excluded"_ns));
  nsTArray<FolderImportProperty> properties;
  ASSERT_EQ(NS_OK, ReadTransfer(properties));
  ExpectProperties({{"id"_ns, "metadata id"_ns, Nothing()},
                    {"parent"_ns, "metadata parent"_ns, Nothing()},
                    {"path"_ns, "metadata path"_ns, Nothing()},
                    {"folderName"_ns, "metadata display"_ns, Nothing()},
                    {"number"_ns, "00042"_ns, Nothing()}},
                   properties);
  EXPECT_EQ(id, mDatabase->FolderId());
  uint64_t afterParent;
  nsAutoCString afterName;
  ASSERT_EQ(NS_OK, sFolders->GetFolderParent(id, &afterParent));
  ASSERT_EQ(NS_OK, sFolders->GetFolderName(id, afterName));
  EXPECT_EQ(parent, afterParent);
  EXPECT_EQ(name, afterName);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       TransferSnapshotDistinguishesEmptyAndMissing) {
  nsTArray<FolderImportProperty> properties{
      {"sentinel"_ns, "unchanged"_ns, Nothing()}};
  ASSERT_EQ(NS_OK, ReadTransfer(properties));
  EXPECT_TRUE(properties.IsEmpty());
  ASSERT_EQ(NS_OK, sFolders->DeleteFolder(mDatabase->FolderId()));
  const nsTArray<FolderImportProperty> sentinel{
      {"sentinel"_ns, "unchanged"_ns, Nothing()}};
  properties = sentinel.Clone();
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, ReadTransfer(properties));
  ExpectProperties(sentinel, properties);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       TransferSnapshotStorageErrorKeepsOutput) {
  ASSERT_EQ(NS_OK, mInfo->SetCharProperty("stored", "value"_ns));
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "ALTER TABLE folder_properties RENAME TO "
                       "hidden_transfer_properties"_ns));
  auto restore = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "ALTER TABLE hidden_transfer_properties "
                         "RENAME TO folder_properties"_ns));
  });
  const nsTArray<FolderImportProperty> sentinel{
      {"sentinel"_ns, "unchanged"_ns, Nothing()}};
  nsTArray<FolderImportProperty> properties = sentinel.Clone();
  EXPECT_EQ(NS_ERROR_FAILURE, ReadTransfer(properties));
  ExpectProperties(sentinel, properties);
}

nsresult AddBodyHeader(nsIMsgDatabase* db, nsIMsgDBHdr** result) {
  nsCOMPtr<nsIMsgDBHdr> draft;
  MOZ_TRY(db->CreateNewHdr(getter_AddRefs(draft)));
  MOZ_TRY(draft->SetMessageId("body-settlement@invalid"_ns));
  MOZ_TRY(draft->SetFlags(nsMsgMessageFlags::Read | nsMsgMessageFlags::Marked));
  MOZ_TRY(draft->SetStoreToken("before"_ns));
  MOZ_TRY(draft->SetMessageSize(10));
  MOZ_TRY(draft->SetOfflineMessageSize(11));
  MOZ_TRY(draft->SetLineCount(2));
  return db->AttachHdr(draft, false, result);
}

TEST_F(DeliveryFolderInfoProperties, DeletionKeepsItsConstructionIncarnation) {
  nsAutoCString originalSource;
  ASSERT_EQ(NS_OK, sCore->GetSourceId(originalSource));
  ASSERT_EQ(NS_OK, mInfo->SetExpungedBytes(43));
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK, AddBodyHeader(mDatabase, getter_AddRefs(header)));
  ASSERT_EQ(NS_OK, header->SetMessageSize(7));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, header->GetMessageKey(&key));

  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  bool active = true;
  auto rollback = MakeScopeExit([&] {
    if (active) {
      EXPECT_EQ(NS_OK, Connection()->RollbackTransaction());
    }
  });
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "UPDATE database_identity SET sourceId = "
                       "'{87654321-4321-4321-4321-cba987654321}'"_ns));
  RefPtr<PerFolderDatabase> transient =
      new PerFolderDatabase(mDatabase->FolderId(), false);
  auto cleanup = MakeScopeExit(
      [&] { sCore->MessageDB().RemoveMessageListener(transient); });
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  active = false;
  nsAutoCString restoredSource;
  ASSERT_EQ(NS_OK, sCore->GetSourceId(restoredSource));
  EXPECT_EQ(originalSource, restoredSource);

  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            transient->DeleteMessage(key, nullptr, true));
  bool present = false;
  ASSERT_EQ(NS_OK, transient->ContainsKey(key, &present));
  EXPECT_TRUE(present);
  nsCOMPtr<nsIDBFolderInfo> info;
  ASSERT_EQ(NS_OK, transient->GetDBFolderInfo(getter_AddRefs(info)));
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, info->GetExpungedBytes(&expunged));
  EXPECT_EQ(43, expunged);
  uint32_t size = 0;
  ASSERT_EQ(NS_OK, header->GetMessageSize(&size));
  EXPECT_EQ(7u, size);
  EXPECT_EQ(NS_OK, transient->ForceClosed());
  // The public service retry and successful 43 + 7 accounting stay in
  // test_perFolderDatabase.js with the real local-account policy.
}

TEST_F(DeliveryFolderInfoProperties, AdmissionKeepsItsOriginalSourceReadError) {
  nsAutoCString originalSource;
  ASSERT_EQ(NS_OK, sCore->GetSourceId(originalSource));
  for (bool missing : {true, false}) {
    uint64_t folderId;
    ASSERT_EQ(NS_OK, sFolders->InsertFolder(
                         mDatabase->FolderId(),
                         missing ? "missing"_ns : "corrupt"_ns, &folderId));
    RefPtr<PerFolderDatabase> original = new PerFolderDatabase(folderId, false);
    RefPtr<PerFolderDatabase> admitted;
    auto cleanup = MakeScopeExit([&] {
      sCore->MessageDB().RemoveMessageListener(original);
      if (admitted) {
        sCore->MessageDB().RemoveMessageListener(admitted);
      }
    });
    nsCOMPtr<nsIMsgDBHdr> header;
    ASSERT_EQ(NS_OK, AddBodyHeader(original, getter_AddRefs(header)));
    ASSERT_EQ(NS_OK, header->SetMessageSize(17));
    nsMsgKey key;
    ASSERT_EQ(NS_OK, header->GetMessageKey(&key));
    ASSERT_EQ(NS_OK, original->ForceClosed());

    auto readCounter = [&](bool& present, int64_t& value,
                           nsACString& type) -> nsresult {
      nsCOMPtr<mozIStorageStatement> row;
      MOZ_TRY(Connection()->CreateStatement(
          "SELECT value, typeof(value) FROM folder_properties "
          "WHERE id=:id AND name='expungedBytes'"_ns,
          getter_AddRefs(row)));
      MOZ_TRY(row->BindInt64ByName("id"_ns, folderId));
      MOZ_TRY(row->ExecuteStep(&present));
      if (present) {
        MOZ_TRY(row->GetInt64(0, &value));
        MOZ_TRY(row->GetUTF8String(1, type));
      }
      return row->Finalize();
    };
    bool originalPresent = false;
    int64_t originalValue = 0;
    nsAutoCString originalType;
    ASSERT_EQ(NS_OK, readCounter(originalPresent, originalValue, originalType));
    bool faultInstalled = false;
    auto repair = [&]() -> nsresult {
      if (!faultInstalled) {
        return NS_OK;
      }
      nsresult rv;
      if (missing) {
        rv = Connection()->ExecuteSimpleSQL(
            "ALTER TABLE hidden_admission_identity "
            "RENAME TO database_identity"_ns);
      } else {
        nsCOMPtr<mozIStorageStatement> statement;
        MOZ_TRY(Connection()->CreateStatement(
            "UPDATE database_identity SET sourceId=:source"_ns,
            getter_AddRefs(statement)));
        MOZ_TRY(statement->BindUTF8StringByName("source"_ns, originalSource));
        rv = statement->Execute();
      }
      if (NS_SUCCEEDED(rv)) {
        faultInstalled = false;
      }
      return rv;
    };
    auto restore = MakeScopeExit([&] { EXPECT_EQ(NS_OK, repair()); });
    ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         missing ? "ALTER TABLE database_identity RENAME TO "
                                   "hidden_admission_identity"_ns
                                 : "UPDATE database_identity SET sourceId = "
                                   "'not-a-uuid'"_ns));
    faultInstalled = true;
    admitted = new PerFolderDatabase(folderId, false);
    ASSERT_EQ(NS_OK, repair());
    nsAutoCString restoredSource;
    ASSERT_EQ(NS_OK, sCore->GetSourceId(restoredSource));
    EXPECT_EQ(originalSource, restoredSource);
    EXPECT_EQ(missing ? NS_ERROR_FAILURE : NS_ERROR_FILE_CORRUPTED,
              admitted->DeleteMessage(key, nullptr, true));
    bool present = false;
    ASSERT_EQ(NS_OK, admitted->ContainsKey(key, &present));
    EXPECT_TRUE(present);
    nsCOMPtr<nsIDBFolderInfo> info;
    ASSERT_EQ(NS_OK, admitted->GetDBFolderInfo(getter_AddRefs(info)));
    int64_t expunged = -1;
    ASSERT_EQ(NS_OK, info->GetExpungedBytes(&expunged));
    EXPECT_EQ(0, expunged);
    int64_t value = 0;
    nsAutoCString type;
    ASSERT_EQ(NS_OK, readCounter(present, value, type));
    EXPECT_EQ(originalPresent, present);
    EXPECT_EQ(originalValue, value);
    EXPECT_EQ(originalType, type);
    uint32_t size = 0;
    ASSERT_EQ(NS_OK, header->GetMessageSize(&size));
    EXPECT_EQ(17u, size);
    EXPECT_EQ(NS_OK, admitted->ForceClosed());
    // Actual account/server retry deletion remains an ordinary public JS case.
  }
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       PublicTransferEpochRetiresOnlyOwnedBindings) {
  ASSERT_EQ(NS_OK, mInfo->SetImapUidValidity(7));
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK, AddBodyHeader(mDatabase, getter_AddRefs(header)));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, header->GetMessageKey(&key));
  ASSERT_EQ(NS_OK, sCore->MessageDB().BindMessageToServerUid(
                       key, mDatabase->FolderId(), 7, 91));
  RawHdr raw;
  raw.messageId = "staged-transfer@invalid"_ns;
  nsMsgKey staged;
  ASSERT_EQ(NS_OK, sCore->MessageDB().StageMessage(mDatabase->FolderId(), raw,
                                                   &staged));
  nsAutoCString sql(
      "INSERT INTO staged_message_properties (id,name,value) VALUES (");
  sql.AppendInt(staged);
  sql.Append(", 'uidOnServer', 91)");
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(sql));
  uint64_t otherId;
  ASSERT_EQ(NS_OK,
            sFolders->InsertFolder(sRoot, "transfer-control"_ns, &otherId));
  RefPtr<PerFolderDatabase> other = new PerFolderDatabase(otherId, false);
  auto cleanup =
      MakeScopeExit([&] { sCore->MessageDB().RemoveMessageListener(other); });
  nsCOMPtr<nsIDBFolderInfo> otherInfo;
  ASSERT_EQ(NS_OK, other->GetDBFolderInfo(getter_AddRefs(otherInfo)));
  ASSERT_EQ(NS_OK, otherInfo->SetImapUidValidity(7));
  nsCOMPtr<nsIMsgDBHdr> otherHeader;
  ASSERT_EQ(NS_OK, AddBodyHeader(other, getter_AddRefs(otherHeader)));
  nsMsgKey otherKey;
  ASSERT_EQ(NS_OK, otherHeader->GetMessageKey(&otherKey));
  ASSERT_EQ(NS_OK, sCore->MessageDB().BindMessageToServerUid(otherKey, otherId,
                                                             7, 91));
  nsCOMPtr<nsIPropertyBag2> transfer;
  ASSERT_EQ(NS_OK, mInfo->GetTransferInfo(getter_AddRefs(transfer)));
  nsCOMPtr<nsIWritablePropertyBag2> edit = do_QueryInterface(transfer);
  ASSERT_TRUE(edit);
  ASSERT_EQ(NS_OK, edit->SetPropertyAsInt64(u"UIDValidity"_ns, UINT32_MAX));
  ASSERT_EQ(NS_OK, mInfo->InitFromTransferInfo(transfer));
  uint32_t epoch = 0;
  ASSERT_EQ(NS_OK, mInfo->GetImapUidValidity(&epoch));
  EXPECT_EQ(UINT32_MAX, epoch);
  nsMsgKey found = nsMsgKey_None;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            sCore->MessageDB().GetMessageKeyForServerUid(
                mDatabase->FolderId(), UINT32_MAX, 91, found));
  EXPECT_EQ(nsMsgKey_None, found);
  ASSERT_EQ(NS_OK, sCore->MessageDB().GetMessageKeyForServerUid(otherId, 7, 91,
                                                                found));
  EXPECT_EQ(otherKey, found);
  nsCOMPtr<mozIStorageStatement> statement;
  ASSERT_EQ(
      NS_OK,
      Connection()->CreateStatement(
          "SELECT (SELECT COUNT(*) FROM messages WHERE id=:live), "
          "(SELECT COUNT(*) FROM staged_messages WHERE id=:staged), "
          "(SELECT COUNT(*) FROM message_properties WHERE id=:live AND "
          "name='uidOnServer'), "
          "(SELECT COUNT(*) FROM staged_message_properties WHERE id=:staged AND name='uidOnServer')"_ns,
          getter_AddRefs(statement)));
  ASSERT_EQ(NS_OK, statement->BindInt64ByName("live"_ns, key));
  ASSERT_EQ(NS_OK, statement->BindInt64ByName("staged"_ns, staged));
  bool row = false;
  ASSERT_EQ(NS_OK, statement->ExecuteStep(&row));
  ASSERT_TRUE(row);
  EXPECT_EQ(1, statement->AsInt32(0));
  EXPECT_EQ(1, statement->AsInt32(1));
  EXPECT_EQ(0, statement->AsInt32(2));
  EXPECT_EQ(0, statement->AsInt32(3));
  ASSERT_EQ(NS_OK, statement->Finalize());
  nsAutoCString token;
  ASSERT_EQ(NS_OK, header->GetStoreToken(token));
  EXPECT_EQ("before"_ns, token);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       PublicTransferValidationPrecedesEpochAndFlagWrites) {
  ASSERT_EQ(NS_OK, mInfo->SetImapUidValidity(7));
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK, AddBodyHeader(mDatabase, getter_AddRefs(header)));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, header->GetMessageKey(&key));
  ASSERT_EQ(NS_OK, sCore->MessageDB().BindMessageToServerUid(
                       key, mDatabase->FolderId(), 7, 91));
  nsCOMPtr<nsIPropertyBag2> transfer;
  ASSERT_EQ(NS_OK, mInfo->GetTransferInfo(getter_AddRefs(transfer)));
  nsCOMPtr<nsIWritablePropertyBag2> edit = do_QueryInterface(transfer);
  ASSERT_TRUE(edit);
  ASSERT_EQ(NS_OK, edit->SetPropertyAsInt64(u"UIDValidity"_ns, 8));
  ASSERT_EQ(NS_OK,
            edit->SetPropertyAsInt64(u"flags"_ns, nsMsgFolderFlags::Mail));
  ASSERT_EQ(NS_OK,
            edit->SetPropertyAsInt64(u"version"_ns, int64_t{UINT32_MAX} + 1));
  EXPECT_EQ(NS_ERROR_LOSS_OF_SIGNIFICANT_DATA,
            mInfo->InitFromTransferInfo(transfer));
  uint32_t epoch = 0;
  ASSERT_EQ(NS_OK, mInfo->GetImapUidValidity(&epoch));
  EXPECT_EQ(7u, epoch);
  int32_t flags = -1;
  ASSERT_EQ(NS_OK, mInfo->GetFlags(&flags));
  EXPECT_EQ(0, flags);
  nsMsgKey found = nsMsgKey_None;
  ASSERT_EQ(NS_OK, sCore->MessageDB().GetMessageKeyForServerUid(
                       mDatabase->FolderId(), 7, 91, found));
  EXPECT_EQ(key, found);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       PublicTransferEpochFailureKeepsBindingsAndPrimaryError) {
  ASSERT_EQ(NS_OK, mInfo->SetImapUidValidity(7));
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK, AddBodyHeader(mDatabase, getter_AddRefs(header)));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, header->GetMessageKey(&key));
  ASSERT_EQ(NS_OK, sCore->MessageDB().BindMessageToServerUid(
                       key, mDatabase->FolderId(), 7, 91));
  nsCOMPtr<nsIWritablePropertyBag2> bag =
      do_CreateInstance("@mozilla.org/hash-property-bag;1");
  ASSERT_TRUE(bag);
  ASSERT_EQ(NS_OK, bag->SetPropertyAsInt64(u"UIDValidity"_ns, 8));
  ASSERT_EQ(NS_OK, bag->SetPropertyAsACString(u"later"_ns, "not applied"_ns));
  ASSERT_EQ(
      NS_OK,
      Connection()->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER fail_transfer_epoch BEFORE INSERT ON "
          "folder_properties "
          "WHEN NEW.name='UIDValidity' BEGIN SELECT RAISE(ABORT,'epoch fault'); END"_ns));
  auto cleanup = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "DROP TRIGGER fail_transfer_epoch"_ns));
  });
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, mInfo->InitFromTransferInfo(bag));
  uint32_t epoch = 0;
  ASSERT_EQ(NS_OK, mInfo->GetImapUidValidity(&epoch));
  EXPECT_EQ(7u, epoch);
  nsMsgKey found = nsMsgKey_None;
  ASSERT_EQ(NS_OK, sCore->MessageDB().GetMessageKeyForServerUid(
                       mDatabase->FolderId(), 7, 91, found));
  EXPECT_EQ(key, found);
  nsCOMPtr<nsIPropertyBag2> after;
  ASSERT_EQ(NS_OK, mInfo->GetTransferInfo(getter_AddRefs(after)));
  bool present = true;
  ASSERT_EQ(NS_OK, after->HasKey(u"later"_ns, &present));
  EXPECT_FALSE(present);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       PublicTransferLateFailureKeepsAppliedPrefix) {
  ASSERT_EQ(NS_OK, mInfo->SetImapUidValidity(7));
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK, AddBodyHeader(mDatabase, getter_AddRefs(header)));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, header->GetMessageKey(&key));
  ASSERT_EQ(NS_OK, sCore->MessageDB().BindMessageToServerUid(
                       key, mDatabase->FolderId(), 7, 91));
  nsCOMPtr<nsIWritablePropertyBag2> bag =
      do_CreateInstance("@mozilla.org/hash-property-bag;1");
  ASSERT_TRUE(bag);
  ASSERT_EQ(NS_OK, bag->SetPropertyAsInt64(u"UIDValidity"_ns, 8));
  ASSERT_EQ(NS_OK,
            bag->SetPropertyAsInt64(u"flags"_ns, nsMsgFolderFlags::Mail));
  ASSERT_EQ(NS_OK, bag->SetPropertyAsACString(u"late"_ns, "rejected"_ns));
  ASSERT_EQ(
      NS_OK,
      Connection()->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER fail_transfer_late BEFORE INSERT ON "
          "folder_properties "
          "WHEN NEW.name='late' BEGIN SELECT RAISE(ABORT,'late fault'); END"_ns));
  auto cleanup = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "DROP TRIGGER fail_transfer_late"_ns));
  });
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, mInfo->InitFromTransferInfo(bag));
  uint32_t epoch = 0;
  ASSERT_EQ(NS_OK, mInfo->GetImapUidValidity(&epoch));
  EXPECT_EQ(8u, epoch);
  int32_t flags = 0;
  ASSERT_EQ(NS_OK, mInfo->GetFlags(&flags));
  EXPECT_EQ(static_cast<uint32_t>(nsMsgFolderFlags::Mail),
            static_cast<uint32_t>(flags));
  nsMsgKey found = nsMsgKey_None;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            sCore->MessageDB().GetMessageKeyForServerUid(mDatabase->FolderId(),
                                                         8, 91, found));
  nsAutoCString token;
  ASSERT_EQ(NS_OK, header->GetStoreToken(token));
  EXPECT_EQ("before"_ns, token);
  nsCOMPtr<nsIPropertyBag2> after;
  ASSERT_EQ(NS_OK, mInfo->GetTransferInfo(getter_AddRefs(after)));
  bool present = true;
  ASSERT_EQ(NS_OK, after->HasKey(u"late"_ns, &present));
  EXPECT_FALSE(present);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       PublicTransferEpochDoesNotSettleForeignTransaction) {
  ASSERT_EQ(NS_OK, mInfo->SetImapUidValidity(7));
  nsCOMPtr<nsIWritablePropertyBag2> bag =
      do_CreateInstance("@mozilla.org/hash-property-bag;1");
  ASSERT_TRUE(bag);
  ASSERT_EQ(NS_OK, bag->SetPropertyAsInt64(u"UIDValidity"_ns, 8));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  auto cleanup = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, Connection()->RollbackTransaction()); });
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, mInfo->InitFromTransferInfo(bag));
  bool active = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  uint32_t epoch = 0;
  ASSERT_EQ(NS_OK, mInfo->GetImapUidValidity(&epoch));
  EXPECT_EQ(7u, epoch);
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       PublicTransferMissingAndNullOutputs) {
  EXPECT_EQ(NS_ERROR_INVALID_POINTER, mInfo->GetTransferInfo(nullptr));
  EXPECT_EQ(NS_ERROR_INVALID_ARG, mInfo->InitFromTransferInfo(nullptr));
  nsCOMPtr<nsIPropertyBag2> bag;
  ASSERT_EQ(NS_OK, mInfo->GetTransferInfo(getter_AddRefs(bag)));
  ASSERT_EQ(NS_OK, sFolders->DeleteFolder(mDatabase->FolderId()));
  nsCOMPtr<nsIPropertyBag2> missing;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mInfo->GetTransferInfo(getter_AddRefs(missing)));
  EXPECT_FALSE(missing);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, mInfo->InitFromTransferInfo(bag));
}

TEST_F(DISABLED_DeliveryFolderInfoProperties,
       PublicTransferFlagChangeDoesNotSettleForeignTransaction) {
  nsCOMPtr<nsIWritablePropertyBag2> bag =
      do_CreateInstance("@mozilla.org/hash-property-bag;1");
  ASSERT_TRUE(bag);
  ASSERT_EQ(NS_OK,
            bag->SetPropertyAsInt64(u"flags"_ns, nsMsgFolderFlags::Mail));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  auto cleanup = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, Connection()->RollbackTransaction()); });
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, mInfo->InitFromTransferInfo(bag));
  bool active = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  int32_t flags = -1;
  ASSERT_EQ(NS_OK, mInfo->GetFlags(&flags));
  EXPECT_EQ(0, flags);
}

TEST_F(DeliveryFolderInfoProperties, UserSortOrderWidthPresenceAndErrors) {
  EXPECT_EQ(NS_ERROR_INVALID_POINTER, mInfo->GetUserSortOrder(nullptr));
  GuardedOutput output{0x33445566, kCanary};
  ASSERT_EQ(NS_OK, mInfo->GetUserSortOrder(&output.value));
  EXPECT_EQ(static_cast<uint32_t>(nsIMsgFolder::NO_SORT_VALUE), output.value);
  EXPECT_EQ(kCanary, static_cast<uint32_t>(output.canary));
  nsCOMPtr<mozIStorageStatement> row;
  ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                       "SELECT COUNT(*) FROM folder_properties "
                       "WHERE id=:id AND name='userSortOrder'"_ns,
                       getter_AddRefs(row)));
  ASSERT_EQ(NS_OK, row->BindInt64ByName("id"_ns, mDatabase->FolderId()));
  bool found = false;
  ASSERT_EQ(NS_OK, row->ExecuteStep(&found));
  ASSERT_TRUE(found);
  EXPECT_EQ(0, row->AsInt32(0));
  ASSERT_EQ(NS_OK, row->Finalize());
  for (uint32_t value : {0u, 7u, UINT32_MAX}) {
    ASSERT_EQ(NS_OK, mInfo->SetUserSortOrder(value));
    output = {0x33445566, kCanary};
    ASSERT_EQ(NS_OK, mInfo->GetUserSortOrder(&output.value));
    EXPECT_EQ(value, output.value);
    EXPECT_EQ(kCanary, static_cast<uint32_t>(output.canary));
  }
  for (int64_t value : {int64_t{-1}, int64_t{1} << 32}) {
    ASSERT_EQ(NS_OK, mInfo->SetInt64Property("userSortOrder", value));
    output = {0x33445566, kCanary};
    EXPECT_EQ(NS_ERROR_LOSS_OF_SIGNIFICANT_DATA,
              mInfo->GetUserSortOrder(&output.value));
    EXPECT_EQ(0x33445566u, output.value);
    EXPECT_EQ(kCanary, static_cast<uint32_t>(output.canary));
  }
  ASSERT_EQ(NS_OK, mInfo->SetUserSortOrder(7));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  bool active = true;
  auto rollback = MakeScopeExit([&] {
    if (active) EXPECT_EQ(NS_OK, Connection()->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, mInfo->SetUserSortOrder(11));
  ASSERT_EQ(NS_OK, mInfo->GetUserSortOrder(&output.value));
  EXPECT_EQ(11u, output.value);
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  active = false;
  ASSERT_EQ(NS_OK, mInfo->GetUserSortOrder(&output.value));
  EXPECT_EQ(7u, output.value);
  EXPECT_EQ(kCanary, static_cast<uint32_t>(output.canary));
}

TEST_F(DeliveryFolderInfoProperties, UserSortOrderAdmissionAndReadFailure) {
  ASSERT_EQ(NS_OK, mInfo->SetUserSortOrder(7));
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "ALTER TABLE folder_properties RENAME TO "
                       "hidden_user_sort_properties"_ns));
  bool hidden = true;
  auto restore = MakeScopeExit([&] {
    if (hidden) {
      EXPECT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                           "ALTER TABLE hidden_user_sort_properties "
                           "RENAME TO folder_properties"_ns));
    }
  });
  GuardedOutput output{0x33445566, kCanary};
  EXPECT_EQ(NS_ERROR_FAILURE, mInfo->GetUserSortOrder(&output.value));
  EXPECT_EQ(0x33445566u, output.value);
  EXPECT_EQ(kCanary, static_cast<uint32_t>(output.canary));
  EXPECT_EQ(NS_ERROR_FAILURE, mInfo->SetUserSortOrder(13));
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "ALTER TABLE hidden_user_sort_properties "
                       "RENAME TO folder_properties"_ns));
  hidden = false;
  ASSERT_EQ(NS_OK, mInfo->GetUserSortOrder(&output.value));
  EXPECT_EQ(7u, output.value);

  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  bool active = true;
  auto rollback = MakeScopeExit([&] {
    if (active) EXPECT_EQ(NS_OK, Connection()->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "UPDATE database_identity SET sourceId = "
                       "'{87654321-4321-4321-4321-cba987654321}'"_ns));
  output = {0x33445566, kCanary};
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, mInfo->GetUserSortOrder(&output.value));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, mInfo->SetUserSortOrder(17));
  EXPECT_EQ(0x33445566u, output.value);
  EXPECT_EQ(kCanary, static_cast<uint32_t>(output.canary));
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  active = false;
  ASSERT_EQ(NS_OK, mInfo->GetUserSortOrder(&output.value));
  EXPECT_EQ(7u, output.value);
  ASSERT_EQ(NS_OK, sFolders->DeleteFolder(mDatabase->FolderId()));
  output = {0x33445566, kCanary};
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, mInfo->GetUserSortOrder(&output.value));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, mInfo->SetUserSortOrder(19));
  EXPECT_EQ(0x33445566u, output.value);
  EXPECT_EQ(kCanary, static_cast<uint32_t>(output.canary));
}

}  // namespace
}  // namespace mozilla::mailnews
