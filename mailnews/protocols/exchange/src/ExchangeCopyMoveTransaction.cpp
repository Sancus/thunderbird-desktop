/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "ExchangeCopyMoveTransaction.h"

#include "UrlListener.h"
#include "nsIMsgTransactionService.h"
#include "nsIMsgFolder.h"

// Both folder callbacks belong to one operation. Keep its headers until the
// copy listener confirms the outcome, including asynchronous deletion failures.
class ExchangeCopyMoveTransaction::OperationListener final
    : public CopyServiceListener,
      public IExchangeFolderOperationListener {
 public:
  NS_DECL_ISUPPORTS_INHERITED

  OperationListener(ExchangeCopyMoveTransaction* transaction, bool undo,
                    bool deleting)
      : mTransaction(transaction), mUndo(undo), mDeleting(deleting) {}

  NS_IMETHOD OnComplete(const nsTArray<RefPtr<nsIMsgDBHdr>>& headers) override {
    if (!mFinished) {
      mHeaders = headers.Clone();
      mHaveHeaders = true;
    }
    return NS_OK;
  }

  NS_IMETHOD OnStopCopy(nsresult status) override {
    if (mFinished) {
      return NS_OK;
    }
    mFinished = true;
    RefPtr<ExchangeCopyMoveTransaction> transaction = std::move(mTransaction);
    if (NS_SUCCEEDED(status) && (mDeleting || mHaveHeaders)) {
      transaction->mCurrentHeaderSet = std::move(mHeaders);
      transaction->mUndone = mUndo;
    }
    transaction->mOperationPending = false;
    return NS_OK;
  }

 private:
  ~OperationListener() override = default;

  RefPtr<ExchangeCopyMoveTransaction> mTransaction;
  nsTArray<RefPtr<nsIMsgDBHdr>> mHeaders;
  const bool mUndo;
  const bool mDeleting;
  bool mHaveHeaders = false;
  bool mFinished = false;
};

NS_IMPL_ISUPPORTS_INHERITED(ExchangeCopyMoveTransaction::OperationListener,
                            CopyServiceListener,
                            IExchangeFolderOperationListener)

RefPtr<ExchangeCopyMoveTransaction> ExchangeCopyMoveTransaction::ForCopy(
    nsCOMPtr<IExchangeFolder> originalSourceFolder,
    nsCOMPtr<IExchangeFolder> originalDestinationFolder,
    nsCOMPtr<nsIMsgWindow> window,
    nsTArray<RefPtr<nsIMsgDBHdr>> originalHeaders,
    nsTArray<RefPtr<nsIMsgDBHdr>> newHeaders) {
  return new ExchangeCopyMoveTransaction(
      std::move(originalSourceFolder), std::move(originalDestinationFolder),
      std::move(window), false, std::move(originalHeaders),
      std::move(newHeaders));
}

RefPtr<ExchangeCopyMoveTransaction> ExchangeCopyMoveTransaction::ForMove(
    nsCOMPtr<IExchangeFolder> originalSourceFolder,
    nsCOMPtr<IExchangeFolder> originalDestinationFolder,
    nsCOMPtr<nsIMsgWindow> window, nsTArray<RefPtr<nsIMsgDBHdr>> newHeaders) {
  // The move case has no need to hold on to a reference for the original
  // headers.
  return new ExchangeCopyMoveTransaction(
      std::move(originalSourceFolder), std::move(originalDestinationFolder),
      std::move(window), true, nsTArray<RefPtr<nsIMsgDBHdr>>(),
      std::move(newHeaders));
}

ExchangeCopyMoveTransaction::ExchangeCopyMoveTransaction(
    nsCOMPtr<IExchangeFolder> originalSourceFolder,
    nsCOMPtr<IExchangeFolder> originalDestinationFolder,
    nsCOMPtr<nsIMsgWindow> window, bool isMove,
    nsTArray<RefPtr<nsIMsgDBHdr>>&& originalHeaders,
    nsTArray<RefPtr<nsIMsgDBHdr>>&& newHeaders)
    : mOriginalSourceFolder(std::move(originalSourceFolder)),
      mOriginalDestinationFolder(std::move(originalDestinationFolder)),
      mWindow(std::move(window)),
      mIsMove(isMove),
      mOriginalHeaderSet(std::move(originalHeaders)),
      mCurrentHeaderSet(std::move(newHeaders)) {}

ExchangeCopyMoveTransaction::~ExchangeCopyMoveTransaction() = default;

NS_IMETHODIMP ExchangeCopyMoveTransaction::UndoTransaction() {
  if (mOperationPending) {
    return NS_ERROR_IN_PROGRESS;
  }
  if (mUndone) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  if (mIsMove) {
    return PerformOperation(mOriginalDestinationFolder, mOriginalSourceFolder,
                            true);
  }

  nsresult rv;
  nsCOMPtr<nsIMsgFolder> msgFolder =
      do_QueryInterface(mOriginalDestinationFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  RefPtr<OperationListener> listener = new OperationListener(this, true, true);
  mOperationPending = true;
  rv = msgFolder->DeleteMessages(mCurrentHeaderSet, mWindow, true, false,
                                 listener, false);
  if (NS_FAILED(rv)) {
    listener->OnStopCopy(rv);
  }
  return rv;
}

NS_IMETHODIMP ExchangeCopyMoveTransaction::RedoTransaction() {
  if (mOperationPending) {
    return NS_ERROR_IN_PROGRESS;
  }
  if (!mUndone) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  return PerformOperation(mOriginalSourceFolder, mOriginalDestinationFolder,
                          false);
}

nsresult ExchangeCopyMoveTransaction::PerformOperation(
    IExchangeFolder* fromFolder, IExchangeFolder* toFolder, bool undo) {
  RefPtr<OperationListener> listener = new OperationListener(this, undo, false);
  const auto& transactionHeaders =
      mIsMove ? mCurrentHeaderSet : mOriginalHeaderSet;
  // We can pass `eUnknown` as the undo operation type because we're passing
  // another argument to disallow undo for this operation.
  mOperationPending = true;
  nsresult rv = toFolder->CopyItemsOnSameServer(
      fromFolder, transactionHeaders, mIsMove, mWindow, listener, false,
      nsIMsgTransactionService::eUnknown, listener);
  if (NS_FAILED(rv)) {
    listener->OnStopCopy(rv);
  }
  return rv;
}
