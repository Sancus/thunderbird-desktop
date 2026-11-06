/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "ImapMigrationWriterLease.h"
#include "MigrationWriterLease.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/StaticPtr.h"
#include "nsIFile.h"
#include "nsIImapProtocol.h"
#include "nsIImapUrl.h"
#include "nsIMsgFolder.h"
#include "nsIMsgIncomingServer.h"
#include "nsIMsgMailNewsUrl.h"
#include "nsIStreamListener.h"
#include "nsIThread.h"
#include "nsIThreadShutdown.h"
#include "nsImapIncomingServer.h"
#include "nsImapProtocol.h"
#include "nsThreadUtils.h"

namespace mozilla::mailnews {
namespace {
// All inventory/fence changes run on main. Worker threads can only record
// their own errors or request a main-thread completion. No callback or IO is
// performed under a state/stream/protocol lock.
StaticAutoPtr<nsTArray<RefPtr<ImapMigrationWork>>> sWork;
StaticAutoPtr<nsTArray<nsImapIncomingServer*>> sServers;
StaticRefPtr<ImapMigrationWriterLease> sDrain;
}  // namespace

bool ImapMigrationDrainActive() {
  MOZ_ASSERT(NS_IsMainThread());
  return sDrain != nullptr;
}

nsresult CheckImapMigrationAdmission() {
  MOZ_ASSERT(NS_IsMainThread());
  // Always call the authoritative ABI, also on denied attempts, so Core can
  // invalidate its exact active snapshot. The IM fence is not an authority.
  nsresult rv = CheckMigrationWriter(MigrationWriterDomain::Imap);
  if (NS_FAILED(rv)) {
    if (sDrain) sDrain->RecordError(rv, true);
    return rv;
  }
  if (sDrain) {
    sDrain->RecordError(NS_ERROR_NOT_AVAILABLE);
    return NS_ERROR_NOT_AVAILABLE;
  }
  return NS_OK;
}

void TrackImapMigrationServer(nsImapIncomingServer* aServer) {
  MOZ_ASSERT(NS_IsMainThread());
  if (!sServers) sServers = new nsTArray<nsImapIncomingServer*>;
  MOZ_RELEASE_ASSERT(!sServers->Contains(aServer));
  sServers->AppendElement(aServer);
}

void UntrackImapMigrationServer(nsImapIncomingServer* aServer) {
  MOZ_ASSERT(NS_IsMainThread());
  if (sServers) sServers->RemoveElement(aServer);
}

ImapMigrationWork::ImapMigrationWork(ImapMigrationWorkKind aKind,
                                     nsISupports* aOwner)
    : mKind(aKind), mOwner(aOwner) {
  mPromise = mTerminalPromise.Ensure(__func__);
}
ImapMigrationWork::~ImapMigrationWork() {
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_ASSERT(mTerminal);
}

Result<RefPtr<ImapMigrationWork>, nsresult> ImapMigrationWork::Retain(
    ImapMigrationWorkKind aKind, nsISupports* aOwner,
    nsIMsgIncomingServer* aServer, ImapMigrationWork* aCapturedParent) {
  MOZ_ASSERT(NS_IsMainThread());
  if (!aOwner) return Err(NS_ERROR_INVALID_ARG);
  if (sDrain && (!aCapturedParent || aCapturedParent->mDrain != sDrain ||
                 aCapturedParent->mTerminal)) {
    return Err(NS_ERROR_NOT_AVAILABLE);
  }
  RefPtr<ImapMigrationWork> work = new ImapMigrationWork(aKind, aOwner);
  if (!sWork) sWork = new nsTArray<RefPtr<ImapMigrationWork>>;
  // Install the ticket before even reading a root: a reentrant capture while
  // GetLocalPath is executing sees an incomplete root and refuses, not Held.
  sWork->AppendElement(work);
  // Retain a captured child before any root/server lookup can reenter a URL
  // completion. The parent ticket cannot settle ahead of its own body child.
  if (sDrain) sDrain->Capture(work);
  work->mServer = aServer;
  nsresult rv = NS_OK;
  if (!work->mServer) {
    nsCOMPtr<nsIMsgMailNewsUrl> url = do_QueryInterface(aOwner);
    nsCOMPtr<nsIMsgFolder> folder = do_QueryInterface(aOwner);
    if (url)
      rv = url->GetServer(getter_AddRefs(work->mServer));
    else if (folder)
      rv = folder->GetServer(getter_AddRefs(work->mServer));
    else
      rv = NS_ERROR_INVALID_ARG;
  }
  if (NS_SUCCEEDED(rv) && !work->mServer) rv = NS_ERROR_NOT_AVAILABLE;
  if (NS_SUCCEEDED(rv)) rv = work->mServer->GetKey(work->mServerKey);
  if (NS_SUCCEEDED(rv))
    rv = work->mServer->GetLocalPath(getter_AddRefs(work->mRoot));
  if (NS_SUCCEEDED(rv) && work->mRoot) rv = work->mRoot->Normalize();
  if (NS_SUCCEEDED(rv) && !work->mRoot) rv = NS_ERROR_NOT_AVAILABLE;
  if (NS_SUCCEEDED(rv) && sDrain)
    rv = sDrain->ValidateRoot(work->mRoot, work->mServerKey);
  if (NS_FAILED(rv)) {
    work->Complete(rv);
    return Err(rv);
  }
  return work;
}

Result<RefPtr<ImapMigrationWork>, nsresult> ImapMigrationWork::Admit(
    ImapMigrationWorkKind aKind, nsISupports* aOwner,
    nsIMsgIncomingServer* aServer) {
  MOZ_TRY(CheckImapMigrationAdmission());
  return Retain(aKind, aOwner, aServer, nullptr);
}

already_AddRefed<ImapMigrationWork> ImapMigrationWork::FindUrl(
    nsIImapUrl* aUrl) {
  MOZ_ASSERT(NS_IsMainThread());
  nsCOMPtr<nsISupports> identity = do_QueryInterface(aUrl);
  if (sWork && identity) {
    for (const auto& work : *sWork) {
      if (work->mKind == ImapMigrationWorkKind::Url &&
          work->mOwner == identity && !work->mTerminal) {
        return do_AddRef(work);
      }
    }
  }
  return nullptr;
}

Result<RefPtr<ImapMigrationWork>, nsresult> ImapMigrationWork::AdmitUrl(
    nsIImapUrl* aUrl) {
  MOZ_TRY(CheckImapMigrationAdmission());
  RefPtr<ImapMigrationWork> existing = FindUrl(aUrl);
  if (existing) return existing;
  nsCOMPtr<nsIMsgMailNewsUrl> url = do_QueryInterface(aUrl);
  if (!url) return Err(NS_ERROR_INVALID_ARG);
  nsCOMPtr<nsISupports> identity = do_QueryInterface(aUrl);
  return Retain(ImapMigrationWorkKind::Url, identity, nullptr, nullptr);
}

Result<RefPtr<ImapMigrationWork>, nsresult> ImapMigrationWork::AdmitBody(
    nsIMsgFolder* aFolder, nsIImapUrl* aUrl) {
  MOZ_ASSERT(NS_IsMainThread());
  RefPtr<ImapMigrationWork> parent = FindUrl(aUrl);
  if (!sDrain || !parent || parent->mDrain != sDrain) {
    MOZ_TRY(CheckImapMigrationAdmission());
  }
  return Retain(ImapMigrationWorkKind::Body, aFolder, nullptr, parent);
}

void ImapMigrationWork::CompleteUrl(nsIImapUrl* aUrl, nsresult aStatus,
                                    nsresult aCallbackResult) {
  RefPtr<ImapMigrationWork> work = FindUrl(aUrl);
  if (!work) return;
  work->RecordError(aStatus);
  work->Complete(aCallbackResult);
}

void ImapMigrationWork::RecordError(nsresult aError) {
  if (NS_SUCCEEDED(aError)) return;
  MutexAutoLock lock(mMutex);
  // Only the original parent retained at Capture is touched. Core's error
  // latch is bounded native state; no service, IO or callback runs here.
  if (mCapturedParent) mCapturedParent->RecordError(aError);
  if (NS_SUCCEEDED(mSettlement.firstError)) {
    mSettlement.firstError = aError;
  } else {
    mSettlement.cleanupErrors.AppendElement(aError);
  }
}

RefPtr<ImapMigrationWork::TerminalPromise> ImapMigrationWork::WhenTerminal() {
  MOZ_ASSERT(NS_IsMainThread());
  return mPromise;
}

void ImapMigrationWork::Complete(nsresult aResult) {
  RecordError(aResult);
  if (NS_IsMainThread()) {
    CompleteOnMainThread();
    return;
  }
  RefPtr<ImapMigrationWork> self = this;
  nsresult rv = NS_DispatchToMainThread(NS_NewRunnableFunction(
      "ImapMigrationWork::Complete", [self] { self->CompleteOnMainThread(); }));
  // Dispatch failure is not a terminal receipt. The inventory retains the
  // exact owner and error, and acquisition cannot supply Held.
  RecordError(rv);
}

void ImapMigrationWork::CompleteOnMainThread() {
  MOZ_ASSERT(NS_IsMainThread());
  if (mTerminal) return;
  if (mDrain) RecordError(mDrain->ValidateRoot(mRoot, mServerKey));
  mTerminal = true;
  ImapMigrationSettlement result;
  {
    MutexAutoLock lock(mMutex);
    result = mSettlement;
  }
  RefPtr<ImapMigrationWork> self = this;
  sWork->RemoveElement(this);
  mOwner = nullptr;
  mServer = nullptr;
  mRoot = nullptr;
  mServerKey.Truncate();
  mRequest = nullptr;
  mTerminalPromise.Resolve(result, __func__);
  if (mDrain) {
    RefPtr<ImapMigrationWriterLease> drain = mDrain.forget();
    drain->WorkCompleted(this);
  }
}

void ImapMigrationWork::SetRequest(nsIRequest* aRequest) {
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_ASSERT(!mRequest && !mTerminal);
  mRequest = aRequest;
}

void ImapMigrationWork::CancelRequest(nsresult aReason) {
  MOZ_ASSERT(NS_IsMainThread());
  RecordError(aReason);
  if (mRequest) RecordError(mRequest->Cancel(aReason));
}

void ImapMigrationWork::ThreadLoopExited(nsIThread* aThread) {
  RefPtr<ImapMigrationWork> self = this;
  nsCOMPtr<nsIThread> thread = aThread;
  nsresult rv = NS_DispatchToMainThread(NS_NewRunnableFunction(
      "ImapMigrationWork::BeginThreadShutdown", [self, thread] {
        nsCOMPtr<nsIThreadShutdown> shutdown;
        nsresult rv = thread->BeginShutdown(getter_AddRefs(shutdown));
        self->RecordError(rv);
        if (NS_FAILED(rv) || !shutdown) {
          self->RecordError(NS_ERROR_NOT_AVAILABLE);
          return;
        }
        nsCOMPtr<nsIRunnable> completed = NS_NewRunnableFunction(
            "ImapMigrationWork::ThreadShutdownComplete", [self, shutdown] {
              if (!shutdown->Completed()) {
                self->RecordError(NS_ERROR_NOT_AVAILABLE);
                return;
              }
              self->Complete(NS_OK);
            });
        rv = shutdown->OnCompletion(completed);
        self->RecordError(rv);
      }));
  RecordError(rv);
}

class ImapMigrationStream final : public nsIStreamListener {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  ImapMigrationStream(nsIStreamListener* aListener, ImapMigrationWork* aWork)
      : mListener(aListener), mWork(aWork) {}
  NS_IMETHOD OnStartRequest(nsIRequest* aRequest) override {
    nsresult rv = mListener->OnStartRequest(aRequest);
    mWork->RecordError(rv);
    return rv;
  }
  NS_IMETHOD OnDataAvailable(nsIRequest* aRequest, nsIInputStream* aStream,
                             uint64_t aOffset, uint32_t aCount) override {
    nsresult rv =
        mListener->OnDataAvailable(aRequest, aStream, aOffset, aCount);
    mWork->RecordError(rv);
    return rv;
  }
  NS_IMETHOD OnStopRequest(nsIRequest* aRequest, nsresult aStatus) override {
    MOZ_ASSERT(NS_IsMainThread());
    NS_ENSURE_TRUE(mListener, NS_ERROR_UNEXPECTED);
    nsCOMPtr<nsIStreamListener> listener = mListener.forget();
    mWork->RecordError(aStatus);
    nsresult rv = listener->OnStopRequest(aRequest, aStatus);
    // The wrapped cache/offline listener has now closed its channel, notified
    // the URL and performed any damaged-body cleanup, including errors.
    mWork->Complete(rv);
    return rv;
  }

 private:
  ~ImapMigrationStream() = default;
  nsCOMPtr<nsIStreamListener> mListener;
  RefPtr<ImapMigrationWork> mWork;
};
NS_IMPL_ISUPPORTS(ImapMigrationStream, nsIStreamListener, nsIRequestObserver)

already_AddRefed<nsIStreamListener> TrackImapMigrationStream(
    nsIStreamListener* aListener, ImapMigrationWork* aWork) {
  MOZ_ASSERT(aListener && aWork);
  RefPtr<nsIStreamListener> listener =
      new ImapMigrationStream(aListener, aWork);
  return listener.forget();
}

void ImapMigrationWriterLease::RecordError(nsresult aResult,
                                           bool aParentRecorded) {
  MOZ_ASSERT(NS_IsMainThread());
  if (NS_SUCCEEDED(aResult)) return;
  if (!aParentRecorded) mParent->RecordError(aResult);
  if (NS_SUCCEEDED(mSettlement.firstError))
    mSettlement.firstError = aResult;
  else
    mSettlement.cleanupErrors.AppendElement(aResult);
}

RefPtr<ImapMigrationPromise> ImapMigrationWriterLease::WhenTerminal() {
  MOZ_ASSERT(NS_IsMainThread());
  return mPromise;
}

void ImapMigrationWriterLease::Capture(ImapMigrationWork* aWork) {
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_RELEASE_ASSERT(!mTerminal && !aWork->mTerminal);
  if (mCaptured.Contains(aWork)) return;
  MOZ_RELEASE_ASSERT(!aWork->mDrain || aWork->mDrain == this);
  {
    MutexAutoLock lock(aWork->mMutex);
    mParent->RecordError(aWork->mSettlement.firstError);
    for (nsresult error : aWork->mSettlement.cleanupErrors)
      mParent->RecordError(error);
    aWork->mCapturedParent = mParent;
  }
  aWork->mDrain = this;
  aWork->mDrainRequested = true;
  mCaptured.AppendElement(aWork);
}

void ImapMigrationWriterLease::WorkCompleted(ImapMigrationWork* aWork) {
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_RELEASE_ASSERT(aWork->mTerminal && mCaptured.Contains(aWork));
  {
    MutexAutoLock lock(aWork->mMutex);
    RecordError(aWork->mSettlement.firstError, true);
    mSettlement.cleanupErrors.AppendElements(aWork->mSettlement.cleanupErrors);
  }
  mCaptured.RemoveElement(aWork);
  MaybeTerminal();
}

void ImapMigrationWriterLease::MaybeTerminal() {
  MOZ_ASSERT(NS_IsMainThread());
  if (mCapturing || mTerminal || !mCaptured.IsEmpty()) return;
  mTerminal = true;
  RecordError(ValidateParent(*mParent));
  if (NS_FAILED(mSettlement.firstError))
    mTerminalPromise.Reject(mSettlement.firstError, __func__);
  else
    mTerminalPromise.Resolve(true, __func__);
}

void ImapMigrationWriterLease::Cancel(nsresult aReason) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mReleaseStarted || NS_FAILED(mParent->ValidateGeneration(mGeneration)))
    return;
  if (NS_SUCCEEDED(aReason)) aReason = NS_ERROR_ABORT;
  RecordError(aReason);
  auto captured = mCaptured.Clone();
  for (const auto& work : captured) {
    if (work->mKind == ImapMigrationWorkKind::Protocol) {
      nsCOMPtr<nsIImapProtocol> protocol = do_QueryInterface(work->mOwner);
      if (!protocol) {
        work->RecordError(NS_ERROR_NOT_AVAILABLE);
        continue;
      }
      static_cast<nsImapProtocol*>(protocol.get())
          ->CancelMigrationWork(aReason);
    } else {
      work->CancelRequest(aReason);
    }
  }
  // No ticket is completed by Cancel: only its real callback supplies a
  // receipt, and the original participant/root lease is still retained.
}

ImapMigrationWriterLease::ImapMigrationWriterLease(
    const MigrationWriterLease& aParent, uint64_t aGeneration)
    : mParent(const_cast<MigrationWriterLease*>(&aParent)),
      mGeneration(aGeneration) {
  // Core's fixed entry passes a const authority view, while its actual native
  // object uses non-const intrusive AddRef/Release. Retain that same object;
  // authority checks and error recording below remain its declared const API.
  mPromise = mTerminalPromise.Ensure(__func__);
}

ImapMigrationWriterLease::~ImapMigrationWriterLease() {
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_ASSERT(mTerminal && mCaptured.IsEmpty());
}

already_AddRefed<ImapMigrationWriterLease> ImapMigrationWriterLease::Current() {
  MOZ_ASSERT(NS_IsMainThread());
  return do_AddRef(sDrain);
}

nsresult ImapMigrationWriterLease::ValidateParent(
    const MigrationWriterLease& aParent) const {
  NS_ENSURE_TRUE(NS_IsMainThread() && mParent == &aParent,
                 NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(aParent.ValidateGeneration(mGeneration));
  return aParent.ValidateSelectedIdentity();
}

nsresult ImapMigrationWriterLease::ValidateRoot(
    nsIFile* aRoot, const nsACString& aServerKey) const {
  MOZ_TRY(ValidateParent(*mParent));
  NS_ENSURE_TRUE(aRoot && !aServerKey.IsEmpty(), NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(mParent->ValidateRoot(aRoot));
  nsAutoString path;
  MOZ_TRY(aRoot->GetPath(path));
  for (const auto& binding : mParent->RootBindings()) {
    if (binding.role.EqualsLiteral("message-store") &&
        binding.serverKey.Equals(NS_ConvertUTF8toUTF16(aServerKey)) &&
        binding.canonicalPath.Equals(path) && binding.exists &&
        binding.isDirectory)
      return NS_OK;
  }
  return NS_ERROR_NOT_AVAILABLE;
}

Result<RefPtr<ImapMigrationWriterLease>, nsresult> BeginImapMigrationDrain(
    const MigrationWriterLease& aParent, uint64_t aGeneration) {
  NS_ENSURE_TRUE(NS_IsMainThread(), Err(NS_ERROR_NOT_AVAILABLE));
  MOZ_TRY(aParent.ValidateGeneration(aGeneration));
  NS_ENSURE_TRUE(aParent.Phase() == MigrationPhase::Draining,
                 Err(NS_ERROR_NOT_AVAILABLE));
  if (sDrain) return Err(NS_ERROR_IN_PROGRESS);
  // ArmSelected and all registration/capture execute on this exact serialized
  // target. No check/register interval yields to a callback before the work
  // ticket is installed. Fence before copying the live owned inventory.
  RefPtr<ImapMigrationWriterLease> drain =
      new ImapMigrationWriterLease(aParent, aGeneration);
  sDrain = drain;
  drain->RecordError(aParent.ValidateSelectedIdentity());
  drain->RecordError(aParent.ValidateRoot(aParent.ProfileDirectory()));
  nsTArray<RefPtr<ImapMigrationWork>> work;
  if (sWork) work = sWork->Clone();
  for (const auto& item : work) {
    drain->Capture(item);
    drain->RecordError(drain->ValidateRoot(item->mRoot, item->mServerKey));
  }
  nsTArray<RefPtr<nsImapIncomingServer>> servers;
  if (sServers) {
    for (auto* server : *sServers) servers.AppendElement(server);
  }
  // Queue cancellation may run URL/listener callbacks. All owned work and the
  // fence are already installed; no server/protocol/state lock is held.
  for (const auto& server : servers)
    drain->RecordError(server->CancelMigrationQueuedUrls());
  for (const auto& item : work) {
    if (item->mKind != ImapMigrationWorkKind::Protocol || item->mTerminal)
      continue;
    nsCOMPtr<nsIImapProtocol> protocol = do_QueryInterface(item->mOwner);
    if (!protocol) {
      drain->RecordError(NS_ERROR_NOT_AVAILABLE);
      continue;  // unknown ownership remains pending, never a forged receipt
    }
    static_cast<nsImapProtocol*>(protocol.get())->RequestMigrationDrain();
  }
  drain->mCapturing = false;
  drain->MaybeTerminal();
  return drain;
}

RefPtr<ImapMigrationPromise> ImapMigrationWriterLease::Release(
    const MigrationWriterLease& aParent,
    MigrationReleaseDisposition aDisposition) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mParent != &aParent || aParent.Generation() != mGeneration ||
      (aDisposition != MigrationReleaseDisposition::ContinueSelectedStartup &&
       aDisposition != MigrationReleaseDisposition::StopSelectedStartup)) {
    return ImapMigrationPromise::CreateAndReject(NS_ERROR_NOT_AVAILABLE,
                                                 __func__);
  }
  if (mReleaseStarted) {
    return mDisposition == aDisposition ? mReleasePromise
                                        : ImapMigrationPromise::CreateAndReject(
                                              NS_ERROR_NOT_AVAILABLE, __func__);
  }
  if (NS_FAILED(aParent.ValidateGeneration(mGeneration)) ||
      aParent.Phase() != MigrationPhase::Releasing || sDrain != this) {
    return ImapMigrationPromise::CreateAndReject(NS_ERROR_NOT_AVAILABLE,
                                                 __func__);
  }
  mReleaseStarted = true;
  mDisposition = aDisposition;
  RefPtr<ImapMigrationWriterLease> self = this;
  mReleasePromise = WhenTerminal()->Then(
      GetMainThreadSerialEventTarget(), __func__,
      [self](bool) { return self->FinishRelease(); },
      [self](nsresult) { return self->FinishRelease(); });
  return mReleasePromise;
}

RefPtr<ImapMigrationPromise> ImapMigrationWriterLease::FinishRelease() {
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_RELEASE_ASSERT(mTerminal && mCaptured.IsEmpty());
  RecordError(ValidateParent(*mParent));
  if (sDrain != this)
    return ImapMigrationPromise::CreateAndReject(NS_ERROR_NOT_AVAILABLE,
                                                 __func__);
  // This only releases the IM participant. Core's own Releasing/FailedHeld
  // fence still denies admission until its entire native settlement is done.
  sDrain = nullptr;
  return NS_FAILED(mSettlement.firstError)
             ? ImapMigrationPromise::CreateAndReject(mSettlement.firstError,
                                                     __func__)
             : ImapMigrationPromise::CreateAndResolve(true, __func__);
}
}  // namespace mozilla::mailnews
