/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsLocalUndoTxn.h"

#include "mozilla/Components.h"
#include "msgCore.h"
#include "nsIMsgHdr.h"
#include "nsImapCore.h"
#include "nsIImapService.h"
#include "nsIUrlListener.h"
#include "nsIMsgLocalMailFolder.h"
#include "nsIMsgMailSession.h"
#include "nsIMsgFolderNotificationService.h"
#include "nsIMsgDatabase.h"
#include "nsIMsgHdr.h"
#include "nsServiceManagerUtils.h"
#include "nsMsgUtils.h"
#include "nsMsgDBFolder.h"

#ifdef MOZ_PANORAMA
#  include "DatabaseCore.h"
#  include "Message.h"
#  include "MessageDatabase.h"
#  include "PerFolderDatabase.h"
#  include "mozilla/AutoRestore.h"
#  include "mozilla/ScopeExit.h"
#  include "mozilla/ResultExtensions.h"
#  include "mozilla/StaticPrefs_mail.h"
#  include "nsDirectoryServiceDefs.h"
#  include "nsIInputStream.h"
#  include "nsIMsgPluggableStore.h"
#  include "nsNetUtil.h"
#  include "nsLocalUtils.h"

using mozilla::mailnews::DatabaseCore;
using mozilla::mailnews::FinishedMessageBody;
using mozilla::mailnews::Message;
using mozilla::mailnews::MessageBodyState;
using mozilla::mailnews::PerFolderDatabase;
using mozilla::mailnews::RemovedMessage;

struct NativeLocalUndoEntry {
  ~NativeLocalUndoEntry() {
    // An unsuccessful operation may have removed physical storage. Do not
    // destroy its independent recovery bytes when the copy state is released.
    if (recovery && !retainRecovery) recovery->Remove(false);
  }
  RemovedMessage removed;
  mozilla::Maybe<MessageBodyState> expected;
  nsCOMPtr<nsIFile> recovery;
  bool retainRecovery = false;
  bool finishAttempted = false;
  nsresult finishResult = NS_OK;
  bool measured = false;
  mozilla::Maybe<FinishedMessageBody> finished;
  RefPtr<Message> live;
};

struct NativeLocalUndoState {
  bool changing = false;
  bool undone = false;
  mozilla::Maybe<bool> pending;
  nsresult firstError = NS_OK;
  nsTArray<mozilla::UniquePtr<NativeLocalUndoEntry>> source;
  nsTArray<mozilla::UniquePtr<NativeLocalUndoEntry>> destination;
};

namespace {
using NativeUndoEntries = nsTArray<mozilla::UniquePtr<NativeLocalUndoEntry>>;

bool SameUndoBody(const MessageBodyState& a, const MessageBodyState& b) {
  return a.databaseSourceId == b.databaseSourceId && a.key == b.key &&
         a.folderId == b.folderId && a.storeToken == b.storeToken &&
         a.contentRevision == b.contentRevision &&
         a.locationRevision == b.locationRevision && a.flags == b.flags &&
         a.messageSize == b.messageSize &&
         a.offlineMessageSize == b.offlineMessageSize &&
         a.lineCount == b.lineCount;
}

nsresult CaptureLocalUndo(nsIMsgFolder* folder, const nsTArray<nsMsgKey>& keys,
                          NativeUndoEntries& entries) {
  NS_ENSURE_FALSE(keys.IsEmpty(), NS_ERROR_NOT_AVAILABLE);
  if (entries.IsEmpty()) {
    for (size_t i = 0; i < keys.Length(); ++i) {
      entries.AppendElement(mozilla::MakeUnique<NativeLocalUndoEntry>());
    }
  }
  NS_ENSURE_TRUE(entries.Length() == keys.Length(), NS_ERROR_NOT_AVAILABLE);
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  NS_ENSURE_STATE(core);
  uint64_t folderId;
  MOZ_TRY(folder->GetId(&folderId));
  nsCOMPtr<nsIMsgDatabase> database;
  MOZ_TRY(folder->GetMsgDatabase(getter_AddRefs(database)));
  // Preflight the whole set before removing any member.
  for (size_t i = 0; i < keys.Length(); ++i) {
    auto& entry = *entries[i];
    if (entry.removed.Body()) continue;
    for (size_t j = 0; j < i; ++j) {
      NS_ENSURE_TRUE(keys[j] != keys[i], NS_ERROR_INVALID_ARG);
    }
    MessageBodyState before;
    MOZ_TRY(core->MessageDB().GetMessageBodyState(keys[i], before));
    NS_ENSURE_TRUE(before.folderId == folderId && before.storeToken &&
                       !before.storeToken->IsEmpty(),
                   NS_ERROR_NOT_AVAILABLE);
    // A failed SQL removal can retry against the exact already captured body.
    if (entry.expected && SameUndoBody(*entry.expected, before)) continue;
    nsCOMPtr<nsIMsgDBHdr> header;
    MOZ_TRY(database->GetMsgHdrForKey(keys[i], getter_AddRefs(header)));
    NS_ENSURE_TRUE(header, NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsIFile> recovery;
    MOZ_TRY(GetSpecialDirectoryWithFileName(NS_OS_TEMP_DIR, "local-undo.eml",
                                            getter_AddRefs(recovery)));
    MOZ_TRY(recovery->CreateUnique(nsIFile::NORMAL_FILE_TYPE, 00600));
    auto remove = mozilla::MakeScopeExit([&] { recovery->Remove(false); });
    nsCOMPtr<nsIInputStream> input;
    MOZ_TRY(folder->GetMsgInputStream(header, getter_AddRefs(input)));
    auto closeInput = mozilla::MakeScopeExit([&] { input->Close(); });
    nsCOMPtr<nsIOutputStream> output;
    MOZ_TRY(MsgNewBufferedFileOutputStream(getter_AddRefs(output), recovery,
                                           PR_WRONLY | PR_CREATE_FILE, 00600));
    uint64_t bytes;
    nsresult copied = SyncCopyStream(input, output, bytes);
    nsresult readClose = input->Close();
    closeInput.release();
    nsresult writeClose = output->Close();
    MOZ_TRY(copied);
    MOZ_TRY(readClose);
    MOZ_TRY(writeClose);
    NS_ENSURE_TRUE(bytes == before.messageSize, NS_ERROR_NOT_AVAILABLE);
    MessageBodyState after;
    MOZ_TRY(core->MessageDB().GetMessageBodyState(keys[i], after));
    NS_ENSURE_TRUE(SameUndoBody(before, after), NS_ERROR_NOT_AVAILABLE);
    if (entry.recovery && !entry.retainRecovery) entry.recovery->Remove(false);
    entry.recovery = recovery;
    entry.expected.reset();
    entry.expected.emplace(std::move(before));
    entry.retainRecovery = false;
    remove.release();
  }
  return NS_OK;
}

nsresult RemoveLocalUndo(nsIMsgFolder* folder, nsMsgKey key,
                         NativeLocalUndoEntry& entry) {
  if (entry.removed.Body()) return NS_OK;
  NS_ENSURE_TRUE(entry.expected && entry.recovery, NS_ERROR_NOT_AVAILABLE);
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  NS_ENSURE_STATE(core);
  MessageBodyState current;
  MOZ_TRY(core->MessageDB().GetMessageBodyState(key, current));
  NS_ENSURE_TRUE(SameUndoBody(*entry.expected, current),
                 NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIMsgDatabase> database;
  MOZ_TRY(folder->GetMsgDatabase(getter_AddRefs(database)));
  entry.retainRecovery = true;
  // Native removal owns the complete metadata snapshot before notifications.
  MOZ_TRY(static_cast<PerFolderDatabase*>(database.get())
              ->RemoveHdrForUndo(key, entry.removed));
  entry.live = nullptr;
  return NS_OK;
}

nsresult RestoreLocalUndo(nsIMsgFolder* folder, nsTArray<nsMsgKey>& keys,
                          NativeUndoEntries& entries) {
  NS_ENSURE_TRUE(entries.Length() == keys.Length(), NS_ERROR_NOT_AVAILABLE);
  bool locked;
  MOZ_TRY(folder->GetLocked(&locked));
  NS_ENSURE_FALSE(locked, NS_MSG_FOLDER_BUSY);
  nsCOMPtr<nsIMsgDatabase> database;
  MOZ_TRY(folder->GetMsgDatabase(getter_AddRefs(database)));
  auto* native = static_cast<PerFolderDatabase*>(database.get());
  nsCOMPtr<nsIMsgPluggableStore> store;
  MOZ_TRY(folder->GetMsgStore(getter_AddRefs(store)));
  nsCOMPtr<nsIMsgFolderNotificationService> notifier =
      mozilla::components::FolderNotification::Service();
  NS_ENSURE_STATE(notifier);
  for (size_t i = 0; i < entries.Length(); ++i) {
    auto& entry = *entries[i];
    if (!entry.removed.Body()) continue;
    NS_ENSURE_TRUE(entry.recovery, NS_ERROR_NOT_AVAILABLE);
    entry.retainRecovery = true;
    if (entry.finishAttempted && !entry.finished) return entry.finishResult;
    if (!entry.finished) {
      nsCOMPtr<nsIInputStream> input;
      MOZ_TRY(
          NS_NewLocalFileInputStream(getter_AddRefs(input), entry.recovery));
      auto closeInput = mozilla::MakeScopeExit([&] { input->Close(); });
      nsCOMPtr<nsIOutputStream> output;
      MOZ_TRY(store->GetNewMsgOutputStream(folder, getter_AddRefs(output)));
      auto discard = mozilla::MakeScopeExit(
          [&] { store->DiscardNewMessage(folder, output); });
      uint64_t bytes;
      MOZ_TRY(SyncCopyStream(input, output, bytes));
      nsresult readClose = input->Close();
      closeInput.release();
      MOZ_TRY(readClose);
      MOZ_TRY(output->Flush());
      // A failed/unknown Finish does not authorize a second Finish or Discard.
      discard.release();
      entry.finishAttempted = true;
      FinishedMessageBody finished;
      entry.finishResult =
          store->FinishNewMessage(folder, output, finished.storeToken);
      MOZ_TRY(entry.finishResult);
      entry.finished.emplace(std::move(finished));
    }
    if (!entry.measured) {
      auto& finished = *entry.finished;
      MOZ_TRY(ReadStoredMessageDetails(store, folder, finished.storeToken,
                                       &finished.messageSize,
                                       &finished.lineCount));
      finished.offline = false;
      finished.offlineMessageSize = 0;
      entry.measured = true;
    }
    NS_ENSURE_TRUE(!entry.live, NS_ERROR_IN_PROGRESS);
    // These persistent slots are filled before native publication can reenter.
    MOZ_TRY(native->UndoDeleteHdrForUndo(entry.removed, *entry.finished,
                                         &keys[i], getter_AddRefs(entry.live)));
    entry.finished.reset();
    entry.finishAttempted = false;
    entry.finishResult = NS_OK;
    entry.measured = false;
    entry.expected.reset();
    entry.retainRecovery = false;
    notifier->NotifyMsgAdded(entry.live);
  }
  return database->SetSummaryValid(true);
}
}  // namespace
#endif

NS_IMPL_ISUPPORTS_INHERITED(nsLocalMoveCopyMsgTxn, nsMsgTxn, nsIFolderListener)

nsLocalMoveCopyMsgTxn::nsLocalMoveCopyMsgTxn()
    : m_isMove(false),
      m_srcIsImap4(false),
      m_undoing(false),
      m_numHdrsCopied(0),
      mUndoFolderListener(nullptr) {}

nsLocalMoveCopyMsgTxn::~nsLocalMoveCopyMsgTxn() {}

nsresult nsLocalMoveCopyMsgTxn::Init(nsIMsgFolder* srcFolder,
                                     nsIMsgFolder* dstFolder, bool isMove) {
  nsresult rv;
  rv = SetSrcFolder(srcFolder);
  NS_ENSURE_SUCCESS(rv, rv);
  rv = SetDstFolder(dstFolder);
  NS_ENSURE_SUCCESS(rv, rv);
  m_isMove = isMove;
#ifdef MOZ_PANORAMA
  nsCOMPtr<nsIMsgLocalMailFolder> localSource = do_QueryInterface(srcFolder);
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup() && localSource) {
    mNativeUndo = mozilla::MakeUnique<NativeLocalUndoState>();
  }
#endif

  mUndoFolderListener = nullptr;

  nsCString protocolType;
  rv = srcFolder->GetURI(protocolType);
  protocolType.SetLength(protocolType.FindChar(':'));
  if (protocolType.LowerCaseEqualsLiteral("imap")) m_srcIsImap4 = true;
  return NS_OK;
}
nsresult nsLocalMoveCopyMsgTxn::GetSrcIsImap(bool* isImap) {
  *isImap = m_srcIsImap4;
  return NS_OK;
}
nsresult nsLocalMoveCopyMsgTxn::SetSrcFolder(nsIMsgFolder* srcFolder) {
  nsresult rv = NS_ERROR_NULL_POINTER;
  if (srcFolder) m_srcFolder = do_GetWeakReference(srcFolder, &rv);
  return rv;
}

nsresult nsLocalMoveCopyMsgTxn::SetDstFolder(nsIMsgFolder* dstFolder) {
  nsresult rv = NS_ERROR_NULL_POINTER;
  if (dstFolder) m_dstFolder = do_GetWeakReference(dstFolder, &rv);
  return rv;
}

nsresult nsLocalMoveCopyMsgTxn::AddSrcKey(nsMsgKey aKey) {
  m_srcKeyArray.AppendElement(aKey);
  return NS_OK;
}

nsresult nsLocalMoveCopyMsgTxn::AddDstKey(nsMsgKey aKey) {
  m_dstKeyArray.AppendElement(aKey);
  return NS_OK;
}

nsresult nsLocalMoveCopyMsgTxn::AddDstMsgSize(uint32_t msgSize) {
  m_dstSizeArray.AppendElement(msgSize);
  return NS_OK;
}

nsresult nsLocalMoveCopyMsgTxn::UndoImapDeleteFlag(nsIMsgFolder* folder,
                                                   nsTArray<nsMsgKey>& keyArray,
                                                   bool deleteFlag) {
  nsresult rv = NS_ERROR_FAILURE;
  if (m_srcIsImap4) {
    nsCOMPtr<nsIImapService> imapService = mozilla::components::Imap::Service();
    nsCOMPtr<nsIUrlListener> urlListener;
    nsCString msgIds;
    uint32_t i, count = keyArray.Length();
    urlListener = do_QueryInterface(folder, &rv);
    for (i = 0; i < count; i++) {
      if (!msgIds.IsEmpty()) msgIds.Append(',');
      msgIds.AppendInt((int32_t)keyArray[i]);
    }
    // This is to make sure that we are in the selected state
    // when executing the imap url; we don't want to load the
    // folder so use lite select to do the trick
    rv = imapService->LiteSelectFolder(folder, urlListener, nullptr, nullptr);
    if (!deleteFlag)
      rv = imapService->AddMessageFlags(folder, urlListener, msgIds,
                                        kImapMsgDeletedFlag, true);
    else
      rv = imapService->SubtractMessageFlags(folder, urlListener, msgIds,
                                             kImapMsgDeletedFlag, true);
    if (NS_SUCCEEDED(rv)) folder->UpdateFolder(nullptr);
    rv = NS_OK;  // always return NS_OK to indicate that the src is imap
  } else
    rv = NS_ERROR_FAILURE;
  return rv;
}

NS_IMETHODIMP
nsLocalMoveCopyMsgTxn::UndoTransaction() {
#ifdef MOZ_PANORAMA
  if (mNativeUndo) return RunNativeUndo(true);
#endif
  nsresult rv;
  nsCOMPtr<nsIMsgDatabase> dstDB;

  nsCOMPtr<nsIMsgFolder> dstFolder = do_QueryReferent(m_dstFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  nsCOMPtr<nsIMsgLocalMailFolder> dstlocalMailFolder =
      do_QueryReferent(m_dstFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  dstlocalMailFolder->GetDatabaseWOReparse(getter_AddRefs(dstDB));

  if (!dstDB) {
    // This will listen for the db reparse finishing, and the corresponding
    // FolderLoadedNotification. When it gets that, it will then call
    // UndoTransactionInternal.
    mUndoFolderListener = new nsLocalUndoFolderListener(this, dstFolder);
    if (!mUndoFolderListener) return NS_ERROR_OUT_OF_MEMORY;
    NS_ADDREF(mUndoFolderListener);

    nsCOMPtr<nsIMsgMailSession> mailSession =
        mozilla::components::MailSession::Service();
    rv = mailSession->AddFolderListener(mUndoFolderListener,
                                        nsIFolderListener::event);
    NS_ENSURE_SUCCESS(rv, rv);

    rv = dstFolder->GetMsgDatabase(getter_AddRefs(dstDB));
    NS_ENSURE_SUCCESS(rv, rv);
  } else
    rv = UndoTransactionInternal();
  return rv;
}

nsresult nsLocalMoveCopyMsgTxn::UndoTransactionInternal() {
  nsresult rv = NS_ERROR_FAILURE;

  if (mUndoFolderListener) {
    nsCOMPtr<nsIMsgMailSession> mailSession =
        mozilla::components::MailSession::Service();
    rv = mailSession->RemoveFolderListener(mUndoFolderListener);
    NS_ENSURE_SUCCESS(rv, rv);

    NS_RELEASE(mUndoFolderListener);
    mUndoFolderListener = nullptr;
  }

  nsCOMPtr<nsIMsgDatabase> srcDB;
  nsCOMPtr<nsIMsgDatabase> dstDB;
  nsCOMPtr<nsIMsgFolder> srcFolder = do_QueryReferent(m_srcFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIMsgFolder> dstFolder = do_QueryReferent(m_dstFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = srcFolder->GetMsgDatabase(getter_AddRefs(srcDB));
  if (NS_FAILED(rv)) return rv;

  rv = dstFolder->GetMsgDatabase(getter_AddRefs(dstDB));
  if (NS_FAILED(rv)) return rv;

  uint32_t count = m_srcKeyArray.Length();
  uint32_t i;

  // protect against a bogus undo txn without any source keys
  // see bug #179856 for details
  NS_ASSERTION(count, "no source keys");
  if (!count) return NS_ERROR_UNEXPECTED;

  if (m_isMove) {
    if (m_srcIsImap4) {
      bool deleteFlag =
          true;  // message has been deleted -we are trying to undo it
      CheckForToggleDelete(srcFolder, m_srcKeyArray[0],
                           &deleteFlag);  // there could have been a toggle.
      rv = UndoImapDeleteFlag(srcFolder, m_srcKeyArray, deleteFlag);
    } else  // undoing a move means moving the messages back.
    {
      nsTArray<RefPtr<nsIMsgDBHdr>> dstMessages(m_dstKeyArray.Length());
      m_numHdrsCopied = 0;
      m_srcKeyArray.Clear();
      for (i = 0; i < count; i++) {
        // GetMsgHdrForKey is not a test for whether the key exists, so check.
        bool hasKey = false;
        dstDB->ContainsKey(m_dstKeyArray[i], &hasKey);
        nsCOMPtr<nsIMsgDBHdr> dstHdr;
        if (hasKey)
          dstDB->GetMsgHdrForKey(m_dstKeyArray[i], getter_AddRefs(dstHdr));
        if (dstHdr) {
          nsCString messageId;
          dstHdr->GetMessageId(messageId);
          dstMessages.AppendElement(dstHdr);
          m_copiedMsgIds.AppendElement(messageId);
        } else {
          NS_WARNING("Cannot get old msg header");
        }
      }
      if (m_copiedMsgIds.Length()) {
        srcFolder->AddFolderListener(this);
        m_undoing = true;
        return srcFolder->CopyMessages(dstFolder, dstMessages, true, nullptr,
                                       nullptr, false, false);
      } else {
        // Nothing to do, probably because original messages were deleted.
        NS_WARNING("Undo did not find any messages to move");
      }
    }
    srcDB->SetSummaryValid(true);
  }

  dstDB->DeleteMessages(m_dstKeyArray, nullptr);
  dstDB->SetSummaryValid(true);

  return rv;
}

NS_IMETHODIMP
nsLocalMoveCopyMsgTxn::RedoTransaction() {
#ifdef MOZ_PANORAMA
  if (mNativeUndo) return RunNativeUndo(false);
#endif
  nsresult rv;
  nsCOMPtr<nsIMsgDatabase> srcDB;
  nsCOMPtr<nsIMsgDatabase> dstDB;

  nsCOMPtr<nsIMsgFolder> srcFolder = do_QueryReferent(m_srcFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIMsgFolder> dstFolder = do_QueryReferent(m_dstFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = srcFolder->GetMsgDatabase(getter_AddRefs(srcDB));
  if (NS_FAILED(rv)) return rv;
  rv = dstFolder->GetMsgDatabase(getter_AddRefs(dstDB));
  if (NS_FAILED(rv)) return rv;

  nsTArray<RefPtr<nsIMsgDBHdr>> srcMessages(m_srcKeyArray.Length());
  nsCOMPtr<nsIMsgDBHdr> srcHdr;
  m_numHdrsCopied = 0;
  m_dstKeyArray.Clear();
  for (nsMsgKey srcKey : m_srcKeyArray) {
    rv = srcDB->GetMsgHdrForKey(srcKey, getter_AddRefs(srcHdr));
    NS_ASSERTION(srcHdr, "fatal ... cannot get old msg header");
    if (NS_SUCCEEDED(rv) && srcHdr) {
      srcMessages.AppendElement(srcHdr);
      nsCString messageId;
      srcHdr->GetMessageId(messageId);
      m_copiedMsgIds.AppendElement(messageId);
    }
  }
  dstFolder->AddFolderListener(this);
  m_undoing = false;
  return dstFolder->CopyMessages(srcFolder, srcMessages, m_isMove, nullptr,
                                 nullptr, false, false);
}

#ifdef MOZ_PANORAMA
nsresult nsLocalMoveCopyMsgTxn::PrepareNativeSourceRemoval(
    nsIMsgFolder* folder, const nsTArray<RefPtr<nsIMsgDBHdr>>& headers) {
  NS_ENSURE_TRUE(mNativeUndo && !mNativeUndo->changing, NS_ERROR_IN_PROGRESS);
  nsCOMPtr<nsIMsgFolder> source = do_QueryReferent(m_srcFolder);
  NS_ENSURE_TRUE(folder == source && headers.Length() == m_srcKeyArray.Length(),
                 NS_ERROR_INVALID_ARG);
  // Require the exact original copy members, independent of input ordering.
  for (const auto& header : headers) {
    nsMsgKey key;
    MOZ_TRY(header->GetMessageKey(&key));
    NS_ENSURE_TRUE(m_srcKeyArray.Contains(key), NS_ERROR_INVALID_ARG);
  }
  mozilla::AutoRestore<bool> changing(mNativeUndo->changing);
  mNativeUndo->changing = true;
  MOZ_TRY(CaptureLocalUndo(folder, m_srcKeyArray, mNativeUndo->source));
  // Provider deletion follows this call and may fail after removing a prefix.
  for (auto& entry : mNativeUndo->source) entry->retainRecovery = true;
  return NS_OK;
}

nsresult nsLocalMoveCopyMsgTxn::RemoveNativeSourceHeader(nsIMsgFolder* folder,
                                                         nsIMsgDBHdr* header) {
  NS_ENSURE_TRUE(mNativeUndo && !mNativeUndo->changing, NS_ERROR_IN_PROGRESS);
  nsCOMPtr<nsIMsgFolder> source = do_QueryReferent(m_srcFolder);
  NS_ENSURE_TRUE(folder == source, NS_ERROR_INVALID_ARG);
  nsMsgKey key;
  MOZ_TRY(header->GetMessageKey(&key));
  auto index = m_srcKeyArray.IndexOf(key);
  NS_ENSURE_TRUE(index != m_srcKeyArray.NoIndex &&
                     mNativeUndo->source.Length() == m_srcKeyArray.Length(),
                 NS_ERROR_NOT_AVAILABLE);
  mozilla::AutoRestore<bool> changing(mNativeUndo->changing);
  mNativeUndo->changing = true;
  MOZ_TRY(RemoveLocalUndo(folder, key, *mNativeUndo->source[index]));
  bool complete = true;
  for (const auto& entry : mNativeUndo->source) {
    if (!entry->removed.Body()) complete = false;
  }
  if (complete) {
    for (auto& entry : mNativeUndo->source) entry->retainRecovery = false;
  }
  return NS_OK;
}

nsresult nsLocalMoveCopyMsgTxn::RunNativeUndo(bool undoing) {
  NS_ENSURE_FALSE(mNativeUndo->changing, NS_ERROR_IN_PROGRESS);
  if (mNativeUndo->pending && *mNativeUndo->pending != undoing) {
    return mNativeUndo->firstError;
  }
  if (!mNativeUndo->pending && mNativeUndo->undone == undoing) return NS_OK;
  nsCOMPtr<nsIMsgFolder> source = do_QueryReferent(m_srcFolder);
  nsCOMPtr<nsIMsgFolder> destination = do_QueryReferent(m_dstFolder);
  NS_ENSURE_TRUE(source && destination, NS_ERROR_NOT_AVAILABLE);
  bool sourceLocked, destinationLocked;
  MOZ_TRY(source->GetLocked(&sourceLocked));
  MOZ_TRY(destination->GetLocked(&destinationLocked));
  if (sourceLocked || destinationLocked) {
    return mNativeUndo->pending ? mNativeUndo->firstError : NS_MSG_FOLDER_BUSY;
  }
  if (!mNativeUndo->pending) mNativeUndo->pending.emplace(undoing);
  RefPtr<nsLocalMoveCopyMsgTxn> self(this);
  mozilla::AutoRestore<bool> changing(mNativeUndo->changing);
  mNativeUndo->changing = true;
  nsresult result = [&]() -> nsresult {
    if (undoing) {
      // Capture all destination bodies before any source restoration or
      // removal.
      MOZ_TRY(CaptureLocalUndo(destination, m_dstKeyArray,
                               mNativeUndo->destination));
      if (m_isMove) {
        MOZ_TRY(RestoreLocalUndo(source, m_srcKeyArray, mNativeUndo->source));
      }
      for (size_t i = 0; i < m_dstKeyArray.Length(); ++i) {
        MOZ_TRY(RemoveLocalUndo(destination, m_dstKeyArray[i],
                                *mNativeUndo->destination[i]));
      }
    } else {
      // Validate the whole current source set before publishing any redo row.
      MOZ_TRY(CaptureLocalUndo(source, m_srcKeyArray, mNativeUndo->source));
      MOZ_TRY(RestoreLocalUndo(destination, m_dstKeyArray,
                               mNativeUndo->destination));
      if (m_isMove) {
        for (size_t i = 0; i < m_srcKeyArray.Length(); ++i) {
          MOZ_TRY(RemoveLocalUndo(source, m_srcKeyArray[i],
                                  *mNativeUndo->source[i]));
        }
      }
    }
    return NS_OK;
  }();
  if (NS_SUCCEEDED(result)) {
    mNativeUndo->undone = undoing;
    mNativeUndo->pending.reset();
    mNativeUndo->firstError = NS_OK;
    // Explicit history cleanup can release settled recovery. Failed operations
    // keep their independent bytes even if the original copy state is dropped.
    for (auto& entry : mNativeUndo->source) entry->retainRecovery = false;
    for (auto& entry : mNativeUndo->destination) entry->retainRecovery = false;
  } else if (NS_SUCCEEDED(mNativeUndo->firstError)) {
    mNativeUndo->firstError = result;
  }
  return NS_FAILED(result) ? mNativeUndo->firstError : result;
}
#endif

NS_IMETHODIMP nsLocalMoveCopyMsgTxn::OnFolderAdded(nsIMsgFolder* parent,
                                                   nsIMsgFolder* child) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalMoveCopyMsgTxn::OnMessageAdded(nsIMsgFolder* parent,
                                                    nsIMsgDBHdr* msgHdr) {
  nsresult rv;
  nsCOMPtr<nsIMsgFolder> folder =
      do_QueryReferent(m_undoing ? m_srcFolder : m_dstFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  nsCString messageId;
  msgHdr->GetMessageId(messageId);
  if (m_copiedMsgIds.Contains(messageId)) {
    nsMsgKey msgKey;
    msgHdr->GetMessageKey(&msgKey);
    if (m_undoing)
      m_srcKeyArray.AppendElement(msgKey);
    else
      m_dstKeyArray.AppendElement(msgKey);
    if (++m_numHdrsCopied == m_copiedMsgIds.Length()) {
      folder->RemoveFolderListener(this);
      m_copiedMsgIds.Clear();
    }
  }
  return NS_OK;
}

NS_IMETHODIMP nsLocalMoveCopyMsgTxn::OnFolderRemoved(nsIMsgFolder* parent,
                                                     nsIMsgFolder* child) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalMoveCopyMsgTxn::OnMessageRemoved(nsIMsgFolder* parent,
                                                      nsIMsgDBHdr* msg) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalMoveCopyMsgTxn::OnFolderPropertyChanged(
    nsIMsgFolder* item, const nsACString& property, const nsACString& oldValue,
    const nsACString& newValue) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalMoveCopyMsgTxn::OnFolderIntPropertyChanged(
    nsIMsgFolder* item, const nsACString& property, int64_t oldValue,
    int64_t newValue) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalMoveCopyMsgTxn::OnFolderBoolPropertyChanged(
    nsIMsgFolder* item, const nsACString& property, bool oldValue,
    bool newValue) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalMoveCopyMsgTxn::OnFolderPropertyFlagChanged(
    nsIMsgDBHdr* item, const nsACString& property, uint32_t oldFlag,
    uint32_t newFlag) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalMoveCopyMsgTxn::OnFolderEvent(nsIMsgFolder* aItem,
                                                   const nsACString& aEvent) {
  return NS_OK;
}

NS_IMPL_ISUPPORTS(nsLocalUndoFolderListener, nsIFolderListener)

nsLocalUndoFolderListener::nsLocalUndoFolderListener(
    nsLocalMoveCopyMsgTxn* aTxn, nsIMsgFolder* aFolder) {
  mTxn = aTxn;
  mFolder = aFolder;
}

nsLocalUndoFolderListener::~nsLocalUndoFolderListener() {}

NS_IMETHODIMP nsLocalUndoFolderListener::OnFolderAdded(nsIMsgFolder* parent,
                                                       nsIMsgFolder* child) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalUndoFolderListener::OnMessageAdded(nsIMsgFolder* parent,
                                                        nsIMsgDBHdr* msg) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalUndoFolderListener::OnFolderRemoved(nsIMsgFolder* parent,
                                                         nsIMsgFolder* child) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalUndoFolderListener::OnMessageRemoved(nsIMsgFolder* parent,
                                                          nsIMsgDBHdr* msg) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalUndoFolderListener::OnFolderPropertyChanged(
    nsIMsgFolder* item, const nsACString& property, const nsACString& oldValue,
    const nsACString& newValue) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalUndoFolderListener::OnFolderIntPropertyChanged(
    nsIMsgFolder* item, const nsACString& property, int64_t oldValue,
    int64_t newValue) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalUndoFolderListener::OnFolderBoolPropertyChanged(
    nsIMsgFolder* item, const nsACString& property, bool oldValue,
    bool newValue) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalUndoFolderListener::OnFolderPropertyFlagChanged(
    nsIMsgDBHdr* item, const nsACString& property, uint32_t oldFlag,
    uint32_t newFlag) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalUndoFolderListener::OnFolderEvent(
    nsIMsgFolder* aItem, const nsACString& aEvent) {
  if (mTxn && mFolder && aItem == mFolder) {
    if (aEvent.Equals(kFolderLoaded)) return mTxn->UndoTransactionInternal();
  }

  return NS_ERROR_FAILURE;
}
