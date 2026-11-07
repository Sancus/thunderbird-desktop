/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "VirtualFolderWrapper.h"

#include "mozilla/Components.h"
#include "mozilla/AutoRestore.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/Services.h"
#include "nsIDBChangeListener.h"
#include "nsIDBFolderInfo.h"
#include "nsIFolderListener.h"
#include "nsIObserver.h"
#include "nsIObserverService.h"
#include "nsIMsgEnumerator.h"
#include "nsIMsgHdr.h"
#include "nsIMsgMailSession.h"
#include "nsIMsgSearchSession.h"
#include "nsMsgFolderFlags.h"
#include "nsMsgMessageFlags.h"
#include "nsMsgSearchCore.h"
#include "nsThreadUtils.h"
#include "nsTHashMap.h"
#include "nsCOMArray.h"
#include "MessageDatabase.h"
#include "nsIMsgFilter.h"
#include "nsIMsgFilterList.h"
#include "nsIMsgFilterService.h"
#include "nsIMsgSearchTerm.h"
#include "nsMsgUtils.h"
#include "nsReadableUtils.h"

namespace mozilla::mailnews {

// One native factory lifetime owns saved-search subscriptions. Wrapping a
// folder in JS does not create another enrollment or keep the subscriptions
// alive.
class SavedSearchBindings final : public MessageListener,
                                  public nsIDBChangeListener,
                                  public nsIFolderListener,
                                  public nsIObserver {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIDBCHANGELISTENER
  NS_DECL_NSIFOLDERLISTENER
  NS_DECL_NSIOBSERVER

  void Start();
  void Stop();
  nsresult Refresh(uint64_t focus = 0);
  nsresult DefinitionChanged(uint64_t id);
  void PublishDefinitions();

  bool SupportsThreadChanges() const override { return true; }
  void OnMessageThreadChanged(const CapturedMessage&, const CapturedMessage&,
                              Message*) override {
    Changed();
  }
  void OnMessageAdded(Message*) override { Changed(); }
  void OnMessageRemoved(Message*, uint32_t) override { Changed(); }
  void OnMessageFlagsChanged(nsIMsgDBHdr*, Message*, uint32_t,
                             uint32_t) override {
    Changed();
  }
  void OnMessageTagsChanged(nsIMsgDBHdr*, Message*, const nsACString&,
                            const nsACString&) override {
    Changed();
  }

 private:
  ~SavedSearchBindings() { Stop(); }
  struct State {
    nsCOMPtr<nsIMsgFolder> folder;
    nsCOMPtr<nsIMsgDatabase> database;
    nsCOMPtr<nsIDBFolderInfo> info;
    nsTArray<nsMsgKey> hits;
    nsCOMArray<nsIMsgDatabase> sources;
    int32_t unread = 0;
    int32_t fresh = 0;
  };
  nsresult Read(uint64_t id, State& state);
  nsresult Apply(const State& state);
  bool Current() const;
  void Changed();
  void Queue();
  nsresult Sync() {
    ++mSerial;
    mDirty = true;
    return Refresh();
  }
  nsCOMPtr<mozIStorageConnection> mConnection;
  nsCString mSource;
  MessageDatabase* mMessages = nullptr;  // Used only while Current().
  nsCOMPtr<nsIObserverService> mObservers;
  nsCOMPtr<nsIMsgMailSession> mMailSession;
  nsCOMArray<nsIMsgDatabase> mSources;
  nsTHashMap<nsUint64HashKey, nsresult> mErrors;
  nsTArray<uint64_t> mDefinitions;
  uint64_t mSerial = 0;
  nsresult mError = NS_OK;
  bool mDirty = true;
  bool mRetireMissingSources = false;
  bool mRefreshing = false;
  bool mQueued = false;
  bool mStopped = false;
};

static SavedSearchBindings* sBindings = nullptr;  // Owned by the factory.
NS_IMPL_ISUPPORTS(SavedSearchBindings, nsIDBChangeListener, nsIFolderListener,
                  nsIObserver)

bool SavedSearchBindings::Current() const {
  nsAutoCString source;
  return !mStopped && mConnection &&
         VirtualFolderWrapper::CurrentConnection() == mConnection &&
         VirtualFolderWrapper::CurrentMessages() == mMessages &&
         NS_SUCCEEDED(VirtualFolderWrapper::CurrentSource(source)) &&
         source == mSource;
}

void SavedSearchBindings::Start() {
  mConnection = VirtualFolderWrapper::CurrentConnection();
  if (!VirtualFolderWrapper::CurrentMessages() || !mConnection) {
    mError = NS_ERROR_NOT_AVAILABLE;
    return;
  }
  mError = VirtualFolderWrapper::CurrentSource(mSource);
  if (NS_FAILED(mError)) return;
  mMessages = VirtualFolderWrapper::CurrentMessages();
  mMessages->AddMessageListener(this);
  mObservers = mozilla::services::GetObserverService();
  mMailSession = mozilla::components::MailSession::Service();
  if (!mObservers || !mMailSession) {
    mError = NS_ERROR_NOT_AVAILABLE;
    return;
  }
  mError = mObservers->AddObserver(this, "quit-application-granted", false);
  if (NS_SUCCEEDED(mError)) {
    mError = mObservers->AddObserver(this, "profile-before-change", false);
  }
  if (NS_SUCCEEDED(mError)) {
    mError = mMailSession->AddFolderListener(
        this, nsIFolderListener::added | nsIFolderListener::removed);
  }
  // Resolve persisted folders after the account-manager Init stack unwinds.
  // Publications before this runnable are reconciled from complete storage.
  Queue();
}

void SavedSearchBindings::Stop() {
  if (mStopped) return;
  bool current = Current();
  mStopped = true;
  if (sBindings == this) sBindings = nullptr;
  for (int32_t i = 0; i < mSources.Count(); ++i) {
    mSources[i]->RemoveListener(this);
  }
  mSources.Clear();
  if (current) mMessages->RemoveMessageListener(this);
  mMessages = nullptr;
  if (mMailSession) mMailSession->RemoveFolderListener(this);
  mMailSession = nullptr;
  if (mObservers) {
    mObservers->RemoveObserver(this, "quit-application-granted");
    mObservers->RemoveObserver(this, "profile-before-change");
  }
  mObservers = nullptr;
  mConnection = nullptr;
  mDefinitions.Clear();
}

void SavedSearchBindings::Queue() {
  if (mStopped || mQueued) return;
  mQueued = true;
  RefPtr<SavedSearchBindings> self(this);
  nsresult rv = NS_DispatchToCurrentThread(
      NS_NewRunnableFunction("SavedSearchBindings::Refresh", [self] {
        self->mQueued = false;
        if (!self->Current()) return;
        self->Refresh();
        self->PublishDefinitions();
      }));
  if (NS_FAILED(rv)) {
    mQueued = false;
    mError = rv;
  }
}

void SavedSearchBindings::Changed() {
  ++mSerial;
  mDirty = true;
  // The physical facade may still be projecting NewList for this captured
  // native publication. Its ordinary callback supplies the synchronous update.
  Queue();
}

nsresult SavedSearchBindings::DefinitionChanged(uint64_t id) {
  ++mSerial;
  mDirty = true;
  if (!mDefinitions.Contains(id)) mDefinitions.AppendElement(id);
  nsresult rv = Refresh(id);
  Queue();
  return rv;
}

void SavedSearchBindings::PublishDefinitions() {
  if (!Current() || mRefreshing || !mObservers) return;
  nsTArray<uint64_t> definitions;
  definitions.SwapElements(mDefinitions);
  for (uint64_t id : definitions) {
    if (NS_FAILED(mErrors.Get(id))) continue;
    RefPtr<VirtualFolderWrapper> wrapper = new VirtualFolderWrapper(id);
    if (NS_FAILED(wrapper->CheckCurrent(false))) continue;
    mObservers->NotifyObservers(wrapper->mMsgFolder, "search-folders-changed",
                                nullptr);
  }
}

nsresult SavedSearchBindings::Read(uint64_t id, State& state) {
  RefPtr<VirtualFolderWrapper> wrapper = new VirtualFolderWrapper(id);
  MOZ_TRY(wrapper->CheckCurrent(false));
  nsAutoCString terms;
  MOZ_TRY(wrapper->GetSearchString(terms));
  // Creation sets the Virtual flag before its predicate and source list.
  if (terms.IsEmpty()) return NS_OK;
  nsTArray<RefPtr<nsIMsgFolder>> folders;
  MOZ_TRY(wrapper->GetSearchFolders(folders));
  nsTArray<RefPtr<nsIMsgSearchTerm>> searchTerms;
  MOZ_TRY(wrapper->GetSearchTerms(searchTerms));
  nsresult rv;
  nsCOMPtr<nsIMsgSearchSession> session =
      do_CreateInstance("@mozilla.org/messenger/searchSession;1", &rv);
  MOZ_TRY(rv);
  for (const auto& term : searchTerms) MOZ_TRY(session->AppendTerm(term));
  state.folder = wrapper->mMsgFolder;
  MOZ_TRY(state.folder->GetDBFolderInfoAndDB(getter_AddRefs(state.info),
                                             getter_AddRefs(state.database)));
  for (const auto& folder : folders) {
    NS_ENSURE_TRUE(folder, NS_ERROR_NOT_AVAILABLE);
    bool isServer;
    MOZ_TRY(folder->GetIsServer(&isServer));
    if (isServer) continue;
    uint32_t flags;
    MOZ_TRY(folder->GetFlags(&flags));
    NS_ENSURE_FALSE(flags & nsMsgFolderFlags::Virtual, NS_ERROR_ILLEGAL_VALUE);
    nsCOMPtr<nsIMsgDatabase> db;
    MOZ_TRY(folder->GetMsgDatabase(getter_AddRefs(db)));
    NS_ENSURE_TRUE(db, NS_ERROR_NOT_AVAILABLE);
    if (mSources.IndexOf(db) < 0) {
      MOZ_TRY(db->AddListener(this));
      mSources.AppendObject(db);
    }
    state.sources.AppendObject(db);
    nsCOMPtr<nsIMsgEnumerator> messages;
    MOZ_TRY(db->EnumerateMessages(getter_AddRefs(messages)));
    NS_ENSURE_TRUE(messages, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(session->AddScopeTerm(nsMsgSearchScope::offlineMail, folder));
    auto clear = mozilla::MakeScopeExit([&] { session->ClearScopes(); });
    bool more;
    while (true) {
      MOZ_TRY(messages->HasMoreElements(&more));
      if (!more) break;
      nsCOMPtr<nsIMsgDBHdr> header;
      MOZ_TRY(messages->GetNext(getter_AddRefs(header)));
      NS_ENSURE_TRUE(header, NS_ERROR_NOT_AVAILABLE);
      nsCOMPtr<nsIMsgFolder> physical;
      MOZ_TRY(header->GetFolder(getter_AddRefs(physical)));
      NS_ENSURE_TRUE(physical == folder, NS_ERROR_ILLEGAL_VALUE);
      bool match;
      MOZ_TRY(session->MatchHdr(header, db, &match));
      if (!match) continue;
      nsMsgKey key;
      MOZ_TRY(header->GetMessageKey(&key));
      NS_ENSURE_FALSE(state.hits.Contains(key), NS_ERROR_ILLEGAL_VALUE);
      NS_ENSURE_TRUE(state.hits.Length() < INT32_MAX, NS_ERROR_ILLEGAL_VALUE);
      state.hits.AppendElement(key);
      MOZ_TRY(header->GetFlags(&flags));
      if (!(flags & nsMsgMessageFlags::Read)) ++state.unread;
      if (flags & nsMsgMessageFlags::New) ++state.fresh;
    }
  }
  state.hits.Sort();
  return NS_OK;
}

nsresult SavedSearchBindings::Apply(const State& state) {
  if (!state.folder) return NS_OK;
  nsCString uri;
  MOZ_TRY(state.folder->GetURI(uri));
  // The fully checked current membership replaces raw cached keys. Resolving
  // old cached headers first would fail on exactly the keys just deleted.
  nsTArray<nsMsgKey> stale;
  MOZ_TRY(state.database->RefreshCache(uri, state.hits, stale));
  int32_t total, unread, fresh;
  MOZ_TRY(state.info->GetNumMessages(&total));
  MOZ_TRY(state.info->GetNumUnreadMessages(&unread));
  MOZ_TRY(state.folder->GetNumNewMessages(false, &fresh));
  if (total != int32_t(state.hits.Length())) {
    MOZ_TRY(state.info->SetNumMessages(state.hits.Length()));
  }
  if (unread != state.unread) {
    MOZ_TRY(state.info->SetNumUnreadMessages(state.unread));
  }
  if (total != int32_t(state.hits.Length()) || unread != state.unread) {
    MOZ_TRY(state.folder->UpdateSummaryTotals(true));
  }
  if (fresh != state.fresh)
    MOZ_TRY(state.folder->SetNumNewMessages(state.fresh));
  bool hasNew;
  MOZ_TRY(state.folder->GetHasNewMessages(&hasNew));
  if (hasNew != (state.fresh > 0)) {
    MOZ_TRY(state.folder->SetHasNewMessages(state.fresh > 0));
  }
  return NS_OK;
}

nsresult SavedSearchBindings::Refresh(uint64_t focus) {
  NS_ENSURE_TRUE(Current(), NS_ERROR_NOT_AVAILABLE);
  if (mRefreshing) return NS_OK;
  MOZ_TRY(mError);
  if (!mDirty && (!focus || NS_SUCCEEDED(mErrors.Get(focus)))) return NS_OK;
  mozilla::AutoRestore<bool> refreshing(mRefreshing);
  mRefreshing = true;
  bool transaction;
  MOZ_TRY(mConnection->GetTransactionInProgress(&transaction));
  NS_ENSURE_FALSE(transaction, NS_ERROR_IN_PROGRESS);
  nsTArray<uint64_t> ids, current;
  MOZ_TRY(VirtualFolderWrapper::SavedFolderIds(ids, current));
  bool retire = mRetireMissingSources;
  bool retireFailed = false;
  mRetireMissingSources = false;
  mDirty = false;
  nsCOMArray<nsIMsgDatabase> sources;
  for (uint64_t id : ids) {
    State state;
    uint64_t serial = mSerial;
    nsresult rv = NS_OK;
    if (retire) {
      // A real folder-loss notification retires missing sources only after a
      // complete checked current hierarchy read. Moves retain their live IDs.
      RefPtr<VirtualFolderWrapper> wrapper = new VirtualFolderWrapper(id);
      bool changed;
      rv = wrapper->RetireMissingSources(current, changed);
      if (NS_SUCCEEDED(rv) && changed && !mDefinitions.Contains(id)) {
        mDefinitions.AppendElement(id);
      }
      if (NS_FAILED(rv)) retireFailed = true;
    }
    if (NS_SUCCEEDED(rv)) rv = Read(id, state);
    if (NS_SUCCEEDED(rv) && serial != mSerial) rv = NS_ERROR_IN_PROGRESS;
    if (NS_SUCCEEDED(rv)) rv = Apply(state);
    mErrors.InsertOrUpdate(id, rv);
    if (NS_SUCCEEDED(rv)) {
      for (int32_t i = 0; i < state.sources.Count(); ++i) {
        if (sources.IndexOf(state.sources[i]) < 0)
          sources.AppendObject(state.sources[i]);
      }
    }
  }
  for (int32_t i = mSources.Count() - 1; i >= 0; --i) {
    if (sources.IndexOf(mSources[i]) < 0) {
      mSources[i]->RemoveListener(this);
      mSources.RemoveObjectAt(i);
    }
  }
  if (retireFailed) {
    mRetireMissingSources = true;
    mDirty = true;
  }
  return focus ? mErrors.Get(focus) : NS_OK;
}

NS_IMETHODIMP SavedSearchBindings::Observe(nsISupports*, const char*,
                                           const char16_t*) {
  Stop();
  return NS_OK;
}
NS_IMETHODIMP SavedSearchBindings::OnHdrAdded(nsIMsgDBHdr*, nsMsgKey, int32_t,
                                              nsIDBChangeListener*) {
  return Sync();
}
NS_IMETHODIMP SavedSearchBindings::OnHdrDeleted(nsIMsgDBHdr*, nsMsgKey, int32_t,
                                                nsIDBChangeListener*) {
  return Sync();
}
NS_IMETHODIMP SavedSearchBindings::OnHdrFlagsChanged(nsIMsgDBHdr*, uint32_t,
                                                     uint32_t,
                                                     nsIDBChangeListener*) {
  return Sync();
}
NS_IMETHODIMP SavedSearchBindings::OnHdrPropertyChanged(nsIMsgDBHdr*,
                                                        const nsACString&,
                                                        bool before,
                                                        uint32_t* status,
                                                        nsIDBChangeListener*) {
  if (before) {
    if (status) *status = 0;
    return NS_OK;
  }
  return Sync();
}
NS_IMETHODIMP SavedSearchBindings::OnReadChanged(nsIDBChangeListener*) {
  return Refresh();
}
NS_IMETHODIMP SavedSearchBindings::OnJunkScoreChanged(nsIDBChangeListener*) {
  return Sync();
}
NS_IMETHODIMP SavedSearchBindings::OnParentChanged(nsMsgKey, nsMsgKey, nsMsgKey,
                                                   nsIDBChangeListener*) {
  return NS_OK;
}
NS_IMETHODIMP SavedSearchBindings::OnEvent(nsIMsgDatabase*, const char*) {
  Changed();
  return NS_OK;
}
NS_IMETHODIMP SavedSearchBindings::OnAnnouncerGoingAway(
    nsIDBChangeAnnouncer* owner) {
  nsCOMPtr<nsIMsgDatabase> db = do_QueryInterface(owner);
  if (db) {
    db->RemoveListener(this);
    mSources.RemoveObject(db);
  }
  Changed();
  return NS_OK;
}
NS_IMETHODIMP SavedSearchBindings::OnFolderAdded(nsIMsgFolder*, nsIMsgFolder*) {
  Changed();
  return NS_OK;
}
NS_IMETHODIMP SavedSearchBindings::OnFolderRemoved(nsIMsgFolder*,
                                                   nsIMsgFolder*) {
  mRetireMissingSources = true;
  Changed();
  return NS_OK;
}
NS_IMETHODIMP SavedSearchBindings::OnMessageAdded(nsIMsgFolder* folder,
                                                  nsIMsgDBHdr*) {
  NS_ENSURE_TRUE(Current(), NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIMsgDatabase> db;
  MOZ_TRY(folder->GetMsgDatabase(getter_AddRefs(db)));
  // An enrolled physical DB already reconciled the publication. If a closed
  // announcer was replaced, enroll and reconcile before returning instead.
  return mSources.IndexOf(db) < 0 ? Sync() : Refresh();
}
NS_IMETHODIMP SavedSearchBindings::OnMessageRemoved(nsIMsgFolder* folder,
                                                    nsIMsgDBHdr* header) {
  return OnMessageAdded(folder, header);
}
NS_IMETHODIMP SavedSearchBindings::OnFolderPropertyChanged(nsIMsgFolder*,
                                                           const nsACString&,
                                                           const nsACString&,
                                                           const nsACString&) {
  return NS_OK;
}
NS_IMETHODIMP SavedSearchBindings::OnFolderIntPropertyChanged(nsIMsgFolder*,
                                                              const nsACString&,
                                                              int64_t,
                                                              int64_t) {
  return NS_OK;
}
NS_IMETHODIMP SavedSearchBindings::OnFolderBoolPropertyChanged(
    nsIMsgFolder*, const nsACString&, bool, bool) {
  return NS_OK;
}
NS_IMETHODIMP SavedSearchBindings::OnFolderPropertyFlagChanged(
    nsIMsgDBHdr*, const nsACString&, uint32_t, uint32_t) {
  return NS_OK;
}
NS_IMETHODIMP SavedSearchBindings::OnFolderEvent(nsIMsgFolder*,
                                                 const nsACString&) {
  return NS_OK;
}

mozIStorageConnection* VirtualFolderWrapper::CurrentConnection() {
  return DatabaseCore::sConnection;
}
MessageDatabase* VirtualFolderWrapper::CurrentMessages() {
  return DatabaseCore::sInstance
             ? DatabaseCore::sInstance->mMessageDatabase.get()
             : nullptr;
}

nsresult VirtualFolderWrapper::CurrentSource(nsACString& source) {
  NS_ENSURE_TRUE(DatabaseCore::sInstance, NS_ERROR_NOT_AVAILABLE);
  return DatabaseCore::sInstance->GetSourceId(source);
}
VirtualFolderWrapper::VirtualFolderWrapper()
    : mConnection(DatabaseCore::sConnection) {
  mSourceResult = CurrentSource(mSource);
}
VirtualFolderWrapper::VirtualFolderWrapper(uint64_t id)
    : mVirtualFolderId(id), mConnection(DatabaseCore::sConnection) {
  mSourceResult = CurrentSource(mSource);
}

nsresult VirtualFolderWrapper::SavedFolderIds(nsTArray<uint64_t>& ids,
                                              nsTArray<uint64_t>& current) {
  NS_ENSURE_TRUE(DatabaseCore::sInstance && DatabaseCore::sConnection,
                 NS_ERROR_NOT_AVAILABLE);
  auto& db = *DatabaseCore::sInstance->mFolderDatabase;
  nsTArray<uint64_t> roots = MOZ_TRY(db.GetFolderChildren(0));
  for (uint64_t root : roots) {
    nsTArray<uint64_t> descendants = MOZ_TRY(db.GetFolderDescendants(root));
    descendants.AppendElement(root);
    for (uint64_t id : descendants) {
      current.AppendElement(id);
      uint32_t flags = MOZ_TRY(db.GetFolderFlags(id));
      if (flags & nsMsgFolderFlags::Virtual) ids.AppendElement(id);
    }
  }
  return NS_OK;
}

nsresult VirtualFolderWrapper::CheckCurrent(bool refresh) {
  NS_ENSURE_TRUE(mConnection && DatabaseCore::sInstance &&
                     mConnection == DatabaseCore::sConnection,
                 NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(mSourceResult);
  nsAutoCString source;
  MOZ_TRY(CurrentSource(source));
  NS_ENSURE_TRUE(source == mSource, NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(mVirtualFolderId, NS_ERROR_NOT_INITIALIZED);
  uint32_t flags = MOZ_TRY(FolderDB().GetFolderFlags(mVirtualFolderId));
  NS_ENSURE_TRUE(flags & nsMsgFolderFlags::Virtual, NS_ERROR_ILLEGAL_VALUE);
  if (!mMsgFolder) {
    MOZ_TRY(FolderDB().GetMsgFolderForFolder(mVirtualFolderId,
                                             getter_AddRefs(mMsgFolder)));
  }
  return refresh && sBindings ? sBindings->Refresh(mVirtualFolderId) : NS_OK;
}

nsresult VirtualFolderWrapper::RetireMissingSources(
    const nsTArray<uint64_t>& current, bool& changed) {
  changed = false;
  MOZ_TRY(CheckCurrent(false));
  nsTArray<uint64_t> before, remaining;
  MOZ_TRY(FolderDB().GetVirtualFolderFolders(mVirtualFolderId, before));
  for (uint64_t id : before) {
    if (current.Contains(id)) remaining.AppendElement(id);
  }
  if (remaining != before) {
    MOZ_TRY(FolderDB().SetVirtualFolderFolders(mVirtualFolderId, remaining));
    changed = true;
  }
  return NS_OK;
}

NS_IMPL_ISUPPORTS(VirtualFolderWrapper, nsIVirtualFolderWrapper)

NS_IMETHODIMP VirtualFolderWrapper::GetVirtualFolder(nsIMsgFolder** msgFolder) {
  NS_ENSURE_ARG_POINTER(msgFolder);
  *msgFolder = nullptr;
  MOZ_TRY(CheckCurrent());
  NS_IF_ADDREF(*msgFolder = mMsgFolder);
  return NS_OK;
}

NS_IMETHODIMP VirtualFolderWrapper::SetVirtualFolder(nsIMsgFolder* msgFolder) {
  NS_ENSURE_ARG(msgFolder);
  NS_ENSURE_TRUE(mConnection == DatabaseCore::sConnection,
                 NS_ERROR_NOT_AVAILABLE);
  uint64_t id;
  MOZ_TRY(msgFolder->GetId(&id));
  nsCOMPtr<nsIMsgFolder> physical;
  MOZ_TRY(FolderDB().GetMsgFolderForFolder(id, getter_AddRefs(physical)));
  NS_ENSURE_TRUE(physical == msgFolder, NS_ERROR_ILLEGAL_VALUE);
  mMsgFolder = msgFolder;
  mVirtualFolderId = id;
  MOZ_TRY(CheckCurrent(false));
  return NS_OK;
}

NS_IMETHODIMP VirtualFolderWrapper::GetSearchFolderURIs(
    nsACString& searchFolderURIs) {
  nsTArray<RefPtr<nsIMsgFolder>> searchFolders;
  nsresult rv = GetSearchFolders(searchFolders);
  NS_ENSURE_SUCCESS(rv, rv);

  searchFolderURIs.Truncate();
  for (auto searchFolder : searchFolders) {
    if (!searchFolderURIs.IsEmpty()) {
      searchFolderURIs.Append('|');
    }
    searchFolderURIs.Append(searchFolder->URI());
  }

  return NS_OK;
}

nsTArray<uint64_t> VirtualFolderWrapper::GetSearchFolderIds() {
  nsTArray<uint64_t> searchFolderIds;
  FolderDB().GetVirtualFolderFolders(mVirtualFolderId, searchFolderIds);
  return searchFolderIds;
}

NS_IMETHODIMP VirtualFolderWrapper::GetSearchFolders(
    nsTArray<RefPtr<nsIMsgFolder>>& searchFolders) {
  MOZ_TRY(CheckCurrent());
  nsTArray<RefPtr<nsIMsgFolder>> result;
  nsTArray<uint64_t> searchFolderIds;
  nsresult rv =
      FolderDB().GetVirtualFolderFolders(mVirtualFolderId, searchFolderIds);
  NS_ENSURE_SUCCESS(rv, rv);

  for (auto searchFolderId : searchFolderIds) {
    nsCOMPtr<nsIMsgFolder> msgFolder;
    MOZ_TRY(FolderDB().GetMsgFolderForFolder(searchFolderId,
                                             getter_AddRefs(msgFolder)));
    result.AppendElement(msgFolder);
  }
  searchFolders = std::move(result);
  return NS_OK;
}

NS_IMETHODIMP VirtualFolderWrapper::SetSearchFolders(
    const nsTArray<RefPtr<nsIMsgFolder>>& searchFolders) {
  MOZ_TRY(CheckCurrent(false));
  nsTArray<uint64_t> searchFolderIds;

  for (auto msgFolder : searchFolders) {
    uint64_t searchFolderId;
    NS_ENSURE_TRUE(msgFolder, NS_ERROR_INVALID_ARG);
    MOZ_TRY(msgFolder->GetId(&searchFolderId));
    nsCOMPtr<nsIMsgFolder> physical;
    MOZ_TRY(FolderDB().GetMsgFolderForFolder(searchFolderId,
                                             getter_AddRefs(physical)));
    NS_ENSURE_TRUE(physical == msgFolder, NS_ERROR_ILLEGAL_VALUE);
    searchFolderIds.AppendElement(searchFolderId);
  }

  MOZ_TRY(
      FolderDB().SetVirtualFolderFolders(mVirtualFolderId, searchFolderIds));
  return sBindings ? sBindings->DefinitionChanged(mVirtualFolderId)
                   : NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP VirtualFolderWrapper::GetSearchString(nsACString& searchString) {
  MOZ_TRY(CheckCurrent());
  return FolderDB().GetFolderProperty(mVirtualFolderId, "searchStr"_ns,
                                      searchString);
}

NS_IMETHODIMP VirtualFolderWrapper::SetSearchString(
    const nsACString& searchString) {
  MOZ_TRY(CheckCurrent(false));
  nsCOMPtr<nsIMsgFilterList> list;
  nsCOMPtr<nsIMsgFilterService> service = components::Filter::Service();
  NS_ENSURE_TRUE(service, NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(service->GetTempFilterList(mMsgFolder, getter_AddRefs(list)));
  nsCOMPtr<nsIMsgFilter> filter;
  MOZ_TRY(list->CreateFilter(u"temp"_ns, getter_AddRefs(filter)));
  MOZ_TRY(list->ParseCondition(filter, searchString));
  MOZ_TRY(FolderDB().SetFolderProperty(mVirtualFolderId, "searchStr"_ns,
                                       searchString));
  return sBindings ? sBindings->DefinitionChanged(mVirtualFolderId)
                   : NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP VirtualFolderWrapper::GetSearchTermsSession(
    nsIMsgFilter** filter) {
  NS_ENSURE_ARG_POINTER(filter);
  *filter = nullptr;
  MOZ_TRY(CheckCurrent());
  nsCOMPtr<nsIMsgFilterService> filterService = components::Filter::Service();

  nsCOMPtr<nsIMsgFilterList> filterList;
  MOZ_TRY(
      filterService->GetTempFilterList(mMsgFolder, getter_AddRefs(filterList)));

  nsAutoCString searchString;
  MOZ_TRY(GetSearchString(searchString));
  nsCOMPtr<nsIMsgFilter> parsedFilter;
  MOZ_TRY(filterList->CreateFilter(u"temp"_ns, getter_AddRefs(parsedFilter)));
  MOZ_TRY(filterList->ParseCondition(parsedFilter, searchString));
  parsedFilter.forget(filter);
  return NS_OK;
}

NS_IMETHODIMP VirtualFolderWrapper::GetSearchTerms(
    nsTArray<RefPtr<nsIMsgSearchTerm>>& searchTerms) {
  nsCOMPtr<nsIMsgFilter> filter;
  MOZ_TRY(GetSearchTermsSession(getter_AddRefs(filter)));

  return filter->GetSearchTerms(searchTerms);
}

NS_IMETHODIMP VirtualFolderWrapper::SetSearchTerms(
    const nsTArray<RefPtr<nsIMsgSearchTerm>>& searchTerms) {
  nsAutoCString condition;

  for (auto term : searchTerms) {
    if (!condition.IsEmpty()) {
      condition.Append(" ");
    }

    bool matchAll;
    NS_ENSURE_TRUE(term, NS_ERROR_INVALID_ARG);
    MOZ_TRY(term->GetMatchAll(&matchAll));
    if (matchAll) {
      condition.Assign("ALL"_ns);
      break;
    }

    bool booleanAnd;
    MOZ_TRY(term->GetBooleanAnd(&booleanAnd));
    condition.Append(booleanAnd ? "AND ("_ns : "OR ("_ns);

    nsAutoCString termAsString;
    MOZ_TRY(term->GetTermAsString(termAsString));
    condition.Append(termAsString);
    condition.Append(")");
  }

  return SetSearchString(condition);
}

NS_IMETHODIMP VirtualFolderWrapper::GetOnlineSearch(bool* onlineSearch) {
  NS_ENSURE_ARG_POINTER(onlineSearch);
  MOZ_TRY(CheckCurrent());
  int64_t value = 0;
  MOZ_TRY(FolderDB().GetFolderProperty(mVirtualFolderId, "searchOnline"_ns,
                                       &value));
  *onlineSearch = value != 0;
  return NS_OK;
}

NS_IMETHODIMP VirtualFolderWrapper::SetOnlineSearch(bool onlineSearch) {
  MOZ_TRY(CheckCurrent(false));
  MOZ_TRY(FolderDB().SetFolderProperty(mVirtualFolderId, "searchOnline"_ns,
                                       (int64_t)onlineSearch));
  return sBindings ? sBindings->DefinitionChanged(mVirtualFolderId)
                   : NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP VirtualFolderWrapper::CleanUpMessageDatabase() {
  MOZ_TRY(CheckCurrent());
  if (sBindings) sBindings->PublishDefinitions();
  return NS_OK;
}

NS_IMPL_ISUPPORTS(VirtualFolderWrapperFactory, nsIFactory)
VirtualFolderWrapperFactory::VirtualFolderWrapperFactory()
    : mBindings(new SavedSearchBindings()) {
  sBindings = mBindings;
  mBindings->Start();
}
VirtualFolderWrapperFactory::~VirtualFolderWrapperFactory() {
  mBindings->Stop();
}

NS_IMETHODIMP VirtualFolderWrapperFactory::CreateInstance(const nsIID& iid,
                                                          void** result) {
  RefPtr inst = new VirtualFolderWrapper();
  return inst->QueryInterface(iid, result);
}

}  // namespace mozilla::mailnews
