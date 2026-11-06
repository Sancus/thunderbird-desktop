/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "msgCore.h"
#include "nsIFile.h"
#include "nsNetUtil.h"
#include "nsMsgUtils.h"
#include "nsMsgLocalFolderHdrs.h"  // For X_MOZILLA_KEYWORDS_BLANK_LEN.
#include "nsMsgMessageFlags.h"
#include "nsMailHeaders.h"
#include "nsPrintfCString.h"
#include "HeaderReader.h"
#include "MboxCompactor.h"
#include "FolderCompactor.h"
#include "MboxMsgOutputStream.h"
#include "MboxScanner.h"
#include "mozilla/glean/CommMailMetrics.h"
#include "mozilla/Buffer.h"
#include "mozilla/Logging.h"
#include "mozilla/ScopeExit.h"

extern mozilla::LazyLogModule
    gCompactLog;  // "compact" (Defined in FolderCompactor).
using mozilla::LogLevel;

NS_IMPL_ISUPPORTS(MboxCompactor, nsIStoreScanListener);

nsresult MboxCompactor::BeginCompaction(nsIFile* srcMbox,
                                        nsIStoreCompactListener* listener,
                                        bool patchXMozillaHeaders) {
#ifdef MOZ_PANORAMA
  NS_ENSURE_FALSE(mMigrationWork && !mMigrationWork->IsTerminal(),
                  NS_ERROR_IN_PROGRESS);
  MOZ_TRY(mozilla::mailnews::LocalStoreMigrationWork::Begin(
      static_cast<nsIStoreScanListener*>(this), srcMbox, mMigrationWork));
  nsresult migrationResult = [&]() -> nsresult {
#endif
    MOZ_ASSERT(!mCompactListener);  // Already running?
    mCompactListener = listener;
    mPatchXMozillaHeaders = patchXMozillaHeaders;
    nsresult rv = SetupPaths(srcMbox);
    NS_ENSURE_SUCCESS(rv, rv);
    rv = SanityCheck(srcMbox);
    NS_ENSURE_SUCCESS(rv, rv);

    MOZ_LOG(gCompactLog, LogLevel::Info,
            ("MboxCompactor - Compacting '%s' into '%s'.",
             mPaths.Source->HumanReadablePath().get(),
             mPaths.Compacting->HumanReadablePath().get()));

    // Create output stream for our dest mbox.
    rv = NS_NewLocalFileOutputStream(
        getter_AddRefs(mDestStream), mPaths.Compacting,
        PR_WRONLY | PR_CREATE_FILE | PR_EXCL, 0600);
    NS_ENSURE_SUCCESS(rv, rv);

    // Start iterating over the src mbox.
    // The scanner will hold a reference to us until it's completed, so
    // no kungfudeathgrippery required here (and MboxScanner holds itself
    // in existence until finished).
    RefPtr<MboxScanner> scanner(new MboxScanner());
    rv = scanner->BeginScan(mPaths.Source, this);
    if (NS_FAILED(rv)) {
#ifdef MOZ_PANORAMA
      mMigrationWork->RecordError(rv);
#endif
      nsresult cleanupRv = mDestStream->Close();
#ifdef MOZ_PANORAMA
      mMigrationWork->RecordError(cleanupRv);
      mMigrationCloseSafe = NS_SUCCEEDED(cleanupRv);
#endif
      if (NS_FAILED(cleanupRv)) {
        NS_WARNING("Could not close unused compaction output");
      }
      mDestStream = nullptr;
      cleanupRv = mPaths.Compacting->Remove(false);
#ifdef MOZ_PANORAMA
      mMigrationWork->RecordError(cleanupRv);
#endif
      if (NS_FAILED(cleanupRv)) {
        NS_WARNING("Could not remove unused compaction output");
      }
      return rv;
    }

    return NS_OK;

#ifdef MOZ_PANORAMA
  }();
  if (NS_FAILED(migrationResult)) {
    mMigrationWork->Complete(migrationResult,
                             mMigrationCloseSafe && !mDestStream);
  }
  return migrationResult;
#endif
}

// Make sure the given mbox file exists and looks readable and writeable.
// Not a 100% guarantee that we'll be able to replace it, but it's an
// early-out for obvious issues.
nsresult MboxCompactor::SanityCheck(nsIFile* srcMbox) {
  bool exists;
  nsresult rv = srcMbox->Exists(&exists);
  NS_ENSURE_SUCCESS(rv, rv);
  if (!exists) {
    // Cheesy hack - create empty mbox file if it doesn't exist.
    // This can happen in a few circumstances - e.g. IMAP folders without
    // offline storage obviously have no messages in their local mbox file.
    // It's valid having an empty mbox file, and cleaner to let the normal
    // flow of code invoke the listener begin/complete callbacks rather than
    // returning early and invoking them explicitly here.
    rv = srcMbox->Create(nsIFile::NORMAL_FILE_TYPE, 0600);
    NS_ENSURE_SUCCESS(rv, rv);
  }

  // Sanity check:
  // Bail out immediately if mbox not readable, writeable or if not a file!
  {
    bool isFile;
    rv = srcMbox->IsFile(&isFile);
    NS_ENSURE_SUCCESS(rv, rv);
    bool isReadable;
    rv = srcMbox->IsReadable(&isReadable);
    NS_ENSURE_SUCCESS(rv, rv);
    bool isWriteable;
    rv = srcMbox->IsWritable(&isWriteable);
    NS_ENSURE_SUCCESS(rv, rv);

    if (!(isFile && isReadable && isWriteable)) {
      MOZ_LOG(gCompactLog, LogLevel::Error,
              ("MboxCompactor - Can't proceed on '%s': isFile=%s isReadable=%s "
               "isWriteable=%s.",
               srcMbox->HumanReadablePath().get(), isFile ? "true" : "FALSE",
               isReadable ? "true" : "FALSE", isWriteable ? "true" : "FALSE"));
      return NS_ERROR_FILE_ACCESS_DENIED;
    }
  }

  return NS_OK;
}

nsresult MboxCompactor::SetupPaths(nsIFile* srcMbox) {
  // Clone to avoid any caching issues on .fileSize etc (Bug 1022704).
  nsresult rv = srcMbox->Clone(getter_AddRefs(mPaths.Source));
  NS_ENSURE_SUCCESS(rv, rv);

  // Set up temp dir.
  rv = GetOrCreateCompactionDir(mPaths.Source, getter_AddRefs(mPaths.TempDir));
  NS_ENSURE_SUCCESS(rv, rv);

  rv = mPaths.Source->GetParent(getter_AddRefs(mPaths.SourceDir));
  NS_ENSURE_SUCCESS(rv, rv);

  rv = mPaths.Source->GetLeafName(mPaths.SourceName);
  NS_ENSURE_SUCCESS(rv, rv);

  // The new mbox, in temp dir, while it's being built.
  mPaths.CompactingName = mPaths.SourceName + u".compacting"_ns;
  rv = mPaths.TempDir->Clone(getter_AddRefs(mPaths.Compacting));
  NS_ENSURE_SUCCESS(rv, rv);
  rv = mPaths.Compacting->Append(mPaths.CompactingName);
  NS_ENSURE_SUCCESS(rv, rv);

  // The new mbox, in temp dir, when it's been built.
  mPaths.CompactedName = mPaths.SourceName + u".compacted"_ns;
  rv = mPaths.TempDir->Clone(getter_AddRefs(mPaths.Compacted));
  NS_ENSURE_SUCCESS(rv, rv);
  rv = mPaths.Compacted->Append(mPaths.CompactedName);
  NS_ENSURE_SUCCESS(rv, rv);

  // The original mbox, moved into temp dir after new mbox has been built.
  // Could be used for recovery, if we die during OnCompactionComplete()
  // callback.
  mPaths.BackupName = mPaths.SourceName + u".original"_ns;
  rv = mPaths.TempDir->Clone(getter_AddRefs(mPaths.Backup));
  NS_ENSURE_SUCCESS(rv, rv);
  rv = mPaths.Backup->Append(mPaths.BackupName);
  NS_ENSURE_SUCCESS(rv, rv);

  // An interrupted compaction may have left the only recoverable body here.
  // Leave these files intact until recovery has determined which one to keep.
  nsIFile* recoveryFiles[] = {mPaths.Compacting.get(), mPaths.Compacted.get(),
                              mPaths.Backup.get()};
  for (nsIFile* file : recoveryFiles) {
    bool exists;
    rv = file->Exists(&exists);
    NS_ENSURE_SUCCESS(rv, rv);
    if (exists) {
      return NS_ERROR_FILE_ALREADY_EXISTS;
    }
  }
  return NS_OK;
}

// nsIStoreScanListener callback called when the scan starts.
NS_IMETHODIMP MboxCompactor::OnStartScan() {
#ifdef MOZ_PANORAMA
  if (mMigrationWork) MOZ_TRY(mMigrationWork->Validate());
#endif

  return mCompactListener->OnCompactionBegin();
}

// nsIStoreScanListener callback called at the start of each message.
NS_IMETHODIMP MboxCompactor::OnStartMessage(nsACString const& storeToken,
                                            nsACString const& envAddr,
                                            PRTime envDate) {
#ifdef MOZ_PANORAMA
  if (mMigrationWork) MOZ_TRY(mMigrationWork->Validate());
#endif

  MOZ_ASSERT(mCurToken.IsEmpty());  // We should _not_ be processing a msg yet!

  // Ask compactListener if we should keep this message.
  bool keepMsg;
  nsresult rv = mCompactListener->OnRetentionQuery(storeToken, &mMsgFlags,
                                                   mMsgKeywords, &keepMsg);
  if (NS_FAILED(rv)) {
    return rv;  // Abort the scan.
  }

  // Some flags are really folder state, not message state.
  // We don't want to write them into the message.
  mMsgFlags &= ~nsMsgMessageFlags::RuntimeOnly;

  mCurToken = storeToken;
  mNewMsgSize = 0;
  mBufferCount = 0;
  if (keepMsg) {
    // Open mMsgOut to write a single message.
    MOZ_ASSERT(mDestStream);
    MOZ_ASSERT(!mMsgOut);
    mMsgOut = new MboxMsgOutputStream(mDestStream, false);
    // Preserve metadata on the "From " line.
    mMsgOut->SetEnvelopeDetails(envAddr, envDate);
  }

  return NS_OK;
}

// nsIStoreScanListener callback, called after OnStartMessage().
NS_IMETHODIMP MboxCompactor::OnStartRequest(nsIRequest* req) {
  // We've already set up everything in OnStartMessage().
  return NS_OK;
}

// Helper to drain count number of bytes from stream.
static nsresult readAndDiscard(nsIInputStream* stream, uint32_t count) {
  char buf[FILE_IO_BUFFER_SIZE];
  while (count > 0) {
    uint32_t ask = std::min((uint32_t)FILE_IO_BUFFER_SIZE, count);
    uint32_t got;
    nsresult rv = stream->Read(buf, ask, &got);
    NS_ENSURE_SUCCESS(rv, rv);
    count -= got;
  }
  return NS_OK;
}

// Helper to write data to an outputstream, until complete or error.
static nsresult writeSpan(nsIOutputStream* writeable,
                          mozilla::Span<const char> data) {
  while (!data.IsEmpty()) {
    uint32_t n;
    nsresult rv = writeable->Write(data.Elements(), data.Length(), &n);
    NS_ENSURE_SUCCESS(rv, rv);
    data = data.Last(data.Length() - n);
  }
  return NS_OK;
}

// nsIStoreScanListener callback to deliver a chunk of the current message.
NS_IMETHODIMP MboxCompactor::OnDataAvailable(nsIRequest* req,
                                             nsIInputStream* stream,
                                             uint64_t offset, uint32_t count) {
#ifdef MOZ_PANORAMA
  if (mMigrationWork) MOZ_TRY(mMigrationWork->Validate());
#endif

  if (!mMsgOut) {
    // We're discarding this message.
    return readAndDiscard(stream, count);
  }

  // While there is still data available...
  while (count > 0) {
    uint32_t maxReadCount =
        std::min((uint32_t)(mBuffer.Length() - mBufferCount), count);
    uint32_t readCount;
    nsresult rv = stream->Read(mBuffer.Elements() + mBufferCount, maxReadCount,
                               &readCount);
    NS_ENSURE_SUCCESS(rv, rv);

    count -= readCount;
    mBufferCount += readCount;
    if (mBufferCount == mBuffer.Length()) {
      // Buffer is full.
      rv = FlushBuffer();
      NS_ENSURE_SUCCESS(rv, rv);
      MOZ_ASSERT(mBufferCount == 0);  // Buffer is now empty.
    }
  }
  return NS_OK;
}

// nsIStoreScanListener callback called at end of each message.
NS_IMETHODIMP MboxCompactor::OnStopRequest(nsIRequest* req, nsresult status) {
#ifdef MOZ_PANORAMA
  if (mMigrationWork) MOZ_TRY(mMigrationWork->Validate());
#endif

  MOZ_LOG(gCompactLog, NS_SUCCEEDED(status) ? LogLevel::Debug : LogLevel::Error,
          ("MboxCompactor - OnStopRequest(status=0x%x)", (uint32_t)status));

  auto cleanup = mozilla::MakeScopeExit([&] {
    if (mMsgOut) {
      mMsgOut->Close();
      mMsgOut = nullptr;
    }
    mCurToken.Truncate();
    mMsgFlags = 0;
    mMsgKeywords.Truncate();
  });

  if (mMsgOut && NS_SUCCEEDED(status)) {
    // Write out any leftover data.
    nsresult rv = FlushBuffer();
    NS_ENSURE_SUCCESS(rv, rv);

    int64_t msgStart = mMsgOut->StartPos();
    rv = mMsgOut->Finish();  // Commit the message.
    NS_ENSURE_SUCCESS(rv, rv);

    MOZ_ASSERT(msgStart >= 0);
    // Tell the listener about the message and its new storeToken.
    nsCString newToken = nsPrintfCString("%" PRId64, msgStart);
    rv = mCompactListener->OnMessageRetained(mCurToken, newToken, mNewMsgSize);
    NS_ENSURE_SUCCESS(rv, rv);
  }

  return NS_OK;
}

// nsIStoreScanListener callback called when the scan completes.
NS_IMETHODIMP MboxCompactor::OnStopScan(nsresult status) {
#ifdef MOZ_PANORAMA
  if (mMigrationWork) {
    MOZ_TRY(mMigrationWork->Validate());
    mMigrationWork->RecordError(status);
  }
#endif

  nsresult rv = mDestStream->Close();
#ifdef MOZ_PANORAMA
  if (mMigrationWork) mMigrationWork->RecordError(rv);
  mMigrationCloseSafe = NS_SUCCEEDED(rv);
#endif
  mDestStream = nullptr;

  MOZ_LOG(gCompactLog, NS_SUCCEEDED(status) ? LogLevel::Debug : LogLevel::Error,
          ("MboxCompactor - OnStopScan(status=0x%x)", (uint32_t)status));

  if (NS_FAILED(status)) {
    rv = status;
  }

  if (NS_SUCCEEDED(rv)) {
    // Rename the completed mbox file.
    // ".../foo/bar/.temp-compact/folder.compacting" ->
    // ".../foo/bar/.temp-compact/folder.compacted"
    rv = mPaths.Compacting->RenameTo(mPaths.TempDir, mPaths.CompactedName);
#ifdef MOZ_PANORAMA
    if (mMigrationWork) mMigrationWork->RecordError(rv);
#endif
    MOZ_LOG(gCompactLog, NS_SUCCEEDED(rv) ? LogLevel::Debug : LogLevel::Error,
            ("MboxCompactor - Compacted OK. Rename '%s' -> '%s' (rv=0x%x)",
             mPaths.Compacting->HumanReadablePath().get(),
             mPaths.Compacted->HumanReadablePath().get(), (uint32_t)rv));
  }

  // Get before/after sizes.
  int64_t originalSize = 0;
  int64_t compactedSize = 0;
  if (NS_SUCCEEDED(rv)) {
    rv = mPaths.Source->GetFileSize(&originalSize);
#ifdef MOZ_PANORAMA
    if (mMigrationWork) mMigrationWork->RecordError(rv);
#endif
  }
  if (NS_SUCCEEDED(rv)) {
    rv = mPaths.Compacted->GetFileSize(&compactedSize);
#ifdef MOZ_PANORAMA
    if (mMigrationWork) mMigrationWork->RecordError(rv);
#endif
  }

  nsCOMPtr<nsIMboxCompactionCommit> commit =
      do_QueryInterface(mCompactListener);
  if (commit && !commit->RequiresBodyRelocation()) commit = nullptr;
  bool keepRecoveryFiles = false;
  bool relocationPrepared = false;
  if (NS_SUCCEEDED(rv) && commit) {
    // A failed preparation may have persisted an intent. Keep the completed
    // body even when the result is uncertain; never infer a rollback from SQL.
    keepRecoveryFiles = true;
    rv = commit->PrepareBodyRelocation(mPaths.Source, mPaths.Compacted,
                                       mPaths.Backup);
#ifdef MOZ_PANORAMA
    if (mMigrationWork) mMigrationWork->RecordError(rv);
#endif
    relocationPrepared = NS_SUCCEEDED(rv);
  }

  bool movedOriginal = false;
  if (NS_SUCCEEDED(rv)) {
    MOZ_LOG(gCompactLog, LogLevel::Debug,
            ("MboxCompactor - Beginning switchover. PR_Now()=%" PRIu64 "\n",
             PR_Now()));
    // Move original mbox out into temp dir, so that if we never come back from
    // OnCompactionComplete() (e.g. power cut), something can see that we died
    // mid-compaction and recover.
    rv = mPaths.Source->RenameTo(mPaths.TempDir, mPaths.BackupName);
#ifdef MOZ_PANORAMA
    if (mMigrationWork) mMigrationWork->RecordError(rv);
#endif
    MOZ_LOG(gCompactLog, NS_SUCCEEDED(rv) ? LogLevel::Debug : LogLevel::Error,
            ("MboxCompactor - Move original '%s' -> '%s' (rv=0x%x)",
             mPaths.Source->HumanReadablePath().get(),
             mPaths.Backup->HumanReadablePath().get(), (uint32_t)rv));
    if (NS_SUCCEEDED(rv)) {
      movedOriginal = true;
    } else if (relocationPrepared) {
      // RenameTo does not fall back to copy/delete on failure. The original is
      // untouched; core rechecks the complete intent before acknowledging it.
      nsresult abandonRv = commit->AbandonBodyRelocation();
#ifdef MOZ_PANORAMA
      if (mMigrationWork) mMigrationWork->RecordError(abandonRv);
#endif
      if (NS_SUCCEEDED(abandonRv)) keepRecoveryFiles = false;
      MOZ_LOG(gCompactLog,
              NS_SUCCEEDED(abandonRv) ? LogLevel::Debug : LogLevel::Error,
              ("MboxCompactor - Abandon relocation (rv=0x%x)",
               (uint32_t)abandonRv));
      // Preserve the rename error even if acknowledgement failed. Recovery
      // bytes must remain until that uncertain intent is resolved.
    }
  }

  // Tell the listener if compaction completed OK or not.
  // This is the final chance for the listener to abort the whole operation
  // by returning a failure code.
  // (FolderCompactor uses this callback to apply its changes to the database).
  nsresult rv2 = mCompactListener->OnCompactionComplete(rv);
#ifdef MOZ_PANORAMA
  if (mMigrationWork) mMigrationWork->RecordError(rv2);
#endif
  if (NS_SUCCEEDED(rv) && NS_FAILED(rv2)) {
    // Listener requested rollback.
    rv = rv2;
  }

  if (NS_SUCCEEDED(rv)) {
    // We've got the all-clear, so install the compacted mbox file (this is
    // as atomic as we've got).
    rv = mPaths.Compacted->RenameTo(mPaths.SourceDir, mPaths.SourceName);
#ifdef MOZ_PANORAMA
    if (mMigrationWork) mMigrationWork->RecordError(rv);
#endif
    MOZ_LOG(gCompactLog, NS_SUCCEEDED(rv) ? LogLevel::Debug : LogLevel::Error,
            ("MboxCompactor - Install new mbox. Rename '%s' -> '%s' (rv=0x%x), "
             "PR_Now()=%" PRIu64 "",
             mPaths.Compacted->HumanReadablePath().get(),
             mPaths.Source->HumanReadablePath().get(), (uint32_t)rv, PR_Now()));

    if (NS_SUCCEEDED(rv) && commit) {
      // A metadata failure leaves the installed body and original backup for
      // recovery, with the native intent/read gate still pending as needed.
      rv = commit->CompleteBodyRelocation();
#ifdef MOZ_PANORAMA
      if (mMigrationWork) mMigrationWork->RecordError(rv);
#endif
    }
    if (NS_SUCCEEDED(rv)) {
      nsresult rvTemp = mPaths.Backup->Remove(false);
#ifdef MOZ_PANORAMA
      if (mMigrationWork) mMigrationWork->RecordError(rvTemp);
#endif
      MOZ_LOG(gCompactLog,
              NS_SUCCEEDED(rvTemp) ? LogLevel::Debug : LogLevel::Error,
              ("MboxCompactor - Delete '%s' (rv=0x%x)",
               mPaths.Backup->HumanReadablePath().get(), (uint32_t)rvTemp));
    }

    // Failed installation or settlement retains recovery bodies. The legacy
    // callback may have installed its DB; Panorama keeps body access gated by
    // its pending intent until an explicit checked recovery outcome.
  } else if (!keepRecoveryFiles) {
    // Either the listener requested that we roll back, or we'd already failed.
    // In any case, that means putting things back how they were.
    if (movedOriginal) {
      // If we got as far as moving out the original mbox, restore it now.
      nsresult rvTemp =
          mPaths.Backup->RenameTo(mPaths.SourceDir, mPaths.SourceName);
      MOZ_LOG(gCompactLog,
              NS_SUCCEEDED(rvTemp) ? LogLevel::Debug : LogLevel::Error,
              ("MboxCompactor - Roll back. Rename '%s' -> '%s' (rv=0x%x)",
               mPaths.Backup->HumanReadablePath().get(),
               mPaths.Source->HumanReadablePath().get(), (uint32_t)rvTemp));
      // If this fails, there's nothing we can do right now. But we'll be
      // leaving the file there for recovery.
    }
    // The compaction didn't happen, so we don't need the .compacting or
    // .compacted mbox files.
    nsresult removeCompacted = mPaths.Compacted->Remove(false);
    nsresult removeCompacting = mPaths.Compacting->Remove(false);
#ifdef MOZ_PANORAMA
    if (mMigrationWork) {
      mMigrationWork->RecordError(removeCompacted);
      mMigrationWork->RecordError(removeCompacting);
    }
#else
    (void)removeCompacted;
    (void)removeCompacting;
#endif
  }

  // Provide our final report.
  nsresult finalSummary =
      mCompactListener->OnFinalSummary(rv, originalSize, compactedSize);
#ifdef MOZ_PANORAMA
  if (mMigrationWork) mMigrationWork->RecordError(finalSummary);
#else
  (void)finalSummary;
#endif

  // Delete the temp dir. But only if it's empty. Even if we succeeded,
  // there might be a failed compaction from another folder which could
  // be recovered.
  nsresult removeTemp = mPaths.TempDir->Remove(false);
#ifdef MOZ_PANORAMA
  if (mMigrationWork) {
    mMigrationWork->RecordError(removeTemp);
    // OnFinalSummary is deliberately not the terminal. All original cleanup
    // above has returned; a failed native close still retains uncertain IO.
    mMigrationWork->Complete(rv, mMigrationCloseSafe);
  }
#else
  (void)removeTemp;
#endif

  MOZ_LOG(gCompactLog, LogLevel::Debug,
          ("MboxCompactor - Finished. status=0x%x, originalSize=%" PRIi64
           ", compactedSize=%" PRIi64 "",
           (uint32_t)rv, originalSize, compactedSize));

  return NS_OK;
}

// Flush out the message data held in mBuffer/mBufferCount.
// Also handles on-the-fly patching of X-Mozilla-Headers if that was requested.
// If this succeeds, the buffer will be empty upon return.
nsresult MboxCompactor::FlushBuffer() {
#ifdef MOZ_PANORAMA
  if (mMigrationWork) MOZ_TRY(mMigrationWork->Validate());
#endif

  MOZ_ASSERT(mMsgOut);  // Shouldn't get here if we're skipping msg!
  nsresult rv;
  auto buf = mBuffer.AsSpan().First(mBufferCount);
  // Only do X-Mozilla-* patching for the first chunk, and only if patching
  // has been requested.
  if (mNewMsgSize > 0 || !mPatchXMozillaHeaders) {
    // Just output the buffer verbatim.
    rv = writeSpan(mMsgOut, buf);
    NS_ENSURE_SUCCESS(rv, rv);
    mNewMsgSize += buf.Length();
    mBufferCount = 0;
    return NS_OK;
  }

  // This is the first chunk of a new message and we want to update the
  // X-Mozilla-(Status|Status2|Keys) headers as we go.

  // Sniff for CRs to decide what kind of EOL is in use.
  auto cr = std::find(buf.cbegin(), buf.cend(), '\r');
  nsAutoCString eolSeq;
  if (cr == buf.cend()) {
    eolSeq.Assign("\n"_ns);  // No CR found.
  } else {
    eolSeq.Assign("\r\n"_ns);
  }

  // Read as many headers as we can. We might not have the complete header
  // block our in buffer, but that's OK - the X-Mozilla-* ones should be
  // right at the start).
  nsTArray<HeaderReader::Hdr> headers;
  HeaderReader rdr;
  auto leftover = rdr.Parse(buf, [&](auto const& hdr) -> bool {
    auto const& name = hdr.Name(buf);
    if (!name.EqualsLiteral(HEADER_X_MOZILLA_STATUS) &&
        !name.EqualsLiteral(HEADER_X_MOZILLA_STATUS2) &&
        !name.EqualsLiteral(HEADER_X_MOZILLA_KEYWORDS)) {
      headers.AppendElement(hdr);
    }
    return true;
  });

  // Write out X-Mozilla-* headers first - we'll create these from scratch.
  auto out =
      nsPrintfCString(HEADER_X_MOZILLA_STATUS ": %4.4x", mMsgFlags & 0xFFFF);
  out.Append(eolSeq);
  rv = writeSpan(mMsgOut, out);
  NS_ENSURE_SUCCESS(rv, rv);
  mNewMsgSize += out.Length();

  out = nsPrintfCString(HEADER_X_MOZILLA_STATUS2 ": %8.8x",
                        mMsgFlags & 0xFFFF0000);
  out.Append(eolSeq);
  rv = writeSpan(mMsgOut, out);
  NS_ENSURE_SUCCESS(rv, rv);
  mNewMsgSize += out.Length();

  // The X-Mozilla-Keys header is dynamically modified as users tag/untag
  // messages, so aim to leave some space for in-place edits.
  // Stored keywords can include padding from the original header. It is a
  // separator, not part of a tag; keep the stored value unchanged.
  nsAutoCString keywords(mMsgKeywords);
  keywords.Trim(" ");
  out = nsPrintfCString(HEADER_X_MOZILLA_KEYWORDS ": %-*s",
                        X_MOZILLA_KEYWORDS_BLANK_LEN, keywords.get());
  out.Append(eolSeq);
  rv = writeSpan(mMsgOut, out);
  NS_ENSURE_SUCCESS(rv, rv);
  mNewMsgSize += out.Length();

  // Write out the rest of the headers.
  for (auto const& hdr : headers) {
    auto h = buf.Subspan(hdr.pos, hdr.len);
    rv = writeSpan(mMsgOut, h);
    NS_ENSURE_SUCCESS(rv, rv);
    mNewMsgSize += h.Length();
  }

  // The header parser consumes the blank line. If we've completed parsing
  // we need to output it now.
  // If we haven't parsed all the headers yet, then the blank line will be
  // safely copied verbatim as part of the remaining data.
  if (rdr.IsComplete()) {
    rv = writeSpan(mMsgOut, eolSeq);
    NS_ENSURE_SUCCESS(rv, rv);
    mNewMsgSize += eolSeq.Length();
  }

  // Write out everything else in the buffer verbatim.
  if (leftover.Length() > 0) {
    rv = writeSpan(mMsgOut, leftover);
    NS_ENSURE_SUCCESS(rv, rv);
    mNewMsgSize += leftover.Length();
  }
  mBufferCount = 0;
  return NS_OK;
}
