/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "LocalStoreMigrationLease.h"

#include "js/CallAndConstruct.h"
#include "js/Conversions.h"
#include "js/Array.h"
#include "js/Promise.h"
#include "js/Realm.h"
#include "js/Wrapper.h"
#include "js/Exception.h"
#include "js/PropertyAndElement.h"
#include "js/RootingAPI.h"
#include "mozilla/StaticPtr.h"
#include "mozilla/Try.h"
#include "mozilla/dom/ChromeUtils.h"
#include "mozilla/dom/ChromeUtilsBinding.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/dom/PromiseNativeHandler.h"
#include "mozilla/dom/ScriptSettings.h"
#include "nsContentUtils.h"
#include "nsIFile.h"
#include "nsIMsgFolder.h"
#include "nsIMsgPluggableStore.h"
#include "nsThreadUtils.h"
#include "xpcpublic.h"
#include <functional>

namespace mozilla::mailnews {
namespace {
// All admission, registration, capture and terminals run on the main serial
// target. ArmSelected runs on that same target before capture, so no successful
// check can interleave with a fence before its concrete owner is registered.
nsTArray<RefPtr<LocalStoreMigrationWork>> sLocalWork;
StaticRefPtr<LocalStoreMigrationLease> sLocalLease;
AutoLocalStoreMigrationContinuation* sContinuation = nullptr;

nsresult ValidatePath(MigrationWriterLease& aParent, nsIFile* aPath) {
  NS_ENSURE_TRUE(aPath, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(aParent.ValidateSelectedIdentity());
  nsCOMPtr<nsIFile> path;
  MOZ_TRY(aPath->Clone(getter_AddRefs(path)));
  // Normalize the actual existing ancestor, never create a path to validate it.
  bool exists = false;
  MOZ_TRY(path->Exists(&exists));
  while (!exists) {
    nsCOMPtr<nsIFile> ancestor;
    MOZ_TRY(path->GetParent(getter_AddRefs(ancestor)));
    NS_ENSURE_TRUE(ancestor, NS_ERROR_NOT_AVAILABLE);
    path = ancestor;
    MOZ_TRY(path->Exists(&exists));
  }
  MOZ_TRY(path->Normalize());
  for (;;) {
    nsAutoString value;
    MOZ_TRY(path->GetPath(value));
    for (const auto& root : aParent.RootBindings()) {
      if (root.canonicalPath.Equals(value)) return aParent.ValidateRoot(path);
    }
    nsCOMPtr<nsIFile> ancestor;
    MOZ_TRY(path->GetParent(getter_AddRefs(ancestor)));
    if (!ancestor) return NS_ERROR_NOT_AVAILABLE;
    path = ancestor;
  }
}

nsresult PopResult(JSContext* aCx, JS::HandleValue aValue) {
  if (!aValue.isObject()) return NS_ERROR_FAILURE;
  JS::RootedObject object(aCx, &aValue.toObject());
  JS::RootedValue result(aCx);
  uint32_t code;
  if (JS_GetProperty(aCx, object, "result", &result) && result.isNumber() &&
      JS::ToUint32(aCx, result, &code) && NS_FAILED(nsresult(code))) {
    return nsresult(code);
  }
  JS_ClearPendingException(aCx);
  return NS_ERROR_FAILURE;
}
void RecordPopSecondary(JSContext* aCx, JS::HandleValue aValue,
                        MigrationWriterLease& aParent) {
  if (!aValue.isObject()) return;
  JS::RootedObject object(aCx, &aValue.toObject());
  JS::RootedValue secondary(aCx);
  if (!JS_GetProperty(aCx, object, "secondaryErrors", &secondary)) {
    JS_ClearPendingException(aCx);
    aParent.RecordError(NS_ERROR_FAILURE);
    return;
  }
  if (!secondary.isObject()) return;
  JS::RootedObject errors(aCx, &secondary.toObject());
  bool array = false;
  if (!JS::IsArrayObject(aCx, errors, &array) || !array) {
    JS_ClearPendingException(aCx);
    return;
  }
  uint32_t length = 0;
  if (!JS::GetArrayLength(aCx, errors, &length)) {
    JS_ClearPendingException(aCx);
    aParent.RecordError(NS_ERROR_FAILURE);
    return;
  }
  for (uint32_t i = 0; i < length; ++i) {
    JS::RootedValue error(aCx);
    if (!JS_GetElement(aCx, errors, i, &error)) {
      JS_ClearPendingException(aCx);
      aParent.RecordError(NS_ERROR_FAILURE);
      continue;
    }
    aParent.RecordError(PopResult(aCx, error));
    RecordPopSecondary(aCx, error, aParent);
  }
}
nsresult PendingPopResult(JSContext* aCx, MigrationWriterLease& aParent) {
  JS::RootedValue error(aCx);
  if (!JS_IsExceptionPending(aCx) || !JS_GetPendingException(aCx, &error)) {
    return NS_ERROR_FAILURE;
  }
  aParent.KeepJSRejection(aCx, error);
  JS_ClearPendingException(aCx);
  nsresult result = PopResult(aCx, error);
  aParent.RecordError(result);
  RecordPopSecondary(aCx, error, aParent);
  return result;
}

class PopMigrationTerminal final : public dom::PromiseNativeHandler {
 public:
  NS_DECL_ISUPPORTS
  PopMigrationTerminal(MigrationWriterLease* aParent,
                       std::function<void(nsresult)> aDone)
      : mParent(aParent), mDone(std::move(aDone)) {}
  void ResolvedCallback(JSContext*, JS::Handle<JS::Value>) override {
    Finish(NS_OK);
  }
  void RejectedCallback(JSContext* aCx, JS::Handle<JS::Value> aValue) override {
    nsresult result = PopResult(aCx, aValue);
    mParent->RecordError(result);
    RecordPopSecondary(aCx, aValue, *mParent);
    Finish(result);
  }

 private:
  ~PopMigrationTerminal() = default;
  void Finish(nsresult aResult) {
    if (!mDone) return;
    auto done = std::move(mDone);
    done(aResult);
  }
  RefPtr<MigrationWriterLease> mParent;
  std::function<void(nsresult)> mDone;
};
NS_IMPL_ISUPPORTS(PopMigrationTerminal, nsISupports)
}  // namespace

namespace {
class LocalMigrationScan final : public nsIStoreScanListener {
 public:
  NS_DECL_ISUPPORTS
  LocalMigrationScan(LocalStoreMigrationWork* aWork,
                     nsIStoreScanListener* aListener)
      : mWork(aWork), mListener(aListener) {}
  NS_IMETHOD OnStartScan() override {
    MOZ_TRY(mWork->Validate());
    nsresult result = mListener->OnStartScan();
    mWork->RecordError(result);
    return result;
  }
  NS_IMETHOD OnStartMessage(const nsACString& aToken, const nsACString& aSender,
                            PRTime aDate) override {
    MOZ_TRY(mWork->Validate());
    nsresult result = mListener->OnStartMessage(aToken, aSender, aDate);
    mWork->RecordError(result);
    return result;
  }
  NS_IMETHOD OnStartRequest(nsIRequest* aRequest) override {
    MOZ_TRY(mWork->Validate());
    nsresult result = mListener->OnStartRequest(aRequest);
    mWork->RecordError(result);
    return result;
  }
  NS_IMETHOD OnDataAvailable(nsIRequest* aRequest, nsIInputStream* aInput,
                             uint64_t aOffset, uint32_t aCount) override {
    MOZ_TRY(mWork->Validate());
    nsresult result =
        mListener->OnDataAvailable(aRequest, aInput, aOffset, aCount);
    mWork->RecordError(result);
    return result;
  }
  NS_IMETHOD OnStopRequest(nsIRequest* aRequest, nsresult aResult) override {
    mWork->RecordError(aResult);
    nsresult result = mListener->OnStopRequest(aRequest, aResult);
    mWork->RecordError(result);
    return result;
  }
  NS_IMETHOD OnStopScan(nsresult aResult) override {
    if (mStopped) return NS_OK;
    mStopped = true;
    mWork->RecordError(aResult);
    nsresult result = mListener->OnStopScan(aResult);
    mWork->RecordError(result);
    // Actual input cleanup must report its IO outcome before this callback.
    // Retain the original listener until its metadata/callback work returns.
    mWork->Complete(aResult);
    mListener = nullptr;
    return result;
  }

 private:
  ~LocalMigrationScan() = default;
  RefPtr<LocalStoreMigrationWork> mWork;
  nsCOMPtr<nsIStoreScanListener> mListener;
  bool mStopped = false;
};
NS_IMPL_ISUPPORTS(LocalMigrationScan, nsIStoreScanListener, nsIStreamListener,
                  nsIRequestObserver)
}  // namespace
already_AddRefed<nsIStoreScanListener> WrapLocalStoreMigrationScan(
    LocalStoreMigrationWork* aWork, nsIStoreScanListener* aListener) {
  nsCOMPtr<nsIStoreScanListener> listener =
      new LocalMigrationScan(aWork, aListener);
  return listener.forget();
}

AutoLocalStoreMigrationContinuation::AutoLocalStoreMigrationContinuation(
    LocalStoreMigrationWork* aWork)
    : mWork(aWork), mPrevious(sContinuation) {
  MOZ_ASSERT(NS_IsMainThread());
  sContinuation = this;
}
AutoLocalStoreMigrationContinuation::~AutoLocalStoreMigrationContinuation() {
  MOZ_ASSERT(sContinuation == this);
  sContinuation = mPrevious;
}
nsresult CheckLocalStoreMigrationAdmission() {
  NS_ENSURE_TRUE(NS_IsMainThread(), NS_ERROR_NOT_AVAILABLE);
  if (sContinuation && !sContinuation->mConsumed && sContinuation->mWork) {
    MOZ_TRY(sContinuation->mWork->Validate());
    sContinuation->mConsumed = true;
    return NS_OK;
  }
  return CheckMigrationWriter(MigrationWriterDomain::LocalStore);
}
LocalStoreMigrationWork::LocalStoreMigrationWork(nsISupports* aOwner)
    : mOwner(aOwner) {}
LocalStoreMigrationWork::~LocalStoreMigrationWork() = default;
nsresult LocalStoreMigrationWork::Begin(
    nsISupports* aOwner, nsIFile* aPath,
    RefPtr<LocalStoreMigrationWork>& aResult) {
  NS_ENSURE_TRUE(aOwner, NS_ERROR_INVALID_ARG);
  RefPtr<LocalStoreMigrationWork> parent;
  if (sContinuation && !sContinuation->mConsumed) parent = sContinuation->mWork;
  MOZ_TRY(CheckLocalStoreMigrationAdmission());
  RefPtr<LocalStoreMigrationWork> work = new LocalStoreMigrationWork(aOwner);
  work->mParent = parent;
  if (aPath) MOZ_TRY(work->AddPath(aPath));
  sLocalWork.AppendElement(work);
  if (sLocalLease) {
    // Only an actual pre-fence parent's exact native continuation can enter.
    if (!parent || parent->mLease != sLocalLease) {
      sLocalWork.RemoveElement(work);
      return NS_ERROR_NOT_AVAILABLE;
    }
    nsresult rv = work->Capture(sLocalLease);
    sLocalLease->mCaptured.AppendElement(work);
    if (NS_FAILED(rv)) {
      work->RecordError(rv);
      work->Complete(rv);
      return rv;
    }
  }
  aResult = work;
  return NS_OK;
}
nsresult LocalStoreMigrationWork::Begin(
    nsISupports* aOwner, nsIMsgFolder* aFolder,
    RefPtr<LocalStoreMigrationWork>& aResult) {
  RefPtr<LocalStoreMigrationWork> work;
  MOZ_TRY(Begin(aOwner, static_cast<nsIFile*>(nullptr), work));
  nsresult rv = work->AddFolder(aFolder);
  if (NS_FAILED(rv)) {
    work->Complete(rv);
    return rv;
  }
  aResult = work;
  return NS_OK;
}
nsresult LocalStoreMigrationWork::PreparePop(
    nsISupports* aOwner, RefPtr<LocalStoreMigrationWork>& aResult) {
  MOZ_TRY(Begin(aOwner, static_cast<nsIFile*>(nullptr), aResult));
  aResult->mPreparedPop = true;
  return NS_OK;
}
nsresult LocalStoreMigrationWork::AddPath(nsIFile* aPath) {
  NS_ENSURE_TRUE(!mTerminal && aPath, NS_ERROR_NOT_AVAILABLE);
  if (mLease) MOZ_TRY(ValidatePath(mLease->Parent(), aPath));
  nsCOMPtr<nsIFile> retained;
  MOZ_TRY(aPath->Clone(getter_AddRefs(retained)));
  mPaths.AppendElement(retained);
  return NS_OK;
}
nsresult LocalStoreMigrationWork::AddFolder(nsIMsgFolder* aFolder) {
  NS_ENSURE_TRUE(aFolder, NS_ERROR_INVALID_ARG);
  nsCOMPtr<nsIFile> path;
  MOZ_TRY(aFolder->GetFilePath(getter_AddRefs(path)));
  return AddPath(path);
}
nsresult LocalStoreMigrationWork::Capture(LocalStoreMigrationLease* aLease) {
  NS_ENSURE_TRUE(!mLease && !mTerminal, NS_ERROR_IN_PROGRESS);
  mLease = aLease;
  for (nsresult error : mErrors) aLease->Parent().RecordError(error);
  return mPaths.IsEmpty() ? NS_OK : Validate();
}
nsresult LocalStoreMigrationWork::Validate() const {
  NS_ENSURE_TRUE(!mTerminal, NS_ERROR_NOT_AVAILABLE);
  if (!mLease) return NS_OK;
  MOZ_TRY(mLease->Parent().ValidateGeneration(mLease->Generation()));
  MOZ_TRY(mLease->Parent().ValidateSelectedIdentity());
  NS_ENSURE_TRUE(!mPaths.IsEmpty(), NS_ERROR_NOT_AVAILABLE);
  for (const auto& path : mPaths) MOZ_TRY(ValidatePath(mLease->Parent(), path));
  return NS_OK;
}
void LocalStoreMigrationWork::RecordError(nsresult aResult) {
  if (NS_SUCCEEDED(aResult)) return;
  if (NS_SUCCEEDED(mFirstError)) mFirstError = aResult;
  mErrors.AppendElement(aResult);
  if (mLease) mLease->Parent().RecordError(aResult);
}
void LocalStoreMigrationWork::HoldUncertainIO(nsresult aResult,
                                              nsISupports* aActualOwner) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mTerminal) return;
  RecordError(aResult);
  mUncertainIO = true;
  if (aActualOwner) Retain(aActualOwner);
}
void LocalStoreMigrationWork::Complete(nsresult aResult, bool aSafe) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mTerminal) return;
  RecordError(aResult);
  if (!aSafe || mUncertainIO) return;
  RefPtr<LocalStoreMigrationWork> self = this;
  mTerminal = true;
  sLocalWork.RemoveElement(this);
  if (!mLease) {
    mOwner = nullptr;
    mRelatedOwners.Clear();
    mParent = nullptr;
  }
  if (mLease) mLease->WorkSettled(this);
}
LocalStoreMigrationLease::LocalStoreMigrationLease(
    MigrationWriterLease& aParent, nsIMsgOperationListener* aTerminal)
    : mParent(&aParent),
      mGeneration(aParent.Generation()),
      mTerminal(aTerminal) {}
LocalStoreMigrationLease::~LocalStoreMigrationLease() = default;
nsresult BeginLocalStoreMigrationDrain(
    MigrationWriterLease& aSelected, nsIMsgOperationListener* aTerminal,
    RefPtr<LocalStoreMigrationLease>& aResult) {
  NS_ENSURE_TRUE(NS_IsMainThread() && aTerminal, NS_ERROR_INVALID_ARG);
  MOZ_TRY(aSelected.ValidateGeneration(aSelected.Generation()));
  if (sLocalLease) {
    if (&sLocalLease->Parent() == &aSelected) {
      aResult = sLocalLease;
      return NS_ERROR_IN_PROGRESS;
    }
    return NS_ERROR_NOT_AVAILABLE;
  }
  RefPtr<LocalStoreMigrationLease> lease =
      new LocalStoreMigrationLease(aSelected, aTerminal);
  sLocalLease = lease;
  aResult = lease;
  // Copy the concrete pending owners before invoking any callback/module.
  lease->mCaptured = sLocalWork.Clone();
  for (auto& work : lease->mCaptured) {
    nsresult rv = work->Capture(lease);
    if (NS_FAILED(rv)) {
      work->RecordError(rv);
      if (NS_SUCCEEDED(lease->mError)) lease->mError = rv;
    }
  }
  lease->mCaptureComplete = true;
  nsresult rv = lease->JoinPop();
  if (NS_FAILED(rv)) {
    aSelected.RecordError(rv);
    lease->mError = rv;
    // Missing/non-Promise producer leaves ownership uncertain, not terminal.
    return rv;
  }
  lease->MaybeFinish();
  return NS_OK;
}
nsresult LocalStoreMigrationLease::JoinPop() {
  MigrationWriterHistory history;
  MOZ_TRY(GetMigrationWriterHistory(MigrationWriterDomain::Pop3, &history));
  if (history == MigrationWriterHistory::NeverStarted) {
    MOZ_TRY(CheckMigrationWriter(MigrationWriterDomain::Pop3,
                                 MigrationWriterCheck::RequireNeverStarted));
    mPopTerminal = true;
    return NS_OK;
  }
  dom::AutoJSAPI jsapi;
  NS_ENSURE_TRUE(jsapi.Init(xpc::PrivilegedJunkScope()), NS_ERROR_FAILURE);
  JSContext* cx = jsapi.cx();
  JS::RootedObject module(cx);
  JS::RootedObject global(cx, JS::CurrentGlobalOrNull(cx));
  dom::GlobalObject current(cx, global);
  IgnoredErrorResult error;
  dom::ChromeUtils::ImportESModule(
      current, u"resource:///modules/Pop3IncomingServer.sys.mjs"_ns,
      dom::ImportESModuleOptionsDictionary(), &module, error);
  if (error.Failed()) return error.StealNSResult();
  JS::RootedValue function(cx), view(cx), returned(cx);
  NS_ENSURE_TRUE(
      JS_GetProperty(cx, module, "drainPop3MigrationWriters", &function),
      NS_ERROR_FAILURE);
  nsCOMPtr<nsISupports> selected = mParent->SelectedView();
  NS_ENSURE_TRUE(selected, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(nsContentUtils::WrapNative(cx, selected, &view));
  if (!JS::Call(cx, module, function, JS::HandleValueArray(view), &returned)) {
    return PendingPopResult(cx, *mParent);
  }
  NS_ENSURE_TRUE(returned.isObject(), NS_ERROR_UNEXPECTED);
  JS::RootedObject object(cx, js::CheckedUnwrapStatic(&returned.toObject()));
  NS_ENSURE_TRUE(object && JS::IsPromiseObject(object), NS_ERROR_UNEXPECTED);
  JSAutoRealm realm(cx, object);
  RefPtr<dom::Promise> promise = dom::Promise::CreateFromExisting(
      xpc::NativeGlobal(JS::CurrentGlobalOrNull(cx)), object);
  NS_ENSURE_TRUE(promise, NS_ERROR_FAILURE);
  RefPtr<LocalStoreMigrationLease> self = this;
  promise->AppendNativeHandler(new PopMigrationTerminal(
      mParent, [self](nsresult rv) { self->PopSettled(rv); }));
  return NS_OK;
}
void LocalStoreMigrationLease::PopSettled(nsresult aResult) {
  mParent->RecordError(aResult);
  if (NS_FAILED(aResult) && NS_SUCCEEDED(mError)) mError = aResult;
  // A never-started native sink association is not an IO terminal by itself.
  // The REAL shared POP Promise proves no captured client can begin delivery.
  for (auto& work : mCaptured) {
    if (work->mPreparedPop && !work->mPopActive && !work->IsTerminal()) {
      work->Complete(aResult);
    }
  }
  mPopTerminal = true;
  MaybeFinish();
}
void LocalStoreMigrationLease::WorkSettled(LocalStoreMigrationWork* aWork) {
  if (NS_SUCCEEDED(mError) && NS_FAILED(aWork->FirstError())) {
    mError = aWork->FirstError();
  }
  MaybeFinish();
}
void LocalStoreMigrationLease::MaybeFinish() {
  if (!mCaptureComplete || !mPopTerminal || mNotified) return;
  for (const auto& work : mCaptured)
    if (!work->IsTerminal()) return;
  nsresult rv = mParent->ValidateGeneration(mGeneration);
  if (NS_SUCCEEDED(rv)) rv = mParent->ValidateSelectedIdentity();
  mParent->RecordError(rv);
  if (NS_FAILED(rv) && NS_SUCCEEDED(mError)) mError = rv;
  // Publish on a later main-target turn. No listener can observe half-capture.
  mNotified = true;
  RefPtr<LocalStoreMigrationLease> self = this;
  nsresult dispatch = NS_DispatchToCurrentThread(
      NS_NewRunnableFunction("LocalStoreMigrationTerminal", [self] {
        nsCOMPtr<nsIMsgOperationListener> done = self->mTerminal.forget();
        if (done) (void)done->OnStopOperation(self->mError);
      }));
  if (NS_FAILED(dispatch)) {
    mNotified = false;
    mParent->RecordError(dispatch);
  }
}
void LocalStoreMigrationLease::Cancel(nsresult aReason) {
  nsresult error = NS_FAILED(aReason) ? aReason : NS_ERROR_ABORT;
  if (NS_FAILED(mParent->ValidateGeneration(mGeneration))) return;
  mParent->RecordError(error);
  if (NS_SUCCEEDED(mError)) mError = error;
  // Original stream/copy/sink/compactor callbacks own their cleanup. Never
  // Finish/discard again, close an unknown stream, or synthesize a terminal.
  MaybeFinish();
}
nsresult LocalStoreMigrationLease::ValidateHeld(uint64_t aGeneration) const {
  MOZ_TRY(mParent->ValidateGeneration(aGeneration));
  NS_ENSURE_TRUE(aGeneration == mGeneration && mNotified,
                 NS_ERROR_NOT_AVAILABLE);
  return mParent->ValidateSelectedIdentity();
}
nsresult LocalStoreMigrationLease::ReleaseAfterConsumerSettlement(
    nsresult aPrimary, nsIMsgOperationListener* aReleased) {
  NS_ENSURE_TRUE(NS_IsMainThread() && aReleased, NS_ERROR_INVALID_ARG);
  MOZ_TRY(ValidateHeld(mGeneration));
  NS_ENSURE_TRUE(!mReleaseStarted && sLocalLease == this, NS_ERROR_IN_PROGRESS);
  RefPtr<LocalStoreMigrationLease> self = this;
  mReleaseStarted = true;
  mParent->RecordError(aPrimary);
  for (auto& work : mCaptured) {
    work->mLease = nullptr;
    work->mOwner = nullptr;
    work->mRelatedOwners.Clear();
    work->mParent = nullptr;
  }
  mCaptured.Clear();
  sLocalLease = nullptr;
  // Core alone removes the process fence after all participants and consumer.
  return aReleased->OnStopOperation(NS_SUCCEEDED(mError) ? aPrimary : mError);
}
}  // namespace mozilla::mailnews
