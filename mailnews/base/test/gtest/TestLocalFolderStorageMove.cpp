/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "gtest/gtest.h"
#include "Helpers.h"
#include "mozilla/Try.h"
#include "nsComponentManagerUtils.h"
#include "nsDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "nsIFile.h"
#include "nsIInputStream.h"
#include "nsIMsgPluggableStore.h"
#include "nsMsgDBFolder.h"
#include "nsMsgLocalStoreUtils.h"
#include "nsNetUtil.h"

using mozilla::mailnews::FolderStorageMove;

namespace {

nsresult WriteStorageFile(const nsCOMPtr<nsIFile>& file,
                          const nsACString& bytes) {
  NS_ENSURE_ARG(file);
  nsCOMPtr<nsIOutputStream> stream;
  MOZ_TRY(NS_NewLocalFileOutputStream(getter_AddRefs(stream), file));
  uint32_t written;
  nsresult rv = stream->Write(bytes.BeginReading(), bytes.Length(), &written);
  nsresult closed = stream->Close();
  NS_ENSURE_SUCCESS(rv, rv);
  NS_ENSURE_TRUE(written == bytes.Length(), NS_ERROR_UNEXPECTED);
  return closed;
}

nsresult ReadStorageFile(const nsCOMPtr<nsIFile>& file, nsACString& bytes) {
  NS_ENSURE_ARG(file);
  nsCOMPtr<nsIInputStream> stream;
  MOZ_TRY(NS_NewLocalFileInputStream(getter_AddRefs(stream), file));
  nsresult rv = testing::Slurp(stream, 4096, bytes);
  nsresult closed = stream->Close();
  return NS_FAILED(rv) ? rv : closed;
}

// The provider receives a real path and a typed admission failure through its
// ordinary folder boundary. No database identity or message header is invented.
class StorageAdmissionFolder final : public nsMsgDBFolder {
 public:
  explicit StorageAdmissionFolder(nsIFile* path) : mStorage(path) {
    mURI = "mailbox://storage-admission/source"_ns;
  }

  NS_IMETHOD GetFilePath(nsIFile** path) override {
    NS_ENSURE_SUCCESS(admissionStatus, admissionStatus);
    return mStorage->Clone(path);
  }

  nsresult admissionStatus = NS_OK;

 protected:
  nsresult GetDatabase() override { return NS_ERROR_NOT_AVAILABLE; }

 private:
  ~StorageAdmissionFolder() override = default;
  nsCOMPtr<nsIFile> mStorage;
};

class FolderStorageMoveTest : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_EQ(NS_OK,
              NS_GetSpecialDirectory(NS_OS_TEMP_DIR, getter_AddRefs(mRoot)));
    ASSERT_EQ(NS_OK, mRoot->Append(u"mailnews-folder-relocation"_ns));
    ASSERT_EQ(NS_OK, mRoot->CreateUnique(nsIFile::DIRECTORY_TYPE, 0700));
    mOwnsRoot = true;
  }

  void TearDown() override {
    if (mOwnsRoot) {
      EXPECT_EQ(NS_OK, mRoot->Remove(true));
    }
  }

  nsCOMPtr<nsIFile> Path(const nsAString& leaf) {
    nsCOMPtr<nsIFile> file;
    nsresult rv = mRoot->Clone(getter_AddRefs(file));
    EXPECT_EQ(NS_OK, rv);
    if (NS_FAILED(rv)) {
      return nullptr;
    }
    rv = file->Append(leaf);
    EXPECT_EQ(NS_OK, rv);
    return NS_SUCCEEDED(rv) ? file : nullptr;
  }

  nsCOMPtr<nsIFile> Child(const nsCOMPtr<nsIFile>& parent,
                          const nsAString& leaf) {
    nsCOMPtr<nsIFile> file;
    nsresult rv = parent->Clone(getter_AddRefs(file));
    EXPECT_EQ(NS_OK, rv);
    if (NS_FAILED(rv)) {
      return nullptr;
    }
    rv = file->Append(leaf);
    EXPECT_EQ(NS_OK, rv);
    return NS_SUCCEEDED(rv) ? file : nullptr;
  }

  nsresult CreateTree(bool maildir) {
    auto source = Path(u"source"_ns);
    if (maildir) {
      MOZ_TRY(source->Create(nsIFile::DIRECTORY_TYPE, 0700));
      auto cur = Child(source, u"cur"_ns);
      MOZ_TRY(cur->Create(nsIFile::DIRECTORY_TYPE, 0700));
      MOZ_TRY(Child(source, u"tmp"_ns)->Create(nsIFile::DIRECTORY_TYPE, 0700));
      MOZ_TRY(WriteStorageFile(
          Child(cur, u"physical-token"_ns),
          "From: sender@example.invalid\r\n\r\nExact body.\r\n"_ns));
    } else {
      MOZ_TRY(
          WriteStorageFile(source,
                           "From sender Thu Jan 01 00:00:00 1970\n"
                           "From: sender@example.invalid\n\nExact body.\n"_ns));
    }
    MOZ_TRY(WriteStorageFile(Path(u"source.msf"_ns), "Exact summary bytes"_ns));
    auto children = Path(u"source.sbd"_ns);
    MOZ_TRY(children->Create(nsIFile::DIRECTORY_TYPE, 0700));
    return WriteStorageFile(Child(children, u"child"_ns),
                            "Exact child bytes"_ns);
  }

  void ExpectBytes(const nsCOMPtr<nsIFile>& file, const nsACString& expected) {
    nsAutoCString bytes;
    ASSERT_EQ(NS_OK, ReadStorageFile(file, bytes));
    EXPECT_EQ(expected, bytes);
  }

  void ExpectExists(const nsCOMPtr<nsIFile>& file, bool expected) {
    bool exists;
    ASSERT_EQ(NS_OK, file->Exists(&exists));
    EXPECT_EQ(expected, exists);
  }

  void ExpectTree(const nsAString& name, bool maildir) {
    auto body = Path(name);
    if (maildir) {
      auto cur = Child(body, u"cur"_ns);
      ExpectBytes(Child(cur, u"physical-token"_ns),
                  "From: sender@example.invalid\r\n\r\nExact body.\r\n"_ns);
      ExpectExists(Child(body, u"tmp"_ns), true);
    } else {
      ExpectBytes(body,
                  "From sender Thu Jan 01 00:00:00 1970\n"
                  "From: sender@example.invalid\n\nExact body.\n"_ns);
    }
    ExpectBytes(Path(name + u".msf"_ns), "Exact summary bytes"_ns);
    ExpectBytes(Child(Path(name + u".sbd"_ns), u"child"_ns),
                "Exact child bytes"_ns);
  }

  void CheckRoundTrip(bool maildir) {
    ASSERT_EQ(NS_OK, CreateTree(maildir));
    auto source = Path(u"source"_ns);
    auto destination = Path(u"destination"_ns);
    FolderStorageMove move;
    ASSERT_EQ(NS_OK, move.Prepare(source, destination));
    ExpectTree(u"source"_ns, maildir);
    ASSERT_EQ(NS_OK, move.Apply());
    EXPECT_TRUE(move.HasPendingMoves());
    EXPECT_EQ(NS_OK, move.RollbackStatus());
    ExpectTree(u"destination"_ns, maildir);
    ExpectExists(source, false);
    ExpectExists(Path(u"source.msf"_ns), false);
    ExpectExists(Path(u"source.sbd"_ns), false);
    // RenameTo does not mutate either caller-owned nsIFile path.
    nsAutoString leaf;
    ASSERT_EQ(NS_OK, source->GetLeafName(leaf));
    EXPECT_EQ(u"source"_ns, leaf);
    ASSERT_EQ(NS_OK, move.Rollback());
    EXPECT_FALSE(move.HasPendingMoves());
    ExpectTree(u"source"_ns, maildir);
    ExpectExists(destination, false);
    EXPECT_EQ(NS_ERROR_ALREADY_INITIALIZED, move.Apply());
  }

  void CheckMaildirAdmission(nsresult error) {
    ASSERT_EQ(NS_OK, CreateTree(true));
    auto source = Path(u"source"_ns);
    RefPtr<StorageAdmissionFolder> folder = new StorageAdmissionFolder(source);
    nsresult rv;
    nsCOMPtr<nsIMsgPluggableStore> store =
        do_CreateInstance("@mozilla.org/msgstore/maildirstore;1", &rv);
    ASSERT_EQ(NS_OK, rv);
    ASSERT_TRUE(store);
    nsCOMPtr<nsIOutputStream> issued;
    ASSERT_EQ(NS_OK,
              store->GetNewMsgOutputStream(folder, getter_AddRefs(issued)));
    const nsLiteralCString first =
        "From: sender@example.invalid\r\n\r\nIssued bytes."_ns;
    uint32_t written;
    ASSERT_EQ(NS_OK,
              issued->Write(first.BeginReading(), first.Length(), &written));
    ASSERT_EQ(first.Length(), written);

    folder->admissionStatus = error;
    nsCOMPtr<nsIOutputStream> rejected;
    EXPECT_EQ(error,
              store->GetNewMsgOutputStream(folder, getter_AddRefs(rejected)));
    EXPECT_FALSE(rejected);
    EXPECT_EQ(NS_OK, issued->StreamStatus());

    // Restoring path admission is a test input, not a native recovery release.
    // The already-issued write must still own its stream and original bytes.
    folder->admissionStatus = NS_OK;
    const nsLiteralCString tail = " Retain this write.\r\n"_ns;
    ASSERT_EQ(NS_OK,
              issued->Write(tail.BeginReading(), tail.Length(), &written));
    ASSERT_EQ(tail.Length(), written);
    nsCString token;
    ASSERT_EQ(NS_OK, store->FinishNewMessage(folder, issued, token));
    ASSERT_FALSE(token.IsEmpty());
    auto cur = Child(source, u"cur"_ns);
    ExpectBytes(Child(cur, NS_ConvertUTF8toUTF16(token)), first + tail);
    EXPECT_EQ(NS_ERROR_ILLEGAL_VALUE,
              store->FinishNewMessage(folder, issued, token));
    ExpectBytes(Child(cur, NS_ConvertUTF8toUTF16(token)), first + tail);
    ExpectTree(u"source"_ns, true);
  }

  nsCOMPtr<nsIFile> mRoot;
  bool mOwnsRoot{false};
};

TEST_F(FolderStorageMoveTest, MboxRoundTrip) { CheckRoundTrip(false); }

TEST_F(FolderStorageMoveTest, MaildirRoundTrip) { CheckRoundTrip(true); }

TEST_F(FolderStorageMoveTest, DestructionLeavesInstalledStorage) {
  ASSERT_EQ(NS_OK, CreateTree(true));
  {
    FolderStorageMove move;
    ASSERT_EQ(NS_OK, move.Prepare(Path(u"source"_ns).get(),
                                  Path(u"destination"_ns).get()));
    ASSERT_EQ(NS_OK, move.Apply());
  }
  ExpectTree(u"destination"_ns, true);
  ExpectExists(Path(u"source"_ns), false);
  ExpectExists(Path(u"source.msf"_ns), false);
  ExpectExists(Path(u"source.sbd"_ns), false);
}

TEST_F(FolderStorageMoveTest, ExistingDestinationKeepsBothBodies) {
  ASSERT_EQ(NS_OK, CreateTree(false));
  auto destination = Path(u"destination"_ns);
  ASSERT_EQ(NS_OK, WriteStorageFile(destination, "Independent body"_ns));
  FolderStorageMove move;
  EXPECT_EQ(NS_ERROR_FILE_ALREADY_EXISTS,
            move.Prepare(Path(u"source"_ns).get(), destination));
  EXPECT_FALSE(move.HasPendingMoves());
  ExpectTree(u"source"_ns, false);
  ExpectBytes(destination, "Independent body"_ns);
}

TEST_F(FolderStorageMoveTest, LateFailureRestoresEarlierMoves) {
  ASSERT_EQ(NS_OK, CreateTree(false));
  FolderStorageMove move;
  ASSERT_EQ(NS_OK, move.Prepare(Path(u"source"_ns).get(),
                                Path(u"destination"_ns).get()));
  auto obstruction = Path(u"destination.msf"_ns);
  ASSERT_EQ(NS_OK, WriteStorageFile(obstruction, "Independent summary"_ns));
  EXPECT_EQ(NS_ERROR_FILE_ALREADY_EXISTS, move.Apply());
  EXPECT_EQ(NS_OK, move.RollbackStatus());
  EXPECT_FALSE(move.HasPendingMoves());
  ExpectTree(u"source"_ns, false);
  ExpectExists(Path(u"destination"_ns), false);
  ExpectBytes(obstruction, "Independent summary"_ns);
}

TEST_F(FolderStorageMoveTest, FailedRestoreRetainsRecoveryBytes) {
  ASSERT_EQ(NS_OK, CreateTree(false));
  FolderStorageMove move;
  auto source = Path(u"source"_ns);
  auto destination = Path(u"destination"_ns);
  ASSERT_EQ(NS_OK, move.Prepare(source, destination));
  ASSERT_EQ(NS_OK, move.Apply());
  ASSERT_EQ(NS_OK,
            WriteStorageFile(source, "Independent source obstruction"_ns));
  EXPECT_EQ(NS_ERROR_FILE_ALREADY_EXISTS, move.Rollback());
  EXPECT_EQ(NS_ERROR_FILE_ALREADY_EXISTS, move.RollbackStatus());
  EXPECT_TRUE(move.HasPendingMoves());
  ExpectBytes(source, "Independent source obstruction"_ns);
  ExpectBytes(destination,
              "From sender Thu Jan 01 00:00:00 1970\n"
              "From: sender@example.invalid\n\nExact body.\n"_ns);
  ExpectBytes(Path(u"source.msf"_ns), "Exact summary bytes"_ns);
  ExpectBytes(Child(Path(u"source.sbd"_ns), u"child"_ns),
              "Exact child bytes"_ns);
  ExpectExists(Path(u"destination.msf"_ns), false);
  ExpectExists(Path(u"destination.sbd"_ns), false);
}

TEST_F(FolderStorageMoveTest, MissingBodyStillMovesCacheParts) {
  ASSERT_EQ(NS_OK, CreateTree(false));
  ASSERT_EQ(NS_OK, Path(u"source"_ns)->Remove(false));
  FolderStorageMove move;
  ASSERT_EQ(NS_OK, move.Prepare(Path(u"source"_ns).get(),
                                Path(u"destination"_ns).get()));
  ASSERT_EQ(NS_OK, move.Apply());
  ExpectExists(Path(u"source"_ns), false);
  ExpectExists(Path(u"destination"_ns), false);
  ExpectBytes(Path(u"destination.msf"_ns), "Exact summary bytes"_ns);
  ExpectBytes(Child(Path(u"destination.sbd"_ns), u"child"_ns),
              "Exact child bytes"_ns);
  ASSERT_EQ(NS_OK, move.Rollback());
  ExpectBytes(Path(u"source.msf"_ns), "Exact summary bytes"_ns);
}

TEST_F(FolderStorageMoveTest, SamePathLeavesStorageUntouched) {
  ASSERT_EQ(NS_OK, CreateTree(true));
  FolderStorageMove move;
  auto source = Path(u"source"_ns);
  ASSERT_EQ(NS_OK, move.Prepare(source, source));
  ASSERT_EQ(NS_OK, move.Apply());
  EXPECT_FALSE(move.HasPendingMoves());
  ExpectTree(u"source"_ns, true);
  ASSERT_EQ(NS_OK, move.Rollback());
  ExpectTree(u"source"_ns, true);
}

TEST_F(FolderStorageMoveTest, MaildirRecoveryAdmissionKeepsIssuedWrite) {
  CheckMaildirAdmission(NS_ERROR_IN_PROGRESS);
}

TEST_F(FolderStorageMoveTest, MaildirPathErrorKeepsIssuedWrite) {
  CheckMaildirAdmission(NS_ERROR_FILE_ACCESS_DENIED);
}

}  // namespace
