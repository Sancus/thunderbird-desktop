/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsImapUndoTxn.h"

#include "mozilla/Components.h"
#include "msgCore.h"  // for precompiled headers
#include "nsIMsgHdr.h"
#include "nsIMsgIncomingServer.h"
#include "nsImapCore.h"
#include "nsImapMailFolder.h"
#include "nsIImapService.h"
#include "nsIDBFolderInfo.h"
#include "nsIMsgDatabase.h"
#include "nsImapUtils.h"
#include "nsMsgUtils.h"
#include "nsServiceManagerUtils.h"
#ifdef MOZ_PANORAMA
#  include "DatabaseCore.h"
#  include "PerFolderDatabase.h"
#  include "Message.h"
#  include "mozilla/StaticPrefs_mail.h"
#  include "mozilla/AutoRestore.h"
#  include "mozilla/ScopeExit.h"
#  include "mozilla/ResultExtensions.h"
#  include "nsDirectoryServiceDefs.h"
#  include "nsNetUtil.h"
#  include "nsIMsgPluggableStore.h"
#  include "nsIMsgFolderNotificationService.h"
#  include "../../local/src/nsLocalUtils.h"

struct NativeImapUndoEntry {
  ~NativeImapUndoEntry() {
    if (recovery) recovery->Remove(false);
  }
  nsMsgKey originalKey{nsMsgKey_None};
  mozilla::mailnews::RemovedMessage removed;
  mozilla::mailnews::OfflineOperationUndo offline;
  mozilla::mailnews::OfflineOperationUndo redo;
  mozilla::Maybe<mozilla::mailnews::PendingDestination> cancelMove;
  bool offlineRemoved = false;
  bool removedFromFolder = false;
  bool removalStarted = false;
  mozilla::Maybe<mozilla::mailnews::MessageBodyState> expectedBody;
  bool finishAttempted = false;
  nsresult finishResult = NS_OK;
  bool finishedMeasured = false;
  nsCOMPtr<nsIFile> recovery;
  nsCOMPtr<nsIMsgDBHdr> metadata;
  nsTArray<nsCString> references;
  mozilla::Maybe<mozilla::mailnews::FinishedMessageBody> finished;
  RefPtr<mozilla::mailnews::Message> live;
  nsCOMPtr<nsIMsgDBHdr> destinationHeader;
  nsCString destinationSourceId;
  uint64_t destinationFolderId = 0;
  uint32_t destinationEpoch = 0;
  ImapUid destinationUid = 0;
};
#endif

nsImapMoveCopyMsgTxn::nsImapMoveCopyMsgTxn()
    : m_idsAreUids(false), m_isMove(false), m_srcIsLocal(false) {}

nsresult nsImapMoveCopyMsgTxn::Init(nsIMsgFolder* srcFolder,
                                    nsTArray<nsMsgKey>* srcKeyArray,
                                    const char* srcMsgIdString,
                                    nsIMsgFolder* dstFolder, bool idsAreUids,
                                    bool isMove) {
  m_srcMsgIdString = srcMsgIdString;
  m_idsAreUids = idsAreUids;
  m_isMove = isMove;
  m_srcFolder = do_GetWeakReference(srcFolder);
  m_dstFolder = do_GetWeakReference(dstFolder);
  m_srcKeyArray = srcKeyArray->Clone();
  nsCString uri;
  nsresult rv = srcFolder->GetURI(uri);
  nsCString protocolType(uri);
  protocolType.SetLength(protocolType.FindChar(':'));
  nsCOMPtr<nsIMsgDatabase> srcDB;
  rv = srcFolder->GetMsgDatabase(getter_AddRefs(srcDB));
  NS_ENSURE_SUCCESS(rv, rv);
  uint32_t i, count = m_srcKeyArray.Length();
  nsCOMPtr<nsIMsgDBHdr> srcHdr;
  nsCOMPtr<nsIMsgDBHdr> copySrcHdr;
  nsCString messageId;

  for (i = 0; i < count; i++) {
    rv = srcDB->GetMsgHdrForKey(m_srcKeyArray[i], getter_AddRefs(srcHdr));
    if (NS_SUCCEEDED(rv)) {
      // ** jt -- only do this for mailbox protocol
      if (protocolType.LowerCaseEqualsLiteral("mailbox")) {
        m_srcIsLocal = true;
        uint32_t msgSize;
        rv = srcHdr->GetMessageSize(&msgSize);
        if (NS_SUCCEEDED(rv)) m_srcSizeArray.AppendElement(msgSize);
        if (isMove) {
#ifdef MOZ_PANORAMA
          if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
            m_srcHdrs.AppendObject(srcHdr);
          } else
#endif
          {
            // Copy the src msgHdrs, but don't add to the db.
            rv = srcDB->CopyHdrFromExistingHdr(nsMsgKey_None, srcHdr, false,
                                               getter_AddRefs(copySrcHdr));
            nsMsgKey pseudoKey = nsMsgKey_None;
            if (NS_SUCCEEDED(rv)) {
              copySrcHdr->GetMessageKey(&pseudoKey);
              m_srcHdrs.AppendObject(copySrcHdr);
            }
          }
        }
      }
      srcHdr->GetMessageId(messageId);
      m_srcMessageIds.AppendElement(messageId);
    }
  }
  return NS_OK;
}

nsImapMoveCopyMsgTxn::~nsImapMoveCopyMsgTxn() {}

NS_IMPL_ISUPPORTS_INHERITED(nsImapMoveCopyMsgTxn, nsMsgTxn, nsIUrlListener)

NS_IMETHODIMP
nsImapMoveCopyMsgTxn::UndoTransaction(void) {
#ifdef MOZ_PANORAMA
  NS_ENSURE_FALSE(mNativeChanging || mNativeRedoPending, NS_ERROR_IN_PROGRESS);
#endif
  nsresult rv;
  nsCOMPtr<nsIImapService> imapService = mozilla::components::Imap::Service();

  bool finishInOnStopRunningUrl = false;

  if (m_isMove || !m_dstFolder) {
    if (m_srcIsLocal) {
      rv = UndoMailboxDelete();
      NS_ENSURE_SUCCESS(rv, rv);
    } else {
      nsCOMPtr<nsIMsgFolder> srcFolder = do_QueryReferent(m_srcFolder, &rv);
      if (NS_FAILED(rv) || !srcFolder) return rv;
      nsCOMPtr<nsIUrlListener> srcListener = do_QueryInterface(srcFolder, &rv);
      if (NS_FAILED(rv)) return rv;
      m_onStopListener = do_GetWeakReference(srcListener);

      // ** make sure we are in the selected state; use lite select
      // folder so we won't hit performance hard
      nsCOMPtr<nsIURI> outUri;
      rv = imapService->LiteSelectFolder(srcFolder, srcListener, nullptr,
                                         getter_AddRefs(outUri));
      if (NS_FAILED(rv)) return rv;
      bool deletedMsgs = true;  // default is true unless imapDelete model
      nsMsgImapDeleteModel deleteModel;
      rv = GetImapDeleteModel(srcFolder, &deleteModel);

      // protect against a bogus undo txn without any source keys
      // see bug #179856 for details
      NS_ASSERTION(!m_srcKeyArray.IsEmpty(), "no source keys");
      if (m_srcKeyArray.IsEmpty()) return NS_ERROR_UNEXPECTED;

      if (!m_srcMsgIdString.IsEmpty()) {
        if (NS_SUCCEEDED(rv) &&
            deleteModel == nsMsgImapDeleteModels::IMAPDelete)
          CheckForToggleDelete(srcFolder, m_srcKeyArray[0], &deletedMsgs);

        if (deletedMsgs)
          rv = imapService->SubtractMessageFlags(
              srcFolder, this, m_srcMsgIdString, kImapMsgDeletedFlag,
              m_idsAreUids);
        else
          rv = imapService->AddMessageFlags(srcFolder, srcListener,
                                            m_srcMsgIdString,
                                            kImapMsgDeletedFlag, m_idsAreUids);
        if (NS_FAILED(rv)) return rv;

        finishInOnStopRunningUrl = true;
        if (deleteModel != nsMsgImapDeleteModels::IMAPDelete)
          nsCOMPtr<nsIURI> outUri;
        rv = imapService->GetHeaders(srcFolder, srcListener,
                                     getter_AddRefs(outUri), m_srcMsgIdString,
                                     true);
      }
    }
  }
  if (!finishInOnStopRunningUrl && !m_dstMsgIdString.IsEmpty()) {
    nsCOMPtr<nsIMsgFolder> dstFolder = do_QueryReferent(m_dstFolder, &rv);
    if (NS_FAILED(rv) || !dstFolder) return rv;

    nsCOMPtr<nsIUrlListener> dstListener;

    dstListener = do_QueryInterface(dstFolder, &rv);
    NS_ENSURE_SUCCESS(rv, rv);
    // ** make sure we are in the selected state; use lite select folder
    // so we won't potentially download a bunch of headers.
    nsCOMPtr<nsIURI> outUri;
    rv = imapService->LiteSelectFolder(dstFolder, dstListener, nullptr,
                                       getter_AddRefs(outUri));
    NS_ENSURE_SUCCESS(rv, rv);
    rv = imapService->AddMessageFlags(dstFolder, dstListener, m_dstMsgIdString,
                                      kImapMsgDeletedFlag, m_idsAreUids);
  }
  return rv;
}

NS_IMETHODIMP
nsImapMoveCopyMsgTxn::RedoTransaction(void) {
#ifdef MOZ_PANORAMA
  NS_ENSURE_FALSE(mNativeChanging || mNativeRedoPending, NS_ERROR_IN_PROGRESS);
#endif
  nsresult rv;
  nsCOMPtr<nsIImapService> imapService = mozilla::components::Imap::Service();
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup() && m_srcIsLocal &&
      m_isMove) {
    MOZ_TRY(ValidateNativeDestinations());
    NS_ENSURE_TRUE(!m_dstMsgIdString.IsEmpty() && !mNativeEntries.IsEmpty(),
                   NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsIMsgFolder> destination = do_QueryReferent(m_dstFolder);
    NS_ENSURE_TRUE(destination && imapService, NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsIUrlListener> listener = do_QueryInterface(destination, &rv);
    MOZ_TRY(rv);
    nsCOMPtr<nsIURI> selected;
    MOZ_TRY(imapService->LiteSelectFolder(destination, listener, nullptr,
                                          getter_AddRefs(selected)));
    nsCOMPtr<nsIMsgFolder> source = do_QueryReferent(m_srcFolder);
    NS_ENSURE_TRUE(source, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(PrepareNativeSources(source));
    mNativeRedoPending = true;
    mNativeRedoUrl = nullptr;
    mNativeRedoListener = listener;
    mNativeRedoResult = NS_ERROR_IN_PROGRESS;
    rv = imapService->SubtractMessageFlags(destination, this, m_dstMsgIdString,
                                           kImapMsgDeletedFlag, m_idsAreUids);
    if (NS_FAILED(rv)) {
      mNativeRedoPending = false;
      mNativeRedoListener = nullptr;
      mNativeRedoResult = rv;
    }
    return rv;
  }
#endif

  if (m_isMove || !m_dstFolder) {
    if (m_srcIsLocal) {
      rv = RedoMailboxDelete();
      if (NS_FAILED(rv)) return rv;
    } else if (!m_srcMsgIdString.IsEmpty()) {
      nsCOMPtr<nsIMsgFolder> srcFolder = do_QueryReferent(m_srcFolder, &rv);
      if (NS_FAILED(rv) || !srcFolder) return rv;
      nsCOMPtr<nsIUrlListener> srcListener = do_QueryInterface(srcFolder, &rv);
      NS_ENSURE_SUCCESS(rv, rv);

      bool deletedMsgs = false;  // default will be false unless
                                 // imapDeleteModel;
      nsMsgImapDeleteModel deleteModel;
      rv = GetImapDeleteModel(srcFolder, &deleteModel);

      // protect against a bogus undo txn without any source keys
      // see bug #179856 for details
      NS_ASSERTION(!m_srcKeyArray.IsEmpty(), "no source keys");
      if (m_srcKeyArray.IsEmpty()) return NS_ERROR_UNEXPECTED;

      if (NS_SUCCEEDED(rv) && deleteModel == nsMsgImapDeleteModels::IMAPDelete)
        rv = CheckForToggleDelete(srcFolder, m_srcKeyArray[0], &deletedMsgs);

      // Make sure we are in the selected state; use lite select
      // folder so performance won't suffer.
      nsCOMPtr<nsIURI> outUri;
      rv = imapService->LiteSelectFolder(srcFolder, srcListener, nullptr,
                                         getter_AddRefs(outUri));
      NS_ENSURE_SUCCESS(rv, rv);
      if (deletedMsgs) {
        rv = imapService->SubtractMessageFlags(
            srcFolder, srcListener, m_srcMsgIdString, kImapMsgDeletedFlag,
            m_idsAreUids);
      } else {
        rv = imapService->AddMessageFlags(srcFolder, srcListener,
                                          m_srcMsgIdString, kImapMsgDeletedFlag,
                                          m_idsAreUids);
      }
    }
  }
  if (!m_dstMsgIdString.IsEmpty()) {
    nsCOMPtr<nsIMsgFolder> dstFolder = do_QueryReferent(m_dstFolder, &rv);
    if (NS_FAILED(rv) || !dstFolder) return rv;

    nsCOMPtr<nsIUrlListener> dstListener;

    dstListener = do_QueryInterface(dstFolder, &rv);
    NS_ENSURE_SUCCESS(rv, rv);
    // ** make sure we are in the selected state; use lite select
    // folder so we won't hit performance hard
    nsCOMPtr<nsIURI> outUri;
    rv = imapService->LiteSelectFolder(dstFolder, dstListener, nullptr,
                                       getter_AddRefs(outUri));
    NS_ENSURE_SUCCESS(rv, rv);
    rv = imapService->SubtractMessageFlags(dstFolder, dstListener,
                                           m_dstMsgIdString,
                                           kImapMsgDeletedFlag, m_idsAreUids);
    NS_ENSURE_SUCCESS(rv, rv);
    nsMsgImapDeleteModel deleteModel;
    rv = GetImapDeleteModel(dstFolder, &deleteModel);
    if (NS_FAILED(rv) || deleteModel == nsMsgImapDeleteModels::MoveToTrash) {
      rv = imapService->GetHeaders(dstFolder, dstListener, nullptr,
                                   m_dstMsgIdString, true);
    }
  }
  return rv;
}

nsresult nsImapMoveCopyMsgTxn::SetCopyResponseUid(const char* aMsgIdString) {
  if (!aMsgIdString) return NS_ERROR_NULL_POINTER;
  m_dstMsgIdString = aMsgIdString;
  if (m_dstMsgIdString.Last() == ']') {
    int32_t len = m_dstMsgIdString.Length();
    m_dstMsgIdString.SetLength(len - 1);
  }
  return NS_OK;
}

nsresult nsImapMoveCopyMsgTxn::GetSrcKeyArray(nsTArray<nsMsgKey>& srcKeyArray) {
  srcKeyArray = m_srcKeyArray.Clone();
  return NS_OK;
}

nsresult nsImapMoveCopyMsgTxn::AddDstKey(nsMsgKey aKey) {
  if (!m_dstMsgIdString.IsEmpty()) m_dstMsgIdString.Append(',');
  m_dstMsgIdString.AppendInt((int32_t)aKey);
  return NS_OK;
}

#ifdef MOZ_PANORAMA
static nsresult CheckNativeUndoMetadata(nsIMsgDBHdr* header,
                                        nsIMsgDBHdr* expected) {
  NS_ENSURE_TRUE(header && expected, NS_ERROR_NOT_AVAILABLE);
#  define CHECK_STRING_FIELD(name)                                  \
    {                                                               \
      nsAutoCString actual, saved;                                  \
      MOZ_TRY(header->Get##name(actual));                           \
      MOZ_TRY(expected->Get##name(saved));                          \
      NS_ENSURE_TRUE(actual.Equals(saved), NS_ERROR_NOT_AVAILABLE); \
    }
  CHECK_STRING_FIELD(Subject);
  CHECK_STRING_FIELD(Author);
  CHECK_STRING_FIELD(Recipients);
  CHECK_STRING_FIELD(CcList);
  CHECK_STRING_FIELD(BccList);
  CHECK_STRING_FIELD(MessageId);
  CHECK_STRING_FIELD(Charset);
#  undef CHECK_STRING_FIELD
  PRTime date, savedDate;
  MOZ_TRY(header->GetDate(&date));
  MOZ_TRY(expected->GetDate(&savedDate));
  NS_ENSURE_TRUE(date == savedDate, NS_ERROR_NOT_AVAILABLE);
  nsMsgPriorityValue priority, savedPriority;
  MOZ_TRY(header->GetPriority(&priority));
  MOZ_TRY(expected->GetPriority(&savedPriority));
  NS_ENSURE_TRUE(priority == savedPriority, NS_ERROR_NOT_AVAILABLE);
  nsTArray<nsCString> properties, savedProperties;
  MOZ_TRY(header->GetProperties(properties));
  MOZ_TRY(expected->GetProperties(savedProperties));
  properties.Sort();
  savedProperties.Sort();
  NS_ENSURE_TRUE(properties == savedProperties, NS_ERROR_NOT_AVAILABLE);
  for (const auto& property : properties) {
    nsAutoCString actual, saved;
    MOZ_TRY(header->GetStringProperty(property.get(), actual));
    MOZ_TRY(expected->GetStringProperty(property.get(), saved));
    NS_ENSURE_TRUE(actual.Equals(saved), NS_ERROR_NOT_AVAILABLE);
  }
  return NS_OK;
}

nsresult nsImapMoveCopyMsgTxn::AppendNativeDestination(uint32_t index,
                                                       nsIMsgFolder* folder,
                                                       uint32_t epoch,
                                                       ImapUid uid,
                                                       nsMsgKey* key) {
  using namespace mozilla::mailnews;
  NS_ENSURE_ARG_POINTER(key);
  NS_ENSURE_FALSE(mNativeChanging, NS_ERROR_IN_PROGRESS);
  NS_ENSURE_TRUE(index < mNativeEntries.Length() && epoch && uid,
                 NS_ERROR_NOT_AVAILABLE);
  RefPtr<nsImapMoveCopyMsgTxn> self(this);
  mozilla::AutoRestore<bool> changing(mNativeChanging);
  mNativeChanging = true;
  auto& entry = *mNativeEntries[index];
  if (entry.destinationHeader) {
    NS_ENSURE_TRUE(
        entry.destinationEpoch == epoch && entry.destinationUid == uid,
        NS_ERROR_NOT_AVAILABLE);
    return entry.destinationHeader->GetMessageKey(key);
  }
  NS_ENSURE_TRUE(entry.metadata && !entry.destinationUid,
                 NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIMsgDatabase> database;
  MOZ_TRY(folder->GetMsgDatabase(getter_AddRefs(database)));
  NS_ENSURE_TRUE(database, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIDBFolderInfo> info;
  MOZ_TRY(database->GetDBFolderInfo(getter_AddRefs(info)));
  uint32_t currentEpoch;
  MOZ_TRY(info->GetImapUidValidity(&currentEpoch));
  NS_ENSURE_TRUE(currentEpoch == epoch, NS_ERROR_NOT_AVAILABLE);
  auto* native = static_cast<PerFolderDatabase*>(database.get());
  nsCOMPtr<nsIMsgFolderNotificationService> notifier =
      mozilla::components::FolderNotification::Service();
  NS_ENSURE_STATE(notifier);
  nsCOMPtr<nsIMsgDBHdr> draft;
  MOZ_TRY(native->CopyHdrForStore(entry.metadata, true, getter_AddRefs(draft)));
  MOZ_TRY(draft->SetUint32Property("uidOnServer", uid));
  MOZ_TRY(folder->GetId(&entry.destinationFolderId));
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  NS_ENSURE_TRUE(core, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(core->GetSourceId(entry.destinationSourceId));
  entry.destinationEpoch = epoch;
  entry.destinationUid = uid;
  // A failed publication is not permission to append or attach a second time.
  MOZ_TRY(
      native->AttachHdr(draft, true, getter_AddRefs(entry.destinationHeader)));
  MOZ_TRY(entry.destinationHeader->GetMessageKey(key));
  if (!m_dstMsgIdString.IsEmpty()) m_dstMsgIdString.Append(',');
  m_dstMsgIdString.AppendInt(uid);
  notifier->NotifyMsgAdded(entry.destinationHeader);
  return NS_OK;
}

nsresult nsImapMoveCopyMsgTxn::ValidateNativeDestinations() {
  using namespace mozilla::mailnews;
  NS_ENSURE_FALSE(WeAreOffline(), NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIMsgFolder> folder = do_QueryReferent(m_dstFolder);
  NS_ENSURE_TRUE(folder && !mNativeEntries.IsEmpty(), NS_ERROR_NOT_AVAILABLE);
  uint64_t folderId;
  MOZ_TRY(folder->GetId(&folderId));
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  NS_ENSURE_TRUE(core, NS_ERROR_NOT_AVAILABLE);
  nsAutoCString sourceId;
  MOZ_TRY(core->GetSourceId(sourceId));
  for (const auto& entry : mNativeEntries) {
    NS_ENSURE_TRUE(entry->destinationHeader &&
                       entry->destinationFolderId == folderId &&
                       entry->destinationSourceId.Equals(sourceId),
                   NS_ERROR_NOT_AVAILABLE);
    nsMsgKey expected, actual;
    MOZ_TRY(entry->destinationHeader->GetMessageKey(&expected));
    nsresult binding = core->MessageDB().GetMessageKeyForServerUid(
        folderId, entry->destinationEpoch, entry->destinationUid, actual);
    MOZ_TRY(binding);
    if (expected != actual) {
      // Normal synchronization can retire and reload a local destination row.
      // The captured incarnation/epoch/UID identify the server member; resolve
      // its current native physical header before preparing the next command.
      nsCOMPtr<nsIMsgDBHdr> current;
      MOZ_TRY(core->MessageDB().GetMessage(actual, getter_AddRefs(current)));
      NS_ENSURE_TRUE(current, NS_ERROR_NOT_AVAILABLE);
      entry->destinationHeader = current;
    }
  }
  return NS_OK;
}

nsresult nsImapMoveCopyMsgTxn::PrepareNativeSources(nsIMsgFolder* folder) {
  return ChangeNativeSources(folder, m_srcKeyArray, false, false);
}

nsresult nsImapMoveCopyMsgTxn::PrepareNativeQueuedSources(
    nsIMsgFolder* folder,
    const mozilla::mailnews::PendingDestination* cancelMove) {
  NS_ENSURE_TRUE(!cancelMove || m_srcKeyArray.Length() == 1,
                 NS_ERROR_INVALID_ARG);
  MOZ_TRY(ChangeNativeSources(folder, m_srcKeyArray, true, false));
  if (cancelMove) {
    auto& entry = *mNativeEntries[0];
    const auto* operation = entry.offline.Operation();
    NS_ENSURE_TRUE(
        operation &&
            (operation->operation & nsIMsgOfflineImapOperation::kMsgMoved) &&
            operation->pendingDestination,
        NS_ERROR_NOT_AVAILABLE);
    const auto& selected = *operation->pendingDestination;
    NS_ENSURE_TRUE(selected.folderId == cancelMove->folderId &&
                       selected.key == cancelMove->key &&
                       selected.epoch == cancelMove->epoch &&
                       selected.epochKnown == cancelMove->epochKnown,
                   NS_ERROR_NOT_AVAILABLE);
    entry.cancelMove.emplace(*cancelMove);
  }
  return NS_OK;
}

nsresult nsImapMoveCopyMsgTxn::RemoveNativeSources(
    nsIMsgFolder* folder, const nsTArray<nsMsgKey>& keys, bool captureOffline) {
  return ChangeNativeSources(folder, keys, captureOffline, true);
}

nsresult nsImapMoveCopyMsgTxn::ChangeNativeSources(
    nsIMsgFolder* folder, const nsTArray<nsMsgKey>& keys, bool captureOffline,
    bool removeSource) {
  using namespace mozilla::mailnews;
  NS_ENSURE_FALSE(mNativeChanging || mNativeRedoPending, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(mNativeInitResult);
  RefPtr<nsImapMoveCopyMsgTxn> self(this);
  mozilla::AutoRestore<bool> changing(mNativeChanging);
  mNativeChanging = true;
  nsCOMPtr<nsIMsgDatabase> database;
  MOZ_TRY(folder->GetMsgDatabase(getter_AddRefs(database)));
  NS_ENSURE_TRUE(database, NS_ERROR_NOT_AVAILABLE);
  auto* native = static_cast<PerFolderDatabase*>(database.get());
  if (mNativeEntries.IsEmpty()) {
    for (nsMsgKey key : m_srcKeyArray) {
      auto entry = mozilla::MakeUnique<NativeImapUndoEntry>();
      entry->originalKey = key;
      mNativeEntries.AppendElement(std::move(entry));
    }
  }
  NS_ENSURE_TRUE(mNativeEntries.Length() == m_srcKeyArray.Length(),
                 NS_ERROR_NOT_AVAILABLE);
  for (nsMsgKey key : keys) {
    auto index = m_srcKeyArray.IndexOf(key);
    NS_ENSURE_TRUE(index != m_srcKeyArray.NoIndex, NS_ERROR_NOT_AVAILABLE);
    auto& entry = *mNativeEntries[index];
    if (entry.removedFromFolder) continue;
    nsCOMPtr<nsIMsgDBHdr> header;
    MOZ_TRY(database->GetMsgHdrForKey(key, getter_AddRefs(header)));
    NS_ENSURE_TRUE(header, NS_ERROR_NOT_AVAILABLE);
    RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
    NS_ENSURE_TRUE(core, NS_ERROR_NOT_AVAILABLE);
    MessageBodyState before;
    MOZ_TRY(core->MessageDB().GetMessageBodyState(key, before));
    if (entry.expectedBody) {
      const auto& expected = *entry.expectedBody;
      NS_ENSURE_TRUE(
          before.databaseSourceId.Equals(expected.databaseSourceId) &&
              before.folderId == expected.folderId &&
              before.contentRevision == expected.contentRevision &&
              before.locationRevision == expected.locationRevision &&
              before.storeToken == expected.storeToken &&
              before.flags == expected.flags &&
              before.messageSize == expected.messageSize &&
              before.offlineMessageSize == expected.offlineMessageSize &&
              before.lineCount == expected.lineCount,
          NS_ERROR_NOT_AVAILABLE);
    }
    if (entry.metadata) {
      MOZ_TRY(CheckNativeUndoMetadata(header, entry.metadata));
      nsTArray<nsCString> references;
      MOZ_TRY(core->MessageDB().GetMessageReferences(key, references));
      NS_ENSURE_TRUE(references == entry.references, NS_ERROR_NOT_AVAILABLE);
    }
    if (!entry.removalStarted) {
      nsCOMPtr<nsIMsgDBHdr> metadata;
      nsTArray<nsCString> references;
      MOZ_TRY(core->MessageDB().GetMessageReferences(key, references));
      MOZ_TRY(database->CopyHdrFromExistingHdr(nsMsgKey_None, header, false,
                                               getter_AddRefs(metadata)));
      nsCOMPtr<nsIFile> recovery;
      MOZ_TRY(GetSpecialDirectoryWithFileName(NS_OS_TEMP_DIR, "imap-undo.eml",
                                              getter_AddRefs(recovery)));
      MOZ_TRY(recovery->CreateUnique(nsIFile::NORMAL_FILE_TYPE, 00600));
      auto remove = mozilla::MakeScopeExit([&] { recovery->Remove(false); });
      nsCOMPtr<nsIInputStream> input;
      MOZ_TRY(folder->GetMsgInputStream(header, getter_AddRefs(input)));
      auto closeInput = mozilla::MakeScopeExit([&] { input->Close(); });
      nsCOMPtr<nsIOutputStream> output;
      MOZ_TRY(MsgNewBufferedFileOutputStream(
          getter_AddRefs(output), recovery, PR_WRONLY | PR_CREATE_FILE, 00600));
      uint64_t bytes;
      nsresult copied = SyncCopyStream(input, output, bytes);
      nsresult readClose = input->Close();
      closeInput.release();
      nsresult writeClose = output->Close();
      MOZ_TRY(copied);
      MOZ_TRY(readClose);
      MOZ_TRY(writeClose);
      NS_ENSURE_TRUE(bytes == ((before.flags & nsMsgMessageFlags::Offline)
                                   ? before.offlineMessageSize
                                   : before.messageSize),
                     NS_ERROR_NOT_AVAILABLE);
      if (entry.recovery) entry.recovery->Remove(false);
      MessageBodyState afterRead;
      MOZ_TRY(core->MessageDB().GetMessageBodyState(key, afterRead));
      NS_ENSURE_TRUE(
          afterRead.databaseSourceId.Equals(before.databaseSourceId) &&
              afterRead.folderId == before.folderId &&
              afterRead.contentRevision == before.contentRevision &&
              afterRead.locationRevision == before.locationRevision &&
              afterRead.storeToken == before.storeToken &&
              afterRead.flags == before.flags &&
              afterRead.messageSize == before.messageSize &&
              afterRead.offlineMessageSize == before.offlineMessageSize &&
              afterRead.lineCount == before.lineCount,
          NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(CheckNativeUndoMetadata(header, metadata));
      nsTArray<nsCString> afterReferences;
      MOZ_TRY(core->MessageDB().GetMessageReferences(key, afterReferences));
      NS_ENSURE_TRUE(references == afterReferences, NS_ERROR_NOT_AVAILABLE);
      entry.references = std::move(references);
      entry.metadata = metadata;
      entry.recovery = recovery;
      entry.expectedBody.emplace(before);
      entry.removalStarted = true;
      remove.release();
    }
    if (captureOffline && !entry.offlineRemoved && !entry.redo.Operation()) {
      nsCOMPtr<nsIMsgOfflineImapOperation> operation;
      MOZ_TRY(
          native->GetOfflineOpForKey(key, false, getter_AddRefs(operation)));
      if (operation) {
        MOZ_TRY(native->CaptureOfflineOperationForUndo(key, entry.offline));
        // The same queued source operation remains replay authority. Native
        // restore validates/rekeys its opaque identity and real counterparts.
      }
      entry.offlineRemoved = true;
    }
    if (!removeSource) continue;
    // Selected Redo owns the original intent. Capturing the canceled live
    // payload here would lose it; native removal validates and reinstalls it
    // with the next full Undo capture before removal callbacks.
    MOZ_TRY(native->RemoveHdrForUndo(
        key, entry.removed, entry.redo.Operation() ? &entry.redo : nullptr,
        entry.redo.Operation() ? &entry.offline : nullptr));
    entry.removedFromFolder = true;
    entry.originalKey = key;
    entry.live = nullptr;
    // The original store bytes are retained as recovery, not reused as the
    // restored location. Native removal accounts their retired storage.
  }
  return NS_OK;
}

nsresult nsImapMoveCopyMsgTxn::RestoreNativeSources(nsIMsgFolder* folder) {
  using namespace mozilla::mailnews;
  NS_ENSURE_FALSE(mNativeChanging || mNativeRedoPending, NS_ERROR_IN_PROGRESS);
  MOZ_TRY(mNativeInitResult);
  RefPtr<nsImapMoveCopyMsgTxn> self(this);
  mozilla::AutoRestore<bool> changing(mNativeChanging);
  mNativeChanging = true;
  NS_ENSURE_TRUE(mNativeEntries.Length() == m_srcKeyArray.Length(),
                 NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIMsgDatabase> database;
  MOZ_TRY(folder->GetMsgDatabase(getter_AddRefs(database)));
  NS_ENSURE_TRUE(database, NS_ERROR_NOT_AVAILABLE);
  auto* native = static_cast<PerFolderDatabase*>(database.get());
  nsCOMPtr<nsIMsgFolderNotificationService> notifier =
      mozilla::components::FolderNotification::Service();
  NS_ENSURE_STATE(notifier);
  nsCOMPtr<nsIMsgPluggableStore> store;
  MOZ_TRY(folder->GetMsgStore(getter_AddRefs(store)));
  for (size_t i = 0; i < mNativeEntries.Length(); ++i) {
    auto& entry = *mNativeEntries[i];
    if (!entry.removedFromFolder) continue;
    NS_ENSURE_TRUE(entry.removed.Body() && entry.recovery,
                   NS_ERROR_NOT_AVAILABLE);
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
      // Once Finish is attempted, neither a repeated Finish nor Discard is
      // authorized by a missing/failed result. Keep the independent recovery.
      discard.release();
      FinishedMessageBody finished;
      entry.finishAttempted = true;
      entry.finishResult =
          store->FinishNewMessage(folder, output, finished.storeToken);
      MOZ_TRY(entry.finishResult);
      entry.finished.emplace(std::move(finished));
    }
    if (!entry.finishedMeasured) {
      auto& finished = *entry.finished;
      MOZ_TRY(ReadStoredMessageDetails(store, folder, finished.storeToken,
                                       &finished.messageSize,
                                       &finished.lineCount));
      nsCOMPtr<nsIMsgIncomingServer> server;
      MOZ_TRY(folder->GetServer(getter_AddRefs(server)));
      nsCString type;
      MOZ_TRY(server->GetLocalDatabaseType(type));
      finished.offline = type.EqualsLiteral("imap");
      finished.offlineMessageSize = finished.offline ? finished.messageSize : 0;
      entry.finishedMeasured = true;
    }
    NS_ENSURE_TRUE(!entry.live, NS_ERROR_IN_PROGRESS);
    MOZ_TRY(native->RestoreHdrForUndo(
        entry.removed, *entry.finished, &m_srcKeyArray[i],
        getter_AddRefs(entry.live),
        entry.offline.Operation() ? &entry.offline : nullptr,
        entry.cancelMove ? &*entry.cancelMove : nullptr,
        entry.cancelMove ? &entry.redo : nullptr));
    // Outputs above are the actual persistent slots observed during native
    // publication. No header lookup or operation SQL follows the commit.
    entry.finished.reset();
    entry.removedFromFolder = false;
    entry.offlineRemoved = false;
    entry.removalStarted = false;
    entry.finishAttempted = false;
    entry.finishResult = NS_OK;
    entry.finishedMeasured = false;
    entry.expectedBody.reset();
    entry.metadata = nullptr;
    notifier->NotifyMsgAdded(entry.live);
  }
  return NS_OK;
}
#endif

nsresult nsImapMoveCopyMsgTxn::UndoMailboxDelete() {
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup() && m_srcIsLocal) {
    MOZ_TRY(ValidateNativeDestinations());
    nsCOMPtr<nsIMsgFolder> folder = do_QueryReferent(m_srcFolder);
    NS_ENSURE_TRUE(folder, NS_ERROR_NOT_AVAILABLE);
    return RestoreNativeSources(folder);
  }
#endif
  nsresult rv = NS_ERROR_FAILURE;
  // ** jt -- only do this for mailbox protocol
  if (m_srcIsLocal) {
    nsCOMPtr<nsIMsgFolder> srcFolder = do_QueryReferent(m_srcFolder, &rv);
    if (NS_FAILED(rv) || !srcFolder) return rv;

    nsCOMPtr<nsIMsgFolder> dstFolder = do_QueryReferent(m_dstFolder, &rv);
    if (NS_FAILED(rv) || !dstFolder) return rv;

    nsCOMPtr<nsIMsgDatabase> srcDB;
    nsCOMPtr<nsIMsgDatabase> dstDB;
    rv = srcFolder->GetMsgDatabase(getter_AddRefs(srcDB));
    if (NS_FAILED(rv)) return rv;
    rv = dstFolder->GetMsgDatabase(getter_AddRefs(dstDB));
    if (NS_FAILED(rv)) return rv;

    uint32_t count = m_srcKeyArray.Length();
    uint32_t i;
    nsCOMPtr<nsIMsgDBHdr> oldHdr;
    nsCOMPtr<nsIMsgDBHdr> newHdr;
    for (i = 0; i < count; i++) {
      oldHdr = m_srcHdrs[i];
      NS_ASSERTION(oldHdr, "fatal ... cannot get old msg header");
      rv = srcDB->CopyHdrFromExistingHdr(m_srcKeyArray[i], oldHdr, true,
                                         getter_AddRefs(newHdr));
      NS_ASSERTION(newHdr, "fatal ... cannot create new header");

      if (NS_SUCCEEDED(rv) && newHdr) {
        if (i < m_srcSizeArray.Length())
          newHdr->SetMessageSize(m_srcSizeArray[i]);
        srcDB->UndoDelete(newHdr);
      }
    }
    srcDB->SetSummaryValid(true);
    return NS_OK;  // always return NS_OK
  }
  return NS_ERROR_FAILURE;
}

nsresult nsImapMoveCopyMsgTxn::RedoMailboxDelete() {
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup() && m_srcIsLocal) {
    nsCOMPtr<nsIMsgFolder> folder = do_QueryReferent(m_srcFolder);
    NS_ENSURE_TRUE(folder, NS_ERROR_NOT_AVAILABLE);
    return RemoveNativeSources(folder, m_srcKeyArray, false);
  }
#endif
  nsresult rv = NS_ERROR_FAILURE;
  if (m_srcIsLocal) {
    nsCOMPtr<nsIMsgDatabase> srcDB;
    nsCOMPtr<nsIMsgFolder> srcFolder = do_QueryReferent(m_srcFolder, &rv);
    if (NS_FAILED(rv) || !srcFolder) return rv;
    rv = srcFolder->GetMsgDatabase(getter_AddRefs(srcDB));
    if (NS_SUCCEEDED(rv)) {
      srcDB->DeleteMessages(m_srcKeyArray, nullptr);
      srcDB->SetSummaryValid(true);
    }
    return NS_OK;  // always return NS_OK
  }
  return NS_ERROR_FAILURE;
}

nsresult nsImapMoveCopyMsgTxn::GetImapDeleteModel(
    nsIMsgFolder* aFolder, nsMsgImapDeleteModel* aDeleteModel) {
  nsresult rv;
  nsCOMPtr<nsIMsgIncomingServer> server;
  if (!aFolder) return NS_ERROR_NULL_POINTER;
  rv = aFolder->GetServer(getter_AddRefs(server));
  NS_ENSURE_SUCCESS(rv, rv);
  nsCOMPtr<nsIImapIncomingServer> imapServer = do_QueryInterface(server, &rv);
  if (NS_SUCCEEDED(rv) && imapServer)
    rv = imapServer->GetDeleteModel(aDeleteModel);
  return rv;
}

NS_IMETHODIMP nsImapMoveCopyMsgTxn::OnStartRunningUrl(nsIURI* aUrl) {
  return NS_OK;
}

NS_IMETHODIMP nsImapMoveCopyMsgTxn::OnStopRunningUrl(nsIURI* aUrl,
                                                     nsresult aExitCode) {
#ifdef MOZ_PANORAMA
  if (mNativeRedoUrl == aUrl && !mNativeRedoPending && aUrl)
    return mNativeRedoResult;
  if (mNativeRedoPending) {
    NS_ENSURE_TRUE(!mNativeRedoUrl || mNativeRedoUrl == aUrl,
                   NS_ERROR_NOT_AVAILABLE);
    mNativeRedoUrl = aUrl;
    nsCOMPtr<nsIImapUrl> url = do_QueryInterface(aUrl);
    nsImapAction action;
    NS_ENSURE_TRUE(url, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(url->GetImapAction(&action));
    NS_ENSURE_TRUE(action == nsIImapUrl::nsImapSubtractMsgFlags,
                   NS_ERROR_NOT_AVAILABLE);
    mNativeRedoPending = false;
    nsCOMPtr<nsIUrlListener> listener = mNativeRedoListener.forget();
    nsresult result = aExitCode;
    if (NS_SUCCEEDED(result)) {
      nsCOMPtr<nsIMsgFolder> source = do_QueryReferent(m_srcFolder);
      result = source ? RemoveNativeSources(source, m_srcKeyArray, false)
                      : NS_ERROR_NOT_AVAILABLE;
    }
    mNativeRedoResult = result;
    if (listener) {
      nsresult notified = listener->OnStopRunningUrl(aUrl, result);
      if (NS_SUCCEEDED(result)) result = notified;
    }
    return result;
  }
#endif
  nsCOMPtr<nsIUrlListener> urlListener = do_QueryReferent(m_onStopListener);
  if (urlListener) urlListener->OnStopRunningUrl(aUrl, aExitCode);

  nsCOMPtr<nsIImapUrl> imapUrl = do_QueryInterface(aUrl);
  if (imapUrl) {
    nsresult rv;
    nsCOMPtr<nsIImapService> imapService = mozilla::components::Imap::Service();
    nsImapAction imapAction;
    imapUrl->GetImapAction(&imapAction);
    nsCOMPtr<nsIMsgFolder> dstFolder = do_QueryReferent(m_dstFolder, &rv);
    NS_ENSURE_SUCCESS(rv, rv);
    nsCOMPtr<nsIMsgFolder> srcFolder = do_QueryReferent(m_srcFolder, &rv);
    NS_ENSURE_SUCCESS(rv, rv);
    if (imapAction == nsIImapUrl::nsImapSubtractMsgFlags) {
      int32_t extraStatus;
      imapUrl->GetExtraStatus(&extraStatus);
      if (extraStatus != nsIImapUrl::ImapStatusNone) {
        // If subtracting the deleted flag didn't work, try
        // moving the message back from the target folder to the src folder
        if (!m_dstMsgIdString.IsEmpty())
          imapService->OnlineMessageCopy(dstFolder, m_dstMsgIdString, srcFolder,
                                         true, true, nullptr, /* listener */
                                         nullptr, nullptr, nullptr);
        else {
          // server doesn't support COPYUID, so we're going to update the dest
          // folder, and when that's done, use the db to find the messages
          // to move back, looking them up by message-id.
          nsCOMPtr<nsIMsgImapMailFolder> imapDest =
              do_QueryInterface(dstFolder);
          if (imapDest) imapDest->UpdateFolderWithListener(nullptr, this);
        }
      } else if (!m_dstMsgIdString.IsEmpty()) {
        nsCOMPtr<nsIUrlListener> dstListener;

        dstListener = do_QueryInterface(dstFolder, &rv);
        NS_ENSURE_SUCCESS(rv, rv);
        // ** make sure we are in the selected state; use lite select folder
        // so we won't potentially download a bunch of headers.
        nsCOMPtr<nsIURI> outUri;
        rv = imapService->LiteSelectFolder(dstFolder, dstListener, nullptr,
                                           getter_AddRefs(outUri));
        NS_ENSURE_SUCCESS(rv, rv);
        rv = imapService->AddMessageFlags(dstFolder, dstListener,
                                          m_dstMsgIdString, kImapMsgDeletedFlag,
                                          m_idsAreUids);
      }
    } else if (imapAction == nsIImapUrl::nsImapSelectFolder) {
      // Now we should have the headers from the dest folder.
      // Look them up and move them back to the source folder.
      nsTArray<ImapUid> dstUids;
      nsCOMPtr<nsIMsgDatabase> destDB;
      rv = dstFolder->GetMsgDatabase(getter_AddRefs(destDB));
      NS_ENSURE_SUCCESS(rv, rv);
      for (auto const& srcMessageId : m_srcMessageIds) {
        nsCOMPtr<nsIMsgDBHdr> dstHdr;
        rv = destDB->GetMsgHdrForMessageID(srcMessageId.get(),
                                           getter_AddRefs(dstHdr));
        if (NS_SUCCEEDED(rv) && dstHdr) {
          nsMsgKey dstKey;
          dstHdr->GetMessageKey(&dstKey);
          ImapUid uid = MOZ_TRY(UidFromMsgKey(destDB, dstKey));
          if (uid != 0) {
            dstUids.AppendElement(uid);
          }
        }
      }
      if (!dstUids.IsEmpty()) {
        nsAutoCString uids;
        rv = imapService->OnlineMessageCopy(dstFolder, UidSetFromUids(dstUids),
                                            srcFolder, true, true, nullptr,
                                            nullptr, nullptr, nullptr);
      }
    }
  }
  return NS_OK;
}

nsImapOfflineTxn::nsImapOfflineTxn(nsIMsgFolder* srcFolder,
                                   nsTArray<nsMsgKey>* srcKeyArray,
                                   const char* srcMsgIdString,
                                   nsIMsgFolder* dstFolder, bool isMove,
                                   nsOfflineImapOperationType opType,
                                   nsCOMArray<nsIMsgDBHdr>& srcHdrs) {
  nsresult initResult =
      Init(srcFolder, srcKeyArray, srcMsgIdString, dstFolder, true, isMove);
#ifdef MOZ_PANORAMA
  mNativeInitResult = initResult;
#endif
  m_opType = opType;
  m_flags = 0;
  m_addFlags = false;
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    m_srcHdrs.Clear();
    m_srcHdrs.AppendObjects(srcHdrs);
    return;
  }
#endif
  if (opType == nsIMsgOfflineImapOperation::kDeletedMsg) {
    nsCOMPtr<nsIMsgDatabase> srcDB;
    nsCOMPtr<nsIDBFolderInfo> folderInfo;

    nsresult rv = srcFolder->GetDBFolderInfoAndDB(getter_AddRefs(folderInfo),
                                                  getter_AddRefs(srcDB));
    if (NS_SUCCEEDED(rv) && srcDB) {
      nsMsgKey pseudoKey;
      nsCOMPtr<nsIMsgDBHdr> copySrcHdr;

      // Imap protocols have conflated key/UUID so we cannot use
      // auto key with them.
      nsCString protocolType;
      srcFolder->GetURI(protocolType);
      protocolType.SetLength(protocolType.FindChar(':'));
      for (int32_t i = 0; i < srcHdrs.Count(); i++) {
        if (protocolType.EqualsLiteral("imap")) {
          srcDB->GetNextPseudoMsgKey(&pseudoKey);
          pseudoKey--;
        } else {
          pseudoKey = nsMsgKey_None;
        }
        rv = srcDB->CopyHdrFromExistingHdr(pseudoKey, srcHdrs[i], false,
                                           getter_AddRefs(copySrcHdr));
        if (NS_SUCCEEDED(rv)) {
          copySrcHdr->GetMessageKey(&pseudoKey);
          m_srcHdrs.AppendObject(copySrcHdr);
        }
      }
    }
  } else
    m_srcHdrs.AppendObjects(srcHdrs);
}

nsImapOfflineTxn::~nsImapOfflineTxn() {}

// Open the database and find the key for the offline operation that we want to
// undo, then remove it from the database, we also hold on to this
// data for a redo operation.
NS_IMETHODIMP nsImapOfflineTxn::UndoTransaction(void) {
#ifdef MOZ_PANORAMA
  NS_ENSURE_FALSE(mNativeChanging || mNativeRedoPending, NS_ERROR_IN_PROGRESS);
#endif
  nsresult rv;

  nsCOMPtr<nsIMsgFolder> srcFolder = do_QueryReferent(m_srcFolder, &rv);
  if (NS_FAILED(rv) || !srcFolder) return rv;
  nsCOMPtr<nsIMsgOfflineImapOperation> op;
  nsCOMPtr<nsIDBFolderInfo> folderInfo;
  nsCOMPtr<nsIMsgDatabase> srcDB;
  nsCOMPtr<nsIMsgDatabase> destDB;

  rv = srcFolder->GetDBFolderInfoAndDB(getter_AddRefs(folderInfo),
                                       getter_AddRefs(srcDB));
  NS_ENSURE_SUCCESS(rv, rv);
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    MOZ_TRY(mNativeInitResult);
    if (m_opType == nsIMsgOfflineImapOperation::kDeletedMsg) {
      return RestoreNativeSources(srcFolder);
    }
    if (m_opType == nsIMsgOfflineImapOperation::kAddedHeader) {
      NS_ENSURE_FALSE(m_srcKeyArray.IsEmpty(), NS_ERROR_NOT_AVAILABLE);
      nsCOMPtr<nsIMsgOfflineOpsDatabase> operations =
          do_QueryInterface(srcDB, &rv);
      MOZ_TRY(rv);
      if (!mNativeEntries.IsEmpty()) {
        return RemoveNativeSources(srcFolder, m_srcKeyArray, true);
      }
      bool anyQueued = false;
      bool anyPlayed = false;
      for (nsMsgKey key : m_srcKeyArray) {
        nsCOMPtr<nsIMsgOfflineImapOperation> operation;
        MOZ_TRY(operations->GetOfflineOpForKey(key, false,
                                               getter_AddRefs(operation)));
        bool played = !operation;
        if (operation) MOZ_TRY(operation->GetPlayingBack(&played));
        anyPlayed |= played;
        anyQueued |= !played;
      }
      NS_ENSURE_FALSE(anyQueued && anyPlayed, NS_ERROR_NOT_AVAILABLE);
      if (!WeAreOffline() && anyPlayed) {
        return nsImapMoveCopyMsgTxn::UndoTransaction();
      }
      return RemoveNativeSources(srcFolder, m_srcKeyArray, true);
    }
  }
#endif

  switch (m_opType) {
    case nsIMsgOfflineImapOperation::kMsgMoved:
    case nsIMsgOfflineImapOperation::kMsgCopy:
    case nsIMsgOfflineImapOperation::kAddedHeader:
    case nsIMsgOfflineImapOperation::kFlagsChanged:
    case nsIMsgOfflineImapOperation::kDeletedMsg: {
      if (m_srcHdrs.IsEmpty()) {
        NS_ASSERTION(false, "No msg header to apply undo.");
        break;
      }
      nsCOMPtr<nsIMsgDBHdr> firstHdr = m_srcHdrs[0];
      nsMsgKey hdrKey;
      firstHdr->GetMessageKey(&hdrKey);
      nsCOMPtr<nsIMsgOfflineOpsDatabase> opsDb = do_QueryInterface(srcDB, &rv);
      NS_ENSURE_SUCCESS(rv, rv);
      rv = opsDb->GetOfflineOpForKey(hdrKey, false, getter_AddRefs(op));
      bool offlineOpPlayedBack = true;
      if (NS_SUCCEEDED(rv) && op) {
        op->GetPlayingBack(&offlineOpPlayedBack);
        opsDb->RemoveOfflineOp(op);
        op = nullptr;
      }
      if (!WeAreOffline() && offlineOpPlayedBack) {
        // couldn't find offline op - it must have been played back already
        // so we should undo the transaction online.
        return nsImapMoveCopyMsgTxn::UndoTransaction();
      }

      if (!firstHdr) break;
      nsMsgKey msgKey;
      if (m_opType == nsIMsgOfflineImapOperation::kAddedHeader) {
        for (int32_t i = 0; i < m_srcHdrs.Count(); i++) {
          m_srcHdrs[i]->GetMessageKey(&msgKey);
          nsCOMPtr<nsIMsgDBHdr> mailHdr;
          rv = srcDB->GetMsgHdrForKey(msgKey, getter_AddRefs(mailHdr));
          if (mailHdr) srcDB->DeleteHeader(mailHdr, nullptr, false, false);
        }
        srcDB->Commit(true);
      } else if (m_opType == nsIMsgOfflineImapOperation::kDeletedMsg) {
        for (int32_t i = 0; i < m_srcHdrs.Count(); i++) {
          nsCOMPtr<nsIMsgDBHdr> undeletedHdr = m_srcHdrs[i];
          m_srcHdrs[i]->GetMessageKey(&msgKey);
          if (undeletedHdr) {
            nsCOMPtr<nsIMsgDBHdr> newHdr;
            srcDB->CopyHdrFromExistingHdr(msgKey, undeletedHdr, true,
                                          getter_AddRefs(newHdr));
          }
        }
        srcDB->Close(true);
        srcFolder->SummaryChanged();
      }
      break;
    }
    case nsIMsgOfflineImapOperation::kMsgMarkedDeleted: {
      nsMsgKey msgKey;
      for (int32_t i = 0; i < m_srcHdrs.Count(); i++) {
        m_srcHdrs[i]->GetMessageKey(&msgKey);
        srcDB->MarkImapDeleted(msgKey, false, nullptr);
      }
    } break;
    default:
      break;
  }
  srcDB->Close(true);
  srcFolder->SummaryChanged();
  return NS_OK;
}

NS_IMETHODIMP nsImapOfflineTxn::RedoTransaction(void) {
#ifdef MOZ_PANORAMA
  NS_ENSURE_FALSE(mNativeChanging || mNativeRedoPending, NS_ERROR_IN_PROGRESS);
#endif
  nsresult rv;

  nsCOMPtr<nsIMsgFolder> srcFolder = do_QueryReferent(m_srcFolder, &rv);
  if (NS_FAILED(rv) || !srcFolder) return rv;
  nsCOMPtr<nsIMsgOfflineImapOperation> op;
  nsCOMPtr<nsIDBFolderInfo> folderInfo;
  nsCOMPtr<nsIMsgDatabase> srcDB;
  nsCOMPtr<nsIMsgDatabase> destDB;
  rv = srcFolder->GetDBFolderInfoAndDB(getter_AddRefs(folderInfo),
                                       getter_AddRefs(srcDB));
  NS_ENSURE_SUCCESS(rv, rv);
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    MOZ_TRY(mNativeInitResult);
    if (m_opType == nsIMsgOfflineImapOperation::kAddedHeader) {
      if (mNativeEntries.IsEmpty())
        return nsImapMoveCopyMsgTxn::RedoTransaction();
      return RestoreNativeSources(srcFolder);
    }
    if (m_opType == nsIMsgOfflineImapOperation::kDeletedMsg) {
      return RemoveNativeSources(srcFolder, m_srcKeyArray, true);
    }
  }
#endif

  switch (m_opType) {
    case nsIMsgOfflineImapOperation::kMsgMoved:
    case nsIMsgOfflineImapOperation::kMsgCopy: {
      nsCOMPtr<nsIMsgOfflineOpsDatabase> opsDb = do_QueryInterface(srcDB, &rv);
      NS_ENSURE_SUCCESS(rv, rv);
      for (int32_t i = 0; i < m_srcHdrs.Count(); i++) {
        nsMsgKey hdrKey;
        m_srcHdrs[i]->GetMessageKey(&hdrKey);
        rv = opsDb->GetOfflineOpForKey(hdrKey, false, getter_AddRefs(op));
        if (NS_SUCCEEDED(rv) && op) {
          nsCOMPtr<nsIMsgFolder> dstFolder = do_QueryReferent(m_dstFolder, &rv);
          if (dstFolder) {
            nsCString folderURI;
            dstFolder->GetURI(folderURI);

            if (m_opType == nsIMsgOfflineImapOperation::kMsgMoved)
              op->SetDestinationFolderURI(folderURI);  // offline move
            if (m_opType == nsIMsgOfflineImapOperation::kMsgCopy) {
              op->SetOperation(nsIMsgOfflineImapOperation::kMsgMoved);
              // NOTE: AddMessageCopyOperation() also sets kMsgCopy.
              op->AddMessageCopyOperation(folderURI);  // offline copy
            }
            dstFolder->SummaryChanged();
          }
        } else if (!WeAreOffline()) {
          // couldn't find offline op - it must have been played back already
          // so we should redo the transaction online.
          return nsImapMoveCopyMsgTxn::RedoTransaction();
        }
      }
      break;
    }
    case nsIMsgOfflineImapOperation::kAddedHeader: {
      nsCOMPtr<nsIMsgFolder> dstFolder = do_QueryReferent(m_dstFolder, &rv);
      rv = srcFolder->GetDBFolderInfoAndDB(getter_AddRefs(folderInfo),
                                           getter_AddRefs(destDB));
      NS_ENSURE_SUCCESS(rv, rv);
      nsCOMPtr<nsIMsgOfflineOpsDatabase> opsDb = do_QueryInterface(destDB, &rv);
      NS_ENSURE_SUCCESS(rv, rv);
      for (int32_t i = 0; i < m_srcHdrs.Count(); i++) {
        nsCOMPtr<nsIMsgDBHdr> restoreHdr;
        nsMsgKey msgKey;
        m_srcHdrs[i]->GetMessageKey(&msgKey);
        destDB->CopyHdrFromExistingHdr(msgKey, m_srcHdrs[i], true,
                                       getter_AddRefs(restoreHdr));
        rv = opsDb->GetOfflineOpForKey(msgKey, true, getter_AddRefs(op));
        if (NS_SUCCEEDED(rv) && op) {
          nsCString folderURI;
          srcFolder->GetURI(folderURI);
          op->SetSourceFolderURI(folderURI);
        }
      }
      dstFolder->SummaryChanged();
      destDB->Close(true);
    } break;
    case nsIMsgOfflineImapOperation::kDeletedMsg:
      for (int32_t i = 0; i < m_srcHdrs.Count(); i++) {
        nsMsgKey msgKey;
        m_srcHdrs[i]->GetMessageKey(&msgKey);
        srcDB->DeleteMessage(msgKey, nullptr, true);
      }
      break;
    case nsIMsgOfflineImapOperation::kMsgMarkedDeleted:
      for (int32_t i = 0; i < m_srcHdrs.Count(); i++) {
        nsMsgKey msgKey;
        m_srcHdrs[i]->GetMessageKey(&msgKey);
        srcDB->MarkImapDeleted(msgKey, true, nullptr);
      }
      break;
    case nsIMsgOfflineImapOperation::kFlagsChanged: {
      nsCOMPtr<nsIMsgOfflineOpsDatabase> opsDb = do_QueryInterface(srcDB, &rv);
      NS_ENSURE_SUCCESS(rv, rv);
      for (int32_t i = 0; i < m_srcHdrs.Count(); i++) {
        nsMsgKey msgKey;
        m_srcHdrs[i]->GetMessageKey(&msgKey);
        rv = opsDb->GetOfflineOpForKey(msgKey, true, getter_AddRefs(op));
        if (NS_SUCCEEDED(rv) && op) {
          imapMessageFlagsType newMsgFlags;
          op->GetNewFlags(&newMsgFlags);
          if (m_addFlags)
            op->SetFlagOperation(newMsgFlags | m_flags);
          else
            op->SetFlagOperation(newMsgFlags & ~m_flags);
        }
      }
      break;
    }
    default:
      break;
  }
  srcDB->Close(true);
  srcDB = nullptr;
  srcFolder->SummaryChanged();
  return NS_OK;
}
