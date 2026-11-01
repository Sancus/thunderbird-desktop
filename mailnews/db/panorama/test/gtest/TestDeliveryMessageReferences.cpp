/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsIMsgOfflineImapOperation.h"
#include <cstddef>
#include <cstdint>
#include <functional>
#include <type_traits>

#include "DatabaseCore.h"
#include "DetachedMsgHdr.h"
#include "Message.h"
#include "MessageDatabase.h"
#include "PerFolderDatabase.h"
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
#include "nsComponentManagerUtils.h"
#include "nsDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "nsIEventTarget.h"
#include "nsIDBChangeListener.h"
#include "nsIFile.h"
#include "nsIInterfaceRequestorUtils.h"
#include "nsIMsgHdr.h"
#include "nsIProperties.h"
#include "nsIVariant.h"
#include "nsMsgMessageFlags.h"
#include "nsServiceManagerUtils.h"
#include "nsString.h"
#include "nsThreadUtils.h"
#include "nsXPCOMCID.h"

namespace mozilla::mailnews {
namespace {

constexpr uint16_t kCountCanary = 0xa5c3;
struct alignas(int64_t) GuardedCount {
  uint16_t value;
  volatile uint16_t canary[3];
};
static_assert(std::is_standard_layout_v<GuardedCount>);
static_assert(offsetof(GuardedCount, canary) == sizeof(uint16_t));
static_assert(sizeof(GuardedCount) == sizeof(int64_t));

constexpr uint32_t kHeaderUint32Sentinel = 0x6ac13f27;
constexpr uint32_t kHeaderUint32Canary = 0xa5c39e71;
struct alignas(int64_t) GuardedHeaderUint32 {
  uint32_t value;
  volatile uint32_t canary;
};
static_assert(std::is_standard_layout_v<GuardedHeaderUint32>);
static_assert(offsetof(GuardedHeaderUint32, canary) == sizeof(uint32_t));
static_assert(sizeof(GuardedHeaderUint32) == sizeof(int64_t));

void CheckHeaderUint32Output(nsIMsgDBHdr* header, nsresult expectedResult,
                             uint32_t expectedValue) {
  GuardedHeaderUint32 output{kHeaderUint32Sentinel, kHeaderUint32Canary};
  EXPECT_EQ(expectedResult,
            header->GetUint32Property("delivery.uint32", &output.value));
  EXPECT_EQ(expectedValue, output.value);
  EXPECT_EQ(kHeaderUint32Canary, static_cast<uint32_t>(output.canary));
}

}  // namespace

class DeliveryMessageReferencesFaultWitness final : public mozIStorageFunction {
 public:
  NS_DECL_ISUPPORTS
  explicit DeliveryMessageReferencesFaultWitness(bool fail = false)
      : mFail(fail) {}
  uint32_t mCalls = 0;
  int64_t mLastKey = 0;
  NS_IMETHOD OnFunctionCall(mozIStorageValueArray* args,
                            nsIVariant** result) override {
    ++mCalls;
    MOZ_TRY(args->GetInt64(0, &mLastKey));
    if (mFail) {
      return NS_ERROR_FAILURE;
    }
    nsCOMPtr<nsIWritableVariant> value =
        do_CreateInstance("@mozilla.org/variant;1");
    NS_ENSURE_STATE(value);
    MOZ_TRY(value->SetAsInt32(0));
    nsCOMPtr<nsIVariant> returned = value;
    returned.forget(result);
    return NS_OK;
  }

 private:
  ~DeliveryMessageReferencesFaultWitness() = default;
  bool mFail;
};
NS_IMPL_ISUPPORTS(DeliveryMessageReferencesFaultWitness, mozIStorageFunction)

class DeliveryMessageReferences : public testing::Test {
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
    // Keep failed fixtures outside the harness-owned profile's cleanup tree.
    ASSERT_EQ(NS_OK,
              NS_GetSpecialDirectory(NS_OS_TEMP_DIR, getter_AddRefs(mProfile)));
    ASSERT_EQ(NS_OK, mProfile->Append(u"delivery-message-references"_ns));
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
    mCore = DatabaseCore::GetInstanceForService();
    ASSERT_EQ(NS_OK, mCore->Startup());
    ASSERT_TRUE(Connection());
    nsCOMPtr<nsIFile> actualFile;
    ASSERT_EQ(NS_OK, Connection()->GetDatabaseFile(getter_AddRefs(actualFile)));
    bool sameFile = false;
    ASSERT_EQ(NS_OK, mFile->Equals(actualFile, &sameFile));
    ASSERT_TRUE(sameFile);
    uint64_t root;
    ASSERT_EQ(NS_OK,
              mCore->FolderDB().InsertRoot("native-references"_ns, &root));
    ASSERT_EQ(NS_OK,
              mCore->FolderDB().InsertFolder(root, "Inbox"_ns, &mFolder));
  }

  void TearDown() override {
    mHeader = nullptr;
    bool drained = Stop();
    mWitness = nullptr;
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

  bool Stop() {
    if (!mCore) {
      return true;
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
    return drained;
  }

  static bool WaitForClose(nsIEventTarget* target) {
    sCloseCompleted = false;
    // Observe queues AsyncClose before this barrier, with no intervening spin.
    nsresult rv = target->Dispatch(
        NS_NewRunnableFunction(
            "DeliveryMessageReferencesCloseBarrier",
            [] {
              MOZ_ALWAYS_SUCCEEDS(NS_DispatchToMainThread(
                  NS_NewRunnableFunction("DeliveryMessageReferencesClosed",
                                         [] { sCloseCompleted = true; })));
            }),
        NS_DISPATCH_NORMAL);
    EXPECT_EQ(NS_OK, rv);
    if (NS_FAILED(rv)) {
      return false;
    }
    bool drained = SpinEventLoopUntil("DeliveryMessageReferencesClosed"_ns,
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

  void Create(const nsTArray<nsCString>& references) {
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().AddMessage(
                  mFolder, "child@invalid"_ns, references, 123456, "sender"_ns,
                  "recipient"_ns, EmptyCString(), EmptyCString(), "subject"_ns,
                  0, EmptyCString(), 0, &mKey));
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetMessage(mKey, getter_AddRefs(mHeader)));
    ASSERT_TRUE(mHeader);
  }

  nsresult StoreParentForBridge(nsMsgKey key, nsMsgKey thread,
                                nsMsgKey parent) {
    nsCOMPtr<mozIStorageStatement> statement;
    MOZ_TRY(Connection()->CreateStatement(
        "UPDATE messages SET threadId=:thread, threadParent=:parent WHERE id=:id"_ns,
        getter_AddRefs(statement)));
    MOZ_TRY(statement->BindInt64ByName("id"_ns, key));
    MOZ_TRY(statement->BindInt64ByName("thread"_ns, thread));
    MOZ_TRY(statement->BindInt64ByName("parent"_ns, parent));
    return statement->Execute();
  }

  void PrepareParentChange(MessageThreadBatch& batch) {
    ASSERT_NO_FATAL_FAILURE(Create({"future-parent@invalid"_ns}));
    CapturedMessage before;
    ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(mKey, before));
    ASSERT_EQ(0u, before.threadParent);
    ASSERT_EQ(mKey, before.threadId);
    nsMsgKey parent;
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().AddMessage(
                  mFolder, "future-parent@invalid"_ns, {}, 123457, "sender"_ns,
                  "recipient"_ns, EmptyCString(), EmptyCString(), "parent"_ns,
                  0, EmptyCString(), 0, &parent));
    // Model the producer's committed derived fields, not arrival grouping.
    ASSERT_EQ(NS_OK, StoreParentForBridge(mKey, parent, parent));
    CapturedMessage after, publication;
    ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(mKey, after));
    ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(parent, publication));
    ASSERT_EQ(parent, after.threadParent);
    ASSERT_EQ(parent, after.threadId);
    batch.batchId = 1;
    batch.publicationKey = parent;
    batch.notifyLegacy = false;
    batch.before.AppendElement(before);
    batch.after.AppendElement(after);
    batch.after.AppendElement(publication);
    batch.changedKeys.AppendElement(mKey);
  }

  void CheckParentBridgeCount(int64_t expected) {
    nsCOMPtr<mozIStorageStatement> statement;
    ASSERT_EQ(NS_OK,
              Connection()->CreateStatement(
                  "SELECT COUNT(*) FROM messages WHERE folderId=:folder"_ns,
                  getter_AddRefs(statement)));
    ASSERT_EQ(NS_OK, statement->BindInt64ByName("folder"_ns, mFolder));
    bool more;
    ASSERT_EQ(NS_OK, statement->ExecuteStep(&more));
    ASSERT_TRUE(more);
    int64_t count;
    ASSERT_EQ(NS_OK, statement->GetInt64(0, &count));
    EXPECT_EQ(expected, count);
  }

  void CreateOversized() {
    nsTArray<nsCString> tokens;
    for (uint32_t i = 0; i < 65535; ++i) {
      tokens.AppendElement("visible@invalid"_ns);
    }
    tokens.AppendElement("last@invalid"_ns);
    ASSERT_NO_FATAL_FAILURE(Create(tokens));
  }

  void CheckMessageRow(bool expected) {
    nsCOMPtr<mozIStorageStatement> stmt;
    auto cleanup = MakeScopeExit([&] {
      if (stmt) {
        EXPECT_EQ(NS_OK, stmt->Finalize());
      }
    });
    ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                         "SELECT 1 FROM messages WHERE id = :id"_ns,
                         getter_AddRefs(stmt)));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, mKey));
    bool exists = !expected;
    ASSERT_EQ(NS_OK, stmt->ExecuteStep(&exists));
    ASSERT_EQ(expected, exists);
  }

  void MakeUnavailable() {
    ASSERT_NO_FATAL_FAILURE(Create({}));
    // A missing marker is the representation of discarded historical tokens.
    ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "DELETE FROM message_reference_sets"_ns));
    ASSERT_NO_FATAL_FAILURE(CheckMessageRow(true));
  }

  void MakeMissing() {
    ASSERT_NO_FATAL_FAILURE(Create({}));
    ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(mKey));
    ASSERT_NO_FATAL_FAILURE(CheckMessageRow(false));
  }

  void InstallWitness(bool fail = false) {
    mWitness = new DeliveryMessageReferencesFaultWitness(fail);
    ASSERT_EQ(NS_OK, Connection()->CreateFunction(
                         "delivery_references_fault"_ns, 1, mWitness));
  }

  void MakeReadFault() {
    ASSERT_NO_FATAL_FAILURE(Create({"original@invalid"_ns}));
    ASSERT_NO_FATAL_FAILURE(InstallWitness(true));
    ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "CREATE TEMP VIEW message_references AS "
                         "SELECT id, ordinal, delivery_references_fault(id) "
                         "AS token FROM main.message_references"_ns));
    nsCOMPtr<mozIStorageStatement> prepared;
    ASSERT_EQ(NS_OK,
              Connection()->CreateStatement(
                  "SELECT token FROM message_references WHERE id = :id"_ns,
                  getter_AddRefs(prepared)));
    EXPECT_EQ(0u, mWitness->mCalls);
    ASSERT_EQ(NS_OK, prepared->Finalize());
  }

  void MakePropertyReadFault() {
    ASSERT_NO_FATAL_FAILURE(Create({}));
    ASSERT_EQ(NS_OK, mHeader->SetStringProperty("delivery.uint32", "2a"_ns));
    ASSERT_NO_FATAL_FAILURE(InstallWitness(true));
    ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "CREATE TEMP VIEW message_properties AS "
                         "SELECT id, name, delivery_references_fault(id) "
                         "AS value FROM main.message_properties"_ns));
    nsCOMPtr<mozIStorageStatement> prepared;
    ASSERT_EQ(NS_OK,
              Connection()->CreateStatement(
                  "SELECT value FROM message_properties WHERE id = :id"_ns,
                  getter_AddRefs(prepared)));
    ASSERT_EQ(NS_OK, prepared->Finalize());
    EXPECT_EQ(0u, mWitness->mCalls);
  }

  void CheckWitness() {
    ASSERT_TRUE(mWitness);
    EXPECT_EQ(1u, mWitness->mCalls);
    EXPECT_EQ(int64_t(mKey), mWitness->mLastKey);
  }

  void CheckCount(nsresult expectedResult, uint16_t expectedValue) {
    GuardedCount output{1234, {kCountCanary, kCountCanary, kCountCanary}};
    EXPECT_EQ(expectedResult, mHeader->GetNumReferences(&output.value));
    EXPECT_EQ(expectedValue, output.value);
    for (auto canary : output.canary) {
      EXPECT_EQ(kCountCanary, static_cast<uint16_t>(canary));
    }
  }

  void CheckStored(const nsTArray<nsCString>& expected) {
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
                         "SELECT ordinal, token FROM message_references "
                         "WHERE id = :id ORDER BY ordinal"_ns,
                         getter_AddRefs(stmt)));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("id"_ns, mKey));
    nsTArray<nsCString> got;
    bool more;
    while (true) {
      ASSERT_EQ(NS_OK, stmt->ExecuteStep(&more));
      if (!more) {
        break;
      }
      int64_t ordinal;
      ASSERT_EQ(NS_OK, stmt->GetInt64(0, &ordinal));
      EXPECT_EQ(int64_t(got.Length()), ordinal);
      nsCString token;
      ASSERT_EQ(NS_OK, stmt->GetUTF8String(1, token));
      got.AppendElement(token);
    }
    EXPECT_EQ(expected, got);
  }

  void CheckNoTransaction() {
    bool active = true;
    ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
    EXPECT_FALSE(active);
  }

  RefPtr<DatabaseCore> mCore;
  nsCOMPtr<nsIProperties> mDirectories;
  nsCOMPtr<nsIFile> mOldProfile, mProfile, mFile;
  nsCOMPtr<nsIMsgDBHdr> mHeader;
  RefPtr<DeliveryMessageReferencesFaultWitness> mWitness;
  bool mProfileCreated = false;
  bool mDirectoryChanged = false;
  bool mProfileInstalled = false;
  uint64_t mFolder = 0;
  nsMsgKey mKey = nsMsgKey_None;
  static inline bool sCloseCompleted = false;
};

class DeliveryParentChangeListener final : public nsIDBChangeListener {
 public:
  NS_DECL_ISUPPORTS
  struct Change {
    nsMsgKey key, oldParent, newParent;
  };
  nsTArray<Change> changes;
  nsTArray<nsMsgKey> added;
  nsTArray<nsMsgKey> order;
  uint32_t otherChanges = 0;
  PerFolderDatabase* detachFrom = nullptr;

  NS_IMETHOD OnParentChanged(nsMsgKey key, nsMsgKey oldParent,
                             nsMsgKey newParent,
                             nsIDBChangeListener* instigator) override {
    EXPECT_EQ(nullptr, instigator);
    changes.AppendElement(Change{key, oldParent, newParent});
    order.AppendElement(key);
    if (detachFrom) {
      PerFolderDatabase* db = detachFrom;
      detachFrom = nullptr;
      EXPECT_EQ(NS_OK, db->RemoveListener(this));
    }
    return NS_OK;
  }
  NS_IMETHOD OnHdrAdded(nsIMsgDBHdr* header, nsMsgKey parent, int32_t,
                        nsIDBChangeListener* instigator) override {
    EXPECT_EQ(nullptr, instigator);
    EXPECT_EQ(nsMsgKey_None, parent);
    nsMsgKey key = nsMsgKey_None;
    EXPECT_EQ(NS_OK, header->GetMessageKey(&key));
    added.AppendElement(key);
    order.AppendElement(key);
    return NS_OK;
  }
  NS_IMETHOD OnHdrDeleted(nsIMsgDBHdr*, nsMsgKey, int32_t,
                          nsIDBChangeListener*) override {
    ++otherChanges;
    return NS_OK;
  }
  NS_IMETHOD OnHdrFlagsChanged(nsIMsgDBHdr*, uint32_t, uint32_t,
                               nsIDBChangeListener*) override {
    ++otherChanges;
    return NS_OK;
  }
  NS_IMETHOD OnAnnouncerGoingAway(nsIDBChangeAnnouncer*) override {
    ++otherChanges;
    return NS_OK;
  }
  NS_IMETHOD OnReadChanged(nsIDBChangeListener*) override {
    ++otherChanges;
    return NS_OK;
  }
  NS_IMETHOD OnJunkScoreChanged(nsIDBChangeListener*) override {
    ++otherChanges;
    return NS_OK;
  }
  NS_IMETHOD OnHdrPropertyChanged(nsIMsgDBHdr*, const nsACString&, bool,
                                  uint32_t*, nsIDBChangeListener*) override {
    ++otherChanges;
    return NS_OK;
  }
  NS_IMETHOD OnEvent(nsIMsgDatabase*, const char*) override {
    ++otherChanges;
    return NS_OK;
  }

 private:
  ~DeliveryParentChangeListener() = default;
};
NS_IMPL_ISUPPORTS(DeliveryParentChangeListener, nsIDBChangeListener)

class DeliveryEarlyMutationListener final : public MessageListener {
 public:
  NS_DECL_ISUPPORTS
  std::function<void(const CapturedMessage&, Message*)> publication;
  std::function<void(const MessageBodyState&)> body;
  void OnMessageAdded(Message*) override {}
  void OnMessageRemoved(Message*, uint32_t) override {}
  void OnMessageFlagsChanged(nsIMsgDBHdr*, Message*, uint32_t,
                             uint32_t) override {}
  void OnMessageTagsChanged(nsIMsgDBHdr*, Message*, const nsACString&,
                            const nsACString&) override {}
  void OnMessagePublishedCaptured(const CapturedMessage& after, Message* live,
                                  bool) override {
    if (publication) {
      publication(after, live);
    }
  }
  void OnMessageBodyChangedCaptured(const CapturedMessage&,
                                    const CapturedMessage&, nsIMsgDBHdr*,
                                    Message*, const MessageBodyState&,
                                    const MessageBodyState& after) override {
    if (body) {
      body(after);
    }
  }

 private:
  ~DeliveryEarlyMutationListener() = default;
};
NS_IMPL_ISUPPORTS(DeliveryEarlyMutationListener, nsISupports)

class DeliveryCapturedLegacyListener final : public nsIDBChangeListener {
 public:
  NS_DECL_ISUPPORTS
  explicit DeliveryCapturedLegacyListener(PerFolderDatabase* db) : mDB(db) {}
  struct Event {
    char kind;
    nsMsgKey key, parent;
    uint32_t oldFlags, flags, liveFlags;
    nsCString tags;
    nsTArray<nsMsgKey> newKeys;
  };
  nsTArray<Event> events;
  uint32_t otherChanges = 0;
  bool closeOnParent = false;
  nsresult Record(char kind, nsIMsgDBHdr* header, nsMsgKey parent,
                  uint32_t oldFlags, uint32_t flags) {
    Event event{kind, nsMsgKey_None, parent, oldFlags, flags, 0, {}, {}};
    MOZ_TRY(header->GetMessageKey(&event.key));
    MOZ_TRY(header->GetFlags(&event.liveFlags));
    MOZ_TRY(mDB->GetNewList(event.newKeys));
    if (kind == 'T') {
      MOZ_TRY(header->GetStringProperty("keywords", event.tags));
    }
    events.AppendElement(std::move(event));
    return NS_OK;
  }
  NS_IMETHOD OnHdrAdded(nsIMsgDBHdr* header, nsMsgKey parent, int32_t flags,
                        nsIDBChangeListener* instigator) override {
    EXPECT_EQ(nullptr, instigator);
    return Record('A', header, parent, 0, flags);
  }
  NS_IMETHOD OnHdrDeleted(nsIMsgDBHdr* header, nsMsgKey parent, int32_t flags,
                          nsIDBChangeListener* instigator) override {
    EXPECT_EQ(nullptr, instigator);
    return Record('D', header, parent, flags, flags);
  }
  NS_IMETHOD OnHdrFlagsChanged(nsIMsgDBHdr* header, uint32_t oldFlags,
                               uint32_t flags,
                               nsIDBChangeListener* instigator) override {
    EXPECT_EQ(nullptr, instigator);
    return Record('F', header, nsMsgKey_None, oldFlags, flags);
  }
  NS_IMETHOD OnHdrPropertyChanged(nsIMsgDBHdr* header,
                                  const nsACString& property, bool preChange,
                                  uint32_t*,
                                  nsIDBChangeListener* instigator) override {
    EXPECT_EQ("keywords"_ns, property);
    EXPECT_FALSE(preChange);
    EXPECT_EQ(nullptr, instigator);
    return Record('T', header, nsMsgKey_None, 0, 0);
  }
  NS_IMETHOD OnParentChanged(nsMsgKey, nsMsgKey, nsMsgKey,
                             nsIDBChangeListener*) override {
    ++otherChanges;
    return closeOnParent ? mDB->ForceClosed() : NS_OK;
  }
  NS_IMETHOD OnAnnouncerGoingAway(nsIDBChangeAnnouncer*) override {
    ++otherChanges;
    return NS_OK;
  }
  NS_IMETHOD OnReadChanged(nsIDBChangeListener*) override {
    ++otherChanges;
    return NS_OK;
  }
  NS_IMETHOD OnJunkScoreChanged(nsIDBChangeListener*) override {
    ++otherChanges;
    return NS_OK;
  }
  NS_IMETHOD OnEvent(nsIMsgDatabase*, const char*) override {
    ++otherChanges;
    return NS_OK;
  }

 private:
  ~DeliveryCapturedLegacyListener() = default;
  PerFolderDatabase* mDB;
};
NS_IMPL_ISUPPORTS(DeliveryCapturedLegacyListener, nsIDBChangeListener)

namespace {

using DISABLED_DeliveryMessageReferences = DeliveryMessageReferences;

using DeliveryDetachedThreadIdentity = DeliveryMessageReferences;

constexpr uint32_t kThreadIdCanary = 0xa53c7e19;
struct alignas(uint64_t) GuardedThreadId {
  nsMsgKey value;
  volatile uint32_t canary;
};
static_assert(std::is_standard_layout_v<GuardedThreadId>);
static_assert(std::is_unsigned_v<nsMsgKey>);
static_assert(sizeof(nsMsgKey) == sizeof(uint32_t));
static_assert(offsetof(GuardedThreadId, canary) == sizeof(nsMsgKey));
static_assert(sizeof(GuardedThreadId) == sizeof(uint64_t));

void CheckDetachedThreadId(nsIMsgDBHdr* header, nsMsgKey expected) {
  GuardedThreadId output{0x31415926, kThreadIdCanary};
  EXPECT_EQ(NS_OK, header->GetThreadId(&output.value));
  EXPECT_EQ(expected, output.value);
  EXPECT_EQ(kThreadIdCanary, static_cast<uint32_t>(output.canary));
}

TEST_F(DeliveryDetachedThreadIdentity, DefaultIsUnknown) {
  RefPtr<nsIMsgDBHdr> header = new DetachedMsgHdr(mFolder);
  CheckDetachedThreadId(header, nsMsgKey_None);
  nsMsgKey key = 123;
  ASSERT_EQ(NS_OK, header->GetMessageKey(&key));
  EXPECT_EQ(nsMsgKey_None, key);
  bool live = true;
  ASSERT_EQ(NS_OK, header->GetIsLive(&live));
  EXPECT_FALSE(live);
}

TEST_F(DeliveryDetachedThreadIdentity, PositiveIdRoundTrips) {
  RefPtr<nsIMsgDBHdr> header = new DetachedMsgHdr(mFolder);
  ASSERT_EQ(NS_OK, header->SetThreadId(17));
  CheckDetachedThreadId(header, 17);
  nsMsgKey key = 123;
  ASSERT_EQ(NS_OK, header->GetMessageKey(&key));
  EXPECT_EQ(nsMsgKey_None, key);
}

TEST_F(DeliveryDetachedThreadIdentity, FullWidthRepeatedReads) {
  RefPtr<nsIMsgDBHdr> header = new DetachedMsgHdr(mFolder);
  ASSERT_EQ(NS_OK, header->SetThreadId(0xf1234567));
  for (uint32_t i = 0; i < 3; ++i) {
    CheckDetachedThreadId(header, 0xf1234567);
  }
  ASSERT_EQ(NS_OK, header->SetThreadId(0xfffffffe));
  CheckDetachedThreadId(header, 0xfffffffe);
}

TEST_F(DeliveryDetachedThreadIdentity, ZeroAndSentinelRoundTrip) {
  RefPtr<nsIMsgDBHdr> header = new DetachedMsgHdr(mFolder);
  ASSERT_EQ(NS_OK, header->SetThreadId(17));
  ASSERT_EQ(NS_OK, header->SetThreadId(0));
  CheckDetachedThreadId(header, 0);
  ASSERT_EQ(NS_OK, header->SetThreadId(nsMsgKey_None));
  CheckDetachedThreadId(header, nsMsgKey_None);
}

TEST_F(DeliveryDetachedThreadIdentity, NullOutputIsRejected) {
  RefPtr<nsIMsgDBHdr> header = new DetachedMsgHdr(mFolder);
  EXPECT_EQ(NS_ERROR_NULL_POINTER, header->GetThreadId(nullptr));
  ASSERT_EQ(NS_OK, header->SetThreadId(0x80000042));
  EXPECT_EQ(NS_ERROR_NULL_POINTER, header->GetThreadId(nullptr));
  CheckDetachedThreadId(header, 0x80000042);
}

TEST_F(DeliveryDetachedThreadIdentity, IdentityIsIndependentOfMetadata) {
  RefPtr<nsIMsgDBHdr> first = new DetachedMsgHdr(mFolder);
  RefPtr<nsIMsgDBHdr> second = new DetachedMsgHdr(mFolder);
  ASSERT_EQ(NS_OK, first->SetFlags(0x11));
  ASSERT_EQ(NS_OK, first->SetStringProperty("keywords", "label1 label2"_ns));
  ASSERT_EQ(NS_OK, first->SetThreadId(17));
  ASSERT_EQ(NS_OK, second->SetThreadId(23));
  ASSERT_EQ(NS_OK,
            first->SetReferences("<parent@invalid> <missing@invalid>"_ns));
  CheckDetachedThreadId(first, 17);
  ASSERT_EQ(NS_OK, first->SetThreadId(71));
  CheckDetachedThreadId(first, 71);
  CheckDetachedThreadId(second, 23);
  uint32_t flags = 0;
  ASSERT_EQ(NS_OK, first->GetFlags(&flags));
  EXPECT_EQ(0x11u, flags);
  nsAutoCString tags;
  ASSERT_EQ(NS_OK, first->GetStringProperty("keywords", tags));
  EXPECT_EQ("label1 label2"_ns, tags);
}

TEST_F(DISABLED_DeliveryMessageReferences, CountSuccessAssignsOnlyUint16) {
  ASSERT_NO_FATAL_FAILURE(Create({"first@invalid"_ns, ""_ns, "child@invalid"_ns,
                                  "missing@invalid"_ns, "first@invalid"_ns}));
  CheckCount(NS_OK, 3);
}

TEST_F(DISABLED_DeliveryMessageReferences, CountKnownEmptyAssignsZero) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  CheckCount(NS_OK, 0);
}

TEST_F(DISABLED_DeliveryMessageReferences, CountUnavailableLeavesZero) {
  ASSERT_NO_FATAL_FAILURE(MakeUnavailable());
  CheckCount(NS_ERROR_NOT_AVAILABLE, 0);
}

TEST_F(DISABLED_DeliveryMessageReferences, CountMissingLeavesZero) {
  ASSERT_NO_FATAL_FAILURE(MakeMissing());
  CheckCount(NS_ERROR_UNEXPECTED, 0);
}

TEST_F(DISABLED_DeliveryMessageReferences, CountReadStepErrorLeavesZero) {
  ASSERT_NO_FATAL_FAILURE(MakeReadFault());
  CheckCount(NS_ERROR_FAILURE, 0);
  CheckWitness();
}

TEST_F(DISABLED_DeliveryMessageReferences, CountOverflowLeavesZero) {
  ASSERT_NO_FATAL_FAILURE(CreateOversized());
  CheckCount(NS_ERROR_LOSS_OF_SIGNIFICANT_DATA, 0);
}

TEST_F(DISABLED_DeliveryMessageReferences,
       IndexedUnavailablePreservesSentinel) {
  ASSERT_NO_FATAL_FAILURE(MakeUnavailable());
  nsAutoCString output("unavailable-sentinel");
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, mHeader->GetStringReference(0, output));
  EXPECT_EQ("unavailable-sentinel"_ns, output);
}

TEST_F(DISABLED_DeliveryMessageReferences, IndexedMissingPreservesSentinel) {
  ASSERT_NO_FATAL_FAILURE(MakeMissing());
  nsAutoCString output("missing-sentinel");
  EXPECT_EQ(NS_ERROR_UNEXPECTED, mHeader->GetStringReference(0, output));
  EXPECT_EQ("missing-sentinel"_ns, output);
}

TEST_F(DISABLED_DeliveryMessageReferences,
       IndexedReadStepErrorPreservesSentinel) {
  ASSERT_NO_FATAL_FAILURE(MakeReadFault());
  nsAutoCString output("read-error-sentinel");
  EXPECT_EQ(NS_ERROR_FAILURE, mHeader->GetStringReference(0, output));
  EXPECT_EQ("read-error-sentinel"_ns, output);
  CheckWitness();
}

TEST_F(DISABLED_DeliveryMessageReferences, IndexedNegativePreservesSentinel) {
  ASSERT_NO_FATAL_FAILURE(Create({"first@invalid"_ns}));
  nsAutoCString output("negative-index-sentinel");
  EXPECT_EQ(NS_ERROR_ILLEGAL_VALUE, mHeader->GetStringReference(-1, output));
  EXPECT_EQ("negative-index-sentinel"_ns, output);
}

TEST_F(DISABLED_DeliveryMessageReferences, IndexedPastEndPreservesSentinel) {
  ASSERT_NO_FATAL_FAILURE(Create({"first@invalid"_ns}));
  nsAutoCString output("past-end-sentinel");
  EXPECT_EQ(NS_ERROR_ILLEGAL_VALUE, mHeader->GetStringReference(1, output));
  EXPECT_EQ("past-end-sentinel"_ns, output);
}

TEST_F(DISABLED_DeliveryMessageReferences, NullCountKnownOversizedSucceeds) {
  ASSERT_NO_FATAL_FAILURE(CreateOversized());
  EXPECT_EQ(NS_OK, mHeader->GetNumReferences(nullptr));
  nsAutoCString last;
  ASSERT_EQ(NS_OK, mHeader->GetStringReference(65535, last));
  EXPECT_EQ("last@invalid"_ns, last);
}

TEST_F(DISABLED_DeliveryMessageReferences, NullCountUnavailablePropagates) {
  ASSERT_NO_FATAL_FAILURE(MakeUnavailable());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, mHeader->GetNumReferences(nullptr));
}

TEST_F(DISABLED_DeliveryMessageReferences, NullCountMissingPropagates) {
  ASSERT_NO_FATAL_FAILURE(MakeMissing());
  EXPECT_EQ(NS_ERROR_UNEXPECTED, mHeader->GetNumReferences(nullptr));
}

TEST_F(DISABLED_DeliveryMessageReferences, NullCountReadStepErrorPropagates) {
  ASSERT_NO_FATAL_FAILURE(MakeReadFault());
  EXPECT_EQ(NS_ERROR_FAILURE, mHeader->GetNumReferences(nullptr));
  CheckWitness();
}

TEST_F(DISABLED_DeliveryMessageReferences,
       EmbeddedNulStopsDelimitedReferences) {
  ASSERT_NO_FATAL_FAILURE(Create({"old@invalid"_ns}));
  constexpr char raw[] = "<first@invalid>\0<ignored@invalid>";
  const nsDependentCString input(raw, sizeof(raw) - 1);
  ASSERT_EQ(sizeof(raw) - 1, input.Length());
  ASSERT_EQ(NS_OK, mHeader->SetReferences(input));
  CheckCount(NS_OK, 1);
  nsAutoCString first;
  ASSERT_EQ(NS_OK, mHeader->GetStringReference(0, first));
  EXPECT_EQ("first@invalid"_ns, first);
  CheckStored({"first@invalid"_ns});
}

TEST_F(DISABLED_DeliveryMessageReferences, EmbeddedNulStopsBareReference) {
  ASSERT_NO_FATAL_FAILURE(Create({"old@invalid"_ns}));
  constexpr char raw[] = "  bare@invalid\0<ignored@invalid>";
  const nsDependentCString input(raw, sizeof(raw) - 1);
  ASSERT_EQ(sizeof(raw) - 1, input.Length());
  ASSERT_EQ(NS_OK, mHeader->SetReferences(input));
  CheckCount(NS_OK, 1);
  nsAutoCString first;
  ASSERT_EQ(NS_OK, mHeader->GetStringReference(0, first));
  EXPECT_EQ("bare@invalid"_ns, first);
  CheckStored({"bare@invalid"_ns});
}

TEST_F(DISABLED_DeliveryMessageReferences,
       SetReferencesInsertAbortPreservesCommittedTokens) {
  ASSERT_NO_FATAL_FAILURE(Create(
      {"original@invalid"_ns, "missing@invalid"_ns, "original@invalid"_ns}));
  ASSERT_NO_FATAL_FAILURE(CheckStored(
      {"original@invalid"_ns, "missing@invalid"_ns, "original@invalid"_ns}));
  ASSERT_NO_FATAL_FAILURE(InstallWitness());
  ASSERT_NO_FATAL_FAILURE(CheckNoTransaction());
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER delivery_insert_fault "
                       "BEFORE INSERT ON main.message_references "
                       "WHEN NEW.ordinal = 1 BEGIN "
                       "SELECT delivery_references_fault(NEW.id); "
                       "SELECT RAISE(ABORT, 'delivery insert fault'); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            mHeader->SetReferences("<first@invalid> <second@invalid>"_ns));
  CheckWitness();
  CheckNoTransaction();
  CheckStored(
      {"original@invalid"_ns, "missing@invalid"_ns, "original@invalid"_ns});
}

TEST_F(DISABLED_DeliveryMessageReferences,
       SetReferencesDeferredCommitFailurePreservesCommittedTokens) {
  ASSERT_NO_FATAL_FAILURE(Create({"original@invalid"_ns}));
  ASSERT_NO_FATAL_FAILURE(CheckStored({"original@invalid"_ns}));
  ASSERT_NO_FATAL_FAILURE(CheckNoTransaction());
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL("PRAGMA foreign_keys = ON"_ns));
  ASSERT_EQ(
      NS_OK,
      Connection()->ExecuteSimpleSQL(
          "CREATE TABLE delivery_commit_parent(id INTEGER PRIMARY KEY);"
          "CREATE TABLE delivery_commit_child(id INTEGER REFERENCES "
          "delivery_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)"_ns));
  // Establish that this fixture fails at COMMIT, after a successful write.
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "INSERT INTO delivery_commit_child VALUES(777)"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, Connection()->CommitTransaction());
  bool active = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  ASSERT_TRUE(active);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  ASSERT_NO_FATAL_FAILURE(InstallWitness());
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER delivery_commit_fault "
                       "AFTER INSERT ON main.message_references BEGIN "
                       "INSERT INTO delivery_commit_child VALUES(NEW.id); "
                       "SELECT delivery_references_fault(NEW.id); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            mHeader->SetReferences("<first@invalid> <second@invalid>"_ns));
  EXPECT_EQ(2u, mWitness->mCalls);
  EXPECT_EQ(int64_t(mKey), mWitness->mLastKey);
  CheckNoTransaction();
  CheckStored({"original@invalid"_ns});
}

using DeliveryHeaderProperties = DeliveryMessageReferences;

TEST_F(DeliveryHeaderProperties, Uint32SuccessAssignsOnlyUint32) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  ASSERT_EQ(NS_OK, mHeader->SetStringProperty("delivery.uint32", "2a"_ns));
  CheckHeaderUint32Output(mHeader, NS_OK, 42);
}

TEST_F(DeliveryHeaderProperties, Uint32MaximumAssignsOnlyUint32) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  ASSERT_EQ(NS_OK, mHeader->SetUint32Property("delivery.uint32", 0xffffffff));
  CheckHeaderUint32Output(mHeader, NS_OK, 0xffffffff);
  nsAutoCString text;
  ASSERT_EQ(NS_OK, mHeader->GetStringProperty("delivery.uint32", text));
  EXPECT_EQ("ffffffff"_ns, text);
}

TEST_F(DeliveryHeaderProperties, Uint32MissingReplacesSentinelWithZero) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  CheckHeaderUint32Output(mHeader, NS_OK, 0);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, mHeader->GetProperties(names));
  EXPECT_FALSE(names.Contains("delivery.uint32"_ns));
}

TEST_F(DeliveryHeaderProperties, Uint32EmptyReplacesSentinelWithZero) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  ASSERT_EQ(NS_OK,
            mHeader->SetStringProperty("delivery.uint32", EmptyCString()));
  CheckHeaderUint32Output(mHeader, NS_OK, 0);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, mHeader->GetProperties(names));
  EXPECT_TRUE(names.Contains("delivery.uint32"_ns));
}

TEST_F(DeliveryHeaderProperties, Uint32InvalidPrefixReplacesSentinelWithZero) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  ASSERT_EQ(NS_OK, mHeader->SetStringProperty("delivery.uint32", "g2a"_ns));
  CheckHeaderUint32Output(mHeader, NS_OK, 0);
}

TEST_F(DeliveryHeaderProperties, Uint32NineDigitsUseFirstEight) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  ASSERT_EQ(NS_OK,
            mHeader->SetStringProperty("delivery.uint32", "100000000"_ns));
  CheckHeaderUint32Output(mHeader, NS_OK, 0x10000000);
}

TEST_F(DeliveryHeaderProperties, Uint32NullKnownOutputIsRejected) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  ASSERT_EQ(NS_OK, mHeader->SetStringProperty("delivery.uint32", "2a"_ns));
  EXPECT_EQ(NS_ERROR_NULL_POINTER,
            mHeader->GetUint32Property("delivery.uint32", nullptr));
  CheckHeaderUint32Output(mHeader, NS_OK, 42);
}

TEST_F(DeliveryHeaderProperties, Uint32NullOutputDoesNotEvaluateSQL) {
  ASSERT_NO_FATAL_FAILURE(MakePropertyReadFault());
  EXPECT_EQ(NS_ERROR_NULL_POINTER,
            mHeader->GetUint32Property("delivery.uint32", nullptr));
  EXPECT_EQ(0u, mWitness->mCalls);
  CheckHeaderUint32Output(mHeader, NS_ERROR_FAILURE, kHeaderUint32Sentinel);
  CheckWitness();
}

TEST_F(DeliveryHeaderProperties, Uint32PrepareErrorPreservesSentinel) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  // Keep the getter's statement cold so the missing table fails preparation.
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL("DROP TABLE message_properties"_ns));
  nsCOMPtr<mozIStorageStatement> prepared;
  ASSERT_EQ(NS_ERROR_FAILURE,
            Connection()->CreateStatement(
                "SELECT value FROM message_properties WHERE id = :id"_ns,
                getter_AddRefs(prepared)));
  ASSERT_FALSE(prepared);
  CheckHeaderUint32Output(mHeader, NS_ERROR_FAILURE, kHeaderUint32Sentinel);
}

TEST_F(DeliveryHeaderProperties, Uint32ReadStepErrorPreservesSentinel) {
  ASSERT_NO_FATAL_FAILURE(MakePropertyReadFault());
  CheckHeaderUint32Output(mHeader, NS_ERROR_FAILURE, kHeaderUint32Sentinel);
  CheckWitness();
}

using DeliveryCompleteHeader = DeliveryMessageReferences;

TEST_F(DeliveryCompleteHeader, DetachedAliasesPreserveExplicitEmpty) {
  RefPtr<nsIMsgDBHdr> draft = new DetachedMsgHdr(mFolder);
  ASSERT_EQ(NS_OK, draft->SetCharset("UTF-8"_ns));
  ASSERT_EQ(NS_OK, draft->SetAccountKey("received-account"_ns));
  ASSERT_EQ(NS_OK, draft->SetStringProperty("keywords", "first"_ns));
  ASSERT_EQ(NS_OK, draft->SetStringProperty("msgCharSet", "windows-1252"_ns));
  ASSERT_EQ(NS_OK, draft->SetStringProperty("account", EmptyCString()));
  ASSERT_EQ(NS_OK, draft->SetStringProperty("charset", "literal"_ns));
  ASSERT_EQ(NS_OK, draft->SetStringProperty("accountKey", "literal"_ns));
  nsAutoCString text;
  ASSERT_EQ(NS_OK, draft->GetCharset(text));
  EXPECT_EQ("windows-1252"_ns, text);
  ASSERT_EQ(NS_OK, draft->GetAccountKey(text));
  EXPECT_TRUE(text.IsEmpty());
  ASSERT_EQ(NS_OK, draft->SetAccountKey("later-account"_ns));
  ASSERT_EQ(NS_OK, draft->GetStringProperty("account", text));
  EXPECT_EQ("later-account"_ns, text);
  ASSERT_EQ(NS_OK, draft->SetStringProperty("account", EmptyCString()));
  ASSERT_EQ(NS_OK, draft->SetCharset(EmptyCString()));
  ASSERT_EQ(NS_OK, draft->GetStringProperty("msgCharSet", text));
  EXPECT_TRUE(text.IsEmpty());
  ASSERT_EQ(NS_OK, draft->GetStringProperty("charset", text));
  EXPECT_EQ("literal"_ns, text);
  ASSERT_EQ(NS_OK, draft->GetStringProperty("accountKey", text));
  EXPECT_EQ("literal"_ns, text);
  ASSERT_EQ(NS_OK, draft->SetStringProperty("keywords", EmptyCString()));
  ASSERT_EQ(NS_OK, draft->GetStringProperty("keywords", text));
  EXPECT_TRUE(text.IsEmpty());
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, draft->GetProperties(names));
  EXPECT_TRUE(names.Contains("account"_ns));
  EXPECT_TRUE(names.Contains("msgCharSet"_ns));
  EXPECT_EQ(5u, names.Length());
}

TEST_F(DeliveryCompleteHeader, RawExtrasKeepOrderCaseAndUtf8) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RawHdr raw;
  raw.messageId = "exact-extras@invalid"_ns;
  raw.charset = "UTF-8"_ns;
  raw.accountKey = "default-account"_ns;
  raw.keywords = "initial"_ns;
  raw.replyTo = "default@invalid"_ns;
  raw.extras = {{"delivery.same"_ns, "first"_ns},
                {"delivery.same"_ns, "last"_ns},
                {"Delivery.same"_ns, "case"_ns},
                {"delivery.\xc3\xa9"_ns, "snow \xe2\x98\x83"_ns},
                {"msgCharSet"_ns, "windows-1252"_ns},
                {"account"_ns, ""_ns},
                {"keywords"_ns, "final"_ns},
                {"replyTo"_ns, ""_ns},
                {"charset"_ns, "literal-charset"_ns},
                {"accountKey"_ns, "literal-accountKey"_ns}};
  nsCOMPtr<nsIMsgDBHdr> live;
  ASSERT_EQ(NS_OK, db->AddMsgHdr(&raw, false, getter_AddRefs(live)));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, live->GetMessageKey(&key));
  RefPtr<nsIMsgDBHdr> cold = new Message(key);
  nsAutoCString text;
  ASSERT_EQ(NS_OK, cold->GetStringProperty("delivery.same", text));
  EXPECT_EQ("last"_ns, text);
  ASSERT_EQ(NS_OK, cold->GetStringProperty("Delivery.same", text));
  EXPECT_EQ("case"_ns, text);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageProperty(
                       key, "delivery.\xc3\xa9"_ns, text));
  EXPECT_EQ("snow \xe2\x98\x83"_ns, text);
  ASSERT_EQ(NS_OK, cold->GetCharset(text));
  EXPECT_EQ("windows-1252"_ns, text);
  ASSERT_EQ(NS_OK, cold->GetAccountKey(text));
  EXPECT_TRUE(text.IsEmpty());
  ASSERT_EQ(NS_OK, cold->GetStringProperty("keywords", text));
  EXPECT_EQ("final"_ns, text);
  ASSERT_EQ(NS_OK, cold->GetStringProperty("replyTo", text));
  EXPECT_TRUE(text.IsEmpty());
  ASSERT_EQ(NS_OK, cold->GetStringProperty("charset", text));
  EXPECT_EQ("literal-charset"_ns, text);
  ASSERT_EQ(NS_OK, cold->GetStringProperty("accountKey", text));
  EXPECT_EQ("literal-accountKey"_ns, text);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, cold->GetProperties(names));
  EXPECT_TRUE(names.Contains("account"_ns));
  EXPECT_TRUE(names.Contains("replyTo"_ns));
}

TEST_F(DeliveryCompleteHeader, UnspecifiedStorageRemainsAbsent) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RawHdr raw;
  raw.messageId = "unspecified-storage@invalid"_ns;
  nsCOMPtr<nsIMsgDBHdr> live;
  ASSERT_EQ(NS_OK, db->AddMsgHdr(&raw, false, getter_AddRefs(live)));
  uint32_t value = 91;
  ASSERT_EQ(NS_OK, live->GetMessageSize(&value));
  EXPECT_EQ(0u, value);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, live->GetProperties(names));
  EXPECT_FALSE(names.Contains("messageSize"_ns));
  EXPECT_FALSE(names.Contains("storeToken"_ns));
  EXPECT_FALSE(names.Contains("offlineMessageSize"_ns));
  EXPECT_FALSE(names.Contains("lineCount"_ns));
}

TEST_F(DeliveryCompleteHeader, AbsentStorageOptionalsPreserveExtras) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RawHdr raw;
  raw.messageId = "storage-none@invalid"_ns;
  raw.extras = {{"messageSize"_ns, "31"_ns},
                {"offlineMessageSize"_ns, "17"_ns},
                {"lineCount"_ns, "9"_ns},
                {"storeToken"_ns, "original"_ns}};
  nsCOMPtr<nsIMsgDBHdr> live;
  ASSERT_EQ(NS_OK, db->AddMsgHdr(&raw, false, getter_AddRefs(live)));
  uint32_t value;
  ASSERT_EQ(NS_OK, live->GetMessageSize(&value));
  EXPECT_EQ(31u, value);
  ASSERT_EQ(NS_OK, live->GetOfflineMessageSize(&value));
  EXPECT_EQ(17u, value);
  ASSERT_EQ(NS_OK, live->GetLineCount(&value));
  EXPECT_EQ(9u, value);
  nsAutoCString token;
  ASSERT_EQ(NS_OK, live->GetStoreToken(token));
  EXPECT_EQ("original"_ns, token);
}

TEST_F(DeliveryCompleteHeader, ExplicitStorageZeroAndEmptyOverrideExtras) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RawHdr raw;
  raw.extras = {{"messageSize"_ns, "31"_ns},
                {"offlineMessageSize"_ns, "17"_ns},
                {"lineCount"_ns, "9"_ns},
                {"storeToken"_ns, "original"_ns}};
  nsCOMPtr<nsIMsgDBHdr> live;
  uint32_t value;
  raw.messageId = "storage-zero@invalid"_ns;
  raw.messageSize = Some(0u);
  raw.offlineMessageSize = Some(0u);
  raw.lineCount = Some(0u);
  raw.storeToken = Some(nsCString());
  ASSERT_EQ(NS_OK, db->AddMsgHdr(&raw, false, getter_AddRefs(live)));
  ASSERT_EQ(NS_OK, live->GetMessageSize(&value));
  EXPECT_EQ(0u, value);
  ASSERT_EQ(NS_OK, live->GetOfflineMessageSize(&value));
  EXPECT_EQ(0u, value);
  ASSERT_EQ(NS_OK, live->GetLineCount(&value));
  EXPECT_EQ(0u, value);
  nsAutoCString text;
  ASSERT_EQ(NS_OK, live->GetStoreToken(text));
  EXPECT_TRUE(text.IsEmpty());
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, live->GetProperties(names));
  EXPECT_TRUE(names.Contains("storeToken"_ns));
  EXPECT_TRUE(names.Contains("messageSize"_ns));
}

TEST_F(DeliveryHeaderProperties, DetachedUint32RetainsTypedStorage) {
  RefPtr<nsIMsgDBHdr> draft = new DetachedMsgHdr(mFolder);
  ASSERT_EQ(NS_OK, draft->SetUint32Property("delivery.number", 42));
  nsAutoCString text;
  ASSERT_EQ(NS_OK, draft->GetStringProperty("delivery.number", text));
  EXPECT_EQ("2a"_ns, text);
  ASSERT_EQ(NS_OK, draft->SetStringProperty("delivery.number", "00042"_ns));
  uint32_t value;
  ASSERT_EQ(NS_OK, draft->GetUint32Property("delivery.number", &value));
  EXPECT_EQ(66u, value);
  ASSERT_EQ(NS_OK, draft->SetMessageSize(0xffffffff));
  ASSERT_EQ(NS_OK, draft->GetUint32Property("messageSize", &value));
  EXPECT_EQ(0xffffffffu, value);
  ASSERT_EQ(NS_OK, draft->SetLineCount(0));
  ASSERT_EQ(NS_OK, draft->GetLineCount(&value));
  EXPECT_EQ(0u, value);
  EXPECT_EQ(NS_ERROR_NULL_POINTER,
            draft->GetUint32Property("delivery.number", nullptr));
}

TEST_F(DeliveryCompleteHeader, LocalStoreCopyExcludesStoragePresence) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> source;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(source)));
  ASSERT_EQ(NS_OK, source->SetMessageId("self@store-copy.invalid"_ns));
  ASSERT_EQ(NS_OK,
            source->SetReferences("<first@invalid> <self@store-copy.invalid> "
                                  "<unresolved@invalid> <first@invalid>"_ns));
  ASSERT_EQ(NS_OK, source->SetFlags(nsMsgMessageFlags::Read |
                                    nsMsgMessageFlags::Offline));
  ASSERT_EQ(NS_OK, source->SetMessageSize(0));
  ASSERT_EQ(NS_OK, source->SetStoreToken(EmptyCString()));
  ASSERT_EQ(NS_OK, source->SetOfflineMessageSize(0));
  ASSERT_EQ(NS_OK, source->SetLineCount(0));
  ASSERT_EQ(NS_OK, source->SetStringProperty("msgOffset", EmptyCString()));
  ASSERT_EQ(NS_OK, source->SetStringProperty("size", "0007"_ns));
  ASSERT_EQ(NS_OK, source->SetStringProperty("numLines", "literal-lines"_ns));
  ASSERT_EQ(NS_OK,
            source->SetStringProperty("offlineMsgSize", "literal-size"_ns));
  ASSERT_EQ(NS_OK, source->SetStringProperty("custom.empty", EmptyCString()));

  nsCOMPtr<nsIMsgDBHdr> draft;
  ASSERT_EQ(NS_OK, db->CopyHdrForStore(source, false, getter_AddRefs(draft)));
  ASSERT_TRUE(draft);
  bool isLive = true;
  ASSERT_EQ(NS_OK, draft->GetIsLive(&isLive));
  EXPECT_FALSE(isLive);
  nsMsgKey key = 1;
  ASSERT_EQ(NS_OK, draft->GetMessageKey(&key));
  EXPECT_EQ(nsMsgKey_None, key);
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, db->ListAllKeys(keys));
  EXPECT_TRUE(keys.IsEmpty());
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, draft->GetProperties(names));
  for (const auto& name :
       {"storeToken"_ns, "messageSize"_ns, "offlineMessageSize"_ns,
        "lineCount"_ns, "msgOffset"_ns}) {
    EXPECT_FALSE(names.Contains(name)) << name.get();
  }
  nsAutoCString text;
  for (const auto& name :
       {"size"_ns, "numLines"_ns, "offlineMsgSize"_ns, "custom.empty"_ns}) {
    EXPECT_TRUE(names.Contains(name)) << name.get();
  }
  ASSERT_EQ(NS_OK, draft->GetStringProperty("size", text));
  EXPECT_EQ("0007"_ns, text);
  ASSERT_EQ(NS_OK, draft->GetStringProperty("numLines", text));
  EXPECT_EQ("literal-lines"_ns, text);
  ASSERT_EQ(NS_OK, draft->GetStringProperty("offlineMsgSize", text));
  EXPECT_EQ("literal-size"_ns, text);
  ASSERT_EQ(NS_OK, draft->GetStringProperty("custom.empty", text));
  EXPECT_TRUE(text.IsEmpty());
  uint32_t flags;
  ASSERT_EQ(NS_OK, draft->GetFlags(&flags));
  EXPECT_EQ(nsMsgMessageFlags::Read, flags);

  nsCOMPtr<nsIMsgDBHdr> live;
  ASSERT_EQ(NS_OK, db->AttachHdr(draft, false, getter_AddRefs(live)));
  ASSERT_EQ(NS_OK, live->GetMessageKey(&key));
  nsTArray<nsCString> references;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(key, references));
  const nsTArray<nsCString> expected = {
      "first@invalid"_ns, "self@store-copy.invalid"_ns, "unresolved@invalid"_ns,
      "first@invalid"_ns};
  EXPECT_EQ(expected, references);
  ASSERT_EQ(NS_OK, live->GetProperties(names));
  EXPECT_FALSE(names.Contains("msgOffset"_ns));
  EXPECT_FALSE(names.Contains("storeToken"_ns));
  EXPECT_FALSE(names.Contains("messageSize"_ns));
  ASSERT_EQ(NS_OK, source->GetProperties(names));
  EXPECT_TRUE(names.Contains("msgOffset"_ns));
  EXPECT_TRUE(names.Contains("storeToken"_ns));
  EXPECT_TRUE(names.Contains("messageSize"_ns));
  ASSERT_EQ(NS_OK, source->GetFlags(&flags));
  EXPECT_EQ(uint32_t(nsMsgMessageFlags::Read | nsMsgMessageFlags::Offline),
            flags);
}

TEST_F(DeliveryCompleteHeader, UncachedStoreCopyKeepsLogicalMessageSize) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> source;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(source)));
  ASSERT_EQ(NS_OK, source->SetMessageId("uncached@store-copy.invalid"_ns));
  ASSERT_EQ(NS_OK, source->SetMessageSize(12345));
  ASSERT_EQ(NS_OK, source->SetStoreToken("source-token"_ns));
  ASSERT_EQ(NS_OK, source->SetOfflineMessageSize(17));
  ASSERT_EQ(NS_OK, source->SetLineCount(9));
  ASSERT_EQ(NS_OK, source->SetFlags(nsMsgMessageFlags::Marked |
                                    nsMsgMessageFlags::Offline));
  ASSERT_EQ(NS_OK, source->SetStringProperty("msgOffset", "0007"_ns));
  nsCOMPtr<nsIMsgDBHdr> draft;
  ASSERT_EQ(NS_OK, db->CopyHdrForStore(source, true, getter_AddRefs(draft)));
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, draft->GetProperties(names));
  EXPECT_TRUE(names.Contains("messageSize"_ns));
  for (const auto& name : {"storeToken"_ns, "offlineMessageSize"_ns,
                           "lineCount"_ns, "msgOffset"_ns}) {
    EXPECT_FALSE(names.Contains(name)) << name.get();
  }
  uint32_t value;
  ASSERT_EQ(NS_OK, draft->GetMessageSize(&value));
  EXPECT_EQ(12345u, value);
  ASSERT_EQ(NS_OK, draft->GetFlags(&value));
  EXPECT_EQ(nsMsgMessageFlags::Marked, value);
  ASSERT_EQ(NS_OK, draft->SetSubject("editable destination"_ns));
  ASSERT_EQ(NS_OK, source->GetOfflineMessageSize(&value));
  EXPECT_EQ(17u, value);
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, db->ListAllKeys(keys));
  EXPECT_TRUE(keys.IsEmpty());
}

TEST_F(DeliveryCompleteHeader, StoreCopyDoesNotCloneServerUidBinding) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> source;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(source)));
  ASSERT_EQ(NS_OK, source->SetMessageId("server-uid@store-copy.invalid"_ns));
  ASSERT_EQ(NS_OK, source->SetStringProperty("uidOnServer", "1"_ns));
  ASSERT_EQ(NS_OK, source->SetStringProperty("UidOnServer", "literal-case"_ns));
  for (bool preserveMessageSize : {false, true}) {
    nsCOMPtr<nsIMsgDBHdr> draft;
    ASSERT_EQ(NS_OK, db->CopyHdrForStore(source, preserveMessageSize,
                                         getter_AddRefs(draft)));
    nsTArray<nsCString> names;
    ASSERT_EQ(NS_OK, draft->GetProperties(names));
    EXPECT_FALSE(names.Contains("uidOnServer"_ns));
    EXPECT_TRUE(names.Contains("UidOnServer"_ns));
    nsAutoCString text;
    ASSERT_EQ(NS_OK, draft->GetStringProperty("UidOnServer", text));
    EXPECT_EQ("literal-case"_ns, text);
  }
  nsCOMPtr<nsIMsgDBHdr> generic;
  ASSERT_EQ(NS_OK, db->CopyHdrFromExistingHdr(nsMsgKey_None, source, false,
                                              getter_AddRefs(generic)));
  nsAutoCString text;
  ASSERT_EQ(NS_OK, generic->GetStringProperty("uidOnServer", text));
  EXPECT_EQ("1"_ns, text);
  ASSERT_EQ(NS_OK, source->GetStringProperty("uidOnServer", text));
  EXPECT_EQ("1"_ns, text);
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, db->ListAllKeys(keys));
  EXPECT_TRUE(keys.IsEmpty());
}

TEST_F(DeliveryCompleteHeader, StoreCopyRejectsStaleAndClosedDestination) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> source;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(source)));
  ASSERT_EQ(NS_OK, source->SetMessageId("source-guard@store-copy.invalid"_ns));
  nsCOMPtr<nsIMsgDBHdr> draft = source;
  EXPECT_EQ(NS_ERROR_NULL_POINTER, db->CopyHdrForStore(source, false, nullptr));
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db->CopyHdrForStore(nullptr, false, getter_AddRefs(draft)));
  EXPECT_FALSE(draft);
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "UPDATE database_identity SET sourceId = "
                       "'{7a139b24-9c50-47fa-8322-168da90748c0}'"_ns));
  draft = source;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->CopyHdrForStore(source, true, getter_AddRefs(draft)));
  EXPECT_FALSE(draft);
  bool inTransaction = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&inTransaction));
  EXPECT_TRUE(inTransaction);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  ASSERT_EQ(NS_OK, db->ForceClosed());
  draft = source;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->CopyHdrForStore(source, false, getter_AddRefs(draft)));
  EXPECT_FALSE(draft);
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader,
       UndoBridgeRejectsClosedWrapperWithoutConsumption) {
  ASSERT_NO_FATAL_FAILURE(Create({"parent@undo.invalid"_ns}));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RemovedMessage captured;
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessageForUndo(mKey, captured));
  ASSERT_TRUE(captured.Body());
  ASSERT_EQ(NS_OK, db->ForceClosed());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db->RemoveHdrForUndo(mKey, captured));
  OfflineOperationUndo redo, nextOffline;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->RemoveHdrForUndo(mKey, captured, &redo, &nextOffline));
  EXPECT_FALSE(redo.Operation());
  EXPECT_FALSE(nextOffline.Operation());
  ASSERT_TRUE(captured.Body());
  EXPECT_EQ(mKey, captured.Body()->key);
  OfflineOperationUndo offline;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->CaptureOfflineOperationForUndo(mKey, offline));
  EXPECT_FALSE(offline.Operation());
  FinishedMessageBody finished;
  nsMsgKey key = 42;
  Message* live = nullptr;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->RestoreHdrForUndo(captured, finished, &key, &live));
  EXPECT_EQ(42u, key);
  EXPECT_EQ(nullptr, live);
  ASSERT_TRUE(captured.Body());
  EXPECT_EQ(mKey, captured.Body()->key);
}

TEST_F(DeliveryCompleteHeader,
       UndoBridgeRejectsForeignFolderAndOccupiedOutput) {
  ASSERT_NO_FATAL_FAILURE(Create({"parent@undo.invalid"_ns}));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<Message> occupiedOwner = new Message(mKey);
  RemovedMessage captured;
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessageForUndo(mKey, captured));
  uint64_t other;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolder, "Other"_ns, &other));
  RefPtr<PerFolderDatabase> foreign = new PerFolderDatabase(other, false);
  FinishedMessageBody finished;
  nsMsgKey key = 42;
  Message* live = nullptr;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            foreign->RestoreHdrForUndo(captured, finished, &key, &live));
  EXPECT_EQ(42u, key);
  EXPECT_EQ(nullptr, live);
  ASSERT_TRUE(captured.Body());
  Message* occupied = occupiedOwner.get();
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db->RestoreHdrForUndo(captured, finished, &key, &occupied));
  EXPECT_EQ(occupiedOwner.get(), occupied);
  EXPECT_EQ(42u, key);
  ASSERT_TRUE(captured.Body());
  EXPECT_EQ(mKey, captured.Body()->key);
  EXPECT_EQ(NS_ERROR_NULL_POINTER,
            db->RestoreHdrForUndo(captured, finished, nullptr));
  PendingDestination selected{mFolder, mKey, 7};
  OfflineOperationUndo redo;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db->RestoreHdrForUndo(captured, finished, &key, &live, nullptr,
                                  &selected, nullptr));
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db->RestoreHdrForUndo(captured, finished, &key, &live, nullptr,
                                  nullptr, &redo));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->RestoreHdrForUndo(captured, finished, &key, &live, &redo,
                                  &selected, &redo));
  EXPECT_EQ(42u, key);
  EXPECT_EQ(nullptr, live);
  EXPECT_FALSE(redo.Operation());
  ASSERT_TRUE(captured.Body());
  EXPECT_EQ(mKey, captured.Body()->key);
}

TEST_F(DeliveryCompleteHeader, UndoBridgeLeavesCallerTransactionAndOutputs) {
  ASSERT_NO_FATAL_FAILURE(Create({"parent@undo.invalid"_ns}));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RemovedMessage captured;
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessageForUndo(mKey, captured));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  FinishedMessageBody finished;
  nsMsgKey key = 42;
  Message* live = nullptr;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db->RestoreHdrForUndo(captured, finished, &key, &live));
  EXPECT_EQ(42u, key);
  EXPECT_EQ(nullptr, live);
  ASSERT_TRUE(captured.Body());
  OfflineOperationUndo offline;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db->CaptureOfflineOperationForUndo(mKey, offline));
  EXPECT_FALSE(offline.Operation());
  bool active = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader,
       OfflineCopyStagesOpaqueMetadataBeforePublication) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> source, draft;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(source)));
  ASSERT_EQ(NS_OK, source->SetMessageId("copied@invalid"_ns));
  ASSERT_EQ(NS_OK,
            source->SetReferences(
                "<copied@invalid> <parent@invalid> <copied@invalid>"_ns));
  ASSERT_EQ(NS_OK, source->SetFlags(nsMsgMessageFlags::Read |
                                    nsMsgMessageFlags::Marked));
  ASSERT_EQ(NS_OK, source->SetMessageSize(73));
  ASSERT_EQ(NS_OK, source->SetStringProperty("Case", "00042"_ns));
  ASSERT_EQ(NS_OK, source->SetStringProperty("empty", ""_ns));
  ASSERT_EQ(NS_OK, source->SetStringProperty("uidOnServer", "2a"_ns));
  ASSERT_EQ(NS_OK, db->CopyHdrForStore(source, true, getter_AddRefs(draft)));
  nsMsgKey key = nsMsgKey_None;
  ASSERT_EQ(NS_OK, db->StageHdrForOfflineCopy(draft, &key));
  ASSERT_NE(nsMsgKey_None, key);
  bool exists = true;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_FALSE(exists);
  nsTArray<nsCString> references;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(key, references));
  EXPECT_EQ((nsTArray<nsCString>{"copied@invalid"_ns, "parent@invalid"_ns,
                                 "copied@invalid"_ns}),
            references);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessagePropertyNames(key, names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  EXPECT_FALSE(names.Contains("storeToken"_ns));
  EXPECT_TRUE(names.Contains("empty"_ns));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, draft->SetSubject("after stage"_ns));
  OfflineOperationData operation;
  operation.operation = nsIMsgOfflineImapOperation::kAddedHeader;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().StoreOfflineOperation(mFolder, key, operation));
  RefPtr<Message> output;
  uint32_t publications = 0;
  RefPtr<DeliveryEarlyMutationListener> listener =
      new DeliveryEarlyMutationListener;
  listener->publication = [&](const CapturedMessage& after, Message* live) {
    ++publications;
    EXPECT_EQ(key, after.id);
    EXPECT_EQ(output.get(), live);
    EXPECT_EQ(uint32_t(nsMsgMessageFlags::Read | nsMsgMessageFlags::Marked),
              after.flags);
    OfflineOperationData saved;
    EXPECT_EQ(NS_OK,
              mCore->MessageDB().GetOfflineOperation(mFolder, key, saved));
    EXPECT_EQ(operation.operation, saved.operation);
    nsMsgKey duplicateKey = 42;
    EXPECT_EQ(NS_ERROR_IN_PROGRESS,
              db->StageHdrForOfflineCopy(draft, &duplicateKey));
    EXPECT_EQ(42u, duplicateKey);
    RefPtr<Message> duplicate;
    EXPECT_EQ(
        NS_ERROR_IN_PROGRESS,
        db->PublishHdrForOfflineCopy(draft, true, getter_AddRefs(duplicate)));
    EXPECT_FALSE(duplicate);
    nsCOMPtr<nsIMsgDBHdr> attached;
    EXPECT_EQ(NS_ERROR_IN_PROGRESS,
              db->AttachHdr(draft, true, getter_AddRefs(attached)));
    EXPECT_FALSE(attached);
    EXPECT_EQ(NS_ERROR_IN_PROGRESS, draft->SetSubject("reentrant"_ns));
  };
  mCore->MessageDB().AddMessageListener(listener);
  auto remove = MakeScopeExit(
      [&] { mCore->MessageDB().RemoveMessageListener(listener); });
  ASSERT_EQ(NS_OK,
            db->PublishHdrForOfflineCopy(draft, true, getter_AddRefs(output)));
  ASSERT_TRUE(output);
  EXPECT_EQ(1u, publications);
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_TRUE(exists);
  RefPtr<Message> duplicate;
  EXPECT_EQ(
      NS_ERROR_ALREADY_INITIALIZED,
      db->PublishHdrForOfflineCopy(draft, true, getter_AddRefs(duplicate)));
  EXPECT_FALSE(duplicate);
  EXPECT_EQ(1u, publications);
  nsCString property;
  ASSERT_EQ(NS_OK, output->GetStringProperty("Case", property));
  EXPECT_EQ("00042"_ns, property);
  uint32_t size;
  ASSERT_EQ(NS_OK, output->GetMessageSize(&size));
  EXPECT_EQ(73u, size);
}

TEST_F(DeliveryCompleteHeader,
       OfflineCopyAdmissionKeepsCallerTransactionAndOutputs) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> source, draft;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(source)));
  ASSERT_EQ(NS_OK, source->SetMessageId("guarded-copy@invalid"_ns));
  nsMsgKey key = 42;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db->StageHdrForOfflineCopy(source, &key));
  EXPECT_EQ(42u, key);
  ASSERT_EQ(NS_OK, db->CopyHdrForStore(source, true, getter_AddRefs(draft)));
  uint64_t other;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolder, "Other"_ns, &other));
  RefPtr<PerFolderDatabase> foreign = new PerFolderDatabase(other, false);
  EXPECT_EQ(NS_ERROR_INVALID_ARG, foreign->StageHdrForOfflineCopy(draft, &key));
  EXPECT_EQ(42u, key);
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db->StageHdrForOfflineCopy(draft, &key));
  EXPECT_EQ(42u, key);
  bool active = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  ASSERT_EQ(NS_OK, db->StageHdrForOfflineCopy(draft, &key));
  RefPtr<Message> output;
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db->PublishHdrForOfflineCopy(draft, false, getter_AddRefs(output)));
  EXPECT_FALSE(output);
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  RefPtr<Message> occupied = new Message(key);
  Message* slot = occupied.get();
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db->PublishHdrForOfflineCopy(draft, false, &slot));
  EXPECT_EQ(occupied.get(), slot);
  EXPECT_EQ(NS_ERROR_NULL_POINTER,
            db->PublishHdrForOfflineCopy(draft, false, nullptr));
  ASSERT_EQ(NS_OK,
            db->PublishHdrForOfflineCopy(draft, false, getter_AddRefs(output)));
  ASSERT_TRUE(output);
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader,
       OfflineCopyFailureSealsDraftAndRetainsStagedOperation) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> source, draft;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(source)));
  ASSERT_EQ(NS_OK, source->SetMessageId("fault-copy@invalid"_ns));
  ASSERT_EQ(NS_OK, source->SetReferences("<parent@invalid>"_ns));
  ASSERT_NO_FATAL_FAILURE(InstallWitness());
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER delivery_stage_copy_fault "
                       "BEFORE INSERT ON main.staged_message_references BEGIN "
                       "SELECT delivery_references_fault(NEW.id); "
                       "SELECT RAISE(ABORT,'stage copy failure'); END"_ns));
  ASSERT_EQ(NS_OK, db->CopyHdrForStore(source, true, getter_AddRefs(draft)));
  nsMsgKey key = 42;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db->StageHdrForOfflineCopy(draft, &key));
  EXPECT_EQ(42u, key);
  EXPECT_EQ(1u, mWitness->mCalls);
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "DROP TRIGGER delivery_stage_copy_fault"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db->StageHdrForOfflineCopy(draft, &key));
  EXPECT_EQ(42u, key);
  EXPECT_EQ(1u, mWitness->mCalls);
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, draft->SetSubject("retry"_ns));
  nsTArray<nsMsgKey> staged;
  ASSERT_EQ(NS_OK, mCore->MessageDB().ListStagedMessages(mFolder, staged));
  EXPECT_TRUE(staged.IsEmpty());
  ASSERT_EQ(NS_OK, db->CopyHdrForStore(source, true, getter_AddRefs(draft)));
  ASSERT_EQ(NS_OK, db->StageHdrForOfflineCopy(draft, &key));
  OfflineOperationData operation;
  operation.operation = nsIMsgOfflineImapOperation::kAddedHeader;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().StoreOfflineOperation(mFolder, key, operation));
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER delivery_publish_copy_fault "
                       "BEFORE INSERT ON main.messages BEGIN "
                       "SELECT delivery_references_fault(NEW.id); "
                       "SELECT RAISE(ABORT,'publish copy failure'); END"_ns));
  RefPtr<Message> output;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db->PublishHdrForOfflineCopy(draft, true, getter_AddRefs(output)));
  EXPECT_FALSE(output);
  EXPECT_EQ(2u, mWitness->mCalls);
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "DROP TRIGGER delivery_publish_copy_fault"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db->PublishHdrForOfflineCopy(draft, true, getter_AddRefs(output)));
  EXPECT_FALSE(output);
  EXPECT_EQ(2u, mWitness->mCalls);
  OfflineOperationData retained;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetOfflineOperation(mFolder, key, retained));
  EXPECT_EQ(operation.operation, retained.operation);
  ASSERT_EQ(NS_OK, mCore->MessageDB().ListStagedMessages(mFolder, staged));
  EXPECT_EQ((nsTArray<nsMsgKey>{key}), staged);
  bool exists = true;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_FALSE(exists);
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, OfflineCopyRejectsStaleAndClosedOwners) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> source, draft;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(source)));
  ASSERT_EQ(NS_OK, source->SetMessageId("stale-copy@invalid"_ns));
  ASSERT_EQ(NS_OK, db->CopyHdrForStore(source, true, getter_AddRefs(draft)));
  nsMsgKey key = nsMsgKey_None;
  ASSERT_EQ(NS_OK, db->StageHdrForOfflineCopy(draft, &key));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "UPDATE database_identity SET sourceId="
                       "'{7a139b24-9c50-47fa-8322-168da90748c0}'"_ns));
  RefPtr<PerFolderDatabase> reopened = new PerFolderDatabase(mFolder, false);
  RefPtr<Message> output;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, reopened->PublishHdrForOfflineCopy(
                                        draft, true, getter_AddRefs(output)));
  EXPECT_FALSE(output);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->PublishHdrForOfflineCopy(draft, true, getter_AddRefs(output)));
  EXPECT_FALSE(output);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  ASSERT_EQ(NS_OK, db->ForceClosed());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->PublishHdrForOfflineCopy(draft, true, getter_AddRefs(output)));
  EXPECT_FALSE(output);
  nsTArray<nsMsgKey> staged;
  ASSERT_EQ(NS_OK, mCore->MessageDB().ListStagedMessages(mFolder, staged));
  EXPECT_EQ((nsTArray<nsMsgKey>{key}), staged);
}

TEST_F(DeliveryCompleteHeader, FailedAttachmentDoesNotReplay) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> draft;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(draft)));
  ASSERT_EQ(NS_OK, draft->SetMessageId("failed-attach@invalid"_ns));
  ASSERT_EQ(NS_OK, draft->SetReferences("<parent@invalid>"_ns));
  ASSERT_NO_FATAL_FAILURE(InstallWitness());
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER delivery_add_fault "
                       "BEFORE INSERT ON main.message_references BEGIN "
                       "SELECT delivery_references_fault(NEW.id); "
                       "SELECT RAISE(ABORT, 'delivery add fault'); END"_ns));
  nsCOMPtr<nsIMsgDBHdr> live;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db->AttachHdr(draft, true, getter_AddRefs(live)));
  EXPECT_FALSE(live);
  ASSERT_TRUE(mWitness);
  EXPECT_EQ(1u, mWitness->mCalls);
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, db->ListAllKeys(keys));
  EXPECT_TRUE(keys.IsEmpty());
  CheckNoTransaction();
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db->AttachHdr(draft, true, getter_AddRefs(live)));
  EXPECT_FALSE(live);
  EXPECT_EQ(1u, mWitness->mCalls);
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, draft->SetSubject("retry"_ns));
}

using DISABLED_DeliveryParentChanges = DeliveryMessageReferences;

TEST_F(DISABLED_DeliveryParentChanges,
       ParentBridgeUsesCapturedParentsWhenLegacyAddIsSuppressed) {
  MessageThreadBatch batch;
  ASSERT_NO_FATAL_FAILURE(PrepareParentChange(batch));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<DeliveryParentChangeListener> listener =
      new DeliveryParentChangeListener;
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto remove =
      MakeScopeExit([&] { EXPECT_EQ(NS_OK, db->RemoveListener(listener)); });
  PreparedThreadBatch prepared;
  ASSERT_EQ(NS_OK, db->PrepareThreadBatch(batch, prepared));
  db->DeliverThreadBatch(prepared);
  ASSERT_EQ(1u, listener->changes.Length());
  EXPECT_EQ(mKey, listener->changes[0].key);
  EXPECT_EQ(nsMsgKey_None, listener->changes[0].oldParent);
  EXPECT_EQ(batch.publicationKey, listener->changes[0].newParent);
  EXPECT_TRUE(listener->added.IsEmpty());
  EXPECT_EQ(0u, listener->otherChanges);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(2));
  CapturedMessage stored;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(mKey, stored));
  EXPECT_EQ(batch.publicationKey, stored.threadParent);
  EXPECT_EQ(batch.publicationKey, stored.threadId);
  EXPECT_EQ(0u, stored.flags);
  nsTArray<nsCString> references;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(mKey, references));
  ASSERT_EQ(1u, references.Length());
  EXPECT_EQ("future-parent@invalid"_ns, references[0]);
}

TEST_F(DISABLED_DeliveryParentChanges,
       ParentBridgePrecedesOnlyTheActualPublication) {
  MessageThreadBatch batch;
  ASSERT_NO_FATAL_FAILURE(PrepareParentChange(batch));
  batch.notifyLegacy = true;
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<DeliveryParentChangeListener> listener =
      new DeliveryParentChangeListener;
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto remove =
      MakeScopeExit([&] { EXPECT_EQ(NS_OK, db->RemoveListener(listener)); });
  PreparedThreadBatch prepared;
  ASSERT_EQ(NS_OK, db->PrepareThreadBatch(batch, prepared));
  db->DeliverThreadBatch(prepared);
  ASSERT_EQ(1u, listener->changes.Length());
  ASSERT_EQ(1u, listener->added.Length());
  EXPECT_EQ(batch.publicationKey, listener->added[0]);
  ASSERT_EQ(2u, listener->order.Length());
  EXPECT_EQ(mKey, listener->order[0]);
  EXPECT_EQ(batch.publicationKey, listener->order[1]);
  EXPECT_EQ(0u, listener->otherChanges);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(2));
}

TEST_F(DISABLED_DeliveryParentChanges,
       ParentBridgeKeepsHistoryAfterAnEarlierRemoval) {
  MessageThreadBatch batch;
  ASSERT_NO_FATAL_FAILURE(PrepareParentChange(batch));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  PreparedThreadBatch prepared;
  ASSERT_EQ(NS_OK, db->PrepareThreadBatch(batch, prepared));
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(mKey));
  ASSERT_NO_FATAL_FAILURE(CheckMessageRow(false));
  RefPtr<DeliveryParentChangeListener> listener =
      new DeliveryParentChangeListener;
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto remove =
      MakeScopeExit([&] { EXPECT_EQ(NS_OK, db->RemoveListener(listener)); });
  db->DeliverThreadBatch(prepared);
  ASSERT_EQ(1u, listener->changes.Length());
  EXPECT_EQ(mKey, listener->changes[0].key);
  EXPECT_EQ(nsMsgKey_None, listener->changes[0].oldParent);
  EXPECT_EQ(batch.publicationKey, listener->changes[0].newParent);
  EXPECT_TRUE(listener->added.IsEmpty());
  EXPECT_EQ(0u, listener->otherChanges);
  ASSERT_NO_FATAL_FAILURE(CheckMessageRow(false));
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(1));
}

TEST_F(DISABLED_DeliveryParentChanges, ParentBridgeMapsAnAbsentDestination) {
  MessageThreadBatch batch;
  ASSERT_NO_FATAL_FAILURE(PrepareParentChange(batch));
  CapturedMessage before = batch.after[0], after;
  ASSERT_EQ(NS_OK, StoreParentForBridge(mKey, mKey, 0));
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(mKey, after));
  RefPtr<Message> live = new Message(mKey);
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<DeliveryParentChangeListener> listener =
      new DeliveryParentChangeListener;
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto remove =
      MakeScopeExit([&] { EXPECT_EQ(NS_OK, db->RemoveListener(listener)); });
  db->OnMessageThreadChanged(before, after, live);
  ASSERT_EQ(1u, listener->changes.Length());
  EXPECT_EQ(mKey, listener->changes[0].key);
  EXPECT_EQ(batch.publicationKey, listener->changes[0].oldParent);
  EXPECT_EQ(nsMsgKey_None, listener->changes[0].newParent);
  EXPECT_TRUE(listener->added.IsEmpty());
  EXPECT_EQ(0u, listener->otherChanges);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(2));
}

TEST_F(DISABLED_DeliveryParentChanges,
       ParentBridgeIgnoresForeignScopeAndUnchangedParents) {
  MessageThreadBatch batch;
  ASSERT_NO_FATAL_FAILURE(PrepareParentChange(batch));
  CapturedMessage before = batch.before[0], after;
  RefPtr<Message> live = new Message(mKey);
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<DeliveryParentChangeListener> listener =
      new DeliveryParentChangeListener;
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto remove =
      MakeScopeExit([&] { EXPECT_EQ(NS_OK, db->RemoveListener(listener)); });
  after = before;
  after.threadId = batch.publicationKey;
  db->OnMessageThreadChanged(before, after, live);
  after.threadParent = nsMsgKey_None;
  db->OnMessageThreadChanged(before, after, live);
  uint64_t otherRoot, other;
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertRoot("parent-bridge-other"_ns, &otherRoot));
  ASSERT_EQ(NS_OK,
            mCore->FolderDB().InsertFolder(otherRoot, "Inbox"_ns, &other));
  after = before;
  after.folderId = other;
  after.threadParent = mKey;
  db->OnMessageThreadChanged(before, after, live);
  db->OnMessageThreadChanged(after, before, live);
  before = after;
  after.threadParent = 0;
  db->OnMessageThreadChanged(before, after, live);
  EXPECT_TRUE(listener->changes.IsEmpty());
  EXPECT_TRUE(listener->added.IsEmpty());
  EXPECT_EQ(0u, listener->otherChanges);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(2));
}

TEST_F(DISABLED_DeliveryParentChanges, ParentBridgeAllowsListenerRemoval) {
  MessageThreadBatch batch;
  ASSERT_NO_FATAL_FAILURE(PrepareParentChange(batch));
  RefPtr<Message> live = new Message(mKey);
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<DeliveryParentChangeListener> listener =
      new DeliveryParentChangeListener;
  listener->detachFrom = db;
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto remove =
      MakeScopeExit([&] { EXPECT_EQ(NS_OK, db->RemoveListener(listener)); });
  db->OnMessageThreadChanged(batch.before[0], batch.after[0], live);
  ASSERT_EQ(1u, listener->changes.Length());
  ASSERT_EQ(NS_OK, StoreParentForBridge(mKey, mKey, 0));
  CapturedMessage restored;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(mKey, restored));
  db->OnMessageThreadChanged(batch.after[0], restored, live);
  EXPECT_EQ(1u, listener->changes.Length());
  EXPECT_TRUE(listener->added.IsEmpty());
  EXPECT_EQ(0u, listener->otherChanges);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(2));
}

using DISABLED_DeliveryHeaderAncestry = DeliveryMessageReferences;

TEST_F(DISABLED_DeliveryHeaderAncestry, StagedOwnFlagsStayUnpublished) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<DeliveryParentChangeListener> listener =
      new DeliveryParentChangeListener;
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto remove =
      MakeScopeExit([&] { EXPECT_EQ(NS_OK, db->RemoveListener(listener)); });
  RawHdr raw{};
  raw.messageId = "staged-own-killed@invalid"_ns;
  nsMsgKey key;
  RefPtr<Message> header;
  ASSERT_EQ(NS_OK, mCore->MessageDB().StageMessage(mFolder, raw, &key,
                                                   getter_AddRefs(header)));
  bool killed = true;
  EXPECT_EQ(NS_OK, header->GetIsKilled(&killed));
  EXPECT_FALSE(killed);
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageFlag(
                       key, nsMsgMessageFlags::Ignored, true));
  EXPECT_EQ(NS_OK, header->GetIsKilled(&killed));
  EXPECT_TRUE(killed);
  ASSERT_EQ(NS_OK, header->MarkRead(true));
  Maybe<CapturedMessage> state;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureHeaderState(key, state));
  ASSERT_TRUE(state);
  EXPECT_EQ(uint32_t(nsMsgMessageFlags::Ignored | nsMsgMessageFlags::Read),
            state->flags);
  EXPECT_EQ(mFolder, state->folderId);
  bool published = true;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, published));
  EXPECT_FALSE(published);
  EXPECT_EQ(NS_ERROR_NULL_POINTER, header->GetIsKilled(nullptr));
  EXPECT_TRUE(listener->changes.IsEmpty());
  EXPECT_TRUE(listener->added.IsEmpty());
  EXPECT_EQ(0u, listener->otherChanges);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(0));
}

TEST_F(DISABLED_DeliveryHeaderAncestry,
       StagedAncestryRemainsPhysicalFolderScoped) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageFlag(
                       mKey, nsMsgMessageFlags::Ignored, true));
  RawHdr raw{};
  raw.messageId = "staged-descendant@invalid"_ns;
  raw.references = {"child@invalid"_ns};
  nsMsgKey key;
  RefPtr<Message> header;
  ASSERT_EQ(NS_OK, mCore->MessageDB().StageMessage(mFolder, raw, &key,
                                                   getter_AddRefs(header)));
  Maybe<CapturedMessage> state;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureHeaderState(key, state));
  ASSERT_TRUE(state);
  ASSERT_EQ(mKey, state->threadParent);
  ASSERT_EQ(mKey, state->threadId);
  bool killed = false;
  EXPECT_EQ(NS_OK, header->GetIsKilled(&killed));
  EXPECT_TRUE(killed);
  EXPECT_EQ(0u, state->flags);
  uint64_t other;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolder, "Other"_ns, &other));
  raw.messageId = "foreign-staged-descendant@invalid"_ns;
  RefPtr<Message> foreign;
  nsMsgKey foreignKey;
  ASSERT_EQ(NS_OK, mCore->MessageDB().StageMessage(other, raw, &foreignKey,
                                                   getter_AddRefs(foreign)));
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureHeaderState(foreignKey, state));
  ASSERT_TRUE(state);
  ASSERT_EQ(mKey, state->threadParent);
  ASSERT_EQ(other, state->folderId);
  killed = true;
  EXPECT_EQ(NS_OK, foreign->GetIsKilled(&killed));
  EXPECT_FALSE(killed);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(1));
}

TEST_F(DISABLED_DeliveryHeaderAncestry,
       RemovedAncestorCannotSupplyCachedKilledState) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageFlag(
                       mKey, nsMsgMessageFlags::Ignored, true));
  RawHdr raw{};
  raw.messageId = "staged-survivor@invalid"_ns;
  raw.references = {"child@invalid"_ns};
  nsMsgKey key;
  RefPtr<Message> header;
  ASSERT_EQ(NS_OK, mCore->MessageDB().StageMessage(mFolder, raw, &key,
                                                   getter_AddRefs(header)));
  bool killed = false;
  ASSERT_EQ(NS_OK, header->GetIsKilled(&killed));
  ASSERT_TRUE(killed);
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(mKey));
  ASSERT_NO_FATAL_FAILURE(CheckMessageRow(false));
  uint32_t retainedFlags = 0;
  ASSERT_EQ(NS_OK, mHeader->GetFlags(&retainedFlags));
  EXPECT_TRUE(retainedFlags & nsMsgMessageFlags::Ignored);
  EXPECT_EQ(NS_OK, header->GetIsKilled(&killed));
  EXPECT_FALSE(killed);
  Maybe<CapturedMessage> state;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureHeaderState(key, state));
  ASSERT_TRUE(state);
  EXPECT_EQ(mKey, state->threadParent);
  EXPECT_EQ(0u, state->flags);
}

TEST_F(DISABLED_DeliveryHeaderAncestry,
       AbortedOwnHeaderFailsWithClearedOutput) {
  RawHdr raw{};
  raw.messageId = "aborted-killed@invalid"_ns;
  raw.flags = nsMsgMessageFlags::Ignored;
  nsMsgKey key;
  RefPtr<Message> header;
  ASSERT_EQ(NS_OK, mCore->MessageDB().StageMessage(mFolder, raw, &key,
                                                   getter_AddRefs(header)));
  bool killed = false;
  ASSERT_EQ(NS_OK, header->GetIsKilled(&killed));
  ASSERT_TRUE(killed);
  ASSERT_EQ(NS_OK, mCore->MessageDB().AbortMessage(key));
  Maybe<CapturedMessage> state;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureHeaderState(key, state));
  ASSERT_FALSE(state);
  EXPECT_EQ(NS_ERROR_UNEXPECTED, header->GetIsKilled(&killed));
  EXPECT_FALSE(killed);
}

TEST_F(DISABLED_DeliveryHeaderAncestry,
       StagedAncestorCycleFailsWithClearedOutput) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  RawHdr raw{};
  raw.messageId = "staged-cycle@invalid"_ns;
  raw.references = {"child@invalid"_ns};
  nsMsgKey key;
  RefPtr<Message> header;
  ASSERT_EQ(NS_OK, mCore->MessageDB().StageMessage(mFolder, raw, &key,
                                                   getter_AddRefs(header)));
  ASSERT_EQ(NS_OK, StoreParentForBridge(mKey, mKey, key));
  bool killed = true;
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, header->GetIsKilled(&killed));
  EXPECT_FALSE(killed);
  Maybe<CapturedMessage> state;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureHeaderState(key, state));
  ASSERT_TRUE(state);
  EXPECT_EQ(mKey, state->threadParent);
  EXPECT_EQ(0u, state->flags);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(1));
}

TEST_F(DISABLED_DeliveryHeaderAncestry, StagedReadFailureIsNotMissingAncestry) {
  RawHdr raw{};
  raw.messageId = "staged-read-error@invalid"_ns;
  RefPtr<Message> header;
  ASSERT_EQ(NS_OK, mCore->MessageDB().StageMessage(mFolder, raw, &mKey,
                                                   getter_AddRefs(header)));
  ASSERT_NO_FATAL_FAILURE(InstallWitness(true));
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP VIEW staged_messages AS SELECT "
                       "id,folderId,messageId,date,sender,"
                       "recipients,subject,delivery_references_fault(id) AS "
                       "flags,tags,threadId,"
                       "threadParent FROM main.staged_messages"_ns));
  auto drop = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "DROP VIEW temp.staged_messages"_ns));
  });
  bool killed = true;
  EXPECT_EQ(NS_ERROR_FAILURE, header->GetIsKilled(&killed));
  EXPECT_FALSE(killed);
  ASSERT_TRUE(mWitness);
  EXPECT_GT(mWitness->mCalls, 0u);
  EXPECT_EQ(int64_t(mKey), mWitness->mLastKey);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(0));
}

using DeliveryCapturedNotifications = DeliveryMessageReferences;

TEST_F(DeliveryCapturedNotifications, PublicationPrecedesReentrantReadDelta) {
  auto& native = mCore->MessageDB();
  RefPtr<DeliveryEarlyMutationListener> early =
      new DeliveryEarlyMutationListener;
  native.AddMessageListener(early);
  auto unwatch = MakeScopeExit([&] { native.RemoveMessageListener(early); });
  bool changed = false;
  early->publication = [&](const CapturedMessage& after, Message* live) {
    changed = true;
    EXPECT_EQ(mFolder, after.folderId);
    EXPECT_EQ(0u, after.flags);
    EXPECT_EQ(NS_OK, live->MarkRead(true));
  };
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<DeliveryCapturedLegacyListener> listener =
      new DeliveryCapturedLegacyListener(db);
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto remove = MakeScopeExit([&] { db->RemoveListener(listener); });
  RawHdr raw{};
  raw.messageId = "captured-read@invalid"_ns;
  nsMsgKey key;
  ASSERT_EQ(NS_OK, native.AddMessage(mFolder, raw, true, &key));
  ASSERT_TRUE(changed);
  ASSERT_EQ(2u, listener->events.Length());
  const auto& added = listener->events[0];
  EXPECT_EQ('A', added.kind);
  EXPECT_EQ(key, added.key);
  EXPECT_EQ(nsMsgMessageFlags::New, added.flags);
  EXPECT_EQ(nsMsgKey_None, added.parent);
  EXPECT_EQ(nsMsgMessageFlags::Read, added.liveFlags);
  EXPECT_EQ((nsTArray<nsMsgKey>{key}), added.newKeys);
  const auto& read = listener->events[1];
  EXPECT_EQ('F', read.kind);
  EXPECT_EQ(nsMsgMessageFlags::New, read.oldFlags);
  EXPECT_EQ(nsMsgMessageFlags::Read, read.flags);
  EXPECT_TRUE(read.newKeys.IsEmpty());
  EXPECT_EQ(0u, listener->otherChanges);
  Maybe<CapturedMessage> stored;
  ASSERT_EQ(NS_OK, native.CaptureHeaderState(key, stored));
  ASSERT_TRUE(stored);
  EXPECT_EQ(nsMsgMessageFlags::Read, stored->flags);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(1));
}

TEST_F(DeliveryCapturedNotifications,
       PublicationAndDeletionKeepHistoricalParent) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  auto& native = mCore->MessageDB();
  RefPtr<DeliveryEarlyMutationListener> early =
      new DeliveryEarlyMutationListener;
  native.AddMessageListener(early);
  auto unwatch = MakeScopeExit([&] { native.RemoveMessageListener(early); });
  bool removed = false;
  early->publication = [&](const CapturedMessage& after, Message*) {
    removed = true;
    EXPECT_EQ(0u, after.flags);
    EXPECT_EQ(NS_OK, native.RemoveMessage(after.id));
  };
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<DeliveryCapturedLegacyListener> listener =
      new DeliveryCapturedLegacyListener(db);
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto remove = MakeScopeExit([&] { db->RemoveListener(listener); });
  RawHdr raw{};
  raw.messageId = "captured-deletion@invalid"_ns;
  raw.references = {"child@invalid"_ns};
  nsMsgKey key;
  ASSERT_EQ(NS_OK, native.AddMessage(mFolder, raw, true, &key));
  ASSERT_TRUE(removed);
  ASSERT_EQ(2u, listener->events.Length());
  EXPECT_EQ('A', listener->events[0].kind);
  EXPECT_EQ(nsMsgMessageFlags::New, listener->events[0].flags);
  EXPECT_EQ(0u, listener->events[0].liveFlags);
  EXPECT_EQ(mKey, listener->events[0].parent);
  EXPECT_EQ((nsTArray<nsMsgKey>{key}), listener->events[0].newKeys);
  EXPECT_EQ('D', listener->events[1].kind);
  EXPECT_EQ(key, listener->events[1].key);
  EXPECT_EQ(mKey, listener->events[1].parent);
  EXPECT_EQ(nsMsgMessageFlags::New, listener->events[1].flags);
  EXPECT_TRUE(listener->events[1].newKeys.IsEmpty());
  EXPECT_EQ(0u, listener->otherChanges);
  Maybe<CapturedMessage> stored;
  ASSERT_EQ(NS_OK, native.CaptureHeaderState(key, stored));
  EXPECT_FALSE(stored);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(1));
}

TEST_F(DeliveryCapturedNotifications,
       ReentrantTagsUseExistingPostChangeCallbacks) {
  auto& native = mCore->MessageDB();
  RefPtr<DeliveryEarlyMutationListener> early =
      new DeliveryEarlyMutationListener;
  native.AddMessageListener(early);
  auto unwatch = MakeScopeExit([&] { native.RemoveMessageListener(early); });
  bool changed = false;
  early->publication = [&](const CapturedMessage& after, Message*) {
    changed = true;
    EXPECT_EQ(NS_OK, native.SetMessageTags(after.id, "first"_ns));
    EXPECT_EQ(NS_OK, native.SetMessageTags(after.id, "second"_ns));
  };
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<DeliveryCapturedLegacyListener> listener =
      new DeliveryCapturedLegacyListener(db);
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto remove = MakeScopeExit([&] { db->RemoveListener(listener); });
  RawHdr raw{};
  raw.messageId = "captured-tags@invalid"_ns;
  nsMsgKey key;
  ASSERT_EQ(NS_OK, native.AddMessage(mFolder, raw, true, &key));
  ASSERT_TRUE(changed);
  ASSERT_EQ(3u, listener->events.Length());
  EXPECT_EQ('A', listener->events[0].kind);
  for (size_t i = 1; i < 3; ++i) {
    EXPECT_EQ('T', listener->events[i].kind);
    EXPECT_EQ(key, listener->events[i].key);
    EXPECT_EQ("second"_ns, listener->events[i].tags);
  }
  EXPECT_EQ(0u, listener->otherChanges);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(1));
}

TEST_F(DeliveryCapturedNotifications, BodyOnlyChangesDoNotInventEvents) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  auto& native = mCore->MessageDB();
  RefPtr<DeliveryEarlyMutationListener> early =
      new DeliveryEarlyMutationListener;
  native.AddMessageListener(early);
  auto unwatch = MakeScopeExit([&] { native.RemoveMessageListener(early); });
  bool changed = false;
  early->body = [&](const MessageBodyState& after) {
    if (changed || !(after.flags & nsMsgMessageFlags::Offline)) {
      return;
    }
    changed = true;
    FinishedMessageBody latest;
    latest.storeToken = "latest"_ns;
    latest.messageSize = 20;
    latest.offlineMessageSize = 21;
    latest.lineCount = 4;
    MessageBodyState output;
    EXPECT_EQ(NS_OK, native.SettleMessageBody(after, latest, output));
  };
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  ASSERT_EQ(NS_OK, db->AddToNewList(mKey));
  RefPtr<DeliveryCapturedLegacyListener> listener =
      new DeliveryCapturedLegacyListener(db);
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto remove = MakeScopeExit([&] { db->RemoveListener(listener); });
  MessageBodyState before, after;
  ASSERT_EQ(NS_OK, native.GetMessageBodyState(mKey, before));
  FinishedMessageBody finished;
  finished.storeToken = "token-only"_ns;
  finished.messageSize = 10;
  finished.offlineMessageSize = 11;
  finished.lineCount = 2;
  ASSERT_EQ(NS_OK, native.SettleMessageBody(before, finished, after));
  EXPECT_EQ(0u, after.flags);
  EXPECT_TRUE(listener->events.IsEmpty());
  EXPECT_FALSE(changed);
  finished.storeToken = "offline"_ns;
  finished.offline = true;
  ASSERT_EQ(NS_OK, native.SettleMessageBody(after, finished, before));
  ASSERT_TRUE(changed);
  EXPECT_EQ(nsMsgMessageFlags::Offline, before.flags);
  ASSERT_EQ(2u, listener->events.Length());
  EXPECT_EQ('F', listener->events[0].kind);
  EXPECT_EQ(nsMsgMessageFlags::New, listener->events[0].oldFlags);
  EXPECT_EQ(uint32_t(nsMsgMessageFlags::New | nsMsgMessageFlags::Offline),
            listener->events[0].flags);
  EXPECT_EQ(0u, listener->events[0].liveFlags);
  EXPECT_EQ('F', listener->events[1].kind);
  EXPECT_EQ(uint32_t(nsMsgMessageFlags::New | nsMsgMessageFlags::Offline),
            listener->events[1].oldFlags);
  EXPECT_EQ(nsMsgMessageFlags::New, listener->events[1].flags);
  EXPECT_EQ((nsTArray<nsMsgKey>{mKey}), listener->events[1].newKeys);
  ASSERT_EQ(NS_OK, native.GetMessageBodyState(mKey, after));
  EXPECT_EQ(0u, after.flags);
  uint32_t rawFlags = UINT32_MAX;
  ASSERT_EQ(NS_OK, native.GetMessageFlags(mKey, rawFlags));
  EXPECT_EQ(0u, rawFlags);
  ASSERT_TRUE(after.storeToken);
  EXPECT_EQ("latest"_ns, *after.storeToken);
  EXPECT_EQ(20u, after.messageSize);
  EXPECT_EQ(21u, after.offlineMessageSize);
  EXPECT_EQ(4u, after.lineCount);
  EXPECT_EQ(0u, listener->otherChanges);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(1));
}

TEST_F(DeliveryCapturedNotifications,
       SuppressedAddStillTracksUnreadMembership) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<DeliveryCapturedLegacyListener> listener =
      new DeliveryCapturedLegacyListener(db);
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto remove = MakeScopeExit([&] { db->RemoveListener(listener); });
  RawHdr raw{};
  raw.messageId = "captured-suppressed@invalid"_ns;
  nsMsgKey key;
  RefPtr<Message> live;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolder, raw, false, &key,
                                                 getter_AddRefs(live)));
  EXPECT_TRUE(listener->events.IsEmpty());
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, db->GetNewList(keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{key}), keys);
  uint32_t rawFlags = UINT32_MAX;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageFlags(key, rawFlags));
  EXPECT_EQ(0u, rawFlags);
  ASSERT_EQ(NS_OK, live->MarkRead(true));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageFlags(key, rawFlags));
  EXPECT_EQ(nsMsgMessageFlags::Read, rawFlags);
  ASSERT_EQ(1u, listener->events.Length());
  EXPECT_EQ('F', listener->events[0].kind);
  EXPECT_EQ(nsMsgMessageFlags::New, listener->events[0].oldFlags);
  EXPECT_EQ(nsMsgMessageFlags::Read, listener->events[0].flags);
  EXPECT_TRUE(listener->events[0].newKeys.IsEmpty());
  EXPECT_EQ(0u, listener->otherChanges);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(1));
}

TEST_F(DeliveryCapturedNotifications,
       ForeignFolderFactsDoNotChangeThisWrapper) {
  uint64_t other;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolder, "Other"_ns, &other));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<DeliveryCapturedLegacyListener> listener =
      new DeliveryCapturedLegacyListener(db);
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto remove = MakeScopeExit([&] { db->RemoveListener(listener); });
  RawHdr raw{};
  raw.messageId = "captured-foreign@invalid"_ns;
  nsMsgKey key;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(other, raw, true, &key));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageFlag(
                       key, nsMsgMessageFlags::Read, true));
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageTags(key, "foreign"_ns));
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessage(key));
  EXPECT_TRUE(listener->events.IsEmpty());
  EXPECT_EQ(0u, listener->otherChanges);
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, db->GetNewList(keys));
  EXPECT_TRUE(keys.IsEmpty());
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(0));
}

using DeliveryCapturedLifetime = DeliveryMessageReferences;

TEST_F(DeliveryCapturedLifetime, ClosedDuringParentDoesNotConsumePublication) {
  MessageThreadBatch batch;
  ASSERT_NO_FATAL_FAILURE(PrepareParentChange(batch));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<DeliveryCapturedLegacyListener> listener =
      new DeliveryCapturedLegacyListener(db);
  listener->closeOnParent = true;
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto remove = MakeScopeExit([&] { db->RemoveListener(listener); });
  PreparedThreadBatch prepared;
  ASSERT_EQ(NS_OK, db->PrepareThreadBatch(batch, prepared));
  db->DeliverThreadBatch(prepared);
  EXPECT_TRUE(listener->events.IsEmpty());
  EXPECT_EQ(2u, listener->otherChanges);
  nsTArray<nsMsgKey> newKeys;
  ASSERT_EQ(NS_OK, db->GetNewList(newKeys));
  EXPECT_TRUE(newKeys.IsEmpty());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db->AddListener(listener));
  Maybe<CapturedMessage> stored;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureHeaderState(batch.publicationKey,
                                                         stored));
  ASSERT_TRUE(stored);
  EXPECT_EQ(mFolder, stored->folderId);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(2));
}

TEST_F(DISABLED_DeliveryHeaderAncestry,
       SingleReferenceUsesTheParentsActualThread) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  nsMsgKey branch;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().AddMessage(
                mFolder, "staged-branch@invalid"_ns, {"child@invalid"_ns},
                123457, "sender"_ns, "recipient"_ns, EmptyCString(),
                EmptyCString(), "branch"_ns, 0, EmptyCString(), 0, &branch));
  ASSERT_NE(mKey, branch);
  ASSERT_EQ(NS_OK, mCore->MessageDB().SetMessageFlag(
                       branch, nsMsgMessageFlags::Ignored, true));
  RawHdr raw{};
  raw.messageId = "staged-single-reference@invalid"_ns;
  raw.references = {"staged-branch@invalid"_ns};
  nsMsgKey key;
  RefPtr<Message> header;
  ASSERT_EQ(NS_OK, mCore->MessageDB().StageMessage(mFolder, raw, &key,
                                                   getter_AddRefs(header)));
  Maybe<CapturedMessage> state;
  ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureHeaderState(key, state));
  ASSERT_TRUE(state);
  EXPECT_EQ(branch, state->threadParent);
  EXPECT_EQ(mKey, state->threadId);
  bool killed = false;
  EXPECT_EQ(NS_OK, header->GetIsKilled(&killed));
  EXPECT_TRUE(killed);
  bool published = true;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, published));
  EXPECT_FALSE(published);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(2));
}

class PartialDraftObserver final : public MessageListener {
 public:
  NS_DECL_ISUPPORTS
  PartialDraftObserver(PerFolderDatabase* database, nsIMsgDBHdr* parsed)
      : mDatabase(database), mParsed(parsed) {}
  void OnMessageAdded(Message*) override { ++mAdds; }
  void OnMessageRemoved(Message*, uint32_t) override {}
  void OnMessageFlagsChanged(nsIMsgDBHdr*, Message*, uint32_t,
                             uint32_t) override {
    ++mChanges;
    nsCOMPtr<nsIMsgDBHdr> duplicate;
    EXPECT_EQ(NS_ERROR_IN_PROGRESS,
              mDatabase->AttachHdr(mParsed, false, getter_AddRefs(duplicate)));
    EXPECT_FALSE(duplicate);
    EXPECT_EQ(NS_ERROR_IN_PROGRESS, mParsed->SetSubject("reentrant"_ns));
  }
  void OnMessageTagsChanged(nsIMsgDBHdr*, Message*, const nsACString&,
                            const nsACString&) override {}
  uint32_t mAdds = 0;
  uint32_t mChanges = 0;

 private:
  ~PartialDraftObserver() = default;
  RefPtr<PerFolderDatabase> mDatabase;
  nsCOMPtr<nsIMsgDBHdr> mParsed;
};
NS_IMPL_ISUPPORTS(PartialDraftObserver, nsISupports)

using DISABLED_DeliveryPartialHeader = DeliveryMessageReferences;

TEST_F(DISABLED_DeliveryPartialHeader, CompletesSameKeyAndConsumesParsedDraft) {
  ASSERT_NO_FATAL_FAILURE(Create({"old@invalid"_ns}));
  ASSERT_EQ(NS_OK, mHeader->SetFlags(nsMsgMessageFlags::Read |
                                     nsMsgMessageFlags::Partial));
  ASSERT_EQ(NS_OK, mHeader->SetStringProperty("keywords", "user-tags"_ns));
  ASSERT_EQ(NS_OK, mHeader->SetStringProperty("unrelated", "keep"_ns));
  ASSERT_EQ(NS_OK, mHeader->SetAccountKey("old-account"_ns));
  ASSERT_EQ(NS_OK, mHeader->SetPriority(nsMsgPriority::highest));
  MessageBodyState expected;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageBodyState(mKey, expected));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> parsed;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(parsed)));
  ASSERT_EQ(NS_OK, parsed->SetMessageId("child@invalid"_ns));
  ASSERT_EQ(NS_OK, parsed->SetSubject("complete subject"_ns));
  ASSERT_EQ(NS_OK, parsed->SetPriority(nsMsgPriority::high));
  ASSERT_EQ(NS_OK,
            parsed->SetReferences(
                "<first@invalid> <unresolved@invalid> <first@invalid>"_ns));
  ASSERT_EQ(NS_OK, parsed->SetStringProperty("Case", "earlier"_ns));
  ASSERT_EQ(NS_OK, parsed->SetStringProperty("case", "1e3"_ns));
  ASSERT_EQ(NS_OK, parsed->SetStringProperty("Case", "00042"_ns));
  ASSERT_EQ(NS_OK, parsed->SetStringProperty("empty", ""_ns));
  ASSERT_EQ(NS_OK, parsed->SetStringProperty("account", ""_ns));
  RefPtr<PartialDraftObserver> observer = new PartialDraftObserver(db, parsed);
  mCore->MessageDB().AddMessageListener(observer);
  auto remove = MakeScopeExit(
      [&] { mCore->MessageDB().RemoveMessageListener(observer); });
  // These are native settlement inputs, not proof of actual provider bytes.
  FinishedMessageBody finished{"0"_ns, 42, 42, 3, true};
  nsCOMPtr<nsIMsgDBHdr> completed;
  ASSERT_EQ(NS_OK, db->CompletePartialHdr(expected, parsed, finished,
                                          getter_AddRefs(completed)));
  ASSERT_TRUE(completed);
  nsMsgKey key, thread;
  ASSERT_EQ(NS_OK, completed->GetMessageKey(&key));
  EXPECT_EQ(mKey, key);
  ASSERT_EQ(NS_OK, completed->GetThreadId(&thread));
  EXPECT_EQ(mKey, thread);
  nsMsgPriorityValue priority;
  ASSERT_EQ(NS_OK, completed->GetPriority(&priority));
  EXPECT_EQ(nsMsgPriority::high, priority);
  uint32_t flags;
  ASSERT_EQ(NS_OK, completed->GetFlags(&flags));
  EXPECT_TRUE(flags & nsMsgMessageFlags::Read);
  EXPECT_TRUE(flags & nsMsgMessageFlags::Offline);
  EXPECT_FALSE(flags & nsMsgMessageFlags::Partial);
  nsCString text;
  ASSERT_EQ(NS_OK, completed->GetSubject(text));
  EXPECT_EQ("complete subject"_ns, text);
  ASSERT_EQ(NS_OK, completed->GetStringProperty("keywords", text));
  EXPECT_EQ("user-tags"_ns, text);
  ASSERT_EQ(NS_OK, completed->GetStringProperty("unrelated", text));
  EXPECT_EQ("keep"_ns, text);
  ASSERT_EQ(NS_OK, completed->GetStringProperty("Case", text));
  EXPECT_EQ("00042"_ns, text);
  ASSERT_EQ(NS_OK, completed->GetStringProperty("case", text));
  EXPECT_EQ("1e3"_ns, text);
  ASSERT_EQ(NS_OK, completed->GetAccountKey(text));
  EXPECT_TRUE(text.IsEmpty());
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, completed->GetProperties(names));
  EXPECT_TRUE(names.Contains("empty"_ns));
  EXPECT_TRUE(names.Contains("account"_ns));
  uint16_t count = 0;
  ASSERT_EQ(NS_OK, completed->GetNumReferences(&count));
  EXPECT_EQ(3u, count);
  ASSERT_EQ(NS_OK, completed->GetStringReference(2, text));
  EXPECT_EQ("first@invalid"_ns, text);
  MessageBodyState after;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageBodyState(mKey, after));
  EXPECT_EQ(Some(nsCString("0"_ns)), after.storeToken);
  EXPECT_EQ(42u, after.messageSize);
  EXPECT_EQ(42u, after.offlineMessageSize);
  EXPECT_EQ(3u, after.lineCount);
  nsCOMPtr<nsIMsgDBHdr> repeated;
  ASSERT_EQ(NS_OK, db->AttachHdr(parsed, true, getter_AddRefs(repeated)));
  EXPECT_EQ(completed, repeated);
  EXPECT_EQ(NS_ERROR_ALREADY_INITIALIZED, parsed->SetSubject("late"_ns));
  EXPECT_EQ(0u, observer->mAdds);
  EXPECT_EQ(1u, observer->mChanges);
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, db->ListAllKeys(keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{mKey}), keys);
}

TEST_F(DISABLED_DeliveryPartialHeader, StorageFailureSealsDraftAndKeepsSource) {
  ASSERT_NO_FATAL_FAILURE(Create({"old@invalid"_ns}));
  ASSERT_EQ(NS_OK, mHeader->SetFlags(nsMsgMessageFlags::Partial));
  MessageBodyState expected;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageBodyState(mKey, expected));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> parsed;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(parsed)));
  ASSERT_EQ(NS_OK, parsed->SetMessageId("child@invalid"_ns));
  ASSERT_EQ(NS_OK, parsed->SetSubject("uncommitted subject"_ns));
  RefPtr<DeliveryMessageReferencesFaultWitness> witness =
      new DeliveryMessageReferencesFaultWitness();
  ASSERT_EQ(NS_OK,
            Connection()->CreateFunction("partial_draft_fault"_ns, 1, witness));
  auto cleanup = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS fail_partial_draft"_ns));
    EXPECT_EQ(NS_OK, Connection()->RemoveFunction("partial_draft_fault"_ns));
  });
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER fail_partial_draft BEFORE UPDATE "
                       "OF subject ON messages BEGIN "
                       "SELECT partial_draft_fault(NEW.id); "
                       "SELECT RAISE(ABORT,'partial draft'); END"_ns));
  FinishedMessageBody finished{"finished-retained"_ns, 23, 23, 1, true};
  nsIMsgDBHdr* output = mHeader;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db->CompletePartialHdr(expected, parsed, finished, &output));
  EXPECT_EQ(nullptr, output);
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(mKey, witness->mLastKey);
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, parsed->SetSubject("retry"_ns));
  nsCOMPtr<nsIMsgDBHdr> duplicate;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db->AttachHdr(parsed, true, getter_AddRefs(duplicate)));
  EXPECT_FALSE(duplicate);
  MessageBodyState after;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageBodyState(mKey, after));
  EXPECT_EQ(expected.storeToken, after.storeToken);
  EXPECT_EQ(expected.contentRevision, after.contentRevision);
  EXPECT_EQ(expected.locationRevision, after.locationRevision);
  EXPECT_TRUE(after.flags & nsMsgMessageFlags::Partial);
  nsCString subject;
  ASSERT_EQ(NS_OK, mHeader->GetSubject(subject));
  EXPECT_EQ("subject"_ns, subject);
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, db->ListAllKeys(keys));
  EXPECT_EQ((nsTArray<nsMsgKey>{mKey}), keys);
}

TEST_F(DISABLED_DeliveryPartialHeader,
       RejectsAnotherPhysicalFolderBeforeClaim) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  ASSERT_EQ(NS_OK, mHeader->SetFlags(nsMsgMessageFlags::Partial));
  MessageBodyState expected;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageBodyState(mKey, expected));
  uint64_t other;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolder, "Other"_ns, &other));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(other, false);
  nsCOMPtr<nsIMsgDBHdr> parsed;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(parsed)));
  FinishedMessageBody finished;
  nsIMsgDBHdr* output = mHeader;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db->CompletePartialHdr(expected, parsed, finished, &output));
  EXPECT_EQ(nullptr, output);
  EXPECT_EQ(NS_OK, parsed->SetSubject("still editable"_ns));
  bool exists = false;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(mKey, exists));
  EXPECT_TRUE(exists);
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK, db->ListAllKeys(keys));
  EXPECT_TRUE(keys.IsEmpty());
}

}  // namespace
using DeliveryDatabaseClose = DeliveryMessageReferences;

TEST_F(DeliveryDatabaseClose, MessageInvalidationClearsOutputs) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgEnumerator> iterator;
  ASSERT_EQ(NS_OK, db->EnumerateMessages(getter_AddRefs(iterator)));
  bool more = false;
  ASSERT_EQ(NS_OK, iterator->HasMoreElements(&more));
  ASSERT_TRUE(more);
  ASSERT_EQ(NS_OK, db->Close(false));
  more = true;
  EXPECT_EQ(NS_ERROR_FAILURE, iterator->HasMoreElements(&more));
  EXPECT_FALSE(more);
  nsIMsgDBHdr* output = mHeader;
  EXPECT_EQ(NS_ERROR_FAILURE, iterator->GetNext(&output));
  EXPECT_EQ(nullptr, output);
  nsCString subject;
  ASSERT_EQ(NS_OK, mHeader->GetSubject(subject));
  EXPECT_EQ("subject"_ns, subject);
}

TEST_F(DeliveryDatabaseClose, ThreadInvalidationClearsOutputs) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgThreadEnumerator> iterator;
  ASSERT_EQ(NS_OK, db->EnumerateThreads(getter_AddRefs(iterator)));
  bool more = false;
  ASSERT_EQ(NS_OK, iterator->HasMoreElements(&more));
  ASSERT_TRUE(more);
  nsCOMPtr<nsIMsgThread> thread;
  ASSERT_EQ(NS_OK,
            db->GetThreadContainingMsgHdr(mHeader, getter_AddRefs(thread)));
  ASSERT_TRUE(thread);
  ASSERT_EQ(NS_OK, db->Close(false));
  more = true;
  EXPECT_EQ(NS_OK, iterator->HasMoreElements(&more));
  EXPECT_FALSE(more);
  nsIMsgThread* output = thread;
  EXPECT_EQ(NS_ERROR_FAILURE, iterator->GetNext(&output));
  EXPECT_EQ(nullptr, output);
  uint32_t count = 0;
  ASSERT_EQ(NS_OK, thread->GetNumChildren(&count));
  EXPECT_EQ(1u, count);
}

TEST_F(DeliveryDatabaseClose, MessageStepFailureIsNotEmptyIteration) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  RefPtr<DeliveryMessageReferencesFaultWitness> witness =
      new DeliveryMessageReferencesFaultWitness(true);
  ASSERT_EQ(NS_OK,
            Connection()->CreateFunction("close_enum_fault"_ns, 1, witness));
  auto cleanup = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, Connection()->RemoveFunction("close_enum_fault"_ns));
  });
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                       "SELECT id FROM messages WHERE id=:key AND "
                       "close_enum_fault(id)=0"_ns,
                       getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("key"_ns, mKey));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<MessageEnumerator> iterator = new MessageEnumerator(db, stmt);
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(mKey, witness->mLastKey);
  bool more = true;
  EXPECT_EQ(NS_ERROR_FAILURE, iterator->HasMoreElements(&more));
  EXPECT_FALSE(more);
  nsIMsgDBHdr* output = mHeader;
  EXPECT_EQ(NS_ERROR_FAILURE, iterator->GetNext(&output));
  EXPECT_EQ(nullptr, output);
}

TEST_F(DeliveryDatabaseClose, ThreadStepFailureIsNotEmptyIteration) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgThread> thread;
  ASSERT_EQ(NS_OK,
            db->GetThreadContainingMsgHdr(mHeader, getter_AddRefs(thread)));
  ASSERT_TRUE(thread);
  RefPtr<DeliveryMessageReferencesFaultWitness> witness =
      new DeliveryMessageReferencesFaultWitness(true);
  ASSERT_EQ(NS_OK,
            Connection()->CreateFunction("close_thread_fault"_ns, 1, witness));
  auto cleanup = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, Connection()->RemoveFunction("close_thread_fault"_ns));
  });
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(NS_OK,
            Connection()->CreateStatement(
                "SELECT threadId, MAX(date) FROM messages WHERE id=:key AND "
                "close_thread_fault(id)=0 GROUP BY threadId"_ns,
                getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("key"_ns, mKey));
  RefPtr<ThreadEnumerator> iterator = new ThreadEnumerator(db, stmt);
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(mKey, witness->mLastKey);
  bool more = true;
  EXPECT_EQ(NS_ERROR_FAILURE, iterator->HasMoreElements(&more));
  EXPECT_FALSE(more);
  nsIMsgThread* output = thread;
  EXPECT_EQ(NS_ERROR_FAILURE, iterator->GetNext(&output));
  EXPECT_EQ(nullptr, output);
}

}  // namespace mozilla::mailnews
