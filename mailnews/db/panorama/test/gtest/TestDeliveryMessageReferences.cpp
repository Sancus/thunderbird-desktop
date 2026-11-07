/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsIMsgOfflineImapOperation.h"
#include "../../../../news/src/nsNewsFolder.h"
#include "mozilla/StaticPrefs_mail.h"
#include "nsIFolderLookupService.h"
#include "nsIInputStream.h"
#include "nsIMsgAccount.h"
#include "nsIMsgAccountManager.h"
#include "nsIMsgDatabase.h"
#include "nsIMsgIncomingServer.h"
#include "nsIMsgPluggableStore.h"
#include "nsIOutputStream.h"
#include "nsMsgLocalStoreUtils.h"
#include "nsPrintfCString.h"
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
#include "nsIDBFolderInfo.h"
#include "nsIFile.h"
#include "nsIInterfaceRequestorUtils.h"
#include "nsIMsgHdr.h"
#include "nsIProperties.h"
#include "nsIVariant.h"
#include "nsMsgFolderFlags.h"
#include "nsMsgMessageFlags.h"
#include "nsQueryObject.h"
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

  // TEST_F bodies derive from this fixture; Core friendship stays here.
  nsresult ReadAdmissionSourceId(nsACString& output) {
    return mCore->ReadSourceIdForFolderAdmission(output);
  }

  static nsresult ReadNewsCheckpoint(PerFolderDatabase& database,
                                     nsACString& output) {
    nsCOMPtr<nsIDBFolderInfo> info;
    MOZ_TRY(database.GetDBFolderInfo(getter_AddRefs(info)));
    return info->GetCharProperty("readSet", output);
  }

  static nsresult ReadNewsZeroCheckpoint(PerFolderDatabase& database,
                                         int64_t& output) {
    nsCOMPtr<nsIDBFolderInfo> info;
    MOZ_TRY(database.GetDBFolderInfo(getter_AddRefs(info)));
    // Keep the caller's sentinel when the stored zero checkpoint is absent.
    return info->GetInt64Property("readSetContainsZero", output, &output);
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

  void CreateOfflineProtocolSource() {
    ASSERT_NO_FATAL_FAILURE(Create({}));
    ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 77));
    ASSERT_EQ(NS_OK, mCore->MessageDB().BindMessageToServerUid(mKey, mFolder,
                                                               77, 7401));
    ASSERT_NE(mKey, 7401u);
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

TEST_F(DeliveryCompleteHeader, PendingAttributesKeepUint64AndStageComplete) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> source, draft;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(source)));
  ASSERT_EQ(NS_OK, source->SetMessageId("pending-native@invalid"_ns));
  ASSERT_EQ(NS_OK, source->SetReferences("<a@invalid> <a@invalid>"_ns));
  ASSERT_EQ(NS_OK, db->CopyHdrForStore(source, false, getter_AddRefs(draft)));
  ASSERT_EQ(NS_OK,
            db->SetUint64AttributeOnPendingHdr(draft, "wide", UINT64_MAX));
  ASSERT_EQ(NS_OK,
            db->SetUint32AttributeOnPendingHdr(draft, "word", UINT32_MAX));
  ASSERT_EQ(NS_OK, db->SetAttributeOnPendingHdr(draft, "empty", ""));
  ASSERT_EQ(NS_OK,
            db->SetAttributeOnPendingHdr(draft, "unicode", "雪 é exact"));
  EXPECT_EQ(NS_ERROR_ILLEGAL_VALUE,
            db->SetUint64AttributeOnPendingHdr(draft, "flags", UINT64_MAX));
  nsMsgKey key = nsMsgKey_None;
  ASSERT_EQ(NS_OK, db->StageHdrForOfflineCopy(draft, &key));
  nsAutoCString text;
  ASSERT_EQ(NS_OK, draft->GetStringProperty("wide", text));
  EXPECT_EQ("ffffffffffffffff"_ns, text);
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db->SetAttributeOnPendingHdr(draft, "wide", "too-late"));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db->UpdatePendingAttributes(draft));
  RefPtr<Message> live;
  ASSERT_EQ(NS_OK,
            db->PublishHdrForOfflineCopy(draft, false, getter_AddRefs(live)));
  ASSERT_TRUE(live);
  ASSERT_EQ(NS_OK, live->GetStringProperty("wide", text));
  EXPECT_EQ("ffffffffffffffff"_ns, text);
  ASSERT_EQ(NS_OK, live->GetStringProperty("unicode", text));
  EXPECT_EQ("雪 é exact"_ns, text);
  ASSERT_EQ(NS_OK, live->GetStringProperty("word", text));
  EXPECT_EQ("ffffffff"_ns, text);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, live->GetProperties(names));
  EXPECT_TRUE(names.Contains("empty"_ns));
  nsTArray<nsCString> references;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(key, references));
  const nsTArray<nsCString> expected = {"a@invalid"_ns, "a@invalid"_ns};
  EXPECT_EQ(expected, references);
}

TEST_F(DeliveryCompleteHeader, PendingAttributesRejectUnownedAndNullInputs) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<PerFolderDatabase> other = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> draft;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(draft)));
  RefPtr<DetachedMsgHdr> unowned = new DetachedMsgHdr(mFolder);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db->UpdatePendingAttributes(unowned));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, other->UpdatePendingAttributes(draft));
  EXPECT_EQ(NS_ERROR_INVALID_ARG, db->UpdatePendingAttributes(nullptr));
  EXPECT_EQ(NS_ERROR_NULL_POINTER,
            db->SetAttributeOnPendingHdr(draft, nullptr, "value"));
  EXPECT_EQ(NS_ERROR_NULL_POINTER,
            db->SetAttributeOnPendingHdr(draft, "name", nullptr));
  EXPECT_EQ(NS_ERROR_NULL_POINTER,
            db->SetUint64AttributeOnPendingHdr(draft, nullptr, UINT64_MAX));
  ASSERT_EQ(NS_OK, db->SetAttributeOnPendingHdr(draft, "kept", "value"));
  ASSERT_EQ(NS_OK, db->UpdatePendingAttributes(draft));
  nsAutoCString text;
  ASSERT_EQ(NS_OK, draft->GetStringProperty("kept", text));
  EXPECT_EQ("value"_ns, text);
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

TEST_F(DeliveryCompleteHeader, UndoDeleteRejectsHeadersWithoutOwnedContext) {
  ASSERT_NO_FATAL_FAILURE(Create({"parent@undo.invalid"_ns}));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<DetachedMsgHdr> detached = new DetachedMsgHdr(mFolder);
  EXPECT_EQ(NS_ERROR_NULL_POINTER, db->UndoDelete(nullptr));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db->UndoDelete(mHeader));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db->UndoDelete(detached));
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(1));
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader,
       UndoDeleteRetainsFailureThenPublishesFreshOutputs) {
  nsTArray<nsCString> references{"parent@undo.invalid"_ns, EmptyCString(),
                                 "parent@undo.invalid"_ns};
  ASSERT_NO_FATAL_FAILURE(Create(references));
  ASSERT_EQ(NS_OK, mHeader->SetStringProperty("Case", "Résumé — 雪"_ns));
  ASSERT_EQ(NS_OK, mHeader->SetStringProperty("case", "distinct"_ns));
  ASSERT_EQ(NS_OK, mHeader->SetStringProperty("presentEmpty", EmptyCString()));
  ASSERT_EQ(NS_OK, mHeader->SetUint32Property("uidOnServer", 900001));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RemovedMessage captured;
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessageForUndo(mKey, captured));
  // Native receiver fixture input; real provider Finish is exercised by the
  // retained ordinary IM caller on both stores, not manufactured by the facade.
  FinishedMessageBody finished{"new-finished"_ns, 23, 0, 2, false};
  nsMsgKey key = 42;
  RefPtr<Message> live;
  uint32_t publications = 0;
  RefPtr<DeliveryEarlyMutationListener> listener =
      new DeliveryEarlyMutationListener;
  listener->publication = [&](const CapturedMessage& after, Message* header) {
    ++publications;
    EXPECT_EQ(key, after.id);
    EXPECT_EQ(live.get(), header);
    EXPECT_NE(mKey, key);
    EXPECT_NE(900001u, key);
    EXPECT_FALSE(captured.Body());
    nsMsgKey reentrantKey = 43;
    RefPtr<Message> reentrantLive;
    EXPECT_EQ(NS_ERROR_IN_PROGRESS,
              db->UndoDeleteHdrForUndo(captured, finished, &reentrantKey,
                                       getter_AddRefs(reentrantLive)));
    EXPECT_EQ(43u, reentrantKey);
    EXPECT_FALSE(reentrantLive);
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db->UndoDelete(header));
  };
  mCore->MessageDB().AddMessageListener(listener);
  auto remove = MakeScopeExit(
      [&] { mCore->MessageDB().RemoveMessageListener(listener); });
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  EXPECT_EQ(
      NS_ERROR_IN_PROGRESS,
      db->UndoDeleteHdrForUndo(captured, finished, &key, getter_AddRefs(live)));
  EXPECT_EQ(42u, key);
  EXPECT_FALSE(live);
  ASSERT_TRUE(captured.Body());
  EXPECT_EQ(mKey, captured.Body()->key);
  EXPECT_EQ(0u, publications);
  bool active = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  ASSERT_EQ(NS_OK, db->UndoDeleteHdrForUndo(captured, finished, &key,
                                            getter_AddRefs(live)));
  ASSERT_TRUE(live);
  EXPECT_EQ(1u, publications);
  EXPECT_FALSE(captured.Body());
  nsCString value;
  ASSERT_EQ(NS_OK, live->GetStringProperty("Case", value));
  EXPECT_EQ("Résumé — 雪"_ns, value);
  ASSERT_EQ(NS_OK, live->GetStringProperty("case", value));
  EXPECT_EQ("distinct"_ns, value);
  nsTArray<nsCString> properties;
  ASSERT_EQ(NS_OK, live->GetProperties(properties));
  EXPECT_TRUE(properties.Contains("presentEmpty"_ns));
  EXPECT_FALSE(properties.Contains("uidOnServer"_ns));
  ASSERT_EQ(NS_OK, live->GetStringProperty("presentEmpty", value));
  EXPECT_TRUE(value.IsEmpty());
  ASSERT_EQ(NS_OK, live->GetStoreToken(value));
  EXPECT_EQ(finished.storeToken, value);
  nsTArray<nsCString> restoredReferences;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessageReferences(key, restoredReferences));
  EXPECT_EQ(references, restoredReferences);
  nsMsgKey duplicateKey = 44;
  RefPtr<Message> duplicate;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->UndoDeleteHdrForUndo(captured, finished, &duplicateKey,
                                     getter_AddRefs(duplicate)));
  EXPECT_EQ(44u, duplicateKey);
  EXPECT_FALSE(duplicate);
  EXPECT_EQ(1u, publications);
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader,
       UndoDeleteRejectsForeignClosedAndOccupiedInputs) {
  ASSERT_NO_FATAL_FAILURE(Create({"parent@undo.invalid"_ns}));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<Message> occupied = new Message(mKey);
  RemovedMessage captured;
  ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveMessageForUndo(mKey, captured));
  uint64_t other;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolder, "Other"_ns, &other));
  RefPtr<PerFolderDatabase> foreign = new PerFolderDatabase(other, false);
  FinishedMessageBody finished{"new-finished"_ns, 23, 0, 2, false};
  nsMsgKey key = 42;
  RefPtr<Message> live;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            foreign->UndoDeleteHdrForUndo(captured, finished, &key,
                                          getter_AddRefs(live)));
  EXPECT_EQ(NS_ERROR_NULL_POINTER,
            db->UndoDeleteHdrForUndo(captured, finished, nullptr));
  Message* occupiedSlot = occupied;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db->UndoDeleteHdrForUndo(captured, finished, &key, &occupiedSlot));
  EXPECT_EQ(occupied.get(), occupiedSlot);
  EXPECT_EQ(42u, key);
  EXPECT_FALSE(live);
  ASSERT_TRUE(captured.Body());
  EXPECT_EQ(mKey, captured.Body()->key);
  ASSERT_EQ(NS_OK, db->ForceClosed());
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      db->UndoDeleteHdrForUndo(captured, finished, &key, getter_AddRefs(live)));
  EXPECT_EQ(42u, key);
  EXPECT_FALSE(live);
  ASSERT_TRUE(captured.Body());
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(0));
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

TEST_F(DeliveryCompleteHeader,
       ParsedServerStagesMetadataAndCopyBeforePublication) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 73));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> parsed;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(parsed)));
  ASSERT_EQ(NS_OK, parsed->SetMessageId("parsed@invalid"_ns));
  ASSERT_EQ(NS_OK,
            parsed->SetReferences(
                "<parsed@invalid> <parent@invalid> <parsed@invalid>"_ns));
  ASSERT_EQ(NS_OK, parsed->SetSubject("selected"_ns));
  ASSERT_EQ(NS_OK, parsed->SetMessageSize(73));
  ASSERT_EQ(NS_OK, parsed->SetUint32Property("uidOnServer", 4001));
  ASSERT_EQ(NS_OK, parsed->SetStringProperty("opaque", "00042"_ns));
  ASSERT_EQ(NS_OK, parsed->SetStringProperty("empty", ""_ns));
  RefPtr<ParsedServerHdr> selected;
  ASSERT_EQ(NS_OK, db->StageParsedServerHdr(parsed, 73, 4001,
                                            getter_AddRefs(selected)));
  ASSERT_TRUE(selected);
  // Clearing the parser's reference does not discard the selected source.
  parsed = nullptr;
  ServerMessageLocation location;
  ASSERT_EQ(NS_OK, selected->GetLocation(location));
  EXPECT_EQ(mFolder, location.folderId);
  EXPECT_EQ(73u, location.epoch);
  EXPECT_EQ(4001u, location.uid);
  EXPECT_NE(4001u, location.key);
  EXPECT_NE(nsMsgKey_None, location.key);
  bool live = true;
  ASSERT_EQ(NS_OK, selected->GetIsLive(&live));
  EXPECT_FALSE(live);
  bool contains = true;
  ASSERT_EQ(NS_OK, db->ContainsKey(location.key, &contains));
  EXPECT_FALSE(contains);
  nsCOMPtr<nsIMsgDBHdr> ordinary;
  EXPECT_EQ(NS_ERROR_ILLEGAL_VALUE,
            db->GetMsgHdrForKey(location.key, getter_AddRefs(ordinary)));
  EXPECT_FALSE(ordinary);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(0));
  ASSERT_EQ(NS_OK, selected->MarkRead(true));
  ASSERT_EQ(NS_OK, selected->MarkFlagged(true));
  uint32_t flags;
  ASSERT_EQ(NS_OK,
            selected->OrFlags(nsMsgMessageFlags::MDNReportNeeded, &flags));
  ASSERT_EQ(NS_OK, selected->SetUint32Property("ProtoThreadFlags",
                                               nsMsgMessageFlags::Ignored));
  ASSERT_EQ(NS_OK, selected->SetStringProperty("junkscore", "100"_ns));
  ASSERT_EQ(NS_OK, selected->UpdateKeywords("tag1 tag2 tag1"_ns, true));
  ASSERT_EQ(NS_OK, selected->UpdateKeywords("tag1"_ns, false));
  nsCString keywords;
  ASSERT_EQ(NS_OK, selected->GetStringProperty("keywords", keywords));
  EXPECT_EQ("tag2"_ns, keywords);
  // The generic non-live native object is not an owning parser capability.
  RefPtr<Message> unowned = new Message(location.key);
  nsCOMPtr<nsIMsgDBHdr> copy;
  EXPECT_EQ(NS_ERROR_ILLEGAL_VALUE,
            db->CopyHdrForStore(unowned, true, getter_AddRefs(copy)));
  EXPECT_FALSE(copy);
  ASSERT_EQ(NS_OK, db->CopyHdrForStore(selected, true, getter_AddRefs(copy)));
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, copy->GetProperties(names));
  EXPECT_FALSE(names.Contains("uidOnServer"_ns));
  EXPECT_FALSE(names.Contains("storeToken"_ns));
  EXPECT_TRUE(names.Contains("empty"_ns));
  nsCString property;
  ASSERT_EQ(NS_OK, copy->GetStringProperty("opaque", property));
  EXPECT_EQ("00042"_ns, property);
  ASSERT_EQ(NS_OK, copy->GetStringProperty("junkscore", property));
  EXPECT_EQ("100"_ns, property);
  nsMsgKey copyKey = nsMsgKey_None;
  ASSERT_EQ(NS_OK, db->StageHdrForOfflineCopy(copy, &copyKey));
  nsTArray<nsCString> references;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessageReferences(copyKey, references));
  EXPECT_EQ((nsTArray<nsCString>{"parsed@invalid"_ns, "parent@invalid"_ns,
                                 "parsed@invalid"_ns}),
            references);
  ASSERT_EQ(NS_OK, mCore->MessageDB().AbortMessage(copyKey));
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(0));

  RefPtr<Message> output;
  uint32_t publications = 0;
  RefPtr<DeliveryEarlyMutationListener> listener =
      new DeliveryEarlyMutationListener;
  listener->publication = [&](const CapturedMessage& after,
                              Message* published) {
    ++publications;
    EXPECT_EQ(output.get(), published);
    EXPECT_EQ(location.key, after.id);
    EXPECT_TRUE(after.flags & nsMsgMessageFlags::Read);
    EXPECT_TRUE(after.flags & nsMsgMessageFlags::Marked);
    RefPtr<Message> reentrant;
    EXPECT_EQ(
        NS_ERROR_IN_PROGRESS,
        db->PublishParsedServerHdr(selected, true, getter_AddRefs(reentrant)));
    EXPECT_FALSE(reentrant);
    EXPECT_EQ(NS_ERROR_IN_PROGRESS, db->AbortParsedServerHdr(selected));
    EXPECT_EQ(NS_ERROR_IN_PROGRESS, selected->MarkRead(false));
  };
  mCore->MessageDB().AddMessageListener(listener);
  auto remove = MakeScopeExit(
      [&] { mCore->MessageDB().RemoveMessageListener(listener); });
  ASSERT_EQ(NS_OK,
            db->PublishParsedServerHdr(selected, true, getter_AddRefs(output)));
  ASSERT_TRUE(output);
  EXPECT_EQ(1u, publications);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(1));
  nsMsgKey physical;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageKeyForServerUid(
                       mFolder, 73, 4001, physical));
  EXPECT_EQ(location.key, physical);
  ASSERT_EQ(NS_OK, selected->GetIsLive(&live));
  EXPECT_TRUE(live);
  RefPtr<Message> repeated;
  EXPECT_EQ(
      NS_ERROR_ALREADY_INITIALIZED,
      db->PublishParsedServerHdr(selected, true, getter_AddRefs(repeated)));
  EXPECT_FALSE(repeated);
  EXPECT_EQ(1u, publications);
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader,
       ParsedServerAdmissionKeepsOwnershipAndTransaction) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 73));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> parsed;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(parsed)));
  ASSERT_EQ(NS_OK, parsed->SetMessageId("guard-parser@invalid"_ns));
  RefPtr<ParsedServerHdr> selected;
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      db->StageParsedServerHdr(parsed, 73, 4001, getter_AddRefs(selected)));
  ASSERT_EQ(NS_OK, parsed->SetUint32Property("uidOnServer", 4001));
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      db->StageParsedServerHdr(parsed, 73, 4002, getter_AddRefs(selected)));
  uint64_t other;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolder, "Other"_ns, &other));
  RefPtr<PerFolderDatabase> foreign = new PerFolderDatabase(other, false);
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            foreign->StageParsedServerHdr(parsed, 73, 4001,
                                          getter_AddRefs(selected)));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  EXPECT_EQ(
      NS_ERROR_IN_PROGRESS,
      db->StageParsedServerHdr(parsed, 73, 4001, getter_AddRefs(selected)));
  EXPECT_FALSE(selected);
  bool active = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  ASSERT_EQ(NS_OK, db->StageParsedServerHdr(parsed, 73, 4001,
                                            getter_AddRefs(selected)));
  ParsedServerHdr* occupied = selected.get();
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db->StageParsedServerHdr(parsed, 73, 4001, &occupied));
  EXPECT_EQ(selected.get(), occupied);
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            parsed->SetSubject("cannot replay parser"_ns));
  RefPtr<Message> output;
  EXPECT_EQ(NS_ERROR_INVALID_ARG, foreign->PublishParsedServerHdr(
                                      selected, false, getter_AddRefs(output)));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, selected->MarkRead(true));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db->PublishParsedServerHdr(
                                      selected, false, getter_AddRefs(output)));
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  ServerMessageLocation location;
  ASSERT_EQ(NS_OK, selected->GetLocation(location));
  RefPtr<Message> existing = new Message(location.key);
  Message* slot = existing.get();
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db->PublishParsedServerHdr(selected, false, &slot));
  EXPECT_EQ(existing.get(), slot);
  EXPECT_EQ(NS_ERROR_NULL_POINTER,
            db->PublishParsedServerHdr(selected, false, nullptr));
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            selected->SetUint32Property("uidOnServer", 9));
  EXPECT_EQ(NS_ERROR_INVALID_ARG, selected->SetStoreToken("invented"_ns));
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            selected->SetFlags(nsMsgMessageFlags::Offline));
  ASSERT_EQ(NS_OK, db->PublishParsedServerHdr(selected, false,
                                              getter_AddRefs(output)));
  ASSERT_TRUE(output);
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, ParsedServerRejectsDuplicateAndRetiredUid) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 73));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> first, second;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(first)));
  ASSERT_EQ(NS_OK, first->SetMessageId("first-parser@invalid"_ns));
  ASSERT_EQ(NS_OK, first->SetUint32Property("uidOnServer", 4001));
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(second)));
  ASSERT_EQ(NS_OK, second->SetMessageId("second-parser@invalid"_ns));
  ASSERT_EQ(NS_OK, second->SetUint32Property("uidOnServer", 4001));
  RefPtr<ParsedServerHdr> selected, duplicate;
  ASSERT_EQ(NS_OK, db->StageParsedServerHdr(first, 73, 4001,
                                            getter_AddRefs(selected)));
  EXPECT_EQ(
      NS_ERROR_ALREADY_INITIALIZED,
      db->StageParsedServerHdr(second, 73, 4001, getter_AddRefs(duplicate)));
  EXPECT_FALSE(duplicate);
  ServerMessageLocation location;
  ASSERT_EQ(NS_OK, selected->GetLocation(location));
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 74));
  ServerMessageLocation canary = location;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, selected->GetLocation(canary));
  EXPECT_EQ(location.key, canary.key);
  EXPECT_EQ(location.epoch, canary.epoch);
  RefPtr<Message> output;
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      db->PublishParsedServerHdr(selected, false, getter_AddRefs(output)));
  EXPECT_FALSE(output);
  bool live = true;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(location.key, live));
  EXPECT_FALSE(live);
  ASSERT_EQ(NS_OK, db->AbortParsedServerHdr(selected));
  nsTArray<nsMsgKey> staged;
  ASSERT_EQ(NS_OK, mCore->MessageDB().ListStagedMessages(mFolder, staged));
  EXPECT_TRUE(staged.IsEmpty());
  EXPECT_EQ(NS_ERROR_ABORT, selected->MarkRead(true));
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(0));
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, ParsedServerMutationFailureRetainsFirstError) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 73));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> parsed;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(parsed)));
  ASSERT_EQ(NS_OK, parsed->SetMessageId("fault-parser@invalid"_ns));
  ASSERT_EQ(NS_OK, parsed->SetUint32Property("uidOnServer", 4001));
  RefPtr<ParsedServerHdr> selected;
  ASSERT_EQ(NS_OK, db->StageParsedServerHdr(parsed, 73, 4001,
                                            getter_AddRefs(selected)));
  ServerMessageLocation location;
  ASSERT_EQ(NS_OK, selected->GetLocation(location));
  ASSERT_EQ(
      NS_OK,
      Connection()->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER delivery_parser_flag_failure BEFORE UPDATE OF "
          "flags "
          "ON main.staged_messages BEGIN SELECT RAISE(ABORT,'parser flag failure'); END"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, selected->MarkRead(true));
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "DROP TRIGGER delivery_parser_flag_failure"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, selected->MarkRead(false));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            parsed->SetSubject("must not replay"_ns));
  RefPtr<Message> output;
  EXPECT_EQ(
      NS_ERROR_STORAGE_CONSTRAINT,
      db->PublishParsedServerHdr(selected, false, getter_AddRefs(output)));
  EXPECT_FALSE(output);
  nsTArray<nsMsgKey> staged;
  ASSERT_EQ(NS_OK, mCore->MessageDB().ListStagedMessages(mFolder, staged));
  EXPECT_EQ((nsTArray<nsMsgKey>{location.key}), staged);
  ASSERT_EQ(NS_OK, db->AbortParsedServerHdr(selected));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, selected->MarkRead(false));
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(0));
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, ParsedServerPublicationFailureDoesNotReplay) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 73));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> parsed;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(parsed)));
  ASSERT_EQ(NS_OK, parsed->SetMessageId("publish-fault-parser@invalid"_ns));
  ASSERT_EQ(NS_OK, parsed->SetUint32Property("uidOnServer", 4001));
  RefPtr<ParsedServerHdr> selected;
  ASSERT_EQ(NS_OK, db->StageParsedServerHdr(parsed, 73, 4001,
                                            getter_AddRefs(selected)));
  ASSERT_EQ(
      NS_OK,
      Connection()->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER delivery_parser_publish_failure BEFORE INSERT "
          "ON main.messages BEGIN SELECT RAISE(ABORT,'parser publish failure'); END"_ns));
  RefPtr<Message> output;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db->PublishParsedServerHdr(selected, true, getter_AddRefs(output)));
  EXPECT_FALSE(output);
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "DROP TRIGGER delivery_parser_publish_failure"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db->PublishParsedServerHdr(selected, true, getter_AddRefs(output)));
  EXPECT_FALSE(output);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(0));
  ASSERT_EQ(NS_OK, db->AbortParsedServerHdr(selected));
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, ParsedServerClosedOwnerKeepsUnpublishedSource) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 73));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> parsed;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(parsed)));
  ASSERT_EQ(NS_OK, parsed->SetMessageId("closed-parser@invalid"_ns));
  ASSERT_EQ(NS_OK, parsed->SetUint32Property("uidOnServer", 4001));
  RefPtr<ParsedServerHdr> selected;
  ASSERT_EQ(NS_OK, db->StageParsedServerHdr(parsed, 73, 4001,
                                            getter_AddRefs(selected)));
  ServerMessageLocation location;
  ASSERT_EQ(NS_OK, selected->GetLocation(location));
  ASSERT_EQ(NS_OK, db->ForceClosed());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, selected->MarkRead(true));
  RefPtr<Message> output;
  EXPECT_EQ(
      NS_ERROR_NOT_AVAILABLE,
      db->PublishParsedServerHdr(selected, false, getter_AddRefs(output)));
  EXPECT_FALSE(output);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db->AbortParsedServerHdr(selected));
  selected = nullptr;
  nsTArray<nsMsgKey> staged;
  ASSERT_EQ(NS_OK, mCore->MessageDB().ListStagedMessages(mFolder, staged));
  EXPECT_EQ((nsTArray<nsMsgKey>{location.key}), staged);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(0));
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, ParsedServerNewIntentPrecedesLegacyPublication) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 73));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<DeliveryCapturedLegacyListener> listener =
      new DeliveryCapturedLegacyListener(db);
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto remove = MakeScopeExit([&] { db->RemoveListener(listener); });
  nsTArray<nsMsgKey> expectedNew;
  for (uint32_t action = 0; action < 7; ++action) {
    nsCOMPtr<nsIMsgDBHdr> parsed;
    ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(parsed)));
    ASSERT_EQ(NS_OK, parsed->SetMessageId("parser-new@invalid"_ns));
    ASSERT_EQ(NS_OK, parsed->SetUint32Property("uidOnServer", 4001 + action));
    RefPtr<ParsedServerHdr> selected;
    ASSERT_EQ(NS_OK, db->StageParsedServerHdr(parsed, 73, 4001 + action,
                                              getter_AddRefs(selected)));
    uint32_t flags = 0;
    switch (action) {
      case 1:
      case 3:
      case 4:
      case 6:
        // Clearing an already absent raw bit still expresses filter intent.
        ASSERT_EQ(NS_OK, selected->AndFlags(~nsMsgMessageFlags::New, &flags));
        if (action == 3) {
          ASSERT_EQ(NS_OK, selected->OrFlags(nsMsgMessageFlags::New, &flags));
        } else if (action == 4) {
          ASSERT_EQ(NS_OK, selected->SetFlags(nsMsgMessageFlags::New));
        }
        break;
      case 2:
        ASSERT_EQ(NS_OK, selected->SetFlags(nsMsgMessageFlags::Marked));
        break;
      case 5:
        ASSERT_EQ(NS_OK, selected->OrFlags(nsMsgMessageFlags::Marked, &flags));
        break;
    }
    bool expectNew = action == 0 || action == 3 || action == 4 || action == 5;
    ServerMessageLocation location;
    ASSERT_EQ(NS_OK, selected->GetLocation(location));
    RefPtr<Message> output;
    uint32_t eventCount = listener->events.Length();
    ASSERT_EQ(NS_OK, db->PublishParsedServerHdr(selected, action != 6,
                                                getter_AddRefs(output)));
    ASSERT_TRUE(output);
    if (expectNew) {
      expectedNew.AppendElement(location.key);
    }
    nsTArray<nsMsgKey> actualNew;
    ASSERT_EQ(NS_OK, db->GetNewList(actualNew));
    EXPECT_EQ(expectedNew, actualNew);
    CapturedMessage stored;
    ASSERT_EQ(NS_OK, mCore->MessageDB().CaptureMessage(location.key, stored));
    EXPECT_FALSE(stored.flags & nsMsgMessageFlags::Read);
    if (action != 6) {
      ASSERT_EQ(eventCount + 1, listener->events.Length());
      const auto& event = listener->events.LastElement();
      EXPECT_EQ('A', event.kind);
      EXPECT_EQ(location.key, event.key);
      EXPECT_EQ(expectNew, bool(event.flags & nsMsgMessageFlags::New));
      EXPECT_FALSE(event.flags & nsMsgMessageFlags::Read);
      EXPECT_EQ(expectedNew, event.newKeys);
      if (!expectNew) {
        EXPECT_FALSE(event.liveFlags & nsMsgMessageFlags::New);
      }
    } else {
      EXPECT_EQ(eventCount, listener->events.Length());
    }
  }
  // Unrelated ordinary native publishers retain their unread-to-New default.
  RawHdr raw{};
  raw.messageId = "ordinary-new@invalid"_ns;
  nsMsgKey ordinary;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().AddMessage(mFolder, raw, true, &ordinary));
  expectedNew.AppendElement(ordinary);
  nsTArray<nsMsgKey> actualNew;
  ASSERT_EQ(NS_OK, db->GetNewList(actualNew));
  EXPECT_EQ(expectedNew, actualNew);
  EXPECT_TRUE(listener->events.LastElement().flags & nsMsgMessageFlags::New);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(8));
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, ParsedServerNewIntentSurvivesQueuedPublication) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 73));
  auto& native = mCore->MessageDB();
  RefPtr<DeliveryEarlyMutationListener> early =
      new DeliveryEarlyMutationListener;
  native.AddMessageListener(early);
  auto unwatch = MakeScopeExit([&] { native.RemoveMessageListener(early); });
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<DeliveryCapturedLegacyListener> listener =
      new DeliveryCapturedLegacyListener(db);
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto remove = MakeScopeExit([&] { db->RemoveListener(listener); });
  nsCOMPtr<nsIMsgDBHdr> parsed;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(parsed)));
  ASSERT_EQ(NS_OK, parsed->SetMessageId("queued-not-new@invalid"_ns));
  ASSERT_EQ(NS_OK, parsed->SetUint32Property("uidOnServer", 4001));
  RefPtr<ParsedServerHdr> selected;
  ASSERT_EQ(NS_OK, db->StageParsedServerHdr(parsed, 73, 4001,
                                            getter_AddRefs(selected)));
  uint32_t flags;
  ASSERT_EQ(NS_OK, selected->AndFlags(~nsMsgMessageFlags::New, &flags));
  ServerMessageLocation location;
  ASSERT_EQ(NS_OK, selected->GetLocation(location));
  RefPtr<Message> output;
  bool queued = false;
  uint32_t selectedCallbacks = 0;
  early->publication = [&](const CapturedMessage& after, Message* live) {
    if (after.id == location.key) {
      ++selectedCallbacks;
      EXPECT_EQ(output.get(), live);
      EXPECT_FALSE(selected);
      EXPECT_FALSE(after.flags & nsMsgMessageFlags::New);
      EXPECT_FALSE(after.flags & nsMsgMessageFlags::Read);
      return;
    }
    ASSERT_FALSE(queued);
    queued = true;
    EXPECT_EQ(NS_OK, db->PublishParsedServerHdr(selected, true,
                                                getter_AddRefs(output)));
    EXPECT_TRUE(output);
    EXPECT_EQ(0u, selectedCallbacks);
    EXPECT_TRUE(listener->events.IsEmpty());
    RefPtr<Message> repeated;
    EXPECT_EQ(
        NS_ERROR_ALREADY_INITIALIZED,
        db->PublishParsedServerHdr(selected, true, getter_AddRefs(repeated)));
    EXPECT_FALSE(repeated);
    // Both caller references can disappear before the queued callback.
    selected = nullptr;
    parsed = nullptr;
  };
  RawHdr raw{};
  raw.messageId = "outer-default-new@invalid"_ns;
  nsMsgKey outer;
  ASSERT_EQ(NS_OK, native.AddMessage(mFolder, raw, true, &outer));
  EXPECT_TRUE(queued);
  EXPECT_EQ(1u, selectedCallbacks);
  ASSERT_EQ(2u, listener->events.Length());
  EXPECT_EQ(outer, listener->events[0].key);
  EXPECT_TRUE(listener->events[0].flags & nsMsgMessageFlags::New);
  const auto& added = listener->events[1];
  EXPECT_EQ(location.key, added.key);
  EXPECT_FALSE(added.flags & nsMsgMessageFlags::New);
  EXPECT_FALSE(added.liveFlags & nsMsgMessageFlags::New);
  EXPECT_FALSE(added.flags & nsMsgMessageFlags::Read);
  EXPECT_EQ((nsTArray<nsMsgKey>{outer}), added.newKeys);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(2));
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, ParsedServerNewFailureRetainsCustody) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().SetFolderUidValidity(mFolder, 73));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> parsed;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(parsed)));
  ASSERT_EQ(NS_OK, parsed->SetMessageId("not-new-failure@invalid"_ns));
  ASSERT_EQ(NS_OK, parsed->SetUint32Property("uidOnServer", 4001));
  RefPtr<ParsedServerHdr> selected;
  ASSERT_EQ(NS_OK, db->StageParsedServerHdr(parsed, 73, 4001,
                                            getter_AddRefs(selected)));
  uint32_t flags;
  ASSERT_EQ(NS_OK, selected->AndFlags(~nsMsgMessageFlags::New, &flags));
  ServerMessageLocation location;
  ASSERT_EQ(NS_OK, selected->GetLocation(location));
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER delivery_not_new_failure BEFORE "
                       "INSERT ON main.messages BEGIN SELECT "
                       "RAISE(ABORT,'not new failure'); END"_ns));
  RefPtr<Message> output;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db->PublishParsedServerHdr(selected, true, getter_AddRefs(output)));
  EXPECT_FALSE(output);
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "DROP TRIGGER delivery_not_new_failure"_ns));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            selected->OrFlags(nsMsgMessageFlags::New, &flags));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db->PublishParsedServerHdr(selected, true, getter_AddRefs(output)));
  EXPECT_FALSE(output);
  nsTArray<nsMsgKey> staged, newKeys;
  ASSERT_EQ(NS_OK, mCore->MessageDB().ListStagedMessages(mFolder, staged));
  EXPECT_EQ((nsTArray<nsMsgKey>{location.key}), staged);
  ASSERT_EQ(NS_OK, db->GetNewList(newKeys));
  EXPECT_TRUE(newKeys.IsEmpty());
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(0));
  ASSERT_EQ(NS_OK, db->AbortParsedServerHdr(selected));
  RawHdr raw{};
  raw.messageId = "after-not-new-failure@invalid"_ns;
  nsMsgKey ordinary;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().AddMessage(mFolder, raw, true, &ordinary));
  ASSERT_EQ(NS_OK, db->GetNewList(newKeys));
  EXPECT_EQ((nsTArray<nsMsgKey>{ordinary}), newKeys);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(1));
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, FolderRepairRetainsParsedDraftsUntilSettlement) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RawHdr old{};
  old.messageId = "old-repair@invalid"_ns;
  old.subject = "old subject"_ns;
  old.references = {"stale@invalid"_ns};
  old.flags = nsMsgMessageFlags::Read | nsMsgMessageFlags::Marked;
  old.keywords = "keep-tag"_ns;
  old.priority = nsMsgPriority::high;
  old.storeToken = Some("repair-old"_ns);
  old.messageSize = Some(91u);
  old.lineCount = Some(4u);
  nsMsgKey originalKey;
  RefPtr<Message> original;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().AddMessage(mFolder, old, false, &originalKey,
                                          getter_AddRefs(original)));
  ASSERT_EQ(NS_OK, original->SetStringProperty("opaque", "0007"_ns));
  ASSERT_EQ(NS_OK, original->SetStringProperty("empty", ""_ns));
  RefPtr<FolderRepair> repair;
  ASSERT_EQ(NS_OK, db->BeginFolderRepair(getter_AddRefs(repair)));
  bool valid = true;
  ASSERT_EQ(NS_OK, db->GetSummaryValid(&valid));
  EXPECT_FALSE(valid);

  nsCOMPtr<nsIMsgDBHdr> parsed;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(parsed)));
  ASSERT_EQ(NS_OK, parsed->SetMessageId("repaired@invalid"_ns));
  ASSERT_EQ(NS_OK, parsed->SetSubject("repaired subject"_ns));
  ASSERT_EQ(NS_OK,
            parsed->SetReferences("<a@invalid> <a@invalid> <b@invalid>"_ns));
  ASSERT_EQ(NS_OK, parsed->SetStoreToken("repair-old"_ns));
  ASSERT_EQ(NS_OK, parsed->SetMessageSize(37));
  ASSERT_EQ(NS_OK, parsed->SetLineCount(2));
  ASSERT_EQ(NS_OK, parsed->SetPriority(nsMsgPriority::low));
  ASSERT_EQ(NS_OK, parsed->SetStringProperty("keywords", "replace-tag"_ns));
  ASSERT_EQ(NS_OK,
            db->AddFolderRepairMessage(repair, parsed, "repair-old"_ns, 37));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, parsed->SetSubject("late mutation"_ns));
  parsed = nullptr;  // The ordinary parser may clear its own header now.

  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(parsed)));
  ASSERT_EQ(NS_OK, parsed->SetMessageId("new-repair@invalid"_ns));
  ASSERT_EQ(NS_OK, parsed->SetReferences(""_ns));
  // Normal parser drafts have no physical key; settlement allocates a fresh
  // one.
  nsMsgKey parsedKey = originalKey;
  ASSERT_EQ(NS_OK, parsed->GetMessageKey(&parsedKey));
  EXPECT_EQ(nsMsgKey_None, parsedKey);
  ASSERT_EQ(NS_OK, parsed->SetStoreToken("repair-new"_ns));
  ASSERT_EQ(NS_OK, parsed->SetMessageSize(19));
  ASSERT_EQ(NS_OK, parsed->SetLineCount(1));
  ASSERT_EQ(NS_OK,
            db->AddFolderRepairMessage(repair, parsed, "repair-new"_ns, 19));
  parsed = nullptr;
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(1));
  nsCString subject;
  ASSERT_EQ(NS_OK, original->GetSubject(subject));
  EXPECT_EQ("old subject"_ns, subject);

  nsTArray<RefPtr<Message>> outputs;
  uint32_t callbacks = 0;
  RefPtr<DeliveryEarlyMutationListener> listener =
      new DeliveryEarlyMutationListener;
  listener->body = [&](const MessageBodyState& after) {
    ++callbacks;
    EXPECT_EQ(originalKey, after.key);
    EXPECT_EQ(2u, outputs.Length());
    EXPECT_EQ(originalKey, outputs[0]->Key());
    nsCString currentSubject;
    EXPECT_EQ(NS_OK, original->GetSubject(currentSubject));
    EXPECT_EQ("repaired subject"_ns, currentSubject);
    bool complete = false;
    EXPECT_EQ(NS_OK, db->GetSummaryValid(&complete));
    EXPECT_TRUE(complete);
    nsTArray<RefPtr<Message>> nested;
    EXPECT_EQ(NS_ERROR_IN_PROGRESS,
              db->CommitFolderRepair(repair, NS_OK, true, nested));
    EXPECT_TRUE(nested.IsEmpty());
    EXPECT_EQ(NS_ERROR_IN_PROGRESS,
              db->AbortFolderRepair(repair, NS_ERROR_ABORT));
    EXPECT_EQ(NS_ERROR_IN_PROGRESS,
              db->AddFolderRepairMessage(repair, nullptr, "reentry"_ns, 1));
  };
  mCore->MessageDB().AddMessageListener(listener);
  auto unwatch = MakeScopeExit(
      [&] { mCore->MessageDB().RemoveMessageListener(listener); });
  ASSERT_EQ(NS_OK, db->CommitFolderRepair(repair, NS_OK, true, outputs));
  EXPECT_EQ(1u, callbacks);
  ASSERT_EQ(2u, outputs.Length());
  EXPECT_EQ(originalKey, outputs[0]->Key());
  EXPECT_NE(originalKey, outputs[1]->Key());
  ASSERT_EQ(NS_OK, original->GetSubject(subject));
  EXPECT_EQ("repaired subject"_ns, subject);
  uint32_t flags;
  ASSERT_EQ(NS_OK, outputs[0]->GetFlags(&flags));
  EXPECT_EQ(old.flags, flags);
  nsMsgPriorityValue priority;
  ASSERT_EQ(NS_OK, outputs[0]->GetPriority(&priority));
  EXPECT_EQ(nsMsgPriority::high, priority);
  nsCString property;
  ASSERT_EQ(NS_OK, outputs[0]->GetStringProperty("keywords", property));
  EXPECT_EQ("keep-tag"_ns, property);
  ASSERT_EQ(NS_OK, outputs[0]->GetStringProperty("opaque", property));
  EXPECT_EQ("0007"_ns, property);
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, outputs[0]->GetProperties(names));
  EXPECT_TRUE(names.Contains("empty"_ns));
  nsTArray<nsCString> references;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetMessageReferences(originalKey, references));
  EXPECT_EQ(
      (nsTArray<nsCString>{"a@invalid"_ns, "a@invalid"_ns, "b@invalid"_ns}),
      references);
  references.Clear();
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageReferences(outputs[1]->Key(),
                                                           references));
  EXPECT_TRUE(
      references.IsEmpty());  // Known empty, not absent References state.
  uint32_t size;
  ASSERT_EQ(NS_OK, outputs[0]->GetMessageSize(&size));
  EXPECT_EQ(37u, size);  // Measured bytes repair a wrong old summary size.
  ASSERT_EQ(NS_OK, db->GetSummaryValid(&valid));
  EXPECT_TRUE(valid);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(2));
  nsTArray<RefPtr<Message>> repeated;
  EXPECT_EQ(NS_ERROR_ALREADY_INITIALIZED,
            db->CommitFolderRepair(repair, NS_OK, true, repeated));
  EXPECT_TRUE(repeated.IsEmpty());
  EXPECT_EQ(NS_ERROR_ALREADY_INITIALIZED,
            db->AbortFolderRepair(repair, NS_ERROR_ABORT));
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, FolderRepairDuplicateRetainsFirstError) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<FolderRepair> repair;
  ASSERT_EQ(NS_OK, db->BeginFolderRepair(getter_AddRefs(repair)));
  nsCOMPtr<nsIMsgDBHdr> first, second;
  for (auto* output : {&first, &second}) {
    ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(*output)));
    ASSERT_EQ(NS_OK, (*output)->SetReferences(""_ns));
    ASSERT_EQ(NS_OK, (*output)->SetStoreToken("same-token"_ns));
    ASSERT_EQ(NS_OK, (*output)->SetMessageSize(17));
    ASSERT_EQ(NS_OK, (*output)->SetLineCount(1));
  }
  ASSERT_EQ(NS_OK,
            db->AddFolderRepairMessage(repair, first, "same-token"_ns, 17));
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db->AddFolderRepairMessage(repair, second, "same-token"_ns, 17));
  EXPECT_EQ(NS_ERROR_INVALID_ARG, first->SetSubject("not editable"_ns));
  nsTArray<RefPtr<Message>> outputs;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db->CommitFolderRepair(repair, NS_ERROR_FAILURE, true, outputs));
  EXPECT_TRUE(outputs.IsEmpty());
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db->AbortFolderRepair(repair, NS_ERROR_ABORT));
  nsTArray<nsMsgKey> staged;
  ASSERT_EQ(NS_OK, mCore->MessageDB().ListStagedMessages(mFolder, staged));
  EXPECT_TRUE(staged.IsEmpty());
  bool valid = true;
  ASSERT_EQ(NS_OK, db->GetSummaryValid(&valid));
  EXPECT_FALSE(valid);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(0));
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, FolderRepairAdmissionPreservesCallerAndOutputs) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RawHdr old{};
  old.messageId = "admission@repair.invalid"_ns;
  old.storeToken = Some("admission-token"_ns);
  old.messageSize = Some(20u);
  old.lineCount = Some(1u);
  nsMsgKey key;
  RefPtr<Message> original;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolder, old, false, &key,
                                                 getter_AddRefs(original)));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  RefPtr<FolderRepair> repair;
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db->BeginFolderRepair(getter_AddRefs(repair)));
  EXPECT_FALSE(repair);
  bool active = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  ASSERT_EQ(NS_OK, db->BeginFolderRepair(getter_AddRefs(repair)));
  FolderRepair* occupied = repair.get();
  EXPECT_EQ(NS_ERROR_INVALID_ARG, db->BeginFolderRepair(&occupied));
  EXPECT_EQ(repair.get(), occupied);
  RefPtr<PerFolderDatabase> other = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> parsed;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(parsed)));
  ASSERT_EQ(NS_OK, parsed->SetReferences(""_ns));
  ASSERT_EQ(NS_OK, parsed->SetStoreToken("admission-token"_ns));
  ASSERT_EQ(NS_OK, parsed->SetMessageSize(21));
  ASSERT_EQ(NS_OK, parsed->SetLineCount(2));
  EXPECT_EQ(
      NS_ERROR_INVALID_ARG,
      other->AddFolderRepairMessage(repair, parsed, "admission-token"_ns, 21));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  EXPECT_EQ(
      NS_ERROR_IN_PROGRESS,
      db->AddFolderRepairMessage(repair, parsed, "admission-token"_ns, 21));
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  ASSERT_EQ(NS_OK, db->AddFolderRepairMessage(repair, parsed,
                                              "admission-token"_ns, 21));
  nsTArray<RefPtr<Message>> outputs{original};
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db->CommitFolderRepair(repair, NS_OK, true, outputs));
  ASSERT_EQ(1u, outputs.Length());
  EXPECT_EQ(original.get(), outputs[0].get());
  outputs.Clear();
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db->CommitFolderRepair(repair, NS_OK, true, outputs));
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  EXPECT_TRUE(outputs.IsEmpty());
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  ASSERT_EQ(NS_OK, db->CommitFolderRepair(repair, NS_OK, true, outputs));
  ASSERT_EQ(1u, outputs.Length());
  EXPECT_EQ(key, outputs[0]->Key());
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, FolderRepairScanAndClosedOwnerRetainRows) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RawHdr old{};
  old.messageId = "retained@repair.invalid"_ns;
  old.subject = "retained"_ns;
  old.storeToken = Some("retained-token"_ns);
  old.messageSize = Some(33u);
  old.lineCount = Some(2u);
  nsMsgKey key;
  RefPtr<Message> original;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolder, old, false, &key,
                                                 getter_AddRefs(original)));
  RefPtr<FolderRepair> repair;
  ASSERT_EQ(NS_OK, db->BeginFolderRepair(getter_AddRefs(repair)));
  nsCOMPtr<nsIMsgDBHdr> parsed;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(parsed)));
  ASSERT_EQ(NS_OK, parsed->SetReferences(""_ns));
  ASSERT_EQ(NS_OK, parsed->SetSubject("must not publish"_ns));
  ASSERT_EQ(NS_OK, parsed->SetStoreToken("retained-token"_ns));
  ASSERT_EQ(NS_OK, parsed->SetMessageSize(34));
  ASSERT_EQ(NS_OK, parsed->SetLineCount(3));
  ASSERT_EQ(NS_OK, db->AddFolderRepairMessage(repair, parsed,
                                              "retained-token"_ns, 34));
  nsTArray<RefPtr<Message>> outputs;
  EXPECT_EQ(NS_ERROR_FAILURE,
            db->CommitFolderRepair(repair, NS_ERROR_FAILURE, true, outputs));
  EXPECT_TRUE(outputs.IsEmpty());
  EXPECT_EQ(NS_ERROR_FAILURE, db->AbortFolderRepair(repair, NS_ERROR_ABORT));
  nsCString subject;
  ASSERT_EQ(NS_OK, original->GetSubject(subject));
  EXPECT_EQ("retained"_ns, subject);
  RefPtr<PerFolderDatabase> reopened = new PerFolderDatabase(mFolder, false);
  bool valid = true;
  ASSERT_EQ(NS_OK, reopened->GetSummaryValid(&valid));
  EXPECT_FALSE(valid);
  RefPtr<FolderRepair> closed;
  ASSERT_EQ(NS_OK, reopened->BeginFolderRepair(getter_AddRefs(closed)));
  ASSERT_EQ(NS_OK, reopened->ForceClosed());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            reopened->CommitFolderRepair(closed, NS_OK, true, outputs));
  EXPECT_TRUE(outputs.IsEmpty());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            reopened->AbortFolderRepair(closed, NS_ERROR_ABORT));
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(1));
  ASSERT_EQ(NS_OK, original->GetSubject(subject));
  EXPECT_EQ("retained"_ns, subject);
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, FolderRepairReceiverFailureKeepsSummaryInvalid) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RawHdr old{};
  old.messageId = "receiver@repair.invalid"_ns;
  old.subject = "old receiver"_ns;
  old.storeToken = Some("receiver-token"_ns);
  old.messageSize = Some(41u);
  old.lineCount = Some(2u);
  nsMsgKey key;
  RefPtr<Message> original;
  ASSERT_EQ(NS_OK, mCore->MessageDB().AddMessage(mFolder, old, false, &key,
                                                 getter_AddRefs(original)));
  RefPtr<FolderRepair> repair;
  ASSERT_EQ(NS_OK, db->BeginFolderRepair(getter_AddRefs(repair)));
  nsCOMPtr<nsIMsgDBHdr> parsed;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(parsed)));
  ASSERT_EQ(NS_OK, parsed->SetReferences(""_ns));
  ASSERT_EQ(NS_OK, parsed->SetSubject("new receiver"_ns));
  ASSERT_EQ(NS_OK, parsed->SetStoreToken("receiver-token"_ns));
  ASSERT_EQ(NS_OK, parsed->SetMessageSize(42));
  ASSERT_EQ(NS_OK, parsed->SetLineCount(3));
  ASSERT_EQ(NS_OK, db->AddFolderRepairMessage(repair, parsed,
                                              "receiver-token"_ns, 42));
  // A reached receiver write failure must not make any repaired row visible.
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER delivery_repair_failure BEFORE "
                       "UPDATE ON main.messages BEGIN SELECT "
                       "RAISE(ABORT,'repair receiver failure'); END"_ns));
  auto remove = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "DROP TRIGGER delivery_repair_failure"_ns));
  });
  nsTArray<RefPtr<Message>> outputs;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db->CommitFolderRepair(repair, NS_OK, true, outputs));
  EXPECT_TRUE(outputs.IsEmpty());
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db->CommitFolderRepair(repair, NS_OK, true, outputs));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db->AbortFolderRepair(repair, NS_ERROR_ABORT));
  nsCString subject;
  ASSERT_EQ(NS_OK, original->GetSubject(subject));
  EXPECT_EQ("old receiver"_ns, subject);
  RefPtr<PerFolderDatabase> reopened = new PerFolderDatabase(mFolder, false);
  bool valid = true;
  ASSERT_EQ(NS_OK, reopened->GetSummaryValid(&valid));
  EXPECT_FALSE(valid);
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(1));
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, FolderRepairRejectsMissingPhysicalInputs) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  for (uint32_t variant = 0; variant < 5; ++variant) {
    RefPtr<FolderRepair> repair;
    ASSERT_EQ(NS_OK, db->BeginFolderRepair(getter_AddRefs(repair)));
    nsCOMPtr<nsIMsgDBHdr> parsed;
    ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(parsed)));
    ASSERT_EQ(NS_OK, parsed->SetReferences(""_ns));
    if (variant != 0) {
      ASSERT_EQ(NS_OK, parsed->SetStoreToken("physical-input"_ns));
    }
    ASSERT_EQ(NS_OK, parsed->SetMessageSize(3));
    if (variant != 1) {
      ASSERT_EQ(NS_OK, parsed->SetLineCount(1));
    }
    uint64_t measured = variant == 2   ? uint64_t(UINT32_MAX) + 1
                        : variant == 3 ? 4
                                       : 3;
    nsresult expected =
        variant == 2 ? NS_ERROR_FILE_TOO_BIG : NS_ERROR_INVALID_ARG;
    nsTArray<RefPtr<Message>> outputs;
    if (variant == 4) {
      ASSERT_EQ(NS_OK, db->AddFolderRepairMessage(
                           repair, parsed, "physical-input"_ns, measured));
      expected = NS_ERROR_NOT_AVAILABLE;
      EXPECT_EQ(expected,
                db->CommitFolderRepair(repair, NS_OK, false, outputs));
    } else {
      EXPECT_EQ(expected, db->AddFolderRepairMessage(
                              repair, parsed, "physical-input"_ns, measured));
    }
    EXPECT_EQ(expected, db->CommitFolderRepair(repair, NS_OK, true, outputs));
    EXPECT_TRUE(outputs.IsEmpty());
    EXPECT_EQ(expected, db->AbortFolderRepair(repair, NS_ERROR_ABORT));
    bool valid = true;
    ASSERT_EQ(NS_OK, db->GetSummaryValid(&valid));
    EXPECT_FALSE(valid);
    ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(0));
    CheckNoTransaction();
  }
}

TEST_F(DeliveryCompleteHeader, FolderRepairRejectsForeignDraftIncarnation) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  // Model an old parser draft without replacing the normal fixture/profile.
  // The transactional source-identity fault is rolled back before repair.
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
    if (active) {
      EXPECT_EQ(NS_OK, Connection()->RollbackTransaction());
    }
  });
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "UPDATE database_identity SET sourceId = "
                       "'{7a139b24-9c50-47fa-8322-168da90748c0}'"_ns));
  RefPtr<PerFolderDatabase> foreign = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsIMsgDBHdr> draft;
  ASSERT_EQ(NS_OK, foreign->CreateNewHdr(getter_AddRefs(draft)));
  ASSERT_EQ(NS_OK, draft->SetReferences(""_ns));
  ASSERT_EQ(NS_OK, draft->SetStoreToken("foreign-draft"_ns));
  ASSERT_EQ(NS_OK, draft->SetMessageSize(3));
  ASSERT_EQ(NS_OK, draft->SetLineCount(1));
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  rollback.release();
  RefPtr<FolderRepair> repair;
  ASSERT_EQ(NS_OK, db->BeginFolderRepair(getter_AddRefs(repair)));
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db->AddFolderRepairMessage(repair, draft, "foreign-draft"_ns, 3));
  // Foreign input ownership was not consumed or silently retargeted.
  EXPECT_EQ(NS_OK, draft->SetSubject("foreign recovery"_ns));
  nsTArray<RefPtr<Message>> outputs;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db->CommitFolderRepair(repair, NS_OK, true, outputs));
  EXPECT_TRUE(outputs.IsEmpty());
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db->AbortFolderRepair(repair, NS_ERROR_ABORT));
  ASSERT_NO_FATAL_FAILURE(CheckParentBridgeCount(0));
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, FolderRepairSummarySurvivesFacadeReopen) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  bool valid = false;
  ASSERT_EQ(NS_OK, db->GetSummaryValid(&valid));
  EXPECT_TRUE(valid);
  ASSERT_EQ(NS_OK, db->SetSummaryValid(false));
  RefPtr<PerFolderDatabase> reopened = new PerFolderDatabase(mFolder, false);
  valid = true;
  ASSERT_EQ(NS_OK, reopened->GetSummaryValid(&valid));
  EXPECT_FALSE(valid);
  ASSERT_EQ(NS_OK, reopened->SetSummaryValid(true));
  ASSERT_EQ(NS_OK, db->GetSummaryValid(&valid));
  EXPECT_TRUE(valid);
  ASSERT_EQ(NS_OK, db->ForceClosed());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db->SetSummaryValid(false));
  valid = true;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db->GetSummaryValid(&valid));
  EXPECT_FALSE(valid);
  ASSERT_EQ(NS_OK, reopened->GetSummaryValid(&valid));
  EXPECT_TRUE(valid);
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, FolderRepairSummaryLeavesCallerTransaction) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  ASSERT_EQ(NS_OK, db->SetSummaryValid(false));
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
    if (active) {
      EXPECT_EQ(NS_OK, Connection()->RollbackTransaction());
    }
  });
  EXPECT_EQ(NS_ERROR_IN_PROGRESS, db->SetSummaryValid(true));
  bool active = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  bool valid = true;
  ASSERT_EQ(NS_OK, db->GetSummaryValid(&valid));
  EXPECT_FALSE(valid);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  rollback.release();
  ASSERT_EQ(NS_OK, db->GetSummaryValid(&valid));
  EXPECT_FALSE(valid);
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, FolderRepairSummaryWriteFailureRemainsInvalid) {
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  ASSERT_EQ(NS_OK, db->SetSummaryValid(false));
  // Only this write is faulted: a failed repair cannot become falsely valid.
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER delivery_summary_failure BEFORE "
                       "INSERT ON main.folder_properties WHEN "
                       "NEW.name = 'summaryValid' BEGIN SELECT "
                       "RAISE(ABORT,'summary failure'); END"_ns));
  auto remove = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "DROP TRIGGER delivery_summary_failure"_ns));
  });
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, db->SetSummaryValid(true));
  bool valid = true;
  ASSERT_EQ(NS_OK, db->GetSummaryValid(&valid));
  EXPECT_FALSE(valid);
  RefPtr<PerFolderDatabase> reopened = new PerFolderDatabase(mFolder, false);
  ASSERT_EQ(NS_OK, reopened->GetSummaryValid(&valid));
  EXPECT_FALSE(valid);
  CheckNoTransaction();
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
  int32_t state = mozIStorageStatement::MOZ_STORAGE_STATEMENT_READY;
  ASSERT_EQ(NS_OK, stmt->GetState(&state));
  EXPECT_EQ(mozIStorageStatement::MOZ_STORAGE_STATEMENT_INVALID, state);
  EXPECT_EQ(1u, witness->mCalls);
  EXPECT_EQ(mKey, witness->mLastKey);
  bool more = true;
  EXPECT_EQ(NS_ERROR_FAILURE, iterator->HasMoreElements(&more));
  EXPECT_FALSE(more);
  nsIMsgDBHdr* output = mHeader;
  EXPECT_EQ(NS_ERROR_FAILURE, iterator->GetNext(&output));
  EXPECT_EQ(nullptr, output);
}

TEST_F(DeliveryDatabaseClose, ExhaustedMessageCursorsPermitShutdown) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsTArray<RefPtr<MessageEnumerator>> cursors;
  nsTArray<nsCOMPtr<mozIStorageStatement>> statements;
  for (bool empty : {true, false}) {
    nsCOMPtr<mozIStorageStatement> stmt;
    ASSERT_EQ(NS_OK,
              Connection()->CreateStatement(
                  empty ? "SELECT id FROM messages WHERE id=:key AND 0"_ns
                        : "SELECT id FROM messages WHERE id=:key"_ns,
                  getter_AddRefs(stmt)));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("key"_ns, mKey));
    RefPtr<MessageEnumerator> cursor = new MessageEnumerator(db, stmt);
    bool more = false;
    ASSERT_EQ(NS_OK, cursor->HasMoreElements(&more));
    EXPECT_EQ(!empty, more);
    if (more) {
      nsCOMPtr<nsIMsgDBHdr> header;
      ASSERT_EQ(NS_OK, cursor->GetNext(getter_AddRefs(header)));
      ASSERT_TRUE(header);
      more = true;
      EXPECT_EQ(NS_OK, cursor->HasMoreElements(&more));
      EXPECT_FALSE(more);
    }
    int32_t state = mozIStorageStatement::MOZ_STORAGE_STATEMENT_READY;
    ASSERT_EQ(NS_OK, stmt->GetState(&state));
    EXPECT_EQ(mozIStorageStatement::MOZ_STORAGE_STATEMENT_INVALID, state);
    cursors.AppendElement(cursor);
    statements.AppendElement(stmt);
  }
  // Keep both the JS-equivalent cursor and statement references alive while
  // the real database shutdown drains its connection.
  EXPECT_TRUE(Stop());
  EXPECT_EQ(nullptr, Connection());
}

TEST_F(DeliveryDatabaseClose, DroppedMessageCursorFinalizesPartialStatement) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                       "SELECT id FROM messages WHERE id=:key"_ns,
                       getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("key"_ns, mKey));
  RefPtr<MessageEnumerator> cursor = new MessageEnumerator(db, stmt);
  bool more = false;
  ASSERT_EQ(NS_OK, cursor->HasMoreElements(&more));
  ASSERT_TRUE(more);
  cursor = nullptr;
  int32_t state = mozIStorageStatement::MOZ_STORAGE_STATEMENT_READY;
  ASSERT_EQ(NS_OK, stmt->GetState(&state));
  EXPECT_EQ(mozIStorageStatement::MOZ_STORAGE_STATEMENT_INVALID, state);
  // The existing listener list must not retain the dropped cursor.
  EXPECT_EQ(NS_OK, db->NotifyAnnouncerGoingAway());
}

TEST_F(DeliveryDatabaseClose, HeldMessageCursorFinalizesOnOwnerClose) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  for (bool force : {false, true}) {
    RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
    nsCOMPtr<mozIStorageStatement> stmt;
    ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                         "SELECT id FROM messages WHERE id=:key"_ns,
                         getter_AddRefs(stmt)));
    ASSERT_EQ(NS_OK, stmt->BindInt64ByName("key"_ns, mKey));
    RefPtr<MessageEnumerator> cursor = new MessageEnumerator(db, stmt);
    bool more = false;
    ASSERT_EQ(NS_OK, cursor->HasMoreElements(&more));
    ASSERT_TRUE(more);
    ASSERT_EQ(NS_OK,
              force ? db->ForceClosed() : db->NotifyAnnouncerGoingAway());
    int32_t state = mozIStorageStatement::MOZ_STORAGE_STATEMENT_READY;
    ASSERT_EQ(NS_OK, stmt->GetState(&state));
    EXPECT_EQ(mozIStorageStatement::MOZ_STORAGE_STATEMENT_INVALID, state);
    more = true;
    EXPECT_EQ(NS_ERROR_FAILURE, cursor->HasMoreElements(&more));
    EXPECT_FALSE(more);
    nsIMsgDBHdr* output = mHeader;
    EXPECT_EQ(NS_ERROR_FAILURE, cursor->GetNext(&output));
    EXPECT_EQ(nullptr, output);
  }
}

TEST_F(DeliveryDatabaseClose, HeldMessageCursorFinalizesOnOwnerDestruction) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                       "SELECT id FROM messages WHERE id=:key"_ns,
                       getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("key"_ns, mKey));
  RefPtr<MessageEnumerator> cursor = new MessageEnumerator(db, stmt);
  bool more = false;
  ASSERT_EQ(NS_OK, cursor->HasMoreElements(&more));
  ASSERT_TRUE(more);
  db = nullptr;
  int32_t state = mozIStorageStatement::MOZ_STORAGE_STATEMENT_READY;
  ASSERT_EQ(NS_OK, stmt->GetState(&state));
  EXPECT_EQ(mozIStorageStatement::MOZ_STORAGE_STATEMENT_INVALID, state);
  more = true;
  EXPECT_EQ(NS_ERROR_FAILURE, cursor->HasMoreElements(&more));
  EXPECT_FALSE(more);
}

TEST_F(DeliveryDatabaseClose, LaterMessageStepFailureFinalizesStatement) {
  ASSERT_NO_FATAL_FAILURE(Create({}));
  RefPtr<DeliveryMessageReferencesFaultWitness> witness =
      new DeliveryMessageReferencesFaultWitness(true);
  ASSERT_EQ(NS_OK, Connection()->CreateFunction("close_enum_later_fault"_ns, 1,
                                                witness));
  auto cleanup = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, Connection()->RemoveFunction("close_enum_later_fault"_ns));
  });
  nsCOMPtr<mozIStorageStatement> stmt;
  ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                       "SELECT :key UNION ALL SELECT :key WHERE "
                       "close_enum_later_fault(:key)=0"_ns,
                       getter_AddRefs(stmt)));
  ASSERT_EQ(NS_OK, stmt->BindInt64ByName("key"_ns, mKey));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  RefPtr<MessageEnumerator> cursor = new MessageEnumerator(db, stmt);
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK, cursor->GetNext(getter_AddRefs(header)));
  ASSERT_TRUE(header);
  EXPECT_EQ(1u, witness->mCalls);
  int32_t state = mozIStorageStatement::MOZ_STORAGE_STATEMENT_READY;
  ASSERT_EQ(NS_OK, stmt->GetState(&state));
  EXPECT_EQ(mozIStorageStatement::MOZ_STORAGE_STATEMENT_INVALID, state);
  bool more = true;
  EXPECT_EQ(NS_ERROR_FAILURE, cursor->HasMoreElements(&more));
  EXPECT_FALSE(more);
  nsIMsgDBHdr* output = mHeader;
  EXPECT_EQ(NS_ERROR_FAILURE, cursor->GetNext(&output));
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

namespace {

class DeliveryNewsReadListener final : public nsIDBChangeListener {
 public:
  NS_DECL_ISUPPORTS
  uint32_t added = 0;
  uint32_t flags = 0;
  uint32_t reads = 0;
  std::function<void(char)> observe;
  NS_IMETHOD OnHdrAdded(nsIMsgDBHdr*, nsMsgKey, int32_t,
                        nsIDBChangeListener*) override {
    ++added;
    if (observe) observe('A');
    return NS_OK;
  }
  NS_IMETHOD OnHdrFlagsChanged(nsIMsgDBHdr*, uint32_t, uint32_t,
                               nsIDBChangeListener*) override {
    ++flags;
    if (observe) observe('F');
    return NS_OK;
  }
  NS_IMETHOD OnReadChanged(nsIDBChangeListener*) override {
    ++reads;
    if (observe) observe('R');
    return NS_OK;
  }
  NS_IMETHOD OnHdrDeleted(nsIMsgDBHdr*, nsMsgKey, int32_t,
                          nsIDBChangeListener*) override {
    return NS_OK;
  }
  NS_IMETHOD OnHdrPropertyChanged(nsIMsgDBHdr*, const nsACString&, bool,
                                  uint32_t*, nsIDBChangeListener*) override {
    return NS_OK;
  }
  NS_IMETHOD OnParentChanged(nsMsgKey, nsMsgKey, nsMsgKey,
                             nsIDBChangeListener*) override {
    return NS_OK;
  }
  NS_IMETHOD OnAnnouncerGoingAway(nsIDBChangeAnnouncer*) override {
    return NS_OK;
  }
  NS_IMETHOD OnJunkScoreChanged(nsIDBChangeListener*) override { return NS_OK; }
  NS_IMETHOD OnEvent(nsIMsgDatabase*, const char*) override { return NS_OK; }

 private:
  ~DeliveryNewsReadListener() = default;
};
NS_IMPL_ISUPPORTS(DeliveryNewsReadListener, nsIDBChangeListener)

nsresult AddFacadeNewsArticle(PerFolderDatabase& db, uint32_t article,
                              const nsACString& messageId,
                              nsIMsgDBHdr** header) {
  nsCOMPtr<nsIMsgDBHdr> draft;
  MOZ_TRY(db.CreateNewHdrWithSpecificMsgKey(article, getter_AddRefs(draft)));
  MOZ_TRY(draft->SetMessageId(messageId));
  MOZ_TRY(draft->SetSubject("news subject"_ns));
  MOZ_TRY(draft->SetReferences("<first@news.invalid> <first@news.invalid>"_ns));
  MOZ_TRY(db.AddNewHdrToDB(draft, true));
  return db.GetNewsArticleHdr(article, header);
}

void ExpectBorrowedNewsSet(PerFolderDatabase& db, nsMsgKeySet* expected) {
  nsMsgKeySet* borrowed = nullptr;
  ASSERT_EQ(NS_OK, db.GetReadSet(&borrowed));
  EXPECT_EQ(expected, borrowed);
}

void ExpectNewsArticleLocation(const NewsArticleIdentity& expected,
                               const NewsArticleIdentity& actual) {
  EXPECT_EQ(expected.group.databaseSourceId, actual.group.databaseSourceId);
  EXPECT_EQ(expected.group.folderId, actual.group.folderId);
  EXPECT_EQ(expected.group.incarnation, actual.group.incarnation);
  EXPECT_EQ(expected.articleNumber, actual.articleNumber);
}

void ExpectNewsBodyState(const MessageBodyState& expected,
                         const MessageBodyState& actual) {
  EXPECT_EQ(expected.databaseSourceId, actual.databaseSourceId);
  EXPECT_EQ(expected.key, actual.key);
  EXPECT_EQ(expected.folderId, actual.folderId);
  EXPECT_EQ(expected.storeToken, actual.storeToken);
  EXPECT_EQ(expected.contentRevision, actual.contentRevision);
  EXPECT_EQ(expected.locationRevision, actual.locationRevision);
  EXPECT_EQ(expected.messageSize, actual.messageSize);
  EXPECT_EQ(expected.offlineMessageSize, actual.offlineMessageSize);
  EXPECT_EQ(expected.lineCount, actual.lineCount);
  EXPECT_EQ(expected.flags, actual.flags);
}

}  // namespace

TEST_F(DeliveryCompleteHeader,
       NewsArticleLocationRequiresExactPhysicalBinding) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().UpdateFlags(mFolder,
                                                 nsMsgFolderFlags::Newsgroup));
  RefPtr<nsMsgKeySet> set = nsMsgKeySet::Create();
  ASSERT_TRUE(set);
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, true);
  ASSERT_EQ(NS_OK, db->SetReadSet(set));
  nsCOMPtr<nsIMsgDBHdr> zero, article;
  ASSERT_EQ(NS_OK, AddFacadeNewsArticle(*db, 0, "location-zero@news.invalid"_ns,
                                        getter_AddRefs(zero)));
  ASSERT_EQ(NS_OK, AddFacadeNewsArticle(*db, 7401, "location@news.invalid"_ns,
                                        getter_AddRefs(article)));
  nsMsgKey zeroKey, key;
  ASSERT_EQ(NS_OK, zero->GetMessageKey(&zeroKey));
  ASSERT_EQ(NS_OK, article->GetMessageKey(&key));
  ASSERT_NE(0u, zeroKey);
  ASSERT_NE(7401u, key);
  NewsArticleIdentity location, zeroLocation;
  ASSERT_EQ(NS_OK, db->GetNewsArticleLocation(key, location));
  ASSERT_EQ(NS_OK, db->GetNewsArticleLocation(zeroKey, zeroLocation));
  EXPECT_EQ(7401u, location.articleNumber);
  EXPECT_EQ(0u, zeroLocation.articleNumber);
  EXPECT_EQ(mFolder, location.group.folderId);
  EXPECT_FALSE(location.group.incarnation.IsEmpty());
  nsCString source;
  ASSERT_EQ(NS_OK, ReadAdmissionSourceId(source));
  EXPECT_EQ(source, location.group.databaseSourceId);
  nsMsgKey roundtrip = nsMsgKey_None;
  ASSERT_EQ(NS_OK, db->GetNewsArticleKey(7401, roundtrip));
  EXPECT_EQ(key, roundtrip);
  ASSERT_EQ(NS_OK, db->GetNewsArticleKey(0, roundtrip));
  EXPECT_EQ(zeroKey, roundtrip);
  // The existing script string route preserves decimal text and zero presence.
  nsCString text;
  ASSERT_EQ(NS_OK, article->GetStringProperty("newsArticleNumber", text));
  EXPECT_EQ("7401"_ns, text);
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            article->SetStringProperty("newsArticleNumber", "1"_ns));
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            article->SetUint32Property("newsArticleNumber", 1));
  const NewsArticleIdentity saved = location;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->GetNewsArticleLocation(nsMsgKey_None - 1, location));
  ExpectNewsArticleLocation(saved, location);
  ASSERT_EQ(NS_OK, db->Close(false));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db->GetNewsArticleLocation(key, location));
  ExpectNewsArticleLocation(saved, location);
  RefPtr<PerFolderDatabase> reopened = new PerFolderDatabase(mFolder, true);
  ASSERT_EQ(NS_OK, reopened->SetReadSet(set));
  ASSERT_EQ(NS_OK, reopened->GetNewsArticleLocation(key, location));
  ExpectNewsArticleLocation(saved, location);
}

TEST_F(DeliveryCompleteHeader,
       NewsArticleLocationRejectsStaleForeignAndCorruptBindings) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().UpdateFlags(mFolder,
                                                 nsMsgFolderFlags::Newsgroup));
  RefPtr<nsMsgKeySet> set = nsMsgKeySet::Create();
  ASSERT_TRUE(set);
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, true);
  ASSERT_EQ(NS_OK, db->SetReadSet(set));
  nsCOMPtr<nsIMsgDBHdr> header, duplicate;
  ASSERT_EQ(NS_OK, AddFacadeNewsArticle(*db, 7401, "checked@news.invalid"_ns,
                                        getter_AddRefs(header)));
  ASSERT_EQ(NS_OK, AddFacadeNewsArticle(*db, 7402, "duplicate@news.invalid"_ns,
                                        getter_AddRefs(duplicate)));
  nsMsgKey key, duplicateKey;
  ASSERT_EQ(NS_OK, header->GetMessageKey(&key));
  ASSERT_EQ(NS_OK, duplicate->GetMessageKey(&duplicateKey));
  NewsArticleIdentity original;
  MessageBodyState before;
  ASSERT_EQ(NS_OK, db->CaptureNewsArticleBody(key, original, before));
  NewsArticleIdentity output = original;
  output.articleNumber = 19;
  const NewsArticleIdentity sentinel = output;
  MessageBodyState bodyOutput = before;
  bodyOutput.key = nsMsgKey_None;
  const MessageBodyState bodySentinel = bodyOutput;
  RefPtr<PerFolderDatabase> local = new PerFolderDatabase(mFolder, false);
  EXPECT_EQ(NS_ERROR_INVALID_ARG, local->GetNewsArticleLocation(key, output));
  EXPECT_EQ(NS_ERROR_INVALID_ARG, db->GetNewsArticleLocation(0, output));
  ExpectNewsArticleLocation(sentinel, output);

  uint64_t otherFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolder, "OtherLocation"_ns,
                                                  &otherFolder));
  ASSERT_EQ(NS_OK, mCore->FolderDB().UpdateFlags(otherFolder,
                                                 nsMsgFolderFlags::Newsgroup));
  RefPtr<nsMsgKeySet> otherSet = nsMsgKeySet::Create();
  ASSERT_TRUE(otherSet);
  RefPtr<PerFolderDatabase> other = new PerFolderDatabase(otherFolder, true);
  ASSERT_EQ(NS_OK, other->SetReadSet(otherSet));
  nsCOMPtr<nsIMsgDBHdr> foreign;
  ASSERT_EQ(NS_OK, AddFacadeNewsArticle(*other, 7401, "foreign@news.invalid"_ns,
                                        getter_AddRefs(foreign)));
  nsMsgKey foreignKey;
  ASSERT_EQ(NS_OK, foreign->GetMessageKey(&foreignKey));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->CaptureNewsArticleBody(foreignKey, output, bodyOutput));
  ExpectNewsArticleLocation(sentinel, output);
  ExpectNewsBodyState(bodySentinel, bodyOutput);

  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  {
    auto rollback = MakeScopeExit(
        [&] { EXPECT_EQ(NS_OK, Connection()->RollbackTransaction()); });
    EXPECT_EQ(NS_ERROR_IN_PROGRESS,
              db->CaptureNewsArticleBody(key, output, bodyOutput));
    ExpectNewsArticleLocation(sentinel, output);
    ExpectNewsBodyState(bodySentinel, bodyOutput);
    ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "UPDATE database_identity SET sourceId="
                         "'{7a139b24-9c50-47fa-8322-168da90748c0}'"_ns));
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db->GetNewsArticleLocation(key, output));
    ExpectNewsArticleLocation(sentinel, output);
  }
  // Valid setters reject corruption. Only these critical reader controls alter
  // stored binding values; each commits outside caller SQL and restores them.
  auto restore = [&]() -> nsresult {
    nsCOMPtr<mozIStorageStatement> statement;
    MOZ_TRY(Connection()->CreateStatement(
        "REPLACE INTO message_properties(id,name,value) VALUES "
        "(:key,'newsArticleNumber',7401),"
        "(:key,'newsGroupIncarnation',:group),"
        "(:duplicate,'newsArticleNumber',7402)"_ns,
        getter_AddRefs(statement)));
    MOZ_TRY(statement->BindInt64ByName("key"_ns, key));
    MOZ_TRY(statement->BindInt64ByName("duplicate"_ns, duplicateKey));
    MOZ_TRY(statement->BindUTF8StringByName("group"_ns,
                                            original.group.incarnation));
    return statement->Execute();
  };
  auto cleanup = MakeScopeExit([&] { EXPECT_EQ(NS_OK, restore()); });
  for (const nsCString& mutation : nsTArray<nsCString>{
           "UPDATE message_properties SET value='broken' "
           "WHERE id=:key AND name='newsArticleNumber'"_ns,
           "UPDATE message_properties SET value=-1 "
           "WHERE id=:key AND name='newsArticleNumber'"_ns,
           "UPDATE message_properties SET value=2147483648 "
           "WHERE id=:key AND name='newsArticleNumber'"_ns,
           "UPDATE message_properties SET value=42 "
           "WHERE id=:key AND name='newsGroupIncarnation'"_ns,
           "UPDATE message_properties SET value='stale-group' "
           "WHERE id=:key AND name='newsGroupIncarnation'"_ns}) {
    nsCOMPtr<mozIStorageStatement> statement;
    ASSERT_EQ(NS_OK, Connection()->CreateStatement(mutation,
                                                   getter_AddRefs(statement)));
    ASSERT_EQ(NS_OK, statement->BindInt64ByName("key"_ns, key));
    ASSERT_EQ(NS_OK, statement->Execute());
    ASSERT_EQ(NS_OK, statement->Finalize());
    EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, db->GetNewsArticleLocation(key, output));
    ExpectNewsArticleLocation(sentinel, output);
    ASSERT_EQ(NS_OK, restore());
  }
  nsCOMPtr<mozIStorageStatement> statement;
  ASSERT_EQ(NS_OK, Connection()->CreateStatement(
                       "UPDATE message_properties SET value=7401 "
                       "WHERE id=:key AND name='newsArticleNumber'"_ns,
                       getter_AddRefs(statement)));
  ASSERT_EQ(NS_OK, statement->BindInt64ByName("key"_ns, duplicateKey));
  ASSERT_EQ(NS_OK, statement->Execute());
  ASSERT_EQ(NS_OK, statement->Finalize());
  EXPECT_EQ(NS_ERROR_FILE_CORRUPTED, db->GetNewsArticleLocation(key, output));
  ExpectNewsArticleLocation(sentinel, output);
  ASSERT_EQ(NS_OK, restore());
  ASSERT_EQ(NS_OK,
            Connection()->CreateStatement(
                "DELETE FROM message_properties WHERE id=:key "
                "AND name IN ('newsArticleNumber','newsGroupIncarnation')"_ns,
                getter_AddRefs(statement)));
  ASSERT_EQ(NS_OK, statement->BindInt64ByName("key"_ns, key));
  ASSERT_EQ(NS_OK, statement->Execute());
  ASSERT_EQ(NS_OK, statement->Finalize());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db->GetNewsArticleLocation(key, output));
  ExpectNewsArticleLocation(sentinel, output);
  ASSERT_EQ(NS_OK, restore());
  ASSERT_EQ(NS_OK, db->ForceClosed());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->CaptureNewsArticleBody(key, output, bodyOutput));
  ExpectNewsArticleLocation(sentinel, output);
  ExpectNewsBodyState(bodySentinel, bodyOutput);
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader,
       NewsBodySettlementPreservesPreviousStateAndFlags) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().UpdateFlags(mFolder,
                                                 nsMsgFolderFlags::Newsgroup));
  RefPtr<nsMsgKeySet> set = nsMsgKeySet::Create();
  ASSERT_TRUE(set);
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, true);
  ASSERT_EQ(NS_OK, db->SetReadSet(set));
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK, AddFacadeNewsArticle(*db, 17, "body@news.invalid"_ns,
                                        getter_AddRefs(header)));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, header->GetMessageKey(&key));
  NewsArticleIdentity article;
  MessageBodyState initial;
  ASSERT_EQ(NS_OK, db->CaptureNewsArticleBody(key, article, initial));
  FinishedMessageBody finished;
  MessageBodyState invalidOutput = initial;
  EXPECT_EQ(
      NS_ERROR_INVALID_ARG,
      db->SettleNewsArticleBody(article, initial, finished, invalidOutput));
  ExpectNewsBodyState(initial, invalidOutput);
  finished.storeToken = "old-news-body"_ns;
  finished.messageSize = finished.offlineMessageSize = 43;
  finished.lineCount = 4;
  finished.offline = true;
  MessageBodyState previous;
  bool reached = false;
  RefPtr<DeliveryNewsReadListener> listener = new DeliveryNewsReadListener();
  listener->observe = [&](char kind) {
    if (kind != 'F' || reached) return;
    reached = true;
    EXPECT_EQ(key, previous.key);
    ASSERT_TRUE(previous.storeToken.isSome());
    EXPECT_EQ(finished.storeToken, *previous.storeToken);
    EXPECT_EQ(43u, previous.offlineMessageSize);
    ASSERT_EQ(NS_OK, header->MarkRead(true));
    uint32_t flags;
    ASSERT_EQ(NS_OK, header->OrFlags(nsMsgMessageFlags::Marked, &flags));
    ASSERT_EQ(NS_OK, header->SetStringProperty("keywords", "kept-tag"_ns));
  };
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto remove =
      MakeScopeExit([&] { EXPECT_EQ(NS_OK, db->RemoveListener(listener)); });
  // Native metadata controls use provider-finished values; actual store bytes
  // and write/Finish faults belong to the same whole issue's ordinary tests.
  ASSERT_EQ(NS_OK,
            db->SettleNewsArticleBody(article, initial, finished, previous));
  EXPECT_TRUE(reached);
  listener->observe = nullptr;
  EXPECT_TRUE(set->IsMember(17));
  finished.storeToken = "new-news-body"_ns;
  finished.messageSize = finished.offlineMessageSize = 57;
  finished.lineCount = 6;
  MessageBodyState output;
  ASSERT_EQ(NS_OK,
            db->SettleNewsArticleBody(article, previous, finished, output));
  EXPECT_EQ(key, output.key);
  EXPECT_EQ(mFolder, output.folderId);
  ASSERT_TRUE(output.storeToken.isSome());
  EXPECT_EQ(finished.storeToken, *output.storeToken);
  EXPECT_TRUE(output.flags & nsMsgMessageFlags::Offline);
  EXPECT_TRUE(output.flags & nsMsgMessageFlags::Read);
  EXPECT_TRUE(output.flags & nsMsgMessageFlags::Marked);
  nsCString tags;
  ASSERT_EQ(NS_OK, header->GetStringProperty("keywords", tags));
  EXPECT_EQ("kept-tag"_ns, tags);
  MessageBodyState stored;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageBodyState(key, stored));
  ExpectNewsBodyState(output, stored);
  const MessageBodyState sentinel = output;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->SettleNewsArticleBody(article, previous, finished, output));
  ExpectNewsBodyState(sentinel, output);
  NewsArticleIdentity stale = article;
  stale.group.incarnation = "stale"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->SettleNewsArticleBody(stale, stored, finished, output));
  ExpectNewsBodyState(sentinel, output);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageBodyState(key, stored));
  ExpectNewsBodyState(sentinel, stored);
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, NewsBodySettlementFailureDoesNotReplay) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().UpdateFlags(mFolder,
                                                 nsMsgFolderFlags::Newsgroup));
  RefPtr<nsMsgKeySet> set = nsMsgKeySet::Create();
  ASSERT_TRUE(set);
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, true);
  ASSERT_EQ(NS_OK, db->SetReadSet(set));
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK, AddFacadeNewsArticle(*db, 19, "failed-body@news.invalid"_ns,
                                        getter_AddRefs(header)));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, header->GetMessageKey(&key));
  NewsArticleIdentity article;
  MessageBodyState empty, previous;
  ASSERT_EQ(NS_OK, db->CaptureNewsArticleBody(key, article, empty));
  FinishedMessageBody finished;
  finished.storeToken = "prior-news-body"_ns;
  finished.messageSize = finished.offlineMessageSize = 31;
  finished.lineCount = 3;
  finished.offline = true;
  ASSERT_EQ(NS_OK,
            db->SettleNewsArticleBody(article, empty, finished, previous));
  mWitness = new DeliveryMessageReferencesFaultWitness();
  ASSERT_EQ(NS_OK,
            Connection()->CreateFunction("news_body_attempt"_ns, 1, mWitness));
  auto cleanup = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS fail_news_body"_ns));
    EXPECT_EQ(NS_OK, Connection()->RemoveFunction("news_body_attempt"_ns));
  });
  // A normal successful native write cannot reach rollback. Fault only this
  // body's metadata insertion and let the existing fixture own all lifecycle.
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER fail_news_body BEFORE INSERT ON "
                       "message_properties WHEN NEW.name='storeToken' BEGIN "
                       "SELECT news_body_attempt(NEW.id); "
                       "SELECT RAISE(ABORT,'news body failure'); END"_ns));
  RefPtr<DeliveryNewsReadListener> listener = new DeliveryNewsReadListener();
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto remove =
      MakeScopeExit([&] { EXPECT_EQ(NS_OK, db->RemoveListener(listener)); });
  MessageBodyState output = previous;
  output.key = nsMsgKey_None;
  const MessageBodyState sentinel = output;
  finished.storeToken = "failed-news-body"_ns;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db->SettleNewsArticleBody(article, previous, finished, output));
  EXPECT_EQ(1u, mWitness->mCalls);
  EXPECT_EQ(int64_t(key), mWitness->mLastKey);
  ExpectNewsBodyState(sentinel, output);
  MessageBodyState stored;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetMessageBodyState(key, stored));
  ExpectNewsBodyState(previous, stored);
  EXPECT_EQ(0u, listener->flags);
  EXPECT_EQ(0u, listener->reads);
  CheckNoTransaction();
  ASSERT_EQ(NS_OK,
            Connection()->ExecuteSimpleSQL("DROP TRIGGER fail_news_body"_ns));
  // This explicit fresh caller attempt is permitted; the helper never retries.
  ASSERT_EQ(NS_OK,
            db->SettleNewsArticleBody(article, stored, finished, output));
  EXPECT_EQ(1u, mWitness->mCalls);
  ASSERT_TRUE(output.storeToken.isSome());
  EXPECT_EQ(finished.storeToken, *output.storeToken);
  EXPECT_TRUE(output.flags & nsMsgMessageFlags::Offline);
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader,
       NewsExpiryRequiresOriginalMappingBeforePhysicalRemoval) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().UpdateFlags(mFolder,
                                                 nsMsgFolderFlags::Newsgroup));
  RefPtr<nsMsgKeySet> set = nsMsgKeySet::Create();
  ASSERT_TRUE(set);
  ASSERT_GE(set->Add(17), 0);
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, true);
  ASSERT_EQ(NS_OK, db->SetReadSet(set));
  nsCOMPtr<nsIMsgDBHdr> expired, retained;
  ASSERT_EQ(NS_OK, AddFacadeNewsArticle(*db, 17, "expired@news.invalid"_ns,
                                        getter_AddRefs(expired)));
  ASSERT_EQ(NS_OK, AddFacadeNewsArticle(*db, 29, "retained@news.invalid"_ns,
                                        getter_AddRefs(retained)));
  nsMsgKey key, retainedKey;
  ASSERT_EQ(NS_OK, expired->GetMessageKey(&key));
  ASSERT_EQ(NS_OK, retained->GetMessageKey(&retainedKey));
  ASSERT_NE(17u, key);
  NewsArticleIdentity article, retainedArticle;
  MessageBodyState body, settled;
  ASSERT_EQ(NS_OK, db->CaptureNewsArticleBody(key, article, body));
  ASSERT_EQ(NS_OK, db->GetNewsArticleLocation(retainedKey, retainedArticle));
  FinishedMessageBody finished;
  finished.storeToken = "expired-news-body"_ns;
  finished.messageSize = 91;
  finished.offlineMessageSize = 37;
  finished.lineCount = 4;
  finished.offline = true;
  ASSERT_EQ(NS_OK, db->SettleNewsArticleBody(article, body, finished, settled));
  nsCOMPtr<nsIDBFolderInfo> info;
  ASSERT_EQ(NS_OK, db->GetDBFolderInfo(getter_AddRefs(info)));
  int64_t before;
  ASSERT_EQ(NS_OK, info->GetExpungedBytes(&before));
  NewsArticleIdentity wrong = article;
  wrong.group.incarnation = "stale"_ns;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db->RemoveNewsArticle(wrong, key));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->RemoveNewsArticle(article, retainedKey));
  bool exists = false;
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_TRUE(exists);
  ASSERT_EQ(NS_OK, db->RemoveNewsArticle(article, key));
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(key, exists));
  EXPECT_FALSE(exists);
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(retainedKey, exists));
  EXPECT_TRUE(exists);
  EXPECT_TRUE(set->IsMember(17));
  int64_t after;
  ASSERT_EQ(NS_OK, info->GetExpungedBytes(&after));
  EXPECT_EQ(before + 37, after);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db->RemoveNewsArticle(article, key));
  ASSERT_EQ(NS_OK, info->GetExpungedBytes(&after));
  EXPECT_EQ(before + 37, after);
  ASSERT_EQ(NS_OK, db->ForceClosed());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->RemoveNewsArticle(retainedArticle, retainedKey));
  ASSERT_EQ(NS_OK, mCore->MessageDB().MessageExists(retainedKey, exists));
  EXPECT_TRUE(exists);
  CheckNoTransaction();
}

namespace {

// These faults must cross the real caller's C++ store/stream boundary: final
// native providers create their own streams, and successful I/O cannot exercise
// a short write or lost Finish acknowledgment. Admission and physical I/O still
// belong to the actual provider. This local delegate adds no production hook.
class NewsStoreForwarder : public nsIMsgPluggableStore {
 public:
  NS_DECL_ISUPPORTS
  NS_FORWARD_NSIMSGPLUGGABLESTORE(mStore->)
  explicit NewsStoreForwarder(nsIMsgPluggableStore* store) : mStore(store) {}

 protected:
  virtual ~NewsStoreForwarder() = default;
  nsCOMPtr<nsIMsgPluggableStore> mStore;
};
NS_IMPL_ISUPPORTS(NewsStoreForwarder, nsIMsgPluggableStore)

enum class NewsWriteFault { None, Error, Short };

class NewsWriteFaultStream final : public nsIOutputStream {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NewsWriteFaultStream(nsIOutputStream* stream, NewsWriteFault fault,
                       uint32_t cut, std::function<void()> onCut)
      : mStream(stream), mFault(fault), mCut(cut), mOnCut(std::move(onCut)) {}

  NS_IMETHOD Close() override { return mStream->Close(); }
  NS_IMETHOD Flush() override { return mStream->Flush(); }
  NS_IMETHOD StreamStatus() override { return mStream->StreamStatus(); }
  NS_IMETHOD IsNonBlocking(bool* value) override {
    return mStream->IsNonBlocking(value);
  }
  NS_IMETHOD WriteFrom(nsIInputStream* input, uint32_t count,
                       uint32_t* written) override {
    return mStream->WriteFrom(input, count, written);
  }
  NS_IMETHOD WriteSegments(nsReadSegmentFun reader, void* closure,
                           uint32_t count, uint32_t* written) override {
    return mStream->WriteSegments(reader, closure, count, written);
  }
  NS_IMETHOD Write(const char* data, uint32_t count,
                   uint32_t* written) override {
    NS_ENSURE_ARG_POINTER(written);
    requests.AppendElement(nsCString(data, count));
    bool cutting = mFault != NewsWriteFault::None && requests.Length() == mCut;
    uint32_t forwarded = cutting && count ? count - 1 : count;
    *written = 0;
    nsresult rv = mStream->Write(data, forwarded, written);
    bytes.Append(data, *written);
    if (NS_FAILED(rv)) return rv;
    NS_ENSURE_TRUE(*written == forwarded, NS_ERROR_UNEXPECTED);
    if (!cutting) return NS_OK;
    cutRequested = count;
    cutWritten = *written;
    if (mOnCut) mOnCut();
    return mFault == NewsWriteFault::Error ? NS_ERROR_FILE_NO_DEVICE_SPACE
                                           : NS_OK;
  }

  nsTArray<nsCString> requests;
  nsCString bytes;
  uint32_t cutRequested = 0;
  uint32_t cutWritten = 0;

 private:
  ~NewsWriteFaultStream() = default;
  nsCOMPtr<nsIOutputStream> mStream;
  NewsWriteFault mFault;
  uint32_t mCut;
  std::function<void()> mOnCut;
};
NS_IMPL_ISUPPORTS(NewsWriteFaultStream, nsIOutputStream)

class NewsFaultStore final : public NewsStoreForwarder,
                             public nsIFolderStorageMoveAdmission {
 public:
  NS_DECL_ISUPPORTS_INHERITED
  explicit NewsFaultStore(nsIMsgPluggableStore* store)
      : NewsStoreForwarder(store) {}

  NS_IMETHOD CheckFolderStorageMove(nsIMsgFolder* folder) override {
    ++admissions;
    nsCOMPtr<nsIFolderStorageMoveAdmission> actual = do_QueryInterface(mStore);
    NS_ENSURE_TRUE(actual, NS_ERROR_NOT_IMPLEMENTED);
    return actual->CheckFolderStorageMove(folder);
  }
  NS_IMETHOD GetNewMsgOutputStream(nsIMsgFolder* folder,
                                   nsIOutputStream** output) override {
    NS_ENSURE_ARG_POINTER(output);
    ++issued;
    NS_ENSURE_FALSE(mOriginal || mCurrent, NS_ERROR_IN_PROGRESS);
    MOZ_TRY(mStore->GetNewMsgOutputStream(folder, getter_AddRefs(mOriginal)));
    mCurrent = new NewsWriteFaultStream(mOriginal, fault, cut, onCut);
    last = mCurrent;
    nsCOMPtr<nsIOutputStream> stream = mCurrent.get();
    stream.forget(output);
    return NS_OK;
  }
  NS_IMETHOD FinishNewMessage(nsIMsgFolder* folder, nsIOutputStream* stream,
                              nsACString& token) override {
    ++finishes;
    NS_ENSURE_TRUE(mCurrent && stream == mCurrent && mOriginal,
                   NS_ERROR_ILLEGAL_VALUE);
    nsCString completed;
    ++actualFinishes;
    // Both providers compare this ORIGINAL pointer with their issued stream.
    nsresult rv = mStore->FinishNewMessage(folder, mOriginal, completed);
    if (NS_FAILED(rv)) return rv;  // Keep real uncertain custody untouched.
    mOriginal = nullptr;
    mCurrent = nullptr;
    if (loseFinishAcknowledgment) {
      orphanToken = completed;
      return NS_ERROR_FILE_ACCESS_DENIED;
    }
    token = completed;
    return NS_OK;
  }
  NS_IMETHOD DiscardNewMessage(nsIMsgFolder* folder,
                               nsIOutputStream* stream) override {
    ++discards;
    NS_ENSURE_TRUE(mCurrent && stream == mCurrent && mOriginal,
                   NS_ERROR_ILLEGAL_VALUE);
    ++actualDiscards;
    nsresult rv = mStore->DiscardNewMessage(folder, mOriginal);
    if (NS_FAILED(rv)) return rv;
    mOriginal = nullptr;
    mCurrent = nullptr;
    return cleanupResultFailure ? NS_ERROR_FILE_ACCESS_DENIED : NS_OK;
  }
  void ResetAttempt() {
    EXPECT_FALSE(mOriginal);
    EXPECT_FALSE(mCurrent);
    issued = finishes = discards = actualFinishes = actualDiscards = 0;
    admissions = 0;
    fault = NewsWriteFault::None;
    cut = 0;
    onCut = nullptr;
    loseFinishAcknowledgment = cleanupResultFailure = false;
    orphanToken.Truncate();
    last = nullptr;
  }
  bool HasUnsettledStream() const { return mOriginal || mCurrent; }

  NewsWriteFault fault = NewsWriteFault::None;
  uint32_t cut = 0;
  std::function<void()> onCut;
  bool loseFinishAcknowledgment = false;
  bool cleanupResultFailure = false;
  uint32_t admissions = 0, issued = 0, finishes = 0, discards = 0;
  uint32_t actualFinishes = 0, actualDiscards = 0;
  nsCString orphanToken;
  RefPtr<NewsWriteFaultStream> last;

 private:
  ~NewsFaultStore() override = default;
  nsCOMPtr<nsIOutputStream> mOriginal;
  RefPtr<NewsWriteFaultStream> mCurrent;
};
NS_IMPL_ISUPPORTS_INHERITED(NewsFaultStore, NewsStoreForwarder,
                            nsIFolderStorageMoveAdmission)

class NativeNewsFaultFolder final : public nsMsgNewsFolder {
 public:
  NS_IMETHOD GetMsgStore(nsIMsgPluggableStore** result) override {
    NS_ENSURE_ARG_POINTER(result);
    nsCOMPtr<nsIMsgPluggableStore> actual;
    MOZ_TRY(nsMsgNewsFolder::GetMsgStore(getter_AddRefs(actual)));
    if (!store) {
      realStore = actual;
      store = new NewsFaultStore(actual);
      // No private-admission QI is advertised by this negative control.
      unknownStore = new NewsStoreForwarder(actual);
    }
    NS_ENSURE_TRUE(actual == realStore, NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsIMsgPluggableStore> selected =
        unknownAdmission
            ? static_cast<nsIMsgPluggableStore*>(unknownStore.get())
            : static_cast<nsIMsgPluggableStore*>(store.get());
    selected.forget(result);
    return NS_OK;
  }

  bool unknownAdmission = false;
  nsCOMPtr<nsIMsgPluggableStore> realStore;
  RefPtr<NewsFaultStore> store;
  RefPtr<NewsStoreForwarder> unknownStore;

 private:
  ~NativeNewsFaultFolder() override = default;
};

struct NewsOfflineSnapshot {
  NewsArticleIdentity article;
  MessageBodyState body;
  nsCString bytes, readSet, checkpoint, tags;
  nsTArray<nsMsgKey> newKeys;
  int32_t total = -1, unread = -1;
  uint32_t publicFlags = 0;
};

// Uses the existing fixture's actual profile/core. Normal account, native
// folder initialization, server shutdown, lookup eviction and account removal
// surround only the scoped provider fault. No folder/database identity is
// injected.
class NewsOfflineNativeCase {
 public:
  nsresult Init(DatabaseCore& core, nsIFile* profile, bool maildir) {
    nsresult rv;
    accounts = do_GetService("@mozilla.org/messenger/account-manager;1", &rv);
    MOZ_TRY(rv);
    NS_ENSURE_TRUE(accounts, NS_ERROR_NOT_AVAILABLE);
    static uint32_t serial = 0;
    nsPrintfCString host("native-news-fault-%u.invalid", ++serial);
    MOZ_TRY(accounts->CreateIncomingServer("reader"_ns, host, "nntp"_ns,
                                           getter_AddRefs(server)));
    MOZ_TRY(server->SetStringValue(
        "storeContractID", maildir
                               ? "@mozilla.org/msgstore/maildirstore;1"_ns
                               : "@mozilla.org/msgstore/berkeleystore;1"_ns));
    nsCOMPtr<nsIFile> path;
    MOZ_TRY(profile->Clone(getter_AddRefs(path)));
    MOZ_TRY(path->Append(u"news-offline-native"_ns));
    MOZ_TRY(path->CreateUnique(nsIFile::DIRECTORY_TYPE, 0700));
    MOZ_TRY(server->SetLocalPath(path));
    MOZ_TRY(accounts->CreateAccount(getter_AddRefs(account)));
    MOZ_TRY(account->SetIncomingServer(server));
    boundAccount = true;
    MOZ_TRY(server->GetRootFolder(getter_AddRefs(root)));
    uint64_t rootId, groupId;
    MOZ_TRY(root->GetId(&rootId));
    MOZ_TRY(core.FolderDB().InsertFolder(rootId, "native.fault.group"_ns,
                                         &groupId));
    MOZ_TRY(core.FolderDB().UpdateFlags(groupId, nsMsgFolderFlags::Newsgroup));
    folder = new NativeNewsFaultFolder();
    MOZ_TRY(folder->InitWithFolderId(groupId));
    MOZ_TRY(folder->SetParent(root));
    // Complete normal subscription/parent/read-set setup through the public
    // caller; its checked cache lookup must retain this exact native object.
    nsCOMPtr<nsIMsgNewsFolder> newsRoot = do_QueryInterface(root);
    NS_ENSURE_TRUE(newsRoot, NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsIMsgFolder> registered;
    MOZ_TRY(newsRoot->AddNewsgroup("native.fault.group"_ns, EmptyCString(),
                                   getter_AddRefs(registered)));
    NS_ENSURE_TRUE(registered == static_cast<nsIMsgFolder*>(folder.get()),
                   NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsIMsgPluggableStore> selected;
    MOZ_TRY(folder->GetMsgStore(getter_AddRefs(selected)));
    MOZ_TRY(selected->EnsureLocalStore(folder));
    nsCOMPtr<nsIMsgDatabase> database;
    MOZ_TRY(folder->GetMsgDatabase(getter_AddRefs(database)));
    native = do_QueryObject(database);
    NS_ENSURE_TRUE(native, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(AddFacadeNewsArticle(*native, 7401,
                                 "native-offline@news.invalid"_ns,
                                 getter_AddRefs(header)));
    MOZ_TRY(header->GetMessageKey(&key));
    NS_ENSURE_TRUE(key && key != 7401 && key != nsMsgKey_None,
                   NS_ERROR_UNEXPECTED);
    MOZ_TRY(header->SetMessageSize(PriorData().Length()));
    MOZ_TRY(header->MarkRead(true));
    uint32_t flags;
    MOZ_TRY(header->OrFlags(nsMsgMessageFlags::Marked, &flags));
    MOZ_TRY(header->SetStringProperty("keywords", "native-kept-tag"_ns));
    MOZ_TRY(folder->SetSaveArticleOffline(true));
    MOZ_TRY(folder->NotifyArticleDownloaded(7401, PriorData()));
    NS_ENSURE_TRUE(folder->store, NS_ERROR_NOT_AVAILABLE);
    return NS_OK;
  }

  ~NewsOfflineNativeCase() {
    header = nullptr;
    native = nullptr;
    if (folder) {
      if (folder->realStore) {
        nsCOMPtr<nsIFolderStorageMoveAdmission> admission =
            do_QueryInterface(folder->realStore);
        EXPECT_TRUE(admission);
        if (admission)
          EXPECT_EQ(NS_OK, admission->CheckFolderStorageMove(folder));
      }
      if (folder->store) {
        EXPECT_FALSE(folder->store->HasUnsettledStream());
        folder->store->onCut = nullptr;
      }
      EXPECT_EQ(NS_OK, folder->Shutdown(true));
      nsCOMPtr<nsIFolderLookupService> lookup =
          do_GetService("@mozilla.org/mail/folder-lookup;1");
      EXPECT_TRUE(lookup);
      if (lookup) EXPECT_EQ(NS_OK, lookup->EvictFolder(folder));
      folder = nullptr;
    }
    root = nullptr;
    if (account) EXPECT_EQ(NS_OK, accounts->RemoveAccount(account, false));
    if (server && !boundAccount) {
      EXPECT_EQ(NS_OK, accounts->RemoveIncomingServer(server, false));
    }
  }

  static nsCString PriorData() {
    return "From: original@example.invalid\r\nSubject: retained native body\r\n"
           "\r\nPrior native body bytes.\r\n"_ns;
  }
  static nsCString RetryData() {
    return "From: retry@example.invalid\r\nSubject: fresh native request\r\n"
           "\r\nFresh explicit native body.\r\n"_ns;
  }
  nsresult ReadBody(const nsACString& token, nsACString& bytes) {
    nsCOMPtr<nsIInputStream> stream;
    MOZ_TRY(folder->realStore->GetMsgInputStream(folder, token, 0,
                                                 getter_AddRefs(stream)));
    nsCString result;
    nsresult rv = NS_OK;
    while (true) {
      char buffer[256];
      uint32_t count = 0;
      rv = stream->Read(buffer, sizeof(buffer), &count);
      if (NS_FAILED(rv) || !count) break;
      result.Append(buffer, count);
    }
    nsresult closed = stream->Close();
    MOZ_TRY(rv);
    MOZ_TRY(closed);
    bytes = result;
    return NS_OK;
  }
  nsresult Capture(NewsOfflineSnapshot& output) {
    NewsOfflineSnapshot result;
    MOZ_TRY(native->CaptureNewsArticleBody(key, result.article, result.body));
    NS_ENSURE_TRUE(result.body.storeToken.isSome(), NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(ReadBody(*result.body.storeToken, result.bytes));
    nsMsgKeySet* readSet = nullptr;
    MOZ_TRY(native->GetReadSet(&readSet));
    NS_ENSURE_TRUE(readSet, NS_ERROR_NOT_AVAILABLE);
    MOZ_TRY(readSet->Output(getter_Copies(result.readSet)));
    MOZ_TRY(native->GetNewList(result.newKeys));
    nsCOMPtr<nsIDBFolderInfo> info;
    MOZ_TRY(native->GetDBFolderInfo(getter_AddRefs(info)));
    MOZ_TRY(info->GetNumMessages(&result.total));
    MOZ_TRY(info->GetNumUnreadMessages(&result.unread));
    MOZ_TRY(info->GetCharProperty("readSet", result.checkpoint));
    MOZ_TRY(header->GetFlags(&result.publicFlags));
    MOZ_TRY(header->GetStringProperty("keywords", result.tags));
    output = std::move(result);
    return NS_OK;
  }
  void ExpectUnchanged(const NewsOfflineSnapshot& expected) {
    NewsOfflineSnapshot actual;
    ASSERT_EQ(NS_OK, Capture(actual));
    ExpectNewsArticleLocation(expected.article, actual.article);
    ExpectNewsBodyState(expected.body, actual.body);
    EXPECT_EQ(expected.bytes, actual.bytes);
    EXPECT_EQ(expected.total, actual.total);
    EXPECT_EQ(expected.unread, actual.unread);
    EXPECT_EQ(expected.publicFlags, actual.publicFlags);
    EXPECT_EQ(expected.newKeys, actual.newKeys);
    EXPECT_EQ(expected.tags, actual.tags);
    EXPECT_EQ(expected.readSet, actual.readSet);
    EXPECT_EQ(expected.checkpoint, actual.checkpoint);
  }
  void ExpectFreshRetry(const NewsOfflineSnapshot& before) {
    folder->store->ResetAttempt();
    ASSERT_EQ(NS_OK, folder->NotifyArticleDownloaded(7401, RetryData()));
    EXPECT_EQ(1u, folder->store->issued);
    EXPECT_EQ(1u, folder->store->finishes);
    EXPECT_EQ(1u, folder->store->actualFinishes);
    EXPECT_EQ(0u, folder->store->discards);
    ASSERT_TRUE(folder->store->last);
    ASSERT_EQ(3u, folder->store->last->requests.Length());
    NewsOfflineSnapshot after;
    ASSERT_EQ(NS_OK, Capture(after));
    ExpectNewsArticleLocation(before.article, after.article);
    EXPECT_EQ(before.body.key, after.body.key);
    EXPECT_EQ(before.body.folderId, after.body.folderId);
    EXPECT_NE(before.body.storeToken, after.body.storeToken);
    EXPECT_TRUE(after.body.flags & nsMsgMessageFlags::Offline);
    EXPECT_EQ(before.publicFlags, after.publicFlags);
    EXPECT_EQ(before.total, after.total);
    EXPECT_EQ(before.unread, after.unread);
    EXPECT_EQ(before.newKeys, after.newKeys);
    EXPECT_EQ(before.tags, after.tags);
    EXPECT_EQ(before.readSet, after.readSet);
    EXPECT_EQ(before.checkpoint, after.checkpoint);
    EXPECT_EQ(folder->store->last->bytes, after.bytes);
    EXPECT_EQ(RetryData(), folder->store->last->requests[2]);
    nsCString retained;
    ASSERT_EQ(NS_OK, ReadBody(*before.body.storeToken, retained));
    EXPECT_EQ(before.bytes, retained);
  }

  nsCOMPtr<nsIMsgAccountManager> accounts;
  nsCOMPtr<nsIMsgAccount> account;
  nsCOMPtr<nsIMsgIncomingServer> server;
  nsCOMPtr<nsIMsgFolder> root;
  RefPtr<NativeNewsFaultFolder> folder;
  RefPtr<PerFolderDatabase> native;
  nsCOMPtr<nsIMsgDBHdr> header;
  nsMsgKey key = nsMsgKey_None;
  bool boundAccount = false;
};

}  // namespace

// Normal AccountManager startup owns the core used by real native folders.
// The older direct-core fixture has already started it, so it cannot initialize
// that application service as well. Run these three application caller cases
// together in a fresh normal gtest process, with Panorama enabled at startup;
// keep the existing direct-core cases in their ordinary invocation. The whole
// job still owns both invocations. No service/factory reset or hot pref change.
class DeliveryNewsOfflineProvider : public DeliveryMessageReferences {
 protected:
  void SetUp() override {
    // This backend-specific fixture is inapplicable to Mork startup.
    // The enabled invocation must run every case; a skip is not coverage.
    if (!mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
      GTEST_SKIP() << "Requires Panorama enabled before application startup.";
    }
    ASSERT_TRUE(mozilla::StaticPrefs::mail_panorama_enabled_AtStartup());
    // Use the harness-owned application profile, not a replacement test
    // profile.
    ASSERT_EQ(NS_OK, NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR,
                                            getter_AddRefs(mProfile)));
    nsresult rv;
    mAccounts = do_GetService("@mozilla.org/messenger/account-manager;1", &rv);
    ASSERT_EQ(NS_OK, rv);
    ASSERT_TRUE(mAccounts);
    nsCOMPtr<nsIMsgDBService> service =
        do_GetService("@mozilla.org/msgDatabase/msgDBService;1", &rv);
    ASSERT_EQ(NS_OK, rv);
    nsCOMPtr<nsIDatabaseCore> nativeService = do_QueryInterface(service, &rv);
    ASSERT_EQ(NS_OK, rv);
    ASSERT_TRUE(nativeService);
    mCore = DatabaseCore::GetInstanceForService();
    ASSERT_EQ(static_cast<nsIDatabaseCore*>(mCore.get()), nativeService.get());
    ASSERT_TRUE(Connection());
    ASSERT_EQ(NS_OK, mProfile->Clone(getter_AddRefs(mFile)));
    ASSERT_EQ(NS_OK, mFile->Append(u"panorama.sqlite"_ns));
    nsCOMPtr<nsIFile> actual;
    ASSERT_EQ(NS_OK, Connection()->GetDatabaseFile(getter_AddRefs(actual)));
    bool same = false;
    ASSERT_EQ(NS_OK, mFile->Equals(actual, &same));
    ASSERT_TRUE(same);
  }
  void TearDown() override {
    // Each case removes only its real accounts/folders in scoped cleanup.
    // Standard application/harness shutdown owns the shared profile and core;
    // a per-case manual profile-before-change would retire the cached service.
    mCore = nullptr;
    mAccounts = nullptr;
    mProfile = nullptr;
    mFile = nullptr;
  }
  nsCOMPtr<nsIMsgAccountManager> mAccounts;
};

TEST_F(DeliveryNewsOfflineProvider,
       NewsOfflineWriteFailuresRetainPriorBodyAndAllowFreshRetry) {
  // Public native folder initialization/callbacks require this ordinary startup
  // input, not a late mutation of a cached AtStartup preference.
  ASSERT_TRUE(mozilla::StaticPrefs::mail_panorama_enabled_AtStartup());
  for (bool maildir : {false, true}) {
    SCOPED_TRACE(maildir ? "maildir" : "mbox");
    NewsOfflineNativeCase item;
    ASSERT_EQ(NS_OK, item.Init(*mCore, mProfile, maildir));
    uint32_t completedCuts = 0;
    for (uint32_t cut : {1u, 2u, 3u}) {
      SCOPED_TRACE(cut);
      NewsOfflineSnapshot before;
      ASSERT_EQ(NS_OK, item.Capture(before));
      EXPECT_TRUE(before.body.flags & nsMsgMessageFlags::Offline);
      EXPECT_TRUE(before.publicFlags & nsMsgMessageFlags::Read);
      EXPECT_TRUE(before.publicFlags & nsMsgMessageFlags::Marked);
      item.folder->store->ResetAttempt();
      item.folder->store->fault = NewsWriteFault::Error;
      item.folder->store->cut = cut;
      item.folder->store->cleanupResultFailure = true;
      bool reentered = false;
      item.folder->store->onCut = [&] {
        reentered = true;
        EXPECT_EQ(NS_ERROR_IN_PROGRESS,
                  item.folder->NotifyArticleDownloaded(
                      7401, NewsOfflineNativeCase::RetryData()));
      };
      EXPECT_EQ(NS_ERROR_FILE_NO_DEVICE_SPACE,
                item.folder->NotifyArticleDownloaded(
                    7401, NewsOfflineNativeCase::RetryData()));
      EXPECT_TRUE(reentered);
      EXPECT_EQ(1u, item.folder->store->issued);
      EXPECT_EQ(0u, item.folder->store->finishes);
      EXPECT_EQ(0u, item.folder->store->actualFinishes);
      EXPECT_EQ(1u, item.folder->store->discards);
      EXPECT_EQ(1u, item.folder->store->actualDiscards);
      ASSERT_TRUE(item.folder->store->last);
      EXPECT_EQ(cut, item.folder->store->last->requests.Length());
      EXPECT_GT(item.folder->store->last->cutRequested, 1u);
      EXPECT_EQ(item.folder->store->last->cutRequested - 1,
                item.folder->store->last->cutWritten);
      ASSERT_NO_FATAL_FAILURE(item.ExpectUnchanged(before));
      ASSERT_NO_FATAL_FAILURE(item.ExpectFreshRetry(before));
      CheckNoTransaction();
      ++completedCuts;
    }
    EXPECT_EQ(3u, completedCuts);
    RecordProperty(maildir ? "maildir_completed_cuts" : "mbox_completed_cuts",
                   completedCuts);
  }
}

TEST_F(DeliveryNewsOfflineProvider,
       NewsOfflineShortWritesRetainPriorBodyAndAllowFreshRetry) {
  ASSERT_TRUE(mozilla::StaticPrefs::mail_panorama_enabled_AtStartup());
  for (bool maildir : {false, true}) {
    SCOPED_TRACE(maildir ? "maildir" : "mbox");
    NewsOfflineNativeCase item;
    ASSERT_EQ(NS_OK, item.Init(*mCore, mProfile, maildir));
    uint32_t completedCuts = 0;
    for (uint32_t cut : {1u, 2u, 3u}) {
      SCOPED_TRACE(cut);
      NewsOfflineSnapshot before;
      ASSERT_EQ(NS_OK, item.Capture(before));
      EXPECT_TRUE(before.body.flags & nsMsgMessageFlags::Offline);
      item.folder->store->ResetAttempt();
      item.folder->store->fault = NewsWriteFault::Short;
      item.folder->store->cut = cut;
      EXPECT_EQ(NS_ERROR_FAILURE,
                item.folder->NotifyArticleDownloaded(
                    7401, NewsOfflineNativeCase::RetryData()));
      EXPECT_EQ(1u, item.folder->store->issued);
      EXPECT_EQ(0u, item.folder->store->finishes);
      EXPECT_EQ(0u, item.folder->store->actualFinishes);
      EXPECT_EQ(1u, item.folder->store->discards);
      EXPECT_EQ(1u, item.folder->store->actualDiscards);
      ASSERT_TRUE(item.folder->store->last);
      EXPECT_EQ(cut, item.folder->store->last->requests.Length());
      EXPECT_GT(item.folder->store->last->cutRequested, 1u);
      EXPECT_EQ(item.folder->store->last->cutRequested - 1,
                item.folder->store->last->cutWritten);
      ASSERT_NO_FATAL_FAILURE(item.ExpectUnchanged(before));
      ASSERT_NO_FATAL_FAILURE(item.ExpectFreshRetry(before));
      CheckNoTransaction();
      ++completedCuts;
    }
    EXPECT_EQ(3u, completedCuts);
    RecordProperty(maildir ? "maildir_completed_cuts" : "mbox_completed_cuts",
                   completedCuts);
  }
}

TEST_F(DeliveryNewsOfflineProvider,
       NewsOfflineUncertainFinishDoesNotDiscardOrReplay) {
  ASSERT_TRUE(mozilla::StaticPrefs::mail_panorama_enabled_AtStartup());
  for (bool maildir : {false, true}) {
    SCOPED_TRACE(maildir ? "maildir" : "mbox");
    NewsOfflineNativeCase item;
    ASSERT_EQ(NS_OK, item.Init(*mCore, mProfile, maildir));
    NewsOfflineSnapshot before;
    ASSERT_EQ(NS_OK, item.Capture(before));
    EXPECT_TRUE(before.body.flags & nsMsgMessageFlags::Offline);
    item.folder->store->ResetAttempt();
    item.folder->unknownAdmission = true;
    EXPECT_EQ(NS_ERROR_NOT_IMPLEMENTED,
              item.folder->NotifyArticleDownloaded(
                  7401, NewsOfflineNativeCase::RetryData()));
    EXPECT_EQ(0u, item.folder->store->issued);
    item.folder->unknownAdmission = false;
    ASSERT_NO_FATAL_FAILURE(item.ExpectUnchanged(before));

    // This stream belongs to this explicit test caller, not the news attempt.
    nsCOMPtr<nsIOutputStream> busy;
    ASSERT_EQ(NS_OK, item.folder->realStore->GetNewMsgOutputStream(
                         item.folder, getter_AddRefs(busy)));
    bool busyDiscardAttempted = false;
    auto discardBusy = MakeScopeExit([&] {
      if (busy && !busyDiscardAttempted) {
        EXPECT_EQ(NS_OK,
                  item.folder->realStore->DiscardNewMessage(item.folder, busy));
      }
    });
    EXPECT_EQ(NS_MSG_FOLDER_BUSY,
              item.folder->NotifyArticleDownloaded(
                  7401, NewsOfflineNativeCase::RetryData()));
    EXPECT_EQ(0u, item.folder->store->issued);
    EXPECT_EQ(0u, item.folder->store->discards);
    busyDiscardAttempted = true;
    nsresult discarded =
        item.folder->realStore->DiscardNewMessage(item.folder, busy);
    busy = nullptr;
    ASSERT_EQ(NS_OK, discarded);
    ASSERT_NO_FATAL_FAILURE(item.ExpectUnchanged(before));

    item.folder->store->ResetAttempt();
    item.folder->store->loseFinishAcknowledgment = true;
    EXPECT_EQ(NS_ERROR_FILE_ACCESS_DENIED,
              item.folder->NotifyArticleDownloaded(
                  7401, NewsOfflineNativeCase::RetryData()));
    EXPECT_EQ(1u, item.folder->store->issued);
    EXPECT_EQ(1u, item.folder->store->finishes);
    EXPECT_EQ(1u, item.folder->store->actualFinishes);
    EXPECT_EQ(0u, item.folder->store->discards);
    EXPECT_EQ(0u, item.folder->store->actualDiscards);
    ASSERT_FALSE(item.folder->store->orphanToken.IsEmpty());
    nsCString orphan = item.folder->store->orphanToken;
    ASSERT_TRUE(before.body.storeToken.isSome());
    EXPECT_NE(*before.body.storeToken, orphan);
    nsCString orphanBytes;
    ASSERT_EQ(NS_OK, item.ReadBody(orphan, orphanBytes));
    ASSERT_TRUE(item.folder->store->last);
    ASSERT_EQ(3u, item.folder->store->last->requests.Length());
    EXPECT_EQ(NewsOfflineNativeCase::RetryData(),
              item.folder->store->last->requests[2]);
    EXPECT_EQ(item.folder->store->last->bytes, orphanBytes);
    ASSERT_NO_FATAL_FAILURE(item.ExpectUnchanged(before));
    uint32_t failedAttemptFinishes = item.folder->store->actualFinishes;
    // Underlying Finish really completed, so its real admission permits this
    // NEW request. This does not claim recovery from an internal failed Finish.
    ASSERT_NO_FATAL_FAILURE(item.ExpectFreshRetry(before));
    nsCString retainedOrphan;
    ASSERT_EQ(NS_OK, item.ReadBody(orphan, retainedOrphan));
    EXPECT_EQ(orphanBytes, retainedOrphan);
    EXPECT_EQ(2u, failedAttemptFinishes + item.folder->store->actualFinishes);
    RecordProperty(maildir ? "maildir_actual_finishes" : "mbox_actual_finishes",
                   failedAttemptFinishes + item.folder->store->actualFinishes);
    CheckNoTransaction();
  }
}

TEST_F(DeliveryCompleteHeader, NewsReadSetBorrowedIdentityAndDetach) {
  RefPtr<PerFolderDatabase> local = new PerFolderDatabase(mFolder, false);
  nsCOMPtr<nsINewsDatabase> nonNews =
      do_QueryInterface(static_cast<nsIMsgDatabase*>(local.get()));
  EXPECT_FALSE(nonNews);
  // A news facade also requires a persisted Newsgroup folder. The local
  // interface rejection above runs before changing the ordinary Inbox flags.
  ASSERT_EQ(NS_OK, mCore->FolderDB().UpdateFlags(mFolder,
                                                 nsMsgFolderFlags::Newsgroup));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, true);
  nsCOMPtr<nsINewsDatabase> news =
      do_QueryInterface(static_cast<nsIMsgDatabase*>(db.get()));
  ASSERT_TRUE(news);
  RefPtr<PerFolderDatabase> concrete = do_QueryObject(news);
  EXPECT_EQ(db, concrete);
  RefPtr<nsMsgKeySet> incoming = nsMsgKeySet::Create("5-7");
  ASSERT_TRUE(incoming);
  ASSERT_EQ(NS_OK, news->SetReadSet(incoming));
  ASSERT_NO_FATAL_FAILURE(ExpectBorrowedNewsSet(*db, incoming));
  RefPtr<nsMsgKeySet> replacement = nsMsgKeySet::Create("9");
  ASSERT_TRUE(replacement);
  ASSERT_EQ(NS_OK, news->SetReadSet(replacement));
  // An earlier owner's cleanup must leave the replacement binding installed.
  db->DetachNewsReadSetIfMatches(incoming);
  ASSERT_NO_FATAL_FAILURE(ExpectBorrowedNewsSet(*db, replacement));
  db->DetachNewsReadSetIfMatches(nullptr);
  ASSERT_NO_FATAL_FAILURE(ExpectBorrowedNewsSet(*db, replacement));
  nsCOMPtr<nsIMsgDBHdr> live;
  ASSERT_EQ(NS_OK, AddFacadeNewsArticle(*db, 9, "detached@news.invalid"_ns,
                                        getter_AddRefs(live)));
  ASSERT_EQ(NS_OK, live->MarkRead(false));
  EXPECT_FALSE(replacement->IsMember(9));
  db->DetachNewsReadSetIfMatches(replacement);
  ASSERT_NO_FATAL_FAILURE(ExpectBorrowedNewsSet(*db, nullptr));
  // Keep the live header after its former borrowed set's owner releases it.
  replacement = nullptr;
  ASSERT_EQ(NS_OK, live->MarkRead(true));
  bool read = false;
  ASSERT_EQ(NS_OK, live->GetIsRead(&read));
  EXPECT_TRUE(read);
  db->DetachNewsReadSetIfMatches(nullptr);
  db->DetachNewsReadSetIfMatches(nullptr);
  ASSERT_NO_FATAL_FAILURE(ExpectBorrowedNewsSet(*db, nullptr));
  ASSERT_EQ(NS_OK, news->SetReadSet(incoming));
  ASSERT_EQ(NS_OK, news->SetReadSet(nullptr));
  ASSERT_NO_FATAL_FAILURE(ExpectBorrowedNewsSet(*db, nullptr));
  incoming = nullptr;
  // Detach has no dependency on the lifetime of the former borrowed object.
  EXPECT_EQ(NS_OK, news->SetReadSet(nullptr));
  RefPtr<nsMsgKeySet> closing = nsMsgKeySet::Create("11");
  ASSERT_TRUE(closing);
  ASSERT_EQ(NS_OK, news->SetReadSet(closing));
  ASSERT_EQ(NS_OK, db->ForceClosed());
  // Matching-only cleanup remains infallible and idempotent after force-close.
  db->DetachNewsReadSetIfMatches(closing);
  db->DetachNewsReadSetIfMatches(nullptr);
  db->DetachNewsReadSetIfMatches(nullptr);
  closing = nullptr;
  EXPECT_EQ(NS_OK, news->SetReadSet(nullptr));
  nsMsgKeySet* output = reinterpret_cast<nsMsgKeySet*>(uintptr_t(1));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, news->GetReadSet(&output));
  EXPECT_EQ(nullptr, output);
  RefPtr<nsMsgKeySet> passive = nsMsgKeySet::Create("1");
  ASSERT_TRUE(passive);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->InitializeNewsReadSetFromNewsrc(passive, "1"_ns));
  EXPECT_TRUE(passive->IsMember(0));
}

TEST_F(DeliveryCompleteHeader, NewsReadSetColdSyncAndNormalReopen) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().UpdateFlags(mFolder,
                                                 nsMsgFolderFlags::Newsgroup));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, true);
  RefPtr<nsMsgKeySet> incoming = nsMsgKeySet::Create();
  ASSERT_TRUE(incoming);
  ASSERT_GE(incoming->Add(0), 0);
  ASSERT_EQ(NS_OK, db->SetReadSet(incoming));
  nsCOMPtr<nsIMsgDBHdr> zero, other;
  ASSERT_EQ(NS_OK, AddFacadeNewsArticle(*db, 0, "zero@news.invalid"_ns,
                                        getter_AddRefs(zero)));
  ASSERT_EQ(NS_OK, AddFacadeNewsArticle(*db, 9, "nine@news.invalid"_ns,
                                        getter_AddRefs(other)));
  bool read = false;
  ASSERT_EQ(NS_OK, zero->GetIsRead(&read));
  EXPECT_TRUE(read);
  ASSERT_EQ(NS_OK, other->GetIsRead(&read));
  EXPECT_FALSE(read);
  nsMsgKey zeroKey;
  ASSERT_EQ(NS_OK, zero->GetMessageKey(&zeroKey));
  EXPECT_NE(0u, zeroKey);
  NewsGroupIdentity identity;
  nsCString sourceId;
  ASSERT_EQ(NS_OK, ReadAdmissionSourceId(sourceId));
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetNewsGroupIdentity(sourceId, mFolder,
                                                           identity));
  nsCString checkpoint;
  ASSERT_EQ(NS_OK, ReadNewsCheckpoint(*db, checkpoint));
  int64_t zeroMember = -1;
  ASSERT_EQ(NS_OK, ReadNewsZeroCheckpoint(*db, zeroMember));
  EXPECT_EQ(1, zeroMember);
  // Use the fixture's normal application shutdown/async-close and startup.
  ASSERT_EQ(NS_OK, db->SetReadSet(nullptr));
  db = nullptr;
  zero = other = nullptr;
  ASSERT_TRUE(Stop());
  mCore = DatabaseCore::GetInstanceForService();
  ASSERT_EQ(NS_OK, mCore->Startup());
  db = new PerFolderDatabase(mFolder, true);
  nsCString reopened;
  ASSERT_EQ(NS_OK, ReadNewsCheckpoint(*db, reopened));
  EXPECT_EQ(checkpoint, reopened);
  zeroMember = -1;
  ASSERT_EQ(NS_OK, ReadNewsZeroCheckpoint(*db, zeroMember));
  EXPECT_EQ(1, zeroMember);
  RefPtr<nsMsgKeySet> restored = nsMsgKeySet::Create(reopened.get());
  ASSERT_TRUE(restored);
  EXPECT_FALSE(restored->IsMember(0));
  ASSERT_EQ(NS_OK, db->InitializeNewsReadSetFromNewsrc(restored, reopened));
  EXPECT_TRUE(restored->IsMember(0));
  NewsGroupIdentity after;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetNewsGroupIdentity(
                       identity.databaseSourceId, mFolder, after));
  EXPECT_EQ(identity.incarnation, after.incarnation);
  ASSERT_EQ(NS_OK, db->GetNewsArticleHdr(0, getter_AddRefs(zero)));
  nsMsgKey actual;
  ASSERT_EQ(NS_OK, zero->GetMessageKey(&actual));
  EXPECT_EQ(zeroKey, actual);
  ASSERT_EQ(NS_OK, zero->GetIsRead(&read));
  EXPECT_TRUE(read);
  ASSERT_NO_FATAL_FAILURE(ExpectBorrowedNewsSet(*db, restored));
  // An explicit setter stays authoritative despite identical lossy text.
  RefPtr<nsMsgKeySet> explicitEmpty = nsMsgKeySet::Create(reopened.get());
  ASSERT_TRUE(explicitEmpty);
  ASSERT_EQ(NS_OK, db->SetReadSet(explicitEmpty));
  ASSERT_EQ(NS_OK, zero->GetIsRead(&read));
  EXPECT_FALSE(read);

  // Literal article1 with zero unread serializes to 1; its legacy parser
  // would add zero. Passive initialization must preserve the known false bit.
  RefPtr<nsMsgKeySet> oneOnly = nsMsgKeySet::Create();
  ASSERT_TRUE(oneOnly);
  ASSERT_GE(oneOnly->Add(1), 0);
  EXPECT_FALSE(oneOnly->IsMember(0));
  ASSERT_EQ(NS_OK, db->SetReadSet(oneOnly));
  nsCString oneText;
  ASSERT_EQ(NS_OK, ReadNewsCheckpoint(*db, oneText));
  EXPECT_EQ("1"_ns, oneText);
  RefPtr<nsMsgKeySet> parsedOne = nsMsgKeySet::Create(oneText.get());
  ASSERT_TRUE(parsedOne);
  EXPECT_TRUE(parsedOne->IsMember(0));
  ASSERT_EQ(NS_OK, db->InitializeNewsReadSetFromNewsrc(parsedOne, oneText));
  EXPECT_FALSE(parsedOne->IsMember(0));

  // A genuinely changed range expression applies the file's incoming intent.
  RefPtr<nsMsgKeySet> changed = nsMsgKeySet::Create("0-1");
  ASSERT_TRUE(changed);
  ASSERT_EQ(NS_OK, db->InitializeNewsReadSetFromNewsrc(changed, "0-1"_ns));
  EXPECT_TRUE(changed->IsMember(0));
  ASSERT_EQ(NS_OK, zero->GetIsRead(&read));
  EXPECT_TRUE(read);
  // Preserve the retained parser's historical 1-x zero-membership semantics.
  RefPtr<nsMsgKeySet> legacy = nsMsgKeySet::Create("1-3");
  ASSERT_TRUE(legacy);
  EXPECT_TRUE(legacy->IsMember(0));
}

TEST_F(DeliveryCompleteHeader, NewsReadSetLiveFlagsAndMarkAllReadKeepSameSet) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().UpdateFlags(mFolder,
                                                 nsMsgFolderFlags::Newsgroup));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, true);
  RefPtr<nsMsgKeySet> set = nsMsgKeySet::Create();
  ASSERT_TRUE(set);
  ASSERT_EQ(NS_OK, db->SetReadSet(set));
  nsCOMPtr<nsIMsgDBHdr> first, second;
  ASSERT_EQ(NS_OK, AddFacadeNewsArticle(*db, 17, "first@read.invalid"_ns,
                                        getter_AddRefs(first)));
  ASSERT_EQ(NS_OK, AddFacadeNewsArticle(*db, 29, "second@read.invalid"_ns,
                                        getter_AddRefs(second)));
  // A changed caller-owned set must reconcile even when its pointer is equal.
  ASSERT_GE(set->Add(17), 0);
  ASSERT_EQ(NS_OK, db->SetReadSet(set));
  bool read = false;
  ASSERT_EQ(NS_OK, first->GetIsRead(&read));
  EXPECT_TRUE(read);
  ASSERT_GE(set->Remove(17), 0);
  ASSERT_EQ(NS_OK, db->SetReadSet(set));
  ASSERT_EQ(NS_OK, first->GetIsRead(&read));
  EXPECT_FALSE(read);
  ASSERT_EQ(NS_OK, first->SetFlags(nsMsgMessageFlags::Marked |
                                   nsMsgMessageFlags::Read));
  EXPECT_TRUE(set->IsMember(17));
  uint32_t result;
  ASSERT_EQ(NS_OK, first->AndFlags(~nsMsgMessageFlags::Read, &result));
  EXPECT_FALSE(set->IsMember(17));
  ASSERT_EQ(NS_OK, first->OrFlags(nsMsgMessageFlags::Read, &result));
  EXPECT_TRUE(set->IsMember(17));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, first->GetMessageKey(&key));
  ASSERT_EQ(NS_OK, db->MarkRead(key, false, nullptr));
  EXPECT_FALSE(set->IsMember(17));
  nsTArray<nsMsgKey> marked;
  ASSERT_EQ(NS_OK, db->MarkAllRead(marked));
  EXPECT_EQ(2u, marked.Length());
  EXPECT_TRUE(set->IsMember(17));
  EXPECT_TRUE(set->IsMember(29));
  ASSERT_EQ(NS_OK, first->GetFlags(&result));
  EXPECT_TRUE(result & nsMsgMessageFlags::Marked);
  ASSERT_NO_FATAL_FAILURE(ExpectBorrowedNewsSet(*db, set));
}

TEST_F(DeliveryCompleteHeader,
       NewsReadSetFailuresKeepPointerRowsCheckpointAndEvents) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().UpdateFlags(mFolder,
                                                 nsMsgFolderFlags::Newsgroup));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, true);
  RefPtr<nsMsgKeySet> previous = nsMsgKeySet::Create();
  RefPtr<nsMsgKeySet> proposed = nsMsgKeySet::Create("17");
  ASSERT_TRUE(previous && proposed);
  ASSERT_EQ(NS_OK, db->SetReadSet(previous));
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK, AddFacadeNewsArticle(*db, 17, "failure@read.invalid"_ns,
                                        getter_AddRefs(header)));
  RefPtr<DeliveryNewsReadListener> listener = new DeliveryNewsReadListener();
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto cleanup = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, db->RemoveListener(listener));
    EXPECT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS fail_news_insert"_ns));
    EXPECT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS fail_news_update"_ns));
  });
  nsCString before;
  ASSERT_EQ(NS_OK, ReadNewsCheckpoint(*db, before));
  // A normal successful write cannot exercise transaction rollback. Only this
  // critical failure body injects SQLite errors; ordinary cleanup removes them.
  ASSERT_EQ(
      NS_OK,
      Connection()->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER fail_news_insert BEFORE INSERT ON "
          "folder_properties "
          "WHEN NEW.name='readSet' BEGIN SELECT RAISE(ABORT,'news checkpoint'); END"_ns));
  ASSERT_EQ(
      NS_OK,
      Connection()->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER fail_news_update BEFORE UPDATE ON "
          "folder_properties "
          "WHEN NEW.name='readSet' BEGIN SELECT RAISE(ABORT,'news checkpoint'); END"_ns));
  EXPECT_TRUE(NS_FAILED(db->SetReadSet(proposed)));
  RefPtr<nsMsgKeySet> passive = nsMsgKeySet::Create();
  ASSERT_TRUE(passive);
  ASSERT_GE(passive->Add(0), 0);
  EXPECT_TRUE(NS_FAILED(db->InitializeNewsReadSetFromNewsrc(passive, before)));
  // Even restoration of a known false bit stays on Core's prepared clone
  // until commit: the caller's proposed zero-only set survives failure.
  EXPECT_TRUE(passive->IsMember(0));
  EXPECT_FALSE(previous->IsMember(0));
  ASSERT_NO_FATAL_FAILURE(ExpectBorrowedNewsSet(*db, previous));
  EXPECT_FALSE(previous->IsMember(17));
  EXPECT_TRUE(proposed->IsMember(17));
  EXPECT_TRUE(NS_FAILED(header->MarkRead(true)));
  bool read = true;
  ASSERT_EQ(NS_OK, header->GetIsRead(&read));
  EXPECT_FALSE(read);
  nsCString after;
  ASSERT_EQ(NS_OK, ReadNewsCheckpoint(*db, after));
  EXPECT_EQ(before, after);
  EXPECT_EQ(0u, listener->flags);
  EXPECT_EQ(0u, listener->reads);
  bool inTransaction = true;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&inTransaction));
  EXPECT_FALSE(inTransaction);
}

TEST_F(DeliveryCompleteHeader,
       NewsReadSetSourceGroupAndSignedArticleAdmission) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().UpdateFlags(mFolder,
                                                 nsMsgFolderFlags::Newsgroup));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, true);
  RefPtr<nsMsgKeySet> firstSet = nsMsgKeySet::Create();
  ASSERT_TRUE(firstSet);
  ASSERT_EQ(NS_OK, db->SetReadSet(firstSet));
  uint64_t otherFolder;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolder, "OtherGroup"_ns,
                                                  &otherFolder));
  ASSERT_EQ(NS_OK, mCore->FolderDB().UpdateFlags(otherFolder,
                                                 nsMsgFolderFlags::Newsgroup));
  RefPtr<PerFolderDatabase> other = new PerFolderDatabase(otherFolder, true);
  RefPtr<nsMsgKeySet> otherSet = nsMsgKeySet::Create();
  ASSERT_TRUE(otherSet);
  ASSERT_EQ(NS_OK, other->SetReadSet(otherSet));
  nsCOMPtr<nsIMsgDBHdr> first, second;
  ASSERT_EQ(NS_OK, AddFacadeNewsArticle(*db, 0, "zero@first.invalid"_ns,
                                        getter_AddRefs(first)));
  ASSERT_EQ(NS_OK, AddFacadeNewsArticle(*other, 0, "zero@other.invalid"_ns,
                                        getter_AddRefs(second)));
  nsMsgKey firstKey, otherKey;
  ASSERT_EQ(NS_OK, first->GetMessageKey(&firstKey));
  ASSERT_EQ(NS_OK, second->GetMessageKey(&otherKey));
  EXPECT_NE(firstKey, otherKey);
  nsCOMPtr<nsIMsgDBHdr> absent, boundary;
  ASSERT_EQ(NS_OK, db->CreateNewHdr(getter_AddRefs(absent)));
  EXPECT_EQ(NS_ERROR_INVALID_ARG, db->AddNewHdrToDB(absent, true));
  ASSERT_EQ(NS_OK, db->CreateNewHdrWithSpecificMsgKey(
                       INT32_MAX, getter_AddRefs(boundary)));
  EXPECT_EQ(NS_ERROR_INVALID_ARG, other->AddNewHdrToDB(boundary, true));
  EXPECT_EQ(NS_OK, boundary->SetSubject("not consumed by foreign group"_ns));
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db->CreateNewHdrWithSpecificMsgKey(uint32_t(INT32_MAX) + 1,
                                               getter_AddRefs(absent)));
  EXPECT_FALSE(absent);
  nsMsgKey sentinel = nsMsgKey_None;
  EXPECT_EQ(NS_ERROR_INVALID_ARG,
            db->GetNewsArticleKey(uint32_t(INT32_MAX) + 1, sentinel));
  EXPECT_EQ(nsMsgKey_None, sentinel);
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  auto rollback = MakeScopeExit(
      [&] { EXPECT_EQ(NS_OK, Connection()->RollbackTransaction()); });
  EXPECT_TRUE(NS_FAILED(db->SetReadSet(firstSet)));
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db->InitializeNewsReadSetFromNewsrc(firstSet, EmptyCString()));
  EXPECT_FALSE(firstSet->IsMember(0));
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "UPDATE database_identity SET sourceId="
                       "'{7a139b24-9c50-47fa-8322-168da90748c0}'"_ns));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->CreateNewHdrWithSpecificMsgKey(1, getter_AddRefs(absent)));
  EXPECT_FALSE(absent);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db->GetNewsArticleKey(0, sentinel));
  EXPECT_EQ(nsMsgKey_None, sentinel);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->InitializeNewsReadSetFromNewsrc(firstSet, EmptyCString()));
  EXPECT_FALSE(firstSet->IsMember(0));
  bool inTransaction = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&inTransaction));
  EXPECT_TRUE(inTransaction);
}

TEST_F(DeliveryCompleteHeader, NewsReadSetReplacementAndListenerPublication) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().UpdateFlags(mFolder,
                                                 nsMsgFolderFlags::Newsgroup));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, true);
  RefPtr<nsMsgKeySet> first = nsMsgKeySet::Create();
  RefPtr<nsMsgKeySet> replacement = nsMsgKeySet::Create("17");
  ASSERT_TRUE(first && replacement);
  ASSERT_EQ(NS_OK, db->SetReadSet(first));
  nsCOMPtr<nsIMsgDBHdr> header;
  ASSERT_EQ(NS_OK, AddFacadeNewsArticle(*db, 17, "replacement@news.invalid"_ns,
                                        getter_AddRefs(header)));
  RefPtr<DeliveryNewsReadListener> listener = new DeliveryNewsReadListener();
  listener->observe = [&](char) {
    ASSERT_NO_FATAL_FAILURE(ExpectBorrowedNewsSet(*db, replacement));
    EXPECT_TRUE(replacement->IsMember(17));
    bool read = false;
    ASSERT_EQ(NS_OK, header->GetIsRead(&read));
    EXPECT_TRUE(read);
    nsCString checkpoint;
    ASSERT_EQ(NS_OK, ReadNewsCheckpoint(*db, checkpoint));
    RefPtr<nsMsgKeySet> committed = nsMsgKeySet::Create(checkpoint.get());
    ASSERT_TRUE(committed);
    EXPECT_TRUE(committed->IsMember(17));
  };
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto cleanup =
      MakeScopeExit([&] { EXPECT_EQ(NS_OK, db->RemoveListener(listener)); });
  ASSERT_EQ(NS_OK, db->SetReadSet(replacement));
  EXPECT_EQ(1u, listener->flags);
  EXPECT_EQ(1u, listener->reads);
  EXPECT_FALSE(first->IsMember(17));
  listener->observe = nullptr;
  // A different facade's successful installation supersedes only Core's
  // concrete binding. Detaching the old owner cannot remove the replacement.
  RefPtr<PerFolderDatabase> next = new PerFolderDatabase(mFolder, true);
  ASSERT_EQ(NS_OK, next->SetReadSet(replacement));
  ASSERT_EQ(NS_OK, db->SetReadSet(nullptr));
  ASSERT_EQ(NS_OK, header->MarkRead(false));
  EXPECT_FALSE(replacement->IsMember(17));
  ASSERT_NO_FATAL_FAILURE(ExpectBorrowedNewsSet(*next, replacement));
}

TEST_F(DeliveryCompleteHeader, NewsDraftArticleIdentityAndPublication) {
  ASSERT_EQ(NS_OK, mCore->FolderDB().UpdateFlags(mFolder,
                                                 nsMsgFolderFlags::Newsgroup));
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, true);
  RefPtr<nsMsgKeySet> incoming = nsMsgKeySet::Create();
  ASSERT_TRUE(incoming);
  ASSERT_GE(incoming->Add(0), 0);
  ASSERT_EQ(NS_OK, db->SetReadSet(incoming));
  nsCOMPtr<nsIMsgDBHdr> draft;
  ASSERT_EQ(NS_OK,
            db->CreateNewHdrWithSpecificMsgKey(0, getter_AddRefs(draft)));
  nsMsgKey key;
  ASSERT_EQ(NS_OK, draft->GetMessageKey(&key));
  EXPECT_EQ(nsMsgKey_None, key);
  ASSERT_EQ(NS_OK, draft->SetMessageId("draft-zero@news.invalid"_ns));
  ASSERT_EQ(NS_OK, draft->SetStringProperty("literal", EmptyCString()));
  ASSERT_EQ(NS_OK, draft->MarkFlagged(true));
  ASSERT_EQ(NS_OK, draft->MarkRead(false));
  ASSERT_EQ(NS_OK,
            draft->SetReferences(
                "<one@news.invalid> <two@news.invalid> <one@news.invalid>"_ns));
  nsCOMPtr<nsIMsgDBHdr> duplicate, live;
  ASSERT_EQ(NS_OK,
            db->CreateNewHdrWithSpecificMsgKey(0, getter_AddRefs(duplicate)));
  ASSERT_EQ(NS_OK, duplicate->SetMessageId("raced-zero@news.invalid"_ns));
  ASSERT_EQ(NS_OK, duplicate->MarkRead(true));
  nsCOMPtr<nsIMsgDBHdr> publishingDraft = draft;
  uint32_t publishingArticle = 0;
  bool expectedRead = false;
  RefPtr<DeliveryNewsReadListener> listener = new DeliveryNewsReadListener();
  listener->observe = [&](char kind) {
    if (kind != 'A') return;
    // Core must install the existing public owning output before callbacks;
    // the parser draft itself remains a sealed keyless metadata object.
    ASSERT_TRUE(live);
    EXPECT_EQ(NS_ERROR_IN_PROGRESS,
              publishingDraft->SetSubject("reentrant edit"_ns));
    nsCOMPtr<nsIMsgDBHdr> published;
    ASSERT_EQ(NS_OK, db->GetNewsArticleHdr(publishingArticle,
                                           getter_AddRefs(published)));
    bool read = false;
    ASSERT_EQ(NS_OK, published->GetIsRead(&read));
    EXPECT_EQ(expectedRead, read);
    EXPECT_EQ(expectedRead, incoming->IsMember(publishingArticle));
    ASSERT_NO_FATAL_FAILURE(ExpectBorrowedNewsSet(*db, incoming));
  };
  ASSERT_EQ(NS_OK, db->AddListener(listener));
  auto cleanup =
      MakeScopeExit([&] { EXPECT_EQ(NS_OK, db->RemoveListener(listener)); });
  ASSERT_EQ(NS_OK, db->AttachHdr(draft, true, getter_AddRefs(live)));
  EXPECT_EQ(1u, listener->added);
  EXPECT_EQ(NS_ERROR_ALREADY_INITIALIZED, draft->SetSubject("sealed"_ns));
  EXPECT_EQ(NS_ERROR_ALREADY_INITIALIZED, draft->MarkRead(true));
  EXPECT_FALSE(incoming->IsMember(0));
  ASSERT_EQ(NS_OK, db->AddNewHdrToDB(draft, true));
  EXPECT_EQ(1u, listener->added);
  ASSERT_EQ(NS_OK, db->AttachHdr(draft, true, getter_AddRefs(live)));
  ASSERT_TRUE(live);
  ASSERT_EQ(NS_OK, live->GetMessageKey(&key));
  EXPECT_NE(0u, key);
  uint16_t count;
  ASSERT_EQ(NS_OK, live->GetNumReferences(&count));
  EXPECT_EQ(3u, count);
  nsCString token;
  ASSERT_EQ(NS_OK, live->GetStringReference(2, token));
  EXPECT_EQ("one@news.invalid"_ns, token);
  nsTArray<nsCString> properties;
  ASSERT_EQ(NS_OK, live->GetProperties(properties));
  EXPECT_TRUE(properties.Contains("literal"_ns));
  nsCOMPtr<nsIMsgDBHdr> raced;
  ASSERT_EQ(NS_OK, db->AttachHdr(duplicate, true, getter_AddRefs(raced)));
  nsMsgKey racedKey;
  ASSERT_EQ(NS_OK, raced->GetMessageKey(&racedKey));
  EXPECT_EQ(key, racedKey);
  EXPECT_EQ(1u, listener->added);
  bool racedRead = true;
  ASSERT_EQ(NS_OK, raced->GetIsRead(&racedRead));
  EXPECT_FALSE(racedRead);  // A dedup race never refilters an existing row.
  nsCOMPtr<nsIMsgDBHdr> existing;
  ASSERT_EQ(NS_OK,
            db->CreateNewHdrWithSpecificMsgKey(0, getter_AddRefs(existing)));
  bool isLive = false;
  ASSERT_EQ(NS_OK, existing->GetIsLive(&isLive));
  EXPECT_TRUE(isLive);
  ASSERT_EQ(NS_OK, existing->GetMessageKey(&racedKey));
  EXPECT_EQ(key, racedKey);

  nsCOMPtr<nsIMsgDBHdr> marked;
  ASSERT_EQ(NS_OK,
            db->CreateNewHdrWithSpecificMsgKey(23, getter_AddRefs(marked)));
  ASSERT_EQ(NS_OK, marked->SetMessageId("read-intent@news.invalid"_ns));
  ASSERT_EQ(NS_OK, marked->MarkFlagged(true));
  ASSERT_EQ(NS_OK, marked->MarkRead(true));
  publishingDraft = marked;
  publishingArticle = 23;
  expectedRead = true;
  ASSERT_EQ(NS_OK, db->AttachHdr(marked, true, getter_AddRefs(live)));
  EXPECT_EQ(2u, listener->added);
  EXPECT_TRUE(incoming->IsMember(23));
  uint32_t flags;
  ASSERT_EQ(NS_OK, live->GetFlags(&flags));
  EXPECT_TRUE(flags & nsMsgMessageFlags::Read);
  EXPECT_TRUE(flags & nsMsgMessageFlags::Marked);

  nsCOMPtr<nsIMsgDBHdr> failed;
  ASSERT_EQ(NS_OK,
            db->CreateNewHdrWithSpecificMsgKey(19, getter_AddRefs(failed)));
  ASSERT_EQ(NS_OK, failed->SetMessageId("failed@news.invalid"_ns));
  ASSERT_EQ(NS_OK, failed->MarkRead(true));
  EXPECT_FALSE(incoming->IsMember(19));
  auto removeFault = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "DROP TRIGGER IF EXISTS fail_news_publication"_ns));
  });
  // Normal publication cannot exercise the first-error/output rollback cut.
  // This bounded injected error retains normal fixture/trigger cleanup.
  ASSERT_EQ(
      NS_OK,
      Connection()->ExecuteSimpleSQL(
          "CREATE TEMP TRIGGER fail_news_publication BEFORE INSERT ON messages "
          "WHEN NEW.messageId='failed@news.invalid' "
          "BEGIN SELECT RAISE(ABORT,'news publication'); END"_ns));
  nsCOMPtr<nsIMsgDBHdr> output = live;
  nsresult firstError = db->AttachHdr(failed, true, getter_AddRefs(output));
  ASSERT_TRUE(NS_FAILED(firstError));
  EXPECT_FALSE(output);
  EXPECT_EQ(firstError, failed->SetSubject("first error retained"_ns));
  EXPECT_EQ(firstError, failed->MarkRead(false));
  EXPECT_FALSE(incoming->IsMember(19));
  EXPECT_EQ(firstError, db->AddNewHdrToDB(failed, true));
  EXPECT_EQ(2u, listener->added);
  nsMsgKey missing = nsMsgKey_None;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, db->GetNewsArticleKey(19, missing));
  EXPECT_EQ(nsMsgKey_None, missing);
}

TEST_F(DeliveryCompleteHeader, OfflineProtocolDeltaSurvivesNormalReopen) {
  ASSERT_NO_FATAL_FAILURE(CreateOfflineProtocolSource());
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  const ServerMessageLocation source{mFolder, mKey, 77, 7401};
  const uint32_t clientFlags = nsMsgMessageFlags::Forwarded;
  ASSERT_EQ(NS_OK, mHeader->SetFlags(clientFlags));
  ASSERT_EQ(NS_OK,
            db->QueueOfflineProtocolFlagMutation(mKey, source, 0x81, true));
  ASSERT_EQ(NS_OK,
            db->QueueOfflineProtocolFlagMutation(mKey, source, 0x01, false));
  ASSERT_EQ(NS_OK,
            db->QueueOfflineProtocolFlagMutation(mKey, source, 0x40, true));
  OfflineOperationData payload;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetOfflineOperation(mFolder, mKey, payload));
  ASSERT_TRUE(payload.flagMutation);
  EXPECT_EQ(0xc0u, payload.flagMutation->setMask);
  EXPECT_EQ(0x01u, payload.flagMutation->clearMask);
  uint32_t flags;
  ASSERT_EQ(NS_OK, mHeader->GetFlags(&flags));
  EXPECT_EQ(clientFlags, flags);
  QueuedSourceIdentity identity;
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetQueuedSourceIdentity(mFolder, mKey,
                                                              identity));
  ASSERT_TRUE(identity.source);
  EXPECT_EQ(mKey, identity.source->key);
  EXPECT_EQ(7401u, identity.source->uid);
  const auto revision = identity.revision;

  // Use the fixture's ordinary asynchronous close/startup and same profile.
  db = nullptr;
  mHeader = nullptr;
  ASSERT_TRUE(Stop());
  mCore = DatabaseCore::GetInstanceForService();
  ASSERT_EQ(NS_OK, mCore->Startup());
  db = new PerFolderDatabase(mFolder, false);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetOfflineOperation(mFolder, mKey, payload));
  ASSERT_TRUE(payload.flagMutation);
  EXPECT_EQ(0xc0u, payload.flagMutation->setMask);
  EXPECT_EQ(0x01u, payload.flagMutation->clearMask);
  ASSERT_EQ(NS_OK, mCore->MessageDB().GetQueuedSourceIdentity(mFolder, mKey,
                                                              identity));
  EXPECT_EQ(revision, identity.revision);
  ASSERT_TRUE(identity.source);
  EXPECT_EQ(77u, identity.source->epoch);
  EXPECT_EQ(7401u, identity.source->uid);
  ASSERT_EQ(NS_OK,
            db->QueueOfflineProtocolFlagMutation(mKey, source, 0x80, false));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetOfflineOperation(mFolder, mKey, payload));
  ASSERT_TRUE(payload.flagMutation);
  EXPECT_EQ(0x40u, payload.flagMutation->setMask);
  EXPECT_EQ(0x81u, payload.flagMutation->clearMask);
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, OfflineProtocolLegacyWritersRemainUnknown) {
  ASSERT_NO_FATAL_FAILURE(CreateOfflineProtocolSource());
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  const ServerMessageLocation source{mFolder, mKey, 77, 7401};
  for (bool flagOperation : {false, true}) {
    ASSERT_EQ(NS_OK,
              db->QueueOfflineProtocolFlagMutation(mKey, source, 0x80, true));
    OfflineOperationData before;
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetOfflineOperation(mFolder, mKey, before));
    ASSERT_TRUE(before.flagMutation);
    nsCOMPtr<nsIMsgOfflineImapOperation> op;
    ASSERT_EQ(NS_OK, db->GetOfflineOpForKey(mKey, false, getter_AddRefs(op)));
    ASSERT_TRUE(op);
    // Even the same legacy numeric word is an explicit unproven replacement.
    if (flagOperation) {
      ASSERT_EQ(NS_OK, op->SetFlagOperation(before.newFlags));
    } else {
      ASSERT_EQ(NS_OK, op->SetNewFlags(before.newFlags));
    }
    OfflineOperationData after;
    ASSERT_EQ(NS_OK,
              mCore->MessageDB().GetOfflineOperation(mFolder, mKey, after));
    EXPECT_FALSE(after.flagMutation);
    EXPECT_EQ(before.newFlags, after.newFlags);
    EXPECT_TRUE(after.operation & nsIMsgOfflineImapOperation::kFlagsChanged);
    QueuedSourceIdentity identity, retained;
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetQueuedSourceIdentity(mFolder, mKey,
                                                                identity));
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db->QueueOfflineProtocolFlagMutation(mKey, source, 0x01, true));
    ASSERT_EQ(NS_OK, mCore->MessageDB().GetQueuedSourceIdentity(mFolder, mKey,
                                                                retained));
    EXPECT_EQ(identity.revision, retained.revision);
    imapMessageFlagsType legacy = 0xa5;
    ASSERT_EQ(NS_OK, op->GetNewFlags(&legacy));
    EXPECT_EQ(before.newFlags, legacy);
    // Each variant starts a distinct explicitly removed unsent intent.
    op = nullptr;
    ASSERT_EQ(NS_OK, mCore->MessageDB().RemoveOfflineOperation(mFolder, mKey));
  }
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, OfflineProtocolCombinedUpdatesKeepProvenance) {
  ASSERT_NO_FATAL_FAILURE(CreateOfflineProtocolSource());
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  const ServerMessageLocation source{mFolder, mKey, 77, 7401};
  ASSERT_EQ(NS_OK,
            db->QueueOfflineProtocolFlagMutation(mKey, source, 0x81, true));
  nsCOMPtr<nsIMsgOfflineImapOperation> op;
  ASSERT_EQ(NS_OK, db->GetOfflineOpForKey(mKey, false, getter_AddRefs(op)));
  ASSERT_TRUE(op);
  ASSERT_EQ(NS_OK, op->SetMsgSize(3537));
  ASSERT_EQ(NS_OK, op->AddKeywordToAdd("keep-tag"));
  ASSERT_EQ(NS_OK,
            op->AddMessageCopyOperation("imap://example.invalid/first"_ns));
  ASSERT_EQ(NS_OK,
            op->AddMessageCopyOperation("imap://example.invalid/second"_ns));
  ASSERT_EQ(NS_OK, op->SetPlayingBack(true));
  OfflineOperationData payload;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetOfflineOperation(mFolder, mKey, payload));
  ASSERT_TRUE(payload.flagMutation);
  EXPECT_EQ(0x81u, payload.flagMutation->setMask);
  EXPECT_EQ(0u, payload.flagMutation->clearMask);
  EXPECT_EQ(3537u, payload.messageSize);
  EXPECT_EQ("keep-tag"_ns, payload.keywordsToAdd);
  EXPECT_EQ((nsTArray<nsCString>{"imap://example.invalid/first"_ns,
                                 "imap://example.invalid/second"_ns}),
            payload.copyDestinations);
  ASSERT_EQ(NS_OK,
            op->ClearOperation(nsIMsgOfflineImapOperation::kFlagsChanged));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetOfflineOperation(mFolder, mKey, payload));
  EXPECT_FALSE(payload.flagMutation);
  EXPECT_FALSE(payload.operation & nsIMsgOfflineImapOperation::kFlagsChanged);
  EXPECT_TRUE(payload.operation & nsIMsgOfflineImapOperation::kMsgCopy);
  EXPECT_TRUE(payload.operation & nsIMsgOfflineImapOperation::kAddKeywords);
  EXPECT_EQ(2u, payload.copyDestinations.Length());
  ASSERT_EQ(NS_OK,
            db->QueueOfflineProtocolFlagMutation(mKey, source, 0x40, true));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetOfflineOperation(mFolder, mKey, payload));
  ASSERT_TRUE(payload.flagMutation);
  EXPECT_EQ(0x40u, payload.flagMutation->setMask);
  EXPECT_EQ("keep-tag"_ns, payload.keywordsToAdd);
  EXPECT_EQ(2u, payload.copyDestinations.Length());
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, OfflineProtocolInputsPreserveCallerAndIdentity) {
  ASSERT_NO_FATAL_FAILURE(CreateOfflineProtocolSource());
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  const ServerMessageLocation source{mFolder, mKey, 77, 7401};
  for (int32_t mask : {-1, 0x20, 0x100, 0x10000, 0xe000}) {
    EXPECT_EQ(NS_ERROR_INVALID_ARG,
              db->QueueOfflineProtocolFlagMutation(mKey, source, mask, true));
  }
  ASSERT_EQ(NS_OK, db->QueueOfflineProtocolFlagMutation(mKey, source, 0, true));
  nsTArray<nsMsgKey> keys;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().ListOfflineOperations(mFolder, false, keys));
  EXPECT_TRUE(keys.IsEmpty());
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  EXPECT_EQ(NS_ERROR_IN_PROGRESS,
            db->QueueOfflineProtocolFlagMutation(mKey, source, 0x01, true));
  bool active = false;
  ASSERT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
  EXPECT_TRUE(active);
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  ASSERT_EQ(NS_OK,
            db->QueueOfflineProtocolFlagMutation(mKey, source, 0x01, true));
  QueuedSourceIdentity before, after;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetQueuedSourceIdentity(mFolder, mKey, before));
  for (uint32_t variant = 0; variant < 3; ++variant) {
    auto wrong = source;
    if (variant == 0) ++wrong.epoch;
    if (variant == 1) ++wrong.uid;
    if (variant == 2) ++wrong.key;
    EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
              db->QueueOfflineProtocolFlagMutation(mKey, wrong, 0x80, true));
  }
  uint64_t other;
  ASSERT_EQ(NS_OK, mCore->FolderDB().InsertFolder(mFolder, "Other"_ns, &other));
  RefPtr<PerFolderDatabase> foreign = new PerFolderDatabase(other, false);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, foreign->QueueOfflineProtocolFlagMutation(
                                        mKey, source, 0x80, true));
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetQueuedSourceIdentity(mFolder, mKey, after));
  EXPECT_EQ(before.operationId, after.operationId);
  EXPECT_EQ(before.revision, after.revision);
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader,
       OfflineProtocolClosedAndForeignSourceKeepOutputs) {
  ASSERT_NO_FATAL_FAILURE(CreateOfflineProtocolSource());
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  const ServerMessageLocation source{mFolder, mKey, 77, 7401};
  ASSERT_EQ(NS_OK,
            db->QueueOfflineProtocolFlagMutation(mKey, source, 0x80, true));
  nsCOMPtr<nsIMsgOfflineImapOperation> op;
  ASSERT_EQ(NS_OK, db->GetOfflineOpForKey(mKey, false, getter_AddRefs(op)));
  ASSERT_TRUE(op);
  // This precise stale-incarnation fault is restored before ordinary teardown.
  // A real database replacement cannot occur inside the open native fixture.
  ASSERT_EQ(NS_OK, Connection()->BeginTransaction());
  auto rollback = MakeScopeExit([&] {
    bool active = false;
    EXPECT_EQ(NS_OK, Connection()->GetTransactionInProgress(&active));
    if (active) EXPECT_EQ(NS_OK, Connection()->RollbackTransaction());
  });
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "UPDATE database_identity SET sourceId = "
                       "'{7a139b24-9c50-47fa-8322-168da90748c0}'"_ns));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->QueueOfflineProtocolFlagMutation(mKey, source, 0x01, true));
  imapMessageFlagsType word = 0xa5;
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, op->GetNewFlags(&word));
  EXPECT_EQ(0xa5u, word);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, op->SetNewFlags(0));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, op->SetPlayingBack(true));
  ASSERT_EQ(NS_OK, Connection()->RollbackTransaction());
  rollback.release();
  OfflineOperationData payload;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetOfflineOperation(mFolder, mKey, payload));
  ASSERT_TRUE(payload.flagMutation);
  EXPECT_EQ(0x80u, payload.flagMutation->setMask);
  ASSERT_EQ(NS_OK, db->ForceClosed());
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE,
            db->QueueOfflineProtocolFlagMutation(mKey, source, 0x01, true));
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, op->GetNewFlags(&word));
  EXPECT_EQ(0xa5u, word);
  EXPECT_EQ(NS_ERROR_NOT_AVAILABLE, op->SetPlayingBack(true));
  CheckNoTransaction();
}

TEST_F(DeliveryCompleteHeader, OfflineProtocolWriteFailureRetainsWholeIntent) {
  ASSERT_NO_FATAL_FAILURE(CreateOfflineProtocolSource());
  RefPtr<PerFolderDatabase> db = new PerFolderDatabase(mFolder, false);
  const ServerMessageLocation source{mFolder, mKey, 77, 7401};
  ASSERT_EQ(NS_OK,
            db->QueueOfflineProtocolFlagMutation(mKey, source, 0x01, true));
  nsCOMPtr<nsIMsgOfflineImapOperation> op;
  ASSERT_EQ(NS_OK, db->GetOfflineOpForKey(mKey, false, getter_AddRefs(op)));
  ASSERT_TRUE(op);
  QueuedSourceIdentity before, after;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetQueuedSourceIdentity(mFolder, mKey, before));
  // Force only the reached durable write to fail; normal setup/cleanup remains.
  ASSERT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                       "CREATE TEMP TRIGGER delivery_protocol_write_failure "
                       "BEFORE UPDATE ON main.offline_operations BEGIN "
                       "SELECT RAISE(ABORT,'protocol write failure'); END"_ns));
  auto remove = MakeScopeExit([&] {
    EXPECT_EQ(NS_OK, Connection()->ExecuteSimpleSQL(
                         "DROP TRIGGER delivery_protocol_write_failure"_ns));
  });
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT, op->SetNewFlags(0));
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            db->QueueOfflineProtocolFlagMutation(mKey, source, 0x01, false));
  OfflineOperationData payload;
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetOfflineOperation(mFolder, mKey, payload));
  ASSERT_TRUE(payload.flagMutation);
  EXPECT_EQ(0x01u, payload.flagMutation->setMask);
  EXPECT_EQ(0u, payload.flagMutation->clearMask);
  ASSERT_EQ(NS_OK,
            mCore->MessageDB().GetQueuedSourceIdentity(mFolder, mKey, after));
  EXPECT_EQ(before.operationId, after.operationId);
  EXPECT_EQ(before.revision, after.revision);
  CheckNoTransaction();
}

}  // namespace mozilla::mailnews
