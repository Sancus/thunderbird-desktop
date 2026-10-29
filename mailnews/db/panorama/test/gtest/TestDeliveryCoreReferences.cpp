/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <functional>
#include <utility>

#include "DatabaseCore.h"
#include "FolderDatabase.h"
#ifdef XP_WIN
#  include "MigrationFileSystem.h"
#endif
#include "Message.h"
#include "MessageDatabase.h"
#include "gtest/gtest.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/ResultExtensions.h"
#include "mozilla/Try.h"
#include "mozilla/SpinEventLoopUntil.h"
#include "mozIStorageConnection.h"
#include "mozIStorageFunction.h"
#include "mozIStorageProgressHandler.h"
#include "mozIStorageService.h"
#include "mozIStorageStatement.h"
#include "mozIStorageValueArray.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "nsIEventTarget.h"
#include "nsIFile.h"
#include "nsLocalFile.h"
#include "nsIInterfaceRequestorUtils.h"
#include "nsIMsgDatabase.h"
#include "nsIMsgOfflineImapOperation.h"
#include "nsMsgMessageFlags.h"
#include "nsImapCore.h"
#include "nsIProperties.h"
#include "nsIVariant.h"
#include "nsComponentManagerUtils.h"
#include "nsServiceManagerUtils.h"
#include "nsThreadUtils.h"

namespace mozilla::mailnews {
namespace {

// Captured unversioned layout at 531bc469, without reconstructing lost tokens.
constexpr auto kOldSchema =
    "CREATE TABLE folders(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES "
    "folders(id), "
    "ordinal INTEGER DEFAULT NULL, name TEXT, flags INTEGER DEFAULT 0, "
    "UNIQUE(parent,name));"
    "CREATE TABLE folder_properties(id INTEGER REFERENCES folders(id), name "
    "TEXT, value ANY, PRIMARY KEY(id,name));"
    "CREATE TABLE messages(id INTEGER PRIMARY KEY, folderId INTEGER REFERENCES "
    "folders(id), "
    "threadId INTEGER REFERENCES messages(id), threadParent INTEGER REFERENCES "
    "messages(id), "
    "messageId TEXT, date INTEGER, sender TEXT, recipients TEXT, ccList TEXT, "
    "bccList TEXT, "
    "subject TEXT, flags INTEGER, tags TEXT, priority INTEGER);"
    "CREATE TABLE message_properties(id INTEGER REFERENCES messages(id), name "
    "TEXT, value ANY, PRIMARY KEY(id,name));"
    "CREATE TABLE virtualFolder_folders(virtualFolderId INTEGER REFERENCES "
    "folders(id), searchFolderId INTEGER REFERENCES folders(id));"
    "CREATE TABLE search_folder_hits(folder_id INTEGER REFERENCES folders(id), message_id INTEGER REFERENCES messages(id), PRIMARY KEY(folder_id,message_id));"_ns;

class FaultWitness final : public mozIStorageFunction {
 public:
  NS_DECL_ISUPPORTS
  uint32_t mCalls = 0;
  int64_t mLastKey = 0;
  NS_IMETHOD OnFunctionCall(mozIStorageValueArray* args,
                            nsIVariant** result) override {
    ++mCalls;
    MOZ_TRY(args->GetInt64(0, &mLastKey));
    nsCOMPtr<nsIWritableVariant> value =
        do_CreateInstance("@mozilla.org/variant;1");
    NS_ENSURE_STATE(value);
    nsresult rv = value->SetAsInt32(0);
    NS_ENSURE_SUCCESS(rv, rv);
    nsCOMPtr<nsIVariant> returned = value;
    returned.forget(result);
    return NS_OK;
  }

 private:
  ~FaultWitness() = default;
};
NS_IMPL_ISUPPORTS(FaultWitness, mozIStorageFunction)

class AddedObserver final : public MessageListener {
 public:
  NS_DECL_ISUPPORTS
  explicit AddedObserver(std::function<void(Message*)> added)
      : mAdded(std::move(added)) {}
  void OnMessageAdded(Message* message) override { mAdded(message); }
  void OnMessageRemoved(Message*, uint32_t) override {}
  void OnMessageFlagsChanged(nsIMsgDBHdr*, Message*, uint32_t,
                             uint32_t) override {}
  void OnMessageTagsChanged(nsIMsgDBHdr*, Message*, const nsACString&,
                            const nsACString&) override {}

 private:
  ~AddedObserver() = default;
  std::function<void(Message*)> mAdded;
};
NS_IMPL_ISUPPORTS(AddedObserver, nsISupports)

class ThreadViewBefore final : public nsISupports {
 public:
  NS_DECL_ISUPPORTS
  nsTArray<CapturedMessage> rows;

 private:
  ~ThreadViewBefore() = default;
};
NS_IMPL_ISUPPORTS(ThreadViewBefore, nsISupports)

class ThreadQueueObserver final : public MessageListener {
 public:
  NS_DECL_ISUPPORTS
  using MessageListener::PrepareThreadBatch;
  std::function<void(char, const CapturedMessage&, const CapturedMessage&,
                     Message*, bool)>
      action;
  std::function<nsresult(nsCOMPtr<nsISupports>&)> captureView;
  std::function<nsresult(const MessageThreadBatch&, nsISupports*,
                         PreparedThreadBatch&)>
      prepareView;
  nsresult CaptureThreadViewBeforeInsert(
      nsCOMPtr<nsISupports>& output) override {
    return captureView ? captureView(output) : NS_OK;
  }
  nsresult PrepareThreadBatch(const MessageThreadBatch& batch,
                              nsISupports* beforeView,
                              PreparedThreadBatch& output) override {
    return prepareView ? prepareView(batch, beforeView, output)
                       : MessageListener::PrepareThreadBatch(batch, output);
  }
  MessageBodyState oldBody, newBody;
  uint32_t ordinary = 0;
  bool SupportsThreadChanges() const override { return true; }
  void OnMessageAdded(Message*) override { ++ordinary; }
  void OnMessageRemoved(Message*, uint32_t) override { ++ordinary; }
  void OnMessageFlagsChanged(nsIMsgDBHdr*, Message*, uint32_t,
                             uint32_t) override {
    ++ordinary;
  }
  void OnMessageTagsChanged(nsIMsgDBHdr*, Message*, const nsACString&,
                            const nsACString&) override {
    ++ordinary;
  }
  void OnMessageThreadChanged(const CapturedMessage& before,
                              const CapturedMessage& after,
                              Message* live) override {
    if (action) {
      action('T', before, after, live, true);
    }
  }
  void OnMessagePublishedCaptured(const CapturedMessage& after, Message* live,
                                  bool notify) override {
    if (action) {
      action('P', after, after, live, notify);
    }
  }
  void OnMessageRemovedCaptured(const CapturedMessage& before,
                                Message* live) override {
    if (action) {
      action('R', before, before, live, true);
    }
  }
  void OnMessageFlagsChangedCaptured(const CapturedMessage& before,
                                     const CapturedMessage& after, nsIMsgDBHdr*,
                                     Message* live) override {
    if (action) {
      action('F', before, after, live, true);
    }
  }
  void OnMessageTagsChangedCaptured(const CapturedMessage& before,
                                    const CapturedMessage& after, nsIMsgDBHdr*,
                                    Message* live) override {
    if (action) {
      action('G', before, after, live, true);
    }
  }
  void OnMessageBodyChangedCaptured(const CapturedMessage& before,
                                    const CapturedMessage& after, nsIMsgDBHdr*,
                                    Message* live,
                                    const MessageBodyState& oldValue,
                                    const MessageBodyState& newValue) override {
    oldBody = oldValue;
    newBody = newValue;
    if (action) {
      action('B', before, after, live, true);
    }
  }

 private:
  ~ThreadQueueObserver() = default;
};
NS_IMPL_ISUPPORTS(ThreadQueueObserver, nsISupports)

}  // namespace

class DeliveryCoreReferences : public testing::Test {
 protected:
  void SetUp() override {
    mDirectories = do_GetService(NS_DIRECTORY_SERVICE_CONTRACTID);
    ASSERT_TRUE(mDirectories);
    nsCOMPtr<nsIFile> base;
    if (NS_SUCCEEDED(mDirectories->Get(NS_APP_USER_PROFILE_50_DIR,
                                       NS_GET_IID(nsIFile),
                                       getter_AddRefs(mOldProfile)))) {
      base = mOldProfile;
    } else {
      mOldProfile = nullptr;
      ASSERT_EQ(NS_OK,
                NS_GetSpecialDirectory(NS_OS_TEMP_DIR, getter_AddRefs(base)));
    }
    ASSERT_EQ(NS_OK, base->Clone(getter_AddRefs(mProfile)));
    ASSERT_EQ(NS_OK, mProfile->Append(u"delivery-core-references"_ns));
    ASSERT_EQ(NS_OK, mProfile->CreateUnique(nsIFile::DIRECTORY_TYPE, 0700));
    mProfileCreated = true;
    mRestoreProfileCache =
        NS_SUCCEEDED(mDirectories->Undefine(NS_APP_USER_PROFILE_50_DIR));
    mDirectoryChanged = mRestoreProfileCache;
    ASSERT_EQ(NS_OK, mDirectories->Set(NS_APP_USER_PROFILE_50_DIR, mProfile));
    mDirectoryChanged = true;
    ASSERT_EQ(NS_OK, mProfile->Clone(getter_AddRefs(mFile)));
    ASSERT_EQ(NS_OK, mFile->Append(u"panorama.sqlite"_ns));
    mStorage = do_GetService("@mozilla.org/storage/service;1");
    ASSERT_TRUE(mStorage);
  }

  void TearDown() override {
    Stop();
    if (mDirectoryChanged) {
      // An uncached provider is restored by removing only our override.
      (void)mDirectories->Undefine(NS_APP_USER_PROFILE_50_DIR);
      if (mRestoreProfileCache && mOldProfile) {
        EXPECT_EQ(NS_OK,
                  mDirectories->Set(NS_APP_USER_PROFILE_50_DIR, mOldProfile));
      }
    }
    if (mProfileCreated) {
      EXPECT_EQ(NS_OK, mProfile->Remove(true));
    }
  }

  mozIStorageConnection* Connection() const {
    return DatabaseCore::sConnection.get();
  }

  nsresult Open(mozIStorageConnection** connection) {
    return mStorage->OpenUnsharedDatabase(
        mFile, mozIStorageService::CONNECTION_DEFAULT, connection);
  }

  nsresult Start() {
    // This native fixture selects the concrete Panorama implementation
    // directly.
    mCore = DatabaseCore::GetInstanceForService();
    auto cleanup = MakeScopeExit([&] { Stop(); });
    nsresult rv = mCore->Startup();
    mConnection = Connection();
    NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(mConnection, NS_ERROR_UNEXPECTED);
    nsCOMPtr<nsIFile> actualFile;
    MOZ_TRY(mConnection->GetDatabaseFile(getter_AddRefs(actualFile)));
    bool sameFile;
    MOZ_TRY(mFile->Equals(actualFile, &sameFile));
    NS_ENSURE_TRUE(sameFile, NS_ERROR_UNEXPECTED);
    if (!mFolderId) {
      uint64_t root;
      MOZ_TRY(mCore->FolderDB().InsertRoot("delivery-references"_ns, &root));
      MOZ_TRY(mCore->FolderDB().InsertFolder(root, "Inbox"_ns, &mFolderId));
    }
    cleanup.release();
    return NS_OK;
  }

  void Stop() {
    if (!mCore) {
      return;
    }
    nsCOMPtr<mozIStorageConnection> connection =
        mConnection ? mConnection.get() : Connection();
    nsCOMPtr<nsIEventTarget> target = do_GetInterface(connection);
    EXPECT_EQ(NS_OK, mCore->Observe(nullptr, "profile-before-change", nullptr));
    mConnection = nullptr;
    mCore = nullptr;
    if (!target) {
      return;
    }
    bool closed = false;
    // Observe queues AsyncClose before this barrier, with no intervening spin.
    ASSERT_EQ(
        NS_OK,
        target->Dispatch(
            NS_NewRunnableFunction(
                "ReferencesCloseBarrier",
                [&closed] {
                  MOZ_ALWAYS_SUCCEEDS(
                      NS_DispatchToMainThread(NS_NewRunnableFunction(
                          "ReferencesClosed", [&closed] { closed = true; })));
                }),
            NS_DISPATCH_NORMAL));
    EXPECT_TRUE(SpinEventLoopUntil("ReferencesClosed"_ns,
                                   [&closed] { return closed; }));
  }

  void CheckStagedParentWithGroupingOff() {
    ASSERT_EQ(NS_OK, Start());
    auto& db = mCore->MessageDB();
    ASSERT_FALSE(db.mConversationGroupingEnabled);
    nsMsgKey root, parent, staged;
    ASSERT_EQ(NS_OK, Add("default-root"_ns, {}, root));
    ASSERT_EQ(NS_OK, Add("default-parent"_ns, {"default-root"_ns}, parent));
    ASSERT_NE(root, parent);
    ASSERT_EQ(NS_OK,
              db.SetMessageFlag(parent, nsMsgMessageFlags::Ignored, true));
    CapturedMessage storedParent;
    ASSERT_EQ(NS_OK, db.CaptureMessage(parent, storedParent));
    ASSERT_EQ(root, storedParent.threadId);
    ASSERT_EQ(nsMsgMessageFlags::Ignored, storedParent.flags);

    uint32_t events = 0;
    RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
    observer->action = [&](char, const auto&, const auto&, Message*, bool) {
      ++events;
    };
    db.AddMessageListener(observer);
    auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
    RawHdr raw;
    raw.messageId = "default-staged"_ns;
    raw.references = {"default-parent"_ns};
    ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
    Maybe<CapturedMessage> state;
    ASSERT_EQ(NS_OK, db.CaptureHeaderState(staged, state));
    ASSERT_TRUE(state);
    EXPECT_EQ(mFolderId, state->folderId);
    EXPECT_EQ(root, state->threadId);
    EXPECT_EQ(parent, state->threadParent);
    EXPECT_EQ(0u, state->flags);
    nsTArray<nsCString> references;
    ASSERT_EQ(NS_OK, db.GetMessageReferences(staged, references));
    EXPECT_EQ((nsTArray<nsCString>{"default-parent"_ns}), references);
    bool published = true;
    ASSERT_EQ(NS_OK, db.MessageExists(staged, published));
    EXPECT_FALSE(published);
    nsTArray<nsMsgKey> keys;
    ASSERT_EQ(NS_OK, db.ListAllKeys(mFolderId, keys));
    keys.Sort();
    EXPECT_EQ((nsTArray<nsMsgKey>{root, parent}), keys);
    ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, keys));
    EXPECT_EQ((nsTArray<nsMsgKey>{staged}), keys);
    uint64_t count;
    ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
    EXPECT_EQ(2u, count);
    ASSERT_EQ(NS_OK, db.GetNumUnread(mFolderId, &count));
    EXPECT_EQ(2u, count);
    EXPECT_EQ(0u, events);
    EXPECT_EQ(0u, observer->ordinary);
  }

  nsresult StartGrouping() {
    MOZ_TRY(Start());
    mCore->MessageDB().mConversationGroupingEnabled = true;
    return NS_OK;
  }

  void CheckGroupingRollback(bool staged) {
    ASSERT_EQ(NS_OK, StartGrouping());
    auto& db = mCore->MessageDB();
    nsMsgKey child, control;
    ASSERT_EQ(NS_OK, AddAt(mFolderId, "rollback-child"_ns,
                           {"rollback-parent"_ns}, child));
    ASSERT_EQ(NS_OK, AddAt(mFolderId, "control"_ns, {}, control));
    ASSERT_EQ(NS_OK, db.SetMessageFlags(child, nsMsgMessageFlags::Marked));
    ASSERT_EQ(NS_OK, db.SetMessageTags(child, "old tags"_ns));
    ASSERT_EQ(NS_OK,
              db.SetMessageProperty(control, "control"_ns, "retained"_ns));
    RefPtr<Message> hot = new Message(child), sentinel = new Message(control);
    nsMsgKey oldThread;
    ASSERT_EQ(NS_OK, hot->GetThreadId(&oldThread));
    RawHdr parent;
    parent.messageId = "rollback-parent"_ns;
    parent.subject = "complete parent"_ns;
    parent.storeToken = Some(nsCString("finished"_ns));
    parent.messageSize = Some(42u);
    parent.extras.AppendElement(RawHdr::kv{"exact"_ns, "00042"_ns});
    nsMsgKey pending = nsMsgKey_None;
    if (staged) {
      ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, parent, &pending));
    }
    RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
    uint32_t calls = 0;
    Message* callbackPublication = nullptr;
    observer->action = [&](char kind, const auto&, const auto&, Message* live,
                           bool notify) {
      ++calls;
      if (kind == 'P') {
        callbackPublication = live;
        EXPECT_FALSE(notify);
        nsCString token, value;
        uint32_t size;
        EXPECT_EQ(NS_OK, live->GetStoreToken(token));
        EXPECT_EQ("finished"_ns, token);
        EXPECT_EQ(NS_OK, live->GetMessageSize(&size));
        EXPECT_EQ(42u, size);
        EXPECT_EQ(NS_OK, db.GetMessageProperty(live->Key(), "exact"_ns, value));
        EXPECT_EQ("00042"_ns, value);
      }
    };
    db.AddMessageListener(observer);
    auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
    RefPtr<FaultWitness> witness = new FaultWitness();
    ASSERT_EQ(NS_OK,
              mConnection->CreateFunction("thread_fault"_ns, 1, witness));
    // A missing late-parent update makes this injection unreached, not a
    // rollback failure.
    ASSERT_EQ(
        NS_OK,
        mConnection->ExecuteSimpleSQL(
            "CREATE TEMP TRIGGER fail_thread BEFORE UPDATE OF "
            "threadId,threadParent ON messages "
            "WHEN OLD.messageId='rollback-child' AND "
            "NEW.threadId<>OLD.threadId "
            "BEGIN SELECT thread_fault(OLD.id); SELECT RAISE(ABORT,'derived fault'); END"_ns));
    auto drop = MakeScopeExit([&] {
      EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "DROP TRIGGER IF EXISTS fail_thread"_ns));
      EXPECT_EQ(NS_OK, mConnection->RemoveFunction("thread_fault"_ns));
    });
    nsMsgKey key = nsMsgKey_None;
    Message* output = sentinel.get();
    nsresult rv = staged
                      ? db.PublishMessage(pending, false, &output)
                      : db.AddMessage(mFolderId, parent, false, &key, &output);
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, rv);
    EXPECT_EQ(nsMsgKey_None, key);
    EXPECT_EQ(sentinel.get(), output);
    if (output != sentinel.get() && output) {
      NS_RELEASE(output);
    }
    EXPECT_EQ(1u, witness->mCalls);
    EXPECT_EQ(int64_t(child), witness->mLastKey);
    EXPECT_EQ(0u, calls);
    bool active;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    CapturedMessage stored;
    ASSERT_EQ(NS_OK, db.CaptureMessage(child, stored));
    EXPECT_EQ(oldThread, stored.threadId);
    EXPECT_EQ(0u, stored.threadParent);
    EXPECT_EQ(nsMsgMessageFlags::Marked, stored.flags);
    EXPECT_EQ("old tags"_ns, stored.tags);
    nsMsgKey cachedThread;
    ASSERT_EQ(NS_OK, hot->GetThreadId(&cachedThread));
    EXPECT_EQ(oldThread, cachedThread);
    nsCString value;
    ASSERT_EQ(NS_OK, db.GetMessageProperty(control, "control"_ns, value));
    EXPECT_EQ("retained"_ns, value);
    if (staged) {
      bool exists;
      ASSERT_EQ(NS_OK, db.MessageExists(pending, exists));
      EXPECT_FALSE(exists);
      nsTArray<nsMsgKey> rows;
      ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, rows));
      EXPECT_EQ((nsTArray<nsMsgKey>{pending}), rows);
    }
    ASSERT_EQ(NS_OK,
              mConnection->ExecuteSimpleSQL("DROP TRIGGER fail_thread"_ns));
    RefPtr<Message> published;
    if (staged) {
      key = pending;
      ASSERT_EQ(NS_OK,
                db.PublishMessage(pending, false, getter_AddRefs(published)));
    } else {
      ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, parent, false, &key,
                                     getter_AddRefs(published)));
    }
    EXPECT_EQ(2u, calls);
    EXPECT_EQ(published.get(), callbackPublication);
    ASSERT_EQ(NS_OK, hot->GetThreadId(&cachedThread));
    EXPECT_EQ(key, cachedThread);
    nsMsgKey parentKey;
    ASSERT_EQ(NS_OK, hot->GetThreadParent(&parentKey));
    EXPECT_EQ(key, parentKey);
    EXPECT_EQ(0u, observer->ordinary);
  }

  void CheckPreinsertViewCapture(bool staged, bool failRead) {
    ASSERT_EQ(NS_OK, StartGrouping());
    auto& db = mCore->MessageDB();
    nsMsgKey child, control;
    ASSERT_EQ(NS_OK,
              Add("before-view-child"_ns, {"before-view-parent"_ns}, child));
    ASSERT_EQ(NS_OK, Add("before-view-control"_ns, {}, control));
    CapturedMessage oldChild;
    ASSERT_EQ(NS_OK, db.CaptureMessage(child, oldChild));
    RawHdr raw;
    raw.messageId = "before-view-parent"_ns;
    nsMsgKey pending = nsMsgKey_None;
    if (staged) {
      ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &pending));
    }
    RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
    uint32_t captures = 0, preparations = 0, publications = 0;
    observer->captureView = [&](nsCOMPtr<nsISupports>& output) -> nsresult {
      ++captures;
      bool active;
      MOZ_TRY(mConnection->GetTransactionInProgress(&active));
      EXPECT_TRUE(active);
      nsCOMPtr<mozIStorageStatement> stmt;
      MOZ_TRY(mConnection->CreateStatement(
          failRead ? "SELECT abs(-9223372036854775808) FROM messages"_ns
                   : "SELECT id FROM messages ORDER BY id"_ns,
          getter_AddRefs(stmt)));
      RefPtr<ThreadViewBefore> before = new ThreadViewBefore();
      while (true) {
        bool more;
        MOZ_TRY(stmt->ExecuteStep(&more));
        if (!more) break;
        int64_t key;
        MOZ_TRY(stmt->GetInt64(0, &key));
        CapturedMessage row;
        MOZ_TRY(db.CaptureMessage(key, row));
        before->rows.AppendElement(std::move(row));
      }
      NS_ENSURE_TRUE(before->rows.Length() == 2, NS_ERROR_UNEXPECTED);
      EXPECT_EQ(child, before->rows[0].id);
      EXPECT_EQ(control, before->rows[1].id);
      EXPECT_EQ(oldChild.threadId, before->rows[0].threadId);
      EXPECT_EQ(0u, before->rows[0].threadParent);
      output = before;
      return NS_OK;
    };
    observer->prepareView = [&](const MessageThreadBatch& batch,
                                nsISupports* ownedBefore,
                                PreparedThreadBatch& output) -> nsresult {
      ++preparations;
      NS_ENSURE_TRUE(ownedBefore, NS_ERROR_UNEXPECTED);
      auto* before = static_cast<ThreadViewBefore*>(ownedBefore);
      NS_ENSURE_TRUE(before->rows.Length() == 2, NS_ERROR_UNEXPECTED);
      EXPECT_EQ(oldChild.threadId, before->rows[0].threadId);
      EXPECT_EQ(0u, before->rows[0].threadParent);
      CapturedMessage changed;
      MOZ_TRY(db.CaptureMessage(child, changed));
      EXPECT_EQ(batch.publicationKey, changed.threadId);
      EXPECT_EQ(batch.publicationKey, changed.threadParent);
      EXPECT_EQ(0u, publications);
      return observer->MessageListener::PrepareThreadBatch(batch, output);
    };
    observer->action = [&](char kind, const auto&, const auto&, Message*,
                           bool) {
      if (kind == 'P') ++publications;
    };
    db.AddMessageListener(observer);
    auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
    nsMsgKey output = nsMsgKey_None;
    RefPtr<Message> sentinel = new Message(control);
    Message* live = sentinel.get();
    nsresult rv = staged ? db.PublishMessage(pending, true, &live)
                         : db.AddMessage(mFolderId, raw, true, &output, &live);
    EXPECT_EQ(failRead ? NS_ERROR_FAILURE : NS_OK, rv);
    EXPECT_EQ(1u, captures);
    EXPECT_EQ(failRead ? 0u : 1u, preparations);
    EXPECT_EQ(failRead ? 0u : 1u, publications);
    if (failRead) {
      EXPECT_EQ(nsMsgKey_None, output);
      EXPECT_EQ(sentinel.get(), live);
      CapturedMessage unchanged;
      ASSERT_EQ(NS_OK, db.CaptureMessage(child, unchanged));
      EXPECT_EQ(oldChild.threadId, unchanged.threadId);
      EXPECT_EQ(oldChild.threadParent, unchanged.threadParent);
      if (staged) {
        nsTArray<nsMsgKey> keys;
        ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, keys));
        EXPECT_EQ((nsTArray<nsMsgKey>{pending}), keys);
      }
      uint64_t count;
      ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
      EXPECT_EQ(2u, count);
    }
    if (live && live != sentinel.get()) NS_RELEASE(live);
    bool active;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
  }

  void CheckEqualThreadWordMerge(uint32_t word) {
    ASSERT_EQ(NS_OK, StartGrouping());
    auto& db = mCore->MessageDB();
    nsMsgKey first, second, joined;
    ASSERT_EQ(NS_OK, Add("word-equal-a"_ns, {}, first));
    ASSERT_EQ(NS_OK, Add("word-equal-b"_ns, {}, second));
    CapturedMessage a, b;
    ASSERT_EQ(NS_OK, db.CaptureMessage(first, a));
    ASSERT_EQ(NS_OK, db.CaptureMessage(second, b));
    ASSERT_NE(a.threadId, b.threadId);
    ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, a.threadId, word));
    ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, b.threadId, word));
    ASSERT_EQ(NS_OK, Add("word-equal-join"_ns,
                         {"word-equal-a"_ns, "word-equal-b"_ns}, joined));
    CapturedMessage currentA, currentB;
    ASSERT_EQ(NS_OK, db.CaptureMessage(first, currentA));
    ASSERT_EQ(NS_OK, db.CaptureMessage(second, currentB));
    EXPECT_EQ(currentA.threadId, currentB.threadId);
    uint32_t stored = 7;
    ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, currentA.threadId, stored));
    EXPECT_EQ(word, stored);
    stored = 7;
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.GetThreadFlags(mFolderId, b.threadId, stored));
    EXPECT_EQ(7u, stored);
    nsTArray<nsCString> refs;
    ASSERT_EQ(NS_OK, Stored(joined, refs));
    EXPECT_EQ((nsTArray<nsCString>{"word-equal-a"_ns, "word-equal-b"_ns}),
              refs);
  }

  void CheckThreadWordConflict(bool staged, uint32_t firstWord,
                               uint32_t secondWord) {
    ASSERT_EQ(NS_OK, StartGrouping());
    auto& db = mCore->MessageDB();
    nsMsgKey first, second, control;
    ASSERT_EQ(NS_OK, Add("word-conflict-a"_ns, {}, first));
    ASSERT_EQ(NS_OK, Add("word-conflict-b"_ns, {}, second));
    ASSERT_EQ(NS_OK, Add("word-conflict-control"_ns, {}, control));
    CapturedMessage a, b;
    ASSERT_EQ(NS_OK, db.CaptureMessage(first, a));
    ASSERT_EQ(NS_OK, db.CaptureMessage(second, b));
    ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, a.threadId, firstWord));
    ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, b.threadId, secondWord));
    RefPtr<Message> hotA = new Message(first), hotB = new Message(second);
    nsMsgKey hotThread;
    ASSERT_EQ(NS_OK, hotA->GetThreadId(&hotThread));
    ASSERT_EQ(NS_OK, hotB->GetThreadId(&hotThread));
    RawHdr raw;
    raw.messageId = "word-conflict-join"_ns;
    raw.references = {"word-conflict-a"_ns, "word-conflict-b"_ns};
    raw.storeToken = Some(nsCString("retained-body"_ns));
    raw.extras.AppendElement(RawHdr::kv{"exact"_ns, "00042"_ns});
    nsMsgKey pending;
    if (staged) ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &pending));
    RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
    uint32_t calls = 0;
    observer->action = [&](char, const auto&, const auto&, Message*, bool) {
      ++calls;
    };
    db.AddMessageListener(observer);
    auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
    nsMsgKey output = nsMsgKey_None;
    RefPtr<Message> sentinel = new Message(control);
    Message* live = sentinel.get();
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              staged ? db.PublishMessage(pending, true, &live)
                     : db.AddMessage(mFolderId, raw, true, &output, &live));
    EXPECT_EQ(nsMsgKey_None, output);
    EXPECT_EQ(sentinel.get(), live);
    if (live && live != sentinel.get()) NS_RELEASE(live);
    EXPECT_EQ(0u, calls);
    for (const auto& old : {a, b}) {
      CapturedMessage current;
      ASSERT_EQ(NS_OK, db.CaptureMessage(old.id, current));
      EXPECT_EQ(old.threadId, current.threadId);
      EXPECT_EQ(old.threadParent, current.threadParent);
    }
    ASSERT_EQ(NS_OK, hotA->GetThreadId(&hotThread));
    EXPECT_EQ(a.threadId, hotThread);
    ASSERT_EQ(NS_OK, hotB->GetThreadId(&hotThread));
    EXPECT_EQ(b.threadId, hotThread);
    uint32_t word;
    ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, a.threadId, word));
    EXPECT_EQ(firstWord, word);
    ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, b.threadId, word));
    EXPECT_EQ(secondWord, word);
    uint64_t count;
    ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
    EXPECT_EQ(3u, count);
    if (staged) {
      nsTArray<nsCString> refs;
      ASSERT_EQ(NS_OK, db.GetMessageReferences(pending, refs));
      EXPECT_EQ(
          (nsTArray<nsCString>{"word-conflict-a"_ns, "word-conflict-b"_ns}),
          refs);
      nsCString exact;
      ASSERT_EQ(NS_OK, db.GetMessageProperty(pending, "exact"_ns, exact));
      EXPECT_EQ("00042"_ns, exact);
      ASSERT_EQ(NS_OK, db.GetMessageStoreToken(pending, exact));
      EXPECT_EQ("retained-body"_ns, exact);
    }
    bool active;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
  }

  void CheckQueuedChangeRollback(bool tags) {
    ASSERT_EQ(NS_OK, Start());
    auto& db = mCore->MessageDB();
    nsMsgKey key, control;
    ASSERT_EQ(NS_OK, Add("queued-change"_ns, {}, key));
    ASSERT_EQ(NS_OK, Add("queued-control"_ns, {}, control));
    ASSERT_EQ(NS_OK, db.SetMessageTags(key, "old"_ns));
    RefPtr<Message> hot = new Message(key);
    uint32_t flags;
    ASSERT_EQ(NS_OK, hot->GetFlags(&flags));
    EXPECT_EQ(0u, flags);
    RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
    uint32_t calls = 0;
    observer->action = [&](char, const auto&, const auto&, Message*, bool) {
      ++calls;
    };
    db.AddMessageListener(observer);
    auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
    RefPtr<FaultWitness> witness = new FaultWitness();
    ASSERT_EQ(NS_OK,
              mConnection->CreateFunction("change_fault"_ns, 1, witness));
    nsAutoCString sql("CREATE TEMP TRIGGER fail_change BEFORE UPDATE OF ");
    sql.Append(tags ? "tags" : "flags");
    sql.AppendLiteral(" ON messages WHEN OLD.id=");
    sql.AppendInt(key);
    sql.AppendLiteral(
        " BEGIN SELECT change_fault(OLD.id); SELECT RAISE(ABORT,'change "
        "fault'); END");
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    auto cleanup = MakeScopeExit([&] {
      EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "DROP TRIGGER IF EXISTS fail_change"_ns));
      EXPECT_EQ(NS_OK, mConnection->RemoveFunction("change_fault"_ns));
    });
    EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
              tags ? db.SetMessageTags(key, "new"_ns)
                   : db.SetMessageFlags(key, nsMsgMessageFlags::Read));
    EXPECT_EQ(1u, witness->mCalls);
    EXPECT_EQ(int64_t(key), witness->mLastKey);
    EXPECT_EQ(0u, calls);
    bool active;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    CapturedMessage row;
    ASSERT_EQ(NS_OK, db.CaptureMessage(key, row));
    EXPECT_EQ(0u, row.flags);
    EXPECT_EQ("old"_ns, row.tags);
    ASSERT_EQ(NS_OK, hot->GetFlags(&flags));
    EXPECT_EQ(0u, flags);
    nsCString text;
    ASSERT_EQ(NS_OK, hot->GetStringProperty("keywords", text));
    EXPECT_EQ("old"_ns, text);
    ASSERT_EQ(NS_OK, db.CaptureMessage(control, row));
    EXPECT_EQ("queued-control"_ns, row.messageId);
    EXPECT_EQ(0u, row.flags);
    ASSERT_EQ(NS_OK,
              mConnection->ExecuteSimpleSQL("DROP TRIGGER fail_change"_ns));
    ASSERT_EQ(NS_OK, tags ? db.SetMessageTags(key, "new"_ns)
                          : db.SetMessageFlags(key, nsMsgMessageFlags::Read));
    EXPECT_EQ(1u, calls);
    ASSERT_EQ(NS_OK, db.CaptureMessage(key, row));
    EXPECT_EQ(tags ? 0u : nsMsgMessageFlags::Read, row.flags);
    EXPECT_EQ(tags ? "new"_ns : "old"_ns, row.tags);
  }

  nsresult AddAt(uint64_t folderId, const nsACString& messageId,
                 const nsTArray<nsCString>& references, nsMsgKey& key) {
    RawHdr raw;
    raw.messageId = messageId;
    raw.references = references.Clone();
    raw.date = 1700000000000000;
    raw.sender = "sender@conversation.invalid"_ns;
    raw.recipients = "recipient@conversation.invalid"_ns;
    raw.subject = "Same subject"_ns;
    return mCore->MessageDB().AddMessage(folderId, raw, true, &key);
  }

  nsresult PlanConversation(nsMsgKey key, bool notifyLegacy,
                            MessageThreadBatch& output) {
    return mCore->MessageDB().PlanConversationInsertion(key, notifyLegacy,
                                                        output);
  }

  const CapturedMessage* Planned(const MessageThreadBatch& batch,
                                 nsMsgKey key) {
    for (const auto& row : batch.after) {
      if (row.id == key) {
        return &row;
      }
    }
    return nullptr;
  }

  nsresult AdmissionSource(DatabaseCore *core, nsACString &output) {
    return core->ReadSourceIdForFolderAdmission(output);
  }

  nsresult RemovalMetric(uint64_t folder, int64_t &output) {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(mConnection->CreateStatement(
        "SELECT value FROM folder_properties WHERE id=:folder "
        "AND name='expungedBytes'"_ns,
        getter_AddRefs(stmt)));
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folder));
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    int64_t value = 0;
    if (more)
      MOZ_TRY(stmt->GetInt64(0, &value));
    output = value;
    return NS_OK;
  }

  nsresult SetRemovalMetric(uint64_t folder, int64_t value) {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(mConnection->CreateStatement(
        "REPLACE INTO folder_properties VALUES(:folder,'expungedBytes',:value)"_ns,
        getter_AddRefs(stmt)));
    MOZ_TRY(stmt->BindInt64ByName("folder"_ns, folder));
    MOZ_TRY(stmt->BindInt64ByName("value"_ns, value));
    return stmt->Execute();
  }

  nsresult Add(const nsACString& messageId,
               const nsTArray<nsCString>& references, nsMsgKey& key) {
    return mCore->MessageDB().AddMessage(
        mFolderId, messageId, references, 123456, "sender"_ns, "recipient"_ns,
        EmptyCString(), EmptyCString(), "subject"_ns, 0, EmptyCString(), 0,
        &key);
  }

  nsresult Stored(nsMsgKey key, nsTArray<nsCString>& values) {
    nsCOMPtr<mozIStorageConnection> reader;
    MOZ_TRY(Open(getter_AddRefs(reader)));
    nsCOMPtr<mozIStorageStatement> stmt;
    auto cleanup = MakeScopeExit([&] {
      if (stmt) {
        EXPECT_EQ(NS_OK, stmt->Finalize());
      }
      EXPECT_EQ(NS_OK, reader->Close());
    });
    MOZ_TRY(reader->CreateStatement(
        "SELECT token FROM message_references WHERE id = :id ORDER BY ordinal"_ns,
        getter_AddRefs(stmt)));
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    bool more;
    while (true) {
      MOZ_TRY(stmt->ExecuteStep(&more));
      if (!more) {
        break;
      }
      nsCString token;
      MOZ_TRY(stmt->GetUTF8String(0, token));
      values.AppendElement(token);
    }
    return NS_OK;
  }

  void CheckUsedDestinationRejected(OfflineAttemptState state) {
    ASSERT_EQ(NS_OK, Start());
    auto& db = mCore->MessageDB();
    uint32_t epoch = 91;
    ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, epoch));
    RawHdr raw;
    raw.messageId = "used-destination@invalid"_ns;
    nsMsgKey used, fresh;
    ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &used));
    raw.messageId = "fresh-destination@invalid"_ns;
    ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &fresh));
    OfflineOperationData payload;
    payload.operation = 0x10;
    ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, used, payload));
    uint64_t first;
    ASSERT_EQ(NS_OK,
              db.BeginOfflineAttempt(
                  mFolderId, used, 0x10,
                  Some(PendingDestination{mFolderId, used, epoch}), first));
    if (state == OfflineAttemptState::Ambiguous) {
      ASSERT_EQ(NS_OK, db.MarkOfflineAttemptAmbiguous(first));
    } else if (state == OfflineAttemptState::Confirmed) {
      ASSERT_EQ(NS_OK, db.ConfirmOfflineAttempt(
                           first, Some(ServerUidConfirmation{epoch, 42})));
      // Retiring the old binding does not make this physical key unused.
      ++epoch;
      ASSERT_EQ(NS_OK,
                mCore->FolderDB().SetFolderUidValidity(mFolderId, epoch));
    }
    nsTArray<nsCString> names;
    ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(used, names));
    ASSERT_FALSE(names.Contains("uidOnServer"_ns));
    OfflineAttempt original;
    ASSERT_EQ(NS_OK, db.GetOfflineAttempt(first, original));
    EXPECT_EQ(state, original.state);
    ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, fresh, payload));
    uint64_t output = 123;
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.BeginOfflineAttempt(
                  mFolderId, fresh, 0x10,
                  Some(PendingDestination{mFolderId, used, epoch}), output));
    EXPECT_EQ(123u, output);
    OfflineAttempt untouched;
    untouched.id = 88;
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.GetCurrentOfflineAttempt(mFolderId, fresh, untouched));
    EXPECT_EQ(88u, untouched.id);
    ASSERT_EQ(NS_OK,
              db.BeginOfflineAttempt(
                  mFolderId, fresh, 0x10,
                  Some(PendingDestination{mFolderId, fresh, epoch}), output));
    EXPECT_NE(first, output);
  }

  void CheckSelfDestinationRejected(uint32_t action) {
    ASSERT_EQ(NS_OK, Start());
    auto& db = mCore->MessageDB();
    ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 92));
    nsMsgKey source, destination;
    ASSERT_EQ(NS_OK, Add("self-source@invalid"_ns, {}, source));
    ASSERT_EQ(NS_OK, db.BindMessageToServerUid(source, mFolderId, 92, 42));
    RawHdr raw;
    raw.messageId = "distinct-destination@invalid"_ns;
    ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &destination));
    OfflineOperationData payload;
    payload.operation = action;
    ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, payload));
    uint64_t output = 123;
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.BeginOfflineAttempt(
                  mFolderId, source, action,
                  Some(PendingDestination{mFolderId, source, 92}), output));
    EXPECT_EQ(123u, output);
    ASSERT_EQ(NS_OK, db.BeginOfflineAttempt(
                         mFolderId, source, action,
                         Some(PendingDestination{mFolderId, destination, 92}),
                         output));
    OfflineAttempt attempt;
    ASSERT_EQ(NS_OK, db.GetOfflineAttempt(output, attempt));
    ASSERT_TRUE(attempt.source);
    ASSERT_TRUE(attempt.destination);
    EXPECT_EQ(source, attempt.source->key);
    EXPECT_EQ(destination, attempt.destination->key);
  }

  void CheckGroupingOff() {
    ASSERT_FALSE(mCore->MessageDB().mConversationGroupingEnabled);
  }

  void CheckRetiredReferences(bool stagedReply) {
    ASSERT_EQ(NS_OK, Start());
    auto& db = mCore->MessageDB();
    auto& folders = mCore->FolderDB();
    ASSERT_FALSE(db.mConversationGroupingEnabled);
    uint64_t retired, first, second;
    ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Retired"_ns, &retired));
    nsMsgKey oldRoot, oldCopy, oldReply;
    ASSERT_EQ(NS_OK, AddAt(retired, "0@made.up.invalid"_ns, {}, oldRoot));
    ASSERT_EQ(NS_OK, AddAt(retired, "0@made.up.invalid"_ns, {}, oldCopy));
    ASSERT_EQ(NS_OK, AddAt(retired, "1@made.up.invalid"_ns,
                           {"0@made.up.invalid"_ns}, oldReply));
    ASSERT_EQ(NS_OK, db.SetMessageStoreToken(oldRoot, "retained-body"_ns));
    MessageBodyState before;
    ASSERT_EQ(NS_OK, db.GetMessageBodyState(oldRoot, before));
    CapturedMessage historical;
    ASSERT_EQ(NS_OK, db.CaptureMessage(oldReply, historical));
    ASSERT_EQ(NS_OK, folders.DeleteFolder(retired));
    ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "First"_ns, &first));
    ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Second"_ns, &second));

    RawHdr raw;
    raw.messageId = "0@made.up.invalid"_ns;
    raw.subject = "Conversation root outside query"_ns;
    nsMsgKey root, reply, copy, tail, unrelated;
    ASSERT_EQ(NS_OK, db.AddMessage(first, raw, true, &root));
    ASSERT_GT(root, oldReply);
    raw.messageId = "1@made.up.invalid"_ns;
    raw.subject = "panoramafacetedphysicalneedle"_ns;
    raw.references = {"0@made.up.invalid"_ns};
    if (stagedReply) {
      ASSERT_EQ(NS_OK, db.StageMessage(second, raw, &reply));
      Maybe<CapturedMessage> staged;
      ASSERT_EQ(NS_OK, db.CaptureHeaderState(reply, staged));
      ASSERT_TRUE(staged);
      EXPECT_EQ(root, staged->threadId);
      EXPECT_EQ(root, staged->threadParent);
      bool exists = true;
      ASSERT_EQ(NS_OK, db.MessageExists(reply, exists));
      EXPECT_FALSE(exists);
      ASSERT_EQ(NS_OK, db.PublishMessage(reply, true));
    } else {
      ASSERT_EQ(NS_OK, db.AddMessage(second, raw, true, &reply));
    }
    ASSERT_EQ(NS_OK, db.AddMessage(first, raw, true, &copy));
    raw.messageId = "2@made.up.invalid"_ns;
    raw.subject = "Conversation tail outside query"_ns;
    raw.references = {"0@made.up.invalid"_ns, "1@made.up.invalid"_ns};
    ASSERT_EQ(NS_OK, db.AddMessage(second, raw, true, &tail));
    raw.messageId = "unrelated@invalid"_ns;
    raw.references.Clear();
    ASSERT_EQ(NS_OK, db.AddMessage(first, raw, true, &unrelated));
    for (auto pair : {std::pair{root, nsMsgKey{0}}, std::pair{reply, root},
                      std::pair{copy, root}, std::pair{tail, reply}}) {
      CapturedMessage stored;
      ASSERT_EQ(NS_OK, db.CaptureMessage(pair.first, stored));
      EXPECT_EQ(root, stored.threadId);
      EXPECT_EQ(pair.second, stored.threadParent);
    }
    // The same stored threadId predicate used by ConversationFilter must
    // include both nonmatching endpoints and both physical reply copies.
    nsCOMPtr<mozIStorageStatement> stmt;
    ASSERT_EQ(
        NS_OK,
        mConnection->CreateStatement(
            "SELECT id FROM messages WHERE threadId=:thread ORDER BY id"_ns,
            getter_AddRefs(stmt)));
    auto finalize = MakeScopeExit([&] { EXPECT_EQ(NS_OK, stmt->Finalize()); });
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("thread"_ns, root));
    nsTArray<nsMsgKey> members;
    bool more;
    while (true) {
      ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
      if (!more) break;
      int64_t key;
      ASSERT_EQ(NS_OK, stmt->GetInt64(0, &key));
      members.AppendElement(static_cast<nsMsgKey>(key));
    }
    EXPECT_EQ((nsTArray<nsMsgKey>{root, reply, copy, tail}), members);
    nsTArray<nsCString> references;
    ASSERT_EQ(NS_OK, Stored(tail, references));
    EXPECT_EQ(
        (nsTArray<nsCString>{"0@made.up.invalid"_ns, "1@made.up.invalid"_ns}),
        references);
    CapturedMessage control, retained;
    ASSERT_EQ(NS_OK, db.CaptureMessage(unrelated, control));
    EXPECT_EQ(unrelated, control.threadId);
    ASSERT_EQ(NS_OK, db.CaptureMessage(oldReply, retained));
    EXPECT_EQ(historical.threadId, retained.threadId);
    EXPECT_EQ(historical.threadParent, retained.threadParent);
    EXPECT_EQ(retired, retained.folderId);
    for (nsMsgKey key : {oldRoot, oldCopy, oldReply}) {
      bool exists = false;
      ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
      EXPECT_TRUE(exists);
    }
    MessageBodyState after;
    ASSERT_EQ(NS_OK, db.GetMessageBodyState(oldRoot, after));
    EXPECT_EQ(retired, after.folderId);
    EXPECT_EQ(Some(nsCString("retained-body"_ns)), after.storeToken);
    EXPECT_EQ(before.contentRevision, after.contentRevision);
    EXPECT_EQ(before.locationRevision, after.locationRevision);
    ASSERT_FALSE(db.mConversationGroupingEnabled);
  }

  void CheckOfflineSource(nsMsgKey key, uint32_t expectedEpoch,
                          uint32_t expectedUid) {
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
    nsCOMPtr<mozIStorageStatement> stmt;
    auto close = MakeScopeExit([&] {
      if (stmt) {
        EXPECT_EQ(NS_OK, stmt->Finalize());
      }
      EXPECT_EQ(NS_OK, reader->Close());
    });
    ASSERT_EQ(NS_OK,
              reader->CreateStatement(
                  "SELECT epoch, uid, folderEpoch FROM offline_operations "
                  "WHERE folderId = :folder AND messageKey = :key"_ns,
                  getter_AddRefs(stmt)));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("folder"_ns, mFolderId));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("key"_ns, key));
    bool more, folderWide;
    ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
    ASSERT_TRUE(more);
    int64_t epoch, uid;
    ASSERT_EQ(NS_OK, stmt->GetInt64(0, &epoch));
    ASSERT_EQ(NS_OK, stmt->GetInt64(1, &uid));
    ASSERT_EQ(NS_OK, stmt->GetIsNull(2, &folderWide));
    EXPECT_EQ(expectedEpoch, epoch);
    EXPECT_EQ(expectedUid, uid);
    EXPECT_TRUE(folderWide);
    ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
    EXPECT_FALSE(more);
  }

  nsresult PrepareRelocation(FolderBodyRelocation& plan) {
    plan.folderId = mFolderId;
    plan.token = "relocation-unit"_ns;
    MOZ_TRY(mCore->GetSourceId(plan.databaseSourceId));
    plan.originalSize = 64;
    plan.compactedSize = 32;
    for (auto pair : {std::pair{u"body.old", &plan.originalPath},
                      {u"body.compacted", &plan.compactedPath},
                      {u"body.backup", &plan.backupPath}}) {
      nsCOMPtr<nsIFile> file;
      MOZ_TRY(mProfile->Clone(getter_AddRefs(file)));
      MOZ_TRY(file->Append(nsDependentString(pair.first)));
      MOZ_TRY(file->GetPath(*pair.second));
      if (pair.second != &plan.backupPath) {
        MOZ_TRY(file->Create(nsIFile::NORMAL_FILE_TYPE, 0600));
        MOZ_TRY(file->SetFileSize(pair.second == &plan.originalPath ? 64 : 32));
      }
    }
    for (uint32_t i = 0; i < 2; ++i) {
      nsMsgKey key;
      nsAutoCString id("relocation-");
      id.AppendInt(i);
      MOZ_TRY(Add(id, {"ancestor"_ns, "ancestor"_ns}, key));
      RelocatedMessageBody* row = plan.messages.AppendElement();
      nsAutoCString token("old-");
      token.AppendInt(i);
      MOZ_TRY(mCore->MessageDB().SetMessageStoreToken(key, token));
      MOZ_TRY(mCore->MessageDB().SetMessageFlags(key, 5));
      MOZ_TRY(
          mCore->MessageDB().SetMessageProperty(key, "Case"_ns, "00042"_ns));
      MOZ_TRY(mCore->MessageDB().GetMessageBodyState(key, row->before));
      token.AssignLiteral("new-");
      token.AppendInt(i);
      row->storeToken = Some(nsCString(token));
      row->messageSize = 10 + i;
      row->offlineMessageSize = 8 + i;
      row->lineCount = 2 + i;
      row->offline = true;
    }
    return NS_OK;
  }

  nsresult InstallRelocation(const FolderBodyRelocation& plan) {
    nsCOMPtr<nsIFile> original, compacted, backup, directory;
    MOZ_TRY(NS_NewLocalFile(plan.originalPath, getter_AddRefs(original)));
    MOZ_TRY(NS_NewLocalFile(plan.compactedPath, getter_AddRefs(compacted)));
    MOZ_TRY(NS_NewLocalFile(plan.backupPath, getter_AddRefs(backup)));
    MOZ_TRY(original->GetParent(getter_AddRefs(directory)));
    nsAutoString oldName, backupName;
    MOZ_TRY(original->GetLeafName(oldName));
    MOZ_TRY(backup->GetLeafName(backupName));
    MOZ_TRY(original->RenameTo(directory, backupName));
    return compacted->RenameTo(directory, oldName);
  }

#ifdef XP_WIN
  nsresult ImportPathIdentity(nsIFile* file, FolderImportPathIdentity& output) {
    RefPtr<MigrationFileSystem> system = new MigrationFileSystem();
    nsCOMPtr<nsIPanoramaMigrationPath> lease;
    MOZ_TRY(system->Admit(file, mProfile,
                          nsIPanoramaMigrationFileSystem::KIND_FILE,
                          getter_AddRefs(lease)));
    auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, lease->Close()); });
    MOZ_TRY(file->GetPath(output.originalPath));
    MOZ_TRY(mProfile->GetPath(output.originalRoot));
    MOZ_TRY(lease->GetCanonicalPath(output.canonicalPath));
    MOZ_TRY(lease->GetCanonicalRoot(output.canonicalRoot));
    MOZ_TRY(lease->GetIdentity(output.id));
    MOZ_TRY(lease->GetParentIdentity(output.parentId));
    MOZ_TRY(lease->GetRootIdentity(output.rootId));
    return NS_OK;
  }
#endif

  nsresult PrepareNativeImport(FolderImportSnapshot& input, nsIFile** source) {
    uint64_t folder;
    MOZ_TRY(mCore->FolderDB().InsertFolder(mFolderId, "Import"_ns, &folder));
    input.identity.folderId = folder;
    input.identity.folderPath =
        MOZ_TRY(mCore->FolderDB().GetFolderPath(folder));
    input.identity.token = "native-import-token"_ns;
    input.identity.sourceId = "native-original-folder"_ns;
    MOZ_TRY(mCore->GetSourceId(input.identity.databaseSourceId));
    input.identity.sourceSha256 =
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"_ns;
    nsCOMPtr<nsIFile> file;
    MOZ_TRY(mProfile->Clone(getter_AddRefs(file)));
    MOZ_TRY(file->Append(u"native-source.bin"_ns));
    MOZ_TRY(file->Create(nsIFile::NORMAL_FILE_TYPE, 0600));
    MOZ_TRY(file->GetPath(input.identity.sourcePath));
#ifdef XP_WIN
    nsCOMPtr<nsIFile> store;
    MOZ_TRY(mProfile->Clone(getter_AddRefs(store)));
    MOZ_TRY(store->Append(u"native-body.bin"_ns));
    MOZ_TRY(store->Create(nsIFile::NORMAL_FILE_TYPE, 0600));
    FolderImportWindowsIdentity paths;
    MOZ_TRY(ImportPathIdentity(file, paths.summary));
    MOZ_TRY(ImportPathIdentity(store, paths.store));
    input.identity.sourcePath = paths.summary.canonicalPath;
    input.identity.windows = Some(std::move(paths));
#endif
    // Native transaction input, not a fabricated Mork/parser fixture.
    input.recordsComplete = true;
    FolderImportMessage* child = input.messages.AppendElement();
    child->sourceKey = 9;
    child->rootSourceKey = 0;
    child->parentSourceKey = Some(nsMsgKey(0));
    child->header.messageId = "child-import@invalid"_ns;
    child->header.subject = "imported child"_ns;
    child->header.storeToken = Some(nsCString("retained-original-body"_ns));
    child->header.messageSize = Some(uint32_t(0));
    child->header.references = {"root-import@invalid"_ns, "missing@invalid"_ns,
                                "root-import@invalid"_ns};
    child->header.extras = {{"Case"_ns, "00042"_ns},
                            {"case"_ns, "1e3"_ns},
                            {"keywords"_ns, "first"_ns},
                            {"keywords"_ns, "last"_ns}};
    FolderImportMessage* root = input.messages.AppendElement();
    root->sourceKey = 0;
    root->rootSourceKey = 0;
    root->header.messageId = "root-import@invalid"_ns;
    root->header.subject = "imported root"_ns;
    file.forget(source);
    return NS_OK;
  }

  nsresult ImportNativeFile(nsIFile* source, const FolderImportSnapshot& input,
                            FolderImportReceipt& output) {
    return mCore->ImportFolderSnapshotFromFile(source, input, output);
  }

  nsresult ThreadKeys(uint64_t folder, uint64_t parent, uint64_t thread,
                      nsTArray<nsMsgKey>& keys) {
    return mCore->MessageDB().ListThreadKeys(folder, parent, thread, keys);
  }
  nsresult ThreadChildren(uint64_t folder, uint64_t parent,
                          nsTArray<nsMsgKey>& keys) {
    return mCore->MessageDB().ListThreadChildKeys(folder, parent, keys);
  }
  nsresult ThreadCount(uint64_t folder, uint64_t thread, uint64_t* count) {
    return mCore->MessageDB().CountThreadKeys(folder, thread, count);
  }
  nsresult ThreadMaxDate(uint64_t folder, uint64_t thread, uint64_t* date) {
    return mCore->MessageDB().GetThreadMaxDate(folder, thread, date);
  }

  nsresult StoredKnownMarker(nsMsgKey key, bool& known) {
    nsCOMPtr<mozIStorageConnection> reader;
    MOZ_TRY(Open(getter_AddRefs(reader)));
    nsCOMPtr<mozIStorageStatement> stmt;
    auto cleanup = MakeScopeExit([&] {
      if (stmt) {
        EXPECT_EQ(NS_OK, stmt->Finalize());
      }
      EXPECT_EQ(NS_OK, reader->Close());
    });
    MOZ_TRY(reader->CreateStatement(
        "SELECT 1 FROM message_reference_sets WHERE id = :id"_ns,
        getter_AddRefs(stmt)));
    MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
    return stmt->ExecuteStep(&known);
  }

  nsCOMPtr<nsIProperties> mDirectories;
  nsCOMPtr<nsIFile> mOldProfile, mProfile, mFile;
  nsCOMPtr<mozIStorageService> mStorage;
  RefPtr<DatabaseCore> mCore;
  nsCOMPtr<mozIStorageConnection> mConnection;
  bool mProfileCreated = false;
  bool mDirectoryChanged = false;
  bool mRestoreProfileCache = false;
  uint64_t mFolderId = 0;
};

namespace {

using DISABLED_DeliveryCoreReferences = DeliveryCoreReferences;

TEST_F(DISABLED_DeliveryCoreReferences,
       AddNotificationSeesCommittedReferences) {
  ASSERT_EQ(NS_OK, Start());
  uint32_t notifications = 0;
  nsMsgKey notified = 0;
  RefPtr<AddedObserver> observer = new AddedObserver([&](Message* message) {
    ++notifications;
    ASSERT_EQ(NS_OK, message->GetMessageKey(&notified));
    nsTArray<nsCString> got, stored;
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(notified, got));
    EXPECT_EQ(
        (nsTArray<nsCString>{"ancestor@invalid"_ns, "ancestor@invalid"_ns}),
        got);
    ASSERT_EQ(NS_OK, Stored(notified, stored));
    EXPECT_EQ(
        (nsTArray<nsCString>{"ancestor@invalid"_ns, "ancestor@invalid"_ns}),
        stored);
  });
  mCore->MessageDB().AddMessageListener(observer);
  auto cleanup = MakeScopeExit(
      [&] { mCore->MessageDB().RemoveMessageListener(observer); });
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("child@invalid"_ns,
                       {"ancestor@invalid"_ns, "ancestor@invalid"_ns}, key));
  EXPECT_EQ(1u, notifications);
  EXPECT_EQ(key, notified);
}

TEST_F(DISABLED_DeliveryCoreReferences, ExactTokensSurviveReopen) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("child@invalid"_ns,
                       {"Missing@invalid"_ns, ""_ns, "e\xcc\x81@invalid"_ns,
                        "\xc3\xa9@invalid"_ns, "Missing@invalid"_ns},
                       key));
  nsTArray<nsCString> got, stored;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(key, got));
  EXPECT_EQ(
      (nsTArray<nsCString>{"Missing@invalid"_ns, ""_ns, "e\xcc\x81@invalid"_ns,
                           "\xc3\xa9@invalid"_ns, "Missing@invalid"_ns}),
      got);
  ASSERT_EQ(NS_OK, Stored(key, stored));
  EXPECT_EQ(
      (nsTArray<nsCString>{"Missing@invalid"_ns, ""_ns, "e\xcc\x81@invalid"_ns,
                           "\xc3\xa9@invalid"_ns, "Missing@invalid"_ns}),
      stored);
  Stop();
  ASSERT_EQ(NS_OK, Start());
  got.Clear();
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(key, got));
  EXPECT_EQ(
      (nsTArray<nsCString>{"Missing@invalid"_ns, ""_ns, "e\xcc\x81@invalid"_ns,
                           "\xc3\xa9@invalid"_ns, "Missing@invalid"_ns}),
      got);
}

TEST_F(DISABLED_DeliveryCoreReferences, ReplaceAndClearDoNotRethread) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey parent, child;
  ASSERT_EQ(NS_OK, Add("parent@invalid"_ns, {}, parent));
  ASSERT_EQ(NS_OK, Add("child@invalid"_ns, {"parent@invalid"_ns}, child));
  nsMsgKey oldThread, oldParent, newThread, newParent;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageThreadId(child, oldThread));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageThreadParent(child, oldParent));
  ASSERT_EQ(parent, oldParent);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().SetMessageReferences(
                child, {"replacement@invalid"_ns, "replacement@invalid"_ns}));
  nsTArray<nsCString> got, stored;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(child, got));
  EXPECT_EQ(
      (nsTArray<nsCString>{"replacement@invalid"_ns, "replacement@invalid"_ns}),
      got);
  ASSERT_EQ(NS_OK, Stored(child, stored));
  EXPECT_EQ(
      (nsTArray<nsCString>{"replacement@invalid"_ns, "replacement@invalid"_ns}),
      stored);
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageReferences(child, {}));
  got.Clear();
  stored.Clear();
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(child, got));
  EXPECT_TRUE(got.IsEmpty());
  ASSERT_EQ(NS_OK, Stored(child, stored));
  EXPECT_TRUE(stored.IsEmpty());
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageThreadId(child, newThread));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageThreadParent(child, newParent));
  EXPECT_EQ(oldThread, newThread);
  EXPECT_EQ(oldParent, newParent);
  uint32_t flags;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageFlags(child, flags));
  EXPECT_EQ(0u, flags);
  uint64_t count;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(2u, count);
}

TEST_F(DISABLED_DeliveryCoreReferences,
       FailedReplacementPreservesCommittedSequence) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("child@invalid"_ns, {"original@invalid"_ns}, key));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("references_fault"_ns, 1, witness));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "CREATE TEMP TRIGGER fail_references BEFORE INSERT ON "
                "message_references "
                "WHEN NEW.ordinal = 1 BEGIN SELECT references_fault(NEW.id); "
                "SELECT RAISE(ABORT, 'references replacement fault'); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            mCore->MessageDB().SetMessageReferences(
                key, {"first@invalid"_ns, "second@invalid"_ns}));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(int64_t(key), witness->mLastKey);
  nsTArray<nsCString> got, stored;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(key, got));
  EXPECT_EQ((nsTArray<nsCString>{"original@invalid"_ns}), got);
  ASSERT_EQ(NS_OK, Stored(key, stored));
  EXPECT_EQ((nsTArray<nsCString>{"original@invalid"_ns}), stored);
  bool inTransaction;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&inTransaction));
  EXPECT_FALSE(inTransaction);
}

TEST_F(DISABLED_DeliveryCoreReferences, FailedClearPreservesCommittedSequence) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("child@invalid"_ns, {"original@invalid"_ns}, key));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("references_fault"_ns, 1, witness));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER fail_clear BEFORE DELETE ON message_references "
          "BEGIN SELECT references_fault(OLD.id); "
          "SELECT RAISE(ABORT, 'references clear fault'); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            mCore->MessageDB().SetMessageReferences(key, {}));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(int64_t(key), witness->mLastKey);
  nsTArray<nsCString> got, stored;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(key, got));
  EXPECT_EQ((nsTArray<nsCString>{"original@invalid"_ns}), got);
  ASSERT_EQ(NS_OK, Stored(key, stored));
  EXPECT_EQ((nsTArray<nsCString>{"original@invalid"_ns}), stored);
}

TEST_F(DISABLED_DeliveryCoreReferences,
       FailedAddRollsBackMessageAndReferences) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey control, failed = 0;
  ASSERT_EQ(NS_OK, Add("control@invalid"_ns, {"kept@invalid"_ns}, control));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("references_fault"_ns, 1, witness));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "CREATE TEMP TRIGGER fail_references BEFORE INSERT ON "
                "message_references "
                "WHEN NEW.ordinal = 1 BEGIN SELECT references_fault(NEW.id); "
                "SELECT RAISE(ABORT, 'references add fault'); END"_ns));
  EXPECT_EQ(
      NS_ERROR_STORAGE_CONSTRAINT,
      Add("failed@invalid"_ns, {"one@invalid"_ns, "two@invalid"_ns}, failed));
  EXPECT_EQ(1u, witness->mCalls);
  ASSERT_GT(witness->mLastKey, 0);
  ASSERT_LT(uint64_t(witness->mLastKey), uint64_t(nsMsgKey_None));
  EXPECT_NE(int64_t(control), witness->mLastKey);
  nsTArray<nsCString> absent;
  EXPECT_EQ(NS_ERROR_UNEXPECTED,
            mCore->MessageDB().GetMessageReferences(
                static_cast<nsMsgKey>(witness->mLastKey), absent));
  ASSERT_EQ(NS_OK, Stored(static_cast<nsMsgKey>(witness->mLastKey), absent));
  EXPECT_TRUE(absent.IsEmpty());
  uint64_t count;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(1u, count);
  nsTArray<nsCString> got;
  ASSERT_EQ(NS_OK, Stored(control, got));
  EXPECT_EQ((nsTArray<nsCString>{"kept@invalid"_ns}), got);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER fail_references"_ns));
  ASSERT_EQ(NS_OK, Add("retry@invalid"_ns, {"one@invalid"_ns}, failed));
  got.Clear();
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(failed, got));
  EXPECT_EQ((nsTArray<nsCString>{"one@invalid"_ns}), got);
}

TEST_F(DISABLED_DeliveryCoreReferences,
       MissingRowsAndStorageErrorsAreFailures) {
  ASSERT_EQ(NS_OK, Start());
  nsTArray<nsCString> got{"unchanged"_ns};
  EXPECT_EQ(NS_ERROR_UNEXPECTED,
            mCore->MessageDB().GetMessageReferences(123, got));
  EXPECT_EQ(NS_ERROR_UNEXPECTED,
            mCore->MessageDB().SetMessageReferences(123, {}));
  EXPECT_EQ((nsTArray<nsCString>{"unchanged"_ns}), got);
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("child@invalid"_ns, {}, key));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "ALTER TABLE message_references RENAME TO unavailable_references"_ns));
  EXPECT_EQ(NS_ERROR_FAILURE,
            mCore->MessageDB().GetMessageReferences(key, got));
  EXPECT_EQ((nsTArray<nsCString>{"unchanged"_ns}), got);
}

TEST_F(DISABLED_DeliveryCoreReferences, UpgradeKeepsOldReferencesUnavailable) {
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL(kOldSchema));
  ASSERT_EQ(
      NS_OK,
      old->ExecuteSimpleSQL(
          "INSERT INTO messages(id,messageId) VALUES(7,'historic@invalid')"_ns));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
  nsTArray<nsCString> got{"unchanged"_ns};
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->MessageDB().GetMessageReferences(7, got));
  EXPECT_EQ((nsTArray<nsCString>{"unchanged"_ns}), got);
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageReferences(7, {}));
  got.Clear();
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(7, got));
  EXPECT_TRUE(got.IsEmpty());
  int32_t version;
  ASSERT_EQ(NS_OK, mConnection->GetSchemaVersion(&version));
  EXPECT_EQ(15, version);
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(7, got));
  EXPECT_TRUE(got.IsEmpty());
}

TEST_F(DISABLED_DeliveryCoreReferences, UnsupportedSchemaCanRetryAfterRepair) {
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL(kOldSchema));
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL(
                       "ALTER TABLE messages ADD COLUMN alien TEXT"_ns));
  ASSERT_EQ(NS_OK, old->Close());
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, Start());
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK,
            old->ExecuteSimpleSQL("ALTER TABLE messages DROP COLUMN alien"_ns));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
}

TEST_F(DISABLED_DeliveryCoreReferences, DeleteRemovesSequenceAndKnownMarker) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("deleted@invalid"_ns, {"old@invalid"_ns}, key));
  bool known;
  ASSERT_EQ(NS_OK, StoredKnownMarker(key, known));
  ASSERT_TRUE(known);
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(key));
  ASSERT_EQ(NS_OK, StoredKnownMarker(key, known));
  EXPECT_FALSE(known);
  nsTArray<nsCString> got, stored;
  EXPECT_EQ(NS_ERROR_UNEXPECTED,
            mCore->MessageDB().GetMessageReferences(key, got));
  ASSERT_EQ(NS_OK, Stored(key, stored));
  EXPECT_TRUE(stored.IsEmpty());
  nsMsgKey replacement;
  ASSERT_EQ(NS_OK, Add("replacement@invalid"_ns, {}, replacement));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(replacement, got));
  EXPECT_TRUE(got.IsEmpty());
}

TEST_F(DISABLED_DeliveryCoreReferences, SetterDoesNotAdoptForeignTransaction) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("child@invalid"_ns, {"original@invalid"_ns}, key));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto cleanup = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            mCore->MessageDB().SetMessageReferences(key, {"other@invalid"_ns}));
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  nsTArray<nsCString> stored;
  ASSERT_EQ(NS_OK, Stored(key, stored));
  EXPECT_EQ((nsTArray<nsCString>{"original@invalid"_ns}), stored);
}

TEST_F(DISABLED_DeliveryCoreReferences, FailedUpgradeRollsBackAndCanRetry) {
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL(kOldSchema));
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL(
                       "CREATE TABLE message_references(unrelated TEXT)"_ns));
  ASSERT_EQ(NS_OK, old->Close());
  EXPECT_EQ(NS_ERROR_FAILURE, Start());
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  bool exists;
  ASSERT_EQ(NS_OK, old->TableExists("message_reference_sets"_ns, &exists));
  EXPECT_FALSE(exists);
  int32_t version;
  ASSERT_EQ(NS_OK, old->GetSchemaVersion(&version));
  EXPECT_EQ(0, version);
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL("DROP TABLE message_references"_ns));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
}

TEST_F(DISABLED_DeliveryCoreReferences, FutureSchemaIsNotSilentlyAccepted) {
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL(kOldSchema));
  ASSERT_EQ(NS_OK, old->SetSchemaVersion(99));
  ASSERT_EQ(NS_OK, old->Close());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, Start());
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  int32_t version;
  ASSERT_EQ(NS_OK, old->GetSchemaVersion(&version));
  EXPECT_EQ(99, version);
  ASSERT_EQ(NS_OK, old->SetSchemaVersion(0));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
}

TEST_F(DISABLED_DeliveryCoreReferences, ChangedDeleteTriggerIsUnsupported) {
  ASSERT_EQ(NS_OK, Start());
  Stop();
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(
      NS_OK,
      old->CreateStatement(
          "SELECT sql FROM sqlite_master WHERE name = 'delete_message_references'"_ns,
          getter_AddRefs(stmt)));
  bool more;
  ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
  ASSERT_TRUE(more);
  nsCString original;
  ASSERT_EQ(NS_OK, stmt->GetUTF8String(0, original));
  ASSERT_EQ(NS_OK, stmt->Finalize());
  ASSERT_EQ(NS_OK,
            old->ExecuteSimpleSQL("DROP TRIGGER delete_message_references"_ns));
  ASSERT_EQ(
      NS_OK,
      old->ExecuteSimpleSQL(
          "CREATE TRIGGER delete_message_references AFTER DELETE ON messages "
          "BEGIN SELECT 1; END"_ns));
  ASSERT_EQ(NS_OK, old->Close());
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, Start());
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK,
            old->ExecuteSimpleSQL("DROP TRIGGER delete_message_references"_ns));
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL(original));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
}

class PublicationObserver final : public MessageListener {
 public:
  NS_DECL_ISUPPORTS
  explicit PublicationObserver(std::function<void(Message*, bool)> published)
      : mPublished(std::move(published)) {}
  void OnMessagePublished(Message* message, bool notifyLegacy) override {
    mPublished(message, notifyLegacy);
  }
  void OnMessageAdded(Message*) override { ADD_FAILURE() << "Unbridged add"; }
  void OnMessageRemoved(Message*, uint32_t) override {}
  void OnMessageFlagsChanged(nsIMsgDBHdr*, Message*, uint32_t,
                             uint32_t) override {
    ++mChanges;
  }
  void OnMessageTagsChanged(nsIMsgDBHdr*, Message*, const nsACString&,
                            const nsACString&) override {
    ++mChanges;
  }
  uint32_t mChanges = 0;

 private:
  ~PublicationObserver() = default;
  std::function<void(Message*, bool)> mPublished;
};
NS_IMPL_ISUPPORTS(PublicationObserver, nsISupports)

class BodyObserver final : public MessageListener {
 public:
  NS_DECL_ISUPPORTS
  explicit BodyObserver(
      std::function<void(nsIMsgDBHdr*, Message*, const MessageBodyState&,
                         const MessageBodyState&)>
          changed)
      : mChanged(std::move(changed)) {}
  void OnMessageBodyChanged(nsIMsgDBHdr* old, Message* message,
                            const MessageBodyState& before,
                            const MessageBodyState& after) override {
    mChanged(old, message, before, after);
  }
  void OnMessageAdded(Message*) override { ADD_FAILURE() << "Unexpected add"; }
  void OnMessageRemoved(Message*, uint32_t) override {}
  void OnMessageFlagsChanged(nsIMsgDBHdr*, Message*, uint32_t,
                             uint32_t) override {
    ADD_FAILURE() << "Body update split into a flag callback";
  }
  void OnMessageTagsChanged(nsIMsgDBHdr*, Message*, const nsACString&,
                            const nsACString&) override {}

 private:
  ~BodyObserver() = default;
  std::function<void(nsIMsgDBHdr*, Message*, const MessageBodyState&,
                     const MessageBodyState&)>
      mChanged;
};
NS_IMPL_ISUPPORTS(BodyObserver, nsISupports)

nsresult PublicationCell(mozIStorageConnection* reader, nsMsgKey key,
                         const nsACString& sql, nsACString& value,
                         const nsACString* name = nullptr) {
  nsCOMPtr<mozIStorageStatement> stmt;
  MOZ_TRY(reader->CreateStatement(sql, getter_AddRefs(stmt)));
  auto cleanup = MakeScopeExit([&] { EXPECT_EQ(NS_OK, stmt->Finalize()); });
  MOZ_TRY(stmt->BindInt64ByName("id"_ns, key));
  if (name) {
    MOZ_TRY(stmt->BindUTF8StringByName("name"_ns, *name));
  }
  bool more;
  MOZ_TRY(stmt->ExecuteStep(&more));
  NS_ENSURE_TRUE(more, NS_ERROR_NOT_AVAILABLE);
  return stmt->GetUTF8String(0, value);
}

TEST_F(DISABLED_DeliveryCoreReferences,
       NativePublicationIsCompleteAtFirstCallback) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey parent;
  ASSERT_EQ(NS_OK, Add("parent@invalid"_ns, {}, parent));
  RawHdr raw;
  raw.key = parent;
  raw.messageId = "complete@invalid"_ns;
  raw.references = {"parent@invalid"_ns, "missing@invalid"_ns,
                    "missing@invalid"_ns, "parent@invalid"_ns};
  raw.date = 123456789;
  raw.dateReceived = 483000000;
  raw.sender = "author@invalid"_ns;
  raw.recipients = "to@invalid"_ns;
  raw.ccList = "cc@invalid"_ns;
  raw.bccList = "bcc@invalid"_ns;
  raw.subject = "complete subject"_ns;
  raw.flags = 5;
  raw.priority = 5;
  raw.replyTo = "reply@invalid"_ns;
  raw.charset = "UTF-8"_ns;
  raw.accountKey = "account7"_ns;
  raw.keywords = "old-tag"_ns;
  raw.extras = {{"keywords"_ns, "final-tag"_ns}, {"custom"_ns, "00042"_ns}};
  raw.messageSize = Some(uint32_t(42));
  raw.storeToken = Some(nsCString("0"_ns));
  raw.offlineMessageSize = Some(uint32_t(17));
  raw.lineCount = Some(uint32_t(3));
  nsMsgKey key = nsMsgKey_None;
  Message* live = nullptr;
  uint32_t notifications = 0;
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([&](Message* message, bool notifyLegacy) {
        ++notifications;
        EXPECT_TRUE(notifyLegacy);
        EXPECT_EQ(message, live);
        nsMsgKey observed, thread, parentThread, threadParent;
        ASSERT_EQ(NS_OK, message->GetMessageKey(&observed));
        EXPECT_EQ(key, observed);
        EXPECT_NE(parent, observed);
        EXPECT_EQ(mFolderId, message->FolderId());
        ASSERT_EQ(NS_OK, message->GetThreadId(&thread));
        ASSERT_EQ(NS_OK,
                  mCore->MessageDB().GetMessageThreadId(parent, parentThread));
        EXPECT_NE(0u, thread);
        EXPECT_EQ(parentThread, thread);
        ASSERT_EQ(NS_OK, message->GetThreadParent(&threadParent));
        EXPECT_EQ(parent, threadParent);
        bool inTransaction = true;
        ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&inTransaction));
        EXPECT_FALSE(inTransaction);
        nsCString text;
        ASSERT_EQ(NS_OK, message->GetSubject(text));
        EXPECT_EQ("complete subject"_ns, text);
        ASSERT_EQ(NS_OK, message->GetMessageId(text));
        EXPECT_EQ("complete@invalid"_ns, text);
        ASSERT_EQ(NS_OK, message->GetAuthor(text));
        EXPECT_EQ("author@invalid"_ns, text);
        ASSERT_EQ(NS_OK, message->GetRecipients(text));
        EXPECT_EQ("to@invalid"_ns, text);
        ASSERT_EQ(NS_OK, message->GetCcList(text));
        EXPECT_EQ("cc@invalid"_ns, text);
        ASSERT_EQ(NS_OK, message->GetBccList(text));
        EXPECT_EQ("bcc@invalid"_ns, text);
        PRTime date;
        ASSERT_EQ(NS_OK, message->GetDate(&date));
        EXPECT_EQ(PRTime(123456789), date);
        uint32_t number;
        ASSERT_EQ(NS_OK, message->GetFlags(&number));
        EXPECT_EQ(5u, number);
        nsMsgPriorityValue priority;
        ASSERT_EQ(NS_OK, message->GetPriority(&priority));
        EXPECT_EQ(5, priority);
        ASSERT_EQ(NS_OK, message->GetMessageSize(&number));
        EXPECT_EQ(42u, number);
        ASSERT_EQ(NS_OK, message->GetOfflineMessageSize(&number));
        EXPECT_EQ(17u, number);
        ASSERT_EQ(NS_OK, message->GetLineCount(&number));
        EXPECT_EQ(3u, number);
        ASSERT_EQ(NS_OK, message->GetStoreToken(text));
        EXPECT_EQ("0"_ns, text);
        nsCOMPtr<mozIStorageConnection> reader;
        ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
        auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
        ASSERT_EQ(NS_OK,
                  PublicationCell(reader, key,
                                  "SELECT tags FROM messages WHERE id = :id"_ns,
                                  text));
        EXPECT_EQ("final-tag"_ns, text);
        const RawHdr::kv expected[] = {{"replyTo"_ns, "reply@invalid"_ns},
                                       {"msgCharSet"_ns, "UTF-8"_ns},
                                       {"account"_ns, "account7"_ns},
                                       {"custom"_ns, "00042"_ns},
                                       {"dateReceived"_ns, "1e3"_ns}};
        for (const auto& property : expected) {
          SCOPED_TRACE(property.k.get());
          ASSERT_EQ(NS_OK, message->GetStringProperty(property.k.get(), text));
          EXPECT_EQ(property.v, text);
          ASSERT_EQ(
              NS_OK,
              PublicationCell(
                  reader, key,
                  "SELECT value FROM message_properties WHERE id = :id AND name = :name"_ns,
                  text, &property.k));
          EXPECT_EQ(property.v, text);
        }
        ASSERT_EQ(NS_OK, message->GetStringProperty("keywords", text));
        EXPECT_EQ("final-tag"_ns, text);
        ASSERT_EQ(
            NS_OK,
            PublicationCell(
                reader, key,
                "SELECT count(*) FROM message_properties WHERE id = :id AND name = 'keywords'"_ns,
                text));
        EXPECT_EQ("0"_ns, text);
        nsTArray<nsCString> refs;
        ASSERT_EQ(NS_OK, Stored(key, refs));
        EXPECT_EQ(
            (nsTArray<nsCString>{"parent@invalid"_ns, "missing@invalid"_ns,
                                 "missing@invalid"_ns, "parent@invalid"_ns}),
            refs);
      });
  mCore->MessageDB().AddMessageListener(observer);
  auto cleanup = MakeScopeExit(
      [&] { mCore->MessageDB().RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().AddMessage(mFolderId, raw, true, &key, &live));
  RefPtr<Message> owned = dont_AddRef(live);
  EXPECT_EQ(1u, notifications);
  EXPECT_EQ(0u, observer->mChanges);
}

TEST_F(DISABLED_DeliveryCoreReferences,
       NativeQuietPublicationStillReachesInternalObservers) {
  ASSERT_EQ(NS_OK, Start());
  uint32_t publications = 0, oldCallbacks = 0;
  RefPtr<PublicationObserver> published =
      new PublicationObserver([&](Message*, bool notifyLegacy) {
        ++publications;
        EXPECT_FALSE(notifyLegacy);
      });
  RefPtr<AddedObserver> internal =
      new AddedObserver([&](Message*) { ++oldCallbacks; });
  mCore->MessageDB().AddMessageListener(published);
  mCore->MessageDB().AddMessageListener(internal);
  auto cleanup = MakeScopeExit([&] {
    mCore->MessageDB().RemoveMessageListener(published);
    mCore->MessageDB().RemoveMessageListener(internal);
  });
  RawHdr raw;
  raw.messageId = "quiet@invalid"_ns;
  nsMsgKey key;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolderId, raw, false, &key));
  EXPECT_EQ(1u, publications);
  EXPECT_EQ(1u, oldCallbacks);
  EXPECT_EQ(0u, published->mChanges);
  uint64_t count;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(1u, count);
}

TEST_F(DISABLED_DeliveryCoreReferences,
       NativeExtrasKeepExactNamesTextAndOrder) {
  ASSERT_EQ(NS_OK, Start());
  RawHdr raw;
  raw.replyTo = "default reply"_ns;
  raw.charset = "default charset"_ns;
  raw.accountKey = "default account"_ns;
  raw.keywords = "default tags"_ns;
  raw.dateReceived = 1000000;
  raw.extras = {{"replyTo"_ns, ""_ns},
                {"msgCharSet"_ns, "override charset"_ns},
                {"account"_ns, ""_ns},
                {"charset"_ns, "arbitrary charset"_ns},
                {"accountKey"_ns, "arbitrary accountKey"_ns},
                {"custom"_ns, "first"_ns},
                {"custom"_ns, "00042"_ns},
                {"Custom"_ns, "1e3"_ns},
                {"\xc3\xa9"_ns, "composed"_ns},
                {"e\xcc\x81"_ns, "decomposed"_ns},
                {""_ns, "empty name"_ns},
                {"dateReceived"_ns, "00042"_ns},
                {"keywords"_ns, "first tag"_ns},
                {"keywords"_ns, ""_ns},
                {"keywords"_ns, "e\xcc\x81"_ns}};
  nsMsgKey key;
  Message* live = nullptr;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().AddMessage(mFolderId, raw, true, &key, &live));
  RefPtr<Message> owned = dont_AddRef(live);
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
  const RawHdr::kv expected[] = {{"replyTo"_ns, ""_ns},
                                 {"msgCharSet"_ns, "override charset"_ns},
                                 {"account"_ns, ""_ns},
                                 {"charset"_ns, "arbitrary charset"_ns},
                                 {"accountKey"_ns, "arbitrary accountKey"_ns},
                                 {"custom"_ns, "00042"_ns},
                                 {"Custom"_ns, "1e3"_ns},
                                 {"\xc3\xa9"_ns, "composed"_ns},
                                 {"e\xcc\x81"_ns, "decomposed"_ns},
                                 {""_ns, "empty name"_ns},
                                 {"dateReceived"_ns, "00042"_ns}};
  for (const auto& property : expected) {
    SCOPED_TRACE(property.k.get());
    nsCString text;
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessageProperty(key, property.k, text));
    EXPECT_EQ(property.v, text);
    ASSERT_EQ(
        NS_OK,
        PublicationCell(
            reader, key,
            "SELECT value FROM message_properties WHERE id = :id AND name = :name"_ns,
            text, &property.k));
    EXPECT_EQ(property.v, text);
  }
  nsCString tags;
  ASSERT_EQ(NS_OK, live->GetStringProperty("keywords", tags));
  EXPECT_EQ("e\xcc\x81"_ns, tags);
  ASSERT_EQ(NS_OK, PublicationCell(
                       reader, key,
                       "SELECT tags FROM messages WHERE id = :id"_ns, tags));
  EXPECT_EQ("e\xcc\x81"_ns, tags);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessagePropertyNames(key, names));
  EXPECT_EQ(11u, names.Length());
  for (const auto& property : expected) {
    EXPECT_TRUE(names.Contains(property.k));
  }
  EXPECT_FALSE(names.Contains("keywords"_ns));
}

TEST_F(DISABLED_DeliveryCoreReferences,
       NativeEmptyKeywordsOverrideNamedDefault) {
  ASSERT_EQ(NS_OK, Start());
  RawHdr raw;
  raw.keywords = "named default"_ns;
  raw.extras = {{"keywords"_ns, "first"_ns}, {"keywords"_ns, ""_ns}};
  nsMsgKey key;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolderId, raw, true, &key));
  nsCString tags;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageTags(key, tags));
  EXPECT_TRUE(tags.IsEmpty());
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
  ASSERT_EQ(NS_OK, PublicationCell(
                       reader, key,
                       "SELECT tags FROM messages WHERE id = :id"_ns, tags));
  EXPECT_TRUE(tags.IsEmpty());
}

TEST_F(DISABLED_DeliveryCoreReferences, NativeAbsentStorageRetainsExactExtras) {
  ASSERT_EQ(NS_OK, Start());
  RawHdr raw;
  raw.extras = {{"messageSize"_ns, "00041"_ns},
                {"storeToken"_ns, "extra"_ns},
                {"offlineMessageSize"_ns, "17"_ns},
                {"lineCount"_ns, "3"_ns}};
  nsMsgKey key;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolderId, raw, true, &key));
  uint64_t size;
  uint32_t lines;
  nsCString text;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageSize(key, size));
  EXPECT_EQ(41u, size);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessageProperty(key, "messageSize"_ns, text));
  EXPECT_EQ("00041"_ns, text);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageStoreToken(key, text));
  EXPECT_EQ("extra"_ns, text);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageOfflineMessageSize(key, size));
  EXPECT_EQ(17u, size);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageLineCount(key, lines));
  EXPECT_EQ(3u, lines);
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
  ASSERT_EQ(
      NS_OK,
      PublicationCell(
          reader, key,
          "SELECT value FROM message_properties WHERE id = :id AND name = 'messageSize'"_ns,
          text));
  EXPECT_EQ("00041"_ns, text);
}

TEST_F(DISABLED_DeliveryCoreReferences,
       NativePresentStorageOverridesExactExtras) {
  ASSERT_EQ(NS_OK, Start());
  RawHdr raw;
  raw.extras = {{"messageSize"_ns, "41"_ns},
                {"storeToken"_ns, "extra"_ns},
                {"offlineMessageSize"_ns, "17"_ns},
                {"lineCount"_ns, "3"_ns}};
  raw.messageSize = Some(uint32_t(0));
  raw.storeToken = Some(nsCString());
  raw.offlineMessageSize = Some(uint32_t(0xffffffff));
  raw.lineCount = Some(uint32_t(0));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolderId, raw, true, &key));
  uint64_t size;
  uint32_t lines;
  nsCString text;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageSize(key, size));
  EXPECT_EQ(0u, size);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageStoreToken(key, text));
  EXPECT_TRUE(text.IsEmpty());
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageOfflineMessageSize(key, size));
  EXPECT_EQ(uint64_t(0xffffffff), size);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageLineCount(key, lines));
  EXPECT_EQ(0u, lines);
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
  ASSERT_EQ(
      NS_OK,
      PublicationCell(
          reader, key,
          "SELECT count(*) FROM message_properties WHERE id = :id AND name IN "
          "('messageSize','storeToken','offlineMessageSize','lineCount')"_ns,
          text));
  EXPECT_EQ("4"_ns, text);
}

TEST_F(DISABLED_DeliveryCoreReferences,
       NativeReceivedDateUsesLegacySecondsText) {
  ASSERT_EQ(NS_OK, Start());
  const struct {
    PRTime received;
    const char* text;
    uint32_t number;
    bool present;
  } cases[] = {{0, "", 0, false},
               {999999, "0", 0, true},
               {483000000, "1e3", 483, true},
               {-1000000, "ffffffff", 0xffffffff, true},
               {-999999, "0", 0, true},
               {4294967297000000LL, "1", 1, true}};
  for (const auto& test : cases) {
    SCOPED_TRACE(test.received);
    RawHdr raw;
    raw.dateReceived = test.received;
    nsMsgKey key;
    Message* live = nullptr;
    nsresult rv =
        mCore->MessageDB().AddMessage(mFolderId, raw, true, &key, &live);
    EXPECT_EQ(NS_OK, rv);
    if (NS_FAILED(rv)) {
      continue;
    }
    RefPtr<Message> owned = dont_AddRef(live);
    nsCString text;
    EXPECT_EQ(NS_OK, live->GetStringProperty("dateReceived", text));
    EXPECT_STREQ(test.text, text.get());
    uint32_t number = 99;
    EXPECT_EQ(NS_OK, live->GetUint32Property("dateReceived", &number));
    EXPECT_EQ(test.number, number);
    nsTArray<nsCString> names;
    EXPECT_EQ(NS_OK, mCore->MessageDB().GetMessagePropertyNames(key, names));
    EXPECT_EQ(test.present, names.Contains("dateReceived"_ns));
  }
}

TEST_F(DISABLED_DeliveryCoreReferences,
       NativePropertyFailureLeavesOutputsAndControlIntact) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("control@invalid"_ns, {"kept@invalid"_ns}, control));
  RefPtr<Message> sentinel = new Message(control);
  Message* live = sentinel.get();
  nsMsgKey key = 0x76543210;
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("publication_fault"_ns, 1, witness));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER fail_publication BEFORE INSERT ON "
          "message_properties "
          "WHEN NEW.name = 'late' BEGIN SELECT publication_fault(NEW.id); "
          "SELECT RAISE(ABORT, 'publication property fault'); END"_ns));
  uint32_t notifications = 0;
  RefPtr<AddedObserver> observer =
      new AddedObserver([&](Message*) { ++notifications; });
  mCore->MessageDB().AddMessageListener(observer);
  auto cleanup = MakeScopeExit(
      [&] { mCore->MessageDB().RemoveMessageListener(observer); });
  RawHdr raw;
  raw.messageId = "failed@invalid"_ns;
  raw.references = {"missing@invalid"_ns, "missing@invalid"_ns};
  raw.extras = {{"early"_ns, "00042"_ns}, {"late"_ns, "1e3"_ns}};
  raw.storeToken = Some(nsCString("finished-bytes"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            mCore->MessageDB().AddMessage(mFolderId, raw, true, &key, &live));
  EXPECT_EQ(1u, witness->mCalls);
  ASSERT_GT(witness->mLastKey, 0);
  ASSERT_LT(uint64_t(witness->mLastKey), uint64_t(nsMsgKey_None));
  EXPECT_EQ(nsMsgKey(0x76543210), key);
  EXPECT_EQ(sentinel.get(), live);
  EXPECT_EQ(0u, notifications);
  bool inTransaction = true;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&inTransaction));
  EXPECT_FALSE(inTransaction);
  nsMsgKey failed = static_cast<nsMsgKey>(witness->mLastKey);
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
  for (const auto& sql :
       {"SELECT count(*) FROM messages WHERE id = :id"_ns,
        "SELECT count(*) FROM message_properties WHERE id = :id"_ns,
        "SELECT count(*) FROM message_references WHERE id = :id"_ns,
        "SELECT count(*) FROM message_reference_sets WHERE id = :id"_ns}) {
    nsCString text;
    ASSERT_EQ(NS_OK, PublicationCell(reader, failed, sql, text));
    EXPECT_EQ("0"_ns, text);
  }
  nsCString subject;
  EXPECT_EQ(NS_ERROR_UNEXPECTED,
            mCore->MessageDB().GetMessageSubject(failed, subject));
  nsTArray<nsCString> stored;
  ASSERT_EQ(NS_OK, Stored(control, stored));
  EXPECT_EQ((nsTArray<nsCString>{"kept@invalid"_ns}), stored);
  nsCString text;
  ASSERT_EQ(NS_OK, PublicationCell(
                       reader, control,
                       "SELECT subject FROM messages WHERE id = :id"_ns, text));
  EXPECT_EQ("subject"_ns, text);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER fail_publication"_ns));
  live = nullptr;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().AddMessage(mFolderId, raw, true, &key, &live));
  RefPtr<Message> owned = dont_AddRef(live);
  EXPECT_EQ(1u, notifications);
  ASSERT_EQ(NS_OK, live->GetStoreToken(text));
  EXPECT_EQ("finished-bytes"_ns, text);
  ASSERT_EQ(NS_OK, PublicationCell(
                       reader, control,
                       "SELECT subject FROM messages WHERE id = :id"_ns, text));
  EXPECT_EQ("subject"_ns, text);
}

TEST_F(DISABLED_DeliveryCoreReferences,
       NativePublicationRejectsForeignTransactionAndNullKey) {
  ASSERT_EQ(NS_OK, Start());
  RawHdr raw;
  raw.subject = "must not be inserted"_ns;
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("foreign-control@invalid"_ns, {}, control));
  RefPtr<Message> sentinel = new Message(99);
  Message* live = sentinel.get();
  EXPECT_EQ(NS_ERROR_INVALID_ARG, mCore->MessageDB().AddMessage(
                                      mFolderId, raw, true, nullptr, &live));
  EXPECT_EQ(sentinel.get(), live);
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(control, "foreign"_ns,
                                                         "kept"_ns));
  nsMsgKey key = 0x12345678;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            mCore->MessageDB().AddMessage(mFolderId, raw, true, &key, &live));
  EXPECT_EQ(nsMsgKey(0x12345678), key);
  EXPECT_EQ(sentinel.get(), live);
  bool inTransaction = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&inTransaction));
  EXPECT_TRUE(inTransaction);
  nsCString value;
  ASSERT_EQ(
      NS_OK,
      PublicationCell(
          mConnection, control,
          "SELECT value FROM message_properties WHERE id = :id AND name = 'foreign'"_ns,
          value));
  EXPECT_EQ("kept"_ns, value);
}

TEST_F(DISABLED_DeliveryCoreReferences,
       NativeBorrowedInputSupportsReentrantReuse) {
  ASSERT_EQ(NS_OK, Start());
  RawHdr raw;
  raw.messageId = "reused@invalid"_ns;
  raw.references = {"unresolved@invalid"_ns, "unresolved@invalid"_ns};
  raw.extras = {{"custom"_ns, "00042"_ns}};
  nsMsgKey outer = nsMsgKey_None, inner = nsMsgKey_None;
  uint32_t notifications = 0;
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([&](Message* message, bool notifyLegacy) {
        ++notifications;
        nsMsgKey key;
        ASSERT_EQ(NS_OK, message->GetMessageKey(&key));
        if (notifications == 1) {
          EXPECT_TRUE(notifyLegacy);
          EXPECT_EQ(outer, key);
          ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolderId, raw, false,
                                                         &inner));
        } else {
          EXPECT_FALSE(notifyLegacy);
          EXPECT_EQ(inner, key);
        }
      });
  mCore->MessageDB().AddMessageListener(observer);
  auto cleanup = MakeScopeExit(
      [&] { mCore->MessageDB().RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolderId, raw, true, &outer));
  EXPECT_EQ(2u, notifications);
  EXPECT_NE(outer, inner);
  EXPECT_EQ(
      (nsTArray<nsCString>{"unresolved@invalid"_ns, "unresolved@invalid"_ns}),
      raw.references);
  ASSERT_EQ(1u, raw.extras.Length());
  EXPECT_EQ("custom"_ns, raw.extras[0].k);
  EXPECT_EQ("00042"_ns, raw.extras[0].v);
  for (nsMsgKey key : {outer, inner}) {
    nsTArray<nsCString> stored;
    ASSERT_EQ(NS_OK, Stored(key, stored));
    EXPECT_EQ(
        (nsTArray<nsCString>{"unresolved@invalid"_ns, "unresolved@invalid"_ns}),
        stored);
  }
}

CapturedMessage CaptureSentinel() {
  CapturedMessage value;
  value.id = 0xfffffff0;
  value.folderId = 0x123456789ULL;
  value.messageId = "sentinel-id"_ns;
  value.date = -2001;
  value.sender = "sentinel-sender"_ns;
  value.recipients = "sentinel-recipients"_ns;
  value.subject = "sentinel-subject"_ns;
  value.flags = 0xfedcba98;
  value.tags = "sentinel-tags"_ns;
  value.threadId = 0xf0000001;
  value.threadParent = 0xe0000001;
  return value;
}

void ExpectCapture(const CapturedMessage& expected,
                   const CapturedMessage& actual) {
  EXPECT_EQ(expected.id, actual.id);
  EXPECT_EQ(expected.folderId, actual.folderId);
  EXPECT_EQ(expected.messageId, actual.messageId);
  EXPECT_EQ(expected.date, actual.date);
  EXPECT_EQ(expected.sender, actual.sender);
  EXPECT_EQ(expected.recipients, actual.recipients);
  EXPECT_EQ(expected.subject, actual.subject);
  EXPECT_EQ(expected.flags, actual.flags);
  EXPECT_EQ(expected.tags, actual.tags);
  EXPECT_EQ(expected.threadId, actual.threadId);
  EXPECT_EQ(expected.threadParent, actual.threadParent);
}

class CaptureReadAbort final : public mozIStorageProgressHandler {
 public:
  NS_DECL_ISUPPORTS
  uint32_t mCalls = 0;
  uint32_t mAborts = 0;
  NS_IMETHOD OnProgress(mozIStorageConnection*, bool* interrupt) override {
    ++mCalls;
    *interrupt = mAborts == 0;
    if (*interrupt) {
      ++mAborts;
    }
    return NS_OK;
  }

 private:
  ~CaptureReadAbort() = default;
};
NS_IMPL_ISUPPORTS(CaptureReadAbort, mozIStorageProgressHandler)

class CapturedBatchObserver final : public MessageListener {
 public:
  NS_DECL_ISUPPORTS
  std::function<void(const CapturedMessage&, const CapturedMessage&, Message*)>
      mChanged;
  std::function<void(const CapturedMessage&, Message*)> mCaptured;
  uint32_t mAdded = 0;
  bool mNotifyLegacy = true;
  void OnMessageThreadChanged(const CapturedMessage& before,
                              const CapturedMessage& after,
                              Message* live) override {
    mChanged(before, after, live);
  }
  void OnMessagePublishedCaptured(const CapturedMessage& after, Message* live,
                                  bool notifyLegacy) override {
    mCaptured(after, live);
    MessageListener::OnMessagePublishedCaptured(after, live, notifyLegacy);
  }
  void OnMessagePublished(Message* live, bool notifyLegacy) override {
    mNotifyLegacy = notifyLegacy;
    MessageListener::OnMessagePublished(live, notifyLegacy);
  }
  void OnMessageAdded(Message*) override { ++mAdded; }
  void OnMessageRemoved(Message*, uint32_t) override {}
  void OnMessageFlagsChanged(nsIMsgDBHdr*, Message*, uint32_t,
                             uint32_t) override {}
  void OnMessageTagsChanged(nsIMsgDBHdr*, Message*, const nsACString&,
                            const nsACString&) override {}

 private:
  ~CapturedBatchObserver() = default;
};
NS_IMPL_ISUPPORTS(CapturedBatchObserver, nsISupports)

TEST_F(DISABLED_DeliveryCoreReferences, CaptureOwnsHistoricalRowFacts) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey parent;
  ASSERT_EQ(NS_OK, Add("capture-parent@invalid"_ns, {}, parent));
  nsMsgKey parentThread;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageThreadId(parent, parentThread));
  RawHdr raw;
  raw.messageId = "captured@invalid"_ns;
  raw.references = {"capture-parent@invalid"_ns};
  raw.date = 1700000000123456LL;
  raw.sender = "sender-original"_ns;
  raw.recipients = "recipients-original"_ns;
  raw.subject = "subject-original"_ns;
  raw.flags = 0x80000004;
  raw.keywords = "tag-one tag-two"_ns;
  nsMsgKey key;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolderId, raw, true, &key));
  CapturedMessage expected;
  expected.id = key;
  expected.folderId = mFolderId;
  expected.messageId = "captured@invalid"_ns;
  expected.date = 1700000000123456LL;
  expected.sender = "sender-original"_ns;
  expected.recipients = "recipients-original"_ns;
  expected.subject = "subject-original"_ns;
  expected.flags = 0x80000004;
  expected.tags = "tag-one tag-two"_ns;
  expected.threadId = parentThread;
  expected.threadParent = parent;
  CapturedMessage captured;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(key, captured));
  ExpectCapture(expected, captured);
  RefPtr<Message> live = new Message(key);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().SetMessageSubject(key, "later subject"_ns));
  nsCString text;
  ASSERT_EQ(NS_OK, live->GetSubject(text));
  EXPECT_EQ("later subject"_ns, text);
  ExpectCapture(expected, captured);
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(key));
  bool exists = true;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_FALSE(exists);
  EXPECT_EQ(NS_ERROR_UNEXPECTED,
            mCore->MessageDB().CaptureMessage(key, captured));
  ExpectCapture(expected, captured);
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
  ASSERT_EQ(
      NS_OK,
      PublicationCell(reader, key,
                      "SELECT count(*) FROM messages WHERE id = :id"_ns, text));
  EXPECT_EQ("0"_ns, text);
  ASSERT_EQ(NS_OK,
            PublicationCell(reader, parent,
                            "SELECT messageId FROM messages WHERE id = :id"_ns,
                            text));
  EXPECT_EQ("capture-parent@invalid"_ns, text);
}

TEST_F(DISABLED_DeliveryCoreReferences, CaptureMissingRowPreservesOutput) {
  ASSERT_EQ(NS_OK, Start());
  CapturedMessage output = CaptureSentinel();
  EXPECT_EQ(NS_ERROR_UNEXPECTED, mCore->MessageDB().CaptureMessage(0, output));
  ExpectCapture(CaptureSentinel(), output);
}

TEST_F(DISABLED_DeliveryCoreReferences, CaptureReadErrorPreservesOutput) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("capture-control@invalid"_ns, {}, control));
  CapturedMessage warm;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(control, warm));
  RefPtr<CaptureReadAbort> fault = new CaptureReadAbort();
  nsCOMPtr<mozIStorageProgressHandler> previous;
  ASSERT_EQ(NS_OK, mConnection->SetProgressHandler(1, fault,
                                                   getter_AddRefs(previous)));
  auto cleanup = MakeScopeExit([&] {
    nsCOMPtr<mozIStorageProgressHandler> removed;
    EXPECT_EQ(NS_OK,
              mConnection->RemoveProgressHandler(getter_AddRefs(removed)));
  });
  EXPECT_FALSE(previous);
  CapturedMessage output = CaptureSentinel();
  EXPECT_EQ(NS_ERROR_ABORT, mCore->MessageDB().CaptureMessage(control, output));
  EXPECT_GT(fault->mCalls, 0u);
  EXPECT_EQ(1u, fault->mAborts);
  ExpectCapture(CaptureSentinel(), output);
  nsCOMPtr<mozIStorageProgressHandler> removed;
  ASSERT_EQ(NS_OK, mConnection->RemoveProgressHandler(getter_AddRefs(removed)));
  cleanup.release();
  EXPECT_EQ(fault.get(), removed.get());
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(control, output));
  EXPECT_EQ(control, output.id);
  EXPECT_EQ(mFolderId, output.folderId);
  EXPECT_EQ("capture-control@invalid"_ns, output.messageId);
  EXPECT_EQ("subject"_ns, output.subject);
  bool inTransaction = true;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&inTransaction));
  EXPECT_FALSE(inTransaction);
}

TEST_F(DISABLED_DeliveryCoreReferences, PreparedBatchOwnsPendingPublication) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey first, second, publication, control;
  ASSERT_EQ(NS_OK, Add("batch-first@invalid"_ns, {}, first));
  ASSERT_EQ(NS_OK, Add("batch-second@invalid"_ns, {}, second));
  ASSERT_EQ(NS_OK, Add("batch-publication@invalid"_ns, {}, publication));
  ASSERT_EQ(NS_OK, Add("batch-control@invalid"_ns, {}, control));
  CapturedMessage oldFirst, oldSecond, added, unchanged;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(first, oldFirst));
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(second, oldSecond));
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(publication, added));
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(control, unchanged));
  // Compose a delta without changing stored threads or enabling dispatch.
  MessageThreadBatch batch;
  batch.batchId = 42;
  batch.before = {oldFirst, oldSecond, unchanged};
  batch.after = {oldFirst, oldSecond, unchanged, added};
  for (size_t i = 0; i < 2; ++i) {
    batch.after[i].threadId = added.threadId;
    batch.after[i].threadParent = publication;
  }
  batch.changedKeys = {first, second};
  if (first > second) {
    std::swap(batch.changedKeys[0], batch.changedKeys[1]);
  }
  nsTArray<nsMsgKey> expectedOrder = batch.changedKeys.Clone();
  nsMsgKey later = expectedOrder[1];
  batch.publicationKey = publication;
  batch.notifyLegacy = false;
  RefPtr<CapturedBatchObserver> observer = new CapturedBatchObserver();
  nsTArray<nsMsgKey> delivered;
  observer->mChanged = [&](const CapturedMessage& before,
                           const CapturedMessage& after, Message* live) {
    size_t index = delivered.Length();
    ASSERT_LT(index, 2u);
    EXPECT_EQ(expectedOrder[index], before.id);
    ExpectCapture(before.id == first ? oldFirst : oldSecond, before);
    EXPECT_EQ(before.id, after.id);
    EXPECT_EQ(added.threadId, after.threadId);
    EXPECT_EQ(publication, after.threadParent);
    EXPECT_EQ(before.id, live->Key());
    delivered.AppendElement(before.id);
    if (index == 0) {
      ASSERT_EQ(NS_OK,
                mCore->MessageDB().SetMessageSubject(later, "later edit"_ns));
      ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(later));
      ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(publication));
    } else {
      nsCString text;
      ASSERT_EQ(NS_OK, live->GetSubject(text));
      EXPECT_EQ("later edit"_ns, text);
      bool exists = true;
      ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(later, exists));
      EXPECT_FALSE(exists);
    }
  };
  observer->mCaptured = [&](const CapturedMessage& after, Message* live) {
    ExpectCapture(added, after);
    EXPECT_EQ(publication, live->Key());
    EXPECT_EQ(expectedOrder, delivered);
    bool exists = true;
    ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(publication, exists));
    EXPECT_FALSE(exists);
    delivered.AppendElement(publication);
  };
  PreparedThreadBatch prepared;
  ASSERT_EQ(NS_OK, observer->PrepareThreadBatch(batch, prepared));
  EXPECT_TRUE(delivered.IsEmpty());
  EXPECT_EQ(0u, observer->mAdded);
  ASSERT_EQ(4u, prepared.captured.after.Length());
  ExpectCapture(unchanged, prepared.captured.after[2]);
  batch.before[0].subject = "discarded before input"_ns;
  batch.after[3].subject = "discarded publication input"_ns;
  batch.before.Clear();
  batch.after.Clear();
  batch.changedKeys.Clear();
  observer->DeliverThreadBatch(prepared);
  expectedOrder.AppendElement(publication);
  EXPECT_EQ(expectedOrder, delivered);
  EXPECT_EQ(1u, observer->mAdded);
  EXPECT_FALSE(observer->mNotifyLegacy);
  EXPECT_EQ(42u, prepared.captured.batchId);
  CapturedMessage kept;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(control, kept));
  ExpectCapture(unchanged, kept);
}

TEST_F(DISABLED_DeliveryCoreReferences,
       BatchPreparationFailurePreservesOutput) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey publication;
  ASSERT_EQ(NS_OK, Add("prepare-publication@invalid"_ns, {}, publication));
  CapturedMessage added;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(publication, added));
  MessageThreadBatch batch;
  batch.after = {added};
  batch.publicationKey = publication;
  batch.notifyLegacy = false;
  uint32_t calls = 0;
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([&](Message* live, bool notifyLegacy) {
        ++calls;
        EXPECT_EQ(publication, live->Key());
        EXPECT_FALSE(notifyLegacy);
      });
  PreparedThreadBatch output;
  ASSERT_EQ(NS_OK, observer->PrepareThreadBatch(batch, output));
  Message* sentinel = output.publicationLive.get();
  EXPECT_EQ(0u, calls);
  batch.after.Clear();
  EXPECT_EQ(NS_ERROR_INVALID_ARG, observer->PrepareThreadBatch(batch, output));
  EXPECT_EQ(sentinel, output.publicationLive.get());
  ASSERT_EQ(1u, output.captured.after.Length());
  ExpectCapture(added, output.captured.after[0]);
  EXPECT_EQ(0u, calls);
  observer->DeliverThreadBatch(output);
  EXPECT_EQ(1u, calls);
}

TEST_F(DISABLED_DeliveryCoreReferences,
       CaptureReadsStagedSqlWithoutCacheMutation) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("capture-staged@invalid"_ns, {}, key));
  RefPtr<Message> live = new Message(key);
  nsCString text;
  ASSERT_EQ(NS_OK, live->GetSubject(text));
  EXPECT_EQ("subject"_ns, text);
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(
      NS_OK,
      mConnection->CreateStatement(
          "UPDATE messages SET subject = 'staged subject' WHERE id = :id"_ns,
          getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, key));
  ASSERT_EQ(NS_OK, stmt->Execute());
  ASSERT_EQ(NS_OK, stmt->Finalize());
  CapturedMessage captured;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(key, captured));
  EXPECT_EQ("staged subject"_ns, captured.subject);
  ASSERT_EQ(NS_OK, live->GetSubject(text));
  EXPECT_EQ("subject"_ns, text);
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  rollback.release();
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(key, captured));
  EXPECT_EQ("subject"_ns, captured.subject);
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
  ASSERT_EQ(NS_OK, PublicationCell(
                       reader, key,
                       "SELECT subject FROM messages WHERE id = :id"_ns, text));
  EXPECT_EQ("subject"_ns, text);
}

nsresult MakeDiscoveryFolders(DatabaseCore& core, uint64_t& a, uint64_t& b) {
  uint64_t root;
  MOZ_TRY(core.FolderDB().InsertRoot("discovery"_ns, &root));
  MOZ_TRY(core.FolderDB().InsertFolder(root, "A"_ns, &a));
  return core.FolderDB().InsertFolder(root, "B"_ns, &b);
}

nsresult AddDiscoveryMessage(MessageDatabase& db, uint64_t folderId,
                             const nsACString& messageId,
                             const nsTArray<nsCString>& references,
                             nsMsgKey& key,
                             const nsACString& subject = "subject"_ns) {
  RawHdr header;
  header.messageId = messageId;
  header.references = references.Clone();
  header.date = 1700000000000000;
  header.sender = "sender@conversation.invalid"_ns;
  header.recipients = "recipient@conversation.invalid"_ns;
  header.subject = subject;
  return db.AddMessage(folderId, header, true, &key);
}

void ExpectDiscovery(MessageDatabase& db, nsMsgKey seed,
                     const nsTArray<ConversationMember>& expected) {
  nsTArray<ConversationMember> actual;
  ASSERT_EQ(NS_OK, db.DiscoverConversationComponent(seed, actual));
  ASSERT_EQ(expected.Length(), actual.Length());
  for (size_t i = 1; i < actual.Length(); ++i) {
    EXPECT_LT(actual[i - 1].id, actual[i].id);
  }
  for (const auto& member : expected) {
    uint32_t matches = 0;
    for (const auto& found : actual) {
      if (found.id == member.id) {
        ++matches;
        EXPECT_EQ(member.folderId, found.folderId);
      }
    }
    EXPECT_EQ(1u, matches);
  }
}

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverOrderedCrossFolder) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t a, b;
  ASSERT_EQ(NS_OK, MakeDiscoveryFolders(*mCore, a, b));
  auto& db = mCore->MessageDB();
  const nsCString subject("Ordered conversation");
  nsMsgKey root, reply, tail, unrelated;
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, a, "ordered-root@conversation.invalid"_ns,
                                {}, root, subject));
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, b, "ordered-reply@conversation.invalid"_ns,
                                {"ordered-root@conversation.invalid"_ns}, reply,
                                subject));
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, a, "ordered-tail@conversation.invalid"_ns,
                                {"ordered-root@conversation.invalid"_ns,
                                 "ordered-reply@conversation.invalid"_ns},
                                tail, subject));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, b, "ordered-unrelated@conversation.invalid"_ns, {},
                       unrelated, subject));
  for (nsMsgKey seed : {root, reply, tail}) {
    ExpectDiscovery(db, seed, {{root, a}, {reply, b}, {tail, a}});
  }
  ExpectDiscovery(db, unrelated, {{unrelated, b}});
  nsTArray<nsCString> stored;
  ASSERT_EQ(NS_OK, Stored(tail, stored));
  EXPECT_EQ((nsTArray<nsCString>{"ordered-root@conversation.invalid"_ns,
                                 "ordered-reply@conversation.invalid"_ns}),
            stored);
}

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverReplyBeforeParent) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t a, b;
  ASSERT_EQ(NS_OK, MakeDiscoveryFolders(*mCore, a, b));
  auto& db = mCore->MessageDB();
  const nsCString subject("Reply before parent");
  nsMsgKey unrelated, reply, parent;
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, a, "reply-first-unrelated@conversation.invalid"_ns,
                       {}, unrelated, subject));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, b, "reply-first-child@conversation.invalid"_ns,
                       {"reply-first-parent@conversation.invalid"_ns}, reply,
                       subject));
  ExpectDiscovery(db, reply, {{reply, b}});
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, a, "reply-first-parent@conversation.invalid"_ns, {},
                       parent, subject));
  for (nsMsgKey seed : {reply, parent}) {
    ExpectDiscovery(db, seed, {{reply, b}, {parent, a}});
  }
  ExpectDiscovery(db, unrelated, {{unrelated, a}});
}

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverSiblingsWithoutParent) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t a, b;
  ASSERT_EQ(NS_OK, MakeDiscoveryFolders(*mCore, a, b));
  auto& db = mCore->MessageDB();
  const nsCString subject("Siblings without parent");
  nsMsgKey unrelated, first, second;
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(
                db, a, "siblings-missing-unrelated@conversation.invalid"_ns, {},
                unrelated, subject));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, a, "siblings-missing-first@conversation.invalid"_ns,
                       {"siblings-missing-parent@conversation.invalid"_ns},
                       first, subject));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, b, "siblings-missing-second@conversation.invalid"_ns,
                       {"siblings-missing-parent@conversation.invalid"_ns},
                       second, subject));
  for (nsMsgKey seed : {first, second}) {
    ExpectDiscovery(db, seed, {{first, a}, {second, b}});
  }
  ExpectDiscovery(db, unrelated, {{unrelated, a}});
}

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverSiblingsThenParent) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t a, b;
  ASSERT_EQ(NS_OK, MakeDiscoveryFolders(*mCore, a, b));
  auto& db = mCore->MessageDB();
  const nsCString subject("Siblings then parent");
  nsMsgKey first, second, unrelated, parent;
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, a, "siblings-late-first@conversation.invalid"_ns,
                       {"siblings-late-parent@conversation.invalid"_ns}, first,
                       subject));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, b, "siblings-late-second@conversation.invalid"_ns,
                       {"siblings-late-parent@conversation.invalid"_ns}, second,
                       subject));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, b, "siblings-late-unrelated@conversation.invalid"_ns,
                       {}, unrelated, subject));
  // Exercise the late arrival independently of the missing-parent assertion.
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(
                       db, a, "siblings-late-parent@conversation.invalid"_ns,
                       {}, parent, subject));
  for (nsMsgKey seed : {first, second, parent}) {
    ExpectDiscovery(db, seed, {{first, a}, {second, b}, {parent, a}});
  }
  ExpectDiscovery(db, unrelated, {{unrelated, b}});
}

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverDuplicatePhysicalCopies) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t a, b;
  ASSERT_EQ(NS_OK, MakeDiscoveryFolders(*mCore, a, b));
  auto& db = mCore->MessageDB();
  nsMsgKey first, second, child, unrelated;
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, a, "duplicate@invalid"_ns, {}, first));
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, b, "duplicate@invalid"_ns, {}, second));
  ASSERT_NE(first, second);
  ExpectDiscovery(db, first, {{first, a}});
  ExpectDiscovery(db, second, {{second, b}});
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, b, "unrelated@invalid"_ns, {}, unrelated));
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, a, "child@invalid"_ns,
                                {"duplicate@invalid"_ns, ""_ns,
                                 "absent@invalid"_ns, "duplicate@invalid"_ns},
                                child));
  ExpectDiscovery(db, child, {{first, a}, {second, b}, {child, a}});
  ExpectDiscovery(db, unrelated, {{unrelated, b}});
  nsTArray<nsCString> stored;
  ASSERT_EQ(NS_OK, Stored(child, stored));
  EXPECT_EQ((nsTArray<nsCString>{"duplicate@invalid"_ns, ""_ns,
                                 "absent@invalid"_ns, "duplicate@invalid"_ns}),
            stored);
}

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverWholeStoredComponent) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey root, child, incoming;
  ASSERT_EQ(NS_OK,
            AddDiscoveryMessage(db, mFolderId, "root@invalid"_ns, {}, root));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(db, mFolderId, "child@invalid"_ns,
                                       {"root@invalid"_ns}, child));
  CapturedMessage rootRow, childRow;
  ASSERT_EQ(NS_OK, db.CaptureMessage(root, rootRow));
  ASSERT_EQ(NS_OK, db.CaptureMessage(child, childRow));
  ASSERT_NE(0u, rootRow.threadId);
  ASSERT_EQ(rootRow.threadId, childRow.threadId);
  ASSERT_EQ(NS_OK, db.SetMessageReferences(child, {}));
  ASSERT_EQ(NS_OK, AddDiscoveryMessage(db, mFolderId, "incoming@invalid"_ns,
                                       {"child@invalid"_ns}, incoming));
  ExpectDiscovery(
      db, incoming,
      {{root, mFolderId}, {child, mFolderId}, {incoming, mFolderId}});
}

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverExactReferenceTokens) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey first, same, lower, spaced, composed, decomposed, emptyA, emptyB;
  ASSERT_EQ(NS_OK, Add("first@invalid"_ns, {"Missing@invalid"_ns}, first));
  ASSERT_EQ(NS_OK, Add("same@invalid"_ns, {"Missing@invalid"_ns}, same));
  ASSERT_EQ(NS_OK, Add("lower@invalid"_ns, {"missing@invalid"_ns}, lower));
  ASSERT_EQ(NS_OK, Add("spaced@invalid"_ns, {" Missing@invalid"_ns}, spaced));
  ASSERT_EQ(NS_OK,
            Add("composed@invalid"_ns, {"caf\xc3\xa9@invalid"_ns}, composed));
  ASSERT_EQ(NS_OK, Add("decomposed@invalid"_ns, {"cafe\xcc\x81@invalid"_ns},
                       decomposed));
  ASSERT_EQ(NS_OK, Add(""_ns, {}, emptyA));
  ASSERT_EQ(NS_OK, Add(""_ns, {}, emptyB));
  CapturedMessage emptyRowA, emptyRowB;
  ASSERT_EQ(NS_OK, db.CaptureMessage(emptyA, emptyRowA));
  ASSERT_EQ(NS_OK, db.CaptureMessage(emptyB, emptyRowB));
  ASSERT_NE(0u, emptyRowA.threadId);
  ASSERT_NE(0u, emptyRowB.threadId);
  ASSERT_NE(emptyRowA.threadId, emptyRowB.threadId);
  ASSERT_EQ(NS_OK, db.SetMessageReferences(emptyA, {""_ns}));
  ASSERT_EQ(NS_OK, db.SetMessageReferences(emptyB, {""_ns}));
  for (nsMsgKey key : {emptyA, emptyB}) {
    nsTArray<nsCString> emptyReferences;
    ASSERT_EQ(NS_OK, Stored(key, emptyReferences));
    ASSERT_EQ(1u, emptyReferences.Length());
    EXPECT_EQ((nsTArray<nsCString>{""_ns}), emptyReferences);
  }
  ExpectDiscovery(db, first, {{first, mFolderId}, {same, mFolderId}});
  for (nsMsgKey seed : {lower, spaced, composed, decomposed, emptyA, emptyB}) {
    ExpectDiscovery(db, seed, {{seed, mFolderId}});
  }
  nsTArray<nsCString> stored;
  ASSERT_EQ(NS_OK, Stored(decomposed, stored));
  EXPECT_EQ((nsTArray<nsCString>{"cafe\xcc\x81@invalid"_ns}), stored);
}

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverMissingRowPreservesOutput) {
  ASSERT_EQ(NS_OK, Start());
  nsTArray<ConversationMember> output{{0xfffffff0, 0x123456789ULL}};
  EXPECT_EQ(NS_ERROR_UNEXPECTED,
            mCore->MessageDB().DiscoverConversationComponent(0, output));
  ASSERT_EQ(1u, output.Length());
  EXPECT_EQ(0xfffffff0u, output[0].id);
  EXPECT_EQ(0x123456789ULL, output[0].folderId);
}

TEST_F(DISABLED_DeliveryCoreReferences,
       DiscoverUnavailableHistoryPreservesOutput) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey known, unknown;
  ASSERT_EQ(NS_OK, Add("known@invalid"_ns, {}, known));
  ASSERT_EQ(NS_OK, Add("unknown@invalid"_ns, {}, unknown));
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(NS_OK, mConnection->CreateStatement(
                       "DELETE FROM message_reference_sets WHERE id = :id"_ns,
                       getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, unknown));
  ASSERT_EQ(NS_OK, stmt->Execute());
  ASSERT_EQ(NS_OK, stmt->Finalize());
  nsTArray<ConversationMember> output{{0xfffffff0, 0x123456789ULL}};
  // Even unrelated lost history could hide a reverse/shared edge.
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.DiscoverConversationComponent(known, output));
  ASSERT_EQ(1u, output.Length());
  EXPECT_EQ(0xfffffff0u, output[0].id);
  EXPECT_EQ(0x123456789ULL, output[0].folderId);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.DiscoverConversationComponent(unknown, output));
  ASSERT_EQ(NS_OK, db.SetMessageReferences(unknown, {}));
  ExpectDiscovery(db, known, {{known, mFolderId}});
  ExpectDiscovery(db, unknown, {{unknown, mFolderId}});
}

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverReadErrorPreservesOutput) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("discovery-control@invalid"_ns, {}, control));
  ExpectDiscovery(db, control, {{control, mFolderId}});
  RefPtr<CaptureReadAbort> fault = new CaptureReadAbort();
  nsCOMPtr<mozIStorageProgressHandler> previous;
  ASSERT_EQ(NS_OK, mConnection->SetProgressHandler(1, fault,
                                                   getter_AddRefs(previous)));
  auto cleanup = MakeScopeExit([&] {
    nsCOMPtr<mozIStorageProgressHandler> removed;
    EXPECT_EQ(NS_OK,
              mConnection->RemoveProgressHandler(getter_AddRefs(removed)));
  });
  EXPECT_FALSE(previous);
  nsTArray<ConversationMember> output{{0xfffffff0, 0x123456789ULL}};
  EXPECT_EQ(NS_ERROR_ABORT, db.DiscoverConversationComponent(control, output));
  EXPECT_GT(fault->mCalls, 0u);
  EXPECT_EQ(1u, fault->mAborts);
  ASSERT_EQ(1u, output.Length());
  EXPECT_EQ(0xfffffff0u, output[0].id);
  EXPECT_EQ(0x123456789ULL, output[0].folderId);
  nsCOMPtr<mozIStorageProgressHandler> removed;
  ASSERT_EQ(NS_OK, mConnection->RemoveProgressHandler(getter_AddRefs(removed)));
  cleanup.release();
  EXPECT_EQ(fault.get(), removed.get());
  ExpectDiscovery(db, control, {{control, mFolderId}});
  bool inTransaction = true;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&inTransaction));
  EXPECT_FALSE(inTransaction);
}

TEST_F(DISABLED_DeliveryCoreReferences, DiscoverReadsStagedReferences) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey child, parent;
  ASSERT_EQ(NS_OK, Add("child@invalid"_ns, {"absent@invalid"_ns}, child));
  ASSERT_EQ(NS_OK, Add("present@invalid"_ns, {}, parent));
  ExpectDiscovery(db, child, {{child, mFolderId}});
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(
      NS_OK,
      mConnection->CreateStatement(
          "UPDATE message_references SET token = 'present@invalid' WHERE id = :id"_ns,
          getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, child));
  ASSERT_EQ(NS_OK, stmt->Execute());
  ASSERT_EQ(NS_OK, stmt->Finalize());
  ExpectDiscovery(db, child, {{child, mFolderId}, {parent, mFolderId}});
  bool inTransaction = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&inTransaction));
  EXPECT_TRUE(inTransaction);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  rollback.release();
  ExpectDiscovery(db, child, {{child, mFolderId}});
  nsTArray<nsCString> stored;
  ASSERT_EQ(NS_OK, Stored(child, stored));
  EXPECT_EQ((nsTArray<nsCString>{"absent@invalid"_ns}), stored);
}

TEST_F(DeliveryCoreReferences, StagingKeepsPhysicalIdentityOutOfMembership) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("published@invalid"_ns, {}, control));
  uint32_t publications = 0;
  nsMsgKey staged = nsMsgKey_None;
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([&](Message* message, bool notifyLegacy) {
        ++publications;
        EXPECT_FALSE(notifyLegacy);
        nsMsgKey observed;
        ASSERT_EQ(NS_OK, message->GetMessageKey(&observed));
        EXPECT_EQ(staged, observed);
        bool active = true;
        ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
        EXPECT_FALSE(active);
        nsCString text;
        ASSERT_EQ(NS_OK, message->GetStoreToken(text));
        EXPECT_EQ("finished-token"_ns, text);
        ASSERT_EQ(NS_OK, message->GetStringProperty("keywords", text));
        EXPECT_EQ("filtered"_ns, text);
        uint32_t flags;
        ASSERT_EQ(NS_OK, message->GetFlags(&flags));
        EXPECT_EQ(5u, flags);
        nsTArray<nsCString> stored;
        ASSERT_EQ(NS_OK, Stored(observed, stored));
        EXPECT_EQ(
            (nsTArray<nsCString>{"missing@invalid"_ns, "missing@invalid"_ns}),
            stored);
        nsCOMPtr<mozIStorageConnection> reader;
        ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
        auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
        const RawHdr::kv expected[] = {{"custom"_ns, "00042:text"_ns},
                                       {"Custom"_ns, "1e3:text"_ns}};
        for (const auto& property : expected) {
          ASSERT_EQ(NS_OK,
                    PublicationCell(
                        reader, observed,
                        "SELECT value || ':' || typeof(value) FROM "
                        "message_properties WHERE id = :id AND name = :name"_ns,
                        text, &property.k));
          EXPECT_EQ(property.v, text);
        }
      });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  RawHdr raw;
  raw.messageId = "staged@invalid"_ns;
  raw.subject = "staged subject"_ns;
  raw.references = {"missing@invalid"_ns, "missing@invalid"_ns};
  raw.extras = {{"custom"_ns, "00042"_ns}, {"Custom"_ns, "1e3"_ns}};
  RefPtr<Message> header;
  ASSERT_EQ(NS_OK,
            db.StageMessage(mFolderId, raw, &staged, getter_AddRefs(header)));
  EXPECT_NE(0u, staged);
  EXPECT_NE(nsMsgKey_None, staged);
  EXPECT_NE(control, staged);
  nsCString text;
  ASSERT_EQ(NS_OK, header->GetSubject(text));
  EXPECT_EQ("staged subject"_ns, text);
  ASSERT_EQ(NS_OK, header->GetStringProperty("custom", text));
  EXPECT_EQ("00042"_ns, text);
  ASSERT_EQ(NS_OK, header->GetStringProperty("Custom", text));
  EXPECT_EQ("1e3"_ns, text);
  ASSERT_EQ(NS_OK, header->SetFlags(5));
  ASSERT_EQ(NS_OK, header->SetStringProperty("keywords", "filtered"_ns));
  ASSERT_EQ(NS_OK, header->SetStoreToken("finished-token"_ns));
  EXPECT_EQ(0u, observer->mChanges);
  EXPECT_EQ(0u, publications);
  bool exists = true;
  ASSERT_EQ(NS_OK, db.MessageExists(staged, exists));
  EXPECT_FALSE(exists);
  uint64_t count = 99;
  ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
  EXPECT_EQ(1u, count);
  nsTArray<nsMsgKey> pending;
  ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, pending));
  EXPECT_EQ((nsTArray<nsMsgKey>{staged}), pending);
  ASSERT_EQ(NS_OK,
            PublicationCell(
                mConnection, staged,
                "SELECT count(*) FROM message_changes WHERE messageId = :id"_ns,
                text));
  EXPECT_EQ("0"_ns, text);
  ASSERT_EQ(NS_OK, db.PublishMessage(staged, false));
  EXPECT_EQ(1u, publications);
  ASSERT_EQ(NS_OK, db.MessageExists(staged, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
  EXPECT_EQ(2u, count);
  ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, pending));
  EXPECT_TRUE(pending.IsEmpty());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.PublishMessage(staged, true));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.AbortMessage(staged));
  EXPECT_EQ(1u, publications);
}

TEST_F(DeliveryCoreReferences, StagedHeaderAndReservedKeySurviveReopen) {
  ASSERT_EQ(NS_OK, Start());
  RawHdr raw;
  raw.messageId = "restart-staged@invalid"_ns;
  raw.subject = "retained header"_ns;
  raw.storeToken = Some(nsCString("retained-body"_ns));
  raw.references = {"first@invalid"_ns, "last@invalid"_ns};
  nsMsgKey staged;
  ASSERT_EQ(NS_OK, mCore->MessageDB().StageMessage(mFolderId, raw, &staged));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsTArray<nsMsgKey> pending;
  ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, pending));
  EXPECT_EQ((nsTArray<nsMsgKey>{staged}), pending);
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK, db.GetMessage(staged, getter_AddRefs(header)));
  nsCString text;
  ASSERT_EQ(NS_OK, header->GetStoreToken(text));
  EXPECT_EQ("retained-body"_ns, text);
  ASSERT_EQ(NS_OK, header->GetSubject(text));
  EXPECT_EQ("retained header"_ns, text);
  nsTArray<nsCString> refs;
  ASSERT_EQ(NS_OK, db.GetMessageReferences(staged, refs));
  EXPECT_EQ((nsTArray<nsCString>{"first@invalid"_ns, "last@invalid"_ns}), refs);
  nsMsgKey later, newest;
  ASSERT_EQ(NS_OK, Add("later@invalid"_ns, {}, later));
  EXPECT_GT(later, staged);
  ASSERT_EQ(NS_OK, db.PublishMessage(staged, true));
  ASSERT_EQ(NS_OK, Add("newest@invalid"_ns, {}, newest));
  EXPECT_GT(newest, later);
}

TEST_F(DeliveryCoreReferences, AbortDropsOnlyStagedMetadataAndRetiresKey) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  RawHdr raw;
  raw.messageId = "abort@invalid"_ns;
  raw.storeToken = Some(nsCString("finished-body-owned-by-store"_ns));
  raw.extras = {{"custom"_ns, "preserved text"_ns}};
  raw.references = {"missing@invalid"_ns};
  nsMsgKey staged, control;
  ASSERT_EQ(NS_OK, Add("survivor@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  ASSERT_EQ(NS_OK, db.AbortMessage(staged));
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, db.MessageExists(staged, exists));
  EXPECT_FALSE(exists);
  nsCString text;
  ASSERT_EQ(
      NS_OK,
      PublicationCell(
          mConnection, staged,
          "SELECT (SELECT count(*) FROM staged_messages WHERE id = :id) + "
          "(SELECT count(*) FROM staged_message_properties WHERE id = :id) + "
          "(SELECT count(*) FROM staged_message_references WHERE id = :id) + "
          "(SELECT count(*) FROM staged_message_reference_sets WHERE id = :id)"_ns,
          text));
  EXPECT_EQ("0"_ns, text);
  nsMsgKey next;
  ASSERT_EQ(NS_OK, Add("next@invalid"_ns, {}, next));
  EXPECT_GT(next, staged);
}

TEST_F(DeliveryCoreReferences, PublicationFailureRetainsStagingAndOutput) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("control@invalid"_ns, {}, control));
  uint32_t publications = 0;
  RefPtr<AddedObserver> observer = new AddedObserver([&](Message* message) {
    ++publications;
    nsCString value;
    ASSERT_EQ(NS_OK, message->GetStringProperty("reject-publication", value));
    EXPECT_EQ("complete"_ns, value);
  });
  db.AddMessageListener(observer);
  auto remove = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  RawHdr raw;
  raw.messageId = "retry@invalid"_ns;
  raw.extras = {{"reject-publication"_ns, "complete"_ns}};
  nsMsgKey staged;
  RefPtr<Message> header;
  ASSERT_EQ(NS_OK,
            db.StageMessage(mFolderId, raw, &staged, getter_AddRefs(header)));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "CREATE TEMP TRIGGER reject_publication BEFORE INSERT ON "
                "message_properties "
                "WHEN NEW.name = 'reject-publication' BEGIN "
                "SELECT RAISE(ABORT, 'publication property failure'); END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS reject_publication"_ns));
  });
  Message* output = header.get();
  EXPECT_TRUE(NS_FAILED(db.PublishMessage(staged, true, &output)));
  EXPECT_EQ(header.get(), output);
  EXPECT_EQ(0u, publications);
  bool active = true, exists = true;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_EQ(NS_OK, db.MessageExists(staged, exists));
  EXPECT_FALSE(exists);
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
  nsCString text;
  ASSERT_EQ(NS_OK, header->GetStringProperty("reject-publication", text));
  EXPECT_EQ("complete"_ns, text);
  ASSERT_EQ(NS_OK,
            PublicationCell(
                mConnection, staged,
                "SELECT count(*) FROM message_changes WHERE messageId = :id"_ns,
                text));
  EXPECT_EQ("0"_ns, text);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER reject_publication"_ns));
  ASSERT_EQ(NS_OK, db.PublishMessage(staged, true));
  EXPECT_EQ(1u, publications);
  ASSERT_EQ(NS_OK, db.MessageExists(staged, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreReferences,
       StagingFailurePreservesOutputsAndForeignTransaction) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("staging-control@invalid"_ns, {}, control));
  RefPtr<Message> controlHeader = new Message(control);
  RawHdr raw;
  raw.messageId = "failed-staging@invalid"_ns;
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_stage BEFORE INSERT ON "
          "staged_message_reference_sets "
          "BEGIN SELECT RAISE(ABORT, 'stage reference failure'); END"_ns));
  nsMsgKey key = 123;
  Message* outputHeader = controlHeader.get();
  EXPECT_TRUE(NS_FAILED(db.StageMessage(mFolderId, raw, &key, &outputHeader)));
  EXPECT_EQ(controlHeader.get(), outputHeader);
  EXPECT_EQ(123u, key);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER reject_stage"_ns));
  nsTArray<nsMsgKey> pending;
  ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, pending));
  EXPECT_TRUE(pending.IsEmpty());
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &key));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  nsMsgKey output = 456;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.StageMessage(mFolderId, raw, &output));
  EXPECT_EQ(456u, output);
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.PublishMessage(key, true));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.AbortMessage(key));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
}

TEST_F(DeliveryCoreReferences,
       EpochChangeRetiresStagedBindingWithoutLosingHeader) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 11));
  RawHdr raw;
  raw.messageId = "old-epoch@invalid"_ns;
  raw.storeToken = Some(nsCString("retained-body"_ns));
  raw.extras = {{"uidOnServer"_ns, "2a"_ns}, {"UidOnServer"_ns, "keep"_ns}};
  nsMsgKey key;
  RefPtr<Message> header;
  ASSERT_EQ(NS_OK,
            db.StageMessage(mFolderId, raw, &key, getter_AddRefs(header)));
  uint32_t uid = 99;
  ASSERT_EQ(NS_OK, header->GetUint32Property("uidOnServer", &uid));
  EXPECT_EQ(42u, uid);
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 12));
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(key, names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  EXPECT_TRUE(names.Contains("UidOnServer"_ns));
  nsCString token;
  ASSERT_EQ(NS_OK, header->GetStoreToken(token));
  EXPECT_EQ("retained-body"_ns, token);
  ASSERT_EQ(NS_OK, db.PublishMessage(key, true));
  nsMsgKey output = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetMessageKeyForServerUid(mFolderId, 12, 42, output));
  EXPECT_EQ(123u, output);
}

TEST_F(DeliveryCoreReferences, ImmediateAddRetainsMissingFolderCompatibility) {
  ASSERT_EQ(NS_OK, Start());
  RawHdr raw;
  raw.messageId = "no-folder@invalid"_ns;
  const uint64_t missingFolder = mFolderId + 1;
  nsMsgKey published;
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.AddMessage(missingFolder, raw, true, &published));
  bool exists = false;
  ASSERT_EQ(NS_OK, db.MessageExists(published, exists));
  EXPECT_TRUE(exists);
  nsMsgKey output = 77;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.StageMessage(missingFolder, raw, &output));
  EXPECT_EQ(77u, output);
  EXPECT_EQ(NS_ERROR_INVALID_ARG, db.StageMessage(0, raw, &output));
  EXPECT_EQ(77u, output);
}

TEST_F(DeliveryCoreReferences, MissingFolderPublicationRetainsStagedHeader) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t destination;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "Destination"_ns,
                                                  &destination));
  RawHdr raw;
  raw.messageId = "removed-folder@invalid"_ns;
  raw.storeToken = Some(nsCString("retained-body"_ns));
  nsMsgKey key;
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.StageMessage(destination, raw, &key));
  ASSERT_EQ(NS_OK, mCore->FolderDB().DeleteFolder(destination));
  EXPECT_EQ(NS_ERROR_UNEXPECTED, db.PublishMessage(key, true));
  nsTArray<nsMsgKey> staged;
  ASSERT_EQ(NS_OK, db.ListStagedMessages(destination, staged));
  EXPECT_EQ((nsTArray<nsMsgKey>{key}), staged);
  bool exists = true;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_FALSE(exists);
  nsCString token;
  ASSERT_EQ(NS_OK, db.GetMessageStoreToken(key, token));
  EXPECT_EQ("retained-body"_ns, token);
}

TEST_F(DeliveryCoreReferences, OfflineDeletesUseProtocolDeletedFlag) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey deleted, mdnSent, moved, copied;
  ASSERT_EQ(NS_OK, Add("protocol-deleted@invalid"_ns, {}, deleted));
  ASSERT_EQ(NS_OK, Add("protocol-mdn@invalid"_ns, {}, mdnSent));
  ASSERT_EQ(NS_OK, Add("protocol-moved@invalid"_ns, {}, moved));
  ASSERT_EQ(NS_OK, Add("protocol-copied@invalid"_ns, {}, copied));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kFlagsChanged;
  input.newFlags = kImapMsgDeletedFlag;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, deleted, input));
  input.newFlags = kImapMsgMDNSentFlag;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, mdnSent, input));
  input.operation = nsIMsgOfflineImapOperation::kMsgMoved;
  input.newFlags = 0;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, moved, input));
  // Copy: a flag value alone does not make it a deletion.
  input.operation = nsIMsgOfflineImapOperation::kMsgCopy;
  input.newFlags = kImapMsgDeletedFlag;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, copied, input));
  ASSERT_EQ(NS_OK, db.RemoveMessage(deleted));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().ListOfflineOperations(mFolderId, true, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{deleted, moved}), keys);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().ListOfflineOperations(mFolderId, false, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{deleted, mdnSent, moved, copied}), keys);
  bool exists = true;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(deleted, exists));
  EXPECT_FALSE(exists);
}

TEST_F(DeliveryCoreReferences,
       CombinedOfflinePayloadSurvivesDeletionAndReopen) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 7));
  auto& db = mCore->MessageDB();
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, Add("offline@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, Add("control@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.SetMessageUidOnServer(key, 42));
  OfflineOperationData input;
  input.operation = 1 | 2 | 4 | 0x400 | 0x800;
  input.flagOperation = 0x80000000;
  input.newFlags = UINT32_MAX;
  input.sourceKey = control;
  input.sourceUid = UINT32_MAX;
  input.messageSize = UINT32_MAX;
  input.playingBack = false;
  input.sourceFolderURI = "imap://source/Inbox"_ns;
  input.destinationFolderURI = "imap://destination/Moved"_ns;
  input.keywordsToAdd = "first second"_ns;
  input.keywordsToRemove = "old"_ns;
  input.copyDestinations = {"imap://destination/One"_ns,
                            "imap://destination/Two"_ns,
                            "imap://destination/One"_ns};
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, input));
  ASSERT_EQ(NS_OK, db.SetOfflineOperationPlayingBack(mFolderId, key, true));
  ASSERT_NO_FATAL_FAILURE(CheckOfflineSource(key, 7, 42));
  ASSERT_EQ(NS_OK, db.RemoveMessage(key));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  OfflineOperationData stored;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetOfflineOperation(mFolderId, key, stored));
  EXPECT_EQ(uint32_t(1 | 2 | 4 | 0x400 | 0x800), stored.operation);
  EXPECT_EQ(0x80000000u, stored.flagOperation);
  EXPECT_EQ(UINT32_MAX, stored.newFlags);
  EXPECT_EQ(control, stored.sourceKey);
  EXPECT_EQ(UINT32_MAX, stored.sourceUid);
  EXPECT_EQ(UINT32_MAX, stored.messageSize);
  EXPECT_TRUE(stored.playingBack);
  EXPECT_EQ("imap://source/Inbox"_ns, stored.sourceFolderURI);
  EXPECT_EQ("imap://destination/Moved"_ns, stored.destinationFolderURI);
  EXPECT_EQ("first second"_ns, stored.keywordsToAdd);
  EXPECT_EQ("old"_ns, stored.keywordsToRemove);
  EXPECT_EQ((nsTArray<nsCString>{"imap://destination/One"_ns,
                                 "imap://destination/Two"_ns,
                                 "imap://destination/One"_ns}),
            stored.copyDestinations);
  nsTArray<nsMsgKey> deletes;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().ListOfflineOperations(mFolderId, true, deletes));
  EXPECT_EQ((nsTArray<nsMsgKey>{key}), deletes);
  ASSERT_NO_FATAL_FAILURE(CheckOfflineSource(key, 7, 42));
  stored.keywordsToAdd = "later edit"_ns;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().StoreOfflineOperation(mFolderId, key, stored));
  ASSERT_NO_FATAL_FAILURE(CheckOfflineSource(key, 7, 42));
  OfflineOperationData edited;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetOfflineOperation(mFolderId, key, edited));
  EXPECT_EQ("later edit"_ns, edited.keywordsToAdd);
  EXPECT_EQ(stored.copyDestinations, edited.copyDestinations);
  bool exists;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(control, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_FALSE(exists);
}

TEST_F(DeliveryCoreReferences,
       OfflinePayloadErrorsPreservePayloadAndReadOutput) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, Add("offline-error@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, Add("control@invalid"_ns, {}, control));
  OfflineOperationData input;
  input.operation = 4;
  input.keywordsToAdd = "original"_ns;
  input.copyDestinations = {"first"_ns, "second"_ns};
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, input));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_offline_copy BEFORE INSERT ON "
          "offline_copy_destinations "
          "WHEN NEW.uri = 'reject' BEGIN SELECT RAISE(ABORT, 'copy failure'); END"_ns));
  input.keywordsToAdd = "replacement"_ns;
  input.copyDestinations = {"new-first"_ns, "reject"_ns};
  EXPECT_TRUE(NS_FAILED(db.StoreOfflineOperation(mFolderId, key, input)));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER reject_offline_copy"_ns));
  OfflineOperationData stored;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, key, stored));
  EXPECT_EQ("original"_ns, stored.keywordsToAdd);
  EXPECT_EQ((nsTArray<nsCString>{"first"_ns, "second"_ns}),
            stored.copyDestinations);
  stored.keywordsToAdd = "sentinel"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetOfflineOperation(mFolderId, nsMsgKey_None, stored));
  EXPECT_EQ("sentinel"_ns, stored.keywordsToAdd);
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP VIEW offline_copy_destinations AS SELECT * "
          "FROM main.offline_copy_destinations WHERE abs(-9223372036854775808)"_ns));
  EXPECT_TRUE(NS_FAILED(db.GetOfflineOperation(mFolderId, key, stored)));
  EXPECT_EQ("sentinel"_ns, stored.keywordsToAdd);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.offline_copy_destinations"_ns));
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, key, stored));
  EXPECT_EQ("original"_ns, stored.keywordsToAdd);
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreReferences, ReservedOfflineKeySurvivesReopenWithoutMessage) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().ReserveOfflineOperationKey(mFolderId, key));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  OfflineOperationData payload;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetOfflineOperation(mFolderId, key, payload));
  EXPECT_EQ(0u, payload.operation);
  bool exists = true;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_FALSE(exists);
  nsMsgKey next;
  ASSERT_EQ(NS_OK, Add("after-reservation@invalid"_ns, {}, next));
  EXPECT_GT(next, key);
}

TEST_F(DeliveryCoreReferences,
       AppendAttemptRetainsDestinationIdentityAcrossReopen) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 17));
  RawHdr raw;
  raw.messageId = "append@invalid"_ns;
  raw.storeToken = Some(nsCString("finished-destination-body"_ns));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, mCore->MessageDB().StageMessage(mFolderId, raw, &key));
  OfflineOperationData payload;
  payload.operation = 0x10;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().StoreOfflineOperation(mFolderId, key, payload));
  uint64_t attemptId = 99;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().BeginOfflineAttempt(
                mFolderId, key, 0x10,
                Some(PendingDestination{mFolderId, key, 17}), attemptId));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, mCore->MessageDB().AbortMessage(key));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, db.GetCurrentOfflineAttempt(mFolderId, key, attempt));
  EXPECT_EQ(attemptId, attempt.id);
  EXPECT_EQ(OfflineAttemptState::Sent, attempt.state);
  OfflineAttempt unchanged;
  unchanged.id = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.GetOfflineAttempt(INT64_MAX, unchanged));
  EXPECT_EQ(123u, unchanged.id);
  EXPECT_FALSE(attempt.source);
  ASSERT_TRUE(attempt.destination);
  EXPECT_EQ(key, attempt.destination->key);
  EXPECT_EQ(mFolderId, attempt.destination->folderId);
  EXPECT_EQ(17u, attempt.destination->epoch);
  ASSERT_EQ(NS_OK, db.MarkOfflineAttemptAmbiguous(attemptId));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& recovered = mCore->MessageDB();
  ASSERT_EQ(NS_OK, recovered.GetCurrentOfflineAttempt(mFolderId, key, attempt));
  EXPECT_EQ(attemptId, attempt.id);
  EXPECT_EQ(OfflineAttemptState::Ambiguous, attempt.state);
  EXPECT_EQ(0x10u, attempt.operation);
  ASSERT_EQ(NS_OK,
            recovered.SetOfflineOperationPlayingBack(mFolderId, key, true));
  ASSERT_EQ(NS_OK, recovered.GetCurrentOfflineAttempt(mFolderId, key, attempt));
  EXPECT_EQ(OfflineAttemptState::Ambiguous, attempt.state);
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            recovered.StoreOfflineOperation(mFolderId, key, payload));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            recovered.RemoveOfflineOperation(mFolderId, key));
  ASSERT_EQ(NS_OK, recovered.ConfirmOfflineAttempt(
                       attemptId, Some(ServerUidConfirmation{17, UINT32_MAX})));
  ASSERT_EQ(NS_OK, recovered.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Confirmed, attempt.state);
  EXPECT_EQ(Some(uint32_t(UINT32_MAX)), attempt.confirmedUid);
  bool exists = true;
  ASSERT_EQ(NS_OK, recovered.MessageExists(key, exists));
  EXPECT_FALSE(exists);
  ASSERT_EQ(NS_OK, recovered.PublishMessage(key, true));
  nsMsgKey found = nsMsgKey_None;
  ASSERT_EQ(NS_OK, recovered.GetMessageKeyForServerUid(mFolderId, 17,
                                                       UINT32_MAX, found));
  EXPECT_EQ(key, found);
  ASSERT_EQ(NS_OK, recovered.ConfirmOfflineAttempt(
                       attemptId, Some(ServerUidConfirmation{17, UINT32_MAX})));
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            recovered.ConfirmOfflineAttempt(
                attemptId, Some(ServerUidConfirmation{17, 42})));
}

TEST_F(DeliveryCoreReferences, StaleAttemptNeedsExplicitResolutionBeforeRetry) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 27));
  RawHdr raw;
  raw.messageId = "stale-append@invalid"_ns;
  raw.storeToken = Some(nsCString("retained-body"_ns));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &key));
  OfflineOperationData payload;
  payload.operation = 0x10;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  uint64_t attemptId;
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(mFolderId, key, 0x10,
                                   Some(PendingDestination{mFolderId, key, 27}),
                                   attemptId));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 28));
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      db.ConfirmOfflineAttempt(attemptId, Some(ServerUidConfirmation{27, 42})));
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Sent, attempt.state);
  uint64_t untouched = 123;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.BeginOfflineAttempt(mFolderId, key, 0x10,
                                   Some(PendingDestination{mFolderId, key, 28}),
                                   untouched));
  EXPECT_EQ(123u, untouched);
  // No network is dispatched in this fixture: the operation had no server
  // effect.
  ASSERT_EQ(NS_OK, db.ResolveOfflineAttemptNotApplied(attemptId));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Pending, attempt.state);
  ASSERT_EQ(NS_OK, db.AbortMessage(key));
}

TEST_F(DeliveryCoreReferences, ConflictingConfirmationDoesNotBindDestination) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 31));
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("bound-control@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(control, mFolderId, 31, 55));
  RawHdr raw;
  raw.messageId = "pending-destination@invalid"_ns;
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &key));
  OfflineOperationData payload;
  payload.operation = 0x10;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  uint64_t attemptId;
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(mFolderId, key, 0x10,
                                   Some(PendingDestination{mFolderId, key, 31}),
                                   attemptId));
  EXPECT_EQ(
      NS_ERROR_FILE_CORRUPTED,
      db.ConfirmOfflineAttempt(attemptId, Some(ServerUidConfirmation{31, 55})));
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(key, names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Sent, attempt.state);
  nsMsgKey found = nsMsgKey_None;
  ASSERT_EQ(NS_OK, db.GetMessageKeyForServerUid(mFolderId, 31, 55, found));
  EXPECT_EQ(control, found);
}

TEST_F(DeliveryCoreReferences, ConfirmationStorageFailureRollsBackUidAndState) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 41));
  RawHdr raw;
  raw.messageId = "confirm-error@invalid"_ns;
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &key));
  OfflineOperationData payload;
  payload.operation = 0x10;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  uint64_t attemptId;
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(mFolderId, key, 0x10,
                                   Some(PendingDestination{mFolderId, key, 41}),
                                   attemptId));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_confirmation BEFORE UPDATE ON "
          "offline_attempts "
          "WHEN NEW.state = 2 BEGIN SELECT RAISE(ABORT, 'confirmation failure'); END"_ns));
  EXPECT_TRUE(NS_FAILED(db.ConfirmOfflineAttempt(
      attemptId, Some(ServerUidConfirmation{41, 42}))));
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(key, names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Sent, attempt.state);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER reject_confirmation"_ns));
  ASSERT_EQ(NS_OK, db.ConfirmOfflineAttempt(
                       attemptId, Some(ServerUidConfirmation{41, 42})));
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(key, names));
  EXPECT_TRUE(names.Contains("uidOnServer"_ns));
}

TEST_F(DeliveryCoreReferences, FolderWideOperationHasNoInventedMessageBinding) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 51));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.ReserveOfflineOperationKey(mFolderId, key));
  OfflineOperationData payload;
  payload.operation = 0x200;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  bool exists = true;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_FALSE(exists);
  uint64_t attemptId;
  ASSERT_EQ(NS_OK, db.BeginOfflineAttempt(mFolderId, key, 0x200, Nothing(),
                                          attemptId));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetCurrentOfflineAttempt(mFolderId, key,
                                                               attempt));
  EXPECT_EQ(attemptId, attempt.id);
  EXPECT_FALSE(attempt.source);
  EXPECT_FALSE(attempt.destination);
  EXPECT_EQ(Some(uint32_t(51)), attempt.folderEpoch);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().ConfirmOfflineAttempt(attemptId, Nothing()));
  nsMsgKey next;
  ASSERT_EQ(NS_OK, Add("next@invalid"_ns, {}, next));
  EXPECT_GT(next, key);
}

TEST_F(DeliveryCoreReferences, DeletedSourceRetainsExactDispatchedTuple) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 61));
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, Add("deleted-source@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, Add("survivor@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 61, 700));
  OfflineOperationData payload;
  payload.operation = 1;
  payload.newFlags = 128;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  ASSERT_EQ(NS_OK, db.RemoveMessage(key));
  uint64_t attemptId;
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(mFolderId, key, 1, Nothing(), attemptId));
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  ASSERT_TRUE(attempt.source);
  EXPECT_EQ(mFolderId, attempt.source->folderId);
  EXPECT_EQ(key, attempt.source->key);
  EXPECT_EQ(61u, attempt.source->epoch);
  EXPECT_EQ(700u, attempt.source->uid);
  EXPECT_EQ(1u, attempt.operation);
  EXPECT_NE(key, attempt.source->uid);
  ASSERT_EQ(NS_OK, db.ConfirmOfflineAttempt(attemptId, Nothing()));
  ASSERT_EQ(NS_OK, db.RemoveOfflineOperation(mFolderId, key));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Confirmed, attempt.state);
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_FALSE(exists);
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreReferences, QueuedFolderWideOperationRejectsChangedEpoch) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 71));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.ReserveOfflineOperationKey(mFolderId, key));
  OfflineOperationData payload;
  payload.operation = 0x200;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 72));
  // Saving other payload metadata does not retarget an existing deletion
  // intent.
  payload.keywordsToAdd = "retained metadata"_ns;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  uint64_t attemptId = 123;
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      db.BeginOfflineAttempt(mFolderId, key, 0x200, Nothing(), attemptId));
  EXPECT_EQ(123u, attemptId);
  OfflineOperationData stored;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, key, stored));
  EXPECT_EQ(0x200u, stored.operation);
  EXPECT_EQ("retained metadata"_ns, stored.keywordsToAdd);
}

TEST_F(DeliveryCoreReferences, QueuedSourceIsNotSilentlyRetargeted) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 81));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("queued-source@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 81, 42));
  OfflineOperationData payload;
  payload.operation = 1;
  payload.newFlags = 128;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 81, 43));
  payload.keywordsToAdd = "another edit"_ns;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  uint64_t attemptId = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineAttempt(mFolderId, key, 1, Nothing(), attemptId));
  EXPECT_EQ(123u, attemptId);
  nsMsgKey found = nsMsgKey_None;
  ASSERT_EQ(NS_OK, db.GetMessageKeyForServerUid(mFolderId, 81, 43, found));
  EXPECT_EQ(key, found);
}

TEST_F(DeliveryCoreReferences, SentAttemptDestinationCannotBeReused) {
  CheckUsedDestinationRejected(OfflineAttemptState::Sent);
}

TEST_F(DeliveryCoreReferences, AmbiguousAttemptDestinationCannotBeReused) {
  CheckUsedDestinationRejected(OfflineAttemptState::Ambiguous);
}

TEST_F(DeliveryCoreReferences, ConfirmedAttemptDestinationCannotBeReused) {
  CheckUsedDestinationRejected(OfflineAttemptState::Confirmed);
}

TEST_F(DeliveryCoreReferences, CopyRequiresDistinctDestinationIdentity) {
  CheckSelfDestinationRejected(4);
}

TEST_F(DeliveryCoreReferences, MoveRequiresDistinctDestinationIdentity) {
  CheckSelfDestinationRejected(2);
}

TEST_F(DeliveryCoreReferences, BoundDestinationCannotStartAnotherAttempt) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 93));
  RawHdr raw;
  raw.messageId = "bound-destination@invalid"_ns;
  nsMsgKey bound, fresh;
  RefPtr<Message> header;
  ASSERT_EQ(NS_OK,
            db.StageMessage(mFolderId, raw, &bound, getter_AddRefs(header)));
  ASSERT_EQ(NS_OK, header->SetUint32Property("uidOnServer", 42));
  raw.messageId = "unbound-destination@invalid"_ns;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &fresh));
  OfflineOperationData payload;
  payload.operation = 0x10;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, fresh, payload));
  uint64_t output = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineAttempt(
                mFolderId, fresh, 0x10,
                Some(PendingDestination{mFolderId, bound, 93}), output));
  EXPECT_EQ(123u, output);
  ASSERT_EQ(NS_OK, db.BeginOfflineAttempt(
                       mFolderId, fresh, 0x10,
                       Some(PendingDestination{mFolderId, fresh, 93}), output));
  uint32_t uid = 77;
  ASSERT_EQ(NS_OK, header->GetUint32Property("uidOnServer", &uid));
  EXPECT_EQ(42u, uid);
}

TEST_F(DeliveryCoreReferences, NotAppliedDestinationAllowsExplicitRetry) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 94));
  RawHdr raw;
  raw.messageId = "not-applied@invalid"_ns;
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &key));
  OfflineOperationData payload;
  payload.operation = 0x10;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  uint64_t first, retry;
  auto destination = Some(PendingDestination{mFolderId, key, 94});
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(mFolderId, key, 0x10, destination, first));
  // This fixture dispatched no network operation.
  ASSERT_EQ(NS_OK, db.ResolveOfflineAttemptNotApplied(first));
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(mFolderId, key, 0x10, destination, retry));
  EXPECT_NE(first, retry);
  OfflineAttempt old;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(first, old));
  EXPECT_EQ(OfflineAttemptState::Pending, old.state);
}

TEST_F(DeliveryCoreReferences,
       PublishedBindingCannotCollideWithConfirmedStaging) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 95));
  RawHdr raw;
  raw.messageId = "confirmed-staging@invalid"_ns;
  nsMsgKey staged, control;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  ASSERT_EQ(NS_OK, Add("published-control@invalid"_ns, {}, control));
  OfflineOperationData payload;
  payload.operation = 0x10;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, staged, payload));
  uint64_t attemptId;
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(
                mFolderId, staged, 0x10,
                Some(PendingDestination{mFolderId, staged, 95}), attemptId));
  ASSERT_EQ(NS_OK, db.ConfirmOfflineAttempt(
                       attemptId, Some(ServerUidConfirmation{95, 55})));
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            db.BindMessageToServerUid(control, mFolderId, 95, 55));
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(control, names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(control, mFolderId, 95, 56));
  ASSERT_EQ(NS_OK, db.PublishMessage(staged, true));
  nsMsgKey found = nsMsgKey_None;
  ASSERT_EQ(NS_OK, db.GetMessageKeyForServerUid(mFolderId, 95, 55, found));
  EXPECT_EQ(staged, found);
  ASSERT_EQ(NS_OK, db.GetMessageKeyForServerUid(mFolderId, 95, 56, found));
  EXPECT_EQ(control, found);
}

TEST_F(DeliveryCoreReferences, ConfirmationDoesNotOverwriteDestinationUid) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 96));
  RawHdr raw;
  raw.messageId = "no-overwrite@invalid"_ns;
  nsMsgKey key;
  RefPtr<Message> header;
  ASSERT_EQ(NS_OK,
            db.StageMessage(mFolderId, raw, &key, getter_AddRefs(header)));
  OfflineOperationData payload;
  payload.operation = 0x10;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  uint64_t attemptId;
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(mFolderId, key, 0x10,
                                   Some(PendingDestination{mFolderId, key, 96}),
                                   attemptId));
  ASSERT_EQ(NS_OK, header->SetStringProperty("uidOnServer", "0002a"_ns));
  EXPECT_EQ(
      NS_ERROR_FILE_CORRUPTED,
      db.ConfirmOfflineAttempt(attemptId, Some(ServerUidConfirmation{96, 43})));
  uint32_t uid = 77;
  ASSERT_EQ(NS_OK, header->GetUint32Property("uidOnServer", &uid));
  EXPECT_EQ(42u, uid);
  nsCString text;
  ASSERT_EQ(NS_OK, header->GetStringProperty("uidOnServer", text));
  EXPECT_EQ("0002a"_ns, text);
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Sent, attempt.state);
  EXPECT_FALSE(attempt.confirmedUid);
  ASSERT_EQ(NS_OK, db.ConfirmOfflineAttempt(
                       attemptId, Some(ServerUidConfirmation{96, 42})));
  ASSERT_EQ(NS_OK, header->GetStringProperty("uidOnServer", text));
  EXPECT_EQ("0002a"_ns, text);
}

TEST_F(DeliveryCoreReferences, ConfirmationRequiresServerReportedEpoch) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 97));
  RawHdr raw;
  raw.messageId = "server-epoch@invalid"_ns;
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &key));
  OfflineOperationData payload;
  payload.operation = 0x10;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  uint64_t attemptId;
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(mFolderId, key, 0x10,
                                   Some(PendingDestination{mFolderId, key, 97}),
                                   attemptId));
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      db.ConfirmOfflineAttempt(attemptId, Some(ServerUidConfirmation{98, 42})));
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Sent, attempt.state);
  EXPECT_FALSE(attempt.confirmedUid);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(key, names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  ASSERT_EQ(NS_OK, db.ConfirmOfflineAttempt(
                       attemptId, Some(ServerUidConfirmation{97, 42})));
  EXPECT_EQ(
      NS_ERROR_FILE_CORRUPTED,
      db.ConfirmOfflineAttempt(attemptId, Some(ServerUidConfirmation{98, 42})));
  ASSERT_EQ(NS_OK, db.ConfirmOfflineAttempt(
                       attemptId, Some(ServerUidConfirmation{97, 42})));
}

TEST_F(DeliveryCoreReferences, BodySettlementPublishesCompleteStorageOnce) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK,
            Add("body@invalid"_ns, {"raw@invalid"_ns, "raw@invalid"_ns}, key));
  ASSERT_EQ(NS_OK, db.SetMessageStoreToken(key, "old-token"_ns));
  ASSERT_EQ(NS_OK, db.SetMessageSize(key, 123));
  ASSERT_EQ(NS_OK, db.SetMessageOfflineMessageSize(key, 111));
  ASSERT_EQ(NS_OK, db.SetMessageLineCount(key, 12));
  MessageBodyState expected;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  ASSERT_EQ(NS_OK, db.SetMessageFlags(key, 5));
  ASSERT_EQ(NS_OK, db.SetMessageProperty(key, "Case"_ns, "00042"_ns));
  ASSERT_EQ(NS_OK, db.SetMessageProperty(key, "case"_ns, "1e3"_ns));
  uint32_t calls = 0;
  RefPtr<BodyObserver> observer = new BodyObserver([&](nsIMsgDBHdr* old,
                                                       Message* message,
                                                       const MessageBodyState&
                                                           before,
                                                       const MessageBodyState&
                                                           after) {
    ++calls;
    EXPECT_EQ(key, before.key);
    EXPECT_EQ(key, after.key);
    ASSERT_TRUE(before.storeToken);
    EXPECT_EQ("old-token"_ns, *before.storeToken);
    EXPECT_EQ(123u, before.messageSize);
    EXPECT_EQ(5u, before.flags);
    EXPECT_GT(after.contentRevision, expected.contentRevision);
    EXPECT_GT(after.locationRevision, expected.locationRevision);
    bool active = true;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    nsCString token;
    ASSERT_EQ(NS_OK, old->GetStoreToken(token));
    EXPECT_EQ("old-token"_ns, token);
    ASSERT_EQ(NS_OK, message->GetStoreToken(token));
    EXPECT_EQ("finished-token"_ns, token);
    uint32_t size, flags;
    ASSERT_EQ(NS_OK, message->GetMessageSize(&size));
    EXPECT_EQ(456u, size);
    ASSERT_EQ(NS_OK, message->GetFlags(&flags));
    EXPECT_EQ(after.flags, flags);
    EXPECT_EQ(5u, flags & ~0x80u);
    EXPECT_TRUE(flags & 0x80u);
    nsTArray<nsCString> stored;
    ASSERT_EQ(NS_OK, Stored(key, stored));
    EXPECT_EQ((nsTArray<nsCString>{"raw@invalid"_ns, "raw@invalid"_ns}),
              stored);
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
    auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
    ASSERT_EQ(
        NS_OK,
        PublicationCell(
            reader, key,
            "SELECT value FROM message_properties WHERE id = :id AND name = 'storeToken'"_ns,
            token));
    EXPECT_EQ("finished-token"_ns, token);
  });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  FinishedMessageBody finished{"finished-token"_ns, 456, 400, 30, true};
  MessageBodyState output;
  ASSERT_EQ(NS_OK, db.SettleMessageBody(expected, finished, output));
  EXPECT_EQ(1u, calls);
  EXPECT_EQ(key, output.key);
  EXPECT_EQ(400u, output.offlineMessageSize);
  EXPECT_EQ(30u, output.lineCount);
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "Case"_ns, text));
  EXPECT_EQ("00042"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "case"_ns, text));
  EXPECT_EQ("1e3"_ns, text);
  db.RemoveMessageListener(observer);
  cleanup.release();
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageBodyState(key, expected));
  EXPECT_EQ(output.storeToken, expected.storeToken);
  EXPECT_EQ(output.contentRevision, expected.contentRevision);
}

TEST_F(DeliveryCoreReferences, BodySettlementRejectsStaleAndMissingGuards) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, Add("body-stale@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, Add("body-control@invalid"_ns, {}, control));
  MessageBodyState expected, output;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  FinishedMessageBody finished{"new"_ns, 20, 20, 2, true};
  output.key = 77;
  auto wrongDatabase = expected;
  wrongDatabase.databaseSourceId = "replaced-database"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.SettleMessageBody(wrongDatabase, finished, output));
  EXPECT_EQ(77u, output.key);
  auto wrongFolder = expected;
  ++wrongFolder.folderId;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.SettleMessageBody(wrongFolder, finished, output));
  EXPECT_EQ(77u, output.key);
  ASSERT_EQ(NS_OK, db.SetMessageSize(key, 21));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.SettleMessageBody(expected, finished, output));
  EXPECT_EQ(77u, output.key);
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  ASSERT_EQ(NS_OK, db.RemoveMessage(key));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.SettleMessageBody(expected, finished, output));
  EXPECT_EQ(77u, output.key);
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(control, output));
  EXPECT_EQ(control, output.key);
}

TEST_F(DeliveryCoreReferences,
       BodySettlementFailureRollsBackStorageAndJournal) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("body-failure@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, db.SetMessageStoreToken(key, "original"_ns));
  MessageBodyState expected, output;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  uint32_t calls = 0;
  RefPtr<BodyObserver> observer =
      new BodyObserver([&](nsIMsgDBHdr*, Message*, const MessageBodyState&,
                           const MessageBodyState&) { ++calls; });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_body_flags BEFORE UPDATE ON messages "
          "BEGIN SELECT RAISE(ABORT, 'body flags'); END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS reject_body_flags"_ns));
  });
  FinishedMessageBody finished{"finished"_ns, 20, 20, 2, true};
  output.key = 77;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.SettleMessageBody(expected, finished, output));
  EXPECT_EQ(77u, output.key);
  EXPECT_EQ(0u, calls);
  MessageBodyState retained;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, retained));
  EXPECT_EQ(expected.storeToken, retained.storeToken);
  EXPECT_EQ(expected.contentRevision, retained.contentRevision);
  EXPECT_EQ(expected.locationRevision, retained.locationRevision);
  EXPECT_EQ(expected.flags, retained.flags);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER reject_body_flags"_ns));
  ASSERT_EQ(NS_OK, db.SettleMessageBody(expected, finished, output));
  EXPECT_EQ(1u, calls);
  ASSERT_TRUE(output.storeToken);
  EXPECT_EQ("finished"_ns, *output.storeToken);
}

TEST_F(DeliveryCoreReferences,
       BodySettlementKeepsForeignTransactionAndFlagObservers) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("body-observers@invalid"_ns, {}, key));
  MessageBodyState expected, output;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  FinishedMessageBody finished{"body"_ns, 10, 10, 1, false};
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.SettleMessageBody(expected, finished, output));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([](Message*, bool) {
        ADD_FAILURE() << "Body settlement published a row";
      });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, db.SettleMessageBody(expected, finished, output));
  EXPECT_EQ(0u, observer->mChanges);
  expected = output;
  finished.offline = true;
  ASSERT_EQ(NS_OK, db.SettleMessageBody(expected, finished, output));
  EXPECT_EQ(1u, observer->mChanges);
}

TEST_F(DeliveryCoreReferences, NativeImportReceiptMapsForwardRootsAndReopens) {
  ASSERT_EQ(NS_OK, Start());
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  FolderImportReceipt receipt;
  uint32_t callbacks = 0;
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([&](Message* message, bool notifyLegacy) {
        ++callbacks;
        EXPECT_FALSE(notifyLegacy);
        ASSERT_EQ(2u, receipt.keys.Length());
        EXPECT_EQ(0u, receipt.keys[0].source);
        EXPECT_EQ(9u, receipt.keys[1].source);
        nsMsgKey root = receipt.keys[0].destination;
        nsMsgKey child = receipt.keys[1].destination;
        nsMsgKey thread, parent;
        ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageThreadId(child, thread));
        ASSERT_EQ(NS_OK,
                  mCore->MessageDB().GetMessageThreadParent(child, parent));
        EXPECT_EQ(root, thread);
        EXPECT_EQ(root, parent);
        nsCString subject;
        ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageSubject(root, subject));
        EXPECT_EQ("imported root"_ns, subject);
        nsTArray<nsCString> stored;
        ASSERT_EQ(NS_OK, Stored(child, stored));
        EXPECT_EQ(
            (nsTArray<nsCString>{"root-import@invalid"_ns, "missing@invalid"_ns,
                                 "root-import@invalid"_ns}),
            stored);
        bool active = true;
        ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
        EXPECT_FALSE(active);
        nsCString text;
        ASSERT_EQ(NS_OK, message->GetSubject(text));
        EXPECT_FALSE(text.IsEmpty());
      });
  auto& db = mCore->MessageDB();
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, receipt));
  EXPECT_EQ(2u, callbacks);
  nsMsgKey root = receipt.keys[0].destination;
  nsMsgKey child = receipt.keys[1].destination;
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(child, "Case"_ns, text));
  EXPECT_EQ("00042"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(child, "case"_ns, text));
  EXPECT_EQ("1e3"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageTags(child, text));
  EXPECT_EQ("last"_ns, text);
  FolderImportReceipt repeated;
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, repeated));
  EXPECT_EQ(2u, callbacks);
  EXPECT_EQ(root, repeated.keys[0].destination);
  EXPECT_EQ(child, repeated.keys[1].destination);
  db.RemoveMessageListener(observer);
  cleanup.release();
  Stop();
  ASSERT_EQ(NS_OK, Start());
  Maybe<FolderImportReceipt> recovered;
  ASSERT_EQ(NS_OK, mCore->GetFolderImportReceipt(input.identity, recovered));
  ASSERT_TRUE(recovered);
  ASSERT_EQ(2u, recovered->keys.Length());
  EXPECT_EQ(root, recovered->keys[0].destination);
  EXPECT_EQ(child, recovered->keys[1].destination);
  EXPECT_EQ(input.identity.databaseSourceId,
            recovered->identity.databaseSourceId);
}

TEST_F(DeliveryCoreReferences, NativeImportReceiptFailureRollsBackWholeUnit) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("prior-control@invalid"_ns, {}, control));
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_import_receipt BEFORE INSERT ON "
          "folder_import_receipts BEGIN SELECT RAISE(ABORT, 'receipt failure'); END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS reject_import_receipt"_ns));
  });
  FolderImportReceipt output;
  output.identity.token = "unchanged"_ns;
  uint32_t callbacks = 0;
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([&](Message*, bool) { ++callbacks; });
  auto& db = mCore->MessageDB();
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            ImportNativeFile(source, input, output));
  EXPECT_EQ("unchanged"_ns, output.identity.token);
  EXPECT_EQ(0u, callbacks);
  uint64_t count;
  ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
  EXPECT_EQ(1u, count);
  bool exists = false, active = true;
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  Maybe<FolderImportReceipt> absent;
  ASSERT_EQ(NS_OK, mCore->GetFolderImportReceipt(input.identity, absent));
  EXPECT_FALSE(absent);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER reject_import_receipt"_ns));
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, output));
  EXPECT_EQ(2u, callbacks);
  ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
  EXPECT_EQ(3u, count);
}

TEST_F(DeliveryCoreReferences,
       NativeImportRejectsUnhandledAndConflictingIdentity) {
  ASSERT_EQ(NS_OK, Start());
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  FolderImportReceipt output;
  output.identity.token = "unchanged"_ns;
  input.recordsComplete = false;
  EXPECT_EQ(NS_ERROR_NOT_IMPLEMENTED, ImportNativeFile(source, input, output));
  EXPECT_EQ("unchanged"_ns, output.identity.token);
  input.recordsComplete = true;
  input.unhandledRecords.AppendElement("unconverted-offline-row"_ns);
  EXPECT_EQ(NS_ERROR_NOT_IMPLEMENTED, ImportNativeFile(source, input, output));
  EXPECT_EQ("unchanged"_ns, output.identity.token);
  input.unhandledRecords.Clear();
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, output));
  auto conflict = input.identity;
  conflict.token = "different-token"_ns;
  Maybe<FolderImportReceipt> sentinel;
  sentinel.emplace();
  sentinel->identity.token = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_ALREADY_INITIALIZED,
            mCore->GetFolderImportReceipt(conflict, sentinel));
  ASSERT_TRUE(sentinel);
  EXPECT_EQ("unchanged"_ns, sentinel->identity.token);
  conflict = input.identity;
  conflict.databaseSourceId = "different-database"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->GetFolderImportReceipt(conflict, sentinel));
  ASSERT_TRUE(sentinel);
  EXPECT_EQ("unchanged"_ns, sentinel->identity.token);
  conflict = input.identity;
  conflict.sourceSha256.AssignLiteral(
      "0000000000000000000000000000000000000000000000000000000000000000");
#ifdef XP_WIN
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->GetFolderImportReceipt(conflict, sentinel));
#else
  EXPECT_EQ(NS_ERROR_ALREADY_INITIALIZED,
            mCore->GetFolderImportReceipt(conflict, sentinel));
#endif
  ASSERT_TRUE(sentinel);
  EXPECT_EQ("unchanged"_ns, sentinel->identity.token);
}

TEST_F(DeliveryCoreReferences, NativeImportDoesNotInventOldHashOnlyKeyMap) {
  ASSERT_EQ(NS_OK, Start());
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(
      NS_OK,
      mConnection->CreateStatement(
          "INSERT INTO folder_properties(id, name, value) VALUES(:id, "
          "'morkMigrationSource', 'v1:sha256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=')"_ns,
          getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, input.identity.folderId));
  ASSERT_EQ(NS_OK, stmt->Execute());
  ASSERT_EQ(NS_OK, stmt->Finalize());
  Maybe<FolderImportReceipt> output;
  output.emplace();
  output->identity.token = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->GetFolderImportReceipt(input.identity, output));
  ASSERT_TRUE(output);
  EXPECT_EQ("unchanged"_ns, output->identity.token);
  FolderImportReceipt receipt;
  receipt.identity.token = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, ImportNativeFile(source, input, receipt));
  EXPECT_EQ("unchanged"_ns, receipt.identity.token);
}

TEST_F(DeliveryCoreReferences, NativeImportReceiptSqlErrorPreservesOutput) {
  ASSERT_EQ(NS_OK, Start());
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  FolderImportReceipt receipt;
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, receipt));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP VIEW folder_import_keys AS SELECT token, sourceKey, "
          "abs(-9223372036854775808) AS destinationKey FROM main.folder_import_keys"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.folder_import_keys"_ns));
  });
  Maybe<FolderImportReceipt> output;
  output.emplace();
  output->identity.token = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_FAILURE,
            mCore->GetFolderImportReceipt(input.identity, output));
  ASSERT_TRUE(output);
  EXPECT_EQ("unchanged"_ns, output->identity.token);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.folder_import_keys"_ns));
  ASSERT_EQ(NS_OK, mCore->GetFolderImportReceipt(input.identity, output));
  ASSERT_TRUE(output);
  EXPECT_EQ(2u, output->keys.Length());
}

TEST_F(DeliveryCoreReferences, NativeImportRejectsLostReceiptMapping) {
  ASSERT_EQ(NS_OK, Start());
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  FolderImportReceipt receipt;
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, receipt));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "DELETE FROM folder_import_keys WHERE sourceKey = 9"_ns));
  Maybe<FolderImportReceipt> output;
  output.emplace();
  output->identity.token = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            mCore->GetFolderImportReceipt(input.identity, output));
  ASSERT_TRUE(output);
  EXPECT_EQ("unchanged"_ns, output->identity.token);
  receipt.identity.token = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, ImportNativeFile(source, input, receipt));
  EXPECT_EQ("unchanged"_ns, receipt.identity.token);
  uint64_t count;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(2u, count);
}

TEST_F(DeliveryCoreReferences,
       NativeImportChecksSourceSizeAndForeignTransaction) {
  ASSERT_EQ(NS_OK, Start());
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  FolderImportReceipt output;
  output.identity.token = "unchanged"_ns;
  input.sourceSize = 1;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, ImportNativeFile(source, input, output));
  EXPECT_EQ("unchanged"_ns, output.identity.token);
  input.sourceSize = 0;
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active;
    if (NS_SUCCEEDED(mConnection->GetTransactionInProgress(&active)) &&
        active) {
      EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
    }
  });
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, ImportNativeFile(source, input, output));
  EXPECT_EQ("unchanged"_ns, output.identity.token);
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, output));
  EXPECT_EQ(2u, output.keys.Length());
}

}  // namespace

TEST_F(DeliveryCoreReferences, RelocationPendingSurvivesReopenAndGatesAccess) {
  ASSERT_EQ(NS_OK, Start());
  FolderBodyRelocation plan;
  ASSERT_EQ(NS_OK, PrepareRelocation(plan));
  auto key = plan.messages[0].before.key;
  uint64_t other;
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolderId, "Other"_ns, &other));
  RawHdr controlHeader;
  controlHeader.messageId = "unrelated-row"_ns;
  nsMsgKey control;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(other, controlHeader, false,
                                                 &control));
  ASSERT_EQ(NS_OK, mCore->MessageDB().PrepareBodyRelocation(plan));
  nsTArray<uint64_t> pending;
  ASSERT_EQ(NS_OK, mCore->MessageDB().ListPendingBodyRelocations(pending));
  EXPECT_EQ((nsTArray<uint64_t>{mFolderId}), pending);
  Stop();
  ASSERT_FALSE(mCore);
  ASSERT_FALSE(mConnection);
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  Maybe<FolderBodyRelocation> stored;
  ASSERT_EQ(NS_OK, db.GetBodyRelocation(mFolderId, stored));
  ASSERT_TRUE(stored);
  EXPECT_EQ(plan.originalPath, stored->originalPath);
  EXPECT_EQ(plan.backupPath, stored->backupPath);
  EXPECT_EQ(BodyRelocationState::Pending, stored->state);
  EXPECT_EQ(2u, stored->messages.Length());
  MessageBodyState output;
  output.key = 77;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.GetMessageBodyState(key, output));
  EXPECT_EQ(77u, output.key);
  nsCString token("sentinel");
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.GetMessageStoreToken(key, token));
  EXPECT_EQ("sentinel"_ns, token);
  EXPECT_EQ(NS_OK, db.SetMessageStoreToken(control, "unrelated-body"_ns));
  ASSERT_EQ(NS_OK, db.GetMessageStoreToken(control, token));
  EXPECT_EQ("unrelated-body"_ns, token);
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.SetMessageFlags(key, 1));
  nsMsgKey rejected = 77;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, Add("late"_ns, {}, rejected));
  EXPECT_EQ(77u, rejected);
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, db.RemoveMessage(key));
  bool exists = false;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_TRUE(exists);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.SettleBodyRelocation(mFolderId, plan.token,
                                    BodyRelocationOutcome::Installed));
  ASSERT_EQ(NS_OK, db.SettleBodyRelocation(mFolderId, plan.token,
                                           BodyRelocationOutcome::Restored));
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, output));
  EXPECT_EQ(plan.messages[0].before.storeToken, output.storeToken);
  EXPECT_EQ(plan.messages[0].before.contentRevision, output.contentRevision);
  EXPECT_EQ(NS_OK, db.SettleBodyRelocation(mFolderId, plan.token,
                                           BodyRelocationOutcome::Restored));
}

TEST_F(DeliveryCoreReferences, RelocationInstallsWholeSetBeforeFirstCallback) {
  ASSERT_EQ(NS_OK, Start());
  FolderBodyRelocation plan;
  ASSERT_EQ(NS_OK, PrepareRelocation(plan));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.PrepareBodyRelocation(plan));
  ASSERT_EQ(NS_OK, InstallRelocation(plan));
  uint32_t calls = 0;
  RefPtr<BodyObserver> observer = new BodyObserver([&](nsIMsgDBHdr* old,
                                                       Message* live,
                                                       const MessageBodyState&
                                                           before,
                                                       const MessageBodyState&
                                                           after) {
    ++calls;
    bool active = true;
    ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    for (const auto& expected : plan.messages) {
      MessageBodyState current;
      ASSERT_EQ(NS_OK, db.GetMessageBodyState(expected.before.key, current));
      EXPECT_EQ(expected.storeToken, current.storeToken);
      EXPECT_EQ(expected.messageSize, current.messageSize);
      EXPECT_GT(current.locationRevision, expected.before.locationRevision);
    }
    nsCString token;
    ASSERT_EQ(NS_OK, old->GetStoreToken(token));
    EXPECT_EQ(*before.storeToken, token);
    ASSERT_EQ(NS_OK, live->GetStoreToken(token));
    EXPECT_EQ(*after.storeToken, token);
    uint32_t flags = 0;
    ASSERT_EQ(NS_OK, live->GetFlags(&flags));
    EXPECT_EQ(5u | 0x80u, flags);
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
    auto close = MakeScopeExit([&] { EXPECT_EQ(NS_OK, reader->Close()); });
    for (const auto& row : plan.messages) {
      ASSERT_EQ(
          NS_OK,
          PublicationCell(
              reader, row.before.key,
              "SELECT value FROM message_properties WHERE id=:id AND name='storeToken'"_ns,
              token));
      EXPECT_EQ(*row.storeToken, token);
    }
  });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, db.SettleBodyRelocation(mFolderId, plan.token,
                                           BodyRelocationOutcome::Installed));
  EXPECT_EQ(2u, calls);
  EXPECT_EQ(NS_OK, db.SettleBodyRelocation(mFolderId, plan.token,
                                           BodyRelocationOutcome::Installed));
  EXPECT_EQ(2u, calls);
  for (const auto& row : plan.messages) {
    nsCString text;
    ASSERT_EQ(NS_OK, db.GetMessageProperty(row.before.key, "Case"_ns, text));
    EXPECT_EQ("00042"_ns, text);
    nsTArray<nsCString> references;
    ASSERT_EQ(NS_OK, Stored(row.before.key, references));
    EXPECT_EQ((nsTArray<nsCString>{"ancestor"_ns, "ancestor"_ns}), references);
  }
  nsCOMPtr<nsIFile> backup;
  ASSERT_EQ(NS_OK, NS_NewLocalFile(plan.backupPath, getter_AddRefs(backup)));
  int64_t size = 0;
  ASSERT_EQ(NS_OK, backup->GetFileSize(&size));
  EXPECT_EQ(64, size);
}

TEST_F(DeliveryCoreReferences, RelocationFailureKeepsIntentAndAllOldRows) {
  ASSERT_EQ(NS_OK, Start());
  FolderBodyRelocation plan;
  ASSERT_EQ(NS_OK, PrepareRelocation(plan));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.PrepareBodyRelocation(plan));
  auto readScalar = [&](const nsACString& sql, int64_t& value) -> nsresult {
    nsCOMPtr<mozIStorageStatement> stmt;
    MOZ_TRY(Connection()->CreateStatement(sql, getter_AddRefs(stmt)));
    auto finalize = MakeScopeExit([&] { EXPECT_EQ(NS_OK, stmt->Finalize()); });
    bool more;
    MOZ_TRY(stmt->ExecuteStep(&more));
    NS_ENSURE_TRUE(more, NS_ERROR_UNEXPECTED);
    return stmt->GetInt64(0, &value);
  };
  int64_t watermark;
  ASSERT_EQ(NS_OK, readScalar("SELECT MAX(sequence) FROM message_changes"_ns,
                              watermark));
  ASSERT_EQ(NS_OK, InstallRelocation(plan));
  uint32_t calls = 0;
  RefPtr<BodyObserver> observer =
      new BodyObserver([&](nsIMsgDBHdr*, Message*, const MessageBodyState&,
                           const MessageBodyState&) { ++calls; });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(
      NS_OK,
      Connection()->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER fail_relocation BEFORE INSERT ON message_properties WHEN NEW.name='storeToken' AND NEW.value='new-1' BEGIN SELECT RAISE(ABORT,'second relocation'); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.SettleBodyRelocation(mFolderId, plan.token,
                                    BodyRelocationOutcome::Installed));
  EXPECT_EQ(0u, calls);
  int64_t sequence, oldTokens;
  ASSERT_EQ(NS_OK, readScalar("SELECT MAX(sequence) FROM message_changes"_ns,
                              sequence));
  EXPECT_EQ(watermark, sequence);
  ASSERT_EQ(
      NS_OK,
      readScalar(
          "SELECT COUNT(*) FROM message_properties WHERE name='storeToken' AND value IN('old-0','old-1')"_ns,
          oldTokens));
  EXPECT_EQ(2, oldTokens);
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.CheckFolderBodyAccess(mFolderId));
  bool active = true;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL("DROP TRIGGER fail_relocation"_ns));
  ASSERT_EQ(NS_OK, db.SettleBodyRelocation(mFolderId, plan.token,
                                           BodyRelocationOutcome::Installed));
  EXPECT_EQ(2u, calls);
}

TEST_F(DeliveryCoreReferences, RelocationRejectsIncompleteAndStaleSets) {
  ASSERT_EQ(NS_OK, Start());
  FolderBodyRelocation plan;
  ASSERT_EQ(NS_OK, PrepareRelocation(plan));
  auto& db = mCore->MessageDB();
  auto last = plan.messages.LastElement();
  plan.messages.RemoveLastElement();
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.PrepareBodyRelocation(plan));
  plan.messages.AppendElement(std::move(last));
  nsMsgKey late;
  ASSERT_EQ(NS_OK, Add("late-row"_ns, {}, late));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.PrepareBodyRelocation(plan));
  ASSERT_EQ(NS_OK, db.RemoveMessage(late));
  ASSERT_EQ(NS_OK, db.SetMessageProperty(plan.messages[0].before.key, "Case"_ns,
                                         "later"_ns));
  ASSERT_EQ(NS_OK, db.NoteMessageContentChanged(plan.messages[0].before.key));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.PrepareBodyRelocation(plan));
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(plan.messages[0].before.key,
                                          plan.messages[0].before));
  --plan.originalSize;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.PrepareBodyRelocation(plan));
  ++plan.originalSize;
  ASSERT_EQ(NS_OK, db.PrepareBodyRelocation(plan));
  ASSERT_EQ(NS_OK, db.SettleBodyRelocation(mFolderId, plan.token,
                                           BodyRelocationOutcome::Restored));
}

TEST_F(DeliveryCoreReferences, RelocationRejectsStagedBodyOwner) {
  ASSERT_EQ(NS_OK, Start());
  FolderBodyRelocation plan;
  ASSERT_EQ(NS_OK, PrepareRelocation(plan));
  auto& db = mCore->MessageDB();
  RawHdr raw;
  raw.messageId = "staged-body@invalid"_ns;
  raw.storeToken = Some(nsCString("unpublished-body"_ns));
  nsMsgKey staged;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  uint64_t otherFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "Other"_ns,
                                                  &otherFolder));
  nsMsgKey otherStaged;
  ASSERT_EQ(NS_OK, db.StageMessage(otherFolder, raw, &otherStaged));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.PrepareBodyRelocation(plan));
  Maybe<FolderBodyRelocation> intent;
  ASSERT_EQ(NS_OK, db.GetBodyRelocation(mFolderId, intent));
  EXPECT_FALSE(intent);
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{staged}), keys);
  bool exists = true;
  ASSERT_EQ(NS_OK, db.MessageExists(staged, exists));
  EXPECT_FALSE(exists);
  nsCString token;
  ASSERT_EQ(NS_OK, db.GetMessageStoreToken(staged, token));
  EXPECT_EQ("unpublished-body"_ns, token);
  MessageBodyState current;
  ASSERT_EQ(NS_OK,
            db.GetMessageBodyState(plan.messages[0].before.key, current));
  EXPECT_EQ(plan.messages[0].before.storeToken, current.storeToken);
  EXPECT_EQ(plan.messages[0].before.contentRevision, current.contentRevision);
  bool active = true;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_EQ(NS_OK, db.AbortMessage(staged));
  ASSERT_EQ(NS_OK, db.PrepareBodyRelocation(plan));
  ASSERT_EQ(NS_OK, db.SettleBodyRelocation(mFolderId, plan.token,
                                           BodyRelocationOutcome::Restored));
  EXPECT_EQ(NS_OK, db.CheckFolderBodyAccess(mFolderId));
  ASSERT_EQ(NS_OK, db.ListStagedMessages(otherFolder, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{otherStaged}), keys);
  ASSERT_EQ(NS_OK, db.AbortMessage(otherStaged));
}

TEST_F(DeliveryCoreReferences, RelocationReadErrorsPreserveOutputAndGate) {
  ASSERT_EQ(NS_OK, Start());
  FolderBodyRelocation plan;
  ASSERT_EQ(NS_OK, PrepareRelocation(plan));
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.PrepareBodyRelocation(plan));
  Maybe<FolderBodyRelocation> output = Some(FolderBodyRelocation{});
  output->folderId = 77;
  ASSERT_EQ(
      NS_OK,
      Connection()->ExecuteSimpleSQL(
          "CREATE TEMP VIEW body_relocation_rows AS SELECT folderId,abs(-9223372036854775808) AS id,oldToken,content,location,size,offlineSize,lines,flags,newToken,newSize,newOfflineSize,newLines,offline FROM main.body_relocation_rows"_ns));
  EXPECT_EQ(NS_ERROR_FAILURE, db.GetBodyRelocation(mFolderId, output));
  ASSERT_TRUE(output);
  EXPECT_EQ(77u, output->folderId);
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "DROP VIEW temp.body_relocation_rows"_ns));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  nsTArray<uint64_t> pending{77};
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.ListPendingBodyRelocations(pending));
  EXPECT_EQ((nsTArray<uint64_t>{77}), pending);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  ASSERT_EQ(NS_OK, db.GetBodyRelocation(mFolderId, output));
  ASSERT_TRUE(output);
  EXPECT_EQ(BodyRelocationState::Pending, output->state);
  ASSERT_EQ(NS_OK, db.SettleBodyRelocation(mFolderId, plan.token,
                                           BodyRelocationOutcome::Restored));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.CheckMessageBodyAccess(plan.messages[0].before.key));
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  EXPECT_EQ(NS_OK, db.CheckMessageBodyAccess(plan.messages[0].before.key));
}


TEST_F(DeliveryCoreReferences, PendingAppendDestinationSurvivesReopen) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().SetFolderUidValidity(mFolderId, UINT32_MAX));
  RawHdr raw;
  raw.messageId = "queued-append@invalid"_ns;
  raw.storeToken = Some(nsCString("finished-body"_ns));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, mCore->MessageDB().StageMessage(mFolderId, raw, &key));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kAppendDraft;
  input.pendingDestination =
      Some(PendingDestination{mFolderId, key, UINT32_MAX});
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().StoreOfflineOperation(mFolderId, key, input));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, key, got));
  ASSERT_TRUE(got.pendingDestination);
  EXPECT_EQ(mFolderId, got.pendingDestination->folderId);
  EXPECT_EQ(key, got.pendingDestination->key);
  EXPECT_EQ(UINT32_MAX, got.pendingDestination->epoch);
  EXPECT_TRUE(got.copyDestinationBindings.IsEmpty());
  OfflineAttempt attempt;
  attempt.id = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetCurrentOfflineAttempt(mFolderId, key, attempt));
  EXPECT_EQ(123u, attempt.id);
  bool exists = true;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_FALSE(exists);
  nsTArray<nsMsgKey> staged;
  ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, staged));
  EXPECT_EQ((nsTArray<nsMsgKey>{key}), staged);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(key, names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  nsCString token;
  ASSERT_EQ(NS_OK, db.GetMessageStoreToken(key, token));
  EXPECT_EQ("finished-body"_ns, token);
}

TEST_F(DeliveryCoreReferences, PendingCopiesKeepOrderedPhysicalAssociations) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  uint64_t destinationFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "Copies"_ns,
                                                  &destinationFolder));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 31));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(destinationFolder,
                                                          UINT32_MAX));
  nsMsgKey source, staged, published;
  ASSERT_EQ(NS_OK, Add("source@invalid"_ns, {}, source));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(source, mFolderId, 31, 700));
  RawHdr raw;
  raw.messageId = "copy-stage@invalid"_ns;
  ASSERT_EQ(NS_OK, db.StageMessage(destinationFolder, raw, &staged));
  raw.messageId = "copy-published@invalid"_ns;
  ASSERT_EQ(NS_OK, db.AddMessage(destinationFolder, raw, true, &published));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kMsgCopy;
  input.copyDestinations = {"imap://same/Copies"_ns, "imap://legacy/Copies"_ns,
                            "imap://same/Copies"_ns};
  input.copyDestinationBindings.AppendElement(
      Some(PendingDestination{destinationFolder, staged, UINT32_MAX}));
  input.copyDestinationBindings.AppendElement(Nothing());
  input.copyDestinationBindings.AppendElement(
      Some(PendingDestination{destinationFolder, published, UINT32_MAX}));
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, input));
  ASSERT_EQ(NS_OK, db.RemoveMessage(source));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->MessageDB();
  {
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
    nsCOMPtr<mozIStorageStatement> stmt;
    auto close = MakeScopeExit([&] {
      if (stmt) {
        EXPECT_EQ(NS_OK, stmt->Finalize());
      }
      EXPECT_EQ(NS_OK, reader->Close());
    });
    ASSERT_EQ(NS_OK, reader->CreateStatement(
                         "SELECT "
                         "c.ordinal,c.uri,c.destinationFolderId,c."
                         "destinationKey,c.destinationEpoch "
                         "FROM offline_copy_destinations c JOIN "
                         "offline_operations o ON o.id=c.operationId "
                         "WHERE o.messageKey=:key ORDER BY c.ordinal"_ns,
                         getter_AddRefs(stmt)));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("key"_ns, source));
    const nsMsgKey expected[] = {staged, nsMsgKey_None, published};
    for (uint32_t i = 0; i < 3; ++i) {
      bool more, absent;
      ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
      ASSERT_TRUE(more);
      int64_t ordinal;
      ASSERT_EQ(NS_OK, stmt->GetInt64(0, &ordinal));
      EXPECT_EQ(i, ordinal);
      nsCString uri;
      ASSERT_EQ(NS_OK, stmt->GetUTF8String(1, uri));
      EXPECT_EQ(input.copyDestinations[i], uri);
      ASSERT_EQ(NS_OK, stmt->GetIsNull(2, &absent));
      EXPECT_EQ(expected[i] == nsMsgKey_None, absent);
      if (!absent) {
        int64_t folder, key, epoch;
        ASSERT_EQ(NS_OK, stmt->GetInt64(2, &folder));
        ASSERT_EQ(NS_OK, stmt->GetInt64(3, &key));
        ASSERT_EQ(NS_OK, stmt->GetInt64(4, &epoch));
        EXPECT_EQ(destinationFolder, uint64_t(folder));
        EXPECT_EQ(expected[i], key);
        EXPECT_EQ(UINT32_MAX, epoch);
      }
    }
    bool more;
    ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
    EXPECT_FALSE(more);
  }
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperation(mFolderId, source, got));
  EXPECT_EQ(input.copyDestinations, got.copyDestinations);
  ASSERT_EQ(3u, got.copyDestinationBindings.Length());
  ASSERT_TRUE(got.copyDestinationBindings[0]);
  EXPECT_EQ(destinationFolder, got.copyDestinationBindings[0]->folderId);
  EXPECT_EQ(staged, got.copyDestinationBindings[0]->key);
  EXPECT_EQ(UINT32_MAX, got.copyDestinationBindings[0]->epoch);
  EXPECT_FALSE(got.copyDestinationBindings[1]);
  ASSERT_TRUE(got.copyDestinationBindings[2]);
  EXPECT_EQ(published, got.copyDestinationBindings[2]->key);
  got.keywordsToAdd = "unrelated edit"_ns;
  ASSERT_EQ(NS_OK, reopened.StoreOfflineOperation(mFolderId, source, got));
  ASSERT_NO_FATAL_FAILURE(CheckOfflineSource(source, 31, 700));
  uint64_t attemptId = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            reopened.BeginOfflineAttempt(
                mFolderId, source, nsIMsgOfflineImapOperation::kMsgCopy,
                got.copyDestinationBindings[2], attemptId));
  EXPECT_EQ(123u, attemptId);
  got.copyDestinationBindings[0].reset();
  ASSERT_EQ(NS_OK, reopened.StoreOfflineOperation(mFolderId, source, got));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            reopened.BeginOfflineAttempt(
                mFolderId, source, nsIMsgOfflineImapOperation::kMsgCopy,
                got.copyDestinationBindings[2], attemptId));
  EXPECT_EQ(123u, attemptId);
  got.copyDestinationBindings[0] =
      Some(PendingDestination{destinationFolder, staged, UINT32_MAX});
  ASSERT_EQ(NS_OK, reopened.StoreOfflineOperation(mFolderId, source, got));
  ASSERT_EQ(NS_OK, reopened.BeginOfflineAttempt(
                       mFolderId, source, nsIMsgOfflineImapOperation::kMsgCopy,
                       got.copyDestinationBindings[0], attemptId));
  got.keywordsToAdd = "must not replace"_ns;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            reopened.StoreOfflineOperation(mFolderId, source, got));
  ASSERT_EQ(NS_OK, reopened.MarkOfflineAttemptAmbiguous(attemptId));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            reopened.StoreOfflineOperation(mFolderId, source, got));
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperation(mFolderId, source, got));
  EXPECT_EQ("unrelated edit"_ns, got.keywordsToAdd);
  EXPECT_EQ(staged, got.copyDestinationBindings[0]->key);
}

TEST_F(DeliveryCoreReferences, PendingDestinationRejectsInvalidIdentity) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 17));
  RawHdr raw;
  raw.messageId = "pending-identity@invalid"_ns;
  nsMsgKey key, other;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &key));
  ASSERT_EQ(NS_OK, Add("bound@invalid"_ns, {}, other));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(other, mFolderId, 17, 42));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kAppendDraft;
  input.pendingDestination = Some(PendingDestination{mFolderId, key, 17});
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, input));
  for (const auto& invalid :
       {PendingDestination{mFolderId, key, 18},
        PendingDestination{mFolderId + 100, key, 17},
        PendingDestination{mFolderId, other, 17},
        PendingDestination{mFolderId, nsMsgKey_None - 1, 17}}) {
    SCOPED_TRACE(invalid.key);
    input.pendingDestination = Some(invalid);
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db.StoreOfflineOperation(mFolderId, key, input));
  }
  input.pendingDestination = Some(PendingDestination{mFolderId, 0, 17});
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.StoreOfflineOperation(mFolderId, key, input));
  input.pendingDestination = Some(PendingDestination{mFolderId, key, 17});
  input.operation = nsIMsgOfflineImapOperation::kAppendDraft |
                    nsIMsgOfflineImapOperation::kAppendTemplate;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.StoreOfflineOperation(mFolderId, key, input));
  input.operation = nsIMsgOfflineImapOperation::kMsgMoved;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.StoreOfflineOperation(mFolderId, key, input));
  input.operation = nsIMsgOfflineImapOperation::kMsgCopy;
  input.pendingDestination.reset();
  input.copyDestinations = {"imap://one"_ns};
  input.copyDestinationBindings.AppendElement(Nothing());
  input.copyDestinationBindings.AppendElement(Nothing());
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.StoreOfflineOperation(mFolderId, key, input));
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, key, got));
  EXPECT_EQ(uint32_t(nsIMsgOfflineImapOperation::kAppendDraft), got.operation);
  ASSERT_TRUE(got.pendingDestination);
  EXPECT_EQ(key, got.pendingDestination->key);
  EXPECT_EQ(17u, got.pendingDestination->epoch);
  EXPECT_TRUE(got.copyDestinations.IsEmpty());
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
}

TEST_F(DeliveryCoreReferences,
       PendingDestinationCannotBeClaimedByAnotherOperation) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 23));
  nsMsgKey first, second, target;
  ASSERT_EQ(NS_OK, Add("first-source@invalid"_ns, {}, first));
  ASSERT_EQ(NS_OK, Add("second-source@invalid"_ns, {}, second));
  ASSERT_EQ(NS_OK, Add("physical-target@invalid"_ns, {}, target));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(first, mFolderId, 23, 42));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(second, mFolderId, 23, 43));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kMsgMoved;
  input.pendingDestination = Some(PendingDestination{mFolderId, target, 23});
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, first, input));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.StoreOfflineOperation(mFolderId, second, input));
  input.pendingDestination.reset();
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, second, input));
  uint64_t output = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineAttempt(
                mFolderId, second, nsIMsgOfflineImapOperation::kMsgMoved,
                Some(PendingDestination{mFolderId, target, 23}), output));
  EXPECT_EQ(123u, output);
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, first, input));
  input.pendingDestination = Some(PendingDestination{mFolderId, target, 23});
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, second, input));
}

TEST_F(DeliveryCoreReferences,
       PendingDestinationEpochIsNotRefreshedAtDispatch) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 71));
  RawHdr raw;
  raw.messageId = "queued-epoch@invalid"_ns;
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &key));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kAppendDraft;
  input.pendingDestination = Some(PendingDestination{mFolderId, key, 71});
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, input));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 72));
  uint64_t output = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineAttempt(
                mFolderId, key, nsIMsgOfflineImapOperation::kAppendDraft,
                Some(PendingDestination{mFolderId, key, 72}), output));
  EXPECT_EQ(123u, output);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineAttempt(mFolderId, key,
                                   nsIMsgOfflineImapOperation::kAppendDraft,
                                   input.pendingDestination, output));
  EXPECT_EQ(123u, output);
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, key, got));
  ASSERT_TRUE(got.pendingDestination);
  EXPECT_EQ(71u, got.pendingDestination->epoch);
}

TEST_F(DeliveryCoreReferences,
       PendingBindingsRejectBoundAndDuplicateDestinations) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 29));
  nsMsgKey source, bound, fresh;
  ASSERT_EQ(NS_OK, Add("source@invalid"_ns, {}, source));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(source, mFolderId, 29, 42));
  RawHdr raw;
  raw.messageId = "bound-staged@invalid"_ns;
  RefPtr<Message> header;
  ASSERT_EQ(NS_OK,
            db.StageMessage(mFolderId, raw, &bound, getter_AddRefs(header)));
  ASSERT_EQ(NS_OK, header->SetUint32Property("uidOnServer", 0));
  raw.messageId = "fresh-staged@invalid"_ns;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &fresh));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kFlagsChanged;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, input));
  input.operation = nsIMsgOfflineImapOperation::kMsgMoved;
  input.pendingDestination = Some(PendingDestination{mFolderId, bound, 29});
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.StoreOfflineOperation(mFolderId, source, input));
  input.pendingDestination = Some(PendingDestination{mFolderId, fresh, 29});
  input.operation |= nsIMsgOfflineImapOperation::kMsgCopy;
  input.copyDestinations = {"imap://duplicate"_ns};
  input.copyDestinationBindings.AppendElement(input.pendingDestination);
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.StoreOfflineOperation(mFolderId, source, input));
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, source, got));
  EXPECT_EQ(uint32_t(nsIMsgOfflineImapOperation::kFlagsChanged), got.operation);
  EXPECT_FALSE(got.pendingDestination);
  EXPECT_TRUE(got.copyDestinations.IsEmpty());
}

TEST_F(DeliveryCoreReferences,
       PendingAssociationSqlFailurePreservesPayloadAndOutput) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 37));
  nsMsgKey source, control, first, second;
  ASSERT_EQ(NS_OK, Add("source@invalid"_ns, {}, source));
  ASSERT_EQ(NS_OK, Add("control@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(source, mFolderId, 37, 42));
  ASSERT_EQ(NS_OK, Add("target-one@invalid"_ns, {}, first));
  ASSERT_EQ(NS_OK, Add("target-two@invalid"_ns, {}, second));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kMsgCopy;
  input.copyDestinations = {"imap://old"_ns};
  input.keywordsToAdd = "old payload"_ns;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, input));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK, mConnection->CreateFunction("pending_fault"_ns, 1, witness));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "CREATE TEMP TRIGGER fail_pending_copy BEFORE INSERT ON "
                "offline_copy_destinations "
                "WHEN NEW.ordinal=1 BEGIN SELECT pending_fault(NEW.ordinal); "
                "SELECT RAISE(ABORT,'pending tuple write'); END"_ns));
  input.copyDestinations = {"imap://first"_ns, "imap://second"_ns};
  input.copyDestinationBindings.AppendElement(
      Some(PendingDestination{mFolderId, first, 37}));
  input.copyDestinationBindings.AppendElement(
      Some(PendingDestination{mFolderId, second, 37}));
  input.keywordsToAdd = "new payload"_ns;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.StoreOfflineOperation(mFolderId, source, input));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(1, witness->mLastKey);
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, source, got));
  EXPECT_EQ("old payload"_ns, got.keywordsToAdd);
  EXPECT_EQ((nsTArray<nsCString>{"imap://old"_ns}), got.copyDestinations);
  ASSERT_EQ(1u, got.copyDestinationBindings.Length());
  EXPECT_FALSE(got.copyDestinationBindings[0]);
  ASSERT_NO_FATAL_FAILURE(CheckOfflineSource(source, 37, 42));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER fail_pending_copy"_ns));
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, input));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "CREATE TEMP VIEW offline_copy_destinations AS SELECT * "
                       "FROM main.offline_copy_destinations "
                       "WHERE abs(-9223372036854775808)"_ns));
  got.operation = 123;
  got.pendingDestination = Some(PendingDestination{99, 98, 97});
  got.copyDestinations = {"untouched"_ns};
  EXPECT_EQ(NS_ERROR_FAILURE, db.GetOfflineOperation(mFolderId, source, got));
  EXPECT_EQ(123u, got.operation);
  ASSERT_TRUE(got.pendingDestination);
  EXPECT_EQ(99u, got.pendingDestination->folderId);
  EXPECT_EQ(98u, got.pendingDestination->key);
  EXPECT_EQ(97u, got.pendingDestination->epoch);
  EXPECT_EQ((nsTArray<nsCString>{"untouched"_ns}), got.copyDestinations);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.offline_copy_destinations"_ns));
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, source, got));
  EXPECT_EQ("new payload"_ns, got.keywordsToAdd);
  ASSERT_EQ(2u, got.copyDestinationBindings.Length());
  ASSERT_TRUE(got.copyDestinationBindings[1]);
  EXPECT_EQ(second, got.copyDestinationBindings[1]->key);
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "UPDATE offline_copy_destinations SET destinationEpoch=NULL WHERE ordinal=0"_ns));
  got.operation = 123;
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            db.GetOfflineOperation(mFolderId, source, got));
  EXPECT_EQ(123u, got.operation);
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, input));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  input.keywordsToAdd = "foreign transaction must remain owned"_ns;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.StoreOfflineOperation(mFolderId, source, input));
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, source, got));
  EXPECT_EQ("new payload"_ns, got.keywordsToAdd);
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreReferences,
       PendingBindingUpgradePreservesAbsentLegacyTuples) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 43));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("legacy-payload@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 43, 42));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kMsgCopy;
  input.copyDestinations = {"imap://repeat"_ns, "imap://repeat"_ns};
  input.keywordsToRemove = "preserved"_ns;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, input));
  Stop();
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  // Restore the exact previous columns on a real core-created database.
  ASSERT_EQ(
      NS_OK,
      old->ExecuteSimpleSQL(
          "DROP TABLE folder_import_windows;"
          "DROP TRIGGER thread_flags_message_delete; DROP TRIGGER "
          "thread_flags_folder_delete;"
          "DROP TABLE thread_flags;"
          "DROP TRIGGER guard_folder_id; DROP TRIGGER record_folder_id;"
          "DROP TRIGGER immutable_folder_id; DROP TABLE folder_id_allocator;"
          "ALTER TABLE offline_operations DROP COLUMN destinationFolderId;"
          "ALTER TABLE offline_operations DROP COLUMN destinationKey;"
          "ALTER TABLE offline_operations DROP COLUMN destinationEpoch;"
          "ALTER TABLE offline_copy_destinations DROP COLUMN "
          "destinationFolderId;"
          "ALTER TABLE offline_copy_destinations DROP COLUMN destinationKey;"
          "ALTER TABLE offline_copy_destinations DROP COLUMN destinationEpoch;"_ns));
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL("DROP TABLE folder_cache_bindings; DROP TABLE folder_cache_imports"_ns));
  ASSERT_EQ(NS_OK, old->SetSchemaVersion(10));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
  int32_t version;
  ASSERT_EQ(NS_OK, mConnection->GetSchemaVersion(&version));
  EXPECT_EQ(15, version);
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetOfflineOperation(mFolderId, key, got));
  EXPECT_EQ(input.operation, got.operation);
  EXPECT_EQ(input.copyDestinations, got.copyDestinations);
  EXPECT_EQ("preserved"_ns, got.keywordsToRemove);
  EXPECT_FALSE(got.pendingDestination);
  ASSERT_EQ(2u, got.copyDestinationBindings.Length());
  EXPECT_FALSE(got.copyDestinationBindings[0]);
  EXPECT_FALSE(got.copyDestinationBindings[1]);
  ASSERT_NO_FATAL_FAILURE(CheckOfflineSource(key, 43, 42));
}

TEST_F(DeliveryCoreReferences, PendingCopyTailRetainsIdentityWithoutDispatch) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 71));
  nsMsgKey source, first, second;
  ASSERT_EQ(NS_OK, Add("copy-source@invalid"_ns, {}, source));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(source, mFolderId, 71, 900));
  RawHdr raw;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &first));
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &second));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kMsgCopy;
  input.copyDestinations = {"imap://first"_ns, "imap://second"_ns};
  input.copyDestinationBindings = {
      Some(PendingDestination{mFolderId, first, 71}),
      Some(PendingDestination{mFolderId, second, 71})};
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, input));
  input.operation = 0;
  input.copyDestinations.RemoveElementAt(0);
  input.copyDestinationBindings.RemoveElementAt(0);
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, input));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->MessageDB();
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperation(mFolderId, source, got));
  EXPECT_EQ(0u, got.operation);
  EXPECT_EQ((nsTArray<nsCString>{"imap://second"_ns}), got.copyDestinations);
  ASSERT_EQ(1u, got.copyDestinationBindings.Length());
  ASSERT_TRUE(got.copyDestinationBindings[0]);
  EXPECT_EQ(second, got.copyDestinationBindings[0]->key);
  EXPECT_EQ(mFolderId, got.copyDestinationBindings[0]->folderId);
  EXPECT_EQ(71u, got.copyDestinationBindings[0]->epoch);
  uint64_t attempt = 123;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            reopened.BeginOfflineAttempt(
                mFolderId, source, nsIMsgOfflineImapOperation::kMsgCopy,
                got.copyDestinationBindings[0], attempt));
  EXPECT_EQ(123u, attempt);
  got.operation = nsIMsgOfflineImapOperation::kMsgCopy;
  ASSERT_EQ(NS_OK, reopened.StoreOfflineOperation(mFolderId, source, got));
  ASSERT_EQ(NS_OK, reopened.BeginOfflineAttempt(
                       mFolderId, source, nsIMsgOfflineImapOperation::kMsgCopy,
                       got.copyDestinationBindings[0], attempt));
  got.operation = 0;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            reopened.StoreOfflineOperation(mFolderId, source, got));
  ASSERT_EQ(NS_OK, reopened.MarkOfflineAttemptAmbiguous(attempt));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            reopened.StoreOfflineOperation(mFolderId, source, got));
}

TEST_F(DeliveryCoreReferences, PendingCopyTailStillValidatesPhysicalBinding) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 73));
  nsMsgKey source, destination;
  ASSERT_EQ(NS_OK, Add("tail-control@invalid"_ns, {}, source));
  RawHdr raw;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &destination));
  OfflineOperationData input;
  input.copyDestinations = {"imap://tail"_ns};
  input.copyDestinationBindings = {
      Some(PendingDestination{mFolderId, destination, 73})};
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, source, input));
  input.copyDestinationBindings[0]->epoch = 74;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.StoreOfflineOperation(mFolderId, source, input));
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, db.GetOfflineOperation(mFolderId, source, got));
  ASSERT_TRUE(got.copyDestinationBindings[0]);
  EXPECT_EQ(73u, got.copyDestinationBindings[0]->epoch);
  EXPECT_EQ(destination, got.copyDestinationBindings[0]->key);
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(destination, mFolderId, 73, 901));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.StoreOfflineOperation(mFolderId, source, got));
}

TEST_F(DeliveryCoreReferences, AccountRootRetirementGuardsPhysicalIdentity) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  auto& messages = mCore->MessageDB();
  nsCString sourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(sourceId));
  uint64_t root, child;
  ASSERT_EQ(NS_OK, folders.InsertRoot("retired-server"_ns, &root));
  ASSERT_EQ(NS_OK, folders.InsertFolder(root, "Saved"_ns, &child));
  RawHdr raw;
  raw.messageId = "retained-account@invalid"_ns;
  raw.subject = "retained subject"_ns;
  raw.storeToken = Some(nsCString("original-token"_ns));
  raw.messageSize = Some(uint32_t(123));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, messages.AddMessage(child, raw, true, &key));
  MessageBodyState before;
  ASSERT_EQ(NS_OK, messages.GetMessageBodyState(key, before));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            DatabaseCore::RetireAccountRoot(root, "retired-server"_ns,
                                            "wrong-db"_ns));
  EXPECT_EQ(NS_ERROR_UNEXPECTED, DatabaseCore::RetireAccountRoot(
                                     root, "another-server"_ns, sourceId));
  EXPECT_EQ(NS_ERROR_UNEXPECTED, folders.DeleteFolder(root));
  auto name = folders.GetFolderName(child);
  ASSERT_TRUE(name.isOk());
  EXPECT_EQ("Saved"_ns, name.unwrap());
  ASSERT_EQ(NS_OK, DatabaseCore::RetireAccountRoot(root, "retired-server"_ns,
                                                   sourceId));
  EXPECT_TRUE(folders.GetFolderName(root).isErr());
  EXPECT_TRUE(folders.GetFolderName(child).isErr());
  CapturedMessage captured;
  ASSERT_EQ(NS_OK, messages.CaptureMessage(key, captured));
  EXPECT_EQ(key, captured.id);
  EXPECT_EQ(child, captured.folderId);
  EXPECT_EQ("retained-account@invalid"_ns, captured.messageId);
  EXPECT_EQ("retained subject"_ns, captured.subject);
  MessageBodyState after;
  ASSERT_EQ(NS_OK, messages.GetMessageBodyState(key, after));
  EXPECT_EQ(child, after.folderId);
  EXPECT_EQ(Some(nsCString("original-token"_ns)), after.storeToken);
  EXPECT_EQ(123u, after.messageSize);
  EXPECT_EQ(before.contentRevision, after.contentRevision);
  EXPECT_EQ(before.locationRevision, after.locationRevision);
  uint64_t replacement;
  ASSERT_EQ(NS_OK, folders.InsertRoot("retired-server"_ns, &replacement));
  EXPECT_GT(replacement, child);
  uint64_t found;
  ASSERT_EQ(NS_OK, folders.GetFolderByPath("retired-server/Saved"_ns, &found));
  EXPECT_EQ(0u, found);
}

TEST_F(DeliveryCoreReferences, FolderDeletionFailureKeepsSqlCacheAndPolicy) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t branch, leaf, control;
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Doomed"_ns, &branch));
  ASSERT_EQ(NS_OK, folders.InsertFolder(branch, "Leaf"_ns, &leaf));
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Control"_ns, &control));
  ASSERT_TRUE(folders.GetFolderName(branch).isOk());
  ASSERT_TRUE(folders.GetFolderName(leaf).isOk());
  nsCOMPtr<mozIStorageStatement> watermark;
  ASSERT_EQ(NS_OK,
            mConnection->CreateStatement(
                "SELECT COALESCE(MAX(sequence),0) FROM message_changes"_ns,
                getter_AddRefs(watermark)));
  bool more;
  ASSERT_EQ(NS_OK, watermark->ExecuteStep(&more));
  ASSERT_TRUE(more);
  int64_t before;
  ASSERT_EQ(NS_OK, watermark->GetInt64(0, &before));
  ASSERT_EQ(NS_OK, watermark->Finalize());
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK, mConnection->CreateFunction("folder_fault"_ns, 1, witness));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_folder_delete AFTER DELETE ON folders "
          "BEGIN SELECT folder_fault(OLD.id); SELECT RAISE(ABORT,'folder deletion'); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, folders.DeleteFolder(branch));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_TRUE(witness->mLastKey == int64_t(branch) ||
              witness->mLastKey == int64_t(leaf));
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  auto name = folders.GetFolderName(branch);
  ASSERT_TRUE(name.isOk());
  EXPECT_EQ("Doomed"_ns, name.unwrap());
  name = folders.GetFolderName(leaf);
  ASSERT_TRUE(name.isOk());
  EXPECT_EQ("Leaf"_ns, name.unwrap());
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  nsCOMPtr<mozIStorageStatement> stmt;
  auto close = MakeScopeExit([&] {
    if (stmt) {
      EXPECT_EQ(NS_OK, stmt->Finalize());
    }
    EXPECT_EQ(NS_OK, reader->Close());
  });
  ASSERT_EQ(
      NS_OK,
      reader->CreateStatement(
          "SELECT (SELECT COUNT(*) FROM folders WHERE id IN (:branch,:leaf)), "
          "(SELECT COALESCE(MAX(sequence),0) FROM message_changes)"_ns,
          getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("branch"_ns, branch));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("leaf"_ns, leaf));
  ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
  ASSERT_TRUE(more);
  int64_t count, after;
  ASSERT_EQ(NS_OK, stmt->GetInt64(0, &count));
  ASSERT_EQ(NS_OK, stmt->GetInt64(1, &after));
  EXPECT_EQ(2, count);
  EXPECT_EQ(before, after);
  ASSERT_EQ(NS_OK, stmt->Reset());
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER reject_folder_delete"_ns));
  ASSERT_EQ(NS_OK, folders.DeleteFolder(branch));
  EXPECT_TRUE(folders.GetFolderName(leaf).isErr());
  EXPECT_TRUE(folders.GetFolderName(control).isOk());
}

TEST_F(DeliveryCoreReferences, FolderMutationsLeaveCallerTransactionOwned) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  nsCString sourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(sourceId));
  auto root = folders.GetFolderRoot(mFolderId);
  ASSERT_TRUE(root.isOk());
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  uint64_t output = 123;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            folders.InsertFolder(mFolderId, "Pending"_ns, &output));
  EXPECT_EQ(123u, output);
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, folders.DeleteFolder(mFolderId));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            DatabaseCore::RetireAccountRoot(
                root.unwrap(), "delivery-references"_ns, sourceId));
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  uint64_t found;
  ASSERT_EQ(NS_OK, folders.GetFolderByPath(
                       "delivery-references/Inbox/Pending"_ns, &found));
  EXPECT_EQ(0u, found);
  ASSERT_EQ(NS_OK, folders.InsertFolder(mFolderId, "Pending"_ns, &output));
  ASSERT_EQ(NS_OK, folders.GetFolderByPath(
                       "delivery-references/Inbox/Pending"_ns, &found));
  EXPECT_EQ(output, found);
}

TEST_F(DeliveryCoreReferences, FolderIdsSurviveReopenAndOldOrphanUpgrade) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t removed;
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolderId, "Retired"_ns, &removed));
  RawHdr raw;
  raw.messageId = "old-folder-history@invalid"_ns;
  nsMsgKey message;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(removed, raw, true, &message));
  ASSERT_EQ(NS_OK, mCore->FolderDB().DeleteFolder(removed));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  uint64_t next;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "Next"_ns, &next));
  EXPECT_GT(next, removed);
  ASSERT_EQ(NS_OK, mCore->FolderDB().DeleteFolder(next));
  Stop();
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  // The previous real layout had retained orphan rows but no folder allocator.
  ASSERT_EQ(
      NS_OK,
      old->ExecuteSimpleSQL(
          "DROP TABLE folder_import_windows;"
          "DROP TRIGGER thread_flags_message_delete; DROP TRIGGER "
          "thread_flags_folder_delete;"
          "DROP TABLE thread_flags;"
          "DROP TRIGGER guard_folder_id; DROP TRIGGER record_folder_id;"
          "DROP TRIGGER immutable_folder_id; DROP TABLE folder_id_allocator;"_ns));
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL("DROP TABLE folder_cache_bindings; DROP TABLE folder_cache_imports"_ns));
  ASSERT_EQ(NS_OK, old->SetSchemaVersion(11));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolderId, "Fresh"_ns, &next));
  EXPECT_GT(next, removed);
  CapturedMessage captured;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(message, captured));
  EXPECT_EQ(removed, captured.folderId);
  EXPECT_EQ("old-folder-history@invalid"_ns, captured.messageId);
}

TEST_F(DeliveryCoreReferences, RetiredFolderDatabaseCannotMutateReopenedCore) {
  ASSERT_EQ(NS_OK, Start());
  RefPtr<FolderDatabase> old = &mCore->FolderDB();
  ASSERT_TRUE(old->GetFolderName(mFolderId).isOk());
  Stop();
  ASSERT_EQ(NS_OK, Start());
  uint64_t output = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            old->InsertFolder(mFolderId, "Old writer"_ns, &output));
  EXPECT_EQ(123u, output);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, old->DeleteFolder(mFolderId));
  uint64_t found;
  ASSERT_EQ(NS_OK, mCore->FolderDB().GetFolderByPath(
                       "delivery-references/Inbox/Old%20writer"_ns, &found));
  EXPECT_EQ(0u, found);
  EXPECT_TRUE(mCore->FolderDB().GetFolderName(mFolderId).isOk());
}

TEST_F(DeliveryCoreReferences,
       FolderAllocationFailureLeavesOutputAndRowsIntact) {
  ASSERT_EQ(NS_OK, Start());
  auto& folders = mCore->FolderDB();
  uint64_t output = 123;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            folders.InsertFolder(UINT64_MAX, "Invalid parent"_ns, &output));
  EXPECT_EQ(123u, output);
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "UPDATE folder_id_allocator SET highWater=9223372036854775807"_ns));
  EXPECT_EQ(NS_ERROR_ILLEGAL_VALUE,
            folders.InsertFolder(mFolderId, "Exhausted"_ns, &output));
  EXPECT_EQ(123u, output);
  uint64_t found;
  ASSERT_EQ(NS_OK, folders.GetFolderByPath(
                       "delivery-references/Inbox/Exhausted"_ns, &found));
  EXPECT_EQ(0u, found);
  EXPECT_TRUE(folders.GetFolderName(mFolderId).isOk());
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
}
TEST_F(DeliveryCoreReferences, ThreadOrderKeepsOrphansAndForeignConnectors) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  uint64_t otherFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "Other"_ns,
                                                  &otherFolder));
  nsMsgKey root, branch, child, sibling, grandchild, control, thread;
  ASSERT_EQ(NS_OK, Add("order-root@invalid"_ns, {}, root));
  RawHdr foreign;
  foreign.messageId = "foreign-branch@invalid"_ns;
  foreign.references = {"order-root@invalid"_ns};
  ASSERT_EQ(NS_OK, db.AddMessage(otherFolder, foreign, true, &branch));
  ASSERT_EQ(NS_OK,
            Add("local-child@invalid"_ns,
                {"order-root@invalid"_ns, "foreign-branch@invalid"_ns}, child));
  ASSERT_EQ(NS_OK,
            Add("sibling@invalid"_ns, {"order-root@invalid"_ns}, sibling));
  ASSERT_EQ(NS_OK,
            Add("grandchild@invalid"_ns,
                {"order-root@invalid"_ns, "sibling@invalid"_ns}, grandchild));
  ASSERT_EQ(NS_OK, Add("unrelated@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(root, thread));
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, ThreadKeys(mFolderId, 0, thread, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{root, child, sibling, grandchild}), keys);
  ASSERT_EQ(NS_OK, ThreadKeys(mFolderId, branch, thread, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{child}), keys);
  ASSERT_EQ(NS_OK, ThreadChildren(mFolderId, root, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{sibling}), keys);
  ASSERT_EQ(NS_OK, db.RemoveMessage(root));
  ASSERT_EQ(NS_OK, ThreadKeys(mFolderId, 0, thread, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{child, sibling, grandchild}), keys);
  ASSERT_EQ(NS_OK, db.RemoveMessage(branch));
  ASSERT_EQ(NS_OK, db.RemoveMessage(sibling));
  ASSERT_EQ(NS_OK, ThreadKeys(mFolderId, 0, thread, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{child, grandchild}), keys);
  uint64_t count, date;
  ASSERT_EQ(NS_OK, ThreadCount(mFolderId, thread, &count));
  EXPECT_EQ(2u, count);
  ASSERT_EQ(NS_OK, ThreadMaxDate(mFolderId, thread, &date));
  EXPECT_EQ(123456u, date);
  CapturedMessage captured;
  ASSERT_EQ(NS_OK, db.CaptureMessage(grandchild, captured));
  EXPECT_EQ(sibling, captured.threadParent);
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreReferences,
       ThreadReadErrorsPreserveOutputsAndCallerTransaction) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey root, child, thread, control;
  ASSERT_EQ(NS_OK, Add("read-root@invalid"_ns, {}, root));
  ASSERT_EQ(NS_OK,
            Add("late-fault@invalid"_ns, {"read-root@invalid"_ns}, child));
  ASSERT_EQ(NS_OK, Add("read-control@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(root, thread));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active;
    if (NS_SUCCEEDED(mConnection->GetTransactionInProgress(&active)) &&
        active) {
      EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
    }
  });
  ASSERT_EQ(NS_OK, db.SetMessageProperty(control, "caller"_ns, "retained"_ns));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP VIEW messages AS SELECT * FROM main.messages WHERE "
          "CASE WHEN messageId='late-fault@invalid' THEN "
          "abs(-9223372036854775808) "
          "ELSE 1 END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.messages"_ns));
  });
  nsTArray<nsMsgKey> children{77, 88}, members{99};
  EXPECT_EQ(NS_ERROR_FAILURE, ThreadChildren(mFolderId, root, children));
  EXPECT_EQ((nsTArray<nsMsgKey>{77, 88}), children);
  EXPECT_EQ(NS_ERROR_FAILURE, ThreadKeys(mFolderId, 0, thread, members));
  EXPECT_EQ((nsTArray<nsMsgKey>{99}), members);
  uint64_t count = 444, date = 555;
  EXPECT_EQ(NS_ERROR_FAILURE, ThreadCount(mFolderId, thread, &count));
  EXPECT_EQ(444u, count);
  EXPECT_EQ(NS_ERROR_FAILURE, ThreadMaxDate(mFolderId, thread, &date));
  EXPECT_EQ(555u, date);
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL("DROP VIEW temp.messages"_ns));
  ASSERT_EQ(NS_OK, ThreadChildren(mFolderId, root, children));
  EXPECT_EQ((nsTArray<nsMsgKey>{child}), children);
  ASSERT_EQ(NS_OK, ThreadKeys(mFolderId, 0, thread, members));
  EXPECT_EQ((nsTArray<nsMsgKey>{root, child}), members);
  ASSERT_EQ(NS_OK, ThreadCount(mFolderId, thread, &count));
  EXPECT_EQ(2u, count);
  ASSERT_EQ(NS_OK, ThreadMaxDate(mFolderId, thread, &date));
  EXPECT_EQ(123456u, date);
  ASSERT_EQ(NS_OK, mConnection->CommitTransaction());
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(control, "caller"_ns, text));
  EXPECT_EQ("retained"_ns, text);
}

TEST_F(DeliveryCoreReferences, ThreadReadsRejectInvalidKeysAndParentCycles) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey root, child, thread;
  ASSERT_EQ(NS_OK, Add("cycle-root@invalid"_ns, {}, root));
  ASSERT_EQ(NS_OK,
            Add("cycle-child@invalid"_ns, {"cycle-root@invalid"_ns}, child));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(root, thread));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "CREATE TEMP VIEW messages AS SELECT 4294967295 AS id,folderId,"
                "threadId,threadParent FROM main.messages"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.messages"_ns));
  });
  nsTArray<nsMsgKey> keys{77};
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, ThreadChildren(mFolderId, root, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{77}), keys);
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, ThreadKeys(mFolderId, 0, thread, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{77}), keys);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL("DROP VIEW temp.messages"_ns));
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(NS_OK, mConnection->CreateStatement(
                       "UPDATE messages SET threadParent=id WHERE id=:id"_ns,
                       getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, root));
  ASSERT_EQ(NS_OK, stmt->Execute());
  ASSERT_EQ(NS_OK, stmt->Finalize());
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, ThreadKeys(mFolderId, 0, thread, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{77}), keys);
  ASSERT_EQ(NS_OK, mConnection->CreateStatement(
                       "UPDATE messages SET threadParent=0 WHERE id=:id"_ns,
                       getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, root));
  ASSERT_EQ(NS_OK, stmt->Execute());
  ASSERT_EQ(NS_OK, stmt->Finalize());
  ASSERT_EQ(NS_OK, ThreadKeys(mFolderId, 0, thread, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{root, child}), keys);
}

TEST_F(DeliveryCoreReferences, ThreadFlagsAreScopedAndSeparateFromHeaderFlags) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  uint64_t otherFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "FlagsOther"_ns,
                                                  &otherFolder));
  nsMsgKey root, other, thread;
  ASSERT_EQ(NS_OK, Add("flags-root@invalid"_ns, {}, root));
  RawHdr raw;
  raw.messageId = "flags-other@invalid"_ns;
  raw.references = {"flags-root@invalid"_ns};
  ASSERT_EQ(NS_OK, db.AddMessage(otherFolder, raw, true, &other));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(root, thread));
  uint32_t flags = 99;
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(0u, flags);
  ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, thread, UINT32_MAX));
  ASSERT_EQ(NS_OK,
            db.SetThreadFlags(otherFolder, thread, nsMsgMessageFlags::Watched));
  ASSERT_EQ(NS_OK, db.GetMessageFlags(root, flags));
  EXPECT_EQ(0u, flags);
  ASSERT_EQ(NS_OK, db.GetMessageFlags(other, flags));
  EXPECT_EQ(0u, flags);
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(UINT32_MAX, flags);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetThreadFlags(otherFolder, thread, flags));
  EXPECT_EQ(nsMsgMessageFlags::Watched, flags);
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  nsCOMPtr<mozIStorageStatement> stmt;
  auto close = MakeScopeExit([&] {
    if (stmt) {
      EXPECT_EQ(NS_OK, stmt->Finalize());
    }
    EXPECT_EQ(NS_OK, reader->Close());
  });
  ASSERT_EQ(
      NS_OK,
      reader->CreateStatement(
          "SELECT flags FROM thread_flags WHERE folderId=:folder AND threadId=:thread"_ns,
          getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("folder"_ns, mFolderId));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("thread"_ns, thread));
  bool more;
  ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
  ASSERT_TRUE(more);
  int64_t stored;
  ASSERT_EQ(NS_OK, stmt->GetInt64(0, &stored));
  EXPECT_EQ(int64_t(UINT32_MAX), stored);
}

TEST_F(DeliveryCoreReferences, ThreadFlagsSurviveRootUntilLastScopedMember) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey root, child, thread;
  ASSERT_EQ(NS_OK, Add("state-root@invalid"_ns, {}, root));
  ASSERT_EQ(NS_OK,
            Add("state-child@invalid"_ns, {"state-root@invalid"_ns}, child));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(root, thread));
  ASSERT_EQ(NS_OK,
            db.SetThreadFlags(mFolderId, thread, nsMsgMessageFlags::Ignored));
  ASSERT_EQ(NS_OK, db.RemoveMessage(root));
  uint32_t flags;
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(nsMsgMessageFlags::Ignored, flags);
  ASSERT_EQ(NS_OK, db.RemoveMessage(child));
  flags = 99;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(99u, flags);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.SetThreadFlags(mFolderId, thread, 1));
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(NS_OK,
            mConnection->CreateStatement("SELECT COUNT(*) FROM thread_flags"_ns,
                                         getter_AddRefs(stmt)));
  bool more;
  ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
  ASSERT_TRUE(more);
  int64_t count;
  ASSERT_EQ(NS_OK, stmt->GetInt64(0, &count));
  EXPECT_EQ(0, count);
  ASSERT_EQ(NS_OK, stmt->Finalize());
}

TEST_F(DeliveryCoreReferences,
       ThreadFlagWriteFailureLeavesCallerAndWordIntact) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey root, thread, control;
  ASSERT_EQ(NS_OK, Add("word-root@invalid"_ns, {}, root));
  ASSERT_EQ(NS_OK, Add("word-control@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(root, thread));
  ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, thread, 0x80000000));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active;
    if (NS_SUCCEEDED(mConnection->GetTransactionInProgress(&active)) &&
        active) {
      EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
    }
  });
  ASSERT_EQ(NS_OK, db.SetMessageProperty(control, "caller"_ns, "retained"_ns));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.SetThreadFlags(mFolderId, thread, 1));
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->CommitTransaction());
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER fail_thread_word BEFORE UPDATE ON thread_flags "
          "BEGIN SELECT RAISE(ABORT,'thread word failure'); END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS fail_thread_word"_ns));
  });
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.SetThreadFlags(mFolderId, thread, 1));
  uint32_t flags;
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(0x80000000u, flags);
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(control, "caller"_ns, text));
  EXPECT_EQ("retained"_ns, text);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER fail_thread_word"_ns));
  ASSERT_EQ(NS_OK,
            db.SetThreadFlags(mFolderId, thread, nsMsgMessageFlags::Watched));
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(nsMsgMessageFlags::Watched, flags);
}

TEST_F(DeliveryCoreReferences, ThreadFlagReadFailureLeavesOutputAndStoredWord) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey root, thread;
  ASSERT_EQ(NS_OK, Add("word-read@invalid"_ns, {}, root));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(root, thread));
  ASSERT_EQ(NS_OK,
            db.SetThreadFlags(mFolderId, thread, nsMsgMessageFlags::Ignored));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP VIEW thread_flags AS SELECT folderId,threadId,"
          "abs(-9223372036854775808) AS flags FROM main.thread_flags"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.thread_flags"_ns));
  });
  uint32_t flags = 0xabcdef12;
  EXPECT_EQ(NS_ERROR_FAILURE, db.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(0xabcdef12u, flags);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP VIEW temp.thread_flags"_ns));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "CREATE TEMP VIEW thread_flags AS SELECT folderId,threadId,"
                "4294967296 AS flags FROM main.thread_flags"_ns));
  flags = 0x12345678;
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            db.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(0x12345678u, flags);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP VIEW temp.thread_flags"_ns));
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(nsMsgMessageFlags::Ignored, flags);
}

TEST_F(DeliveryCoreReferences, ThreadFlagsUpgradeDoesNotInferHeaderIgnored) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey root, thread;
  ASSERT_EQ(NS_OK, Add("old-thread@invalid"_ns, {"absent@invalid"_ns}, root));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageThreadId(root, thread));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageFlag(
                       root, nsMsgMessageFlags::Ignored, true));
  Stop();
  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK,
            old->ExecuteSimpleSQL("DROP TABLE folder_import_windows;"
                                  "DROP TRIGGER thread_flags_message_delete; "
                                  "DROP TRIGGER thread_flags_folder_delete;"
                                  "DROP TABLE thread_flags"_ns));
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL("DROP TABLE folder_cache_bindings; DROP TABLE folder_cache_imports"_ns));
  ASSERT_EQ(NS_OK, old->SetSchemaVersion(12));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
  uint32_t flags = 99;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(0u, flags);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageFlags(root, flags));
  EXPECT_TRUE(flags & nsMsgMessageFlags::Ignored);
  nsTArray<nsCString> refs;
  ASSERT_EQ(NS_OK, Stored(root, refs));
  EXPECT_EQ((nsTArray<nsCString>{"absent@invalid"_ns}), refs);
}

TEST_F(DeliveryCoreReferences, ThreadFlagsRequirePhysicalFolderAndMembership) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key, thread;
  ASSERT_EQ(NS_OK, Add("physical-word@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(key, thread));
  uint64_t emptyFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "EmptyFlags"_ns,
                                                  &emptyFolder));
  uint32_t flags = 0x76543210;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetThreadFlags(emptyFolder, thread, flags));
  EXPECT_EQ(0x76543210u, flags);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.SetThreadFlags(emptyFolder, thread, 7));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.GetThreadFlags(0, thread, flags));
  EXPECT_EQ(0x76543210u, flags);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.SetThreadFlags(0, thread, 7));
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(0u, flags);
}

TEST_F(DeliveryCoreReferences, ConversationPlanOrderedCrossFolderChain) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t b;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "B"_ns, &b));
  nsMsgKey root, reply, tail, unrelated;
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "ordered-root@conversation.invalid"_ns, {}, root));
  ASSERT_EQ(NS_OK, AddAt(b, "ordered-reply@conversation.invalid"_ns,
                         {"ordered-root@conversation.invalid"_ns}, reply));
  ASSERT_EQ(NS_OK, AddAt(mFolderId, "ordered-tail@conversation.invalid"_ns,
                         {"ordered-root@conversation.invalid"_ns,
                          "ordered-reply@conversation.invalid"_ns},
                         tail));
  ASSERT_EQ(NS_OK, AddAt(b, "ordered-unrelated@conversation.invalid"_ns, {},
                         unrelated));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  MessageThreadBatch batch;
  ASSERT_EQ(NS_OK, PlanConversation(tail, true, batch));
  ASSERT_EQ(3u, batch.after.Length());
  ASSERT_EQ(2u, batch.before.Length());
  EXPECT_TRUE(batch.changedKeys.IsEmpty());
  ASSERT_TRUE(Planned(batch, root) && Planned(batch, reply) &&
              Planned(batch, tail));
  EXPECT_FALSE(Planned(batch, unrelated));
  EXPECT_EQ(root, Planned(batch, root)->threadId);
  EXPECT_EQ(0u, Planned(batch, root)->threadParent);
  EXPECT_EQ(root, Planned(batch, reply)->threadId);
  EXPECT_EQ(root, Planned(batch, reply)->threadParent);
  EXPECT_EQ(root, Planned(batch, tail)->threadId);
  EXPECT_EQ(reply, Planned(batch, tail)->threadParent);
  EXPECT_EQ(b, Planned(batch, reply)->folderId);
  EXPECT_EQ(mFolderId, Planned(batch, tail)->folderId);
}

TEST_F(DeliveryCoreReferences, ConversationPlanReplyBeforeParent) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t b;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "B"_ns, &b));
  nsMsgKey unrelated, reply, parent;
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "reply-first-unrelated@conversation.invalid"_ns,
                  {}, unrelated));
  ASSERT_EQ(NS_OK,
            AddAt(b, "reply-first-child@conversation.invalid"_ns,
                  {"reply-first-parent@conversation.invalid"_ns}, reply));
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "reply-first-parent@conversation.invalid"_ns, {},
                  parent));
  CapturedMessage before;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(reply, before));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  MessageThreadBatch batch;
  ASSERT_EQ(NS_OK, PlanConversation(parent, false, batch));
  ASSERT_EQ(2u, batch.after.Length());
  EXPECT_EQ((nsTArray<nsMsgKey>{reply}), batch.changedKeys);
  EXPECT_FALSE(batch.notifyLegacy);
  EXPECT_EQ(parent, batch.publicationKey);
  ASSERT_TRUE(Planned(batch, reply) && Planned(batch, parent));
  EXPECT_FALSE(Planned(batch, unrelated));
  EXPECT_EQ(parent, Planned(batch, reply)->threadId);
  EXPECT_EQ(parent, Planned(batch, reply)->threadParent);
  EXPECT_EQ(parent, Planned(batch, parent)->threadId);
  EXPECT_EQ(0u, Planned(batch, parent)->threadParent);
  CapturedMessage stored;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(reply, stored));
  EXPECT_EQ(before.threadId, stored.threadId);
  EXPECT_EQ(before.threadParent, stored.threadParent);
  EXPECT_EQ(before.flags, stored.flags);
  EXPECT_EQ(before.subject, stored.subject);
  nsTArray<nsCString> refs;
  ASSERT_EQ(NS_OK, Stored(reply, refs));
  EXPECT_EQ((nsTArray<nsCString>{"reply-first-parent@conversation.invalid"_ns}),
            refs);
}

TEST_F(DeliveryCoreReferences, ConversationPlanSiblingsWithMissingParent) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t b;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "B"_ns, &b));
  nsMsgKey unrelated, first, second;
  ASSERT_EQ(NS_OK, AddAt(mFolderId,
                         "siblings-missing-unrelated@conversation.invalid"_ns,
                         {}, unrelated));
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "siblings-missing-first@conversation.invalid"_ns,
                  {"siblings-missing-parent@conversation.invalid"_ns}, first));
  ASSERT_EQ(NS_OK,
            AddAt(b, "siblings-missing-second@conversation.invalid"_ns,
                  {"siblings-missing-parent@conversation.invalid"_ns}, second));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  MessageThreadBatch batch;
  ASSERT_EQ(NS_OK, PlanConversation(second, true, batch));
  ASSERT_EQ(2u, batch.after.Length());
  ASSERT_TRUE(Planned(batch, first) && Planned(batch, second));
  EXPECT_FALSE(Planned(batch, unrelated));
  EXPECT_EQ(first, Planned(batch, first)->threadId);
  EXPECT_EQ(first, Planned(batch, second)->threadId);
  EXPECT_EQ(0u, Planned(batch, first)->threadParent);
  EXPECT_EQ(0u, Planned(batch, second)->threadParent);
  EXPECT_TRUE(batch.changedKeys.IsEmpty());
}

TEST_F(DeliveryCoreReferences, ConversationPlanSiblingsThenParent) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t b;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "B"_ns, &b));
  nsMsgKey first, second, unrelated, parent;
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "siblings-late-first@conversation.invalid"_ns,
                  {"siblings-late-parent@conversation.invalid"_ns}, first));
  ASSERT_EQ(NS_OK,
            AddAt(b, "siblings-late-second@conversation.invalid"_ns,
                  {"siblings-late-parent@conversation.invalid"_ns}, second));
  ASSERT_EQ(NS_OK, AddAt(b, "siblings-late-unrelated@conversation.invalid"_ns,
                         {}, unrelated));
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "siblings-late-parent@conversation.invalid"_ns, {},
                  parent));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  MessageThreadBatch batch;
  ASSERT_EQ(NS_OK, PlanConversation(parent, true, batch));
  ASSERT_EQ(3u, batch.after.Length());
  EXPECT_EQ((nsTArray<nsMsgKey>{first, second}), batch.changedKeys);
  ASSERT_TRUE(Planned(batch, first) && Planned(batch, second) &&
              Planned(batch, parent));
  EXPECT_FALSE(Planned(batch, unrelated));
  EXPECT_EQ(parent, Planned(batch, first)->threadId);
  EXPECT_EQ(parent, Planned(batch, second)->threadId);
  EXPECT_EQ(parent, Planned(batch, first)->threadParent);
  EXPECT_EQ(parent, Planned(batch, second)->threadParent);
  EXPECT_EQ(parent, Planned(batch, parent)->threadId);
  EXPECT_EQ(0u, Planned(batch, parent)->threadParent);
}

TEST_F(DeliveryCoreReferences, ConversationPlanKeepsCopiesAndExactHistory) {
  ASSERT_EQ(NS_OK, Start());
  uint64_t b;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "B"_ns, &b));
  nsMsgKey first, copy, ownIdOnly, incoming;
  ASSERT_EQ(NS_OK, AddAt(mFolderId, "copies-parent"_ns, {}, first));
  ASSERT_EQ(NS_OK, AddAt(b, "copies-parent"_ns, {}, copy));
  ASSERT_EQ(NS_OK, AddAt(b, "copies-child"_ns, {}, ownIdOnly));
  nsTArray<nsCString> expected{""_ns, "copies-parent"_ns, "copies-parent"_ns,
                               "unresolved"_ns};
  ASSERT_EQ(NS_OK, AddAt(mFolderId, "copies-child"_ns, expected, incoming));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  MessageThreadBatch batch;
  ASSERT_EQ(NS_OK, PlanConversation(incoming, true, batch));
  ASSERT_EQ(3u, batch.after.Length());
  ASSERT_TRUE(Planned(batch, first) && Planned(batch, copy) &&
              Planned(batch, incoming));
  EXPECT_FALSE(Planned(batch, ownIdOnly));
  EXPECT_EQ(b, Planned(batch, copy)->folderId);
  EXPECT_EQ(first, Planned(batch, incoming)->threadParent);
  EXPECT_EQ(first, Planned(batch, first)->threadId);
  EXPECT_EQ(first, Planned(batch, copy)->threadId);
  EXPECT_EQ(first, Planned(batch, incoming)->threadId);
  nsTArray<nsCString> stored;
  ASSERT_EQ(NS_OK, Stored(incoming, stored));
  EXPECT_EQ(expected, stored);
  CapturedMessage other;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(ownIdOnly, other));
  EXPECT_EQ(ownIdOnly, other.threadId);
}

TEST_F(DeliveryCoreReferences, ConversationPlanFailurePreservesOutputAndOwner) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey seed, control;
  ASSERT_EQ(NS_OK, AddAt(mFolderId, "plan-seed"_ns, {"missing"_ns}, seed));
  ASSERT_EQ(NS_OK, AddAt(mFolderId, "plan-control"_ns, {}, control));
  MessageThreadBatch batch;
  batch.batchId = 71;
  batch.publicationKey = 77;
  batch.after.SetLength(1);
  batch.after[0].subject = "sentinel"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, PlanConversation(seed, true, batch));
  EXPECT_EQ(71u, batch.batchId);
  EXPECT_EQ(77u, batch.publicationKey);
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(control, "caller"_ns,
                                                         "retained"_ns));
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(NS_OK, mConnection->CreateStatement(
                       "DELETE FROM message_reference_sets WHERE id=:id"_ns,
                       getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, control));
  ASSERT_EQ(NS_OK, stmt->Execute());
  ASSERT_EQ(NS_OK, stmt->Finalize());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, PlanConversation(seed, true, batch));
  EXPECT_EQ(71u, batch.batchId);
  EXPECT_EQ(77u, batch.publicationKey);
  ASSERT_EQ(1u, batch.after.Length());
  EXPECT_EQ("sentinel"_ns, batch.after[0].subject);
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  nsCString text;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessageProperty(control, "caller"_ns, text));
  EXPECT_EQ("retained"_ns, text);
}

TEST_F(DeliveryCoreReferences, ConversationPlanReadFailureIsNotAnEmptyPlan) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey seed;
  ASSERT_EQ(NS_OK, AddAt(mFolderId, "plan-fault"_ns, {"missing"_ns}, seed));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP VIEW message_references AS SELECT id,ordinal,"
          "abs(-9223372036854775808) AS token FROM main.message_references"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.message_references"_ns));
  });
  MessageThreadBatch batch;
  batch.publicationKey = 77;
  EXPECT_EQ(NS_ERROR_FAILURE, PlanConversation(seed, true, batch));
  EXPECT_EQ(77u, batch.publicationKey);
  EXPECT_TRUE(batch.after.IsEmpty());
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.message_references"_ns));
  ASSERT_EQ(NS_OK, PlanConversation(seed, true, batch));
  ASSERT_EQ(1u, batch.after.Length());
  EXPECT_EQ(seed, batch.publicationKey);
  EXPECT_EQ(seed, batch.after[0].threadId);
  EXPECT_EQ(0u, batch.after[0].threadParent);
}

TEST_F(DeliveryCoreReferences, ConversationPlanDoesNotCloseReferenceCycle) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey first, second;
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "cycle-first"_ns, {"cycle-second"_ns}, first));
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "cycle-second"_ns, {"cycle-first"_ns}, second));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  MessageThreadBatch batch;
  ASSERT_EQ(NS_OK, PlanConversation(second, true, batch));
  ASSERT_EQ(2u, batch.after.Length());
  const auto* a = Planned(batch, first);
  const auto* b = Planned(batch, second);
  ASSERT_TRUE(a && b);
  EXPECT_TRUE((a->threadParent == 0 && b->threadParent == first) ||
              (b->threadParent == 0 && a->threadParent == second));
  EXPECT_EQ(a->threadId, b->threadId);
  EXPECT_EQ(a->threadParent == 0 ? first : second, a->threadId);
  nsTArray<nsCString> refs;
  ASSERT_EQ(NS_OK, Stored(first, refs));
  EXPECT_EQ((nsTArray<nsCString>{"cycle-second"_ns}), refs);
  refs.Clear();
  ASSERT_EQ(NS_OK, Stored(second, refs));
  EXPECT_EQ((nsTArray<nsCString>{"cycle-first"_ns}), refs);
}

TEST_F(DeliveryCoreReferences, GroupImmediateFailureRollsBackHotMembers) {
  ASSERT_NO_FATAL_FAILURE(CheckGroupingRollback(false));
}

TEST_F(DeliveryCoreReferences, GroupStagedFailureRetainsUnpublishedHeader) {
  ASSERT_NO_FATAL_FAILURE(CheckGroupingRollback(true));
}

TEST_F(DeliveryCoreReferences, GroupUnknownListenerRejectsBeforeSuccess) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  nsMsgKey child;
  ASSERT_EQ(NS_OK, Add("unaware-child"_ns, {"unaware-parent"_ns}, child));
  uint32_t calls = 0;
  RefPtr<AddedObserver> unaware = new AddedObserver([&](Message*) { ++calls; });
  db.AddMessageListener(unaware);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(unaware); });
  nsMsgKey output = nsMsgKey_None;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, Add("unaware-parent"_ns, {}, output));
  EXPECT_EQ(nsMsgKey_None, output);
  EXPECT_EQ(0u, calls);
  CapturedMessage row;
  ASSERT_EQ(NS_OK, db.CaptureMessage(child, row));
  EXPECT_EQ(0u, row.threadParent);
  uint64_t count;
  ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
  EXPECT_EQ(1u, count);
  db.RemoveMessageListener(unaware);
  ASSERT_EQ(NS_OK, Add("unaware-parent"_ns, {}, output));
  ASSERT_EQ(NS_OK, db.CaptureMessage(child, row));
  EXPECT_EQ(output, row.threadId);
  EXPECT_EQ(output, row.threadParent);
}

TEST_F(DeliveryCoreReferences, GroupUnknownHistoryIsNotAnEmptySingleton) {
  ASSERT_EQ(NS_OK, StartGrouping());
  nsMsgKey old;
  ASSERT_EQ(NS_OK, Add("history-row"_ns, {}, old));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DELETE FROM message_reference_sets"_ns));
  nsMsgKey output = nsMsgKey_None;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, Add("new-known-empty"_ns, {}, output));
  EXPECT_EQ(nsMsgKey_None, output);
  uint64_t count;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(1u, count);
  nsTArray<nsCString> refs{"sentinel"_ns};
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->MessageDB().GetMessageReferences(old, refs));
  EXPECT_EQ((nsTArray<nsCString>{"sentinel"_ns}), refs);
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
}

TEST_F(DeliveryCoreReferences,
       GroupReentrantChangesFollowWholeHistoricalBatch) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  nsMsgKey child;
  ASSERT_EQ(NS_OK, Add("queue-child"_ns, {"queue-parent"_ns}, child));
  RefPtr<Message> hot = new Message(child);
  nsMsgKey beforeThread;
  ASSERT_EQ(NS_OK, hot->GetThreadId(&beforeThread));
  nsTArray<nsCString> order;
  RefPtr<ThreadQueueObserver> a = new ThreadQueueObserver(),
                              b = new ThreadQueueObserver();
  nsMsgKey publication = nsMsgKey_None, nested = nsMsgKey_None;
  bool reentered = false;
  auto record = [&](const char* name, char kind, const CapturedMessage& before,
                    const CapturedMessage& after, Message* live, bool notify) {
    nsAutoCString label(name);
    label.Append(kind == 'P' && after.messageId == "nested-row"_ns ? 'N'
                                                                   : kind);
    order.AppendElement(label);
    if (kind == 'T') {
      EXPECT_EQ(child, after.id);
      EXPECT_EQ(beforeThread, before.threadId);
      EXPECT_EQ(publication, after.threadId);
      EXPECT_EQ(publication, after.threadParent);
      nsMsgKey current;
      EXPECT_EQ(NS_OK, hot->GetThreadId(&current));
      EXPECT_EQ(publication, current);
    }
    if (kind == 'P' && after.id == publication) {
      EXPECT_FALSE(notify);
      EXPECT_EQ(0u, after.flags);
      EXPECT_EQ("before"_ns, after.tags);
      bool exists = true;
      EXPECT_EQ(NS_OK, db.MessageExists(publication, exists));
      EXPECT_FALSE(exists);
      nsCString subject;
      EXPECT_EQ(NS_OK, live->GetSubject(subject));
      EXPECT_EQ("parent"_ns, subject);
    }
    if (kind == 'F') {
      EXPECT_EQ(0u, before.flags);
      EXPECT_EQ(nsMsgMessageFlags::Read, after.flags);
    }
    if (kind == 'G') {
      EXPECT_EQ("before"_ns, before.tags);
      EXPECT_EQ("after"_ns, after.tags);
      EXPECT_EQ(nsMsgMessageFlags::Read, after.flags);
    }
    if (kind == 'B') {
      EXPECT_EQ(nsMsgMessageFlags::Read, before.flags);
      EXPECT_EQ(uint32_t(nsMsgMessageFlags::Read | nsMsgMessageFlags::Offline),
                after.flags);
    }
    if (kind == 'R') {
      EXPECT_EQ(uint32_t(nsMsgMessageFlags::Read | nsMsgMessageFlags::Offline),
                before.flags);
    }
  };
  a->action = [&](char kind, const auto& before, const auto& after,
                  Message* live, bool notify) {
    record("A", kind, before, after, live, notify);
    if (kind != 'T' || reentered) {
      return;
    }
    reentered = true;
    EXPECT_EQ(NS_OK, db.SetMessageFlags(publication, nsMsgMessageFlags::Read));
    EXPECT_EQ(NS_OK, db.SetMessageTags(publication, "after"_ns));
    MessageBodyState body;
    ASSERT_EQ(NS_OK, db.GetMessageBodyState(publication, body));
    FinishedMessageBody finished;
    finished.storeToken = "after-token"_ns;
    finished.messageSize = 2;
    finished.offline = true;
    MessageBodyState settled;
    ASSERT_EQ(NS_OK, db.SettleMessageBody(body, finished, settled));
    EXPECT_EQ("after-token"_ns, *settled.storeToken);
    EXPECT_EQ(NS_OK, db.RemoveMessage(publication));
    EXPECT_EQ(NS_OK, Add("nested-row"_ns, {}, nested));
    EXPECT_EQ(1u, order.Length());
  };
  b->action = [&](char kind, const auto& before, const auto& after,
                  Message* live, bool notify) {
    record("B", kind, before, after, live, notify);
  };
  db.AddMessageListener(a);
  db.AddMessageListener(b);
  auto unwatch = MakeScopeExit([&] {
    db.RemoveMessageListener(a);
    db.RemoveMessageListener(b);
  });
  RawHdr parent;
  parent.messageId = "queue-parent"_ns;
  parent.subject = "parent"_ns;
  parent.keywords = "before"_ns;
  parent.storeToken = Some(nsCString("before-token"_ns));
  parent.messageSize = Some(1u);
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, parent, false, &publication));
  EXPECT_TRUE(reentered);
  EXPECT_EQ((nsTArray<nsCString>{"AT"_ns, "AP"_ns, "BT"_ns, "BP"_ns, "AF"_ns,
                                 "BF"_ns, "AG"_ns, "BG"_ns, "AB"_ns, "BB"_ns,
                                 "AR"_ns, "BR"_ns, "AN"_ns, "BN"_ns}),
            order);
  EXPECT_EQ(0u, a->ordinary + b->ordinary);
  EXPECT_EQ(Some(nsCString("before-token"_ns)), a->oldBody.storeToken);
  EXPECT_EQ(Some(nsCString("after-token"_ns)), b->newBody.storeToken);
  uint64_t count;
  ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
  EXPECT_EQ(2u, count);
}

TEST_F(DeliveryCoreReferences,
       GroupListenerReattachmentDoesNotReceiveOldBatch) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  nsMsgKey child;
  ASSERT_EQ(NS_OK, Add("reattach-child"_ns, {"reattach-parent"_ns}, child));
  RefPtr<ThreadQueueObserver> a = new ThreadQueueObserver(),
                              b = new ThreadQueueObserver();
  nsTArray<char> seen;
  b->action = [&](char kind, const auto&, const auto&, Message*, bool) {
    seen.AppendElement(kind);
  };
  a->action = [&](char kind, const auto&, const auto&, Message*, bool) {
    if (kind != 'T') {
      return;
    }
    db.RemoveMessageListener(b);
    db.AddMessageListener(b);
    EXPECT_EQ(NS_OK, db.SetMessageFlags(child, nsMsgMessageFlags::Read));
  };
  db.AddMessageListener(a);
  db.AddMessageListener(b);
  auto unwatch = MakeScopeExit([&] {
    db.RemoveMessageListener(a);
    db.RemoveMessageListener(b);
  });
  nsMsgKey parent;
  ASSERT_EQ(NS_OK, Add("reattach-parent"_ns, {}, parent));
  EXPECT_EQ((nsTArray<char>{'F'}), seen);
}

TEST_F(DeliveryCoreReferences, OrdinaryPublicationQueuesReentrantFlagFanout) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  RefPtr<ThreadQueueObserver> a = new ThreadQueueObserver(),
                              b = new ThreadQueueObserver();
  nsTArray<nsCString> order;
  a->action = [&](char kind, const auto&, const auto& after, Message*, bool) {
    order.AppendElement(kind == 'P' ? "AP"_ns : "AF"_ns);
    if (kind == 'P') {
      EXPECT_EQ(NS_OK, db.SetMessageFlags(after.id, nsMsgMessageFlags::Read));
    }
  };
  b->action = [&](char kind, const auto&, const auto& after, Message*, bool) {
    order.AppendElement(kind == 'P' ? "BP"_ns : "BF"_ns);
    EXPECT_EQ(kind == 'P' ? 0u : nsMsgMessageFlags::Read, after.flags);
  };
  db.AddMessageListener(a);
  db.AddMessageListener(b);
  auto unwatch = MakeScopeExit([&] {
    db.RemoveMessageListener(a);
    db.RemoveMessageListener(b);
  });
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("ordinary-queue"_ns, {}, key));
  EXPECT_EQ((nsTArray<nsCString>{"AP"_ns, "BP"_ns, "AF"_ns, "BF"_ns}), order);
}

TEST_F(DeliveryCoreReferences,
       GroupSiblingsAndPhysicalCopiesAcquireLateParent) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  uint64_t other;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "B"_ns, &other));
  nsMsgKey first, second, copy, control;
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "siblings-late-first@conversation.invalid"_ns,
                  {"siblings-late-parent@conversation.invalid"_ns}, first));
  ASSERT_EQ(NS_OK,
            AddAt(other, "siblings-late-second@conversation.invalid"_ns,
                  {"siblings-late-parent@conversation.invalid"_ns}, second));
  ASSERT_EQ(NS_OK,
            AddAt(other, "siblings-late-first@conversation.invalid"_ns,
                  {"siblings-late-parent@conversation.invalid"_ns}, copy));
  ASSERT_EQ(NS_OK,
            AddAt(other, "siblings-late-unrelated@conversation.invalid"_ns, {},
                  control));
  CapturedMessage a, b;
  ASSERT_EQ(NS_OK, db.CaptureMessage(first, a));
  ASSERT_EQ(NS_OK, db.CaptureMessage(second, b));
  EXPECT_NE(0u, a.threadId);
  EXPECT_EQ(a.threadId, b.threadId);
  EXPECT_EQ(0u, a.threadParent);
  EXPECT_EQ(0u, b.threadParent);
  RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
  nsTArray<nsMsgKey> changed;
  uint32_t publications = 0;
  observer->action = [&](char kind, const auto&, const auto& after, Message*,
                         bool) {
    if (kind == 'T') {
      changed.AppendElement(after.id);
    }
    if (kind == 'P') {
      ++publications;
    }
  };
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  nsMsgKey parent;
  ASSERT_EQ(NS_OK,
            AddAt(mFolderId, "siblings-late-parent@conversation.invalid"_ns, {},
                  parent));
  EXPECT_EQ((nsTArray<nsMsgKey>{first, second, copy}), changed);
  EXPECT_EQ(1u, publications);
  for (nsMsgKey key : {first, second, copy}) {
    CapturedMessage row;
    ASSERT_EQ(NS_OK, db.CaptureMessage(key, row));
    EXPECT_EQ(parent, row.threadId);
    EXPECT_EQ(parent, row.threadParent);
    nsTArray<nsCString> refs;
    ASSERT_EQ(NS_OK, Stored(key, refs));
    EXPECT_EQ(
        (nsTArray<nsCString>{"siblings-late-parent@conversation.invalid"_ns}),
        refs);
  }
  ASSERT_EQ(NS_OK, db.CaptureMessage(copy, b));
  EXPECT_EQ(other, b.folderId);
  ASSERT_EQ(NS_OK, db.CaptureMessage(control, b));
  EXPECT_EQ(control, b.threadId);
}

TEST_F(DeliveryCoreReferences, GroupStagedHistoryFailureRetainsCompleteDraft) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  nsMsgKey old;
  ASSERT_EQ(NS_OK, Add("old-history"_ns, {}, old));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DELETE FROM message_reference_sets"_ns));
  RawHdr raw;
  raw.messageId = "kept-staged"_ns;
  raw.storeToken = Some(nsCString(""_ns));
  raw.messageSize = Some(0u);
  nsMsgKey staged;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  Message* output = nullptr;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db.PublishMessage(staged, true, &output));
  EXPECT_EQ(nullptr, output);
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{staged}), keys);
  nsTArray<nsCString> names, refs;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(staged, names));
  EXPECT_TRUE(names.Contains("storeToken"_ns));
  EXPECT_TRUE(names.Contains("messageSize"_ns));
  ASSERT_EQ(NS_OK, db.GetMessageReferences(staged, refs));
  EXPECT_TRUE(refs.IsEmpty());
  uint64_t count;
  ASSERT_EQ(NS_OK, db.GetTotalCount(&count));
  EXPECT_EQ(1u, count);
}

TEST_F(DeliveryCoreReferences,
       HeaderStateReadsPublishedStagedAndGenuineAbsence) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey published, staged;
  ASSERT_EQ(NS_OK, Add("published-state"_ns, {}, published));
  RawHdr raw;
  raw.messageId = "staged-state"_ns;
  raw.flags = 0x80000000u;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  Maybe<CapturedMessage> state;
  ASSERT_EQ(NS_OK, db.CaptureHeaderState(staged, state));
  ASSERT_TRUE(state);
  EXPECT_EQ(staged, state->id);
  EXPECT_EQ(mFolderId, state->folderId);
  EXPECT_EQ(0x80000000u, state->flags);
  EXPECT_EQ(staged, state->threadId);
  EXPECT_EQ(0u, state->threadParent);
  bool exists = true;
  ASSERT_EQ(NS_OK, db.MessageExists(staged, exists));
  EXPECT_FALSE(exists);
  CapturedMessage publishedOnly;
  EXPECT_EQ(NS_ERROR_UNEXPECTED, db.CaptureMessage(staged, publishedOnly));
  ASSERT_EQ(NS_OK, db.CaptureHeaderState(published, state));
  ASSERT_TRUE(state);
  EXPECT_EQ(published, state->id);
  RefPtr<Message> hot = new Message(published);
  nsCString text;
  ASSERT_EQ(NS_OK, hot->GetSubject(text));
  ASSERT_EQ(NS_OK, db.RemoveMessage(published));
  ASSERT_EQ(NS_OK, db.CaptureHeaderState(published, state));
  EXPECT_FALSE(state);
  ASSERT_EQ(NS_OK, db.AbortMessage(staged));
  ASSERT_EQ(NS_OK, db.CaptureHeaderState(staged, state));
  EXPECT_FALSE(state);
}

TEST_F(DeliveryCoreReferences,
       HeaderStateErrorsPreserveOutputAndCallerTransaction) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("state-errors"_ns, {}, key));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  Maybe<CapturedMessage> state{Some(CapturedMessage{})};
  state->id = 77;
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP VIEW messages AS SELECT id,abs(-9223372036854775808) AS "
          "folderId,"
          "messageId,date,sender,recipients,subject,flags,tags,threadId,threadParent FROM main.messages"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(
        NS_OK,
        mConnection->ExecuteSimpleSQL(
            "DROP VIEW IF EXISTS temp.messages; DROP VIEW IF EXISTS temp.staged_messages"_ns));
  });
  EXPECT_EQ(NS_ERROR_FAILURE, db.CaptureHeaderState(key, state));
  ASSERT_TRUE(state);
  EXPECT_EQ(77u, state->id);
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "DROP VIEW temp.messages; CREATE TEMP VIEW staged_messages AS SELECT * FROM main.messages"_ns));
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, db.CaptureHeaderState(key, state));
  ASSERT_TRUE(state);
  EXPECT_EQ(77u, state->id);
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP VIEW temp.staged_messages"_ns));
  ASSERT_EQ(NS_OK, db.CaptureHeaderState(key, state));
  ASSERT_TRUE(state);
  EXPECT_EQ(key, state->id);
}

TEST_F(DeliveryCoreReferences, StagedHeaderStateUsesNearestPublishedParent) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  nsMsgKey root, parent, staged;
  ASSERT_EQ(NS_OK, Add("ancestry-root"_ns, {}, root));
  ASSERT_EQ(NS_OK, Add("ancestry-parent"_ns, {"ancestry-root"_ns}, parent));
  RawHdr raw;
  raw.messageId = "ancestry-staged"_ns;
  raw.references = {"ancestry-root"_ns, "ancestry-parent"_ns, "unresolved"_ns};
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  Maybe<CapturedMessage> state;
  ASSERT_EQ(NS_OK, db.CaptureHeaderState(staged, state));
  ASSERT_TRUE(state);
  EXPECT_EQ(root, state->threadId);
  EXPECT_EQ(parent, state->threadParent);
  bool published = true;
  ASSERT_EQ(NS_OK, db.MessageExists(staged, published));
  EXPECT_FALSE(published);
}

TEST_F(DeliveryCoreReferences, StagedParentUsesStoredThreadWithGroupingOff) {
  ASSERT_NO_FATAL_FAILURE(CheckStagedParentWithGroupingOff());
}

TEST_F(DeliveryCoreReferences, QueuedFlagFailureKeepsStoredAndHotFacts) {
  ASSERT_NO_FATAL_FAILURE(CheckQueuedChangeRollback(false));
}

TEST_F(DeliveryCoreReferences, QueuedTagFailureKeepsStoredAndHotFacts) {
  ASSERT_NO_FATAL_FAILURE(CheckQueuedChangeRollback(true));
}

TEST_F(DeliveryCoreReferences, QueuedChangesDoNotSettleCallerTransaction) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("caller-owned-change"_ns, {}, key));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, mConnection->RollbackTransaction()); });
  ASSERT_EQ(NS_OK, db.SetMessageProperty(key, "caller"_ns, "kept"_ns));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.SetMessageFlags(key, nsMsgMessageFlags::Read));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.SetMessageTags(key, "rejected"_ns));
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  CapturedMessage row;
  ASSERT_EQ(NS_OK, db.CaptureMessage(key, row));
  EXPECT_EQ(0u, row.flags);
  EXPECT_TRUE(row.tags.IsEmpty());
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "caller"_ns, text));
  EXPECT_EQ("kept"_ns, text);
}

TEST_F(DeliveryCoreReferences,
       ImmediateViewCaptureReadsRealPreinsertIdentities) {
  ASSERT_NO_FATAL_FAILURE(CheckPreinsertViewCapture(false, false));
}

TEST_F(DeliveryCoreReferences, StagedViewCaptureReadsRealPreinsertIdentities) {
  ASSERT_NO_FATAL_FAILURE(CheckPreinsertViewCapture(true, false));
}

TEST_F(DeliveryCoreReferences, ImmediateViewCaptureReadFailurePreservesOutput) {
  ASSERT_NO_FATAL_FAILURE(CheckPreinsertViewCapture(false, true));
}

TEST_F(DeliveryCoreReferences, StagedViewCaptureReadFailurePreservesDraft) {
  ASSERT_NO_FATAL_FAILURE(CheckPreinsertViewCapture(true, true));
}

TEST_F(DeliveryCoreReferences,
       GroupThreadWordRekeyPreservesFolderScopesAndRestart) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  uint64_t otherFolder, controlFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "WordOther"_ns,
                                                  &otherFolder));
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolderId, "WordControl"_ns,
                                                  &controlFolder));
  nsMsgKey first, second, control, parent;
  ASSERT_EQ(NS_OK, AddAt(mFolderId, "word-rekey-a"_ns, {"word-rekey-parent"_ns},
                         first));
  ASSERT_EQ(NS_OK, AddAt(otherFolder, "word-rekey-b"_ns,
                         {"word-rekey-parent"_ns}, second));
  ASSERT_EQ(NS_OK, AddAt(controlFolder, "word-control"_ns, {}, control));
  CapturedMessage a, b, c;
  ASSERT_EQ(NS_OK, db.CaptureMessage(first, a));
  ASSERT_EQ(NS_OK, db.CaptureMessage(second, b));
  ASSERT_EQ(NS_OK, db.CaptureMessage(control, c));
  ASSERT_EQ(a.threadId, b.threadId);
  uint32_t firstWord = 0x80000000u | nsMsgMessageFlags::Watched;
  uint32_t secondWord = 0x40000000u | nsMsgMessageFlags::Ignored;
  ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, a.threadId, firstWord));
  ASSERT_EQ(NS_OK, db.SetThreadFlags(otherFolder, b.threadId, secondWord));
  ASSERT_EQ(NS_OK, db.SetThreadFlags(controlFolder, c.threadId, 0xabcdef01u));
  ASSERT_EQ(NS_OK, Add("word-rekey-parent"_ns, {}, parent));
  CapturedMessage current;
  ASSERT_EQ(NS_OK, db.CaptureMessage(first, current));
  EXPECT_EQ(parent, current.threadId);
  EXPECT_EQ(parent, current.threadParent);
  uint32_t flags = 7;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetThreadFlags(mFolderId, a.threadId, flags));
  EXPECT_EQ(7u, flags);
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->MessageDB();
  ASSERT_EQ(NS_OK, reopened.GetThreadFlags(mFolderId, parent, flags));
  EXPECT_EQ(firstWord, flags);
  ASSERT_EQ(NS_OK, reopened.GetThreadFlags(otherFolder, parent, flags));
  EXPECT_EQ(secondWord, flags);
  ASSERT_EQ(NS_OK, reopened.GetThreadFlags(controlFolder, c.threadId, flags));
  EXPECT_EQ(0xabcdef01u, flags);
  nsTArray<nsCString> refs;
  ASSERT_EQ(NS_OK, Stored(first, refs));
  EXPECT_EQ((nsTArray<nsCString>{"word-rekey-parent"_ns}), refs);
  ASSERT_EQ(NS_OK, reopened.RemoveMessage(parent));
  ASSERT_EQ(NS_OK, reopened.GetThreadFlags(mFolderId, parent, flags));
  EXPECT_EQ(firstWord, flags);
  ASSERT_EQ(NS_OK, reopened.RemoveMessage(first));
  flags = 7;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            reopened.GetThreadFlags(mFolderId, parent, flags));
  EXPECT_EQ(7u, flags);
  ASSERT_EQ(NS_OK, reopened.GetThreadFlags(otherFolder, parent, flags));
  EXPECT_EQ(secondWord, flags);
  ASSERT_EQ(NS_OK, reopened.RemoveMessage(second));
  ASSERT_EQ(NS_OK, reopened.GetThreadFlags(controlFolder, c.threadId, flags));
  EXPECT_EQ(0xabcdef01u, flags);
  nsCOMPtr<mozIStorageConnection> reader;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(reader)));
  nsCOMPtr<mozIStorageStatement> stmt;
  auto close = MakeScopeExit([&] {
    if (stmt) EXPECT_EQ(NS_OK, stmt->Finalize());
    EXPECT_EQ(NS_OK, reader->Close());
  });
  ASSERT_EQ(
      NS_OK,
      reader->CreateStatement(
          "SELECT folderId,threadId,flags FROM thread_flags ORDER BY folderId,threadId"_ns,
          getter_AddRefs(stmt)));
  bool more;
  ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
  ASSERT_TRUE(more);
  int64_t folder, thread, word;
  ASSERT_EQ(NS_OK, stmt->GetInt64(0, &folder));
  ASSERT_EQ(NS_OK, stmt->GetInt64(1, &thread));
  ASSERT_EQ(NS_OK, stmt->GetInt64(2, &word));
  EXPECT_EQ(controlFolder, uint64_t(folder));
  EXPECT_EQ(c.threadId, thread);
  EXPECT_EQ(int64_t(0xabcdef01u), word);
  ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
  EXPECT_FALSE(more);
}

TEST_F(DeliveryCoreReferences, GroupThreadWordsMergeExactEqualUnknownBits) {
  ASSERT_NO_FATAL_FAILURE(
      CheckEqualThreadWordMerge(0xa0000000u | nsMsgMessageFlags::Watched));
}

TEST_F(DeliveryCoreReferences, GroupThreadWordsMergeExplicitZero) {
  ASSERT_NO_FATAL_FAILURE(CheckEqualThreadWordMerge(0));
}

TEST_F(DeliveryCoreReferences, GroupThreadWordsRejectWatchedIgnoredConflict) {
  ASSERT_NO_FATAL_FAILURE(CheckThreadWordConflict(
      false, nsMsgMessageFlags::Watched, nsMsgMessageFlags::Ignored));
}

TEST_F(DeliveryCoreReferences,
       GroupThreadWordsRejectZeroNonzeroStagedConflict) {
  ASSERT_NO_FATAL_FAILURE(
      CheckThreadWordConflict(true, 0, nsMsgMessageFlags::Watched));
}

TEST_F(DeliveryCoreReferences,
       GroupThreadWordWriteFailureRollsBackDerivedState) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  nsMsgKey child, control;
  ASSERT_EQ(NS_OK, Add("word-write-child"_ns, {"word-write-parent"_ns}, child));
  ASSERT_EQ(NS_OK, Add("word-write-control"_ns, {}, control));
  CapturedMessage before;
  ASSERT_EQ(NS_OK, db.CaptureMessage(child, before));
  ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, before.threadId, 0x80000001u));
  RefPtr<Message> hot = new Message(child);
  nsMsgKey cachedThread;
  ASSERT_EQ(NS_OK, hot->GetThreadId(&cachedThread));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK, mConnection->CreateFunction("word_fault"_ns, 1, witness));
  // An unreached INSERT trigger requires a new failure injection point.
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER fail_word_rekey BEFORE INSERT ON thread_flags "
          "BEGIN SELECT word_fault(NEW.threadId); SELECT RAISE(ABORT,'word rekey fault'); END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS fail_word_rekey"_ns));
    EXPECT_EQ(NS_OK, mConnection->RemoveFunction("word_fault"_ns));
  });
  RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
  uint32_t calls = 0;
  observer->action = [&](char, const auto&, const auto&, Message*, bool) {
    ++calls;
  };
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  RawHdr raw;
  raw.messageId = "word-write-parent"_ns;
  nsMsgKey output = nsMsgKey_None;
  RefPtr<Message> sentinel = new Message(control);
  Message* live = sentinel.get();
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.AddMessage(mFolderId, raw, true, &output, &live));
  EXPECT_EQ(nsMsgKey_None, output);
  EXPECT_EQ(sentinel.get(), live);
  if (live && live != sentinel.get()) NS_RELEASE(live);
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_GT(witness->mLastKey, 0);
  EXPECT_EQ(0u, calls);
  ASSERT_EQ(NS_OK, hot->GetThreadId(&cachedThread));
  EXPECT_EQ(before.threadId, cachedThread);
  CapturedMessage actual;
  ASSERT_EQ(NS_OK, db.CaptureMessage(child, actual));
  EXPECT_EQ(before.threadId, actual.threadId);
  EXPECT_EQ(before.threadParent, actual.threadParent);
  ASSERT_EQ(NS_OK, db.CaptureMessage(control, actual));
  EXPECT_EQ("word-write-control"_ns, actual.messageId);
  uint32_t flags;
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, before.threadId, flags));
  EXPECT_EQ(0x80000001u, flags);
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP TRIGGER fail_word_rekey"_ns));
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &output));
  EXPECT_EQ(2u, calls);
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, output, flags));
  EXPECT_EQ(0x80000001u, flags);
}

TEST_F(DeliveryCoreReferences,
       GroupThreadWordPublishPreservesCallerTransaction) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  nsMsgKey child, pending;
  ASSERT_EQ(NS_OK, Add("word-owner-child"_ns, {"word-owner-parent"_ns}, child));
  CapturedMessage before;
  ASSERT_EQ(NS_OK, db.CaptureMessage(child, before));
  ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, before.threadId, 0x80000000u));
  RawHdr raw;
  raw.messageId = "word-owner-parent"_ns;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &pending));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active;
    if (NS_SUCCEEDED(mConnection->GetTransactionInProgress(&active)) && active)
      EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, db.SetMessageProperty(child, "caller"_ns, "kept"_ns));
  Message* output = nullptr;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db.PublishMessage(pending, true, &output));
  EXPECT_EQ(nullptr, output);
  bool active;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  uint32_t flags;
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, before.threadId, flags));
  EXPECT_EQ(0x80000000u, flags);
  ASSERT_EQ(NS_OK, mConnection->CommitTransaction());
  ASSERT_EQ(NS_OK, db.PublishMessage(pending, true));
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, pending, flags));
  EXPECT_EQ(0x80000000u, flags);
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(child, "caller"_ns, text));
  EXPECT_EQ("kept"_ns, text);
}

TEST_F(DeliveryCoreReferences,
       GroupThreadWordReadErrorPreservesPublicationOutput) {
  ASSERT_EQ(NS_OK, StartGrouping());
  auto& db = mCore->MessageDB();
  nsMsgKey child;
  ASSERT_EQ(NS_OK, Add("word-read-child"_ns, {"word-read-parent"_ns}, child));
  CapturedMessage before;
  ASSERT_EQ(NS_OK, db.CaptureMessage(child, before));
  ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, before.threadId, 0x80000001u));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP VIEW thread_flags AS SELECT folderId,threadId,"
          "abs(-9223372036854775808) AS flags FROM main.thread_flags"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.thread_flags"_ns));
  });
  RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
  uint32_t calls = 0;
  observer->action = [&](char, const auto&, const auto&, Message*, bool) {
    ++calls;
  };
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  nsMsgKey output = nsMsgKey_None;
  EXPECT_EQ(NS_ERROR_FAILURE, Add("word-read-parent"_ns, {}, output));
  EXPECT_EQ(nsMsgKey_None, output);
  EXPECT_EQ(0u, calls);
  CapturedMessage current;
  ASSERT_EQ(NS_OK, db.CaptureMessage(child, current));
  EXPECT_EQ(before.threadId, current.threadId);
  EXPECT_EQ(before.threadParent, current.threadParent);
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL("DROP VIEW temp.thread_flags"_ns));
  uint32_t flags;
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, before.threadId, flags));
  EXPECT_EQ(0x80000001u, flags);
  ASSERT_EQ(NS_OK, Add("word-read-parent"_ns, {}, output));
  EXPECT_EQ(2u, calls);
  ASSERT_EQ(NS_OK, db.GetThreadFlags(mFolderId, output, flags));
  EXPECT_EQ(0x80000001u, flags);
}

#ifdef XP_WIN
TEST_F(DeliveryCoreReferences, WindowsImportRequiresOriginalPhysicalContext) {
  ASSERT_EQ(NS_OK, Start());
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  auto paths = *input.identity.windows;
  FolderImportReceipt output;
  output.identity.token = "unchanged"_ns;
  input.identity.windows.reset();
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, ImportNativeFile(source, input, output));
  EXPECT_EQ("unchanged"_ns, output.identity.token);
  input.identity.windows = Some(paths);
  input.identity.windows->summary.id.Assign(
      "0000000000000000:00000000000000000000000000000000");
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, ImportNativeFile(source, input, output));
  EXPECT_EQ("unchanged"_ns, output.identity.token);
  uint64_t count;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(0u, count);
  input.identity.windows = Some(paths);
  input.identity.windows->summary.rootId.Assign(
      "0000000000000000:00000000000000000000000000000000");
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, ImportNativeFile(source, input, output));
  EXPECT_EQ("unchanged"_ns, output.identity.token);
  input.identity.windows = Some(paths);
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, output));
  ASSERT_TRUE(output.identity.windows);
  EXPECT_EQ(paths.summary.id, output.identity.windows->summary.id);
  EXPECT_EQ(paths.store.id, output.identity.windows->store.id);
  EXPECT_EQ(paths.summary.originalRoot,
            output.identity.windows->summary.originalRoot);
  Stop();
  ASSERT_EQ(NS_OK, Start());
  Maybe<FolderImportReceipt> recovered;
  ASSERT_EQ(NS_OK, mCore->GetFolderImportReceipt(input.identity, recovered));
  ASSERT_TRUE(recovered && recovered->identity.windows);
  EXPECT_EQ(paths.summary.id, recovered->identity.windows->summary.id);
  EXPECT_EQ(paths.summary.parentId,
            recovered->identity.windows->summary.parentId);
  EXPECT_EQ(paths.store.rootId, recovered->identity.windows->store.rootId);
}

TEST_F(DeliveryCoreReferences, WindowsImportCannotRebindOldReceipt) {
  ASSERT_EQ(NS_OK, Start());
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  FolderImportReceipt imported;
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, imported));
  // A v1 receipt has no native Windows sidecar, even when its digest matches.
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DELETE FROM folder_import_windows"_ns));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  Maybe<FolderImportReceipt> output(Some(FolderImportReceipt{}));
  output->identity.token = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->GetFolderImportReceipt(input.identity, output));
  ASSERT_TRUE(output);
  EXPECT_EQ("unchanged"_ns, output->identity.token);
  FolderImportReceipt retry;
  retry.identity.token = "still unchanged"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, ImportNativeFile(source, input, retry));
  EXPECT_EQ("still unchanged"_ns, retry.identity.token);
  uint64_t count;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(2u, count);
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(NS_OK, mConnection->CreateStatement(
                       "SELECT COUNT(*) FROM folder_import_windows"_ns,
                       getter_AddRefs(stmt)));
  bool more;
  ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
  ASSERT_TRUE(more);
  int64_t rows;
  ASSERT_EQ(NS_OK, stmt->GetInt64(0, &rows));
  EXPECT_EQ(0, rows);
  ASSERT_EQ(NS_OK, stmt->Finalize());
}

TEST_F(DeliveryCoreReferences, WindowsImportOwnsLeaseUntilPublicationReturns) {
  ASSERT_EQ(NS_OK, Start());
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  nsAutoString leaf;
  ASSERT_EQ(NS_OK, source->GetLeafName(leaf));
  ASSERT_EQ(NS_OK, source->RenameTo(mProfile, u"rename-control.bin"_ns));
  nsCOMPtr<nsIFile> renamed;
  ASSERT_EQ(NS_OK, mProfile->Clone(getter_AddRefs(renamed)));
  ASSERT_EQ(NS_OK, renamed->Append(u"rename-control.bin"_ns));
  ASSERT_EQ(NS_OK, renamed->RenameTo(mProfile, leaf));
  uint32_t calls = 0;
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([&](Message*, bool) {
        ++calls;
        // PrepareNativeImport closed its own admission leases before this call.
        EXPECT_TRUE(NS_FAILED(source->RenameTo(mProfile, u"blocked.bin"_ns)));
        bool exists;
        ASSERT_EQ(NS_OK, source->Exists(&exists));
        EXPECT_TRUE(exists);
      });
  auto& db = mCore->MessageDB();
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  FolderImportReceipt receipt;
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, receipt));
  EXPECT_EQ(2u, calls);
  ASSERT_EQ(NS_OK, source->RenameTo(mProfile, u"after-import.bin"_ns));
  ASSERT_EQ(NS_OK, mProfile->Clone(getter_AddRefs(renamed)));
  ASSERT_EQ(NS_OK, renamed->Append(u"after-import.bin"_ns));
  ASSERT_EQ(NS_OK, renamed->RenameTo(mProfile, leaf));
}
#endif

#ifdef XP_WIN
TEST_F(DeliveryCoreReferences,
       WindowsImportIdentityWriteFailureRollsBackReceipt) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey control;
  ASSERT_EQ(NS_OK, Add("control@invalid"_ns, {}, control));
  FolderImportSnapshot input;
  nsCOMPtr<nsIFile> source;
  ASSERT_EQ(NS_OK, PrepareNativeImport(input, getter_AddRefs(source)));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_windows_identity BEFORE INSERT ON "
          "folder_import_windows BEGIN SELECT RAISE(ABORT, 'identity failure'); END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS reject_windows_identity"_ns));
  });
  uint32_t callbacks = 0;
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([&](Message*, bool) { ++callbacks; });
  auto& db = mCore->MessageDB();
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  FolderImportReceipt output;
  output.identity.token = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            ImportNativeFile(source, input, output));
  EXPECT_EQ("unchanged"_ns, output.identity.token);
  EXPECT_EQ(0u, callbacks);
  bool exists;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(control, exists));
  EXPECT_TRUE(exists);
  uint64_t count;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(1u, count);
  Maybe<FolderImportReceipt> receipt;
  ASSERT_EQ(NS_OK, mCore->GetFolderImportReceipt(input.identity, receipt));
  EXPECT_FALSE(receipt);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER reject_windows_identity"_ns));
  ASSERT_EQ(NS_OK, ImportNativeFile(source, input, output));
  EXPECT_EQ(2u, callbacks);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
  EXPECT_EQ(3u, count);
}
#endif

TEST_F(DeliveryCoreReferences, Schema14UpgradeKeepsThreadAndPendingState) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey root, thread, staged;
  ASSERT_EQ(NS_OK, Add("schema14-root"_ns, {}, root));
  ASSERT_EQ(NS_OK, db.GetMessageThreadId(root, thread));
  ASSERT_EQ(NS_OK, db.SetThreadFlags(mFolderId, thread, 0x80000001));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 19));
  RawHdr raw;
  raw.messageId = "schema14-staged"_ns;
  raw.references = {"schema14-root"_ns};
  raw.storeToken = Some(nsCString("retained-body"_ns));
  raw.messageSize = Some(42u);
  raw.extras = {{"exact"_ns, "00042"_ns}};
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  OfflineOperationData input;
  input.operation = nsIMsgOfflineImapOperation::kAppendDraft;
  input.pendingDestination = Some(PendingDestination{mFolderId, staged, 19});
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, staged, input));
  nsCString sourceId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(sourceId));
  Stop();

  nsCOMPtr<mozIStorageConnection> old;
  ASSERT_EQ(NS_OK, Open(getter_AddRefs(old)));
  ASSERT_EQ(NS_OK,
            old->ExecuteSimpleSQL("DROP TABLE folder_import_windows"_ns));
  ASSERT_EQ(NS_OK, old->ExecuteSimpleSQL("DROP TABLE folder_cache_bindings; DROP TABLE folder_cache_imports"_ns));
  ASSERT_EQ(NS_OK, old->SetSchemaVersion(13));
  ASSERT_EQ(NS_OK, old->Close());
  ASSERT_EQ(NS_OK, Start());
  int32_t version;
  ASSERT_EQ(NS_OK, mConnection->GetSchemaVersion(&version));
  EXPECT_EQ(15, version);
  nsCString reopenedId;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(reopenedId));
  EXPECT_EQ(sourceId, reopenedId);
  auto& reopened = mCore->MessageDB();
  uint32_t flags;
  ASSERT_EQ(NS_OK, reopened.GetThreadFlags(mFolderId, thread, flags));
  EXPECT_EQ(0x80000001u, flags);
  OfflineOperationData got;
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperation(mFolderId, staged, got));
  EXPECT_EQ(nsIMsgOfflineImapOperation::kAppendDraft, got.operation);
  ASSERT_TRUE(got.pendingDestination);
  EXPECT_EQ(mFolderId, got.pendingDestination->folderId);
  EXPECT_EQ(staged, got.pendingDestination->key);
  EXPECT_EQ(19u, got.pendingDestination->epoch);
  Maybe<CapturedMessage> captured;
  ASSERT_EQ(NS_OK, reopened.CaptureHeaderState(staged, captured));
  ASSERT_TRUE(captured);
  EXPECT_EQ(thread, captured->threadId);
  EXPECT_EQ(root, captured->threadParent);
  nsTArray<nsCString> references;
  ASSERT_EQ(NS_OK, reopened.GetMessageReferences(staged, references));
  EXPECT_EQ((nsTArray<nsCString>{"schema14-root"_ns}), references);
  nsCString text;
  ASSERT_EQ(NS_OK, reopened.GetMessageProperty(staged, "exact"_ns, text));
  EXPECT_EQ("00042"_ns, text);
  ASSERT_EQ(NS_OK, reopened.GetMessageStoreToken(staged, text));
  EXPECT_EQ("retained-body"_ns, text);
  uint64_t size;
  ASSERT_EQ(NS_OK, reopened.GetMessageSize(staged, size));
  EXPECT_EQ(42u, size);
  bool published = true;
  ASSERT_EQ(NS_OK, reopened.MessageExists(staged, published));
  EXPECT_FALSE(published);
}

TEST_F(DeliveryCoreReferences, QueuedSourceReadIsDurableAndReadOnly) {
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 61));
  auto& db = mCore->MessageDB();
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, Add("read-queued-source@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, Add("source-control@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 61, 700));
  OfflineOperationData payload;
  payload.operation = nsIMsgOfflineImapOperation::kFlagsChanged;
  // Mutable compatibility fields are not the captured source identity.
  payload.sourceKey = control;
  payload.sourceUid = UINT32_MAX;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  ASSERT_EQ(NS_OK, db.SetOfflineOperationPlayingBack(mFolderId, key, true));
  ASSERT_EQ(NS_OK, db.RemoveMessage(key));
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 62));
  Maybe<ServerMessageLocation> source;
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperationSource(mFolderId, key, source));
  ASSERT_TRUE(source);
  EXPECT_EQ(mFolderId, source->folderId);
  EXPECT_EQ(key, source->key);
  EXPECT_EQ(61u, source->epoch);
  EXPECT_EQ(700u, source->uid);
  ASSERT_NO_FATAL_FAILURE(CheckOfflineSource(key, 61, 700));
  OfflineOperationData stored;
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperation(mFolderId, key, stored));
  EXPECT_EQ(control, stored.sourceKey);
  EXPECT_EQ(UINT32_MAX, stored.sourceUid);
  EXPECT_TRUE(stored.playingBack);
  // Reading neither dispatches nor changes the payload revision.
  nsCOMPtr<mozIStorageStatement> state;
  ASSERT_EQ(NS_OK,
            mConnection->CreateStatement(
                "SELECT revision, (SELECT COUNT(*) FROM offline_attempts) "
                "FROM offline_operations WHERE messageKey=:key"_ns,
                getter_AddRefs(state)));
  ASSERT_EQ(NS_OK, state->BindInt64ByName("key"_ns, key));
  bool more;
  ASSERT_EQ(NS_OK, state->ExecuteStep(&more));
  ASSERT_TRUE(more);
  int64_t revision, attempts;
  ASSERT_EQ(NS_OK, state->GetInt64(0, &revision));
  ASSERT_EQ(NS_OK, state->GetInt64(1, &attempts));
  EXPECT_EQ(1, revision);
  EXPECT_EQ(0, attempts);
  ASSERT_EQ(NS_OK, state->Finalize());
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  ASSERT_EQ(NS_OK, reopened.GetOfflineOperationSource(mFolderId, key, source));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  bool exists = true;
  ASSERT_EQ(NS_OK, reopened.MessageExists(key, exists));
  EXPECT_FALSE(exists);
  ASSERT_EQ(NS_OK, reopened.MessageExists(control, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreReferences, QueuedSourceAbsenceDoesNotCaptureLaterBinding) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("initially-unbound@invalid"_ns, {}, key));
  OfflineOperationData payload;
  payload.operation = nsIMsgOfflineImapOperation::kFlagsChanged;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 81));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 81, 42));
  payload.sourceUid = 999;
  payload.keywordsToAdd = "later edit"_ns;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  Maybe<ServerMessageLocation> source =
      Some(ServerMessageLocation{99, 98, 97, 96});
  ASSERT_EQ(NS_OK, db.GetOfflineOperationSource(mFolderId, key, source));
  EXPECT_FALSE(source);
  uint64_t attempt = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.BeginOfflineAttempt(mFolderId, key,
                                   nsIMsgOfflineImapOperation::kFlagsChanged,
                                   Nothing(), attempt));
  EXPECT_EQ(123u, attempt);
  source = Some(ServerMessageLocation{99, 98, 97, 96});
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetOfflineOperationSource(mFolderId + 1, key, source));
  ASSERT_TRUE(source);
  EXPECT_EQ(96u, source->uid);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetOfflineOperationSource(mFolderId, nsMsgKey_None - 1, source));
  EXPECT_EQ(NS_ERROR_INVALID_ARG, db.GetOfflineOperationSource(0, key, source));
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db.GetOfflineOperationSource(mFolderId, nsMsgKey_None, source));
  ASSERT_TRUE(source);
  EXPECT_EQ(99u, source->folderId);
  EXPECT_EQ(98u, source->key);
  EXPECT_EQ(97u, source->epoch);
  EXPECT_EQ(96u, source->uid);
  Stop();
  ASSERT_EQ(NS_OK, Start());
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetOfflineOperationSource(mFolderId, key,
                                                                source));
  EXPECT_FALSE(source);
}

TEST_F(DeliveryCoreReferences, QueuedSourceErrorsPreserveOutput) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 91));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("source-read-fault@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 91, UINT32_MAX));
  OfflineOperationData payload;
  payload.operation = nsIMsgOfflineImapOperation::kFlagsChanged;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  for (const char* projection :
       {"id, revision, NULL AS epoch, uid, folderEpoch",
        "id, revision, -1 AS epoch, uid, folderEpoch",
        "id, revision, 'invalid' AS epoch, uid, folderEpoch",
        "id, revision, epoch, 4294967296 AS uid, folderEpoch",
        "id, 'invalid' AS revision, epoch, uid, folderEpoch"}) {
    nsCString sql("CREATE TEMP VIEW offline_operations AS SELECT ");
    sql.Append(projection);
    sql.AppendLiteral(", folderId, messageKey FROM main.offline_operations");
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    Maybe<ServerMessageLocation> source =
        Some(ServerMessageLocation{99, 98, 97, 96});
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
              db.GetOfflineOperationSource(mFolderId, key, source));
    ASSERT_TRUE(source);
    EXPECT_EQ(96u, source->uid);
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW temp.offline_operations"_ns));
  }
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "CREATE TEMP VIEW offline_operations AS SELECT * FROM "
                       "main.offline_operations "
                       "UNION ALL SELECT * FROM main.offline_operations"_ns));
  Maybe<ServerMessageLocation> source =
      Some(ServerMessageLocation{99, 98, 97, 96});
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED,
            db.GetOfflineOperationSource(mFolderId, key, source));
  ASSERT_TRUE(source);
  EXPECT_EQ(96u, source->uid);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.offline_operations"_ns));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("source_read_fault"_ns, 1, witness));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP VIEW offline_operations AS SELECT id, revision, "
          "CASE WHEN source_read_fault(messageKey)=0 THEN "
          "abs(-9223372036854775808) "
          "ELSE epoch END AS epoch, uid, folderEpoch, folderId, messageKey "
          "FROM main.offline_operations"_ns));
  EXPECT_EQ(NS_ERROR_FAILURE,
            db.GetOfflineOperationSource(mFolderId, key, source));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(key, witness->mLastKey);
  ASSERT_TRUE(source);
  EXPECT_EQ(96u, source->uid);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.offline_operations"_ns));
  ASSERT_EQ(NS_OK, db.GetOfflineOperationSource(mFolderId, key, source));
  ASSERT_TRUE(source);
  EXPECT_EQ(91u, source->epoch);
  EXPECT_EQ(UINT32_MAX, source->uid);
}

TEST_F(DeliveryCoreReferences, QueuedSourceCaptureFailureRollsBackIntent) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolderId, 101));
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, Add("source-write-fault@invalid"_ns, {}, key));
  ASSERT_EQ(NS_OK, Add("source-write-control@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(key, mFolderId, 101, 700));
  ASSERT_EQ(NS_OK, db.BindMessageToServerUid(control, mFolderId, 101, 701));
  OfflineOperationData payload;
  payload.operation = nsIMsgOfflineImapOperation::kFlagsChanged;
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, control, payload));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("source_write_fault"_ns, 1, witness));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER reject_source_capture BEFORE INSERT ON "
          "offline_operations "
          "WHEN NEW.uid=700 BEGIN SELECT source_write_fault(NEW.messageKey); "
          "SELECT RAISE(ABORT, 'source capture failure'); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.StoreOfflineOperation(mFolderId, key, payload));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(key, witness->mLastKey);
  bool active = true;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  Maybe<ServerMessageLocation> source =
      Some(ServerMessageLocation{99, 98, 97, 96});
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.GetOfflineOperationSource(mFolderId, key, source));
  ASSERT_TRUE(source);
  EXPECT_EQ(96u, source->uid);
  ASSERT_EQ(NS_OK, db.GetOfflineOperationSource(mFolderId, control, source));
  ASSERT_TRUE(source);
  EXPECT_EQ(701u, source->uid);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER reject_source_capture"_ns));
  ASSERT_EQ(NS_OK, db.StoreOfflineOperation(mFolderId, key, payload));
  ASSERT_NO_FATAL_FAILURE(CheckOfflineSource(key, 101, 700));
  uint64_t attemptId;
  ASSERT_EQ(NS_OK,
            db.BeginOfflineAttempt(mFolderId, key,
                                   nsIMsgOfflineImapOperation::kFlagsChanged,
                                   Nothing(), attemptId));
  ASSERT_EQ(NS_OK, db.GetOfflineOperationSource(mFolderId, key, source));
  ASSERT_TRUE(source);
  EXPECT_EQ(700u, source->uid);
  OfflineAttempt attempt;
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Sent, attempt.state);
  EXPECT_EQ(1u, attempt.revision);
  ASSERT_EQ(NS_OK, db.MarkOfflineAttemptAmbiguous(attemptId));
  ASSERT_EQ(NS_OK, db.GetOfflineOperationSource(mFolderId, key, source));
  ASSERT_EQ(NS_OK, db.GetOfflineAttempt(attemptId, attempt));
  EXPECT_EQ(OfflineAttemptState::Ambiguous, attempt.state);
  EXPECT_EQ(1u, attempt.revision);
}

TEST_F(DeliveryCoreReferences, RetiredReferencesKeepLiveConversationMembers) {
  ASSERT_NO_FATAL_FAILURE(CheckRetiredReferences(false));
}

TEST_F(DeliveryCoreReferences, StagedReferencesKeepLiveConversationMembers) {
  ASSERT_NO_FATAL_FAILURE(CheckRetiredReferences(true));
}

TEST_F(DeliveryCoreReferences,
       DefaultReferenceReadFailurePreservesPublication) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  ASSERT_NO_FATAL_FAILURE(CheckGroupingOff());
  nsMsgKey root, control;
  ASSERT_EQ(NS_OK, Add("reference-read-root"_ns, {}, root));
  ASSERT_EQ(NS_OK, Add("reference-read-control"_ns, {}, control));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("reference_read_fault"_ns, 1, witness));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "CREATE TEMP VIEW messages AS SELECT * FROM main.messages "
                "WHERE CASE WHEN reference_read_fault(id)=0 "
                "THEN abs(-9223372036854775808) ELSE 1 END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.messages"_ns));
  });
  auto failed = db.FindByMessageId("reference-read-root"_ns);
  ASSERT_TRUE(failed.isErr());
  EXPECT_EQ(NS_ERROR_FAILURE, failed.unwrapErr());
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(root, witness->mLastKey);
  uint32_t publications = 0;
  RefPtr<PublicationObserver> observer =
      new PublicationObserver([&](Message*, bool) { ++publications; });
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  nsMsgKey output = 123;
  EXPECT_EQ(NS_ERROR_FAILURE,
            Add("reference-read-child"_ns, {"reference-read-root"_ns}, output));
  EXPECT_EQ(123u, output);
  EXPECT_EQ(0u, publications);
  bool active = true;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL("DROP VIEW temp.messages"_ns));
  bool exists = false;
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            Add("foreign-owner-child"_ns, {"reference-read-root"_ns}, output));
  EXPECT_EQ(123u, output);
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_EQ(NS_OK,
            Add("reference-read-child"_ns, {"reference-read-root"_ns}, output));
  EXPECT_EQ(1u, publications);
  CapturedMessage child;
  ASSERT_EQ(NS_OK, db.CaptureMessage(output, child));
  EXPECT_EQ(root, child.threadId);
  EXPECT_EQ(root, child.threadParent);
}

TEST_F(DeliveryCoreReferences,
       PartialCompletionPublishesOneCompleteExistingIdentity) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  RawHdr raw;
  raw.messageId = "partial@invalid"_ns;
  raw.subject = "old subject"_ns;
  raw.date = 100;
  raw.flags = nsMsgMessageFlags::Partial;
  raw.keywords = "old tags"_ns;
  raw.storeToken = Some(nsCString("partial-token"_ns));
  raw.messageSize = Some(uint32_t(12));
  raw.references = {"old@invalid"_ns};
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &key));
  ASSERT_EQ(NS_OK, db.SetMessageProperty(key, "unrelated"_ns, "1e3"_ns));
  MessageBodyState expected;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  ASSERT_EQ(NS_OK, db.SetMessageFlag(key, nsMsgMessageFlags::Read, true));
  ASSERT_EQ(NS_OK, db.SetMessageTags(key, "latest tags"_ns));
  RawHdr parsed;
  parsed.messageId = "complete@invalid"_ns;
  parsed.subject = "complete subject"_ns;
  parsed.sender = "parsed sender"_ns;
  parsed.recipients = "parsed recipients"_ns;
  parsed.ccList = "parsed cc"_ns;
  parsed.bccList = "parsed bcc"_ns;
  parsed.date = 300;
  parsed.priority = nsMsgPriority::highest;
  parsed.keywords = "stale parsed tags"_ns;
  parsed.dateReceived = 42000000;
  parsed.charset = "UTF-8"_ns;
  parsed.references = {"late@invalid"_ns, ""_ns, "late@invalid"_ns};
  parsed.extras = {
      {"Case"_ns, "00042"_ns},        {"Case"_ns, ""_ns},
      {"case"_ns, "1e3"_ns},          {"café"_ns, "composed"_ns},
      {"café"_ns, "decomposed"_ns},   {"messageSize"_ns, "00042"_ns},
      {"dateReceived"_ns, "0002a"_ns}};
  uint32_t calls = 0;
  RefPtr<BodyObserver> observer = new BodyObserver(
      [&](nsIMsgDBHdr* old, Message* live, const MessageBodyState& before,
          const MessageBodyState& after) {
        ++calls;
        EXPECT_EQ(key, after.key);
        EXPECT_TRUE(before.flags & nsMsgMessageFlags::Partial);
        EXPECT_FALSE(after.flags & nsMsgMessageFlags::Partial);
        EXPECT_TRUE(after.flags & nsMsgMessageFlags::Read);
        bool active;
        ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
        EXPECT_FALSE(active);
        nsCString text;
        ASSERT_EQ(NS_OK, old->GetSubject(text));
        EXPECT_EQ("old subject"_ns, text);
        PRTime date;
        ASSERT_EQ(NS_OK, old->GetDate(&date));
        EXPECT_EQ(100, date);
        ASSERT_EQ(NS_OK, live->GetSubject(text));
        EXPECT_EQ("complete subject"_ns, text);
        ASSERT_EQ(NS_OK, live->GetStoreToken(text));
        EXPECT_EQ("full-token"_ns, text);
        nsTArray<nsCString> refs;
        ASSERT_EQ(NS_OK, Stored(key, refs));
        EXPECT_EQ(
            (nsTArray<nsCString>{"late@invalid"_ns, ""_ns, "late@invalid"_ns}),
            refs);
      });
  db.AddMessageListener(observer);
  auto cleanup = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  FinishedMessageBody finished{"full-token"_ns, 123, 120, 7, true};
  MessageBodyState output;
  ASSERT_EQ(NS_OK,
            db.CompletePartialMessage(expected, parsed, finished, output));
  EXPECT_EQ(1u, calls);
  EXPECT_EQ(key, output.key);
  EXPECT_EQ(123u, output.messageSize);
  EXPECT_EQ(120u, output.offlineMessageSize);
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageTags(key, text));
  EXPECT_EQ("latest tags"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "unrelated"_ns, text));
  EXPECT_EQ("1e3"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "Case"_ns, text));
  EXPECT_TRUE(text.IsEmpty());
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, db.GetMessagePropertyNames(key, names));
  EXPECT_TRUE(names.Contains("Case"_ns));
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "café"_ns, text));
  EXPECT_EQ("composed"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "café"_ns, text));
  EXPECT_EQ("decomposed"_ns, text);
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "dateReceived"_ns, text));
  EXPECT_EQ("0002a"_ns, text);
  nsMsgPriorityValue priority;
  ASSERT_EQ(NS_OK, db.GetMessagePriority(key, priority));
  EXPECT_EQ(nsMsgPriority::highest, priority);
  db.RemoveMessageListener(observer);
  cleanup.release();
  Stop();
  ASSERT_EQ(NS_OK, Start());
  auto& reopened = mCore->MessageDB();
  MessageBodyState restored;
  ASSERT_EQ(NS_OK, reopened.GetMessageBodyState(key, restored));
  EXPECT_EQ(key, restored.key);
  EXPECT_EQ(output.storeToken, restored.storeToken);
  EXPECT_EQ(output.contentRevision, restored.contentRevision);
  EXPECT_EQ(output.locationRevision, restored.locationRevision);
  EXPECT_EQ(output.flags, restored.flags);
  CapturedMessage stored;
  ASSERT_EQ(NS_OK, reopened.CaptureMessage(key, stored));
  EXPECT_EQ("complete@invalid"_ns, stored.messageId);
  EXPECT_EQ("parsed sender"_ns, stored.sender);
  EXPECT_EQ("parsed recipients"_ns, stored.recipients);
  EXPECT_EQ("complete subject"_ns, stored.subject);
  EXPECT_EQ(PRTime(300), stored.date);
  EXPECT_EQ("latest tags"_ns, stored.tags);
  EXPECT_EQ(key, stored.threadId);
  EXPECT_EQ(0u, stored.threadParent);
  RefPtr<Message> header = new Message(key);
  ASSERT_EQ(NS_OK, header->GetCcList(text));
  EXPECT_EQ("parsed cc"_ns, text);
  ASSERT_EQ(NS_OK, header->GetBccList(text));
  EXPECT_EQ("parsed bcc"_ns, text);
  ASSERT_EQ(NS_OK, header->GetPriority(&priority));
  EXPECT_EQ(nsMsgPriority::highest, priority);
  nsTArray<nsCString> references;
  ASSERT_EQ(NS_OK, Stored(key, references));
  EXPECT_EQ((nsTArray<nsCString>{"late@invalid"_ns, ""_ns, "late@invalid"_ns}),
            references);
  ASSERT_EQ(NS_OK, reopened.GetMessageProperty(key, "unrelated"_ns, text));
  EXPECT_EQ("1e3"_ns, text);
}

TEST_F(DeliveryCoreReferences,
       PartialCompletionFailureRollsBackAllHeaderFacts) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, Add("partial-failure@invalid"_ns, {"old@invalid"_ns}, key));
  ASSERT_EQ(NS_OK, Add("partial-control@invalid"_ns, {}, control));
  ASSERT_EQ(NS_OK, db.SetMessageFlag(key, nsMsgMessageFlags::Partial, true));
  ASSERT_EQ(NS_OK, db.SetMessageProperty(key, "Case"_ns, "old"_ns));
  MessageBodyState expected;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  RawHdr parsed;
  parsed.subject = "new subject"_ns;
  parsed.references = {"new@invalid"_ns};
  parsed.extras = {{"Case"_ns, "new"_ns}};
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK, mConnection->CreateFunction("partial_fault"_ns, 1, witness));
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER fail_partial_metadata BEFORE UPDATE OF subject "
          "ON messages "
          "BEGIN SELECT partial_fault(NEW.id); SELECT RAISE(ABORT,'partial metadata'); END"_ns));
  FinishedMessageBody finished{"finished-retained"_ns, 321, 300, 8, true};
  MessageBodyState output;
  output.key = 123;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db.CompletePartialMessage(expected, parsed, finished, output));
  EXPECT_EQ(123u, output.key);
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(key, witness->mLastKey);
  MessageBodyState current;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, current));
  EXPECT_EQ(expected.storeToken, current.storeToken);
  EXPECT_EQ(expected.contentRevision, current.contentRevision);
  EXPECT_EQ(expected.locationRevision, current.locationRevision);
  EXPECT_TRUE(current.flags & nsMsgMessageFlags::Partial);
  nsCString text;
  ASSERT_EQ(NS_OK, db.GetMessageProperty(key, "Case"_ns, text));
  EXPECT_EQ("old"_ns, text);
  nsTArray<nsCString> refs;
  ASSERT_EQ(NS_OK, Stored(key, refs));
  EXPECT_EQ((nsTArray<nsCString>{"old@invalid"_ns}), refs);
  bool exists;
  ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER fail_partial_metadata"_ns));
  ASSERT_EQ(NS_OK,
            db.CompletePartialMessage(expected, parsed, finished, output));
}

TEST_F(DeliveryCoreReferences, PartialCompletionRejectsStaleAndNonPartialRows) {
  ASSERT_EQ(NS_OK, Start());
  auto& db = mCore->MessageDB();
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("partial-guard@invalid"_ns, {}, key));
  MessageBodyState expected, output;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  RawHdr parsed;
  FinishedMessageBody finished{"finished"_ns, 1, 1, 1, false};
  output.key = 123;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.CompletePartialMessage(expected, parsed, finished, output));
  EXPECT_EQ(123u, output.key);
  ASSERT_EQ(NS_OK, db.SetMessageFlag(key, nsMsgMessageFlags::Partial, true));
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  ASSERT_EQ(NS_OK, db.SetMessageSize(key, 99));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.CompletePartialMessage(expected, parsed, finished, output));
  EXPECT_EQ(123u, output.key);
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, expected));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.CompletePartialMessage(expected, parsed, finished, output));
  EXPECT_EQ(123u, output.key);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_EQ(NS_OK, db.RemoveMessage(key));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.CompletePartialMessage(expected, parsed, finished, output));
  EXPECT_EQ(123u, output.key);
}

TEST_F(DeliveryCoreReferences, FolderRemovalAccountsWideLocalBytesBeforeEvent) {
  ASSERT_EQ(NS_OK, Start());
  auto &db = mCore->MessageDB();
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  RawHdr raw;
  raw.messageId = "account-local"_ns;
  raw.subject = "retained deleted header"_ns;
  raw.references = {"absent-parent"_ns, "ordered-tail"_ns};
  raw.flags = nsMsgMessageFlags::Offline;
  raw.messageSize = Some(UINT32_MAX);
  raw.offlineMessageSize = Some(19u);
  raw.storeToken = Some(nsCString("finished-owned-by-provider"_ns));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &key));
  // Warm the existing header; a failed removal must not replace it early.
  nsCString subject;
  ASSERT_EQ(NS_OK, db.GetMessageSubject(key, subject));
  uint32_t removed = 0;
  RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
  observer->action = [&](char kind, const CapturedMessage &before,
                         const CapturedMessage &, Message *live, bool) {
    EXPECT_EQ('R', kind);
    ++removed;
    EXPECT_EQ(key, before.id);
    EXPECT_EQ(mFolderId, before.folderId);
    EXPECT_EQ(raw.subject, before.subject);
    bool active = true, exists = true;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    EXPECT_EQ(NS_OK, db.MessageExists(key, exists));
    EXPECT_FALSE(exists);
    int64_t expunged = -1;
    EXPECT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
    EXPECT_EQ(int64_t(UINT32_MAX), expunged);
    nsCString retained;
    EXPECT_EQ(NS_OK, live->GetSubject(retained));
    EXPECT_EQ(raw.subject, retained);
  };
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, db.RemoveMessageFromFolder(
                       key, mFolderId, source,
                       MessageRemovalAccounting::LocalMessageSize));
  EXPECT_EQ(1u, removed);
  nsTArray<nsCString> references;
  ASSERT_EQ(NS_OK, Stored(key, references));
  EXPECT_TRUE(references.IsEmpty());
  ASSERT_EQ(NS_OK, db.GetMessageSubject(key, subject));
  EXPECT_EQ(raw.subject, subject);
  db.RemoveMessageListener(observer);
  unwatch.release();
  Stop();
  ASSERT_EQ(NS_OK, Start());
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(int64_t(UINT32_MAX), expunged);
  bool exists = true;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_FALSE(exists);
}

TEST_F(DeliveryCoreReferences,
       FolderRemovalRemoteAndGenericPoliciesStayDistinct) {
  ASSERT_EQ(NS_OK, Start());
  auto &db = mCore->MessageDB();
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  RawHdr raw;
  raw.messageId = "remote-online"_ns;
  raw.messageSize = Some(97u);
  raw.offlineMessageSize = Some(UINT32_MAX);
  nsMsgKey online, offline, generic, absent;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &online));
  raw.messageId = "remote-offline"_ns;
  raw.flags = nsMsgMessageFlags::Offline;
  raw.offlineMessageSize = Some(0x80000000u);
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &offline));
  raw.messageId = "generic-unaccounted"_ns;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &generic));
  ASSERT_EQ(NS_OK, Add("absent-size"_ns, {}, absent));
  ASSERT_EQ(NS_OK, db.RemoveMessageFromFolder(
                       online, mFolderId, source,
                       MessageRemovalAccounting::OfflineMessageSize));
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(0, expunged);
  ASSERT_EQ(NS_OK, db.RemoveMessageFromFolder(
                       offline, mFolderId, source,
                       MessageRemovalAccounting::OfflineMessageSize));
  ASSERT_EQ(NS_OK, db.RemoveMessage(generic));
  ASSERT_EQ(NS_OK, db.RemoveMessageFromFolder(
                       absent, mFolderId, source,
                       MessageRemovalAccounting::LocalMessageSize));
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(int64_t(0x80000000u), expunged);
}

TEST_F(DeliveryCoreReferences,
       FolderRemovalRejectsForeignAndUnpublishedIdentity) {
  ASSERT_EQ(NS_OK, Start());
  auto &db = mCore->MessageDB();
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  uint64_t other;
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(mFolderId, "Other"_ns, &other));
  nsMsgKey key, staged;
  ASSERT_EQ(NS_OK, Add("owned-removal"_ns, {}, key));
  RawHdr raw;
  raw.messageId = "unpublished-removal"_ns;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolderId, raw, &staged));
  auto policy = MessageRemovalAccounting::LocalMessageSize;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.RemoveMessageFromFolder(key, other, source, policy));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.RemoveMessageFromFolder(key, mFolderId, "other-incarnation"_ns,
                                       policy));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.RemoveMessageFromFolder(staged, mFolderId, source, policy));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db.RemoveMessageFromFolder(1234567, mFolderId, source, policy));
  EXPECT_EQ(
      NS_ERROR_INVALID_ARG,
      db.RemoveMessageFromFolder(nsMsgKey_None, mFolderId, source, policy));
  bool exists = false;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_TRUE(exists);
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, db.ListStagedMessages(mFolderId, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{staged}), keys);
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(0, expunged);
  ASSERT_EQ(NS_OK, RemovalMetric(other, expunged));
  EXPECT_EQ(0, expunged);
}

TEST_F(DeliveryCoreReferences, FolderRemovalRejectsSizeAndCounterOverflow) {
  ASSERT_EQ(NS_OK, Start());
  auto &db = mCore->MessageDB();
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("invalid-accounting"_ns, {}, key));
  for (const auto &size : {"-1"_ns, "4294967296"_ns}) {
    nsAutoCString sql("REPLACE INTO message_properties VALUES(");
    sql.AppendInt(key);
    sql.AppendLiteral(",'messageSize',");
    sql.Append(size);
    sql.Append(')');
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    EXPECT_EQ(
        NS_ERROR_LOSS_OF_SIGNIFICANT_DATA,
        db.RemoveMessageFromFolder(key, mFolderId, source,
                                   MessageRemovalAccounting::LocalMessageSize));
    bool exists = false;
    ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
    EXPECT_TRUE(exists);
  }
  ASSERT_EQ(NS_OK, db.SetMessageSize(key, 1));
  for (int64_t metric : {-int64_t(1), INT64_MAX}) {
    ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, metric));
    EXPECT_EQ(
        NS_ERROR_LOSS_OF_SIGNIFICANT_DATA,
        db.RemoveMessageFromFolder(key, mFolderId, source,
                                   MessageRemovalAccounting::LocalMessageSize));
    int64_t retained = 0;
    ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, retained));
    EXPECT_EQ(metric, retained);
    bool exists = false;
    ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
    EXPECT_TRUE(exists);
  }
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, INT64_MAX - 1));
  ASSERT_EQ(NS_OK, db.RemoveMessageFromFolder(
                       key, mFolderId, source,
                       MessageRemovalAccounting::LocalMessageSize));
  int64_t expunged = 0;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(INT64_MAX, expunged);
}

TEST_F(DeliveryCoreReferences,
       FolderRemovalWriteFailuresRollBackCounterAndRow) {
  ASSERT_EQ(NS_OK, Start());
  auto &db = mCore->MessageDB();
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  RawHdr raw;
  raw.messageId = "removal-fault"_ns;
  raw.subject = "warm unchanged"_ns;
  raw.references = {"first"_ns, ""_ns, "last"_ns};
  raw.messageSize = Some(42u);
  raw.storeToken = Some(nsCString("provider-body"_ns));
  nsMsgKey key, control;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &key));
  ASSERT_EQ(NS_OK, Add("removal-control"_ns, {}, control));
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 7));
  nsCString subject;
  ASSERT_EQ(NS_OK, db.GetMessageSubject(key, subject));
  MessageBodyState before;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, before));
  uint32_t removed = 0;
  RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
  observer->action = [&](char kind, const CapturedMessage &,
                         const CapturedMessage &, Message *, bool) {
    EXPECT_EQ('R', kind);
    ++removed;
  };
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK, mConnection->CreateFunction("removal_fault"_ns, 1, witness));
  const nsCString triggers[] = {
      "CREATE TEMP TRIGGER reject_removal BEFORE INSERT ON folder_properties "
      "WHEN NEW.name='expungedBytes' BEGIN SELECT removal_fault(NEW.id); "
      "SELECT RAISE(ABORT,'counter failure'); END"_ns,
      "CREATE TEMP TRIGGER reject_removal BEFORE DELETE ON messages "
      "BEGIN SELECT removal_fault(OLD.id); "
      "SELECT RAISE(ABORT,'delete failure'); END"_ns};
  for (uint32_t i = 0; i < 2; ++i) {
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(triggers[i]));
    auto drop = MakeScopeExit([&] {
      EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                           "DROP TRIGGER IF EXISTS reject_removal"_ns));
    });
    EXPECT_EQ(
        NS_ERROR_STORAGE_CONSTRAINT,
        db.RemoveMessageFromFolder(key, mFolderId, source,
                                   MessageRemovalAccounting::LocalMessageSize));
    EXPECT_EQ(i + 1, witness->mCalls);
    EXPECT_EQ(i == 0 ? int64_t(mFolderId) : int64_t(key), witness->mLastKey);
    EXPECT_EQ(0u, removed);
    bool active = true, exists = false;
    ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
    ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
    EXPECT_TRUE(exists);
    ASSERT_EQ(NS_OK, db.MessageExists(control, exists));
    EXPECT_TRUE(exists);
    int64_t expunged = -1;
    ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
    EXPECT_EQ(7, expunged);
    ASSERT_EQ(NS_OK, db.GetMessageSubject(key, subject));
    EXPECT_EQ(raw.subject, subject);
    MessageBodyState after;
    ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, after));
    EXPECT_EQ(before.storeToken, after.storeToken);
    EXPECT_EQ(before.contentRevision, after.contentRevision);
    EXPECT_EQ(before.locationRevision, after.locationRevision);
    nsTArray<nsCString> references;
    ASSERT_EQ(NS_OK, Stored(key, references));
    EXPECT_EQ(raw.references, references);
  }
  ASSERT_EQ(NS_OK, db.RemoveMessageFromFolder(
                       key, mFolderId, source,
                       MessageRemovalAccounting::LocalMessageSize));
  EXPECT_EQ(1u, removed);
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(49, expunged);
}

TEST_F(DeliveryCoreReferences,
       FolderRemovalReadFailurePreservesCounterAndEvents) {
  ASSERT_EQ(NS_OK, Start());
  auto &db = mCore->MessageDB();
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("removal-read-fault"_ns, {}, key));
  ASSERT_EQ(NS_OK, db.SetMessageSize(key, 23));
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 9));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("removal_read_fault"_ns, 1, witness));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "CREATE TEMP VIEW folder_properties AS SELECT id,name, "
                "CASE WHEN name='expungedBytes' AND removal_read_fault(id)=0 "
                "THEN abs(-9223372036854775808) ELSE value END AS value "
                "FROM main.folder_properties"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.folder_properties"_ns));
  });
  uint32_t removed = 0;
  RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
  observer->action = [&](char, const CapturedMessage &, const CapturedMessage &,
                         Message *, bool) { ++removed; };
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  EXPECT_EQ(NS_ERROR_FAILURE, db.RemoveMessageFromFolder(
                                  key, mFolderId, source,
                                  MessageRemovalAccounting::LocalMessageSize));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(int64_t(mFolderId), witness->mLastKey);
  EXPECT_EQ(0u, removed);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.folder_properties"_ns));
  bool exists = false;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_TRUE(exists);
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(9, expunged);
}

TEST_F(DeliveryCoreReferences, FolderRemovalDoesNotTakeCallerTransaction) {
  ASSERT_EQ(NS_OK, Start());
  auto &db = mCore->MessageDB();
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("removal-foreign-transaction"_ns, {}, key));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 83));
  EXPECT_EQ(
      NS_ERROR_IN_PROGRESS,
      db.RemoveMessageFromFolder(key, mFolderId, source,
                                 MessageRemovalAccounting::LocalMessageSize));
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(83, expunged);
  ASSERT_EQ(NS_OK, mConnection->CommitTransaction());
  bool exists = false;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreReferences, FolderRemovalRespectsPendingBodyRelocation) {
  ASSERT_EQ(NS_OK, Start());
  FolderBodyRelocation plan;
  ASSERT_EQ(NS_OK, PrepareRelocation(plan));
  auto &db = mCore->MessageDB();
  ASSERT_EQ(NS_OK, db.PrepareBodyRelocation(plan));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db.RemoveMessageFromFolder(
                plan.messages[0].before.key, mFolderId, plan.databaseSourceId,
                MessageRemovalAccounting::LocalMessageSize));
  bool exists = false;
  ASSERT_EQ(NS_OK, db.MessageExists(plan.messages[0].before.key, exists));
  EXPECT_TRUE(exists);
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(0, expunged);
  ASSERT_EQ(NS_OK, db.SettleBodyRelocation(mFolderId, plan.token,
                                           BodyRelocationOutcome::Restored));
}

TEST_F(DeliveryCoreReferences,
       FolderRemovalCommitFailureRollsBackCounterAndRow) {
  ASSERT_EQ(NS_OK, Start());
  auto &db = mCore->MessageDB();
  nsCString source;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(source));
  RawHdr raw;
  raw.messageId = "removal-commit-fault"_ns;
  raw.messageSize = Some(42u);
  raw.storeToken = Some(nsCString("retained-body"_ns));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, db.AddMessage(mFolderId, raw, true, &key));
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 7));
  MessageBodyState before;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, before));
  ASSERT_EQ(NS_OK,
            mConnection->ExecuteSimpleSQL(
                "PRAGMA foreign_keys=ON; "
                "CREATE TEMP TABLE removal_parent(id INTEGER PRIMARY KEY); "
                "CREATE TEMP TABLE removal_child(id INTEGER REFERENCES "
                "removal_parent(id) "
                "DEFERRABLE INITIALLY DEFERRED)"_ns));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("removal_commit_fault"_ns, 1, witness));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER reject_removal_commit AFTER DELETE "
                       "ON main.messages "
                       "BEGIN SELECT removal_commit_fault(OLD.id); "
                       "INSERT INTO removal_child VALUES(OLD.id); END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS reject_removal_commit"_ns));
  });
  uint32_t removed = 0;
  RefPtr<ThreadQueueObserver> observer = new ThreadQueueObserver();
  observer->action = [&](char, const CapturedMessage &, const CapturedMessage &,
                         Message *, bool) { ++removed; };
  db.AddMessageListener(observer);
  auto unwatch = MakeScopeExit([&] { db.RemoveMessageListener(observer); });
  EXPECT_EQ(
      NS_ERROR_STORAGE_CONSTRAINT,
      db.RemoveMessageFromFolder(key, mFolderId, source,
                                 MessageRemovalAccounting::LocalMessageSize));
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(int64_t(key), witness->mLastKey);
  EXPECT_EQ(0u, removed);
  bool active = true, exists = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_TRUE(exists);
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(7, expunged);
  MessageBodyState after;
  ASSERT_EQ(NS_OK, db.GetMessageBodyState(key, after));
  EXPECT_EQ(before.storeToken, after.storeToken);
  EXPECT_EQ(before.contentRevision, after.contentRevision);
  EXPECT_EQ(before.locationRevision, after.locationRevision);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP TRIGGER reject_removal_commit"_ns));
  ASSERT_EQ(NS_OK, db.RemoveMessageFromFolder(
                       key, mFolderId, source,
                       MessageRemovalAccounting::LocalMessageSize));
  EXPECT_EQ(1u, removed);
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(49, expunged);
}

TEST_F(DeliveryCoreReferences,
       FolderAdmissionReadsCallerTransactionWithoutOwningIt) {
  ASSERT_EQ(NS_OK, Start());
  nsCString expected;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(expected));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    if (active)
      EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 83));
  nsCString admitted = "unchanged"_ns;
  ASSERT_EQ(NS_OK, AdmissionSource(mCore, admitted));
  EXPECT_EQ(expected, admitted);
  nsCString publicOutput = "public-unchanged"_ns;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, mCore->GetSourceId(publicOutput));
  EXPECT_EQ("public-unchanged"_ns, publicOutput);
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  int64_t expunged = 0;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(83, expunged);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(0, expunged);
  ASSERT_EQ(NS_OK, mCore->GetSourceId(publicOutput));
  EXPECT_EQ(admitted, publicOutput);
}

TEST_F(DeliveryCoreReferences,
       FolderAdmissionRolledBackIdentityCannotRemoveRows) {
  ASSERT_EQ(NS_OK, Start());
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("admitted-incarnation"_ns, {}, key));
  nsCString committed;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(committed));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    if (active)
      EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
  });
  ASSERT_EQ(
      NS_OK,
      mConnection->ExecuteSimpleSQL(
          "UPDATE database_identity SET "
          "sourceId='{12345678-9ABC-4def-8123-0123456789ab}' WHERE singleton=1"_ns));
  nsCString admitted;
  ASSERT_EQ(NS_OK, AdmissionSource(mCore, admitted));
  EXPECT_EQ("{12345678-9ABC-4def-8123-0123456789ab}"_ns, admitted);
  EXPECT_NE(committed, admitted);
  ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            mCore->MessageDB().RemoveMessageFromFolder(
                key, mFolderId, admitted,
                MessageRemovalAccounting::LocalMessageSize));
  bool exists = false;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_TRUE(exists);
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(0, expunged);
  EXPECT_EQ("{12345678-9ABC-4def-8123-0123456789ab}"_ns, admitted);
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessageFromFolder(
                       key, mFolderId, committed,
                       MessageRemovalAccounting::LocalMessageSize));
}

TEST_F(DeliveryCoreReferences,
       FolderAdmissionReadErrorsKeepOutputAndTransaction) {
  ASSERT_EQ(NS_OK, Start());
  nsCString expected;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(expected));
  RefPtr<FaultWitness> witness = new FaultWitness();
  ASSERT_EQ(NS_OK,
            mConnection->CreateFunction("admission_fault"_ns, 1, witness));
  ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
    if (active)
      EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, SetRemovalMetric(mFolderId, 31));
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "CREATE TEMP VIEW database_identity AS "
                       "SELECT singleton,sourceId FROM main.database_identity "
                       "WHERE CASE WHEN admission_fault(singleton)=0 "
                       "THEN abs(-9223372036854775808) ELSE 1 END"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                         "DROP VIEW IF EXISTS temp.database_identity"_ns));
  });
  nsCString output = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_FAILURE, AdmissionSource(mCore, output));
  EXPECT_EQ("unchanged"_ns, output);
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(1, witness->mLastKey);
  bool active = false;
  ASSERT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(
                       "DROP VIEW temp.database_identity"_ns));
  ASSERT_EQ(NS_OK, AdmissionSource(mCore, output));
  EXPECT_EQ(expected, output);
  ASSERT_EQ(NS_OK, mConnection->CommitTransaction());
  int64_t expunged = -1;
  ASSERT_EQ(NS_OK, RemovalMetric(mFolderId, expunged));
  EXPECT_EQ(31, expunged);
}

TEST_F(DeliveryCoreReferences, FolderAdmissionRejectsCorruptAndRetiredSources) {
  ASSERT_EQ(NS_OK, Start());
  nsCString expected;
  ASSERT_EQ(NS_OK, mCore->GetSourceId(expected));
  for (const auto &sql :
       {"DELETE FROM database_identity"_ns,
        "UPDATE database_identity SET sourceId='not-a-uuid'"_ns,
        "UPDATE database_identity SET sourceId=''"_ns}) {
    ASSERT_EQ(NS_OK, mConnection->BeginTransaction());
    auto rollback = MakeScopeExit([&] {
      bool active = false;
      EXPECT_EQ(NS_OK, mConnection->GetTransactionInProgress(&active));
      if (active)
        EXPECT_EQ(NS_OK, mConnection->RollbackTransaction());
    });
    ASSERT_EQ(NS_OK, mConnection->ExecuteSimpleSQL(sql));
    nsCString output = "unchanged"_ns;
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, AdmissionSource(mCore, output));
    EXPECT_EQ("unchanged"_ns, output);
    ASSERT_EQ(NS_OK, mConnection->RollbackTransaction());
  }
  RefPtr<DatabaseCore> retired = mCore;
  Stop();
  nsCString output = "unchanged"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, AdmissionSource(retired, output));
  EXPECT_EQ("unchanged"_ns, output);
  ASSERT_EQ(NS_OK, Start());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, AdmissionSource(retired, output));
  EXPECT_EQ("unchanged"_ns, output);
  ASSERT_EQ(NS_OK, AdmissionSource(mCore, output));
  EXPECT_EQ(expected, output);
}

}  // namespace mozilla::mailnews
