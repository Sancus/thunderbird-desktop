/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_DB_PANORAMA_SRC_DATABASECORE_H_
#define COMM_MAILNEWS_DB_PANORAMA_SRC_DATABASECORE_H_

#include <functional>

#include "FolderDatabase.h"
#include "MessageDatabase.h"
#include "mozilla/RefCounted.h"
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
class nsIAsyncShutdownBlocker;
class nsMsgDBFolder;
namespace mozilla::dom {
class Promise;
}

namespace mozilla::mailnews {

class ProfileStartupOperation;
class PerFolderDatabase;
struct CacheImport;
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

// Private version3 connected import. All references name original member tokens
// and physical source keys; only the owning transaction assigns native keys.
struct ImapImportReference {
  nsCString token;
  nsMsgKey sourceKey{nsMsgKey_None};
};

struct ImapImportUid {
  nsMsgKey sourceKey{nsMsgKey_None};
  uint32_t uid{0};
};

struct ImapImportOperation {
  nsMsgKey sourceKey{nsMsgKey_None};
  OfflineOperationData payload;
  // Presence of the twelve optional typed payload fields in the saved row.
  uint32_t payloadPresence{0};
  Maybe<ImapImportReference> source;
  Maybe<ImapImportReference> destination;
  nsTArray<Maybe<ImapImportReference>> copies;
};

struct ImapImportBody {
  nsMsgKey sourceKey{nsMsgKey_None};
  uint32_t size{0};
  nsCString sha256;
};

struct ImapImportFolder {
  FolderImportSnapshot snapshot;
  nsCOMPtr<nsIMsgFolder> folder;
  nsCString uri;
  Maybe<uint32_t> uidValidity;
  nsTArray<ImapImportUid> serverUids;
  nsTArray<ImapImportOperation> operations;
  nsTArray<ImapImportBody> bodies;
};

struct ImapImportUnit {
  nsCString token;
  nsCString databaseSourceId;
  nsTArray<ImapImportFolder> folders;
};

struct ImapImportOperationReceipt {
  nsMsgKey sourceKey{nsMsgKey_None};
  nsMsgKey key{nsMsgKey_None};
  uint64_t id{0};
  uint64_t revision{0};
};

struct ImapImportFolderReceipt {
  FolderImportReceipt folder;
  Maybe<uint32_t> uidValidity;
  nsTArray<ImapImportUid> serverUids;
  nsTArray<ImapImportOperationReceipt> operations;
};

struct ImapImportReceipt {
  nsCString token;
  nsCString databaseSourceId;
  nsTArray<ImapImportFolderReceipt> folders;
};

// One prepared folder operation. The protocol/local owner retains its exact
// storage plan and path/error snapshots through the strong nsISupports owner.
// No storage I/O or retry occurs on destruction. Main-thread use only.
class FolderRelocationRecovery final
    : public RefCounted<FolderRelocationRecovery> {
 public:
  MOZ_DECLARE_REFCOUNTED_TYPENAME(FolderRelocationRecovery)

  // Allocation-free, before releasing active wrapper references on failure.
  // First failure wins. A blocked holder has no unchecked release operation.
  void BlockAfterFailedRestore(nsresult primaryError, nsresult rollbackError);
  nsresult PrimaryError() const { return mPrimaryError; }
  nsresult RollbackError() const { return mRollbackError; }

 private:
  friend class DatabaseCore;
  friend class mozilla::detail::RefCounted<FolderRelocationRecovery,
                                           mozilla::detail::NonAtomicRefCount>;
  FolderRelocationRecovery(nsCString&& sourceId, uint64_t root,
                           nsTArray<uint64_t>&& folders, nsISupports* owner);
  ~FolderRelocationRecovery() = default;

  nsCString mSourceId;
  uint64_t mRoot;
  nsTArray<uint64_t> mFolders;
  nsCOMPtr<nsISupports> mOwner;
  bool mBlocked{false};
  nsresult mPrimaryError{NS_OK};
  nsresult mRollbackError{NS_OK};
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

  // Account construction may bind verified metadata; ordinary loading may not
  // run while selected startup is unresolved. Never creates a database.
  static nsresult CheckAccountStartup(bool metadata = false,
                                      const nsACString* serverKey = nullptr);

  // Retains the actual initialized account shutdown owner for selected native
  // startup. No account service is created by failure/shutdown settlement.
  static void RetainStartupAccount(nsIAsyncShutdownBlocker* account);

  // Retires SQL folder identities only; never opens a core or removes files.
  static nsresult RetireAccountRoot(uint64_t folderId,
                                    const nsACString& serverKey,
                                    const nsACString& databaseSourceId);

  // Private native folder-operation boundary, not an XPCOM API. Prepare before
  // I/O, revalidate before Apply, and discard only an unblocked completed plan.
  // The owner must not strongly retain this core, this token, or a wrapper/PFD
  // ancestry that retains this core. Failure leaves output unchanged.
  nsresult PrepareFolderRelocationRecovery(
      const nsACString& expectedSourceId, uint64_t root,
      const nsTArray<uint64_t>& capturedFolders, nsISupports* recoveryOwner,
      RefPtr<FolderRelocationRecovery>& output);
  nsresult ValidateFolderRelocationRecovery(FolderRelocationRecovery* recovery);
  void DiscardFolderRelocationRecovery(FolderRelocationRecovery* recovery);
  // Does not open a core, own SQL, or erase numeric diagnostic identities.
  nsresult CheckFolderRelocationRecovery(uint64_t folderId);

  FolderDatabase& FolderDB() { return *mFolderDatabase; }
  MessageDatabase& MessageDB() { return *mMessageDatabase; }

  // Native converted snapshot boundary; no legacy database service is started.
  nsresult ImportFolderSnapshot(nsIMsgFolder* source,
                                const FolderImportSnapshot& input,
                                FolderImportReceipt& output);
  nsresult GetFolderImportReceipt(const FolderImportIdentity& identity,
                                  Maybe<FolderImportReceipt>& output);

 protected:
  virtual ~DatabaseCore();

 private:
  friend class ::nsMsgDBFolder;
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
  nsCString mCacheOriginGeneration;  // Empty after reopening an existing DB.
#ifndef XP_WIN
  nsresult CheckStartupCachePublication(JSContext* cx,
                                        const CacheImport& input);
  nsresult ImportFolderCacheMetadataV2(CacheImport& input, JSContext* cx,
                                       JS::MutableHandle<JS::Value> output);
#endif
  static nsCOMPtr<mozIStorageConnection> sConnection;
  static nsTHashMap<nsCString, nsCOMPtr<mozIStorageStatement>> sStatements;

  // PerFolderDatabase captures this once when admitted. Reads the current
  // transaction without owning it; a rolled-back source change leaves that
  // captured identity stale. Never creates/opens a core or rebinds a wrapper.
  // Failure leaves output unchanged. Public GetSourceId still requires no TX.
  nsresult ReadSourceIdForFolderAdmission(nsACString& output);

  static nsresult EnsureConnection(bool aAllowNewConnection = false);
  static nsresult CreateNewDatabase();
  static nsresult UpgradeSchema();
  // Caller owns the insert transaction; the insert advances the high-water
  // mark.
  static nsresult GetNextMessageKey(nsMsgKey& key);
  nsresult ImportFolderSnapshotFromFile(nsIFile* source,
                                        const FolderImportSnapshot& input,
                                        FolderImportReceipt& output);
  // Existing friend fixture exercises the real raw validator; no caller API.
  static nsresult CheckImportRecordsForTesting(JSContext* cx,
                                               JS::Handle<JSObject*> request,
                                               nsIMsgFolder* folder,
                                               FolderImportSnapshot& input,
                                               ImapImportFolder* imap);
  nsresult CheckFolderImportIdentity(const FolderImportIdentity& identity);
  nsresult ReadFolderImportReceipt(const FolderImportIdentity& identity,
                                   Maybe<FolderImportReceipt>& output);
  nsresult WriteImportedMessage(uint64_t folderId, nsMsgKey key, nsMsgKey root,
                                nsMsgKey parent, const RawHdr& header);

  // Native-only complete unit; callbacks run after the entire SQL commit and
  // output installation. The bridge may preallocate JS output before commit.
  nsresult ImportImapUnit(
      const ImapImportUnit& input, ImapImportReceipt& output,
      const std::function<nsresult(const ImapImportReceipt&)>& prepare = {},
      const std::function<void()>& publish = {});
  nsresult ReadImapImportReceipt(const ImapImportUnit& input,
                                 const nsACString& provenance,
                                 Maybe<ImapImportReceipt>& output);

  static nsresult GetStatement(const nsACString& aName, const nsACString& aSQL,
                               mozIStorageStatement** aStmt);
  static nsresult CreateSavepoint(const nsACString& name);
  static nsresult ReleaseSavepoint(const nsACString& name);
  static nsresult RollbackToSavepoint(const nsACString& name);

  nsresult CheckFolderRelocationRecoverySnapshot(
      const nsACString& sourceId, uint64_t root,
      const nsTArray<uint64_t>& capturedFolders);
  bool HasFailedFolderRelocationRecovery() const;
  nsTArray<RefPtr<FolderRelocationRecovery>> mFolderRelocationRecoveries;

  nsresult ArmProfileStartup(nsIFile* profile, nsIFile* localProfile);
  nsresult CheckProfileStartup(nsISupports* operation, bool metadata = false);
  nsresult DescribeProfileStartup(JSContext* cx,
                                  JS::MutableHandle<JS::Value> output);
  nsresult OpenProfileStartup(JSContext* cx, JS::Handle<JS::Value> plan);
  nsresult BuildStartupFolders();
  nsresult CheckProfileActivation(JSContext* cx,
                                  JS::Handle<JS::Value> activation);
  nsresult SettleProfileStartup(nsresult firstError);
  nsISupports* ProfileStartupToken();
  RefPtr<ProfileStartupOperation> mProfileStartup;
  nsTArray<RefPtr<mozilla::dom::Promise>> mStartupBegins;
  nsCOMPtr<nsIAsyncShutdownBlocker> mStartupAccount;
  bool mStartupBeginRequested = false;
  bool mStartupManaged = false;
  bool mStartupObserved = false;
  nsresult mStartupFailure = NS_OK;
  bool mStartupOpening = false;
  bool mStartupClosePending = false;
  uint32_t mStartupMetadataDepth = 0;

  bool mShuttingDown = false;
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
