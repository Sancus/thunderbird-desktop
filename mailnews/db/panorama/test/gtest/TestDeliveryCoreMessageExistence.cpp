/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <functional>
#include <utility>

#include "DatabaseCore.h"
#include "DetachedMsgHdr.h"
#include "LiveViewFilters.h"
#include "Message.h"
#include "MessageDatabase.h"
#include "gtest/gtest.h"
#include "mozilla/ResultExtensions.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/SpinEventLoopUntil.h"
#include "mozilla/Try.h"
#include "mozIStorageConnection.h"
#include "mozIStorageFunction.h"
#include "mozIStorageService.h"
#include "mozIStorageStatement.h"
#include "mozIStorageValueArray.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "nsIEventTarget.h"
#include "nsIFile.h"
#include "nsIInterfaceRequestorUtils.h"
#include "nsIMsgHdr.h"
#include "nsIProperties.h"
#include "nsIVariant.h"
#include "nsMsgFolderFlags.h"
#include "nsMsgMessageFlags.h"
#include "nsServiceManagerUtils.h"
#include "nsString.h"
#include "nsThreadUtils.h"
#include "nsXPCOMCID.h"

namespace mozilla::mailnews {

class MessageExistenceReadFault final : public mozIStorageFunction {
 public:
  NS_DECL_ISUPPORTS

  NS_IMETHOD OnFunctionCall(mozIStorageValueArray* args,
                            nsIVariant** result) override {
    ++mCalls;
    MOZ_TRY(args->GetInt64(0, &mLastKey));
    return NS_ERROR_FAILURE;
  }

  uint32_t mCalls = 0;
  int64_t mLastKey = 0;

 private:
  ~MessageExistenceReadFault() = default;
};
NS_IMPL_ISUPPORTS(MessageExistenceReadFault, mozIStorageFunction)

namespace {

class ConversationThreadReadFault final : public DetachedMsgHdr {
 public:
  ConversationThreadReadFault(uint64_t folderId, nsMsgKey threadId)
      : DetachedMsgHdr(folderId), mThreadId(threadId) {}

  NS_IMETHOD GetThreadId(nsMsgKey* threadId) override {
    NS_ENSURE_ARG_POINTER(threadId);
    ++mCalls;
    // An output written on failure is not a successful identity read.
    *threadId = mThreadId;
    return NS_ERROR_FAILURE;
  }

  uint32_t mCalls = 0;

 private:
  ~ConversationThreadReadFault() = default;
  const nsMsgKey mThreadId;
};

class MessageExistenceRemovedObserver final : public MessageListener {
 public:
  NS_DECL_ISUPPORTS
  explicit MessageExistenceRemovedObserver(
      std::function<void(Message*, uint32_t)> removed)
      : mRemoved(std::move(removed)) {}

  void OnMessageAdded(Message*) override {}
  void OnMessageRemoved(Message* message, uint32_t oldFlags) override {
    mRemoved(message, oldFlags);
  }
  void OnMessageFlagsChanged(nsIMsgDBHdr*, Message*, uint32_t,
                             uint32_t) override {}
  void OnMessageTagsChanged(nsIMsgDBHdr*, Message*, const nsACString&,
                            const nsACString&) override {}

 private:
  ~MessageExistenceRemovedObserver() = default;
  std::function<void(Message*, uint32_t)> mRemoved;
};
NS_IMPL_ISUPPORTS(MessageExistenceRemovedObserver, nsISupports)

}  // namespace

class DeliveryCoreMessageExistence : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_FALSE(DatabaseCore::sInstance);
    ASSERT_FALSE(Connection());
    mDirectories = do_GetService(NS_DIRECTORY_SERVICE_CONTRACTID);
    ASSERT_TRUE(mDirectories);
    ASSERT_EQ(NS_OK,
              mDirectories->Get(NS_APP_USER_PROFILE_50_DIR, NS_GET_IID(nsIFile),
                                getter_AddRefs(mOldProfile)));
    ASSERT_TRUE(mOldProfile);
    // Retain failed fixtures outside the harness profile's cleanup tree.
    ASSERT_EQ(NS_OK,
              NS_GetSpecialDirectory(NS_OS_TEMP_DIR, getter_AddRefs(mProfile)));
    ASSERT_EQ(NS_OK, mProfile->Append(u"delivery-message-existence"_ns));
    ASSERT_EQ(NS_OK, mProfile->CreateUnique(nsIFile::DIRECTORY_TYPE, 0700));
    mProfileCreated = true;
    nsresult rv = mDirectories->Undefine(NS_APP_USER_PROFILE_50_DIR);
    mDirectoryChanged = NS_SUCCEEDED(rv);
    ASSERT_EQ(NS_OK, rv);
    rv = mDirectories->Set(NS_APP_USER_PROFILE_50_DIR, mProfile);
    mProfileInstalled = NS_SUCCEEDED(rv);
    ASSERT_EQ(NS_OK, rv);
    ASSERT_EQ(NS_OK, mProfile->Clone(getter_AddRefs(mFile)));
    ASSERT_EQ(NS_OK, mFile->Append(u"panorama.sqlite"_ns));
    ASSERT_NO_FATAL_FAILURE(Start());
    uint64_t root;
    ASSERT_EQ(NS_OK,
              mCore->FolderDB().InsertRoot("native-existence"_ns, &root));
    ASSERT_EQ(NS_OK,
              mCore->FolderDB().InsertFolder(root, "Inbox"_ns, &mFolder));
  }

  void TearDown() override {
    bool drained = Stop();
    mFault = nullptr;
    bool restored = RestoreProfile();
    if (mProfileCreated) {
      EXPECT_TRUE(drained);
      EXPECT_TRUE(restored);
      if (drained && restored && !HasFailure()) {
        EXPECT_EQ(NS_OK, mProfile->Remove(true));
        bool exists = true;
        EXPECT_EQ(NS_OK, mProfile->Exists(&exists));
        EXPECT_FALSE(exists);
      } else {
        nsAutoString retained;
        EXPECT_EQ(NS_OK, mProfile->GetPath(retained));
        RecordProperty("retained_profile",
                       NS_ConvertUTF16toUTF8(retained).get());
      }
    }
  }

  static mozIStorageConnection* Connection() {
    return DatabaseCore::sConnection.get();
  }

  void Start() {
    mCore = DatabaseCore::GetInstanceForService();
    ASSERT_EQ(NS_OK, mCore->Startup());
    ASSERT_TRUE(Connection());
    nsCOMPtr<nsIFile> actualFile;
    ASSERT_EQ(NS_OK, Connection()->GetDatabaseFile(getter_AddRefs(actualFile)));
    bool sameFile = false;
    ASSERT_EQ(NS_OK, mFile->Equals(actualFile, &sameFile));
    ASSERT_TRUE(sameFile);
  }

  bool Stop() {
    if (!mCore) {
      return !mCloseFailed;
    }
    nsCOMPtr<mozIStorageConnection> connection = Connection();
    nsCOMPtr<nsIEventTarget> target = do_GetInterface(connection);
    if (connection) {
      EXPECT_TRUE(target);
    }
    nsresult rv = mCore->Observe(nullptr, "profile-before-change", nullptr);
    EXPECT_EQ(NS_OK, rv);
    mCore = nullptr;
    bool drained = NS_SUCCEEDED(rv);
    if (connection) {
      drained = target && WaitForClose(target) && drained;
    }
    mCloseFailed = mCloseFailed || !drained;
    return !mCloseFailed;
  }

  static bool WaitForClose(nsIEventTarget* target) {
    sCloseCompleted = false;
    // Observe queues AsyncClose before this barrier, with no intervening spin.
    nsresult rv = target->Dispatch(
        NS_NewRunnableFunction(
            "MessageExistenceCloseBarrier",
            [] {
              MOZ_ALWAYS_SUCCEEDS(NS_DispatchToMainThread(
                  NS_NewRunnableFunction("MessageExistenceClosed",
                                         [] { sCloseCompleted = true; })));
            }),
        NS_DISPATCH_NORMAL);
    EXPECT_EQ(NS_OK, rv);
    if (NS_FAILED(rv)) {
      return false;
    }
    bool drained = SpinEventLoopUntil("MessageExistenceClosed"_ns,
                                      [] { return sCloseCompleted; });
    EXPECT_TRUE(drained);
    return drained;
  }

  bool RestoreProfile() {
    if (!mDirectoryChanged) {
      return true;
    }
    bool restored = true;
    if (mProfileInstalled) {
      nsresult rv = mDirectories->Undefine(NS_APP_USER_PROFILE_50_DIR);
      EXPECT_EQ(NS_OK, rv);
      restored = NS_SUCCEEDED(rv);
    }
    nsresult rv = mDirectories->Set(NS_APP_USER_PROFILE_50_DIR, mOldProfile);
    EXPECT_EQ(NS_OK, rv);
    restored = NS_SUCCEEDED(rv) && restored;
    nsCOMPtr<nsIFile> actual;
    rv = mDirectories->Get(NS_APP_USER_PROFILE_50_DIR, NS_GET_IID(nsIFile),
                           getter_AddRefs(actual));
    EXPECT_EQ(NS_OK, rv);
    bool sameProfile = false;
    if (NS_SUCCEEDED(rv) && actual) {
      rv = mOldProfile->Equals(actual, &sameProfile);
      EXPECT_EQ(NS_OK, rv);
      restored = NS_SUCCEEDED(rv) && restored;
    }
    EXPECT_TRUE(sameProfile);
    return sameProfile && restored;
  }

  nsresult Add(const nsACString& messageId, nsMsgKey& key) {
    return mCore->MessageDB().AddMessage(
        mFolder, messageId, {}, 123456, "Sender <sender@invalid>"_ns,
        "Recipient <recipient@invalid>"_ns, "cc@invalid"_ns, "bcc@invalid"_ns,
        "Stored subject"_ns,
        nsMsgMessageFlags::Read | nsMsgMessageFlags::Marked, "tagA tagB"_ns, 5,
        &key);
  }

  void CheckStoredKeys(nsTArray<nsMsgKey> expected,
                       const nsACString& table = "messages"_ns) {
    nsCOMPtr<mozIStorageService> storage =
        do_GetService("@mozilla.org/storage/service;1");
    ASSERT_TRUE(storage);
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, storage->OpenUnsharedDatabase(
                         mFile, mozIStorageService::CONNECTION_DEFAULT,
                         getter_AddRefs(reader)));
    nsCOMPtr<mozIStorageStatement> stmt;
    auto cleanup = MakeScopeExit([&] {
      if (stmt) {
        EXPECT_EQ(NS_OK, stmt->Finalize());
      }
      EXPECT_EQ(NS_OK, reader->Close());
    });
    ASSERT_EQ(NS_OK, reader->CreateStatement(
                         "SELECT id FROM "_ns + table + " ORDER BY id"_ns,
                         getter_AddRefs(stmt)));
    nsTArray<nsMsgKey> actual;
    while (true) {
      bool more;
      ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
      if (!more) {
        break;
      }
      int64_t key;
      ASSERT_EQ(NS_OK, stmt->GetInt64(0, &key));
      actual.AppendElement(static_cast<nsMsgKey>(key));
    }
    expected.Sort();
    EXPECT_EQ(expected, actual);
  }

  void CheckHeader(nsIMsgDBHdr* header, nsMsgKey key, nsMsgKey thread) {
    nsMsgKey actualKey = nsMsgKey_None;
    EXPECT_EQ(NS_OK, header->GetMessageKey(&actualKey));
    EXPECT_EQ(key, actualKey);
    nsAutoCString text;
    EXPECT_EQ(NS_OK, header->GetMessageId(text));
    EXPECT_EQ("removed@invalid"_ns, text);
    EXPECT_EQ(NS_OK, header->GetSubject(text));
    EXPECT_EQ("Stored subject"_ns, text);
    EXPECT_EQ(NS_OK, header->GetAuthor(text));
    EXPECT_EQ("Sender <sender@invalid>"_ns, text);
    EXPECT_EQ(NS_OK, header->GetRecipients(text));
    EXPECT_EQ("Recipient <recipient@invalid>"_ns, text);
    EXPECT_EQ(NS_OK, header->GetCcList(text));
    EXPECT_EQ("cc@invalid"_ns, text);
    EXPECT_EQ(NS_OK, header->GetBccList(text));
    EXPECT_EQ("bcc@invalid"_ns, text);
    EXPECT_EQ(NS_OK, header->GetStringProperty("keywords", text));
    EXPECT_EQ("tagA tagB"_ns, text);
    PRTime date = 0;
    EXPECT_EQ(NS_OK, header->GetDate(&date));
    EXPECT_EQ(PRTime(123456), date);
    uint32_t flags = 0;
    EXPECT_EQ(NS_OK, header->GetFlags(&flags));
    EXPECT_EQ(uint32_t(nsMsgMessageFlags::Read | nsMsgMessageFlags::Marked),
              flags);
    nsMsgPriorityValue priority = 0;
    EXPECT_EQ(NS_OK, header->GetPriority(&priority));
    EXPECT_EQ(5, priority);
    actualKey = 0;
    EXPECT_EQ(NS_OK, header->GetThreadId(&actualKey));
    EXPECT_EQ(thread, actualKey);
    actualKey = nsMsgKey_None;
    EXPECT_EQ(NS_OK, header->GetThreadParent(&actualKey));
    EXPECT_EQ(0u, actualKey);
    uint64_t folder = 0;
    EXPECT_EQ(NS_OK, mCore->MessageDB().GetMessageFolderId(key, folder));
    EXPECT_EQ(mFolder, folder);
  }

  void InstallStepFault() {
    mFault = new MessageExistenceReadFault();
    ASSERT_EQ(NS_OK, Connection()->CreateFunction("delivery_existence_fault"_ns,
                                                  1, mFault));
    ASSERT_EQ(NS_OK,
              Connection()->ExecuteSimpleSQL(
                  "CREATE TEMP VIEW messages AS SELECT "
                  "delivery_existence_fault(id) AS id FROM main.messages"_ns));
    nsCOMPtr<mozIStorageStatement> probe;
    ASSERT_EQ(NS_OK, Connection()->CreateStatement("SELECT id FROM messages"_ns,
                                                   getter_AddRefs(probe)));
    EXPECT_EQ(0u, mFault->mCalls);
    EXPECT_EQ(NS_OK, probe->Finalize());
  }

  void CheckStepFailure(nsMsgKey key) {
    ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({key}));
    ASSERT_NO_FATAL_FAILURE(InstallStepFault());
    bool exists = true;
    EXPECT_EQ(NS_ERROR_FAILURE, mCore->MessageDB().MessageExists(key, exists));
    EXPECT_TRUE(exists);
    EXPECT_EQ(1u, mFault->mCalls);
    EXPECT_EQ(int64_t(key), mFault->mLastKey);
    ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({key}));
  }

  void CheckPrepareFailure(nsMsgKey key) {
    ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({key}));
    ASSERT_EQ(
        NS_OK,
        Connection()->ExecuteSimpleSQL(
            "ALTER TABLE messages RENAME TO delivery_hidden_messages"_ns));
    ASSERT_NO_FATAL_FAILURE(
        CheckStoredKeys({key}, "delivery_hidden_messages"_ns));
    bool exists = false;
    EXPECT_EQ(NS_ERROR_FAILURE, mCore->MessageDB().MessageExists(key, exists));
    EXPECT_FALSE(exists);
    ASSERT_NO_FATAL_FAILURE(
        CheckStoredKeys({key}, "delivery_hidden_messages"_ns));
  }

  void AddFilterMessages(nsTArray<RefPtr<Message>>& messages,
                         nsTArray<uint64_t>& folders) {
    uint64_t root, other, excluded;
    ASSERT_EQ(NS_OK, mCore->FolderDB().GetFolderRoot(mFolder, &root));
    ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(root, "Other"_ns, &other));
    ASSERT_EQ(NS_OK,
              mCore->FolderDB().InsertFolder(root, "Excluded"_ns, &excluded));
    folders = {mFolder, other, excluded};
    for (uint64_t folder : folders) {
      nsMsgKey key;
      ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(
                           folder, "filter@invalid"_ns, {}, 123456, "sender"_ns,
                           "recipient"_ns, ""_ns, ""_ns, "Filter message"_ns, 0,
                           ""_ns, 0, &key));
      messages.AppendElement(new Message(key));
    }
    ASSERT_NO_FATAL_FAILURE(CheckStoredKeys(
        {messages[0]->Key(), messages[1]->Key(), messages[2]->Key()}));
    nsCOMPtr<mozIStorageStatement> stored;
    ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                         "SELECT folderId FROM messages WHERE id = :id"_ns,
                         getter_AddRefs(stored)));
    auto finalize =
        MakeScopeExit([&] { EXPECT_EQ(NS_OK, stored->Finalize()); });
    for (size_t i = 0; i < messages.Length(); ++i) {
      ASSERT_EQ(NS_OK, stored->BindInt64ByName("id"_ns, messages[i]->Key()));
      bool more = false;
      ASSERT_EQ(NS_OK, stored->ExecuteStep(&more));
      ASSERT_TRUE(more);
      int64_t actualFolder = 0;
      ASSERT_EQ(NS_OK, stored->GetInt64(0, &actualFolder));
      EXPECT_EQ(folders[i], static_cast<uint64_t>(actualFolder));
      ASSERT_EQ(NS_OK, stored->Reset());
    }
    nsCOMPtr<nsIMsgFolder> folder;
    ASSERT_EQ(NS_ERROR_NOT_INITIALIZED,
              messages[0]->GetFolder(getter_AddRefs(folder)));
    ASSERT_FALSE(folder);
  }

  void ReadStoredThread(nsMsgKey key, nsMsgKey& thread) {
    nsCOMPtr<mozIStorageStatement> stmt;
    ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                         "SELECT threadId FROM messages WHERE id = :id"_ns,
                         getter_AddRefs(stmt)));
    auto finalize = MakeScopeExit([&] { EXPECT_EQ(NS_OK, stmt->Finalize()); });
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, key));
    bool more = false;
    ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
    ASSERT_TRUE(more);
    int64_t stored = 0;
    ASSERT_EQ(NS_OK, stmt->GetInt64(0, &stored));
    ASSERT_GT(stored, 0);
    thread = static_cast<nsMsgKey>(stored);
  }

  void CheckRemovedState(Message* header, nsMsgKey removed, nsMsgKey survivor,
                         nsMsgKey thread) {
    bool inTransaction = true;
    EXPECT_EQ(NS_OK, Connection()->GetTransactionInProgress(&inTransaction));
    EXPECT_FALSE(inTransaction);
    bool exists = true;
    EXPECT_EQ(NS_OK, mCore->MessageDB().MessageExists(removed, exists));
    EXPECT_FALSE(exists);
    exists = false;
    EXPECT_EQ(NS_OK, mCore->MessageDB().MessageExists(survivor, exists));
    EXPECT_TRUE(exists);
    uint64_t count = 0;
    EXPECT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&count));
    EXPECT_EQ(1u, count);
    CheckStoredKeys({survivor});
    CheckHeader(header, removed, thread);
  }

  void CheckRemovalProperty(nsMsgKey key, bool present) {
    nsCOMPtr<mozIStorageService> storage =
        do_GetService("@mozilla.org/storage/service;1");
    ASSERT_TRUE(storage);
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, storage->OpenUnsharedDatabase(
                         mFile, mozIStorageService::CONNECTION_DEFAULT,
                         getter_AddRefs(reader)));
    nsCOMPtr<mozIStorageStatement> stmt;
    auto cleanup = MakeScopeExit([&] {
      if (stmt) {
        EXPECT_EQ(NS_OK, stmt->Finalize());
      }
      EXPECT_EQ(NS_OK, reader->Close());
    });
    ASSERT_EQ(NS_OK, reader->CreateStatement(
                         "SELECT value FROM message_properties "
                         "WHERE id = :id AND name = 'delivery.keep'"_ns,
                         getter_AddRefs(stmt)));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, key));
    bool more = false;
    ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
    EXPECT_EQ(present, more);
    if (more) {
      nsAutoCString value;
      EXPECT_EQ(NS_OK, stmt->GetUTF8String(0, value));
      EXPECT_EQ("preserved"_ns, value);
    }
  }

  nsresult FolderCount(uint64_t folder, bool unread, uint64_t& count) {
    return unread ? mCore->MessageDB().GetNumUnread(folder, &count)
                  : mCore->MessageDB().GetNumMessages(folder, &count);
  }

  nsresult FolderKeys(uint64_t folder, nsTArray<nsMsgKey>& keys) {
    return mCore->MessageDB().ListAllKeys(folder, keys);
  }

  void CheckFolderKeysBindFailure() {
    nsMsgKey key;
    ASSERT_EQ(NS_OK, Add("folder-bind@invalid"_ns, key));
    nsCOMPtr<mozIStorageStatement> stmt;
    ASSERT_EQ(NS_OK, DatabaseCore::GetStatement("ListAllKeys"_ns,
                                                "SELECT :other AS id"_ns,
                                                getter_AddRefs(stmt)));
    nsTArray<nsMsgKey> keys{77, 88};
    EXPECT_EQ(NS_ERROR_INVALID_ARG, FolderKeys(mFolder, keys));
    EXPECT_EQ((nsTArray<nsMsgKey>{77, 88}), keys);
    ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({key}));
  }

  nsresult ThreadKeys(uint64_t folder, uint64_t parent, uint64_t thread,
                      nsTArray<nsMsgKey>& keys) {
    return mCore->MessageDB().ListThreadKeys(folder, parent, thread, keys);
  }

  void SetThreadLocation(nsMsgKey key, nsMsgKey thread, nsMsgKey parent,
                         uint64_t folder) {
    nsCOMPtr<mozIStorageStatement> stmt;
    ASSERT_EQ(
        NS_OK,
        Connection()->CreateStatement(
            "UPDATE messages SET threadId = :thread, "
            "threadParent = :parent, folderId = :folder WHERE id = :id"_ns,
            getter_AddRefs(stmt)));
    auto cleanup = MakeScopeExit([&] { EXPECT_EQ(NS_OK, stmt->Finalize()); });
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("thread"_ns, thread));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("parent"_ns, parent));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("folder"_ns, folder));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, key));
    ASSERT_EQ(NS_OK, stmt->Execute());
  }

  void CheckThreadBindFailure(const nsACString& sql,
                              const nsACString& missingParameter) {
    nsMsgKey key, thread;
    ASSERT_EQ(NS_OK, Add("thread-bind@invalid"_ns, key));
    ASSERT_NO_FATAL_FAILURE(ReadStoredThread(key, thread));
    nsCOMPtr<mozIStorageStatement> stmt;
    // Inject a real cached statement with one missing bind parameter.
    ASSERT_EQ(NS_OK, DatabaseCore::GetStatement("ListThreadKeys"_ns, sql,
                                                getter_AddRefs(stmt)));
    uint32_t index = 0;
    ASSERT_EQ(NS_ERROR_INVALID_ARG,
              stmt->GetParameterIndex(missingParameter, &index));
    nsTArray<nsMsgKey> keys{77, 88};
    EXPECT_EQ(NS_ERROR_INVALID_ARG, ThreadKeys(mFolder, 0, thread, keys));
    EXPECT_EQ((nsTArray<nsMsgKey>{77, 88}), keys);
    ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({key}));
  }

  void CheckThreadStepFailure(bool afterSeed) {
    nsMsgKey root, child, thread;
    ASSERT_EQ(NS_OK, Add("thread-root@invalid"_ns, root));
    ASSERT_EQ(NS_OK, Add("thread-child@invalid"_ns, child));
    ASSERT_NO_FATAL_FAILURE(ReadStoredThread(root, thread));
    ASSERT_NO_FATAL_FAILURE(SetThreadLocation(child, thread, root, mFolder));
    mFault = new MessageExistenceReadFault();
    ASSERT_EQ(NS_OK, Connection()->CreateFunction("delivery_thread_fault"_ns, 1,
                                                  mFault));
    ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "PRAGMA automatic_index = OFF;"
                         "CREATE TEMP VIEW messages AS SELECT "
                         "delivery_thread_fault(id) AS id, folderId, "
                         "threadId, threadParent FROM main.messages"_ns));
    EXPECT_EQ(0u, mFault->mCalls);
    nsTArray<nsMsgKey> keys{77, 88};
    EXPECT_EQ(NS_ERROR_FAILURE,
              ThreadKeys(mFolder, afterSeed ? root : 0, thread, keys));
    EXPECT_EQ((nsTArray<nsMsgKey>{77, 88}), keys);
    EXPECT_EQ(1u, mFault->mCalls);
    EXPECT_EQ(int64_t(afterSeed ? child : root), mFault->mLastKey);
    ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({root, child}));
    ASSERT_EQ(NS_OK,
              Connection()->ExecuteSimpleSQL(
                  "DROP VIEW temp.messages; PRAGMA automatic_index = ON"_ns));
    ASSERT_EQ(NS_OK, Connection()->RemoveFunction("delivery_thread_fault"_ns));
    ASSERT_EQ(NS_OK, ThreadKeys(mFolder, 0, thread, keys));
    EXPECT_EQ((nsTArray<nsMsgKey>{root, child}), keys);
  }

  RefPtr<DatabaseCore> mCore;
  nsCOMPtr<nsIProperties> mDirectories;
  nsCOMPtr<nsIFile> mOldProfile, mProfile, mFile;
  RefPtr<MessageExistenceReadFault> mFault;
  bool mProfileCreated = false;
  bool mDirectoryChanged = false;
  bool mProfileInstalled = false;
  bool mCloseFailed = false;
  uint64_t mFolder = 0;
  static inline bool sCloseCompleted = false;
};

namespace {

using DISABLED_DeliveryCoreMessageExistence = DeliveryCoreMessageExistence;

TEST_F(DISABLED_DeliveryCoreMessageExistence,
       SingleFolderFilterUsesStoredIdentity) {
  nsTArray<RefPtr<Message>> messages;
  nsTArray<uint64_t> folders;
  ASSERT_NO_FATAL_FAILURE(AddFilterMessages(messages, folders));
  SingleFolderFilter filter(folders[0]);
  EXPECT_TRUE(filter.Matches(messages[0], messages[0]->FolderId()));
  EXPECT_FALSE(filter.Matches(messages[1], messages[1]->FolderId()));
  EXPECT_FALSE(filter.Matches(messages[2], messages[2]->FolderId()));
  RefPtr<Message> missing = new Message(nsMsgKey_None);
  ASSERT_EQ(0u, missing->FolderId());
  EXPECT_FALSE(filter.Matches(missing, missing->FolderId()));
}

TEST_F(DISABLED_DeliveryCoreMessageExistence,
       MultiFolderFilterUsesStoredIdentity) {
  nsTArray<RefPtr<Message>> messages;
  nsTArray<uint64_t> folders;
  ASSERT_NO_FATAL_FAILURE(AddFilterMessages(messages, folders));
  nsTArray<uint64_t> wanted = {folders[1], folders[0]};
  MultiFolderFilter filter(wanted);
  EXPECT_TRUE(filter.Matches(messages[0], messages[0]->FolderId()));
  EXPECT_TRUE(filter.Matches(messages[1], messages[1]->FolderId()));
  EXPECT_FALSE(filter.Matches(messages[2], messages[2]->FolderId()));
  RefPtr<Message> missing = new Message(nsMsgKey_None);
  ASSERT_EQ(0u, missing->FolderId());
  EXPECT_FALSE(filter.Matches(missing, missing->FolderId()));
}

TEST_F(DISABLED_DeliveryCoreMessageExistence,
       VirtualFolderFilterUsesStoredIdentity) {
  nsTArray<RefPtr<Message>> messages;
  nsTArray<uint64_t> folders;
  ASSERT_NO_FATAL_FAILURE(AddFilterMessages(messages, folders));
  uint64_t root, virtualFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().GetFolderRoot(mFolder, &root));
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(root, "Virtual"_ns, &virtualFolder));
  ASSERT_EQ(NS_OK, mCore->FolderDB().UpdateFlags(virtualFolder,
                                                 nsMsgFolderFlags::Virtual));
  nsCOMPtr<mozIStorageStatement> stmt;
  auto finalize = MakeScopeExit([&] {
    if (stmt) {
      EXPECT_EQ(NS_OK, stmt->Finalize());
    }
  });
  ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                       "INSERT INTO folder_properties (id, name, value) "
                       "VALUES (:id, 'searchStr', 'ALL')"_ns,
                       getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, virtualFolder));
  ASSERT_EQ(NS_OK, stmt->Execute());
  ASSERT_EQ(NS_OK, stmt->Finalize());
  stmt = nullptr;
  ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                       "INSERT INTO virtualFolder_folders "
                       "(virtualFolderId, searchFolderId) "
                       "VALUES (:virtual, :first), (:virtual, :second)"_ns,
                       getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("virtual"_ns, virtualFolder));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("first"_ns, folders[0]));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("second"_ns, folders[1]));
  ASSERT_EQ(NS_OK, stmt->Execute());
  ASSERT_EQ(NS_OK, stmt->Finalize());
  stmt = nullptr;
  VirtualFolderFilter filter(virtualFolder);
  EXPECT_TRUE(filter.Matches(messages[0], messages[0]->FolderId()));
  EXPECT_TRUE(filter.Matches(messages[1], messages[1]->FolderId()));
  EXPECT_FALSE(filter.Matches(messages[2], messages[2]->FolderId()));
  RefPtr<Message> missing = new Message(nsMsgKey_None);
  ASSERT_EQ(0u, missing->FolderId());
  EXPECT_FALSE(filter.Matches(missing, missing->FolderId()));
}

TEST_F(DeliveryCoreMessageExistence,
       ColdRemovalCallbackSeesCommittedRowAndReadableHeader) {
  nsMsgKey survivor, removed, thread;
  ASSERT_EQ(NS_OK, Add("survivor@invalid"_ns, survivor));
  ASSERT_EQ(NS_OK, Add("removed@invalid"_ns, removed));
  ASSERT_NO_FATAL_FAILURE(ReadStoredThread(removed, thread));
  ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({survivor, removed}));
  ASSERT_TRUE(Stop());
  ASSERT_NO_FATAL_FAILURE(Start());
  // Reopening the core clears its header cache; this is not process restart.
  uint32_t callbacks = 0;
  RefPtr<Message> retained;
  RefPtr<MessageExistenceRemovedObserver> observer =
      new MessageExistenceRemovedObserver([&](Message* message,
                                              uint32_t oldFlags) {
        ++callbacks;
        EXPECT_EQ(uint32_t(nsMsgMessageFlags::Read | nsMsgMessageFlags::Marked),
                  oldFlags);
        retained = message;
        CheckRemovedState(message, removed, survivor, thread);
      });
  mCore->MessageDB().AddMessageListener(observer);
  auto cleanup = MakeScopeExit(
      [&] { mCore->MessageDB().RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(removed));
  ASSERT_EQ(1u, callbacks);
  ASSERT_TRUE(retained);
  CheckRemovedState(retained, removed, survivor, thread);
}

TEST_F(DeliveryCoreMessageExistence, WarmRemovalUsesReturnedStoredFields) {
  nsMsgKey removed;
  ASSERT_EQ(NS_OK, Add("removed@invalid"_ns, removed));
  RefPtr<Message> header = new Message(removed);
  nsAutoCString subject;
  ASSERT_EQ(NS_OK, header->GetSubject(subject));
  ASSERT_EQ("Stored subject"_ns, subject);
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "UPDATE messages SET subject = 'Stored at deletion', "
                       "priority = 4"_ns));
  uint32_t callbacks = 0;
  RefPtr<MessageExistenceRemovedObserver> observer =
      new MessageExistenceRemovedObserver([&](Message* message, uint32_t) {
        ++callbacks;
        nsAutoCString value;
        EXPECT_EQ(NS_OK, message->GetSubject(value));
        EXPECT_EQ("Stored at deletion"_ns, value);
        nsMsgPriorityValue priority = 0;
        EXPECT_EQ(NS_OK, message->GetPriority(&priority));
        EXPECT_EQ(4, priority);
        CheckStoredKeys({});
      });
  mCore->MessageDB().AddMessageListener(observer);
  auto cleanup = MakeScopeExit(
      [&] { mCore->MessageDB().RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(removed));
  EXPECT_EQ(1u, callbacks);
  EXPECT_EQ(NS_OK, header->GetSubject(subject));
  EXPECT_EQ("Stored at deletion"_ns, subject);
  bool exists = true;
  EXPECT_EQ(NS_OK, mCore->MessageDB().MessageExists(removed, exists));
  EXPECT_FALSE(exists);
}

TEST_F(DeliveryCoreMessageExistence,
       RemovalStepFailureRollsBackWithoutNotification) {
  nsMsgKey survivor, removed, thread;
  ASSERT_EQ(NS_OK, Add("survivor@invalid"_ns, survivor));
  ASSERT_EQ(NS_OK, Add("removed@invalid"_ns, removed));
  ASSERT_NO_FATAL_FAILURE(ReadStoredThread(removed, thread));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(
                       removed, "delivery.keep"_ns, "preserved"_ns));
  ASSERT_NO_FATAL_FAILURE(CheckRemovalProperty(removed, true));
  RefPtr<Message> header = new Message(removed);
  ASSERT_NO_FATAL_FAILURE(CheckHeader(header, removed, thread));
  uint32_t callbacks = 0;
  RefPtr<MessageExistenceRemovedObserver> observer =
      new MessageExistenceRemovedObserver([&](Message* message, uint32_t) {
        ++callbacks;
        CheckRemovedState(message, removed, survivor, thread);
      });
  mCore->MessageDB().AddMessageListener(observer);
  auto unlisten = MakeScopeExit(
      [&] { mCore->MessageDB().RemoveMessageListener(observer); });
  mFault = new MessageExistenceReadFault();
  ASSERT_EQ(NS_OK, Connection()->CreateFunction("delivery_remove_fault"_ns, 1,
                                                mFault));
  bool faultInstalled = true;
  auto cleanup = MakeScopeExit([&] {
    if (faultInstalled) {
      EXPECT_EQ(NS_OK,
                Connection()->ExecuteSimpleSQL(
                    "DROP TRIGGER IF EXISTS delivery_remove_failure"_ns));
      EXPECT_EQ(NS_OK,
                Connection()->RemoveFunction("delivery_remove_fault"_ns));
    }
  });
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER delivery_remove_failure "
                       "BEFORE DELETE ON main.messages "
                       "WHEN OLD.messageId = 'removed@invalid' "
                       "BEGIN SELECT delivery_remove_fault(OLD.id); END"_ns));
  EXPECT_EQ(NS_ERROR_FAILURE, mCore->MessageDB().RemoveMessage(removed));
  EXPECT_EQ(1u, mFault->mCalls);
  EXPECT_EQ(int64_t(removed), mFault->mLastKey);
  EXPECT_EQ(0u, callbacks);
  bool inTransaction = true;
  EXPECT_EQ(NS_OK, Connection()->GetTransactionInProgress(&inTransaction));
  EXPECT_FALSE(inTransaction);
  ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({survivor, removed}));
  ASSERT_NO_FATAL_FAILURE(CheckRemovalProperty(removed, true));
  ASSERT_NO_FATAL_FAILURE(CheckHeader(header, removed, thread));
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "DROP TRIGGER delivery_remove_failure"_ns));
  ASSERT_EQ(NS_OK, Connection()->RemoveFunction("delivery_remove_fault"_ns));
  faultInstalled = false;
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(removed));
  EXPECT_EQ(1u, callbacks);
  CheckRemovalProperty(removed, false);
}

TEST_F(DeliveryCoreMessageExistence,
       RemovalCommitFailureRollsBackWithoutNotification) {
  nsMsgKey survivor, removed, thread;
  ASSERT_EQ(NS_OK, Add("survivor@invalid"_ns, survivor));
  ASSERT_EQ(NS_OK, Add("removed@invalid"_ns, removed));
  ASSERT_NO_FATAL_FAILURE(ReadStoredThread(removed, thread));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(
                       removed, "delivery.keep"_ns, "preserved"_ns));
  ASSERT_TRUE(Stop());
  ASSERT_NO_FATAL_FAILURE(Start());
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL("PRAGMA foreign_keys = ON"_ns));
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TABLE delivery_remove_parent "
                       "(id INTEGER PRIMARY KEY);"
                       "CREATE TEMP TABLE delivery_remove_child "
                       "(id INTEGER REFERENCES delivery_remove_parent(id) "
                       "DEFERRABLE INITIALLY DEFERRED)"_ns));
  // Prove the fault is deferred until COMMIT, after a successful write.
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
    if (active) {
      EXPECT_EQ(NS_OK, Connection()->RollbackTransaction());
    }
  });
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "INSERT INTO delivery_remove_child VALUES(777)"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, Connection()->CommitTransaction());
  bool active = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  ASSERT_TRUE(active);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER delivery_remove_commit_failure "
                       "AFTER DELETE ON main.messages "
                       "WHEN OLD.messageId = 'removed@invalid' "
                       "BEGIN INSERT INTO delivery_remove_child "
                       "VALUES(OLD.id); END"_ns));
  uint32_t callbacks = 0;
  RefPtr<MessageExistenceRemovedObserver> observer =
      new MessageExistenceRemovedObserver([&](Message* message, uint32_t) {
        ++callbacks;
        CheckRemovedState(message, removed, survivor, thread);
      });
  mCore->MessageDB().AddMessageListener(observer);
  auto unlisten = MakeScopeExit(
      [&] { mCore->MessageDB().RemoveMessageListener(observer); });
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            mCore->MessageDB().RemoveMessage(removed));
  EXPECT_EQ(0u, callbacks);
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_FALSE(active);
  ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({survivor, removed}));
  ASSERT_NO_FATAL_FAILURE(CheckRemovalProperty(removed, true));
  RefPtr<Message> header = new Message(removed);
  ASSERT_NO_FATAL_FAILURE(CheckHeader(header, removed, thread));
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "DROP TRIGGER delivery_remove_commit_failure"_ns));
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(removed));
  EXPECT_EQ(1u, callbacks);
  CheckRemovalProperty(removed, false);
}

TEST_F(DeliveryCoreMessageExistence, RemovalRejectsForeignTransaction) {
  nsMsgKey survivor, removed;
  ASSERT_EQ(NS_OK, Add("survivor@invalid"_ns, survivor));
  ASSERT_EQ(NS_OK, Add("removed@invalid"_ns, removed));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageProperty(
                       removed, "delivery.keep"_ns, "preserved"_ns));
  uint32_t callbacks = 0;
  RefPtr<MessageExistenceRemovedObserver> observer =
      new MessageExistenceRemovedObserver(
          [&](Message*, uint32_t) { ++callbacks; });
  mCore->MessageDB().AddMessageListener(observer);
  auto unlisten = MakeScopeExit(
      [&] { mCore->MessageDB().RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool inTransaction = false;
    EXPECT_EQ(NS_OK, Connection()->GetTransactionInProgress(&inTransaction));
    if (inTransaction) {
      EXPECT_EQ(NS_OK, Connection()->RollbackTransaction());
    }
  });
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "UPDATE messages SET subject = 'Foreign pending' "
                       "WHERE messageId = 'survivor@invalid'"_ns));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, mCore->MessageDB().RemoveMessage(removed));
  EXPECT_EQ(0u, callbacks);
  bool inTransaction = false;
  EXPECT_EQ(NS_OK, Connection()->GetTransactionInProgress(&inTransaction));
  EXPECT_TRUE(inTransaction);
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                       "SELECT subject FROM messages "
                       "WHERE messageId = 'survivor@invalid'"_ns,
                       getter_AddRefs(stmt)));
  auto finalize = MakeScopeExit([&] { EXPECT_EQ(NS_OK, stmt->Finalize()); });
  bool more = false;
  ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
  ASSERT_TRUE(more);
  nsAutoCString subject;
  ASSERT_EQ(NS_OK, stmt->GetUTF8String(0, subject));
  EXPECT_EQ("Foreign pending"_ns, subject);
  ASSERT_EQ(NS_OK, stmt->Reset());
  {
    nsCOMPtr<mozIStorageService> storage =
        do_GetService("@mozilla.org/storage/service;1");
    ASSERT_TRUE(storage);
    nsCOMPtr<mozIStorageConnection> reader;
    ASSERT_EQ(NS_OK, storage->OpenUnsharedDatabase(
                         mFile, mozIStorageService::CONNECTION_DEFAULT,
                         getter_AddRefs(reader)));
    nsCOMPtr<mozIStorageStatement> stored;
    auto close = MakeScopeExit([&] {
      if (stored) {
        EXPECT_EQ(NS_OK, stored->Finalize());
      }
      EXPECT_EQ(NS_OK, reader->Close());
    });
    ASSERT_EQ(NS_OK,
              reader->CreateStatement("SELECT subject FROM messages "
                                      "WHERE messageId = 'survivor@invalid'"_ns,
                                      getter_AddRefs(stored)));
    ASSERT_EQ(NS_OK, stored->ExecuteStep(&more));
    ASSERT_TRUE(more);
    ASSERT_EQ(NS_OK, stored->GetUTF8String(0, subject));
    EXPECT_EQ("Stored subject"_ns, subject);
  }
  CheckStoredKeys({survivor, removed});
  CheckRemovalProperty(removed, true);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(removed));
  EXPECT_EQ(1u, callbacks);
  CheckStoredKeys({survivor});
  CheckRemovalProperty(removed, false);
}

TEST_F(DeliveryCoreMessageExistence, WarmHeaderDeletionUsesStoredMembership) {
  nsMsgKey survivor, removed;
  ASSERT_EQ(NS_OK, Add("survivor@invalid"_ns, survivor));
  ASSERT_EQ(NS_OK, Add("removed@invalid"_ns, removed));
  ASSERT_NE(survivor, removed);
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessage(removed, getter_AddRefs(header)));
  ASSERT_TRUE(header);
  nsMsgKey thread = 0;
  ASSERT_EQ(NS_OK, header->GetThreadId(&thread));
  ASSERT_NE(0u, thread);
  ASSERT_NO_FATAL_FAILURE(CheckHeader(header, removed, thread));
  ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({survivor, removed}));
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(removed));
  ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({survivor}));
  bool exists = true;
  EXPECT_EQ(NS_OK, mCore->MessageDB().MessageExists(removed, exists));
  EXPECT_FALSE(exists);
  exists = false;
  EXPECT_EQ(NS_OK, mCore->MessageDB().MessageExists(survivor, exists));
  EXPECT_TRUE(exists);
  CheckHeader(header, removed, thread);
}

TEST_F(DeliveryCoreMessageExistence, ColdRowDeletionUsesStoredMembership) {
  nsMsgKey survivor, removed;
  ASSERT_EQ(NS_OK, Add("survivor@invalid"_ns, survivor));
  ASSERT_EQ(NS_OK, Add("removed@invalid"_ns, removed));
  ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({survivor, removed}));
  ASSERT_TRUE(Stop());
  ASSERT_NO_FATAL_FAILURE(Start());
  // A new MessageDatabase has not loaded any header fields.
  bool exists = false;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(removed, exists));
  ASSERT_TRUE(exists);
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(removed));
  ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({survivor}));
  exists = true;
  EXPECT_EQ(NS_OK, mCore->MessageDB().MessageExists(removed, exists));
  EXPECT_FALSE(exists);
  exists = false;
  EXPECT_EQ(NS_OK, mCore->MessageDB().MessageExists(survivor, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreMessageExistence,
       RemovalCallbackSeesAbsentRowAndReadableHeader) {
  nsMsgKey survivor, removed;
  ASSERT_EQ(NS_OK, Add("survivor@invalid"_ns, survivor));
  ASSERT_EQ(NS_OK, Add("removed@invalid"_ns, removed));
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessage(removed, getter_AddRefs(header)));
  ASSERT_TRUE(header);
  nsMsgKey thread = 0;
  ASSERT_EQ(NS_OK, header->GetThreadId(&thread));
  ASSERT_NE(0u, thread);
  ASSERT_NO_FATAL_FAILURE(CheckHeader(header, removed, thread));
  uint32_t callbacks = 0;
  RefPtr<MessageExistenceRemovedObserver> observer =
      new MessageExistenceRemovedObserver([&](Message* message,
                                              uint32_t oldFlags) {
        ++callbacks;
        EXPECT_EQ(uint32_t(nsMsgMessageFlags::Read | nsMsgMessageFlags::Marked),
                  oldFlags);
        bool exists = true;
        EXPECT_EQ(NS_OK, mCore->MessageDB().MessageExists(removed, exists));
        EXPECT_FALSE(exists);
        CheckStoredKeys({survivor});
        CheckHeader(message, removed, thread);
        exists = false;
        EXPECT_EQ(NS_OK, mCore->MessageDB().MessageExists(survivor, exists));
        EXPECT_TRUE(exists);
      });
  mCore->MessageDB().AddMessageListener(observer);
  auto cleanup = MakeScopeExit(
      [&] { mCore->MessageDB().RemoveMessageListener(observer); });
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(removed));
  EXPECT_EQ(1u, callbacks);
  CheckStoredKeys({survivor});
}

TEST_F(DeliveryCoreMessageExistence, WarmHeaderPrepareFailurePropagates) {
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("warm@invalid"_ns, key));
  nsAutoCString subject;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageSubject(key, subject));
  ASSERT_EQ("Stored subject"_ns, subject);
  CheckPrepareFailure(key);
}

TEST_F(DeliveryCoreMessageExistence, ColdRowPrepareFailurePropagates) {
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("cold@invalid"_ns, key));
  ASSERT_TRUE(Stop());
  ASSERT_NO_FATAL_FAILURE(Start());
  CheckPrepareFailure(key);
}

TEST_F(DeliveryCoreMessageExistence, WarmHeaderStepFailurePropagates) {
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("warm@invalid"_ns, key));
  nsAutoCString subject;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageSubject(key, subject));
  ASSERT_EQ("Stored subject"_ns, subject);
  CheckStepFailure(key);
}

TEST_F(DeliveryCoreMessageExistence, ColdRowStepFailurePropagates) {
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("cold@invalid"_ns, key));
  ASSERT_TRUE(Stop());
  ASSERT_NO_FATAL_FAILURE(Start());
  CheckStepFailure(key);
}

TEST_F(DISABLED_DeliveryCoreMessageExistence,
       ThreadKeysPreserveMembershipAndDepthFirstOrder) {
  nsMsgKey root, child, grandchild, peer, excluded, foreign, unrelated;
  ASSERT_EQ(NS_OK, Add("thread-root@invalid"_ns, root));
  ASSERT_EQ(NS_OK, Add("thread-child@invalid"_ns, child));
  ASSERT_EQ(NS_OK, Add("thread-grandchild@invalid"_ns, grandchild));
  ASSERT_EQ(NS_OK, Add("thread-peer@invalid"_ns, peer));
  ASSERT_EQ(NS_OK, Add("thread-excluded@invalid"_ns, excluded));
  ASSERT_EQ(NS_OK, Add("thread-foreign@invalid"_ns, foreign));
  ASSERT_EQ(NS_OK, Add("thread-unrelated@invalid"_ns, unrelated));
  nsMsgKey thread, otherThread;
  ASSERT_NO_FATAL_FAILURE(ReadStoredThread(root, thread));
  ASSERT_NO_FATAL_FAILURE(ReadStoredThread(unrelated, otherThread));
  ASSERT_NE(thread, otherThread);
  uint64_t otherFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertRoot("other-thread-folder"_ns,
                                                &otherFolder));
  ASSERT_NO_FATAL_FAILURE(SetThreadLocation(child, thread, root, mFolder));
  ASSERT_NO_FATAL_FAILURE(
      SetThreadLocation(grandchild, thread, child, mFolder));
  ASSERT_NO_FATAL_FAILURE(SetThreadLocation(peer, thread, root, mFolder));
  ASSERT_NO_FATAL_FAILURE(
      SetThreadLocation(excluded, otherThread, root, mFolder));
  ASSERT_NO_FATAL_FAILURE(
      SetThreadLocation(foreign, thread, root, otherFolder));
  nsTArray<nsMsgKey> keys{77, 88};
  ASSERT_EQ(NS_OK, ThreadKeys(mFolder, 0, thread, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{root, child, grandchild, peer}), keys);
  ASSERT_EQ(NS_OK, ThreadKeys(mFolder, child, thread, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{child, grandchild}), keys);
  ASSERT_EQ(NS_OK, ThreadKeys(otherFolder, 0, thread, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{foreign}), keys);
  ASSERT_NO_FATAL_FAILURE(CheckStoredKeys(
      {root, child, grandchild, peer, excluded, foreign, unrelated}));
}

TEST_F(DISABLED_DeliveryCoreMessageExistence, EmptyThreadKeysReplaceOutput) {
  nsMsgKey key, thread;
  ASSERT_EQ(NS_OK, Add("thread-control@invalid"_ns, key));
  ASSERT_NO_FATAL_FAILURE(ReadStoredThread(key, thread));
  uint64_t emptyFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertRoot("empty-thread-folder"_ns,
                                                &emptyFolder));
  nsTArray<nsMsgKey> keys{77, 88};
  ASSERT_EQ(NS_OK, ThreadKeys(emptyFolder, 0, thread, keys));
  EXPECT_TRUE(keys.IsEmpty());
  ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({key}));
}

TEST_F(DISABLED_DeliveryCoreMessageExistence, ThreadKeysFolderBindError) {
  ASSERT_NO_FATAL_FAILURE(CheckThreadBindFailure(
      "SELECT :parent AS id WHERE :threadId > 0"_ns, "folderId"_ns));
}

TEST_F(DISABLED_DeliveryCoreMessageExistence, ThreadKeysParentBindError) {
  ASSERT_NO_FATAL_FAILURE(CheckThreadBindFailure(
      "SELECT :folderId AS id WHERE :threadId > 0"_ns, "parent"_ns));
}

TEST_F(DISABLED_DeliveryCoreMessageExistence, ThreadKeysThreadBindError) {
  ASSERT_NO_FATAL_FAILURE(CheckThreadBindFailure(
      "SELECT :folderId AS id WHERE :parent >= 0"_ns, "threadId"_ns));
}

TEST_F(DISABLED_DeliveryCoreMessageExistence, ThreadKeysPrepareError) {
  nsMsgKey key, thread;
  ASSERT_EQ(NS_OK, Add("thread-control@invalid"_ns, key));
  ASSERT_NO_FATAL_FAILURE(ReadStoredThread(key, thread));
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL(
                "ALTER TABLE messages RENAME TO hidden_thread_messages"_ns));
  nsTArray<nsMsgKey> keys{77, 88};
  EXPECT_EQ(NS_ERROR_FAILURE, ThreadKeys(mFolder, 0, thread, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{77, 88}), keys);
  ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({key}, "hidden_thread_messages"_ns));
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL(
                "ALTER TABLE hidden_thread_messages RENAME TO messages"_ns));
  ASSERT_EQ(NS_OK, ThreadKeys(mFolder, 0, thread, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{key}), keys);
}

TEST_F(DISABLED_DeliveryCoreMessageExistence, ThreadKeysFirstStepError) {
  ASSERT_NO_FATAL_FAILURE(CheckThreadStepFailure(false));
}

TEST_F(DISABLED_DeliveryCoreMessageExistence, ThreadKeysErrorAfterSeedRow) {
  ASSERT_NO_FATAL_FAILURE(CheckThreadStepFailure(true));
}

TEST_F(DISABLED_DeliveryCoreMessageExistence,
       ConversationFilterRejectsThreadReadFailure) {
  nsMsgKey key, other, thread, otherThread;
  ASSERT_EQ(NS_OK, Add("conversation-error@invalid"_ns, key));
  ASSERT_EQ(NS_OK, Add("conversation-control@invalid"_ns, other));
  ASSERT_NO_FATAL_FAILURE(ReadStoredThread(key, thread));
  ASSERT_NO_FATAL_FAILURE(ReadStoredThread(other, otherThread));
  ASSERT_NE(thread, otherThread);
  ASSERT_NE(nsMsgKey_None, thread);
  RefPtr<Message> matching = new Message(key);
  RefPtr<Message> excluded = new Message(other);
  ConversationFilter filter(thread);
  EXPECT_TRUE(filter.Matches(matching, mFolder));
  EXPECT_FALSE(filter.Matches(excluded, mFolder));

  RefPtr<ConversationThreadReadFault> fault =
      new ConversationThreadReadFault(mFolder, thread);
  nsMsgKey written = nsMsgKey_None;
  EXPECT_EQ(NS_ERROR_FAILURE, fault->GetThreadId(&written));
  EXPECT_EQ(thread, written);
  EXPECT_EQ(1u, fault->mCalls);
  EXPECT_FALSE(filter.Matches(fault, mFolder));
  EXPECT_EQ(2u, fault->mCalls);

  EXPECT_TRUE(filter.Matches(matching, mFolder));
  EXPECT_FALSE(filter.Matches(excluded, mFolder));
  ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({key, other}));
}

TEST_F(DeliveryCoreMessageExistence, FolderKeysReturnStoredMembership) {
  nsMsgKey first, second;
  ASSERT_EQ(NS_OK, Add("folder-first@invalid"_ns, first));
  ASSERT_EQ(NS_OK, Add("folder-second@invalid"_ns, second));
  nsTArray<nsMsgKey> keys{77, 88};
  ASSERT_EQ(NS_OK, FolderKeys(mFolder, keys));
  keys.Sort();
  nsTArray<nsMsgKey> expected{first, second};
  expected.Sort();
  EXPECT_EQ(expected, keys);
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(first));
  ASSERT_EQ(NS_OK, FolderKeys(mFolder, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{second}), keys);
  ASSERT_EQ(NS_OK, FolderKeys(0, keys));
  EXPECT_TRUE(keys.IsEmpty());
  ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({second}));
}

TEST_F(DeliveryCoreMessageExistence, FolderKeysBindErrorsPreserveOutput) {
  ASSERT_NO_FATAL_FAILURE(CheckFolderKeysBindFailure());
}

TEST_F(DeliveryCoreMessageExistence, FolderKeysStepErrorsPreserveOutput) {
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("folder-error@invalid"_ns, key));
  mFault = new MessageExistenceReadFault();
  ASSERT_EQ(NS_OK,
            Connection()->CreateFunction("folder_key_fault"_ns, 1, mFault));
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL(
                "CREATE TEMP VIEW messages AS SELECT "
                "folder_key_fault(id) AS id, folderId FROM main.messages"_ns));
  nsTArray<nsMsgKey> keys{77, 88};
  EXPECT_EQ(NS_ERROR_FAILURE, FolderKeys(mFolder, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{77, 88}), keys);
  EXPECT_EQ(1u, mFault->mCalls);
  EXPECT_EQ(int64_t(key), mFault->mLastKey);
  ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({key}));
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL("DROP VIEW temp.messages"_ns));
  ASSERT_EQ(NS_OK, Connection()->RemoveFunction("folder_key_fault"_ns));
  ASSERT_EQ(NS_OK, FolderKeys(mFolder, keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{key}), keys);
}

TEST_F(DeliveryCoreMessageExistence,
       CountsUseStoredFolderMembershipAndReadFlag) {
  nsMsgKey read, unread;
  ASSERT_EQ(NS_OK, Add("count-read@invalid"_ns, read));
  ASSERT_EQ(NS_OK, Add("count-unread@invalid"_ns, unread));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageFlag(
                       unread, nsMsgMessageFlags::Read, false));
  uint64_t total = 99, folder = 99, unreadCount = 99;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&total));
  ASSERT_EQ(NS_OK, FolderCount(mFolder, false, folder));
  ASSERT_EQ(NS_OK, FolderCount(mFolder, true, unreadCount));
  EXPECT_EQ(2u, total);
  EXPECT_EQ(2u, folder);
  EXPECT_EQ(1u, unreadCount);
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(read));
  ASSERT_EQ(NS_OK, FolderCount(mFolder, false, folder));
  EXPECT_EQ(1u, folder);
  ASSERT_EQ(NS_OK, FolderCount(mFolder, true, unreadCount));
  EXPECT_EQ(1u, unreadCount);
  ASSERT_EQ(NS_OK, FolderCount(0, false, folder));
  EXPECT_EQ(0u, folder);
  ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({unread}));
}

TEST_F(DeliveryCoreMessageExistence, CountStepErrorsPreserveOutputs) {
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("count-error@invalid"_ns, key));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageFlag(
                       key, nsMsgMessageFlags::Read, false));
  uint64_t before = 99;
  ASSERT_EQ(NS_OK, FolderCount(mFolder, true, before));
  ASSERT_EQ(1u, before);
  mFault = new MessageExistenceReadFault();
  ASSERT_EQ(NS_OK,
            Connection()->CreateFunction("count_read_fault"_ns, 1, mFault));
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL(
                "CREATE TEMP VIEW messages AS SELECT * FROM main.messages "
                "WHERE count_read_fault(id)"_ns));
  uint64_t total = 77, folder = 88, unread = 99;
  EXPECT_EQ(NS_ERROR_FAILURE, mCore->MessageDB().GetTotalCount(&total));
  EXPECT_EQ(77u, total);
  EXPECT_EQ(NS_ERROR_FAILURE, FolderCount(mFolder, false, folder));
  EXPECT_EQ(88u, folder);
  EXPECT_EQ(NS_ERROR_FAILURE, FolderCount(mFolder, true, unread));
  EXPECT_EQ(99u, unread);
  EXPECT_GE(mFault->mCalls, 3u);
  ASSERT_NO_FATAL_FAILURE(CheckStoredKeys({key}));
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL("DROP VIEW temp.messages"_ns));
  ASSERT_EQ(NS_OK, Connection()->RemoveFunction("count_read_fault"_ns));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetTotalCount(&total));
  EXPECT_EQ(1u, total);
  ASSERT_EQ(NS_OK, FolderCount(mFolder, true, unread));
  EXPECT_EQ(1u, unread);
}

TEST_F(DeliveryCoreMessageExistence,
       PublishedMembershipDoesNotReopenRetiredCore) {
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("membership@invalid"_ns, key));
  RefPtr<MessageDatabase> retired = &mCore->MessageDB();
  bool exists = false;
  ASSERT_EQ(NS_OK, retired->MessageExists(key, exists));
  EXPECT_TRUE(exists);
  ASSERT_TRUE(Stop());
  EXPECT_FALSE(Connection());
  exists = false;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, retired->MessageExists(key, exists));
  EXPECT_FALSE(exists);
  EXPECT_FALSE(Connection());
  ASSERT_NO_FATAL_FAILURE(Start());
  exists = true;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, retired->MessageExists(key, exists));
  EXPECT_TRUE(exists);
  exists = false;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_TRUE(exists);
}

TEST_F(DeliveryCoreMessageExistence,
       PublishedMembershipReadsCallerTransaction) {
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("membership@invalid"_ns, key));
  auto& db = mCore->MessageDB();
  RawHdr raw;
  nsMsgKey staged;
  ASSERT_EQ(NS_OK, db.StageMessage(mFolder, raw, &staged));
  bool exists = true;
  ASSERT_EQ(NS_OK, db.MessageExists(staged, exists));
  EXPECT_FALSE(exists);
  ASSERT_EQ(NS_OK, db.MessageExists(nsMsgKey_None, exists));
  EXPECT_FALSE(exists);
  ASSERT_EQ(NS_OK, db.MessageExists(0, exists));
  EXPECT_FALSE(exists);
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, Connection()->RollbackTransaction()); });
  nsAutoCString sql("DELETE FROM messages WHERE id = ");
  sql.AppendInt(key);
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(sql));
  exists = true;
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_FALSE(exists);
  bool active = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  rollback.release();
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, db.RemoveMessage(key));
  ASSERT_EQ(NS_OK, db.MessageExists(key, exists));
  EXPECT_FALSE(exists);
}

TEST_F(DeliveryCoreMessageExistence,
       PublishedMembershipReadFailureKeepsOutputAndCallerTransaction) {
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("membership-fault@invalid"_ns, key));
  ASSERT_NO_FATAL_FAILURE(InstallStepFault());
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, Connection()->RollbackTransaction()); });
  bool exists = false;
  EXPECT_EQ(NS_ERROR_FAILURE, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_FALSE(exists);
  EXPECT_EQ(1u, mFault->mCalls);
  EXPECT_EQ(int64_t(key), mFault->mLastKey);
  exists = true;
  EXPECT_EQ(NS_ERROR_FAILURE, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_TRUE(exists);
  EXPECT_EQ(2u, mFault->mCalls);
  bool active = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  rollback.release();
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL("DROP VIEW temp.messages"_ns));
  ASSERT_EQ(NS_OK, Connection()->RemoveFunction("delivery_existence_fault"_ns));
  exists = false;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_TRUE(exists);
}

}  // namespace
}  // namespace mozilla::mailnews
