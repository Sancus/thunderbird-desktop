/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_IMAP_SRC_NSIMAPURL_H_
#define COMM_MAILNEWS_IMAP_SRC_NSIMAPURL_H_

#include "ImapTypes.h"
#include "nsIImapUrl.h"
#include "nsCOMPtr.h"
#include "nsMsgMailNewsUrl.h"
#include "nsIWeakReferenceUtils.h"
#include "nsIFile.h"
#include "mozilla/Mutex.h"
#include "mozilla/Maybe.h"
#ifdef MOZ_PANORAMA
#  include "MessageDatabase.h"

struct NativeQueuedAppendTarget {
  mozilla::mailnews::MessageBodyState body;
  uint32_t epoch{0};
  mozilla::mailnews::OfflineAttempt attempt;
  uint32_t ordinal{0};
};

struct NativeQueuedAppendReceipt {
  mozilla::Maybe<mozilla::mailnews::ServerUidConfirmation> destination;
};
struct NativeReplayCommandReceipt {
  mozilla::mailnews::OfflineReplayReceipt outcome;
  nsresult status;
};
struct NativeQueuedCopyReceipt {
  ImapUid sourceUid = 0;
  mozilla::Maybe<mozilla::mailnews::ServerUidConfirmation> destination;
};
#endif

class nsImapUrl : public nsIImapUrl,
                  public nsMsgMailNewsUrl,
                  public nsIMsgMessageUrl,
                  public nsIMsgI18NUrl {
 public:
  NS_DECL_ISUPPORTS_INHERITED

  // nsMsgMailNewsUrl overrides
  nsresult SetSpecInternal(const nsACString& aSpec) override;
  nsresult SetQuery(const nsACString& aQuery) override;
  nsresult Clone(nsIURI** _retval) override;

  //////////////////////////////////////////////////////////////////////////////
  // we support the nsIImapUrl interface
  //////////////////////////////////////////////////////////////////////////////
  NS_DECL_NSIIMAPURL

  // nsIMsgMailNewsUrl overrides
  NS_IMETHOD IsUrlType(uint32_t type, bool* isType) override;
  NS_IMETHOD GetFolder(nsIMsgFolder** aFolder) override;
  NS_IMETHOD SetFolder(nsIMsgFolder* aFolder) override;
  // nsIMsgMessageUrl
  NS_DECL_NSIMSGMESSAGEURL
  NS_DECL_NSIMSGI18NURL

  // nsImapUrl
  nsImapUrl();

  static nsCString ConvertToCanonicalFormat(nsACString const& folderName,
                                            char onlineDelimiter);
  static nsresult EscapeSlashes(const char* sourcePath, char** resultPath);
  static nsresult UnescapeSlashes(nsACString& path);
  static nsresult UnescapeSlashes(char* path);
#ifdef MOZ_PANORAMA
  nsresult PrepareNativeQueuedCopies(
      const nsTArray<mozilla::mailnews::OfflineAttempt>& attempts);
  nsTArray<mozilla::mailnews::OfflineAttempt> CopyNativeQueuedCopies();
  nsresult RecordNativeCopyReceipts(
      const nsTArray<NativeQueuedCopyReceipt>& receipts);
  nsTArray<NativeQueuedCopyReceipt> CopyNativeCopyReceipts();
  bool HasNativeOnlineCopyTargets();
  void MarkNativeOnlineCopyTargets();
  struct OnlineCopyInput {
    ImapUid sourceUid;
    nsCString messageId;
    nsCOMPtr<nsIFile> snapshot;
    bool snapshotReady;
  };
  struct OnlineCopyObservation {
    ImapUid sourceUid;
    uint32_t epoch;
    ImapUid uid;
  };
  nsresult SetNativeOnlineCopyInputs(nsTArray<OnlineCopyInput>&& inputs);
  nsTArray<OnlineCopyInput> CopyNativeOnlineCopyInputs();
  nsresult RecordNativeCopyObservation(ImapUid sourceUid, uint32_t epoch,
                                       ImapUid uid);
  nsTArray<OnlineCopyObservation> CopyNativeCopyObservations();

  nsresult PrepareNativeReplayCommand(
      const mozilla::mailnews::OfflineReplayCommandToken& token);
  mozilla::Maybe<mozilla::mailnews::OfflineReplayCommandToken>
  CopyNativeReplayCommand();
  void CollectNativeReplayFlags(bool collecting);
  void RecordNativeReplayFlags(ImapUid uid, imapMessageFlagsType flags,
                               bool explicitUid);
  bool NativeReplayFlagsMatched();
  void RecordNativeReplayReceipt(
      mozilla::mailnews::OfflineReplayReceipt outcome, nsresult status);
  mozilla::Maybe<NativeReplayCommandReceipt> CopyNativeReplayReceipt();
  nsresult PrepareNativeFolderDelete(
      const mozilla::mailnews::OfflineAttempt& attempt);
  bool HasNativeFolderDelete();
  void RecordNativeFolderDeleteAcknowledged();
  bool NativeFolderDeleteAcknowledged();
  void RecordNativeSourceRetired();
  bool NativeSourceRetired();
  struct AcceptedAppendInput {
    mozilla::mailnews::OfflineAttempt attempt;
    nsCString messageId;
    nsCOMPtr<nsIFile> snapshot;
  };
  struct AcceptedAppendObservation {
    uint32_t index;
    uint32_t epoch;
    ImapUid uid;
  };
  nsresult PrepareAcceptedAppendDiscovery(
      nsTArray<AcceptedAppendInput>&& inputs);
  nsTArray<AcceptedAppendInput> CopyAcceptedAppendInputs();
  nsresult RecordAcceptedAppendObservation(uint32_t index, uint32_t epoch,
                                           ImapUid uid);
  nsTArray<AcceptedAppendObservation> CopyAcceptedAppendObservations();
  struct OnlineAppendObservation {
    uint32_t epoch;
    ImapUid uid;
  };
  void MarkNativeOnlineAppend();
  bool HasNativeOnlineAppend();
  nsresult RecordNativeAppendObservation(uint32_t epoch, ImapUid uid);
  mozilla::Maybe<OnlineAppendObservation> CopyNativeAppendObservation();
  nsresult PrepareNativeQueuedAppend(const NativeQueuedAppendTarget& target);
  mozilla::Maybe<NativeQueuedAppendTarget> CopyNativeQueuedAppendTarget();
  nsresult RecordNativeQueuedAppendReceipt(
      const NativeQueuedAppendReceipt& receipt);
  mozilla::Maybe<NativeQueuedAppendReceipt> CopyNativeQueuedAppendReceipt();
  void RecordNativeQueuedAppendRejected();
  bool NativeQueuedAppendRejected();
  struct FlagTarget {
    nsMsgKey key;
    ImapUid uid;
  };
  struct KeywordResponse {
    ImapUid uid;
    imapMessageFlagsType flags;
    nsCString keywords;
  };
  void RecordKeywordResponse(ImapUid uid, imapMessageFlagsType flags,
                             const nsACString& keywords);
  nsTArray<KeywordResponse> TakeKeywordResponses();
  struct FlagTargets {
    uint64_t folderId;
    uint32_t epoch;
    nsTArray<FlagTarget> messages;
  };
  struct CopyTarget {
    nsMsgKey key;
    ImapUid uid;
  };
  struct CopyTargets {
    uint64_t folderId;
    uint32_t epoch;
    nsTArray<CopyTarget> messages;
  };
  // The worker sees only immutable mailbox strings and records matching ACKs.
  // The storage/wrapper continuation is main-thread-only and released there.
  nsresult PrepareNativeHierarchy(const nsACString& source,
                                  const nsACString& destination,
                                  nsISupports* continuation,
                                  nsISupports* copyState);
  bool HasNativeHierarchy();
  nsresult ConfirmNativeHierarchy(const nsACString& source,
                                  const nsACString& destination);
  bool NativeHierarchyConfirmed();
  nsISupports* NativeHierarchyContinuation();
  nsISupports* NativeHierarchyCopyState();
  void ClearNativeHierarchyContinuation();
  bool BeginNativeHierarchyCompletion();
  nsresult NativeHierarchyResult() const { return mNativeHierarchyResult; }
  void SetNativeHierarchyResult(nsresult result) {
    mNativeHierarchyResult = result;
  }
  nsresult CaptureCopyTargets(nsIMsgFolder* folder,
                              const nsTArray<nsMsgKey>& keys,
                              const nsTArray<ImapUid>& uids);
  const mozilla::Maybe<CopyTargets>& CapturedCopyTargets() const {
    return mCopyTargets;
  }
  nsresult CaptureFlagTargets(nsIMsgFolder* folder, const nsACString& uidSet);
  const mozilla::Maybe<FlagTargets>& CapturedFlagTargets() const {
    return mFlagTargets;
  }
  nsresult SetExpectedUidValidity(uint32_t epoch);
  uint32_t ExpectedUidValidity();
  // Completion bookkeeping is confined to the main-thread URL listener.
  bool BeginFlagCompletion() {
    if (mFlagCompletionStarted) return false;
    mFlagCompletionStarted = true;
    return true;
  }
  void SetFlagDeleteIsMove(bool value) {
    mozilla::MutexAutoLock lock(mLock);
    mFlagDeleteIsMove = value;
  }
  bool FlagDeleteIsMove() {
    mozilla::MutexAutoLock lock(mLock);
    return mFlagDeleteIsMove;
  }
  nsresult FlagCompletionResult() const { return mFlagCompletionResult; }
  void SetFlagCompletionResult(nsresult result) {
    mFlagCompletionResult = result;
  }
#endif

 protected:
  virtual ~nsImapUrl();
  virtual nsresult ParseUrl();

  char* m_listOfMessageIds;

  // handle the imap specific parsing
  void ParseImapPart(char* imapPartOfUrl);

  void ParseFolderPath(char** resultingCanonicalPath);
  void ParseSearchCriteriaString();
  void ParseUidChoice();
  void ParseMsgFlags();
  void ParseListOfMessageIds();
  void ParseCustomMsgFetchAttribute();
  void ParseNumBytes();

  char* m_sourceCanonicalFolderPathSubString;
  char* m_destinationCanonicalFolderPathSubString;
  char* m_tokenPlaceHolder;
  char* m_urlidSubString;
  char m_onlineSubDirSeparator;
  char* m_searchCriteriaString;   // should we use m_search, or is this special?
  nsCString m_command;            // for custom commands
  nsCString m_msgFetchAttribute;  // for fetching custom msg attributes
  nsCString m_customAttributeResult;  // for fetching custom msg attributes
  nsCString m_customCommandResult;    // custom command response
  nsCString
      m_customAddFlags;  // these two are for setting and clearing custom flags
  nsCString m_customSubtractFlags;
  int32_t m_numBytesToFetch;  // when doing a msg body preview, how many bytes
                              // to read
  bool m_validUrl;
  bool m_runningUrl;
  bool m_idsAreUids;
  bool m_mimePartSelectorDetected;
  bool m_msgLoadingFromCache;  // if true, we might need to mark read on server
  bool m_externalLinkUrl;  // if true, we're running this url because the user
  // True if the fetch results should be put in the offline store.
  bool m_storeResultsOffline;
  bool m_storeOfflineOnFallback;
  bool m_localFetchOnly;
  bool m_rerunningUrl;  // first attempt running this failed with connection
                        // error; retrying
  bool m_moreHeadersToDownload;

  int32_t m_extraStatus;

  nsCString m_userName;
  nsCString m_serverKey;
  // event sinks
  imapMessageFlagsType m_flags;
  nsImapAction m_imapAction;

  nsWeakPtr m_imapFolder;
  nsWeakPtr m_imapMailFolderSink;
  nsWeakPtr m_imapMessageSink;

  nsWeakPtr m_imapServerSink;

  // online message copy support; i don't have a better solution yet
  nsCOMPtr<nsISupports> m_copyState;  // now, refcounted.
  nsCOMPtr<nsIFile> m_file;
  nsWeakPtr m_channelWeakPtr;

  // used by save message to disk
  nsCOMPtr<nsIFile> m_messageFile;
  bool m_canonicalLineEnding;  // CRLF

  nsCString mURI;           // the RDF URI associated with this url.
  bool mAutodetectCharset;  // used by nsIMsgI18NUrl...
  mozilla::Mutex mLock;
#ifdef MOZ_PANORAMA
  nsTArray<mozilla::mailnews::OfflineAttempt> mNativeQueuedCopies
      MOZ_GUARDED_BY(mLock);
  nsTArray<NativeQueuedCopyReceipt> mNativeCopyReceipts MOZ_GUARDED_BY(mLock);
  mozilla::Maybe<mozilla::mailnews::OfflineReplayCommandToken>
      mNativeReplayCommand MOZ_GUARDED_BY(mLock);
  mozilla::Maybe<NativeReplayCommandReceipt> mNativeReplayReceipt
      MOZ_GUARDED_BY(mLock);
  bool mCollectNativeReplayFlags MOZ_GUARDED_BY(mLock) = false;
  bool mNativeReplayFlagsMatched MOZ_GUARDED_BY(mLock) = false;
  mozilla::Maybe<mozilla::mailnews::OfflineAttempt> mNativeFolderDelete
      MOZ_GUARDED_BY(mLock);
  bool mNativeFolderDeleteAcknowledged MOZ_GUARDED_BY(mLock) = false;
  bool mNativeSourceRetired MOZ_GUARDED_BY(mLock) = false;
  bool mNativeOnlineAppend MOZ_GUARDED_BY(mLock) = false;
  nsTArray<AcceptedAppendInput> mAcceptedAppendInputs MOZ_GUARDED_BY(mLock);
  nsTArray<AcceptedAppendObservation> mAcceptedAppendObservations
      MOZ_GUARDED_BY(mLock);
  mozilla::Maybe<OnlineAppendObservation> mNativeAppendObservation
      MOZ_GUARDED_BY(mLock);
  mozilla::Maybe<NativeQueuedAppendTarget> mNativeQueuedAppend
      MOZ_GUARDED_BY(mLock);
  mozilla::Maybe<NativeQueuedAppendReceipt> mNativeAppendReceipt
      MOZ_GUARDED_BY(mLock);
  bool mNativeAppendRejected MOZ_GUARDED_BY(mLock) = false;
  struct NativeHierarchyEvidence {
    nsCString source;
    nsCString destination;
    bool confirmed = false;
  };
  mozilla::Maybe<NativeHierarchyEvidence> mNativeHierarchy
      MOZ_GUARDED_BY(mLock);
  nsCOMPtr<nsISupports> mNativeHierarchyContinuation;  // Main thread only.
  nsCOMPtr<nsISupports> mNativeHierarchyCopyState;     // Main thread only.
  bool mNativeHierarchyCompletionStarted = false;
  nsresult mNativeHierarchyResult = NS_ERROR_IN_PROGRESS;
  uint32_t m_expectedUidValidity = 0;
  mozilla::Maybe<FlagTargets> mFlagTargets;
  nsTArray<KeywordResponse> mKeywordResponses MOZ_GUARDED_BY(mLock);
  mozilla::Maybe<CopyTargets> mCopyTargets;
  bool mNativeOnlineCopyTargets MOZ_GUARDED_BY(mLock) = false;
  nsTArray<OnlineCopyInput> mNativeOnlineCopyInputs MOZ_GUARDED_BY(mLock);
  nsTArray<OnlineCopyObservation> mNativeCopyObservations MOZ_GUARDED_BY(mLock);

  bool mFlagCompletionStarted = false;
  bool mFlagDeleteIsMove = false;
  nsresult mFlagCompletionResult = NS_ERROR_IN_PROGRESS;
#endif
};

#endif  // COMM_MAILNEWS_IMAP_SRC_NSIMAPURL_H_
