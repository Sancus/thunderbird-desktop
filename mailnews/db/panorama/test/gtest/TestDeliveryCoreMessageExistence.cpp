/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <functional>
#include <utility>

#include "DatabaseCore.h"
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
#include "nsMsgMessageFlags.h"
#include "nsServiceManagerUtils.h"
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
        nsAutoCString retained;
        EXPECT_EQ(NS_OK, mProfile->GetNativePath(retained));
        RecordProperty("retained_profile", retained.get());
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
    EXPECT_EQ(nsMsgMessageFlags::Read | nsMsgMessageFlags::Marked, flags);
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
       WarmHeaderDeletionUsesStoredMembership) {
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

TEST_F(DISABLED_DeliveryCoreMessageExistence,
       ColdRowDeletionUsesStoredMembership) {
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

TEST_F(DISABLED_DeliveryCoreMessageExistence,
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
        EXPECT_EQ(nsMsgMessageFlags::Read | nsMsgMessageFlags::Marked,
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

TEST_F(DISABLED_DeliveryCoreMessageExistence,
       WarmHeaderPrepareFailurePropagates) {
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("warm@invalid"_ns, key));
  nsAutoCString subject;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageSubject(key, subject));
  ASSERT_EQ("Stored subject"_ns, subject);
  CheckPrepareFailure(key);
}

TEST_F(DISABLED_DeliveryCoreMessageExistence, ColdRowPrepareFailurePropagates) {
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("cold@invalid"_ns, key));
  ASSERT_TRUE(Stop());
  ASSERT_NO_FATAL_FAILURE(Start());
  CheckPrepareFailure(key);
}

TEST_F(DISABLED_DeliveryCoreMessageExistence, WarmHeaderStepFailurePropagates) {
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("warm@invalid"_ns, key));
  nsAutoCString subject;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageSubject(key, subject));
  ASSERT_EQ("Stored subject"_ns, subject);
  CheckStepFailure(key);
}

TEST_F(DISABLED_DeliveryCoreMessageExistence, ColdRowStepFailurePropagates) {
  nsMsgKey key;
  ASSERT_EQ(NS_OK, Add("cold@invalid"_ns, key));
  ASSERT_TRUE(Stop());
  ASSERT_NO_FATAL_FAILURE(Start());
  CheckStepFailure(key);
}

}  // namespace
}  // namespace mozilla::mailnews
