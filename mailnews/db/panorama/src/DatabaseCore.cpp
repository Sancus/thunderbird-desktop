/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "DatabaseCore.h"

#include <utility>

#include "DatabaseUtils.h"
#include "FolderDatabase.h"
#include "Message.h"
#include "MessageDatabase.h"
#include "mozilla/Components.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/Logging.h"
#include "mozilla/ProfilerMarkers.h"
#include "mozilla/Services.h"
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
#include "nsIFile.h"
#include "nsIInputStream.h"
#include "nsILineInputStream.h"
#include "nsIMimeConverter.h"
#include "nsIObserverService.h"
#include "nsMsgFolderFlags.h"
#include "nsMsgUtils.h"
#include "nsNetUtil.h"
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

  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("DatabaseCore shutting down"));

  for (auto iter = sStatements.Iter(); !iter.Done(); iter.Next()) {
    iter.UserData()->Finalize();
  }
  sStatements.Clear();

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
        nsresult removeRv = databaseFile->Remove(false);
        NS_WARNING_ASSERTION(
            NS_SUCCEEDED(removeRv),
            "Failed to remove a newly created, rolled-back database");
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
  MOZ_TRY(UpgradeReferencesSchema());
  MOZ_TRY(sConnection->CommitTransaction());
  transactionGuard.release();
  schemaCommitted = true;
  sDatabaseIsNew = !exists;

  rv = sConnection->ExecuteSimpleSQL("PRAGMA cache_size=-200000;"_ns);
  NS_ENSURE_SUCCESS(rv, rv);
  RefPtr<TagsMatchFunction> tagsInclude = new TagsMatchFunction(true);
  sConnection->CreateFunction("tags_include"_ns, 2, tagsInclude);
  RefPtr<TagsMatchFunction> tagsExclude = new TagsMatchFunction(false);
  sConnection->CreateFunction("tags_exclude"_ns, 2, tagsExclude);
  RefPtr<AddressFormatFunction> addressFormat = new AddressFormatFunction();
  sConnection->CreateFunction("address_format"_ns, 1, addressFormat);
  RefPtr<GroupedByDateFunction> dateGroup = new GroupedByDateFunction();
  sConnection->CreateFunction("date_group"_ns, 1, dateGroup);

  connectionGuard.release();
  return NS_OK;
}

namespace {

constexpr auto kReferenceDeleteTrigger =
    "CREATE TRIGGER delete_message_references AFTER DELETE ON messages BEGIN "
    "DELETE FROM message_references WHERE id = OLD.id; "
    "DELETE FROM message_reference_sets WHERE id = OLD.id; END"_ns;

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

nsresult DatabaseCore::UpgradeReferencesSchema() {
  int32_t version;
  MOZ_TRY(sConnection->GetSchemaVersion(&version));
  NS_ENSURE_TRUE(version == 0 || version == 1, NS_ERROR_NOT_AVAILABLE);
  // Both the original production schema and the old test fixture have these
  // columns. References discarded by either layout cannot be reconstructed.
  static constexpr struct {
    const char* table;
    const char* columns;
  } layouts[] = {
      {"folders",
       "id:INTEGER:0:1,parent:INTEGER:0:0,ordinal:INTEGER:0:0,name:TEXT:0:0,"
       "flags:INTEGER:0:0"},
      {"folder_properties", "id:INTEGER:0:1,name:TEXT:0:2,value:ANY:0:0"},
      {"messages",
       "id:INTEGER:0:1,folderId:INTEGER:0:0,threadId:INTEGER:0:0,threadParent:"
       "INTEGER:0:0,messageId:TEXT:0:0,date:INTEGER:0:0,sender:TEXT:0:0,"
       "recipients:TEXT:0:0,ccList:TEXT:0:0,bccList:TEXT:0:0,subject:TEXT:0:0,"
       "flags:INTEGER:0:0,tags:TEXT:0:0,priority:INTEGER:0:0"},
      {"message_properties", "id:INTEGER:0:1,name:TEXT:0:2,value:ANY:0:0"},
      {"virtualFolder_folders",
       "virtualFolderId:INTEGER:0:0,searchFolderId:INTEGER:0:0"},
      {"search_folder_hits", "folder_id:INTEGER:0:1,message_id:INTEGER:0:2"},
  };
  for (const auto& layout : layouts) {
    MOZ_TRY(
        CheckReferenceSchemaTable(sConnection, layout.table, layout.columns));
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

  struct MessageData {
    nsTArray<nsCString> references;
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
                                  folderId, messageId, date, sender, recipients, ccList, bccList, subject, flags, tags \
                                ) VALUES ( \
                                  :folderId, :messageId, :date, :sender, :recipients, :ccList, :bccList, :subject, :flags, :tags \
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

NS_IMETHODIMP
DatabaseCore::MigrateFolderDatabase(nsIMsgFolder* srcFolder, JSContext* aCx,
                                    Promise** aPromise) {
  AUTO_PROFILER_LABEL("DatabaseCore::MigrateFolderDatabase", MAILNEWS);

  ErrorResult err;
  RefPtr<Promise> promise = Promise::Create(xpc::CurrentNativeGlobal(aCx), err);

  RefPtr<FolderMigrator> migrator = new FolderMigrator();
  nsresult rv = migrator->SetupAndRun(srcFolder, promise);
  NS_ENSURE_SUCCESS(rv, rv);

  promise.forget(aPromise);
  return NS_OK;
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
  uint64_t folderId;
  aFolder->GetId(&folderId);
  WeakPtr<PerFolderDatabase> existingDatabase = mOpenDatabases.Get(folderId);
  if (existingDatabase) {
    NS_IF_ADDREF(*_retval = existingDatabase);
    return NS_OK;
  }

  bool isNewsgroup;
  aFolder->GetFlag(nsMsgFolderFlags::Newsgroup, &isNewsgroup);
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(folderId, isNewsgroup);
  NS_IF_ADDREF(*_retval = db);

  mOpenDatabases.InsertOrUpdate(folderId, db);

  nsCOMPtr<nsIFile> filePath;
  nsresult rv = aFolder->GetFilePath(getter_AddRefs(filePath));
  NS_ENSURE_SUCCESS(rv, rv);

  nsString path;
  rv = filePath->GetPath(path);
  NS_ENSURE_SUCCESS(rv, rv);
  mOpenDatabasesByFile.InsertOrUpdate(path, db);

  return NS_OK;
}
NS_IMETHODIMP DatabaseCore::CreateNewDB(nsIMsgFolder* aFolder,
                                        nsIMsgDatabase** _retval) {
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
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP DatabaseCore::CachedDBForFilePath(nsIFile* filePath,
                                                nsIMsgDatabase** _retval) {
  nsString path;
  nsresult rv = filePath->GetPath(path);
  NS_ENSURE_SUCCESS(rv, rv);

  WeakPtr<PerFolderDatabase> existingDatabase = mOpenDatabasesByFile.Get(path);
  if (existingDatabase) {
    NS_IF_ADDREF(*_retval = existingDatabase);
    return NS_OK;
  }

  return NS_ERROR_FAILURE;
}
NS_IMETHODIMP DatabaseCore::ForceFolderDBClosed(nsIMsgFolder* aFolder) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP DatabaseCore::GetOpenDBs(
    nsTArray<RefPtr<nsIMsgDatabase>>& aOpenDBs) {
  aOpenDBs.Clear();
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
