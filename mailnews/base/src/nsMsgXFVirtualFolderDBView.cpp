/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsMsgXFVirtualFolderDBView.h"

#include "mozilla/ProfilerMarkers.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/StaticPrefs_mail.h"
#include "msgCore.h"
#include "nsIMsgHdr.h"
#include "nsIMsgThread.h"
#include "nsIDBFolderInfo.h"
#include "nsIMsgCopyService.h"
#include "nsMsgUtils.h"
#include "nsIMsgSearchSession.h"
#include "nsIMsgSearchTerm.h"
#include "nsMsgMessageFlags.h"
#include "nsServiceManagerUtils.h"

// Materialize the native global cache before any replacement. Validate each
// header through its actual physical database, not the cursor owner's database.
static nsresult ReadNativeCachedHits(nsIMsgDatabase* db,
                                     const nsACString& searchUri,
                                     nsCOMArray<nsIMsgDBHdr>& headers) {
  nsCOMPtr<nsIMsgEnumerator> cached;
  nsresult rv = db->GetCachedHits(searchUri, getter_AddRefs(cached));
  NS_ENSURE_SUCCESS(rv, rv);
  if (!cached) return NS_OK;

  while (true) {
    bool more = false;
    rv = cached->HasMoreElements(&more);
    NS_ENSURE_SUCCESS(rv, rv);
    if (!more) return NS_OK;

    nsCOMPtr<nsIMsgDBHdr> header;
    rv = cached->GetNext(getter_AddRefs(header));
    NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(header, NS_ERROR_UNEXPECTED);
    nsMsgKey key;
    rv = header->GetMessageKey(&key);
    NS_ENSURE_SUCCESS(rv, rv);
    nsCOMPtr<nsIMsgFolder> physicalFolder;
    rv = header->GetFolder(getter_AddRefs(physicalFolder));
    NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(physicalFolder, NS_ERROR_UNEXPECTED);
    nsCOMPtr<nsIMsgDatabase> physicalDB;
    rv = physicalFolder->GetMsgDatabase(getter_AddRefs(physicalDB));
    NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(physicalDB, NS_ERROR_UNEXPECTED);
    nsCOMPtr<nsIMsgDBHdr> current;
    rv = physicalDB->GetMsgHdrForKey(key, getter_AddRefs(current));
    NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(current, NS_ERROR_UNEXPECTED);
    nsCOMPtr<nsIMsgFolder> currentFolder;
    rv = current->GetFolder(getter_AddRefs(currentFolder));
    NS_ENSURE_SUCCESS(rv, rv);
    nsMsgKey currentKey;
    rv = current->GetMessageKey(&currentKey);
    NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(currentFolder == physicalFolder && currentKey == key,
                   NS_ERROR_ILLEGAL_VALUE);
    NS_ENSURE_TRUE(headers.AppendObject(current), NS_ERROR_OUT_OF_MEMORY);
  }
}

nsMsgXFVirtualFolderDBView::nsMsgXFVirtualFolderDBView() {
  m_doingSearch = false;
  m_searchBatchOpen = false;
  m_cacheStatus = NS_OK;
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
  }
}

NS_IMETHODIMP
nsMsgXFVirtualFolderDBView::Close() {
  if (m_searchBatchOpen && mJSTree) mJSTree->EndUpdateBatch();
  m_searchBatchOpen = false;
  RemovePendingDBListeners();
  return nsMsgSearchDBView::Close();
}

NS_IMETHODIMP
nsMsgXFVirtualFolderDBView::CloneDBView(nsIMsgWindow* aMsgWindow,
                                        nsIMsgDBViewCommandUpdater* aCmdUpdater,
                                        nsIMsgDBView** _retval) {
  nsMsgXFVirtualFolderDBView* newMsgDBView = new nsMsgXFVirtualFolderDBView();
  nsresult rv =
      CopyDBView(newMsgDBView, aMsgWindow, aCmdUpdater);
  NS_ENSURE_SUCCESS(rv, rv);

  NS_IF_ADDREF(*_retval = newMsgDBView);
  return NS_OK;
}

NS_IMETHODIMP
nsMsgXFVirtualFolderDBView::CopyDBView(
    nsMsgDBView* aNewMsgDBView, nsIMsgWindow* aMsgWindow, nsIMsgDBViewCommandUpdater* aCmdUpdater) {
  nsMsgSearchDBView::CopyDBView(aNewMsgDBView, aMsgWindow,
                                aCmdUpdater);

  nsMsgXFVirtualFolderDBView* newMsgDBView =
      (nsMsgXFVirtualFolderDBView*)aNewMsgDBView;

  newMsgDBView->m_viewFolder = m_viewFolder;
  newMsgDBView->m_searchSession = m_searchSession;

  int32_t scopeCount;
  nsresult rv;
  nsCOMPtr<nsIMsgSearchSession> searchSession =
      do_QueryReferent(m_searchSession, &rv);
  // It's OK not to have a search session.
  NS_ENSURE_SUCCESS(rv, NS_OK);
  nsCOMPtr<nsIMsgDBService> msgDBService =
      do_GetService("@mozilla.org/msgDatabase/msgDBService;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  searchSession->CountSearchScopes(&scopeCount);
  for (int32_t i = 0; i < scopeCount; i++) {
    nsMsgSearchScopeValue scopeId;
    nsCOMPtr<nsIMsgFolder> searchFolder;
    searchSession->GetNthSearchScope(i, &scopeId, getter_AddRefs(searchFolder));
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
nsMsgXFVirtualFolderDBView::OnHdrDeleted(nsIMsgDBHdr* header,
                                         nsMsgKey parentKey, int32_t flags,
                                         nsIDBChangeListener* instigator) {
  NS_ENSURE_ARG_POINTER(header);
  nsresult cacheStatus = NS_OK;
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup() && m_viewFolder) {
    // Native hit keys are global. Remove this deleted key without enumerating
    // its now-missing physical row or replacing another source folder's hits.
    nsCString searchUri;
    cacheStatus = m_viewFolder->GetURI(searchUri);
    if (NS_SUCCEEDED(cacheStatus)) {
      nsCOMPtr<nsIMsgDatabase> db;
      cacheStatus = m_viewFolder->GetMsgDatabase(getter_AddRefs(db));
      if (NS_SUCCEEDED(cacheStatus)) {
        cacheStatus = db ? db->UpdateHdrInCache(searchUri, header, false)
                         : NS_ERROR_UNEXPECTED;
      }
    }
  }
  // The real deletion must still leave the view if updating the cache fails.
  nsresult rv =
      nsMsgSearchDBView::OnHdrDeleted(header, parentKey, flags, instigator);
  if (NS_FAILED(cacheStatus)) {
    m_cacheStatus = cacheStatus;
    return cacheStatus;
  }
  return rv;
}

NS_IMETHODIMP
nsMsgXFVirtualFolderDBView::OnHdrPropertyChanged(
    nsIMsgDBHdr* aHdrChanged, const nsACString& property, bool aPreChange,
    uint32_t* aStatus, nsIDBChangeListener* aInstigator) {
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

nsresult nsMsgXFVirtualFolderDBView::UpdateCacheAndViewForFolder(
    nsIMsgFolder* folder, nsTArray<nsMsgKey> const& newHits) {
  nsCOMPtr<nsIMsgDatabase> db;
  nsresult rv = folder->GetMsgDatabase(getter_AddRefs(db));
  if (NS_SUCCEEDED(rv) && db) {
    nsCString searchUri;
    rv = m_viewFolder->GetURI(searchUri);
    if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
      NS_ENSURE_SUCCESS(rv, rv);
      return UpdateNativeCacheAndViewForFolder(folder, db, searchUri, newHits);
    }
    nsTArray<nsMsgKey> badHits;
    rv = db->RefreshCache(searchUri, newHits, badHits);
    if (NS_SUCCEEDED(rv)) {
      nsCOMPtr<nsIMsgDBHdr> badHdr;
      for (nsMsgKey badKey : badHits) {
        // ### of course, this isn't quite right, since we should be
        // using FindHdr, and we shouldn't be expanding the threads.
        db->GetMsgHdrForKey(badKey, getter_AddRefs(badHdr));
        // Let nsMsgSearchDBView decide what to do about this header
        // getting removed.
        if (badHdr) OnHdrDeleted(badHdr, nsMsgKey_None, 0, this);
      }
    }
  }
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(db, NS_ERROR_UNEXPECTED);
  }
  return NS_OK;
}

nsresult nsMsgXFVirtualFolderDBView::UpdateNativeCacheAndViewForFolder(
    nsIMsgFolder* folder, nsIMsgDatabase* db, const nsACString& searchUri,
    const nsTArray<nsMsgKey>& newHits) {
  nsCOMArray<nsIMsgDBHdr> cached;
  nsresult rv = ReadNativeCachedHits(db, searchUri, cached);
  NS_ENSURE_SUCCESS(rv, rv);

  nsTArray<nsMsgKey> replacement;
  nsTArray<nsMsgKey> oldSourceKeys;
  nsCOMArray<nsIMsgDBHdr> oldSourceHeaders;
  for (nsMsgKey key : newHits) {
    nsCOMPtr<nsIMsgDBHdr> header;
    rv = db->GetMsgHdrForKey(key, getter_AddRefs(header));
    NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(header, NS_ERROR_UNEXPECTED);
    nsCOMPtr<nsIMsgFolder> physicalFolder;
    rv = header->GetFolder(getter_AddRefs(physicalFolder));
    NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(physicalFolder == folder, NS_ERROR_ILLEGAL_VALUE);
    if (!replacement.Contains(key)) replacement.AppendElement(key);
  }
  for (int32_t i = 0; i < cached.Count(); ++i) {
    nsIMsgDBHdr* header = cached[i];
    nsMsgKey key;
    rv = header->GetMessageKey(&key);
    NS_ENSURE_SUCCESS(rv, rv);
    nsCOMPtr<nsIMsgFolder> physicalFolder;
    rv = header->GetFolder(getter_AddRefs(physicalFolder));
    NS_ENSURE_SUCCESS(rv, rv);
    if (physicalFolder == folder) {
      oldSourceKeys.AppendElement(key);
      NS_ENSURE_TRUE(oldSourceHeaders.AppendObject(header),
                     NS_ERROR_OUT_OF_MEMORY);
    } else if (!replacement.Contains(key)) {
      replacement.AppendElement(key);
    }
  }
  replacement.Sort();
  nsTArray<nsMsgKey> stale;
  rv = db->RefreshCache(searchUri, replacement, stale);
  NS_ENSURE_SUCCESS(rv, rv);
  for (nsMsgKey key : stale) {
    auto index = oldSourceKeys.IndexOf(key);
    NS_ENSURE_TRUE(index != nsTArray<nsMsgKey>::NoIndex, NS_ERROR_UNEXPECTED);
    rv = OnHdrDeleted(oldSourceHeaders[index], nsMsgKey_None, 0, this);
    NS_ENSURE_SUCCESS(rv, rv);
  }
  return NS_OK;
}

nsresult nsMsgXFVirtualFolderDBView::UpdateCacheAndViewForPrevSearchedFolders(
    nsIMsgFolder* curSearchFolder) {
  // Handle the most recent folder with hits, if any.
  if (m_curFolderGettingHits) {
    uint32_t count = m_hdrHits.Count();
    nsTArray<nsMsgKey> newHits;
    newHits.SetLength(count);
    for (uint32_t i = 0; i < count; i++) {
      nsresult rv = m_hdrHits[i]->GetMessageKey(&newHits[i]);
      if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
        NS_ENSURE_SUCCESS(rv, rv);
      }
    }

    newHits.Sort();
    nsresult rv = UpdateCacheAndViewForFolder(m_curFolderGettingHits, newHits);
    NS_ENSURE_SUCCESS(rv, rv);
    m_foldersSearchingOver.RemoveObject(m_curFolderGettingHits);
  }

  while (m_foldersSearchingOver.Count() > 0) {
    // This new folder has cached hits.
    if (m_foldersSearchingOver[0] == curSearchFolder) {
      m_curFolderHasCachedHits = true;
      m_foldersSearchingOver.RemoveObjectAt(0);
      break;
    } else {
      // This must be a folder that had no hits with the current search.
      // So all cached hits, if any, need to be removed.
      nsTArray<nsMsgKey> noHits;
      nsresult rv =
          UpdateCacheAndViewForFolder(m_foldersSearchingOver[0], noHits);
      NS_ENSURE_SUCCESS(rv, rv);
      m_foldersSearchingOver.RemoveObjectAt(0);
    }
  }
  return NS_OK;
}
NS_IMETHODIMP
nsMsgXFVirtualFolderDBView::OnSearchHit(nsIMsgDBHdr* aMsgHdr,
                                        nsIMsgFolder* aFolder) {
  NS_ENSURE_ARG(aMsgHdr);
  NS_ENSURE_ARG(aFolder);
  NS_ENSURE_SUCCESS(m_cacheStatus, m_cacheStatus);

  if (m_curFolderGettingHits != aFolder && m_doingSearch &&
      !m_doingQuickSearch) {
    m_curFolderHasCachedHits = false;
    // Since we've gotten a hit for a new folder, the searches for
    // any previous folders are done, so deal with stale cached hits
    // for those folders now.
    m_cacheStatus = UpdateCacheAndViewForPrevSearchedFolders(aFolder);
    NS_ENSURE_SUCCESS(m_cacheStatus, m_cacheStatus);
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
    if (NS_SUCCEEDED(rv)) {
      nsCString searchUri;
      m_viewFolder->GetURI(searchUri);
      dbToUse->HdrIsInCache(searchUri, aMsgHdr, &hdrInCache);
    }
  }

  if (!m_doingSearch || !m_curFolderHasCachedHits || !hdrInCache) {
    if (m_viewFlags & nsMsgViewFlagsType::kGroupBySort)
      nsMsgGroupView::OnNewHeader(aMsgHdr, nsMsgKey_None, true);
    else if (m_sortValid)
      InsertHdrFromFolder(aMsgHdr, aFolder);
    else
      AddHdrFromFolder(aMsgHdr, aFolder);
  }

  m_hdrHits.AppendObject(aMsgHdr);
  m_totalMessagesInView++;

  return NS_OK;
}

NS_IMETHODIMP
nsMsgXFVirtualFolderDBView::OnSearchDone(nsresult status) {
  // This batch began in OnNewSearch.
  if (m_searchBatchOpen && mJSTree) mJSTree->EndUpdateBatch();
  m_searchBatchOpen = false;

  NS_ENSURE_TRUE(m_viewFolder, NS_ERROR_NOT_INITIALIZED);

  // Handle any non verified hits we haven't handled yet.
  if (NS_SUCCEEDED(status) && NS_SUCCEEDED(m_cacheStatus) &&
      !m_doingQuickSearch && status != NS_MSG_SEARCH_INTERRUPTED) {
    if (mJSTree) mJSTree->BeginUpdateBatch();
    m_cacheStatus = UpdateCacheAndViewForPrevSearchedFolders(nullptr);
    if (mJSTree) mJSTree->EndUpdateBatch();
  }

  m_doingSearch = false;
  if (NS_FAILED(m_cacheStatus)) {
    m_foldersSearchingOver.Clear();
    m_curFolderGettingHits = nullptr;
    return m_cacheStatus;
  }

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

  dbFolderInfo->SetNumUnreadMessages(numUnread);
  dbFolderInfo->SetNumMessages(m_totalMessagesInView);
  // Force update from db.
  m_viewFolder->UpdateSummaryTotals(true);
  virtDatabase->Commit(nsMsgDBCommitType::kLargeCommit);
  if (!m_sortValid && m_sortType != nsMsgViewSortType::byThread &&
      !(m_viewFlags & nsMsgViewFlagsType::kThreadedDisplay)) {
    // Sort the results.
    m_sortValid = false;
    Sort(m_sortType, m_sortOrder);
  }

  m_foldersSearchingOver.Clear();
  m_curFolderGettingHits = nullptr;
  return rv;
}

NS_IMETHODIMP
nsMsgXFVirtualFolderDBView::OnNewSearch() {
  if (m_searchBatchOpen && mJSTree) mJSTree->EndUpdateBatch();
  m_searchBatchOpen = false;
  int32_t oldSize = GetSize();

  RemovePendingDBListeners();
  m_doingSearch = true;
  m_cacheStatus = NS_OK;
  m_totalMessagesInView = 0;
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
  searchSession->CountSearchScopes(&scopeCount);

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

  const bool cacheBatch = !m_doingQuickSearch;
  if (cacheBatch) {
    if (mTree) mTree->BeginUpdateBatch();
    if (mJSTree) mJSTree->BeginUpdateBatch();
  }
  auto finishCacheBatch = mozilla::MakeScopeExit([&, cacheBatch] {
    if (cacheBatch) {
      if (mTree) mTree->EndUpdateBatch();
      if (mJSTree) mJSTree->EndUpdateBatch();
    }
  });

  for (int32_t i = 0; i < scopeCount; i++) {
    nsMsgSearchScopeValue scopeId;
    nsCOMPtr<nsIMsgFolder> searchFolder;
    nsresult scopeStatus = searchSession->GetNthSearchScope(
        i, &scopeId, getter_AddRefs(searchFolder));
    if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
      m_cacheStatus = scopeStatus;
      NS_ENSURE_SUCCESS(m_cacheStatus, m_cacheStatus);
    }
    if (searchFolder) {
      nsCOMPtr<nsIMsgDatabase> searchDB;
      nsCString searchUri;
      nsresult rv = m_viewFolder->GetURI(searchUri);
      if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
        m_cacheStatus = rv;
        NS_ENSURE_SUCCESS(m_cacheStatus, m_cacheStatus);
      }
      rv = searchFolder->GetMsgDatabase(getter_AddRefs(searchDB));
      if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
        m_cacheStatus = NS_FAILED(rv) ? rv
                        : searchDB    ? NS_OK
                                      : NS_ERROR_UNEXPECTED;
        NS_ENSURE_SUCCESS(m_cacheStatus, m_cacheStatus);
      }
      if (NS_SUCCEEDED(rv) && searchDB) {
        if (msgDBService)
          msgDBService->RegisterPendingListener(searchFolder, this);

        m_foldersSearchingOver.AppendObject(searchFolder);
        // Ignore cached hits in quick search case.
        if (m_doingQuickSearch) continue;

        if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
          nsCOMArray<nsIMsgDBHdr> cached;
          m_cacheStatus = ReadNativeCachedHits(searchDB, searchUri, cached);
          NS_ENSURE_SUCCESS(m_cacheStatus, m_cacheStatus);
          for (int32_t j = 0; j < cached.Count(); ++j) {
            nsCOMPtr<nsIMsgFolder> physicalFolder;
            m_cacheStatus =
                cached[j]->GetFolder(getter_AddRefs(physicalFolder));
            NS_ENSURE_SUCCESS(m_cacheStatus, m_cacheStatus);
            if (physicalFolder == searchFolder) {
              m_cacheStatus = AddHdrFromFolder(cached[j], searchFolder);
              NS_ENSURE_SUCCESS(m_cacheStatus, m_cacheStatus);
            }
          }
          continue;
        }

        nsCOMPtr<nsIMsgEnumerator> cachedHits;
        searchDB->GetCachedHits(searchUri, getter_AddRefs(cachedHits));
        bool hasMore;
        if (cachedHits) {
          cachedHits->HasMoreElements(&hasMore);
          if (hasMore) {
            mozilla::DebugOnly<nsMsgKey> prevKey = nsMsgKey_None;
            while (hasMore) {
              nsCOMPtr<nsIMsgDBHdr> header;
              nsresult rv = cachedHits->GetNext(getter_AddRefs(header));
              if (header && NS_SUCCEEDED(rv)) {
                nsMsgKey msgKey;
                header->GetMessageKey(&msgKey);
                NS_ASSERTION(prevKey == nsMsgKey_None || msgKey > prevKey,
                             "cached Hits not sorted");
#ifdef DEBUG
                prevKey = msgKey;
#endif
                AddHdrFromFolder(header, searchFolder);
              } else {
                break;
              }

              cachedHits->HasMoreElements(&hasMore);
            }
          }
        }
      }
    }
  }

  finishCacheBatch.release();
  if (cacheBatch) {
    if (mTree) mTree->EndUpdateBatch();
    if (mJSTree) mJSTree->EndUpdateBatch();
  }

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
  if (mJSTree) {
    mJSTree->BeginUpdateBatch();
    m_searchBatchOpen = true;
  }

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
