/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef COMM_MAILNEWS_DB_PANORAMA_SRC_MIGRATIONWRITERLEASE_H_
#define COMM_MAILNEWS_DB_PANORAMA_SRC_MIGRATIONWRITERLEASE_H_

#include "js/TypeDecls.h"
#include "mozilla/MozPromise.h"
#include "mozilla/RefPtr.h"
#include "mozilla/Result.h"
#include "mozilla/UniquePtr.h"
#include "nsCOMPtr.h"
#include "nsIObserver.h"
#include "nsISupportsImpl.h"
#include "nsString.h"
#include "nsTArray.h"
#include <stdint.h>

class nsIFile;
class nsIProfileLock;
class nsIPropertyBag2;
class nsIWritablePropertyBag2;
namespace mozilla::mailnews {
class ImapMigrationWriterLease;
class LocalStoreMigrationLease;
class MigrationWriterLease;
class DeliveryCoreReferences;

enum class MigrationWriterDomain : uint8_t {
  Account = 0,
  NativeDatabase = 1,
  LegacyDatabase = 2,
  Imap = 3,
  LocalStore = 4,
  Pop3 = 5,
  MailSearch = 6,
  ChatSearch = 7,
  Chat = 8,
  News = 9,
  Smtp = 10,
  Rss = 11,
  Compose = 12,
  SendLater = 13
};
enum class MigrationWriterCheck : uint8_t {
  NewAdmission = 0,
  RequireNeverStarted = 1
};
enum class MigrationWriterHistory : uint8_t {
  NeverStarted = 0,
  Started = 1,
  Unknown = 2
};
[[nodiscard]] nsresult CheckMigrationWriter(
    MigrationWriterDomain aDomain,
    MigrationWriterCheck aCheck = MigrationWriterCheck::NewAdmission);
[[nodiscard]] nsresult GetMigrationWriterHistory(
    MigrationWriterDomain aDomain, MigrationWriterHistory* aHistory);

// Fixed native owners resolve only after their real terminal callback/IO.
// Multiple native observers may join; cancellation never destroys this promise.
using MigrationSettlementPromise = MozPromise<bool, nsresult, false>;
enum class MigrationReleaseDisposition : uint8_t {
  ContinueSelectedStartup,
  StopSelectedStartup
};
struct SelectedSnapshotRequest {
  nsString path;
};
enum class MigrationPhase : uint8_t {
  Armed,
  Draining,
  Held,
  SnapshotPending,
  Settling,
  Releasing,
  Released,
  FailedHeld
};

struct MigrationRootBinding {
  nsString originalPath;
  nsString canonicalPath;
  nsString parentPath;
  nsString role;
  nsString serverKey;
  nsCString physicalIdentity;
  nsCString parentIdentity;
  bool exists = false;
  bool isDirectory = false;
};

class MigrationWriterLease final {
 public:
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(MigrationWriterLease)
  static Result<RefPtr<MigrationWriterLease>, nsresult> ArmSelected(
      nsIProfileLock* aLock, nsIFile* aProfile, nsIFile* aLocal,
      const SelectedSnapshotRequest& aRequest);
  uint64_t Generation() const { return mGeneration; }
  nsresult ValidateGeneration(uint64_t aGeneration) const;
  nsresult ValidateSelectedIdentity() const;
  const nsTArray<MigrationRootBinding>& RootBindings() const;
  nsresult ValidateRoot(nsIFile* aFile) const;
  nsIFile* ProfileDirectory() const { return mProfile; }
  nsIFile* LocalDirectory() const { return mLocal; }
  already_AddRefed<nsISupports> SelectedView();
  RefPtr<MigrationSettlementPromise> AcquireAndDrain();
  // Called only at the one actual outer XRE startup boundary.
  nsresult RunBeforeAppStartup();
  void Cancel(nsresult aReason);
  void RecordError(nsresult aResult) const;
  void KeepJSRejection(JSContext*, JS::Handle<JS::Value>);
  nsresult FirstError() const;
  nsTArray<nsresult> SecondaryErrors() const;
  MigrationPhase Phase() const;
  RefPtr<MigrationSettlementPromise> SettleConsumerAndRelease(nsresult aResult);

 private:
  friend class DeliveryCoreReferences;
  MigrationWriterLease(nsIProfileLock*, nsIFile*, nsIFile*,
                       const SelectedSnapshotRequest&, uint64_t);
  ~MigrationWriterLease();
  struct State;
  UniquePtr<State> mState;
  const uint64_t mGeneration;
  nsCOMPtr<nsIProfileLock> mLock;
  nsCOMPtr<nsIFile> mProfile;
  nsCOMPtr<nsIFile> mLocal;
  SelectedSnapshotRequest mRequest;
  nsCOMPtr<nsIPropertyBag2> mView;
  nsCOMPtr<nsIWritablePropertyBag2> mViewProperties;
  RefPtr<ImapMigrationWriterLease> mImap;
  RefPtr<LocalStoreMigrationLease> mLocalStore;
  MozPromiseHolder<MigrationSettlementPromise> mDrain;
  MozPromiseHolder<MigrationSettlementPromise> mRelease;
  // Main-thread counters of actual release work, never caller observations.
  uint32_t mReleasePasses = 0;
  uint32_t mReleaseCompletions = 0;
  nsresult CaptureInventory();
  void BodyWritersSettled();
  void ReleasePop();
  nsresult CollectSearchErrors(bool aRejected);
  void FinishDrain();
  void FinishRelease();
  void ReleaseLocal();
  void ReleaseImap();
  nsresult RunConsumer();
  nsresult EnsureView();
};

nsresult CloseMigrationAccountState(const MigrationWriterLease& aLease);
already_AddRefed<nsIObserver> CreateMigrationWriterGate();
}  // namespace mozilla::mailnews
#endif
