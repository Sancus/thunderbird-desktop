/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "MailNewsTypes.h"
#include "msgCore.h"
#include "nsIInputStream.h"
#include "nsIInputStreamPump.h"
#include "nsIMsgPluggableStore.h"
#include "nsMsgUtils.h"
#include "nsNetUtil.h"
#include "MboxScanner.h"
#include "mozilla/Logging.h"
#include "mozilla/ProfilerMarkers.h"
#include "mozilla/ScopeExit.h"

#ifdef MOZ_PANORAMA
#  include "mozilla/Mutex.h"
#  include "mozilla/Try.h"

// MboxMsgInputStream::Close deliberately hides the raw input's result. Keep
// that exact raw owner and memoize its one actual close here, so a destructor
// cannot retry uncertain IO or turn its failure into a successful scan.
class MboxMigrationInput final : public nsIInputStream {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  explicit MboxMigrationInput(nsIInputStream* raw) : mRaw(raw) {}
  NS_IMETHOD Close() override {
    mozilla::MutexAutoLock lock(mCloseLock);
    if (!mCloseAttempted) {
      mCloseAttempted = true;
      mCloseResult = mRaw->Close();
    }
    return mCloseResult;
  }
  nsresult CloseResult() {
    mozilla::MutexAutoLock lock(mCloseLock);
    return mCloseAttempted ? mCloseResult : NS_ERROR_IN_PROGRESS;
  }
  NS_IMETHOD Available(uint64_t* result) override {
    return mRaw->Available(result);
  }
  NS_IMETHOD StreamStatus() override { return mRaw->StreamStatus(); }
  NS_IMETHOD Read(char* buffer, uint32_t count, uint32_t* result) override {
    return mRaw->Read(buffer, count, result);
  }
  NS_IMETHOD ReadSegments(nsWriteSegmentFun writer, void* closure,
                          uint32_t count, uint32_t* result) override {
    return mRaw->ReadSegments(writer, closure, count, result);
  }
  NS_IMETHOD IsNonBlocking(bool* result) override {
    return mRaw->IsNonBlocking(result);
  }

 private:
  ~MboxMigrationInput() = default;
  nsCOMPtr<nsIInputStream> mRaw;
  mozilla::Mutex mCloseLock{"MboxMigrationInput::Close"};
  nsresult mCloseResult = NS_OK;
  bool mCloseAttempted = false;
};
NS_IMPL_ISUPPORTS(MboxMigrationInput, nsIInputStream)
#endif

NS_IMPL_ISUPPORTS(MboxScanner, nsIStreamListener)
MboxScanner::~MboxScanner() = default;

nsresult MboxScanner::BeginScan(
    nsIFile* mboxFile, nsIStoreScanListener* scanListener
#ifdef MOZ_PANORAMA
    ,
    mozilla::mailnews::LocalStoreMigrationWork* migration
#endif
) {
  MOZ_ASSERT(scanListener);
  MOZ_ASSERT(!mKungFuDeathGrip);
  MOZ_ASSERT(!mScanListener);
#ifdef MOZ_PANORAMA
  mMigrationWork = migration;
  if (mMigrationWork) {
    MOZ_TRY(mMigrationWork->Validate());
    mMigrationWork->Retain(static_cast<nsIStreamListener*>(this));
  }
#endif
  mScanListener = scanListener;
  nsresult started = [&]() -> nsresult {
    int64_t fileSize;
    nsresult rv = mboxFile->GetFileSize(&fileSize);
    NS_ENSURE_SUCCESS(rv, rv);
    if (!fileSize) {
      // The actual known empty file has no input to close. Keep the original
      // asynchronous listener contract and validate its captured continuation.
      RefPtr<MboxScanner> self = this;
      return NS_DispatchToMainThread(
          NS_NewRunnableFunction("Notify scanListener", [self] {
            nsresult status = NS_OK;
#ifdef MOZ_PANORAMA
            if (self->mMigrationWork) status = self->mMigrationWork->Validate();
#endif
            if (NS_SUCCEEDED(status))
              status = self->mScanListener->OnStartScan();
            self->FinishScan(status);
          }));
    }
    nsCOMPtr<nsIInputStream> raw;
    rv = NS_NewLocalFileInputStream(getter_AddRefs(raw), mboxFile);
    NS_ENSURE_SUCCESS(rv, rv);
#ifdef MOZ_PANORAMA
    if (mMigrationWork) {
      mMigrationInput = new MboxMigrationInput(raw);
      mMigrationWork->Retain(mMigrationInput);
      raw = mMigrationInput;
    }
#endif
    RefPtr<MboxMsgInputStream> stream = new MboxMsgInputStream(raw, 0);
    mMboxStream = stream;
    rv = NS_NewInputStreamPump(getter_AddRefs(mPump), stream.forget());
    NS_ENSURE_SUCCESS(rv, rv);
    rv = mPump->AsyncRead(this);
    NS_ENSURE_SUCCESS(rv, rv);
    mKungFuDeathGrip = this;
    return NS_OK;
  }();
  if (NS_FAILED(started)) {
    // BeginScan promises no callbacks when setup fails. Close the actual input
    // once before returning its original error; the original caller settles
    // its outer work only after all other owned cleanup has returned.
    started = CloseInput(started);
    mScanListener = nullptr;
    mPump = nullptr;
  }
  return started;
}

nsresult MboxScanner::CloseInput(nsresult status) {
#ifdef MOZ_PANORAMA
  if (mMigrationWork) mMigrationWork->RecordError(status);
#endif
  if (mCloseAttempted || !mMboxStream) return status;
  mCloseAttempted = true;
  nsresult closed = mMboxStream->Close();
#ifdef MOZ_PANORAMA
  if (mMigrationInput) closed = mMigrationInput->CloseResult();
  if (mMigrationWork) {
    mMigrationWork->RecordError(closed);
    if (NS_FAILED(closed)) {
      mMigrationWork->HoldUncertainIO(closed, mMigrationInput);
    }
  }
#endif
  if (NS_SUCCEEDED(status) && NS_FAILED(closed)) status = closed;
  if (NS_SUCCEEDED(closed)) mMboxStream = nullptr;
  return status;
}

void MboxScanner::FinishScan(nsresult status) {
  if (mStopped) return;
  mStopped = true;
  RefPtr<MboxScanner> self = this;
#ifdef MOZ_PANORAMA
  if (mMigrationWork) mMigrationWork->RecordError(status);
#endif
  nsresult notified = mScanListener->OnStopScan(status);
#ifdef MOZ_PANORAMA
  if (mMigrationWork) mMigrationWork->RecordError(notified);
#endif
  (void)notified;
  mScanListener = nullptr;
  mPump = nullptr;
  mKungFuDeathGrip = nullptr;
}

NS_IMETHODIMP MboxScanner::OnStartRequest(nsIRequest* req) {
#ifdef MOZ_PANORAMA
  if (mMigrationWork) MOZ_TRY(mMigrationWork->Validate());
#endif
  nsresult rv;
  uint64_t msgOffset = mMboxStream->MsgOffset();
  if (msgOffset == 0) {
    rv = mScanListener->OnStartScan();
    if (NS_FAILED(rv)) return rv;
    if (mMboxStream->IsNullMessage()) {
      // OnStopRequest owns the one input close, including this parse failure.
      return NS_ERROR_FAILURE;
    }
  }
  nsAutoCString token;
  token.AppendInt(msgOffset);
  mMessageStarted = true;
  rv = mScanListener->OnStartMessage(token, mMboxStream->EnvAddr(),
                                     mMboxStream->EnvDate());
  if (NS_FAILED(rv)) return rv;
  return mScanListener->OnStartRequest(req);
}

NS_IMETHODIMP MboxScanner::OnDataAvailable(nsIRequest* req,
                                           nsIInputStream* stream,
                                           uint64_t offset, uint32_t count) {
#ifdef MOZ_PANORAMA
  if (mMigrationWork) MOZ_TRY(mMigrationWork->Validate());
#endif
  if (!mMboxStream) return NS_OK;
  return mScanListener->OnDataAvailable(req, stream, offset, count);
}

NS_IMETHODIMP MboxScanner::OnStopRequest(nsIRequest* req, nsresult status) {
  AUTO_PROFILER_LABEL("MboxScanner::OnStopRequest", MAILNEWS);
  if (mStopped) return NS_OK;
#ifdef MOZ_PANORAMA
  if (mMigrationWork) mMigrationWork->RecordError(status);
#endif
  if (mMessageStarted) {
    mMessageStarted = false;
    nsresult notified = mScanListener->OnStopRequest(req, status);
#ifdef MOZ_PANORAMA
    if (mMigrationWork) mMigrationWork->RecordError(notified);
#endif
    if (NS_SUCCEEDED(status) && NS_FAILED(notified)) status = notified;
  }
#ifdef MOZ_PANORAMA
  if (mMigrationWork) {
    nsresult valid = mMigrationWork->Validate();
    mMigrationWork->RecordError(valid);
    if (NS_SUCCEEDED(status) && NS_FAILED(valid)) status = valid;
  }
#endif
  bool more = false;
  if (mMboxStream && NS_SUCCEEDED(status)) {
    nsresult rv = mMboxStream->Continue(more);
    if (NS_SUCCEEDED(rv) && more) {
      RefPtr<MboxMsgInputStream> stream = mMboxStream;
      rv = NS_NewInputStreamPump(getter_AddRefs(mPump), stream.forget());
      if (NS_SUCCEEDED(rv)) rv = mPump->AsyncRead(this);
    }
    if (NS_FAILED(rv)) {
      more = false;
      status = rv;
    }
  }
  if (!more) {
    // Report the original operation error plus the actual underlying close
    // error before callback/metadata settlement. Unknown input remains held.
    status = CloseInput(status);
    FinishScan(status);
  }
  return NS_OK;
}
