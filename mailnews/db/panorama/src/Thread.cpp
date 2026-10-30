/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "Thread.h"

#include <limits>
#include <utility>

#include "FolderDatabase.h"
#include "mozilla/Try.h"
#include "nsHashKeys.h"
#include "nsIMsgDatabase.h"
#include "nsIMsgFolder.h"
#include "nsMsgMessageFlags.h"
#include "nsTHashSet.h"
#include "prtime.h"

namespace mozilla::mailnews {

namespace {

// Preserve physical parents while exposing each root of this folder's forest.
nsresult IsScopedRoot(MessageDatabase& messages, const CapturedMessage& current,
                      bool& isRoot) {
  if (!current.threadParent || current.threadParent == nsMsgKey_None) {
    isRoot = true;
    return NS_OK;
  }
  bool exists;
  MOZ_TRY(messages.MessageExists(current.threadParent, exists));
  if (!exists) {
    isRoot = true;
    return NS_OK;
  }
  CapturedMessage parent;
  MOZ_TRY(messages.CaptureMessage(current.threadParent, parent));
  isRoot = parent.folderId != current.folderId ||
           parent.threadId != current.threadId;
  return NS_OK;
}

}  // namespace

NS_IMPL_ISUPPORTS(Thread, nsIMsgThread)

NS_IMETHODIMP Thread::GetThreadKey(nsMsgKey* threadKey) {
  NS_ENSURE_ARG_POINTER(threadKey);
  *threadKey = mThreadId;
  return NS_OK;
}
NS_IMETHODIMP Thread::SetThreadKey(nsMsgKey threadKey) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP Thread::GetFlags(uint32_t* aFlags) {
  NS_ENSURE_ARG_POINTER(aFlags);
  *aFlags = 0;
  return MessageDB().GetThreadFlags(mFolderId, mThreadId, *aFlags);
}
NS_IMETHODIMP Thread::SetFlags(uint32_t aFlags) {
  return MessageDB().SetThreadFlags(mFolderId, mThreadId, aFlags);
}
NS_IMETHODIMP Thread::GetNewestMsgDate(uint32_t* aNewestMsgDate) {
  NS_ENSURE_ARG_POINTER(aNewestMsgDate);
  uint64_t maxDate;
  MOZ_TRY(MessageDB().GetThreadMaxDate(mFolderId, mThreadId, &maxDate));
  mMaxDate = maxDate;
  *aNewestMsgDate = mMaxDate / PR_USEC_PER_SEC;
  return NS_OK;
}
NS_IMETHODIMP Thread::SetNewestMsgDate(uint32_t aNewestMsgDate) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP Thread::GetNumChildren(uint32_t* aNumChildren) {
  NS_ENSURE_ARG_POINTER(aNumChildren);
  *aNumChildren = 0;
  uint64_t count;
  nsresult rv = MessageDB().CountThreadKeys(mFolderId, mThreadId, &count);
  NS_ENSURE_SUCCESS(rv, rv);
  *aNumChildren = count;
  return NS_OK;
}
NS_IMETHODIMP Thread::GetNumUnreadChildren(uint32_t* aNumUnreadChildren) {
  NS_ENSURE_ARG_POINTER(aNumUnreadChildren);
  *aNumUnreadChildren = 0;
  nsTArray<nsMsgKey> keys;
  nsresult rv = GetKeys(keys);
  NS_ENSURE_SUCCESS(rv, rv);

  uint32_t unread = 0;
  for (nsMsgKey key : keys) {
    uint32_t flags;
    rv = MessageDB().GetMessageFlags(key, flags);
    NS_ENSURE_SUCCESS(rv, rv);
    if (!(flags & nsMsgMessageFlags::Read)) {
      ++unread;
    }
  }
  *aNumUnreadChildren = unread;
  return NS_OK;
}
NS_IMETHODIMP Thread::GetNumNewChildren(uint32_t* aNumNewChildren) {
  NS_ENSURE_ARG_POINTER(aNumNewChildren);
  *aNumNewChildren = 0;
  nsCOMPtr<nsIMsgFolder> folder;
  MOZ_TRY(DatabaseCore::sInstance->mFolderDatabase->GetMsgFolderForFolder(
      mFolderId, getter_AddRefs(folder)));
  NS_ENSURE_TRUE(folder, NS_ERROR_NOT_AVAILABLE);
  nsCOMPtr<nsIMsgDatabase> db;
  MOZ_TRY(folder->GetMsgDatabase(getter_AddRefs(db)));
  NS_ENSURE_TRUE(db, NS_ERROR_NOT_AVAILABLE);
  nsTArray<nsMsgKey> newKeys, keys;
  MOZ_TRY(db->GetNewList(newKeys));
  MOZ_TRY(GetKeys(keys));
  nsTHashSet<nsUint32HashKey> newSet;
  for (nsMsgKey key : newKeys) {
    newSet.Insert(key);
  }
  uint32_t count = 0;
  for (nsMsgKey key : keys) {
    if (newSet.Contains(key)) {
      ++count;
    }
  }
  *aNumNewChildren = count;
  return NS_OK;
}
NS_IMETHODIMP Thread::AddChild(nsIMsgDBHdr* child, nsIMsgDBHdr* inReplyTo,
                               bool threadInThread,
                               nsIDBChangeAnnouncer* announcer) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP Thread::GetChildKeyAt(uint32_t index, nsMsgKey* _retval) {
  NS_ENSURE_ARG_POINTER(_retval);
  *_retval = nsMsgKey_None;
  nsTArray<nsMsgKey> keys;
  nsresult rv = GetKeys(keys);
  NS_ENSURE_SUCCESS(rv, rv);
  if (index >= keys.Length()) {
    return NS_ERROR_UNEXPECTED;
  }
  *_retval = keys[index];
  return NS_OK;
}
NS_IMETHODIMP Thread::GetChild(nsMsgKey msgKey, nsIMsgDBHdr** result) {
  NS_ENSURE_ARG_POINTER(result);
  *result = nullptr;
  CapturedMessage current;
  MOZ_TRY(MessageDB().CaptureMessage(msgKey, current));
  NS_ENSURE_TRUE(current.folderId == mFolderId && current.threadId == mThreadId,
                 NS_ERROR_UNEXPECTED);
  RefPtr<Message> message;
  MOZ_TRY(MessageDB().GetMessage(msgKey, getter_AddRefs(message)));
  message.forget(result);
  return NS_OK;
}
NS_IMETHODIMP Thread::GetChildHdrAt(uint32_t index, nsIMsgDBHdr** result) {
  NS_ENSURE_ARG_POINTER(result);
  *result = nullptr;
  nsTArray<nsMsgKey> keys;
  MOZ_TRY(GetKeys(keys));
  NS_ENSURE_TRUE(index < keys.Length(), NS_ERROR_UNEXPECTED);
  return GetChild(keys[index], result);
}
NS_IMETHODIMP Thread::GetRootHdr(nsIMsgDBHdr** result) {
  NS_ENSURE_ARG_POINTER(result);
  *result = nullptr;
  nsTArray<nsMsgKey> keys;
  MOZ_TRY(GetKeys(keys));
  NS_ENSURE_TRUE(!keys.IsEmpty(), NS_ERROR_UNEXPECTED);
  // A deleted or foreign root may still identify current members in this
  // folder.
  return GetChild(keys.Contains(mThreadId) ? mThreadId : keys[0], result);
}
NS_IMETHODIMP Thread::RemoveChildAt(uint32_t index) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP Thread::RemoveChildHdr(nsIMsgDBHdr* child,
                                     nsIDBChangeAnnouncer* announcer) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP Thread::MarkChildNew(bool bNew) {
  // Counts are derived from current folder new-list membership.
  return NS_OK;
}
NS_IMETHODIMP Thread::MarkChildRead(bool bRead) {
  // Counts are derived from current stored flags; do not adjust them twice.
  return NS_OK;
}
NS_IMETHODIMP Thread::GetFirstUnreadChild(nsIMsgDBHdr** result) {
  NS_ENSURE_ARG_POINTER(result);
  *result = nullptr;
  nsTArray<nsMsgKey> keys;
  MOZ_TRY(GetKeys(keys));
  nsMsgKey best = nsMsgKey_None;
  size_t bestLevel = std::numeric_limits<size_t>::max();
  for (nsMsgKey key : keys) {
    CapturedMessage current;
    MOZ_TRY(MessageDB().CaptureMessage(key, current));
    NS_ENSURE_TRUE(
        current.folderId == mFolderId && current.threadId == mThreadId,
        NS_ERROR_UNEXPECTED);
    if (current.flags & nsMsgMessageFlags::Read) {
      continue;
    }
    nsTHashSet<nsUint32HashKey> ancestors;
    size_t level = 0;
    while (current.threadParent && current.threadParent != nsMsgKey_None) {
      NS_ENSURE_TRUE(!ancestors.Contains(current.id), NS_ERROR_FILE_CORRUPTED);
      ancestors.Insert(current.id);
      bool exists;
      MOZ_TRY(MessageDB().MessageExists(current.threadParent, exists));
      if (!exists) {
        break;
      }
      CapturedMessage parent;
      MOZ_TRY(MessageDB().CaptureMessage(current.threadParent, parent));
      if (parent.folderId != mFolderId || parent.threadId != mThreadId) {
        break;
      }
      current = std::move(parent);
      ++level;
    }
    if (level < bestLevel) {
      best = key;
      bestLevel = level;
    }
  }
  NS_ENSURE_TRUE(best != nsMsgKey_None, NS_ERROR_NULL_POINTER);
  return GetChild(best, result);
}
NS_IMETHODIMP Thread::EnumerateMessages(nsMsgKey parent,
                                        nsIMsgEnumerator** result) {
  NS_ENSURE_ARG_POINTER(result);
  *result = nullptr;
  nsCOMPtr<nsIMsgDBHdr> header;
  nsTArray<nsMsgKey> keys;
  if (parent == nsMsgKey_None) {
    nsTArray<nsMsgKey> members;
    MOZ_TRY(GetKeys(members));
    NS_ENSURE_TRUE(!members.IsEmpty(), NS_ERROR_UNEXPECTED);
    for (nsMsgKey key : members) {
      CapturedMessage current;
      MOZ_TRY(MessageDB().CaptureMessage(key, current));
      NS_ENSURE_TRUE(
          current.folderId == mFolderId && current.threadId == mThreadId,
          NS_ERROR_UNEXPECTED);
      bool isRoot;
      MOZ_TRY(IsScopedRoot(MessageDB(), current, isRoot));
      if (isRoot) {
        keys.AppendElement(key);
      }
    }
  } else {
    MOZ_TRY(GetChild(parent, getter_AddRefs(header)));
    MOZ_TRY(MessageDB().ListThreadChildKeys(mFolderId, parent, keys));
  }
  RefPtr<ThreadMessageEnumerator> enumerator =
      new ThreadMessageEnumerator(mFolderId, mThreadId, parent, keys);
  enumerator.forget(result);
  return NS_OK;
}

nsresult Thread::GetKeys(nsTArray<nsMsgKey>& keys) {
  return MessageDB().ListThreadKeys(mFolderId, 0, mThreadId, keys);
}

nsresult ThreadMessageEnumerator::Advance(bool* hasNext) {
  *hasNext = false;
  for (; mCurrent < mKeys.Length(); ++mCurrent) {
    const nsMsgKey key = mKeys[mCurrent];
    bool exists;
    MOZ_TRY(MessageDB().MessageExists(key, exists));
    if (!exists) {
      continue;
    }
    CapturedMessage current;
    MOZ_TRY(MessageDB().CaptureMessage(key, current));
    if (current.folderId != mFolderId || current.threadId != mThreadId) {
      continue;
    }
    if (mParent == nsMsgKey_None) {
      bool isRoot;
      MOZ_TRY(IsScopedRoot(MessageDB(), current, isRoot));
      if (!isRoot) {
        continue;
      }
    } else if (current.threadParent != mParent) {
      continue;
    }
    *hasNext = true;
    break;
  }
  return NS_OK;
}

NS_IMETHODIMP ThreadMessageEnumerator::GetNext(nsIMsgDBHdr** item) {
  NS_ENSURE_ARG_POINTER(item);
  *item = nullptr;
  bool more;
  MOZ_TRY(Advance(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_FAILURE);
  RefPtr<Message> message;
  MOZ_TRY(MessageDB().GetMessage(mKeys[mCurrent], getter_AddRefs(message)));
  ++mCurrent;
  message.forget(item);
  return NS_OK;
}

NS_IMETHODIMP ThreadMessageEnumerator::HasMoreElements(bool* hasNext) {
  NS_ENSURE_ARG_POINTER(hasNext);
  return Advance(hasNext);
}

}  // namespace mozilla::mailnews
