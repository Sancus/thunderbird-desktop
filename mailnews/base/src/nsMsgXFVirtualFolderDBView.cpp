/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsMsgXFVirtualFolderDBView.h"

#include "mozilla/ProfilerMarkers.h"
#include "mozilla/StaticPrefs_mail.h"
#include "mozilla/AutoRestore.h"
#include "mozilla/ScopeExit.h"
#include "msgCore.h"
#include "nsIMsgHdr.h"
#include "nsIMsgThread.h"
#include "nsIDBFolderInfo.h"
#include "nsIMsgCopyService.h"
#include "nsMsgUtils.h"
#include "nsIMsgSearchSession.h"
#include "nsIMsgSearchTerm.h"
#include "nsMsgFolderFlags.h"
#include "nsMsgMessageFlags.h"
#include "nsServiceManagerUtils.h"

nsMsgXFVirtualFolderDBView::nsMsgXFVirtualFolderDBView() {
  m_doingSearch = false;
  m_doingQuickSearch = false;
  m_totalMessagesInView = 0;
  m_curFolderStartKeyIndex = -1;
  m_curFolderHasCachedHits = false;
}

nsMsgXFVirtualFolderDBView::~nsMsgXFVirtualFolderDBView() {}

NS_IMETHODIMP
nsMsgXFVirtualFolderDBView::Open(nsIMsgFolder* folder,
                                 nsMsgViewSortTypeValue sortType,
                                 nsMsgViewSortOrderValue sortOrder,
                                 nsMsgViewFlagsTypeValue viewFlags) {
  AUTO_PROFILER_LABEL("nsMsgXFVirtualFolderDBView::Open", MAILNEWS);
  m_viewFolder = folder;
  return nsMsgSearchDBView::Open(folder, sortType, sortOrder, viewFlags);
}

void nsMsgXFVirtualFolderDBView::RemovePendingDBListeners() {
  nsresult rv;
  nsCOMPtr<nsIMsgDBService> msgDBService =
      do_GetService("@mozilla.org/msgDatabase/msgDBService;1", &rv);

  if (!mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    // UnregisterPendingListener will return an error when there are no more
    // instances of this object registered as pending listeners.
    while (NS_SUCCEEDED(rv)) rv = msgDBService->UnregisterPendingListener(this);
  } else {
    // Native pending registration is immediate, and its service unregister is
    // a no-op. Release the registrations owned by this view instead.
    for (int32_t i = 0; i < m_dbToUseList.Count(); i++) {
      m_dbToUseList[i]->RemoveListener(this);
    }
    m_dbToUseList.Clear();
  }
}

NS_IMETHODIMP
nsMsgXFVirtualFolderDBView::Close() {
  ++mNativeSearchSerial;
  mNativeLiveMatches.Clear();
  RemovePendingDBListeners();
  return nsMsgSearchDBView::Close();
}

NS_IMETHODIMP
nsMsgXFVirtualFolderDBView::CloneDBView(nsIMsgWindow* aMsgWindow,
                                        nsIMsgDBViewCommandUpdater* aCmdUpdater,
                                        nsIMsgDBView** _retval) {
  nsMsgXFVirtualFolderDBView* newMsgDBView = new nsMsgXFVirtualFolderDBView();
  nsresult rv = CopyDBView(newMsgDBView, aMsgWindow, aCmdUpdater);
  NS_ENSURE_SUCCESS(rv, rv);

  NS_IF_ADDREF(*_retval = newMsgDBView);
  return NS_OK;
}

NS_IMETHODIMP
nsMsgXFVirtualFolderDBView::CopyDBView(
    nsMsgDBView* aNewMsgDBView, nsIMsgWindow* aMsgWindow,
    nsIMsgDBViewCommandUpdater* aCmdUpdater) {
  nsMsgSearchDBView::CopyDBView(aNewMsgDBView, aMsgWindow, aCmdUpdater);

  nsMsgXFVirtualFolderDBView* newMsgDBView =
      (nsMsgXFVirtualFolderDBView*)aNewMsgDBView;

  newMsgDBView->m_viewFolder = m_viewFolder;
  newMsgDBView->mNativeMembers.Clear();
  newMsgDBView->mNativeMembers.AppendObjects(mNativeMembers);
  newMsgDBView->m_searchSession = m_searchSession;

  // The base copy already registered the clone with its owned native DBs.
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    return NS_OK;
  }

  int32_t scopeCount;
  nsresult rv;
  nsCOMPtr<nsIMsgSearchSession> searchSession =
      do_QueryReferent(m_searchSession, &rv);
  // It's OK not to have a search session.
  NS_ENSURE_SUCCESS(rv, NS_OK);
  nsCOMPtr<nsIMsgDBService> msgDBService =
      do_GetService("@mozilla.org/msgDatabase/msgDBService;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  MOZ_TRY(searchSession->CountSearchScopes(&scopeCount));
  for (int32_t i = 0; i < scopeCount; i++) {
    nsMsgSearchScopeValue scopeId;
    nsCOMPtr<nsIMsgFolder> searchFolder;
    MOZ_TRY(searchSession->GetNthSearchScope(i, &scopeId,
                                             getter_AddRefs(searchFolder)));
    if (searchFolder)
      msgDBService->RegisterPendingListener(searchFolder, newMsgDBView);
  }

  return NS_OK;
}

NS_IMETHODIMP
nsMsgXFVirtualFolderDBView::GetViewType(nsMsgViewTypeValue* aViewType) {
  NS_ENSURE_ARG_POINTER(aViewType);
  *aViewType = nsMsgViewType::eShowVirtualFolderResults;
  return NS_OK;
}

nsresult nsMsgXFVirtualFolderDBView::OnNewHeader(nsIMsgDBHdr* newHdr,
                                                 nsMsgKey aParentKey,
                                                 bool /*ensureListed*/) {
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    return UpdateNativeMatch(newHdr);
  }
  if (newHdr) {
    bool match = false;
    nsCOMPtr<nsIMsgSearchSession> searchSession =
        do_QueryReferent(m_searchSession);

    if (searchSession) searchSession->MatchHdr(newHdr, m_db, &match);

    if (!match) match = WasHdrRecentlyDeleted(newHdr);

    if (match) {
      nsCOMPtr<nsIMsgFolder> folder;
      newHdr->GetFolder(getter_AddRefs(folder));
      bool saveDoingSearch = m_doingSearch;
      m_doingSearch = false;
      OnSearchHit(newHdr, folder);
      m_doingSearch = saveDoingSearch;
    }
  }
  return NS_OK;
}

NS_IMETHODIMP
nsMsgXFVirtualFolderDBView::OnHdrPropertyChanged(
    nsIMsgDBHdr* aHdrChanged, const nsACString& property, bool aPreChange,
    uint32_t* aStatus, nsIDBChangeListener* aInstigator) {
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    NS_ENSURE_ARG_POINTER(aStatus);
    *aStatus = 0;
    return aPreChange ? NS_OK : UpdateNativeMatch(aHdrChanged);
  }
  // If the junk mail plugin just activated on a message, then
  // we'll allow filters to remove from view.
  // Otherwise, just update the view line.
  //
  // Note this will not add newly matched headers to the view. This is
  // probably a bug that needs fixing.

  NS_ENSURE_ARG_POINTER(aStatus);
  NS_ENSURE_ARG_POINTER(aHdrChanged);

  nsMsgViewIndex index = FindHdr(aHdrChanged);
  // Message does not appear in view.
  if (index == nsMsgViewIndex_None) return NS_OK;

  nsCString originStr;
  (void)aHdrChanged->GetStringProperty("junkscoreorigin", originStr);
  // Check for "plugin" with only first character for performance.
  bool plugin = (originStr.get()[0] == 'p');

  if (aPreChange) {
    // First call, done prior to the change.
    *aStatus = plugin;
    return NS_OK;
  }

  // Second call, done after the change.
  bool wasPlugin = *aStatus;

  bool match = true;
  nsCOMPtr<nsIMsgSearchSession> searchSession(
      do_QueryReferent(m_searchSession));
  if (searchSession) searchSession->MatchHdr(aHdrChanged, m_db, &match);

  if (!match && plugin && !wasPlugin)
    // Remove hdr from view.
    RemoveByIndex(index);
  else
    NoteChange(index, 1, nsMsgViewNotificationCode::changed);

  return NS_OK;
}

nsresult nsMsgXFVirtualFolderDBView::NativeMemberIndex(nsIMsgDBHdr* header,
                                                       int32_t& index) {
  NS_ENSURE_ARG(header);
  index = mNativeMembers.IndexOf(header);
  if (index >= 0) return NS_OK;
  nsMsgKey key;
  MOZ_TRY(header->GetMessageKey(&key));
  for (int32_t i = 0; i < mNativeMembers.Count(); ++i) {
    nsMsgKey other;
    MOZ_TRY(mNativeMembers[i]->GetMessageKey(&other));
    if (other != key) continue;
    // Retired scan hits retain their key but no longer resolve a folder. Only
    // resolve an owner after finding a still-current native member with it.
    nsCOMPtr<nsIMsgFolder> folder, physical;
    MOZ_TRY(header->GetFolder(getter_AddRefs(folder)));
    MOZ_TRY(mNativeMembers[i]->GetFolder(getter_AddRefs(physical)));
    if (physical == folder) {
      index = i;
      break;
    }
  }
  return NS_OK;
}

nsresult nsMsgXFVirtualFolderDBView::UpdateNativeMatch(nsIMsgDBHdr* header) {
  NS_ENSURE_ARG(header);
  nsCOMPtr<nsIMsgSearchSession> session = do_QueryReferent(m_searchSession);
  NS_ENSURE_TRUE(session, NS_ERROR_NOT_INITIALIZED);
  nsCOMPtr<nsIMsgFolder> physical;
  MOZ_TRY(header->GetFolder(getter_AddRefs(physical)));
  bool match = false;
  int32_t count;
  MOZ_TRY(session->CountSearchScopes(&count));
  for (int32_t i = 0; i < count; ++i) {
    nsMsgSearchScopeValue type;
    nsCOMPtr<nsIMsgFolder> folder;
    MOZ_TRY(session->GetNthSearchScope(i, &type, getter_AddRefs(folder)));
    if (folder != physical) continue;
    nsCOMPtr<nsIMsgDatabase> db;
    MOZ_TRY(folder->GetMsgDatabase(getter_AddRefs(db)));
    MOZ_TRY(session->MatchHdr(header, db, &match));
    break;
  }
  int32_t member;
  MOZ_TRY(NativeMemberIndex(header, member));
  if (match && member < 0) {
    const bool duringSearch = m_doingSearch;
    const uint64_t serial = mNativeSearchSerial;
    mozilla::AutoRestore<bool> searching(m_doingSearch);
    m_doingSearch = false;
    MOZ_TRY(OnSearchHit(header, physical));
    if (duringSearch && serial == mNativeSearchSerial &&
        !mNativeLiveMatches.Contains(header)) {
      mNativeLiveMatches.AppendObject(header);
    }
    return NS_OK;
  }
  if (!match && member >= 0)
    return OnHdrDeleted(header, nsMsgKey_None, 0, this);
  return NS_OK;
}

NS_IMETHODIMP nsMsgXFVirtualFolderDBView::OnHdrFlagsChanged(
    nsIMsgDBHdr* header, uint32_t oldFlags, uint32_t newFlags,
    nsIDBChangeListener* instigator) {
  MOZ_TRY(nsMsgSearchDBView::OnHdrFlagsChanged(header, oldFlags, newFlags,
                                               instigator));
  return mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()
             ? UpdateNativeMatch(header)
             : NS_OK;
}

NS_IMETHODIMP nsMsgXFVirtualFolderDBView::OnHdrDeleted(
    nsIMsgDBHdr* header, nsMsgKey parent, int32_t flags,
    nsIDBChangeListener* instigator) {
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    int32_t member;
    MOZ_TRY(NativeMemberIndex(header, member));
    if (member >= 0) {
      MOZ_TRY(
          nsMsgSearchDBView::OnHdrDeleted(header, parent, flags, instigator));
      mNativeMembers.RemoveObjectAt(member);
      --m_totalMessagesInView;
    }
    nsMsgKey key;
    MOZ_TRY(header->GetMessageKey(&key));
    for (int32_t i = mNativeLiveMatches.Count() - 1; i >= 0; --i) {
      nsMsgKey liveKey;
      MOZ_TRY(mNativeLiveMatches[i]->GetMessageKey(&liveKey));
      if (liveKey == key) mNativeLiveMatches.RemoveObjectAt(i);
    }
    return NS_OK;
  }
  return nsMsgSearchDBView::OnHdrDeleted(header, parent, flags, instigator);
}

nsresult nsMsgXFVirtualFolderDBView::UpdateCacheAndViewForFolder(
    nsIMsgFolder* folder, nsTArray<nsMsgKey> const& newHits) {
  nsCOMPtr<nsIMsgDatabase> db;
  MOZ_TRY(folder->GetMsgDatabase(getter_AddRefs(db)));
  NS_ENSURE_TRUE(db && m_viewFolder, NS_ERROR_NOT_INITIALIZED);
  nsCString uri;
  MOZ_TRY(m_viewFolder->GetURI(uri));
  nsTArray<nsMsgKey> replacement = newHits.Clone();
  nsCOMArray<nsIMsgDBHdr> oldSourceHits;
  bool native = mozilla::StaticPrefs::mail_panorama_enabled_AtStartup();
  if (native) {
    uint32_t flags;
    MOZ_TRY(m_viewFolder->GetFlags(&flags));
    // The ordinary search-notify interface can also be populated directly on
    // a physical folder, with no saved predicate or search-session scope.
    if (!(flags & nsMsgFolderFlags::Virtual)) return NS_OK;
    nsCOMPtr<nsIMsgSearchSession> session = do_QueryReferent(m_searchSession);
    NS_ENSURE_TRUE(session, NS_ERROR_NOT_INITIALIZED);
    int32_t count;
    MOZ_TRY(session->CountSearchScopes(&count));
    nsCOMArray<nsIMsgFolder> scopes;
    for (int32_t i = 0; i < count; ++i) {
      nsMsgSearchScopeValue type;
      nsCOMPtr<nsIMsgFolder> scope;
      MOZ_TRY(session->GetNthSearchScope(i, &type, getter_AddRefs(scope)));
      NS_ENSURE_TRUE(scope, NS_ERROR_NOT_AVAILABLE);
      scopes.AppendObject(scope);
    }
    // A live match can belong to a scope with no scanner hits, or to a row
    // passed before that scope's first hit. Its lifetime is the whole search,
    // not the current scanner batch.
    for (int32_t i = 0; i < mNativeLiveMatches.Count(); ++i) {
      int32_t member;
      MOZ_TRY(NativeMemberIndex(mNativeLiveMatches[i], member));
      if (member < 0) continue;
      nsCOMPtr<nsIMsgFolder> physical;
      MOZ_TRY(mNativeMembers[member]->GetFolder(getter_AddRefs(physical)));
      if (physical != folder) continue;
      nsMsgKey key;
      MOZ_TRY(mNativeMembers[member]->GetMessageKey(&key));
      if (!replacement.Contains(key)) replacement.AppendElement(key);
    }
    // Validate all same-source keys, including live admissions, before merging
    // the other physical partitions from the complete native cache.
    for (nsMsgKey key : replacement) {
      nsCOMPtr<nsIMsgDBHdr> header;
      MOZ_TRY(db->GetMsgHdrForKey(key, getter_AddRefs(header)));
      NS_ENSURE_TRUE(header, NS_ERROR_NOT_AVAILABLE);
    }
    // Native cache keys are global, not partitioned by the receiver DB.
    // Finish the old enumeration before replacing the complete live union.
    nsCOMPtr<nsIMsgEnumerator> cached;
    MOZ_TRY(db->GetCachedHits(uri, getter_AddRefs(cached)));
    if (cached) {
      bool more;
      while (true) {
        MOZ_TRY(cached->HasMoreElements(&more));
        if (!more) break;
        nsCOMPtr<nsIMsgDBHdr> header;
        MOZ_TRY(cached->GetNext(getter_AddRefs(header)));
        NS_ENSURE_TRUE(header, NS_ERROR_NOT_AVAILABLE);
        nsCOMPtr<nsIMsgFolder> physical;
        MOZ_TRY(header->GetFolder(getter_AddRefs(physical)));
        NS_ENSURE_TRUE(physical, NS_ERROR_NOT_AVAILABLE);
        nsMsgKey key;
        MOZ_TRY(header->GetMessageKey(&key));
        if (physical == folder) {
          oldSourceHits.AppendObject(header);
        } else if (scopes.IndexOf(physical) >= 0) {
          nsCOMPtr<nsIMsgDatabase> owner;
          MOZ_TRY(physical->GetMsgDatabase(getter_AddRefs(owner)));
          nsCOMPtr<nsIMsgDBHdr> current;
          MOZ_TRY(owner->GetMsgHdrForKey(key, getter_AddRefs(current)));
          NS_ENSURE_TRUE(current, NS_ERROR_NOT_AVAILABLE);
          NS_ENSURE_FALSE(replacement.Contains(key), NS_ERROR_ILLEGAL_VALUE);
          replacement.AppendElement(key);
        }
      }
    }
  }
  replacement.Sort();
  for (size_t i = 1; i < replacement.Length(); ++i) {
    NS_ENSURE_TRUE(replacement[i - 1] != replacement[i],
                   NS_ERROR_ILLEGAL_VALUE);
  }
  nsTArray<nsMsgKey> stale;
  MOZ_TRY(db->RefreshCache(uri, replacement, stale));
  for (nsMsgKey key : stale) {
    nsCOMPtr<nsIMsgDBHdr> header;
    if (native) {
      for (int32_t i = 0; i < oldSourceHits.Count(); ++i) {
        nsMsgKey oldKey;
        MOZ_TRY(oldSourceHits[i]->GetMessageKey(&oldKey));
        if (key == oldKey) {
          header = oldSourceHits[i];
          break;
        }
      }
      if (!header) continue;  // Never resolve another source's key through F.
    } else {
      MOZ_TRY(db->GetMsgHdrForKey(key, getter_AddRefs(header)));
    }
    NS_ENSURE_TRUE(header, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(OnHdrDeleted(header, nsMsgKey_None, 0, this));
  }
  return NS_OK;
}

nsresult nsMsgXFVirtualFolderDBView::UpdateCacheAndViewForPrevSearchedFolders(
    nsIMsgFolder* current) {
  if (m_curFolderGettingHits) {
    nsTArray<nsMsgKey> hits;
    for (int32_t i = 0; i < m_hdrHits.Count(); ++i) {
      nsMsgKey key;
      MOZ_TRY(m_hdrHits[i]->GetMessageKey(&key));
      if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
        int32_t member;
        MOZ_TRY(NativeMemberIndex(m_hdrHits[i], member));
        if (member < 0) continue;
        nsCOMPtr<nsIMsgFolder> physical;
        MOZ_TRY(mNativeMembers[member]->GetFolder(getter_AddRefs(physical)));
        // Live notifications share this array with scanner hits. A matching
        // member of another scope is preserved by its own cache partition.
        if (physical != m_curFolderGettingHits || hits.Contains(key)) continue;
      }
      hits.AppendElement(key);
    }
    hits.Sort();
    MOZ_TRY(UpdateCacheAndViewForFolder(m_curFolderGettingHits, hits));
    m_foldersSearchingOver.RemoveObject(m_curFolderGettingHits);
  }
  while (m_foldersSearchingOver.Count()) {
    if (m_foldersSearchingOver[0] == current) {
      m_curFolderHasCachedHits = true;
      m_foldersSearchingOver.RemoveObjectAt(0);
      break;
    }
    nsTArray<nsMsgKey> empty;
    MOZ_TRY(UpdateCacheAndViewForFolder(m_foldersSearchingOver[0], empty));
    m_foldersSearchingOver.RemoveObjectAt(0);
  }
  return NS_OK;
}

NS_IMETHODIMP
nsMsgXFVirtualFolderDBView::OnSearchHit(nsIMsgDBHdr* aMsgHdr,
                                        nsIMsgFolder* aFolder) {
  NS_ENSURE_ARG(aMsgHdr);
  NS_ENSURE_ARG(aFolder);
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    nsCOMPtr<nsIMsgFolder> physical;
    MOZ_TRY(aMsgHdr->GetFolder(getter_AddRefs(physical)));
    NS_ENSURE_TRUE(physical == aFolder, NS_ERROR_ILLEGAL_VALUE);
  }

  if (m_curFolderGettingHits != aFolder && m_doingSearch &&
      !m_doingQuickSearch) {
    m_curFolderHasCachedHits = false;
    // Since we've gotten a hit for a new folder, the searches for
    // any previous folders are done, so deal with stale cached hits
    // for those folders now.
    MOZ_TRY(UpdateCacheAndViewForPrevSearchedFolders(aFolder));
    m_curFolderGettingHits = aFolder;
    m_hdrHits.Clear();
    m_curFolderStartKeyIndex = m_keys.Length();
  }

  bool hdrInCache = false;
  if (!m_doingQuickSearch) {
    nsCOMPtr<nsIMsgDatabase> dbToUse;
    nsCOMPtr<nsIDBFolderInfo> dummyInfo;
    nsresult rv = aFolder->GetDBFolderInfoAndDB(getter_AddRefs(dummyInfo),
                                                getter_AddRefs(dbToUse));
    NS_ENSURE_SUCCESS(rv, rv);
    if (dbToUse) {
      nsCString searchUri;
      MOZ_TRY(m_viewFolder->GetURI(searchUri));
      MOZ_TRY(dbToUse->HdrIsInCache(searchUri, aMsgHdr, &hdrInCache));
    }
  }

  int32_t nativeMember = -1;
  bool native = mozilla::StaticPrefs::mail_panorama_enabled_AtStartup();
  if (native) MOZ_TRY(NativeMemberIndex(aMsgHdr, nativeMember));
  if ((native && nativeMember < 0) ||
      (!native &&
       (!m_doingSearch || !m_curFolderHasCachedHits || !hdrInCache))) {
    if (m_viewFlags & nsMsgViewFlagsType::kGroupBySort)
      MOZ_TRY(nsMsgGroupView::OnNewHeader(aMsgHdr, nsMsgKey_None, true));
    else if (m_sortValid)
      MOZ_TRY(InsertHdrFromFolder(aMsgHdr, aFolder));
    else
      MOZ_TRY(AddHdrFromFolder(aMsgHdr, aFolder));
  }

  m_hdrHits.AppendObject(aMsgHdr);
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    int32_t member;
    MOZ_TRY(NativeMemberIndex(aMsgHdr, member));
    if (member < 0) {
      mNativeMembers.AppendObject(aMsgHdr);
      ++m_totalMessagesInView;
    }
  } else {
    ++m_totalMessagesInView;
  }

  return NS_OK;
}

NS_IMETHODIMP
nsMsgXFVirtualFolderDBView::OnSearchDone(nsresult status) {
  const uint64_t serial = mNativeSearchSerial;
  auto clearLiveMatches = mozilla::MakeScopeExit([&] {
    if (serial == mNativeSearchSerial) mNativeLiveMatches.Clear();
  });
  // This batch began in OnNewSearch.
  if (mJSTree) mJSTree->EndUpdateBatch();

  NS_ENSURE_TRUE(m_viewFolder, NS_ERROR_NOT_INITIALIZED);

  m_doingSearch = false;
  // Handle any non verified hits we haven't handled yet.
  if (NS_SUCCEEDED(status) && !m_doingQuickSearch &&
      status != NS_MSG_SEARCH_INTERRUPTED) {
    if (mJSTree) mJSTree->BeginUpdateBatch();
    nsresult cacheResult = UpdateCacheAndViewForPrevSearchedFolders(nullptr);
    if (mJSTree) mJSTree->EndUpdateBatch();
    NS_ENSURE_SUCCESS(cacheResult, cacheResult);
  }

  m_doingSearch = false;
  NS_ENSURE_SUCCESS(status, status);
  if (status == NS_MSG_SEARCH_INTERRUPTED) return status;

  if (!mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    // Native saved-folder summaries belong to the persistent complete binding,
    // not to a view narrowed by a mail view or quick filter.
    nsCOMPtr<nsIMsgDatabase> virtDatabase;
    nsCOMPtr<nsIDBFolderInfo> dbFolderInfo;
    nsresult rv = m_viewFolder->GetDBFolderInfoAndDB(
        getter_AddRefs(dbFolderInfo), getter_AddRefs(virtDatabase));
    NS_ENSURE_SUCCESS(rv, rv);
    // Count up the number of unread and total messages from the view, and set
    // those in the folder - easier than trying to keep the count up to date in
    // the face of search hits coming in while the user is reading/deleting
    // messages.
    uint32_t numUnread = 0;
    for (uint32_t i = 0; i < m_flags.Length(); i++) {
      if (m_flags[i] & nsMsgMessageFlags::Elided) {
        nsCOMPtr<nsIMsgThread> thread;
        GetThreadContainingIndex(i, getter_AddRefs(thread));
        if (thread) {
          uint32_t unreadInThread;
          thread->GetNumUnreadChildren(&unreadInThread);
          numUnread += unreadInThread;
        }
      } else {
        if (!(m_flags[i] & nsMsgMessageFlags::Read)) numUnread++;
      }
    }

    MOZ_TRY(dbFolderInfo->SetNumUnreadMessages(numUnread));
    MOZ_TRY(dbFolderInfo->SetNumMessages(m_totalMessagesInView));
    // Force update from db.
    MOZ_TRY(m_viewFolder->UpdateSummaryTotals(true));
    MOZ_TRY(virtDatabase->Commit(nsMsgDBCommitType::kLargeCommit));
  }
  if (!m_sortValid && m_sortType != nsMsgViewSortType::byThread &&
      !(m_viewFlags & nsMsgViewFlagsType::kThreadedDisplay)) {
    // Sort the results.
    m_sortValid = false;
    Sort(m_sortType, m_sortOrder);
  }

  m_foldersSearchingOver.Clear();
  m_curFolderGettingHits = nullptr;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgXFVirtualFolderDBView::OnNewSearch() {
  int32_t oldSize = GetSize();

  RemovePendingDBListeners();
  m_doingSearch = true;
  m_totalMessagesInView = 0;
  mNativeMembers.Clear();
  ++mNativeSearchSerial;
  mNativeLiveMatches.Clear();
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    // Every search owns a fresh scope cursor and hit batch. In particular, an
    // empty first scope must not leave the previous last scope/hits active.
    m_curFolderGettingHits = nullptr;
    m_curFolderHasCachedHits = false;
    m_curFolderStartKeyIndex = 0;
    m_hdrHits.Clear();
    m_foldersSearchingOver.Clear();
    // Reusing this saved-search view must not reuse the old scope's members.
    m_threadsTable.Clear();
    m_hdrsTable.Clear();
    m_groupsTable.Clear();
    m_nextThreadId = 1;
  }
  m_folders.Clear();
  m_keys.Clear();
  m_levels.Clear();
  m_flags.Clear();

  // Needs to happen after we remove the keys, since RowCountChanged() will
  // call our GetRowCount().
  if (mTree) mTree->RowCountChanged(0, -oldSize);
  if (mJSTree) mJSTree->RowCountChanged(0, -oldSize);

  // To use the search results cache, we'll need to iterate over the scopes
  // in the search session, calling getNthSearchScope
  // for i = 0; i < searchSession.countSearchScopes; i++
  // and for each folder, then open the db and pull out the cached hits,
  // add them to the view. For each hit in a new folder, we'll then clean up
  // the stale hits from the previous folder(s).

  int32_t scopeCount;
  nsCOMPtr<nsIMsgSearchSession> searchSession =
      do_QueryReferent(m_searchSession);
  // Just ignore.
  NS_ENSURE_TRUE(searchSession, NS_OK);
  nsCOMPtr<nsIMsgDBService> msgDBService =
      do_GetService("@mozilla.org/msgDatabase/msgDBService;1");
  MOZ_TRY(searchSession->CountSearchScopes(&scopeCount));

  // Figure out how many search terms the virtual folder has.
  nsCOMPtr<nsIMsgDatabase> virtDatabase;
  nsCOMPtr<nsIDBFolderInfo> dbFolderInfo;
  nsresult rv = m_viewFolder->GetDBFolderInfoAndDB(
      getter_AddRefs(dbFolderInfo), getter_AddRefs(virtDatabase));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCString terms;
  dbFolderInfo->GetCharProperty("searchStr", terms);
  nsTArray<RefPtr<nsIMsgSearchTerm>> searchTerms;
  rv = searchSession->GetSearchTerms(searchTerms);
  NS_ENSURE_SUCCESS(rv, rv);
  nsCString curSearchAsString;

  rv = MsgTermListToString(searchTerms, curSearchAsString);
  // Trim off the initial AND/OR, which is irrelevant and inconsistent between
  // what SearchSpec.sys.mjs generates, and what's in virtualFolders.dat.
  curSearchAsString.Cut(0,
                        StringBeginsWith(curSearchAsString, "AND"_ns) ? 3 : 2);
  terms.Cut(0, StringBeginsWith(terms, "AND"_ns) ? 3 : 2);

  NS_ENSURE_SUCCESS(rv, rv);
  // If the search session search string doesn't match the vf search str,
  // then we're doing quick search, which means we don't want to invalidate
  // cached results, or used cached results.
  m_doingQuickSearch = !curSearchAsString.Equals(terms);

  if (!m_doingQuickSearch) {
    if (mTree) mTree->BeginUpdateBatch();
    if (mJSTree) mJSTree->BeginUpdateBatch();
  }

  bool cacheBatch = !m_doingQuickSearch;
  auto endCacheBatch = mozilla::MakeScopeExit([&] {
    if (cacheBatch) {
      if (mTree) mTree->EndUpdateBatch();
      if (mJSTree) mJSTree->EndUpdateBatch();
    }
  });
  for (int32_t i = 0; i < scopeCount; i++) {
    nsMsgSearchScopeValue scopeId;
    nsCOMPtr<nsIMsgFolder> searchFolder;
    MOZ_TRY(searchSession->GetNthSearchScope(i, &scopeId,
                                             getter_AddRefs(searchFolder)));
    if (searchFolder) {
      nsCOMPtr<nsIMsgDatabase> searchDB;
      nsCString searchUri;
      MOZ_TRY(m_viewFolder->GetURI(searchUri));
      nsresult rv = searchFolder->GetMsgDatabase(getter_AddRefs(searchDB));
      NS_ENSURE_SUCCESS(rv, rv);
      NS_ENSURE_TRUE(searchDB, NS_ERROR_NOT_AVAILABLE);
      if (searchDB) {
        if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
          if (m_dbToUseList.IndexOf(searchDB) < 0) {
            if (!m_dbToUseList.AppendObject(searchDB)) {
              return NS_ERROR_OUT_OF_MEMORY;
            }
            rv = searchDB->AddListener(this);
            if (NS_FAILED(rv)) {
              m_dbToUseList.RemoveObject(searchDB);
              return rv;
            }
          }
        } else if (msgDBService) {
          msgDBService->RegisterPendingListener(searchFolder, this);
        }

        m_foldersSearchingOver.AppendObject(searchFolder);
        // Ignore cached hits in quick search case.
        if (m_doingQuickSearch) continue;

        nsCOMPtr<nsIMsgEnumerator> cachedHits;
        MOZ_TRY(searchDB->GetCachedHits(searchUri, getter_AddRefs(cachedHits)));
        nsCOMArray<nsIMsgDBHdr> admitted;
        if (cachedHits) {
          bool more;
          while (true) {
            MOZ_TRY(cachedHits->HasMoreElements(&more));
            if (!more) break;
            nsCOMPtr<nsIMsgDBHdr> header;
            MOZ_TRY(cachedHits->GetNext(getter_AddRefs(header)));
            NS_ENSURE_TRUE(header, NS_ERROR_NOT_AVAILABLE);
            nsCOMPtr<nsIMsgFolder> physical;
            MOZ_TRY(header->GetFolder(getter_AddRefs(physical)));
            if (physical != searchFolder) {
              NS_ENSURE_TRUE(
                  mozilla::StaticPrefs::mail_panorama_enabled_AtStartup(),
                  NS_ERROR_ILLEGAL_VALUE);
              continue;
            }
            nsMsgKey key;
            MOZ_TRY(header->GetMessageKey(&key));
            nsCOMPtr<nsIMsgDBHdr> current;
            MOZ_TRY(searchDB->GetMsgHdrForKey(key, getter_AddRefs(current)));
            NS_ENSURE_TRUE(current, NS_ERROR_NOT_AVAILABLE);
            admitted.AppendObject(current);
          }
        }
        // A failed/partial source enumeration must not publish its row prefix.
        for (int32_t j = 0; j < admitted.Count(); ++j) {
          MOZ_TRY(AddHdrFromFolder(admitted[j], searchFolder));
          if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
            mNativeMembers.AppendObject(admitted[j]);
            ++m_totalMessagesInView;
          }
        }
      }
    }
  }

  if (!m_doingQuickSearch) {
    if (mTree) mTree->EndUpdateBatch();
    if (mJSTree) mJSTree->EndUpdateBatch();
  }

  cacheBatch = false;
  m_curFolderStartKeyIndex = 0;
  m_curFolderGettingHits = nullptr;
  m_curFolderHasCachedHits = false;

  // If we have cached hits, sort them.
  if (GetSize() > 0) {
    // Currently, we keep threaded views sorted while we build them.
    if (m_sortType != nsMsgViewSortType::byThread &&
        !(m_viewFlags & nsMsgViewFlagsType::kThreadedDisplay)) {
      // Sort the results.
      m_sortValid = false;
      Sort(m_sortType, m_sortOrder);
    } else if (mJSTree) {
      mJSTree->Invalidate();
    }
  }

  // Prevent updates for every message found. This batch ends in OnSearchDone.
  if (mJSTree) mJSTree->BeginUpdateBatch();

  return NS_OK;
}

NS_IMETHODIMP
nsMsgXFVirtualFolderDBView::DoCommand(nsMsgViewCommandTypeValue command) {
  return nsMsgSearchDBView::DoCommand(command);
}

NS_IMETHODIMP
nsMsgXFVirtualFolderDBView::GetMsgFolder(nsIMsgFolder** aMsgFolder) {
  NS_ENSURE_ARG_POINTER(aMsgFolder);
  NS_IF_ADDREF(*aMsgFolder = m_viewFolder);
  return NS_OK;
}

nsresult nsMsgXFVirtualFolderDBView::GetMessageEnumerator(
    nsIMsgEnumerator** enumerator) {
  return GetViewEnumerator(enumerator);
}
