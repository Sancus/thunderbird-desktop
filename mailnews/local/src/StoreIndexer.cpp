/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "StoreIndexer.h"

#include "LineReader.h"
#include "mozilla/ScopeExit.h"
#include "nsIDBFolderInfo.h"
#include "nsLocalMailFolder.h"
#include "nsParseMailbox.h"
#ifdef MOZ_PANORAMA
#  include "PerFolderDatabase.h"
#  include "mozilla/StaticPrefs_mail.h"
#endif
#include <limits>

NS_IMPL_ISUPPORTS(StoreIndexer, nsIStoreScanListener)

// 32KB buffer is a bit arbitrary. Gut feeling is that it should be at least
// a few times larger than filesystem block size (often 4KB).
StoreIndexer::StoreIndexer()
    : mExpectedTotalCount(0),
      mCurrentCount(0),
      mCurrentMsgSize(0),
      mBuf(32768),
      mUsed(0),
      mUnused(0),
      mIsStupidlyLongLine(false) {}

StoreIndexer::~StoreIndexer() { ReleaseFolder(); }

nsresult StoreIndexer::GoIndex(nsMsgLocalMailFolder* folder,
                               std::function<void(int64_t, int64_t)> progressFn,
                               std::function<void(nsresult)> completionFn) {
  MOZ_ASSERT(!mFolder);  // already in use?

  mFirstError = NS_OK;
  mScanFinished = false;

  // Only set mFolder if we can successfully lock it!
  // NOTE: the folder semaphore is not a thread-safe mechanism!
  // The folder just sets a member var to track who is currently holding
  // it. It's thoroughly main-thread-only.
  nsresult rv = folder->AcquireSemaphore(this, "StoreIndexer::GoIndex"_ns);
  NS_ENSURE_SUCCESS(rv, rv);
  mFolder = folder;
  auto scopeGuard = mozilla::MakeScopeExit([&] { ReleaseFolder(); });

  mProgressFn = progressFn;
  mCompletionFn = completionFn;

  nsCOMPtr<nsIMsgDBService> msgDBService =
      do_GetService("@mozilla.org/msgDatabase/msgDBService;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  // Use OpenFolderDB to always open the db so that db's m_folder
  // is set correctly.
  rv = msgDBService->OpenFolderDB(mFolder, true, getter_AddRefs(mDB));
#ifdef MOZ_PANORAMA
  const bool native = mozilla::StaticPrefs::mail_panorama_enabled_AtStartup();
  // An invalid native summary retains its existing physical rows for repair.
  if (native && mDB && rv == NS_MSG_ERROR_FOLDER_SUMMARY_OUT_OF_DATE) {
    rv = NS_OK;
  }
#endif
  if (rv == NS_MSG_ERROR_FOLDER_SUMMARY_MISSING) {
    rv = msgDBService->CreateNewDB(mFolder, getter_AddRefs(mDB));
  }
  NS_ENSURE_SUCCESS(rv, rv);
  // Try to get a backup message database.
  // NOTE: this doesn't actually create a backup db. That's handled further up
  // the chain, by nsMsgLocalMailFolder::GetDatabaseWithReparse(). Really, we
  // should be handling DB backup/rollback in this code.
  // If GetBackupMsgDatabase() fails, there's nothing we can do about it,
  // and we still need to index the store. After all, there may not even
  // _be_ a primary database, let alone a backup. It's this indexing process
  // which is used to recreate missing DBs!
#ifdef MOZ_PANORAMA
  if (native) {
    mNativeDB = static_cast<mozilla::mailnews::PerFolderDatabase*>(mDB.get());
    rv = mNativeDB->BeginFolderRepair(getter_AddRefs(mFolderRepair));
    if (NS_FAILED(rv)) {
      return RememberError(rv);
    }
  } else
#endif
  {
    mFolder->GetBackupMsgDatabase(getter_AddRefs(mBackupDB));
  }

  nsCOMPtr<nsIMsgPluggableStore> msgStore;
  rv = mFolder->GetMsgStore(getter_AddRefs(msgStore));
  NS_ENSURE_SUCCESS(rv, RememberError(rv));

  // Set up for progress updates.
  mCurrentCount = 0;
  rv = msgStore->EstimateFolderSize(mFolder, &mExpectedTotalCount);
  NS_ENSURE_SUCCESS(rv, RememberError(rv));

  // Start iterating over all the messages.
  // AsyncScan() holds a refcounted ptr to the listener until the scan
  // completes, so we don't need our own kungfudeathgrip or anything.
  rv = msgStore->AsyncScan(mFolder, this);
  NS_ENSURE_SUCCESS(rv, RememberError(rv));

#ifdef MOZ_PANORAMA
  if (!native)
#endif
  {
    // Reset forceReparse in the DB.
    nsCOMPtr<nsIDBFolderInfo> folderInfo;
    mDB->GetDBFolderInfo(getter_AddRefs(folderInfo));
    if (folderInfo) {
      folderInfo->SetBooleanProperty("forceReparse", false);
    }
  }

  scopeGuard.release();
  return NS_OK;
}

nsresult StoreIndexer::RememberError(nsresult status) {
  if (NS_FAILED(status) && NS_SUCCEEDED(mFirstError)) {
    mFirstError = status;
  }
  return mFirstError;
}

void StoreIndexer::ReleaseFolder() {
#ifdef MOZ_PANORAMA
  if (mFolderRepair) {
    // No body cleanup: a failed or interrupted scan retains all source bytes.
    mNativeDB->AbortFolderRepair(
        mFolderRepair, NS_FAILED(mFirstError) ? mFirstError : NS_ERROR_ABORT);
    mFolderRepair = nullptr;
  }
  mNativeDB = nullptr;
#endif
  // mFolder is only set if we took a lock on it.
  if (mFolder) {
    mFolder->ReleaseSemaphore(this, "StoreIndexer::ReleaseFolder"_ns);
    mFolder = nullptr;
  }
  // Release
  mDB = nullptr;
  mBackupDB = nullptr;
}

// nsIStoreScanListener.onStartScan()
// Called at beginning of msgStore scan.
NS_IMETHODIMP StoreIndexer::OnStartScan() { return mFirstError; }

// nsIStoreScanListener.onStartMessage()
// Called when a new message is about to start.
NS_IMETHODIMP StoreIndexer::OnStartMessage(nsACString const& token,
                                           nsACString const& envAddr,
                                           PRTime envDate) {
  NS_ENSURE_SUCCESS(mFirstError, mFirstError);
  MOZ_ASSERT(!mParser);  // Can't be mid-message!

  mStoreToken = token;

  // Start a new header parser for this message...
  mParser = new nsParseMailMessageState();
  nsresult rv = mParser->SetMailDB(mDB);
  NS_ENSURE_SUCCESS(rv, RememberError(rv));
  rv = mParser->SetBackupMailDB(mBackupDB);
  NS_ENSURE_SUCCESS(rv, RememberError(rv));

  mParser->SetEnvDetails(envAddr, envDate);

  mIsStupidlyLongLine = false;
  mCurrentMsgSize = 0;
  // Clear the buffer.
  mUsed = 0;
  mUnused = 0;
  return NS_OK;
}

// nsIStoreScanListener.onStartRequest()
// Called after OnStartMessage(), but before the first OnDataAvailable().
NS_IMETHODIMP StoreIndexer::OnStartRequest(nsIRequest* req) {
  NS_ENSURE_SUCCESS(mFirstError, mFirstError);
  MOZ_ASSERT(!mStoreToken.IsEmpty());
  MOZ_ASSERT(mParser);
  // Nothing to do - OnStartMessage() has already set us up.
  return NS_OK;
}

// nsIStoreScanListener.onDataAvailable()
NS_IMETHODIMP StoreIndexer::OnDataAvailable(nsIRequest* req,
                                            nsIInputStream* stream,
                                            uint64_t offset, uint32_t count) {
  NS_ENSURE_SUCCESS(mFirstError, mFirstError);
  while (count > 0) {
    // Read in a chunk.
    uint32_t got;
    size_t freeSpace = mBuf.Length() - (mUsed + mUnused);
    nsresult rv = stream->Read(mBuf.Elements() + mUsed + mUnused,
                               std::min((uint32_t)freeSpace, count), &got);
    NS_ENSURE_SUCCESS(rv, RememberError(rv));
    NS_ENSURE_TRUE(got, RememberError(NS_BASE_STREAM_CLOSED));
    mUnused += got;
    count -= got;

    while (true) {
      auto data = mBuf.AsSpan().Subspan(mUsed, mUnused);
      auto line = FirstLine(data);
      // Empty line means no EOL was found.
      bool incompleteLine = line.IsEmpty();
      if (incompleteLine) {
        if (data.Length() >= STUPIDLY_LONG_LINE_THRESHOLD) {
          // Uhoh... a stupidly long line with no EOL in sight.
          // We'll discard everything up to the end of the line (whenever
          // that shows up!). The discarded data will _not_ be fed to the
          // header parser, because we'd have to buffer up the whole lot,
          // and we _really_ don't want to do that as the pathological case
          // could involve gigabytes!
          mIsStupidlyLongLine = true;
          // Soak up the whole lot for discarding.
          line = data.First(data.Length());
        } else {
          break;  // It's OK. Just wait for the rest of the line to arrive.
        }
      }

      if (!mIsStupidlyLongLine) {
        MOZ_ASSERT(!incompleteLine);
        rv = mParser->ParseAFolderLine(line.Elements(), line.Length());
        NS_ENSURE_SUCCESS(rv, RememberError(rv));
      } else if (!incompleteLine) {
        // Soaked up entire stupidly-long-line, stop discarding data.
        mIsStupidlyLongLine = false;
      }
      mCurrentMsgSize += line.Length();
      mUsed += line.Length();
      mUnused -= line.Length();
    }

    // Shift the unused portion (if any) to the front of the buffer.
    if (mUsed > 0) {
      auto unused = mBuf.AsSpan().Subspan(mUsed, mUnused);
      std::copy(unused.cbegin(), unused.cend(), mBuf.begin());
      mUsed = 0;
    }
  }
  return NS_OK;
}

// nsIStoreScanListener.onStopRequest()
// Called at end of each message.
NS_IMETHODIMP StoreIndexer::OnStopRequest(nsIRequest* req, nsresult status) {
  auto clearMessage = mozilla::MakeScopeExit([&] {
    mStoreToken.Truncate();
    mCurrentMsgSize = 0;
    if (mParser) {
      mParser->SetNewMsgHdr(nullptr);
      mParser = nullptr;
    }
  });
  NS_ENSURE_SUCCESS(RememberError(status), mFirstError);
  NS_ENSURE_TRUE(mParser, RememberError(NS_ERROR_UNEXPECTED));

  // An unfinished final line is still part of the retrievable message size.
  mCurrentMsgSize += mUnused;
  mCurrentCount += (int64_t)mCurrentMsgSize;
  if (mProgressFn) {
    mProgressFn(mCurrentCount, mExpectedTotalCount);
  }

  nsCOMPtr<nsIMsgDBHdr> hdr;
  nsresult rv = mParser->GetNewMsgHdr(getter_AddRefs(hdr));
  NS_ENSURE_SUCCESS(rv, RememberError(rv));
#ifdef MOZ_PANORAMA
  // A scanned body which never completed its headers cannot silently disappear
  // from a successful native rebuild. Expunged headers are handled below.
  if (mFolderRepair) {
    NS_ENSURE_TRUE(hdr, RememberError(NS_ERROR_ILLEGAL_VALUE));
  }
#endif
  if (hdr) {
    uint32_t flags;
    rv = hdr->GetFlags(&flags);
    NS_ENSURE_SUCCESS(rv, RememberError(rv));
    if (flags & nsMsgMessageFlags::Expunged) {
      hdr = nullptr;
    }
  }

  if (hdr) {
    NS_ENSURE_TRUE(mCurrentMsgSize <= std::numeric_limits<uint32_t>::max(),
                   RememberError(NS_ERROR_FILE_TOO_BIG));
    rv = hdr->SetMessageSize(mCurrentMsgSize);
    NS_ENSURE_SUCCESS(rv, RememberError(rv));
    rv = hdr->SetLineCount(mParser->m_body_lines);
    NS_ENSURE_SUCCESS(rv, RememberError(rv));
    MOZ_ASSERT(!mStoreToken.IsEmpty());
    rv = hdr->SetStoreToken(mStoreToken);
    NS_ENSURE_SUCCESS(rv, RememberError(rv));

#ifdef MOZ_PANORAMA
    if (mFolderRepair) {
      // Retain a sealed parsed draft; the complete successful scan owns the
      // only native settlement. Existing rows are never AttachHdr inserts.
      return RememberError(mNativeDB->AddFolderRepairMessage(
          mFolderRepair, hdr, mStoreToken, mCurrentMsgSize));
    }
#endif
    nsCOMPtr<nsIMsgDBHdr> liveHdr;
    rv = mParser->m_mailDB->AttachHdr(hdr, false, getter_AddRefs(liveHdr));
    NS_ENSURE_SUCCESS(rv, RememberError(rv));
  } else {
#ifdef MOZ_PANORAMA
    if (mFolderRepair) {
      return NS_OK;
    }
#endif
    nsCOMPtr<nsIDBFolderInfo> folderInfo;
    rv = mParser->m_mailDB->GetDBFolderInfo(getter_AddRefs(folderInfo));
    if (NS_SUCCEEDED(rv) && folderInfo) {
      folderInfo->ChangeExpungedBytes(mCurrentMsgSize);
    }
  }
  return NS_OK;
}

// nsIStoreScanListener.onStopScan()
// Called when the scan completes.
NS_IMETHODIMP StoreIndexer::OnStopScan(nsresult status) {
  if (mScanFinished) {
    return NS_OK;
  }
  mScanFinished = true;
  RememberError(status);
  if (mParser) {
    RememberError(NS_ERROR_UNEXPECTED);
    mParser->SetNewMsgHdr(nullptr);
    mParser = nullptr;
  }
#ifdef MOZ_PANORAMA
  if (mFolderRepair) {
    if (NS_SUCCEEDED(mFirstError)) {
      nsTArray<RefPtr<mozilla::mailnews::Message>> repaired;
      RememberError(mNativeDB->CommitFolderRepair(mFolderRepair, mFirstError,
                                                  true, repaired));
    }
    if (NS_FAILED(mFirstError)) {
      RememberError(mNativeDB->AbortFolderRepair(mFolderRepair, mFirstError));
    }
    mFolderRepair = nullptr;
  } else
#endif
      if (NS_SUCCEEDED(mFirstError)) {
    RememberError(mDB->SetSummaryValid(true));
  }
  status = mFirstError;
  ReleaseFolder();

  if (NS_SUCCEEDED(status) && mProgressFn) {
    // Provider estimates include mbox framing, unlike the parsed byte total.
    mProgressFn(mExpectedTotalCount, mExpectedTotalCount);
  }
  auto completionFn = std::move(mCompletionFn);
  if (completionFn) {
    completionFn(status);
  }
  return NS_OK;
}
