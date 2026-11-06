/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_IMAP_SRC_IMAPMIGRATIONWRITERLEASE_H_
#define COMM_MAILNEWS_IMAP_SRC_IMAPMIGRATIONWRITERLEASE_H_

#include "MigrationWriterLease.h"
#include "mozilla/Atomics.h"
#include "mozilla/MozPromise.h"
#include "mozilla/Mutex.h"
#include "mozilla/RefPtr.h"
#include "mozilla/Result.h"
#include "nsCOMPtr.h"
#include "nsISupports.h"
#include "nsISupportsImpl.h"
#include "nsTArray.h"

class nsIFile;
class nsIImapUrl;
class nsIMsgFolder;
class nsIMsgIncomingServer;
class nsIStreamListener;
class nsIRequest;
class nsIThread;
class nsImapIncomingServer;
class nsImapProtocol;

namespace mozilla::mailnews {
class MigrationWriterLease;
enum class MigrationReleaseDisposition : uint8_t;
class ImapMigrationWriterLease;
class ImapMigrationWriterLeaseTest;

// These are concrete IMAP operation lifetimes, not externally registered
// participants. A ticket remains in the inventory until its actual owner
// completes it; dropping a caller reference never supplies a receipt.
enum class ImapMigrationWorkKind : uint8_t {
  Protocol,
  Url,
  Body,
  Stream,
  Append
};
struct ImapMigrationSettlement {
  nsresult firstError = NS_OK;
  nsTArray<nsresult> cleanupErrors;
  ImapMigrationSettlement() = default;
  ImapMigrationSettlement(const ImapMigrationSettlement& aOther)
      : firstError(aOther.firstError) {
    cleanupErrors.AppendElements(aOther.cleanupErrors);
  }
  ImapMigrationSettlement& operator=(const ImapMigrationSettlement& aOther) {
    if (this != &aOther) {
      firstError = aOther.firstError;
      cleanupErrors.Clear();
      cleanupErrors.AppendElements(aOther.cleanupErrors);
    }
    return *this;
  }
};
using ImapMigrationPromise = MigrationSettlementPromise;

class ImapMigrationWork final {
 public:
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(ImapMigrationWork)
  using TerminalPromise = MozPromise<ImapMigrationSettlement, nsresult, false>;

  static Result<RefPtr<ImapMigrationWork>, nsresult> Admit(
      ImapMigrationWorkKind aKind, nsISupports* aOwner,
      nsIMsgIncomingServer* aServer);
  static Result<RefPtr<ImapMigrationWork>, nsresult> AdmitBody(
      nsIMsgFolder* aFolder, nsIImapUrl* aUrl);
  static Result<RefPtr<ImapMigrationWork>, nsresult> AdmitUrl(nsIImapUrl* aUrl);
  static void CompleteUrl(nsIImapUrl* aUrl, nsresult aStatus,
                          nsresult aCallbackResult);
  static already_AddRefed<ImapMigrationWork> FindUrl(nsIImapUrl* aUrl);

  void RecordError(nsresult aError);
  nsresult RecordResult(nsresult aResult) {
    RecordError(aResult);
    return aResult;
  }
  void Complete(nsresult aResult);
  void ThreadLoopExited(nsIThread* aThread);
  void SetRequest(nsIRequest* aRequest);
  void CancelRequest(nsresult aReason);
  RefPtr<TerminalPromise> WhenTerminal();
  bool DrainRequested() const { return mDrainRequested; }
  ImapMigrationWorkKind Kind() const { return mKind; }

 private:
  friend class ImapMigrationWriterLease;
  friend class ImapMigrationWriterLeaseTest;
  friend Result<RefPtr<ImapMigrationWriterLease>, nsresult>
  BeginImapMigrationDrain(const MigrationWriterLease&, uint64_t);
  ImapMigrationWork(ImapMigrationWorkKind aKind, nsISupports* aOwner);
  ~ImapMigrationWork();
  static Result<RefPtr<ImapMigrationWork>, nsresult> Retain(
      ImapMigrationWorkKind aKind, nsISupports* aOwner,
      nsIMsgIncomingServer* aServer, ImapMigrationWork* aCapturedParent);
  void CompleteOnMainThread();

  const ImapMigrationWorkKind mKind;
  // Owner, server and original physical root are released only on main, after
  // the receipt. They survive cache eviction and protocol m_server clearing.
  nsCOMPtr<nsISupports> mOwner;
  nsCOMPtr<nsIMsgIncomingServer> mServer;
  nsCOMPtr<nsIFile> mRoot;
  nsCString mServerKey;
  nsCOMPtr<nsIRequest> mRequest;
  RefPtr<ImapMigrationWriterLease> mDrain;
  Atomic<bool> mDrainRequested{false};
  Mutex mMutex{"ImapMigrationWork"};
  ImapMigrationSettlement mSettlement MOZ_GUARDED_BY(mMutex);
  RefPtr<MigrationWriterLease> mCapturedParent MOZ_GUARDED_BY(mMutex);
  bool mTerminal = false;  // main-thread only
  MozPromiseHolder<TerminalPromise> mTerminalPromise;
  RefPtr<TerminalPromise> mPromise;
};

// Admission checks always use Core's fixed native ABI, including an unarmed
// process. Existing captured body callbacks use their concrete URL ownership;
// there is no cleanup=true admission escape or script-controlled authority.
[[nodiscard]] nsresult CheckImapMigrationAdmission();
bool ImapMigrationDrainActive();
void TrackImapMigrationServer(nsImapIncomingServer* aServer);
void UntrackImapMigrationServer(nsImapIncomingServer* aServer);
already_AddRefed<nsIStreamListener> TrackImapMigrationStream(
    nsIStreamListener* aListener, ImapMigrationWork* aWork);

class ImapMigrationWriterLease final {
 public:
  NS_INLINE_DECL_REFCOUNTING(ImapMigrationWriterLease)
  RefPtr<ImapMigrationPromise> WhenTerminal();
  void Cancel(nsresult aReason);
  RefPtr<ImapMigrationPromise> Release(
      const MigrationWriterLease& aParent,
      MigrationReleaseDisposition aDisposition);

 private:
  friend class ImapMigrationWork;
  friend class ImapMigrationWriterLeaseTest;
  friend nsresult CheckImapMigrationAdmission();
  friend Result<RefPtr<ImapMigrationWriterLease>, nsresult>
  BeginImapMigrationDrain(const MigrationWriterLease&, uint64_t);
  ImapMigrationWriterLease(const MigrationWriterLease& aParent,
                           uint64_t aGeneration);
  ~ImapMigrationWriterLease();
  nsresult ValidateParent(const MigrationWriterLease& aParent) const;
  nsresult ValidateRoot(nsIFile* aRoot, const nsACString& aServerKey) const;
  void Capture(ImapMigrationWork* aWork);
  void WorkCompleted(ImapMigrationWork* aWork);
  void MaybeTerminal();
  RefPtr<ImapMigrationPromise> FinishRelease();
  void RecordError(nsresult aResult, bool aParentRecorded = false);

  RefPtr<MigrationWriterLease> mParent;
  const uint64_t mGeneration;
  nsTArray<RefPtr<ImapMigrationWork>> mCaptured;
  ImapMigrationSettlement mSettlement;
  bool mCapturing = true;
  bool mTerminal = false;
  bool mReleaseStarted = false;
  MigrationReleaseDisposition mDisposition =
      MigrationReleaseDisposition::StopSelectedStartup;
  static already_AddRefed<ImapMigrationWriterLease> Current();
  MozPromiseHolder<ImapMigrationPromise> mTerminalPromise;
  RefPtr<ImapMigrationPromise> mPromise;
  RefPtr<ImapMigrationPromise> mReleasePromise;
};

Result<RefPtr<ImapMigrationWriterLease>, nsresult> BeginImapMigrationDrain(
    const MigrationWriterLease& aParent, uint64_t aGeneration);
}  // namespace mozilla::mailnews
#endif
