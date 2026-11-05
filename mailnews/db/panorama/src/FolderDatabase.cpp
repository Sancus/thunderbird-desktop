/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "FolderDatabase.h"

#include <utility>

#include <charconv>
#include <cstdint>

#include "DatabaseCore.h"
#include "mozilla/Base64.h"
#include "DatabaseUtils.h"
#include "FolderComparator.h"
#include "mozilla/Components.h"
#include "mozilla/Logging.h"
#include "mozilla/ProfilerMarkers.h"
#include "mozilla/fallible.h"
#include "mozIStorageConnection.h"
#include "mozIStorageStatement.h"
#include "mozStorageHelper.h"
#include "nsCOMPtr.h"
#include "nsCharSeparatedTokenizer.h"
#include "nsIMsgAccountManager.h"
#include "nsIMsgIncomingServer.h"
#include "nsMsgFolderFlags.h"
#include "nsMsgUtils.h"       // For PercentEncode().
#include "nsReadableUtils.h"  // For StringJoin().
#include "nsThreadUtils.h"

using mozilla::LazyLogModule;
using mozilla::LogLevel;
using mozilla::MarkerOptions;
using mozilla::MarkerTiming;

namespace mozilla::mailnews {

extern LazyLogModule gPanoramaLog;  // Defined by DatabaseCore.

namespace {
nsresult RollbackFolderUpdate(mozIStorageConnection* connection,
                              nsresult original) {
  bool active;
  nsresult cleanup = connection->GetTransactionInProgress(&active);
  if (NS_SUCCEEDED(cleanup) && active) {
    cleanup = connection->RollbackTransaction();
  }
  if (NS_FAILED(cleanup)) {
    MOZ_LOG(gPanoramaLog, LogLevel::Error,
            ("Folder update rollback failed: 0x%08x",
             static_cast<uint32_t>(cleanup)));
  }
  return original;
}
}  // namespace

NS_IMPL_ISUPPORTS(FolderDatabase, nsIFolderDatabase)

CacheDiscoveryFlagWrite::CacheDiscoveryFlagWrite(
    FolderDatabase* owner, nsCString source, nsCString generation,
    uint64_t folder, uint64_t revision, uint32_t flags,
    CacheDiscoveryFlagSite site)
    : mOwner(owner),
      mSource(std::move(source)),
      mGeneration(std::move(generation)),
      mFolder(folder),
      mRevision(revision),
      mFlags(flags),
      mSite(site) {}

CacheDiscoveryFlagWrite::CacheDiscoveryFlagWrite(
    CacheDiscoveryFlagWrite&& other)
    : mOwner(std::exchange(other.mOwner, nullptr)),
      mSource(std::move(other.mSource)),
      mGeneration(std::move(other.mGeneration)),
      mFolder(other.mFolder),
      mRevision(other.mRevision),
      mFlags(other.mFlags),
      mSite(other.mSite) {}

nsresult FolderDatabase::CheckCacheOriginSource(
    const nsACString& expectedSourceId) {
  MOZ_TRY(RequireCurrentOwner());
  nsCString source;
  MOZ_TRY(DatabaseCore::sInstance->ReadSourceIdForFolderAdmission(source));
  NS_ENSURE_TRUE(!expectedSourceId.IsEmpty() && source == expectedSourceId,
                 NS_ERROR_NOT_AVAILABLE);
  return NS_OK;
}

nsresult FolderDatabase::HasCacheImportBinding(uint64_t folderId, bool& bound) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::sConnection->CreateStatement(
      "SELECT 1 FROM folder_cache_bindings WHERE folderId=:id"_ns,
      getter_AddRefs(stmt)));
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, folderId));
  return stmt->ExecuteStep(&bound);
}

nsresult FolderDatabase::ReadCacheOrigin(uint64_t folderId,
                                         Maybe<CacheOrigin>& output) {
  MOZ_TRY(RequireCurrentOwner());
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::sConnection->CreateStatement(
      "SELECT value FROM folder_properties WHERE id=:id AND "
      "name='panoramaCacheImportOrigin'"_ns,
      getter_AddRefs(stmt)));
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, folderId));
  bool row;
  MOZ_TRY(stmt->ExecuteStep(&row));
  if (!row) {
    output = Nothing();
    return NS_OK;
  }
  int32_t type;
  MOZ_TRY(stmt->GetTypeOfIndex(0, &type));
  NS_ENSURE_TRUE(type == mozIStorageStatement::VALUE_TYPE_TEXT,
                 NS_ERROR_FILE_CORRUPTED);
  nsCString text;
  MOZ_TRY(stmt->GetUTF8String(0, text));
  nsTArray<nsCString> parts;
  for (const auto& part : text.Split('\n'))
    parts.AppendElement(nsCString(part));
  NS_ENSURE_TRUE(parts.Length() == 13 && parts[0] == "1"_ns,
                 NS_ERROR_FILE_CORRUPTED);
  CacheOrigin value;
  value.source = parts[1];
  value.generation = parts[2];
  MOZ_TRY(Base64Decode(parts[5], value.name));
  auto number = [&](uint32_t index, uint64_t& result) -> nsresult {
    const auto& input = parts[index];
    const char* end = input.EndReading();
    auto parsed = std::from_chars(input.BeginReading(), end, result);
    NS_ENSURE_TRUE(
        !input.IsEmpty() && parsed.ec == std::errc() && parsed.ptr == end,
        NS_ERROR_FILE_CORRUPTED);
    return NS_OK;
  };
  MOZ_TRY(number(3, value.id));
  MOZ_TRY(number(4, value.parent));
  uint64_t site, mask, pending, used, sealed;
  MOZ_TRY(number(6, site));
  MOZ_TRY(number(7, mask));
  MOZ_TRY(number(8, value.revision));
  MOZ_TRY(number(9, pending));
  MOZ_TRY(number(10, used));
  MOZ_TRY(number(11, sealed));
  NS_ENSURE_TRUE(value.id == folderId && value.id && value.id <= INT64_MAX &&
                     value.parent <= INT64_MAX && site <= 3 &&
                     mask <= UINT32_MAX && !(mask & ~kCacheClientMask) &&
                     pending <= 5 && used <= 31 && sealed <= 1 &&
                     parts[12] == "end"_ns && !value.source.IsEmpty() &&
                     !value.generation.IsEmpty() && value.revision &&
                     value.revision < INT64_MAX,
                 NS_ERROR_FILE_CORRUPTED);
  value.birthSite = site;
  value.explicitMask = mask;
  value.pending = pending;
  value.used = used;
  value.sealed = sealed;
  MOZ_TRY(CheckCacheOriginSource(value.source));
  MOZ_TRY(stmt->ExecuteStep(&row));
  NS_ENSURE_FALSE(row, NS_ERROR_FILE_CORRUPTED);
  output = Some(std::move(value));
  return NS_OK;
}

nsresult FolderDatabase::WriteCacheOrigin(const CacheOrigin& origin) {
  nsCString encoded;
  MOZ_TRY(Base64Encode(origin.name, encoded));
  nsCString text("1\n");
  text.Append(origin.source);
  text.Append('\n');
  text.Append(origin.generation);
  for (uint64_t value : {origin.id, origin.parent}) {
    text.Append('\n');
    text.AppendInt(value);
  }
  text.Append('\n');
  text.Append(encoded);
  for (uint64_t value :
       {uint64_t(origin.birthSite), uint64_t(origin.explicitMask),
        origin.revision, uint64_t(origin.pending), uint64_t(origin.used),
        uint64_t(origin.sealed)}) {
    text.Append('\n');
    text.AppendInt(value);
  }
  text.AppendLiteral("\nend");
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::sConnection->CreateStatement(
      "REPLACE INTO folder_properties(id,name,value) VALUES "
      "(:id,'panoramaCacheImportOrigin',:value)"_ns,
      getter_AddRefs(stmt)));
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, origin.id));
  MOZ_TRY(stmt->BindUTF8StringByName("value"_ns, text));
  MOZ_TRY(stmt->Execute());
  stmt = nullptr;
  Maybe<CacheOrigin> stored;
  MOZ_TRY(ReadCacheOrigin(origin.id, stored));
  NS_ENSURE_TRUE(
      stored && stored->source == origin.source &&
          stored->generation == origin.generation &&
          stored->name == origin.name && stored->parent == origin.parent &&
          stored->birthSite == origin.birthSite &&
          stored->explicitMask == origin.explicitMask &&
          stored->revision == origin.revision &&
          stored->pending == origin.pending && stored->used == origin.used &&
          stored->sealed == origin.sealed,
      NS_ERROR_FILE_CORRUPTED);
  return NS_OK;
}

nsresult FolderDatabase::CheckCacheOriginLocation(const CacheOrigin& origin) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::sConnection->CreateStatement(
      "SELECT parent,name FROM folders WHERE id=:id"_ns, getter_AddRefs(stmt)));
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, origin.id));
  bool row;
  MOZ_TRY(stmt->ExecuteStep(&row));
  NS_ENSURE_TRUE(row, NS_ERROR_NOT_AVAILABLE);
  int64_t parent;
  nsCString name;
  MOZ_TRY(stmt->GetInt64(0, &parent));
  MOZ_TRY(stmt->GetUTF8String(1, name));
  NS_ENSURE_TRUE(
      parent >= 0 && uint64_t(parent) == origin.parent && name == origin.name,
      NS_ERROR_NOT_AVAILABLE);
  return NS_OK;
}

nsresult FolderDatabase::InsertCacheOrigin(uint64_t id, uint64_t parent,
                                           const nsACString& name,
                                           CacheDiscoveryFlagSite site) {
  auto* core = DatabaseCore::sInstance.get();
  if (core->mCacheOriginGeneration.IsEmpty()) return NS_OK;
  CacheOrigin origin;
  MOZ_TRY(core->ReadSourceIdForFolderAdmission(origin.source));
  origin.generation = core->mCacheOriginGeneration;
  origin.id = id;
  origin.parent = parent;
  origin.name = name;
  origin.birthSite = uint32_t(site);
  origin.revision = 1;
  return WriteCacheOrigin(origin);
}

nsresult FolderDatabase::RecordCacheClientFlagAttempt(
    const nsACString& expectedSourceId, uint64_t folderId,
    uint32_t attemptedClientMask) {
  MOZ_TRY(CheckCacheOriginSource(expectedSourceId));
  NS_ENSURE_TRUE(!(attemptedClientMask & ~kCacheClientMask),
                 NS_ERROR_INVALID_ARG);
  // Sealed/reopened or already tainted captures cannot confer new adoption.
  // Preserve ordinary native writer behavior outside the live capture window.
  const auto& generation = DatabaseCore::sInstance->mCacheOriginGeneration;
  if (!attemptedClientMask || generation.IsEmpty() || mCacheOriginTainted)
    return NS_OK;
  bool bound;
  MOZ_TRY(HasCacheImportBinding(folderId, bound));
  if (bound) return NS_OK;  // Both immutable receipt policies end new adoption.
  Maybe<CacheOrigin> origin;
  MOZ_TRY(ReadCacheOrigin(folderId, origin));
  if (!origin || origin->sealed || origin->generation != generation)
    return NS_OK;
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  if (active) {
    mCacheOriginTainted = true;
    return NS_ERROR_IN_PROGRESS;
  }
  auto connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  auto apply = [&]() -> nsresult {
    Maybe<CacheOrigin> current;
    MOZ_TRY(ReadCacheOrigin(folderId, current));
    NS_ENSURE_TRUE(current, NS_ERROR_NOT_AVAILABLE);
    current->explicitMask |= attemptedClientMask;
    NS_ENSURE_TRUE(current->revision < INT64_MAX - 1, NS_ERROR_ILLEGAL_VALUE);
    ++current->revision;
    MOZ_TRY(WriteCacheOrigin(*current));
    return connection->CommitTransaction();
  };
  nsresult rv = apply();
  if (NS_FAILED(rv)) {
    mCacheOriginTainted = true;
    return RollbackFolderUpdate(connection, rv);
  }
  return NS_OK;
}

nsresult FolderDatabase::ObserveCacheFolderInitialization(
    const nsACString& expectedSourceId, uint64_t folderId,
    uint32_t prebindExplicitClientMask) {
  MOZ_TRY(CheckCacheOriginSource(expectedSourceId));
  NS_ENSURE_TRUE(folderId && MOZ_TRY(GetFolderRoot(folderId)),
                 NS_ERROR_NOT_AVAILABLE);
  return RecordCacheClientFlagAttempt(expectedSourceId, folderId,
                                      prebindExplicitClientMask);
}

nsresult FolderDatabase::HasCacheDiscoveryOrigin(
    const nsACString& expectedSourceId, uint64_t folderId, bool& tracked) {
  MOZ_TRY(CheckCacheOriginSource(expectedSourceId));
  Maybe<CacheOrigin> origin;
  MOZ_TRY(ReadCacheOrigin(folderId, origin));
  tracked =
      origin && !mCacheOriginTainted && !origin->sealed && !origin->pending &&
      !origin->generation.IsEmpty() &&
      origin->generation == DatabaseCore::sInstance->mCacheOriginGeneration;
  return NS_OK;
}

Result<CacheDiscoveryFlagWrite, nsresult>
FolderDatabase::BeginCacheDiscoveryFlags(const nsACString& expectedSourceId,
                                         uint64_t folderId,
                                         CacheDiscoveryFlagSite site) {
  MOZ_TRY(CheckCacheOriginSource(expectedSourceId));
  NS_ENSURE_TRUE(uint32_t(site) <= 4, Err(NS_ERROR_INVALID_ARG));
  Maybe<CacheOrigin> origin;
  MOZ_TRY(ReadCacheOrigin(folderId, origin));
  NS_ENSURE_TRUE(
      origin && !origin->sealed && !origin->pending && !mCacheOriginTainted &&
          !origin->generation.IsEmpty() &&
          origin->generation == DatabaseCore::sInstance->mCacheOriginGeneration,
      Err(NS_ERROR_NOT_AVAILABLE));
  MOZ_TRY(CheckCacheOriginLocation(*origin));
  uint32_t bit = 1u << uint32_t(site);
  if (site != CacheDiscoveryFlagSite::ImapServerRefresh) {
    NS_ENSURE_TRUE(!(origin->used & bit), Err(NS_ERROR_NOT_AVAILABLE));
    bool permitted =
        uint32_t(site) == origin->birthSite ||
        (origin->birthSite ==
             uint32_t(CacheDiscoveryFlagSite::ImapInitialBoxFlags) &&
         site == CacheDiscoveryFlagSite::ImapInitialDefaults &&
         (origin->used &
          (1u << uint32_t(CacheDiscoveryFlagSite::ImapInitialBoxFlags))));
    NS_ENSURE_TRUE(permitted, Err(NS_ERROR_NOT_AVAILABLE));
  }
  bool active;
  auto connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, Err(NS_ERROR_IN_PROGRESS));
  uint32_t flags = MOZ_TRY(GetFolderFlags(folderId));
  NS_ENSURE_TRUE(origin->revision < INT64_MAX - 1, Err(NS_ERROR_ILLEGAL_VALUE));
  ++origin->revision;
  origin->pending = uint32_t(site) + 1;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = WriteCacheOrigin(*origin);
  if (NS_SUCCEEDED(rv)) rv = connection->CommitTransaction();
  if (NS_FAILED(rv)) {
    mCacheOriginTainted = true;
    return Err(RollbackFolderUpdate(connection, rv));
  }
  return CacheDiscoveryFlagWrite(this, nsCString(expectedSourceId),
                                 origin->generation, folderId, origin->revision,
                                 flags, site);
}

nsresult FolderDatabase::WriteCacheFolderFlags(uint64_t folderId,
                                               uint32_t flags) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::sConnection->CreateStatement(
      "UPDATE folders SET flags=:flags WHERE id=:id"_ns, getter_AddRefs(stmt)));
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, folderId));
  MOZ_TRY(stmt->BindInt64ByName("flags"_ns, flags));
  MOZ_TRY(stmt->Execute());
  stmt = nullptr;
  NS_ENSURE_TRUE(MOZ_TRY(GetFolderFlags(folderId)) == flags,
                 NS_ERROR_FILE_CORRUPTED);
  return NS_OK;
}

nsresult FolderDatabase::ApplyCacheDiscoveryFlags(
    CacheDiscoveryFlagWrite&& write, uint32_t proposedNativeFlags,
    uint32_t& storedFlags) {
  NS_ENSURE_TRUE(std::exchange(write.mOwner, nullptr) == this,
                 NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(CheckCacheOriginSource(write.mSource));
  auto connection = DatabaseCore::sConnection;
  bool active;
  MOZ_TRY(connection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(connection->BeginTransaction());
  uint32_t result = 0;
  auto apply = [&]() -> nsresult {
    Maybe<CacheOrigin> origin;
    MOZ_TRY(ReadCacheOrigin(write.mFolder, origin));
    NS_ENSURE_TRUE(origin && !origin->sealed && !mCacheOriginTainted &&
                       origin->generation == write.mGeneration &&
                       origin->generation ==
                           DatabaseCore::sInstance->mCacheOriginGeneration &&
                       origin->revision == write.mRevision &&
                       origin->pending == uint32_t(write.mSite) + 1,
                   NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(CheckCacheOriginLocation(*origin));
    uint32_t before = MOZ_TRY(GetFolderFlags(origin->id));
    NS_ENSURE_TRUE(before == write.mFlags, NS_ERROR_NOT_AVAILABLE);
    uint32_t preserve = write.mSite == CacheDiscoveryFlagSite::ImapServerRefresh
                            ? kCacheClientMask
                            : origin->explicitMask;
    result = (proposedNativeFlags & ~preserve) | (before & preserve);
    MOZ_TRY(WriteCacheFolderFlags(origin->id, result));
    origin->used |= 1u << uint32_t(write.mSite);
    origin->pending = 0;
    NS_ENSURE_TRUE(origin->revision < INT64_MAX - 1, NS_ERROR_ILLEGAL_VALUE);
    ++origin->revision;
    MOZ_TRY(WriteCacheOrigin(*origin));
    return connection->CommitTransaction();
  };
  nsresult rv = apply();
  if (NS_FAILED(rv)) return RollbackFolderUpdate(connection, rv);
  storedFlags = result;
  return NS_OK;
}

nsresult FolderDatabase::CheckCacheProjectionOrigin(uint64_t folderId,
                                                    CacheOrigin& output) {
  Maybe<CacheOrigin> origin;
  MOZ_TRY(ReadCacheOrigin(folderId, origin));
  NS_ENSURE_TRUE(
      origin && !origin->sealed && !origin->pending && !mCacheOriginTainted &&
          !origin->generation.IsEmpty() &&
          origin->generation == DatabaseCore::sInstance->mCacheOriginGeneration,
      NS_ERROR_NOT_AVAILABLE);
  if (origin->birthSite ==
      uint32_t(CacheDiscoveryFlagSite::ImapInitialBoxFlags)) {
    NS_ENSURE_TRUE(
        origin->used &
            (1u << uint32_t(CacheDiscoveryFlagSite::ImapInitialDefaults)),
        NS_ERROR_NOT_AVAILABLE);
  }
  MOZ_TRY(CheckCacheOriginLocation(*origin));
  output = std::move(*origin);
  return NS_OK;
}

nsresult FolderDatabase::InsertCacheDiscoveryFolder(
    const nsACString& expectedSourceId, uint64_t parentId,
    const nsACString& nativeName, CacheDiscoveryFlagSite site,
    uint64_t& folderId) {
  MOZ_TRY(CheckCacheOriginSource(expectedSourceId));
  MOZ_TRY(RequireCommittedHierarchyMutation());
  NS_ENSURE_TRUE(
      (!parentId && site == CacheDiscoveryFlagSite::CommonRoot) ||
          (parentId && site == CacheDiscoveryFlagSite::ImapInitialBoxFlags),
      NS_ERROR_INVALID_ARG);
  nsCString name = MOZ_TRY(DatabaseUtils::Normalize(nativeName));
  NS_ENSURE_FALSE(name.IsEmpty(), NS_ERROR_INVALID_ARG);
  uint64_t existing = MOZ_TRY(GetFolderChildNamed(parentId, name));
  if (existing) {
    folderId = existing;
    return NS_OK;
  }
  if (parentId) MOZ_TRY(CheckFolderRelocationRecovery(parentId, false));
  auto connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  uint64_t id;
  nsresult rv = InsertFolderRow(parentId, name, &id, Some(site));
  if (NS_SUCCEEDED(rv)) rv = connection->CommitTransaction();
  if (NS_FAILED(rv)) return RollbackFolderUpdate(connection, rv);
  folderId = id;
  return NS_OK;
}

nsresult FolderDatabase::ReconcileCacheDiscoveryChildren(
    const nsACString& expectedSourceId, uint64_t parentId,
    const nsTArray<nsCString>& childNames) {
  MOZ_TRY(CheckCacheOriginSource(expectedSourceId));
  bool tracked;
  MOZ_TRY(HasCacheDiscoveryOrigin(expectedSourceId, parentId, tracked));
  return ReconcileInternal(parentId, childNames, tracked);
}

/**
 * Lookup functions.
 */

NS_IMETHODIMP FolderDatabase::GetFolderByPath(const nsACString& path,
                                              uint64_t* folderId) {
  NS_ENSURE_ARG_POINTER(folderId);

  uint64_t curId = 0;  // start with root part.
  for (auto const& part : path.Split('/')) {
    // Percent-decode each part.
    // Note, no NFC normalisation (GetFolderChildNamed() does that).
    // TODO: This is general percent decoding. Maybe paths should _only_
    // percent-encode '/'?
    nsAutoCString name(part);
    NS_UnescapeURL(name);

    curId = MOZ_TRY(GetFolderChildNamed(curId, name));
    if (curId == 0) {
      *folderId = 0;  // Path not found!
      return NS_OK;
    }
  }
  *folderId = curId;
  return NS_OK;
}

// NOTE: This is the _only_ thing that couples FolderDatabase to
// nsIMsgFolder. It'd be nice to get rid of this linkage entirely (moving
// this function out to accountmanager or something).
NS_IMETHODIMP FolderDatabase::GetMsgFolderForFolder(uint64_t folderId,
                                                    nsIMsgFolder** msgFolder) {
  NS_ENSURE_ARG(folderId);  // Folder 0 disallowed.
  NS_ENSURE_ARG_POINTER(msgFolder);
  auto currentOwner = [this] {
    return DatabaseCore::sInstance && DatabaseCore::sConnection &&
           DatabaseCore::sInstance->mFolderDatabase.get() == this;
  };
  NS_ENSURE_TRUE(currentOwner(), NS_ERROR_NOT_AVAILABLE);
  // Validate the stored ancestry before entering the recursive facade lookup.
  (void)MOZ_TRY(GetFolderRoot(folderId));
  nsCString name = MOZ_TRY(GetFolderName(folderId));
  uint64_t parentId = MOZ_TRY(GetFolderParent(folderId));
  nsCOMPtr<nsIMsgFolder> resolved;
  if (!parentId) {
    nsCOMPtr<nsIMsgAccountManager> accountManager =
        components::AccountManager::Service();
    nsCOMPtr<nsIMsgIncomingServer> server;
    MOZ_TRY(accountManager->GetIncomingServer(name, getter_AddRefs(server)));
    MOZ_TRY(server->GetRootFolder(getter_AddRefs(resolved)));
    NS_ENSURE_TRUE(resolved, NS_ERROR_NOT_AVAILABLE);
    uint64_t rootId;
    MOZ_TRY(resolved->GetId(&rootId));
    NS_ENSURE_TRUE(rootId == folderId, NS_ERROR_NOT_AVAILABLE);
  } else {
    nsCOMPtr<nsIMsgFolder> parent;
    MOZ_TRY(GetMsgFolderForFolder(parentId, getter_AddRefs(parent)));
    NS_ENSURE_TRUE(parent, NS_ERROR_NOT_AVAILABLE);
    nsTArray<RefPtr<nsIMsgFolder>> children;
    MOZ_TRY(parent->GetSubFolders(children));
    // Stored wire names and pretty names differ (notably for IMAP). A display
    // name or URI alias cannot choose the physical row requested by the caller.
    for (const auto& child : children) {
      NS_ENSURE_TRUE(child, NS_ERROR_FILE_CORRUPTED);
      uint64_t childId;
      MOZ_TRY(child->GetId(&childId));
      if (childId != folderId) {
        continue;
      }
      NS_ENSURE_FALSE(resolved, NS_ERROR_FILE_CORRUPTED);
      nsCOMPtr<nsIMsgFolder> actualParent;
      MOZ_TRY(child->GetParent(getter_AddRefs(actualParent)));
      NS_ENSURE_TRUE(actualParent == parent, NS_ERROR_NOT_AVAILABLE);
      resolved = child;
    }
    NS_ENSURE_TRUE(resolved, NS_ERROR_NOT_AVAILABLE);
  }
  NS_ENSURE_TRUE(currentOwner(), NS_ERROR_NOT_AVAILABLE);
  uint64_t currentParent = MOZ_TRY(GetFolderParent(folderId));
  NS_ENSURE_TRUE(currentParent == parentId, NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(currentOwner(), NS_ERROR_NOT_AVAILABLE);
  resolved.forget(msgFolder);
  return NS_OK;
}

/**
 * Modification functions.
 */

NS_IMETHODIMP FolderDatabase::InsertRoot(const nsACString& serverKey,
                                         uint64_t* rootId) {
  NS_ENSURE_ARG_POINTER(rootId);

  // `serverKey` is almost certainly ASCII, but normalize it and be sure.
  nsCString nfcServerKey = MOZ_TRY(DatabaseUtils::Normalize(serverKey));
  return InternalInsertFolder(0, nfcServerKey, rootId);
}

NS_IMETHODIMP FolderDatabase::InsertFolder(uint64_t parentId,
                                           const nsACString& name,
                                           uint64_t* childId) {
  NS_ENSURE_ARG(parentId);
  NS_ENSURE_ARG_POINTER(childId);

  nsCString nfcName = MOZ_TRY(DatabaseUtils::Normalize(name));
  return InternalInsertFolder(parentId, nfcName, childId);
}

/**
 * Common function for creating a new folder.
 * This will fail if a folder with the given parent and name already
 * exists (because of unique (name,parent) constraint in db).
 *
 * `parentId` may be 0, to add a root folder.
 * `name` must already be normalized.
 */
nsresult FolderDatabase::InternalInsertFolder(uint64_t parentId,
                                              const nsACString& name,
                                              uint64_t* childId) {
  MOZ_ASSERT(MOZ_TRY(DatabaseUtils::Normalize(name)) == name);
  NS_ENSURE_ARG_POINTER(childId);
  NS_ENSURE_TRUE(parentId <= INT64_MAX, NS_ERROR_INVALID_ARG);
  MOZ_TRY(RequireCommittedHierarchyMutation());
  if (parentId) MOZ_TRY(CheckFolderRelocationRecovery(parentId, false));
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  CachedFolder cached;
  cached.parent = parentId;
  cached.ordinal = Nothing();
  cached.name = name;
  MOZ_TRY(connection->BeginTransaction());
  uint64_t id;
  nsresult rv = InsertFolderRow(parentId, name, &id);
  if (NS_SUCCEEDED(rv)) {
    rv = connection->CommitTransaction();
  }
  if (NS_FAILED(rv)) {
    return RollbackFolderUpdate(connection, rv);
  }
  cached.id = id;
  MOZ_ALWAYS_TRUE(mFolderCache.put(id, cached));
  MOZ_LOG(gPanoramaLog, LogLevel::Info,
          ("InternalInsertFolder created new folder '%s' (id=%" PRIu64 ")\n",
           GetFolderPath(id).unwrapOr(""_ns).get(), id));
  *childId = id;
  return NS_OK;
}

// The caller owns the transaction and defers cache/output changes until commit.
nsresult FolderDatabase::InsertFolderRow(uint64_t parentId,
                                         const nsACString& name,
                                         uint64_t* childId,
                                         Maybe<CacheDiscoveryFlagSite> site) {
  NS_ENSURE_TRUE(parentId <= INT64_MAX, NS_ERROR_INVALID_ARG);
  // DB has uniqueness constraint upon (parent, name).
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "InsertFolder"_ns,
      "INSERT INTO folders (id, parent, name) SELECT highWater + 1, :parent, "
      ":name FROM folder_id_allocator WHERE singleton = 1 AND highWater < "
      "9223372036854775807 RETURNING id"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);

  MOZ_TRY(stmt->BindInt64ByName("parent"_ns, parentId));  // 0 for root.
  MOZ_TRY(stmt->BindUTF8StringByName("name"_ns, name));
  bool hasResult;
  rv = stmt->ExecuteStep(&hasResult);
  NS_ENSURE_SUCCESS(rv, rv);
  if (!hasResult) {
    return NS_ERROR_ILLEGAL_VALUE;
  }

  int64_t storedId;
  MOZ_TRY(stmt->GetInt64(0, &storedId));
  NS_ENSURE_TRUE(storedId > 0, NS_ERROR_FILE_CORRUPTED);
  MOZ_TRY(stmt->ExecuteStep(&hasResult));
  NS_ENSURE_FALSE(hasResult, NS_ERROR_UNEXPECTED);

  if (site)
    MOZ_TRY(InsertCacheOrigin(uint64_t(storedId), parentId, name, *site));
  *childId = uint64_t(storedId);
  return NS_OK;
}

NS_IMETHODIMP FolderDatabase::DeleteFolder(uint64_t folderId) {
  return DeleteFolderTree(folderId, false, EmptyCString());
}

nsresult FolderDatabase::RetireRoot(uint64_t folderId,
                                    const nsACString& serverKey) {
  NS_ENSURE_TRUE(!serverKey.IsEmpty(), NS_ERROR_INVALID_ARG);
  return DeleteFolderTree(folderId, true, serverKey);
}

nsresult FolderDatabase::DeleteFolderTree(uint64_t folderId, bool root,
                                          const nsACString& serverKey) {
  NS_ENSURE_TRUE(DatabaseCore::sInstance && DatabaseCore::sConnection &&
                     DatabaseCore::sInstance->mFolderDatabase.get() == this,
                 NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool active;
  MOZ_TRY(connection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(CheckFolderRelocationRecovery(folderId, true));
  nsTArray<uint64_t> removed;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = DeleteFolderRows(folderId, root, serverKey, removed);
  if (NS_SUCCEEDED(rv)) {
    rv = connection->CommitTransaction();
  }
  if (NS_FAILED(rv)) {
    return RollbackFolderUpdate(connection, rv);
  }
  // Physical messages, body metadata and captured revisions remain readable.
  for (uint64_t id : removed) {
    mFolderCache.remove(id);
  }
  return NS_OK;
}

// Shared only by owned folder mutations; no commit or cache invalidation here.
nsresult FolderDatabase::DeleteFolderRows(uint64_t folderId, bool root,
                                          const nsACString& serverKey,
                                          nsTArray<uint64_t>& removed) {
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "CheckDeletedFolderOwner"_ns,
        "SELECT parent, name FROM folders WHERE id = :id"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, folderId));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_UNEXPECTED);
    int64_t parent;
    nsCString name;
    MOZ_TRY(stmt->GetInt64(0, &parent));
    MOZ_TRY(stmt->GetUTF8String(1, name));
    if (!root && !parent) {
      NS_WARNING("using DeleteFolder on a root folder is forbidden");
    }
    NS_ENSURE_TRUE(root ? (!parent && name == serverKey) : parent > 0,
                   NS_ERROR_UNEXPECTED);
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  }
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "DeleteFolderTree"_ns,
        "WITH RECURSIVE doomed(id) AS (SELECT :id UNION SELECT f.id FROM "
        "folders f JOIN doomed d ON f.parent=d.id) "
        "DELETE FROM folders WHERE id IN (SELECT id FROM doomed) RETURNING id"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, folderId));
    while (true) {
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      if (!more) {
        break;
      }
      int64_t id;
      MOZ_TRY(stmt->GetInt64(0, &id));
      NS_ENSURE_TRUE(id > 0, NS_ERROR_FILE_CORRUPTED);
      if (!removed.AppendElement(uint64_t(id), fallible)) {
        return NS_ERROR_OUT_OF_MEMORY;
      }
    }
  }
  return NS_OK;
}

NS_IMETHODIMP FolderDatabase::Reconcile(uint64_t parentId,
                                        const nsTArray<nsCString>& childNames) {
  return ReconcileInternal(parentId, childNames, false);
}

nsresult FolderDatabase::ReconcileInternal(
    uint64_t parentId, const nsTArray<nsCString>& childNames,
    bool cacheDiscovery) {
  // InsertFolder/UpdateName store NFC names. Normalize the complete incoming
  // list before comparing it, so equivalent spellings retain physical IDs and
  // normalization failures occur before any existing child is removed.
  nsTArray<nsCString> names;
  if (!names.SetCapacity(childNames.Length(), fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  for (const auto& name : childNames) {
    names.AppendElement(MOZ_TRY(DatabaseUtils::Normalize(name)));
  }

  MOZ_TRY(RequireCommittedHierarchyMutation());
  MOZ_TRY(CheckFolderRelocationRecovery(parentId, true));
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  nsTArray<uint64_t> removed;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    // Keep virtual folders even when the server listing does not name them.
    nsTArray<uint64_t> childIds = MOZ_TRY(GetFolderChildrenUnsorted(parentId));
    for (uint64_t childId : childIds) {
      nsCString childName = MOZ_TRY(GetFolderName(childId));
      uint32_t childFlags = MOZ_TRY(GetFolderFlags(childId));
      if (!names.Contains(childName) &&
          !(childFlags & nsMsgFolderFlags::Virtual)) {
        MOZ_TRY(DeleteFolderRows(childId, false, EmptyCString(), removed));
      }
    }
    for (const auto& name : names) {
      uint64_t id = MOZ_TRY(GetFolderChildNamed(parentId, name));
      if (!id) {
        // As with InsertFolder, this operation cannot create root folders.
        NS_ENSURE_ARG(parentId);
        MOZ_TRY(InsertFolderRow(
            parentId, name, &id,
            cacheDiscovery ? Some(CacheDiscoveryFlagSite::LocalInitialChild)
                           : Nothing()));
      }
    }
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    return RollbackFolderUpdate(connection, rv);
  }
  // Removed entries stay visible in the cache until commit is confirmed.
  // New rows are loaded on demand, after this owned transaction has settled.
  for (uint64_t id : removed) {
    mFolderCache.remove(id);
  }
  return NS_OK;
}

NS_IMETHODIMP
FolderDatabase::MoveFolderWithin(uint64_t parentId, uint64_t childId,
                                 uint64_t beforeId) {
  MOZ_TRY(RequireCommittedHierarchyMutation());
  nsTArray<uint64_t> children = MOZ_TRY(GetFolderChildren(parentId));

  // Remove the folder we're moving around.
  if (!children.RemoveElement(childId)) {
    NS_WARNING("childId is not a child of parent");
    return NS_ERROR_UNEXPECTED;
  }

  if (beforeId == 0) {
    // Special case - missing beforeId indicates end.
    children.AppendElement(childId);
  } else {
    auto idx = children.IndexOf(beforeId);
    if (idx == nsTArray<uint64_t>::NoIndex) {
      NS_WARNING("beforeId is not a child of parent");
      return NS_ERROR_UNEXPECTED;
    }

    // Reinsert the child before beforeId.
    children.InsertElementAt(idx, childId);
  }

  // Recalculate the ordinal fields for all the children.
  nsresult rv = SaveOrdinals(children);
  NS_ENSURE_SUCCESS(rv, rv);
  return NS_OK;
}

nsresult FolderDatabase::RequireCurrentOwner() const {
  NS_ENSURE_TRUE(DatabaseCore::sInstance && DatabaseCore::sConnection &&
                     DatabaseCore::sInstance->mFolderDatabase.get() == this,
                 NS_ERROR_NOT_AVAILABLE);
  return NS_OK;
}

nsresult FolderDatabase::RequireCommittedHierarchyMutation() {
  MOZ_TRY(RequireCurrentOwner());
  bool active;
  MOZ_TRY(DatabaseCore::sConnection->GetTransactionInProgress(&active));
  return active ? NS_ERROR_IN_PROGRESS : NS_OK;
}

nsresult FolderDatabase::CheckFolderRelocationRecovery(uint64_t folderId,
                                                       bool subtree) {
  MOZ_TRY(DatabaseCore::sInstance->CheckFolderRelocationRecovery(folderId));
  if (subtree && DatabaseCore::sInstance->HasFailedFolderRelocationRecovery()) {
    nsTArray<uint64_t> descendants = MOZ_TRY(GetFolderDescendants(folderId));
    for (uint64_t child : descendants) {
      MOZ_TRY(DatabaseCore::sInstance->CheckFolderRelocationRecovery(child));
    }
  }
  return NS_OK;
}

nsresult FolderDatabase::ValidateFolderRelocation(
    const nsACString& expectedSourceId, uint64_t folderId,
    uint64_t expectedParent, const nsACString& expectedName,
    uint64_t newParent) {
  nsCString sourceId;
  MOZ_TRY(DatabaseCore::sInstance->ReadSourceIdForFolderAdmission(sourceId));
  NS_ENSURE_TRUE(sourceId == expectedSourceId, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(CheckFolderRelocationRecovery(newParent, false));
  {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "ReadFolderRelocationLocation"_ns,
        "SELECT parent, name FROM folders WHERE id=:id"_ns,
        getter_AddRefs(stmt)));
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, folderId));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
    int32_t parentType, nameType;
    int64_t parent;
    nsCString name;
    MOZ_TRY(stmt->GetTypeOfIndex(0, &parentType));
    MOZ_TRY(stmt->GetTypeOfIndex(1, &nameType));
    MOZ_TRY(stmt->GetInt64(0, &parent));
    MOZ_TRY(stmt->GetUTF8String(1, name));
    NS_ENSURE_TRUE(parentType == mozIStorageStatement::VALUE_TYPE_INTEGER &&
                       nameType == mozIStorageStatement::VALUE_TYPE_TEXT &&
                       parent >= 0,
                   NS_ERROR_FILE_CORRUPTED);
    NS_ENSURE_TRUE(uint64_t(parent) == expectedParent && name == expectedName,
                   NS_ERROR_NOT_AVAILABLE);
    NS_ENSURE_TRUE(parent, NS_ERROR_UNEXPECTED);  // Account roots stay roots.
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  }
  NS_ENSURE_TRUE(folderId != newParent, NS_ERROR_UNEXPECTED);
  nsTArray<uint64_t> descendants = MOZ_TRY(GetFolderDescendants(folderId));
  NS_ENSURE_FALSE(descendants.Contains(newParent), NS_ERROR_UNEXPECTED);
  uint64_t sourceRoot = MOZ_TRY(GetFolderRoot(folderId));
  uint64_t targetRoot = MOZ_TRY(GetFolderRoot(newParent));
  NS_ENSURE_TRUE(sourceRoot == targetRoot, NS_ERROR_UNEXPECTED);
  // Every path in the moved subtree changes. An unfinished body relocation
  // still owns its old physical paths, including after a restart.
  auto& messages = DatabaseCore::sInstance->MessageDB();
  MOZ_TRY(messages.CheckPendingFolderRelocation(folderId));
  for (uint64_t child : descendants) {
    MOZ_TRY(messages.CheckPendingFolderRelocation(child));
  }
  return NS_OK;
}

nsresult FolderDatabase::RelocateFolder(const nsACString& expectedSourceId,
                                        uint64_t folderId,
                                        uint64_t expectedParent,
                                        const nsACString& expectedName,
                                        uint64_t newParent,
                                        const nsACString& newName) {
  return RelocateFolderInternal(expectedSourceId, folderId, expectedParent,
                                expectedName, newParent, newName, nullptr);
}

nsresult FolderDatabase::RelocateImapFolder(
    const nsACString& expectedSourceId, uint64_t folderId,
    uint64_t expectedParent, const nsACString& expectedName, uint64_t newParent,
    const nsACString& newName, const ImapFolderRelocationMetadata& metadata) {
  return RelocateFolderInternal(expectedSourceId, folderId, expectedParent,
                                expectedName, newParent, newName, &metadata);
}

nsresult FolderDatabase::ValidateImapFolderRelocation(
    uint64_t folderId, const ImapFolderRelocationMetadata& metadata) {
  nsTArray<uint64_t> remaining = MOZ_TRY(GetFolderDescendants(folderId));
  remaining.AppendElement(folderId);
  NS_ENSURE_TRUE(remaining.Length() == metadata.folders.Length(),
                 NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "CheckImapRelocationTarget"_ns,
      "SELECT parent,name FROM folders WHERE id=:id"_ns, getter_AddRefs(stmt)));
  for (const auto& entry : metadata.folders) {
    NS_ENSURE_TRUE(entry.id && entry.id <= INT64_MAX && entry.expectedParent &&
                       entry.expectedParent <= INT64_MAX &&
                       !entry.onlineName.IsEmpty(),
                   NS_ERROR_INVALID_ARG);
    NS_ENSURE_TRUE(remaining.RemoveElement(entry.id), NS_ERROR_NOT_AVAILABLE);
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, entry.id));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
    int32_t parentType, nameType;
    int64_t parent;
    nsCString name;
    MOZ_TRY(stmt->GetTypeOfIndex(0, &parentType));
    MOZ_TRY(stmt->GetTypeOfIndex(1, &nameType));
    MOZ_TRY(stmt->GetInt64(0, &parent));
    MOZ_TRY(stmt->GetUTF8String(1, name));
    NS_ENSURE_TRUE(parentType == mozIStorageStatement::VALUE_TYPE_INTEGER &&
                       nameType == mozIStorageStatement::VALUE_TYPE_TEXT &&
                       parent > 0,
                   NS_ERROR_FILE_CORRUPTED);
    NS_ENSURE_TRUE(
        uint64_t(parent) == entry.expectedParent && name == entry.expectedName,
        NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  }
  return NS_OK;
}

nsresult FolderDatabase::WriteImapFolderRelocation(
    uint64_t folderId, uint64_t expectedParent, uint64_t newParent,
    const ImapFolderRelocationMetadata& metadata) {
  for (const auto& entry : metadata.folders) {
    MOZ_TRY(SetFolderProperty(entry.id, "onlineName"_ns, entry.onlineName));
    MOZ_TRY(SetFolderProperty(entry.id, "mailboxName"_ns, entry.onlineName));
  }
  if (metadata.displayName) {
    MOZ_TRY(SetFolderProperty(folderId, "imapDisplayName"_ns,
                              *metadata.displayName));
  }
  if (expectedParent != newParent) {
    nsTArray<uint64_t> ancestors = MOZ_TRY(GetFolderAncestors(newParent));
    ancestors.AppendElement(newParent);
    bool trash = false;
    for (uint64_t ancestor : ancestors) {
      uint32_t flags = MOZ_TRY(GetFolderFlags(ancestor));
      trash |= bool(flags & nsMsgFolderFlags::Trash);
    }
    if (trash) {
      // Generic UpdateFlags publishes immediately and can join caller SQL. This
      // operation owns SQL, so keep this write private until confirmed commit.
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "ClearImapRelocationTrashFlags"_ns,
          "UPDATE folders SET flags=flags & ~:clear WHERE id=:id RETURNING id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName(
          "clear"_ns, nsMsgFolderFlags::Favorite | nsMsgFolderFlags::CheckNew));
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, folderId));
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
      int64_t storedId;
      MOZ_TRY(stmt->GetInt64(0, &storedId));
      NS_ENSURE_TRUE(storedId > 0 && uint64_t(storedId) == folderId,
                     NS_ERROR_FILE_CORRUPTED);
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
    }
  }
  return NS_OK;
}

nsresult FolderDatabase::RelocateFolderInternal(
    const nsACString& expectedSourceId, uint64_t folderId,
    uint64_t expectedParent, const nsACString& expectedName, uint64_t newParent,
    const nsACString& newName, const ImapFolderRelocationMetadata* metadata) {
  MOZ_TRY(RequireCommittedHierarchyMutation());
  NS_ENSURE_TRUE(!expectedSourceId.IsEmpty() && folderId &&
                     folderId <= INT64_MAX && expectedParent <= INT64_MAX &&
                     newParent && newParent <= INT64_MAX,
                 NS_ERROR_INVALID_ARG);
  nsCString normalized = MOZ_TRY(DatabaseUtils::Normalize(newName));
  MOZ_TRY(ValidateFolderRelocation(expectedSourceId, folderId, expectedParent,
                                   expectedName, newParent));
  if (metadata) {
    NS_ENSURE_TRUE(normalized == expectedName || metadata->displayName,
                   NS_ERROR_INVALID_ARG);
    NS_ENSURE_TRUE(newParent == expectedParent || normalized != expectedName ||
                       !metadata->displayName,
                   NS_ERROR_INVALID_ARG);
    MOZ_TRY(ValidateImapFolderRelocation(folderId, *metadata));
  }
  if (!metadata && newParent == expectedParent && normalized == expectedName) {
    return NS_OK;
  }
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    // Recheck the captured facts in our own transaction, without borrowing or
    // committing a caller's transaction or relying on a stale wrapper/cache.
    MOZ_TRY(ValidateFolderRelocation(expectedSourceId, folderId, expectedParent,
                                     expectedName, newParent));
    if (metadata) MOZ_TRY(ValidateImapFolderRelocation(folderId, *metadata));
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "RelocateFolder"_ns,
          "UPDATE folders SET name=:name, parent=:parent, "
          "ordinal=CASE WHEN parent=:parent THEN ordinal ELSE NULL END "
          "WHERE id=:id AND parent=:oldParent AND name=:oldName RETURNING id"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindUTF8StringByName("name"_ns, normalized));
      MOZ_TRY(stmt->BindInt64ByName("parent"_ns, newParent));
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, folderId));
      MOZ_TRY(stmt->BindInt64ByName("oldParent"_ns, expectedParent));
      MOZ_TRY(stmt->BindUTF8StringByName("oldName"_ns, expectedName));
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
      int64_t storedId;
      MOZ_TRY(stmt->GetInt64(0, &storedId));
      NS_ENSURE_TRUE(storedId > 0 && uint64_t(storedId) == folderId,
                     NS_ERROR_FILE_CORRUPTED);
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
    }
    if (metadata) {
      MOZ_TRY(WriteImapFolderRelocation(folderId, expectedParent, newParent,
                                        *metadata));
    }
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    return RollbackFolderUpdate(connection, rv);
  }
  // No fallible lookup/allocation/publication after a confirmed commit. Cold
  // entries load the committed values normally on the next read.
  auto cached = mFolderCache.lookup(folderId);
  if (cached) {
    cached->value().name = std::move(normalized);
    cached->value().parent = newParent;
    if (newParent != expectedParent) {
      cached->value().ordinal.reset();
    }
  }
  return NS_OK;
}

// Each folder is assigned an incrementing ordinal value in the order
// given, starting at 1.
nsresult FolderDatabase::SaveOrdinals(nsTArray<uint64_t> const& folderIds) {
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "UpdateOrdinals"_ns,
        "UPDATE folders SET ordinal = :ordinal WHERE id = :id RETURNING id"_ns,
        getter_AddRefs(stmt)));
    uint64_t ordinal = 1;
    for (auto folderId : folderIds) {
      mozStorageStatementScoper scope(stmt);
      MOZ_TRY(stmt->BindInt64ByName("ordinal"_ns, ordinal++));
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, folderId));
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
      int64_t storedId;
      MOZ_TRY(stmt->GetInt64(0, &storedId));
      NS_ENSURE_TRUE(uint64_t(storedId) == folderId, NS_ERROR_FILE_CORRUPTED);
      MOZ_TRY(stmt->ExecuteStep(&more));
      NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
    }
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    bool active;
    nsresult cleanup = connection->GetTransactionInProgress(&active);
    if (NS_SUCCEEDED(cleanup) && active) {
      cleanup = connection->RollbackTransaction();
    }
    if (NS_FAILED(cleanup)) {
      MOZ_LOG(gPanoramaLog, LogLevel::Error,
              ("Folder ordinal rollback failed: 0x%08x",
               static_cast<uint32_t>(cleanup)));
    }
    return rv;
  }

  // Install the complete order only after every SQL row and COMMIT succeeds.
  // Existing entries need no allocation and absent entries stay cold.
  uint64_t ordinal = 1;
  for (auto folderId : folderIds) {
    auto p = mFolderCache.lookup(folderId);
    if (p) {
      p->value().ordinal = Some(ordinal);
    }
    ++ordinal;
  }
  return NS_OK;
}

// Null out the ordinal field for every child of this parent.
NS_IMETHODIMP
FolderDatabase::ResetChildOrder(uint64_t parentId) {
  MOZ_TRY(RequireCommittedHierarchyMutation());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      nsresult statementRv = DatabaseCore::GetStatement(
          "ResetOrdinals"_ns,
          "UPDATE folders SET ordinal = NULL WHERE parent = :parent"_ns,
          getter_AddRefs(stmt));
      NS_ENSURE_SUCCESS(statementRv, statementRv);
      mozStorageStatementScoper scoper(stmt);

      MOZ_TRY(stmt->BindInt64ByName("parent"_ns, parentId));
      statementRv = stmt->Execute();
      NS_ENSURE_SUCCESS(statementRv, statementRv);
    }
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    return RollbackFolderUpdate(connection, rv);
  }

  // Update cache.
  for (auto it = mFolderCache.iter(); !it.done(); it.next()) {
    if (it.get().value().parent == parentId) {
      it.get().value().ordinal.reset();
    }
  }
  return NS_OK;
}

NS_IMETHODIMP
FolderDatabase::MoveFolderTo(uint64_t newParentId, uint64_t childId) {
  NS_ENSURE_ARG(childId);
  MOZ_TRY(RequireCommittedHierarchyMutation());
  MOZ_TRY(CheckFolderRelocationRecovery(childId, true));
  MOZ_TRY(CheckFolderRelocationRecovery(newParentId, false));

  // Sanity checks.
  uint64_t oldParentId = MOZ_TRY(GetFolderParent(childId));
  if (!oldParentId) {
    NS_WARNING("cannot move a root folder");
    return NS_ERROR_UNEXPECTED;
  }
  if (childId == newParentId) {
    NS_WARNING("child cannot be made a child of itself");
    return NS_ERROR_UNEXPECTED;
  }

  if (newParentId == oldParentId) {
    return NS_OK;
  }

  nsTArray<uint64_t> descendants = MOZ_TRY(GetFolderDescendants(childId));
  if (descendants.Contains(newParentId)) {
    NS_WARNING("child cannot be made a descendant of itself");
    return NS_ERROR_UNEXPECTED;
  }

  // Don't allow cross-server moves.
  // TODO: The DB can support this just fine, and there's no hard reason to
  // disallow it here. It could actually be really useful, so this
  // restriction should be imposed by the nsIMsgFolder layer instead.
  uint64_t newParentRootId = MOZ_TRY(GetFolderRoot(newParentId));
  uint64_t oldParentRootId = MOZ_TRY(GetFolderRoot(oldParentId));
  if (newParentRootId != oldParentRootId) {
    NS_WARNING("child cannot move to a different root");
    return NS_ERROR_UNEXPECTED;
  }

  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      nsresult statementRv = DatabaseCore::GetStatement(
          "Reparent"_ns,
          "UPDATE folders SET parent = :parent, ordinal = NULL WHERE id = :id"_ns,
          getter_AddRefs(stmt));
      NS_ENSURE_SUCCESS(statementRv, statementRv);
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("parent"_ns, newParentId));
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, childId));
      statementRv = stmt->Execute();
      NS_ENSURE_SUCCESS(statementRv, statementRv);
    }
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    return RollbackFolderUpdate(connection, rv);
  }

  // Update cache.
  auto p = mFolderCache.lookup(childId);
  if (p) {
    p->value().ordinal.reset();
    p->value().parent = newParentId;
  }

  return NS_OK;
}

NS_IMETHODIMP
FolderDatabase::UpdateName(uint64_t folderId, const nsACString& newName) {
  NS_ENSURE_ARG(folderId);
  MOZ_TRY(RequireCommittedHierarchyMutation());
  MOZ_TRY(CheckFolderRelocationRecovery(folderId, true));
  nsCString nfcNewName = MOZ_TRY(DatabaseUtils::Normalize(newName));

  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      nsresult statementRv = DatabaseCore::GetStatement(
          "UpdateName"_ns, "UPDATE folders SET name = :name WHERE id = :id"_ns,
          getter_AddRefs(stmt));
      NS_ENSURE_SUCCESS(statementRv, statementRv);
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindUTF8StringByName("name"_ns, nfcNewName));
      MOZ_TRY(stmt->BindInt64ByName("id"_ns, folderId));

      statementRv = stmt->Execute();
      NS_ENSURE_SUCCESS(statementRv, statementRv);
    }
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    return RollbackFolderUpdate(connection, rv);
  }

  // Update cache.
  auto p = mFolderCache.lookup(folderId);
  if (p) {
    p->value().name = nfcNewName;
  }

  return rv;
}

NS_IMETHODIMP
FolderDatabase::UpdateFlags(uint64_t folderId, uint64_t newFlags) {
  NS_ENSURE_ARG(folderId);
  MOZ_TRY(RequireCurrentOwner());
  nsCString source;
  MOZ_TRY(DatabaseCore::sInstance->ReadSourceIdForFolderAdmission(source));
  MOZ_TRY(RecordCacheClientFlagAttempt(source, folderId, kCacheClientMask));

  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "UpdateFlags"_ns, "UPDATE folders SET flags = :flags WHERE id = :id"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("flags"_ns, newFlags));
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, folderId));

  rv = stmt->Execute();
  NS_ENSURE_SUCCESS(rv, rv);

  return NS_OK;
}

nsresult FolderDatabase::GetFolderUidValidity(uint64_t folderId,
                                              uint32_t& epoch) {
  if (!folderId || folderId > INT64_MAX) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "GetFolderUidValidity"_ns,
      "SELECT p.id, p.value FROM folders f LEFT JOIN folder_properties p "
      "ON p.id = f.id AND p.name = 'UIDValidity' WHERE f.id = :folderId"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, folderId));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  if (!more) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  bool absent;
  MOZ_TRY(stmt->GetIsNull(0, &absent));
  if (absent) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  int32_t type;
  MOZ_TRY(stmt->GetTypeOfIndex(1, &type));
  if (type != mozIStorageStatement::VALUE_TYPE_INTEGER) {
    return NS_ERROR_FILE_CORRUPTED;
  }
  int64_t value;
  MOZ_TRY(stmt->GetInt64(1, &value));
  if (value < 0 || value > UINT32_MAX) {
    return NS_ERROR_FILE_CORRUPTED;
  }
  epoch = static_cast<uint32_t>(value);
  return NS_OK;
}

nsresult FolderDatabase::SetFolderUidValidity(uint64_t folderId,
                                              uint32_t epoch) {
  if (!folderId || folderId > INT64_MAX) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  MOZ_TRY(RequireCurrentOwner());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool active;
  MOZ_TRY(connection->GetTransactionInProgress(&active));
  if (active) {
    return NS_ERROR_IN_PROGRESS;
  }
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "FolderExistsForUidValidity"_ns,
          "SELECT id FROM folders WHERE id = :folderId"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, folderId));
      bool more;
      MOZ_TRY(stmt->ExecuteStep(&more));
      if (!more) {
        return NS_ERROR_NOT_AVAILABLE;
      }
    }
    uint32_t previous;
    nsresult previousRv = GetFolderUidValidity(folderId, previous);
    if (NS_FAILED(previousRv) && previousRv != NS_ERROR_NOT_AVAILABLE) {
      return previousRv;
    }
    if (NS_FAILED(previousRv) || previous != epoch) {
      {
        nsCOMPtr<mozIStorageStatement> stmt;
        MOZ_TRY(DatabaseCore::GetStatement(
            "RetireFolderServerUids"_ns,
            "DELETE FROM message_properties WHERE name = 'uidOnServer' "
            "AND id IN (SELECT id FROM messages WHERE folderId = :folderId)"_ns,
            getter_AddRefs(stmt)));
        mozStorageStatementScoper scoper(stmt);
        MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, folderId));
        MOZ_TRY(stmt->Execute());
      }
      {
        nsCOMPtr<mozIStorageStatement> stmt;
        MOZ_TRY(DatabaseCore::GetStatement(
            "RetireStagedFolderServerUids"_ns,
            "DELETE FROM staged_message_properties WHERE name = 'uidOnServer' "
            "AND id IN (SELECT id FROM staged_messages WHERE folderId = :folderId)"_ns,
            getter_AddRefs(stmt)));
        mozStorageStatementScoper scoper(stmt);
        MOZ_TRY(stmt->BindInt64ByName("folderId"_ns, folderId));
        MOZ_TRY(stmt->Execute());
      }
      MOZ_TRY(SetFolderProperty(folderId, "UIDValidity"_ns,
                                static_cast<int64_t>(epoch)));
    }
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    nsresult cleanupRv = connection->GetTransactionInProgress(&active);
    if (NS_SUCCEEDED(cleanupRv) && active) {
      cleanupRv = connection->RollbackTransaction();
    }
    if (NS_FAILED(cleanupRv)) {
      MOZ_LOG(gPanoramaLog, LogLevel::Error,
              ("UIDVALIDITY cleanup failed: 0x%08x",
               static_cast<uint32_t>(cleanupRv)));
    }
  }
  return rv;
}

nsresult FolderDatabase::GetFolderProperties(
    uint64_t id, nsTArray<FolderImportProperty>& output) {
  NS_ENSURE_TRUE(DatabaseCore::sInstance && DatabaseCore::sConnection &&
                     DatabaseCore::sInstance->mFolderDatabase.get() == this &&
                     id && id <= INT64_MAX,
                 NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "GetPresentFolderProperties"_ns,
      "SELECT p.id, p.name, p.value FROM folders f LEFT JOIN folder_properties "
      "p "
      "ON p.id = f.id WHERE f.id = :id ORDER BY p.name COLLATE BINARY"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, id));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
  nsTArray<FolderImportProperty> properties;
  do {
    bool absent;
    MOZ_TRY(stmt->GetIsNull(0, &absent));
    if (!absent) {
      int32_t type;
      MOZ_TRY(stmt->GetTypeOfIndex(1, &type));
      NS_ENSURE_TRUE(type == mozIStorageStatement::VALUE_TYPE_TEXT,
                     NS_ERROR_FILE_CORRUPTED);
      FolderImportProperty property;
      MOZ_TRY(stmt->GetUTF8String(1, property.name));
      if (property.name == kCacheOriginProperty) {
        MOZ_TRY(stmt->ExecuteStep(&more));
        continue;
      }
      MOZ_TRY(stmt->GetTypeOfIndex(2, &type));
      if (type == mozIStorageStatement::VALUE_TYPE_INTEGER) {
        int64_t value;
        MOZ_TRY(stmt->GetInt64(2, &value));
        property.integer = Some(value);
      } else {
        NS_ENSURE_TRUE(type == mozIStorageStatement::VALUE_TYPE_TEXT,
                       NS_ERROR_FILE_CORRUPTED);
        MOZ_TRY(stmt->GetUTF8String(2, property.text));
      }
      properties.AppendElement(std::move(property));
    }
    MOZ_TRY(stmt->ExecuteStep(&more));
  } while (more);
  output = std::move(properties);
  return NS_OK;
}

nsresult FolderDatabase::GetFolderProperty(uint64_t id, const nsACString& name,
                                           nsACString& value) {
  MOZ_TRY(RequireCurrentOwner());
  NS_ENSURE_TRUE(name != kCacheOriginProperty, NS_ERROR_INVALID_ARG);
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "GetFolderProperty"_ns,
      "SELECT value FROM folder_properties WHERE id = :id AND name = :name"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);

  MOZ_TRY(stmt->BindInt64ByName("id"_ns, id));
  MOZ_TRY(stmt->BindUTF8StringByName("name"_ns, name));

  bool hasResult;
  MOZ_TRY(stmt->ExecuteStep(&hasResult));
  if (hasResult) {
    return stmt->GetUTF8String(0, value);
  }

  return rv;
}

nsresult FolderDatabase::GetFolderProperty(uint64_t id, const nsACString& name,
                                           int64_t* value) {
  MOZ_TRY(RequireCurrentOwner());
  NS_ENSURE_TRUE(name != kCacheOriginProperty, NS_ERROR_INVALID_ARG);
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "GetFolderProperty"_ns,
      "SELECT value FROM folder_properties WHERE id = :id AND name = :name"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);

  MOZ_TRY(stmt->BindInt64ByName("id"_ns, id));
  MOZ_TRY(stmt->BindUTF8StringByName("name"_ns, name));

  bool hasResult;
  MOZ_TRY(stmt->ExecuteStep(&hasResult));
  if (hasResult) {
    return stmt->GetInt64(0, value);
  }

  return rv;
}

nsresult FolderDatabase::SetFolderProperty(uint64_t id, const nsACString& name,
                                           const nsACString& value) {
  MOZ_TRY(RequireCurrentOwner());
  NS_ENSURE_TRUE(name != kCacheOriginProperty, NS_ERROR_INVALID_ARG);
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "SetFolderProperty"_ns,
      "REPLACE INTO folder_properties (id, name, value) VALUES (:id, :name, :value)"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);

  MOZ_TRY(stmt->BindInt64ByName("id"_ns, id));
  MOZ_TRY(stmt->BindUTF8StringByName("name"_ns, name));
  MOZ_TRY(stmt->BindUTF8StringByName("value"_ns, value));
  return stmt->Execute();
}

nsresult FolderDatabase::SetFolderProperty(uint64_t id, const nsACString& name,
                                           int64_t value) {
  MOZ_TRY(RequireCurrentOwner());
  NS_ENSURE_TRUE(name != kCacheOriginProperty, NS_ERROR_INVALID_ARG);
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "SetFolderProperty"_ns,
      "REPLACE INTO folder_properties (id, name, value) VALUES (:id, :name, :value)"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);

  MOZ_TRY(stmt->BindInt64ByName("id"_ns, id));
  MOZ_TRY(stmt->BindUTF8StringByName("name"_ns, name));
  MOZ_TRY(stmt->BindInt64ByName("value"_ns, value));
  return stmt->Execute();
}

nsresult FolderDatabase::GetVirtualFolderFolders(
    uint64_t virtualFolderId, nsTArray<uint64_t>& searchFolderIds) {
  MOZ_TRY(RequireCurrentOwner());
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement(
      "GetVirtualFolderFolders"_ns,
      "SELECT searchFolderId FROM virtualFolder_folders WHERE virtualFolderId = :virtualFolderId"_ns,
      getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);

  MOZ_TRY(stmt->BindInt64ByName("virtualFolderId"_ns, virtualFolderId));

  nsTArray<uint64_t> folders;
  while (true) {
    bool hasResult;
    MOZ_TRY(stmt->ExecuteStep(&hasResult));
    if (!hasResult) {
      break;
    }
    int64_t folder;
    MOZ_TRY(stmt->GetInt64(0, &folder));
    folders.AppendElement(static_cast<uint64_t>(folder));
  }
  searchFolderIds = std::move(folders);
  return NS_OK;
}

nsresult FolderDatabase::SetVirtualFolderFolders(
    uint64_t virtualFolderId, nsTArray<uint64_t>& searchFolderIds) {
  MOZ_TRY(RequireCurrentOwner());
  nsCOMPtr<mozIStorageConnection> connection = DatabaseCore::sConnection;
  bool active;
  MOZ_TRY(connection->GetTransactionInProgress(&active));
  if (active) {
    return NS_ERROR_IN_PROGRESS;
  }
  MOZ_TRY(connection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(DatabaseCore::GetStatement(
          "SetVirtualFolderFolders1"_ns,
          "DELETE FROM virtualFolder_folders WHERE virtualFolderId = :virtualFolderId"_ns,
          getter_AddRefs(stmt)));
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("virtualFolderId"_ns, virtualFolderId));
      MOZ_TRY(stmt->Execute());
    }
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(DatabaseCore::GetStatement(
        "SetVirtualFolderFolders2"_ns,
        "INSERT INTO virtualFolder_folders (virtualFolderId, searchFolderId) "
        "VALUES (:virtualFolderId, :searchFolderId)"_ns,
        getter_AddRefs(stmt)));
    for (auto searchFolderId : searchFolderIds) {
      mozStorageStatementScoper scoper(stmt);
      MOZ_TRY(stmt->BindInt64ByName("virtualFolderId"_ns, virtualFolderId));
      MOZ_TRY(stmt->BindInt64ByName("searchFolderId"_ns, searchFolderId));
      MOZ_TRY(stmt->Execute());
    }
    return connection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    nsresult cleanupRv = connection->GetTransactionInProgress(&active);
    if (NS_SUCCEEDED(cleanupRv) && active) {
      cleanupRv = connection->RollbackTransaction();
    }
    if (NS_FAILED(cleanupRv)) {
      MOZ_LOG(gPanoramaLog, LogLevel::Error,
              ("Virtual folder scope cleanup failed: 0x%08x",
               static_cast<uint32_t>(cleanupRv)));
    }
  }
  return rv;
}

Result<nsCString, nsresult> FolderDatabase::GetFolderName(uint64_t folderId) {
  MOZ_ASSERT(folderId);
  CachedFolder* cached = MOZ_TRY(EnsureFolderCached(folderId));
  return cached->name;
}

Result<nsCString, nsresult> FolderDatabase::GetFolderPath(uint64_t folderId) {
  return GetFolderPath(folderId, true);
}

Result<nsCString, nsresult> FolderDatabase::GetFolderPath(uint64_t folderId,
                                                          bool escapePercent) {
  MOZ_ASSERT(folderId);

  nsTArray<nsCString> encodedParts;
  nsTArray<uint64_t> visited;
  while (true) {
    if (visited.Contains(folderId)) {
      return Err(NS_ERROR_FILE_CORRUPTED);
    }
    if (!visited.AppendElement(folderId, fallible)) {
      return Err(NS_ERROR_OUT_OF_MEMORY);
    }
    CachedFolder* cached = MOZ_TRY(EnsureFolderCached(folderId));
    nsCString encodedName =
        PercentEncode(cached->name, [escapePercent](char c) {
          return c == '/' || (escapePercent && c == '%');
        });
    encodedParts.AppendElement(encodedName);
    folderId = cached->parent;
    if (cached->parent == 0) {
      break;  // We've reached the root.
    }
  }
  encodedParts.Reverse();
  return StringJoin("/"_ns, encodedParts);
}

Result<uint32_t, nsresult> FolderDatabase::GetFolderFlags(uint64_t folderId) {
  MOZ_ASSERT(folderId);
  // Flags can be written in a caller transaction which may later roll back.
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "GetStoredFolderFlags"_ns, "SELECT flags FROM folders WHERE id = :id"_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, folderId));
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  if (!more) {
    return Err(NS_ERROR_UNEXPECTED);
  }
  int64_t flags;
  MOZ_TRY(stmt->GetInt64(0, &flags));
  MOZ_TRY(stmt->ExecuteStep(&more));
  if (more) {
    return Err(NS_ERROR_FILE_CORRUPTED);
  }
  return static_cast<uint32_t>(flags);
}

Result<Maybe<uint64_t>, nsresult> FolderDatabase::GetFolderOrdinal(
    uint64_t folderId) {
  MOZ_ASSERT(folderId);
  CachedFolder* cached = MOZ_TRY(EnsureFolderCached(folderId));
  return cached->ordinal;
}

Result<uint64_t, nsresult> FolderDatabase::GetFolderParent(uint64_t folderId) {
  MOZ_ASSERT(folderId);
  CachedFolder* cached = MOZ_TRY(EnsureFolderCached(folderId));
  return cached->parent;
}

Result<nsTArray<uint64_t>, nsresult> FolderDatabase::GetFolderChildrenUnsorted(
    uint64_t folderId) {
  // folderId can be 0, to return root folders.
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(
      DatabaseCore::GetStatement("GetFolderChildren"_ns,
                                 "SELECT id "
                                 " FROM folders WHERE parent = :parentid "_ns,
                                 getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  stmt->BindInt64ByName("parentid"_ns, (int64_t)folderId);

  nsTArray<uint64_t> children;
  while (true) {
    bool hasResult;
    MOZ_TRY(stmt->ExecuteStep(&hasResult));
    if (!hasResult) {
      break;
    }
    uint64_t childId = (uint64_t)stmt->AsInt64(0);
    MOZ_ASSERT(!children.Contains(childId));  // Cycle detected!
    children.AppendElement(childId);
  }
  return children;
}

Result<nsTArray<uint64_t>, nsresult> FolderDatabase::GetFolderChildren(
    uint64_t folderId) {
  // folderId can be 0, to return root folders.
  nsTArray<uint64_t> children = MOZ_TRY(GetFolderChildrenUnsorted(folderId));

  if (children.Length() < 2) {
    return children;
  }
  // Fetch fallible metadata before sorting. A comparator cannot propagate a
  // storage error, and must not replace unreadable keys with default values.
  nsTArray<FolderComparator::Key> keys;
  if (!keys.SetCapacity(children.Length(), fallible)) {
    return Err(NS_ERROR_OUT_OF_MEMORY);
  }
  for (uint64_t id : children) {
    FolderComparator::Key key;
    key.id = id;
    key.ordinal = MOZ_TRY(GetFolderOrdinal(id));
    key.flags = MOZ_TRY(GetFolderFlags(id));
    key.name = MOZ_TRY(GetFolderName(id));
    if (!keys.AppendElement(std::move(key), fallible)) {
      return Err(NS_ERROR_OUT_OF_MEMORY);
    }
  }
  keys.Sort(mComparator);
  for (size_t i = 0; i < children.Length(); ++i) {
    children[i] = keys[i].id;
  }
  return children;
};

Result<uint64_t, nsresult> FolderDatabase::GetFolderChildNamed(
    uint64_t folderId, nsACString const& childName) {
  // folderId can be 0, to search root folders.
  nsCString nfcName = MOZ_TRY(DatabaseUtils::Normalize(childName));

  // Have a quick rummage through the cache first.
  for (auto it = mFolderCache.iter(); !it.done(); it.next()) {
    if (it.get().value().parent == folderId &&
        it.get().value().name == nfcName) {
      return it.get().key();
    }
  }

  // Hit the DB.
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(DatabaseCore::GetStatement(
      "GetFolderChildNamed"_ns,
      "SELECT id "
      " FROM folders WHERE parent = :parentid AND name = :name "_ns,
      getter_AddRefs(stmt)));
  mozStorageStatementScoper scoper(stmt);
  stmt->BindInt64ByName("parentid"_ns, (int64_t)folderId);
  stmt->BindUTF8StringByName("name"_ns, nfcName);
  bool hasResult;
  MOZ_TRY(stmt->ExecuteStep(&hasResult));
  if (hasResult) {
    return (uint64_t)stmt->AsInt64(0);
  }
  return 0;  // Not found.
}

Result<uint64_t, nsresult> FolderDatabase::GetFolderRoot(uint64_t folderId) {
  MOZ_ASSERT(folderId);
  nsTArray<uint64_t> visited;
  while (true) {
    if (visited.Contains(folderId)) {
      return Err(NS_ERROR_FILE_CORRUPTED);
    }
    if (!visited.AppendElement(folderId, fallible)) {
      return Err(NS_ERROR_OUT_OF_MEMORY);
    }
    uint64_t parent = MOZ_TRY(GetFolderParent(folderId));
    if (parent == 0) {
      break;
    }
    folderId = parent;
  }
  return folderId;
}

nsresult FolderDatabase::InternalAppendDescendants(
    uint64_t folderId, nsTArray<uint64_t>& descendants) {
  nsTArray<uint64_t> children = MOZ_TRY(GetFolderChildren(folderId));
  for (uint64_t child : children) {
    NS_ENSURE_FALSE(descendants.Contains(child), NS_ERROR_FILE_CORRUPTED);
    if (!descendants.AppendElement(child, fallible)) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
    MOZ_TRY(InternalAppendDescendants(child, descendants));
  }
  return NS_OK;
}

Result<nsTArray<uint64_t>, nsresult> FolderDatabase::GetFolderDescendants(
    uint64_t folderId) {
  nsTArray<uint64_t> descendants;
  MOZ_TRY(InternalAppendDescendants(folderId, descendants));
  return descendants;
}

Result<nsTArray<uint64_t>, nsresult> FolderDatabase::GetFolderAncestors(
    uint64_t folderId) {
  MOZ_ASSERT(folderId);
  nsTArray<uint64_t> ancestors;
  // Don't include self.
  folderId = MOZ_TRY(GetFolderParent(folderId));
  while (folderId) {
    if (ancestors.Contains(folderId)) {
      return Err(NS_ERROR_FILE_CORRUPTED);
    }
    if (!ancestors.AppendElement(folderId, fallible)) {
      return Err(NS_ERROR_OUT_OF_MEMORY);
    }
    folderId = MOZ_TRY(GetFolderParent(folderId));
  }
  return ancestors;
}

// Populate a CachedFolder entry from the database.
nsresult FolderDatabase::FetchFolderData(uint64_t folderId,
                                         CachedFolder& cached) {
  nsCOMPtr<mozIStorageStatement> stmt;
  nsresult rv = DatabaseCore::GetStatement("FetchFolder"_ns,
                                           "SELECT id, parent, ordinal, name "
                                           " FROM folders WHERE id = :id"_ns,
                                           getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  mozStorageStatementScoper scoper(stmt);
  stmt->BindInt64ByName("id"_ns, (uint64_t)folderId);

  bool hasResult;
  rv = stmt->ExecuteStep(&hasResult);
  NS_ENSURE_SUCCESS(rv, rv);
  if (!hasResult) {
    return NS_ERROR_UNEXPECTED;
  }

  cached.id = (uint64_t)stmt->AsInt64(0);
  cached.parent = (uint64_t)stmt->AsInt64(1);
  cached.ordinal =
      stmt->IsNull(2) ? Nothing() : Some((uint64_t)stmt->AsInt64(2));
  uint32_t len;
  cached.name = stmt->AsSharedUTF8String(3, &len);
  return NS_OK;
}

// Return cached data for a folder, loading it in from the DB if needed.
Result<FolderDatabase::CachedFolder*, nsresult>
FolderDatabase::EnsureFolderCached(uint64_t folderId) {
  auto p = mFolderCache.lookupForAdd(folderId);
  if (!p) {
    TrimCache();
    CachedFolder cached;
    nsresult rv = FetchFolderData(folderId, cached);
    if (NS_FAILED(rv)) {
      return Err(rv);
    }
    // Trimming can invalidate the insertion slot captured by lookupForAdd.
    if (!mFolderCache.relookupOrAdd(p, folderId, cached)) {
      return Err(NS_ERROR_FAILURE);
    }
  }
  return &p->value();
}

void FolderDatabase::TrimCache() {
  // Standin cache policy:
  // Grow to maxEntries, then discard an arbitrary 25%.
  // Probably no point being too clever here.
  constexpr uint32_t maxEntries = 512;
  if (mFolderCache.count() < maxEntries) {
    return;
  }
  // Throw away 25%. Don't care which.
  uint32_t n = maxEntries / 4;
  for (auto it = mFolderCache.modIter(); !it.done(); it.next()) {
    if (!n) {
      break;
    }
    it.remove();
    --n;
  }
}

// XPCOM wrappers

NS_IMETHODIMP FolderDatabase::GetFolderName(uint64_t folderId,
                                            nsACString& name) {
  NS_ENSURE_ARG(folderId);
  name = MOZ_TRY(GetFolderName(folderId));
  return NS_OK;
}

NS_IMETHODIMP FolderDatabase::GetFolderPath(uint64_t folderId,
                                            nsACString& path) {
  NS_ENSURE_ARG(folderId);
  path = MOZ_TRY(GetFolderPath(folderId));
  return NS_OK;
}

NS_IMETHODIMP FolderDatabase::GetFolderFlags(uint64_t folderId,
                                             uint32_t* flags) {
  NS_ENSURE_ARG(folderId);
  NS_ENSURE_ARG_POINTER(flags);
  *flags = MOZ_TRY(GetFolderFlags(folderId));
  return NS_OK;
}

NS_IMETHODIMP FolderDatabase::GetFolderIsServer(uint64_t folderId,
                                                bool* isServer) {
  NS_ENSURE_ARG(folderId);
  NS_ENSURE_ARG_POINTER(isServer);
  // Root/Server folders are just top-level ones with no parent.
  uint64_t parentId = MOZ_TRY(GetFolderParent(folderId));
  *isServer = (parentId == 0);
  return NS_OK;
}

NS_IMETHODIMP FolderDatabase::GetFolderParent(uint64_t folderId,
                                              uint64_t* parentId) {
  NS_ENSURE_ARG(folderId);
  NS_ENSURE_ARG_POINTER(parentId);
  *parentId = MOZ_TRY(GetFolderParent(folderId));
  return NS_OK;
}

NS_IMETHODIMP FolderDatabase::GetFolderChildren(uint64_t folderId,
                                                nsTArray<uint64_t>& children) {
  children = MOZ_TRY(GetFolderChildren(folderId));
  return NS_OK;
}

NS_IMETHODIMP FolderDatabase::GetFolderChildNamed(uint64_t folderId,
                                                  nsACString const& childName,
                                                  uint64_t* childId) {
  // folderId can be 0 to access root folders.
  NS_ENSURE_ARG_POINTER(childId);
  *childId = MOZ_TRY(GetFolderChildNamed(folderId, childName));
  return NS_OK;
}

NS_IMETHODIMP FolderDatabase::GetFolderRoot(uint64_t folderId,
                                            uint64_t* rootId) {
  NS_ENSURE_ARG(folderId);
  NS_ENSURE_ARG_POINTER(rootId);
  *rootId = MOZ_TRY(GetFolderRoot(folderId));
  return NS_OK;
}

NS_IMETHODIMP FolderDatabase::GetFolderDescendants(
    uint64_t folderId, nsTArray<uint64_t>& descendants) {
  descendants = MOZ_TRY(GetFolderDescendants(folderId));
  return NS_OK;
}

NS_IMETHODIMP FolderDatabase::GetFolderAncestors(
    uint64_t folderId, nsTArray<uint64_t>& ancestors) {
  NS_ENSURE_ARG(folderId);  // Can't call with null folder.
  ancestors = MOZ_TRY(GetFolderAncestors(folderId));
  return NS_OK;
}

NS_IMETHODIMP FolderDatabase::GetFolderIsDescendantOf(
    uint64_t folderId, uint64_t potentialAncestorId, bool* isDescendant) {
  NS_ENSURE_ARG(folderId);
  NS_ENSURE_ARG(potentialAncestorId);
  // Note inverted search - it's likely quicker to search ancestors than
  // descendants.
  nsTArray<uint64_t> ancestorIds = MOZ_TRY(GetFolderAncestors(folderId));
  *isDescendant = ancestorIds.Contains(potentialAncestorId);
  return NS_OK;
}

NS_IMETHODIMP FolderDatabase::GetFolderIsAncestorOf(
    uint64_t folderId, uint64_t potentialDescendantId, bool* isAncestor) {
  NS_ENSURE_ARG(folderId);
  NS_ENSURE_ARG(potentialDescendantId);
  nsTArray<uint64_t> ancestorIds =
      MOZ_TRY(GetFolderAncestors(potentialDescendantId));
  *isAncestor = ancestorIds.Contains(folderId);
  return NS_OK;
}

}  // namespace mozilla::mailnews
