/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <cstdint>
#include <utility>

#include "DatabaseCore.h"
#include "gtest/gtest.h"
#include "mozilla/ResultExtensions.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/SpinEventLoopUntil.h"
#include "mozilla/Try.h"
#include "mozIStorageConnection.h"
#include "mozIStorageService.h"
#include "mozIStorageStatement.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "nsIEventTarget.h"
#include "nsIFile.h"
#include "nsIInterfaceRequestorUtils.h"
#include "nsIProperties.h"
#include "nsServiceManagerUtils.h"
#include "nsThreadUtils.h"
#include "nsXPCOMCID.h"

namespace mozilla::mailnews {

class DeliveryCoreProperties : public testing::Test {
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
    // Retain failed fixtures outside the harness profile's cleanup tree.
    ASSERT_EQ(NS_OK,
              NS_GetSpecialDirectory(NS_OS_TEMP_DIR, getter_AddRefs(mProfile)));
    ASSERT_EQ(NS_OK, mProfile->Append(u"delivery-core-properties"_ns));
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
  }

  void TearDown() override {
    bool drained = Stop();
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

  nsresult Start() {
    mCore = DatabaseCore::GetInstanceForService();
    auto cleanup = MakeScopeExit([&] { Stop(); });
    MOZ_TRY(mCore->Startup());
    NS_ENSURE_TRUE(Connection(), NS_ERROR_UNEXPECTED);
    nsCOMPtr<nsIFile> actualFile;
    MOZ_TRY(Connection()->GetDatabaseFile(getter_AddRefs(actualFile)));
    bool sameFile = false;
    MOZ_TRY(mFile->Equals(actualFile, &sameFile));
    NS_ENSURE_TRUE(sameFile, NS_ERROR_UNEXPECTED);
    if (!mFolder) {
      uint64_t root;
      MOZ_TRY(mCore->FolderDB().InsertRoot("native-properties"_ns, &root));
      MOZ_TRY(mCore->FolderDB().InsertFolder(root, "Inbox"_ns, &mFolder));
    }
    cleanup.release();
    return NS_OK;
  }

  bool Stop() {
    if (!mCore) {
      return !mCloseFailed;
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
    mCloseFailed = mCloseFailed || !drained;
    return !mCloseFailed;
  }

  static bool WaitForClose(nsIEventTarget* target) {
    sCloseCompleted = false;
    // Observe queues AsyncClose before this barrier, with no intervening spin.
    nsresult rv = target->Dispatch(
        NS_NewRunnableFunction(
            "CorePropertiesCloseBarrier",
            [] {
              MOZ_ALWAYS_SUCCEEDS(
                  NS_DispatchToMainThread(NS_NewRunnableFunction(
                      "CorePropertiesClosed", [] { sCloseCompleted = true; })));
            }),
        NS_DISPATCH_NORMAL);
    EXPECT_EQ(NS_OK, rv);
    if (NS_FAILED(rv)) {
      return false;
    }
    bool drained = SpinEventLoopUntil("CorePropertiesClosed"_ns,
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

  nsresult Open(mozIStorageConnection** connection) {
    nsCOMPtr<mozIStorageService> storage =
        do_GetService("@mozilla.org/storage/service;1");
    NS_ENSURE_TRUE(storage, NS_ERROR_UNEXPECTED);
    return storage->OpenUnsharedDatabase(
        mFile, mozIStorageService::CONNECTION_DEFAULT, connection);
  }

  nsresult Add(nsMsgKey& key) {
    return mCore->MessageDB().AddMessage(
        mFolder, "properties@invalid"_ns, {}, 123456, "sender"_ns,
        "recipient"_ns, EmptyCString(), EmptyCString(), "subject"_ns, 0,
        EmptyCString(), 0, &key);
  }

  nsresult SetFolder(const nsACString& name, const nsACString& value) {
    return mCore->FolderDB().SetFolderProperty(mFolder, name, value);
  }

  nsresult GetFolder(const nsACString& name, nsACString& value) {
    return mCore->FolderDB().GetFolderProperty(mFolder, name, value);
  }

  void CheckStored(const nsACString& table, uint64_t id, const nsACString& name,
                   const nsACString& expected,
                   const nsACString& expectedType = "text"_ns) {
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
    nsCOMPtr<mozIStorageStatement> stmt;
    auto cleanup = MakeScopeExit([&] {
      if (stmt) {
        EXPECT_EQ(NS_OK, stmt->Finalize());
      }
      EXPECT_EQ(NS_OK, reader->Close());
    });
    ASSERT_EQ(NS_OK, reader->CreateStatement(
                         "SELECT value, typeof(value) FROM "_ns + table +
                             " WHERE id = :id AND name = :name"_ns,
                         getter_AddRefs(stmt)));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, id));
    ASSERT_EQ(NS_OK, stmt->BindUTF8StringByName("name"_ns, name));
    bool more;
    ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
    ASSERT_TRUE(more);
    nsCString text, type;
    ASSERT_EQ(NS_OK, stmt->GetUTF8String(0, text));
    ASSERT_EQ(NS_OK, stmt->GetUTF8String(1, type));
    EXPECT_EQ(expected, text);
    EXPECT_EQ(expectedType, type);
    ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
    EXPECT_FALSE(more);
  }

  nsresult Snapshot(nsTArray<nsCString>& cells) {
    nsCOMPtr<mozIStorageConnection> reader;
    MOZ_TRY(Open(getter_AddRefs(reader)));
    nsCOMPtr<mozIStorageStatement> stmt;
    auto cleanup = MakeScopeExit([&] {
      if (stmt) {
        EXPECT_EQ(NS_OK, stmt->Finalize());
      }
      EXPECT_EQ(NS_OK, reader->Close());
    });
    // Compare opaque cell bytes and storage classes across the upgrade.
    MOZ_TRY(reader->CreateStatement(
        "SELECT 'folder:' || id || ':' || hex(name) || ':' || typeof(value) || "
        "':' || hex(value) FROM folder_properties UNION ALL "
        "SELECT 'message:' || id || ':' || hex(name) || ':' || typeof(value) "
        "|| "
        "':' || hex(value) FROM message_properties ORDER BY 1"_ns,
        getter_AddRefs(stmt)));
    cells.Clear();
    while (true) {
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      if (!more) {
        return NS_OK;
      }
      nsCString cell;
      MOZ_TRY(stmt->GetUTF8String(0, cell));
      cells.AppendElement(std::move(cell));
    }
  }

  nsresult MakeVersionOne() {
    if (!Stop()) {
      return NS_ERROR_FAILURE;
    }
    nsCOMPtr<mozIStorageConnection> old;
    MOZ_TRY(Open(getter_AddRefs(old)));
    auto cleanup = MakeScopeExit([&] { EXPECT_EQ(NS_OK, old->Close()); });
    MOZ_TRY(old->ExecuteSimpleSQL(
        "BEGIN;"
        "CREATE TABLE old_folder_properties(id INTEGER REFERENCES folders(id),"
        "name TEXT, value ANY, PRIMARY KEY(id, name));"
        "INSERT INTO old_folder_properties SELECT * FROM folder_properties;"
        "DROP TABLE folder_properties;"
        "ALTER TABLE old_folder_properties RENAME TO folder_properties;"
        "CREATE TABLE old_message_properties(id INTEGER REFERENCES "
        "messages(id),"
        "name TEXT, value ANY, PRIMARY KEY(id, name));"
        "INSERT INTO old_message_properties SELECT * FROM message_properties;"
        "DROP TABLE message_properties;"
        "ALTER TABLE old_message_properties RENAME TO message_properties;"
        "PRAGMA user_version = 1; COMMIT;"_ns));
    return NS_OK;
  }

  nsCOMPtr<nsIProperties> mDirectories;
  nsCOMPtr<nsIFile> mOldProfile, mProfile, mFile;
  RefPtr<DatabaseCore> mCore;
  uint64_t mFolder = 0;
  bool mProfileCreated = false;
  bool mDirectoryChanged = false;
  bool mProfileInstalled = false;
  bool mCloseFailed = false;
  inline static bool sCloseCompleted = false;
};

namespace {

using DISABLED_DeliveryCoreProperties = DeliveryCoreProperties;

TEST_F(DISABLED_DeliveryCoreProperties, MessageNamesAndTextAreExact) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add(key));
  const struct {
    nsCString name;
    nsCString text;
  } cases[] = {{"native.caf\xc3\xa9"_ns, "composed"_ns},
               {"native.cafe\xcc\x81"_ns, "decomposed"_ns},
               {"native.Case"_ns, "upper"_ns},
               {"native.case"_ns, "lower"_ns},
               {"native.leading"_ns, "00042"_ns},
               {"native.exponent"_ns, "1e3"_ns},
               {"native.empty"_ns, ""_ns}};
  nsTArray<nsCString> expectedNames;
  for (const auto& item : cases) {
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().SetMessageProperty(key, item.name, item.text));
    expectedNames.AppendElement(item.name);
  }
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(
                       key, "native.cafe\xcc\x81"_ns, "replaced"_ns));
  for (const auto& item : cases) {
    nsCString expected = item.text;
    if (item.name == "native.cafe\xcc\x81"_ns) {
      expected = "replaced"_ns;
    }
    nsCString text;
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessageProperty(key, item.name, text));
    EXPECT_EQ(expected, text);
    ASSERT_NO_FATAL_FAILURE(
        CheckStored("message_properties"_ns, key, item.name, expected));
  }
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessagePropertyNames(key, names));
  names.Sort();
  expectedNames.Sort();
  EXPECT_EQ(expectedNames, names);
  nsCString absent = "sentinel"_ns;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessageProperty(key, "absent"_ns, absent));
  EXPECT_TRUE(absent.IsEmpty());
}

TEST_F(DISABLED_DeliveryCoreProperties, FolderNamesAndTextAreExact) {
  ASSERT_EQ(NS_OK, Start());
  const struct {
    nsCString name;
    nsCString text;
  } cases[] = {{"native.caf\xc3\xa9"_ns, "composed"_ns},
               {"native.cafe\xcc\x81"_ns, "decomposed"_ns},
               {"native.Case"_ns, "upper"_ns},
               {"native.case"_ns, "lower"_ns},
               {"native.leading"_ns, "00042"_ns},
               {"native.exponent"_ns, "1e3"_ns},
               {"native.empty"_ns, ""_ns}};
  for (const auto& item : cases) {
    ASSERT_EQ(NS_OK, SetFolder(item.name, item.text));
  }
  ASSERT_EQ(NS_OK, SetFolder("native.cafe\xcc\x81"_ns, "replaced"_ns));
  for (const auto& item : cases) {
    nsCString expected = item.text;
    if (item.name == "native.cafe\xcc\x81"_ns) {
      expected = "replaced"_ns;
    }
    nsCString text;
    ASSERT_EQ(NS_OK, GetFolder(item.name, text));
    EXPECT_EQ(expected, text);
    ASSERT_NO_FATAL_FAILURE(
        CheckStored("folder_properties"_ns, mFolder, item.name, expected));
  }
}

TEST_F(DISABLED_DeliveryCoreProperties,
       NativeIntegersAndStructuralValuesRemainTyped) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add(key));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(
                       key, "native.unsigned"_ns, UINT32_MAX));
  uint32_t number = 0;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageProperty(
                       key, "native.unsigned"_ns, number));
  EXPECT_EQ(UINT32_MAX, number);
  ASSERT_NO_FATAL_FAILURE(CheckStored("message_properties"_ns, key,
                                      "native.unsigned"_ns, "4294967295"_ns,
                                      "integer"_ns));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageSize(key, UINT32_MAX));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageStoreToken(key, "00042"_ns));
  uint64_t size = 0;
  nsCString token;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageSize(key, size));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageStoreToken(key, token));
  EXPECT_EQ(uint64_t(UINT32_MAX), size);
  EXPECT_EQ("00042"_ns, token);
}

TEST_F(DISABLED_DeliveryCoreProperties, CoreReopenKeepsExactTextAndPresence) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add(key));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(
                       key, "native.cafe\xcc\x81"_ns, "00042"_ns));
  ASSERT_EQ(NS_OK, SetFolder("native.caf\xc3\xa9"_ns, "1e3"_ns));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(key, "native.empty"_ns,
                                                         ""_ns));
  ASSERT_TRUE(Stop());
  ASSERT_EQ(NS_OK, Start());
  nsCString text;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageProperty(
                       key, "native.cafe\xcc\x81"_ns, text));
  EXPECT_EQ("00042"_ns, text);
  ASSERT_EQ(NS_OK, GetFolder("native.caf\xc3\xa9"_ns, text));
  EXPECT_EQ("1e3"_ns, text);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessagePropertyNames(key, names));
  EXPECT_TRUE(names.Contains("native.empty"_ns));
  EXPECT_FALSE(names.Contains("absent"_ns));
  ASSERT_NO_FATAL_FAILURE(
      CheckStored("message_properties"_ns, key, "native.empty"_ns, ""_ns));
}

TEST_F(DISABLED_DeliveryCoreProperties, FailedMessageOverwritePreservesRows) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add(key));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(key, "native.write"_ns,
                                                         "00042"_ns));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().SetMessageProperty(key, "control"_ns, "1e3"_ns));
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL(
                "CREATE TEMP TRIGGER fail_property BEFORE INSERT ON "
                "message_properties WHEN NEW.name = 'native.write' BEGIN "
                "SELECT RAISE(ABORT, 'property write fault'); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, mCore->MessageDB().SetMessageProperty(
                                             key, "native.write"_ns, "new"_ns));
  ASSERT_NO_FATAL_FAILURE(
      CheckStored("message_properties"_ns, key, "native.write"_ns, "00042"_ns));
  ASSERT_NO_FATAL_FAILURE(
      CheckStored("message_properties"_ns, key, "control"_ns, "1e3"_ns));
}

TEST_F(DISABLED_DeliveryCoreProperties, FailedFolderOverwritePreservesRows) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, SetFolder("native.write"_ns, "00042"_ns));
  ASSERT_EQ(NS_OK, SetFolder("control"_ns, "1e3"_ns));
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER fail_property BEFORE INSERT ON "
                       "folder_properties WHEN NEW.name = 'native.write' BEGIN "
                       "SELECT RAISE(ABORT, 'property write fault'); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            SetFolder("native.write"_ns, "new"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckStored("folder_properties"_ns, mFolder,
                                      "native.write"_ns, "00042"_ns));
  ASSERT_NO_FATAL_FAILURE(
      CheckStored("folder_properties"_ns, mFolder, "control"_ns, "1e3"_ns));
}

TEST_F(DISABLED_DeliveryCoreProperties, ReadErrorsAreNotAbsentProperties) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add(key));
  ASSERT_EQ(
      NS_OK,
      Connection()->ExecuteSimpleSQL(
          "DROP TABLE message_properties; DROP TABLE folder_properties"_ns));
  nsCString text = "sentinel"_ns;
  uint32_t number = 99;
  nsTArray<nsCString> names{"sentinel"_ns};
  EXPECT_EQ(NS_ERROR_FAILURE,
            mCore->MessageDB().GetMessageProperty(key, "absent"_ns, text));
  EXPECT_EQ("sentinel"_ns, text);
  EXPECT_EQ(NS_ERROR_FAILURE,
            mCore->MessageDB().GetMessageProperty(key, "absent"_ns, number));
  EXPECT_EQ(99u, number);
  EXPECT_EQ(NS_ERROR_FAILURE,
            mCore->MessageDB().GetMessagePropertyNames(key, names));
  EXPECT_EQ((nsTArray<nsCString>{"sentinel"_ns}), names);
  EXPECT_EQ(NS_ERROR_FAILURE, GetFolder("absent"_ns, text));
  EXPECT_EQ("sentinel"_ns, text);
}

TEST_F(DISABLED_DeliveryCoreProperties, StepErrorsPreserveOutputSentinels) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add(key));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(key, "control"_ns,
                                                         "kept"_ns));
  ASSERT_EQ(NS_OK, SetFolder("control"_ns, "kept"_ns));
  // abs(INT64_MIN) is valid SQL that fails only when the row is evaluated.
  ASSERT_EQ(
      NS_OK,
      Connection()->ExecuteSimpleSQL(
          "ALTER TABLE message_properties RENAME TO saved_message_properties;"
          "CREATE VIEW message_properties AS SELECT id, "
          "CAST(abs(-9223372036854775808) AS TEXT) AS name, value "
          "FROM saved_message_properties;"
          "ALTER TABLE folder_properties RENAME TO saved_folder_properties;"
          "CREATE VIEW folder_properties AS SELECT id, "
          "CAST(abs(-9223372036854775808) AS TEXT) AS name, value "
          "FROM saved_folder_properties;"_ns));
  nsCString text = "sentinel"_ns;
  uint32_t number = 99;
  nsTArray<nsCString> names{"sentinel"_ns};
  EXPECT_EQ(NS_ERROR_FAILURE,
            mCore->MessageDB().GetMessageProperty(key, "control"_ns, text));
  EXPECT_EQ("sentinel"_ns, text);
  EXPECT_EQ(NS_ERROR_FAILURE,
            mCore->MessageDB().GetMessageProperty(key, "control"_ns, number));
  EXPECT_EQ(99u, number);
  EXPECT_EQ(NS_ERROR_FAILURE,
            mCore->MessageDB().GetMessagePropertyNames(key, names));
  EXPECT_EQ((nsTArray<nsCString>{"sentinel"_ns}), names);
  EXPECT_EQ(NS_ERROR_FAILURE, GetFolder("control"_ns, text));
  EXPECT_EQ("sentinel"_ns, text);
}

TEST_F(DISABLED_DeliveryCoreProperties, UpgradePreservesExistingValues) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add(key));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(
                       key, "native.unsigned"_ns, UINT32_MAX));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(
                       key, "native.cafe\xcc\x81"_ns, "exact"_ns));
  ASSERT_EQ(NS_OK, SetFolder("native.caf\xc3\xa9"_ns, "exact"_ns));
  ASSERT_EQ(NS_OK, SetFolder("already.coerced"_ns, "00042"_ns));
  ASSERT_EQ(
      NS_OK,
      Connection()->ExecuteSimpleSQL(
          "INSERT INTO folder_properties SELECT id, 'native.blob', X'00FF42' "
          "FROM folders WHERE name = 'Inbox';"
          "INSERT INTO message_properties SELECT id, 'native.null', NULL "
          "FROM messages;"_ns));
  ASSERT_EQ(NS_OK, MakeVersionOne());
  nsTArray<nsCString> before, after;
  ASSERT_EQ(NS_OK, Snapshot(before));
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, Snapshot(after));
  EXPECT_EQ(before, after);
  int32_t version;
  ASSERT_EQ(NS_OK, Connection()->GetSchemaVersion(&version));
  EXPECT_EQ(2, version);
  ASSERT_NO_FATAL_FAILURE(CheckStored("message_properties"_ns, key,
                                      "native.unsigned"_ns, "4294967295"_ns,
                                      "integer"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckStored("message_properties"_ns, key,
                                      "native.cafe\xcc\x81"_ns, "exact"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckStored("folder_properties"_ns, mFolder,
                                      "native.caf\xc3\xa9"_ns, "exact"_ns));
  // The old numeric-affinity table already discarded the leading zeros.
  ASSERT_NO_FATAL_FAILURE(CheckStored("folder_properties"_ns, mFolder,
                                      "already.coerced"_ns, "42"_ns,
                                      "integer"_ns));
  ASSERT_EQ(NS_OK, SetFolder("after.upgrade"_ns, "00042"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckStored("folder_properties"_ns, mFolder,
                                      "after.upgrade"_ns, "00042"_ns));
}

TEST_F(DISABLED_DeliveryCoreProperties, UpgradeDoesNotDropUnknownIndex) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, SetFolder("control"_ns, "kept"_ns));
  ASSERT_EQ(NS_OK, MakeVersionOne());
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(
      NS_OK,
      old->ExecuteSimpleSQL(
          "CREATE INDEX extra_property_index ON folder_properties(value)"_ns));
  ASSERT_EQ(NS_OK, old->Close());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, Start());
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  bool exists = false;
  ASSERT_EQ(NS_OK, old->IndexExists("extra_property_index"_ns, &exists));
  EXPECT_TRUE(exists);
  int32_t version;
  ASSERT_EQ(NS_OK, old->GetSchemaVersion(&version));
  EXPECT_EQ(1, version);
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL("DROP INDEX extra_property_index"_ns));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
  ASSERT_NO_FATAL_FAILURE(
      CheckStored("folder_properties"_ns, mFolder, "control"_ns, "kept"_ns));
}

TEST_F(DISABLED_DeliveryCoreProperties, FailedUpgradeRollsBackAndRetries) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, SetFolder("control"_ns, "exact"_ns));
  ASSERT_EQ(NS_OK, MakeVersionOne());
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK,
            old->ExecuteSimpleSQL(
                "CREATE TABLE message_properties_v2(unrelated TEXT)"_ns));
  ASSERT_EQ(NS_OK, old->Close());
  EXPECT_EQ(NS_ERROR_FAILURE, Start());
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  int32_t version;
  ASSERT_EQ(NS_OK, old->GetSchemaVersion(&version));
  EXPECT_EQ(1, version);
  bool exists = true;
  ASSERT_EQ(NS_OK, old->TableExists("folder_properties_v2"_ns, &exists));
  EXPECT_FALSE(exists);
  ASSERT_EQ(NS_OK,
            old->ExecuteSimpleSQL("DROP TABLE message_properties_v2"_ns));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
  ASSERT_NO_FATAL_FAILURE(
      CheckStored("folder_properties"_ns, mFolder, "control"_ns, "exact"_ns));
}

}  // namespace
}  // namespace mozilla::mailnews
