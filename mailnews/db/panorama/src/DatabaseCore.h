/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_DB_PANORAMA_SRC_DATABASECORE_H_
#define COMM_MAILNEWS_DB_PANORAMA_SRC_DATABASECORE_H_

#include "FolderDatabase.h"
#include "MessageDatabase.h"
#include "mozilla/RefPtr.h"
#include "mozilla/StaticPtr.h"
#include "mozilla/WeakPtr.h"
#include "nsCOMPtr.h"
#include "nsIDatabaseCore.h"
#include "nsIFactory.h"
#include "nsIMsgDatabase.h"
#include "nsIObserver.h"
#include "nsTHashMap.h"

#define DATABASE_CORE_CID \
  {0xbb308d0b, 0xbb99, 0x4699, {0x89, 0xde, 0x42, 0x82, 0x65, 0x2d, 0x0e, 0x16}}

class mozIStorageConnection;
class mozIStorageStatement;
class nsIFile;

namespace mozilla::mailnews {

class PerFolderDatabase;
class DeliveryCoreMessageExistence;
class DeliveryCoreReferences;
class DeliveryCoreProperties;
class DeliveryFolderInfoProperties;
class DeliveryMessageReferences;

// Windows v2 retains original inventory spellings separately from native
// results.
struct FolderImportPathIdentity {
  nsString originalPath;
  nsString originalRoot;
  nsString canonicalPath;
  nsString canonicalRoot;
  nsCString id;
  nsCString parentId;
  nsCString rootId;
};

struct FolderImportWindowsIdentity {
  FolderImportPathIdentity summary;
  FolderImportPathIdentity store;
};

struct FolderImportIdentity {
  nsCString token;
  nsCString sourceId;
  nsCString databaseSourceId;
  nsCString sourceSha256;
  uint64_t folderId{0};
  nsCString folderPath;
  nsString sourcePath;
  Maybe<FolderImportWindowsIdentity> windows;
};

struct FolderImportMessage {
  nsMsgKey sourceKey{nsMsgKey_None};
  nsMsgKey rootSourceKey{nsMsgKey_None};
  Maybe<nsMsgKey> parentSourceKey;
  RawHdr header;
};

struct FolderImportProperty {
  nsCString name;
  nsCString text;
  Maybe<int64_t> integer;
};

struct FolderImportSnapshot {
  FolderImportIdentity identity;
  uint64_t sourceSize{0};
  nsTArray<FolderImportMessage> messages;
  nsTArray<FolderImportProperty> folderProperties;
  // Set only after accounting for every required source row/table.
  bool recordsComplete{false};
  nsTArray<nsCString> unhandledRecords;
};

struct FolderImportKey {
  nsMsgKey source{nsMsgKey_None};
  nsMsgKey destination{nsMsgKey_None};
};

struct FolderImportReceipt {
  FolderImportIdentity identity;
  nsTArray<FolderImportKey> keys;
};

class DatabaseCore : public nsIDatabaseCore,
                     public nsIMsgDBService,
                     public nsIObserver {
 public:
  DatabaseCore();

  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIDATABASECORE
  NS_DECL_NSIMSGDBSERVICE
  NS_DECL_NSIOBSERVER

  static already_AddRefed<DatabaseCore> GetInstanceForService();

  // Retires SQL folder identities only; never opens a core or removes files.
  static nsresult RetireAccountRoot(uint64_t folderId,
                                    const nsACString& serverKey,
                                    const nsACString& databaseSourceId);

  FolderDatabase& FolderDB() { return *mFolderDatabase; }
  MessageDatabase& MessageDB() { return *mMessageDatabase; }

  // Native converted snapshot boundary; no legacy database service is started.
  nsresult ImportFolderSnapshot(nsIMsgFolder* source,
                                const FolderImportSnapshot& input,
                                FolderImportReceipt& output);
  nsresult GetFolderImportReceipt(const FolderImportIdentity& identity,
                                  Maybe<FolderImportReceipt>& output);

 protected:
  virtual ~DatabaseCore() {};

 private:
  friend class DeliveryCoreMessageExistence;
  friend class DeliveryCoreReferences;
  friend class DeliveryCoreProperties;
  friend class DeliveryFolderInfoProperties;
  friend class DeliveryMessageReferences;
  friend class FolderDatabase;
  friend class FolderInfo;
  friend class FolderMigrator;
  friend class LiveView;
  friend class Message;
  friend class MessageDatabase;
  friend class PerFolderDatabase;
  friend class SearchFolderHitsCache;
  friend class Thread;
  friend class ThreadMessageEnumerator;
  friend class VirtualFolderWrapper;

  static StaticRefPtr<DatabaseCore> sInstance;
  static bool sDatabaseIsNew;  // If the database was created in this session.
  static nsCOMPtr<mozIStorageConnection> sConnection;
  static nsTHashMap<nsCString, nsCOMPtr<mozIStorageStatement>> sStatements;

  static nsresult EnsureConnection();
  static nsresult CreateNewDatabase();
  static nsresult UpgradeSchema();
  // Caller owns the insert transaction; the insert advances the high-water mark.
  static nsresult GetNextMessageKey(nsMsgKey& key);
  nsresult ImportFolderSnapshotFromFile(nsIFile* source,
                                        const FolderImportSnapshot& input,
                                        FolderImportReceipt& output);
  nsresult CheckFolderImportIdentity(const FolderImportIdentity& identity);
  nsresult ReadFolderImportReceipt(const FolderImportIdentity& identity,
                                   Maybe<FolderImportReceipt>& output);
  nsresult WriteImportedMessage(uint64_t folderId, nsMsgKey key, nsMsgKey root,
                                nsMsgKey parent, const RawHdr& header);

  static nsresult GetStatement(const nsACString& aName, const nsACString& aSQL,
                               mozIStorageStatement** aStmt);
  static nsresult CreateSavepoint(const nsACString& name);
  static nsresult ReleaseSavepoint(const nsACString& name);
  static nsresult RollbackToSavepoint(const nsACString& name);

  RefPtr<FolderDatabase> mFolderDatabase;
  RefPtr<MessageDatabase> mMessageDatabase;

  nsTHashMap<uint64_t, WeakPtr<PerFolderDatabase>> mOpenDatabases;
  nsTHashMap<nsString, WeakPtr<PerFolderDatabase>> mOpenDatabasesByFile;
};

class DatabaseCoreFactory final : public nsIFactory {
  NS_DECL_ISUPPORTS
  NS_DECL_NSIFACTORY

 private:
  ~DatabaseCoreFactory() = default;
};

}  // namespace mozilla::mailnews

#endif  // COMM_MAILNEWS_DB_PANORAMA_SRC_DATABASECORE_H_
