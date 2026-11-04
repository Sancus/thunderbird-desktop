/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_DB_PANORAMA_SRC_LIVEVIEW_H_
#define COMM_MAILNEWS_DB_PANORAMA_SRC_LIVEVIEW_H_

#include "LiveViewFilters.h"
#include "MessageDatabase.h"
#include "mozilla/UniquePtr.h"
#include "js/Context.h"
#include "mozIStorageConnection.h"
#include "mozIStorageStatement.h"
#include "nsCOMPtr.h"
#include "nsILiveView.h"
#include "nsIVariant.h"

using JS::Rooted;

namespace mozilla::mailnews {

class LiveViewBatchCapability;
class CapturedLiveView;
class LiveViewFolderStatusListener;
struct LiveViewPublicStatus;
class LiveViewThreadBatchBuilder;

class LiveView : public nsILiveView, public MessageListener {
 public:
  LiveView();

  NS_DECL_ISUPPORTS
  NS_DECL_NSILIVEVIEW

  // Scoped JS admission is checked by PrepareThreadBatch.
  bool SupportsThreadChanges() const override { return true; }
  nsresult CaptureThreadViewBeforeInsert(
      nsCOMPtr<nsISupports>& output) override;
  nsresult PrepareThreadBatch(const MessageThreadBatch& batch,
                              nsISupports* beforeView,
                              PreparedThreadBatch& prepared) override;
  nsresult PrepareThreadBatch(const MessageThreadBatch& batch,
                              PreparedThreadBatch& prepared) override;
  void DeliverThreadBatch(const PreparedThreadBatch& prepared) override;
  void OnMessageAdded(Message* message) override;
  void OnMessageRemoved(Message* message, uint32_t oldFlags) override;
  void OnMessageFlagsChanged(nsIMsgDBHdr* oldMessage, Message* message,
                             uint32_t oldFlags, uint32_t newFlags) override;
  void OnMessageTagsChanged(nsIMsgDBHdr* oldMessage, Message* message,
                            const nsACString& oldTags,
                            const nsACString& newTags) override;

  void OnMessagePublishedCaptured(const CapturedMessage& after, Message* live,
                                  bool notifyLegacy) override;
  void OnMessageRemovedCaptured(const CapturedMessage& before,
                                Message* live) override;
  void OnMessageFlagsChangedCaptured(const CapturedMessage& before,
                                     const CapturedMessage& after,
                                     nsIMsgDBHdr* oldHeader,
                                     Message* live) override;
  void OnMessageTagsChangedCaptured(const CapturedMessage& before,
                                    const CapturedMessage& after,
                                    nsIMsgDBHdr* oldHeader,
                                    Message* live) override;
  void OnMessageBodyChangedCaptured(const CapturedMessage& before,
                                    const CapturedMessage& after,
                                    nsIMsgDBHdr* oldHeader, Message* live,
                                    const MessageBodyState& oldBody,
                                    const MessageBodyState& newBody) override;

 private:
  virtual ~LiveView();

  friend class SelectMessagesListener;
  friend class LiveViewFolderStatusListener;
  friend class LiveViewThreadBatchBuilder;

  MessageDatabase& MessageDB() const {
    return *DatabaseCore::sInstance->mMessageDatabase;
  }

  mozIStorageConnection* Connection() const {
    return DatabaseCore::sConnection;
  }

  nsresult CaptureQueryView(const CapturedLiveView* context,
                            RefPtr<CapturedLiveView>& output);
  void ResetStatements();
  nsresult RefreshPublicStatus();
  void ClearPublicStatus();
  void OnPublicStatusFlags(uint64_t attachment, uint64_t folderId, nsMsgKey key,
                           uint32_t oldFlags, uint32_t newFlags);
  void OnPublicStatusClosed(uint64_t attachment);
  UniquePtr<LiveViewPublicStatus> mPublicStatus;
  nsCString mPublicFlagsSQL = "flags"_ns;
  nsCString GetSQLClause();
  nsCString SelectSQL();
  nsCString SelectGroupSQL();
  nsresult MatchesCaptured(const CapturedMessage& message, bool& matches);
  void InvalidateCapturedConsumer(nsILiveViewListener* listener,
                                  LiveViewBatchCapability* capability,
                                  uint64_t attachment);
  enum class CapturedChange { Added, Removed, Flags, Tags };
  void NotifyCaptured(const CapturedMessage* before,
                      const CapturedMessage* after, CapturedChange change);
  void PrepareStatement(mozIStorageStatement* aStatement);

  // Are we interested in this message?
  bool Matches(nsIMsgDBHdr* aMessage, uint64_t aFolderId);
  // Should we fire a notification to the listener?
  bool CheckIfChangeMatches(nsIMsgDBHdr* oldMessage, Message* newMessage);

  nsAutoCString mClause;
  nsTArray<RefPtr<nsIVariant>> mParams;
  LiveViewFilter* mFolderFilter = nullptr;

  nsILiveView::SortColumn mSortColumn;
  bool mSortDescending;
  nsILiveView::Grouping mGrouping;

  nsCOMPtr<mozIStorageStatement> mCountStmt;
  nsCOMPtr<mozIStorageStatement> mCountUnreadStmt;
  nsCOMPtr<mozIStorageStatement> mSelectStmt;
  nsCOMPtr<mozIStorageStatement> mSelectGroupStmt;
  nsCOMPtr<mozIStoragePendingStatement> mPendingStmt;

  // The one and only listener for this live view, if set.
  nsCOMPtr<nsILiveViewListener> mListener;
  RefPtr<LiveViewBatchCapability> mBatchCapability;
  RefPtr<CapturedLiveView> mCountQuery;
  RefPtr<CapturedLiveView> mMappedQuery;
  uint64_t mAttachmentGeneration = 0;
  uint64_t mQueryGeneration = 0;
  uint64_t mBatchDeliveryGeneration = 0;
  uint64_t mConfigurationGeneration = 0;
};

void CreateJSMessage(uint64_t id, uint64_t folderId, const char* messageId,
                     PRTime date, const char* sender, const char* recipients,
                     const char* subject, uint64_t flags, const char* tags,
                     uint64_t threadId, uint64_t threadParent, JSContext* aCx,
                     Rooted<JSObject*>&);
void CreateJSMessage(Message* aMessage, JSContext* aCx, Rooted<JSObject*>&);

}  // namespace mozilla::mailnews

#endif  // COMM_MAILNEWS_DB_PANORAMA_SRC_LIVEVIEW_H_
