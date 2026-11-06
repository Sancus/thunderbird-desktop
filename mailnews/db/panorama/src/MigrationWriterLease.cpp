/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "MigrationWriterLease.h"

#include "DatabaseCore.h"
#include "ImapMigrationWriterLease.h"
#include "LocalStoreMigrationLease.h"
#include "js/Array.h"
#include "js/JSON.h"
#include "js/Exception.h"
#include "js/Realm.h"
#include "js/Wrapper.h"
#include "js/CallAndConstruct.h"
#include "js/Conversions.h"
#include "js/Promise.h"
#include "js/PropertyAndElement.h"
#include "js/RootingAPI.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/StaticMutex.h"
#include "mozilla/StaticPtr.h"
#include "mozilla/SpinEventLoopUntil.h"
#include "mozilla/Try.h"
#include "mozilla/dom/AbortController.h"
#include "mozilla/dom/AbortSignal.h"
#include "mozilla/dom/ToJSValue.h"
#include "mozilla/dom/ChromeUtils.h"
#include "mozilla/dom/ChromeUtilsBinding.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/dom/PromiseNativeHandler.h"
#include "mozilla/dom/ScriptSettings.h"
#include "nsComponentManagerUtils.h"
#include "nsContentUtils.h"
#include <iterator>
#include <cstring>
#include <cstdio>
#include <inttypes.h>
#include "nsIFile.h"
#include "nsJSUtils.h"
#include "nsPrintfCString.h"
#include "nsIMsgOperationListener.h"
#include "nsIPropertyBag2.h"
#include "nsISimpleEnumerator.h"
#include "nsIToolkitProfile.h"
#include "nsIVariant.h"
#include "nsIWritablePropertyBag2.h"
#include "nsServiceManagerUtils.h"
#include "nsThreadUtils.h"
#include "xpcpublic.h"
#include <functional>
#ifdef XP_WIN
#  include <windows.h>
#else
#  include <fcntl.h>
#  include <sys/stat.h>
#  include <unistd.h>
#endif

namespace mozilla::mailnews {
namespace {
StaticMutex sWriterMutex;
MigrationWriterLease* sActiveLease = nullptr;  // XRE/real callbacks retain it.
bool sFailedProcess = false;
uint64_t sNextGeneration = 0;
MigrationWriterHistory sHistory[14] = {};
constexpr const char* kDomains[] = {"account",
                                    "native-database",
                                    "legacy-database",
                                    "imap",
                                    "local-store",
                                    "pop3",
                                    "mail-search",
                                    "chat-search",
                                    "chat",
                                    "news",
                                    "smtp",
                                    "rss",
                                    "compose",
                                    "send-later"};
bool ValidDomain(MigrationWriterDomain aDomain) {
  return uint8_t(aDomain) < std::size(kDomains);
}
nsresult Domain(const nsAString& aName, MigrationWriterDomain& aDomain) {
  for (uint8_t i = 0; i < std::size(kDomains); ++i) {
    if (aName.EqualsASCII(kDomains[i])) {
      aDomain = MigrationWriterDomain(i);
      return NS_OK;
    }
  }
  return NS_ERROR_INVALID_ARG;
}

// Retain real selected-directory handles; path spelling alone is not identity.
class SelectedDirectory final {
 public:
  nsresult Open(nsIFile* aFile, bool aDirectory = true) {
    mDirectory = aDirectory;
    MOZ_TRY(aFile->Clone(getter_AddRefs(mFile)));
    bool link = true;
    MOZ_TRY(mFile->IsSymlink(&link));
    NS_ENSURE_FALSE(link, NS_ERROR_NOT_AVAILABLE);
    // Retain and revalidate this exact spelling. Normalizing here could follow
    // a newly substituted ancestor link and silently capture a foreign root.
#ifdef XP_WIN
    nsAutoString path;
    MOZ_TRY(mFile->GetPath(path));
    mHandle = CreateFileW(
        reinterpret_cast<LPCWSTR>(path.get()), FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    NS_ENSURE_TRUE(mHandle != INVALID_HANDLE_VALUE,
                   NS_ERROR_FILE_ACCESS_DENIED);
    NS_ENSURE_TRUE(GetFileInformationByHandle(mHandle, &mIdentity),
                   NS_ERROR_FILE_ACCESS_DENIED);
    NS_ENSURE_TRUE(
        !(mIdentity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
            bool(mIdentity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ==
                mDirectory,
        NS_ERROR_NOT_AVAILABLE);
#else
    nsAutoCString path;
    MOZ_TRY(mFile->GetNativePath(path));
    mFd = open(path.get(), O_RDONLY | (mDirectory ? O_DIRECTORY : 0) |
                               O_CLOEXEC | O_NOFOLLOW);
    NS_ENSURE_TRUE(mFd >= 0, NS_ERROR_FILE_ACCESS_DENIED);
    NS_ENSURE_TRUE(fstat(mFd, &mIdentity) == 0, NS_ERROR_FILE_ACCESS_DENIED);
#endif
    return Validate();
  }
  nsresult Validate() const {
    NS_ENSURE_TRUE(mFile, NS_ERROR_NOT_AVAILABLE);
    bool link = true;
    MOZ_TRY(mFile->IsSymlink(&link));
    NS_ENSURE_FALSE(link, NS_ERROR_NOT_AVAILABLE);
#ifdef XP_WIN
    nsAutoString path;
    MOZ_TRY(mFile->GetPath(path));
    HANDLE current = CreateFileW(
        reinterpret_cast<LPCWSTR>(path.get()), FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    NS_ENSURE_TRUE(current != INVALID_HANDLE_VALUE, NS_ERROR_NOT_AVAILABLE);
    BY_HANDLE_FILE_INFORMATION info{};
    bool ok = GetFileInformationByHandle(current, &info);
    CloseHandle(current);
    NS_ENSURE_TRUE(
        ok && !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
            bool(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ==
                mDirectory &&
            info.dwVolumeSerialNumber == mIdentity.dwVolumeSerialNumber &&
            info.nFileIndexHigh == mIdentity.nFileIndexHigh &&
            info.nFileIndexLow == mIdentity.nFileIndexLow,
        NS_ERROR_NOT_AVAILABLE);
#else
    nsAutoCString path;
    MOZ_TRY(mFile->GetNativePath(path));
    struct stat current {
    }, held{};
    NS_ENSURE_TRUE(lstat(path.get(), &current) == 0 && fstat(mFd, &held) == 0 &&
                       (mDirectory ? S_ISDIR(current.st_mode)
                                   : S_ISREG(current.st_mode)) &&
                       current.st_dev == mIdentity.st_dev &&
                       current.st_ino == mIdentity.st_ino &&
                       held.st_dev == mIdentity.st_dev &&
                       held.st_ino == mIdentity.st_ino,
                   NS_ERROR_NOT_AVAILABLE);
#endif
    // Checking every ancestor also rejects a link that resolves back to the
    // retained inode; physical equality alone cannot authorize a path alias.
    nsCOMPtr<nsIFile> part = mFile;
    while (part) {
      bool linked = true;
      MOZ_TRY(part->IsSymlink(&linked));
      NS_ENSURE_FALSE(linked, NS_ERROR_NOT_AVAILABLE);
      nsCOMPtr<nsIFile> parent;
      MOZ_TRY(part->GetParent(getter_AddRefs(parent)));
      part = parent;
    }
    return NS_OK;
  }
  nsCString Identity() const {
#ifdef XP_WIN
    return nsPrintfCString("%lu:%lu:%lu", mIdentity.dwVolumeSerialNumber,
                           mIdentity.nFileIndexHigh, mIdentity.nFileIndexLow);
#else
    return nsPrintfCString("%llu:%llu",
                           static_cast<unsigned long long>(mIdentity.st_dev),
                           static_cast<unsigned long long>(mIdentity.st_ino));
#endif
  }
  ~SelectedDirectory() {
#ifdef XP_WIN
    if (mHandle != INVALID_HANDLE_VALUE) CloseHandle(mHandle);
#else
    if (mFd >= 0) close(mFd);
#endif
  }

 private:
  bool mDirectory = true;
  nsCOMPtr<nsIFile> mFile;
#ifdef XP_WIN
  HANDLE mHandle = INVALID_HANDLE_VALUE;
  BY_HANDLE_FILE_INFORMATION mIdentity{};
#else
  int mFd = -1;
  struct stat mIdentity {};
#endif
};

// Never forward QI to the mutable backing bag.
class ReadOnlyMigrationBag : public nsIPropertyBag2 {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIPROPERTYBAG
  NS_DECL_NSIPROPERTYBAG2
 protected:
  virtual ~ReadOnlyMigrationBag() = default;
  virtual nsresult Snapshot(nsIPropertyBag2** aBag) = 0;
};
NS_IMPL_ISUPPORTS(ReadOnlyMigrationBag, nsIPropertyBag, nsIPropertyBag2)
NS_IMETHODIMP ReadOnlyMigrationBag::GetEnumerator(
    nsISimpleEnumerator** aResult) {
  nsCOMPtr<nsIPropertyBag2> bag;
  MOZ_TRY(Snapshot(getter_AddRefs(bag)));
  return bag->GetEnumerator(aResult);
}
NS_IMETHODIMP ReadOnlyMigrationBag::GetProperty(const nsAString& aName,
                                                nsIVariant** aResult) {
  nsCOMPtr<nsIPropertyBag2> bag;
  MOZ_TRY(Snapshot(getter_AddRefs(bag)));
  return bag->GetProperty(aName, aResult);
}
#define BAG_GET(Name, Type)                                        \
  NS_IMETHODIMP ReadOnlyMigrationBag::Name(const nsAString& aName, \
                                           Type aResult) {         \
    nsCOMPtr<nsIPropertyBag2> bag;                                 \
    MOZ_TRY(Snapshot(getter_AddRefs(bag)));                        \
    return bag->Name(aName, aResult);                              \
  }
BAG_GET(GetPropertyAsInt32, int32_t*)
BAG_GET(GetPropertyAsUint32, uint32_t*)
BAG_GET(GetPropertyAsInt64, int64_t*)
BAG_GET(GetPropertyAsUint64, uint64_t*)
BAG_GET(GetPropertyAsDouble, double*)
BAG_GET(GetPropertyAsAString, nsAString&)
BAG_GET(GetPropertyAsACString, nsACString&)
BAG_GET(GetPropertyAsAUTF8String, nsACString&)
BAG_GET(GetPropertyAsBool, bool*)
BAG_GET(Get, nsIVariant**)
BAG_GET(HasKey, bool*)
#undef BAG_GET
NS_IMETHODIMP ReadOnlyMigrationBag::GetPropertyAsInterface(
    const nsAString& aName, const nsIID& aIID, void** aResult) {
  nsCOMPtr<nsIPropertyBag2> bag;
  MOZ_TRY(Snapshot(getter_AddRefs(bag)));
  return bag->GetPropertyAsInterface(aName, aIID, aResult);
}
class SelectedView final : public ReadOnlyMigrationBag {
 public:
  explicit SelectedView(nsIPropertyBag2* aBag) : mBag(aBag) {}

 private:
  ~SelectedView() = default;
  nsresult Snapshot(nsIPropertyBag2** aBag) override {
    NS_IF_ADDREF(*aBag = mBag);
    return NS_OK;
  }
  nsCOMPtr<nsIPropertyBag2> mBag;
};
class AdmissionSubject final : public nsISupports {
 public:
  NS_DECL_ISUPPORTS
 private:
  ~AdmissionSubject() = default;
};
NS_IMPL_ISUPPORTS(AdmissionSubject, nsISupports)

class MigrationWriterGate final : public ReadOnlyMigrationBag,
                                  public nsIObserver {
 public:
  NS_DECL_ISUPPORTS_INHERITED
  NS_DECL_NSIOBSERVER
  MigrationWriterGate() : mSubject(new AdmissionSubject()) {}

 private:
  ~MigrationWriterGate() = default;
  nsCOMPtr<nsISupports> mSubject;
  nsresult Snapshot(nsIPropertyBag2** aBag) override {
    nsCOMPtr<nsIWritablePropertyBag2> bag =
        do_CreateInstance("@mozilla.org/hash-property-bag;1");
    NS_ENSURE_TRUE(bag, NS_ERROR_OUT_OF_MEMORY);
    MOZ_TRY(
        bag->SetPropertyAsInterface(u"writer-admission-subject"_ns, mSubject));
    for (uint8_t i = 0; i < std::size(kDomains); ++i) {
      MigrationWriterHistory history;
      MOZ_TRY(GetMigrationWriterHistory(MigrationWriterDomain(i), &history));
      nsAutoString name(u"writer-history.");
      name.AppendASCII(kDomains[i]);
      MOZ_TRY(bag->SetPropertyAsUint32(name, uint32_t(history)));
    }
    nsCOMPtr<nsIPropertyBag2> result = do_QueryInterface(bag);
    result.forget(aBag);
    return NS_OK;
  }
};
NS_IMPL_ISUPPORTS_INHERITED(MigrationWriterGate, ReadOnlyMigrationBag,
                            nsIObserver)
}  // namespace

struct MigrationWriterLease::State {
  SelectedDirectory profile;
  SelectedDirectory local;
  struct CapturedRoot {
    MigrationRootBinding binding;
    nsCOMPtr<nsIFile> file;
    UniquePtr<SelectedDirectory> parent;
    UniquePtr<SelectedDirectory> leaf;
  };
  nsTArray<UniquePtr<CapturedRoot>> roots;
  nsTArray<MigrationRootBinding> rootBindings;
  nsString inventoryJSON;
  bool inventoryCaptured = false;
  MigrationPhase phase = MigrationPhase::Armed;
  nsresult first = NS_OK;
  nsTArray<nsresult> secondary;
  bool imapSettled = false;
  bool localSettled = false;
  bool searchSettled = false;
  bool popSettled = false;
  bool databaseSettled = false;
  bool drainStarted = false;
  bool closeStarted = false;
  bool releaseStarted = false;
  bool consumerSettled = false;
  bool consumerInvoked = false;
  RefPtr<MigrationSettlementPromise> drainResult;
  RefPtr<MigrationSettlementPromise> releaseResult;
  bool searchAcquired = false;
  bool popAcquired = false;
  RefPtr<dom::AbortController> abortController;
  UniquePtr<JS::PersistentRootedValue> firstRejection;
  nsTArray<UniquePtr<JS::PersistentRootedValue>> secondaryRejections;
  uint32_t searchErrorsRead = 0;
};

nsresult GetMigrationWriterHistory(MigrationWriterDomain aDomain,
                                   MigrationWriterHistory* aHistory) {
  NS_ENSURE_TRUE(aHistory && ValidDomain(aDomain), NS_ERROR_INVALID_ARG);
  StaticMutexAutoLock lock(sWriterMutex);
  *aHistory = sHistory[uint8_t(aDomain)];
  return NS_OK;
}
nsresult CheckMigrationWriter(MigrationWriterDomain aDomain,
                              MigrationWriterCheck aCheck) {
  if (!ValidDomain(aDomain) ||
      (aCheck != MigrationWriterCheck::NewAdmission &&
       aCheck != MigrationWriterCheck::RequireNeverStarted)) {
    RefPtr<MigrationWriterLease> active;
    {
      StaticMutexAutoLock lock(sWriterMutex);
      active = sActiveLease;
    }
    if (active) active->RecordError(NS_ERROR_INVALID_ARG);
    return NS_ERROR_INVALID_ARG;
  }
  RefPtr<MigrationWriterLease> active;
  {
    StaticMutexAutoLock lock(sWriterMutex);
    if (aCheck == MigrationWriterCheck::RequireNeverStarted) {
      return !sFailedProcess && sHistory[uint8_t(aDomain)] ==
                                    MigrationWriterHistory::NeverStarted
                 ? NS_OK
                 : NS_ERROR_NOT_AVAILABLE;
    }
    active = sActiveLease;
    if (!active && !sFailedProcess) {
      sHistory[uint8_t(aDomain)] = MigrationWriterHistory::Started;
      return NS_OK;
    }
  }
  if (active) active->RecordError(NS_ERROR_NOT_AVAILABLE);
  return NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP MigrationWriterGate::Observe(nsISupports* aSubject,
                                           const char* aTopic,
                                           const char16_t* aData) {
  NS_ENSURE_TRUE(aTopic && aData, NS_ERROR_INVALID_ARG);
  nsCOMPtr<nsISupports> subject = do_QueryInterface(aSubject);
  if (!strcmp(aTopic, "validate-selected-view")) {
    RefPtr<MigrationWriterLease> active;
    {
      StaticMutexAutoLock lock(sWriterMutex);
      active = sActiveLease;
    }
    NS_ENSURE_TRUE(active, NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsISupports> view = active->SelectedView();
    NS_ENSURE_TRUE(view && subject == view, NS_ERROR_NOT_AVAILABLE);
    nsDependentString phase(aData);
    NS_ENSURE_TRUE(phase.EqualsLiteral("before-source-read") ||
                       phase.EqualsLiteral("after-await") ||
                       phase.EqualsLiteral("before-publication"),
                   NS_ERROR_INVALID_ARG);
    MOZ_TRY(active->ValidateSelectedIdentity());
    // Already-owned cleanup must validate its generation even when another
    // participant failed. This grants no new work, global Held or source IO.
    if (phase.EqualsLiteral("after-await")) return NS_OK;
    MOZ_TRY(active->FirstError());
    NS_ENSURE_TRUE(active->Phase() == MigrationPhase::Held ||
                       active->Phase() == MigrationPhase::SnapshotPending,
                   NS_ERROR_NOT_AVAILABLE);
    return NS_OK;
  }
  nsresult result = NS_OK;
  MigrationWriterDomain domain;
  if (!subject || subject != mSubject) {
    result = NS_ERROR_NOT_AVAILABLE;
  } else {
    result = Domain(nsDependentString(aData), domain);
    if (NS_SUCCEEDED(result)) {
      if (!strcmp(aTopic, "check-writer-admission")) {
        result = CheckMigrationWriter(domain);
      } else if (!strcmp(aTopic, "check-writer-never-started")) {
        result = CheckMigrationWriter(
            domain, MigrationWriterCheck::RequireNeverStarted);
      } else {
        result = NS_ERROR_INVALID_ARG;
      }
    }
  }
  if (NS_FAILED(result)) {
    RefPtr<MigrationWriterLease> active;
    {
      StaticMutexAutoLock lock(sWriterMutex);
      active = sActiveLease;
    }
    if (active) active->RecordError(result);
  }
  return result;
}
already_AddRefed<nsIObserver> CreateMigrationWriterGate() {
  static StaticRefPtr<MigrationWriterGate> gate;
  if (!gate) {
    gate = new MigrationWriterGate();
    ClearOnShutdown(&gate);
  }
  nsCOMPtr<nsIObserver> result = gate;
  return result.forget();
}

MigrationWriterLease::MigrationWriterLease(
    nsIProfileLock* aLock, nsIFile* aProfile, nsIFile* aLocal,
    const SelectedSnapshotRequest& aRequest, uint64_t aGeneration)
    : mState(MakeUnique<State>()),
      mGeneration(aGeneration),
      mLock(aLock),
      mProfile(aProfile),
      mLocal(aLocal),
      mRequest(aRequest) {}
MigrationWriterLease::~MigrationWriterLease() {
  StaticMutexAutoLock lock(sWriterMutex);
  if (sActiveLease == this) {
    // Dropping a failed operation is never permission for ordinary startup.
    sFailedProcess = true;
    sActiveLease = nullptr;
  }
  // XRE owns Unlock, including on all failure paths.
}
Result<RefPtr<MigrationWriterLease>, nsresult>
MigrationWriterLease::ArmSelected(nsIProfileLock* aLock, nsIFile* aProfile,
                                  nsIFile* aLocal,
                                  const SelectedSnapshotRequest& aRequest) {
  if (!NS_IsMainThread() || !aLock || !aProfile || !aLocal ||
      aRequest.path.IsEmpty())
    return Err(NS_ERROR_INVALID_ARG);
  nsCOMPtr<nsIFile> requestFile;
  MOZ_TRY(NS_NewLocalFile(aRequest.path, getter_AddRefs(requestFile)));
  nsCOMPtr<nsIFile> profile, local;
  MOZ_TRY(aLock->GetDirectory(getter_AddRefs(profile)));
  MOZ_TRY(aLock->GetLocalDirectory(getter_AddRefs(local)));
  bool equal = false;
  NS_ENSURE_TRUE(profile && local, Err(NS_ERROR_NOT_AVAILABLE));
  MOZ_TRY(profile->Equals(aProfile, &equal));
  if (!equal) return Err(NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(local->Equals(aLocal, &equal));
  if (!equal) return Err(NS_ERROR_NOT_AVAILABLE);
  uint64_t generation;
  {
    StaticMutexAutoLock lock(sWriterMutex);
    if (sActiveLease) return Err(NS_ERROR_IN_PROGRESS);
    if (sFailedProcess || sNextGeneration == UINT64_MAX)
      return Err(NS_ERROR_NOT_AVAILABLE);
    generation = ++sNextGeneration;
  }
  // The actual lock is an independent anchor: never share its mutable nsIFile
  // with native participants or the read-only script view.
  nsCOMPtr<nsIFile> retainedProfile, retainedLocal;
  MOZ_TRY(profile->Clone(getter_AddRefs(retainedProfile)));
  MOZ_TRY(local->Clone(getter_AddRefs(retainedLocal)));
  RefPtr<MigrationWriterLease> lease = new MigrationWriterLease(
      aLock, retainedProfile, retainedLocal, aRequest, generation);
  MOZ_TRY(lease->mState->profile.Open(profile));
  MOZ_TRY(lease->mState->local.Open(local));
  {
    StaticMutexAutoLock lock(sWriterMutex);
    if (sActiveLease || sFailedProcess) return Err(NS_ERROR_IN_PROGRESS);
    sActiveLease = lease;
  }
  return lease;
}
nsresult MigrationWriterLease::ValidateGeneration(uint64_t aGeneration) const {
  StaticMutexAutoLock lock(sWriterMutex);
  return sActiveLease == this && aGeneration == mGeneration &&
                 mState->phase != MigrationPhase::Released
             ? NS_OK
             : NS_ERROR_NOT_AVAILABLE;
}
nsresult MigrationWriterLease::ValidateSelectedIdentity() const {
  NS_ENSURE_TRUE(NS_IsMainThread(), NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(ValidateGeneration(mGeneration));
  nsCOMPtr<nsIFile> profile, local;
  MOZ_TRY(mLock->GetDirectory(getter_AddRefs(profile)));
  MOZ_TRY(mLock->GetLocalDirectory(getter_AddRefs(local)));
  NS_ENSURE_TRUE(profile && local, NS_ERROR_NOT_AVAILABLE);
  bool equal = false;
  MOZ_TRY(profile->Equals(mProfile, &equal));
  NS_ENSURE_TRUE(equal, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(local->Equals(mLocal, &equal));
  NS_ENSURE_TRUE(equal, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(mState->profile.Validate());
  MOZ_TRY(mState->local.Validate());
  for (const auto& root : mState->roots) {
    MOZ_TRY(root->parent->Validate());
    if (root->leaf) {
      MOZ_TRY(root->leaf->Validate());
    } else {
      bool exists = true;
      MOZ_TRY(root->file->Exists(&exists));
      NS_ENSURE_FALSE(exists, NS_ERROR_NOT_AVAILABLE);
    }
  }
  return NS_OK;
}
void MigrationWriterLease::RecordError(nsresult aResult) const {
  if (NS_SUCCEEDED(aResult)) return;
  StaticMutexAutoLock lock(sWriterMutex);
  if (NS_SUCCEEDED(mState->first))
    mState->first = aResult;
  else
    mState->secondary.AppendElement(aResult);
}
nsresult MigrationWriterLease::FirstError() const {
  StaticMutexAutoLock lock(sWriterMutex);
  return mState->first;
}
nsTArray<nsresult> MigrationWriterLease::SecondaryErrors() const {
  StaticMutexAutoLock lock(sWriterMutex);
  return mState->secondary.Clone();
}
MigrationPhase MigrationWriterLease::Phase() const {
  StaticMutexAutoLock lock(sWriterMutex);
  return mState->phase;
}
nsresult MigrationWriterLease::EnsureView() {
  MOZ_TRY(ValidateSelectedIdentity());
  if (mView) return NS_OK;
  nsCOMPtr<nsIWritablePropertyBag2> bag =
      do_CreateInstance("@mozilla.org/hash-property-bag;1");
  NS_ENSURE_TRUE(bag, NS_ERROR_OUT_OF_MEMORY);
  // The actual lock is native-only. Exposing its Unlock method is authority.
  mViewProperties = bag;
  nsCOMPtr<nsIFile> profileView, localView;
  MOZ_TRY(mProfile->Clone(getter_AddRefs(profileView)));
  MOZ_TRY(mLocal->Clone(getter_AddRefs(localView)));
  MOZ_TRY(bag->SetPropertyAsInterface(u"profile-directory"_ns, profileView));
  MOZ_TRY(bag->SetPropertyAsInterface(u"local-directory"_ns, localView));
  nsAutoString path;
  MOZ_TRY(mProfile->GetPath(path));
  MOZ_TRY(bag->SetPropertyAsAString(u"profile-path"_ns, path));
  MOZ_TRY(mLocal->GetPath(path));
  MOZ_TRY(bag->SetPropertyAsAString(u"local-path"_ns, path));
  MOZ_TRY(bag->SetPropertyAsAString(u"request-path"_ns, mRequest.path));
  MOZ_TRY(bag->SetPropertyAsUint64(u"generation"_ns, mGeneration));
  MOZ_TRY(
      bag->SetPropertyAsAString(u"inventory-json"_ns, mState->inventoryJSON));
  nsCOMPtr<nsIPropertyBag2> properties = do_QueryInterface(bag);
  mView = new SelectedView(properties);
  return NS_OK;
}
already_AddRefed<nsISupports> MigrationWriterLease::SelectedView() {
  if (NS_FAILED(EnsureView())) return nullptr;
  nsCOMPtr<nsISupports> result = do_QueryInterface(mView);
  return result.forget();
}
namespace {
class OperationTerminal final : public nsIMsgOperationListener {
 public:
  NS_DECL_ISUPPORTS
  explicit OperationTerminal(std::function<void(nsresult)> aDone)
      : mDone(std::move(aDone)) {}
  NS_IMETHOD OnStopOperation(nsresult aResult) override {
    NS_ENSURE_TRUE(mDone, NS_ERROR_UNEXPECTED);
    auto done = std::move(mDone);
    done(aResult);
    return NS_OK;
  }

 private:
  ~OperationTerminal() = default;
  std::function<void(nsresult)> mDone;
};
NS_IMPL_ISUPPORTS(OperationTerminal, nsIMsgOperationListener)
class JSTerminal final : public dom::PromiseNativeHandler {
 public:
  NS_DECL_ISUPPORTS
  JSTerminal(MigrationWriterLease* aLease, std::function<void(nsresult)> aDone)
      : mLease(aLease), mDone(std::move(aDone)) {}
  void ResolvedCallback(JSContext*, JS::HandleValue, ErrorResult&) override {
    auto done = std::move(mDone);
    if (done) done(NS_OK);
  }
  void RejectedCallback(JSContext* aCx, JS::HandleValue aValue,
                        ErrorResult&) override {
    nsresult failure = NS_ERROR_FAILURE;
    if (aValue.isObject()) {
      JS::RootedObject error(aCx, &aValue.toObject());
      JS::RootedValue result(aCx);
      uint32_t code;
      if (JS_GetProperty(aCx, error, "result", &result) && result.isNumber() &&
          JS::ToUint32(aCx, result, &code) && NS_FAILED(nsresult(code))) {
        failure = nsresult(code);
      }
      JS_ClearPendingException(aCx);
    }
    mLease->KeepJSRejection(aCx, aValue);
    auto done = std::move(mDone);
    if (done) done(failure);
  }

 private:
  ~JSTerminal() = default;
  RefPtr<MigrationWriterLease> mLease;
  std::function<void(nsresult)> mDone;
};
NS_IMPL_ISUPPORTS(JSTerminal, nsISupports)
nsresult JoinJS(JSContext* aCx, JS::HandleValue aValue,
                MigrationWriterLease* aLease,
                std::function<void(nsresult)> aDone) {
  NS_ENSURE_TRUE(aValue.isObject(), NS_ERROR_UNEXPECTED);
  JS::RootedObject object(aCx, js::CheckedUnwrapStatic(&aValue.toObject()));
  NS_ENSURE_TRUE(object && JS::IsPromiseObject(object), NS_ERROR_UNEXPECTED);
  JSAutoRealm realm(aCx, object);
  RefPtr<dom::Promise> promise = dom::Promise::CreateFromExisting(
      xpc::NativeGlobal(JS::CurrentGlobalOrNull(aCx)), object);
  NS_ENSURE_TRUE(promise, NS_ERROR_FAILURE);
  promise->AppendNativeHandler(new JSTerminal(aLease, std::move(aDone)));
  return NS_OK;
}
nsresult Import(JSContext* aCx, const nsAString& aURI,
                JS::MutableHandleObject aModule) {
  JS::RootedObject global(aCx, JS::CurrentGlobalOrNull(aCx));
  dom::GlobalObject caller(aCx, global);
  ErrorResult error;
  dom::ChromeUtils::ImportESModule(
      caller, aURI, dom::ImportESModuleOptionsDictionary(), aModule, error);
  return error.Failed() ? error.StealNSResult() : NS_OK;
}
nsresult PendingJSFailure(JSContext* aCx) {
  JS::RootedValue error(aCx);
  if (!JS_IsExceptionPending(aCx) || !JS_GetPendingException(aCx, &error)) {
    return NS_ERROR_FAILURE;
  }
  RefPtr<MigrationWriterLease> active;
  {
    StaticMutexAutoLock lock(sWriterMutex);
    active = sActiveLease;
  }
  if (active) active->KeepJSRejection(aCx, error);
  JS_ClearPendingException(aCx);
  nsresult failure = NS_ERROR_FAILURE;
  if (error.isObject()) {
    JS::RootedObject object(aCx, &error.toObject());
    JS::RootedValue result(aCx);
    uint32_t code;
    if (JS_GetProperty(aCx, object, "result", &result) && result.isNumber() &&
        JS::ToUint32(aCx, result, &code) && NS_FAILED(nsresult(code))) {
      failure = nsresult(code);
    }
    JS_ClearPendingException(aCx);
  }
  return failure;
}
nsresult Call(JSContext* aCx, JS::HandleObject aObject, const char* aMethod,
              const JS::HandleValueArray& aArgs,
              JS::MutableHandleValue aValue) {
  JS::RootedValue function(aCx);
  if (!JS_GetProperty(aCx, aObject, aMethod, &function) ||
      !JS::Call(aCx, aObject, function, aArgs, aValue)) {
    return PendingJSFailure(aCx);
  }
  return NS_OK;
}
}  // namespace

const nsTArray<MigrationRootBinding>& MigrationWriterLease::RootBindings()
    const {
  return mState->rootBindings;
}
nsresult MigrationWriterLease::ValidateRoot(nsIFile* aFile) const {
  NS_ENSURE_TRUE(aFile && mState->inventoryCaptured, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(ValidateSelectedIdentity());
  nsAutoString path;
  MOZ_TRY(aFile->GetPath(path));
  for (const auto& root : mState->roots) {
    if (path.Equals(root->binding.canonicalPath)) return NS_OK;
  }
  return NS_ERROR_NOT_AVAILABLE;
}
namespace {
nsresult StringProperty(JSContext* aCx, JS::HandleObject aObject,
                        const char* aName, nsAString& aResult,
                        bool aNullable = false) {
  JS::RootedValue value(aCx);
  NS_ENSURE_TRUE(JS_GetProperty(aCx, aObject, aName, &value), NS_ERROR_FAILURE);
  if (aNullable && value.isNull()) {
    aResult.Truncate();
    return NS_OK;
  }
  NS_ENSURE_TRUE(value.isString(), NS_ERROR_UNEXPECTED);
  nsAutoJSString text;
  NS_ENSURE_TRUE(text.init(aCx, value.toString()), NS_ERROR_OUT_OF_MEMORY);
  NS_ENSURE_TRUE(text.FindChar(char16_t(0)) == kNotFound, NS_ERROR_INVALID_ARG);
  aResult = text;
  return NS_OK;
}
nsresult SetStringProperty(JSContext* aCx, JS::HandleObject aObject,
                           const char* aName, const nsACString& aText) {
  JS::RootedString text(
      aCx, JS_NewStringCopyN(aCx, aText.BeginReading(), aText.Length()));
  NS_ENSURE_TRUE(text, NS_ERROR_OUT_OF_MEMORY);
  JS::RootedValue value(aCx, JS::StringValue(text));
  return JS_SetProperty(aCx, aObject, aName, value) ? NS_OK : NS_ERROR_FAILURE;
}
bool WriteInventory(const char16_t* aChars, uint32_t aLength, void* aData) {
  static_cast<nsString*>(aData)->Append(aChars, aLength);
  return true;
}
}  // namespace
nsresult MigrationWriterLease::CaptureInventory() {
  MOZ_ASSERT(NS_IsMainThread());
  if (mState->inventoryCaptured) return ValidateSelectedIdentity();
  MOZ_TRY(ValidateSelectedIdentity());
  dom::AutoJSAPI jsapi;
  NS_ENSURE_TRUE(jsapi.Init(xpc::PrivilegedJunkScope()), NS_ERROR_FAILURE);
  JSContext* cx = jsapi.cx();
  JS::RootedObject module(cx);
  MOZ_TRY(Import(cx,
                 u"resource:///modules/panorama/MigrationQuiescence.sys.mjs"_ns,
                 &module));
  JS::RootedValueArray<2> args(cx);
  for (uint32_t i = 0; i < 2; ++i) {
    nsAutoString path;
    MOZ_TRY((i ? mLocal : mProfile)->GetPath(path));
    JS::RootedString text(cx,
                          JS_NewUCStringCopyN(cx, path.get(), path.Length()));
    NS_ENSURE_TRUE(text, NS_ERROR_OUT_OF_MEMORY);
    args[i].setString(text);
  }
  JS::RootedValue inventory(cx), rootsValue(cx);
  MOZ_TRY(
      Call(cx, module, "collectSelectedMigrationInventory", args, &inventory));
  NS_ENSURE_TRUE(inventory.isObject(), NS_ERROR_UNEXPECTED);
  JS::RootedObject object(cx, &inventory.toObject());
  NS_ENSURE_TRUE(
      JS_GetProperty(cx, object, "roots", &rootsValue) && rootsValue.isObject(),
      NS_ERROR_UNEXPECTED);
  JS::RootedObject roots(cx, &rootsValue.toObject());
  bool array = false;
  NS_ENSURE_TRUE(JS::IsArrayObject(cx, roots, &array) && array,
                 NS_ERROR_UNEXPECTED);
  uint32_t length;
  NS_ENSURE_TRUE(JS::GetArrayLength(cx, roots, &length) && length >= 2,
                 NS_ERROR_UNEXPECTED);
  for (uint32_t i = 0; i < length; ++i) {
    JS::RootedValue value(cx), exists(cx);
    NS_ENSURE_TRUE(JS_GetElement(cx, roots, i, &value) && value.isObject(),
                   NS_ERROR_UNEXPECTED);
    JS::RootedObject entry(cx, &value.toObject());
    auto root = MakeUnique<State::CapturedRoot>();
    auto& b = root->binding;
    MOZ_TRY(StringProperty(cx, entry, "originalPath", b.originalPath));
    MOZ_TRY(StringProperty(cx, entry, "canonicalPath", b.canonicalPath));
    MOZ_TRY(StringProperty(cx, entry, "parentPath", b.parentPath));
    MOZ_TRY(StringProperty(cx, entry, "role", b.role));
    MOZ_TRY(StringProperty(cx, entry, "serverKey", b.serverKey, true));
    nsAutoString kind;
    MOZ_TRY(StringProperty(cx, entry, "kind", kind));
    NS_ENSURE_TRUE(
        kind.EqualsLiteral("file") || kind.EqualsLiteral("directory"),
        NS_ERROR_NOT_AVAILABLE);
    b.isDirectory = kind.EqualsLiteral("directory");
    NS_ENSURE_TRUE(
        JS_GetProperty(cx, entry, "exists", &exists) && exists.isBoolean(),
        NS_ERROR_UNEXPECTED);
    b.exists = exists.toBoolean();
    MOZ_TRY(NS_NewLocalFile(b.canonicalPath, getter_AddRefs(root->file)));
    nsCOMPtr<nsIFile> parent;
    MOZ_TRY(root->file->GetParent(getter_AddRefs(parent)));
    NS_ENSURE_TRUE(parent, NS_ERROR_NOT_AVAILABLE);
    nsAutoString parentPath;
    MOZ_TRY(parent->GetPath(parentPath));
    NS_ENSURE_TRUE(parentPath.Equals(b.parentPath), NS_ERROR_NOT_AVAILABLE);
    if (i < 2) {
      bool same = false;
      MOZ_TRY(root->file->Equals(i ? mLocal : mProfile, &same));
      NS_ENSURE_TRUE(same && b.exists && b.isDirectory &&
                         b.role.Equals(i ? u"local-profile"_ns : u"profile"_ns),
                     NS_ERROR_NOT_AVAILABLE);
    } else {
      NS_ENSURE_TRUE(
          !b.serverKey.IsEmpty() && (b.role.EqualsLiteral("message-store") ||
                                     b.role.EqualsLiteral("metadata")),
          NS_ERROR_NOT_AVAILABLE);
    }
    root->parent = MakeUnique<SelectedDirectory>();
    MOZ_TRY(root->parent->Open(parent));
    b.parentIdentity = root->parent->Identity();
    bool actualExists = false;
    MOZ_TRY(root->file->Exists(&actualExists));
    NS_ENSURE_TRUE(actualExists == b.exists, NS_ERROR_NOT_AVAILABLE);
    if (b.exists) {
      root->leaf = MakeUnique<SelectedDirectory>();
      MOZ_TRY(root->leaf->Open(root->file, b.isDirectory));
      b.physicalIdentity = root->leaf->Identity();
    }
    for (const auto& earlier : mState->roots) {
      const auto& e = earlier->binding;
      if (e.canonicalPath.Equals(b.canonicalPath) ||
          (b.exists && e.exists &&
           e.physicalIdentity.Equals(b.physicalIdentity))) {
        NS_ENSURE_TRUE(e.originalPath.Equals(b.originalPath) &&
                           e.canonicalPath.Equals(b.canonicalPath) &&
                           e.exists == b.exists &&
                           e.isDirectory == b.isDirectory,
                       NS_ERROR_NOT_AVAILABLE);
      }
    }
    MOZ_TRY(SetStringProperty(cx, entry, "nativePhysicalIdentity",
                              b.physicalIdentity));
    MOZ_TRY(
        SetStringProperty(cx, entry, "nativeParentIdentity", b.parentIdentity));
    mState->rootBindings.AppendElement(b);
    mState->roots.AppendElement(std::move(root));
  }
  NS_ENSURE_TRUE(JS_Stringify(cx, &inventory, nullptr, JS::UndefinedHandleValue,
                              WriteInventory, &mState->inventoryJSON),
                 NS_ERROR_FAILURE);
  mState->inventoryCaptured = true;
  MOZ_TRY(ValidateSelectedIdentity());
  MOZ_TRY(EnsureView());
  return mViewProperties->SetPropertyAsAString(u"inventory-json"_ns,
                                               mState->inventoryJSON);
}

RefPtr<MigrationSettlementPromise> MigrationWriterLease::AcquireAndDrain() {
  MOZ_ASSERT(NS_IsMainThread());
  if (mState->drainStarted) return mState->drainResult;
  mState->drainStarted = true;
  RefPtr<MigrationSettlementPromise> result = mDrain.Ensure(__func__);
  mState->drainResult = result;
  {
    StaticMutexAutoLock lock(sWriterMutex);
    mState->phase = MigrationPhase::Draining;
  }
  RecordError(ValidateSelectedIdentity());
  RecordError(CaptureInventory());
  // These domains offer checked never-started exclusion, never a live drain.
  for (auto domain :
       {MigrationWriterDomain::LegacyDatabase, MigrationWriterDomain::Chat,
        MigrationWriterDomain::News, MigrationWriterDomain::Smtp,
        MigrationWriterDomain::Rss, MigrationWriterDomain::Compose,
        MigrationWriterDomain::SendLater}) {
    RecordError(CheckMigrationWriter(
        domain, MigrationWriterCheck::RequireNeverStarted));
  }
  RefPtr<MigrationWriterLease> self = this;
  auto imap = BeginImapMigrationDrain(*this, mGeneration);
  if (imap.isOk()) {
    mImap = imap.unwrap();
    mImap->WhenTerminal()->Then(
        GetMainThreadSerialEventTarget(), __func__,
        [self](bool aTerminal) {
          if (!aTerminal) {
            self->RecordError(NS_ERROR_UNEXPECTED);
            return;
          }
          self->mState->imapSettled = true;
          self->BodyWritersSettled();
        },
        [self](nsresult aError) {
          self->RecordError(aError);
          self->mState->imapSettled = true;
          self->BodyWritersSettled();
        });
  } else {
    RecordError(imap.unwrapErr());
    mState->imapSettled = true;
  }
  RefPtr<OperationTerminal> localDone =
      new OperationTerminal([self](nsresult rv) {
        self->RecordError(rv);
        self->mState->localSettled = true;
        self->BodyWritersSettled();
      });
  nsresult rv = BeginLocalStoreMigrationDrain(*this, localDone, mLocalStore);
  if (NS_FAILED(rv)) {
    RecordError(rv);
    if (!mLocalStore) mState->localSettled = true;
  }
  // The two script participants have fixed module/function bindings. Their
  // real Promise is the terminal; no observer topic can mark them complete.
  auto scriptDrain = [&](bool aCold, bool& aAcquired, bool& aSettled,
                         const nsAString& aURI, const char* aMethod,
                         std::function<void(nsresult)> aDone) {
    if (aCold) {
      aSettled = true;
      return;
    }
    dom::AutoJSAPI jsapi;
    nsresult error =
        jsapi.Init(xpc::PrivilegedJunkScope()) ? NS_OK : NS_ERROR_FAILURE;
    if (NS_SUCCEEDED(error)) {
      JSContext* cx = jsapi.cx();
      JS::RootedObject module(cx);
      JS::RootedValue view(cx), terminal(cx);
      error = EnsureView();
      if (NS_SUCCEEDED(error))
        error = nsContentUtils::WrapNative(cx, mView, &view);
      if (NS_SUCCEEDED(error)) error = Import(cx, aURI, &module);
      if (NS_SUCCEEDED(error)) {
        // From this point a missing terminal means uncertain owned work. Keep
        // the fence/lease pending, including when the export throws.
        aAcquired = true;
        error =
            Call(cx, module, aMethod, JS::HandleValueArray(view), &terminal);
        if (NS_SUCCEEDED(error))
          error = JoinJS(cx, terminal, this, std::move(aDone));
      }
    }
    if (NS_FAILED(error)) {
      RecordError(error);
      if (!aAcquired) aSettled = true;
    }
  };
  auto cold = [](MigrationWriterDomain aDomain) {
    MigrationWriterHistory history = MigrationWriterHistory::Unknown;
    return NS_SUCCEEDED(GetMigrationWriterHistory(aDomain, &history)) &&
           history == MigrationWriterHistory::NeverStarted;
  };
  scriptDrain(cold(MigrationWriterDomain::MailSearch) &&
                  cold(MigrationWriterDomain::ChatSearch),
              mState->searchAcquired, mState->searchSettled,
              u"resource:///modules/panorama/SearchMigrationHold.sys.mjs"_ns,
              "drainSearchMigrationWriters", [self](nsresult error) {
                self->RecordError(error);
                nsresult observed = self->CollectSearchErrors(NS_FAILED(error));
                self->RecordError(observed);
                // A rejected pre-capture Promise is not an owned domain
                // terminal. The exact retained GS record proves capture.
                if (NS_FAILED(observed)) return;
                self->mState->searchSettled = true;
                self->BodyWritersSettled();
              });
  scriptDrain(cold(MigrationWriterDomain::Pop3), mState->popAcquired,
              mState->popSettled,
              u"resource:///modules/Pop3IncomingServer.sys.mjs"_ns,
              "drainPop3MigrationWriters", [self](nsresult error) {
                self->RecordError(error);
                self->mState->popSettled = true;
                self->BodyWritersSettled();
              });
  if (NS_FAILED(FirstError())) Cancel(FirstError());
  BodyWritersSettled();
  return result;
}
void MigrationWriterLease::BodyWritersSettled() {
  if (!mState->imapSettled || !mState->localSettled || !mState->searchSettled ||
      !mState->popSettled || mState->closeStarted)
    return;
  mState->closeStarted = true;
  // Body metadata and actual store/provider callbacks have all settled first.
  // This native bridge records each actual owner error, including secondary.
  (void)CloseMigrationAccountState(*this);
  RefPtr<MigrationWriterLease> self = this;
  DatabaseCore::CloseForMigration(*this)->Then(
      GetMainThreadSerialEventTarget(), __func__,
      [self](bool ok) {
        if (!ok) {
          self->RecordError(NS_ERROR_UNEXPECTED);
          return;
        }
        self->mState->databaseSettled = true;
        self->FinishDrain();
      },
      [self](nsresult error) {
        // Native close already records each actual IO/cleanup error.
        if (NS_SUCCEEDED(self->FirstError())) self->RecordError(error);
        self->mState->databaseSettled = true;
        self->FinishDrain();
      });
}
void MigrationWriterLease::FinishDrain() {
  RecordError(ValidateSelectedIdentity());
  nsresult result = FirstError();
  {
    StaticMutexAutoLock lock(sWriterMutex);
    mState->phase = NS_SUCCEEDED(result) ? MigrationPhase::Held
                                         : MigrationPhase::FailedHeld;
  }
  if (NS_FAILED(result))
    mDrain.RejectIfExists(result, __func__);
  else
    mDrain.ResolveIfExists(true, __func__);
}
void MigrationWriterLease::Cancel(nsresult aReason) {
  MOZ_ASSERT(NS_IsMainThread());
  nsresult reason = NS_FAILED(aReason) ? aReason : NS_ERROR_ABORT;
  if (reason != FirstError()) RecordError(reason);
  if (mImap) mImap->Cancel(FirstError());
  if (mLocalStore) mLocalStore->Cancel(FirstError());
  // Abort requests cancellation; only the real IO Promise grants settlement.
  if (mState->abortController) {
    dom::AutoJSAPI jsapi;
    if (jsapi.Init(xpc::PrivilegedJunkScope())) {
      mState->abortController->Abort(jsapi.cx(), JS::UndefinedHandleValue);
    } else {
      RecordError(NS_ERROR_FAILURE);
    }
  }
}

void MigrationWriterLease::KeepJSRejection(JSContext* aCx,
                                           JS::HandleValue aValue) {
  if (NS_SUCCEEDED(FirstError()) && !mState->firstRejection) {
    mState->firstRejection = MakeUnique<JS::PersistentRootedValue>(aCx, aValue);
  } else {
    mState->secondaryRejections.AppendElement(
        MakeUnique<JS::PersistentRootedValue>(aCx, aValue));
  }
}
nsresult MigrationWriterLease::CollectSearchErrors(bool aRejected) {
  // The module's ordered record precedes queue-tail error normalization.
  // Observe it only at real drain/release terminals of this identical view.
  dom::AutoJSAPI jsapi;
  NS_ENSURE_TRUE(jsapi.Init(xpc::PrivilegedJunkScope()), NS_ERROR_FAILURE);
  JSContext* cx = jsapi.cx();
  JS::RootedObject module(cx), errors(cx);
  JS::RootedValue view(cx), returned(cx);
  MOZ_TRY(ValidateSelectedIdentity());
  MOZ_TRY(nsContentUtils::WrapNative(cx, mView, &view));
  MOZ_TRY(Import(cx,
                 u"resource:///modules/panorama/SearchMigrationHold.sys.mjs"_ns,
                 &module));
  MOZ_TRY(Call(cx, module, "getSearchMigrationErrors",
               JS::HandleValueArray(view), &returned));
  NS_ENSURE_TRUE(returned.isObject(), NS_ERROR_UNEXPECTED);
  errors = &returned.toObject();
  bool array = false;
  uint32_t length;
  NS_ENSURE_TRUE(JS::IsArrayObject(cx, errors, &array) && array &&
                     JS::GetArrayLength(cx, errors, &length) &&
                     length >= mState->searchErrorsRead,
                 NS_ERROR_UNEXPECTED);
  while (mState->searchErrorsRead < length) {
    uint32_t i = mState->searchErrorsRead;
    JS::RootedValue error(cx);
    NS_ENSURE_TRUE(JS_GetElement(cx, errors, i, &error), NS_ERROR_FAILURE);
    // JSTerminal already rooted and recorded the original first rejection.
    // Read only newly appended later records, retaining their actual raw
    // values.
    if (!(i == 0 && aRejected)) {
      nsresult result = NS_ERROR_FAILURE;
      if (error.isObject()) {
        JS::RootedObject object(cx, &error.toObject());
        JS::RootedValue code(cx);
        uint32_t value;
        if (JS_GetProperty(cx, object, "result", &code) && code.isNumber() &&
            JS::ToUint32(cx, code, &value) && NS_FAILED(nsresult(value))) {
          result = nsresult(value);
        }
        JS_ClearPendingException(cx);
      }
      KeepJSRejection(cx, error);
      RecordError(result);
    }
    ++mState->searchErrorsRead;
  }
  return NS_OK;
}

RefPtr<MigrationSettlementPromise>
MigrationWriterLease::SettleConsumerAndRelease(nsresult aResult) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mState->releaseStarted) return mState->releaseResult;
  RefPtr<MigrationSettlementPromise> result = mRelease.Ensure(__func__);
  mState->releaseResult = result;
  if (aResult != FirstError()) RecordError(aResult);
  // It is never safe to release a partial/unfinished acquisition.
  if (!mState->databaseSettled) {
    RecordError(NS_ERROR_IN_PROGRESS);
    return result;
  }
  mState->consumerSettled = true;
  mState->releaseStarted = true;
  ++mReleasePasses;
  {
    StaticMutexAutoLock lock(sWriterMutex);
    mState->phase = MigrationPhase::Releasing;
  }
  RefPtr<MigrationWriterLease> self = this;
  if (!mState->searchAcquired) {
    ReleasePop();
    return result;
  }
  dom::AutoJSAPI jsapi;
  nsresult rv =
      jsapi.Init(xpc::PrivilegedJunkScope()) ? NS_OK : NS_ERROR_FAILURE;
  if (NS_SUCCEEDED(rv)) {
    JSContext* cx = jsapi.cx();
    JS::RootedObject module(cx);
    JS::RootedValueArray<2> args(cx);
    JS::RootedValue done(cx);
    rv = nsContentUtils::WrapNative(cx, mView, args[0]);
    args[1].setNumber(uint32_t(FirstError()));
    if (NS_SUCCEEDED(rv))
      rv = Import(
          cx, u"resource:///modules/panorama/SearchMigrationHold.sys.mjs"_ns,
          &module);
    if (NS_SUCCEEDED(rv))
      rv = Call(cx, module, "releaseSearchMigrationWriters", args, &done);
    if (NS_SUCCEEDED(rv))
      rv = JoinJS(cx, done, this, [self](nsresult error) {
        self->RecordError(error);
        nsresult observed = self->CollectSearchErrors(NS_FAILED(error));
        self->RecordError(observed);
        if (NS_FAILED(observed)) {
          // Try the other actual cleanup while keeping uncertain GS custody.
          self->ReleasePop();
          return;
        }
        self->mState->searchAcquired = false;
        self->ReleasePop();
      });
  }
  if (NS_FAILED(rv)) {
    RecordError(rv);
    ReleasePop();
  }
  return result;
}
void MigrationWriterLease::ReleasePop() {
  if (!mState->popAcquired) {
    ReleaseLocal();
    return;
  }
  RefPtr<MigrationWriterLease> self = this;
  dom::AutoJSAPI jsapi;
  nsresult rv =
      jsapi.Init(xpc::PrivilegedJunkScope()) ? NS_OK : NS_ERROR_FAILURE;
  if (NS_SUCCEEDED(rv)) {
    JSContext* cx = jsapi.cx();
    JS::RootedObject module(cx);
    JS::RootedValueArray<2> args(cx);
    JS::RootedValue done(cx);
    rv = nsContentUtils::WrapNative(cx, mView, args[0]);
    args[1].setNumber(uint32_t(FirstError()));
    if (NS_SUCCEEDED(rv))
      rv = Import(cx, u"resource:///modules/Pop3IncomingServer.sys.mjs"_ns,
                  &module);
    if (NS_SUCCEEDED(rv))
      rv = Call(cx, module, "releasePop3MigrationWriters", args, &done);
    if (NS_SUCCEEDED(rv))
      rv = JoinJS(cx, done, this, [self](nsresult error) {
        self->RecordError(error);
        self->mState->popAcquired = false;
        self->ReleaseLocal();
      });
  }
  if (NS_FAILED(rv)) {
    RecordError(rv);
    ReleaseLocal();
  }
}
void MigrationWriterLease::ReleaseLocal() {
  RefPtr<MigrationWriterLease> self = this;
  if (!mLocalStore) {
    ReleaseImap();
    return;
  }
  RefPtr<OperationTerminal> done =
      new OperationTerminal([self](nsresult error) {
        self->RecordError(error);
        // The callback itself is the actual safe cleanup terminal, including a
        // failed cleanup result. An uncertain producer must keep it pending.
        self->mLocalStore = nullptr;
        self->ReleaseImap();
      });
  nsresult rv = mLocalStore->ReleaseAfterConsumerSettlement(FirstError(), done);
  if (NS_FAILED(rv)) {
    RecordError(rv);
    ReleaseImap();
  }
}
void MigrationWriterLease::ReleaseImap() {
  if (!mImap) {
    FinishRelease();
    return;
  }
  RefPtr<MigrationWriterLease> self = this;
  auto disposition = NS_SUCCEEDED(FirstError())
                         ? MigrationReleaseDisposition::ContinueSelectedStartup
                         : MigrationReleaseDisposition::StopSelectedStartup;
  mImap->Release(*this, disposition)
      ->Then(
          GetMainThreadSerialEventTarget(), __func__,
          [self](bool ok) {
            if (!ok) {
              self->RecordError(NS_ERROR_UNEXPECTED);
              return;
            }
            self->mImap = nullptr;
            self->FinishRelease();
          },
          [self](nsresult error) {
            self->RecordError(error);
            self->mImap = nullptr;
            self->FinishRelease();
          });
}
void MigrationWriterLease::FinishRelease() {
  MOZ_ASSERT(NS_IsMainThread());
  // Uncertain ownership must not unblock XPCOM destruction/XRE Unlock. The
  // actual owned promises, not an error/timeout, are the settlement boundary.
  if (mState->searchAcquired || mState->popAcquired || mLocalStore || mImap)
    return;
  // Repeated observers cannot perform or report another safe release.
  if (mReleaseCompletions) return;
  RecordError(ValidateSelectedIdentity());
  nsresult result = FirstError();
  {
    StaticMutexAutoLock lock(sWriterMutex);
    mState->phase = NS_SUCCEEDED(result) ? MigrationPhase::Released
                                         : MigrationPhase::FailedHeld;
    if (NS_SUCCEEDED(result)) {
      if (sActiveLease == this) sActiveLease = nullptr;
    } else {
      sFailedProcess = true;
    }
  }
  ++mReleaseCompletions;
  // This operation-bound diagnostic follows the real reverse-release terminals.
  // A consumer receipt, cancellation request or process exit cannot emit it.
#ifdef XP_WIN
  const uint32_t pid = uint32_t(::GetCurrentProcessId());
#else
  const uint32_t pid = uint32_t(::getpid());
#endif
  std::fprintf(stderr,
               "PANORAMA_SNAPSHOT_SETTLED {\"pid\":%" PRIu32
               ",\"generation\":%" PRIu64 ",\"first_error\":%" PRIu32
               ",\"consumer_settled\":%s,\"release_started\":%s,"
               "\"release_passes\":%" PRIu32 ",\"release_completions\":%" PRIu32
               ",\"phase\":\"%s\"}\n",
               pid, mGeneration, uint32_t(result),
               mState->consumerSettled ? "true" : "false",
               mState->releaseStarted ? "true" : "false", mReleasePasses,
               mReleaseCompletions,
               NS_SUCCEEDED(result) ? "released" : "failed");
  std::fflush(stderr);
  if (NS_FAILED(result))
    mRelease.RejectIfExists(result, __func__);
  else
    mRelease.ResolveIfExists(true, __func__);
}
nsresult MigrationWriterLease::RunConsumer() {
  dom::AutoJSAPI jsapi;
  NS_ENSURE_TRUE(jsapi.Init(xpc::PrivilegedJunkScope()), NS_ERROR_FAILURE);
  JSContext* cx = jsapi.cx();
  JS::RootedObject global(cx, JS::CurrentGlobalOrNull(cx)), module(cx);
  JS::RootedValue signal(cx), view(cx), path(cx), returned(cx);
  mState->abortController = new dom::AbortController(xpc::NativeGlobal(global));
  NS_ENSURE_TRUE(dom::ToJSValue(cx, mState->abortController->Signal(), &signal),
                 NS_ERROR_FAILURE);
  MOZ_TRY(nsContentUtils::WrapNative(cx, mView, &view));
  JS::RootedString text(
      cx, JS_NewUCStringCopyN(cx, mRequest.path.get(), mRequest.path.Length()));
  NS_ENSURE_TRUE(text, NS_ERROR_OUT_OF_MEMORY);
  path.setString(text);
  MOZ_TRY(Import(cx,
                 u"resource:///modules/panorama/MigrationQuiescence.sys.mjs"_ns,
                 &module));
  JS::RootedValueArray<3> args(cx);
  args[0].set(view);
  args[1].set(signal);
  args[2].set(path);
  MOZ_TRY(ValidateSelectedIdentity());
  MOZ_TRY(FirstError());
  {
    StaticMutexAutoLock lock(sWriterMutex);
    mState->phase = MigrationPhase::SnapshotPending;
  }
  mState->consumerInvoked = true;
  MOZ_TRY(Call(cx, module, "runSelectedProfileSnapshot", args, &returned));
  RefPtr<MigrationWriterLease> self = this;
  return JoinJS(cx, returned, this, [self](nsresult error) {
    self->RecordError(error);
    self->mState->consumerSettled = true;
    {
      StaticMutexAutoLock lock(sWriterMutex);
      self->mState->phase = MigrationPhase::Settling;
    }
  });
}
nsresult MigrationWriterLease::RunBeforeAppStartup() {
  MOZ_ASSERT(NS_IsMainThread());
  bool drained = false;
  AcquireAndDrain()->Then(
      GetMainThreadSerialEventTarget(), __func__,
      [&drained](bool) { drained = true; },
      [&drained](nsresult) { drained = true; });
  MOZ_RELEASE_ASSERT(SpinEventLoopUntil("MigrationWriterLease::Acquire"_ns,
                                        [&] { return drained; }),
                     "Cannot abandon retained writer IO at XRE teardown");
  if (NS_SUCCEEDED(FirstError())) {
    nsresult rv = RunConsumer();
    if (NS_FAILED(rv)) {
      RecordError(rv);
      // Calling/importing failed before a real consumer promise was admitted.
      if (!mState->consumerInvoked) mState->consumerSettled = true;
    }
    MOZ_RELEASE_ASSERT(
        SpinEventLoopUntil("MigrationWriterLease::Snapshot"_ns,
                           [&] { return mState->consumerSettled; }),
        "Cannot abandon retained snapshot IO at XRE teardown");
  }
  bool released = false;
  SettleConsumerAndRelease(FirstError())
      ->Then(
          GetMainThreadSerialEventTarget(), __func__,
          [&released](bool) { released = true; },
          [&released](nsresult) { released = true; });
  MOZ_RELEASE_ASSERT(SpinEventLoopUntil("MigrationWriterLease::Release"_ns,
                                        [&] { return released; }),
                     "Cannot abandon retained release IO at XRE teardown");
  // These roots belong to the live JS runtime. All actual JS promises have
  // settled now; retire them before XRE tears down scoped XPCOM/JS.
  mState->abortController = nullptr;
  mState->firstRejection.reset();
  mState->secondaryRejections.Clear();
  return FirstError();
}
}  // namespace mozilla::mailnews
