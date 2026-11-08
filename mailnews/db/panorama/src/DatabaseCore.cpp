/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "DatabaseCore.h"
#include "mozIStorageCompletionCallback.h"
#include "mozilla/AutoRestore.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/StaticPrefs_mail.h"
#include "nsContentUtils.h"
#include "nsIAsyncShutdown.h"
#include "nsICommandLine.h"
#include "nsIDirectoryEnumerator.h"
#include "nsIFileURL.h"
#include "nsIPrefBranch.h"
#include "nsIVersionComparator.h"
#include "nsIXULAppInfo.h"
#include "nsXULAppAPI.h"
#include "nsIImapIncomingServer.h"
#include "nsIImapUrl.h"
#include "nsIMsgAccountManager.h"
#include "nsIMsgImapMailFolder.h"
#include "nsIMsgIncomingServer.h"
#include "nsIRelativeFilePref.h"
#include "mozilla/Preferences.h"
#include "nsImapCore.h"
#include "../../../imap/src/nsImapUrl.h"
#include "nsTHashSet.h"
#include "nsPrintfCString.h"
#include "js/Equality.h"
#include "nsCharSeparatedTokenizer.h"
#include "nsEscape.h"
#include "mozilla/dom/ScriptSettings.h"
#ifndef XP_WIN
#  include <fcntl.h>
#  include <sys/stat.h>
#  include <unistd.h>
#endif

#ifdef XP_WIN
#  include "MigrationFileSystem.h"
#  include "nsILocalFileWin.h"
#endif

#include <algorithm>
#include <charconv>
#include <limits>
#include <cmath>
#include <cstring>
#include <utility>
#include <cstdlib>
#include <type_traits>

#include "DatabaseUtils.h"
#include "FolderDatabase.h"
#include "Message.h"
#include "MboxMsgInputStream.h"
#include "MessageDatabase.h"
#include "PerFolderDatabase.h"
#include "js/Array.h"
#include "js/CharacterEncoding.h"
#include "js/ForOfIterator.h"
#include "js/JSON.h"
#include "js/MapAndSet.h"
#include "js/PropertyAndElement.h"
#include "js/String.h"
#include "js/experimental/TypedData.h"
#include "jsapi.h"
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
#include "mozilla/Base64.h"
#include "mozilla/Components.h"
#include "mozilla/Logging.h"
#include "mozilla/ProfilerMarkers.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/Services.h"
#include "mozilla/UniquePtr.h"
#include "mozilla/dom/ChromeUtils.h"
#include "mozilla/dom/ChromeUtilsBinding.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/fallible.h"
#include "msgCore.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsIClassInfoImpl.h"
#include "nsICryptoHash.h"
#include "nsID.h"
#include "nsIFile.h"
#include "nsIInputStream.h"
#include "nsISeekableStream.h"
#include "nsILineInputStream.h"
#include "nsIMimeConverter.h"
#include "nsIMsgOfflineImapOperation.h"
#include "nsIMsgPluggableStore.h"
#include "nsIFolderLookupService.h"
#include "nsIObserverService.h"
#include "nsIUUIDGenerator.h"
#include "nsIAbManager.h"
#include "nsIAbDirectory.h"
#include "nsJSUtils.h"
#include "nsMsgFolderFlags.h"
#include "nsMsgDBFolder.h"
#include "nsMsgMessageFlags.h"
#include "nsMsgUtils.h"
#include "nsMsgLocalStoreUtils.h"
#include "nsNetUtil.h"
#include "nsReadableUtils.h"
#include "nsThreadUtils.h"
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

// Selected startup is a single native lifetime. Only XRE's app-startup callback
// arms it; the actual XRE lock stays with XRE until XPCOM shutdown completes.
struct StartupMailSource {
  nsCString id, path, hash, storePath, serverKey, serverRoot, storeContract;
  nsCString protocol, canonicalPath, onlineName;
  nsTArray<nsCString> localNames, localLeaves;
  uint64_t size = 0;
  uint32_t boxFlags = 0;
  Maybe<uint32_t> originalFlags;
  char delimiter = 0;
};

struct StartupServerSummary {
  nsCString id, path, hash, serverKey, serverRoot, storeContract, storeType;
  uint64_t size = 0, folderId = 0;
};

struct StartupServerRoot {
  nsCString key, path, protocol, contract;
};

class ProfileStartupOperation final : public nsIAsyncShutdownBlocker {
 public:
  NS_DECL_ISUPPORTS
  NS_IMETHOD GetName(nsAString& name) override {
    name.AssignLiteral("Panorama: settle selected profile startup");
    return NS_OK;
  }
  NS_IMETHOD GetState(nsIPropertyBag** state) override {
    *state = nullptr;
    return NS_OK;
  }
  NS_IMETHOD BlockShutdown(nsIAsyncShutdownClient*) override {
    if (settled) return NS_OK;
    if (ready) return onShutdown ? onShutdown() : NS_ERROR_NOT_AVAILABLE;
    closing = true;
    Remember(NS_ERROR_ABORT);
    // The coordinator joins its outstanding I/O before failed settlement.
    return NS_OK;
  }
  void Remember(nsresult error) {
    if (NS_FAILED(error) && NS_SUCCEEDED(firstError)) firstError = error;
  }
  nsCOMPtr<nsIFile> profile, localProfile;
  nsCOMPtr<nsIAsyncShutdownClient> barrier;
  nsCString profilePath, localPath, sourceId, mode{"legacy"_ns};
  nsCString journalPath, backupPath, backupHash;
  nsCString initialSelector, retainedSources, retainedBooks, retainedCaches;
  nsCString retainedServerSummaries{"[]"_ns};
  nsTArray<StartupServerSummary> serverSummaries;
  nsTArray<StartupMailSource> sources;
  nsTArray<StartupServerRoot> servers;
  nsTHashMap<nsCString, nsCString> backupFiles;
  nsTHashMap<nsCString, nsCOMPtr<nsIFile>> backupCopies;
  nsTHashMap<nsCString, nsCString> createdEmptyStores;
  nsTArray<nsCString> sourceIds;
  nsTArray<nsCOMPtr<nsIMsgFolder>> folders;
  nsTArray<nsCOMPtr<nsIMsgFolder>> localFolders;
  int32_t schema = -1;
  nsresult firstError = NS_OK, closeError = NS_OK;
  bool selected = false, existing = false, busy = false, opened = false,
       ready = false;
  bool closing = false, settled = false;
  nsTArray<RefPtr<Promise>> settlements;
  std::function<nsresult()> onShutdown;
#ifndef XP_WIN
  int profileFD = -1, localFD = -1, databaseFD = -1;
  struct stat profileIdentity{}, localIdentity{}, databaseIdentity{};
#else
  // Retained handle admissions of the original spellings; see StartupAdmit.
  RefPtr<MigrationFileSystem> fileSystem;
  nsCOMPtr<nsIPanoramaMigrationPath> profileLease, localLease, databaseLease;
#endif

 private:
  ~ProfileStartupOperation() {
#ifndef XP_WIN
    if (databaseFD >= 0) close(databaseFD);
    if (profileFD >= 0) close(profileFD);
    if (localFD >= 0) close(localFD);
#endif
  }
};
NS_IMPL_ISUPPORTS(ProfileStartupOperation, nsIAsyncShutdownBlocker)

DatabaseCore::~DatabaseCore() = default;

// A UTF-8 file path for comparison with stored path strings. Windows has no
// native narrow path; there the UTF-16 path is converted, as PathUtils does.
static nsresult GetComparablePath(nsIFile* file, nsACString& path) {
#ifdef XP_WIN
  nsAutoString wide;
  MOZ_TRY(file->GetPath(wide));
  CopyUTF16toUTF8(wide, path);
  return NS_OK;
#else
  return file->GetNativePath(path);
#endif
}

// The inverse of GetComparablePath for retained UTF-8 path strings. Windows
// native 8-bit paths use the ANSI code page, not UTF-8.
static nsresult NewComparableFile(const nsACString& path, nsIFile** file) {
#ifdef XP_WIN
  return NS_NewLocalFile(NS_ConvertUTF8toUTF16(path), file);
#else
  return NS_NewNativeLocalFile(path, file);
#endif
}

namespace {
// A link above a selected startup profile whose canonical target contains
// that profile is the operating system's alias of its location (macOS /var
// to /private/var). A link at or inside the profile is never such an alias.
bool StartupAliasAboveProfile(nsIFile* entry) {
  for (const char* key :
       {NS_APP_PROFILE_DIR_STARTUP, NS_APP_PROFILE_LOCAL_DIR_STARTUP}) {
    nsCOMPtr<nsIFile> profile, parent, location, target;
    nsAutoString leaf;
    bool equal = true, inside = true, contains = false;
    if (NS_FAILED(NS_GetSpecialDirectory(key, getter_AddRefs(profile))) ||
        NS_FAILED(profile->Normalize()) ||
        NS_FAILED(entry->GetParent(getter_AddRefs(parent))) || !parent ||
        NS_FAILED(parent->Clone(getter_AddRefs(location))) ||
        NS_FAILED(location->Normalize()) ||
        NS_FAILED(entry->GetLeafName(leaf)) ||
        NS_FAILED(location->Append(leaf)) ||
        NS_FAILED(entry->Clone(getter_AddRefs(target))) ||
        NS_FAILED(target->Normalize()) ||
        NS_FAILED(profile->Equals(location, &equal)) ||
        NS_FAILED(profile->Contains(location, &inside)) ||
        NS_FAILED(target->Contains(profile, &contains))) {
      continue;
    }
    if (!equal && !inside && contains) return true;
  }
  return false;
}
nsresult StartupDirectory(nsIFile* file, nsACString& path) {
  NS_ENSURE_TRUE(file, NS_ERROR_INVALID_ARG);
  bool directory, linked;
  MOZ_TRY(file->IsDirectory(&directory));
  MOZ_TRY(file->IsSymlink(&linked));
  NS_ENSURE_TRUE(directory && !linked, NS_ERROR_FILE_ACCESS_DENIED);
  MOZ_TRY(GetComparablePath(file, path));
  // Every ancestor must retain its literal spelling, except an operating
  // system alias above the selected profile; any other link at any depth is
  // not a selected physical directory admission.
  bool aliased = false;
  nsCOMPtr<nsIFile> current = file;
  while (current) {
    MOZ_TRY(current->IsSymlink(&linked));
    if (linked) {
      NS_ENSURE_TRUE(StartupAliasAboveProfile(current),
                     NS_ERROR_FILE_ACCESS_DENIED);
      aliased = true;
    }
    nsCOMPtr<nsIFile> parent;
    MOZ_TRY(current->GetParent(getter_AddRefs(parent)));
    current = parent;
  }
  nsCOMPtr<nsIFile> normalized;
  MOZ_TRY(file->Clone(getter_AddRefs(normalized)));
  MOZ_TRY(normalized->Normalize());
  nsAutoCString actual;
  MOZ_TRY(GetComparablePath(normalized, actual));
  if (aliased) {
    // The canonical spelling resolves only that alias; the leaf is unchanged.
    nsAutoString leaf, actualLeaf;
    MOZ_TRY(file->GetLeafName(leaf));
    MOZ_TRY(normalized->GetLeafName(actualLeaf));
    NS_ENSURE_TRUE(leaf == actualLeaf, NS_ERROR_FILE_INVALID_PATH);
    path = actual;
    return NS_OK;
  }
  NS_ENSURE_TRUE(actual == path, NS_ERROR_FILE_INVALID_PATH);
  return NS_OK;
}
nsresult StartupChild(nsIFile* parent, const char* leaf, nsIFile** output) {
  MOZ_TRY(parent->Clone(output));
  return (*output)->AppendNative(nsDependentCString(leaf));
}
nsresult StartupRegular(nsIFile* file) {
  bool regular, linked;
  MOZ_TRY(file->IsFile(&regular));
  MOZ_TRY(file->IsSymlink(&linked));
  NS_ENSURE_TRUE(regular && !linked, NS_ERROR_FILE_ACCESS_DENIED);
  nsCOMPtr<nsIFile> parent;
  MOZ_TRY(file->GetParent(getter_AddRefs(parent)));
  nsAutoCString path;
  return StartupDirectory(parent, path);
}
nsresult StartupRead(nsIFile* file, nsACString& bytes) {
  MOZ_TRY(StartupRegular(file));
  int64_t size;
  MOZ_TRY(file->GetFileSize(&size));
  NS_ENSURE_TRUE(size > 0 && size <= 64 * 1024 * 1024, NS_ERROR_FILE_CORRUPTED);
  nsCOMPtr<nsIInputStream> stream;
  MOZ_TRY(NS_NewLocalFileInputStream(getter_AddRefs(stream), file));
  auto close = MakeScopeExit([&] { stream->Close(); });
  MOZ_TRY(NS_ReadInputStreamToString(stream, bytes, size));
  NS_ENSURE_TRUE(bytes.Length() == uint64_t(size), NS_ERROR_FILE_CORRUPTED);
  MOZ_TRY(stream->Close());
  close.release();
  return NS_OK;
}
nsresult StartupHash(nsIFile* file, nsACString& hex) {
  MOZ_TRY(StartupRegular(file));
  nsCOMPtr<nsIInputStream> stream;
  MOZ_TRY(NS_NewLocalFileInputStream(getter_AddRefs(stream), file));
  auto close = MakeScopeExit([&] { stream->Close(); });
  nsCOMPtr<nsICryptoHash> hash;
  MOZ_TRY(NS_NewCryptoHash(nsICryptoHash::SHA256, getter_AddRefs(hash)));
  uint64_t available;
  MOZ_TRY(stream->Available(&available));
  NS_ENSURE_TRUE(available < UINT32_MAX, NS_ERROR_FILE_TOO_BIG);
  if (available) MOZ_TRY(hash->UpdateFromStream(stream, available));
  MOZ_TRY(stream->Close());
  close.release();
  nsAutoCString bytes;
  MOZ_TRY(hash->Finish(false, bytes));
  hex.Truncate();
  for (unsigned char byte : bytes.View()) {
    hex.Append("0123456789abcdef"[byte >> 4]);
    hex.Append("0123456789abcdef"[byte & 15]);
  }
  return NS_OK;
}
#ifdef XP_WIN
// Windows has no O_NOFOLLOW descriptor or st_dev/st_ino pair. The existing
// migration admission is the startup physical identity instead: the full
// volume serial and 128-bit file ID of every component, refusing reparse and
// offline components, with retained handles that deny deletion or renaming of
// each checked component while still permitting child operations. A database
// lease uses FILE_OR_MISSING sharing so SQLite keeps its own read/write access;
// only a present regular file is admitted. Failures mirror the POSIX refusal.
nsresult StartupAdmit(ProfileStartupOperation& operation, nsIFile* file,
                      nsIFile* root, uint16_t kind,
                      nsCOMPtr<nsIPanoramaMigrationPath>& output) {
  nsCOMPtr<nsIPanoramaMigrationPath> lease;
  nsresult rv =
      operation.fileSystem->Admit(file, root, kind, getter_AddRefs(lease));
  bool exists = false;
  if (NS_SUCCEEDED(rv)) rv = lease->GetExists(&exists);
  if (NS_FAILED(rv) || !exists) {
    MOZ_LOG(gPanoramaLog, LogLevel::Error,
            ("Startup physical admission refused: 0x%08x", unsigned(rv)));
    if (lease) (void)lease->Close();
    return NS_ERROR_FILE_ACCESS_DENIED;
  }
  output = std::move(lease);
  return NS_OK;
}
#endif
}  // namespace

nsresult DatabaseCore::ArmProfileStartup(nsIFile* profile, nsIFile* local) {
  NS_ENSURE_TRUE(
      NS_IsMainThread() && !mShuttingDown && !mProfileStartup && !sConnection,
      NS_ERROR_NOT_AVAILABLE);
  mStartupManaged = true;
  RefPtr<ProfileStartupOperation> operation = new ProfileStartupOperation();
  MOZ_TRY(StartupDirectory(profile, operation->profilePath));
  MOZ_TRY(StartupDirectory(local, operation->localPath));
  // Bind the canonical locations admitted above, not an aliased spelling.
  nsCOMPtr<nsIFile> canonicalProfile, canonicalLocal;
  MOZ_TRY(profile->Clone(getter_AddRefs(canonicalProfile)));
  MOZ_TRY(canonicalProfile->Normalize());
  MOZ_TRY(local->Clone(getter_AddRefs(canonicalLocal)));
  MOZ_TRY(canonicalLocal->Normalize());
  operation->profile = canonicalProfile;
  operation->localProfile = canonicalLocal;
#ifdef XP_WIN
  // Admit the original spellings before lexical normalization; every
  // component, including those above the profile, must be a plain directory.
  operation->fileSystem = new MigrationFileSystem();
  MOZ_TRY(StartupAdmit(*operation, profile, profile,
                       nsIPanoramaMigrationFileSystem::KIND_DIRECTORY,
                       operation->profileLease));
  MOZ_TRY(StartupAdmit(*operation, local, local,
                       nsIPanoramaMigrationFileSystem::KIND_DIRECTORY,
                       operation->localLease));
#else
  operation->profileFD = open(operation->profilePath.get(),
                              O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  operation->localFD = open(operation->localPath.get(),
                            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  NS_ENSURE_TRUE(
      operation->profileFD >= 0 && operation->localFD >= 0 &&
          !fstat(operation->profileFD, &operation->profileIdentity) &&
          !fstat(operation->localFD, &operation->localIdentity),
      NS_ERROR_FILE_ACCESS_DENIED);
#endif
  nsCOMPtr<nsIAsyncShutdownService> shutdown =
      do_GetService("@mozilla.org/async-shutdown-service;1");
  NS_ENSURE_TRUE(shutdown, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(shutdown->GetProfileBeforeChange(getter_AddRefs(operation->barrier)));
  MOZ_TRY(operation->barrier->AddBlocker(
      operation, NS_LITERAL_STRING_FROM_CSTRING(__FILE__), __LINE__,
      u"Selected Panorama startup and native storage settlement"_ns));
  mProfileStartup = operation;
  // Only the identity of this instance is captured; it is used only while it
  // is still the live singleton.
  operation->onShutdown = [token = static_cast<const void*>(this)]() {
    RefPtr<DatabaseCore> core = sInstance.get();
    NS_ENSURE_TRUE(core && static_cast<const void*>(core.get()) == token &&
                       core->mProfileStartup && core->mProfileStartup->ready,
                   NS_ERROR_NOT_AVAILABLE);
    return core->SettleProfileStartup(NS_OK);
  };
  nsCOMPtr<nsIObserverService> observers = services::GetObserverService();
  NS_ENSURE_TRUE(observers, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(observers->AddObserver(this, "profile-before-change", false));
  return NS_OK;
}

nsISupports* DatabaseCore::ProfileStartupToken() {
  return static_cast<nsIAsyncShutdownBlocker*>(mProfileStartup.get());
}
nsresult DatabaseCore::CheckProfileStartup(nsISupports* token, bool metadata) {
  NS_ENSURE_TRUE(NS_IsMainThread() && sInstance == this && mProfileStartup &&
                     token == ProfileStartupToken(),
                 NS_ERROR_NOT_AVAILABLE);
  auto& operation = *mProfileStartup;
  NS_ENSURE_SUCCESS(operation.firstError, operation.firstError);
  NS_ENSURE_FALSE(mShuttingDown || operation.closing || operation.settled,
                  NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_FALSE(operation.busy && !metadata, NS_ERROR_IN_PROGRESS);
#ifndef XP_WIN
  struct stat profile{}, local{};
  NS_ENSURE_TRUE(!lstat(operation.profilePath.get(), &profile) &&
                     !lstat(operation.localPath.get(), &local) &&
                     profile.st_dev == operation.profileIdentity.st_dev &&
                     profile.st_ino == operation.profileIdentity.st_ino &&
                     local.st_dev == operation.localIdentity.st_dev &&
                     local.st_ino == operation.localIdentity.st_ino &&
                     S_ISDIR(profile.st_mode) && S_ISDIR(local.st_mode),
                 NS_ERROR_FILE_ACCESS_DENIED);
#else
  // Re-walk each original spelling and compare every retained physical ID:
  // a replaced, linked or removed directory or database is refused.
  NS_ENSURE_TRUE(operation.profileLease && operation.localLease,
                 NS_ERROR_FILE_ACCESS_DENIED);
  for (nsIPanoramaMigrationPath* lease :
       {operation.profileLease.get(), operation.localLease.get(),
        operation.databaseLease.get()}) {
    NS_ENSURE_TRUE(
        !lease || NS_SUCCEEDED(operation.fileSystem->Validate(lease)),
        NS_ERROR_FILE_ACCESS_DENIED);
  }
#endif
#ifndef XP_WIN
  if (operation.databaseFD >= 0) {
    struct stat database{};
    nsAutoCString path(operation.profilePath + "/panorama.sqlite"_ns);
    NS_ENSURE_TRUE(!lstat(path.get(), &database) && S_ISREG(database.st_mode) &&
                       database.st_dev == operation.databaseIdentity.st_dev &&
                       database.st_ino == operation.databaseIdentity.st_ino,
                   NS_ERROR_FILE_ACCESS_DENIED);
  }
#endif
  for (auto entry :
       {std::pair{NS_APP_PROFILE_DIR_STARTUP, &operation.profilePath},
        std::pair{NS_APP_PROFILE_LOCAL_DIR_STARTUP, &operation.localPath}}) {
    nsCOMPtr<nsIFile> selected;
    MOZ_TRY(NS_GetSpecialDirectory(entry.first, getter_AddRefs(selected)));
    nsAutoCString path;
    MOZ_TRY(StartupDirectory(selected, path));
    NS_ENSURE_TRUE(path == *entry.second, NS_ERROR_NOT_AVAILABLE);
  }
  return NS_OK;
}

/* static */ void DatabaseCore::RetainStartupAccount(
    nsIAsyncShutdownBlocker* account) {
  if (sInstance && sInstance->mStartupManaged && sInstance->mProfileStartup &&
      !sInstance->mProfileStartup->settled) {
    sInstance->mStartupAccount = account;
  }
}

/* static */ nsresult DatabaseCore::CheckAccountStartup(
    bool metadata, const nsACString* serverKey) {
  if (sInstance && sInstance->mStartupManaged) {
    auto& core = *sInstance;
    bool admittedMetadata = metadata && core.mStartupMetadataDepth;
    if (metadata && serverKey && core.mProfileStartup &&
        core.mProfileStartup->opened) {
      for (const auto& source : core.mProfileStartup->servers)
        admittedMetadata |= source.key == *serverKey;
    }
    MOZ_TRY(
        core.CheckProfileStartup(core.ProfileStartupToken(), admittedMetadata));
    NS_ENSURE_TRUE(core.mProfileStartup->ready || admittedMetadata,
                   NS_ERROR_NOT_AVAILABLE);
    return NS_OK;
  }
  // Even default/Mork startup must not ignore a durable Panorama selection.
  // Managed production startup reads its exact format/version before this
  // boundary; unmanaged service consumers never bypass it by creating a core.
  nsCOMPtr<nsIFile> profile, selector;
  nsresult rv = NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR,
                                       getter_AddRefs(profile));
  if (NS_FAILED(rv)) return rv;
  MOZ_TRY(
      StartupChild(profile, "panorama-profile.json", getter_AddRefs(selector)));
  bool exists;
  MOZ_TRY(selector->Exists(&exists));
  return exists ? NS_ERROR_NOT_AVAILABLE : NS_OK;
}

/* static */
already_AddRefed<DatabaseCore> DatabaseCore::GetInstanceForService() {
  if (!sInstance) {
    sInstance = new DatabaseCore();
    static bool registered = false;
    if (!registered) {
      ClearOnShutdown(&sInstance);
      registered = true;
    }
  }
  return do_AddRef(sInstance);
}

DatabaseCore::DatabaseCore() {
  MOZ_ASSERT(!sConnection, "creating a second DatabaseCore");
}

NS_IMETHODIMP
DatabaseCore::Startup() {
  NS_ENSURE_FALSE(mShuttingDown, NS_ERROR_NOT_AVAILABLE);
  if (!mStartupManaged) MOZ_TRY(CheckAccountStartup());
  NS_ENSURE_TRUE(!mStartupManaged || mStartupOpening, NS_ERROR_NOT_AVAILABLE);
  if (sConnection) {
    MOZ_LOG(gPanoramaLog, LogLevel::Error, ("DatabaseCore is already started"));
    return NS_ERROR_FAILURE;
  }

  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("DatabaseCore starting up"));

  nsresult rv = EnsureConnection(true);
  NS_ENSURE_SUCCESS(rv, rv);

  mCacheOriginGeneration.Truncate();
  if (sDatabaseIsNew) {
    // The already committed new-incarnation UUID is native birth identity.
    // Reopening the same file never recreates this live capture generation.
    MOZ_TRY(ReadSourceIdForFolderAdmission(mCacheOriginGeneration));
  }
  mFolderDatabase = new FolderDatabase();

  mMessageDatabase = new MessageDatabase();
  mMessageDatabase->Startup();

  nsCOMPtr<nsIObserverService> obs = mozilla::services::GetObserverService();
  if (!mStartupManaged) obs->AddObserver(this, "profile-before-change", false);

  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("DatabaseCore startup complete"));
  return NS_OK;
}

NS_IMETHODIMP
DatabaseCore::Observe(nsISupports* aSubject, const char* aTopic,
                      const char16_t* aData) {
  if (!strcmp(aTopic, "app-startup")) {
    NS_ENSURE_TRUE(XRE_IsParentProcess() && !mStartupObserved,
                   NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsICommandLine> commandLine = do_QueryInterface(aSubject);
    NS_ENSURE_TRUE(commandLine, NS_ERROR_INVALID_ARG);
    mStartupObserved = true;
    nsCOMPtr<nsIFile> profile, local, selector;
    nsresult rv = NS_GetSpecialDirectory(NS_APP_PROFILE_DIR_STARTUP,
                                         getter_AddRefs(profile));
    bool hasSelector = false;
    if (NS_SUCCEEDED(rv))
      rv = StartupChild(profile, "panorama-profile.json",
                        getter_AddRefs(selector));
    if (NS_SUCCEEDED(rv)) rv = selector->Exists(&hasSelector);
    if (NS_SUCCEEDED(rv) && !StaticPrefs::mail_panorama_enabled_AtStartup() &&
        !hasSelector) {
      mStartupManaged = false;
      for (const auto& promise : mStartupBegins)
        promise->MaybeReject(NS_ERROR_NOT_AVAILABLE);
      mStartupBegins.Clear();
      return NS_OK;
    }
    mStartupManaged = true;
    if (NS_SUCCEEDED(rv))
      rv = NS_GetSpecialDirectory(NS_APP_PROFILE_LOCAL_DIR_STARTUP,
                                  getter_AddRefs(local));
    if (NS_SUCCEEDED(rv) && !StaticPrefs::mail_panorama_enabled_AtStartup())
      rv = NS_ERROR_NOT_AVAILABLE;
    if (NS_SUCCEEDED(rv)) rv = ArmProfileStartup(profile, local);
    if (NS_SUCCEEDED(rv)) {
      dom::AutoJSAPI jsapi;
      if (!jsapi.Init(xpc::PrivilegedJunkScope()))
        rv = NS_ERROR_FAILURE;
      else {
        JS::Rooted<JS::Value> descriptor(jsapi.cx());
        rv = DescribeProfileStartup(jsapi.cx(), &descriptor);
        if (jsapi.HasException()) jsapi.ReportException();
      }
    }
    mStartupFailure = rv;
    for (const auto& promise : mStartupBegins) {
      if (NS_FAILED(rv))
        promise->MaybeReject(rv);
      else
        promise->MaybeResolve(ProfileStartupToken());
    }
    mStartupBegins.Clear();
    if (NS_FAILED(rv) && mProfileStartup) {
      mProfileStartup->Remember(rv);
      // No target/caller work was admitted and no opaque token escaped.
      // Settle the genuine native lifetime instead of stranding a blocker.
      (void)SettleProfileStartup(rv);
    }
    return rv;
  }
  if (strcmp(aTopic, "profile-before-change")) {
    return NS_OK;
  }

  if (mShuttingDown) {
    if (mProfileStartup && mProfileStartup->settled) {
      nsCOMPtr<nsIObserverService> observers = services::GetObserverService();
      observers->RemoveObserver(this, "profile-before-change");
      if (sInstance.get() == this) sInstance = nullptr;
    }
    return NS_OK;
  }
  if (mProfileStartup && mProfileStartup->ready && !mProfileStartup->settled) {
    return SettleProfileStartup(NS_OK);
  }
  if (mProfileStartup && !mProfileStartup->settled && !mProfileStartup->ready) {
    mProfileStartup->closing = true;
    mProfileStartup->Remember(NS_ERROR_ABORT);
    return NS_ERROR_IN_PROGRESS;
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

  if (sInstance.get() == this) sInstance = nullptr;

  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("DatabaseCore shutdown complete"));

  return NS_OK;
}

/**
 * Ensures a mozIStorageConnection to panorama.sqlite in the profile folder.
 */
nsresult DatabaseCore::EnsureConnection(bool aAllowNewConnection) {
  NS_ENSURE_TRUE(!sInstance || !sInstance->mStartupManaged || sConnection ||
                     sInstance->mStartupOpening,
                 NS_ERROR_NOT_AVAILABLE);
  if (sConnection) {
    return NS_OK;
  }
  // Only explicit startup may open a connection after native teardown.
  NS_ENSURE_TRUE(aAllowNewConnection && sInstance && !sInstance->mShuttingDown,
                 NS_ERROR_NOT_AVAILABLE);

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
  NS_ENSURE_TRUE(version >= 0 && version <= 21, NS_ERROR_NOT_AVAILABLE);
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
  if (version < 17) {
    MOZ_TRY(CheckReferenceSchemaTable(
        sConnection, "offline_attempts",
        "id:INTEGER:0:1,operationId:INTEGER:1:0,revision:INTEGER:1:0,state:"
        "INTEGER:1:0,"
        "sourceFolderId:INTEGER:0:0,sourceKey:INTEGER:0:0,sourceEpoch:INTEGER:"
        "0:"
        "0,"
        "sourceUid:INTEGER:0:0,destinationFolderId:INTEGER:0:0,destinationKey:"
        "INTEGER:0:0,"
        "destinationEpoch:INTEGER:0:0,confirmedUid:INTEGER:0:0,"
        "operationFolderId:"
        "INTEGER:1:0,operationEpoch:INTEGER:0:0,operation:INTEGER:1:0"));
  }
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
  if (version < 16) {
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
        "TEXT:1:0,folderEpoch:INTEGER:0:0,destinationFolderId:INTEGER:0:0,"
        "destinationKey:INTEGER:0:0,destinationEpoch:INTEGER:0:0"));
  }
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
  if (version < 16) {
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "ALTER TABLE offline_operations ADD COLUMN sourcePhysicalKey INTEGER"_ns));
    MOZ_TRY(sConnection->SetSchemaVersion(16));
  }
  if (version < 17) {
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts ADD COLUMN appendAccepted INTEGER NOT "
        "NULL "
        "DEFAULT 0 CHECK(appendAccepted IN (0,1));"
        "ALTER TABLE offline_attempts ADD COLUMN appendSourceId TEXT;"
        "ALTER TABLE offline_attempts ADD COLUMN appendContentRevision INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN appendLocationRevision "
        "INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN appendStoreToken TEXT;"
        "ALTER TABLE offline_attempts ADD COLUMN appendMessageSize INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN appendOfflineSize INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN appendLineCount INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN appendFlags INTEGER;"_ns));
    MOZ_TRY(sConnection->SetSchemaVersion(17));
  }
  if (version < 18) {
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "ALTER TABLE offline_attempts ADD COLUMN transferSourceId TEXT;"
        "ALTER TABLE offline_attempts ADD COLUMN transferOperationKey INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN copyOrdinal INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN transferAccepted INTEGER NOT "
        "NULL "
        "DEFAULT 0 CHECK(transferAccepted IN (0,1));"
        "ALTER TABLE offline_attempts ADD COLUMN transferContentRevision "
        "INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN transferLocationRevision "
        "INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN transferStoreToken TEXT;"
        "ALTER TABLE offline_attempts ADD COLUMN transferMessageSize INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN transferOfflineSize INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN transferLineCount INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN transferFlags INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN confirmedEpoch INTEGER;"_ns));
    MOZ_TRY(sConnection->SetSchemaVersion(18));
  }
  if (version < 19) {
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "ALTER TABLE offline_operations ADD COLUMN flagSetMask INTEGER;"
        "ALTER TABLE offline_operations ADD COLUMN flagClearMask INTEGER;"
        "ALTER TABLE offline_operations ADD COLUMN guardSourceId TEXT;"
        "ALTER TABLE offline_operations ADD COLUMN guardFolderId INTEGER;"
        "ALTER TABLE offline_operations ADD COLUMN guardKey INTEGER;"
        "ALTER TABLE offline_operations ADD COLUMN guardContentRevision "
        "INTEGER;"
        "ALTER TABLE offline_operations ADD COLUMN guardLocationRevision "
        "INTEGER;"
        "ALTER TABLE offline_operations ADD COLUMN guardStoreToken TEXT;"
        "ALTER TABLE offline_operations ADD COLUMN guardMessageSize INTEGER;"
        "ALTER TABLE offline_operations ADD COLUMN guardOfflineSize INTEGER;"
        "ALTER TABLE offline_operations ADD COLUMN guardLineCount INTEGER;"
        "ALTER TABLE offline_operations ADD COLUMN guardFlags INTEGER;"
        "ALTER TABLE offline_operations ADD COLUMN guardPresence INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN flagSetMask INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN flagClearMask INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN guardSourceId TEXT;"
        "ALTER TABLE offline_attempts ADD COLUMN guardFolderId INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN guardKey INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN guardContentRevision INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN guardLocationRevision INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN guardStoreToken TEXT;"
        "ALTER TABLE offline_attempts ADD COLUMN guardMessageSize INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN guardOfflineSize INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN guardLineCount INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN guardFlags INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN guardPresence INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN replayVersion INTEGER NOT "
        "NULL DEFAULT 0;"
        "ALTER TABLE offline_attempts ADD COLUMN moveExpunge INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN flagSetState INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN flagSetGeneration INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN flagSetError INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN flagClearState INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN flagClearGeneration INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN flagClearError INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN sourceStoreState INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN sourceStoreGeneration INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN sourceStoreError INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN sourceExpungeState INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN sourceExpungeGeneration "
        "INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN sourceExpungeError INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN moveSettled INTEGER NOT NULL "
        "DEFAULT 0;"
        "ALTER TABLE offline_attempts ADD COLUMN firstError INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN settledSourceRemoved INTEGER;"
        "ALTER TABLE offline_attempts ADD COLUMN settledOperationRetired "
        "INTEGER;"
        ""_ns));
    MOZ_TRY(sConnection->SetSchemaVersion(19));
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
      "destinationKey:INTEGER:0:0,destinationEpoch:INTEGER:0:0,"
      "sourcePhysicalKey:INTEGER:0:0,"
      "flagSetMask:INTEGER:0:0,"
      "flagClearMask:INTEGER:0:0,"
      "guardSourceId:TEXT:0:0,"
      "guardFolderId:INTEGER:0:0,"
      "guardKey:INTEGER:0:0,"
      "guardContentRevision:INTEGER:0:0,"
      "guardLocationRevision:INTEGER:0:0,"
      "guardStoreToken:TEXT:0:0,"
      "guardMessageSize:INTEGER:0:0,"
      "guardOfflineSize:INTEGER:0:0,"
      "guardLineCount:INTEGER:0:0,"
      "guardFlags:INTEGER:0:0,"
      "guardPresence:INTEGER:0:0"));
  MOZ_TRY(CheckReferenceSchemaTable(
      sConnection, "offline_attempts",
      "id:INTEGER:0:1,operationId:INTEGER:1:0,revision:INTEGER:1:0,state:"
      "INTEGER:1:0,"
      "sourceFolderId:INTEGER:0:0,sourceKey:INTEGER:0:0,sourceEpoch:INTEGER:0:"
      "0,"
      "sourceUid:INTEGER:0:0,destinationFolderId:INTEGER:0:0,destinationKey:"
      "INTEGER:0:0,"
      "destinationEpoch:INTEGER:0:0,confirmedUid:INTEGER:0:0,operationFolderId:"
      "INTEGER:1:0,"
      "operationEpoch:INTEGER:0:0,operation:INTEGER:1:0,appendAccepted:INTEGER:"
      "1:0,"
      "appendSourceId:TEXT:0:0,appendContentRevision:INTEGER:0:0,"
      "appendLocationRevision:INTEGER:0:0,appendStoreToken:TEXT:0:0,"
      "appendMessageSize:INTEGER:0:0,appendOfflineSize:INTEGER:0:0,"
      "appendLineCount:INTEGER:0:0,appendFlags:INTEGER:0:0,"
      "transferSourceId:TEXT:0:0,transferOperationKey:INTEGER:0:0,"
      "copyOrdinal:INTEGER:0:0,transferAccepted:INTEGER:1:0,"
      "transferContentRevision:INTEGER:0:0,transferLocationRevision:INTEGER:0:"
      "0,"
      "transferStoreToken:TEXT:0:0,transferMessageSize:INTEGER:0:0,"
      "transferOfflineSize:INTEGER:0:0,transferLineCount:INTEGER:0:0,"
      "transferFlags:INTEGER:0:0,confirmedEpoch:INTEGER:0:0,"
      "flagSetMask:INTEGER:0:0,"
      "flagClearMask:INTEGER:0:0,"
      "guardSourceId:TEXT:0:0,"
      "guardFolderId:INTEGER:0:0,"
      "guardKey:INTEGER:0:0,"
      "guardContentRevision:INTEGER:0:0,"
      "guardLocationRevision:INTEGER:0:0,"
      "guardStoreToken:TEXT:0:0,"
      "guardMessageSize:INTEGER:0:0,"
      "guardOfflineSize:INTEGER:0:0,"
      "guardLineCount:INTEGER:0:0,"
      "guardFlags:INTEGER:0:0,"
      "guardPresence:INTEGER:0:0,"
      "replayVersion:INTEGER:1:0,"
      "moveExpunge:INTEGER:0:0,"
      "flagSetState:INTEGER:0:0,"
      "flagSetGeneration:INTEGER:0:0,"
      "flagSetError:INTEGER:0:0,"
      "flagClearState:INTEGER:0:0,"
      "flagClearGeneration:INTEGER:0:0,"
      "flagClearError:INTEGER:0:0,"
      "sourceStoreState:INTEGER:0:0,"
      "sourceStoreGeneration:INTEGER:0:0,"
      "sourceStoreError:INTEGER:0:0,"
      "sourceExpungeState:INTEGER:0:0,"
      "sourceExpungeGeneration:INTEGER:0:0,"
      "sourceExpungeError:INTEGER:0:0,"
      "moveSettled:INTEGER:1:0,"
      "firstError:INTEGER:0:0,"
      "settledSourceRemoved:INTEGER:0:0,"
      "settledOperationRetired:INTEGER:0:0"));
  if (version < 20) {
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "CREATE TABLE imap_import_units("
        "token TEXT NOT NULL PRIMARY KEY, databaseSourceId TEXT NOT NULL, "
        "provenance TEXT NOT NULL);"
        "CREATE TABLE imap_import_operations("
        "unitToken TEXT NOT NULL, member INTEGER NOT NULL, "
        "sourceKey INTEGER NOT NULL, messageKey INTEGER NOT NULL, "
        "operationId INTEGER NOT NULL, revision INTEGER NOT NULL, "
        "PRIMARY KEY(unitToken,member,sourceKey));"_ns));
    MOZ_TRY(sConnection->SetSchemaVersion(20));
  }
  MOZ_TRY(CheckReferenceSchemaTable(
      sConnection, "imap_import_units",
      "token:TEXT:1:1,databaseSourceId:TEXT:1:0,provenance:TEXT:1:0"));
  MOZ_TRY(CheckReferenceSchemaTable(
      sConnection, "imap_import_operations",
      "unitToken:TEXT:1:1,member:INTEGER:1:2,sourceKey:INTEGER:1:3,"
      "messageKey:INTEGER:1:0,operationId:INTEGER:1:0,revision:INTEGER:1:0"));
  if (version < 21) {
    MOZ_TRY(sConnection->ExecuteSimpleSQL(
        "CREATE TABLE imap_import_operation_holds("
        "operationId INTEGER PRIMARY KEY, databaseSourceId TEXT NOT NULL, "
        "folderId INTEGER NOT NULL, messageKey INTEGER NOT NULL);"
        "CREATE TRIGGER delete_imap_import_hold AFTER DELETE ON "
        "offline_operations "
        "BEGIN DELETE FROM imap_import_operation_holds "
        "WHERE operationId=OLD.id; END"_ns));
    MOZ_TRY(sConnection->SetSchemaVersion(21));
  }
  MOZ_TRY(CheckReferenceSchemaTable(
      sConnection, "imap_import_operation_holds",
      "operationId:INTEGER:0:1,databaseSourceId:TEXT:1:0,"
      "folderId:INTEGER:1:0,messageKey:INTEGER:1:0"));
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
    if (allowMissing && !expected.id.IsEmpty()) {
      // This selects a candidate kind only. Native admission and the expected
      // physical identities below still prove the original and live paths.
      bool directory;
      MOZ_TRY(original->IsDirectory(&directory));
      if (directory) kind = nsIPanoramaMigrationFileSystem::KIND_DIRECTORY;
    }
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

namespace {

void ImapImportFrame(nsACString& output, const nsACString& value) {
  output.AppendInt(static_cast<uint64_t>(value.Length()));
  output.Append(':');
  output.Append(value);
}

void ImapImportNumber(nsACString& output, uint64_t value) {
  nsAutoCString text;
  text.AppendInt(value);
  ImapImportFrame(output, text);
}

void ImapImportRef(nsACString& output,
                   const Maybe<ImapImportReference>& value) {
  ImapImportNumber(output, value.isSome());
  if (value) {
    ImapImportFrame(output, value->token);
    ImapImportNumber(output, value->sourceKey);
  }
}

nsCString ImapImportProvenance(const ImapImportUnit& input) {
  nsCString proof;
  ImapImportFrame(proof, input.token);
  ImapImportFrame(proof, input.databaseSourceId);
  ImapImportNumber(proof, input.folders.Length());
  for (const auto& member : input.folders) {
    const auto& snapshot = member.snapshot;
    const auto& id = snapshot.identity;
    for (const auto* text : {&id.token, &id.sourceId, &id.databaseSourceId,
                             &id.sourceSha256, &id.folderPath, &member.uri}) {
      ImapImportFrame(proof, *text);
    }
    ImapImportFrame(proof, NS_ConvertUTF16toUTF8(id.sourcePath));
    ImapImportNumber(proof, id.folderId);
    ImapImportNumber(proof, snapshot.sourceSize);
    ImapImportNumber(proof, id.windows.isSome());
    if (id.windows) {
      for (const auto* path : {&id.windows->summary, &id.windows->store}) {
        for (const auto* text : {&path->originalPath, &path->originalRoot,
                                 &path->canonicalPath, &path->canonicalRoot}) {
          ImapImportFrame(proof, NS_ConvertUTF16toUTF8(*text));
        }
        for (const auto* text : {&path->id, &path->parentId, &path->rootId}) {
          ImapImportFrame(proof, *text);
        }
      }
    }
    ImapImportNumber(proof, member.uidValidity.isSome());
    if (member.uidValidity) ImapImportNumber(proof, *member.uidValidity);
    ImapImportNumber(proof, member.serverUids.Length());
    for (const auto& uid : member.serverUids) {
      ImapImportNumber(proof, uid.sourceKey);
      ImapImportNumber(proof, uid.uid);
    }
    ImapImportNumber(proof, member.operations.Length());
    for (const auto& operation : member.operations) {
      const auto& op = operation.payload;
      ImapImportNumber(proof, operation.sourceKey);
      ImapImportNumber(proof, operation.payloadPresence);
      for (uint32_t value :
           {op.operation, op.flagOperation, op.newFlags, op.sourceKey,
            op.sourceUid, op.messageSize, uint32_t(op.playingBack)}) {
        ImapImportNumber(proof, value);
      }
      for (const auto* text : {&op.sourceFolderURI, &op.destinationFolderURI,
                               &op.keywordsToAdd, &op.keywordsToRemove}) {
        ImapImportFrame(proof, *text);
      }
      ImapImportRef(proof, operation.source);
      ImapImportRef(proof, operation.destination);
      ImapImportNumber(proof, op.copyDestinations.Length());
      for (size_t i = 0; i < op.copyDestinations.Length(); ++i) {
        ImapImportFrame(proof, op.copyDestinations[i]);
        if (i < operation.copies.Length()) {
          ImapImportRef(proof, operation.copies[i]);
        }
      }
    }
    ImapImportNumber(proof, member.bodies.Length());
    for (const auto& body : member.bodies) {
      ImapImportNumber(proof, body.sourceKey);
      ImapImportNumber(proof, body.size);
      ImapImportFrame(proof, body.sha256);
    }
  }
  return proof;
}

// An ordinary provider open still requires committed metadata. Keep that first
// measurement, then use this private checked path for the transaction's fresh
// recheck. Retaining an mbox provider stream would retain its prefetched bytes.
struct ImapImportBodyAdmission {
  nsMsgKey sourceKey{nsMsgKey_None};
  nsCString token;
  nsCOMPtr<nsIFile> folderPath;
  nsCOMPtr<nsIFile> file;
  nsCOMPtr<nsIMsgPluggableStore> store;
  bool mbox{false};
  int64_t offset{0};
};

nsresult AdmitImapImportBody(const ImapImportFolder& member,
                             const ImapImportBody& body,
                             ImapImportBodyAdmission& output) {
  NS_ENSURE_TRUE(member.folder, NS_ERROR_NOT_AVAILABLE);
  uint64_t folder;
  MOZ_TRY(member.folder->GetId(&folder));
  NS_ENSURE_TRUE(folder == member.snapshot.identity.folderId,
                 NS_ERROR_NOT_AVAILABLE);
  const RawHdr* header = nullptr;
  for (const auto& row : member.snapshot.messages) {
    if (row.sourceKey == body.sourceKey) header = &row.header;
  }
  NS_ENSURE_TRUE(header && header->storeToken && !header->storeToken->IsEmpty(),
                 NS_ERROR_NOT_AVAILABLE);
  output.sourceKey = body.sourceKey;
  output.token = *header->storeToken;
  MOZ_TRY(member.folder->GetMsgStore(getter_AddRefs(output.store)));
  NS_ENSURE_TRUE(output.store, NS_ERROR_NOT_AVAILABLE);
  nsCString type;
  MOZ_TRY(output.store->GetStoreType(type));
  NS_ENSURE_TRUE(type == "mbox"_ns || type == "maildir"_ns,
                 NS_ERROR_NOT_IMPLEMENTED);
  output.mbox = type == "mbox"_ns;
  MOZ_TRY(member.folder->GetFilePath(getter_AddRefs(output.folderPath)));
  MOZ_TRY(output.folderPath->Clone(getter_AddRefs(output.file)));
  if (output.mbox) {
    uint64_t offset;
    const char* end = output.token.EndReading();
    auto parsed = std::from_chars(output.token.BeginReading(), end, offset);
    NS_ENSURE_TRUE(parsed.ec == std::errc() && parsed.ptr == end &&
                       offset <= uint64_t(std::numeric_limits<int64_t>::max()),
                   NS_ERROR_ILLEGAL_VALUE);
    output.offset = int64_t(offset);
  } else {
    MOZ_TRY(output.file->Append(u"cur"_ns));
    MOZ_TRY(output.file->Append(NS_ConvertUTF8toUTF16(output.token)));
  }
  return NS_OK;
}

nsresult MeasureImapImportStream(nsIInputStream* stream,
                                 ImapImportBody& output) {
  NS_ENSURE_TRUE(stream, NS_ERROR_NOT_AVAILABLE);
  auto close = MakeScopeExit([&] { stream->Close(); });
  nsCOMPtr<nsICryptoHash> hash;
  MOZ_TRY(NS_NewCryptoHash(nsICryptoHash::SHA256, getter_AddRefs(hash)));
  char bytes[65536];
  uint64_t size = 0;
  while (true) {
    uint32_t count;
    MOZ_TRY(stream->Read(bytes, sizeof(bytes), &count));
    if (!count) break;
    size += count;
    NS_ENSURE_TRUE(size <= UINT32_MAX, NS_ERROR_FILE_TOO_BIG);
    MOZ_TRY(hash->Update(reinterpret_cast<const uint8_t*>(bytes), count));
  }
  MOZ_TRY(stream->Close());
  close.release();
  nsCString digest, hex;
  MOZ_TRY(hash->Finish(false, digest));
  for (unsigned char byte : digest.View()) {
    hex.Append("0123456789abcdef"[byte >> 4]);
    hex.Append("0123456789abcdef"[byte & 15]);
  }
  output.size = size;
  output.sha256 = std::move(hex);
  return NS_OK;
}

nsresult MeasureImapImportBody(const ImapImportFolder& member,
                               const RawHdr& header, ImapImportBody& output) {
  NS_ENSURE_TRUE(
      member.folder && header.storeToken && !header.storeToken->IsEmpty(),
      NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIMsgPluggableStore> store;
  MOZ_TRY(member.folder->GetMsgStore(getter_AddRefs(store)));
  NS_ENSURE_TRUE(store, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIInputStream> stream;
  MOZ_TRY(store->GetMsgInputStream(member.folder, *header.storeToken, 0,
                                   getter_AddRefs(stream)));
  return MeasureImapImportStream(stream, output);
}

nsresult RecheckImapImportBody(const ImapImportFolder& member,
                               const ImapImportBody& body,
                               const ImapImportBodyAdmission& admission) {
  NS_ENSURE_TRUE(member.folder && body.sourceKey == admission.sourceKey,
                 NS_ERROR_NOT_AVAILABLE);
  uint64_t folder;
  MOZ_TRY(member.folder->GetId(&folder));
  NS_ENSURE_TRUE(folder == member.snapshot.identity.folderId,
                 NS_ERROR_NOT_AVAILABLE);
  const RawHdr* header = nullptr;
  for (const auto& row : member.snapshot.messages) {
    if (row.sourceKey == body.sourceKey) header = &row.header;
  }
  NS_ENSURE_TRUE(
      header && header->storeToken && *header->storeToken == admission.token,
      NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIFile> path;
  MOZ_TRY(member.folder->GetFilePath(getter_AddRefs(path)));
  bool same;
  MOZ_TRY(admission.folderPath->Equals(path, &same));
  NS_ENSURE_TRUE(same, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIMsgPluggableStore> store;
  MOZ_TRY(member.folder->GetMsgStore(getter_AddRefs(store)));
  NS_ENSURE_TRUE(store == admission.store, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIInputStream> stream;
  MOZ_TRY(NS_NewLocalFileInputStream(getter_AddRefs(stream), admission.file));
  if (admission.mbox) {
    nsCOMPtr<nsISeekableStream> seekable = do_QueryInterface(stream);
    NS_ENSURE_TRUE(seekable, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(seekable->Seek(PR_SEEK_SET, admission.offset));
    stream = new MboxMsgInputStream(stream, 0);
  }
  ImapImportBody measured;
  MOZ_TRY(MeasureImapImportStream(stream, measured));
  NS_ENSURE_TRUE(measured.size == body.size && measured.sha256 == body.sha256,
                 NS_ERROR_NOT_AVAILABLE);
  return NS_OK;
}

nsresult CheckImapImportBodies(const ImapImportFolder& member) {
  nsTHashMap<nsMsgKey, bool> seen;
  for (const auto& body : member.bodies) {
    NS_ENSURE_FALSE(seen.Contains(body.sourceKey), NS_ERROR_INVALID_ARG);
    seen.InsertOrUpdate(body.sourceKey, true);
    const RawHdr* header = nullptr;
    for (const auto& row : member.snapshot.messages) {
      if (row.sourceKey == body.sourceKey) header = &row.header;
    }
    NS_ENSURE_TRUE(header, NS_ERROR_NOT_AVAILABLE);
    ImapImportBody measured;
    MOZ_TRY(MeasureImapImportBody(member, *header, measured));
    NS_ENSURE_TRUE(measured.size == body.size && measured.sha256 == body.sha256,
                   NS_ERROR_NOT_AVAILABLE);
  }
  return NS_OK;
}

// Compare only a newly written unit. A committed retry may legitimately retain
// receipt identities after its live messages or operations have been consumed.
bool SameImapImportReceipt(const ImapImportReceipt& a,
                           const ImapImportReceipt& b) {
  if (a.token != b.token || a.databaseSourceId != b.databaseSourceId ||
      a.folders.Length() != b.folders.Length()) {
    return false;
  }
  for (uint32_t i = 0; i < a.folders.Length(); ++i) {
    const auto& x = a.folders[i];
    const auto& y = b.folders[i];
    const auto& u = x.folder.identity;
    const auto& v = y.folder.identity;
    if (u.token != v.token || u.sourceId != v.sourceId ||
        u.databaseSourceId != v.databaseSourceId ||
        u.sourceSha256 != v.sourceSha256 || u.folderId != v.folderId ||
        u.folderPath != v.folderPath || u.sourcePath != v.sourcePath ||
        u.windows.isSome() != v.windows.isSome() ||
        x.folder.keys.Length() != y.folder.keys.Length() ||
        x.uidValidity != y.uidValidity ||
        x.serverUids.Length() != y.serverUids.Length() ||
        x.operations.Length() != y.operations.Length()) {
      return false;
    }
    if (u.windows && (!SameImportPath(u.windows->summary, v.windows->summary) ||
                      !SameImportPath(u.windows->store, v.windows->store))) {
      return false;
    }
    for (uint32_t j = 0; j < x.folder.keys.Length(); ++j) {
      if (x.folder.keys[j].source != y.folder.keys[j].source ||
          x.folder.keys[j].destination != y.folder.keys[j].destination) {
        return false;
      }
    }
    for (uint32_t j = 0; j < x.serverUids.Length(); ++j) {
      if (x.serverUids[j].sourceKey != y.serverUids[j].sourceKey ||
          x.serverUids[j].uid != y.serverUids[j].uid) {
        return false;
      }
    }
    for (uint32_t j = 0; j < x.operations.Length(); ++j) {
      const auto& op = x.operations[j];
      const auto& stored = y.operations[j];
      if (op.sourceKey != stored.sourceKey || op.key != stored.key ||
          op.id != stored.id || op.revision != stored.revision) {
        return false;
      }
    }
  }
  return true;
}

}  // namespace

// Decode only the native provenance already committed with the complete unit.
// This is a readback of our existing frame format, never a script import path.
// Later startup must not reopen the obsolete Mork files or replay its intent.
nsresult DatabaseCore::ReadStartupImapProvenance(const nsCString& proof,
                                                 ImapImportUnit& output) {
  const char* cursor = proof.BeginReading();
  const char* end = proof.EndReading();
  auto text = [&](nsACString& value) -> nsresult {
    uint32_t length;
    auto parsed = std::from_chars(cursor, end, length);
    NS_ENSURE_TRUE(parsed.ec == std::errc() && parsed.ptr != end &&
                       *parsed.ptr == ':' &&
                       uint64_t(end - parsed.ptr - 1) >= length,
                   NS_ERROR_FILE_CORRUPTED);
    cursor = parsed.ptr + 1;
    value.Assign(cursor, length);
    cursor += length;
    return NS_OK;
  };
  auto number = [&](auto& value) -> nsresult {
    nsAutoCString digits;
    MOZ_TRY(text(digits));
    uint64_t parsed;
    auto result =
        std::from_chars(digits.BeginReading(), digits.EndReading(), parsed);
    using T = std::remove_reference_t<decltype(value)>;
    NS_ENSURE_TRUE(result.ec == std::errc() &&
                       result.ptr == digits.EndReading() && !digits.IsEmpty() &&
                       parsed <= uint64_t(std::numeric_limits<T>::max()),
                   NS_ERROR_FILE_CORRUPTED);
    value = T(parsed);
    return NS_OK;
  };
  auto count = [&](uint32_t& value) -> nsresult {
    MOZ_TRY(number(value));
    NS_ENSURE_TRUE(value <= uint64_t(end - cursor), NS_ERROR_FILE_CORRUPTED);
    return NS_OK;
  };
  auto reference = [&](Maybe<ImapImportReference>& value) -> nsresult {
    bool present;
    MOZ_TRY(number(present));
    if (present) {
      ImapImportReference item;
      MOZ_TRY(text(item.token));
      MOZ_TRY(number(item.sourceKey));
      NS_ENSURE_TRUE(!item.token.IsEmpty() && item.sourceKey != nsMsgKey_None,
                     NS_ERROR_FILE_CORRUPTED);
      value = Some(std::move(item));
    }
    return NS_OK;
  };
  ImapImportUnit unit;
  MOZ_TRY(text(unit.token));
  MOZ_TRY(text(unit.databaseSourceId));
  uint32_t members;
  MOZ_TRY(count(members));
  NS_ENSURE_TRUE(
      members && !unit.token.IsEmpty() && !unit.databaseSourceId.IsEmpty(),
      NS_ERROR_FILE_CORRUPTED);
  for (uint32_t m = 0; m < members; ++m) {
    auto& member = *unit.folders.AppendElement();
    auto& id = member.snapshot.identity;
    for (auto* value : {&id.token, &id.sourceId, &id.databaseSourceId,
                        &id.sourceSha256, &id.folderPath, &member.uri})
      MOZ_TRY(text(*value));
    nsAutoCString path;
    MOZ_TRY(text(path));
    CopyUTF8toUTF16(path, id.sourcePath);
    MOZ_TRY(number(id.folderId));
    MOZ_TRY(number(member.snapshot.sourceSize));
    bool windows, epoch;
    MOZ_TRY(number(windows));
#ifdef XP_WIN
    // A Windows startup unit always committed its measured version2
    // admission. Reuse reads it back only to compare it with the durable
    // folder_import_windows row (ReadFolderImportReceipt); it never re-admits
    // the obsolete original summary or offline store.
    NS_ENSURE_TRUE(windows, NS_ERROR_NOT_AVAILABLE);
    FolderImportWindowsIdentity paths;
    for (auto* path : {&paths.summary, &paths.store}) {
      for (auto* value : {&path->originalPath, &path->originalRoot,
                          &path->canonicalPath, &path->canonicalRoot}) {
        nsAutoCString utf8;
        MOZ_TRY(text(utf8));
        CopyUTF8toUTF16(utf8, *value);
      }
      for (auto* value : {&path->id, &path->parentId, &path->rootId})
        MOZ_TRY(text(*value));
    }
    NS_ENSURE_FALSE(paths.summary.id.IsEmpty(), NS_ERROR_FILE_CORRUPTED);
    id.windows = Some(std::move(paths));
#else
    // This selected Unix operation cannot adopt a Windows physical receipt.
    NS_ENSURE_FALSE(windows, NS_ERROR_NOT_AVAILABLE);
#endif
    MOZ_TRY(number(epoch));
    if (epoch) {
      uint32_t value;
      MOZ_TRY(number(value));
      member.uidValidity = Some(value);
    }
    uint32_t length;
    MOZ_TRY(count(length));
    for (uint32_t i = 0; i < length; ++i) {
      auto& uid = *member.serverUids.AppendElement();
      MOZ_TRY(number(uid.sourceKey));
      MOZ_TRY(number(uid.uid));
    }
    MOZ_TRY(count(length));
    for (uint32_t i = 0; i < length; ++i) {
      auto& operation = *member.operations.AppendElement();
      auto& op = operation.payload;
      MOZ_TRY(number(operation.sourceKey));
      MOZ_TRY(number(operation.payloadPresence));
      NS_ENSURE_TRUE((operation.payloadPresence & ~uint32_t(0xfff)) == 0,
                     NS_ERROR_FILE_CORRUPTED);
      for (auto* value : {&op.operation, &op.flagOperation, &op.newFlags,
                          &op.sourceKey, &op.sourceUid, &op.messageSize})
        MOZ_TRY(number(*value));
      MOZ_TRY(number(op.playingBack));
      NS_ENSURE_FALSE(op.playingBack, NS_ERROR_FILE_CORRUPTED);
      for (auto* value : {&op.sourceFolderURI, &op.destinationFolderURI,
                          &op.keywordsToAdd, &op.keywordsToRemove})
        MOZ_TRY(text(*value));
      MOZ_TRY(reference(operation.source));
      MOZ_TRY(reference(operation.destination));
      uint32_t copies;
      MOZ_TRY(count(copies));
      for (uint32_t c = 0; c < copies; ++c) {
        MOZ_TRY(text(*op.copyDestinations.AppendElement()));
        MOZ_TRY(reference(*operation.copies.AppendElement()));
      }
    }
    MOZ_TRY(count(length));
    for (uint32_t i = 0; i < length; ++i) {
      auto& body = *member.bodies.AppendElement();
      MOZ_TRY(number(body.sourceKey));
      MOZ_TRY(number(body.size));
      MOZ_TRY(text(body.sha256));
      NS_ENSURE_TRUE(
          body.sourceKey != nsMsgKey_None && body.sha256.Length() == 64,
          NS_ERROR_FILE_CORRUPTED);
      for (char c : body.sha256.View())
        NS_ENSURE_TRUE((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'),
                       NS_ERROR_FILE_CORRUPTED);
    }
  }
  NS_ENSURE_TRUE(cursor == end && ImapImportProvenance(unit) == proof,
                 NS_ERROR_FILE_CORRUPTED);
  output = std::move(unit);
  return NS_OK;
}

nsresult DatabaseCore::ReadImapImportReceipt(const ImapImportUnit& input,
                                             const nsACString& provenance,
                                             Maybe<ImapImportReceipt>& output,
                                             bool durableStartup) {
  NS_ENSURE_FALSE(input.folders.IsEmpty(), NS_ERROR_INVALID_ARG);
  if (durableStartup) {
    MOZ_TRY(CheckProfileStartup(ProfileStartupToken(), true));
    NS_ENSURE_TRUE(mProfileStartup->mode == "reuse"_ns &&
                       mProfileStartup->opened && mProfileStartup->busy &&
                       !mProfileStartup->ready,
                   NS_ERROR_NOT_AVAILABLE);
    nsCString current;
    MOZ_TRY(ReadDatabaseSourceId(sConnection, current));
    NS_ENSURE_TRUE(current == input.databaseSourceId, NS_ERROR_NOT_AVAILABLE);
  } else {
    MOZ_TRY(CheckFolderImportIdentity(input.folders[0].snapshot.identity));
  }
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(GetStatement(
      "ReadImapImportUnit"_ns,
      "SELECT databaseSourceId,provenance FROM imap_import_units WHERE token=:token"_ns,
      getter_AddRefs(stmt)));
  {
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindUTF8StringByName("token"_ns, input.token));
    bool exists;
    MOZ_TRY(stmt->ExecuteStep(&exists));
    if (!exists) {
      output.reset();
      return NS_OK;
    }
    nsCString database, stored;
    MOZ_TRY(stmt->GetUTF8String(0, database));
    MOZ_TRY(stmt->GetUTF8String(1, stored));
    NS_ENSURE_TRUE(database == input.databaseSourceId && stored == provenance,
                   NS_ERROR_ALREADY_INITIALIZED);
  }
  ImapImportReceipt result;
  result.token = input.token;
  result.databaseSourceId = input.databaseSourceId;
  MOZ_TRY(GetStatement(
      "ReadImapImportOperations"_ns,
      "SELECT sourceKey,messageKey,operationId,revision FROM "
      "imap_import_operations WHERE unitToken=:token AND member=:member "
      "ORDER BY sourceKey"_ns,
      getter_AddRefs(stmt)));
  nsTHashMap<nsMsgKey, bool> globalKeys;
  nsTHashMap<uint64_t, bool> operationIds;
  for (uint32_t i = 0; i < input.folders.Length(); ++i) {
    const auto& original = input.folders[i];
    Maybe<FolderImportReceipt> member;
    if (!durableStartup)
      MOZ_TRY(CheckFolderImportIdentity(original.snapshot.identity));
    MOZ_TRY(ReadFolderImportReceipt(original.snapshot.identity, member));
    NS_ENSURE_TRUE(member, NS_ERROR_FILE_CORRUPTED);
    auto& receipt = *result.folders.AppendElement();
    receipt.folder = std::move(*member);
    receipt.uidValidity = original.uidValidity;
    receipt.serverUids = original.serverUids.Clone();
    for (const auto& pair : receipt.folder.keys) {
      NS_ENSURE_FALSE(globalKeys.Contains(pair.destination),
                      NS_ERROR_FILE_CORRUPTED);
      globalKeys.InsertOrUpdate(pair.destination, true);
    }
    mozStorageStatementScoper scope(stmt);
    MOZ_TRY(stmt->BindUTF8StringByName("token"_ns, input.token));
    MOZ_TRY(stmt->BindInt64ByName("member"_ns, i));
    bool more;
    while (true) {
      MOZ_TRY(stmt->ExecuteStep(&more));
      if (!more) break;
      int64_t values[4];
      for (uint32_t column = 0; column < 4; ++column) {
        int32_t type;
        MOZ_TRY(stmt->GetTypeOfIndex(column, &type));
        NS_ENSURE_TRUE(type == mozIStorageStatement::VALUE_TYPE_INTEGER,
                       NS_ERROR_FILE_CORRUPTED);
        MOZ_TRY(stmt->GetInt64(column, &values[column]));
      }
      NS_ENSURE_TRUE(values[0] >= 0 && values[0] < nsMsgKey_None &&
                         values[1] > 0 && values[1] < nsMsgKey_None &&
                         values[2] > 0 && values[2] <= 9007199254740991LL &&
                         values[3] > 0 && values[3] <= 9007199254740991LL,
                     NS_ERROR_FILE_CORRUPTED);
      bool captured = false;
      for (const auto& op : original.operations) {
        captured |= op.sourceKey == values[0];
      }
      NS_ENSURE_TRUE(captured && !operationIds.Contains(values[2]),
                     NS_ERROR_FILE_CORRUPTED);
      operationIds.InsertOrUpdate(values[2], true);
      bool mapped = false;
      for (const auto& pair : receipt.folder.keys) {
        if (pair.source == values[0]) {
          NS_ENSURE_TRUE(pair.destination == values[1],
                         NS_ERROR_FILE_CORRUPTED);
          mapped = true;
        }
      }
      if (!mapped) {
        NS_ENSURE_FALSE(globalKeys.Contains(values[1]),
                        NS_ERROR_FILE_CORRUPTED);
        globalKeys.InsertOrUpdate(values[1], true);
      }
      receipt.operations.AppendElement(
          ImapImportOperationReceipt{nsMsgKey(values[0]), nsMsgKey(values[1]),
                                     uint64_t(values[2]), uint64_t(values[3])});
    }
    NS_ENSURE_TRUE(receipt.operations.Length() == original.operations.Length(),
                   NS_ERROR_FILE_CORRUPTED);
  }
  output = Some(std::move(result));
  return NS_OK;
}

nsresult DatabaseCore::ImportImapUnit(
    const ImapImportUnit& input, ImapImportReceipt& output,
    const std::function<nsresult(const ImapImportReceipt&)>& prepare,
    const std::function<void()>& publish) {
  NS_ENSURE_TRUE(sInstance.get() == this && sConnection && mMessageDatabase,
                 NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(!input.token.IsEmpty() && input.token.FindChar(0) < 0 &&
                     !input.folders.IsEmpty(),
                 NS_ERROR_INVALID_ARG);
  bool active;
  MOZ_TRY(sConnection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  nsCString current;
  MOZ_TRY(GetSourceId(current));
  NS_ENSURE_TRUE(current == input.databaseSourceId, NS_ERROR_NOT_AVAILABLE);
  struct Prepared {
    FolderImportAdmission admission;
    nsCString marker;
    nsTHashMap<nsMsgKey, nsMsgKey> keys;
    nsTArray<ImapImportBodyAdmission> bodies;
  };
  nsTArray<UniquePtr<Prepared>> members;
  nsTHashMap<nsCString, uint32_t> tokens;
  nsTHashMap<uint64_t, bool> folders;
  for (uint32_t i = 0; i < input.folders.Length(); ++i) {
    const auto& member = input.folders[i];
    const auto& snapshot = member.snapshot;
    const auto& identity = snapshot.identity;
    NS_ENSURE_TRUE(
        snapshot.recordsComplete && snapshot.unhandledRecords.IsEmpty() &&
            identity.databaseSourceId == current && !identity.token.IsEmpty() &&
            identity.token != input.token && !tokens.Contains(identity.token) &&
            !folders.Contains(identity.folderId),
        NS_ERROR_INVALID_ARG);
    tokens.InsertOrUpdate(identity.token, i);
    folders.InsertOrUpdate(identity.folderId, true);
    MOZ_TRY(CheckFolderImportIdentity(identity));
    nsTHashMap<nsMsgKey, bool> uidKeys;
    nsTHashMap<uint32_t, bool> uids;
    for (const auto& uid : member.serverUids) {
      NS_ENSURE_TRUE(member.uidValidity && *member.uidValidity && uid.uid &&
                         uid.sourceKey != nsMsgKey_None &&
                         !uidKeys.Contains(uid.sourceKey) &&
                         !uids.Contains(uid.uid),
                     NS_ERROR_NOT_AVAILABLE);
      uidKeys.InsertOrUpdate(uid.sourceKey, true);
      uids.InsertOrUpdate(uid.uid, true);
    }
    nsCOMPtr<nsIFile> file;
    MOZ_TRY(NS_NewLocalFile(identity.sourcePath, getter_AddRefs(file)));
    auto prepared = MakeUnique<Prepared>();
    MOZ_TRY(prepared->admission.Acquire(identity, file));
    MOZ_TRY(HashImportSource(prepared->admission.Summary(), identity,
                             snapshot.sourceSize, &prepared->marker));
    MOZ_TRY(CheckImapImportBodies(member));
    if (!member.bodies.IsEmpty()) {
      MOZ_TRY(mMessageDatabase->CheckFolderBodyAccess(identity.folderId));
      for (const auto& body : member.bodies) {
        MOZ_TRY(AdmitImapImportBody(member, body,
                                    *prepared->bodies.AppendElement()));
      }
    }
    members.AppendElement(std::move(prepared));
  }
  nsCString proof = ImapImportProvenance(input);
  Maybe<ImapImportReceipt> previous;
  MOZ_TRY(ReadImapImportReceipt(input, proof, previous));
  if (previous) {
    if (prepare) MOZ_TRY(prepare(*previous));
    output = std::move(*previous);
    if (publish) publish();
    return NS_OK;
  }
  RefPtr<DatabaseCore> self(this);
  RefPtr<MessageDatabase> messages = mMessageDatabase;
  nsTArray<UniquePtr<MessageDatabase::CachedMsg>> cached;
  nsTArray<RefPtr<Message>> live;
  ImapImportReceipt result;
  result.token = input.token;
  result.databaseSourceId = current;
  MOZ_TRY(sConnection->BeginTransaction());
  nsresult rv = [&]() -> nsresult {
    nsMsgKey next;
    MOZ_TRY(GetNextMessageKey(next));
    auto allocate = [&](nsMsgKey& key) -> nsresult {
      NS_ENSURE_TRUE(next && next < nsMsgKey_None, NS_ERROR_ILLEGAL_VALUE);
      key = next++;
      return NS_OK;
    };
    for (uint32_t i = 0; i < input.folders.Length(); ++i) {
      const auto& member = input.folders[i];
      const auto& snapshot = member.snapshot;
      const auto& identity = snapshot.identity;
      Maybe<FolderImportReceipt> old;
      MOZ_TRY(ReadFolderImportReceipt(identity, old));
      NS_ENSURE_FALSE(old, NS_ERROR_ALREADY_INITIALIZED);
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(GetStatement(
          "EmptyImapImportFolder"_ns,
          "SELECT 1 FROM messages WHERE folderId=:folder UNION ALL "
          "SELECT 1 FROM staged_messages WHERE folderId=:folder UNION ALL "
          "SELECT 1 FROM offline_operations WHERE folderId=:folder LIMIT 1"_ns,
          getter_AddRefs(stmt)));
      {
        mozStorageStatementScoper scope(stmt);
        MOZ_TRY(stmt->BindInt64ByName("folder"_ns, identity.folderId));
        bool occupied;
        MOZ_TRY(stmt->ExecuteStep(&occupied));
        NS_ENSURE_FALSE(occupied, NS_ERROR_ALREADY_INITIALIZED);
      }
      uint32_t epoch;
      nsresult epochRv =
          FolderDB().GetFolderUidValidity(identity.folderId, epoch);
      NS_ENSURE_TRUE(epochRv == NS_ERROR_NOT_AVAILABLE ||
                         (NS_SUCCEEDED(epochRv) && member.uidValidity &&
                          epoch == *member.uidValidity),
                     NS_FAILED(epochRv) ? epochRv : NS_ERROR_NOT_AVAILABLE);
      auto& receipt = *result.folders.AppendElement();
      receipt.folder.identity = identity;
      receipt.uidValidity = member.uidValidity;
      receipt.serverUids = member.serverUids.Clone();
      for (const auto& row : snapshot.messages) {
        NS_ENSURE_TRUE(row.sourceKey != nsMsgKey_None &&
                           row.header.key == nsMsgKey_None &&
                           !members[i]->keys.Contains(row.sourceKey),
                       NS_ERROR_INVALID_ARG);
        nsMsgKey key;
        MOZ_TRY(allocate(key));
        members[i]->keys.InsertOrUpdate(row.sourceKey, key);
        receipt.folder.keys.AppendElement(FolderImportKey{row.sourceKey, key});
      }
    }
    // Operation-only reservations follow all message keys, so message insertion
    // keeps the existing monotonic physical allocator trigger unchanged.
    for (uint32_t i = 0; i < input.folders.Length(); ++i) {
      nsTHashMap<nsMsgKey, bool> operations;
      for (const auto& op : input.folders[i].operations) {
        NS_ENSURE_TRUE(
            op.sourceKey != nsMsgKey_None &&
                !operations.Contains(op.sourceKey) && !op.payload.playingBack &&
                op.copies.Length() == op.payload.copyDestinations.Length(),
            NS_ERROR_INVALID_ARG);
        operations.InsertOrUpdate(op.sourceKey, true);
        if (!members[i]->keys.Contains(op.sourceKey)) {
          nsMsgKey key;
          MOZ_TRY(allocate(key));
          members[i]->keys.InsertOrUpdate(op.sourceKey, key);
        }
      }
    }
    for (uint32_t i = 0; i < input.folders.Length(); ++i) {
      const auto& member = input.folders[i];
      const auto& snapshot = member.snapshot;
      auto& map = members[i]->keys;
      for (const auto& row : snapshot.messages) {
        nsMsgKey key, root, parent = 0;
        NS_ENSURE_TRUE(map.Get(row.sourceKey, &key) &&
                           map.Get(row.rootSourceKey, &root) &&
                           (!row.parentSourceKey ||
                            map.Get(*row.parentSourceKey, &parent)),
                       NS_ERROR_INVALID_ARG);
        MOZ_TRY(WriteImportedMessage(snapshot.identity.folderId, key, root,
                                     parent, row.header));
        live.AppendElement(new Message(key));
      }
      for (const auto& property : snapshot.folderProperties) {
        NS_ENSURE_TRUE(property.name != "morkMigrationSource"_ns,
                       NS_ERROR_INVALID_ARG);
        if (property.integer) {
          MOZ_TRY(FolderDB().SetFolderProperty(
              snapshot.identity.folderId, property.name, *property.integer));
        } else {
          MOZ_TRY(FolderDB().SetFolderProperty(snapshot.identity.folderId,
                                               property.name, property.text));
        }
      }
      uint32_t epoch;
      nsresult epochRv =
          FolderDB().GetFolderUidValidity(snapshot.identity.folderId, epoch);
      NS_ENSURE_TRUE(member.uidValidity
                         ? NS_SUCCEEDED(epochRv) && epoch == *member.uidValidity
                         : epochRv == NS_ERROR_NOT_AVAILABLE,
                     NS_ERROR_INVALID_ARG);
      nsTHashMap<nsMsgKey, bool> bound;
      for (const auto& uid : member.serverUids) {
        NS_ENSURE_TRUE(member.uidValidity && *member.uidValidity && uid.uid &&
                           !bound.Contains(uid.sourceKey),
                       NS_ERROR_INVALID_ARG);
        bound.InsertOrUpdate(uid.sourceKey, true);
        nsMsgKey key;
        NS_ENSURE_TRUE(map.Get(uid.sourceKey, &key), NS_ERROR_INVALID_ARG);
        bool liveHeader = false;
        for (const auto& row : snapshot.messages)
          liveHeader |= row.sourceKey == uid.sourceKey;
        if (liveHeader) {
          MOZ_TRY(messages->BindMessageToServerUidInTransaction(
              key, snapshot.identity.folderId, *member.uidValidity, uid.uid,
              false));
        }
      }
      MOZ_TRY(FolderDB().SetFolderProperty(snapshot.identity.folderId,
                                           "morkMigrationSource"_ns,
                                           members[i]->marker));
    }
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(GetStatement(
          "ReserveImapImportKeys"_ns,
          "UPDATE message_key_allocator SET highWater=:key WHERE singleton=1 AND highWater<=:key"_ns,
          getter_AddRefs(stmt)));
      MOZ_TRY(stmt->BindInt64ByName("key"_ns, uint64_t(next) - 1));
      MOZ_TRY(stmt->Execute());
    }
    auto resolve = [&](const ImapImportReference& ref, PendingDestination& dest,
                       uint32_t& index) -> nsresult {
      NS_ENSURE_TRUE(tokens.Get(ref.token, &index), NS_ERROR_NOT_AVAILABLE);
      const auto& target = input.folders[index];
      nsMsgKey key;
      NS_ENSURE_TRUE(members[index]->keys.Get(ref.sourceKey, &key),
                     NS_ERROR_NOT_AVAILABLE);
      dest = target.uidValidity
                 ? PendingDestination{target.snapshot.identity.folderId, key,
                                      *target.uidValidity}
                 : PendingDestination::Unobserved(
                       target.snapshot.identity.folderId, key);
      return NS_OK;
    };
    for (uint32_t i = 0; i < input.folders.Length(); ++i) {
      const auto& member = input.folders[i];
      for (const auto& original : member.operations) {
        const auto& raw = original.payload;
        OfflineOperationData op{raw.operation,
                                raw.flagOperation,
                                raw.newFlags,
                                raw.sourceKey,
                                raw.sourceUid,
                                raw.messageSize,
                                raw.playingBack,
                                raw.sourceFolderURI,
                                raw.destinationFolderURI,
                                raw.keywordsToAdd,
                                raw.keywordsToRemove,
                                raw.copyDestinations.Clone(),
                                raw.pendingDestination,
                                raw.copyDestinationBindings.Clone(),
                                raw.flagMutation,
                                raw.moveSourceGuard,
                                raw.invalidateFlagMutation};
        nsMsgKey key;
        NS_ENSURE_TRUE(members[i]->keys.Get(original.sourceKey, &key),
                       NS_ERROR_INVALID_ARG);
        Maybe<ServerMessageLocation> source;
        if (original.source) {
          PendingDestination physical;
          uint32_t index;
          MOZ_TRY(resolve(*original.source, physical, index));
          const auto& from = input.folders[index];
          if (!op.sourceFolderURI.IsEmpty()) {
            NS_ENSURE_TRUE(op.sourceFolderURI == from.uri &&
                               op.sourceKey == original.source->sourceKey,
                           NS_ERROR_NOT_AVAILABLE);
            op.sourceKey = physical.key;
          } else {
            NS_ENSURE_TRUE(
                index == i && original.source->sourceKey == original.sourceKey,
                NS_ERROR_NOT_AVAILABLE);
          }
          uint32_t uid = op.sourceUid;
          for (const auto& binding : from.serverUids) {
            if (binding.sourceKey == original.source->sourceKey) {
              NS_ENSURE_TRUE(!uid || uid == binding.uid,
                             NS_ERROR_NOT_AVAILABLE);
              uid = binding.uid;
            }
          }
          NS_ENSURE_TRUE(from.uidValidity && *from.uidValidity && uid,
                         NS_ERROR_NOT_AVAILABLE);
          if (index == i) {
            NS_ENSURE_TRUE(physical.key == key, NS_ERROR_NOT_AVAILABLE);
            source = Some(ServerMessageLocation{physical.folderId, key,
                                                *from.uidValidity, uid});
          }
        } else {
          NS_ENSURE_TRUE(op.sourceFolderURI.IsEmpty(), NS_ERROR_NOT_AVAILABLE);
          for (const auto& uid : member.serverUids) {
            if (uid.sourceKey == original.sourceKey) {
              NS_ENSURE_TRUE(member.uidValidity && *member.uidValidity &&
                                 (!op.sourceUid || op.sourceUid == uid.uid),
                             NS_ERROR_NOT_AVAILABLE);
              source = Some(
                  ServerMessageLocation{member.snapshot.identity.folderId, key,
                                        *member.uidValidity, uid.uid});
            }
          }
        }
        if (original.destination) {
          PendingDestination dest;
          uint32_t index;
          MOZ_TRY(resolve(*original.destination, dest, index));
          NS_ENSURE_TRUE(op.destinationFolderURI == input.folders[index].uri,
                         NS_ERROR_NOT_AVAILABLE);
          if (op.operation & (nsIMsgOfflineImapOperation::kMsgMoved |
                              nsIMsgOfflineImapOperation::kAppendDraft |
                              nsIMsgOfflineImapOperation::kAppendTemplate)) {
            op.pendingDestination = Some(dest);
          } else {
            NS_ENSURE_TRUE(
                (op.operation & nsIMsgOfflineImapOperation::kMoveResult) &&
                    index == i && dest.key == key && original.source,
                NS_ERROR_NOT_AVAILABLE);
          }
        } else {
          NS_ENSURE_TRUE(op.destinationFolderURI.IsEmpty(),
                         NS_ERROR_NOT_AVAILABLE);
        }
        op.copyDestinationBindings.Clear();
        for (size_t n = 0; n < original.copies.Length(); ++n) {
          NS_ENSURE_TRUE(original.copies[n], NS_ERROR_NOT_AVAILABLE);
          PendingDestination dest;
          uint32_t index;
          MOZ_TRY(resolve(*original.copies[n], dest, index));
          NS_ENSURE_TRUE(op.copyDestinations[n] == input.folders[index].uri,
                         NS_ERROR_NOT_AVAILABLE);
          op.copyDestinationBindings.AppendElement(Some(dest));
        }
        uint64_t id, revision;
        MOZ_TRY(messages->ImportOfflineOperationInTransaction(
            member.snapshot.identity.folderId, key, op, source, id, revision));
        NS_ENSURE_TRUE(
            id <= 9007199254740991ULL && revision <= 9007199254740991ULL,
            NS_ERROR_ILLEGAL_VALUE);
        result.folders[i].operations.AppendElement(
            ImapImportOperationReceipt{original.sourceKey, key, id, revision});
      }
    }
    // Reuse the unchanged platform member receipt representation. The new unit
    // proof and operation map are separate, so old v1/v2 receipt bytes survive.
    for (uint32_t i = 0; i < input.folders.Length(); ++i) {
      const auto& snapshot = input.folders[i].snapshot;
      const auto& id = snapshot.identity;
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(GetStatement(
          "WriteImapMemberReceipt"_ns,
          "INSERT INTO folder_import_receipts(token,sourceId,databaseSourceId,"
          "sourceSha256,folderId,folderPath,sourcePath,messageCount) VALUES("
          ":token,:source,:database,:hash,:folder,:path,:sourcePath,:count)"_ns,
          getter_AddRefs(stmt)));
      {
        mozStorageStatementScoper scope(stmt);
        MOZ_TRY(stmt->BindUTF8StringByName("token"_ns, id.token));
        MOZ_TRY(stmt->BindUTF8StringByName("source"_ns, id.sourceId));
        MOZ_TRY(stmt->BindUTF8StringByName("database"_ns, id.databaseSourceId));
        MOZ_TRY(stmt->BindUTF8StringByName("hash"_ns, id.sourceSha256));
        MOZ_TRY(stmt->BindInt64ByName("folder"_ns, id.folderId));
        MOZ_TRY(stmt->BindUTF8StringByName("path"_ns, id.folderPath));
        MOZ_TRY(stmt->BindStringByName("sourcePath"_ns, id.sourcePath));
        MOZ_TRY(stmt->BindInt64ByName("count"_ns, snapshot.messages.Length()));
        MOZ_TRY(stmt->Execute());
      }
      MOZ_TRY(GetStatement(
          "WriteImapMemberKey"_ns,
          "INSERT INTO folder_import_keys(token,sourceKey,destinationKey) "
          "VALUES(:token,:source,:destination)"_ns,
          getter_AddRefs(stmt)));
      for (const auto& pair : result.folders[i].folder.keys) {
        mozStorageStatementScoper scope(stmt);
        MOZ_TRY(stmt->BindUTF8StringByName("token"_ns, id.token));
        MOZ_TRY(stmt->BindInt64ByName("source"_ns, pair.source));
        MOZ_TRY(stmt->BindInt64ByName("destination"_ns, pair.destination));
        MOZ_TRY(stmt->Execute());
      }
      MOZ_TRY(WriteWindowsImportReceipt(sConnection, id));
      MOZ_TRY(GetStatement(
          "WriteImapOperationReceipt"_ns,
          "INSERT INTO imap_import_operations(unitToken,member,sourceKey,"
          "messageKey,operationId,revision) VALUES(:token,:member,:source,:key,:id,:revision)"_ns,
          getter_AddRefs(stmt)));
      for (const auto& op : result.folders[i].operations) {
        mozStorageStatementScoper scope(stmt);
        MOZ_TRY(stmt->BindUTF8StringByName("token"_ns, input.token));
        MOZ_TRY(stmt->BindInt64ByName("member"_ns, i));
        MOZ_TRY(stmt->BindInt64ByName("source"_ns, op.sourceKey));
        MOZ_TRY(stmt->BindInt64ByName("key"_ns, op.key));
        MOZ_TRY(stmt->BindInt64ByName("id"_ns, op.id));
        MOZ_TRY(stmt->BindInt64ByName("revision"_ns, op.revision));
        MOZ_TRY(stmt->Execute());
      }
      std::sort(
          result.folders[i].folder.keys.begin(),
          result.folders[i].folder.keys.end(),
          [](const auto& a, const auto& b) { return a.source < b.source; });
      std::sort(result.folders[i].operations.begin(),
                result.folders[i].operations.end(),
                [](const auto& a, const auto& b) {
                  return a.sourceKey < b.sourceKey;
                });
      MOZ_TRY(HashImportSource(members[i]->admission.Summary(), id,
                               snapshot.sourceSize));
      MOZ_TRY(members[i]->admission.Validate());
      const auto& member = input.folders[i];
      NS_ENSURE_TRUE(member.bodies.Length() == members[i]->bodies.Length(),
                     NS_ERROR_NOT_AVAILABLE);
      if (!member.bodies.IsEmpty()) {
        // Only this owning native transaction uses the precommitted admission.
        // Ordinary body access retains its committed-read requirement.
        MOZ_TRY(messages->CheckPendingFolderRelocation(id.folderId));
        for (uint32_t j = 0; j < member.bodies.Length(); ++j) {
          MOZ_TRY(RecheckImapImportBody(member, member.bodies[j],
                                        members[i]->bodies[j]));
        }
      }
    }
    {
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(GetStatement(
          "WriteImapImportUnit"_ns,
          "INSERT INTO imap_import_units(token,databaseSourceId,provenance) "
          "VALUES(:token,:database,:proof)"_ns,
          getter_AddRefs(stmt)));
      MOZ_TRY(stmt->BindUTF8StringByName("token"_ns, input.token));
      MOZ_TRY(stmt->BindUTF8StringByName("database"_ns, current));
      MOZ_TRY(stmt->BindUTF8StringByName("proof"_ns, proof));
      MOZ_TRY(stmt->Execute());
    }
    // Validate the persisted unit before preparing caller output or committing.
    // Structurally valid but altered child mappings must not become visible.
    Maybe<ImapImportReceipt> stored;
    MOZ_TRY(ReadImapImportReceipt(input, proof, stored));
    NS_ENSURE_TRUE(stored && SameImapImportReceipt(result, *stored),
                   NS_ERROR_FILE_CORRUPTED);
    for (const auto& message : live) {
      auto value = MakeUnique<MessageDatabase::CachedMsg>();
      MOZ_TRY(messages->FetchMsg(message->Key(), *value));
      cached.AppendElement(std::move(value));
    }
    NS_ENSURE_TRUE(messages->mMsgCache.reserve(messages->mMsgCache.count() +
                                               cached.Length()),
                   NS_ERROR_OUT_OF_MEMORY);
    if (prepare) MOZ_TRY(prepare(result));
    return sConnection->CommitTransaction();
  }();
  if (NS_FAILED(rv)) {
    bool open;
    nsresult cleanup = sConnection->GetTransactionInProgress(&open);
    if (NS_SUCCEEDED(cleanup) && open)
      cleanup = sConnection->RollbackTransaction();
    NS_WARNING_ASSERTION(NS_SUCCEEDED(cleanup),
                         "Connected import rollback failed");
    return rv;
  }
  for (auto& value : cached) {
    nsMsgKey key = value->key;
    auto entry = messages->mMsgCache.lookup(key);
    if (entry)
      entry->value() = std::move(*value);
    else
      messages->mMsgCache.putNewInfallible(key, std::move(*value));
  }
  output = std::move(result);
  if (publish) publish();
  for (const auto& message : live) messages->NotifyImportedMessage(message);
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

NS_IMETHODIMP
DatabaseCore::MigrateVirtualFolders() {
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
                                nsTArray<FolderImportProperty>& output,
                                bool imap = false) {
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
    NS_ENSURE_TRUE(value.name != "morkMigrationSource"_ns &&
                       value.name != "panoramaCacheImportOrigin"_ns,
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
        // IMAP may clear its pending-work marker without changing saved state.
        // Preserve the raw property; every other flag must still match.
        uint32_t allowed = imap ? nsMsgFolderFlags::OfflineEvents : 0;
        NS_ENSURE_TRUE(((uint32_t(expected) ^ flags) & ~allowed) == 0,
                       NS_ERROR_NOT_IMPLEMENTED);
      } else if (value.name == "numMsgs"_ns || value.name == "numNewMsgs"_ns) {
        NS_ENSURE_TRUE(
            expected == (value.name == "numMsgs"_ns ? total : unread),
            NS_ERROR_INVALID_ARG);
      } else if (value.name == "version"_ns) {
        NS_ENSURE_TRUE(expected == 1, NS_ERROR_NOT_IMPLEMENTED);
      } else if (value.name == "totPendingMsgs"_ns ||
                 value.name == "unreadPendingMsgs"_ns ||
                 value.name == "forceReparse"_ns) {
        NS_ENSURE_TRUE(
            (imap && value.name != "forceReparse"_ns) || expected == 0,
            NS_ERROR_NOT_IMPLEMENTED);
      }
    }
    output.AppendElement(std::move(value));
  }
  return NS_OK;
}

// This checks the typed projection against the complete saved MDB rows. Neither
// a caller's expected ledger nor URI/key equality confers server identity.
nsresult CheckImapImportRecords(JSContext* cx, JS::Handle<JSObject*> request,
                                nsTArray<UniquePtr<ImportSourceRecord>>& rows,
                                ImportSourceRecord* table,
                                const ImportSourceRecord& info,
                                ImapImportFolder& input) {
  JS::Rooted<JS::Value> field(cx);
  MOZ_TRY(ImportMember(cx, request, "imap", &field));
  NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
  JS::Rooted<JSObject*> object(cx, &field.toObject());
  int64_t number;
  MOZ_TRY(ImportMember(cx, object, "version", &field));
  MOZ_TRY(ImportNumber(field, 1, 1, number));
  MOZ_TRY(ImportMember(cx, object, "originalFolderURI", &field));
  MOZ_TRY(ImportText(cx, field, input.uri));
  NS_ENSURE_TRUE(!input.uri.IsEmpty() && input.uri.FindChar(0) < 0,
                 NS_ERROR_INVALID_ARG);
  nsCString originalURI;
  if (!info.cells.Get("originalFolderURI"_ns, &originalURI)) {
    MOZ_TRY(input.folder->GetURI(originalURI));
  }
  NS_ENSURE_TRUE(input.uri == originalURI, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(ImportMember(cx, object, "uidValidity", &field));
  NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
  JS::Rooted<JSObject*> epoch(cx, &field.toObject());
  MOZ_TRY(ImportMember(cx, epoch, "present", &field));
  NS_ENSURE_TRUE(field.isBoolean() &&
                     field.toBoolean() == info.cells.Contains("UIDValidity"_ns),
                 NS_ERROR_INVALID_ARG);
  bool present = field.toBoolean();
  MOZ_TRY(ImportMember(cx, epoch, "value", &field, true));
  NS_ENSURE_TRUE(present == !field.isUndefined(), NS_ERROR_INVALID_ARG);
  if (present) {
    MOZ_TRY(ImportNumber(field, 0, UINT32_MAX, number));
    uint32_t expected;
    MOZ_TRY(ImportCellNumber(info, "UIDValidity"_ns, expected));
    NS_ENSURE_TRUE(number == expected, NS_ERROR_INVALID_ARG);
    input.uidValidity = Some(expected);
  }
  MOZ_TRY(ImportMember(cx, object, "operations", &field));
  JS::Rooted<JSObject*> array(cx);
  uint32_t count;
  MOZ_TRY(ImportArray(cx, field, &array, count));
  NS_ENSURE_TRUE(count == (table ? table->members.Length() : 0),
                 NS_ERROR_INVALID_ARG);
  nsTHashMap<nsMsgKey, bool> seen;
  for (uint32_t i = 0; i < count; ++i) {
    NS_ENSURE_TRUE(JS_GetElement(cx, array, i, &field), NS_ERROR_FAILURE);
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
    JS::Rooted<JSObject*> entry(cx, &field.toObject());
    ImapImportOperation operation;
    MOZ_TRY(ImportMember(cx, entry, "sourceKey", &field));
    MOZ_TRY(ImportNumber(field, 0, nsMsgKey_None - 1, number));
    operation.sourceKey = number;
    MOZ_TRY(ImportMember(cx, entry, "rowId", &field));
    MOZ_TRY(ImportNumber(field, 0, nsMsgKey_None - 1, number));
    NS_ENSURE_TRUE(
        number == operation.sourceKey && !seen.Contains(operation.sourceKey),
        NS_ERROR_INVALID_ARG);
    seen.InsertOrUpdate(operation.sourceKey, true);
    nsCString scope;
    MOZ_TRY(ImportMember(cx, entry, "scope", &field));
    MOZ_TRY(ImportText(cx, field, scope));
    NS_ENSURE_TRUE(scope == "ns:msg:db:row:scope:ops:all"_ns,
                   NS_ERROR_NOT_IMPLEMENTED);
    ImportSourceRecord* row = nullptr;
    for (auto& candidate : rows) {
      if (candidate->id == operation.sourceKey && candidate->scope == scope) {
        row = candidate.get();
      }
    }
    NS_ENSURE_TRUE(
        row && !row->accounted && table &&
            table->memberSet.Contains(ImportSourceKey(row->id, scope)),
        NS_ERROR_INVALID_ARG);
    for (auto cell = row->cells.ConstIter(); !cell.Done(); cell.Next()) {
      bool known = false;
      for (const char* name :
           {"op", "msgKey", "opFlags", "newFlags", "srcMsgKey", "srcUid",
            "srcFolderURI", "moveDest", "msgSize", "inPlayback",
            "addedKeywords", "removedKeywords", "numCopyDests", "copyDests"}) {
        known |= cell.Key().Equals(name);
      }
      NS_ENSURE_TRUE(known, NS_ERROR_NOT_IMPLEMENTED);
    }
    uint32_t key;
    NS_ENSURE_TRUE(
        row->cells.Contains("msgKey"_ns) && row->cells.Contains("op"_ns),
        NS_ERROR_INVALID_ARG);
    MOZ_TRY(ImportCellNumber(*row, "msgKey"_ns, key));
    NS_ENSURE_TRUE(key == operation.sourceKey, NS_ERROR_INVALID_ARG);
    MOZ_TRY(ImportMember(cx, entry, "payload", &field));
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
    JS::Rooted<JSObject*> payload(cx, &field.toObject());
    auto numeric = [&](const char* name, const char* column, uint32_t& output,
                       uint32_t fallback = 0) -> nsresult {
      MOZ_TRY(ImportMember(cx, payload, name, &field, true));
      bool stored = row->cells.Contains(nsDependentCString(column));
      NS_ENSURE_TRUE(stored == !field.isUndefined(), NS_ERROR_INVALID_ARG);
      output = fallback;
      if (stored) {
        MOZ_TRY(ImportNumber(field, 0, UINT32_MAX, number));
        MOZ_TRY(ImportCellNumber(*row, nsDependentCString(column), output));
        NS_ENSURE_TRUE(number == output, NS_ERROR_INVALID_ARG);
      }
      return NS_OK;
    };
    auto text = [&](const char* name, const char* column,
                    nsCString& output) -> nsresult {
      MOZ_TRY(ImportMember(cx, payload, name, &field, true));
      nsCString raw;
      bool stored = row->cells.Get(nsDependentCString(column), &raw);
      NS_ENSURE_TRUE(stored == !field.isUndefined(), NS_ERROR_INVALID_ARG);
      if (stored) {
        MOZ_TRY(ImportText(cx, field, output));
        NS_ENSURE_TRUE(output == raw && output.FindChar(0) < 0,
                       NS_ERROR_INVALID_ARG);
      }
      return NS_OK;
    };
    const char* optionalColumns[] = {
        "opFlags",         "newFlags",     "srcMsgKey", "srcUid",
        "msgSize",         "srcFolderURI", "moveDest",  "addedKeywords",
        "removedKeywords", "inPlayback",   "copyDests", "numCopyDests"};
    for (uint32_t bit = 0; bit < 12; ++bit) {
      if (row->cells.Contains(nsDependentCString(optionalColumns[bit])))
        operation.payloadPresence |= 1u << bit;
    }
    auto& op = operation.payload;
    MOZ_TRY(numeric("operation", "op", op.operation));
    NS_ENSURE_TRUE(op.operation && !(op.operation & ~0xfffu),
                   NS_ERROR_NOT_IMPLEMENTED);
    MOZ_TRY(numeric("flagOperation", "opFlags", op.flagOperation));
    MOZ_TRY(numeric("newFlags", "newFlags", op.newFlags));
    MOZ_TRY(
        numeric("sourceMessageKey", "srcMsgKey", op.sourceKey, nsMsgKey_None));
    MOZ_TRY(numeric("sourceUid", "srcUid", op.sourceUid));
    MOZ_TRY(numeric("messageSize", "msgSize", op.messageSize));
    MOZ_TRY(text("sourceFolderURI", "srcFolderURI", op.sourceFolderURI));
    MOZ_TRY(text("destinationFolderURI", "moveDest", op.destinationFolderURI));
    MOZ_TRY(text("keywordsToAdd", "addedKeywords", op.keywordsToAdd));
    MOZ_TRY(text("keywordsToRemove", "removedKeywords", op.keywordsToRemove));
    MOZ_TRY(ImportMember(cx, payload, "playingBack", &field, true));
    NS_ENSURE_TRUE(row->cells.Contains("inPlayback"_ns) == !field.isUndefined(),
                   NS_ERROR_INVALID_ARG);
    if (!field.isUndefined()) {
      uint32_t playing;
      MOZ_TRY(ImportCellNumber(*row, "inPlayback"_ns, playing));
      NS_ENSURE_TRUE(playing <= 1 && field.isBoolean() &&
                         field.toBoolean() == bool(playing),
                     NS_ERROR_INVALID_ARG);
      NS_ENSURE_FALSE(playing, NS_ERROR_NOT_AVAILABLE);
    }
    MOZ_TRY(ImportMember(cx, payload, "copyDestinations", &field, true));
    nsCString rawCopies;
    bool copiesPresent = row->cells.Get("copyDests"_ns, &rawCopies);
    NS_ENSURE_TRUE(copiesPresent == !field.isUndefined(), NS_ERROR_INVALID_ARG);
    if (copiesPresent) {
      JS::Rooted<JSObject*> copies(cx);
      uint32_t length;
      MOZ_TRY(ImportArray(cx, field, &copies, length));
      uint32_t offset = 0;
      for (uint32_t n = 0; n < length; ++n) {
        NS_ENSURE_TRUE(JS_GetElement(cx, copies, n, &field), NS_ERROR_FAILURE);
        nsCString uri;
        MOZ_TRY(ImportText(cx, field, uri));
        int32_t end = rawCopies.FindChar('\1', offset);
        uint32_t stop = end < 0 ? rawCopies.Length() : uint32_t(end);
        NS_ENSURE_TRUE(!uri.IsEmpty() && uri.FindChar(0) < 0 &&
                           uri == Substring(rawCopies, offset, stop - offset),
                       NS_ERROR_INVALID_ARG);
        NS_ENSURE_TRUE((n + 1 == length) == (end < 0), NS_ERROR_INVALID_ARG);
        offset = stop + (end >= 0);
        op.copyDestinations.AppendElement(std::move(uri));
      }
      NS_ENSURE_TRUE(length || rawCopies.IsEmpty(), NS_ERROR_INVALID_ARG);
    }
    uint32_t copyCount;
    MOZ_TRY(numeric("copyDestinationCount", "numCopyDests", copyCount,
                    op.copyDestinations.Length()));
    NS_ENSURE_TRUE(copyCount == op.copyDestinations.Length(),
                   NS_ERROR_INVALID_ARG);
    NS_ENSURE_TRUE(bool(op.operation & nsIMsgOfflineImapOperation::kMsgCopy) ==
                       !op.copyDestinations.IsEmpty(),
                   NS_ERROR_NOT_AVAILABLE);
    row->accounted = true;
    input.operations.AppendElement(std::move(operation));
  }
  MOZ_TRY(ImportMember(cx, object, "serverUids", &field));
  MOZ_TRY(ImportArray(cx, field, &array, count));
  seen.Clear();
  nsTHashMap<uint32_t, bool> uids;
  for (uint32_t i = 0; i < count; ++i) {
    NS_ENSURE_TRUE(JS_GetElement(cx, array, i, &field), NS_ERROR_FAILURE);
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
    JS::Rooted<JSObject*> binding(cx, &field.toObject());
    ImapImportUid uid;
    MOZ_TRY(ImportMember(cx, binding, "sourceKey", &field));
    MOZ_TRY(ImportNumber(field, 0, nsMsgKey_None - 1, number));
    uid.sourceKey = number;
    MOZ_TRY(ImportMember(cx, binding, "uid", &field));
    MOZ_TRY(ImportNumber(field, 1, UINT32_MAX, number));
    uid.uid = number;
    NS_ENSURE_TRUE(input.uidValidity && *input.uidValidity &&
                       !seen.Contains(uid.sourceKey) && !uids.Contains(uid.uid),
                   NS_ERROR_NOT_AVAILABLE);
    seen.InsertOrUpdate(uid.sourceKey, true);
    uids.InsertOrUpdate(uid.uid, true);
    input.serverUids.AppendElement(uid);
  }
  for (const auto& message : input.snapshot.messages) {
    ImportSourceRecord* row = nullptr;
    for (auto& candidate : rows) {
      if (candidate->id == message.sourceKey &&
          candidate->scope == "ns:msg:db:row:scope:msgs:all"_ns)
        row = candidate.get();
    }
    NS_ENSURE_TRUE(row, NS_ERROR_INVALID_ARG);
    uint32_t pseudo;
    MOZ_TRY(ImportCellNumber(*row, "pseudoHdr"_ns, pseudo));
    uint32_t word = 0;
    for (const auto& op : input.operations) {
      if (op.sourceKey == message.sourceKey) word = op.payload.operation;
    }
    bool pending = word & (nsIMsgOfflineImapOperation::kMoveResult |
                           nsIMsgOfflineImapOperation::kAppendDraft |
                           nsIMsgOfflineImapOperation::kAppendTemplate |
                           nsIMsgOfflineImapOperation::kAddedHeader);
    Maybe<uint32_t> expected;
    if (row->cells.Contains("uidOnServer"_ns)) {
      uint32_t uid;
      MOZ_TRY(ImportCellNumber(*row, "uidOnServer"_ns, uid));
      NS_ENSURE_TRUE(uid && !pseudo && !pending, NS_ERROR_NOT_AVAILABLE);
      expected = Some(uid);
    } else if (!pseudo && !pending) {
      NS_ENSURE_TRUE(message.sourceKey, NS_ERROR_NOT_AVAILABLE);
      expected = Some(uint32_t(message.sourceKey));
    } else {
      NS_ENSURE_TRUE(word && message.header.storeToken &&
                         !message.header.storeToken->IsEmpty() &&
                         (message.header.flags & nsMsgMessageFlags::Offline),
                     NS_ERROR_NOT_AVAILABLE);
    }
    Maybe<uint32_t> projected;
    for (const auto& uid : input.serverUids) {
      if (uid.sourceKey == message.sourceKey) projected = Some(uid.uid);
    }
    NS_ENSURE_TRUE(expected == projected, NS_ERROR_NOT_AVAILABLE);
  }
  return NS_OK;
}

nsresult CheckFullImportRecords(JSContext* cx, JS::Handle<JSObject*> request,
                                nsIMsgFolder* folder,
                                FolderImportSnapshot& input,
                                ImapImportFolder* imap = nullptr) {
  nsCString protocol;
  uint32_t folderFlags;
  MOZ_TRY(folder->GetIncomingServerType(protocol));
  MOZ_TRY(folder->GetFlags(&folderFlags));
  NS_ENSURE_TRUE(protocol == (imap ? "imap"_ns : "none"_ns),
                 NS_ERROR_NOT_IMPLEMENTED);
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
                     *allThreads = nullptr, *offlineTable = nullptr,
                     *pendingTable = nullptr;
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
    } else if (imap && table.scope == "ns:msg:db:row:scope:ops:all"_ns &&
               kind == "ns:msg:db:table:kind:ops"_ns && !offlineTable &&
               table.meta.IsEmpty()) {
      offlineTable = &table;
    } else if (imap && table.scope == "ns:msg:db:row:scope:pending:all"_ns &&
               table.id == 1 && kind == "ns:msg:db:table:kind:pending"_ns &&
               !pendingTable && table.meta.IsEmpty() &&
               table.members.IsEmpty()) {
      pendingTable = &table;
    } else {
      return NS_ERROR_NOT_IMPLEMENTED;
    }
  }
  // Native empty local folders have no per-thread table. Only the exact
  // empty message/allthreads shape with a lone folder-info row can omit it;
  // every record, info cell and live count is still checked below.
  NS_ENSURE_TRUE(
      messageTable && infoTable && allThreads &&
          (imap || !threadTables.IsEmpty() ||
           (input.messages.IsEmpty() && messageTable->members.IsEmpty() &&
            allThreads->members.IsEmpty() && rows.Length() == 1)),
      NS_ERROR_NOT_IMPLEMENTED);
  NS_ENSURE_TRUE(messageTable->members.Length() == input.messages.Length() &&
                     infoTable->members.Length() == 1,
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
    NS_ENSURE_TRUE(meta && !meta->accounted && meta->scope == "m"_ns,
                   NS_ERROR_NOT_IMPLEMENTED);
    // The legacy unread cache defaults to zero when absent. Only IMAP admits
    // that exact representation, and the computed live unread count must agree.
    bool absentUnread = imap && !meta->cells.Contains("unreadChildren"_ns);
    // nsMsgThread defaults an absent newest-date cache to zero and computes
    // the live maximum on read. Preserve absence just like an explicit zero;
    // no original row/cell is rewritten or newly marked as accounted here.
    bool absentNewest = !meta->cells.Contains("threadNewestMsgDate"_ns);
    NS_ENSURE_TRUE(meta->cells.Count() ==
                       6u - uint32_t(absentUnread) - uint32_t(absentNewest),
                   NS_ERROR_NOT_IMPLEMENTED);
    uint32_t values[6] = {};
    const char* names[] = {"threadRoot",     "threadId",
                           "threadFlags",    "children",
                           "unreadChildren", "threadNewestMsgDate"};
    for (uint32_t i = 0; i < 6; ++i) {
      nsDependentCString name(names[i]);
      if ((i == 4 && absentUnread) || (i == 5 && absentNewest)) continue;
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
  nsTHashMap<uint32_t, bool> retiredThreads;
  constexpr uint32_t retiring = nsIMsgOfflineImapOperation::kMsgMoved |
                                nsIMsgOfflineImapOperation::kDeletedMsg |
                                nsIMsgOfflineImapOperation::kMsgMarkedDeleted;
  for (auto entry = threadTables.ConstIter(); !entry.Done(); entry.Next()) {
    const auto& table = *tables[entry.Data()];
    if (table.members.IsEmpty()) {
      auto operationKey =
          ImportSourceKey(table.id, "ns:msg:db:row:scope:ops:all"_ns);
      auto* operation = find(operationKey);
      NS_ENSURE_TRUE(imap && !messages.Contains(table.id) && offlineTable &&
                         offlineTable->memberSet.Contains(operationKey) &&
                         operation,
                     NS_ERROR_NOT_IMPLEMENTED);
      uint32_t word, key, root;
      MOZ_TRY(ImportCellNumber(*operation, "op"_ns, word));
      MOZ_TRY(ImportCellNumber(*operation, "msgKey"_ns, key));
      NS_ENSURE_TRUE((word & retiring) && key == table.id,
                     NS_ERROR_NOT_IMPLEMENTED);
      MOZ_TRY(checkMeta(find(table.meta), table.id, 0, 0, 0, root));
      NS_ENSURE_TRUE(
          root == table.id && !allThreads->memberSet.Contains(
                                  ImportSourceKey(table.id, threadScope)),
          NS_ERROR_NOT_IMPLEMENTED);
      retiredThreads.InsertOrUpdate(table.id, true);
      continue;
    }
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
  NS_ENSURE_TRUE(assigned.Count() == input.messages.Length() &&
                     allThreads->members.Length() ==
                         threadTables.Count() - retiredThreads.Count(),
                 NS_ERROR_INVALID_ARG);
  auto* info = find(infoTable->members[0]);
  NS_ENSURE_TRUE(info && info->id == 1 && info->scope == infoScope,
                 NS_ERROR_NOT_IMPLEMENTED);
  MOZ_TRY(ImportFolderProperties(cx, request, *info, folderFlags,
                                 input.messages.Length(), unread,
                                 input.folderProperties, bool(imap)));
  info->accounted = true;
  if (imap) {
    MOZ_TRY(
        CheckImapImportRecords(cx, request, rows, offlineTable, *info, *imap));
  }
  // CheckImapImportRecords above independently validates the entire raw op
  // payload and exact typed projection before inactive remnants are accounted.
  for (const auto& row : rows) {
    if (imap && !row->accounted && retiredThreads.Contains(row->id)) {
      if (row->scope == threadScope && row->cells.Count() == 1 &&
          row->cells.Contains("threadSubject"_ns)) {
        row->accounted = true;
      } else if (row->scope == messageScope && row->cells.IsEmpty() &&
                 !messageTable->memberSet.Contains(
                     ImportSourceKey(row->id, messageScope))) {
        row->accounted = true;
      }
    }
    if (!row->accounted) {
      uint32_t root;
      MOZ_TRY(checkMeta(row.get(), row->id, 0, 0, 0, root));
      NS_ENSURE_TRUE(root == row->id, NS_ERROR_NOT_IMPLEMENTED);
    }
  }
  return NS_OK;
}

}  // namespace

nsresult DatabaseCore::CheckImportRecordsForTesting(
    JSContext* cx, JS::Handle<JSObject*> request, nsIMsgFolder* folder,
    FolderImportSnapshot& input, ImapImportFolder* imap) {
  return CheckFullImportRecords(cx, request, folder, input, imap);
}

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
                        nsIMsgFolder* folder, FolderImportSnapshot& input,
                        ImapImportFolder* imap = nullptr) {
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
  full = full || input.sourceSize != 0 || imap;
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
    MOZ_TRY(CheckFullImportRecords(cx, request, folder, input, imap));
  } else {
    MOZ_TRY(CheckProjectedImportRecords(cx, request, input));
  }
  input.recordsComplete = true;
  return NS_OK;
}

nsresult ImportImapReference(JSContext* cx, JS::Handle<JSObject*> object,
                             const char* name, const ImapImportUnit& unit,
                             Maybe<ImapImportReference>& output,
                             Maybe<uint32_t> ordinal = Nothing()) {
  JS::Rooted<JS::Value> field(cx);
  MOZ_TRY(ImportMember(cx, object, name, &field, true));
  if (field.isUndefined()) return NS_OK;
  NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
  JS::Rooted<JSObject*> reference(cx, &field.toObject());
  nsCString source;
  MOZ_TRY(ImportMember(cx, reference, "sourceId", &field));
  MOZ_TRY(ImportText(cx, field, source));
  int64_t key;
  MOZ_TRY(ImportMember(cx, reference, "key", &field));
  MOZ_TRY(ImportNumber(field, 0, nsMsgKey_None - 1, key));
  if (ordinal) {
    int64_t number;
    MOZ_TRY(ImportMember(cx, reference, "ordinal", &field));
    MOZ_TRY(ImportNumber(field, *ordinal, *ordinal, number));
  }
  for (const auto& member : unit.folders) {
    if (member.snapshot.identity.sourceId == source) {
      bool exists = false;
      for (const auto& row : member.snapshot.messages)
        exists |= row.sourceKey == key;
      for (const auto& op : member.operations) exists |= op.sourceKey == key;
      NS_ENSURE_TRUE(exists, NS_ERROR_NOT_AVAILABLE);
      output = Some(
          ImapImportReference{member.snapshot.identity.token, nsMsgKey(key)});
      return NS_OK;
    }
  }
  return NS_ERROR_NOT_AVAILABLE;
}

bool SameImapReference(const Maybe<ImapImportReference>& left,
                       const Maybe<ImapImportReference>& right) {
  return bool(left) == bool(right) &&
         (!left ||
          (left->token == right->token && left->sourceKey == right->sourceKey));
}

nsresult ImportImapUnitRequest(
    DatabaseCore* core, nsIMsgFolder* anchor, JSContext* cx,
    JS::Handle<JSObject*> request, ImapImportUnit& unit,
    nsTArray<UniquePtr<FolderImportAdmission>>& admissions) {
  NS_ENSURE_ARG_POINTER(anchor);
  JS::Rooted<JS::Value> field(cx);
  nsCString protocol;
  MOZ_TRY(ImportMember(cx, request, "protocol", &field));
  MOZ_TRY(ImportText(cx, field, protocol));
  NS_ENSURE_TRUE(protocol == "imap"_ns, NS_ERROR_NOT_IMPLEMENTED);
  for (auto pair : {std::pair{"token", &unit.token},
                    {"databaseSourceId", &unit.databaseSourceId}}) {
    MOZ_TRY(ImportMember(cx, request, pair.first, &field));
    MOZ_TRY(ImportText(cx, field, *pair.second));
    NS_ENSURE_TRUE(!pair.second->IsEmpty() && pair.second->FindChar(0) < 0,
                   NS_ERROR_INVALID_ARG);
  }
  nsCString current;
  MOZ_TRY(core->GetSourceId(current));
  NS_ENSURE_TRUE(current == unit.databaseSourceId, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(ImportMember(cx, request, "folders", &field));
  JS::Rooted<JSObject*> folders(cx);
  uint32_t count;
  MOZ_TRY(ImportArray(cx, field, &folders, count));
  NS_ENSURE_TRUE(count, NS_ERROR_INVALID_ARG);
  nsTHashMap<nsCString, bool> sourceIds, uris;
  uint64_t anchorId;
  MOZ_TRY(anchor->GetId(&anchorId));
  for (uint32_t i = 0; i < count; ++i) {
    NS_ENSURE_TRUE(JS_GetElement(cx, folders, i, &field), NS_ERROR_FAILURE);
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
    JS::Rooted<JSObject*> requestMember(cx, &field.toObject());
    MOZ_TRY(ImportMember(cx, requestMember, "folder", &field));
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
    JS::Rooted<JSObject*> binding(cx, &field.toObject());
    int64_t id;
    MOZ_TRY(ImportMember(cx, binding, "id", &field));
    MOZ_TRY(ImportNumber(field, 1, 9007199254740991., id));
    NS_ENSURE_TRUE(i || uint64_t(id) == anchorId, NS_ERROR_NOT_AVAILABLE);
    auto& member = *unit.folders.AppendElement();
    MOZ_TRY(core->FolderDB().GetMsgFolderForFolder(
        id, getter_AddRefs(member.folder)));
    NS_ENSURE_TRUE(member.folder, NS_ERROR_NOT_AVAILABLE);
    auto admission = MakeUnique<FolderImportAdmission>();
    MOZ_TRY(ImportIdentity(core, member.folder, cx, requestMember,
                           member.snapshot.identity, *admission));
#ifndef XP_WIN
    nsCOMPtr<nsIFile> summary;
    MOZ_TRY(NS_NewLocalFile(member.snapshot.identity.sourcePath,
                            getter_AddRefs(summary)));
    MOZ_TRY(admission->Acquire(member.snapshot.identity, summary));
#endif
    NS_ENSURE_TRUE(
        member.snapshot.identity.databaseSourceId == unit.databaseSourceId,
        NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(ImportMessages(cx, requestMember, member.folder, member.snapshot,
                           &member));
    NS_ENSURE_FALSE(sourceIds.Contains(member.snapshot.identity.sourceId) ||
                        uris.Contains(member.uri),
                    NS_ERROR_INVALID_ARG);
    sourceIds.InsertOrUpdate(member.snapshot.identity.sourceId, true);
    uris.InsertOrUpdate(member.uri, true);
    // The digest is measured from the real provider stream, never supplied by
    // the semantic test ledger or inferred from the header's message size.
    for (const auto& row : member.snapshot.messages) {
      bool token = row.header.storeToken && !row.header.storeToken->IsEmpty();
      NS_ENSURE_TRUE(!(row.header.flags & nsMsgMessageFlags::Offline) || token,
                     NS_ERROR_NOT_AVAILABLE);
      if (token) {
        ImapImportBody body;
        body.sourceKey = row.sourceKey;
        MOZ_TRY(MeasureImapImportBody(member, row.header, body));
        member.bodies.AppendElement(std::move(body));
      }
    }
    admissions.AppendElement(std::move(admission));
  }
  auto memberFor = [&](const nsACString& uri) -> ImapImportFolder* {
    for (auto& member : unit.folders)
      if (member.uri == uri) return &member;
    return nullptr;
  };
  auto ref = [](const ImapImportFolder& member, nsMsgKey key) {
    return Some(ImapImportReference{member.snapshot.identity.token, key});
  };
  auto counterpart = [&](const ImapImportFolder& origin, nsMsgKey key,
                         const nsACString& uri,
                         Maybe<ImapImportReference>& output) -> nsresult {
    auto* target = memberFor(uri);
    NS_ENSURE_TRUE(target, NS_ERROR_NOT_AVAILABLE);
    for (const auto& candidate : target->operations) {
      if (candidate.payload.sourceFolderURI == origin.uri &&
          candidate.payload.sourceKey == key) {
        NS_ENSURE_FALSE(output, NS_ERROR_NOT_AVAILABLE);
        NS_ENSURE_TRUE(candidate.payload.operation &
                           nsIMsgOfflineImapOperation::kMoveResult,
                       NS_ERROR_NOT_AVAILABLE);
        output = ref(*target, candidate.sourceKey);
      }
    }
    return output ? NS_OK : NS_ERROR_NOT_AVAILABLE;
  };
  for (uint32_t i = 0; i < count; ++i) {
    auto& member = unit.folders[i];
    NS_ENSURE_TRUE(JS_GetElement(cx, folders, i, &field), NS_ERROR_FAILURE);
    JS::Rooted<JSObject*> requestMember(cx, &field.toObject());
    MOZ_TRY(ImportMember(cx, requestMember, "imap", &field));
    JS::Rooted<JSObject*> imap(cx, &field.toObject());
    MOZ_TRY(ImportMember(cx, imap, "operations", &field));
    JS::Rooted<JSObject*> operations(cx, &field.toObject());
    for (uint32_t n = 0; n < member.operations.Length(); ++n) {
      auto& op = member.operations[n];
      const auto& payload = op.payload;
      NS_ENSURE_TRUE(JS_GetElement(cx, operations, n, &field),
                     NS_ERROR_FAILURE);
      JS::Rooted<JSObject*> entry(cx, &field.toObject());
      MOZ_TRY(ImportImapReference(cx, entry, "source", unit, op.source));
      MOZ_TRY(
          ImportImapReference(cx, entry, "destination", unit, op.destination));
      Maybe<ImapImportReference> expected;
      if (!payload.sourceFolderURI.IsEmpty()) {
        auto* origin = memberFor(payload.sourceFolderURI);
        NS_ENSURE_TRUE(origin && payload.sourceKey != nsMsgKey_None,
                       NS_ERROR_NOT_AVAILABLE);
        expected = ref(*origin, payload.sourceKey);
      }
      NS_ENSURE_TRUE(SameImapReference(expected, op.source),
                     NS_ERROR_NOT_AVAILABLE);
      expected.reset();
      if (!payload.destinationFolderURI.IsEmpty()) {
        if (payload.operation & (nsIMsgOfflineImapOperation::kAppendDraft |
                                 nsIMsgOfflineImapOperation::kAppendTemplate |
                                 nsIMsgOfflineImapOperation::kMoveResult)) {
          NS_ENSURE_TRUE(payload.destinationFolderURI == member.uri,
                         NS_ERROR_NOT_AVAILABLE);
          expected = ref(member, op.sourceKey);
        } else if (payload.operation & nsIMsgOfflineImapOperation::kMsgMoved) {
          MOZ_TRY(counterpart(member, op.sourceKey,
                              payload.destinationFolderURI, expected));
        } else {
          return NS_ERROR_NOT_AVAILABLE;
        }
      }
      NS_ENSURE_TRUE(SameImapReference(expected, op.destination),
                     NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(ImportMember(cx, entry, "copies", &field, true));
      JS::Rooted<JSObject*> copies(cx);
      uint32_t length = 0;
      if (!field.isUndefined())
        MOZ_TRY(ImportArray(cx, field, &copies, length));
      NS_ENSURE_TRUE(length == payload.copyDestinations.Length(),
                     NS_ERROR_INVALID_ARG);
      nsTHashMap<nsCString, bool> distinct;
      for (uint32_t c = 0; c < length; ++c) {
        NS_ENSURE_FALSE(distinct.Contains(payload.copyDestinations[c]),
                        NS_ERROR_NOT_AVAILABLE);
        distinct.InsertOrUpdate(payload.copyDestinations[c], true);
        NS_ENSURE_TRUE(JS_GetElement(cx, copies, c, &field), NS_ERROR_FAILURE);
        NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
        JS::Rooted<JSObject*> copy(cx, JS_NewPlainObject(cx));
        NS_ENSURE_TRUE(
            copy && JS_DefineProperty(cx, copy, "ref", field, JSPROP_ENUMERATE),
            NS_ERROR_OUT_OF_MEMORY);
        Maybe<ImapImportReference> actual;
        MOZ_TRY(ImportImapReference(cx, copy, "ref", unit, actual, Some(c)));
        expected.reset();
        MOZ_TRY(counterpart(member, op.sourceKey, payload.copyDestinations[c],
                            expected));
        NS_ENSURE_TRUE(SameImapReference(expected, actual),
                       NS_ERROR_NOT_AVAILABLE);
        op.copies.AppendElement(std::move(actual));
      }
    }
  }
  constexpr uint32_t serverActions =
      nsIMsgOfflineImapOperation::kFlagsChanged |
      nsIMsgOfflineImapOperation::kMsgMoved |
      nsIMsgOfflineImapOperation::kMsgCopy |
      nsIMsgOfflineImapOperation::kDeletedMsg |
      nsIMsgOfflineImapOperation::kMsgMarkedDeleted |
      nsIMsgOfflineImapOperation::kAddKeywords |
      nsIMsgOfflineImapOperation::kRemoveKeywords;
  for (const auto& member : unit.folders) {
    for (const auto& uid : member.serverUids) {
      bool live = false, evidence = false;
      for (const auto& row : member.snapshot.messages)
        live |= row.sourceKey == uid.sourceKey;
      if (live)
        continue;  // Independently checked against the saved header above.
      bool operationKey = false;
      for (const auto& op : member.operations) {
        operationKey |= op.sourceKey == uid.sourceKey;
        if (op.sourceKey == uid.sourceKey &&
            op.payload.sourceFolderURI.IsEmpty()) {
          evidence |= op.payload.sourceUid == uid.uid;
        }
      }
      for (const auto& other : unit.folders) {
        for (const auto& op : other.operations) {
          if (op.payload.sourceFolderURI == member.uri &&
              op.payload.sourceKey == uid.sourceKey) {
            NS_ENSURE_TRUE(
                !op.payload.sourceUid || op.payload.sourceUid == uid.uid,
                NS_ERROR_NOT_AVAILABLE);
            evidence |= op.payload.sourceUid == uid.uid;
          }
        }
      }
      NS_ENSURE_TRUE(operationKey && evidence, NS_ERROR_NOT_AVAILABLE);
    }
    for (const auto& op : member.operations) {
      if (!(op.payload.operation & serverActions)) continue;
      bool bound = false;
      for (const auto& uid : member.serverUids)
        bound |= uid.sourceKey == op.sourceKey;
      NS_ENSURE_TRUE(bound, NS_ERROR_NOT_AVAILABLE);
    }
  }
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

bool ImapImportText(JSContext* cx, JS::Handle<JSObject*> object,
                    const char* name, const nsACString& text) {
  JS::Rooted<JSString*> string(
      cx, JS_NewStringCopyUTF8N(
              cx, JS::UTF8Chars(text.BeginReading(), text.Length())));
  return string &&
         JS_DefineProperty(cx, object, name, string, JSPROP_ENUMERATE);
}

bool ImapPayloadValue(JSContext* cx, const ImapImportOperation& input,
                      JS::MutableHandle<JSObject*> output) {
  JS::Rooted<JSObject*> object(cx, JS_NewPlainObject(cx));
  if (!object ||
      !JS_DefineProperty(cx, object, "operation",
                         double(input.payload.operation), JSPROP_ENUMERATE))
    return false;
  const auto& op = input.payload;
  const char* numbers[] = {"flagOperation", "newFlags", "sourceMessageKey",
                           "sourceUid", "messageSize"};
  uint32_t values[] = {op.flagOperation, op.newFlags, op.sourceKey,
                       op.sourceUid, op.messageSize};
  for (uint32_t i = 0; i < 5; ++i) {
    if ((input.payloadPresence & (1u << i)) &&
        !JS_DefineProperty(cx, object, numbers[i], double(values[i]),
                           JSPROP_ENUMERATE))
      return false;
  }
  const char* names[] = {"sourceFolderURI", "destinationFolderURI",
                         "keywordsToAdd", "keywordsToRemove"};
  const nsCString* texts[] = {&op.sourceFolderURI, &op.destinationFolderURI,
                              &op.keywordsToAdd, &op.keywordsToRemove};
  for (uint32_t i = 0; i < 4; ++i) {
    if ((input.payloadPresence & (1u << (i + 5))) &&
        !ImapImportText(cx, object, names[i], *texts[i]))
      return false;
  }
  JS::Rooted<JS::Value> playing(cx, JS::BooleanValue(op.playingBack));
  if ((input.payloadPresence & (1u << 9)) &&
      !JS_DefineProperty(cx, object, "playingBack", playing, JSPROP_ENUMERATE))
    return false;
  if (input.payloadPresence & (1u << 10)) {
    JS::Rooted<JSObject*> copies(
        cx, JS::NewArrayObject(cx, op.copyDestinations.Length()));
    if (!copies) return false;
    for (uint32_t i = 0; i < op.copyDestinations.Length(); ++i) {
      JS::Rooted<JSString*> text(
          cx, JS_NewStringCopyUTF8N(
                  cx, JS::UTF8Chars(op.copyDestinations[i].get(),
                                    op.copyDestinations[i].Length())));
      if (!text || !JS_DefineElement(cx, copies, i, text, JSPROP_ENUMERATE))
        return false;
    }
    if (!JS_DefineProperty(cx, object, "copyDestinations", copies,
                           JSPROP_ENUMERATE))
      return false;
  }
  if ((input.payloadPresence & (1u << 11)) &&
      !JS_DefineProperty(cx, object, "copyDestinationCount",
                         double(op.copyDestinations.Length()),
                         JSPROP_ENUMERATE))
    return false;
  output.set(object);
  return true;
}

bool ImapImportReceiptValue(JSContext* cx, const ImapImportUnit& input,
                            const ImapImportReceipt& receipt,
                            JS::MutableHandle<JS::Value> output) {
  JS::Rooted<JSObject*> object(cx, JS_NewPlainObject(cx));
  JS::Rooted<JSObject*> folders(
      cx, JS::NewArrayObject(cx, receipt.folders.Length()));
  if (!object || !folders ||
      receipt.folders.Length() != input.folders.Length() ||
      !JS_DefineProperty(cx, object, "version", double(3), JSPROP_ENUMERATE) ||
      !ImapImportText(cx, object, "token", receipt.token) ||
      !ImapImportText(cx, object, "databaseSourceId",
                      receipt.databaseSourceId) ||
      !ImapImportText(cx, object, "protocol", "imap"_ns))
    return false;
  auto mappedKey = [&](uint32_t member, nsMsgKey original) -> nsMsgKey {
    for (const auto& pair : receipt.folders[member].folder.keys) {
      if (pair.source == original) return pair.destination;
    }
    for (const auto& op : receipt.folders[member].operations) {
      if (op.sourceKey == original) return op.key;
    }
    return nsMsgKey_None;
  };
  auto reference = [&](const ImapImportReference& ref, Maybe<uint32_t> ordinal,
                       JS::MutableHandle<JSObject*> target) -> bool {
    for (uint32_t i = 0; i < input.folders.Length(); ++i) {
      const auto& id = input.folders[i].snapshot.identity;
      if (id.token != ref.token) continue;
      nsMsgKey key = mappedKey(i, ref.sourceKey);
      if (key == nsMsgKey_None) return false;
      JS::Rooted<JSObject*> result(cx, JS_NewPlainObject(cx));
      if (!result || !ImapImportText(cx, result, "sourceId", id.sourceId) ||
          !JS_DefineProperty(cx, result, "key", double(key),
                             JSPROP_ENUMERATE) ||
          (ordinal && !JS_DefineProperty(cx, result, "ordinal",
                                         double(*ordinal), JSPROP_ENUMERATE)))
        return false;
      target.set(result);
      return true;
    }
    return false;
  };
  for (uint32_t i = 0; i < receipt.folders.Length(); ++i) {
    const auto& member = receipt.folders[i];
    const auto& original = input.folders[i];
    JS::Rooted<JS::Value> value(cx);
    if (!ImportReceiptValue(cx, member.folder, &value)) return false;
    JS::Rooted<JSObject*> folder(cx, &value.toObject());
    JS::Rooted<JSObject*> imap(cx, JS_NewPlainObject(cx)),
        epoch(cx, JS_NewPlainObject(cx));
    JS::Rooted<JSObject*> uids(
        cx, JS::NewArrayObject(cx, member.serverUids.Length()));
    JS::Rooted<JSObject*> operations(
        cx, JS::NewArrayObject(cx, original.operations.Length()));
    JS::Rooted<JSObject*> keys(cx, JS::NewArrayObject(cx, 0));
    JS::Rooted<JS::Value> epochPresent(
        cx, JS::BooleanValue(member.uidValidity.isSome()));
    if (!imap || !epoch || !uids || !operations || !keys ||
        !JS_DefineProperty(cx, imap, "version", double(1), JSPROP_ENUMERATE) ||
        !ImapImportText(cx, imap, "originalFolderURI", original.uri) ||
        !JS_DefineProperty(cx, epoch, "present", epochPresent,
                           JSPROP_ENUMERATE) ||
        (member.uidValidity &&
         !JS_DefineProperty(cx, epoch, "value", double(*member.uidValidity),
                            JSPROP_ENUMERATE)) ||
        !JS_DefineProperty(cx, imap, "uidValidity", epoch, JSPROP_ENUMERATE))
      return false;
    for (uint32_t n = 0; n < member.serverUids.Length(); ++n) {
      const auto& uid = member.serverUids[n];
      nsMsgKey key = mappedKey(i, uid.sourceKey);
      JS::Rooted<JSObject*> binding(cx, JS_NewPlainObject(cx));
      if (key == nsMsgKey_None || !binding ||
          !JS_DefineProperty(cx, binding, "sourceKey", double(uid.sourceKey),
                             JSPROP_ENUMERATE) ||
          !JS_DefineProperty(cx, binding, "key", double(key),
                             JSPROP_ENUMERATE) ||
          !JS_DefineProperty(cx, binding, "uid", double(uid.uid),
                             JSPROP_ENUMERATE) ||
          !JS_DefineElement(cx, uids, n, binding, JSPROP_ENUMERATE))
        return false;
    }
    uint32_t missing = 0;
    for (const auto& op : member.operations) {
      bool live = false;
      for (const auto& pair : member.folder.keys)
        live |= pair.source == op.sourceKey;
      if (live) continue;
      JS::Rooted<JSObject*> pair(cx, JS::NewArrayObject(cx, 2));
      if (!pair ||
          !JS_DefineElement(cx, pair, 0, double(op.sourceKey),
                            JSPROP_ENUMERATE) ||
          !JS_DefineElement(cx, pair, 1, double(op.key), JSPROP_ENUMERATE) ||
          !JS_DefineElement(cx, keys, missing++, pair, JSPROP_ENUMERATE))
        return false;
    }
    for (uint32_t n = 0; n < original.operations.Length(); ++n) {
      const auto& operation = original.operations[n];
      const ImapImportOperationReceipt* saved = nullptr;
      for (const auto& candidate : member.operations) {
        if (candidate.sourceKey == operation.sourceKey) saved = &candidate;
      }
      JS::Rooted<JSObject*> result(cx, JS_NewPlainObject(cx)), payload(cx);
      if (!saved || !result || !ImapPayloadValue(cx, operation, &payload) ||
          !JS_DefineProperty(cx, result, "sourceKey", double(saved->sourceKey),
                             JSPROP_ENUMERATE) ||
          !JS_DefineProperty(cx, result, "key", double(saved->key),
                             JSPROP_ENUMERATE) ||
          !JS_DefineProperty(cx, result, "id", double(saved->id),
                             JSPROP_ENUMERATE) ||
          !JS_DefineProperty(cx, result, "revision", double(saved->revision),
                             JSPROP_ENUMERATE) ||
          !JS_DefineProperty(cx, result, "payload", payload, JSPROP_ENUMERATE))
        return false;
      for (const auto& pair : {std::pair{"source", &operation.source},
                               {"destination", &operation.destination}}) {
        if (!*pair.second) continue;
        JS::Rooted<JSObject*> ref(cx);
        if (!reference(**pair.second, Nothing(), &ref) ||
            !JS_DefineProperty(cx, result, pair.first, ref, JSPROP_ENUMERATE))
          return false;
      }
      if (!operation.copies.IsEmpty()) {
        JS::Rooted<JSObject*> copies(
            cx, JS::NewArrayObject(cx, operation.copies.Length()));
        if (!copies) return false;
        for (uint32_t c = 0; c < operation.copies.Length(); ++c) {
          JS::Rooted<JSObject*> ref(cx);
          if (!operation.copies[c] ||
              !reference(*operation.copies[c], Some(c), &ref) ||
              !JS_DefineElement(cx, copies, c, ref, JSPROP_ENUMERATE))
            return false;
        }
        if (!JS_DefineProperty(cx, result, "copies", copies, JSPROP_ENUMERATE))
          return false;
      }
      if (!JS_DefineElement(cx, operations, n, result, JSPROP_ENUMERATE))
        return false;
    }
    if (!JS_DefineProperty(cx, imap, "serverUids", uids, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, imap, "operationKeys", keys, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, imap, "operations", operations,
                           JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, folder, "imap", imap, JSPROP_ENUMERATE) ||
        !JS_DefineElement(cx, folders, i, folder, JSPROP_ENUMERATE))
      return false;
  }
  if (!JS_DefineProperty(cx, object, "folders", folders, JSPROP_ENUMERATE))
    return false;
  output.setObject(*object);
  return true;
}

}  // namespace

NS_IMETHODIMP
DatabaseCore::ImportFolderSnapshot(nsIMsgFolder* source,
                                   JS::Handle<JS::Value> request, JSContext* cx,
                                   Promise** output) {
  NS_ENSURE_TRUE(request.isObject(), NS_ERROR_INVALID_ARG);
  JS::Rooted<JSObject*> object(cx, &request.toObject());
  JS::Rooted<JS::Value> version(cx);
  MOZ_TRY(ImportMember(cx, object, "version", &version));
  if (version.isNumber() && version.toNumber() == 3) {
    ImapImportUnit input;
    nsTArray<UniquePtr<FolderImportAdmission>> admissions;
    MOZ_TRY(ImportImapUnitRequest(this, source, cx, object, input, admissions));
    ErrorResult error;
    RefPtr<Promise> promise =
        Promise::Create(xpc::CurrentNativeGlobal(cx), error);
    if (error.Failed()) return error.StealNSResult();
    JS::Rooted<JS::Value> result(cx);
    ImapImportReceipt receipt;
    bool published = false;
    nsresult rv = ImportImapUnit(
        input, receipt,
        [&](const ImapImportReceipt& prepared) -> nsresult {
          return ImapImportReceiptValue(cx, input, prepared, &result)
                     ? NS_OK
                     : NS_ERROR_OUT_OF_MEMORY;
        },
        [&] {
          promise->MaybeResolve(result);
          RefPtr<Promise> returned = promise;
          returned.forget(output);
          published = true;
        });
    if (NS_FAILED(rv)) {
      promise->MaybeReject(rv);
      promise.forget(output);
    } else {
      MOZ_ASSERT(published);
    }
    return NS_OK;
  }
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

NS_IMETHODIMP
DatabaseCore::GetFolderImportReceipt(nsIMsgFolder* source,
                                     JS::Handle<JS::Value> request,
                                     JSContext* cx,
                                     JS::MutableHandle<JS::Value> output) {
  NS_ENSURE_TRUE(request.isObject(), NS_ERROR_INVALID_ARG);
  JS::Rooted<JSObject*> object(cx, &request.toObject());
  JS::Rooted<JS::Value> version(cx);
  MOZ_TRY(ImportMember(cx, object, "version", &version));
  if (version.isNumber() && version.toNumber() == 3) {
    ImapImportUnit input;
    nsTArray<UniquePtr<FolderImportAdmission>> admissions;
    MOZ_TRY(ImportImapUnitRequest(this, source, cx, object, input, admissions));
    for (uint32_t i = 0; i < input.folders.Length(); ++i) {
      const auto& member = input.folders[i];
      MOZ_TRY(HashImportSource(admissions[i]->Summary(),
                               member.snapshot.identity,
                               member.snapshot.sourceSize));
      MOZ_TRY(admissions[i]->Validate());
    }
    Maybe<ImapImportReceipt> receipt;
    MOZ_TRY(ReadImapImportReceipt(input, ImapImportProvenance(input), receipt));
    if (!receipt) {
      output.setNull();
      return NS_OK;
    }
    JS::Rooted<JS::Value> result(cx);
    NS_ENSURE_TRUE(ImapImportReceiptValue(cx, input, *receipt, &result),
                   NS_ERROR_OUT_OF_MEMORY);
    output.set(result);
    return NS_OK;
  }
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
// Windows uses the same importer only inside the native selected-startup
// migration, whose operation retains the profile and database leases; source
// bytes are additionally read under a native no-reparse file lease.
struct CacheFolder {
  nsCString originalKey, descriptor, cachePath, storePath, protocol, storeType;
  uint64_t id;
  Maybe<uint32_t> sourceKey;
  bool isServer;
  nsCString originalSummaryPath;
  Maybe<uint32_t> originalFlags;
  nsTArray<FolderImportProperty> properties;
};
struct CacheImport {
  nsCString token, sourceId, databaseId, path, sha256, sourceFormat;
  uint32_t version{1};
  uint32_t size;
  nsCString profilePath, manifestPath, manifestSha256;
  uint32_t manifestSize{0};
  nsTArray<CacheFolder> folders;
};
namespace {

// Retained profile paths are joined with the platform separator (PathUtils).
#ifdef XP_WIN
constexpr auto kCacheJSONLeaf = "\\folderCache.json"_ns;
constexpr auto kCacheDatabaseLeaf = "\\panorama.sqlite"_ns;
constexpr auto kCacheSelectorLeaf = "\\panorama-profile.json"_ns;
#else
constexpr auto kCacheJSONLeaf = "/folderCache.json"_ns;
constexpr auto kCacheDatabaseLeaf = "/panorama.sqlite"_ns;
constexpr auto kCacheSelectorLeaf = "/panorama-profile.json"_ns;
#endif

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
  MOZ_TRY(ImportNumber(field, 1, 3, number));
  input.version = number;
  if (input.version == 3) {
    MOZ_TRY(ImportMember(cx, request, "sourceFormat", &field));
    MOZ_TRY(ImportText(cx, field, input.sourceFormat));
    NS_ENSURE_TRUE(input.sourceFormat == "json"_ns, NS_ERROR_INVALID_ARG);
    MOZ_TRY(ImportMember(cx, request, "policy", &field));
    nsCString policy;
    MOZ_TRY(ImportText(cx, field, policy));
    NS_ENSURE_TRUE(policy == "native-reconciled-json-v3"_ns,
                   NS_ERROR_INVALID_ARG);
  }
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
  if (input.version == 3) {
    nsCOMPtr<nsIFile> file;
    MOZ_TRY(NewComparableFile(input.path, getter_AddRefs(file)));
    nsAutoString leaf;
    MOZ_TRY(file->GetLeafName(leaf));
    NS_ENSURE_TRUE(leaf.EqualsLiteral("folderCache.json"),
                   NS_ERROR_INVALID_ARG);
  }
  if (input.version >= 2) {
    MOZ_TRY(ImportMember(cx, request, "proof", &field));
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
    object = &field.toObject();
    MOZ_TRY(ImportMember(cx, object, "profilePath", &field));
    MOZ_TRY(ImportText(cx, field, input.profilePath));
    MOZ_TRY(ImportMember(cx, object, "manifest", &field));
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_INVALID_ARG);
    object = &field.toObject();
    MOZ_TRY(ImportMember(cx, object, "path", &field));
    MOZ_TRY(ImportText(cx, field, input.manifestPath));
    MOZ_TRY(ImportMember(cx, object, "sha256", &field));
    MOZ_TRY(ImportText(cx, field, input.manifestSha256));
    NS_ENSURE_TRUE(input.manifestSha256.Length() == 64 &&
                       !input.profilePath.IsEmpty() &&
                       !input.manifestPath.IsEmpty() &&
                       input.profilePath.FindChar(0) < 0 &&
                       input.manifestPath.FindChar(0) < 0,
                   NS_ERROR_INVALID_ARG);
    for (char c : input.manifestSha256.View()) {
      NS_ENSURE_TRUE((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'),
                     NS_ERROR_INVALID_ARG);
    }
    MOZ_TRY(ImportMember(cx, object, "size", &field));
    MOZ_TRY(ImportNumber(field, 1, UINT32_MAX - 1, number));
    input.manifestSize = number;
    if (input.version == 3) {
      const nsCString expectedPath(input.profilePath + kCacheJSONLeaf);
      NS_ENSURE_TRUE(input.path == expectedPath, NS_ERROR_INVALID_ARG);
    }
  }
  MOZ_TRY(ImportMember(cx, request, "folders", &field));
  uint32_t length;
  MOZ_TRY(ImportArray(cx, field, &array, length));
  NS_ENSURE_TRUE(length || input.version == 3, NS_ERROR_INVALID_ARG);
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
    if (input.version == 3) {
      bool hasSourceKey;
      NS_ENSURE_TRUE(JS_HasOwnProperty(cx, object, "sourceKey", &hasSourceKey),
                     NS_ERROR_FAILURE);
      NS_ENSURE_FALSE(hasSourceKey, NS_ERROR_INVALID_ARG);
      nsCOMPtr<nsIFile> original;
      MOZ_TRY(NewComparableFile(folder.originalKey, getter_AddRefs(original)));
      NS_ENSURE_TRUE(folder.originalKey == folder.descriptor,
                     NS_ERROR_NOT_AVAILABLE);
    } else {
      MOZ_TRY(ImportMember(cx, object, "sourceKey", &field));
      MOZ_TRY(ImportNumber(field, 1, UINT32_MAX, number));
      folder.sourceKey = Some(uint32_t(number));
    }
    MOZ_TRY(ImportMember(cx, object, "isServer", &field));
    NS_ENSURE_TRUE(field.isBoolean(), NS_ERROR_INVALID_ARG);
    folder.isServer = field.toBoolean();
    if (input.version >= 2) {
      MOZ_TRY(ImportMember(cx, object, "originalSummaryPath", &field));
      MOZ_TRY(ImportText(cx, field, folder.originalSummaryPath));
      NS_ENSURE_TRUE(folder.originalSummaryPath.FindChar(0) < 0 &&
                         (folder.isServer
                              ? folder.originalSummaryPath.IsEmpty()
                              : folder.originalSummaryPath == folder.cachePath),
                     NS_ERROR_INVALID_ARG);
    }
    for (const auto& previous : input.folders) {
      NS_ENSURE_TRUE(
          previous.id != folder.id &&
              previous.originalKey != folder.originalKey &&
              (input.version == 3 || previous.sourceKey != folder.sourceKey) &&
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
      JS_DefineProperty(cx, result, "version", input.version,
                        JSPROP_ENUMERATE) &&
          CacheText(cx, result, "policy",
                    input.version == 1   ? "native-authoritative-v1"_ns
                    : input.version == 2 ? "native-reconciled-selected-v2"_ns
                                         : "native-reconciled-json-v3"_ns),
      NS_ERROR_OUT_OF_MEMORY);
  if (input.version == 3)
    NS_ENSURE_TRUE(CacheText(cx, result, "sourceFormat", input.sourceFormat),
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
  if (input.version >= 2) {
    JS::Rooted<JSObject*> proof(
        cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
    JS::Rooted<JSObject*> manifest(
        cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
    NS_ENSURE_TRUE(
        proof && manifest &&
            CacheText(cx, proof, "profilePath", input.profilePath) &&
            CacheText(cx, manifest, "path", input.manifestPath) &&
            CacheText(cx, manifest, "sha256", input.manifestSha256) &&
            JS_DefineProperty(cx, manifest, "size", double(input.manifestSize),
                              JSPROP_ENUMERATE) &&
            JS_DefineProperty(cx, proof, "manifest", manifest,
                              JSPROP_ENUMERATE) &&
            JS_DefineProperty(cx, result, "proof", proof, JSPROP_ENUMERATE),
        NS_ERROR_OUT_OF_MEMORY);
  }
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
    if (input.version >= 2) {
      NS_ENSURE_TRUE(CacheText(cx, object, "originalSummaryPath",
                               folder.originalSummaryPath),
                     NS_ERROR_OUT_OF_MEMORY);
    }
    JS::Rooted<JS::Value> server(cx, JS::BooleanValue(folder.isServer));
    NS_ENSURE_TRUE(
        JS_DefineProperty(cx, object, "id", double(folder.id),
                          JSPROP_ENUMERATE) &&
            (input.version == 3 ||
             JS_DefineProperty(cx, object, "sourceKey",
                               double(*folder.sourceKey), JSPROP_ENUMERATE)) &&
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
#ifdef XP_WIN
  // Hold the existing migration admission through the read: every component
  // is a plain local directory/file and writers are denied until it closes.
  nsCOMPtr<nsIFile> parent;
  MOZ_TRY(file->GetParent(getter_AddRefs(parent)));
  NS_ENSURE_TRUE(parent, NS_ERROR_FILE_INVALID_PATH);
  RefPtr<MigrationFileSystem> fileSystem = new MigrationFileSystem();
  nsCOMPtr<nsIPanoramaMigrationPath> lease;
  MOZ_TRY(fileSystem->Admit(file, parent,
                            nsIPanoramaMigrationFileSystem::KIND_FILE,
                            getter_AddRefs(lease)));
  auto closeLease = MakeScopeExit([&] { (void)lease->Close(); });
  nsAutoString admitted;
  MOZ_TRY(lease->GetCanonicalPath(admitted));
  NS_ENSURE_TRUE(admitted == path, NS_ERROR_NOT_AVAILABLE);
#endif
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
  return name.EqualsLiteral("panoramaCacheImportOrigin") ||
         name.EqualsLiteral("morkMigrationSource") ||
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

nsresult ParseCacheDocument(JSContext* cx, const nsACString& bytes, bool json,
                            JS::MutableHandle<JSObject*> output) {
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
      JS_GetProperty(cx, module,
                     json ? "parseJSONFolderCache" : "parseMorkFolderCache",
                     &function) &&
          JS::Call(cx, module, function, JS::HandleValueArray(argument),
                   &parsed),
      NS_ERROR_FAILURE);
  NS_ENSURE_TRUE(parsed.isObject(), NS_ERROR_FAILURE);
  JS::Rooted<JSObject*> object(cx, &parsed.toObject());
  if (json) {
    MOZ_TRY(ImportMember(cx, object, "format", &field));
    nsCString format;
    MOZ_TRY(ImportText(cx, field, format));
    NS_ENSURE_TRUE(format == "json"_ns, NS_ERROR_FILE_CORRUPTED);
  }
  output.set(object);
  return NS_OK;
}

nsresult ParseCacheBytes(JSContext* cx, const nsACString& bytes,
                         CacheImport& input) {
  JS::Rooted<JSObject*> object(cx), entries(cx), source(cx), rows(cx);
  MOZ_TRY(ParseCacheDocument(cx, bytes, input.version == 3, &object));
  JS::Rooted<JS::Value> field(cx);
  MOZ_TRY(ImportMember(cx, object, "entries", &field));
  NS_ENSURE_TRUE(field.isObject(), NS_ERROR_FAILURE);
  entries = &field.toObject();
  MOZ_TRY(ImportMember(cx, object, "source", &field));
  NS_ENSURE_TRUE(field.isObject(), NS_ERROR_FAILURE);
  source = &field.toObject();
  if (input.version == 3) {
    JS::Rooted<JS::IdVector> keys(cx, JS::IdVector(cx));
    NS_ENSURE_TRUE(JS_Enumerate(cx, source, &keys), NS_ERROR_FAILURE);
    NS_ENSURE_TRUE(keys.length() == input.folders.Length(),
                   NS_ERROR_NOT_IMPLEMENTED);
  } else {
    MOZ_TRY(ImportMember(cx, source, "rows", &field));
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_FAILURE);
    rows = &field.toObject();
    NS_ENSURE_TRUE(JS::MapSize(cx, rows) == input.folders.Length(),
                   NS_ERROR_NOT_IMPLEMENTED);
  }
  NS_ENSURE_TRUE(JS::MapSize(cx, entries) == input.folders.Length(),
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
    int64_t number;
    if (input.version == 3) {
      bool hasSourceKey;
      NS_ENSURE_TRUE(JS_HasOwnProperty(cx, object, "sourceKey", &hasSourceKey),
                     NS_ERROR_FAILURE);
      NS_ENSURE_FALSE(hasSourceKey || folder.sourceKey,
                      NS_ERROR_FILE_CORRUPTED);
    } else {
      MOZ_TRY(ImportMember(cx, object, "sourceKey", &field));
      MOZ_TRY(
          ImportNumber(field, *folder.sourceKey, *folder.sourceKey, number));
    }
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
      const bool jsonUserOrder =
          input.version == 3 && property.name == "userSortOrder"_ns;
      NS_ENSURE_FALSE(CacheUnsupportedAlias(property.name) && !jsonUserOrder,
                      NS_ERROR_NOT_IMPLEMENTED);
      if (input.version == 3 && property.name == "key"_ns)
        NS_ENSURE_TRUE(property.text == folder.originalKey,
                       NS_ERROR_FILE_CORRUPTED);
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
      // Only the named JSON3 producer cell can cross the generic alias guard.
      // Validate its original typed value and canonical text independently of
      // the shared parser; Mork1/2 and every other alias retain their refusal.
      if (jsonUserOrder) {
        NS_ENSURE_TRUE(property.integer && *property.integer >= 0 &&
                           uint64_t(*property.integer) <= UINT32_MAX,
                       NS_ERROR_INVALID_ARG);
        nsAutoCString canonical;
        canonical.AppendInt(uint32_t(*property.integer), 16);
        NS_ENSURE_TRUE(property.text == canonical, NS_ERROR_FILE_CORRUPTED);
      }
      folder.properties.AppendElement(std::move(property));
    }
  }
  return NS_OK;
}

// Reuse checks native retained bytes and their complete original cells. It
// never reopens obsolete source files or replays a projection into live state.
nsresult CheckStoredJSONCacheReceipt(JSContext* cx,
                                     mozIStorageConnection* connection,
                                     CacheImport& input,
                                     const nsACString& receipt) {
  NS_ENSURE_TRUE(input.version == 3, NS_ERROR_INVALID_ARG);
  nsCOMPtr<mozIStorageStatement> stored;
  MOZ_TRY(connection->CreateStatement(
      "SELECT raw FROM folder_cache_imports WHERE token=:token"_ns,
      getter_AddRefs(stored)));
  MOZ_TRY(stored->BindUTF8StringByName("token"_ns, input.token));
  bool row;
  MOZ_TRY(stored->ExecuteStep(&row));
  NS_ENSURE_TRUE(row, NS_ERROR_FILE_CORRUPTED);
  int32_t type;
  MOZ_TRY(stored->GetTypeOfIndex(0, &type));
  NS_ENSURE_TRUE(type == mozIStorageStatement::VALUE_TYPE_BLOB,
                 NS_ERROR_FILE_CORRUPTED);
  uint32_t length;
  uint8_t* raw = nullptr;
  MOZ_TRY(stored->GetBlob(0, &length, &raw));
  auto release = MakeScopeExit([&] { std::free(raw); });
  NS_ENSURE_TRUE(length == input.size && length, NS_ERROR_FILE_CORRUPTED);
  nsCString bytes(reinterpret_cast<const char*>(raw), length);
  nsCOMPtr<nsICryptoHash> hash;
  MOZ_TRY(NS_NewCryptoHash(nsICryptoHash::SHA256, getter_AddRefs(hash)));
  MOZ_TRY(hash->Update(raw, length));
  nsCString digest, actual;
  MOZ_TRY(hash->Finish(false, digest));
  for (unsigned char c : digest.View()) {
    actual.Append("0123456789abcdef"[c >> 4]);
    actual.Append("0123456789abcdef"[c & 15]);
  }
  NS_ENSURE_TRUE(actual == input.sha256, NS_ERROR_FILE_CORRUPTED);
  MOZ_TRY(stored->ExecuteStep(&row));
  NS_ENSURE_FALSE(row, NS_ERROR_FILE_CORRUPTED);
  stored = nullptr;
  for (auto& folder : input.folders) folder.properties.Clear();
  MOZ_TRY(ParseCacheBytes(cx, bytes, input));
  JS::Rooted<JS::Value> value(cx);
  MOZ_TRY(CacheParseJSON(cx, receipt, &value));
  JS::Rooted<JSObject*> result(cx, &value.toObject()), identity(cx), cells(cx);
  MOZ_TRY(ImportMember(cx, result, "identity", &value));
  NS_ENSURE_TRUE(value.isObject(), NS_ERROR_FILE_CORRUPTED);
  identity = &value.toObject();
  nsCString expectedIdentity, actualIdentity;
  MOZ_TRY(CacheJSON(cx, identity, actualIdentity));
  MOZ_TRY(CacheIdentity(cx, input, &identity));
  MOZ_TRY(CacheJSON(cx, identity, expectedIdentity));
  NS_ENSURE_TRUE(actualIdentity == expectedIdentity, NS_ERROR_FILE_CORRUPTED);
  MOZ_TRY(ImportMember(cx, result, "cells", &value));
  uint32_t count;
  MOZ_TRY(ImportArray(cx, value, &cells, count));
  uint64_t expectedCount = 0;
  for (const auto& folder : input.folders)
    expectedCount += folder.properties.Length();
  NS_ENSURE_TRUE(count == expectedCount, NS_ERROR_FILE_CORRUPTED);
  nsTHashSet<nsCString> seen;
  for (uint32_t i = 0; i < count; ++i) {
    NS_ENSURE_TRUE(JS_GetElement(cx, cells, i, &value) && value.isObject(),
                   NS_ERROR_FILE_CORRUPTED);
    JS::Rooted<JSObject*> cell(cx, &value.toObject());
    MOZ_TRY(ImportMember(cx, cell, "id", &value));
    int64_t id;
    MOZ_TRY(ImportNumber(value, 1, 9007199254740991., id));
    nsCString name, text;
    MOZ_TRY(ImportMember(cx, cell, "name", &value));
    MOZ_TRY(ImportText(cx, value, name));
    MOZ_TRY(ImportMember(cx, cell, "text", &value));
    MOZ_TRY(ImportText(cx, value, text));
    nsAutoCString key;
    key.AppendInt(id);
    key.Append(':');
    key.Append(name);
    NS_ENSURE_FALSE(seen.Contains(key), NS_ERROR_FILE_CORRUPTED);
    seen.Insert(key);
    const FolderImportProperty* original = nullptr;
    for (const auto& folder : input.folders) {
      if (folder.id != uint64_t(id)) continue;
      for (const auto& property : folder.properties)
        if (property.name == name) original = &property;
    }
    NS_ENSURE_TRUE(original && original->text == text, NS_ERROR_FILE_CORRUPTED);
    MOZ_TRY(ImportMember(cx, cell, "integer", &value, true));
    if (original->integer) {
      int64_t integer;
      MOZ_TRY(
          ImportNumber(value, *original->integer, *original->integer, integer));
    } else {
      NS_ENSURE_TRUE(value.isUndefined(), NS_ERROR_FILE_CORRUPTED);
    }
    if (name == "userSortOrder"_ns) {
      // This is the committed historical projection, not the current live
      // property. Later native edits must never be undone by receipt reuse.
      nsCString target, disposition;
      MOZ_TRY(ImportMember(cx, cell, "target", &value));
      MOZ_TRY(ImportText(cx, value, target));
      MOZ_TRY(ImportMember(cx, cell, "disposition", &value));
      MOZ_TRY(ImportText(cx, value, disposition));
      NS_ENSURE_TRUE(target == name && (disposition == "existing"_ns ||
                                        disposition == "applied"_ns),
                     NS_ERROR_FILE_CORRUPTED);
      MOZ_TRY(ImportMember(cx, cell, "nativeInteger", &value));
      int64_t native;
      MOZ_TRY(ImportNumber(value, 0, UINT32_MAX, native));
      NS_ENSURE_TRUE(original->integer && (disposition == "existing"_ns ||
                                           native == *original->integer),
                     NS_ERROR_FILE_CORRUPTED);
      for (const char* absent : {"nativeText", "eligibleMask"}) {
        MOZ_TRY(ImportMember(cx, cell, absent, &value, true));
        NS_ENSURE_TRUE(value.isUndefined(), NS_ERROR_FILE_CORRUPTED);
      }
    }
  }
  return NS_OK;
}

nsresult ParseCacheOriginalSummary(JSContext* cx, const nsACString& bytes,
                                   Maybe<uint32_t>& flags, uint32_t& messages) {
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
      caller, u"resource:///modules/panorama/MorkSummaryReader.sys.mjs"_ns,
      dom::ImportESModuleOptionsDictionary(), &module, error);
  if (error.Failed()) return error.StealNSResult();
  JS::Rooted<JS::Value> function(cx), parsed(cx), value(cx),
      argument(cx, JS::ObjectValue(*buffer));
  NS_ENSURE_TRUE(JS_GetProperty(cx, module, "parseMorkSummary", &function) &&
                     JS::Call(cx, module, function,
                              JS::HandleValueArray(argument), &parsed) &&
                     parsed.isObject(),
                 NS_ERROR_FAILURE);
  JS::Rooted<JSObject*> object(cx, &parsed.toObject()), array(cx), rows(cx);
  MOZ_TRY(ImportMember(cx, object, "messages", &value));
  MOZ_TRY(ImportArray(cx, value, &array, messages));
  MOZ_TRY(ImportMember(cx, object, "source", &value));
  NS_ENSURE_TRUE(value.isObject(), NS_ERROR_FILE_CORRUPTED);
  object = &value.toObject();
  MOZ_TRY(ImportMember(cx, object, "rows", &value));
  NS_ENSURE_TRUE(value.isObject(), NS_ERROR_FILE_CORRUPTED);
  rows = &value.toObject();
  NS_ENSURE_TRUE(JS::MapValues(cx, rows, &value), NS_ERROR_FAILURE);
  JS::ForOfIterator iterator(cx);
  NS_ENSURE_TRUE(iterator.init(value), NS_ERROR_FAILURE);
  bool done, seen = false;
  while (true) {
    NS_ENSURE_TRUE(iterator.next(&value, &done), NS_ERROR_FAILURE);
    if (done) break;
    NS_ENSURE_TRUE(value.isObject(), NS_ERROR_FILE_CORRUPTED);
    object = &value.toObject();
    MOZ_TRY(ImportMember(cx, object, "scope", &value));
    nsCString scope;
    MOZ_TRY(ImportText(cx, value, scope));
    if (scope != "ns:msg:db:row:scope:dbfolderinfo:all"_ns) continue;
    NS_ENSURE_FALSE(seen, NS_ERROR_NOT_IMPLEMENTED);
    seen = true;
    MOZ_TRY(ImportMember(cx, object, "cells", &value));
    NS_ENSURE_TRUE(value.isObject(), NS_ERROR_FILE_CORRUPTED);
    JS::Rooted<JSObject*> cells(cx, &value.toObject());
    JS::Rooted<JSString*> name(cx, JS_NewStringCopyZ(cx, "flags"));
    NS_ENSURE_TRUE(name, NS_ERROR_OUT_OF_MEMORY);
    JS::Rooted<JS::Value> key(cx, JS::StringValue(name));
    bool present;
    NS_ENSURE_TRUE(JS::MapHas(cx, cells, key, &present), NS_ERROR_FAILURE);
    if (present) {
      NS_ENSURE_TRUE(JS::MapGet(cx, cells, key, &value), NS_ERROR_FAILURE);
      nsCString text;
      MOZ_TRY(ImportText(cx, value, text));
      uint64_t word;
      MOZ_TRY(ImportHex(text, 8, word));
      flags = Some(uint32_t(word));
    }
  }
  NS_ENSURE_TRUE(seen, NS_ERROR_NOT_IMPLEMENTED);
  return NS_OK;
}

struct CacheInventoryFile {
  nsCString original, backup, sha;
  uint32_t size;
};

nsresult CheckCacheProjectionProof(
    JSContext* cx, CacheImport& input, mozIStorageConnection* connection,
    nsTArray<CacheImport>& checkedFiles,
    const std::function<nsresult()>& selectedStartup) {
  nsCOMPtr<nsIFile> selected;
  MOZ_TRY(NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR,
                                 getter_AddRefs(selected)));
  MOZ_TRY(NormalizeImportFile(selected));
  nsAutoString profile;
  MOZ_TRY(selected->GetPath(profile));
  NS_ENSURE_TRUE(NS_ConvertUTF16toUTF8(profile) == input.profilePath,
                 NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIFile> selector;
  MOZ_TRY(selected->Clone(getter_AddRefs(selector)));
  MOZ_TRY(selector->Append(u"panorama-profile.json"_ns));
  bool exists;
  MOZ_TRY(selector->Exists(&exists));
  if (exists) {
    NS_ENSURE_TRUE(selectedStartup, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(selectedStartup());
  }
  CacheImport manifest;
  manifest.path = input.manifestPath;
  manifest.sha256 = input.manifestSha256;
  manifest.size = input.manifestSize;
  nsCString bytes;
  MOZ_TRY(ReadCacheBytes(manifest, bytes));
  checkedFiles.AppendElement(std::move(manifest));
  JS::Rooted<JS::Value> value(cx);
  MOZ_TRY(CacheParseJSON(cx, bytes, &value));
  JS::Rooted<JSObject*> object(cx, &value.toObject()), roots(cx), entries(cx),
      parts(cx);
  MOZ_TRY(ImportMember(cx, object, "complete", &value));
  NS_ENSURE_TRUE(value.isBoolean() && value.toBoolean(),
                 NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(ImportMember(cx, object, "version", &value));
  int64_t number;
  // Selected startup has already authenticated its version-3 backup. Keep that
  // format scoped to its native publication check above; an unselected import
  // still requires the original version-1 proof.
  if (exists && value.isNumber() && value.toNumber() == 3) {
    MOZ_TRY(ImportNumber(value, 3, 3, number));
  } else {
    MOZ_TRY(ImportNumber(value, 1, 1, number));
  }
  MOZ_TRY(ImportMember(cx, object, "roots", &value));
  uint32_t rootCount;
  MOZ_TRY(ImportArray(cx, value, &roots, rootCount));
  NS_ENSURE_TRUE(rootCount, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIFile> manifestFile, backupRoot;
  MOZ_TRY(NS_NewLocalFile(NS_ConvertUTF8toUTF16(input.manifestPath),
                          getter_AddRefs(manifestFile)));
  MOZ_TRY(manifestFile->GetParent(getter_AddRefs(backupRoot)));
  nsTArray<CacheInventoryFile> files;
  nsTHashMap<nsCString, bool> paths, directories;
  for (uint32_t r = 0; r < rootCount; ++r) {
    NS_ENSURE_TRUE(JS_GetElement(cx, roots, r, &value) && value.isObject(),
                   NS_ERROR_INVALID_ARG);
    object = &value.toObject();
    MOZ_TRY(ImportMember(cx, object, "source", &value));
    nsCString rootPath;
    MOZ_TRY(ImportText(cx, value, rootPath));
    NS_ENSURE_TRUE(r || rootPath == input.profilePath, NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsIFile> root;
    MOZ_TRY(
        NS_NewLocalFile(NS_ConvertUTF8toUTF16(rootPath), getter_AddRefs(root)));
    MOZ_TRY(NormalizeImportFile(root));
    nsAutoString canonical;
    MOZ_TRY(root->GetPath(canonical));
    NS_ENSURE_TRUE(NS_ConvertUTF16toUTF8(canonical) == rootPath,
                   NS_ERROR_NOT_AVAILABLE);
    directories.InsertOrUpdate(rootPath, true);
    MOZ_TRY(ImportMember(cx, object, "directory", &value));
    nsCString directory, expected("root-");
    expected.AppendInt(r);
    MOZ_TRY(ImportText(cx, value, directory));
    NS_ENSURE_TRUE(directory == expected, NS_ERROR_INVALID_ARG);
    MOZ_TRY(ImportMember(cx, object, "entries", &value));
    uint32_t count;
    MOZ_TRY(ImportArray(cx, value, &entries, count));
    for (uint32_t e = 0; e < count; ++e) {
      NS_ENSURE_TRUE(JS_GetElement(cx, entries, e, &value) && value.isObject(),
                     NS_ERROR_INVALID_ARG);
      object = &value.toObject();
      nsCOMPtr<nsIFile> original, saved;
      MOZ_TRY(root->Clone(getter_AddRefs(original)));
      MOZ_TRY(backupRoot->Clone(getter_AddRefs(saved)));
      MOZ_TRY(saved->Append(NS_ConvertUTF8toUTF16(directory)));
      MOZ_TRY(ImportMember(cx, object, "parts", &value));
      uint32_t length;
      MOZ_TRY(ImportArray(cx, value, &parts, length));
      NS_ENSURE_TRUE(length, NS_ERROR_INVALID_ARG);
      for (uint32_t n = 0; n < length; ++n) {
        NS_ENSURE_TRUE(JS_GetElement(cx, parts, n, &value), NS_ERROR_FAILURE);
        nsCString component;
        MOZ_TRY(ImportText(cx, value, component));
        NS_ENSURE_TRUE(
            !component.IsEmpty() && component != "."_ns &&
                component != ".."_ns && component.FindChar('/') < 0 &&
                component.FindChar('\\') < 0 && component.FindChar(0) < 0,
            NS_ERROR_INVALID_ARG);
        MOZ_TRY(original->Append(NS_ConvertUTF8toUTF16(component)));
        MOZ_TRY(saved->Append(NS_ConvertUTF8toUTF16(component)));
      }
      nsAutoString originalPath, savedPath;
      MOZ_TRY(original->GetPath(originalPath));
      MOZ_TRY(saved->GetPath(savedPath));
      nsCString path{NS_ConvertUTF16toUTF8(originalPath)};
      NS_ENSURE_FALSE(paths.Contains(path), NS_ERROR_INVALID_ARG);
      paths.InsertOrUpdate(path, true);
      if (!r) {
        const nsCString databasePath{input.profilePath + kCacheDatabaseLeaf};
        const nsCString selectorPath{input.profilePath + kCacheSelectorLeaf};
        NS_ENSURE_TRUE(path != databasePath && path != selectorPath,
                       NS_ERROR_NOT_AVAILABLE);
      }
      MOZ_TRY(ImportMember(cx, object, "type", &value));
      nsCString type;
      MOZ_TRY(ImportText(cx, value, type));
      if (type == "directory"_ns) {
        directories.InsertOrUpdate(path, true);
        continue;
      }
      NS_ENSURE_TRUE(type == "regular"_ns, NS_ERROR_NOT_IMPLEMENTED);
      CacheInventoryFile file;
      file.original = path;
      file.backup = NS_ConvertUTF16toUTF8(savedPath);
      MOZ_TRY(ImportMember(cx, object, "size", &value));
      MOZ_TRY(ImportNumber(value, 0, UINT32_MAX - 1, number));
      file.size = number;
      MOZ_TRY(ImportMember(cx, object, "sha256", &value));
      MOZ_TRY(ImportText(cx, value, file.sha));
      NS_ENSURE_TRUE(file.sha.Length() == 64, NS_ERROR_INVALID_ARG);
      files.AppendElement(std::move(file));
    }
  }
  bool cacheCovered = false;
  for (const auto& file : files) {
    if (file.original == input.path) {
      NS_ENSURE_TRUE(file.sha == input.sha256 && file.size == input.size,
                     NS_ERROR_NOT_AVAILABLE);
      CacheImport backup;
      backup.path = file.backup;
      backup.size = file.size;
      backup.sha256 = file.sha;
      nsCString copied;
      MOZ_TRY(ReadCacheBytes(backup, copied));
      checkedFiles.AppendElement(std::move(backup));
      cacheCovered = true;
    }
  }
  NS_ENSURE_TRUE(cacheCovered, NS_ERROR_NOT_AVAILABLE);
  for (auto& folder : input.folders) {
    if (folder.isServer) {
      NS_ENSURE_TRUE(directories.Contains(folder.cachePath),
                     NS_ERROR_NOT_AVAILABLE);
      continue;
    }
    nsCOMPtr<nsIFile> summaryFile, parent;
    MOZ_TRY(NS_NewLocalFile(NS_ConvertUTF8toUTF16(folder.originalSummaryPath),
                            getter_AddRefs(summaryFile)));
    MOZ_TRY(summaryFile->GetParent(getter_AddRefs(parent)));
    MOZ_TRY(NormalizeImportFile(parent));
    nsAutoString parentPath;
    MOZ_TRY(parent->GetPath(parentPath));
    NS_ENSURE_TRUE(directories.Contains(NS_ConvertUTF16toUTF8(parentPath)),
                   NS_ERROR_NOT_AVAILABLE);
    const CacheInventoryFile* found = nullptr;
    for (const auto& file : files)
      if (file.original == folder.originalSummaryPath) found = &file;
    if (!found) {
      // A present directory is not evidence that an original summary is absent.
      NS_ENSURE_FALSE(paths.Contains(folder.originalSummaryPath),
                      NS_ERROR_NOT_AVAILABLE);
      nsCOMPtr<nsIFile> absent;
      MOZ_TRY(NS_NewLocalFile(NS_ConvertUTF8toUTF16(folder.originalSummaryPath),
                              getter_AddRefs(absent)));
      MOZ_TRY(NormalizeImportFile(absent));
      MOZ_TRY(absent->Exists(&exists));
      NS_ENSURE_FALSE(exists, NS_ERROR_NOT_AVAILABLE);
      continue;
    }
    CacheImport source;
    source.path = found->original;
    source.size = found->size;
    source.sha256 = found->sha;
    nsCString summary;
    MOZ_TRY(ReadCacheBytes(source, summary));
    checkedFiles.AppendElement(std::move(source));
    CacheImport backup;
    backup.path = found->backup;
    backup.size = found->size;
    backup.sha256 = found->sha;
    nsCString saved;
    MOZ_TRY(ReadCacheBytes(backup, saved));
    NS_ENSURE_TRUE(saved == summary, NS_ERROR_NOT_AVAILABLE);
    checkedFiles.AppendElement(std::move(backup));
    uint32_t messages;
    MOZ_TRY(
        ParseCacheOriginalSummary(cx, summary, folder.originalFlags, messages));
    if (messages) {
      nsCOMPtr<mozIStorageStatement> receipt;
      MOZ_TRY(connection->CreateStatement(
          "SELECT sourcePath,sourceSha256,databaseSourceId,messageCount FROM "
          "folder_import_receipts WHERE folderId=:id"_ns,
          getter_AddRefs(receipt)));
      MOZ_TRY(receipt->BindInt64ByName("id"_ns, folder.id));
      bool row;
      MOZ_TRY(receipt->ExecuteStep(&row));
      NS_ENSURE_TRUE(row, NS_ERROR_NOT_AVAILABLE);
      nsString path;
      nsCString hash, database;
      int64_t count;
      MOZ_TRY(receipt->GetString(0, path));
      MOZ_TRY(receipt->GetUTF8String(1, hash));
      MOZ_TRY(receipt->GetUTF8String(2, database));
      MOZ_TRY(receipt->GetInt64(3, &count));
      NS_ENSURE_TRUE(NS_ConvertUTF16toUTF8(path) == found->original &&
                         hash == found->sha && database == input.databaseId &&
                         count == messages,
                     NS_ERROR_NOT_AVAILABLE);
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

nsresult DatabaseCore::ImportFolderCacheMetadataV2(
    CacheImport& input, JSContext* cx, JS::MutableHandle<JS::Value> output) {
  auto connection = sConnection;
  RefPtr<FolderDatabase> folders = mFolderDatabase;
  auto current = [&]() -> bool {
    return sInstance.get() == this && sConnection == connection &&
           mFolderDatabase == folders && !mShuttingDown;
  };
  NS_ENSURE_TRUE(current(), NS_ERROR_NOT_AVAILABLE);
  nsCString source;
  MOZ_TRY(ReadDatabaseSourceId(connection, source));
  NS_ENSURE_TRUE(source == input.databaseId, NS_ERROR_NOT_AVAILABLE);
  JS::Rooted<JSObject*> identityObject(cx);
  MOZ_TRY(CacheIdentity(cx, input, &identityObject));
  nsCString identity;
  MOZ_TRY(CacheJSON(cx, identityObject, identity));
  Maybe<nsCString> prior;
  MOZ_TRY(ReadCacheReceipt(connection, input, identity, prior));
  if (prior) {
    nsCString bytes;
    MOZ_TRY(ReadCacheBytes(input, bytes));
    if (input.version == 3)
      MOZ_TRY(CheckStoredJSONCacheReceipt(cx, connection, input, *prior));
    JS::Rooted<JS::Value> result(cx);
    MOZ_TRY(CacheParseJSON(cx, *prior, &result));
    NS_ENSURE_TRUE(current(), NS_ERROR_NOT_AVAILABLE);
    output.set(result);
    return NS_OK;
  }
  MOZ_TRY(CheckCacheFolders(this, connection, input));
  nsCString bytes;
  MOZ_TRY(ReadCacheBytes(input, bytes));
  MOZ_TRY(ParseCacheBytes(cx, bytes, input));
  nsTArray<CacheImport> checkedFiles;
  auto selectedStartup = [&]() {
    return CheckStartupCachePublication(cx, input);
  };
  MOZ_TRY(CheckCacheProjectionProof(cx, input, connection, checkedFiles,
                                    selectedStartup));
  NS_ENSURE_TRUE(current(), NS_ERROR_NOT_AVAILABLE);
  struct Plan {
    uint64_t id;
    FolderDatabase::CacheOrigin origin;
    uint32_t beforeFlags;
    uint32_t warmBeforeFlags;
    uint32_t afterFlags;
    uint32_t eligibleMask;
    uint64_t total;
    uint64_t unread;
    int64_t storeSize;
    int32_t pendingOperations;
    nsCString name;
    nsTArray<FolderImportProperty> before;
    nsTArray<FolderImportProperty> writes;
    RefPtr<nsMsgDBFolder> wrapper;
    nsCOMPtr<nsIMsgPluggableStore> store;
  };
  nsTArray<Plan> plans;
  JS::Rooted<JSObject*> result(
      cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
  JS::Rooted<JSObject*> cells(cx, JS::NewArrayObject(cx, 0));
  NS_ENSURE_TRUE(
      result && cells && JS_SetPrototype(cx, cells, nullptr) &&
          JS_DefineProperty(cx, result, "identity", identityObject,
                            JSPROP_ENUMERATE) &&
          JS_DefineProperty(cx, result, "cells", cells, JSPROP_ENUMERATE),
      NS_ERROR_OUT_OF_MEMORY);
  uint32_t cellIndex = 0;
  for (const auto& folder : input.folders) {
    Plan plan;
    plan.id = folder.id;
    nsCOMPtr<nsIMsgFolder> wrapper;
    MOZ_TRY(folders->GetMsgFolderForFolder(folder.id, getter_AddRefs(wrapper)));
    NS_ENSURE_TRUE(wrapper, NS_ERROR_NOT_AVAILABLE);
    plan.wrapper = static_cast<nsMsgDBFolder*>(wrapper.get());
    MOZ_TRY(wrapper->GetMsgStore(getter_AddRefs(plan.store)));
    NS_ENSURE_TRUE(plan.store, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(plan.store->EstimateFolderSize(wrapper, &plan.storeSize));
    NS_ENSURE_TRUE(plan.storeSize >= 0, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(wrapper->GetFlags(&plan.warmBeforeFlags));
    MOZ_TRY(folders->CheckCacheProjectionOrigin(folder.id, plan.origin));
    plan.beforeFlags = MOZ_TRY(folders->GetFolderFlags(folder.id));
    NS_ENSURE_FALSE(plan.beforeFlags & nsMsgFolderFlags::Virtual,
                    NS_ERROR_NOT_IMPLEMENTED);
    plan.afterFlags = plan.beforeFlags;
    plan.eligibleMask =
        FolderDatabase::kCacheClientMask & ~plan.origin.explicitMask;
    if (folder.originalFlags) {
      plan.afterFlags = (plan.beforeFlags & ~plan.eligibleMask) |
                        (*folder.originalFlags & plan.eligibleMask);
      plan.eligibleMask = 0;
    }
    MOZ_TRY(folders->GetFolderProperties(folder.id, plan.before));
    plan.name = MOZ_TRY(folders->GetFolderName(folder.id));
    MOZ_TRY(MessageDB().GetNumMessages(folder.id, &plan.total));
    MOZ_TRY(MessageDB().GetNumUnread(folder.id, &plan.unread));
    NS_ENSURE_TRUE(plan.total <= INT32_MAX && plan.unread <= INT32_MAX,
                   NS_ERROR_LOSS_OF_SIGNIFICANT_DATA);
    nsCOMPtr<mozIStorageStatement> operations;
    MOZ_TRY(connection->CreateStatement(
        "SELECT EXISTS(SELECT 1 FROM offline_operations WHERE folderId=:id)"_ns,
        getter_AddRefs(operations)));
    MOZ_TRY(operations->BindInt64ByName("id"_ns, folder.id));
    bool row;
    MOZ_TRY(operations->ExecuteStep(&row));
    NS_ENSURE_TRUE(row, NS_ERROR_FILE_CORRUPTED);
    int32_t pendingOperations;
    MOZ_TRY(operations->GetInt32(0, &pendingOperations));
    operations = nullptr;
    plan.pendingOperations = pendingOperations;
    bool sawFlags = false;
    for (const auto& property : folder.properties) {
      nsCString target(property.name);
      Maybe<int64_t> nativeInteger;
      Maybe<nsCString> nativeText;
      const char* disposition = "native-authoritative";
      bool apply = false;
      if (target == "flags"_ns) {
        NS_ENSURE_TRUE(property.integer && *property.integer >= 0 &&
                           uint64_t(*property.integer) <= UINT32_MAX,
                       NS_ERROR_INVALID_ARG);
        sawFlags = true;
        plan.afterFlags = (plan.afterFlags & ~plan.eligibleMask) |
                          (uint32_t(*property.integer) & plan.eligibleMask);
        nativeInteger = Some(int64_t(plan.afterFlags));
        disposition = plan.eligibleMask ? "applied"
                      : folder.originalFlags && !plan.origin.explicitMask
                          ? "source-authoritative"
                          : "existing";
      } else if (target == "totalMsgs"_ns || target == "totalUnreadMsgs"_ns) {
        nativeInteger =
            Some(int64_t(target == "totalMsgs"_ns ? plan.total : plan.unread));
      } else if (target == "folderName"_ns) {
        nativeText = Some(plan.name);
      } else if (target == "key"_ns) {
        disposition = "binding";
      } else {
        bool pending =
            target == "pendingMsgs"_ns || target == "pendingUnreadMsgs"_ns;
        if (pending)
          target.Assign(property.name == "pendingMsgs"_ns
                            ? "totPendingMsgs"
                            : "unreadPendingMsgs");
        const FolderImportProperty* present = nullptr;
        for (const auto& old : plan.before)
          if (old.name == target) present = &old;
        if (present) {
          if (target == "userSortOrder"_ns) {
            NS_ENSURE_TRUE(input.version == 3 && present->integer &&
                               *present->integer >= 0 &&
                               uint64_t(*present->integer) <= UINT32_MAX,
                           NS_ERROR_FILE_CORRUPTED);
          }
          if (target == "folderSize"_ns || target == "expungedBytes"_ns) {
            NS_ENSURE_TRUE(present->integer && *present->integer >= 0,
                           NS_ERROR_NOT_IMPLEMENTED);
          }
          nativeInteger = present->integer;
          if (!present->integer) nativeText = Some(present->text);
          disposition = "existing";
        } else if (pending && pendingOperations) {
          // No cached contribution is added to independently imported work.
          nativeInteger = Some(int64_t{0});
        } else if (target == "folderSize"_ns || target == "expungedBytes"_ns) {
          // Native size is measured; absent expungedBytes has FolderInfo's
          // effective default zero even when committed messages remain.
          nativeInteger =
              Some(target == "folderSize"_ns ? plan.storeSize : int64_t{0});
          disposition = "applied-native";
          apply = true;
        } else {
          nativeInteger = property.integer;
          if (!property.integer) nativeText = Some(property.text);
          disposition = "applied";
          apply = true;
        }
        if (pending && nativeInteger) {
          if (apply) {
            NS_ENSURE_TRUE(
                *nativeInteger >= INT32_MIN && *nativeInteger <= INT32_MAX,
                NS_ERROR_INVALID_ARG);
          } else {
            NS_ENSURE_TRUE(
                *nativeInteger >= 0 && uint64_t(*nativeInteger) <= UINT32_MAX,
                NS_ERROR_LOSS_OF_SIGNIFICANT_DATA);
            nativeInteger = Some(int64_t(int32_t(uint32_t(*nativeInteger))));
          }
        }
        if (apply) {
          FolderImportProperty write{target, nativeText.valueOr(nsCString()),
                                     nativeInteger};
          if (pending && write.integer)
            write.integer = Some(int64_t(uint32_t(int32_t(*write.integer))));
          plan.writes.AppendElement(std::move(write));
        }
      }
      JS::Rooted<JSObject*> cell(
          cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
      NS_ENSURE_TRUE(cell &&
                         JS_DefineProperty(cx, cell, "id", double(folder.id),
                                           JSPROP_ENUMERATE) &&
                         CacheText(cx, cell, "name", property.name) &&
                         CacheText(cx, cell, "text", property.text) &&
                         CacheText(cx, cell, "target", target) &&
                         CacheText(cx, cell, "disposition",
                                   nsDependentCString(disposition)),
                     NS_ERROR_OUT_OF_MEMORY);
      if (property.integer)
        NS_ENSURE_TRUE(
            JS_DefineProperty(cx, cell, "integer", double(*property.integer),
                              JSPROP_ENUMERATE),
            NS_ERROR_OUT_OF_MEMORY);
      if (nativeInteger)
        NS_ENSURE_TRUE(
            JS_DefineProperty(cx, cell, "nativeInteger", double(*nativeInteger),
                              JSPROP_ENUMERATE),
            NS_ERROR_OUT_OF_MEMORY);
      if (nativeText)
        NS_ENSURE_TRUE(CacheText(cx, cell, "nativeText", *nativeText),
                       NS_ERROR_OUT_OF_MEMORY);
      if (property.name == "flags"_ns)
        NS_ENSURE_TRUE(
            JS_DefineProperty(cx, cell, "eligibleMask",
                              double(plan.eligibleMask), JSPROP_ENUMERATE),
            NS_ERROR_OUT_OF_MEMORY);
      NS_ENSURE_TRUE(
          JS_DefineElement(cx, cells, cellIndex++, cell, JSPROP_ENUMERATE),
          NS_ERROR_OUT_OF_MEMORY);
    }
    NS_ENSURE_TRUE(sawFlags || input.version == 3, NS_ERROR_NOT_IMPLEMENTED);
    MOZ_TRY(plan.wrapper->CheckCacheImportFlags(input.databaseId, plan.id,
                                                plan.warmBeforeFlags));
    plans.AppendElement(std::move(plan));
  }
  nsCString receipt;
  MOZ_TRY(CacheJSON(cx, result, receipt));
  JS::Rooted<JS::Value> prepared(cx);
  MOZ_TRY(CacheParseJSON(cx, receipt, &prepared));
  // Re-measure through the existing provider before taking SQL ownership.
  for (auto& plan : plans) {
    int64_t size;
    MOZ_TRY(plan.store->EstimateFolderSize(plan.wrapper, &size));
    NS_ENSURE_TRUE(size == plan.storeSize, NS_ERROR_NOT_AVAILABLE);
  }
  nsCString reread;
  MOZ_TRY(ReadCacheBytes(input, reread));
  NS_ENSURE_TRUE(reread == bytes, NS_ERROR_NOT_AVAILABLE);
  for (const auto& file : checkedFiles) {
    MOZ_TRY(ReadCacheBytes(file, reread));
  }
  for (const auto& folder : input.folders) {
    if (folder.isServer || folder.originalFlags) continue;
    // Recheck absence after all callbacks, before taking SQL ownership.
    // Present MSFs without a flags cell are in checkedFiles instead.
    bool checked = false;
    for (const auto& file : checkedFiles)
      checked |= file.path == folder.originalSummaryPath;
    if (checked) continue;
    nsCOMPtr<nsIFile> absent;
    MOZ_TRY(NS_NewLocalFile(NS_ConvertUTF8toUTF16(folder.originalSummaryPath),
                            getter_AddRefs(absent)));
    MOZ_TRY(NormalizeImportFile(absent));
    bool exists;
    MOZ_TRY(absent->Exists(&exists));
    if (exists) MOZ_TRY(selectedStartup());
  }
  nsCOMPtr<nsIFile> selector;
  MOZ_TRY(NS_NewLocalFile(NS_ConvertUTF8toUTF16(input.profilePath),
                          getter_AddRefs(selector)));
  MOZ_TRY(selector->Append(u"panorama-profile.json"_ns));
  bool exists;
  MOZ_TRY(selector->Exists(&exists));
  if (exists) MOZ_TRY(selectedStartup());
  NS_ENSURE_TRUE(current(), NS_ERROR_NOT_AVAILABLE);
  bool active;
  MOZ_TRY(connection->GetTransactionInProgress(&active));
  NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(connection->BeginTransaction());
  auto apply = [&]() -> nsresult {
    Maybe<nsCString> existing;
    MOZ_TRY(ReadCacheReceipt(connection, input, identity, existing));
    NS_ENSURE_FALSE(existing, NS_ERROR_ALREADY_INITIALIZED);
    auto sameProperties = [](const nsTArray<FolderImportProperty>& left,
                             const nsTArray<FolderImportProperty>& right) {
      if (left.Length() != right.Length()) return false;
      for (const auto& property : left) {
        bool found = false;
        for (const auto& other : right) {
          if (property.name == other.name && property.text == other.text &&
              property.integer == other.integer) {
            found = true;
            break;
          }
        }
        if (!found) return false;
      }
      return true;
    };
    auto checkPlan = [&](const Plan& plan, bool applied) -> nsresult {
      NS_ENSURE_TRUE(current() && !folders->mCacheOriginTainted,
                     NS_ERROR_NOT_AVAILABLE);
      Maybe<FolderDatabase::CacheOrigin> origin;
      MOZ_TRY(folders->ReadCacheOrigin(plan.id, origin));
      NS_ENSURE_TRUE(
          origin && origin->source == plan.origin.source &&
              origin->generation == mCacheOriginGeneration &&
              origin->generation == plan.origin.generation &&
              origin->parent == plan.origin.parent &&
              origin->name == plan.origin.name &&
              origin->birthSite == plan.origin.birthSite &&
              origin->explicitMask == plan.origin.explicitMask &&
              origin->used == plan.origin.used && !origin->pending &&
              origin->sealed == applied &&
              origin->revision == plan.origin.revision + uint64_t(applied),
          NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(folders->CheckCacheOriginLocation(*origin));
      NS_ENSURE_TRUE(MOZ_TRY(folders->GetFolderFlags(plan.id)) ==
                         (applied ? plan.afterFlags : plan.beforeFlags),
                     NS_ERROR_FILE_CORRUPTED);
      nsTArray<FolderImportProperty> properties;
      MOZ_TRY(folders->GetFolderProperties(plan.id, properties));
      auto expected = plan.before.Clone();
      if (applied) expected.AppendElements(plan.writes);
      NS_ENSURE_TRUE(sameProperties(properties, expected),
                     NS_ERROR_FILE_CORRUPTED);
      uint64_t total, unread;
      MOZ_TRY(MessageDB().GetNumMessages(plan.id, &total));
      MOZ_TRY(MessageDB().GetNumUnread(plan.id, &unread));
      NS_ENSURE_TRUE(total == plan.total && unread == plan.unread,
                     NS_ERROR_NOT_AVAILABLE);
      nsCOMPtr<mozIStorageStatement> guard;
      MOZ_TRY(connection->CreateStatement(
          "SELECT EXISTS(SELECT 1 FROM offline_operations WHERE folderId=:id),"
          "EXISTS(SELECT 1 FROM body_relocations WHERE folderId=:id "
          "AND state NOT IN(1,2))"_ns,
          getter_AddRefs(guard)));
      MOZ_TRY(guard->BindInt64ByName("id"_ns, plan.id));
      bool row;
      MOZ_TRY(guard->ExecuteStep(&row));
      NS_ENSURE_TRUE(row, NS_ERROR_FILE_CORRUPTED);
      int32_t operations, relocation;
      MOZ_TRY(guard->GetInt32(0, &operations));
      MOZ_TRY(guard->GetInt32(1, &relocation));
      NS_ENSURE_TRUE(operations == plan.pendingOperations && !relocation,
                     NS_ERROR_NOT_AVAILABLE);
      return plan.wrapper->CheckCacheImportFlags(input.databaseId, plan.id,
                                                 plan.warmBeforeFlags);
    };
    for (const auto& plan : plans) MOZ_TRY(checkPlan(plan, false));
    nsCOMPtr<mozIStorageStatement> insert;
    MOZ_TRY(connection->CreateStatement(
        "INSERT INTO folder_properties(id,name,value) VALUES(:id,:name,:value)"_ns,
        getter_AddRefs(insert)));
    for (auto& plan : plans) {
      for (const auto& property : plan.writes) {
        mozStorageStatementScoper reset(insert);
        MOZ_TRY(insert->BindInt64ByName("id"_ns, plan.id));
        MOZ_TRY(insert->BindUTF8StringByName("name"_ns, property.name));
        if (property.integer) {
          MOZ_TRY(insert->BindInt64ByName("value"_ns, *property.integer));
        } else {
          MOZ_TRY(insert->BindUTF8StringByName("value"_ns, property.text));
        }
        MOZ_TRY(insert->Execute());
      }
      MOZ_TRY(folders->WriteCacheFolderFlags(plan.id, plan.afterFlags));
      auto sealed = plan.origin;
      NS_ENSURE_TRUE(sealed.revision < INT64_MAX - 1, NS_ERROR_ILLEGAL_VALUE);
      ++sealed.revision;
      sealed.sealed = true;
      MOZ_TRY(folders->WriteCacheOrigin(sealed));
    }
    insert = nullptr;
    nsCOMPtr<mozIStorageStatement> save;
    MOZ_TRY(connection->CreateStatement(
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
    save = nullptr;
    nsCOMPtr<mozIStorageStatement> bind;
    MOZ_TRY(connection->CreateStatement(
        "INSERT INTO folder_cache_bindings(folderId,token) VALUES(:id,:token)"_ns,
        getter_AddRefs(bind)));
    for (const auto& folder : input.folders) {
      mozStorageStatementScoper reset(bind);
      MOZ_TRY(bind->BindInt64ByName("id"_ns, folder.id));
      MOZ_TRY(bind->BindUTF8StringByName("token"_ns, input.token));
      MOZ_TRY(bind->Execute());
    }
    bind = nullptr;
    // Independently reread the whole write set after every trigger has run.
    for (const auto& plan : plans) MOZ_TRY(checkPlan(plan, true));
    MOZ_TRY(ReadCacheReceipt(connection, input, identity, existing));
    NS_ENSURE_TRUE(existing && *existing == receipt, NS_ERROR_FILE_CORRUPTED);
    nsCOMPtr<mozIStorageStatement> raw;
    MOZ_TRY(connection->CreateStatement(
        "SELECT typeof(raw),length(raw),raw=:bytes FROM folder_cache_imports "
        "WHERE token=:token"_ns,
        getter_AddRefs(raw)));
    MOZ_TRY(raw->BindUTF8StringByName("token"_ns, input.token));
    MOZ_TRY(raw->BindBlobByName("bytes"_ns,
                                reinterpret_cast<const uint8_t*>(bytes.get()),
                                bytes.Length()));
    bool row;
    MOZ_TRY(raw->ExecuteStep(&row));
    NS_ENSURE_TRUE(row, NS_ERROR_FILE_CORRUPTED);
    nsCString type;
    int64_t size;
    int32_t equal;
    MOZ_TRY(raw->GetUTF8String(0, type));
    MOZ_TRY(raw->GetInt64(1, &size));
    MOZ_TRY(raw->GetInt32(2, &equal));
    NS_ENSURE_TRUE(type == "blob"_ns && size >= 0 &&
                       static_cast<uint64_t>(size) == bytes.Length() &&
                       equal == 1,
                   NS_ERROR_FILE_CORRUPTED);
    raw = nullptr;
    nsCString finalSource;
    MOZ_TRY(ReadDatabaseSourceId(connection, finalSource));
    NS_ENSURE_TRUE(current() && finalSource == input.databaseId,
                   NS_ERROR_NOT_AVAILABLE);
    return connection->CommitTransaction();
  };
  nsresult rv = apply();
  if (NS_FAILED(rv)) {
    bool pending;
    nsresult cleanup = connection->GetTransactionInProgress(&pending);
    if (NS_SUCCEEDED(cleanup) && pending)
      cleanup = connection->RollbackTransaction();
    NS_WARNING_ASSERTION(NS_SUCCEEDED(cleanup),
                         "Cache reconciliation rollback failed");
    return rv;
  }
  for (auto& plan : plans)
    plan.wrapper->PublishCacheImportFlags(plan.afterFlags);
  output.set(prepared);
  return NS_OK;
}

NS_IMETHODIMP
DatabaseCore::GetFolderCacheImportReceipt(JS::Handle<JS::Value> request,
                                          JSContext* cx,
                                          JS::MutableHandle<JS::Value> output) {
#ifdef XP_WIN
  // A Windows caller has no original-path admission of its own here. Only the
  // live selected-startup migration, whose native operation pins the profile
  // and database physical identities, may import or read cache receipts.
  NS_ENSURE_TRUE(
      mProfileStartup && mProfileStartup->opened && !mProfileStartup->ready &&
          mProfileStartup->mode == "migrate"_ns &&
          NS_SUCCEEDED(CheckProfileStartup(ProfileStartupToken(), true)),
      NS_ERROR_NOT_AVAILABLE);
#endif
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
  auto connection = sConnection;
  JS::Rooted<JSObject*> identityObject(cx);
  MOZ_TRY(CacheIdentity(cx, input, &identityObject));
  nsCString identity;
  MOZ_TRY(CacheJSON(cx, identityObject, identity));
  nsCString currentSource;
  MOZ_TRY(ReadDatabaseSourceId(connection, currentSource));
  NS_ENSURE_TRUE(currentSource == input.databaseId, NS_ERROR_NOT_AVAILABLE);
  Maybe<nsCString> receipt;
  MOZ_TRY(ReadCacheReceipt(connection, input, identity, receipt));
  if (!receipt) MOZ_TRY(CheckCacheFolders(this, connection, input));
  if (receipt && input.version == 3)
    MOZ_TRY(CheckStoredJSONCacheReceipt(cx, connection, input, *receipt));
  JS::Rooted<JS::Value> result(cx, JS::NullValue());
  if (receipt) MOZ_TRY(CacheParseJSON(cx, *receipt, &result));
  NS_ENSURE_TRUE(
      sInstance.get() == this && sConnection == connection && !mShuttingDown,
      NS_ERROR_NOT_AVAILABLE);
  output.set(result);
  return NS_OK;
}

NS_IMETHODIMP
DatabaseCore::ImportFolderCacheMetadata(JS::Handle<JS::Value> request,
                                        JSContext* cx,
                                        JS::MutableHandle<JS::Value> output) {
#ifdef XP_WIN
  // A Windows caller has no original-path admission of its own here. Only the
  // live selected-startup migration, whose native operation pins the profile
  // and database physical identities, may import or read cache receipts.
  NS_ENSURE_TRUE(
      mProfileStartup && mProfileStartup->opened && !mProfileStartup->ready &&
          mProfileStartup->mode == "migrate"_ns &&
          NS_SUCCEEDED(CheckProfileStartup(ProfileStartupToken(), true)),
      NS_ERROR_NOT_AVAILABLE);
#endif
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
  if (input.version >= 2) {
    return ImportFolderCacheMetadataV2(input, cx, output);
  }
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

namespace {
nsresult StartupText(JSContext* cx, JS::Handle<JSObject*> object,
                     const char* name, nsACString& text) {
  JS::Rooted<JS::Value> value(cx);
  MOZ_TRY(ImportMember(cx, object, name, &value));
  MOZ_TRY(ImportText(cx, value, text));
  NS_ENSURE_TRUE(text.FindChar(0) < 0, NS_ERROR_INVALID_ARG);
  return NS_OK;
}
nsresult StartupObject(JSContext* cx, JS::Handle<JSObject*> parent,
                       const char* name, JS::MutableHandle<JSObject*> object) {
  JS::Rooted<JS::Value> value(cx);
  MOZ_TRY(ImportMember(cx, parent, name, &value));
  NS_ENSURE_TRUE(value.isObject(), NS_ERROR_FILE_CORRUPTED);
  object.set(&value.toObject());
  return NS_OK;
}
nsresult StartupNumber(JSContext* cx, JS::Handle<JSObject*> object,
                       const char* name, int64_t minimum, int64_t maximum,
                       int64_t& number) {
  JS::Rooted<JS::Value> value(cx);
  MOZ_TRY(ImportMember(cx, object, name, &value));
  return ImportNumber(value, minimum, maximum, number);
}
bool StartupJSONWrite(const char16_t* text, uint32_t size, void* output) {
  static_cast<nsAString*>(output)->Append(text, size);
  return true;
}
nsresult StartupJSON(JSContext* cx, JS::Handle<JS::Value> input,
                     nsACString& output) {
  JS::Rooted<JS::Value> value(cx, input);
  nsString text;
  NS_ENSURE_TRUE(JS_Stringify(cx, &value, nullptr, JS::NullHandleValue,
                              StartupJSONWrite, &text),
                 NS_ERROR_FAILURE);
  NS_ENSURE_FALSE(text.IsEmpty(), NS_ERROR_INVALID_ARG);
  CopyUTF16toUTF8(text, output);
  return NS_OK;
}
nsresult StartupParse(JSContext* cx, const nsACString& text,
                      JS::MutableHandle<JS::Value> output) {
  NS_ConvertUTF8toUTF16 utf16(text);
  NS_ENSURE_TRUE(JS_ParseJSON(cx, utf16.get(), utf16.Length(), output) &&
                     output.isObject(),
                 NS_ERROR_FILE_CORRUPTED);
  return NS_OK;
}
nsresult StartupReadJSON(JSContext* cx, nsIFile* file,
                         JS::MutableHandle<JSObject*> output,
                         nsACString* original = nullptr) {
  nsCString text;
  MOZ_TRY(StartupRead(file, text));
  JS::Rooted<JS::Value> value(cx);
  MOZ_TRY(StartupParse(cx, text, &value));
  output.set(&value.toObject());
  if (original) *original = text;
  return NS_OK;
}
// Compare JSON trees, including number/string/null distinctions, independently
// of object property order. Only parsed native JSON is compared with snapshots.
nsresult StartupEqual(JSContext* cx, JS::Handle<JS::Value> a,
                      JS::Handle<JS::Value> b, uint32_t depth = 0) {
  NS_ENSURE_TRUE(depth < 128, NS_ERROR_FILE_CORRUPTED);
  if (!a.isObject() || !b.isObject()) {
    bool same;
    NS_ENSURE_TRUE(JS::SameValue(cx, a, b, &same), NS_ERROR_FAILURE);
    return same ? NS_OK : NS_ERROR_NOT_AVAILABLE;
  }
  JS::Rooted<JSObject*> left(cx, &a.toObject()), right(cx, &b.toObject());
  bool leftArray, rightArray;
  NS_ENSURE_TRUE(JS::IsArrayObject(cx, left, &leftArray) &&
                     JS::IsArrayObject(cx, right, &rightArray),
                 NS_ERROR_FAILURE);
  NS_ENSURE_TRUE(leftArray == rightArray, NS_ERROR_NOT_AVAILABLE);
  JS::Rooted<JS::IdVector> keys(cx, JS::IdVector(cx));
  JS::Rooted<JS::IdVector> other(cx, JS::IdVector(cx));
  NS_ENSURE_TRUE(
      JS_Enumerate(cx, left, &keys) && JS_Enumerate(cx, right, &other),
      NS_ERROR_FAILURE);
  NS_ENSURE_TRUE(keys.length() == other.length(), NS_ERROR_NOT_AVAILABLE);
  if (leftArray) {
    uint32_t x, y;
    NS_ENSURE_TRUE(
        JS::GetArrayLength(cx, left, &x) && JS::GetArrayLength(cx, right, &y),
        NS_ERROR_FAILURE);
    NS_ENSURE_TRUE(x == y, NS_ERROR_NOT_AVAILABLE);
  }
  for (uint32_t i = 0; i < keys.length(); ++i) {
    JS::Rooted<jsid> key(cx, keys[i]);
    bool present;
    NS_ENSURE_TRUE(JS_HasOwnPropertyById(cx, right, key, &present),
                   NS_ERROR_FAILURE);
    NS_ENSURE_TRUE(present, NS_ERROR_NOT_AVAILABLE);
    JS::Rooted<JS::Value> x(cx), y(cx);
    NS_ENSURE_TRUE(JS_GetPropertyById(cx, left, key, &x) &&
                       JS_GetPropertyById(cx, right, key, &y),
                   NS_ERROR_FAILURE);
    MOZ_TRY(StartupEqual(cx, x, y, depth + 1));
  }
  return NS_OK;
}
bool StartupApplication(const nsACString& version, const nsACString& build) {
  const auto text = version.BeginReading();
  const auto end = version.EndReading();
  auto current = text;
  auto number = [&]() {
    if (current == end || *current < '0' || *current > '9') return false;
    uint64_t value = 0;
    while (current != end && *current >= '0' && *current <= '9') {
      value = value * 10 + (*current++ - '0');
      if (value > INT32_MAX) return false;
    }
    return true;
  };
  if (!number() || current == end || *current++ != '.' || !number())
    return false;
  uint32_t parts = 2;
  while (current != end && *current == '.') {
    if (++parts > 4) return false;
    ++current;
    if (!number()) return false;
  }
  if (current != end) {
    nsDependentCSubstring suffix(current, end);
    if (suffix != "a1"_ns && suffix != "a2"_ns && suffix != "esr"_ns) {
      if (*current == 'b')
        ++current;
      else if (end - current > 2 && current[0] == 'r' && current[1] == 'c')
        current += 2;
      else
        return false;
      if (current == end || *current < '1' || *current > '9' || !number() ||
          current != end)
        return false;
    }
  }
  if (build.Length() != 14) return false;
  for (char c : build.View())
    if (c < '0' || c > '9') return false;
  auto part = [&](uint32_t first, uint32_t length) {
    uint32_t result = 0;
    for (uint32_t i = first; i < first + length; ++i)
      result = result * 10 + build[i] - '0';
    return result;
  };
  uint32_t year = part(0, 4), month = part(4, 2), day = part(6, 2);
  static const uint32_t days[] = {31, 28, 31, 30, 31, 30,
                                  31, 31, 30, 31, 30, 31};
  if (!year || !month || month > 12) return false;
  uint32_t max = days[month - 1] +
                 (month == 2 && !(year % 4) && ((year % 100) || !(year % 400)));
  return day && day <= max && part(8, 2) < 24 && part(10, 2) < 60 &&
         part(12, 2) < 60;
}
nsresult StartupVersion(JSContext* cx, JS::Handle<JSObject*> record) {
  JS::Rooted<JSObject*> application(cx);
  MOZ_TRY(StartupObject(cx, record, "application", &application));
  nsCString floor, build, current, currentBuild;
  MOZ_TRY(StartupText(cx, application, "version", floor));
  MOZ_TRY(StartupText(cx, application, "buildId", build));
  NS_ENSURE_TRUE(StartupApplication(floor, build), NS_ERROR_FILE_CORRUPTED);
  nsCOMPtr<nsIXULAppInfo> app = do_GetService("@mozilla.org/xre/app-info;1");
  nsCOMPtr<nsIVersionComparator> comparator =
      do_GetService("@mozilla.org/xpcom/version-comparator;1");
  NS_ENSURE_TRUE(app && comparator, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(app->GetVersion(current));
  MOZ_TRY(app->GetAppBuildID(currentBuild));
  NS_ENSURE_TRUE(StartupApplication(current, currentBuild),
                 NS_ERROR_NOT_AVAILABLE);
  int32_t order;
  MOZ_TRY(comparator->Compare(current, floor, &order));
  NS_ENSURE_TRUE(order > 0 || (order == 0 && Compare(currentBuild, build) >= 0),
                 NS_ERROR_NOT_AVAILABLE);
  return NS_OK;
}
nsresult StartupSelector(JSContext* cx, ProfileStartupOperation& operation,
                         JS::MutableHandle<JSObject*> record,
                         bool requireActive = false) {
  nsCOMPtr<nsIFile> file;
  MOZ_TRY(StartupChild(operation.profile, "panorama-profile.json",
                       getter_AddRefs(file)));
  bool exists;
  MOZ_TRY(file->Exists(&exists));
  if (!exists) {
    NS_ENSURE_FALSE(requireActive, NS_ERROR_NOT_AVAILABLE);
    record.set(nullptr);
    return NS_OK;
  }
  MOZ_TRY(StartupReadJSON(cx, file, record));
  int64_t version;
  MOZ_TRY(StartupNumber(cx, record, "formatVersion", 1, 2, version));
  // Format1 stays recoverable; it cannot silently gain a new native identity.
  NS_ENSURE_TRUE(version == 2, NS_ERROR_NOT_AVAILABLE);
  nsAutoCString backend, state, profile;
  MOZ_TRY(StartupText(cx, record, "backend", backend));
  MOZ_TRY(StartupText(cx, record, "state", state));
  NS_ENSURE_TRUE(
      backend == "panorama"_ns &&
          (state == "active"_ns || (!requireActive && state == "prepared"_ns)),
      NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(StartupVersion(cx, record));
  JS::Rooted<JSObject*> identity(cx);
  MOZ_TRY(StartupObject(cx, record, "identity", &identity));
  MOZ_TRY(StartupText(cx, identity, "profilePath", profile));
  NS_ENSURE_TRUE(profile == operation.profilePath, NS_ERROR_NOT_AVAILABLE);
  return NS_OK;
}
nsresult StartupSchema(mozIStorageConnection* reader, int32_t version) {
  NS_ENSURE_TRUE(version >= 0 && version <= 21, NS_ERROR_NOT_AVAILABLE);
  // These are the original upgrade pre/post layouts at their actual versions.
  // Nothing in this preflight creates, upgrades or repairs an on-disk schema.
  static constexpr struct {
    int32_t first, limit;
    const char* table;
    const char* columns;
  } layouts[] = {
      {1, 22, "message_reference_sets", "id:INTEGER:0:1"},
      {1, 22, "message_references",
       "id:INTEGER:0:1,ordinal:INTEGER:0:2,token:TEXT:1:0"},
      {3, 22, "message_key_allocator",
       "singleton:INTEGER:0:1,highWater:INTEGER:1:0"},
      {4, 22, "message_changes",
       "sequence:INTEGER:0:1,messageId:INTEGER:0:0,contentRevision:INTEGER:1:0,"
       "locationRevision:INTEGER:1:0,deleted:INTEGER:1:0"},
      {5, 22, "staged_message_properties",
       "id:INTEGER:0:1,name:TEXT:0:2,value:BLOB:0:0"},
      {5, 22, "staged_message_reference_sets", "id:INTEGER:0:1"},
      {5, 22, "staged_message_references",
       "id:INTEGER:0:1,ordinal:INTEGER:0:2,token:TEXT:1:0"},
      {8, 22, "database_identity", "singleton:INTEGER:0:1,sourceId:TEXT:1:0"},
      {9, 22, "folder_import_receipts",
       "token:TEXT:0:1,sourceId:TEXT:1:0,databaseSourceId:TEXT:1:0,"
       "sourceSha256:TEXT:1:0,folderId:INTEGER:1:0,folderPath:TEXT:1:0,"
       "sourcePath:TEXT:1:0,messageCount:INTEGER:1:0"},
      {9, 22, "folder_import_keys",
       "token:TEXT:1:1,sourceKey:INTEGER:1:2,destinationKey:INTEGER:1:0"},
      {10, 22, "body_relocations",
       "folderId:INTEGER:0:1,token:TEXT:1:0,sourceId:TEXT:1:0,original:TEXT:1:"
       "0,"
       "compacted:TEXT:1:0,backup:TEXT:1:0,originalSize:INTEGER:1:0,"
       "compactedSize:INTEGER:1:0,state:INTEGER:1:0,messageCount:INTEGER:1:0"},
      {10, 22, "body_relocation_rows",
       "folderId:INTEGER:1:1,id:INTEGER:1:2,oldToken:TEXT:0:0,content:INTEGER:"
       "1:0,"
       "location:INTEGER:1:0,size:INTEGER:1:0,offlineSize:INTEGER:1:0,lines:"
       "INTEGER:1:0,"
       "flags:INTEGER:1:0,newToken:TEXT:0:0,newSize:INTEGER:1:0,"
       "newOfflineSize:INTEGER:1:0,newLines:INTEGER:1:0,offline:INTEGER:1:0"},
      {12, 22, "folder_id_allocator",
       "singleton:INTEGER:0:1,highWater:INTEGER:1:0"},
      {13, 22, "thread_flags",
       "folderId:INTEGER:1:1,threadId:INTEGER:1:2,flags:INTEGER:1:0"},
      {14, 22, "folder_import_windows",
       "token:TEXT:0:1,version:INTEGER:1:0,sOriginal:TEXT:1:0,sRootOriginal:"
       "TEXT:1:0,"
       "sCanonical:TEXT:1:0,sCanonicalRoot:TEXT:1:0,sId:TEXT:1:0,sParentId:"
       "TEXT:1:0,"
       "sRootId:TEXT:1:0,tOriginal:TEXT:1:0,tRootOriginal:TEXT:1:0,tCanonical:"
       "TEXT:1:0,"
       "tCanonicalRoot:TEXT:1:0,tId:TEXT:1:0,tParentId:TEXT:1:0,tRootId:TEXT:1:"
       "0"},
      {15, 22, "folder_cache_imports",
       "token:TEXT:1:1,sourceId:TEXT:1:0,path:TEXT:1:0,identity:TEXT:1:0,raw:"
       "BLOB:1:0,"
       "receipt:TEXT:1:0"},
      {15, 22, "folder_cache_bindings", "folderId:INTEGER:1:1,token:TEXT:1:0"},
      {20, 22, "imap_import_units",
       "token:TEXT:1:1,databaseSourceId:TEXT:1:0,provenance:TEXT:1:0"},
      {20, 22, "imap_import_operations",
       "unitToken:TEXT:1:1,member:INTEGER:1:2,sourceKey:INTEGER:1:3,"
       "messageKey:INTEGER:1:0,operationId:INTEGER:1:0,revision:INTEGER:1:0"},
      {21, 22, "imap_import_operation_holds",
       "operationId:INTEGER:0:1,databaseSourceId:TEXT:1:0,folderId:INTEGER:1:0,"
       "messageKey:INTEGER:1:0"},
      {6, 11, "offline_operations",
       "id:INTEGER:0:1,folderId:INTEGER:1:0,messageKey:INTEGER:1:0,revision:"
       "INTEGER:1:0,"
       "epoch:INTEGER:0:0,uid:INTEGER:0:0,operation:INTEGER:1:0,"
       "flagOperation:INTEGER:1:0,newFlags:INTEGER:1:0,sourceKey:INTEGER:1:0,"
       "sourceUid:INTEGER:1:0,messageSize:INTEGER:1:0,playingBack:INTEGER:1:0,"
       "sourceFolderURI:TEXT:1:0,destinationFolderURI:TEXT:1:0,keywordsToAdd:"
       "TEXT:1:0,"
       "keywordsToRemove:TEXT:1:0,folderEpoch:INTEGER:0:0"},
      {11, 16, "offline_operations",
       "id:INTEGER:0:1,folderId:INTEGER:1:0,messageKey:INTEGER:1:0,revision:"
       "INTEGER:1:0,"
       "epoch:INTEGER:0:0,uid:INTEGER:0:0,operation:INTEGER:1:0,"
       "flagOperation:INTEGER:1:0,newFlags:INTEGER:1:0,sourceKey:INTEGER:1:0,"
       "sourceUid:INTEGER:1:0,messageSize:INTEGER:1:0,playingBack:INTEGER:1:0,"
       "sourceFolderURI:TEXT:1:0,destinationFolderURI:TEXT:1:0,keywordsToAdd:"
       "TEXT:1:0,"
       "keywordsToRemove:TEXT:1:0,folderEpoch:INTEGER:0:0,"
       "destinationFolderId:INTEGER:0:0,destinationKey:INTEGER:0:0,"
       "destinationEpoch:INTEGER:0:0"},
      {16, 19, "offline_operations",
       "id:INTEGER:0:1,folderId:INTEGER:1:0,messageKey:INTEGER:1:0,revision:"
       "INTEGER:1:0,"
       "epoch:INTEGER:0:0,uid:INTEGER:0:0,operation:INTEGER:1:0,"
       "flagOperation:INTEGER:1:0,newFlags:INTEGER:1:0,sourceKey:INTEGER:1:0,"
       "sourceUid:INTEGER:1:0,messageSize:INTEGER:1:0,playingBack:INTEGER:1:0,"
       "sourceFolderURI:TEXT:1:0,destinationFolderURI:TEXT:1:0,keywordsToAdd:"
       "TEXT:1:0,"
       "keywordsToRemove:TEXT:1:0,folderEpoch:INTEGER:0:0,"
       "destinationFolderId:INTEGER:0:0,destinationKey:INTEGER:0:0,"
       "destinationEpoch:INTEGER:0:0,sourcePhysicalKey:INTEGER:0:0"},
      {19, 22, "offline_operations",
       "id:INTEGER:0:1,folderId:INTEGER:1:0,messageKey:INTEGER:1:0,revision:"
       "INTEGER:1:0,"
       "epoch:INTEGER:0:0,uid:INTEGER:0:0,operation:INTEGER:1:0,"
       "flagOperation:INTEGER:1:0,newFlags:INTEGER:1:0,sourceKey:INTEGER:1:0,"
       "sourceUid:INTEGER:1:0,messageSize:INTEGER:1:0,playingBack:INTEGER:1:0,"
       "sourceFolderURI:TEXT:1:0,destinationFolderURI:TEXT:1:0,keywordsToAdd:"
       "TEXT:1:0,"
       "keywordsToRemove:TEXT:1:0,folderEpoch:INTEGER:0:0,"
       "destinationFolderId:INTEGER:0:0,destinationKey:INTEGER:0:0,"
       "destinationEpoch:INTEGER:0:0,sourcePhysicalKey:INTEGER:0:0,"
       "flagSetMask:INTEGER:0:0,flagClearMask:INTEGER:0:0,guardSourceId:TEXT:0:"
       "0,"
       "guardFolderId:INTEGER:0:0,guardKey:INTEGER:0:0,guardContentRevision:"
       "INTEGER:0:0,"
       "guardLocationRevision:INTEGER:0:0,guardStoreToken:TEXT:0:0,"
       "guardMessageSize:INTEGER:0:0,guardOfflineSize:INTEGER:0:0,"
       "guardLineCount:INTEGER:0:0,guardFlags:INTEGER:0:0,guardPresence:"
       "INTEGER:0:0"},
      {6, 11, "offline_copy_destinations",
       "operationId:INTEGER:1:1,ordinal:INTEGER:1:2,uri:TEXT:1:0"},
      {11, 22, "offline_copy_destinations",
       "operationId:INTEGER:1:1,ordinal:INTEGER:1:2,uri:TEXT:1:0,"
       "destinationFolderId:INTEGER:0:0,destinationKey:INTEGER:0:0,"
       "destinationEpoch:INTEGER:0:0"},
      {6, 17, "offline_attempts",
       "id:INTEGER:0:1,operationId:INTEGER:1:0,revision:INTEGER:1:0,state:"
       "INTEGER:1:0,"
       "sourceFolderId:INTEGER:0:0,sourceKey:INTEGER:0:0,sourceEpoch:INTEGER:0:"
       "0,"
       "sourceUid:INTEGER:0:0,destinationFolderId:INTEGER:0:0,"
       "destinationKey:INTEGER:0:0,destinationEpoch:INTEGER:0:0,"
       "confirmedUid:INTEGER:0:0,operationFolderId:INTEGER:1:0,"
       "operationEpoch:INTEGER:0:0,operation:INTEGER:1:0"},
      {17, 18, "offline_attempts",
       "id:INTEGER:0:1,operationId:INTEGER:1:0,revision:INTEGER:1:0,state:"
       "INTEGER:1:0,"
       "sourceFolderId:INTEGER:0:0,sourceKey:INTEGER:0:0,sourceEpoch:INTEGER:0:"
       "0,"
       "sourceUid:INTEGER:0:0,destinationFolderId:INTEGER:0:0,"
       "destinationKey:INTEGER:0:0,destinationEpoch:INTEGER:0:0,"
       "confirmedUid:INTEGER:0:0,operationFolderId:INTEGER:1:0,"
       "operationEpoch:INTEGER:0:0,operation:INTEGER:1:0,appendAccepted:"
       "INTEGER:1:0,"
       "appendSourceId:TEXT:0:0,appendContentRevision:INTEGER:0:0,"
       "appendLocationRevision:INTEGER:0:0,appendStoreToken:TEXT:0:0,"
       "appendMessageSize:INTEGER:0:0,appendOfflineSize:INTEGER:0:0,"
       "appendLineCount:INTEGER:0:0,appendFlags:INTEGER:0:0"},
      {18, 19, "offline_attempts",
       "id:INTEGER:0:1,operationId:INTEGER:1:0,revision:INTEGER:1:0,state:"
       "INTEGER:1:0,"
       "sourceFolderId:INTEGER:0:0,sourceKey:INTEGER:0:0,sourceEpoch:INTEGER:0:"
       "0,"
       "sourceUid:INTEGER:0:0,destinationFolderId:INTEGER:0:0,"
       "destinationKey:INTEGER:0:0,destinationEpoch:INTEGER:0:0,"
       "confirmedUid:INTEGER:0:0,operationFolderId:INTEGER:1:0,"
       "operationEpoch:INTEGER:0:0,operation:INTEGER:1:0,appendAccepted:"
       "INTEGER:1:0,"
       "appendSourceId:TEXT:0:0,appendContentRevision:INTEGER:0:0,"
       "appendLocationRevision:INTEGER:0:0,appendStoreToken:TEXT:0:0,"
       "appendMessageSize:INTEGER:0:0,appendOfflineSize:INTEGER:0:0,"
       "appendLineCount:INTEGER:0:0,appendFlags:INTEGER:0:0,transferSourceId:"
       "TEXT:0:0,"
       "transferOperationKey:INTEGER:0:0,copyOrdinal:INTEGER:0:0,"
       "transferAccepted:INTEGER:1:0,transferContentRevision:INTEGER:0:0,"
       "transferLocationRevision:INTEGER:0:0,transferStoreToken:TEXT:0:0,"
       "transferMessageSize:INTEGER:0:0,transferOfflineSize:INTEGER:0:0,"
       "transferLineCount:INTEGER:0:0,transferFlags:INTEGER:0:0,"
       "confirmedEpoch:INTEGER:0:0"},
      {19, 22, "offline_attempts",
       "id:INTEGER:0:1,operationId:INTEGER:1:0,revision:INTEGER:1:0,state:"
       "INTEGER:1:0,"
       "sourceFolderId:INTEGER:0:0,sourceKey:INTEGER:0:0,sourceEpoch:INTEGER:0:"
       "0,"
       "sourceUid:INTEGER:0:0,destinationFolderId:INTEGER:0:0,"
       "destinationKey:INTEGER:0:0,destinationEpoch:INTEGER:0:0,"
       "confirmedUid:INTEGER:0:0,operationFolderId:INTEGER:1:0,"
       "operationEpoch:INTEGER:0:0,operation:INTEGER:1:0,appendAccepted:"
       "INTEGER:1:0,"
       "appendSourceId:TEXT:0:0,appendContentRevision:INTEGER:0:0,"
       "appendLocationRevision:INTEGER:0:0,appendStoreToken:TEXT:0:0,"
       "appendMessageSize:INTEGER:0:0,appendOfflineSize:INTEGER:0:0,"
       "appendLineCount:INTEGER:0:0,appendFlags:INTEGER:0:0,transferSourceId:"
       "TEXT:0:0,"
       "transferOperationKey:INTEGER:0:0,copyOrdinal:INTEGER:0:0,"
       "transferAccepted:INTEGER:1:0,transferContentRevision:INTEGER:0:0,"
       "transferLocationRevision:INTEGER:0:0,transferStoreToken:TEXT:0:0,"
       "transferMessageSize:INTEGER:0:0,transferOfflineSize:INTEGER:0:0,"
       "transferLineCount:INTEGER:0:0,transferFlags:INTEGER:0:0,"
       "confirmedEpoch:INTEGER:0:0,flagSetMask:INTEGER:0:0,flagClearMask:"
       "INTEGER:0:0,"
       "guardSourceId:TEXT:0:0,guardFolderId:INTEGER:0:0,guardKey:INTEGER:0:0,"
       "guardContentRevision:INTEGER:0:0,guardLocationRevision:INTEGER:0:0,"
       "guardStoreToken:TEXT:0:0,guardMessageSize:INTEGER:0:0,"
       "guardOfflineSize:INTEGER:0:0,guardLineCount:INTEGER:0:0,guardFlags:"
       "INTEGER:0:0,"
       "guardPresence:INTEGER:0:0,replayVersion:INTEGER:1:0,moveExpunge:"
       "INTEGER:0:0,"
       "flagSetState:INTEGER:0:0,flagSetGeneration:INTEGER:0:0,flagSetError:"
       "INTEGER:0:0,"
       "flagClearState:INTEGER:0:0,flagClearGeneration:INTEGER:0:0,"
       "flagClearError:INTEGER:0:0,sourceStoreState:INTEGER:0:0,"
       "sourceStoreGeneration:INTEGER:0:0,sourceStoreError:INTEGER:0:0,"
       "sourceExpungeState:INTEGER:0:0,sourceExpungeGeneration:INTEGER:0:0,"
       "sourceExpungeError:INTEGER:0:0,moveSettled:INTEGER:1:0,firstError:"
       "INTEGER:0:0,"
       "settledSourceRemoved:INTEGER:0:0,settledOperationRetired:INTEGER:0:0"},
      {0, 22, "folders",
       "id:INTEGER:0:1,parent:INTEGER:0:0,ordinal:INTEGER:0:0,name:TEXT:0:0,"
       "flags:INTEGER:0:0"},
      {0, 22, "messages",
       "id:INTEGER:0:1,folderId:INTEGER:0:0,threadId:INTEGER:0:0,"
       "threadParent:INTEGER:0:0,messageId:TEXT:0:0,date:INTEGER:0:0,sender:"
       "TEXT:0:0,"
       "recipients:TEXT:0:0,ccList:TEXT:0:0,bccList:TEXT:0:0,subject:TEXT:0:0,"
       "flags:INTEGER:0:0,tags:TEXT:0:0,priority:INTEGER:0:0"},
      {5, 22, "staged_messages",
       "id:INTEGER:0:1,folderId:INTEGER:0:0,threadId:INTEGER:0:0,"
       "threadParent:INTEGER:0:0,messageId:TEXT:0:0,date:INTEGER:0:0,sender:"
       "TEXT:0:0,"
       "recipients:TEXT:0:0,ccList:TEXT:0:0,bccList:TEXT:0:0,subject:TEXT:0:0,"
       "flags:INTEGER:0:0,tags:TEXT:0:0,priority:INTEGER:0:0"},
      {0, 22, "virtualFolder_folders",
       "virtualFolderId:INTEGER:0:0,searchFolderId:INTEGER:0:0"},
      {0, 22, "search_folder_hits",
       "folder_id:INTEGER:0:1,message_id:INTEGER:0:2"},
      {0, 2, "folder_properties", "id:INTEGER:0:1,name:TEXT:0:2,value:ANY:0:0"},
      {2, 22, "folder_properties",
       "id:INTEGER:0:1,name:TEXT:0:2,value:BLOB:0:0"},
      {0, 2, "message_properties",
       "id:INTEGER:0:1,name:TEXT:0:2,value:ANY:0:0"},
      {2, 22, "message_properties",
       "id:INTEGER:0:1,name:TEXT:0:2,value:BLOB:0:0"},
  };
  for (const auto& layout : layouts) {
    if (version >= layout.first && version < layout.limit)
      MOZ_TRY(CheckReferenceSchemaTable(reader, layout.table, layout.columns));
  }
  auto trigger = [&](const char* name, const nsACString& expected) -> nsresult {
    nsCOMPtr<mozIStorageStatement> statement;
    MOZ_TRY(reader->CreateStatement(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=:name"_ns,
        getter_AddRefs(statement)));
    MOZ_TRY(
        statement->BindUTF8StringByName("name"_ns, nsDependentCString(name)));
    bool row;
    MOZ_TRY(statement->ExecuteStep(&row));
    NS_ENSURE_TRUE(row, NS_ERROR_FILE_CORRUPTED);
    nsCString actual;
    MOZ_TRY(statement->GetUTF8String(0, actual));
    NS_ENSURE_TRUE(actual == expected, NS_ERROR_FILE_CORRUPTED);
    return NS_OK;
  };
  if (version >= 1)
    MOZ_TRY(trigger("delete_message_references", kReferenceDeleteTrigger));
  if (version >= 3) {
    if (version >= 5) {
      MOZ_TRY(trigger("guard_message_key", kStagedMessageKeyGuard));
      MOZ_TRY(trigger("record_message_key", kStagedMessageKeyRecord));
    } else {
      MOZ_TRY(trigger("guard_message_key", kMessageKeyGuard));
      MOZ_TRY(trigger("record_message_key", kMessageKeyRecord));
    }
    MOZ_TRY(trigger("immutable_message_key", kMessageKeyImmutable));
  }
  if (version >= 5) MOZ_TRY(trigger("delete_staged_header", kStagedDelete));
  if (version >= 12) {
    MOZ_TRY(trigger("guard_folder_id", kFolderIdGuard));
    MOZ_TRY(trigger("record_folder_id", kFolderIdRecord));
    MOZ_TRY(trigger("immutable_folder_id", kFolderIdImmutable));
  }
  if (version >= 4)
    MOZ_TRY(SearchChangeTriggers(reader, SearchTriggerAction::CheckAll,
                                 version < 7));
  if (version >= 8) {
    nsCString identity;
    MOZ_TRY(ReadDatabaseSourceId(reader, identity));
  }
  if (version >= 3) {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(reader->CreateStatement(
        "SELECT highWater FROM message_key_allocator WHERE singleton=1 AND "
        "typeof(highWater)='integer' AND highWater BETWEEN 0 AND 4294967294 "
        "AND highWater >= (SELECT COALESCE(MAX(id),0) FROM messages)"_ns,
        getter_AddRefs(stmt)));
    bool row;
    MOZ_TRY(stmt->ExecuteStep(&row));
    NS_ENSURE_TRUE(row, NS_ERROR_FILE_CORRUPTED);
  }
  return NS_OK;
}

nsresult StartupProbe(nsIFile* file, bool& exists, int32_t& version,
                      nsACString& sourceId) {
  MOZ_TRY(file->Exists(&exists));
  if (!exists) {
    // A detached WAL/SHM/journal is recovery state, not an empty profile.
    nsCOMPtr<nsIFile> parent, sidecar;
    MOZ_TRY(file->GetParent(getter_AddRefs(parent)));
    for (const char* leaf : {"panorama.sqlite-wal", "panorama.sqlite-shm",
                             "panorama.sqlite-journal"}) {
      MOZ_TRY(StartupChild(parent, leaf, getter_AddRefs(sidecar)));
      bool present;
      MOZ_TRY(sidecar->Exists(&present));
      NS_ENSURE_FALSE(present, NS_ERROR_FILE_CORRUPTED);
    }
    return NS_OK;
  }
  MOZ_TRY(StartupRegular(file));
  nsCOMPtr<nsIURI> uri;
  MOZ_TRY(NS_NewFileURI(getter_AddRefs(uri), file));
  nsAutoCString spec;
  MOZ_TRY(uri->GetSpec(spec));
  spec.AppendLiteral("?mode=ro");
  MOZ_TRY(NS_NewURI(getter_AddRefs(uri), spec));
  nsCOMPtr<nsIFileURL> url = do_QueryInterface(uri);
  NS_ENSURE_TRUE(url, NS_ERROR_UNEXPECTED);
  nsCOMPtr<mozIStorageService> storage =
      do_GetService("@mozilla.org/storage/service;1");
  NS_ENSURE_TRUE(storage, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<mozIStorageConnection> reader;
  MOZ_TRY(storage->OpenDatabaseWithFileURL(
      url, "panorama.sqlite"_ns, mozIStorageService::CONNECTION_DEFAULT,
      getter_AddRefs(reader)));
  auto close = MakeScopeExit([&] { reader->Close(); });
  MOZ_TRY(reader->GetSchemaVersion(&version));
  NS_ENSURE_TRUE(version >= 0 && version <= 21, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<mozIStorageStatement> check;
  MOZ_TRY(
      reader->CreateStatement("PRAGMA quick_check"_ns, getter_AddRefs(check)));
  bool more;
  MOZ_TRY(check->ExecuteStep(&more));
  nsAutoCString result;
  NS_ENSURE_TRUE(more, NS_ERROR_FILE_CORRUPTED);
  MOZ_TRY(check->GetUTF8String(0, result));
  NS_ENSURE_TRUE(result == "ok"_ns, NS_ERROR_FILE_CORRUPTED);
  MOZ_TRY(check->ExecuteStep(&more));
  NS_ENSURE_FALSE(more, NS_ERROR_FILE_CORRUPTED);
  check = nullptr;
  MOZ_TRY(StartupSchema(reader, version));
  if (version >= 8) MOZ_TRY(ReadDatabaseSourceId(reader, sourceId));
  MOZ_TRY(reader->Close());
  close.release();
  return NS_OK;
}
nsresult StartupArray(JSContext* cx, JS::Handle<JSObject*> object,
                      const char* name, JS::MutableHandle<JSObject*> array,
                      uint32_t& length, bool optional = false) {
  JS::Rooted<JS::Value> value(cx);
  MOZ_TRY(ImportMember(cx, object, name, &value, optional));
  if (optional && value.isUndefined()) {
    array.set(JS::NewArrayObject(cx, 0));
    length = 0;
    return array ? NS_OK : NS_ERROR_OUT_OF_MEMORY;
  }
  return ImportArray(cx, value, array, length);
}
nsresult StartupItem(JSContext* cx, JS::Handle<JSObject*> array, uint32_t index,
                     JS::MutableHandle<JSObject*> object) {
  JS::Rooted<JS::Value> value(cx);
  NS_ENSURE_TRUE(JS_GetElement(cx, array, index, &value) && value.isObject(),
                 NS_ERROR_FILE_CORRUPTED);
  object.set(&value.toObject());
  return NS_OK;
}
nsresult StartupContained(nsIFile* root, const nsACString& path,
                          nsIFile** file) {
  MOZ_TRY(NS_NewNativeLocalFile(path, file));
  nsAutoCString literal;
  MOZ_TRY(GetComparablePath((*file), literal));
  NS_ENSURE_TRUE(literal == path, NS_ERROR_FILE_INVALID_PATH);
  bool inside;
  MOZ_TRY(root->Contains(*file, &inside));
  NS_ENSURE_TRUE(inside, NS_ERROR_FILE_ACCESS_DENIED);
  MOZ_TRY(StartupRegular(*file));
  return NS_OK;
}
// Independent on-disk inventory. Only selected-profile roots are admitted here;
// a path or digest does not prove an external writer has been excluded.
nsresult StartupJSONCache(nsIFile* file, bool& empty) {
  nsCString bytes;
  MOZ_TRY(StartupRead(file, bytes));
  dom::AutoJSAPI jsapi;
  NS_ENSURE_TRUE(jsapi.Init(xpc::PrivilegedJunkScope()), NS_ERROR_FAILURE);
  JSContext* cx = jsapi.cx();
  JS::Rooted<JSObject*> parsed(cx), entries(cx), source(cx);
  nsresult rv = ParseCacheDocument(cx, bytes, true, &parsed);
  if (NS_FAILED(rv)) {
    // Preserve the actual decoder diagnostic before the isolated JSAPI scope
    // ends. The caller still receives the original native failure code.
    if (jsapi.HasException()) jsapi.ReportException();
    return rv;
  }
  JS::Rooted<JS::Value> value(cx);
  MOZ_TRY(ImportMember(cx, parsed, "entries", &value));
  NS_ENSURE_TRUE(value.isObject(), NS_ERROR_FILE_CORRUPTED);
  entries = &value.toObject();
  MOZ_TRY(ImportMember(cx, parsed, "source", &value));
  NS_ENSURE_TRUE(value.isObject(), NS_ERROR_FILE_CORRUPTED);
  source = &value.toObject();
  JS::Rooted<JS::IdVector> keys(cx, JS::IdVector(cx));
  NS_ENSURE_TRUE(JS_Enumerate(cx, source, &keys), NS_ERROR_FAILURE);
  uint32_t count = JS::MapSize(cx, entries);
  NS_ENSURE_TRUE(keys.length() == count, NS_ERROR_FILE_CORRUPTED);
  nsCString after;
  MOZ_TRY(StartupRead(file, after));
  NS_ENSURE_TRUE(after == bytes, NS_ERROR_NOT_AVAILABLE);
  empty = count == 0;
  return NS_OK;
}

nsresult StartupInventory(nsIFile* directory, nsTArray<nsCString>& sources,
                          bool mailTree = false, bool selectedRoot = true) {
  nsAutoCString ignored;
  MOZ_TRY(StartupDirectory(directory, ignored));
  bool jsonCache = false, emptyJSON = false;
  if (selectedRoot) {
    nsCOMPtr<nsIFile> file;
    MOZ_TRY(StartupChild(directory, "folderCache.json", getter_AddRefs(file)));
    MOZ_TRY(file->Exists(&jsonCache));
    if (jsonCache) MOZ_TRY(StartupJSONCache(file, emptyJSON));
  }
  nsCOMPtr<nsIDirectoryEnumerator> entries;
  MOZ_TRY(directory->GetDirectoryEntries(getter_AddRefs(entries)));
  auto close = MakeScopeExit([&] { entries->Close(); });
  while (true) {
    nsCOMPtr<nsIFile> file;
    MOZ_TRY(entries->GetNextFile(getter_AddRefs(file)));
    if (!file) break;
    nsAutoCString name, path;
    MOZ_TRY(file->GetNativeLeafName(name));
    if (selectedRoot && (name == "parent.lock"_ns || name == ".parentlock"_ns ||
                         name == "lock"_ns))
      continue;
    bool linked;
    MOZ_TRY(file->IsSymlink(&linked));
    NS_ENSURE_FALSE(linked, NS_ERROR_FILE_ACCESS_DENIED);
    bool isDirectory;
    MOZ_TRY(file->IsDirectory(&isDirectory));
    // Precedence never waives the original physical-file admission.
    if (selectedRoot && jsonCache &&
        (name == "panacea.dat"_ns ||
         (name == "folderCache.json"_ns && emptyJSON))) {
      MOZ_TRY(StartupRegular(file));
      continue;
    }
    if (isDirectory) {
      MOZ_TRY(StartupInventory(file, sources,
                               mailTree || name == "Mail"_ns ||
                                   name == "ImapMail"_ns || name == "News"_ns,
                               false));
    } else if (StringEndsWith(name, ".msf"_ns) ||
               StringEndsWith(name, ".mab"_ns) ||
               name == "folderCache.json"_ns || name == "panacea.dat"_ns) {
      MOZ_TRY(StartupRegular(file));
      MOZ_TRY(GetComparablePath(file, path));
      sources.AppendElement(path);
    } else if (mailTree) {
      // A store without any summary still prevents empty initialization.
      MOZ_TRY(GetComparablePath(file, path));
      sources.AppendElement(path);
    }
  }
  MOZ_TRY(entries->Close());
  close.release();
  return NS_OK;
}
// Read only the selected server's existing path preferences. In particular,
// GetIncomingServer is not a path getter: it also constructs the cold root and
// recursively reconciles its children before returning the server.
// A configured server root in its canonical spelling. Only the operating
// system alias above the selected profile is resolved (macOS /var or /tmp to
// /private), as StartupDirectory and the JS capture admit it; any other link
// is refused. Windows roots keep their literal admitted physical spelling.
nsresult StartupCanonicalRoot(nsIFile* root, nsIFile** output) {
#ifndef XP_WIN
  bool exists = false;
  MOZ_TRY(root->Exists(&exists));
  if (exists) {
    nsAutoCString canonical;
    MOZ_TRY(StartupDirectory(root, canonical));
    return NewComparableFile(canonical, output);
  }
#endif
  return root->Clone(output);
}

nsresult StartupConfiguredPath(nsIPrefBranch* prefs, const nsACString& branch,
                               nsIFile** output) {
  bool relative;
  MOZ_TRY(prefs->PrefHasUserValue(nsCString(branch + "directory-rel"_ns).get(),
                                  &relative));
  nsCOMPtr<nsIFile> root;
  if (relative) {
    nsCOMPtr<nsIRelativeFilePref> value;
    MOZ_TRY(prefs->GetComplexValue(nsCString(branch + "directory-rel"_ns).get(),
                                   NS_GET_IID(nsIRelativeFilePref),
                                   getter_AddRefs(value)));
    NS_ENSURE_TRUE(value, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(value->GetFile(getter_AddRefs(root)));
  } else {
    MOZ_TRY(prefs->GetComplexValue(nsCString(branch + "directory"_ns).get(),
                                   NS_GET_IID(nsIFile), getter_AddRefs(root)));
  }
  NS_ENSURE_TRUE(root, NS_ERROR_NOT_AVAILABLE);
  return StartupCanonicalRoot(root, output);
}

nsresult StartupConfiguredRoots(nsIFile* profile,
                                nsTArray<nsCString>& inventory,
                                nsTArray<StartupServerRoot>* output = nullptr) {
  nsCOMPtr<nsIPrefBranch> prefs =
      do_GetService("@mozilla.org/preferences-service;1");
  NS_ENSURE_TRUE(prefs, NS_ERROR_NOT_AVAILABLE);
  nsTArray<nsCString> names;
  MOZ_TRY(prefs->GetChildList("mail.server.", names));
  nsTHashSet<nsCString> servers;
  for (const auto& name : names) {
    if (!StringEndsWith(name, ".directory"_ns) &&
        !StringEndsWith(name, ".directory-rel"_ns))
      continue;
    int32_t dot = name.FindChar('.', 12);
    NS_ENSURE_TRUE(dot > 12, NS_ERROR_FILE_CORRUPTED);
    nsCString branch(Substring(name, 0, dot + 1));
    if (servers.Contains(branch)) continue;
    servers.Insert(branch);
    nsCOMPtr<nsIFile> root;
    MOZ_TRY(StartupConfiguredPath(prefs, branch, getter_AddRefs(root)));
    bool inside;
    MOZ_TRY(profile->Contains(root, &inside));
    NS_ENSURE_TRUE(inside, NS_ERROR_FILE_ACCESS_DENIED);
    nsTArray<nsCString> files;
    MOZ_TRY(StartupInventory(root, files, true, false));
    inventory.AppendElements(files);
    if (output) {
      StartupServerRoot binding;
      binding.key = Substring(branch, 12, branch.Length() - 13);
      MOZ_TRY(GetComparablePath(root, binding.path));
      MOZ_TRY(Preferences::GetCString(nsCString(branch + "type"_ns).get(),
                                      binding.protocol));
      Preferences::GetCString(nsCString(branch + "storeContractID"_ns).get(),
                              binding.contract);
      if (binding.contract.IsEmpty())
        binding.contract.AssignLiteral("@mozilla.org/msgstore/berkeleystore;1");
      if (binding.protocol != "none"_ns && binding.protocol != "imap"_ns) {
        NS_ENSURE_TRUE(files.IsEmpty(), NS_ERROR_NOT_IMPLEMENTED);
        continue;
      }
      NS_ENSURE_TRUE(
          binding.contract == "@mozilla.org/msgstore/berkeleystore;1"_ns ||
              binding.contract == "@mozilla.org/msgstore/maildirstore;1"_ns,
          NS_ERROR_NOT_IMPLEMENTED);
      output->AppendElement(std::move(binding));
    }
  }
  return NS_OK;
}
nsresult StartupStores(ProfileStartupOperation& operation,
                       const nsTArray<nsCString>& inventory,
                       const nsTHashSet<nsCString>& declared,
                       const nsTArray<nsCString>& cacheRoots = {}) {
  for (const auto& path : inventory) {
    if (declared.Contains(path)) continue;
    nsCOMPtr<nsIFile> file;
    MOZ_TRY(StartupContained(operation.profile, path, getter_AddRefs(file)));
    if (nsMsgLocalStoreUtils::nsShouldIgnoreFile(file)) continue;
    bool covered = false;
    for (const auto& source : operation.sources) {
      if (source.storePath == path) {
        covered = true;
        break;
      }
      nsCOMPtr<nsIFile> store;
      MOZ_TRY(NS_NewNativeLocalFile(source.storePath, getter_AddRefs(store)));
      bool directory, contains;
      MOZ_TRY(store->IsDirectory(&directory));
      if (!directory) continue;
      MOZ_TRY(store->Contains(file, &contains));
      covered |= contains;
    }
    auto created = operation.createdEmptyStores.Lookup(path);
    bool nativeEmpty = false;
    if (created) {
      for (const auto& rootPath : cacheRoots) {
        nsCOMPtr<nsIFile> root;
        MOZ_TRY(NS_NewNativeLocalFile(rootPath, getter_AddRefs(root)));
        bool contains;
        MOZ_TRY(root->Contains(file, &contains));
        nativeEmpty |= contains;
      }
      if (nativeEmpty) {
        int64_t size;
        MOZ_TRY(file->GetFileSize(&size));
        NS_ENSURE_TRUE(!size, NS_ERROR_NOT_AVAILABLE);
      }
    }
    NS_ENSURE_TRUE(covered || nativeEmpty, NS_ERROR_NOT_AVAILABLE);
    auto saved = operation.backupFiles.Lookup(path);
    NS_ENSURE_TRUE(saved || nativeEmpty, NS_ERROR_NOT_AVAILABLE);
    nsCString actual;
    MOZ_TRY(StartupHash(file, actual));
    NS_ENSURE_TRUE((saved && saved.Data() == actual) ||
                       (nativeEmpty && created.Data() == actual),
                   NS_ERROR_NOT_AVAILABLE);
  }
  return NS_OK;
}
nsresult StartupJournalFile(ProfileStartupOperation& operation,
                            const nsACString& path, nsIFile** output) {
  // This is the caller's fixed sibling work directory, not the selected profile
  // and not an arbitrary JSON path accepted from a script descriptor.
  nsCOMPtr<nsIFile> work;
  MOZ_TRY(operation.profile->GetParent(getter_AddRefs(work)));
  nsAutoCString leaf;
  MOZ_TRY(operation.profile->GetNativeLeafName(leaf));
  MOZ_TRY(work->AppendNative("panorama-migration-"_ns + leaf));
  nsAutoCString actual;
  MOZ_TRY(StartupDirectory(work, actual));
  nsCOMPtr<nsIFile> file;
  MOZ_TRY(StartupChild(work, "journal.json", getter_AddRefs(file)));
  MOZ_TRY(GetComparablePath(file, actual));
  NS_ENSURE_TRUE(path == actual, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(StartupRegular(file));
  file.forget(output);
  return NS_OK;
}
nsresult StartupBackup(JSContext* cx, ProfileStartupOperation& operation,
                       JS::Handle<JSObject*> backup) {
  nsCString path, expected, actual;
  MOZ_TRY(StartupText(cx, backup, "path", path));
  MOZ_TRY(StartupText(cx, backup, "sha256", expected));
  NS_ENSURE_TRUE(expected.Length() == 64, NS_ERROR_INVALID_ARG);
  nsCOMPtr<nsIFile> manifest;
  MOZ_TRY(NS_NewNativeLocalFile(path, getter_AddRefs(manifest)));
  MOZ_TRY(StartupHash(manifest, actual));
  NS_ENSURE_TRUE(actual == expected, NS_ERROR_NOT_AVAILABLE);
  JS::Rooted<JSObject*> record(cx), roots(cx);
  MOZ_TRY(StartupReadJSON(cx, manifest, &record));
  JS::Rooted<JS::Value> complete(cx);
  MOZ_TRY(ImportMember(cx, record, "complete", &complete));
  NS_ENSURE_TRUE(complete.isBoolean() && complete.toBoolean(),
                 NS_ERROR_NOT_AVAILABLE);
  int64_t version;
  MOZ_TRY(StartupNumber(cx, record, "version", 1, 3, version));
  uint32_t rootCount;
  MOZ_TRY(StartupArray(cx, record, "roots", &roots, rootCount));
  NS_ENSURE_TRUE(rootCount, NS_ERROR_FILE_CORRUPTED);
  nsCOMPtr<nsIFile> archive;
  MOZ_TRY(manifest->GetParent(getter_AddRefs(archive)));
#ifdef XP_WIN
  // Copies live below the fixed panorama-migration-<profile>\backup\root-N
  // prefix, longer than the profile's own, so a copy of a legacy file close to
  // MAX_PATH exceeds it. Read copies through the extended-length spelling;
  // clones and appended children keep it. Original paths stay plain, and the
  // JS backup writer admitted every copy component (no ".", "..", reparse).
  nsCOMPtr<nsILocalFileWin> longArchive = do_QueryInterface(archive);
  NS_ENSURE_TRUE(longArchive, NS_ERROR_UNEXPECTED);
  MOZ_TRY(longArchive->SetUseDOSDevicePathSyntax(true));
#endif
  for (uint32_t i = 0; i < rootCount; ++i) {
    JS::Rooted<JSObject*> root(cx), entries(cx), entry(cx), parts(cx);
    MOZ_TRY(StartupItem(cx, roots, i, &root));
    nsCString source, leaf;
    MOZ_TRY(StartupText(cx, root, "source", source));
    MOZ_TRY(StartupText(cx, root, "directory", leaf));
    NS_ENSURE_TRUE(leaf.Equals("root-"_ns + nsPrintfCString("%u", i)),
                   NS_ERROR_FILE_CORRUPTED);
    nsCOMPtr<nsIFile> original, copy;
    MOZ_TRY(NS_NewNativeLocalFile(source, getter_AddRefs(original)));
    bool same, contained;
    MOZ_TRY(operation.profile->Equals(original, &same));
    MOZ_TRY(operation.profile->Contains(original, &contained));
    NS_ENSURE_TRUE((i == 0 && same) || (i > 0 && contained),
                   NS_ERROR_FILE_ACCESS_DENIED);
    MOZ_TRY(StartupChild(archive, leaf.get(), getter_AddRefs(copy)));
    uint32_t count;
    MOZ_TRY(StartupArray(cx, root, "entries", &entries, count));
    nsTHashSet<nsCString> seen;
    for (uint32_t j = 0; j < count; ++j) {
      MOZ_TRY(StartupItem(cx, entries, j, &entry));
      uint32_t partCount;
      MOZ_TRY(StartupArray(cx, entry, "parts", &parts, partCount));
      nsCOMPtr<nsIFile> destination, originalEntry;
      MOZ_TRY(copy->Clone(getter_AddRefs(destination)));
      MOZ_TRY(original->Clone(getter_AddRefs(originalEntry)));
      nsAutoCString key;
      for (uint32_t k = 0; k < partCount; ++k) {
        JS::Rooted<JS::Value> value(cx);
        NS_ENSURE_TRUE(JS_GetElement(cx, parts, k, &value), NS_ERROR_FAILURE);
        nsCString part;
        MOZ_TRY(ImportText(cx, value, part));
        NS_ENSURE_TRUE(!part.IsEmpty() && part != "."_ns && part != ".."_ns &&
                           part.FindChar('/') < 0 && part.FindChar('\\') < 0 &&
                           part.FindChar(0) < 0,
                       NS_ERROR_FILE_INVALID_PATH);
        MOZ_TRY(destination->AppendNative(part));
        MOZ_TRY(originalEntry->AppendNative(part));
        key.Append('/');
        key.Append(part);
      }
      NS_ENSURE_FALSE(seen.Contains(key), NS_ERROR_FILE_CORRUPTED);
      seen.Insert(key);
      nsCString type;
      MOZ_TRY(StartupText(cx, entry, "type", type));
      if (type == "directory"_ns) {
        nsAutoCString actualPath;
        MOZ_TRY(StartupDirectory(destination, actualPath));
      } else {
        NS_ENSURE_TRUE(type == "regular"_ns, NS_ERROR_FILE_CORRUPTED);
        nsCString expectedHash, copyHash;
        MOZ_TRY(StartupText(cx, entry, "sha256", expectedHash));
        MOZ_TRY(StartupHash(destination, copyHash));
        NS_ENSURE_TRUE(copyHash == expectedHash, NS_ERROR_NOT_AVAILABLE);
        int64_t size, actualSize;
        MOZ_TRY(StartupNumber(cx, entry, "size", 0, UINT32_MAX - 1, size));
        MOZ_TRY(destination->GetFileSize(&actualSize));
        NS_ENSURE_TRUE(size == actualSize, NS_ERROR_NOT_AVAILABLE);
        nsCString originalPath;
        MOZ_TRY(GetComparablePath(originalEntry, originalPath));
        if (auto prior = operation.backupFiles.Lookup(originalPath))
          NS_ENSURE_TRUE(prior.Data() == expectedHash, NS_ERROR_NOT_AVAILABLE);
        operation.backupFiles.InsertOrUpdate(originalPath, expectedHash);
        operation.backupCopies.InsertOrUpdate(originalPath, destination);
      }
    }
  }
  MOZ_TRY(StartupHash(manifest, actual));
  NS_ENSURE_TRUE(actual == expected, NS_ERROR_NOT_AVAILABLE);
  operation.backupPath = path;
  operation.backupHash = expected;
  return NS_OK;
}
}  // namespace

namespace {

nsresult StartupModuleCall(JSContext* cx, const nsAString& uri,
                           const char* method, JS::HandleValueArray arguments,
                           JS::MutableHandle<JS::Value> result) {
  JS::Rooted<JSObject*> module(cx), global(cx, JS::CurrentGlobalOrNull(cx));
  dom::GlobalObject caller(cx, global);
  ErrorResult error;
  dom::ChromeUtils::ImportESModule(
      caller, uri, dom::ImportESModuleOptionsDictionary(), &module, error);
  if (error.Failed()) return error.StealNSResult();
  JS::Rooted<JS::Value> function(cx);
  NS_ENSURE_TRUE(JS_GetProperty(cx, module, method, &function) &&
                     JS::Call(cx, module, function, arguments, result),
                 NS_ERROR_FAILURE);
  return NS_OK;
}
// The published book is a byte copy of its stage, so on Windows it has its own
// file ID but retains the stage's migration_file_identity pin. Its Windows
// readback therefore compares that pin with the journal receipt's
// stagePhysicalIdentity, as AddrBookManager does for the same copy; it still
// re-admits the target itself (no reparse/offline component).
nsresult StartupBookReadback(JSContext* cx, nsIFile* target, nsIFile* source,
                             const nsACString& token,
                             JS::Handle<JSObject*> stageIdentity,
                             JS::MutableHandle<JS::Value> output) {
  nsCString bytes;
  MOZ_TRY(StartupRead(source, bytes));
  JS::Rooted<JSObject*> buffer(cx, JS_NewUint8Array(cx, bytes.Length()));
  NS_ENSURE_TRUE(buffer, NS_ERROR_OUT_OF_MEMORY);
  {
    JS::AutoCheckCannotGC nogc;
    bool shared;
    memcpy(JS_GetUint8ArrayData(buffer, &shared, nogc), bytes.BeginReading(),
           bytes.Length());
  }
  JS::Rooted<JSObject*> module(cx), global(cx, JS::CurrentGlobalOrNull(cx));
  dom::GlobalObject caller(cx, global);
  ErrorResult error;
  dom::ChromeUtils::ImportESModule(
      caller, u"resource:///modules/SQLiteDirectory.sys.mjs"_ns,
      dom::ImportESModuleOptionsDictionary(), &module, error);
  if (error.Failed()) return error.StealNSResult();
  JS::Rooted<JS::Value> type(cx), method(cx);
  NS_ENSURE_TRUE(
      JS_GetProperty(cx, module, "SQLiteDirectory", &type) && type.isObject(),
      NS_ERROR_FAILURE);
  JS::Rooted<JSObject*> directory(cx, &type.toObject());
  NS_ENSURE_TRUE(
      JS_GetProperty(cx, directory, "validateMigrationBook", &method),
      NS_ERROR_FAILURE);
  JS::RootedValueArray<4> arguments(cx);
  MOZ_TRY(nsContentUtils::WrapNative(cx, target, &NS_GET_IID(nsIFile),
                                     arguments[0]));
  arguments[1].setObject(*buffer);
  JS::Rooted<JSString*> storage(
      cx, JS_NewStringCopyN(cx, token.BeginReading(), token.Length()));
  JS::Rooted<JSObject*> options(cx, JS_NewPlainObject(cx));
  NS_ENSURE_TRUE(storage && options &&
                     JS_DefineProperty(cx, options, "requireClosed", false,
                                       JSPROP_ENUMERATE),
                 NS_ERROR_OUT_OF_MEMORY);
  if (stageIdentity) {
    NS_ENSURE_TRUE(JS_DefineProperty(cx, options, "stageIdentity",
                                     stageIdentity, JSPROP_ENUMERATE),
                   NS_ERROR_OUT_OF_MEMORY);
  }
  arguments[2].setString(storage);
  arguments[3].setObject(*options);
  NS_ENSURE_TRUE(
      JS::Call(cx, directory, method, arguments, output) && output.isObject(),
      NS_ERROR_FAILURE);
  return NS_OK;
}
// Check the immutable import receipt on reuse, allowing ordinary book edits.
nsresult StartupStoredBookReceipt(JSContext* cx, nsIFile* file,
                                  JS::MutableHandle<JS::Value> output) {
  MOZ_TRY(StartupRegular(file));
  nsCOMPtr<mozIStorageService> storage =
      do_GetService("@mozilla.org/storage/service;1");
  NS_ENSURE_TRUE(storage, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<mozIStorageConnection> connection;
  nsCOMPtr<nsIURI> uri;
  MOZ_TRY(NS_NewFileURI(getter_AddRefs(uri), file));
  nsAutoCString spec;
  MOZ_TRY(uri->GetSpec(spec));
  spec.AppendLiteral("?mode=ro");
  MOZ_TRY(NS_NewURI(getter_AddRefs(uri), spec));
  nsCOMPtr<nsIFileURL> url = do_QueryInterface(uri);
  NS_ENSURE_TRUE(url, NS_ERROR_UNEXPECTED);
  MOZ_TRY(storage->OpenDatabaseWithFileURL(
      url, "panorama-import-book.sqlite"_ns,
      mozIStorageService::CONNECTION_DEFAULT, getter_AddRefs(connection)));
  JS::Rooted<JSObject*> result(cx, JS_NewPlainObject(cx));
  auto read = [&]() -> nsresult {
    MOZ_TRY(connection->ExecuteSimpleSQL("PRAGMA query_only=ON"_ns));
    int32_t version;
    MOZ_TRY(connection->GetSchemaVersion(&version));
    NS_ENSURE_TRUE(version == 4 && result, NS_ERROR_NOT_AVAILABLE);
    for (const char* name :
         {"migration_source", "migration_records", "migration_properties"}) {
      bool exists;
      MOZ_TRY(connection->TableExists(nsDependentCString(name), &exists));
      NS_ENSURE_TRUE(exists, NS_ERROR_NOT_AVAILABLE);
    }
    nsCOMPtr<mozIStorageStatement> source;
    MOZ_TRY(connection->CreateStatement(
        "SELECT sourceId,sha256,size,bytes FROM migration_source WHERE version=1"_ns,
        getter_AddRefs(source)));
    bool row;
    MOZ_TRY(source->ExecuteStep(&row));
    NS_ENSURE_TRUE(row, NS_ERROR_FILE_CORRUPTED);
    for (uint32_t i : {0u, 1u, 2u, 3u}) {
      int32_t type;
      MOZ_TRY(source->GetTypeOfIndex(i, &type));
      NS_ENSURE_TRUE(
          type == (i < 2    ? mozIStorageStatement::VALUE_TYPE_TEXT
                   : i == 2 ? mozIStorageStatement::VALUE_TYPE_INTEGER
                            : mozIStorageStatement::VALUE_TYPE_BLOB),
          NS_ERROR_FILE_CORRUPTED);
    }
    nsCString token, expected;
    int64_t size;
    MOZ_TRY(source->GetUTF8String(0, token));
    MOZ_TRY(source->GetUTF8String(1, expected));
    MOZ_TRY(source->GetInt64(2, &size));
    uint32_t length;
    uint8_t* bytes = nullptr;
    MOZ_TRY(source->GetBlob(3, &length, &bytes));
    auto release = MakeScopeExit([&] { std::free(bytes); });
    NS_ENSURE_TRUE(size >= 0 && uint64_t(size) == length && !token.IsEmpty(),
                   NS_ERROR_FILE_CORRUPTED);
    nsCOMPtr<nsICryptoHash> hash;
    MOZ_TRY(NS_NewCryptoHash(nsICryptoHash::SHA256, getter_AddRefs(hash)));
    if (length) MOZ_TRY(hash->Update(bytes, length));
    nsCString digest, actual;
    MOZ_TRY(hash->Finish(false, digest));
    for (unsigned char c : digest.View()) {
      actual.Append("0123456789abcdef"[c >> 4]);
      actual.Append("0123456789abcdef"[c & 15]);
    }
    NS_ENSURE_TRUE(actual == expected, NS_ERROR_FILE_CORRUPTED);
    MOZ_TRY(source->ExecuteStep(&row));
    NS_ENSURE_FALSE(row, NS_ERROR_FILE_CORRUPTED);
    source = nullptr;
    NS_ENSURE_TRUE(ImapImportText(cx, result, "sourceId", token) &&
                       ImapImportText(cx, result, "sourceSha256", actual) &&
                       JS_DefineProperty(cx, result, "sourceSize",
                                         double(length), JSPROP_ENUMERATE),
                   NS_ERROR_OUT_OF_MEMORY);
    nsTHashSet<nsCString> uids;
    for (const char* kind : {"card", "list"}) {
      nsCOMPtr<mozIStorageStatement> records;
      MOZ_TRY(connection->CreateStatement(
          "SELECT sourceKey,uid FROM migration_records WHERE kind=:kind ORDER BY CAST(sourceKey AS INTEGER)"_ns,
          getter_AddRefs(records)));
      MOZ_TRY(
          records->BindUTF8StringByName("kind"_ns, nsDependentCString(kind)));
      JS::Rooted<JSObject*> map(cx, JS::NewArrayObject(cx, 0));
      NS_ENSURE_TRUE(map, NS_ERROR_OUT_OF_MEMORY);
      uint32_t ordinal = 0;
      nsTHashSet<uint32_t> keys;
      while (true) {
        MOZ_TRY(records->ExecuteStep(&row));
        if (!row) break;
        for (uint32_t c : {0u, 1u}) {
          int32_t type;
          MOZ_TRY(records->GetTypeOfIndex(c, &type));
          NS_ENSURE_TRUE(type == mozIStorageStatement::VALUE_TYPE_TEXT,
                         NS_ERROR_FILE_CORRUPTED);
        }
        nsCString key, uid;
        MOZ_TRY(records->GetUTF8String(0, key));
        MOZ_TRY(records->GetUTF8String(1, uid));
        uint32_t number;
        auto parsed =
            std::from_chars(key.BeginReading(), key.EndReading(), number);
        nsAutoCString canonical;
        if (parsed.ec == std::errc()) canonical.AppendInt(number);
        NS_ENSURE_TRUE(!key.IsEmpty() && parsed.ec == std::errc() &&
                           parsed.ptr == key.EndReading() && canonical == key &&
                           !uid.IsEmpty() && !keys.Contains(number) &&
                           !uids.Contains(uid),
                       NS_ERROR_FILE_CORRUPTED);
        keys.Insert(number);
        uids.Insert(uid);
        JS::Rooted<JSObject*> pair(cx, JS::NewArrayObject(cx, 2));
        JS::Rooted<JSString*> text(
            cx,
            JS_NewStringCopyUTF8N(cx, JS::UTF8Chars(uid.get(), uid.Length())));
        NS_ENSURE_TRUE(
            pair && text &&
                JS_DefineElement(cx, pair, 0, double(number),
                                 JSPROP_ENUMERATE) &&
                JS_DefineElement(cx, pair, 1, text, JSPROP_ENUMERATE) &&
                JS_DefineElement(cx, map, ordinal++, pair, JSPROP_ENUMERATE),
            NS_ERROR_OUT_OF_MEMORY);
      }
      NS_ENSURE_TRUE(JS_DefineProperty(
                         cx, result, !strcmp(kind, "card") ? "cards" : "lists",
                         map, JSPROP_ENUMERATE),
                     NS_ERROR_OUT_OF_MEMORY);
    }
    return NS_OK;
  };
  nsresult first = read();
  nsresult closed = connection->Close();
  MOZ_TRY(first);
  MOZ_TRY(closed);
  output.setObject(*result);
  return NS_OK;
}

nsresult StartupCopy(JSContext* cx, JS::Handle<JSObject*> from,
                     JS::Handle<JSObject*> to, const char* name,
                     const char* outputName = nullptr) {
  JS::Rooted<JS::Value> value(cx);
  MOZ_TRY(ImportMember(cx, from, name, &value));
  NS_ENSURE_TRUE(JS_DefineProperty(cx, to, outputName ? outputName : name,
                                   value, JSPROP_ENUMERATE),
                 NS_ERROR_OUT_OF_MEMORY);
  return NS_OK;
}
nsresult StartupFieldsEqual(JSContext* cx, JS::Handle<JSObject*> left,
                            JS::Handle<JSObject*> right,
                            std::initializer_list<const char*> names) {
  for (const char* name : names) {
    JS::Rooted<JS::Value> a(cx), b(cx);
    MOZ_TRY(ImportMember(cx, left, name, &a));
    MOZ_TRY(ImportMember(cx, right, name, &b));
    MOZ_TRY(StartupEqual(cx, a, b));
  }
  return NS_OK;
}
#ifdef XP_WIN
// A Windows startup source retains its committed version2 receipt, including
// the measured original/canonical summary and store admission. Activation
// re-admits exactly those paths and IDs (FolderImportAdmission); reuse only
// compares them with the durable folder_import_windows row.
nsresult StartupWindowsImportIdentity(JSContext* cx,
                                      JS::Handle<JSObject*> source,
                                      FolderImportIdentity& identity) {
  JS::Rooted<JSObject*> receipt(cx), admission(cx);
  MOZ_TRY(StartupObject(cx, source, "receipt", &receipt));
  MOZ_TRY(StartupObject(cx, receipt, "windowsAdmission", &admission));
  FolderImportWindowsIdentity paths;
  for (auto pair :
       {std::pair{"summary", &paths.summary}, {"store", &paths.store}}) {
    JS::Rooted<JSObject*> path(cx);
    MOZ_TRY(StartupObject(cx, admission, pair.first, &path));
    MOZ_TRY(ImportOriginalPath(cx, path, *pair.second));
    for (auto field : {std::pair{"canonicalPath", &pair.second->canonicalPath},
                       {"canonicalRoot", &pair.second->canonicalRoot}}) {
      nsCString utf8;
      MOZ_TRY(StartupText(cx, path, field.first, utf8));
      NS_ENSURE_TRUE(!utf8.IsEmpty() && utf8.FindChar(0) < 0,
                     NS_ERROR_FILE_CORRUPTED);
      CopyUTF8toUTF16(utf8, *field.second);
    }
  }
  NS_ENSURE_TRUE(!paths.summary.id.IsEmpty() &&
                     paths.summary.canonicalPath == identity.sourcePath,
                 NS_ERROR_NOT_AVAILABLE);
  identity.windows = Some(std::move(paths));
  return NS_OK;
}
#endif
nsresult StartupParseFile(JSContext* cx, nsIFile* file, const nsAString& module,
                          const char* parser,
                          JS::MutableHandle<JSObject*> result) {
  nsCString bytes;
  MOZ_TRY(StartupRead(file, bytes));
  JS::Rooted<JSObject*> buffer(cx, JS_NewUint8Array(cx, bytes.Length()));
  NS_ENSURE_TRUE(buffer, NS_ERROR_OUT_OF_MEMORY);
  {
    JS::AutoCheckCannotGC nogc;
    bool shared;
    memcpy(JS_GetUint8ArrayData(buffer, &shared, nogc), bytes.BeginReading(),
           bytes.Length());
  }
  JS::Rooted<JS::Value> argument(cx, JS::ObjectValue(*buffer)), value(cx);
  MOZ_TRY(StartupModuleCall(cx, module, parser, JS::HandleValueArray(argument),
                            &value));
  NS_ENSURE_TRUE(value.isObject(), NS_ERROR_FILE_CORRUPTED);
  result.set(&value.toObject());
  return NS_OK;
}
nsresult StartupMapEntry(JSContext* cx, JS::Handle<JSObject*> parent,
                         const char* name, const nsACString& key,
                         JS::MutableHandle<JS::Value> output,
                         bool optional = false) {
  JS::Rooted<JSObject*> map(cx);
  MOZ_TRY(StartupObject(cx, parent, name, &map));
  JS::Rooted<JSString*> string(
      cx, JS_NewStringCopyUTF8N(
              cx, JS::UTF8Chars(key.BeginReading(), key.Length())));
  NS_ENSURE_TRUE(string, NS_ERROR_OUT_OF_MEMORY);
  JS::Rooted<JS::Value> mapKey(cx, JS::StringValue(string));
  NS_ENSURE_TRUE(JS::MapGet(cx, map, mapKey, output), NS_ERROR_FAILURE);
  NS_ENSURE_TRUE(optional || !output.isUndefined(), NS_ERROR_NOT_AVAILABLE);
  return NS_OK;
}
nsresult StartupCheckHash(nsIFile* file, const nsACString& expected,
                          uint64_t expectedSize) {
  int64_t size;
  MOZ_TRY(file->GetFileSize(&size));
  NS_ENSURE_TRUE(size >= 0 && uint64_t(size) == expectedSize,
                 NS_ERROR_NOT_AVAILABLE);
  nsAutoCString actual;
  MOZ_TRY(StartupHash(file, actual));
  return actual == expected ? NS_OK : NS_ERROR_NOT_AVAILABLE;
}
// A server's sibling summary is metadata, never a synthetic message folder.
// Its entire original document remains in the verified backup and inventory.
nsresult StartupServerSummaryInput(JSContext* cx, JS::Handle<JSObject*> source,
                                   ProfileStartupOperation& operation,
                                   StartupServerSummary& output,
                                   bool historical = false) {
  nsCString role, protocol;
  MOZ_TRY(StartupText(cx, source, "role", role));
  MOZ_TRY(StartupText(cx, source, "protocol", protocol));
  NS_ENSURE_TRUE(role == "imap-server-root-summary"_ns && protocol == "imap"_ns,
                 NS_ERROR_NOT_IMPLEMENTED);
  for (auto entry : {std::pair{"id", &output.id},
                     {"path", &output.path},
                     {"sha256", &output.hash},
                     {"serverKey", &output.serverKey},
                     {"serverRoot", &output.serverRoot},
                     {"storeContractID", &output.storeContract},
                     {"storeType", &output.storeType}}) {
    MOZ_TRY(StartupText(cx, source, entry.first, *entry.second));
    NS_ENSURE_FALSE(entry.second->IsEmpty(), NS_ERROR_INVALID_ARG);
  }
  NS_ENSURE_TRUE(
      output.serverKey.FindChar('.') < 0 &&
          output.path.Equals(output.serverRoot + ".msf"_ns) &&
          ((output.storeType == "mbox"_ns &&
            output.storeContract ==
                "@mozilla.org/msgstore/berkeleystore;1"_ns) ||
           (output.storeType == "maildir"_ns &&
            output.storeContract == "@mozilla.org/msgstore/maildirstore;1"_ns)),
      NS_ERROR_NOT_AVAILABLE);
  int64_t size;
  MOZ_TRY(StartupNumber(cx, source, "size", 1, UINT32_MAX - 1, size));
  output.size = size;
  nsCOMPtr<nsIFile> original;
  MOZ_TRY(NS_NewNativeLocalFile(output.path, getter_AddRefs(original)));
  nsCString literal, relative;
  MOZ_TRY(GetComparablePath(original, literal));
  bool inside;
  MOZ_TRY(operation.profile->Contains(original, &inside));
  MOZ_TRY(original->GetRelativePath(operation.profile, relative));
  NS_ENSURE_TRUE(inside && literal == output.path &&
                     output.id.Equals("server-summary:"_ns + relative),
                 NS_ERROR_FILE_ACCESS_DENIED);
  if (historical) {
    // The unchanged selected/journal bindings and native root identity are
    // checked by CheckProfileActivation. This old metadata no longer imports
    // anything; do not reopen its archived Mork document on ordinary reuse.
    NS_ENSURE_TRUE(output.hash.Length() == 64, NS_ERROR_NOT_AVAILABLE);
    for (char c : output.hash.View())
      NS_ENSURE_TRUE((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'),
                     NS_ERROR_NOT_AVAILABLE);
    return NS_OK;
  }
  if (!historical) {
    uint32_t matches = 0;
    for (const auto& server : operation.servers) {
      nsCOMPtr<nsIFile> root;
      MOZ_TRY(NS_NewNativeLocalFile(server.path, getter_AddRefs(root)));
      bool contains;
      MOZ_TRY(root->Contains(original, &contains));
      // A summary inside another server's tree has an ambiguous role.
      NS_ENSURE_FALSE(contains, NS_ERROR_NOT_AVAILABLE);
      if (server.path == output.serverRoot) {
        NS_ENSURE_TRUE(server.key == output.serverKey &&
                           server.protocol == protocol &&
                           server.contract == output.storeContract,
                       NS_ERROR_NOT_AVAILABLE);
        ++matches;
      }
    }
    NS_ENSURE_TRUE(matches == 1, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(StartupCheckHash(original, output.hash, output.size));
  }
  auto archived = operation.backupFiles.Lookup(output.path);
  auto copy = operation.backupCopies.Lookup(output.path);
  NS_ENSURE_TRUE(archived && archived.Data() == output.hash && copy,
                 NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIFile> retained = historical ? copy.Data() : original;
  MOZ_TRY(StartupCheckHash(retained, output.hash, output.size));
  JS::Rooted<JSObject*> parsed(cx), originalData(cx), rows(cx), tables(cx),
      messages(cx), info(cx);
  MOZ_TRY(StartupParseFile(
      cx, retained,
      u"resource:///modules/panorama/MorkSummaryReader.sys.mjs"_ns,
      "parseMorkSummary", &parsed));
  uint32_t count;
  MOZ_TRY(StartupArray(cx, parsed, "messages", &messages, count));
  NS_ENSURE_TRUE(!count, NS_ERROR_NOT_IMPLEMENTED);
  MOZ_TRY(StartupObject(cx, parsed, "source", &originalData));
  MOZ_TRY(StartupObject(cx, originalData, "rows", &rows));
  // Check every original row, including detached or hidden operations.
  NS_ENSURE_TRUE(JS::MapSize(cx, rows) == 1, NS_ERROR_NOT_IMPLEMENTED);
  JS::Rooted<JS::Value> value(cx);
  NS_ENSURE_TRUE(JS::MapValues(cx, rows, &value), NS_ERROR_FAILURE);
  JS::ForOfIterator rowIterator(cx);
  NS_ENSURE_TRUE(rowIterator.init(value), NS_ERROR_FAILURE);
  bool done;
  NS_ENSURE_TRUE(rowIterator.next(&value, &done) && !done && value.isObject(),
                 NS_ERROR_FILE_CORRUPTED);
  info = &value.toObject();
  nsCString scope;
  MOZ_TRY(StartupText(cx, info, "scope", scope));
  NS_ENSURE_TRUE(scope == "ns:msg:db:row:scope:dbfolderinfo:all"_ns,
                 NS_ERROR_NOT_IMPLEMENTED);
  JS::Rooted<JSObject*> cells(cx);
  MOZ_TRY(StartupObject(cx, info, "cells", &cells));
  NS_ENSURE_TRUE(JS::MapKeys(cx, cells, &value), NS_ERROR_FAILURE);
  JS::ForOfIterator cellIterator(cx);
  NS_ENSURE_TRUE(cellIterator.init(value), NS_ERROR_FAILURE);
  while (true) {
    NS_ENSURE_TRUE(cellIterator.next(&value, &done), NS_ERROR_FAILURE);
    if (done) break;
    nsCString name;
    MOZ_TRY(ImportText(cx, value, name));
    // Only the native folder-info metadata role is understood. Unknown cells
    // may carry state that an empty message table alone cannot account for.
    bool supported = false;
    for (const char* known :
         {"version", "flags", "folderName", "mailboxName", "folderDate",
          "forceReparse", "fixedBadRefThreading", "numMsgs", "numNewMsgs",
          "totPendingMsgs", "unreadPendingMsgs", "expungedBytes", "folderSize",
          "highWaterKey", "UIDValidity"}) {
      supported |= name.Equals(known);
    }
    if (name == "onlineName"_ns) {
      // SetOnlineName persists this literal empty cell on the IMAP server
      // root. A nonempty name denotes a mailbox, not this metadata-only role.
      JS::Rooted<JS::Value> originalName(cx);
      MOZ_TRY(StartupMapEntry(cx, info, "cells", name, &originalName));
      nsCString text;
      MOZ_TRY(ImportText(cx, originalName, text));
      NS_ENSURE_TRUE(text.IsEmpty(), NS_ERROR_NOT_IMPLEMENTED);
      supported = true;
    }
    NS_ENSURE_TRUE(supported, NS_ERROR_NOT_IMPLEMENTED);
  }
  for (const char* name : {"numMsgs", "numNewMsgs", "totPendingMsgs",
                           "unreadPendingMsgs", "expungedBytes", "folderSize",
                           "highWaterKey", "UIDValidity", "forceReparse"}) {
    MOZ_TRY(StartupMapEntry(cx, info, "cells", nsDependentCString(name), &value,
                            true));
    if (value.isUndefined()) continue;
    nsCString text;
    uint64_t number;
    MOZ_TRY(ImportText(cx, value, text));
    MOZ_TRY(ImportHex(text, 16, number));
    NS_ENSURE_TRUE(!number, NS_ERROR_NOT_IMPLEMENTED);
  }
  MOZ_TRY(StartupMapEntry(cx, info, "cells", "flags"_ns, &value, true));
  if (!value.isUndefined()) {
    nsCString text;
    uint64_t flags;
    MOZ_TRY(ImportText(cx, value, text));
    MOZ_TRY(ImportHex(text, 8, flags));
    NS_ENSURE_FALSE(
        flags & (nsMsgFolderFlags::OfflineEvents | nsMsgFolderFlags::Virtual |
                 nsMsgFolderFlags::Newsgroup),
        NS_ERROR_NOT_IMPLEMENTED);
  }
  MOZ_TRY(StartupObject(cx, originalData, "tables", &tables));
  NS_ENSURE_TRUE(JS::MapValues(cx, tables, &value), NS_ERROR_FAILURE);
  JS::ForOfIterator tableIterator(cx);
  NS_ENSURE_TRUE(tableIterator.init(value), NS_ERROR_FAILURE);
  bool seenInfo = false, seenMessages = false, seenThreads = false;
  while (true) {
    NS_ENSURE_TRUE(tableIterator.next(&value, &done), NS_ERROR_FAILURE);
    if (done) break;
    NS_ENSURE_TRUE(value.isObject(), NS_ERROR_FILE_CORRUPTED);
    JS::Rooted<JSObject*> table(cx, &value.toObject()), members(cx);
    MOZ_TRY(StartupText(cx, table, "scope", scope));
    MOZ_TRY(StartupArray(cx, table, "rows", &members, count));
    JS::Rooted<JS::Value> meta(cx), kindValue(cx);
    MOZ_TRY(ImportMember(cx, table, "metaRow", &meta));
    NS_ENSURE_TRUE(meta.isNull(), NS_ERROR_NOT_IMPLEMENTED);
    MOZ_TRY(StartupMapEntry(cx, table, "cells", "k"_ns, &kindValue));
    nsCString kind;
    MOZ_TRY(ImportText(cx, kindValue, kind));
    if (scope == "ns:msg:db:row:scope:dbfolderinfo:all"_ns &&
        kind == "ns:msg:db:table:kind:dbfolderinfo"_ns) {
      NS_ENSURE_TRUE(!seenInfo && count == 1, NS_ERROR_NOT_IMPLEMENTED);
      seenInfo = true;
      JS::Rooted<JS::Value> key(cx), row(cx);
      NS_ENSURE_TRUE(JS_GetElement(cx, members, 0, &key) &&
                         JS::MapGet(cx, rows, key, &row) && row.isObject() &&
                         &row.toObject() == info.get(),
                     NS_ERROR_FILE_CORRUPTED);
    } else if (scope == "ns:msg:db:row:scope:msgs:all"_ns &&
               kind == "ns:msg:db:table:kind:msgs"_ns) {
      NS_ENSURE_TRUE(!seenMessages && !count, NS_ERROR_NOT_IMPLEMENTED);
      seenMessages = true;
    } else if (scope == "ns:msg:db:row:scope:threads:all"_ns &&
               kind == "ns:msg:db:table:kind:allthreads"_ns) {
      NS_ENSURE_TRUE(!seenThreads && !count, NS_ERROR_NOT_IMPLEMENTED);
      seenThreads = true;
    } else {
      return NS_ERROR_NOT_IMPLEMENTED;
    }
  }
  NS_ENSURE_TRUE(seenInfo && seenMessages, NS_ERROR_NOT_IMPLEMENTED);
  return StartupCheckHash(retained, output.hash, output.size);
}

}  // namespace

nsresult DatabaseCore::ReadStartupMailSource(JSContext* cx,
                                             JS::Handle<JSObject*> source,
                                             ProfileStartupOperation& operation,
                                             StartupMailSource& output) {
  for (auto entry : {std::pair{"id", &output.id},
                     {"path", &output.path},
                     {"sha256", &output.hash},
                     {"storePath", &output.storePath},
                     {"serverKey", &output.serverKey},
                     {"serverRoot", &output.serverRoot},
                     {"storeContractID", &output.storeContract},
                     {"protocol", &output.protocol}}) {
    MOZ_TRY(StartupText(cx, source, entry.first, *entry.second));
    NS_ENSURE_FALSE(entry.second->IsEmpty(), NS_ERROR_INVALID_ARG);
  }
  NS_ENSURE_TRUE(
      output.serverKey.FindChar('.') < 0 &&
          output.path.Equals(output.storePath + ".msf"_ns) &&
          (output.protocol == "none"_ns || output.protocol == "imap"_ns),
      NS_ERROR_NOT_IMPLEMENTED);
  int64_t size;
  MOZ_TRY(StartupNumber(cx, source, "size", 1, UINT32_MAX - 1, size));
  output.size = size;
  nsCOMPtr<nsIFile> file, root, storedRoot;
  MOZ_TRY(
      StartupContained(operation.profile, output.path, getter_AddRefs(file)));
  MOZ_TRY(StartupCheckHash(file, output.hash, output.size));
  MOZ_TRY(NS_NewNativeLocalFile(output.serverRoot, getter_AddRefs(root)));
  nsAutoCString normalized;
  MOZ_TRY(StartupDirectory(root, normalized));
  NS_ENSURE_TRUE(normalized == output.serverRoot, NS_ERROR_FILE_INVALID_PATH);
  bool contains;
  MOZ_TRY(root->Contains(file, &contains));
  NS_ENSURE_TRUE(contains, NS_ERROR_FILE_ACCESS_DENIED);
  nsCOMPtr<nsIPrefBranch> prefs =
      do_GetService("@mozilla.org/preferences-service;1");
  NS_ENSURE_TRUE(prefs, NS_ERROR_NOT_AVAILABLE);
  nsCString branch("mail.server."_ns + output.serverKey + "."_ns);
  bool relative;
  MOZ_TRY(prefs->PrefHasUserValue(nsCString(branch + "directory-rel"_ns).get(),
                                  &relative));
  if (relative) {
    nsCOMPtr<nsIRelativeFilePref> pref;
    MOZ_TRY(prefs->GetComplexValue(nsCString(branch + "directory-rel"_ns).get(),
                                   NS_GET_IID(nsIRelativeFilePref),
                                   getter_AddRefs(pref)));
    MOZ_TRY(pref->GetFile(getter_AddRefs(storedRoot)));
  } else {
    MOZ_TRY(prefs->GetComplexValue(nsCString(branch + "directory"_ns).get(),
                                   NS_GET_IID(nsIFile),
                                   getter_AddRefs(storedRoot)));
  }
  bool same;
  MOZ_TRY(root->Equals(storedRoot, &same));
  NS_ENSURE_TRUE(same, NS_ERROR_NOT_AVAILABLE);
  nsCString protocol, contract;
  MOZ_TRY(
      Preferences::GetCString(nsCString(branch + "type"_ns).get(), protocol));
  Preferences::GetCString(nsCString(branch + "storeContractID"_ns).get(),
                          contract);
  if (contract.IsEmpty())
    contract.AssignLiteral("@mozilla.org/msgstore/berkeleystore;1");
  NS_ENSURE_TRUE(protocol == output.protocol &&
                     contract == output.storeContract &&
                     (contract == "@mozilla.org/msgstore/berkeleystore;1"_ns ||
                      contract == "@mozilla.org/msgstore/maildirstore;1"_ns),
                 NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(
      CheckStartupMailStore(output.storePath, contract, protocol == "imap"_ns));
  const bool directory = contract == "@mozilla.org/msgstore/maildirstore;1"_ns;
  nsCString storeType;
  MOZ_TRY(StartupText(cx, source, "storeType", storeType));
  NS_ENSURE_TRUE(storeType == (directory ? "maildir"_ns : "mbox"_ns),
                 NS_ERROR_INVALID_ARG);
  JS::Rooted<JSObject*> origin(cx);
  MOZ_TRY(StartupObject(cx, source, "origin", &origin));
  nsCString provider;
  MOZ_TRY(StartupText(cx, origin, "provider", provider));
  nsAutoCString relativePath;
  MOZ_TRY(file->GetRelativePath(root, relativePath));
  nsCString retainedRelative;
  MOZ_TRY(StartupText(cx, source, "physicalRelativePath", retainedRelative));
  NS_ENSURE_TRUE(relativePath == retainedRelative, NS_ERROR_NOT_AVAILABLE);
  if (protocol == "none"_ns) {
    NS_ENSURE_TRUE(provider == "local-store-discovery"_ns,
                   NS_ERROR_INVALID_ARG);
    nsCCharSeparatedTokenizer parts(relativePath, '/');
    while (parts.hasMoreTokens()) {
      nsCString part(parts.nextToken());
      bool last = !parts.hasMoreTokens();
      NS_ENSURE_TRUE(StringEndsWith(part, last ? ".msf"_ns : ".sbd"_ns),
                     NS_ERROR_NOT_AVAILABLE);
      part.Truncate(part.Length() - 4);
      NS_ENSURE_TRUE(!part.IsEmpty() && part != "."_ns && part != ".."_ns &&
                         part.FindChar(0) < 0,
                     NS_ERROR_FILE_INVALID_PATH);
      output.localLeaves.AppendElement(part);
    }
    NS_ENSURE_FALSE(output.localLeaves.IsEmpty(), NS_ERROR_NOT_AVAILABLE);
    return NS_OK;
  }
  NS_ENSURE_TRUE(provider == "imap-client-discovery"_ns, NS_ERROR_INVALID_ARG);
  // Non-default server-directory/namespace layout needs a separate original
  // canonical-path contract. Refuse it before target creation, never guess.
  for (const char* pref : {"server_sub_directory", "namespace.personal",
                           "namespace.public", "namespace.other_users"}) {
    nsCString value;
    Preferences::GetCString(nsCString(branch + nsDependentCString(pref)).get(),
                            value);
    NS_ENSURE_TRUE(value.IsEmpty() || value == "\"\""_ns,
                   NS_ERROR_NOT_IMPLEMENTED);
  }
  JS::Rooted<JSObject*> cache(cx), parsed(cx), row(cx), properties(cx),
      values(cx), original(cx);
  MOZ_TRY(StartupObject(cx, origin, "cache", &cache));
  nsCString cachePath, cacheHash, key, sourceFormat;
  int64_t cacheSize, sourceKey = 0;
  JS::Rooted<JS::Value> format(cx);
  MOZ_TRY(ImportMember(cx, cache, "sourceFormat", &format, true));
  bool jsonCache = !format.isUndefined();
  if (jsonCache) {
    MOZ_TRY(ImportText(cx, format, sourceFormat));
    NS_ENSURE_TRUE(sourceFormat == "json"_ns || sourceFormat == "mork"_ns,
                   NS_ERROR_INVALID_ARG);
    jsonCache = sourceFormat == "json"_ns;
  }
  MOZ_TRY(StartupText(cx, cache, "path", cachePath));
  MOZ_TRY(StartupText(cx, cache, "sha256", cacheHash));
  MOZ_TRY(StartupText(cx, cache, "originalKey", key));
  MOZ_TRY(StartupNumber(cx, cache, "size", 1, UINT32_MAX - 1, cacheSize));
  if (jsonCache) {
    bool hasSourceKey;
    NS_ENSURE_TRUE(JS_HasOwnProperty(cx, cache, "sourceKey", &hasSourceKey),
                   NS_ERROR_FAILURE);
    NS_ENSURE_FALSE(hasSourceKey, NS_ERROR_INVALID_ARG);
  } else {
    MOZ_TRY(StartupNumber(cx, cache, "sourceKey", 0, UINT32_MAX, sourceKey));
  }
  nsCString actualKey;
  MOZ_TRY(file->GetPersistentDescriptor(actualKey));
  NS_ENSURE_TRUE(key == actualKey, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIFile> cacheFile;
  MOZ_TRY(StartupContained(operation.profile, cachePath,
                           getter_AddRefs(cacheFile)));
  nsCOMPtr<nsIFile> activeJSON;
  MOZ_TRY(StartupChild(operation.profile, "folderCache.json",
                       getter_AddRefs(activeJSON)));
  bool hasJSON;
  MOZ_TRY(activeJSON->Exists(&hasJSON));
  if (jsonCache) {
    nsCString actualPath;
    MOZ_TRY(GetComparablePath(activeJSON, actualPath));
    auto archived = operation.backupFiles.Lookup(cachePath);
    NS_ENSURE_TRUE(hasJSON && actualPath == cachePath && archived &&
                       archived.Data() == cacheHash,
                   NS_ERROR_NOT_AVAILABLE);
  } else {
    NS_ENSURE_FALSE(hasJSON, NS_ERROR_NOT_AVAILABLE);
  }
  MOZ_TRY(StartupCheckHash(cacheFile, cacheHash, cacheSize));
  MOZ_TRY(StartupParseFile(
      cx, cacheFile, u"resource:///modules/panorama/MorkFolderCache.sys.mjs"_ns,
      jsonCache ? "parseJSONFolderCache" : "parseMorkFolderCache", &parsed));
  JS::Rooted<JS::Value> field(cx);
  MOZ_TRY(StartupMapEntry(cx, parsed, "entries", key, &field));
  NS_ENSURE_TRUE(field.isObject(), NS_ERROR_FILE_CORRUPTED);
  row = &field.toObject();
  if (jsonCache) {
    bool hasSourceKey;
    NS_ENSURE_TRUE(JS_HasOwnProperty(cx, row, "sourceKey", &hasSourceKey),
                   NS_ERROR_FAILURE);
    NS_ENSURE_FALSE(hasSourceKey, NS_ERROR_FILE_CORRUPTED);
    nsCString parsedFormat;
    MOZ_TRY(StartupText(cx, parsed, "format", parsedFormat));
    NS_ENSURE_TRUE(parsedFormat == "json"_ns, NS_ERROR_FILE_CORRUPTED);
  } else {
    int64_t actualSourceKey;
    MOZ_TRY(
        StartupNumber(cx, row, "sourceKey", 0, UINT32_MAX, actualSourceKey));
    NS_ENSURE_TRUE(sourceKey == actualSourceKey, NS_ERROR_NOT_AVAILABLE);
  }
  MOZ_TRY(StartupObject(cx, row, "values", &values));
  MOZ_TRY(StartupObject(cx, origin, "originalCells", &original));
  for (const char* name : {"onlineName", "hierDelim", "boxFlags"}) {
    MOZ_TRY(StartupMapEntry(cx, row, "properties", nsDependentCString(name),
                            &field));
    nsCString raw, retained;
    MOZ_TRY(ImportText(cx, field, raw));
    MOZ_TRY(StartupText(cx, original, name, retained));
    NS_ENSURE_TRUE(raw == retained, NS_ERROR_NOT_AVAILABLE);
  }
  int64_t delimiter, flags, retainedDelimiter, retainedFlags;
  MOZ_TRY(StartupText(cx, values, "onlineName", output.onlineName));
  nsCString retainedName;
  MOZ_TRY(StartupText(cx, origin, "onlineName", retainedName));
  MOZ_TRY(StartupNumber(cx, values, "hierDelim", 1, 127, delimiter));
  MOZ_TRY(StartupNumber(cx, values, "boxFlags", 0, UINT32_MAX, flags));
  MOZ_TRY(StartupNumber(cx, origin, "hierarchyDelimiter", 1, 127,
                        retainedDelimiter));
  MOZ_TRY(StartupNumber(cx, origin, "boxFlags", 0, UINT32_MAX, retainedFlags));
  NS_ENSURE_TRUE(!output.onlineName.IsEmpty() &&
                     output.onlineName == retainedName &&
                     delimiter == retainedDelimiter && flags == retainedFlags &&
                     delimiter != kOnlineHierarchySeparatorUnknown &&
                     delimiter != kOnlineHierarchySeparatorNil,
                 NS_ERROR_NOT_AVAILABLE);
  output.delimiter = char(delimiter);
  output.boxFlags = uint32_t(flags);
  output.canonicalPath =
      nsImapUrl::ConvertToCanonicalFormat(output.onlineName, output.delimiter);
  NS_ENSURE_TRUE(!output.canonicalPath.IsEmpty() &&
                     output.canonicalPath.First() != '/' &&
                     output.canonicalPath.Last() != '/',
                 NS_ERROR_NOT_IMPLEMENTED);
  // Cross-check retained summary metadata from original bytes when present.
  MOZ_TRY(StartupParseFile(
      cx, file, u"resource:///modules/panorama/MorkSummaryReader.sys.mjs"_ns,
      "parseMorkSummary", &parsed));
  JS::Rooted<JSObject*> sourceObject(cx), rows(cx);
  MOZ_TRY(StartupObject(cx, parsed, "source", &sourceObject));
  MOZ_TRY(StartupObject(cx, sourceObject, "rows", &rows));
  NS_ENSURE_TRUE(JS::MapValues(cx, rows, &field), NS_ERROR_FAILURE);
  JS::ForOfIterator iterator(cx);
  NS_ENSURE_TRUE(iterator.init(field), NS_ERROR_FAILURE);
  bool done, seenInfo = false;
  while (true) {
    NS_ENSURE_TRUE(iterator.next(&field, &done), NS_ERROR_FAILURE);
    if (done) break;
    NS_ENSURE_TRUE(field.isObject(), NS_ERROR_FILE_CORRUPTED);
    row = &field.toObject();
    nsCString scope;
    MOZ_TRY(StartupText(cx, row, "scope", scope));
    if (scope != "ns:msg:db:row:scope:dbfolderinfo:all"_ns) continue;
    NS_ENSURE_FALSE(seenInfo, NS_ERROR_NOT_AVAILABLE);
    seenInfo = true;
    MOZ_TRY(StartupObject(cx, row, "cells", &properties));
    JS::Rooted<JSString*> name(cx, JS_NewStringCopyZ(cx, "onlineName"));
    NS_ENSURE_TRUE(name, NS_ERROR_OUT_OF_MEMORY);
    JS::Rooted<JS::Value> mapKey(cx, JS::StringValue(name));
    NS_ENSURE_TRUE(JS::MapGet(cx, properties, mapKey, &field),
                   NS_ERROR_FAILURE);
    if (!field.isUndefined()) {
      nsAutoJSString raw;
      NS_ENSURE_TRUE(field.isString() && raw.init(cx, field),
                     NS_ERROR_FILE_CORRUPTED);
      nsCString bytes;
      for (uint32_t i = 0; i < raw.Length(); ++i) {
        char16_t c = raw[i];
        NS_ENSURE_TRUE(c <= 255, NS_ERROR_FILE_CORRUPTED);
        bytes.Append(char(c));
      }
      NS_ENSURE_TRUE(bytes == output.onlineName, NS_ERROR_NOT_AVAILABLE);
    }
  }
  nsCOMPtr<nsIFile> physical;
  MOZ_TRY(root->Clone(getter_AddRefs(physical)));
  nsCCharSeparatedTokenizer parts(output.canonicalPath, '/');
  while (parts.hasMoreTokens()) {
    nsCString part(parts.nextToken());
    NS_ENSURE_TRUE(!part.IsEmpty() && part != "."_ns && part != ".."_ns,
                   NS_ERROR_NOT_IMPLEMENTED);
    MOZ_TRY(physical->Append(EncodeFilename(part)));
    if (parts.hasMoreTokens()) {
      nsAutoString leaf;
      MOZ_TRY(physical->GetLeafName(leaf));
      leaf.AppendLiteral(".sbd");
      MOZ_TRY(physical->SetLeafName(leaf));
    }
  }
  nsCString expectedStore;
  MOZ_TRY(GetComparablePath(physical, expectedStore));
  NS_ENSURE_TRUE(expectedStore == output.storePath, NS_ERROR_NOT_IMPLEMENTED);
  return NS_OK;
}

// Decode a retained dbfolderinfo name from byte-string Mork cells. This is
// source parsing only; publication additionally requires actual store
// discovery.
nsresult DatabaseCore::ReadStartupSummaryName(JSContext* cx, nsIFile* file,
                                              const nsACString& expected,
                                              Maybe<nsCString>& output) {
  nsCString hash;
  MOZ_TRY(StartupHash(file, hash));
  NS_ENSURE_TRUE(hash == expected, NS_ERROR_NOT_AVAILABLE);
  JS::Rooted<JSObject*> parsed(cx), source(cx), rows(cx);
  MOZ_TRY(StartupParseFile(
      cx, file, u"resource:///modules/panorama/MorkSummaryReader.sys.mjs"_ns,
      "parseMorkSummary", &parsed));
  MOZ_TRY(StartupObject(cx, parsed, "source", &source));
  MOZ_TRY(StartupObject(cx, source, "rows", &rows));
  JS::Rooted<JS::Value> value(cx);
  NS_ENSURE_TRUE(JS::MapValues(cx, rows, &value), NS_ERROR_FAILURE);
  JS::ForOfIterator iterator(cx);
  NS_ENSURE_TRUE(iterator.init(value), NS_ERROR_FAILURE);
  bool done, seen = false;
  Maybe<nsCString> result;
  while (true) {
    NS_ENSURE_TRUE(iterator.next(&value, &done), NS_ERROR_FAILURE);
    if (done) break;
    NS_ENSURE_TRUE(value.isObject(), NS_ERROR_FILE_CORRUPTED);
    JS::Rooted<JSObject*> row(cx, &value.toObject());
    nsCString scope;
    MOZ_TRY(StartupText(cx, row, "scope", scope));
    if (scope != "ns:msg:db:row:scope:dbfolderinfo:all"_ns) continue;
    NS_ENSURE_FALSE(seen, NS_ERROR_NOT_AVAILABLE);
    seen = true;
    MOZ_TRY(StartupMapEntry(cx, row, "cells", "folderName"_ns, &value, true));
    if (value.isUndefined()) continue;
    nsCString encoded, name;
    MOZ_TRY(ImportText(cx, value, encoded));
    nsString units = NS_ConvertUTF8toUTF16(encoded);
    for (char16_t c : units.View()) {
      NS_ENSURE_TRUE(c <= 255, NS_ERROR_FILE_CORRUPTED);
      name.Append(char(c));
    }
    NS_ENSURE_TRUE(NS_ConvertUTF16toUTF8(NS_ConvertUTF8toUTF16(name)) == name &&
                       name.FindChar(0) < 0,
                   NS_ERROR_FILE_CORRUPTED);
    if (!name.IsEmpty()) result = Some(std::move(name));
  }
  MOZ_TRY(StartupHash(file, hash));
  NS_ENSURE_TRUE(hash == expected, NS_ERROR_NOT_AVAILABLE);
  output = std::move(result);
  return NS_OK;
}

nsresult DatabaseCore::BindStartupLocalNames(JSContext* cx,
                                             StartupMailSource& source) {
  MOZ_TRY(CheckProfileStartup(ProfileStartupToken(), true));
  auto& operation = *mProfileStartup;
  nsCOMPtr<nsIFile> base;
  MOZ_TRY(NS_NewNativeLocalFile(source.serverRoot, getter_AddRefs(base)));
  for (uint32_t i = 0; i < source.localLeaves.Length(); ++i) {
    const auto& leaf = source.localLeaves[i];
    nsCOMPtr<nsIFile> summary;
    MOZ_TRY(base->Clone(getter_AddRefs(summary)));
    MOZ_TRY(summary->AppendNative(leaf + ".msf"_ns));
    nsCString path;
    MOZ_TRY(GetComparablePath(summary, path));
    Maybe<nsCString> name;
    if (auto archived = operation.backupFiles.Lookup(path))
      MOZ_TRY(ReadStartupSummaryName(cx, summary, archived.Data(), name));
    nsCOMPtr<nsIFile> cache;
    MOZ_TRY(operation.profile->Clone(getter_AddRefs(cache)));
    MOZ_TRY(cache->AppendNative("folderCache.json"_ns));
    bool jsonCache;
    MOZ_TRY(cache->Exists(&jsonCache));
    if (!jsonCache) MOZ_TRY(cache->SetNativeLeafName("panacea.dat"_ns));
    nsCString cachePath;
    MOZ_TRY(GetComparablePath(cache, cachePath));
    if (jsonCache)
      NS_ENSURE_TRUE(operation.backupFiles.Contains(cachePath),
                     NS_ERROR_NOT_AVAILABLE);
    if (auto archived = operation.backupFiles.Lookup(cachePath)) {
      nsCString cacheHash;
      MOZ_TRY(StartupHash(cache, cacheHash));
      NS_ENSURE_TRUE(cacheHash == archived.Data(), NS_ERROR_NOT_AVAILABLE);
      JS::Rooted<JSObject*> parsed(cx), row(cx), values(cx);
      MOZ_TRY(StartupParseFile(
          cx, cache, u"resource:///modules/panorama/MorkFolderCache.sys.mjs"_ns,
          jsonCache ? "parseJSONFolderCache" : "parseMorkFolderCache",
          &parsed));
      nsCString descriptor;
      MOZ_TRY(summary->GetPersistentDescriptor(descriptor));
      JS::Rooted<JS::Value> value(cx);
      MOZ_TRY(StartupMapEntry(cx, parsed, "entries", descriptor, &value, true));
      if (!value.isUndefined()) {
        NS_ENSURE_TRUE(value.isObject(), NS_ERROR_FILE_CORRUPTED);
        row = &value.toObject();
        MOZ_TRY(StartupObject(cx, row, "values", &values));
        MOZ_TRY(ImportMember(cx, values, "folderName", &value, true));
        if (!value.isUndefined()) {
          nsCString cached;
          MOZ_TRY(ImportText(cx, value, cached));
          if (!cached.IsEmpty()) {
            NS_ENSURE_TRUE(!name || *name == cached, NS_ERROR_NOT_AVAILABLE);
            name = Some(std::move(cached));
          }
        }
      }
      MOZ_TRY(StartupHash(cache, cacheHash));
      NS_ENSURE_TRUE(cacheHash == archived.Data(), NS_ERROR_NOT_AVAILABLE);
    }
    if (!name) {
      // Legacy Mork storage used NS_MsgHashIfNecessary, not the Panorama
      // filename codec. A literal percent is not an escape in this contract.
      // A possible shortened/hash suffix needs its actual retained name.
      bool hashed = leaf.Length() >= 8;
      nsCString suffix(
          Substring(leaf, leaf.Length() >= 8 ? leaf.Length() - 8 : 0));
      for (char c : suffix.View())
        hashed &= (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
      NS_ENSURE_TRUE(
          !hashed && NS_ConvertUTF16toUTF8(NS_MsgHashIfNecessary(leaf)) == leaf,
          NS_ERROR_NOT_AVAILABLE);
      name = Some(leaf);
    }
    NS_ENSURE_TRUE(!name->IsEmpty() && *name != "."_ns && *name != ".."_ns &&
                       name->FindChar(0) < 0,
                   NS_ERROR_FILE_CORRUPTED);
    source.localNames.AppendElement(*name);
    if (i + 1 < source.localLeaves.Length())
      MOZ_TRY(base->AppendNative(leaf + ".sbd"_ns));
  }
  return CheckProfileStartup(ProfileStartupToken(), true);
}

nsresult DatabaseCore::DescribeProfileStartup(
    JSContext* cx, JS::MutableHandle<JS::Value> output) {
  MOZ_TRY(CheckProfileStartup(ProfileStartupToken()));
  auto& operation = *mProfileStartup;
  if (!operation.selected) {
    AutoRestore<bool> busy(operation.busy);
    operation.busy = true;
    JS::Rooted<JSObject*> selector(cx);
    MOZ_TRY(StartupSelector(cx, operation, &selector));
    nsCOMPtr<nsIFile> file;
    MOZ_TRY(StartupChild(operation.profile, "panorama.sqlite",
                         getter_AddRefs(file)));
    MOZ_TRY(StartupProbe(file, operation.existing, operation.schema,
                         operation.sourceId));
    if (operation.existing) {
#ifndef XP_WIN
      nsAutoCString path;
      MOZ_TRY(GetComparablePath(file, path));
      operation.databaseFD =
          open(path.get(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
      NS_ENSURE_TRUE(
          operation.databaseFD >= 0 &&
              !fstat(operation.databaseFD, &operation.databaseIdentity),
          NS_ERROR_FILE_ACCESS_DENIED);
#else
      MOZ_TRY(StartupAdmit(operation, file, operation.profile,
                           nsIPanoramaMigrationFileSystem::KIND_FILE_OR_MISSING,
                           operation.databaseLease));
#endif
      bool exists;
      int32_t version;
      nsCString source;
      MOZ_TRY(StartupProbe(file, exists, version, source));
      NS_ENSURE_TRUE(
          exists && version == operation.schema && source == operation.sourceId,
          NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(CheckProfileStartup(ProfileStartupToken(), true));
    }
    if (selector) {
      nsCString state;
      MOZ_TRY(StartupText(cx, selector, "state", state));
      // Interrupted prepared work is explicit recovery. It is not an empty
      // profile and cannot be replaced by a fresh startup plan.
      NS_ENSURE_TRUE(state == "active"_ns && operation.existing,
                     NS_ERROR_NOT_AVAILABLE);
      JS::Rooted<JSObject*> identity(cx);
      MOZ_TRY(StartupObject(cx, selector, "identity", &identity));
      nsCString source;
      int64_t schema;
      MOZ_TRY(StartupText(cx, identity, "databaseSourceId", source));
      MOZ_TRY(StartupNumber(cx, identity, "schemaVersion", 0, 21, schema));
      NS_ENSURE_TRUE(source == operation.sourceId && schema == operation.schema,
                     NS_ERROR_NOT_AVAILABLE);
      JS::Rooted<JS::Value> value(cx, JS::ObjectValue(*selector));
      MOZ_TRY(StartupJSON(cx, value, operation.initialSelector));
    }
    if (operation.existing) {
      operation.mode = "reuse"_ns;
    } else {
      nsTArray<nsCString> inventory;
      MOZ_TRY(StartupInventory(operation.profile, inventory));
      MOZ_TRY(StartupConfiguredRoots(operation.profile, inventory));
      operation.mode = inventory.IsEmpty() ? "initialize"_ns : "migrate"_ns;
    }
    operation.selected = true;
  }
  JS::Rooted<JSObject*> result(cx, JS_NewPlainObject(cx));
  JS::Rooted<JSObject*> folders(
      cx, JS::NewArrayObject(cx, operation.folders.Length()));
  NS_ENSURE_TRUE(result && folders, NS_ERROR_OUT_OF_MEMORY);
  auto text = [&](JS::Handle<JSObject*> object, const char* name,
                  const nsACString& value) -> bool {
    JS::Rooted<JSString*> string(
        cx, JS_NewStringCopyUTF8N(
                cx, JS::UTF8Chars(value.BeginReading(), value.Length())));
    return string &&
           JS_DefineProperty(cx, object, name, string, JSPROP_ENUMERATE);
  };
  NS_ENSURE_TRUE(text(result, "profilePath", operation.profilePath) &&
                     text(result, "localProfilePath", operation.localPath) &&
                     text(result, "phase",
                          operation.ready    ? "ready"_ns
                          : operation.opened ? "target-open"_ns
                                             : "selected"_ns) &&
                     text(result, "mode", operation.mode),
                 NS_ERROR_OUT_OF_MEMORY);
  JS::Rooted<JS::Value> source(cx, JS::NullValue()),
      schema(cx, JS::NullValue());
  if (!operation.sourceId.IsEmpty()) {
    JS::Rooted<JSString*> string(
        cx, JS_NewStringCopyN(cx, operation.sourceId.get(),
                              operation.sourceId.Length()));
    NS_ENSURE_TRUE(string, NS_ERROR_OUT_OF_MEMORY);
    source.setString(string);
  }
  if (operation.schema >= 0) schema.setNumber(operation.schema);
  NS_ENSURE_TRUE(JS_DefineProperty(cx, result, "databaseSourceId", source,
                                   JSPROP_ENUMERATE) &&
                     JS_DefineProperty(cx, result, "schemaVersion", schema,
                                       JSPROP_ENUMERATE),
                 NS_ERROR_OUT_OF_MEMORY);
  for (uint32_t i = 0; i < operation.folders.Length(); ++i) {
    JS::Rooted<JSObject*> entry(cx, JS_NewPlainObject(cx));
    JS::Rooted<JS::Value> folder(cx);
    uint64_t id;
    MOZ_TRY(operation.folders[i]->GetId(&id));
    MOZ_TRY(nsContentUtils::WrapNative(cx, operation.folders[i],
                                       &NS_GET_IID(nsIMsgFolder), &folder));
    NS_ENSURE_TRUE(
        entry && text(entry, "sourceId", operation.sourceIds[i]) &&
            JS_DefineProperty(cx, entry, "folderId", double(id),
                              JSPROP_ENUMERATE) &&
            JS_DefineProperty(cx, entry, "folder", folder, JSPROP_ENUMERATE) &&
            JS_SetElement(cx, folders, i, entry),
        NS_ERROR_OUT_OF_MEMORY);
  }
  NS_ENSURE_TRUE(
      JS_DefineProperty(cx, result, "folders", folders, JSPROP_ENUMERATE),
      NS_ERROR_OUT_OF_MEMORY);
  JS::Rooted<JSObject*> serverSummaries(
      cx, JS::NewArrayObject(cx, operation.serverSummaries.Length()));
  NS_ENSURE_TRUE(serverSummaries, NS_ERROR_OUT_OF_MEMORY);
  for (uint32_t i = 0; i < operation.serverSummaries.Length(); ++i) {
    const auto& summary = operation.serverSummaries[i];
    JS::Rooted<JSObject*> entry(cx, JS_NewPlainObject(cx));
    NS_ENSURE_TRUE(
        summary.folderId && summary.folderId <= 9007199254740991ULL && entry &&
            text(entry, "sourceId", summary.id) &&
            JS_DefineProperty(cx, entry, "folderId", double(summary.folderId),
                              JSPROP_ENUMERATE) &&
            JS_SetElement(cx, serverSummaries, i, entry),
        NS_ERROR_NOT_AVAILABLE);
  }
  NS_ENSURE_TRUE(JS_DefineProperty(cx, result, "serverSummaries",
                                   serverSummaries, JSPROP_ENUMERATE),
                 NS_ERROR_OUT_OF_MEMORY);
  output.setObject(*result);
  return NS_OK;
}

nsresult DatabaseCore::CheckStartupMailStore(const nsACString& path,
                                             const nsACString& contract,
                                             bool remote) {
  NS_ENSURE_TRUE(contract == "@mozilla.org/msgstore/berkeleystore;1"_ns ||
                     contract == "@mozilla.org/msgstore/maildirstore;1"_ns,
                 NS_ERROR_NOT_IMPLEMENTED);
  nsCOMPtr<nsIFile> store;
  MOZ_TRY(NS_NewNativeLocalFile(path, getter_AddRefs(store)));
  // IsSymlink uses lstat on Unix and fails when no offline body exists. A real
  // metadata-only IMAP summary need not have created that body file yet. Still
  // lstat first: Exists follows links and would hide a dangling symlink.
  bool linked = false;
  nsresult linkStatus = store->IsSymlink(&linked);
  NS_ENSURE_TRUE(NS_SUCCEEDED(linkStatus) ||
                     (remote && linkStatus == NS_ERROR_FILE_NOT_FOUND),
                 linkStatus);
  NS_ENSURE_FALSE(linked, NS_ERROR_FILE_ACCESS_DENIED);
  bool exists;
  MOZ_TRY(store->Exists(&exists));
  if (!exists) {
    NS_ENSURE_TRUE(remote && linkStatus == NS_ERROR_FILE_NOT_FOUND,
                   NS_ERROR_NOT_AVAILABLE);
    return NS_OK;
  }
  // A failed lstat followed by an existing path is a changed input, not a
  // missing-body allowance. All other real file/directory errors propagate.
  MOZ_TRY(linkStatus);
  bool directory;
  MOZ_TRY(store->IsDirectory(&directory));
  NS_ENSURE_TRUE(
      directory == (contract == "@mozilla.org/msgstore/maildirstore;1"_ns),
      NS_ERROR_NOT_AVAILABLE);
  if (!directory) {
    bool regular;
    MOZ_TRY(store->IsFile(&regular));
    NS_ENSURE_TRUE(regular, NS_ERROR_NOT_AVAILABLE);
  }
  return NS_OK;
}

nsresult DatabaseCore::OpenProfileStartup(JSContext* cx,
                                          JS::Handle<JS::Value> input) {
  MOZ_TRY(CheckProfileStartup(ProfileStartupToken()));
  auto& operation = *mProfileStartup;
  // A failed descriptor must not leave its partial probe as open authority.
  NS_ENSURE_TRUE(operation.selected, NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_FALSE(operation.opened || operation.ready,
                  NS_ERROR_ALREADY_INITIALIZED);
  // Freeze caller input before using any fields. Accessors may reenter, but
  // the operation is busy and no target mutation has yet been authorized.
  AutoRestore<bool> busy(operation.busy);
  operation.busy = true;
  nsCString snapshot;
  MOZ_TRY(StartupJSON(cx, input, snapshot));
  JS::Rooted<JS::Value> value(cx);
  MOZ_TRY(StartupParse(cx, snapshot, &value));
  JS::Rooted<JSObject*> plan(cx, &value.toObject()), selector(cx), sources(cx);
  nsCString mode, profile;
  MOZ_TRY(StartupText(cx, plan, "mode", mode));
  MOZ_TRY(StartupText(cx, plan, "profilePath", profile));
  NS_ENSURE_TRUE(profile == operation.profilePath, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(StartupSelector(
      cx, operation, &selector,
      mode == "reuse"_ns && !operation.initialSelector.IsEmpty()));
  nsCOMPtr<nsIFile> file;
  MOZ_TRY(
      StartupChild(operation.profile, "panorama.sqlite", getter_AddRefs(file)));
  bool exists;
  int32_t schema = -1;
  nsCString oldSource;
  MOZ_TRY(StartupProbe(file, exists, schema, oldSource));
  NS_ENSURE_TRUE(
      exists == operation.existing && oldSource == operation.sourceId,
      NS_ERROR_NOT_AVAILABLE);
  uint32_t count, serverSummaryCount;
  MOZ_TRY(StartupArray(cx, plan, "sources", &sources, count, true));
  JS::Rooted<JSObject*> serverSummaries(cx);
  MOZ_TRY(StartupArray(cx, plan, "serverSummaries", &serverSummaries,
                       serverSummaryCount, true));
  NS_ENSURE_TRUE(mode == "migrate"_ns || !serverSummaryCount,
                 NS_ERROR_NOT_AVAILABLE);
  if (mode == "legacy"_ns) {
    NS_ENSURE_TRUE(!selector && !exists && !count, NS_ERROR_NOT_AVAILABLE);
    operation.mode = mode;
    operation.opened = true;
    return NS_OK;
  }
  NS_ENSURE_TRUE(
      mode == "reuse"_ns || mode == "initialize"_ns || mode == "migrate"_ns,
      NS_ERROR_INVALID_ARG);
  nsTArray<nsCString> inventory;
  if (mode == "reuse"_ns) {
    NS_ENSURE_TRUE(operation.mode == "reuse"_ns && exists && !count,
                   NS_ERROR_NOT_AVAILABLE);
    // Recheck the exact selected active record after freezing caller input.
    // An unmarked existing database remains adoptable only while unmarked.
    if (operation.initialSelector.IsEmpty()) {
      NS_ENSURE_FALSE(selector, NS_ERROR_NOT_AVAILABLE);
    } else {
      NS_ENSURE_TRUE(selector, NS_ERROR_NOT_AVAILABLE);
      JS::Rooted<JS::Value> selected(cx),
          actual(cx, JS::ObjectValue(*selector));
      MOZ_TRY(StartupParse(cx, operation.initialSelector, &selected));
      MOZ_TRY(StartupEqual(cx, selected, actual));
    }
  } else {
    NS_ENSURE_TRUE(mode == "migrate"_ns || (!exists && !selector),
                   NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(StartupInventory(operation.profile, inventory));
    operation.servers.Clear();
    MOZ_TRY(StartupConfiguredRoots(
        operation.profile, inventory,
        mode == "migrate"_ns ? &operation.servers : nullptr));
    if (mode == "initialize"_ns) {
      NS_ENSURE_TRUE(inventory.IsEmpty() && !count, NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(StartupConfiguredRoots(operation.profile, inventory));
      NS_ENSURE_TRUE(inventory.IsEmpty(), NS_ERROR_NOT_AVAILABLE);
    } else {
      NS_ENSURE_TRUE(selector, NS_ERROR_NOT_AVAILABLE);
      JS::Rooted<JSObject*> selectorIdentity(cx), backup(cx), journal(cx),
          startup(cx), retained(cx);
      MOZ_TRY(StartupObject(cx, selector, "identity", &selectorIdentity));
      MOZ_TRY(StartupObject(cx, plan, "backup", &backup));
      MOZ_TRY(StartupText(cx, plan, "journalPath", operation.journalPath));
      nsCString selectedJournal, origin, state;
      MOZ_TRY(
          StartupText(cx, selectorIdentity, "journalPath", selectedJournal));
      MOZ_TRY(StartupText(cx, selector, "origin", origin));
      MOZ_TRY(StartupText(cx, selector, "state", state));
      NS_ENSURE_TRUE(selectedJournal == operation.journalPath &&
                         origin == "migrated"_ns && state == "prepared"_ns,
                     NS_ERROR_NOT_AVAILABLE);
      JS::Rooted<JS::Value> expected(cx), actual(cx);
      MOZ_TRY(ImportMember(cx, selectorIdentity, "backup", &expected));
      actual.setObject(*backup);
      MOZ_TRY(StartupEqual(cx, expected, actual));
      MOZ_TRY(StartupBackup(cx, operation, backup));
      nsCOMPtr<nsIFile> journalFile;
      MOZ_TRY(StartupJournalFile(operation, operation.journalPath,
                                 getter_AddRefs(journalFile)));
      MOZ_TRY(StartupReadJSON(cx, journalFile, &journal));
      int64_t version;
      MOZ_TRY(StartupNumber(cx, journal, "version", 7, 7, version));
      MOZ_TRY(StartupText(cx, journal, "profilePath", profile));
      MOZ_TRY(ImportMember(cx, journal, "cancelled", &expected));
      NS_ENSURE_TRUE(profile == operation.profilePath && expected.isBoolean() &&
                         !expected.toBoolean(),
                     NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(StartupText(cx, journal, "stage", state));
      NS_ENSURE_TRUE(state == "backup"_ns || state == "import"_ns ||
                         state == "validate"_ns || state == "activate"_ns ||
                         state == "complete"_ns,
                     NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(StartupObject(cx, journal, "startup", &startup));
      MOZ_TRY(StartupObject(cx, startup, "inventory", &retained));
      MOZ_TRY(ImportMember(cx, retained, "sources", &expected));
      actual.setObject(*sources);
      MOZ_TRY(StartupEqual(cx, expected, actual));
      MOZ_TRY(StartupJSON(cx, actual, operation.retainedSources));
      nsTHashSet<nsCString> paths, ids, destinations;
      operation.sources.Clear();
      for (uint32_t i = 0; i < count; ++i) {
        JS::Rooted<JSObject*> source(cx);
        MOZ_TRY(StartupItem(cx, sources, i, &source));
        StartupMailSource native;
        MOZ_TRY(ReadStartupMailSource(cx, source, operation, native));
        if (native.protocol == "none"_ns)
          MOZ_TRY(BindStartupLocalNames(cx, native));
        auto archived = operation.backupFiles.Lookup(native.path);
        NS_ENSURE_TRUE(archived && archived.Data() == native.hash,
                       NS_ERROR_NOT_AVAILABLE);
        nsCOMPtr<nsIFile> summary;
        MOZ_TRY(StartupContained(operation.profile, native.path,
                                 getter_AddRefs(summary)));
        JS::Rooted<JSObject*> parsed(cx), original(cx), rows(cx);
        MOZ_TRY(StartupParseFile(
            cx, summary,
            u"resource:///modules/panorama/MorkSummaryReader.sys.mjs"_ns,
            "parseMorkSummary", &parsed));
        MOZ_TRY(StartupObject(cx, parsed, "source", &original));
        MOZ_TRY(StartupObject(cx, original, "rows", &rows));
        JS::Rooted<JS::Value> rowValue(cx);
        NS_ENSURE_TRUE(JS::MapValues(cx, rows, &rowValue), NS_ERROR_FAILURE);
        JS::ForOfIterator rowsIterator(cx);
        NS_ENSURE_TRUE(rowsIterator.init(rowValue), NS_ERROR_FAILURE);
        bool done, seenInfo = false;
        while (true) {
          NS_ENSURE_TRUE(rowsIterator.next(&rowValue, &done), NS_ERROR_FAILURE);
          if (done) break;
          NS_ENSURE_TRUE(rowValue.isObject(), NS_ERROR_FILE_CORRUPTED);
          JS::Rooted<JSObject*> row(cx, &rowValue.toObject());
          nsCString scope;
          MOZ_TRY(StartupText(cx, row, "scope", scope));
          if (scope != "ns:msg:db:row:scope:dbfolderinfo:all"_ns) continue;
          NS_ENSURE_FALSE(seenInfo, NS_ERROR_NOT_IMPLEMENTED);
          seenInfo = true;
          MOZ_TRY(
              StartupMapEntry(cx, row, "cells", "flags"_ns, &rowValue, true));
          if (!rowValue.isUndefined()) {
            nsCString text;
            MOZ_TRY(ImportText(cx, rowValue, text));
            uint64_t flags;
            MOZ_TRY(ImportHex(text, 8, flags));
            native.originalFlags = Some(uint32_t(flags));
          }
        }
        NS_ENSURE_TRUE(seenInfo, NS_ERROR_NOT_IMPLEMENTED);
        nsCString measured;
        MOZ_TRY(StartupHash(summary, measured));
        NS_ENSURE_TRUE(measured == native.hash, NS_ERROR_NOT_AVAILABLE);
        NS_ENSURE_TRUE(!ids.Contains(native.id) &&
                           !paths.Contains(native.path) &&
                           !destinations.Contains(native.serverKey + "/"_ns +
                                                  (native.protocol == "imap"_ns
                                                       ? native.canonicalPath
                                                       : native.storePath)),
                       NS_ERROR_INVALID_ARG);
        ids.Insert(native.id);
        paths.Insert(native.path);
        destinations.Insert(native.serverKey + "/"_ns +
                            (native.protocol == "imap"_ns ? native.canonicalPath
                                                          : native.storePath));
        operation.sources.AppendElement(std::move(native));
      }
      JS::Rooted<JSObject*> savedSummaries(cx);
      uint32_t savedSummaryCount;
      MOZ_TRY(StartupArray(cx, retained, "serverSummaries", &savedSummaries,
                           savedSummaryCount, true));
      expected.setObject(*savedSummaries);
      actual.setObject(*serverSummaries);
      MOZ_TRY(StartupEqual(cx, expected, actual));
      MOZ_TRY(StartupJSON(cx, actual, operation.retainedServerSummaries));
      operation.serverSummaries.Clear();
      nsTHashSet<nsCString> summaryServers;
      for (uint32_t i = 0; i < serverSummaryCount; ++i) {
        JS::Rooted<JSObject*> entry(cx);
        MOZ_TRY(StartupItem(cx, serverSummaries, i, &entry));
        StartupServerSummary summary;
        MOZ_TRY(StartupServerSummaryInput(cx, entry, operation, summary));
        NS_ENSURE_TRUE(!ids.Contains(summary.id) &&
                           !paths.Contains(summary.path) &&
                           !summaryServers.Contains(summary.serverKey),
                       NS_ERROR_NOT_AVAILABLE);
        ids.Insert(summary.id);
        paths.Insert(summary.path);
        summaryServers.Insert(summary.serverKey);
        operation.serverSummaries.AppendElement(std::move(summary));
      }
      for (const auto& source : operation.sources) {
        if (source.protocol != "imap"_ns) continue;
        int32_t slash = source.canonicalPath.RFindChar('/');
        if (slash < 0) continue;
        nsCString parent(Substring(source.canonicalPath, 0, slash));
        bool present = false;
        for (const auto& other : operation.sources) {
          if (other.serverKey == source.serverKey &&
              other.protocol == "imap"_ns && other.canonicalPath == parent &&
              other.delimiter == source.delimiter)
            present = true;
        }
        NS_ENSURE_TRUE(present, NS_ERROR_NOT_AVAILABLE);
      }
      for (const char* field : {"books", "caches"}) {
        JS::Rooted<JSObject*> units(cx);
        uint32_t length;
        MOZ_TRY(StartupArray(cx, plan, field, &units, length, true));
        JS::Rooted<JS::Value> retainedValue(cx, JS::ObjectValue(*units));
        MOZ_TRY(StartupJSON(cx, retainedValue,
                            strcmp(field, "books") == 0
                                ? operation.retainedBooks
                                : operation.retainedCaches));
        for (uint32_t i = 0; i < length; ++i) {
          JS::Rooted<JSObject*> unit(cx);
          MOZ_TRY(StartupItem(cx, units, i, &unit));
          nsCString path, digest, measured;
          MOZ_TRY(StartupText(cx, unit, "path", path));
          MOZ_TRY(StartupText(cx, unit, "sha256", digest));
          nsCOMPtr<nsIFile> sourceFile;
          MOZ_TRY(StartupContained(operation.profile, path,
                                   getter_AddRefs(sourceFile)));
          MOZ_TRY(StartupHash(sourceFile, measured));
          auto archived = operation.backupFiles.Lookup(path);
          NS_ENSURE_TRUE(digest == measured && !paths.Contains(path) &&
                             archived && archived.Data() == digest,
                         NS_ERROR_NOT_AVAILABLE);
          paths.Insert(path);
        }
      }
      // Every observed summary/book/cache must have a declared retained unit.
      // Physical store files are accounted by the source store, never imported
      // as a remote hierarchy or substituted for an original summary.
      for (const auto& path : inventory) {
        if (StringEndsWith(path, ".msf"_ns) ||
            StringEndsWith(path, ".mab"_ns) ||
            StringEndsWith(path, "/panacea.dat"_ns) ||
            StringEndsWith(path, "/folderCache.json"_ns)) {
          NS_ENSURE_TRUE(paths.Contains(path), NS_ERROR_NOT_AVAILABLE);
        }
      }
      MOZ_TRY(StartupStores(operation, inventory, paths));
      NS_ENSURE_FALSE(paths.IsEmpty(), NS_ERROR_NOT_AVAILABLE);
    }
  }
  MOZ_TRY(CheckProfileStartup(ProfileStartupToken(), true));
  operation.mode = mode;
  AutoRestore<bool> opening(mStartupOpening);
  mStartupOpening = true;
  MOZ_TRY(Startup());
  MOZ_TRY(GetSourceId(operation.sourceId));
  MOZ_TRY(sConnection->GetSchemaVersion(&operation.schema));
  if (!oldSource.IsEmpty())
    NS_ENSURE_TRUE(oldSource == operation.sourceId, NS_ERROR_NOT_AVAILABLE);
#ifndef XP_WIN
  // Pin the exact database file after SQLite open, not just its pathname.
  nsAutoCString databasePath;
  MOZ_TRY(GetComparablePath(file, databasePath));
  if (operation.databaseFD < 0) {
    operation.databaseFD =
        open(databasePath.get(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    NS_ENSURE_TRUE(
        operation.databaseFD >= 0 &&
            !fstat(operation.databaseFD, &operation.databaseIdentity),
        NS_ERROR_FILE_ACCESS_DENIED);
  }
#else
  // Pin the exact database file after SQLite open, not just its pathname.
  if (!operation.databaseLease) {
    MOZ_TRY(StartupAdmit(operation, file, operation.profile,
                         nsIPanoramaMigrationFileSystem::KIND_FILE_OR_MISSING,
                         operation.databaseLease));
  }
#endif
  MOZ_TRY(CheckProfileStartup(ProfileStartupToken(), true));
  if (mode == "migrate"_ns) MOZ_TRY(BuildStartupFolders());
  operation.opened = true;
  return NS_OK;
}

nsresult DatabaseCore::BuildStartupFolders() {
  auto& operation = *mProfileStartup;
  AutoRestore<uint32_t> metadata(mStartupMetadataDepth);
  ++mStartupMetadataDepth;
  nsCOMPtr<nsIMsgAccountManager> accounts =
      do_GetService("@mozilla.org/messenger/account-manager;1");
  NS_ENSURE_TRUE(accounts, NS_ERROR_NOT_AVAILABLE);
  nsTHashMap<nsCString, nsCOMPtr<nsIMsgFolder>> roots;
  for (const auto& source : operation.servers) {
    nsCOMPtr<nsIFile> retainedRoot;
    MOZ_TRY(NS_NewNativeLocalFile(source.path, getter_AddRefs(retainedRoot)));
    nsTArray<nsCString> beforeConstruction;
    MOZ_TRY(StartupInventory(retainedRoot, beforeConstruction, true, false));
    for (const auto& path : beforeConstruction)
      NS_ENSURE_TRUE(operation.backupFiles.Contains(path),
                     NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsIMsgIncomingServer> server;
    MOZ_TRY(accounts->GetIncomingServer(source.key, getter_AddRefs(server)));
    NS_ENSURE_TRUE(server, NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsIFile> localPath, path;
    MOZ_TRY(server->GetLocalPath(getter_AddRefs(localPath)));
    MOZ_TRY(StartupCanonicalRoot(localPath, getter_AddRefs(path)));
    nsAutoCString actualPath, protocol, contract;
    MOZ_TRY(GetComparablePath(path, actualPath));
    MOZ_TRY(server->GetType(protocol));
    MOZ_TRY(server->GetStringValue("storeContractID", contract));
    if (contract.IsEmpty())
      contract.AssignLiteral("@mozilla.org/msgstore/berkeleystore;1");
    NS_ENSURE_TRUE(actualPath == source.path && protocol == source.protocol &&
                       contract == source.contract,
                   NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsIMsgFolder> root;
    MOZ_TRY(server->GetRootFolder(getter_AddRefs(root)));
    NS_ENSURE_TRUE(root, NS_ERROR_NOT_AVAILABLE);
    roots.InsertOrUpdate(source.key, root);
  }
  for (auto& summary : operation.serverSummaries) {
    auto root = roots.Lookup(summary.serverKey);
    NS_ENSURE_TRUE(root, NS_ERROR_NOT_AVAILABLE);
    bool isServer;
    MOZ_TRY(root.Data()->GetIsServer(&isServer));
    uint64_t id;
    MOZ_TRY(root.Data()->GetId(&id));
    NS_ENSURE_TRUE(
        isServer && id && !MOZ_TRY(mFolderDatabase->GetFolderParent(id)) &&
            MOZ_TRY(mFolderDatabase->GetFolderName(id)) == summary.serverKey,
        NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsIFile> file, store;
    MOZ_TRY(root.Data()->GetSummaryFile(getter_AddRefs(file)));
    MOZ_TRY(root.Data()->GetFilePath(getter_AddRefs(store)));
    nsCString filePath, storePath;
    MOZ_TRY(GetComparablePath(file, filePath));
    MOZ_TRY(GetComparablePath(store, storePath));
    NS_ENSURE_TRUE(filePath == summary.path && storePath == summary.serverRoot,
                   NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(StartupCheckHash(file, summary.hash, summary.size));
    summary.folderId = id;
  }
  nsTArray<const StartupMailSource*> local;
  for (const auto& source : operation.sources)
    if (source.protocol == "none"_ns) local.AppendElement(&source);
  local.Sort([](const StartupMailSource* a, const StartupMailSource* b) -> int {
    if (a->localNames.Length() != b->localNames.Length())
      return a->localNames.Length() < b->localNames.Length() ? -1 : 1;
    return Compare(a->storePath, b->storePath);
  });
  // Map actual legacy store discovery through retained summary/cache names.
  // A shortened physical leaf is not a public AddSubfolder row birth.
  auto reconcileLocal = [&](nsIMsgFolder* parent,
                            const StartupMailSource& source, uint32_t depth,
                            const nsTArray<nsCString>& discovered) -> nsresult {
    nsTArray<nsCString> names;
    nsTHashSet<nsCString> physicalNames;
    for (const auto& name : discovered) {
      NS_ENSURE_FALSE(physicalNames.Contains(name), NS_ERROR_NOT_AVAILABLE);
      physicalNames.Insert(name);
      names.AppendElement(MOZ_TRY(DatabaseUtils::Normalize(name)));
    }
    bool root;
    MOZ_TRY(parent->GetIsServer(&root));
    nsTHashMap<nsCString, nsCString> boundNames;
    for (const auto* candidate : local) {
      if (candidate->serverKey != source.serverKey ||
          candidate->serverRoot != source.serverRoot ||
          candidate->localLeaves.Length() <= depth)
        continue;
      bool sameParent = true;
      for (uint32_t i = 0; i < depth; ++i)
        sameParent &= candidate->localLeaves[i] == source.localLeaves[i];
      if (!sameParent) continue;
      nsCString decoded =
          DecodeFilename(NS_ConvertUTF8toUTF16(candidate->localLeaves[depth]));
      auto index = discovered.IndexOf(decoded);
      NS_ENSURE_TRUE(index != nsTArray<nsCString>::NoIndex,
                     NS_ERROR_NOT_AVAILABLE);
      nsCString name =
          MOZ_TRY(DatabaseUtils::Normalize(candidate->localNames[depth]));
      if (root) {
        for (const auto& canonical :
             {"Inbox"_ns, "Unsent Messages"_ns, "Drafts"_ns, "Trash"_ns,
              "Sent"_ns, "Templates"_ns, "Archives"_ns}) {
          if (name.Equals(canonical, nsCaseInsensitiveUTF8StringComparator)) {
            name = canonical;
            break;
          }
        }
      }
      if (auto prior = boundNames.Lookup(decoded))
        NS_ENSURE_TRUE(prior.Data() == name, NS_ERROR_NOT_AVAILABLE);
      boundNames.InsertOrUpdate(decoded, name);
      names[index] = name;
    }
    bool changed = false;
    for (uint32_t i = 0; i < names.Length(); ++i) {
      changed |= names[i] != MOZ_TRY(DatabaseUtils::Normalize(discovered[i]));
      for (uint32_t j = 0; j < i; ++j)
        NS_ENSURE_FALSE(
            names[i].Equals(names[j], nsCaseInsensitiveUTF8StringComparator),
            NS_ERROR_NOT_AVAILABLE);
    }
    if (!changed) return NS_OK;
    uint64_t parentId;
    MOZ_TRY(parent->GetId(&parentId));
    FolderDatabase::CacheOrigin parentOrigin;
    MOZ_TRY(
        mFolderDatabase->CheckCacheProjectionOrigin(parentId, parentOrigin));
    auto* nativeParent = static_cast<nsMsgDBFolder*>(parent);
    nsTArray<nsMsgDBFolder::FolderInitialization> retired;
    nsTArray<RefPtr<nsIMsgFolder>> detached;
    // Supersede only fresh untouched native discovery objects, never a public,
    // sealed, pending, imported or data-bearing row. Retain every other guard.
    std::function<nsresult(nsMsgDBFolder*)> capture =
        [&](nsMsgDBFolder* folder) -> nsresult {
      uint64_t id;
      MOZ_TRY(folder->GetId(&id));
      FolderDatabase::CacheOrigin origin;
      MOZ_TRY(mFolderDatabase->CheckCacheProjectionOrigin(id, origin));
      bool imported;
      MOZ_TRY(mFolderDatabase->HasCacheImportBinding(id, imported));
      nsCOMPtr<mozIStorageStatement> receipt;
      MOZ_TRY(sConnection->CreateStatement(
          "SELECT EXISTS(SELECT 1 FROM folder_import_receipts WHERE folderId=:folder)"_ns,
          getter_AddRefs(receipt)));
      MOZ_TRY(receipt->BindInt64ByName("folder"_ns, id));
      bool row;
      MOZ_TRY(receipt->ExecuteStep(&row));
      NS_ENSURE_TRUE(row, NS_ERROR_FILE_CORRUPTED);
      int32_t mailImported;
      MOZ_TRY(receipt->GetInt32(0, &mailImported));
      receipt = nullptr;
      uint64_t messageCount;
      MOZ_TRY(MessageDB().GetNumMessages(id, &messageCount));
      NS_ENSURE_TRUE(
          origin.birthSite ==
                  uint32_t(CacheDiscoveryFlagSite::LocalInitialChild) &&
              !origin.explicitMask && !imported && !mailImported &&
              !messageCount,
          NS_ERROR_NOT_AVAILABLE);
      nsTArray<uint64_t> childIds =
          MOZ_TRY(mFolderDatabase->GetFolderChildren(id));
      nsTHashSet<uint64_t> seen;
      nsTArray<RefPtr<nsIMsgFolder>> children;
      for (nsIMsgFolder* child : folder->mSubFolders) {
        uint64_t childId;
        MOZ_TRY(child->GetId(&childId));
        NS_ENSURE_TRUE(childIds.Contains(childId) && !seen.Contains(childId),
                       NS_ERROR_NOT_AVAILABLE);
        seen.Insert(childId);
        children.AppendElement(child);
      }
      NS_ENSURE_TRUE(seen.Count() == childIds.Length(), NS_ERROR_NOT_AVAILABLE);
      retired.AppendElement(nsMsgDBFolder::FolderInitialization{
          folder, nullptr, std::move(children)});
      for (nsIMsgFolder* child : folder->mSubFolders)
        MOZ_TRY(capture(static_cast<nsMsgDBFolder*>(child)));
      return NS_OK;
    };
    nsTArray<uint64_t> priorIds =
        MOZ_TRY(mFolderDatabase->GetFolderChildren(parentId));
    nsTHashSet<uint64_t> seen;
    for (nsIMsgFolder* child : nativeParent->mSubFolders) {
      uint64_t id;
      MOZ_TRY(child->GetId(&id));
      NS_ENSURE_TRUE(priorIds.Contains(id) && !seen.Contains(id),
                     NS_ERROR_NOT_AVAILABLE);
      seen.Insert(id);
      if (names.Contains(MOZ_TRY(mFolderDatabase->GetFolderName(id)))) continue;
      MOZ_TRY(capture(static_cast<nsMsgDBFolder*>(child)));
      detached.AppendElement(child);
    }
    NS_ENSURE_TRUE(seen.Count() == priorIds.Length(), NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsIFolderLookupService> lookup =
        do_GetService("@mozilla.org/mail/folder-lookup;1");
    NS_ENSURE_TRUE(lookup, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(CheckProfileStartup(ProfileStartupToken(), true));
    MOZ_TRY(mFolderDatabase->ReconcileCacheDiscoveryChildren(operation.sourceId,
                                                             parentId, names));
    // Evict and invalidate only the superseded native wrappers using existing
    // initialization rollback. Normal factories below attach the newly
    // discovered logical children with their separately retained physical path.
    nsMsgDBFolder::RollbackFolderInitialization(lookup, retired);
    for (const auto& child : detached)
      nativeParent->mSubFolders.RemoveObject(child);
    return CheckProfileStartup(ProfileStartupToken(), true);
  };
  nsTHashMap<uint64_t, nsCString> physical;
  nsTHashMap<nsCString, nsCOMPtr<nsIMsgFolder>> localBindings;
  for (const auto* source : local) {
    auto root = roots.Lookup(source->serverKey);
    NS_ENSURE_TRUE(root, NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsIMsgFolder> parent = root.Data();
    nsCOMPtr<nsIMsgPluggableStore> store;
    MOZ_TRY(parent->GetMsgStore(getter_AddRefs(store)));
    NS_ENSURE_TRUE(store, NS_ERROR_NOT_AVAILABLE);
    for (uint32_t i = 0; i < source->localNames.Length(); ++i) {
      nsTArray<nsCString> children;
      MOZ_TRY(store->DiscoverChildFolders(parent, children));
      NS_ENSURE_TRUE(children.Contains(DecodeFilename(
                         NS_ConvertUTF8toUTF16(source->localLeaves[i]))),
                     NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(reconcileLocal(parent, *source, i, children));
      nsCOMPtr<nsIFile> path;
      MOZ_TRY(parent->GetFilePath(getter_AddRefs(path)));
      bool server;
      MOZ_TRY(parent->GetIsServer(&server));
      if (!server) {
        nsAutoString leaf;
        MOZ_TRY(path->GetLeafName(leaf));
        MOZ_TRY(path->SetLeafName(leaf + u".sbd"_ns));
      }
      MOZ_TRY(path->AppendNative(source->localLeaves[i]));
      nsCString actual;
      MOZ_TRY(GetComparablePath(path, actual));
      nsCOMPtr<nsIMsgFolder> child;
      MOZ_TRY(
          parent->GetChildNamed(source->localNames[i], getter_AddRefs(child)));
      if (!child)
        MOZ_TRY(
            parent->AddSubfolder(source->localNames[i], getter_AddRefs(child)));
      NS_ENSURE_TRUE(child, NS_ERROR_NOT_AVAILABLE);
      nsCString name;
      MOZ_TRY(child->GetName(name));
      // Use the same NFC spelling as native InsertFolder. Physical discovery
      // and the retained leaf remain independent of this logical normalization.
      nsCString retainedName =
          MOZ_TRY(DatabaseUtils::Normalize(source->localNames[i]));
      bool canonical =
          server &&
          ((name == "Inbox"_ns &&
            retainedName.LowerCaseEqualsLiteral("inbox")) ||
           (name == "Unsent Messages"_ns &&
            retainedName.LowerCaseEqualsLiteral("unsent messages")) ||
           (name == "Drafts"_ns &&
            retainedName.LowerCaseEqualsLiteral("drafts")) ||
           (name == "Trash"_ns &&
            retainedName.LowerCaseEqualsLiteral("trash")) ||
           (name == "Sent"_ns && retainedName.LowerCaseEqualsLiteral("sent")) ||
           (name == "Templates"_ns &&
            retainedName.LowerCaseEqualsLiteral("templates")) ||
           (name == "Archives"_ns &&
            retainedName.LowerCaseEqualsLiteral("archives")));
      NS_ENSURE_TRUE(name == retainedName || canonical, NS_ERROR_NOT_AVAILABLE);
      uint64_t id;
      MOZ_TRY(child->GetId(&id));
      NS_ENSURE_TRUE(id, NS_ERROR_NOT_AVAILABLE);
      if (auto prior = physical.Lookup(id))
        NS_ENSURE_TRUE(prior.Data() == actual, NS_ERROR_NOT_AVAILABLE);
      physical.InsertOrUpdate(id, actual);
      MOZ_TRY(child->SetFilePath(path));
      operation.localFolders.AppendElement(child);
      parent = child;
    }
    localBindings.InsertOrUpdate(source->id, parent);
  }
  nsTArray<const StartupMailSource*> imap;
  for (const auto& source : operation.sources)
    if (source.protocol == "imap"_ns) imap.AppendElement(&source);
  // Parents precede children. A missing parent was refused before creation.
  imap.Sort([](const StartupMailSource* a, const StartupMailSource* b) {
    return Compare(a->canonicalPath, b->canonicalPath);
  });
  for (const auto* source : imap) {
    auto root = roots.Lookup(source->serverKey);
    NS_ENSURE_TRUE(root, NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsIMsgImapMailFolder> provider = do_QueryInterface(root.Data());
    NS_ENSURE_TRUE(provider, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(provider->CreateClientSubfolderInfo(
        source->canonicalPath, source->delimiter, int32_t(source->boxFlags),
        true));
  }
  nsTHashSet<uint64_t> ids;
  for (const auto& source : operation.sources) {
    auto root = roots.Lookup(source.serverKey);
    NS_ENSURE_TRUE(root, NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsIMsgFolder> folder = root.Data();
    if (source.protocol == "none"_ns) {
      auto binding = localBindings.Lookup(source.id);
      NS_ENSURE_TRUE(binding, NS_ERROR_NOT_AVAILABLE);
      folder = binding.Data();
    } else {
      for (const auto& part : source.canonicalPath.Split('/')) {
        nsCOMPtr<nsIMsgFolder> child;
        MOZ_TRY(folder->GetChildNamed(part, getter_AddRefs(child)));
        NS_ENSURE_TRUE(child, NS_ERROR_NOT_AVAILABLE);
        folder = child;
      }
      nsCOMPtr<nsIMsgImapMailFolder> imapFolder = do_QueryInterface(folder);
      NS_ENSURE_TRUE(imapFolder, NS_ERROR_NOT_AVAILABLE);
      nsCString online;
      char delimiter;
      MOZ_TRY(imapFolder->GetOnlineName(online));
      MOZ_TRY(imapFolder->GetHierarchyDelimiter(&delimiter));
      NS_ENSURE_TRUE(
          online == source.onlineName && delimiter == source.delimiter,
          NS_ERROR_NOT_AVAILABLE);
    }
    nsCOMPtr<nsIFile> summary, store;
    MOZ_TRY(folder->GetSummaryFile(getter_AddRefs(summary)));
    MOZ_TRY(folder->GetFilePath(getter_AddRefs(store)));
    nsCString summaryPath, storePath;
    MOZ_TRY(GetComparablePath(summary, summaryPath));
    MOZ_TRY(GetComparablePath(store, storePath));
    NS_ENSURE_TRUE(summaryPath == source.path && storePath == source.storePath,
                   NS_ERROR_NOT_AVAILABLE);
    uint64_t id;
    MOZ_TRY(folder->GetId(&id));
    NS_ENSURE_TRUE(id && !ids.Contains(id), NS_ERROR_NOT_AVAILABLE);
    ids.Insert(id);
    if (source.originalFlags) {
      // Public GetFlags opens a message database and reads counts/new state.
      // Startup admits only metadata until the complete import is ready.
      uint32_t before = MOZ_TRY(mFolderDatabase->GetFolderFlags(id));
      const uint32_t wanted =
          source.protocol == "imap"_ns
              ? (*source.originalFlags & ~nsMsgFolderFlags::OfflineEvents) |
                    (before & nsMsgFolderFlags::OfflineEvents)
              : *source.originalFlags;
      const uint32_t protocolMask =
          nsMsgFolderFlags::Newsgroup | nsMsgFolderFlags::Virtual |
          nsMsgFolderFlags::ImapBox | nsMsgFolderFlags::ImapPersonal |
          nsMsgFolderFlags::ImapPublic | nsMsgFolderFlags::ImapOtherUser |
          nsMsgFolderFlags::ImapNoselect | nsMsgFolderFlags::ImapNoinferiors;
      NS_ENSURE_TRUE(!((wanted ^ before) & protocolMask) &&
                         !(before & nsMsgFolderFlags::SpecialUse & ~wanted),
                     NS_ERROR_NOT_AVAILABLE);
      if (wanted != before) {
        auto connection = sConnection;
        NS_ENSURE_TRUE(connection && !mShuttingDown, NS_ERROR_NOT_AVAILABLE);
        bool active;
        MOZ_TRY(connection->GetTransactionInProgress(&active));
        NS_ENSURE_FALSE(active, NS_ERROR_IN_PROGRESS);
        MOZ_TRY(connection->BeginTransaction());
        auto apply = [&]() -> nsresult {
          MOZ_TRY(CheckProfileStartup(ProfileStartupToken(), true));
          NS_ENSURE_TRUE(sConnection == connection, NS_ERROR_NOT_AVAILABLE);
          FolderDatabase::CacheOrigin origin;
          MOZ_TRY(mFolderDatabase->CheckCacheProjectionOrigin(id, origin));
          NS_ENSURE_TRUE(MOZ_TRY(mFolderDatabase->GetFolderFlags(id)) == before,
                         NS_ERROR_NOT_AVAILABLE);
          nsCString measured;
          MOZ_TRY(StartupHash(summary, measured));
          NS_ENSURE_TRUE(measured == source.hash, NS_ERROR_NOT_AVAILABLE);
          MOZ_TRY(mFolderDatabase->WriteCacheFolderFlags(id, wanted));
          NS_ENSURE_TRUE(origin.revision < INT64_MAX - 1,
                         NS_ERROR_ILLEGAL_VALUE);
          ++origin.revision;
          MOZ_TRY(mFolderDatabase->WriteCacheOrigin(origin));
          MOZ_TRY(CheckProfileStartup(ProfileStartupToken(), true));
          NS_ENSURE_TRUE(sConnection == connection, NS_ERROR_NOT_AVAILABLE);
          return NS_OK;
        };
        nsresult rv = apply();
        if (NS_SUCCEEDED(rv)) rv = connection->CommitTransaction();
        if (NS_FAILED(rv)) {
          (void)connection->RollbackTransaction();
          return rv;
        }
        static_cast<nsMsgDBFolder*>(folder.get())
            ->PublishCacheImportFlags(wanted);
      }
    }
    operation.sourceIds.AppendElement(source.id);
    operation.folders.AppendElement(folder);
  }
  // Retain only empty physical files first observed during actual native root
  // construction. Final coverage additionally needs an exact cache root
  // receipt.
  operation.createdEmptyStores.Clear();
  for (const auto& server : operation.servers) {
    if (server.protocol != "none"_ns) continue;
    nsCOMPtr<nsIFile> root;
    MOZ_TRY(NS_NewNativeLocalFile(server.path, getter_AddRefs(root)));
    nsTArray<nsCString> files;
    MOZ_TRY(StartupInventory(root, files, true, false));
    for (const auto& path : files) {
      if (operation.backupFiles.Contains(path)) continue;
      nsCOMPtr<nsIFile> file;
      MOZ_TRY(StartupContained(operation.profile, path, getter_AddRefs(file)));
      int64_t size;
      MOZ_TRY(file->GetFileSize(&size));
      if (size) continue;
      nsCString hash;
      MOZ_TRY(StartupHash(file, hash));
      operation.createdEmptyStores.InsertOrUpdate(path, hash);
    }
  }
  return NS_OK;
}

NS_IMETHODIMP DatabaseCore::BeginProfileStartup(JSContext* cx,
                                                Promise** output) {
  NS_ENSURE_TRUE(NS_IsMainThread(), NS_ERROR_NOT_AVAILABLE);
  // app-startup may already have settled a failed native selection. Its first
  // consumer must still receive that failure, rather than a shutdown refusal.
  const bool failedSelection = NS_FAILED(mStartupFailure);
  NS_ENSURE_TRUE(!mShuttingDown || failedSelection, NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(
      !mStartupBeginRequested && (failedSelection || mProfileStartup ||
                                  (!sConnection && !mStartupObserved)),
      NS_ERROR_NOT_AVAILABLE);
  mStartupBeginRequested = true;
  mStartupManaged = true;
  ErrorResult error;
  RefPtr<Promise> promise =
      Promise::Create(xpc::CurrentNativeGlobal(cx), error);
  if (error.Failed()) return error.StealNSResult();
  if (NS_FAILED(mStartupFailure)) {
    promise->MaybeReject(mStartupFailure);
  } else if (!mProfileStartup) {
    if (mStartupObserved)
      promise->MaybeReject(NS_ERROR_NOT_AVAILABLE);
    else
      mStartupBegins.AppendElement(promise);
  } else {
    JS::Rooted<JS::Value> descriptor(cx);
    nsresult rv = DescribeProfileStartup(cx, &descriptor);
    if (NS_FAILED(rv))
      promise->MaybeReject(rv);
    else
      promise->MaybeResolve(ProfileStartupToken());
  }
  promise.forget(output);
  return NS_OK;
}
NS_IMETHODIMP DatabaseCore::ValidateProfileStartup(
    nsISupports* token, JSContext* cx, JS::MutableHandle<JS::Value> output) {
  MOZ_TRY(CheckProfileStartup(token));
  return DescribeProfileStartup(cx, output);
}
NS_IMETHODIMP DatabaseCore::OpenProfileStartupTarget(
    nsISupports* token, JS::Handle<JS::Value> plan, JSContext* cx,
    JS::MutableHandle<JS::Value> output) {
  MOZ_TRY(CheckProfileStartup(token));
  JS::Rooted<JS::Value> ignored(cx);
  MOZ_TRY(DescribeProfileStartup(cx, &ignored));
  nsresult rv = OpenProfileStartup(cx, plan);
  if (NS_FAILED(rv)) {
    mProfileStartup->Remember(rv);
    return rv;
  }
  return DescribeProfileStartup(cx, output);
}

namespace {
class StartupStorageClosed final : public mozIStorageCompletionCallback {
 public:
  NS_DECL_ISUPPORTS
  explicit StartupStorageClosed(std::function<void(nsresult)> complete)
      : mComplete(std::move(complete)) {}
  NS_IMETHOD Complete(nsresult status, nsISupports*) override {
    if (mComplete) {
      auto complete = std::move(mComplete);
      complete(status);
    }
    return NS_OK;
  }

 private:
  ~StartupStorageClosed() = default;
  std::function<void(nsresult)> mComplete;
};
NS_IMPL_ISUPPORTS(StartupStorageClosed, mozIStorageCompletionCallback)
}  // namespace

nsresult DatabaseCore::SettleProfileStartup(nsresult failure) {
  NS_ENSURE_TRUE(mProfileStartup && NS_IsMainThread(), NS_ERROR_NOT_AVAILABLE);
  RefPtr<ProfileStartupOperation> operation = mProfileStartup;
  operation->Remember(failure);
  if (operation->settled || mStartupClosePending) return NS_OK;
  NS_ENSURE_FALSE(operation->busy, NS_ERROR_IN_PROGRESS);
  // Only the real, already initialized account owner is retained. Calling its
  // existing blocker closes server/root work synchronously before SQL close;
  // this never constructs an account service during failure or shutdown.
  nsCOMPtr<nsIAsyncShutdownBlocker> account = mStartupAccount.forget();
  if (account) {
    AutoRestore<bool> busy(operation->busy);
    operation->busy = true;
    operation->Remember(account->BlockShutdown(operation->barrier));
  }
  operation->closing = true;
  mShuttingDown = true;
  nsTArray<RefPtr<nsIMsgDatabase>> databases;
  operation->Remember(GetOpenDBs(databases));
  for (const auto& database : databases)
    operation->Remember(database->ForceClosed());
  mOpenDatabases.Clear();
  mOpenDatabasesByFile.Clear();
  for (auto iter = sStatements.Iter(); !iter.Done(); iter.Next()) {
    operation->Remember(iter.UserData()->Finalize());
  }
  sStatements.Clear();
  mFolderRelocationRecoveries.Clear();
  mFolderDatabase = nullptr;
  if (mMessageDatabase) mMessageDatabase->Shutdown();
  mMessageDatabase = nullptr;
  operation->folders.Clear();
  operation->localFolders.Clear();
  operation->sourceIds.Clear();
  RefPtr<DatabaseCore> self = this;
  auto finished = [self, operation](nsresult closeError) {
    operation->closeError = closeError;
    operation->Remember(closeError);
    if (NS_FAILED(closeError)) {
      MOZ_LOG(gPanoramaLog, LogLevel::Error,
              ("Startup native close failed: 0x%08x (first 0x%08x)",
               unsigned(closeError), unsigned(operation->firstError)));
    }
    self->mStartupClosePending = false;
    // SQLite has actually completed close before any lease/barrier is released.
    // A callback failure is retained, never reported as a successful close.
#ifndef XP_WIN
    for (int* fd :
         {&operation->databaseFD, &operation->profileFD, &operation->localFD}) {
      if (*fd >= 0) {
        if (close(*fd) && NS_SUCCEEDED(operation->closeError))
          operation->closeError = NS_ERROR_FAILURE;
        *fd = -1;
      }
    }
#else
    for (auto* lease : {&operation->databaseLease, &operation->profileLease,
                        &operation->localLease}) {
      if (*lease) {
        if (NS_FAILED((*lease)->Close()) && NS_SUCCEEDED(operation->closeError))
          operation->closeError = NS_ERROR_FAILURE;
        *lease = nullptr;
      }
    }
#endif
    operation->Remember(operation->closeError);
    operation->settled = true;
    operation->onShutdown = {};
    if (operation->barrier) {
      operation->Remember(operation->barrier->RemoveBlocker(operation));
      operation->barrier = nullptr;
    }
    for (const auto& promise : operation->settlements) {
      if (NS_FAILED(operation->closeError))
        promise->MaybeReject(operation->firstError);
      else
        promise->MaybeResolveWithUndefined();
    }
    operation->settlements.Clear();
    // Preserve a failed ready operation's first error until the ordinary
    // profile-before-change observer retires the already settled owner.
    if (operation->ready && NS_SUCCEEDED(operation->firstError)) {
      nsCOMPtr<nsIObserverService> observers = services::GetObserverService();
      if (observers) observers->RemoveObserver(self, "profile-before-change");
      if (sInstance == self) sInstance = nullptr;
    }
  };
  if (sConnection) {
    nsCOMPtr<mozIStorageConnection> closing = sConnection;
    RefPtr<StartupStorageClosed> callback = new StartupStorageClosed(finished);
    mStartupClosePending = true;
    nsresult rv = closing->AsyncClose(callback);
    if (NS_FAILED(rv)) {
      mStartupClosePending = false;
      operation->closeError = rv;
      operation->Remember(rv);
      // Failed scheduling is not close completion. Keep the actual connection
      // and blocker for a subsequent explicit settlement attempt.
      return rv;
    }
    sConnection = nullptr;
  } else {
    finished(NS_OK);
  }
  return NS_OK;
}

nsresult DatabaseCore::CheckStartupCachePublication(JSContext* cx,
                                                    const CacheImport& input) {
  MOZ_TRY(CheckProfileStartup(ProfileStartupToken()));
  auto& operation = *mProfileStartup;
  NS_ENSURE_TRUE(operation.opened && !operation.ready &&
                     operation.mode == "migrate"_ns &&
                     operation.profilePath == input.profilePath &&
                     operation.sourceId == input.databaseId &&
                     operation.backupPath == input.manifestPath &&
                     operation.backupHash == input.manifestSha256,
                 NS_ERROR_NOT_AVAILABLE);
  JS::Rooted<JSObject*> selector(cx), identity(cx), backup(cx);
  MOZ_TRY(StartupSelector(cx, operation, &selector));
  NS_ENSURE_TRUE(selector, NS_ERROR_NOT_AVAILABLE);
  nsCString state, origin, journalPath;
  MOZ_TRY(StartupText(cx, selector, "state", state));
  MOZ_TRY(StartupText(cx, selector, "origin", origin));
  MOZ_TRY(StartupObject(cx, selector, "identity", &identity));
  MOZ_TRY(StartupText(cx, identity, "journalPath", journalPath));
  NS_ENSURE_TRUE(state == "prepared"_ns && origin == "migrated"_ns &&
                     journalPath == operation.journalPath,
                 NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(StartupObject(cx, identity, "backup", &backup));
  MOZ_TRY(StartupBackup(cx, operation, backup));
  nsCOMPtr<nsIFile> journalFile;
  MOZ_TRY(
      StartupJournalFile(operation, journalPath, getter_AddRefs(journalFile)));
  JS::Rooted<JSObject*> journal(cx), startup(cx), units(cx);
  MOZ_TRY(StartupReadJSON(cx, journalFile, &journal));
  MOZ_TRY(StartupObject(cx, journal, "startup", &startup));
  nsCString databaseSource, stage;
  MOZ_TRY(StartupText(cx, startup, "databaseSourceId", databaseSource));
  MOZ_TRY(StartupText(cx, journal, "stage", stage));
  JS::Rooted<JS::Value> cancelled(cx);
  MOZ_TRY(ImportMember(cx, journal, "cancelled", &cancelled));
  NS_ENSURE_TRUE(databaseSource == input.databaseId &&
                     (stage == "import"_ns || stage == "validate"_ns) &&
                     cancelled.isBoolean() && !cancelled.toBoolean(),
                 NS_ERROR_NOT_AVAILABLE);
  uint32_t count;
  MOZ_TRY(StartupArray(cx, journal, "caches", &units, count));
  bool found = false;
  for (uint32_t i = 0; i < count; ++i) {
    JS::Rooted<JSObject*> unit(cx);
    MOZ_TRY(StartupItem(cx, units, i, &unit));
    nsCString token, source, path, hash;
    MOZ_TRY(StartupText(cx, unit, "token", token));
    if (token != input.token) continue;
    MOZ_TRY(StartupText(cx, unit, "id", source));
    MOZ_TRY(StartupText(cx, unit, "path", path));
    MOZ_TRY(StartupText(cx, unit, "sha256", hash));
    NS_ENSURE_TRUE(!found && source == input.sourceId && path == input.path &&
                       hash == input.sha256,
                   NS_ERROR_NOT_AVAILABLE);
    if (input.version == 3) {
      int64_t version;
      nsCString format;
      MOZ_TRY(StartupNumber(cx, unit, "requestVersion", 3, 3, version));
      MOZ_TRY(StartupText(cx, unit, "sourceFormat", format));
      NS_ENSURE_TRUE(format == "json"_ns, NS_ERROR_NOT_AVAILABLE);
    }
    found = true;
  }
  NS_ENSURE_TRUE(found, NS_ERROR_NOT_AVAILABLE);
  return CheckProfileStartup(ProfileStartupToken());
}

// A stack-owned binding map is installed only after durable activation
// readback. Folder construction must use it before discovery can reconcile a
// legacy physical spelling against the committed logical hierarchy.
nsresult DatabaseCore::BindStartupFolderPath(uint64_t folderId,
                                             nsCOMPtr<nsIFile>& path) {
  if (!mStartupLocalPaths) return NS_OK;
  MOZ_TRY(CheckProfileStartup(ProfileStartupToken(), true));
  NS_ENSURE_TRUE(mStartupMetadataDepth && mProfileStartup->busy &&
                     mProfileStartup->opened && !mProfileStartup->ready &&
                     mProfileStartup->mode == "reuse"_ns,
                 NS_ERROR_NOT_AVAILABLE);
  auto retained = mStartupLocalPaths->Lookup(folderId);
  if (!retained) return NS_OK;
  uint64_t root = MOZ_TRY(mFolderDatabase->GetFolderRoot(folderId));
  nsCString key = MOZ_TRY(mFolderDatabase->GetFolderName(root));
  nsCOMPtr<nsIMsgAccountManager> accounts =
      do_GetService("@mozilla.org/messenger/account-manager;1");
  NS_ENSURE_TRUE(accounts, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIMsgIncomingServer> server;
  MOZ_TRY(accounts->GetIncomingServer(key, getter_AddRefs(server)));
  NS_ENSURE_TRUE(server, NS_ERROR_NOT_AVAILABLE);
  nsCString protocol, contract;
  MOZ_TRY(server->GetType(protocol));
  MOZ_TRY(server->GetStringValue("storeContractID", contract));
  if (contract.IsEmpty())
    contract.AssignLiteral("@mozilla.org/msgstore/berkeleystore;1");
  NS_ENSURE_TRUE(protocol == "none"_ns, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIFile> selected, localPath, serverPath, parent;
  MOZ_TRY(NS_NewNativeLocalFile(retained.Data(), getter_AddRefs(selected)));
  MOZ_TRY(server->GetLocalPath(getter_AddRefs(localPath)));
  MOZ_TRY(StartupCanonicalRoot(localPath, getter_AddRefs(serverPath)));
  bool inside;
  MOZ_TRY(serverPath->Contains(selected, &inside));
  NS_ENSURE_TRUE(inside, NS_ERROR_FILE_ACCESS_DENIED);
  MOZ_TRY(selected->GetParent(getter_AddRefs(parent)));
  nsCString physicalParent;
  MOZ_TRY(StartupDirectory(parent, physicalParent));
  MOZ_TRY(CheckStartupMailStore(retained.Data(), contract, false));
  MOZ_TRY(CheckProfileStartup(ProfileStartupToken(), true));
  path = selected;
  return NS_OK;
}

nsresult DatabaseCore::BindStartupChildNames(uint64_t parentId,
                                             nsIFile* parentPath,
                                             nsTArray<nsCString>& childNames) {
  if (!mStartupLocalPaths) return NS_OK;
  MOZ_TRY(CheckProfileStartup(ProfileStartupToken(), true));
  nsTArray<uint64_t> children =
      MOZ_TRY(mFolderDatabase->GetFolderChildren(parentId));
  nsTArray<nsCString> names = childNames.Clone();
  nsTHashSet<uint32_t> bound;
  nsCOMPtr<nsIFile> directory;
  MOZ_TRY(parentPath->Clone(getter_AddRefs(directory)));
  if (MOZ_TRY(mFolderDatabase->GetFolderParent(parentId))) {
    nsCString leaf;
    MOZ_TRY(directory->GetNativeLeafName(leaf));
    MOZ_TRY(directory->SetNativeLeafName(leaf + ".sbd"_ns));
  }
  for (uint64_t id : children) {
    if (!mStartupLocalPaths->Contains(id)) continue;
    nsCOMPtr<nsIFile> physical, parent;
    MOZ_TRY(BindStartupFolderPath(id, physical));
    NS_ENSURE_TRUE(physical, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(physical->GetParent(getter_AddRefs(parent)));
    nsCString expected, actual, leaf;
    MOZ_TRY(GetComparablePath(directory, expected));
    MOZ_TRY(GetComparablePath(parent, actual));
    NS_ENSURE_TRUE(actual == expected, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(physical->GetNativeLeafName(leaf));
    nsCString decoded = DecodeFilename(NS_ConvertUTF8toUTF16(leaf));
    uint32_t matches = 0, index = 0;
    for (uint32_t n = 0; n < childNames.Length(); ++n) {
      if (childNames[n] != decoded) continue;
      ++matches;
      index = n;
    }
    NS_ENSURE_TRUE(matches == 1 && !bound.Contains(index),
                   NS_ERROR_NOT_AVAILABLE);
    bound.Insert(index);
    names[index] = MOZ_TRY(mFolderDatabase->GetFolderName(id));
  }
  if (!bound.Count()) return NS_OK;
  // A second physical child must not alias a retained committed logical row.
  for (uint32_t i = 0; i < names.Length(); ++i) {
    names[i] = MOZ_TRY(DatabaseUtils::Normalize(names[i]));
    for (uint32_t j = 0; j < i; ++j)
      NS_ENSURE_FALSE(
          names[i].Equals(names[j], nsCaseInsensitiveUTF8StringComparator),
          NS_ERROR_NOT_AVAILABLE);
  }
  MOZ_TRY(CheckProfileStartup(ProfileStartupToken(), true));
  childNames = std::move(names);
  return NS_OK;
}

// Do not use GetDirectory's failure as an absence signal: it also reports
// malformed state and service errors. Enumerate actual registrations and check
// all overlapping identity fields before treating ordinary deletion as retired.
nsresult DatabaseCore::ReadStartupReusedBookDirectory(nsIFile* target,
                                                      const nsACString& pref,
                                                      const nsACString& uri,
                                                      const nsACString& uid,
                                                      nsIAbDirectory** output) {
  *output = nullptr;
  nsCOMPtr<nsIFile> parent;
  MOZ_TRY(target->GetParent(getter_AddRefs(parent)));
  nsCString parentPath, fileName;
  MOZ_TRY(StartupDirectory(parent, parentPath));
  MOZ_TRY(target->GetNativeLeafName(fileName));
  bool linked;
  nsresult status = target->IsSymlink(&linked);
  const bool missing = status == NS_ERROR_FILE_NOT_FOUND;
  if (!missing) {
    MOZ_TRY(status);
    NS_ENSURE_FALSE(linked, NS_ERROR_FILE_ACCESS_DENIED);
    MOZ_TRY(StartupRegular(target));
  }
  // Inspect the physical/pref pair before initializing AbManager: a cold
  // SQLite directory initializer may otherwise recreate a missing live file.
  nsresult service;
  nsCOMPtr<nsIPrefBranch> prefs =
      do_GetService("@mozilla.org/preferences-service;1", &service);
  MOZ_TRY(service);
  NS_ENSURE_TRUE(prefs, NS_ERROR_NOT_AVAILABLE);
  nsTArray<nsCString> names;
  const nsCString branch(pref + "."_ns);
  MOZ_TRY(prefs->GetChildList(branch.get(), names));
  const bool missingPrefs = names.IsEmpty();
  NS_ENSURE_TRUE(missing == missingPrefs, NS_ERROR_NOT_AVAILABLE);
  auto checkPrefs = [&]() -> nsresult {
    nsCString configured;
    const nsCString filenamePref(branch + "filename"_ns);
    MOZ_TRY(prefs->GetCharPref(filenamePref.get(), configured));
    NS_ENSURE_TRUE(configured == fileName, NS_ERROR_NOT_AVAILABLE);
    const nsCString uidPref(branch + "uid"_ns), typePref(branch + "dirType"_ns);
    MOZ_TRY(prefs->GetCharPref(uidPref.get(), configured));
    int32_t type;
    MOZ_TRY(prefs->GetIntPref(typePref.get(), &type));
    NS_ENSURE_TRUE(configured == uid && type == nsIAbManager::JS_DIRECTORY_TYPE,
                   NS_ERROR_NOT_AVAILABLE);
    return NS_OK;
  };
  if (!missing) MOZ_TRY(checkPrefs());
  nsTArray<nsCString> reservations;
  MOZ_TRY(prefs->GetChildList("ldap_2.servers.", reservations));
  for (const auto& name : reservations) {
    if (StringBeginsWith(name, branch)) continue;
    const bool filename = StringEndsWith(name, ".filename"_ns);
    if (!filename && !StringEndsWith(name, ".uid"_ns)) continue;
    nsCString value;
    MOZ_TRY(prefs->GetCharPref(name.get(), value));
    NS_ENSURE_TRUE((filename ? value != fileName : value != uid),
                   NS_ERROR_NOT_AVAILABLE);
  }
  nsCOMPtr<nsIAbManager> manager =
      do_GetService("@mozilla.org/abmanager;1", &service);
  MOZ_TRY(service);
  NS_ENSURE_TRUE(manager, NS_ERROR_NOT_AVAILABLE);
  nsTArray<RefPtr<nsIAbDirectory>> directories;
  MOZ_TRY(manager->GetDirectories(directories));
  nsCOMPtr<nsIAbDirectory> found;
  for (const auto& directory : directories) {
    nsCString actualPref, actualUri, actualUid, actualFile;
    MOZ_TRY(directory->GetDirPrefId(actualPref));
    MOZ_TRY(directory->GetURI(actualUri));
    MOZ_TRY(directory->GetUID(actualUid));
    MOZ_TRY(directory->GetFileName(actualFile));
    if (actualPref == pref || actualUri == uri || actualUid == uid ||
        actualFile == fileName) {
      NS_ENSURE_TRUE(!found && actualPref == pref && actualUri == uri &&
                         actualUid == uid && actualFile == fileName,
                     NS_ERROR_NOT_AVAILABLE);
      found = directory;
    }
  }
  names.Clear();
  MOZ_TRY(prefs->GetChildList(branch.get(), names));
  NS_ENSURE_TRUE(missingPrefs == names.IsEmpty(), NS_ERROR_NOT_AVAILABLE);
  // Ordinary deletion clears the preference branch, unregisters the directory,
  // and removes its closed file. Any partial state remains a startup error.
  if (missing && !found) {
    // Service initialization must not turn an earlier ENOENT into permission to
    // overlook a new occupant or a replaced physical parent.
    MOZ_TRY(StartupDirectory(parent, parentPath));
    status = target->IsSymlink(&linked);
    if (status == NS_ERROR_FILE_NOT_FOUND) return NS_OK;
    MOZ_TRY(status);
    return NS_ERROR_NOT_AVAILABLE;
  }
  NS_ENSURE_TRUE(!missing && found, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(checkPrefs());
  found.forget(output);
  return NS_OK;
}

nsresult DatabaseCore::CheckProfileActivation(
    JSContext* cx, JS::Handle<JS::Value> activation) {
  MOZ_TRY(CheckProfileStartup(ProfileStartupToken()));
  auto& operation = *mProfileStartup;
  NS_ENSURE_TRUE(operation.opened && !operation.ready, NS_ERROR_NOT_AVAILABLE);
  if (operation.mode == "legacy"_ns) {
    NS_ENSURE_TRUE(activation.isNull() && !sConnection, NS_ERROR_INVALID_ARG);
    return NS_OK;
  }
  NS_ENSURE_TRUE(sConnection && activation.isObject(), NS_ERROR_NOT_AVAILABLE);
  bool transaction;
  MOZ_TRY(sConnection->GetTransactionInProgress(&transaction));
  NS_ENSURE_FALSE(transaction, NS_ERROR_IN_PROGRESS);
  nsCString current;
  int32_t version;
  MOZ_TRY(GetSourceId(current));
  MOZ_TRY(sConnection->GetSchemaVersion(&version));
  NS_ENSURE_TRUE(current == operation.sourceId && version == operation.schema,
                 NS_ERROR_NOT_AVAILABLE);
  AutoRestore<bool> busy(operation.busy);
  operation.busy = true;
  JS::Rooted<JSObject*> selector(cx), identity(cx);
  MOZ_TRY(StartupSelector(cx, operation, &selector, true));
  MOZ_TRY(StartupObject(cx, selector, "identity", &identity));
  nsCString selectedSource, origin;
  int64_t selectedVersion;
  MOZ_TRY(StartupText(cx, selector, "origin", origin));
  MOZ_TRY(StartupText(cx, identity, "databaseSourceId", selectedSource));
  MOZ_TRY(StartupNumber(cx, identity, "schemaVersion", 0, 21, selectedVersion));
  NS_ENSURE_TRUE(selectedSource == current && selectedVersion == version,
                 NS_ERROR_NOT_AVAILABLE);
  JS::Rooted<JSObject*> caller(cx, &activation.toObject());
  nsCString profile, selectorPath;
  MOZ_TRY(StartupText(cx, caller, "profilePath", profile));
  MOZ_TRY(StartupText(cx, caller, "selectorPath", selectorPath));
  // The caller joins with the platform separator (PathUtils.join).
#ifdef XP_WIN
  constexpr auto selectorLeaf = "\\panorama-profile.json"_ns;
#else
  constexpr auto selectorLeaf = "/panorama-profile.json"_ns;
#endif
  NS_ENSURE_TRUE(profile == operation.profilePath &&
                     selectorPath.Equals(profile + selectorLeaf),
                 NS_ERROR_NOT_AVAILABLE);
  JS::Rooted<JS::Value> declaredJournal(cx);
  MOZ_TRY(ImportMember(cx, identity, "journalPath", &declaredJournal));
  JS::Rooted<JS::Value> callerJournal(cx);
  MOZ_TRY(ImportMember(cx, caller, "journalPath", &callerJournal));
  MOZ_TRY(StartupEqual(cx, callerJournal, declaredJournal));
  const bool reusing =
      operation.mode == "reuse"_ns && !operation.initialSelector.IsEmpty();
  if (reusing) {
    JS::Rooted<JS::Value> original(cx);
    MOZ_TRY(StartupParse(cx, operation.initialSelector, &original));
    JS::Rooted<JSObject*> initial(cx, &original.toObject()), priorIdentity(cx);
    MOZ_TRY(StartupObject(cx, initial, "identity", &priorIdentity));
    MOZ_TRY(StartupFieldsEqual(cx, initial, selector,
                               {"backend", "origin", "application"}));
    MOZ_TRY(
        StartupFieldsEqual(cx, priorIdentity, identity,
                           {"profilePath", "databaseSourceId", "journalPath",
                            "backup", "imports", "books", "caches"}));
    JS::Rooted<JSObject*> beforeSummaries(cx), afterSummaries(cx);
    uint32_t beforeCount, afterCount;
    MOZ_TRY(StartupArray(cx, priorIdentity, "serverSummaries", &beforeSummaries,
                         beforeCount, true));
    MOZ_TRY(StartupArray(cx, identity, "serverSummaries", &afterSummaries,
                         afterCount, true));
    JS::Rooted<JS::Value> before(cx, JS::ObjectValue(*beforeSummaries)),
        after(cx, JS::ObjectValue(*afterSummaries));
    MOZ_TRY(StartupEqual(cx, before, after));
    // An unchanged selector does not prove durable recovery state.
  }
  if (origin != "migrated"_ns) {
    NS_ENSURE_TRUE(
        (origin == "initialized-empty"_ns &&
         operation.mode == "initialize"_ns) ||
            (origin == "adopted-existing"_ns && operation.mode == "reuse"_ns) ||
            (!operation.initialSelector.IsEmpty() &&
             operation.mode == "reuse"_ns),
        NS_ERROR_NOT_AVAILABLE);
    NS_ENSURE_TRUE(declaredJournal.isNull(), NS_ERROR_NOT_AVAILABLE);
    JS::Rooted<JS::Value> backup(cx);
    MOZ_TRY(ImportMember(cx, identity, "backup", &backup));
    NS_ENSURE_TRUE(backup.isNull(), NS_ERROR_NOT_AVAILABLE);
    for (const char* name : {"imports", "books", "caches", "serverSummaries"}) {
      JS::Rooted<JSObject*> array(cx);
      uint32_t length;
      MOZ_TRY(StartupArray(cx, identity, name, &array, length,
                           strcmp(name, "serverSummaries") == 0));
      NS_ENSURE_TRUE(!length, NS_ERROR_NOT_AVAILABLE);
    }
    return NS_OK;
  }
  nsCString journalPath;
  MOZ_TRY(ImportText(cx, declaredJournal, journalPath));
  NS_ENSURE_TRUE(
      operation.journalPath.IsEmpty() || journalPath == operation.journalPath,
      NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIFile> journalFile;
  MOZ_TRY(
      StartupJournalFile(operation, journalPath, getter_AddRefs(journalFile)));
  JS::Rooted<JSObject*> journal(cx), startup(cx), backup(cx), sources(cx),
      imports(cx);
  MOZ_TRY(StartupReadJSON(cx, journalFile, &journal));
  int64_t journalVersion;
  MOZ_TRY(StartupNumber(cx, journal, "version", 7, 7, journalVersion));
  nsCString stage, journalProfile, databaseSource;
  MOZ_TRY(StartupText(cx, journal, "profilePath", journalProfile));
  MOZ_TRY(StartupText(cx, journal, "stage", stage));
  MOZ_TRY(StartupObject(cx, journal, "startup", &startup));
  MOZ_TRY(StartupText(cx, startup, "databaseSourceId", databaseSource));
  JS::Rooted<JS::Value> cancelled(cx), bound(cx);
  MOZ_TRY(ImportMember(cx, journal, "cancelled", &cancelled));
  MOZ_TRY(ImportMember(cx, startup, "bound", &bound));
  NS_ENSURE_TRUE(journalProfile == profile && databaseSource == current &&
                     stage == "complete"_ns && cancelled.isBoolean() &&
                     !cancelled.toBoolean() && bound.isBoolean() &&
                     bound.toBoolean(),
                 NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(StartupObject(cx, journal, "backup", &backup));
  JS::Rooted<JS::Value> expected(cx), actual(cx, JS::ObjectValue(*backup));
  MOZ_TRY(ImportMember(cx, identity, "backup", &expected));
  MOZ_TRY(StartupEqual(cx, expected, actual));
  if (reusing) {
    // The committed selector and durable complete journal already bind this
    // backup identity. Ordinary reuse consumes native receipts, not the
    // archive.
    nsCString path, hash;
    MOZ_TRY(StartupText(cx, backup, "path", path));
    MOZ_TRY(StartupText(cx, backup, "sha256", hash));
    NS_ENSURE_TRUE(!path.IsEmpty() && hash.Length() == 64,
                   NS_ERROR_INVALID_ARG);
    nsCOMPtr<nsIFile> named;
    MOZ_TRY(NS_NewNativeLocalFile(path, getter_AddRefs(named)));
    for (char c : hash.View())
      NS_ENSURE_TRUE((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'),
                     NS_ERROR_INVALID_ARG);
  } else {
    // First migration activation still consumes and verifies the full backup.
    MOZ_TRY(StartupBackup(cx, operation, backup));
  }
  JS::Rooted<JSObject*> originalInventory(cx);
  MOZ_TRY(StartupObject(cx, startup, "inventory", &originalInventory));
  JS::Rooted<JS::Value> retainedInventory(cx);
  if (reusing) {
    MOZ_TRY(ImportMember(cx, originalInventory, "sources", &retainedInventory));
    MOZ_TRY(StartupJSON(cx, retainedInventory, operation.retainedSources));
    for (auto entry : {std::pair{"books", &operation.retainedBooks},
                       std::pair{"caches", &operation.retainedCaches}}) {
      JS::Rooted<JSObject*> array(cx);
      uint32_t length;
      MOZ_TRY(StartupArray(cx, journal, entry.first, &array, length, true));
      retainedInventory.setObject(*array);
      MOZ_TRY(StartupJSON(cx, retainedInventory, *entry.second));
    }
  }
  MOZ_TRY(StartupParse(cx, operation.retainedSources, &retainedInventory));
  MOZ_TRY(ImportMember(cx, originalInventory, "sources", &expected));
  MOZ_TRY(StartupEqual(cx, expected, retainedInventory));
  nsTHashSet<nsCString> declaredPaths;
  JS::Rooted<JSObject*> originalSummaries(cx), selectedSummaries(cx),
      journalSummaries(cx);
  uint32_t originalSummaryCount, selectedSummaryCount, journalSummaryCount;
  MOZ_TRY(StartupArray(cx, originalInventory, "serverSummaries",
                       &originalSummaries, originalSummaryCount, true));
  MOZ_TRY(StartupArray(cx, identity, "serverSummaries", &selectedSummaries,
                       selectedSummaryCount, true));
  MOZ_TRY(StartupArray(cx, startup, "serverSummaries", &journalSummaries,
                       journalSummaryCount, true));
  expected.setObject(*selectedSummaries);
  actual.setObject(*journalSummaries);
  MOZ_TRY(StartupEqual(cx, expected, actual));
  NS_ENSURE_TRUE(originalSummaryCount == selectedSummaryCount,
                 NS_ERROR_NOT_AVAILABLE);
  actual.setObject(*originalSummaries);
  if (reusing) {
    MOZ_TRY(StartupJSON(cx, actual, operation.retainedServerSummaries));
  }
  MOZ_TRY(StartupParse(cx, operation.retainedServerSummaries, &expected));
  MOZ_TRY(StartupEqual(cx, expected, actual));
  NS_ENSURE_TRUE(
      reusing || originalSummaryCount == operation.serverSummaries.Length(),
      NS_ERROR_NOT_AVAILABLE);
  nsTHashSet<nsCString> summaryIds, summaryServers;
  nsTHashSet<uint64_t> summaryRoots;
  for (uint32_t i = 0; i < originalSummaryCount; ++i) {
    JS::Rooted<JSObject*> original(cx), binding(cx);
    MOZ_TRY(StartupItem(cx, originalSummaries, i, &original));
    MOZ_TRY(StartupItem(cx, selectedSummaries, i, &binding));
    StartupServerSummary summary;
    MOZ_TRY(
        StartupServerSummaryInput(cx, original, operation, summary, reusing));
    nsCString id;
    int64_t folder;
    MOZ_TRY(StartupText(cx, binding, "sourceId", id));
    MOZ_TRY(
        StartupNumber(cx, binding, "folderId", 1, 9007199254740991LL, folder));
    NS_ENSURE_TRUE(id == summary.id && !summaryIds.Contains(id) &&
                       !summaryServers.Contains(summary.serverKey) &&
                       !summaryRoots.Contains(folder) &&
                       !declaredPaths.Contains(summary.path),
                   NS_ERROR_NOT_AVAILABLE);
    // RetireAccountRoot removes the actual native row on ordinary IMAP account
    // deletion. Its historical binding remains in the unchanged journal. Check
    // duplicates above even for retired roots; every live row still must match.
    nsCOMPtr<mozIStorageStatement> live;
    MOZ_TRY(sConnection->CreateStatement(
        "SELECT 1 FROM folders WHERE id=:id"_ns, getter_AddRefs(live)));
    MOZ_TRY(live->BindInt64ByName("id"_ns, folder));
    bool exists;
    MOZ_TRY(live->ExecuteStep(&exists));
    live = nullptr;
    NS_ENSURE_TRUE(reusing || exists, NS_ERROR_NOT_AVAILABLE);
    if (exists) {
      NS_ENSURE_TRUE(!MOZ_TRY(mFolderDatabase->GetFolderParent(folder)) &&
                         MOZ_TRY(mFolderDatabase->GetFolderName(folder)) ==
                             summary.serverKey,
                     NS_ERROR_NOT_AVAILABLE);
    }
    if (!reusing) {
      NS_ENSURE_TRUE(
          operation.serverSummaries[i].id == summary.id &&
              operation.serverSummaries[i].folderId == uint64_t(folder),
          NS_ERROR_NOT_AVAILABLE);
    }
    summaryIds.Insert(id);
    summaryServers.Insert(summary.serverKey);
    summaryRoots.Insert(folder);
    declaredPaths.Insert(summary.path);
  }
  nsTArray<nsCString> cacheStoreRoots;
  uint32_t count, importCount;
  MOZ_TRY(StartupArray(cx, journal, "sources", &sources, count));
  MOZ_TRY(StartupArray(cx, identity, "imports", &imports, importCount));
  NS_ENSURE_TRUE(
      count == importCount && (reusing || count == operation.sources.Length()),
      NS_ERROR_NOT_AVAILABLE);
  nsTHashSet<nsCString> tokens;
  nsTHashSet<uint64_t> folderIds;
  nsTHashMap<uint64_t, nsCString> retainedLocalPaths;
  for (uint32_t i = 0; i < count; ++i) {
    JS::Rooted<JSObject*> source(cx), declared(cx);
    MOZ_TRY(StartupItem(cx, sources, i, &source));
    MOZ_TRY(StartupItem(cx, imports, i, &declared));
    FolderImportIdentity native;
    nsCString state, path;
    int64_t folder;
    MOZ_TRY(StartupText(cx, source, "state", state));
    MOZ_TRY(StartupText(cx, source, "token", native.token));
    MOZ_TRY(StartupText(cx, source, "id", native.sourceId));
    MOZ_TRY(StartupText(cx, source, "sha256", native.sourceSha256));
    MOZ_TRY(StartupText(cx, source, "path", path));
    CopyUTF8toUTF16(path, native.sourcePath);
    MOZ_TRY(
        StartupNumber(cx, source, "destinationFolderId", 1, INT64_MAX, folder));
    native.folderId = folder;
    NS_ENSURE_FALSE(declaredPaths.Contains(path), NS_ERROR_NOT_AVAILABLE);
    declaredPaths.Insert(path);
    native.databaseSourceId = current;
#ifdef XP_WIN
    MOZ_TRY(StartupWindowsImportIdentity(cx, source, native));
#endif
    bool planned = false;
    for (const auto& retained : operation.sources) {
      planned |= retained.id == native.sourceId && retained.path == path &&
                 retained.hash == native.sourceSha256;
    }
    if (reusing) {
      // The retained inventory must match the committed native receipt below;
      // an archived copy is neither readback authority nor a reuse dependency.
      JS::Rooted<JSObject*> retained(cx);
      uint32_t length;
      MOZ_TRY(ImportArray(cx, retainedInventory, &retained, length));
      for (uint32_t r = 0; r < length; ++r) {
        JS::Rooted<JSObject*> item(cx);
        MOZ_TRY(StartupItem(cx, retained, r, &item));
        nsCString id, originalPath, hash;
        MOZ_TRY(StartupText(cx, item, "id", id));
        MOZ_TRY(StartupText(cx, item, "path", originalPath));
        MOZ_TRY(StartupText(cx, item, "sha256", hash));
        planned |= id == native.sourceId && originalPath == path &&
                   hash == native.sourceSha256;
      }
      // Read the import-time spelling from native provenance. A normal later
      // rename is not permission to reopen or replay the obsolete Mork source.
      nsCOMPtr<mozIStorageStatement> savedPath;
      MOZ_TRY(sConnection->CreateStatement(
          "SELECT folderPath FROM folder_import_receipts WHERE token=:token"_ns,
          getter_AddRefs(savedPath)));
      MOZ_TRY(savedPath->BindUTF8StringByName("token"_ns, native.token));
      bool exists;
      MOZ_TRY(savedPath->ExecuteStep(&exists));
      NS_ENSURE_TRUE(exists, NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(savedPath->GetUTF8String(0, native.folderPath));
    } else {
      native.folderPath = MOZ_TRY(mFolderDatabase->GetFolderPath(folder));
    }
    NS_ENSURE_TRUE(planned, NS_ERROR_NOT_AVAILABLE);
    NS_ENSURE_TRUE(state == "imported"_ns && !tokens.Contains(native.token) &&
                       !folderIds.Contains(folder),
                   NS_ERROR_NOT_AVAILABLE);
    tokens.Insert(native.token);
    folderIds.Insert(folder);
    Maybe<FolderImportReceipt> receipt;
    if (reusing) {
      MOZ_TRY(ReadFolderImportReceipt(native, receipt));
    } else {
      nsCOMPtr<nsIFile> original;
      MOZ_TRY(
          StartupContained(operation.profile, path, getter_AddRefs(original)));
      nsCString hash;
      MOZ_TRY(StartupHash(original, hash));
      NS_ENSURE_TRUE(hash == native.sourceSha256, NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(GetFolderImportReceipt(native, receipt));
    }
    NS_ENSURE_TRUE(receipt, NS_ERROR_NOT_AVAILABLE);
    NS_ENSURE_TRUE(ImportReceiptValue(cx, *receipt, &actual),
                   NS_ERROR_OUT_OF_MEMORY);
    JS::Rooted<JSObject*> full(cx, &actual.toObject()),
        normalized(cx, JS_NewPlainObject(cx));
    NS_ENSURE_TRUE(normalized, NS_ERROR_OUT_OF_MEMORY);
    for (const char* name : {"token", "sourceSha256", "folderId", "keys"})
      MOZ_TRY(StartupCopy(cx, full, normalized, name));
#ifdef XP_WIN
    // Physical journals retain the complete version2 receipt: the measured
    // admission and source file ID that the native lookup has just matched.
    for (const char* name : {"version", "sourceId", "databaseSourceId",
                             "windowsAdmission", "sourcePhysicalIdentity"})
      MOZ_TRY(StartupCopy(cx, full, normalized, name));
#endif
    // Unix journals deliberately store this four-field projection. Identity
    // was independently checked by native receipt lookup and source hashing.
    actual.setObject(*normalized);
    MOZ_TRY(ImportMember(cx, source, "receipt", &expected));
    MOZ_TRY(StartupEqual(cx, expected, actual));
    MOZ_TRY(ImportMember(cx, declared, "receipt", &expected));
    MOZ_TRY(StartupEqual(cx, expected, actual));
    MOZ_TRY(
        StartupFieldsEqual(cx, source, declared, {"id", "token", "sha256"}));
    int64_t declaredFolder;
    MOZ_TRY(
        StartupNumber(cx, declared, "folderId", 1, INT64_MAX, declaredFolder));
    NS_ENSURE_TRUE(declaredFolder == folder, NS_ERROR_NOT_AVAILABLE);
    if (reusing) {
      // Only unchanged native locations need the legacy physical spelling.
      // Normal later rename/move/server-path changes keep their normal paths.
      nsCOMPtr<mozIStorageStatement> live;
      MOZ_TRY(sConnection->CreateStatement(
          "SELECT 1 FROM folders WHERE id=:id"_ns, getter_AddRefs(live)));
      MOZ_TRY(live->BindInt64ByName("id"_ns, folder));
      bool exists;
      MOZ_TRY(live->ExecuteStep(&exists));
      live = nullptr;
      if (!exists) continue;
      nsCString currentPath = MOZ_TRY(mFolderDatabase->GetFolderPath(folder));
      if (currentPath != receipt->identity.folderPath) continue;
      JS::Rooted<JSObject*> retained(cx);
      uint32_t length;
      MOZ_TRY(ImportArray(cx, retainedInventory, &retained, length));
      for (uint32_t r = 0; r < length; ++r) {
        JS::Rooted<JSObject*> item(cx);
        MOZ_TRY(StartupItem(cx, retained, r, &item));
        nsCString id, protocol;
        MOZ_TRY(StartupText(cx, item, "id", id));
        if (id != native.sourceId) continue;
        MOZ_TRY(StartupText(cx, item, "protocol", protocol));
        if (protocol != "none"_ns) continue;
        nsCString serverKey, serverRoot, relative;
        MOZ_TRY(StartupText(cx, item, "serverKey", serverKey));
        MOZ_TRY(StartupText(cx, item, "serverRoot", serverRoot));
        MOZ_TRY(StartupText(cx, item, "physicalRelativePath", relative));
        uint64_t root = MOZ_TRY(mFolderDatabase->GetFolderRoot(folder));
        nsCString actualKey = MOZ_TRY(mFolderDatabase->GetFolderName(root));
        if (serverKey != actualKey) continue;
        // A cold account service runs Init while this operation is busy.
        // Its metadata-only admission must cover acquisition as well as the
        // bound server/path reads; ordinary account work remains closed.
        AutoRestore<uint32_t> metadata(mStartupMetadataDepth);
        ++mStartupMetadataDepth;
        nsCOMPtr<nsIMsgAccountManager> accounts =
            do_GetService("@mozilla.org/messenger/account-manager;1");
        NS_ENSURE_TRUE(accounts, NS_ERROR_NOT_AVAILABLE);
        // Service Init establishes its real shutdown lifetime, but asking it
        // for a cold server here would create/reconcile that root before the
        // complete retained path map exists. Read the same path preferences
        // without constructing a facade; BindStartupFolderPath later checks
        // the actual server, protocol, store and path under the complete map.
        nsCOMPtr<nsIPrefBranch> prefs =
            do_GetService("@mozilla.org/preferences-service;1");
        NS_ENSURE_TRUE(prefs, NS_ERROR_NOT_AVAILABLE);
        nsCOMPtr<nsIFile> physical;
        MOZ_TRY(StartupConfiguredPath(prefs,
                                      "mail.server."_ns + serverKey + "."_ns,
                                      getter_AddRefs(physical)));
        nsCString actualRoot;
        MOZ_TRY(StartupDirectory(physical, actualRoot));
        if (serverRoot != actualRoot) continue;
        nsTArray<uint64_t> ancestors =
            MOZ_TRY(mFolderDatabase->GetFolderAncestors(folder));
        nsTArray<nsCString> leaves;
        nsCCharSeparatedTokenizer parts(relative, '/');
        while (parts.hasMoreTokens()) {
          nsCString leaf(parts.nextToken());
          bool last = !parts.hasMoreTokens();
          NS_ENSURE_TRUE(StringEndsWith(leaf, last ? ".msf"_ns : ".sbd"_ns),
                         NS_ERROR_FILE_CORRUPTED);
          leaf.Truncate(leaf.Length() - 4);
          NS_ENSURE_TRUE(!leaf.IsEmpty() && leaf != "."_ns && leaf != ".."_ns &&
                             leaf.FindChar(0) < 0 && leaf.FindChar('\\') < 0,
                         NS_ERROR_FILE_INVALID_PATH);
          leaves.AppendElement(leaf);
        }
        NS_ENSURE_TRUE(leaves.Length() == ancestors.Length(),
                       NS_ERROR_FILE_CORRUPTED);
        for (uint32_t n = 0; n < leaves.Length(); ++n) {
          MOZ_TRY(physical->AppendNative(leaves[n]));
          nsCString body;
          MOZ_TRY(GetComparablePath(physical, body));
          uint64_t currentId = n + 1 == leaves.Length()
                                   ? uint64_t(folder)
                                   : ancestors[ancestors.Length() - 2 - n];
          if (auto prior = retainedLocalPaths.Lookup(currentId))
            NS_ENSURE_TRUE(prior.Data() == body, NS_ERROR_NOT_AVAILABLE);
          retainedLocalPaths.InsertOrUpdate(currentId, body);
          if (n + 1 < leaves.Length())
            MOZ_TRY(physical->SetNativeLeafName(leaves[n] + ".sbd"_ns));
          else
            NS_ENSURE_TRUE(path.Equals(body + ".msf"_ns),
                           NS_ERROR_NOT_AVAILABLE);
        }
      }
    }
  }
  // Reconstruct each saved protocol intent from its original raw summaries.
  // The existing converter and native unit reader independently check member,
  // UID, body and held-operation provenance; no checkpoint label grants it.
  JS::Rooted<JSObject*> units(cx);
  uint32_t unitCount;
  MOZ_TRY(StartupArray(cx, journal, "protocolUnits", &units, unitCount));
  nsTHashSet<nsCString> unitMembers;
  for (uint32_t u = 0; u < unitCount; ++u) {
    JS::Rooted<JSObject*> unit(cx), intent(cx), members(cx);
    MOZ_TRY(StartupItem(cx, units, u, &unit));
    nsCString state, token;
    MOZ_TRY(StartupText(cx, unit, "state", state));
    MOZ_TRY(StartupText(cx, unit, "token", token));
    NS_ENSURE_TRUE(state == "imported"_ns, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(StartupObject(cx, unit, "input", &intent));
    uint32_t memberCount;
    MOZ_TRY(StartupArray(cx, intent, "folders", &members, memberCount));
    NS_ENSURE_TRUE(memberCount, NS_ERROR_NOT_AVAILABLE);
    if (reusing) {
      nsCOMPtr<mozIStorageStatement> stored;
      MOZ_TRY(sConnection->CreateStatement(
          "SELECT databaseSourceId,provenance FROM imap_import_units WHERE token=:token"_ns,
          getter_AddRefs(stored)));
      MOZ_TRY(stored->BindUTF8StringByName("token"_ns, token));
      bool exists;
      MOZ_TRY(stored->ExecuteStep(&exists));
      NS_ENSURE_TRUE(exists, NS_ERROR_NOT_AVAILABLE);
      nsCString database, provenance;
      MOZ_TRY(stored->GetUTF8String(0, database));
      MOZ_TRY(stored->GetUTF8String(1, provenance));
      NS_ENSURE_TRUE(database == current, NS_ERROR_NOT_AVAILABLE);
      stored = nullptr;
      ImapImportUnit native;
      MOZ_TRY(ReadStartupImapProvenance(provenance, native));
      NS_ENSURE_TRUE(native.token == token &&
                         native.databaseSourceId == current &&
                         native.folders.Length() == memberCount,
                     NS_ERROR_NOT_AVAILABLE);
      for (const auto& member : native.folders) {
        const auto& id = member.snapshot.identity.sourceId;
        NS_ENSURE_FALSE(unitMembers.Contains(id), NS_ERROR_NOT_AVAILABLE);
        unitMembers.Insert(id);
      }
      Maybe<ImapImportReceipt> receipt;
      MOZ_TRY(ReadImapImportReceipt(native, provenance, receipt, true));
      NS_ENSURE_TRUE(receipt, NS_ERROR_NOT_AVAILABLE);
      JS::RootedValueArray<2> arguments(cx);
      arguments[0].setObject(*intent);
      NS_ENSURE_TRUE(ImapImportReceiptValue(cx, native, *receipt, arguments[1]),
                     NS_ERROR_OUT_OF_MEMORY);
      JS::Rooted<JS::Value> checked(cx);
      // Ordinary reuse must not depend on the obsolete originals, which a
      // later offline download, compaction or removal may legitimately change.
      // On Windows the retained check compares the measured admission with the
      // journal intent instead of re-admitting those files; the durable rows
      // were already matched above (POSIX receipts carry no admission).
      MOZ_TRY(StartupModuleCall(
          cx, u"resource:///modules/panorama/MorkSnapshotAdapter.sys.mjs"_ns,
          "validateRetainedMorkProtocolUnitReceipt", arguments, &checked));
      MOZ_TRY(ImportMember(cx, unit, "receipt", &expected));
      MOZ_TRY(StartupEqual(cx, expected, checked));
      continue;
    }
    JS::Rooted<JSObject*> entries(cx, JS::NewArrayObject(cx, memberCount));
    NS_ENSURE_TRUE(entries, NS_ERROR_OUT_OF_MEMORY);
    nsCOMPtr<nsIMsgFolder> anchor;
    for (uint32_t m = 0; m < memberCount; ++m) {
      JS::Rooted<JSObject*> member(cx), original(cx), source(cx), data(cx),
          summary(cx);
      MOZ_TRY(StartupItem(cx, members, m, &member));
      nsCString id;
      MOZ_TRY(StartupText(cx, member, "sourceId", id));
      NS_ENSURE_FALSE(unitMembers.Contains(id), NS_ERROR_NOT_AVAILABLE);
      unitMembers.Insert(id);
      for (uint32_t i = 0; i < count; ++i) {
        JS::Rooted<JSObject*> candidate(cx);
        MOZ_TRY(StartupItem(cx, sources, i, &candidate));
        nsCString candidateId;
        MOZ_TRY(StartupText(cx, candidate, "id", candidateId));
        if (candidateId == id) {
          source = candidate;
          break;
        }
      }
      NS_ENSURE_TRUE(source, NS_ERROR_NOT_AVAILABLE);
      nsCString protocol, unitToken, path;
      MOZ_TRY(StartupText(cx, source, "protocol", protocol));
      MOZ_TRY(StartupText(cx, source, "protocolUnitToken", unitToken));
      MOZ_TRY(StartupText(cx, source, "path", path));
      NS_ENSURE_TRUE(protocol == "imap"_ns && unitToken == token,
                     NS_ERROR_NOT_AVAILABLE);
      nsCOMPtr<nsIFile> file;
      MOZ_TRY(StartupContained(operation.profile, path, getter_AddRefs(file)));
      MOZ_TRY(StartupParseFile(
          cx, file,
          u"resource:///modules/panorama/MorkSummaryReader.sys.mjs"_ns,
          "parseMorkSummary", &summary));
      JS::Rooted<JS::Value> argument(cx, JS::ObjectValue(*summary)),
          converted(cx);
      MOZ_TRY(StartupModuleCall(
          cx, u"resource:///modules/panorama/MorkFolderImport.sys.mjs"_ns,
          "createMorkImportData", JS::HandleValueArray(argument), &converted));
      NS_ENSURE_TRUE(converted.isObject(), NS_ERROR_FAILURE);
      data = &converted.toObject();
      original = JS_NewPlainObject(cx);
      NS_ENSURE_TRUE(original, NS_ERROR_OUT_OF_MEMORY);
      for (const char* name : {"version", "token", "folder", "source"})
        MOZ_TRY(StartupCopy(cx, member, original, name));
#ifdef XP_WIN
      // The retained Windows member is a version2 request. Rebuild it with its
      // original admission, which the converter compares with the journal
      // source inventory (re-admitting the originals) and the native unit
      // lookup re-acquires (FolderImportAdmission), as for a local source.
      MOZ_TRY(StartupCopy(cx, member, original, "windowsAdmission"));
#endif
      for (const char* name : {"messages", "records"})
        MOZ_TRY(StartupCopy(cx, data, original, name));
      JS::Rooted<JSObject*> binding(cx);
      MOZ_TRY(StartupObject(cx, member, "folder", &binding));
      int64_t idNumber;
      MOZ_TRY(StartupNumber(cx, binding, "id", 1, INT64_MAX, idNumber));
      nsCOMPtr<nsIMsgFolder> folder;
      MOZ_TRY(mFolderDatabase->GetMsgFolderForFolder(idNumber,
                                                     getter_AddRefs(folder)));
      NS_ENSURE_TRUE(folder, NS_ERROR_NOT_AVAILABLE);
      if (!m) anchor = folder;
      // Reconstruct protocol intent from committed native metadata without
      // opening a public message reader while startup is still closed.
      uint32_t flags = MOZ_TRY(mFolderDatabase->GetFolderFlags(idNumber));
      JS::Rooted<JSObject*> entry(cx, JS_NewPlainObject(cx));
      NS_ENSURE_TRUE(
          entry &&
              JS_DefineProperty(cx, entry, "input", original,
                                JSPROP_ENUMERATE) &&
              JS_DefineProperty(cx, entry, "source", source,
                                JSPROP_ENUMERATE) &&
              JS_DefineProperty(cx, entry, "folderFlags", double(flags),
                                JSPROP_ENUMERATE) &&
              JS_DefineElement(cx, entries, m, entry, JSPROP_ENUMERATE),
          NS_ERROR_OUT_OF_MEMORY);
    }
    JS::RootedValueArray<3> arguments(cx);
    arguments[0].setObject(*entries);
    JS::Rooted<JSString*> tokenString(
        cx, JS_NewStringCopyN(cx, token.get(), token.Length()));
    JS::Rooted<JSString*> sourceString(
        cx, JS_NewStringCopyN(cx, current.get(), current.Length()));
    NS_ENSURE_TRUE(tokenString && sourceString, NS_ERROR_OUT_OF_MEMORY);
    arguments[1].setString(tokenString);
    arguments[2].setString(sourceString);
    JS::Rooted<JS::Value> request(cx), retained(cx), receipt(cx);
    MOZ_TRY(StartupModuleCall(
        cx, u"resource:///modules/panorama/MorkSnapshotAdapter.sys.mjs"_ns,
        "convertMorkProtocolUnit", arguments, &request));
    MOZ_TRY(StartupModuleCall(
        cx, u"resource:///modules/panorama/MorkSnapshotAdapter.sys.mjs"_ns,
        "getMorkProtocolUnitIntent", JS::HandleValueArray(request), &retained));
    expected.setObject(*intent);
    MOZ_TRY(StartupEqual(cx, expected, retained));
    MOZ_TRY(GetFolderImportReceipt(anchor, request, cx, &receipt));
    MOZ_TRY(ImportMember(cx, unit, "receipt", &expected));
    MOZ_TRY(StartupEqual(cx, expected, receipt));
  }
  for (uint32_t i = 0; i < count; ++i) {
    JS::Rooted<JSObject*> source(cx);
    MOZ_TRY(StartupItem(cx, sources, i, &source));
    nsCString protocol, id;
    MOZ_TRY(StartupText(cx, source, "protocol", protocol));
    MOZ_TRY(StartupText(cx, source, "id", id));
    NS_ENSURE_TRUE((protocol == "imap"_ns) == unitMembers.Contains(id),
                   NS_ERROR_NOT_AVAILABLE);
  }
  nsTHashSet<nsCString> bookPrefs, bookFiles, bookUris, bookUids, bookIds;
  for (const char* name : {"books", "caches"}) {
    JS::Rooted<JSObject*> declared(cx);
    uint32_t length, declaredLength;
    MOZ_TRY(StartupArray(cx, journal, name, &units, length, true));
    MOZ_TRY(StartupArray(cx, identity, name, &declared, declaredLength));
    NS_ENSURE_TRUE(length == declaredLength, NS_ERROR_NOT_AVAILABLE);
    JS::Rooted<JS::Value> retainedValue(cx);
    MOZ_TRY(StartupParse(cx,
                         !strcmp(name, "books") ? operation.retainedBooks
                                                : operation.retainedCaches,
                         &retainedValue));
    JS::Rooted<JSObject*> retainedUnits(cx);
    uint32_t retainedLength;
    MOZ_TRY(ImportArray(cx, retainedValue, &retainedUnits, retainedLength));
    NS_ENSURE_TRUE(retainedLength == length, NS_ERROR_NOT_AVAILABLE);
    for (uint32_t i = 0; i < length; ++i) {
      JS::Rooted<JSObject*> unit(cx), item(cx), saved(cx);
      MOZ_TRY(StartupItem(cx, units, i, &unit));
      MOZ_TRY(StartupItem(cx, declared, i, &item));
      JS::Rooted<JSObject*> retainedUnit(cx);
      MOZ_TRY(StartupItem(cx, retainedUnits, i, &retainedUnit));
      MOZ_TRY(StartupFieldsEqual(cx, retainedUnit, unit,
                                 {"id", "path", "sha256", "size"}));
      MOZ_TRY(StartupFieldsEqual(cx, unit, item,
                                 {"id", "token", "sha256", "receipt"}));
      nsCString state, path, hash, token;
      int64_t size;
      MOZ_TRY(StartupText(cx, unit, "state", state));
      MOZ_TRY(StartupText(cx, unit, "path", path));
      MOZ_TRY(StartupText(cx, unit, "sha256", hash));
      MOZ_TRY(StartupText(cx, unit, "token", token));
      MOZ_TRY(StartupNumber(cx, unit, "size", 1, UINT32_MAX - 1, size));
      NS_ENSURE_TRUE(!declaredPaths.Contains(path) && !tokens.Contains(token),
                     NS_ERROR_NOT_AVAILABLE);
      declaredPaths.Insert(path);
      tokens.Insert(token);
      NS_ENSURE_TRUE(state == "imported"_ns, NS_ERROR_NOT_AVAILABLE);
      nsCOMPtr<nsIFile> original;
      if (!reusing) {
        MOZ_TRY(StartupContained(operation.profile, path,
                                 getter_AddRefs(original)));
        MOZ_TRY(StartupCheckHash(original, hash, size));
      }
      // Reuse verifies the committed book/cache receipt below, not backup
      // bytes.
      MOZ_TRY(StartupObject(cx, unit, "receipt", &saved));
      if (!strcmp(name, "books")) {
        JS::Rooted<JSObject*> publication(cx), published(cx);
        MOZ_TRY(StartupObject(cx, unit, "publication", &publication));
        MOZ_TRY(StartupText(cx, publication, "state", state));
        NS_ENSURE_TRUE(state == "published"_ns, NS_ERROR_NOT_AVAILABLE);
        MOZ_TRY(StartupObject(cx, publication, "receipt", &published));
        MOZ_TRY(ImportMember(cx, item, "publication", &expected));
        actual.setObject(*published);
        MOZ_TRY(StartupEqual(cx, expected, actual));
        nsCString pref, fileName, uri, uid;
        MOZ_TRY(StartupText(cx, published, "dirPrefId", pref));
        MOZ_TRY(StartupText(cx, published, "fileName", fileName));
        MOZ_TRY(StartupText(cx, published, "uri", uri));
        MOZ_TRY(StartupText(cx, published, "bookUID", uid));
        const nsLiteralCString prefix("ldap_2.servers.panorama_import_");
        NS_ENSURE_TRUE(StringBeginsWith(pref, prefix) &&
                           pref.Length() == prefix.Length() + 64,
                       NS_ERROR_NOT_AVAILABLE);
        nsCString suffix(Substring(pref, prefix.Length()));
        for (char c : suffix.View())
          NS_ENSURE_TRUE((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'),
                         NS_ERROR_NOT_AVAILABLE);
        NS_ENSURE_TRUE(
            fileName.Equals("panorama-import-"_ns + suffix + ".sqlite"_ns) &&
                uri.Equals("jsaddrbook://"_ns + fileName),
            NS_ERROR_NOT_AVAILABLE);
        NS_ENSURE_TRUE(!bookPrefs.Contains(pref) &&
                           !bookFiles.Contains(fileName) &&
                           !bookUris.Contains(uri) && !bookUids.Contains(uid),
                       NS_ERROR_NOT_AVAILABLE);
        bookPrefs.Insert(pref);
        bookFiles.Insert(fileName);
        bookUris.Insert(uri);
        bookUids.Insert(uid);
        // Validate the durable unit/publication identity before consulting live
        // state, including when a user has completely removed the book.
        nsCString savedToken, savedId, id, savedHash;
        int64_t savedSize;
        MOZ_TRY(StartupText(cx, saved, "storageSourceId", savedToken));
        MOZ_TRY(StartupText(cx, saved, "sourceId", savedId));
        MOZ_TRY(StartupText(cx, unit, "id", id));
        MOZ_TRY(StartupText(cx, saved, "sourceSha256", savedHash));
        MOZ_TRY(StartupNumber(cx, saved, "sourceSize", 1, UINT32_MAX - 1,
                              savedSize));
        NS_ENSURE_TRUE(!uid.IsEmpty() && !id.IsEmpty() && !token.IsEmpty() &&
                           !bookIds.Contains(id) && savedToken == token &&
                           savedId == id && savedHash == hash &&
                           savedSize == size && hash.Length() == 64,
                       NS_ERROR_NOT_AVAILABLE);
        bookIds.Insert(id);
        for (char c : hash.View())
          NS_ENSURE_TRUE((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'),
                         NS_ERROR_NOT_AVAILABLE);
        MOZ_TRY(
            StartupFieldsEqual(cx, saved, published,
                               {"sourceId", "storageSourceId", "sourceSha256",
                                "sourceSize", "cards", "lists"}));
        nsCOMPtr<nsIFile> target;
        MOZ_TRY(StartupChild(operation.profile, fileName.get(),
                             getter_AddRefs(target)));
        if (reusing) {
          nsCOMPtr<nsIAbDirectory> directory;
          MOZ_TRY(ReadStartupReusedBookDirectory(target, pref, uri, uid,
                                                 getter_AddRefs(directory)));
          if (!directory) {
            // No live file remains to parse these maps. Keep the native
            // receipt's original key/UID shape and uniqueness requirements.
            nsTHashSet<nsCString> uids;
            for (const char* kind : {"cards", "lists"}) {
              JS::Rooted<JSObject*> map(cx);
              uint32_t length;
              MOZ_TRY(StartupArray(cx, saved, kind, &map, length));
              nsTHashSet<uint32_t> keys;
              for (uint32_t n = 0; n < length; ++n) {
                JS::Rooted<JS::Value> value(cx);
                NS_ENSURE_TRUE(JS_GetElement(cx, map, n, &value),
                               NS_ERROR_FAILURE);
                JS::Rooted<JSObject*> pair(cx);
                uint32_t fields;
                MOZ_TRY(ImportArray(cx, value, &pair, fields));
                NS_ENSURE_TRUE(fields == 2, NS_ERROR_FILE_CORRUPTED);
                NS_ENSURE_TRUE(JS_GetElement(cx, pair, 0, &value),
                               NS_ERROR_FAILURE);
                int64_t key;
                MOZ_TRY(ImportNumber(value, 0, UINT32_MAX, key));
                NS_ENSURE_TRUE(JS_GetElement(cx, pair, 1, &value),
                               NS_ERROR_FAILURE);
                nsCString uid;
                MOZ_TRY(ImportText(cx, value, uid));
                NS_ENSURE_TRUE(!uid.IsEmpty() &&
                                   !keys.Contains(uint32_t(key)) &&
                                   !uids.Contains(uid),
                               NS_ERROR_FILE_CORRUPTED);
                keys.Insert(uint32_t(key));
                uids.Insert(uid);
              }
            }
            continue;
          }
        }
        MOZ_TRY(StartupRegular(target));
        nsCOMPtr<nsIAbManager> manager =
            do_GetService("@mozilla.org/abmanager;1");
        NS_ENSURE_TRUE(manager, NS_ERROR_NOT_AVAILABLE);
        nsCOMPtr<nsIAbDirectory> directory;
        MOZ_TRY(manager->GetDirectory(uri, getter_AddRefs(directory)));
        NS_ENSURE_TRUE(directory, NS_ERROR_NOT_AVAILABLE);
        nsCString actualUid, actualPref, actualFile;
        MOZ_TRY(directory->GetUID(actualUid));
        MOZ_TRY(directory->GetDirPrefId(actualPref));
        MOZ_TRY(directory->GetFileName(actualFile));
        NS_ENSURE_TRUE(
            actualUid == uid && actualPref == pref && actualFile == fileName,
            NS_ERROR_NOT_AVAILABLE);
        if (reusing) {
          MOZ_TRY(StartupStoredBookReceipt(cx, target, &actual));
        } else {
          JS::Rooted<JSObject*> stageIdentity(cx);
#ifdef XP_WIN
          // A physical journal7 book receipt always retains the stage pin.
          MOZ_TRY(StartupObject(cx, saved, "stagePhysicalIdentity",
                                &stageIdentity));
#endif
          MOZ_TRY(StartupBookReadback(cx, target, original, token,
                                      stageIdentity, &actual));
        }
        JS::Rooted<JSObject*> readback(cx, &actual.toObject());
        nsCString storageToken;
        MOZ_TRY(StartupText(cx, readback, "sourceId", storageToken));
        NS_ENSURE_TRUE(
            storageToken == token && savedToken == token && savedId == id,
            NS_ERROR_NOT_AVAILABLE);
        MOZ_TRY(StartupFieldsEqual(
            cx, saved, readback,
            {"sourceSha256", "sourceSize", "cards", "lists"}));
        MOZ_TRY(
            StartupFieldsEqual(cx, saved, published,
                               {"sourceId", "storageSourceId", "sourceSha256",
                                "sourceSize", "cards", "lists"}));
      } else {
        JS::Rooted<JSObject*> request(cx, JS_NewPlainObject(cx)),
            source(cx, JS_NewPlainObject(cx));
        NS_ENSURE_TRUE(request && source, NS_ERROR_OUT_OF_MEMORY);
        for (const char* field :
             {"token", "databaseSourceId", "folders", "proof"})
          MOZ_TRY(StartupCopy(cx, unit, request, field));
        MOZ_TRY(StartupCopy(cx, unit, request, "id", "sourceId"));
        MOZ_TRY(StartupCopy(cx, unit, request, "requestVersion", "version"));
        JS::Rooted<JS::Value> requestVersion(cx);
        MOZ_TRY(ImportMember(cx, request, "version", &requestVersion));
        if (requestVersion.isNumber() && requestVersion.toNumber() == 3) {
          MOZ_TRY(StartupCopy(cx, unit, request, "sourceFormat"));
          NS_ENSURE_TRUE(ImapImportText(cx, request, "policy",
                                        "native-reconciled-json-v3"_ns),
                         NS_ERROR_OUT_OF_MEMORY);
        }
        for (const char* field : {"path", "sha256", "size"})
          MOZ_TRY(StartupCopy(cx, unit, source, field));
        NS_ENSURE_TRUE(
            JS_DefineProperty(cx, request, "source", source, JSPROP_ENUMERATE),
            NS_ERROR_OUT_OF_MEMORY);
        actual.setObject(*request);
        if (reusing) {
          CacheImport input;
          MOZ_TRY(CacheRequest(cx, actual, input));
          NS_ENSURE_TRUE(input.databaseId == current, NS_ERROR_NOT_AVAILABLE);
          JS::Rooted<JSObject*> identity(cx);
          MOZ_TRY(CacheIdentity(cx, input, &identity));
          nsCString encoded;
          MOZ_TRY(CacheJSON(cx, identity, encoded));
          nsCOMPtr<mozIStorageStatement> stored;
          MOZ_TRY(sConnection->CreateStatement(
              "SELECT identity,receipt FROM folder_cache_imports WHERE token=:token OR sourceId=:source OR path=:path"_ns,
              getter_AddRefs(stored)));
          MOZ_TRY(stored->BindUTF8StringByName("token"_ns, input.token));
          MOZ_TRY(stored->BindUTF8StringByName("source"_ns, input.sourceId));
          MOZ_TRY(stored->BindUTF8StringByName("path"_ns, input.path));
          bool row;
          MOZ_TRY(stored->ExecuteStep(&row));
          NS_ENSURE_TRUE(row, NS_ERROR_NOT_AVAILABLE);
          for (uint32_t c : {0u, 1u}) {
            int32_t type;
            MOZ_TRY(stored->GetTypeOfIndex(c, &type));
            NS_ENSURE_TRUE(type == mozIStorageStatement::VALUE_TYPE_TEXT,
                           NS_ERROR_FILE_CORRUPTED);
          }
          nsCString retained, receipt;
          MOZ_TRY(stored->GetUTF8String(0, retained));
          MOZ_TRY(stored->GetUTF8String(1, receipt));
          NS_ENSURE_TRUE(retained == encoded, NS_ERROR_NOT_AVAILABLE);
          MOZ_TRY(stored->ExecuteStep(&row));
          NS_ENSURE_FALSE(row, NS_ERROR_FILE_CORRUPTED);
          if (input.version == 3)
            MOZ_TRY(
                CheckStoredJSONCacheReceipt(cx, sConnection, input, receipt));
          MOZ_TRY(CacheParseJSON(cx, receipt, &expected));
        } else {
          MOZ_TRY(GetFolderCacheImportReceipt(actual, cx, &expected));
        }
        actual.setObject(*saved);
        MOZ_TRY(StartupEqual(cx, expected, actual));
        if (!reusing) {
          CacheImport input;
          JS::Rooted<JS::Value> requestValue(cx, JS::ObjectValue(*request));
          MOZ_TRY(CacheRequest(cx, requestValue, input));
          for (const auto& folder : input.folders) {
            if (!folder.isServer) continue;
            NS_ENSURE_TRUE(
                MOZ_TRY(mFolderDatabase->GetFolderParent(folder.id)) == 0,
                NS_ERROR_NOT_AVAILABLE);
            nsCString key = MOZ_TRY(mFolderDatabase->GetFolderName(folder.id));
            bool bound = false;
            for (const auto& server : operation.servers) {
              if (server.key != key) continue;
              NS_ENSURE_TRUE(
                  server.path == folder.storePath &&
                      server.protocol == folder.protocol &&
                      (server.protocol == "none"_ns ||
                       server.protocol == "imap"_ns) &&
                      ((folder.storeType == "mbox"_ns &&
                        server.contract ==
                            "@mozilla.org/msgstore/berkeleystore;1"_ns) ||
                       (folder.storeType == "maildir"_ns &&
                        server.contract ==
                            "@mozilla.org/msgstore/maildirstore;1"_ns)),
                  NS_ERROR_NOT_AVAILABLE);
              bound = true;
            }
            NS_ENSURE_TRUE(bound, NS_ERROR_NOT_AVAILABLE);
            cacheStoreRoots.AppendElement(folder.storePath);
          }
        }
      }
    }
  }
  if (reusing) {
    // Prepare all native wrappers first; no user getter runs between successful
    // readback and installing their retained physical paths.
    struct Binding {
      nsCOMPtr<nsIMsgFolder> folder;
      nsCOMPtr<nsIFile> before, after;
    };
    nsTArray<Binding> bindings;
    AutoRestore<uint32_t> metadata(mStartupMetadataDepth);
    ++mStartupMetadataDepth;
    NS_ENSURE_FALSE(mStartupLocalPaths, NS_ERROR_IN_PROGRESS);
    AutoRestore<const nsTHashMap<uint64_t, nsCString>*> paths(
        mStartupLocalPaths);
    mStartupLocalPaths = &retainedLocalPaths;
    for (auto entry = retainedLocalPaths.Iter(); !entry.Done(); entry.Next()) {
      auto& binding = *bindings.AppendElement();
      MOZ_TRY(mFolderDatabase->GetMsgFolderForFolder(
          entry.Key(), getter_AddRefs(binding.folder)));
      NS_ENSURE_TRUE(binding.folder, NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(binding.folder->GetFilePath(getter_AddRefs(binding.before)));
      MOZ_TRY(
          NS_NewNativeLocalFile(entry.Data(), getter_AddRefs(binding.after)));
    }
    uint32_t installed = 0;
    auto rollback = MakeScopeExit([&] {
      for (uint32_t i = 0; i < installed; ++i)
        (void)bindings[i].folder->SetFilePath(bindings[i].before);
    });
    MOZ_TRY(CheckProfileStartup(ProfileStartupToken(), true));
    for (auto& binding : bindings) {
      MOZ_TRY(binding.folder->SetFilePath(binding.after));
      ++installed;
    }
    MOZ_TRY(CheckProfileStartup(ProfileStartupToken(), true));
    for (const auto& binding : bindings)
      operation.localFolders.AppendElement(binding.folder);
    rollback.release();
    return NS_OK;
  }
  nsTArray<nsCString> finalInventory;
  MOZ_TRY(StartupInventory(operation.profile, finalInventory));
  MOZ_TRY(StartupConfiguredRoots(operation.profile, finalInventory));
  for (const auto& path : finalInventory) {
    if (StringEndsWith(path, ".msf"_ns) || StringEndsWith(path, ".mab"_ns) ||
        StringEndsWith(path, "/panacea.dat"_ns) ||
        StringEndsWith(path, "/folderCache.json"_ns))
      NS_ENSURE_TRUE(declaredPaths.Contains(path), NS_ERROR_NOT_AVAILABLE);
  }
  MOZ_TRY(
      StartupStores(operation, finalInventory, declaredPaths, cacheStoreRoots));
  return NS_OK;
}
NS_IMETHODIMP DatabaseCore::CompleteProfileStartup(
    nsISupports* token, JS::Handle<JS::Value> activation, JSContext* cx,
    Promise** output) {
  MOZ_TRY(CheckProfileStartup(token));
  ErrorResult error;
  RefPtr<Promise> promise =
      Promise::Create(xpc::CurrentNativeGlobal(cx), error);
  if (error.Failed()) return error.StealNSResult();
  nsresult rv = CheckProfileActivation(cx, activation);
  if (NS_FAILED(rv)) {
    mProfileStartup->Remember(rv);
    JS::Rooted<JS::Value> exception(cx);
    if (JS_IsExceptionPending(cx) && JS_GetPendingException(cx, &exception)) {
      JS_ClearPendingException(cx);
      promise->MaybeReject(exception);
    } else {
      promise->MaybeReject(rv);
    }
  } else {
    // The final native check runs without a caller getter between it and ready.
    rv = CheckProfileStartup(token);
    if (NS_FAILED(rv)) {
      mProfileStartup->Remember(rv);
      promise->MaybeReject(rv);
    } else {
      // Readiness admits ordinary work, but the actual close blocker remains
      // until account shutdown and the native SQLite close callback settle.
      mProfileStartup->ready = true;
      promise->MaybeResolveWithUndefined();
    }
  }
  promise.forget(output);
  return NS_OK;
}
NS_IMETHODIMP DatabaseCore::FailProfileStartup(nsISupports* token,
                                               nsresult failure, JSContext* cx,
                                               Promise** output) {
  NS_ENSURE_TRUE(NS_IsMainThread() && mProfileStartup &&
                     token == ProfileStartupToken() && !mProfileStartup->ready,
                 NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_FALSE(mProfileStartup->busy, NS_ERROR_IN_PROGRESS);
  ErrorResult error;
  RefPtr<Promise> promise =
      Promise::Create(xpc::CurrentNativeGlobal(cx), error);
  if (error.Failed()) return error.StealNSResult();
  mProfileStartup->Remember(NS_FAILED(failure) ? failure : NS_ERROR_FAILURE);
  if (mProfileStartup->settled) {
    if (NS_FAILED(mProfileStartup->closeError))
      promise->MaybeReject(mProfileStartup->firstError);
    else
      promise->MaybeResolveWithUndefined();
  } else {
    mProfileStartup->settlements.AppendElement(promise);
    nsresult rv = SettleProfileStartup(failure);
    if (NS_FAILED(rv)) {
      mProfileStartup->settlements.RemoveElement(promise);
      promise->MaybeReject(mProfileStartup->firstError);
    }
  }
  promise.forget(output);
  return NS_OK;
}

nsresult DatabaseCore::ReadSourceIdForFolderAdmission(nsACString& output) {
  NS_ENSURE_TRUE(sInstance.get() == this && sConnection && !mShuttingDown,
                 NS_ERROR_NOT_AVAILABLE);
  return ReadDatabaseSourceId(sConnection, output);
}

NS_IMETHODIMP
DatabaseCore::GetSourceId(nsACString& sourceId) {
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

NS_IMETHODIMP
DatabaseCore::OpenFolderDB(nsIMsgFolder* aFolder, bool aLeaveInvalidDB,
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
NS_IMETHODIMP
DatabaseCore::CreateNewDB(nsIMsgFolder* aFolder, nsIMsgDatabase** _retval) {
  NS_ENSURE_ARG_POINTER(_retval);
  *_retval = nullptr;
  NS_ENSURE_ARG_POINTER(aFolder);
  NS_ENSURE_TRUE(!mShuttingDown && mFolderDatabase && mMessageDatabase,
                 NS_ERROR_NOT_AVAILABLE);
  nsAutoCString name;
  MOZ_TRY(aFolder->GetName(name));
  nsCOMPtr<nsIMsgFolder> msgParent;
  MOZ_TRY(aFolder->GetParent(getter_AddRefs(msgParent)));
  NS_ENSURE_ARG(msgParent);
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
NS_IMETHODIMP
DatabaseCore::OpenDBFromFile(nsIFile* aFile, nsIMsgFolder* aFolder,
                             bool aCreate, bool aLeaveInvalidDB,
                             nsIMsgDatabase** _retval) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP
DatabaseCore::RegisterPendingListener(nsIMsgFolder* folder,
                                      nsIDBChangeListener* listener) {
  // This function was meant to wait for a database to open, but let's just
  // open it. They're not real anyway.
  nsCOMPtr<nsIMsgDatabase> database;
  nsresult rv = OpenFolderDB(folder, false, getter_AddRefs(database));
  NS_ENSURE_SUCCESS(rv, rv);

  return database->AddListener(listener);
}
NS_IMETHODIMP
DatabaseCore::UnregisterPendingListener(nsIDBChangeListener* listener) {
  return NS_OK;
}
NS_IMETHODIMP
DatabaseCore::CachedDBForFolder(nsIMsgFolder* aFolder,
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
NS_IMETHODIMP
DatabaseCore::CachedDBForFilePath(nsIFile* filePath, nsIMsgDatabase** _retval) {
  NS_ENSURE_ARG_POINTER(_retval);
  *_retval = nullptr;
  NS_ENSURE_ARG_POINTER(filePath);
  nsString path;
  MOZ_TRY(filePath->GetPath(path));
  RefPtr<PerFolderDatabase> db = mOpenDatabasesByFile.Get(path).get();
  db.forget(_retval);
  return NS_OK;
}
NS_IMETHODIMP
DatabaseCore::ForceFolderDBClosed(nsIMsgFolder* aFolder) {
  nsCOMPtr<nsIMsgDatabase> db;
  MOZ_TRY(CachedDBForFolder(aFolder, getter_AddRefs(db)));
  return db ? db->ForceClosed() : NS_OK;
}
NS_IMETHODIMP
DatabaseCore::GetOpenDBs(nsTArray<RefPtr<nsIMsgDatabase>>& aOpenDBs) {
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

NS_IMETHODIMP
DatabaseCoreFactory::CreateInstance(const nsIID& aIID, void** aResult) {
  *aResult = nullptr;
  nsresult rv;
  nsCOMPtr<nsIDatabaseCore> core =
      do_GetService("@mozilla.org/mailnews/database-core;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  return core->QueryInterface(aIID, aResult);
}

}  // namespace mozilla::mailnews
