/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "ImapMigrationWriterLease.h"
#include "MigrationWriterLease.h"
#include "../../../../imap/src/nsImapIncomingServer.h"
#include "../../../../imap/src/nsImapMailFolder.h"
#include "../../../../imap/src/nsImapProtocol.h"
#include "gtest/gtest.h"
#include "mozilla/Atomics.h"
#include "mozilla/Monitor.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/SpinEventLoopUntil.h"
#include "mozilla/TimeStamp.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsComponentManagerUtils.h"
#include "nsDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "nsIFile.h"
#include "nsIImapHostSessionList.h"
#include "nsIImapUrl.h"
#include "nsIInputStream.h"
#include "nsIMsgAccount.h"
#include "nsIMsgAccountManager.h"
#include "nsIMsgFolder.h"
#include "nsIMsgIncomingServer.h"
#include "nsIMsgMailNewsUrl.h"
#include "nsIMsgPluggableStore.h"
#include "nsIOutputStream.h"
#include "nsIPrefService.h"
#include "nsIProfileLock.h"
#include "nsIProfileUnlocker.h"
#include "nsIProperties.h"
#include "nsIDirectoryEnumerator.h"
#include "nsIThread.h"
#include "nsIThreadShutdown.h"
#include "nsITimer.h"
#include "nsIUrlListener.h"
#include "nsNetUtil.h"
#include "nsServiceManagerUtils.h"
#include "nsStreamUtils.h"
#include "nsThreadUtils.h"
#include "nss.h"
#include "prio.h"
#include <cstdlib>
#include <functional>

nsresult NS_LockProfilePath(nsIFile*, nsIFile*, nsIProfileUnlocker**,
                            nsIProfileLock**);

namespace mozilla::mailnews {
namespace {
constexpr auto kBody =
    "From: lease@example.invalid\r\nSubject: real captured writer\r\n"
    "\r\noriginal body before fence\r\n"_ns;

struct MigrationWait final {
  NS_INLINE_DECL_REFCOUNTING(MigrationWait)
  bool done = false;
  bool expired = false;
  nsresult result = NS_ERROR_IN_PROGRESS;

 private:
  ~MigrationWait() = default;
};

struct WorkerTail final {
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(WorkerTail)
  Monitor monitor{"ImapMigrationWriterLeaseTest::WorkerTail"};
  Atomic<bool> entered{false};
  Atomic<bool> proxyRan{false};
  bool release = false;
  Atomic<bool> expired{false};

 private:
  ~WorkerTail() = default;
};

class QueueWitness final : public nsIUrlListener {
 public:
  NS_DECL_ISUPPORTS
  uint32_t stops = 0;
  nsresult status = NS_OK;
  std::function<void()> onStop;
  NS_IMETHOD OnStartRunningUrl(nsIURI*) override { return NS_OK; }
  NS_IMETHOD OnStopRunningUrl(nsIURI*, nsresult aStatus) override {
    ++stops;
    status = aStatus;
    if (onStop) onStop();
    return NS_OK;
  }

 private:
  ~QueueWitness() = default;
};
NS_IMPL_ISUPPORTS(QueueWitness, nsIUrlListener)
}  // namespace

// This peer observes the fixed IM native boundary and drives actual ordinary
// workers, body streams and selected locks. It cannot manufacture a selected
// view, reset native process history or replace a backend service.
class ImapMigrationWriterLeaseTest final {
 public:
  static void Run(uint32_t aCase, bool aMaildir) {
    ImapMigrationWriterLeaseTest test;
    auto cleanup = MakeScopeExit([&] { test.Close(); });
    test.Open(aCase == 12, aMaildir);
    ASSERT_FALSE(::testing::Test::HasFatalFailure());
    test.Check(aCase);
  }

 private:
  nsCOMPtr<nsIFile> mProfile, mMail, mInput, mOldProfile, mOldLocal;
  nsCOMPtr<nsIProperties> mDirectories;
  nsCOMPtr<nsIMsgAccountManager> mAccounts;
  nsCOMPtr<nsIMsgAccount> mAccount;
  nsCOMPtr<nsIMsgIncomingServer> mServer;
  nsCOMPtr<nsIMsgFolder> mFolder;
  nsCOMPtr<nsIMsgPluggableStore> mStore;
  nsCOMPtr<nsIOutputStream> mOutput;
  nsCOMPtr<nsIProfileLock> mLock;
  RefPtr<nsImapProtocol> mProtocol;
  RefPtr<ImapMigrationWork> mBody;
  RefPtr<MigrationWriterLease> mParent;
  RefPtr<MigrationSettlementPromise> mWhole;
  RefPtr<ImapMigrationWriterLease> mImap;
  nsCString mToken;
  bool mMaildir = false;
  bool mCold = false;
  bool mProfileInstalled = false;
  bool mLocalInstalled = false;
  bool mFinishAttempted = false;
  bool mConsumerSettled = false;
  uint32_t mFinishes = 0;
  uint32_t mDiscards = 0;

  static nsresult Read(nsIFile* aFile, nsACString& aBytes) {
    nsCOMPtr<nsIInputStream> input;
    MOZ_TRY(NS_NewLocalFileInputStream(getter_AddRefs(input), aFile));
    nsresult rv = NS_ConsumeStream(input, UINT32_MAX, aBytes);
    nsresult close = input->Close();
    return NS_FAILED(rv) ? rv : close;
  }

  void Open(bool aCold, bool aMaildir) {
    mCold = aCold;
    mMaildir = aMaildir;
    mDirectories = do_GetService(NS_DIRECTORY_SERVICE_CONTRACTID);
    ASSERT_TRUE(mDirectories);
    mDirectories->Get(NS_APP_USER_PROFILE_50_DIR, NS_GET_IID(nsIFile),
                      getter_AddRefs(mOldProfile));
    mDirectories->Get(NS_APP_USER_PROFILE_LOCAL_50_DIR, NS_GET_IID(nsIFile),
                      getter_AddRefs(mOldLocal));
    nsCOMPtr<nsIFile> temporary;
    ASSERT_EQ(NS_OK, NS_GetSpecialDirectory(NS_OS_TEMP_DIR,
                                            getter_AddRefs(temporary)));
    ASSERT_EQ(NS_OK, temporary->Clone(getter_AddRefs(mProfile)));
    ASSERT_EQ(NS_OK, mProfile->Append(u"imap-writer-lease"_ns));
    ASSERT_EQ(NS_OK, mProfile->CreateUnique(nsIFile::DIRECTORY_TYPE, 0700));
    mDirectories->Undefine(NS_APP_USER_PROFILE_50_DIR);
    ASSERT_EQ(NS_OK, mDirectories->Set(NS_APP_USER_PROFILE_50_DIR, mProfile));
    mProfileInstalled = true;
    mDirectories->Undefine(NS_APP_USER_PROFILE_LOCAL_50_DIR);
    ASSERT_EQ(NS_OK,
              mDirectories->Set(NS_APP_USER_PROFILE_LOCAL_50_DIR, mProfile));
    mLocalInstalled = true;
    ASSERT_EQ(NS_OK, mProfile->Clone(getter_AddRefs(mInput)));
    ASSERT_EQ(NS_OK, mInput->Append(u"unchanged-input.eml"_ns));
    nsCOMPtr<nsIOutputStream> input;
    ASSERT_EQ(NS_OK,
              NS_NewLocalFileOutputStream(getter_AddRefs(input), mInput));
    uint32_t written = 0;
    ASSERT_EQ(NS_OK,
              input->Write(kBody.BeginReading(), kBody.Length(), &written));
    ASSERT_EQ(kBody.Length(), written);
    ASSERT_EQ(NS_OK, input->Close());
    if (!aCold) {
      mAccounts = do_GetService("@mozilla.org/messenger/account-manager;1");
      ASSERT_TRUE(mAccounts);
      ASSERT_EQ(NS_OK, mAccounts->CreateIncomingServer(
                           "s508-writer"_ns, "localhost"_ns, "imap"_ns,
                           getter_AddRefs(mServer)));
      ASSERT_EQ(NS_OK, mAccounts->CreateAccount(getter_AddRefs(mAccount)));
      ASSERT_EQ(NS_OK, mAccount->SetIncomingServer(mServer));
      ASSERT_EQ(NS_OK,
                mServer->SetStringValue(
                    "storeContractID",
                    aMaildir ? "@mozilla.org/msgstore/maildirstore;1"_ns
                             : "@mozilla.org/msgstore/berkeleystore;1"_ns));
      ASSERT_EQ(NS_OK, mProfile->Clone(getter_AddRefs(mMail)));
      ASSERT_EQ(NS_OK, mMail->Append(u"ImapMail"_ns));
      ASSERT_EQ(NS_OK, mMail->Create(nsIFile::DIRECTORY_TYPE, 0700));
      ASSERT_EQ(NS_OK, mServer->SetLocalPath(mMail));
      nsCOMPtr<nsIMsgFolder> root;
      ASSERT_EQ(NS_OK, mServer->GetRootFolder(getter_AddRefs(root)));
      ASSERT_EQ(NS_OK, root->AddSubfolder("Body"_ns, getter_AddRefs(mFolder)));
      ASSERT_EQ(NS_OK, mFolder->GetMsgStore(getter_AddRefs(mStore)));
      nsCString type;
      ASSERT_EQ(NS_OK, mStore->GetStoreType(type));
      ASSERT_EQ(aMaildir ? "maildir"_ns : "mbox"_ns, type);
      ASSERT_EQ(NS_OK, mStore->EnsureLocalStore(mFolder));
    }
    // Inventory consumes actual saved preferences, never an expected binding
    // supplied by this oracle. No account/store getter runs after ArmSelected.
    nsCOMPtr<nsIFile> prefs;
    ASSERT_EQ(NS_OK, mProfile->Clone(getter_AddRefs(prefs)));
    ASSERT_EQ(NS_OK, prefs->Append(u"prefs.js"_ns));
    nsCOMPtr<nsIPrefService> pref = do_GetService(NS_PREFSERVICE_CONTRACTID);
    ASSERT_TRUE(pref);
    ASSERT_EQ(NS_OK, pref->SavePrefFile(prefs));
  }

  static bool Until(const std::function<bool()>& aDone) {
    RefPtr<MigrationWait> wait = new MigrationWait();
    nsCOMPtr<nsITimer> timer;
    nsresult rv = NS_NewTimerWithFuncCallback(
        getter_AddRefs(timer),
        [](nsITimer*, void* aClosure) {
          static_cast<MigrationWait*>(aClosure)->expired = true;
        },
        wait.get(), 15000, nsITimer::TYPE_ONE_SHOT, "ImapMigrationBoundary"_ns);
    EXPECT_EQ(NS_OK, rv);
    if (NS_FAILED(rv)) return false;
    bool spun = SpinEventLoopUntil("ImapMigrationActualBoundary"_ns,
                                   [&] { return aDone() || wait->expired; });
    EXPECT_EQ(NS_OK, timer->Cancel());
    EXPECT_TRUE(spun);
    EXPECT_TRUE(aDone());
    return spun && aDone();
  }

  nsresult Wait(const RefPtr<MigrationSettlementPromise>& aPromise) {
    RefPtr<MigrationWait> wait = new MigrationWait();
    aPromise->Then(
        GetMainThreadSerialEventTarget(), __func__,
        [wait](bool aOk) {
          wait->result = aOk ? NS_OK : NS_ERROR_UNEXPECTED;
          wait->done = true;
        },
        [wait](nsresult aError) {
          wait->result = aError;
          wait->done = true;
        });
    return Until([&] { return wait->done; }) ? wait->result
                                             : NS_ERROR_NET_TIMEOUT;
  }

  void Arm() {
    nsCOMPtr<nsIProfileUnlocker> unlocker;
    ASSERT_EQ(NS_OK,
              NS_LockProfilePath(mProfile, mProfile, getter_AddRefs(unlocker),
                                 getter_AddRefs(mLock)));
    SelectedSnapshotRequest request;
    ASSERT_EQ(NS_OK, mProfile->GetPath(request.path));
    request.path.AppendLiteral(".s508-request.json");
    auto parent =
        MigrationWriterLease::ArmSelected(mLock, mProfile, mProfile, request);
    ASSERT_TRUE(parent.isOk());
    mParent = parent.unwrap();
    ASSERT_EQ(NS_OK, mParent->ValidateSelectedIdentity());
    mWhole = mParent->AcquireAndDrain();
    mImap = ImapMigrationWriterLease::Current();
    ASSERT_TRUE(mImap);
    ASSERT_EQ(mParent.get(), mImap->mParent.get());
    ASSERT_EQ(mParent->Generation(), mImap->mGeneration);
  }

  void Protocol() {
    ASSERT_TRUE(mServer);
    nsCOMPtr<nsIImapIncomingServer> server = do_QueryInterface(mServer);
    nsCOMPtr<nsIImapHostSessionList> hosts =
        do_GetService("@mozilla.org/messenger/imaphostsessionlist;1");
    ASSERT_TRUE(server && hosts);
    mProtocol = new nsImapProtocol();
    ASSERT_EQ(NS_OK, mProtocol->Initialize(hosts, server));
    ASSERT_TRUE(mProtocol->mMigrationThread);
    ASSERT_TRUE(mProtocol->MigrationWork());
  }

  void Body() {
    auto work = ImapMigrationWork::AdmitBody(mFolder, nullptr);
    ASSERT_TRUE(work.isOk());
    mBody = work.unwrap();
    ASSERT_EQ(NS_OK,
              mStore->GetNewMsgOutputStream(mFolder, getter_AddRefs(mOutput)));
    uint32_t count;
    ASSERT_EQ(NS_OK,
              mOutput->Write(kBody.BeginReading(), kBody.Length(), &count));
    ASSERT_EQ(kBody.Length(), count);
  }

  nsresult Finish() {
    EXPECT_FALSE(mFinishAttempted);
    mFinishAttempted = true;
    ++mFinishes;
    nsresult rv = mStore->FinishNewMessage(mFolder, mOutput, mToken);
    mBody->RecordError(rv);
    // Finish may have installed bytes on error. There is deliberately no
    // discard or second Finish. Keep this output/root custody through release.
    // An error is not itself a close receipt. The failure case deliberately
    // closed the real output before Finish; success follows its normal close.
    if (NS_SUCCEEDED(rv) || mOutput->StreamStatus() == NS_BASE_STREAM_CLOSED) {
      mBody->Complete(rv);
    }
    return rv;
  }

  void CheckInput() {
    nsCString bytes;
    ASSERT_EQ(NS_OK, Read(mInput, bytes));
    EXPECT_EQ(kBody, bytes);
  }

  void CheckFinishedBody() {
    ASSERT_FALSE(mToken.IsEmpty());
    nsCOMPtr<nsIInputStream> input;
    ASSERT_EQ(NS_OK, mStore->GetMsgInputStream(mFolder, mToken, 0,
                                               getter_AddRefs(input)));
    nsCString bytes;
    ASSERT_EQ(NS_OK, NS_ConsumeStream(input, UINT32_MAX, bytes));
    ASSERT_EQ(NS_OK, input->Close());
    EXPECT_EQ(kBody, bytes);
    CheckInput();
  }

  RefPtr<WorkerTail> Tail(bool aProxy) {
    RefPtr<WorkerTail> tail = new WorkerTail();
    nsresult rv = mProtocol->mMigrationThread->Dispatch(
        NS_NewRunnableFunction(
            "ImapMigrationWriterLeaseTest::ActualWorkerTail",
            [tail, aProxy] {
              tail->entered = true;
              if (aProxy) {
                MOZ_ALWAYS_SUCCEEDS(NS_DispatchAndSpinEventLoopUntilComplete(
                    "ImapMigrationWriterLeaseTest::ActualProxy"_ns,
                    GetMainThreadSerialEventTarget(),
                    NS_NewRunnableFunction(
                        "ImapMigrationWriterLeaseTest::MainProxy", [tail] {
                          EXPECT_TRUE(NS_IsMainThread());
                          EXPECT_TRUE(ImapMigrationDrainActive());
                          tail->proxyRan = true;
                        })));
              }
              MonitorAutoLock lock(tail->monitor);
              TimeStamp deadline =
                  TimeStamp::Now() + TimeDuration::FromSeconds(5);
              while (!tail->release) {
                TimeDuration remaining = deadline - TimeStamp::Now();
                if (remaining <= TimeDuration()) {
                  tail->expired = true;
                  break;
                }
                if (lock.Wait(remaining) == CVStatus::Timeout) {
                  tail->expired = true;
                  break;
                }
              }
            }),
        NS_DISPATCH_NORMAL);
    EXPECT_EQ(NS_OK, rv);
    return tail;
  }

  void ReleaseTail(WorkerTail* aTail) {
    MonitorAutoLock lock(aTail->monitor);
    aTail->release = true;
    lock.NotifyAll();
  }

  nsresult Settle(nsresult aConsumer = NS_OK) {
    mConsumerSettled = true;
    return Wait(mParent->SettleConsumerAndRelease(aConsumer));
  }

  void Check(uint32_t aCase) {
    switch (aCase) {
      case 0: {  // Actual denied native entries cannot start a thread or body.
        Arm();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        nsCOMPtr<nsIImapIncomingServer> server = do_QueryInterface(mServer);
        RefPtr<nsImapProtocol> late = new nsImapProtocol();
        EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, late->Initialize(nullptr, server));
        EXPECT_FALSE(late->mMigrationThread);
        nsCOMPtr<nsIFile> output;
        ASSERT_EQ(NS_OK, mProfile->Clone(getter_AddRefs(output)));
        ASSERT_EQ(NS_OK, output->Append(u"must-not-open.eml"_ns));
        EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
                  static_cast<nsImapMailFolder*>(mFolder.get())
                      ->SetupMsgWriteStream(output));
        bool exists = true;
        ASSERT_EQ(NS_OK, output->Exists(&exists));
        EXPECT_FALSE(exists);
        EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, mParent->FirstError());
        break;
      }
      case 1: {  // Cache eviction does not complete an actual protocol ticket.
        Protocol();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        nsCOMPtr<nsIImapIncomingServer> server = do_QueryInterface(mServer);
        ASSERT_EQ(NS_OK, server->RemoveConnection(mProtocol));
        Arm();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        EXPECT_FALSE(mImap->mTerminal);
        EXPECT_FALSE(mProtocol->MigrationWork()->mTerminal);
        EXPECT_EQ(NS_OK, Wait(mImap->WhenTerminal()));
        EXPECT_TRUE(mProtocol->MigrationWork()->mTerminal);
        EXPECT_TRUE(mProtocol->mMigrationThreadOwned);
        // The ticket resolves only in the real shutdown OnCompletion callback.
        EXPECT_FALSE(mProtocol->m_imapThreadIsRunning);
        break;
      }
      case 2:
      case 3: {
        Protocol();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        auto tail = Tail(aCase == 3);
        auto release = MakeScopeExit([&] { ReleaseTail(tail); });
        Arm();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        ASSERT_TRUE(Until(
            [&] { return tail->entered && (aCase != 3 || tail->proxyRan); }));
        EXPECT_FALSE(mProtocol->m_imapThreadIsRunning);
        EXPECT_FALSE(mImap->mTerminal);
        EXPECT_FALSE(mProtocol->MigrationWork()->mTerminal);
        ReleaseTail(tail);
        release.release();
        EXPECT_EQ(NS_OK, Wait(mImap->WhenTerminal()));
        EXPECT_FALSE(tail->expired);
        if (aCase == 3) EXPECT_TRUE(tail->proxyRan);
        break;
      }
      case 4: {
        Body();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        Arm();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        EXPECT_FALSE(mImap->mTerminal);
        EXPECT_FALSE(mBody->mTerminal);
        EXPECT_EQ(0u, mFinishes);
        EXPECT_EQ(NS_OK, Finish());
        EXPECT_EQ(NS_OK, Wait(mImap->WhenTerminal()));
        EXPECT_EQ(1u, mFinishes);
        EXPECT_EQ(0u, mDiscards);
        CheckFinishedBody();
        break;
      }
      case 5: {
        Body();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        // Both stores have real closed output. Maildir additionally has an
        // owned cur-file collision, so Finish cannot rename tmp bytes away.
        ASSERT_EQ(NS_OK, mOutput->Close());
        if (mMaildir) {
          nsCOMPtr<nsIFile> path;
          ASSERT_EQ(NS_OK, mFolder->GetFilePath(getter_AddRefs(path)));
          ASSERT_EQ(NS_OK, path->Append(u"cur"_ns));
          bool exists;
          ASSERT_EQ(NS_OK, path->Exists(&exists));
          if (exists) ASSERT_EQ(NS_OK, path->Remove(false));
          ASSERT_EQ(NS_OK, path->Create(nsIFile::NORMAL_FILE_TYPE, 0600));
        }
        Arm();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        uint32_t count = UINT32_MAX;
        nsresult first = mOutput->Write("x", 1, &count);
        ASSERT_EQ(NS_BASE_STREAM_CLOSED, first);
        mBody->RecordError(first);
        nsresult finish = Finish();
        EXPECT_TRUE(NS_FAILED(finish));
        EXPECT_EQ(first, Wait(mImap->WhenTerminal()));
        EXPECT_EQ(first, mParent->FirstError());
        EXPECT_EQ(1u, mFinishes);
        EXPECT_EQ(0u, mDiscards);
        EXPECT_TRUE(mToken.IsEmpty());
        EXPECT_EQ(NS_BASE_STREAM_CLOSED, mOutput->StreamStatus());
        if (mMaildir) {
          nsCOMPtr<nsIFile> tmp;
          ASSERT_EQ(NS_OK, mFolder->GetFilePath(getter_AddRefs(tmp)));
          ASSERT_EQ(NS_OK, tmp->Append(u"tmp"_ns));
          nsCOMPtr<nsIDirectoryEnumerator> entries;
          ASSERT_EQ(NS_OK, tmp->GetDirectoryEntries(getter_AddRefs(entries)));
          nsCOMPtr<nsIFile> retained;
          ASSERT_EQ(NS_OK, entries->GetNextFile(getter_AddRefs(retained)));
          ASSERT_TRUE(retained);
          nsCString bytes;
          ASSERT_EQ(NS_OK, Read(retained, bytes));
          EXPECT_EQ(kBody, bytes);
          nsCOMPtr<nsIFile> extra;
          ASSERT_EQ(NS_OK, entries->GetNextFile(getter_AddRefs(extra)));
          EXPECT_FALSE(extra);
          ASSERT_EQ(NS_OK, entries->Close());
        }
        EXPECT_FALSE(mParent->SecondaryErrors().IsEmpty());
        CheckInput();
        break;
      }
      case 6:
      case 7: {
        nsCOMPtr<nsIMsgMailNewsUrl> url =
            do_CreateInstance("@mozilla.org/messenger/imapurl;1");
        ASSERT_TRUE(url);
        nsCString uri;
        ASSERT_EQ(NS_OK, mFolder->GetURI(uri));
        ASSERT_EQ(NS_OK, url->SetSpecInternal(uri));
        RefPtr<QueueWitness> witness = new QueueWitness();
        nsCOMPtr<nsIImapIncomingServer> server = do_QueryInterface(mServer);
        RefPtr<nsImapIncomingServer> native =
            static_cast<nsImapIncomingServer*>(server.get());
        nsCOMPtr<nsIImapUrl> imapUrl = do_QueryInterface(url);
        ASSERT_EQ(NS_OK, url->RegisterListener(witness));
        witness->onStop = [&, native] {
          native->mLock.AssertNotCurrentThreadOwns();
          EXPECT_EQ(0, native->m_urlQueue.Count());
          EXPECT_TRUE(ImapMigrationDrainActive());
          if (aCase == 7) {
            EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, native->SuspendUrl(imapUrl));
            bool ran = true;
            EXPECT_EQ(NS_OK, native->LoadNextQueuedUrl(nullptr, &ran));
            EXPECT_FALSE(ran);
            EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
                      native->RetryUrl(imapUrl, nullptr));
          }
        };
        ASSERT_EQ(NS_OK, native->SuspendUrl(imapUrl));
        Arm();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        EXPECT_EQ(1u, witness->stops);
        EXPECT_EQ(NS_BINDING_ABORTED, witness->status);
        EXPECT_TRUE(NS_FAILED(Wait(mImap->WhenTerminal())));
        EXPECT_EQ(1u, witness->stops);
        EXPECT_EQ(0, native->m_urlQueue.Count());
        witness->onStop = nullptr;
        break;
      }
      case 8: {
        Protocol();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        RefPtr<ImapMigrationWork> work = mProtocol->MigrationWork();
        nsCOMPtr<nsIThreadShutdown> external;
        ASSERT_EQ(NS_OK, mProtocol->mMigrationThread->BeginShutdown(
                             getter_AddRefs(external)));
        Arm();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        // The real runnable's second BeginShutdown fails. Even after the
        // independently observed actual shutdown, that failed request alone
        // cannot supply this ticket's receipt.
        ASSERT_TRUE(Until([&] { return external->Completed(); }));
        EXPECT_FALSE(work->mTerminal);
        EXPECT_FALSE(mImap->mTerminal);
        nsresult failure;
        {
          MutexAutoLock lock(work->mMutex);
          failure = work->mSettlement.firstError;
        }
        ASSERT_TRUE(NS_FAILED(failure));
        // Fixture cleanup acknowledges the concrete external receipt only now.
        ASSERT_TRUE(external->Completed());
        work->Complete(failure);
        EXPECT_EQ(failure, Wait(mImap->WhenTerminal()));
        break;
      }
      case 9: {
        Body();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        Arm();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        auto stale =
            BeginImapMigrationDrain(*mParent, mParent->Generation() + 1);
        ASSERT_TRUE(stale.isErr());
        EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, stale.unwrapErr());
        auto reentry = BeginImapMigrationDrain(*mParent, mParent->Generation());
        ASSERT_TRUE(reentry.isErr());
        EXPECT_EQ(NS_ERROR_IN_PROGRESS, reentry.unwrapErr());
        EXPECT_FALSE(mImap->mTerminal);
        EXPECT_EQ(NS_OK, mParent->FirstError());
        EXPECT_EQ(NS_OK, Finish());
        EXPECT_EQ(NS_OK, Wait(mImap->WhenTerminal()));
        CheckFinishedBody();
        break;
      }
      case 10: {
        Body();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        Arm();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        mImap->Cancel(NS_ERROR_ABORT);
        EXPECT_FALSE(mImap->mTerminal);
        EXPECT_FALSE(mBody->mTerminal);
        EXPECT_EQ(NS_ERROR_ABORT, mParent->FirstError());
        EXPECT_EQ(NS_OK, Finish());
        EXPECT_EQ(NS_ERROR_ABORT, Wait(mImap->WhenTerminal()));
        EXPECT_EQ(1u, mFinishes);
        EXPECT_EQ(0u, mDiscards);
        CheckFinishedBody();
        break;
      }
      case 11: {
        Protocol();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        Arm();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        EXPECT_EQ(NS_OK, Wait(mWhole));
        auto rejected = mImap->Release(
            *mParent, MigrationReleaseDisposition::ContinueSelectedStartup);
        EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, Wait(rejected));
        EXPECT_FALSE(mImap->mReleaseStarted);
        mConsumerSettled = true;
        auto release = mParent->SettleConsumerAndRelease(NS_OK);
        ASSERT_TRUE(Until([&] { return mImap->mReleaseStarted; }));
        auto repeat = mImap->Release(
            *mParent, MigrationReleaseDisposition::ContinueSelectedStartup);
        EXPECT_EQ(mImap->mReleasePromise, repeat);
        auto conflict = mImap->Release(
            *mParent, MigrationReleaseDisposition::StopSelectedStartup);
        EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, Wait(conflict));
        EXPECT_EQ(NS_OK, Wait(release));
        EXPECT_EQ(MigrationPhase::Released, mParent->Phase());
        auto stale = BeginImapMigrationDrain(*mParent, mParent->Generation());
        ASSERT_TRUE(stale.isErr());
        EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, stale.unwrapErr());
        RefPtr<ImapMigrationWriterLease> old = mImap;
        mProtocol = nullptr;
        Protocol();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        old->Cancel(NS_ERROR_ABORT);
        EXPECT_FALSE(mProtocol->MigrationWork()->DrainRequested());
        ASSERT_EQ(NS_OK, mProtocol->TellThreadToDie(true));
        bool done = false;
        mProtocol->MigrationWork()->WhenTerminal()->Then(
            GetMainThreadSerialEventTarget(), __func__,
            [&](const auto&) { done = true; }, [&](nsresult) { done = true; });
        EXPECT_TRUE(Until([&] { return done; }));
        break;
      }
      case 12: {
        ASSERT_FALSE(NSS_IsInitialized());
        Arm();
        ASSERT_FALSE(::testing::Test::HasFatalFailure());
        EXPECT_EQ(NS_OK, Wait(mImap->WhenTerminal()));
        EXPECT_TRUE(mImap->mCaptured.IsEmpty());
        EXPECT_FALSE(NSS_IsInitialized());
        EXPECT_EQ(NS_OK, Wait(mWhole));
        EXPECT_FALSE(NSS_IsInitialized());
        break;
      }
      default:
        FAIL() << "Unknown fixed native regression";
    }
    CheckInput();
  }

  void Close() {
    if (mOutput && !mFinishAttempted) {
      ++mDiscards;
      nsresult rv = mStore->DiscardNewMessage(mFolder, mOutput);
      EXPECT_EQ(NS_OK, rv);
      if (mBody) mBody->Complete(rv);
    }
    if (mProtocol && mProtocol->MigrationWork() &&
        !mProtocol->MigrationWork()->mTerminal) {
      EXPECT_EQ(NS_OK, mProtocol->TellThreadToDie(true));
    }
    if (mParent && !mConsumerSettled) {
      nsresult result = Wait(mWhole);
      EXPECT_EQ(mParent->FirstError(), result);
      EXPECT_EQ(result, Settle(result));
    }
    mOutput = nullptr;
    mBody = nullptr;
    mProtocol = nullptr;
    mImap = nullptr;
    mWhole = nullptr;
    mParent = nullptr;
    if (mLock) {
      EXPECT_EQ(NS_OK, mLock->Unlock());
      mLock = nullptr;
    }
    mStore = nullptr;
    mFolder = nullptr;
    mAccount = nullptr;
    mServer = nullptr;
    mAccounts = nullptr;
    if (mProfileInstalled) {
      mDirectories->Undefine(NS_APP_USER_PROFILE_50_DIR);
      if (mOldProfile)
        EXPECT_EQ(NS_OK,
                  mDirectories->Set(NS_APP_USER_PROFILE_50_DIR, mOldProfile));
    }
    if (mLocalInstalled) {
      mDirectories->Undefine(NS_APP_USER_PROFILE_LOCAL_50_DIR);
      if (mOldLocal)
        EXPECT_EQ(NS_OK, mDirectories->Set(NS_APP_USER_PROFILE_LOCAL_50_DIR,
                                           mOldLocal));
    }
    if (mProfile) EXPECT_EQ(NS_OK, mProfile->Remove(true));
  }
};

// Sticky native history has no reset: ordinary GTest fresh subprocesses
// isolate each real selected lock and store variant, with explicit teardown.
TEST(ImapMigrationWriterLease, AdmissionClosesBeforeProtocolOrOfflineBodyStart)
{
#if GTEST_HAS_DEATH_TEST
  ::testing::FLAGS_gtest_death_test_style = "threadsafe";
  for (bool maildir : {false, true}) {
    ASSERT_EXIT(
        {
          ImapMigrationWriterLeaseTest::Run(0, maildir);
          std::_Exit(::testing::Test::HasFailure() ? 1 : 0);
        },
        ::testing::ExitedWithCode(0), "");
  }
#else
  FAIL() << "Fresh-process native ownership controls are unavailable";
#endif
}

// Sticky native history has no reset: ordinary GTest fresh subprocesses
// isolate each real selected lock and store variant, with explicit teardown.
TEST(ImapMigrationWriterLease, UncachedProtocolGenerationStillPreventsHeld)
{
#if GTEST_HAS_DEATH_TEST
  ::testing::FLAGS_gtest_death_test_style = "threadsafe";
  for (bool maildir : {false, true}) {
    ASSERT_EXIT(
        {
          ImapMigrationWriterLeaseTest::Run(1, maildir);
          std::_Exit(::testing::Test::HasFailure() ? 1 : 0);
        },
        ::testing::ExitedWithCode(0), "");
  }
#else
  FAIL() << "Fresh-process native ownership controls are unavailable";
#endif
}

// Sticky native history has no reset: ordinary GTest fresh subprocesses
// isolate each real selected lock and store variant, with explicit teardown.
TEST(ImapMigrationWriterLease, WorkerLoopExitDoesNotSkipProxyAndThreadShutdown)
{
#if GTEST_HAS_DEATH_TEST
  ::testing::FLAGS_gtest_death_test_style = "threadsafe";
  for (bool maildir : {false, true}) {
    ASSERT_EXIT(
        {
          ImapMigrationWriterLeaseTest::Run(2, maildir);
          std::_Exit(::testing::Test::HasFailure() ? 1 : 0);
        },
        ::testing::ExitedWithCode(0), "");
  }
#else
  FAIL() << "Fresh-process native ownership controls are unavailable";
#endif
}

// Sticky native history has no reset: ordinary GTest fresh subprocesses
// isolate each real selected lock and store variant, with explicit teardown.
TEST(ImapMigrationWriterLease, MainThreadProxiesRemainServiceableDuringDrain)
{
#if GTEST_HAS_DEATH_TEST
  ::testing::FLAGS_gtest_death_test_style = "threadsafe";
  for (bool maildir : {false, true}) {
    ASSERT_EXIT(
        {
          ImapMigrationWriterLeaseTest::Run(3, maildir);
          std::_Exit(::testing::Test::HasFailure() ? 1 : 0);
        },
        ::testing::ExitedWithCode(0), "");
  }
#else
  FAIL() << "Fresh-process native ownership controls are unavailable";
#endif
}

// Sticky native history has no reset: ordinary GTest fresh subprocesses
// isolate each real selected lock and store variant, with explicit teardown.
TEST(ImapMigrationWriterLease, PartialLiteralBodyRetainsWriterUntilFinish)
{
#if GTEST_HAS_DEATH_TEST
  ::testing::FLAGS_gtest_death_test_style = "threadsafe";
  for (bool maildir : {false, true}) {
    ASSERT_EXIT(
        {
          ImapMigrationWriterLeaseTest::Run(4, maildir);
          std::_Exit(::testing::Test::HasFailure() ? 1 : 0);
        },
        ::testing::ExitedWithCode(0), "");
  }
#else
  FAIL() << "Fresh-process native ownership controls are unavailable";
#endif
}

// Sticky native history has no reset: ordinary GTest fresh subprocesses
// isolate each real selected lock and store variant, with explicit teardown.
TEST(ImapMigrationWriterLease,
     AbortAndFinishFailurePreserveFirstErrorAndBodyCustody)
{
#if GTEST_HAS_DEATH_TEST
  ::testing::FLAGS_gtest_death_test_style = "threadsafe";
  for (bool maildir : {false, true}) {
    ASSERT_EXIT(
        {
          ImapMigrationWriterLeaseTest::Run(5, maildir);
          std::_Exit(::testing::Test::HasFailure() ? 1 : 0);
        },
        ::testing::ExitedWithCode(0), "");
  }
#else
  FAIL() << "Fresh-process native ownership controls are unavailable";
#endif
}

// Sticky native history has no reset: ordinary GTest fresh subprocesses
// isolate each real selected lock and store variant, with explicit teardown.
TEST(ImapMigrationWriterLease, QueuedUrlCancellationCompletesOnceOutsideLocks)
{
#if GTEST_HAS_DEATH_TEST
  ::testing::FLAGS_gtest_death_test_style = "threadsafe";
  for (bool maildir : {false, true}) {
    ASSERT_EXIT(
        {
          ImapMigrationWriterLeaseTest::Run(6, maildir);
          std::_Exit(::testing::Test::HasFailure() ? 1 : 0);
        },
        ::testing::ExitedWithCode(0), "");
  }
#else
  FAIL() << "Fresh-process native ownership controls are unavailable";
#endif
}

// Sticky native history has no reset: ordinary GTest fresh subprocesses
// isolate each real selected lock and store variant, with explicit teardown.
TEST(ImapMigrationWriterLease, IdleRetryAndCallbackReentryCannotReadmit)
{
#if GTEST_HAS_DEATH_TEST
  ::testing::FLAGS_gtest_death_test_style = "threadsafe";
  for (bool maildir : {false, true}) {
    ASSERT_EXIT(
        {
          ImapMigrationWriterLeaseTest::Run(7, maildir);
          std::_Exit(::testing::Test::HasFailure() ? 1 : 0);
        },
        ::testing::ExitedWithCode(0), "");
  }
#else
  FAIL() << "Fresh-process native ownership controls are unavailable";
#endif
}

// Sticky native history has no reset: ordinary GTest fresh subprocesses
// isolate each real selected lock and store variant, with explicit teardown.
TEST(ImapMigrationWriterLease,
     ShutdownDispatchOrShutdownFailureCannotCertifyTerminal)
{
#if GTEST_HAS_DEATH_TEST
  ::testing::FLAGS_gtest_death_test_style = "threadsafe";
  for (bool maildir : {false, true}) {
    ASSERT_EXIT(
        {
          ImapMigrationWriterLeaseTest::Run(8, maildir);
          std::_Exit(::testing::Test::HasFailure() ? 1 : 0);
        },
        ::testing::ExitedWithCode(0), "");
  }
#else
  FAIL() << "Fresh-process native ownership controls are unavailable";
#endif
}

// Sticky native history has no reset: ordinary GTest fresh subprocesses
// isolate each real selected lock and store variant, with explicit teardown.
TEST(ImapMigrationWriterLease, ForeignStaleAndReentrantLeaseAreRejected)
{
#if GTEST_HAS_DEATH_TEST
  ::testing::FLAGS_gtest_death_test_style = "threadsafe";
  for (bool maildir : {false, true}) {
    ASSERT_EXIT(
        {
          ImapMigrationWriterLeaseTest::Run(9, maildir);
          std::_Exit(::testing::Test::HasFailure() ? 1 : 0);
        },
        ::testing::ExitedWithCode(0), "");
  }
#else
  FAIL() << "Fresh-process native ownership controls are unavailable";
#endif
}

// Sticky native history has no reset: ordinary GTest fresh subprocesses
// isolate each real selected lock and store variant, with explicit teardown.
TEST(ImapMigrationWriterLease, CancellationWaitsForRealSettlement)
{
#if GTEST_HAS_DEATH_TEST
  ::testing::FLAGS_gtest_death_test_style = "threadsafe";
  for (bool maildir : {false, true}) {
    ASSERT_EXIT(
        {
          ImapMigrationWriterLeaseTest::Run(10, maildir);
          std::_Exit(::testing::Test::HasFailure() ? 1 : 0);
        },
        ::testing::ExitedWithCode(0), "");
  }
#else
  FAIL() << "Fresh-process native ownership controls are unavailable";
#endif
}

// Sticky native history has no reset: ordinary GTest fresh subprocesses
// isolate each real selected lock and store variant, with explicit teardown.
TEST(ImapMigrationWriterLease, ReleaseOnceAndReopenRequireParentGeneration)
{
#if GTEST_HAS_DEATH_TEST
  ::testing::FLAGS_gtest_death_test_style = "threadsafe";
  for (bool maildir : {false, true}) {
    ASSERT_EXIT(
        {
          ImapMigrationWriterLeaseTest::Run(11, maildir);
          std::_Exit(::testing::Test::HasFailure() ? 1 : 0);
        },
        ::testing::ExitedWithCode(0), "");
  }
#else
  FAIL() << "Fresh-process native ownership controls are unavailable";
#endif
}

// Sticky native history has no reset: ordinary GTest fresh subprocesses
// isolate each real selected lock and store variant, with explicit teardown.
TEST(ImapMigrationWriterLease, ColdEmptyAcquireDoesNotInitializeNSS)
{
#if GTEST_HAS_DEATH_TEST
  ::testing::FLAGS_gtest_death_test_style = "threadsafe";
  for (bool maildir : {false, true}) {
    ASSERT_EXIT(
        {
          ImapMigrationWriterLeaseTest::Run(12, maildir);
          std::_Exit(::testing::Test::HasFailure() ? 1 : 0);
        },
        ::testing::ExitedWithCode(0), "");
  }
#else
  FAIL() << "Fresh-process native ownership controls are unavailable";
#endif
}

}  // namespace mozilla::mailnews
