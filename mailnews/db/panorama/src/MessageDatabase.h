/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_DB_PANORAMA_SRC_MESSAGEDATABASE_H_
#define COMM_MAILNEWS_DB_PANORAMA_SRC_MESSAGEDATABASE_H_

#include "MailNewsTypes.h"
#include "js/Context.h"
#include "mozilla/HashTable.h"
#include "mozilla/Maybe.h"
#include "mozilla/RefPtr.h"
#include "mozilla/Result.h"
#include "mozilla/UniquePtr.h"
#include "nsCOMPtr.h"
#include "nsIMessageDatabase.h"
#include "nsString.h"
#include "nsTArray.h"
#include "nsTObserverArray.h"
#include "prtime.h"

struct RawHdr;
class mozIStorageStatement;

namespace mozilla::mailnews {

class Folder;
class Message;

// Committed physical body location; Nothing distinguishes an absent token.
struct MessageBodyState {
  nsCString databaseSourceId;
  nsMsgKey key{nsMsgKey_None};
  uint64_t folderId{0};
  Maybe<nsCString> storeToken;
  uint64_t contentRevision{0};
  uint64_t locationRevision{0};
  uint32_t messageSize{0};
  uint32_t offlineMessageSize{0};
  uint32_t lineCount{0};
  uint32_t flags{0};
};

struct FinishedMessageBody {
  nsCString storeToken;
  uint32_t messageSize{0};
  uint32_t offlineMessageSize{0};
  uint32_t lineCount{0};
  bool offline{false};
};

// Existing local versus IMAP/news expunged-byte accounting on deletion.
enum class MessageRemovalAccounting { LocalMessageSize, OfflineMessageSize };

enum class BodyRelocationState : uint32_t { Pending, Installed, Restored };
enum class BodyRelocationOutcome { Installed, Restored };

struct RelocatedMessageBody {
  MessageBodyState before;
  Maybe<nsCString> storeToken;
  uint32_t messageSize{0};
  uint32_t offlineMessageSize{0};
  uint32_t lineCount{0};
  bool offline{false};
};

struct FolderBodyRelocation {
  nsCString databaseSourceId;
  nsCString token;
  uint64_t folderId{0};
  nsString originalPath;
  nsString compactedPath;
  nsString backupPath;
  uint64_t originalSize{0};
  uint64_t compactedSize{0};
  BodyRelocationState state{BodyRelocationState::Pending};
  // Every published physical key in the folder, in ascending order.
  nsTArray<RelocatedMessageBody> messages;
};

struct PendingDestination {
  uint64_t folderId{0};
  nsMsgKey key{nsMsgKey_None};
  uint32_t epoch{0};
};

// Combined legacy operation payload; copy destinations retain their order.
struct OfflineOperationData {
  uint32_t operation{0};
  uint32_t flagOperation{0};
  uint32_t newFlags{0};
  nsMsgKey sourceKey{nsMsgKey_None};
  uint32_t sourceUid{0};
  uint32_t messageSize{0};
  bool playingBack{false};
  nsCString sourceFolderURI;
  nsCString destinationFolderURI;
  nsCString keywordsToAdd;
  nsCString keywordsToRemove;
  nsTArray<nsCString> copyDestinations;
  Maybe<PendingDestination> pendingDestination;
  // Aligned with copyDestinations. Empty input means all bindings absent.
  nsTArray<Maybe<PendingDestination>> copyDestinationBindings;
};

struct ServerMessageLocation {
  uint64_t folderId{0};
  nsMsgKey key{nsMsgKey_None};
  uint32_t epoch{0};
  uint32_t uid{0};
};

// Destination UIDVALIDITY and UID reported together by APPENDUID/COPYUID.
struct ServerUidConfirmation {
  uint32_t epoch{0};
  uint32_t uid{0};
};

enum class OfflineAttemptState { Pending, Sent, Confirmed, Ambiguous };

struct OfflineAttempt {
  uint64_t id{0};
  uint64_t operationId{0};
  uint64_t revision{0};
  uint64_t folderId{0};
  uint32_t operation{0};
  Maybe<uint32_t> folderEpoch;
  OfflineAttemptState state{OfflineAttemptState::Pending};
  Maybe<ServerMessageLocation> source;
  Maybe<PendingDestination> destination;
  Maybe<uint32_t> confirmedUid;
};

// Physical identity only; never a Message-ID or protocol UID.
struct ConversationMember {
  nsMsgKey id{nsMsgKey_None};
  uint64_t folderId{0};
};

// Owned native fields corresponding to one CreateJSMessage row.
struct CapturedMessage {
  nsMsgKey id{nsMsgKey_None};
  uint64_t folderId{0};
  nsCString messageId;
  PRTime date{0};
  nsCString sender;
  nsCString recipients;
  nsCString subject;
  uint32_t flags{0};
  nsCString tags;
  nsMsgKey threadId{0};
  nsMsgKey threadParent{0};
};

// Includes unchanged component members; only publicationKey is after-only.
// changedKeys contains exactly the changed old keys, in ascending order.
struct MessageThreadBatch {
  uint64_t batchId{0};
  nsTArray<CapturedMessage> before;
  nsTArray<CapturedMessage> after;
  nsTArray<nsMsgKey> changedKeys;
  nsMsgKey publicationKey{nsMsgKey_None};
  bool notifyLegacy{true};
};

// Filled before commit; keep unchanged until its one delivery.
struct PreparedThreadBatch {
  PreparedThreadBatch();
  ~PreparedThreadBatch();
  PreparedThreadBatch(PreparedThreadBatch&&);
  PreparedThreadBatch& operator=(PreparedThreadBatch&&);
  PreparedThreadBatch(const PreparedThreadBatch&) = delete;
  PreparedThreadBatch& operator=(const PreparedThreadBatch&) = delete;

  MessageThreadBatch captured;
  nsTArray<RefPtr<Message>> changedLive;
  RefPtr<Message> publicationLive;
  // Only LiveView fills this with owned rooted preparation/attachment data.
  nsCOMPtr<nsISupports> liveViewData;
};

class MessageListener : public nsISupports {
 public:
  virtual void OnMessageAdded(Message* message) = 0;
  // Internal observers always receive committed adds. Adapters use the flag
  // only to gate legacy onHdrAdded callbacks.
  virtual void OnMessagePublished(Message* message, bool) {
    OnMessageAdded(message);
  }
  virtual void OnMessageRemoved(Message* message, uint32_t oldFlags) = 0;
  virtual void OnMessageFlagsChanged(nsIMsgDBHdr* oldMessage, Message* message,
                                     uint32_t oldFlags, uint32_t newFlags) = 0;
  virtual void OnMessageTagsChanged(nsIMsgDBHdr* oldMessage, Message* message,
                                    const nsACString& oldTags,
                                    const nsACString& newTags) = 0;
  // One complete storage update; default preserves existing flag observers.
  virtual void OnMessageBodyChanged(nsIMsgDBHdr* oldMessage, Message* message,
                                    const MessageBodyState& before,
                                    const MessageBodyState& after) {
    if (before.flags != after.flags) {
      OnMessageFlagsChanged(oldMessage, message, before.flags, after.flags);
    }
  }
  // Historical facts stay owned by the queue; borrowed headers remain live.
  virtual void OnMessageRemovedCaptured(const CapturedMessage& before,
                                        Message* live) {
    OnMessageRemoved(live, before.flags);
  }
  virtual void OnMessageFlagsChangedCaptured(const CapturedMessage& before,
                                             const CapturedMessage& after,
                                             nsIMsgDBHdr* oldHeader,
                                             Message* live) {
    OnMessageFlagsChanged(oldHeader, live, before.flags, after.flags);
  }
  virtual void OnMessageTagsChangedCaptured(const CapturedMessage& before,
                                            const CapturedMessage& after,
                                            nsIMsgDBHdr* oldHeader,
                                            Message* live) {
    OnMessageTagsChanged(oldHeader, live, before.tags, after.tags);
  }
  virtual void OnMessageBodyChangedCaptured(const CapturedMessage& before,
                                            const CapturedMessage& after,
                                            nsIMsgDBHdr* oldHeader,
                                            Message* live,
                                            const MessageBodyState& oldBody,
                                            const MessageBodyState& newBody) {
    OnMessageBodyChanged(oldHeader, live, oldBody, newBody);
  }
  // Known native consumers opt in; LiveView additionally admits its JS
  // listener.
  virtual bool SupportsThreadChanges() const { return false; }
  // Called in the owned transaction, before a published insert/derived writes.
  // Reads only; native views own exact old query identities.
  // Failure leaves output intact; no external JS callbacks.
  virtual nsresult CaptureThreadViewBeforeInsert(
      nsCOMPtr<nsISupports>& output) {
    output = nullptr;
    return NS_OK;
  }
  // The opaque snapshot is borrowed; queued records retain its ownership.
  virtual nsresult PrepareThreadBatch(const MessageThreadBatch& batch,
                                      nsISupports* beforeView,
                                      PreparedThreadBatch& prepared) {
    return PrepareThreadBatch(batch, prepared);
  }
  // Preparation owns history and live wrappers, without notifying observers.
  // On failure prepared is unchanged. No external JS callbacks during
  // preparation.
  virtual nsresult PrepareThreadBatch(const MessageThreadBatch& batch,
                                      PreparedThreadBatch& prepared);
  virtual void DeliverThreadBatch(const PreparedThreadBatch& prepared);
  virtual void OnMessageThreadChanged(const CapturedMessage& before,
                                      const CapturedMessage& after,
                                      Message* borrowedLive) {}
  virtual void OnMessagePublishedCaptured(const CapturedMessage& after,
                                          Message* borrowedLive,
                                          bool notifyLegacy) {
    OnMessagePublished(borrowedLive, notifyLegacy);
  }
  virtual ~MessageListener() {};
};

#define MESSAGE_SQL_FIELDS \
  "id, folderId, threadId, threadParent, messageId, date, sender, recipients, ccList, bccList, subject, flags, tags, priority"_ns

class MessageDatabase : public nsIMessageDatabase {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIMESSAGEDATABASE

  // Borrows inputs until return; RawHdr::key is not an allocation request.
  // Sets outputs after commit, before callbacks; the live result is owned.
  nsresult AddMessage(uint64_t folderId, const ::RawHdr& header,
                      bool notifyLegacy, nsMsgKey* key,
                      Message** liveHeader = nullptr);

  // Native facade entry: owns its transaction, verifies the physical folder
  // and database incarnation, and accounts bytes before committing removal.
  // OfflineMessageSize counts only rows with the Offline flag. Generic
  // RemoveMessage keeps its existing behavior without folder accounting.
  nsresult RemoveMessageFromFolder(nsMsgKey key, uint64_t folderId,
                                   const nsACString &databaseSourceId,
                                   MessageRemovalAccounting accounting);

  // Durable identity/header, excluded from published membership and events.
  nsresult StageMessage(uint64_t folderId, const ::RawHdr& header,
                        nsMsgKey* key, Message** liveHeader = nullptr);
  // Caller finishes body storage before publishing the completed header.
  nsresult PublishMessage(nsMsgKey key, bool notifyLegacy,
                          Message** liveHeader = nullptr);
  // Removes staged metadata only; never deletes stored body bytes.
  nsresult AbortMessage(nsMsgKey key);
  nsresult ListStagedMessages(uint64_t folderId, nsTArray<nsMsgKey>& keys);

  // Published rows only. Missing: NOT_AVAILABLE; failure leaves output intact.
  nsresult GetMessageBodyState(nsMsgKey key, MessageBodyState& output);
  // Provider has finished storage. Stale guard: NOT_AVAILABLE; no byte
  // deletion.
  nsresult SettleMessageBody(const MessageBodyState& expected,
                             const FinishedMessageBody& finished,
                             MessageBodyState& output);

  // Completes a Partial row with provider-finished bytes and parsed metadata.
  // Keeps physical/thread identity and unrelated current properties. Current
  // user flags/tags survive, except a final explicit keywords extra wins.
  nsresult CompletePartialMessage(const MessageBodyState& expected,
                                  const ::RawHdr& parsed,
                                  const FinishedMessageBody& finished,
                                  MessageBodyState& output);

  // Pending relocation blocks new body resolutions and folder mutation.
  nsresult CheckFolderBodyAccess(uint64_t folderId);
  nsresult CheckMessageBodyAccess(nsMsgKey key);
  // Unpublished staged rows in this folder defer preparation with IN_PROGRESS.
  nsresult PrepareBodyRelocation(const FolderBodyRelocation& input);
  nsresult GetBodyRelocation(uint64_t folderId,
                             Maybe<FolderBodyRelocation>& output);
  nsresult ListPendingBodyRelocations(nsTArray<uint64_t>& output);
  nsresult SettleBodyRelocation(uint64_t folderId, const nsACString& token,
                                BodyRelocationOutcome outcome);

  // Whole-payload writes are atomic. Sent/ambiguous attempts freeze payloads.
  // Missing records return NOT_AVAILABLE; reads leave output unchanged on
  // error. Reserves a disjoint key for folder-wide operations without a message
  // row.
  nsresult ReserveOfflineOperationKey(uint64_t folderId, nsMsgKey& key);
  nsresult GetOfflineOperation(uint64_t folderId, nsMsgKey key,
                               OfflineOperationData& output);
  // Reads the immutable queued tuple, even after local message removal.
  // Nothing means no captured tuple; a missing operation is NOT_AVAILABLE.
  // Does not check the current server epoch or begin an attempt.
  nsresult GetOfflineOperationSource(uint64_t folderId, nsMsgKey key,
                                     Maybe<ServerMessageLocation>& output);
  nsresult StoreOfflineOperation(uint64_t folderId, nsMsgKey key,
                                 const OfflineOperationData& input);
  nsresult SetOfflineOperationPlayingBack(uint64_t folderId, nsMsgKey key,
                                          bool playingBack);
  nsresult RemoveOfflineOperation(uint64_t folderId, nsMsgKey key);
  nsresult ListOfflineOperations(uint64_t folderId, bool deletesOnly,
                                 nsTArray<nsMsgKey>& keys);
  // Dispatch snapshots the saved source tuple and explicit destination
  // identity. No automatic replay of Sent/Ambiguous; confirmation alone binds a
  // UID.
  nsresult BeginOfflineAttempt(uint64_t folderId, nsMsgKey key,
                               uint32_t operation,
                               const Maybe<PendingDestination>& destination,
                               uint64_t& attemptId);
  nsresult GetOfflineAttempt(uint64_t attemptId, OfflineAttempt& output);
  nsresult GetCurrentOfflineAttempt(uint64_t folderId, nsMsgKey key,
                                    OfflineAttempt& output);
  nsresult MarkOfflineAttemptAmbiguous(uint64_t attemptId);
  // Caller has proved no server effect, not merely lost an acknowledgement.
  nsresult ResolveOfflineAttemptNotApplied(uint64_t attemptId);
  nsresult ConfirmOfflineAttempt(
      uint64_t attemptId, const Maybe<ServerUidConfirmation>& destinationUid);

  // Reads stored facts directly, including uncommitted owned changes.
  // Missing row: NS_ERROR_UNEXPECTED. On failure output is unchanged.
  nsresult CaptureMessage(nsMsgKey key, CapturedMessage& output);
  // Published or staged current facts. Missing is NS_OK/Nothing; errors leave
  // output intact. No cache/presence inference or transaction ownership.
  nsresult CaptureHeaderState(nsMsgKey key, Maybe<CapturedMessage>& output);

  // Unwired insertion discovery: direct edges plus whole stored components.
  // Requires known References history for every visible row; otherwise
  // NS_ERROR_NOT_AVAILABLE. Missing seed: NS_ERROR_UNEXPECTED.
  // Reads owned staging without changing cache/transactions.
  // On failure output is unchanged.
  nsresult DiscoverConversationComponent(nsMsgKey key,
                                         nsTArray<ConversationMember>& output);

  // A bunch of oddly-specific functions here purely to support implementing
  // legacy message interfaces (nsIMsgDBHdr and friends).
  // Only available via the concrete class, Not XPCOM.
  // New code should avoid these in favour of more operation-centric methods
  // (eg: "tag these messages with $keyword", "move these messages into
  // folder B", "fetch JS-friendly data for these messages" etc...).

  nsresult GetMessageFlags(nsMsgKey key, uint32_t& flags);
  nsresult GetMessageFlag(nsMsgKey key, uint32_t flag, bool& value);
  nsresult GetMessagePriority(nsMsgKey key, nsMsgPriorityValue& priority);
  nsresult GetMessageDate(nsMsgKey key, PRTime& date);
  nsresult GetMessageSize(nsMsgKey key, uint64_t& size);
  nsresult GetMessageLineCount(nsMsgKey key, uint32_t& size);
  nsresult GetMessageOfflineMessageSize(nsMsgKey key, uint64_t& size);
  nsresult GetMessageStoreToken(nsMsgKey key, nsACString& token);
  nsresult GetMessageMessageId(nsMsgKey key, nsACString& messageId);
  nsresult GetMessageCcList(nsMsgKey key, nsACString& ccList);
  nsresult GetMessageBccList(nsMsgKey key, nsACString& bccList);
  nsresult GetMessageSender(nsMsgKey key, nsACString& sender);
  nsresult GetMessageSubject(nsMsgKey key, nsACString& subject);
  nsresult GetMessageRecipients(nsMsgKey key, nsACString& recipients);
  nsresult GetMessageTags(nsMsgKey key, nsACString& tags);
  nsresult GetMessageUidOnServer(nsMsgKey key, uint32_t& uidOnServer);
  // Only present UID properties participate. Missing/stale: NOT_AVAILABLE;
  // multiple physical matches: FILE_CORRUPTED. Failure leaves key unchanged.
  nsresult GetMessageKeyForServerUid(uint64_t folderId, uint32_t epoch,
                                     uint32_t uid, nsMsgKey& key);
  // Owns its transaction; rejects stale epochs, wrong folders and collisions.
  nsresult BindMessageToServerUid(nsMsgKey key, uint64_t folderId,
                                  uint32_t epoch, uint32_t uid);
  nsresult GetMessageFolderId(nsMsgKey key, uint64_t& folderId);
  nsresult GetMessagePropertyNames(nsMsgKey key, nsTArray<nsCString>& names);
  nsresult GetMessageProperty(nsMsgKey key, const nsACString& name,
                              uint32_t& value);

  // Raw parsed tokens, in order, without normalization or self-exclusion.
  // Missing row: NS_ERROR_UNEXPECTED; discarded history:
  // NS_ERROR_NOT_AVAILABLE. On failure the output is unchanged.
  nsresult GetMessageReferences(nsMsgKey key, nsTArray<nsCString>& references);
  // Metadata only. Owns its transaction; rejects any transaction already open.
  nsresult SetMessageReferences(nsMsgKey key,
                                const nsTArray<nsCString>& references);

  // Folder-scoped thread metadata, separate from header flags. Missing physical
  // folder/thread returns NOT_AVAILABLE; failures leave getter output
  // unchanged.
  nsresult GetThreadFlags(uint64_t folderId, uint64_t threadId,
                          uint32_t& flags);
  // Commits silently before success; an active caller transaction is not
  // joined.
  nsresult SetThreadFlags(uint64_t folderId, uint64_t threadId, uint32_t flags);

  nsresult GetMessageThreadId(nsMsgKey key, nsMsgKey& threadId);
  nsresult GetMessageThreadParent(nsMsgKey key, nsMsgKey& threadParent);

  nsresult SetMessageFlags(nsMsgKey key, uint32_t flags);
  nsresult SetMessageFlag(nsMsgKey key, uint32_t flag, bool value);
  nsresult SetMessagePriority(nsMsgKey key, nsMsgPriorityValue priority);
  nsresult SetMessageDate(nsMsgKey key, PRTime date);
  nsresult SetMessageSize(nsMsgKey key, uint64_t size);
  nsresult SetMessageLineCount(nsMsgKey key, uint32_t size);
  nsresult SetMessageOfflineMessageSize(nsMsgKey key, uint64_t size);
  nsresult SetMessageStoreToken(nsMsgKey key, const nsACString& token);
  nsresult SetMessageMessageId(nsMsgKey key, const nsACString& messageId);
  nsresult SetMessageCcList(nsMsgKey key, const nsACString& ccList);
  nsresult SetMessageBccList(nsMsgKey key, const nsACString& bccList);
  nsresult SetMessageSender(nsMsgKey key, const nsACString& sender);
  nsresult SetMessageSubject(nsMsgKey key, const nsACString& subject);
  nsresult SetMessageRecipients(nsMsgKey key, const nsACString& recipients);
  nsresult SetMessageTags(nsMsgKey key, const nsACString& tags);
  nsresult SetMessageUidOnServer(nsMsgKey key, uint32_t uidOnServer);
  nsresult SetMessageProperty(nsMsgKey key, const nsACString& name,
                              const nsACString& value);
  nsresult SetMessageProperty(nsMsgKey key, const nsACString& name,
                              uint32_t value);

  // Stored membership, independent of cached notification headers.
  // On storage error, exists is unchanged.
  nsresult MessageExists(nsMsgKey key, bool& exists);

  // Lowest physical key with this exact Message-ID in an existing folder.
  // Returns 0 if not found; storage errors propagate.
  Result<nsMsgKey, nsresult> FindByMessageId(nsACString const& messageId);

 protected:
  virtual ~MessageDatabase();

 private:
  friend class DatabaseCore;
  friend class FolderMigrator;

  // Caller owns the insertion transaction and has written the new row/history.
  // Read-only plan; does not assign a batch ID, write derived fields, warm
  // caches or notify. Failure leaves output and the caller transaction intact.
  nsresult PlanConversationInsertion(nsMsgKey key, bool notifyLegacy,
                                     MessageThreadBatch& output);

  // Caller owns the active transaction/savepoint and must roll it back on
  // error.
  nsresult WriteMessageReferencesInTransaction(
      nsMsgKey key, const nsTArray<nsCString>& references);

  enum class HeaderTable { Messages, Properties, References, ReferenceSets };
  nsresult IsMessageStaged(nsMsgKey key, bool& staged);
  nsresult GetHeaderStatement(nsMsgKey key, const nsACString& label,
                              HeaderTable table, const nsACString& prefix,
                              const nsACString& suffix,
                              mozIStorageStatement** statement,
                              bool* staged = nullptr);
  nsresult InsertMessage(uint64_t folderId, const ::RawHdr& header, bool staged,
                         bool notifyLegacy, nsMsgKey* key,
                         Message** liveHeader);

  nsresult ReadOfflineOperationIdentity(uint64_t folderId, nsMsgKey key,
                                        int64_t& id, int64_t& revision,
                                        Maybe<ServerMessageLocation>& source,
                                        Maybe<uint32_t>* folderEpoch = nullptr);
  nsresult RequireOfflineOperationMutable(int64_t operationId);
  nsresult ValidatePendingDestination(const PendingDestination& destination,
                                      uint64_t folderId, nsMsgKey key,
                                      bool append, int64_t operationId);
  nsresult BindMessageToServerUidInTransaction(nsMsgKey key, uint64_t folderId,
                                               uint32_t epoch, uint32_t uid,
                                               bool allowStaged);

  nsresult RemoveMessageInternal(nsMsgKey key, uint64_t folderId,
                                 const nsACString *databaseSourceId,
                                 MessageRemovalAccounting accounting);
  nsresult AccountRemovedMessage(nsMsgKey key, uint64_t folderId,
                                 const nsACString &databaseSourceId,
                                 MessageRemovalAccounting accounting);

  nsresult SettleMessageBodyInternal(const MessageBodyState& expected,
                                     const FinishedMessageBody& finished,
                                     const ::RawHdr* parsed,
                                     MessageBodyState& output);
  nsresult ReadMessageBodyState(nsMsgKey key, MessageBodyState& output);
  nsresult ReadBodyRelocation(uint64_t folderId,
                              Maybe<FolderBodyRelocation>& output);
  nsresult VerifyBodyRelocationRows(const FolderBodyRelocation& plan);
  nsresult CheckPendingFolderRelocation(uint64_t folderId);
  nsresult CheckPendingMessageRelocation(nsMsgKey key);
  nsresult RequireCommittedSearchRead();
  nsresult GetSearchWatermark(uint64_t& sequence);

  MessageDatabase();
  void Startup();
  void Shutdown();

 private:
  friend class FolderInfo;
  friend class PerFolderDatabase;
  friend class Thread;
  friend class ThreadMessageEnumerator;
  friend class DeliveryCoreMessageExistence;
  friend class DeliveryCoreReferences;

  // Leaves keys unchanged on failure.
  nsresult ListAllKeys(uint64_t aFolderId, nsTArray<nsMsgKey>& aKeys);
  // Leaves keys unchanged on failure.
  nsresult ListThreadKeys(uint64_t folderId, uint64_t parent, uint64_t threadId,
                          nsTArray<nsMsgKey>& keys);
  nsresult GetThreadMaxDate(uint64_t folderId, uint64_t threadId,
                            uint64_t* maxDate);
  nsresult CountThreadKeys(uint64_t folderId, uint64_t threadId,
                           uint64_t* numMessages);
  nsresult ListThreadChildKeys(uint64_t folderId, uint64_t parent,
                               nsTArray<nsMsgKey>& keys);
  nsresult GetMessage(nsMsgKey aKey, Message** aMessage);
  nsresult GetMessageForMessageID(uint64_t aFolderId,
                                  const nsACString& aMessageId,
                                  Message** aMessage);
  nsresult MarkAllRead(uint64_t aFolderId, nsTArray<nsMsgKey>& aMarkedKeys);
  // Count read errors leave the output unchanged.
  nsresult GetNumMessages(uint64_t folderId, uint64_t* numMessages);
  nsresult GetNumUnread(uint64_t folderId, uint64_t* numUnread);

  // Message-data cache.
  // Holds whatever fields we want to cache about a message - can
  // be pulled from multiple tables, and doesn't have to be _every_
  // field.
  struct CachedMsg {
    nsMsgKey key{nsMsgKey_None};
    uint64_t folderId{0};
    nsMsgKey threadId;
    nsMsgKey threadParent;
    nsAutoCString messageId;
    PRTime date{0};
    nsAutoCString sender;
    nsAutoCString recipients;
    nsAutoCString ccList;
    nsAutoCString bccList;
    nsAutoCString subject;
    uint32_t flags{0};
    nsAutoCString tags;
    nsMsgPriorityValue priority{0};
  };
  // The cache, indexed by msgKey.
  mozilla::HashMap<nsMsgKey, CachedMsg> mMsgCache;
  // Guarantee message data is in cache.
  Result<CachedMsg*, nsresult> EnsureCached(nsMsgKey key);
  // Fetch message data from DB into our cache struct.
  nsresult FetchMsg(nsMsgKey key, CachedMsg& cached);
  // Check the cache and slim it down if needed.
  void TrimCache();

  struct ListenerRegistration;
  void NotifyImportedMessage(Message* message);
  struct QueuedMessageBatch;
  nsresult PrepareMessageBatch(UniquePtr<QueuedMessageBatch>& output);
  nsresult CaptureThreadViewsBeforeInsert(QueuedMessageBatch& batch);
  nsresult PrepareConversationBatch(nsMsgKey key, bool notifyLegacy,
                                    QueuedMessageBatch& notification,
                                    MessageThreadBatch& captured);
  struct ThreadWordRemap {
    uint64_t folderId{0};
    nsMsgKey threadId{0};
    uint32_t flags{0};
    bool present{false};
    nsTArray<nsMsgKey> oldThreads;
  };
  nsresult ReadThreadWord(uint64_t folderId, nsMsgKey threadId, uint32_t& flags,
                          bool& present);
  nsresult PrepareThreadWordRemap(const MessageThreadBatch& batch,
                                  nsTArray<ThreadWordRemap>& output);
  nsresult ApplyThreadWordRemap(const nsTArray<ThreadWordRemap>& remaps);
  void InstallThreadCache(const MessageThreadBatch& batch);
  void QueueMessageBatch(UniquePtr<QueuedMessageBatch> batch);
  void DrainMessageBatches();

  nsTArray<RefPtr<ListenerRegistration>> mMessageListeners;
  nsTArray<UniquePtr<QueuedMessageBatch>> mMessageBatches;
  uint64_t mLastMessageBatch{0};
  bool mDeliveringMessageBatches{false};
  // Enabled only with the independently accepted producer/consumer aggregate.
  bool mConversationGroupingEnabled{false};

  nsresult SetMessageFlagsInternal(Message* message, uint32_t newFlags);
};

}  // namespace mozilla::mailnews

#endif  // COMM_MAILNEWS_DB_PANORAMA_SRC_MESSAGEDATABASE_H_
