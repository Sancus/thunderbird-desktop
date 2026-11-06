/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "msgCore.h"  // precompiled header...
#include "nsPop3Sink.h"
#include "nsISeekableStream.h"
#include "prprf.h"
#include "prlog.h"
#include "nscore.h"
#include <stdio.h>
#include <time.h>
#include "nsParseMailbox.h"
#include "nsIMsgLocalMailFolder.h"
#include "nsIMsgIncomingServer.h"
#include "nsLocalUtils.h"
#include "nsMsgLocalFolderHdrs.h"
#include "nsIMsgFolder.h"  // TO include biffState enum. Change to bool later...
#include "nsMsgMessageFlags.h"
#include "nsMailHeaders.h"
#include "nsIMsgAccountManager.h"
#include "nsIPop3Protocol.h"
#include "nsLocalMailFolder.h"
#include "nsIInputStream.h"
#include "nsIDocShell.h"
#include "nsMsgUtils.h"
#include "nsServiceManagerUtils.h"
#include "nsISupportsPrimitives.h"
#include "nsIObserverService.h"
#include "nsIPop3Service.h"
#include "mozilla/Components.h"
#include "mozilla/Logging.h"
#include "mozilla/Services.h"
#ifdef MOZ_PANORAMA
#  include "DatabaseCore.h"
#  include "PerFolderDatabase.h"
#  include "mozilla/ResultExtensions.h"
#  include "mozilla/StaticPrefs_mail.h"
#endif

/* for logging to Error Console */
#include "nsIScriptError.h"

mozilla::LazyLogModule POP3LOGMODULE("POP3");
#define POP3LOG(str) "sink: [this=%p] " str, this

NS_IMPL_ISUPPORTS(nsPop3Sink, nsIPop3Sink, nsIMsgOperationListener)

#ifdef MOZ_PANORAMA
class PopMigrationIncorporationTerminal final : public nsIMsgOperationListener {
 public:
  NS_DECL_ISUPPORTS
  PopMigrationIncorporationTerminal(
      nsPop3Sink* aSink, mozilla::mailnews::LocalStoreMigrationWork* aWork,
      uint64_t aSerial)
      : mSink(aSink), mWork(aWork), mSerial(aSerial) {}
  NS_IMETHOD OnStopOperation(nsresult aResult) override {
    if (mDone) return NS_OK;
    mDone = true;
    NS_ENSURE_TRUE(mSink->mMigrationIncorporation == mSerial &&
                       mSink->mMigrationDelivery == mWork,
                   NS_ERROR_NOT_AVAILABLE);
    if (mWork && !mWork->IsTerminal()) MOZ_TRY(mWork->Validate());
    return mSink->OnStopOperation(aResult);
  }

 private:
  ~PopMigrationIncorporationTerminal() = default;
  RefPtr<nsPop3Sink> mSink;
  RefPtr<mozilla::mailnews::LocalStoreMigrationWork> mWork;
  const uint64_t mSerial;
  bool mDone = false;
};
NS_IMPL_ISUPPORTS(PopMigrationIncorporationTerminal, nsIMsgOperationListener)
#endif

nsPop3Sink::nsPop3Sink() {
  m_biffState = 0;
  m_numNewMessages = 0;
  m_numNewMessagesInFolder = 0;
  m_numMsgsDownloaded = 0;
  m_senderAuthed = false;
  m_outFileStream = nullptr;
  m_uidlDownload = false;
  m_buildMessageUri = false;
}

nsPop3Sink::~nsPop3Sink() {
  MOZ_LOG(POP3LOGMODULE, mozilla::LogLevel::Debug,
          (POP3LOG("Calling ReleaseFolderLock from ~nsPop3Sink")));
  ReleaseFolderLock();
}

nsresult nsPop3Sink::DiscardStalePartialMessages(nsIPop3Protocol* protocol) {
  struct PartialRecord {
    nsCOMPtr<nsIMsgDBHdr> m_msgDBHdr = nullptr;
    nsCString m_uidl;
  };
  nsTArray<PartialRecord> partialMsgsArray;

  // Walk through all the messages in this folder and look for any
  // partial messages. For each of those, dig through the mailbox and
  // find the account that the message belongs to. If that account
  // matches the current Account, then look for the UIDL and save
  // this message for later processing.

  nsCOMPtr<nsIMsgLocalMailFolder> localFolder = do_QueryInterface(m_folder);
  if (!localFolder) {
    return NS_ERROR_FAILURE;
  }

  nsCOMPtr<nsIMsgEnumerator> messages;
  bool hasMore = false;
  bool isOpen = false;
  nsLocalFolderScanState folderScanState;
  nsCOMPtr<nsIMsgDatabase> db;
  m_folder->GetMsgDatabase(getter_AddRefs(db));
  if (!db) return NS_ERROR_FAILURE;  // we need it to grub through the folder

  nsresult rv = db->EnumerateMessages(getter_AddRefs(messages));
  if (messages) messages->HasMoreElements(&hasMore);
  while (hasMore && NS_SUCCEEDED(rv)) {
    uint32_t flags = 0;
    nsCOMPtr<nsIMsgDBHdr> msgDBHdr;
    rv = messages->GetNext(getter_AddRefs(msgDBHdr));
    if (!NS_SUCCEEDED(rv)) break;
    msgDBHdr->GetFlags(&flags);
    if (flags & nsMsgMessageFlags::Partial) {
      // Open the various streams we need to seek and read from the mailbox
      if (!isOpen) {
        rv = localFolder->GetFolderScanState(&folderScanState);
        if (NS_SUCCEEDED(rv)) {
          isOpen = true;
        } else {
          break;
        }
      }
      rv = localFolder->GetUidlFromFolder(&folderScanState, msgDBHdr);
      if (!NS_SUCCEEDED(rv)) break;

      // If we got the uidl, see if this partial message belongs to this
      // account. Add it to the array if so...
      if (folderScanState.m_uidl &&
          m_accountKey.Equals(folderScanState.m_accountKey,
                              nsCaseInsensitiveCStringComparator)) {
        partialMsgsArray.AppendElement(
            PartialRecord{msgDBHdr, nsCString{folderScanState.m_uidl}});
      }
    }
    messages->HasMoreElements(&hasMore);
  }
  if (isOpen && folderScanState.m_inputStream) {
    folderScanState.m_inputStream->Close();
  }
  NS_ENSURE_SUCCESS(rv, rv);

  // For all the partial messages saved above, ask the protocol handler if they
  // still exist on the server. Any messages that don't exist any more are
  // deleted from the msgDB.

  bool deleted = false;
  for (PartialRecord& partialMsg : partialMsgsArray) {
    bool found = true;
    protocol->CheckMessage(partialMsg.m_uidl.get(), &found);
    if (!found && partialMsg.m_msgDBHdr) {
      rv = db->DeleteHeader(partialMsg.m_msgDBHdr, nullptr, false, true);
      if (NS_FAILED(rv)) {
        continue;
      }
      deleted = true;
    }
  }
  partialMsgsArray.Clear();
  if (deleted) {
    localFolder->NotifyDelete();
  }
  return NS_OK;
}

NS_IMETHODIMP nsPop3Sink::BeginMailDelivery(bool uidlDownload,
                                            nsIMsgWindow* aMsgWindow) {
  if (m_completionPending) return NS_ERROR_IN_PROGRESS;
  if (m_outFileStream) {
    return NS_FAILED(m_incorporateStatus) ? m_incorporateStatus
                                          : NS_ERROR_IN_PROGRESS;
  }
#ifdef MOZ_PANORAMA
  NS_ENSURE_TRUE(m_folder, NS_ERROR_NOT_INITIALIZED);
  if (!mMigrationDelivery || mMigrationDelivery->IsTerminal()) {
    MOZ_TRY(mozilla::mailnews::LocalStoreMigrationWork::Begin(
        static_cast<nsIPop3Sink*>(this), m_folder, mMigrationDelivery));
  } else {
    MOZ_TRY(mMigrationDelivery->AddFolder(m_folder));
    MOZ_TRY(mMigrationDelivery->Validate());
  }
  mMigrationDelivery->StartPopDelivery();
  mMigrationDeliveryEnding = false;
#endif
  m_incorporateStatus = NS_OK;
  nsCOMPtr<nsIMsgIncomingServer> server = do_QueryInterface(m_popServer);
  if (!server) return NS_ERROR_UNEXPECTED;

  m_window = aMsgWindow;

  nsCOMPtr<nsIMsgAccountManager> acctMgr =
      mozilla::components::AccountManager::Service();
  nsCOMPtr<nsIMsgAccount> account;
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    m_accountKey.Truncate();
    MOZ_TRY(acctMgr->FindAccountForServer(server, getter_AddRefs(account)));
    NS_ENSURE_TRUE(account, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(account->GetKey(m_accountKey));
  } else
#endif
  {
    acctMgr->FindAccountForServer(server, getter_AddRefs(account));
    if (account) account->GetKey(m_accountKey);
  }

  bool isLocked;
  nsCOMPtr<nsISupports> supports =
      do_QueryInterface(static_cast<nsIPop3Sink*>(this));

  NS_ENSURE_STATE(m_folder);
  m_folder->GetLocked(&isLocked);
  if (!isLocked) {
    MOZ_LOG(POP3LOGMODULE, mozilla::LogLevel::Debug,
            (POP3LOG("BeginMailDelivery acquiring semaphore")));
    m_folder->AcquireSemaphore(supports, "nsPop3Sink::BeginMailDelivery"_ns);
  } else {
    MOZ_LOG(POP3LOGMODULE, mozilla::LogLevel::Debug,
            (POP3LOG("BeginMailDelivery folder locked")));
    return NS_MSG_FOLDER_BUSY;
  }
  m_uidlDownload = uidlDownload;

  m_folder->GetNumNewMessages(false, &m_numNewMessagesInFolder);

#ifdef DEBUG
  printf("Begin mail message delivery.\n");
#endif
  nsresult rv;
  nsCOMPtr<nsIPop3Service> pop3Service(
      do_GetService("@mozilla.org/messenger/popservice;1", &rv));
  NS_ENSURE_SUCCESS(rv, rv);
  pop3Service->NotifyDownloadStarted(m_folder);
  return NS_OK;
}

NS_IMETHODIMP nsPop3Sink::EndMailDelivery(nsIPop3Protocol* protocol) {
#ifdef MOZ_PANORAMA
  if (mMigrationDelivery && !mMigrationDelivery->IsTerminal())
    MOZ_TRY(mMigrationDelivery->Validate());
  mMigrationDeliveryEnding = true;
  nsresult migrationResult = [&]() -> nsresult {
#endif
    if (m_completionPending) return NS_ERROR_IN_PROGRESS;
    if (m_outFileStream && NS_SUCCEEDED(m_incorporateStatus)) {
      RecordIncorporateResult(NS_ERROR_UNEXPECTED);
    }
    if (NS_FAILED(m_incorporateStatus)) {
      AbortMailDelivery(protocol);
      return m_incorporateStatus;
    }
    if (!m_uidlDownload) {
      DiscardStalePartialMessages(protocol);
    }

    if (m_newMailParser) {
      m_newMailParser->DoneParsing();
      m_newMailParser->EndMsgDownload();
    }

    // tell the parser to mark the db valid *after* closing the mailbox.
    if (m_newMailParser) m_newMailParser->UpdateDBFolderInfo();

    MOZ_LOG(POP3LOGMODULE, mozilla::LogLevel::Debug,
            (POP3LOG("Calling ReleaseFolderLock from EndMailDelivery")));
    nsresult rv = ReleaseFolderLock();
    NS_ASSERTION(NS_SUCCEEDED(rv), "folder lock not released successfully");

    bool filtersRun;
    m_folder->CallFilterPlugins(nullptr,
                                &filtersRun);  // ??? do we need msgWindow?
    int32_t numNewMessagesInFolder;
    // if filters have marked msgs read or deleted, the num new messages count
    // will go negative by the number of messages marked read or deleted,
    // so if we add that number to the number of msgs downloaded, that will give
    // us the number of actual new messages.
    m_folder->GetNumNewMessages(false, &numNewMessagesInFolder);
    m_numNewMessages -= (m_numNewMessagesInFolder - numNewMessagesInFolder);
    m_folder->SetNumNewMessages(
        m_numNewMessages);  // we'll adjust this for spam later
    if (!filtersRun && m_numNewMessages > 0) {
      nsCOMPtr<nsIMsgIncomingServer> server;
      m_folder->GetServer(getter_AddRefs(server));
      if (server) {
        server->SetPerformingBiff(true);
        m_folder->SetBiffState(m_biffState);
        server->SetPerformingBiff(false);
      }
    }
    // note that size on disk has possibly changed.
    nsCOMPtr<nsIMsgLocalMailFolder> localFolder = do_QueryInterface(m_folder);
    if (localFolder) (void)localFolder->RefreshSizeOnDisk();
    nsCOMPtr<nsIMsgIncomingServer> server = do_QueryInterface(m_popServer);
    if (server) {
      nsCOMPtr<nsIMsgFilterList> filterList;
      rv = server->GetFilterList(nullptr, getter_AddRefs(filterList));
      NS_ENSURE_SUCCESS(rv, rv);

      if (filterList) (void)filterList->FlushLogIfNecessary();
    }

    // fix for bug #161999
    // we should update the summary totals for the folder (inbox)
    // in case it's not the open folder
    m_folder->UpdateSummaryTotals(true);

#ifdef DEBUG
    printf("End mail message delivery.\n");
#endif
    nsCOMPtr<nsIPop3Service> pop3Service(
        do_GetService("@mozilla.org/messenger/popservice;1", &rv));
    NS_ENSURE_SUCCESS(rv, rv);
    pop3Service->NotifyDownloadCompleted(m_folder, m_numNewMessages);
    return NS_OK;

#ifdef MOZ_PANORAMA
  }();
  MaybeSettleMigration(migrationResult);
  return migrationResult;
#endif
}

nsresult nsPop3Sink::ReleaseFolderLock() {
  nsresult result = NS_OK;
  if (!m_folder) return result;
  bool haveSemaphore;
  nsCOMPtr<nsISupports> supports =
      do_QueryInterface(static_cast<nsIPop3Sink*>(this));
  result = m_folder->TestSemaphore(supports, &haveSemaphore);
  MOZ_LOG(POP3LOGMODULE, mozilla::LogLevel::Debug,
          (POP3LOG("ReleaseFolderLock haveSemaphore = %s"),
           haveSemaphore ? "TRUE" : "FALSE"));

  if (NS_SUCCEEDED(result) && haveSemaphore)
    result = m_folder->ReleaseSemaphore(supports,
                                        "nsPop3Sink::ReleaseFolderLock"_ns);
  return result;
}

NS_IMETHODIMP nsPop3Sink::AbortMailDelivery(nsIPop3Protocol* protocol) {
#ifdef MOZ_PANORAMA
  if (mMigrationDelivery && !mMigrationDelivery->IsTerminal())
    MOZ_TRY(mMigrationDelivery->Validate());
  mMigrationDeliveryEnding = true;
  nsresult migrationResult = [&]() -> nsresult {
#endif
    IncorporateAbort();

    if (!m_outFileStream && m_newMailParser) {
      m_newMailParser->UpdateDBFolderInfo();
    }
    MOZ_LOG(POP3LOGMODULE, mozilla::LogLevel::Debug,
            (POP3LOG("Calling ReleaseFolderLock from AbortMailDelivery")));

    nsresult rv = ReleaseFolderLock();
    NS_ASSERTION(NS_SUCCEEDED(rv), "folder lock not released successfully");
    RecordIncorporateResult(rv);

    nsCOMPtr<nsIPop3Service> pop3Service(
        do_GetService("@mozilla.org/messenger/popservice;1", &rv));
    if (NS_SUCCEEDED(rv)) {
      rv = pop3Service->NotifyDownloadCompleted(m_folder, 0);
    }
    return RecordIncorporateResult(rv);

#ifdef MOZ_PANORAMA
  }();
  MaybeSettleMigration(migrationResult);
  return migrationResult;
#endif
}

nsresult nsPop3Sink::RecordIncorporateResult(nsresult status) {
#ifdef MOZ_PANORAMA
  if (mMigrationDelivery) mMigrationDelivery->RecordError(status);
#endif

  if (NS_SUCCEEDED(m_incorporateStatus) && NS_FAILED(status)) {
    m_incorporateStatus = status;
  }
  return NS_FAILED(m_incorporateStatus) ? m_incorporateStatus : status;
}

NS_IMETHODIMP nsPop3Sink::IncorporateBegin(const char* uidlString,
                                           uint32_t flags) {
#ifdef MOZ_PANORAMA
  if (mMigrationDelivery && !mMigrationDelivery->IsTerminal())
    MOZ_TRY(mMigrationDelivery->Validate());
#endif

  if (m_completionPending) return NS_ERROR_IN_PROGRESS;
  if (NS_FAILED(m_incorporateStatus)) return m_incorporateStatus;
  if (m_outFileStream) return RecordIncorporateResult(NS_ERROR_IN_PROGRESS);
  m_finishCalled = false;
  nsresult rv = IncorporateBeginInternal(uidlString, flags);
  if (NS_SUCCEEDED(rv)) {
    m_confirmedPartialCompletion = false;
    // Only a successfully admitted message replaces the preceding receipt.
    m_messageUri.Truncate();
  }
  return RecordIncorporateResult(rv);
}

nsresult nsPop3Sink::IncorporateBeginInternal(const char* uidlString,
                                              uint32_t flags) {
#ifdef DEBUG
  printf("Incorporate message begin:\n");
  if (uidlString) printf("uidl string: %s\n", uidlString);
#endif

  nsresult rv;

  nsCOMPtr<nsIMsgDatabase> db;
  rv = m_folder->GetMsgDatabase(getter_AddRefs(db));
  NS_ENSURE_SUCCESS(rv, rv);

#ifdef MOZ_PANORAMA
  // Resolve the source and capture its guard before opening replacement bytes.
  rv = PreparePartialMessage(uidlString, flags, db);
  NS_ENSURE_SUCCESS(rv, rv);
#endif
  rv = m_folder->GetMsgStore(getter_AddRefs(m_msgStore));
  NS_ENSURE_SUCCESS(rv, rv);
#ifdef MOZ_PANORAMA
  {
    mozilla::mailnews::AutoLocalStoreMigrationContinuation continuation(
        mMigrationDelivery);
#endif
    rv = m_msgStore->GetNewMsgOutputStream(m_folder,
                                           getter_AddRefs(m_outFileStream));
#ifdef MOZ_PANORAMA
  }
#endif
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIMsgFolder> serverFolder;
  rv = GetServerFolder(getter_AddRefs(serverFolder));
  if (NS_FAILED(rv)) return rv;

  // Annoyingly, there's some state which needs to be carried over multiple
  // messages, hence this hoop-jumping.
  int32_t oldNotNewCount = 0;
  RefPtr<nsImapMoveCoalescer> oldCoalescer;
  mozilla::UniquePtr<nsTHashMap<nsCStringHashKey, int32_t>>
      oldFilterTargetFoldersMsgMovedCount;
  if (m_newMailParser) {
    oldNotNewCount = m_newMailParser->m_numNotNewMessages;
    oldCoalescer = m_newMailParser->m_moveCoalescer;
    oldFilterTargetFoldersMsgMovedCount.swap(
        m_newMailParser->m_filterTargetFoldersMsgMovedCount);
    m_newMailParser->m_moveCoalescer = nullptr;
    m_newMailParser = nullptr;
  }

  nsCOMPtr<nsIMsgDBHdr> newHdr;
  rv = db->CreateNewHdr(getter_AddRefs(newHdr));
  NS_ENSURE_SUCCESS(rv, rv);

  // Create a new mail parser to parse out the headers of the message and
  // load the details into the message database.
  m_newMailParser = new nsParseNewMailState;
  rv = m_newMailParser->Init(serverFolder, m_folder, m_window, newHdr,
                             m_outFileStream);
  m_newMailParser->m_numNotNewMessages = oldNotNewCount;
  m_newMailParser->m_moveCoalescer = oldCoalescer;
  m_newMailParser->m_filterTargetFoldersMsgMovedCount.swap(
      oldFilterTargetFoldersMsgMovedCount);

  if (m_uidlDownload) m_newMailParser->DisableFilters();

  NS_ENSURE_SUCCESS(rv, rv);

  nsCString outputString;
  // Write out account-key before UIDL so the code that looks for
  // UIDL will find the account first and know it can stop looking
  // once it finds the UIDL line.
  if (!m_accountKey.IsEmpty()) {
    outputString.AssignLiteral(HEADER_X_MOZILLA_ACCOUNT_KEY ": ");
    outputString.Append(m_accountKey);
    outputString.AppendLiteral(MSG_LINEBREAK);
    rv = WriteLineToMailbox(outputString);
    NS_ENSURE_SUCCESS(rv, rv);
  }
  if (uidlString) {
    outputString.AssignLiteral("X-UIDL: ");
    outputString.Append(uidlString);
    outputString.AppendLiteral(MSG_LINEBREAK);
    rv = WriteLineToMailbox(outputString);
    NS_ENSURE_SUCCESS(rv, rv);
  }

  // WriteLineToMailbox("X-Mozilla-Status: 8000" MSG_LINEBREAK);
  char* statusLine = PR_smprintf(X_MOZILLA_STATUS_FORMAT MSG_LINEBREAK, flags);
  outputString.Assign(statusLine);
  rv = WriteLineToMailbox(outputString);
  PR_smprintf_free(statusLine);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = WriteLineToMailbox("X-Mozilla-Status2: 00000000"_ns MSG_LINEBREAK);
  NS_ENSURE_SUCCESS(rv, rv);

  // leave space for 60 bytes worth of keys/tags
  return WriteLineToMailbox(nsLiteralCString(X_MOZILLA_KEYWORDS));
}

NS_IMETHODIMP
nsPop3Sink::SetPopServer(nsIPop3IncomingServer* server) {
#ifdef MOZ_PANORAMA
  if (mMigrationDelivery && !mMigrationDelivery->IsTerminal()) {
    if (server != m_popServer) {
      NS_ENSURE_TRUE(!server && !m_completionPending && !m_outFileStream &&
                         !mMigrationCallbackRunning,
                     NS_ERROR_IN_PROGRESS);
      // Clearing the actual server association performs no IO. The global
      // participant still joins the real client/UIDL Promise independently.
      mMigrationDelivery->Complete(m_incorporateStatus);
    }
  } else if (server) {
    MOZ_TRY(mozilla::mailnews::LocalStoreMigrationWork::PreparePop(
        static_cast<nsIPop3Sink*>(this), mMigrationDelivery));
  }
#endif

  m_popServer = server;
  return NS_OK;
}

NS_IMETHODIMP
nsPop3Sink::GetPopServer(nsIPop3IncomingServer** aServer) {
  NS_ENSURE_ARG_POINTER(aServer);
  NS_IF_ADDREF(*aServer = m_popServer);
  return NS_OK;
}

NS_IMETHODIMP nsPop3Sink::GetFolder(nsIMsgFolder** aFolder) {
  NS_ENSURE_ARG_POINTER(aFolder);
  NS_IF_ADDREF(*aFolder = m_folder);
  return NS_OK;
}

NS_IMETHODIMP nsPop3Sink::SetFolder(nsIMsgFolder* aFolder) {
#ifdef MOZ_PANORAMA
  if (mMigrationDelivery && !mMigrationDelivery->IsTerminal() && aFolder) {
    NS_ENSURE_FALSE(m_outFileStream || m_completionPending,
                    NS_ERROR_IN_PROGRESS);
    MOZ_TRY(mMigrationDelivery->AddFolder(aFolder));
  }
#endif

  m_folder = aFolder;
  return NS_OK;
}

nsresult nsPop3Sink::GetServerFolder(nsIMsgFolder** aFolder) {
  NS_ENSURE_ARG_POINTER(aFolder);

  if (m_popServer) {
    // not sure what this is used for - might be wrong if we have a deferred
    // account.
    nsCOMPtr<nsIMsgIncomingServer> incomingServer =
        do_QueryInterface(m_popServer);
    if (incomingServer) return incomingServer->GetRootFolder(aFolder);
  }
  *aFolder = nullptr;
  return NS_ERROR_NULL_POINTER;
}

NS_IMETHODIMP nsPop3Sink::SetMsgsToDownload(uint32_t aNumMessages) {
  m_numNewMessages = aNumMessages;
  return NS_OK;
}

NS_IMETHODIMP nsPop3Sink::IncorporateWrite(const char* block, int32_t length) {
#ifdef MOZ_PANORAMA
  if (mMigrationDelivery && !mMigrationDelivery->IsTerminal())
    MOZ_TRY(mMigrationDelivery->Validate());
#endif

  if (m_completionPending) return NS_ERROR_IN_PROGRESS;
  return WriteLineToMailbox(nsDependentCString(block, length));
}

nsresult nsPop3Sink::WriteLineToMailbox(const nsACString& buffer) {
#ifdef MOZ_PANORAMA
  if (mMigrationDelivery && !mMigrationDelivery->IsTerminal())
    MOZ_TRY(mMigrationDelivery->Validate());
#endif

  if (NS_FAILED(m_incorporateStatus)) return m_incorporateStatus;
  if (buffer.IsEmpty()) return NS_OK;
  if (!m_outFileStream) {
    return RecordIncorporateResult(NS_ERROR_NOT_INITIALIZED);
  }
  nsresult rv =
      SyncWriteAll(m_outFileStream, buffer.BeginReading(), buffer.Length());
  if (NS_SUCCEEDED(rv) && m_newMailParser) {
    rv = m_newMailParser->HandleLine(buffer.BeginReading(), buffer.Length());
  }
  return RecordIncorporateResult(rv);
}

NS_IMETHODIMP nsPop3Sink::IncorporateComplete(
    nsIMsgWindow* aMsgWindow, int32_t aSize,
    nsIMsgOperationListener* aCallback) {
#ifdef MOZ_PANORAMA
  if (mMigrationDelivery && !mMigrationDelivery->IsTerminal())
    MOZ_TRY(mMigrationDelivery->Validate());
#endif

  if (m_completionPending) return NS_ERROR_IN_PROGRESS;
  if (NS_FAILED(m_incorporateStatus)) return m_incorporateStatus;
  if (m_finishCalled) {
    return RecordIncorporateResult(NS_ERROR_ALREADY_INITIALIZED);
  }
  if (!m_outFileStream)
    return RecordIncorporateResult(NS_ERROR_NOT_INITIALIZED);
  // From acceptance onward only the callback reports terminal status.
  if (aCallback) {
#ifdef MOZ_PANORAMA
    NS_ENSURE_TRUE(mMigrationIncorporation != UINT64_MAX,
                   RecordIncorporateResult(NS_ERROR_NOT_AVAILABLE));
    ++mMigrationIncorporation;
#endif
    m_completionListener = aCallback;
    m_completionPending = true;
  }
  nsresult rv;
  nsCOMPtr<nsIMsgDBHdr> completed;
#ifdef MOZ_PANORAMA
  if (m_partialBody) {
    rv = CompletePartialMessage(aSize, getter_AddRefs(completed));
  } else
#endif
  {
    rv = IncorporateCompleteInternal(aMsgWindow, aSize,
                                     getter_AddRefs(completed));
  }
  RecordIncorporateResult(rv);
#ifdef MOZ_PANORAMA
  if (completed && NS_SUCCEEDED(m_incorporateStatus)) {
    nsCOMPtr<nsIMsgOperationListener> migrationTerminal;
    if (aCallback) {
      migrationTerminal = new PopMigrationIncorporationTerminal(
          this, mMigrationDelivery, mMigrationIncorporation);
    }
    rv = m_newMailParser->ApplyFiltersToCompletedMessage(
        completed, migrationTerminal, !m_partialBody);
    if (aCallback) {
      // May already have completed synchronously through OnStopOperation.
      if (NS_FAILED(rv)) (void)OnStopOperation(rv);
      return NS_OK;
    }
  }
#endif
  if (aCallback) {
    (void)OnStopOperation(rv);
    return NS_OK;
  }
  return FinishIncorporation(rv);
}

nsresult nsPop3Sink::FinishIncorporation(nsresult status) {
#ifdef MOZ_PANORAMA
  if (mMigrationDelivery && !mMigrationDelivery->IsTerminal())
    MOZ_TRY(mMigrationDelivery->Validate());
#endif

  if (NS_FAILED(RecordIncorporateResult(status))) return m_incorporateStatus;
  nsresult rv;
  nsCOMPtr<nsIPop3Service> pop3Service(
      do_GetService("@mozilla.org/messenger/popservice;1", &rv));
  if (NS_FAILED(rv)) return RecordIncorporateResult(rv);
  pop3Service->NotifyDownloadProgress(m_folder, ++m_numMsgsDownloaded,
                                      m_numNewMessages);
  return RecordIncorporateResult(NS_OK);
}

NS_IMETHODIMP nsPop3Sink::OnStopOperation(nsresult status) {
  if (!m_completionPending) return NS_OK;
  status = FinishIncorporation(status);
  nsCOMPtr<nsIMsgOperationListener> completion = m_completionListener.forget();
  m_completionPending = false;
  // Retain failed/uncertain provider state; clear only callback ownership.
#ifdef MOZ_PANORAMA
  mMigrationCallbackRunning = true;
#endif
  if (completion) (void)completion->OnStopOperation(status);
#ifdef MOZ_PANORAMA
  mMigrationCallbackRunning = false;
  MaybeSettleMigration(status);
#endif
  return NS_OK;
}

#ifdef MOZ_PANORAMA
nsresult nsPop3Sink::PreparePartialMessage(const char* uidl, uint32_t flags,
                                           nsIMsgDatabase* database) {
  m_partialBody.reset();
  m_partialUri.Truncate();
  m_partialFinishedToken.Truncate();
  if (!mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) return NS_OK;
  if (flags & nsMsgMessageFlags::Partial) {
    // A truncated response cannot complete an explicitly requested source.
    return m_origMessageUri.IsEmpty() ? NS_OK : NS_ERROR_UNEXPECTED;
  }

  nsCOMPtr<nsIMsgDBHdr> original;
  if (!m_origMessageUri.IsEmpty()) {
    MOZ_TRY(GetMsgDBHdrFromURI(m_origMessageUri, getter_AddRefs(original)));
    NS_ENSURE_TRUE(original, NS_ERROR_NOT_AVAILABLE);
  } else {
    nsCOMPtr<nsIMsgLocalMailFolder> local = do_QueryInterface(m_folder);
    NS_ENSURE_TRUE(local, NS_ERROR_NO_INTERFACE);
    auto* folder = static_cast<nsMsgLocalMailFolder*>(local.get());
    MOZ_TRY(folder->FindPartialMessageByUidl(
        m_accountKey, nsDependentCString(uidl ? uidl : ""),
        getter_AddRefs(original)));
    if (!original) return NS_OK;  // Ordinary new mail, not a selected Partial.
  }
  NS_ENSURE_TRUE(uidl && *uidl && !m_accountKey.IsEmpty(),
                 NS_ERROR_INVALID_ARG);
  nsCOMPtr<nsIMsgFolder> originalFolder;
  MOZ_TRY(original->GetFolder(getter_AddRefs(originalFolder)));
  NS_ENSURE_TRUE(originalFolder, NS_ERROR_NOT_AVAILABLE);
  uint64_t folderId, originalFolderId;
  MOZ_TRY(m_folder->GetId(&folderId));
  MOZ_TRY(originalFolder->GetId(&originalFolderId));
  NS_ENSURE_TRUE(folderId == originalFolderId, NS_ERROR_INVALID_ARG);
  nsMsgKey key;
  MOZ_TRY(original->GetMessageKey(&key));
  RefPtr<mozilla::mailnews::DatabaseCore> core =
      mozilla::mailnews::DatabaseCore::GetInstanceForService();
  NS_ENSURE_TRUE(core, NS_ERROR_NOT_INITIALIZED);
  mozilla::mailnews::MessageBodyState expected;
  MOZ_TRY(core->MessageDB().GetMessageBodyState(key, expected));
  NS_ENSURE_TRUE(expected.folderId == folderId &&
                     (expected.flags & nsMsgMessageFlags::Partial),
                 NS_ERROR_INVALID_ARG);
  // OpenFolderDB selects this native facade when Panorama is enabled.
  auto* folderDB = static_cast<mozilla::mailnews::PerFolderDatabase*>(database);
  NS_ENSURE_TRUE(folderDB->FolderId() == folderId, NS_ERROR_INVALID_ARG);
  nsCString storedAccount, storedUidl;
  MOZ_TRY(
      ReadPop3MessageIdentity(m_folder, original, storedAccount, storedUidl));
  NS_ENSURE_TRUE(m_accountKey.Equals(storedAccount) && storedUidl.Equals(uidl),
                 NS_ERROR_INVALID_ARG);
  MOZ_TRY(m_folder->GetUriForMsg(original, m_partialUri));
  m_partialBody.emplace(std::move(expected));
  return NS_OK;
}

nsresult nsPop3Sink::CompletePartialMessage(int32_t size,
                                            nsIMsgDBHdr** result) {
  NS_ENSURE_ARG_POINTER(result);
  *result = nullptr;
  NS_ENSURE_STATE(m_partialBody && m_newMailParser && m_outFileStream);
  MOZ_TRY(m_newMailParser->HandleLine("", 0));
  MOZ_TRY(m_newMailParser->FinishHeader());
  nsCOMPtr<nsIMsgDBHdr> parsed;
  MOZ_TRY(m_newMailParser->GetNewMsgHdr(getter_AddRefs(parsed)));
  NS_ENSURE_TRUE(m_newMailParser->m_mailDB, NS_ERROR_NOT_INITIALIZED);
  auto* database = static_cast<mozilla::mailnews::PerFolderDatabase*>(
      m_newMailParser->m_mailDB.get());
  NS_ENSURE_TRUE(database->FolderId() == m_partialBody->folderId,
                 NS_ERROR_INVALID_ARG);
  nsCOMPtr<nsIMsgDBHdr> original;
  MOZ_TRY(
      database->GetMsgHdrForKey(m_partialBody->key, getter_AddRefs(original)));
  // Keep the user's priority, as legacy UpdateNewMsgHdr does.
  nsMsgPriorityValue priority;
  MOZ_TRY(original->GetPriority(&priority));
  MOZ_TRY(parsed->SetPriority(priority));
  // The padded incoming X-Mozilla-Keys header must not replace current tags.
  nsCString keywords, junkOrigin;
  MOZ_TRY(original->GetStringProperty("keywords", keywords));
  MOZ_TRY(parsed->SetStringProperty("keywords", keywords));
  MOZ_TRY(original->GetStringProperty("junkscoreorigin", junkOrigin));
  if (junkOrigin.EqualsLiteral("plugin")) {
    MOZ_TRY(parsed->SetStringProperty("junkscore", ""_ns));
  }
  if (size) MOZ_TRY(parsed->SetUint32Property("onlineSize", size));

  nsresult rv;
  nsCOMPtr<nsISupportsString> originalUri =
      do_CreateInstance(NS_SUPPORTS_STRING_CONTRACTID, &rv);
  MOZ_TRY(rv);
  MOZ_TRY(originalUri->SetData(NS_ConvertUTF8toUTF16(m_partialUri)));
  MOZ_TRY(m_outFileStream->Flush());
  // From this point neither failure nor SQL rollback permits Discard or retry.
  m_finishCalled = true;
  MOZ_TRY(m_msgStore->FinishNewMessage(m_folder, m_outFileStream,
                                       m_partialFinishedToken));
  m_outFileStream = nullptr;
  mozilla::mailnews::FinishedMessageBody finished;
  finished.storeToken = m_partialFinishedToken;
  MOZ_TRY(ReadStoredMessageDetails(m_msgStore, m_folder, finished.storeToken,
                                   &finished.messageSize, &finished.lineCount));
  // Local bodies are available without the IMAP offline-storage flag/size.
  nsCOMPtr<nsIMsgDBHdr> completed;
  MOZ_TRY(database->CompletePartialHdr(*m_partialBody, parsed, finished,
                                       getter_AddRefs(completed)));
  // CompletePartialHdr returns success only after the owned native commit.
  m_confirmedPartialCompletion = true;
  // DoneParsing must not publish this consumed draft as a new message.
  m_newMailParser->SetNewMsgHdr(nullptr);
  if (m_buildMessageUri) m_messageUri = m_partialUri;
  nsCOMPtr<nsIObserverService> observers =
      mozilla::services::GetObserverService();
  if (observers) {
    observers->NotifyObservers(originalUri, "message-content-updated",
                               NS_ConvertUTF8toUTF16(m_partialUri).get());
  }
  // Filters operate on this committed physical row without replaying Finish.
  completed.forget(result);
  return NS_OK;
}
#endif

nsresult nsPop3Sink::IncorporateCompleteInternal(nsIMsgWindow* aMsgWindow,
                                                 int32_t aSize,
                                                 nsIMsgDBHdr** completed) {
  *completed = nullptr;
  bool native = false;
#ifdef MOZ_PANORAMA
  native = mozilla::StaticPrefs::mail_panorama_enabled_AtStartup();
#endif
  if (!native && m_buildMessageUri && !m_baseMessageUri.IsEmpty() &&
      m_newMailParser) {
    nsCOMPtr<nsIMsgDBHdr> hdr;
    m_newMailParser->GetNewMsgHdr(getter_AddRefs(hdr));
    if (hdr) {
      nsMsgKey msgKey;
      hdr->GetMessageKey(&msgKey);
      m_messageUri.Truncate();
      nsBuildLocalMessageURI(m_baseMessageUri, msgKey, m_messageUri);
    }
  }

  nsresult rv;

  NS_ASSERTION(m_newMailParser, "could not get m_newMailParser");

  // If line separators in server response are just LF instead of standard CRLF,
  // the blank line between the headers and the message body will not be
  // detected. The detection of this blank line causes the header content to
  // be parsed to correctly display the message list information. Send parser an
  // empty/blank line to cause a header parse if it has not yet occurred.
  if (m_newMailParser) {
    rv = m_newMailParser->HandleLine("", 0);
    NS_ENSURE_SUCCESS(rv, rv);
  }

  NS_ENSURE_STATE(m_outFileStream);
  // We need to flush the output stream in case mail filters move/copy the new
  // message. This relies on all the data being flushed (i.e., written to disk).
  rv = m_outFileStream->Flush();
  NS_ENSURE_SUCCESS(rv, rv);
  if (m_newMailParser) {
    // PublishMsgHdr clears m_newMsgHdr, so we need a comptr to
    // hold onto it.
    nsCOMPtr<nsIMsgDBHdr> hdr;
    m_newMailParser->GetNewMsgHdr(getter_AddRefs(hdr));
    NS_ASSERTION(hdr, "m_newMailParser->m_newMsgHdr wasn't set");
    if (!hdr) return NS_ERROR_FAILURE;

    nsCOMPtr<nsIMsgLocalMailFolder> localFolder = do_QueryInterface(m_folder);

    // If a header already exists for this message (for example, when
    // getting a complete message when a partial exists), then update the new
    // header from the old.
    nsCOMPtr<nsIMsgDBHdr> oldMsgHdr;
    bool replaceOldHeader = true;
#ifdef MOZ_PANORAMA
    // Panorama completion was resolved physically before opening this write.
    // A different UIDL must never fall back to matching by Message-ID here.
    replaceOldHeader = !mozilla::StaticPrefs::mail_panorama_enabled_AtStartup();
#endif
    if (localFolder && replaceOldHeader) {
      rv = !m_origMessageUri.IsEmpty()
               ? GetMsgDBHdrFromURI(m_origMessageUri, getter_AddRefs(oldMsgHdr))
               : localFolder->RetrieveHdrOfPartialMessage(
                     hdr, getter_AddRefs(oldMsgHdr));
      if (NS_SUCCEEDED(rv) && oldMsgHdr) {
        rv = localFolder->UpdateNewMsgHdr(oldMsgHdr, hdr);
        NS_ENSURE_SUCCESS(rv, rv);
      }
    }

    if (aSize) {
      rv = hdr->SetUint32Property("onlineSize", aSize);
      NS_ENSURE_SUCCESS(rv, rv);
    }
    m_finishCalled = true;
    nsAutoCString storeToken;
    rv = m_msgStore->FinishNewMessage(m_folder, m_outFileStream, storeToken);
    NS_ENSURE_SUCCESS(rv, rv);
    // The provider owns finalization. Never Close or Discard after Finish.
    m_outFileStream = nullptr;
    rv = hdr->SetStoreToken(storeToken);
    NS_ENSURE_SUCCESS(rv, rv);

    rv = m_newMailParser->PublishMsgHeader(
        aMsgWindow, completed,
        native && m_buildMessageUri ? &m_messageUri : nullptr);
    NS_ENSURE_SUCCESS(rv, rv);
    // Native fresh actions queue compose work on the published row and settle
    // it after completed filters, including any asynchronous Move, finish.
    if (!*completed) {
      (void)m_newMailParser->ApplyForwardAndReplyFilter(aMsgWindow);
    }

    if (oldMsgHdr) {
      // We had the partial message, but got the full now.
      nsCOMPtr<nsIMsgFolder> oldMsgFolder;
      rv = oldMsgHdr->GetFolder(getter_AddRefs(oldMsgFolder));
      NS_ENSURE_SUCCESS(rv, rv);
      nsCString oldURI;
      rv = oldMsgFolder->GetUriForMsg(oldMsgHdr, oldURI);
      NS_ENSURE_SUCCESS(rv, rv);

      nsCOMPtr<nsIMsgFolder> newMsgFolder;
      rv = hdr->GetFolder(getter_AddRefs(newMsgFolder));
      NS_ENSURE_SUCCESS(rv, rv);
      nsCString newURI;
      rv = newMsgFolder->GetUriForMsg(hdr, newURI);
      NS_ENSURE_SUCCESS(rv, rv);

      // Delete old header before notifying.
      nsCOMPtr<nsIMsgDatabase> db;
      rv = m_folder->GetMsgDatabase(getter_AddRefs(db));
      NS_ENSURE_SUCCESS(rv, rv);
      rv = db->DeleteHeader(oldMsgHdr, nullptr, false, true);
      NS_ENSURE_SUCCESS(rv, rv);

      nsCOMPtr<nsIObserverService> obsServ =
          mozilla::services::GetObserverService();
      nsCOMPtr<nsISupportsString> origUri =
          do_CreateInstance(NS_SUPPORTS_STRING_CONTRACTID, &rv);
      if (NS_SUCCEEDED(rv)) {
        origUri->SetData(NS_ConvertUTF8toUTF16(oldURI));
        obsServ->NotifyObservers(origUri, "message-content-updated",
                                 NS_ConvertUTF8toUTF16(newURI).get());
      }
    }
  }

#ifdef DEBUG
  printf("Incorporate message complete.\n");
#endif
  return NS_OK;
}

NS_IMETHODIMP nsPop3Sink::IncorporateAbort() {
#ifdef MOZ_PANORAMA
  if (mMigrationDelivery && !mMigrationDelivery->IsTerminal())
    MOZ_TRY(mMigrationDelivery->Validate());
#endif

  if (m_completionPending) {
    RecordIncorporateResult(NS_BINDING_ABORTED);
#ifdef MOZ_PANORAMA
    if (m_newMailParser) {
      m_newMailParser->CancelCompletedFilters(m_incorporateStatus);
    }
#endif
  }
  if (m_outFileStream && !m_finishCalled) {
    nsresult rv = m_msgStore->DiscardNewMessage(m_folder, m_outFileStream);
    NS_WARNING_ASSERTION(NS_SUCCEEDED(rv),
                         "Could not discard unfinished POP3 write");
    RecordIncorporateResult(rv);
    if (NS_SUCCEEDED(rv)) m_outFileStream = nullptr;
  }
  // A failed/uncertain Finish retains its stream and provider identity.
  // Drop only the unpublished draft, so later cleanup cannot publish it.
  if (m_newMailParser) m_newMailParser->SetNewMsgHdr(nullptr);
  return m_incorporateStatus;
}

#ifdef MOZ_PANORAMA
void nsPop3Sink::MaybeSettleMigration(nsresult aResult) {
  if (!mMigrationDelivery || mMigrationDelivery->IsTerminal()) return;
  mMigrationDelivery->RecordError(aResult);
  if (!mMigrationDeliveryEnding || m_completionPending || m_outFileStream ||
      mMigrationCallbackRunning)
    return;
  bool locked = true;
  nsCOMPtr<nsISupports> self =
      do_QueryInterface(static_cast<nsIPop3Sink*>(this));
  nsresult rv = m_folder ? m_folder->TestSemaphore(self, &locked) : NS_OK;
  mMigrationDelivery->RecordError(rv);
  if (NS_SUCCEEDED(rv) && (!m_folder || !locked)) {
    mMigrationDelivery->Complete(m_incorporateStatus);
  }
}
#endif

NS_IMETHODIMP nsPop3Sink::SetBiffStateAndUpdateFE(uint32_t aBiffState,
                                                  int32_t numNewMessages,
                                                  bool notify) {
  m_biffState = aBiffState;
  if (m_newMailParser) numNewMessages -= m_newMailParser->m_numNotNewMessages;

  if (notify && m_folder && numNewMessages > 0 &&
      numNewMessages != m_numNewMessages &&
      aBiffState == nsIMsgFolder::nsMsgBiffState_NewMail) {
    m_folder->SetNumNewMessages(numNewMessages);
    m_folder->SetBiffState(aBiffState);
  }
  m_numNewMessages = numNewMessages;

  return NS_OK;
}

NS_IMETHODIMP nsPop3Sink::GetBuildMessageUri(bool* bVal) {
  NS_ENSURE_ARG_POINTER(bVal);
  *bVal = m_buildMessageUri;
  return NS_OK;
}

NS_IMETHODIMP nsPop3Sink::SetBuildMessageUri(bool bVal) {
  m_buildMessageUri = bVal;
  return NS_OK;
}

NS_IMETHODIMP nsPop3Sink::GetConfirmedPartialCompletion(bool* confirmed) {
  NS_ENSURE_ARG_POINTER(confirmed);
  *confirmed = m_confirmedPartialCompletion;
  return NS_OK;
}

NS_IMETHODIMP nsPop3Sink::GetMessageUri(nsACString& messageUri) {
  NS_ENSURE_TRUE(!m_messageUri.IsEmpty(), NS_ERROR_FAILURE);
  messageUri = m_messageUri;
  return NS_OK;
}

NS_IMETHODIMP nsPop3Sink::SetMessageUri(const nsACString& messageUri) {
  m_messageUri = messageUri;
  return NS_OK;
}

NS_IMETHODIMP nsPop3Sink::GetBaseMessageUri(nsACString& baseMessageUri) {
  NS_ENSURE_TRUE(!m_baseMessageUri.IsEmpty(), NS_ERROR_FAILURE);
  baseMessageUri = m_baseMessageUri;
  return NS_OK;
}

NS_IMETHODIMP nsPop3Sink::SetBaseMessageUri(const nsACString& baseMessageUri) {
  m_baseMessageUri = baseMessageUri;
  return NS_OK;
}

NS_IMETHODIMP nsPop3Sink::GetOrigMessageUri(nsACString& aOrigMessageUri) {
  aOrigMessageUri.Assign(m_origMessageUri);
  return NS_OK;
}

NS_IMETHODIMP nsPop3Sink::SetOrigMessageUri(const nsACString& aOrigMessageUri) {
  m_origMessageUri.Assign(aOrigMessageUri);
  return NS_OK;
}
