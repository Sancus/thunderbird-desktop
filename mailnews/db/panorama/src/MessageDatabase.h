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
class nsMsgKeySet;

namespace mozilla::mailnews {

class Folder;
class Message;
class PerFolderDatabase;

// A persistent local group incarnation, never an inferred NNTP server epoch.
struct NewsGroupIdentity {
  nsCString databaseSourceId;
  uint64_t folderId{0};
  nsCString incarnation;
};

// This binding is present, including article 0. Physical keys are independent.
struct NewsArticleIdentity {
  NewsGroupIdentity group;
  uint32_t articleNumber{0};
};

// One imported header of a migrated news group and its retained article.
struct ImportedNewsArticle {
  nsMsgKey physicalKey{nsMsgKey_None};
  uint32_t articleNumber{0};
};

struct NewsArticleResult {
  bool inserted{false};
  nsMsgKey physicalKey{nsMsgKey_None};
  RefPtr<Message> header;
};

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

// Owned complete deletion snapshot. Consumed by a successful fresh-key restore.
// Not a durable undo journal; callers retain recovery bytes until settled.
class RemovedMessage final {
 public:
  RemovedMessage();
  ~RemovedMessage();
  RemovedMessage(RemovedMessage&&);
  RemovedMessage& operator=(RemovedMessage&&);
  RemovedMessage(const RemovedMessage&) = delete;
  RemovedMessage& operator=(const RemovedMessage&) = delete;
  const MessageBodyState* Body() const;

 private:
  friend class MessageDatabase;
  struct Data;
  UniquePtr<Data> mData;
};

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

// Opaque pre-scan custody. Failure/retry never consumes the captured rows.
class FolderRepairSnapshot final {
 public:
  FolderRepairSnapshot();
  ~FolderRepairSnapshot();
  FolderRepairSnapshot(FolderRepairSnapshot&&);
  FolderRepairSnapshot& operator=(FolderRepairSnapshot&&);
  FolderRepairSnapshot(const FolderRepairSnapshot&) = delete;
  FolderRepairSnapshot& operator=(const FolderRepairSnapshot&) = delete;
  const nsTArray<MessageBodyState>* Messages() const;

 private:
  friend class MessageDatabase;
  struct Data;
  UniquePtr<Data> mData;
};

// Borrowed only during CompleteFolderRepair; the facade owns each parser draft.
struct FolderRepairMessage {
  const ::RawHdr* parsed{nullptr};
  nsCString storeToken;
  uint64_t messageSize{0};
  uint32_t lineCount{0};
  bool referencesKnown{false};
};

struct PendingDestination {
  uint64_t folderId{0};
  nsMsgKey key{nsMsgKey_None};
  uint32_t epoch{0};
  // False is explicit absence, stored as SQL NULL, never an epoch-zero
  // sentinel.
  bool epochKnown{true};
  static PendingDestination Unobserved(uint64_t folder, nsMsgKey physicalKey) {
    return {folder, physicalKey, 0, false};
  }
};

// Explicit pending destination metadata, not an inferred source-header match.
// Generic integers use the existing public legacy unsigned text view.
struct PendingHeaderAttribute {
  nsCString name;
  nsCString text;  // Used only when integer is Nothing.
  Maybe<uint64_t> integer;
};

// A proven mutation of protocol flags, never a client flag snapshot.
struct OfflineFlagMutation {
  uint16_t setMask{0};
  uint16_t clearMask{0};
};
enum class OfflineMoveLocalPresence : uint8_t { Exact, ExactOrAbsent };
struct OfflineMoveSourceGuard {
  MessageBodyState original;
  OfflineMoveLocalPresence presence{OfflineMoveLocalPresence::Exact};
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
  Maybe<OfflineFlagMutation> flagMutation;
  Maybe<OfflineMoveSourceGuard> moveSourceGuard;
  // Input-only: an explicit legacy whole-word setter invalidates provenance.
  // Ordinary read/modify/write preserves it; this never grants promotion.
  bool invalidateFlagMutation{false};
};

// An explicitly identified surviving operation targeting the removed header.
struct OfflineUndoCounterpart {
  nsCString databaseSourceId;
  uint64_t folderId{0};
  nsMsgKey key{nsMsgKey_None};
  uint32_t action{0};
  Maybe<uint32_t> copyOrdinal;
  PendingDestination destination;
};

// Native-owned identity, revision, full payload and immutable queued
// provenance. Consumed together with RemovedMessage only after a successful
// restore commit.
class OfflineOperationUndo final {
 public:
  OfflineOperationUndo();
  ~OfflineOperationUndo();
  OfflineOperationUndo(OfflineOperationUndo&&);
  OfflineOperationUndo& operator=(OfflineOperationUndo&&);
  OfflineOperationUndo(const OfflineOperationUndo&) = delete;
  OfflineOperationUndo& operator=(const OfflineOperationUndo&) = delete;
  // Borrowed until move, replacement, successful restore/removal, or
  // destruction. A separate selected-MOVE Redo output owns the full intent;
  // this borrowed view is never permission to reconstruct or write a consumed
  // snapshot.
  const OfflineOperationData* Operation() const;

 private:
  friend class MessageDatabase;
  struct Data;
  UniquePtr<Data> mData;
};

struct ServerMessageLocation {
  uint64_t folderId{0};
  nsMsgKey key{nsMsgKey_None};
  uint32_t epoch{0};
  uint32_t uid{0};
};

// Immutable queued source identity for the narrow prepublication return-home
// binding. The physical operation key is distinct from its historical source
// key.
struct QueuedSourceIdentity {
  nsCString databaseSourceId;
  uint64_t folderId{0};
  nsMsgKey key{nsMsgKey_None};
  uint64_t operationId{0};
  uint64_t revision{0};
  Maybe<ServerMessageLocation> source;
};

// Destination UIDVALIDITY and UID reported together by APPENDUID/COPYUID.
struct ServerUidConfirmation {
  uint32_t epoch{0};
  uint32_t uid{0};
};

// Caller-checked ordinary online destination, not a queued command receipt.
// A file source stays owned by the protocol caller. Native sources carry their
// actual body incarnation and, for an IMAP source, its current server tuple.
struct OnlineTransferDestination {
  nsCString databaseSourceId;
  PendingDestination destination;
  Maybe<FinishedMessageBody> finished;
  Maybe<MessageBodyState> sourceBody;
  Maybe<ServerMessageLocation> sourceLocation;
};

enum class OfflineReplayCommand : uint8_t {
  FlagSet,
  FlagClear,
  MoveStore,
  MoveUidExpunge,
  MoveExpunge
};
enum class OfflineReplayCommandState : uint8_t {
  Pending,
  Sent,
  RejectedNoEffect,
  Acknowledged,
  Ambiguous
};
enum class OfflineReplayReceipt : uint8_t {
  Acknowledged,
  RejectedNoEffect,
  Ambiguous
};
struct OfflineReplayCommandProgress {
  OfflineReplayCommandState state{OfflineReplayCommandState::Pending};
  uint64_t generation{0};
  Maybe<nsresult> firstError;
};
enum class OfflineMoveExpunge : uint8_t { None, Uid, Mailbox };
struct OfflineMoveSourcePlan {
  OfflineMoveExpunge expunge{OfflineMoveExpunge::None};
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
  Maybe<uint32_t> confirmedEpoch;
  // Explicit action snapshots preserve the whole ordered operation payload.
  nsCString transferSourceId;
  nsMsgKey operationKey{nsMsgKey_None};
  Maybe<uint32_t> copyOrdinal;
  bool transferAccepted{false};
  Maybe<MessageBodyState> transferBody;
  // An actual tagged APPEND OK is durable even without an authoritative UID.
  // Keep Sent until an actual UID receipt confirms the destination.
  bool appendAccepted{false};
  Maybe<MessageBodyState> appendBody;
  uint32_t replayVersion{0};
  Maybe<OfflineFlagMutation> flagMutation;
  Maybe<OfflineMoveSourceGuard> moveSourceGuard;
  Maybe<OfflineMoveSourcePlan> moveSourcePlan;
  Maybe<OfflineReplayCommandProgress> flagSet, flagClear;
  Maybe<OfflineReplayCommandProgress> sourceStore, sourceExpunge;
  bool moveSettled{false};
  Maybe<nsresult> firstError;
};

struct OfflineReplayCommandToken {
  OfflineAttempt attempt;
  OfflineReplayCommand command{OfflineReplayCommand::FlagSet};
  uint64_t generation{0};
};
struct OfflineMoveSettlement {
  uint64_t attemptId{0};
  nsMsgKey destinationKey{nsMsgKey_None};
  bool sourceRowRemoved{false};
  bool operationRetired{false};
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

  // installed is the facade's persistent borrowed slot. All fallible work
  // precedes commit; slot/set contents and owning outputs precede callbacks.
  nsresult SetNewsReadSet(const nsACString& databaseSourceId, uint64_t folderId,
                          PerFolderDatabase& owner, nsMsgKeySet* proposed,
                          nsMsgKeySet*& installed,
                          const Maybe<nsCString>& serializedNewsrc = Nothing());
  // Cleanup only: never dereferences the borrowed set or opens the core.
  void DetachNewsReadSet(PerFolderDatabase& owner, nsMsgKeySet*& installed);
  nsresult GetNewsGroupIdentity(const nsACString& databaseSourceId,
                                uint64_t folderId, NewsGroupIdentity& output);
  nsresult GetNewsArticleKey(const NewsArticleIdentity& expected,
                             nsMsgKey& physicalKey);
  // Optional public owning output must be initially null. It is filled with
  // the result before native callbacks; errors preserve both output slots.
  // Migration only, inside the import transaction that inserted these
  // headers: a legacy news key is the article number, while native physical
  // keys are independent. Binds each header to its article in this group.
  nsresult BindImportedNewsArticlesInTransaction(
      uint64_t folderId, const nsTArray<ImportedNewsArticle>& articles);
  nsresult AddNewsArticle(const NewsArticleIdentity& expected,
                          const ::RawHdr& parsed, bool notifyLegacy,
                          NewsArticleResult& output,
                          nsIMsgDBHdr** liveHeader = nullptr,
                          const Maybe<bool>& readIntent = Nothing());

  // Native facade entry: owns its transaction, verifies the physical folder
  // and database incarnation, and accounts bytes before committing removal.
  // OfflineMessageSize counts only rows with the Offline flag. Generic
  // RemoveMessage keeps its existing behavior without folder accounting.
  nsresult RemoveMessageFromFolder(nsMsgKey key, uint64_t folderId,
                                   const nsACString& databaseSourceId,
                                   MessageRemovalAccounting accounting);

  // Durable identity/header, excluded from published membership and events.
  nsresult StageMessage(uint64_t folderId, const ::RawHdr& header,
                        nsMsgKey* key, Message** liveHeader = nullptr);
  // Caller finishes body storage before publishing the completed header.
  nsresult PublishMessage(nsMsgKey key, bool notifyLegacy,
                          Message** liveHeader = nullptr);
  // The caller has reconciled this positive UID with the complete actual
  // command/mailbox result. Bind/read back/publish the exact unqueued staged
  // destination in one transaction. This never confirms an offline attempt.
  // Failure preserves mapping and the null owning header slot. Both outputs
  // are installed before callbacks; the caller must keep them alive through
  // synchronous publication and retain its source until successful settlement.
  nsresult PublishOnlineTransferDestination(
      const OnlineTransferDestination& expected, uint32_t observedEpoch,
      uint32_t observedUid, bool notifyLegacy, ServerMessageLocation& mapping,
      Message** liveHeader);
  // Removes staged metadata only; never deletes stored body bytes.
  nsresult AbortMessage(nsMsgKey key);
  nsresult ListStagedMessages(uint64_t folderId, nsTArray<nsMsgKey>& keys);

  // Updates only the explicit unbound staged target, without publication.
  // Attributes are ordered and atomic; PublishMessage consumes the staged row.
  // Storage aliases require matching provider-finished destination state.
  nsresult SetStagedHeaderAttributes(
      const nsACString& databaseSourceId, const PendingDestination& target,
      const nsTArray<PendingHeaderAttribute>& attributes,
      const Maybe<FinishedMessageBody>& finished = Nothing());

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

  // Caller first persistently invalidates the summary, then captures before
  // the semaphore-guarded scan. Published physical rows only; no store I/O.
  nsresult CaptureFolderRepair(uint64_t folderId,
                               const nsACString& databaseSourceId,
                               FolderRepairSnapshot& output);
  // One complete successful physical scan. Matching uses captured token/body
  // identity, never a header key/Message-ID/UID. No unmatched-row deletion.
  // On error snapshot/output are unchanged and no callbacks are delivered.
  // Success consumes the snapshot and sets all live outputs before callbacks.
  nsresult CompleteFolderRepair(FolderRepairSnapshot& snapshot,
                                const nsTArray<FolderRepairMessage>& messages,
                                nsresult scanStatus, bool scanComplete,
                                nsTArray<RefPtr<Message>>& output);

  // Captures complete SQL metadata before deletion, never from a cached header.
  // Output is unchanged on error and available before removal callbacks.
  // Successful capture replaces any prior unconsumed snapshot in output.
  nsresult RemoveMessageForUndo(nsMsgKey key, RemovedMessage& output);
  // Per-folder capture accounts expunged bytes in the same removal transaction.
  nsresult RemoveMessageForUndo(nsMsgKey key, uint64_t folderId,
                                const nsACString& databaseSourceId,
                                MessageRemovalAccounting accounting,
                                RemovedMessage& output,
                                OfflineOperationUndo* redo = nullptr,
                                OfflineOperationUndo* nextOffline = nullptr);
  // Requires a fresh provider-finished target write, not old-token reuse.
  // Old removed bytes remain expunged; no UID binding is copied.
  // Allocates a fresh key; consumes captured only after successful commit.
  nsresult RestoreMessageForUndo(uint64_t folderId, RemovedMessage& captured,
                                 const FinishedMessageBody& finished,
                                 nsMsgKey* key, Message** liveHeader = nullptr,
                                 OfflineOperationUndo* offline = nullptr,
                                 const PendingDestination* cancelMove = nullptr,
                                 OfflineOperationUndo* redo = nullptr);
  // Explicit cancelMove selects only that queued unsent MOVE. The separate redo
  // output owns the immutable full intent; default full restore is unchanged.
  // Redo is consumed with nextOffline/RemovedMessage output only on removal
  // commit. Capture before removing the queued operation. No dispatched
  // resurrection. Optional counterpart must identify an actual COPY/MOVE
  // destination binding.
  nsresult CaptureOfflineOperationForUndo(
      uint64_t folderId, nsMsgKey key, const nsACString& databaseSourceId,
      OfflineOperationUndo& output,
      const OfflineUndoCounterpart* counterpart = nullptr);

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
  // Read-only custody query for an existing exact folder/key operation.
  // Missing, stale-owner, corrupt-binding and storage errors preserve held.
  // False does not authorize dispatch or bypass the ordinary replay guards.
  nsresult IsOfflineImportHeld(uint64_t folderId, nsMsgKey key, bool& held);
  // Reads the immutable queued tuple, even after local message removal.
  // Nothing means no captured tuple; a missing operation is NOT_AVAILABLE.
  // Does not check the current server epoch or begin an attempt.
  nsresult GetOfflineOperationSource(uint64_t folderId, nsMsgKey key,
                                     Maybe<ServerMessageLocation>& output);
  nsresult GetQueuedSourceIdentity(uint64_t folderId, nsMsgKey key,
                                   QueuedSourceIdentity& output);
  // Only a matching actual first UIDVALIDITY observation authorizes this call.
  nsresult ObserveOfflineDestinationEpoch(const QueuedSourceIdentity& expected,
                                          uint32_t action,
                                          const Maybe<uint32_t>& copyOrdinal,
                                          const PendingDestination& destination,
                                          uint32_t observedEpoch);
  // Return an actual queued destination to its captured server source, before
  // publication. No generic staged UID/property bypass.
  nsresult BindStagedMessageToQueuedSource(nsMsgKey stagedKey,
                                           uint64_t folderId,
                                           const QueuedSourceIdentity& expected,
                                           const Maybe<uint32_t>& copyOrdinal,
                                           const MessageBodyState& returning);
  nsresult QueueOfflineProtocolFlagMutation(
      const nsACString& databaseSourceId, uint64_t folderId,
      nsMsgKey operationKey, const ServerMessageLocation& expectedSource,
      int32_t protocolMask, bool addFlags);
  nsresult PlanOfflineMoveSource(const OfflineAttempt& expected,
                                 const OfflineMoveSourcePlan& plan,
                                 OfflineAttempt& output);
  nsresult BeginOfflineReplayCommand(const OfflineAttempt& expected,
                                     OfflineReplayCommand command,
                                     OfflineReplayCommandToken& output);
  nsresult RecordOfflineReplayCommand(const OfflineReplayCommandToken& token,
                                      OfflineReplayReceipt receipt,
                                      nsresult actualStatus);
  nsresult SettleOfflineMove(const OfflineAttempt& expected,
                             OfflineMoveSettlement& output);

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
                               uint64_t& attemptId,
                               const MessageBodyState* appendBody = nullptr);
  // COPY selects its actual zero-based stored ordinal; other actions use
  // Nothing. Existing legacy dispatch and mutation fences remain unchanged.
  nsresult BeginOfflineAction(uint64_t folderId, nsMsgKey key, uint32_t action,
                              const Maybe<PendingDestination>& destination,
                              const Maybe<uint32_t>& copyOrdinal,
                              uint64_t& attemptId);
  nsresult GetOfflineAttemptForAction(uint64_t folderId, nsMsgKey key,
                                      uint32_t action,
                                      const Maybe<uint32_t>& copyOrdinal,
                                      OfflineAttempt& output);
  nsresult RecordOfflineCopyAcceptedWithoutUid(const OfflineAttempt& expected);
  nsresult ValidateOfflineCopyAcceptedWithoutUid(
      const OfflineAttempt& expected);
  nsresult GetOfflineAttempt(uint64_t attemptId, OfflineAttempt& output);
  nsresult GetCurrentOfflineAttempt(uint64_t folderId, nsMsgKey key,
                                    OfflineAttempt& output);
  // Call only for a matching tagged APPEND OK without APPENDUID. Recording
  // that fact does not depend on later local body/epoch settlement succeeding.
  nsresult RecordOfflineAppendAcceptedWithoutUid(
      const OfflineAttempt& expected);
  // Local-only retry: retain the operation, body and unresolved destination.
  nsresult ValidateOfflineAppendAcceptedWithoutUid(
      const OfflineAttempt& expected);
  // Read retained accepted custody, not replay or UID-receipt authority.
  // Success: false for exact unbound state, true for a checked private stamp.
  // Failure leaves observed unchanged and never adopts a caller transaction.
  nsresult ReadRetainedAcceptedAppend(const OfflineAttempt& expected,
                                      bool& observed);
  // A later complete checked mailbox observation, never a UID receipt. Bind
  // the existing published member without changing Sent/acceptance history.
  // No message-added/publication callback is emitted for an existing member.
  // Failure preserves mapping and the initially-null owning header slot.
  nsresult AssociateAcceptedAppendObservation(const OfflineAttempt& expected,
                                              uint32_t observedEpoch,
                                              uint32_t observedUid,
                                              ServerMessageLocation& mapping,
                                              Message** liveHeader);
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
  // Cached structural fields own their transaction; an active caller
  // transaction is rejected before writing or changing hot state.
  nsresult SetMessagePriority(nsMsgKey key, nsMsgPriorityValue priority);
  nsresult SetMessageDate(nsMsgKey key, PRTime date);
  // Size setters retain the public/stored uint32 width; overflow is rejected.
  nsresult SetMessageSize(nsMsgKey key, uint64_t size);
  nsresult SetMessageLineCount(nsMsgKey key, uint32_t size);
  nsresult SetMessageOfflineMessageSize(nsMsgKey key, uint64_t size);
  nsresult SetMessageStoreToken(nsMsgKey key, const nsACString& token);
  // Same owned-transaction boundary as priority/date above.
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
  // A property of a message whose row the running import transaction inserts
  // afterwards. Written first, it needs no header lookup and the change log
  // records the new message once, with its row, not again for each property.
  nsresult WriteImportedMessageProperty(nsMsgKey key, const nsACString& name,
                                        const nsACString& value);
  nsresult WriteImportedMessageProperty(nsMsgKey key, const nsACString& name,
                                        uint32_t value);
  nsresult ImportedPropertyStatement(nsMsgKey key, const nsACString& name,
                                     mozIStorageStatement** output);

  // Stored published membership; never opens a stopped/replaced core.
  // Reads a caller transaction without owning it; errors leave exists
  // unchanged.
  nsresult MessageExists(nsMsgKey key, bool& exists);

  // Lowest physical key with this exact Message-ID in an existing folder.
  // Returns 0 if not found; storage errors propagate.
  Result<nsMsgKey, nsresult> FindByMessageId(nsACString const& messageId);

 protected:
  virtual ~MessageDatabase();

 private:
  friend class DatabaseCore;
  friend class FolderDatabase;
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
  nsresult PublishMessageInternal(
      nsMsgKey key, bool notifyLegacy, Message** liveHeader,
      const OnlineTransferDestination* online = nullptr, uint32_t epoch = 0,
      uint32_t uid = 0, ServerMessageLocation* mapping = nullptr);
  nsresult ValidateOnlineTransferDestination(
      const OnlineTransferDestination& expected, uint32_t epoch,
      const Maybe<uint32_t>& uid, bool staged);
  nsresult InsertMessage(uint64_t folderId, const ::RawHdr& header, bool staged,
                         bool notifyLegacy, nsMsgKey* key, Message** liveHeader,
                         RemovedMessage* restoring = nullptr,
                         const FinishedMessageBody* finished = nullptr,
                         OfflineOperationUndo* offline = nullptr,
                         const PendingDestination* cancelMove = nullptr,
                         OfflineOperationUndo* redo = nullptr,
                         const NewsArticleIdentity* news = nullptr,
                         NewsArticleResult* newsOutput = nullptr,
                         nsIMsgDBHdr** newsLiveHeader = nullptr,
                         const Maybe<bool>* newsReadIntent = nullptr);

  nsresult ReadOfflineOperationIdentity(uint64_t folderId, nsMsgKey key,
                                        int64_t& id, int64_t& revision,
                                        Maybe<ServerMessageLocation>& source,
                                        Maybe<uint32_t>* folderEpoch = nullptr);
  nsresult RequireOfflineOperationMutable(int64_t operationId);
  nsresult ReadOfflineImportHold(int64_t operationId, bool& held);
  nsresult RequireOfflineImportDispatchable(int64_t operationId);
  nsresult ValidateQueuedSourceIdentity(const QueuedSourceIdentity& expected);
  nsresult ObserveDestinationEpochInTransaction(
      const QueuedSourceIdentity& expected, uint32_t action,
      const Maybe<uint32_t>& copyOrdinal, const PendingDestination& destination,
      uint32_t observedEpoch);
  nsresult BeginOfflineAttemptInternal(
      uint64_t folderId, nsMsgKey key, uint32_t operation,
      const Maybe<PendingDestination>& destination, uint64_t& attemptId,
      const MessageBodyState* appendBody, const Maybe<uint32_t>* copyOrdinal);
  nsresult RequireOfflineActionDispatchable(int64_t id, int64_t revision,
                                            uint32_t action,
                                            const Maybe<uint32_t>& copyOrdinal);
  nsresult ReadExpectedTransferAttempt(const OfflineAttempt& expected,
                                       OfflineAttempt& actual);
  nsresult ValidateTransferTargetInTransaction(const OfflineAttempt& attempt);
  nsresult ReadExpectedAppendAttempt(const OfflineAttempt& expected,
                                     OfflineAttempt& actual);
  nsresult ValidateAppendTargetInTransaction(const OfflineAttempt& attempt);
  nsresult ReadAcceptedAppendObservationInTransaction(
      const OfflineAttempt& attempt, uint32_t epoch, const Maybe<uint32_t>& uid,
      bool& associated);
  nsresult RequireOfflineUndoQueued(int64_t operationId,
                                    const OfflineOperationData& operation);
  nsresult ReadExpectedReplayAttempt(const OfflineAttempt& expected,
                                     OfflineAttempt& actual);
  nsresult ValidateReplaySource(const OfflineAttempt& attempt, bool& present);
  nsresult ValidateReplayMove(const OfflineAttempt& attempt);
  nsresult OfflineReplayActionsComplete(const OfflineAttempt& move,
                                        bool sourceOnly, bool& complete);
  nsresult FinishOfflineMoveInTransaction(const OfflineAttempt& attempt,
                                          bool removed,
                                          OfflineMoveSettlement& output);
  // Only DatabaseCore's fully checked connected migration unit can establish
  // an operation without a live header. Ordinary callers retain their guard.
  nsresult ImportOfflineOperationInTransaction(
      uint64_t folderId, nsMsgKey key, const OfflineOperationData& input,
      const Maybe<ServerMessageLocation>& source, uint64_t& operationId,
      uint64_t& revision);

  nsresult StoreOfflineOperationInTransaction(
      uint64_t folderId, nsMsgKey key, const OfflineOperationData& input,
      const OfflineOperationUndo* restoring = nullptr,
      bool restoreEmptyCanceledMove = false,
      const Maybe<uint32_t>& canceledDestination = Nothing(),
      bool typedFlagMutation = false);
  nsresult CaptureOfflineOperationInTransaction(
      uint64_t folderId, nsMsgKey key, const nsACString& databaseSourceId,
      OfflineOperationUndo& output, const OfflineUndoCounterpart* counterpart,
      const PendingDestination* extraTarget = nullptr);
  nsresult ValidateOfflineUndoState(const OfflineOperationUndo::Data& saved,
                                    bool allowMissingEmpty = false);
  nsresult CancelOfflineMoveInTransaction(uint64_t folderId, nsMsgKey key,
                                          const PendingDestination& selected,
                                          const OfflineOperationUndo& full,
                                          OfflineOperationUndo& canceled);
  nsresult ReapplyOfflineMoveInTransaction(uint64_t folderId, nsMsgKey key,
                                           const OfflineOperationUndo& redo,
                                           OfflineOperationUndo& nextOffline);
  nsresult RestoreOfflineOperationInTransaction(uint64_t folderId, nsMsgKey key,
                                                const RemovedMessage& removed,
                                                OfflineOperationUndo& offline);
  nsresult ValidatePendingDestination(const PendingDestination& destination,
                                      uint64_t folderId, nsMsgKey key,
                                      bool append, int64_t operationId);
  nsresult BindMessageToServerUidInTransaction(nsMsgKey key, uint64_t folderId,
                                               uint32_t epoch, uint32_t uid,
                                               bool allowStaged);

  nsresult RemoveMessageInternal(
      nsMsgKey key, uint64_t folderId, const nsACString* databaseSourceId,
      MessageRemovalAccounting accounting, RemovedMessage* output = nullptr,
      OfflineOperationUndo* redo = nullptr,
      OfflineOperationUndo* nextOffline = nullptr,
      const OfflineAttempt* settlement = nullptr,
      OfflineMoveSettlement* settledOutput = nullptr);
  nsresult ReadRemovedMessage(nsMsgKey key, RemovedMessage& output);
  nsresult AccountRemovedMessage(nsMsgKey key, uint64_t folderId,
                                 const nsACString& databaseSourceId,
                                 MessageRemovalAccounting accounting);

  nsresult SettleMessageBodyInternal(const MessageBodyState& expected,
                                     const FinishedMessageBody& finished,
                                     const ::RawHdr* parsed,
                                     MessageBodyState& output);
  nsresult ReadMessageBodyState(nsMsgKey key, MessageBodyState& output);
  nsresult ReadFolderRepairState(uint64_t folderId,
                                 const nsACString& databaseSourceId,
                                 FolderRepairSnapshot::Data& output);
  nsresult ReadBodyRelocation(uint64_t folderId,
                              Maybe<FolderBodyRelocation>& output);
  nsresult VerifyBodyRelocationRows(const FolderBodyRelocation& plan);
  nsresult CheckPendingFolderRelocation(uint64_t folderId);
  nsresult CheckPendingMessageRelocation(nsMsgKey key);
  nsresult RequireCurrentOwner() const;
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
  // Uses an owned transaction; errors leave marked keys and hot flags
  // unchanged. Refuses a caller transaction, matching published per-message
  // flag writes.
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

  // Only known folder facades are weakly enrolled. A prepared delivery owns
  // its recipients until completion; ordinary native listeners stay strong.
  void AddFolderMessageListener(PerFolderDatabase* listener);
  void PruneExpiredFolderListeners();
  struct ListenerRegistration;
  void NotifyImportedMessage(Message* message);
  struct QueuedMessageBatch;
  nsresult PrepareMessageBatch(UniquePtr<QueuedMessageBatch>& output);
  nsresult CaptureThreadViewsBeforeInsert(QueuedMessageBatch& batch);
  friend class LiveView;
  nsresult CaptureOrdinaryThreadPeers(nsMsgKey threadId,
                                      QueuedMessageBatch& notification,
                                      MessageThreadBatch& captured);
  nsresult PrepareOrdinaryPublication(QueuedMessageBatch& notification,
                                      MessageThreadBatch& captured);
  // Consume a staged action only after the final published thread is known,
  // before any prepared delivery can observe its thread state.
  nsresult ConsumeProtoThreadFlagsInTransaction(nsMsgKey key, uint64_t folderId,
                                                nsMsgKey threadId);
  nsresult PrepareConversationBatch(nsMsgKey key, bool notifyLegacy,
                                    QueuedMessageBatch& notification,
                                    MessageThreadBatch& captured,
                                    bool consumeProtoThreadFlags = false);
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

  // Read-only passive initialization probe. Some is a known zero membership
  // for unchanged exact file ranges; absent/legacy/changed inputs yield
  // Nothing. Every storage/currentness/type error preserves output.
  nsresult ReadNewsReadSetForInitialization(
      const nsACString& databaseSourceId, uint64_t folderId,
      const nsACString& exactFileSerialization, Maybe<bool>& zeroOverride);
  struct NewsReadSetBinding;
  struct PreparedNewsReadSet;
  nsTArray<UniquePtr<NewsReadSetBinding>> mNewsReadSets;
  nsresult ReadNewsGroupIdentity(const nsACString& sourceId, uint64_t folderId,
                                 NewsGroupIdentity& output, bool create);
  nsresult ReadNewsArticle(nsMsgKey key, Maybe<NewsArticleIdentity>& output);
  nsresult PrepareNewsReadChanges(
      const nsTArray<CapturedMessage>& rows,
      nsTArray<UniquePtr<PreparedNewsReadSet>>& output);
  nsresult PrepareNewsRecipients(PreparedNewsReadSet& prepared,
                                 PerFolderDatabase* replacing = nullptr);
  nsresult WriteNewsReadSets(
      const nsTArray<UniquePtr<PreparedNewsReadSet>>& prepared);
  void InstallNewsReadSets(nsTArray<UniquePtr<PreparedNewsReadSet>>& prepared);

  nsresult SetMessageFlagsInternal(Message* message, uint32_t newFlags);
};

}  // namespace mozilla::mailnews

#endif  // COMM_MAILNEWS_DB_PANORAMA_SRC_MESSAGEDATABASE_H_
