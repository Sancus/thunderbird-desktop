/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef COMM_MAILNEWS_LOCAL_SRC_LOCALSTOREMIGRATIONLEASE_H_
#define COMM_MAILNEWS_LOCAL_SRC_LOCALSTOREMIGRATIONLEASE_H_

#include "MigrationWriterLease.h"
#include "nsCOMPtr.h"
#include "nsIMsgOperationListener.h"
#include "nsTArray.h"

class nsIFile;
class nsIMsgFolder;
class nsIStoreScanListener;
namespace mozilla::mailnews {
class LocalStoreMigrationLease;

// One actual local operation, from admission through its original terminal.
// The owning stream/copy/sink/compactor retains this handle. Destruction is not
// a terminal: an uncertain owner stays retained until its real cleanup settles.
class LocalStoreMigrationWork final {
 public:
  NS_INLINE_DECL_REFCOUNTING(LocalStoreMigrationWork)
  static nsresult Begin(nsISupports* aOwner, nsIFile* aPath,
                        RefPtr<LocalStoreMigrationWork>& aResult);
  static nsresult Begin(nsISupports* aOwner, nsIMsgFolder* aFolder,
                        RefPtr<LocalStoreMigrationWork>& aResult);
  void Retain(nsISupports* aOwner) { mRelatedOwners.AppendElement(aOwner); }
  nsresult AddPath(nsIFile* aPath);
  nsresult AddFolder(nsIMsgFolder* aFolder);
  static nsresult PreparePop(nsISupports* aOwner,
                             RefPtr<LocalStoreMigrationWork>& aResult);
  void StartPopDelivery() {
    mPreparedPop = true;
    mPopActive = true;
  }
  nsresult Validate() const;
  void RecordError(nsresult aResult);
  void HoldUncertainIO(nsresult aResult, nsISupports* aActualOwner);
  // Safe means no remaining IO/callback can act for this operation. A failed
  // Finish/close with uncertain custody records its error without completing.
  void Complete(nsresult aResult, bool aSafe = true);
  nsresult FirstError() const { return mFirstError; }
  bool IsTerminal() const { return mTerminal; }

 private:
  friend class LocalStoreMigrationLease;
  LocalStoreMigrationWork(nsISupports* aOwner);
  ~LocalStoreMigrationWork();
  nsresult Capture(LocalStoreMigrationLease* aLease);
  nsCOMPtr<nsISupports> mOwner;
  nsTArray<nsCOMPtr<nsISupports>> mRelatedOwners;
  nsTArray<nsCOMPtr<nsIFile>> mPaths;
  RefPtr<LocalStoreMigrationLease> mLease;
  RefPtr<LocalStoreMigrationWork> mParent;
  nsTArray<nsresult> mErrors;
  nsresult mFirstError = NS_OK;
  bool mTerminal = false;
  bool mUncertainIO = false;
  bool mPreparedPop = false;
  bool mPopActive = false;
};

// Only wrap the exact native callee of already-owned work. Admission consumes
// the scope once; listener reentry cannot borrow it to create another writer.
class MOZ_RAII AutoLocalStoreMigrationContinuation final {
 public:
  explicit AutoLocalStoreMigrationContinuation(LocalStoreMigrationWork* aWork);
  ~AutoLocalStoreMigrationContinuation();

 private:
  friend nsresult CheckLocalStoreMigrationAdmission();
  friend class LocalStoreMigrationWork;
  RefPtr<LocalStoreMigrationWork> mWork;
  AutoLocalStoreMigrationContinuation* mPrevious;
  bool mConsumed = false;
};
nsresult CheckLocalStoreMigrationAdmission();

already_AddRefed<nsIStoreScanListener> WrapLocalStoreMigrationScan(
    LocalStoreMigrationWork* aWork, nsIStoreScanListener* aListener);

class LocalStoreMigrationLease final {
 public:
  NS_INLINE_DECL_REFCOUNTING(LocalStoreMigrationLease)
  void Cancel(nsresult aReason);
  nsresult ValidateHeld(uint64_t aGeneration) const;
  nsresult ReleaseAfterConsumerSettlement(nsresult aPrimary,
                                          nsIMsgOperationListener* aReleased);
  MigrationWriterLease& Parent() const { return *mParent; }
  uint64_t Generation() const { return mGeneration; }
  // Called by the real terminal hook, including work begun by a captured
  // logical copy/sink continuation while its outer owner is still pending.
  void WorkSettled(LocalStoreMigrationWork* aWork);

 private:
  friend class LocalStoreMigrationWork;
  friend nsresult BeginLocalStoreMigrationDrain(
      MigrationWriterLease&, nsIMsgOperationListener*,
      RefPtr<LocalStoreMigrationLease>&);
  LocalStoreMigrationLease(MigrationWriterLease&, nsIMsgOperationListener*);
  ~LocalStoreMigrationLease();
  void MaybeFinish();
  void PopSettled(nsresult aResult);
  nsresult JoinPop();
  RefPtr<MigrationWriterLease> mParent;
  const uint64_t mGeneration;
  nsCOMPtr<nsIMsgOperationListener> mTerminal;
  nsTArray<RefPtr<LocalStoreMigrationWork>> mCaptured;
  nsresult mError = NS_OK;
  bool mCaptureComplete = false;
  bool mPopTerminal = false;
  bool mNotified = false;
  bool mReleaseStarted = false;
};
nsresult BeginLocalStoreMigrationDrain(
    MigrationWriterLease& aSelected, nsIMsgOperationListener* aTerminal,
    RefPtr<LocalStoreMigrationLease>& aResult);
}  // namespace mozilla::mailnews
#endif
