/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_DB_PANORAMA_SRC_FOLDERDATABASE_H_
#define COMM_MAILNEWS_DB_PANORAMA_SRC_FOLDERDATABASE_H_

#include "FolderComparator.h"
#include "mozilla/HashTable.h"
#include "mozilla/MozPromise.h"
#include "mozilla/RefPtr.h"
#include "mozilla/Result.h"
#include "nsIFolderDatabase.h"
#include "nsTHashMap.h"

using mozilla::MozPromise;

namespace mozilla::mailnews {

struct FolderImportProperty;

// Captured physical targets for one server-confirmed IMAP relocation. Wire
// paths are supplied by the protocol owner, never derived from logical paths.
struct ImapFolderRelocationEntry {
  uint64_t id{0};
  uint64_t expectedParent{0};
  nsCString expectedName;
  nsCString onlineName;
};

struct ImapFolderRelocationMetadata {
  nsTArray<ImapFolderRelocationEntry> folders;  // Root and every descendant.
  Maybe<nsCString> displayName;  // Root only; Nothing preserves presence/text.
};

class FolderDatabase : public nsIFolderDatabase {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIFOLDERDATABASE

  Result<nsCString, nsresult> GetFolderName(uint64_t folderId);
  Result<nsCString, nsresult> GetFolderPath(uint64_t folderId);
  Result<uint32_t, nsresult> GetFolderFlags(uint64_t folderId);

  // Native same-row settlement, not a filesystem or wrapper operation. Guards
  // the exact captured location/incarnation; owns SQL and refuses caller TXs.
  // Failure preserves metadata/cache; success has no fallible postcommit work.
  nsresult RelocateFolder(const nsACString& expectedSourceId, uint64_t folderId,
                          uint64_t expectedParent,
                          const nsACString& expectedName, uint64_t newParent,
                          const nsACString& newName);

  // Same guards/transaction as RelocateFolder, with complete physical subtree
  // metadata. Writes onlineName/mailboxName, optional root displayName, and
  // clears only Favorite|CheckNew when reparenting beneath actual Trash.
  nsresult RelocateImapFolder(const nsACString& expectedSourceId,
                              uint64_t folderId, uint64_t expectedParent,
                              const nsACString& expectedName,
                              uint64_t newParent, const nsACString& newName,
                              const ImapFolderRelocationMetadata& metadata);

  Result<uint64_t, nsresult> GetFolderParent(uint64_t folderId);
  // Returns children sorted. Can pass folderId=0 to get root folders.
  Result<nsTArray<uint64_t>, nsresult> GetFolderChildren(uint64_t folderId);
  Result<uint64_t, nsresult> GetFolderChildNamed(uint64_t folderId,
                                                 nsACString const& childName);
  Result<uint64_t, nsresult> GetFolderRoot(uint64_t folderId);
  Result<nsTArray<uint64_t>, nsresult> GetFolderDescendants(uint64_t folderId);
  Result<nsTArray<uint64_t>, nsresult> GetFolderAncestors(uint64_t folderId);

  Result<Maybe<uint64_t>, nsresult> GetFolderOrdinal(uint64_t folderId);

  // Missing folder/epoch: NOT_AVAILABLE. Failure leaves epoch unchanged.
  nsresult GetFolderUidValidity(uint64_t folderId, uint32_t& epoch);
  // Owns its transaction. New/changed epochs retire exact server-UID bindings,
  // retaining physical messages and body metadata. Same epoch is a no-op.
  nsresult SetFolderUidValidity(uint64_t folderId, uint32_t epoch);

 protected:
  virtual ~FolderDatabase() {};

 private:
  friend class DatabaseCore;

  FolderDatabase() = default;

  // Historical spelling is only for checking an already identified receipt.
  Result<nsCString, nsresult> GetFolderPath(uint64_t folderId,
                                            bool escapePercent);

 private:
  friend class DatabaseCore;
  friend class FolderInfo;
  friend class DeliveryCoreProperties;
  friend class VirtualFolderFilter;
  friend class VirtualFolderWrapper;

  // Present rows only. Missing folder/errors leave output unchanged.
  nsresult GetFolderProperties(uint64_t id,
                               nsTArray<FolderImportProperty>& output);

  nsresult GetFolderProperty(uint64_t id, const nsACString& name,
                             nsACString& value);
  nsresult GetFolderProperty(uint64_t id, const nsACString& name,
                             int64_t* value);
  nsresult SetFolderProperty(uint64_t id, const nsACString& name,
                             const nsACString& value);
  nsresult SetFolderProperty(uint64_t id, const nsACString& name,
                             int64_t value);

  nsresult GetVirtualFolderFolders(uint64_t virtualFolderId,
                                   nsTArray<uint64_t>& searchFolderIds);
  nsresult SetVirtualFolderFolders(uint64_t virtualFolderId,
                                   nsTArray<uint64_t>& searchFolderIds);

  Result<nsTArray<uint64_t>, nsresult> GetFolderChildrenUnsorted(
      uint64_t folderId);

 private:
  FolderComparator mComparator;

  nsresult ValidateFolderRelocation(const nsACString& expectedSourceId,
                                    uint64_t folderId, uint64_t expectedParent,
                                    const nsACString& expectedName,
                                    uint64_t newParent);

  nsresult RelocateFolderInternal(const nsACString& expectedSourceId,
                                  uint64_t folderId, uint64_t expectedParent,
                                  const nsACString& expectedName,
                                  uint64_t newParent, const nsACString& newName,
                                  const ImapFolderRelocationMetadata* metadata);
  nsresult ValidateImapFolderRelocation(
      uint64_t folderId, const ImapFolderRelocationMetadata& metadata);
  nsresult WriteImapFolderRelocation(
      uint64_t folderId, uint64_t expectedParent, uint64_t newParent,
      const ImapFolderRelocationMetadata& metadata);

  nsresult InternalLoadFolders();

  nsresult InternalInsertFolder(uint64_t aParent, const nsACString& aName,
                                uint64_t* aChild);
  // SQL-only helpers. Callers own the transaction and settle cache after
  // commit.
  nsresult InsertFolderRow(uint64_t parent, const nsACString& name,
                           uint64_t* child);
  nsresult DeleteFolderRows(uint64_t folder, bool root,
                            const nsACString& serverKey,
                            nsTArray<uint64_t>& removed);
  nsresult RetireRoot(uint64_t folderId, const nsACString& serverKey);
  nsresult DeleteFolderTree(uint64_t folderId, bool root,
                            const nsACString& serverKey);

  nsresult RequireCommittedHierarchyMutation();

  nsresult SaveOrdinals(nsTArray<uint64_t> const& aFolders);

  nsresult InternalAppendDescendants(uint64_t folderId,
                                     nsTArray<uint64_t>& descendants);

  // Folder data we want cached.
  struct CachedFolder {
    uint64_t id{0};
    uint64_t parent{0};
    Maybe<uint64_t> ordinal;
    nsAutoCString name;
  };

  // The cache, indexed by folderId.
  mozilla::HashMap<uint64_t, CachedFolder> mFolderCache;
  // Guarantee folder data is in cache.
  Result<CachedFolder*, nsresult> EnsureFolderCached(uint64_t folderId);
  // Fetch folder data from DB into our cache struct.
  nsresult FetchFolderData(uint64_t folderId, CachedFolder& cached);
  // Check the cache and slim it down if needed.
  void TrimCache();
};

}  // namespace mozilla::mailnews

#endif  // COMM_MAILNEWS_DB_PANORAMA_SRC_FOLDERDATABASE_H_
