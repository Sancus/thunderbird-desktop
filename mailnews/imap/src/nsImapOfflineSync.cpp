/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "msgCore.h"
#include "netCore.h"
#include "nsNetUtil.h"
#include "nsIAppStartup.h"
#include "nsImapOfflineSync.h"
#ifdef MOZ_PANORAMA
#  include "mozilla/StaticPrefs_mail.h"
#  include "DatabaseCore.h"
#  include "nsImapUrl.h"
#  include "nsImapService.h"
#  include "nsIImapIncomingServer.h"
#  include "mozilla/Preferences.h"
#  include "PerFolderDatabase.h"
#  include "nsIFolderLookupService.h"
#  include "mozilla/ScopeExit.h"
#  include "mozilla/ResultExtensions.h"
#  include "mozilla/AutoRestore.h"
#endif
#include "nsImapMailFolder.h"
#include "nsIMsgDatabase.h"
#include "nsMsgFolderFlags.h"
#include "nsMsgMessageFlags.h"
#include "nsIDBFolderInfo.h"
#include "nsIImapService.h"
#include "nsIMsgMailNewsUrl.h"
#include "nsIMsgAccountManager.h"
#include "nsINntpIncomingServer.h"
#include "nsDirectoryServiceDefs.h"
#include "nsIMsgCopyService.h"
#include "nsImapProtocol.h"
#include "nsMsgUtils.h"
#include "mozilla/Components.h"

/**
 * Set or clear the `nsMsgFolderFlags::OfflineEvents` flag on `folder`,
 * depending on whether it has dispatchable offline work in its database.
 * Native accepted unknown-UID recovery is retained without redispatch; errors
 * preserve the flag. The legacy branch retains its existing fallback.
 */
static nsresult UpdateOfflineEventsFlag(nsIMsgFolder* folder,
                                        nsIMsgOfflineOpsDatabase* db) {
  MOZ_ASSERT(folder);
  nsTArray<nsMsgKey> pending;
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    NS_ENSURE_TRUE(db, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(db->ListAllOfflineOpIds(pending));
    uint64_t folderId;
    MOZ_TRY(folder->GetId(&folderId));
    RefPtr<mozilla::mailnews::DatabaseCore> core =
        mozilla::mailnews::DatabaseCore::GetInstanceForService();
    NS_ENSURE_TRUE(core, NS_ERROR_NOT_AVAILABLE);
    for (nsMsgKey key : pending) {
      using namespace mozilla::mailnews;
      bool held;
      MOZ_TRY(core->MessageDB().IsOfflineImportHeld(folderId, key, held));
      // Imported custody must not repeatedly trigger automatic playback.
      if (held) continue;
      OfflineOperationData payload;
      MOZ_TRY(core->MessageDB().GetOfflineOperation(folderId, key, payload));
      for (uint32_t action : {nsIMsgOfflineImapOperation::kFlagsChanged,
                              nsIMsgOfflineImapOperation::kAddKeywords,
                              nsIMsgOfflineImapOperation::kRemoveKeywords,
                              nsIMsgOfflineImapOperation::kMsgCopy,
                              nsIMsgOfflineImapOperation::kMsgMoved,
                              nsIMsgOfflineImapOperation::kAppendDraft,
                              nsIMsgOfflineImapOperation::kAppendTemplate,
                              nsIMsgOfflineImapOperation::kDeleteAllMsgs}) {
        if (!(payload.operation & action)) continue;
        bool append = action == nsIMsgOfflineImapOperation::kAppendDraft ||
                      action == nsIMsgOfflineImapOperation::kAppendTemplate;
        bool copy = action == nsIMsgOfflineImapOperation::kMsgCopy;
        uint32_t count = copy ? payload.copyDestinations.Length() : 1;
        for (uint32_t ordinal = 0; ordinal < count; ++ordinal) {
          OfflineAttempt attempt;
          nsresult found =
              append ? core->MessageDB().GetCurrentOfflineAttempt(folderId, key,
                                                                  attempt)
                     : core->MessageDB().GetOfflineAttemptForAction(
                           folderId, key, action,
                           copy ? mozilla::Some(ordinal) : mozilla::Nothing(),
                           attempt);
          if (found == NS_ERROR_NOT_AVAILABLE ||
              (NS_SUCCEEDED(found) &&
               (attempt.operation != action ||
                attempt.state == OfflineAttemptState::Pending)))
            return folder->SetFlag(nsMsgFolderFlags::OfflineEvents);
          MOZ_TRY(found);
          if (attempt.replayVersion == 1) {
            auto blocked = [](const auto& progress) {
              return progress &&
                     (progress->state == OfflineReplayCommandState::Sent ||
                      progress->state == OfflineReplayCommandState::Ambiguous);
            };
            if (action == nsIMsgOfflineImapOperation::kFlagsChanged &&
                attempt.flagMutation &&
                attempt.state != OfflineAttemptState::Confirmed &&
                !blocked(attempt.flagSet) && !blocked(attempt.flagClear))
              return folder->SetFlag(nsMsgFolderFlags::OfflineEvents);
            if (action == nsIMsgOfflineImapOperation::kMsgMoved &&
                attempt.state == OfflineAttemptState::Confirmed &&
                !attempt.moveSettled && !blocked(attempt.sourceStore) &&
                !blocked(attempt.sourceExpunge))
              return folder->SetFlag(nsMsgFolderFlags::OfflineEvents);
          }
          if (action == nsIMsgOfflineImapOperation::kDeleteAllMsgs &&
              attempt.state == OfflineAttemptState::Confirmed)
            return folder->SetFlag(nsMsgFolderFlags::OfflineEvents);
          // A retained effect/uncertainty needs recovery, not another send.
          // Counterpart-only records likewise do not make work dispatchable.
          if (attempt.appendAccepted)
            MOZ_TRY(core->MessageDB().ValidateOfflineAppendAcceptedWithoutUid(
                attempt));
        }
      }
    }
    // Accepted unknown-UID recovery is retained, but is not dispatchable work.
    return folder->ClearFlag(nsMsgFolderFlags::OfflineEvents);
  }
#endif
  if (db && NS_SUCCEEDED(db->ListAllOfflineOpIds(pending)) &&
      !pending.IsEmpty()) {
    folder->SetFlag(nsMsgFolderFlags::OfflineEvents);
  } else {
    // UpdateFolder hands a folder whose flag is set to the playback machinery
    // instead of selecting it, so a flag we cannot justify has to go.
    folder->ClearFlag(nsMsgFolderFlags::OfflineEvents);
  }
  return NS_OK;
}

#ifdef MOZ_PANORAMA
// Retire a flag/keyword payload only after every saved action is confirmed.
// Transfer payloads and their action/ordinal receipts stay intact. A local
// removal failure is retried without resending any confirmed command.
static nsresult RemoveCompletedNativeActions(
    mozilla::mailnews::DatabaseCore* core,
    const mozilla::mailnews::OfflineAttempt& attempt, bool& removed) {
  using namespace mozilla::mailnews;
  removed = false;
  NS_ENSURE_TRUE(
      attempt.state == OfflineAttemptState::Confirmed &&
          (attempt.operation == nsIMsgOfflineImapOperation::kFlagsChanged ||
           attempt.operation == nsIMsgOfflineImapOperation::kAddKeywords ||
           attempt.operation == nsIMsgOfflineImapOperation::kRemoveKeywords),
      NS_ERROR_NOT_AVAILABLE);
  OfflineOperationData payload;
  MOZ_TRY(core->MessageDB().GetOfflineOperation(attempt.folderId,
                                                attempt.operationKey, payload));
  constexpr uint32_t flagActions = nsIMsgOfflineImapOperation::kFlagsChanged |
                                   nsIMsgOfflineImapOperation::kAddKeywords |
                                   nsIMsgOfflineImapOperation::kRemoveKeywords;
  if (payload.operation & ~flagActions) return NS_OK;
  for (uint32_t action : {nsIMsgOfflineImapOperation::kFlagsChanged,
                          nsIMsgOfflineImapOperation::kAddKeywords,
                          nsIMsgOfflineImapOperation::kRemoveKeywords}) {
    if (!(payload.operation & action)) continue;
    OfflineAttempt saved;
    nsresult found = core->MessageDB().GetOfflineAttemptForAction(
        attempt.folderId, attempt.operationKey, action, mozilla::Nothing(),
        saved);
    if (found == NS_ERROR_NOT_AVAILABLE) return NS_OK;
    MOZ_TRY(found);
    if (saved.state != OfflineAttemptState::Confirmed) return NS_OK;
    NS_ENSURE_TRUE(saved.operationId == attempt.operationId &&
                       saved.revision == attempt.revision &&
                       saved.transferSourceId == attempt.transferSourceId,
                   NS_ERROR_NOT_AVAILABLE);
  }
  QueuedSourceIdentity current;
  MOZ_TRY(core->MessageDB().GetQueuedSourceIdentity(
      attempt.folderId, attempt.operationKey, current));
  NS_ENSURE_TRUE(current.databaseSourceId == attempt.transferSourceId &&
                     current.operationId == attempt.operationId &&
                     current.revision == attempt.revision && current.source &&
                     attempt.source &&
                     current.source->folderId == attempt.source->folderId &&
                     current.source->key == attempt.source->key &&
                     current.source->epoch == attempt.source->epoch &&
                     current.source->uid == attempt.source->uid,
                 NS_ERROR_NOT_AVAILABLE);
  uint32_t epoch;
  MOZ_TRY(
      core->FolderDB().GetFolderUidValidity(current.source->folderId, epoch));
  NS_ENSURE_TRUE(epoch == current.source->epoch, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(core->MessageDB().RemoveOfflineOperation(attempt.folderId,
                                                   attempt.operationKey));
  removed = true;
  return NS_OK;
}
#endif

NS_IMPL_ISUPPORTS(nsImapOfflineSync, nsIUrlListener, nsIMsgCopyServiceListener,
                  nsIDBChangeListener)

nsImapOfflineSync::nsImapOfflineSync() {
  m_singleFolderToUpdate = nullptr;
  m_window = nullptr;
  mCurrentPlaybackOpType = nsIMsgOfflineImapOperation::kFlagsChanged;
  m_mailboxupdatesStarted = false;
  m_mailboxupdatesFinished = false;
  m_started = false;
  m_pseudoOffline = false;
  m_KeyIndex = 0;
  mCurrentUIDValidity = 0;
  m_listener = nullptr;
}

nsresult nsImapOfflineSync::Init(nsIMsgWindow* window, nsIUrlListener* listener,
                                 nsIMsgFolder* singleFolderOnly,
                                 bool isPseudoOffline) {
  m_window = window;
  m_listener = listener;
  m_singleFolderToUpdate = singleFolderOnly;
  m_pseudoOffline = isPseudoOffline;

  return NS_OK;
}

nsImapOfflineSync::~nsImapOfflineSync() {}

void nsImapOfflineSync::SetWindow(nsIMsgWindow* window) { m_window = window; }

NS_IMETHODIMP nsImapOfflineSync::OnStartRunningUrl(nsIURI* url) {
  return NS_OK;
}

NS_IMETHODIMP
nsImapOfflineSync::OnStopRunningUrl(nsIURI* url, nsresult exitCode) {
#ifdef MOZ_PANORAMA
  nsCOMPtr<nsIImapUrl> nativeImapUrl = do_QueryInterface(url);
  if (nativeImapUrl &&
      static_cast<nsImapUrl*>(nativeImapUrl.get())->CopyNativeReplayCommand()) {
    return mNativeReplay && mNativeReplayUrl == url
               ? CompleteNativeReplay(url, exitCode)
               : NS_OK;
  }
  if (nativeImapUrl &&
      static_cast<nsImapUrl*>(nativeImapUrl.get())->HasNativeFolderDelete()) {
    return mNativeFolderDelete && mNativeFolderDeleteUrl == url
               ? CompleteNativeFolderDelete(url, exitCode)
               : NS_OK;
  }
  if (nativeImapUrl && !static_cast<nsImapUrl*>(nativeImapUrl.get())
                            ->CopyNativeQueuedCopies()
                            .IsEmpty()) {
    return mNativeTransfer ? CompleteNativeTransfer(url, exitCode) : NS_OK;
  }
  if (nativeImapUrl && static_cast<nsImapUrl*>(nativeImapUrl.get())
                           ->CopyNativeQueuedAppendTarget()) {
    if (!mNativeAppend) return NS_OK;
    return CompleteNativeAppend(url, exitCode);
  }
#endif
#ifdef MOZ_PANORAMA
  if (mNativeAction && mNativeActionUrl == url)
    return CompleteNativeAction(url, exitCode);
#endif
  nsresult rv = exitCode;

  if (m_curTempFile) {
    m_curTempFile->Remove(false);
    m_curTempFile = nullptr;
  }

  bool isShuttingDown = false;
  nsCOMPtr<nsIAppStartup> appStartup(
      mozilla::components::AppStartup::Service());
  NS_ENSURE_TRUE(appStartup, NS_ERROR_FAILURE);
  appStartup->GetShuttingDown(&isShuttingDown);
  if (isShuttingDown) {
    if (m_listener) m_listener->OnStopRunningUrl(url, NS_BINDING_ABORTED);
    return NS_OK;
  }

  nsCOMPtr<nsIImapUrl> imapUrl = do_QueryInterface(url);

  if (imapUrl)
    nsImapProtocol::LogImapUrl(NS_SUCCEEDED(rv) ? "offline imap url succeeded "
                                                : "offline imap url failed ",
                               imapUrl);

#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup() &&
      NS_FAILED(exitCode)) {
    return FinishPlayback(url, exitCode);
  }
#endif

  // If we succeeded, or it was an imap move/copy that timed out, clear the
  // operation.
  bool moveCopy =
      mCurrentPlaybackOpType == nsIMsgOfflineImapOperation::kMsgCopy ||
      mCurrentPlaybackOpType == nsIMsgOfflineImapOperation::kMsgMoved;
  if (NS_SUCCEEDED(exitCode) || exitCode == NS_MSG_ERROR_IMAP_COMMAND_FAILED ||
      (moveCopy && exitCode == NS_ERROR_NET_TIMEOUT)) {
    ClearCurrentOps();
    rv = ProcessNextOperation();
  }
  // else if it's a non-stop error, and we're doing multiple folders,
  // go to the next folder.
  else if (!m_singleFolderToUpdate) {
    if (AdvanceToNextFolder())
      rv = ProcessNextOperation();
    else if (m_listener)
      m_listener->OnStopRunningUrl(url, rv);
  }

  return rv;
}

/**
 * Leaves m_currentServer at the next imap or local mail "server" that
 * might have offline events to playback, and m_folderQueue holding
 * a (reversed) list of all the folders to consider for that server.
 * If no more servers, m_currentServer will be left at nullptr and the
 * function returns false.
 */
bool nsImapOfflineSync::AdvanceToNextServer() {
  nsresult rv = NS_OK;

  if (m_allServers.IsEmpty()) {
    NS_ASSERTION(!m_currentServer, "this shouldn't be set");
    m_currentServer = nullptr;
    nsCOMPtr<nsIMsgAccountManager> accountManager =
        mozilla::components::AccountManager::Service();
    rv = accountManager->GetAllServers(m_allServers);
    NS_ENSURE_SUCCESS(rv, false);
  }
  size_t serverIndex = 0;
  if (m_currentServer) {
    serverIndex = m_allServers.IndexOf(m_currentServer);
    if (serverIndex == m_allServers.NoIndex) {
      serverIndex = 0;
    } else {
      // Move to the next server
      ++serverIndex;
    }
  }
  m_currentServer = nullptr;
  nsCOMPtr<nsIMsgFolder> rootFolder;

  while (serverIndex < m_allServers.Length()) {
    nsCOMPtr<nsIMsgIncomingServer> server(m_allServers[serverIndex]);
    serverIndex++;

    nsCOMPtr<nsINntpIncomingServer> newsServer = do_QueryInterface(server);
    if (newsServer)  // news servers aren't involved in offline imap
      continue;

    if (server) {
      m_currentServer = server;
      server->GetRootFolder(getter_AddRefs(rootFolder));
      if (rootFolder) {
        rv = rootFolder->GetDescendants(m_folderQueue);
        if (NS_SUCCEEDED(rv)) {
          if (!m_folderQueue.IsEmpty()) {
            // We'll be popping folders off the end as they are processed.
            m_folderQueue.Reverse();
            return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * Sets m_currentFolder to the next folder to process.
 *
 * @return  True if next folder to process was found, otherwise false.
 */
bool nsImapOfflineSync::AdvanceToNextFolder() {
  // we always start by changing flags
  mCurrentPlaybackOpType = nsIMsgOfflineImapOperation::kFlagsChanged;

  if (m_currentFolder) {
    m_currentFolder->SetMsgDatabase(nullptr);
    m_currentFolder = nullptr;
  }

  bool hasMore = false;
  if (m_currentServer) {
    hasMore = !m_folderQueue.IsEmpty();
  }
  if (!hasMore) {
    hasMore = AdvanceToNextServer();
  }
  if (hasMore) {
    m_currentFolder = m_folderQueue.PopLastElement();
  }
  ClearDB();
  return m_currentFolder;
}

void nsImapOfflineSync::AdvanceToFirstIMAPFolder() {
  m_currentServer = nullptr;
  nsCOMPtr<nsIMsgImapMailFolder> imapFolder;
  while (!imapFolder && AdvanceToNextFolder()) {
    imapFolder = do_QueryInterface(m_currentFolder);
  }
}

nsresult nsImapOfflineSync::ProcessFlagOperation(
    nsIMsgOfflineImapOperation* op) {
  nsCOMPtr<nsIMsgOfflineImapOperation> currentOp = op;
  nsTArray<nsMsgKey> matchingFlagKeys;
  uint32_t currentKeyIndex = m_KeyIndex;

  imapMessageFlagsType matchingFlags;
  currentOp->GetNewFlags(&matchingFlags);
  bool flagsMatch = true;
  do {  // loop for all messages with the same flags
    if (flagsMatch) {
      nsMsgKey curKey;
      currentOp->GetMessageKey(&curKey);
      matchingFlagKeys.AppendElement(curKey);
      currentOp->SetPlayingBack(true);
      m_currentOpsToClear.AppendObject(currentOp);
    }
    currentOp = nullptr;
    imapMessageFlagsType newFlags = kNoImapMsgFlag;
    imapMessageFlagsType flagOperation = kNoImapMsgFlag;
    if (++currentKeyIndex < m_CurrentKeys.Length())
      m_currentDB->GetOfflineOpForKey(m_CurrentKeys[currentKeyIndex], false,
                                      getter_AddRefs(currentOp));
    if (currentOp) {
      currentOp->GetFlagOperation(&flagOperation);
      currentOp->GetNewFlags(&newFlags);
    }
    flagsMatch = (flagOperation & nsIMsgOfflineImapOperation::kFlagsChanged) &&
                 (newFlags == matchingFlags);
  } while (currentOp);

  if (!matchingFlagKeys.IsEmpty()) {
    uint32_t curFolderFlags;
    m_currentFolder->GetFlags(&curFolderFlags);
    if (curFolderFlags & nsMsgFolderFlags::ImapBox) {
      nsresult rv = NS_OK;
      nsCOMPtr<nsIMsgImapMailFolder> imapFolder =
          do_QueryInterface(m_currentFolder);
      nsCOMPtr<nsIURI> uriToSetFlags;
      if (imapFolder) {
        rv = imapFolder->SetImapFlags(matchingFlagKeys, matchingFlags,
                                      getter_AddRefs(uriToSetFlags));
        if (NS_SUCCEEDED(rv) && uriToSetFlags) {
          nsCOMPtr<nsIMsgMailNewsUrl> mailnewsUrl =
              do_QueryInterface(uriToSetFlags);
          if (mailnewsUrl) {
            rv = mailnewsUrl->RegisterListener(this);
#ifdef MOZ_PANORAMA
            if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup())
              return rv;
#endif
          }
        }
#ifdef MOZ_PANORAMA
        if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup())
          return NS_FAILED(rv) ? rv : NS_ERROR_NOT_AVAILABLE;
#endif
      }
#ifdef MOZ_PANORAMA
      if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup())
        return NS_ERROR_NOT_AVAILABLE;
#endif
    }
#ifdef MOZ_PANORAMA
    if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup())
      return NS_ERROR_NOT_AVAILABLE;
#endif
  } else {
#ifdef MOZ_PANORAMA
    if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup())
      return ProcessNextOperation();
#endif
    ProcessNextOperation();
  }
  return NS_OK;
}

nsresult nsImapOfflineSync::ProcessKeywordOperation(
    nsIMsgOfflineImapOperation* op) {
  nsCOMPtr<nsIMsgOfflineImapOperation> currentOp = op;
  nsTArray<nsMsgKey> matchingKeywordKeys;
  uint32_t currentKeyIndex = m_KeyIndex;

  nsAutoCString keywords;
  if (mCurrentPlaybackOpType == nsIMsgOfflineImapOperation::kAddKeywords)
    currentOp->GetKeywordsToAdd(getter_Copies(keywords));
  else
    currentOp->GetKeywordsToRemove(getter_Copies(keywords));
  bool keywordsMatch = true;
  do {  // loop for all messages with the same keywords
    if (keywordsMatch) {
      nsMsgKey curKey;
      currentOp->GetMessageKey(&curKey);
      matchingKeywordKeys.AppendElement(curKey);
      currentOp->SetPlayingBack(true);
      m_currentOpsToClear.AppendObject(currentOp);
    }
    currentOp = nullptr;
    if (++currentKeyIndex < m_CurrentKeys.Length())
      m_currentDB->GetOfflineOpForKey(m_CurrentKeys[currentKeyIndex], false,
                                      getter_AddRefs(currentOp));
    if (currentOp) {
      nsAutoCString curOpKeywords;
      nsOfflineImapOperationType operation;
      currentOp->GetOperation(&operation);
      if (mCurrentPlaybackOpType == nsIMsgOfflineImapOperation::kAddKeywords)
        currentOp->GetKeywordsToAdd(getter_Copies(curOpKeywords));
      else
        currentOp->GetKeywordsToRemove(getter_Copies(curOpKeywords));
      keywordsMatch = (operation & mCurrentPlaybackOpType) &&
                      (curOpKeywords.Equals(keywords));
    }
  } while (currentOp);

  if (!matchingKeywordKeys.IsEmpty()) {
    uint32_t curFolderFlags;
    m_currentFolder->GetFlags(&curFolderFlags);

    if (curFolderFlags & nsMsgFolderFlags::ImapBox) {
      nsresult rv = NS_OK;
      nsCOMPtr<nsIMsgImapMailFolder> imapFolder =
          do_QueryInterface(m_currentFolder);
      nsCOMPtr<nsIURI> uriToStoreCustomKeywords;
      if (imapFolder) {
        rv = imapFolder->StoreCustomKeywords(
            m_window,
            (mCurrentPlaybackOpType == nsIMsgOfflineImapOperation::kAddKeywords)
                ? keywords
                : EmptyCString(),
            (mCurrentPlaybackOpType ==
             nsIMsgOfflineImapOperation::kRemoveKeywords)
                ? keywords
                : EmptyCString(),
            matchingKeywordKeys, getter_AddRefs(uriToStoreCustomKeywords));
        if (NS_SUCCEEDED(rv) && uriToStoreCustomKeywords) {
          nsCOMPtr<nsIMsgMailNewsUrl> mailnewsUrl =
              do_QueryInterface(uriToStoreCustomKeywords);
          if (mailnewsUrl) {
            rv = mailnewsUrl->RegisterListener(this);
#ifdef MOZ_PANORAMA
            if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup())
              return rv;
#endif
          }
        }
#ifdef MOZ_PANORAMA
        if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup())
          return NS_FAILED(rv) ? rv : NS_ERROR_NOT_AVAILABLE;
#endif
      }
#ifdef MOZ_PANORAMA
      if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup())
        return NS_ERROR_NOT_AVAILABLE;
#endif
    }
#ifdef MOZ_PANORAMA
    if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup())
      return NS_ERROR_NOT_AVAILABLE;
#endif
  } else {
#ifdef MOZ_PANORAMA
    if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup())
      return ProcessNextOperation();
#endif
    ProcessNextOperation();
  }
  return NS_OK;
}

#ifdef MOZ_PANORAMA
nsresult nsImapOfflineSync::ClearNativeAppend(nsIMsgOfflineImapOperation* op,
                                              uint32_t action) {
  mozilla::AutoRestore<bool> restoring(mNativeAppendCompleting);
  mNativeAppendCompleting = true;
  MOZ_TRY(op->SetPlayingBack(false));
  MOZ_TRY(op->ClearOperation(action));
  nsOfflineImapOperationType remaining;
  MOZ_TRY(op->GetOperation(&remaining));
  if (!remaining) MOZ_TRY(m_currentDB->RemoveOfflineOp(op));
  return NS_OK;
}

nsresult nsImapOfflineSync::HoldNativeReplay(nsresult status) {
  if (NS_FAILED(status) && NS_SUCCEEDED(m_firstPlaybackError))
    m_firstPlaybackError = status;
  ++m_KeyIndex;
  return ProcessNextOperation();
}

nsresult nsImapOfflineSync::ProcessNativeFolderDelete(
    nsIMsgOfflineImapOperation* op) {
  using namespace mozilla::mailnews;
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  NS_ENSURE_TRUE(core && op && !mNativeFolderDelete, NS_ERROR_NOT_AVAILABLE);
  uint64_t folder;
  nsMsgKey key;
  MOZ_TRY(m_currentFolder->GetId(&folder));
  MOZ_TRY(op->GetMessageKey(&key));
  OfflineAttempt attempt;
  nsresult rv = core->MessageDB().GetOfflineAttemptForAction(
      folder, key, nsIMsgOfflineImapOperation::kDeleteAllMsgs,
      mozilla::Nothing(), attempt);
  if (rv == NS_ERROR_NOT_AVAILABLE ||
      (NS_SUCCEEDED(rv) && attempt.state == OfflineAttemptState::Pending)) {
    uint64_t id;
    rv = core->MessageDB().BeginOfflineAction(
        folder, key, nsIMsgOfflineImapOperation::kDeleteAllMsgs,
        mozilla::Nothing(), mozilla::Nothing(), id);
    if (NS_SUCCEEDED(rv)) rv = core->MessageDB().GetOfflineAttempt(id, attempt);
  } else if (NS_SUCCEEDED(rv) &&
             attempt.state != OfflineAttemptState::Confirmed) {
    // A previous process may have sent all or part of empty-trash. No repeated
    // DELETE/STORE/EXPUNGE is permitted from an uncertain saved receipt.
    return HoldNativeReplay(NS_ERROR_NOT_AVAILABLE);
  }
  if (NS_FAILED(rv)) return HoldNativeReplay(rv);
  bool refresh = attempt.state == OfflineAttemptState::Confirmed;
  return StartNativeFolderDelete(attempt, refresh);
}

nsresult nsImapOfflineSync::StartNativeFolderDelete(
    const mozilla::mailnews::OfflineAttempt& attempt, bool refresh) {
  using namespace mozilla::mailnews;
  NS_ENSURE_TRUE(!mNativeFolderDelete, NS_ERROR_IN_PROGRESS);
  mNativeFolderDelete = mozilla::MakeUnique<OfflineAttempt>(attempt);
  mNativeFolderRefreshing = refresh;
  uint64_t serial = ++mNativeFolderSerial;
  nsCOMPtr<nsIImapService> service = mozilla::components::Imap::Service();
  nsresult rv =
      static_cast<nsImapService*>(service.get())
          ->ReplayOfflineFolderDelete(m_currentFolder, this, attempt, refresh,
                                      getter_AddRefs(mNativeFolderDeleteUrl));
  if (serial != mNativeFolderSerial) return rv;
  if (NS_FAILED(rv)) {
    if (!refresh) {
      RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
      if (core) (void)core->MessageDB().MarkOfflineAttemptAmbiguous(attempt.id);
    }
    mNativeFolderDelete = nullptr;
    mNativeFolderDeleteUrl = nullptr;
    ++mNativeFolderSerial;
    return HoldNativeReplay(rv);
  }
  return NS_OK;
}

nsresult nsImapOfflineSync::CompleteNativeFolderDelete(nsIURI* url,
                                                       nsresult status) {
  using namespace mozilla::mailnews;
  RefPtr<nsImapOfflineSync> self(this);
  nsCOMPtr<nsIMsgFolder> folder = m_currentFolder;
  auto attempt = std::move(mNativeFolderDelete);
  bool refresh = mNativeFolderRefreshing;
  mNativeFolderDeleteUrl = nullptr;
  ++mNativeFolderSerial;
  NS_ENSURE_TRUE(attempt, NS_ERROR_NOT_AVAILABLE);
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  NS_ENSURE_TRUE(core, NS_ERROR_NOT_AVAILABLE);
  if (!refresh) {
    nsCOMPtr<nsIImapUrl> imap = do_QueryInterface(url);
    bool acknowledged =
        imap &&
        static_cast<nsImapUrl*>(imap.get())->NativeFolderDeleteAcknowledged();
    nsresult recorded =
        acknowledged
            ? core->MessageDB().ConfirmOfflineAttempt(attempt->id,
                                                      mozilla::Nothing())
            : core->MessageDB().MarkOfflineAttemptAmbiguous(attempt->id);
    if (NS_SUCCEEDED(status) && !acknowledged) status = NS_ERROR_NOT_AVAILABLE;
    if (NS_SUCCEEDED(status) && NS_FAILED(recorded)) status = recorded;
    if (NS_FAILED(status)) return HoldNativeReplay(status);
    OfflineAttempt actual;
    nsresult rv = core->MessageDB().GetOfflineAttempt(attempt->id, actual);
    if (NS_FAILED(rv)) return HoldNativeReplay(rv);
    // Reconcile the current server membership normally. Messages that arrived
    // after the acknowledged empty-trash must not be deleted locally.
    return StartNativeFolderDelete(actual, true);
  }
  if (NS_FAILED(status)) return HoldNativeReplay(status);
  OfflineAttempt actual;
  nsresult rv = core->MessageDB().GetOfflineAttempt(attempt->id, actual);
  if (NS_SUCCEEDED(rv) && (actual.state != OfflineAttemptState::Confirmed ||
                           actual.operationId != attempt->operationId ||
                           actual.revision != attempt->revision ||
                           actual.folderEpoch != attempt->folderEpoch))
    rv = NS_ERROR_NOT_AVAILABLE;
  nsCOMPtr<nsIMsgOfflineImapOperation> op;
  if (NS_SUCCEEDED(rv))
    rv = m_currentDB->GetOfflineOpForKey(actual.operationKey, false,
                                         getter_AddRefs(op));
  if (NS_SUCCEEDED(rv) && !op) rv = NS_ERROR_NOT_AVAILABLE;
  if (NS_SUCCEEDED(rv)) {
    mozilla::AutoRestore<bool> guard(mNativeReplayCompleting);
    mNativeReplayCompleting = true;
    rv = ClearNativeAppend(op, nsIMsgOfflineImapOperation::kDeleteAllMsgs);
  }
  return HoldNativeReplay(rv);
}

nsresult nsImapOfflineSync::ProcessNativeFlags(nsIMsgOfflineImapOperation* op) {
  using namespace mozilla::mailnews;
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  NS_ENSURE_TRUE(core && op && !mNativeReplay, NS_ERROR_NOT_AVAILABLE);
  uint64_t folder;
  nsMsgKey key;
  MOZ_TRY(m_currentFolder->GetId(&folder));
  MOZ_TRY(op->GetMessageKey(&key));
  OfflineAttempt attempt;
  nsresult rv = core->MessageDB().GetOfflineAttemptForAction(
      folder, key, nsIMsgOfflineImapOperation::kFlagsChanged,
      mozilla::Nothing(), attempt);
  if (rv == NS_ERROR_NOT_AVAILABLE ||
      (NS_SUCCEEDED(rv) && attempt.state == OfflineAttemptState::Pending)) {
    uint64_t id;
    rv = core->MessageDB().BeginOfflineAction(
        folder, key, nsIMsgOfflineImapOperation::kFlagsChanged,
        mozilla::Nothing(), mozilla::Nothing(), id);
    if (NS_SUCCEEDED(rv)) rv = core->MessageDB().GetOfflineAttempt(id, attempt);
  }
  if (NS_FAILED(rv)) return HoldNativeReplay(rv);
  return ContinueNativeFlags(std::move(attempt));
}

nsresult nsImapOfflineSync::ContinueNativeFlags(
    mozilla::mailnews::OfflineAttempt attempt) {
  using namespace mozilla::mailnews;
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  NS_ENSURE_TRUE(core, NS_ERROR_NOT_AVAILABLE);
  if (attempt.state != OfflineAttemptState::Confirmed) {
    if (attempt.replayVersion != 1 || !attempt.flagMutation)
      return HoldNativeReplay(NS_ERROR_NOT_AVAILABLE);
    for (auto command :
         {OfflineReplayCommand::FlagSet, OfflineReplayCommand::FlagClear}) {
      const auto& progress = command == OfflineReplayCommand::FlagSet
                                 ? attempt.flagSet
                                 : attempt.flagClear;
      if (!progress ||
          progress->state == OfflineReplayCommandState::Acknowledged)
        continue;
      if (progress->state == OfflineReplayCommandState::Sent ||
          progress->state == OfflineReplayCommandState::Ambiguous)
        return HoldNativeReplay(NS_ERROR_NOT_AVAILABLE);
      return DispatchNativeReplay(attempt, command);
    }
    nsresult rv =
        core->MessageDB().ConfirmOfflineAttempt(attempt.id, mozilla::Nothing());
    if (NS_FAILED(rv)) return HoldNativeReplay(rv);
    rv = core->MessageDB().GetOfflineAttempt(attempt.id, attempt);
    if (NS_FAILED(rv)) return HoldNativeReplay(rv);
  }
  bool removed;
  nsresult rv = RemoveCompletedNativeActions(core, attempt, removed);
  return HoldNativeReplay(rv);
}

nsresult nsImapOfflineSync::ContinueNativeMove(
    mozilla::mailnews::OfflineAttempt attempt) {
  using namespace mozilla::mailnews;
  RefPtr<nsImapOfflineSync> self(this);
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  if (!core || !m_currentFolder)
    return HoldNativeReplay(NS_ERROR_NOT_AVAILABLE);
  if (attempt.replayVersion != 1 || !attempt.confirmedUid ||
      attempt.state != OfflineAttemptState::Confirmed)
    return HoldNativeReplay(NS_ERROR_NOT_AVAILABLE);
  if (!attempt.moveSourcePlan) {
    // Single-folder pseudo-offline playback does not initialize
    // m_currentServer.
    nsCOMPtr<nsIMsgIncomingServer> incomingServer;
    nsresult rv = m_currentFolder->GetServer(getter_AddRefs(incomingServer));
    if (NS_FAILED(rv)) return HoldNativeReplay(rv);
    nsCOMPtr<nsIImapIncomingServer> server = do_QueryInterface(incomingServer);
    if (!server) return HoldNativeReplay(NS_ERROR_NOT_AVAILABLE);
    eIMAPCapabilityFlags capabilities = kCapabilityUndefined;
    nsMsgImapDeleteModel model;
    rv = server->GetCapability(&capabilities);
    if (NS_FAILED(rv)) return HoldNativeReplay(rv);
    rv = server->GetDeleteModel(&model);
    if (NS_FAILED(rv)) return HoldNativeReplay(rv);
    if (capabilities == kCapabilityUndefined)
      return HoldNativeReplay(NS_ERROR_NOT_AVAILABLE);
    bool uidplus = capabilities & kUidplusCapability;
    bool expunge =
        mozilla::Preferences::GetBool("mail.imap.expunge_after_delete", false);
    OfflineMoveSourcePlan plan;
    if (expunge)
      plan.expunge =
          uidplus ? OfflineMoveExpunge::Uid : OfflineMoveExpunge::Mailbox;
    else if (model != nsMsgImapDeleteModels::IMAPDelete && uidplus)
      plan.expunge = OfflineMoveExpunge::Uid;
    OfflineAttempt planned;
    rv = core->MessageDB().PlanOfflineMoveSource(attempt, plan, planned);
    if (NS_FAILED(rv)) return HoldNativeReplay(rv);
    attempt = std::move(planned);
  }
  for (bool store : {true, false}) {
    const auto& progress = store ? attempt.sourceStore : attempt.sourceExpunge;
    if (!progress || progress->state == OfflineReplayCommandState::Acknowledged)
      continue;
    if (progress->state == OfflineReplayCommandState::Sent ||
        progress->state == OfflineReplayCommandState::Ambiguous)
      return HoldNativeReplay(NS_ERROR_NOT_AVAILABLE);
    auto command = store ? OfflineReplayCommand::MoveStore
                   : attempt.moveSourcePlan->expunge == OfflineMoveExpunge::Uid
                       ? OfflineReplayCommand::MoveUidExpunge
                       : OfflineReplayCommand::MoveExpunge;
    return DispatchNativeReplay(attempt, command);
  }
  OfflineMoveSettlement settlement;
  nsresult rv;
  {
    // The native output is filled before removal callbacks. Keep this object
    // and its original folder alive and refuse same-object playback reentry.
    nsCOMPtr<nsIMsgFolder> folder = m_currentFolder;
    mozilla::AutoRestore<bool> guard(mNativeReplayCompleting);
    mNativeReplayCompleting = true;
    rv = core->MessageDB().SettleOfflineMove(attempt, settlement);
  }
  return HoldNativeReplay(rv);
}

nsresult nsImapOfflineSync::DispatchNativeReplay(
    const mozilla::mailnews::OfflineAttempt& attempt,
    mozilla::mailnews::OfflineReplayCommand command) {
  using namespace mozilla::mailnews;
  NS_ENSURE_TRUE(!mNativeReplay, NS_ERROR_IN_PROGRESS);
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  NS_ENSURE_TRUE(core, NS_ERROR_NOT_AVAILABLE);
  OfflineReplayCommandToken token;
  nsresult rv =
      core->MessageDB().BeginOfflineReplayCommand(attempt, command, token);
  if (NS_FAILED(rv)) return HoldNativeReplay(rv);
  mNativeReplay = mozilla::MakeUnique<OfflineReplayCommandToken>(token);
  uint64_t serial = ++mNativeReplaySerial;
  nsCOMPtr<nsIImapService> service = mozilla::components::Imap::Service();
  rv = static_cast<nsImapService*>(service.get())
           ->ReplayOfflineCommand(m_currentFolder, this, token,
                                  getter_AddRefs(mNativeReplayUrl));
  // Completion can synchronously dispatch another URL. Its output belongs to
  // that new command, even if the allocator reused a previous object address.
  if (serial != mNativeReplaySerial) return rv;
  if (NS_FAILED(rv)) {
    auto receipt = mNativeReplayUrl ? OfflineReplayReceipt::Ambiguous
                                    : OfflineReplayReceipt::RejectedNoEffect;
    (void)core->MessageDB().RecordOfflineReplayCommand(token, receipt, rv);
    mNativeReplay = nullptr;
    mNativeReplayUrl = nullptr;
    ++mNativeReplaySerial;
    return HoldNativeReplay(rv);
  }
  return NS_OK;
}

nsresult nsImapOfflineSync::CompleteNativeReplay(nsIURI* url, nsresult status) {
  using namespace mozilla::mailnews;
  RefPtr<nsImapOfflineSync> self(this);
  auto token = std::move(mNativeReplay);
  mNativeReplayUrl = nullptr;
  ++mNativeReplaySerial;
  NS_ENSURE_TRUE(token, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIImapUrl> imap = do_QueryInterface(url);
  NS_ENSURE_TRUE(imap, NS_ERROR_NOT_AVAILABLE);
  auto receipt = static_cast<nsImapUrl*>(imap.get())->CopyNativeReplayReceipt();
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  NS_ENSURE_TRUE(core, NS_ERROR_NOT_AVAILABLE);
  auto outcome = receipt ? receipt->outcome : OfflineReplayReceipt::Ambiguous;
  nsresult wire = receipt             ? receipt->status
                  : NS_FAILED(status) ? status
                                      : NS_ERROR_NOT_AVAILABLE;
  nsresult recorded =
      core->MessageDB().RecordOfflineReplayCommand(*token, outcome, wire);
  // Save a real wire acknowledgement even if later local completion failed.
  // A disk failure leaves Sent fenced and never authorizes another send.
  if (NS_FAILED(wire)) status = wire;
  if (NS_SUCCEEDED(status) && NS_FAILED(recorded)) status = recorded;
  if (NS_FAILED(status)) return HoldNativeReplay(status);
  OfflineAttempt actual;
  nsresult rv = core->MessageDB().GetOfflineAttempt(token->attempt.id, actual);
  if (NS_FAILED(rv)) return HoldNativeReplay(rv);
  return token->command == OfflineReplayCommand::FlagSet ||
                 token->command == OfflineReplayCommand::FlagClear
             ? ContinueNativeFlags(std::move(actual))
             : ContinueNativeMove(std::move(actual));
}

nsresult nsImapOfflineSync::ProcessNativeAction(nsIMsgOfflineImapOperation* op,
                                                uint32_t action) {
  using namespace mozilla::mailnews;
  NS_ENSURE_TRUE(!mNativeAction && op, NS_ERROR_IN_PROGRESS);
  if (action == nsIMsgOfflineImapOperation::kFlagsChanged)
    return ProcessNativeFlags(op);
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  NS_ENSURE_TRUE(core, NS_ERROR_NOT_AVAILABLE);
  uint64_t folderId;
  nsMsgKey key;
  MOZ_TRY(m_currentFolder->GetId(&folderId));
  MOZ_TRY(op->GetMessageKey(&key));
  uint64_t id;
  MOZ_TRY(core->MessageDB().BeginOfflineAction(
      folderId, key, action, mozilla::Nothing(), mozilla::Nothing(), id));
  auto attempt = mozilla::MakeUnique<OfflineAttempt>();
  MOZ_TRY(core->MessageDB().GetOfflineAttempt(id, *attempt));
  NS_ENSURE_TRUE(attempt->source, NS_ERROR_NOT_AVAILABLE);
  OfflineOperationData payload;
  MOZ_TRY(core->MessageDB().GetOfflineOperation(folderId, key, payload));
  nsAutoCString uid;
  uid.AppendInt(attempt->source->uid);
  mNativeAction = std::move(attempt);
  nsCOMPtr<nsIImapService> service = mozilla::components::Imap::Service();
  nsresult rv;
  {
    rv = service->StoreCustomKeywords(
        m_currentFolder, m_window,
        action == nsIMsgOfflineImapOperation::kAddKeywords
            ? payload.keywordsToAdd
            : EmptyCString(),
        action == nsIMsgOfflineImapOperation::kRemoveKeywords
            ? payload.keywordsToRemove
            : EmptyCString(),
        uid, getter_AddRefs(mNativeActionUrl));
    if (NS_SUCCEEDED(rv) && mNativeActionUrl) {
      nsCOMPtr<nsIMsgMailNewsUrl> news = do_QueryInterface(mNativeActionUrl);
      rv = news ? news->RegisterListener(this) : NS_ERROR_NOT_AVAILABLE;
    }
  }
  if (NS_SUCCEEDED(rv) && !mNativeActionUrl) rv = NS_ERROR_NOT_AVAILABLE;
  if (NS_FAILED(rv)) {
    (void)core->MessageDB().MarkOfflineAttemptAmbiguous(id);
    mNativeAction = nullptr;
    mNativeActionUrl = nullptr;
  }
  return rv;
}

nsresult nsImapOfflineSync::CompleteNativeAction(nsIURI* url, nsresult status) {
  auto attempt = std::move(mNativeAction);
  mNativeActionUrl = nullptr;
  NS_ENSURE_TRUE(attempt, NS_ERROR_NOT_AVAILABLE);
  RefPtr<nsImapOfflineSync> self(this);
  RefPtr<mozilla::mailnews::DatabaseCore> core =
      mozilla::mailnews::DatabaseCore::GetInstanceForService();
  NS_ENSURE_TRUE(core, NS_ERROR_NOT_AVAILABLE);
  nsresult settled =
      NS_SUCCEEDED(status)
          ? core->MessageDB().ConfirmOfflineAttempt(attempt->id,
                                                    mozilla::Nothing())
          : core->MessageDB().MarkOfflineAttemptAmbiguous(attempt->id);
  if (NS_SUCCEEDED(status)) status = settled;
  if (NS_SUCCEEDED(status)) {
    mozilla::mailnews::OfflineAttempt confirmed;
    nsresult cleanup =
        core->MessageDB().GetOfflineAttempt(attempt->id, confirmed);
    bool removed;
    if (NS_SUCCEEDED(cleanup))
      cleanup = RemoveCompletedNativeActions(core, confirmed, removed);
    if (NS_FAILED(cleanup)) return FinishPlayback(url, cleanup);
  }
  if (NS_FAILED(status) && NS_SUCCEEDED(m_firstPlaybackError))
    m_firstPlaybackError = status;
  ++m_KeyIndex;
  return ProcessNextOperation();
}

nsresult nsImapOfflineSync::ProcessNativeTransfer(
    nsIMsgOfflineImapOperation* op, uint32_t action) {
  using namespace mozilla::mailnews;
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  NS_ENSURE_TRUE(core && op && m_currentFolder && !mNativeTransfer,
                 NS_ERROR_NOT_AVAILABLE);
  uint64_t folderId;
  MOZ_TRY(m_currentFolder->GetId(&folderId));
  nsMsgKey key;
  MOZ_TRY(op->GetMessageKey(&key));
  OfflineOperationData payload;
  MOZ_TRY(core->MessageDB().GetOfflineOperation(folderId, key, payload));
  bool copy = action == nsIMsgOfflineImapOperation::kMsgCopy;
  uint32_t count = copy ? payload.copyDestinations.Length() : 1;
  NS_ENSURE_TRUE(!copy || payload.copyDestinationBindings.Length() == count,
                 NS_ERROR_NOT_AVAILABLE);
  for (uint32_t index = 0; index < count; ++index) {
    mozilla::Maybe<uint32_t> ordinal =
        copy ? mozilla::Some(index) : mozilla::Nothing();
    OfflineAttempt previous;
    nsresult found = core->MessageDB().GetOfflineAttemptForAction(
        folderId, key, action, ordinal, previous);
    if (NS_SUCCEEDED(found) && previous.state != OfflineAttemptState::Pending) {
      if (!copy && previous.state == OfflineAttemptState::Confirmed)
        return ContinueNativeMove(std::move(previous));
      if (!copy && previous.transferAccepted && !previous.confirmedUid &&
          NS_SUCCEEDED(m_firstPlaybackError))
        m_firstPlaybackError = NS_ERROR_NOT_AVAILABLE;
      if (previous.transferAccepted && !previous.confirmedUid) {
        nsresult validated =
            core->MessageDB().ValidateOfflineCopyAcceptedWithoutUid(previous);
        if (NS_FAILED(validated) && NS_SUCCEEDED(m_firstPlaybackError))
          m_firstPlaybackError = validated;
      }
      // Preserve uncertainty/known effect and its entire frozen payload. The
      // next ordinal/action is independent; this one is never sent again.
      if ((previous.state == OfflineAttemptState::Sent ||
           previous.state == OfflineAttemptState::Ambiguous) &&
          !previous.transferAccepted && NS_SUCCEEDED(m_firstPlaybackError))
        m_firstPlaybackError = NS_ERROR_NOT_AVAILABLE;
      continue;
    }
    NS_ENSURE_TRUE(NS_SUCCEEDED(found) || found == NS_ERROR_NOT_AVAILABLE,
                   found);
    auto destination = copy ? payload.copyDestinationBindings[index]
                            : payload.pendingDestination;
    NS_ENSURE_TRUE(destination, NS_ERROR_NOT_AVAILABLE);
    const nsCString& uri =
        copy ? payload.copyDestinations[index] : payload.destinationFolderURI;
    nsCOMPtr<nsIFolderLookupService> folders =
        do_GetService(NS_FOLDERLOOKUPSERVICE_CONTRACTID);
    NS_ENSURE_STATE(folders);
    nsCOMPtr<nsIMsgFolder> target;
    MOZ_TRY(folders->GetFolderForURL(uri, getter_AddRefs(target)));
    NS_ENSURE_TRUE(target && DestFolderOnSameServer(target),
                   NS_ERROR_NOT_AVAILABLE);
    uint64_t targetId;
    MOZ_TRY(target->GetId(&targetId));
    NS_ENSURE_TRUE(targetId == destination->folderId, NS_ERROR_NOT_AVAILABLE);
    if (!destination->epochKnown) {
      uint32_t observed;
      nsresult epoch =
          core->FolderDB().GetFolderUidValidity(targetId, observed);
      if (NS_SUCCEEDED(epoch)) {
        QueuedSourceIdentity identity;
        MOZ_TRY(
            core->MessageDB().GetQueuedSourceIdentity(folderId, key, identity));
        MOZ_TRY(core->MessageDB().ObserveOfflineDestinationEpoch(
            identity, action, ordinal, *destination, observed));
        destination->epoch = observed;
        destination->epochKnown = true;
      } else {
        NS_ENSURE_TRUE(epoch == NS_ERROR_NOT_AVAILABLE, epoch);
      }
    }
    uint64_t id;
    MOZ_TRY(core->MessageDB().BeginOfflineAction(folderId, key, action,
                                                 destination, ordinal, id));
    auto attempt = mozilla::MakeUnique<OfflineAttempt>();
    MOZ_TRY(core->MessageDB().GetOfflineAttempt(id, *attempt));
    NS_ENSURE_TRUE(attempt->source && attempt->destination,
                   NS_ERROR_NOT_AVAILABLE);
    RefPtr<nsImapMailCopyState> state = new nsImapMailCopyState();
    state->m_nativeQueuedCopies.AppendElement(*attempt);
    nsAutoCString uid;
    uid.AppendInt(attempt->source->uid);
    mNativeTransfer = std::move(attempt);
    nsCOMPtr<nsIImapService> service = mozilla::components::Imap::Service();
    nsCOMPtr<nsIURI> url;
    nsresult started =
        service->OnlineMessageCopy(m_currentFolder, uid, target, true, !copy,
                                   this, getter_AddRefs(url), state, m_window);
    if (NS_FAILED(started) && mNativeTransfer) {
      // A launch error does not prove no send; retain the fence and first
      // error.
      (void)core->MessageDB().MarkOfflineAttemptAmbiguous(mNativeTransfer->id);
      mNativeTransfer = nullptr;
    }
    return started;
  }
  ++m_KeyIndex;
  return ProcessNextOperation();
}

nsresult nsImapOfflineSync::CompleteNativeTransfer(nsIURI* url,
                                                   nsresult status) {
  using namespace mozilla::mailnews;
  auto target = std::move(mNativeTransfer);
  NS_ENSURE_TRUE(target, NS_ERROR_NOT_AVAILABLE);
  RefPtr<nsImapOfflineSync> self(this);
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  NS_ENSURE_TRUE(core, NS_ERROR_NOT_AVAILABLE);
  OfflineAttempt actual;
  nsresult read = core->MessageDB().GetOfflineAttempt(target->id, actual);
  if (NS_SUCCEEDED(status) && NS_FAILED(read)) status = read;
  if (NS_SUCCEEDED(read) && !actual.transferAccepted && !actual.confirmedUid) {
    nsresult ambiguous =
        core->MessageDB().MarkOfflineAttemptAmbiguous(actual.id);
    if (NS_SUCCEEDED(status))
      status = NS_FAILED(ambiguous) ? ambiguous : NS_ERROR_NOT_AVAILABLE;
  }
  if (target->operation == nsIMsgOfflineImapOperation::kMsgMoved) {
    if (NS_SUCCEEDED(status) && actual.confirmedUid)
      return ContinueNativeMove(std::move(actual));
    if (NS_SUCCEEDED(status)) status = NS_ERROR_NOT_AVAILABLE;
    ++m_KeyIndex;
  }
  if (NS_FAILED(status) && NS_SUCCEEDED(m_firstPlaybackError))
    m_firstPlaybackError = status;
  return ProcessNextOperation();
}

nsresult nsImapOfflineSync::ProcessNativeAppend(nsIMsgOfflineImapOperation* op,
                                                uint32_t action) {
  using namespace mozilla::mailnews;
  NS_ENSURE_FALSE(mNativeAppend, NS_ERROR_IN_PROGRESS);
  nsMsgKey key;
  MOZ_TRY(op->GetMessageKey(&key));
  uint64_t folderId;
  MOZ_TRY(m_currentFolder->GetId(&folderId));
  nsCOMPtr<nsIMsgDBHdr> header;
  MOZ_TRY(m_currentDB->GetMsgHdrForKey(key, getter_AddRefs(header)));
  NS_ENSURE_TRUE(header, NS_ERROR_NOT_AVAILABLE);
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  NS_ENSURE_TRUE(core, NS_ERROR_NOT_AVAILABLE);
  auto& db = core->MessageDB();
  OfflineOperationData payload;
  MOZ_TRY(db.GetOfflineOperation(folderId, key, payload));
  NS_ENSURE_TRUE(payload.operation & action, NS_ERROR_NOT_AVAILABLE);
  OfflineAttempt prior;
  nsresult lookup = db.GetCurrentOfflineAttempt(folderId, key, prior);
  if (NS_SUCCEEDED(lookup)) {
    NS_ENSURE_TRUE(prior.operation == action, NS_ERROR_NOT_AVAILABLE);
    if (prior.appendAccepted) {
      MOZ_TRY(db.ValidateOfflineAppendAcceptedWithoutUid(prior));
      return ProcessNextOperation();
    }
    if (prior.state == OfflineAttemptState::Confirmed) {
      MOZ_TRY(ClearNativeAppend(op, action));
      return ProcessNextOperation();
    }
    NS_ENSURE_TRUE(prior.state == OfflineAttemptState::Pending,
                   NS_ERROR_NOT_AVAILABLE);
  } else {
    NS_ENSURE_TRUE(lookup == NS_ERROR_NOT_AVAILABLE, lookup);
  }
  auto target = mozilla::MakeUnique<NativeQueuedAppendTarget>();
  MOZ_TRY(db.GetMessageBodyState(key, target->body));
  NS_ENSURE_TRUE(target->body.folderId == folderId && target->body.storeToken &&
                     (target->body.flags & nsMsgMessageFlags::Offline),
                 NS_ERROR_NOT_AVAILABLE);
  nsCString source;
  MOZ_TRY(core->GetSourceId(source));
  NS_ENSURE_TRUE(source.Equals(target->body.databaseSourceId),
                 NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIDBFolderInfo> info;
  MOZ_TRY(m_currentDB->GetDBFolderInfo(getter_AddRefs(info)));
  MOZ_TRY(info->GetImapUidValidity(&target->epoch));
  NS_ENSURE_TRUE(target->epoch && target->epoch == GetCurrentUIDValidity(),
                 NS_ERROR_NOT_AVAILABLE);
  nsCString uri;
  MOZ_TRY(m_currentFolder->GetURI(uri));
  NS_ENSURE_TRUE(payload.destinationFolderURI.Equals(uri),
                 NS_ERROR_NOT_AVAILABLE);

  nsCOMPtr<nsIFile> temporary;
  MOZ_TRY(GetSpecialDirectoryWithFileName(NS_OS_TEMP_DIR, "nscpmsg.txt",
                                          getter_AddRefs(temporary)));
  MOZ_TRY(temporary->CreateUnique(nsIFile::NORMAL_FILE_TYPE, 00600));
  auto removeTemporary =
      mozilla::MakeScopeExit([&] { temporary->Remove(false); });
  nsCOMPtr<nsIInputStream> input;
  MOZ_TRY(m_currentFolder->GetMsgInputStream(header, getter_AddRefs(input)));
  auto closeInput = mozilla::MakeScopeExit([&] { input->Close(); });
  nsCOMPtr<nsIOutputStream> output;
  MOZ_TRY(MsgNewBufferedFileOutputStream(getter_AddRefs(output), temporary,
                                         PR_WRONLY | PR_CREATE_FILE, 00600));
  uint64_t copied = 0;
  nsresult result = SyncCopyStream(input, output, copied, FILE_IO_BUFFER_SIZE);
  nsresult inputClose = input->Close();
  closeInput.release();
  nsresult outputClose = output->Close();
  MOZ_TRY(result);
  MOZ_TRY(inputClose);
  MOZ_TRY(outputClose);
  NS_ENSURE_TRUE(copied == target->body.offlineMessageSize,
                 NS_ERROR_NOT_AVAILABLE);
  MessageBodyState afterRead;
  MOZ_TRY(db.GetMessageBodyState(key, afterRead));
  NS_ENSURE_TRUE(
      afterRead.databaseSourceId.Equals(target->body.databaseSourceId) &&
          afterRead.folderId == target->body.folderId &&
          afterRead.storeToken == target->body.storeToken &&
          afterRead.contentRevision == target->body.contentRevision &&
          afterRead.locationRevision == target->body.locationRevision,
      NS_ERROR_NOT_AVAILABLE);
  uint64_t attemptId;
  MOZ_TRY(db.BeginOfflineAttempt(
      folderId, key, action,
      mozilla::Some(PendingDestination{folderId, key, target->epoch}),
      attemptId, &target->body));
  MOZ_TRY(db.GetOfflineAttempt(attemptId, target->attempt));
  RefPtr<nsImapMailCopyState> state = new nsImapMailCopyState();
  state->m_messages.AppendElement(header);
  state->m_nativeQueuedAppend =
      mozilla::MakeUnique<NativeQueuedAppendTarget>(*target);
  mNativeAppend = std::move(target);
  mNativeAppendOp = op;
  m_curTempFile = temporary;
  removeTemporary.release();
  nsCOMPtr<nsIImapService> service = mozilla::components::Imap::Service();
  result = service ? service->AppendMessageFromFile(temporary, m_currentFolder,
                                                    EmptyCString(), true, true,
                                                    this, state, m_window)
                   : NS_ERROR_NOT_AVAILABLE;
  if (NS_FAILED(result)) {
    // A failed launcher may have begun network work. Retain the attempt fence,
    // and let our caller finish the playback exactly once with the first error.
    (void)db.MarkOfflineAttemptAmbiguous(attemptId);
    mNativeAppend = nullptr;
    mNativeAppendOp = nullptr;
    m_curTempFile->Remove(false);
    m_curTempFile = nullptr;
    return result;
  }
  return NS_OK;
}

nsresult nsImapOfflineSync::CompleteNativeAppend(nsIURI* url, nsresult status) {
  using namespace mozilla::mailnews;
  auto target = std::move(mNativeAppend);
  nsCOMPtr<nsIMsgOfflineImapOperation> op = mNativeAppendOp.forget();
  NS_ENSURE_TRUE(target && op, NS_ERROR_NOT_AVAILABLE);
  if (m_curTempFile) {
    m_curTempFile->Remove(false);
    m_curTempFile = nullptr;
  }
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  nsresult result = status;
  nsresult settlement = [&]() -> nsresult {
    NS_ENSURE_TRUE(core && m_currentDB && m_currentFolder,
                   NS_ERROR_NOT_AVAILABLE);
    nsCString source;
    MOZ_TRY(core->GetSourceId(source));
    NS_ENSURE_TRUE(source.Equals(target->body.databaseSourceId),
                   NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsIImapUrl> acknowledgedUrl = do_QueryInterface(url);
    auto receipt = acknowledgedUrl
                       ? static_cast<nsImapUrl*>(acknowledgedUrl.get())
                             ->CopyNativeQueuedAppendReceipt()
                       : mozilla::Nothing();
    if (receipt && !receipt->destination) {
      // Durable acknowledgement is independent of later current-body
      // settlement.
      MOZ_TRY(core->MessageDB().RecordOfflineAppendAcceptedWithoutUid(
          target->attempt));
      MOZ_TRY(core->MessageDB().ValidateOfflineAppendAcceptedWithoutUid(
          target->attempt));
      MOZ_TRY(status);
      return NS_OK;
    }
    OfflineAttempt actual;
    MOZ_TRY(core->MessageDB().GetCurrentOfflineAttempt(
        target->body.folderId, target->body.key, actual));
    NS_ENSURE_TRUE(actual.id == target->attempt.id &&
                       actual.operationId == target->attempt.operationId &&
                       actual.revision == target->attempt.revision,
                   NS_ERROR_NOT_AVAILABLE);
    if (actual.state != OfflineAttemptState::Confirmed) {
      nsCOMPtr<nsIImapUrl> imapUrl = do_QueryInterface(url);
      bool rejected =
          imapUrl &&
          static_cast<nsImapUrl*>(imapUrl.get())->NativeQueuedAppendRejected();
      nsresult fence =
          rejected
              ? core->MessageDB().ResolveOfflineAttemptNotApplied(actual.id)
              : core->MessageDB().MarkOfflineAttemptAmbiguous(actual.id);
      MOZ_TRY(fence);
      return NS_FAILED(status) ? status : NS_ERROR_NOT_AVAILABLE;
    }
    MOZ_TRY(status);
    NS_ENSURE_TRUE(actual.destination && actual.confirmedUid &&
                       actual.destination->folderId == target->body.folderId &&
                       actual.destination->key == target->body.key &&
                       actual.destination->epoch == target->epoch &&
                       GetCurrentUIDValidity() == target->epoch,
                   NS_ERROR_NOT_AVAILABLE);
    return ClearNativeAppend(op, target->attempt.operation);
  }();
  if (NS_SUCCEEDED(result)) result = settlement;
  if (NS_FAILED(result)) return FinishPlayback(url, result);
  return ProcessNextOperation();
}
#endif

// XXX This should not be void but return an error to indicate which low
// level routine failed.
void nsImapOfflineSync::ProcessAppendMsgOperation(
    nsIMsgOfflineImapOperation* currentOp, int32_t opType) {
  nsMsgKey msgKey;
  currentOp->GetMessageKey(&msgKey);
  nsCOMPtr<nsIMsgDBHdr> mailHdr;
  nsresult rv = m_currentDB->GetMsgHdrForKey(msgKey, getter_AddRefs(mailHdr));
  if (NS_FAILED(rv) || !mailHdr) {
    m_currentDB->RemoveOfflineOp(currentOp);
    ProcessNextOperation();
    return;
  }

  nsCOMPtr<nsIFile> tmpFile;

  if (NS_WARN_IF(NS_FAILED(GetSpecialDirectoryWithFileName(
          NS_OS_TEMP_DIR, "nscpmsg.txt", getter_AddRefs(tmpFile)))))
    return;

  if (NS_WARN_IF(
          NS_FAILED(tmpFile->CreateUnique(nsIFile::NORMAL_FILE_TYPE, 00600))))
    return;

  nsCOMPtr<nsIOutputStream> outputStream;
  rv = MsgNewBufferedFileOutputStream(getter_AddRefs(outputStream), tmpFile,
                                      PR_WRONLY | PR_CREATE_FILE, 00600);
  if (NS_WARN_IF(NS_FAILED(rv) || !outputStream)) return;

  // We break out of the loop to get to the clean-up code.
  bool setPlayingBack = false;
  do {
    nsCString moveDestination;
    currentOp->GetDestinationFolderURI(moveDestination);

    nsCOMPtr<nsIMsgFolder> destFolder;
    rv = GetOrCreateFolder(moveDestination, getter_AddRefs(destFolder));
    if (NS_WARN_IF(NS_FAILED(rv))) break;

    nsCOMPtr<nsIInputStream> inStream;
    rv = destFolder->GetMsgInputStream(mailHdr, getter_AddRefs(inStream));
    if (NS_WARN_IF((NS_FAILED(rv)))) break;

    // From this point onwards, we need to set "playing back".
    setPlayingBack = true;

    // Copy the dest folder offline store msg to the temp file.
    uint64_t bytesCopied;
    rv = SyncCopyStream(inStream, outputStream, bytesCopied,
                        FILE_IO_BUFFER_SIZE);

    // rv could have an error from Read/Write.
    nsresult rv2 = outputStream->Close();
    if (NS_FAILED(rv2)) {
      NS_WARNING("ouputStream->Close() failed");
    }
    outputStream = nullptr;  // Don't try to close it again below.

    // rv: Read/Write, rv2: Close
    if (NS_FAILED(rv) || NS_FAILED(rv2)) {
      // This Remove() will fail under Windows if the output stream
      // fails to close above.
      (void)NS_WARN_IF(NS_FAILED(tmpFile->Remove(false)));
      break;
    }

    nsCOMPtr<nsIFile> cloneTmpFile;
    // clone the tmp file to defeat nsIFile's stat/size caching.
    tmpFile->Clone(getter_AddRefs(cloneTmpFile));
    m_curTempFile = cloneTmpFile;
    nsCOMPtr<nsIMsgCopyService> copyService =
        mozilla::components::Copy::Service();

    // CopyFileMessage returns error async to this->OnStopCopy
    // if copyService is null, let's crash here and now.
    rv = copyService->CopyFileMessage(cloneTmpFile, destFolder,
                                      nullptr,  // nsIMsgDBHdr* msgToReplace
                                      true,     // isDraftOrTemplate
                                      0,        // new msg flags
                                      EmptyCString(), this, m_window);
    MOZ_ASSERT(NS_SUCCEEDED(rv),
               "CopyFileMessage() failed. Fatal. Error in call setup?");
  } while (false);

  if (setPlayingBack) {
    currentOp->SetPlayingBack(true);
    m_currentOpsToClear.AppendObject(currentOp);
    m_currentDB->DeleteHeader(mailHdr, nullptr, true, true);
  }

  // Close the output stream if it's not already closed.
  if (outputStream) {
    (void)NS_WARN_IF(NS_FAILED(outputStream->Close()));
  }
}

void nsImapOfflineSync::ClearCurrentOps() {
  int32_t opCount = m_currentOpsToClear.Count();
  for (int32_t i = opCount - 1; i >= 0; i--) {
    m_currentOpsToClear[i]->SetPlayingBack(false);
    m_currentOpsToClear[i]->ClearOperation(mCurrentPlaybackOpType);
    m_currentOpsToClear.RemoveObjectAt(i);
  }
}

void nsImapOfflineSync::ProcessMoveOperation(nsIMsgOfflineImapOperation* op) {
  nsTArray<nsMsgKey> srcKeys;
  uint32_t currentKeyIndex = m_KeyIndex;
  nsCString moveDestination;
  op->GetDestinationFolderURI(moveDestination);
  bool moveMatches = true;
  nsCOMPtr<nsIMsgOfflineImapOperation> currentOp = op;
  do {  // loop for all messages with the same destination
    if (moveMatches) {
      nsMsgKey curKey;
      currentOp->GetMessageKey(&curKey);
      srcKeys.AppendElement(curKey);
      currentOp->SetPlayingBack(true);
      m_currentOpsToClear.AppendObject(currentOp);
    }
    currentOp = nullptr;

    if (++currentKeyIndex < m_CurrentKeys.Length()) {
      nsCString nextDestination;
      nsresult rv = m_currentDB->GetOfflineOpForKey(
          m_CurrentKeys[currentKeyIndex], false, getter_AddRefs(currentOp));
      moveMatches = false;
      if (NS_SUCCEEDED(rv) && currentOp) {
        nsOfflineImapOperationType opType;
        currentOp->GetOperation(&opType);
        if (opType & nsIMsgOfflineImapOperation::kMsgMoved) {
          currentOp->GetDestinationFolderURI(nextDestination);
          moveMatches = moveDestination.Equals(nextDestination);
        }
      }
    }
  } while (currentOp);

  nsCOMPtr<nsIMsgFolder> destFolder;
  FindFolder(moveDestination, getter_AddRefs(destFolder));
  // if the dest folder doesn't really exist, these operations are
  // going to fail, so clear them out and move on.
  if (!destFolder) {
    NS_WARNING("trying to playing back move to non-existent folder");
    ClearCurrentOps();
    ProcessNextOperation();
    return;
  }
  nsCOMPtr<nsIMsgImapMailFolder> imapFolder =
      do_QueryInterface(m_currentFolder);
  if (imapFolder && DestFolderOnSameServer(destFolder)) {
    nsresult launch = imapFolder->ReplayOfflineMoveCopy(
        srcKeys, true, destFolder, this, m_window);
    (void)launch;
#ifdef MOZ_PANORAMA
    if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup() &&
        NS_FAILED(launch)) {
      (void)FinishPlayback(nullptr, launch);
      return;
    }
#endif
  } else {
    // NOTE: Is this dead code?
    // The source messages have already been removed from the database,
    // so there should be no way this ever did anything...
    // Leaving it here for now, but treat it with skepticism.
    nsresult rv;
    nsTArray<RefPtr<nsIMsgDBHdr>> messages;
    for (nsMsgKey srcKey : srcKeys) {
      nsCOMPtr<nsIMsgDBHdr> mailHdr = nullptr;
      rv = m_currentFolder->GetMessageHeader(srcKey, getter_AddRefs(mailHdr));
      if (NS_SUCCEEDED(rv) && mailHdr) {
        uint32_t msgSize;
        // in case of a move, the header has already been deleted,
        // so we've really got a fake header. We need to get its flags and
        // size from the offline op to have any chance of doing the move.
        mailHdr->GetMessageSize(&msgSize);
        if (!msgSize) {
          imapMessageFlagsType newImapFlags;
          uint32_t msgFlags = 0;
          op->GetMsgSize(&msgSize);
          op->GetNewFlags(&newImapFlags);
          // first three bits are the same
          msgFlags |= (newImapFlags & 0x07);
          if (newImapFlags & kImapMsgForwardedFlag)
            msgFlags |= nsMsgMessageFlags::Forwarded;
          mailHdr->SetFlags(msgFlags);
          mailHdr->SetMessageSize(msgSize);
        }
        messages.AppendElement(mailHdr);
      }
    }
    nsCOMPtr<nsIMsgCopyService> copyService =
        mozilla::components::Copy::Service();
    copyService->CopyMessages(m_currentFolder, messages, destFolder, true, this,
                              m_window, false);
  }
}

// I'm tempted to make this a method on nsIMsgFolder, but that interface
// is already so huge, and there are only a few places in the code that do this.
// If there end up to be more places that need this, then we can reconsider.
bool nsImapOfflineSync::DestFolderOnSameServer(nsIMsgFolder* destFolder) {
  nsCOMPtr<nsIMsgIncomingServer> srcServer;
  nsCOMPtr<nsIMsgIncomingServer> dstServer;

  bool sameServer = false;
  if (NS_SUCCEEDED(m_currentFolder->GetServer(getter_AddRefs(srcServer))) &&
      NS_SUCCEEDED(destFolder->GetServer(getter_AddRefs(dstServer))))
    dstServer->Equals(srcServer, &sameServer);
  return sameServer;
}

void nsImapOfflineSync::ProcessCopyOperation(
    nsIMsgOfflineImapOperation* aCurrentOp) {
  nsCOMPtr<nsIMsgOfflineImapOperation> currentOp = aCurrentOp;

  nsTArray<nsMsgKey> matchingFlagKeys;
  uint32_t currentKeyIndex = m_KeyIndex;
  nsCString copyDestination;
  currentOp->GetCopyDestination(0, getter_Copies(copyDestination));
  bool copyMatches = true;
  nsresult rv;

  do {  // loop for all messages with the same destination
    if (copyMatches) {
      nsMsgKey curKey;
      currentOp->GetMessageKey(&curKey);
      matchingFlagKeys.AppendElement(curKey);
      currentOp->SetPlayingBack(true);
      m_currentOpsToClear.AppendObject(currentOp);
    }
    currentOp = nullptr;

    if (++currentKeyIndex < m_CurrentKeys.Length()) {
      nsCString nextDestination;
      rv = m_currentDB->GetOfflineOpForKey(m_CurrentKeys[currentKeyIndex],
                                           false, getter_AddRefs(currentOp));
      copyMatches = false;
      if (NS_SUCCEEDED(rv) && currentOp) {
        nsOfflineImapOperationType opType;
        currentOp->GetOperation(&opType);
        if (opType & nsIMsgOfflineImapOperation::kMsgCopy) {
          currentOp->GetCopyDestination(0, getter_Copies(nextDestination));
          copyMatches = copyDestination.Equals(nextDestination);
        }
      }
    }
  } while (currentOp);

  nsCOMPtr<nsIMsgFolder> destFolder;
  FindFolder(copyDestination, getter_AddRefs(destFolder));
  // if the dest folder doesn't really exist, these operations are
  // going to fail, so clear them out and move on.
  if (!destFolder) {
    NS_ERROR("trying to playing back copy to non-existent folder");
    ClearCurrentOps();
    ProcessNextOperation();
    return;
  }
  nsCOMPtr<nsIMsgImapMailFolder> imapFolder =
      do_QueryInterface(m_currentFolder);
  if (imapFolder && DestFolderOnSameServer(destFolder)) {
    rv = imapFolder->ReplayOfflineMoveCopy(matchingFlagKeys, false, destFolder,
                                           this, m_window);
#ifdef MOZ_PANORAMA
    if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup() &&
        NS_FAILED(rv)) {
      (void)FinishPlayback(nullptr, rv);
      return;
    }
#endif
  } else {
    nsTArray<RefPtr<nsIMsgDBHdr>> messages;
    for (uint32_t keyIndex = 0; keyIndex < matchingFlagKeys.Length();
         keyIndex++) {
      nsCOMPtr<nsIMsgDBHdr> mailHdr = nullptr;
      rv = m_currentFolder->GetMessageHeader(
          matchingFlagKeys.ElementAt(keyIndex), getter_AddRefs(mailHdr));
      if (NS_SUCCEEDED(rv) && mailHdr) messages.AppendElement(mailHdr);
    }
    nsCOMPtr<nsIMsgCopyService> copyService =
        mozilla::components::Copy::Service();
    copyService->CopyMessages(m_currentFolder, messages, destFolder, false,
                              this, m_window, false);
  }
}

void nsImapOfflineSync::ProcessEmptyTrash() {
  m_currentFolder->EmptyTrash(this);
  ClearDB();  // EmptyTrash closes and deletes the trash db.
}

ImapUid nsImapOfflineSync::GetCurrentUIDValidity() {
  if (m_currentFolder) {
    nsCOMPtr<nsIImapMailFolderSink> imapFolderSink =
        do_QueryInterface(m_currentFolder);
    if (imapFolderSink) imapFolderSink->GetUidValidity(&mCurrentUIDValidity);
  }
  return mCurrentUIDValidity;
}

/**
 * Playing back offline operations is one giant state machine that runs through
 * ProcessNextOperation.
 */
nsresult nsImapOfflineSync::ProcessNextOperation() {
#ifdef MOZ_PANORAMA
  if (mNativeReplayCompleting) return NS_ERROR_IN_PROGRESS;
#endif
#ifdef MOZ_PANORAMA
  if (mNativeAppend || mNativeAppendCompleting || mNativeTransfer ||
      mNativeAction || mNativeReplay || mNativeFolderDelete)
    return NS_ERROR_IN_PROGRESS;
#endif
  nsresult rv = NS_OK;

  // Some annoying hoop-jumping for historical reasons.
  // See https://bugzilla.mozilla.org/show_bug.cgi?id=2060778 for cleaning
  // this up.
  if (!m_started) {
    if (m_singleFolderToUpdate) {
      if (!m_pseudoOffline) {
        AdvanceToFirstIMAPFolder();
      }
    } else {
      m_currentServer = nullptr;
      AdvanceToNextFolder();
    }
    m_started = true;
  }

  // if updating one folder only, restore m_currentFolder to that folder
  if (m_singleFolderToUpdate) m_currentFolder = m_singleFolderToUpdate;

  uint32_t folderFlags = 0;
  if (m_currentFolder) {
    nsresult flags = m_currentFolder->GetFlags(&folderFlags);
    if (NS_FAILED(flags)) return FinishPlayback(nullptr, flags);
  }
  nsCOMPtr<nsIDBFolderInfo> folderInfo;
  while (m_currentFolder && !m_currentDB) {
    m_currentFolder->GetFlags(&folderFlags);
    bool inspectIntents = folderFlags & nsMsgFolderFlags::OfflineEvents;
#ifdef MOZ_PANORAMA
    if (!inspectIntents && !m_mailboxupdatesStarted && !m_pseudoOffline &&
        (folderFlags & nsMsgFolderFlags::ImapBox) &&
        mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
      // OfflineEvents selects dispatchable work for ordinary UpdateFolder.
      // Explicit playback must also inspect retained uncertainty and report
      // it without resending. Do not turn that custody back into an auto-send.
      RefPtr<mozilla::mailnews::DatabaseCore> core =
          mozilla::mailnews::DatabaseCore::GetInstanceForService();
      if (!core) return FinishPlayback(nullptr, NS_ERROR_NOT_AVAILABLE);
      uint64_t folderId;
      nsresult identity = m_currentFolder->GetId(&folderId);
      if (NS_FAILED(identity)) return FinishPlayback(nullptr, identity);
      nsTArray<nsMsgKey> retained;
      nsresult found =
          core->MessageDB().ListOfflineOperations(folderId, false, retained);
      if (NS_FAILED(found)) return FinishPlayback(nullptr, found);
      constexpr uint32_t actions = nsIMsgOfflineImapOperation::kFlagsChanged |
                                   nsIMsgOfflineImapOperation::kAddKeywords |
                                   nsIMsgOfflineImapOperation::kRemoveKeywords |
                                   nsIMsgOfflineImapOperation::kMsgCopy |
                                   nsIMsgOfflineImapOperation::kMsgMoved |
                                   nsIMsgOfflineImapOperation::kAppendDraft |
                                   nsIMsgOfflineImapOperation::kAppendTemplate |
                                   nsIMsgOfflineImapOperation::kDeleteAllMsgs;
      for (nsMsgKey key : retained) {
        mozilla::mailnews::OfflineOperationData payload;
        found = core->MessageDB().GetOfflineOperation(folderId, key, payload);
        if (NS_FAILED(found)) return FinishPlayback(nullptr, found);
        // Counterpart and inactive Undo/Redo custody are not server intents.
        if (payload.operation & actions) {
          inspectIntents = true;
          break;
        }
      }
    }
#endif
    if (inspectIntents) {
      nsCOMPtr<nsIMsgDatabase> db;
      rv = m_currentFolder->GetDBFolderInfoAndDB(getter_AddRefs(folderInfo),
                                                 getter_AddRefs(db));
#ifdef MOZ_PANORAMA
      if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup() &&
          (NS_FAILED(rv) || !db || !folderInfo))
        return FinishPlayback(nullptr,
                              NS_FAILED(rv) ? rv : NS_ERROR_NOT_AVAILABLE);
#endif
      if (db) {
        m_currentDB = do_QueryInterface(db, &rv);
#ifdef MOZ_PANORAMA
        if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup() &&
            (NS_FAILED(rv) || !m_currentDB))
          return FinishPlayback(nullptr,
                                NS_FAILED(rv) ? rv : NS_ERROR_NOT_AVAILABLE);
#endif
        m_currentDB->AddListener(this);
      }
    }

    if (m_currentDB) {
      m_CurrentKeys.Clear();
      m_KeyIndex = 0;
      if (NS_FAILED(m_currentDB->ListAllOfflineOpIds(m_CurrentKeys)) ||
          m_CurrentKeys.IsEmpty()) {
        rv = UpdateOfflineEventsFlag(m_currentFolder, m_currentDB);
        if (NS_FAILED(rv)) return FinishPlayback(nullptr, rv);
        ClearDB();
        folderInfo = nullptr;  // can't hold onto folderInfo longer than db
      } else {
        // trash any ghost msgs
        bool deletedGhostMsgs = false;
        for (uint32_t fakeIndex = 0; fakeIndex < m_CurrentKeys.Length();
             fakeIndex++) {
          nsCOMPtr<nsIMsgOfflineImapOperation> currentOp;
          rv = m_currentDB->GetOfflineOpForKey(m_CurrentKeys[fakeIndex], false,
                                               getter_AddRefs(currentOp));
#ifdef MOZ_PANORAMA
          if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup() &&
              NS_FAILED(rv))
            return FinishPlayback(nullptr, rv);
#endif
          if (currentOp) {
            nsOfflineImapOperationType opType;
            rv = currentOp->GetOperation(&opType);
#ifdef MOZ_PANORAMA
            if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
              if (NS_FAILED(rv)) return FinishPlayback(nullptr, rv);
              // Canceled recovery has no server action. Clean its operation
              // record before LiteSelect's epoch gate; a never-selected target
              // has no durable epoch yet. Physical rows and bodies stay owned
              // by native Redo, which validates any later reactivation.
              if (!opType) {
                rv = m_currentDB->RemoveOfflineOp(currentOp);
                if (NS_FAILED(rv)) return FinishPlayback(nullptr, rv);
                continue;
              }
            }
#endif

            // kMoveResult op holds the source folder URI and the source
            // msgKey.
            if (opType == nsIMsgOfflineImapOperation::kMoveResult
#ifdef MOZ_PANORAMA
                && !mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()
#endif
            ) {
              // Get the destination msgKey.
              nsMsgKey curKey;
              currentOp->GetMessageKey(&curKey);
              m_currentDB->RemoveOfflineOp(currentOp);
              deletedGhostMsgs = true;

              // Remember the pseudo headers before we delete them,
              // and when we download new headers, tell listeners about the
              // message key change between the pseudo headers and the real
              // downloaded headers. Note that we're not currently sending
              // a msgsDeleted notification for these headers, but the
              // db listeners are notified about the deletion.
              // for imap folders, we should adjust the pending counts, because
              // we have a header that we know about, but don't have in the db.
              nsCOMPtr<nsIMsgImapMailFolder> imapFolder =
                  do_QueryInterface(m_currentFolder);
              if (imapFolder) {
                bool hdrIsRead;
                m_currentDB->IsRead(curKey, &hdrIsRead);
                imapFolder->ChangePendingTotal(1);
                if (!hdrIsRead) imapFolder->ChangePendingUnread(1);
                imapFolder->AddMoveResultPseudoKey(curKey);
              }
              m_currentDB->DeleteMessage(curKey, nullptr, false);
            }
          }
        }

        if (deletedGhostMsgs) m_currentFolder->SummaryChanged();

        m_CurrentKeys.Clear();
        if (NS_FAILED(m_currentDB->ListAllOfflineOpIds(m_CurrentKeys)) ||
            m_CurrentKeys.IsEmpty()) {
          rv = UpdateOfflineEventsFlag(m_currentFolder, m_currentDB);
          if (NS_FAILED(rv)) return FinishPlayback(nullptr, rv);
          ClearDB();
        } else if (folderFlags & nsMsgFolderFlags::ImapBox) {
          // if pseudo offline, falls through to playing ops back.
          if (!m_pseudoOffline) {
            // there are operations to playback so check uid validity
            SetCurrentUIDValidity(0);  // force initial invalid state

            // Call LiteSelectFolder() to select the current folder without
            // kicking off a full syncing operation.
            nsCOMPtr<nsIImapService> imapService =
                mozilla::components::Imap::Service();
            nsCOMPtr<nsIURI> unusedUri;
            // Passing this as UrlListener, so our OnStopRunningUrl() will be
            // called when this completes.
            return imapService->LiteSelectFolder(
                m_currentFolder, this, m_window, getter_AddRefs(unusedUri));
          }
        }
      }
    }

    if (!m_currentDB) {
      // only advance if we are doing all folders
      if (!m_singleFolderToUpdate)
        AdvanceToNextFolder();
      else
        m_currentFolder = nullptr;  // force update of this folder now.
    }
  }

  if (m_currentFolder) m_currentFolder->GetFlags(&folderFlags);
  // do the current operation
  if (m_currentDB) {
    bool currentFolderFinished = false;
    if (!folderInfo) m_currentDB->GetDBFolderInfo(getter_AddRefs(folderInfo));
    // user canceled the lite select! if GetCurrentUIDValidity() == 0
    bool nativeActionScan = false;
#ifdef MOZ_PANORAMA
    nativeActionScan = mozilla::StaticPrefs::mail_panorama_enabled_AtStartup();
#endif
    if (folderInfo &&
        (m_KeyIndex < m_CurrentKeys.Length() || nativeActionScan) &&
        (m_pseudoOffline || (GetCurrentUIDValidity() != 0) ||
         !(folderFlags & nsMsgFolderFlags::ImapBox))) {
#ifdef MOZ_PANORAMA
      if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup() &&
          GetCurrentUIDValidity()) {
        nsCOMPtr<nsIMsgImapMailFolder> imap =
            do_QueryInterface(m_currentFolder);
        NS_ENSURE_TRUE(imap, NS_ERROR_NOT_AVAILABLE);
        nsresult observed =
            static_cast<nsImapMailFolder*>(m_currentFolder.get())
                ->ObserveNativeQueuedDestinations(GetCurrentUIDValidity());
        if (NS_FAILED(observed)) return FinishPlayback(nullptr, observed);
      }
#endif
      ImapUid curFolderUidValidity = 0;
      nsresult validityRv =
          folderInfo->GetImapUidValidity(&curFolderUidValidity);
      bool uidvalidityChanged =
          (!m_pseudoOffline && folderFlags & nsMsgFolderFlags::ImapBox) &&
          (GetCurrentUIDValidity() != curFolderUidValidity);
#ifdef MOZ_PANORAMA
      if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup() &&
          (NS_FAILED(validityRv) || uidvalidityChanged)) {
        return FinishPlayback(nullptr, NS_FAILED(validityRv)
                                           ? validityRv
                                           : NS_ERROR_NOT_AVAILABLE);
      }
#endif
      nsCOMPtr<nsIMsgOfflineImapOperation> currentOp;
      if (uidvalidityChanged)
        DeleteAllOfflineOpsForCurrentDB();
      else if (m_KeyIndex < m_CurrentKeys.Length())
        m_currentDB->GetOfflineOpForKey(m_CurrentKeys[m_KeyIndex], false,
                                        getter_AddRefs(currentOp));

      bool nativePlayback = false;
#ifdef MOZ_PANORAMA
      nativePlayback = mozilla::StaticPrefs::mail_panorama_enabled_AtStartup();
      if (nativePlayback) {
        using namespace mozilla::mailnews;
        RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
        NS_ENSURE_TRUE(core, NS_ERROR_NOT_AVAILABLE);
        uint64_t folderId;
        MOZ_TRY(m_currentFolder->GetId(&folderId));
        // Advance across missing/completed and accepted recovery records while
        // retaining each operation identity. Reaching the end still advances
        // the playback action, so later action types are not dropped.
        for (; m_KeyIndex < m_CurrentKeys.Length(); ++m_KeyIndex) {
          currentOp = nullptr;
          MOZ_TRY(m_currentDB->GetOfflineOpForKey(
              m_CurrentKeys[m_KeyIndex], false, getter_AddRefs(currentOp)));
          if (!currentOp) continue;
          bool held;
          nsresult hold = core->MessageDB().IsOfflineImportHeld(
              folderId, m_CurrentKeys[m_KeyIndex], held);
          if (NS_FAILED(hold)) return FinishPlayback(nullptr, hold);
          if (held) {
            // Keep the imported row and report uncertainty without blocking
            // later dispatchable keys or action types in this folder.
            if (NS_SUCCEEDED(m_firstPlaybackError))
              m_firstPlaybackError = NS_ERROR_NOT_AVAILABLE;
            currentOp = nullptr;
            continue;
          }
          nsOfflineImapOperationType dispatchable;
          MOZ_TRY(currentOp->GetOperation(&dispatchable));
          if (!dispatchable) {
            MOZ_TRY(m_currentDB->RemoveOfflineOp(currentOp));
            currentOp = nullptr;
            continue;
          }
          OfflineAttempt attempt;
          nsresult found = core->MessageDB().GetCurrentOfflineAttempt(
              folderId, m_CurrentKeys[m_KeyIndex], attempt);
          if (NS_SUCCEEDED(found) && attempt.appendAccepted) {
            nsresult validated =
                core->MessageDB().ValidateOfflineAppendAcceptedWithoutUid(
                    attempt);
            // An observed binding does not grant a replay receipt. Complete
            // the original listener on this refusal or any validation error.
            if (NS_FAILED(validated)) return FinishPlayback(nullptr, validated);
            dispatchable &= ~attempt.operation;
          } else {
            NS_ENSURE_TRUE(
                NS_SUCCEEDED(found) || found == NS_ERROR_NOT_AVAILABLE, found);
          }
          if (dispatchable & mCurrentPlaybackOpType &&
              (mCurrentPlaybackOpType ==
                   nsIMsgOfflineImapOperation::kFlagsChanged ||
               mCurrentPlaybackOpType ==
                   nsIMsgOfflineImapOperation::kAddKeywords ||
               mCurrentPlaybackOpType ==
                   nsIMsgOfflineImapOperation::kRemoveKeywords)) {
            OfflineAttempt action;
            nsresult actionRead = core->MessageDB().GetOfflineAttemptForAction(
                folderId, m_CurrentKeys[m_KeyIndex], mCurrentPlaybackOpType,
                mozilla::Nothing(), action);
            NS_ENSURE_TRUE(NS_SUCCEEDED(actionRead) ||
                               actionRead == NS_ERROR_NOT_AVAILABLE,
                           actionRead);
            if (NS_SUCCEEDED(actionRead) &&
                action.state == OfflineAttemptState::Confirmed) {
              bool removed;
              nsresult cleanup =
                  RemoveCompletedNativeActions(core, action, removed);
              if (NS_FAILED(cleanup)) return FinishPlayback(nullptr, cleanup);
              if (removed) {
                currentOp = nullptr;
                continue;
              }
            }
            if (NS_SUCCEEDED(actionRead) &&
                action.state != OfflineAttemptState::Pending) {
              bool replayFlags =
                  mCurrentPlaybackOpType ==
                      nsIMsgOfflineImapOperation::kFlagsChanged &&
                  action.replayVersion == 1 &&
                  action.state != OfflineAttemptState::Confirmed;
              if (!replayFlags) {
                dispatchable &= ~mCurrentPlaybackOpType;
                if (action.state != OfflineAttemptState::Confirmed &&
                    NS_SUCCEEDED(m_firstPlaybackError))
                  m_firstPlaybackError = NS_ERROR_NOT_AVAILABLE;
              }
            }
          }
          if (dispatchable & mCurrentPlaybackOpType) break;
          currentOp = nullptr;
        }
      }
#endif
      if (currentOp || nativePlayback) {
        nsOfflineImapOperationType opType = 0;
        if (currentOp) currentOp->GetOperation(&opType);
        // loop until we find the next db record that matches the current
        // playback operation
        while (currentOp && !(opType & mCurrentPlaybackOpType)) {
          // remove operations with no type.
          if (!opType) m_currentDB->RemoveOfflineOp(currentOp);
          currentOp = nullptr;
          ++m_KeyIndex;
          if (m_KeyIndex < m_CurrentKeys.Length())
            m_currentDB->GetOfflineOpForKey(m_CurrentKeys[m_KeyIndex], false,
                                            getter_AddRefs(currentOp));
          if (currentOp) currentOp->GetOperation(&opType);
        }
        // if we did not find a db record that matches the current playback
        // operation, then move to the next playback operation and recurse.
        if (!currentOp) {
          int32_t nextOp = 0;
          switch (mCurrentPlaybackOpType) {
            case nsIMsgOfflineImapOperation::kFlagsChanged:
              nextOp = nsIMsgOfflineImapOperation::kAddKeywords;
              break;
            case nsIMsgOfflineImapOperation::kAddKeywords:
              nextOp = nsIMsgOfflineImapOperation::kRemoveKeywords;
              break;
            case nsIMsgOfflineImapOperation::kRemoveKeywords:
              nextOp = nsIMsgOfflineImapOperation::kMsgCopy;
              break;
            case nsIMsgOfflineImapOperation::kMsgCopy:
              nextOp = nsIMsgOfflineImapOperation::kMsgMoved;
              break;
            case nsIMsgOfflineImapOperation::kMsgMoved:
              nextOp = nsIMsgOfflineImapOperation::kAppendDraft;
              break;
            case nsIMsgOfflineImapOperation::kAppendDraft:
              nextOp = nsIMsgOfflineImapOperation::kAppendTemplate;
              break;
            case nsIMsgOfflineImapOperation::kAppendTemplate:
              nextOp = nsIMsgOfflineImapOperation::kDeleteAllMsgs;
              break;
            default:
              break;
          }
          if (nextOp) {
            mCurrentPlaybackOpType = nextOp;
            m_KeyIndex = 0;
#ifdef MOZ_PANORAMA
            if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup())
              return ProcessNextOperation();
#endif
            ProcessNextOperation();
          } else {
#ifdef MOZ_PANORAMA
            if (!mozilla::StaticPrefs::mail_panorama_enabled_AtStartup())
#endif
              DeleteAllOfflineOpsForCurrentDB();
            currentFolderFinished = true;
          }
        } else {
#ifdef MOZ_PANORAMA
          if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup() &&
              mCurrentPlaybackOpType ==
                  nsIMsgOfflineImapOperation::kDeleteAllMsgs) {
            rv = ProcessNativeFolderDelete(currentOp);
            return NS_FAILED(rv) ? FinishPlayback(nullptr, rv) : rv;
          }
          if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup() &&
              (mCurrentPlaybackOpType == nsIMsgOfflineImapOperation::kMsgCopy ||
               mCurrentPlaybackOpType ==
                   nsIMsgOfflineImapOperation::kMsgMoved)) {
            rv = ProcessNativeTransfer(currentOp, mCurrentPlaybackOpType);
            return NS_FAILED(rv) ? FinishPlayback(nullptr, rv) : rv;
          }
          if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup() &&
              (mCurrentPlaybackOpType ==
                   nsIMsgOfflineImapOperation::kAppendDraft ||
               mCurrentPlaybackOpType ==
                   nsIMsgOfflineImapOperation::kAppendTemplate)) {
            rv = ProcessNativeAppend(currentOp, mCurrentPlaybackOpType);
            return NS_FAILED(rv) ? FinishPlayback(nullptr, rv) : rv;
          }
          if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup() &&
              (mCurrentPlaybackOpType ==
                   nsIMsgOfflineImapOperation::kFlagsChanged ||
               mCurrentPlaybackOpType ==
                   nsIMsgOfflineImapOperation::kAddKeywords ||
               mCurrentPlaybackOpType ==
                   nsIMsgOfflineImapOperation::kRemoveKeywords)) {
            rv = ProcessNativeAction(currentOp, mCurrentPlaybackOpType);
            return NS_FAILED(rv) ? FinishPlayback(nullptr, rv) : rv;
          }
#endif
          switch (mCurrentPlaybackOpType) {
            case nsIMsgOfflineImapOperation::kFlagsChanged:
              ProcessFlagOperation(currentOp);
              break;
            case nsIMsgOfflineImapOperation::kAddKeywords:
            case nsIMsgOfflineImapOperation::kRemoveKeywords:
              ProcessKeywordOperation(currentOp);
              break;
            case nsIMsgOfflineImapOperation::kMsgCopy:
              ProcessCopyOperation(currentOp);
              break;
            case nsIMsgOfflineImapOperation::kMsgMoved:
              ProcessMoveOperation(currentOp);
              break;
            case nsIMsgOfflineImapOperation::kAppendDraft:
              ProcessAppendMsgOperation(
                  currentOp, nsIMsgOfflineImapOperation::kAppendDraft);
              break;
            case nsIMsgOfflineImapOperation::kAppendTemplate:
              ProcessAppendMsgOperation(
                  currentOp, nsIMsgOfflineImapOperation::kAppendTemplate);
              break;
            case nsIMsgOfflineImapOperation::kDeleteAllMsgs:
              // empty trash is going to delete the db, so we'd better release
              // the reference to the offline operation first.
              currentOp = nullptr;
              ProcessEmptyTrash();
              break;
            default:
              NS_WARNING("invalid playback op type");
              break;
          }
        }
      } else
        currentFolderFinished = true;
    } else
      currentFolderFinished = true;

    if (currentFolderFinished) {
      rv = UpdateOfflineEventsFlag(m_currentFolder, m_currentDB);
      if (NS_FAILED(rv)) return FinishPlayback(nullptr, rv);
      ClearDB();
      if (!m_singleFolderToUpdate) {
        AdvanceToNextFolder();
        ProcessNextOperation();
        return NS_OK;
      }
      m_currentFolder = nullptr;
    }
  }

  if (!m_currentFolder && !m_mailboxupdatesStarted) {
    m_mailboxupdatesStarted = true;

    // if we are updating more than one folder then we need the iterator
    if (!m_singleFolderToUpdate) {
      m_currentServer = nullptr;
      AdvanceToNextFolder();
    }
    if (m_singleFolderToUpdate) {
      m_singleFolderToUpdate->UpdateFolder(m_window);
    }
  }
  if (NS_SUCCEEDED(rv)) rv = m_firstPlaybackError;
  // if we get here, then I *think* we're done. Not sure, though.
  nsCOMPtr<nsIUrlListener> saveListener = m_listener;
  m_listener = nullptr;

  if (saveListener)
    saveListener->OnStopRunningUrl(nullptr /* don't know url */, rv);
  return rv;
}

// A failed native SELECT or playback never authorizes deleting its intent.
nsresult nsImapOfflineSync::FinishPlayback(nsIURI* url, nsresult status) {
  if (NS_FAILED(status) && NS_SUCCEEDED(m_firstPlaybackError)) {
    m_firstPlaybackError = status;
  }
  // A refused idempotent flag command retains its payload for a later retry.
  if (NS_FAILED(status) &&
      (mCurrentPlaybackOpType == nsIMsgOfflineImapOperation::kFlagsChanged ||
       mCurrentPlaybackOpType == nsIMsgOfflineImapOperation::kAddKeywords ||
       mCurrentPlaybackOpType == nsIMsgOfflineImapOperation::kRemoveKeywords)) {
    for (int32_t i = 0; i < m_currentOpsToClear.Count(); ++i) {
      m_currentOpsToClear[i]->SetPlayingBack(false);
    }
  }
  ClearDB();
  if (status != NS_BINDING_ABORTED && m_listener && !m_singleFolderToUpdate &&
      AdvanceToNextFolder()) {
    return ProcessNextOperation();
  }
  nsCOMPtr<nsIUrlListener> listener = m_listener.forget();
  nsresult result =
      NS_FAILED(m_firstPlaybackError) ? m_firstPlaybackError : status;
  if (listener) listener->OnStopRunningUrl(url, result);
  return result;
}

void nsImapOfflineSync::DeleteAllOfflineOpsForCurrentDB() {
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    // Checked native per-operation settlement removes completed work. Remaining
    // Sent/accepted/ambiguous operations are recovery custody, never a sweep.
    m_KeyIndex = m_CurrentKeys.Length();
    return;
  }
#endif
  m_KeyIndex = 0;
  nsCOMPtr<nsIMsgOfflineImapOperation> currentOp;
  m_currentDB->GetOfflineOpForKey(m_CurrentKeys[m_KeyIndex], false,
                                  getter_AddRefs(currentOp));
  while (currentOp) {
    // NS_ASSERTION(currentOp->GetOperationFlags() == 0);
    // delete any ops that have already played back
    m_currentDB->RemoveOfflineOp(currentOp);
    currentOp = nullptr;

    if (++m_KeyIndex < m_CurrentKeys.Length())
      m_currentDB->GetOfflineOpForKey(m_CurrentKeys[m_KeyIndex], false,
                                      getter_AddRefs(currentOp));
  }
  m_currentDB->Commit(nsMsgDBCommitType::kLargeCommit);
}

NS_IMETHODIMP nsImapOfflineSync::OnStartCopy() {
  return NS_ERROR_NOT_IMPLEMENTED;
}

/* void OnProgress (in uint32_t aProgress, in uint32_t aProgressMax); */
NS_IMETHODIMP nsImapOfflineSync::OnProgress(uint32_t aProgress,
                                            uint32_t aProgressMax) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

/* void SetMessageKey (in uint32_t aKey); */
NS_IMETHODIMP nsImapOfflineSync::SetMessageKey(uint32_t aKey) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

/* [noscript] void GetMessageId (in nsCString aMessageId); */
NS_IMETHODIMP nsImapOfflineSync::GetMessageId(nsACString& messageId) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

/* void OnStopCopy (in nsresult aStatus); */
NS_IMETHODIMP nsImapOfflineSync::OnStopCopy(nsresult aStatus) {
  return OnStopRunningUrl(nullptr, aStatus);
}

void nsImapOfflineSync::ClearDB() {
  m_currentOpsToClear.Clear();
  if (m_currentDB) m_currentDB->RemoveListener(this);
  m_currentDB = nullptr;
}

NS_IMETHODIMP
nsImapOfflineSync::OnHdrPropertyChanged(nsIMsgDBHdr* aHdrToChange,
                                        const nsACString& property,
                                        bool aPreChange, uint32_t* aStatus,
                                        nsIDBChangeListener* aInstigator) {
  return NS_OK;
}

NS_IMETHODIMP
nsImapOfflineSync::OnHdrFlagsChanged(nsIMsgDBHdr* aHdrChanged,
                                     uint32_t aOldFlags, uint32_t aNewFlags,
                                     nsIDBChangeListener* aInstigator) {
  return NS_OK;
}

NS_IMETHODIMP
nsImapOfflineSync::OnHdrDeleted(nsIMsgDBHdr* aHdrChanged, nsMsgKey aParentKey,
                                int32_t aFlags,
                                nsIDBChangeListener* aInstigator) {
  return NS_OK;
}

NS_IMETHODIMP
nsImapOfflineSync::OnHdrAdded(nsIMsgDBHdr* aHdrAdded, nsMsgKey aParentKey,
                              int32_t aFlags,
                              nsIDBChangeListener* aInstigator) {
  return NS_OK;
}

/* void OnParentChanged (in nsMsgKey aKeyChanged, in nsMsgKey oldParent, in
 * nsMsgKey newParent, in nsIDBChangeListener aInstigator); */
NS_IMETHODIMP
nsImapOfflineSync::OnParentChanged(nsMsgKey aKeyChanged, nsMsgKey oldParent,
                                   nsMsgKey newParent,
                                   nsIDBChangeListener* aInstigator) {
  return NS_OK;
}

/* void OnAnnouncerGoingAway (in nsIDBChangeAnnouncer instigator); */
NS_IMETHODIMP
nsImapOfflineSync::OnAnnouncerGoingAway(nsIDBChangeAnnouncer* instigator) {
  ClearDB();
  return NS_OK;
}

NS_IMETHODIMP nsImapOfflineSync::OnEvent(nsIMsgDatabase* aDB,
                                         const char* aEvent) {
  return NS_OK;
}

/* void OnReadChanged (in nsIDBChangeListener instigator); */
NS_IMETHODIMP
nsImapOfflineSync::OnReadChanged(nsIDBChangeListener* instigator) {
  return NS_OK;
}

/* void OnJunkScoreChanged (in nsIDBChangeListener instigator); */
NS_IMETHODIMP
nsImapOfflineSync::OnJunkScoreChanged(nsIDBChangeListener* instigator) {
  return NS_OK;
}
