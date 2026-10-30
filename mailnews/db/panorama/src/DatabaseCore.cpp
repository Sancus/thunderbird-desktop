/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "DatabaseCore.h"

#ifdef XP_WIN
#  include "MigrationFileSystem.h"
#endif

#include <algorithm>
#include <cmath>
#include <cstring>
#include <utility>

#include "DatabaseUtils.h"
#include "js/Array.h"
#include "js/ForOfIterator.h"
#include "js/JSON.h"
#include "js/MapAndSet.h"
#include "js/experimental/TypedData.h"
#include "mozilla/dom/ChromeUtils.h"
#include "mozilla/dom/ChromeUtilsBinding.h"
#include "js/CharacterEncoding.h"
#include "js/PropertyAndElement.h"
#include "js/String.h"
#include "jsapi.h"
#include "nsJSUtils.h"
#include "nsIMsgPluggableStore.h"
#include "FolderDatabase.h"
#include "Message.h"
#include "MessageDatabase.h"
#include "mozilla/Base64.h"
#include "mozilla/Components.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/Logging.h"
#include "mozilla/ProfilerMarkers.h"
#include "mozilla/Services.h"
#include "mozilla/UniquePtr.h"
#include "mozilla/fallible.h"
#include "mozilla/ScopeExit.h"
#include "mozIStorageBindingParams.h"
#include "mozIStorageBindingParamsArray.h"
#include "mozIStorageConnection.h"
#include "mozIStorageError.h"
#include "mozIStoragePendingStatement.h"
#include "mozIStorageResultSet.h"
#include "mozIStorageRow.h"
#include "mozIStorageService.h"
#include "mozIStorageStatement.h"
#include "mozIStorageStatementCallback.h"
#include "mozStorageHelper.h"
#include "msgCore.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsIClassInfoImpl.h"
#include "nsICryptoHash.h"
#include "nsID.h"
#include "nsIFile.h"
#include "nsIInputStream.h"
#include "nsILineInputStream.h"
#include "nsIMimeConverter.h"
#include "nsIObserverService.h"
#include "nsIUUIDGenerator.h"
#include "nsMsgFolderFlags.h"
#include "nsMsgMessageFlags.h"
#include "nsMsgUtils.h"
#include "nsReadableUtils.h"
#include "nsNetUtil.h"
#include "nsThreadUtils.h"
#include "PerFolderDatabase.h"
#include "xpcpublic.h"

using mozilla::LazyLogModule;
using mozilla::LogLevel;
using mozilla::dom::Promise;

namespace mozilla::mailnews {

LazyLogModule gPanoramaLog("panorama");

NS_IMPL_CLASSINFO(DatabaseCore, nullptr, nsIClassInfo::SINGLETON,
                  DATABASE_CORE_CID)
NS_IMPL_ISUPPORTS_CI(DatabaseCore, nsIDatabaseCore, nsIMsgDBService,
                     nsIObserver)

StaticRefPtr<DatabaseCore> DatabaseCore::sInstance;
bool DatabaseCore::sDatabaseIsNew = false;
MOZ_GLOBINIT nsCOMPtr<mozIStorageConnection> DatabaseCore::sConnection;
MOZ_GLOBINIT nsTHashMap<nsCString, nsCOMPtr<mozIStorageStatement>>
    DatabaseCore::sStatements;

/* static */
already_AddRefed<DatabaseCore> DatabaseCore::GetInstanceForService() {
  if (!sInstance) {
    sInstance = new DatabaseCore();
  }
  return do_AddRef(sInstance);
}

DatabaseCore::DatabaseCore() {
  MOZ_ASSERT(!sConnection, "creating a second DatabaseCore");

  // Bump up the refcount so it doesn't get freed too early. This is needed
  // because of the unusual dynamic component registration done in
  // `nsMsgAccountManager::Init`.
  NS_ADDREF_THIS();
}

NS_IMETHODIMP
DatabaseCore::Startup() {
  NS_ENSURE_FALSE(mShuttingDown, NS_ERROR_NOT_AVAILABLE);
  if (sConnection) {
    MOZ_LOG(gPanoramaLog, LogLevel::Error, ("DatabaseCore is already started"));
    return NS_ERROR_FAILURE;
  }

  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("DatabaseCore starting up"));

  nsresult rv = EnsureConnection();
  NS_ENSURE_SUCCESS(rv, rv);

  mFolderDatabase = new FolderDatabase();

  mMessageDatabase = new MessageDatabase();
  mMessageDatabase->Startup();

  nsCOMPtr<nsIObserverService> obs = mozilla::services::GetObserverService();
  obs->AddObserver(this, "profile-before-change", false);

  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("DatabaseCore startup complete"));
  return NS_OK;
}

NS_IMETHODIMP
DatabaseCore::Observe(nsISupports* aSubject, const char* aTopic,
                      const char16_t* aData) {
  if (strcmp(aTopic, "profile-before-change")) {
    return NS_OK;
  }

  if (mShuttingDown) {
    return NS_OK;
  }
  mShuttingDown = true;
  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("DatabaseCore shutting down"));

  nsTArray<RefPtr<nsIMsgDatabase>> databases;
  MOZ_ALWAYS_SUCCEEDS(GetOpenDBs(databases));
  mOpenDatabases.Clear();
  mOpenDatabasesByFile.Clear();
  for (const auto& database : databases) {
    if (NS_FAILED(database->ForceClosed())) {
      NS_WARNING("Failed to close folder database");
    }
  }

  for (auto iter = sStatements.Iter(); !iter.Done(); iter.Next()) {
    iter.UserData()->Finalize();
  }
  sStatements.Clear();

  mFolderRelocationRecoveries.Clear();
  mFolderDatabase = nullptr;

  if (mMessageDatabase) {
    mMessageDatabase->Shutdown();
    mMessageDatabase = nullptr;
  }

  if (sConnection) {
    sConnection->AsyncClose(nullptr);
    sConnection = nullptr;
  }

  nsCOMPtr<nsIObserverService> obs = mozilla::services::GetObserverService();
  obs->RemoveObserver(this, "profile-before-change");

  sInstance = nullptr;

  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("DatabaseCore shutdown complete"));

  return NS_OK;
}

/**
 * Ensures a mozIStorageConnection to panorama.sqlite in the profile folder.
 */
nsresult DatabaseCore::EnsureConnection() {
  if (sConnection) {
    return NS_OK;
  }

  MOZ_ASSERT(NS_IsMainThread(),
             "connection must be established on the main thread");

  nsCOMPtr<nsIFile> databaseFile;
  nsresult rv = NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR,
                                       getter_AddRefs(databaseFile));
  NS_ENSURE_SUCCESS(rv, rv);

  rv = databaseFile->Append(u"panorama.sqlite"_ns);
  NS_ENSURE_SUCCESS(rv, rv);

  bool exists;
  rv = databaseFile->Exists(&exists);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<mozIStorageService> storage =
      do_GetService("@mozilla.org/storage/service;1");
  NS_ENSURE_STATE(storage);

  bool schemaCommitted = false;
  bool cleanupSucceeded = true;
  auto connectionGuard = MakeScopeExit([&] {
    if (sConnection) {
      nsresult closeRv = sConnection->Close();
      NS_WARNING_ASSERTION(NS_SUCCEEDED(closeRv),
                           "Failed to close an uninitialized database");
      sConnection = nullptr;
      if (!exists && !schemaCommitted && cleanupSucceeded &&
          NS_SUCCEEDED(closeRv)) {
        if (NS_FAILED(databaseFile->Remove(false))) {
          NS_WARNING("Failed to remove a newly created, rolled-back database");
        }
      }
    }
  });
  rv = storage->OpenUnsharedDatabase(databaseFile,
                                     mozIStorageService::CONNECTION_DEFAULT,
                                     getter_AddRefs(sConnection));
  NS_ENSURE_SUCCESS(rv, rv);
  if (!exists) {
    MOZ_TRY(sConnection->ExecuteSimpleSQL("PRAGMA journal_mode=WAL;"_ns));
  }
  MOZ_TRY(sConnection->BeginTransaction());
  auto transactionGuard = MakeScopeExit([&] {
    bool active = false;
    nsresult cleanupRv = sConnection->GetTransactionInProgress(&active);
    if (NS_SUCCEEDED(cleanupRv) && active) {
      cleanupRv = sConnection->RollbackTransaction();
    }
    cleanupSucceeded = NS_SUCCEEDED(cleanupRv);
    NS_WARNING_ASSERTION(cleanupSucceeded,
                         "Database initialization rollback failed");
  });
  if (!exists) {
    MOZ_TRY(CreateNewDatabase());
  }
  MOZ_TRY(UpgradeSchema());
  MOZ_TRY(sConnection->CommitTransaction());
  transactionGuard.release();
  schemaCommitted = true;
  sDatabaseIsNew = !exists;

  rv = sConnection->ExecuteSimpleSQL("PRAGMA cache_size=-200000;"_ns);
  NS_ENSURE_SUCCESS(rv, rv);
  RefPtr<TagsMatchFunction> tagsInclude = new TagsMatchFunction(true);
  MOZ_TRY(sConnection->CreateFunction("tags_include"_ns, 2, tagsInclude));
  RefPtr<TagsMatchFunction> tagsExclude = new TagsMatchFunction(false);
  MOZ_TRY(sConnection->CreateFunction("tags_exclude"_ns, 2, tagsExclude));
  RefPtr<AddressFormatFunction> addressFormat = new AddressFormatFunction();
  MOZ_TRY(sConnection->CreateFunction("address_format"_ns, 1, addressFormat));
  RefPtr<GroupedByDateFunction> dateGroup = new GroupedByDateFunction();
  MOZ_TRY(sConnection->CreateFunction("date_group"_ns, 1, dateGroup));

  connectionGuard.release();
  return NS_OK;
}

namespace {

constexpr auto kFolderIdGuard =
    "CREATE TRIGGER guard_folder_id BEFORE INSERT ON folders "
    "WHEN NEW.id <= 0 OR NOT EXISTS(SELECT 1 FROM folder_id_allocator "
    "WHERE singleton=1) OR NEW.id <= (SELECT highWater FROM "
    "folder_id_allocator "
    "WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'invalid folder id'); END"_ns;
constexpr auto kFolderIdRecord =
    "CREATE TRIGGER record_folder_id AFTER INSERT ON folders BEGIN "
    "UPDATE folder_id_allocator SET highWater=NEW.id WHERE singleton=1; END"_ns;
constexpr auto kFolderIdImmutable =
    "CREATE TRIGGER immutable_folder_id BEFORE UPDATE OF id ON folders "
    "WHEN NEW.id IS NOT OLD.id "
    "BEGIN SELECT RAISE(ABORT,'immutable folder id'); END"_ns;

constexpr auto kReferenceDeleteTrigger =
    "CREATE TRIGGER delete_message_references AFTER DELETE ON messages BEGIN "
    "DELETE FROM message_references WHERE id = OLD.id; "
    "DELETE FROM message_reference_sets WHERE id = OLD.id; END"_ns;

constexpr auto kMessageKeyGuard =
    "CREATE TRIGGER guard_message_key BEFORE INSERT ON messages "
    "WHEN NEW.id <= 0 OR NEW.id >= 4294967295 OR "
    "NOT EXISTS(SELECT 1 FROM message_key_allocator WHERE singleton = 1) OR "
    "NEW.id <= (SELECT highWater FROM message_key_allocator WHERE singleton = "
    "1) "
    "BEGIN SELECT RAISE(ABORT, 'invalid message key'); END"_ns;
constexpr auto kMessageKeyRecord =
    "CREATE TRIGGER record_message_key AFTER INSERT ON messages BEGIN "
    "UPDATE message_key_allocator SET highWater = NEW.id WHERE singleton = 1; END"_ns;

constexpr auto kMessageKeyImmutable =
    "CREATE TRIGGER immutable_message_key BEFORE UPDATE OF id ON messages "
    "WHEN NEW.id IS NOT OLD.id BEGIN SELECT RAISE(ABORT, 'immutable message key'); END"_ns;

constexpr auto kStagedMessageKeyGuard =
    "CREATE TRIGGER guard_message_key BEFORE INSERT ON messages "
    "WHEN NEW.id <= 0 OR NEW.id >= 4294967295 OR "
    "NOT EXISTS(SELECT 1 FROM message_key_allocator WHERE singleton = 1) OR "
    "(NEW.id <= (SELECT highWater FROM message_key_allocator WHERE singleton = "
    "1) "
    "AND NOT EXISTS(SELECT 1 FROM staged_messages WHERE id = NEW.id "
    "AND folderId = NEW.folderId)) "
    "BEGIN SELECT RAISE(ABORT, 'invalid message key'); END"_ns;
constexpr auto kStagedMessageKeyRecord =
    "CREATE TRIGGER record_message_key AFTER INSERT ON messages BEGIN "
    "UPDATE message_key_allocator SET highWater = MAX(highWater, NEW.id) "
    "WHERE singleton = 1; END"_ns;
constexpr auto kStagedDelete =
    "CREATE TRIGGER delete_staged_header AFTER DELETE ON staged_messages BEGIN "
    "DELETE FROM staged_message_properties WHERE id = OLD.id; "
    "DELETE FROM staged_message_references WHERE id = OLD.id; "
    "DELETE FROM staged_message_reference_sets WHERE id = OLD.id; END"_ns;

nsCString SearchChangeSQL(const nsACString& id, const nsACString& contentDelta,
                          const nsACString& locationDelta, bool deleted) {
  nsCString sql(
      "INSERT INTO message_changes(messageId, contentRevision, "
      "locationRevision, deleted) VALUES ("_ns);
  sql.Append(id);
  for (const auto& field : {"contentRevision", "locationRevision"}) {
    sql.AppendLiteral(", COALESCE((SELECT ");
    sql.Append(field);
    sql.AppendLiteral(" FROM message_changes WHERE messageId = ");
    sql.Append(id);
    sql.AppendLiteral(" ORDER BY sequence DESC LIMIT 1), 0) + (");
    sql.Append(strcmp(field, "contentRevision") == 0 ? contentDelta
                                                     : locationDelta);
    sql.Append(')');
  }
  sql.Append(deleted ? ", 1);" : ", 0);");
  return sql;
}

enum class SearchTriggerAction { CreateAll, CheckAll, ReplacePolicy };

nsresult SearchChangeTriggers(mozIStorageConnection* connection,
                              SearchTriggerAction action, bool legacyPolicy) {
  struct Trigger {
    nsCString name;
    nsCString sql;
  };
  nsTArray<Trigger> triggers;
  auto add = [&](const char* name, const char* event, const char* table,
                 const nsACString& condition, const nsACString& write) {
    Trigger trigger;
    trigger.name.Assign(name);
    trigger.sql.AssignLiteral("CREATE TRIGGER ");
    trigger.sql.Append(name);
    trigger.sql.AppendLiteral(" AFTER ");
    trigger.sql.Append(event);
    trigger.sql.AppendLiteral(" ON ");
    trigger.sql.Append(table);
    if (!condition.IsEmpty()) {
      trigger.sql.AppendLiteral(" WHEN ");
      trigger.sql.Append(condition);
    }
    trigger.sql.AppendLiteral(" BEGIN ");
    trigger.sql.Append(write);
    trigger.sql.AppendLiteral(" END");
    triggers.AppendElement(std::move(trigger));
  };
  add("search_message_insert", "INSERT", "messages", EmptyCString(),
      SearchChangeSQL("NEW.id"_ns, "1"_ns, "1"_ns, false));
  add("search_message_update", "UPDATE", "messages", EmptyCString(),
      SearchChangeSQL(
          "NEW.id"_ns,
          "CASE WHEN NEW.subject IS NOT OLD.subject OR NEW.sender IS NOT "
          "OLD.sender "
          "OR NEW.recipients IS NOT OLD.recipients OR NEW.ccList IS NOT "
          "OLD.ccList "
          "OR NEW.bccList IS NOT OLD.bccList THEN 1 ELSE 0 END"_ns,
          "CASE WHEN NEW.folderId IS NOT OLD.folderId THEN 1 ELSE 0 END"_ns,
          false));
  add("search_message_delete", "DELETE", "messages", EmptyCString(),
      SearchChangeSQL("OLD.id"_ns, "0"_ns, "1"_ns, true));
  for (const char* table :
       {"message_properties", "message_references", "message_reference_sets"}) {
    for (const char* event : {"INSERT", "UPDATE", "DELETE"}) {
      nsAutoCString prefix(strcmp(event, "DELETE") == 0 ? "OLD" : "NEW");
      nsAutoCString id(prefix);
      id.AppendLiteral(".id");
      nsAutoCString condition("EXISTS(SELECT 1 FROM messages WHERE id = "_ns);
      condition.Append(id);
      condition.Append(')');
      nsAutoCString content("0"_ns), location("0"_ns);
      if (strcmp(table, "message_properties") == 0) {
        content.AssignLiteral("CASE WHEN ");
        content.Append(prefix);
        content.AppendLiteral(
            ".name IN ('storeToken', 'messageSize', 'offlineMessageSize', "
            "'lineCount', 'msgCharSet') THEN 1 ELSE 0 END");
        location.AssignLiteral("CASE WHEN ");
        location.Append(prefix);
        location.AppendLiteral(
            ".name IN ('storeToken', 'uidOnServer') THEN 1 ELSE 0 END");
      }
      nsAutoCString name("search_"_ns);
      name.Append(table);
      name.Append('_');
      name.Append(event);
      add(name.get(), event, table, condition,
          SearchChangeSQL(id, content, location, false));
    }
  }
  const nsCString policy = SearchChangeSQL("NULL"_ns, "0"_ns, "0"_ns, false);
  add("search_folder_policy", "UPDATE OF parent, name, flags", "folders",
      EmptyCString(), policy);
  if (!legacyPolicy) {
    add("search_folder_delete", "DELETE", "folders", EmptyCString(), policy);
  }
  for (const char* event : {"INSERT", "UPDATE", "DELETE"}) {
    nsAutoCString name("search_folder_properties_"_ns);
    name.Append(event);
    nsCString condition;
    if (!legacyPolicy) {
      if (strcmp(event, "UPDATE") == 0) {
        condition.AssignLiteral(
            "(NEW.name = 'indexingPriority' OR OLD.name = 'indexingPriority') "
            "AND (NEW.id IS NOT OLD.id OR NEW.name IS NOT OLD.name "
            "OR NEW.value IS NOT OLD.value)");
      } else {
        condition.Assign(strcmp(event, "DELETE") == 0 ? "OLD" : "NEW");
        condition.AppendLiteral(".name = 'indexingPriority'");
      }
    }
    add(name.get(), event, "folder_properties", condition, policy);
  }
  for (const auto& trigger : triggers) {
    if (action == SearchTriggerAction::ReplacePolicy) {
      if (trigger.name.Find("search_folder_") != 0) {
        continue;
      }
      nsAutoCString drop("DROP TRIGGER IF EXISTS "_ns);
      drop.Append(trigger.name);
      MOZ_TRY(connection->ExecuteSimpleSQL(drop));
    }
    if (action != SearchTriggerAction::CheckAll) {
      MOZ_TRY(connection->ExecuteSimpleSQL(trigger.sql));
    } else {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(connection->CreateStatement(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = :name"_ns,
          getter_AddRefs(stmt)));
      MOZ_TRY(stmt->BindUTF8StringByName("name"_ns, trigger.name));
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
      nsCString sql;
      MOZ_TRY(stmt->GetUTF8String(0, sql));
      NS_ENSURE_TRUE(sql.Equals(trigger.sql), NS_ERROR_FILE_CORRUPTED);
    }
  }
  return NS_OK;
}

nsresult ReadDatabaseSourceId(mozIStorageConnection* connection,
                              nsACString& sourceId) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(connection->CreateStatement(
      "SELECT sourceId FROM database_identity WHERE singleton = 1"_ns,
      getter_AddRefs(stmt)));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
  nsCString value;
  MOZ_TRY(stmt->GetUTF8String(0, value));
  nsID parsed;
  NS_ENSURE_TRUE(value.Length() == NSID_LENGTH - 1 && parsed.Parse(value),
                 NS_ERROR_FILE_CORRUPTED);
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(!more, NS_ERROR_FILE_CORRUPTED);
  sourceId = value;
  return NS_OK;
}

nsresult CheckReferenceSchemaTable(mozIStorageConnection* connection,
                                   const char* table, const char* columns) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(connection->CreateStatement(
      "SELECT group_concat(name || ':' || type || ':' || \"notnull\" || ':' || "
      "pk, ',') "
      "FROM (SELECT * FROM pragma_table_info(:table) ORDER BY cid) "
      "WHERE EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = :table)"_ns,
      getter_AddRefs(stmt)));
  MOZ_TRY(stmt->BindUTF8StringByName("table"_ns, nsDependentCString(table)));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
  nsCString actual;
  MOZ_TRY(stmt->GetUTF8String(0, actual));
  NS_ENSURE_TRUE(actual.Equals(columns), NS_ERROR_FILE_CORRUPTED);
  return NS_OK;
}

}  // namespace

static constexpr auto kThreadFlagsMessageDelete =
    "CREATE TRIGGER thread_flags_message_delete AFTER DELETE ON messages BEGIN "
    "DELETE FROM thread_flags WHERE folderId=OLD.folderId AND "
    "threadId=OLD.threadId "
    "AND NOT EXISTS(SELECT 1 FROM messages WHERE folderId=OLD.folderId AND threadId=OLD.threadId); END"_ns;
static constexpr auto kThreadFlagsFolderDelete =
    "CREATE TRIGGER thread_flags_folder_delete AFTER DELETE ON folders BEGIN "
    "DELETE FROM thread_flags WHERE folderId=OLD.id; END"_ns;

nsresult DatabaseCore::UpgradeSchema() {
  int32_t version;
  MOZ_TRY(sConnection->GetSchemaVersion(&version));
  NS_ENSURE_TRUE(version >= 0 && version <= 15, NS_ERROR_NOT_AVAILABLE);
  // Both the original production schema and the old test fixture have these
  // columns. References discarded by either layout cannot be reconstructed.
  static constexpr struct {
    const char* table;
    const char* columns;
  } layouts[] = {
      {"folders",
       "id:INTEGER:0:1,parent:INTEGER:0:0,ordinal:INTEGER:0:0,name:TEXT:0:0,"
       "flags:INTEGER:0:0"},
      {"messages",
       "id:INTEGER:0:1,folderId:INTEGER:0:0,threadId:INTEGER:0:0,threadParent:"
       "INTEGER:0:0,messageId:TEXT:0:0,date:INTEGER:0:0,sender:TEXT:0:0,"
       "recipients:TEXT:0:0,ccList:TEXT:0:0,bccList:TEXT:0:0,subject:TEXT:0:0,"
       "flags:INTEGER:0:0,tags:TEXT:0:0,priority:INTEGER:0:0"},
      {"virtualFolder_folders",
       "virtualFolderId:INTEGER:0:0,searchFolderId:INTEGER:0:0"},
      {"search_folder_hits", "folder_id:INTEGER:0:1,message_id:INTEGER:0:2"},
  };
  for (const auto& layout : layouts) {
    MOZ_TRY(
        CheckReferenceSchemaTable(sConnection, layout.table, layout.columns));
  }
  const char* propertyColumns =
      version < 2 ? "id:INTEGER:0:1,name:TEXT:0:2,value:ANY:0:0"
                  : "id:INTEGER:0:1,name:TEXT:0:2,value:BLOB:0:0";
  for (const char* table : {"folder_properties", "message_properties"}) {
    MOZ_TRY(CheckReferenceSchemaTable(sConnection, table, propertyColumns));
  }
  if (version < 2) {
    // Do not discard unrecognized indexes or triggers while replacing tables.
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(sConnection->CreateStatement(
        "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN "
        "('folder_properties', 'message_properties') UNION ALL "
        "SELECT 1 FROM pragma_index_list('folder_properties') WHERE origin != "
        "'pk' "
        "UNION ALL SELECT 1 FROM pragma_index_list('message_properties') "
        "WHERE origin != 'pk'"_ns,
        getter_AddRefs(stmt)));
    bool unexpected;
    MOZ_TRY(stmt->ExecuteStep(&unexpected));
    NS_ENSURE_TRUE(!unexpected, NS_ERROR_NOT_AVAILABLE);
  }
  if (version == 0) {
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "CREATE TABLE message_reference_sets(id INTEGER PRIMARY KEY REFERENCES messages(id))"_ns));
    MOZ_TRY(
        sConnection->ExecuteSimpleSQL("CREATE TABLE message_references("
                                      "id INTEGER REFERENCES messages(id), "
                                      "ordinal INTEGER, token TEXT NOT NULL, "
                                      "PRIMARY KEY(id, ordinal))"_ns));
    // Foreign key enforcement is not established by the existing database.
    MOZ_TRY(sConnection->ExecuteSimpleSQL(kReferenceDeleteTrigger));
    MOZ_TRY(sConnection->SetSchemaVersion(1));
  }
  MOZ_TRY(CheckReferenceSchemaTable(sConnection, "message_reference_sets",
                                    "id:INTEGER:0:1"));
  MOZ_TRY(CheckReferenceSchemaTable(
      sConnection, "message_references",
      "id:INTEGER:0:1,ordinal:INTEGER:0:2,token:TEXT:1:0"));
  {
    bool exists;
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(sConnection->CreateStatement(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' "
        "AND name = 'delete_message_references' AND tbl_name = 'messages'"_ns,
        getter_AddRefs(stmt)));
    MOZ_TRY(stmt->ExecuteStep(&exists));
    NS_ENSURE_TRUE(exists, NS_ERROR_FILE_CORRUPTED);
    nsCString triggerSQL;
    MOZ_TRY(stmt->GetUTF8String(0, triggerSQL));
    NS_ENSURE_TRUE(triggerSQL.Equals(kReferenceDeleteTrigger),
                   NS_ERROR_FILE_CORRUPTED);
  }
  if (version < 2) {
    // BLOB affinity preserves text and native integers without coercion.
    // Existing cells are copied unchanged; previously lost text cannot be
    // reconstructed.
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "CREATE TABLE folder_properties_v2(id INTEGER REFERENCES folders(id), "
        "name TEXT, value BLOB, PRIMARY KEY(id, name));"
        "INSERT INTO folder_properties_v2 "
        "SELECT id, name, value FROM folder_properties;"
        "DROP TABLE folder_properties;"
        "ALTER TABLE folder_properties_v2 RENAME TO folder_properties;"
        "CREATE TABLE message_properties_v2(id INTEGER REFERENCES "
        "messages(id), "
        "name TEXT, value BLOB, PRIMARY KEY(id, name));"
        "INSERT INTO message_properties_v2 "
        "SELECT id, name, value FROM message_properties;"
        "DROP TABLE message_properties;"
        "ALTER TABLE message_properties_v2 RENAME TO message_properties;"_ns));
    MOZ_TRY(sConnection->SetSchemaVersion(2));
  }
  if (version < 3) {
    nsCOMPtr<mozIStorageStatement> invalid;
    MOZ_TRY(sConnection->CreateStatement(
        "SELECT 1 FROM messages WHERE id <= 0 OR id >= 4294967295 LIMIT 1"_ns,
        getter_AddRefs(invalid)));
    bool badKey;
    MOZ_TRY(invalid->ExecuteStep(&badKey));
    NS_ENSURE_TRUE(!badKey, NS_ERROR_FILE_CORRUPTED);
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "CREATE TABLE message_key_allocator("
        "singleton INTEGER PRIMARY KEY CHECK(singleton = 1), "
        "highWater INTEGER NOT NULL CHECK(highWater >= 0 AND highWater <= "
        "4294967294));"
        "INSERT INTO message_key_allocator "
        "SELECT 1, COALESCE(MAX(id), 0) FROM messages;"_ns));
    MOZ_TRY(sConnection->ExecuteSimpleSQL(kMessageKeyGuard));
    MOZ_TRY(sConnection->ExecuteSimpleSQL(kMessageKeyRecord));
    MOZ_TRY(sConnection->ExecuteSimpleSQL(kMessageKeyImmutable));
    MOZ_TRY(sConnection->SetSchemaVersion(3));
  }
  MOZ_TRY(
      CheckReferenceSchemaTable(sConnection, "message_key_allocator",
                                "singleton:INTEGER:0:1,highWater:INTEGER:1:0"));
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(sConnection->CreateStatement(
        "SELECT 1 FROM message_key_allocator WHERE singleton = 1 "
        "AND typeof(highWater) = 'integer' AND highWater >= 0 "
        "AND highWater <= 4294967294 "
        "AND highWater >= (SELECT COALESCE(MAX(id), 0) FROM messages)"_ns,
        getter_AddRefs(stmt)));
    bool valid;
    MOZ_TRY(stmt->ExecuteStep(&valid));
    NS_ENSURE_TRUE(valid, NS_ERROR_FILE_CORRUPTED);
  }

  for (const char* name :
       {"guard_message_key", "record_message_key", "immutable_message_key"}) {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(sConnection->CreateStatement(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' "
        "AND name = :name AND tbl_name = 'messages'"_ns,
        getter_AddRefs(stmt)));
    MOZ_TRY(stmt->BindUTF8StringByName("name"_ns, nsDependentCString(name)));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
    nsCString sql;
    MOZ_TRY(stmt->GetUTF8String(0, sql));
    bool matches;
    if (strcmp(name, "guard_message_key") == 0) {
      matches =
          sql.Equals(version >= 5 ? kStagedMessageKeyGuard : kMessageKeyGuard);
    } else if (strcmp(name, "record_message_key") == 0) {
      matches = sql.Equals(version >= 5 ? kStagedMessageKeyRecord
                                        : kMessageKeyRecord);
    } else {
      matches = sql.Equals(kMessageKeyImmutable);
    }
    NS_ENSURE_TRUE(matches, NS_ERROR_FILE_CORRUPTED);
  }

  if (version < 4) {
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "CREATE TABLE message_changes("
        "sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(sequence <= "
        "9007199254740991), "
        "messageId INTEGER, contentRevision INTEGER NOT NULL, "
        "locationRevision INTEGER NOT NULL, deleted INTEGER NOT NULL);"
        "CREATE INDEX message_changes_messageId ON message_changes(messageId, "
        "sequence);"
        "INSERT INTO message_changes(messageId, contentRevision, "
        "locationRevision, deleted) "
        "SELECT id, 1, 1, 0 FROM messages ORDER BY id;"_ns));
    MOZ_TRY(SearchChangeTriggers(sConnection, SearchTriggerAction::CreateAll,
                                 true));
    MOZ_TRY(sConnection->SetSchemaVersion(4));
  }
  MOZ_TRY(CheckReferenceSchemaTable(
      sConnection, "message_changes",
      "sequence:INTEGER:0:1,messageId:INTEGER:0:0,contentRevision:INTEGER:1:0,"
      "locationRevision:INTEGER:1:0,deleted:INTEGER:1:0"));
  MOZ_TRY(SearchChangeTriggers(sConnection, SearchTriggerAction::CheckAll,
                               version < 7));
  if (version < 5) {
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "CREATE TABLE staged_messages("
        "id INTEGER PRIMARY KEY CHECK(id > 0 AND id < 4294967295), "
        "folderId INTEGER REFERENCES folders(id), threadId INTEGER, "
        "threadParent INTEGER, messageId TEXT, date INTEGER, sender TEXT, "
        "recipients TEXT, ccList TEXT, bccList TEXT, subject TEXT, flags "
        "INTEGER, "
        "tags TEXT, priority INTEGER);"
        "CREATE TABLE staged_message_properties("
        "id INTEGER REFERENCES staged_messages(id), name TEXT, value BLOB, "
        "PRIMARY KEY(id, name));"
        "CREATE TABLE staged_message_reference_sets("
        "id INTEGER PRIMARY KEY REFERENCES staged_messages(id));"
        "CREATE TABLE staged_message_references("
        "id INTEGER REFERENCES staged_messages(id), ordinal INTEGER, "
        "token TEXT NOT NULL, PRIMARY KEY(id, ordinal));"
        "DROP TRIGGER guard_message_key; DROP TRIGGER record_message_key;"_ns));
    MOZ_TRY(sConnection->ExecuteSimpleSQL(kStagedMessageKeyGuard));
    MOZ_TRY(sConnection->ExecuteSimpleSQL(kStagedMessageKeyRecord));
    MOZ_TRY(sConnection->ExecuteSimpleSQL(kStagedDelete));
    MOZ_TRY(sConnection->SetSchemaVersion(5));
  }
  MOZ_TRY(CheckReferenceSchemaTable(sConnection, "staged_messages",
                                    layouts[1].columns));
  MOZ_TRY(
      CheckReferenceSchemaTable(sConnection, "staged_message_properties",
                                "id:INTEGER:0:1,name:TEXT:0:2,value:BLOB:0:0"));
  MOZ_TRY(CheckReferenceSchemaTable(
      sConnection, "staged_message_reference_sets", "id:INTEGER:0:1"));
  MOZ_TRY(CheckReferenceSchemaTable(
      sConnection, "staged_message_references",
      "id:INTEGER:0:1,ordinal:INTEGER:0:2,token:TEXT:1:0"));
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(sConnection->CreateStatement(
        "SELECT 1 FROM staged_messages s WHERE "
        "s.id > (SELECT highWater FROM message_key_allocator WHERE singleton = "
        "1) "
        "OR EXISTS(SELECT 1 FROM messages m WHERE m.id = s.id) LIMIT 1"_ns,
        getter_AddRefs(stmt)));
    bool invalid;
    MOZ_TRY(stmt->ExecuteStep(&invalid));
    NS_ENSURE_TRUE(!invalid, NS_ERROR_FILE_CORRUPTED);
  }
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(sConnection->CreateStatement(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' "
        "AND name = 'delete_staged_header'"_ns,
        getter_AddRefs(stmt)));
    bool exists;
    MOZ_TRY(stmt->ExecuteStep(&exists));
    NS_ENSURE_TRUE(exists, NS_ERROR_FILE_CORRUPTED);
    nsCString sql;
    MOZ_TRY(stmt->GetUTF8String(0, sql));
    NS_ENSURE_TRUE(sql.Equals(kStagedDelete), NS_ERROR_FILE_CORRUPTED);
  }
  if (version < 6) {
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "CREATE TABLE offline_operations("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, folderId INTEGER NOT NULL, "
        "messageKey INTEGER NOT NULL, revision INTEGER NOT NULL, "
        "epoch INTEGER, uid INTEGER, operation INTEGER NOT NULL, "
        "flagOperation INTEGER NOT NULL, newFlags INTEGER NOT NULL, "
        "sourceKey INTEGER NOT NULL, sourceUid INTEGER NOT NULL, "
        "messageSize INTEGER NOT NULL, playingBack INTEGER NOT NULL, "
        "sourceFolderURI TEXT NOT NULL, destinationFolderURI TEXT NOT NULL, "
        "keywordsToAdd TEXT NOT NULL, keywordsToRemove TEXT NOT NULL, "
        "folderEpoch INTEGER, UNIQUE(folderId, messageKey));"
        "CREATE TABLE offline_copy_destinations("
        "operationId INTEGER NOT NULL, ordinal INTEGER NOT NULL, uri TEXT NOT "
        "NULL, "
        "PRIMARY KEY(operationId, ordinal));"
        "CREATE TABLE offline_attempts("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, operationId INTEGER NOT NULL, "
        "revision INTEGER NOT NULL, state INTEGER NOT NULL CHECK(state IN "
        "(0,1,2,3)), "
        "sourceFolderId INTEGER, sourceKey INTEGER, sourceEpoch INTEGER, "
        "sourceUid INTEGER, "
        "destinationFolderId INTEGER, destinationKey INTEGER, destinationEpoch "
        "INTEGER, "
        "confirmedUid INTEGER, operationFolderId INTEGER NOT NULL, "
        "operationEpoch INTEGER, operation INTEGER NOT NULL);"
        "CREATE INDEX offline_attempts_operation ON "
        "offline_attempts(operationId, id);"
        "CREATE TRIGGER delete_offline_copies AFTER DELETE ON "
        "offline_operations "
        "BEGIN DELETE FROM offline_copy_destinations WHERE operationId = OLD.id; END;"_ns));
    MOZ_TRY(sConnection->SetSchemaVersion(6));
  }
  if (version < 11) {
    MOZ_TRY(CheckReferenceSchemaTable(
        sConnection, "offline_operations",
        "id:INTEGER:0:1,folderId:INTEGER:1:0,messageKey:INTEGER:1:0,revision:"
        "INTEGER:1:0,"
        "epoch:INTEGER:0:0,uid:INTEGER:0:0,operation:INTEGER:1:0,flagOperation:"
        "INTEGER:1:0,"
        "newFlags:INTEGER:1:0,sourceKey:INTEGER:1:0,sourceUid:INTEGER:1:0,"
        "messageSize:INTEGER:1:0,playingBack:INTEGER:1:0,sourceFolderURI:TEXT:"
        "1:"
        "0,"
        "destinationFolderURI:TEXT:1:0,keywordsToAdd:TEXT:1:0,keywordsToRemove:"
        "TEXT:1:0,folderEpoch:INTEGER:0:0"));
    MOZ_TRY(CheckReferenceSchemaTable(
        sConnection, "offline_copy_destinations",
        "operationId:INTEGER:1:1,ordinal:INTEGER:1:2,uri:TEXT:1:0"));
  }
  MOZ_TRY(CheckReferenceSchemaTable(
      sConnection, "offline_attempts",
      "id:INTEGER:0:1,operationId:INTEGER:1:0,revision:INTEGER:1:0,state:"
      "INTEGER:1:0,"
      "sourceFolderId:INTEGER:0:0,sourceKey:INTEGER:0:0,sourceEpoch:INTEGER:0:"
      "0,"
      "sourceUid:INTEGER:0:0,destinationFolderId:INTEGER:0:0,destinationKey:"
      "INTEGER:0:0,"
      "destinationEpoch:INTEGER:0:0,confirmedUid:INTEGER:0:0,operationFolderId:"
      "INTEGER:1:0,operationEpoch:INTEGER:0:0,operation:INTEGER:1:0"));
  if (version < 7) {
    MOZ_TRY(SearchChangeTriggers(sConnection,
                                 SearchTriggerAction::ReplacePolicy, false));
    MOZ_TRY(sConnection->SetSchemaVersion(7));
  }
  if (version < 8) {
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "CREATE TABLE database_identity (singleton INTEGER PRIMARY KEY "
        "CHECK(singleton = 1), sourceId TEXT NOT NULL)"_ns));
    nsCOMPtr<nsIUUIDGenerator> generator =
        mozilla::components::UUIDGenerator::Service();
    NS_ENSURE_TRUE(generator, NS_ERROR_FAILURE);
    nsID id;
    MOZ_TRY(generator->GenerateUUIDInPlace(&id));
    char value[NSID_LENGTH];
    id.ToProvidedString(value);
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(sConnection->CreateStatement(
        "INSERT INTO database_identity(singleton, sourceId) VALUES(1, :sourceId)"_ns,
        getter_AddRefs(stmt)));
    MOZ_TRY(
        stmt->BindUTF8StringByName("sourceId"_ns, nsDependentCString(value)));
    MOZ_TRY(stmt->Execute());
    MOZ_TRY(sConnection->SetSchemaVersion(8));
  }
  MOZ_TRY(CheckReferenceSchemaTable(sConnection, "database_identity",
                                    "singleton:INTEGER:0:1,sourceId:TEXT:1:0"));
  nsCString sourceId;
  MOZ_TRY(ReadDatabaseSourceId(sConnection, sourceId));
  if (version < 9) {
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "CREATE TABLE folder_import_receipts (token TEXT PRIMARY KEY, "
        "sourceId TEXT NOT NULL UNIQUE, databaseSourceId TEXT NOT NULL, "
        "sourceSha256 TEXT NOT NULL, folderId INTEGER NOT NULL UNIQUE, "
        "folderPath TEXT NOT NULL, sourcePath TEXT NOT NULL, messageCount "
        "INTEGER NOT NULL);"
        "CREATE TABLE folder_import_keys (token TEXT NOT NULL REFERENCES "
        "folder_import_receipts(token), sourceKey INTEGER NOT NULL, "
        "destinationKey INTEGER NOT NULL UNIQUE, PRIMARY KEY(token, sourceKey));"_ns));
    MOZ_TRY(sConnection->SetSchemaVersion(9));
  }
  MOZ_TRY(CheckReferenceSchemaTable(
      sConnection, "folder_import_receipts",
      "token:TEXT:0:1,sourceId:TEXT:1:0,databaseSourceId:TEXT:1:0,"
      "sourceSha256:TEXT:1:0,folderId:INTEGER:1:0,folderPath:TEXT:1:0,"
      "sourcePath:TEXT:1:0,messageCount:INTEGER:1:0"));
  MOZ_TRY(CheckReferenceSchemaTable(
      sConnection, "folder_import_keys",
      "token:TEXT:1:1,sourceKey:INTEGER:1:2,destinationKey:INTEGER:1:0"));
  if (version < 10) {
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "CREATE TABLE body_relocations(folderId INTEGER PRIMARY KEY, token "
        "TEXT NOT NULL UNIQUE, "
        "sourceId TEXT NOT NULL, original TEXT NOT NULL, compacted TEXT NOT "
        "NULL, backup TEXT NOT NULL, "
        "originalSize INTEGER NOT NULL, compactedSize INTEGER NOT NULL, state "
        "INTEGER NOT NULL, "
        "messageCount INTEGER NOT NULL);"
        "CREATE TABLE body_relocation_rows(folderId INTEGER NOT NULL, id "
        "INTEGER NOT NULL, "
        "oldToken TEXT, content INTEGER NOT NULL, location INTEGER NOT NULL, "
        "size INTEGER NOT NULL, "
        "offlineSize INTEGER NOT NULL, lines INTEGER NOT NULL, flags INTEGER "
        "NOT NULL, newToken TEXT, "
        "newSize INTEGER NOT NULL, newOfflineSize INTEGER NOT NULL, newLines "
        "INTEGER NOT NULL, "
        "offline INTEGER NOT NULL, PRIMARY KEY(folderId,id));"_ns));
    MOZ_TRY(sConnection->SetSchemaVersion(10));
  }
  MOZ_TRY(CheckReferenceSchemaTable(
      sConnection, "body_relocations",
      "folderId:INTEGER:0:1,token:TEXT:1:0,sourceId:TEXT:1:0,original:TEXT:1:0,"
      "compacted:TEXT:1:0,backup:TEXT:1:0,originalSize:INTEGER:1:0,"
      "compactedSize:INTEGER:1:0,"
      "state:INTEGER:1:0,messageCount:INTEGER:1:0"));
  MOZ_TRY(CheckReferenceSchemaTable(
      sConnection, "body_relocation_rows",
      "folderId:INTEGER:1:1,id:INTEGER:1:2,oldToken:TEXT:0:0,content:INTEGER:1:"
      "0,location:INTEGER:1:0,"
      "size:INTEGER:1:0,offlineSize:INTEGER:1:0,lines:INTEGER:1:0,flags:"
      "INTEGER:1:0,newToken:TEXT:0:0,"
      "newSize:INTEGER:1:0,newOfflineSize:INTEGER:1:0,newLines:INTEGER:1:0,"
      "offline:INTEGER:1:0"));
  for (const auto* table :
       {"messages", "staged_messages", "folder_properties", "folders",
        "offline_operations", "offline_attempts", "offline_copy_destinations",
        "message_properties", "message_references", "message_reference_sets",
        "staged_message_properties", "staged_message_references",
        "staged_message_reference_sets"}) {
    for (const auto* action : {"INSERT", "UPDATE", "DELETE"}) {
      nsAutoCString sql("CREATE TRIGGER IF NOT EXISTS relocation_guard_");
      sql.Append(table);
      sql.Append('_');
      sql.Append(action);
      sql.AppendLiteral(" BEFORE ");
      sql.Append(action);
      sql.AppendLiteral(" ON ");
      sql.Append(table);
      sql.AppendLiteral(
          " WHEN EXISTS(SELECT 1 FROM body_relocations r WHERE r.state NOT "
          "IN(1,2) AND "
          "(");
      bool first = true;
      for (const auto* row : {"OLD", "NEW"}) {
        if ((strcmp(action, "INSERT") == 0 && strcmp(row, "OLD") == 0) ||
            (strcmp(action, "DELETE") == 0 && strcmp(row, "NEW") == 0)) {
          continue;
        }
        if (!first) {
          sql.AppendLiteral(" OR ");
        }
        first = false;
        if (strcmp(table, "messages") == 0 ||
            strcmp(table, "staged_messages") == 0 ||
            strcmp(table, "offline_operations") == 0) {
          sql.AppendLiteral("r.folderId=");
          sql.Append(row);
          sql.AppendLiteral(".folderId");
        } else if (strcmp(table, "offline_attempts") == 0) {
          sql.AppendLiteral("r.folderId IN (");
          sql.Append(row);
          sql.AppendLiteral(".sourceFolderId,");
          sql.Append(row);
          sql.AppendLiteral(".destinationFolderId,");
          sql.Append(row);
          sql.AppendLiteral(".operationFolderId)");
        } else if (strcmp(table, "offline_copy_destinations") == 0) {
          sql.AppendLiteral(
              "r.folderId IN (SELECT folderId FROM offline_operations WHERE "
              "id=");
          sql.Append(row);
          sql.AppendLiteral(".operationId)");
        } else if (strcmp(table, "folders") == 0) {
          sql.AppendLiteral(
              "r.folderId IN (WITH RECURSIVE children(id) AS (SELECT ");
          sql.Append(row);
          sql.AppendLiteral(
              ".id UNION SELECT f.id FROM folders f JOIN children c ON "
              "f.parent=c.id) SELECT id FROM children)");
        } else if (strcmp(table, "folder_properties") == 0) {
          sql.AppendLiteral("r.folderId=");
          sql.Append(row);
          sql.AppendLiteral(".id");
        } else {
          sql.AppendLiteral("r.folderId IN (SELECT folderId FROM ");
          sql.Append(StringBeginsWith(nsDependentCString(table), "staged_"_ns)
                         ? "staged_messages"
                         : "messages");
          sql.AppendLiteral(" WHERE id=");
          sql.Append(row);
          sql.AppendLiteral(".id)");
        }
      }
      sql.AppendLiteral(
          ")) BEGIN SELECT RAISE(ABORT,'pending body relocation'); END");
      MOZ_TRY(sConnection->ExecuteSimpleSQL(sql));
    }
  }
  MOZ_TRY(sConnection->ExecuteSimpleSQL(
      "CREATE TRIGGER IF NOT EXISTS body_relocation_folder_delete AFTER DELETE "
      "ON folders BEGIN "
      "DELETE FROM body_relocation_rows WHERE folderId=OLD.id; "
      "DELETE FROM body_relocations WHERE folderId=OLD.id; END"_ns));
  if (version < 11) {
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "ALTER TABLE offline_operations ADD COLUMN destinationFolderId INTEGER;"
        "ALTER TABLE offline_operations ADD COLUMN destinationKey INTEGER;"
        "ALTER TABLE offline_operations ADD COLUMN destinationEpoch INTEGER;"
        "ALTER TABLE offline_copy_destinations ADD COLUMN destinationFolderId "
        "INTEGER;"
        "ALTER TABLE offline_copy_destinations ADD COLUMN destinationKey "
        "INTEGER;"
        "ALTER TABLE offline_copy_destinations ADD COLUMN destinationEpoch INTEGER;"_ns));
    MOZ_TRY(sConnection->SetSchemaVersion(11));
  }
  MOZ_TRY(CheckReferenceSchemaTable(
      sConnection, "offline_operations",
      "id:INTEGER:0:1,folderId:INTEGER:1:0,messageKey:INTEGER:1:0,revision:"
      "INTEGER:1:0,"
      "epoch:INTEGER:0:0,uid:INTEGER:0:0,operation:INTEGER:1:0,flagOperation:"
      "INTEGER:1:0,"
      "newFlags:INTEGER:1:0,sourceKey:INTEGER:1:0,sourceUid:INTEGER:1:0,"
      "messageSize:INTEGER:1:0,playingBack:INTEGER:1:0,sourceFolderURI:TEXT:1:"
      "0,"
      "destinationFolderURI:TEXT:1:0,keywordsToAdd:TEXT:1:0,keywordsToRemove:"
      "TEXT:1:0,folderEpoch:INTEGER:0:0,destinationFolderId:INTEGER:0:0,"
      "destinationKey:INTEGER:0:0,destinationEpoch:INTEGER:0:0"));
  MOZ_TRY(CheckReferenceSchemaTable(
      sConnection, "offline_copy_destinations",
      "operationId:INTEGER:1:1,ordinal:INTEGER:1:2,uri:TEXT:1:0,"
      "destinationFolderId:INTEGER:0:0,destinationKey:INTEGER:0:0,"
      "destinationEpoch:INTEGER:0:0"));

  if (version < 12) {
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "CREATE TABLE folder_id_allocator(singleton INTEGER PRIMARY KEY "
        "CHECK(singleton=1), highWater INTEGER NOT NULL "
        "CHECK(typeof(highWater)='integer' AND highWater>=0));"
        "INSERT INTO folder_id_allocator SELECT 1,MAX(id) FROM ("
        "SELECT 0 AS id UNION ALL SELECT id FROM folders "
        "UNION ALL SELECT parent FROM folders "
        "UNION ALL SELECT folderId FROM messages "
        "UNION ALL SELECT folderId FROM staged_messages "
        "UNION ALL SELECT id FROM folder_properties "
        "UNION ALL SELECT folderId FROM offline_operations "
        "UNION ALL SELECT destinationFolderId FROM offline_operations "
        "UNION ALL SELECT destinationFolderId FROM offline_copy_destinations "
        "UNION ALL SELECT sourceFolderId FROM offline_attempts "
        "UNION ALL SELECT destinationFolderId FROM offline_attempts "
        "UNION ALL SELECT operationFolderId FROM offline_attempts "
        "UNION ALL SELECT virtualFolderId FROM virtualFolder_folders "
        "UNION ALL SELECT searchFolderId FROM virtualFolder_folders "
        "UNION ALL SELECT folder_id FROM search_folder_hits "
        "UNION ALL SELECT folderId FROM folder_import_receipts "
        "UNION ALL SELECT folderId FROM body_relocations "
        "UNION ALL SELECT folderId FROM body_relocation_rows);"_ns));
    MOZ_TRY(sConnection->ExecuteSimpleSQL(kFolderIdGuard));
    MOZ_TRY(sConnection->ExecuteSimpleSQL(kFolderIdRecord));
    MOZ_TRY(sConnection->ExecuteSimpleSQL(kFolderIdImmutable));
    MOZ_TRY(sConnection->SetSchemaVersion(12));
  }
  MOZ_TRY(
      CheckReferenceSchemaTable(sConnection, "folder_id_allocator",
                                "singleton:INTEGER:0:1,highWater:INTEGER:1:0"));
  for (auto pair : {std::pair{"guard_folder_id", &kFolderIdGuard},
                    {"record_folder_id", &kFolderIdRecord},
                    {"immutable_folder_id", &kFolderIdImmutable}}) {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(sConnection->CreateStatement(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=:name"_ns,
        getter_AddRefs(stmt)));
    MOZ_TRY(
        stmt->BindUTF8StringByName("name"_ns, nsDependentCString(pair.first)));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
    nsCString sql;
    MOZ_TRY(stmt->GetUTF8String(0, sql));
    NS_ENSURE_TRUE(sql.Equals(*pair.second), NS_ERROR_FILE_CORRUPTED);
  }
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(sConnection->CreateStatement(
        "SELECT 1 FROM folder_id_allocator WHERE singleton=1 "
        "AND typeof(highWater)='integer' AND highWater>=0 "
        "AND NOT EXISTS(SELECT 1 FROM folders WHERE id<=0 OR id>highWater)"_ns,
        getter_AddRefs(stmt)));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
  }

  if (version < 13) {
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "CREATE TABLE thread_flags(folderId INTEGER NOT NULL REFERENCES "
        "folders(id) CHECK(typeof(folderId)='integer' AND folderId>0),"
        "threadId INTEGER NOT NULL CHECK(typeof(threadId)='integer' AND "
        "threadId>0 AND threadId<4294967295),"
        "flags INTEGER NOT NULL CHECK(typeof(flags)='integer' AND flags>=0 AND "
        "flags<=4294967295),"
        "PRIMARY KEY(folderId,threadId))"_ns));
    MOZ_TRY(sConnection->ExecuteSimpleSQL(kThreadFlagsMessageDelete));
    MOZ_TRY(sConnection->ExecuteSimpleSQL(kThreadFlagsFolderDelete));
    MOZ_TRY(sConnection->SetSchemaVersion(13));
  }
  MOZ_TRY(CheckReferenceSchemaTable(
      sConnection, "thread_flags",
      "folderId:INTEGER:1:1,threadId:INTEGER:1:2,flags:INTEGER:1:0"));
  for (auto pair :
       {std::pair{"thread_flags_message_delete", &kThreadFlagsMessageDelete},
        {"thread_flags_folder_delete", &kThreadFlagsFolderDelete}}) {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(sConnection->CreateStatement(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=:name"_ns,
        getter_AddRefs(stmt)));
    MOZ_TRY(
        stmt->BindUTF8StringByName("name"_ns, nsDependentCString(pair.first)));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
    nsCString sql;
    MOZ_TRY(stmt->GetUTF8String(0, sql));
    NS_ENSURE_TRUE(sql.Equals(*pair.second), NS_ERROR_FILE_CORRUPTED);
  }

  if (version < 14) {
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "CREATE TABLE folder_import_windows(token TEXT PRIMARY KEY REFERENCES "
        "folder_import_receipts(token), version INTEGER NOT NULL "
        "CHECK(version=2), "
        "sOriginal TEXT NOT NULL, sRootOriginal TEXT NOT NULL, sCanonical TEXT "
        "NOT NULL, "
        "sCanonicalRoot TEXT NOT NULL, sId TEXT NOT NULL, sParentId TEXT NOT "
        "NULL, "
        "sRootId TEXT NOT NULL, tOriginal TEXT NOT NULL, tRootOriginal TEXT "
        "NOT NULL, "
        "tCanonical TEXT NOT NULL, tCanonicalRoot TEXT NOT NULL, tId TEXT NOT "
        "NULL, "
        "tParentId TEXT NOT NULL, tRootId TEXT NOT NULL)"_ns));
    MOZ_TRY(sConnection->SetSchemaVersion(14));
  }
  MOZ_TRY(
      CheckReferenceSchemaTable(sConnection, "folder_import_windows",
                                "token:TEXT:0:1,version:INTEGER:1:0,sOriginal:"
                                "TEXT:1:0,sRootOriginal:TEXT:1:0,"
                                "sCanonical:TEXT:1:0,sCanonicalRoot:TEXT:1:0,"
                                "sId:TEXT:1:0,sParentId:TEXT:1:0,"
                                "sRootId:TEXT:1:0,tOriginal:TEXT:1:0,"
                                "tRootOriginal:TEXT:1:0,tCanonical:TEXT:1:0,"
                                "tCanonicalRoot:TEXT:1:0,tId:TEXT:1:0,"
                                "tParentId:TEXT:1:0,tRootId:TEXT:1:0"));
  if (version < 15) {
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "CREATE TABLE folder_cache_imports(token TEXT PRIMARY KEY NOT NULL, "
        "sourceId TEXT NOT NULL UNIQUE, path TEXT NOT NULL UNIQUE, "
        "identity TEXT NOT NULL, raw BLOB NOT NULL, receipt TEXT NOT NULL);"
        "CREATE TABLE folder_cache_bindings(folderId INTEGER PRIMARY KEY NOT "
        "NULL, "
        "token TEXT NOT NULL REFERENCES folder_cache_imports(token))"_ns));
    MOZ_TRY(sConnection->SetSchemaVersion(15));
  }
  MOZ_TRY(CheckReferenceSchemaTable(
      sConnection, "folder_cache_imports",
      "token:TEXT:1:1,sourceId:TEXT:1:0,path:TEXT:1:0,identity:TEXT:1:0,"
      "raw:BLOB:1:0,receipt:TEXT:1:0"));
  MOZ_TRY(CheckReferenceSchemaTable(sConnection, "folder_cache_bindings",
                                    "folderId:INTEGER:1:1,token:TEXT:1:0"));
  return NS_OK;
}

namespace {

bool SameImportPath(const FolderImportPathIdentity& a,
                    const FolderImportPathIdentity& b) {
  return a.originalPath == b.originalPath && a.originalRoot == b.originalRoot &&
         a.canonicalPath == b.canonicalPath &&
         a.canonicalRoot == b.canonicalRoot && a.id == b.id &&
         a.parentId == b.parentId && a.rootId == b.rootId;
}

bool ValidImportFileId(const nsACString& id) {
  if (id.Length() != 49 || id[16] != ':') {
    return false;
  }
  for (uint32_t i = 0; i < id.Length(); ++i) {
    if (i != 16 &&
        !((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f'))) {
      return false;
    }
  }
  return true;
}

// Owns different leases from any caller-visible JS admission.
class FolderImportAdmission final {
 public:
  nsresult Acquire(const FolderImportIdentity& expected,
                   nsIFile* actualSummary = nullptr,
                   nsIFile* actualStore = nullptr) {
    mIdentity = expected;
#ifdef XP_WIN
    NS_ENSURE_TRUE(expected.windows, NS_ERROR_NOT_AVAILABLE);
    mFileSystem = new MigrationFileSystem();
    FolderImportWindowsIdentity measured;
    MOZ_TRY(Admit(expected.windows->summary, false, actualSummary,
                  measured.summary));
    MOZ_TRY(Admit(expected.windows->store, true, actualStore, measured.store));
    NS_ENSURE_TRUE(expected.sourcePath.IsEmpty() ||
                       expected.sourcePath == measured.summary.canonicalPath,
                   NS_ERROR_NOT_AVAILABLE);
    mIdentity.sourcePath = measured.summary.canonicalPath;
    mIdentity.windows = Some(std::move(measured));
    MOZ_TRY(NS_NewLocalFile(mIdentity.sourcePath, getter_AddRefs(mSummary)));
#else
    NS_ENSURE_FALSE(expected.windows, NS_ERROR_NOT_AVAILABLE);
    mSummary = actualSummary;
#endif
    return Validate();
  }

  nsresult Validate() {
#ifdef XP_WIN
    for (const auto& lease : mLeases) {
      MOZ_TRY(mFileSystem->Validate(lease));
    }
#endif
    return NS_OK;
  }
  const FolderImportIdentity& Identity() const { return mIdentity; }
  nsIFile* Summary() const { return mSummary; }

 private:
#ifdef XP_WIN
  static nsresult OriginalFile(const nsAString& path, nsIFile** output) {
    MOZ_TRY(NS_NewLocalFile(path, output));
    nsAutoString actual;
    MOZ_TRY((*output)->GetPath(actual));
    NS_ENSURE_TRUE(actual == path, NS_ERROR_FILE_INVALID_PATH);
    return NS_OK;
  }

  nsresult Admit(const FolderImportPathIdentity& expected, bool allowMissing,
                 nsIFile* actual, FolderImportPathIdentity& measured) {
    NS_ENSURE_TRUE(ValidImportFileId(expected.parentId) &&
                       ValidImportFileId(expected.rootId) &&
                       (ValidImportFileId(expected.id) ||
                        (allowMissing && expected.id.IsEmpty())),
                   NS_ERROR_INVALID_ARG);
    nsCOMPtr<nsIFile> original, root;
    MOZ_TRY(OriginalFile(expected.originalPath, getter_AddRefs(original)));
    MOZ_TRY(OriginalFile(expected.originalRoot, getter_AddRefs(root)));
    uint16_t kind = expected.id.IsEmpty()
                        ? nsIPanoramaMigrationFileSystem::KIND_FILE_OR_MISSING
                        : nsIPanoramaMigrationFileSystem::KIND_FILE;
    nsCOMPtr<nsIPanoramaMigrationPath> lease;
    MOZ_TRY(mFileSystem->Admit(original, root, kind, getter_AddRefs(lease)));
    mLeases.AppendElement(lease);
    bool exists;
    MOZ_TRY(lease->GetExists(&exists));
    NS_ENSURE_TRUE(exists == !expected.id.IsEmpty(), NS_ERROR_NOT_AVAILABLE);
    measured.originalPath = expected.originalPath;
    measured.originalRoot = expected.originalRoot;
    MOZ_TRY(lease->GetCanonicalPath(measured.canonicalPath));
    MOZ_TRY(lease->GetCanonicalRoot(measured.canonicalRoot));
    MOZ_TRY(lease->GetIdentity(measured.id));
    MOZ_TRY(lease->GetParentIdentity(measured.parentId));
    MOZ_TRY(lease->GetRootIdentity(measured.rootId));
    NS_ENSURE_TRUE(measured.id == expected.id &&
                       measured.parentId == expected.parentId &&
                       measured.rootId == expected.rootId &&
                       (expected.canonicalPath.IsEmpty() ||
                        measured.canonicalPath == expected.canonicalPath) &&
                       (expected.canonicalRoot.IsEmpty() ||
                        measured.canonicalRoot == expected.canonicalRoot),
                   NS_ERROR_NOT_AVAILABLE);
    if (actual) {
      nsCOMPtr<nsIPanoramaMigrationPath> bound;
      MOZ_TRY(mFileSystem->Admit(actual, root, kind, getter_AddRefs(bound)));
      mLeases.AppendElement(bound);
      nsAutoString path;
      nsAutoCString id, parent;
      MOZ_TRY(bound->GetCanonicalPath(path));
      MOZ_TRY(bound->GetIdentity(id));
      MOZ_TRY(bound->GetParentIdentity(parent));
      NS_ENSURE_TRUE(path == measured.canonicalPath && id == measured.id &&
                         parent == measured.parentId,
                     NS_ERROR_NOT_AVAILABLE);
    }
    return NS_OK;
  }
  RefPtr<MigrationFileSystem> mFileSystem;
  nsTArray<nsCOMPtr<nsIPanoramaMigrationPath>> mLeases;
#endif
  FolderImportIdentity mIdentity;
  nsCOMPtr<nsIFile> mSummary;
};

// Work on clones: normalizing must not rewrite the folder's stored path.
nsresult NormalizeImportFile(nsCOMPtr<nsIFile>& file) {
  NS_ENSURE_TRUE(file, NS_ERROR_INVALID_ARG);
  nsCOMPtr<nsIFile> normalized;
  MOZ_TRY(file->Clone(getter_AddRefs(normalized)));
  bool linked;
  nsresult rv = normalized->IsSymlink(&linked);
  if (rv == NS_ERROR_FILE_NOT_FOUND) {
    nsAutoString leaf;
    MOZ_TRY(normalized->GetLeafName(leaf));
    nsCOMPtr<nsIFile> parent;
    MOZ_TRY(normalized->GetParent(getter_AddRefs(parent)));
    NS_ENSURE_TRUE(parent, NS_ERROR_FILE_UNRECOGNIZED_PATH);
    MOZ_TRY(parent->Normalize());
    MOZ_TRY(parent->Append(leaf));
    normalized = parent;
  } else {
    MOZ_TRY(rv);
    NS_ENSURE_FALSE(linked, NS_ERROR_FILE_ACCESS_DENIED);
    MOZ_TRY(normalized->Normalize());
  }
  file = normalized;
  return NS_OK;
}

nsresult BindImportPath(mozIStorageStatement* stmt, const char* prefix,
                        const FolderImportPathIdentity& path) {
  for (auto pair : {std::pair{"Original", &path.originalPath},
                    {"RootOriginal", &path.originalRoot},
                    {"Canonical", &path.canonicalPath},
                    {"CanonicalRoot", &path.canonicalRoot}}) {
    nsAutoCString name(prefix);
    name.Append(pair.first);
    MOZ_TRY(stmt->BindStringByName(name, *pair.second));
  }
  for (auto pair : {std::pair{"Id", &path.id},
                    {"ParentId", &path.parentId},
                    {"RootId", &path.rootId}}) {
    nsAutoCString name(prefix);
    name.Append(pair.first);
    MOZ_TRY(stmt->BindUTF8StringByName(name, *pair.second));
  }
  return NS_OK;
}

nsresult WriteWindowsImportReceipt(mozIStorageConnection* connection,
                                   const FolderImportIdentity& identity) {
  if (!identity.windows) {
    return NS_OK;
  }
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(connection->CreateStatement(
      "INSERT INTO folder_import_windows VALUES(:token,2,:sOriginal,"
      ":sRootOriginal,:sCanonical,:sCanonicalRoot,:sId,:sParentId,:sRootId,"
      ":tOriginal,:tRootOriginal,:tCanonical,:tCanonicalRoot,:tId,:tParentId,:tRootId)"_ns,
      getter_AddRefs(stmt)));
  MOZ_TRY(stmt->BindUTF8StringByName("token"_ns, identity.token));
  MOZ_TRY(BindImportPath(stmt, "s", identity.windows->summary));
  MOZ_TRY(BindImportPath(stmt, "t", identity.windows->store));
  return stmt->Execute();
}

nsresult ReadImportPath(mozIStorageStatement* stmt, uint32_t column,
                        FolderImportPathIdentity& path) {
  for (auto* text : {&path.originalPath, &path.originalRoot,
                     &path.canonicalPath, &path.canonicalRoot}) {
    int32_t type;
    MOZ_TRY(stmt->GetTypeOfIndex(column, &type));
    NS_ENSURE_TRUE(type == mozIStorageStatement::VALUE_TYPE_TEXT,
                   NS_ERROR_FILE_CORRUPTED);
    MOZ_TRY(stmt->GetString(column++, *text));
  }
  for (auto* text : {&path.id, &path.parentId, &path.rootId}) {
    int32_t type;
    MOZ_TRY(stmt->GetTypeOfIndex(column, &type));
    NS_ENSURE_TRUE(type == mozIStorageStatement::VALUE_TYPE_TEXT,
                   NS_ERROR_FILE_CORRUPTED);
    MOZ_TRY(stmt->GetUTF8String(column++, *text));
  }
  NS_ENSURE_TRUE((path.id.IsEmpty() || ValidImportFileId(path.id)) &&
                     ValidImportFileId(path.parentId) &&
                     ValidImportFileId(path.rootId),
                 NS_ERROR_FILE_CORRUPTED);
  return NS_OK;
}

nsresult ReadWindowsImportReceipt(mozIStorageConnection* connection,
                                  const FolderImportIdentity& expected,
                                  FolderImportIdentity& found) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(connection->CreateStatement(
      "SELECT version,sOriginal,sRootOriginal,sCanonical,sCanonicalRoot,sId,"
      "sParentId,sRootId,tOriginal,tRootOriginal,tCanonical,tCanonicalRoot,tId,"
      "tParentId,tRootId FROM folder_import_windows WHERE token=:token"_ns,
      getter_AddRefs(stmt)));
  MOZ_TRY(stmt->BindUTF8StringByName("token"_ns, expected.token));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  if (!more) {
    // Unix v1 stays v1; old Windows receipts cannot acquire new physical pins.
    NS_ENSURE_FALSE(expected.windows, NS_ERROR_NOT_AVAILABLE);
    return NS_OK;
  }
  NS_ENSURE_TRUE(expected.windows, NS_ERROR_NOT_AVAILABLE);
  int32_t type;
  int64_t version;
  MOZ_TRY(stmt->GetTypeOfIndex(0, &type));
  MOZ_TRY(stmt->GetInt64(0, &version));
  NS_ENSURE_TRUE(
      type == mozIStorageStatement::VALUE_TYPE_INTEGER && version == 2,
      NS_ERROR_FILE_CORRUPTED);
  FolderImportWindowsIdentity measured;
  MOZ_TRY(ReadImportPath(stmt, 1, measured.summary));
  MOZ_TRY(ReadImportPath(stmt, 8, measured.store));
  NS_ENSURE_TRUE(!measured.summary.id.IsEmpty(), NS_ERROR_FILE_CORRUPTED);
  NS_ENSURE_TRUE(SameImportPath(measured.summary, expected.windows->summary) &&
                     SameImportPath(measured.store, expected.windows->store),
                 NS_ERROR_ALREADY_INITIALIZED);
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  found.windows = Some(std::move(measured));
  return NS_OK;
}

nsresult HashImportSource(nsIFile* file, const FolderImportIdentity& identity,
                          uint64_t sourceSize,
                          nsACString* legacyMarker = nullptr) {
  NS_ENSURE_ARG_POINTER(file);
  nsCOMPtr<nsIFile> normalized = file;
  MOZ_TRY(NormalizeImportFile(normalized));
  nsAutoString path;
  MOZ_TRY(normalized->GetPath(path));
  NS_ENSURE_TRUE(path == identity.sourcePath, NS_ERROR_INVALID_ARG);
  int64_t size;
  MOZ_TRY(normalized->GetFileSize(&size));
  NS_ENSURE_TRUE(size >= 0 && uint64_t(size) == sourceSize,
                 NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(uint64_t(size) < UINT32_MAX, NS_ERROR_FILE_TOO_BIG);
  nsCOMPtr<nsIInputStream> stream;
  MOZ_TRY(NS_NewLocalFileInputStream(getter_AddRefs(stream), normalized));
  auto close = MakeScopeExit([&] { stream->Close(); });
  nsCOMPtr<nsICryptoHash> hash;
  MOZ_TRY(NS_NewCryptoHash(nsICryptoHash::SHA256, getter_AddRefs(hash)));
  if (size) {
    MOZ_TRY(hash->UpdateFromStream(stream, UINT32_MAX));
  }
  MOZ_TRY(stream->Close());
  close.release();
  nsCString bytes, hex;
  MOZ_TRY(hash->Finish(false, bytes));
  for (unsigned char byte : bytes.View()) {
    hex.Append("0123456789abcdef"[byte >> 4]);
    hex.Append("0123456789abcdef"[byte & 15]);
  }
  NS_ENSURE_TRUE(hex == identity.sourceSha256, NS_ERROR_NOT_AVAILABLE);
  if (legacyMarker) {
    nsCString base64;
    MOZ_TRY(Base64Encode(bytes, base64));
    legacyMarker->Assign("v1:sha256:"_ns);
    legacyMarker->Append(base64);
  }
  return NS_OK;
}

}  // namespace

nsresult DatabaseCore::CheckFolderImportIdentity(
    const FolderImportIdentity& identity) {
  NS_ENSURE_TRUE(sInstance.get() == this && sConnection && mFolderDatabase,
                 NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(!identity.token.IsEmpty() && !identity.sourceId.IsEmpty() &&
                     identity.folderId && identity.folderId <= INT64_MAX &&
                     identity.sourceSha256.Length() == 64,
                 NS_ERROR_INVALID_ARG);
  for (char c : identity.sourceSha256.View()) {
    NS_ENSURE_TRUE((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'),
                   NS_ERROR_INVALID_ARG);
  }
  nsCString sourceId;
  MOZ_TRY(ReadDatabaseSourceId(sConnection, sourceId));
  NS_ENSURE_TRUE(sourceId == identity.databaseSourceId, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(GetStatement("ImportDestinationExists"_ns,
                       "SELECT 1 FROM folders WHERE id = :id"_ns,
                       getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, identity.folderId));
  bool exists;
  MOZ_TRY(stmt->ExecuteStep(&exists));
  NS_ENSURE_TRUE(exists, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(MessageDB().CheckPendingFolderRelocation(identity.folderId));
  nsCString path = MOZ_TRY(mFolderDatabase->GetFolderPath(identity.folderId));
  NS_ENSURE_TRUE(path == identity.folderPath, NS_ERROR_NOT_AVAILABLE);
  return NS_OK;
}

nsresult DatabaseCore::GetFolderImportReceipt(
    const FolderImportIdentity& identity, Maybe<FolderImportReceipt>& output) {
  NS_ENSURE_TRUE(sInstance.get() == this && sConnection,
                 NS_ERROR_NOT_AVAILABLE);
  bool active;
  MOZ_TRY(sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  FolderImportAdmission admission;
  MOZ_TRY(admission.Acquire(identity));
  const auto& checked = admission.Identity();
  MOZ_TRY(CheckFolderImportIdentity(checked));
#ifdef XP_WIN
  int64_t size;
  MOZ_TRY(admission.Summary()->GetFileSize(&size));
  NS_ENSURE_TRUE(size >= 0, NS_ERROR_FILE_CORRUPTED);
  MOZ_TRY(HashImportSource(admission.Summary(), checked, size));
#endif
  Maybe<FolderImportReceipt> receipt;
  MOZ_TRY(ReadFolderImportReceipt(checked, receipt));
  MOZ_TRY(admission.Validate());
  output = std::move(receipt);
  return NS_OK;
}

nsresult DatabaseCore::ReadFolderImportReceipt(
    const FolderImportIdentity& identity, Maybe<FolderImportReceipt>& output) {
  FolderImportReceipt receipt;
  int64_t expectedCount;
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(GetStatement(
        "ReadFolderImportReceipt"_ns,
        "SELECT token, sourceId, databaseSourceId, sourceSha256, folderId, "
        "folderPath, sourcePath, messageCount FROM folder_import_receipts "
        "WHERE token = "
        ":token OR "
        "sourceId = :source OR folderId = :folder"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scoper(stmt);
    MOZ_TRY(stmt->BindUTF8StringByName("token"_ns, identity.token));
    MOZ_TRY(stmt->BindUTF8StringByName("source"_ns, identity.sourceId));
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, identity.folderId));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (!more) {
      nsCOMPtr<mozIStorageStatement> old;
      MOZ_TRY(GetStatement("OldImportReceiptWithoutMap"_ns,
                           "SELECT 1 FROM folder_properties WHERE id = :id "
                           "AND name = 'morkMigrationSource'"_ns,
                           getter_AddRefs(old)));
      mozStorageStatementScoper oldScoper(old);
      MOZ_TRY(old->BindInt64ByName("id"_ns, identity.folderId));
      MOZ_TRY(old->ExecuteStep(&more));
      NS_ENSURE_FALSE(more, NS_ERROR_NOT_AVAILABLE);
      output.reset();
      return NS_OK;
    }
    auto& found = receipt.identity;
    MOZ_TRY(stmt->GetUTF8String(0, found.token));
    MOZ_TRY(stmt->GetUTF8String(1, found.sourceId));
    MOZ_TRY(stmt->GetUTF8String(2, found.databaseSourceId));
    MOZ_TRY(stmt->GetUTF8String(3, found.sourceSha256));
    int64_t folder;
    MOZ_TRY(stmt->GetInt64(4, &folder));
    MOZ_TRY(stmt->GetUTF8String(5, found.folderPath));
    MOZ_TRY(stmt->GetString(6, found.sourcePath));
    MOZ_TRY(stmt->GetInt64(7, &expectedCount));
    NS_ENSURE_TRUE(expectedCount >= 0 && uint64_t(expectedCount) <= UINT32_MAX,
                   NS_ERROR_FILE_CORRUPTED);
    NS_ENSURE_TRUE(folder > 0, NS_ERROR_FILE_CORRUPTED);
    found.folderId = static_cast<uint64_t>(folder);
    NS_ENSURE_TRUE(found.token == identity.token &&
                       found.sourceId == identity.sourceId &&
                       found.databaseSourceId == identity.databaseSourceId &&
                       found.sourceSha256 == identity.sourceSha256 &&
                       found.folderId == identity.folderId &&
                       found.sourcePath == identity.sourcePath,
                   NS_ERROR_ALREADY_INITIALIZED);
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  }
  MOZ_TRY(ReadWindowsImportReceipt(sConnection, identity, receipt.identity));
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(
      GetStatement("ReadFolderImportKeys"_ns,
                   "SELECT sourceKey, destinationKey FROM folder_import_keys "
                   "WHERE token = :token ORDER BY sourceKey"_ns,
                   getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindUTF8StringByName("token"_ns, identity.token));
  while (true) {
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    if (!more) {
      break;
    }
    int64_t source, destination;
    MOZ_TRY(stmt->GetInt64(0, &source));
    MOZ_TRY(stmt->GetInt64(1, &destination));
    NS_ENSURE_TRUE(source >= 0 && source < nsMsgKey_None && destination > 0 &&
                       destination < nsMsgKey_None,
                   NS_ERROR_FILE_CORRUPTED);
    receipt.keys.AppendElement(FolderImportKey{
        static_cast<nsMsgKey>(source), static_cast<nsMsgKey>(destination)});
  }
  NS_ENSURE_TRUE(receipt.keys.Length() == uint64_t(expectedCount),
                 NS_ERROR_FILE_CORRUPTED);
  if (receipt.identity.folderPath != identity.folderPath) {
    // Only after the physical/source tuple and durable mapping are checked may
    // an old receipt retain its slash-only spelling. Never use it for lookup or
    // rewrite it: literal percent and slash siblings had the same old path.
    nsCString historical =
        MOZ_TRY(mFolderDatabase->GetFolderPath(identity.folderId, false));
    NS_ENSURE_TRUE(receipt.identity.folderPath == historical,
                   NS_ERROR_ALREADY_INITIALIZED);
  }
  output = Some(std::move(receipt));
  return NS_OK;
}

nsresult DatabaseCore::WriteImportedMessage(uint64_t folderId, nsMsgKey key,
                                            nsMsgKey root, nsMsgKey parent,
                                            const RawHdr& header) {
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(GetStatement("ImportSnapshotMessage"_ns,
                         "INSERT INTO messages ("_ns MESSAGE_SQL_FIELDS
                         ") VALUES "
                         "(:id, :folder, :root, :parent, :messageId, :date, "
                         ":sender, :recipients, "
                         ":cc, :bcc, :subject, :flags, :tags, :priority)"_ns,
                         getter_AddRefs(stmt)));
    mozStorageStatementScoper scoper(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folderId));
    MOZ_TRY(stmt->BindInt64ByName("root"_ns, root));
    MOZ_TRY(stmt->BindInt64ByName("parent"_ns, parent));
    MOZ_TRY(stmt->BindInt64ByName("date"_ns, header.date));
    MOZ_TRY(stmt->BindInt64ByName("flags"_ns, header.flags));
    MOZ_TRY(stmt->BindInt32ByName("priority"_ns, header.priority));
    auto text = [&](const nsACString& name,
                    const nsACString& value) -> nsresult {
      nsCString normalized = MOZ_TRY(DatabaseUtils::Normalize(value));
      return stmt->BindUTF8StringByName(name, normalized);
    };
    MOZ_TRY(text("messageId"_ns, header.messageId));
    MOZ_TRY(text("sender"_ns, header.sender));
    MOZ_TRY(text("recipients"_ns, header.recipients));
    MOZ_TRY(text("cc"_ns, header.ccList));
    MOZ_TRY(text("bcc"_ns, header.bccList));
    MOZ_TRY(text("subject"_ns, header.subject));
    nsCString tags = MOZ_TRY(DatabaseUtils::Normalize(header.keywords));
    for (const auto& extra : header.extras) {
      if (extra.k.EqualsLiteral("keywords")) {
        tags = extra.v;
      }
    }
    MOZ_TRY(stmt->BindUTF8StringByName("tags"_ns, tags));
    MOZ_TRY(stmt->Execute());
  }
  auto& messages = MessageDB();
  MOZ_TRY(messages.WriteMessageReferencesInTransaction(key, header.references));
  if (!header.replyTo.IsEmpty()) {
    MOZ_TRY(messages.SetMessageProperty(key, "replyTo"_ns, header.replyTo));
  }
  if (!header.charset.IsEmpty()) {
    MOZ_TRY(messages.SetMessageProperty(key, "msgCharSet"_ns, header.charset));
  }
  if (!header.accountKey.IsEmpty()) {
    MOZ_TRY(messages.SetMessageProperty(key, "account"_ns, header.accountKey));
  }
  if (header.dateReceived) {
    uint32_t seconds;
    PRTime2Seconds(header.dateReceived, &seconds);
    nsAutoCString value;
    value.AppendInt(seconds, 16);
    MOZ_TRY(messages.SetMessageProperty(key, "dateReceived"_ns, value));
  }
  for (const auto& extra : header.extras) {
    if (!extra.k.EqualsLiteral("keywords")) {
      MOZ_TRY(messages.SetMessageProperty(key, extra.k, extra.v));
    }
  }
  if (header.storeToken) {
    MOZ_TRY(
        messages.SetMessageProperty(key, "storeToken"_ns, *header.storeToken));
  }
  if (header.messageSize) {
    MOZ_TRY(messages.SetMessageProperty(key, "messageSize"_ns,
                                        *header.messageSize));
  }
  if (header.offlineMessageSize) {
    MOZ_TRY(messages.SetMessageProperty(key, "offlineMessageSize"_ns,
                                        *header.offlineMessageSize));
  }
  if (header.lineCount) {
    MOZ_TRY(
        messages.SetMessageProperty(key, "lineCount"_ns, *header.lineCount));
  }
  return NS_OK;
}

nsresult DatabaseCore::ImportFolderSnapshot(nsIMsgFolder* source,
                                            const FolderImportSnapshot& input,
                                            FolderImportReceipt& output) {
  NS_ENSURE_ARG_POINTER(source);
  uint64_t folder;
  nsAutoCString path;
  MOZ_TRY(source->GetId(&folder));
  MOZ_TRY(source->GetPath(path));
  NS_ENSURE_TRUE(
      folder == input.identity.folderId && path == input.identity.folderPath,
      NS_ERROR_INVALID_ARG);
  nsCOMPtr<nsIFile> summary;
  MOZ_TRY(source->GetSummaryFile(getter_AddRefs(summary)));
  FolderImportAdmission admission;
#ifdef XP_WIN
  nsCOMPtr<nsIFile> store;
  MOZ_TRY(source->GetFilePath(getter_AddRefs(store)));
  NS_ENSURE_TRUE(store, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(admission.Acquire(input.identity, summary, store));
#else
  MOZ_TRY(admission.Acquire(input.identity, summary));
#endif
  return ImportFolderSnapshotFromFile(admission.Summary(), input, output);
}

nsresult DatabaseCore::ImportFolderSnapshotFromFile(
    nsIFile* source, const FolderImportSnapshot& input,
    FolderImportReceipt& output) {
  NS_ENSURE_TRUE(input.recordsComplete && input.unhandledRecords.IsEmpty(),
                 NS_ERROR_NOT_IMPLEMENTED);
  NS_ENSURE_TRUE(sInstance.get() == this && sConnection,
                 NS_ERROR_NOT_AVAILABLE);
  bool active;
  MOZ_TRY(sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  FolderImportAdmission admission;
  MOZ_TRY(admission.Acquire(input.identity, source));
  const auto& identity = admission.Identity();
  source = admission.Summary();
  MOZ_TRY(CheckFolderImportIdentity(identity));
  nsCString legacyMarker;
  MOZ_TRY(HashImportSource(source, identity, input.sourceSize, &legacyMarker));
  RefPtr<DatabaseCore> self(this);
  RefPtr<MessageDatabase> messages = mMessageDatabase;
  nsTHashMap<nsMsgKey, nsMsgKey> keys;
  nsTArray<UniquePtr<MessageDatabase::CachedMsg>> prepared;
  nsTArray<RefPtr<Message>> live;
  Maybe<FolderImportReceipt> receipt;
  MOZ_TRY(sConnection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    MOZ_TRY(CheckFolderImportIdentity(identity));
    MOZ_TRY(ReadFolderImportReceipt(identity, receipt));
    if (receipt) {
      MOZ_TRY(admission.Validate());
      return sConnection->CommitTransaction();
    }
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(GetStatement(
          "RequireEmptyImportDestination"_ns,
          "SELECT 1 FROM messages WHERE folderId = :folder UNION ALL "
          "SELECT 1 FROM staged_messages WHERE folderId = :folder UNION ALL "
          "SELECT 1 FROM offline_operations WHERE folderId = :folder LIMIT 1"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("folder"_ns, identity.folderId));
      bool occupied;
      MOZ_TRY(stmt->ExecuteStep(&occupied));
      NS_ENSURE_FALSE(occupied, NS_ERROR_ALREADY_INITIALIZED);
    }
    nsMsgKey first = 0;
    if (!input.messages.IsEmpty()) {
      MOZ_TRY(GetNextMessageKey(first));
      NS_ENSURE_TRUE(uint64_t(first) + input.messages.Length() <= nsMsgKey_None,
                     NS_ERROR_ILLEGAL_VALUE);
    }
    for (uint32_t i = 0; i < input.messages.Length(); ++i) {
      const auto& row = input.messages[i];
      NS_ENSURE_TRUE(row.sourceKey != nsMsgKey_None &&
                         !keys.Contains(row.sourceKey) &&
                         row.header.key == nsMsgKey_None,
                     NS_ERROR_INVALID_ARG);
      keys.InsertOrUpdate(row.sourceKey, first + i);
    }
    for (const auto& row : input.messages) {
      nsMsgKey key, root, parent = 0;
      NS_ENSURE_TRUE(
          keys.Get(row.sourceKey, &key) && keys.Get(row.rootSourceKey, &root),
          NS_ERROR_INVALID_ARG);
      if (row.parentSourceKey) {
        NS_ENSURE_TRUE(keys.Get(*row.parentSourceKey, &parent),
                       NS_ERROR_INVALID_ARG);
      }
      MOZ_TRY(WriteImportedMessage(identity.folderId, key, root, parent,
                                   row.header));
      auto cached = MakeUnique<MessageDatabase::CachedMsg>();
      MOZ_TRY(messages->FetchMsg(key, *cached));
      prepared.AppendElement(std::move(cached));
      live.AppendElement(new Message(key));
    }
    for (const auto& property : input.folderProperties) {
      NS_ENSURE_TRUE(!property.name.EqualsLiteral("morkMigrationSource"),
                     NS_ERROR_INVALID_ARG);
      if (property.name.EqualsLiteral("UIDValidity")) {
        NS_ENSURE_TRUE(property.integer && *property.integer >= 0 &&
                           uint64_t(*property.integer) <= UINT32_MAX,
                       NS_ERROR_INVALID_ARG);
      }
      if (property.integer) {
        MOZ_TRY(FolderDB().SetFolderProperty(identity.folderId, property.name,
                                             *property.integer));
      } else {
        MOZ_TRY(FolderDB().SetFolderProperty(identity.folderId, property.name,
                                             property.text));
      }
    }
    MOZ_TRY(FolderDB().SetFolderProperty(
        identity.folderId, "morkMigrationSource"_ns, legacyMarker));
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(GetStatement(
          "WriteFolderImportReceipt"_ns,
          "INSERT INTO folder_import_receipts(token, sourceId, "
          "databaseSourceId, "
          "sourceSha256, folderId, folderPath, sourcePath, messageCount) "
          "VALUES "
          "(:token, :source, :database, :hash, :folder, :path, :sourcePath, :count)"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindUTF8StringByName("token"_ns, identity.token));
      MOZ_TRY(stmt->BindUTF8StringByName("source"_ns, identity.sourceId));
      MOZ_TRY(
          stmt->BindUTF8StringByName("database"_ns, identity.databaseSourceId));
      MOZ_TRY(stmt->BindUTF8StringByName("hash"_ns, identity.sourceSha256));
      MOZ_TRY(stmt->BindInt64ByName("folder"_ns, identity.folderId));
      MOZ_TRY(stmt->BindUTF8StringByName("path"_ns, identity.folderPath));
      MOZ_TRY(stmt->BindStringByName("sourcePath"_ns, identity.sourcePath));
      MOZ_TRY(stmt->BindInt64ByName("count"_ns, input.messages.Length()));
      MOZ_TRY(stmt->Execute());
    }
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(GetStatement(
          "WriteFolderImportKey"_ns,
          "INSERT INTO folder_import_keys(token, sourceKey, destinationKey) "
          "VALUES (:token, :source, :destination)"_ns,
          getter_AddRefs(stmt)));
      for (const auto& row : input.messages) {
        mozStorageStatementScoper scoper(stmt);
        nsMsgKey key;
        NS_ENSURE_TRUE(keys.Get(row.sourceKey, &key), NS_ERROR_UNEXPECTED);
        MOZ_TRY(stmt->BindUTF8StringByName("token"_ns, identity.token));
        MOZ_TRY(stmt->BindInt64ByName("source"_ns, row.sourceKey));
        MOZ_TRY(stmt->BindInt64ByName("destination"_ns, key));
        MOZ_TRY(stmt->Execute());
      }
    }
    MOZ_TRY(WriteWindowsImportReceipt(sConnection, identity));
    MOZ_TRY(HashImportSource(source, identity, input.sourceSize));
    MOZ_TRY(admission.Validate());
    MOZ_TRY(ReadFolderImportReceipt(identity, receipt));
    NS_ENSURE_TRUE(receipt, NS_ERROR_UNEXPECTED);
    if (!messages->mMsgCache.reserve(messages->mMsgCache.count() +
                                     prepared.Length())) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
    return sConnection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    nsresult cleanup = sConnection->GetTransactionInProgress(&active);
    if (NS_SUCCEEDED(cleanup) && active) {
      cleanup = sConnection->RollbackTransaction();
    }
    if (NS_FAILED(cleanup)) {
      MOZ_LOG(gPanoramaLog, LogLevel::Error,
              ("Snapshot import rollback failed: 0x%08x",
               static_cast<uint32_t>(cleanup)));
    }
    return rv;
  }
  for (auto& cached : prepared) {
    nsMsgKey key = cached->key;
    auto entry = messages->mMsgCache.lookup(key);
    if (entry) {
      entry->value() = std::move(*cached);
    } else {
      messages->mMsgCache.putNewInfallible(key, std::move(*cached));
    }
  }
  output = std::move(*receipt);
  for (const auto& message : live) {
    messages->NotifyImportedMessage(message.get());
  }
  return NS_OK;
}

nsresult DatabaseCore::GetNextMessageKey(nsMsgKey& key) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(GetStatement(
      "NextMessageKey"_ns,
      "SELECT highWater, typeof(highWater) FROM message_key_allocator "
      "WHERE singleton = 1"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
  nsCString type;
  MOZ_TRY(stmt->GetUTF8String(1, type));
  int64_t highWater;
  MOZ_TRY(stmt->GetInt64(0, &highWater));
  NS_ENSURE_TRUE(type.EqualsLiteral("integer") && highWater >= 0 &&
                     highWater < nsMsgKey_None,
                 NS_ERROR_FILE_CORRUPTED);
  if (highWater == nsMsgKey_None - 1) {
    return NS_ERROR_ILLEGAL_VALUE;
  }
  key = static_cast<nsMsgKey>(highWater + 1);
  return NS_OK;
}

nsresult DatabaseCore::CreateNewDatabase() {
  MOZ_LOG(gPanoramaLog, LogLevel::Warning,
          ("database file does not exist, creating"));
  // Please keep mailnews/db/panorama/test/xpcshell/head.js in sync with
  // changes to the following code.
  nsresult rv = sConnection->ExecuteSimpleSQL(
      "CREATE TABLE folders ( \
        id INTEGER PRIMARY KEY, \
        parent INTEGER REFERENCES folders(id), \
        ordinal INTEGER DEFAULT NULL, \
        name TEXT, \
        flags INTEGER DEFAULT 0, \
        UNIQUE(parent, name) \
      );"_ns);
  NS_ENSURE_SUCCESS(rv, rv);
  rv = sConnection->ExecuteSimpleSQL(
      "CREATE TABLE folder_properties ( \
        id INTEGER REFERENCES folders(id), \
        name TEXT, \
        value ANY, \
        PRIMARY KEY(id, name) \
      );"_ns);
  NS_ENSURE_SUCCESS(rv, rv);
  rv = sConnection->ExecuteSimpleSQL(
      "CREATE TABLE messages ( \
        id INTEGER PRIMARY KEY, \
        folderId INTEGER REFERENCES folders(id), \
        threadId INTEGER REFERENCES messages(id), \
        threadParent INTEGER REFERENCES messages(id), \
        messageId TEXT, \
        date INTEGER, \
        sender TEXT, \
        recipients TEXT, \
        ccList TEXT, \
        bccList TEXT, \
        subject TEXT, \
        flags INTEGER, \
        tags TEXT, \
        priority INTEGER \
      );"_ns);
  NS_ENSURE_SUCCESS(rv, rv);
  rv = sConnection->ExecuteSimpleSQL(
      "CREATE INDEX messages_folderId ON messages(folderId);"_ns);
  NS_ENSURE_SUCCESS(rv, rv);
  rv = sConnection->ExecuteSimpleSQL(
      "CREATE INDEX messages_threadId ON messages(threadId);"_ns);
  NS_ENSURE_SUCCESS(rv, rv);
  rv = sConnection->ExecuteSimpleSQL(
      "CREATE INDEX messages_date ON messages(date);"_ns);
  NS_ENSURE_SUCCESS(rv, rv);
  rv = sConnection->ExecuteSimpleSQL(
      "CREATE INDEX messages_flags ON messages(flags);"_ns);
  NS_ENSURE_SUCCESS(rv, rv);
  rv = sConnection->ExecuteSimpleSQL(
      "CREATE TABLE message_properties ( \
        id INTEGER REFERENCES messages(id), \
        name TEXT, \
        value ANY, \
        PRIMARY KEY(id, name) \
      );"_ns);
  NS_ENSURE_SUCCESS(rv, rv);
  rv = sConnection->ExecuteSimpleSQL(
      "CREATE TABLE virtualFolder_folders ( \
        virtualFolderId INTEGER REFERENCES folders(id), \
        searchFolderId INTEGER REFERENCES folders(id) \
      );"_ns);
  NS_ENSURE_SUCCESS(rv, rv);
  rv = sConnection->ExecuteSimpleSQL(
      "CREATE TABLE search_folder_hits ( \
        folder_id INTEGER REFERENCES folders(id), \
        message_id INTEGER REFERENCES messages(id), \
        PRIMARY KEY(folder_id, message_id) \
      )"_ns);
  NS_ENSURE_SUCCESS(rv, rv);
  rv = sConnection->ExecuteSimpleSQL(
      "CREATE INDEX search_folder_hits_folder_id ON search_folder_hits(folder_id);"_ns);
  NS_ENSURE_SUCCESS(rv, rv);

  return NS_OK;
}

NS_IMETHODIMP DatabaseCore::MigrateVirtualFolders() {
  if (!sDatabaseIsNew) {
    // Only do this if we created the database in this session.
    return NS_OK;
  }

  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("Migrating virtual folders"));

  // Read virtualFolders.dat into an array of structs containing the info.

  struct VirtualFolderDef {
    nsCString uri;
    nsCString scope;
    nsCString terms;
    bool searchOnline;
  };

  nsTArray<VirtualFolderDef> defs;

  nsCOMPtr<nsIFile> virtualFoldersFile;
  nsresult rv = NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR,
                                       getter_AddRefs(virtualFoldersFile));
  NS_ENSURE_SUCCESS(rv, rv);

  rv = virtualFoldersFile->Append(u"virtualFolders.dat"_ns);
  NS_ENSURE_SUCCESS(rv, rv);

  bool exists;
  rv = virtualFoldersFile->Exists(&exists);
  NS_ENSURE_SUCCESS(rv, rv);
  if (!exists) {
    return NS_OK;
  }

  nsCOMPtr<nsIInputStream> stream;
  rv = NS_NewLocalFileInputStream(getter_AddRefs(stream), virtualFoldersFile);
  NS_ENSURE_SUCCESS(rv, rv);
  nsCOMPtr<nsILineInputStream> lineStream = do_QueryInterface(stream);
  MOZ_ASSERT(lineStream);

  bool hasMoreLines = true;
  nsAutoCString buffer;
  while (hasMoreLines &&
         NS_SUCCEEDED(lineStream->ReadLine(buffer, &hasMoreLines))) {
    if (buffer.IsEmpty()) {
      break;
    }
    if (StringBeginsWith(buffer, "version="_ns)) {
      continue;
    }
    if (StringBeginsWith(buffer, "uri="_ns)) {
      buffer.Cut(0, 4);
      VirtualFolderDef def;
      def.uri = buffer;
      defs.AppendElement(def);
      continue;
    }
    if (StringBeginsWith(buffer, "scope="_ns)) {
      buffer.Cut(0, 6);
      defs.LastElement().scope = buffer;
    } else if (StringBeginsWith(buffer, "terms="_ns)) {
      buffer.Cut(0, 6);
      defs.LastElement().terms = buffer;
    } else if (StringBeginsWith(buffer, "searchOnline="_ns)) {
      buffer.Cut(0, 13);
      defs.LastElement().searchOnline = buffer.EqualsLiteral("true");
    }
  }

  // Now that we have all of the info, loop over the array and insert the
  // folders we want to keep.

  for (VirtualFolderDef def : defs) {
    if (StringBeginsWith(def.uri, "mailbox://nobody@smart%20mailboxes/"_ns)) {
      // We don't want to copy the unified folders or tags folders.
      continue;
    }

    nsCOMPtr<nsIMsgFolder> virtualFolder;
    // The virtual folder might exist already, which would be weird but it could
    // happen.
    GetExistingFolder(def.uri, getter_AddRefs(virtualFolder));

    if (!virtualFolder) {
      nsCOMPtr<nsIMsgFolder> parent;
      nsAutoCString name;
      int32_t lastSlash = def.uri.RFindChar('/');

      // Find the parent folder.

      rv = GetExistingFolder(Substring(def.uri, 0, lastSlash),
                             getter_AddRefs(parent));
      if (NS_FAILED(rv)) {
        MOZ_LOG(
            gPanoramaLog, LogLevel::Warning,
            ("parent folder of %s not found, can't create the virtual folder",
             def.uri.get()));
        continue;
      }

      // Create the virtual folder.

      MsgUnescapeString(
          Substring(def.uri, lastSlash + 1),
          nsINetUtil::ESCAPE_URL_FILE_BASENAME | nsINetUtil::ESCAPE_URL_FORCED,
          name);
      rv = parent->AddSubfolder(name, getter_AddRefs(virtualFolder));
      if (NS_FAILED(rv)) {
        MOZ_LOG(gPanoramaLog, LogLevel::Warning,
                ("failed to create %s", def.uri.get()));
        continue;
      }
    }

    // Add the virtual folder info to the database.

    virtualFolder->SetFlag(nsMsgFolderFlags::Virtual);

    nsTArray<nsCString> folderUris;
    ParseString(def.scope, '|', folderUris);
    nsTArray<uint64_t> searchFolderIds;
    for (auto folderUri : folderUris) {
      nsCOMPtr<nsIMsgFolder> searchFolder;
      if (NS_SUCCEEDED(
              GetExistingFolder(folderUri, getter_AddRefs(searchFolder)))) {
        uint64_t searchFolderId;
        searchFolder->GetId(&searchFolderId);
        searchFolderIds.AppendElement(searchFolderId);
      }
    }

    uint64_t virtualFolderId;
    virtualFolder->GetId(&virtualFolderId);
    mFolderDatabase->SetVirtualFolderFolders(virtualFolderId, searchFolderIds);
    mFolderDatabase->SetFolderProperty(virtualFolderId, "searchStr"_ns,
                                       def.terms);
    mFolderDatabase->SetFolderProperty(virtualFolderId, "searchOnline"_ns,
                                       def.searchOnline);
  }

  return NS_OK;
}

/**
 * Create and cache an SQL statement.
 */
/* static */
nsresult DatabaseCore::GetStatement(const nsACString& aName,
                                    const nsACString& aSQL,
                                    mozIStorageStatement** aStmt) {
  NS_ENSURE_ARG_POINTER(aStmt);

  nsresult rv = EnsureConnection();
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<mozIStorageStatement> stmt;
  if (sStatements.Get(aName, &stmt)) {
    NS_IF_ADDREF(*aStmt = stmt);
    return NS_OK;
  }

  rv = sConnection->CreateStatement(aSQL, getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  sStatements.InsertOrUpdate(aName, stmt);
  NS_IF_ADDREF(*aStmt = stmt);

  return NS_OK;
}

/**
 * Functions for SQLite savepoints (https://sqlite.org/lang_savepoint.html).
 */

/**
 * Checks that the given string only contains a-z characters, for protection
 * against SQL injection. You should never call these savepoint functions with
 * a name that isn't hard-coded, but mistakes happen and that's how we get
 * security vulnerabilities.
 */
void assertStringIsSafeForSQL(const nsACString& str) {
  for (uint32_t i = 0; i < str.Length(); i++) {
    char c = str.CharAt(i);
    if (c < 'a' || c > 'z') {
      MOZ_CRASH(
          "Only a-z characters are allowed here. I see you, Bobby Tables!");
    }
  }
}

/* static */
nsresult DatabaseCore::CreateSavepoint(const nsACString& name) {
  assertStringIsSafeForSQL(name);
  return sConnection->ExecuteSimpleSQL("SAVEPOINT "_ns + name);
}

/* static */
nsresult DatabaseCore::ReleaseSavepoint(const nsACString& name) {
  assertStringIsSafeForSQL(name);
  return sConnection->ExecuteSimpleSQL("RELEASE "_ns + name);
}

/* static */
nsresult DatabaseCore::RollbackToSavepoint(const nsACString& name) {
  assertStringIsSafeForSQL(name);
  return sConnection->ExecuteSimpleSQL("ROLLBACK TO "_ns + name);
}

/* static */
nsresult DatabaseCore::RetireAccountRoot(uint64_t folderId,
                                         const nsACString& serverKey,
                                         const nsACString& databaseSourceId) {
  NS_ENSURE_TRUE(sInstance && sConnection && sInstance->mFolderDatabase,
                 NS_ERROR_NOT_AVAILABLE);
  nsCString currentSourceId;
  MOZ_TRY(sInstance->GetSourceId(currentSourceId));
  NS_ENSURE_TRUE(currentSourceId == databaseSourceId, NS_ERROR_NOT_AVAILABLE);
  return sInstance->mFolderDatabase->RetireRoot(folderId, serverKey);
}

NS_IMETHODIMP
DatabaseCore::GetFolderDB(nsIFolderDatabase** folderDatabase) {
  NS_IF_ADDREF(*folderDatabase = mFolderDatabase);
  return NS_OK;
}

NS_IMETHODIMP
DatabaseCore::GetMessageDB(nsIMessageDatabase** messageDatabase) {
  NS_IF_ADDREF(*messageDatabase = mMessageDatabase);
  return NS_OK;
}

/**
 * Folder migration happens in four steps:
 *
 * 1. The existing summary file is opened and the messages are enumerated,
 *    collecting all of the data we need to copy into the new database. This
 *    happens on the main thread, but after every 100 messages we jump to the
 *    end of the main thread event queue so that the UI remains responsive
 *    (except while opening the summary file, which could take some time).
 *
 * 2. The messages are asynchronously inserted into the messages table.
 *    The keys of the inserted messages are collected.
 *
 * 3. The threadId and threadParent columns of all new messages are updated.
 *
 * 4. Message properties are combined with the message keys and asynchronously
 *    inserted into the message_properties table.
 *
 * This object is an nsIRunnable that step 1 can keep pushing to the back of
 * the main thread event queue, and a mozIStorageStatementCallback to capture
 * the results of the SQL operations.
 */

class FolderMigrator final : public nsIRunnable, mozIStorageStatementCallback {
 public:
  FolderMigrator() {}

  NS_DECL_ISUPPORTS

  uint64_t mDestFolderId;
  nsAutoCString mDestFolderPath;
  nsCOMPtr<nsIFile> mSummaryFile;
  nsCString mSourceHash;
  bool mAlreadyMigrated = false;
  nsMainThreadPtrHandle<Promise> mPromiseHolder;

  struct Property {
    nsCString name;
    nsCString value;
    Maybe<uint32_t> integer;
  };
  struct MessageData {
    nsTArray<nsCString> references;
    nsTArray<Property> properties;
    nsMsgKey oldMessageKey;
    nsCString storeToken;
    uint32_t messageSize;
    nsMsgKey threadId;
    nsMsgKey threadParent;
  };
  nsCOMPtr<nsIMsgDatabase> mDB;
  nsCOMPtr<nsIMsgEnumerator> mEnumerator;
  nsTArray<MessageData> mMessageData;
  nsTArray<int64_t> mNewMessageKeys;
  nsTHashMap<nsMsgKey, int64_t> mMessageKeyMap;

  nsCOMPtr<nsIMimeConverter> mMimeConverter;

  nsCOMPtr<mozIStorageStatement> mStmt;
  nsCOMPtr<mozIStorageBindingParamsArray> mParamsArray;
  uint32_t mCurrentStep = 0;
  bool mSavepointActive = false;
  nsCString mErrorMessage;

  nsresult SetupAndRun(nsIMsgFolder* srcFolder, RefPtr<Promise> promise) {
    MOZ_TRY(DatabaseCore::EnsureConnection());
    MOZ_TRY(RequireIdleConnection());
    MOZ_TRY(srcFolder->GetId(&mDestFolderId));
    NS_ENSURE_TRUE(mDestFolderId, NS_ERROR_INVALID_ARG);
    MOZ_TRY(srcFolder->GetPath(mDestFolderPath));
    mPromiseHolder = new nsMainThreadPtrHolder<Promise>(__func__, promise);

    MOZ_LOG(gPanoramaLog, LogLevel::Info,
            ("migrating %s to the new database", mDestFolderPath.get()));

    MOZ_TRY(srcFolder->GetSummaryFile(getter_AddRefs(mSummaryFile)));
    MOZ_TRY(HashSource(mSourceHash));
    MOZ_TRY(CheckCompletion());
    if (mAlreadyMigrated) {
      promise->MaybeResolveWithUndefined();
      return NS_OK;
    }

    mDB = do_CreateInstance("@mozilla.org/nsMsgDatabase/msgDB-mailbox");
    NS_ENSURE_TRUE(mDB, NS_ERROR_NOT_AVAILABLE);
    nsresult rv = mDB->OpenFromFile(mSummaryFile);
    NS_ENSURE_SUCCESS(rv, rv);

    rv = mDB->EnumerateMessages(getter_AddRefs(mEnumerator));
    NS_ENSURE_SUCCESS(rv, rv);

    PROFILER_MARKER_TEXT("Folder Migration", MAILNEWS,
                         MarkerOptions(MarkerTiming::IntervalStart()),
                         mDestFolderPath);
    bool hasMore;
    MOZ_TRY(mEnumerator->HasMoreElements(&hasMore));
    if (!hasMore) {
      MOZ_TRY(mDB->Close(false));
      mDB = nullptr;
      Complete(true);
      return NS_OK;
    }

    mMimeConverter = mozilla::components::MimeConverter::Service();
    NS_ENSURE_TRUE(mMimeConverter, NS_ERROR_FAILURE);

    rv = DatabaseCore::GetStatement("AddMigratedMessage"_ns,
                                    "INSERT INTO messages ( \
                                  id, folderId, messageId, date, sender, recipients, ccList, bccList, subject, flags, tags \
                                ) VALUES ( \
                                  (SELECT highWater + 1 FROM message_key_allocator WHERE singleton = 1), :folderId, :messageId, :date, :sender, :recipients, :ccList, :bccList, :subject, :flags, :tags \
                                ) RETURNING "_ns MESSAGE_SQL_FIELDS,
                                    getter_AddRefs(mStmt));
    NS_ENSURE_SUCCESS(rv, rv);
    rv = mStmt->NewBindingParamsArray(getter_AddRefs(mParamsArray));
    NS_ENSURE_SUCCESS(rv, rv);

    MOZ_TRY(NS_DispatchToMainThread(this));
    return NS_OK;
  }

  void Complete(bool success) {
    PROFILER_MARKER_TEXT("Folder Migration", MAILNEWS,
                         MarkerOptions(MarkerTiming::IntervalEnd()),
                         mDestFolderPath);
    nsresult rv = NS_OK;
    if (success && !mAlreadyMigrated) {
      nsCString sourceHash;
      rv = HashSource(sourceHash);
      if (NS_SUCCEEDED(rv) && !sourceHash.Equals(mSourceHash)) {
        rv = NS_ERROR_ALREADY_INITIALIZED;
      }
      if (NS_SUCCEEDED(rv) && !mSavepointActive) {
        rv = StartImport();
      }
      if (NS_SUCCEEDED(rv) && !mAlreadyMigrated) {
        rv = WriteCompletion();
      }
    }
    if (mSavepointActive) {
      if (!DatabaseCore::sConnection) {
        mPromiseHolder.get()->MaybeReject(NS_ERROR_NOT_AVAILABLE);
        return;
      }
      if (success && NS_SUCCEEDED(rv)) {
        rv = DatabaseCore::ReleaseSavepoint("foldermigration"_ns);
      }
      if (!success || NS_FAILED(rv)) {
        nsresult cleanupRv =
            DatabaseCore::RollbackToSavepoint("foldermigration"_ns);
        if (NS_SUCCEEDED(cleanupRv)) {
          cleanupRv = DatabaseCore::ReleaseSavepoint("foldermigration"_ns);
        }
        if (NS_FAILED(cleanupRv)) {
          // Cleanup errors take precedence when savepoint closure is uncertain.
          mPromiseHolder.get()->MaybeReject(cleanupRv);
          return;
        }
      }
      mSavepointActive = false;
    }

    if (NS_FAILED(rv)) {
      mPromiseHolder.get()->MaybeReject(rv);
    } else if (success) {
      MOZ_LOG(gPanoramaLog, LogLevel::Info, ("migration complete"));
      mPromiseHolder.get()->MaybeResolveWithUndefined();
    } else {
      MOZ_LOG(gPanoramaLog, LogLevel::Info, ("migration failed"));
      if (mErrorMessage.IsEmpty()) {
        mPromiseHolder.get()->MaybeRejectWithUnknownError(
            "Folder migration failed.");
      } else {
        mPromiseHolder.get()->MaybeRejectWithUnknownError(
            "Folder migration SQL failed: "_ns + mErrorMessage);
      }
    }
  }

  NS_IMETHOD Run() override {
    auto guard = mozilla::MakeScopeExit([&] { Complete(false); });

    mCurrentStep = 1;
    bool hasMore;
    uint64_t count = 0;
    while (true) {
      MOZ_TRY(mEnumerator->HasMoreElements(&hasMore));
      if (!hasMore) {
        break;
      }
      nsCOMPtr<nsIMsgDBHdr> message;
      MOZ_TRY(mEnumerator->GetNext(getter_AddRefs(message)));
      NS_ENSURE_TRUE(message, NS_ERROR_UNEXPECTED);

      // Collect what we need to insert into the messages table.

      nsAutoCString messageId;
      MOZ_TRY(message->GetMessageId(messageId));
      PRTime date;
      MOZ_TRY(message->GetDate(&date));
      nsAutoCString sender;
      MOZ_TRY(message->GetAuthor(sender));
      nsAutoCString recipients;
      MOZ_TRY(message->GetRecipients(recipients));
      nsAutoCString ccList;
      MOZ_TRY(message->GetCcList(ccList));
      nsAutoCString bccList;
      MOZ_TRY(message->GetBccList(bccList));
      nsAutoCString subject;
      MOZ_TRY(message->GetSubject(subject));
      uint32_t flags;
      MOZ_TRY(message->GetFlags(&flags));
      nsAutoCString tags;
      MOZ_TRY(message->GetStringProperty("keywords", tags));
      nsAutoCString charset;
      MOZ_TRY(message->GetCharset(charset));

      MOZ_TRY(mMimeConverter->DecodeMimeHeaderToUTF8(sender, charset.get(),
                                                     true, true, sender));
      MOZ_TRY(mMimeConverter->DecodeMimeHeaderToUTF8(recipients, charset.get(),
                                                     true, true, recipients));
      MOZ_TRY(mMimeConverter->DecodeMimeHeaderToUTF8(ccList, charset.get(),
                                                     true, true, ccList));
      MOZ_TRY(mMimeConverter->DecodeMimeHeaderToUTF8(bccList, charset.get(),
                                                     true, true, bccList));
      MOZ_TRY(mMimeConverter->DecodeMimeHeaderToUTF8(subject, charset.get(),
                                                     true, true, subject));

      nsCOMPtr<mozIStorageBindingParams> params;
      MOZ_TRY(mParamsArray->NewBindingParams(getter_AddRefs(params)));

      MOZ_TRY(params->BindInt64ByName("folderId"_ns, mDestFolderId));
      MOZ_TRY(params->BindUTF8StringByName(
          "messageId"_ns, MOZ_TRY(DatabaseUtils::Normalize(messageId))));
      MOZ_TRY(params->BindInt64ByName("date"_ns, date));
      MOZ_TRY(params->BindUTF8StringByName(
          "sender"_ns, MOZ_TRY(DatabaseUtils::Normalize(sender))));
      MOZ_TRY(params->BindUTF8StringByName(
          "recipients"_ns, MOZ_TRY(DatabaseUtils::Normalize(recipients))));
      MOZ_TRY(params->BindUTF8StringByName(
          "ccList"_ns, MOZ_TRY(DatabaseUtils::Normalize(ccList))));
      MOZ_TRY(params->BindUTF8StringByName(
          "bccList"_ns, MOZ_TRY(DatabaseUtils::Normalize(bccList))));
      MOZ_TRY(params->BindUTF8StringByName(
          "subject"_ns, MOZ_TRY(DatabaseUtils::Normalize(subject))));
      MOZ_TRY(params->BindInt64ByName("flags"_ns, flags));
      MOZ_TRY(params->BindUTF8StringByName(
          "tags"_ns, MOZ_TRY(DatabaseUtils::Normalize(tags))));

      // Collect what we need to insert into the message_properties table, and
      // the things we need to update in the messages table once we have the
      // new keys of the messages.

      MessageData data;
      uint16_t referenceCount;
      MOZ_TRY(message->GetNumReferences(&referenceCount));
      for (uint16_t i = 0; i < referenceCount; ++i) {
        nsCString reference;
        MOZ_TRY(message->GetStringReference(i, reference));
        data.references.AppendElement(reference);
      }
      MOZ_TRY(message->GetMessageKey(&data.oldMessageKey));
      MOZ_TRY(message->GetThreadId(&data.threadId));
      if (data.threadId == 0xfffffffe) {
        // The first thread was always stored as -2.
        data.threadId = 1;
      }
      MOZ_TRY(message->GetThreadParent(&data.threadParent));
      if (data.threadParent == 0xffffffff) {
        // No parent.
        data.threadParent = 0;
      }
      MOZ_TRY(message->GetStoreToken(data.storeToken));
      MOZ_TRY(message->GetMessageSize(&data.messageSize));
      nsTArray<nsCString> names;
      MOZ_TRY(message->GetProperties(names));
      for (const auto& name : names) {
        // These two structural values are bound separately below.
        if (name.EqualsLiteral("storeToken") ||
            name.EqualsLiteral("messageSize")) {
          continue;
        }
        auto& property = *data.properties.AppendElement();
        property.name = name;
        if (name.EqualsLiteral("lineCount") ||
            name.EqualsLiteral("offlineMessageSize")) {
          uint32_t value;
          MOZ_TRY(message->GetUint32Property(name.get(), &value));
          property.integer = Some(value);
        } else {
          // The legacy getter returns exact text for every unknown name,
          // including present-empty cells and hex text from uint32 writers.
          MOZ_TRY(message->GetStringProperty(name.get(), property.value));
        }
      }
      mMessageData.AppendElement(std::move(data));

      MOZ_TRY(mParamsArray->AddParams(params));

      if (++count == 100) {
        break;
      }
    }

    MOZ_TRY(mEnumerator->HasMoreElements(&hasMore));
    if (hasMore) {
      // Push the remaining work to the end of the event loop.
      MOZ_TRY(NS_DispatchToMainThread(this));
    } else {
      MOZ_TRY(mDB->ClearCachedHdrs());
      MOZ_TRY(mDB->Close(false));
      mDB = nullptr;

      uint32_t length;
      MOZ_TRY(mParamsArray->GetLength(&length));
      if (length > 0) {
        // Execute the query.
        mCurrentStep = 2;
        MOZ_TRY(StartImport());
        if (mAlreadyMigrated) {
          guard.release();
          Complete(true);
          return NS_OK;
        }
        MOZ_TRY(mStmt->BindParameters(mParamsArray));
        nsCOMPtr<mozIStoragePendingStatement> unused;
        MOZ_TRY(mStmt->ExecuteAsync(this, getter_AddRefs(unused)));
      } else {
        // No messages to migrate. Stop here.
        Complete(true);
      }
    }

    guard.release();
    return NS_OK;
  }

  NS_IMETHOD HandleError(mozIStorageError* error) override {
    error->GetMessage(mErrorMessage);
    MOZ_LOG(gPanoramaLog, LogLevel::Error,
            ("migration failed, the database said: %s", mErrorMessage.get()));
    return NS_OK;
  }
  NS_IMETHOD HandleResult(mozIStorageResultSet* resultSet) override {
    if (mCurrentStep == 2) {
      // Collect the keys of inserted messages.
      nsCOMPtr<mozIStorageRow> row;
      while (NS_SUCCEEDED(resultSet->GetNextRow(getter_AddRefs(row))) && row) {
        mNewMessageKeys.AppendElement(row->AsInt64(0));
      }
    }
    return NS_OK;
  }
  NS_IMETHOD HandleCompletion(uint16_t reason) override {
    if (reason != mozIStorageStatementCallback::REASON_FINISHED) {
      Complete(false);
      return NS_OK;
    }
    auto guard = mozilla::MakeScopeExit([&] { Complete(false); });
    if (mCurrentStep == 2) {
      mCurrentStep = 3;
      NS_ENSURE_TRUE(mNewMessageKeys.Length() == mMessageData.Length(),
                     NS_ERROR_UNEXPECTED);

      // Update threading data.

      // Map message keys in the old DB to row IDs in the new DB.
      for (size_t i = 0; i < mNewMessageKeys.Length(); i++) {
        mMessageKeyMap.InsertOrUpdate(mMessageData[i].oldMessageKey,
                                      mNewMessageKeys[i]);
      }

      // Duplicate statement! Also in MessageDatabase::AddMessage.
      MOZ_TRY(DatabaseCore::GetStatement(
          "UpdateThreadInfo"_ns,
          "UPDATE messages SET threadId = :threadId, threadParent = :threadParent WHERE id = :id"_ns,
          getter_AddRefs(mStmt)));
      MOZ_TRY(mStmt->NewBindingParamsArray(getter_AddRefs(mParamsArray)));

      for (size_t i = 0; i < mNewMessageKeys.Length(); i++) {
        nsCOMPtr<mozIStorageBindingParams> params;
        MOZ_TRY(mParamsArray->NewBindingParams(getter_AddRefs(params)));
        MOZ_TRY(params->BindInt64ByName("id"_ns, mNewMessageKeys[i]));
        int64_t newThreadId = 0;
        int64_t newThreadParent = 0;
        if (mMessageKeyMap.Get(mMessageData[i].threadId, &newThreadId) &&
            (mMessageData[i].threadParent == 0 ||
             mMessageKeyMap.Get(mMessageData[i].threadParent,
                                &newThreadParent))) {
          MOZ_TRY(params->BindInt64ByName("threadId"_ns, newThreadId));
          MOZ_TRY(params->BindInt64ByName("threadParent"_ns, newThreadParent));
          MOZ_TRY(mParamsArray->AddParams(params));
        }
      }

      uint32_t length;
      MOZ_TRY(mParamsArray->GetLength(&length));
      if (length > 0) {
        MOZ_TRY(mStmt->BindParameters(mParamsArray));
        nsCOMPtr<mozIStoragePendingStatement> unused;
        MOZ_TRY(mStmt->ExecuteAsync(this, getter_AddRefs(unused)));
        guard.release();
        return NS_OK;
      }
    }
    if (mCurrentStep == 3) {
      mCurrentStep = 4;
      // Now pair the message keys with the properties collected in step 1,
      // and insert them into the database.

      MOZ_TRY(DatabaseCore::GetStatement(
          "SetMessageProperty"_ns,
          "REPLACE INTO message_properties (id, name, value) VALUES (:id, :name, :value)"_ns,
          getter_AddRefs(mStmt)));
      MOZ_TRY(mStmt->NewBindingParamsArray(getter_AddRefs(mParamsArray)));

      for (size_t i = 0; i < mMessageData.Length(); i++) {
        for (const auto& property : mMessageData[i].properties) {
          nsCOMPtr<mozIStorageBindingParams> params;
          MOZ_TRY(mParamsArray->NewBindingParams(getter_AddRefs(params)));
          MOZ_TRY(params->BindInt64ByName("id"_ns, mNewMessageKeys[i]));
          MOZ_TRY(params->BindUTF8StringByName("name"_ns, property.name));
          if (property.integer) {
            MOZ_TRY(params->BindInt64ByName("value"_ns, *property.integer));
          } else {
            MOZ_TRY(params->BindUTF8StringByName("value"_ns, property.value));
          }
          MOZ_TRY(mParamsArray->AddParams(params));
        }
        if (!mMessageData[i].storeToken.IsEmpty()) {
          nsCOMPtr<mozIStorageBindingParams> params;
          MOZ_TRY(mParamsArray->NewBindingParams(getter_AddRefs(params)));
          MOZ_TRY(params->BindInt64ByName("id"_ns, mNewMessageKeys[i]));
          MOZ_TRY(params->BindUTF8StringByName("name"_ns, "storeToken"_ns));
          MOZ_TRY(params->BindUTF8StringByName("value"_ns,
                                               mMessageData[i].storeToken));
          MOZ_TRY(mParamsArray->AddParams(params));
        }

        if (mMessageData[i].messageSize != 0) {
          nsCOMPtr<mozIStorageBindingParams> params;
          MOZ_TRY(mParamsArray->NewBindingParams(getter_AddRefs(params)));
          MOZ_TRY(params->BindInt64ByName("id"_ns, mNewMessageKeys[i]));
          MOZ_TRY(params->BindUTF8StringByName("name"_ns, "messageSize"_ns));
          MOZ_TRY(
              params->BindInt64ByName("value"_ns, mMessageData[i].messageSize));
          MOZ_TRY(mParamsArray->AddParams(params));
        }
      }

      uint32_t length;
      MOZ_TRY(mParamsArray->GetLength(&length));
      if (length > 0) {
        MOZ_TRY(mStmt->BindParameters(mParamsArray));
        nsCOMPtr<mozIStoragePendingStatement> unused;
        MOZ_TRY(mStmt->ExecuteAsync(this, getter_AddRefs(unused)));
        guard.release();
        return NS_OK;
      }
    }

    // The migration owns the savepoint until Complete ends it.
    RefPtr<DatabaseCore> core = DatabaseCore::sInstance;
    NS_ENSURE_TRUE(core && core->mMessageDatabase, NS_ERROR_NOT_AVAILABLE);
    NS_ENSURE_TRUE(mNewMessageKeys.Length() == mMessageData.Length(),
                   NS_ERROR_UNEXPECTED);
    for (size_t i = 0; i < mMessageData.Length(); ++i) {
      NS_ENSURE_TRUE(mNewMessageKeys[i] > 0 &&
                         uint64_t(mNewMessageKeys[i]) < nsMsgKey_None,
                     NS_ERROR_ILLEGAL_VALUE);
      MOZ_TRY(core->MessageDB().WriteMessageReferencesInTransaction(
          static_cast<nsMsgKey>(mNewMessageKeys[i]),
          mMessageData[i].references));
    }

    // Step 3 had no properties to insert, or step 4 is complete.
    guard.release();
    Complete(true);
    return NS_OK;
  }

  // Keep the completion receipt in existing folder properties.
  nsresult CheckCompletion() {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "GetMorkMigrationSource"_ns,
        "SELECT value FROM folder_properties "
        "WHERE id = :id AND name = 'morkMigrationSource'"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scoper(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, mDestFolderId));
    bool exists;
    MOZ_TRY(stmt->ExecuteStep(&exists));
    if (!exists) {
      mAlreadyMigrated = false;
      return NS_OK;
    }
    nsCString storedHash;
    MOZ_TRY(stmt->GetUTF8String(0, storedHash));
    NS_ENSURE_TRUE(storedHash.Equals(mSourceHash),
                   NS_ERROR_ALREADY_INITIALIZED);
    mAlreadyMigrated = true;
    return NS_OK;
  }

  nsresult RequireIdleConnection() {
    NS_ENSURE_TRUE(DatabaseCore::sConnection, NS_ERROR_NOT_AVAILABLE);
    bool active;
    MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
    return active ? NS_ERROR_IN_PROGRESS : NS_OK;
  }

  nsresult StartImport() {
    MOZ_TRY(RequireIdleConnection());
    // Another import may have finished while source enumeration yielded.
    MOZ_TRY(CheckCompletion());
    if (!mAlreadyMigrated) {
      MOZ_TRY(DatabaseCore::CreateSavepoint("foldermigration"_ns));
      mSavepointActive = true;
    }
    return NS_OK;
  }

  nsresult HashSource(nsACString& result) {
    int64_t size;
    MOZ_TRY(mSummaryFile->GetFileSize(&size));
    NS_ENSURE_TRUE(size >= 0 && uint64_t(size) < UINT32_MAX,
                   NS_ERROR_FILE_TOO_BIG);
    nsCOMPtr<nsIInputStream> stream;
    MOZ_TRY(NS_NewLocalFileInputStream(getter_AddRefs(stream), mSummaryFile));
    auto close = mozilla::MakeScopeExit([&] { stream->Close(); });
    nsCOMPtr<nsICryptoHash> hash;
    MOZ_TRY(NS_NewCryptoHash(nsICryptoHash::SHA256, getter_AddRefs(hash)));
    MOZ_TRY(hash->UpdateFromStream(stream, UINT32_MAX));
    MOZ_TRY(stream->Close());
    close.release();
    nsCString digest;
    MOZ_TRY(hash->Finish(true, digest));
    result.Assign("v1:sha256:"_ns);
    result.Append(digest);
    return NS_OK;
  }

  nsresult WriteCompletion() {
    MOZ_ASSERT(mSavepointActive);
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "SetMorkMigrationSource"_ns,
        "INSERT INTO folder_properties (id, name, value) "
        "VALUES (:id, 'morkMigrationSource', :source)"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scoper(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, mDestFolderId));
    MOZ_TRY(stmt->BindUTF8StringByName("source"_ns, mSourceHash));
    return stmt->Execute();
  }

 private:
  ~FolderMigrator() = default;
};
NS_IMPL_ISUPPORTS(FolderMigrator, nsIRunnable, mozIStorageStatementCallback)

namespace {

nsresult ImportMember(JSContext* cx, JS::Handle<JSObject*> object,
                      const char* name, JS::MutableHandle<JS::Value> value,
                      bool optional = false) {
  bool present;
  if (!JS_HasOwnProperty(cx, object, name, &present)) {
    return NS_ERROR_FAILURE;
  }
  NS_ENSURE_TRUE(present || optional, NS_ERROR_INVALID_ARG);
  if (!present) {
    value.setUndefined();
    return NS_OK;
  }
  return JS_GetProperty(cx, object, name, value) ? NS_OK : NS_ERROR_FAILURE;
}

nsresult ImportText(JSContext* cx, JS::Handle<JS::Value> value,
                    nsACString& output) {
  NS_ENSURE_TRUE(value.isString(), NS_ERROR_INVALID_ARG);
  nsAutoJSString text;
  NS_ENSURE_TRUE(text.init(cx, value), NS_ERROR_OUT_OF_MEMORY);
  for (uint32_t i = 0; i < text.Length(); ++i) {
    char16_t c = text[i];
    if (c >= 0xd800 && c <= 0xdbff) {
      NS_ENSURE_TRUE(
          ++i < text.Length() && text[i] >= 0xdc00 && text[i] <= 0xdfff,
          NS_ERROR_INVALID_ARG);
    } else {
      NS_ENSURE_FALSE(c >= 0xdc00 && c <= 0xdfff, NS_ERROR_INVALID_ARG);
    }
  }
  CopyUTF16toUTF8(text, output);
  return NS_OK;
}

nsresult ImportNumber(JS::Handle<JS::Value> value, double minimum,
                      double maximum, int64_t& output) {
  NS_ENSURE_TRUE(value.isNumber(), NS_ERROR_INVALID_ARG);
  double number = value.toNumber();
  NS_ENSURE_TRUE(std::isfinite(number) && std::trunc(number) == number &&
                     number >= minimum && number <= maximum,
                 NS_ERROR_INVALID_ARG);
  output = static_cast<int64_t>(number);
  return NS_OK;
}

nsresult ImportArray(JSContext* cx, JS::Handle<JS::Value> value,
                     JS::MutableHandle<JSObject*> array, uint32_t& length) {
  bool isArray;
  if (!JS::IsArrayObject(cx, value, &isArray)) {
    return NS_ERROR_FAILURE;
  }
  NS_ENSURE_TRUE(isArray, NS_ERROR_INVALID_ARG);
  array.set(&value.toObject());
  return JS::GetArrayLength(cx, array, &length) ? NS_OK : NS_ERROR_FAILURE;
}

nsresult ImportHeader(JSContext* cx, JS::Handle<JS::Value> value,
                      RawHdr& header) {
  NS_ENSURE_TRUE(value.isObject(), NS_ERROR_INVALID_ARG);
  JS::Rooted<JSObject*> object(cx, &value.toObject());
  JS::Rooted<JS::Value> field(cx);
  bool hasKey;
  NS_ENSURE_TRUE(JS_HasOwnProperty(cx, object, "key", &hasKey),
                 NS_ERROR_FAILURE);
  NS_ENSURE_FALSE(hasKey, NS_ERROR_INVALID_ARG);
  for (auto pair : {std::pair{"messageId", &header.messageId},
                    {"sender", &header.sender},
                    {"recipients", &header.recipients},
                    {"ccList", &header.ccList},
                    {"bccList", &header.bccList},
                    {"subject", &header.subject},
                    {"keywords", &header.keywords},
                    {"charset", &header.charset},
                    {"accountKey", &header.accountKey}}) {
    MOZ_TRY(ImportMember(cx, object, pair.first, &field));
    MOZ_TRY(ImportText(cx, field, *pair.second));
  }
  MOZ_TRY(ImportMember(cx, object, "replyTo", &field, true));
  if (!field.isUndefined()) {
    MOZ_TRY(ImportText(cx, field, header.replyTo));
  }
  int64_t number;
  for (auto pair : {std::pair{"date", &header.date},
                    {"dateReceived", &header.dateReceived}}) {
    MOZ_TRY(ImportMember(cx, object, pair.first, &field));
    MOZ_TRY(ImportNumber(field, -9007199254740991., 9007199254740991., number));
    *pair.second = number;
  }
  MOZ_TRY(ImportMember(cx, object, "flags", &field));
  MOZ_TRY(ImportNumber(field, 0, UINT32_MAX, number));
  header.flags = number;
  MOZ_TRY(ImportMember(cx, object, "priority", &field));
  MOZ_TRY(ImportNumber(field, nsMsgPriority::notSet, nsMsgPriority::highest,
                       number));
  header.priority = number;
  MOZ_TRY(ImportMember(cx, object, "references", &field));
  JS::Rooted<JSObject*> array(cx);
  uint32_t length;
  MOZ_TRY(ImportArray(cx, field, &array, length));
  for (uint32_t i = 0; i < length; ++i) {
    NS_ENSURE_TRUE(JS_GetElement(cx, array, i, &field), NS_ERROR_FAILURE);
    MOZ_TRY(ImportText(cx, field, *header.references.AppendElement()));
  }
  MOZ_TRY(ImportMember(cx, object, "extras", &field));
  MOZ_TRY(ImportArray(cx, field, &array, length));
  for (uint32_t i = 0; i < length; ++i) {
    NS_ENSURE_TRUE(JS_GetElement(cx, array, i, &field), NS_ERROR_FAILURE);
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
    JS::Rooted<JSObject*> extra(cx, &field.toObject());
    RawHdr::kv* cell = header.extras.AppendElement();
    MOZ_TRY(ImportMember(cx, extra, "k", &field));
    MOZ_TRY(ImportText(cx, field, cell->k));
    MOZ_TRY(ImportMember(cx, extra, "v", &field));
    MOZ_TRY(ImportText(cx, field, cell->v));
  }
  bool present;
  MOZ_TRY(ImportMember(cx, object, "storeToken", &field, true));
  NS_ENSURE_TRUE(JS_HasOwnProperty(cx, object, "storeToken", &present),
                 NS_ERROR_FAILURE);
  if (present) {
    nsCString token;
    MOZ_TRY(ImportText(cx, field, token));
    header.storeToken = Some(std::move(token));
  }
  for (auto pair : {std::pair{"messageSize", &header.messageSize},
                    {"offlineMessageSize", &header.offlineMessageSize},
                    {"lineCount", &header.lineCount}}) {
    NS_ENSURE_TRUE(JS_HasOwnProperty(cx, object, pair.first, &present),
                   NS_ERROR_FAILURE);
    if (present) {
      MOZ_TRY(ImportMember(cx, object, pair.first, &field));
      MOZ_TRY(ImportNumber(field, 0, UINT32_MAX, number));
      *pair.second = Some(static_cast<uint32_t>(number));
    }
  }
  return NS_OK;
}

// Preserve the original explicit message-only converted-input boundary.
nsresult CheckProjectedImportRecords(JSContext* cx,
                                     JS::Handle<JSObject*> request,
                                     const FolderImportSnapshot& input) {
  JS::Rooted<JS::Value> field(cx);
  MOZ_TRY(ImportMember(cx, request, "records", &field));
  NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
  JS::Rooted<JSObject*> records(cx, &field.toObject()), rows(cx), tables(cx);
  uint32_t length;
  MOZ_TRY(ImportMember(cx, records, "tables", &field));
  MOZ_TRY(ImportArray(cx, field, &tables, length));
  NS_ENSURE_TRUE(length <= 1, NS_ERROR_NOT_IMPLEMENTED);
  if (length) {
    NS_ENSURE_TRUE(JS_GetElement(cx, tables, 0, &field), NS_ERROR_FAILURE);
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
    JS::Rooted<JSObject*> table(cx, &field.toObject()), cells(cx), members(cx);
    MOZ_TRY(ImportMember(cx, table, "id", &field));
    int64_t tableId;
    MOZ_TRY(ImportNumber(field, 0, UINT32_MAX, tableId));
    MOZ_TRY(ImportMember(cx, table, "scope", &field));
    nsCString text;
    MOZ_TRY(ImportText(cx, field, text));
    NS_ENSURE_TRUE(text.EqualsLiteral("ns:msg:db:row:scope:msgs:all"),
                   NS_ERROR_NOT_IMPLEMENTED);
    MOZ_TRY(ImportMember(cx, table, "metaRow", &field));
    NS_ENSURE_TRUE(field.isNull(), NS_ERROR_NOT_IMPLEMENTED);
    MOZ_TRY(ImportMember(cx, table, "cells", &field));
    uint32_t count;
    MOZ_TRY(ImportArray(cx, field, &cells, count));
    bool messageKind = false;
    for (uint32_t i = 0; i < count; ++i) {
      NS_ENSURE_TRUE(JS_GetElement(cx, cells, i, &field), NS_ERROR_FAILURE);
      NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
      JS::Rooted<JSObject*> cell(cx, &field.toObject());
      nsCString name;
      MOZ_TRY(ImportMember(cx, cell, "k", &field));
      MOZ_TRY(ImportText(cx, field, name));
      MOZ_TRY(ImportMember(cx, cell, "v", &field));
      MOZ_TRY(ImportText(cx, field, text));
      if (name.EqualsLiteral("k")) {
        NS_ENSURE_FALSE(messageKind, NS_ERROR_INVALID_ARG);
        NS_ENSURE_TRUE(text.EqualsLiteral("ns:msg:db:table:kind:msgs"),
                       NS_ERROR_NOT_IMPLEMENTED);
        messageKind = true;
      } else {
        // Mork's storage layout parameter has no message semantics.
        NS_ENSURE_TRUE(name.EqualsLiteral("s"), NS_ERROR_NOT_IMPLEMENTED);
      }
    }
    NS_ENSURE_TRUE(messageKind, NS_ERROR_INVALID_ARG);
    MOZ_TRY(ImportMember(cx, table, "rows", &field));
    MOZ_TRY(ImportArray(cx, field, &members, count));
    NS_ENSURE_TRUE(count == input.messages.Length(), NS_ERROR_INVALID_ARG);
    for (uint32_t i = 0; i < count; ++i) {
      NS_ENSURE_TRUE(JS_GetElement(cx, members, i, &field), NS_ERROR_FAILURE);
      MOZ_TRY(ImportText(cx, field, text));
      nsAutoCString expected;
      expected.AppendInt(input.messages[i].sourceKey);
      expected.AppendLiteral(":ns:msg:db:row:scope:msgs:all");
      NS_ENSURE_TRUE(text == expected, NS_ERROR_INVALID_ARG);
    }
  }
  MOZ_TRY(ImportMember(cx, records, "rows", &field));
  MOZ_TRY(ImportArray(cx, field, &rows, length));
  NS_ENSURE_TRUE(length == input.messages.Length(), NS_ERROR_INVALID_ARG);
  for (uint32_t i = 0; i < length; ++i) {
    NS_ENSURE_TRUE(JS_GetElement(cx, rows, i, &field), NS_ERROR_FAILURE);
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
    JS::Rooted<JSObject*> row(cx, &field.toObject()), cells(cx);
    MOZ_TRY(ImportMember(cx, row, "id", &field));
    int64_t id;
    MOZ_TRY(ImportNumber(field, 0, nsMsgKey_None - 1, id));
    NS_ENSURE_TRUE(id == input.messages[i].sourceKey, NS_ERROR_INVALID_ARG);
    MOZ_TRY(ImportMember(cx, row, "scope", &field));
    nsCString scope;
    MOZ_TRY(ImportText(cx, field, scope));
    NS_ENSURE_TRUE(scope.EqualsLiteral("ns:msg:db:row:scope:msgs:all"),
                   NS_ERROR_NOT_IMPLEMENTED);
    MOZ_TRY(ImportMember(cx, row, "cells", &field));
    uint32_t count;
    MOZ_TRY(ImportArray(cx, field, &cells, count));
    const auto& extras = input.messages[i].header.extras;
    NS_ENSURE_TRUE(count == extras.Length(), NS_ERROR_INVALID_ARG);
    for (uint32_t j = 0; j < count; ++j) {
      NS_ENSURE_TRUE(JS_GetElement(cx, cells, j, &field), NS_ERROR_FAILURE);
      NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
      JS::Rooted<JSObject*> cell(cx, &field.toObject());
      for (auto pair : {std::pair{"k", &extras[j].k}, {"v", &extras[j].v}}) {
        MOZ_TRY(ImportMember(cx, cell, pair.first, &field));
        NS_ENSURE_TRUE(field.isString(), NS_ERROR_INVALID_ARG);
        nsAutoJSString bytes;
        NS_ENSURE_TRUE(bytes.init(cx, field), NS_ERROR_OUT_OF_MEMORY);
        nsCString raw;
        for (char16_t c : bytes.View()) {
          NS_ENSURE_TRUE(c <= 255, NS_ERROR_INVALID_ARG);
          raw.Append(static_cast<char>(c));
        }
        NS_ENSURE_TRUE(raw == *pair.second, NS_ERROR_INVALID_ARG);
      }
    }
  }
  return NS_OK;
}

struct ImportSourceRecord {
  uint32_t id{0};
  nsCString scope;
  nsTHashMap<nsCString, nsCString> cells;
  nsTArray<nsCString> members;
  nsTHashMap<nsCString, bool> memberSet;
  nsCString meta;
  bool accounted{false};
};

nsCString ImportSourceKey(uint32_t id, const nsACString& scope) {
  nsCString key;
  key.AppendInt(uint64_t(id));
  key.Append(':');
  key.Append(scope);
  return key;
}

nsresult ImportByteText(JSContext* cx, JS::Handle<JS::Value> value,
                        nsACString& output) {
  NS_ENSURE_TRUE(value.isString(), NS_ERROR_INVALID_ARG);
  nsAutoJSString bytes;
  NS_ENSURE_TRUE(bytes.init(cx, value), NS_ERROR_OUT_OF_MEMORY);
  output.Truncate();
  for (char16_t c : bytes.View()) {
    NS_ENSURE_TRUE(c <= 255, NS_ERROR_INVALID_ARG);
    output.Append(char(c));
  }
  nsCString roundtrip = NS_ConvertUTF16toUTF8(NS_ConvertUTF8toUTF16(output));
  NS_ENSURE_TRUE(roundtrip == output, NS_ERROR_INVALID_ARG);
  return NS_OK;
}

nsresult ImportSourceRecords(JSContext* cx, JS::Handle<JS::Value> value,
                             bool tables,
                             nsTArray<UniquePtr<ImportSourceRecord>>& records,
                             nsTHashMap<nsCString, uint32_t>& indexes) {
  JS::Rooted<JSObject*> array(cx);
  JS::Rooted<JS::Value> field(cx);
  uint32_t count;
  MOZ_TRY(ImportArray(cx, value, &array, count));
  for (uint32_t i = 0; i < count; ++i) {
    NS_ENSURE_TRUE(JS_GetElement(cx, array, i, &field), NS_ERROR_FAILURE);
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
    JS::Rooted<JSObject*> object(cx, &field.toObject()), cells(cx);
    auto record = MakeUnique<ImportSourceRecord>();
    int64_t id;
    MOZ_TRY(ImportMember(cx, object, "id", &field));
    MOZ_TRY(ImportNumber(field, 0, UINT32_MAX, id));
    record->id = id;
    MOZ_TRY(ImportMember(cx, object, "scope", &field));
    MOZ_TRY(ImportText(cx, field, record->scope));
    nsCString key = ImportSourceKey(record->id, record->scope);
    NS_ENSURE_FALSE(indexes.Contains(key), NS_ERROR_INVALID_ARG);
    MOZ_TRY(ImportMember(cx, object, "cells", &field));
    uint32_t length;
    MOZ_TRY(ImportArray(cx, field, &cells, length));
    for (uint32_t j = 0; j < length; ++j) {
      NS_ENSURE_TRUE(JS_GetElement(cx, cells, j, &field), NS_ERROR_FAILURE);
      NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
      JS::Rooted<JSObject*> cell(cx, &field.toObject());
      nsCString name, text;
      MOZ_TRY(ImportMember(cx, cell, "k", &field));
      MOZ_TRY(ImportByteText(cx, field, name));
      MOZ_TRY(ImportMember(cx, cell, "v", &field));
      MOZ_TRY(ImportByteText(cx, field, text));
      NS_ENSURE_FALSE(record->cells.Contains(name), NS_ERROR_INVALID_ARG);
      record->cells.InsertOrUpdate(name, std::move(text));
    }
    if (tables) {
      MOZ_TRY(ImportMember(cx, object, "metaRow", &field));
      if (!field.isNull()) {
        MOZ_TRY(ImportText(cx, field, record->meta));
        NS_ENSURE_FALSE(record->meta.IsEmpty(), NS_ERROR_INVALID_ARG);
      }
      MOZ_TRY(ImportMember(cx, object, "rows", &field));
      JS::Rooted<JSObject*> members(cx);
      MOZ_TRY(ImportArray(cx, field, &members, length));
      for (uint32_t j = 0; j < length; ++j) {
        NS_ENSURE_TRUE(JS_GetElement(cx, members, j, &field), NS_ERROR_FAILURE);
        nsCString member;
        MOZ_TRY(ImportText(cx, field, member));
        NS_ENSURE_FALSE(record->memberSet.Contains(member),
                        NS_ERROR_INVALID_ARG);
        record->memberSet.InsertOrUpdate(member, true);
        record->members.AppendElement(std::move(member));
      }
    }
    indexes.InsertOrUpdate(key, records.Length());
    records.AppendElement(std::move(record));
  }
  return NS_OK;
}

// Only named legacy structural numbers are decoded; arbitrary text stays text.
nsresult ImportHex(const nsACString& text, uint32_t digits, uint64_t& output) {
  NS_ENSURE_TRUE(!text.IsEmpty() && text.Length() <= digits,
                 NS_ERROR_INVALID_ARG);
  uint64_t value = 0;
  for (char c : text.View()) {
    uint8_t digit;
    if (c >= '0' && c <= '9') {
      digit = c - '0';
    } else if (c >= 'a' && c <= 'f') {
      digit = c - 'a' + 10;
    } else if (c >= 'A' && c <= 'F') {
      digit = c - 'A' + 10;
    } else {
      return NS_ERROR_INVALID_ARG;
    }
    value = (value << 4) | digit;
  }
  output = value;
  return NS_OK;
}

nsresult ImportCellNumber(const ImportSourceRecord& row, const nsACString& name,
                          uint32_t& value, uint32_t fallback = 0) {
  nsCString text;
  value = fallback;
  if (row.cells.Get(name, &text)) {
    uint64_t number;
    MOZ_TRY(ImportHex(text, 8, number));
    value = number;
  }
  return NS_OK;
}

nsresult CheckImportHeader(const ImportSourceRecord& row, const RawHdr& header,
                           nsIMimeConverter* converter) {
  NS_ENSURE_TRUE(row.cells.Count() == header.extras.Length(),
                 NS_ERROR_INVALID_ARG);
  nsTHashMap<nsCString, bool> seen;
  for (const auto& extra : header.extras) {
    nsCString text;
    NS_ENSURE_TRUE(!seen.Contains(extra.k) && row.cells.Get(extra.k, &text) &&
                       text == extra.v,
                   NS_ERROR_INVALID_ARG);
    seen.InsertOrUpdate(extra.k, true);
  }
  auto text = [&](const nsACString& name) {
    nsCString value;
    if (!row.cells.Get(name, &value)) {
      value.Truncate();
    }
    return value;
  };
  nsCString messageId = text("message-id"_ns);
  nsCString normalized = MOZ_TRY(DatabaseUtils::Normalize(messageId));
  NS_ENSURE_TRUE(header.messageId == normalized && header.replyTo.IsEmpty() &&
                     header.charset == text("msgCharSet"_ns) &&
                     header.accountKey == text("account"_ns),
                 NS_ERROR_INVALID_ARG);
  for (auto pair : {std::pair{"sender", &header.sender},
                    {"recipients", &header.recipients},
                    {"ccList", &header.ccList},
                    {"bccList", &header.bccList},
                    {"subject", &header.subject}}) {
    nsCString decoded;
    MOZ_TRY(converter->DecodeMimeHeaderToUTF8(
        text(nsDependentCString(pair.first)), header.charset.get(), true, true,
        decoded));
    normalized = MOZ_TRY(DatabaseUtils::Normalize(decoded));
    NS_ENSURE_TRUE(*pair.second == normalized, NS_ERROR_INVALID_ARG);
  }
  normalized = MOZ_TRY(DatabaseUtils::Normalize(text("keywords"_ns)));
  NS_ENSURE_TRUE(header.keywords == normalized, NS_ERROR_INVALID_ARG);
  uint32_t flags, date, received, priority, protoFlags;
  MOZ_TRY(ImportCellNumber(row, "flags"_ns, flags));
  MOZ_TRY(ImportCellNumber(row, "date"_ns, date));
  MOZ_TRY(ImportCellNumber(row, "dateReceived"_ns, received));
  MOZ_TRY(ImportCellNumber(row, "priority"_ns, priority));
  MOZ_TRY(ImportCellNumber(row, "ProtoThreadFlags"_ns, protoFlags));
  NS_ENSURE_TRUE(!(flags & nsMsgMessageFlags::Expunged) && !protoFlags,
                 NS_ERROR_NOT_IMPLEMENTED);
  NS_ENSURE_TRUE(
      header.flags == (flags & ~nsMsgMessageFlags::New) &&
          header.date == PRTime(date) * PR_USEC_PER_SEC &&
          header.dateReceived == PRTime(received) * PR_USEC_PER_SEC &&
          uint32_t(header.priority) == priority,
      NS_ERROR_INVALID_ARG);
  for (auto pair : {std::pair{"size", &header.messageSize},
                    {"offlineMsgSize", &header.offlineMessageSize},
                    {"numLines", &header.lineCount}}) {
    NS_ENSURE_TRUE(bool(*pair.second) ==
                       row.cells.Contains(nsDependentCString(pair.first)),
                   NS_ERROR_INVALID_ARG);
    if (*pair.second) {
      uint32_t number;
      MOZ_TRY(ImportCellNumber(row, nsDependentCString(pair.first), number));
      NS_ENSURE_TRUE(**pair.second == number, NS_ERROR_INVALID_ARG);
    }
  }
  nsCString token = text("storeToken"_ns);
  if (token.IsEmpty() && row.cells.Contains("msgOffset"_ns)) {
    uint64_t offset;
    MOZ_TRY(ImportHex(text("msgOffset"_ns), 16, offset));
    if (offset != UINT64_MAX) {
      token.AppendInt(offset);
    }
  }
  bool tokenPresent = row.cells.Contains("storeToken"_ns) || !token.IsEmpty();
  NS_ENSURE_TRUE(bool(header.storeToken) == tokenPresent &&
                     (!tokenPresent || *header.storeToken == token),
                 NS_ERROR_INVALID_ARG);
  // Match the reader's NUL-terminated legacy References view, preserving order.
  nsCString references(text("references"_ns).get());
  nsTArray<nsCString> expected;
  uint32_t position = 0;
  while (position < references.Length()) {
    bool first = position == 0;
    int32_t open = references.FindChar('<', position);
    int32_t close = open < 0 ? -1 : references.FindChar('>', open + 1);
    nsCString reference;
    if (close >= 0) {
      reference = Substring(references, open + 1, close - open - 1);
      position = close + 1;
    } else {
      if (first) {
        reference = Substring(references, position);
        reference.Trim(" \r\n\t", true, false);
        if (!reference.IsEmpty() && reference.First() == '<') {
          reference.Cut(0, 1);
        }
      }
      position = references.Length();
    }
    if (!reference.IsEmpty() && reference != messageId) {
      expected.AppendElement(std::move(reference));
    }
  }
  NS_ENSURE_TRUE(header.references == expected, NS_ERROR_INVALID_ARG);
  return NS_OK;
}

nsresult ImportFolderProperties(JSContext* cx, JS::Handle<JSObject*> request,
                                const ImportSourceRecord& info, uint32_t flags,
                                uint32_t total, uint32_t unread,
                                nsTArray<FolderImportProperty>& output) {
  JS::Rooted<JS::Value> field(cx);
  JS::Rooted<JSObject*> array(cx);
  uint32_t count;
  MOZ_TRY(ImportMember(cx, request, "folderProperties", &field));
  MOZ_TRY(ImportArray(cx, field, &array, count));
  NS_ENSURE_TRUE(count == info.cells.Count(), NS_ERROR_INVALID_ARG);
  nsTHashMap<nsCString, bool> seen;
  for (uint32_t i = 0; i < count; ++i) {
    NS_ENSURE_TRUE(JS_GetElement(cx, array, i, &field), NS_ERROR_FAILURE);
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
    JS::Rooted<JSObject*> property(cx, &field.toObject());
    FolderImportProperty value;
    MOZ_TRY(ImportMember(cx, property, "name", &field));
    MOZ_TRY(ImportText(cx, field, value.name));
    MOZ_TRY(ImportMember(cx, property, "text", &field));
    MOZ_TRY(ImportText(cx, field, value.text));
    nsCString raw;
    NS_ENSURE_TRUE(!seen.Contains(value.name) &&
                       info.cells.Get(value.name, &raw) && raw == value.text,
                   NS_ERROR_INVALID_ARG);
    seen.InsertOrUpdate(value.name, true);
    NS_ENSURE_TRUE(value.name != "morkMigrationSource"_ns,
                   NS_ERROR_INVALID_ARG);
    bool present;
    NS_ENSURE_TRUE(JS_HasOwnProperty(cx, property, "integer", &present),
                   NS_ERROR_FAILURE);
    if (present) {
      MOZ_TRY(ImportMember(cx, property, "integer", &field));
      int64_t number;
      MOZ_TRY(
          ImportNumber(field, -9007199254740991., 9007199254740991., number));
      value.integer = Some(number);
    }
    bool isUint32 = false;
    for (const char* name : {"numMsgs",
                             "numNewMsgs",
                             "flags",
                             "folderDate",
                             "highWaterKey",
                             "UIDValidity",
                             "totPendingMsgs",
                             "unreadPendingMsgs",
                             "version",
                             "userSortOrder",
                             "viewType",
                             "viewFlags",
                             "sortType",
                             "sortOrder",
                             "retainBy",
                             "daysToKeepHdrs",
                             "numHdrsToKeep",
                             "useServerDefaults",
                             "applyToFlaggedMessages",
                             "downloadByDate",
                             "downloadUnreadOnly",
                             "ageLimit",
                             "forceReparse",
                             "fixedBadRefThreading"}) {
      isUint32 |= value.name.Equals(name);
    }
    bool isInt64 =
        value.name == "folderSize"_ns || value.name == "expungedBytes"_ns;
    NS_ENSURE_TRUE(bool(value.integer) == (isUint32 || isInt64),
                   NS_ERROR_INVALID_ARG);
    if (value.integer) {
      uint64_t bits;
      MOZ_TRY(ImportHex(value.text, isInt64 ? 16 : 8, bits));
      bool negative = isInt64 && (bits >> 63);
      uint64_t magnitude = negative ? (~bits + 1) : bits;
      NS_ENSURE_TRUE(magnitude <= 9007199254740991ULL,
                     NS_ERROR_NOT_IMPLEMENTED);
      int64_t expected = negative ? -int64_t(magnitude) : int64_t(magnitude);
      NS_ENSURE_TRUE(*value.integer == expected, NS_ERROR_INVALID_ARG);
      if (value.name == "flags"_ns) {
        NS_ENSURE_TRUE(expected == flags, NS_ERROR_NOT_IMPLEMENTED);
      } else if (value.name == "numMsgs"_ns || value.name == "numNewMsgs"_ns) {
        NS_ENSURE_TRUE(
            expected == (value.name == "numMsgs"_ns ? total : unread),
            NS_ERROR_INVALID_ARG);
      } else if (value.name == "version"_ns) {
        NS_ENSURE_TRUE(expected == 1, NS_ERROR_NOT_IMPLEMENTED);
      } else if (value.name == "totPendingMsgs"_ns ||
                 value.name == "unreadPendingMsgs"_ns ||
                 value.name == "forceReparse"_ns) {
        NS_ENSURE_TRUE(expected == 0, NS_ERROR_NOT_IMPLEMENTED);
      }
    }
    output.AppendElement(std::move(value));
  }
  return NS_OK;
}

nsresult CheckFullImportRecords(JSContext* cx, JS::Handle<JSObject*> request,
                                nsIMsgFolder* folder,
                                FolderImportSnapshot& input) {
  nsCString protocol;
  uint32_t folderFlags;
  MOZ_TRY(folder->GetIncomingServerType(protocol));
  MOZ_TRY(folder->GetFlags(&folderFlags));
  NS_ENSURE_TRUE(protocol == "none"_ns, NS_ERROR_NOT_IMPLEMENTED);
  JS::Rooted<JS::Value> field(cx);
  JS::Rooted<JSObject*> records(cx);
  MOZ_TRY(ImportMember(cx, request, "unhandledRecords", &field));
  JS::Rooted<JSObject*> unhandled(cx);
  uint32_t count;
  MOZ_TRY(ImportArray(cx, field, &unhandled, count));
  NS_ENSURE_TRUE(!count, NS_ERROR_NOT_IMPLEMENTED);
  MOZ_TRY(ImportMember(cx, request, "records", &field));
  NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
  records = &field.toObject();
  nsTArray<UniquePtr<ImportSourceRecord>> rows, tables;
  nsTHashMap<nsCString, uint32_t> rowIndexes, tableIndexes;
  MOZ_TRY(ImportMember(cx, records, "rows", &field));
  MOZ_TRY(ImportSourceRecords(cx, field, false, rows, rowIndexes));
  MOZ_TRY(ImportMember(cx, records, "tables", &field));
  MOZ_TRY(ImportSourceRecords(cx, field, true, tables, tableIndexes));
  auto find = [&](const nsACString& key) -> ImportSourceRecord* {
    uint32_t index;
    return rowIndexes.Get(key, &index) ? rows[index].get() : nullptr;
  };
  constexpr auto messageScope = "ns:msg:db:row:scope:msgs:all"_ns;
  constexpr auto threadScope = "ns:msg:db:row:scope:threads:all"_ns;
  constexpr auto infoScope = "ns:msg:db:row:scope:dbfolderinfo:all"_ns;
  ImportSourceRecord *messageTable = nullptr, *infoTable = nullptr,
                     *allThreads = nullptr;
  nsTHashMap<uint32_t, uint32_t> threadTables;
  for (uint32_t i = 0; i < tables.Length(); ++i) {
    auto& table = *tables[i];
    for (auto cell = table.cells.ConstIter(); !cell.Done(); cell.Next()) {
      NS_ENSURE_TRUE(cell.Key() == "k"_ns || cell.Key() == "s"_ns,
                     NS_ERROR_NOT_IMPLEMENTED);
    }
    nsCString kind;
    NS_ENSURE_TRUE(table.cells.Get("k"_ns, &kind), NS_ERROR_INVALID_ARG);
    if (table.scope == messageScope && kind == "ns:msg:db:table:kind:msgs"_ns &&
        !messageTable && table.meta.IsEmpty()) {
      messageTable = &table;
    } else if (table.scope == messageScope &&
               kind == "ns:msg:db:table:kind:thread"_ns) {
      threadTables.InsertOrUpdate(table.id, i);
    } else if (table.scope == infoScope &&
               kind == "ns:msg:db:table:kind:dbfolderinfo"_ns && !infoTable &&
               table.meta.IsEmpty()) {
      infoTable = &table;
    } else if (table.scope == threadScope &&
               kind == "ns:msg:db:table:kind:allthreads"_ns && !allThreads &&
               table.meta.IsEmpty()) {
      allThreads = &table;
    } else {
      return NS_ERROR_NOT_IMPLEMENTED;
    }
  }
  NS_ENSURE_TRUE(
      messageTable && infoTable && allThreads && !threadTables.IsEmpty(),
      NS_ERROR_NOT_IMPLEMENTED);
  NS_ENSURE_TRUE(messageTable->members.Length() == input.messages.Length() &&
                     infoTable->members.Length() == 1 &&
                     allThreads->members.Length() == threadTables.Count(),
                 NS_ERROR_INVALID_ARG);
  nsTHashMap<nsMsgKey, uint32_t> messages;
  nsCOMPtr<nsIMimeConverter> converter =
      mozilla::components::MimeConverter::Service();
  NS_ENSURE_TRUE(converter, NS_ERROR_NOT_AVAILABLE);
  uint32_t unread = 0;
  for (uint32_t i = 0; i < input.messages.Length(); ++i) {
    const auto& message = input.messages[i];
    nsCString key = ImportSourceKey(message.sourceKey, messageScope);
    auto* row = find(key);
    NS_ENSURE_TRUE(row && messageTable->memberSet.Contains(key),
                   NS_ERROR_INVALID_ARG);
    MOZ_TRY(CheckImportHeader(*row, message.header, converter));
    row->accounted = true;
    messages.InsertOrUpdate(message.sourceKey, i);
    unread += !(message.header.flags & nsMsgMessageFlags::Read);
  }
  nsTHashMap<nsMsgKey, bool> assigned;
  auto checkMeta = [&](ImportSourceRecord* meta, uint32_t id, uint32_t children,
                       uint32_t unreadChildren, uint32_t newest,
                       uint32_t& root) -> nsresult {
    NS_ENSURE_TRUE(meta && !meta->accounted && meta->scope == "m"_ns &&
                       meta->cells.Count() == 6,
                   NS_ERROR_NOT_IMPLEMENTED);
    uint32_t values[6];
    const char* names[] = {"threadRoot",     "threadId",
                           "threadFlags",    "children",
                           "unreadChildren", "threadNewestMsgDate"};
    for (uint32_t i = 0; i < 6; ++i) {
      nsDependentCString name(names[i]);
      NS_ENSURE_TRUE(meta->cells.Contains(name), NS_ERROR_NOT_IMPLEMENTED);
      MOZ_TRY(ImportCellNumber(*meta, name, values[i]));
    }
    NS_ENSURE_TRUE(values[1] == id && !values[2] && values[3] == children &&
                       values[4] == unreadChildren &&
                       (!values[5] || values[5] == newest),
                   NS_ERROR_NOT_IMPLEMENTED);
    root = values[0];
    meta->accounted = true;
    return NS_OK;
  };
  for (auto entry = threadTables.ConstIter(); !entry.Done(); entry.Next()) {
    const auto& table = *tables[entry.Data()];
    NS_ENSURE_TRUE(!table.members.IsEmpty(), NS_ERROR_NOT_IMPLEMENTED);
    uint32_t childrenUnread = 0, newest = 0;
    for (const auto& key : table.members) {
      auto* row = find(key);
      uint32_t index;
      NS_ENSURE_TRUE(row && row->scope == messageScope &&
                         messages.Get(row->id, &index) &&
                         !assigned.Contains(row->id),
                     NS_ERROR_INVALID_ARG);
      uint32_t id, parent;
      MOZ_TRY(ImportCellNumber(*row, "msgThreadId"_ns, id));
      MOZ_TRY(ImportCellNumber(*row, "threadParent"_ns, parent, nsMsgKey_None));
      const auto& message = input.messages[index];
      Maybe<nsMsgKey> expectedParent;
      if (parent != nsMsgKey_None) {
        expectedParent = Some(nsMsgKey(parent));
      }
      NS_ENSURE_TRUE(
          id == table.id && message.parentSourceKey == expectedParent,
          NS_ERROR_INVALID_ARG);
      assigned.InsertOrUpdate(row->id, true);
      childrenUnread += !(message.header.flags & nsMsgMessageFlags::Read);
      newest =
          std::max(newest, uint32_t(message.header.date / PR_USEC_PER_SEC));
    }
    uint32_t root, rootIndex;
    MOZ_TRY(checkMeta(find(table.meta), table.id, table.members.Length(),
                      childrenUnread, newest, root));
    NS_ENSURE_TRUE(
        messages.Get(root, &rootIndex) &&
            table.memberSet.Contains(ImportSourceKey(root, messageScope)),
        NS_ERROR_INVALID_ARG);
    for (const auto& key : table.members) {
      uint32_t index;
      NS_ENSURE_TRUE(messages.Get(find(key)->id, &index) &&
                         input.messages[index].rootSourceKey == root,
                     NS_ERROR_INVALID_ARG);
    }
    nsCString subjectKey = ImportSourceKey(table.id, threadScope);
    auto* subject = find(subjectKey);
    auto* rootRow = find(ImportSourceKey(root, messageScope));
    nsCString rawSubject, threadSubject;
    if (!rootRow->cells.Get("subject"_ns, &rawSubject)) {
      rawSubject.Truncate();
    }
    NS_ENSURE_TRUE(subject && !subject->accounted &&
                       subject->cells.Count() == 1 &&
                       subject->cells.Get("threadSubject"_ns, &threadSubject) &&
                       threadSubject == rawSubject &&
                       allThreads->memberSet.Contains(subjectKey),
                   NS_ERROR_NOT_IMPLEMENTED);
    subject->accounted = true;
  }
  NS_ENSURE_TRUE(assigned.Count() == input.messages.Length(),
                 NS_ERROR_INVALID_ARG);
  auto* info = find(infoTable->members[0]);
  NS_ENSURE_TRUE(info && info->id == 1 && info->scope == infoScope,
                 NS_ERROR_NOT_IMPLEMENTED);
  MOZ_TRY(ImportFolderProperties(cx, request, *info, folderFlags,
                                 input.messages.Length(), unread,
                                 input.folderProperties));
  info->accounted = true;
  for (const auto& row : rows) {
    if (!row->accounted) {
      uint32_t root;
      MOZ_TRY(checkMeta(row.get(), row->id, 0, 0, 0, root));
      NS_ENSURE_TRUE(root == row->id, NS_ERROR_NOT_IMPLEMENTED);
    }
  }
  return NS_OK;
}

}  // namespace

namespace {

#ifdef XP_WIN
nsresult ImportOriginalPath(JSContext* cx, JS::Handle<JSObject*> object,
                            FolderImportPathIdentity& path) {
  JS::Rooted<JS::Value> field(cx);
  for (auto pair : {std::pair{"originalPath", &path.originalPath},
                    {"originalRoot", &path.originalRoot}}) {
    MOZ_TRY(ImportMember(cx, object, pair.first, &field));
    nsCString utf8;
    MOZ_TRY(ImportText(cx, field, utf8));
    NS_ENSURE_TRUE(!utf8.IsEmpty() && utf8.FindChar(0) < 0,
                   NS_ERROR_INVALID_ARG);
    CopyUTF8toUTF16(utf8, *pair.second);
  }
  for (auto pair : {std::pair{"id", &path.id},
                    {"parentId", &path.parentId},
                    {"rootId", &path.rootId}}) {
    MOZ_TRY(ImportMember(cx, object, pair.first, &field));
    MOZ_TRY(ImportText(cx, field, *pair.second));
  }
  return NS_OK;
}

nsresult ImportWindowsAdmission(JSContext* cx, JS::Handle<JSObject*> request,
                                FolderImportIdentity& identity) {
  JS::Rooted<JS::Value> field(cx);
  MOZ_TRY(ImportMember(cx, request, "windowsAdmission", &field));
  NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
  JS::Rooted<JSObject*> admission(cx, &field.toObject());
  FolderImportWindowsIdentity paths;
  for (auto pair :
       {std::pair{"summary", &paths.summary}, {"store", &paths.store}}) {
    MOZ_TRY(ImportMember(cx, admission, pair.first, &field));
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
    JS::Rooted<JSObject*> path(cx, &field.toObject());
    MOZ_TRY(ImportOriginalPath(cx, path, *pair.second));
  }
  identity.windows = Some(std::move(paths));
  return NS_OK;
}
#endif

nsresult ImportIdentity(DatabaseCore* core, nsIMsgFolder* source, JSContext* cx,
                        JS::Handle<JSObject*> request,
                        FolderImportIdentity& identity,
                        FolderImportAdmission& admission) {
  NS_ENSURE_ARG_POINTER(source);
  JS::Rooted<JS::Value> field(cx);
  int64_t version;
  MOZ_TRY(ImportMember(cx, request, "version", &field));
#ifdef XP_WIN
  MOZ_TRY(ImportNumber(field, 2, 2, version));
  MOZ_TRY(ImportWindowsAdmission(cx, request, identity));
#else
  MOZ_TRY(ImportNumber(field, 1, 1, version));
#endif
  for (auto pair : {std::pair{"token", &identity.token},
                    {"sourceId", &identity.sourceId},
                    {"databaseSourceId", &identity.databaseSourceId}}) {
    MOZ_TRY(ImportMember(cx, request, pair.first, &field));
    MOZ_TRY(ImportText(cx, field, *pair.second));
    NS_ENSURE_TRUE(!pair.second->IsEmpty() && pair.second->FindChar(0) < 0,
                   NS_ERROR_INVALID_ARG);
  }
  nsCString databaseId;
  MOZ_TRY(core->GetSourceId(databaseId));
  NS_ENSURE_TRUE(identity.databaseSourceId == databaseId,
                 NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(ImportMember(cx, request, "folder", &field));
  NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
  JS::Rooted<JSObject*> folder(cx, &field.toObject());
  MOZ_TRY(ImportMember(cx, folder, "id", &field));
  int64_t id;
  MOZ_TRY(ImportNumber(field, 1, 9007199254740991., id));
  identity.folderId = id;
  uint64_t actualId;
  MOZ_TRY(source->GetId(&actualId));
  NS_ENSURE_TRUE(actualId == identity.folderId, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(source->GetPath(identity.folderPath));
  nsCOMPtr<nsIFile> summary, storeFile;
  MOZ_TRY(source->GetSummaryFile(getter_AddRefs(summary)));
  MOZ_TRY(source->GetFilePath(getter_AddRefs(storeFile)));
  NS_ENSURE_TRUE(summary && storeFile, NS_ERROR_NOT_AVAILABLE);
  nsAutoString summaryPath, storePath;
#ifdef XP_WIN
  // Native leases precede normalization and outlive hash, conversion and
  // commit.
  MOZ_TRY(admission.Acquire(identity, summary, storeFile));
  identity = admission.Identity();
  summaryPath = identity.windows->summary.canonicalPath;
  storePath = identity.windows->store.canonicalPath;
#else
  MOZ_TRY(NormalizeImportFile(summary));
  MOZ_TRY(NormalizeImportFile(storeFile));
  MOZ_TRY(summary->GetPath(summaryPath));
  MOZ_TRY(storeFile->GetPath(storePath));
#endif
  nsCString uri, storeType, protocol;
  MOZ_TRY(source->GetURI(uri));
  MOZ_TRY(source->GetIncomingServerType(protocol));
  nsCOMPtr<nsIMsgPluggableStore> store;
  MOZ_TRY(source->GetMsgStore(getter_AddRefs(store)));
  NS_ENSURE_TRUE(store, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(store->GetStoreType(storeType));
  nsCString summaryUtf8 = NS_ConvertUTF16toUTF8(summaryPath);
  nsCString storeUtf8 = NS_ConvertUTF16toUTF8(storePath);
  for (auto pair : {std::pair{"uri", &uri},
                    {"summaryPath", &summaryUtf8},
                    {"storePath", &storeUtf8},
                    {"storeType", &storeType},
                    {"protocol", &protocol}}) {
    MOZ_TRY(ImportMember(cx, folder, pair.first, &field));
    nsCString text;
    MOZ_TRY(ImportText(cx, field, text));
    NS_ENSURE_TRUE(text == *pair.second, NS_ERROR_NOT_AVAILABLE);
  }
  bool exists;
  MOZ_TRY(storeFile->Exists(&exists));
#ifdef XP_WIN
  NS_ENSURE_TRUE(exists == !identity.windows->store.id.IsEmpty(),
                 NS_ERROR_NOT_AVAILABLE);
#endif
  MOZ_TRY(ImportMember(cx, folder, "storeExists", &field));
  NS_ENSURE_TRUE(field.isBoolean(), NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(field.toBoolean() == exists, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(ImportMember(cx, request, "source", &field));
  NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
  JS::Rooted<JSObject*> original(cx, &field.toObject());
  MOZ_TRY(ImportMember(cx, original, "path", &field));
  nsCString text;
  MOZ_TRY(ImportText(cx, field, text));
  NS_ENSURE_TRUE(text == summaryUtf8, NS_ERROR_NOT_AVAILABLE);
  identity.sourcePath = summaryPath;
  MOZ_TRY(ImportMember(cx, original, "sha256", &field));
  MOZ_TRY(ImportText(cx, field, identity.sourceSha256));
  return NS_OK;
}

nsresult ImportMessages(JSContext* cx, JS::Handle<JSObject*> request,
                        nsIMsgFolder* folder, FolderImportSnapshot& input) {
  NS_ENSURE_ARG_POINTER(folder);
  bool full;
  NS_ENSURE_TRUE(JS_HasOwnProperty(cx, request, "folderProperties", &full),
                 NS_ERROR_FAILURE);
  JS::Rooted<JS::Value> field(cx);
  MOZ_TRY(ImportMember(cx, request, "source", &field));
  NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
  JS::Rooted<JSObject*> source(cx, &field.toObject());
  MOZ_TRY(ImportMember(cx, source, "size", &field));
  int64_t number;
  MOZ_TRY(ImportNumber(field, 0, UINT32_MAX - 1, number));
  input.sourceSize = number;
  // Nonempty summaries cannot opt out of full raw-record accounting.
  full = full || input.sourceSize != 0;
  MOZ_TRY(ImportMember(cx, source, "messageKeys", &field));
  JS::Rooted<JSObject*> keys(cx), messages(cx);
  uint32_t keyCount, count;
  MOZ_TRY(ImportArray(cx, field, &keys, keyCount));
  MOZ_TRY(ImportMember(cx, request, "messages", &field));
  MOZ_TRY(ImportArray(cx, field, &messages, count));
  NS_ENSURE_TRUE(count == keyCount, NS_ERROR_INVALID_ARG);
  nsTHashMap<nsMsgKey, bool> sourceKeys;
  if (full) {
    for (uint32_t i = 0; i < keyCount; ++i) {
      NS_ENSURE_TRUE(JS_GetElement(cx, keys, i, &field), NS_ERROR_FAILURE);
      MOZ_TRY(ImportNumber(field, 0, nsMsgKey_None - 1, number));
      NS_ENSURE_FALSE(sourceKeys.Contains(number), NS_ERROR_INVALID_ARG);
      sourceKeys.InsertOrUpdate(number, true);
    }
  }
  for (uint32_t i = 0; i < count; ++i) {
    NS_ENSURE_TRUE(JS_GetElement(cx, messages, i, &field), NS_ERROR_FAILURE);
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
    JS::Rooted<JSObject*> message(cx, &field.toObject());
    FolderImportMessage* row = input.messages.AppendElement();
    MOZ_TRY(ImportMember(cx, message, "sourceKey", &field));
    MOZ_TRY(ImportNumber(field, 0, nsMsgKey_None - 1, number));
    row->sourceKey = number;
    if (full) {
      NS_ENSURE_TRUE(sourceKeys.Contains(row->sourceKey), NS_ERROR_INVALID_ARG);
    } else {
      NS_ENSURE_TRUE(JS_GetElement(cx, keys, i, &field), NS_ERROR_FAILURE);
      MOZ_TRY(ImportNumber(field, 0, nsMsgKey_None - 1, number));
      NS_ENSURE_TRUE(number == row->sourceKey, NS_ERROR_INVALID_ARG);
    }
    MOZ_TRY(ImportMember(cx, message, "rootSourceKey", &field));
    MOZ_TRY(ImportNumber(field, 0, nsMsgKey_None - 1, number));
    row->rootSourceKey = number;
    MOZ_TRY(ImportMember(cx, message, "parentSourceKey", &field));
    if (!field.isNull()) {
      MOZ_TRY(ImportNumber(field, 0, nsMsgKey_None - 1, number));
      row->parentSourceKey = Some(static_cast<nsMsgKey>(number));
    }
    MOZ_TRY(ImportMember(cx, message, "header", &field));
    MOZ_TRY(ImportHeader(cx, field, row->header));
  }
  nsTHashMap<nsMsgKey, uint32_t> indexes;
  for (uint32_t i = 0; i < count; ++i) {
    nsMsgKey key = input.messages[i].sourceKey;
    NS_ENSURE_FALSE(indexes.Contains(key), NS_ERROR_INVALID_ARG);
    indexes.InsertOrUpdate(key, i);
  }
  for (const auto& row : input.messages) {
    uint32_t index;
    NS_ENSURE_TRUE(indexes.Get(row.rootSourceKey, &index) &&
                       input.messages[index].rootSourceKey == row.rootSourceKey,
                   NS_ERROR_INVALID_ARG);
    if (row.parentSourceKey) {
      NS_ENSURE_TRUE(
          indexes.Get(*row.parentSourceKey, &index) &&
              input.messages[index].rootSourceKey == row.rootSourceKey,
          NS_ERROR_INVALID_ARG);
    }
  }
  nsTArray<uint8_t> visited;
  visited.SetLength(count);
  for (auto& state : visited) {
    state = 0;
  }
  for (uint32_t i = 0; i < count; ++i) {
    uint32_t index = i;
    nsTArray<uint32_t> chain;
    while (visited[index] != 2) {
      NS_ENSURE_TRUE(visited[index] == 0, NS_ERROR_INVALID_ARG);
      visited[index] = 1;
      chain.AppendElement(index);
      const auto& parent = input.messages[index].parentSourceKey;
      if (!parent) {
        break;
      }
      NS_ENSURE_TRUE(indexes.Get(*parent, &index), NS_ERROR_INVALID_ARG);
    }
    for (uint32_t member : chain) {
      visited[member] = 2;
    }
  }
  if (full) {
    MOZ_TRY(CheckFullImportRecords(cx, request, folder, input));
  } else {
    MOZ_TRY(CheckProjectedImportRecords(cx, request, input));
  }
  input.recordsComplete = true;
  return NS_OK;
}

bool ImportPathValue(JSContext* cx, const FolderImportPathIdentity& path,
                     JS::MutableHandle<JSObject*> output) {
  JS::Rooted<JSObject*> object(cx, JS_NewPlainObject(cx));
  if (!object) {
    return false;
  }
  for (auto pair : {std::pair{"originalPath", &path.originalPath},
                    {"originalRoot", &path.originalRoot},
                    {"canonicalPath", &path.canonicalPath},
                    {"canonicalRoot", &path.canonicalRoot}}) {
    JS::Rooted<JSString*> text(
        cx, JS_NewUCStringCopyN(cx, pair.second->get(), pair.second->Length()));
    if (!text) {
      return false;
    }
    JS::Rooted<JS::Value> value(cx, JS::StringValue(text));
    if (!JS_DefineProperty(cx, object, pair.first, value, JSPROP_ENUMERATE)) {
      return false;
    }
  }
  for (auto pair : {std::pair{"id", &path.id},
                    {"parentId", &path.parentId},
                    {"rootId", &path.rootId}}) {
    JS::Rooted<JSString*> text(
        cx, JS_NewStringCopyUTF8N(
                cx, JS::UTF8Chars(pair.second->get(), pair.second->Length())));
    if (!text) {
      return false;
    }
    JS::Rooted<JS::Value> value(cx, JS::StringValue(text));
    if (!JS_DefineProperty(cx, object, pair.first, value, JSPROP_ENUMERATE)) {
      return false;
    }
  }
  output.set(object);
  return true;
}

bool ImportWindowsValue(JSContext* cx, const FolderImportWindowsIdentity& paths,
                        JS::Handle<JSObject*> receipt) {
  JS::Rooted<JSObject*> admission(cx, JS_NewPlainObject(cx));
  JS::Rooted<JSObject*> summary(cx), store(cx);
  JS::Rooted<JSObject*> physical(cx, JS_NewPlainObject(cx));
  if (!admission || !physical ||
      !ImportPathValue(cx, paths.summary, &summary) ||
      !ImportPathValue(cx, paths.store, &store) ||
      !JS_DefineProperty(cx, admission, "summary", summary, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, admission, "store", store, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, physical, "version", double(1),
                         JSPROP_ENUMERATE)) {
    return false;
  }
  for (auto pair : {std::pair{"id", &paths.summary.id},
                    {"parentId", &paths.summary.parentId}}) {
    JS::Rooted<JSString*> text(
        cx, JS_NewStringCopyUTF8N(
                cx, JS::UTF8Chars(pair.second->get(), pair.second->Length())));
    if (!text) {
      return false;
    }
    JS::Rooted<JS::Value> value(cx, JS::StringValue(text));
    if (!JS_DefineProperty(cx, physical, pair.first, value, JSPROP_ENUMERATE)) {
      return false;
    }
  }
  return JS_DefineProperty(cx, receipt, "version", double(2),
                           JSPROP_ENUMERATE) &&
         JS_DefineProperty(cx, receipt, "windowsAdmission", admission,
                           JSPROP_ENUMERATE) &&
         JS_DefineProperty(cx, receipt, "sourcePhysicalIdentity", physical,
                           JSPROP_ENUMERATE);
}

bool ImportReceiptValue(JSContext* cx, const FolderImportReceipt& receipt,
                        JS::MutableHandle<JS::Value> output) {
  JS::Rooted<JSObject*> object(cx, JS_NewPlainObject(cx));
  JS::Rooted<JSObject*> keys(cx, JS::NewArrayObject(cx, receipt.keys.Length()));
  if (!object || !keys) {
    return false;
  }
  for (auto pair : {std::pair{"token", &receipt.identity.token},
                    {"sourceId", &receipt.identity.sourceId},
                    {"databaseSourceId", &receipt.identity.databaseSourceId},
                    {"sourceSha256", &receipt.identity.sourceSha256}}) {
    JS::Rooted<JSString*> text(
        cx, JS_NewStringCopyUTF8N(
                cx, JS::UTF8Chars(pair.second->get(), pair.second->Length())));
    if (!text) {
      return false;
    }
    JS::Rooted<JS::Value> value(cx, JS::StringValue(text));
    if (!JS_DefineProperty(cx, object, pair.first, value, JSPROP_ENUMERATE)) {
      return false;
    }
  }
  for (uint32_t i = 0; i < receipt.keys.Length(); ++i) {
    JS::Rooted<JSObject*> key(cx, JS::NewArrayObject(cx, 2));
    if (!key ||
        !JS_DefineElement(cx, key, 0, double(receipt.keys[i].source),
                          JSPROP_ENUMERATE) ||
        !JS_DefineElement(cx, key, 1, double(receipt.keys[i].destination),
                          JSPROP_ENUMERATE) ||
        !JS_DefineElement(cx, keys, i, key, JSPROP_ENUMERATE)) {
      return false;
    }
  }
  if (!JS_DefineProperty(cx, object, "folderId",
                         double(receipt.identity.folderId), JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, object, "keys", keys, JSPROP_ENUMERATE)) {
    return false;
  }
  if (receipt.identity.windows &&
      !ImportWindowsValue(cx, *receipt.identity.windows, object)) {
    return false;
  }
  output.setObject(*object);
  return true;
}

}  // namespace

NS_IMETHODIMP DatabaseCore::ImportFolderSnapshot(nsIMsgFolder* source,
                                                 JS::Handle<JS::Value> request,
                                                 JSContext* cx,
                                                 Promise** output) {
  NS_ENSURE_TRUE(request.isObject(), NS_ERROR_INVALID_ARG);
  JS::Rooted<JSObject*> object(cx, &request.toObject());
  FolderImportSnapshot input;
  // Finish admission and JS conversion before the owned SQL transaction.
  FolderImportAdmission admission;
#ifdef XP_WIN
  MOZ_TRY(ImportIdentity(this, source, cx, object, input.identity, admission));
#endif
  MOZ_TRY(ImportMessages(cx, object, source, input));
#ifndef XP_WIN
  MOZ_TRY(ImportIdentity(this, source, cx, object, input.identity, admission));
#endif
  Maybe<FolderImportReceipt> previous;
  MOZ_TRY(GetFolderImportReceipt(input.identity, previous));
  FolderImportReceipt prepared;
  if (previous) {
    prepared = std::move(*previous);
  } else {
    prepared.identity = input.identity;
    for (const auto& row : input.messages) {
      prepared.keys.AppendElement(FolderImportKey{row.sourceKey, 0});
    }
    std::sort(prepared.keys.begin(), prepared.keys.end(),
              [](const auto& a, const auto& b) { return a.source < b.source; });
  }
  JS::Rooted<JS::Value> result(cx);
  NS_ENSURE_TRUE(ImportReceiptValue(cx, prepared, &result),
                 NS_ERROR_OUT_OF_MEMORY);
  ErrorResult error;
  RefPtr<Promise> promise =
      Promise::Create(xpc::CurrentNativeGlobal(cx), error);
  if (error.Failed()) {
    return error.StealNSResult();
  }
  FolderImportReceipt receipt;
  nsresult rv = ImportFolderSnapshot(source, input, receipt);
  if (NS_SUCCEEDED(rv)) {
    JS::Rooted<JSObject*> resultObject(cx, &result.toObject());
    JS::Rooted<JS::Value> keys(cx), pair(cx);
    if (receipt.keys.Length() != prepared.keys.Length() ||
        !JS_GetProperty(cx, resultObject, "keys", &keys)) {
      return NS_ERROR_FAILURE;
    }
    JS::Rooted<JSObject*> array(cx, &keys.toObject());
    for (uint32_t i = 0; i < receipt.keys.Length(); ++i) {
      NS_ENSURE_TRUE(JS_GetElement(cx, array, i, &pair), NS_ERROR_FAILURE);
      JS::Rooted<JSObject*> tuple(cx, &pair.toObject());
      JS::Rooted<JS::Value> key(cx,
                                JS::NumberValue(receipt.keys[i].destination));
      NS_ENSURE_TRUE(JS_SetElement(cx, tuple, 1, key), NS_ERROR_FAILURE);
    }
    promise->MaybeResolve(result);
  } else {
    promise->MaybeReject(rv);
  }
  promise.forget(output);
  return NS_OK;
}

NS_IMETHODIMP DatabaseCore::GetFolderImportReceipt(
    nsIMsgFolder* source, JS::Handle<JS::Value> request, JSContext* cx,
    JS::MutableHandle<JS::Value> output) {
  NS_ENSURE_TRUE(request.isObject(), NS_ERROR_INVALID_ARG);
  JS::Rooted<JSObject*> object(cx, &request.toObject());
  FolderImportIdentity identity;
  FolderImportAdmission admission;
  MOZ_TRY(ImportIdentity(this, source, cx, object, identity, admission));
  Maybe<FolderImportReceipt> receipt;
  MOZ_TRY(GetFolderImportReceipt(identity, receipt));
  if (!receipt) {
    output.setNull();
    return NS_OK;
  }
  JS::Rooted<JS::Value> result(cx);
  NS_ENSURE_TRUE(ImportReceiptValue(cx, *receipt, &result),
                 NS_ERROR_OUT_OF_MEMORY);
  output.set(result);
  return NS_OK;
}

NS_IMETHODIMP
DatabaseCore::MigrateFolderDatabase(nsIMsgFolder* srcFolder, JSContext* aCx,
                                    Promise** aPromise) {
  AUTO_PROFILER_LABEL("DatabaseCore::MigrateFolderDatabase", MAILNEWS);
#ifdef XP_WIN
  // This entrypoint has no original inventory paths or admitted-root context.
  return NS_ERROR_NOT_AVAILABLE;
#else

  ErrorResult err;
  RefPtr<Promise> promise = Promise::Create(xpc::CurrentNativeGlobal(aCx), err);

  RefPtr<FolderMigrator> migrator = new FolderMigrator();
  nsresult rv = migrator->SetupAndRun(srcFolder, promise);
  NS_ENSURE_SUCCESS(rv, rv);

  promise.forget(aPromise);
  return NS_OK;
#endif
}

// Cache imports are separate from message-summary imports. These records never
// confer a new physical identity or permission to replace derived folder state.
#ifndef XP_WIN
namespace {
struct CacheFolder {
  nsCString originalKey, descriptor, cachePath, storePath, protocol, storeType;
  uint64_t id;
  uint32_t sourceKey;
  bool isServer;
  nsTArray<FolderImportProperty> properties;
};
struct CacheImport {
  nsCString token, sourceId, databaseId, path, sha256;
  uint32_t size;
  nsTArray<CacheFolder> folders;
};

bool CacheText(JSContext* cx, JS::Handle<JSObject*> object, const char* name,
               const nsACString& text) {
  NS_ConvertUTF8toUTF16 utf16(text);
  JS::Rooted<JSString*> string(
      cx, JS_NewUCStringCopyN(cx, utf16.get(), utf16.Length()));
  return string &&
         JS_DefineProperty(cx, object, name, string, JSPROP_ENUMERATE);
}

bool CacheJSONWrite(const char16_t* buffer, uint32_t length, void* data) {
  static_cast<nsAString*>(data)->Append(buffer, length);
  return true;
}
nsresult CacheJSON(JSContext* cx, JS::Handle<JSObject*> object,
                   nsACString& output) {
  JS::Rooted<JS::Value> value(cx, JS::ObjectValue(*object));
  nsString text;
  NS_ENSURE_TRUE(JS_Stringify(cx, &value, nullptr, JS::NullHandleValue,
                              CacheJSONWrite, &text),
                 NS_ERROR_FAILURE);
  CopyUTF16toUTF8(text, output);
  return NS_OK;
}
nsresult CacheParseJSON(JSContext* cx, const nsACString& text,
                        JS::MutableHandle<JS::Value> output) {
  NS_ConvertUTF8toUTF16 utf16(text);
  NS_ENSURE_TRUE(JS_ParseJSON(cx, utf16.get(), utf16.Length(), output) &&
                     output.isObject(),
                 NS_ERROR_FILE_CORRUPTED);
  return NS_OK;
}

nsresult CacheRequest(JSContext* cx, JS::Handle<JS::Value> value,
                      CacheImport& input) {
  NS_ENSURE_TRUE(value.isObject(), NS_ERROR_INVALID_ARG);
  JS::Rooted<JSObject*> request(cx, &value.toObject()), object(cx), array(cx);
  JS::Rooted<JS::Value> field(cx);
  int64_t number;
  MOZ_TRY(ImportMember(cx, request, "version", &field));
  MOZ_TRY(ImportNumber(field, 1, 1, number));
  for (auto pair : {std::pair{"token", &input.token},
                    {"sourceId", &input.sourceId},
                    {"databaseSourceId", &input.databaseId}}) {
    MOZ_TRY(ImportMember(cx, request, pair.first, &field));
    MOZ_TRY(ImportText(cx, field, *pair.second));
    NS_ENSURE_TRUE(!pair.second->IsEmpty() && pair.second->FindChar(0) < 0,
                   NS_ERROR_INVALID_ARG);
  }
  MOZ_TRY(ImportMember(cx, request, "source", &field));
  NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
  object = &field.toObject();
  for (auto pair :
       {std::pair{"path", &input.path}, {"sha256", &input.sha256}}) {
    MOZ_TRY(ImportMember(cx, object, pair.first, &field));
    MOZ_TRY(ImportText(cx, field, *pair.second));
    NS_ENSURE_TRUE(!pair.second->IsEmpty() && pair.second->FindChar(0) < 0,
                   NS_ERROR_INVALID_ARG);
  }
  NS_ENSURE_TRUE(input.sha256.Length() == 64, NS_ERROR_INVALID_ARG);
  for (char c : input.sha256.View()) {
    NS_ENSURE_TRUE((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'),
                   NS_ERROR_INVALID_ARG);
  }
  MOZ_TRY(ImportMember(cx, object, "size", &field));
  MOZ_TRY(ImportNumber(field, 1, UINT32_MAX - 1, number));
  input.size = number;
  MOZ_TRY(ImportMember(cx, request, "folders", &field));
  uint32_t length;
  MOZ_TRY(ImportArray(cx, field, &array, length));
  NS_ENSURE_TRUE(length, NS_ERROR_INVALID_ARG);
  for (uint32_t i = 0; i < length; ++i) {
    NS_ENSURE_TRUE(JS_GetElement(cx, array, i, &field), NS_ERROR_FAILURE);
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
    object = &field.toObject();
    CacheFolder folder;
    for (auto pair : {std::pair{"originalKey", &folder.originalKey},
                      {"descriptor", &folder.descriptor},
                      {"cachePath", &folder.cachePath},
                      {"storePath", &folder.storePath},
                      {"protocol", &folder.protocol},
                      {"storeType", &folder.storeType}}) {
      MOZ_TRY(ImportMember(cx, object, pair.first, &field));
      MOZ_TRY(ImportText(cx, field, *pair.second));
      NS_ENSURE_TRUE(!pair.second->IsEmpty() && pair.second->FindChar(0) < 0,
                     NS_ERROR_INVALID_ARG);
    }
    MOZ_TRY(ImportMember(cx, object, "id", &field));
    MOZ_TRY(ImportNumber(field, 1, 9007199254740991., number));
    folder.id = number;
    MOZ_TRY(ImportMember(cx, object, "sourceKey", &field));
    MOZ_TRY(ImportNumber(field, 1, UINT32_MAX, number));
    folder.sourceKey = number;
    MOZ_TRY(ImportMember(cx, object, "isServer", &field));
    NS_ENSURE_TRUE(field.isBoolean(), NS_ERROR_INVALID_ARG);
    folder.isServer = field.toBoolean();
    for (const auto& previous : input.folders) {
      NS_ENSURE_TRUE(previous.id != folder.id &&
                         previous.originalKey != folder.originalKey &&
                         previous.sourceKey != folder.sourceKey &&
                         previous.descriptor != folder.descriptor &&
                         previous.cachePath != folder.cachePath &&
                         previous.storePath != folder.storePath,
                     NS_ERROR_INVALID_ARG);
    }
    input.folders.AppendElement(std::move(folder));
  }
  std::sort(input.folders.begin(), input.folders.end(),
            [](const auto& a, const auto& b) {
              return Compare(a.originalKey, b.originalKey) < 0;
            });
  return NS_OK;
}

nsresult CheckCacheFolders(DatabaseCore* core,
                           mozIStorageConnection* connection,
                           const CacheImport& input) {
  nsCString databaseId;
  MOZ_TRY(ReadDatabaseSourceId(connection, databaseId));
  NS_ENSURE_TRUE(databaseId == input.databaseId, NS_ERROR_NOT_AVAILABLE);
  for (const auto& folder : input.folders) {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(connection->CreateStatement(
        "SELECT EXISTS(SELECT 1 FROM body_relocations r WHERE r.folderId=f.id "
        "AND r.state NOT IN(1,2)) FROM folders f WHERE id=:id"_ns,
        getter_AddRefs(stmt)));
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, folder.id));
    bool exists;
    MOZ_TRY(stmt->ExecuteStep(&exists));
    NS_ENSURE_TRUE(exists, NS_ERROR_NOT_AVAILABLE);
    int32_t pending;
    MOZ_TRY(stmt->GetInt32(0, &pending));
    NS_ENSURE_FALSE(pending, NS_ERROR_IN_PROGRESS);
    nsCOMPtr<nsIMsgFolder> actual;
    MOZ_TRY(core->FolderDB().GetMsgFolderForFolder(folder.id,
                                                   getter_AddRefs(actual)));
    NS_ENSURE_TRUE(actual, NS_ERROR_NOT_AVAILABLE);
    uint64_t actualId;
    MOZ_TRY(actual->GetId(&actualId));
    NS_ENSURE_TRUE(actualId == folder.id, NS_ERROR_NOT_AVAILABLE);
    bool isServer;
    MOZ_TRY(actual->GetIsServer(&isServer));
    NS_ENSURE_TRUE(isServer == folder.isServer, NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsIFile> file, storeFile;
    if (isServer) {
      MOZ_TRY(actual->GetFilePath(getter_AddRefs(file)));
    } else {
      MOZ_TRY(actual->GetSummaryFile(getter_AddRefs(file)));
    }
    MOZ_TRY(actual->GetFilePath(getter_AddRefs(storeFile)));
    MOZ_TRY(NormalizeImportFile(file));
    MOZ_TRY(NormalizeImportFile(storeFile));
    nsAutoString cachePath, storePath;
    nsCString descriptor, protocol, storeType;
    MOZ_TRY(file->GetPath(cachePath));
    MOZ_TRY(file->GetPersistentDescriptor(descriptor));
    MOZ_TRY(storeFile->GetPath(storePath));
    MOZ_TRY(actual->GetIncomingServerType(protocol));
    nsCOMPtr<nsIMsgPluggableStore> store;
    MOZ_TRY(actual->GetMsgStore(getter_AddRefs(store)));
    NS_ENSURE_TRUE(store, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(store->GetStoreType(storeType));
    NS_ENSURE_TRUE(descriptor == folder.descriptor &&
                       NS_ConvertUTF16toUTF8(cachePath) == folder.cachePath &&
                       NS_ConvertUTF16toUTF8(storePath) == folder.storePath &&
                       protocol == folder.protocol &&
                       storeType == folder.storeType,
                   NS_ERROR_NOT_AVAILABLE);
    NS_ENSURE_TRUE(
        protocol.EqualsLiteral("none") || protocol.EqualsLiteral("imap"),
        NS_ERROR_NOT_IMPLEMENTED);
  }
  return NS_OK;
}

nsresult CacheIdentity(JSContext* cx, const CacheImport& input,
                       JS::MutableHandle<JSObject*> result) {
  result.set(JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
  JS::Rooted<JSObject*> folders(cx,
                                JS::NewArrayObject(cx, input.folders.Length()));
  NS_ENSURE_TRUE(result && folders && JS_SetPrototype(cx, folders, nullptr),
                 NS_ERROR_OUT_OF_MEMORY);
  NS_ENSURE_TRUE(
      JS_DefineProperty(cx, result, "version", 1, JSPROP_ENUMERATE) &&
          CacheText(cx, result, "policy", "native-authoritative-v1"_ns),
      NS_ERROR_OUT_OF_MEMORY);
  for (auto pair : {std::pair{"token", &input.token},
                    {"sourceId", &input.sourceId},
                    {"databaseSourceId", &input.databaseId},
                    {"path", &input.path},
                    {"sha256", &input.sha256}}) {
    NS_ENSURE_TRUE(CacheText(cx, result, pair.first, *pair.second),
                   NS_ERROR_OUT_OF_MEMORY);
  }
  NS_ENSURE_TRUE(JS_DefineProperty(cx, result, "size", double(input.size),
                                   JSPROP_ENUMERATE),
                 NS_ERROR_OUT_OF_MEMORY);
  for (uint32_t i = 0; i < input.folders.Length(); ++i) {
    const auto& folder = input.folders[i];
    JS::Rooted<JSObject*> object(
        cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
    NS_ENSURE_TRUE(object, NS_ERROR_OUT_OF_MEMORY);
    for (auto pair : {std::pair{"originalKey", &folder.originalKey},
                      {"descriptor", &folder.descriptor},
                      {"cachePath", &folder.cachePath},
                      {"storePath", &folder.storePath},
                      {"protocol", &folder.protocol},
                      {"storeType", &folder.storeType}}) {
      NS_ENSURE_TRUE(CacheText(cx, object, pair.first, *pair.second),
                     NS_ERROR_OUT_OF_MEMORY);
    }
    JS::Rooted<JS::Value> server(cx, JS::BooleanValue(folder.isServer));
    NS_ENSURE_TRUE(
        JS_DefineProperty(cx, object, "id", double(folder.id),
                          JSPROP_ENUMERATE) &&
            JS_DefineProperty(cx, object, "sourceKey", double(folder.sourceKey),
                              JSPROP_ENUMERATE) &&
            JS_DefineProperty(cx, object, "isServer", server,
                              JSPROP_ENUMERATE) &&
            JS_DefineElement(cx, folders, i, object, JSPROP_ENUMERATE),
        NS_ERROR_OUT_OF_MEMORY);
  }
  NS_ENSURE_TRUE(
      JS_DefineProperty(cx, result, "folders", folders, JSPROP_ENUMERATE),
      NS_ERROR_OUT_OF_MEMORY);
  return NS_OK;
}

nsresult ReadCacheBytes(const CacheImport& input, nsACString& bytes) {
  nsCOMPtr<nsIFile> file;
  MOZ_TRY(
      NS_NewLocalFile(NS_ConvertUTF8toUTF16(input.path), getter_AddRefs(file)));
  MOZ_TRY(NormalizeImportFile(file));
  nsAutoString path;
  MOZ_TRY(file->GetPath(path));
  NS_ENSURE_TRUE(NS_ConvertUTF16toUTF8(path) == input.path,
                 NS_ERROR_NOT_AVAILABLE);
  int64_t size;
  MOZ_TRY(file->GetFileSize(&size));
  NS_ENSURE_TRUE(size == input.size, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIInputStream> stream;
  MOZ_TRY(NS_NewLocalFileInputStream(getter_AddRefs(stream), file));
  auto close = MakeScopeExit([&] { stream->Close(); });
  MOZ_TRY(NS_ReadInputStreamToString(stream, bytes, input.size));
  MOZ_TRY(stream->Close());
  close.release();
  NS_ENSURE_TRUE(bytes.Length() == input.size, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsICryptoHash> hash;
  MOZ_TRY(NS_NewCryptoHash(nsICryptoHash::SHA256, getter_AddRefs(hash)));
  MOZ_TRY(hash->Update(reinterpret_cast<const uint8_t*>(bytes.BeginReading()),
                       bytes.Length()));
  nsCString digest, hex;
  MOZ_TRY(hash->Finish(false, digest));
  for (unsigned char c : digest.View()) {
    hex.Append("0123456789abcdef"[c >> 4]);
    hex.Append("0123456789abcdef"[c & 15]);
  }
  NS_ENSURE_TRUE(hex == input.sha256, NS_ERROR_NOT_AVAILABLE);
  return NS_OK;
}

// Names are compared exactly. Cache structural facts are source history, not
// permission to overwrite discovery, message-derived counts or body accounting.
bool CacheNativeAuthoritative(const nsACString& name) {
  return name.EqualsLiteral("flags") || name.EqualsLiteral("folderName") ||
         name.EqualsLiteral("totalMsgs") ||
         name.EqualsLiteral("totalUnreadMsgs") ||
         name.EqualsLiteral("pendingMsgs") ||
         name.EqualsLiteral("pendingUnreadMsgs") ||
         name.EqualsLiteral("folderSize") ||
         name.EqualsLiteral("expungedBytes");
}
bool CacheUnsupportedAlias(const nsACString& name) {
  return name.EqualsLiteral("morkMigrationSource") ||
         name.EqualsLiteral("UIDValidity") ||
         name.EqualsLiteral("highWaterKey") ||
         name.EqualsLiteral("folderDate") || name.EqualsLiteral("version") ||
         name.EqualsLiteral("userSortOrder") ||
         name.EqualsLiteral("viewType") || name.EqualsLiteral("viewFlags") ||
         name.EqualsLiteral("sortType") || name.EqualsLiteral("sortOrder") ||
         name.EqualsLiteral("numMsgs") || name.EqualsLiteral("numNewMsgs") ||
         name.EqualsLiteral("totPendingMsgs") ||
         name.EqualsLiteral("unreadPendingMsgs");
}

nsresult ParseCacheBytes(JSContext* cx, const nsACString& bytes,
                         CacheImport& input) {
  JS::Rooted<JSObject*> module(cx),
      buffer(cx, JS_NewUint8Array(cx, bytes.Length()));
  NS_ENSURE_TRUE(buffer, NS_ERROR_OUT_OF_MEMORY);
  {
    JS::AutoCheckCannotGC nogc;
    bool shared;
    memcpy(JS_GetUint8ArrayData(buffer, &shared, nogc), bytes.BeginReading(),
           bytes.Length());
  }
  JS::Rooted<JSObject*> global(cx, JS::CurrentGlobalOrNull(cx));
  dom::GlobalObject caller(cx, global);
  ErrorResult error;
  dom::ChromeUtils::ImportESModule(
      caller, u"resource:///modules/panorama/MorkFolderCache.sys.mjs"_ns,
      dom::ImportESModuleOptionsDictionary(), &module, error);
  if (error.Failed()) return error.StealNSResult();
  JS::Rooted<JS::Value> function(cx), parsed(cx),
      argument(cx, JS::ObjectValue(*buffer)), field(cx);
  NS_ENSURE_TRUE(
      JS_GetProperty(cx, module, "parseMorkFolderCache", &function) &&
          JS::Call(cx, module, function, JS::HandleValueArray(argument),
                   &parsed),
      NS_ERROR_FAILURE);
  NS_ENSURE_TRUE(parsed.isObject(), NS_ERROR_FAILURE);
  JS::Rooted<JSObject*> object(cx, &parsed.toObject()), entries(cx), source(cx),
      rows(cx);
  MOZ_TRY(ImportMember(cx, object, "entries", &field));
  NS_ENSURE_TRUE(field.isObject(), NS_ERROR_FAILURE);
  entries = &field.toObject();
  MOZ_TRY(ImportMember(cx, object, "source", &field));
  NS_ENSURE_TRUE(field.isObject(), NS_ERROR_FAILURE);
  source = &field.toObject();
  MOZ_TRY(ImportMember(cx, source, "rows", &field));
  NS_ENSURE_TRUE(field.isObject(), NS_ERROR_FAILURE);
  rows = &field.toObject();
  NS_ENSURE_TRUE(JS::MapSize(cx, rows) == input.folders.Length() &&
                     JS::MapSize(cx, entries) == input.folders.Length(),
                 NS_ERROR_NOT_IMPLEMENTED);
  for (auto& folder : input.folders) {
    JS::Rooted<JSString*> key(
        cx, JS_NewUCStringCopyN(
                cx, NS_ConvertUTF8toUTF16(folder.originalKey).get(),
                NS_ConvertUTF8toUTF16(folder.originalKey).Length()));
    NS_ENSURE_TRUE(key, NS_ERROR_OUT_OF_MEMORY);
    JS::Rooted<JS::Value> keyValue(cx, JS::StringValue(key));
    NS_ENSURE_TRUE(JS::MapGet(cx, entries, keyValue, &field), NS_ERROR_FAILURE);
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
    object = &field.toObject();
    MOZ_TRY(ImportMember(cx, object, "sourceKey", &field));
    int64_t number;
    MOZ_TRY(ImportNumber(field, folder.sourceKey, folder.sourceKey, number));
    MOZ_TRY(ImportMember(cx, object, "values", &field));
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_FAILURE);
    JS::Rooted<JSObject*> values(cx, &field.toObject()), properties(cx);
    MOZ_TRY(ImportMember(cx, object, "properties", &field));
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_FAILURE);
    properties = &field.toObject();
    NS_ENSURE_TRUE(JS::MapEntries(cx, properties, &field), NS_ERROR_FAILURE);
    JS::ForOfIterator iterator(cx);
    NS_ENSURE_TRUE(iterator.init(field), NS_ERROR_FAILURE);
    bool done;
    while (true) {
      NS_ENSURE_TRUE(iterator.next(&field, &done), NS_ERROR_FAILURE);
      if (done) break;
      NS_ENSURE_TRUE(field.isObject(), NS_ERROR_FAILURE);
      JS::Rooted<JSObject*> pair(cx, &field.toObject());
      FolderImportProperty property;
      NS_ENSURE_TRUE(JS_GetElement(cx, pair, 0, &field), NS_ERROR_FAILURE);
      JS::Rooted<JS::Value> name(cx, field);
      MOZ_TRY(ImportText(cx, name, property.name));
      NS_ENSURE_TRUE(JS_GetElement(cx, pair, 1, &field), NS_ERROR_FAILURE);
      MOZ_TRY(ImportText(cx, field, property.text));
      NS_ENSURE_FALSE(CacheUnsupportedAlias(property.name),
                      NS_ERROR_NOT_IMPLEMENTED);
      if (!property.name.EqualsLiteral("key")) {
        JS::Rooted<JS::PropertyKey> id(cx);
        NS_ENSURE_TRUE(JS_ValueToId(cx, name, &id) &&
                           JS_GetPropertyById(cx, values, id, &field),
                       NS_ERROR_FAILURE);
        if (field.isNumber()) {
          MOZ_TRY(ImportNumber(field, -9007199254740991., 9007199254740991.,
                               number));
          property.integer = Some(number);
        }
      }
      folder.properties.AppendElement(std::move(property));
    }
  }
  return NS_OK;
}

nsresult ReadCacheReceipt(mozIStorageConnection* connection,
                          const CacheImport& input, const nsACString& identity,
                          Maybe<nsCString>& output) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(connection->CreateStatement(
      "SELECT identity,receipt FROM folder_cache_imports WHERE token=:token "
      "OR sourceId=:source OR path=:path"_ns,
      getter_AddRefs(stmt)));
  MOZ_TRY(stmt->BindUTF8StringByName("token"_ns, input.token));
  MOZ_TRY(stmt->BindUTF8StringByName("source"_ns, input.sourceId));
  MOZ_TRY(stmt->BindUTF8StringByName("path"_ns, input.path));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  Maybe<nsCString> result;
  if (more) {
    for (uint32_t column : {0u, 1u}) {
      int32_t type;
      MOZ_TRY(stmt->GetTypeOfIndex(column, &type));
      NS_ENSURE_TRUE(type == mozIStorageStatement::VALUE_TYPE_TEXT,
                     NS_ERROR_FILE_CORRUPTED);
    }
    nsCString stored, receipt;
    MOZ_TRY(stmt->GetUTF8String(0, stored));
    NS_ENSURE_TRUE(stored == identity, NS_ERROR_ALREADY_INITIALIZED);
    MOZ_TRY(stmt->GetUTF8String(1, receipt));
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
    result = Some(std::move(receipt));
  }
  nsCOMPtr<mozIStorageStatement> binding;
  MOZ_TRY(connection->CreateStatement(
      "SELECT b.token,r.token FROM folder_cache_bindings b LEFT JOIN "
      "folder_cache_imports r ON r.token=b.token WHERE b.folderId=:id"_ns,
      getter_AddRefs(binding)));
  for (const auto& folder : input.folders) {
    mozStorageStatementScoper reset(binding);
    MOZ_TRY(binding->BindInt64ByName("id"_ns, folder.id));
    MOZ_TRY(binding->ExecuteStep(&more));
    if (!more) {
      NS_ENSURE_FALSE(result, NS_ERROR_FILE_CORRUPTED);
      continue;
    }
    bool orphan;
    MOZ_TRY(binding->GetIsNull(1, &orphan));
    NS_ENSURE_FALSE(orphan, NS_ERROR_FILE_CORRUPTED);
    NS_ENSURE_TRUE(result, NS_ERROR_ALREADY_INITIALIZED);
    int32_t type;
    MOZ_TRY(binding->GetTypeOfIndex(0, &type));
    NS_ENSURE_TRUE(type == mozIStorageStatement::VALUE_TYPE_TEXT,
                   NS_ERROR_FILE_CORRUPTED);
    nsCString token;
    MOZ_TRY(binding->GetUTF8String(0, token));
    NS_ENSURE_TRUE(token == input.token, NS_ERROR_FILE_CORRUPTED);
  }
  if (result) {
    nsCOMPtr<mozIStorageStatement> count;
    MOZ_TRY(connection->CreateStatement(
        "SELECT COUNT(*) FROM folder_cache_bindings WHERE token=:token"_ns,
        getter_AddRefs(count)));
    MOZ_TRY(count->BindUTF8StringByName("token"_ns, input.token));
    MOZ_TRY(count->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
    int64_t size;
    MOZ_TRY(count->GetInt64(0, &size));
    NS_ENSURE_TRUE(size == int64_t(input.folders.Length()),
                   NS_ERROR_FILE_CORRUPTED);
  }
  output = std::move(result);
  return NS_OK;
}
}  // namespace
#endif

NS_IMETHODIMP DatabaseCore::GetFolderCacheImportReceipt(
    JS::Handle<JS::Value> request, JSContext* cx,
    JS::MutableHandle<JS::Value> output) {
#ifdef XP_WIN
  return NS_ERROR_NOT_AVAILABLE;
#else
  NS_ENSURE_TRUE(sInstance.get() == this && sConnection,
                 NS_ERROR_NOT_AVAILABLE);
  bool active;
  MOZ_TRY(sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  CacheImport input;
  MOZ_TRY(CacheRequest(cx, request, input));
  NS_ENSURE_TRUE(sInstance.get() == this && sConnection && !mShuttingDown,
                 NS_ERROR_NOT_AVAILABLE);
  // Request getters can reenter the core. Refuse to adopt their transaction.
  MOZ_TRY(sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(CheckCacheFolders(this, sConnection, input));
  JS::Rooted<JSObject*> identityObject(cx);
  MOZ_TRY(CacheIdentity(cx, input, &identityObject));
  nsCString identity;
  MOZ_TRY(CacheJSON(cx, identityObject, identity));
  Maybe<nsCString> receipt;
  MOZ_TRY(ReadCacheReceipt(sConnection, input, identity, receipt));
  JS::Rooted<JS::Value> result(cx, JS::NullValue());
  if (receipt) MOZ_TRY(CacheParseJSON(cx, *receipt, &result));
  output.set(result);
  return NS_OK;
#endif
}

NS_IMETHODIMP DatabaseCore::ImportFolderCacheMetadata(
    JS::Handle<JS::Value> request, JSContext* cx,
    JS::MutableHandle<JS::Value> output) {
#ifdef XP_WIN
  return NS_ERROR_NOT_AVAILABLE;
#else
  NS_ENSURE_TRUE(sInstance.get() == this && sConnection,
                 NS_ERROR_NOT_AVAILABLE);
  bool active;
  MOZ_TRY(sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  CacheImport input;
  MOZ_TRY(CacheRequest(cx, request, input));
  NS_ENSURE_TRUE(sInstance.get() == this && sConnection && !mShuttingDown,
                 NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(CheckCacheFolders(this, sConnection, input));
  JS::Rooted<JSObject*> identityObject(cx);
  MOZ_TRY(CacheIdentity(cx, input, &identityObject));
  nsCString identity;
  MOZ_TRY(CacheJSON(cx, identityObject, identity));
  Maybe<nsCString> prior;
  MOZ_TRY(ReadCacheReceipt(sConnection, input, identity, prior));
  if (prior) {
    nsCString checkedBytes;
    MOZ_TRY(ReadCacheBytes(input, checkedBytes));
    JS::Rooted<JS::Value> result(cx);
    MOZ_TRY(CacheParseJSON(cx, *prior, &result));
    output.set(result);
    return NS_OK;
  }
  nsCString bytes;
  MOZ_TRY(ReadCacheBytes(input, bytes));
  MOZ_TRY(ParseCacheBytes(cx, bytes, input));
  NS_ENSURE_TRUE(sInstance.get() == this && sConnection && !mShuttingDown,
                 NS_ERROR_NOT_AVAILABLE);
  JS::Rooted<JSObject*> result(
      cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
  JS::Rooted<JSObject*> cells(cx, JS::NewArrayObject(cx, 0));
  NS_ENSURE_TRUE(
      result && cells && JS_SetPrototype(cx, cells, nullptr) &&
          JS_DefineProperty(cx, result, "identity", identityObject,
                            JSPROP_ENUMERATE) &&
          JS_DefineProperty(cx, result, "cells", cells, JSPROP_ENUMERATE),
      NS_ERROR_OUT_OF_MEMORY);
  // Prepare output and the exact write set before taking transaction ownership.
  struct Write {
    uint64_t id;
    FolderImportProperty property;
  };
  nsTArray<Write> writes;
  uint32_t index = 0;
  for (const auto& folder : input.folders) {
    nsTArray<FolderImportProperty> current;
    MOZ_TRY(mFolderDatabase->GetFolderProperties(folder.id, current));
    for (const auto& property : folder.properties) {
      bool present = false;
      for (const auto& existing : current)
        present |= existing.name == property.name;
      const char* disposition = property.name.EqualsLiteral("key") ? "binding"
                                : CacheNativeAuthoritative(property.name)
                                    ? "native-authoritative"
                                : present ? "existing"
                                          : "applied";
      if (strcmp(disposition, "applied") == 0) {
        writes.AppendElement(Write{folder.id, property});
      }
      JS::Rooted<JSObject*> cell(
          cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
      NS_ENSURE_TRUE(cell &&
                         JS_DefineProperty(cx, cell, "id", double(folder.id),
                                           JSPROP_ENUMERATE) &&
                         CacheText(cx, cell, "name", property.name) &&
                         CacheText(cx, cell, "text", property.text) &&
                         CacheText(cx, cell, "disposition",
                                   nsDependentCString(disposition)),
                     NS_ERROR_OUT_OF_MEMORY);
      if (property.integer) {
        NS_ENSURE_TRUE(
            JS_DefineProperty(cx, cell, "integer", double(*property.integer),
                              JSPROP_ENUMERATE),
            NS_ERROR_OUT_OF_MEMORY);
      }
      NS_ENSURE_TRUE(
          JS_DefineElement(cx, cells, index++, cell, JSPROP_ENUMERATE),
          NS_ERROR_OUT_OF_MEMORY);
    }
  }
  nsCString receipt;
  MOZ_TRY(CacheJSON(cx, result, receipt));
  JS::Rooted<JS::Value> prepared(cx);
  MOZ_TRY(CacheParseJSON(cx, receipt, &prepared));
  MOZ_TRY(sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(sConnection->BeginTransaction());
  auto apply = [&]() -> nsresult {
    MOZ_TRY(CheckCacheFolders(this, sConnection, input));
    // A concurrent writer may have completed between preparation and BEGIN.
    Maybe<nsCString> found;
    MOZ_TRY(ReadCacheReceipt(sConnection, input, identity, found));
    NS_ENSURE_FALSE(found, NS_ERROR_ALREADY_INITIALIZED);
    nsCOMPtr<mozIStorageStatement> insert;
    MOZ_TRY(sConnection->CreateStatement(
        "INSERT INTO folder_properties(id,name,value) VALUES(:id,:name,:value)"_ns,
        getter_AddRefs(insert)));
    for (const auto& write : writes) {
      mozStorageStatementScoper reset(insert);
      MOZ_TRY(insert->BindInt64ByName("id"_ns, write.id));
      MOZ_TRY(insert->BindUTF8StringByName("name"_ns, write.property.name));
      if (write.property.integer) {
        MOZ_TRY(insert->BindInt64ByName("value"_ns, *write.property.integer));
      } else {
        MOZ_TRY(insert->BindUTF8StringByName("value"_ns, write.property.text));
      }
      MOZ_TRY(insert->Execute());
    }
    nsCOMPtr<mozIStorageStatement> save;
    MOZ_TRY(sConnection->CreateStatement(
        "INSERT INTO "
        "folder_cache_imports(token,sourceId,path,identity,raw,receipt) "
        "VALUES(:token,:source,:path,:identity,:raw,:receipt)"_ns,
        getter_AddRefs(save)));
    for (auto pair : {std::pair{"token", &input.token},
                      {"source", &input.sourceId},
                      {"path", &input.path},
                      {"identity", &identity},
                      {"receipt", &receipt}}) {
      MOZ_TRY(save->BindUTF8StringByName(nsDependentCString(pair.first),
                                         *pair.second));
    }
    MOZ_TRY(save->BindBlobByName("raw"_ns,
                                 reinterpret_cast<const uint8_t*>(bytes.get()),
                                 bytes.Length()));
    MOZ_TRY(save->Execute());
    nsCOMPtr<mozIStorageStatement> bind;
    MOZ_TRY(sConnection->CreateStatement(
        "INSERT INTO folder_cache_bindings(folderId,token) VALUES(:id,:token)"_ns,
        getter_AddRefs(bind)));
    for (const auto& folder : input.folders) {
      mozStorageStatementScoper reset(bind);
      MOZ_TRY(bind->BindInt64ByName("id"_ns, folder.id));
      MOZ_TRY(bind->BindUTF8StringByName("token"_ns, input.token));
      MOZ_TRY(bind->Execute());
    }
    nsCString reread;
    MOZ_TRY(ReadCacheBytes(input, reread));
    NS_ENSURE_TRUE(reread == bytes, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(CheckCacheFolders(this, sConnection, input));
    return sConnection->CommitTransaction();
  };
  nsresult rv = apply();
  if (NS_FAILED(rv)) {
    bool pending;
    nsresult cleanup = sConnection->GetTransactionInProgress(&pending);
    if (NS_SUCCEEDED(cleanup) && pending)
      cleanup = sConnection->RollbackTransaction();
    if (NS_FAILED(cleanup)) {
      MOZ_LOG(gPanoramaLog, LogLevel::Error,
              ("Cache import rollback failed: 0x%08x", unsigned(cleanup)));
    }
    return rv;
  }
  // Generic folder properties are read from SQL. No physical folder, counts,
  // flags or live-view caches were changed, so no speculative event is emitted.
  output.set(prepared);
  return NS_OK;
#endif
}

FolderRelocationRecovery::FolderRelocationRecovery(nsCString&& sourceId,
                                                   uint64_t root,
                                                   nsTArray<uint64_t>&& folders,
                                                   nsISupports* owner)
    : mSourceId(std::move(sourceId)),
      mRoot(root),
      mFolders(std::move(folders)),
      mOwner(owner) {}

void FolderRelocationRecovery::BlockAfterFailedRestore(nsresult primaryError,
                                                       nsresult rollbackError) {
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_ASSERT(NS_FAILED(primaryError) && NS_FAILED(rollbackError));
  if (!mBlocked) {
    mPrimaryError = primaryError;
    mRollbackError = rollbackError;
    mBlocked = true;
  }
}

nsresult DatabaseCore::CheckFolderRelocationRecoverySnapshot(
    const nsACString& sourceId, uint64_t root,
    const nsTArray<uint64_t>& capturedFolders) {
  nsCString current;
  MOZ_TRY(ReadSourceIdForFolderAdmission(current));
  NS_ENSURE_TRUE(current == sourceId, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(GetStatement("CheckRecoveryRoot"_ns,
                       "SELECT parent FROM folders WHERE id=:id"_ns,
                       getter_AddRefs(stmt)));
  {
    mozStorageStatementScoper reset(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, root));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
    int32_t type;
    int64_t parent;
    MOZ_TRY(stmt->GetTypeOfIndex(0, &type));
    MOZ_TRY(stmt->GetInt64(0, &parent));
    NS_ENSURE_TRUE(
        type == mozIStorageStatement::VALUE_TYPE_INTEGER && parent >= 0,
        NS_ERROR_FILE_CORRUPTED);
    NS_ENSURE_TRUE(parent, NS_ERROR_UNEXPECTED);
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  }
  nsTArray<uint64_t> remaining = MOZ_TRY(FolderDB().GetFolderDescendants(root));
  remaining.AppendElement(root);
  NS_ENSURE_TRUE(remaining.Length() == capturedFolders.Length(),
                 NS_ERROR_NOT_AVAILABLE);
  for (uint64_t id : capturedFolders) {
    NS_ENSURE_TRUE(remaining.RemoveElement(id), NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(MessageDB().CheckPendingFolderRelocation(id));
  }
  return NS_OK;
}

nsresult DatabaseCore::PrepareFolderRelocationRecovery(
    const nsACString& expectedSourceId, uint64_t root,
    const nsTArray<uint64_t>& capturedFolders, nsISupports* recoveryOwner,
    RefPtr<FolderRelocationRecovery>& output) {
  MOZ_ASSERT(NS_IsMainThread());
  NS_ENSURE_TRUE(sInstance.get() == this && sConnection && mFolderDatabase &&
                     mMessageDatabase && !mShuttingDown,
                 NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(recoveryOwner && !expectedSourceId.IsEmpty() && root &&
                     root <= INT64_MAX && !capturedFolders.IsEmpty(),
                 NS_ERROR_INVALID_ARG);
  for (uint64_t id : capturedFolders) {
    NS_ENSURE_TRUE(id && id <= INT64_MAX, NS_ERROR_INVALID_ARG);
  }
  bool active;
  MOZ_TRY(sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(CheckFolderRelocationRecoverySnapshot(expectedSourceId, root,
                                                capturedFolders));
  for (const auto& existing : mFolderRelocationRecoveries) {
    for (uint64_t id : capturedFolders) {
      if (existing->mFolders.Contains(id)) {
        NS_ENSURE_TRUE(existing->mSourceId == expectedSourceId,
                       NS_ERROR_NOT_AVAILABLE);
        return NS_ERROR_IN_PROGRESS;
      }
    }
  }
  nsTArray<uint64_t> retained;
  if (!retained.AppendElements(capturedFolders, fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  RefPtr<FolderRelocationRecovery> recovery = new FolderRelocationRecovery(
      nsCString(expectedSourceId), root, std::move(retained), recoveryOwner);
  if (!mFolderRelocationRecoveries.AppendElement(recovery, fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  output = std::move(recovery);
  return NS_OK;
}

nsresult DatabaseCore::ValidateFolderRelocationRecovery(
    FolderRelocationRecovery* recovery) {
  MOZ_ASSERT(NS_IsMainThread());
  NS_ENSURE_TRUE(sInstance.get() == this && sConnection && mFolderDatabase &&
                     mMessageDatabase && !mShuttingDown,
                 NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_ARG_POINTER(recovery);
  NS_ENSURE_TRUE(mFolderRelocationRecoveries.Contains(recovery),
                 NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_FALSE(recovery->mBlocked, NS_ERROR_IN_PROGRESS);
  bool active;
  MOZ_TRY(sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  return CheckFolderRelocationRecoverySnapshot(
      recovery->mSourceId, recovery->mRoot, recovery->mFolders);
}

void DatabaseCore::DiscardFolderRelocationRecovery(
    FolderRelocationRecovery* recovery) {
  MOZ_ASSERT(NS_IsMainThread());
  // Success/complete rollback can discard its prepared inactive holder. A
  // failed restore cannot be dismissed by a caller Boolean or object
  // destruction.
  if (recovery && !recovery->mBlocked) {
    mFolderRelocationRecoveries.RemoveElement(recovery);
  }
}

bool DatabaseCore::HasFailedFolderRelocationRecovery() const {
  for (const auto& recovery : mFolderRelocationRecoveries) {
    if (recovery->mBlocked) return true;
  }
  return false;
}

nsresult DatabaseCore::CheckFolderRelocationRecovery(uint64_t folderId) {
  MOZ_ASSERT(NS_IsMainThread());
  NS_ENSURE_TRUE(sInstance.get() == this && sConnection && !mShuttingDown,
                 NS_ERROR_NOT_AVAILABLE);
  for (const auto& recovery : mFolderRelocationRecoveries) {
    if (recovery->mBlocked && recovery->mFolders.Contains(folderId)) {
      nsCString current;
      MOZ_TRY(ReadSourceIdForFolderAdmission(current));
      NS_ENSURE_TRUE(current == recovery->mSourceId, NS_ERROR_NOT_AVAILABLE);
      return NS_ERROR_IN_PROGRESS;
    }
  }
  return NS_OK;
}

nsresult DatabaseCore::ReadSourceIdForFolderAdmission(nsACString& output) {
  NS_ENSURE_TRUE(sInstance.get() == this && sConnection && !mShuttingDown,
                 NS_ERROR_NOT_AVAILABLE);
  return ReadDatabaseSourceId(sConnection, output);
}

NS_IMETHODIMP DatabaseCore::GetSourceId(nsACString& sourceId) {
  if (sInstance.get() != this || !sConnection) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  bool active;
  MOZ_TRY(sConnection->GetTransactionInProgress(&active));
  if (active) {
    return NS_ERROR_IN_PROGRESS;
  }
  return ReadDatabaseSourceId(sConnection, sourceId);
}

NS_IMETHODIMP
DatabaseCore::GetConnectionForTests(mozIStorageConnection** aConnection) {
  if (!xpc::IsInAutomation()) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  NS_ENSURE_ARG_POINTER(aConnection);

  nsresult rv = EnsureConnection();
  NS_ENSURE_SUCCESS(rv, rv);

  NS_IF_ADDREF(*aConnection = sConnection);
  return NS_OK;
}

NS_IMETHODIMP DatabaseCore::OpenFolderDB(nsIMsgFolder* aFolder,
                                         bool aLeaveInvalidDB,
                                         nsIMsgDatabase** _retval) {
  NS_ENSURE_ARG_POINTER(_retval);
  *_retval = nullptr;
  NS_ENSURE_ARG_POINTER(aFolder);
  NS_ENSURE_TRUE(!mShuttingDown && mFolderDatabase && mMessageDatabase,
                 NS_ERROR_NOT_AVAILABLE);
  uint64_t folderId;
  MOZ_TRY(aFolder->GetId(&folderId));
  RefPtr<PerFolderDatabase> db = mOpenDatabases.Get(folderId).get();
  if (db) {
    db.forget(_retval);
    return NS_OK;
  }

  bool isNewsgroup;
  MOZ_TRY(aFolder->GetFlag(nsMsgFolderFlags::Newsgroup, &isNewsgroup));
  nsCOMPtr<nsIFile> filePath;
  MOZ_TRY(aFolder->GetFilePath(getter_AddRefs(filePath)));
  NS_ENSURE_TRUE(filePath, NS_ERROR_UNEXPECTED);
  nsString path;
  MOZ_TRY(filePath->GetPath(path));

  db = new PerFolderDatabase(folderId, isNewsgroup);
  mOpenDatabases.InsertOrUpdate(folderId, db);
  mOpenDatabasesByFile.InsertOrUpdate(path, db);
  db.forget(_retval);
  return NS_OK;
}
NS_IMETHODIMP DatabaseCore::CreateNewDB(nsIMsgFolder* aFolder,
                                        nsIMsgDatabase** _retval) {
  NS_ENSURE_ARG_POINTER(_retval);
  *_retval = nullptr;
  NS_ENSURE_ARG_POINTER(aFolder);
  NS_ENSURE_TRUE(!mShuttingDown && mFolderDatabase && mMessageDatabase,
                 NS_ERROR_NOT_AVAILABLE);
  nsAutoCString name;
  aFolder->GetName(name);
  nsCOMPtr<nsIMsgFolder> msgParent;
  aFolder->GetParent(getter_AddRefs(msgParent));
  uint64_t parentId;
  MOZ_TRY(msgParent->GetId(&parentId));

  // I think the folder should be in the DB by now, but add it if it's not.
  uint64_t folderId = MOZ_TRY(FolderDB().GetFolderChildNamed(parentId, name));
  if (folderId == 0) {
    nsresult rv = FolderDB().InsertFolder(parentId, name, &folderId);
    NS_ENSURE_SUCCESS(rv, rv);
  }

  return OpenFolderDB(aFolder, false, _retval);
}
NS_IMETHODIMP DatabaseCore::OpenDBFromFile(nsIFile* aFile,
                                           nsIMsgFolder* aFolder, bool aCreate,
                                           bool aLeaveInvalidDB,
                                           nsIMsgDatabase** _retval) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP DatabaseCore::RegisterPendingListener(
    nsIMsgFolder* folder, nsIDBChangeListener* listener) {
  // This function was meant to wait for a database to open, but let's just
  // open it. They're not real anyway.
  nsCOMPtr<nsIMsgDatabase> database;
  nsresult rv = OpenFolderDB(folder, false, getter_AddRefs(database));
  NS_ENSURE_SUCCESS(rv, rv);

  return database->AddListener(listener);
}
NS_IMETHODIMP DatabaseCore::UnregisterPendingListener(
    nsIDBChangeListener* listener) {
  return NS_OK;
}
NS_IMETHODIMP DatabaseCore::CachedDBForFolder(nsIMsgFolder* aFolder,
                                              nsIMsgDatabase** _retval) {
  NS_ENSURE_ARG_POINTER(_retval);
  *_retval = nullptr;
  NS_ENSURE_ARG_POINTER(aFolder);
  uint64_t folderId;
  MOZ_TRY(aFolder->GetId(&folderId));
  RefPtr<PerFolderDatabase> db = mOpenDatabases.Get(folderId).get();
  db.forget(_retval);
  return NS_OK;
}
NS_IMETHODIMP DatabaseCore::CachedDBForFilePath(nsIFile* filePath,
                                                nsIMsgDatabase** _retval) {
  NS_ENSURE_ARG_POINTER(_retval);
  *_retval = nullptr;
  NS_ENSURE_ARG_POINTER(filePath);
  nsString path;
  MOZ_TRY(filePath->GetPath(path));
  RefPtr<PerFolderDatabase> db = mOpenDatabasesByFile.Get(path).get();
  db.forget(_retval);
  return NS_OK;
}
NS_IMETHODIMP DatabaseCore::ForceFolderDBClosed(nsIMsgFolder* aFolder) {
  nsCOMPtr<nsIMsgDatabase> db;
  MOZ_TRY(CachedDBForFolder(aFolder, getter_AddRefs(db)));
  return db ? db->ForceClosed() : NS_OK;
}
NS_IMETHODIMP DatabaseCore::GetOpenDBs(
    nsTArray<RefPtr<nsIMsgDatabase>>& aOpenDBs) {
  aOpenDBs.Clear();
  for (auto iter = mOpenDatabases.Iter(); !iter.Done(); iter.Next()) {
    RefPtr<PerFolderDatabase> db = iter.UserData().get();
    if (db) {
      aOpenDBs.AppendElement(db.get());
    } else {
      iter.Remove();
    }
  }
  return NS_OK;
}

NS_IMPL_ISUPPORTS(DatabaseCoreFactory, nsIFactory)

NS_IMETHODIMP DatabaseCoreFactory::CreateInstance(const nsIID& aIID,
                                                  void** aResult) {
  nsresult rv;
  nsCOMPtr<nsIDatabaseCore> core =
      do_GetService("@mozilla.org/mailnews/database-core;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  *aResult = (void*)(core);
  return NS_OK;
}

}  // namespace mozilla::mailnews
