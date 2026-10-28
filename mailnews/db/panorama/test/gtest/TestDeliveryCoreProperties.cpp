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
#include "nsIMsgHdr.h"
#include "nsIProperties.h"
#include "nsServiceManagerUtils.h"
#include "nsString.h"
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
        nsAutoString retained;
        EXPECT_EQ(NS_OK, mProfile->GetPath(retained));
        RecordProperty("retained_profile",
                       NS_ConvertUTF16toUTF8(retained).get());
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

  nsresult SetScope(uint64_t id, nsTArray<uint64_t> folders) {
    return mCore->FolderDB().SetVirtualFolderFolders(id, folders);
  }

  void CheckScope(uint64_t id, const nsTArray<uint64_t>& expected) {
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
                  "SELECT searchFolderId FROM virtualFolder_folders "
                  "WHERE virtualFolderId = :id ORDER BY searchFolderId"_ns,
                  getter_AddRefs(stmt)));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, id));
    nsTArray<uint64_t> actual;
    while (true) {
      bool more;
      ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
      if (!more) {
        break;
      }
      int64_t folder;
      ASSERT_EQ(NS_OK, stmt->GetInt64(0, &folder));
      actual.AppendElement(static_cast<uint64_t>(folder));
    }
    EXPECT_EQ(expected, actual);
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

  nsresult DropSearchSchema(mozIStorageConnection* connection) {
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "DROP TRIGGER delete_offline_copies;"
        "DROP TABLE offline_copy_destinations; DROP TABLE offline_attempts;"
        "DROP TABLE offline_operations;"_ns));
    MOZ_TRY(connection->ExecuteSimpleSQL(
        "DROP TRIGGER delete_staged_header;"
        "DROP TABLE staged_message_properties; DROP TABLE "
        "staged_message_references;"
        "DROP TABLE staged_message_reference_sets; DROP TABLE staged_messages;"_ns));
    for (const char* name :
         {"search_message_insert", "search_message_update",
          "search_message_delete", "search_message_properties_INSERT",
          "search_message_properties_UPDATE",
          "search_message_properties_DELETE",
          "search_message_references_INSERT",
          "search_message_references_UPDATE",
          "search_message_references_DELETE",
          "search_message_reference_sets_INSERT",
          "search_message_reference_sets_UPDATE",
          "search_message_reference_sets_DELETE", "search_folder_policy",
          "search_folder_properties_INSERT", "search_folder_properties_UPDATE",
          "search_folder_properties_DELETE", "search_folder_delete"}) {
      nsAutoCString sql("DROP TRIGGER IF EXISTS "_ns);
      sql.Append(name);
      MOZ_TRY(connection->ExecuteSimpleSQL(sql));
    }
    return connection->ExecuteSimpleSQL(
        "DROP TABLE message_changes; DROP TABLE database_identity; "
        "DROP TABLE folder_import_keys; DROP TABLE folder_import_receipts"_ns);
  }

  nsresult MakeVersionTwo() {
    NS_ENSURE_TRUE(Stop(), NS_ERROR_FAILURE);
    nsCOMPtr<mozIStorageConnection> old;
    MOZ_TRY(Open(getter_AddRefs(old)));
    auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, old->Close()); });
    MOZ_TRY(old->ExecuteSimpleSQL("BEGIN"_ns));
    MOZ_TRY(DropSearchSchema(old));
    return old->ExecuteSimpleSQL(
        "DROP TRIGGER guard_message_key; DROP TRIGGER record_message_key;"
        "DROP TRIGGER immutable_message_key;"
        "DROP TABLE message_key_allocator; PRAGMA user_version = 2; COMMIT;"_ns);
  }

  nsresult MakeVersionOne() {
    if (!Stop()) {
      return NS_ERROR_FAILURE;
    }
    nsCOMPtr<mozIStorageConnection> old;
    MOZ_TRY(Open(getter_AddRefs(old)));
    auto cleanup = MakeScopeExit([&] { EXPECT_EQ(NS_OK, old->Close()); });
    MOZ_TRY(old->ExecuteSimpleSQL("BEGIN"_ns));
    MOZ_TRY(DropSearchSchema(old));
    MOZ_TRY(old->ExecuteSimpleSQL(
        "DROP TRIGGER guard_message_key; DROP TRIGGER record_message_key;"
        "DROP TRIGGER immutable_message_key;"
        "DROP TABLE message_key_allocator;"
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
  EXPECT_EQ(9, version);
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

TEST_F(DISABLED_DeliveryCoreProperties, UidValuesAndViewsSurviveCoreReopen) {
  ASSERT_EQ(NS_OK, Start());
  const struct {
    uint32_t uid;
    nsCString text;
  } cases[] = {{0, "0"_ns},
               {1, "1"_ns},
               {42, "2a"_ns},
               {0x80000000u, "80000000"_ns},
               {0xfffffffeu, "fffffffe"_ns},
               {UINT32_MAX, "ffffffff"_ns}};
  nsTArray<nsMsgKey> keys;
  for (const auto& item : cases) {
    nsMsgKey key;
    ASSERT_EQ(NS_OK, Add(key));
    keys.AppendElement(key);
    ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageUidOnServer(key, item.uid));
    uint32_t uid = 99;
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageUidOnServer(key, uid));
    EXPECT_EQ(item.uid, uid);
    nsCOMPtr<nsIMsgDBHdr> header;
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessage(key, getter_AddRefs(header)));
    uid = 99;
    ASSERT_EQ(NS_OK, header->GetUint32Property("uidOnServer", &uid));
    EXPECT_EQ(item.uid, uid);
    nsCString text;
    ASSERT_EQ(NS_OK, header->GetStringProperty("uidOnServer", text));
    EXPECT_EQ(item.text, text);
    ASSERT_NO_FATAL_FAILURE(
        CheckStored("message_properties"_ns, key, "uidOnServer"_ns, item.text));
  }
  ASSERT_TRUE(Stop());
  ASSERT_EQ(NS_OK, Start());
  for (size_t i = 0; i < keys.Length(); ++i) {
    uint32_t uid = 99;
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageUidOnServer(keys[i], uid));
    EXPECT_EQ(cases[i].uid, uid);
    nsCOMPtr<nsIMsgDBHdr> header;
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessage(keys[i], getter_AddRefs(header)));
    uid = 99;
    ASSERT_EQ(NS_OK, header->GetUint32Property("uidOnServer", &uid));
    EXPECT_EQ(cases[i].uid, uid);
    nsCString text;
    ASSERT_EQ(NS_OK, header->GetStringProperty("uidOnServer", text));
    EXPECT_EQ(cases[i].text, text);
  }
}

TEST_F(DISABLED_DeliveryCoreProperties, UidTextPresenceAndNamesStayExact) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add(key));
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessage(key, getter_AddRefs(header)));
  nsTArray<nsCString> before, after, names;
  ASSERT_EQ(NS_OK, Snapshot(before));
  uint32_t uid = 99;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageUidOnServer(key, uid));
  EXPECT_EQ(0u, uid);
  ASSERT_EQ(NS_OK, Snapshot(after));
  EXPECT_EQ(before, after);
  ASSERT_EQ(NS_OK, header->GetProperties(names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));

  ASSERT_EQ(NS_OK, header->SetStringProperty("UidOnServer", "a1"_ns));
  ASSERT_EQ(NS_OK, header->SetStringProperty("uidonserver", "b2"_ns));
  uid = 99;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageUidOnServer(key, uid));
  EXPECT_EQ(0u, uid);
  ASSERT_EQ(NS_OK, header->GetProperties(names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  EXPECT_TRUE(names.Contains("UidOnServer"_ns));
  EXPECT_TRUE(names.Contains("uidonserver"_ns));

  ASSERT_EQ(NS_OK, header->SetStringProperty("uidOnServer", ""_ns));
  uid = 99;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageUidOnServer(key, uid));
  EXPECT_EQ(0u, uid);
  ASSERT_EQ(NS_OK, header->GetProperties(names));
  EXPECT_TRUE(names.Contains("uidOnServer"_ns));
  ASSERT_NO_FATAL_FAILURE(
      CheckStored("message_properties"_ns, key, "uidOnServer"_ns, ""_ns));

  const struct {
    nsCString text;
    uint32_t uid;
  } cases[] = {{"00042"_ns, 66},
               {"1e3"_ns, 483},
               {"2ag"_ns, 42},
               {"xyz"_ns, 0},
               {"100000000"_ns, 268435456},
               {"-1"_ns, 0},
               {"2a \xc3\xa9"_ns, 42}};
  for (const auto& item : cases) {
    ASSERT_EQ(NS_OK, header->SetStringProperty("uidOnServer", item.text));
    uid = 99;
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageUidOnServer(key, uid));
    EXPECT_EQ(item.uid, uid);
    uid = 99;
    ASSERT_EQ(NS_OK, header->GetUint32Property("uidOnServer", &uid));
    EXPECT_EQ(item.uid, uid);
    nsCString text;
    ASSERT_EQ(NS_OK, header->GetStringProperty("uidOnServer", text));
    EXPECT_EQ(item.text, text);
    ASSERT_NO_FATAL_FAILURE(
        CheckStored("message_properties"_ns, key, "uidOnServer"_ns, item.text));
  }
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageUidOnServer(key, 42));
  ASSERT_NO_FATAL_FAILURE(
      CheckStored("message_properties"_ns, key, "UidOnServer"_ns, "a1"_ns));
  ASSERT_NO_FATAL_FAILURE(
      CheckStored("message_properties"_ns, key, "uidonserver"_ns, "b2"_ns));
}

TEST_F(DISABLED_DeliveryCoreProperties, UidIsIndependentOfGlobalAndFolderKeys) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t root, otherFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertRoot("uid-other-root"_ns, &root));
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(root, "Archive"_ns, &otherFolder));
  ASSERT_NE(mFolder, otherFolder);
  nsMsgKey first, second;
  ASSERT_EQ(NS_OK, Add(first));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().AddMessage(
                otherFolder, "other-uid@invalid"_ns, {}, 123456, "sender"_ns,
                "recipient"_ns, EmptyCString(), EmptyCString(), "subject"_ns, 0,
                EmptyCString(), 0, &second));
  ASSERT_NE(first, second);
  ASSERT_NE(0u, first);
  ASSERT_NE(0u, second);
  for (nsMsgKey key : {first, second}) {
    uint32_t uid = 99;
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageUidOnServer(key, uid));
    EXPECT_EQ(0u, uid);
    ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageUidOnServer(key, 42));
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageUidOnServer(key, uid));
    EXPECT_EQ(42u, uid);
  }
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageUidOnServer(first, 1));
  uint32_t uid = 99;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageUidOnServer(second, uid));
  EXPECT_EQ(42u, uid);
  ASSERT_NO_FATAL_FAILURE(
      CheckStored("message_properties"_ns, first, "uidOnServer"_ns, "1"_ns));
  ASSERT_NO_FATAL_FAILURE(
      CheckStored("message_properties"_ns, second, "uidOnServer"_ns, "2a"_ns));

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
                       "SELECT COUNT(*), "
                       "SUM(id = :first AND folderId = :firstFolder), "
                       "SUM(id = :second AND folderId = :secondFolder) "
                       "FROM messages"_ns,
                       getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("first"_ns, first));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("firstFolder"_ns, mFolder));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("second"_ns, second));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("secondFolder"_ns, otherFolder));
  bool more;
  ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
  ASSERT_TRUE(more);
  int64_t count, firstMatches, secondMatches;
  ASSERT_EQ(NS_OK, stmt->GetInt64(0, &count));
  ASSERT_EQ(NS_OK, stmt->GetInt64(1, &firstMatches));
  ASSERT_EQ(NS_OK, stmt->GetInt64(2, &secondMatches));
  EXPECT_EQ(2, count);
  EXPECT_EQ(1, firstMatches);
  EXPECT_EQ(1, secondMatches);
  ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
  EXPECT_FALSE(more);
}

TEST_F(DISABLED_DeliveryCoreProperties, UidMissingKeyPreservesOutputAndRows) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add(control));
  nsCOMPtr<nsIMsgDBHdr> controlHeader;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessage(
                       control, getter_AddRefs(controlHeader)));
  ASSERT_EQ(NS_OK, controlHeader->SetUint32Property("uidOnServer", 1));
  bool exists = true;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(nsMsgKey_None, exists));
  ASSERT_FALSE(exists);
  nsTArray<nsCString> before, after;
  ASSERT_EQ(NS_OK, Snapshot(before));
  uint32_t uid = 0x12345678;
  EXPECT_EQ(NS_ERROR_UNEXPECTED,
            mCore->MessageDB().GetMessageUidOnServer(nsMsgKey_None, uid));
  EXPECT_EQ(0x12345678u, uid);
  EXPECT_EQ(NS_ERROR_UNEXPECTED,
            mCore->MessageDB().SetMessageUidOnServer(nsMsgKey_None, 42));
  ASSERT_EQ(NS_OK, Snapshot(after));
  EXPECT_EQ(before, after);
  ASSERT_NO_FATAL_FAILURE(
      CheckStored("message_properties"_ns, control, "uidOnServer"_ns, "1"_ns));
}

TEST_F(DISABLED_DeliveryCoreProperties, UidDeletedWarmHeaderIsNotMembership) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, Add(key));
  ASSERT_EQ(NS_OK, Add(control));
  {
    nsCOMPtr<nsIMsgDBHdr> header, controlHeader;
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessage(key, getter_AddRefs(header)));
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessage(
                         control, getter_AddRefs(controlHeader)));
    ASSERT_EQ(NS_OK, header->SetUint32Property("uidOnServer", 42));
    ASSERT_EQ(NS_OK, controlHeader->SetUint32Property("uidOnServer", 1));
  }
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessage(key, getter_AddRefs(header)));
  nsCString subject;
  ASSERT_EQ(NS_OK, header->GetSubject(subject));
  ASSERT_EQ("subject"_ns, subject);
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(key));
  ASSERT_EQ(NS_OK, header->GetSubject(subject));
  EXPECT_EQ("subject"_ns, subject);
  bool exists = true;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  ASSERT_FALSE(exists);
  nsTArray<nsCString> before, after;
  ASSERT_EQ(NS_OK, Snapshot(before));
  uint32_t uid = 0x12345678;
  EXPECT_EQ(NS_ERROR_UNEXPECTED,
            mCore->MessageDB().GetMessageUidOnServer(key, uid));
  EXPECT_EQ(0x12345678u, uid);
  EXPECT_EQ(NS_ERROR_UNEXPECTED,
            mCore->MessageDB().SetMessageUidOnServer(key, 42));
  ASSERT_EQ(NS_OK, Snapshot(after));
  EXPECT_EQ(before, after);
  ASSERT_NO_FATAL_FAILURE(
      CheckStored("message_properties"_ns, control, "uidOnServer"_ns, "1"_ns));
}

TEST_F(DISABLED_DeliveryCoreProperties, UidReadStepFailurePreservesOutput) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, Add(key));
  ASSERT_EQ(NS_OK, Add(control));
  {
    nsCOMPtr<nsIMsgDBHdr> header, controlHeader;
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessage(key, getter_AddRefs(header)));
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessage(
                         control, getter_AddRefs(controlHeader)));
    ASSERT_EQ(NS_OK, header->SetUint32Property("uidOnServer", 42));
    ASSERT_EQ(NS_OK, controlHeader->SetUint32Property("uidOnServer", 1));
  }
  nsTArray<nsCString> before, after;
  ASSERT_EQ(NS_OK, Snapshot(before));
  // This valid view faults only when a property row's name is evaluated.
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "ALTER TABLE message_properties RENAME TO "
                       "saved_message_properties;"
                       "CREATE VIEW message_properties AS SELECT id, "
                       "CAST(abs(-9223372036854775808) AS TEXT) AS name, value "
                       "FROM saved_message_properties;"_ns));
  bool exists = false;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  ASSERT_TRUE(exists);
  {
    nsCOMPtr<mozIStorageStatement> probe;
    ASSERT_EQ(NS_OK,
              Connection()->CreateStatement(
                  "SELECT name FROM message_properties WHERE id = :id"_ns,
                  getter_AddRefs(probe)));
    auto cleanup = MakeScopeExit([&] { EXPECT_EQ(NS_OK, probe->Finalize()); });
    ASSERT_EQ(NS_OK, probe->BindInt64ByName("id"_ns, key));
    bool more;
    EXPECT_EQ(NS_ERROR_FAILURE, probe->ExecuteStep(&more));
  }
  uint32_t uid = 0x12345678;
  EXPECT_EQ(NS_ERROR_FAILURE,
            mCore->MessageDB().GetMessageUidOnServer(key, uid));
  EXPECT_EQ(0x12345678u, uid);
  ASSERT_NO_FATAL_FAILURE(CheckStored("saved_message_properties"_ns, key,
                                      "uidOnServer"_ns, "2a"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckStored("saved_message_properties"_ns, control,
                                      "uidOnServer"_ns, "1"_ns));
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "DROP VIEW message_properties;"
                       "ALTER TABLE saved_message_properties RENAME TO "
                       "message_properties;"_ns));
  ASSERT_EQ(NS_OK, Snapshot(after));
  EXPECT_EQ(before, after);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageUidOnServer(key, uid));
  EXPECT_EQ(42u, uid);
}

TEST_F(DISABLED_DeliveryCoreProperties, UidWriteFailurePreservesOldRows) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, Add(key));
  ASSERT_EQ(NS_OK, Add(control));
  {
    nsCOMPtr<nsIMsgDBHdr> header, controlHeader;
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessage(key, getter_AddRefs(header)));
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessage(
                         control, getter_AddRefs(controlHeader)));
    ASSERT_EQ(NS_OK, header->SetUint32Property("uidOnServer", 42));
    ASSERT_EQ(NS_OK, controlHeader->SetUint32Property("uidOnServer", 1));
  }
  nsTArray<nsCString> before, after;
  ASSERT_EQ(NS_OK, Snapshot(before));
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER fail_uid_write BEFORE INSERT ON "
                       "message_properties WHEN NEW.name = 'uidOnServer' BEGIN "
                       "SELECT RAISE(ABORT, 'UID write fault'); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            mCore->MessageDB().SetMessageUidOnServer(key, UINT32_MAX));
  ASSERT_EQ(NS_OK, Snapshot(after));
  EXPECT_EQ(before, after);
  uint32_t uid = 99;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageUidOnServer(key, uid));
  EXPECT_EQ(42u, uid);
  ASSERT_NO_FATAL_FAILURE(
      CheckStored("message_properties"_ns, key, "uidOnServer"_ns, "2a"_ns));
  ASSERT_NO_FATAL_FAILURE(
      CheckStored("message_properties"_ns, control, "uidOnServer"_ns, "1"_ns));
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL("DROP TRIGGER fail_uid_write"_ns));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageUidOnServer(key, UINT32_MAX));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageUidOnServer(key, uid));
  EXPECT_EQ(UINT32_MAX, uid);
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessage(key, getter_AddRefs(header)));
  uid = 99;
  ASSERT_EQ(NS_OK, header->GetUint32Property("uidOnServer", &uid));
  EXPECT_EQ(UINT32_MAX, uid);
  nsCString text;
  ASSERT_EQ(NS_OK, header->GetStringProperty("uidOnServer", text));
  EXPECT_EQ("ffffffff"_ns, text);
  ASSERT_NO_FATAL_FAILURE(
      CheckStored("message_properties"_ns, control, "uidOnServer"_ns, "1"_ns));
}

TEST_F(DeliveryCoreProperties, ServerUidLookupUsesFolderEpochAndPublicView) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, UINT32_MAX));
  uint64_t root, otherFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertRoot("uid-lookup"_ns, &root));
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(root, "Other"_ns, &otherFolder));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(otherFolder, 0));
  const uint32_t values[] = {0, 1, 42, 0x80000000u, 0xfffffffeu, UINT32_MAX};
  nsTArray<nsMsgKey> keys;
  for (uint32_t uid : values) {
    nsMsgKey key;
    ASSERT_EQ(NS_OK, Add(key));
    keys.AppendElement(key);
    ASSERT_EQ(NS_OK, mCore->MessageDB().BindMessageToServerUid(
                         key, mFolder, UINT32_MAX, uid));
  }
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessage(keys[2], getter_AddRefs(header)));
  ASSERT_EQ(NS_OK, header->SetStringProperty("uidOnServer", "0002ag"_ns));
  nsMsgKey other;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(
                       otherFolder, "other@invalid"_ns, {}, 1, "sender"_ns,
                       "recipient"_ns, EmptyCString(), EmptyCString(),
                       "other"_ns, 0, EmptyCString(), 0, &other));
  ASSERT_EQ(NS_OK, mCore->MessageDB().BindMessageToServerUid(other, otherFolder,
                                                             0, 42));
  ASSERT_TRUE(Stop());
  ASSERT_EQ(NS_OK, Start());
  uint32_t epoch = 7;
  ASSERT_EQ(NS_OK, mCore->FolderDB().GetFolderUidValidity(mFolder, epoch));
  EXPECT_EQ(UINT32_MAX, epoch);
  for (size_t i = 0; i < keys.Length(); ++i) {
    nsMsgKey found = nsMsgKey_None;
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageKeyForServerUid(
                         mFolder, UINT32_MAX, values[i], found));
    EXPECT_EQ(keys[i], found);
  }
  nsMsgKey found = nsMsgKey_None;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageKeyForServerUid(otherFolder, 0,
                                                                42, found));
  EXPECT_EQ(other, found);
  found = nsMsgKey_None;
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      mCore->MessageDB().GetMessageKeyForServerUid(mFolder, 0, 42, found));
  EXPECT_EQ(nsMsgKey_None, found);
  ASSERT_NO_FATAL_FAILURE(CheckStored("message_properties"_ns, keys[2],
                                      "uidOnServer"_ns, "0002ag"_ns));
}

TEST_F(DeliveryCoreProperties,
       ServerUidEpochRetiresBindingsWithoutDeletingRows) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 10));
  uint64_t root, otherFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertRoot("uid-retain"_ns, &root));
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(root, "Other"_ns, &otherFolder));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(otherFolder, 20));
  nsMsgKey control;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(
                       otherFolder, "control@invalid"_ns, {}, 1, "sender"_ns,
                       "recipient"_ns, EmptyCString(), EmptyCString(),
                       "control"_ns, 0, EmptyCString(), 0, &control));
  ASSERT_EQ(NS_OK, mCore->MessageDB().BindMessageToServerUid(
                       control, otherFolder, 20, 42));
  nsMsgKey key, unbound;
  ASSERT_EQ(NS_OK, Add(key));
  ASSERT_EQ(NS_OK, Add(unbound));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().BindMessageToServerUid(key, mFolder, 10, 42));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().SetMessageStoreToken(key, "body-token"_ns));
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessage(key, getter_AddRefs(header)));
  ASSERT_EQ(NS_OK, header->SetStringProperty("UidOnServer", "a1"_ns));
  const nsTArray<nsCString> references = {"parent@invalid"_ns,
                                          "parent@invalid"_ns};
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageReferences(key, references));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 10));
  nsMsgKey found = nsMsgKey_None;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageKeyForServerUid(mFolder, 10, 42,
                                                                found));
  EXPECT_EQ(key, found);
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 11));
  found = nsMsgKey_None;
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      mCore->MessageDB().GetMessageKeyForServerUid(mFolder, 10, 42, found));
  EXPECT_EQ(nsMsgKey_None, found);
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      mCore->MessageDB().GetMessageKeyForServerUid(mFolder, 11, 42, found));
  EXPECT_EQ(nsMsgKey_None, found);
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      mCore->MessageDB().GetMessageKeyForServerUid(mFolder, 11, 0, found));
  EXPECT_EQ(nsMsgKey_None, found);
  nsTArray<nsCString> names, actualReferences;
  ASSERT_EQ(NS_OK, header->GetProperties(names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  EXPECT_TRUE(names.Contains("UidOnServer"_ns));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessageReferences(key, actualReferences));
  EXPECT_EQ(references, actualReferences);
  nsCString token, subject;
  ASSERT_EQ(NS_OK, header->GetStoreToken(token));
  EXPECT_EQ("body-token"_ns, token);
  ASSERT_EQ(NS_OK, header->GetSubject(subject));
  EXPECT_EQ("subject"_ns, subject);
  for (nsMsgKey survivor : {key, unbound}) {
    bool exists = false;
    ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(survivor, exists));
    EXPECT_TRUE(exists);
  }
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().BindMessageToServerUid(key, mFolder, 11, 42));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageKeyForServerUid(mFolder, 11, 42,
                                                                found));
  EXPECT_EQ(key, found);
  found = nsMsgKey_None;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageKeyForServerUid(otherFolder, 20,
                                                                42, found));
  EXPECT_EQ(control, found);
  uint64_t count = 0;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(3u, count);
  ASSERT_NO_FATAL_FAILURE(CheckStored("message_properties"_ns, key,
                                      "storeToken"_ns, "body-token"_ns));
}

TEST_F(DeliveryCoreProperties, ServerUidLookupRejectsAmbiguousPhysicalRows) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 7));
  nsMsgKey first, second;
  ASSERT_EQ(NS_OK, Add(first));
  ASSERT_EQ(NS_OK, Add(second));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().BindMessageToServerUid(first, mFolder, 7, 42));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().BindMessageToServerUid(second, mFolder, 7, 1));
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            mCore->MessageDB().BindMessageToServerUid(second, mFolder, 7, 42));
  ASSERT_NO_FATAL_FAILURE(
      CheckStored("message_properties"_ns, second, "uidOnServer"_ns, "1"_ns));
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessage(second, getter_AddRefs(header)));
  ASSERT_EQ(NS_OK, header->SetStringProperty("uidOnServer", "2ag"_ns));
  nsMsgKey found = nsMsgKey_None;
  EXPECT_EQ(
      NS_ERROR_FILE_CORRUPTED,
      mCore->MessageDB().GetMessageKeyForServerUid(mFolder, 7, 42, found));
  EXPECT_EQ(nsMsgKey_None, found);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().BindMessageToServerUid(first, mFolder, 7, 43));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageKeyForServerUid(mFolder, 7, 42,
                                                                found));
  EXPECT_EQ(second, found);
}

TEST_F(DeliveryCoreProperties, ServerUidMissingMembershipNeverCreatesBindings) {
  ASSERT_EQ(NS_OK, Start());
  uint32_t epoch = 99;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->FolderDB().GetFolderUidValidity(mFolder, epoch));
  EXPECT_EQ(99u, epoch);
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add(key));
  // Establishing the first known epoch must also retire unscoped old UIDs.
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageUidOnServer(key, 42));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 7));
  nsMsgKey found = nsMsgKey_None;
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      mCore->MessageDB().GetMessageKeyForServerUid(mFolder, 7, 42, found));
  EXPECT_EQ(nsMsgKey_None, found);
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      mCore->MessageDB().GetMessageKeyForServerUid(mFolder, 7, key, found));
  EXPECT_EQ(nsMsgKey_None, found);
  nsTArray<nsCString> before, after;
  ASSERT_EQ(NS_OK, Snapshot(before));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->FolderDB().SetFolderUidValidity(UINT64_MAX, 8));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, mCore->MessageDB().BindMessageToServerUid(
                                        nsMsgKey_None, mFolder, 7, 1));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->MessageDB().BindMessageToServerUid(key, mFolder, 8, 1));
  ASSERT_EQ(NS_OK, Snapshot(after));
  EXPECT_EQ(before, after);
  uint64_t root, otherFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertRoot("uid-wrong-folder"_ns, &root));
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(root, "Other"_ns, &otherFolder));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(otherFolder, 7));
  // Exclude the deliberate other-folder epoch write from the error snapshot.
  ASSERT_EQ(NS_OK, Snapshot(before));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->MessageDB().BindMessageToServerUid(key, otherFolder, 7, 1));
  ASSERT_EQ(NS_OK, Snapshot(after));
  EXPECT_EQ(before, after);
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(key));
  ASSERT_EQ(NS_OK, Snapshot(before));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->MessageDB().BindMessageToServerUid(key, mFolder, 7, 1));
  ASSERT_EQ(NS_OK, Snapshot(after));
  EXPECT_EQ(before, after);
}

TEST_F(DeliveryCoreProperties,
       ServerUidEpochFailureRollsBackBindingRetirement) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 7));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add(key));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().BindMessageToServerUid(key, mFolder, 7, 42));
  nsTArray<nsCString> before, after;
  ASSERT_EQ(NS_OK, Snapshot(before));
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER fail_epoch BEFORE INSERT ON "
                       "folder_properties WHEN NEW.name = 'UIDValidity' BEGIN "
                       "SELECT RAISE(ABORT, 'epoch fault'); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            mCore->FolderDB().SetFolderUidValidity(mFolder, 8));
  bool active = true;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_EQ(NS_OK, Snapshot(after));
  EXPECT_EQ(before, after);
  nsMsgKey found = nsMsgKey_None;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageKeyForServerUid(mFolder, 7, 42,
                                                                found));
  EXPECT_EQ(key, found);
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL("DROP TRIGGER fail_epoch"_ns));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 8));
  found = nsMsgKey_None;
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      mCore->MessageDB().GetMessageKeyForServerUid(mFolder, 8, 42, found));
  EXPECT_EQ(nsMsgKey_None, found);
}

TEST_F(DeliveryCoreProperties,
       ServerUidBindingFailurePreservesPreviousBinding) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 7));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add(key));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().BindMessageToServerUid(key, mFolder, 7, 42));
  nsTArray<nsCString> before, after;
  ASSERT_EQ(NS_OK, Snapshot(before));
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER fail_binding BEFORE INSERT ON "
                       "message_properties WHEN NEW.name = 'uidOnServer' BEGIN "
                       "SELECT RAISE(ABORT, 'binding fault'); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            mCore->MessageDB().BindMessageToServerUid(key, mFolder, 7, 1));
  ASSERT_EQ(NS_OK, Snapshot(after));
  EXPECT_EQ(before, after);
  ASSERT_NO_FATAL_FAILURE(
      CheckStored("message_properties"_ns, key, "uidOnServer"_ns, "2a"_ns));
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL("DROP TRIGGER fail_binding"_ns));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().BindMessageToServerUid(key, mFolder, 7, 1));
}

TEST_F(DeliveryCoreProperties, ServerUidReadErrorsPreserveScalarOutputs) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 7));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add(key));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().BindMessageToServerUid(key, mFolder, 7, 42));
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL(
                "ALTER TABLE message_properties RENAME TO saved_uid_properties;"
                "CREATE VIEW message_properties AS SELECT "
                "abs(-9223372036854775808) AS id, name, value "
                "FROM saved_uid_properties"_ns));
  nsMsgKey found = nsMsgKey_None;
  EXPECT_EQ(NS_ERROR_FAILURE, mCore->MessageDB().GetMessageKeyForServerUid(
                                  mFolder, 7, 42, found));
  EXPECT_EQ(nsMsgKey_None, found);
  ASSERT_EQ(
      NS_OK,
      Connection()->ExecuteSimpleSQL(
          "DROP VIEW message_properties;"
          "ALTER TABLE saved_uid_properties RENAME TO message_properties"_ns));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageKeyForServerUid(mFolder, 7, 42,
                                                                found));
  EXPECT_EQ(key, found);
  ASSERT_EQ(NS_OK, SetFolder("UIDValidity"_ns, "invalid"_ns));
  uint32_t epoch = 99;
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            mCore->FolderDB().GetFolderUidValidity(mFolder, epoch));
  EXPECT_EQ(99u, epoch);
}

TEST_F(DeliveryCoreProperties, ServerUidEpochReadErrorsPreserveOutput) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 7));
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL(
                "ALTER TABLE folder_properties RENAME TO saved_uid_epochs;"
                "CREATE VIEW folder_properties AS SELECT "
                "abs(-9223372036854775808) AS id, name, value "
                "FROM saved_uid_epochs"_ns));
  uint32_t epoch = 99;
  EXPECT_EQ(NS_ERROR_FAILURE,
            mCore->FolderDB().GetFolderUidValidity(mFolder, epoch));
  EXPECT_EQ(99u, epoch);
  nsMsgKey found = nsMsgKey_None;
  EXPECT_EQ(NS_ERROR_FAILURE, mCore->MessageDB().GetMessageKeyForServerUid(
                                  mFolder, 7, 42, found));
  EXPECT_EQ(nsMsgKey_None, found);
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL(
                "DROP VIEW folder_properties;"
                "ALTER TABLE saved_uid_epochs RENAME TO folder_properties"_ns));
  ASSERT_EQ(NS_OK, mCore->FolderDB().GetFolderUidValidity(mFolder, epoch));
  EXPECT_EQ(7u, epoch);
}

TEST_F(DeliveryCoreProperties, ServerUidWritesDoNotCommitAnotherTransaction) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 7));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add(key));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  ASSERT_EQ(NS_OK, SetFolder("uncommitted"_ns, "pending"_ns));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            mCore->FolderDB().SetFolderUidValidity(mFolder, 8));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            mCore->MessageDB().BindMessageToServerUid(key, mFolder, 7, 42));
  bool active = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  nsCString text;
  ASSERT_EQ(NS_OK, GetFolder("uncommitted"_ns, text));
  EXPECT_TRUE(text.IsEmpty());
}


TEST_F(DeliveryCoreProperties, AllocatorNeverReusesCommittedDeletedKeys) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey first, removed, next;
  ASSERT_EQ(NS_OK, Add(first));
  ASSERT_EQ(NS_OK, Add(removed));
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(removed));
  ASSERT_TRUE(Stop());
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, Add(next));
  EXPECT_GT(next, removed);
  EXPECT_NE(first, next);
  bool exists = true;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(removed, exists));
  EXPECT_FALSE(exists);
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(first, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreProperties, AllocatorRollsBackWithFailedInsertion) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add(control));
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL(
                "CREATE TEMP TRIGGER fail_allocated_add AFTER INSERT "
                "ON messages BEGIN SELECT RAISE(ABORT, 'add fault'); END"_ns));
  nsMsgKey failed = nsMsgKey_None;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, Add(failed));
  EXPECT_EQ(nsMsgKey_None, failed);
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "DROP TRIGGER fail_allocated_add"_ns));
  nsMsgKey retry;
  ASSERT_EQ(NS_OK, Add(retry));
  EXPECT_EQ(control + 1, retry);
  uint64_t count;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(2u, count);
}

TEST_F(DeliveryCoreProperties, AllocatorUsesFullKeyRangeAndRejectsExhaustion) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL(
                "UPDATE message_key_allocator SET highWater = 4294967293"_ns));
  nsMsgKey last;
  ASSERT_EQ(NS_OK, Add(last));
  EXPECT_EQ(0xfffffffeu, last);
  nsMsgKey thread = 0;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageThreadId(last, thread));
  EXPECT_EQ(last, thread);
  ASSERT_TRUE(Stop());
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey output = 77;
  EXPECT_EQ(NS_ERROR_ILLEGAL_VALUE, Add(output));
  EXPECT_EQ(77u, output);
  bool exists = false;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(last, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreProperties, AllocatorUpgradeSeedsHighestExistingKey) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey first, highest;
  ASSERT_EQ(NS_OK, Add(first));
  ASSERT_EQ(NS_OK, Add(highest));
  ASSERT_EQ(NS_OK, MakeVersionTwo());
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey next;
  ASSERT_EQ(NS_OK, Add(next));
  EXPECT_GT(next, highest);
  bool exists = false;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(first, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreProperties, AllocatorUpgradeFailurePreservesVersionAndRows) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add(key));
  ASSERT_EQ(NS_OK, MakeVersionTwo());
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK,
            old->ExecuteSimpleSQL(
                "CREATE TABLE message_key_allocator(unrelated TEXT)"_ns));
  ASSERT_EQ(NS_OK, old->Close());
  EXPECT_EQ(NS_ERROR_FAILURE, Start());
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  int32_t version;
  ASSERT_EQ(NS_OK, old->GetSchemaVersion(&version));
  EXPECT_EQ(2, version);
  ASSERT_EQ(NS_OK,
            old->ExecuteSimpleSQL("DROP TABLE message_key_allocator"_ns));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
  bool exists = false;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_TRUE(exists);
}


TEST_F(DeliveryCoreProperties, AllocatorRejectsChangingPhysicalKey) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add(key));
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                       "UPDATE messages SET id = :other WHERE id = :id"_ns,
                       getter_AddRefs(stmt)));
  auto finalize = MakeScopeExit([&] { EXPECT_EQ(NS_OK, stmt->Finalize()); });
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, key));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("other"_ns, key + 1));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, stmt->Execute());
  bool exists = false;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key + 1, exists));
  EXPECT_FALSE(exists);
}

TEST_F(DeliveryCoreProperties, AllocatorKeepsUnsignedThreadReferences) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL(
                "UPDATE message_key_allocator SET highWater = 2147483647"_ns));
  nsMsgKey parent, child;
  ASSERT_EQ(NS_OK, Add(parent));
  ASSERT_EQ(0x80000000u, parent);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().AddMessage(
                mFolder, "unsigned-child@invalid"_ns, {"properties@invalid"_ns},
                123456, "sender"_ns, "recipient"_ns, EmptyCString(),
                EmptyCString(), "child"_ns, 0, EmptyCString(), 0, &child));
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
                       "SELECT COUNT(*) FROM messages c JOIN messages p "
                       "ON p.id = c.threadId AND p.id = c.threadParent "
                       "WHERE c.id = :id AND p.id = :parent"_ns,
                       getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, child));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("parent"_ns, parent));
  bool more;
  ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
  ASSERT_TRUE(more);
  int64_t matches;
  ASSERT_EQ(NS_OK, stmt->GetInt64(0, &matches));
  EXPECT_EQ(1, matches);
}

TEST_F(DeliveryCoreProperties,
       SourceIdSurvivesReopenAndDistinguishesReplacement) {
  ASSERT_EQ(NS_OK, Start());
  nsCString original;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(original));
  ASSERT_FALSE(original.IsEmpty());
  nsMsgKey oldKey;
  ASSERT_EQ(NS_OK, Add(oldKey));
  ASSERT_TRUE(Stop());
  ASSERT_EQ(NS_OK, Start());
  nsCString reopened;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(reopened));
  EXPECT_EQ(original, reopened);
  ASSERT_TRUE(Stop());

  nsCOMPtr<nsIFile> retained;
  ASSERT_EQ(NS_OK, mFile->Clone(getter_AddRefs(retained)));
  ASSERT_EQ(NS_OK, retained->MoveTo(nullptr, u"panorama-original.sqlite"_ns));
  mFolder = 0;
  ASSERT_EQ(NS_OK, Start());
  nsCString replacement;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(replacement));
  EXPECT_NE(original, replacement);
  nsMsgKey newKey;
  ASSERT_EQ(NS_OK, Add(newKey));
  EXPECT_EQ(oldKey, newKey);
  ASSERT_TRUE(Stop());
  ASSERT_EQ(NS_OK, Start());
  nsCString replacementReopened;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(replacementReopened));
  EXPECT_EQ(replacement, replacementReopened);
}

TEST_F(DeliveryCoreProperties, SourceIdReadFailurePreservesOutput) {
  ASSERT_EQ(NS_OK, Start());
  nsCString expected;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(expected));
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL(
                "CREATE TEMP VIEW database_identity AS SELECT singleton, "
                "sourceId FROM main.database_identity "
                "WHERE abs(-9223372036854775808)"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.database_identity"_ns));
  });
  nsCString actual = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_FAILURE, mCore->GetSourceId(actual));
  EXPECT_EQ("unchanged"_ns, actual);
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "DROP VIEW temp.database_identity"_ns));
  ASSERT_EQ(NS_OK, mCore->GetSourceId(actual));
  EXPECT_EQ(expected, actual);
}

TEST_F(DeliveryCoreProperties, SourceIdRejectsPendingAndRetiredConnections) {
  ASSERT_EQ(NS_OK, Start());
  nsCString expected;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(expected));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  nsCString actual = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, mCore->GetSourceId(actual));
  EXPECT_EQ("unchanged"_ns, actual);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  RefPtr<DatabaseCore> retired = mCore;
  ASSERT_TRUE(Stop());
  ASSERT_EQ(NS_OK, Start());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, retired->GetSourceId(actual));
  EXPECT_EQ("unchanged"_ns, actual);
  ASSERT_EQ(NS_OK, mCore->GetSourceId(actual));
  EXPECT_EQ(expected, actual);
}

TEST_F(DeliveryCoreProperties, VirtualScopeReplacementPersistsAndClears) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t first, second, control;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolder, "First"_ns, &first));
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolder, "Second"_ns, &second));
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolder, "Control"_ns, &control));
  ASSERT_EQ(NS_OK, SetScope(mFolder, {first}));
  ASSERT_EQ(NS_OK, SetScope(control, {second}));
  ASSERT_EQ(NS_OK, SetScope(mFolder, {second, first}));
  ASSERT_NO_FATAL_FAILURE(CheckScope(mFolder, {first, second}));
  ASSERT_NO_FATAL_FAILURE(CheckScope(control, {second}));
  ASSERT_TRUE(Stop());
  ASSERT_EQ(NS_OK, Start());
  ASSERT_NO_FATAL_FAILURE(CheckScope(mFolder, {first, second}));
  ASSERT_EQ(NS_OK, SetScope(mFolder, {}));
  ASSERT_NO_FATAL_FAILURE(CheckScope(mFolder, {}));
  ASSERT_NO_FATAL_FAILURE(CheckScope(control, {second}));
}

TEST_F(DeliveryCoreProperties, VirtualScopeInsertFailureKeepsPreviousScope) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t first, second, rejected, control;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolder, "First"_ns, &first));
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolder, "Second"_ns, &second));
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolder, "Rejected"_ns, &rejected));
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolder, "Control"_ns, &control));
  ASSERT_EQ(NS_OK, SetScope(mFolder, {first}));
  ASSERT_EQ(NS_OK, SetScope(control, {second}));
  nsAutoCString sql(
      "CREATE TEMP TRIGGER fail_scope_insert BEFORE INSERT ON "
      "virtualFolder_folders WHEN NEW.searchFolderId = "_ns);
  sql.AppendInt(rejected);
  sql.AppendLiteral(" BEGIN SELECT RAISE(ABORT, 'scope fault'); END");
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(sql));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS fail_scope_insert"_ns));
  });
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, SetScope(mFolder, {second, rejected}));
  bool active = true;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_NO_FATAL_FAILURE(CheckScope(mFolder, {first}));
  ASSERT_NO_FATAL_FAILURE(CheckScope(control, {second}));
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "DROP TRIGGER fail_scope_insert"_ns));
  ASSERT_EQ(NS_OK, SetScope(mFolder, {second, rejected}));
  ASSERT_NO_FATAL_FAILURE(CheckScope(mFolder, {second, rejected}));
  ASSERT_NO_FATAL_FAILURE(CheckScope(control, {second}));
}

TEST_F(DeliveryCoreProperties, VirtualScopeRejectsUnrelatedTransaction) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t first, second;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolder, "First"_ns, &first));
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolder, "Second"_ns, &second));
  ASSERT_EQ(NS_OK, SetScope(mFolder, {first}));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active;
    if (NS_SUCCEEDED(Connection()->GetTransactionInProgress(&active)) &&
        active) {
      EXPECT_EQ(NS_OK, Connection()->RollbackTransaction());
    }
  });
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, SetScope(mFolder, {second}));
  bool active = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_NO_FATAL_FAILURE(CheckScope(mFolder, {first}));
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  ASSERT_EQ(NS_OK, SetScope(mFolder, {second}));
  ASSERT_NO_FATAL_FAILURE(CheckScope(mFolder, {second}));
}

TEST_F(DeliveryCoreProperties, BodyStatePreservesTokenPresenceAndRevisions) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add(key));
  MessageBodyState initial;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, initial));
  EXPECT_EQ(key, initial.key);
  EXPECT_EQ(mFolder, initial.folderId);
  EXPECT_FALSE(initial.storeToken);
  EXPECT_GT(initial.contentRevision, 0u);
  EXPECT_GT(initial.locationRevision, 0u);
  ASSERT_EQ(NS_OK, db.SetMessageStoreToken(key, ""_ns));
  MessageBodyState empty;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, empty));
  ASSERT_TRUE(empty.storeToken);
  EXPECT_TRUE(empty.storeToken->IsEmpty());
  EXPECT_GT(empty.contentRevision, initial.contentRevision);
  EXPECT_GT(empty.locationRevision, initial.locationRevision);
  ASSERT_EQ(NS_OK, db.SetMessageStoreToken(key, "00042"_ns));
  MessageBodyState stored;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, stored));
  ASSERT_TRUE(stored.storeToken);
  EXPECT_EQ("00042"_ns, *stored.storeToken);
  ASSERT_EQ(NS_OK, db.SetMessageProperty(key, "unrelated"_ns, "1e3"_ns));
  ASSERT_EQ(NS_OK, db.SetMessageFlags(key, 1));
  MessageBodyState unrelated;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, unrelated));
  EXPECT_EQ(stored.contentRevision, unrelated.contentRevision);
  EXPECT_EQ(stored.locationRevision, unrelated.locationRevision);
  ASSERT_TRUE(Stop());
  ASSERT_EQ(NS_OK, Start());
  MessageBodyState reopened;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageBodyState(key, reopened));
  EXPECT_EQ(key, reopened.key);
  EXPECT_EQ(mFolder, reopened.folderId);
  EXPECT_EQ(stored.storeToken, reopened.storeToken);
  EXPECT_EQ(stored.contentRevision, reopened.contentRevision);
  EXPECT_EQ(stored.locationRevision, reopened.locationRevision);
}

TEST_F(DeliveryCoreProperties, MissingBodyStateDoesNotUseCachedMembership) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey removed, control;
  ASSERT_EQ(NS_OK, Add(removed));
  ASSERT_EQ(NS_OK, Add(control));
  ASSERT_EQ(NS_OK, db.SetMessageStoreToken(removed, "old-body"_ns));
  MessageBodyState output;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(removed, output));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetMessageBodyState(removed + 100, output));
  EXPECT_EQ(removed, output.key);
  EXPECT_EQ(Some(nsCString("old-body"_ns)), output.storeToken);
  ASSERT_EQ(NS_OK, db.RemoveMessage(removed));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.GetMessageBodyState(removed, output));
  EXPECT_EQ(removed, output.key);
  EXPECT_EQ(Some(nsCString("old-body"_ns)), output.storeToken);
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(control, output));
  EXPECT_EQ(control, output.key);
}

TEST_F(DeliveryCoreProperties, BodyStateSqlFailurePreservesOutput) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add(key));
  MessageBodyState output;
  output.key = 77;
  output.folderId = 88;
  output.storeToken = Some(nsCString("unchanged"_ns));
  output.contentRevision = 99;
  output.locationRevision = 100;
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP VIEW message_changes AS SELECT "
                       "abs(-9223372036854775808) AS sequence, messageId, "
                       "contentRevision, locationRevision, deleted "
                       "FROM main.message_changes"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.message_changes"_ns));
  });
  EXPECT_EQ(NS_ERROR_FAILURE,
            mCore->MessageDB().GetMessageBodyState(key, output));
  EXPECT_EQ(77u, output.key);
  EXPECT_EQ(88u, output.folderId);
  EXPECT_EQ(Some(nsCString("unchanged"_ns)), output.storeToken);
  EXPECT_EQ(99u, output.contentRevision);
  EXPECT_EQ(100u, output.locationRevision);
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "DROP VIEW temp.message_changes"_ns));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageBodyState(key, output));
  EXPECT_EQ(key, output.key);
}

TEST_F(DeliveryCoreProperties, BodyStateRejectsUncommittedLocation) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add(key));
  ASSERT_EQ(NS_OK, db.SetMessageStoreToken(key, "committed"_ns));
  MessageBodyState before;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, before));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active;
    if (NS_SUCCEEDED(Connection()->GetTransactionInProgress(&active)) &&
        active) {
      EXPECT_EQ(NS_OK, Connection()->RollbackTransaction());
    }
  });
  ASSERT_EQ(NS_OK, db.SetMessageStoreToken(key, "pending"_ns));
  MessageBodyState output;
  output.key = 77;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.GetMessageBodyState(key, output));
  EXPECT_EQ(77u, output.key);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, output));
  EXPECT_EQ(before.storeToken, output.storeToken);
  EXPECT_EQ(before.contentRevision, output.contentRevision);
  EXPECT_EQ(before.locationRevision, output.locationRevision);
}

}  // namespace
}  // namespace mozilla::mailnews
