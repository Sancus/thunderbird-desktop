/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsNewsFolder.h"

#include <utility>

#include "nsIDBFolderInfo.h"
#include "prlog.h"
#include "prtime.h"

#include "msgCore.h"  // precompiled header...
#include "nsIMsgMailNewsUrl.h"
#include "nsMsgFolderFlags.h"
#include "MailNewsTypes.h"
#include "prprf.h"
#include "prsystem.h"
#include "nsTArray.h"
#include "nsINntpService.h"
#include "nsIMsgFilterService.h"
#include "nsCOMPtr.h"
#include "nsMsgUtils.h"

#include "nsIMsgIncomingServer.h"
#include "nsINntpIncomingServer.h"
#include "nsINewsDatabase.h"
#include "nsILineInputStream.h"

#include "nsIMsgWindow.h"

#include "nsLocalFile.h"
#include "nsNetUtil.h"
#include "nsIURL.h"
#include "nsNetCID.h"

#include "nsMsgI18N.h"

#include "nsIMsgFolderNotificationService.h"
#include "mozilla/Components.h"
#include "mozilla/Preferences.h"
#include "mozilla/ScopeExit.h"
#include "nsIInputStream.h"
#include "nsIURIMutator.h"

#ifdef MOZ_PANORAMA
#  include "DatabaseCore.h"
#  include "MigrationWriterLease.h"
#  include "FolderDatabase.h"
#  include "PerFolderDatabase.h"
#  include "../../local/src/nsLocalUtils.h"
#  include "nsMsgLocalStoreUtils.h"
#  include "nsPrintfCString.h"
#  include "nsIMsgSearchSession.h"
#  include "nsIMsgSearchNotify.h"
#  include "nsIMsgSearchTerm.h"
#  include "nsIMsgSearchValue.h"
#  include "nsMsgSearchCore.h"
#  include "nsQueryObject.h"
#  include "mozilla/CheckedInt.h"
#  include "mozilla/ResultExtensions.h"
#  include "mozilla/StaticPrefs_mail.h"
#endif

#define kNewsRootURI "news:/"
#define kNewsMessageRootURI "news-message:/"

using mozilla::Preferences;

#ifdef MOZ_PANORAMA
// The existing folder API has a completion listener, while the legacy service's
// folder downloader is void. Keep this native operation on those existing
// search/URL interfaces so queue admission cannot be reported as body success.
class nsMsgNewsFolder::NativeDownload final : public nsIMsgSearchNotify,
                                              public nsIUrlListener {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIMSGSEARCHNOTIFY
  NS_DECL_NSIURLLISTENER

  NativeDownload(nsMsgNewsFolder* folder, nsIUrlListener* listener,
                 nsIMsgWindow* window)
      : mFolder(folder), mListener(listener), mWindow(window) {}

  nsresult Start() {
    RefPtr<nsMsgNewsFolder> folder = mFolder;
    NS_ENSURE_FALSE(folder->m_downloadMessageForOfflineUse, NS_MSG_FOLDER_BUSY);
    mPreviousSaveOffline = folder->m_downloadMessageForOfflineUse;
    folder->m_downloadMessageForOfflineUse = true;
    mOwnsSaveOffline = true;
    MOZ_TRY(folder->GetDatabase());
    NS_ENSURE_FALSE(mDone, NS_BINDING_ABORTED);
    mDatabase = folder->mDatabase;
    mNative = do_QueryObject(mDatabase);
    NS_ENSURE_TRUE(mNative, NS_ERROR_NOT_AVAILABLE);
    nsresult rv;
    nsCOMPtr<nsIDatabaseCore> core =
        do_GetService("@mozilla.org/mailnews/database-core;1", &rv);
    MOZ_TRY(rv);
    MOZ_TRY(core->GetSourceId(mSourceId));
    mService = do_GetService("@mozilla.org/messenger/nntpservice;1", &rv);
    MOZ_TRY(rv);
    mSearch = do_CreateInstance("@mozilla.org/messenger/searchSession;1", &rv);
    MOZ_TRY(rv);
    nsCOMPtr<nsIMsgDownloadSettings> settings;
    MOZ_TRY(mFolder->GetDownloadSettings(getter_AddRefs(settings)));
    bool unreadOnly, byDate;
    uint32_t days;
    MOZ_TRY(settings->GetDownloadUnreadOnly(&unreadOnly));
    MOZ_TRY(settings->GetDownloadByDate(&byDate));
    MOZ_TRY(settings->GetAgeLimitOfMsgsToDownload(&days));
    if (unreadOnly) {
      MOZ_TRY(AddTerm(nsMsgSearchAttrib::MsgStatus, nsMsgSearchOp::Isnt,
                      nsMsgMessageFlags::Read));
    }
    if (byDate) {
      MOZ_TRY(AddTerm(nsMsgSearchAttrib::AgeInDays, nsMsgSearchOp::IsLessThan,
                      days));
    }
    MOZ_TRY(AddTerm(nsMsgSearchAttrib::MsgStatus, nsMsgSearchOp::Isnt,
                    nsMsgMessageFlags::Offline));
    nsCOMPtr<nsIMsgIncomingServer> server;
    MOZ_TRY(mFolder->GetServer(getter_AddRefs(server)));
    bool limitSize;
    int32_t maxSize;
    MOZ_TRY(server->GetLimitOfflineMessageSize(&limitSize));
    MOZ_TRY(server->GetMaxMessageSize(&maxSize));
    if (limitSize && maxSize > 0) {
      MOZ_TRY(AddTerm(nsMsgSearchAttrib::Size, nsMsgSearchOp::IsLessThan,
                      static_cast<uint32_t>(maxSize)));
    }
    MOZ_TRY(mSearch->AddScopeTerm(nsMsgSearchScope::localNews, mFolder));
    if (mListener) {
      MOZ_TRY(mListener->OnStartRunningUrl(nullptr));
    }
    NS_ENSURE_FALSE(mDone, NS_BINDING_ABORTED);
    MOZ_TRY(
        mSearch->RegisterListener(this, nsIMsgSearchSession::allNotifications));
    nsCOMPtr<nsIMsgSearchSession> search = mSearch;
    return search->Search(mWindow);
  }

  void Cancel() { Complete(NS_BINDING_ABORTED); }

  void Complete(nsresult status) {
    if (mDone) return;
    RefPtr<NativeDownload> self(this);
    mDone = true;
    if (mSearch) {
      nsCOMPtr<nsIMsgSearchSession> search;
      search.swap(mSearch);
      search->UnregisterListener(this);
      search->InterruptSearch();
    }
    RefPtr<nsMsgNewsFolder> folder;
    folder.swap(mFolder);
    if (folder && folder->mNativeDownload == this) {
      if (mOwnsSaveOffline) {
        folder->m_downloadMessageForOfflineUse = mPreviousSaveOffline;
      }
      folder->mNativeDownload = nullptr;
    }
    nsCOMPtr<nsIUrlListener> listener;
    listener.swap(mListener);
    mCurrentUri = nullptr;
    if (listener) {
      listener->OnStopRunningUrl(nullptr, status);
    } else if (NS_FAILED(status)) {
      NS_WARNING("Native news offline download failed");
    }
  }

 private:
  ~NativeDownload() = default;

  nsresult AddTerm(nsMsgSearchAttribValue attribute, nsMsgSearchOpValue op,
                   uint32_t number) {
    nsCOMPtr<nsIMsgSearchTerm> term;
    MOZ_TRY(mSearch->CreateTerm(getter_AddRefs(term)));
    nsCOMPtr<nsIMsgSearchValue> value;
    MOZ_TRY(term->GetValue(getter_AddRefs(value)));
    MOZ_TRY(value->SetAttrib(attribute));
    if (attribute == nsMsgSearchAttrib::MsgStatus) {
      MOZ_TRY(value->SetStatus(number));
    } else if (attribute == nsMsgSearchAttrib::AgeInDays) {
      MOZ_TRY(value->SetAge(number));
    } else {
      MOZ_TRY(value->SetSize(number));
    }
    return mSearch->AddSearchTerm(attribute, op, value, true, nullptr);
  }

  nsresult Next() {
    if (mDone) return NS_OK;
    NS_ENSURE_TRUE(mFolder->mDatabase == mDatabase &&
                       mFolder->m_downloadMessageForOfflineUse,
                   NS_ERROR_NOT_AVAILABLE);
    nsresult rv;
    nsCOMPtr<nsIDatabaseCore> core =
        do_GetService("@mozilla.org/mailnews/database-core;1", &rv);
    MOZ_TRY(rv);
    nsCString source;
    MOZ_TRY(core->GetSourceId(source));
    NS_ENSURE_TRUE(source == mSourceId, NS_ERROR_NOT_AVAILABLE);
    if (mIndex == mKeys.Length()) {
      Complete(NS_OK);
      return NS_OK;
    }
    mozilla::mailnews::NewsArticleIdentity article;
    MOZ_TRY(mNative->GetNewsArticleLocation(mKeys[mIndex], article));
    // fetchMessage's existing nsIURI result identifies this exact pending call.
    return mService->FetchMessage(mFolder, mKeys[mIndex++], mWindow, nullptr,
                                  this, getter_AddRefs(mCurrentUri));
  }

  RefPtr<nsMsgNewsFolder> mFolder;
  nsCOMPtr<nsIUrlListener> mListener;
  nsCOMPtr<nsIMsgWindow> mWindow;
  nsCOMPtr<nsIMsgDatabase> mDatabase;
  RefPtr<mozilla::mailnews::PerFolderDatabase> mNative;
  nsCOMPtr<nsINntpService> mService;
  nsCOMPtr<nsIMsgSearchSession> mSearch;
  nsCOMPtr<nsIURI> mCurrentUri;
  nsTArray<nsMsgKey> mKeys;
  nsCString mSourceId;
  uint32_t mIndex{0};
  nsresult mSelectionError{NS_OK};
  bool mPreviousSaveOffline{false};
  bool mOwnsSaveOffline{false};
  bool mDone{false};
};

NS_IMPL_ISUPPORTS(nsMsgNewsFolder::NativeDownload, nsIMsgSearchNotify,
                  nsIUrlListener)

NS_IMETHODIMP nsMsgNewsFolder::NativeDownload::OnNewSearch() { return NS_OK; }

NS_IMETHODIMP nsMsgNewsFolder::NativeDownload::OnSearchHit(
    nsIMsgDBHdr* header, nsIMsgFolder* folder) {
  if (mDone || NS_FAILED(mSelectionError)) return NS_OK;
  mSelectionError = [&]() -> nsresult {
    NS_ENSURE_TRUE(folder == static_cast<nsIMsgFolder*>(mFolder.get()),
                   NS_ERROR_NOT_AVAILABLE);
    nsMsgKey key;
    bool killed, ignored;
    uint32_t flags;
    MOZ_TRY(header->GetMessageKey(&key));
    MOZ_TRY(header->GetFlags(&flags));
    MOZ_TRY(header->GetIsKilled(&killed));
    MOZ_TRY(mDatabase->IsIgnored(key, &ignored));
    if ((flags & nsMsgMessageFlags::Offline) || killed || ignored) return NS_OK;
    mozilla::mailnews::NewsArticleIdentity article;
    MOZ_TRY(mNative->GetNewsArticleLocation(key, article));
    mKeys.AppendElement(key);
    return NS_OK;
  }();
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::NativeDownload::OnSearchDone(nsresult status) {
  if (mDone) return NS_OK;
  RefPtr<NativeDownload> self(this);
  nsCOMPtr<nsIMsgSearchSession> search;
  search.swap(mSearch);
  if (search) search->UnregisterListener(this);
  if (NS_FAILED(mSelectionError)) status = mSelectionError;
  if (NS_SUCCEEDED(status)) {
    status = Next();
  }
  if (NS_FAILED(status)) Complete(status);
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::NativeDownload::OnStartRunningUrl(nsIURI* uri) {
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::NativeDownload::OnStopRunningUrl(
    nsIURI* uri, nsresult status) {
  if (mDone || uri != mCurrentUri) return NS_OK;
  RefPtr<NativeDownload> self(this);
  mCurrentUri = nullptr;
  if (NS_SUCCEEDED(status)) status = Next();
  if (NS_FAILED(status)) Complete(status);
  return NS_OK;
}
#endif

nsresult nsMsgNewsFolder::CheckMigrationWriterAdmission() {
#ifdef MOZ_PANORAMA
  return mozilla::mailnews::CheckMigrationWriter(
      mozilla::mailnews::MigrationWriterDomain::News);
#else
  return NS_OK;
#endif
}

nsMsgNewsFolder::nsMsgNewsFolder(void)
    : mExpungedBytes(0),
      mGettingNews(false),
      mInitialized(false),
      m_downloadMessageForOfflineUse(false),
      mReadSet(nullptr) {
  mFolderSize = kSizeUnknown;
}

nsMsgNewsFolder::~nsMsgNewsFolder(void) {
#ifdef MOZ_PANORAMA
  // The base destructor cannot dispatch to our Shutdown after members die.
  DetachNativeReadSet();
#endif
}

NS_IMPL_ADDREF_INHERITED(nsMsgNewsFolder, nsMsgDBFolder)
NS_IMPL_RELEASE_INHERITED(nsMsgNewsFolder, nsMsgDBFolder)

NS_IMETHODIMP nsMsgNewsFolder::QueryInterface(REFNSIID aIID,
                                              void** aInstancePtr) {
  if (!aInstancePtr) return NS_ERROR_NULL_POINTER;
  *aInstancePtr = nullptr;

#ifdef MOZ_PANORAMA
  if (aIID.Equals(NS_GET_IID(nsMsgNewsFolder)))
    *aInstancePtr = static_cast<nsMsgNewsFolder*>(this);
#endif
  if (aIID.Equals(NS_GET_IID(nsIMsgNewsFolder)))
    *aInstancePtr = static_cast<nsIMsgNewsFolder*>(this);
  if (*aInstancePtr) {
    AddRef();
    return NS_OK;
  }

  return nsMsgDBFolder::QueryInterface(aIID, aInstancePtr);
}

////////////////////////////////////////////////////////////////////////////////

nsresult nsMsgNewsFolder::CreateSubFolders(nsIFile* path) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  nsresult rv;
  bool isNewsServer = false;
  rv = GetIsServer(&isNewsServer);
  if (NS_FAILED(rv)) return rv;

  if (isNewsServer) {
    nsCOMPtr<nsINntpIncomingServer> nntpServer;
    rv = GetNntpServer(getter_AddRefs(nntpServer));
    NS_ENSURE_SUCCESS(rv, rv);

    rv = nntpServer->GetNewsrcFilePath(getter_AddRefs(mNewsrcFilePath));
    NS_ENSURE_SUCCESS(rv, rv);

    rv = LoadNewsrcFileAndCreateNewsgroups();
  } else  // is not a host, so it has no newsgroups.  (what about categories??)
    rv = NS_OK;
  return rv;
}

NS_IMETHODIMP
nsMsgNewsFolder::AddNewsgroup(const nsACString& name, const nsACString& setStr,
                              nsIMsgFolder** child) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  NS_ENSURE_ARG_POINTER(child);
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    return AddNewsgroupWithFolderId(name, setStr, child);
  }
#endif
  nsresult rv;

  nsCOMPtr<nsINntpIncomingServer> nntpServer;
  rv = GetNntpServer(getter_AddRefs(nntpServer));
  if (NS_FAILED(rv)) return rv;

  nsAutoCString uri(mURI);
  uri.Append('/');
  // URI should use UTF-8
  // (see RFC2396 Uniform Resource Identifiers (URI): Generic Syntax)

  nsAutoCString escapedName;
  rv = MsgEscapeString(name, nsINetUtil::ESCAPE_URL_PATH, escapedName);
  if (NS_FAILED(rv)) return rv;

  rv = nntpServer->AddNewsgroup(name);
  if (NS_FAILED(rv)) return rv;

  uri.Append(escapedName);

  nsCOMPtr<nsIMsgFolder> folder;
  rv = GetOrCreateFolder(uri, getter_AddRefs(folder));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIMsgNewsFolder> newsFolder(do_QueryInterface(folder, &rv));
  NS_ENSURE_SUCCESS(rv, rv);

  // Ensure any containing .sdb dir exists.
  nsCOMPtr<nsIFile> path;
  rv = CreateDirectoryForFolder(getter_AddRefs(path));
  NS_ENSURE_SUCCESS(rv, rv);

  // cache this for when we open the db
  rv = newsFolder->SetReadSetFromStr(setStr);

  rv = folder->SetParent(this);
  NS_ENSURE_SUCCESS(rv, rv);

  // this what shows up in the UI
  rv = folder->SetName(name);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = folder->SetFlag(nsMsgFolderFlags::Newsgroup);
  if (NS_FAILED(rv)) return rv;

  mSubFolders.AppendObject(folder);
  folder->SetParent(this);
  folder.forget(child);
  return rv;
}

#ifdef MOZ_PANORAMA
nsresult nsMsgNewsFolder::AddNewsgroupWithFolderId(const nsACString& name,
                                                   const nsACString& setStr,
                                                   nsIMsgFolder** child,
                                                   bool passive) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  *child = nullptr;
  NS_ENSURE_STATE(mFolderId);
  NS_ENSURE_ARG(!name.IsEmpty());
  RefPtr<mozilla::mailnews::DatabaseCore> core =
      mozilla::mailnews::DatabaseCore::GetInstanceForService();
  auto& folderDB = core->FolderDB();
  uint64_t id = MOZ_TRY(folderDB.GetFolderChildNamed(mFolderId, name));
  if (!id) {
    MOZ_TRY(folderDB.InsertFolder(mFolderId, name, &id));
  }

  // The native database captures its protocol at opening. Publish the group
  // flag before SetFlag can reenter database initialization via summary counts.
  uint32_t flags = MOZ_TRY(folderDB.GetFolderFlags(id));
  if (!(flags & nsMsgFolderFlags::Newsgroup)) {
    MOZ_TRY(folderDB.UpdateFlags(id, flags | nsMsgFolderFlags::Newsgroup));
  }
  nsCOMPtr<nsIFile> path;
  MOZ_TRY(CreateDirectoryForFolder(getter_AddRefs(path)));
  nsCOMPtr<nsIMsgFolder> folder;
  MOZ_TRY(GetCachedChild(id, getter_AddRefs(folder)));
  nsresult rv;
  if (!folder) {
    folder =
        do_CreateInstance("@mozilla.org/mail/folder-factory;1?name=news", &rv);
    NS_ENSURE_SUCCESS(rv, rv);
    MOZ_TRY(folder->InitWithFolderId(id));
    MOZ_TRY(folder->SetParent(this));
  }
  nsCOMPtr<nsIMsgNewsFolder> newsFolder = do_QueryInterface(folder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  MOZ_TRY(folder->SetFlag(nsMsgFolderFlags::Newsgroup));
  if (passive) {
    RefPtr<nsMsgNewsFolder> native = do_QueryObject(folder, &rv);
    NS_ENSURE_SUCCESS(rv, rv);
    MOZ_TRY(native->SetNativeReadSetFromStr(setStr, true));
  } else {
    MOZ_TRY(newsFolder->SetReadSetFromStr(setStr));
  }

  nsCOMPtr<nsINntpIncomingServer> nntpServer;
  MOZ_TRY(GetNntpServer(getter_AddRefs(nntpServer)));
  MOZ_TRY(nntpServer->AddNewsgroup(name));
  if (passive && mSubFolders.Contains(folder)) {
    // Native restoration populated these retained children before newsrc was
    // read. Replay its subscription order without replacing their identities.
    // Prepare the new position before releasing the old array membership.
    NS_ENSURE_TRUE(mSubFolders.AppendObject(folder), NS_ERROR_OUT_OF_MEMORY);
    mSubFolders.RemoveObject(folder);
  } else if (!mSubFolders.Contains(folder)) {
    NS_ENSURE_TRUE(mSubFolders.AppendObject(folder), NS_ERROR_OUT_OF_MEMORY);
  }
  folder.forget(child);
  return NS_OK;
}
#endif

nsresult nsMsgNewsFolder::ParseFolder(nsIFile* path) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

nsresult nsMsgNewsFolder::AddDirectorySeparator(nsIFile* path) {
  // don't concat the full separator with .sbd
  return (mURI.Equals(kNewsRootURI))
             ? NS_OK
             : nsMsgDBFolder::AddDirectorySeparator(path);
}

NS_IMETHODIMP
nsMsgNewsFolder::GetSubFolders(nsTArray<RefPtr<nsIMsgFolder>>& folders) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  if (!mInitialized) {
    // do this first, so we make sure to do it, even on failure.
    // see bug #70494
    mInitialized = true;

    nsCOMPtr<nsIFile> path;
    nsresult rv = GetFilePath(getter_AddRefs(path));
    if (NS_FAILED(rv)) return rv;

    rv = CreateSubFolders(path);
    if (NS_FAILED(rv)) {
#ifdef MOZ_PANORAMA
      if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
        // A partial newsrc load cannot authorize a rewrite of its source file.
        // Keep the reentrancy guard during loading, then retry on next access.
        mInitialized = false;
      }
#endif
      return rv;
    }

    // force ourselves to get initialized from cache
    // Don't care if it fails.  this will fail the first time after
    // migration, but we continue on.  see #66018
    (void)UpdateSummaryTotals(false);
  }

  return nsMsgDBFolder::GetSubFolders(folders);
}

// Makes sure the database is open and exists.  If the database is valid then
// returns NS_OK.  Otherwise returns a failure error value.
nsresult nsMsgNewsFolder::GetDatabase() {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    return GetNativeDatabase();
  }
#endif
  nsresult rv;
  if (!mDatabase) {
    nsCOMPtr<nsIMsgDBService> msgDBService =
        do_GetService("@mozilla.org/msgDatabase/msgDBService;1", &rv);
    NS_ENSURE_SUCCESS(rv, rv);

    nsCOMPtr<nsIMsgDatabase> database;
    rv = msgDBService->OpenFolderDB(this, false, getter_AddRefs(database));
    if (NS_FAILED(rv) && !mDatabase) {
      rv = msgDBService->CreateNewDB(this, getter_AddRefs(database));
    }
    NS_ENSURE_SUCCESS(rv, rv);

    nsCOMPtr<nsINewsDatabase> db = do_QueryInterface(database, &rv);
    NS_ENSURE_SUCCESS(rv, rv);
    nsMsgKeySet* previousSet = nullptr;
    rv = db->GetReadSet(&previousSet);
    NS_ENSURE_SUCCESS(rv, rv);
    RefPtr<nsMsgKeySet> readSet = mReadSet;
#ifdef MOZ_PANORAMA
    const bool native = mozilla::StaticPrefs::mail_panorama_enabled_AtStartup();
    nsCOMPtr<nsINewsDatabase> previousBinding = mReadSetDatabase;
    RefPtr<mozilla::mailnews::PerFolderDatabase> nativeDB;
    if (native) {
      nativeDB = do_QueryObject(db, &rv);
      NS_ENSURE_SUCCESS(rv, rv);
    }
#endif
    NS_ENSURE_TRUE(!mDatabase, NS_ERROR_IN_PROGRESS);

    // Summary updates re-enter through GetDBFolderInfoAndDB.
    mDatabase = database;
    bool listenerAdded = false;
    bool readSetAttempted = false;
    auto cleanup = mozilla::MakeScopeExit([&] {
      if (listenerAdded) {
        if (NS_FAILED(database->RemoveListener(this))) {
          NS_WARNING("Failed to detach news database listener");
        }
      }
#ifdef MOZ_PANORAMA
      if (native && readSetAttempted) {
        if (readSet != previousSet) {
          nativeDB->DetachNewsReadSetIfMatches(readSet);
        }
      } else
#endif
          if (readSetAttempted) {
        nsMsgKeySet* currentSet = nullptr;
        nsresult cleanupRv = db->GetReadSet(&currentSet);
        if (NS_SUCCEEDED(cleanupRv) && currentSet == readSet.get() &&
            currentSet != previousSet) {
          cleanupRv = db->SetReadSet(nullptr);
        }
        NS_WARNING_ASSERTION(NS_SUCCEEDED(cleanupRv),
                             "Failed to clear news database read set");
      }
#ifdef MOZ_PANORAMA
      if (native && mReadSetDatabase == db && mReadSet == readSet) {
        mReadSetDatabase = previousBinding;
      }
#endif
      if (mDatabase == database) {
        mDatabase = nullptr;
      }
    });
    if (mAddListener) {
      rv = database->AddListener(this);
      NS_ENSURE_SUCCESS(rv, rv);
      listenerAdded = true;
      NS_ENSURE_TRUE(mDatabase == database, NS_ERROR_IN_PROGRESS);
    }
    readSetAttempted = true;
#ifdef MOZ_PANORAMA
    if (native) {
      mReadSetDatabase = db;
    }
#endif
#ifdef MOZ_PANORAMA
    if (native && mPendingNewsrcReadSet.isSome()) {
      rv = nativeDB->InitializeNewsReadSetFromNewsrc(readSet,
                                                     *mPendingNewsrcReadSet);
      if (NS_SUCCEEDED(rv) && mReadSet == readSet && mReadSetDatabase == db) {
        mPendingNewsrcReadSet.reset();
      }
    } else
#endif
    {
      rv = db->SetReadSet(readSet);
    }
    NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(mDatabase == database, NS_ERROR_IN_PROGRESS);

    rv = UpdateSummaryTotals(true);
    NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(mDatabase == database, NS_ERROR_IN_PROGRESS);
    cleanup.release();
  }
  nsCOMPtr<nsINewsDatabase> db = do_QueryInterface(mDatabase, &rv);
  (void)db;
  return rv;
}

NS_IMETHODIMP
nsMsgNewsFolder::UpdateFolder(nsIMsgWindow* aWindow) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  // Get news.get_messages_on_select pref

  // Only if news.get_messages_on_select is true do we get new messages
  // automatically
  if (Preferences::GetBool("news.get_messages_on_select", true)) {
    nsresult rv = GetDatabase();  // want this cached...
    if (NS_SUCCEEDED(rv)) {
      if (mDatabase) {
        nsCOMPtr<nsIMsgRetentionSettings> retentionSettings;
        nsresult rv = GetRetentionSettings(getter_AddRefs(retentionSettings));
        if (NS_SUCCEEDED(rv))
          rv = mDatabase->ApplyRetentionSettings(retentionSettings, false);
      }
      // GetNewMessages has to be the last rv set before we get to the next
      // check, so that we'll have rv set to NS_MSG_ERROR_OFFLINE when offline
      // and send a folder loaded notification to the front end.
      rv = GetNewMessages(aWindow, nullptr);
    }
    if (rv != NS_MSG_ERROR_OFFLINE) {
      // For the server root folder there are no running URLs that will fire
      // kFolderLoaded, so notify immediately.
      // For newsgroup folders, nsMsgDBFolder::OnStopRunningUrl fires
      // kFolderLoaded when the async download completes.
      bool isNewsServer = false;
      GetIsServer(&isNewsServer);
      if (isNewsServer) {
        NotifyFolderEvent(kFolderLoaded);
      }
      return rv;
    }
  }
  // We're not getting messages because either get_messages_on_select is
  // false or we're offline. Send an immediate folder loaded notification.
  NotifyFolderEvent(kFolderLoaded);
  (void)RefreshSizeOnDisk();
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::GetCanSubscribe(bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = false;

  bool isNewsServer = false;
  nsresult rv = GetIsServer(&isNewsServer);
  if (NS_FAILED(rv)) return rv;

  // you can only subscribe to news servers, not news groups
  *aResult = isNewsServer;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::GetCanFileMessages(bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  // you can't file messages into a news server or news group
  *aResult = false;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::GetCanCreateSubfolders(bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = false;
  // you can't create subfolders on a news server or a news group
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::GetCanRename(bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = false;
  // you can't rename a news server or a news group
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::GetCanCompact(bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = false;
  // you can't compact a news server or a news group
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::SetNewsrcHasChanged(bool newsrcHasChanged) {
  nsresult rv;

  nsCOMPtr<nsINntpIncomingServer> nntpServer;
  rv = GetNntpServer(getter_AddRefs(nntpServer));
  if (NS_FAILED(rv)) return rv;
  return nntpServer->SetNewsrcHasChanged(newsrcHasChanged);
}

NS_IMETHODIMP nsMsgNewsFolder::CreateSubfolder(const nsACString& newsgroupName,
                                               nsIMsgWindow* msgWindow) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  nsresult rv = NS_OK;
  if (newsgroupName.IsEmpty()) return NS_MSG_ERROR_INVALID_FOLDER_NAME;

  nsCOMPtr<nsIMsgFolder> child;
  // Now let's create the actual new folder
  rv = AddNewsgroup(newsgroupName, EmptyCString(), getter_AddRefs(child));

  if (NS_SUCCEEDED(rv))
    SetNewsrcHasChanged(true);  // subscribe UI does this - but maybe we got
                                // here through auto-subscribe

  if (NS_SUCCEEDED(rv) && child) {
    nsCOMPtr<nsINntpIncomingServer> nntpServer;
    rv = GetNntpServer(getter_AddRefs(nntpServer));
    if (NS_FAILED(rv)) return rv;

    nsCOMPtr<nsIDBFolderInfo> folderInfo;
    nsCOMPtr<nsIMsgDatabase> db;
    // Used to init some folder status of child.
    rv = child->GetDBFolderInfoAndDB(getter_AddRefs(folderInfo),
                                     getter_AddRefs(db));
    NS_ENSURE_SUCCESS(rv, rv);

    NotifyFolderAdded(child);
    nsCOMPtr<nsIMsgFolderNotificationService> notifier =
        mozilla::components::FolderNotification::Service();
    notifier->NotifyFolderAdded(child);
  }
  return rv;
}

NS_IMETHODIMP nsMsgNewsFolder::DeleteStorage() {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  nsresult rv = nsMsgDBFolder::DeleteStorage();
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsINntpIncomingServer> nntpServer;
  rv = GetNntpServer(getter_AddRefs(nntpServer));
  if (NS_FAILED(rv)) return rv;

  rv = nntpServer->RemoveNewsgroup(mName);
  NS_ENSURE_SUCCESS(rv, rv);

  (void)RefreshSizeOnDisk();

  return SetNewsrcHasChanged(true);
}

NS_IMETHODIMP nsMsgNewsFolder::Rename(const nsACString& newName,
                                      nsIMsgWindow* msgWindow) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP nsMsgNewsFolder::GetAbbreviatedName(nsAString& aAbbreviatedName) {
  nsresult rv;

  rv = nsMsgDBFolder::GetLocalizedName(aAbbreviatedName);
  NS_ENSURE_SUCCESS(rv, rv);

  // only do this for newsgroup names, not for newsgroup hosts.
  bool isNewsServer = false;
  rv = GetIsServer(&isNewsServer);
  NS_ENSURE_SUCCESS(rv, rv);

  if (!isNewsServer) {
    nsCOMPtr<nsINntpIncomingServer> nntpServer;
    rv = GetNntpServer(getter_AddRefs(nntpServer));
    NS_ENSURE_SUCCESS(rv, rv);

    bool abbreviate = true;
    rv = nntpServer->GetAbbreviate(&abbreviate);
    NS_ENSURE_SUCCESS(rv, rv);

    if (abbreviate)
      rv = AbbreviatePrettyName(aAbbreviatedName, 1 /* hardcoded for now */);
  }
  return rv;
}

// original code from Oleg Rekutin
// rekusha@asan.com
// Public domain, created by Oleg Rekutin
//
// takes a newsgroup name, number of words from the end to leave unabberviated
// the newsgroup name, will get reset to the following format:
// x.x.x, where x is the first letter of each word and with the
// exception of last 'fullwords' words, which are left intact.
// If a word has a dash in it, it is abbreviated as a-b, where
// 'a' is the first letter of the part of the word before the
// dash and 'b' is the first letter of the part of the word after
// the dash
nsresult nsMsgNewsFolder::AbbreviatePrettyName(nsAString& prettyName,
                                               int32_t fullwords) {
  nsAutoString name(prettyName);
  int32_t totalwords = 0;  // total no. of words

  // get the total no. of words
  int32_t pos = 0;
  while (1) {
    pos = name.FindChar('.', pos);
    if (pos == -1) {
      totalwords++;
      break;
    } else {
      totalwords++;
      pos++;
    }
  }

  // get the no. of words to abbreviate
  int32_t abbrevnum = totalwords - fullwords;
  if (abbrevnum < 1) return NS_OK;  // nothing to abbreviate

  // build the ellipsis
  nsAutoString out;
  out += name[0];

  int32_t length = name.Length();
  int32_t newword = 0;  // == 2 if done with all abbreviated words

  fullwords = 0;
  char16_t currentChar;
  for (int32_t i = 1; i < length; i++) {
    // this temporary assignment is needed to fix an intel mac compiler bug.
    // See Bug #327037 for details.
    currentChar = name[i];
    if (newword < 2) {
      switch (currentChar) {
        case '.':
          fullwords++;
          // check if done with all abbreviated words...
          if (fullwords == abbrevnum)
            newword = 2;
          else
            newword = 1;
          break;
        case '-':
          newword = 1;
          break;
        default:
          if (newword)
            newword = 0;
          else
            continue;
      }
    }
    out.Append(currentChar);
  }
  prettyName = out;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::GetMsgDatabase(nsIMsgDatabase** database) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    NS_ENSURE_ARG_POINTER(database);
    *database = nullptr;
    // Only the summary reader may reenter the in-progress initialization.
    NS_ENSURE_TRUE(!mNativeDatabaseInitializing, NS_ERROR_IN_PROGRESS);
    MOZ_TRY(GetNativeDatabase());
    MOZ_TRY(mDatabase->SetLastUseTime(PR_Now()));
    NS_ADDREF(*database = mDatabase);
    return NS_OK;
  }
#endif
  return nsMsgDBFolder::GetMsgDatabase(database);
}

NS_IMETHODIMP
nsMsgNewsFolder::SetMsgDatabase(nsIMsgDatabase* database) {
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    if (database) {
      return InitializeNativeDatabase(database);
    }
    ++mNativeDatabaseGeneration;
    mNativeDatabaseInitializing = false;
    mNativeDatabaseReadingSummary = false;
    nsCOMPtr<nsIMsgDatabase> previous = mDatabase.forget();
    if (previous) {
      MOZ_TRY(previous->Commit(nsMsgDBCommitType::kLargeCommit));
      MOZ_TRY(previous->RemoveListener(this));
      MOZ_TRY(previous->ClearCachedHdrs());
      MOZ_TRY(previous->GetNewList(m_newMsgs));
    }
    return NS_OK;
  }
#endif
  return nsMsgDBFolder::SetMsgDatabase(database);
}

NS_IMETHODIMP
nsMsgNewsFolder::GetDBFolderInfoAndDB(nsIDBFolderInfo** folderInfo,
                                      nsIMsgDatabase** db) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  NS_ENSURE_ARG_POINTER(folderInfo);
  NS_ENSURE_ARG_POINTER(db);
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    *folderInfo = nullptr;
    *db = nullptr;
    NS_ENSURE_TRUE(
        !mNativeDatabaseInitializing || mNativeDatabaseReadingSummary,
        NS_ERROR_IN_PROGRESS);
    MOZ_TRY(GetNativeDatabase());
    nsCOMPtr<nsIMsgDatabase> database = mDatabase;
    nsCOMPtr<nsIDBFolderInfo> info;
    MOZ_TRY(database->GetDBFolderInfo(getter_AddRefs(info)));
    info.forget(folderInfo);
    database.forget(db);
    return NS_OK;
  }
#endif
  nsresult openErr;
  openErr = GetDatabase();
  if (!mDatabase) {
    *db = nullptr;
    return openErr;
  }

  NS_ADDREF(*db = mDatabase);

  if (NS_SUCCEEDED(openErr)) openErr = (*db)->GetDBFolderInfo(folderInfo);
  return openErr;
}

#ifdef MOZ_PANORAMA
nsresult nsMsgNewsFolder::GetNativeDatabase() {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  if (mDatabase) {
    nsresult rv;
    RefPtr<mozilla::mailnews::PerFolderDatabase> native =
        do_QueryObject(mDatabase, &rv);
    NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(native->FolderId() == mFolderId, NS_ERROR_NOT_AVAILABLE);
    nsMsgKeySet* current = nullptr;
    MOZ_TRY(native->GetReadSet(&current));
    if (mReadSet &&
        mReadSetDatabase.get() == static_cast<nsINewsDatabase*>(native.get()) &&
        current == mReadSet) {
      return NS_OK;
    }
    NS_ENSURE_TRUE(!mNativeDatabaseInitializing, NS_ERROR_IN_PROGRESS);
    return InitializeNativeDatabase(mDatabase);
  }
  nsresult rv;
  nsCOMPtr<nsIMsgDBService> service =
      do_GetService("@mozilla.org/msgDatabase/msgDBService;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  nsCOMPtr<nsIMsgDatabase> database;
  MOZ_TRY(service->OpenFolderDB(this, false, getter_AddRefs(database)));
  return InitializeNativeDatabase(database);
}

nsresult nsMsgNewsFolder::InitializeNativeDatabase(nsIMsgDatabase* candidate) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  NS_ENSURE_ARG(candidate);
  nsCOMPtr<nsIMsgDatabase> database = candidate;
  nsresult rv;
  RefPtr<mozilla::mailnews::PerFolderDatabase> native =
      do_QueryObject(database, &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  NS_ENSURE_TRUE(native->FolderId() == mFolderId, NS_ERROR_NOT_AVAILABLE);
  nsMsgKeySet* previousSet = nullptr;
  MOZ_TRY(native->GetReadSet(&previousSet));
  RefPtr<nsMsgKeySet> readSet = mReadSet;
  if (!readSet) {
    // A restored group need not have a newsrc line. Read its persisted native
    // checkpoint before attaching an owner; an empty default must not erase it.
    nsCOMPtr<nsIDBFolderInfo> info;
    MOZ_TRY(database->GetDBFolderInfo(getter_AddRefs(info)));
    nsCString ranges;
    MOZ_TRY(info->GetCharProperty("readSet", ranges));
    readSet = nsMsgKeySet::Create(ranges.get());
    NS_ENSURE_TRUE(readSet, NS_ERROR_OUT_OF_MEMORY);
    mReadSet = readSet;
    mPendingNewsrcReadSet.emplace(std::move(ranges));
  }
  nsCOMPtr<nsINewsDatabase> previousBinding = mReadSetDatabase;
  nsCOMPtr<nsINewsDatabase> news = do_QueryInterface(database, &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  if (!mNativeDatabaseInitializing && mDatabase == database && mReadSet &&
      previousSet == mReadSet && mReadSetDatabase == news) {
    // A checked current binding needs no write or listener replacement.
    return NS_OK;
  }
  if (mDatabase && mDatabase != database) {
    MOZ_TRY(mDatabase->RemoveListener(this));
    MOZ_TRY(mDatabase->ClearCachedHdrs());
  }

  const uint64_t generation = ++mNativeDatabaseGeneration;
  mNativeDatabaseInitializing = true;
  mNativeDatabaseReadingSummary = false;
  // ReadDBFolderInfo reenters with this exact facade after its read set binds.
  mDatabase = database;
  bool listenerAdded = false;
  bool readSetAttempted = false;
  auto cleanup = mozilla::MakeScopeExit([&] {
    // A synchronous callback may have fully replaced this same object.
    if (mNativeDatabaseGeneration != generation) {
      return;
    }
    if (listenerAdded) {
      nsresult cleanupRv = database->RemoveListener(this);
      NS_WARNING_ASSERTION(NS_SUCCEEDED(cleanupRv),
                           "Failed to detach news database listener");
    }
    if (readSetAttempted && readSet != previousSet) {
      native->DetachNewsReadSetIfMatches(readSet);
    }
    if (mReadSetDatabase == news && mReadSet == readSet) {
      mReadSetDatabase = previousBinding;
    }
    mDatabase = nullptr;
    mNativeDatabaseInitializing = false;
    mNativeDatabaseReadingSummary = false;
  });
  if (mAddListener) {
    MOZ_TRY(database->AddListener(this));
    listenerAdded = true;
  }
  readSetAttempted = true;
  mReadSetDatabase = news;
  if (mPendingNewsrcReadSet.isSome()) {
    MOZ_TRY(native->InitializeNewsReadSetFromNewsrc(readSet,
                                                    *mPendingNewsrcReadSet));
    if (mReadSet == readSet && mReadSetDatabase == news) {
      mPendingNewsrcReadSet.reset();
    }
  } else {
    MOZ_TRY(news->SetReadSet(readSet));
  }
  NS_ENSURE_TRUE(mNativeDatabaseGeneration == generation, NS_ERROR_IN_PROGRESS);
  mNativeDatabaseReadingSummary = true;
  MOZ_TRY(UpdateSummaryTotals(true));
  NS_ENSURE_TRUE(
      mNativeDatabaseGeneration == generation && mDatabase == database,
      NS_ERROR_IN_PROGRESS);
  mNativeDatabaseInitializing = false;
  mNativeDatabaseReadingSummary = false;
  cleanup.release();
  return NS_OK;
}

void nsMsgNewsFolder::DetachNativeReadSet() {
  RefPtr<mozilla::mailnews::PerFolderDatabase> native =
      do_QueryObject(mReadSetDatabase);
  if (native && mReadSet) {
    // Match without inspecting the saved weak pointer, including after cache
    // clearing, close, or source shutdown. A newer binding must survive.
    native->DetachNewsReadSetIfMatches(mReadSet);
  }
  mReadSetDatabase = nullptr;
  mPendingNewsrcReadSet.reset();
}

nsresult nsMsgNewsFolder::ApplyNativeReadRange(int32_t first, int32_t last) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  MOZ_TRY(GetDatabase());
  RefPtr<nsMsgKeySet> owner = mReadSet;
  NS_ENSURE_TRUE(owner, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsINewsDatabase> news = do_QueryInterface(mDatabase);
  NS_ENSURE_TRUE(news, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsINntpIncomingServer> server;
  MOZ_TRY(GetNntpServer(getter_AddRefs(server)));
  nsCString encoded;
  MOZ_TRY(owner->Output(getter_Copies(encoded)));
  const bool zero = owner->IsMember(0);
  RefPtr<nsMsgKeySet> prepared = nsMsgKeySet::Create(encoded.get());
  NS_ENSURE_TRUE(prepared, NS_ERROR_OUT_OF_MEMORY);
  NS_ENSURE_TRUE((zero ? prepared->Add(0) : prepared->Remove(0)) >= 0,
                 NS_ERROR_OUT_OF_MEMORY);
  int changed = prepared->AddRange(first, last);
  NS_ENSURE_TRUE(changed >= 0, NS_ERROR_OUT_OF_MEMORY);
  if (!changed) {
    return NS_OK;
  }
  // The same borrowed identity is reconciled; the owning caller restores its
  // exact old contents if native preparation/storage refuses the range.
  owner->SwapContents(*prepared);
  nsresult rv = news->SetReadSet(owner);
  if (NS_FAILED(rv)) {
    if (mReadSet == owner) {
      owner->SwapContents(*prepared);
    }
    return rv;
  }
  return server->SetNewsrcHasChanged(true);
}
#endif

/* this used to be MSG_FolderInfoNews::UpdateSummaryFromNNTPInfo() */
NS_IMETHODIMP
nsMsgNewsFolder::UpdateSummaryFromNNTPInfo(int32_t oldest, int32_t youngest,
                                           int32_t total) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  NS_ENSURE_STATE(mReadSet);
  bool dbWasOpen = mDatabase != nullptr;
#ifdef MOZ_PANORAMA
  const bool native = mozilla::StaticPrefs::mail_panorama_enabled_AtStartup();
  NS_ENSURE_TRUE(!native || (oldest >= 0 && youngest >= 0 && total >= 0),
                 NS_ERROR_ILLEGAL_VALUE);
  if (native && oldest > 1) {
    MOZ_TRY(ApplyNativeReadRange(1, oldest - 1));
  } else
#endif
    /* First, mark all of the articles now known to be expired as read. */
    if (oldest > 1) {
      nsCString oldSet;
      nsCString newSet;
      mReadSet->Output(getter_Copies(oldSet));
      mReadSet->AddRange(1, oldest - 1);
      mReadSet->Output(getter_Copies(newSet));
    }

  /* Now search the newsrc line and figure out how many of these messages are
   * marked as unread. */

  /* make sure youngest is a least 1. MSNews seems to return a youngest of 0. */
  if (youngest == 0) youngest = 1;

  int32_t unread = mReadSet->CountMissingInRange(oldest, youngest);
  NS_ASSERTION(unread >= 0, "CountMissingInRange reported unread < 0");
  if (unread < 0)
    // servers can send us stuff like "211 0 41 40 nz.netstatus"
    // we should handle it gracefully.
    unread = 0;

  if (unread > total) {
    /* This can happen when the newsrc file shows more unread than exist in the
     * group (total is not necessarily `end - start'.) */
    unread = total;
    int32_t deltaInDB = mNumTotalMessages - mNumUnreadMessages;
    // int32_t deltaInDB = m_totalInDB - m_unreadInDB;
    /* if we know there are read messages in the db, subtract that from the
     * unread total */
    if (deltaInDB > 0) unread -= deltaInDB;
  }

  int32_t pendingUnreadDelta =
      unread - mNumUnreadMessages - mNumPendingUnreadMessages;
  int32_t pendingTotalDelta =
      total - mNumTotalMessages - mNumPendingTotalMessages;
  nsresult pendingRv = ChangeNumPendingUnread(pendingUnreadDelta);
#ifdef MOZ_PANORAMA
  if (native) {
    NS_ENSURE_SUCCESS(pendingRv, pendingRv);
  }
#endif
  pendingRv = ChangeNumPendingTotalMessages(pendingTotalDelta);
#ifdef MOZ_PANORAMA
  if (native) {
    NS_ENSURE_SUCCESS(pendingRv, pendingRv);
  }
#endif
  (void)pendingRv;
  if (!dbWasOpen && mDatabase) {
    mDatabase->Commit(nsMsgDBCommitType::kLargeCommit);
    mDatabase->RemoveListener(this);
    mDatabase = nullptr;
  }
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::GetExpungedBytesCount(int64_t* count) {
  NS_ENSURE_ARG_POINTER(count);
  *count = mExpungedBytes;
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::GetDeletable(bool* deletable) {
  NS_ENSURE_ARG_POINTER(deletable);

  *deletable = false;
  // For legacy reasons, there can be Saved search folders under news accounts.
  // Allow deleting those.
  GetFlag(nsMsgFolderFlags::Virtual, deletable);
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::RefreshSizeOnDisk() {
  uint64_t oldFolderSize = mFolderSize;
  // We set size to unknown to force it to get recalculated from disk.
  mFolderSize = kSizeUnknown;
  if (NS_SUCCEEDED(GetSizeOnDisk(&mFolderSize)))
    NotifyIntPropertyChanged(kFolderSize, oldFolderSize, mFolderSize);
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::GetSizeOnDisk(int64_t* size) {
  NS_ENSURE_ARG_POINTER(size);

  bool isServer = false;
  nsresult rv = GetIsServer(&isServer);
  // If this is the rootFolder, return 0 as a safe value.
  if (NS_FAILED(rv) || isServer) mFolderSize = 0;

  // 0 is a valid folder size (meaning empty file with no offline messages),
  // but 1 is not. So use -1 as a special value meaning no file size was fetched
  // from disk yet.
  if (mFolderSize == kSizeUnknown) {
    // Leave mFolderSize on kSizeUnknown if the file can't be reached at all.
    // Callers expect kSizeUnknown rather than a failure.
    nsCOMPtr<nsIFile> diskFile;
    if (NS_SUCCEEDED(GetFilePath(getter_AddRefs(diskFile)))) {
      // If there were no news messages downloaded for offline use, the folder
      // file may not exist yet. In that case size is 0.
      bool exists = false;
      nsresult rv = diskFile->Exists(&exists);
      if (NS_FAILED(rv) || !exists) {
        mFolderSize = 0;
      } else {
        int64_t fileSize;
        if (NS_SUCCEEDED(diskFile->GetFileSize(&fileSize))) {
          mFolderSize = fileSize;
        }
      }
    }
  }

  *size = mFolderSize;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::DeleteMessages(nsTArray<RefPtr<nsIMsgDBHdr>> const& msgHdrs,
                                nsIMsgWindow* aMsgWindow, bool deleteStorage,
                                bool isMove,
                                nsIMsgCopyServiceListener* listener,
                                bool allowUndo) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  nsresult rv = NS_OK;
  NS_ENSURE_ARG_POINTER(aMsgWindow);

  if (!isMove) {
    nsCOMPtr<nsIMsgFolderNotificationService> notifier =
        mozilla::components::FolderNotification::Service();
    notifier->NotifyMsgsDeleted(msgHdrs);
  }

  rv = GetDatabase();
  NS_ENSURE_SUCCESS(rv, rv);

  rv = EnableNotifications(allMessageCountNotifications, false);
  if (NS_SUCCEEDED(rv)) {
    for (auto msgHdr : msgHdrs) {
      rv = mDatabase->DeleteHeader(msgHdr, nullptr, true, true);
      if (NS_FAILED(rv)) {
        break;
      }
    }
    EnableNotifications(allMessageCountNotifications, true);
  }

  if (!isMove)
    NotifyFolderEvent(NS_SUCCEEDED(rv) ? kDeleteOrMoveMsgCompleted
                                       : kDeleteOrMoveMsgFailed);

  if (listener) {
    listener->OnStartCopy();
    listener->OnStopCopy(NS_OK);
  }

  (void)RefreshSizeOnDisk();

  return rv;
}

NS_IMETHODIMP nsMsgNewsFolder::CancelMessage(nsIMsgDBHdr* msgHdr,
                                             nsIUrlListener* aUrlListener,
                                             nsIMsgWindow* aMsgWindow) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  NS_ENSURE_ARG_POINTER(msgHdr);

  nsresult rv;

  nsCOMPtr<nsINntpService> nntpService =
      do_GetService("@mozilla.org/messenger/nntpservice;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  // for cancel, we need to
  // turn "newsmessage://sspitzer@news.mozilla.org/netscape.test#5428"
  // into "news://sspitzer@news.mozilla.org/23423@netscape.com"

  nsCOMPtr<nsIMsgIncomingServer> server;
  rv = GetServer(getter_AddRefs(server));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCString serverURI;
  rv = server->GetServerURI(serverURI);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCString messageID;
  rv = msgHdr->GetMessageId(messageID);
  NS_ENSURE_SUCCESS(rv, rv);

  // we need to escape the message ID,
  // it might contain characters which will mess us up later, like #
  // see bug #120502
  nsCString escapedMessageID;
  MsgEscapeString(messageID, nsINetUtil::ESCAPE_URL_PATH, escapedMessageID);

  nsAutoCString cancelURL(serverURI.get());
  cancelURL += '/';
  cancelURL += escapedMessageID;
  cancelURL += "?cancel";

  nsCString messageURI;
  rv = GetUriForMsg(msgHdr, messageURI);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIURI> resultUri;
  return nntpService->CancelMessage(cancelURL, messageURI,
                                    nullptr /* consumer */, aUrlListener,
                                    aMsgWindow, getter_AddRefs(resultUri));
}

NS_IMETHODIMP nsMsgNewsFolder::GetNewMessages(nsIMsgWindow* aMsgWindow,
                                              nsIUrlListener* aListener) {
  return GetNewsMessages(aMsgWindow, false, aListener);
}

NS_IMETHODIMP nsMsgNewsFolder::GetNextNMessages(nsIMsgWindow* aMsgWindow) {
  return GetNewsMessages(aMsgWindow, true, nullptr);
}

nsresult nsMsgNewsFolder::GetNewsMessages(nsIMsgWindow* aMsgWindow,
                                          bool aGetOld,
                                          nsIUrlListener* aUrlListener) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  nsresult rv = NS_OK;

  nsCOMPtr<nsINntpService> nntpService =
      do_GetService("@mozilla.org/messenger/nntpservice;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsINntpIncomingServer> nntpServer;
  rv = GetNntpServer(getter_AddRefs(nntpServer));
  NS_ENSURE_SUCCESS(rv, rv);

  bool isNewsServer = false;
  rv = GetIsServer(&isNewsServer);
  NS_ENSURE_SUCCESS(rv, rv);

  if (!isNewsServer) {
    nsCOMPtr<nsIURI> resultUri;
    rv = nntpService->GetNewNews(nntpServer, mURI, aGetOld, this, aMsgWindow,
                                 getter_AddRefs(resultUri));
    if (aUrlListener && NS_SUCCEEDED(rv) && resultUri) {
      nsCOMPtr<nsIMsgMailNewsUrl> msgUrl(do_QueryInterface(resultUri));
      if (msgUrl) msgUrl->RegisterListener(aUrlListener);
    }
  } else {
    for (auto folder : mSubFolders) {
      nsCString uri;
      rv = folder->GetURI(uri);
      NS_ENSURE_SUCCESS(rv, rv);
      nsCOMPtr<nsIURI> resultUri;
      nntpService->GetNewNews(nntpServer, uri, aGetOld, aUrlListener,
                              aMsgWindow, getter_AddRefs(resultUri));
    }
  }
  return rv;
}

nsresult nsMsgNewsFolder::LoadNewsrcFileAndCreateNewsgroups() {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  nsresult rv = NS_OK;
  if (!mNewsrcFilePath) return NS_ERROR_FAILURE;

  bool exists;
  rv = mNewsrcFilePath->Exists(&exists);
  if (NS_FAILED(rv)) return rv;

  if (!exists)
    // it is ok for the newsrc file to not exist yet
    return NS_OK;

  nsCOMPtr<nsIInputStream> fileStream;
  rv = NS_NewLocalFileInputStream(getter_AddRefs(fileStream), mNewsrcFilePath);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsILineInputStream> lineInputStream(
      do_QueryInterface(fileStream, &rv));
  NS_ENSURE_SUCCESS(rv, rv);

  bool more = true;
  nsCString line;

  while (more && NS_SUCCEEDED(rv)) {
    rv = lineInputStream->ReadLine(line, &more);
    if (NS_FAILED(rv) || line.IsEmpty()) continue;
    nsresult lineRv = HandleNewsrcLine(line.get(), line.Length());
#ifdef MOZ_PANORAMA
    if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
      rv = lineRv;
    }
#endif
  }

  nsresult closeRv = fileStream->Close();
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup() &&
      NS_SUCCEEDED(rv)) {
    return closeRv;
  }
#endif
  return rv;
}

nsresult nsMsgNewsFolder::HandleNewsrcLine(const char* line,
                                           uint32_t line_size) {
  nsresult rv;

  /* guard against blank line lossage */
  if (line[0] == '#' || line[0] == '\r' || line[0] == '\n') return NS_OK;

  if ((line[0] == 'o' || line[0] == 'O') && !PL_strncasecmp(line, "options", 7))
    return NS_OK;

  const char* s = nullptr;
  const char* setStr = nullptr;
  const char* end = line + line_size;

  for (s = line; s < end; s++)
    if ((*s == ':') || (*s == '!')) break;

  if (*s == 0) {
    return NS_OK;
  }

  bool subscribed = (*s == ':');
  setStr = s + 1;

  if (*line == '\0') return NS_OK;

  // previous versions of Communicator polluted the
  // newsrc files with articles
  // (this would happen when you clicked on a link like
  // news://news.mozilla.org/3746EF3F.6080309@netscape.com)
  //
  // legal newsgroup names can't contain @ or %
  //
  // News group names are structured into parts separated by dots,
  // for example "netscape.public.mozilla.mail-news".
  // Each part may be up to 14 characters long, and should consist
  // only of letters, digits, "+" and "-", with at least one letter
  //
  // @ indicates an article and %40 is @ escaped.
  // previous versions of Communicator also dumped
  // the escaped version into the newsrc file
  //
  // So lines like this in a newsrc file should be ignored:
  // 3746EF3F.6080309@netscape.com:
  // 3746EF3F.6080309%40netscape.com:
  if (PL_strchr(line, '@') || PL_strstr(line, "%40"))
    // skipping, it contains @ or %40
    subscribed = false;

  if (subscribed) {
    // we're subscribed, so add it
    nsCOMPtr<nsIMsgFolder> child;

#ifdef MOZ_PANORAMA
    if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
      // ReadLine removed structural line endings. Exclude only the writer's
      // one separator byte; preserve the actual range syntax for comparison.
      if (*setStr == ' ') ++setStr;
      return AddNewsgroupWithFolderId(Substring(line, s),
                                      nsDependentCString(setStr),
                                      getter_AddRefs(child), true);
    }
#endif
    rv = AddNewsgroup(Substring(line, s), nsDependentCString(setStr),
                      getter_AddRefs(child));
    NS_ENSURE_SUCCESS(rv, rv);
  }

  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::GetGroupUsername(nsACString& aGroupUsername) {
  aGroupUsername = mGroupUsername;
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::SetGroupUsername(
    const nsACString& aGroupUsername) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  mGroupUsername = aGroupUsername;
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::GetGroupPassword(nsACString& aGroupPassword) {
  aGroupPassword = mGroupPassword;
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::SetGroupPassword(
    const nsACString& aGroupPassword) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  mGroupPassword = aGroupPassword;
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::GetUrlForSignon(nsAString& result) {
  nsresult rv;

  nsCOMPtr<nsIMsgIncomingServer> server;
  rv = GetServer(getter_AddRefs(server));
  if (NS_FAILED(rv)) return rv;

  nsCOMPtr<nsINntpIncomingServer> nntpServer;
  rv = GetNntpServer(getter_AddRefs(nntpServer));
  if (NS_FAILED(rv)) return rv;

  bool singleSignon = true;
  rv = nntpServer->GetSingleSignon(&singleSignon);

  nsCOMPtr<nsIURL> url;
  if (singleSignon) {
    // Do not include username in the url when interacting with LoginManager.
    nsCString serverURI = "news://"_ns;
    nsCString hostname;
    rv = server->GetHostname(hostname);
    NS_ENSURE_SUCCESS(rv, rv);
    serverURI.Append(hostname);
    rv = MsgNewStandardURL(serverURI, getter_AddRefs(url));
    NS_ENSURE_SUCCESS(rv, rv);
  } else {
    rv = MsgNewStandardURL(mURI, getter_AddRefs(url));
    NS_ENSURE_SUCCESS(rv, rv);
  }

  int32_t port = 0;
  rv = url->GetPort(&port);
  NS_ENSURE_SUCCESS(rv, rv);

  if (port <= 0) {
    nsCOMPtr<nsIMsgIncomingServer> server;
    rv = GetServer(getter_AddRefs(server));
    NS_ENSURE_SUCCESS(rv, rv);

    int32_t socketType;
    nsresult rv = server->GetSocketType(&socketType);
    NS_ENSURE_SUCCESS(rv, rv);

    // Only set this for ssl newsgroups as for non-ssl connections, we don't
    // need to specify the port as it is the default for the protocol and
    // password manager "blanks" those out.
    if (socketType == nsMsgSocketType::SSL) {
      rv = NS_MutateURI(url)
               .SetPort(nsINntpIncomingServer::DEFAULT_NNTPS_PORT)
               .Finalize(url);
      NS_ENSURE_SUCCESS(rv, rv);
    }
  }

  nsCString rawResult;

  // The url doesn't have a path, make sure we don't get a '/' on the end
  // as that will confuse searching in password manager.
  nsCString spec;
  rv = url->GetSpec(spec);
  NS_ENSURE_SUCCESS(rv, rv);

  if (!spec.IsEmpty() && spec[spec.Length() - 1] == '/')
    rawResult = StringHead(spec, spec.Length() - 1);
  else
    rawResult = spec;

  result = NS_ConvertASCIItoUTF16(rawResult);
  return NS_OK;
}

nsresult nsMsgNewsFolder::CreateBaseMessageURI(const nsACString& aURI) {
  nsAutoCString tailURI(aURI);

  // chop off news:/
  if (tailURI.Find(kNewsRootURI) == 0) {
    tailURI.Cut(0, PL_strlen(kNewsRootURI));
  };

  mBaseMessageURI = kNewsMessageRootURI;
  mBaseMessageURI += tailURI;

  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::GetCharset(nsACString& charset) {
  nsCOMPtr<nsIMsgIncomingServer> server;
  nsresult rv = GetServer(getter_AddRefs(server));
  NS_ENSURE_SUCCESS(rv, rv);
  nsCOMPtr<nsINntpIncomingServer> nserver(do_QueryInterface(server));
  NS_ENSURE_TRUE(nserver, NS_ERROR_NULL_POINTER);
  return nserver->GetCharset(charset);
}

NS_IMETHODIMP
nsMsgNewsFolder::GetNewsrcLine(nsACString& newsrcLine) {
  nsresult rv;
  nsAutoCString newsgroupName;
  rv = GetName(newsgroupName);
  if (NS_FAILED(rv)) return rv;

  newsrcLine = newsgroupName;
  newsrcLine.Append(':');

#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup() &&
      mPendingNewsrcReadSet.isSome()) {
    MOZ_TRY(GetDatabase());
  }
#endif
  if (mReadSet) {
    nsCString setStr;
    rv = mReadSet->Output(getter_Copies(setStr));
    NS_ENSURE_SUCCESS(rv, rv);
    if (NS_SUCCEEDED(rv)) {
      newsrcLine.Append(' ');
      newsrcLine.Append(setStr);
    }
  }
  // A restored native group can exist before its first newsrc write.
  newsrcLine.AppendLiteral(MSG_LINEBREAK);
  return NS_OK;
}

#ifdef MOZ_PANORAMA
nsresult nsMsgNewsFolder::SetNativeReadSetFromStr(const nsACString& ranges,
                                                  bool passive) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  // Reject overflow before the legacy signed parser changes range meaning.
  mozilla::CheckedInt<int32_t> article = 0;
  for (uint32_t i = 0; i < ranges.Length(); ++i) {
    const char c = ranges.CharAt(i);
    if (c >= '0' && c <= '9') {
      article = article * 10 + (c - '0');
      NS_ENSURE_TRUE(article.isValid(), NS_ERROR_ILLEGAL_VALUE);
    } else {
      article = 0;
    }
  }
  RefPtr<nsMsgKeySet> replacement =
      nsMsgKeySet::Create(PromiseFlatCString(ranges).get());
  NS_ENSURE_TRUE(replacement, NS_ERROR_OUT_OF_MEMORY);
  mozilla::Maybe<nsCString> pending;
  if (passive) {
    nsCString serialized;
    NS_ENSURE_TRUE(serialized.Assign(ranges, mozilla::fallible),
                   NS_ERROR_OUT_OF_MEMORY);
    pending.emplace(std::move(serialized));
  }
  nsCOMPtr<nsINewsDatabase> previousBinding = mReadSetDatabase;
  nsCOMPtr<nsINewsDatabase> newsDatabase = previousBinding;
  if (mDatabase) {
    nsresult rv;
    newsDatabase = do_QueryInterface(mDatabase, &rv);
    NS_ENSURE_SUCCESS(rv, rv);
  }
  RefPtr<mozilla::mailnews::PerFolderDatabase> nativeDB;
  if (passive && newsDatabase) {
    nsresult rv;
    nativeDB = do_QueryObject(newsDatabase, &rv);
    NS_ENSURE_SUCCESS(rv, rv);
  }

  // Install owning state before synchronous native callbacks. Keep the old
  // owner/ranges alive until this exact attempt commits or rolls back.
  RefPtr<nsMsgKeySet> previous = mReadSet;
  auto previousRanges = std::move(mPendingNewsrcReadSet);
  mReadSet = replacement;
  mPendingNewsrcReadSet = std::move(pending);
  if (!newsDatabase) {
    return NS_OK;
  }
  mReadSetDatabase = newsDatabase;
  nsresult rv =
      passive ? nativeDB->InitializeNewsReadSetFromNewsrc(replacement, ranges)
              : newsDatabase->SetReadSet(replacement);
  if (mReadSetDatabase == newsDatabase && mReadSet == replacement) {
    if (NS_FAILED(rv)) {
      mReadSet = previous;
      mReadSetDatabase = previousBinding;
      mPendingNewsrcReadSet = std::move(previousRanges);
    } else {
      mPendingNewsrcReadSet.reset();
    }
  }
  return rv;
}
#endif

NS_IMETHODIMP nsMsgNewsFolder::SetReadSetFromStr(const nsACString& newsrcLine) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    return SetNativeReadSetFromStr(newsrcLine, false);
  }
#endif

  mReadSet = nsMsgKeySet::Create(PromiseFlatCString(newsrcLine).get());
  NS_ENSURE_TRUE(mReadSet, NS_ERROR_OUT_OF_MEMORY);

  // Now that mReadSet is recreated, make sure it's stored in the db as well.
  nsCOMPtr<nsINewsDatabase> db = do_QueryInterface(mDatabase);
  if (db)  // it's ok not to have a db here.
    db->SetReadSet(mReadSet);
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::OnReadChanged(nsIDBChangeListener* aInstigator) {
  return SetNewsrcHasChanged(true);
}

NS_IMETHODIMP
nsMsgNewsFolder::GetRawName(nsACString& aRawName) {
  nsresult rv;
  if (mRawName.IsEmpty()) {
    nsAutoCString name;
    rv = GetName(name);
    NS_ENSURE_SUCCESS(rv, rv);

    // convert to the server-side encoding
    nsCOMPtr<nsINntpIncomingServer> nntpServer;
    rv = GetNntpServer(getter_AddRefs(nntpServer));
    NS_ENSURE_SUCCESS(rv, rv);

    nsAutoCString dataCharset;
    rv = nntpServer->GetCharset(dataCharset);
    NS_ENSURE_SUCCESS(rv, rv);
    rv = nsMsgI18NConvertFromUnicode(dataCharset, NS_ConvertUTF8toUTF16(name),
                                     mRawName);

    if (NS_FAILED(rv))
      LossyCopyUTF16toASCII(NS_ConvertUTF8toUTF16(name), mRawName);
  }
  aRawName = mRawName;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::GetNntpServer(nsINntpIncomingServer** result) {
  nsresult rv;
  NS_ENSURE_ARG_POINTER(result);

  nsCOMPtr<nsIMsgIncomingServer> server;
  rv = GetServer(getter_AddRefs(server));
  if (NS_FAILED(rv)) return rv;

  nsCOMPtr<nsINntpIncomingServer> nntpServer = do_QueryInterface(server, &rv);
  if (NS_FAILED(rv)) return rv;
  nntpServer.forget(result);
  return NS_OK;
}

// this gets called after the message actually gets cancelled
// it removes the cancelled message from the db
NS_IMETHODIMP nsMsgNewsFolder::RemoveMessage(nsMsgKey key) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  nsresult rv = GetDatabase();
  NS_ENSURE_SUCCESS(rv,
                    rv);  // if GetDatabase succeeds, mDatabase will be non-null

  // Notify listeners of a delete for a single message
  nsCOMPtr<nsIMsgFolderNotificationService> notifier =
      mozilla::components::FolderNotification::Service();
  nsCOMPtr<nsIMsgDBHdr> msgHdr;
  rv = mDatabase->GetMsgHdrForKey(key, getter_AddRefs(msgHdr));
  NS_ENSURE_SUCCESS(rv, rv);
  notifier->NotifyMsgsDeleted({msgHdr.get()});

  return mDatabase->DeleteMessage(key, nullptr, false);
}

NS_IMETHODIMP nsMsgNewsFolder::RemoveMessages(
    const nsTArray<nsMsgKey>& aMsgKeys) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  nsresult rv = GetDatabase();
  NS_ENSURE_SUCCESS(rv,
                    rv);  // if GetDatabase succeeds, mDatabase will be non-null

#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    RefPtr<mozilla::mailnews::PerFolderDatabase> native =
        do_QueryObject(mDatabase);
    NS_ENSURE_TRUE(native, NS_ERROR_NOT_AVAILABLE);
    struct Target {
      nsMsgKey key;
      mozilla::mailnews::NewsArticleIdentity article;
      nsCOMPtr<nsIMsgDBHdr> header;
    };
    nsTArray<Target> targets;
    for (nsMsgKey key : aMsgKeys) {
      Target target;
      target.key = key;
      MOZ_TRY(native->GetNewsArticleLocation(key, target.article));
      MOZ_TRY(native->GetMsgHdrForKey(key, getter_AddRefs(target.header)));
      targets.AppendElement(std::move(target));
    }
    nsCOMPtr<nsIMsgFolderNotificationService> notifier =
        mozilla::components::FolderNotification::Service();
    NS_ENSURE_TRUE(notifier, NS_ERROR_NOT_AVAILABLE);
    for (const auto& target : targets) {
      MOZ_TRY(native->RemoveNewsArticle(target.article, target.key));
      // Only a confirmed removal may publish its global deletion notification.
      // Later failures retain the actual committed prefix, not a false
      // rollback.
      notifier->NotifyMsgsDeleted({target.header.get()});
    }
    return NS_OK;
  }
#endif

  // Notify listeners of a multiple message delete
  nsCOMPtr<nsIMsgFolderNotificationService> notifier =
      mozilla::components::FolderNotification::Service();
  nsTArray<RefPtr<nsIMsgDBHdr>> msgHdrs;
  rv = MsgGetHeadersFromKeys(mDatabase, aMsgKeys, msgHdrs);
  NS_ENSURE_SUCCESS(rv, rv);
  notifier->NotifyMsgsDeleted(msgHdrs);

  return mDatabase->DeleteMessages(aMsgKeys, nullptr);
}

NS_IMETHODIMP nsMsgNewsFolder::CancelComplete() {
  NotifyFolderEvent(kDeleteOrMoveMsgCompleted);
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::GetSaveArticleOffline(bool* aBool) {
  NS_ENSURE_ARG(aBool);
  *aBool = m_downloadMessageForOfflineUse;
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::SetSaveArticleOffline(bool aBool) {
  m_downloadMessageForOfflineUse = aBool;
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::DownloadAllForOffline(nsIUrlListener* listener,
                                                     nsIMsgWindow* msgWindow) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    NS_ENSURE_FALSE(mNativeDownload, NS_ERROR_IN_PROGRESS);
    RefPtr<NativeDownload> download =
        new NativeDownload(this, listener, msgWindow);
    mNativeDownload = download;
    nsresult rv = download->Start();
    if (NS_FAILED(rv)) download->Complete(rv);
    return rv;
  }
#endif
  nsresult rv = NS_OK;

  nsCOMPtr<nsINntpService> nntpService(
      do_GetService("@mozilla.org/messenger/nntpservice;1", &rv));
  if (NS_SUCCEEDED(rv) && nntpService) {
    rv = nntpService->DownloadFolderForOffline(this, msgWindow);
  }

  return rv;
}

NS_IMETHODIMP nsMsgNewsFolder::DownloadMessagesForOffline(
    nsTArray<RefPtr<nsIMsgDBHdr>> const& messages, nsIMsgWindow* msgWindow) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  nsresult rv = NS_OK;

  nsTArray<nsMsgKey> srcKeyArray(messages.Length());
  for (const auto& hdr : messages) {
    nsMsgKey key;
    rv = hdr->GetMessageKey(&key);
    if (NS_SUCCEEDED(rv)) srcKeyArray.AppendElement(key);
  }

  nsCOMPtr<nsINntpService> nntpService(
      do_GetService("@mozilla.org/messenger/nntpservice;1", &rv));
  if (NS_SUCCEEDED(rv) && nntpService) {
    rv = nntpService->DownloadMessagesForOffline(this, srcKeyArray, msgWindow);
  }

  return rv;
}

#ifdef MOZ_PANORAMA
nsresult nsMsgNewsFolder::StoreNativeNewsArticle(uint32_t articleNumber,
                                                 const nsACString& data) {
  using namespace mozilla::mailnews;
  NS_ENSURE_FALSE(mNativeOfflineWriting || m_tempMessageStream,
                  NS_ERROR_IN_PROGRESS);
  RefPtr<nsMsgNewsFolder> self(this);
  mNativeOfflineWriting = true;
  auto writing = mozilla::MakeScopeExit([&] { mNativeOfflineWriting = false; });
  MOZ_TRY(GetDatabase());
  RefPtr<PerFolderDatabase> database = do_QueryObject(mDatabase);
  NS_ENSURE_TRUE(database, NS_ERROR_NOT_AVAILABLE);
  nsMsgKey key;
  MOZ_TRY(database->GetNewsArticleKey(articleNumber, key));
  NewsArticleIdentity article;
  MessageBodyState before;
  MOZ_TRY(database->CaptureNewsArticleBody(key, article, before));

  bool locked = false, hasSemaphore = false;
  MOZ_TRY(GetLocked(&locked));
  if (locked) {
    MOZ_TRY(TestSemaphore(static_cast<nsIMsgFolder*>(this), &hasSemaphore));
    NS_ENSURE_TRUE(hasSemaphore, NS_MSG_FOLDER_BUSY);
  }
  if (!hasSemaphore) {
    MOZ_TRY(AcquireSemaphore(static_cast<nsIMsgFolder*>(this),
                             "nsMsgNewsFolder::StoreNativeNewsArticle"_ns));
  }
  auto semaphore = mozilla::MakeScopeExit([&] {
    if (!hasSemaphore) {
      ReleaseSemaphore(static_cast<nsIMsgFolder*>(this),
                       "nsMsgNewsFolder::StoreNativeNewsArticle"_ns);
    }
  });
  // Query the selected provider without preempting any issued stream, including
  // one whose previous Finish has not settled. Unknown providers fail closed.
  MOZ_TRY(CheckFolderStorageMove(this));
  nsCOMPtr<nsIMsgPluggableStore> store;
  MOZ_TRY(GetMsgStore(getter_AddRefs(store)));
  NS_ENSURE_TRUE(store, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIOutputStream> stream;
  bool finishAttempted = false;
  auto discard = mozilla::MakeScopeExit([&] {
    if (stream && !finishAttempted) {
      nsresult cleanup = store->DiscardNewMessage(this, stream);
      if (NS_FAILED(cleanup)) {
        NS_WARNING("Failed to discard the new native news stream");
      }
    }
  });
  MOZ_TRY(store->GetNewMsgOutputStream(this, getter_AddRefs(stream)));
  NS_ENSURE_TRUE(stream, NS_ERROR_UNEXPECTED);
  auto write = [&](const nsACString& value) -> nsresult {
    uint32_t written = 0;
    MOZ_TRY(stream->Write(value.BeginReading(), value.Length(), &written));
    NS_ENSURE_TRUE(written == value.Length(), NS_ERROR_FAILURE);
    return NS_OK;
  };
  uint32_t flags = before.flags | nsMsgMessageFlags::Offline;
  nsPrintfCString statusHeader("X-Mozilla-Status: %04x" MSG_LINEBREAK,
                               flags & 0xffff);
  nsPrintfCString statusHeader2("X-Mozilla-Status2: %08x" MSG_LINEBREAK,
                                flags & 0xffff0000);
  MOZ_TRY(write(statusHeader));
  MOZ_TRY(write(statusHeader2));
  MOZ_TRY(write(data));

  // A provider write can call back into the folder. Refuse changed ownership
  // while the newly issued stream can still be discarded safely.
  NewsArticleIdentity currentArticle;
  MessageBodyState current;
  MOZ_TRY(database->CaptureNewsArticleBody(key, currentArticle, current));
  NS_ENSURE_TRUE(
      currentArticle.articleNumber == article.articleNumber &&
          currentArticle.group.databaseSourceId ==
              article.group.databaseSourceId &&
          currentArticle.group.folderId == article.group.folderId &&
          currentArticle.group.incarnation == article.group.incarnation &&
          current.databaseSourceId == before.databaseSourceId &&
          current.folderId == before.folderId && current.key == before.key &&
          current.storeToken == before.storeToken &&
          current.contentRevision == before.contentRevision &&
          current.locationRevision == before.locationRevision &&
          current.messageSize == before.messageSize &&
          current.offlineMessageSize == before.offlineMessageSize &&
          current.lineCount == before.lineCount &&
          !((current.flags ^ before.flags) & nsMsgMessageFlags::Offline),
      NS_ERROR_NOT_AVAILABLE);

  // Finish owns provider settlement from this point. Never discard or repeat
  // it after any Finish result. A later metadata failure leaves a completed
  // orphan explicit and preserves the old committed metadata and body.
  finishAttempted = true;
  nsAutoCString token;
  MOZ_TRY(store->FinishNewMessage(this, stream, token));
  NS_ENSURE_FALSE(token.IsEmpty(), NS_ERROR_UNEXPECTED);
  uint32_t size, measuredLines;
  MOZ_TRY(ReadStoredMessageDetails(store, this, token, &size, &measuredLines));
  FinishedMessageBody finished;
  finished.storeToken = token;
  finished.messageSize = before.messageSize;
  finished.offlineMessageSize = size;
  finished.lineCount = data.CountChar('\n');
  finished.offline = true;
  MessageBodyState published;
  return database->SettleNewsArticleBody(article, before, finished, published);
}
#endif

NS_IMETHODIMP nsMsgNewsFolder::NotifyArticleDownloaded(uint32_t articleNumber,
                                                       nsACString const& data) {
  if (!m_downloadMessageForOfflineUse) {
    return NS_OK;
  }
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    return StoreNativeNewsArticle(articleNumber, data);
  }
#endif
  if (m_tempMessageStream) {
    return NS_ERROR_IN_PROGRESS;
  }
  nsresult rv =
      GetMessageHeader(articleNumber, getter_AddRefs(m_offlineHeader));
  NS_ENSURE_SUCCESS(rv, rv);
  rv = StartNewOfflineMessage();
  if (NS_FAILED(rv)) {
    if (m_tempMessageStream) {
      EndNewOfflineMessage(rv);
    } else {
      m_offlineHeader = nullptr;
    }
    return rv;
  }

  if (m_tempMessageStream) {
    m_numOfflineMsgLines += data.CountChar('\n');
    uint32_t count = 0;
    rv = m_tempMessageStream->Write(data.BeginReading(), data.Length(), &count);
    m_tempMessageStreamBytesWritten += count;
    if (NS_SUCCEEDED(rv) && count != data.Length()) {
      rv = NS_ERROR_FAILURE;
    }
  } else {
    rv = NS_ERROR_UNEXPECTED;
  }
  nsresult finishRv = EndNewOfflineMessage(rv);
  return NS_FAILED(rv) ? rv : finishRv;
}

NS_IMETHODIMP nsMsgNewsFolder::NotifyFinishedDownloadinghdrs() {
  bool wasCached = !!mDatabase;
  ChangeNumPendingTotalMessages(-mNumPendingTotalMessages);
  ChangeNumPendingUnread(-mNumPendingUnreadMessages);
  bool filtersRun;
  // run the bayesian spam filters, if enabled.
  CallFilterPlugins(nullptr, &filtersRun);

  // If the DB was not open before, close our reference to it now.
  if (!wasCached && mDatabase) {
    mDatabase->Commit(nsMsgDBCommitType::kLargeCommit);
    mDatabase->RemoveListener(this);
    // This also clears all of the cached headers that may have been added while
    // we were downloading messages (and those clearing refcount cycles in the
    // database).
    mDatabase->ClearCachedHdrs();
    mDatabase = nullptr;
  }

  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::ApplyRetentionSettings() {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  return nsMsgDBFolder::ApplyRetentionSettings(false);
}

NS_IMETHODIMP nsMsgNewsFolder::GetMessageIdForKey(nsMsgKey key,
                                                  nsACString& result) {
  nsresult rv = GetDatabase();
  if (!mDatabase) return rv;
  bool containsKey = false;
  rv = mDatabase->ContainsKey(key, &containsKey);
  NS_ENSURE_SUCCESS(rv, rv);
  if (!containsKey) {
    result.SetIsVoid(true);
    return NS_OK;
  }
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    RefPtr<mozilla::mailnews::PerFolderDatabase> native =
        do_QueryObject(mDatabase);
    NS_ENSURE_TRUE(native, NS_ERROR_NOT_AVAILABLE);
    mozilla::mailnews::NewsArticleIdentity article;
    MOZ_TRY(native->GetNewsArticleLocation(key, article));
  }
#endif
  nsCOMPtr<nsIMsgDBHdr> hdr;
  rv = mDatabase->GetMsgHdrForKey(key, getter_AddRefs(hdr));
  NS_ENSURE_SUCCESS(rv, rv);
  return hdr->GetMessageId(result);
}

NS_IMETHODIMP nsMsgNewsFolder::Shutdown(bool shutdownChildren) {
#ifdef MOZ_PANORAMA
  if (mNativeDownload) mNativeDownload->Cancel();
#endif
  if (mFilterList) {
    // close the filter log stream
    nsresult rv = mFilterList->SetLogStream(nullptr);
    NS_ENSURE_SUCCESS(rv, rv);
    mFilterList = nullptr;
  }

  mInitialized = false;
#ifdef MOZ_PANORAMA
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    DetachNativeReadSet();
    mReadSet = nullptr;
    return nsMsgDBFolder::Shutdown(shutdownChildren);
  }
#endif
  if (mReadSet) {
    // the nsINewsDatabase holds a weak ref to the readset,
    // and we outlive the db, so it's safe to delete it here.
    nsCOMPtr<nsINewsDatabase> db = do_QueryInterface(mDatabase);
    if (db) db->SetReadSet(nullptr);
    mReadSet = nullptr;
  }
  return nsMsgDBFolder::Shutdown(shutdownChildren);
}

NS_IMETHODIMP
nsMsgNewsFolder::SetFilterList(nsIMsgFilterList* aFilterList) {
  if (mIsServer) {
    nsCOMPtr<nsIMsgIncomingServer> server;
    nsresult rv = GetServer(getter_AddRefs(server));
    NS_ENSURE_SUCCESS(rv, rv);
    return server->SetFilterList(aFilterList);
  }

  mFilterList = aFilterList;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::GetFilterList(nsIMsgWindow* aMsgWindow,
                               nsIMsgFilterList** aResult) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  if (mIsServer) {
    nsCOMPtr<nsIMsgIncomingServer> server;
    nsresult rv = GetServer(getter_AddRefs(server));
    NS_ENSURE_SUCCESS(rv, rv);
    return server->GetFilterList(aMsgWindow, aResult);
  }

  if (!mFilterList) {
    nsCOMPtr<nsIFile> thisFolder;
    nsresult rv = GetFilePath(getter_AddRefs(thisFolder));
    NS_ENSURE_SUCCESS(rv, rv);

    nsCOMPtr<nsIFile> filterFile = new nsLocalFile();
    rv = filterFile->InitWithFile(thisFolder);
    NS_ENSURE_SUCCESS(rv, rv);

    // in 4.x, the news filter file was
    // C:\Program
    // Files\Netscape\Users\meer\News\host-news.mcom.com\mcom.test.dat where the
    // summary file was C:\Program
    // Files\Netscape\Users\meer\News\host-news.mcom.com\mcom.test.snm we make
    // the rules file ".dat" in mozilla, so that migration works.

    // NOTE:
    // we don't we need to call NS_MsgHashIfNecessary()
    // it's already been hashed, if necessary
    nsAutoString filterFileName;
    rv = filterFile->GetLeafName(filterFileName);
    NS_ENSURE_SUCCESS(rv, rv);

    filterFileName.AppendLiteral(u".dat");

    rv = filterFile->SetLeafName(filterFileName);
    NS_ENSURE_SUCCESS(rv, rv);

    nsCOMPtr<nsIMsgFilterService> filterService =
        mozilla::components::Filter::Service();
    rv = filterService->OpenFilterList(filterFile, this, aMsgWindow,
                                       getter_AddRefs(mFilterList));
    NS_ENSURE_SUCCESS(rv, rv);
  }

  NS_IF_ADDREF(*aResult = mFilterList);
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::GetEditableFilterList(nsIMsgWindow* aMsgWindow,
                                       nsIMsgFilterList** aResult) {
  nsresult admissionRv = CheckMigrationWriterAdmission();
  NS_ENSURE_SUCCESS(admissionRv, admissionRv);
  // We don't support pluggable filter list types for news.
  return GetFilterList(aMsgWindow, aResult);
}

NS_IMETHODIMP
nsMsgNewsFolder::SetEditableFilterList(nsIMsgFilterList* aFilterList) {
  return SetFilterList(aFilterList);
}

NS_IMETHODIMP
nsMsgNewsFolder::GetIncomingServerType(nsACString& serverType) {
  serverType.AssignLiteral("nntp");
  return NS_OK;
}
