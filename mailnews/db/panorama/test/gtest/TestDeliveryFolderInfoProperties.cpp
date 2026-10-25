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
#include "nsCOMPtr.h"
#include "nsIDBFolderInfo.h"
#include "nsIFolderDatabase.h"
#include "nsString.h"

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

class DISABLED_DeliveryFolderInfoProperties : public ::testing::Test {
 protected:
  static void SetUpTestSuite() {
    // Manual-only until profile setup and async shutdown are validated.
    sStartedCore = false;
    sCore = DatabaseCore::GetInstanceForService();
    ASSERT_EQ(NS_OK, sCore->GetFolderDB(getter_AddRefs(sFolders)));
    if (!sFolders) {
      ASSERT_EQ(NS_OK, sCore->Startup());
      sStartedCore = true;
      ASSERT_EQ(NS_OK, sCore->GetFolderDB(getter_AddRefs(sFolders)));
    }
    ASSERT_TRUE(sFolders);
    ASSERT_EQ(NS_OK, sFolders->GetFolderChildNamed(
                         0, "delivery-folder-info-width"_ns, &sRoot));
    if (!sRoot) {
      ASSERT_EQ(NS_OK,
                sFolders->InsertRoot("delivery-folder-info-width"_ns, &sRoot));
    }
  }

  static void TearDownTestSuite() {
    sFolders = nullptr;
    if (sStartedCore) {
      EXPECT_EQ(NS_OK,
                sCore->Observe(nullptr, "profile-before-change", nullptr));
    }
    sCore = nullptr;
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

  static inline RefPtr<DatabaseCore> sCore;
  static inline nsCOMPtr<nsIFolderDatabase> sFolders;
  static inline uint64_t sRoot = 0;
  static inline bool sStartedCore = false;
  RefPtr<PerFolderDatabase> mDatabase;
  nsCOMPtr<nsIDBFolderInfo> mInfo;
};

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

}  // namespace
}  // namespace mozilla::mailnews
