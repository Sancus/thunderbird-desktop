/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_LOCAL_SRC_NSPOP3SINK_H_
#define COMM_MAILNEWS_LOCAL_SRC_NSPOP3SINK_H_

#include "nscore.h"
#include "nsCOMPtr.h"
#include "nsIPop3Sink.h"
#include "nsIMsgOperationListener.h"
#include "nsIOutputStream.h"
#include "prmem.h"
#include "prio.h"
#include "plstr.h"
#include "prenv.h"
#include "nsIMsgFolder.h"
#include "nsTArray.h"
#include "nsString.h"
#ifdef MOZ_PANORAMA
#  include "MessageDatabase.h"
#endif

class nsParseNewMailState;
class nsIMsgFolder;
class nsIMsgDatabase;

class nsPop3Sink : public nsIPop3Sink, public nsIMsgOperationListener {
 public:
  nsPop3Sink();

  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIPOP3SINK
  NS_DECL_NSIMSGOPERATIONLISTENER
  nsresult GetServerFolder(nsIMsgFolder** aFolder);

 protected:
  virtual ~nsPop3Sink();
  nsresult WriteLineToMailbox(const nsACString& buffer);
  nsresult IncorporateBeginInternal(const char* uidlString, uint32_t flags);
  nsresult IncorporateCompleteInternal(nsIMsgWindow* msgWindow, int32_t size);
  nsresult RecordIncorporateResult(nsresult status);
  nsresult FinishIncorporation(nsresult status);
  nsresult ReleaseFolderLock();
  nsresult DiscardStalePartialMessages(nsIPop3Protocol* protocol);

#ifdef MOZ_PANORAMA
  nsresult PreparePartialMessage(const char* uidl, uint32_t flags,
                                 nsIMsgDatabase* database);
  nsresult CompletePartialMessage(int32_t size, nsIMsgDBHdr** completed);
  mozilla::Maybe<mozilla::mailnews::MessageBodyState> m_partialBody;
  nsCString m_partialUri;
  nsCString m_partialFinishedToken;
#endif

  uint32_t m_biffState;
  int32_t m_numNewMessages;
  int32_t m_numNewMessagesInFolder;
  int32_t m_numMsgsDownloaded;
  bool m_senderAuthed;
  nsCOMPtr<nsIPop3IncomingServer> m_popServer;
  // Currently the folder we want to update about biff info
  nsCOMPtr<nsIMsgFolder> m_folder;
  RefPtr<nsParseNewMailState> m_newMailParser;
  nsCOMPtr<nsIOutputStream>
      m_outFileStream;  // the file we write to, which may be temporary
  nsCOMPtr<nsIMsgPluggableStore> m_msgStore;
  bool m_uidlDownload;
  bool m_buildMessageUri;
  // Finish owns settlement even when its result is uncertain.
  bool m_finishCalled = false;
  bool m_confirmedPartialCompletion = false;
  // Keep the first failure for the current delivery.
  nsresult m_incorporateStatus = NS_OK;
  bool m_completionPending = false;
  nsCOMPtr<nsIMsgOperationListener> m_completionListener;
  nsCOMPtr<nsIMsgWindow> m_window;
  nsCString m_messageUri;
  nsCString m_baseMessageUri;
  nsCString m_origMessageUri;
  nsCString m_accountKey;
};

#endif  // COMM_MAILNEWS_LOCAL_SRC_NSPOP3SINK_H_
