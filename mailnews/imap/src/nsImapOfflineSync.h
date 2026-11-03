/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_IMAP_SRC_NSIMAPOFFLINESYNC_H_
#define COMM_MAILNEWS_IMAP_SRC_NSIMAPOFFLINESYNC_H_

#include "nsIUrlListener.h"
#include "nsIMsgOfflineImapOperation.h"
#include "nsIMsgWindow.h"
#include "nsIMsgFolder.h"
#include "nsCOMArray.h"
#include "nsCOMPtr.h"
#include "nsIDBChangeListener.h"
#include "ImapTypes.h"

class nsIMsgOfflineOpsDatabase;
#ifdef MOZ_PANORAMA
#  include "MessageDatabase.h"
#  include "mozilla/UniquePtr.h"
struct NativeQueuedAppendTarget;
#endif

class nsImapOfflineSync : public nsIUrlListener,
                          public nsIMsgCopyServiceListener,
                          public nsIDBChangeListener {
 public:  // set to one folder to playback one folder only
  nsImapOfflineSync();

  NS_DECL_ISUPPORTS
  NS_DECL_NSIURLLISTENER
  NS_DECL_NSIMSGCOPYSERVICELISTENER
  NS_DECL_NSIDBCHANGELISTENER

  // isPseudoOffline is used only when performing message copies between IMAP
  // folders on the same server. An "offline" copy is performed first to
  // instantly copy the messages, then nsImapOfflineSync is used to perform the
  // corresponding IMAP operations.
  nsresult Init(nsIMsgWindow* window, nsIUrlListener* listener,
                nsIMsgFolder* folder, bool isPseudoOffline);

  virtual nsresult ProcessNextOperation();

  ImapUid GetCurrentUIDValidity();
  void SetCurrentUIDValidity(ImapUid uidvalidity) {
    mCurrentUIDValidity = uidvalidity;
  }

  bool ProcessingStaleFolderUpdate() {
    return m_singleFolderToUpdate != nullptr;
  }

  void SetWindow(nsIMsgWindow* window);

 protected:
  virtual ~nsImapOfflineSync();

  bool DestFolderOnSameServer(nsIMsgFolder* destFolder);
  bool AdvanceToNextServer();
  bool AdvanceToNextFolder();
  void AdvanceToFirstIMAPFolder();
  void DeleteAllOfflineOpsForCurrentDB();
  void ClearCurrentOps();
  // Clears m_currentDB, and unregister listener.
  void ClearDB();
  nsresult FinishPlayback(nsIURI* url, nsresult status);
  nsresult m_firstPlaybackError = NS_OK;
  nsresult ProcessFlagOperation(nsIMsgOfflineImapOperation* currentOp);
  nsresult ProcessKeywordOperation(nsIMsgOfflineImapOperation* op);
  void ProcessMoveOperation(nsIMsgOfflineImapOperation* currentOp);
  void ProcessCopyOperation(nsIMsgOfflineImapOperation* currentOp);
  void ProcessEmptyTrash();
#ifdef MOZ_PANORAMA
  nsresult ProcessNativeAction(nsIMsgOfflineImapOperation* op, uint32_t action);
  nsresult CompleteNativeAction(nsIURI* url, nsresult status);
  nsresult ProcessNativeFlags(nsIMsgOfflineImapOperation* op);
  nsresult ContinueNativeFlags(mozilla::mailnews::OfflineAttempt attempt);
  nsresult ContinueNativeMove(mozilla::mailnews::OfflineAttempt attempt);
  nsresult DispatchNativeReplay(
      const mozilla::mailnews::OfflineAttempt& attempt,
      mozilla::mailnews::OfflineReplayCommand command);
  nsresult CompleteNativeReplay(nsIURI* url, nsresult status);
  nsresult HoldNativeReplay(nsresult status);
  mozilla::UniquePtr<mozilla::mailnews::OfflineReplayCommandToken>
      mNativeReplay;
  nsCOMPtr<nsIURI> mNativeReplayUrl;
  uint64_t mNativeReplaySerial = 0;
  bool mNativeReplayCompleting = false;
  nsresult ProcessNativeFolderDelete(nsIMsgOfflineImapOperation* op);
  nsresult StartNativeFolderDelete(
      const mozilla::mailnews::OfflineAttempt& attempt, bool refresh);
  nsresult CompleteNativeFolderDelete(nsIURI* url, nsresult status);
  mozilla::UniquePtr<mozilla::mailnews::OfflineAttempt> mNativeFolderDelete;
  nsCOMPtr<nsIURI> mNativeFolderDeleteUrl;
  uint64_t mNativeFolderSerial = 0;
  bool mNativeFolderRefreshing = false;
  mozilla::UniquePtr<mozilla::mailnews::OfflineAttempt> mNativeAction;
  nsCOMPtr<nsIURI> mNativeActionUrl;
  nsresult ProcessNativeTransfer(nsIMsgOfflineImapOperation* op,
                                 uint32_t action);
  nsresult CompleteNativeTransfer(nsIURI* url, nsresult status);
  mozilla::UniquePtr<mozilla::mailnews::OfflineAttempt> mNativeTransfer;
  nsresult ProcessNativeAppend(nsIMsgOfflineImapOperation* op, uint32_t action);
  nsresult CompleteNativeAppend(nsIURI* url, nsresult status);
  nsresult ClearNativeAppend(nsIMsgOfflineImapOperation* op, uint32_t action);
  mozilla::UniquePtr<NativeQueuedAppendTarget> mNativeAppend;
  nsCOMPtr<nsIMsgOfflineImapOperation> mNativeAppendOp;
  bool mNativeAppendCompleting = false;
#endif
  void ProcessAppendMsgOperation(nsIMsgOfflineImapOperation* currentOp,
                                 nsOfflineImapOperationType opType);

  nsCOMPtr<nsIMsgFolder> m_currentFolder;
  nsCOMPtr<nsIMsgFolder> m_singleFolderToUpdate;
  nsCOMPtr<nsIMsgWindow> m_window;
  nsTArray<RefPtr<nsIMsgIncomingServer>> m_allServers;
  nsCOMPtr<nsIMsgIncomingServer> m_currentServer;
  // Folders left to consider on m_currentServer.
  nsTArray<RefPtr<nsIMsgFolder>> m_folderQueue;

  nsCOMPtr<nsIFile> m_curTempFile;

  nsTArray<nsMsgKey> m_CurrentKeys;
  nsCOMArray<nsIMsgOfflineImapOperation> m_currentOpsToClear;
  uint32_t m_KeyIndex;
  nsCOMPtr<nsIMsgOfflineOpsDatabase> m_currentDB;
  nsCOMPtr<nsIUrlListener> m_listener;
  ImapUid mCurrentUIDValidity;
  int32_t mCurrentPlaybackOpType;  // kFlagsChanged -> kMsgCopy -> kMsgMoved
  bool m_mailboxupdatesStarted;
  bool m_mailboxupdatesFinished;
  bool m_started;
  bool m_pseudoOffline;  // for queueing online events in offline db
};

#endif  // COMM_MAILNEWS_IMAP_SRC_NSIMAPOFFLINESYNC_H_
